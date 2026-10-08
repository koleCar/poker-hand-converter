/**
 * The trainer's worker, from the page's side (phase A7).
 *
 * One worker per page load, asked by job id like the analysis' hand-view
 * worker (`lib/db/analysis.ts`). When a worker cannot be made (a strict CSP,
 * an embedded webview) the same jobs run on the main thread — slower and
 * janky on a river, but a trainer that never deals would be worse.
 */

import { flopLibraryBase, FLOP_LIBRARY_ENABLED, FlopLibraryLoader } from "./analysis/flopLibrary";
import { ensureChartSets } from "./charts";
import { preflopCharts } from "./chartSet";
import { SUPABASE_URL } from "./supabase/config";
import type {
  FlopSpotOptions,
  GradedAnswer,
  PreflopSpotOptions,
  RiverSpotOptions,
  SplitItem,
  SplitOptions,
  TrainerSpot,
  TrainingRequest,
  TrainingResponse,
  TurnSpotOptions,
} from "./training";

let worker: Worker | null | undefined;
let sequence = 0;

/**
 * Whether the Learn flop drills can run here (L2): the flag is on and a
 * Supabase URL names the public bucket the library's chunks are fetched from.
 */
export const FLOP_DRILLS_AVAILABLE = FLOP_LIBRARY_ENABLED && flopLibraryBase(SUPABASE_URL) !== null;

/** The main-thread fallback's own flop library loader (the worker keeps its own). */
let mainLoader: FlopLibraryLoader | null | undefined;

function newWorker(): Worker | null {
  try {
    return new Worker(new URL("../workers/training.worker.ts", import.meta.url), { type: "module", name: "rail-trainer" });
  } catch {
    return null;
  }
}

async function ask(request: TrainingRequest): Promise<TrainingResponse> {
  if (worker === undefined) worker = typeof Worker === "undefined" ? null : newWorker();
  if (!worker) {
    // Yield first so a "dealing…" line can paint.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { prepareFlopLibrary, runTrainingJob, trainingChartSets } = await import("./training/jobs");
    const library = await preflopCharts();
    await ensureChartSets(library, trainingChartSets(request));
    if (mainLoader === undefined) {
      const base = flopLibraryBase(SUPABASE_URL);
      mainLoader = FLOP_LIBRARY_ENABLED && base ? new FlopLibraryLoader(base, (url) => fetch(url)) : null;
    }
    const flop = await prepareFlopLibrary(request, library, mainLoader);
    return runTrainingJob(request, library, flop);
  }
  const live = worker;
  return new Promise<TrainingResponse>((resolve) => {
    const onMessage = (event: MessageEvent<TrainingResponse>) => {
      if (event.data.jobId !== request.jobId) return;
      live.removeEventListener("message", onMessage);
      resolve(event.data);
    };
    live.addEventListener("message", onMessage);
    live.postMessage(request);
  });
}

function unwrap<T>(response: TrainingResponse, pick: (r: TrainingResponse) => T | undefined): T {
  if (response.type === "error") throw new Error(response.message);
  const value = pick(response);
  if (value === undefined) throw new Error(`unexpected ${response.type} from the trainer`);
  return value;
}

/** A preflop spot for `seed`, or null when none matches the options. */
export async function dealPreflopSpot(options: PreflopSpotOptions, seed: number): Promise<TrainerSpot | null> {
  sequence += 1;
  const response = await ask({ type: "preflop", jobId: sequence, options, seed });
  return unwrap(response, (r) => (r.type === "spot" ? r.spot : undefined));
}

/** A river spot for `seed`, or null when the generator found none. */
export async function dealRiverSpot(options: RiverSpotOptions, seed: number): Promise<TrainerSpot | null> {
  sequence += 1;
  const response = await ask({ type: "river", jobId: sequence, options, seed });
  return unwrap(response, (r) => (r.type === "spot" ? r.spot : undefined));
}

/** A turn spot for `seed` (Learn L1), or null when the generator found none. Solves a turn: about a second. */
export async function dealTurnSpot(options: TurnSpotOptions, seed: number): Promise<TrainerSpot | null> {
  sequence += 1;
  const response = await ask({ type: "turn", jobId: sequence, options, seed });
  return unwrap(response, (r) => (r.type === "spot" ? r.spot : undefined));
}

/** A flop spot for `seed` from Rail's flop library (Learn L2), or null when the library holds none for the options. */
export async function dealFlopSpot(options: FlopSpotOptions, seed: number): Promise<TrainerSpot | null> {
  sequence += 1;
  const response = await ask({ type: "flop", jobId: sequence, options, seed });
  return unwrap(response, (r) => (r.type === "spot" ? r.spot : undefined));
}

/** A range-split item for `seed` (Learn L2): a flop from the library, or a turn solved on demand. */
export async function dealSplit(options: SplitOptions, seed: number): Promise<SplitItem | null> {
  sequence += 1;
  const response = await ask({ type: "split", jobId: sequence, options, seed });
  return unwrap(response, (r) => (r.type === "split" ? r.item : undefined));
}

/** The answer graded by the analysis, with the hand it was graded on. */
export async function gradeSpotAnswer(spot: TrainerSpot, menuIndex: number): Promise<GradedAnswer> {
  sequence += 1;
  const response = await ask({ type: "answer", jobId: sequence, spot, menuIndex });
  return unwrap(response, (r) =>
    r.type === "graded" ? { hand: r.hand, actionIndex: r.actionIndex, decision: r.decision } : undefined,
  );
}
