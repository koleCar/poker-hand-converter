//! Text helpers shared by the two PartyGaming-lineage dialects, 888poker and
//! partypoker (`web/src/lib/parsers/shared/p2-partygaming.ts`), and by
//! the rooms that borrow pieces of them: PokerBros' party-dialect converter
//! (the date and game patterns, `bracketAmount`, the noise list) and Ongame
//! (`isoFromPartyDate`, `knownZone`).
//!
//! The two formats share their skeleton - a `***** Hand History for Game N
//! *****` banner, `Seat n: name ( $x )`, `** Dealing ... **` street markers,
//! bracketed amounts - which is why most of this is about telling them apart.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `p2-partygaming.ts`). Amounts are JavaScript numbers ([`JsNumber`]): the
//! draft builder computes with them in doubles and prints them
//! (`p2_handbuilder`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::js::{self, JsNumber};
use crate::phf::CurrencyUnit;
use crate::phf::money::{EUR, GBP, USD, parse_amount_js};
use crate::phf::serialize::{date_utc, to_iso_string};

/// `BANNER_REGEX`: `***** 888poker Hand History for Game 349736402 *****`
/// and its skins.
pub static BANNER_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*{3,}\s*(.*?)\s*Hand History for Game\s+(\d+)\s*\*{3,}$",
    ""
);

/// `P888_STAKES_REGEX`: 888's stakes line, `$0.05/$0.10 Blinds No Limit
/// Holdem - *** 06 01 2014 22:40:28`.
pub static P888_STAKES_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^([^/]*?)\/(.*?)\s+Blinds\s+(.+?)\s+-\s+\*{3}\s+(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})",
    ""
);

/// `P888_AMOUNT_REGEX`: one half of an 888 stakes line, English locale.
pub static P888_AMOUNT_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^([$€£]?)([\d,]+(?:\.\d+)?)$", "");

/// `PARTY_DATE_REGEX`: partypoker's stakes line, split at its weekday-name
/// date with a zone abbreviation.
pub static PARTY_DATE_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+-\s+(?:\w+day),\s+(\w+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Za-z]{2,5})\s+(\d{4})\s*$",
    ""
);

/// `PARTY_GAME_REGEX`: the half in front of the date - blinds
/// (`$0.05/$0.10 USD NL Texas Hold'em`) or a maximum buy-in (`$100 USD PL
/// Omaha`).
pub static PARTY_GAME_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^([$€£]?)([\d,]+(?:\.\d+)?)(?:\/([$€£]?)([\d,]+(?:\.\d+)?))?\s+([A-Z]{3})\s+(NL|PL|FL|No Limit|Pot Limit|Fixed Limit|Limit)\s+(.+)$",
    ""
);

static BRACKET_PART: LazyLock<Regex> = crate::js_regex_lazy!(r"[\d,]+(?:\.\d+)?", "g");
static GAME_NO: LazyLock<Regex> = crate::js_regex_lazy!(r"^#\s*Game No\s*:", "");
static NOISE_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:#\s*Game No\s*:|Game #\d+ starts\.|Total number of players\s*:|Your time bank will be activated)",
    ""
);
static NOISE_SUFFIX_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"(?:\bhas joined the table\.?|\bhas left the table\.?|\bis sitting out\b|\bwill be using (?:his|her|their) time bank for this hand\.?|\bdid not respond in time\b|\bwas removed from the table for failing to post\b|\bfinished the tournament\b)$",
    ""
);
static CHAT_SPEAKER: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?):\s", "");

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

/// `ZONE_OFFSETS`: minutes east of UTC for the abbreviations partypoker
/// stamps its hands with.
const ZONE_OFFSETS: [(&str, i64); 20] = [
    ("UTC", 0),
    ("GMT", 0),
    ("BST", 60),
    ("WET", 0),
    ("WEST", 60),
    ("CET", 60),
    ("CEST", 120),
    ("EET", 120),
    ("EEST", 180),
    ("MSK", 180),
    ("AST", -240),
    ("ADT", -180),
    ("EST", -300),
    ("EDT", -240),
    ("CST", -360),
    ("CDT", -300),
    ("MST", -420),
    ("MDT", -360),
    ("PST", -480),
    ("PDT", -420),
];

