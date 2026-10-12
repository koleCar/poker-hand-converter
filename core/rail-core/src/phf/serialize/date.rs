//! The part of JavaScript's `Date` the standard text uses: reading a header
//! timestamp into an ISO instant (`parsePlayedAt`) and printing an instant the
//! way rooms do (`formatPlayedAt`).
//!
//! Both go through `new Date(string)`, so what V8 accepts and how it rolls
//! over is part of the output:
//!
//! - the ECMAScript date-time string format: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
//!   optionally `THH:mm`, `:ss`, `.s…` (any number of digits, milliseconds
//!   truncated), then `Z` or an offset `±HH:mm` / `±HHMM`; `T` and `Z` in
//!   either case; years as four digits or a sign and six (`-000000` is
//!   refused);
//! - V8 accepts any day from 01 to 31 in any month and rolls it over
//!   (`2021-02-31` is 3 March), and `24:00` (`:00`, `.000`) as the next
//!   midnight; month, minute, second and offset ranges are checked;
//! - instants beyond ±8.64e15 ms of the epoch are invalid.
//!
//! **Not reproduced**: a date-time *without* a zone is local time in
//! JavaScript, and any other string goes to V8's legacy parser, which is
//! lenient and also mostly local time. The core has no time zone, so those
//! are an invalid date here (`NaN/NaN/NaN NaN:NaN:NaN` when printed). Every
//! `playedAt` a parser writes is `toISOString()` output, and so is every one
//! in the corpus.

use std::sync::LazyLock;

use regex::Regex;

/// Milliseconds in a day.
const DAY_MS: i64 = 86_400_000;
/// `Date`'s range: ±100 000 000 days around the epoch.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// Days from 1970-01-01 to `year-month-01` (proleptic Gregorian, any year).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `(year, month 1-12, day 1-31)` of a day count from the epoch.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The UTC fields of an instant: what `getUTCFullYear()` … `getUTCSeconds()`
/// and `getUTCMilliseconds()` return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UtcFields {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
}

fn fields(ms: i64) -> UtcFields {
    let days = ms.div_euclid(DAY_MS);
    let rest = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    UtcFields {
        year,
        month,
        day,
        hour: rest / 3_600_000,
        minute: rest / 60_000 % 60,
        second: rest / 1000 % 60,
        millisecond: rest % 1000,
    }
}

/// The ECMAScript date-time format (ASCII digits: `regex`'s `\d` is Unicode).
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:([0-9]{4})|([+-])([0-9]{6}))(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(?:([Zz])|([+-])([0-9]{2}):?([0-9]{2})))?$",
    )
    .expect("ISO date pattern")
});

