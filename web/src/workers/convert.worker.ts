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
 *
 * Since R4.1 the pipeline converts with the WebAssembly core: the first job
 * awaits its `init()` with the `.wasm` URL (`lib/wasm/core.ts`), later jobs
 * reuse the instance. When it cannot load, the TypeScript parsers convert
 * instead (`lib/wasm/engine.ts`), and `done` says which engine ran.
 *
 * ## Two requests
 *
 * `convert` takes decoded text and converts all of it (the protocol R4.1's
 * tests drive). `bulk` (R4.2, `components/converter/bulkRun.ts`) takes the
 * dropped `File` handles themselves - posting a `File` copies no bytes - and
 * reads, unzips and decodes them here, one at a time, converting each before
 * reading the next. Its batches are **acknowledged** by the page (`ack`) once
 * the save has room for them; the worker never runs more than `window`
 * batches ahead, so a slow network slows the conversion down instead of
 * filling the tab's memory.
 */

import { startBulkRun, type BulkMessage, type BulkRequest, type BulkRun } from "../components/converter/bulkRun";
import { runPipeline, type PipelineBatch, type PipelineSource, type SourceStart } from "../components/converter/pipeline";
import type { ConvertOptions } from "../lib/phf/detect";
import type { EngineKind } from "../lib/wasm/engine";

export type { BulkRequest } from "../components/converter/bulkRun";

export interface ConvertRequest {
  type: "convert";
  jobId: number;
  sources: PipelineSource[];
  options: ConvertOptions;
}

export interface AckRequest {
  type: "ack";
  jobId: number;
  /** Batches acknowledged by this message. */
  batches: number;
}

export interface CancelRequest {
  type: "cancel";
  jobId: number;
}

export type WorkerRequest = ConvertRequest | BulkRequest | AckRequest | CancelRequest;

export type WorkerResponse =
  | ({ type: "source-start"; jobId: number } & SourceStart)
  | ({ type: "batch"; jobId: number } & PipelineBatch)
  | { type: "source-end"; jobId: number; sourceId: string }
  | { type: "done"; jobId: number; cancelled: boolean; engine: EngineKind }
  | { type: "error"; jobId: number; message: string }
  | BulkMessage;

let cancelledJob: number | null = null;
let bulk: { jobId: number; run: BulkRun } | null = null;

function reply(message: WorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === "cancel") {
    cancelledJob = request.jobId;
    if (bulk?.jobId === request.jobId) {
      bulk.run.wake();
    }
    return;
  }

  if (request.type === "ack") {
    if (bulk?.jobId === request.jobId) {
      bulk.run.ack(request.batches);
    }
    return;
  }

  const { jobId } = request;
  const isCancelled = () => cancelledJob === jobId;

  let run: Promise<EngineKind>;
  if (request.type === "bulk") {
    const started = startBulkRun(request, reply, isCancelled);
    bulk = { jobId, run: started };
    run = started.finished;
  } else {
    run = runPipeline(request.sources, request.options, {
      onSourceStart: (start) => reply({ type: "source-start", jobId, ...start }),
      onBatch: (batch) => reply({ type: "batch", jobId, ...batch }),
      onSourceEnd: (sourceId) => reply({ type: "source-end", jobId, sourceId }),
      isCancelled,
    });
  }

  void run
    .then((engine) => reply({ type: "done", jobId, cancelled: isCancelled(), engine }))
    .catch((error: unknown) =>
      reply({ type: "error", jobId, message: error instanceof Error ? error.message : String(error) }),
    );
};
