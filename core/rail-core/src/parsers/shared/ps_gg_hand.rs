//! Shared machinery for the PokerStars-family text grammars
//! (`frontend/src/lib/parsers/shared/ps-gg-hand.ts`).
//!
//! PokerStars invented the `Seat N: name ($x in chips)` / `*** FLOP *** [..]` /
//! `*** SUMMARY ***` shape and GGPoker is a dialect of it. The *semantics* are
//! shared - how `raises X to Y` becomes chips added, how an uncalled return
//! nets out of a street commitment, how the SUMMARY prose maps onto
//! [`PhfPlayerResult`], how runouts are assembled - and live in
//! [`StarsHandDraft`]. The *syntax* is each site's own: there is no line
//! dispatcher here (the PokerStars-clone dispatcher is
//! [`super::p3_stars_dialect`]).
//!
//! This is a shared contract. Besides [`crate::parsers::pokerstars`] and
//! [`crate::parsers::ggpoker`], CoinPoker, Full Tilt, Run It Once, PokerBros
//! and ACR (`limit_from_label`) read it, through [`super::p3_draft`] for some
//! of them. The API keeps the TypeScript's shape: the same free functions and
//! the same draft methods, in snake case.
//!
//! **Patterns** are the TypeScript source text verbatim (with `${MONEY}`
//! substituted as the template literal does), compiled with JavaScript
//! semantics; a test holds them to `ps-gg-hand.ts`. The two lookahead probes
//! of `detectDecimals` are written out as code.
//!
//! **What a Rust hand cannot hold.** The TypeScript records a straddler with
//! no seat line as `seat: -1` in `game.straddles`; a PHF seat is a `u32`, so
//! [`StarsHandDraft::build`] reports [`BuildError::UnseatedStraddler`]
//! instead. Every caller in the TypeScript then refuses the hand anyway (the
//! straddler is an actor missing from the seat block: `unseated-actor`), and
//! [`StarsHandDraft::first_unseated_actor`] names the actor that refusal
//! names.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::cards::{extract_cards, parse_card};
use crate::detect::{ParseError, ParseSkip, SkipReason};
use crate::js::{self, JsError, JsNumber};
use crate::phf::game::map_set;
use crate::phf::hilo::assign_hi_lo_halves;
use crate::phf::money::{CHIPS, cash_unit, format_amount, parse_amount, unit_for_symbol};
use crate::phf::{
    ActionType, Amount, AnteModel, BUTTON_BLIND_VERB, CurrencyUnit, DecimalStyle, GameFormat,
    LimitType, PhfAction, PhfBoard, PhfBombPot, PhfChipMovement, PhfFees, PhfGame, PhfHand,
    PhfMarkerLabels, PhfMeta, PhfPlayer, PhfPlayerResult, PhfPot, PhfResults, PhfRunout, PhfSchema,
    PhfStraddle, PhfTable, PhfTextStyle, PhfTournament, PhfWarning, PhfWinner, SeatOutcome, Street,
    Variant, resolve_runout,
};

/// Re-exported as `ps-gg-hand.ts` re-exports them from `phf/types`.
pub use crate::phf::{is_hi_lo_label, variant_from_label};

/* ------------------------------------------------------------- text helpers */

/// `toLines`: splits on `\r\n`, `\r` or `\n`. PokerStars exports exist with
/// bare-CR line endings (fixture 11), which a `\n` split would leave as one
/// line.
pub fn to_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                out.push(&text[start..i]);
                i += if bytes.get(i + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = i;
            }
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[start..]);
    out
}

/// `normalizeNewlines`: every line ending becomes `\n`, nothing else changes.
pub fn normalize_newlines(text: &str) -> String {
    to_lines(text).join("\n")
}

/// `text.split(/(?=^…)/m)` for a lookahead-only split pattern: a cut before
/// every JavaScript line start (after `\n`, `\r`, U+2028, U+2029) where
/// `anchored` (the lookahead's body, compiled without `m`) matches - never at
/// offset 0, where `String.prototype.split` skips the empty match.
pub fn split_before_line_starts<'t>(text: &'t str, anchored: &Regex) -> Vec<&'t str> {
    let mut cuts: Vec<usize> = crate::phf::serialize::line_starts(text)
        .filter(|&start| start > 0 && start < text.len() && anchored.is_match(&text[start..]))
        .collect();
    cuts.push(text.len());
    let mut out = Vec::with_capacity(cuts.len());
    let mut from = 0;
    for cut in cuts {
        out.push(&text[from..cut]);
        from = cut;
    }
    out
}

/// `stripBom`: `text.replace(/^﻿/, "")` - one leading BOM.
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// `MONEY`: the amount capture every amount-bearing pattern of the family
/// uses. Deliberately permissive about the symbol, so that a currency PHF
/// cannot represent is refused at the header rather than by every line
/// silently failing to match.
pub const MONEY: &str = r"(?:\$|€|£|¥|₩|R\$|Rs\.?)?\s?([\d,]+(?:\.\d+)?)";

/// A `String.raw` template with `${MONEY}` (and `${SUFFIX}`, given) filled in,
/// compiled with JavaScript semantics.
pub(crate) fn template_regex(template: &str, suffix: &str, flags: &str) -> Regex {
    js::regex::js_regex(
        &template
            .replace("${MONEY}", MONEY)
            .replace("${SUFFIX}", suffix),
        flags,
    )
}

/// `symbolIn`: the first currency symbol of `€`, `£`, `$` in the text; `""`
/// for chips or play money.
pub fn symbol_in(text: &str) -> &'static str {
    if text.contains('€') {
        "€"
    } else if text.contains('£') {
        "£"
    } else if text.contains('$') {
        "$"
    } else {
        ""
    }
}

/// `UNSUPPORTED_SYMBOL`: symbols `MONEY` accepts that no unit exists for.
static UNSUPPORTED_SYMBOL: LazyLock<Regex> = crate::js_regex_lazy!(r"¥|₩|Rs\.?\s?\d", "");
static CURRENCY_CODE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\b(USD|EUR|GBP|CAD|AUD|NZD|CNY|NOK|SEK|DKK|PLN|RUB|INR|BRL)\b",
    ""
);

/// `hasUnsupportedCurrency`: the text prices a hand in a currency PHF has no
/// unit for.
pub fn has_unsupported_currency(text: &str) -> bool {
    UNSUPPORTED_SYMBOL.is_match(text)
}

/// `unitForStakes(stakesText, chips)`: the header's unit. A stated
/// three-letter code wins (`$` is USD and CAD); no symbol at all is `chips`;
/// `None` is a currency PHF cannot represent, which the caller refuses.
pub fn unit_for_stakes(stakes_text: &str, chips: &CurrencyUnit) -> Option<CurrencyUnit> {
    if UNSUPPORTED_SYMBOL.is_match(stakes_text) {
        return None;
    }
    let symbol = symbol_in(stakes_text);
    if symbol.is_empty() {
        return Some(chips.clone());
    }
    if let Some(code) = CURRENCY_CODE.captures(stakes_text) {
        return Some(cash_unit(&code[1], symbol));
    }
    Some(unit_for_symbol(symbol).unit())
}

