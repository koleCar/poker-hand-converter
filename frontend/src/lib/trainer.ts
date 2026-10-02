/**
 * The trainer's worker, from the page's side (phase A7).
 *
 * One worker per page load, asked by job id like the analysis' hand-view
 * worker (`lib/db/analysis.ts`). When a worker cannot be made (a strict CSP,
 * an embedded webview) the same jobs run on the main thread — slower and
 * janky on a river, but a trainer that never deals would be worse.
 */

import { ensureChartSets } from "./charts";
import { preflopCharts } from "./chartSet";
import type {
  GradedAnswer,
  PreflopSpotOptions,
  RiverSpotOptions,
  TrainerSpot,
  TrainingRequest,
  TrainingResponse,
} from "./training";

let worker: Worker | null | undefined;
let sequence = 0;

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
    const { runTrainingJob, trainingChartSets } = await import("./training/jobs");
    const library = await preflopCharts();
    await ensureChartSets(library, trainingChartSets(request));
    return runTrainingJob(request, library);
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

/** The answer graded by the analysis, with the hand it was graded on. */
export async function gradeSpotAnswer(spot: TrainerSpot, menuIndex: number): Promise<GradedAnswer> {
  sequence += 1;
  const response = await ask({ type: "answer", jobId: sequence, spot, menuIndex });
  return unwrap(response, (r) =>
    r.type === "graded" ? { hand: r.hand, actionIndex: r.actionIndex, decision: r.decision } : undefined,
  );
}
