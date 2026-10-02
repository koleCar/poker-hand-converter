/**
 * Range narrowing through a heads-up hand (phase A4, `docs/ANALYSIS-PLAN.md`
 * §3.2 "Inputs").
 *
 * Each player starts from a preflop range — the charts' range for their line
 * where a chart node exists (`chartRange`), the labelled placeholder
 * (`ranges.ts`) where it does not — expanded to the 1,326 combos. Every
 * postflop action then multiplies each combo's weight by how likely that combo
 * is to take that action:
 *
 *     w'(c) = w(c) · L(c | action, board, both ranges)
 *
 * That is Bayes' rule with the actor's strategy as the likelihood, and it is
 * what a solver does inside its own tree. Before A5 there is no flop or turn
 * strategy to read `L` from, so the likelihood here is a **heuristic model**,
 * written down below, deterministic and tested. Every grade that rests on it
 * carries the `narrowing-heuristic` approximation.
 *
 * ## The model (`heuristic/2`)
 *
 * **Strength.** For each combo, its *hand strength* HS: the share of the
 * opponent's current range it beats now (ties half), with card removal — a
 * combo cannot be held against a combo that shares a card. On the flop and
 * turn, draws add potential: outs from the draw classes of `texture.ts`
 * (flush draw 9, open-ender 8, gutshot 4, two overcards 3, a backdoor 1),
 * turned into the chance of hitting by the next card(s), and
 *
 *     EHS = HS + (1 − HS) · P(hit) · DRAW_REALISATION
 *
 * Each combo's percentile `q` is then its rank by EHS within the *actor's own*
 * range, weights counted: 1 is the top of the range, 0 the bottom.
 *
 * **Likelihoods** (every one in `[FLOOR, 1]`, so a weight only ever goes down
 * and nothing is ever ruled out completely — a real player is never perfectly
 * balanced, and a solver must still reach the line):
 *
 * - **Bet / raise** of `x` × the pot: *value* is the top `VALUE_SHARE` of the
 *   range (`L = 1`, ramping down over `RAMP` below it); *strong draws* (8+
 *   outs) `DRAW_BET`, weaker draws half that; the *bottom* of the range
 *   (`q < BLUFF_ZONE`, no draw) bluffs at a rate `λ` solved so that bluffs and
 *   draws are `T(x) = x / (1 + 2x)` of the betting range — the share that
 *   makes a bluff-catcher indifferent on the river — scaled up on the flop and
 *   turn (`BLUFF_STREET`), where draws carry equity. Everything else, the
 *   middle, is `FLOOR`: medium hands mostly check.
 * - **Call** of a bet of `x` × the pot: the caller defends the top
 *   `MDF = 1 / (1 + x)` of its range (a ramp of `RAMP` around the cut), draws
 *   keep calling (`DRAW_CALL`), and the very top calls only `TOP_CALL`
 *   of the time — the rest of it raises.
 * - **Check**: the range is *capped* partially — value checks `CHECK_VALUE`
 *   of the time (traps and pot control), the middle always, draws
 *   `CHECK_DRAW`, the bottom `CHECK_AIR` (the rest of it bluffed). **A
 *   repeated check trims less**: the actor's `k`-th earlier postflop check
 *   scales the trim by `CHECK_REPEAT^k`. A player who has already checked is
 *   capped; checking again is mostly pot control, not new information, and
 *   trimming three checks at full strength left a "check, check, check"
 *   range as nothing but air with no medium hands — which made a river bluff
 *   look mandatory (`heuristic/1`, A4's first library run).
 *
 * The constants are part of `ANALYSIS_VERSION`: changing one re-narrows every
 * stored river grade.
 *
 * ## Designed to be replaced
 *
 * `NarrowingModel` is the seam. A5 brings flop and turn strategies; a model
 * that reads `L(c)` from them (`strategy[action][combo]` at the node, exactly
 * as `rangesAt` does inside a solve) drops in through the same interface, and
 * the river solve downstream does not change. The flop library (A5b,
 * `flopLibrary.ts`'s `libraryModel`, behind `FLOP_LIBRARY_ENABLED`) is the
 * first such model: it finds the node from `NarrowInput.actionIndex`.
 */

