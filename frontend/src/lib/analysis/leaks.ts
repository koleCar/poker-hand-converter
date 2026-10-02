/**
 * Leaks and progress (`docs/ANALYSIS-PLAN.md` §0.1 *Stats*, §2, §6.0 *Leaks*,
 * phase A6): which spots cost the most EV, and whether that is changing.
 *
 * The database sums graded decisions per **finest spot** — street, scenario,
 * chart line, seat, the action taken and the reference's best action
 * (`analysis_leaks`, `20270201090000_analysis_leaks.sql`). Everything that
 * decides what a *leak* is lives here, pure and deterministic:
 *
 * - **Spot attributes.** A finest row becomes (street, scenario, scenario
 *   family, hero seat, villain seat, taken, best). Preflop chart grades take
 *   both seats from the chart line — the hero is the node's actor, the villain
 *   the line's last aggressor (the opener, the 3-bettor, the 4-bettor) — so a
 *   short-handed hand graded at the 6-max node is grouped with that node, the
 *   way the reference saw it. Postflop the seat is the decision's own and the
 *   role (raiser or caller, in or out of position, facing what) is the
 *   scenario.
 * - **A leak** is a situation plus a wrong turn in it: (situation, taken,
 *   best) with taken ≠ best, or taken = best at the wrong size (a sizing leak).
 *   Its **frequency** is how often the player was in the situation at all
 *   (every graded decision there, right or wrong), not how often they erred.
 * - **Sparse spots merge up a level.** Five levels, finest first:
 *   `(scenario, hero, villain)` → `(scenario, hero)` → `(scenario)` →
 *   `(family)` → `(street)`, always with the same taken/best. A group whose
 *   situations add up to fewer than {@link MIN_SPOT_SAMPLE} decisions is
 *   lifted, whole, to the next level, where it merges with the other lifted
 *   groups that share the coarser key (never with a sibling that was big enough
 *   to stand on its own). What is still thin at the top stays, marked low
 *   confidence. So "BB vs UTG open" with 4 hands and "BB vs HJ open" with 6
 *   become one "BB vs an open (other seats)" leak, while "BB vs BTN open" with
 *   60 keeps its own row.
 * - **Ranking**: total EV lost (bb) by default — within one filter set that is
 *   also the order of EV lost per 100 hands, the same denominator divides
 *   every row — or EV lost per time in the spot (how badly the spot is played),
 *   or the number of mistakes.
 * - **Confidence** is the sample: the situation's decisions and the mistakes
 *   seen there ({@link confidenceOf}).
 * - **Two periods** are compared on the union's leaks (so a leak keeps its
 *   identity when one period is thin) by mistake rate in the situation — a
 *   two-proportion z-test — and streets and the whole sample by mean move
 *   score (Welch's z from the sums of scores and squares). The wording tiers
 *   follow |z| (≥ 1.96 "better/worse", ≥ 1 "leaning", else "steady"), and a
 *   period under the minimum sample says "too few" instead of guessing.
 *
 * Same import rule as the rest of `lib/analysis`: no framework, no database.
 * The words live in `ns/analysisLeaks.*.ts`.
 */

import { walkLine } from "./reports";

/* ------------------------------------------------------------ constants - */

/** A situation with fewer graded decisions than this merges into its parent. */
export const MIN_SPOT_SAMPLE = 10;
/** A leak worth less than this in total (bb) is not listed: it is rounding, not a leak. */
export const MIN_LEAK_EV_BB = 0.05;
/** Below this many graded moves in either period, a street or overall comparison is "too few". */
export const MIN_COMPARE_MOVES = 20;
/** Below this many decisions in the situation in either period, a leak comparison is "too few". */
export const MIN_COMPARE_SPOT = 10;
/** |z| at or above this: a change the sample can see (two-sided 95%). */
export const Z_CLEAR = 1.959964;
/** |z| at or above this, below {@link Z_CLEAR}: "leaning", worded as possibly noise. */
export const Z_LEANING = 1;

export const LEAK_STREETS = ["preflop", "flop", "turn", "river"] as const;
export type LeakStreet = (typeof LEAK_STREETS)[number];
export const LEAK_ACTIONS = ["fold", "check", "call", "bet", "raise"] as const;
export type LeakAction = (typeof LEAK_ACTIONS)[number];