/// `ZONE_OFFSETS[abbreviation.toUpperCase()]`. (The TypeScript's `in` also
/// sees `Object.prototype`'s members, but none of them is all upper case.)
fn zone_offset(abbreviation: &str) -> Option<i64> {
    let upper = js::to_upper_case(abbreviation);
    ZONE_OFFSETS
        .iter()
        .find(|(zone, _)| *zone == upper)
        .map(|(_, offset)| *offset)
}

/// `text.replace(/^\uFEFF/, "")`: one leading byte order mark.
fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// `text.split(/\r?\n/)`.
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// The banner line and the stakes line right under it (`bannerAndStakes`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannerAndStakes {
    pub banner: String,
    pub stakes: String,
}

/// `bannerAndStakes(text)`: the first line that is a banner once a leading
/// BOM and surrounding whitespace are gone, and the (likewise cleaned) line
/// under it - `""` when there is none.
pub fn banner_and_stakes(text: &str) -> Option<BannerAndStakes> {
    let lines = split_lines(text);
    for (i, raw) in lines.iter().enumerate() {
        let line = js::trim(strip_bom(raw));
        if BANNER_REGEX.is_match(line) {
            let stakes = lines
                .get(i + 1)
                .map_or("", |next| js::trim(strip_bom(next)));
            return Some(BannerAndStakes {
                banner: line.to_owned(),
                stakes: stakes.to_owned(),
            });
        }
    }
    None
}

/// `knownZone(abbreviation)`.
pub fn known_zone(abbreviation: &str) -> bool {
    zone_offset(abbreviation).is_some()
}

/// `Number(digits)` as an integer for `Date.UTC`; `None` (an invalid date)
/// for anything that is not one - the callers pass `\d+` captures.
fn date_field(text: &str) -> Option<i64> {
    JsNumber::parse(text).to_i64()
}

/// `isoFromPartyDate(monthName, day, hour, minute, second, zone, year)`: the
/// UTC instant of a partypoker date line; an unknown zone counts as UTC (the
/// caller warns), an unknown month is `None`.
pub fn iso_from_party_date(
    month_name: &str,
    day: &str,
    hour: &str,
    minute: &str,
    second: &str,
    zone: &str,
    year: &str,
) -> Option<String> {
    let lower = js::to_lower_case(month_name);
    let month = MONTHS.iter().position(|name| *name == lower)?;
    let month = i64::try_from(month).ok()?;
    let offset = zone_offset(zone).unwrap_or(0);
    let local = date_utc(
        date_field(year)?,
        month,
        date_field(day)?,
        date_field(hour)?,
        date_field(minute)?,
        date_field(second)?,
    )?;
    // `new Date(local - offset * 60_000)`: TimeClip again (unreachable for
    // four-digit years; the TypeScript's `toISOString` would throw).
    let instant = local - offset * 60_000;
    (instant.abs() <= 8_640_000_000_000_000).then(|| to_iso_string(instant))
}

/// `isoFrom888Date(day, month, year, hour, minute, second)`: 888 stamps no
/// zone; the month is 1-based and rolls over like any `Date.UTC` field.
pub fn iso_from_888_date(
    day: &str,
    month: &str,
    year: &str,
    hour: &str,
    minute: &str,
    second: &str,
) -> Option<String> {
    date_utc(
        date_field(year)?,
        date_field(month)? - 1,
        date_field(day)?,
        date_field(hour)?,
        date_field(minute)?,
        date_field(second)?,
    )
    .map(to_iso_string)
}

