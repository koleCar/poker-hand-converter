//! `acrwpn`: Americas Cardroom / Winning Poker Network (ACR, Black Chip,
//! True Poker, Ya Poker) (`frontend/src/lib/parsers/acrwpn.ts`, R0.10b). A
//! HUD-priority room.
//!
//! Two grammars and an anonymized mode out of one file:
//!
//! - `legacy` (2013-2019): `Game started at: 2014/3/9 19:37:22` and `Game ID:
//!   <id> <sb>/<bb> <table> (<Game>)`, actions as `Player <name> <verb>`,
//!   `raises (N)` an *increment*, and a summary whose `Bets:` column is checked
//!   against every action line (`contribution-mismatch`) and whose
//!   `Collects:` figure is the player's whole take, summed over every pot;
//! - `modern` (2019-2022): `Hand #<id> - Holdem(No Limit) - $0.05/$0.10 -
//!   2019/06/28 02:38:17 UTC`, GG-like action lines;
//! - `mined` (2018): the legacy grammar with numeric ids for names - read,
//!   with a `numeric-player-ids` warning.
//!
//! No skin prints a brand name, so detection is structural. Text may be a
//! UTF-16LE file read as UTF-8 ([`p5_recover_encoding`]). Hold'em, four-card
//! Omaha and (legacy only) Six Plus Hold'em are read; hi/lo is refused.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `acrwpn.ts`); the `m`-flag probes run at every JavaScript line start, the
//! modern detection probe's `$` written out as "end, or a line terminator".

use std::sync::LazyLock;

use regex::Regex;

use super::shared::p2_partygaming::{iso_from_888_date, split_lines};
use super::shared::p5_encoding::p5_recover_encoding;
use super::shared::p5_handdraft::{
    P5Action, P5Collect, P5Draft, P5Kind, P5Seat, P5Street, P5Tournament, p5_build_hand,
};
use super::shared::ps_gg_hand::{limit_from_label, split_before_line_starts};
use super::shared::variant_lock::{
    HOLDEM_OMAHA, HOLDEM_OMAHA_SHORTDECK, canonical_game_label, unsupported_variant_skip,
};
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::{CHIPS, USD, parse_amount_js};
use crate::phf::serialize::matches_at_line_start;
use crate::phf::{
    CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant, variant_from_label,
};

/// `VERSION`.
pub const ACRWPN_PARSER_VERSION: &str = "1.1.0";

/// `ACR_VARIANTS`: Hold'em, four-card Omaha and Six Plus Hold'em.
const ACR_VARIANTS: &[Variant] = HOLDEM_OMAHA_SHORTDECK;
/// `ACR_MODERN_VARIANTS`: no short-deck hand of the modern dialect was read.
const ACR_MODERN_VARIANTS: &[Variant] = HOLDEM_OMAHA;

const SITE_ID: &str = "acrwpn";
const SITE_NAME: &str = "ACR / Winning Poker Network";

static LEGACY_HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Game started at:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\s*$",
    ""
);
static MODERN_HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Game\s)?Hand\s#(\d+)\s-\s(.*)$", "");
/// `SPLIT_RE` without its lookahead (cut before every line start it matches).
static SPLIT_AT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Game started at:|(?:Game )?Hand #\d+ - )", "");
static MODERN_DATE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*UTC\s*$",
    ""
);
static CARD: LazyLock<Regex> = crate::js_regex_lazy!(r"\b(?:10|[2-9TJQKA])[cdhs]\b", "g");
static MINED_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat \d+: \d+ \(", "");
static BRACKET: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");

static LEGACY_GAME: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.*?)\s*\(([^()]*)\)\s*(?:(\d+)\s*-\s*max)?\s*$", "i");
static GAME_ID_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Game ID:", "");
static GAME_ID: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Game ID:\s*(\S+)\s+(\S+)\/(\S+)\s*(.*)$", "");
static TABLE_NUMBER: LazyLock<Regex> = crate::js_regex_lazy!(r",\s*Table\s+(\d+)\s*$", "");
static MAX_IN_NAME: LazyLock<Regex> = crate::js_regex_lazy!(r"(\d+)\s*-\s*max", "i");
static LEGACY_NOISE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:is timed out\.?|sitting out|wait BB|is disconnected and ALL IN\.?|mucks cards|is connected|is disconnected|stands up|sits down)$",
    "i"
);
static SUMMARY_MARK: LazyLock<Regex> = crate::js_regex_lazy!(r"^-+\s*Summary\s*-+$", "i");
static POT_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^Pot:", "");
static LEGACY_RAKE: LazyLock<Regex> = crate::js_regex_lazy!(r"\.\s*Rake", "i");
static LEGACY_POT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Pot:\s*([\d.]+)(?:\.\s*Rake\s*([\d.]+))?(?:\.\s*JP fee\s*([\d.]+))?\s*$",
    "i"
);
static LEGACY_SEAT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.*?)\s+\(([\d.,]+)\)\.?\s*$", "");
static LEGACY_BUTTON: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+)\s+is the button$", "");
static LEGACY_SKIP: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Game started at:|Game ID:|Seat\s)", "");
static LEGACY_MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*\s*:?(.*)$", "i");
static LEGACY_UNCALLED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Uncalled bet\s*\(([\d.,]+)\)\s*returned to\s*(.*)$", "i");
static GAME_ENDED: LazyLock<Regex> = crate::js_regex_lazy!(r"^Game ended at:", "");
static PLAYER: LazyLock<Regex> = crate::js_regex_lazy!(r"^Player\s(.*)$", "");
static FOLDS_OR_CHECKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:folds|checks)$", "i");
static UPCARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^received card:\s*\[([^\]]*)\]$", "i");
static LEGACY_BLIND: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^has\s(small|big)\sblind\s*\(([\d.,]+)\)$", "i");
static SMALL: LazyLock<Regex> = crate::js_regex_lazy!(r"^small$", "i");
static DEAD_BET: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^posts\s*\(([\d.,]+)\)\s*as a dead bet$", "i");
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(posts ante|ante|posts|straddle|bring in|calls|raises|bets|caps|allin)\s*\(([\d.,]+)\)$",
    "i"
);
static BARE_ALLIN: LazyLock<Regex> = crate::js_regex_lazy!(r"^allin$", "i");
static FOLDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^folds$", "i");
static CHECKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^checks$", "i");
static SUMMARY_SKIP: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Pot:|Board:|Game ended at:)", "i");
static SUMMARY_BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board:", "i");
static SUMMARY_ENTRY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*?Player\s(.*)$", "");
/// `` new RegExp(String.raw`Bets:\s*${NUM}`) `` with `NUM` =
/// `(\d[\d,]*(?:\.\d+)?)`.
static BETS: LazyLock<Regex> = crate::js_regex_lazy!(r"Bets:\s*(\d[\d,]*(?:\.\d+)?)", "");
/// The same with `Collects:`.
static COLLECTS: LazyLock<Regex> = crate::js_regex_lazy!(r"Collects:\s*(\d[\d,]*(?:\.\d+)?)", "");
static SHOWS_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"\bshows:", "i");
static SHOWS_DESCRIPTION: LazyLock<Regex> =
    crate::js_regex_lazy!(r"shows:\s*(.*?)\s*(?:\[|\.?\s*Bets:)", "i");

static TOURNAMENT_PAYLOAD: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:(.*?)\s)?Tournament\s#(\S+)\s-\s(.+?)\(([^)]*)\)\s-\sLevel\s(\S+)\s*\(([^)]*)\)\s*-",
    ""
);
static CASH_PAYLOAD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\(([^)]*)\)\s-\s(\S+)\/(\S+)\s-", "");
static RUN_IT_TWICE: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*RUN IT TWICE", "i");
static MODERN_TABLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.*?)\s*(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?\s*$",
    ""
);
static QUOTED_TABLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Table\s+'(.*)'$", "");
static MODERN_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Seat\s+(\d+):\s+(.*?)\s+\(\$?([\d.,]+)\)(\s+is sitting out)?\s*$",
    ""
);
static SUMMARY_MARKER: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY", "i");
static RUNNING_POT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:Main|Side) pot\b", "i");
static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS", "i");
static SHOWDOWN: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SHOW\s?DOWN", "i");
static MODERN_MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*(.*)$", "i");
static TOTAL_POT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Total pot\s+\$?([\d.,]+)(?:\s*\|\s*Rake\s+\$?([\d.,]+))?(?:\s*\|\s*JP Fee\s+\$?([\d.,]+))?",
    "i"
);
static BOARD_BRACKET: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board\s*\[", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.*)$", "");
static WON: LazyLock<Regex> = crate::js_regex_lazy!(r"\bwon\s+\$?([\d.,]+)", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to\s+(.*?)\s+\[([^\]]*)\]\s*$", "");
static MODERN_UNCALLED: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Uncalled bet\s*\(\$?([\d.,]+)\)\s*returned to\s*(.*)$",
    "i"
);
static ALL_IN_SUFFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"\sand is all-in$", "i");
static MODERN_BLIND: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^posts the (small|big) blind\s+\$?([\d.,]+)$", "i");
static MODERN_ANTE: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts ante\s+\$?([\d.,]+)$", "i");
static DEAD_POST: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts dead\s+\$?([\d.,]+)$", "i");
static POST: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts\s+\$?([\d.,]+)$", "i");
static RAISE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^raises\s+\$?([\d.,]+)\s+to\s+\$?([\d.,]+)$", "i");
static CALL_BET: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(calls|bets|caps)\s+\$?([\d.,]+)$", "i");
static CALLS: LazyLock<Regex> = crate::js_regex_lazy!(r"^calls$", "i");
static BETS_VERB: LazyLock<Regex> = crate::js_regex_lazy!(r"^bets$", "i");
static COLLECT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^collected\s+\$?([\d.,]+)\s+from\s+(.*)$", "i");
static POT_NUMBER: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+\d+$", "");
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^shows\s*\[([^\]]*)\](?:\s*\((.*)\))?$", "i");
static BEST_FIVE: LazyLock<Regex> = crate::js_regex_lazy!(r"\s*\[[^\]]*\]\s*$", "");
static MUCKS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:does not show|doesn't show|mucks hand|mucks)$", "i");
static MODERN_NOISE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:is sitting out|sits out|has timed out|is disconnected|is connected|said,)",
    "i"
);
static PARENTHESES: LazyLock<Regex> = crate::js_regex_lazy!(r"[()]", "g");

