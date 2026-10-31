/**
 * The trainer's address bar: which trainer, its settings, and — for "Drill
 * this" on a leak — the leak's spot keys. Pure, so a link from Leaks or the
 * study plan and the page that reads it cannot disagree.
 *
 * The study plan (A8b) links straight into a focus area's spot: preflop the
 * family, seat and the raiser faced (`vs`), on the river the hero's preflop
 * role (`role`) and side. A trainer target (`lib/training/plan.ts`) becomes an
 * address through {@link targetQuery}.
 *
 * The flop trainer (§10, 2026-10-28) deals from Rail's flop library on the
 * sets it is solved for ({@link FLOP_TRAINER_SETS}), filtered like the river
 * by pot, side and preflop role, and by what the hero faces (`facing`); since
 * the study plan's flop target (§10, 2026-10-31) also by the hero's seat
 * (`seat`, the preflop trainer's setting) and one library line (`line`).
 */

import { FLOP_LIBRARY_SETS, flopLinesFor, flopPlayersOf, lineSeats } from "../../../lib/analysis/flopLibrary";
import { CHART_SETS, DEFAULT_CHART_SET, type ChartPosition } from "../../../lib/charts";
import {
  ALL_PREFLOP_SEATS,
  DEAL_BIASES,
  FLOP_FACINGS,
  PREFLOP_FAMILIES,
  RIVER_POTS,
  RIVER_ROLES,
  RIVER_SEATS,
  type DealBias,
  type FlopFacing,
  type FlopSpotOptions,
  type PreflopFamily,
  type PreflopSpotOptions,
  type RiverPot,
  type RiverRole,
  type RiverSeat,
  type RiverSpotOptions,
  type TrainerAnswer,
  type TrainerSpot,
} from "../../../lib/training";
import type { TrainerResultInput } from "../../../lib/db/training";
import type { TrainerTarget } from "../../../lib/training/plan";

/**
 * The sets the preflop trainer deals from: every chart set, the heads-up
 * ones (`charts/8`, `charts/9`) included - their seats are the small blind
 * (the button) and the big blind (`trainerSeats`).
 */
export const TRAINER_SETS = CHART_SETS;

/**
 * The sets the river trainer deals from: the default 6-max set and the
 * heads-up sets (`RIVER_LINES_HU`). The table is one setting for both
 * trainers (`TrainState.set`); a table the river has no lines for deals
 * the default set's.
 */
export const RIVER_TRAINER_SETS = CHART_SETS.filter((spec) => spec.id === DEFAULT_CHART_SET || spec.players === 2);

/** The set the river trainer deals from at a table: the table's own when it has river lines, else the default. */
export function riverSetOf(set: string): string {
  return RIVER_TRAINER_SETS.some((spec) => spec.id === set) ? set : DEFAULT_CHART_SET;
}

/**
 * The sets the flop trainer deals from: the ones the flop library is solved
 * for (`FLOP_LIBRARY_SETS`), in its order. A set whose manifest is not in the
 * bucket is offered and deals nothing: the manifest is the gate, so a set
 * deals the day its chunks are uploaded (heads-up 150bb, `analysis/37`).
 */
export const FLOP_TRAINER_SETS = FLOP_LIBRARY_SETS.map((id) => CHART_SETS.find((spec) => spec.id === id)!);

/** The set the flop trainer deals from at a table: the table's own when the library is solved for it, else the default. */
export function flopSetOf(set: string): string {
  return FLOP_TRAINER_SETS.some((spec) => spec.id === set) ? set : DEFAULT_CHART_SET;
}

/** The library lines the flop trainer offers at a table (`flopLinesFor` of the set it deals from). */
export function flopLinesAt(set: string) {
  const players = CHART_SETS.find((spec) => spec.id === flopSetOf(set))?.players ?? 6;
  return flopLinesFor(players);
}

/** The seats that see a flop on one of the table's library lines, in preflop order (the flop trainer's seat filter). */
export function flopSeatsAt(set: string): ChartPosition[] {
  const lines = flopLinesAt(set);
  const live = new Set(lines.flatMap((line) => flopPlayersOf(line.key, lineSeats(line))));
  return lines.length > 0 ? lineSeats(lines[0]).filter((seat) => live.has(seat)) : [];
}

export const TRAIN_MODES = ["preflop", "flop", "river", "drills"] as const;
export type TrainMode = (typeof TRAIN_MODES)[number];

