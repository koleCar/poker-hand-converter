/**
 * The trainer's jobs as messages: what the trainer worker
 * (`workers/training.worker.ts`) is asked and answers, and the function that
 * does the work — shared with the main-thread fallback for a browser that
 * cannot start a worker.
 *
 * - `preflop`: deal a preflop spot from a seed (`dealPreflop`);
 * - `river`: generate a river spot from a seed (`generateRiverSpot`);
 * - `answer`: the spot's hand with the answer appended, graded by the
 *   analysis (`gradeAnswer`).
 */

import type { DecisionAnalysis } from "../analysis";
import type { ChartSet } from "../charts";
import type { PhfHand } from "../phf/types";
import { gradeAnswer } from "./grade";
import { dealPreflop, preflopAnswer, type PreflopSpotOptions, type PreflopTrainerSpot } from "./preflop";
import { generateRiverSpot, riverAnswer, type RiverSpotOptions, type RiverTrainerSpot } from "./river";

export type TrainerSpot = PreflopTrainerSpot | RiverTrainerSpot;

export type TrainingRequest =
  | { type: "preflop"; jobId: number; options: PreflopSpotOptions; seed: number }
  | { type: "river"; jobId: number; options: RiverSpotOptions; seed: number }
  | { type: "answer"; jobId: number; spot: TrainerSpot; menuIndex: number };

export interface GradedAnswer {
  /** The spot's hand with the answer appended. */
  hand: PhfHand;
  actionIndex: number;
  /** The analysis' verdict on the answer; null when it has none (a bug, shown as such). */
  decision: DecisionAnalysis | null;
}

export type TrainingResponse =
  | { type: "spot"; jobId: number; spot: TrainerSpot | null }
  | ({ type: "graded"; jobId: number } & GradedAnswer)
  | { type: "error"; jobId: number; message: string };

/**
 * The chart sets a job needs loaded besides the library's default (A2c): the
 * set a preflop spot is dealt from, and graded against.
 */
export function trainingChartSets(request: TrainingRequest): string[] {
  if (request.type === "preflop") return request.options.set ? [request.options.set] : [];
  if (request.type === "answer" && request.spot.kind === "preflop") return [request.spot.set];
  return [];
}

/**
 * Does one job. Pure apart from the chart set it is given: a library (A2c)
 * with `trainingChartSets(request)` loaded, or one set.
 */
export function runTrainingJob(request: TrainingRequest, charts: ChartSet): TrainingResponse {
  const { jobId } = request;
  if (request.type === "preflop") {
    return { type: "spot", jobId, spot: dealPreflop(charts, request.options, request.seed) };
  }
  if (request.type === "river") {
    return { type: "spot", jobId, spot: generateRiverSpot(charts, request.options, request.seed) };
  }
  const answer =
    request.spot.kind === "preflop"
      ? preflopAnswer(request.spot, request.menuIndex)
      : riverAnswer(request.spot, request.menuIndex);
  const decision = gradeAnswer(answer.hand, answer.actionIndex, charts);
  return { type: "graded", jobId, hand: answer.hand, actionIndex: answer.actionIndex, decision };
}
