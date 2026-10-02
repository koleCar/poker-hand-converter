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
 *
 * Nor does it know about languages: a file that cannot be read carries a
 * {@link SourceProblem} code, and the component that shows it picks the words
 * ({@link describeProblem}, `converter.problems` in the dictionaries).
 */

import type { Dict } from "../../lib/i18n/types";

/**
 * Why a file cannot be converted at all, as a code rather than a sentence.
 *
 * `detail` is an exception's own message when there was one; it is technical
 * and is shown as thrown.
 */
export type SourceProblem =
  | { kind: "empty" }
  | { kind: "no-text" }
  | { kind: "binary" }
  | { kind: "not-zip" }
  | { kind: "encrypted-entry" }
  | { kind: "zip64" }
  | { kind: "cannot-unzip" }
  | { kind: "unreadable-entry"; detail?: string }
  | { kind: "empty-archive" }
  | { kind: "too-large"; bytes: number }
  | { kind: "unreadable-file"; detail?: string }
  | { kind: "nothing-pasted" };

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
  problem?: SourceProblem;
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

/** How much of the text is outside ASCII. Real hand histories are ~all ASCII. */
function nonAsciiRatio(text: string): number {
  const sample = text.slice(0, 4096);
  if (!sample.length) {
    return 0;
  }
  let high = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample.charCodeAt(i) > 0x7f) {
      high += 1;
    }
  }
  return high / sample.length;
}

/**
 * Decodes bytes that are not valid UTF-8, or returns null to keep the UTF-8 read.
 *
 * Several rooms still ship 8-bit exports — Winamax and Unibet write the euro
 * sign as a single 0x80 byte, MicroGaming writes accented player names — and
 * decoding those as UTF-8 turns every such byte into U+FFFD. That is not
 * recoverable later: the parsers see a replacement character where the currency
 * was and refuse the hand (`lossy-encoding`). Windows-1252 is the only legacy
 * codec worth trying, because it is what Windows poker clients actually emit.
 *
 * The guard matters: Windows-1252 maps nearly every byte to *something*, so it
 * would happily "decode" a JPEG. A real hand history is overwhelmingly ASCII
 * with a sprinkling of accents, so a high non-ASCII share means we are looking
 * at binary and should stay on the UTF-8 read, whose replacement characters let
 * {@link binaryRatio} reject the file with the right message.
 */
function decodeLegacySingleByte(body: Uint8Array): string | null {
  let legacy: string;
  try {
    legacy = new TextDecoder("windows-1252").decode(body);
  } catch {
    return null;
  }
  if (binaryRatio(legacy) > 0.02 || nonAsciiRatio(legacy) > 0.05) {
    return null;
  }
  return legacy;
}

/** Decodes bytes to text, or explains why we will not try. */
export function decodeSource(buffer: ArrayBuffer): { text: string; encoding: string; problem?: SourceProblem } {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    return { text: "", encoding: "UTF-8", problem: { kind: "empty" } };
  }

  const { label, offset, pretty } = pickEncoding(bytes);
  const body = bytes.subarray(offset);
  let text: string;
  let encoding = pretty;
  try {
    if (label === "utf-8") {
      // Strict first, so invalid bytes raise instead of silently becoming
      // U+FFFD, which is the whole signal the Windows-1252 fallback needs.
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        const legacy = decodeLegacySingleByte(body);
        if (legacy === null) {
          text = new TextDecoder("utf-8").decode(body);
        } else {
          text = legacy;
          encoding = "Windows-1252";
        }
      }
    } else {
      text = new TextDecoder(label).decode(body);
    }
  } catch {
    text = new TextDecoder("utf-8").decode(body);
  }

  const ratio = binaryRatio(text);
  if (ratio > 0.05) {
    return {
      text: "",
      encoding,
      problem: { kind: "binary" },
    };
  }

  // Strip a BOM the decoder left in place (UTF-16 decoders keep it), and
  // normalize CRLF and lone CR so every parser downstream sees one line ending.
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) {
    return { text: "", encoding, problem: { kind: "no-text" } };
  }
  return { text: normalized, encoding };
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

/** Thrown when the browser has no `DecompressionStream`; reported as `cannot-unzip`. */
class UnzipUnsupportedError extends Error {}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompression) {
    throw new UnzipUnsupportedError("DecompressionStream is not available");
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
    return [{ id: nextId(), name: file.name, bytes: file.size, text: "", encoding: "-", problem: { kind: "not-zip" } }];
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
      out.push({ id: nextId(), name: label, bytes: uncompressedSize, text: "", encoding: "-", problem: { kind: "encrypted-entry" } });
      continue;
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      out.push({ id: nextId(), name: label, bytes: 0, text: "", encoding: "-", problem: { kind: "zip64" } });
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
        problem:
          error instanceof UnzipUnsupportedError
            ? { kind: "cannot-unzip" }
            : { kind: "unreadable-entry", detail: error instanceof Error ? error.message : undefined },
      });
    }
  }

  if (out.length === 0) {
    return [{ id: nextId(), name: file.name, bytes: file.size, text: "", encoding: "-", problem: { kind: "empty-archive" } }];
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
      problem: { kind: "too-large", bytes: file.size },
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
      problem: { kind: "unreadable-file", detail: error instanceof Error ? error.message : undefined },
    }];
  }
}

/**
 * Wraps pasted text as a source so it flows through the same pipeline. `name`
 * is a display name in the reader's language ("Pasted text").
 */
export function sourceFromText(text: string, name: string): LoadedSource {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  return {
    id: nextId(),
    name,
    bytes: new Blob([normalized]).size,
    text: normalized,
    encoding: "UTF-8",
    problem: normalized.trim() ? undefined : { kind: "nothing-pasted" },
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

/** `locale` is a BCP 47 tag: `INTL_LOCALE[useLocale()]` in a component. */
export function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) {
    return `${formatCount(bytes, locale)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatCount(Math.round(bytes / 1024), locale)} kB`;
  }
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** `locale` is a BCP 47 tag: `INTL_LOCALE[useLocale()]` in a component. */
export function formatCount(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

/** A {@link SourceProblem} in the reader's words. */
export function describeProblem(
  problem: SourceProblem,
  t: Dict["converter"]["problems"],
  locale: string,
): string {
  switch (problem.kind) {
    case "empty":
      return t.empty;
    case "no-text":
      return t.noText;
    case "binary":
      return t.binary;
    case "not-zip":
      return t.notZip;
    case "encrypted-entry":
      return t.encryptedEntry;
    case "zip64":
      return t.zip64;
    case "cannot-unzip":
      return t.cannotUnzip;
    case "unreadable-entry":
      return problem.detail ?? t.unreadableEntry;
    case "empty-archive":
      return t.emptyArchive;
    case "too-large":
      return t.tooLarge(formatBytes(problem.bytes, locale));
    case "unreadable-file":
      return problem.detail ?? t.unreadableFile;
    case "nothing-pasted":
      return t.nothingPasted;
  }
}
