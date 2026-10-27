//! `weplay`: WePlay (`web/src/lib/parsers/weplay.ts`).
//!
//! WePlay text is first normalized into the app's standard text - the
//! rewrites of the old converter, every one of them forced by a real broken
//! hand in `weplay-hh/` (ghost antes, phantom river walks, zero-stack actors,
//! short covering all-ins written as raises, hidden `##` showdown cards) - and
//! that text is then read by [`parse_standard_hand`]. `meta.rawText` is the
//! WePlay original, not the rewrite.
//!
//! **Arithmetic is JavaScript's.** The normalizer computes in doubles:
//! `Math.round(Number(raw) * minorUnits)`, `to - raiseBy`, `Math.max`,
//! `units % minorUnits`, `(units / minorUnits).toFixed(2)`. Every one of
//! those is [`JsNumber`] here, so an amount the corpus never printed (a
//! thousandth, a twenty-digit stack) still rewrites to the bytes the
//! TypeScript writes.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `weplay.ts`). The one lookahead, the hand split, is written out as code;
//! the zero-stack probe, a `RegExp` built from an escaped player name, is a
//! literal prefix test.
//!
//! The TypeScript's main loop also keeps a per-street `commitment` map that it
//! never reads (only `findIntegritySkip`'s own map is read); it has no effect
//! on the output and is not ported.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use super::shared::ps_gg_hand::split_before_line_starts;
use crate::detect::{ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError};
use crate::js::{self, JsNumber};
use crate::phf::PhfHand;
use crate::phf::serialize::{StandardContext, parse_standard_hand};

/// `WEPLAY_PARSER_VERSION`.
pub const WEPLAY_PARSER_VERSION: &str = "2.0.0";

/// `AMOUNT`.
const AMOUNT: &str = r"(?:\$|€|£)?(\d+(?:\.\d+)?)";

/// A `String.raw` template with `${AMOUNT}` filled in, compiled with
/// JavaScript semantics.
fn amount_regex(template: &str, flags: &str) -> Regex {
    js::regex::js_regex(&template.replace("${AMOUNT}", AMOUNT), flags)
}

macro_rules! amount_regex_lazy {
    ($template:expr, $flags:expr) => {
        LazyLock::new(|| amount_regex($template, $flags))
    };
}

/// `HAND_SPLIT_REGEX`'s lookahead body.
static HAND_START: LazyLock<Regex> = crate::js_regex_lazy!(r"^Weplay Hand #\d+:", "");
static DETECT: LazyLock<Regex> = crate::js_regex_lazy!(r"(?:^|\n)\uFEFF?Weplay Hand #\d+:", "");
static RAISE_LINE: LazyLock<Regex> = amount_regex_lazy!(
    r"^(.+?): raises ${AMOUNT} to ${AMOUNT}( and is all-in)?$",
    ""
);
static STREET_MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (?:FIRST |SECOND )?(?:FLOP|TURN|RIVER)\b", "");
static SHOWS_HIDDEN: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?): shows \[.*#.*\].*$", "");
static SEAT_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+\d+:\s+(.+?)\s+\((.+) in chips\)$", "");
static PLAYER_ACTION: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?): (?:posts|raises|calls|bets|folds|checks|shows|mucks|doesn't show)",
    ""
);
static COLLECTED: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?) collected ", "");
static UNCALLED: LazyLock<Regex> =
    amount_regex_lazy!(r"^Uncalled bet \(${AMOUNT}\) returned to (.+)$", "");
static HEADER_STAKES: LazyLock<Regex> = amount_regex_lazy!(r"\(${AMOUNT}\/${AMOUNT}\)", "");

