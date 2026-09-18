/**
 * The conversion loop, without any DOM or React in it.
 *
 * `convertAny` is one call that returns when the whole file is done. On the
 * 7.9 MB / 6 299-hand file built from `weplay-hh/` that call takes ~2 s, which
 * is two seconds of no progress bar, no cancel button and no repaint. So the
 * loop here splits the file with the detected parser first and feeds
 * `convertAny` one batch of hands at a time, reporting after each batch.
 *
 * Measured with the batched loop: identical output (6 120 hands, 179 failures)
 * and no measurable overhead, with the slowest single batch at ~60 ms for a
 * batch of 100. That is small enough to stay responsive even in the main-thread
 * fallback, and it is what lets cancel take effect within a frame or two.
 *
 * This module is imported by both `workers/convert.worker.ts` and — when a
 * worker cannot be created — by the main thread, so it must not touch `window`.
 */

import {
  convertAny,
  detectSite,
  type ConversionFailure,
  type ConvertOptions,
} from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";

/**
 * Hands per `convertAny` call.
 *
 * Small enough that a cancel lands quickly and the progress bar moves visibly,
 * large enough that the per-call detection and split overhead disappears.
 */
export const BATCH_SIZE = 100;

/** One decoded file (or pasted block) handed to the pipeline. */
export interface PipelineSource {
  id: string;
  name: string;
  text: string;
}

/** What the detector concluded about a source, before any hand is parsed. */
export interface SourceStart {
  sourceId: string;
  /** Registry id of the winning parser, or null when nothing claimed the text. */
  siteId: string | null;
  siteName: string | null;
  confidence: number | null;
  /** Hands the split found. 1 for a source nothing recognised. */
  total: number;
}

/** One batch of results, streamed out as soon as it exists. */
export interface PipelineBatch {
  sourceId: string;
  hands: PhfHand[];
  failures: ConversionFailure[];
  /** Hands of this source processed so far, including this batch. */
  done: number;
  total: number;
}

export interface PipelineHandlers {
  onSourceStart(start: SourceStart): void;
  onBatch(batch: PipelineBatch): void;
  onSourceEnd(sourceId: string): void;
  /** True to stop; checked between batches. */
  isCancelled(): boolean;
}

/** Yields to the event loop so `postMessage` and cancels get a turn. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Converts every source, streaming batches through `handlers`.
 *
 * A source whose site nothing recognises still goes through `convertAny` once,
 * because that is what produces the `unknown-site` failure record we want to
 * keep — an unsupported format is reference material, not an error to swallow.
 */
export async function runPipeline(
  sources: PipelineSource[],
  options: ConvertOptions,
  handlers: PipelineHandlers,
): Promise<void> {
  for (const source of sources) {
    if (handlers.isCancelled()) {
      return;
    }

    const opts: ConvertOptions = { ...options, sourceFilename: source.name };
    const best = detectSite(source.text)[0];

    let chunks: string[] | null = null;
    if (best) {
      try {
        chunks = best.parser.splitHands(source.text);
      } catch {
        // Let `convertAny` produce the proper `split-failed` failure record.
        chunks = null;
      }
    }

    if (!best || !chunks || chunks.length === 0) {
      handlers.onSourceStart({
        sourceId: source.id,
        siteId: best?.parser.id ?? null,
        siteName: best?.parser.name ?? null,
        confidence: best?.confidence ?? null,
        total: 1,
      });
      const result = await convertAny(source.text, opts);
      handlers.onBatch({
        sourceId: source.id,
        hands: result.hands,
        failures: result.failures,
        done: 1,
        total: 1,
      });
      handlers.onSourceEnd(source.id);
      continue;
    }

    handlers.onSourceStart({
      sourceId: source.id,
      siteId: best.parser.id,
      siteName: best.parser.name,
      confidence: best.confidence,
      total: chunks.length,
    });

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      if (handlers.isCancelled()) {
        return;
      }
      // Re-joined with a blank line: every parser splits on a lookahead at its
      // own header line, so a batch re-splits into exactly the hands it holds.
      const batchText = chunks.slice(i, i + BATCH_SIZE).join("\n\n");
      const result = await convertAny(batchText, opts);
      handlers.onBatch({
        sourceId: source.id,
        hands: result.hands,
        failures: result.failures,
        done: Math.min(i + BATCH_SIZE, chunks.length),
        total: chunks.length,
      });
      await yieldToLoop();
    }

    handlers.onSourceEnd(source.id);
  }
}
