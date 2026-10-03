/**
 * The arithmetic behind the concept pages' calculators.
 *
 * Every function here is a formula a page states in words, so the number a
 * slider shows and the number the text quotes come from the same place. All
 * amounts are in one unit (big blinds, chips — it cancels); every share is a
 * fraction in [0, 1]. Degenerate inputs (a zero pot, a zero bet) return the
 * limit the formula tends to rather than NaN, because a slider can reach them.
 *
 * Two conventions, because pot odds and MDF are quoted against different pots:
 *
 * - **Facing a bet** — `requiredEquity(pot, call)`: `pot` is everything in the
 *   middle *including* the bet you face. That is what a call can win.
 * - **Making a bet** — `mdf`, `alpha`, `bluffShare`: `pot` is the pot *before*
 *   the bet. That is what the bet is trying to win.
 *
 * Pure TypeScript, imported by `tests/test/` under plain Node.
 */

import { EquityInputError, mulberry32 } from "../equity/enumerate";
import { cardIndex, evaluateMasks, STANDARD } from "../equity/evaluator";
import { classCombos, rangeCombos, type ClassWeights, type WeightedCombo } from "../equity/range";

const safe = (num: number, den: number, fallback: number) => (den > 0 ? num / den : fallback);

/* ----------------------------------------------------------- facing a bet - */

/** Equity a call needs to break even: `call / (pot + call)`, `pot` including the bet faced. */
export function requiredEquity(pot: number, call: number): number {
  return safe(call, pot + call, 0);
}

/** The same price as a ratio, `pot : call` — "3 to 1". */
export function potOddsRatio(pot: number, call: number): number {
  return safe(pot, call, Infinity);
}

/**
 * The EV of calling, against folding, when the hand is decided after the call
 * (an all-in, or the river with no raise behind): win the whole pot `equity`
 * of the time, pay `call` always. `pot` includes the bet faced.
 */
export function callEv(pot: number, call: number, equity: number): number {
  return equity * (pot + call) - call;
}

/* ------------------------------------------------------------- making a bet - */

/**
 * Alpha: how often a bet of `bet` into `pot` must make the opponent fold to
 * break even if it never wins when called. `bet / (pot + bet)`. The same
 * number is the break-even fold rate of any steal or bluff: risk over risk
 * plus reward.
 */
export function alpha(pot: number, bet: number): number {
  return safe(bet, pot + bet, 0);
}

/**
 * Minimum defence frequency: how much of a range has to continue against a
 * bet so that a bluff with no equity cannot profit. `pot / (pot + bet)`,
 * which is `1 − alpha`.
 */
export function mdf(pot: number, bet: number): number {
  return safe(pot, pot + bet, 1);
}

/**
 * The bluff share of a perfectly polarised river betting range — nuts or air —
 * that leaves a bluff-catcher indifferent: `bet / (pot + 2·bet)`. It is the
 * caller's required equity, because the caller wins exactly when they meet a
 * bluff.
 */
export function bluffShare(pot: number, bet: number): number {
  return safe(bet, pot + 2 * bet, 0);
}

/* ------------------------------------------------------------ multiway - */

/**
 * The chance that every one of `opponents` players folds, when each folds
 * `foldEach` of the time independently: `foldEach^opponents`. Fold equity
 * multiplies down with every extra player.
 */
export function allFold(foldEach: number, opponents: number): number {
  return Math.pow(Math.min(1, Math.max(0, foldEach)), Math.max(0, Math.floor(opponents)));
}

/**
 * The MDF split: how much of their range each of `defenders` players must
 * continue with so that, defending independently, they all fold no more than
 * alpha together: `1 − alpha^(1/defenders)`. One defender: the MDF.
 */
export function mdfSplit(pot: number, bet: number, defenders: number): number {
  const k = Math.max(1, Math.floor(defenders));
  return 1 - Math.pow(alpha(pot, bet), 1 / k);
}

/**
 * EV of a bet that never wins when called, into `opponents` players who each
 * fold `foldEach` of the time: win the pot when all fold, lose the bet
 * otherwise.
 */
export function multiwayBluffEv(pot: number, bet: number, foldEach: number, opponents: number): number {
  const folds = allFold(foldEach, opponents);
  return folds * pot - (1 - folds) * bet;
}

/** Value combos per bluff combo in that range: `(pot + bet) / bet`. */
export function valuePerBluff(pot: number, bet: number): number {
  return safe(pot + bet, bet, Infinity);
}