/** Grouping levels, finest first. */
export const LEAK_LEVELS = ["villain", "seat", "scenario", "family", "street"] as const;
export type LeakLevel = (typeof LEAK_LEVELS)[number];

/** Marks a part that is genuinely absent (no villain in an unopened pot). */
export const NONE = "-";
/** Marks a part that merging dropped ("any seat"). */
export const ANY = "*";

/* ---------------------------------------------------------------- input - */

/** One finest spot, as `analysis_leaks` returns it. */
export interface SpotRow {
  key: string;
  street: string;
  scenario: string;
  /** Chart line for chart grades, empty otherwise. */
  line: string;
  /** The decision's seat. */
  position: string;
  taken: string;
  best: string;
  decisions: number;
  hands: number;
  /** Graded worse than Perfect. */
  nonPerfect: number;
  /** Inaccurate or worse. */
  mistakes: number;
  evLossBb: number;
  evLossPot: number;
  scoreSum: number;
  scoreSq: number;
}

/* ------------------------------------------------------------ attributes - */

export interface SpotAttrs {
  street: string;
  scenario: string;
  family: string;
  hero: string;
  villain: string;
  taken: string;
  best: string;
}

/**
 * The family a scenario belongs to, the level between a scenario and the
 * whole street. Preflop: first in, facing one raise, facing a re-raise.
 * Postflop: what the hero was facing (`first`, `vs-bet`, `vs-raise`), the role
 * dropped.
 */
export function scenarioFamily(street: string, scenario: string): string {
  if (street === "preflop") {
    if (scenario === "unopened" || scenario === "bb-option" || scenario === "vs-limp") return "first-in";
    if (scenario === "vs-open" || scenario === "squeeze") return "vs-raise";
    if (scenario === "vs-3bet" || scenario === "vs-3bet-cold" || scenario === "vs-4bet") return "vs-reraise";
    return scenario;
  }
  const facing = /-(first|vs-bet|vs-raise)$/.exec(scenario);
  return facing ? facing[1] : scenario;
}

/** The line's last raiser, or null when nobody has raised. */
function lastAggressor(line: string): string | null {
  const steps = walkLine(line).steps;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].code === "r" || steps[index].code === "a") return steps[index].position;
  }
  return null;
}

/** A finest row's attributes (see the header for where each comes from). */
export function spotAttrs(row: SpotRow): SpotAttrs {
  let hero = row.position || NONE;
  let villain = NONE;
  // A chart grade carries its line; the UTG open's line is empty, and is still a chart node.
  if (row.street === "preflop" && (row.line !== "" || row.scenario === "unopened")) {
    const walked = walkLine(row.line);
    if (walked.next) hero = walked.next;
    villain = lastAggressor(row.line) ?? NONE;
  }
  return {
    street: row.street,
    scenario: row.scenario,
    family: scenarioFamily(row.street, row.scenario),
    hero,
    villain,
    taken: row.taken,
    best: row.best,
  };
}

/** The attributes as seen at a level: the parts that level drops become {@link ANY}. */
export function atLevel(attrs: SpotAttrs, level: number): SpotAttrs {
  return {
    street: attrs.street,
    scenario: level >= 3 ? ANY : attrs.scenario,
    family: level >= 4 ? ANY : attrs.family,
    hero: level >= 2 ? ANY : attrs.hero,
    villain: level >= 1 ? ANY : attrs.villain,
    taken: attrs.taken,
    best: attrs.best,
  };
}

/** A situation: the attributes without what was done there. */
export const situationKey = (a: SpotAttrs) => [a.street, a.scenario, a.family, a.hero, a.villain].join("~");
/** A leak's id: stable across reloads and filters, safe in a URL. */
export const leakId = (a: SpotAttrs) => [a.street, a.scenario, a.family, a.hero, a.villain, a.taken, a.best].join("~");

/** The parts of a leak id, or null for anything that is not one. */
export function parseLeakId(id: string): SpotAttrs | null {
  const parts = id.split("~");
  if (parts.length !== 7 || parts.some((part) => !/^[A-Za-z0-9+*-]{1,40}$/.test(part))) return null;
  const [street, scenario, family, hero, villain, taken, best] = parts;
  return { street, scenario, family, hero, villain, taken, best };
}

