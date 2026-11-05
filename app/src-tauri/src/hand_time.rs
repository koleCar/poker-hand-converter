//! When a refused hand was played, read from its header line: the core
//! refused the hand, so there is no parsed hand to ask, only its text.
//!
//! Lenient on purpose and display only: the date and time are kept as the
//! room wrote them (its own clock), with the zone the room named, if any,
//! next to them. Nothing is converted, so nothing is guessed about zones.
//! A header this does not recognise gives `None`, and the list shows a dash.

use serde::Serialize;

/// A hand's date and time as its header wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandTime {
    /// `YYYY-MM-DDTHH:MM`, the room's wall clock.
    pub at: String,
    /// The zone the header names right after the time (`UTC`, `ET`, `CET`).
    pub zone: Option<String>,
}

/// How many non-empty lines of the text are looked at: the header is the
/// first line on most rooms, the third on 888poker.
const LINES: usize = 4;

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// The date and time in `header` (the start of a hand's raw text).
pub fn hand_time(header: &str) -> Option<HandTime> {
    header
        .lines()
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .filter(|line| !line.is_empty())
        .take(LINES)
        .find_map(|line| {
            numeric_date(line)
                .or_else(|| day_first_date(line))
                .or_else(|| month_name_date(line))
                .or_else(|| compact_stamp(line))
        })
}

#[derive(Debug, Clone, Copy)]
struct Date {
    year: u32,
    month: u32,
    day: u32,
}

#[derive(Debug, Clone, Copy)]
struct Time {
    hour: u32,
    minute: u32,
    /// Byte offset just past the time (seconds included), for the zone.
    end: usize,
}

fn valid(date: Date, time: Time) -> bool {
    (1990..=2100).contains(&date.year)
        && (1..=12).contains(&date.month)
        && (1..=31).contains(&date.day)
        && time.hour < 24
        && time.minute < 60
}

fn result(line: &str, date: Date, time: Time) -> Option<HandTime> {
    valid(date, time).then(|| HandTime {
        at: format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            date.year, date.month, date.day, time.hour, time.minute
        ),
        zone: zone_after(line, time.end),
    })
}

