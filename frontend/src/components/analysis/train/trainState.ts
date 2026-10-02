/**
 * The trainer's address bar: which trainer, its settings, and — for "Drill
 * this" on a leak — the leak's spot keys. Pure, so a link from Leaks or the
 * study plan and the page that reads it cannot disagree.
 *
 * The study plan (A8b) links straight into a focus area's spot: preflop the
 * family, seat and the raiser faced (`vs`), on the river the hero's preflop
 * role (`role`) and side. A trainer target (`lib/training/plan.ts`) becomes an
 * address through {@link targetQuery}.
 */

import { CHART_SETS, DEFAULT_CHART_SET, type ChartPosition } from "../../../lib/charts";
import {
  ALL_PREFLOP_SEATS,
  DEAL_BIASES,
  PREFLOP_FAMILIES,
  RIVER_POTS,
  RIVER_ROLES,
  RIVER_SEATS,
  type DealBias,
  type PreflopFamily,
  type RiverPot,
  type RiverRole,
  type RiverSeat,
} from "../../../lib/training";
import type { TrainerTarget } from "../../../lib/training/plan";

export const TRAIN_MODES = ["preflop", "river", "drills"] as const;
export type TrainMode = (typeof TRAIN_MODES)[number];

export interface TrainState {
  mode: TrainMode;
  /** Preflop: the chart set (table and depth, A2c). */
  set: string;
  family: PreflopFamily | "random";
  seat: ChartPosition | null;
  /** Preflop: only against this raiser (the opener, 3-bettor or 4-bettor). */
  vs: ChartPosition | null;
  deal: DealBias;
  pot: RiverPot | "any";
  side: RiverSeat | "any";
  /** River: only as the preflop raiser or the caller. */
  role: RiverRole | "any";
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
    set: oneOf(first(query.set), CHART_SETS.map((spec) => spec.id), DEFAULT_TRAIN_STATE.set),
    family: oneOf(first(query.family), [...PREFLOP_FAMILIES, "random"] as const, DEFAULT_TRAIN_STATE.family),
    seat: seatParam(first(query.seat)),
    vs: seatParam(first(query.vs)),
    deal: oneOf(first(query.deal), DEAL_BIASES, DEFAULT_TRAIN_STATE.deal),
    pot: oneOf(first(query.pot), [...RIVER_POTS, "any"] as const, DEFAULT_TRAIN_STATE.pot),
    side: oneOf(first(query.side), [...RIVER_SEATS, "any"] as const, DEFAULT_TRAIN_STATE.side),
    role: oneOf(first(query.role), [...RIVER_ROLES, "any"] as const, DEFAULT_TRAIN_STATE.role),
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
  if (state.mode === "river") {
    if (state.pot !== DEFAULT_TRAIN_STATE.pot) params.set("pot", state.pot);
    if (state.side !== DEFAULT_TRAIN_STATE.side) params.set("side", state.side);
    if (state.role !== DEFAULT_TRAIN_STATE.role) params.set("role", state.role);
  }
  if (state.mode !== "drills" && state.deal !== DEFAULT_TRAIN_STATE.deal) params.set("deal", state.deal);
  if (state.mode === "drills") {
    if (state.spots) params.set("spots", state.spots.join(","));
    if (state.all) params.set("all", "1");
    if (state.inaccurate) params.set("inaccurate", "1");
  }
  return params.toString();
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
    return trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "preflop", family: target.family, seat: target.seat, vs: target.vs });
  }
  return trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "river", pot: target.pot, side: target.side, role: target.role });
}