/** A row is part of some leak when its move was not the reference's, or was at the wrong size. */
export function isLeakRow(row: SpotRow): boolean {
  if (!row.best) return false;
  return row.taken !== row.best || row.nonPerfect > 0;
}

/* ----------------------------------------------------------------- leaks - */

export type Confidence = "low" | "medium" | "high";

/**
 * How far a leak's numbers can be trusted: the situation's sample and the
 * mistakes seen. High needs 50 decisions and 5 mistakes, medium 20 and 2.
 */
export function confidenceOf(spotDecisions: number, mistakes: number): Confidence {
  if (spotDecisions >= 50 && mistakes >= 5) return "high";
  if (spotDecisions >= 20 && mistakes >= 2) return "medium";
  return "low";
}

export interface Mix {
  fold: number;
  check: number;
  call: number;
  bet: number;
  raise: number;
}

const emptyMix = (): Mix => ({ fold: 0, check: 0, call: 0, bet: 0, raise: 0 });
const addTo = (mix: Mix, action: string, n: number) => {
  if ((LEAK_ACTIONS as readonly string[]).includes(action)) mix[action as LeakAction] += n;
};

export interface Leak {
  id: string;
  attrs: SpotAttrs;
  /** Index into {@link LEAK_LEVELS}: how far it was merged up. */
  level: number;
  /**
   * Merged, while a sibling spot under the same coarser key was big enough to
   * keep its own row: this leak is "the other seats", not all of them.
   */
  partial: boolean;
  /** Finest spot keys whose decisions this leak is made of (for `analysis_leak_hands`). */
  keys: string[];
  /** Finest situations it covers (more than one: merged), as {@link situationKey}s. */
  situationKeys: string[];
  /** Decisions that took this wrong turn. */
  decisions: number;
  /** ... of which graded worse than Perfect. */
  mistakes: number;
  /** ... of which Inaccurate or worse. */
  serious: number;
  evLossBb: number;
  evLossPot: number;
  /** Graded decisions in the situations this leak covers, whatever was done: how often the spot came up. */
  spotDecisions: number;
  /** In those situations: what the player did, and what the reference's best move was, per decision. */
  taken: Mix;
  best: Mix;
  /** EV lost per 100 graded hands in the sample. */
  per100: number;
  /** EV lost per time in the spot. */
  perSpot: number;
  /** EV lost per mistake (worse than Perfect). */
  perMistake: number;
  confidence: Confidence;
}

export const LEAK_SORTS = ["ev", "per-spot", "mistakes"] as const;
export type LeakSort = (typeof LEAK_SORTS)[number];

export interface GroupOptions {
  /** Graded hands in the sample: the "per 100 hands" denominator. */
  hands: number;
  minSample?: number;
  minEv?: number;
}

interface Built {
  attrs: SpotAttrs;
  /** Finest situation key per member row. */
  rows: Array<{ row: SpotRow; finest: SpotAttrs }>;
}

/**
 * The leaks in a sample, merged where thin, ranked by total EV lost.
 * Deterministic: equal inputs in any order give equal output.
 */