static TOURNAMENT: LazyLock<Regex> = crate::js_regex_lazy!(r"Tournament", "i");
static TABLE_ID: LazyLock<Regex> = crate::js_regex_lazy!(r"\(\d+\)", "");
static MONEY_3: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+\(Money 3\)", "");
static SPACE_RUN: LazyLock<Regex> = crate::js_regex_lazy!(r"\s{2,}", "g");
static RAKE: LazyLock<Regex> = crate::js_regex_lazy!(r"Rake\s+([$€£\d.]+)", "");
static FOLDED: LazyLock<Regex> = crate::js_regex_lazy!(r"folded", "i");
static SHOWED: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+showed \[[^\]]*\]", "i");
static LOST_WITH: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+and lost with .+$", "i");
static SHOWED_HIDDEN: LazyLock<Regex> = crate::js_regex_lazy!(r"showed \[[^\]]*#[^\]]*\]", "i");
static HEADER: LazyLock<Regex> = crate::js_regex_lazy!(r"^Weplay Hand #(\d+):\s*(.+)$", "");
static UTC: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+UTC$", "");
static TIME_BANK: LazyLock<Regex> = crate::js_regex_lazy!(r"\bactivates time bank\b", "i");
static DECLINES_STRADDLE: LazyLock<Regex> = crate::js_regex_lazy!(r"\bdeclines straddle\b", "i");
static RUN_TWO_TIMES: LazyLock<Regex> = crate::js_regex_lazy!(r"\bwas run two times\b", "i");
static DISCONNECTED: LazyLock<Regex> = crate::js_regex_lazy!(r"\bis disconnected\b", "i");
static CONNECTED: LazyLock<Regex> = crate::js_regex_lazy!(r"\bis connected\b", "i");
static OMAHA: LazyLock<Regex> = crate::js_regex_lazy!(r"\bOmaha\b", "i");
static PLO: LazyLock<Regex> = crate::js_regex_lazy!(r"\bPLO\b", "i");
static BOMB_POT_MARKER: LazyLock<Regex> = crate::js_regex_lazy!(r"\*\*\*\s*BOMB POT\s*\*\*\*", "i");
static POSTS_BOMB_POT: LazyLock<Regex> = crate::js_regex_lazy!(r"posts bomb pot", "i");
static POSTS_ANTE: LazyLock<Regex> = crate::js_regex_lazy!(r"posts the ante", "i");
static POSTS_BLIND: LazyLock<Regex> = crate::js_regex_lazy!(r"posts (?:small|big) blind", "i");
static ALL_IN_OR_FOLD: LazyLock<Regex> = crate::js_regex_lazy!(r"All-in or Fold", "i");
static BLIND_AMOUNT: LazyLock<Regex> =
    amount_regex_lazy!(r": posts (?:small|big) blind ${AMOUNT}", "");
static POST_AMOUNT: LazyLock<Regex> = amount_regex_lazy!(r": posts ${AMOUNT}", "");
static BET_AMOUNT: LazyLock<Regex> = amount_regex_lazy!(r": bets ${AMOUNT}", "");
static HAS_BIG_BLIND: LazyLock<Regex> = crate::js_regex_lazy!(r": posts big blind ", "i");
static HAS_SMALL_BLIND: LazyLock<Regex> = crate::js_regex_lazy!(r": posts small blind ", "i");
static SHORT_SB: LazyLock<Regex> =
    amount_regex_lazy!(r": posts small blind ${AMOUNT} and is all-in", "gi");
static SHORT_BB: LazyLock<Regex> =
    amount_regex_lazy!(r": posts big blind ${AMOUNT} and is all-in", "gi");
static ZERO_STACK: LazyLock<Regex> = crate::js_regex_lazy!(r"^[$€£]?0(?:\.0+)?$", "");
static FLOP_MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (?:FIRST |SECOND )?FLOP\b", "");
static TURN_MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (?:FIRST |SECOND )?TURN\b", "");
static RIVER_MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (?:FIRST |SECOND )?RIVER\b", "");
static ANTE: LazyLock<Regex> = amount_regex_lazy!(r"^(.+?): posts the ante ${AMOUNT}", "");
static MONEY_ACTION: LazyLock<Regex> =
    crate::js_regex_lazy!(r": (?:posts|raises|calls|bets|shows|collected)", "");
static BLIND: LazyLock<Regex> = amount_regex_lazy!(
    r"^(.+?): posts (small|big) blind ${AMOUNT}( and is all-in)?$",
    ""
);
static CALL: LazyLock<Regex> = amount_regex_lazy!(r"^(.+?): calls ${AMOUNT}( and is all-in)?$", "");
static BET: LazyLock<Regex> = amount_regex_lazy!(r"^(.+?): bets ${AMOUNT}", "");
static DEALT_TO: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to ", "");
static BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board \[", "");

/* ---------------------------------------------------------------- helpers */

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    for piece in &mut pieces[..last] {
        *piece = piece.strip_suffix('\r').unwrap_or(piece);
    }
    pieces
}

