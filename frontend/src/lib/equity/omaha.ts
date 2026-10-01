/**
 * Omaha hand evaluation: exactly two hole cards and exactly three board cards.
 *
 * The rule is what makes Omaha a different game from "Hold'em with more cards",
 * and it is the rule a seven-card evaluator cannot express - `AhKh` on a
 * four-heart board is not a flush in Omaha unless both hearts come from the
 * hand. So the best hand is the maximum over every 2-of-hole x 3-of-board
 * combination, each evaluated as a plain five-card hand:
 *
 *     PLO  (4 hole cards):  C(4,2) x C(5,3) =  6 x 10 =  60 evaluations
 *     PLO5 (5 hole cards):  C(5,2) x C(5,3) = 10 x 10 = 100 evaluations
 *     PLO6 (6 hole cards):  C(6,2) x C(5,3) = 15 x 10 = 150 evaluations
 *
 * Both halves are prepared as suit masks once - the hole pairs once per hand,
 * the board triples once per board - so each of those evaluations is four ORs
 * and one `evaluateMasks`.
 */

import { cardIndex, evaluateMasks, STANDARD, type RankingTable } from "./evaluator";

/** Suit masks of every k-card subset of `cards`, flattened four ints per subset. */
function subsetMasks(cards: readonly number[], k: 2 | 3): Int32Array {
  const out: number[] = [];
  const n = cards.length;
  const push = (picked: number[]) => {
    const masks = [0, 0, 0, 0];
    for (const card of picked) {
      masks[card & 3] |= 1 << (card >> 2);
    }
    out.push(...masks);
  };
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      if (k === 2) {
        push([cards[a], cards[b]]);
        continue;
      }
      for (let c = b + 1; c < n; c += 1) {
        push([cards[a], cards[b], cards[c]]);
      }
    }
  }
  return Int32Array.from(out);
}

/** Every two-card subset of the hole cards, as suit masks. Built once per hand. */
export function holePairMasks(hole: readonly number[]): Int32Array {
  return subsetMasks(hole, 2);
}

/** Every three-card subset of the board, as suit masks. Built once per board. */
export function boardTripleMasks(board: readonly number[]): Int32Array {
  return subsetMasks(board, 3);
}

/** Best value over every hole pair x board triple. */
export function evaluateOmahaMasks(
  table: RankingTable,
  pairs: Int32Array,
  triples: Int32Array,
): number {
  let best = -1;
  for (let i = 0; i < pairs.length; i += 4) {
    const s = pairs[i];
    const h = pairs[i + 1];
    const d = pairs[i + 2];
    const c = pairs[i + 3];
    for (let j = 0; j < triples.length; j += 4) {
      const value = evaluateMasks(
        table,
        s | triples[j],
        h | triples[j + 1],
        d | triples[j + 2],
        c | triples[j + 3],
      );
      if (value > best) {
        best = value;
      }
    }
  }
  return best;
}

/**
 * Value of the best Omaha hand: `hole` holds 4-6 cards, `board` 3-5.
 *
 * Comparable with other `evaluateOmaha` values on the same board, and with
 * five-card `evaluate` values, but not with six- or seven-card ones.
 */
export function evaluateOmaha(
  hole: readonly (number | string)[],
  board: readonly (number | string)[],
  table: RankingTable = STANDARD,
): number {
  const toIndex = (card: number | string) => {
    const index = typeof card === "number" ? card : cardIndex(card);
    if (index < 0 || index > 51) {
      throw new Error(`not a card: ${String(card)}`);
    }
    return index;
  };
  if (hole.length < 2 || board.length < 3) {
    throw new Error("Omaha needs at least two hole cards and three board cards");
  }
  return evaluateOmahaMasks(
    table,
    holePairMasks(hole.map(toIndex)),
    boardTripleMasks(board.map(toIndex)),
  );
}
