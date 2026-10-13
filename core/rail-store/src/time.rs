//! Wall-clock helpers. The store's times are milliseconds since the Unix
//! epoch (UTC) in `i64`; the core has no clock, so the PHF's `parsedAt` is
//! made here.

use std::time::{SystemTime, UNIX_EPOCH};

/// Now, in milliseconds since the epoch (0 if the clock is before 1970).
pub fn now_ms() -> i64 {
    system_time_ms(SystemTime::now()).unwrap_or(0)
}

/// A `SystemTime` in milliseconds since the epoch; `None` before 1970 or
/// beyond `i64`.
pub fn system_time_ms(time: SystemTime) -> Option<i64> {
    let since = time.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// `ms` as `Date.prototype.toISOString` writes it: `2026-10-13T08:15:00.123Z`.
/// The format of every `parsedAt` the TypeScript stamps.
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = in_day / 3_600_000;
    let minute = in_day / 60_000 % 60;
    let second = in_day / 1000 % 60;
    let milli = in_day % 1000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Now as [`iso_from_ms`].
pub fn iso_now() -> String {
    iso_from_ms(now_ms())
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (year,
/// month, day) in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::iso_from_ms;

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        // new Date(1_760_343_300_123).toISOString()
        assert_eq!(iso_from_ms(1_760_343_300_123), "2025-10-13T08:15:00.123Z");
        // A leap day, and the last millisecond of a year.
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_704_067_199_999), "2023-12-31T23:59:59.999Z");
        assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
    }
}