/// A run of ASCII digits starting at `at`: its value and where it ends.
fn digits(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let len = bytes[at..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if len == 0 || len > 9 {
        return None;
    }
    let text = std::str::from_utf8(&bytes[at..at + len]).ok()?;
    Some((text.parse().ok()?, at + len))
}

/// Whether a number starts at `at` (no digit just before it).
fn starts_number(bytes: &[u8], at: usize) -> bool {
    bytes[at].is_ascii_digit() && (at == 0 || !bytes[at - 1].is_ascii_digit())
}

/// `H:MM` or `HH:MM`, optionally `:SS`, starting at `at`.
fn time_at(bytes: &[u8], at: usize) -> Option<Time> {
    let (hour, after_hour) = digits(bytes, at)?;
    if after_hour - at > 2 || bytes.get(after_hour) != Some(&b':') {
        return None;
    }
    let (minute, after_minute) = digits(bytes, after_hour + 1)?;
    if after_minute - after_hour - 1 != 2 {
        return None;
    }
    let mut end = after_minute;
    if bytes.get(end) == Some(&b':')
        && let Some((_, after_second)) = digits(bytes, end + 1)
        && after_second - end - 1 == 2
    {
        end = after_second;
    }
    Some(Time { hour, minute, end })
}

/// The first time in `line` at or after `from`, else the first one before.
fn time_near(line: &str, from: usize) -> Option<Time> {
    let bytes = line.as_bytes();
    let find = |range: std::ops::Range<usize>| {
        range
            .filter(|&at| starts_number(bytes, at))
            .find_map(|at| time_at(bytes, at))
    };
    find(from..bytes.len()).or_else(|| find(0..from))
}

/// A zone named right after the time: 1-5 capital letters, then not a letter.
fn zone_after(line: &str, end: usize) -> Option<String> {
    let rest = line.get(end..)?.strip_prefix(' ')?;
    let zone: String = rest.chars().take_while(char::is_ascii_uppercase).collect();
    let next = rest[zone.len()..].chars().next();
    ((1..=5).contains(&zone.len()) && !next.is_some_and(char::is_alphabetic)).then_some(zone)
}

/// `YYYY/MM/DD` (or `-`, `.`) and a time on the same line, before or after it:
/// PokerStars, GGPoker, WePlay, Winamax, ACR, Full Tilt, Unibet, ...
fn numeric_date(line: &str) -> Option<HandTime> {
    let bytes = line.as_bytes();
    (0..bytes.len())
        .filter(|&at| starts_number(bytes, at))
        .find_map(|at| {
            let (year, after_year) = digits(bytes, at)?;
            if after_year - at != 4 {
                return None;
            }
            let sep = *bytes.get(after_year)?;
            if !matches!(sep, b'/' | b'-' | b'.') {
                return None;
            }
            let (month, after_month) = digits(bytes, after_year + 1)?;
            if after_month - after_year - 1 > 2 || bytes.get(after_month) != Some(&sep) {
                return None;
            }
            let (day, after_day) = digits(bytes, after_month + 1)?;
            if after_day - after_month - 1 > 2 {
                return None;
            }
            let time = time_near(line, after_day)?;
            result(line, Date { year, month, day }, time)
        })
}

/// `DD MM YYYY HH:MM:SS`: 888poker.
fn day_first_date(line: &str) -> Option<HandTime> {
    let bytes = line.as_bytes();
    (0..bytes.len())
        .filter(|&at| starts_number(bytes, at))
        .find_map(|at| {
            let (day, after_day) = digits(bytes, at)?;
            if after_day - at != 2 || bytes.get(after_day) != Some(&b' ') {
                return None;
            }
            let (month, after_month) = digits(bytes, after_day + 1)?;
            if after_month - after_day - 1 != 2 || bytes.get(after_month) != Some(&b' ') {
                return None;
            }
            let (year, after_year) = digits(bytes, after_month + 1)?;
            if after_year - after_month - 1 != 4 || bytes.get(after_year) != Some(&b' ') {
                return None;
            }
            let time = time_at(bytes, after_year + 1)?;
            result(line, Date { year, month, day }, time)
        })
}

/// A month by name, its day after it, a time and a year on the same line:
/// partypoker (`Monday, January 06, 05:54:36 EST 2014`), Ongame
/// (`Mon Jan 06 01:06:00 CET 2014`).
fn month_name_date(line: &str) -> Option<HandTime> {
    let words: Vec<(usize, &str)> = line
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        // Where the word starts in `line` (a sub-slice of it).
        .map(|word| (word.as_ptr() as usize - line.as_ptr() as usize, word))
        .collect();
    let year = words.iter().find_map(|(_, word)| {
        (word.len() == 4)
            .then(|| word.parse::<u32>().ok())
            .flatten()
            .filter(|year| (1990..=2100).contains(year))
    })?;
    words.windows(2).find_map(|pair| {
        let [(at, name), (_, day)] = pair else {
            return None;
        };
        let name = name.to_ascii_lowercase();
        let month = MONTHS
            .iter()
            .position(|month| name == *month || (name.len() == 3 && month.starts_with(&name)))?;
        if day.len() > 2 {
            return None;
        }
        let day: u32 = day.parse().ok()?;
        let time = time_near(line, *at)?;
        let month = u32::try_from(month).ok()? + 1;
        result(line, Date { year, month, day }, time)
    })
}

/// `YYYYMMDDHHMMSS` in one piece: the Merge network's `starttime`.
fn compact_stamp(line: &str) -> Option<HandTime> {
    let bytes = line.as_bytes();
    (0..bytes.len())
        .filter(|&at| starts_number(bytes, at))
        .find_map(|at| {
            let len = bytes[at..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            if len != 14 {
                return None;
            }
            let part = |from: usize, to: usize| line[at + from..at + to].parse::<u32>().ok();
            let date = Date {
                year: part(0, 4)?,
                month: part(4, 6)?,
                day: part(6, 8)?,
            };
            let time = Time {
                hour: part(8, 10)?,
                minute: part(10, 12)?,
                end: at + len,
            };
            valid(date, time).then(|| HandTime {
                at: format!(
                    "{:04}-{:02}-{:02}T{:02}:{:02}",
                    date.year, date.month, date.day, time.hour, time.minute
                ),
                zone: None,
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(header: &str) -> Option<(String, Option<String>)> {
        hand_time(header).map(|time| (time.at, time.zone))
    }

    fn some(at: &str, zone: Option<&str>) -> Option<(String, Option<String>)> {
        Some((at.to_owned(), zone.map(str::to_owned)))
    }

    #[test]
    fn rooms_headers() {
        // WePlay
        assert_eq!(
            at(
                "\u{feff}Weplay Hand #71443807:  Hold'em No Limit ($0.25/$0.50) - 2026/01/03 14:40:47 UTC\nTable 'Manchester #1'"
            ),
            some("2026-01-03T14:40", Some("UTC"))
        );
        // PokerStars, both clocks: the first one.
        assert_eq!(
            at(
                "PokerStars Hand #1: Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 13:22:02 CET [2014/01/06 7:22:02 ET]"
            ),
            some("2014-01-06T13:22", Some("CET"))
        );
        assert_eq!(
            at(
                "PokerStars Game #109681344065:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 7:22:02 ET"
            ),
            some("2014-01-06T07:22", Some("ET"))
        );
        // GGPoker: no zone.
        assert_eq!(
            at(
                "Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01\nTable 'NLHPurple70'"
            ),
            some("2026-02-17T05:56", None)
        );
        // Run It Once: no seconds.
        assert_eq!(
            at(
                "Run It Once Poker Hand #30266126:  Hold'em No Limit (€0.05/€0.10) - 2019/06/25 16:12 UTC [2019/06/25 17:12 CET]"
            ),
            some("2019-06-25T16:12", Some("UTC"))
        );
        // Full Tilt and Unibet: the time before the date.
        assert_eq!(
            at(
                "Full Tilt Poker Game #33727950903: Table Goldring (heads up) - NL Hold'em - $5/$10 - 21:11:15 ET - 2014/01/05"
            ),
            some("2014-01-05T21:11", Some("ET"))
        );
        assert_eq!(
            at(
                "Game #1463192545: Table 1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04"
            ),
            some("2021-04-04T13:22", None)
        );
        // 888poker: the third line, day first.
        assert_eq!(
            at(
                "\u{feff}#Game No : 349736402\n***** 888poker Hand History for Game 349736402 *****\n$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28\n"
            ),
            some("2014-01-06T22:40", None)
        );
        // partypoker and Ongame: the month by name.
        assert_eq!(
            at(
                "***** Hand History for Game 13550420797 *****\n$0.05/$0.10 USD NL Texas Hold'em - Monday, January 06, 05:54:36 EST 2014"
            ),
            some("2014-01-06T05:54", Some("EST"))
        );
        assert_eq!(
            at(
                "***** History for hand R5-361850810-474 *****\nStart hand: Mon Jan 06 01:06:00 CET 2014"
            ),
            some("2014-01-06T01:06", Some("CET"))
        );
        // Microgaming and Merge XML.
        assert_eq!(
            at(r#"<Game hhversion="4" id="5049092037" date="2013-09-23 14:27:55" tablename="x">"#),
            some("2013-09-23T14:27", None)
        );
        assert_eq!(
            at(
                "<description type=\"Omaha\"/>\n<game id=\"56176485-33\" starttime=\"20120529182537\" numholecards=\"4\">"
            ),
            some("2012-05-29T18:25", None)
        );
    }

    #[test]
    fn nothing_to_read() {
        assert_eq!(at(""), None);
        assert_eq!(at("garbage $0.25/$0.50 and 1/2/3"), None);
        // A date without a time is not enough.
        assert_eq!(at("Tournament 2026/01/03 Table 5"), None);
        // Out of range.
        assert_eq!(at("Hand - 2026/13/03 14:40:47"), None);
    }
}