/// `buyInUnitFor(token, code)`: a buy-in with no currency symbol is play
/// money (chips), not dollars; a stated code wins over the symbol.
pub fn buy_in_unit_for(token: &str, code: Option<&str>) -> CurrencyUnit {
    let symbol = symbol_in(token);
    if symbol.is_empty() {
        return CHIPS.unit();
    }
    match code {
        Some(code) if !code.is_empty() => cash_unit(code, symbol),
        _ => unit_for_symbol(symbol).unit(),
    }
}

/// `detectDecimals`: `fixed2` when any amount shows a trailing zero after the
/// point (`/\d\.\d0(?!\d)/`), else `minimal` when one shows a single decimal
/// (`/\d\.\d(?!\d)/`), else `fixed2`. The probes are ASCII, so they scan
/// bytes.
pub fn detect_decimals(text: &str) -> DecimalStyle {
    let bytes = text.as_bytes();
    let digit = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_digit);
    let at = |i: usize, b: u8| bytes.get(i) == Some(&b);
    if (0..bytes.len())
        .any(|i| digit(i) && at(i + 1, b'.') && digit(i + 2) && at(i + 3, b'0') && !digit(i + 4))
    {
        return DecimalStyle::Fixed2;
    }
    if (0..bytes.len()).any(|i| digit(i) && at(i + 1, b'.') && digit(i + 2) && !digit(i + 3)) {
        return DecimalStyle::Minimal;
    }
    DecimalStyle::Fixed2
}

static PAD_HOUR: LazyLock<Regex> =
    crate::js_regex_lazy!(r"\d{4}[/-]\d{2}[/-]\d{2}[ T](\d{1,2}):\d{2}:\d{2}", "");

/// `detectPadHour`: whether the header zero-pads the hour; `true` when it
/// cannot tell.
pub fn detect_pad_hour(payload: &str) -> bool {
    PAD_HOUR
        .captures(payload)
        .is_none_or(|c| c.get(1).is_some_and(|hour| hour.as_str().len() == 2))
}

/// `parsePlayedAt`: the first `YYYY/MM/DD H:MM:SS` of a header payload, read
/// as UTC, as an ISO instant (the same reading `phf/serialize.ts` uses).
pub fn parse_played_at(payload: &str) -> Option<String> {
    crate::phf::serialize::parse_played_at(payload)
}

static LIMIT_PL: LazyLock<Regex> = crate::js_regex_lazy!(r"pot\s*limit|\bPL\b|\bPLO-?\d?\b", "i");
static LIMIT_NL: LazyLock<Regex> = crate::js_regex_lazy!(r"no\s*limit|\bNL\b|\bNLO-?\d?\b", "i");
static LIMIT_FL: LazyLock<Regex> = crate::js_regex_lazy!(r"\blimit\b", "i");

/// `limitFromLabel`: `PLO`/`PLO-5` are pot limit, `NLO` no limit, a bare
/// `limit` fixed limit, anything else no limit.
pub fn limit_from_label(label: &str) -> LimitType {
    if LIMIT_PL.is_match(label) {
        LimitType::Pl
    } else if LIMIT_NL.is_match(label) {
        LimitType::Nl
    } else if LIMIT_FL.is_match(label) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

static DIGITS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\d+$", "");
static ROMAN: LazyLock<Regex> = crate::js_regex_lazy!(r"^[IVXLCDM]+$", "");

/// Why a level label has no PHF number although the TypeScript gives it one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LevelTooLarge;

/// `levelNumberOf`: a roman or arabic level label to a number; `Ok(None)`
/// when it is neither. `Err` when the TypeScript's number is beyond `u32`
/// (`levelNumber` is a `u32` here, R0.4).
pub fn level_number_of(label: &str) -> Result<Option<u32>, LevelTooLarge> {
    if DIGITS.is_match(label) {
        return number_u32(label).map(Some).ok_or(LevelTooLarge);
    }
    let upper = js::to_upper_case(label);
    if !ROMAN.is_match(&upper) {
        return Ok(None);
    }
    let value = |c: Option<char>| -> i64 {
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
    let mut total: i64 = 0;
    for (i, c) in chars.iter().enumerate() {
        let this = value(Some(*c));
        let next = value(chars.get(i + 1).copied());
        total = if this < next {
            total.checked_sub(this)
        } else {
            total.checked_add(this)
        }
        .ok_or(LevelTooLarge)?;
    }
    u32::try_from(total).map(Some).map_err(|_| LevelTooLarge)
}

/// `Number(digits)` for a `\d+` capture, as a seat, size or level; `None`
/// beyond `u32`.
pub fn number_u32(digits: &str) -> Option<u32> {
    JsNumber::parse(digits)
        .to_i64()
        .and_then(|n| u32::try_from(n).ok())
}

/// The error a parser returns for a seat, table size or button the TypeScript
/// keeps as a JavaScript number and a PHF cannot hold (`parser-error`).
pub fn unrepresentable(what: &str) -> JsError {
    JsError::new(format!(
        "{what} is beyond what a PHF hand can hold (u32); the TypeScript keeps it as a \
         JavaScript number"
    ))
}

/* ------------------------------------------------- line helpers (per site) */
//
// `pokerstars.ts`, `ggpoker.ts` and `p3-stars-dialect.ts` each carry their own
// identical copy of these; one copy serves all three here.

/// `RUN_PREFIXES`.
pub(crate) const RUN_PREFIXES: [&str; 4] = ["FIRST", "SECOND", "THIRD", "FOURTH"];
static WHITESPACE_RUN: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+", "g");
static GROUP: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");

/// `runoutIndexForLabel`.
pub(crate) fn runout_index_for_label(label: &str) -> u32 {
    if label.is_empty() {
        return 0;
    }
    let upper = js::to_upper_case(label);
    (0_u32..)
        .zip(RUN_PREFIXES)
        .find(|(_, prefix)| *prefix == upper)
        .map_or(0, |(index, _)| index)
}

/// `seat`/`size` digits as a `u32`, or the parser error the TypeScript has no
/// equivalent of (see `unrepresentable`).
pub(crate) fn u32_or_bug(digits: &str, what: &str) -> Result<u32, ParseError> {
    number_u32(digits).ok_or_else(|| ParseError::Bug(unrepresentable(what).message))
}

pub(crate) fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

pub(crate) fn line_number(index: usize) -> Option<u32> {
    u32::try_from(index + 1).ok()
}

/// `marker[2].replace(/\s+/g, "").toUpperCase()` to a marker kind.
pub(crate) fn marker_kind(word: &str) -> MarkerKind {
    let kind = js::to_upper_case(&WHITESPACE_RUN.replace_all(word, ""));
    match kind.as_str() {
        "SHOWDOWN" => MarkerKind::Showdown,
        "FLOP" => MarkerKind::Flop,
        "TURN" => MarkerKind::Turn,
        _ => MarkerKind::River,
    }
}

/// The last `[...]` group of a marker's tail, as cards.
pub(crate) fn last_bracket_cards(tail: &str) -> Vec<String> {
    GROUP
        .captures_iter(tail)
        .last()
        .map(|c| extract_cards(&c[1]))
        .unwrap_or_default()
}

/// The `unseated-actor` refusal.
pub(crate) fn unseated(player: &str) -> ParseError {
    skip(
        SkipReason::UnseatedActor,
        format!("\"{player}\" acts but is not in the seat block."),
    )
}

/* ------------------------------------------------------- summary seat lines */

static SUMMARY_SEAT_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat\s+\d+:\s*", "");
static POSITION_LABEL: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\((button|small blind|big blind)\)\s*", "i");
static SHOWN: LazyLock<Regex> = crate::js_regex_lazy!(r"(?:showed|mucked)\s+\[([^\]]*)\]", "i");
static CASHOUT_RISK: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"Cashout Risk \(${MONEY}\)", "", ""));
static FOLDED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^folded\s+(?:before Flop|on the (Flop|Turn|River))", "i");
static DIDNT_BET: LazyLock<Regex> = crate::js_regex_lazy!(r"\(didn't bet\)", "i");
static MUCKED: LazyLock<Regex> = crate::js_regex_lazy!(r"^mucked\b", "i");
static WON: LazyLock<Regex> =
    LazyLock::new(|| template_regex(r"(?:won|collected)\s+\(${MONEY}\)", "", ""));
