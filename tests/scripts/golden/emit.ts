/**
 * The golden oracle (docs/RAIL-PLAN.md R0.3).
 *
 * Runs today's TypeScript pipeline - the one the converter tab runs - over
 * every hand-history file in the corpus and records what it concluded, one
 * golden per input, in the canonical JSON of `canonical.ts`. The Rust core
 * (R0.4 onwards) is done when it reproduces them byte for byte. The format is
 * documented in `testdata/golden/README.md`; change the two together.
 *
 * Two trees come out of one run:
 *
 * - `testdata/golden/<input>.json` - committed. Everything about the file
 *   (decode, detection, refusals, warnings, text hashes) with each hand's PHF
 *   reduced to the sha-256 of its canonical JSON.
 * - `testdata/golden-full/<input>.json` - gitignored, regenerated in ~10 s.
 *   The same document with every PHF written out in full. ~136 MB, which is
 *   why it is not committed (README, "Size").
 *
 * The pipeline, step for step what `ConverterTab` does with a dropped file:
 *
 *   bytes ─ decodeSource ─ convertAny(text, { sourceFilename, validate: true })
 *
 * `convertAny` is detect → split → per-chunk detect → parse → refusal backstops
 * → assignPositions → validateHand. Nothing is reimplemented here; this file
 * only re-asks pure questions of the result (`detectSite`, the primary
 * parser's `splitHands` for chunk indexes, `validateHand` for the warnings an
 * accepted hand carried, `toStandardText` for the tracker text).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { decodeSource } from "../../../frontend/src/components/converter/inputs.js";
import {
  convertAny,
  detectSite,
  type ConversionFailure,
} from "../../../frontend/src/lib/parsers/index.js";
import type { ConversionResult } from "../../../frontend/src/lib/phf/detect.js";
import { toStandardText, toStandardTextFile } from "../../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../../frontend/src/lib/phf/validate.js";
import { canonicalJson, compareUtf8 } from "./canonical.js";

export const ROOT = join(import.meta.dirname, "../../..");
/** Committed: PHF bodies as hashes. */
export const GOLDEN_DIR = join(ROOT, "testdata/golden");
/** Gitignored: PHF bodies in full. */
export const GOLDEN_FULL_DIR = join(ROOT, "testdata/golden-full");

/** Bumped whenever the shape of a golden file changes. */
export const GOLDEN_FORMAT = "rail-golden/1";

/**
 * `meta.parsedAt` is the wall clock at parse time - the only field of a hand
 * that is not a function of the input bytes. The golden pins it to this value;
 * the Rust side does the same before comparing (or takes "now" as an input).
 */
export const PINNED_PARSED_AT = "1970-01-01T00:00:00.000Z";

/**
 * The corpus trees, as `docs/WEB.md` "The corpus" lists them.
 *
 * Within them an input is a `.txt` or `.xml` file, which is exactly what the
 * test loaders treat as a hand history (`tests/test/support/*Corpus.ts`).
 * Everything else is documentation or out of scope and has no golden:
 * `SOURCES.md` in every sample directory, the four `.phh` files of the PHH
 * interchange spec in `fixtures/samples/phh/` (no parser reads PHH), and one
 * cashier `.html` page harvested next to the ACR samples.
 */
export const CORPUS_TREES = ["fixtures/samples", "gg-hh", "weplay-hh", "tests/test/fixtures"];
const INPUT_PATTERN = /\.(?:txt|xml)$/i;

