/**
 * The Trainer opened from Analytics (docs/ANALYTICS.md Step 9): the link a
 * stat, a finding or the drill-down makes (`packages/ui/analytics/view.ts`:
 * `practiseQuery`, `drillQuery`, `playQuery`), read back as a trainer
 * target, and the goal the side panel shows.
 *
 * ```
 * from=analytics&stat=flop_fold_vs_bet&spot=single-raised|caller|BB|SB&size=20-40
 *   &classes=middle_pair,underpair&you=52&ref=31&cost=1.3[&hand=<id>&ord=7&action=12]
 *   ─▶ analyticsLink ─▶ { target (FocusTarget with sizes, classes, from), play }
 *   ─▶ targetSettings ─▶ the session's settings (the dealer narrows to the size and the classes)
 * ```
 *
 * The spot key is the checker's (`pot|role|hero|opponent`, `packages/ui/analytics/spot.ts`):
 * the street and what the hero faces come from the stat, the seats, pot
 * and role from the key. A spot the Trainer's dealers cannot hold exactly
 * (a bomb or 4-bet pot, several opponents, a flop line the library does not
 * have) is dealt as near as they can and marked `approximate`.
 *
 * Pure: the web's address and the desktop's route parameter go through the
 * same functions.
 */

import { CHART_SETS, DEFAULT_CHART_SET, type ChartPosition } from "../../lib/charts";
import { FLOP_LIBRARY_SETS, flopLinesFor, flopPlayersOf, lineSeats } from "../../lib/analysis/flopLibrary";
import { ALL_PREFLOP_SEATS, type PreflopFamily, type RiverPot, type RiverRole } from "../../lib/training";
import { ANALYTICS, type ActionClass, type Catalogue, type CatalogueStat, type RateStat } from "../../lib/stats/analytics";
import type { Grade } from "../../lib/analysis/types";
import type { FocusTarget } from "./focus";
import type { TrainerDict } from "./host";
import type { TrainerSettings } from "./settings";

/** Where a drill came from: the stat, its spot, and its figures there (percent; bb/100). */
export interface AnalyticsFrom {
  stat: string;
  /** The checker's spot key; '' for every spot. */
  spot: string;
  /** The player's rate in the spot, percent; null when the link carried none. */
  you: number | null;
  /** The target (the solver's or the charts'), percent. */
  ref: number | null;
  /** What it costs, bb/100. */
  cost: number | null;
  /** The player's number's tone in Analytics (`ok`, `off`, `far`, `few`); null when the link carried none. */
  tone?: "ok" | "off" | "far" | "few" | null;
}

const TONES = ["ok", "off", "far", "few"] as const;

/** A played decision to deal once ("Play it ▸"): the hand's id on the surface, its decision. */
export interface PlayedRef {
  hand: string;
  ord: number;
  action: number;
}

/** An Analytics link read: the target to deal, and the played decision first when "Play it" asked for one. */
export interface AnalyticsLink {
  target: FocusTarget;
  play: PlayedRef | null;
  /** The spot cannot be dealt exactly (the closest the dealers hold is). */
  approximate: boolean;
}

const first = (value: unknown): string | null => {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one !== "" ? one : null;
};