static DESCRIPTION: LazyLock<Regex> = crate::js_regex_lazy!(
    r"\bwith\s+(.+?)(?:,\s+(?:and\s+)?(?:won|lost|Cashout Risk)\b.*)?$",
    "i"
);
static TRAILING_COMMA: LazyLock<Regex> = crate::js_regex_lazy!(r",\s*$", "");
static SHOWED: LazyLock<Regex> = crate::js_regex_lazy!(r"^showed\b", "i");
static COLLECTED_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"\bcollected\b", "i");

/// What `parseSummarySeat` reads off one SUMMARY seat line (the TypeScript's
/// `Partial<PhfPlayerResult>`, of which it always sets these fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummarySeat {
    pub position_labels: Vec<String>,
    pub raw: String,
    pub outcome: SeatOutcome,
    pub folded_street: Option<Street>,
    pub didnt_bet: bool,
    pub shown_cards: Vec<String>,
    pub hand_description: Option<String>,
    pub mucked: bool,
    pub cashout_risk: Option<Amount>,
}

/// `parseSummarySeat(raw, playerName, unit)`: one SUMMARY `Seat N: ...` line.
/// The prose is the same across the family; what it cannot classify stays on
/// `raw`.
pub fn parse_summary_seat(raw: &str, player_name: &str, unit: &CurrencyUnit) -> SummarySeat {
    let trimmed = js::trim(raw);
    let mut rest: &str = match SUMMARY_SEAT_PREFIX.find(trimmed) {
        Some(m) => &trimmed[m.end()..],
        None => trimmed,
    };
    if let Some(after) = rest.strip_prefix(player_name) {
        rest = after;
    }
    // `rest.replace(/^\s+/, "")`.
    rest = js::trim_start(rest);

    let mut position_labels = Vec::new();
    while let Some(c) = POSITION_LABEL.captures(rest) {
        position_labels.push(format!("({})", &c[1]));
        let consumed = c.get(0).map_or(0, |m| m.end());
        rest = &rest[consumed..];
    }

    let mut out = SummarySeat {
        position_labels,
        raw: raw.to_owned(),
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
    // GG only: the EV-cashout premium the seat paid, reported outside the pot.
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
        out.hand_description = Some(TRAILING_COMMA.replacen(&c[1], 1, "").into_owned());
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

/* --------------------------------------------------------------- the draft */

/// `DraftGame`: what a header says about the game.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftGame {
    pub variant: Variant,
    pub limit: LimitType,
    pub format: GameFormat,
    pub label: String,
    pub unit: CurrencyUnit,
    pub small_blind: Amount,
    pub big_blind: Amount,
}

/// `DraftInit`: provenance and header facts the draft stamps on the hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftInit {
    pub site_id: String,
    pub site_name: String,
    pub parser_id: String,
    pub parser_version: String,
    pub hand_id: String,
    /// Stable dedupe key; usually the site id prefixed so ids cannot collide.
    pub hand_key: String,
    pub raw_text: String,
    pub original_filename: Option<String>,
    pub game: DraftGame,
    pub tournament: Option<PhfTournament>,
    pub played_at: Option<String>,
    pub text_style: PhfTextStyle,
    /// Rebuild an `Uncalled bet (x) returned to y` line the source omitted;
    /// opted into per site (see [`StarsHandDraft::build`]).
    pub repair_missing_uncalled: bool,
    /// Rust only: what `meta.parsedAt` is stamped with (the TypeScript reads
    /// the clock; `SiteParserContext::parsed_at`).
    pub parsed_at: String,
}

/// `MarkerKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarkerKind {
    Flop,
    Turn,
    River,
    Showdown,
}

/// The options object of `post`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PostOptions<'a> {
    pub all_in: bool,
    pub verb: Option<&'a str>,
    pub line: Option<u32>,
    pub raw_line: &'a str,
}

/// Why [`StarsHandDraft::build`] produced no hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildError {
    /// The TypeScript threw (`assignHiLoHalves` on a card the evaluator
    /// cannot read): the parser's `parser-error`.
    Thrown(JsError),
    /// A straddler has no seat line. The TypeScript writes `seat: -1`, which
    /// a PHF cannot hold; every TypeScript caller then refuses the hand as
    /// `unseated-actor` (see the module docs).
    UnseatedStraddler,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RunoutDraft {
    flop: Option<Vec<String>>,
    turn: Option<String>,
    river: Option<String>,
}

/// `StarsHandDraft`: accumulates one hand from *semantic* events and resolves,
/// at [`build`](Self::build), everything only the whole hand tells: the
/// board, contributions, the results block.
///
/// Players are kept by index where the TypeScript shares the object between
/// `players` and `byName`; `Map`s whose order shows are insertion-ordered
/// vectors.
#[derive(Debug, Clone)]
pub struct StarsHandDraft {
    /// `readonly warnings`: becomes `meta.warnings`. Warnings pushed after
    /// `build` do not reach the built hand here (in the TypeScript the array
    /// is shared); push those onto the hand.
    pub warnings: Vec<PhfWarning>,

    init: DraftInit,
    players: Vec<PhfPlayer>,
    by_name: HashMap<String, usize>,
    actions: Vec<PhfAction>,
    runouts: Vec<RunoutDraft>,
    marker_labels: Vec<PhfMarkerLabels>,
    summary_boards: Vec<(u32, Vec<String>)>,
    summary_seat_lines: Vec<(u32, String)>,
    collected_by: Vec<(String, Amount)>,
    folded: HashSet<String>,
    straddles: Vec<(String, Amount)>,
    movements: Vec<PhfChipMovement>,
    showdown_labels: Vec<String>,
    pots: Vec<PhfPot>,

    street_commit: HashMap<String, Amount>,
    street: Street,
    runout_index: u32,
    table_name: Option<String>,
    max_seats: u32,
    button_seat: Option<u32>,
    fast_fold: Option<String>,
    hero_name: Option<String>,
    total_pot: Amount,
    saw_summary_pot: bool,
    fees: PhfFees,
    ante_max: Amount,
    ante_posters: u32,
    saw_showdown_marker: bool,
    saw_hole_cards_marker: bool,
    dealt_line_count: u32,
    run_it_twice_note: bool,
    small_blind_posted: Amount,
    big_blind_posted: Amount,
    /// What `set_table_numbers` could not hold as a `u32` (`"a table size"`,
    /// `"a button seat"`); `build` fails with the parser error while it is
    /// set. A later `set_table` replaces it, as a later `setTable` replaces
    /// the JavaScript number.
    table_unrepresentable: Option<&'static str>,
}