import { evaluateMasks, STANDARD } from "../equity/evaluator";
import type { ClassWeights, WeightedCombo } from "../equity/range";
import { classByName, comboHi, comboLo, combosOfClass, NUM_COMBOS } from "../solver";
import { draws } from "./texture";

/** The model's id, stored with every river grade. */
export const NARROWING_MODEL = "heuristic/2";

/** The least any likelihood is: nothing is ever ruled out completely. */
export const FLOOR = 0.03;
/** The top share of a range that bets or raises for value. */
export const VALUE_SHARE = { flop: 0.4, turn: 0.33, river: 0.28, raise: 0.14 } as const;
/** Width (in percentiles) of the ramp between a region and the next. */
export const RAMP = 0.12;
/** The bottom share of a range (without a draw) that bluffs. */
export const BLUFF_ZONE = 0.35;
/** Bluffs and draws as a share of the betting range, × T(x), per street. */
export const BLUFF_STREET = { flop: 1.5, turn: 1.25, river: 1 } as const;
/** The most bluffs and draws a betting range is assumed to hold. */
export const MAX_BLUFF_SHARE = 0.5;
/** Likelihood a strong draw (8+ outs) bets; a weak one (4–7 outs) half of it. */
export const DRAW_BET = 0.75;
/** Likelihood a strong draw calls; a weak one `DRAW_CALL / 2`. */
export const DRAW_CALL = 1;
/** The top of a calling range that calls rather than raises. */
export const TOP_CALL = 0.6;
/** Where "the top" starts, as a percentile. */
export const TOP_ZONE = 0.95;
/** Value checks this often (a slowplay); the rest of it bets. */
export const CHECK_VALUE = 0.5;
/** Each earlier postflop check by the same player scales the next check's trim by this. */
export const CHECK_REPEAT = 0.5;
export const CHECK_DRAW = 0.6;
export const CHECK_AIR = 0.7;
/** How much of a draw's chance of hitting turns into equity. */
export const DRAW_REALISATION = 0.75;
/** Outs that make a draw "strong". */
export const STRONG_DRAW_OUTS = 8;
/** Outs below this are no draw at all (a backdoor is not a reason to bet). */
export const WEAK_DRAW_OUTS = 4;

export type NarrowStreet = "flop" | "turn" | "river";

/** An action as the narrowing reads it. */
export interface NarrowAction {
  kind: "check" | "bet" | "call" | "raise";
  /**
   * A bet: its size over the pot it went into. A raise: the increment over
   * the call, over the pot after the call (the convention of
   * `lib/solver/betting.ts`). A call: the size of the bet being called, as a
   * bet. Null for a check.
   */
  sizePot: number | null;
  allIn: boolean;
  /** How many times the actor has already checked after the flop in this hand. */
  checksBefore?: number;
}

export interface NarrowInput {
  street: NarrowStreet;
  /** Card indices of the board on this street. */
  board: readonly number[];
  /** The actor's range before the action, 1,326 weights. */
  actor: Float64Array;
  /** The opponent's range at the same moment. */
  opponent: Float64Array;
  action: NarrowAction;
  /** A precomputed `streetStrength(board)`, to share between actions. */
  strength?: StreetStrength;
  /**
   * `PhfAction.index` of the action being narrowed by. A model that reads a
   * solved tree (the flop library, A5b) finds its node from the street's
   * actions before it; the heuristic ignores it.
   */
  actionIndex?: number;
}

/** How likely each combo of the actor's range is to take the action: 1,326 values in [0, 1]. */
export interface NarrowingModel {
  readonly id: string;
  likelihood(input: NarrowInput): Float64Array;
}

/* ----------------------------------------------------------------- ranges - */

/** Preflop class weights (`AKs: 0.5`) as 1,326 combo weights. */
export function comboRange(classes: ClassWeights): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  for (const [name, weight] of classes) {
    if (!(weight > 0)) continue;
    const k = classByName(name);
    if (k < 0) continue;
    for (const combo of combosOfClass(k)) out[combo] = Math.min(1, weight);
  }
  return out;
}

/** Zeroes every combo holding one of `cards`, in place. */
export function removeCards(range: Float64Array, cards: readonly number[]): Float64Array {
  if (cards.length === 0) return range;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (range[c] > 0 && (cards.includes(comboHi(c)) || cards.includes(comboLo(c)))) range[c] = 0;
  }
  return range;
}

