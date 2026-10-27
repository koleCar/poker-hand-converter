/**
 * Shadow mode (docs/RAIL-PLAN.md R0.13): the WebAssembly core next to the
 * TypeScript pipeline, over every corpus file. `npm run wasm:shadow` after
 * `npm run wasm:build`; not part of `npm test`.
 *
 * For each input the TypeScript side is `goldenFor` of the golden emitter -
 * `decodeSource` and `convertAny`, exactly what the converter tab and the
 * goldens run - and the WASM side is one `convert` call. The WASM result is
 * rewritten into the emitter's `golden-full` document (every PHF written out
 * in full, `parsedAt` pinned) and the two canonical texts must be equal byte
 * for byte: decode, detection ranking with per-mille scores, chunk count,
 * every hand (index, id, parser, PHF, warnings with their context, standard
 * text hash), every refusal (index, stage, reason, message, site, per-mille,
 * parser version, fingerprint), the file's standard text hash and the stats.
 * On top of the document:
 *
 * - each hand's `phfSha256` - the sha-256 of the canonical JSON **Rust**
 *   wrote inside the WASM module - must be the golden's hash, so the
 *   canonical bytes are the native core's and the oracle's, not merely
 *   equal after a TypeScript re-canonicalisation;
 * - each refusal's `rawText` and `sourceFilename` must be TypeScript's;
 * - the R0.11 registry record is there exactly when no parser claims a
 *   decodable file, with the refusal's fingerprint;
 * - `detect` gives the same decode and ranking as `convert`;
 * - `serialize` of the **TypeScript** hands (PHF JSON from the other
 *   implementation, through the strict Rust model) gives the file's
 *   standard text.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeSource } from "../../../web/src/components/converter/inputs.js";
import { convertAny } from "../../../web/src/lib/parsers/index.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { railCore, type ConvertResult, type RailCoreWasm } from "../../../core/rail-core-wasm/js/index.js";
import { canonicalJson } from "../golden/canonical.js";
import { GOLDEN_FORMAT, PINNED_PARSED_AT, ROOT, goldenFor, listInputs, sha256 } from "../golden/emit.js";

const PKG = join(ROOT, "core/rail-core-wasm/pkg/nodejs/rail_core_wasm.js");

function load(): RailCoreWasm {
  try {
    return createRequire(import.meta.url)(PKG) as RailCoreWasm;
  } catch (error) {
    throw new Error(`no WASM build at ${PKG}: run \`npm run wasm:build\` in tests/ first (${String(error)})`);
  }
}

const core = railCore(load());

function readInput(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, path)));
}

/** The WASM result as the emitter's `golden-full` document. */
function asGoldenFull(path: string, bytes: Uint8Array, wasm: ConvertResult): Record<string, unknown> {
  const input = { path, sha256: sha256(bytes), bytes: bytes.length };
  if (wasm.decode.problem !== null) {
    return {
      format: GOLDEN_FORMAT,
      input,
      decode: wasm.decode,
      detected: null,
      chunks: 0,
      hands: [],
      refusals: [],
      standardTextFile: null,
      stats: null,
    };
  }
  if (wasm.thrown !== null) {
    return { input, thrown: wasm.thrown };
  }
  return {
    format: GOLDEN_FORMAT,
    input,
    decode: wasm.decode,
    detected: wasm.detected,
    chunks: wasm.chunks,
    hands: wasm.hands.map((hand) => ({
      index: hand.index,
      handId: hand.handId,
      parser: hand.parser,
      standardText: hand.standardText === null ? null : sha256(hand.standardText),
      warnings: hand.warnings,
      phf: hand.phf,
    })),
    refusals: wasm.refusals.map((r) => ({
      index: r.index,
      stage: r.stage,
      reason: r.reason,
      message: r.message,
      site: r.site,
      permille: r.permille,
      parserVersion: r.parserVersion,
      fingerprint: r.fingerprint,
    })),
    standardTextFile: wasm.standardTextFile === null ? null : sha256(wasm.standardTextFile),
    stats: wasm.stats,
  };
}

/** The first line where two texts part. */
function firstDifference(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    if (e[i] !== a[i]) {
      return `line ${i + 1}: TS ${JSON.stringify(e[i])}, WASM ${JSON.stringify(a[i])}`;
    }
  }
  return "equal";
}

