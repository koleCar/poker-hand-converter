/**
 * The trainer's jobs as messages: what the trainer worker
 * (`workers/training.worker.ts`) is asked and answers, and the function that
 * does the work — shared with the main-thread fallback for a browser that
 * cannot start a worker.
 *
 * - `preflop`: deal a preflop spot from a seed (`dealPreflop`);
 * - `river`: generate a river spot from a seed (`generateRiverSpot`);
 * - `turn`: generate a turn spot from a seed (`generateTurnSpot`, Learn L1);
 * - `flop`: generate a flop spot from the flop library (`generateFlopSpot`, Learn L2);
 * - `split`: a range-split item, flop (the library), turn or river (`generateSplit`, Learn L2–L3);
 * - `paint`: a range-paint item, a chart's first-in range or a river node (`generatePaint`, Learn L3);
 * - `lab`: an exploit-lab item, a river with an opponent tendency locked (`generateLab`, Learn L4);
 * - `answer`: the spot's hand with the answer appended, graded by the
 *   analysis (`gradeAnswer`; a turn spot with the turn solve on, a flop spot
 *   with the flop library).
 *
 * Flop jobs read one chunk of the library: the caller loads it first
 * (`trainingChunk` names it) and passes the library in.
 */

import type { DecisionAnalysis, FlopLibrary } from "../analysis";
import type { ChartSet } from "../charts";
import type { PhfHand } from "../phf/types";
import { flopAnswer, flopChunkFor, generateFlopSpot, type FlopSpotOptions, type FlopTrainerSpot } from "./flop";
import { gradeAnswer } from "./grade";
import { generateLab, type LabItem, type LabOptions } from "./lab";
import { generatePaint, type PaintItem, type PaintOptions } from "./paint";
import { dealPreflop, preflopAnswer, trainerSet, type PreflopSpotOptions, type PreflopTrainerSpot } from "./preflop";
import { generateRiverSpot, riverAnswer, type RiverSpotOptions, type RiverTrainerSpot } from "./river";
import { generateSplit, type SplitItem, type SplitOptions } from "./split";
import { generateTurnSpot, turnAnswer, type TurnSpotOptions, type TurnTrainerSpot } from "./turn";

export type TrainerSpot = PreflopTrainerSpot | RiverTrainerSpot | TurnTrainerSpot | FlopTrainerSpot;

export type TrainingRequest =
  | { type: "preflop"; jobId: number; options: PreflopSpotOptions; seed: number }
  | { type: "river"; jobId: number; options: RiverSpotOptions; seed: number }
  | { type: "turn"; jobId: number; options: TurnSpotOptions; seed: number }
  | { type: "flop"; jobId: number; options: FlopSpotOptions; seed: number }
  | { type: "split"; jobId: number; options: SplitOptions; seed: number }
  | { type: "paint"; jobId: number; options: PaintOptions; seed: number }
  | { type: "lab"; jobId: number; options: LabOptions; seed: number }
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
  | { type: "split"; jobId: number; item: SplitItem | null }
  | { type: "paint"; jobId: number; item: PaintItem | null }
  | { type: "lab"; jobId: number; item: LabItem | null }
  | ({ type: "graded"; jobId: number } & GradedAnswer)
  | { type: "error"; jobId: number; message: string };

/**
 * The chart sets a job needs loaded besides the library's default (A2c): the
 * set a preflop spot is dealt from, and graded against.
 */
export function trainingChartSets(request: TrainingRequest): string[] {
  if (request.type === "preflop") return request.options.set ? [request.options.set] : [];
  if (request.type === "answer" && request.spot.kind === "preflop") return [request.spot.set];
  if (request.type === "paint" && request.options.source === "chart" && request.options.set) return [request.options.set];
  return [];
}

/** Whether a job reads the flop library. */
export function needsFlopLibrary(request: TrainingRequest): boolean {
  return request.type === "flop" || (request.type === "split" && request.options.street === "flop") || (request.type === "answer" && request.spot.kind === "flop");
}

/**
 * The flop library chunk a job reads, for the caller to load before running
 * it (the set's manifest must be loaded for `has`). Null when it reads none.
 */
export function trainingChunk(request: TrainingRequest, charts: ChartSet, library: Pick<FlopLibrary, "has">): { set: string; line: string; flop: string } | null {
  if (request.type === "flop" || (request.type === "split" && request.options.street === "flop")) {
    return flopChunkFor(charts, library, request.options, request.seed);
  }
  if (request.type === "answer" && request.spot.kind === "flop") return { set: request.spot.set, line: request.spot.lineId, flop: request.spot.flop };
  return null;
}

/** What `prepareFlopLibrary` needs of a loader (`FlopLibraryLoader`). */
export interface ChunkLoader extends FlopLibrary {
  ready(set: string): Promise<boolean>;
  load(set: string, line: string, flop: string): Promise<unknown>;
}

/**
 * The flop library a job runs with, its chunk loaded: null when the job does
 * not read the library or there is none (no Supabase URL). Never throws.
 */
export async function prepareFlopLibrary(request: TrainingRequest, charts: ChartSet, loader: ChunkLoader | null): Promise<FlopLibrary | null> {
  if (!loader || !needsFlopLibrary(request)) return null;
  const set = request.type === "answer" && request.spot.kind === "flop" ? request.spot.set : charts.id;
  try {
    await loader.ready(set);
    const want = trainingChunk(request, charts, loader);
    if (want) await loader.load(want.set, want.line, want.flop);
  } catch {
    // A chunk that cannot be fetched: the job finds no spot.
  }
  return loader;
}

/** The spot's hand with the answer appended, whatever the street. */
export function answerHand(spot: TrainerSpot, menuIndex: number): { hand: PhfHand; actionIndex: number } {
  if (spot.kind === "preflop") return preflopAnswer(spot, menuIndex);
  if (spot.kind === "turn") return turnAnswer(spot, menuIndex);
  if (spot.kind === "flop") return flopAnswer(spot, menuIndex);
  return riverAnswer(spot, menuIndex);
}

/**
 * Does one job. Pure apart from the chart set it is given: a library (A2c)
 * with `trainingChartSets(request)` loaded, or one set; and, for a flop job,
 * the flop library with `trainingChunk(request)` loaded.
 */
export function runTrainingJob(request: TrainingRequest, charts: ChartSet, flopLibrary: FlopLibrary | null = null): TrainingResponse {
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
  if (request.type === "flop") {
    return { type: "spot", jobId, spot: flopLibrary ? generateFlopSpot(charts, flopLibrary, request.options, request.seed) : null };
  }
  if (request.type === "split") {
    return { type: "split", jobId, item: generateSplit(charts, flopLibrary, request.options, request.seed) };
  }
  if (request.type === "paint") {
    const options = request.options;
    const set = options.source === "chart" ? trainerSet(charts, options.set) : charts;
    return { type: "paint", jobId, item: generatePaint(set, options, request.seed) };
  }
  if (request.type === "lab") {
    return { type: "lab", jobId, item: generateLab(charts, request.options, request.seed) };
  }
  const answer = answerHand(request.spot, request.menuIndex);
  const decision = gradeAnswer(answer.hand, answer.actionIndex, charts, {
    turn: request.spot.kind === "turn",
    flopLibrary: request.spot.kind === "flop" ? flopLibrary : null,
  });
  return { type: "graded", jobId, hand: answer.hand, actionIndex: answer.actionIndex, decision };
}