/// `map.get(key) ?? 0` over an insertion-ordered map.
fn get_or_zero(map: &[(String, Amount)], key: &str) -> Amount {
    map.iter().find(|(k, _)| k == key).map_or(0, |(_, v)| *v)
}

/// `[...map.values()].reduce((sum, value) => sum + value, 0)`.
fn sum_values(map: &[(String, Amount)]) -> Amount {
    map.iter()
        .fold(0, |sum: Amount, (_, v)| sum.saturating_add(*v))
}

impl StarsHandDraft {
    pub fn new(init: DraftInit) -> Self {
        Self {
            warnings: Vec::new(),
            init,
            players: Vec::new(),
            by_name: HashMap::new(),
            actions: Vec::new(),
            runouts: vec![RunoutDraft::default()],
            marker_labels: vec![PhfMarkerLabels::default()],
            summary_boards: Vec::new(),
            summary_seat_lines: Vec::new(),
            collected_by: Vec::new(),
            folded: HashSet::new(),
            straddles: Vec::new(),
            movements: Vec::new(),
            showdown_labels: Vec::new(),
            pots: Vec::new(),
            street_commit: HashMap::new(),
            street: Street::Preflop,
            runout_index: 0,
            table_name: None,
            max_seats: 0,
            button_seat: None,
            fast_fold: None,
            hero_name: None,
            total_pot: 0,
            saw_summary_pot: false,
            fees: PhfFees::ZERO,
            ante_max: 0,
            ante_posters: 0,
            saw_showdown_marker: false,
            saw_hole_cards_marker: false,
            dealt_line_count: 0,
            run_it_twice_note: false,
            small_blind_posted: 0,
            big_blind_posted: 0,
            table_unrepresentable: None,
        }
    }

    /// `get unit()`.
    pub fn unit(&self) -> &CurrencyUnit {
        &self.init.game.unit
    }

    /// `seatedNames()`: every seated name.
    pub fn seated_names(&self) -> HashSet<String> {
        self.by_name.keys().cloned().collect()
    }

    /// `isSeated(name)`.
    pub fn is_seated(&self, name: &str) -> bool {
        self.by_name.contains_key(name)
    }

    /// `currentStreet()`.
    pub fn current_street(&self) -> Street {
        self.street
    }

    /// `warn(code, message, line?)`.
    pub fn warn(&mut self, code: &str, message: impl Into<String>, line: Option<u32>) {
        self.warnings.push(PhfWarning {
            code: code.to_owned(),
            message: message.into(),
            line,
        });
    }

    /* ------------------------------------------------------------- structure */

    /// `setTable(name, maxSeats, buttonSeat, fastFold = null)`.
    pub fn set_table(
        &mut self,
        name: Option<String>,
        max_seats: u32,
        button_seat: Option<u32>,
        fast_fold: Option<String>,
    ) {
        self.table_name = name;
        self.max_seats = max_seats;
        self.button_seat = button_seat;
        self.fast_fold = fast_fold;
        self.table_unrepresentable = None;
    }

    /// `setTable(name, maxSeats, buttonSeat, fastFold)` with the size and the
    /// button as the JavaScript numbers the TypeScript passes. A value beyond
    /// `u32` is held back (the size as 0, the button as `None`) and makes
    /// [`build`](Self::build) return the parser error - the TypeScript's hand
    /// would hold a number no PHF can - unless a later `set_table` replaces
    /// it, as PokerBros does with a button on an empty seat.
    pub fn set_table_numbers(
        &mut self,
        name: Option<String>,
        max_seats: JsNumber,
        button_seat: Option<JsNumber>,
        fast_fold: Option<String>,
    ) {
        let as_u32 = |n: JsNumber| n.to_i64().and_then(|n| u32::try_from(n).ok());
        let size = as_u32(max_seats);
        let button = button_seat.map(as_u32);
        self.set_table(name, size.unwrap_or(0), button.flatten(), fast_fold);
        if size.is_none() {
            self.table_unrepresentable = Some("a table size");
        } else if button.is_some_and(|button| button.is_none()) {
            self.table_unrepresentable = Some("a button seat");
        }
    }

    /// `seat(seat, name, stack, sittingOut = false)`; a name listed twice is
    /// a `duplicate-seat-line` warning and the second line is dropped.
    pub fn seat(&mut self, seat: u32, name: &str, stack: Amount, sitting_out: bool) {
        if self.by_name.contains_key(name) {
            self.warn(
                "duplicate-seat-line",
                format!("{name} is listed twice in the seat block."),
                None,
            );
            return;
        }
        self.players.push(PhfPlayer {
            seat,
            name: name.to_owned(),
            starting_stack: stack,
            is_hero: false,
            hole_cards: Vec::new(),
            bounty: None,
            sitting_out,
            position: None,
            dealt_announced: false,
            dealt_cards: Vec::new(),
        });
        self.by_name.insert(name.to_owned(), self.players.len() - 1);
    }

    fn player_mut(&mut self, name: &str) -> Option<&mut PhfPlayer> {
        let index = *self.by_name.get(name)?;
        self.players.get_mut(index)
    }

    /// `markSittingOut(name)`.
    pub fn mark_sitting_out(&mut self, name: &str) {
        if let Some(player) = self.player_mut(name) {
            player.sitting_out = true;
        }
    }

    /// `setBounty(name, amount)`: adds to the player's bounty.
    pub fn set_bounty(&mut self, name: &str, amount: Amount) {
        if let Some(player) = self.player_mut(name) {
            player.bounty = Some(player.bounty.unwrap_or(0).saturating_add(amount));
        }
    }

    /// `holeCardsMarker()`: the source printed `*** HOLE CARDS ***`.
    pub fn hole_cards_marker(&mut self) {
        self.saw_hole_cards_marker = true;
    }

    /// `dealt(name, cards)`: a `Dealt to <name> [cards]` line; empty cards
    /// mean "dealt in, cards not shown" (GG). The first seat dealt face-up
    /// cards is the hero.
    pub fn dealt(&mut self, name: &str, cards: Vec<String>) {
        self.dealt_line_count += 1;
        let Some(&index) = self.by_name.get(name) else {
            self.warn(
                "dealt-to-unseated",
                format!("Cards were dealt to {name}, who is not seated."),
                None,
            );
            return;
        };
        let has_cards = !cards.is_empty();
        let make_hero = has_cards && self.hero_name.is_none();
        let player = &mut self.players[index];
        player.dealt_announced = true;
        player.dealt_cards.clone_from(&cards);
        if has_cards {
            player.hole_cards = cards;
            if make_hero {
                player.is_hero = true;
            }
        }
        if make_hero {
            self.hero_name = Some(name.to_owned());
        }
    }

    /// `setHero(name)`: forces the hero (rooms that name the observer `Hero`).
    pub fn set_hero(&mut self, name: &str) {
        let Some(&index) = self.by_name.get(name) else {
            return;
        };
        for (i, player) in self.players.iter_mut().enumerate() {
            player.is_hero = i == index;
        }
        self.hero_name = Some(name.to_owned());
    }