/// `text.replace(/^\uFEFF/, "")` (a literal BOM in the source): one leading byte-order mark.
fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// `MoneyContext`.
#[derive(Debug, Clone)]
struct Money {
    symbol: &'static str,
    minor_units: u64,
}

/// `parseUnits(raw, minorUnits)`: `Math.round(Number(raw) * minorUnits)`.
fn parse_units(raw: &str, money: &Money) -> JsNumber {
    (JsNumber::parse(raw) * JsNumber::from_u64(money.minor_units)).round()
}

/// `formatUnits`: round amounts lose their decimals, everything else gets
/// exactly two.
fn format_units(units: JsNumber, money: &Money) -> String {
    let symbol = money.symbol;
    if money.minor_units == 1 {
        return format!("{symbol}{}", units.to_js_string());
    }
    let divided = units / JsNumber::from_u64(money.minor_units);
    if units.is_multiple_of(money.minor_units) {
        format!("{symbol}{}", divided.to_js_string())
    } else {
        format!("{symbol}{}", divided.to_fixed(2))
    }
}

/// `moneyContextFor`.
fn money_context_for(chunk: &str, header: &str) -> Money {
    if TOURNAMENT.is_match(header) {
        // Stacks and bets are chips; the buy-in in the header is the only
        // real money.
        return Money {
            symbol: "",
            minor_units: 1,
        };
    }
    let symbol = if chunk.contains('€') {
        "€"
    } else if chunk.contains('£') {
        "£"
    } else {
        "$"
    };
    Money {
        symbol,
        minor_units: 100,
    }
}

/// `normalizeTableLine`.
fn normalize_table_line(line: &str) -> String {
    let line = TABLE_ID.replacen(line, 1, "");
    let line = MONEY_3.replacen(&line, 1, "");
    let line = SPACE_RUN.replace_all(&line, " ");
    js::trim(&line).to_owned()
}

/// `normalizeSummaryLine`: WePlay's `Total pot $11 | Rake $0.55 ` with the
/// GG fee columns added, always zero.
fn normalize_summary_line(line: &str, money: &Money) -> String {
    let before_pipe = js::trim(line.split('|').next().unwrap_or(""));
    let zero = format!("{}0", money.symbol);
    let rake = RAKE
        .captures(line)
        .map_or_else(|| zero.clone(), |c| c[1].to_owned());
    format!(
        "{before_pipe} | Rake {rake} | Jackpot {zero} | Bingo {zero} | Fortune {zero} | Tax {zero}"
    )
}

/// `line.replace(/\s+showed \[[^\]]*\]/i, "").replace(/\s+and lost with .+$/i, "").trim()`.
fn drop_reveal(line: &str) -> String {
    let line = SHOWED.replacen(line, 1, "");
    let line = LOST_WITH.replacen(&line, 1, "");
    js::trim(&line).to_owned()
}

/// `scrubSummarySeatLine`: a hidden `##` reveal, or any reveal by a folder,
/// is dropped.
fn scrub_summary_seat_line(line: &str) -> String {
    if !line.starts_with("Seat ") {
        return line.to_owned();
    }
    if FOLDED.is_match(line) || SHOWED_HIDDEN.is_match(line) {
        return drop_reveal(line);
    }
    line.to_owned()
}

/// `normalizeHeader`: `Weplay Hand #N: …` → `Poker Hand #HDN: …` without the
/// trailing ` UTC`; the id is `unknown` when the line is not a header.
fn normalize_header(line: &str) -> (String, String) {
    let Some(c) = HEADER.captures(line) else {
        return (line.to_owned(), "unknown".to_owned());
    };
    let hand_id = c[1].to_owned();
    let payload = UTC.replacen(&c[2], 1, "");
    // The "HD" prefix keeps WePlay ids from colliding with real GG ids.
    (format!("Poker Hand #HD{hand_id}: {payload}"), hand_id)
}

/// `shouldDropLine`.
fn should_drop_line(line: &str) -> bool {
    let trimmed = js::trim(line);
    trimmed.contains("has timed out")
        || trimmed.contains("leaves the table")
        || trimmed.contains("joins the table")
        || trimmed.contains("sits out")
        || trimmed.contains("while being disconnected")
        // Time-bank notices are UI events; GG has no equivalent line.
        || TIME_BANK.is_match(trimmed)
        // GG has no equivalent lines; the runout is already in the
        // FIRST/SECOND markers.
        || DECLINES_STRADDLE.is_match(trimmed)
        || RUN_TWO_TIMES.is_match(trimmed)
        || DISCONNECTED.is_match(trimmed)
        || CONNECTED.is_match(trimmed)
}

