/**
 * Turning whatever the user gave us into decoded text.
 *
 * Hand histories arrive in worse shape than a converter demo suggests. The
 * repo's own WePlay exports start with a UTF-8 byte-order mark and contain
 * non-ASCII table names ("Niš"); PokerStars on Windows writes CRLF; a few
 * clients write UTF-16; and people drag whole export folders or the zip their
 * room emailed them. Everything below exists so that none of those cases
 * reaches the parser as mojibake, and so that a file we genuinely cannot read
 * says why instead of failing as "unknown site".
 *
 * Nothing here knows about poker. It hands `lib/phf` clean `\n`-separated text.
 */

/** A file (or archive entry) that is ready to convert. */
export interface LoadedSource {
  /** Stable id for React keys and for matching worker messages back to a source. */
  id: string;
  /** Display name. Archive entries read `archive.zip → hands/file.txt`. */
  name: string;
  /** Size on disk. For an archive entry this is the uncompressed size. */
  bytes: number;
  /** Decoded, BOM-stripped, LF-normalized text. Empty when `problem` is set. */
  text: string;
  /** Encoding we decoded with, surfaced only when it is not plain UTF-8. */
  encoding: string;
  /**
   * Why this file cannot be converted at all — a binary, an empty file, an
   * archive we could not open. Kept as a per-file note rather than a thrown
   * error so one bad file in a fifty-file drop does not cost the other 49.
   */
  problem?: string;
}

/** Extensions real hand history exports actually use, for the file picker. */
export const ACCEPTED_EXTENSIONS = [
  ".txt",
  ".log",
  ".xml",
  ".csv",
  ".hh",
  ".hhd",
  ".hhf",
  ".hand",
  ".zip",
];

/** `accept` for `<input type="file">`. Deliberately generous; content decides. */
export const FILE_ACCEPT = `${ACCEPTED_EXTENSIONS.join(",")},text/plain`;

/**
 * Refuse anything above this. A hand history that large is a mistake (a video,
 * a database dump), and reading it would blow the tab's memory before we ever
 * got to tell the user it was the wrong file.
 */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `src-${sequence}`;
}

/* --------------------------------------------------------------- decoding - */

/**
 * Picks a decoder from the first bytes of the file.
 *
 * BOM first, because it is unambiguous. Without one, a run of NUL bytes at
 * every other index is the giveaway for UTF-16 written without a BOM, which is
 * what a handful of Windows clients produce; ASCII-range text in UTF-16LE has
 * NULs at the odd indexes and UTF-16BE at the even ones.
 */
function pickEncoding(bytes: Uint8Array): { label: string; offset: number; pretty: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { label: "utf-8", offset: 3, pretty: "UTF-8 (BOM)" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { label: "utf-16le", offset: 2, pretty: "UTF-16 LE" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { label: "utf-16be", offset: 2, pretty: "UTF-16 BE" };
  }

  const sample = bytes.subarray(0, 1024);
  let oddNuls = 0;
  let evenNuls = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] !== 0) {
      continue;
    }
    if (i % 2 === 0) {
      evenNuls += 1;
    } else {
      oddNuls += 1;
    }
  }
  const half = Math.max(1, Math.floor(sample.length / 2));
  if (oddNuls > half * 0.3 && evenNuls < half * 0.05) {
    return { label: "utf-16le", offset: 0, pretty: "UTF-16 LE (no BOM)" };
  }
  if (evenNuls > half * 0.3 && oddNuls < half * 0.05) {
    return { label: "utf-16be", offset: 0, pretty: "UTF-16 BE (no BOM)" };
  }
  return { label: "utf-8", offset: 0, pretty: "UTF-8" };
}

/**
 * How much of the decoded text is not plausible hand-history text.
 *
 * U+FFFD means the decoder hit bytes that are not valid in the encoding we
 * chose, and C0 control characters do not appear in any hand history. A .exe
 * renamed to .txt scores near 1; a WePlay file with Serbian table names scores
 * 0, because those characters decode perfectly well.
 */