/**
 * EV of a bet or raise that risks `risk` to win `pot`, if it wins every time
 * the opponent folds and never when called — the worst case, and the one alpha
 * is defined on. Real bluffs keep some equity when called, so this is a floor.
 */
export function bluffEv(pot: number, risk: number, foldRate: number): number {
  return foldRate * pot - (1 - foldRate) * risk;
}

/**
 * EV of calling a river bet with a pure bluff-catcher — a hand that beats every
 * bluff and loses to every value bet — when `bluffs` of the betting range is
 * bluffs. `pot` is before the bet. Zero exactly at `bluffShare(pot, bet)`.
 */
export function bluffCatcherEv(pot: number, bet: number, bluffs: number): number {
  return bluffs * (pot + bet) - (1 - bluffs) * bet;
}

/**
 * What a river value bet gains over checking, per decision, when the opponent
 * calls `callRate` of the time and you beat `beatShare` of the hands that call.
 * Assumes no raise, and that a check would have gone to showdown against the
 * same hands — the textbook "thin value" frame: bet when more than half the
 * calls are worse.
 */
export function valueBetGain(bet: number, callRate: number, beatShare: number): number {
  return callRate * bet * (2 * beatShare - 1);
}

/** Raw equity scaled by how much of it a hand turns into pot share. Capped at 1. */
export function realisedEquity(equity: number, realisation: number): number {
  return Math.min(1, Math.max(0, equity * realisation));
}

/* -------------------------------------------------------------- geometry - */

/** Stack-to-pot ratio: effective stack behind over the pot, at the start of a street. */
export function spr(stack: number, pot: number): number {
  return safe(stack, pot, Infinity);
}

/**
 * The bet, as a fraction of the pot, that gets the stacks in over `streets`
 * equal bets that are each called. Each bet `f·pot` called makes the pot
 * `pot·(1 + 2f)`, so after `n` streets the pot is `pot·(1 + 2f)^n`, and all in
 * means that equals `pot + 2·stack`:
 *
 *     f = ((1 + 2·stack/pot)^(1/n) − 1) / 2
 */
export function geometricBet(pot: number, stack: number, streets: number): number {
  if (pot <= 0 || streets <= 0) return Infinity;
  if (stack <= 0) return 0;
  return (Math.pow(1 + (2 * stack) / pot, 1 / streets) - 1) / 2;
}

/** How many called pot-sized bets the stacks hold: `log(1 + 2·SPR) / log 3`. */
export function potSizedBets(pot: number, stack: number): number {
  if (pot <= 0) return Infinity;
  if (stack <= 0) return 0;
  return Math.log(1 + (2 * stack) / pot) / Math.log(3);
}

/* ---------------------------------------------------------------- combos - */

export interface ClassCount {
  /** `AKs`, `QQ`, `AKo`. */
  name: string;
  /** Combos before any card is removed: 6, 4 or 12. */
  total: number;
  /** Combos left once the dead cards are taken out. */
  left: number;
}

/**
 * Combos of each class left when `dead` cards (your hand, the board) are out
 * of the deck. Blockers in one table: with the `A♠` in your hand there are 3
 * combos of `AA` instead of 6, and 12 of `AK` instead of 16.
 */
export function countCombos(classes: readonly string[], dead: readonly string[]): ClassCount[] {
  const out = new Set<number>();
  for (const code of dead) {
    const index = cardIndex(code);
    if (index < 0) throw new EquityInputError(`not a card: ${code}`);
    out.add(index);
  }
  return classes.map((name) => {
    const combos = classCombos(name);
    return { name, total: combos.length, left: combos.filter(([a, b]) => !out.has(a) && !out.has(b)).length };
  });
}

/* ---------------------------------------------------------- range vs range - */

function boardIndices(board: readonly string[], seen: Set<number>): number[] {
  return board.map((code) => {
    const index = cardIndex(code);
    if (index < 0) throw new EquityInputError(`not a card: ${code}`);
    if (seen.has(index)) throw new EquityInputError(`${code} appears twice`);
    seen.add(index);
    return index;
  });
}

function masksOf(cards: readonly number[]): number[] {
  const masks = [0, 0, 0, 0];
  for (const card of cards) masks[card & 3] |= 1 << (card >> 2);
  return masks;
}

function value(masks: readonly number[], a: number, b: number): number {
  const own = [masks[0], masks[1], masks[2], masks[3]];
  own[a & 3] |= 1 << (a >> 2);
  own[b & 3] |= 1 << (b >> 2);
  return evaluateMasks(STANDARD, own[0], own[1], own[2], own[3]);
}

