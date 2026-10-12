//! `winamax`: Winamax (winamax.fr / .es / .de)
//! (`frontend/src/lib/parsers/winamax.ts`, R0.10a). A HUD-priority room.
//!
//! Winamax's own grammar, read into a [`P6Draft`] and built by
//! [`build_p6_hand`]:
//!
//! - there is no `Uncalled bet` line, ever: an unmatched bet stays in the pot
//!   and comes back inside `collected`, so `Total pot` is every chip that went
//!   in minus the rake;
//! - `No rake` is a literal string; `Board:` has a colon;
//! - player names carry spaces and digits, so an action line is matched
//!   against the seat list, longest name first;
//! - every amount must be `<digits>[.<1-2 digits>]` before the currency
//!   glyph - anything else (`0,25€`, `1 234,50€`) refuses the hand as
//!   `unsupported-locale`, and a U+FFFD anywhere (a Windows-1252 euro sign
//!   read as UTF-8) as `unsupported-encoding`;
//! - tournaments are refused outright (no verified sample).
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `winamax.ts`); the three multiline detection probes and the lookahead
//! split run at every JavaScript line start.

use std::sync::LazyLock;

use regex::Regex;

use super::shared::p2_partygaming::{iso_from_888_date, split_lines};
use super::shared::p6_handbuilder::{
    P6Action, P6Collect, P6Draft, P6Kind, P6Seat, P6Street, build_p6_hand,
};
use super::shared::ps_gg_hand::split_before_line_starts;
use super::shared::variant_lock::{
    HOLDEM_OMAHA, canonical_game_label, unsupported_variant_skip, variant_of,
};
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::game::hole_card_count;
use crate::phf::money::{parse_amount_js, unit_for_symbol};
use crate::phf::serialize::matches_at_line_start;
use crate::phf::{DecimalStyle, LimitType, PhfHand, PhfWarning, Variant};

/// `VERSION`.
pub const WINAMAX_PARSER_VERSION: &str = "1.0.0";

/// `WINAMAX_VARIANTS`: Hold'em and four-card Omaha (one `Omaha pot limit`
/// file); the card-count check stops a five-card table on a four-card label.
const WINAMAX_VARIANTS: &[Variant] = HOLDEM_OMAHA;

static HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Winamax Poker - (CashGame|Tournament)\b.*?HandId: #(\S+) - (.+?) \((.+?)\) - (\d{4})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\s+\S+)?\s*$",
    ""
);
static TABLE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table: '(.*)' (\d+)-max \((real|play) money\)(?: Seat #(\d+) is the button)?\s*$",
    ""
);
static SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat (\d+): (.+) \(([^()]*)\)\s*$", "");
/// `AMOUNT_AND_SYMBOL`: digits, then whatever the room appends as a glyph.
static AMOUNT_AND_SYMBOL: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^([\d.,\u00a0\u202f ]+)(.*)$", "");
/// `SAFE_AMOUNT`: the one amount shape this corpus ever uses.
static SAFE_AMOUNT: LazyLock<Regex> = crate::js_regex_lazy!(r"^\d+(?:\.\d{1,2})?$", "");
/// `KNOWN_SYMBOLS`.
const KNOWN_SYMBOLS: [&str; 3] = ["€", "$", "£"];

/// The three `detect` probes, `m` flag dropped (run at every line start).
static DETECT_KNOWN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\uFEFF?Winamax Poker - (?:CashGame|Tournament)\b", "");
static DETECT_ANY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\uFEFF?Winamax Poker - ", "");
static DETECT_BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* ANTE\/BLINDS \*\*\*", "");

