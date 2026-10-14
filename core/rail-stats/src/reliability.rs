//! How far to trust a displayed statistic (docs/RAIL-PLAN.md R2.5,
//! docs/STATS-SPEC.md §13): a 95% Wilson interval for a rate, and a
//! reliability [`Level`] and an opacity for every value, from the
//! definition's `sample.min`. The web computes the same in
//! `frontend/src/lib/stats/reliability.ts`; `tests/reliability.rs` holds the
//! two to the same bits.
//!
//! **The interval** is the Wilson score interval - asymmetric, inside 0-100,
//! and honestly wide for 0 of 3 (0-56.1%), where the textbook normal
//! approximation prints "0.0 ± 0.0". In percentage points, each step one
//! double operation in this order ([`JsNumber`]; `Math.sqrt` is correctly
//! rounded in JavaScript, [`JsNumber::sqrt`] here):
//!
//! ```text
//! z2     = z * z                                    z = 1.959964 (95%, two-sided)
//! centre = made + z2 / 2
//! spread = z * sqrt((made * (n - made)) / n + z2 / 4)
//! low    = made == 0 ? 0   : ((centre - spread) * 100) / (n + z2)
//! high   = made == n ? 100 : ((centre + spread) * 100) / (n + z2)
//! ```
//!
//! Clamped to 0-100; none unless `n > 0` and `0 <= made <= n` (nor when a
//! bound overflows, which takes an `n` near 1e306). Other statistics get no
//! interval: a win rate's needs the per-hand variance, and the engine stores
//! sums, not sums of squares - a "±" on bb/100 would be an assumed standard
//! deviation presented as measured. A ratio is not a proportion either.
//!
//! **Level and opacity** ([`sample_reliability`]), the same rule for every
//! statistic, from the sample (`sample.of`, or the rate's opportunities)
//! against `sample.min`:
//!
//! - [`Level::Ok`]: the sample reaches `min` (or `min` is 0); R2.4's `full`.
//! - [`Level::Low`]: at least a quarter of `min` - an interval at most twice
//!   as wide as at `min`, since widths shrink with `√n`.
//! - [`Level::Insufficient`]: less, or no sample.
//!
//! `opacity = 0.6 + 0.4 * sqrt(sample / min)` below `min`, 1 from it: it grows
//! with the precision and reaches 1 where the level turns `ok`, without a
//! step. 0.6 is the floor at which the web's figures keep their contrast.

use rail_core::js::JsNumber;

/// The confidence of the interval, in percent (for labels).
pub const CONFIDENCE_PERCENT: u32 = 95;

/// `z` as the web writes it: the two-sided 95% normal quantile, 1.959964.
pub const WILSON_Z: &str = "1.959964";

/// The opacity of a value with (almost) no sample.
pub const OPACITY_FLOOR: &str = "0.6";

/// How far a value can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Level {
    /// Under a quarter of `sample.min`, or no sample.
    Insufficient,
    /// From a quarter of `sample.min`.
    Low,
    /// From `sample.min` (always when it is 0): full opacity.
    Ok,
}

impl Level {
    /// The name the web uses (`Reliability` in `reliability.ts`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Insufficient => "insufficient",
            Self::Low => "low",
            Self::Ok => "ok",
        }
    }
}

/// A rate's interval, in percentage points.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interval {
    pub low: JsNumber,
    pub high: JsNumber,
}

fn number(text: &str) -> JsNumber {
    JsNumber::parse(text)
}

