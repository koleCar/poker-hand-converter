/**
 * The leak finder's top three (`docs/RAIL-PLAN.md` R5.2): the three most
 * important leaks of a sample, each with how sure we are of it, whether it is
 * moving, and a handful of example hands.
 *
 * Built on the leak finder (`leaks.ts`, A6) and changing none of it: the leaks
 * are `groupLeaks`' rows - the same ids, the same merging, the same numbers the
 * full report at `/analysis/leaks` lists - so "#1 here" is a row there.
 *
 * - **Importance** is the EV a leak costs in total: how often the spot comes
 *   up x how often it goes wrong there x what a mistake costs, which is the
 *   leak's `evLossBb` (summed per decision by the database). Within one sample
 *   every leak divides by the same graded hands, so the order is also the
 *   order of EV lost per 100 hands - the figure shown.
 * - **The sample must vouch for it.** A leak of medium or high confidence
 *   (A6's rule: 20 decisions in the spot and 2 mistakes, or 50 and 5) ranks
 *   before any low-confidence one, however costly: one blunder in a spot met
 *   three times is a hand to look at, not a leak. Only when fewer than three
 *   confident leaks exist are the places filled with low-confidence leaks of
 *   at least {@link TOP_MIN_MISTAKES} mistakes, marked tentative - the study
 *   plan's rule (A8b `pickFocus`), so the top three and the week's plan do not
 *   contradict each other. A leak of one mistake never makes the list.
 * - **Ties** (equal EV lost) go to the bigger sample (more decisions in the
 *   spot), then to more mistakes, then to the id, so the order is stable.
 * - **Uncertainty**: the mistake rate in the spot with its 95% Wilson
 *   interval, and EV lost per 100 hands over the same interval (the rate's
 *   bounds at the leak's own cost per mistake): the part of the figure the
 *   sample is unsure about.
 * - **Was / now**: the mistake rate in the leak's spots over the last 30 days
 *   of play against the 30 before, A6's comparison (two-proportion z,
 *   `trendOf`'s words, "too few" under {@link MIN_COMPARE_SPOT} decisions in
 *   either period).
 * - **Example hands**: up to {@link EXAMPLES_MAX} decisions behind the leak,
 *   one per hand, the costliest of each finer spot it merges first (so a
 *   merged leak shows its spread), then the costliest of the rest.
 *
 * Same import rule as the rest of `lib/analysis`: no framework, no database.
 * The words live in `ns/analysisLeaks.*.ts` (`topLeaks`).
 */

import {
  MIN_COMPARE_SPOT,
  rateZ,
  situationKey,
  spotAttrs,
  trendOf,
  type Leak,
  type SpotRow,
  type Trend,
} from "./leaks";

/* ------------------------------------------------------------ constants - */

/** How many leaks the top list names. */
export const TOP_LEAKS = 3;
/**
 * A low-confidence leak fills a place only with this many mistakes (the study
 * plan's `TENTATIVE_MIN_MISTAKES`; a test holds the two equal).
 */
export const TOP_MIN_MISTAKES = 2;
/** Example hands per leak: at most this many ... */
export const EXAMPLES_MAX = 5;
/** ... asked of the server per leak, so the spread across finer spots has some to choose from. */
export const EXAMPLES_FETCH = 15;
/** The period a "last N days" view and the was / now comparison use, in days of play. */
export const TOP_PERIOD_DAYS = 30;
/** z for a two-sided 95% interval. */
const Z95 = 1.959964;

/* ---------------------------------------------------------------- ranking - */

export interface RankedLeak {
  leak: Leak;
  /** 1-based place in the top list. */
  rank: number;
  /** Low confidence: listed only because fewer confident leaks exist. */
  tentative: boolean;
}

