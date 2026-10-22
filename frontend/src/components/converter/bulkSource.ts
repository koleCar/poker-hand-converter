/**
 * What the user dropped, read one file at a time (R4.2).
 *
 * Before R4.2 the converter decoded every dropped file - and every entry of
 * every zip - before converting the first hand, and posted all of that text to
 * the worker in one message. That is a tab holding the whole drop twice over;
 * at a desktop export's scale (hundreds of MB, a million hands) it is a
 * crashed tab. This module is the lazy version: an async generator over the
 * drop that reads, inflates and decodes **the next file only when the
 * consumer asks for it**, so at any moment the tab holds one file's bytes and
 * text (plus the archive's directory, `zipStream.ts`).
 *
 * It runs in the conversion worker (the `File` handles are posted to it, which
 * copies no bytes) and, when no worker can start, on the page.
 *
 * Every source gets a **key**: the identity a resumed upload recognises it by
 * (`bulkSaver.ts` records the keys whose hands are all stored). A file is its
 * path, size and modification time; an archive entry is the archive's key
 * plus the entry's name, CRC-32 and size - what the archive's directory says,
 * so an entry already saved is skipped without inflating it.
 */

import {
  decodeSource,
  isZip,
  MAX_SOURCE_BYTES,
  skipReason,
  zipEntryProblem,
  type SourceProblem,
} from "./inputs";
import { readZipDirectory, readZipEntry } from "./zipStream";

/** One thing the user gave the converter. */
export type InputItem =
  | { kind: "file"; file: Blob & { name: string; lastModified?: number }; path: string }
  | { kind: "text"; name: string; text: string };

/** A file (or archive entry, or pasted block), read and decoded. */
export interface BulkSource {
  id: string;
  /** Identity across attempts of the same upload; see the module header. */
  key: string;
  /** Display name; archive entries read `archive.zip → hands/file.txt`. */
  name: string;
  /** Size of the file, or of the entry uncompressed. */
  bytes: number;
  encoding: string;
  /** Decoded text; empty when `problem` is set. */
  text: string;
  problem?: SourceProblem;
  /**
   * The original file gzip-compressed, for the opt-in copy in Storage (A2).
   * Only when asked for, and only for a file that decoded.
   */
  original?: { path: string; blob: Blob };
}

export interface ReadInputsOptions {
  /** Prefix for source ids, so two runs never share one. */
  idPrefix?: string;
  /** Gzip each readable original for the Storage opt-in. */
  keepOriginals?: boolean;
  /** True for a key an earlier attempt already stored: it is not read at all. */
  isDone?(key: string): boolean;
  /**
   * Called as the drop's bytes are consumed - read files, archive entries
   * (compressed), skipped entries, already-stored files, an archive's
   * directory - so the sum reaches the drop's total size (the progress bar's
   * denominator). `skipped` counts what was left out: stored by an earlier
   * attempt (`done`) or not a hand history (`other`).
   */
  onConsumed?(bytes: number, skipped: { done: number; other: number }): void;
  /** Stops before the next file is read. */
  isCancelled?(): boolean;
  /** Largest single file or entry decoded; the default is the converter's. */
  maxSourceBytes?: number;
}

/** How deep a zip inside a zip is followed. */
const MAX_ZIP_DEPTH = 2;

/** FNV-1a, 32 bits, as 8 hex digits: a short stable tag, not a security hash. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A path that is safe as a Storage object name: ASCII letters, digits and
 * `._- ()` per segment, no empty or dot segments, each segment at most 80
 * characters; ends in the key's hash so two names that sanitise alike stay
 * apart, and so the same file lands on the same object when an upload resumes.
 */
export function storagePathFor(displayPath: string, key: string): string {
  const segments = displayPath
    .split(/[\\/]|\s→\s/)
    .map((segment) =>
      segment
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9._\- ()]/g, "_")
        .replace(/^\.+/, "_")
        .slice(0, 80)
        .trim(),
    )
    .filter((segment) => segment.length > 0);
  const leaf = segments.pop() ?? "file";
  return [...segments.slice(-6), `${leaf}.${shortHash(key)}.gz`].join("/");
}

/** The bytes gzip-compressed, streamed: never a second uncompressed copy. */
async function gzip(data: Blob): Promise<Blob> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Compression) {
    throw new Error("CompressionStream is not available");
  }
  const compressed = await new Response(data.stream().pipeThrough(new Compression("gzip"))).blob();
  return new Blob([compressed], { type: "application/gzip" });
}

function fileKey(item: Extract<InputItem, { kind: "file" }>): string {
  return `f|${item.path}|${item.file.size}|${item.file.lastModified ?? 0}`;
}

/**
 * The drop as a stream of decoded sources, read lazily and in order.
 *
 * A file that cannot be read is still yielded, with its `problem`, so the
 * converter can list it; entries and folder files that are obviously not
 * hand histories (`skipReason`) and keys already stored (`isDone`) are not
 * yielded at all, only counted through `onConsumed`.
 */
