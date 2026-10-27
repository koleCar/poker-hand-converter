/**
 * A zip reader that never holds the archive in memory (R4.2).
 *
 * The first reader (`readZip` before R4.2) did `file.arrayBuffer()` and then
 * walked the central directory: fine for the 8 MB zip a room emails, fatal for
 * the 400 MB export of a desktop database - the tab holds the archive, then
 * every inflated entry, then every entry's text, all at once. This one reads
 * the archive through `Blob.slice()`, which on a `File` is a window onto the
 * disk, not a copy:
 *
 *  * the end-of-central-directory record from the last 64 KiB (plus the zip64
 *    locator and record when the archive needs them),
 *  * the central directory itself (~80 bytes an entry: a 100 000-entry export
 *    is 8 MB, the one part read whole),
 *  * then **one entry at a time**, when the caller asks for it: its local
 *    header, and its compressed bytes streamed through the browser's own
 *    `DecompressionStream("deflate-raw")` into one buffer of the entry's
 *    declared size.
 *
 * So the most the tab holds for an archive of any size is the directory plus
 * one entry, inflated. A caller that converts an entry and lets it go before
 * asking for the next one (`bulkSource.ts`) runs a 1 GB archive in the memory
 * of its largest file.
 *
 * ## Why no library
 *
 * The candidates were fflate (~8 KB gzipped for its streaming unzip) and
 * zip.js (~25 KB gzipped, its own workers). Both bring their own inflate in
 * JavaScript; every browser the app supports (`DecompressionStream`: Chrome
 * 80, Safari 16.4, Firefox 113) already ships a native one, which is faster
 * and costs no bytes. What is left is parsing two record types, which is
 * this file (~2 KB gzipped). Deflate (8) and stored (0) are the only methods
 * any poker client or OS archiver writes; anything else (bzip2, LZMA, zstd)
 * is reported per entry, not guessed at.
 *
 * Zip64 is supported (an export of more than 65 535 files or 4 GiB needs it);
 * encryption is not, per entry, with a readable reason.
 */

/** Signatures, little-endian. */
const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The fixed part of the end-of-central-directory record. */
const EOCD_SIZE = 22;
/** Its trailing comment is at most this long, so the record is in this tail. */
const MAX_COMMENT = 0xffff;

/** One file in the archive, from the central directory. Nothing is read yet. */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** 0 stored, 8 deflate; anything else cannot be read. */
  method: number;
  encrypted: boolean;
  compressedSize: number;
  uncompressedSize: number;
  /** CRC-32 of the uncompressed bytes, as the archive states it. */
  crc32: number;
  /** Where the entry's local header starts. */
  localOffset: number;
  /** A directory entry (`name/`) - carries no data. */
  directory: boolean;
}

/** Why an archive as a whole cannot be read. */
export type ZipDirectoryProblem = "not-zip" | "cannot-unzip";

export class ZipEntryError extends Error {
  readonly kind: "encrypted-entry" | "unsupported-method" | "corrupt" | "too-large" | "cannot-unzip";
  constructor(kind: ZipEntryError["kind"], message: string) {
    super(message);
    this.name = "ZipEntryError";
    this.kind = kind;
  }
}

async function readRange(blob: Blob, start: number, end: number): Promise<DataView> {
  const buffer = await blob.slice(start, end).arrayBuffer();
  return new DataView(buffer);
}

/** A 64-bit little-endian integer as a number (exact up to 2^53, i.e. 8 PiB). */
function u64(view: DataView, offset: number): number {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x1_0000_0000;
}

/**
 * Entry names are read as UTF-8 whatever flag bit 11 says: older archivers
 * wrote CP437, which no browser decoder offers, and reading it as UTF-8 can
 * only garble a display name (and a resume key, consistently), never contents.
 */
function decodeName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Reads the archive's directory: the entries and where each one lives.
 *
 * Returns a problem instead of throwing for "this is not a zip": that is a
 * per-file note in the converter, like every other unreadable input.
 */
