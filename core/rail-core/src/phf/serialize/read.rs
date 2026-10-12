//! Standard text → PHF: `parseStandardHand`, `splitStandardHands`,
//! `parseStandardText` and the header reader the writer also uses.
//!
//! A line-for-line port. The TypeScript keeps several `Map`s whose iteration
//! order or overwrite behaviour shows in the output; they are `Vec`s of pairs
//! here, updated with `Map.set` semantics (a key keeps its first position).
//! Players are referenced by index where the TypeScript shares the object.
//!
//! **What a Rust hand cannot hold.** The TypeScript writes `seat: -1` into
//! `game.straddles` for a straddler with no seat line, and any `\d+` it reads
//! as a seat, table size, button or level becomes a JavaScript number however
//! large. A PHF seat is a `u32` (R0.4), so those hands are an error here
//! ([`JsError`], which the parser turns into a `parser-error`) rather than a
//! hand with a made-up seat. No corpus text gets there. And `-0`: the
//! TypeScript records an uncalled bet of 0 as `amount: -0`, which
//! `JSON.stringify` writes as `0`; a Rust amount is simply 0.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::date::parse_played_at;
use super::{HEADER, RUN_PREFIXES, first_line, line_starts, number_u32, split_lines, strip_bom};
use crate::cards::extract_cards;
use crate::js::{self, JsError};
use crate::phf::game::map_set;
use crate::phf::hilo::{NO_LOW_LINE, assign_hi_lo_halves, check_no_low_stated};
use crate::phf::money::{
    USD, chips_unit_for, format_amount, parse_amount, parse_buy_in_token, unit_for_symbol,
};
use crate::phf::{
    ActionType, Amount, AnteModel, BUTTON_BLIND_VERB, ChipMovementAnchor, CurrencyUnit,
    DecimalStyle, GameFormat, LimitType, PhfAction, PhfBoard, PhfBombPot, PhfChipMovement, PhfFees,
    PhfGame, PhfHand, PhfMarkerLabels, PhfMeta, PhfPlayer, PhfPlayerResult, PhfPot, PhfResults,
    PhfRunout, PhfSchema, PhfStraddle, PhfTable, PhfTextStyle, PhfTournament, PhfWarning,
    PhfWinner, SeatOutcome, Street, is_hi_lo_label, resolve_positions, resolve_runout,
    variant_from_label,
};

/// `STANDARD_TEXT_PARSER_VERSION`: bumped whenever the grammar changes.
pub const STANDARD_TEXT_PARSER_VERSION: &str = "1.0.0";

/// `ParseContext`, plus the clock the TypeScript reads itself.
#[derive(Debug, Clone, Copy)]
pub struct StandardContext<'a> {
    pub site_id: &'a str,
    pub site_name: &'a str,
    pub original_filename: Option<&'a str>,
    /// Stamped on `meta.parserId`; `"standard"` when `None`.
    pub parser_id: Option<&'a str>,
    /// Stamped on `meta.parserVersion`; [`STANDARD_TEXT_PARSER_VERSION`]
    /// when `None`.
    pub parser_version: Option<&'a str>,
    /// `meta.parsedAt` (`new Date().toISOString()` in TypeScript).
    pub parsed_at: &'a str,
}

/* ------------------------------------------------------------- patterns - */

/// `MONEY`: a printed amount; the symbol set is `unitForSymbol`'s.
const MONEY: &str = r"(?:\$|€|£|₮)?([\d,]+(?:\.\d+)?)";

fn with_money(template: &str, flags: &str) -> Regex {
    crate::js::regex::js_regex(&template.replace("${MONEY}", MONEY), flags)
}

macro_rules! money_regex {
    ($template:expr) => {
        LazyLock::new(|| with_money($template, ""))
    };
    ($template:expr, $flags:expr) => {
        LazyLock::new(|| with_money($template, $flags))
    };
}

static TABLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table\s+'(.*)'\s+(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?\s*$",
    ""
);
static SEAT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.+)\s+\((\S+)\s+in chips\)$", "");
static MARKER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$",
    "i"
);
static CHATTER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\b(?:joins the table|leaves the table|sits out|has timed out|is (?:dis)?connected|declines straddle|was run two times|said,|will be allowed to play after the button|stands up|posts?\s+dead)\b",
    "i"
);
/// The first line of a hand, for `splitStandardHands`' lookahead.
static SPLIT_HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#", "i");

static ROMAN: LazyLock<Regex> = crate::js_regex_lazy!(r"^[IVXLCDM]+$", "");
static LIMIT_PL: LazyLock<Regex> = crate::js_regex_lazy!(r"pot\s*limit|\bPL\b|\bPLO-?\d?\b", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"fixed\s*limit", "i");
static LIMIT_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"\bLimit\b", "i");
static HOLD_AHEAD: LazyLock<Regex> = crate::js_regex_lazy!(r"^\s*Hold", "i");
static NO_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"no\s*limit", "i");
static PAD_HOUR: LazyLock<Regex> =
    crate::js_regex_lazy!(r"\d{4}[/-]\d{2}[/-]\d{2}[ T](\d{1,2}):\d{2}:\d{2}", "");
static GAME_LABEL_TAIL: LazyLock<Regex> = crate::js_regex_lazy!(
    r"((?:Hold\s*'?\s*em|Omaha|Short\s*Deck|6\+|Stud|Razz|Draw|Badugi|Mixed|HORSE|8-Game)\b.*)$",
    "i"
);
static GAME_LABEL_EXACT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"((?:Mixed\s+)?(?:Hold\s*'?\s*em|Omaha(?:\s*Hi(?:\s*\/\s*Lo)?)?|Short\s*Deck|6\+\s*Hold\s*'?\s*em|Stud(?:\s*Hi(?:\s*\/\s*Lo)?)?|Razz|Badugi|HORSE|8-Game|PLO\d?|NLO\d?)\s+(?:No\s+Limit|Pot\s+Limit|Fixed\s+Limit|Limit))$",
    "i"
);
static BUY_IN_TOKEN: LazyLock<Regex> = crate::js_regex_lazy!(
    r"((?:[$€£₮]\s?[\d,]+(?:\.\d+)?(?:\s*\+\s*[$€£₮]?[\d,]+(?:\.\d+)?)*)|Freeroll)",
    "i"
);
static TOURNAMENT_HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Tournament\s*(?:\(([^]*?)\))?\s*#(\S+?),\s*(.+?)\s+-\s+(?:Level\s*([IVXLCDM]+|\d+)\s*)?\(([^)]*)\)\s+-\s+(.*)$",
    ""
);
static CASH_HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$", "");

static SUMMARY_SEAT_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat\s+\d+:\s*", "");
static POSITION_LABEL: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\((button|small blind|big blind)\)\s*", "i");
static SHOWN: LazyLock<Regex> = crate::js_regex_lazy!(r"(?:showed|mucked)\s+\[([^\]]*)\]", "i");
static CASHOUT_RISK: LazyLock<Regex> = money_regex!(r"Cashout Risk \(${MONEY}\)");
static FOLDED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^folded\s+(?:before Flop|on the (Flop|Turn|River))", "i");
static DIDNT_BET: LazyLock<Regex> = crate::js_regex_lazy!(r"\(didn't bet\)", "i");
static MUCKED: LazyLock<Regex> = crate::js_regex_lazy!(r"^mucked\b", "i");
static WON: LazyLock<Regex> = money_regex!(r"(?:won|collected)\s+\(${MONEY}\)");
static DESCRIPTION: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\bwith\s+(.+?)(?:,\s+(?:and\s+)?(?:won|lost|Cashout Risk)\b.*)?$",
    "i"
);
static TRAILING_COMMA: LazyLock<Regex> = crate::js_regex_lazy!(r",\s*$", "");
static SHOWED: LazyLock<Regex> = crate::js_regex_lazy!(r"^showed\b", "i");
static COLLECTED_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"\bcollected\b", "i");

