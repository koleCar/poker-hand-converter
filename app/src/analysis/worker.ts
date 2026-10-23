/**
 * The app's analysis worker (docs/RAIL-PLAN.md R5.4): the web's analysis,
 * off the window's thread - a river or turn solve takes up to a second or
 * two, and the window must stay as quick as ever while it runs.
 *
 * The web's worker (`frontend/src/workers/analysis.worker.ts`) reads the
 * Supabase URL to fetch the flop library; a worker of the app's webview has
 * no Tauri IPC, so its fetches go to the window ({@link FetchRequest}),
 * which asks Rust (`flop_library_file`: the disk, else the web's public
 * bucket). Otherwise the same: the chart library loaded once and each set
 * when a hand first needs it, the flop library's chunks kept for the
 * worker's life, a page in and rows out with progress in between
 * ({@link analysePage}).
 *
 * Offline, a fetch fails at once (the window says `offline`), and for a
 * minute every fetch fails without asking and the loader does not wait
 * between its tries: the hands are graded without the chunks they would
 * have read - as the web grades a hand whose chunk cannot be fetched - and
 * their rows say so, to be analysed again once the bucket answers.
 */
import { analysePage, preparePage, type PageHand, type PageResult } from "./engine";
import {
  analyzeHand,
  FlopLibraryLoader,
  loadChartLibrary,
  type ChartLibrary,
  type HandAnalysis,
  type LibraryFetch,
  type VillainStatsMap,
} from "./library";

export interface AnalyseRequest {
  type: "analyse";
  jobId: number;
  page: PageHand[];
  villains: VillainStatsMap | null;
  /** Read the flop library (false: known to be offline, or switched off). */
  library: boolean;
}

/** One hand for the hand view, analysed now and not stored. */
export interface HandRequest {
  type: "hand";
  jobId: number;
  hand: PageHand;
  villains: VillainStatsMap | null;
  library: boolean;
}

/** The window's answer to a {@link FetchRequest}. */
export interface FetchReply {
  type: "fetched";
  reqId: number;
  outcome: FetchOutcome;
}

export type FetchOutcome =
  | { kind: "bytes"; bytes: ArrayBuffer }
  | { kind: "absent" }
  | { kind: "transient"; status: number }
  | { kind: "offline" };

export type WorkerRequest = AnalyseRequest | HandRequest | FetchReply;

/** A flop library file the worker needs (`<set>/<tree>/...`). */
export interface FetchRequest {
  type: "fetch";
  reqId: number;
  path: string;
}

export type WorkerResponse =
  | FetchRequest
  | { type: "progress"; jobId: number; done: number }
  | ({ type: "analysed"; jobId: number } & PageResult)
  | { type: "hand"; jobId: number; analysis: HandAnalysis }
  | { type: "error"; jobId: number; message: string };

/** The loader's base: every URL it builds is `<BASE>/<path>`. */
export const BASE = "rail-flop-library:";

/** After an offline answer, this long every fetch fails at once. */
export const OFFLINE_MS = 60_000;

const PROGRESS_MS = 250;

interface Scope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

/**
 * The worker's state and message handler, apart from `self` so a test can
 * drive it with a fake scope.
 */
export function createWorker(scope: Scope, clock: () => number = Date.now): { fetch: LibraryFetch; failures: () => number } {
  let charts: Promise<ChartLibrary> | null = null;
  let offlineUntil = 0;
  let failures = 0;
  let reqSeq = 0;
  const waiting = new Map<number, (outcome: FetchOutcome) => void>();

  const fetcher: LibraryFetch = async (url) => {
    if (clock() < offlineUntil) throw new Error("offline");
    const path = url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : url;
    reqSeq += 1;
    const reqId = reqSeq;
    const outcome = await new Promise<FetchOutcome>((resolve) => {
      waiting.set(reqId, resolve);
      scope.postMessage({ type: "fetch", reqId, path });
    });
    switch (outcome.kind) {
      case "bytes": {
        const bytes = outcome.bytes;
        return {
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(bytes),
          json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
        };
      }
      case "absent":
        return { ok: false, status: 404, arrayBuffer: () => Promise.reject(new Error("absent")), json: () => Promise.reject(new Error("absent")) };
      case "transient":
        failures += 1;
        return {
          ok: false,
          status: outcome.status,
          arrayBuffer: () => Promise.reject(new Error("transient")),
          json: () => Promise.reject(new Error("transient")),
        };
      case "offline":
        failures += 1;
        offlineUntil = clock() + OFFLINE_MS;
        throw new Error("offline");
    }
  };
  // A fetch that fails offline is not waited on: the next try fails at once too.
  const sleep = (ms: number) =>
    clock() < offlineUntil ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));
  const loader = new FlopLibraryLoader(BASE, fetcher, undefined, { sleep });
  const library = {
    loader,
    failures: () => failures,
  };

  const chartLibrary = (): Promise<ChartLibrary> => {
    charts ??= loadChartLibrary().catch((error: unknown) => {
      charts = null;
      throw error;
    });
    return charts;
  };

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

  async function handle(request: AnalyseRequest | HandRequest): Promise<void> {
    const { jobId } = request;
    try {
      const set = await chartLibrary();
      if (request.type === "hand") {
        // The hand view reads the engine's record of a hand not stored yet.
        const prepared = await preparePage([request.hand], set, request.library ? library : null);
        const hand = prepared.hands[0];
        if (!hand) throw new Error("no hand");
        const analysis = analyzeHand(hand.phf, { charts: set, flopLibrary: prepared.loader, villains: request.villains });
        scope.postMessage({ type: "hand", jobId, analysis });
        return;
      }
      let last = clock();
      const result = await analysePage(request.page, set, request.library ? library : null, request.villains, (done) => {
        const now = clock();
        if (now - last >= PROGRESS_MS) {
          last = now;
          scope.postMessage({ type: "progress", jobId, done });
        }
      });
      scope.postMessage({ type: "analysed", jobId, ...result });
    } catch (error) {
      scope.postMessage({ type: "error", jobId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { fetch: fetcher, failures: () => failures };
}
