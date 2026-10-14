//! Calendar arithmetic and a small seeded random source.
//!
//! Integers only (the workspace denies float arithmetic): civil dates from
//! days since 1970-01-01 and back (Howard Hinnant's algorithms), and
//! SplitMix64 for the jitter, the rosters and the ids. A seed makes a run
//! repeatable apart from the wall clock.

use std::time::{SystemTime, UNIX_EPOCH};

/// Days since 1970-01-01 of a proleptic Gregorian date.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number from [`days_from_civil`]: (year, month, day).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A wall-clock time split into its fields (no time zone: whatever zone the
/// seconds were counted in).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
}

impl Civil {
    /// From seconds since the epoch.
    pub fn from_unix(seconds: i64) -> Self {
        let days = seconds.div_euclid(86_400);
        let rest = seconds.rem_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        Self {
            year,
            month,
            day,
            hour: rest / 3600,
            minute: rest % 3600 / 60,
            second: rest % 60,
        }
    }

    /// Seconds since the epoch.
    pub fn to_unix(self) -> i64 {
        days_from_civil(self.year, self.month, self.day) * 86_400
            + self.hour * 3600
            + self.minute * 60
            + self.second
    }

    /// `YYYYMMDD`.
    pub fn compact_date(self) -> String {
        format!("{:04}{:02}{:02}", self.year, self.month, self.day)
    }
}

/// Seconds since the epoch of an ISO-8601 UTC time as PHF writes it
/// (`2014-01-06T07:22:02.000Z`).
pub fn parse_iso_utc(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let field = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    Some(
        Civil {
            year: field(0, 4)?,
            month: field(5, 7)?,
            day: field(8, 10)?,
            hour: field(11, 13)?,
            minute: field(14, 16)?,
            second: field(17, 19)?,
        }
        .to_unix(),
    )
}

/// Milliseconds since the epoch, now.
pub fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// SplitMix64: small, fast, good enough for jitter and names.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n > 0`; 0 when `n == 0`).
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }

    /// Uniform index into a slice of `len` items.
    pub fn index(&mut self, len: usize) -> usize {
        let n = u64::try_from(len).unwrap_or(u64::MAX);
        usize::try_from(self.below(n)).unwrap_or(0)
    }

    /// Uniform in `low..=high` (`low <= high`).
    pub fn between(&mut self, low: i64, high: i64) -> i64 {
        if high <= low {
            return low;
        }
        let span = u64::try_from(high - low)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        low + i64::try_from(self.below(span)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for days in [-800_000, -1, 0, 1, 365, 10_957, 16_076, 20_000, 2_000_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn iso_utc() {
        let t = parse_iso_utc("2014-01-06T07:22:02.000Z").expect("parses");
        let c = Civil::from_unix(t);
        assert_eq!(
            c,
            Civil {
                year: 2014,
                month: 1,
                day: 6,
                hour: 7,
                minute: 22,
                second: 2
            }
        );
        assert_eq!(c.compact_date(), "20140106");
        assert_eq!(parse_iso_utc("nope"), None);
    }

    #[test]
    fn rng_is_seeded_and_bounded() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..100 {
            let x = a.between(-3, 3);
            assert_eq!(x, b.between(-3, 3));
            assert!((-3..=3).contains(&x));
            assert!(a.index(5) < 5);
            b.index(5);
        }
        assert_eq!(a.below(0), 0);
    }
}