static DETECT_GAME_STARTED: LazyLock<Regex> = crate::js_regex_lazy!(r"^Game started at:", "");
static DETECT_GAME_ID: LazyLock<Regex> = crate::js_regex_lazy!(r"^Game ID:\s*\S+\s+\S+\/\S+", "");
/// `/^(?:Game\s)?Hand\s#\d+\s-\s.*...\s*UTC\s*$/m`, run at every line start:
/// the `m`-flag `$` is the end of the text or a line terminator after it.
static DETECT_MODERN: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Game\s)?Hand\s#\d+\s-\s.*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*UTC\s*(?:$|[\n\r\u2028\u2029])",
    ""
);
static DETECT_RUNNING_POT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Main|Side) pot\s+\S+\s*\|\s*Rake\s", "");

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

/// `i + 1` as a warning's line number.
fn line_number(i: usize) -> Option<u32> {
    u32::try_from(i + 1).ok()
}

/// `WpnDialect`: which grammar a chunk is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WpnDialect {
    Legacy,
    Modern,
    Mined,
}

impl WpnDialect {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Modern => "modern",
            Self::Mined => "mined",
        }
    }
}

/// `wpnDialect(chunk)`: the first line of the recovered text decides; the
/// numeric-name probe reads the chunk as given.
pub fn wpn_dialect(chunk: &str) -> Option<WpnDialect> {
    let recovered = p5_recover_encoding(chunk);
    let first = js::trim(split_lines(&recovered)[0]);
    if LEGACY_HEADER.is_match(first) {
        return Some(if matches_at_line_start(&MINED_SEAT, chunk) {
            WpnDialect::Mined
        } else {
            WpnDialect::Legacy
        });
    }
    MODERN_HEADER.is_match(first).then_some(WpnDialect::Modern)
}

/// `cardsIn(text)`: every card token, `10d` written `Td`.
fn cards_in(text: &str) -> Vec<String> {
    CARD.find_iter(text)
        .map(|card| {
            let card = card.as_str();
            card.strip_prefix("10")
                .map_or_else(|| card.to_owned(), |suit| format!("T{suit}"))
        })
        .collect()
}

/// `isoFrom(...)`: `Date.UTC` then `toISOString` (which throws `Invalid
/// time value` beyond the date range; unreachable for these digit counts).
fn iso_from(
    year: &str,
    month: &str,
    day: &str,
    hour: &str,
    minute: &str,
    second: &str,
) -> Result<String, ParseError> {
    iso_from_888_date(day, month, year, hour, minute, second)
        .ok_or_else(|| ParseError::Bug("Invalid time value".to_owned()))
}

/// `name.length` as a JavaScript number (UTF-16 code units).
fn utf16_length(name: &str) -> JsNumber {
    JsNumber::from_u64(u64::try_from(js::utf16_len(name)).unwrap_or(u64::MAX))
}

/// `matchName(text, names)`: the first (longest) name `text` is or starts
/// with followed by a space.
fn match_name<'n>(text: &str, names: &'n [String]) -> Option<&'n str> {
    names
        .iter()
        .find(|name| {
            text == name.as_str()
                || text
                    .strip_prefix(name.as_str())
                    .is_some_and(|rest| rest.starts_with(' '))
        })
        .map(String::as_str)
}

/// `sortedNames(seats)`: `sort((a, b) => b.length - a.length)`, as V8 sorts.
fn sorted_names(seats: &[P5Seat]) -> Vec<String> {
    let mut names: Vec<String> = seats.iter().map(|seat| seat.name.clone()).collect();
    js::sort::sort_by(&mut names, |a, b| utf16_length(b) - utf16_length(a));
    names
}

/// `Map.set` on a vector of pairs.
fn set_entry<V>(map: &mut Vec<(String, V)>, key: &str, value: V) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

fn has_entry<V>(map: &[(String, V)], key: &str) -> bool {
    map.iter().any(|(k, _)| k == key)
}

fn get_entry<'m, V>(map: &'m [(String, V)], key: &str) -> Option<&'m V> {
    map.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/* ------------------------------------------------------------------ shared */

/// `Scratch`: everything a dialect reader fills in before the builder runs.
#[derive(Debug, Default)]
struct Scratch {
    seats: Vec<P5Seat>,
    actions: Vec<P5Action>,
    collected: Vec<P5Collect>,
    hole_cards: Vec<(String, Vec<String>)>,
    warnings: Vec<PhfWarning>,
    stated_contributions: Vec<(String, JsNumber)>,
    street: Option<P5Street>,
    flop: Option<Vec<String>>,
    turn: Option<String>,
    river: Option<String>,
    small_blind: JsNumber,
    big_blind: JsNumber,
    stated_payout: Option<JsNumber>,
    stated_rake: Option<JsNumber>,
}

impl Scratch {
    fn street(&self) -> P5Street {
        self.street.unwrap_or(P5Street::Preflop)
    }

    /// `seatByName.get(name)`: names are unique (a second seat refuses).
    fn seat_index(&self, name: &str) -> Option<usize> {
        self.seats.iter().position(|seat| seat.name == name)
    }
}

/// `applyMarker(scratch, kind, payload)`: the board cards of a street marker
/// (its last bracket), and the street moves on.
fn apply_marker(scratch: &mut Scratch, kind: &str, payload: &str) {
    let last = BRACKET
        .captures_iter(payload)
        .last()
        .map(|group| cards_in(&group[1]))
        .unwrap_or_default();
    match kind {
        "FLOP" => {
            scratch.flop = Some(last.into_iter().take(3).collect());
            scratch.street = Some(P5Street::Flop);
        }
        "TURN" => {
            scratch.turn = last.into_iter().next();
            scratch.street = Some(P5Street::Turn);
        }
        _ => {
            scratch.river = last.into_iter().next();
            scratch.street = Some(P5Street::River);
        }
    }
}

/// `resolveBareAllIns(scratch)`: an `allin` without a figure is the rest of
/// the seat's stack, worked out over the whole stream.
fn resolve_bare_all_ins(scratch: &mut Scratch) -> Result<(), ParseError> {
    let mut spent: Vec<(String, JsNumber)> = Vec::new();
    for index in 0..scratch.actions.len() {
        let action = &scratch.actions[index];
        if action.kind == P5Kind::Allin && action.amount.is_none() {
            let Some(seat) = scratch.seat_index(&action.player) else {
                return Err(skip(
                    SkipReason::UnseatedActor,
                    format!("\"{}\" is all-in but is not seated.", action.player),
                ));
            };
            let already = get_entry(&spent, &action.player)
                .copied()
                .unwrap_or(JsNumber::ZERO);
            let rest = JsNumber::ZERO.max_of(scratch.seats[seat].starting_stack - already);
            scratch.actions[index].amount = Some(rest);
        }
        let action = &scratch.actions[index];
        // Reveals and folds move nothing; an uncalled return comes back out.
        let moved = if action.kind == P5Kind::Uncalled {
            -action.amount.unwrap_or(JsNumber::ZERO)
        } else {
            action.amount.unwrap_or(JsNumber::ZERO) + action.dead.unwrap_or(JsNumber::ZERO)
        };
        let total = get_entry(&spent, &action.player)
            .copied()
            .unwrap_or(JsNumber::ZERO)
            + moved;
        let player = action.player.clone();
        set_entry(&mut spent, &player, total);
    }
    Ok(())
}