export async function* readInputs(items: InputItem[], options: ReadInputsOptions = {}): AsyncGenerator<BulkSource> {
  const prefix = options.idPrefix ?? "bulk";
  const maxBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES;
  let sequence = 0;
  const nextId = () => `${prefix}-${(sequence += 1)}`;
  const consumed = (bytes: number, done = 0, other = 0) => options.onConsumed?.(bytes, { done, other });
  const cancelled = () => options.isCancelled?.() ?? false;

  async function decoded(
    key: string,
    name: string,
    storageName: string,
    bytes: Uint8Array | null,
    fallbackBytes: number,
    problem?: SourceProblem,
  ): Promise<BulkSource> {
    if (!bytes || problem) {
      return { id: nextId(), key, name, bytes: fallbackBytes, encoding: "-", text: "", problem };
    }
    const result = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const source: BulkSource = { id: nextId(), key, name, bytes: bytes.byteLength, ...result };
    if (options.keepOriginals && !result.problem) {
      source.original = { path: storagePathFor(storageName, key), blob: await gzip(new Blob([bytes as BlobPart])) };
    }
    return source;
  }

  async function* zip(
    archive: Blob,
    archiveKey: string,
    archiveName: string,
    archivePath: string,
    depth: number,
    counts = true,
  ): AsyncGenerator<BulkSource> {
    // An inner archive's bytes were already counted as its outer entry.
    const consumed = (bytes: number, done = 0, other = 0) => {
      if (counts || done || other) {
        options.onConsumed?.(counts ? bytes : 0, { done, other });
      }
    };
    const directory = await readZipDirectory(archive);
    if ("problem" in directory) {
      consumed(archive.size);
      yield { id: nextId(), key: archiveKey, name: archiveName, bytes: archive.size, encoding: "-", text: "", problem: { kind: directory.problem } };
      return;
    }
    let accounted = 0;
    let readable = 0;
    let doneBefore = 0;
    for (const entry of directory.entries) {
      if (cancelled()) {
        return;
      }
      const share = entry.compressedSize + 30 + entry.name.length;
      accounted += share;
      if (entry.directory) {
        consumed(share);
        continue;
      }
      if (skipReason(entry.name)) {
        consumed(share, 0, 1);
        continue;
      }
      const key = `${archiveKey}|${entry.name}|${entry.crc32}|${entry.uncompressedSize}`;
      if (options.isDone?.(key)) {
        doneBefore += 1;
        consumed(share, 1, 0);
        continue;
      }
      const name = `${archiveName} → ${entry.name}`;
      const path = `${archivePath}/${entry.name}`;
      if (/\.zip$/i.test(entry.name) && depth < MAX_ZIP_DEPTH) {
        let inner: Uint8Array;
        try {
          inner = await readZipEntry(archive, entry, maxBytes);
        } catch (error) {
          consumed(share);
          readable += 1;
          yield await decoded(key, name, path, null, entry.uncompressedSize, zipEntryProblem(error, entry.uncompressedSize));
          continue;
        }
        // The inner archive is in memory (it is one entry, under the size
        // cap); its own entries are read from that copy one at a time. Its
        // bytes are this entry's share of the outer archive, so its progress
        // is not counted twice.
        readable += 1;
        consumed(share);
        yield* zip(new Blob([inner as BlobPart]), key, name, path, depth + 1, false);
        continue;
      }
      readable += 1;
      let content: Uint8Array | null = null;
      let problem: SourceProblem | undefined;
      try {
        content = await readZipEntry(archive, entry, maxBytes);
      } catch (error) {
        problem = zipEntryProblem(error, entry.uncompressedSize);
      }
      consumed(share);
      yield await decoded(key, name, path, content, entry.uncompressedSize, problem);
      content = null;
    }
    consumed(Math.max(0, archive.size - accounted));
    if (readable === 0 && doneBefore === 0) {
      yield { id: nextId(), key: archiveKey, name: archiveName, bytes: archive.size, encoding: "-", text: "", problem: { kind: "empty-archive" } };
    }
  }

  for (const item of items) {
    if (cancelled()) {
      return;
    }
    if (item.kind === "text") {
      const key = `t|${item.text.length}|${shortHash(item.text)}`;
      const normalized = item.text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
      if (options.isDone?.(key)) {
        consumed(normalized.length, 1, 0);
        continue;
      }
      const bytes = new TextEncoder().encode(normalized);
      consumed(normalized.length);
      yield {
        id: nextId(),
        key,
        name: item.name,
        bytes: bytes.byteLength,
        encoding: "UTF-8",
        text: normalized,
        problem: normalized.trim() ? undefined : { kind: "nothing-pasted" },
        original: options.keepOriginals && normalized.trim()
          ? { path: storagePathFor(item.name, key), blob: await gzip(new Blob([bytes as BlobPart])) }
          : undefined,
      };
      continue;
    }

    const key = fileKey(item);
    if (isZip(item.file)) {
      yield* zip(item.file, key, item.file.name, item.path, 1);
      continue;
    }
    if (options.isDone?.(key)) {
      consumed(item.file.size, 1, 0);
      continue;
    }
    if (item.file.size > maxBytes) {
      consumed(item.file.size);
      yield await decoded(key, item.file.name, item.path, null, item.file.size, { kind: "too-large", bytes: item.file.size });
      continue;
    }
    let content: Uint8Array | null = null;
    let problem: SourceProblem | undefined;
    try {
      content = new Uint8Array(await item.file.arrayBuffer());
    } catch (error) {
      problem = { kind: "unreadable-file", detail: error instanceof Error ? error.message : undefined };
    }
    consumed(item.file.size);
    yield await decoded(key, item.file.name, item.path, content, item.file.size, problem);
    content = null;
  }
}
