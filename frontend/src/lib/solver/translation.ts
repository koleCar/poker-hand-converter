/**
 * Action translation: a real bet size onto the tree's abstract sizes.
 *
 * Players bet 2.08 into 6.3; the tree has 33% and 75%. The real size has to
 * be read as one of the solved sizes - or as a mix of the two around it - to
 * look up a strategy and to grade a response to it.
 *
 * **Pseudo-harmonic mapping** (Ganzfried & Sandholm, "Action Translation in
 * Extensive-Form Games with Large Action Spaces", IJCAI 2013). With sizes as
 * fractions of the pot and `A <= x <= B`, map `x` to `A` with probability
 *
 *     f(x) = ((B - x)(1 + A)) / ((B - A)(1 + x))
 *
 * and to `B` otherwise. It is the mapping that is least exploitable on the
 * clairvoyance game - an opponent who knows the mapping gains little by
 * picking sizes between the abstract ones - and unlike "nearest size" it does
 * not jump at the midpoint, so a grade does not flip because a bet was 0.1bb
 * larger. It is not linear: 50% between 33% and 75% maps to 33% with
 * probability ~0.53, not the linear 0.6, because the pot odds a size offers are
 * `x / (1 + 2x)`, not `x`.
 *
 * **Outside the menu** a size maps wholly to the nearest end; whether it is
 * too far from any solved size to trust is `offTree` (plan §3.3: more than 25%
 * of the pot from the nearest), which caps the grade.
 */

/** Distance from the nearest solved size, as a fraction of the pot, beyond which a size is off-tree. */
export const OFF_TREE_DISTANCE = 0.25;

/** Probability that `x` maps to `a` rather than `b` (`a < b`, all as fractions of the pot). */
export function pseudoHarmonic(x: number, a: number, b: number): number {
  if (!(a < b)) {
    throw new Error("pseudoHarmonic needs a < b");
  }
  if (x <= a) {
    return 1;
  }
  if (x >= b) {
    return 0;
  }
  return ((b - x) * (1 + a)) / ((b - a) * (1 + x));
}

export interface Translation {
  /** One or two abstract sizes with the probability of each, summing to 1. */
  mapped: { index: number; size: number; probability: number }[];
  /** Distance to the nearest abstract size, as a fraction of the pot. */
  distance: number;
  /** `distance > OFF_TREE_DISTANCE`. */
  offTree: boolean;
}

/**
 * Translates a real size `x` (fraction of the pot) onto `sizes` (fractions of
 * the pot, any order). `index` refers to the position in `sizes`.
 */
export function translateSize(x: number, sizes: readonly number[]): Translation {
  if (!sizes.length) {
    throw new Error("no sizes to translate onto");
  }
  const order = sizes.map((size, index) => ({ size, index })).sort((p, q) => p.size - q.size);
  let distance = Infinity;
  for (const { size } of order) {
    distance = Math.min(distance, Math.abs(size - x));
  }
  const offTree = distance > OFF_TREE_DISTANCE;
  if (x <= order[0].size) {
    return { mapped: [{ ...order[0], probability: 1 }], distance, offTree };
  }
  const last = order[order.length - 1];
  if (x >= last.size) {
    return { mapped: [{ ...last, probability: 1 }], distance, offTree };
  }
  let k = 0;
  while (order[k + 1].size < x) {
    k += 1;
  }
  const lo = order[k];
  const hi = order[k + 1];
  if (x === hi.size) {
    return { mapped: [{ ...hi, probability: 1 }], distance, offTree };
  }
  const p = pseudoHarmonic(x, lo.size, hi.size);
  return {
    mapped: [
      { ...lo, probability: p },
      { ...hi, probability: 1 - p },
    ],
    distance,
    offTree,
  };
}