function binaryRatio(text: string): number {
  const sample = text.slice(0, 4096);
  if (!sample.length) {
    return 0;
  }
  let bad = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      bad += 1;
    }
  }
  return bad / sample.length;
}

/** Decodes bytes to text, or explains why we will not try. */
export function decodeSource(buffer: ArrayBuffer): { text: string; encoding: string; problem?: string } {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    return { text: "", encoding: "UTF-8", problem: "The file is empty." };
  }

  const { label, offset, pretty } = pickEncoding(bytes);
  let text: string;
  try {
    text = new TextDecoder(label).decode(bytes.subarray(offset));
  } catch {
    text = new TextDecoder("utf-8").decode(bytes.subarray(offset));
  }

  const ratio = binaryRatio(text);
  if (ratio > 0.05) {
    return {
      text: "",
      encoding: pretty,
      problem: "This looks like a binary file, not a hand history. Check you picked the right file.",
    };
  }

  // Strip a BOM the decoder left in place (UTF-16 decoders keep it), and
  // normalize CRLF and lone CR so every parser downstream sees one line ending.
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) {
    return { text: "", encoding: pretty, problem: "The file has no text in it." };
  }
  return { text: normalized, encoding: pretty };
}

/* ------------------------------------------------------------------- zip - */

/**
 * Minimal zip reader.
 *
 * Rooms and trackers hand out hand histories as a zip often enough that
 * refusing them is a real papercut, but a zip library is ~30 KB of runtime for
 * a feature this narrow. The browser already ships the hard part:
 * `DecompressionStream("deflate-raw")` is the deflate decoder, so all that is
 * left is walking the central directory, which is about eighty lines.
 *
 * Deliberately not supported: encrypted entries and zip64. Both report a
 * readable problem instead of producing garbage.
 */
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function findEocd(view: DataView): number {
  // The comment field is last and variable-length, so the signature has to be
  // found by scanning back from the end. 64 KiB is the maximum comment size.
  const start = Math.max(0, view.byteLength - 0x10000 - 22);
  for (let i = view.byteLength - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD) {
      return i;
    }
  }
  return -1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompression) {
    throw new Error("This browser cannot unzip files. Unzip it yourself and drop the .txt files in.");
  }
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new Decompression("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads every plausible text entry out of a zip. */
export async function readZip(file: File): Promise<LoadedSource[]> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const eocd = findEocd(view);
  if (eocd < 0) {
    return [{ id: nextId(), name: file.name, bytes: file.size, text: "", encoding: "-", problem: "This is not a readable zip archive." }];
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const out: LoadedSource[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== ZIP_CENTRAL) {
      break;
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    // Bit 11 says the name is UTF-8; older archivers wrote CP437, and treating
    // that as UTF-8 only garbles the display name, never the contents.
    const name = new TextDecoder(flags & 0x800 ? "utf-8" : "utf-8").decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    cursor += 46 + nameLength + extraLength + commentLength;

    const label = `${file.name} → ${name}`;
    // Directory entries and macOS resource forks are not files anyone wants.
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop()?.startsWith(".")) {
      continue;
    }
    if (flags & 0x0001) {
      out.push({ id: nextId(), name: label, bytes: uncompressedSize, text: "", encoding: "-", problem: "Encrypted zip entries are not supported." });
      continue;
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      out.push({ id: nextId(), name: label, bytes: 0, text: "", encoding: "-", problem: "Zip64 archives are not supported. Unzip it and drop the files in." });
      continue;
    }

    if (view.getUint32(localOffset, true) !== ZIP_LOCAL) {
      continue;
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    try {
      const content = method === 0 ? raw : await inflateRaw(raw);
      const decoded = decodeSource(
        content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
      );
      out.push({ id: nextId(), name: label, bytes: uncompressedSize, ...decoded });
    } catch (error) {
      out.push({
        id: nextId(),
        name: label,
        bytes: uncompressedSize,
        text: "",
        encoding: "-",
        problem: error instanceof Error ? error.message : "Could not read this archive entry.",
      });
    }
  }

  if (out.length === 0) {
    return [{ id: nextId(), name: file.name, bytes: file.size, text: "", encoding: "-", problem: "The archive has no files in it." }];
  }
  return out;
}

/* ----------------------------------------------------------------- files - */

function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

/** Reads one picked or dropped file into one or more sources. */
export async function loadFile(file: File): Promise<LoadedSource[]> {
  if (file.size > MAX_FILE_BYTES) {
    return [{
      id: nextId(),
      name: file.name,
      bytes: file.size,
      text: "",
      encoding: "-",
      problem: `That file is ${formatBytes(file.size)}. Hand histories are not that big — this one is skipped.`,
    }];
  }
  if (isZip(file)) {
    return readZip(file);
  }
  try {
    const decoded = decodeSource(await file.arrayBuffer());
    return [{ id: nextId(), name: file.name, bytes: file.size, ...decoded }];
  } catch (error) {
    return [{
      id: nextId(),
      name: file.name,
      bytes: file.size,
      text: "",
      encoding: "-",
      problem: error instanceof Error ? error.message : "Could not read this file.",
    }];
  }
}

/** Wraps pasted text as a source so it flows through the same pipeline. */
export function sourceFromText(text: string, name = "Pasted text"): LoadedSource {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  return {
    id: nextId(),
    name,
    bytes: new Blob([normalized]).size,
    text: normalized,
    encoding: "UTF-8",
    problem: normalized.trim() ? undefined : "There was nothing in the box.",
  };
}

/* ------------------------------------------------------------ drag & drop - */

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  file(onSuccess: (file: File) => void, onError: (error: unknown) => void): void;
  createReader(): {
    readEntries(onSuccess: (entries: FileSystemEntryLike[]) => void, onError: (error: unknown) => void): void;
  };
}