/** Σ weights, optionally without the combos holding `dead` cards. */
export function rangeWeight(range: ArrayLike<number>, dead: readonly number[] = []): number {
  let sum = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (range[c] > 0 && (dead.length === 0 || (!dead.includes(comboHi(c)) && !dead.includes(comboLo(c))))) {
      sum += range[c];
    }
  }
  return sum;
}

/** A range as weighted combos for `equityVsRange`, relative weights scaled into (0, 1]. */
export function weightedCombos(range: ArrayLike<number>): WeightedCombo[] {
  let max = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) max = Math.max(max, range[c]);
  const out: WeightedCombo[] = [];
  if (!(max > 0)) return out;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (range[c] > 0) out.push({ cards: [comboHi(c), comboLo(c)], weight: range[c] / max });
  }
  return out;
}

/* --------------------------------------------------------------- strength - */

/** What one board says about every combo, independent of anyone's range. */
export interface StreetStrength {
  board: number[];
  /** Evaluator value of each combo with the board; -1 where the combo holds a board card. */
  value: Int32Array;
  /** Estimated outs (flop and turn); 0 on the river. */
  outs: Float32Array;
}

const OUTS: Record<string, number> = {
  "flush-draw": 9,
  "nut-flush-draw": 9,
  oesd: 8,
  gutshot: 4,
  overcards: 3,
  "backdoor-flush": 1,
  "backdoor-straight": 1,
};
/** A flush draw and a straight draw share about two outs. */
const MAX_OUTS = 15;

/** Each combo's value on a board, and its outs before the river. */
export function streetStrength(board: readonly number[]): StreetStrength {
  const masks = [0, 0, 0, 0];
  for (const card of board) masks[card & 3] |= 1 << (card >> 2);
  const value = new Int32Array(NUM_COMBOS).fill(-1);
  const outs = new Float32Array(NUM_COMBOS);
  const drawStreet = board.length < 5;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const a = comboHi(c);
    const b = comboLo(c);
    if (board.includes(a) || board.includes(b)) continue;
    const m = masks.slice();
    m[a & 3] |= 1 << (a >> 2);
    m[b & 3] |= 1 << (b >> 2);
    value[c] = evaluateMasks(STANDARD, m[0], m[1], m[2], m[3]);
    if (drawStreet) {
      let n = 0;
      for (const kind of draws([a, b], board)) n += OUTS[kind] ?? 0;
      outs[c] = Math.min(MAX_OUTS, n);
    }
  }
  return { board: [...board], value, outs };
}

/**
 * Hand strength of every combo against `opponent`: the share of the
 * opponent's weight it beats, ties counted half, with card removal. NaN where
 * the combo holds a board card or nothing compatible is left.
 *
 * O(n log n): combos sorted by value, one sweep keeping the opponent's weight
 * below and per card, then inclusion–exclusion for the two cards each combo
 * blocks (the same trick the solver's showdown uses).
 */
export function handStrength(strength: StreetStrength, opponent: ArrayLike<number>): Float64Array {
  const { value } = strength;
  const order: number[] = [];
  for (let c = 0; c < NUM_COMBOS; c += 1) if (value[c] >= 0) order.push(c);
  order.sort((x, y) => value[x] - value[y] || x - y);

  const total = new Float64Array(52);
  let all = 0;
  for (const c of order) {
    const w = opponent[c] > 0 ? opponent[c] : 0;
    total[comboHi(c)] += w;
    total[comboLo(c)] += w;
    all += w;
  }

  const out = new Float64Array(NUM_COMBOS).fill(NaN);
  const below = new Float64Array(52);
  let belowAll = 0;
  const group = new Float64Array(52);
  let k = 0;
  while (k < order.length) {
    let end = k;
    while (end < order.length && value[order[end]] === value[order[k]]) end += 1;
    let groupAll = 0;
    for (let j = k; j < end; j += 1) {
      const c = order[j];
      const w = opponent[c] > 0 ? opponent[c] : 0;
      group[comboHi(c)] += w;
      group[comboLo(c)] += w;
      groupAll += w;
    }
    for (let j = k; j < end; j += 1) {
      const c = order[j];
      const hi = comboHi(c);
      const lo = comboLo(c);
      const self = opponent[c] > 0 ? opponent[c] : 0;
      const compatible = all - total[hi] - total[lo] + self;
      const beats = belowAll - below[hi] - below[lo];
      const ties = groupAll - group[hi] - group[lo] + self;
      out[c] = compatible > 1e-12 ? Math.min(1, Math.max(0, (beats + ties / 2) / compatible)) : NaN;
    }
    for (let j = k; j < end; j += 1) {
      const c = order[j];
      const w = opponent[c] > 0 ? opponent[c] : 0;
      below[comboHi(c)] += w;
      below[comboLo(c)] += w;
      group[comboHi(c)] -= w;
      group[comboLo(c)] -= w;
    }
    belowAll += groupAll;
    k = end;
  }
  return out;
}