/** Every input file, as a repository-relative path with `/`, in byte order. */
export function listInputs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (INPUT_PATTERN.test(name)) {
        out.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  for (const tree of CORPUS_TREES) {
    walk(join(ROOT, tree));
  }
  return out.sort(compareUtf8);
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Detection scores are floats in 0..1. They are stored as integer per-mille,
 * `Math.round(score * 1000)`, which Rust reproduces exactly with
 * `(score * 1000.0).round() as i64` for any non-negative score computed with
 * the same IEEE-754 operations.
 */
function permille(score: number | null): number | null {
  return score === null ? null : Math.round(score * 1000);
}

/** The hand as stored, with the one non-deterministic field pinned. */
function storedPhf(hand: PhfHand): PhfHand {
  return { ...hand, meta: { ...hand.meta, parsedAt: PINNED_PARSED_AT } };
}

export interface GoldenFile {
  /** The committed document: PHF bodies replaced by their canonical sha-256. */
  summary: Record<string, unknown>;
  /** The gitignored document: PHF bodies in full. */
  full: Record<string, unknown>;
  hands: number;
  refusals: number;
  /**
   * `convertAny`'s own result, `null` when the source could not be decoded.
   * Not written anywhere; the WASM shadow mode (`tests/scripts/wasm/`)
   * compares what the documents leave out, such as a refusal's `rawText`.
   */
  result: ConversionResult | null;
}

/** Canonical text with the input path on any error, so a float is easy to find. */
function canonical(path: string, value: unknown): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The golden documents for one input file. */
export async function goldenFor(path: string): Promise<GoldenFile> {
  const bytes = new Uint8Array(readFileSync(join(ROOT, path)));
  const name = path.split("/").pop()!;
  const input = { path, sha256: sha256(bytes), bytes: bytes.length };

  const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const decode = { encoding: decoded.encoding, problem: decoded.problem?.kind ?? null };

  if (decoded.problem) {
    // The converter never calls `convertAny` for a source it could not decode:
    // the file is listed with its problem and that is the whole outcome.
    const doc = {
      format: GOLDEN_FORMAT,
      input,
      decode,
      detected: null,
      chunks: 0,
      hands: [],
      refusals: [],
      standardTextFile: null,
      stats: null,
    };
    return { summary: doc, full: doc, hands: 0, refusals: 0, result: null };
  }

  const text = decoded.text;
  const ranked = detectSite(text);
  const detected = {
    top: ranked[0]?.parser.id ?? null,
    // Best first; ties keep registration order (`lib/parsers/index.ts`),
    // because `detectSite` sorts stably.
    candidates: ranked.map((c) => ({ parser: c.parser.id, permille: permille(c.confidence) })),
  };

  const result = await convertAny(text, { sourceFilename: name, validate: true });

  // Chunk indexes. `convertAny` returns hands and failures in two lists; every
  // chunk ends as exactly one of them, in chunk order, and a refused chunk's
  // failure carries the chunk itself as `rawText`. So walking the primary
  // parser's split (the same call `convertAny` made) recovers the index of
  // every outcome. A file-level refusal (nothing detected, split threw, no
  // hands) has no chunk and gets index null.
  let chunks: string[] = [];
  if (ranked.length > 0) {
    try {
      chunks = ranked[0].parser.splitHands(text);
    } catch {
      chunks = [];
    }
  }
  const handIndex: number[] = [];
  const failureIndex: (number | null)[] = [];
  if (chunks.length === 0) {
    if (result.hands.length !== 0) {
      throw new Error(`${path}: hands without chunks`);
    }
    failureIndex.push(...result.failures.map(() => null));
  } else {
    let f = 0;
    chunks.forEach((chunk, i) => {
      if (f < result.failures.length && result.failures[f].rawText === chunk) {
        failureIndex.push(i);
        f += 1;
      } else {
        handIndex.push(i);
      }
    });
    if (f !== result.failures.length || handIndex.length !== result.hands.length) {
      throw new Error(
        `${path}: could not line ${chunks.length} chunks up with ` +
          `${result.hands.length} hands and ${result.failures.length} failures`,
      );
    }
  }

  const fullHands: Record<string, unknown>[] = [];
  const summaryHands: Record<string, unknown>[] = [];
  result.hands.forEach((hand, i) => {
    const phf = storedPhf(hand);
    const common = {
      index: handIndex[i],
      handId: hand.meta.handId,
      parser: hand.meta.parserId,
      standardText: sha256(toStandardText(hand)),
      // `convertAny` keeps a hand whose report has only warnings and drops the
      // report; validateHand is pure, so asking again gives the same answer.
      // Parser warnings (`meta.warnings`) are included, as validateHand
      // re-reports them.
      warnings: validateHand(hand).warnings.map((w) => ({
        code: w.code,
        context: w.context,
        message: w.message,
      })),
    };
    fullHands.push({ ...common, phf });
    summaryHands.push({ ...common, phf: sha256(canonical(path, phf)) });
  });

  const refusals = result.failures.map((failure: ConversionFailure, i) => ({
    index: failureIndex[i],
    stage: failure.stage,
    reason: failure.reason,
    message: failure.message,
    site: failure.detectedSite,
    permille: permille(failure.detectionConfidence),
    parserVersion: failure.parserVersion,
    fingerprint: failure.fingerprint,
  }));

  const rest = {
    format: GOLDEN_FORMAT,
    input,
    decode,
    detected,
    chunks: chunks.length,
    refusals,
    // What "Download" on the converter writes for this file.
    standardTextFile: result.hands.length ? sha256(toStandardTextFile(result.hands)) : null,
    stats: result.stats,
  };
  return {
    summary: { ...rest, hands: summaryHands },
    full: { ...rest, hands: fullHands },
    hands: result.hands.length,
    refusals: refusals.length,
    result,
  };
}

/** Every `*.json` under `dir`, for pruning goldens whose input is gone. */
function existingJson(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return existingJson(full);
    }
    return name.endsWith(".json") ? [full] : [];
  });
}

export interface EmitReport {
  files: number;
  hands: number;
  refusals: number;
  summaryBytes: number;
  fullBytes: number;
  removed: number;
}

/** Regenerates both trees, and removes goldens whose input is gone. */
export async function emitAll(): Promise<EmitReport> {
  const inputs = listInputs();
  const report: EmitReport = { files: 0, hands: 0, refusals: 0, summaryBytes: 0, fullBytes: 0, removed: 0 };

  for (const dir of [GOLDEN_DIR, GOLDEN_FULL_DIR]) {
    const wanted = new Set(inputs.map((input) => join(dir, `${input}.json`)));
    for (const stale of existingJson(dir)) {
      if (!wanted.has(stale)) {
        rmSync(stale);
        report.removed += 1;
      }
    }
  }

  for (const input of inputs) {
    const golden = await goldenFor(input);
    const summary = canonical(input, golden.summary);
    const full = canonical(input, golden.full);
    for (const [dir, text] of [
      [GOLDEN_DIR, summary],
      [GOLDEN_FULL_DIR, full],
    ] as const) {
      const out = join(dir, `${input}.json`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
    }
    report.files += 1;
    report.hands += golden.hands;
    report.refusals += golden.refusals;
    report.summaryBytes += Buffer.byteLength(summary);
    report.fullBytes += Buffer.byteLength(full);
  }
  return report;
}
