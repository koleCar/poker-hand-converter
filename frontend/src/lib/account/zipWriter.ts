/**
 * A streaming ZIP writer (Rail R6.5: the account export).
 *
 * The export of a 1 000 000-hand account is gigabytes of JSON. Nothing here
 * holds an entry, let alone the archive: each entry's bytes go through the
 * browser's own `CompressionStream("deflate-raw")` straight to a sink (a file
 * the user picked, through the File System Access API, or a list of Blob
 * parts the browser keeps on disk), with the CRC-32 and sizes counted on the
 * way and written after the data (a data descriptor, general-purpose bit 3).
 *
 *   - Entries are written one at a time (`openEntry` ... `close`), deflated
 *     or stored (`compress: false`: the kept original files are gzip already).
 *   - Names are UTF-8 (bit 11).
 *   - An entry is at most 4 GiB - 1 uncompressed (the exporter splits its
 *     files far below that); the **archive** may be larger and have more than
 *     65 535 entries: the central directory then carries zip64 offsets and the
 *     end of the archive a zip64 record and locator.
 *
 * Read back by the converter's own reader (`components/converter/
 * zipStream.ts`) in the tests, and by every OS archiver.
 *
 * No library, for the reason `zipStream.ts` gives: the browser ships deflate.
 */

export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ZipEntryWriter {
  write(chunk: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

interface CentralEntry {
  name: Uint8Array;
  method: 0 | 8;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309) of `bytes`, continuing from `crc` (start: 0). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** MS-DOS time and date (local fields, 2-second resolution, from 1980). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getFullYear(), 1980);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

class Bytes {
  private readonly view: DataView;
  readonly array: Uint8Array;
  private at = 0;
  constructor(size: number) {
    this.array = new Uint8Array(size);
    this.view = new DataView(this.array.buffer);
  }
  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }
  u32(value: number): this {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(value: number): this {
    this.view.setUint32(this.at, value % 0x100000000, true);
    this.view.setUint32(this.at + 4, Math.floor(value / 0x100000000), true);
    this.at += 8;
    return this;
  }
  bytes(value: Uint8Array): this {
    this.array.set(value, this.at);
    this.at += value.length;
    return this;
  }
}

const encoder = new TextEncoder();

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private open = false;
  private closed = false;
  private readonly sink: ZipSink;
  private readonly now: () => Date;

  constructor(sink: ZipSink, now: () => Date = () => new Date()) {
    this.sink = sink;
    this.now = now;
  }

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    await this.sink.write(chunk);
    this.offset += chunk.length;
  }

  /** Starts an entry; write its bytes, then `close()` it before the next. */
  async openEntry(name: string, options: { compress?: boolean } = {}): Promise<ZipEntryWriter> {
    if (this.closed) throw new Error("The archive is already finished.");
    if (this.open) throw new Error("Close the previous entry first.");
    const nameBytes = encoder.encode(name.replace(/^\/+/, ""));
    if (nameBytes.length === 0 || nameBytes.length > MAX_16) throw new Error("An entry needs a name.");
    this.open = true;

    const method: 0 | 8 = options.compress === false ? 0 : 8;
    const { time, date } = dosDateTime(this.now());
    const offset = this.offset;
    await this.emit(
      new Bytes(30 + nameBytes.length)
        .u32(0x04034b50)
        .u16(20) // version needed: 2.0
        .u16(0x0808) // bit 3: sizes in the data descriptor; bit 11: UTF-8 name
        .u16(method)
        .u16(time)
        .u16(date)
        .u32(0) // CRC-32, in the descriptor
        .u32(0) // compressed size, in the descriptor
        .u32(0) // size, in the descriptor
        .u16(nameBytes.length)
        .u16(0)
        .bytes(nameBytes).array,
    );

    let crc = 0;
    let size = 0;
    let compressed = 0;
    let pump: Promise<void> = Promise.resolve();
    let pumpError: unknown = null;
    let input: WritableStreamDefaultWriter<Uint8Array> | null = null;
    if (method === 8) {
      const stream = new CompressionStream("deflate-raw");
      const writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
      input = writer;
      const output = stream.readable.getReader();
      pump = (async () => {
        for (;;) {
          const { done, value } = await output.read();
          if (done) return;
          compressed += value.length;
          await this.emit(value);
        }
      })();
      // A sink that fails stops the compressor too, so a pending write
      // rejects instead of waiting forever for a reader that left.
      pump.catch((error: unknown) => {
        pumpError = error;
        writer.abort(error).catch(() => undefined);
      });
    }

    let finished = false;
    const write = async (chunk: Uint8Array | string): Promise<void> => {
      if (finished) throw new Error("The entry is closed.");
      if (pumpError) throw pumpError;
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      if (bytes.length === 0) return;
      crc = crc32(bytes, crc);
      size += bytes.length;
      if (size >= MAX_32) throw new Error("An entry must stay under 4 GiB.");
      if (input) {
        await input.write(bytes);
      } else {
        compressed += bytes.length;
        await this.emit(bytes);
      }
    };
    const close = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      if (input) {
        await input.close();
      }
      await pump;
      await this.emit(new Bytes(16).u32(0x08074b50).u32(crc).u32(compressed).u32(size).array);
      this.entries.push({ name: nameBytes, method, crc, compressed, size, offset, time, date });
      this.open = false;
    };
    return { write, close };
  }

  /** One whole entry at once. */
  async addEntry(name: string, data: Uint8Array | string, options: { compress?: boolean } = {}): Promise<void> {
    const entry = await this.openEntry(name, options);
    await entry.write(data);
    await entry.close();
  }

  /** Writes the central directory and the end records, and closes the sink. */
  async finish(): Promise<{ bytes: number; entries: number }> {
    if (this.closed) throw new Error("The archive is already finished.");
    if (this.open) throw new Error("Close the last entry first.");
    this.closed = true;

    const directoryStart = this.offset;
    for (const e of this.entries) {
      const zip64 = e.offset >= MAX_32;
      const extra = zip64 ? new Bytes(12).u16(0x0001).u16(8).u64(e.offset).array : new Uint8Array(0);
      await this.emit(
        new Bytes(46 + e.name.length + extra.length)
          .u32(0x02014b50)
          .u16(zip64 ? 45 : 20) // version made by (MS-DOS / FAT attributes)
          .u16(zip64 ? 45 : 20) // version needed
          .u16(0x0808)
          .u16(e.method)
          .u16(e.time)
          .u16(e.date)
          .u32(e.crc)
          .u32(e.compressed)
          .u32(e.size)
          .u16(e.name.length)
          .u16(extra.length)
          .u16(0) // comment
          .u16(0) // disk
          .u16(0) // internal attributes
          .u32(0) // external attributes
          .u32(zip64 ? MAX_32 : e.offset)
          .bytes(e.name)
          .bytes(extra).array,
      );
    }
    const directorySize = this.offset - directoryStart;
    const count = this.entries.length;

    if (count >= MAX_16 || directoryStart >= MAX_32 || directorySize >= MAX_32) {
      const recordAt = this.offset;
      await this.emit(
        new Bytes(56)
          .u32(0x06064b50)
          .u64(44) // size of the rest of this record
          .u16(45)
          .u16(45)
          .u32(0)
          .u32(0)
          .u64(count)
          .u64(count)
          .u64(directorySize)
          .u64(directoryStart).array,
      );
      await this.emit(new Bytes(20).u32(0x07064b50).u32(0).u64(recordAt).u32(1).array);
    }
    await this.emit(
      new Bytes(22)
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(Math.min(count, MAX_16))
        .u16(Math.min(count, MAX_16))
        .u32(Math.min(directorySize, MAX_32))
        .u32(Math.min(directoryStart, MAX_32))
        .u16(0).array,
    );
    await this.sink.close();
    return { bytes: this.offset, entries: count };
  }
}

