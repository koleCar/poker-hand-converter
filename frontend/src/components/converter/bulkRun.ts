/**
 * One bulk conversion (R4.2): read the drop, convert it, post what happens.
 *
 * Shared by the conversion worker and the page's fallback when no worker can
 * start, so both speak the same messages (`WorkerResponse`) and obey the same
 * flow control: at most `window` batches posted and not yet acknowledged.
 * Must not touch `window` or `self`.
 */

import type { ConvertOptions } from "../../lib/phf/detect";
import type { EngineKind } from "../../lib/wasm/engine";
import { readInputs, type BulkSource, type InputItem } from "./bulkSource";
import { runSourceStream, type SourceStart, type StreamBatch } from "./pipeline";

/** What an earlier attempt of the same upload already stored. */
export interface ResumeState {
  /** Source keys whose hands (and original, when kept) are all stored. */
  done: string[];
  /** Source keys with a stored prefix of batches, and how many. */
  batches: Array<[string, number]>;
}

export interface BulkRequest {
  type: "bulk";
  jobId: number;
  items: InputItem[];
  options: ConvertOptions;
  keepOriginals: boolean;
  resume: ResumeState;
  /** Batches that may be posted before an acknowledgement is awaited. */
  window: number;
}

/** A read source as the page sees it: everything but the text. */
export type SourceInfo = Omit<BulkSource, "text">;

export type BulkMessage =
  | ({ type: "source-start"; jobId: number } & SourceStart)
  | { type: "bulk-source"; jobId: number; source: SourceInfo }
  | ({ type: "bulk-batch"; jobId: number } & StreamBatch)
  | { type: "bulk-source-end"; jobId: number; sourceId: string; key: string }
  | { type: "bulk-consumed"; jobId: number; bytes: number; done: number; other: number };

export interface BulkRun {
  /** Resolves with the engine that converted, once the drop is done or cancelled. */
  finished: Promise<EngineKind>;
  /** `batches` more were taken by the page. */
  ack(batches: number): void;
  /** Wakes a wait for room (after a cancel). */
  wake(): void;
}

export function startBulkRun(
  request: BulkRequest,
  post: (message: BulkMessage) => void,
  isCancelled: () => boolean,
): BulkRun {
  const { jobId } = request;
  const window = Math.max(1, request.window);
  let sent = 0;
  let acked = 0;
  let wake: (() => void) | null = null;
  const wakeUp = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const done = new Set(request.resume.done);
  const batches = new Map(request.resume.batches);

  // Consumed bytes arrive per entry - thousands for a big archive - so they
  // are summed and posted with the next source or batch, not one by one.
  const pending = { bytes: 0, done: 0, other: 0 };
  const flushConsumed = () => {
    if (pending.bytes || pending.done || pending.other) {
      post({ type: "bulk-consumed", jobId, ...pending });
      pending.bytes = 0;
      pending.done = 0;
      pending.other = 0;
    }
  };

  const sources = readInputs(request.items, {
    idPrefix: `j${jobId}`,
    keepOriginals: request.keepOriginals,
    isDone: (key) => done.has(key),
    isCancelled,
    onConsumed: (bytes, skipped) => {
      pending.bytes += bytes;
      pending.done += skipped.done;
      pending.other += skipped.other;
    },
  });

  const finished = runSourceStream(sources, request.options, {
    onSource: (source) => {
      flushConsumed();
      // Everything but the text, which stays here.
      const info: SourceInfo = {
        id: source.id,
        key: source.key,
        name: source.name,
        bytes: source.bytes,
        encoding: source.encoding,
        problem: source.problem,
        original: source.original,
      };
      post({ type: "bulk-source", jobId, source: info });
    },
    onSourceStart: (start) => post({ type: "source-start", jobId, ...start }),
    onBatch: (batch) => {
      flushConsumed();
      sent += 1;
      post({ type: "bulk-batch", jobId, ...batch });
    },
    onSourceEnd: (sourceId, key) => post({ type: "bulk-source-end", jobId, sourceId, key }),
    isCancelled,
    skipBatches: (key) => batches.get(key) ?? 0,
    waitForRoom: async () => {
      while (sent - acked >= window && !isCancelled()) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  }).finally(flushConsumed);

  return {
    finished,
    ack: (count) => {
      acked += count;
      wakeUp();
    },
    wake: wakeUp,
  };
}
