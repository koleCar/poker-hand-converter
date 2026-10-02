/**
 * A game for the CFR engine: a public tree plus each player's private hands.
 *
 * **Hands are card pairs in one card space.** Every private hand is one or two
 * cards drawn from `numCards` (52 for hold'em, 6 for Leduc, 3 for Kuhn). Two
 * hands can meet only if they share no card - card removal - and that one rule
 * is all the engine knows about cards. A one-card game gives every hand a
 * phantom second card that no opposing hand can hold (`numCards + player`), so
 * the same two-card arithmetic works without a branch in the hot loop.
 *
 * **Showdowns are an ordering.** A board's entry lists each player's possible
 * hands sorted by strength. The engine never evaluates a hand; it sweeps the
 * two sorted lists against each other (see `cfr.ts`), which is O(n + m) per
 * showdown node instead of O(n * m). Strength values only have to compare
 * correctly across the two players on the same board - the hold'em builder
 * uses `lib/equity`'s evaluator values directly; toy games use small integers.
 */

import type { FlatTree } from "./tree";

export interface HandSet {
  readonly size: number;
  /** First card of each hand. */
  readonly c1: Uint8Array;
  /** Second card, or the player's phantom card for one-card games. */
  readonly c2: Uint8Array;
  /** Initial reach (range weight) of each hand. */
  readonly weight: Float64Array;
}

export interface ShowdownBoard {
  /** Per player: indices of the hands possible on this board, weakest first. */
  readonly order: readonly [Int32Array, Int32Array];
  /** Per player: strength of `order[k]`, so non-decreasing. */
  readonly strength: readonly [Float64Array, Float64Array];
}

/**
 * A dealt card that a chance node does not deal itself because it is
 * strategically the same as one it does (suit isomorphism, `subgame.ts`).
 * Listed under the card that stands for it: `card` is the card left out, and
 * `map[p][i]` is the index among player p's hands of hand `i` relabelled by
 * the suit permutation that takes `card` to the one dealt.
 */
export interface Mirror {
  readonly card: number;
  readonly map: readonly [Int32Array, Int32Array];
}

export interface Game {
  readonly tree: FlatTree;
  /**
   * Per dealt card (index `0 .. numCards - 1`): the cards it stands for, or
   * undefined. Only a game whose ranges and board are symmetric under those
   * relabellings may carry them; the engine trusts it.
   */
  readonly mirrors?: readonly (readonly Mirror[] | undefined)[];
  /** Real cards are `0 .. numCards - 1`; `numCards + p` is player p's phantom. */
  readonly numCards: number;
  readonly hands: readonly [HandSet, HandSet];
  readonly boards: readonly ShowdownBoard[];
  /** Pot that exploitability is reported against (the pot at the root). */
  readonly pot: number;
  /** Size of a big blind in chips, for exploitability in mbb. Default 1. */
  readonly bigBlind?: number;
}

/**
 * A hand set from `[card1, card2]` pairs. Use `card2 = -1` for one-card games;
 * it becomes the player's phantom card.
 */
export function handSet(
  player: 0 | 1,
  numCards: number,
  cards: readonly (readonly [number, number])[],
  weights: ArrayLike<number>,
): HandSet {
  const size = cards.length;
  const c1 = new Uint8Array(size);
  const c2 = new Uint8Array(size);
  const weight = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    const [a, b] = cards[i];
    if (a < 0 || a >= numCards || b >= numCards || a === b) {
      throw new Error(`bad hand ${a},${b} for a ${numCards}-card game`);
    }
    c1[i] = a;
    c2[i] = b < 0 ? numCards + player : b;
    weight[i] = weights[i];
  }
  return { size, c1, c2, weight };
}

/**
 * A showdown board from each player's per-hand strengths. `NaN` marks a hand
 * that cannot exist on this board (it holds a board card); it is left out of
 * the ordering and gets a value of zero there.
 */
export function showdownBoard(strength0: ArrayLike<number>, strength1: ArrayLike<number>): ShowdownBoard {
  const side = (strength: ArrayLike<number>): [Int32Array, Float64Array] => {
    const ids: number[] = [];
    for (let i = 0; i < strength.length; i += 1) {
      if (!Number.isNaN(strength[i])) {
        ids.push(i);
      }
    }
    // Stable on equal strength, so the order - and with it the floating-point
    // summation order - depends only on the input.
    ids.sort((a, b) => strength[a] - strength[b] || a - b);
    const order = Int32Array.from(ids);
    const sorted = Float64Array.from(ids, (i) => strength[i]);
    return [order, sorted];
  };
  const [o0, s0] = side(strength0);
  const [o1, s1] = side(strength1);
  return { order: [o0, o1], strength: [s0, s1] };
}
