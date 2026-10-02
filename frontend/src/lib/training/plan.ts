/**
 * The study plan (phase A8b, `docs/ANALYSIS-PLAN.md` §7): "here is what to
 * work on this week, and how", built from the leak finder (A6) and the
 * trainer (A7). Pure and deterministic; the screen is
 * `components/analysis/plan/`, the storage
 * `20270215090000_analysis_study_plan.sql` through `lib/db/studyPlan.ts`.
 *
 * ```
 * analysis_leaks rows ─▶ groupLeaks (A6) ─▶ focus areas (leaks in one situation, summed)
 *   ─▶ pickFocus: the top three by EV lost, confident ones first; a thin one only
 *      with two mistakes or more, and labelled tentative
 *   ─▶ per area: concepts (leakConcepts), a trainer target (family / seat / opener,
 *      or river role / side), drills due on its spot keys, hands to review
 *   ─▶ planTasks: the week's checklist
 * too little graded play ─▶ fundamentalsTasks: the basics instead
 * ```
 *
 * - **A focus area** is a situation — street, scenario, seats, at the level the
 *   leak finder settled it — with every wrong turn the leak finder found there:
 *   "river, as the preflop raiser out of position" with both "checking instead
 *   of betting" and "betting instead of checking". Two leaks of one spot are one
 *   thing to study, not two. Its sample is every graded decision in its
 *   situations, its mistakes the sum of its leaks', and its confidence the leak
 *   finder's rule on those ({@link confidenceOf}).
 * - **Ranking** is EV lost, which within one sample is also the order of EV lost
 *   per 100 hands (one denominator divides every area).
 * - **The rollover.** A new week builds a new plan; last week's stays as it
 *   was. A concept read last week is not asked again, a hand reviewed last
 *   week is not offered again, a hand left unreviewed carries over while its
 *   area stays in focus, and an area's `weeks` counts how long it has been
 *   in focus.
 * - **The retrospective** uses A6's period comparison: an area's mistake rate in
 *   its spot in one period against another (two-proportion z, `rateZ`), worded
 *   by `trendOf`, "too few" under {@link MIN_COMPARE_SPOT} decisions, with EV
 *   lost per 100 hands in each period beside it.
 *
 * Same import rule as the rest of `lib/training`. The words live in
 * `ns/analysisPlan.*.ts`.
 */

import {
  ANY,
  MIN_COMPARE_SPOT,
  NONE,
  confidenceOf,
  groupLeaks,
  leakConcepts,
  periodWindows,
  rateZ,
  situationKey,
  spotAttrs,
  trendOf,
  type Confidence,
  type Leak,
  type SpotRow,
  type Trend,
} from "../analysis/leaks";
import type { ChartPosition } from "../charts";
import { PREFLOP_FAMILIES, PREFLOP_SEATS, type PreflopFamily } from "./preflop";
import { RIVER_POTS, RIVER_ROLES, RIVER_SEATS, riverSeatings, type RiverPot, type RiverRole, type RiverSeat } from "./river";

/* ------------------------------------------------------------ constants - */

/** Focus areas in a week's plan. */
export const PLAN_FOCUS = 3;
/** A low-confidence area is a (tentative) focus only with this many mistakes: one bad hand is not a leak. */
export const TENTATIVE_MIN_MISTAKES = 2;
/** Fewer graded moves than this and the plan is the fundamentals. */
export const MIN_PLAN_MOVES = 50;
/** Trainer spots a week, per area: a river spot takes longer to deal and to think about. */
export const TRAIN_TARGET: Readonly<Record<"preflop" | "river", number>> = { preflop: 20, river: 10 };
/** At most this many drills to clear in one task. */
export const MAX_DRILL_TARGET = 15;
/** Hands to review per area. */
export const REVIEW_HANDS = 3;
/** Concepts to read per area. */
export const AREA_CONCEPTS = 2;
/** Spot keys kept per area (the trainer's address takes 200). */
export const MAX_AREA_KEYS = 200;