/** Chance to hit one of `outs` by the river, from a board of `cards`. */
export function hitChance(outs: number, cards: number): number {
  if (outs <= 0 || cards >= 5) return 0;
  const unseen = 52 - 2 - cards;
  let miss = 1;
  for (let k = 0; k < 5 - cards; k += 1) miss *= Math.max(0, 1 - outs / (unseen - k));
  return 1 - miss;
}

/** HS plus the draw potential: §"Strength" above. */
export function effectiveStrength(strength: StreetStrength, hs: Float64Array): Float64Array {
  const out = new Float64Array(NUM_COMBOS).fill(NaN);
  const cards = strength.board.length;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const h = hs[c];
    if (Number.isNaN(h)) continue;
    out[c] = h + (1 - h) * hitChance(strength.outs[c], cards) * DRAW_REALISATION;
  }
  return out;
}

/**
 * Each combo's percentile by `score` within `range`, weights counted: the
 * weight strictly below plus half the weight tied, over the total. NaN for
 * combos not in the range.
 */
export function percentiles(score: Float64Array, range: ArrayLike<number>): Float64Array {
  const live: number[] = [];
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (range[c] > 0 && !Number.isNaN(score[c])) {
      live.push(c);
      total += range[c];
    }
  }
  live.sort((x, y) => score[x] - score[y] || x - y);
  const out = new Float64Array(NUM_COMBOS).fill(NaN);
  if (!(total > 0)) return out;
  let below = 0;
  let k = 0;
  while (k < live.length) {
    let end = k;
    let tied = 0;
    while (end < live.length && score[live[end]] === score[live[k]]) {
      tied += range[live[end]];
      end += 1;
    }
    const q = (below + tied / 2) / total;
    for (let j = k; j < end; j += 1) out[live[j]] = q;
    below += tied;
    k = end;
  }
  return out;
}

/* ------------------------------------------------------------ likelihood - */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0 below `from`, 1 above `to`, linear between. */
function ramp(q: number, from: number, to: number): number {
  if (q <= from) return 0;
  if (q >= to) return 1;
  return (q - from) / (to - from);
}

/** `T(x)`: the share of bluffs that makes a call of `x` × the pot break even. */
export function bluffShare(sizePot: number): number {
  const x = Math.max(0, sizePot);
  return x / (1 + 2 * x);
}

interface Scored {
  q: Float64Array;
  outs: Float32Array;
}

function scored(input: NarrowInput): Scored {
  const strength = input.strength ?? streetStrength(input.board);
  const hs = handStrength(strength, input.opponent);
  const ehs = effectiveStrength(strength, hs);
  return { q: percentiles(ehs, input.actor), outs: strength.outs };
}

