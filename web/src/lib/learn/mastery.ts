/**
 * Mastery from real-hand improvement (Learn L3, `docs/LEARN-PLAN.md` §4): did
 * the learner's own graded decisions in a lesson's spots get better after
 * they passed it?
 *
 * ```
 * the lesson's spots (`match.spots`, plus its own-hands exercise's)
 *   ─▶ the leak finder's rows (A6, `analysis_leaks`, invoker under RLS) for hands played
 *      before the day the lesson was passed, and from it on (`to` / `from`)
 *   ─▶ the rows that match a spot (`rowMatches`, the recommendations' matcher)
 *   ─▶ per side: graded decisions, EV lost (bb, and per decision; % of the pot per decision),
 *      decisions graded Inaccurate or worse, the mean move score
 *   ─▶ Welch's z on the mean score (the leak finder's own `meanZ` and `trendOf`): better, worse,
 *      steady, or "not enough hands yet" below `MASTERY_MIN_DECISIONS` on either side
 * ```
 *
 * Pure: the screen fetches the two reports. Nothing is stored, so there is no
 * migration: it is read again from the analysis rows each time, and changes
 * when the learner uploads more hands or re-runs the analysis.
 */

import { meanZ, trendOf, type SpotRow, type Trend } from "../analysis/leaks";
import type { LessonMeta, SpotPattern } from "./course";
import { rowMatches } from "./recommend";

/** Graded decisions needed on each side of the pass date before a change is named. */
export const MASTERY_MIN_DECISIONS = 20;

/** The spots whose decisions measure a lesson: its leak match and its own-hands exercise's spots, without repeats. */
export function lessonSpots(meta: LessonMeta): SpotPattern[] {
  const all: SpotPattern[] = [...meta.match.spots];
  for (const def of meta.exercises) if (def.kind === "own-hands" && def.spots) all.push(...def.spots);
  const seen = new Set<string>();
  return all.filter((pattern) => {
    const key = JSON.stringify(pattern);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The analysis' pot type an own-hands exercise filters by, if any (`3bet`, …): the reports are asked with it. */
export function lessonPotType(meta: LessonMeta): string | undefined {
  for (const def of meta.exercises) if (def.kind === "own-hands" && def.potType) return def.potType;
  return undefined;
}

export interface MasterySide {
  /** Graded decisions in the lesson's spots. */
  decisions: number;
  /** Total EV lost there, bb. */
  evLossBb: number;
  /** EV lost per decision, bb; null without decisions. */
  perDecisionBb: number | null;
  /** EV lost per decision as a share of the pot; null without decisions. */
  perDecisionPot: number | null;
  /** Decisions graded Inaccurate or worse. */
  mistakes: number;
  mistakeRate: number | null;
  /** Mean move score (0–100); null without decisions. */
  score: number | null;
  /** For the z: the sums. */
  sample: { n: number; sum: number; sq: number };
}

export interface Mastery {
  /** The day the lesson was passed (ISO): before is everything played earlier, after is from it on. */
  since: string;
  before: MasterySide;
  after: MasterySide;
  /** Positive when the mean score went up after passing. */
  z: number | null;
  /** `too-few` below the minimum on either side. */
  trend: Trend;
  /** Both sides have at least `MASTERY_MIN_DECISIONS`. */
  enough: boolean;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** One side's sums over the rows that match the lesson's spots. */
export function masterySide(rows: readonly SpotRow[], spots: readonly SpotPattern[]): MasterySide {
  let decisions = 0;
  let ev = 0;
  let evPot = 0;
  let mistakes = 0;
  let sum = 0;
  let sq = 0;
  for (const row of rows) {
    if (!rowMatches(spots, row)) continue;
    decisions += row.decisions;
    ev += row.evLossBb;
    evPot += row.evLossPot;
    mistakes += row.mistakes;
    sum += row.scoreSum;
    sq += row.scoreSq;
  }
  return {
    decisions,
    evLossBb: round(ev, 3),
    perDecisionBb: decisions > 0 ? round(ev / decisions, 4) : null,
    perDecisionPot: decisions > 0 ? round(evPot / decisions, 5) : null,
    mistakes,
    mistakeRate: decisions > 0 ? round(mistakes / decisions, 4) : null,
    score: decisions > 0 ? round(sum / decisions, 2) : null,
    sample: { n: decisions, sum, sq },
  };
}

/**
 * The lesson's mastery from the learner's own hands: the decisions in its
 * spots before `since` (`before`) against those from it on (`after`), by the
 * leak finder's own test on the mean move score.
 */
export function masteryFrom(meta: LessonMeta, before: readonly SpotRow[], after: readonly SpotRow[], since: string, min = MASTERY_MIN_DECISIONS): Mastery {
  const spots = lessonSpots(meta);
  const b = masterySide(before, spots);
  const a = masterySide(after, spots);
  const enough = b.decisions >= min && a.decisions >= min;
  const z = meanZ(a.sample, b.sample);
  return { since, before: b, after: a, z: z === null || !Number.isFinite(z) ? z : round(z, 3), trend: trendOf(z, enough), enough };
}

/** The day a lesson was passed, as the reports' `from` / `to` bound (midnight UTC of that day). */
export function passDay(passedAt: string): string | null {
  const t = Date.parse(passedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}