/** The fundamentals: what a new player reads and plays first. Concept ids of `lib/learn` (checked by the tests). */
export const FUNDAMENTAL_CONCEPTS = ["position", "rfi", "pot-odds"] as const;

/* ---------------------------------------------------------------- weeks - */

const DAY = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** A `YYYY-MM-DD` date as local midnight. */
export function localDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The Monday of the reader's week (local time), as `YYYY-MM-DD`: the plan's name. */
export function weekStart(now: Date): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (day.getDay() + 6) % 7;
  return isoDate(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
}

/** The week `n` weeks after (or before) `week`. */
export function addWeeks(week: string, n: number): string {
  const start = localDate(week);
  return isoDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * n));
}

/** The week's local bounds, `[from, to)`, as ISO instants (what progress is counted inside). */
export function weekBounds(week: string): { from: string; to: string } {
  const start = localDate(week);
  return {
    from: start.toISOString(),
    to: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).toISOString(),
  };
}

/** Whole days left in the week from `now`, today included (1 on Sunday). */
export function daysLeft(week: string, now: Date): number {
  const end = localDate(addWeeks(week, 1)).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((end - today) / DAY));
}

/* --------------------------------------------------------- focus areas - */

/** Where an area is: the parts of a leak id that name a situation (`ANY` where merging dropped one). */
export interface AreaWhere {
  street: string;
  scenario: string;
  family: string;
  hero: string;
  villain: string;
}

/** One wrong turn inside an area. */
export interface FocusLeak {
  id: string;
  taken: string;
  best: string;
  evLossBb: number;
  mistakes: number;
}

export type TrainerTarget =
  | { mode: "preflop"; family: PreflopFamily | "random"; seat: ChartPosition | null; vs: ChartPosition | null }
  | { mode: "river"; pot: RiverPot | "any"; side: RiverSeat | "any"; role: RiverRole | "any" };

export interface FocusArea {
  /** The situation's key: street~scenario~family~hero~villain. */
  id: string;
  where: AreaWhere;
  /** How far its leaks were merged up (`LEAK_LEVELS` index) and whether it is "the other seats". */
  level: number;
  partial: boolean;
  /** Its wrong turns, costliest first. */
  leaks: FocusLeak[];
  /** Finest spot keys (for the hands, the drills and the comparison). */
  keys: string[];
  /** Finest situations (for the comparison's "times in spot"). */
  situations: string[];
  evLossBb: number;
  per100: number;
  /** Graded decisions in its situations, right or wrong. */
  spotDecisions: number;
  mistakes: number;
  confidence: Confidence;
  /** Low confidence, in the plan only because nothing surer was there. */
  tentative: boolean;
  /** Concept ids to read, most relevant first. */
  concepts: string[];
  trainer: TrainerTarget | null;
  /** Weeks in a row this area has been a focus (1: new this week). */
  weeks: number;
  /** The hands its review tasks name, as the screen shows them (filled in once the hands are chosen). */
  reviews: ReviewHand[];
}

