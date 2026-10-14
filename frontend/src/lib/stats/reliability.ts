/**
 * How far to trust a displayed statistic (docs/RAIL-PLAN.md R2.5,
 * docs/STATS-SPEC.md §13): a 95% interval for a rate, and a reliability
 * level and an opacity for every value, from the definition's
 * `sample.min`. The desktop app and the HUD compute the same in Rust
 * (`rail_stats::reliability`), bit for bit.
 *
 * A VPIP over forty hands and a VPIP over forty thousand both print "23.4",
 * and they are not the same claim. A screen that shows them identically is
 * not neutral - it asserts a precision it does not have. So every value comes
 * with its sample, a rate with its interval, and a small sample is dimmed
 * (guideline §5 "Uzorak uz svaku vrijednost", §7 "Dok je uzorak malen,
 * vrijednosti su prigušene").
 *
 * **The interval is the Wilson score interval**, not the textbook
 * `p ± z·√(p(1-p)/n)`. The normal approximation is wrong exactly where poker
 * statistics live: near 0 or 100% it leaves the range, and at a small `n` it
 * collapses to ±0 for a counter that happened to be 0 or all - "0 4-bets in 3,
 * ±0.0%" is the most misleading thing a HUD can print. Wilson is asymmetric,
 * stays inside 0-100 and gives 0 of 3 an honestly wide band (0-56.1%).
 *
 * In the order the arithmetic is done (every step one double operation, so
 * Rust's `JsNumber` gives the same bits; `Math.sqrt` is correctly rounded):
 *
 * ```
 * z2     = z * z                                    z = 1.959964 (95%, two-sided)
 * centre = made + z2 / 2
 * spread = z * sqrt((made * (n - made)) / n + z2 / 4)
 * low    = made === 0 ? 0   : ((centre - spread) * 100) / (n + z2)
 * high   = made === n ? 100 : ((centre + spread) * 100) / (n + z2)
 * ```
 *
 * which is the usual `(p + z²/2n ± z·√(p(1-p)/n + z²/4n²)) / (1 + z²/n)`
 * multiplied through by `n`, in percentage points, clamped to 0-100. There is
 * none unless `n > 0` and `0 <= made <= n` (nor when a bound overflows, which
 * takes an `n` near 1e306). `z` is the 1.959964 the web has always used
 * (and `lib/analysis/reports.ts` still does), not the 1.959963984540054 of a
 * table: the bounds differ in the eighth digit and no display shows it.
 *
 * **Other statistics get no interval, on purpose.** An interval on a win
 * rate (bb/100) needs the variance of the per-hand result, and the engine
 * stores sums, not sums of squares; printing a "±" would mean assuming a
 * standard deviation (the usual 90-100 bb/100 for no-limit cash) and
 * presenting it as measured. A ratio (aggression factor) is not a proportion
 * either. For those the sample is the whole story: its size, and the level
 * and opacity below.
 *
 * **Level and opacity** come from the sample (`sample.of`, or a rate's
 * opportunities) against the definition's `sample.min`, the same rule for
 * every statistic:
 *
 * - `ok`: the sample reaches `min` (or `min` is 0) - full opacity; this is
 *   R2.4's `full`.
 * - `low`: at least a quarter of `min`. An interval shrinks with `√n`, so a
 *   quarter of the sample is at most twice the width the definition calls
 *   enough.
 * - `insufficient`: less than that, or no sample at all.
 *
 * `opacity = 0.6 + 0.4 * sqrt(sample / min)` below `min`, 1 from there: it
 * grows with the precision (`√n`) and reaches 1 exactly where the level turns
 * `ok`, without a step. 0.6 is the floor because it is the lowest opacity at
 * which the web's large figures keep their contrast (it was the web's "noise"
 * opacity before R2.5); 0.8 at a quarter of `min`, where `low` begins.
 *
 * Pure: no framework, no I/O. `display.ts` applies it to a definition.
 */

/** The confidence the interval is at, in percent (for labels). */
export const CONFIDENCE_PERCENT = 95;
/** The two-sided 95% normal quantile, as the web has always used it. */
export const WILSON_Z = 1.959964;
/** The opacity of a value with (almost) no sample. */
export const OPACITY_FLOOR = 0.6;
/** The largest `sample.min` a definition may have (`compileStats` and `rail_config` refuse more). */
export const MAX_SAMPLE_MIN = 1_000_000_000;

export type Reliability = "insufficient" | "low" | "ok";

/** A rate's interval, in percentage points. */
export interface RateInterval {
  low: number;
  high: number;
}

/**
 * The 95% Wilson score interval of `made` out of `opportunities`, in
 * percentage points; null unless `opportunities > 0` and
 * `0 <= made <= opportunities`.
 */
export function wilson(made: number, opportunities: number): RateInterval | null {
  const n = opportunities;
  if (!Number.isFinite(made) || !Number.isFinite(n) || !(n > 0) || made < 0 || made > n) return null;
  const z2 = WILSON_Z * WILSON_Z;
  const centre = made + z2 / 2;
  const spread = WILSON_Z * Math.sqrt((made * (n - made)) / n + z2 / 4);
  const denominator = n + z2;
  let low = made === 0 ? 0 : ((centre - spread) * 100) / denominator;
  let high = made === n ? 100 : ((centre + spread) * 100) / denominator;
  // Only for absurd inputs (n near 1e306, where `* 100` overflows).
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (low < 0) low = 0;
  if (high > 100) high = 100;
  return { low, high };
}

/** The level and opacity of a value over `sample`, for a definition's `min`. */
export function sampleReliability(sample: number | null, min: number): { level: Reliability; opacity: number } {
  if (min === 0) return { level: "ok", opacity: 1 };
  if (sample === null || !(sample > 0)) return { level: "insufficient", opacity: OPACITY_FLOOR };
  if (!(sample < min)) return { level: "ok", opacity: 1 };
  return {
    level: sample * 4 < min ? "insufficient" : "low",
    opacity: OPACITY_FLOOR + 0.4 * Math.sqrt(sample / min),
  };
}
