//! `chico`: the Chico network - BetOnline, PayNoRake, ActionPoker, Gear Poker
//! (`frontend/src/lib/parsers/chico.ts`, R0.10a).
//!
//! One network, several skins: lower-case verbs and `[a b c][d]` brackets
//! (BetOnline, PayNoRake) or Title-Case verbs with trailing periods (`Calls
//! 2.00.`, ActionPoker, Gear Poker), read by one set of patterns into a
//! [`P6Draft`] and built by [`build_p6_hand`]. SportsBetting.ag and Tiger
//! Gaming are named by the network but no hand of theirs exists: detected at
//! 0.55 and warned `unverified-skin`.
//!
//! What it gets right that a naive reading would not:
//!
//! - the variant comes from the **cards**, not the label: every four-card
//!   hand is headed `Hold'em Pot Limit`;
//! - the only statement of who won is the SUMMARY block;
//! - the `Total pot | Rake` lines repeat per pot component, so only the rake
//!   is read from them - and every other number is reconciled against it
//!   (13 of the 17 hands of the Omaha file are refused `rake-mismatch` for
//!   the network's own accounting);
//! - `post dead` under-reports by a small blind, added back as dead money;
//! - ten is written `10`, and two skins print the best five cards as the
//!   shown hand.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `chico.ts`); the multiline header probes and the lookahead split run at
//! every JavaScript line start.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::shared::p2_partygaming::{iso_from_888_date, split_lines};
use super::shared::p6_handbuilder::{
    P6Action, P6Collect, P6Draft, P6Kind, P6PrintedUncalled, P6Seat, P6Street, P6Tournament,
    build_p6_hand,
};
use super::shared::ps_gg_hand::split_before_line_starts;
use super::shared::variant_lock::{HOLDEM_OMAHA, canonical_game_label};
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::game::hole_card_count;
use crate::phf::money::{CHIPS, PLAY_CHIPS, USD, parse_amount_js};
use crate::phf::serialize::matches_at_line_start;
use crate::phf::{CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant};

/// `VERSION`.
pub const CHICO_PARSER_VERSION: &str = "1.0.0";

/// `chicoParser.name`.
pub const CHICO_PARSER_NAME: &str =
    "Chico Network (BetOnline / PayNoRake / ActionPoker / Gear Poker)";

/// `CHICO_VARIANTS`: decided by the deal - two-card Hold'em and four-card
/// Omaha (17 hands, all headed `Hold'em Pot Limit`).
const CHICO_VARIANTS: &[Variant] = HOLDEM_OMAHA;

/// `CONFIRMED_SKINS`: brand strings backed by real fixture bytes.
pub const CONFIRMED_SKINS: [&str; 4] = [
    "BetOnline Poker",
    "PayNoRake",
    "ActionPoker.com",
    "Gear Poker",
];
/// `INFERRED_SKINS`: brand strings asserted only by another parser's regex.
pub const INFERRED_SKINS: [&str; 2] = ["SportsBetting.ag Poker", "Tiger Gaming"];

/// `name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`.
fn escape_reg_exp(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `BRAND`: every skin, escaped and joined with `|`.
static BRAND: LazyLock<String> = LazyLock::new(|| {
    CONFIRMED_SKINS
        .iter()
        .chain(INFERRED_SKINS.iter())
        .map(|name| escape_reg_exp(name))
        .collect::<Vec<_>>()
        .join("|")
});

static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    js::regex::js_regex(
        &format!(
            r"^({}) Game #(\d+): (.+?) - (\d{{4}}[/-]\d{{2}}[/-]\d{{2}} .*)$",
            *BRAND
        ),
        "",
    )
});
/// `CONFIRMED_HEADER` without its `m` flag (run at every line start).
static CONFIRMED_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    let confirmed: Vec<String> = CONFIRMED_SKINS.iter().map(|n| escape_reg_exp(n)).collect();
    js::regex::js_regex(&format!(r"^(?:{}) Game #\d+:", confirmed.join("|")), "")
});
/// `ANY_HEADER` without its `m` flag (run at every line start).
static ANY_HEADER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"^(?:{}) Game #\d+:", *BRAND), ""));
/// The split's lookahead body, `(?=^(?:${BRAND}) Game #)` with `m`.
static SPLIT_AT: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"^(?:{}) Game #", *BRAND), ""));

static DATE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(.*))?$",
    ""
);
static TABLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table (?:'([^']*)'|(.+?)) (?:(\d+)-Max,|\((?:Play|Real) Money\)) Seat #(\d+) is the button\s*$",
    "i"
);
static SEAT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Seat (\d+): (.*?) \(([^()]*?) in [Cc]hips\)(?: - (.+?))?\s*$",
    ""
);
static POT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Total [Pp]ot ([\d.,]+)(?: \| Rake ([\d.,]+))?\s*\.?$", "");
/// `SAFE_AMOUNT`: US decimal, optional thousands grouping.
static SAFE_AMOUNT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$", "");
/// `NOISE`: chat, joins, leaves and lobby lines, dropped on purpose.
static NOISE: LazyLock<Regex> = crate::js_regex_lazy!(
    r#"(?: said ".*"$| joins the table at seat #\d+$| has left the table$)|^Joined table during game\.|^Tournament will start in a moment\.$|^Hand cancelled"#,
    ""
);

