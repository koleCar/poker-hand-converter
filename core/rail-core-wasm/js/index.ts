/**
 * The typed face of `rail-core-wasm` (docs/RAIL-PLAN.md R0.13).
 *
 * The WebAssembly exports take bytes and JSON text and return JSON text
 * (`src/api.rs` says why); this module parses and types them. It does not
 * load the module itself, because how that is done depends on the
 * `wasm-bindgen` target: `--target nodejs` (the test harness) is a CommonJS
 * file that loads its `.wasm` synchronously, `--target web` (the web app's
 * worker, R4.1) is an ES module whose default export must be awaited first.
 * Either way the caller passes the loaded module to {@link railCore}.
 *
 * PHF types are the declarations generated from the Rust model
 * (`../types/phf.d.ts`).
 */

import type { PhfHand } from "../types/phf";

/** The raw exports, as `wasm-bindgen` declares them (`pkg/<target>/rail_core_wasm.d.ts`). */
export interface RailCoreWasm {
  convert(bytes: Uint8Array, filename: string, options: string): string;
  detect(bytes: Uint8Array): string;
  serialize(phf: string): string;
  anonymise(bytes: Uint8Array): string;
  formats(): string;
}

export interface ConvertOptions {
  /** ISO timestamp stamped on every hand's `meta.parsedAt`. Required: the core has no clock. */
  parsedAt: string;
  /** Force a parser instead of detecting one. */
  siteId?: string | null;
  cashOnly?: boolean;
  skipBombPots?: boolean;
  /** Run the validator (default `true`, as the converter does). */
  validate?: boolean;
  /** Write `standardText` per hand and `standardTextFile` (default `true`). */
  standardText?: boolean;
  /** Add `phfSha256`, the sha-256 of each hand's canonical JSON as Rust writes it (default `false`). */
  digests?: boolean;
}

export interface Decode {
  /** `decodeSource`'s label: `UTF-8`, `UTF-16 LE`, `Windows-1252`, ... */
  encoding: string;
  /** `empty`, `no-text` or `binary`; then nothing else ran. */
  problem: "empty" | "no-text" | "binary" | null;
}

export interface Detected {
  top: string | null;
  /** Best first, scores in per-mille. */
  candidates: { parser: string; permille: number }[];
}

export interface Warning {
  code: string;
  context?: Record<string, string | number>;
  message: string;
}

export interface ConvertedHand {
  /** The chunk of the primary parser's split this hand came from. */
  index: number;
  handId: string;
  parser: string;
  phf: PhfHand;
  phfSha256: string | null;
  standardText: string | null;
  warnings: Warning[];
}

export interface Refusal {
  /** The chunk, or `null` for a file-level refusal. */
  index: number | null;
  stage: string;
  reason: string;
  message: string;
  site: string | null;
  permille: number | null;
  parserVersion: string;
  fingerprint: string;
  rawText: string;
  sourceFilename: string | null;
}

/** The unsupported-format registry's record of a file no parser claims (R0.11). */
export interface Unrecognized {
  fingerprint: string;
  headerSample: string;
  guessedSite: string | null;
  confidence: number;
  guessBasis: "below-threshold" | "known-format" | null;
  shape: "xml" | "json" | "text";
}

/** `convert`'s document, format `rail-convert/1`. */
export interface ConvertResult {
  format: "rail-convert/1";
  decode: Decode;
  /** `null` when the bytes are not text. */
  detected: Detected | null;
  chunks: number;
  hands: ConvertedHand[];
  refusals: Refusal[];
  stats: { total: number; converted: number; failed: number; bySite: Record<string, number> } | null;
  standardTextFile: string | null;
  unrecognized: Unrecognized | null;
  /** What `convertAny` would have thrown; then no hands, refusals or stats. */
  thrown: string | null;
}

export interface Detection {
  decode: Decode;
  detected: Detected | null;
}

export interface Sample {
  decode: Decode;
  /** Player names replaced, amounts and layout kept, at most 64 KiB. */
  text: string;
  truncated: boolean;
  names: number;
}

export interface RailCore {
  convert(bytes: Uint8Array, filename: string, options: ConvertOptions): ConvertResult;
  detect(bytes: Uint8Array): Detection;
  /** The standard text of one hand, or of a file's hands. */
  serialize(phf: PhfHand | PhfHand[]): string;
  anonymise(bytes: Uint8Array): Sample;
  formats(): { convert: string; phf: string };
}

/** Types the raw exports of a loaded `rail-core-wasm` module. */
export function railCore(raw: RailCoreWasm): RailCore {
  return {
    convert: (bytes, filename, options) =>
      JSON.parse(raw.convert(bytes, filename, JSON.stringify(options))) as ConvertResult,
    detect: (bytes) => JSON.parse(raw.detect(bytes)) as Detection,
    serialize: (phf) => raw.serialize(JSON.stringify(phf)),
    anonymise: (bytes) => JSON.parse(raw.anonymise(bytes)) as Sample,
    formats: () => JSON.parse(raw.formats()) as { convert: string; phf: string },
  };
}
