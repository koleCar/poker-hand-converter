/**
 * Spaced repetition for mistake drills: SM-2, simplified.
 *
 * A drill is one of the player's own Mistakes or Blunders, replayed as "what
 * would you do?". Its state is four numbers: repetitions in a row answered
 * well enough (`reps`), times it was failed after that (`lapses`), how fast
 * its interval grows (`ease`), and the interval itself (`intervalDays`).
 *
 * **The answer's grade is the quality** (SM-2's 0–5): Perfect 5, Good 4,
 * Inaccurate 3, Mistake 1, Blunder 0. Inaccurate passes — the move was rare
 * but cheap — Mistake and Blunder fail.
 *
 * - **Ease** moves first, by SM-2's formula: `ease + 0.1 − (5 − q)(0.08 +
 *   (5 − q)·0.02)`, kept in `[1.3, 3.0]` and to two decimals (the database
 *   stores `numeric(4,2)`). Perfect +0.10, Good ±0, Inaccurate −0.14,
 *   Mistake −0.54, Blunder −0.80.
 * - **A pass** adds a repetition; the interval is 1 day after the first, 6
 *   after the second, then the previous interval × the new ease, rounded half
 *   up, at most a year.
 * - **A fail** resets the repetitions, counts a lapse, and brings the drill
 *   back in `RELEARN_MINUTES`: a spot you just got wrong comes back in the
 *   same session, "replayed until right".
 *
 * The database computes the same thing (`drill_next` in
 * `20270208090000_analysis_training.sql`) and is what stores it; this copy
 * is what the screen shows before the answer is saved, and the tests hold the
 * two to one table of cases.
 */

import type { Grade } from "../analysis";

export const INITIAL_EASE = 2.5;
export const MIN_EASE = 1.3;
export const MAX_EASE = 3;
/** A failed drill comes back after this many minutes. */
export const RELEARN_MINUTES = 10;
export const MAX_INTERVAL_DAYS = 365;
/** The lowest quality that passes. */
export const PASS_QUALITY = 3;

export const QUALITY: Readonly<Record<Grade, number>> = {
  perfect: 5,
  good: 4,
  inaccurate: 3,
  mistake: 1,
  blunder: 0,
};

export interface DrillState {
  reps: number;
  lapses: number;
  ease: number;
  intervalDays: number;
  /** ISO timestamp the drill is next due. */
  dueAt: string;
}

/** A drill never reviewed: due now. */
export function newDrillState(now: Date): DrillState {
  return { reps: 0, lapses: 0, ease: INITIAL_EASE, intervalDays: 0, dueAt: now.toISOString() };
}

/** The ease after an answer of quality `q`, in hundredths (an integer, so it rounds as the database does). */
function nextEaseHundredths(ease: number, q: number): number {
  const miss = 5 - q;
  // 0.1 − miss·(0.08 + miss·0.02), in hundredths: 10 − miss·(8 + 2·miss).
  const next = Math.round(ease * 100) + 10 - miss * (8 + 2 * miss);
  return Math.min(MAX_EASE * 100, Math.max(MIN_EASE * 100, next));
}

/** The state after one review. Pure; `now` is when the answer was given. */
export function nextDrillState(state: DrillState, quality: number, now: Date): DrillState {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const easeH = nextEaseHundredths(state.ease, q);
  const ease = easeH / 100;
  if (q < PASS_QUALITY) {
    return {
      reps: 0,
      lapses: state.lapses + 1,
      ease,
      intervalDays: 0,
      dueAt: new Date(now.getTime() + RELEARN_MINUTES * 60_000).toISOString(),
    };
  }
  const reps = state.reps + 1;
  let intervalDays: number;
  if (reps === 1) intervalDays = 1;
  else if (reps === 2) intervalDays = 6;
  // round(interval × ease), half up, in integers: interval × easeH / 100.
  else intervalDays = Math.floor((Math.max(1, state.intervalDays) * easeH + 50) / 100);
  intervalDays = Math.min(MAX_INTERVAL_DAYS, Math.max(1, intervalDays));
  return {
    reps,
    lapses: state.lapses,
    ease,
    intervalDays,
    dueAt: new Date(now.getTime() + intervalDays * 86_400_000).toISOString(),
  };
}

/** The state after answering with `grade`. */
export function reviewDrill(state: DrillState, grade: Grade, now: Date): DrillState {
  return nextDrillState(state, QUALITY[grade], now);
}

/** Whether a drill is due at `now`. */
export function isDue(state: Pick<DrillState, "dueAt">, now: Date): boolean {
  return new Date(state.dueAt).getTime() <= now.getTime();
}