function aggressive(input: NarrowInput, { q, outs }: Scored): Float64Array {
  const { street, actor, action } = input;
  const x = action.sizePot !== null && action.sizePot > 0 ? action.sizePot : 0.5;
  const share = action.kind === "raise" ? VALUE_SHARE.raise : VALUE_SHARE[street];
  const cut = 1 - share;
  const target = Math.min(MAX_BLUFF_SHARE, bluffShare(x) * BLUFF_STREET[street]);

  const out = new Float64Array(NUM_COMBOS);
  const bluffZone: number[] = [];
  let valueMass = 0;
  let drawMass = 0;
  let bluffMass = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = actor[c];
    if (!(w > 0) || Number.isNaN(q[c])) continue;
    const value = ramp(q[c], cut - RAMP, cut);
    const o = outs[c];
    const draw = o >= STRONG_DRAW_OUTS ? DRAW_BET : o >= WEAK_DRAW_OUTS ? DRAW_BET / 2 : 0;
    if (draw > value) {
      out[c] = draw;
      drawMass += w * draw;
    } else if (value === 0 && q[c] < BLUFF_ZONE) {
      bluffZone.push(c);
      bluffMass += w;
    } else {
      out[c] = Math.max(FLOOR, value);
      valueMass += w * out[c];
    }
  }
  // λ such that (bluffs + draws) / everything = target.
  const lambda =
    bluffMass > 0 ? clamp01((target * (valueMass + drawMass) - drawMass) / ((1 - target) * bluffMass)) : 0;
  const bluff = Math.max(FLOOR, lambda);
  for (const c of bluffZone) out[c] = bluff;
  return out;
}

function call(input: NarrowInput, { q, outs }: Scored): Float64Array {
  const { actor, action } = input;
  const x = action.sizePot !== null && action.sizePot > 0 ? action.sizePot : 0.5;
  const cut = x / (1 + x); // fold the bottom 1 − MDF
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!(actor[c] > 0) || Number.isNaN(q[c])) continue;
    let made = ramp(q[c], cut - RAMP / 2, cut + RAMP / 2);
    if (q[c] >= TOP_ZONE) made = TOP_CALL;
    const o = outs[c];
    const draw = o >= STRONG_DRAW_OUTS ? DRAW_CALL : o >= WEAK_DRAW_OUTS ? DRAW_CALL / 2 : 0;
    out[c] = Math.max(FLOOR, made, draw);
  }
  return out;
}

function check(input: NarrowInput, { q, outs }: Scored): Float64Array {
  const { street, actor } = input;
  const repeat = Math.pow(CHECK_REPEAT, Math.max(0, input.action.checksBefore ?? 0));
  const cut = 1 - VALUE_SHARE[street];
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!(actor[c] > 0) || Number.isNaN(q[c])) continue;
    const o = outs[c];
    if (o >= STRONG_DRAW_OUTS) {
      out[c] = 1 - (1 - CHECK_DRAW) * repeat;
      continue;
    }
    const value = ramp(q[c], cut - RAMP, cut);
    const air = q[c] < BLUFF_ZONE && o < WEAK_DRAW_OUTS ? 1 - ramp(q[c], BLUFF_ZONE - RAMP, BLUFF_ZONE) : 0;
    // Value fades to CHECK_VALUE, air to CHECK_AIR, the middle checks.
    out[c] = Math.max(FLOOR, 1 - repeat * (value * (1 - CHECK_VALUE) + air * (1 - CHECK_AIR)));
  }
  return out;
}

/** The `heuristic/2` model: see the header. */
export const heuristicModel: NarrowingModel = {
  id: NARROWING_MODEL,
  likelihood(input: NarrowInput): Float64Array {
    const s = scored(input);
    switch (input.action.kind) {
      case "bet":
      case "raise":
        return aggressive(input, s);
      case "call":
        return call(input, s);
      case "check":
      default:
        return check(input, s);
    }
  },
};

/**
 * The same model at half the strength: every likelihood `L` becomes `√L`,
 * i.e. each action counts as half the evidence. The sensitivity check of a
 * river grade (`analyze.ts`) re-solves with it: a grade that moves by more
 * than one class between the two narrowings rests on the narrowing, not on
 * the hand.
 */
export function halved(model: NarrowingModel): NarrowingModel {
  return {
    id: `${model.id}-half`,
    likelihood(input: NarrowInput): Float64Array {
      const out = model.likelihood(input);
      for (let c = 0; c < out.length; c += 1) out[c] = Math.sqrt(Math.max(0, out[c]));
      return out;
    },
  };
}

/** One narrowing step: a new range, `actor · L`. Never mutates its input. */
export function narrow(input: NarrowInput, model: NarrowingModel = heuristicModel): Float64Array {
  const likelihood = model.likelihood(input);
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = input.actor[c];
    if (w > 0) out[c] = w * Math.min(1, Math.max(0, likelihood[c] || 0));
  }
  return out;
}
