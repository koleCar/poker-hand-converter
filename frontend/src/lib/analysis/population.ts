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