/// `new Date(text).getTime()` for the ECMAScript format (see the module
/// docs); `None` is an invalid date.
pub(crate) fn parse_instant(text: &str) -> Option<i64> {
    let c = ISO.captures(text)?;
    let num = |i: usize| -> Option<i64> { c.get(i).map(|m| m.as_str().parse::<i64>().ok())? };
    let year = match (num(1), c.get(2), num(3)) {
        (Some(year), _, _) => year,
        (None, Some(sign), Some(six)) => {
            if sign.as_str() == "-" {
                if six == 0 {
                    return None;
                }
                -six
            } else {
                six
            }
        }
        _ => return None,
    };
    let month = num(4).unwrap_or(1);
    let day = num(5).unwrap_or(1);
    let has_time = c.get(6).is_some();
    // A date-time without a zone is local time: not reproducible here.
    if has_time && c.get(10).is_none() && c.get(11).is_none() {
        return None;
    }
    let hour = num(6).unwrap_or(0);
    let minute = num(7).unwrap_or(0);
    let second = num(8).unwrap_or(0);
    let millisecond = c.get(9).map_or(Some(0), |m| {
        let digits: String = m.as_str().chars().chain("00".chars()).take(3).collect();
        digits.parse::<i64>().ok()
    })?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if minute > 59 || second > 59 {
        return None;
    }
    if hour > 24 || (hour == 24 && (minute != 0 || second != 0 || millisecond != 0)) {
        return None;
    }
    let offset = match (c.get(11), num(12), num(13)) {
        (Some(sign), Some(h), Some(m)) => {
            if h > 23 || m > 59 {
                return None;
            }
            let minutes = h * 60 + m;
            if sign.as_str() == "-" {
                -minutes
            } else {
                minutes
            }
        }
        _ => 0,
    };
    let ms = days_from_civil(year, month, 1) * DAY_MS
        + (day - 1) * DAY_MS
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + millisecond
        - offset * 60_000;
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

/// `Date.prototype.toISOString` of a valid instant.
pub(crate) fn to_iso_string(ms: i64) -> String {
    let f = fields(ms);
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else if f.year < 0 {
        format!("-{:06}", -f.year)
    } else {
        format!("+{:06}", f.year)
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        f.month, f.day, f.hour, f.minute, f.second, f.millisecond
    )
}

/// `Date.UTC(year, month, day, hour, minute, second)` for integer arguments
/// (`month` 0-based and possibly out of range, as JavaScript allows): a year
/// from 0 to 99 is 1900 + year, every field rolls over (`MakeDay`,
/// `MakeTime`), and an instant beyond ±8.64e15 ms is `None` (`NaN`). The
/// arithmetic is exact: the TypeScript's doubles are exact for these
/// integers, which the PartyGaming date regexes keep to a few digits.
pub(crate) fn date_utc(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
) -> Option<i64> {
    let year = if (0..=99).contains(&year) {
        1900 + year
    } else {
        year
    };
    let year = year.checked_add(month.div_euclid(12))?;
    let month = month.rem_euclid(12) + 1;
    // Far beyond the ±100 000 000-day range already; also keeps the civil
    // arithmetic below inside `i64`.
    if year.abs() > 1_000_000 {
        return None;
    }
    let days = i128::from(days_from_civil(year, month, 1)) + i128::from(day) - 1;
    let time =
        i128::from(hour) * 3_600_000 + i128::from(minute) * 60_000 + i128::from(second) * 1000;
    let ms = days * i128::from(DAY_MS) + time;
    if ms.abs() > i128::from(MAX_TIME_MS) {
        return None;
    }
    i64::try_from(ms).ok()
}

/// `new Date(text)`'s UTC fields, `None` for an invalid date.
pub(crate) fn utc_fields(text: &str) -> Option<UtcFields> {
    parse_instant(text).map(fields)
}

static PLAYED_AT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})",
    ""
);

/// `parsePlayedAt(payload)`: the first `YYYY/MM/DD H:MM:SS` (or with `-` and
/// `T`) in the header, read as UTC, as an ISO instant; `None` when there is
/// none or V8 rejects it.
pub(crate) fn parse_played_at(payload: &str) -> Option<String> {
    let c = PLAYED_AT.captures(payload)?;
    let hour = &c[4];
    let padded = if hour.len() < 2 {
        format!("0{hour}")
    } else {
        hour.to_owned()
    };
    let iso = format!(
        "{}-{}-{}T{padded}:{}:{}Z",
        &c[1], &c[2], &c[3], &c[5], &c[6]
    );
    parse_instant(&iso).map(to_iso_string)
}

/// `String(value).padStart(2, "0")`.
fn pad(value: i64) -> String {
    let text = value.to_string();
    if text.len() < 2 {
        format!("0{text}")
    } else {
        text
    }
}

