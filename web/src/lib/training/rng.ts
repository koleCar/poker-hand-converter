/**
 * A seeded random number generator: the trainer deals from a seed, so a spot
 * is reproducible (a test pins it, a bug report names it) and two runs with
 * the same seed deal the same hand.
 *
 * Mulberry32: 32 bits of state, fast, and good enough for dealing cards. It
 * is not a cryptographic generator and nothing here needs one.
 */

export type Rng = () => number;

/** A generator for `seed` (any 32-bit integer). Each call returns a number in [0, 1). */
export function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed from a generator (or from `Math.random` when none is given). */
export function nextSeed(rng: Rng = Math.random): number {
  return Math.floor(rng() * 4294967296) >>> 0;
}

/** Index drawn with probability proportional to `weights[i]`; -1 when every weight is zero. */
export function pickWeighted(weights: ArrayLike<number>, rng: Rng): number {
  let total = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    if (w > 0 && Number.isFinite(w)) total += w;
  }
  if (!(total > 0)) return -1;
  let target = rng() * total;
  let last = -1;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    if (!(w > 0) || !Number.isFinite(w)) continue;
    last = i;
    target -= w;
    if (target < 0) return i;
  }
  return last;
}

/** One element, uniformly. */
export function pickOne<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