/// `[2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn`.
fn table_size_for(dealt_in: usize) -> JsNumber {
    let size = [2_usize, 6, 9, 10]
        .into_iter()
        .find(|size| *size >= dealt_in)
        .unwrap_or(dealt_in);
    JsNumber::from_u64(u64::try_from(size).unwrap_or(u64::MAX))
}

/// `(text.replace(/[()]/g, "").trim()) || null`.
fn tournament_name(text: &str) -> Option<String> {
    let name = PARENTHESES.replace_all(text, "");
    Some(js::trim(&name).to_owned()).filter(|name| !name.is_empty())
}

/// The payout check both dialects end with (`Math.abs(paid - statedPayout)
/// > 1`).
fn paid(scratch: &Scratch) -> JsNumber {
    scratch
        .collected
        .iter()
        .fold(JsNumber::ZERO, |sum, entry| sum + entry.amount)
}

fn payout_off(scratch: &Scratch) -> Option<(JsNumber, JsNumber)> {
    let stated = scratch.stated_payout?;
    let paid = paid(scratch);
    (paid - stated)
        .abs()
        .greater_than(JsNumber::from_u64(1))
        .then_some((stated, paid))
}

/* ------------------------------------------------------------------ legacy */

/// `LegacyHeader`.
struct LegacyHeader {
    hand_id: String,
    game_name: String,
    table_name: String,
    small_blind: JsNumber,
    big_blind: JsNumber,
    max_seats: Option<JsNumber>,
    /// Tournament table number, when the table text carries one.
    table_number: Option<String>,
    played_at: String,
}

/// `readLegacyHeader(lines, unitHint)`.
fn read_legacy_header(
    lines: &[&str],
    unit_hint: &CurrencyUnit,
) -> Result<Option<LegacyHeader>, ParseError> {
    let started = LEGACY_HEADER.captures(js::trim(lines[0]));
    let id_line = lines
        .iter()
        .find(|line| GAME_ID_LINE.is_match(js::trim(line)));
    let (Some(started), Some(id_line)) = (started, id_line) else {
        return Ok(None);
    };
    let Some(id) = GAME_ID.captures(js::trim(id_line)) else {
        return Ok(None);
    };
    let info = js::trim(&id[4]);
    let Some(game) = LEGACY_GAME.captures(info) else {
        return Ok(None);
    };
    let mut table = js::trim(&game[1]);
    // `$5 Regular 9-Max, Table 1`: the only tournament coordinate.
    let table_number = TABLE_NUMBER.captures(table).map(|number| {
        let start = number.get(0).map_or(0, |m| m.start());
        let digits = number[1].to_owned();
        (start, digits)
    });
    if let Some((start, _)) = &table_number {
        table = js::trim(&table[..*start]);
    }
    let max_in_name = MAX_IN_NAME.captures(table);
    let max_seats = match game.get(3) {
        Some(size) if !size.as_str().is_empty() => Some(JsNumber::parse(size.as_str())),
        _ => max_in_name.map(|max| JsNumber::parse(&max[1])),
    };
    Ok(Some(LegacyHeader {
        hand_id: id[1].to_owned(),
        game_name: js::trim(&game[2]).to_owned(),
        table_name: table.to_owned(),
        small_blind: parse_amount_js(&id[2], unit_hint),
        big_blind: parse_amount_js(&id[3], unit_hint),
        max_seats,
        table_number: table_number.map(|(_, digits)| digits),
        played_at: iso_from(
            &started[1],
            &started[2],
            &started[3],
            &started[4],
            &started[5],
            &started[6],
        )?,
    }))
}

/// `push(kind, amount, dead)` of the legacy reader: the seat is dealt in.
fn push_legacy(
    scratch: &mut Scratch,
    seat: usize,
    kind: P5Kind,
    amount: Option<JsNumber>,
    dead: Option<JsNumber>,
) {
    scratch.seats[seat].dealt_in = true;
    let mut action = P5Action::new(scratch.street(), &scratch.seats[seat].name.clone(), kind);
    action.amount = amount;
    action.dead = dead;
    scratch.actions.push(action);
}