/// `unitFor(symbol)`: `€` is EUR, `£` GBP, anything else USD.
pub fn unit_for(symbol: &str) -> CurrencyUnit {
    match symbol {
        "€" => EUR.unit(),
        "£" => GBP.unit(),
        _ => USD.unit(),
    }
}

/// `bracketAmount(raw, unit)`: `[$1 + $2]`, `[$0.05 USD]`, `[ $0.19 ]` ->
/// minor units, summed (as doubles, from 0).
pub fn bracket_amount(raw: &str, unit: &CurrencyUnit) -> JsNumber {
    BRACKET_PART
        .find_iter(raw)
        .fold(JsNumber::ZERO, |sum, part| {
            sum + parse_amount_js(part.as_str(), unit)
        })
}

/// `raw.match(/[\d,]+(?:\.\d+)?/g) ?? []`: the amounts of a bracket.
pub(crate) fn bracket_parts(raw: &str) -> Vec<&str> {
    BRACKET_PART.find_iter(raw).map(|m| m.as_str()).collect()
}

/// `splitBanneredHands(text)`: one chunk per banner line, each starting at
/// the `#Game No :` line right above its banner when there is one; chunks
/// trimmed (and one more BOM dropped), empty ones left out.
pub fn split_bannered_hands(text: &str) -> Vec<String> {
    let lines = split_lines(strip_bom(text));
    let clean = |line: &str| js::trim(strip_bom(line)).to_owned();
    let mut starts: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !BANNER_REGEX.is_match(&clean(line)) {
            continue;
        }
        let previous = i.checked_sub(1).map_or(String::new(), |p| clean(lines[p]));
        starts.push(if GAME_NO.is_match(&previous) {
            i - 1
        } else {
            i
        });
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(index, &start)| {
            let end = starts.get(index + 1).copied().unwrap_or(lines.len());
            // `Array.prototype.slice` with an end before the start is empty.
            let joined = if end > start {
                lines[start..end].join("\n")
            } else {
                String::new()
            };
            let chunk = js::trim(strip_bom(&joined)).to_owned();
            (!chunk.is_empty()).then_some(chunk)
        })
        .collect()
}

/// `isNoiseLine(line)`: a line deliberately dropped (an explicit list, so a
/// new line shape still raises `unknown-line`).
pub fn is_noise_line(line: &str) -> bool {
    NOISE_REGEX.is_match(line) || NOISE_SUFFIX_REGEX.is_match(line)
}

/// `isChatLine(line, seatNames)`: `speaker: text` where the speaker is a
/// seated player.
pub fn is_chat_line(line: &str, seat_names: &HashSet<String>) -> bool {
    CHAT_SPEAKER
        .captures(line)
        .is_some_and(|c| seat_names.contains(&c[1]))
}

/// `^\*{2}\s*Dealing\s+${street}\s*\*{2}\s*\[([^\]]*)\]` for the three board
/// streets (case-insensitive, matched at JavaScript line starts below).
static DEALING: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    ["flop", "turn", "river"]
        .map(|street| js::regex::js_regex(&BOARD_TEMPLATE.replace("${street}", street), "i"))
});

/// The `String.raw` template of `boardOf` in `partypoker.ts` and
/// `pokerstars888.ts` (each file has its own copy).
pub(crate) const BOARD_TEMPLATE: &str = r"^\*{2}\s*Dealing\s+${street}\s*\*{2}\s*\[([^\]]*)\]";