static SUMMARY_MARKER: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY", "i");
static TOTAL_POT: LazyLock<Regex> = money_regex!(r"^Total pot ${MONEY}");
static SIDE_POTS: LazyLock<Regex> = money_regex!(r"(Main|Side) pot ${MONEY}\.", "g");
static RAKE: LazyLock<Regex> = money_regex!(r"Rake ${MONEY}");
static JACKPOT: LazyLock<Regex> = money_regex!(r"Jackpot ${MONEY}");
static BINGO: LazyLock<Regex> = money_regex!(r"Bingo ${MONEY}");
static FORTUNE: LazyLock<Regex> = money_regex!(r"Fortune ${MONEY}");
static TAX: LazyLock<Regex> = money_regex!(r"Tax ${MONEY}");
static RUN_TIMES: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Hand was run (?:two|three|four) times$", "i");
static BOARD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat\s+(\d+):", "");
static DROP: LazyLock<Regex> =
    money_regex!(r"^(?:Cash Drop to Pot\s*:\s*total|STP added:)\s*${MONEY}$");
static STP: LazyLock<Regex> = crate::js_regex_lazy!(r"^STP", "");
static GROUP: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");
static WHITESPACE_RUN: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+", "g");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS", "i");
static DEALT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Dealt to\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$", "");
static UNCALLED: LazyLock<Regex> = money_regex!(r"^Uncalled bet \(${MONEY}\) returned to (.+)$");
static COLLECTED: LazyLock<Regex> =
    money_regex!(r"^(.+?) collected ${MONEY} from (?:the )?(.+?)\s*$");
static ANTE: LazyLock<Regex> = money_regex!(r"^(.+?): posts the ante ${MONEY}( and is all-in)?$");
static BLIND: LazyLock<Regex> =
    money_regex!(r"^(.+?): posts (small|big|button) blind ${MONEY}( and is all-in)?$");
static MISSED_BLIND: LazyLock<Regex> = money_regex!(r"^(.+?): posts missed blind ${MONEY}$");
static CASHOUT_CHOOSE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): Chooses to EV Cashout$", "");
static CASHOUT_PAY: LazyLock<Regex> = money_regex!(r"^(.+?): Pays Cashout Risk \(${MONEY}\)$");
static POST: LazyLock<Regex> =
    money_regex!(r"^(.+?): (posts straddle|straddle|posts) ${MONEY}( and is all-in)?$");
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?): (folds|checks)$", "");
static CALL_BET: LazyLock<Regex> = money_regex!(r"^(.+?): (calls|bets) ${MONEY}( and is all-in)?$");
static RAISE: LazyLock<Regex> =
    money_regex!(r"^(.+?): raises ${MONEY} to ${MONEY}( and is all-in)?$");
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$", "");
static MUCKS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?): (mucks hand|doesn't show hand)$", "i");

/// Every pattern above (and the writer's) as written in `serialize.ts`, for
/// the test that holds them to the source.
#[cfg(test)]
pub(super) const SOURCE_PATTERNS: &[&str] = &[
    r"^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#([A-Za-z0-9_-]+):\s*(.*)$",
    r"(?:\$|€|£|₮)?([\d,]+(?:\.\d+)?)",
    r"^Table\s+'(.*)'\s+(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?\s*$",
    r"^Seat\s+(\d+):\s+(.+)\s+\((\S+)\s+in chips\)$",
    r"^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$",
    r"\b(?:joins the table|leaves the table|sits out|has timed out|is (?:dis)?connected|declines straddle|was run two times|said,|will be allowed to play after the button|stands up|posts?\s+dead)\b",
    r"(?=^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#)",
    r"^[IVXLCDM]+$",
    r"pot\s*limit|\bPL\b|\bPLO-?\d?\b",
    r"fixed\s*limit|\bLimit\b(?!\s*Hold)",
    r"no\s*limit",
    r"\d{4}[/-]\d{2}[/-]\d{2}[ T](\d{1,2}):\d{2}:\d{2}",
    r"(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})",
    r"((?:Hold\s*'?\s*em|Omaha|Short\s*Deck|6\+|Stud|Razz|Draw|Badugi|Mixed|HORSE|8-Game)\b.*)$",
    r"((?:Mixed\s+)?(?:Hold\s*'?\s*em|Omaha(?:\s*Hi(?:\s*\/\s*Lo)?)?|Short\s*Deck|6\+\s*Hold\s*'?\s*em|Stud(?:\s*Hi(?:\s*\/\s*Lo)?)?|Razz|Badugi|HORSE|8-Game|PLO\d?|NLO\d?)\s+(?:No\s+Limit|Pot\s+Limit|Fixed\s+Limit|Limit))$",
    r"((?:[$€£₮]\s?[\d,]+(?:\.\d+)?(?:\s*\+\s*[$€£₮]?[\d,]+(?:\.\d+)?)*)|Freeroll)",
    r"^Tournament\s*(?:\(([^]*?)\))?\s*#(\S+?),\s*(.+?)\s+-\s+(?:Level\s*([IVXLCDM]+|\d+)\s*)?\(([^)]*)\)\s+-\s+(.*)$",
    r"^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$",
    r"^Seat\s+\d+:\s*",
    r"^\((button|small blind|big blind)\)\s*",
    r"(?:showed|mucked)\s+\[([^\]]*)\]",
    r"Cashout Risk \(${MONEY}\)",
    r"^folded\s+(?:before Flop|on the (Flop|Turn|River))",
    r"\(didn't bet\)",
    r"^mucked\b",
    r"(?:won|collected)\s+\(${MONEY}\)",
    r"\bwith\s+(.+?)(?:,\s+(?:and\s+)?(?:won|lost|Cashout Risk)\b.*)?$",
    r",\s*$",
    r"^showed\b",
    r"\bcollected\b",
    r"^\*\*\*\s*SUMMARY",
    r"^Total pot ${MONEY}",
    r"(Main|Side) pot ${MONEY}\.",
    r"Rake ${MONEY}",
    r"Jackpot ${MONEY}",
    r"Bingo ${MONEY}",
    r"Fortune ${MONEY}",
    r"Tax ${MONEY}",
    r"^Hand was run (?:two|three|four) times$",
    r"^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]",
    r"^Seat\s+(\d+):",
    r"^(?:Cash Drop to Pot\s*:\s*total|STP added:)\s*${MONEY}$",
    r"^STP",
    r"\[([^\]]*)\]",
    r"\s+",
    r"^\*\*\*\s*HOLE CARDS",
    r"^Dealt to\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$",
    r"^Uncalled bet \(${MONEY}\) returned to (.+)$",
    r"^(.+?) collected ${MONEY} from (?:the )?(.+?)\s*$",
    r"^(.+?): posts the ante ${MONEY}( and is all-in)?$",
    r"^(.+?): posts (small|big|button) blind ${MONEY}( and is all-in)?$",
    r"^(.+?): posts missed blind ${MONEY}$",
    r"^(.+?): Chooses to EV Cashout$",
    r"^(.+?): Pays Cashout Risk \(${MONEY}\)$",
    r"^(.+?): (posts straddle|straddle|posts) ${MONEY}( and is all-in)?$",
    r"^(.+?): (folds|checks)$",
    r"^(.+?): (calls|bets) ${MONEY}( and is all-in)?$",
    r"^(.+?): raises ${MONEY} to ${MONEY}( and is all-in)?$",
    r"^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$",
    r"^(.+?): (mucks hand|doesn't show hand)$",
    r"^(?:FIRST|SECOND|THIRD)[ \t]*$",
    r"[\d](?:\.\d0)(?!\d)",
    r"[\d]\.\d(?!\d)",
];

/* -------------------------------------------------------------- helpers - */

/// `splitStandardHands`: `text.split(/(?=^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#)/im)`,
/// each chunk with one leading BOM dropped and trimmed, keeping the chunks
/// whose first line is a header.
///
/// The lookahead split cuts before every line start (JavaScript `m`: after
/// `\n`, `\r`, U+2028, U+2029) where a header begins - never at offset 0,
/// where `String.prototype.split` skips an empty match.
pub fn split_standard_hands(text: &str) -> Vec<String> {
    let mut cuts: Vec<usize> = line_starts(text)
        .filter(|&start| start > 0 && SPLIT_HEADER.is_match(&text[start..]))
        .collect();
    cuts.push(text.len());
    let mut out = Vec::new();
    let mut from = 0;
    for cut in cuts {
        let chunk = js::trim(strip_bom(&text[from..cut]));
        from = cut;
        if !chunk.is_empty() && HEADER.is_match(first_line(chunk)) {
            out.push(chunk.to_owned());
        }
    }
    out
}

/// `detectSymbol`: the currency glyph a text uses, `""` for none.
fn detect_symbol(text: &str) -> &'static str {
    if text.contains('€') {
        "€"
    } else if text.contains('£') {
        "£"
    } else if text.contains('$') {
        "$"
    } else if text.contains('\u{20ae}') {
        "\u{20ae}"
    } else {
        ""
    }
}