/// `parseLegacy(raw, ctx, dialect)`.
#[allow(clippy::too_many_lines)]
fn parse_legacy(
    raw: &str,
    ctx: &SiteParserContext<'_>,
    dialect: WpnDialect,
) -> Result<(P5Draft, String), ParseError> {
    let lines = split_lines(raw);
    // Read with cents first so fractional blinds survive, then again with the
    // unit the pot line decides.
    let Some(probe) = read_legacy_header(&lines, &USD.unit())? else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk has no readable `Game started at:` / `Game ID:` pair.",
        ));
    };
    // Hi/lo first, so its reason stays `unsupported-hi-lo`.
    if let Some(refusal) = unsupported_game_skip(&probe.game_name, &[])
        .or_else(|| unsupported_variant_skip(&probe.game_name, ACR_VARIANTS))
    {
        return Err(refusal.into());
    }
    let variant = variant_from_label(&probe.game_name);

    let Some(summary_index) = lines
        .iter()
        .position(|line| SUMMARY_MARK.is_match(js::trim(line)))
    else {
        return Err(skip(
            SkipReason::TruncatedHand,
            "The hand has no `------ Summary ------` block.",
        ));
    };
    let Some(pot_line) = lines[summary_index..]
        .iter()
        .map(|line| js::trim(line))
        .find(|line| POT_PREFIX.is_match(line))
    else {
        return Err(skip(
            SkipReason::TruncatedHand,
            "The summary block has no `Pot:` line.",
        ));
    };
    // Cash prints a rake clause even when it is zero; a tournament never does.
    let is_tournament = !LEGACY_RAKE.is_match(pot_line);
    if ctx.options.cash_only && is_tournament {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped.",
        ));
    }
    let unit = if is_tournament {
        CHIPS.unit()
    } else {
        USD.unit()
    };
    let Some(header) = read_legacy_header(&lines, &unit)? else {
        return Err(ParseError::Bug(
            "the legacy header read once and not twice".to_owned(),
        ));
    };
    let mut scratch = Scratch {
        small_blind: header.small_blind,
        big_blind: header.big_blind,
        ..Scratch::default()
    };

    let Some(pot) = LEGACY_POT.captures(pot_line) else {
        return Err(skip(
            SkipReason::TruncatedHand,
            format!("Unreadable pot line \"{pot_line}\"."),
        ));
    };
    scratch.stated_payout = Some(parse_amount_js(&pot[1], &unit));
    scratch.stated_rake = pot.get(2).map(|rake| {
        parse_amount_js(rake.as_str(), &unit)
            + parse_amount_js(pot.get(3).map_or("", |m| m.as_str()), &unit)
    });

    let mut button_seat: Option<JsNumber> = None;
    let mut dealt_any_card = false;

    /* ------------------------------------------------------- seats first --- */

    for line in &lines[..summary_index] {
        let line = js::trim(line);
        if let Some(seat) = LEGACY_SEAT.captures(line) {
            let name = &seat[2];
            if scratch.seat_index(name).is_some() {
                return Err(skip(
                    SkipReason::DuplicatePlayer,
                    format!("\"{name}\" is seated twice."),
                ));
            }
            scratch.seats.push(P5Seat {
                seat: JsNumber::parse(&seat[1]),
                name: name.to_owned(),
                starting_stack: parse_amount_js(&seat[3], &unit),
                is_hero: false,
                // Only seats the dealer dealt to are in the hand.
                dealt_in: false,
                dealt_cards: Vec::new(),
            });
            continue;
        }
        if let Some(button) = LEGACY_BUTTON.captures(line) {
            button_seat = Some(JsNumber::parse(&button[1]));
        }
    }
    if scratch.seats.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The hand lists no seats."));
    }
    let names = sorted_names(&scratch.seats);

    /* ----------------------------------------------------------- actions --- */

    for (i, raw_line) in lines.iter().enumerate().take(summary_index).skip(1) {
        let line = js::trim(raw_line);
        if line.is_empty() || LEGACY_SKIP.is_match(line) {
            continue;
        }
        if let Some(marker) = LEGACY_MARKER.captures(line) {
            let kind = js::to_upper_case(&marker[1]);
            apply_marker(
                &mut scratch,
                &kind,
                marker.get(2).map_or("", |m| m.as_str()),
            );
            continue;
        }
        if let Some(uncalled) = LEGACY_UNCALLED.captures(line) {
            let player = js::trim(&uncalled[2]);
            if scratch.seat_index(player).is_none() {
                // Which seat gets the money back changes the pot for two
                // players: nothing safe to assume.
                return Err(skip(
                    SkipReason::UnnamedActor,
                    format!(
                        "An uncalled bet of {} is returned to a player the export did not name.",
                        &uncalled[1]
                    ),
                ));
            }
            let mut action = P5Action::new(scratch.street(), player, P5Kind::Uncalled);
            action.amount = Some(parse_amount_js(&uncalled[1], &unit));
            scratch.actions.push(action);
            continue;
        }
        if GAME_ENDED.is_match(line) {
            continue;
        }

        let Some(acted) = PLAYER.captures(line) else {
            scratch
                .warnings
                .push(warning("unknown-line", line, line_number(i)));
            continue;
        };
        let rest = acted.get(1).map_or("", |m| m.as_str());
        let Some(player) = match_name(rest, &names) else {
            // `Player  folds` with no name is real; anything it does to the
            // pot is unattributable, so only the no-op lines can be dropped.
            let verb = js::trim(rest);
            if LEGACY_NOISE.is_match(verb) || FOLDS_OR_CHECKS.is_match(verb) {
                continue;
            }
            return Err(skip(
                SkipReason::UnnamedActor,
                format!("The export did not name the player in \"{line}\"."),
            ));
        };
        let verb = js::trim(&rest[player.len()..]);
        let Some(seat) = scratch.seat_index(player) else {
            return Err(ParseError::Bug(format!("no seat for {player}")));
        };

        if verb == "received a card." {
            scratch.seats[seat].dealt_in = true;
            dealt_any_card = true;
            continue;
        }
        if let Some(upcard) = UPCARD.captures(verb) {
            let entry = &mut scratch.seats[seat];
            entry.dealt_in = true;
            entry.is_hero = true;
            dealt_any_card = true;
            entry.dealt_cards.extend(cards_in(&upcard[1]));
            let cards = entry.dealt_cards.clone();
            set_entry(&mut scratch.hole_cards, player, cards);
            continue;
        }
        if LEGACY_NOISE.is_match(verb) {
            continue;
        }

        if let Some(blind) = LEGACY_BLIND.captures(verb) {
            let amount = parse_amount_js(&blind[2], &unit);
            if SMALL.is_match(&blind[1]) {
                scratch.small_blind = scratch.small_blind.max_of(amount);
                push_legacy(&mut scratch, seat, P5Kind::SmallBlind, Some(amount), None);
            } else {
                scratch.big_blind = scratch.big_blind.max_of(amount);
                push_legacy(&mut scratch, seat, P5Kind::BigBlind, Some(amount), None);
            }
            continue;
        }
        if let Some(dead) = DEAD_BET.captures(verb) {
            // In the pot, but nobody has to match it; the live half follows
            // as a plain `posts (N)`.
            let dead = parse_amount_js(&dead[1], &unit);
            push_legacy(
                &mut scratch,
                seat,
                P5Kind::Post,
                Some(JsNumber::ZERO),
                Some(dead),
            );
            continue;
        }
        if let Some(simple) = SIMPLE.captures(verb) {
            let amount = Some(parse_amount_js(&simple[2], &unit));
            let kind = match js::to_lower_case(&simple[1]).as_str() {
                "posts ante" | "ante" => P5Kind::Ante,
                "posts" | "bring in" => P5Kind::Post,
                "straddle" => P5Kind::Straddle,
                "calls" => P5Kind::Call,
                "bets" => P5Kind::Bet,
                // `raises (N)` and `caps (N)` state the chips pushed.
                "raises" | "caps" => P5Kind::Raise,
                _ => P5Kind::Allin,
            };
            push_legacy(&mut scratch, seat, kind, amount, None);
            continue;
        }
        if BARE_ALLIN.is_match(verb) {
            // The rest of the stack, filled in later.
            push_legacy(&mut scratch, seat, P5Kind::Allin, None, None);
            continue;
        }
        if FOLDS.is_match(verb) {
            push_legacy(&mut scratch, seat, P5Kind::Fold, None, None);
            continue;
        }
        if CHECKS.is_match(verb) {
            push_legacy(&mut scratch, seat, P5Kind::Check, None, None);
            continue;
        }
        scratch
            .warnings
            .push(warning("unknown-line", line, line_number(i)));
    }

    if !dealt_any_card {
        return Err(skip(
            SkipReason::CancelledHand,
            "No cards were dealt; the table cancelled the hand before the deal.",
        ));
    }

    /* ----------------------------------------------------------- summary --- */

    let mut all_bets_zero = true;
    for (i, raw_line) in lines.iter().enumerate().skip(summary_index + 1) {
        let line = js::trim(raw_line);
        if line.is_empty() || SUMMARY_SKIP.is_match(line) {
            if SUMMARY_BOARD.is_match(line) {
                let summary_board = cards_in(line);
                if !summary_board.is_empty() && scratch.flop.is_none() {
                    scratch.flop = Some(summary_board.iter().take(3).cloned().collect());
                    scratch.turn = summary_board.get(3).cloned();
                    scratch.river = summary_board.get(4).cloned();
                }
            }
            continue;
        }
        let Some(entry) = SUMMARY_ENTRY.captures(line) else {
            scratch
                .warnings
                .push(warning("unknown-summary-line", line, line_number(i)));
            continue;
        };
        let text = entry.get(1).map_or("", |m| m.as_str());
        let player = match_name(text, &names);
        let tail = player.map_or(text, |player| &text[player.len()..]);
        let bets = BETS.captures(tail);
        let collects = COLLECTS.captures(tail);
        let Some(player) = player else {
            // Somebody who never sat down: harmless while no money moves.
            let figure = |captures: &Option<regex::Captures<'_>>| {
                parse_amount_js(
                    captures
                        .as_ref()
                        .and_then(|c| c.get(1))
                        .map_or("", |m| m.as_str()),
                    &unit,
                )
            };
            if figure(&bets).strict_equals(JsNumber::ZERO)
                && figure(&collects).strict_equals(JsNumber::ZERO)
            {
                continue;
            }
            return Err(skip(
                SkipReason::UnseatedActor,
                format!("The summary reports money for an unseated player: \"{line}\"."),
            ));
        };
        if let Some(bets) = &bets {
            let amount = parse_amount_js(&bets[1], &unit);
            set_entry(&mut scratch.stated_contributions, player, amount);
            if !amount.strict_equals(JsNumber::ZERO) {
                all_bets_zero = false;
            }
        }
        if let Some(collects) = &collects {
            let amount = parse_amount_js(&collects[1], &unit);
            if amount.greater_than(JsNumber::ZERO) {
                scratch.collected.push(P5Collect {
                    player: player.to_owned(),
                    amount,
                    pot_name: None,
                });
            }
        }

        let revealed = BRACKET
            .captures(tail)
            .map(|cards| cards_in(&cards[1]))
            .unwrap_or_default();
        if revealed.len() == 2 && !has_entry(&scratch.hole_cards, player) {
            set_entry(&mut scratch.hole_cards, player, revealed);
        }
        let folded = scratch
            .actions
            .iter()
            .any(|action| action.player == player && action.kind == P5Kind::Fold);
        if folded {
            continue;
        }
        let known = get_entry(&scratch.hole_cards, player)
            .cloned()
            .unwrap_or_default();
        if SHOWS_WORD.is_match(tail) {
            let mut action = P5Action::new(scratch.street(), player, P5Kind::Show);
            action.cards = Some(known);
            action.description = SHOWS_DESCRIPTION
                .captures(tail)
                .and_then(|m| m.get(1))
                .map(|m| m.as_str().to_owned())
                .filter(|d| !d.is_empty());
            scratch.actions.push(action);
        } else if scratch
            .seat_index(player)
            .is_some_and(|seat| scratch.seats[seat].dealt_in)
        {
            let mut action = P5Action::new(scratch.street(), player, P5Kind::Muck);
            action.cards = Some(known);
            scratch.actions.push(action);
        }
    }

    if all_bets_zero && !scratch.stated_contributions.is_empty() {
        // The data-mined export zeroes the whole column.
        scratch.stated_contributions.clear();
    }

    resolve_bare_all_ins(&mut scratch)?;

    let dealt_in = scratch.seats.iter().filter(|seat| seat.dealt_in).count();
    if dialect == WpnDialect::Mined {
        scratch.warnings.push(warning(
            "numeric-player-ids",
            "Every seat is a numeric id rather than a screen name, and no seat is marked as the \
             hero; the names are not usable as player identities.",
            None,
        ));
    }

    if let Some((stated, paid)) = payout_off(&scratch) {
        return Err(skip(
            SkipReason::PayoutMismatch,
            format!(
                "The summary reports a pot of {} but the per-player columns only account for {} \
                 of it.",
                stated.to_js_string(),
                paid.to_js_string()
            ),
        ));
    }

    let limit = if variant == Variant::Omaha {
        LimitType::Pl
    } else {
        LimitType::Nl
    };
    let table_name = match &header.table_number {
        Some(number) => Some(js::trim(&format!("{} {number}", header.table_name)).to_owned()),
        None => Some(header.table_name.clone()).filter(|name| !name.is_empty()),
    };
    let flop = scratch.flop.take().filter(|flop| flop.len() == 3);
    let stated_contributions = Some(std::mem::take(&mut scratch.stated_contributions))
        .filter(|entries| !entries.is_empty());
    let draft = P5Draft {
        site_id: SITE_ID.to_owned(),
        site_name: SITE_NAME.to_owned(),
        parser_id: SITE_ID.to_owned(),
        parser_version: ACRWPN_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        game_label: canonical_game_label(variant, limit, false),
        unit: unit.clone(),
        decimals: DecimalStyle::Fixed2,
        small_blind: scratch.small_blind,
        big_blind: scratch.big_blind,
        table_name,
        max_seats: header.max_seats.unwrap_or_else(|| table_size_for(dealt_in)),
        button_seat,
        played_at: Some(header.played_at.clone()),
        tournament: is_tournament.then(|| P5Tournament {
            // The legacy dialect never prints a tournament number.
            id: "unknown".to_owned(),
            name: tournament_name(&header.table_name),
            buy_in_token: "$0".to_owned(),
            level_label: "1".to_owned(),
        }),
        seats: scratch.seats,
        actions: scratch.actions,
        flop,
        turn: scratch.turn,
        river: scratch.river,
        collected: scratch.collected,
        // The printed pot is net of every fee: the contributions are the pot.
        stated_pot: None,
        stated_rake: scratch.stated_rake,
        stated_contributions,
        hole_cards: scratch.hole_cards,
        raw_text: js::trim(raw).to_owned(),
        warnings: scratch.warnings,
    };
    Ok((draft, format!("WPN{}", header.hand_id)))
}