/// `formatPlayedAt(iso, padHour)`: `2026-02-17T05:56:01.000Z` →
/// `2026/02/17 05:56:01`, the shape sites print; the hour unpadded when
/// `pad_hour` is false. Empty for no instant; `NaN` fields for an invalid one.
pub fn format_played_at(iso: Option<&str>, pad_hour: bool) -> String {
    let Some(iso) = iso.filter(|iso| !iso.is_empty()) else {
        return String::new();
    };
    let Some(f) = utc_fields(iso) else {
        return "NaN/NaN/NaN NaN:NaN:NaN".to_owned();
    };
    let hour = if pad_hour {
        pad(f.hour)
    } else {
        f.hour.to_string()
    };
    format!(
        "{}/{}/{} {hour}:{}:{}",
        f.year,
        pad(f.month),
        pad(f.day),
        pad(f.minute),
        pad(f.second)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso(text: &str) -> Option<String> {
        parse_instant(text).map(to_iso_string)
    }

    /// Recorded from `new Date(text).toISOString()` under Node 24.
    #[test]
    fn reads_what_v8_reads() {
        let cases: [(&str, Option<&str>); 33] = [
            ("2021-02-31T00:00:00Z", Some("2021-03-03T00:00:00.000Z")),
            ("2021-02-30T00:00:00Z", Some("2021-03-02T00:00:00.000Z")),
            ("2021-02-32T00:00:00Z", None),
            ("2021-13-01T00:00:00Z", None),
            ("2021-00-10T00:00:00Z", None),
            ("2021-01-00T00:00:00Z", None),
            ("2021-01-01T24:00:00Z", Some("2021-01-02T00:00:00.000Z")),
            ("2021-01-01T24:01:00Z", None),
            ("2021-01-01T23:60:00Z", None),
            ("2021-01-01T23:59:60Z", None),
            ("2021-01-01T25:00:00Z", None),
            ("0000-01-01T00:00:00Z", Some("0000-01-01T00:00:00.000Z")),
            ("2023-02-29T00:00:00Z", Some("2023-03-01T00:00:00.000Z")),
            ("2024-02-29T10:00:00Z", Some("2024-02-29T10:00:00.000Z")),
            ("2026-02-17T05:56:01.1Z", Some("2026-02-17T05:56:01.100Z")),
            (
                "2026-02-17T05:56:01.123456789Z",
                Some("2026-02-17T05:56:01.123Z"),
            ),
            ("2026-02-17T05:56:01.Z", None),
            ("2026-02-17t05:56:01z", Some("2026-02-17T05:56:01.000Z")),
            ("2026-02-17T05:56Z", Some("2026-02-17T05:56:00.000Z")),
            ("2026-02-17T05Z", None),
            ("2026-02", Some("2026-02-01T00:00:00.000Z")),
            ("2026", Some("2026-01-01T00:00:00.000Z")),
            ("2026-02-17T05:56:01+0200", Some("2026-02-17T03:56:01.000Z")),
            ("2026-02-17T05:56:01+24:00", None),
            (
                "2026-02-17T05:56:01+23:59",
                Some("2026-02-16T05:57:01.000Z"),
            ),
            ("-000000-01-01T00:00:00Z", None),
            (
                "+275760-09-13T00:00:00.000Z",
                Some("+275760-09-13T00:00:00.000Z"),
            ),
            ("+275760-09-13T00:00:00.001Z", None),
            (
                "-271821-04-20T00:00:00.000Z",
                Some("-271821-04-20T00:00:00.000Z"),
            ),
            ("-271821-04-19T23:59:59.999Z", None),
            (" 2026-02-17T05:56:01Z", None),
            ("2026-2-17T05:56:01Z", None),
            ("20260-02-17T05:56:01Z", None),
        ];
        for (text, expected) in cases {
            assert_eq!(iso(text).as_deref(), expected, "{text}");
        }
    }

    #[test]
    fn prints_the_way_rooms_do() {
        let t = Some("2026-02-17T05:56:01.000Z");
        assert_eq!(format_played_at(t, true), "2026/02/17 05:56:01");
        assert_eq!(format_played_at(t, false), "2026/02/17 5:56:01");
        assert_eq!(format_played_at(None, true), "");
        assert_eq!(format_played_at(Some(""), true), "");
        assert_eq!(
            format_played_at(Some("nope"), false),
            "NaN/NaN/NaN NaN:NaN:NaN"
        );
        assert_eq!(
            format_played_at(Some("0999-01-02T03:04:05.000Z"), true),
            "999/01/02 03:04:05"
        );
        assert_eq!(
            format_played_at(Some("-000001-12-31T23:59:59.000Z"), true),
            "-1/12/31 23:59:59"
        );
    }

    #[test]
    fn reads_a_header_timestamp_as_utc() {
        assert_eq!(
            parse_played_at("Hold'em No Limit ($1/$2) - 2026/02/17 5:56:01").as_deref(),
            Some("2026-02-17T05:56:01.000Z")
        );
        assert_eq!(
            parse_played_at("x 2026-02-31T24:00:00").as_deref(),
            Some("2026-03-04T00:00:00.000Z")
        );
        assert_eq!(parse_played_at("x 2026/13/01 00:00:00"), None);
        assert_eq!(parse_played_at("no date"), None);
    }
}