export function groupLeaks(input: readonly SpotRow[], options: GroupOptions): Leak[] {
  const minSample = options.minSample ?? MIN_SPOT_SAMPLE;
  const minEv = options.minEv ?? MIN_LEAK_EV_BB;
  const rows = [...input].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Every graded decision counts towards its situation's frequency, per finest situation.
  const finestAttrs = new Map<SpotRow, SpotAttrs>();
  const situationTotal = new Map<string, number>();
  const situationRows = new Map<string, SpotRow[]>();
  for (const row of rows) {
    const attrs = spotAttrs(row);
    finestAttrs.set(row, attrs);
    const key = situationKey(attrs);
    situationTotal.set(key, (situationTotal.get(key) ?? 0) + row.decisions);
    const list = situationRows.get(key);
    if (list) list.push(row);
    else situationRows.set(key, [row]);
  }

  const sampleOf = (group: Built) => {
    const seen = new Set<string>();
    let total = 0;
    for (const { finest } of group.rows) {
      const key = situationKey(finest);
      if (seen.has(key)) continue;
      seen.add(key);
      total += situationTotal.get(key) ?? 0;
    }
    return total;
  };

  // Level 0: the leak rows, by their finest key.
  let pending = new Map<string, Built>();
  for (const row of rows) {
    if (!isLeakRow(row)) continue;
    const finest = finestAttrs.get(row)!;
    const attrs = atLevel(finest, 0);
    const id = leakId(attrs);
    const group = pending.get(id);
    if (group) group.rows.push({ row, finest });
    else pending.set(id, { attrs, rows: [{ row, finest }] });
  }

  const settled: Array<{ group: Built; level: number }> = [];
  for (let level = 0; level < LEAK_LEVELS.length; level += 1) {
    const lifted = new Map<string, Built>();
    for (const group of pending.values()) {
      const last = level === LEAK_LEVELS.length - 1;
      if (last || sampleOf(group) >= minSample) {
        settled.push({ group, level });
        continue;
      }
      for (const member of group.rows) {
        const attrs = atLevel(member.finest, level + 1);
        const id = leakId(attrs);
        const target = lifted.get(id);
        if (target) target.rows.push(member);
        else lifted.set(id, { attrs, rows: [member] });
      }
    }
    pending = lifted;
    if (pending.size === 0) break;
  }

  // A merged group is partial when a finer group settled under the same coarser key.
  const finerAt = (level: number) =>
    new Set(settled.filter((entry) => entry.level < level).map((entry) => leakId(atLevel(entry.group.attrs, level))));
  const finerCache = new Map<number, Set<string>>();

  const leaks: Leak[] = [];
  for (const { group, level } of settled) {
    let decisions = 0;
    let mistakes = 0;
    let serious = 0;
    let evLossBb = 0;
    let evLossPot = 0;
    const keys: string[] = [];
    const situations = new Set<string>();
    for (const { row, finest } of group.rows) {
      decisions += row.decisions;
      mistakes += row.nonPerfect;
      serious += row.mistakes;
      evLossBb += row.evLossBb;
      evLossPot += row.evLossPot;
      keys.push(row.key);
      situations.add(situationKey(finest));
    }
    if (mistakes === 0 || evLossBb < minEv) continue;
    const taken = emptyMix();
    const best = emptyMix();
    let spotDecisions = 0;
    for (const key of [...situations].sort()) {
      spotDecisions += situationTotal.get(key) ?? 0;
      for (const row of situationRows.get(key) ?? []) {
        addTo(taken, row.taken, row.decisions);
        addTo(best, row.best, row.decisions);
      }
    }
    if (level > 0 && !finerCache.has(level)) finerCache.set(level, finerAt(level));
    leaks.push({
      id: leakId(group.attrs),
      attrs: group.attrs,
      level,
      partial: level > 0 && (finerCache.get(level)?.has(leakId(group.attrs)) ?? false),
      keys: keys.sort(),
      situationKeys: [...situations].sort(),
      decisions,
      mistakes,
      serious,
      evLossBb: round(evLossBb, 3),
      evLossPot: round(evLossPot, 4),
      spotDecisions,
      taken,
      best,
      per100: options.hands > 0 ? round((evLossBb / options.hands) * 100, 3) : 0,
      perSpot: spotDecisions > 0 ? round(evLossBb / spotDecisions, 4) : 0,
      perMistake: round(evLossBb / mistakes, 4),
      confidence: confidenceOf(spotDecisions, mistakes),
    });
  }
  return sortLeaks(leaks, "ev");
}

