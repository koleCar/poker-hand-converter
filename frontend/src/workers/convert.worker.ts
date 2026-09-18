/**
 * Conversion worker.
 *
 * The whole reason this file exists is the measurement in
 * `components/converter/pipeline.ts`: converting the 7.9 MB WePlay corpus takes
 * ~2 s of solid CPU. On the main thread that is a frozen tab — no progress, no
 * cancel, no repaint. Off it, the page stays at 60 fps and the progress bar is
 * genuinely live.
 *
 * The worker owns no state beyond the id of the job it is running, so a cancel
 * is a single flag. Everything else lives in the pipeline module, which the
 * main thread reuses verbatim when a worker cannot be created.
 */

import { runPipeline, type PipelineSource } from "../components/converter/pipeline";
import type { ConvertOptions } from "../lib/phf";
import type { PipelineBatch, SourceStart } from "../components/converter/pipeline";

export interface ConvertRequest {
  type: "convert";
  jobId: number;
  sources: PipelineSource[];
  options: ConvertOptions;
}

export interface CancelRequest {
  type: "cancel";
  jobId: number;
}

export type WorkerRequest = ConvertRequest | CancelRequest;

export type WorkerResponse =
  | ({ type: "source-start"; jobId: number } & SourceStart)
  | ({ type: "batch"; jobId: number } & PipelineBatch)
  | { type: "source-end"; jobId: number; sourceId: string }
  | { type: "done"; jobId: number; cancelled: boolean }
  | { type: "error"; jobId: number; message: string };

let cancelledJob: number | null = null;

function reply(message: WorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === "cancel") {
    cancelledJob = request.jobId;
    return;
  }

  const { jobId, sources, options } = request;
  const isCancelled = () => cancelledJob === jobId;

  void runPipeline(sources, options, {
    onSourceStart: (start) => reply({ type: "source-start", jobId, ...start }),
    onBatch: (batch) => reply({ type: "batch", jobId, ...batch }),
    onSourceEnd: (sourceId) => reply({ type: "source-end", jobId, sourceId }),
    isCancelled,
  })
    .then(() => reply({ type: "done", jobId, cancelled: isCancelled() }))
    .catch((error: unknown) =>
      reply({ type: "error", jobId, message: error instanceof Error ? error.message : String(error) }),
    );
};
