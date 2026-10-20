/**
 * Population preflop ranges for opponents' flat calls and limps
 * (analysis/19, `docs/ANALYSIS-PLAN.md` §10 2026-10-10, population callers).
 *
 * The charts' flat-calling ranges explain the hands real callers show down
 * far worse than even the placeholder (`analysis/18`: cold calls −9.75
 * against −8.34 per combo), and nothing narrower than any two cards explains
 * shown limps (`analysis/17`). These ranges were fitted on the shown hands of
 * the opponents in the owner's library, as a shape: one logistic over nine
 * class features shared by every line, and an intercept per line,
 *
 *     weight[class] = σ(β · features(class) + α[line])
 *
 * fitted with a correction for the showdown's lean (each class's propensity
 * to be shown, measured on the same players' open-raises against the charts'
 * open ranges) and with each player weighted by how often they play the line
 * against how often they show it down. Only these 14 numbers are stored -
 * no hand, and nothing per player. Held out (five folds by player, and by
 * date), they explain shown hands better than the placeholder, the charts and
 * any two cards on every line (§10).
 *
 * Only for opponents (`PreflopRangeOptions.populationHero`): the hero's own
 * range stays the charts' or the placeholder, and the trainers, which build
 * their spots from the charts, do not ask for these.
 */

import { allClasses, type ClassWeights } from "../equity/range";
import type { PhfHand, Position } from "../phf/types";
import type { StatsContext } from "../stats/context";
import { preflopLine } from "./ranges";

/** The fit's name, quoted by the docs and the tests. */
export const POPULATION_RANGES = "population/1" as const;

/** The lines a population range is fitted for. */
export type PopulationLine = "cold-call" | "bb-defence" | "first-limp" | "over-limp" | "limp-call";

const RANKS = "23456789TJQKA";

/**
 * A class's features: constant, pair, suited, high rank / 12, low rank / 12,
 * gap (0-4, non-pairs) / 4, an ace with another card, both cards T or
 * higher, pair × low rank / 12.
 */
function features(name: string): number[] {
  const hi = RANKS.indexOf(name[0]);
  const lo = RANKS.indexOf(name[1]);
  const pair = name.length === 2 ? 1 : 0;
  const suited = name.endsWith("s") ? 1 : 0;
  const gap = pair ? 0 : Math.min(hi - lo - 1, 4) / 4;
  return [1, pair, suited, hi / 12, lo / 12, gap, hi === 12 && !pair ? 1 : 0, lo >= 8 ? 1 : 0, (pair * lo) / 12];
}

/** β: the shared shape (`population/1`). */
const SHAPE = [-0.443, 1.609, 1.578, 1.046, 1.105, -1.779, 2.221, 0.18, -3.071] as const;

/** α: each line's shift of the shared shape (`population/1`). */
const SHIFT: Record<PopulationLine, number> = {
  "cold-call": -0.693,
  "bb-defence": -0.343,
  "first-limp": 0.095,
  "over-limp": 0.294,
  "limp-call": 0.023,
};

const cache = new Map<PopulationLine, ClassWeights>();

/** The population range of a line, by class (weights in 0..1). */
export function populationRange(line: PopulationLine): ClassWeights {
  let range = cache.get(line);
  if (!range) {
    const out = new Map<string, number>();
    for (const name of allClasses()) {
      const z = features(name).reduce((sum, x, j) => sum + x * SHAPE[j], 0) + SHIFT[line];
      out.set(name, Math.round(10_000 / (1 + Math.exp(-z))) / 10_000);
    }
    range = out;
    cache.set(line, range);
  }
  return range;
}

/** The population order's name (analysis/31), quoted by the docs and the tests. */
export const POPULATION_ORDER = "population-order/1" as const;

/**
 * The share of an opponent's chart or placeholder range that takes the
 * population's order (analysis/31, §10 2026-10-20, opponents' chart ranges).
 * Chosen held out on the unselected river-showdown score: in every fold of
 * 0.25 … 1, by hand and by player.
 */
export const POPULATION_ORDER_MIX = 0.75;

/** The shape's pair × low-rank term, left out of the population order. */
const PAIR_LOW = 8;
const comboCount = (name: string) => (name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12);
let shapeLogits: Map<string, number> | null = null;