export async function readZipDirectory(blob: Blob): Promise<{ entries: ZipEntry[] } | { problem: ZipDirectoryProblem }> {
  const size = blob.size;
  if (size < EOCD_SIZE) {
    return { problem: "not-zip" };
  }
  const tailStart = Math.max(0, size - EOCD_SIZE - MAX_COMMENT);
  const tail = await readRange(blob, tailStart, size);
  let eocd = -1;
  for (let i = tail.byteLength - EOCD_SIZE; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return { problem: "not-zip" };
  }

  let entryCount = tail.getUint16(eocd + 10, true);
  let directorySize = tail.getUint32(eocd + 12, true);
  let directoryOffset = tail.getUint32(eocd + 16, true);

  // Zip64: any of the three saturated means the real values are in the zip64
  // record, which the locator just before the EOCD points at.
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0 || tail.getUint32(locatorAt, true) !== ZIP64_LOCATOR) {
      return { problem: "not-zip" };
    }
    const recordOffset = u64(tail, locatorAt + 8);
    if (recordOffset + 56 > size) {
      return { problem: "not-zip" };
    }
    const record = await readRange(blob, recordOffset, recordOffset + 56);
    if (record.getUint32(0, true) !== ZIP64_EOCD) {
      return { problem: "not-zip" };
    }
    entryCount = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
  }

  if (directoryOffset + directorySize > size) {
    return { problem: "not-zip" };
  }
  const directory = await readRange(blob, directoryOffset, directoryOffset + directorySize);
  const bytes = new Uint8Array(directory.buffer);
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > directory.byteLength || directory.getUint32(cursor, true) !== CENTRAL) {
      break;
    }
    const flags = directory.getUint16(cursor + 8, true);
    const method = directory.getUint16(cursor + 10, true);
    const crc32 = directory.getUint32(cursor + 16, true);
    let compressedSize = directory.getUint32(cursor + 20, true);
    let uncompressedSize = directory.getUint32(cursor + 24, true);
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    let localOffset = directory.getUint32(cursor + 42, true);
    const name = decodeName(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    // The zip64 extended-information field holds, in this order, only the
    // values that are saturated in the fixed record.
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff && field + 8 <= extra + 4 + length) {
          uncompressedSize = u64(directory, field);
          field += 8;
        }
        if (compressedSize === 0xffffffff && field + 8 <= extra + 4 + length) {
          compressedSize = u64(directory, field);
          field += 8;
        }
        if (localOffset === 0xffffffff && field + 8 <= extra + 4 + length) {
          localOffset = u64(directory, field);
        }
      }
      extra += 4 + length;
    }

    entries.push({
      name,
      method,
      encrypted: (flags & 0x0001) !== 0,
      compressedSize,
      uncompressedSize,
      crc32,
      localOffset,
      directory: name.endsWith("/"),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { entries };
}

/**
 * The entry's bytes, uncompressed. Reads only this entry's range of the blob.
 *
 * `maxBytes` refuses an entry whose declared size is larger, and stops an
 * inflate that produces more than it declared (a zip bomb, or a corrupt
 * directory), so a hostile archive costs at most `maxBytes` of memory.
 */
export async function readZipEntry(blob: Blob, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  if (entry.encrypted) {
    throw new ZipEntryError("encrypted-entry", "encrypted entry");
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipEntryError("unsupported-method", `compression method ${entry.method} is not supported`);
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new ZipEntryError("too-large", `entry is ${entry.uncompressedSize} bytes`);
  }
  const header = await readRange(blob, entry.localOffset, Math.min(blob.size, entry.localOffset + 30));
  if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) {
    throw new ZipEntryError("corrupt", "local header not found");
  }
  const dataStart = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > blob.size) {
    throw new ZipEntryError("corrupt", "entry runs past the end of the archive");
  }
  const raw = blob.slice(dataStart, dataEnd);

  if (entry.method === 0) {
    return new Uint8Array(await raw.arrayBuffer());
  }

  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Decompression) {
    throw new ZipEntryError("cannot-unzip", "DecompressionStream is not available");
  }
  // One buffer of the declared size, filled as the inflater produces output:
  // no list of chunks, no second copy at the end.
  const out = new Uint8Array(entry.uncompressedSize);
  let filled = 0;
  const reader = raw.stream().pipeThrough(new Decompression("deflate-raw")).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (filled + value.byteLength > out.byteLength) {
        throw new ZipEntryError("corrupt", "entry inflates past its declared size");
      }
      out.set(value, filled);
      filled += value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ZipEntryError) {
      throw error;
    }
    throw new ZipEntryError("corrupt", error instanceof Error ? error.message : String(error));
  }
  if (filled !== out.byteLength) {
    throw new ZipEntryError("corrupt", "entry is shorter than its declared size");
  }
  return out;
}