static PLAY_MONEY: LazyLock<Regex> = crate::js_regex_lazy!(r"\(Play Money\)", "i");
static TOURNAMENT_SPEC: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Tournament #(\d+):\s*(.+?)\s+(\S+)\/(\S+)$", "");
static CASH_SPEC: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?)\s*\((\S+?)\/(\S+?)\)$", "");
static HOLDEM_LABEL: LazyLock<Regex> = crate::js_regex_lazy!(r"hold\s*'?em", "i");
static ANY_SYMBOL: LazyLock<Regex> = crate::js_regex_lazy!(r"[$€£]", "");
static LEADING_SYMBOL: LazyLock<Regex> = crate::js_regex_lazy!(r"^[$€£]", "");
static FRACTION: LazyLock<Regex> = crate::js_regex_lazy!(r"\.\d*[1-9]", "");
static MARKER_HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* HOLE CARDS \*\*\*", "");
static MARKER_SHOWDOWN: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* SHOW\s?DOWN \*\*\*", "");
static MARKER_SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* SUMMARY \*\*\*", "");
static MARKER_BOARD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (FLOP|TURN|RIVER) \*\*\*\s*(.*)$", "i");
static BRACKET: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");
static SUMMARY_BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board \[([^\]]*)\]\s*$", "");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+): (.*)$", "");
static SHOWED: LazyLock<Regex> = crate::js_regex_lazy!(r"showed \[([^\]]*)\]", "i");
static WON: LazyLock<Regex> = crate::js_regex_lazy!(r"\b(?:collected|won) \(([\d.,]+)\)", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt [Tt]o (.+?) \[([^\]]*)\]\s*$", "");
static UNCALLED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Uncalled bet \(([\d.,]+)\) returned to (.+?)\s*$", "");
static UNSEATED_ACTION: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^.+?: (?:folds|checks|calls|bets|raises|posts?|ante)\b",
    "i"
);
static TRAILING_PERIOD: LazyLock<Regex> = crate::js_regex_lazy!(r"\.\s*$", "");
static ALL_IN: LazyLock<Regex> = crate::js_regex_lazy!(r" and is all[- ]?in$", "i");
static FOLDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^folds$", "i");
static CHECKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^checks$", "i");
static BLIND: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts? (small|big) blind ([\d.,]+)$", "i");
static POST: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts? (now|dead) ([\d.,]+)$", "i");
static DEAD: LazyLock<Regex> = crate::js_regex_lazy!(r"^dead$", "i");
static ANTE: LazyLock<Regex> = crate::js_regex_lazy!(r"^ante processed ([\d.,]+)$", "i");
static CALL_BET: LazyLock<Regex> = crate::js_regex_lazy!(r"^(calls|bets) ([\d.,]+)$", "i");
static CALLS: LazyLock<Regex> = crate::js_regex_lazy!(r"^calls$", "i");
static RAISE_TO: LazyLock<Regex> = crate::js_regex_lazy!(r"^raises ([\d.,]+) to ([\d.,]+)$", "i");
static RAISE_BY: LazyLock<Regex> = crate::js_regex_lazy!(r"^raises ([\d.,]+)$", "i");
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"pot\s*limit", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"fixed\s*limit", "i");
static CARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^(10|[2-9tjqkaTJQKA])([shdcSHDC])$", "");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

fn warning(code: &str, message: impl Into<String>, line: Option<u32>) -> PhfWarning {
    PhfWarning {
        code: code.to_owned(),
        message: message.into(),
        line,
    }
}

/// `limitOf(label)`: `Hold'em`, `Hold'em No Limit`, `Hold'em Pot Limit`.
fn limit_of(label: &str) -> LimitType {
    if POT_LIMIT.is_match(label) {
        return LimitType::Pl;
    }
    if FIXED_LIMIT.is_match(label) {
        return LimitType::Fl;
    }
    // A bare `Hold'em` is what the Title-Case skins write (no-limit tables).
    LimitType::Nl
}

/// `variantForHoleCount(count)`: the flop game a deal of `count` hole cards
/// belongs to.
fn variant_for_hole_count(count: usize) -> Option<Variant> {
    [
        Variant::Holdem,
        Variant::Omaha,
        Variant::Omaha5,
        Variant::Omaha6,
    ]
    .into_iter()
    .find(|variant| hole_card_count(*variant).and_then(|n| usize::try_from(n).ok()) == Some(count))
}

/// `cardsIn(raw)`: card codes with `10` -> `T` and the suit lower-cased.
fn cards_in(raw: &str) -> Vec<String> {
    js::trim(raw)
        .split(js::is_whitespace)
        .filter(|token| !token.is_empty())
        .map(|token| {
            let Some(card) = CARD.captures(token) else {
                return token.to_owned();
            };
            let rank = js::to_upper_case(&card[1]);
            let rank = if rank == "10" { "T".to_owned() } else { rank };
            format!("{rank}{}", js::to_lower_case(&card[2]))
        })
        .collect()
}

/// `isoFrom(match)`: the printed clock as the instant (seconds default to 0).
fn iso_from(date: &regex::Captures<'_>) -> Option<String> {
    iso_from_888_date(
        &date[3],
        &date[2],
        &date[1],
        &date[4],
        &date[5],
        date.get(6).map_or("0", |m| m.as_str()),
    )
}

/// `Map` key equality (`SameValueZero`) for the seat-number maps.
fn same_key(a: JsNumber, b: JsNumber) -> bool {
    a.strict_equals(b) || (a.is_nan() && b.is_nan())
}

/// `name.length` as a JavaScript number (UTF-16 code units).
fn utf16_length(name: &str) -> JsNumber {
    JsNumber::from_u64(u64::try_from(js::utf16_len(name)).unwrap_or(u64::MAX))
}

/// `nameOf(line, separator)`: the longest seated name `line` starts with,
/// followed by `separator`.
fn name_of(names: &[String], line: &str, separator: &str) -> Option<String> {
    names
        .iter()
        .find(|name| {
            line.strip_prefix(name.as_str())
                .is_some_and(|rest| rest.starts_with(separator))
        })
        .cloned()
}

