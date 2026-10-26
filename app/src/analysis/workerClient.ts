/**
 * The window's side of the analysis worker (`worker.ts`, R5.4): one worker
 * at a time (the analysis is a background job: one core at most), created
 * when first needed and terminated when a page is stopped - a table opened
 * (A10), the user paused it, the app is quitting. A page analysed but not
 * written is simply analysed again later.
 *
 * The worker's flop library fetches are answered here by `fetchFile` (in
 * the app: Rust's `flop_library_file` - the disk, else the web's public
 * bucket; `service.ts`).
 */
import type { PageHand, PageResult } from "./engine";
import type { HandAnalysis, TournamentSettingsMap, VillainStatsMap } from "./library";
import type { FetchOutcome, WorkerRequest, WorkerResponse } from "./worker";

/** Thrown out of a page that was stopped. */
export class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

/** A `flop_library_file` rejection's text as the worker's outcome. */
export function fetchOutcomeOfError(text: string): FetchOutcome {
  if (text === "absent") return { kind: "absent" };
  if (text.startsWith("transient:")) return { kind: "transient", status: Number(text.slice("transient:".length)) || 503 };
  // `offline`, or anything else that kept the file away.
  return { kind: "offline" };
}

/** What the runner needs of the worker. */
export interface Analyser {
  analyse(
    page: PageHand[],
    villains: VillainStatsMap | null,
    library: boolean,
    signal?: AbortSignal,
    onDone?: (done: number) => void,
    tournaments?: TournamentSettingsMap | null,
  ): Promise<PageResult>;
  hand(hand: PageHand, villains: VillainStatsMap | null, library: boolean, tournaments?: TournamentSettingsMap | null): Promise<HandAnalysis>;
  /** Terminate the worker (the next call makes a new one). */
  stop(): void;
}

type MakeWorker = () => Worker;

const defaultWorker: MakeWorker = () =>
  new Worker(new URL("./worker.entry.ts", import.meta.url), { type: "module", name: "rail-analysis" });

/** The worker client: `fetchFile` answers the worker's flop library files; `make` is the tests' to replace. */
export function workerAnalyser(fetchFile: (path: string) => Promise<FetchOutcome>, make: MakeWorker = defaultWorker): Analyser {
  let worker: Worker | null = null;
  let jobSeq = 0;
  const jobs = new Map<number, { resolve: (message: WorkerResponse) => void; reject: (error: Error) => void; onDone?: (done: number) => void }>();

  const fail = (error: Error) => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };

  const live = (): Worker => {
    if (worker) return worker;
    const made = make();
    made.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "fetch") {
        void fetchFile(message.path).then((outcome) => {
          if (worker !== made) return;
          const reply: WorkerRequest = { type: "fetched", reqId: message.reqId, outcome };
          made.postMessage(reply, outcome.kind === "bytes" ? [outcome.bytes] : []);
        });
        return;
      }
      const job = jobs.get(message.jobId);
      if (!job) return;
      if (message.type === "progress") {
        job.onDone?.(message.done);
        return;
      }
      jobs.delete(message.jobId);
      if (message.type === "error") job.reject(new Error(message.message));
      else job.resolve(message);
    };
    made.onerror = (event) => {
      if (worker === made) worker = null;
      made.terminate();
      fail(new Error(event.message || "the analysis worker failed"));
    };
    worker = made;
    return made;
  };

  const stop = () => {
    worker?.terminate();
    worker = null;
    fail(new Stopped());
  };

  const ask = (request: WorkerRequest & { jobId: number }, onDone?: (done: number) => void): Promise<WorkerResponse> =>
    new Promise((resolve, reject) => {
      jobs.set(request.jobId, { resolve, reject, onDone });
      live().postMessage(request);
    });

  return {
    async analyse(page, villains, library, signal, onDone, tournaments = null) {
      if (signal?.aborted) throw new Stopped();
      const onAbort = () => stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        jobSeq += 1;
        const message = await ask({ type: "analyse", jobId: jobSeq, page, villains, library, tournaments }, onDone);
        if (message.type !== "analysed") throw new Error(`unexpected ${message.type} from the analysis worker`);
        return { rows: message.rows, failed: message.failed };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    async hand(hand, villains, library, tournaments = null) {
      jobSeq += 1;
      const message = await ask({ type: "hand", jobId: jobSeq, hand, villains, library, tournaments });
      if (message.type !== "hand") throw new Error(`unexpected ${message.type} from the analysis worker`);
      return message.analysis;
    },
    stop,
  };
}