/** Leaks in the order a sort asks for; ties fall back to EV lost, then the id. */
export function sortLeaks(leaks: readonly Leak[], sort: LeakSort): Leak[] {
  const value = (leak: Leak) => (sort === "per-spot" ? leak.perSpot : sort === "mistakes" ? leak.mistakes : leak.evLossBb);
  return [...leaks].sort((a, b) => value(b) - value(a) || b.evLossBb - a.evLossBb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The action the leak is about, as a pair the dictionary words. */
export type LeakKind =
  | "fold-too-much"
  | "call-too-wide"
  | "call-not-raise"
  | "raise-too-wide"
  | "raise-not-call"
  | "check-not-bet"
  | "bet-not-check"
  | "check-not-raise"
  | "wrong-size"
  | "fold-free-check"
  | "other";

export function leakKind(taken: string, best: string): LeakKind {
  if (taken === best) return "wrong-size";
  if (taken === "fold") return best === "check" ? "fold-free-check" : "fold-too-much";
  if (taken === "call") return best === "fold" ? "call-too-wide" : best === "raise" ? "call-not-raise" : "other";
  if (taken === "raise" || taken === "bet") {
    if (best === "fold") return "raise-too-wide";
    if (best === "call") return "raise-not-call";
    if (best === "check") return "bet-not-check";
    return "wrong-size";
  }
  if (taken === "check") return best === "bet" ? "check-not-bet" : best === "raise" ? "check-not-raise" : "other";
  return "other";
}

/**
 * The concept pages a leak can link to. Spelled out rather than imported:
 * `lib/analysis` may not import `lib/learn` (the module's import rule), and
 * `tests/test/analysisLeaks.test.ts` checks every one is a `ConceptId`.
 */
export type LeakConcept =
  | "squeeze"
  | "blind-defence"
  | "three-bet"
  | "steal"
  | "rfi"
  | "position"
  | "bluff-catching"
  | "mdf-alpha"
  | "pot-odds"
  | "bet-sizing"
  | "thin-value"
  | "continuation-bet"
  | "donk-bet"
  | "range-advantage";

/** Concept pages that explain a leak (`lib/learn/concepts.ts`), most relevant first, at most two. */
export function leakConcepts(attrs: SpotAttrs): LeakConcept[] {
  const { street, scenario, family, hero, taken, best } = attrs;
  const kind = leakKind(taken, best);
  const out: LeakConcept[] = [];
  if (street === "preflop") {
    if (scenario === "squeeze") out.push("squeeze");
    else if (scenario === "vs-open") out.push(hero === "BB" || hero === "SB" ? "blind-defence" : "three-bet");
    else if (family === "vs-reraise") out.push("three-bet");
    else if (scenario === "unopened") out.push(hero === "CO" || hero === "BTN" || hero === "SB" ? "steal" : "rfi");
    else if (family === "vs-raise") out.push("three-bet", "blind-defence");
    else out.push("rfi", "position");
  } else if (family === "vs-bet" || family === "vs-raise") {
    if (street === "river" && (kind === "fold-too-much" || kind === "call-too-wide")) out.push("bluff-catching", "mdf-alpha");
    else out.push("mdf-alpha", "pot-odds");
  } else {
    if (kind === "wrong-size") out.push("bet-sizing");
    else if (street === "river" && kind === "check-not-bet") out.push("thin-value", "bet-sizing");
    else if (street === "flop" && scenario.startsWith("pfr-")) out.push("continuation-bet");
    else if (scenario.startsWith("caller-oop") && (taken === "bet" || best === "bet")) out.push("donk-bet");
    else out.push("bet-sizing", "range-advantage");
  }
  return [...new Set(out)].slice(0, 2);
}

/* --------------------------------------------------------------- periods - */

export type Trend = "better" | "leaning-better" | "steady" | "leaning-worse" | "worse" | "too-few";

/** A z score (positive: improvement) as a trend word, honest about sample size. */
export function trendOf(z: number | null, enough: boolean): Trend {
  if (!enough || z === null || !Number.isFinite(z)) return "too-few";
  if (z >= Z_CLEAR) return "better";
  if (z >= Z_LEANING) return "leaning-better";
  if (z <= -Z_CLEAR) return "worse";
  if (z <= -Z_LEANING) return "leaning-worse";
  return "steady";
}

/**
 * Two-proportion z for a rate that should go **down** (mistakes per time in
 * a spot): positive when the current rate is lower. Pooled standard error; a
 * pooled rate of 0 or 1 has no variance and gives 0 (no evidence either way).
 */
export function rateZ(currentMade: number, currentN: number, priorMade: number, priorN: number): number | null {
  if (currentN <= 0 || priorN <= 0) return null;
  const pooled = (currentMade + priorMade) / (currentN + priorN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / currentN + 1 / priorN));
  if (se === 0) return 0;
  return (priorMade / priorN - currentMade / currentN) / se;
}

export interface ScoreSample {
  n: number;
  sum: number;
  sq: number;
}

export function meanOf(sample: ScoreSample): number | null {
  return sample.n > 0 ? sample.sum / sample.n : null;
}

/** Standard error of the mean move score, from the sums (sample variance). */
export function standardError(sample: ScoreSample): number | null {
  if (sample.n < 2) return null;
  const mean = sample.sum / sample.n;
  const variance = Math.max(0, (sample.sq - sample.n * mean * mean) / (sample.n - 1));
  return Math.sqrt(variance / sample.n);
}

/** Welch's z for a mean that should go **up** (score): positive when the current mean is higher. */
export function meanZ(current: ScoreSample, prior: ScoreSample): number | null {
  const a = meanOf(current);
  const b = meanOf(prior);
  const sa = standardError(current);
  const sb = standardError(prior);
  if (a === null || b === null || sa === null || sb === null) return null;
  const se = Math.sqrt(sa * sa + sb * sb);
  if (se === 0) return a === b ? 0 : a > b ? Infinity : -Infinity;
  return (a - b) / se;
}

export interface ScoreChange {
  /** `all` or a street. */
  key: string;
  current: ScoreSample & { mean: number | null; evLossBb: number };
  prior: ScoreSample & { mean: number | null; evLossBb: number };
  z: number | null;
  trend: Trend;
}

export interface LeakChange {
  leak: Leak;
  current: { spot: number; mistakes: number; evLossBb: number; rate: number | null };
  prior: { spot: number; mistakes: number; evLossBb: number; rate: number | null };
  z: number | null;
  trend: Trend;
}

export interface PeriodComparison {
  overall: ScoreChange;
  streets: ScoreChange[];
  leaks: LeakChange[];
  /** Leaks that got better (clearly or leaning), most improved first. */
  improved: LeakChange[];
  /** The current period's costliest leaks: what to work on. */
  focus: LeakChange[];
  currentHands: number;
  priorHands: number;
}

function scoreSample(rows: readonly SpotRow[], street: string | null) {
  let n = 0;
  let sum = 0;
  let sq = 0;
  let ev = 0;
  for (const row of rows) {
    if (street && row.street !== street) continue;
    n += row.decisions;
    sum += row.scoreSum;
    sq += row.scoreSq;
    ev += row.evLossBb;
  }
  return { n, sum, sq, mean: n > 0 ? sum / n : null, evLossBb: round(ev, 3) };
}

function scoreChange(key: string, current: readonly SpotRow[], prior: readonly SpotRow[], minMoves: number): ScoreChange {
  const street = key === "all" ? null : key;
  const a = scoreSample(current, street);
  const b = scoreSample(prior, street);
  const z = meanZ(a, b);
  return { key, current: a, prior: b, z, trend: trendOf(z, a.n >= minMoves && b.n >= minMoves) };
}

/** Sums one period's rows over a leak: its own decisions, and every decision in its situations. */
function periodStats(leak: Leak, rows: readonly SpotRow[]) {
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

export interface CompareOptions {
  currentHands: number;
  priorHands: number;
  minMoves?: number;
  minSpot?: number;
  /** How many leaks "what to work on" lists. */
  focus?: number;
}

/**
 * The current period against the prior one: overall and per street by mean
 * move score, per leak by mistake rate in its spot. The leaks are grouped on
 * both periods together, so one leak means the same spots in both.
 */
export function comparePeriods(current: readonly SpotRow[], prior: readonly SpotRow[], options: CompareOptions): PeriodComparison {
  const minMoves = options.minMoves ?? MIN_COMPARE_MOVES;
  const minSpot = options.minSpot ?? MIN_COMPARE_SPOT;
  const union = mergeRows([...current, ...prior]);
  const leaks = groupLeaks(union, { hands: options.currentHands + options.priorHands });
  const changes: LeakChange[] = leaks.map((leak) => {
    const a = periodStats(leak, current);
    const b = periodStats(leak, prior);
    const z = rateZ(a.mistakes, a.spot, b.mistakes, b.spot);
    return { leak, current: a, prior: b, z, trend: trendOf(z, a.spot >= minSpot && b.spot >= minSpot) };
  });
  const improved = changes
    .filter((change) => change.trend === "better" || change.trend === "leaning-better")
    .sort((x, y) => (y.z ?? 0) - (x.z ?? 0) || y.prior.evLossBb - x.prior.evLossBb || (x.leak.id < y.leak.id ? -1 : 1));
  const focus = changes
    .filter((change) => change.current.mistakes > 0 && change.current.evLossBb >= MIN_LEAK_EV_BB)
    .sort((x, y) => y.current.evLossBb - x.current.evLossBb || (x.leak.id < y.leak.id ? -1 : 1))
    .slice(0, options.focus ?? 3);
  return {
    overall: scoreChange("all", current, prior, minMoves),
    streets: LEAK_STREETS.map((street) => scoreChange(street, current, prior, minMoves)).filter(
      (change) => change.current.n > 0 || change.prior.n > 0,
    ),
    leaks: changes,
    improved,
    focus,
    currentHands: options.currentHands,
    priorHands: options.priorHands,
  };
}

/** Rows with equal keys summed (two periods' rows into one sample). */
export function mergeRows(rows: readonly SpotRow[]): SpotRow[] {
  const byKey = new Map<string, SpotRow>();
  for (const row of rows) {
    const seen = byKey.get(row.key);
    if (!seen) {
      byKey.set(row.key, { ...row });
      continue;
    }
    seen.decisions += row.decisions;
    seen.hands += row.hands;
    seen.nonPerfect += row.nonPerfect;
    seen.mistakes += row.mistakes;
    seen.evLossBb += row.evLossBb;
    seen.evLossPot += row.evLossPot;
    seen.scoreSum += row.scoreSum;
    seen.scoreSq += row.scoreSq;
  }
  return [...byKey.values()];
}

/**
 * The two periods a summary compares: the `days` up to the end of the day of
 * `last` (the latest graded hand — a library that stopped in February is
 * summarised as of February, and the card says so), and the `days` before.
 * ISO strings, `[from, to)`.
 */
export function periodWindows(last: string, days: number): { current: { from: string; to: string }; prior: { from: string; to: string } } {
  const day = 24 * 60 * 60 * 1000;
  const end = Math.floor(Date.parse(last) / day) * day + day;
  const iso = (time: number) => new Date(time).toISOString();
  return {
    current: { from: iso(end - days * day), to: iso(end) },
    prior: { from: iso(end - 2 * days * day), to: iso(end - days * day) },
  };
}

/* ----------------------------------------------------------------- trend - */

/** One row of `analysis_trend`. */
export interface TrendRow {
  start: string;
  end: string;
  first: string | null;
  last: string | null;
  key: string;
  bucketHands: number;
  hands: number;
  graded: number;
  nonPerfect: number;
  mistakes: number;
  evLossBb: number;
  evLossPot: number;
  scoreSum: number;
  scoreSq: number;
}

export interface TrendPoint {
  start: string;
  end: string;
  first: string | null;
  last: string | null;
  /** Graded moves in the bucket (and key). */
  graded: number;
  /** Hands the per-100 figure divides by. */
  hands: number;
  score: number | null;
  /** Half-width of a 95% interval on the mean score; null under two moves. */
  scoreMargin: number | null;
  /** EV lost per 100 hands. */
  evPer100: number | null;
  /** Share of moves graded worse than Perfect. */
  offRate: number | null;
}

export interface TrendSeries {
  key: string;
  points: TrendPoint[];
  graded: number;
}

/**
 * `analysis_trend` rows as one series per key, oldest bucket first, with the
 * means and intervals the chart draws. Per 100 hands divides by the key's own
 * hands, except by street, where a hand has decisions on several streets and
 * the bucket's graded hands are the denominator (so the streets add up to the
 * whole).
 */
export function trendSeries(rows: readonly TrendRow[], group: string): TrendSeries[] {
  const byKey = new Map<string, TrendRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }
  const out: TrendSeries[] = [];
  for (const [key, list] of byKey) {
    const points = [...list]
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      .map((row): TrendPoint => {
        const hands = group === "street" ? row.bucketHands : row.hands;
        const se = standardError({ n: row.graded, sum: row.scoreSum, sq: row.scoreSq });
        return {
          start: row.start,
          end: row.end,
          first: row.first,
          last: row.last,
          graded: row.graded,
          hands,
          score: row.graded > 0 ? round(row.scoreSum / row.graded, 2) : null,
          scoreMargin: se === null ? null : round(Z_CLEAR * se, 2),
          evPer100: hands > 0 ? round((row.evLossBb / hands) * 100, 2) : null,
          offRate: row.graded > 0 ? round(row.nonPerfect / row.graded, 4) : null,
        };
      });
    out.push({ key, points, graded: points.reduce((sum, point) => sum + point.graded, 0) });
  }
  return out.sort((a, b) => b.graded - a.graded || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
