/**
 * The Trainer's settings: what it deals and how it behaves. Pure, so the
 * web's address, the app's storage and the leak-driven mode cannot disagree
 * about what a setting means.
 *
 * One flat record for every mode, as the old trainer's `TrainState` was: a
 * seat picked for preflop is still there when the player switches to the
 * flop, and a setting a mode does not read is simply ignored by it
 * ({@link spotOptions}). The deal itself is `lib/training` (the same
 * generators and the same grader the Learn exercises and the old trainer use).
 */

import { FLOP_LIBRARY_SETS, flopLinesFor, flopPlayersOf, lineSeats } from "../../lib/analysis/flopLibrary";
import { CHART_SETS, DEFAULT_CHART_SET, PLANNED_CHART_SETS, type ChartPosition } from "../../lib/charts";
import {
  ALL_PREFLOP_SEATS,
  DEAL_BIASES,
  FLOP_FACINGS,
  PREFLOP_FAMILIES,
  RIVER_POTS,
  RIVER_ROLES,
  RIVER_SEATS,
  trainerFamilies,
  trainerSeats,
  type DealBias,
  type FlopFacing,
  type FlopSpotOptions,
  type PreflopFamily,
  type PreflopSpotOptions,
  type RiverPot,
  type RiverRole,
  type RiverSeat,
  type RiverSpotOptions,
  type TurnSpotOptions,
} from "../../lib/training";
import type { FocusTarget } from "./focus";
import type { AnalyticsFrom } from "./analytics";
import { ANALYTICS } from "../../lib/stats/analytics";
import { PLAY_FAMILIES, type PlayOptions } from "../../lib/training/play";

/** `focus`: spots from the player's own leaks; the others deal one street. */
export const TRAINER_MODES = ["focus", "preflop", "flop", "turn", "river"] as const;
export type TrainerMode = (typeof TRAINER_MODES)[number];
/** A mode that deals one street. */
export type StreetMode = Exclude<TrainerMode, "focus">;
export const STREET_MODES: readonly StreetMode[] = ["preflop", "flop", "turn", "river"];

export const PAUSES = ["always", "mistakes"] as const;

/** One decision a spot, or the whole hand played on to the end (T2, `lib/training/play.ts`). */
export const PLAYS = ["spot", "hand"] as const;
export type Play = (typeof PLAYS)[number];
/** The modes a whole hand starts from: preflop, the flop, or a leak's spot (at its street, a river's from the flop). */
/**
 * The range panel while answering: the range's shape only, or how the reference plays it (gives the answer away).
 * The panel itself folds open and shut on the spot (`RangePanel`); an old "off" reads as the default.
 */
export const RANGES = ["range", "strategy"] as const;
export type RangePanel = (typeof RANGES)[number];
/** Seconds to answer; "0": no clock. Out of time: a check where there is one, else a fold. */
export const TIMEBANKS = ["0", "7", "15", "25"] as const;
export type Timebank = (typeof TIMEBANKS)[number];
/** Every size its own button, or one button per kind (credited with the size the reference prefers for the hand). */
export const BUTTONS = ["all", "simple"] as const;
export type Buttons = (typeof BUTTONS)[number];
/** Answer with one action, or with a mix: each action's share of the time. */
export const INPUTS = ["action", "frequency"] as const;
export type Input = (typeof INPUTS)[number];
/** Tables at once (one spot each). */
export const TABLES = ["1", "2", "3", "4"] as const;
export type Tables = (typeof TABLES)[number];

/** Spots of the session's own dealt again (`sessions.ts`): never, about one in six, about one in three. */
export const REPEATS = ["off", "some", "often"] as const;
export type Repeat = (typeof REPEATS)[number];

export const HAND_MODES: readonly TrainerMode[] = ["focus", "preflop", "flop"];
export type Pause = (typeof PAUSES)[number];