const numberOf = (value: unknown): number | null => {
  const text = first(value);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

const isSeat = (value: string): value is ChartPosition => (ALL_PREFLOP_SEATS as readonly string[]).includes(value);

/** The rate a stat's drill counts: its own class, a share's parent's. */
export function rateOf(stat: CatalogueStat | undefined, catalogue: Catalogue = ANALYTICS): RateStat | null {
  if (!stat) return null;
  if (stat.kind === "rate") return stat;
  if (stat.kind === "share") {
    const parent = catalogue.get(stat.of);
    return parent?.kind === "rate" ? parent : null;
  }
  return null;
}

/** Whether a stat's decisions answer a bet (`facing = bet` in its predicate); otherwise the hero acts first or is checked to. */
export function facesBet(stat: RateStat): boolean {
  return /\bfacing\s*=\s*bet\b/.test(stat.count);
}

/** The checker's preflop scenario as the chart family the preflop dealer reads. */
const FAMILY: Record<string, PreflopFamily> = {
  unopened: "rfi",
  "vs-limp": "vs-limp",
  "bb-option": "vs-limp",
  "vs-open": "vs-open",
  squeeze: "squeeze",
  "vs-3bet": "vs-3bet",
  "vs-3bet-cold": "vs-3bet",
  "vs-4bet": "vs-4bet",
};

/** The checker's postflop pot as the trainers' (`srp`, `3bp`, `limped`); null for one they do not deal. */
const POT: Record<string, RiverPot> = { "single-raised": "srp", "3bet": "3bp", limped: "limped" };

/** The flop library's set to deal from: the base settings' when it has a library, else the first published. */
function flopSetOf(base: string): string {
  if (FLOP_LIBRARY_SETS.includes(base)) return base;
  return FLOP_LIBRARY_SETS[0] ?? DEFAULT_CHART_SET;
}

/** The library line a heads-up flop between two seats was played on, and the hero's side on it. */
export function flopLineOf(set: string, pot: RiverPot | null, hero: ChartPosition, villain: ChartPosition): { line: string; side: "ip" | "oop" } | null {
  const players = CHART_SETS.find((spec) => spec.id === set)?.players ?? 6;
  for (const line of flopLinesFor(players)) {
    const linePot = line.pot === "4bp" ? null : line.pot;
    if (pot !== null && linePot !== pot) continue;
    const [oop, ip] = flopPlayersOf(line.key, lineSeats(line));
    if (oop === hero && ip === villain) return { line: line.id, side: "oop" };
    if (ip === hero && oop === villain) return { line: line.id, side: "ip" };
  }
  return null;
}

/** The side of two seats after the flop: the blinds act first, then the table's order to the button. */
export function sideOf(hero: ChartPosition, villain: ChartPosition): "ip" | "oop" {
  const order = ["SB", "BB", ...ALL_PREFLOP_SEATS.filter((seat) => seat !== "SB" && seat !== "BB")];
  return order.indexOf(hero) > order.indexOf(villain) ? "ip" : "oop";
}

/**
 * The trainer target of a stat in a spot, at a size, from classes. Null when
 * the stat has no rate (a coded stat) or no street the Trainer deals.
 */
export function analyticsTarget(
  statId: string,
  spot: string,
  size: string | null,
  classes: readonly string[],
  from: AnalyticsFrom,
  baseSet: string = DEFAULT_CHART_SET,
  catalogue: Catalogue = ANALYTICS,
): { target: FocusTarget; approximate: boolean } | null {
  const stat = rateOf(catalogue.get(statId), catalogue);
  if (!stat) return null;
  const [pot = "", role = "", heroRaw = "", opponentRaw = ""] = spot.split("|");
  const hero = isSeat(heroRaw) ? heroRaw : null;
  const villain = isSeat(opponentRaw) ? opponentRaw : null;
  const known = new Set(catalogue.file.handClasses.map((cls) => cls.id));
  const bucket = size && catalogue.file.sizeBuckets.some((b) => b.id === size) ? size : null;
  const kept = classes.filter((cls) => known.has(cls));
  const focus = { from, ...(kept.length > 0 ? { classes: kept } : {}), ...(bucket ? { sizes: [bucket] } : {}) };

  if (stat.street === "preflop") {
    const family = FAMILY[role] ?? "random";
    return {
      target: { mode: "preflop", family, seat: hero, vs: family === "rfi" ? null : villain, from },
      approximate: Boolean(role && !FAMILY[role]) || (opponentRaw !== "" && villain === null),
    };
  }
  if (stat.street !== "flop" && stat.street !== "turn" && stat.street !== "river") return null;

  const trainerPot: RiverPot | null = POT[pot] ?? null;
  const trainerRole: RiverRole | "any" = role === "pfr" || role === "caller" ? role : "any";
  const betting = facesBet(stat);
  let approximate = (pot !== "" && trainerPot === null) || villain === null || role === "bomb";

  if (stat.street === "flop") {
    const set = flopSetOf(baseSet);
    const placed = hero && villain ? flopLineOf(set, trainerPot, hero, villain) : null;
    if (hero && villain && !placed) approximate = true;
    const side = placed?.side ?? "any";
    // Checked to in position; out of position the hero's first decision.
    const facing = betting ? "bet" : side === "ip" ? "check" : "any";
    return {
      target: {
        mode: "flop",
        set,
        pot: trainerPot ?? "any",
        side,
        role: trainerRole,
        seat: hero,
        facing,
        line: placed?.line ?? null,
        ...focus,
      },
      approximate,
    };
  }
  const side = hero && villain ? sideOf(hero, villain) : "any";
  const facing = betting ? "bet" : side === "ip" ? "check" : "any";
  const common = { pot: trainerPot ?? ("any" as const), side, role: trainerRole, seat: hero, vs: villain, faced: facing, ...focus } as const;
  return {
    target: stat.street === "turn" ? { mode: "turn", ...common } : { mode: "river", ...common },
    approximate,
  };
}

/**
 * An Analytics link read back (the web's address, the desktop's route
 * parameter as `URLSearchParams`), or null when it is not one: no
 * `from=analytics`, or a stat the Trainer cannot deal.
 */
export function analyticsLink(
  query: Record<string, unknown> | URLSearchParams,
  baseSet: string = DEFAULT_CHART_SET,
  catalogue: Catalogue = ANALYTICS,
): AnalyticsLink | null {
  const get = (key: string): unknown => (query instanceof URLSearchParams ? query.get(key) : query[key]);
  if (first(get("from")) !== "analytics") return null;
  const stat = first(get("stat"));
  if (!stat) return null;
  const spot = first(get("spot")) ?? "";
  const classes = (first(get("classes")) ?? "").split(",").map((cls) => cls.trim()).filter(Boolean);
  const toneText = first(get("tone"));
  const tone = TONES.find((one) => one === toneText) ?? null;
  const from: AnalyticsFrom = { stat, spot, you: numberOf(get("you")), ref: numberOf(get("ref")), cost: numberOf(get("cost")), ...(tone ? { tone } : {}) };
  const made = analyticsTarget(stat, spot, first(get("size")), classes, from, baseSet, catalogue);
  if (!made) return null;
  const hand = first(get("hand"));
  const ord = numberOf(get("ord"));
  const action = numberOf(get("action"));
  const play = hand && action !== null && Number.isInteger(action) && action >= 0 ? { hand, ord: ord !== null && Number.isInteger(ord) ? ord : -1, action } : null;
  return { target: made.target, play, approximate: made.approximate };
}

/* ----------------------------------------------------------- the goal - */

/** What an answer says for the drill's goal: the action taken and the reference's mix for the hand. */
export interface GoalAnswer {
  action?: string;
  /** The reference's frequency by action (`fold`, `check`, `call`, `bet`, `raise`) for the hand. */
  mix?: Record<string, number>;
  grade: Grade;
}

export interface DrillGoal {
  /** Answers counted (those that carry their action). */
  n: number;
  /** Of them, in the stat's class. */
  taken: number;
  /** Percent; null before the first answer. */
  rate: number | null;
  /** The reference's rate on the same hands, percent; null before the first answer. */
  ref: number | null;
  /** ok: within the band of the reference; off; far; few: under {@link GOAL_MIN} answers. */
  tone: "ok" | "off" | "far" | "few";
}

/** Answers before the drill's rate is judged. */
export const GOAL_MIN = 5;
/** The band's floor, points (a drill is short; the checker's own floor is 2). */
export const GOAL_FLOOR = 5;

/**
 * This drill's rate of the stat's class and the reference's on the same
 * hands, from the session's answers that carry their action: the rate counts
 * up as the player answers. Judged like the checker (docs/ANALYTICS.md §3):
 * inside max(floor, 1.96·√(t(1−t)/n)) of the reference is ok, past twice it far.
 */
export function drillGoal(answers: readonly GoalAnswer[], cls: ActionClass, catalogue: Catalogue = ANALYTICS): DrillGoal {
  let n = 0;
  let taken = 0;
  let refSum = 0;
  for (const answer of answers) {
    if (!answer.action) continue;
    n += 1;
    if (catalogue.inClass(cls, answer.action)) taken += 1;
    if (answer.mix) {
      for (const [action, freq] of Object.entries(answer.mix)) if (catalogue.inClass(cls, action)) refSum += freq;
    }
  }
  if (n === 0) return { n, taken, rate: null, ref: null, tone: "few" };
  const rate = (taken / n) * 100;
  const ref = Math.min(100, (refSum / n) * 100);
  if (n < GOAL_MIN) return { n, taken, rate, ref, tone: "few" };
  const t = ref / 100;
  const half = Math.max(GOAL_FLOOR, 196 * Math.sqrt((t * (1 - t)) / n));
  const gap = Math.abs(rate - ref);
  return { n, taken, rate, ref, tone: gap <= half ? "ok" : gap <= 2 * half ? "off" : "far" };
}

/** A size bucket's label in the Trainer's language (the catalogue's own). */
export function sizeLabel(size: string, t: TrainerDict): string {
  const bucket = ANALYTICS.file.sizeBuckets.find((b) => b.id === size);
  return bucket ? bucket.label[t.lang === "hr" ? "hr" : "en"] : size;
}

/** The action class an Analytics session's stat counts ("fold" for a fold stat): the Hands chip's words. */
export function analyticsAction(s: Pick<TrainerSettings, "from">): string {
  const stat = s.from ? ANALYTICS.get(s.from.stat) : undefined;
  if (stat?.kind === "rate") return stat.class;
  if (stat?.kind === "share") {
    const parent = ANALYTICS.get(stat.of);
    return parent?.kind === "rate" ? parent.class : "";
  }
  return "";
}