    /* ------------------------------------------------------------- the board */

    /// `marker(kind, runoutIndex, label, cards)`: a `*** [FIRST|SECOND]
    /// FLOP|TURN|RIVER|SHOWDOWN ***` line. `label` is the printed prefix
    /// (`""`, `FIRST`, ...), kept for faithful re-serialization.
    pub fn marker(&mut self, kind: MarkerKind, runout_index: u32, label: &str, cards: &[String]) {
        let index = usize::try_from(runout_index).unwrap_or(usize::MAX);
        while self.runouts.len() <= index {
            self.runouts.push(RunoutDraft::default());
            self.marker_labels.push(PhfMarkerLabels::default());
        }
        self.runout_index = runout_index;
        let label = js::to_upper_case(label);
        if kind == MarkerKind::Showdown {
            self.saw_showdown_marker = true;
            self.showdown_labels.push(label);
            self.street = Street::Showdown;
            return;
        }
        let last = cards.last().cloned();
        match kind {
            MarkerKind::Flop => {
                self.runouts[index].flop = Some(cards.iter().take(3).cloned().collect());
                self.marker_labels[index].flop = Some(label);
                self.street = Street::Flop;
            }
            MarkerKind::Turn => {
                self.runouts[index].turn = last;
                self.marker_labels[index].turn = Some(label);
                self.street = Street::Turn;
            }
            MarkerKind::River | MarkerKind::Showdown => {
                self.runouts[index].river = last;
                self.marker_labels[index].river = Some(label);
                self.street = Street::River;
            }
        }
        // A new street resets what everybody has committed to the current bet.
        self.street_commit = HashMap::new();
    }

    /// `marker("showdown", runoutIndex, label, cards)` with a runout index no
    /// `u32` holds: Full Tilt's `*** SHOW DOWN 0 ***` is `Number("0") - 1`.
    /// The TypeScript extends no runout (`while (length <= -1)` never runs)
    /// and tags every action that follows with -1; here they carry
    /// `stand_in`, an index the caller keeps clear of every real runout and
    /// finds on the built hand. Nothing else differs from `marker`'s
    /// showdown branch.
    pub fn showdown_marker_at(&mut self, stand_in: u32, label: &str) {
        self.runout_index = stand_in;
        self.saw_showdown_marker = true;
        self.showdown_labels.push(js::to_upper_case(label));
        self.street = Street::Showdown;
    }

    /* ----------------------------------------------------------- the actions */

    fn seat_of(&self, name: &str) -> Option<u32> {
        self.by_name
            .get(name)
            .map(|&index| self.players[index].seat)
    }

    fn commit(&mut self, name: &str, delta: Amount) -> Amount {
        let next = self.committed(name).saturating_add(delta);
        self.street_commit.insert(name.to_owned(), next);
        next
    }

    /// `committed(name)`: what the actor has put in on the current street.
    pub fn committed(&self, name: &str) -> Amount {
        self.street_commit.get(name).copied().unwrap_or(0)
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        street: Street,
        name: &str,
        kind: ActionType,
        amount: Amount,
        street_total: Amount,
        all_in: bool,
        label: String,
        line: Option<u32>,
        raw_line: &str,
    ) -> &mut PhfAction {
        let index = u32::try_from(self.actions.len()).unwrap_or(u32::MAX);
        self.actions.push(PhfAction {
            index,
            street,
            runout_index: self.runout_index,
            seat: self.seat_of(name),
            player: name.to_owned(),
            kind,
            amount,
            street_total,
            all_in,
            cards: None,
            description: None,
            verb: None,
            pot_name: None,
            half: None,
            label,
            source_line: line,
            raw_line: raw_line.to_owned(),
        });
        let last = self.actions.len() - 1;
        &mut self.actions[last]
    }

    /// `this.money(amount)`: `formatAmount(Math.abs(amount), unit, decimals)`.
    fn money(&self, amount: Amount) -> String {
        format_amount(
            amount.saturating_abs(),
            &self.init.game.unit,
            self.init.text_style.decimals,
            false,
        )
    }

    /// `post(name, type, amount, options)`: antes, blinds, straddles, dead
    /// posts. Antes and missed blinds are dead money and never touch the
    /// street commitment.
    pub fn post(&mut self, name: &str, kind: ActionType, amount: Amount, options: PostOptions<'_>) {
        if matches!(kind, ActionType::Ante | ActionType::BombAnte) {
            self.ante_max = self.ante_max.max(amount);
            self.ante_posters += 1;
        }
        if kind == ActionType::SmallBlind {
            self.small_blind_posted = self.small_blind_posted.max(amount);
        }
        if kind == ActionType::BigBlind {
            self.big_blind_posted = self.big_blind_posted.max(amount);
        }
        let dead = matches!(
            kind,
            ActionType::Ante | ActionType::MissedBlind | ActionType::BombAnte
        );
        let street_total = if dead { 0 } else { self.commit(name, amount) };
        if kind == ActionType::Straddle {
            // The straddle's size: for a seat that already had money in, its
            // total rather than the chips this line added.
            self.straddles.push((name.to_owned(), street_total));
        }
        let label = if options.verb == Some(BUTTON_BLIND_VERB) {
            format!("button blind {}", self.money(amount))
        } else {
            format!(
                "{} {}",
                kind.as_str().replacen('-', " ", 1),
                self.money(if kind == ActionType::Straddle {
                    street_total
                } else {
                    amount
                })
            )
        };
        let action = self.push(
            Street::Preflop,
            name,
            kind,
            amount,
            street_total,
            options.all_in,
            label,
            options.line,
            options.raw_line,
        );
        action.verb = options.verb.map(str::to_owned);
    }

    /// `simple(name, "fold" | "check", options)`. Cards on a fold are a
    /// reveal (`folds [Ks]`), recorded on the action and, if it has none yet,
    /// the player - not a showdown.
    pub fn simple(
        &mut self,
        name: &str,
        kind: ActionType,
        cards: Vec<String>,
        line: Option<u32>,
        raw_line: &str,
    ) {
        if kind == ActionType::Fold {
            self.folded.insert(name.to_owned());
        }
        if !cards.is_empty()
            && let Some(player) = self.player_mut(name)
            && player.hole_cards.is_empty()
        {
            player.hole_cards.clone_from(&cards);
        }
        let label = if !cards.is_empty() {
            format!("folds {}", cards.join(" "))
        } else if kind == ActionType::Fold {
            "folds".to_owned()
        } else {
            "checks".to_owned()
        };
        let street = self.street;
        let street_total = self.committed(name);
        let action = self.push(
            street,
            name,
            kind,
            0,
            street_total,
            false,
            label,
            line,
            raw_line,
        );
        action.cards = (!cards.is_empty()).then_some(cards);
    }

    /// `wager(name, "call" | "bet", amount, options)`.
    pub fn wager(
        &mut self,
        name: &str,
        kind: ActionType,
        amount: Amount,
        all_in: bool,
        line: Option<u32>,
        raw_line: &str,
    ) {
        let street = self.street;
        let street_total = self.commit(name, amount);
        let label = format!(
            "{} {}",
            if kind == ActionType::Call {
                "calls"
            } else {
                "bets"
            },
            self.money(amount)
        );
        self.push(
            street,
            name,
            kind,
            amount,
            street_total,
            all_in,
            label,
            line,
            raw_line,
        );
    }