/** A hand to review, as the plan shows it: enough to recognise it without opening it. */
export interface ReviewHand {
  handId: string;
  cards: string[];
  handClass: string | null;
  position: string | null;
  evLossBb: number | null;
  playedAt: string | null;
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const whereOf = (leak: Leak): AreaWhere => ({
  street: leak.attrs.street,
  scenario: leak.attrs.scenario,
  family: leak.attrs.family,
  hero: leak.attrs.hero,
  villain: leak.attrs.villain,
});

/** An area's id: its situation at the level it settled. */
export const areaId = (where: AreaWhere) => [where.street, where.scenario, where.family, where.hero, where.villain].join("~");

const known = (part: string) => part !== ANY && part !== NONE;
const seatOf = (part: string): ChartPosition | null =>
  known(part) && (PREFLOP_SEATS as readonly string[]).includes(part) ? (part as ChartPosition) : null;

/**
 * The trainer that practises an area: preflop the chart family at the seat
 * (and against the raiser), on the river the hero's role and side; null for a
 * street there is no trainer for (the flop and the turn, until A5).
 */
export function trainerTarget(where: AreaWhere): TrainerTarget | null {
  if (where.street === "preflop") {
    const seat = seatOf(where.hero);
    const vs = seatOf(where.villain);
    let family: PreflopFamily;
    switch (where.scenario) {
      case "unopened":
        family = "rfi";
        break;
      case "vs-open":
        // The big blind against the small blind's open is the charts' blind-vs-blind family.
        family = seat === "BB" && vs === "SB" ? "bvb" : "vs-open";
        break;
      case "squeeze":
        family = "squeeze";
        break;
      case "vs-3bet":
      case "vs-3bet-cold":
        family = "vs-3bet";
        break;
      case "vs-4bet":
        family = "vs-4bet";
        break;
      case "vs-limp":
      case "bb-option":
        family = "bvb";
        break;
      default:
        // Merged up to the family: the family's trainer, any seat the parts still name.
        if (where.family === "first-in") family = "rfi";
        else if (where.family === "vs-raise") family = "vs-open";
        else if (where.family === "vs-reraise") family = "vs-3bet";
        else return { mode: "preflop", family: "random", seat: null, vs: null };
    }
    return { mode: "preflop", family, seat, vs: family === "rfi" ? null : vs };
  }
  if (where.street === "river") {
    // The river trainer's out-of-position hero acts first; only the hero in
    // position ever faces a bet there. So a spot facing a bet or a raise is
    // practised in position, whatever side it came from.
    const facing = where.family === "vs-bet" || where.family === "vs-raise" || /-vs-(bet|raise)$/.test(where.scenario);
    const match = /^(pfr|caller|limped)-(ip|oop)-/.exec(where.scenario);
    const side: RiverSeat | "any" = facing ? "ip" : match ? (match[2] as RiverSeat) : "any";
    if (!match) return { mode: "river", pot: "any", side, role: "any" };
    if (match[1] === "limped") return { mode: "river", pot: "limped", side, role: "any" };
    return { mode: "river", pot: "any", side, role: match[1] as RiverRole };
  }
  return null;
}

/** A trainer target as a task reference: `preflop/vs-open/BTN/vs-CO`, `river/any/oop/pfr`. */
export function trainerRef(target: TrainerTarget): string {
  if (target.mode === "preflop") {
    return ["preflop", target.family, target.seat ?? "any", target.vs ? `vs-${target.vs}` : null].filter(Boolean).join("/");
  }
  return ["river", target.pot, target.side, target.role].join("/");
}

/** A task reference read back as its target (the inverse of {@link trainerRef}); null for anything else. */
export function parseTrainerRef(ref: string): TrainerTarget | null {
  const parts = ref.split("/");
  const seat = (part: string | undefined) =>
    part && (PREFLOP_SEATS as readonly string[]).includes(part) ? (part as ChartPosition) : null;
  const oneOf = <T extends string>(part: string | undefined, allowed: readonly T[]): T | "any" | null =>
    part === "any" ? "any" : part && (allowed as readonly string[]).includes(part) ? (part as T) : null;
  if (parts[0] === "preflop" && parts.length >= 3 && parts.length <= 4) {
    const family = oneOf(parts[1], [...PREFLOP_FAMILIES, "random"] as const);
    if (!family || family === "any") return null;
    if (parts[2] !== "any" && !seat(parts[2])) return null;
    if (parts[3] !== undefined && !(parts[3].startsWith("vs-") && seat(parts[3].slice(3)))) return null;
    return { mode: "preflop", family, seat: seat(parts[2]), vs: parts[3] ? seat(parts[3].slice(3)) : null };
  }
  if (parts[0] === "river" && parts.length === 4) {
    const pot = oneOf(parts[1], RIVER_POTS);
    const side = oneOf(parts[2], RIVER_SEATS);
    const role = oneOf(parts[3], RIVER_ROLES);
    if (!pot || !side || !role) return null;
    return { mode: "river", pot, side, role };
  }
  return null;
}

export interface TrainerMatch {
  mode: "preflop" | "river";
  family: string | null;
  position: string | null;
  /** River: `<line id>:<hero seat>` (`trainer_results.spot` and `.position`); null for any. */
  spots: string[] | null;
}

/**
 * Which kept trainer answers count towards a target (`study_plan` counts
 * them): preflop by family and seat, the river by the (line, seat) pairs its
 * role and side allow.
 */
export function trainerMatch(target: TrainerTarget): TrainerMatch {
  if (target.mode === "preflop") {
    return { mode: "preflop", family: target.family === "random" ? null : target.family, position: target.seat, spots: null };
  }
  const seatings = riverSeatings({ pot: target.pot, seat: target.side, role: target.role });
  const all = target.pot === "any" && target.side === "any" && target.role === "any";
  return {
    mode: "river",
    family: null,
    position: null,
    spots: all ? null : seatings.map((s) => `${s.line.id}:${s.hero}`).sort(),
  };
}

/**
 * Every focus area in a sample, costliest first: the leak finder's leaks
 * gathered by situation. Deterministic: equal rows in any order give equal
 * areas.
 */
export function focusAreas(rows: readonly SpotRow[], hands: number): FocusArea[] {
  const leaks = groupLeaks(rows, { hands });
  const situationTotal = new Map<string, number>();
  for (const row of rows) {
    const key = situationKey(spotAttrs(row));
    situationTotal.set(key, (situationTotal.get(key) ?? 0) + row.decisions);
  }
  const byArea = new Map<string, Leak[]>();
  for (const leak of leaks) {
    const id = areaId(whereOf(leak));
    const list = byArea.get(id);
    if (list) list.push(leak);
    else byArea.set(id, [leak]);
  }
  const areas: FocusArea[] = [];
  for (const [id, list] of byArea) {
    const sorted = [...list].sort((a, b) => b.evLossBb - a.evLossBb || (a.id < b.id ? -1 : 1));
    const keys = [...new Set(sorted.flatMap((leak) => leak.keys))].sort();
    const situations = [...new Set(sorted.flatMap((leak) => leak.situationKeys))].sort();
    const spotDecisions = situations.reduce((sum, key) => sum + (situationTotal.get(key) ?? 0), 0);
    const mistakes = sorted.reduce((sum, leak) => sum + leak.mistakes, 0);
    const evLossBb = sorted.reduce((sum, leak) => sum + leak.evLossBb, 0);
    const concepts: string[] = [];
    for (const leak of sorted) for (const concept of leakConcepts(leak.attrs)) if (!concepts.includes(concept)) concepts.push(concept);
    const where = whereOf(sorted[0]);
    areas.push({
      id,
      where,
      level: sorted[0].level,
      partial: sorted.some((leak) => leak.partial),
      leaks: sorted.map((leak) => ({
        id: leak.id,
        taken: leak.attrs.taken,
        best: leak.attrs.best,
        evLossBb: leak.evLossBb,
        mistakes: leak.mistakes,
      })),
      keys: keys.slice(0, MAX_AREA_KEYS),
      situations,
      evLossBb: round(evLossBb, 3),
      per100: hands > 0 ? round((evLossBb / hands) * 100, 3) : 0,
      spotDecisions,
      mistakes,
      confidence: confidenceOf(spotDecisions, mistakes),
      tentative: false,
      concepts: concepts.slice(0, AREA_CONCEPTS),
      trainer: trainerTarget(where),
      weeks: 1,
      reviews: [],
    });
  }
  return areas.sort((a, b) => b.evLossBb - a.evLossBb || (a.id < b.id ? -1 : 1));
}

/**
 * The week's focus: the costliest areas the sample can vouch for (medium or
 * high confidence), then — only if fewer than `count` — the costliest thin
 * ones with at least {@link TENTATIVE_MIN_MISTAKES} mistakes, marked
 * tentative. One mistake in a thin spot is a hand to look at, not a leak.
 */
export function pickFocus(areas: readonly FocusArea[], count = PLAN_FOCUS): FocusArea[] {
  const sure = areas.filter((area) => area.confidence !== "low").slice(0, count);
  const thin = areas
    .filter((area) => area.confidence === "low" && area.mistakes >= TENTATIVE_MIN_MISTAKES)
    .slice(0, count - sure.length)
    .map((area) => ({ ...area, tentative: true }));
  return [...sure, ...thin];
}

/* ----------------------------------------------------------- the plan - */

export type PlanKind = "leaks" | "fundamentals";
export type TaskKind = "read" | "train" | "drill" | "review";

export interface PlanTask {
  kind: TaskKind;
  ref: string;
  target: number;
  /** Index of the focus area it serves; null for a plan-wide task. */
  focus: number | null;
  handId?: string;
  trainer?: TrainerTarget;
  match?: TrainerMatch;
  /** Drill: the spot keys (null for every drill). */
  spotKeys?: string[] | null;
}

/** What last week's plan says, for the rollover. */
export interface PreviousPlan {
  focus: readonly Pick<FocusArea, "id" | "weeks">[];
  tasks: ReadonlyArray<{ kind: TaskKind; ref: string; focus: number | null; done: boolean; handId?: string | null }>;
}

export interface FocusInput {
  rows: readonly SpotRow[];
  /** Graded hands in the sample. */
  hands: number;
  /** Graded moves in the sample. */
  graded: number;
  previous?: PreviousPlan | null;
}

export interface PlanFocus {
  kind: PlanKind;
  areas: FocusArea[];
  /** Why a fundamentals plan: no graded moves, too few, or no leak worth a week. */
  reason: "none" | "few" | "no-leaks" | null;
}

/** The week's focus from the leak finder's rows, or the fundamentals when the sample cannot carry one. */
export function planFocus(input: FocusInput): PlanFocus {
  if (input.graded === 0) return { kind: "fundamentals", areas: [], reason: "none" };
  if (input.graded < MIN_PLAN_MOVES) return { kind: "fundamentals", areas: [], reason: "few" };
  const picked = pickFocus(focusAreas(input.rows, input.hands));
  if (picked.length === 0) return { kind: "fundamentals", areas: [], reason: "no-leaks" };
  const before = new Map((input.previous?.focus ?? []).map((area) => [area.id, area.weeks]));
  return {
    kind: "leaks",
    areas: picked.map((area) => ({ ...area, weeks: (before.get(area.id) ?? 0) + 1 })),
    reason: null,
  };
}

export interface TaskInput {
  areas: readonly FocusArea[];
  /** Per area id: the hands behind it, most EV lost first (`analysis_leak_hands`). */
  hands: Readonly<Record<string, readonly string[]>>;
  /** Per finest spot key: drills and drills due (`drill_due_by_spot`). */
  drills: ReadonlyMap<string, { items: number; due: number }>;
  previous?: PreviousPlan | null;
}

/** Concepts and hands last week's plan finished, and the hands it left open per area. */
function carried(previous: PreviousPlan | null | undefined) {
  const read = new Set<string>();
  const reviewed = new Set<string>();
  const open = new Map<string, string[]>();
  if (!previous) return { read, reviewed, open };
  for (const task of previous.tasks) {
    if (task.kind === "read" && task.done) read.add(task.ref);
    if (task.kind === "review") {
      if (task.done) reviewed.add(task.ref);
      else if (task.focus !== null && previous.focus[task.focus]) {
        const id = previous.focus[task.focus].id;
        open.set(id, [...(open.get(id) ?? []), task.ref]);
      }
    }
  }
  return { read, reviewed, open };
}

/**
 * The week's checklist for a leaks plan, area by area: the concepts to read,
 * the trainer spots, the drills due on the area's spots, the hands to review.
 * A concept appears once even when two areas lean on it; so does a hand.
 */
export function planTasks(input: TaskInput): PlanTask[] {
  const { read, reviewed, open } = carried(input.previous);
  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  const add = (task: PlanTask) => {
    const key = `${task.kind}:${task.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    tasks.push(task);
  };
  input.areas.forEach((area, focus) => {
    for (const concept of area.concepts) {
      // Read last week: not asked again.
      if (read.has(concept)) continue;
      add({ kind: "read", ref: concept, target: 1, focus });
    }
    if (area.trainer) {
      add({
        kind: "train",
        ref: trainerRef(area.trainer),
        target: TRAIN_TARGET[area.trainer.mode],
        focus,
        trainer: area.trainer,
        match: trainerMatch(area.trainer),
      });
    }
    let due = 0;
    for (const key of area.keys) due += input.drills.get(key)?.due ?? 0;
    if (due > 0) {
      add({ kind: "drill", ref: area.id, target: Math.min(due, MAX_DRILL_TARGET), focus, spotKeys: area.keys });
    }
    const candidates = [...(open.get(area.id) ?? []), ...(input.hands[area.id] ?? [])];
    let picked = 0;
    for (const handId of candidates) {
      if (picked >= REVIEW_HANDS) break;
      if (reviewed.has(handId) || seen.has(`review:${handId}`)) continue;
      add({ kind: "review", ref: handId, target: 1, focus, handId });
      picked += 1;
    }
  });
  return tasks;
}

/**
 * The fundamentals plan, for a player with too little graded play: the core
 * concepts, the preflop trainer first in and defending the big blind, a few
 * river spots, and any drills already due.
 */
export function fundamentalsTasks(drillsDue: number, previous?: PreviousPlan | null): PlanTask[] {
  const { read } = carried(previous);
  const tasks: PlanTask[] = [];
  for (const concept of FUNDAMENTAL_CONCEPTS) if (!read.has(concept)) tasks.push({ kind: "read", ref: concept, target: 1, focus: null });
  if (tasks.length === 0) tasks.push({ kind: "read", ref: "blind-defence", target: 1, focus: null });
  const targets: TrainerTarget[] = [
    { mode: "preflop", family: "rfi", seat: null, vs: null },
    { mode: "preflop", family: "vs-open", seat: "BB", vs: null },
    { mode: "river", pot: "any", side: "any", role: "any" },
  ];
  for (const trainer of targets) {
    tasks.push({
      kind: "train",
      ref: trainerRef(trainer),
      target: trainer.mode === "river" ? 5 : 15,
      focus: null,
      trainer,
      match: trainerMatch(trainer),
    });
  }
  if (drillsDue > 0) tasks.push({ kind: "drill", ref: "all", target: Math.min(drillsDue, MAX_DRILL_TARGET), focus: null, spotKeys: null });
  return tasks;
}

/** A task as `save_study_plan` takes it. */
export function rpcTask(task: PlanTask): Record<string, unknown> {
  return {
    kind: task.kind,
    ref: task.ref,
    target: task.target,
    focus: task.focus,
    hand_id: task.handId ?? null,
    match_mode: task.match?.mode ?? null,
    match_family: task.match?.family ?? null,
    match_position: task.match?.position ?? null,
    match_spots: task.match?.spots ?? null,
    spot_keys: task.kind === "drill" ? (task.spotKeys ?? null) : null,
  };
}

/* ------------------------------------------------------------ progress - */

export interface TaskState {
  kind: TaskKind;
  focus: number | null;
  done: boolean;
  progress: number;
  target: number;
}

export interface PlanProgress {
  done: number;
  total: number;
  /** Per focus area index (and `null` for plan-wide tasks). */
  byFocus: Map<number | null, { done: number; total: number }>;
  /** 0..1, counting partial progress (12 of 20 trainer spots is 0.6 of a task). */
  share: number;
}

export function planProgress(tasks: readonly TaskState[]): PlanProgress {
  const byFocus = new Map<number | null, { done: number; total: number }>();
  let done = 0;
  let partial = 0;
  for (const task of tasks) {
    const entry = byFocus.get(task.focus) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.done) {
      entry.done += 1;
      done += 1;
    }
    byFocus.set(task.focus, entry);
    partial += task.done ? 1 : task.target > 0 ? Math.min(1, task.progress / task.target) : 0;
  }
  return { done, total: tasks.length, byFocus, share: tasks.length > 0 ? partial / tasks.length : 0 };
}

/* ------------------------------------------------------- retrospective - */

export interface AreaPeriod {
  /** Graded decisions in the area's situations. */
  spot: number;
  /** Graded worse than Perfect, on the area's leaks. */
  mistakes: number;
  evLossBb: number;
  /** EV lost on the area per 100 graded hands in the period; null with no hands. */
  per100: number | null;
  rate: number | null;
}

/** One period's numbers for an area: its keys' mistakes and EV, its situations' decisions. */
export function areaPeriod(area: Pick<FocusArea, "keys" | "situations">, rows: readonly SpotRow[], hands: number): AreaPeriod {
  const keys = new Set(area.keys);
  const situations = new Set(area.situations);
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
  return {
    spot,
    mistakes,
    evLossBb: round(ev, 3),
    per100: hands > 0 ? round((ev / hands) * 100, 3) : null,
    rate: spot > 0 ? mistakes / spot : null,
  };
}

export interface AreaChange {
  current: AreaPeriod;
  prior: AreaPeriod;
  z: number | null;
  trend: Trend;
}

/**
 * Did an area move between two periods? A6's comparison: the mistake rate in
 * its spot (two-proportion z, positive = fewer mistakes now), "too few" when
 * either period has under `minSpot` decisions there; EV lost per 100 hands of
 * each period for the reader to see.
 */
export function areaChange(
  area: Pick<FocusArea, "keys" | "situations">,
  current: { rows: readonly SpotRow[]; hands: number },
  prior: { rows: readonly SpotRow[]; hands: number },
  minSpot = MIN_COMPARE_SPOT,
): AreaChange {
  const a = areaPeriod(area, current.rows, current.hands);
  const b = areaPeriod(area, prior.rows, prior.hands);
  const z = rateZ(a.mistakes, a.spot, b.mistakes, b.spot);
  return { current: a, prior: b, z, trend: trendOf(z, a.spot >= minSpot && b.spot >= minSpot) };
}

export interface RetroWindows {
  /** `plan-week`: the plan's own week against the one before; `last-play`: no hands that week, so A6's last 7 days of play. */
  basis: "plan-week" | "last-play";
  current: { from: string; to: string };
  prior: { from: string; to: string };
}

/**
 * The two periods a retrospective compares. Last week's plan with graded
 * hands played during it: that week against the one before. Otherwise — no
 * plan, or no hands that week — the last 7 days of play against the 7 before,
 * as A6's card does (`periodWindows`). Null with no graded hand at all.
 */
export function retroWindows(previousWeek: string | null, lastPlayed: string | null): RetroWindows | null {
  if (!lastPlayed) return null;
  if (previousWeek) {
    const week = weekBounds(previousWeek);
    if (Date.parse(lastPlayed) >= Date.parse(week.from)) {
      return { basis: "plan-week", current: week, prior: weekBounds(addWeeks(previousWeek, -1)) };
    }
  }
  const windows = periodWindows(lastPlayed, 7);
  return { basis: "last-play", current: windows.current, prior: windows.prior };
}

/* ------------------------------------------------------------- parsing - */

const str = (value: unknown, pattern: RegExp, fallback = "") =>
  typeof value === "string" && pattern.test(value) ? value : fallback;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const strings = (value: unknown, pattern: RegExp, max: number) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && pattern.test(v)).slice(0, max) : [];

const PART = /^[A-Za-z0-9+*-]{1,40}$/;
const SPOT_KEY = /^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$/;
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];

function parseTrainer(value: unknown): TrainerTarget | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const seat = (x: unknown) => (typeof x === "string" && (PREFLOP_SEATS as readonly string[]).includes(x) ? (x as ChartPosition) : null);
  if (v.mode === "preflop" && typeof v.family === "string" && [...PREFLOP_FAMILIES, "random"].includes(v.family)) {
    return { mode: "preflop", family: v.family as PreflopFamily | "random", seat: seat(v.seat), vs: seat(v.vs) };
  }
  if (v.mode === "river") {
    const pick = <T extends string>(x: unknown, allowed: readonly T[]): T | "any" =>
      typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : "any";
    return { mode: "river", pot: pick(v.pot, RIVER_POTS), side: pick(v.side, RIVER_SEATS), role: pick(v.role, RIVER_ROLES) };
  }
  return null;
}

/**
 * A stored focus snapshot (`study_plans.focus`) read back: a whitelist of
 * the fields this module writes, anything else dropped, so an old or
 * malformed snapshot degrades to fewer details rather than a broken page.
 */
export function parseFocus(value: unknown): FocusArea[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, PLAN_FOCUS).flatMap((raw): FocusArea[] => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const w = (r.where ?? {}) as Record<string, unknown>;
    const where: AreaWhere = {
      street: str(w.street, /^(preflop|flop|turn|river)$/),
      scenario: str(w.scenario, PART, ANY),
      family: str(w.family, PART, ANY),
      hero: str(w.hero, PART, ANY),
      villain: str(w.villain, PART, ANY),
    };
    if (!where.street) return [];
    const leaks = Array.isArray(r.leaks)
      ? r.leaks.flatMap((l): FocusLeak[] => {
          if (!l || typeof l !== "object") return [];
          const leak = l as Record<string, unknown>;
          return [
            {
              id: str(leak.id, /^[A-Za-z0-9+*~-]{1,200}$/),
              taken: str(leak.taken, /^[a-z]{1,10}$/),
              best: str(leak.best, /^[a-z]{1,10}$/),
              evLossBb: num(leak.evLossBb),
              mistakes: num(leak.mistakes),
            },
          ];
        })
      : [];
    const confidence = CONFIDENCES.includes(r.confidence as Confidence) ? (r.confidence as Confidence) : "low";
    return [
      {
        id: areaId(where),
        where,
        level: num(r.level),
        partial: r.partial === true,
        leaks,
        keys: strings(r.keys, SPOT_KEY, MAX_AREA_KEYS),
        situations: strings(r.situations, /^[A-Za-z0-9+*~-]{1,200}$/, 500),
        evLossBb: num(r.evLossBb),
        per100: num(r.per100),
        spotDecisions: num(r.spotDecisions),
        mistakes: num(r.mistakes),
        confidence,
        tentative: r.tentative === true,
        concepts: strings(r.concepts, /^[a-z0-9][a-z0-9-]{0,39}$/, AREA_CONCEPTS + 1),
        trainer: parseTrainer(r.trainer),
        weeks: Math.max(1, Math.round(num(r.weeks)) || 1),
        reviews: parseReviews(r.reviews),
      },
    ];
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseReviews(value: unknown): ReviewHand[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, REVIEW_HANDS * 2).flatMap((raw): ReviewHand[] => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const handId = str(r.handId, UUID);
    if (!handId) return [];
    const maybe = (v: unknown, pattern: RegExp) => (typeof v === "string" && pattern.test(v) ? v : null);
    return [
      {
        handId,
        cards: strings(r.cards, /^[2-9TJQKA][cdhs]$/, 2),
        handClass: maybe(r.handClass, /^[2-9TJQKA]{2}[so]?$/),
        position: maybe(r.position, /^[A-Z0-9+]{1,8}$/),
        evLossBb: typeof r.evLossBb === "number" && Number.isFinite(r.evLossBb) ? r.evLossBb : null,
        playedAt: maybe(r.playedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/),
      },
    ];
  });
}

/** Area snapshots with each area's review hands looked up among those known (fresh rows first, then last week's). */
export function withReviews(areas: readonly FocusArea[], tasks: readonly PlanTask[], known: ReadonlyMap<string, ReviewHand>): FocusArea[] {
  return areas.map((area, index) => ({
    ...area,
    reviews: tasks
      .filter((task) => task.kind === "review" && task.focus === index && task.handId)
      .map((task) => known.get(task.handId!) ?? { handId: task.handId!, cards: [], handClass: null, position: null, evLossBb: null, playedAt: null }),
  }));
}
