/**
 * One API for "convert these sources", whether or not a worker is available.
 *
 * The happy path posts to `workers/convert.worker.ts`. Workers can fail to
 * start for reasons that have nothing to do with the user — a strict CSP, a
 * `file://` page, an embedded webview — and a converter that shows a blank
 * screen in those cases is worse than one that is briefly janky, so the
 * fallback runs the identical pipeline on the main thread.
 *
 * Either way the pipeline converts with the WebAssembly core, or with the
 * TypeScript parsers when the core cannot load (`lib/wasm/engine.ts`);
 * `onDone` reports which.
 */

import type { ConvertOptions } from "../../lib/phf/detect";
import type { EngineKind } from "../../lib/wasm/engine";
import { startBulkRun, type BulkMessage, type BulkRequest, type SourceInfo } from "./bulkRun";
import { runPipeline, type PipelineBatch, type PipelineSource, type SourceStart, type StreamBatch } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "../../workers/convert.worker";

export interface ConversionHandlers {
  onSourceStart(start: SourceStart): void;
  onBatch(batch: PipelineBatch): void;
  onSourceEnd(sourceId: string): void;
  onDone(info: { cancelled: boolean; usedWorker: boolean; engine: EngineKind | null }): void;
  /**
   * The run failed. `message` is the thrown error's own (technical) text, or
   * empty when the worker died without one; the caller supplies the words for
   * that case in the reader's language.
   */
  onError(message: string): void;
}

/** Handle on a running conversion. `cancel()` is safe to call at any time. */
export interface ConversionJob {
  cancel(): void;
}

let jobSequence = 0;

function createWorker(): Worker | null {
  try {
    return new Worker(new URL("../../workers/convert.worker.ts", import.meta.url), {
      type: "module",
      name: "phc-convert",
    });
  } catch {
    return null;
  }
}

export function startConversion(
  sources: PipelineSource[],
  options: ConvertOptions,
  handlers: ConversionHandlers,
): ConversionJob {
  jobSequence += 1;
  const jobId = jobSequence;
  const worker = createWorker();

  if (!worker) {
    let cancelled = false;
    void runPipeline(sources, options, {
      onSourceStart: handlers.onSourceStart,
      onBatch: handlers.onBatch,
      onSourceEnd: handlers.onSourceEnd,
      isCancelled: () => cancelled,
    })
      .then((engine) => handlers.onDone({ cancelled, usedWorker: false, engine }))
      .catch((error: unknown) =>
        handlers.onError(error instanceof Error ? error.message : String(error)),
      );
    return { cancel: () => { cancelled = true; } };
  }

  let finished = false;
  const finish = (cancelled: boolean, engine: EngineKind | null) => {
    if (finished) {
      return;
    }
    finished = true;
    worker.terminate();
    handlers.onDone({ cancelled, usedWorker: true, engine });
  };

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.jobId !== jobId) {
      return;
    }
    switch (message.type) {
      case "source-start":
        handlers.onSourceStart(message);
        break;
      case "batch":
        handlers.onBatch(message);
        break;
      case "source-end":
        handlers.onSourceEnd(message.sourceId);
        break;
      case "done":
        finish(message.cancelled, message.engine);
        break;
      case "error":
        if (!finished) {
          finished = true;
          worker.terminate();
          handlers.onError(message.message);
        }
        break;
    }
  };

  worker.onerror = (event) => {
    if (!finished) {
      finished = true;
      worker.terminate();
      handlers.onError(event.message || "");
    }
  };

  const request: WorkerRequest = { type: "convert", jobId, sources, options };
  worker.postMessage(request);

  return {
    cancel: () => {
      if (finished) {
        return;
      }
      // Ask nicely first so the worker can stop between batches and report the
      // partial result; terminating outright would throw away converted hands.
      worker.postMessage({ type: "cancel", jobId } satisfies WorkerRequest);
      // Belt and braces: if the worker is wedged, stop waiting for it.
      setTimeout(() => finish(true, null), 1500);
    },
  };
}

/* ------------------------------------------------------- bulk (R4.2) - */

export interface BulkHandlers {
  onSource(source: SourceInfo): void;
  onSourceStart(start: SourceStart): void;
  onBatch(batch: StreamBatch): void;
  onSourceEnd(sourceId: string, key: string): void;
  onConsumed(consumed: { bytes: number; done: number; other: number }): void;
  onDone(info: { cancelled: boolean; usedWorker: boolean; engine: EngineKind | null }): void;
  onError(message: string): void;
}

/** A running bulk conversion: cancel it, or acknowledge batches taken. */
export interface BulkJob extends ConversionJob {
  ack(batches: number): void;
}

/**
 * Starts converting a drop on the bulk path (R4.2): the worker reads the files
 * itself and waits for {@link BulkJob.ack} before running more than `window`
 * batches ahead. Falls back to the page, with the same flow control, when no
 * worker can start.
 */
export function startBulkConversion(
  request: Omit<BulkRequest, "type" | "jobId">,
  handlers: BulkHandlers,
): BulkJob {
  jobSequence += 1;
  const jobId = jobSequence;
  const full: BulkRequest = { ...request, type: "bulk", jobId };

  const dispatch = (message: BulkMessage) => {
    switch (message.type) {
      case "bulk-source":
        handlers.onSource(message.source);
        break;
      case "source-start":
        handlers.onSourceStart(message);
        break;
      case "bulk-batch":
        handlers.onBatch(message);
        break;
      case "bulk-source-end":
        handlers.onSourceEnd(message.sourceId, message.key);
        break;
      case "bulk-consumed":
        handlers.onConsumed(message);
        break;
    }
  };

  const worker = createWorker();
  if (!worker) {
    let cancelled = false;
    const run = startBulkRun(full, dispatch, () => cancelled);
    run.finished
      .then((engine) => handlers.onDone({ cancelled, usedWorker: false, engine }))
      .catch((error: unknown) => handlers.onError(error instanceof Error ? error.message : String(error)));
    return {
      cancel: () => {
        cancelled = true;
        run.wake();
      },
      ack: (batches) => run.ack(batches),
    };
  }

  let finished = false;
  const finish = (cancelled: boolean, engine: EngineKind | null) => {
    if (finished) {
      return;
    }
    finished = true;
    worker.terminate();
    handlers.onDone({ cancelled, usedWorker: true, engine });
  };

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.jobId !== jobId) {
      return;
    }
    if (message.type === "done") {
      finish(message.cancelled, message.engine);
    } else if (message.type === "error") {
      if (!finished) {
        finished = true;
        worker.terminate();
        handlers.onError(message.message);
      }
    } else if (message.type !== "batch" && message.type !== "source-end") {
      dispatch(message);
    }
  };
  worker.onerror = (event) => {
    if (!finished) {
      finished = true;
      worker.terminate();
      handlers.onError(event.message || "");
    }
  };
  worker.postMessage(full satisfies WorkerRequest);

  return {
    cancel: () => {
      if (finished) {
        return;
      }
      worker.postMessage({ type: "cancel", jobId } satisfies WorkerRequest);
      setTimeout(() => finish(true, null), 1500);
    },
    ack: (batches) => {
      if (!finished) {
        worker.postMessage({ type: "ack", jobId, batches } satisfies WorkerRequest);
      }
    },
  };
}