static MARKER_BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* ANTE\/BLINDS \*\*\*", "");
static MARKER_PREFLOP: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* PRE-FLOP \*\*\*", "");
static MARKER_SHOWDOWN: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* SHOW\s?DOWN \*\*\*", "");
static MARKER_SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\* SUMMARY \*\*\*", "");
static MARKER_BOARD: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (FLOP|TURN|RIVER) \*\*\*\s*(.*)$", "");
static BRACKET: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");
static TOTAL_POT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Total pot (\S+) \| (?:Rake (\S+)|No rake)\s*$", "");
static SUMMARY_BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board: \[([^\]]*)\]\s*$", "");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat \d+: ", "");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to (.+) \[([^\]]*)\]\s*$", "");
static ALL_IN: LazyLock<Regex> = crate::js_regex_lazy!(r" and is all-in$", "");
static BLIND: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts (small|big) blind (\S+)(.*)$", "");
static ANTE: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts ante (\S+)$", "");
static CALL_BET: LazyLock<Regex> = crate::js_regex_lazy!(r"^(calls|bets) (\S+)$", "");
static RAISE: LazyLock<Regex> = crate::js_regex_lazy!(r"^raises (\S+) to (\S+)$", "");
static SHOWS: LazyLock<Regex> = crate::js_regex_lazy!(r"^shows \[([^\]]*)\](?: \((.+)\))?$", "");
static COLLECT: LazyLock<Regex> = crate::js_regex_lazy!(r"^collected (\S+) from (.+)$", "");
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"pot\s*limit", "i");
static NO_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"no\s*limit", "i");

/// `assertRepresentableAmounts`' token pattern for each known symbol:
/// `` String.raw`([\d][\d.,\u00a0\u202f ]*)${escapeRegExp(symbol)}` ``.
static REPRESENTABLE: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    KNOWN_SYMBOLS
        .iter()
        .map(|symbol| {
            let pattern = format!(r"([\d][\d.,\u00a0\u202f ]*){}", escape_reg_exp(symbol));
            (*symbol, js::regex::js_regex(&pattern, "g"))
        })
        .collect()
});

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

/// `escapeRegExp(value)`.
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

/// `cardsIn(raw)`: `raw.split(/\s+/).filter(Boolean)`.
fn cards_in(raw: &str) -> Vec<String> {
    raw.split(js::is_whitespace)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `limitOf(label)`: Winamax writes the limit after the game.
fn limit_of(label: &str) -> LimitType {
    if POT_LIMIT.is_match(label) {
        return LimitType::Pl;
    }
    if NO_LIMIT.is_match(label) {
        LimitType::Nl
    } else {
        LimitType::Fl
    }
}

/// `assertRepresentableAmounts(text, symbol)`: every `<digits><symbol>`
/// token must be in the one shape the corpus proves.
fn assert_representable_amounts(text: &str, symbol: &str) -> Result<(), ParseError> {
    let Some((_, token)) = REPRESENTABLE.iter().find(|(known, _)| *known == symbol) else {
        return Ok(());
    };
    for captures in token.captures_iter(text) {
        let digits = &captures[1];
        if !SAFE_AMOUNT.is_match(digits) {
            return Err(skip(
                SkipReason::UnsupportedLocale,
                format!(
                    "\"{digits}{symbol}\" is not a plain decimal amount. This parser only reads \
                     the period-decimal, no-separator format the verified corpus uses; a locale \
                     that groups thousands or uses a comma decimal would be misread by a factor \
                     of 100."
                ),
            ));
        }
    }
    Ok(())
}

/// The money readers of one hand (`readDigits`, `readAmount`).
struct Money<'a> {
    symbol: &'a str,
    unit: crate::phf::CurrencyUnit,
}

impl Money<'_> {
    /// `readDigits(token, line)`: a bare digit string in the one safe shape.
    fn digits(&self, token: &str, line: usize) -> Result<JsNumber, ParseError> {
        if !SAFE_AMOUNT.is_match(token) {
            return Err(skip(
                SkipReason::UnsupportedLocale,
                format!(
                    "\"{token}\" on line {line} is not a plain decimal amount, and guessing at \
                     its magnitude would be wrong by a factor of 100."
                ),
            ));
        }
        Ok(parse_amount_js(token, &self.unit))
    }

    /// `readAmount(token, line)`: `99.36€` -> 9936.
    fn amount(&self, token: &str, line: usize) -> Result<JsNumber, ParseError> {
        let Some(digits) = token.strip_suffix(self.symbol) else {
            return Err(skip(
                SkipReason::UnsupportedLocale,
                format!(
                    "\"{token}\" on line {line} is not an amount in {}.",
                    self.symbol
                ),
            ));
        };
        self.digits(js::trim(digits), line)
    }
}

