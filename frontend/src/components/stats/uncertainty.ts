/**
 * How much to trust a number on the HUD.
 *
 * A VPIP over forty hands and a VPIP over forty thousand are both rendered as
 * "23.4%", and they are not the same claim. A tracker that shows them
 * identically is not being neutral — it is asserting a precision it does not
 * have, and the reader has no way to tell. Every percentage in this module
 * therefore carries its own interval, and the UI is expected to show it.
 *
 * The interval is a **Wilson score interval**, not the textbook
 * `p ± 1.96·√(p(1-p)/n)`. The normal approximation is exactly wrong where poker
 * statistics live: at `p` near 0 or 1 it produces bounds outside [0, 1], and at
 * small `n` it collapses to ±0 for any counter that happened to be 0 or 100%.
 * "I have 4-bet 0 times out of 3, ±0.0%" is the single most misleading thing a
 * HUD can print. Wilson is asymmetric, stays inside the range, and gives a
 * 0-of-3 an honestly enormous band.
 *
 * Nothing here is stored. These are read-time decorations on sums, like every
 * other rate in the engine.
 */

/** 1.96: the two-sided 95% normal quantile. */
const Z = 1.959964;

export interface Interval {
  /** The point estimate, in percentage points. */
  value: number;
  low: number;
  high: number;
  /** Half the width of the interval, in percentage points. The "±" figure. */
  margin: number;
  /** The denominator the interval was computed over. */
  opportunities: number;
}

/**
 * The 95% Wilson score interval for `made` successes out of `opportunities`,
 * in percentage points.
 *
 * Returns null for an empty denominator. That is deliberate and it propagates:
 * `rates()` returns null rather than 0 for the same reason, because a 0% cbet
 * over zero opportunities and a 0% cbet over four hundred are different claims
 * and a UI that cannot tell them apart will render the first one as a leak.
 */
export function wilson(made: number, opportunities: number): Interval | null {
  if (!Number.isFinite(made) || !Number.isFinite(opportunities) || opportunities <= 0) {
    return null;
  }
  const n = opportunities;
  const p = Math.min(Math.max(made / n, 0), 1);
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const spread = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  const low = Math.max(0, centre - spread) * 100;
  const high = Math.min(1, centre + spread) * 100;
  return {
    value: p * 100,
    low,
    high,
    margin: (high - low) / 2,
    opportunities: n,
  };
}

/**
 * Three bands, because a reader needs a glance-level answer and not a number.
 *
 * The thresholds are in percentage points of the half-width and are chosen
 * against how the statistics are actually used:
 *
 *   * **firm** (±≤ 2 pp) — tight enough to compare against a population norm.
 *     A VPIP needs roughly 2 400 hands to get here, which is about right: that
 *     is the point at which players stop arguing about their own VPIP.
 *   * **loose** (±≤ 6 pp) — the shape is real, the digit after the point is not.
 *   * **noise** (wider) — the number is on screen because you asked for it, not
 *     because it means anything. Rendered as such.
 */
export type Confidence = "firm" | "loose" | "noise";

export function confidenceOf(interval: Interval | null): Confidence {
  if (!interval) {
    return "noise";
  }
  if (interval.margin <= 2) {
    return "firm";
  }
  if (interval.margin <= 6) {
    return "loose";
  }
  return "noise";
}

/**
 * Whether a win rate is worth reading yet.
 *
 * **No interval is offered for bb/100, on purpose.** A confidence interval on a
 * win rate needs the variance of the per-hand result, and the engine stores
 * sums rather than sums of squares — so the only way to print a "±" here would
 * be to assume a standard deviation (the usual 90-100 bb/100 for no-limit cash)
 * and present the result as if it had been measured. That is a fabricated
 * number wearing the costume of a measured one, which is worse than no number.
 *
 * So the honest thing to show is the sample size and a plain statement about
 * it. 10 000 hands is not a threshold of significance — it is roughly where a
 * ±5 bb/100 band lands at typical no-limit variance, which is to say, still
 * wide enough to contain both "winning player" and "losing player" for most
 * people reading it.
 */
export const WIN_RATE_SAMPLE_FLOOR = 10_000;

export function winRateIsMeaningful(hands: number): boolean {
  return hands >= WIN_RATE_SAMPLE_FLOOR;
}