/// `isOmahaHand`.
pub fn is_omaha_hand(header_or_chunk: &str) -> bool {
    OMAHA.is_match(header_or_chunk) || PLO.is_match(header_or_chunk)
}

/// `isBombPotHand`: a `*** BOMB POT ***` marker, a `posts bomb pot` line, or
/// antes with no blind.
pub fn is_bomb_pot_hand(chunk: &str) -> bool {
    if BOMB_POT_MARKER.is_match(chunk) || POSTS_BOMB_POT.is_match(chunk) {
        return true;
    }
    POSTS_ANTE.is_match(chunk) && !POSTS_BLIND.is_match(chunk)
}

/// `parseHeaderStakes`.
fn parse_header_stakes(header: &str, money: &Money) -> Option<(JsNumber, JsNumber)> {
    let c = HEADER_STAKES.captures(header)?;
    Some((parse_units(&c[1], money), parse_units(&c[2], money)))
}

/// `normalizeShowsLine`: a showdown reveal with a hidden `##` card is no
/// reveal.
fn normalize_shows_line(line: &str) -> String {
    match SHOWS_HIDDEN.captures(line) {
        Some(c) => format!("{}: doesn't show hand", &c[1]),
        None => line.to_owned(),
    }
}

/// `normalizeLine`.
fn normalize_line(line: &str, money: &Money) -> String {
    if js::trim(line).is_empty() {
        return line.to_owned();
    }
    if line.starts_with("Table ") {
        return normalize_table_line(line);
    }
    if line == "*** SHOW DOWN ***" {
        return "*** SHOWDOWN ***".to_owned();
    }
    if line.starts_with("Total pot") {
        return normalize_summary_line(line, money);
    }
    if line.starts_with("Seat ") {
        return scrub_summary_seat_line(line);
    }
    normalize_shows_line(line)
}

/// `updateCurrentBetFromLine`.
fn update_current_bet_from_line(line: &str, current_bet: JsNumber, money: &Money) -> JsNumber {
    if let Some(c) = BLIND_AMOUNT.captures(line) {
        return current_bet.max_of(parse_units(&c[1], money));
    }
    if let Some(c) = POST_AMOUNT.captures(line) {
        return current_bet.max_of(parse_units(&c[1], money));
    }
    if let Some(c) = BET_AMOUNT.captures(line) {
        return parse_units(&c[1], money);
    }
    current_bet
}

/// What `rewriteRaiseLine` returns.
struct Raised {
    line: String,
    current_bet: JsNumber,
}

/// `rewriteRaiseLine`: WePlay writes `raises <chips added> to <total>`, GG
/// `raises <amount over the current bet> to <total>`.
fn rewrite_raise_line(line: &str, current_bet: JsNumber, money: &Money) -> Option<Raised> {
    let c = RAISE_LINE.captures(line)?;
    let player = &c[1];
    let raise_by = parse_units(&c[2], money);
    let to = parse_units(&c[3], money);
    let all_in_suffix = c.get(4).map_or("", |m| m.as_str());
    let implied_previous = to - raise_by;

    // Short cover all-in written as raise-to below current bet → call all-in.
    if !all_in_suffix.is_empty() && to.less_than(current_bet) {
        return Some(Raised {
            line: format!(
                "{player}: calls {} and is all-in",
                format_units(raise_by, money)
            ),
            current_bet,
        });
    }

    // Already GG-like: Y - X matches the tracked previous bet.
    if implied_previous.strict_equals(current_bet) {
        return Some(Raised {
            line: line.to_owned(),
            current_bet: to,
        });
    }

    let over = to - current_bet;
    if over.less_than(JsNumber::ZERO) || over.strict_equals(JsNumber::ZERO) {
        return Some(Raised {
            line: line.to_owned(),
            current_bet: current_bet.max_of(to),
        });
    }

    Some(Raised {
        line: format!(
            "{player}: raises {} to {}{all_in_suffix}",
            format_units(over, money),
            format_units(to, money)
        ),
        current_bet: to,
    })
}

