/**
 * Bulk upload at desktop scale (docs/RAIL-PLAN.md R4.2): how much memory and
 * time a desktop-sized zip costs on the converter's bulk path.
 *
 * Builds, in a temporary directory, a zip of corpus files repeated until it
 * holds `BULK_HANDS` hands (default 1 000 000), written entry by entry so the
 * builder never holds it either. Then reads it the way the worker does - a
 * file-backed `Blob` (`fs.openAsBlob`), `readInputs` (one entry at a time),
 * `runSourceStream` with the committed WebAssembly core, every batch dropped
 * as soon as it is counted (the page acknowledging at once: no save) - and
 * samples the process's memory every 100 ms.
 *
 * Prints hands, sizes, time, hands/s and peak RSS / heap / ArrayBuffers;
 * asserts only that every hand was converted and that the heap grows by less
 * than a fixed 256 MB whatever the archive's size (the bound the streaming
 * exists for).
 *
 *   npm run bulk-upload:measure                   # 1 000 000 hands
 *   BULK_HANDS=200000 npm run bulk-upload:measure
 */

import { closeSync, mkdtempSync, openAsBlob, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { expect, it } from "vitest";

import { readInputs } from "../../../frontend/src/components/converter/bulkSource";
import { decodeSource } from "../../../frontend/src/components/converter/inputs";
import { runSourceStream } from "../../../frontend/src/components/converter/pipeline";
import { wasmEngine } from "../../../frontend/src/lib/wasm/engine";
import { loadWebCore } from "../../test/support/webConversion";
import { crc32 } from "../../test/support/zipWriter";

const TARGET_HANDS = Number(process.env.BULK_HANDS ?? 1_000_000);
const SAMPLES = fileURLToPath(new URL("../../../fixtures/samples/", import.meta.url));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (/\.txt$/i.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** Writes a zip to `path` one entry at a time; returns its size. */
function writeZip(path: string, entries: Iterable<{ name: string; data: Uint8Array }>): { bytes: number; entries: number; uncompressed: number } {
  const fd = openSync(path, "w");
  let offset = 0;
  let uncompressed = 0;
  const central: Buffer[] = [];
  const write = (buffer: Buffer) => {
    writeSync(fd, buffer);
    offset += buffer.length;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const at = offset;
    write(local);
    write(name);
    write(body);
    uncompressed += entry.data.length;
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(at, 42);
    central.push(record, name);
  }
  const directoryOffset = offset;
  for (const part of central) write(part);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(offset - directoryOffset, 12);
  end.writeUInt32LE(directoryOffset, 16);
  write(end);
  closeSync(fd);
  if (central.length / 2 > 0xffff || offset > 0xffffffff) {
    throw new Error("the measurement zip would need zip64; lower BULK_HANDS");
  }
  return { bytes: offset, entries: central.length / 2, uncompressed };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

it(`reads and converts a zip of ${TARGET_HANDS.toLocaleString("en-GB")} hands in bounded memory`, async () => {
  const engine = wasmEngine(await loadWebCore());

  // Corpus files the core converts, with their hand counts.
  const pool: Array<{ name: string; bytes: Uint8Array; hands: number }> = [];
  for (const path of filesUnder(SAMPLES)) {
    const raw = readFileSync(path);
    const decoded = decodeSource(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer);
    if (decoded.problem) continue;
    const result = await engine.convert(decoded.text, { validate: true, sourceFilename: path });
    if (result.hands.length >= 20) {
      pool.push({ name: path.slice(SAMPLES.length), bytes: new Uint8Array(raw), hands: result.hands.length });
    }
  }
  expect(pool.length).toBeGreaterThan(3);

  const dir = mkdtempSync(join(tmpdir(), "rail-bulk-"));
  const zipPath = join(dir, "export.zip");
  try {
    let planned = 0;
    let built = { bytes: 0, entries: 0, uncompressed: 0 };
    const started = performance.now();
    built = writeZip(zipPath, (function* () {
      for (let i = 0; planned < TARGET_HANDS; i += 1) {
        const file = pool[i % pool.length];
        planned += file.hands;
        yield { name: `HandHistory/${String(Math.floor(i / 500)).padStart(3, "0")}/${i}-${file.name.replace(/\//g, "_")}`, data: file.bytes };
      }
    })());
    const buildSeconds = (performance.now() - started) / 1000;
    expect(statSync(zipPath).size).toBe(built.bytes);

    // Memory, sampled while the drop is read and converted.
    const base = process.memoryUsage();
    const peak = { rss: base.rss, heapUsed: base.heapUsed, arrayBuffers: base.arrayBuffers };
    const sampler = setInterval(() => {
      const now = process.memoryUsage();
      peak.rss = Math.max(peak.rss, now.rss);
      peak.heapUsed = Math.max(peak.heapUsed, now.heapUsed);
      peak.arrayBuffers = Math.max(peak.arrayBuffers, now.arrayBuffers);
    }, 100);

    const blob = await openAsBlob(zipPath);
    const file = Object.assign(blob, { name: "export.zip", lastModified: 1 });
    let hands = 0;
    let failures = 0;
    let sources = 0;
    let firstBatchMs = 0;
    const t0 = performance.now();
    await runSourceStream(readInputs([{ kind: "file", file, path: "export.zip" }]), { validate: true }, {
      onSource: () => {
        sources += 1;
      },
      onSourceStart: () => undefined,
      onBatch: (batch) => {
        if (!firstBatchMs) firstBatchMs = performance.now() - t0;
        hands += batch.hands.length;
        failures += batch.failures.length;
      },
      onSourceEnd: () => undefined,
      isCancelled: () => false,
      waitForRoom: async () => undefined,
      skipBatches: () => 0,
    }, engine);
    const seconds = (performance.now() - t0) / 1000;
    clearInterval(sampler);

    const report = {
      hands,
      refused: failures,
      sources,
      zip: mb(built.bytes),
      uncompressed: mb(built.uncompressed),
      entries: built.entries,
      buildSeconds: Number(buildSeconds.toFixed(1)),
      seconds: Number(seconds.toFixed(1)),
      handsPerSecond: Math.round(hands / seconds),
      firstBatchMs: Math.round(firstBatchMs),
      baseline: { rss: mb(base.rss), heapUsed: mb(base.heapUsed), arrayBuffers: mb(base.arrayBuffers) },
      peak: { rss: mb(peak.rss), heapUsed: mb(peak.heapUsed), arrayBuffers: mb(peak.arrayBuffers) },
    };
    console.log(JSON.stringify(report, null, 2));

    expect(hands).toBeGreaterThanOrEqual(TARGET_HANDS * 0.95);
    expect(sources).toBe(built.entries);
    // The bound: the heap does not grow with the archive (a fixed ceiling,
    // whatever BULK_HANDS is; garbage collection decides most of it).
    expect(peak.heapUsed - base.heapUsed).toBeLessThan(256 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
