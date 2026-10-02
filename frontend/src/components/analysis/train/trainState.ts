/**
 * The trainer's address bar: which trainer, its settings, and — for "Drill
 * this" on a leak — the leak's spot keys. Pure, so a link from Leaks and the
 * page that reads it cannot disagree.
 */

import type { ChartPosition } from "../../../lib/charts";
import {
  DEAL_BIASES,
  PREFLOP_FAMILIES,
  PREFLOP_SEATS,
  RIVER_POTS,
  RIVER_SEATS,
  type DealBias,
  type PreflopFamily,
  type RiverPot,
  type RiverSeat,
} from "../../../lib/training";

export const TRAIN_MODES = ["preflop", "river", "drills"] as const;
export type TrainMode = (typeof TRAIN_MODES)[number];

export interface TrainState {
  mode: TrainMode;
  family: PreflopFamily | "random";
  seat: ChartPosition | null;
  deal: DealBias;
  pot: RiverPot | "any";
  side: RiverSeat | "any";
  /** Drills: only these finest spot keys (a leak). */
  spots: string[] | null;
  /** Drills: every drill, not only the due ones. */
  all: boolean;
  /** Drills: Inaccurate moves too. */
  inaccurate: boolean;
}

export const DEFAULT_TRAIN_STATE: TrainState = {
  mode: "preflop",
  family: "random",
  seat: null,
  deal: "borderline",
  pot: "any",
  side: "any",
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

export function parseTrainState(query: Record<string, string | string[] | undefined>): TrainState {
  const spotsRaw = first(query.spots);
  const spots = spotsRaw
    ? spotsRaw
        .split(",")
        .map((key) => key.trim())
        .filter((key) => SPOT_KEY.test(key))
        .slice(0, MAX_SPOT_KEYS)
    : [];
  const seat = first(query.seat);
  return {
    mode: oneOf(first(query.mode), TRAIN_MODES, spots.length > 0 ? "drills" : DEFAULT_TRAIN_STATE.mode),
    family: oneOf(first(query.family), [...PREFLOP_FAMILIES, "random"] as const, DEFAULT_TRAIN_STATE.family),
    seat: seat && (PREFLOP_SEATS as readonly string[]).includes(seat) ? (seat as ChartPosition) : null,
    deal: oneOf(first(query.deal), DEAL_BIASES, DEFAULT_TRAIN_STATE.deal),
    pot: oneOf(first(query.pot), [...RIVER_POTS, "any"] as const, DEFAULT_TRAIN_STATE.pot),
    side: oneOf(first(query.side), [...RIVER_SEATS, "any"] as const, DEFAULT_TRAIN_STATE.side),
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
    if (state.family !== DEFAULT_TRAIN_STATE.family) params.set("family", state.family);
    if (state.seat) params.set("seat", state.seat);
  }
  if (state.mode === "river") {
    if (state.pot !== DEFAULT_TRAIN_STATE.pot) params.set("pot", state.pot);
    if (state.side !== DEFAULT_TRAIN_STATE.side) params.set("side", state.side);
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