export interface TrainerSettings {
  mode: TrainerMode;
  /** One spot or the whole hand. */
  play: Play;
  /** The chart set: table and depth. A postflop mode deals on its own nearest table ({@link setFor}). */
  set: string;
  /** Preflop: the chart family. */
  family: PreflopFamily | "random";
  /** Preflop and flop: the hero's seat; null for any. */
  seat: ChartPosition | null;
  /** Preflop: against this raiser; null for any. */
  vs: ChartPosition | null;
  /** Postflop: the pot type. */
  pot: RiverPot | "any";
  /** Postflop: in or out of position. */
  side: RiverSeat | "any";
  /** Postflop: the hero raised preflop last, or called. */
  role: RiverRole | "any";
  /** Flop: what the hero faces (turn: a check or a bet only). */
  facing: FlopFacing | "any";
  /** Flop: one library line of the table; null for any. */
  line: string | null;
  deal: DealBias;
  /** `mistakes`: a Perfect or Good answer moves on by itself. */
  pause: Pause;
  /** After an answer: the strategy for the hand (every option's frequency and EV). */
  strategy: boolean;
  /** After an answer: the hand's facts (equity, pot odds, made hand, draws). */
  facts: boolean;
  range: RangePanel;
  timebank: Timebank;
  buttons: Buttons;
  input: Input;
  tables: Tables;
  /** Spots of the session's own dealt again. */
  repeat: Repeat;
  /** Postflop: only bets of this size bucket faced (Analytics' `size`, `20-40`…); null for any. */
  size: string | null;
  /** Postflop: only hero hands of these hand classes (Analytics' "Hands you tend to fold"); empty for any. */
  classes: string[];
  /** The Analytics stat and spot the session practises (the bar and the goal); null for any other session. */
  from: AnalyticsFrom | null;
}

export const DEFAULT_SETTINGS: TrainerSettings = {
  mode: "focus",
  play: "spot",
  set: DEFAULT_CHART_SET,
  family: "random",
  seat: null,
  vs: null,
  pot: "any",
  side: "any",
  role: "any",
  facing: "any",
  line: null,
  deal: "borderline",
  pause: "always",
  strategy: true,
  facts: true,
  range: "range",
  timebank: "0",
  buttons: "all",
  input: "action",
  tables: "1",
  repeat: "some",
  size: null,
  classes: [],
  from: null,
};

/** The sets each street deals from (the river and turn trainers: the 6-max default and heads-up). */
export const PREFLOP_SETS = CHART_SETS;
export const FLOP_SETS = FLOP_LIBRARY_SETS.map((id) => CHART_SETS.find((spec) => spec.id === id)!).filter(Boolean);
export const SOLVED_SETS = CHART_SETS.filter((spec) => spec.id === DEFAULT_CHART_SET || spec.players === 2);

export function setsFor(mode: TrainerMode) {
  if (mode === "preflop" || mode === "focus") return PREFLOP_SETS;
  return mode === "flop" ? FLOP_SETS : SOLVED_SETS;
}

/** Whether a set is transcribed (`CHART_SETS`): one that is not has nothing to deal. */
export function isTranscribed(set: string): boolean {
  return CHART_SETS.some((spec) => spec.id === set);
}

/**
 * The set a mode deals from at the chosen table: the table's own when it has
 * one, else the default. A set not transcribed yet (a leak's or a link's) stays
 * itself: the Trainer says it is not available ({@link unavailable}), it never
 * deals another set in its place.
 */
export function setFor(mode: TrainerMode, set: string): string {
  if (!isTranscribed(set)) return set;
  return setsFor(mode).some((spec) => spec.id === set) ? set : DEFAULT_CHART_SET;
}

/** Why the Trainer cannot deal: no flop library published (`flop`), or the set not transcribed yet (`set`). */
export type Unavailable = "flop" | "set";

/**
 * Whether a street mode (a whole hand when `hand`: from the flop unless the
 * mode is preflop) can deal at these settings: a flop needs a published flop
 * library (none is, until one is solved on the GTO Wizard sets), every mode a
 * set `CHART_SETS` holds. Null when it can.
 */
export function unavailable(mode: StreetMode, s: TrainerSettings, hand = false): Unavailable | null {
  if ((mode === "flop" || (hand && mode !== "preflop")) && FLOP_SETS.length === 0) return "flop";
  return isTranscribed(setFor(mode, s.set)) ? null : "set";
}

export function playersOf(set: string): number {
  return CHART_SETS.find((spec) => spec.id === set)?.players ?? 6;
}

/** The seats a preflop spot can give the hero at the table. */
export function seatsAt(set: string): readonly ChartPosition[] {
  return trainerSeats(playersOf(set));
}

export function familiesAt(set: string): readonly PreflopFamily[] {
  return trainerFamilies(playersOf(set));
}

/** The flop library's lines at the table the flop deals from. */
export function flopLinesAt(set: string) {
  return flopLinesFor(playersOf(setFor("flop", set)));
}

/** The seats that see a flop on one of the table's library lines, in preflop order. */
export function flopSeatsAt(set: string): ChartPosition[] {
  const lines = flopLinesAt(set);
  const live = new Set(lines.flatMap((line) => flopPlayersOf(line.key, lineSeats(line))));
  return lines.length > 0 ? lineSeats(lines[0]).filter((seat) => live.has(seat)) : [];
}

/** A spot request: what to deal, from which generator. */
export type SpotRequest =
  | { kind: "preflop"; options: PreflopSpotOptions }
  | { kind: "flop"; options: FlopSpotOptions }
  | { kind: "turn"; options: TurnSpotOptions }
  | { kind: "river"; options: RiverSpotOptions };