/// `detectDecimalStyle`: `fixed2` when any amount shows a trailing zero after
/// the point (`/[\d](?:\.\d0)(?!\d)/`), else `minimal` when one shows a single
/// decimal (`/[\d]\.\d(?!\d)/`), else `fixed2`.
fn detect_decimal_style(text: &str) -> DecimalStyle {
    let chars: Vec<char> = text.chars().collect();
    let digit = |i: usize| chars.get(i).is_some_and(char::is_ascii_digit);
    let at = |i: usize, c: char| chars.get(i) == Some(&c);
    let fixed2 = (0..chars.len())
        .any(|i| digit(i) && at(i + 1, '.') && digit(i + 2) && at(i + 3, '0') && !digit(i + 4));
    if fixed2 {
        return DecimalStyle::Fixed2;
    }
    let minimal =
        (0..chars.len()).any(|i| digit(i) && at(i + 1, '.') && digit(i + 2) && !digit(i + 3));
    if minimal {
        DecimalStyle::Minimal
    } else {
        DecimalStyle::Fixed2
    }
}

/// `romanToNumber`, `None` for anything but Roman numerals (upper case).
fn roman_to_number(roman: &str) -> Option<u64> {
    let upper = js::to_upper_case(roman);
    if !ROMAN.is_match(&upper) {
        return None;
    }
    let value = |c: Option<char>| -> u64 {
        match c {
            Some('I') => 1,
            Some('V') => 5,
            Some('X') => 10,
            Some('L') => 50,
            Some('C') => 100,
            Some('D') => 500,
            Some('M') => 1000,
            _ => 0,
        }
    };
    let chars: Vec<char> = upper.chars().collect();
    // Never negative: every subtracted numeral is followed by a larger one
    // worth more than all smaller numerals together.
    let mut total: i128 = 0;
    for i in 0..chars.len() {
        let v = i128::from(value(chars.get(i).copied()));
        let next = i128::from(value(chars.get(i + 1).copied()));
        total += if v < next { -v } else { v };
    }
    u64::try_from(total).ok()
}

/// `limitFromLabel`.
pub(super) fn limit_from_label(label: &str) -> LimitType {
    if LIMIT_PL.is_match(label) {
        return LimitType::Pl;
    }
    // `/fixed\s*limit|\bLimit\b(?!\s*Hold)/i`: some `Limit` word not followed
    // by `Hold`.
    let limit_not_hold = FIXED_LIMIT.is_match(label)
        || LIMIT_WORD
            .find_iter(label)
            .any(|m| !HOLD_AHEAD.is_match(&label[m.end()..]));
    if limit_not_hold && !NO_LIMIT.is_match(label) {
        return LimitType::Fl;
    }
    LimitType::Nl
}

/// What the header says (`HeaderInfo`).
#[derive(Debug, Clone)]
pub(super) struct HeaderInfo {
    pub hand_id: String,
    pub payload: String,
    pub game_label: String,
    pub unit: CurrencyUnit,
    pub small_blind: Amount,
    pub big_blind: Amount,
    pub header_ante: Amount,
    pub played_at: Option<String>,
    pub tournament: Option<PhfTournament>,
    /// Rust only: the level was a number beyond `u32`, which the TypeScript
    /// keeps as `levelNumber` and a PHF cannot.
    pub level_number_overflow: bool,
}

/// `detectPadHour`: whether the header zero-pads the hour; `true` when it
/// cannot tell.
fn detect_pad_hour(payload: &str) -> bool {
    PAD_HOUR
        .captures(payload)
        .is_none_or(|c| js::utf16_len(&c[1]) == 2)
}

/// `splitTournamentBody`: the free text between the tournament id and the
/// level clause, as `(name, buy-in token, game label)`.
fn split_tournament_body(body: &str, paren_name: Option<&str>) -> (Option<String>, String, String) {
    let tail = GAME_LABEL_EXACT
        .captures(body)
        .or_else(|| GAME_LABEL_TAIL.captures(body))
        .and_then(|c| c.get(1));
    let game_label = js::trim(tail.map_or(body, |m| m.as_str())).to_owned();
    // The label group always runs to the end of `body` (`$`), so what is in
    // front of it is `body.slice(0, body.length - tail[1].length)`.
    let name_part = js::trim(tail.map_or("", |m| &body[..m.start()]));
    let buy_in_token = BUY_IN_TOKEN
        .captures(name_part)
        .and_then(|c| c.get(1))
        .map_or("", |m| m.as_str())
        .to_owned();
    let inline_name =
        (!name_part.is_empty() && name_part != buy_in_token).then(|| name_part.to_owned());
    let name = paren_name.map(str::to_owned).or(inline_name);
    (name, buy_in_token, game_label)
}

/// `stakes[i]` of a `split("/")`, `""` for `undefined`.
fn part<'a>(parts: &[&'a str], i: usize) -> &'a str {
    parts.get(i).copied().unwrap_or("")
}