/// The 95% Wilson score interval of `made` out of `opportunities`, in
/// percentage points (see the module header); `None` unless
/// `opportunities > 0` and `0 <= made <= opportunities`.
pub fn wilson(made: JsNumber, opportunities: JsNumber) -> Option<Interval> {
    let n = opportunities;
    if !made.is_finite()
        || !n.is_finite()
        || !n.greater_than(JsNumber::ZERO)
        || made.less_than(JsNumber::ZERO)
        || made.greater_than(n)
    {
        return None;
    }
    let z = number(WILSON_Z);
    let hundred = JsNumber::from_i64(100);
    let z2 = z * z;
    let centre = made + z2 / JsNumber::from_i64(2);
    let spread = z * ((made * (n - made)) / n + z2 / JsNumber::from_i64(4)).sqrt();
    let denominator = n + z2;
    let mut low = if made.strict_equals(JsNumber::ZERO) {
        JsNumber::ZERO
    } else {
        ((centre - spread) * hundred) / denominator
    };
    let mut high = if made.strict_equals(n) {
        hundred
    } else {
        ((centre + spread) * hundred) / denominator
    };
    // Only for absurd inputs (n near 1e306, where `* 100` overflows).
    if !low.is_finite() || !high.is_finite() {
        return None;
    }
    if low.less_than(JsNumber::ZERO) {
        low = JsNumber::ZERO;
    }
    if high.greater_than(hundred) {
        high = hundred;
    }
    Some(Interval { low, high })
}

/// The level and opacity of a value over `sample`, for a definition's
/// `sample.min` (see the module header). `sampleReliability` in
/// `reliability.ts`.
pub fn sample_reliability(sample: Option<JsNumber>, min: u64) -> (Level, JsNumber) {
    let one = JsNumber::from_i64(1);
    if min == 0 {
        return (Level::Ok, one);
    }
    let Some(sample) = sample.filter(|s| s.greater_than(JsNumber::ZERO)) else {
        return (Level::Insufficient, number(OPACITY_FLOOR));
    };
    let min = JsNumber::from_u64(min);
    if !sample.less_than(min) {
        return (Level::Ok, one);
    }
    let level = if (sample * JsNumber::from_i64(4)).less_than(min) {
        Level::Insufficient
    } else {
        Level::Low
    };
    let opacity = number(OPACITY_FLOOR) + number("0.4") * (sample / min).sqrt();
    (level, opacity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(value: i64) -> JsNumber {
        JsNumber::from_i64(value)
    }

    fn bounds(made: i64, opportunities: i64) -> Option<(String, String)> {
        wilson(n(made), n(opportunities)).map(|i| (i.low.to_js_string(), i.high.to_js_string()))
    }

    #[test]
    fn wilson_at_the_edges() {
        assert_eq!(bounds(0, 0), None);
        assert_eq!(bounds(1, 0), None);
        assert_eq!(bounds(4, 3), None, "made above the opportunities");
        assert_eq!(bounds(-1, 3), None);
        let (low, high) = bounds(0, 3).expect("0 of 3");
        assert_eq!(low, "0");
        assert!(high.starts_with("56.1"), "{high}");
        let (low, high) = bounds(3, 3).expect("3 of 3");
        assert!(low.starts_with("43.8"), "{low}");
        assert_eq!(high, "100");
        let (low, high) = bounds(23, 80).expect("23 of 80");
        assert!(
            low.starts_with("19.9") && high.starts_with("39.4"),
            "{low} {high}"
        );
        let huge = wilson(n(1 << 52), n(1 << 53)).expect("2^52 of 2^53");
        assert!(huge.low.less_than(n(50)) && huge.high.greater_than(n(50)));
        assert!(wilson(JsNumber::Nan, n(3)).is_none());
    }

    #[test]
    fn levels_and_opacity() {
        let level = |sample: Option<i64>, min| sample_reliability(sample.map(n), min);
        assert_eq!(level(None, 0), (Level::Ok, n(1)));
        assert_eq!(level(Some(0), 0), (Level::Ok, n(1)));
        assert_eq!(level(None, 100).0, Level::Insufficient);
        assert_eq!(level(Some(0), 100).1.to_js_string(), "0.6");
        assert_eq!(level(Some(-5), 100).0, Level::Insufficient);
        assert_eq!(level(Some(24), 100).0, Level::Insufficient);
        assert_eq!(level(Some(25), 100), (Level::Low, JsNumber::parse("0.8")));
        assert_eq!(level(Some(99), 100).0, Level::Low);
        assert_eq!(level(Some(100), 100), (Level::Ok, n(1)));
        assert_eq!(level(Some(1 << 40), 100), (Level::Ok, n(1)));
        assert_eq!(Level::Insufficient.as_str(), "insufficient");
    }
}