/**
 * A sink that keeps the archive as Blob parts: the fallback where the browser
 * cannot write to a file the user picked. Small writes are gathered into
 * ~4 MB parts so the Blob is not millions of pieces; the browser keeps large
 * Blobs on disk, not in the tab's memory.
 */
export class BlobSink implements ZipSink {
  private readonly parts: Blob[] = [];
  private buffer: Uint8Array[] = [];
  private buffered = 0;
  private blob: Blob | null = null;
  private readonly type: string;
  private readonly partBytes: number;

  constructor(type = "application/zip", partBytes = 4 * 1024 * 1024) {
    this.type = type;
    this.partBytes = partBytes;
  }

  write(chunk: Uint8Array): Promise<void> {
    // The writer reuses nothing it hands over, but copy anyway: a Blob part
    // must not change after it is made.
    this.buffer.push(chunk.slice());
    this.buffered += chunk.length;
    if (this.buffered >= this.partBytes) this.flush();
    return Promise.resolve();
  }

  private flush(): void {
    if (this.buffered === 0) return;
    this.parts.push(new Blob(this.buffer as BlobPart[]));
    this.buffer = [];
    this.buffered = 0;
  }

  close(): Promise<void> {
    this.flush();
    this.blob = new Blob(this.parts, { type: this.type });
    return Promise.resolve();
  }

  /** The archive, after `close()`. */
  toBlob(): Blob {
    if (!this.blob) throw new Error("The archive is not finished.");
    return this.blob;
  }
}

/** A sink over a `FileSystemWritableFileStream` (a file the user picked). */
export function writableSink(stream: {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}): ZipSink {
  return {
    write: (chunk) => stream.write(chunk),
    close: () => stream.close(),
  };
}