/** What a street mode deals from: the settings it reads, the table its own. */
export function spotOptions(mode: StreetMode, s: TrainerSettings): SpotRequest {
  if (mode === "preflop") {
    const seats = seatsAt(s.set);
    const seat = s.seat && seats.includes(s.seat) ? s.seat : null;
    const vs = s.family !== "rfi" && s.vs && seats.includes(s.vs) && s.vs !== seat ? s.vs : null;
    const family = s.family === "random" || familiesAt(s.set).includes(s.family) ? s.family : "random";
    return { kind: "preflop", options: { set: s.set, family, seat, vs, bias: s.deal } };
  }
  // Analytics' narrowing (Step 9): the bet faced of one size bucket, the hero's hand of the classes chosen.
  const focus = { ...(s.size ? { size: s.size } : {}), ...(s.classes.length > 0 ? { classes: [...s.classes] } : {}) };
  if (mode === "flop") {
    const hero = s.seat && flopSeatsAt(s.set).includes(s.seat) ? s.seat : null;
    const line = s.line && flopLinesAt(s.set).some((l) => l.id === s.line) ? s.line : null;
    return {
      kind: "flop",
      options: {
        set: setFor("flop", s.set),
        pot: s.pot,
        seat: s.side,
        role: s.role,
        facing: s.facing,
        ...(hero ? { hero } : {}),
        ...(line ? { line } : {}),
        bias: s.deal,
        ...focus,
      },
    };
  }
  // The turn and river solvers deal heads-up lines of the default 6-max set or a heads-up set.
  const set = setFor(mode, s.set);
  // Out of position a bet to answer is the villain's after the hero's check.
  const facing = s.facing === "bet" && s.side === "oop" ? "check-bet" : s.facing === "check" || s.facing === "bet" ? s.facing : "any";
  // The seats only from Analytics: the street modes' sheet has no seat row for the turn and river.
  const seats = s.from ? { ...(s.seat ? { hero: s.seat } : {}), ...(s.vs ? { villain: s.vs } : {}) } : {};
  const options = { set, pot: s.pot, seat: s.side, role: s.role, bias: s.deal, facing, ...seats, ...focus } as const;
  if (mode === "turn") return { kind: "turn", options };
  return { kind: "river", options };
}

/**
 * A leak's trainer target as settings: the street it is on, the table it was
 * played at, and its seat, raiser, pot, side, role and what it faced. Only
 * the spot fields change; how the trainer behaves (pause, shown panels, the
 * deal bias) stays the player's.
 */
export function targetSettings(target: FocusTarget, base: TrainerSettings): { mode: StreetMode; settings: TrainerSettings } {
  // Analytics' narrowing and origin (Step 9); a study plan's or a leak's target carries none, so none is kept.
  const narrowed: Pick<TrainerSettings, "size" | "classes" | "from"> = {
    size: target.sizes?.[0] ?? null,
    classes: [...(target.classes ?? [])],
    from: target.from ?? null,
  };
  // The turn and river: Analytics' seats and what is faced; a leak's turn or river spot leaves them open.
  const later = target.from ? { seat: target.seat ?? null, vs: target.vs ?? null, facing: target.faced ?? "any" } : { facing: "any" as const };
  if (target.mode === "turn") {
    return {
      mode: "turn",
      settings: { ...base, ...narrowed, ...later, set: target.set ?? DEFAULT_CHART_SET, pot: target.pot, side: target.side, role: target.role },
    };
  }
  if (target.mode === "preflop") {
    return {
      mode: "preflop",
      settings: { ...base, ...narrowed, set: target.set ?? base.set, family: target.family, seat: target.seat, vs: target.vs },
    };
  }
  if (target.mode === "flop") {
    return {
      mode: "flop",
      settings: {
        ...base,
        ...narrowed,
        set: target.set,
        pot: target.pot,
        side: target.side,
        role: target.role,
        seat: target.seat,
        facing: target.facing,
        line: target.line,
      },
    };
  }
  return {
    mode: "river",
    settings: { ...base, ...narrowed, ...later, set: target.set ?? DEFAULT_CHART_SET, pot: target.pot, side: target.side, role: target.role },
  };
}

/* ------------------------------------------------------ reading back - */

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const seatOf = (value: unknown) =>
  typeof value === "string" && (ALL_PREFLOP_SEATS as readonly string[]).includes(value) ? (value as ChartPosition) : null;

const SIZES = ANALYTICS.file.sizeBuckets.map((bucket) => bucket.id);
const CLASSES = ANALYTICS.file.handClasses.map((cls) => cls.id);

