/**
 * Example hands from the learner's own analysed decisions (Learn L5, the
 * `own` kind of a lesson's `examples` slot, `course.ts`).
 *
 * Never a hand from outside Rail. Among the learner's graded decisions in
 * the lesson's spots, the two most instructive:
 *
 * - **the costliest mistake**: the largest EV loss in big blinds among the
 *   decisions graded Inaccurate or worse;
 * - **a clean Perfect**: a decision graded Perfect whose move the reference
 *   plays almost always (`CLEAN_FREQ`) and is the best by EV, where the next
 *   best option gives up the most — the spot where getting it right mattered.
 *
 * Each comes with a short "why" in Rail's words, built from the grade's own
 * numbers (`exampleWhy`): the move made, the reference's move and how often
 * it plays it, and what the difference cost or would have cost. Pure: the
 * screen fetches the rows (`analysis_leak_hands`, invoker under RLS).
 */

import { GRADES, type Grade, type OptionAnalysis } from "../analysis/types";

/** A graded decision as an example needs it (the leak finder's hand rows carry exactly this). */
export interface ExampleCandidate {
  handId: string;
  actionIndex: number;
  street: string;
  position: string | null;
  heroCards: readonly string[];
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
  options: readonly OptionAnalysis[];
  chosen: number | null;
}

/** The reference must play a Perfect's move at least this often for it to be a clean example (not a mix). */
export const CLEAN_FREQ = 0.9;

const rank = (grade: string | null) => (grade ? GRADES.indexOf(grade as Grade) : -1);

/** The largest EV loss among decisions graded Inaccurate or worse, or null. */
export function costliest(rows: readonly ExampleCandidate[]): ExampleCandidate | null {
  let best: ExampleCandidate | null = null;
  for (const row of rows) {
    if (rank(row.grade) < GRADES.indexOf("inaccurate")) continue;
    if (row.evLossBb === null || !(row.evLossBb > 0) || row.chosen === null || !row.options[row.chosen]) continue;
    if (!best || row.evLossBb > (best.evLossBb ?? 0)) best = row;
  }
  return best;
}

/** How much the next best option gives up against the chosen one, bb; null when the chosen one is not the best by EV. */
export function perfectMargin(row: ExampleCandidate): number | null {
  if (row.chosen === null) return null;
  const chosen = row.options[row.chosen];
  if (!chosen) return null;
  let next = -Infinity;
  for (let i = 0; i < row.options.length; i += 1) {
    if (i === row.chosen) continue;
    if (row.options[i].ev > chosen.ev + 1e-9) return null;
    next = Math.max(next, row.options[i].ev);
  }
  return Number.isFinite(next) ? chosen.ev - next : null;
}

/** The clean Perfect whose next best option gives up the most, or null. */
export function cleanPerfect(rows: readonly ExampleCandidate[]): ExampleCandidate | null {
  let best: { row: ExampleCandidate; margin: number } | null = null;
  for (const row of rows) {
    if (row.grade !== "perfect" || row.chosen === null) continue;
    const chosen = row.options[row.chosen];
    if (!chosen || chosen.freq < CLEAN_FREQ) continue;
    const margin = perfectMargin(row);
    if (margin === null || !(margin > 0)) continue;
    if (!best || margin > best.margin) best = { row, margin };
  }
  return best?.row ?? null;
}

/** The reference's favourite option: the most played, the better EV on a tie. */
export function referenceOption(options: readonly OptionAnalysis[]): number {
  let best = 0;
  for (let i = 1; i < options.length; i += 1) {
    const a = options[i];
    const b = options[best];
    if (a.freq > b.freq + 1e-9 || (Math.abs(a.freq - b.freq) <= 1e-9 && a.ev > b.ev)) best = i;
  }
  return best;
}

/** What Rail says about an example, as numbers for the dictionary's sentence. */
export type ExampleWhy =
  | {
      kind: "mistake";
      /** The option played, and the reference's favourite. */
      taken: OptionAnalysis;
      reference: OptionAnalysis;
      lossBb: number;
      lossPot: number | null;
      grade: string;
    }
  | {
      kind: "perfect";
      taken: OptionAnalysis;
      /** The next best option by EV, and what it gives up. */
      next: OptionAnalysis;
      marginBb: number;
    };

/** The "why" of an example; null when the row lacks the numbers for one. */
export function exampleWhy(row: ExampleCandidate): ExampleWhy | null {
  if (row.chosen === null || !row.options[row.chosen]) return null;
  const taken = row.options[row.chosen];
  if (row.grade === "perfect") {
    const margin = perfectMargin(row);
    if (margin === null) return null;
    let next = -1;
    row.options.forEach((option, i) => {
      if (i !== row.chosen && (next < 0 || option.ev > row.options[next].ev)) next = i;
    });
    return next < 0 ? null : { kind: "perfect", taken, next: row.options[next], marginBb: margin };
  }
  if (row.evLossBb === null || !row.grade) return null;
  return { kind: "mistake", taken, reference: row.options[referenceOption(row.options)], lossBb: row.evLossBb, lossPot: row.evLossPot, grade: row.grade };
}
