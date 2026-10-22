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
import { readZipDirectory, readZipEntry, ZipEntryError } from "./zipStream";

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
 * Refuse a single file (or archive entry) above this. A hand history that
 * large is a mistake (a video, a database dump), and decoding it would blow
 * the tab's memory before we ever got to tell the user it was the wrong file.
 * An archive itself has no limit since R4.2: it is read one entry at a time.
 */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

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
 * Archive entries and folder files nobody exported as a hand history.
 *
 * A dropped export folder or zip carries the room's other files too - the
 * client's logs are useful, its screenshots and its `.DS_Store` are not. They
 * are left out silently rather than listed as "binary file" rows: a folder of
 * 30 000 hand histories and 2 000 table screenshots should read as 30 000
 * files. Anything not on this list still goes to the decoder, which refuses
 * a real binary with a reason; this list only saves reading the obvious ones.
 */
const NOT_HAND_HISTORY = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg", "heic", "tif", "tiff",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "rtf",
  "mp3", "wav", "ogg", "mp4", "mov", "avi", "mkv", "webm",
  "exe", "dll", "so", "dylib", "msi", "dmg", "pkg", "app", "jar", "class", "bin", "iso",
  "db", "sqlite", "sqlite3", "mdb", "ldb", "dat", "idx",
  "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "zst",
  "js", "css", "html", "htm", "json", "ini", "cfg", "plist", "lnk", "url", "torrent",
]);

/** Null when the entry should be read; otherwise why it is left out. */
export function skipReason(path: string): "hidden" | "not-hand-history" | null {
  const parts = path.split("/").filter(Boolean);
  const leaf = path.endsWith("/") ? "" : parts.at(-1) ?? "";
  if (!leaf || parts.some((part) => part.startsWith(".")) || parts[0] === "__MACOSX") {
    return "hidden";
  }
  const dot = leaf.lastIndexOf(".");
  const extension = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
  return NOT_HAND_HISTORY.has(extension) ? "not-hand-history" : null;
}

/** A {@link ZipEntryError} as the per-file problem the converter shows. */
export function zipEntryProblem(error: unknown, bytes: number): SourceProblem {
  if (error instanceof ZipEntryError) {
    switch (error.kind) {
      case "encrypted-entry":
        return { kind: "encrypted-entry" };
      case "cannot-unzip":
        return { kind: "cannot-unzip" };
      case "too-large":
        return { kind: "too-large", bytes };
      default:
        return { kind: "unreadable-entry", detail: error.message };
    }
  }
  return { kind: "unreadable-entry", detail: error instanceof Error ? error.message : undefined };
}

/**
 * Reads every plausible text entry out of a zip, all at once.
 *
 * The single-hand box's reader, and the converter's before R4.2. It no longer
 * loads the archive (`zipStream.ts` reads it entry by entry), but it does
 * return every entry's text together, so it is for small archives; the
 * converter streams through `bulkSource.ts` instead.
 */
export async function readZip(file: Blob & { name: string }): Promise<LoadedSource[]> {
  const directory = await readZipDirectory(file);
  if ("problem" in directory) {
    return [{ id: nextId(), name: file.name, bytes: file.size, text: "", encoding: "-", problem: { kind: directory.problem } }];
  }
  const out: LoadedSource[] = [];
  for (const entry of directory.entries) {
    if (entry.directory || skipReason(entry.name)) {
      continue;
    }
    const label = `${file.name} → ${entry.name}`;
    try {
      const content = await readZipEntry(file, entry, MAX_SOURCE_BYTES);
      const decoded = decodeSource(content.buffer as ArrayBuffer);
      out.push({ id: nextId(), name: label, bytes: entry.uncompressedSize, ...decoded });
    } catch (error) {
      out.push({
        id: nextId(),
        name: label,
        bytes: entry.uncompressedSize,
        text: "",
        encoding: "-",
        problem: zipEntryProblem(error, entry.uncompressedSize),
      });
    }
  }
  if (out.length === 0) {
    return [{ id: nextId(), name: file.name, bytes: file.size, text: "", encoding: "-", problem: { kind: "empty-archive" } }];
  }
  return out;
}

/* ----------------------------------------------------------------- files - */

export function isZip(file: { name: string; type?: string }): boolean {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

/** Reads one picked or dropped file into one or more sources. */
export async function loadFile(file: File): Promise<LoadedSource[]> {
  if (isZip(file)) {
    return readZip(file);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return [{
      id: nextId(),
      name: file.name,
      bytes: file.size,
      text: "",
      encoding: "-",
      problem: { kind: "too-large", bytes: file.size },
    }];
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

/**
 * A picked or dropped file and where it sat in what the user gave us:
 * `HandHistory/Player/HH20261001.txt` for a file inside a dropped or picked
 * folder, the bare name otherwise. The path is the file's identity for a
 * resumed upload (`bulkSource.ts`) and the name shown for it.
 */
export interface PickedFile {
  file: File;
  path: string;
}

/** A file from an `<input type="file">`, folder pickers included. */
export function pickedFile(file: File): PickedFile {
  return { file, path: file.webkitRelativePath || file.name };
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file(onSuccess: (file: File) => void, onError: (error: unknown) => void): void;
  createReader(): {
    readEntries(onSuccess: (entries: FileSystemEntryLike[]) => void, onError: (error: unknown) => void): void;
  };
}

/**
 * Hard cap on a dropped folder, so a stray home directory cannot hang the tab.
 *
 * 500 before R4.2. A `File` from the entries API is a handle, not its bytes
 * (~200 bytes each), and the files are read one at a time, so the cap is now
 * what a real tracker export can hold: a PokerStars folder of ten years is a
 * few tens of thousands of daily files.
 */
export const MAX_DROPPED_FILES = 100_000;

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

function entryPath(entry: FileSystemEntryLike): string {
  return (entry.fullPath ?? entry.name).replace(/^\/+/, "") || entry.name;
}

async function collectEntry(entry: FileSystemEntryLike, out: PickedFile[], inFolder: boolean): Promise<void> {
  if (out.length >= MAX_DROPPED_FILES) {
    return;
  }
  if (entry.isFile) {
    const path = entryPath(entry);
    // Inside a folder, the room's screenshots and the OS's dotfiles stay out;
    // a file dropped on its own is read whatever it is called.
    if (inFolder && skipReason(path)) {
      return;
    }
    const file = await entryFile(entry);
    if (file) {
      out.push({ file, path });
    }
    return;
  }
  if (entry.isDirectory) {
    if (inFolder && entry.name.startsWith(".")) {
      return;
    }
    for (const child of await readDirectory(entry)) {
      await collectEntry(child, out, true);
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
export async function filesFromDrop(transfer: DataTransfer): Promise<PickedFile[]> {
  const items = Array.from(transfer.items ?? []);
  const entries = items
    .map((item) => (item.kind === "file" && "webkitGetAsEntry" in item
      ? (item.webkitGetAsEntry() as unknown as FileSystemEntryLike | null)
      : null))
    .filter((entry): entry is FileSystemEntryLike => entry !== null);

  const plain = () => Array.from(transfer.files ?? []).slice(0, MAX_DROPPED_FILES).map(pickedFile);
  if (entries.length === 0) {
    return plain();
  }

  const out: PickedFile[] = [];
  for (const entry of entries) {
    await collectEntry(entry, out, false);
  }
  // A browser that gave us entries but no files (rare, and seen on some Linux
  // builds) should still fall back rather than silently drop the whole drop.
  return out.length > 0 ? out : plain();
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
