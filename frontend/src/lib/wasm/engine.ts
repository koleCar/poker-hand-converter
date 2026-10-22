/**
 * Which code converts hand-history text on the web (docs/RAIL-PLAN.md R4.1).
 *
 * Every caller that turns text into PHF - the converter's pipeline (in the
 * worker, or on the main thread when no worker can start), the single-hand
 * box, a share of a hand that was never saved - asks {@link conversionEngine}
 * and gets one of two engines with the same face:
 *
 * - **`wasm`**, the Rust core (`rail-core-wasm`), the default. Shadow mode
 *   (R0.13) holds it equal to the TypeScript pipeline over the whole corpus,
 *   and `tests/scripts/wasm/web.test.ts` holds this module's results - hands,
 *   failures, stats, batches - equal to the TypeScript engine's.
 * - **`typescript`**, the parsers in `lib/parsers/`, loaded only when needed:
 *   when the WebAssembly module cannot be fetched or instantiated (logged
 *   once; the user still converts), and for the rare text the Rust decoder
 *   would read differently from what the caller passed (below). They are also
 *   the oracle CI checks the core against, and stay until shadow mode has been
 *   green in production for the agreed period (the plan's R4.1 notes).
 *
 * **Text in, as the converter decodes it.** The core takes bytes and decodes
 * them itself; the web has already decoded every file (`decodeSource`: BOM
 * dropped, line endings LF) to show its encoding and refuse binary, so the
 * engine hands the core that text as UTF-8, which it reads back unchanged.
 * Text that is not in that form - a CR, a leading BOM, an empty file name (the
 * core records it as none) - or that the core's decoder would refuse (empty,
 * whitespace, binary-looking) goes to the TypeScript engine, which reads it
 * exactly as it always has, so the two can never disagree about the input.
 */

import type { ConversionFailure, ConversionResult, ConvertOptions } from "../phf/detect";
import type { PhfHand } from "../phf/types";
import { instantiateRailCore, type ConvertResult, type RailCore } from "./core";

export type EngineKind = "wasm" | "typescript";

/** What the detector concluded about a whole text, and the top parser's split of it. */
export interface SplitResult {
  /** Registry id of the top parser, or `null` when nothing claims the text. */
  siteId: string | null;
  siteName: string | null;
  /** The top parser's score in 0..1. */
  confidence: number | null;
  /** The top parser's hand chunks; `null` when nothing claims the text or the split fails. */
  chunks: string[] | null;
}

export interface ConversionEngine {
  readonly kind: EngineKind;
  split(text: string): Promise<SplitResult>;
  /** `convertAny`: hands, refusals and stats. Throws what `convertAny` throws. */
  convert(text: string, options?: ConvertOptions): Promise<ConversionResult>;
}

/* -------------------------------------------------------------- typescript - */

/** The TypeScript parsers, imported on first use so the WASM path never loads them. */
export function typescriptEngine(): ConversionEngine {
  const phf = () => import("../phf");
  return {
    kind: "typescript",
    async split(text) {
      const { detectSite } = await phf();
      const best = detectSite(text)[0];
      let chunks: string[] | null = null;
      if (best) {
        try {
          chunks = best.parser.splitHands(text);
        } catch {
          // `convert` of the whole text writes the `split-failed` refusal.
          chunks = null;
        }
      }
      return {
        siteId: best?.parser.id ?? null,
        siteName: best?.parser.name ?? null,
        confidence: best?.confidence ?? null,
        chunks,
      };
    },
    async convert(text, options = {}) {
      const { convertAny } = await phf();
      return convertAny(text, options);
    },
  };
}

/* -------------------------------------------------------------------- wasm - */

const encoder = new TextEncoder();

/** Text the core reads back exactly as given (see the module comment). */
function inConverterForm(text: string): boolean {
  return !text.includes("\r") && !text.startsWith("﻿");
}

/** The core's per-mille score as the 0..1 number the TypeScript detectors return. */
function confidenceOf(permille: number | null): number | null {
  return permille === null ? null : permille / 1000;
}

function failuresOf(result: ConvertResult): ConversionFailure[] {
  return result.refusals.map((refusal) => ({
    fingerprint: refusal.fingerprint,
    rawText: refusal.rawText,
    detectedSite: refusal.site,
    detectionConfidence: confidenceOf(refusal.permille),
    stage: refusal.stage as ConversionFailure["stage"],
    reason: refusal.reason,
    message: refusal.message,
    parserVersion: refusal.parserVersion,
    sourceFilename: refusal.sourceFilename,
  }));
}

/** An engine over an instantiated core; `fallback` takes what the core should not. */
export function wasmEngine(core: RailCore, fallback: ConversionEngine = typescriptEngine()): ConversionEngine {
  return {
    kind: "wasm",
    async split(text) {
      if (!inConverterForm(text)) {
        return fallback.split(text);
      }
      const split = core.split(encoder.encode(text));
      if (split.decode.problem !== null || split.decode.encoding !== "UTF-8" || !split.detected) {
        return fallback.split(text);
      }
      const top = split.detected.candidates[0];
      return {
        siteId: split.detected.top,
        siteName: split.name,
        confidence: confidenceOf(top?.permille ?? null),
        chunks: split.chunks,
      };
    },
    async convert(text, options = {}) {
      const filename = options.sourceFilename ?? null;
      if (!inConverterForm(text) || filename === "") {
        return fallback.convert(text, options);
      }
      const result = core.convert(encoder.encode(text), filename ?? "", {
        // The core has no clock; the TypeScript parsers stamp the same thing.
        parsedAt: new Date().toISOString(),
        siteId: options.siteId || null,
        cashOnly: options.cashOnly ?? false,
        skipBombPots: options.skipBombPots ?? false,
        validate: options.validate !== false,
        // The web renders standard text itself when it needs it (download, save).
        standardText: false,
      });
      if (result.decode.problem !== null || result.decode.encoding !== "UTF-8" || !result.stats) {
        if (result.thrown !== null) {
          // What `convertAny` would have thrown.
          throw new Error(result.thrown);
        }
        return fallback.convert(text, options);
      }
      return {
        hands: result.hands.map((hand): PhfHand => hand.phf),
        failures: failuresOf(result),
        stats: result.stats,
      };
    },
  };
}

/* ----------------------------------------------------------------- choice - */

let chosen: Promise<ConversionEngine> | undefined;

/**
 * The engine this page (or worker) converts with: the WebAssembly core once it
 * has loaded, the TypeScript parsers when it cannot. Decided once per page or
 * worker; a failure is logged once, and the next page load tries again.
 */
export function conversionEngine(): Promise<ConversionEngine> {
  chosen ??= instantiateRailCore().then(
    (core) => wasmEngine(core),
    (error: unknown) => {
      console.warn(
        "[rail] The WebAssembly core could not be loaded; converting with the TypeScript parsers instead.",
        error,
      );
      return typescriptEngine();
    },
  );
  return chosen;
}

/** Forgets the choice (tests). */
export function resetConversionEngine(): void {
  chosen = undefined;
}