/// The money readers of one hand (`readAmount`, `readStake`).
struct Money {
    unit: CurrencyUnit,
}

impl Money {
    /// `readAmount(token, line)`.
    fn amount(&self, token: &str, line: usize) -> Result<JsNumber, ParseError> {
        let cleaned = LEADING_SYMBOL.replace(js::trim(token), "");
        if !SAFE_AMOUNT.is_match(&cleaned) {
            return Err(skip(
                SkipReason::UnsupportedLocale,
                format!(
                    "\"{token}\" on line {line} is not a plain decimal amount, and guessing at \
                     its magnitude would be wrong by a factor of 100."
                ),
            ));
        }
        Ok(parse_amount_js(&cleaned, &self.unit))
    }

    /// `readStake(token, line)`: money entering the pot, refused when it is
    /// a fraction of an indivisible chip.
    fn stake(&self, token: &str, line: usize) -> Result<JsNumber, ParseError> {
        let value = self.amount(token, line)?;
        if self.unit.minor_units == 1 && FRACTION.is_match(token) {
            return Err(skip(
                SkipReason::FractionalChips,
                format!(
                    "\"{token}\" on line {line} is a fraction of a chip, which this hand's unit \
                     cannot represent."
                ),
            ));
        }
        Ok(value)
    }
}

/// `requireSeat(name, line)`: the seat of an actor, who is then dealt in.
fn require_seat(
    seats: &[P6Seat],
    acted: &mut HashSet<String>,
    name: &str,
    line: usize,
) -> Result<usize, ParseError> {
    let Some(index) = seats.iter().position(|seat| seat.name == name) else {
        // `Unknown player` is a real sentinel; there is no seat to attach
        // the chips to.
        return Err(skip(
            SkipReason::UnseatedActor,
            format!("\"{name}\" acts on line {line} but is not seated in this hand."),
        ));
    };
    acted.insert(name.to_owned());
    Ok(index)
}