/* ------------------------------------------------------------------ modern */

/// `parseModern(raw, ctx)`.
#[allow(clippy::too_many_lines)]
fn parse_modern(raw: &str, ctx: &SiteParserContext<'_>) -> Result<(P5Draft, String), ParseError> {
    let lines = split_lines(raw);
    let Some(head) = MODERN_HEADER.captures(js::trim(lines[0])) else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk has no readable `Hand #` header.",
        ));
    };
    let hand_id = head[1].to_owned();
    let payload = head.get(2).map_or("", |m| m.as_str());
    let played_at = match MODERN_DATE.captures(payload) {
        Some(date) => Some(iso_from(
            &date[1], &date[2], &date[3], &date[4], &date[5], &date[6],
        )?),
        None => None,
    };

    let tour = TOURNAMENT_PAYLOAD.captures(payload);
    let cash = CASH_PAYLOAD.captures(payload);
    let header = match (&tour, &cash) {
        (Some(tour), _) => tour,
        (None, Some(cash)) => cash,
        (None, None) => {
            return Err(skip(
                SkipReason::NoHeader,
                format!("Unreadable modern header payload \"{payload}\"."),
            ));
        }
    };
    let game_name = js::trim(if tour.is_some() {
        &header[3]
    } else {
        &header[1]
    })
    .to_owned();
    if let Some(refusal) = unsupported_game_skip(&game_name, &[])
        .or_else(|| unsupported_variant_skip(&game_name, ACR_MODERN_VARIANTS))
    {
        return Err(refusal.into());
    }
    if ctx.options.cash_only && tour.is_some() {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped.",
        ));
    }
    if matches_at_line_start(&RUN_IT_TWICE, raw) {
        return Err(skip(
            SkipReason::RunItTwice,
            "Run-it-twice hands are not supported yet.",
        ));
    }

    let limit = js::trim(if tour.is_some() {
        &header[4]
    } else {
        &header[2]
    })
    .to_owned();
    let unit = if tour.is_some() {
        CHIPS.unit()
    } else {
        USD.unit()
    };
    let mut scratch = Scratch::default();
    if let Some(tour) = &tour {
        let stakes: Vec<&str> = tour[6].split('/').collect();
        scratch.small_blind = parse_amount_js(stakes[0], &unit);
        scratch.big_blind = parse_amount_js(stakes.get(1).copied().unwrap_or(stakes[0]), &unit);
    } else if let Some(cash) = &cash {
        scratch.small_blind = parse_amount_js(&cash[3], &unit);
        scratch.big_blind = parse_amount_js(&cash[4], &unit);
    }

    let mut table_name: Option<String> = None;
    let mut max_seats: Option<JsNumber> = None;
    let mut button_seat: Option<JsNumber> = None;
    let mut in_summary = false;
    let mut summary_wins: Vec<P5Collect> = Vec::new();

    // The table line is the only place the seat count and the button appear.
    let table = lines
        .get(1)
        .and_then(|line| MODERN_TABLE.captures(js::trim(line)));
    if let Some(table) = &table {
        let name = &table[1];
        let unquoted = QUOTED_TABLE
            .captures(name)
            .map_or(name, |quoted| quoted.get(1).map_or("", |m| m.as_str()));
        table_name = Some(js::trim(unquoted).to_owned()).filter(|name| !name.is_empty());
        max_seats = Some(JsNumber::parse(&table[2]));
        button_seat = table.get(3).map(|button| JsNumber::parse(button.as_str()));
    }

    let mut names: Vec<String> = Vec::new();
    let mut names_for = usize::MAX;
    let first = if table.is_some() { 2 } else { 1 };
    for (i, raw_line) in lines.iter().enumerate().skip(first) {
        let line = js::trim(raw_line);
        if line.is_empty() {
            continue;
        }
        if !in_summary && let Some(seat) = MODERN_SEAT.captures(line) {
            let name = &seat[2];
            if scratch.seat_index(name).is_some() {
                return Err(skip(
                    SkipReason::DuplicatePlayer,
                    format!("\"{name}\" is seated twice."),
                ));
            }
            scratch.seats.push(P5Seat {
                seat: JsNumber::parse(&seat[1]),
                name: name.to_owned(),
                starting_stack: parse_amount_js(&seat[3], &unit),
                is_hero: false,
                dealt_in: seat.get(4).is_none_or(|m| m.as_str().is_empty()),
                dealt_cards: Vec::new(),
            });
            continue;
        }
        if SUMMARY_MARKER.is_match(line) {
            in_summary = true;
            continue;
        }
        // A running pot after every street marker: only the SUMMARY is final.
        if RUNNING_POT.is_match(line) && !in_summary {
            continue;
        }
        if HOLE_CARDS.is_match(line) || SHOWDOWN.is_match(line) {
            continue;
        }
        if !in_summary && let Some(marker) = MODERN_MARKER.captures(line) {
            let kind = js::to_upper_case(&marker[1]);
            apply_marker(
                &mut scratch,
                &kind,
                marker.get(2).map_or("", |m| m.as_str()),
            );
            continue;
        }

        if in_summary {
            if let Some(pot) = TOTAL_POT.captures(line) {
                scratch.stated_payout = Some(parse_amount_js(&pot[1], &unit));
                scratch.stated_rake = pot.get(2).map(|rake| {
                    parse_amount_js(rake.as_str(), &unit)
                        + parse_amount_js(pot.get(3).map_or("", |m| m.as_str()), &unit)
                });
                continue;
            }
            if BOARD_BRACKET.is_match(line) {
                continue;
            }
            if let Some(summary_seat) = SUMMARY_SEAT.captures(line) {
                let text = summary_seat.get(2).map_or("", |m| m.as_str());
                let sorted = sorted_names(&scratch.seats);
                let Some(player) = match_name(text, &sorted) else {
                    scratch
                        .warnings
                        .push(warning("unknown-summary-line", line, line_number(i)));
                    continue;
                };
                let tail = &text[player.len()..];
                let revealed = BRACKET
                    .captures(tail)
                    .map(|cards| cards_in(&cards[1]))
                    .unwrap_or_default();
                if revealed.len() == 2 && !has_entry(&scratch.hole_cards, player) {
                    set_entry(&mut scratch.hole_cards, player, revealed);
                }
                if let Some(won) = WON.captures(tail) {
                    summary_wins.push(P5Collect {
                        player: player.to_owned(),
                        amount: parse_amount_js(&won[1], &unit),
                        pot_name: None,
                    });
                }
                continue;
            }
            scratch
                .warnings
                .push(warning("unknown-summary-line", line, line_number(i)));
            continue;
        }

        if let Some(dealt) = DEALT.captures(line) {
            if let Some(seat) = scratch.seat_index(js::trim(&dealt[1])) {
                let cards = cards_in(&dealt[2]);
                let entry = &mut scratch.seats[seat];
                entry.is_hero = true;
                entry.dealt_in = true;
                entry.dealt_cards.clone_from(&cards);
                let name = entry.name.clone();
                set_entry(&mut scratch.hole_cards, &name, cards);
            }
            continue;
        }
        if let Some(uncalled) = MODERN_UNCALLED.captures(line) {
            let player = js::trim(&uncalled[2]);
            if scratch.seat_index(player).is_none() {
                return Err(skip(
                    SkipReason::UnnamedActor,
                    format!("An uncalled bet is returned to \"{player}\"."),
                ));
            }
            let mut action = P5Action::new(scratch.street(), player, P5Kind::Uncalled);
            action.amount = Some(parse_amount_js(&uncalled[1], &unit));
            scratch.actions.push(action);
            continue;
        }

        if names_for != scratch.seats.len() {
            names = sorted_names(&scratch.seats);
            names_for = scratch.seats.len();
        }
        let Some(player) = match_name(line, &names) else {
            scratch
                .warnings
                .push(warning("unknown-line", line, line_number(i)));
            continue;
        };
        let player = player.to_owned();
        let verb = js::trim(&line[player.len()..]);
        let all_in = ALL_IN_SUFFIX.is_match(verb);
        let verb = ALL_IN_SUFFIX.replace(verb, "");
        let verb = verb.as_ref();
        let Some(seat) = scratch.seat_index(&player) else {
            return Err(ParseError::Bug(format!("no seat for {player}")));
        };
        let push = |scratch: &mut Scratch, kind: P5Kind, amount: Option<JsNumber>| {
            scratch.seats[seat].dealt_in = true;
            let mut action = P5Action::new(scratch.street(), &player, kind);
            action.amount = amount;
            action.all_in = all_in;
            scratch.actions.push(action);
        };

        if let Some(blind) = MODERN_BLIND.captures(verb) {
            let amount = parse_amount_js(&blind[2], &unit);
            if SMALL.is_match(&blind[1]) {
                scratch.small_blind = scratch.small_blind.max_of(amount);
                push(&mut scratch, P5Kind::SmallBlind, Some(amount));
            } else {
                scratch.big_blind = scratch.big_blind.max_of(amount);
                push(&mut scratch, P5Kind::BigBlind, Some(amount));
            }
            continue;
        }
        if let Some(ante) = MODERN_ANTE.captures(verb) {
            push(
                &mut scratch,
                P5Kind::Ante,
                Some(parse_amount_js(&ante[1], &unit)),
            );
            continue;
        }
        if let Some(dead) = DEAD_POST.captures(verb) {
            push(&mut scratch, P5Kind::Post, Some(JsNumber::ZERO));
            if let Some(action) = scratch.actions.last_mut() {
                action.dead = Some(parse_amount_js(&dead[1], &unit));
            }
            continue;
        }
        if let Some(post) = POST.captures(verb) {
            push(
                &mut scratch,
                P5Kind::Post,
                Some(parse_amount_js(&post[1], &unit)),
            );
            continue;
        }
        if let Some(raise) = RAISE.captures(verb) {
            push(
                &mut scratch,
                P5Kind::Raise,
                Some(parse_amount_js(&raise[2], &unit)),
            );
            if let Some(action) = scratch.actions.last_mut() {
                action.to_total = true;
            }
            continue;
        }
        if let Some(call_bet) = CALL_BET.captures(verb) {
            let amount = parse_amount_js(&call_bet[2], &unit);
            let kind = if CALLS.is_match(&call_bet[1]) {
                P5Kind::Call
            } else if BETS_VERB.is_match(&call_bet[1]) {
                P5Kind::Bet
            } else {
                P5Kind::Raise
            };
            push(&mut scratch, kind, Some(amount));
            continue;
        }
        if FOLDS.is_match(verb) {
            push(&mut scratch, P5Kind::Fold, None);
            continue;
        }
        if CHECKS.is_match(verb) {
            push(&mut scratch, P5Kind::Check, None);
            continue;
        }
        if let Some(collect) = COLLECT.captures(verb) {
            let pot = POT_NUMBER.replace(js::trim(&collect[2]), "").into_owned();
            scratch.collected.push(P5Collect {
                player: player.clone(),
                amount: parse_amount_js(&collect[1], &unit),
                pot_name: Some(pot),
            });
            continue;
        }
        if let Some(shows) = SHOWS.captures(verb) {
            let cards = cards_in(&shows[1]);
            if !cards.is_empty() {
                set_entry(&mut scratch.hole_cards, &player, cards.clone());
                scratch.seats[seat].dealt_in = true;
            }
            let mut action = P5Action::new(scratch.street(), &player, P5Kind::Show);
            action.cards = Some(cards);
            // The description carries its own best-five bracket.
            action.description = shows
                .get(2)
                .map(|description| BEST_FIVE.replace(description.as_str(), "").into_owned())
                .filter(|description| !description.is_empty());
            scratch.actions.push(action);
            continue;
        }
        if MUCKS.is_match(verb) {
            let mut action = P5Action::new(scratch.street(), &player, P5Kind::Muck);
            action.cards = Some(
                get_entry(&scratch.hole_cards, &player)
                    .cloned()
                    .unwrap_or_default(),
            );
            scratch.actions.push(action);
            continue;
        }
        if MODERN_NOISE.is_match(verb) {
            continue;
        }
        scratch
            .warnings
            .push(warning("unknown-line", line, line_number(i)));
    }

    if scratch.seats.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The hand lists no seats."));
    }
    // Four of the six modern hold'em hands print no `collected` line.
    if scratch.collected.is_empty() {
        scratch.collected.append(&mut summary_wins);
    }
    resolve_bare_all_ins(&mut scratch)?;

    let dealt_in = scratch.seats.iter().filter(|seat| seat.dealt_in).count();
    if let Some((stated, paid)) = payout_off(&scratch) {
        return Err(skip(
            SkipReason::PayoutMismatch,
            format!(
                "The summary reports a pot of {} but only {} is accounted for.",
                stated.to_js_string(),
                paid.to_js_string()
            ),
        ));
    }

    let flop = scratch.flop.take().filter(|flop| flop.len() == 3);
    let draft = P5Draft {
        site_id: SITE_ID.to_owned(),
        site_name: SITE_NAME.to_owned(),
        parser_id: SITE_ID.to_owned(),
        parser_version: ACRWPN_PARSER_VERSION.to_owned(),
        hand_id: hand_id.clone(),
        // The modern header states the limit in its own bracket.
        game_label: canonical_game_label(
            variant_from_label(&game_name),
            limit_from_label(&limit),
            false,
        ),
        unit,
        decimals: DecimalStyle::Fixed2,
        small_blind: scratch.small_blind,
        big_blind: scratch.big_blind,
        table_name,
        max_seats: max_seats.unwrap_or_else(|| table_size_for(dealt_in)),
        button_seat,
        played_at,
        tournament: tour.as_ref().map(|tour| P5Tournament {
            id: tour[2].to_owned(),
            name: tournament_name(tour.get(1).map_or("", |m| m.as_str())),
            buy_in_token: "$0".to_owned(),
            level_label: tour[5].to_owned(),
        }),
        seats: scratch.seats,
        actions: scratch.actions,
        flop,
        turn: scratch.turn,
        river: scratch.river,
        collected: scratch.collected,
        stated_pot: None,
        stated_rake: scratch.stated_rake,
        stated_contributions: None,
        hole_cards: scratch.hole_cards,
        raw_text: js::trim(raw).to_owned(),
        warnings: scratch.warnings,
    };
    Ok((draft, format!("WPN{hand_id}")))
}