/// `parseHeader(handId, payload, sourceText = payload)`.
pub(super) fn parse_header(hand_id: &str, payload: &str, source_text: &str) -> HeaderInfo {
    let played_at = parse_played_at(payload);

    if let Some(c) = TOURNAMENT_HEADER.captures(payload) {
        let paren_name = c.get(1).map(|m| m.as_str());
        let tid = &c[2];
        let body = &c[3];
        let level_label = c.get(4).map(|m| m.as_str().to_owned());
        let level_stakes = &c[5];
        let (name, buy_in_token, game_label) = split_tournament_body(body, paren_name);
        let buy_in_symbol = match detect_symbol(&buy_in_token) {
            "" => "$",
            symbol => symbol,
        };
        let buy_in_unit = unit_for_symbol(buy_in_symbol).unit();
        let buy_in = parse_buy_in_token(&buy_in_token, &buy_in_unit);
        let unit = match detect_symbol(level_stakes) {
            "" => chips_unit_for(source_text).unit(),
            symbol => unit_for_symbol(symbol).unit(),
        };
        let stakes: Vec<&str> = level_stakes.split('/').collect();
        // `romanToNumber(label) ?? (Number(label) || null)`.
        let (level_number, level_number_overflow) = match &level_label {
            None => (None, false),
            Some(label) => match roman_to_number(label) {
                Some(n) => match u32::try_from(n) {
                    Ok(n) => (Some(n), false),
                    Err(_) => (None, true),
                },
                // `\d+`: never `NaN`, so `None` is beyond `u32`.
                None => match number_u32(label) {
                    Some(0) => (None, false),
                    Some(n) => (Some(n), false),
                    None => (None, true),
                },
            },
        };
        let small_blind = parse_amount(part(&stakes, 0), &unit);
        let big_blind = parse_amount(stakes.get(1).copied().unwrap_or(stakes[0]), &unit);
        let ante = parse_amount(part(&stakes, 2), &unit);
        return HeaderInfo {
            hand_id: hand_id.to_owned(),
            payload: payload.to_owned(),
            game_label,
            unit,
            small_blind,
            big_blind,
            header_ante: ante,
            played_at,
            tournament: Some(PhfTournament {
                id: tid.to_owned(),
                name,
                buy_in: buy_in.buy_in,
                bounty: Some(buy_in.bounty),
                fee: buy_in.fee,
                buy_in_unit,
                level_label,
                level_number,
                level_small_blind: small_blind,
                level_big_blind: big_blind,
                level_ante: ante,
                bounties: Vec::new(),
                prize_pool: None,
            }),
            level_number_overflow,
        };
    }

    if let Some(c) = CASH_HEADER.captures(payload) {
        let stakes_text = &c[2];
        let unit = unit_for_symbol(detect_symbol(stakes_text)).unit();
        let stakes: Vec<&str> = stakes_text.split('/').collect();
        return HeaderInfo {
            hand_id: hand_id.to_owned(),
            payload: payload.to_owned(),
            game_label: js::trim(&c[1]).to_owned(),
            small_blind: if stakes.len() > 1 {
                parse_amount(stakes[0], &unit)
            } else {
                0
            },
            big_blind: parse_amount(stakes.get(1).copied().unwrap_or(stakes[0]), &unit),
            header_ante: parse_amount(part(&stakes, 2), &unit),
            unit,
            played_at,
            tournament: None,
            level_number_overflow: false,
        };
    }

    HeaderInfo {
        hand_id: hand_id.to_owned(),
        payload: payload.to_owned(),
        game_label: js::trim(payload.split(" - ").next().unwrap_or(payload)).to_owned(),
        unit: USD.unit(),
        small_blind: 0,
        big_blind: 0,
        header_ante: 0,
        played_at,
        tournament: None,
        level_number_overflow: false,
    }
}

/// What `parseSummarySeatLine` reads off one summary `Seat N:` line.
#[derive(Debug, Clone)]
struct SummarySeat {
    position_labels: Vec<String>,
    outcome: SeatOutcome,
    folded_street: Option<Street>,
    didnt_bet: bool,
    shown_cards: Vec<String>,
    hand_description: Option<String>,
    mucked: bool,
    cashout_risk: Option<Amount>,
}

/// `parseSummarySeatLine(raw, playerName, unit)`.
fn parse_summary_seat_line(raw: &str, player_name: &str, unit: &CurrencyUnit) -> SummarySeat {
    let mut rest: &str = SUMMARY_SEAT_PREFIX
        .find(raw)
        .map_or(raw, |m| &raw[m.end()..]);
    if let Some(after) = rest.strip_prefix(player_name) {
        rest = after;
    }
    rest = js::trim_start(rest);

    let mut position_labels = Vec::new();
    while let Some(c) = POSITION_LABEL.captures(rest) {
        position_labels.push(format!("({})", &c[1]));
        rest = &rest[c.get(0).map_or(0, |m| m.end())..];
    }

    let mut out = SummarySeat {
        position_labels,
        outcome: SeatOutcome::Unknown,
        folded_street: None,
        didnt_bet: false,
        shown_cards: Vec::new(),
        hand_description: None,
        mucked: false,
        cashout_risk: None,
    };

    if let Some(c) = SHOWN.captures(rest) {
        out.shown_cards = extract_cards(&c[1]);
    }
    if let Some(c) = CASHOUT_RISK.captures(rest) {
        out.cashout_risk = Some(parse_amount(&c[1], unit));
    }
    if let Some(c) = FOLDED.captures(rest) {
        out.outcome = SeatOutcome::Folded;
        out.folded_street = Some(match c.get(1).map(|m| js::to_lower_case(m.as_str())) {
            Some(street) if street == "flop" => Street::Flop,
            Some(street) if street == "turn" => Street::Turn,
            Some(_) => Street::River,
            None => Street::Preflop,
        });
        out.didnt_bet = DIDNT_BET.is_match(rest);
        return out;
    }
    if MUCKED.is_match(rest) {
        out.outcome = SeatOutcome::Mucked;
        out.mucked = true;
        return out;
    }
    let won = WON.is_match(rest);
    if let Some(c) = DESCRIPTION.captures(rest) {
        out.hand_description = Some(TRAILING_COMMA.replace(&c[1], "").into_owned());
    }
    if SHOWED.is_match(rest) {
        out.outcome = if won {
            SeatOutcome::Won
        } else {
            SeatOutcome::Lost
        };
        return out;
    }
    if won {
        out.outcome = if COLLECTED_WORD.is_match(rest) {
            SeatOutcome::Collected
        } else {
            SeatOutcome::Won
        };
    }
    out
}

/// `RUN_PREFIXES.indexOf(label.toUpperCase())`, 0 for none or unknown.
fn runout_index_for_label(label: &str) -> u32 {
    if label.is_empty() {
        return 0;
    }
    let upper = js::to_upper_case(label);
    (0_u32..)
        .zip(RUN_PREFIXES)
        .find(|(_, prefix)| *prefix == upper)
        .map_or(0, |(i, _)| i)
}

/// `Boolean(match[i])`: the group took part and is not empty.
fn flag(c: &regex::Captures<'_>, i: usize) -> bool {
    c.get(i).is_some_and(|m| !m.as_str().is_empty())
}

#[derive(Debug, Clone, Default)]
struct RunoutDraft {
    flop: Option<Vec<String>>,
    turn: Option<String>,
    river: Option<String>,
}

/// The money in a hand's own currency, as labels print it
/// (`formatAmount(amount, unit)`: minimal, ungrouped).
fn label_money(amount: Amount, unit: &CurrencyUnit) -> String {
    format_amount(amount, unit, DecimalStyle::Minimal, false)
}

/// Everything `push` needs besides the fields every action has.
struct Draft<'a> {
    street: Street,
    player: &'a str,
    kind: ActionType,
    amount: Amount,
    street_total: Amount,
    all_in: bool,
    label: String,
    line: u32,
    raw_line: &'a str,
}

/// The reader's state for one hand.
struct Reader {
    players: Vec<PhfPlayer>,
    /// `playerByName`: name → index into `players`.
    player_by_name: Vec<(String, usize)>,
    actions: Vec<PhfAction>,
    runout_index: u32,
    /// `streetCommit`.
    street_commit: Vec<(String, Amount)>,
}

impl Reader {
    fn player_index(&self, name: &str) -> Option<usize> {
        self.player_by_name
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, i)| *i)
    }

    /// `seatOf(name)`.
    fn seat_of(&self, name: &str) -> Option<u32> {
        self.player_index(name).map(|i| self.players[i].seat)
    }

    fn committed(&self, player: &str) -> Amount {
        self.street_commit
            .iter()
            .find(|(n, _)| n == player)
            .map_or(0, |(_, v)| *v)
    }

    /// `commit(player, delta)`.
    fn commit(&mut self, player: &str, delta: Amount) -> Amount {
        let next = self.committed(player).saturating_add(delta);
        map_set(&mut self.street_commit, player.to_owned(), next);
        next
    }

    /// `push(action)`: the action with the current runout and the next index.
    fn push(&mut self, draft: Draft<'_>, extra: impl FnOnce(&mut PhfAction)) {
        let mut action = PhfAction {
            index: u32::try_from(self.actions.len()).unwrap_or(u32::MAX),
            street: draft.street,
            runout_index: self.runout_index,
            seat: self.seat_of(draft.player),
            player: draft.player.to_owned(),
            kind: draft.kind,
            amount: draft.amount,
            street_total: draft.street_total,
            all_in: draft.all_in,
            cards: None,
            description: None,
            verb: None,
            pot_name: None,
            half: None,
            label: draft.label,
            source_line: Some(draft.line),
            raw_line: draft.raw_line.to_owned(),
        };
        extra(&mut action);
        self.actions.push(action);
    }
}

