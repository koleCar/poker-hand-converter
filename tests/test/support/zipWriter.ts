/**
 * A small zip writer for the bulk-upload tests (R4.2): archives are built in
 * memory at test time, never committed (nothing synthetic under `fixtures/`).
 *
 * Stored and deflated entries, directory entries, the encryption flag (the
 * bytes are not encrypted - the reader must refuse on the flag), any method
 * number, and zip64 (every size and offset saturated in the fixed records, the
 * real values in the zip64 extra field and end records).
 */

import { deflateRawSync } from "node:zlib";

export interface ZipInput {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate (default); anything else is written as that method, stored. */
  method?: number;
  encrypted?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;
  bytes(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }
  u16(value: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value, true);
    this.bytes(b);
  }
  u32(value: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.bytes(b);
  }
  u64(value: number): void {
    this.u32(value % 0x1_0000_0000);
    this.u32(Math.floor(value / 0x1_0000_0000));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const encoder = new TextEncoder();

export function buildZip(entries: ZipInput[], options: { zip64?: boolean } = {}): Uint8Array {
  const zip64 = options.zip64 ?? false;
  const out = new Writer();
  const central: Array<{
    name: Uint8Array;
    flags: number;
    method: number;
    crc: number;
    csize: number;
    usize: number;
    offset: number;
  }> = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = entry.data === undefined ? new Uint8Array(0) : typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const method = entry.name.endsWith("/") ? 0 : entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const flags = 0x800 | (entry.encrypted ? 0x1 : 0);
    const record = { name, flags, method, crc: crc32(raw), csize: body.length, usize: raw.length, offset: out.length };
    central.push(record);
    out.u32(0x04034b50);
    out.u16(zip64 ? 45 : 20);
    out.u16(flags);
    out.u16(method);
    out.u16(0);
    out.u16(0x21);
    out.u32(record.crc);
    out.u32(zip64 ? 0xffffffff : record.csize);
    out.u32(zip64 ? 0xffffffff : record.usize);
    out.u16(name.length);
    out.u16(zip64 ? 20 : 0);
    out.bytes(name);
    if (zip64) {
      out.u16(0x0001);
      out.u16(16);
      out.u64(record.usize);
      out.u64(record.csize);
    }
    out.bytes(body);
  }

  const directoryOffset = out.length;
  for (const record of central) {
    out.u32(0x02014b50);
    out.u16(zip64 ? 45 : 20);
    out.u16(zip64 ? 45 : 20);
    out.u16(record.flags);
    out.u16(record.method);
    out.u16(0);
    out.u16(0x21);
    out.u32(record.crc);
    out.u32(zip64 ? 0xffffffff : record.csize);
    out.u32(zip64 ? 0xffffffff : record.usize);
    out.u16(record.name.length);
    out.u16(zip64 ? 28 : 0);
    out.u16(0);
    out.u16(0);
    out.u16(0);
    out.u32(0);
    out.u32(zip64 ? 0xffffffff : record.offset);
    out.bytes(record.name);
    if (zip64) {
      out.u16(0x0001);
      out.u16(24);
      out.u64(record.usize);
      out.u64(record.csize);
      out.u64(record.offset);
    }
  }
  const directorySize = out.length - directoryOffset;

  if (zip64) {
    const recordOffset = out.length;
    out.u32(0x06064b50);
    out.u64(44);
    out.u16(45);
    out.u16(45);
    out.u32(0);
    out.u32(0);
    out.u64(central.length);
    out.u64(central.length);
    out.u64(directorySize);
    out.u64(directoryOffset);
    out.u32(0x07064b50);
    out.u32(0);
    out.u64(recordOffset);
    out.u32(1);
  }

  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(zip64 ? 0xffff : central.length);
  out.u16(zip64 ? 0xffff : central.length);
  out.u32(zip64 ? 0xffffffff : directorySize);
  out.u32(zip64 ? 0xffffffff : directoryOffset);
  out.u16(0);
  return out.done();
}

/**
 * A `File`-like view of `bytes` that records every range read through
 * `slice()` - the only way the streaming reader touches an archive.
 */
export function trackedFile(
  bytes: Uint8Array,
  name: string,
  reads: Array<[number, number]>,
  lastModified = 1_700_000_000_000,
): File {
  const blob = new Blob([bytes as BlobPart]);
  const view = {
    name,
    size: blob.size,
    type: name.endsWith(".zip") ? "application/zip" : "",
    lastModified,
    slice(start = 0, end = blob.size) {
      const from = Math.max(0, start < 0 ? blob.size + start : start);
      const to = Math.min(blob.size, end < 0 ? blob.size + end : end);
      reads.push([from, to]);
      return blob.slice(from, to);
    },
    arrayBuffer() {
      reads.push([0, blob.size]);
      return blob.arrayBuffer();
    },
    stream() {
      reads.push([0, blob.size]);
      return blob.stream();
    },
    text() {
      reads.push([0, blob.size]);
      return blob.text();
    },
  };
  return view as unknown as File;
}

/** A plain `File` (Node 20+ has the global). */
export function file(name: string, data: string | Uint8Array, lastModified = 1_700_000_000_000): File {
  return new File([data as BlobPart], name, { lastModified });
}