/// `chicoParser.parseHand`.
#[allow(clippy::too_many_lines, clippy::cognitive_complexity)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    let lines = split_lines(text);
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let Some(header) = HEADER.captures(lines[0]) else {
        return Err(skip(
            SkipReason::NoHeader,
            format!("Unreadable Chico header: \"{}\".", lines[0]),
        ));
    };
    let skin = &header[1];
    if INFERRED_SKINS.contains(&skin) {
        warnings.push(warning(
            "unverified-skin",
            format!(
                "\"{skin}\" is named by the network but no real hand history bearing that brand \
                 was available when this parser was written; its dialect is inferred from the \
                 four skins that were."
            ),
            None,
        ));
    }

    let Some(table) = lines.get(1).and_then(|line| TABLE.captures(line)) else {
        return Err(skip(
            SkipReason::NoHeader,
            format!(
                "Unreadable Chico table line: \"{}\".",
                lines.get(1).copied().unwrap_or("")
            ),
        ));
    };
    let play_money = PLAY_MONEY.is_match(lines.get(1).copied().unwrap_or(""));

    /* ---------------------------------------------------------- header --- */

    let spec = js::trim(&header[3]);
    let tournament = TOURNAMENT_SPEC.captures(spec);
    let cash = CASH_SPEC.captures(spec);

    let game_label_raw = match (&tournament, &cash) {
        (Some(tournament), _) => tournament.get(2).map_or("", |m| m.as_str()),
        (None, Some(cash)) => cash.get(1).map_or("", |m| m.as_str()),
        (None, None) => spec,
    };
    if let Some(hi_lo) = unsupported_game_skip(game_label_raw, &[]) {
        return Err(hi_lo.into());
    }
    if !HOLDEM_LABEL.is_match(game_label_raw) {
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "\"{game_label_raw}\" is a game label this network has not been seen to print; \
                 every verified hand is labelled Hold'em, whatever it deals."
            ),
        ));
    }

    // Tournament and play-money stacks are chips; a real-money cash table is
    // dollars (the network prints no symbol on body amounts).
    let unit = if tournament.is_some() {
        CHIPS.unit()
    } else if play_money {
        warnings.push(warning(
            "play-money-table",
            "The table is flagged as play money, so the amounts are not real currency.",
            None,
        ));
        PLAY_CHIPS.unit()
    } else {
        if !ANY_SYMBOL.is_match(spec) {
            warnings.push(warning(
                "assumed-currency",
                "The header states no currency symbol; the amounts are read as USD, which is the \
                 only currency this network has been seen to offer.",
                None,
            ));
        }
        USD.unit()
    };
    let money = Money { unit };

    let date = DATE.captures(js::trim(&header[4]));
    let played_at = date.as_ref().and_then(iso_from);
    if date.is_none() {
        warnings.push(warning(
            "unreadable-timestamp",
            format!("Could not read a timestamp from \"{}\".", &header[4]),
            None,
        ));
    }

    /* ---------------------------------------------------------- stream --- */

    let mut seats: Vec<P6Seat> = Vec::new();
    let mut actions: Vec<P6Action> = Vec::new();
    let mut acted: HashSet<String> = HashSet::new();
    let mut printed_uncalled: Vec<P6PrintedUncalled> = Vec::new();
    // Indices into `actions` of the `post dead` entries.
    let mut dead_posts: Vec<usize> = Vec::new();
    // `Total pot` figures, kept only as evidence that the hand finished.
    let mut pot_components = 0_usize;
    // `Map<number, …>`s, in insertion order.
    let mut summary_shown: Vec<(JsNumber, Vec<String>)> = Vec::new();
    let mut summary_won: Vec<(JsNumber, JsNumber)> = Vec::new();
    let mut inline_shown: HashSet<String> = HashSet::new();
    let mut reported_rake: Option<JsNumber> = None;
    let mut street = P6Street::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut summary_board: Option<Vec<String>> = None;
    let mut in_summary = false;
    let mut names: Vec<String> = Vec::new();

    for (i, raw_line) in lines.iter().enumerate().skip(2) {
        let line = js::trim(raw_line);
        let line_no = i + 1;
        let line_u32 = u32::try_from(line_no).ok();
        if line.is_empty() {
            continue;
        }

        if MARKER_HOLE_CARDS.is_match(line) {
            street = P6Street::Preflop;
            continue;
        }
        if MARKER_SHOWDOWN.is_match(line) {
            continue;
        }
        if MARKER_SUMMARY.is_match(line) {
            in_summary = true;
            continue;
        }

        if let Some(board) = MARKER_BOARD.captures(line) {
            // The last bracket holds the new card(s); BetOnline runs the
            // brackets together, ActionPoker separates them.
            let last = BRACKET
                .captures_iter(board.get(2).map_or("", |m| m.as_str()))
                .last()
                .map(|group| cards_in(&group[1]))
                .unwrap_or_default();
            match js::to_upper_case(&board[1]).as_str() {
                "FLOP" => {
                    flop = Some(last);
                    street = P6Street::Flop;
                }
                "TURN" => {
                    turn = last.into_iter().next();
                    street = P6Street::Turn;
                }
                _ => {
                    river = last.into_iter().next();
                    street = P6Street::River;
                }
            }
            continue;
        }

        // Pot lines appear in and out of the SUMMARY block, once per pot
        // component; the rake they repeat is the hand's total.
        if let Some(pot) = POT.captures(line) {
            money.stake(&pot[1], line_no)?;
            pot_components += 1;
            if let Some(rake) = pot.get(2) {
                reported_rake = Some(money.stake(rake.as_str(), line_no)?);
            }
            continue;
        }

        if let Some(printed) = SUMMARY_BOARD.captures(line) {
            summary_board = Some(cards_in(&printed[1]));
            continue;
        }

        if !in_summary && let Some(seat) = SEAT.captures(line) {
            let name = js::trim(seat.get(2).map_or("", |m| m.as_str()));
            if name.is_empty() {
                return Err(skip(
                    SkipReason::UnnamedSeat,
                    format!(
                        "Seat {} on line {line_no} has no player name, so its actions cannot be \
                         attributed.",
                        &seat[1]
                    ),
                ));
            }
            if seats.iter().any(|entry| entry.name == name) {
                return Err(skip(
                    SkipReason::DuplicatePlayer,
                    format!("\"{name}\" is seated twice."),
                ));
            }
            let number = JsNumber::parse(&seat[1]);
            if seats.iter().any(|entry| entry.seat.strict_equals(number)) {
                return Err(skip(
                    SkipReason::DuplicateSeat,
                    format!(
                        "Seat {} is claimed by two different players in the same hand.",
                        &seat[1]
                    ),
                ));
            }
            seats.push(P6Seat {
                seat: number,
                name: name.to_owned(),
                starting_stack: money.amount(seat.get(3).map_or("", |m| m.as_str()), line_no)?,
                // Decided below from whether the seat did anything.
                dealt_in: false,
                is_hero: false,
                dealt_cards: Vec::new(),
            });
            names.push(name.to_owned());
            // `names.sort((a, b) => b.length - a.length)`, as V8 sorts.
            js::sort::sort_by(&mut names, |a, b| utf16_length(b) - utf16_length(a));
            continue;
        }

        if in_summary {
            // Some hands print an inline reveal after the summary marker.
            if let Some(late) = name_of(&names, line, " shows ") {
                let cards = cards_in(&line[late.len() + " shows ".len()..]);
                if !inline_shown.contains(&late) {
                    inline_shown.insert(late.clone());
                    acted.insert(late.clone());
                    let mut action = P6Action::new(street, &late, P6Kind::Show);
                    action.cards = Some(cards);
                    action.line = line_u32;
                    actions.push(action);
                }
                continue;
            }
            if let Some(summary_seat) = SUMMARY_SEAT.captures(line) {
                let number = JsNumber::parse(&summary_seat[1]);
                let rest = summary_seat.get(2).map_or("", |m| m.as_str());
                if let Some(shown) = SHOWED.captures(rest) {
                    let cards = cards_in(&shown[1]);
                    match summary_shown
                        .iter_mut()
                        .find(|(key, _)| same_key(*key, number))
                    {
                        Some(entry) => entry.1 = cards,
                        None => summary_shown.push((number, cards)),
                    }
                }
                if let Some(won) = WON.captures(rest) {
                    let previous = summary_won
                        .iter()
                        .find(|(key, _)| same_key(*key, number))
                        .map_or(JsNumber::ZERO, |(_, value)| *value);
                    let total = previous + money.stake(&won[1], line_no)?;
                    match summary_won
                        .iter_mut()
                        .find(|(key, _)| same_key(*key, number))
                    {
                        Some(entry) => entry.1 = total,
                        None => summary_won.push((number, total)),
                    }
                }
                continue;
            }
            if NOISE.is_match(line) {
                continue;
            }
            warnings.push(warning("unknown-summary-line", line, line_u32));
            continue;
        }

        if let Some(dealt) = DEALT.captures(line) {
            let owner = require_seat(&seats, &mut acted, js::trim(&dealt[1]), line_no)?;
            seats[owner].is_hero = true;
            seats[owner].dealt_cards = cards_in(&dealt[2]);
            continue;
        }

        if let Some(uncalled) = UNCALLED.captures(line) {
            let owner = require_seat(&seats, &mut acted, js::trim(&uncalled[2]), line_no)?;
            let player = seats[owner].name.clone();
            printed_uncalled.push(P6PrintedUncalled {
                player,
                amount: money.stake(&uncalled[1], line_no)?,
            });
            continue;
        }

        if NOISE.is_match(line) {
            continue;
        }

        // Inline showdown reveals carry no brackets: `Player2 shows Jc Jd`.
        if let Some(shows) = name_of(&names, line, " shows ") {
            let cards = cards_in(&line[shows.len() + " shows ".len()..]);
            require_seat(&seats, &mut acted, &shows, line_no)?;
            inline_shown.insert(shows.clone());
            let mut action = P6Action::new(street, &shows, P6Kind::Show);
            action.cards = Some(cards);
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        let Some(actor) = name_of(&names, line, ": ") else {
            // `Unknown player: raises …`: an action by somebody not seated.
            if UNSEATED_ACTION.is_match(line) {
                return Err(skip(
                    SkipReason::UnseatedActor,
                    format!(
                        "Line {line_no} is an action by somebody who is not in the seat list: \
                         \"{line}\"."
                    ),
                ));
            }
            warnings.push(warning("unknown-line", line, line_u32));
            continue;
        };
        require_seat(&seats, &mut acted, &actor, line_no)?;
        // The Title-Case skins end every line with a period.
        let rest = TRAILING_PERIOD.replace(&line[actor.len() + 2..], "");
        let rest = js::trim(&rest);
        let all_in = ALL_IN.is_match(rest);
        let verb = ALL_IN.replace(rest, "");
        let verb = js::trim(&verb);

        if FOLDS.is_match(verb) || CHECKS.is_match(verb) {
            let kind = if FOLDS.is_match(verb) {
                P6Kind::Fold
            } else {
                P6Kind::Check
            };
            let mut action = P6Action::new(street, &actor, kind);
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(blind) = BLIND.captures(verb) {
            let kind = if js::to_lower_case(&blind[1]) == "small" {
                P6Kind::SmallBlind
            } else {
                P6Kind::BigBlind
            };
            let mut action = P6Action::new(P6Street::Preflop, &actor, kind);
            action.amount = Some(money.stake(&blind[2], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        // `post now` catches up mid-orbit; `post dead` is the dead-blind
        // form. Both are live money that does not move the ring.
        if let Some(post) = POST.captures(verb) {
            let mut action = P6Action::new(P6Street::Preflop, &actor, P6Kind::Post);
            action.amount = Some(money.stake(&post[2], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            if DEAD.is_match(&post[1]) {
                dead_posts.push(actions.len() - 1);
            }
            continue;
        }

        if let Some(ante) = ANTE.captures(verb) {
            let amount = money.stake(&ante[1], line_no)?;
            // A zero ante is printed for every seat, sitting out or not.
            if amount.greater_than(JsNumber::ZERO) {
                let mut action = P6Action::new(P6Street::Preflop, &actor, P6Kind::Ante);
                action.amount = Some(amount);
                action.all_in = all_in;
                action.line = line_u32;
                actions.push(action);
            } else {
                acted.remove(&actor);
            }
            continue;
        }

        if let Some(call_bet) = CALL_BET.captures(verb) {
            let kind = if CALLS.is_match(&call_bet[1]) {
                P6Kind::Call
            } else {
                P6Kind::Bet
            };
            let mut action = P6Action::new(street, &actor, kind);
            action.amount = Some(money.stake(&call_bet[2], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(raise) = RAISE_TO.captures(verb) {
            // Only the "to" number is trustworthy.
            let mut action = P6Action::new(street, &actor, P6Kind::Raise);
            action.amount = Some(money.stake(&raise[2], line_no)?);
            action.to_total = true;
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        // `Raises 1000.00 and is All In.`: an increment, like the calls.
        if let Some(raise) = RAISE_BY.captures(verb) {
            let mut action = P6Action::new(street, &actor, P6Kind::Raise);
            action.amount = Some(money.stake(&raise[1], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        warnings.push(warning("unknown-line", line, line_u32));
    }

    /* ---------------------------------------------------------- checks --- */

    if seats.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The hand lists no seats."));
    }
    if pot_components == 0 {
        return Err(skip(
            SkipReason::TruncatedHand,
            "The hand has no readable `Total pot` line.",
        ));
    }

    // `post dead X` under-reports by the small blind: added back as dead
    // money, and checked against the printed rake by the builder.
    if !dead_posts.is_empty() {
        let posted_small_blind = actions
            .iter()
            .find(|entry| entry.kind == P6Kind::SmallBlind)
            .and_then(|entry| entry.amount)
            .unwrap_or(JsNumber::ZERO);
        for index in &dead_posts {
            actions[*index].dead = Some(posted_small_blind);
        }
    }

    // The deal and the inline reveals decide the variant, and must agree.
    let mut dealt_counts: Vec<usize> = Vec::new();
    let counts = seats.iter().map(|entry| entry.dealt_cards.len()).chain(
        actions
            .iter()
            .filter(|action| action.kind == P6Kind::Show)
            .map(|action| action.cards.as_ref().map_or(0, Vec::len)),
    );
    for count in counts {
        if count > 0 && !dealt_counts.contains(&count) {
            dealt_counts.push(count);
        }
    }
    if dealt_counts.len() > 1 {
        // `[...dealtCounts].sort()`: compared as strings.
        let mut sorted: Vec<String> = dealt_counts.iter().map(ToString::to_string).collect();
        sorted.sort();
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "The hand shows hole cards in groups of {}; one deal cannot be both.",
                sorted.join(" and ")
            ),
        ));
    }
    let hole_count = dealt_counts.first().copied().unwrap_or(2);
    let Some(variant) =
        variant_for_hole_count(hole_count).filter(|variant| CHICO_VARIANTS.contains(variant))
    else {
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "The hand deals {hole_count} hole cards under the label \"{game_label_raw}\"; \
                 this parser reads two-card Hold'em and four-card Omaha from this network and \
                 has no verified sample of anything else."
            ),
        ));
    };
    // A four-card table that names itself hi/lo is taken at its word.
    let table_name = js::trim(
        table
            .get(1)
            .or_else(|| table.get(2))
            .map_or("", |m| m.as_str()),
    );
    if variant != Variant::Holdem && crate::phf::is_hi_lo_label(table_name) {
        return Err(skip(
            SkipReason::UnsupportedHiLo,
            format!(
                "The four-card table \"{table_name}\" names itself a high-low split game, which \
                 this converter does not model yet, so the hand is refused rather than read as \
                 high-only."
            ),
        ));
    }

    // The markers have to be a prefix of the summary board, which fills in
    // the run-out the markers stop before.
    let mut marker_board: Vec<String> = flop.clone().unwrap_or_default();
    marker_board.extend(turn.clone());
    marker_board.extend(river.clone());
    let mut resolved = marker_board.clone();
    if let Some(summary) = &summary_board {
        let conflicting = marker_board.len() > summary.len()
            || marker_board
                .iter()
                .enumerate()
                .any(|(index, card)| summary.get(index) != Some(card));
        if conflicting {
            return Err(skip(
                SkipReason::BoardMismatch,
                format!(
                    "The street markers deal [{}] but the summary reports [{}]; the two cannot \
                     both be the board.",
                    marker_board.join(" "),
                    summary.join(" ")
                ),
            ));
        }
        if summary.len() > marker_board.len() {
            resolved.clone_from(summary);
            flop = Some(resolved[..resolved.len().min(3)].to_vec());
            turn = resolved.get(3).cloned();
            river = resolved.get(4).cloned();
            warnings.push(warning(
                "board-from-summary",
                format!(
                    "The street markers stop after {} cards; the rest of the board is taken \
                     from the summary, which is the only place it is written down.",
                    marker_board.len()
                ),
                None,
            ));
        }
    }
    if !resolved.is_empty() && ![3, 4, 5].contains(&resolved.len()) {
        return Err(skip(
            SkipReason::BoardSize,
            format!("The board has {} cards.", resolved.len()),
        ));
    }

    /* --------------------------------------------------- reveals, pots --- */

    let on_board = |card: &String| resolved.contains(card);
    for action in &actions {
        if action.kind != P6Kind::Show {
            continue;
        }
        if action.cards.iter().flatten().any(on_board) {
            return Err(skip(
                SkipReason::DuplicateCard,
                format!(
                    "{} shows a card that is already on the board.",
                    action.player
                ),
            ));
        }
    }
    for (number, cards) in &summary_shown {
        let Some(seat) = seats.iter().find(|entry| entry.seat.strict_equals(*number)) else {
            continue;
        };
        if inline_shown.contains(&seat.name) {
            continue;
        }
        // The best five cards rather than the hole cards: dropped.
        if cards.len() != hole_count || cards.iter().any(on_board) {
            warnings.push(warning(
                "unreadable-shown-cards",
                format!(
                    "Seat {} is shown as [{}], which is the made hand rather than hole cards, so \
                     no hole cards were recorded for the seat.",
                    number.to_js_string(),
                    cards.join(" ")
                ),
                None,
            ));
            continue;
        }
        let mut action = P6Action::new(street, &seat.name, P6Kind::Show);
        action.cards = Some(cards.clone());
        actions.push(action);
        acted.insert(seat.name.clone());
    }

    let mut collected: Vec<P6Collect> = Vec::new();
    for (number, amount) in &summary_won {
        let Some(seat) = seats.iter().find(|entry| entry.seat.strict_equals(*number)) else {
            return Err(skip(
                SkipReason::UnseatedActor,
                format!(
                    "The summary credits seat {}, which is not in the seat list.",
                    number.to_js_string()
                ),
            ));
        };
        if amount.greater_than(JsNumber::ZERO) {
            collected.push(P6Collect {
                player: seat.name.clone(),
                amount: *amount,
                pot_name: Some("pot".to_owned()),
            });
            acted.insert(seat.name.clone());
        }
    }

    for seat in &mut seats {
        seat.dealt_in = acted.contains(&seat.name);
    }

    let (header_small_blind, header_big_blind) = match (&tournament, &cash) {
        (Some(tournament), _) => (
            money.amount(&tournament[3], 1)?,
            money.amount(&tournament[4], 1)?,
        ),
        (None, Some(cash)) => (money.amount(&cash[2], 1)?, money.amount(&cash[3], 1)?),
        (None, None) => (JsNumber::ZERO, JsNumber::ZERO),
    };

    let draft = P6Draft {
        site_id: "chico".to_owned(),
        site_name: CHICO_PARSER_NAME.to_owned(),
        parser_id: "chico".to_owned(),
        parser_version: CHICO_PARSER_VERSION.to_owned(),
        hand_prefix: "CHC-".to_owned(),
        hand_id: header[2].to_owned(),
        game_label: canonical_game_label(variant, limit_of(game_label_raw), false),
        unit: money.unit.clone(),
        decimals: DecimalStyle::Fixed2,
        header_small_blind,
        header_big_blind,
        table_name: Some(table_name.to_owned()).filter(|name| !name.is_empty()),
        // The Title-Case skins omit the capacity while seating ten.
        max_seats: table.get(3).map_or_else(
            || JsNumber::from_u64(10),
            |size| JsNumber::parse(size.as_str()),
        ),
        button_seat: Some(JsNumber::parse(&table[4])),
        tournament: tournament.as_ref().map(|tournament| P6Tournament {
            id: tournament[1].to_owned(),
            level_small_blind: header_small_blind,
            level_big_blind: header_big_blind,
        }),
        played_at,
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        collected_includes_uncalled: false,
        printed_uncalled,
        reported_gross: None,
        reported_payout: None,
        // Only the rake is read from the `Total pot` lines.
        reported_rake: Some(reported_rake.unwrap_or(JsNumber::ZERO)),
        raw_text: text.to_owned(),
        warnings,
    };

    build_p6_hand(&draft, ctx)
}

/// `chunk.replace(/^\uFEFF/, "").trim()`.
fn clean_chunk(chunk: &str) -> &str {
    js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk))
}

/// `chicoParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ChicoParser;

impl SiteParser for ChicoParser {
    fn id(&self) -> &'static str {
        "chico"
    }

    fn name(&self) -> &'static str {
        CHICO_PARSER_NAME
    }

    fn version(&self) -> &'static str {
        CHICO_PARSER_VERSION
    }

    /// 0.95 for a confirmed skin's header at a line start, 0.55 for an
    /// inferred skin's.
    fn detect(&self, text: &str) -> u32 {
        if matches_at_line_start(&CONFIRMED_HEADER, text) {
            return 950;
        }
        if matches_at_line_start(&ANY_HEADER, text) {
            return 550;
        }
        0
    }

    /// Cut before every header at a line start; the lobby chatter before the
    /// first header is dropped (`ANY_HEADER` tested on the first line, at
    /// each of its JavaScript line starts).
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(text, &SPLIT_AT)
            .into_iter()
            .map(clean_chunk)
            .filter(|chunk| matches_at_line_start(&ANY_HEADER, split_lines(chunk)[0]))
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_hand(raw, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/chico.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r#"const CONFIRMED_SKINS = ["BetOnline Poker", "PayNoRake", "ActionPoker.com", "Gear Poker"];"#,
            r#"const INFERRED_SKINS = ["SportsBetting.ag Poker", "Tiger Gaming"];"#,
            r#".map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))"#,
            r#".join("|");"#,
            r"String.raw`^(${BRAND}) Game #(\d+): (.+?) - (\d{4}[/-]\d{2}[/-]\d{2} .*)$`,",
            r"String.raw`^(?:${CONFIRMED_SKINS.map(",
            r#")}) Game #\d+:`,"#,
            r#"const ANY_HEADER = new RegExp(String.raw`^(?:${BRAND}) Game #\d+:`, "m");"#,
            r"const DATE = /^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(.*))?$/;",
            r"/^Table (?:'([^']*)'|(.+?)) (?:(\d+)-Max,|\((?:Play|Real) Money\)) Seat #(\d+) is the button\s*$/i;",
            r"const SEAT = /^Seat (\d+): (.*?) \(([^()]*?) in [Cc]hips\)(?: - (.+?))?\s*$/;",
            r"const POT = /^Total [Pp]ot ([\d.,]+)(?: \| Rake ([\d.,]+))?\s*\.?$/;",
            r"const SAFE_AMOUNT = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;",
            r#"/(?: said ".*"$| joins the table at seat #\d+$| has left the table$)|^Joined table during game\.|^Tournament will start in a moment\.$|^Hand cancelled/;"#,
            r#".split(new RegExp(String.raw`(?=^(?:${BRAND}) Game #)`, "m"))"#,
            ".map((chunk) => chunk.replace(/^\u{FEFF}/, \"\").trim())",
            r#".filter((chunk) => ANY_HEADER.test(chunk.split(/\r?\n/)[0] ?? ""));"#,
            "const text = raw.replace(/^\u{FEFF}/, \"\").trim();",
            r"const lines = text.split(/\r?\n/);",
            r#"const playMoney = /\(Play Money\)/i.test(lines[1] ?? "");"#,
            r"const tournamentMatch = spec.match(/^Tournament #(\d+):\s*(.+?)\s+(\S+)\/(\S+)$/);",
            r"const cashMatch = spec.match(/^(.+?)\s*\((\S+?)\/(\S+?)\)$/);",
            r"if (!/hold\s*'?em/i.test(gameLabelRaw)) {",
            r"if (!/[$€£]/.test(spec)) {",
            r#"const cleaned = token.trim().replace(/^[$€£]/, "");"#,
            r"if (unit.minorUnits === 1 && /\.\d*[1-9]/.test(token)) {",
            r"if (/^\*\*\* HOLE CARDS \*\*\*/.test(line)) {",
            r"if (/^\*\*\* SHOW\s?DOWN \*\*\*/.test(line)) {",
            r"if (/^\*\*\* SUMMARY \*\*\*/.test(line)) {",
            r"const board = line.match(/^\*\*\* (FLOP|TURN|RIVER) \*\*\*\s*(.*)$/i);",
            r"[...board[2].matchAll(/\[([^\]]*)\]/g)]",
            r"const printedBoard = line.match(/^Board \[([^\]]*)\]\s*$/);",
            r"const summarySeat = line.match(/^Seat (\d+): (.*)$/);",
            r"const shown = summarySeat[2].match(/showed \[([^\]]*)\]/i);",
            r"const won = summarySeat[2].match(/\b(?:collected|won) \(([\d.,]+)\)/i);",
            r"const dealt = line.match(/^Dealt [Tt]o (.+?) \[([^\]]*)\]\s*$/);",
            r"const uncalled = line.match(/^Uncalled bet \(([\d.,]+)\) returned to (.+?)\s*$/);",
            r"if (/^.+?: (?:folds|checks|calls|bets|raises|posts?|ante)\b/i.test(line)) {",
            r#".replace(/\.\s*$/, "")"#,
            r"const allIn = / and is all[- ]?in$/i.test(rest);",
            r#"const verb = rest.replace(/ and is all[- ]?in$/i, "").trim();"#,
            r"if (/^folds$/i.test(verb) || /^checks$/i.test(verb)) {",
            r"const blind = verb.match(/^posts? (small|big) blind ([\d.,]+)$/i);",
            r"const post = verb.match(/^posts? (now|dead) ([\d.,]+)$/i);",
            r"if (/^dead$/i.test(post[1])) {",
            r"const ante = verb.match(/^ante processed ([\d.,]+)$/i);",
            r"const callBet = verb.match(/^(calls|bets) ([\d.,]+)$/i);",
            r#"kind: /^calls$/i.test(callBet[1]) ? "call" : "bet","#,
            r"const raiseTo = verb.match(/^raises ([\d.,]+) to ([\d.,]+)$/i);",
            r"const raiseBy = verb.match(/^raises ([\d.,]+)$/i);",
            r"if (/pot\s*limit/i.test(label)) {",
            r"if (/fixed\s*limit/i.test(label)) {",
            r"const match = token.match(/^(10|[2-9tjqkaTJQKA])([shdcSHDC])$/);",
            r#"const flopGames: Variant[] = ["holdem", "omaha", "omaha5", "omaha6"];"#,
            "const CHICO_VARIANTS: readonly Variant[] = HOLDEM_OMAHA;",
            r#"const VERSION = "1.0.0";"#,
            r#"name: "Chico Network (BetOnline / PayNoRake / ActionPoker / Gear Poker)","#,
            r#"handPrefix: "CHC-","#,
            "maxSeats: tableMatch[3] ? Number(tableMatch[3]) : 10,",
            "names.find((name) => line.startsWith(`${name}${separator}`))",
            "names.sort((a, b) => b.length - a.length);",
            "Number(match[6] ?? 0),",
            "return 0.95;",
            "return 0.55;",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
        for message in [
            "`Unreadable Chico header: \"${lines[0] ?? \"\"}\".`",
            "`\"${skin}\" is named by the network but no real hand history bearing that brand ` +\n          \"was available when this parser was written; its dialect is inferred from the \" +\n          \"four skins that were.\"",
            "`Unreadable Chico table line: \"${lines[1] ?? \"\"}\".`",
            "`\"${gameLabelRaw}\" is a game label this network has not been seen to print; ` +\n          \"every verified hand is labelled Hold'em, whatever it deals.\"",
            "\"The table is flagged as play money, so the amounts are not real currency.\"",
            "\"The header states no currency symbol; the amounts are read as USD, which is \" +\n            \"the only currency this network has been seen to offer.\"",
            "`\"${token}\" on line ${line} is not a plain decimal amount, and guessing at its ` +\n            \"magnitude would be wrong by a factor of 100.\"",
            "`\"${token}\" on line ${line} is a fraction of a chip, which this hand's unit ` +\n            \"cannot represent.\"",
            "`Could not read a timestamp from \"${headerMatch[4]}\".`",
            "`\"${name}\" acts on line ${line} but is not seated in this hand.`",
            "`Seat ${seat[1]} on line ${lineNo} has no player name, so its actions cannot ` +\n              \"be attributed.\"",
            "`\"${name}\" is seated twice.`",
            "`Seat ${seat[1]} is claimed by two different players in the same hand.`",
            "`Line ${lineNo} is an action by somebody who is not in the seat list: \"${line}\".`",
            "\"The hand lists no seats.\"",
            "\"The hand has no readable `Total pot` line.\"",
            "`The hand shows hole cards in groups of ${[...dealtCounts].sort().join(\" and \")}; ` +\n          \"one deal cannot be both.\"",
            "`The hand deals ${holeCount} hole cards under the label \"${gameLabelRaw}\"; this ` +\n          \"parser reads two-card Hold'em and four-card Omaha from this network and has \" +\n          \"no verified sample of anything else.\"",
            "`The four-card table \"${tableName}\" names itself a high-low split game, which ` +\n          \"this converter does not model yet, so the hand is refused rather than read \" +\n          \"as high-only.\"",
            "`The street markers deal [${markerBoard.join(\" \")}] but the summary reports ` +\n            `[${summaryBoard.join(\" \")}]; the two cannot both be the board.`",
            "`The street markers stop after ${markerBoard.length} cards; the rest of the ` +\n            \"board is taken from the summary, which is the only place it is written down.\"",
            "`The board has ${resolved.length} cards.`",
            "`${action.player} shows a card that is already on the board.`",
            "`Seat ${number} is shown as [${cards.join(\" \")}], which is the made hand rather ` +\n            \"than hole cards, so no hole cards were recorded for the seat.\"",
            "`The summary credits seat ${number}, which is not in the seat list.`",
        ] {
            assert!(source.contains(message), "{message}");
        }
    }

    #[test]
    fn helpers() {
        assert_eq!(
            *BRAND,
            r"BetOnline Poker|PayNoRake|ActionPoker\.com|Gear Poker|SportsBetting\.ag Poker|Tiger Gaming"
        );
        assert_eq!(
            cards_in(" 10S 6d  Kc x 10x "),
            ["Ts", "6d", "Kc", "x", "10x"]
        );
        assert_eq!(limit_of("Hold'em"), LimitType::Nl);
        assert_eq!(limit_of("Hold'em Pot Limit"), LimitType::Pl);
        assert_eq!(limit_of("Hold'em Fixed Limit"), LimitType::Fl);
        assert_eq!(variant_for_hole_count(4), Some(Variant::Omaha));
        assert_eq!(variant_for_hole_count(3), None);
    }
}