/**
 * An opponent's chart or placeholder range in the population's order
 * (analysis/31): the same number of combos (its width), but
 * `POPULATION_ORDER_MIX` of it spread by `population/1`'s shared shape,
 *
 *     w'[class] = (1 − m) · w[class] + m · σ(β · features(class) + a),
 *
 * with `a` set so the shape holds as many combos as the range, and β without
 * its last term (pair × low rank): that term puts big pairs below small ones
 * on the flat-calling lines it was fitted on, where big pairs leave by
 * re-raising - not on the raises this mostly reads. Players open, isolate
 * and 3-bet about as often as the charts say (opens within a few points by
 * position, 3-bets less), but with more of the hands the population plays -
 * weak aces and suited hands, fewer offsuit broadways and middle pairs -
 * than the solver's selection (an UTG open: A9o-A2o 0 → 0.12-0.19, KQo
 * 1 → 0.43, AA 0.96 → 0.75); a river showdown
 * scored with the losers' mucks counted (not only the hands shown, which are
 * selected on winning) says so by half a nat per spot. No number is fitted
 * here but `POPULATION_ORDER_MIX`.
 */
export function populationOrdered(range: ClassWeights): ClassWeights {
  shapeLogits ??= new Map(allClasses().map((name) => [name, features(name).reduce((sum, x, j) => sum + (j === PAIR_LOW ? 0 : x * SHAPE[j]), 0)]));
  let width = 0;
  for (const [name, weight] of range) if (weight > 0) width += Math.min(1, weight) * comboCount(name);
  if (!(width > 0)) return range;
  let lo = -30;
  let hi = 30;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    let held = 0;
    for (const [name, z] of shapeLogits) held += comboCount(name) / (1 + Math.exp(-(z + mid)));
    if (held > width) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  const m = POPULATION_ORDER_MIX;
  const out = new Map<string, number>();
  for (const [name, z] of shapeLogits) {
    const w = Math.min(1, Math.max(0, range.get(name) ?? 0));
    const next = (1 - m) * w + m / (1 + Math.exp(-(z + a)));
    if (next > 0) out.set(name, next);
  }
  return out;
}

/**
 * Whether an opponent's chart or placeholder range takes the population's
 * order (analysis/31): hold'em, no limit, and nobody all-in preflop before
 * `beforeIndex` (an all-in's ranges were never measured).
 */
export function populationOrderApplies(hand: PhfHand, beforeIndex: number): boolean {
  if (hand.game.variant !== "holdem" || hand.game.limit !== "nl") return false;
  return !hand.actions.some((action) => action.street === "preflop" && action.allIn && action.index < beforeIndex);
}

/**
 * The population line a seat's preflop play falls on, or null: a flat call of
 * a single raise (`cold-call`, the big blind's `bb-defence`), a limp from a
 * seat other than the blinds first in (`first-limp`) or behind a limper
 * (`over-limp`), or such a limp then a call of the raise behind it
 * (`limp-call`). Null in a game the fit never saw - not NLHE cash, an ante, a
 * straddle, a bomb pot - and when anyone was all-in preflop before
 * `beforeIndex` (a call of an all-in is another decision).
 */
export function populationLine(hand: PhfHand, context: StatsContext, seat: number, beforeIndex: number): PopulationLine | null {
  const game = hand.game;
  if (game.variant !== "holdem" || game.limit !== "nl" || game.format !== "cash") return null;
  for (const action of hand.actions) {
    if (action.type === "ante" || action.type === "straddle" || action.type === "bomb-ante") return null;
    if (action.street === "preflop" && action.allIn && action.index < beforeIndex) return null;
  }
  const line = preflopLine(context, seat);
  if (line !== "call" && line !== "limp") return null;
  const position = (context.position.get(seat) ?? null) as Position | null;
  const blind = position === "SB" || position === "BB";
  const mine = (context.byStreet.get("preflop") ?? []).filter(
    (decision) => decision.seat === seat && (decision.type === "call" || decision.type === "raise" || decision.type === "bet"),
  );
  if (mine.length === 0) return null;
  if (line === "call") {
    const first = mine[0];
    if (!blind && first.type === "call" && first.raisesBefore === 0) return "limp-call";
    return position === "BB" ? "bb-defence" : "cold-call";
  }
  if (blind) return null;
  return mine[mine.length - 1].enteredBefore.length > 0 ? "over-limp" : "first-limp";
}