    /// `raiseTo(name, to, options)`: only the total is stored; the increment
    /// is derived from the street's betting when serialized.
    pub fn raise_to(
        &mut self,
        name: &str,
        to: Amount,
        all_in: bool,
        line: Option<u32>,
        raw_line: &str,
    ) {
        let already = self.committed(name);
        self.street_commit.insert(name.to_owned(), to);
        let street = self.street;
        let label = format!("raises to {}", self.money(to));
        self.push(
            street,
            name,
            ActionType::Raise,
            to.saturating_sub(already),
            to,
            all_in,
            label,
            line,
            raw_line,
        );
    }

    /// `uncalled(name, amount, options)`: stored negative.
    pub fn uncalled(&mut self, name: &str, amount: Amount, line: Option<u32>, raw_line: &str) {
        let street = self.street;
        let street_total = self.commit(name, amount.saturating_neg());
        let label = format!("uncalled {} returned", self.money(amount));
        self.push(
            street,
            name,
            ActionType::Uncalled,
            amount.saturating_neg(),
            street_total,
            false,
            label,
            line,
            raw_line,
        );
    }

    /// `collect(name, amount, potName, options)`.
    pub fn collect(
        &mut self,
        name: &str,
        amount: Amount,
        pot_name: &str,
        line: Option<u32>,
        raw_line: &str,
    ) {
        let total = get_or_zero(&self.collected_by, name).saturating_add(amount);
        map_set(&mut self.collected_by, name.to_owned(), total);
        let label = format!("wins {}", self.money(amount));
        let action = self.push(
            Street::Showdown,
            name,
            ActionType::Collect,
            amount,
            0,
            false,
            label,
            line,
            raw_line,
        );
        action.pot_name = Some(pot_name.to_owned());
    }

    /// `show(name, cards, description, options)`. The action always carries
    /// `cards`, even an empty list.
    pub fn show(
        &mut self,
        name: &str,
        cards: Vec<String>,
        description: Option<&str>,
        line: Option<u32>,
        raw_line: &str,
    ) {
        if !cards.is_empty()
            && let Some(player) = self.player_mut(name)
        {
            player.hole_cards.clone_from(&cards);
        }
        let label = if cards.is_empty() {
            "shows".to_owned()
        } else {
            format!("shows {}", cards.join(" "))
        };
        let street = self.street;
        let action = self.push(
            street,
            name,
            ActionType::Show,
            0,
            0,
            false,
            label,
            line,
            raw_line,
        );
        action.cards = Some(cards);
        action.description = description.map(str::to_owned);
    }

    /// `muck(name, verb, options)`.
    pub fn muck(&mut self, name: &str, verb: &str, line: Option<u32>, raw_line: &str) {
        let street = self.street;
        let action = self.push(
            street,
            name,
            ActionType::Muck,
            0,
            0,
            false,
            "mucks".to_owned(),
            line,
            raw_line,
        );
        action.description = Some(verb.to_owned());
    }

    /// `cashout(name, "cashout-choose" | "cashout-pay", risk, options)`: GG
    /// EV-cashout events, settled outside the pot (amount 0).
    pub fn cashout(
        &mut self,
        name: &str,
        kind: ActionType,
        risk: Amount,
        line: Option<u32>,
        raw_line: &str,
    ) {
        let label = if kind == ActionType::CashoutChoose {
            "chooses EV cashout".to_owned()
        } else {
            format!("pays cashout risk {}", self.money(risk))
        };
        let description = (kind == ActionType::CashoutPay).then(|| self.money(risk));
        let street = self.street;
        let action = self.push(street, name, kind, 0, 0, false, label, line, raw_line);
        action.description = description;
    }

    /* ------------------------------------------------------------- summary -- */

    /// `chipMovement(movement)`: promotional money that is not a bet;
    /// `fromPlayer` is filled from `fromSeat` (ignored on the way in).
    pub fn chip_movement(&mut self, movement: PhfChipMovement) {
        let from_player = movement.from_seat.and_then(|seat| {
            self.players
                .iter()
                .find(|player| player.seat == seat)
                .map(|player| player.name.clone())
        });
        self.movements.push(PhfChipMovement {
            from_player,
            ..movement
        });
    }

    /// `summaryPot(totalPot, pots, fees)`.
    pub fn summary_pot(&mut self, total_pot: Amount, pots: Vec<PhfPot>, fees: PhfFees) {
        self.total_pot = total_pot;
        self.saw_summary_pot = true;
        self.pots.extend(pots);
        self.fees = fees;
    }

    /// `summaryBoard(runoutIndex, cards)`.
    pub fn summary_board(&mut self, runout_index: u32, cards: Vec<String>) {
        map_set(&mut self.summary_boards, runout_index, cards);
    }

    /// `summarySeat(seat, rawLine)`.
    pub fn summary_seat(&mut self, seat: u32, raw_line: &str) {
        map_set(&mut self.summary_seat_lines, seat, raw_line.to_owned());
    }

    /// `noteRunItTwice()`.
    pub fn note_run_it_twice(&mut self) {
        self.run_it_twice_note = true;
    }

    /* --------------------------------------------------------------- build -- */

    /// `playerCount()`.
    pub fn player_count(&self) -> usize {
        self.players.len()
    }

    /// `actionCount()`.
    pub fn action_count(&self) -> usize {
        self.actions.len()
    }

    /// `hasInvalidCard()`: the first hole card `parseCard` cannot read.
    pub fn has_invalid_card(&self) -> Option<&str> {
        self.players
            .iter()
            .flat_map(|player| &player.hole_cards)
            .find(|card| parse_card(card).is_none())
            .map(String::as_str)
    }

    /// The first actor (in action order) with no seat line: who the
    /// `unseated-actor` refusal of the site parsers names.
    pub fn first_unseated_actor(&self) -> Option<&str> {
        self.actions
            .iter()
            .find(|action| !self.by_name.contains_key(&action.player))
            .map(|action| action.player.as_str())
    }