export interface TrainState {
  mode: TrainMode;
  /** The chart set (table and depth, A2c); the river and flop trainers' when they deal there (`riverSetOf`, `flopSetOf`). */
  set: string;
  family: PreflopFamily | "random";
  seat: ChartPosition | null;
  /** Preflop: only against this raiser (the opener, 3-bettor or 4-bettor). */
  vs: ChartPosition | null;
  deal: DealBias;
  pot: RiverPot | "any";
  side: RiverSeat | "any";
  /** River and flop: only as the preflop raiser or the caller. */
  role: RiverRole | "any";
  /** Flop: only facing a check, a bet or a raise. */
  facing: FlopFacing;
  /** Flop: only this library line of the table (`btn-bb`); null for any. */
  line: string | null;
  /** Drills: only these finest spot keys (a leak). */
  spots: string[] | null;
  /** Drills: every drill, not only the due ones. */
  all: boolean;
  /** Drills: Inaccurate moves too. */
  inaccurate: boolean;
}

export const DEFAULT_TRAIN_STATE: TrainState = {
  mode: "preflop",
  set: DEFAULT_CHART_SET,
  family: "random",
  seat: null,
  vs: null,
  deal: "borderline",
  pot: "any",
  side: "any",
  role: "any",
  facing: "any",
  line: null,
  spots: null,
  all: false,
  inaccurate: false,
};

/** A spot key's shape (`analysis_spot_key`), as the database validates it. */
const SPOT_KEY = /^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$/;
/** At most this many keys travel in an address (the database takes 500). */
export const MAX_SPOT_KEYS = 200;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const seatParam = (value: string | undefined) =>
  value && (ALL_PREFLOP_SEATS as readonly string[]).includes(value) ? (value as ChartPosition) : null;

/** A line the flop trainer offers at the address's table, else none. */
const lineParam = (value: string | undefined, set: string | undefined) =>
  value && flopLinesAt(set ?? DEFAULT_CHART_SET).some((line) => line.id === value) ? value : null;

export function parseTrainState(query: Record<string, string | string[] | undefined>): TrainState {
  const spotsRaw = first(query.spots);
  const spots = spotsRaw
    ? spotsRaw
        .split(",")
        .map((key) => key.trim())
        .filter((key) => SPOT_KEY.test(key))
        .slice(0, MAX_SPOT_KEYS)
    : [];
  return {
    mode: oneOf(first(query.mode), TRAIN_MODES, spots.length > 0 ? "drills" : DEFAULT_TRAIN_STATE.mode),
    set: oneOf(first(query.set), TRAINER_SETS.map((spec) => spec.id), DEFAULT_TRAIN_STATE.set),
    family: oneOf(first(query.family), [...PREFLOP_FAMILIES, "random"] as const, DEFAULT_TRAIN_STATE.family),
    seat: seatParam(first(query.seat)),
    vs: seatParam(first(query.vs)),
    deal: oneOf(first(query.deal), DEAL_BIASES, DEFAULT_TRAIN_STATE.deal),
    pot: oneOf(first(query.pot), [...RIVER_POTS, "any"] as const, DEFAULT_TRAIN_STATE.pot),
    side: oneOf(first(query.side), [...RIVER_SEATS, "any"] as const, DEFAULT_TRAIN_STATE.side),
    role: oneOf(first(query.role), [...RIVER_ROLES, "any"] as const, DEFAULT_TRAIN_STATE.role),
    facing: oneOf(first(query.facing), [...FLOP_FACINGS, "any"] as const, DEFAULT_TRAIN_STATE.facing),
    line: lineParam(first(query.line), first(query.set)),
    spots: spots.length > 0 ? spots : null,
    all: first(query.all) === "1",
    inaccurate: first(query.inaccurate) === "1",
  };
}

/** The query string for a state, defaults left out. */
export function trainQuery(state: TrainState): string {
  const params = new URLSearchParams();
  if (state.mode !== DEFAULT_TRAIN_STATE.mode || state.spots) params.set("mode", state.mode);
  if (state.mode === "preflop") {
    if (state.set !== DEFAULT_TRAIN_STATE.set) params.set("set", state.set);
    if (state.family !== DEFAULT_TRAIN_STATE.family) params.set("family", state.family);
    if (state.seat) params.set("seat", state.seat);
    if (state.vs) params.set("vs", state.vs);
  }
  if (state.mode === "river" || state.mode === "flop") {
    const set = state.mode === "river" ? riverSetOf(state.set) : flopSetOf(state.set);
    if (set !== DEFAULT_TRAIN_STATE.set) params.set("set", state.set);
    if (state.pot !== DEFAULT_TRAIN_STATE.pot) params.set("pot", state.pot);
    if (state.side !== DEFAULT_TRAIN_STATE.side) params.set("side", state.side);
    if (state.role !== DEFAULT_TRAIN_STATE.role) params.set("role", state.role);
  }
  if (state.mode === "flop") {
    if (state.seat && flopSeatsAt(state.set).includes(state.seat)) params.set("seat", state.seat);
    if (state.facing !== DEFAULT_TRAIN_STATE.facing) params.set("facing", state.facing);
    if (state.line && flopLinesAt(state.set).some((line) => line.id === state.line)) params.set("line", state.line);
  }
  if (state.mode !== "drills" && state.deal !== DEFAULT_TRAIN_STATE.deal) params.set("deal", state.deal);
  if (state.mode === "drills") {
    if (state.spots) params.set("spots", state.spots.join(","));
    if (state.all) params.set("all", "1");
    if (state.inaccurate) params.set("inaccurate", "1");
  }
  return params.toString();
}