/* ------------------------------------------------------------------ parser */

/// `firstMatchingLine(text, /^Game started at:/m)`: the first line (of
/// `split(/\r?\n/)`) the `m`-flag pattern matches in, trimmed.
fn first_game_started_line(text: &str) -> Option<&str> {
    split_lines(text)
        .into_iter()
        .find(|line| matches_at_line_start(&DETECT_GAME_STARTED, line))
        .map(js::trim)
}

/// `acrwpnParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct AcrWpnParser;

impl SiteParser for AcrWpnParser {
    fn id(&self) -> &'static str {
        SITE_ID
    }

    fn name(&self) -> &'static str {
        SITE_NAME
    }

    fn version(&self) -> &'static str {
        ACRWPN_PARSER_VERSION
    }

    fn short_deck(&self) -> bool {
        true
    }

    /// 0.95 for a legacy header with a `Game ID:` line (0.3 without), 0.95
    /// for a modern header closing in a UTC stamp, 0.4 for a running pot
    /// line alone.
    fn detect(&self, text: &str) -> u32 {
        let body = p5_recover_encoding(text);
        if LEGACY_HEADER.is_match(first_game_started_line(&body).unwrap_or("")) {
            if matches_at_line_start(&DETECT_GAME_ID, &body) {
                return 950;
            }
            return 300;
        }
        if matches_at_line_start(&DETECT_MODERN, &body) {
            return 950;
        }
        if matches_at_line_start(&DETECT_RUNNING_POT, &body) {
            return 400;
        }
        0
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        let body = p5_recover_encoding(text);
        Ok(split_before_line_starts(&body, &SPLIT_AT)
            .into_iter()
            .map(js::trim)
            .filter(|chunk| wpn_dialect(chunk).is_some())
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        let recovered = p5_recover_encoding(raw);
        let text = js::trim(&recovered);
        let Some(dialect) = wpn_dialect(text) else {
            return Err(skip(
                SkipReason::NoHeader,
                "The chunk matches no WPN header shape.",
            ));
        };
        let (draft, hand_key) = if dialect == WpnDialect::Modern {
            parse_modern(text, ctx)?
        } else {
            parse_legacy(text, ctx, dialect)?
        };
        p5_build_hand(&draft, ctx, &hand_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/acrwpn.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r#"const VERSION = "1.1.0";"#,
            "const ACR_VARIANTS: readonly Variant[] = HOLDEM_OMAHA_SHORTDECK;",
            "const ACR_MODERN_VARIANTS: readonly Variant[] = HOLDEM_OMAHA;",
            r"const LEGACY_HEADER_RE = /^Game started at:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\s*$/;",
            r"const MODERN_HEADER_RE = /^(?:Game\s)?Hand\s#(\d+)\s-\s(.*)$/;",
            r"const SPLIT_RE = /(?=^(?:Game started at:|(?:Game )?Hand #\d+ - ))/m;",
            r"const MODERN_DATE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*UTC\s*$/;",
            r"const CARD_RE = /\b(?:10|[2-9TJQKA])[cdhs]\b/g;",
            "(card.startsWith(\"10\") ? `T${card[2]}` : card)",
            r#"const first = p5RecoverEncoding(chunk).split(/\r?\n/)[0] ?? "";"#,
            r#"return /^Seat \d+: \d+ \(/m.test(chunk) ? "mined" : "legacy";"#,
            "if (text === name || text.startsWith(`${name} `)) {",
            "return seats.map((seat) => seat.name).sort((a, b) => b.length - a.length);",
            r"const groups = [...payload.matchAll(/\[([^\]]*)\]/g)].map((group) => cardsIn(group[1]));",
            "scratch.flop = last.slice(0, 3);",
            "scratch.turn = last[0] ?? null;",
            "scratch.river = last[0] ?? null;",
            r#"if (action.kind === "allin" && action.amount === undefined) {"#,
            "throw new ParseSkip(\"unseated-actor\", `\"${action.player}\" is all-in but is not seated.`);",
            "action.amount = Math.max(0, seat.startingStack - (spent.get(action.player) ?? 0));",
            r#"action.kind === "uncalled""#,
            "? -(action.amount ?? 0)",
            ": (action.amount ?? 0) + (action.dead ?? 0);",
            r"const LEGACY_GAME_RE = /^(.*?)\s*\(([^()]*)\)\s*(?:(\d+)\s*-\s*max)?\s*$/i;",
            r"const idLine = lines.find((line) => /^Game ID:/.test(line.trim()));",
            r"const id = idLine.trim().match(/^Game ID:\s*(\S+)\s+(\S+)\/(\S+)\s*(.*)$/);",
            r"const tableNumber = table.match(/,\s*Table\s+(\d+)\s*$/);",
            "table = table.slice(0, tableNumber.index).trim();",
            r"const maxInName = table.match(/(\d+)\s*-\s*max/i);",
            "maxSeats: game[3] ? Number(game[3]) : maxInName ? Number(maxInName[1]) : null,",
            r"/^(?:is timed out\.?|sitting out|wait BB|is disconnected and ALL IN\.?|mucks cards|is connected|is disconnected|stands up|sits down)$/i;",
            r#"throw new ParseSkip("no-header", "The chunk has no readable `Game started at:` / `Game ID:` pair.");"#,
            "unsupportedGameSkip(probe.gameName) ?? unsupportedVariantSkip(probe.gameName, ACR_VARIANTS);",
            "const variant = variantFromLabel(probe.gameName);",
            r"const summaryIndex = lines.findIndex((line) => /^-+\s*Summary\s*-+$/i.test(line.trim()));",
            r#"throw new ParseSkip("truncated-hand", "The hand has no `------ Summary ------` block.");"#,
            r".find((line) => /^Pot:/.test(line));",
            r#"throw new ParseSkip("truncated-hand", "The summary block has no `Pot:` line.");"#,
            r"const isTournament = !/\.\s*Rake/i.test(potLine);",
            r#"throw new ParseSkip("tournament-in-cash-mode", "Tournament hand skipped.");"#,
            r"/^Pot:\s*([\d.]+)(?:\.\s*Rake\s*([\d.]+))?(?:\.\s*JP fee\s*([\d.]+))?\s*$/i,",
            "throw new ParseSkip(\"truncated-hand\", `Unreadable pot line \"${potLine}\".`);",
            "pot[2] === undefined ? null : parseAmount(pot[2], unit) + parseAmount(pot[3], unit);",
            r"const seat = line.trim().match(/^Seat\s+(\d+):\s+(.*?)\s+\(([\d.,]+)\)\.?\s*$/);",
            "throw new ParseSkip(\"duplicate-player\", `\"${player.name}\" is seated twice.`);",
            r"const button = line.trim().match(/^Seat\s+(\d+)\s+is the button$/);",
            r#"throw new ParseSkip("no-players", "The hand lists no seats.");"#,
            r"if (/^(?:Game started at:|Game ID:|Seat\s)/.test(line)) {",
            r"const marker = line.match(/^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*\s*:?(.*)$/i);",
            r"const uncalled = line.match(/^Uncalled bet\s*\(([\d.,]+)\)\s*returned to\s*(.*)$/i);",
            "`An uncalled bet of ${uncalled[1]} is returned to a player the export did not name.`,",
            r"if (/^Game ended at:/.test(line)) {",
            r"const acted = line.match(/^Player\s(.*)$/);",
            r#"scratch.warnings.push({ code: "unknown-line", message: line, line: i + 1 });"#,
            r"if (LEGACY_NOISE_RE.test(verb) || /^(?:folds|checks)$/i.test(verb)) {",
            "throw new ParseSkip(\"unnamed-actor\", `The export did not name the player in \"${line}\".`);",
            r#"if (verb === "received a card.") {"#,
            r"const upcard = verb.match(/^received card:\s*\[([^\]]*)\]$/i);",
            "seat.dealtCards = [...seat.dealtCards, ...cardsIn(upcard[1])];",
            r"const blind = verb.match(/^has\s(small|big)\sblind\s*\(([\d.,]+)\)$/i);",
            r"if (/^small$/i.test(blind[1])) {",
            r"const dead = verb.match(/^posts\s*\(([\d.,]+)\)\s*as a dead bet$/i);",
            r#"push("post", 0, parseAmount(dead[1], unit));"#,
            r"/^(posts ante|ante|posts|straddle|bring in|calls|raises|bets|caps|allin)\s*\(([\d.,]+)\)$/i,",
            r"if (/^allin$/i.test(verb)) {",
            r"if (/^folds$/i.test(verb)) {",
            r"if (/^checks$/i.test(verb)) {",
            r#""cancelled-hand","#,
            r#""No cards were dealt; the table cancelled the hand before the deal.","#,
            r"const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;",
            r"if (!line || /^(?:Pot:|Board:|Game ended at:)/i.test(line)) {",
            r"if (/^Board:/i.test(line)) {",
            "if (summaryBoard.length > 0 && scratch.flop === null) {",
            r"const entry = line.match(/^\*?Player\s(.*)$/);",
            r#"scratch.warnings.push({ code: "unknown-summary-line", message: line, line: i + 1 });"#,
            "const tail = player === null ? entry[1] : entry[1].slice(player.length);",
            r"const bets = tail.match(new RegExp(String.raw`Bets:\s*${NUM}`));",
            r"const collects = tail.match(new RegExp(String.raw`Collects:\s*${NUM}`));",
            "if (parseAmount(bets?.[1], unit) === 0 && parseAmount(collects?.[1], unit) === 0) {",
            "throw new ParseSkip(\"unseated-actor\", `The summary reports money for an unseated player: \"${line}\".`);",
            "if (collects && parseAmount(collects[1], unit) > 0) {",
            r"const cards = tail.match(/\[([^\]]*)\]/);",
            "if (revealed.length === 2 && !scratch.holeCards.has(player)) {",
            r"if (/\bshows:/i.test(tail)) {",
            r"description: tail.match(/shows:\s*(.*?)\s*(?:\[|\.?\s*Bets:)/i)?.[1] || undefined,",
            "} else if (scratch.seatByName.get(player)?.dealtIn) {",
            "if (allBetsZero && scratch.statedContributions.size > 0) {",
            r#"code: "numeric-player-ids","#,
            r#""Every seat is a numeric id rather than a screen name, and no seat is " +"#,
            r#""marked as the hero; the names are not usable as player identities.","#,
            r#"siteName: "ACR / Winning Poker Network","#,
            r#"gameLabel: canonicalGameLabel(variant, variant === "omaha" ? "pl" : "nl"),"#,
            r#"decimals: "fixed2","#,
            "? `${header.tableName} ${header.tableNumber}`.trim()",
            ": header.tableName || null,",
            "maxSeats: header.maxSeats ?? ([2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn),",
            r#"id: "unknown","#,
            r#"name: header.tableName.replace(/[()]/g, "").trim() || null,"#,
            r#"buyInToken: "$0","#,
            r#"levelLabel: "1","#,
            "flop: scratch.flop && scratch.flop.length === 3 ? scratch.flop : null,",
            "statedContributions: scratch.statedContributions.size > 0 ? scratch.statedContributions : null,",
            "rawText: raw.trim(),",
            "if (scratch.statedPayout !== null && Math.abs(paid - scratch.statedPayout) > 1) {",
            "`The summary reports a pot of ${scratch.statedPayout} but the per-player ` +",
            "`columns only account for ${paid} of it.`,",
            "return { draft, handKey: `WPN${header.handId}` };",
            r#"throw new ParseSkip("no-header", "The chunk has no readable `Hand #` header.");"#,
            r"/^(?:(.*?)\s)?Tournament\s#(\S+)\s-\s(.+?)\(([^)]*)\)\s-\sLevel\s(\S+)\s*\(([^)]*)\)\s*-/,",
            r"const cash = payload.match(/^(.+?)\(([^)]*)\)\s-\s(\S+)\/(\S+)\s-/);",
            "throw new ParseSkip(\"no-header\", `Unreadable modern header payload \"${payload}\".`);",
            "unsupportedGameSkip(gameName) ?? unsupportedVariantSkip(gameName, ACR_MODERN_VARIANTS);",
            "if (ctx.options.cashOnly && tour) {",
            r"if (/^\*\*\*\s*RUN IT TWICE/im.test(raw)) {",
            r#"throw new ParseSkip("run-it-twice", "Run-it-twice hands are not supported yet.");"#,
            r#"const stakes = tour[6].split("/");"#,
            "scratch.bigBlind = parseAmount(stakes[1] ?? stakes[0], unit);",
            r"const table = lines[1]?.trim().match(/^(.*?)\s*(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?\s*$/);",
            r#"tableName = table[1].replace(/^Table\s+'(.*)'$/, "$1").trim() || null;"#,
            "buttonSeat = table[3] ? Number(table[3]) : null;",
            "for (let i = table ? 2 : 1; i < lines.length; i += 1) {",
            r"const seat = line.match(/^Seat\s+(\d+):\s+(.*?)\s+\(\$?([\d.,]+)\)(\s+is sitting out)?\s*$/);",
            "dealtIn: !seat[4],",
            r"if (/^\*\*\*\s*SUMMARY/i.test(line)) {",
            r"if (/^(?:Main|Side) pot\b/i.test(line) && !inSummary) {",
            r"if (/^\*\*\*\s*HOLE CARDS/i.test(line)) {",
            r"if (/^\*\*\*\s*SHOW\s?DOWN/i.test(line)) {",
            r"const marker = line.match(/^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*(.*)$/i);",
            r"/^Total pot\s+\$?([\d.,]+)(?:\s*\|\s*Rake\s+\$?([\d.,]+))?(?:\s*\|\s*JP Fee\s+\$?([\d.,]+))?/i,",
            r"if (/^Board\s*\[/i.test(line)) {",
            r"const summarySeat = line.match(/^Seat\s+(\d+):\s+(.*)$/);",
            "const player = matchName(summarySeat[2], sortedNames(scratch.seats));",
            r"const won = tail.match(/\bwon\s+\$?([\d.,]+)/i);",
            r"const dealt = line.match(/^Dealt to\s+(.*?)\s+\[([^\]]*)\]\s*$/);",
            r"const uncalled = line.match(/^Uncalled bet\s*\(\$?([\d.,]+)\)\s*returned to\s*(.*)$/i);",
            "throw new ParseSkip(\"unnamed-actor\", `An uncalled bet is returned to \"${player}\".`);",
            r"const allIn = /\sand is all-in$/i.test(verb);",
            r#"verb = verb.replace(/\sand is all-in$/i, "");"#,
            "scratch.actions.push({ street: scratch.street, player, kind, amount, allIn, ...extra });",
            r"const blind = verb.match(/^posts the (small|big) blind\s+\$?([\d.,]+)$/i);",
            r"const ante = verb.match(/^posts ante\s+\$?([\d.,]+)$/i);",
            r"const deadPost = verb.match(/^posts dead\s+\$?([\d.,]+)$/i);",
            r#"push("post", 0, { dead: parseAmount(deadPost[1], unit) });"#,
            r"const post = verb.match(/^posts\s+\$?([\d.,]+)$/i);",
            r"const raise = verb.match(/^raises\s+\$?([\d.,]+)\s+to\s+\$?([\d.,]+)$/i);",
            r#"push("raise", parseAmount(raise[2], unit), { toTotal: true });"#,
            r"const callBet = verb.match(/^(calls|bets|caps)\s+\$?([\d.,]+)$/i);",
            r#"const kind = /^calls$/i.test(callBet[1]) ? "call" : /^bets$/i.test(callBet[1]) ? "bet" : "raise";"#,
            r"const collect = verb.match(/^collected\s+\$?([\d.,]+)\s+from\s+(.*)$/i);",
            r#"potName: collect[2].trim().replace(/\s+\d+$/, ""),"#,
            r"const shows = verb.match(/^shows\s*\[([^\]]*)\](?:\s*\((.*)\))?$/i);",
            r#"description: shows[2]?.replace(/\s*\[[^\]]*\]\s*$/, "") || undefined,"#,
            r"if (/^(?:does not show|doesn't show|mucks hand|mucks)$/i.test(verb)) {",
            r"if (/^(?:is sitting out|sits out|has timed out|is disconnected|is connected|said,)/i.test(verb)) {",
            "scratch.collected.push(...summaryWins);",
            "gameLabel: canonicalGameLabel(variantFromLabel(gameName), limitFromLabel(limit)),",
            "maxSeats: maxSeats ?? ([2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn),",
            r#"name: (tour[1] ?? "").replace(/[()]/g, "").trim() || null,"#,
            "levelLabel: tour[5],",
            "`The summary reports a pot of ${scratch.statedPayout} but only ${paid} is ` +",
            r#""accounted for.","#,
            "return { draft, handKey: `WPN${handId}` };",
            "shortDeck: true,",
            r#"if (LEGACY_HEADER_RE.test(firstMatchingLine(body, /^Game started at:/m) ?? "")) {"#,
            r"if (/^Game ID:\s*\S+\s+\S+\/\S+/m.test(body)) {",
            "return 0.95;",
            "return 0.3;",
            r"if (/^(?:Game\s)?Hand\s#\d+\s-\s.*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*UTC\s*$/m.test(body)) {",
            r"if (/^(?:Main|Side) pot\s+\S+\s*\|\s*Rake\s/m.test(body)) {",
            "return 0.4;",
            ".split(SPLIT_RE)",
            ".map((chunk) => chunk.trim())",
            ".filter((chunk) => wpnDialect(chunk) !== null);",
            "const text = p5RecoverEncoding(raw).trim();",
            r#"throw new ParseSkip("no-header", "The chunk matches no WPN header shape.");"#,
            "return p5BuildHand(parsed.draft, ctx, parsed.handKey);",
            r"for (const line of text.split(/\r?\n/)) {",
            "if (pattern.test(line)) {",
            "return line.trim();",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    #[test]
    fn cards_and_names() {
        assert_eq!(cards_in("[10d Ah 2c] 10x 1h"), ["Td", "Ah", "2c"]);
        let names = sorted_names(&[
            P5Seat {
                seat: JsNumber::from_u64(1),
                name: "Sean".to_owned(),
                starting_stack: JsNumber::ZERO,
                is_hero: false,
                dealt_in: true,
                dealt_cards: Vec::new(),
            },
            P5Seat {
                seat: JsNumber::from_u64(2),
                name: "Sean LeBlanc".to_owned(),
                starting_stack: JsNumber::ZERO,
                is_hero: false,
                dealt_in: true,
                dealt_cards: Vec::new(),
            },
        ]);
        assert_eq!(names, ["Sean LeBlanc", "Sean"]);
        assert_eq!(
            match_name("Sean LeBlanc folds", &names),
            Some("Sean LeBlanc")
        );
        assert_eq!(match_name("Sean", &names), Some("Sean"));
        assert_eq!(match_name("SeanX folds", &names), None);
        assert_eq!(table_size_for(3), JsNumber::from_u64(6));
        assert_eq!(table_size_for(11), JsNumber::from_u64(11));
        assert_eq!(tournament_name("(Turbo) "), Some("Turbo".to_owned()));
        assert_eq!(tournament_name("()"), None);
    }

    #[test]
    fn dialects() {
        assert_eq!(
            wpn_dialect("Game started at: 2014/3/9 19:37:22\nGame ID: 1 0.05/0.10 T (Hold'em)"),
            Some(WpnDialect::Legacy)
        );
        assert_eq!(
            wpn_dialect("Game started at: 2014/3/9 19:37:22\nSeat 1: 123 (5)"),
            Some(WpnDialect::Mined)
        );
        assert_eq!(
            wpn_dialect("Hand #1 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC"),
            Some(WpnDialect::Modern)
        );
        assert_eq!(wpn_dialect("PokerStars Hand #1: x"), None);
    }
}
