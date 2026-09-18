/**
 * One API for "convert these sources", whether or not a worker is available.
 *
 * The happy path posts to `workers/convert.worker.ts`. Workers can fail to
 * start for reasons that have nothing to do with the user — a strict CSP, a
 * `file://` page, an embedded webview — and a converter that shows a blank
 * screen in those cases is worse than one that is briefly janky, so the
 * fallback runs the identical pipeline on the main thread.
 */

import type { ConvertOptions } from "../../lib/phf";
import { runPipeline, type PipelineBatch, type PipelineSource, type SourceStart } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "../../workers/convert.worker";

export interface ConversionHandlers {
  onSourceStart(start: SourceStart): void;
  onBatch(batch: PipelineBatch): void;
  onSourceEnd(sourceId: string): void;
  onDone(info: { cancelled: boolean; usedWorker: boolean }): void;
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
      .then(() => handlers.onDone({ cancelled, usedWorker: false }))
      .catch((error: unknown) =>
        handlers.onError(error instanceof Error ? error.message : String(error)),
      );
    return { cancel: () => { cancelled = true; } };
  }

  let finished = false;
  const finish = (cancelled: boolean) => {
    if (finished) {
      return;
    }
    finished = true;
    worker.terminate();
    handlers.onDone({ cancelled, usedWorker: true });
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
        finish(message.cancelled);
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
      handlers.onError(event.message || "The conversion worker stopped unexpectedly.");
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
      setTimeout(() => finish(true), 1500);
    },
  };
}
