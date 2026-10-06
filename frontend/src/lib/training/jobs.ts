/**
 * The trainer's jobs as messages: what the trainer worker
 * (`workers/training.worker.ts`) is asked and answers, and the function that
 * does the work — shared with the main-thread fallback for a browser that
 * cannot start a worker.
 *
 * - `preflop`: deal a preflop spot from a seed (`dealPreflop`);
 * - `river`: generate a river spot from a seed (`generateRiverSpot`);
 * - `turn`: generate a turn spot from a seed (`generateTurnSpot`, Learn L1);
 * - `answer`: the spot's hand with the answer appended, graded by the
 *   analysis (`gradeAnswer`; a turn spot with the turn solve on).
 */

import type { DecisionAnalysis } from "../analysis";
import type { ChartSet } from "../charts";
import type { PhfHand } from "../phf/types";
import { gradeAnswer } from "./grade";
import { dealPreflop, preflopAnswer, type PreflopSpotOptions, type PreflopTrainerSpot } from "./preflop";
import { generateRiverSpot, riverAnswer, type RiverSpotOptions, type RiverTrainerSpot } from "./river";
import { generateTurnSpot, turnAnswer, type TurnSpotOptions, type TurnTrainerSpot } from "./turn";

export type TrainerSpot = PreflopTrainerSpot | RiverTrainerSpot | TurnTrainerSpot;

export type TrainingRequest =
  | { type: "preflop"; jobId: number; options: PreflopSpotOptions; seed: number }
  | { type: "river"; jobId: number; options: RiverSpotOptions; seed: number }
  | { type: "turn"; jobId: number; options: TurnSpotOptions; seed: number }
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

/** The spot's hand with the answer appended, whatever the street. */
export function answerHand(spot: TrainerSpot, menuIndex: number): { hand: PhfHand; actionIndex: number } {
  if (spot.kind === "preflop") return preflopAnswer(spot, menuIndex);
  if (spot.kind === "turn") return turnAnswer(spot, menuIndex);
  return riverAnswer(spot, menuIndex);
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
  if (request.type === "turn") {
    return { type: "spot", jobId, spot: generateTurnSpot(charts, request.options, request.seed) };
  }
  const answer = answerHand(request.spot, request.menuIndex);
  const decision = gradeAnswer(answer.hand, answer.actionIndex, charts, { turn: request.spot.kind === "turn" });
  return { type: "graded", jobId, hand: answer.hand, actionIndex: answer.actionIndex, decision };
}