/// `boardOf(raw, street)` of partypoker and 888poker: the cards of the first
/// `** Dealing <street> ** [ ... ]` at a JavaScript line start (`/im`) -
/// `None` when there is none or it lists no card.
pub(crate) fn dealing_board(raw: &str, street: &str) -> Option<Vec<String>> {
    let pattern = match street {
        "flop" => &DEALING[0],
        "turn" => &DEALING[1],
        _ => &DEALING[2],
    };
    let captures = crate::phf::serialize::line_starts(raw)
        .find_map(|start| pattern.captures(&raw[start..]))?;
    let cards = crate::cards::extract_cards(&captures[1]);
    (!cards.is_empty()).then_some(cards)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str =
        include_str!("../../../../../web/src/lib/parsers/shared/p2-partygaming.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/^\*{3,}\s*(.*?)\s*Hand History for Game\s+(\d+)\s*\*{3,}$/",
            r"/^([^/]*?)\/(.*?)\s+Blinds\s+(.+?)\s+-\s+\*{3}\s+(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/",
            r"/^([$€£]?)([\d,]+(?:\.\d+)?)$/",
            r"/^(.+?)\s+-\s+(?:\w+day),\s+(\w+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Za-z]{2,5})\s+(\d{4})\s*$/",
            r"/^([$€£]?)([\d,]+(?:\.\d+)?)(?:\/([$€£]?)([\d,]+(?:\.\d+)?))?\s+([A-Z]{3})\s+(NL|PL|FL|No Limit|Pot Limit|Fixed Limit|Limit)\s+(.+)$/",
            r"/[\d,]+(?:\.\d+)?/g",
            r"/^#\s*Game No\s*:/",
            r"/^(?:#\s*Game No\s*:|Game #\d+ starts\.|Total number of players\s*:|Your time bank will be activated)/",
            r"/(?:\bhas joined the table\.?|\bhas left the table\.?|\bis sitting out\b|\bwill be using (?:his|her|their) time bank for this hand\.?|\bdid not respond in time\b|\bwas removed from the table for failing to post\b|\bfinished the tournament\b)$/",
            r"/^(.+?):\s/",
            r"/^\uFEFF/",
            r"/\r?\n/",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
        for (zone, offset) in ZONE_OFFSETS {
            assert!(source.contains(&format!("  {zone}: {offset},\n")), "{zone}");
        }
        for month in MONTHS {
            assert!(source.contains(&format!("  \"{month}\",\n")), "{month}");
        }
    }

    #[test]
    fn dates_roll_over_like_date_utc() {
        // Recorded from Node: `isoFromPartyDate("January", "06", "08", "54",
        // "23", "EST", "2014")` and friends.
        assert_eq!(
            iso_from_party_date("January", "06", "08", "54", "23", "EST", "2014").as_deref(),
            Some("2014-01-06T13:54:23.000Z")
        );
        assert_eq!(
            iso_from_party_date("february", "31", "23", "59", "59", "cest", "2014").as_deref(),
            Some("2014-03-03T21:59:59.000Z")
        );
        assert_eq!(
            iso_from_party_date("March", "1", "0", "00", "00", "XYZ", "0014").as_deref(),
            Some("1914-03-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_party_date("Smarch", "1", "0", "00", "00", "UTC", "2014"),
            None
        );
        assert_eq!(
            iso_from_888_date("06", "01", "2014", "22", "40", "28").as_deref(),
            Some("2014-01-06T22:40:28.000Z")
        );
        assert_eq!(
            iso_from_888_date("00", "00", "2014", "99", "99", "99").as_deref(),
            Some("2013-12-04T04:40:39.000Z")
        );
        assert_eq!(
            iso_from_888_date("99", "99", "9999", "99", "99", "99").as_deref(),
            Some("+010007-06-11T04:40:39.000Z")
        );
    }

    #[test]
    fn splits_on_the_banner_keeping_the_game_number_line() {
        let text = "\u{FEFF}#Game No : 1\r\n***** 888poker Hand History for Game 1 *****\r\nx\n\n#Game No : 2\n***** Hand History for Game 2 *****\ny\n";
        assert_eq!(
            split_bannered_hands(text),
            vec![
                "#Game No : 1\n***** 888poker Hand History for Game 1 *****\nx".to_owned(),
                "#Game No : 2\n***** Hand History for Game 2 *****\ny".to_owned(),
            ]
        );
        assert!(split_bannered_hands("").is_empty());
    }
}
