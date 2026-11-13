/**
 * The app's trainer worker: the web's training jobs (`jobs.ts`) off the
 * window's thread - a turn or river spot solves on the spot, up to a few
 * seconds, and the window must stay as quick as ever while it runs.
 *
 * As in the analysis worker (`src/analysis/worker.ts`), a worker of the
 * app's webview has no Tauri IPC: the flop library's files are asked of the
 * window ({@link TrainerFetch}), which reads them through Rust
 * (`flop_library_file`: the disk, else the web's public bucket).
 */
import type { FetchOutcome } from "../analysis/worker";
import {
  ensureChartSets,
  FlopLibraryLoader,
  isPlayJob,
  loadChartLibrary,
  prepareFlopLibrary,
  runPlayJob,
  runTrainingJob,
  trainingChartSets,
  type ChartLibrary,
  type LibraryFetch,
  type TrainingRequest,
  type TrainingResponse,
} from "./jobs";

/** A flop library file the worker needs (`<set>/<tree>/...`). */
export interface TrainerFetch {
  type: "fetch";
  reqId: number;
  path: string;
}

/** The window's answer to a {@link TrainerFetch}. */
export interface TrainerFetched {
  type: "fetched";
  reqId: number;
  outcome: FetchOutcome;
}

export type TrainerWorkerRequest = TrainingRequest | TrainerFetched;
export type TrainerWorkerResponse = TrainingResponse | TrainerFetch;

/** The loader's base: every URL it builds is `<BASE>/<path>`. */
const BASE = "rail-flop-library:";

interface Scope {
  postMessage(message: TrainerWorkerResponse): void;
  onmessage: ((event: MessageEvent<TrainerWorkerRequest>) => void) | null;
}

export function createTrainerWorker(scope: Scope): void {
  let charts: Promise<ChartLibrary> | null = null;
  let reqSeq = 0;
  const waiting = new Map<number, (outcome: FetchOutcome) => void>();

  const fetcher: LibraryFetch = async (url) => {
    const path = url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : url;
    reqSeq += 1;
    const reqId = reqSeq;
    const outcome = await new Promise<FetchOutcome>((resolve) => {
      waiting.set(reqId, resolve);
      scope.postMessage({ type: "fetch", reqId, path });
    });
    if (outcome.kind === "bytes") {
      const bytes = outcome.bytes;
      return {
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(bytes),
        json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      };
    }
    if (outcome.kind === "offline") throw new Error("offline");
    const status = outcome.kind === "absent" ? 404 : outcome.status;
    const fail = () => Promise.reject(new Error(outcome.kind));
    return { ok: false, status, arrayBuffer: fail, json: fail };
  };
  const loader = new FlopLibraryLoader(BASE, fetcher);

  scope.onmessage = (event) => {
    const request = event.data;
    if (request.type === "fetched") {
      const resolve = waiting.get(request.reqId);
      waiting.delete(request.reqId);
      resolve?.(request.outcome);
      return;
    }
    void handle(request);
  };

  async function handle(request: TrainingRequest): Promise<void> {
    try {
      charts ??= loadChartLibrary().catch((error: unknown) => {
        charts = null;
        throw error;
      });
      const library = await charts;
      await ensureChartSets(library, trainingChartSets(request));
      if (isPlayJob(request)) {
        scope.postMessage(await runPlayJob(request, library, loader));
        return;
      }
      const flop = await prepareFlopLibrary(request, library, loader);
      scope.postMessage(runTrainingJob(request, library, flop));
    } catch (error) {
      scope.postMessage({ type: "error", jobId: request.jobId, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