/** The order of importance: EV lost, then the bigger sample, then more mistakes, then the id. */
export function compareImportance(a: Leak, b: Leak): number {
  return (
    b.evLossBb - a.evLossBb ||
    b.spotDecisions - a.spotDecisions ||
    b.mistakes - a.mistakes ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Whether a leak can be in the top list at all (confident, or thin with enough mistakes). */
export function topEligible(leak: Leak): boolean {
  return leak.confidence !== "low" || leak.mistakes >= TOP_MIN_MISTAKES;
}

/**
 * The top `count` leaks: the costliest confident ones (medium or high), then -
 * only if fewer than `count` - the costliest low-confidence ones with at least
 * {@link TOP_MIN_MISTAKES} mistakes, marked tentative.
 */
export function rankTopLeaks(leaks: readonly Leak[], count = TOP_LEAKS): RankedLeak[] {
  const ordered = [...leaks].sort(compareImportance);
  const sure = ordered.filter((leak) => leak.confidence !== "low").slice(0, count);
  const thin = ordered
    .filter((leak) => leak.confidence === "low" && leak.mistakes >= TOP_MIN_MISTAKES)
    .slice(0, Math.max(0, count - sure.length));
  return [
    ...sure.map((leak) => ({ leak, tentative: false })),
    ...thin.map((leak) => ({ leak, tentative: true })),
  ].map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/* ----------------------------------------------------------- uncertainty - */

export interface Interval {
  low: number;
  high: number;
}

/** The 95% Wilson interval of `made` out of `n`; null for an empty sample. */
export function wilson(made: number, n: number, z = Z95): Interval | null {
  if (!(n > 0)) return null;
  const p = Math.min(1, Math.max(0, made / n));
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface LeakSize {
  /** Mistakes per decision in the spot. */
  rate: number;
  rateInterval: Interval;
  /** EV lost per 100 graded hands. */
  per100: number;
  /** `per100` at the rate interval's bounds (the cost per mistake held). */
  per100Interval: Interval;
}

/** How big a leak is and how sure the sample is of it. Null when it has no spot decisions. */
export function leakSize(leak: Leak): LeakSize | null {
  const interval = wilson(leak.mistakes, leak.spotDecisions);
  if (!interval) return null;
  const rate = leak.mistakes / leak.spotDecisions;
  const scale = (bound: number) => (rate > 0 ? round((leak.per100 * bound) / rate, 3) : 0);
  return {
    rate,
    rateInterval: interval,
    per100: leak.per100,
    per100Interval: { low: scale(interval.low), high: scale(interval.high) },
  };
}

/* ------------------------------------------------------------- was / now - */

export interface LeakPeriod {
  /** Graded decisions in the leak's spots. */
  spot: number;
  /** Graded worse than Perfect, on the leak's own wrong turn. */
  mistakes: number;
  evLossBb: number;
  rate: number | null;
}

/** One period's numbers for a leak: its keys' mistakes and EV, its situations' decisions. */
export function leakPeriod(leak: Pick<Leak, "keys" | "situationKeys">, rows: readonly SpotRow[]): LeakPeriod {
  const keys = new Set(leak.keys);
  const situations = new Set(leak.situationKeys);
  let spot = 0;
  let mistakes = 0;
  let ev = 0;
  for (const row of rows) {
    if (keys.has(row.key)) {
      mistakes += row.nonPerfect;
      ev += row.evLossBb;
    }
    if (situations.has(situationKey(spotAttrs(row)))) spot += row.decisions;
  }
  return { spot, mistakes, evLossBb: round(ev, 3), rate: spot > 0 ? mistakes / spot : null };
}

export interface LeakTrend {
  /** The 30 days of play before `now`. */
  was: LeakPeriod;
  /** The last 30 days of play. */
  now: LeakPeriod;
  z: number | null;
  trend: Trend;
}

/** Was / now for a leak: the mistake rate in its spots, A6's two-proportion comparison and words. */
export function leakTrend(
  leak: Pick<Leak, "keys" | "situationKeys">,
  now: readonly SpotRow[],
  was: readonly SpotRow[],
  minSpot = MIN_COMPARE_SPOT,
): LeakTrend {
  const a = leakPeriod(leak, now);
  const b = leakPeriod(leak, was);
  const z = rateZ(a.mistakes, a.spot, b.mistakes, b.spot);
  return { was: b, now: a, z, trend: trendOf(z, a.spot >= minSpot && b.spot >= minSpot) };
}

/* -------------------------------------------------------- example hands - */

/** What example selection needs of one decision behind a leak (`analysis_leak_hands`' rows). */
export interface ExampleCandidate {
  handId: string;
  ord: number;
  playedAt: string | null;
  scenario: string;
  line: string;
  position: string | null;
  evLossBb: number | null;
}

/** The finer spot a decision is in, inside a merged leak. */
const finerSpot = (row: ExampleCandidate) => `${row.scenario}|${row.line}|${row.position ?? ""}`;

/** Costliest first; equal costs, the newer hand, then by id and decision. */
function compareExamples(a: ExampleCandidate, b: ExampleCandidate): number {
  return (
    (b.evLossBb ?? 0) - (a.evLossBb ?? 0) ||
    (b.playedAt ?? "").localeCompare(a.playedAt ?? "") ||
    a.handId.localeCompare(b.handId) ||
    a.ord - b.ord
  );
}

/**
 * Up to `max` example decisions for a leak: one per hand (its costliest),
 * first the costliest of each finer spot the leak merges (costliest spot
 * first), then the costliest of the rest. A leak of one spot gets its
 * costliest hands.
 */
export function pickExamples<T extends ExampleCandidate>(candidates: readonly T[], max = EXAMPLES_MAX): T[] {
  const perHand = new Map<string, T>();
  for (const row of [...candidates].sort(compareExamples)) {
    if (!perHand.has(row.handId)) perHand.set(row.handId, row);
  }
  const ordered = [...perHand.values()];
  const picked: T[] = [];
  const spots = new Set<string>();
  for (const row of ordered) {
    if (picked.length >= max) break;
    const spot = finerSpot(row);
    if (spots.has(spot)) continue;
    spots.add(spot);
    picked.push(row);
  }
  for (const row of ordered) {
    if (picked.length >= max) break;
    if (!picked.includes(row)) picked.push(row);
  }
  return picked.sort(compareExamples);
}

/* -------------------------------------------------------------- periods - */

export const TOP_PERIODS = ["30d", "all"] as const;
export type TopPeriod = (typeof TOP_PERIODS)[number];

export function parseTopPeriod(value: unknown): TopPeriod | null {
  return typeof value === "string" && (TOP_PERIODS as readonly string[]).includes(value) ? (value as TopPeriod) : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