    /// `reconstructUncalled(shortfall)`: inserts the `Uncalled bet` line two
    /// 2011 PokerStars exports dropped, only when the shortfall is exactly
    /// the last betting street's single top commitment over the next one.
    fn reconstruct_uncalled(&mut self, shortfall: Amount) -> bool {
        let is_wager = |kind: ActionType| {
            matches!(
                kind,
                ActionType::SmallBlind
                    | ActionType::BigBlind
                    | ActionType::Straddle
                    | ActionType::Post
                    | ActionType::Call
                    | ActionType::Bet
                    | ActionType::Raise
                    | ActionType::Uncalled
            )
        };
        // Groups of consecutive actions with one `street:runoutIndex` key; a
        // key change starts a new group even on a non-wager action.
        let mut groups: Vec<Vec<(String, Amount)>> = Vec::new();
        let mut key: Option<(Street, u32)> = None;
        let mut last_group: Option<usize> = None;
        let mut last_key: Option<(Street, u32)> = None;
        let mut last_index: Option<usize> = None;
        for (i, action) in self.actions.iter().enumerate() {
            let action_key = (action.street, action.runout_index);
            if key != Some(action_key) {
                key = Some(action_key);
                groups.push(Vec::new());
            }
            if !is_wager(action.kind) {
                continue;
            }
            let current = groups.len() - 1;
            let group = &mut groups[current];
            let total = get_or_zero(group, &action.player).saturating_add(action.amount);
            map_set(group, action.player.clone(), total);
            last_key = key;
            last_group = Some(current);
            last_index = Some(i);
        }
        let (Some(last_index), Some(last_group)) = (last_index, last_group) else {
            return false;
        };
        // The return belongs at the end of that street, before the showdown.
        let mut group_end = last_index;
        for i in last_index + 1..self.actions.len() {
            if Some((self.actions[i].street, self.actions[i].runout_index)) != last_key {
                break;
            }
            group_end = i;
        }

        let mut sorted = groups[last_group].clone();
        // `sort((a, b) => b[1] - a[1])`, stable.
        sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        let Some((top_player, top_amount)) = sorted.first().cloned() else {
            return false;
        };
        let second = sorted.get(1).map_or(0, |entry| entry.1);
        if top_amount.saturating_sub(second) != shortfall
            || sorted.get(1).is_some_and(|entry| entry.1 == top_amount)
        {
            return false;
        }

        let template = &self.actions[group_end];
        let money = self.money(shortfall);
        let inserted = PhfAction {
            index: 0,
            street: template.street,
            runout_index: template.runout_index,
            seat: self.seat_of(&top_player),
            player: top_player.clone(),
            kind: ActionType::Uncalled,
            amount: shortfall.saturating_neg(),
            street_total: top_amount.saturating_sub(shortfall),
            all_in: false,
            cards: None,
            description: None,
            verb: None,
            pot_name: None,
            half: None,
            label: format!("uncalled {money} returned"),
            source_line: None,
            raw_line: format!("Uncalled bet ({money}) returned to {top_player}"),
        };
        self.actions.insert(group_end + 1, inserted);
        for (index, action) in (0_u32..).zip(self.actions.iter_mut()) {
            action.index = index;
        }
        self.warn(
            "uncalled-return-reconstructed",
            format!(
                "The source omitted the uncalled return of {money} to {top_player}; it was \
                 rebuilt from the reported pot."
            ),
            None,
        );
        true
    }

    /// `tally()`: every non-collect, non-zero action amount, per player, in
    /// first-seen order.
    fn tally(&self) -> Vec<(String, Amount)> {
        let mut out: Vec<(String, Amount)> = Vec::new();
        for action in &self.actions {
            if action.kind == ActionType::Collect || action.amount == 0 {
                continue;
            }
            let total = get_or_zero(&out, &action.player).saturating_add(action.amount);
            map_set(&mut out, action.player.clone(), total);
        }
        out
    }

    /// `build()`: the hand. Positions are left `None` - `assignPositions` in
    /// the pipeline is the authority. For a hi/lo game the halves are
    /// assigned as `parseStandardHand` does, so the room's hand and its
    /// standard text agree.
    pub fn build(&mut self) -> Result<PhfHand, BuildError> {
        let hand = self.build_hand()?;
        // The TypeScript builds this hand; its table size or button is a
        // number no PHF holds (see `set_table_numbers`).
        match self.table_unrepresentable {
            Some(what) => Err(BuildError::Thrown(unrepresentable(what))),
            None => Ok(hand),
        }
    }

