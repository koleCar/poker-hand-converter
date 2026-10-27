/**
 * Bulk upload, the reading side (docs/RAIL-PLAN.md R4.2): the streaming zip
 * reader (`web/src/components/converter/zipStream.ts`), the lazy reader
 * of a drop (`bulkSource.ts`) and the pipeline over it.
 *
 * Archives are built here at test time (`support/zipWriter.ts`); the hand
 * text inside is real corpus text.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  readInputs,
  shortHash,
  storagePathFor,
  type BulkSource,
  type InputItem,
} from "../../web/src/components/converter/bulkSource";
import { readZip, skipReason } from "../../web/src/components/converter/inputs";
import { runSourceStream, type StreamBatch } from "../../web/src/components/converter/pipeline";
import { readZipDirectory, readZipEntry, ZipEntryError } from "../../web/src/components/converter/zipStream";
import { typescriptEngine } from "../../web/src/lib/wasm/engine";
import { buildZip, crc32, file, trackedFile } from "./support/zipWriter";

const sample = (path: string) => readFileSync(new URL(`../../fixtures/samples/${path}`, import.meta.url), "utf8");
const STARS = sample("pokerstars/28-cash-multi-hand-file-no-blank-separator.txt");
const WEPLAY = sample("weplay/01-cash-nlhe-8max-0.25-0.50.txt");

async function collect(items: InputItem[], options: Parameters<typeof readInputs>[1] = {}): Promise<BulkSource[]> {
  const out: BulkSource[] = [];
  for await (const source of readInputs(items, options)) {
    out.push(source);
  }
  return out;
}

const zipItem = (bytes: Uint8Array, name = "export.zip", reads: Array<[number, number]> = []): InputItem => ({
  kind: "file",
  file: trackedFile(bytes, name, reads),
  path: name,
});

describe("the streaming zip reader", () => {
  it("reads stored and deflated entries in nested folders", async () => {
    const zip = buildZip([
      { name: "HandHistory/", data: "" },
      { name: "HandHistory/Hero/", data: "" },
      { name: "HandHistory/Hero/stars.txt", data: STARS, method: 8 },
      { name: "HandHistory/Hero/2026/weplay.txt", data: WEPLAY, method: 0 },
    ]);
    const blob = new Blob([zip as BlobPart]);
    const directory = await readZipDirectory(blob);
    if ("problem" in directory) throw new Error(directory.problem);
    expect(directory.entries.map((e) => [e.name, e.directory, e.method])).toEqual([
      ["HandHistory/", true, 0],
      ["HandHistory/Hero/", true, 0],
      ["HandHistory/Hero/stars.txt", false, 8],
      ["HandHistory/Hero/2026/weplay.txt", false, 0],
    ]);
    const stars = await readZipEntry(blob, directory.entries[2], 1 << 24);
    const weplay = await readZipEntry(blob, directory.entries[3], 1 << 24);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(stars)).toBe(STARS);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(weplay)).toBe(WEPLAY);
    expect(directory.entries[2].crc32).toBe(crc32(new TextEncoder().encode(STARS)));
  });

  it("reads zip64 archives", async () => {
    const zip = buildZip([{ name: "a.txt", data: STARS }, { name: "b/c.txt", data: WEPLAY, method: 0 }], { zip64: true });
    const blob = new Blob([zip as BlobPart]);
    const directory = await readZipDirectory(blob);
    if ("problem" in directory) throw new Error(directory.problem);
    expect(directory.entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ["a.txt", new TextEncoder().encode(STARS).length],
      ["b/c.txt", new TextEncoder().encode(WEPLAY).length],
    ]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(await readZipEntry(blob, directory.entries[1], 1 << 24))).toBe(WEPLAY);
  });

  it("refuses what it cannot read, entry by entry", async () => {
    const zip = buildZip([
      { name: "locked.txt", data: STARS, encrypted: true, method: 0 },
      { name: "bzip2.txt", data: STARS, method: 12 },
      { name: "fine.txt", data: STARS },
    ]);
    const blob = new Blob([zip as BlobPart]);
    const directory = await readZipDirectory(blob);
    if ("problem" in directory) throw new Error(directory.problem);
    await expect(readZipEntry(blob, directory.entries[0], 1 << 24)).rejects.toMatchObject({ kind: "encrypted-entry" });
    await expect(readZipEntry(blob, directory.entries[1], 1 << 24)).rejects.toMatchObject({ kind: "unsupported-method" });
    await expect(readZipEntry(blob, directory.entries[2], 100)).rejects.toMatchObject({ kind: "too-large" });
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(await readZipEntry(blob, directory.entries[2], 1 << 24))).toBe(STARS);
  });

  it("stops an entry that inflates past its declared size (a zip bomb, a lying directory)", async () => {
    const zip = buildZip([{ name: "bomb.txt", data: "A".repeat(100_000) }]);
    const blob = new Blob([zip as BlobPart]);
    const directory = await readZipDirectory(blob);
    if ("problem" in directory) throw new Error(directory.problem);
    const lying = { ...directory.entries[0], uncompressedSize: 1000 };
    await expect(readZipEntry(blob, lying, 1 << 24)).rejects.toBeInstanceOf(ZipEntryError);
  });

  it("says when a file is not a zip at all", async () => {
    expect(await readZipDirectory(new Blob([STARS]))).toEqual({ problem: "not-zip" });
    expect(await readZipDirectory(new Blob([new Uint8Array(10)]))).toEqual({ problem: "not-zip" });
    // Cut off before its directory: the end record is gone.
    const zip = buildZip([{ name: "a.txt", data: STARS }]);
    expect(await readZipDirectory(new Blob([zip.subarray(0, zip.length - 30) as BlobPart]))).toEqual({ problem: "not-zip" });
  });

  it("the converter's all-at-once reader uses it and skips what is not a hand history", async () => {
    const zip = buildZip([
      { name: "__MACOSX/._a.txt", data: "junk" },
      { name: ".DS_Store", data: "junk" },
      { name: "shots/table.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      { name: "hands/a.txt", data: STARS },
    ]);
    const sources = await readZip(file("export.zip", zip));
    expect(sources.map((s) => [s.name, s.problem ?? null])).toEqual([["export.zip → hands/a.txt", null]]);
    expect(sources[0].text).toBe(STARS.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  });
});

describe("skipReason", () => {
  it("leaves out hidden files, OS debris and obvious non-hand-histories", () => {
    expect(skipReason("HandHistory/Hero/HH20261001.txt")).toBeNull();
    expect(skipReason("export/hands.xml")).toBeNull();
    expect(skipReason("noextension")).toBeNull();
    expect(skipReason("a/.DS_Store")).toBe("hidden");
    expect(skipReason(".git/config")).toBe("hidden");
    expect(skipReason("__MACOSX/a.txt")).toBe("hidden");
    expect(skipReason("a/b/")).toBe("hidden");
    expect(skipReason("shots/Table 1.PNG")).toBe("not-hand-history");
    expect(skipReason("client/PokerStars.exe")).toBe("not-hand-history");
  });
});

describe("reading a drop lazily", () => {
  it("yields files, archive entries and pasted text in order, with stable keys", async () => {
    const zip = buildZip([
      { name: "deep/er/stars.txt", data: STARS },
      { name: "notes.pdf", data: "%PDF" },
      { name: "weplay.txt", data: WEPLAY },
    ]);
    const items: InputItem[] = [
      { kind: "file", file: file("one.txt", STARS), path: "Export/one.txt" },
      zipItem(zip),
      { kind: "text", name: "Pasted text", text: WEPLAY },
    ];
    const skipped: number[] = [];
    const sources = await collect(items, { onConsumed: (_bytes, s) => skipped.push(s.other) });
    expect(sources.map((s) => s.name)).toEqual([
      "one.txt",
      "export.zip → deep/er/stars.txt",
      "export.zip → weplay.txt",
      "Pasted text",
    ]);
    expect(sources.every((s) => !s.problem && s.text.length > 0)).toBe(true);
    expect(skipped.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sources[0].key).toBe("f|Export/one.txt|" + new TextEncoder().encode(STARS).length + "|1700000000000");
    expect(sources[1].key).toMatch(/^f\|export\.zip\|\d+\|1700000000000\|deep\/er\/stars\.txt\|\d+\|\d+$/);
    const again = await collect(items);
    expect(again.map((s) => s.key)).toEqual(sources.map((s) => s.key));
  });

  it("counts every byte of the drop exactly once", async () => {
    const zip = buildZip([
      { name: "a.txt", data: STARS },
      { name: "skip.png", data: "x".repeat(5000) },
      { name: "inner.zip", data: buildZip([{ name: "b.txt", data: WEPLAY }]), method: 0 },
    ]);
    const plain = file("plain.txt", STARS);
    let bytes = 0;
    const sources = await collect([zipItem(zip), { kind: "file", file: plain, path: "plain.txt" }], {
      onConsumed: (n) => {
        bytes += n;
      },
    });
    expect(sources.map((s) => s.name)).toEqual(["export.zip → a.txt", "export.zip → inner.zip → b.txt", "plain.txt"]);
    expect(bytes).toBe(zip.length + plain.size);
  });

  it("reads one archive entry at a time: nothing past an entry is read before it is yielded", async () => {
    // 40 entries of hand history plus ~60 KB that does not compress, so the
    // archive is ~2 MB and its entries are far apart.
    const entries = Array.from({ length: 40 }, (_, i) => ({
      name: `hands/day-${String(i).padStart(2, "0")}.txt`,
      data: `${STARS}\n${randomBytes(45_000).toString("base64")}`,
    }));
    const zip = buildZip(entries);
    const reads: Array<[number, number]> = [];
    const directory = await readZipDirectory(new Blob([zip as BlobPart]));
    if ("problem" in directory) throw new Error(directory.problem);
    const last = directory.entries.at(-1)!;
    const directoryOffset = last.localOffset + 30 + new TextEncoder().encode(last.name).length + last.compressedSize;
    const entryEnds = directory.entries.map((_, i) =>
      i + 1 < directory.entries.length ? directory.entries[i + 1].localOffset : directoryOffset,
    );

    let yielded = 0;
    let largestRead = 0;
    for await (const source of readInputs([zipItem(zip, "export.zip", reads)])) {
      expect(source.problem).toBeUndefined();
      // Every read so far lies in an entry already yielded (or this one), in
      // the archive's directory, or is the one look at its last 64 KiB for
      // the end record.
      for (const [start, end] of reads) {
        largestRead = Math.max(largestRead, end - start);
        const endRecordScan = end === zip.length && end - start <= 65_557;
        expect(endRecordScan || start >= directoryOffset || end <= entryEnds[yielded]).toBe(true);
      }
      yielded += 1;
    }
    expect(yielded).toBe(40);
    // No single read is bigger than one entry, or the tail (at most 64 KiB
    // plus the end record, or the directory).
    const biggestEntry = Math.max(...directory.entries.map((e) => e.compressedSize));
    expect(largestRead).toBeLessThanOrEqual(Math.max(biggestEntry, zip.length - directoryOffset, 65_557));
    expect(largestRead).toBeLessThan(zip.length / 10);
  });

  it("skips files and entries an earlier attempt stored, without reading them", async () => {
    const zip = buildZip([{ name: "a.txt", data: STARS }, { name: "b.txt", data: WEPLAY }]);
    const first = await collect([zipItem(zip), { kind: "file", file: file("c.txt", STARS), path: "c.txt" }]);
    const done = new Set([first[0].key, first[2].key]);
    const reads: Array<[number, number]> = [];
    const skippedDone: number[] = [];
    const second = await collect([zipItem(zip, "export.zip", reads), { kind: "file", file: file("c.txt", STARS), path: "c.txt" }], {
      isDone: (key) => done.has(key),
      onConsumed: (_n, s) => skippedDone.push(s.done),
    });
    expect(second.map((s) => s.name)).toEqual(["export.zip → b.txt"]);
    expect(skippedDone.reduce((a, b) => a + b, 0)).toBe(2);
    // a.txt's data was never read.
    const directory = await readZipDirectory(new Blob([zip as BlobPart]));
    if ("problem" in directory) throw new Error(directory.problem);
    const a = directory.entries[0];
    const aData: [number, number] = [a.localOffset + 30 + a.name.length, a.localOffset + 30 + a.name.length + a.compressedSize];
    // (The archive is small, so the one end-record scan of its last 64 KiB
    // covers it whole; that read is not an entry being read.)
    const entryReads = reads.filter(([start, end]) => !(end === zip.length && start === Math.max(0, zip.length - 65_557)));
    expect(entryReads.some(([start, end]) => start < aData[1] && end > aData[0] && end - start > 30)).toBe(false);
    expect(entryReads.some(([start, end]) => start >= aData[1] || end <= aData[0])).toBe(true);
  });

  it("lists a file it cannot read, with the reason", async () => {
    const sources = await collect(
      [
        { kind: "file", file: file("broken.zip", "not a zip"), path: "broken.zip" },
        zipItem(buildZip([{ name: "locked.txt", data: STARS, encrypted: true, method: 0 }])),
        zipItem(buildZip([{ name: "only.png", data: "x" }]), "pictures.zip"),
        { kind: "file", file: file("big.txt", "x".repeat(2000)), path: "big.txt" },
      ],
      { maxSourceBytes: 1000 },
    );
    expect(sources.map((s) => [s.name, s.problem?.kind])).toEqual([
      ["broken.zip", "not-zip"],
      ["export.zip → locked.txt", "encrypted-entry"],
      ["pictures.zip", "empty-archive"],
      ["big.txt", "too-large"],
    ]);
  });

  it("gzips the originals only when asked, under a safe and stable Storage path", async () => {
    const zip = buildZip([{ name: "Hero ♠/HH 2026-10-01 (1).txt", data: STARS }]);
    const off = await collect([zipItem(zip)]);
    expect(off[0].original).toBeUndefined();
    const on = await collect([zipItem(zip)], { keepOriginals: true });
    const original = on[0].original!;
    expect(original.path).toBe(`export.zip/Hero _/HH 2026-10-01 (1).txt.${shortHash(on[0].key)}.gz`);
    expect(original.blob.type).toBe("application/gzip");
    const unzipped = gunzipSync(new Uint8Array(await original.blob.arrayBuffer())).toString("utf8");
    expect(unzipped).toBe(STARS);
  });

  it("makes Storage paths of anything", () => {
    expect(storagePathFor("../../etc/passwd", "k")).toBe(`_/_/etc/passwd.${shortHash("k")}.gz`);
    expect(storagePathFor("a.zip → b/c.txt", "k")).toBe(`a.zip/b/c.txt.${shortHash("k")}.gz`);
    expect(storagePathFor("", "k")).toBe(`file.${shortHash("k")}.gz`);
    expect(storagePathFor("a/".repeat(20) + "x.txt", "k").split("/")).toHaveLength(7);
  });
});

describe("the pipeline over a lazy drop", () => {
  const engine = typescriptEngine();

  async function run(items: InputItem[], skip: Map<string, number> = new Map()) {
    const batches: StreamBatch[] = [];
    const ended: string[] = [];
    await runSourceStream(readInputs(items), { validate: true }, {
      onSource: () => undefined,
      onSourceStart: () => undefined,
      onBatch: (batch) => batches.push(batch),
      onSourceEnd: (_id, key) => ended.push(key),
      isCancelled: () => false,
      waitForRoom: async () => undefined,
      skipBatches: (key) => skip.get(key) ?? 0,
    }, engine);
    return { batches, ended };
  }

  it("converts each source in batches of 100, with their index", async () => {
    const big = Array.from({ length: 3 }, () => WEPLAY).join("\n\n");
    const { batches, ended } = await run([zipItem(buildZip([{ name: "w.txt", data: big }]))]);
    expect(batches.map((b) => b.index)).toEqual(batches.map((_, i) => i));
    expect(batches.at(-1)!.last).toBe(true);
    expect(batches.slice(0, -1).every((b) => !b.last)).toBe(true);
    expect(ended).toHaveLength(1);
  });

  it("skips the batches an earlier attempt stored, and converts the rest identically", async () => {
    const big = Array.from({ length: 3 }, () => WEPLAY).join("\n\n");
    const item = zipItem(buildZip([{ name: "w.txt", data: big }]));
    const full = await run([item]);
    expect(full.batches.length).toBeGreaterThan(1);
    const key = full.batches[0].key;
    const resumed = await run([item], new Map([[key, 1]]));
    expect(resumed.batches.map((b) => b.index)).toEqual(full.batches.slice(1).map((b) => b.index));
    expect(resumed.batches.map((b) => b.hands.map((h) => h.meta.handKey))).toEqual(
      full.batches.slice(1).map((b) => b.hands.map((h) => h.meta.handKey)),
    );
  });
});