/** Differences of one file; empty when the two pipelines agree. */
async function shadowFile(path: string): Promise<{ problems: string[]; hands: number; refusals: number }> {
  const bytes = readInput(path);
  const name = path.split("/").pop()!;
  const ts = await goldenFor(path);
  const wasm = core.convert(bytes, name, { parsedAt: PINNED_PARSED_AT, digests: true });
  const problems: string[] = [];

  const expected = canonicalJson(ts.full);
  const actual = canonicalJson(asGoldenFull(path, bytes, wasm));
  if (expected !== actual) {
    problems.push(`document: ${firstDifference(expected, actual)}`);
  }

  const summaryHands = ts.summary.hands as { phf: string }[];
  wasm.hands.forEach((hand, i) => {
    if (hand.phfSha256 !== summaryHands[i]?.phf) {
      problems.push(`hands[${i}].phfSha256: Rust canonical ${hand.phfSha256}, golden ${summaryHands[i]?.phf}`);
    }
    if (hand.phf.meta.parsedAt !== PINNED_PARSED_AT) {
      problems.push(`hands[${i}]: parsedAt ${hand.phf.meta.parsedAt} is not the caller's`);
    }
  });

  const failures = ts.result?.failures ?? [];
  if (failures.length !== wasm.refusals.length) {
    problems.push(`refusals: TS ${failures.length}, WASM ${wasm.refusals.length}`);
  }
  wasm.refusals.forEach((refusal, i) => {
    const f = failures[i];
    if (f && (f.rawText !== refusal.rawText || (f.sourceFilename ?? null) !== refusal.sourceFilename)) {
      problems.push(`refusals[${i}]: rawText or sourceFilename differs`);
    }
  });

  const unclaimed = wasm.decode.problem === null && wasm.detected?.top === null;
  if (unclaimed !== (wasm.unrecognized !== null)) {
    problems.push(`unrecognized: ${wasm.unrecognized === null ? "missing" : "unexpected"}`);
  } else if (wasm.unrecognized && wasm.unrecognized.fingerprint !== wasm.refusals[0]?.fingerprint) {
    problems.push("unrecognized.fingerprint is not the refusal's");
  }

  const detection = core.detect(bytes);
  if (canonicalJson(detection) !== canonicalJson({ decode: wasm.decode, detected: wasm.detected })) {
    problems.push("detect() differs from convert()'s decode and ranking");
  }

  const tsHands = (ts.full.hands as { phf: PhfHand }[]).map((hand) => hand.phf);
  if (tsHands.length > 0) {
    const text = core.serialize(tsHands);
    if (sha256(text) !== ts.full.standardTextFile) {
      problems.push("serialize(TS hands) is not the file's standard text");
    }
  }
  return { problems, hands: ts.hands, refusals: ts.refusals };
}

describe("WASM shadow mode", () => {
  const inputs = listInputs();
  let hands = 0;

  it("states its formats", () => {
    expect(core.formats()).toEqual({ convert: "rail-convert/1", phf: "phf/1" });
  });

  it("every corpus file: the WASM core equals the TypeScript pipeline", async () => {
    const started = performance.now();
    const failed: string[] = [];
    let refusals = 0;
    for (const path of inputs) {
      const result = await shadowFile(path);
      hands += result.hands;
      refusals += result.refusals;
      if (result.problems.length > 0) {
        failed.push(`${path}:\n    ${result.problems.slice(0, 8).join("\n    ")}`);
      }
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `shadow: ${inputs.length - failed.length} / ${inputs.length} files equal, ${hands} hands, ` +
        `${refusals} refusals, ${seconds} s`,
    );
    expect(failed.slice(0, 20), `${failed.length} files differ`).toEqual([]);
    expect(inputs.length).toBeGreaterThanOrEqual(556);
  });

  it("parsedAt is the caller's", () => {
    const path = inputs.find((p) => p.startsWith("fixtures/samples/pokerstars/"))!;
    const at = "2026-10-13T05:00:00.000Z";
    const result = core.convert(readInput(path), path.split("/").pop()!, { parsedAt: at });
    expect(result.hands.length).toBeGreaterThan(0);
    expect(new Set(result.hands.map((h) => h.phf.meta.parsedAt))).toEqual(new Set([at]));
    expect(() => core.convert(readInput(path), "x.txt", {} as never)).toThrow(/parsedAt/);
  });

  it("throughput over the corpus, WASM and TypeScript", async () => {
    const files = inputs.map((path) => ({ name: path.split("/").pop()!, bytes: readInput(path) }));
    const timeIt = async (pass: () => Promise<number>) => {
      await pass(); // warm-up: JIT, regex compilation, lazy statics
      const started = performance.now();
      const count = await pass();
      return { count, seconds: (performance.now() - started) / 1000 };
    };
    const ts = await timeIt(async () => {
      let n = 0;
      for (const { name, bytes } of files) {
        const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        if (!decoded.problem) {
          n += (await convertAny(decoded.text, { sourceFilename: name, validate: true })).hands.length;
        }
      }
      return n;
    });
    const wasmOnly = await timeIt(async () => {
      let n = 0;
      for (const { name, bytes } of files) {
        n += core.convert(bytes, name, { parsedAt: PINNED_PARSED_AT, standardText: false }).hands.length;
      }
      return n;
    });
    const wasmText = await timeIt(async () => {
      let n = 0;
      for (const { name, bytes } of files) {
        n += core.convert(bytes, name, { parsedAt: PINNED_PARSED_AT }).hands.length;
      }
      return n;
    });
    const rate = (r: { count: number; seconds: number }) =>
      `${Math.round(r.count / r.seconds)} hands/s (${r.seconds.toFixed(2)} s)`;
    console.log(
      `throughput over ${files.length} files, ${ts.count} hands: TypeScript decode + convertAny ${rate(ts)}; ` +
        `WASM convert + JSON.parse ${rate(wasmOnly)}; with standard text ${rate(wasmText)}`,
    );
    expect(wasmOnly.count).toBe(ts.count);
    expect(wasmText.count).toBe(ts.count);
  });
});