function pick(combos: readonly WeightedCombo[], cumulative: Float64Array, random: () => number): WeightedCombo {
  const target = random() * cumulative[cumulative.length - 1];
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return combos[lo];
}

function cumulate(combos: readonly WeightedCombo[]): Float64Array {
  const out = new Float64Array(combos.length);
  let sum = 0;
  combos.forEach((combo, index) => {
    sum += combo.weight;
    out[index] = sum;
  });
  return out;
}

export interface RangeVsRangeResult {
  /** Range A's share of the pot over every sampled matchup and runout. */
  equity: number;
  /** Matchups sampled. 0 when one range is empty after card removal. */
  samples: number;
}

/**
 * Range A's equity against range B on a board: the "range advantage" number.
 *
 * Sampled, deterministically: a combo from each range by weight (a pair that
 * shares a card is drawn again), then the rest of the board. `trials` samples
 * with a fixed seed, so the same question gives the same answer every time —
 * a teaching widget that wobbles on a re-render would teach the wrong thing.
 */
export function rangeVsRange(
  a: ClassWeights,
  b: ClassWeights,
  board: readonly string[] = [],
  trials = 12_000,
  seed = 0x1ea4,
): RangeVsRangeResult {
  const seen = new Set<number>();
  const boardCards = boardIndices(board, seen);
  if (boardCards.length > 5 || boardCards.length === 1 || boardCards.length === 2) {
    throw new EquityInputError(`a board of ${boardCards.length} cards is not a street`);
  }
  const combosA = rangeCombos(a, seen);
  const combosB = rangeCombos(b, seen);
  if (combosA.length === 0 || combosB.length === 0) {
    return { equity: 0.5, samples: 0 };
  }
  const cumA = cumulate(combosA);
  const cumB = cumulate(combosB);
  const random = mulberry32(seed);
  const missing = 5 - boardCards.length;
  const deck: number[] = [];
  for (let card = 0; card < 52; card += 1) if (!seen.has(card)) deck.push(card);

  let share = 0;
  let samples = 0;
  const boardMasks = masksOf(boardCards);
  for (let trial = 0; trial < trials; trial += 1) {
    const x = pick(combosA, cumA, random);
    let y: WeightedCombo | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = pick(combosB, cumB, random);
      const [c, d] = candidate.cards;
      if (c !== x.cards[0] && c !== x.cards[1] && d !== x.cards[0] && d !== x.cards[1]) {
        y = candidate;
        break;
      }
    }
    if (!y) continue;
    const used = new Set([...x.cards, ...y.cards]);
    const masks = [...boardMasks];
    // Draw the runout without replacement from what is left.
    let drawn = 0;
    const taken = new Set<number>();
    while (drawn < missing) {
      const card = deck[Math.floor(random() * deck.length)];
      if (used.has(card) || taken.has(card)) continue;
      taken.add(card);
      masks[card & 3] |= 1 << (card >> 2);
      drawn += 1;
    }
    const va = value(masks, x.cards[0], x.cards[1]);
    const vb = value(masks, y.cards[0], y.cards[1]);
    share += va > vb ? 1 : va === vb ? 0.5 : 0;
    samples += 1;
  }
  return { equity: samples > 0 ? share / samples : 0.5, samples };
}

/**
 * §4's nut advantage: the share of a range that holds one of the strongest
 * `top` (10%) of all hands possible on this board right now.
 *
 * "All hands possible" is every two-card holding the board leaves, ranked by
 * what it makes with the board; the cut is the hand value at which the top
 * share is reached, ties included. A range's share is its combos at or above
 * that value, by weight, after card removal. Flop or later only.
 */
export function nutShare(range: ClassWeights, board: readonly string[], top = 0.1): number {
  const seen = new Set<number>();
  const boardCards = boardIndices(board, seen);
  if (boardCards.length < 3) {
    throw new EquityInputError("nut share needs a flop or later");
  }
  const masks = masksOf(boardCards);
  const all: number[] = [];
  for (let a = 0; a < 52; a += 1) {
    if (seen.has(a)) continue;
    for (let b = a + 1; b < 52; b += 1) {
      if (seen.has(b)) continue;
      all.push(value(masks, a, b));
    }
  }
  all.sort((x, y) => y - x);
  const cut = all[Math.max(0, Math.ceil(all.length * top) - 1)];
  const combos = rangeCombos(range, seen);
  let total = 0;
  let strong = 0;
  for (const combo of combos) {
    total += combo.weight;
    if (value(masks, combo.cards[0], combo.cards[1]) >= cut) strong += combo.weight;
  }
  return total > 0 ? strong / total : 0;
}