/** Hard cap on a dropped folder, so a stray home directory cannot hang the tab. */
const MAX_DROPPED_FILES = 500;

function readDirectory(entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> {
  // `readEntries` returns at most 100 entries per call and an empty array when
  // it is done, so a folder of 300 files needs four calls.
  const reader = entry.createReader();
  const all: FileSystemEntryLike[] = [];
  return new Promise((resolve) => {
    const step = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all);
          return;
        }
        all.push(...entries);
        step();
      }, () => resolve(all));
    };
    step();
  });
}

function entryFile(entry: FileSystemEntryLike): Promise<File | null> {
  return new Promise((resolve) => entry.file((file) => resolve(file), () => resolve(null)));
}

async function collectEntry(entry: FileSystemEntryLike, out: File[]): Promise<void> {
  if (out.length >= MAX_DROPPED_FILES) {
    return;
  }
  if (entry.isFile) {
    const file = await entryFile(entry);
    if (file) {
      out.push(file);
    }
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readDirectory(entry)) {
      await collectEntry(child, out);
    }
  }
}

/**
 * Every file in a drop, including the contents of dropped folders.
 *
 * `DataTransfer.files` flattens a dropped folder to nothing, so the entries API
 * is the only way to support "drag your whole HandHistory folder in" — which is
 * exactly what the folder layout of `weplay-hh/` invites.
 */
export async function filesFromDrop(transfer: DataTransfer): Promise<File[]> {
  const items = Array.from(transfer.items ?? []);
  const entries = items
    .map((item) => (item.kind === "file" && "webkitGetAsEntry" in item
      ? (item.webkitGetAsEntry() as unknown as FileSystemEntryLike | null)
      : null))
    .filter((entry): entry is FileSystemEntryLike => entry !== null);

  if (entries.length === 0) {
    return Array.from(transfer.files ?? []).slice(0, MAX_DROPPED_FILES);
  }

  const out: File[] = [];
  for (const entry of entries) {
    await collectEntry(entry, out);
  }
  // A browser that gave us entries but no files (rare, and seen on some Linux
  // builds) should still fall back rather than silently drop the whole drop.
  return out.length > 0 ? out : Array.from(transfer.files ?? []).slice(0, MAX_DROPPED_FILES);
}

/* ---------------------------------------------------------------- format - */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
