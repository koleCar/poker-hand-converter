/**
 * The conversion loop, without any DOM or React in it.
 *
 * Converting a whole file is one call that returns when the file is done. On
 * the 7.9 MB / 6 299-hand file built from `weplay-hh/` that call takes ~2 s,
 * which is two seconds of no progress bar, no cancel button and no repaint. So
 * the loop here splits the file with the detected parser first and converts
 * one batch of hands at a time, reporting after each batch.
 *
 * Measured with the batched loop: identical output (6 120 hands, 179 failures)
 * and no measurable overhead, with the slowest single batch at ~60 ms for a
 * batch of 100. That is small enough to stay responsive even in the main-thread
 * fallback, and it is what lets cancel take effect within a frame or two.
 *
 * The splitting and converting are the engine's (`lib/wasm/engine.ts`): the
 * WebAssembly core since R4.1, the TypeScript parsers when it cannot load.
 * Both split the same way and batch the same way, so a run's batches, hands
 * and failures do not depend on which one ran.
 *
 * This module is imported by both `workers/convert.worker.ts` and — when a
 * worker cannot be created — by the main thread, so it must not touch `window`.
 */

import type { ConversionFailure, ConvertOptions } from "../../lib/phf/detect";
import type { PhfHand } from "../../lib/phf/types";
import { conversionEngine, type ConversionEngine } from "../../lib/wasm/engine";
import type { BulkSource } from "./bulkSource";

/**
 * Hands per conversion call.
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

/** What converting one source reports, with the batch's position (R4.2). */
interface SourceHandlers {
  onSourceStart(start: SourceStart): void;
  /** `index` counts the source's batches from 0; `last` is its final one. */
  onBatch(batch: PipelineBatch, index: number, last: boolean): void;
  onSourceEnd(sourceId: string): void;
  isCancelled(): boolean;
  /** Awaited before each conversion call: the bulk path's backpressure. */
  beforeBatch?(): Promise<void>;
}

/**
 * Converts one source batch by batch. False when cancelled midway.
 *
 * `skipBatches` (a resumed upload) leaves the source's first batches
 * unconverted: the split is deterministic, so batch `i` is the same hands on
 * every attempt, and those were stored by the earlier one.
 */
async function convertSource(
  conv: ConversionEngine,
  source: PipelineSource,
  options: ConvertOptions,
  handlers: SourceHandlers,
  skipBatches = 0,
): Promise<boolean> {
  const opts: ConvertOptions = { ...options, sourceFilename: source.name };
  const split = await conv.split(source.text);
  const chunks = split.chunks;

  if (split.siteId === null || !chunks || chunks.length === 0) {
    handlers.onSourceStart({
      sourceId: source.id,
      siteId: split.siteId,
      siteName: split.siteName,
      confidence: split.confidence,
      total: 1,
    });
    if (skipBatches < 1) {
      await handlers.beforeBatch?.();
      const result = await conv.convert(source.text, opts);
      handlers.onBatch(
        { sourceId: source.id, hands: result.hands, failures: result.failures, done: 1, total: 1 },
        0,
        true,
      );
    }
    handlers.onSourceEnd(source.id);
    return true;
  }

  handlers.onSourceStart({
    sourceId: source.id,
    siteId: split.siteId,
    siteName: split.siteName,
    confidence: split.confidence,
    total: chunks.length,
  });

  for (let i = skipBatches * BATCH_SIZE; i < chunks.length; i += BATCH_SIZE) {
    if (handlers.isCancelled()) {
      return false;
    }
    await handlers.beforeBatch?.();
    if (handlers.isCancelled()) {
      return false;
    }
    // Re-joined with a blank line: every parser splits on a lookahead at its
    // own header line, so a batch re-splits into exactly the hands it holds.
    const batchText = chunks.slice(i, i + BATCH_SIZE).join("\n\n");
    const result = await conv.convert(batchText, opts);
    const done = Math.min(i + BATCH_SIZE, chunks.length);
    handlers.onBatch(
      { sourceId: source.id, hands: result.hands, failures: result.failures, done, total: chunks.length },
      i / BATCH_SIZE,
      done === chunks.length,
    );
    await yieldToLoop();
  }

  handlers.onSourceEnd(source.id);
  return true;
}

/**
 * Converts every source, streaming batches through `handlers`.
 *
 * A source whose site nothing recognises still goes through the engine once,
 * because that is what produces the `unknown-site` failure record we want to
 * keep — an unsupported format is reference material, not an error to swallow.
 *
 * `engine` defaults to {@link conversionEngine}'s choice; the caller can learn
 * which one ran from the returned kind.
 */
export async function runPipeline(
  sources: PipelineSource[],
  options: ConvertOptions,
  handlers: PipelineHandlers,
  engine?: ConversionEngine,
): Promise<ConversionEngine["kind"]> {
  const conv = engine ?? (await conversionEngine());
  for (const source of sources) {
    if (handlers.isCancelled()) {
      return conv.kind;
    }
    const finished = await convertSource(conv, source, options, {
      onSourceStart: handlers.onSourceStart,
      onBatch: (batch) => handlers.onBatch(batch),
      onSourceEnd: handlers.onSourceEnd,
      isCancelled: handlers.isCancelled,
    });
    if (!finished) {
      return conv.kind;
    }
  }
  return conv.kind;
}

/* ------------------------------------------------------- bulk (R4.2) - */

/** A batch on the bulk path: where it sits in its source, for resuming. */
export interface StreamBatch extends PipelineBatch {
  /** The source's resume key (`BulkSource.key`). */
  key: string;
  index: number;
  last: boolean;
}

export interface StreamHandlers {
  /** A source was read (or could not be): before any of its batches. */
  onSource(source: BulkSource): void;
  onSourceStart(start: SourceStart): void;
  onBatch(batch: StreamBatch): void;
  onSourceEnd(sourceId: string, key: string): void;
  isCancelled(): boolean;
  /**
   * Resolves when the consumer has room for another batch. The worker waits
   * here for the page's acknowledgements, so conversion never runs further
   * ahead of the save than the page allows.
   */
  waitForRoom(): Promise<void>;
  /** Batches of `key` an earlier attempt stored; 0 when none. */
  skipBatches(key: string): number;
}

/**
 * Converts a stream of sources as they are read (`bulkSource.ts`), one at a
 * time: the source in hand is the only one in memory. Same batches as
 * {@link runPipeline} for the same text.
 */
export async function runSourceStream(
  sources: AsyncIterable<BulkSource>,
  options: ConvertOptions,
  handlers: StreamHandlers,
  engine?: ConversionEngine,
): Promise<ConversionEngine["kind"]> {
  const conv = engine ?? (await conversionEngine());
  for await (const source of sources) {
    if (handlers.isCancelled()) {
      break;
    }
    handlers.onSource(source);
    if (source.problem) {
      continue;
    }
    const finished = await convertSource(
      conv,
      source,
      options,
      {
        onSourceStart: handlers.onSourceStart,
        onBatch: (batch, index, last) => handlers.onBatch({ ...batch, key: source.key, index, last }),
        onSourceEnd: (sourceId) => handlers.onSourceEnd(sourceId, source.key),
        isCancelled: handlers.isCancelled,
        beforeBatch: handlers.waitForRoom,
      },
      handlers.skipBatches(source.key),
    );
    if (!finished) {
      break;
    }
    await handlers.waitForRoom();
  }
  return conv.kind;
}