    #[allow(clippy::too_many_lines)]
    fn build_hand(&mut self) -> Result<PhfHand, BuildError> {
        let unit = self.init.game.unit.clone();

        if self.max_seats == 0 {
            let players = u32::try_from(self.players.len()).unwrap_or(u32::MAX);
            self.max_seats = self
                .players
                .iter()
                .map(|player| player.seat)
                .fold(players, u32::max);
        }

        // The summary can reveal cards no `shows` line did (`mucked [Td 7d]`).
        for (seat, line) in &self.summary_seat_lines {
            let Some(player) = self.players.iter_mut().find(|p| p.seat == *seat) else {
                continue;
            };
            if !player.hole_cards.is_empty() {
                continue;
            }
            if let Some(c) = SHOWN.captures(line) {
                player.hole_cards = extract_cards(&c[1]);
            }
        }

        let summary_board = |index: u32| -> Option<Vec<String>> {
            self.summary_boards
                .iter()
                .find(|(key, _)| *key == index)
                .map(|(_, cards)| cards.clone())
        };
        let mut board = PhfBoard {
            runouts: (0_u32..)
                .zip(&self.runouts)
                .map(|(index, run)| PhfRunout {
                    index,
                    flop: run.flop.clone(),
                    turn: run.turn.clone(),
                    river: run.river.clone(),
                    marker_labels: self
                        .marker_labels
                        .get(usize::try_from(index).unwrap_or(usize::MAX))
                        .cloned()
                        .unwrap_or_default(),
                    summary_cards: summary_board(index),
                })
                .collect(),
        };
        // A hand that ends before a marker can still carry a SUMMARY board.
        let mut board_from_summary = false;
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
                board_from_summary = true;
            }
        }
        if board_from_summary {
            self.warn(
                "board-from-summary",
                "Board taken from the SUMMARY line.",
                None,
            );
        }

        let mut contributions = self.tally();
        let mut put_in = sum_values(&contributions);
        if self.init.repair_missing_uncalled
            && self.saw_summary_pot
            && put_in.saturating_sub(self.total_pot) > 0
            && self.reconstruct_uncalled(put_in.saturating_sub(self.total_pot))
        {
            contributions = self.tally();
            put_in = sum_values(&contributions);
        }
        let taken_out = sum_values(&self.collected_by);

        // House money in the pot came from no seat.
        let from_house = self
            .movements
            .iter()
            .filter(|movement| movement.to_pot && movement.from_seat.is_none())
            .fold(0, |sum: Amount, movement| {
                sum.saturating_add(movement.amount)
            });

        if !self.saw_summary_pot {
            // No SUMMARY block (a truncated export): the pot is what went in,
            // and what the winners did not get back is the rake.
            self.total_pot = put_in.saturating_add(from_house);
            if taken_out > 0 && self.total_pot.saturating_sub(taken_out) > 0 {
                self.fees = PhfFees {
                    rake: self.total_pot.saturating_sub(taken_out),
                    ..self.fees
                };
                self.warn(
                    "rake-inferred",
                    "The hand has no SUMMARY block; the rake was derived from pot minus collected.",
                    None,
                );
            } else {
                self.warn("no-summary", "The hand has no SUMMARY block.", None);
            }
        } else if self.total_pot == 0 {
            self.total_pot = put_in.saturating_add(from_house);
        }

        let shown_at_showdown: HashSet<&str> = self
            .actions
            .iter()
            .filter(|action| action.kind == ActionType::Show)
            .map(|action| action.player.as_str())
            .collect();
        // Cards a player exposed anywhere in the stream (`folds [Ks]` never
        // reaches the summary); the last one per player wins.
        let mut revealed_in_stream: HashMap<&str, &Vec<String>> = HashMap::new();
        for action in &self.actions {
            if let Some(cards) = &action.cards
                && !cards.is_empty()
            {
                revealed_in_stream.insert(action.player.as_str(), cards);
            }
        }

        let player_results: Vec<PhfPlayerResult> = self
            .players
            .iter()
            .map(|player| {
                let summary_line = self
                    .summary_seat_lines
                    .iter()
                    .find(|(seat, _)| *seat == player.seat)
                    .map(|(_, line)| line.clone());
                let parsed = summary_line
                    .as_deref()
                    .map(|line| parse_summary_seat(line, &player.name, &unit));
                let won = get_or_zero(&self.collected_by, &player.name);
                let contributed = get_or_zero(&contributions, &player.name);
                let revealed = || {
                    revealed_in_stream
                        .get(player.name.as_str())
                        .map(|cards| (*cards).clone())
                        .unwrap_or_default()
                };
                PhfPlayerResult {
                    seat: player.seat,
                    player: player.name.clone(),
                    won,
                    contributed,
                    net: won.saturating_sub(contributed),
                    went_to_showdown: shown_at_showdown.contains(player.name.as_str())
                        || parsed
                            .as_ref()
                            .is_some_and(|p| p.outcome == SeatOutcome::Showed),
                    shown_cards: match &parsed {
                        Some(p) if !p.shown_cards.is_empty() => p.shown_cards.clone(),
                        _ => revealed(),
                    },
                    mucked: parsed.as_ref().is_some_and(|p| p.mucked),
                    hand_description: parsed.as_ref().and_then(|p| p.hand_description.clone()),
                    position_labels: parsed
                        .as_ref()
                        .map(|p| p.position_labels.clone())
                        .unwrap_or_default(),
                    outcome: parsed.as_ref().map_or(
                        if won > 0 {
                            SeatOutcome::Collected
                        } else {
                            SeatOutcome::Unknown
                        },
                        |p| p.outcome,
                    ),
                    folded_street: parsed.as_ref().and_then(|p| p.folded_street),
                    didnt_bet: parsed.as_ref().is_some_and(|p| p.didnt_bet),
                    cashout_risk: parsed.as_ref().and_then(|p| p.cashout_risk),
                    raw: summary_line,
                }
            })
            .collect();

        let primary = resolve_runout(&board, 0);
        let dealt_to = match primary.len() {
            5.. => Street::River,
            4 => Street::Turn,
            3 => Street::Flop,
            _ => Street::Preflop,
        };
        let contenders = self
            .players
            .iter()
            .filter(|player| !self.folded.contains(&player.name))
            .count();
        let went_to_showdown = self.saw_showdown_marker && contenders >= 2;

        let ante_model = if self.ante_posters == 0 {
            AnteModel::None
        } else if self.ante_posters == 1 && self.players.len() > 1 {
            AnteModel::BigBlindAnte
        } else {
            AnteModel::PostedPerPlayer
        };

        let has_blinds = self
            .actions
            .iter()
            .any(|action| matches!(action.kind, ActionType::SmallBlind | ActionType::BigBlind));
        let bomb_pot = (self.ante_posters >= 2 && !has_blinds).then_some(PhfBombPot {
            ante: self.ante_max,
            dealt_to_street: Street::Flop,
            double_board: board.runouts.len() > 1,
        });

        let mut unseated_straddler = false;
        let straddles: Vec<PhfStraddle> = (1_u32..)
            .zip(&self.straddles)
            .map(|(order, (player, amount))| {
                let seat = self.seat_of(player).unwrap_or_else(|| {
                    unseated_straddler = true;
                    0
                });
                PhfStraddle {
                    seat,
                    player: player.clone(),
                    amount: *amount,
                    order,
                }
            })
            .collect();

        // Level headers go stale in tournaments, so what was posted wins.
        let game = &self.init.game;
        let tournament = self.init.tournament.is_some();
        let small_blind = if tournament && self.small_blind_posted > 0 {
            game.small_blind.max(self.small_blind_posted)
        } else if game.small_blind != 0 {
            game.small_blind
        } else {
            self.small_blind_posted
        };
        let big_blind = if tournament && self.big_blind_posted > 0 {
            game.big_blind.max(self.big_blind_posted)
        } else if game.big_blind != 0 {
            game.big_blind
        } else {
            self.big_blind_posted
        };

        let winners: Vec<PhfWinner> = self
            .actions
            .iter()
            .filter(|action| action.kind == ActionType::Collect)
            .map(|action| PhfWinner {
                player: action.player.clone(),
                seat: action.seat,
                amount: action.amount,
                runout_index: action.runout_index,
                half: None,
            })
            .collect();
        let hero_net = self.hero_name.as_ref().map(|hero| {
            get_or_zero(&self.collected_by, hero).saturating_sub(get_or_zero(&contributions, hero))
        });

        let init = &self.init;
        let mut hand = PhfHand {
            schema: PhfSchema::V1,
            meta: PhfMeta {
                site_id: init.site_id.clone(),
                site_name: init.site_name.clone(),
                hand_id: init.hand_id.clone(),
                hand_key: init.hand_key.clone(),
                original_filename: init.original_filename.clone(),
                parser_id: init.parser_id.clone(),
                parser_version: init.parser_version.clone(),
                warnings: self.warnings.clone(),
                raw_text: init.raw_text.clone(),
                parsed_at: init.parsed_at.clone(),
                text_style: PhfTextStyle {
                    dealt_lines_for_all_players: self.dealt_line_count > 1,
                    showdown_section: self.saw_showdown_marker,
                    hole_cards_section: self.saw_hole_cards_marker,
                    showdown_labels: if self.showdown_labels.is_empty() {
                        vec![String::new()]
                    } else {
                        self.showdown_labels.clone()
                    },
                    run_it_twice_note: self.run_it_twice_note,
                    ..init.text_style.clone()
                },
            },
            game: PhfGame {
                variant: init.game.variant,
                limit: init.game.limit,
                // The label is the only place any room states it.
                hi_lo: is_hi_lo_label(&init.game.label),
                format: init.game.format,
                unit,
                small_blind,
                big_blind,
                ante_model,
                ante: self.ante_max,
                straddles,
                bomb_pot,
                label: init.game.label.clone(),
            },
            table: PhfTable {
                name: self.table_name.clone(),
                max_seats: self.max_seats,
                button_seat: self.button_seat,
                fast_fold: self
                    .fast_fold
                    .as_ref()
                    .filter(|name| !name.is_empty())
                    .map(|name| Some(name.clone())),
            },
            tournament: init.tournament.clone(),
            players: self.players.clone(),
            actions: self.actions.clone(),
            // Absent rather than empty on almost every hand.
            chip_movements: (!self.movements.is_empty()).then(|| self.movements.clone()),
            board,
            results: PhfResults {
                total_pot: self.total_pot,
                pots: self.pots.clone(),
                fees: self.fees,
                players: player_results,
                winners,
                hero_net,
                went_to_showdown,
                street_reached: if went_to_showdown {
                    Street::Showdown
                } else {
                    dealt_to
                },
            },
            played_at: init.played_at.clone(),
        };
        // Same derivation `parseStandardHand` runs.
        if hand.game.hi_lo {
            let warnings = assign_hi_lo_halves(&mut hand).map_err(BuildError::Thrown)?;
            self.warnings.extend(warnings.iter().cloned());
            hand.meta.warnings.extend(warnings);
        }
        if unseated_straddler {
            return Err(BuildError::UnseatedStraddler);
        }
        Ok(hand)
    }
}

#[cfg(test)]
mod tests;
