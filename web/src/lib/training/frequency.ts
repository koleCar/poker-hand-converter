/**
 * Answering with a mix (T5, the Trainer's frequency input): the player gives
 * each action a share of the time, and the answer is held against the
 * reference's own mix for the hand.
 *
 * - **Accuracy** is one minus the total variation distance between the two
 *   mixes: 100% for the reference's mix exactly, 0% for a mix that shares
 *   nothing with it.
 * - **EV lost** is the mix's expected loss against the best option:
 *   `Σ share_i · (best EV − EV_i)`, the same EV the action grades read.
 * - The **grade** is the accuracy in the five classes, so the session's
 *   counts and streaks read alike for both inputs.
 *
 * Pure.
 */

import type { Grade, OptionAnalysis } from "../analysis";

export interface MixResult {
  accuracy: number;
  evLoss: number;
  grade: Grade;
  /** 0–100, as an action answer's score. */
  score: number;
}

/** Accuracy at or above each grade's floor, best first. */
export const MIX_GRADES: ReadonlyArray<[Grade, number]> = [
  ["perfect", 0.9],
  ["good", 0.75],
  ["inaccurate", 0.55],
  ["mistake", 0.35],
  ["blunder", 0],
];

/** Shares that sum to 1 (all zero: all on the first option). */
export function normalised(shares: readonly number[]): number[] {
  const clean = shares.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return clean.map((_, i) => (i === 0 ? 1 : 0));
  return clean.map((s) => s / total);
}

export function gradeMix(shares: readonly number[], options: readonly Pick<OptionAnalysis, "freq" | "ev">[]): MixResult {
  const mix = normalised(shares.slice(0, options.length).concat(new Array(Math.max(0, options.length - shares.length)).fill(0)));
  const best = Math.max(...options.map((o) => o.ev));
  let distance = 0;
  let evLoss = 0;
  options.forEach((option, i) => {
    distance += Math.abs(mix[i] - option.freq);
    evLoss += mix[i] * (best - option.ev);
  });
  const accuracy = Math.max(0, Math.min(1, 1 - distance / 2));
  const grade = MIX_GRADES.find(([, floor]) => accuracy >= floor)?.[0] ?? "blunder";
  return { accuracy, evLoss: Math.max(0, Math.round(evLoss * 1000) / 1000), grade, score: Math.round(accuracy * 100) };
}
