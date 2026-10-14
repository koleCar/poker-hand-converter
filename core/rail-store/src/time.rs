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

/// Back from an ISO instant in UTC, as PHF writes `playedAt`
/// (`2026-10-13T08:15:00.123Z`; the fraction may have any number of digits
/// or be absent, digits past the millisecond are cut). `None` for any other
/// text, an offset other than `Z` included.
pub fn ms_from_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = bytes.get(from..from + len)?;
        part.iter().try_fold(0_i64, |value, &byte| {
            byte.is_ascii_digit()
                .then(|| value * 10 + i64::from(byte - b'0'))
        })
    };
    let at = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    if !(at(4, b'-') && at(7, b'-') && at(10, b'T') && at(13, b':') && at(16, b':')) {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (hour, minute, second) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut index = 19;
    let mut milli = 0;
    if at(index, b'.') {
        index += 1;
        let start = index;
        let mut kept = 0;
        while let Some(byte) = bytes.get(index).filter(|byte| byte.is_ascii_digit()) {
            if kept < 3 {
                milli = milli * 10 + i64::from(byte - b'0');
                kept += 1;
            }
            index += 1;
        }
        if index == start {
            return None;
        }
        while kept < 3 {
            milli *= 10;
            kept += 1;
        }
    }
    if index + 1 != bytes.len() || !at(index, b'Z') {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + milli)
}

/// Howard Hinnant's `days_from_civil`: (year, month, day) in the proleptic
/// Gregorian calendar to days since 1970-01-01.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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
    use super::{iso_from_ms, ms_from_iso};

    #[test]
    fn iso_round_trips() {
        for ms in [
            0,
            1_760_343_300_123,
            951_782_400_000,
            1_704_067_199_999,
            -1,
            4_102_444_800_000,
        ] {
            assert_eq!(ms_from_iso(&iso_from_ms(ms)), Some(ms), "{ms}");
        }
        assert_eq!(ms_from_iso("2025-10-13T08:15:00Z"), Some(1_760_343_300_000));
        assert_eq!(
            ms_from_iso("2025-10-13T08:15:00.1Z"),
            Some(1_760_343_300_100)
        );
        assert_eq!(
            ms_from_iso("2025-10-13T08:15:00.123456Z"),
            Some(1_760_343_300_123)
        );
        for bad in [
            "",
            "2025-10-13",
            "2025-10-13T08:15:00",
            "2025-10-13T08:15:00+02:00",
            "2025-10-13T08:15:00.Z",
            "2025-13-13T08:15:00Z",
            "2025-10-13T08:15:00.000Zx",
            "2025-10-13 08:15:00Z",
        ] {
            assert_eq!(ms_from_iso(bad), None, "{bad}");
        }
    }

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
