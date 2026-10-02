/**
 * Suit isomorphism: one canonical spelling per strategically identical spot.
 *
 * Poker does not rank suits, so relabelling them - hearts become spades,
 * spades become clubs - changes nothing about the game. `Ah Kd 7c` with ranges
 * R is the same spot as `As Kh 7d` with R relabelled the same way, and must get
 * the same (relabelled) answer. Two consequences:
 *
 *  - **Cache sharing.** A spot is solved and cached once in its canonical
 *    spelling; every isomorphic spot maps onto it (`canonicalSpot`) and maps
 *    the answer back with the inverse permutation (`permuteCombo`).
 *  - **A correctness check.** Solving a spot and its relabelled copy must give
 *    the same strategy combo for combo; the tests do exactly that.
 *
 * **Canonical form.** Of the 24 suit permutations, the one whose relabelled
 * board is lexicographically smallest - flop cards high to low (the flop is a set),
 * turn and river kept in place (they are not) - with ties broken by the
 * relabelled ranges, compared weight by weight in combo order. Since
 * `rank * 4 + suit` sorts suits `s < h < d < c` within a rank, the result reads
 * naturally: the highest flop card gets spades, the next new suit hearts.
 *
 * The board alone (`canonicalBoard`) is what the spot key uses: the ranges at a
 * node are a deterministic, suit-equivariant function of the board and the
 * line, so the board's permutation carries them along. The joint form
 * (`canonicalSpot`) is for solver input that came from anywhere else.
 */

import { cardCode } from "../equity";
import { comboHi, comboIndex, comboLo, NUM_COMBOS, parseCards, toRange, type RangeInput } from "./combos";

/** All 24 permutations of the suits `0..3`; `perm[s]` is the new suit of suit `s`. */
export const SUIT_PERMUTATIONS: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  const rec = (prefix: number[]) => {
    if (prefix.length === 4) {
      out.push(prefix);
      return;
    }
    for (let s = 0; s < 4; s += 1) {
      if (!prefix.includes(s)) {
        rec([...prefix, s]);
      }
    }
  };
  rec([]);
  return out;
})();

/** A card with its suit relabelled. */
export function permuteCard(card: number, perm: readonly number[]): number {
  return (card & ~3) | perm[card & 3];
}

/** A combo with both cards' suits relabelled. */
export function permuteCombo(combo: number, perm: readonly number[]): number {
  return comboIndex(permuteCard(comboHi(combo), perm), permuteCard(comboLo(combo), perm));
}

/** The permutation that undoes `perm`. */
export function inversePermutation(perm: readonly number[]): number[] {
  const out = [0, 0, 0, 0];
  perm.forEach((to, from) => {
    out[to] = from;
  });
  return out;
}

/** A range relabelled: `out[permuteCombo(c)] = range[c]`. */
export function permuteRange(range: ArrayLike<number>, perm: readonly number[]): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    out[permuteCombo(c, perm)] = range[c];
  }
  return out;
}

/** Relabelled board in its street-structured order: flop high to low, then turn, river. */
function arrangedBoard(board: readonly number[], perm: readonly number[]): number[] {
  const mapped = board.map((card) => permuteCard(card, perm));
  const flop = mapped.slice(0, 3).sort((a, b) => b - a);
  return [...flop, ...mapped.slice(3)];
}

function compareArrays(a: ArrayLike<number>, b: ArrayLike<number>): number {
  for (let k = 0; k < a.length; k += 1) {
    if (a[k] !== b[k]) {
      return a[k] - b[k];
    }
  }
  return 0;
}

export interface CanonicalBoard {
  /** Canonical board as card codes, flop sorted. */
  board: string[];
  /** The permutation that maps the input onto it. */
  perm: number[];
  /** Every permutation that does so (more than one when suits are interchangeable). */
  perms: number[][];
}

/** The canonical spelling of a board (0 to 5 cards). */
export function canonicalBoard(board: readonly (string | number)[]): CanonicalBoard {
  const cards = parseCards(board);
  let best: number[] | null = null;
  let perms: number[][] = [];
  for (const perm of SUIT_PERMUTATIONS) {
    const arranged = arrangedBoard(cards, perm);
    const cmp = best ? compareArrays(arranged, best) : -1;
    if (cmp < 0) {
      best = arranged;
      perms = [perm.slice()];
    } else if (cmp === 0) {
      perms.push(perm.slice());
    }
  }
  return { board: (best as number[]).map(cardCode), perm: perms[0], perms };
}

export interface CanonicalSpot {
  board: string[];
  ranges: [Float64Array, Float64Array];
  /** Maps the input's suits to the canonical ones; invert it to map answers back. */
  perm: number[];
}

/** The canonical spelling of a board together with both ranges. */
export function canonicalSpot(
  board: readonly (string | number)[],
  ranges: readonly [RangeInput, RangeInput],
): CanonicalSpot {
  const { board: canonical, perms } = canonicalBoard(board);
  const r0 = toRange(ranges[0]);
  const r1 = toRange(ranges[1]);
  let best: CanonicalSpot | null = null;
  for (const perm of perms) {
    const candidate: CanonicalSpot = {
      board: canonical,
      ranges: [permuteRange(r0, perm), permuteRange(r1, perm)],
      perm,
    };
    if (
      !best ||
      compareArrays(candidate.ranges[0], best.ranges[0]) < 0 ||
      (compareArrays(candidate.ranges[0], best.ranges[0]) === 0 &&
        compareArrays(candidate.ranges[1], best.ranges[1]) < 0)
    ) {
      best = candidate;
    }
  }
  return best as CanonicalSpot;
}