/// `winamaxParser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    let lines = split_lines(text);

    if text.contains('\u{FFFD}') {
        return Err(skip(
            SkipReason::UnsupportedEncoding,
            "The text contains U+FFFD replacement characters, so it was decoded with the wrong \
             codec and the currency cannot be identified. Two files in the Winamax corpus \
             encode the euro sign as Windows-1252. Re-save the export as UTF-8.",
        ));
    }

    let Some(header) = HEADER.captures(lines[0]) else {
        return Err(skip(
            SkipReason::NoHeader,
            format!("Unreadable Winamax header: \"{}\".", lines[0]),
        ));
    };
    if &header[1] == "Tournament" {
        return Err(skip(
            SkipReason::UnsupportedTournament,
            "Winamax tournament hands are not supported: no verified sample of the tournament \
             grammar exists, so a parser for it would be written against a guess.",
        ));
    }

    let game_label = js::trim(&header[3]);
    if let Some(refusal) = unsupported_game_skip(game_label, &[])
        .or_else(|| unsupported_variant_skip(game_label, WINAMAX_VARIANTS))
    {
        return Err(refusal.into());
    }
    let variant = variant_of(game_label);
    // Never `None` for an allowed variant (`holeCardCount(variant)!`).
    let Some(dealt_card_count) = hole_card_count(variant) else {
        return Err(ParseError::Bug(format!(
            "no hole-card count for {variant:?}"
        )));
    };
    let dealt_card_count = usize::try_from(dealt_card_count).unwrap_or(usize::MAX);

    /* ----------------------------------------------------------- money --- */

    let stake_parts: Vec<&str> = js::trim(&header[4]).split('/').collect();
    let stake_tokens: Vec<Option<regex::Captures<'_>>> = stake_parts
        .iter()
        .map(|part| AMOUNT_AND_SYMBOL.captures(js::trim(part)))
        .collect();
    let (2, Some(Some(small_token)), Some(Some(big_token))) =
        (stake_parts.len(), stake_tokens.first(), stake_tokens.get(1))
    else {
        return Err(skip(
            SkipReason::NoHeader,
            format!("Unreadable stakes clause \"{}\".", &header[4]),
        ));
    };
    let symbol = js::trim(if big_token[2].is_empty() {
        &small_token[2]
    } else {
        &big_token[2]
    });
    if !KNOWN_SYMBOLS.contains(&symbol) {
        return Err(skip(
            SkipReason::UnsupportedCurrency,
            format!(
                "The stakes are quoted in \"{symbol}\", which is not a currency this parser can \
                 name; filing it under the wrong code would corrupt every win-rate it feeds."
            ),
        ));
    }
    assert_representable_amounts(text, symbol)?;
    let money = Money {
        symbol,
        unit: unit_for_symbol(symbol).unit(),
    };

    let small_blind = money.digits(js::trim(&small_token[1]), 1)?;
    let big_blind = money.digits(js::trim(&big_token[1]), 1)?;

    let Some(table) = lines.get(1).and_then(|line| TABLE.captures(line)) else {
        return Err(skip(
            SkipReason::NoHeader,
            format!(
                "Unreadable Winamax table line: \"{}\".",
                lines.get(1).copied().unwrap_or("")
            ),
        ));
    };

    /* ---------------------------------------------------------- stream --- */

    let mut warnings: Vec<PhfWarning> = Vec::new();
    let mut seats: Vec<P6Seat> = Vec::new();
    let mut actions: Vec<P6Action> = Vec::new();
    let mut collected: Vec<P6Collect> = Vec::new();
    let mut street = P6Street::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut in_summary = false;
    let mut reported_pot: Option<JsNumber> = None;
    let mut reported_rake: Option<JsNumber> = None;
    let mut summary_board: Option<Vec<String>> = None;
    // Longest first: `Incognito 1` would swallow `Incognito 10`'s lines.
    let mut names: Vec<String> = Vec::new();

    for (i, raw_line) in lines.iter().enumerate().skip(2) {
        let line = js::trim(raw_line);
        let line_no = i + 1;
        let line_u32 = u32::try_from(line_no).ok();
        if line.is_empty() {
            continue;
        }

        if MARKER_BLINDS.is_match(line) || MARKER_PREFLOP.is_match(line) {
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
            // The last bracket holds the new cards.
            let last = BRACKET
                .captures_iter(board.get(2).map_or("", |m| m.as_str()))
                .last()
                .map(|group| cards_in(&group[1]))
                .unwrap_or_default();
            match &board[1] {
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

        if in_summary {
            if let Some(pot) = TOTAL_POT.captures(line) {
                reported_pot = Some(money.amount(&pot[1], line_no)?);
                reported_rake = Some(match pot.get(2) {
                    Some(rake) => money.amount(rake.as_str(), line_no)?,
                    None => JsNumber::ZERO,
                });
                continue;
            }
            if let Some(printed) = SUMMARY_BOARD.captures(line) {
                summary_board = Some(cards_in(&printed[1]));
                continue;
            }
            if SUMMARY_SEAT.is_match(line) {
                // Regenerated from the structured data by the builder.
                continue;
            }
            warnings.push(warning("unknown-summary-line", line, line_u32));
            continue;
        }

        if let Some(seat) = SEAT.captures(line) {
            let name = js::trim(&seat[2]);
            if name.is_empty() {
                return Err(skip(
                    SkipReason::UnnamedSeat,
                    format!("Seat {} has no player name.", &seat[1]),
                ));
            }
            if names.iter().any(|known| known == name) {
                return Err(skip(
                    SkipReason::DuplicatePlayer,
                    format!("\"{name}\" is seated twice."),
                ));
            }
            let number = JsNumber::parse(&seat[1]);
            if seats.iter().any(|entry| entry.seat.strict_equals(number)) {
                return Err(skip(
                    SkipReason::DuplicateSeat,
                    format!("Seat {} is occupied twice.", &seat[1]),
                ));
            }
            seats.push(P6Seat {
                seat: number,
                name: name.to_owned(),
                starting_stack: money.amount(js::trim(&seat[3]), line_no)?,
                // Winamax lists only the seats that were dealt in.
                dealt_in: true,
                is_hero: false,
                dealt_cards: Vec::new(),
            });
            names.push(name.to_owned());
            // `names.sort((a, b) => b.length - a.length)`, as V8 sorts.
            js::sort::sort_by(&mut names, |a, b| utf16_length(b) - utf16_length(a));
            continue;
        }

        if let Some(dealt) = DEALT.captures(line) {
            // The deal line is the only hero marker Winamax has.
            let Some(owner) = seats
                .iter_mut()
                .find(|entry| entry.name == js::trim(&dealt[1]))
            else {
                return Err(skip(
                    SkipReason::UnseatedActor,
                    format!("\"{}\" is dealt cards but is not seated.", &dealt[1]),
                ));
            };
            owner.is_hero = true;
            owner.dealt_cards = cards_in(&dealt[2]);
            continue;
        }

        let Some(name) = names
            .iter()
            .find(|name| {
                line.strip_prefix(name.as_str())
                    .is_some_and(|rest| rest.starts_with(' '))
            })
            .cloned()
        else {
            warnings.push(warning("unknown-line", line, line_u32));
            continue;
        };
        let rest = &line[name.len() + 1..];
        let all_in = ALL_IN.is_match(rest);
        let verb = ALL_IN.replace(rest, "");
        let verb = verb.as_ref();

        if verb == "folds" || verb == "checks" {
            let kind = if verb == "folds" {
                P6Kind::Fold
            } else {
                P6Kind::Check
            };
            let mut action = P6Action::new(street, &name, kind);
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(blind) = BLIND.captures(verb) {
            let qualifier = js::trim(&blind[3]);
            if !qualifier.is_empty() && qualifier != "out of position" {
                warnings.push(warning("unknown-line", line, line_u32));
                continue;
            }
            // `posts big blind X out of position`: live money that is not
            // the table's big blind and must not move the ring.
            let kind = if !qualifier.is_empty() {
                P6Kind::Post
            } else if &blind[1] == "small" {
                P6Kind::SmallBlind
            } else {
                P6Kind::BigBlind
            };
            let mut action = P6Action::new(P6Street::Preflop, &name, kind);
            action.amount = Some(money.amount(&blind[2], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(ante) = ANTE.captures(verb) {
            let mut action = P6Action::new(P6Street::Preflop, &name, P6Kind::Ante);
            action.amount = Some(money.amount(&ante[1], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(call_bet) = CALL_BET.captures(verb) {
            let kind = if &call_bet[1] == "calls" {
                P6Kind::Call
            } else {
                P6Kind::Bet
            };
            let mut action = P6Action::new(street, &name, kind);
            action.amount = Some(money.amount(&call_bet[2], line_no)?);
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(raise) = RAISE.captures(verb) {
            // The "to" number is the one worth trusting.
            let mut action = P6Action::new(street, &name, P6Kind::Raise);
            action.amount = Some(money.amount(&raise[2], line_no)?);
            action.to_total = true;
            action.all_in = all_in;
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(shows) = SHOWS.captures(verb) {
            let mut action = P6Action::new(street, &name, P6Kind::Show);
            action.cards = Some(cards_in(&shows[1]));
            action.description = shows.get(2).map(|m| m.as_str().to_owned());
            action.line = line_u32;
            actions.push(action);
            continue;
        }

        if let Some(collect) = COLLECT.captures(verb) {
            collected.push(P6Collect {
                player: name.clone(),
                amount: money.amount(&collect[1], line_no)?,
                pot_name: Some(collect[2].to_owned()),
            });
            continue;
        }

        warnings.push(warning("unknown-line", line, line_u32));
    }

    /* ---------------------------------------------------------- checks --- */

    if seats.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The hand lists no seats."));
    }
    let (Some(reported_pot), Some(reported_rake)) = (reported_pot, reported_rake) else {
        return Err(skip(
            SkipReason::TruncatedHand,
            "The hand has no readable `Total pot` line.",
        ));
    };

    // The deal has to match the header's card count.
    for action in &actions {
        let shown = action.cards.as_ref().map_or(0, Vec::len);
        if action.kind == P6Kind::Show && shown != dealt_card_count {
            return Err(skip(
                SkipReason::UnsupportedVariant,
                format!(
                    "A showdown reveals {shown} cards; \"{game_label}\" deals {dealt_card_count}."
                ),
            ));
        }
    }
    for seat in &seats {
        if !seat.dealt_cards.is_empty() && seat.dealt_cards.len() != dealt_card_count {
            return Err(skip(
                SkipReason::UnsupportedVariant,
                format!(
                    "{} was dealt {} cards; \"{game_label}\" deals {dealt_card_count}.",
                    seat.name,
                    seat.dealt_cards.len()
                ),
            ));
        }
    }

    // The street markers have to be a prefix of the summary board.
    let mut marker_board: Vec<String> = flop.clone().unwrap_or_default();
    marker_board.extend(turn.clone());
    marker_board.extend(river.clone());
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
            flop = Some(summary[..summary.len().min(3)].to_vec());
            turn = summary.get(3).cloned();
            river = summary.get(4).cloned();
            warnings.push(warning(
                "board-from-summary",
                format!(
                    "The street markers stop after {} cards; the rest of the board is taken \
                     from the summary.",
                    marker_board.len()
                ),
                None,
            ));
        }
    }

    if &table[3] == "play" {
        warnings.push(warning(
            "play-money-table",
            "The table is flagged as play money, so the amounts are not real currency.",
            None,
        ));
    }

    let draft = P6Draft {
        site_id: "winamax".to_owned(),
        site_name: "Winamax".to_owned(),
        parser_id: "winamax".to_owned(),
        parser_version: WINAMAX_PARSER_VERSION.to_owned(),
        hand_prefix: "WMX-".to_owned(),
        hand_id: header[2].to_owned(),
        game_label: canonical_game_label(variant, limit_of(game_label), false),
        unit: money.unit.clone(),
        // `0.50€` and `1€`.
        decimals: DecimalStyle::Fixed2,
        header_small_blind: small_blind,
        header_big_blind: big_blind,
        table_name: Some(table[1].to_owned()).filter(|name| !name.is_empty()),
        max_seats: JsNumber::parse(&table[2]),
        button_seat: table.get(4).map(|button| JsNumber::parse(button.as_str())),
        tournament: None,
        played_at: iso_from_888_date(
            &header[7],
            &header[6],
            &header[5],
            &header[8],
            &header[9],
            &header[10],
        ),
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        // Winamax never returns an unmatched bet; it pays it back inside
        // `collected`.
        collected_includes_uncalled: true,
        printed_uncalled: Vec::new(),
        // `Total pot` is net of rake.
        reported_gross: Some(reported_pot + reported_rake),
        reported_payout: None,
        reported_rake: Some(reported_rake),
        raw_text: text.to_owned(),
        warnings,
    };

    build_p6_hand(&draft, ctx)
}

/// `name.length` as a JavaScript number (UTF-16 code units).
fn utf16_length(name: &str) -> JsNumber {
    JsNumber::from_u64(u64::try_from(js::utf16_len(name)).unwrap_or(u64::MAX))
}

/// `chunk.replace(/^\uFEFF/, "").trim()`.
fn clean_chunk(chunk: &str) -> &str {
    js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk))
}

/// `winamaxParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct WinamaxParser;

impl SiteParser for WinamaxParser {
    fn id(&self) -> &'static str {
        "winamax"
    }

    fn name(&self) -> &'static str {
        "Winamax"
    }

    fn version(&self) -> &'static str {
        WINAMAX_PARSER_VERSION
    }

    /// 0.95 for a `Winamax Poker - CashGame`/`Tournament` line, 0.9 for any
    /// `Winamax Poker - ` line, 0.5 for a bare `*** ANTE/BLINDS ***` marker.
    fn detect(&self, text: &str) -> u32 {
        if matches_at_line_start(&DETECT_KNOWN, text) {
            return 950;
        }
        if matches_at_line_start(&DETECT_ANY, text) {
            return 900;
        }
        if matches_at_line_start(&DETECT_BLINDS, text) {
            return 500;
        }
        0
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(text, &DETECT_ANY)
            .into_iter()
            .map(clean_chunk)
            .filter(|chunk| chunk.starts_with("Winamax Poker - "))
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

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/winamax.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/^Winamax Poker - (CashGame|Tournament)\b.*?HandId: #(\S+) - (.+?) \((.+?)\) - (\d{4})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\s+\S+)?\s*$/;",
            r"/^Table: '(.*)' (\d+)-max \((real|play) money\)(?: Seat #(\d+) is the button)?\s*$/;",
            r"/^Seat (\d+): (.+) \(([^()]*)\)\s*$/;",
            r"/^([\d.,\u00a0\u202f ]+)(.*)$/;",
            r"/^\d+(?:\.\d{1,2})?$/;",
            r#"new Set(["€", "$", "£"]);"#,
            "/^\u{FEFF}?Winamax Poker - (?:CashGame|Tournament)\\b/m.test(text)",
            "/^\u{FEFF}?Winamax Poker - /m.test(text)",
            r"/^\*\*\* ANTE\/BLINDS \*\*\*/m.test(text)",
            ".split(/(?=^\u{FEFF}?Winamax Poker - )/m)",
            ".map((chunk) => chunk.replace(/^\u{FEFF}/, \"\").trim())",
            r#".filter((chunk) => chunk.startsWith("Winamax Poker - "));"#,
            "const text = raw.replace(/^\u{FEFF}/, \"\").trim();",
            r"const lines = text.split(/\r?\n/);",
            "if (text.includes(\"\u{FFFD}\")) {",
            r"if (/^\*\*\* ANTE\/BLINDS \*\*\*/.test(line) || /^\*\*\* PRE-FLOP \*\*\*/.test(line)) {",
            r"if (/^\*\*\* SHOW\s?DOWN \*\*\*/.test(line)) {",
            r"if (/^\*\*\* SUMMARY \*\*\*/.test(line)) {",
            r"const board = line.match(/^\*\*\* (FLOP|TURN|RIVER) \*\*\*\s*(.*)$/);",
            r"[...board[2].matchAll(/\[([^\]]*)\]/g)]",
            r"const pot = line.match(/^Total pot (\S+) \| (?:Rake (\S+)|No rake)\s*$/);",
            r"const printedBoard = line.match(/^Board: \[([^\]]*)\]\s*$/);",
            r"if (/^Seat \d+: /.test(line)) {",
            r"const dealt = line.match(/^Dealt to (.+) \[([^\]]*)\]\s*$/);",
            r"const allIn = / and is all-in$/.test(rest);",
            r#"const verb = rest.replace(/ and is all-in$/, "");"#,
            r"const blind = verb.match(/^posts (small|big) blind (\S+)(.*)$/);",
            r#"if (qualifier && qualifier !== "out of position") {"#,
            r"const ante = verb.match(/^posts ante (\S+)$/);",
            r"const callBet = verb.match(/^(calls|bets) (\S+)$/);",
            r"const raise = verb.match(/^raises (\S+) to (\S+)$/);",
            r"const shows = verb.match(/^shows \[([^\]]*)\](?: \((.+)\))?$/);",
            r"const collect = verb.match(/^collected (\S+) from (.+)$/);",
            "String.raw`([\\d][\\d.,\\u00a0\\u202f ]*)${escapeRegExp(symbol)}`,",
            r"if (/pot\s*limit/i.test(label)) {",
            r#"return /no\s*limit/i.test(label) ? "nl" : "fl";"#,
            r"return raw.split(/\s+/).filter(Boolean);",
            r#"return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");"#,
            r#"const WINAMAX_VARIANTS = ["holdem", "omaha"] as const;"#,
            r#"const VERSION = "1.0.0";"#,
            r#"handPrefix: "WMX-","#,
            r#"decimals: "fixed2","#,
            "names.find((name) => line.startsWith(`${name} `))",
            "names.sort((a, b) => b.length - a.length);",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
        for message in [
            "The text contains U+FFFD replacement characters, so it was decoded with the \" +\n          \"wrong codec and the currency cannot be identified. Two files in the Winamax \" +\n          \"corpus encode the euro sign as Windows-1252. Re-save the export as UTF-8.",
            "`Unreadable Winamax header: \"${lines[0] ?? \"\"}\".`",
            "\"Winamax tournament hands are not supported: no verified sample of the \" +\n          \"tournament grammar exists, so a parser for it would be written against a guess.\"",
            "`Unreadable stakes clause \"${headerMatch[4]}\".`",
            "`The stakes are quoted in \"${symbol}\", which is not a currency this parser can ` +\n          \"name; filing it under the wrong code would corrupt every win-rate it feeds.\"",
            "`\"${token}\" on line ${line} is not a plain decimal amount, and guessing at its ` +\n            \"magnitude would be wrong by a factor of 100.\"",
            "`\"${token}\" on line ${line} is not an amount in ${symbol}.`",
            "`Unreadable Winamax table line: \"${lines[1] ?? \"\"}\".`",
            "`Seat ${seat[1]} has no player name.`",
            "`\"${name}\" is seated twice.`",
            "`Seat ${seat[1]} is occupied twice.`",
            "`\"${dealt[1]}\" is dealt cards but is not seated.`",
            "\"The hand lists no seats.\"",
            "\"The hand has no readable `Total pot` line.\"",
            "`A showdown reveals ${action.cards?.length ?? 0} cards; \"${gameLabel}\" deals ` +\n            `${dealtCardCount}.`",
            "`${seat.name} was dealt ${seat.dealtCards.length} cards; \"${gameLabel}\" deals ` +\n            `${dealtCardCount}.`",
            "`The street markers deal [${markerBoard.join(\" \")}] but the summary reports ` +\n          `[${summaryBoard.join(\" \")}]; the two cannot both be the board.`",
            "`The street markers stop after ${markerBoard.length} cards; the rest of the ` +\n          \"board is taken from the summary.\"",
            "\"The table is flagged as play money, so the amounts are not real currency.\"",
            "`\"${match[1]}${symbol}\" is not a plain decimal amount. This parser only reads the ` +\n          \"period-decimal, no-separator format the verified corpus uses; a locale that \" +\n          \"groups thousands or uses a comma decimal would be misread by a factor of 100.\"",
        ] {
            assert!(source.contains(message), "{message}");
        }
    }

    #[test]
    fn limits_and_escapes() {
        assert_eq!(limit_of("Omaha pot limit"), LimitType::Pl);
        assert_eq!(limit_of("Holdem no limit"), LimitType::Nl);
        assert_eq!(limit_of("Holdem fixed limit"), LimitType::Fl);
        assert_eq!(escape_reg_exp("$"), r"\$");
        assert_eq!(escape_reg_exp("€"), "€");
        assert_eq!(cards_in("  Ah \u{A0}Kd "), ["Ah", "Kd"]);
    }
}