/** A trainer that deals spots (every mode but the drills). */
export type SpotMode = Exclude<TrainMode, "drills">;

/** What a spot trainer deals from: its settings in the state, the table its own (`riverSetOf`, `flopSetOf`). */
export function spotOptions(mode: "preflop", state: TrainState): PreflopSpotOptions;
export function spotOptions(mode: "river", state: TrainState): RiverSpotOptions;
export function spotOptions(mode: "flop", state: TrainState): FlopSpotOptions;
export function spotOptions(mode: SpotMode, state: TrainState): PreflopSpotOptions | RiverSpotOptions | FlopSpotOptions;
export function spotOptions(mode: SpotMode, state: TrainState): PreflopSpotOptions | RiverSpotOptions | FlopSpotOptions {
  if (mode === "preflop") return { set: state.set, family: state.family, seat: state.seat, vs: state.vs, bias: state.deal };
  if (mode === "river") return { set: riverSetOf(state.set), pot: state.pot, seat: state.side, role: state.role, bias: state.deal };
  // The hero's seat and the line only when the table has them (a preflop seat carried over may not see a flop).
  const hero = state.seat && flopSeatsAt(state.set).includes(state.seat) ? state.seat : null;
  const line = state.line && flopLinesAt(state.set).some((l) => l.id === state.line) ? state.line : null;
  return {
    set: flopSetOf(state.set),
    pot: state.pot,
    seat: state.side,
    role: state.role,
    facing: state.facing,
    ...(hero ? { hero } : {}),
    ...(line ? { line } : {}),
    bias: state.deal,
  };
}

/**
 * The `trainer_results` row a graded answer is kept as: the mode is the
 * spot's street; the family the preflop family, else the pot type; the spot
 * the chart line, else the line id (a flop's library line). Null for a turn
 * spot, which no trainer mode deals (Learn's own).
 */
export function trainerResultOf(spot: TrainerSpot, answer: TrainerAnswer, handClass: string | null): TrainerResultInput | null {
  if (spot.kind === "turn") return null;
  return {
    mode: spot.kind,
    family: spot.kind === "preflop" ? spot.family : spot.pot,
    spot: spot.kind === "preflop" ? spot.line : spot.lineId,
    position: spot.hero,
    handClass,
    grade: answer.grade,
    evLossBb: answer.evLoss,
    evLossPot: answer.evLossPot,
    score: answer.score,
  };
}

/** The address "Drill this" opens for a leak's spot keys. */
export function drillQuery(keys: readonly string[]): string {
  return trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "drills", all: true, spots: keys.slice(0, MAX_SPOT_KEYS) });
}

/** The address of a study plan's drill task: the due drills of an area (or all of them), not every drill. */
export function dueDrillQuery(keys: readonly string[] | null): string {
  return trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "drills", spots: keys && keys.length > 0 ? keys.slice(0, MAX_SPOT_KEYS) : null });
}

/** The address of a study plan's trainer task: the trainer set to the area's spot. */
export function targetQuery(target: TrainerTarget): string {
  if (target.mode === "preflop") {
    const set = target.set && TRAINER_SETS.some((spec) => spec.id === target.set) ? target.set : DEFAULT_TRAIN_STATE.set;
    return trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "preflop", set, family: target.family, seat: target.seat, vs: target.vs });
  }
  if (target.mode === "flop") {
    // The table, seat, role, side and what the hero faces; the line when the area fits one.
    return trainQuery({
      ...DEFAULT_TRAIN_STATE,
      mode: "flop",
      set: flopSetOf(target.set),
      pot: target.pot,
      side: target.side,
      role: target.role,
      seat: target.seat,
      facing: target.facing,
      line: target.line,
    });
  }
  return trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "river", pot: target.pot, side: target.side, role: target.role });
}