/** Hand classes from a list or a comma-joined field: the catalogue's, each once, in the catalogue's order. */
function classesOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const wanted = new Set(list.filter((item): item is string => typeof item === "string").map((item) => item.trim()));
  return CLASSES.filter((cls) => wanted.has(cls));
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Where a session came from in Analytics: a stored JSON field or a record; null when it is neither. */
function fromOf(value: unknown): AnalyticsFrom | null {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.stat !== "string" || !ANALYTICS.get(r.stat)) return null;
  const tone = r.tone === "ok" || r.tone === "off" || r.tone === "far" || r.tone === "few" ? r.tone : null;
  return {
    stat: r.stat,
    spot: typeof r.spot === "string" ? r.spot.slice(0, 120) : "",
    you: finite(r.you),
    ref: finite(r.ref),
    cost: finite(r.cost),
    ...(tone ? { tone } : {}),
  };
}

/**
 * Settings from loose fields (an address, a stored record): every field
 * checked, anything unknown falling back to the default. Never throws.
 */
export function parseSettings(raw: Record<string, unknown> | null | undefined): TrainerSettings {
  const r = raw ?? {};
  const d = DEFAULT_SETTINGS;
  // A planned set not transcribed yet is kept (a study plan's link to it): the Trainer says it is not available.
  const set = oneOf(r.set, [...new Set([...CHART_SETS.map((spec) => spec.id), ...PLANNED_CHART_SETS])], d.set);
  const flag = (value: unknown, fallback: boolean) =>
    value === true || value === "1" || value === "on" ? true : value === false || value === "0" || value === "off" ? false : fallback;
  return {
    mode: oneOf(r.mode, TRAINER_MODES, d.mode),
    play: oneOf(r.play, PLAYS, d.play),
    set,
    family: oneOf(r.family, [...PREFLOP_FAMILIES, "random"] as const, d.family),
    seat: seatOf(r.seat),
    vs: seatOf(r.vs),
    pot: oneOf(r.pot, [...RIVER_POTS, "any"] as const, d.pot),
    side: oneOf(r.side, [...RIVER_SEATS, "any"] as const, d.side),
    role: oneOf(r.role, [...RIVER_ROLES, "any"] as const, d.role),
    facing: oneOf(r.facing, [...FLOP_FACINGS, "any"] as const, d.facing),
    line: typeof r.line === "string" && flopLinesAt(set).some((line) => line.id === r.line) ? r.line : null,
    deal: oneOf(r.deal, DEAL_BIASES, d.deal),
    pause: oneOf(r.pause, PAUSES, d.pause),
    strategy: flag(r.strategy, d.strategy),
    facts: flag(r.facts, d.facts),
    range: oneOf(r.range, RANGES, d.range),
    timebank: oneOf(r.timebank, TIMEBANKS, d.timebank),
    buttons: oneOf(r.buttons, BUTTONS, d.buttons),
    input: oneOf(r.input, INPUTS, d.input),
    tables: oneOf(r.tables, TABLES, d.tables),
    repeat: oneOf(r.repeat, REPEATS, d.repeat),
    size: typeof r.size === "string" && SIZES.includes(r.size) ? r.size : null,
    classes: classesOf(r.classes),
    from: fromOf(r.from),
  };
}

/** The fields that differ from the default, as strings (an address's query, a stored record). */
export function settingsFields(s: TrainerSettings): Record<string, string> {
  const out: Record<string, string> = {};
  const d = DEFAULT_SETTINGS;
  for (const key of Object.keys(d) as (keyof TrainerSettings)[]) {
    const value = s[key];
    if (value === d[key] || value === null) continue;
    if (typeof value === "boolean") out[key] = value ? "1" : "0";
    else if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(",");
    } else if (typeof value === "object") out[key] = JSON.stringify(value);
    else out[key] = value;
  }
  return out;
}

/**
 * What a whole hand is dealt from: preflop the chart spot's settings (a
 * family a whole hand cannot start from - a squeeze, limpers - as any), the
 * flop the library line's (from the root: what the hero faces is played out,
 * not chosen). A river leak's hand starts on the flop of its kind of line.
 */
export function playOptions(mode: StreetMode, s: TrainerSettings): PlayOptions {
  const preflop = spotOptions("preflop", s);
  const flop = spotOptions("flop", { ...s, facing: "any" });
  const family = preflop.kind === "preflop" && preflop.options.family !== "random" && !PLAY_FAMILIES.includes(preflop.options.family) ? "random" : undefined;
  return {
    start: mode === "preflop" ? "preflop" : "flop",
    preflop: preflop.kind === "preflop" ? { ...preflop.options, ...(family ? { family } : {}) } : { family: "random" },
    flop: flop.kind === "flop" ? flop.options : {},
  };
}