/// `parseStandardHand(text, ctx)`: one standard-text chunk as PHF; `Ok(None)`
/// when the text is not a hand at all (no header, or no seat). Anything odd
/// about a hand is a `meta.warnings` entry, for the validator to judge.
///
/// `Err` where the TypeScript throws - a hi/lo card the evaluator cannot read
/// (`not a card: …`) - and where it would build a hand a PHF cannot hold
/// (see the module docs).
#[allow(clippy::too_many_lines)]
pub fn parse_standard_hand(
    text: &str,
    ctx: &StandardContext<'_>,
) -> Result<Option<PhfHand>, JsError> {
    let raw_text = js::trim(strip_bom(text)).to_owned();
    let lines = split_lines(&raw_text);
    let Some(header_match) = HEADER.captures(lines[0]) else {
        return Ok(None);
    };

    let mut warnings: Vec<PhfWarning> = Vec::new();
    let header = parse_header(&header_match[1], &header_match[2], &raw_text);
    let unit = header.unit.clone();
    let mut reader = Reader {
        players: Vec::new(),
        player_by_name: Vec::new(),
        actions: Vec::new(),
        runout_index: 0,
        street_commit: Vec::new(),
    };
    let mut runouts: Vec<RunoutDraft> = vec![RunoutDraft::default()];
    let mut summary_boards: Vec<(u32, Vec<String>)> = Vec::new();
    let mut chip_movements: Vec<PhfChipMovement> = Vec::new();
    let mut marker_labels: Vec<PhfMarkerLabels> = vec![PhfMarkerLabels::default()];
    let mut showdown_labels: Vec<String> = Vec::new();
    let mut pots: Vec<PhfPot> = Vec::new();
    let mut summary_seat_lines: Vec<(u32, String)> = Vec::new();
    let mut collected_by: Vec<(String, Amount)> = Vec::new();

    let mut table_name: Option<String> = None;
    let mut max_seats: u32 = 0;
    let mut button_seat: Option<u32> = None;
    let mut hero_name: Option<String> = None;
    let mut total_pot: Amount = 0;
    let mut fees = PhfFees::ZERO;
    let mut ante_max: Amount = 0;
    let mut ante_posters: u32 = 0;
    let mut in_summary = false;
    let mut street = Street::Preflop;
    let mut saw_showdown_marker = false;
    let mut saw_hole_cards_marker = false;
    let mut dealt_line_count: u32 = 0;
    let mut run_two_times_line = false;
    let mut pending_board_label = String::new();
    let mut no_low_stated = false;
    let mut straddles: Vec<(String, Amount)> = Vec::new();
    let mut folded_players: HashSet<String> = HashSet::new();

    let unrepresentable = |what: &str| {
        JsError::new(format!(
            "{what} is beyond what a PHF hand can hold (u32); the TypeScript keeps it as a \
             JavaScript number"
        ))
    };

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let raw_line: &str = raw_line;
        let trimmed = js::trim(raw_line);
        let line_no = u32::try_from(i + 1).unwrap_or(u32::MAX);
        if trimmed.is_empty() {
            continue;
        }

        if SUMMARY_MARKER.is_match(trimmed) {
            in_summary = true;
            continue;
        }

        if in_summary {
            if let Some(c) = TOTAL_POT.captures(trimmed) {
                total_pot = parse_amount(&c[1], &unit);
                let before_bar = trimmed.split('|').next().unwrap_or_default();
                for entry in SIDE_POTS.captures_iter(before_bar) {
                    pots.push(PhfPot {
                        name: entry[1].to_owned(),
                        amount: parse_amount(&entry[2], &unit),
                    });
                }
                let fee = |re: &Regex| {
                    parse_amount(
                        re.captures(trimmed)
                            .and_then(|c| c.get(1))
                            .map_or("", |m| m.as_str()),
                        &unit,
                    )
                };
                fees = PhfFees {
                    rake: fee(&RAKE),
                    jackpot: fee(&JACKPOT),
                    bingo: fee(&BINGO),
                    fortune: fee(&FORTUNE),
                    tax: fee(&TAX),
                    other: 0,
                };
                continue;
            }

            if RUN_TIMES.is_match(trimmed) {
                run_two_times_line = true;
                continue;
            }

            // `BOARD_LABEL_LINE.test(trimmed)` (`m` flag, but `trimmed` is
            // one line unless it holds a lone `\r` or U+2028/9).
            if super::has_board_label_line(trimmed) {
                trimmed.clone_into(&mut pending_board_label);
                continue;
            }
            if let Some(c) = BOARD.captures(trimmed) {
                let label = c
                    .get(1)
                    .map_or(pending_board_label.as_str(), |m| m.as_str());
                let index = runout_index_for_label(js::trim(label));
                pending_board_label.clear();
                map_set(&mut summary_boards, index, extract_cards(&c[2]));
                continue;
            }

            if let Some(c) = SUMMARY_SEAT.captures(trimmed) {
                // Stored untrimmed: some sites leave a trailing space on these
                // lines and the output has to match the input byte for byte.
                // A seat beyond `u32` can match no player; it is dropped.
                if let Some(seat) = number_u32(&c[1]) {
                    map_set(&mut summary_seat_lines, seat, raw_line.to_owned());
                }
                continue;
            }

            warnings.push(PhfWarning {
                code: "unknown-summary-line".to_owned(),
                message: trimmed.to_owned(),
                line: Some(line_no),
            });
            continue;
        }

        if let Some(c) = TABLE.captures(trimmed) {
            table_name = Some(c[1].to_owned()).filter(|name| !name.is_empty());
            max_seats = number_u32(&c[2]).ok_or_else(|| unrepresentable("a table size"))?;
            button_seat = match c.get(3) {
                Some(m) if !m.as_str().is_empty() => {
                    Some(number_u32(m.as_str()).ok_or_else(|| unrepresentable("a button seat"))?)
                }
                _ => None,
            };
            continue;
        }

        if let Some(c) = SEAT.captures(trimmed) {
            let name = c[2].to_owned();
            let seat = number_u32(&c[1]).ok_or_else(|| unrepresentable("a seat number"))?;
            let player = PhfPlayer {
                seat,
                name: name.clone(),
                starting_stack: parse_amount(&c[3], &unit),
                is_hero: name == "Hero",
                hole_cards: Vec::new(),
                bounty: None,
                sitting_out: false,
                position: None,
                dealt_announced: false,
                dealt_cards: Vec::new(),
            };
            let is_hero = player.is_hero;
            reader.players.push(player);
            let index = reader.players.len() - 1;
            map_set(&mut reader.player_by_name, name.clone(), index);
            if is_hero {
                hero_name = Some(name);
            }
            continue;
        }

        // House money into the pot: a chip movement, not an action.
        if let Some(c) = DROP.captures(trimmed) {
            chip_movements.push(PhfChipMovement {
                kind: if STP.is_match(trimmed) {
                    "splash-the-pot"
                } else {
                    "cash-drop"
                }
                .to_owned(),
                from_seat: None,
                from_player: None,
                to_pot: true,
                amount: parse_amount(&c[1], &unit),
                raw: Some(trimmed.to_owned()),
                anchor: if saw_hole_cards_marker {
                    ChipMovementAnchor::AfterHoleCards
                } else {
                    ChipMovementAnchor::BeforePostings
                },
            });
            continue;
        }

        if let Some(c) = MARKER.captures(trimmed) {
            let printed = c.get(1).map_or("", |m| m.as_str());
            let index = runout_index_for_label(printed);
            let kind = js::to_upper_case(&WHITESPACE_RUN.replace_all(&c[2], ""));
            let groups: Vec<Vec<String>> = GROUP
                .captures_iter(&c[3])
                .map(|g| extract_cards(&g[1]))
                .collect();
            let slot = usize::try_from(index).unwrap_or(0);
            while runouts.len() <= slot {
                runouts.push(RunoutDraft::default());
                marker_labels.push(PhfMarkerLabels::default());
            }
            reader.runout_index = index;
            let printed_label = js::to_upper_case(printed);

            if kind == "SHOWDOWN" {
                saw_showdown_marker = true;
                showdown_labels.push(printed_label);
                street = Street::Showdown;
                continue;
            }

            let last: Vec<String> = groups.last().cloned().unwrap_or_default();
            if kind == "FLOP" {
                runouts[slot].flop = Some(last.iter().take(3).cloned().collect());
                marker_labels[slot].flop = Some(printed_label);
                street = Street::Flop;
            } else if kind == "TURN" {
                runouts[slot].turn = last.first().cloned();
                marker_labels[slot].turn = Some(printed_label);
                street = Street::Turn;
            } else {
                runouts[slot].river = last.first().cloned();
                marker_labels[slot].river = Some(printed_label);
                street = Street::River;
            }
            reader.street_commit.clear();
            continue;
        }

        if HOLE_CARDS.is_match(trimmed) {
            saw_hole_cards_marker = true;
            continue;
        }

        if let Some(c) = DEALT.captures(raw_line) {
            let cards = c
                .get(2)
                .map_or_else(Vec::new, |m| extract_cards(m.as_str()));
            dealt_line_count += 1;
            if let Some(index) = reader.player_index(js::trim(&c[1])) {
                let player = &mut reader.players[index];
                player.dealt_announced = true;
                player.dealt_cards.clone_from(&cards);
                if !cards.is_empty() {
                    player.hole_cards = cards;
                    // Some sites label the observer seat with the real name.
                    if hero_name.is_none() {
                        hero_name = Some(player.name.clone());
                        player.is_hero = true;
                    }
                }
            }
            continue;
        }

        if let Some(c) = UNCALLED.captures(trimmed) {
            let amount = parse_amount(&c[1], &unit);
            let player = js::trim(&c[2]);
            let street_total = reader.commit(player, -amount);
            reader.push(
                Draft {
                    street,
                    player,
                    kind: ActionType::Uncalled,
                    amount: -amount,
                    street_total,
                    all_in: false,
                    label: format!("uncalled {} returned", label_money(amount, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = COLLECTED.captures(trimmed) {
            let player = js::trim(&c[1]);
            let amount = parse_amount(&c[2], &unit);
            let before = collected_by
                .iter()
                .find(|(n, _)| n == player)
                .map_or(0, |(_, v)| *v);
            map_set(
                &mut collected_by,
                player.to_owned(),
                before.saturating_add(amount),
            );
            let pot_name = c[3].to_owned();
            reader.push(
                Draft {
                    street: Street::Showdown,
                    player,
                    kind: ActionType::Collect,
                    amount,
                    street_total: 0,
                    all_in: false,
                    label: format!("wins {}", label_money(amount, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |a| a.pot_name = Some(pot_name),
            );
            continue;
        }

        if let Some(c) = ANTE.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let amount = parse_amount(&c[2], &unit);
            ante_max = ante_max.max(amount);
            ante_posters += 1;
            reader.push(
                Draft {
                    street: Street::Preflop,
                    player,
                    kind: ActionType::Ante,
                    amount,
                    street_total: 0,
                    all_in: flag(&c, 3),
                    label: format!("ante {}", label_money(amount, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = BLIND.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let amount = parse_amount(&c[3], &unit);
            let kind = js::to_lower_case(&c[2]);
            let street_total = reader.commit(player, amount);
            let button = kind == "button";
            reader.push(
                Draft {
                    street: Street::Preflop,
                    player,
                    kind: if kind == "small" {
                        ActionType::SmallBlind
                    } else {
                        ActionType::BigBlind
                    },
                    amount,
                    street_total,
                    all_in: flag(&c, 4),
                    label: format!("{kind} blind {}", label_money(amount, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |a| {
                    if button {
                        a.verb = Some(BUTTON_BLIND_VERB.to_owned());
                    }
                },
            );
            continue;
        }

        if let Some(c) = MISSED_BLIND.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let amount = parse_amount(&c[2], &unit);
            reader.push(
                Draft {
                    street: Street::Preflop,
                    player,
                    kind: ActionType::MissedBlind,
                    amount,
                    street_total: 0,
                    all_in: false,
                    label: format!("missed blind {}", label_money(amount, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = CASHOUT_CHOOSE.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            reader.push(
                Draft {
                    street,
                    player,
                    kind: ActionType::CashoutChoose,
                    amount: 0,
                    street_total: 0,
                    all_in: false,
                    label: "chooses EV cashout".to_owned(),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = CASHOUT_PAY.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let printed = label_money(parse_amount(&c[2], &unit), &unit);
            reader.push(
                Draft {
                    street,
                    player,
                    kind: ActionType::CashoutPay,
                    amount: 0,
                    street_total: 0,
                    all_in: false,
                    label: format!("pays cashout risk {printed}"),
                    line: line_no,
                    raw_line: trimmed,
                },
                |a| a.description = Some(printed),
            );
            continue;
        }

        // `posts straddle` / GG's bare `straddle` / a plain `posts` (dead).
        if let Some(c) = POST.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let verb = &c[2];
            let explicit_straddle = verb != "posts";
            let printed = parse_amount(&c[3], &unit);
            // GG's bare `straddle` states the street total, like a raise's
            // `to`; `posts straddle` is chips added.
            let already = reader.committed(player);
            let amount = if verb == "straddle" {
                printed.saturating_sub(already)
            } else {
                printed
            };
            let is_straddle =
                explicit_straddle || (street == Street::Preflop && amount > header.big_blind);
            if is_straddle {
                straddles.push((player.to_owned(), already.saturating_add(amount)));
            }
            let street_total = reader.commit(player, amount);
            let verb = explicit_straddle.then(|| verb.to_owned());
            reader.push(
                Draft {
                    street,
                    player,
                    kind: if is_straddle {
                        ActionType::Straddle
                    } else {
                        ActionType::Post
                    },
                    amount,
                    street_total,
                    all_in: flag(&c, 4),
                    label: format!("posts {}", label_money(printed, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |a| a.verb = verb,
            );
            continue;
        }

        if let Some(c) = SIMPLE.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let fold = &c[2] == "folds";
            if fold {
                folded_players.insert(player.to_owned());
            }
            let street_total = reader.committed(player);
            reader.push(
                Draft {
                    street,
                    player,
                    kind: if fold {
                        ActionType::Fold
                    } else {
                        ActionType::Check
                    },
                    amount: 0,
                    street_total,
                    all_in: false,
                    label: if fold { "folds" } else { "checks" }.to_owned(),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = CALL_BET.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let amount = parse_amount(&c[3], &unit);
            let call = &c[2] == "calls";
            let street_total = reader.commit(player, amount);
            reader.push(
                Draft {
                    street,
                    player,
                    kind: if call {
                        ActionType::Call
                    } else {
                        ActionType::Bet
                    },
                    amount,
                    street_total,
                    all_in: flag(&c, 4),
                    label: format!(
                        "{} {}",
                        if call { "calls" } else { "bets" },
                        label_money(amount, &unit)
                    ),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = RAISE.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let to = parse_amount(&c[3], &unit);
            let already = reader.committed(player);
            let added = to.saturating_sub(already);
            map_set(&mut reader.street_commit, player.to_owned(), to);
            reader.push(
                Draft {
                    street,
                    player,
                    kind: ActionType::Raise,
                    amount: added,
                    street_total: to,
                    all_in: flag(&c, 4),
                    label: format!("raises to {}", label_money(to, &unit)),
                    line: line_no,
                    raw_line: trimmed,
                },
                |_| {},
            );
            continue;
        }

        if let Some(c) = SHOWS.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let cards = extract_cards(&c[2]);
            if !cards.is_empty()
                && let Some(index) = reader.player_index(player)
            {
                reader.players[index].hole_cards.clone_from(&cards);
            }
            let description = c.get(3).map(|m| m.as_str().to_owned());
            let label = if cards.is_empty() {
                "shows".to_owned()
            } else {
                format!("shows {}", cards.join(" "))
            };
            reader.push(
                Draft {
                    street,
                    player,
                    kind: ActionType::Show,
                    amount: 0,
                    street_total: 0,
                    all_in: false,
                    label,
                    line: line_no,
                    raw_line: trimmed,
                },
                |a| {
                    a.cards = Some(cards);
                    a.description = description;
                },
            );
            continue;
        }

        if let Some(c) = MUCKS.captures(trimmed) {
            let player = c.get(1).map_or("", |m| m.as_str());
            let description = c[2].to_owned();
            reader.push(
                Draft {
                    street,
                    player,
                    kind: ActionType::Muck,
                    amount: 0,
                    street_total: 0,
                    all_in: false,
                    label: "mucks".to_owned(),
                    line: line_no,
                    raw_line: trimmed,
                },
                |a| a.description = Some(description),
            );
            continue;
        }

        if CHATTER.is_match(trimmed) {
            continue;
        }

        // PokerStars' hi/lo "the whole pot went high": a fact to check.
        if NO_LOW_LINE.is_match(trimmed) {
            no_low_stated = true;
            continue;
        }

        warnings.push(PhfWarning {
            code: "unknown-line".to_owned(),
            message: trimmed.to_owned(),
            line: Some(line_no),
        });
    }

    let Reader {
        mut players,
        player_by_name,
        actions,
        ..
    } = reader;

    if players.is_empty() {
        return Ok(None);
    }

    if max_seats == 0 {
        let count = u32::try_from(players.len()).unwrap_or(u32::MAX);
        max_seats = players.iter().map(|p| p.seat).fold(count, u32::max);
    }

    // Seeded geometrically; `assignPositions` re-resolves once the hand is
    // assembled.
    let seats: Vec<u32> = players.iter().map(|p| p.seat).collect();
    let positions = resolve_positions(&seats, button_seat);
    for player in &mut players {
        player.position = positions
            .iter()
            .find(|(seat, _)| *seat == player.seat)
            .map(|(_, position)| *position);
    }

    // The summary can reveal cards no `shows` line did.
    for (seat, line) in &summary_seat_lines {
        let Some(player) = players.iter_mut().find(|p| p.seat == *seat) else {
            continue;
        };
        if let Some(c) = SHOWN.captures(line)
            && player.hole_cards.is_empty()
        {
            player.hole_cards = extract_cards(&c[1]);
        }
    }

    // The board the markers built is authoritative; the summary cross-checks.
    let summary_board = |index: u32| {
        summary_boards
            .iter()
            .find(|(i, _)| *i == index)
            .map(|(_, cards)| cards.clone())
    };
    let mut board = PhfBoard {
        runouts: (0_u32..)
            .zip(runouts)
            .zip(marker_labels)
            .map(|((index, run), labels)| PhfRunout {
                index,
                flop: run.flop,
                turn: run.turn,
                river: run.river,
                marker_labels: labels,
                summary_cards: summary_board(index),
            })
            .collect(),
    };
    if board.runouts.len() == 1 && board.runouts[0].flop.is_none() {
        let from_summary = summary_board(0).unwrap_or_default();
        if !from_summary.is_empty() {
            board.runouts[0] = PhfRunout {
                index: 0,
                flop: Some(from_summary.iter().take(3).cloned().collect()),
                turn: from_summary.get(3).cloned(),
                river: from_summary.get(4).cloned(),
                marker_labels: PhfMarkerLabels::default(),
                summary_cards: Some(from_summary),
            };
            warnings.push(PhfWarning {
                code: "board-from-summary".to_owned(),
                message: "Board taken from the SUMMARY line.".to_owned(),
                line: None,
            });
        }
    }

    let mut contributions: Vec<(String, Amount)> = Vec::new();
    for action in &actions {
        if action.kind == ActionType::Collect || action.amount == 0 {
            continue;
        }
        let before = contributions
            .iter()
            .find(|(n, _)| *n == action.player)
            .map_or(0, |(_, v)| *v);
        map_set(
            &mut contributions,
            action.player.clone(),
            before.saturating_add(action.amount),
        );
    }

    if total_pot == 0 {
        let players_in = contributions
            .iter()
            .fold(0, |sum: Amount, (_, v)| sum.saturating_add(*v));
        let house_in = chip_movements
            .iter()
            .filter(|m| m.to_pot)
            .fold(0, |sum: Amount, m| sum.saturating_add(m.amount));
        total_pot = players_in.saturating_add(house_in);
    }

    let results = build_results(&Results {
        players: &players,
        actions: &actions,
        contributions: &contributions,
        collected_by: &collected_by,
        summary_seat_lines: &summary_seat_lines,
        unit: &unit,
        total_pot,
        pots,
        fees,
        hero_name: hero_name.as_deref(),
        board: &board,
        saw_showdown_marker,
        folded_players: &folded_players,
    });

    // A tournament header's level goes stale; what was posted wins.
    let mut small_blind = header.small_blind;
    let mut big_blind = header.big_blind;
    if header.tournament.is_some() {
        for action in &actions {
            if action.kind == ActionType::SmallBlind {
                small_blind = small_blind.max(action.amount);
            } else if action.kind == ActionType::BigBlind {
                big_blind = big_blind.max(action.amount);
            }
        }
    }
    if header.level_number_overflow {
        return Err(unrepresentable("a level number"));
    }

    let ante_model = match ante_posters {
        0 => AnteModel::None,
        1 if players.len() > 1 => AnteModel::BigBlindAnte,
        _ => AnteModel::PostedPerPlayer,
    };
    let has_blinds = actions
        .iter()
        .any(|a| matches!(a.kind, ActionType::SmallBlind | ActionType::BigBlind));
    let bomb_pot = (ante_posters >= 2 && !has_blinds).then_some(PhfBombPot {
        ante: ante_max,
        dealt_to_street: Street::Flop,
        double_board: board.runouts.len() > 1,
    });

    let text_style = PhfTextStyle {
        decimals: detect_decimal_style(&raw_text),
        dealt_lines_for_all_players: dealt_line_count > 1,
        showdown_section: saw_showdown_marker,
        hole_cards_section: saw_hole_cards_marker,
        showdown_labels: if showdown_labels.is_empty() {
            vec![String::new()]
        } else {
            showdown_labels
        },
        run_it_twice_note: run_two_times_line,
        pad_hour: detect_pad_hour(&header.payload),
        ..PhfTextStyle::default()
    };

    let mut game_straddles = Vec::with_capacity(straddles.len());
    for (order, (player, amount)) in (1_u32..).zip(straddles) {
        let seat = player_by_name
            .iter()
            .find(|(n, _)| *n == player)
            .map(|(_, i)| players[*i].seat)
            // TypeScript: `seat: -1`.
            .ok_or_else(|| unrepresentable("a straddle by a player with no seat (seat -1)"))?;
        game_straddles.push(PhfStraddle {
            seat,
            player,
            amount,
            order,
        });
    }

    let mut hand = PhfHand {
        schema: PhfSchema::V1,
        meta: PhfMeta {
            site_id: ctx.site_id.to_owned(),
            site_name: ctx.site_name.to_owned(),
            hand_id: header.hand_id.clone(),
            hand_key: header.hand_id.clone(),
            original_filename: ctx.original_filename.map(str::to_owned),
            parser_id: ctx.parser_id.unwrap_or("standard").to_owned(),
            parser_version: ctx
                .parser_version
                .unwrap_or(STANDARD_TEXT_PARSER_VERSION)
                .to_owned(),
            warnings,
            raw_text,
            parsed_at: ctx.parsed_at.to_owned(),
            text_style,
        },
        game: PhfGame {
            variant: variant_from_label(&header.game_label),
            limit: limit_from_label(&header.game_label),
            hi_lo: is_hi_lo_label(&header.game_label),
            format: if header.tournament.is_some() {
                GameFormat::Tournament
            } else {
                GameFormat::Cash
            },
            unit: unit.clone(),
            small_blind,
            big_blind,
            ante_model,
            ante: if ante_max == 0 {
                header.header_ante
            } else {
                ante_max
            },
            straddles: game_straddles,
            bomb_pot,
            label: header.game_label.clone(),
        },
        table: PhfTable {
            name: table_name,
            max_seats,
            button_seat,
            fast_fold: None,
        },
        tournament: header.tournament,
        players,
        actions,
        chip_movements: (!chip_movements.is_empty()).then_some(chip_movements),
        board,
        results,
        played_at: header.played_at,
    };

    crate::positions::assign_positions(&mut hand);
    if hand.game.hi_lo {
        let halves = assign_hi_lo_halves(&mut hand)?;
        hand.meta.warnings.extend(halves);
        // PokerStars says it in words; the hands have to agree.
        if no_low_stated {
            let stated = check_no_low_stated(&hand);
            hand.meta.warnings.extend(stated);
        }
    }
    Ok(Some(hand))
}

/// `buildResults`' input.
struct Results<'a> {
    players: &'a [PhfPlayer],
    actions: &'a [PhfAction],
    contributions: &'a [(String, Amount)],
    collected_by: &'a [(String, Amount)],
    summary_seat_lines: &'a [(u32, String)],
    unit: &'a CurrencyUnit,
    total_pot: Amount,
    pots: Vec<PhfPot>,
    fees: PhfFees,
    hero_name: Option<&'a str>,
    board: &'a PhfBoard,
    saw_showdown_marker: bool,
    folded_players: &'a HashSet<String>,
}

fn lookup(map: &[(String, Amount)], key: &str) -> Option<Amount> {
    map.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
}

/// `buildResults`.
fn build_results(input: &Results<'_>) -> PhfResults {
    let shown_at_showdown: HashSet<&str> = input
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::Show)
        .map(|a| a.player.as_str())
        .collect();
    // Cards a `shows` line exposed that the summary does not repeat.
    let mut revealed_in_stream: Vec<(String, Vec<String>)> = Vec::new();
    for action in input.actions {
        if let Some(cards) = action.cards.as_ref().filter(|c| !c.is_empty()) {
            map_set(
                &mut revealed_in_stream,
                action.player.clone(),
                cards.clone(),
            );
        }
    }

    let player_results: Vec<PhfPlayerResult> = input
        .players
        .iter()
        .map(|player| {
            let summary_line = input
                .summary_seat_lines
                .iter()
                .find(|(seat, _)| *seat == player.seat)
                .map(|(_, line)| line.clone());
            let parsed = summary_line
                .as_deref()
                .map(|line| parse_summary_seat_line(line, &player.name, input.unit));
            let won = lookup(input.collected_by, &player.name).unwrap_or(0);
            let contributed = lookup(input.contributions, &player.name).unwrap_or(0);
            let revealed = || {
                revealed_in_stream
                    .iter()
                    .find(|(n, _)| *n == player.name)
                    .map(|(_, cards)| cards.clone())
                    .unwrap_or_default()
            };
            let went = shown_at_showdown.contains(player.name.as_str())
                || parsed
                    .as_ref()
                    .is_some_and(|p| p.outcome == SeatOutcome::Showed);
            match parsed {
                Some(p) => PhfPlayerResult {
                    seat: player.seat,
                    player: player.name.clone(),
                    won,
                    contributed,
                    net: won.saturating_sub(contributed),
                    went_to_showdown: went,
                    shown_cards: if p.shown_cards.is_empty() {
                        revealed()
                    } else {
                        p.shown_cards
                    },
                    mucked: p.mucked,
                    hand_description: p.hand_description,
                    position_labels: p.position_labels,
                    outcome: p.outcome,
                    folded_street: p.folded_street,
                    didnt_bet: p.didnt_bet,
                    cashout_risk: p.cashout_risk,
                    raw: summary_line,
                },
                None => PhfPlayerResult {
                    seat: player.seat,
                    player: player.name.clone(),
                    won,
                    contributed,
                    net: won.saturating_sub(contributed),
                    went_to_showdown: went,
                    shown_cards: revealed(),
                    mucked: false,
                    hand_description: None,
                    position_labels: Vec::new(),
                    outcome: if won > 0 {
                        SeatOutcome::Collected
                    } else {
                        SeatOutcome::Unknown
                    },
                    folded_street: None,
                    didnt_bet: false,
                    cashout_risk: None,
                    raw: None,
                },
            }
        })
        .collect();

    let winners = input
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::Collect)
        .map(|a| PhfWinner {
            player: a.player.clone(),
            seat: a.seat,
            amount: a.amount,
            runout_index: a.runout_index,
            half: None,
        })
        .collect();

    let primary = resolve_runout(input.board, 0);
    let street_reached = match primary.len() {
        5.. => Street::River,
        4 => Street::Turn,
        3 => Street::Flop,
        _ => Street::Preflop,
    };
    let contenders = input
        .players
        .iter()
        .filter(|p| !input.folded_players.contains(&p.name))
        .count();
    let went_to_showdown = input.saw_showdown_marker && contenders >= 2;

    PhfResults {
        total_pot: input.total_pot,
        pots: input.pots.clone(),
        fees: input.fees,
        players: player_results,
        winners,
        hero_net: input.hero_name.map(|hero| {
            lookup(input.collected_by, hero)
                .unwrap_or(0)
                .saturating_sub(lookup(input.contributions, hero).unwrap_or(0))
        }),
        went_to_showdown,
        street_reached: if went_to_showdown {
            Street::Showdown
        } else {
            street_reached
        },
    }
}

/// `parseStandardText(text, ctx)`: every hand of a standard-format file;
/// chunks that are not hands are dropped. Site `standard` / `Rail standard`
/// unless `ctx` says otherwise.
pub fn parse_standard_text(text: &str, ctx: &StandardContext<'_>) -> Result<Vec<PhfHand>, JsError> {
    let mut out = Vec::new();
    for chunk in split_standard_hands(text) {
        if let Some(hand) = parse_standard_hand(&chunk, ctx)? {
            out.push(hand);
        }
    }
    Ok(out)
}

impl Default for StandardContext<'_> {
    /// `parseStandardText`'s defaults, with the clock pinned.
    fn default() -> Self {
        Self {
            site_id: "standard",
            site_name: "Rail standard",
            original_filename: None,
            parser_id: None,
            parser_version: None,
            parsed_at: crate::detect::PINNED_PARSED_AT,
        }
    }
}