/// `extractSeatedPlayers`: name → stack text, in first-seen order (a later
/// line for the same name replaces the stack, as `Map.set` does).
fn extract_seated_players<S: AsRef<str>>(lines: &[S]) -> Vec<(String, String)> {
    let mut seats: Vec<(String, String)> = Vec::new();
    for line in lines {
        let Some(c) = SEAT_LINE.captures(line.as_ref()) else {
            continue;
        };
        let (name, stack) = (&c[1], &c[2]);
        match seats.iter_mut().find(|(seated, _)| seated == name) {
            Some(entry) => stack.clone_into(&mut entry.1),
            None => seats.push((name.to_owned(), stack.to_owned())),
        }
    }
    seats
}

/// `new RegExp(`^${escapeRegExp(name)}: (?:posts|raises|calls|bets)\\b`).test(line)`.
fn is_money_action_by(line: &str, name: &str) -> bool {
    let Some(rest) = line
        .strip_prefix(name)
        .and_then(|rest| rest.strip_prefix(": "))
    else {
        return false;
    };
    ["posts", "raises", "calls", "bets"].iter().any(|verb| {
        rest.strip_prefix(verb).is_some_and(|after| {
            !after
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    })
}

/// A refusal of the normalizer (`Skip`).
fn refuse(reason: SkipReason, message: impl Into<String>) -> ParseSkip {
    ParseSkip::new(reason, message)
}

/// `getEarlySkip`: cheap structural checks made before any rewriting.
fn early_skip(chunk: &str, header: &str, money: &Money) -> Option<ParseSkip> {
    if ALL_IN_OR_FOLD.is_match(chunk) {
        return Some(refuse(
            SkipReason::AllInOrFoldTable,
            "All-in or Fold table.",
        ));
    }

    if HAS_BIG_BLIND.is_match(chunk) && !HAS_SMALL_BLIND.is_match(chunk) {
        return Some(refuse(
            SkipReason::BbOnlyWalk,
            "Big blind posted without a small blind (BB-only walk).",
        ));
    }

    if let Some((small_blind, big_blind)) = parse_header_stakes(header, money) {
        for c in SHORT_SB.captures_iter(chunk) {
            if parse_units(&c[1], money).less_than(small_blind) {
                return Some(refuse(
                    SkipReason::ShortAllinSmallBlind,
                    "Small blind posted all-in for less than the stated blind.",
                ));
            }
        }
        for c in SHORT_BB.captures_iter(chunk) {
            if parse_units(&c[1], money).less_than(big_blind) {
                return Some(refuse(
                    SkipReason::ShortAllinBigBlind,
                    "Big blind posted all-in for less than the stated blind.",
                ));
            }
        }
    }

    let lines = split_lines(chunk);
    let zero_stack: Vec<String> = extract_seated_players(&lines)
        .into_iter()
        .filter(|(_, stack)| ZERO_STACK.is_match(js::trim(stack)))
        .map(|(name, _)| name)
        .collect();
    for line in &lines {
        for name in &zero_stack {
            if is_money_action_by(line, name) {
                return Some(refuse(
                    SkipReason::ZeroStackActor,
                    format!("A player with a zero stack acted ({name})."),
                ));
            }
        }
    }
    None
}

/// `findIntegritySkip`: structural checks on the rewritten lines.
#[allow(clippy::too_many_lines)]
fn integrity_skip(lines: &[String], header: &str, money: &Money) -> Option<ParseSkip> {
    let seated: HashSet<String> = extract_seated_players(lines)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let stakes = parse_header_stakes(header, money);

    let mut saw_flop = false;
    let mut saw_turn = false;
    let mut saw_first_flop = false;
    let mut saw_first_turn = false;
    let mut saw_second_flop = false;
    let mut saw_second_turn = false;
    let mut in_summary = false;
    // `currentBet` is tracked by the TypeScript too, and never read here.
    let mut preflop = true;
    let mut commitment: HashMap<String, JsNumber> = HashMap::new();
    let committed = |map: &HashMap<String, JsNumber>, player: &str| {
        map.get(player).copied().unwrap_or(JsNumber::ZERO)
    };

    for line in lines {
        let line = line.as_str();
        if line.starts_with("*** SUMMARY") {
            in_summary = true;
            continue;
        }
        if in_summary {
            continue;
        }

        if FLOP_MARKER.is_match(line) {
            saw_flop = true;
            if line.contains("FIRST") {
                saw_first_flop = true;
            }
            if line.contains("SECOND") {
                saw_second_flop = true;
            }
            commitment.clear();
            preflop = false;
            continue;
        }
        if TURN_MARKER.is_match(line) {
            let is_second = line.contains("SECOND");
            if !is_second && !saw_flop && !saw_first_flop {
                return Some(refuse(
                    SkipReason::TurnWithoutFlop,
                    "A turn was dealt without a flop.",
                ));
            }
            if is_second && !saw_second_flop && !saw_flop {
                return Some(refuse(
                    SkipReason::TurnWithoutFlop,
                    "A second turn was dealt without a flop.",
                ));
            }
            saw_turn = true;
            if line.contains("FIRST") {
                saw_first_turn = true;
            }
            if is_second {
                saw_second_turn = true;
            }
            commitment.clear();
            continue;
        }
        if RIVER_MARKER.is_match(line) {
            let is_second = line.contains("SECOND");
            if !is_second && !saw_turn && !saw_first_turn {
                return Some(refuse(
                    SkipReason::RiverWithoutTurn,
                    "A river was dealt without a turn.",
                ));
            }
            if is_second && !saw_second_turn && !saw_turn && !saw_first_turn {
                return Some(refuse(
                    SkipReason::RiverWithoutTurn,
                    "A second river was dealt without a turn.",
                ));
            }
            commitment.clear();
            continue;
        }

        if let Some(c) = UNCALLED.captures(line) {
            let amount = parse_units(&c[1], money);
            let player = &c[2];
            if amount.greater_than(committed(&commitment, player)) {
                return Some(refuse(
                    SkipReason::UncalledExceedsCommitment,
                    format!("Uncalled bet is larger than what {player} committed."),
                ));
            }
            continue;
        }

        if let Some(c) = ANTE.captures(line) {
            let player = &c[1];
            if !seated.contains(player) {
                return Some(refuse(
                    SkipReason::GhostAnte,
                    format!("Ante posted by an unseated player ({player})."),
                ));
            }
            continue;
        }

        let actor = PLAYER_ACTION
            .captures(line)
            .or_else(|| COLLECTED.captures(line))
            .map(|c| c[1].to_owned());
        if let Some(actor) = actor
            && !seated.contains(&actor)
            && (MONEY_ACTION.is_match(line) || line.contains(" collected "))
        {
            return Some(refuse(
                SkipReason::UnseatedActor,
                format!("An unseated player acted ({actor})."),
            ));
        }

        if let Some(c) = BLIND.captures(line) {
            let amount = parse_units(&c[3], money);
            commitment.insert(c[1].to_owned(), amount);
            continue;
        }

        if let Some(c) = RAISE_LINE.captures(line) {
            let to = parse_units(&c[3], money);
            commitment.insert(c[1].to_owned(), to);
            continue;
        }

        if let Some(c) = CALL.captures(line) {
            let amount = parse_units(&c[2], money);
            let all_in = c.get(3).is_some();
            let total = committed(&commitment, &c[1]) + amount;
            commitment.insert(c[1].to_owned(), total);
            if preflop
                && all_in
                && let Some((_, big_blind)) = stakes
                && amount.less_than(big_blind)
            {
                return Some(refuse(
                    SkipReason::ShortAllinCall,
                    "An all-in call preflop is smaller than the big blind.",
                ));
            }
            continue;
        }

        if let Some(c) = BET.captures(line) {
            let amount = parse_units(&c[2], money);
            commitment.insert(c[1].to_owned(), amount);
        }
    }
    None
}

/// `stripPhantomWalkBoards`: a preflop walk sometimes carries a board and a
/// `*** RIVER ***` marker that never happened; they are removed.
fn strip_phantom_walk_boards(lines: Vec<String>) -> Vec<String> {
    let Some(showdown) = lines
        .iter()
        .position(|line| line == "*** SHOWDOWN ***" || line == "*** SHOW DOWN ***")
    else {
        return lines;
    };
    if lines[..showdown]
        .iter()
        .any(|line| FLOP_MARKER.is_match(line))
    {
        return lines;
    }
    lines
        .into_iter()
        .enumerate()
        .filter(|(index, line)| {
            *index <= showdown
                || !(line == "*** HOLE CARDS ***"
                    || DEALT_TO.is_match(line)
                    || STREET_MARKER.is_match(line)
                    || BOARD.is_match(line))
        })
        .map(|(_, line)| line)
        .collect()
}

/// What [`normalize_weplay_chunk`] makes of a chunk it accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    /// The standard text.
    pub text: String,
    /// The WePlay hand id (`unknown` without a header).
    pub hand_id: String,
}

/// `normalizeWeplayChunk`: a WePlay chunk to standard text, or the refusal
/// (the TypeScript's `{ skip }`, as a [`ParseSkip`] at stage `parse`).
pub fn normalize_weplay_chunk(chunk: &str) -> Result<Normalized, ParseSkip> {
    let lines = split_lines(chunk);
    let raw_header = lines[0];
    let (header, hand_id) = normalize_header(raw_header);
    let money = money_context_for(chunk, &header);

    if is_omaha_hand(raw_header) || is_omaha_hand(&header) {
        return Err(refuse(
            SkipReason::UnsupportedVariant,
            "Omaha is not supported yet; the hand is kept for a future parser.",
        ));
    }

    if let Some(skip) = early_skip(chunk, &header, &money) {
        return Err(skip);
    }

    let mut current_bet = JsNumber::ZERO;
    let mut normalized: Vec<String> = Vec::with_capacity(lines.len());
    for (index, raw_line) in lines.iter().enumerate() {
        if index == 0 {
            normalized.push(header.clone());
            continue;
        }
        if should_drop_line(raw_line) {
            continue;
        }
        let line = normalize_line(raw_line, &money);
        if line.is_empty() {
            continue;
        }
        if STREET_MARKER.is_match(&line) {
            current_bet = JsNumber::ZERO;
            normalized.push(line);
            continue;
        }
        if let Some(raised) = rewrite_raise_line(&line, current_bet, &money) {
            current_bet = raised.current_bet;
            normalized.push(raised.line);
            continue;
        }
        current_bet = update_current_bet_from_line(&line, current_bet, &money);
        normalized.push(line);
    }

    let cleaned = strip_phantom_walk_boards(normalized);
    if let Some(skip) = integrity_skip(&cleaned, &header, &money) {
        return Err(skip);
    }
    Ok(Normalized {
        text: cleaned.join("\n"),
        hand_id,
    })
}

/* ------------------------------------------------------------------ parser */

/// `weplayParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct WePlayParser;

impl SiteParser for WePlayParser {
    fn id(&self) -> &'static str {
        "weplay"
    }

    fn name(&self) -> &'static str {
        "WePlay"
    }

    fn version(&self) -> &'static str {
        WEPLAY_PARSER_VERSION
    }

    /// 0.99 for a header at the start or after a `\n` (a BOM tolerated);
    /// a WePlay export without its header is not guessed at.
    fn detect(&self, text: &str) -> u32 {
        if DETECT.is_match(text) { 990 } else { 0 }
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(strip_bom(text), &HAND_START)
            .into_iter()
            .map(|chunk| js::trim(strip_bom(chunk)))
            .filter(|chunk| chunk.starts_with("Weplay Hand #"))
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        let header = split_lines(raw)[0];
        if ctx.options.cash_only && TOURNAMENT.is_match(header) {
            return Err(refuse(
                SkipReason::TournamentInCashMode,
                "Tournament hand skipped because the converter is in cash-only mode.",
            )
            .into());
        }
        if ctx.options.skip_bomb_pots && is_bomb_pot_hand(raw) {
            return Err(refuse(SkipReason::BombPot, "Bomb pot hand skipped by request.").into());
        }

        let normalized = normalize_weplay_chunk(raw)?;
        let context = StandardContext {
            site_id: "weplay",
            site_name: "WePlay",
            original_filename: ctx.source_filename,
            parser_id: Some("weplay"),
            parser_version: Some(WEPLAY_PARSER_VERSION),
            parsed_at: ctx.parsed_at(),
        };
        let mut hand = match parse_standard_hand(&normalized.text, &context) {
            Ok(Some(hand)) => hand,
            Ok(None) => {
                return Err(refuse(
                    SkipReason::NormalizedUnparseable,
                    "The hand normalized cleanly but the result could not be parsed.",
                )
                .into());
            }
            Err(thrown) => return Err(ParseError::Bug(thrown.message)),
        };
        // The raw text kept is the WePlay original, not the rewrite: a fixed
        // normalizer can then re-convert it.
        js::trim(raw).clone_into(&mut hand.meta.raw_text);
        Ok(hand)
    }
}

#[cfg(test)]
mod tests;
