//! `ongame`: the Ongame Network (`frontend/src/lib/parsers/ongame.ts`) -
//! bwin, Betsson, PokerRoom and the other skins.
//!
//! A small, closed grammar between `***** History for hand <id> *****` and
//! `***** End of hand <id> *****`:
//!
//! - `raises $1.50 to $2.00` is increment-then-total; only the total is read
//!   (`to_total`), the builder recomputes the rest;
//! - `Main pot: $X won by <name> ($Y)` states the pot before the rake and the
//!   share after it; the pot is already net of the uncalled bet, which the
//!   room never prints, so [`build_hand`] derives the return;
//! - nothing identifies the hero: hole cards appear only in the summary, as
//!   reveals tagged with the last street dealt;
//! - names are unconstrained (`---Cockatrice---`, `BONUS 1OOO`), so action
//!   lines are matched against the seat list ([`leading_name`]).
//!
//! The summary's `Rake taken:` and per-seat `net:` are cross-checked against
//! the built hand (warnings, after the build).

use std::sync::LazyLock;

use regex::Regex;

use super::ipoker::{highest_seat, next_table_size};
use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
};
use super::shared::p2_partygaming::{iso_from_party_date, known_zone, split_lines};
use super::shared::p4_textroom::{
    currency_symbol_of, expand_month, leading_name, names_by_length, strict_amount,
};
use super::shared::ps_gg_hand::split_before_line_starts;
use super::shared::variant_lock::{
    HOLDEM_OMAHA, canonical_game_label, normalize_game_name, unsupported_variant_skip, variant_of,
};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::unit_for_symbol;
use crate::phf::serialize::matches_at_line_start;
use crate::phf::{CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant};

/// `VERSION`.
pub const ONGAME_PARSER_VERSION: &str = "1.0.0";

/// `ONGAME_VARIANTS`: Hold'em and four-card Omaha. `OMAHA_HI_LO` stays
/// refused (no `hiLoVariants`): no Ongame fixture splits a pot.
const ONGAME_VARIANTS: &[Variant] = HOLDEM_OMAHA;

static OPEN_BANNER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*{5}\s*History for hand\s+(\S+)\s*\*{5}\s*$", "");
static CLOSE_BANNER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*{5}\s*End of hand\s+\S+\s*\*{5}\s*$", "");
static START_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Start hand:\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\S+)\s+(\d{4})\s*$",
    ""
);
static TABLE_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Table:\s+(.*?)\s*\[(\d+)\]\s*\((\S+)\s+(\S+)\s+(\S+?)\/(\S+?),\s*(.*?)\)\s*$",
    ""
);
static BUTTON_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Button:\s*seat\s+(\d+)\s*$", "i");
static COUNT_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Players in round:\s*(\d+)\s*$", "i");
static SEAT_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)\s*$", "");
static STREET_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^---\s*Dealing\s+(flop|turn|river)\s*\[([^\]]*)\]\s*$",
    "i"
);
static POT_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(Main|Side)\s+pot(?:\s+\d+)?:\s+(\S+)\s+won by\s+(.+)\s+\((\S+)\)\s*$",
    "i"
);
static RAKE_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Rake taken:\s+(\S+)\s*$", "i");
static SUMMARY_SEAT_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)(?:,\s*net:\s*(\S+?))?(?:,\s*\[([^\]]*)\])?\s*$",
    ""
);
static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^Summary:\s*$", "i");
static REAL_MONEY: LazyLock<Regex> = crate::js_regex_lazy!(r"real\s*money", "i");

/// `detect`'s `/^\*{5}\s*History for hand\s+\S+\s*\*{5}\s*$/m`, at every
/// JavaScript line start; the `m`-flag `$` is any line terminator or the end.
static DETECT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*{5}\s*History for hand\s+\S+\s*\*{5}\s*(?:$|[\n\r\u2028\u2029])",
    ""
);
/// `splitHands`' `/(?=^\*{5}\s*History for hand\s)/m`, at line starts.
static CHUNK_START: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*{5}\s*History for hand\s", "");

/* readAction's patterns */
static SHOVE: LazyLock<Regex> = crate::js_regex_lazy!(r"\s*\[all in\]\s*$", "i");
static POSTED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^posts\s+(small|big)\s+blind\s+\((\S+)\)$", "i");
static ANTE: LazyLock<Regex> = crate::js_regex_lazy!(r"^posts\s+ante\s+\((\S+)\)$", "i");
static FOLDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^folds$", "i");
static CHECKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^checks$", "i");
static CALLED: LazyLock<Regex> = crate::js_regex_lazy!(r"^calls\s+(\S+)$", "i");
static BET: LazyLock<Regex> = crate::js_regex_lazy!(r"^bets\s+(\S+)$", "i");
static RAISED: LazyLock<Regex> = crate::js_regex_lazy!(r"^raises\s+\S+\s+to\s+(\S+)$", "i");
static SHOWS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:shows|mucks|doesn't show)\s*(?:\[([^\]]*)\])?$", "i");
static SHOWS_VERB: LazyLock<Regex> = crate::js_regex_lazy!(r"^shows", "i");

/* limitOf's patterns */
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^POT_LIMIT$", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^LIMIT$", "i");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

fn line_number(i: usize) -> Option<u32> {
    u32::try_from(i + 1).ok()
}

fn group<'t>(captures: &regex::Captures<'t>, i: usize) -> &'t str {
    captures.get(i).map_or("", |m| m.as_str())
}

/// `limitOf(limit)`: Ongame's limit token.
fn limit_of(limit: &str) -> LimitType {
    if POT_LIMIT.is_match(limit) {
        LimitType::Pl
    } else if FIXED_LIMIT.is_match(limit) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

/// `fallbackMaxSeats(seats)`: the next real table size above the highest
/// seat (or the seat count).
fn fallback_max_seats(seats: &[DraftSeat]) -> JsNumber {
    next_table_size(&[2, 6, 9, 10], highest_seat(seats))
}

/// `readAction(rest, player, unit, street, actions)`: the part of an action
/// line after the player's name; `false` when it means nothing here.
fn read_action(
    rest: &str,
    player: &str,
    unit: &CurrencyUnit,
    street: DraftStreet,
    actions: &mut Vec<DraftAction>,
) -> Result<bool, ParseSkip> {
    // `[all in]` is decoration on an ordinary action.
    let mut body = rest;
    let mut all_in = false;
    if let Some(shove) = SHOVE.find(body) {
        all_in = true;
        body = js::trim(&body[..shove.start()]);
    }
    let action = |kind: DraftKind| DraftAction::new(street, player, kind);

    if let Some(posted) = POSTED.captures(body) {
        let kind = if js::to_lower_case(group(&posted, 1)) == "small" {
            DraftKind::SmallBlind
        } else {
            DraftKind::BigBlind
        };
        let mut post = action(kind);
        post.amount = Some(strict_amount(group(&posted, 2), unit, "a blind post")?);
        post.all_in = all_in;
        actions.push(post);
        return Ok(true);
    }
    if let Some(ante) = ANTE.captures(body) {
        let mut post = action(DraftKind::Ante);
        post.amount = Some(strict_amount(group(&ante, 1), unit, "an ante")?);
        post.all_in = all_in;
        actions.push(post);
        return Ok(true);
    }
    if FOLDS.is_match(body) {
        actions.push(action(DraftKind::Fold));
        return Ok(true);
    }
    if CHECKS.is_match(body) {
        actions.push(action(DraftKind::Check));
        return Ok(true);
    }
    for (pattern, kind, place) in [
        (&*CALLED, DraftKind::Call, "a call"),
        (&*BET, DraftKind::Bet, "a bet"),
    ] {
        if let Some(found) = pattern.captures(body) {
            let mut wager = action(kind);
            wager.amount = Some(strict_amount(group(&found, 1), unit, place)?);
            wager.all_in = all_in;
            actions.push(wager);
            return Ok(true);
        }
    }
    if let Some(raised) = RAISED.captures(body) {
        // Only the total is read; the increment is recomputed.
        let mut raise = action(DraftKind::Raise);
        raise.amount = Some(strict_amount(group(&raised, 1), unit, "a raise")?);
        raise.to_total = true;
        raise.all_in = all_in;
        actions.push(raise);
        return Ok(true);
    }
    if let Some(shows) = SHOWS.captures(body) {
        let kind = if SHOWS_VERB.is_match(body) {
            DraftKind::Show
        } else {
            DraftKind::Muck
        };
        let mut reveal = action(kind);
        reveal.cards = Some(extract_cards(group(&shows, 1)));
        actions.push(reveal);
        return Ok(true);
    }
    Ok(false)
}

fn warning(code: &str, message: String) -> PhfWarning {
    PhfWarning {
        code: code.to_owned(),
        message,
        line: None,
    }
}

/// `crossCheck(hand, statedPot, statedRake, reportedNet)`: warnings where
/// the room's own `Main pot`, `Rake taken:` and `net:` figures disagree with
/// the reconstruction by more than one minor unit.
fn cross_check(
    hand: &mut PhfHand,
    stated_pot: JsNumber,
    stated_rake: Option<JsNumber>,
    reported_net: &[(String, JsNumber)],
) {
    let one = JsNumber::from_i64(1);
    let total_pot = JsNumber::from_i64(hand.results.total_pot);
    let rake = JsNumber::from_i64(hand.results.fees.rake);
    let mut found = Vec::new();
    if stated_pot.greater_than(JsNumber::ZERO) && (stated_pot - total_pot).abs().greater_than(one) {
        found.push(warning(
            "pot-mismatch",
            format!(
                "The summary states a pot of {} but the stream accounts for {}.",
                stated_pot.to_js_string(),
                total_pot.to_js_string()
            ),
        ));
    }
    if let Some(stated) = stated_rake
        && (stated - rake).abs().greater_than(one)
    {
        found.push(warning(
            "rake-mismatch",
            format!(
                "The summary states a rake of {} but the reconstruction derives {}.",
                stated.to_js_string(),
                rake.to_js_string()
            ),
        ));
    }
    for result in &hand.results.players {
        let Some((_, stated)) = reported_net.iter().find(|(name, _)| *name == result.player) else {
            continue;
        };
        let net = JsNumber::from_i64(result.net);
        if (*stated - net).abs().greater_than(one) {
            found.push(warning(
                "net-result-mismatch",
                format!(
                    "{}: the summary states a net of {}, the reconstruction {}.",
                    result.player,
                    stated.to_js_string(),
                    net.to_js_string()
                ),
            ));
        }
    }
    hand.meta.warnings.append(&mut found);
}

/// `ongameParser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let source = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    let lines = split_lines(source);
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let Some(hand_id) = OPEN_BANNER
        .captures(lines[0])
        .map(|banner| group(&banner, 1).to_owned())
        .filter(|id| !id.is_empty())
    else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk does not open with an Ongame hand banner.",
        ));
    };

    let Some(table) = lines
        .iter()
        .find(|line| TABLE_LINE.is_match(js::trim(line)))
        .and_then(|line| TABLE_LINE.captures(js::trim(line)))
    else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk has no readable `Table:` line.",
        ));
    };
    let table_name = group(&table, 1);
    let limit_token = group(&table, 3);
    let game_token = group(&table, 4);
    let small_blind = group(&table, 5);
    let big_blind = group(&table, 6);
    let money = group(&table, 7);
    // `OMAHA_HI_LO` is spelled out before either reader sees it.
    let game_name = normalize_game_name(game_token);
    if let Some(refusal) = unsupported_game_skip(&game_name, &[])
        .or_else(|| unsupported_variant_skip(&game_name, ONGAME_VARIANTS))
    {
        return Err(refusal.into());
    }
    if !REAL_MONEY.is_match(money) {
        return Err(skip(
            SkipReason::PlayMoney,
            format!("The table is \"{money}\", not a real-money table."),
        ));
    }
    let symbol = match currency_symbol_of(small_blind) {
        "" => currency_symbol_of(big_blind),
        symbol => symbol,
    };
    let unit = unit_for_symbol(symbol).unit();

    // The seat list first: every later line is matched against it.
    let mut seats: Vec<DraftSeat> = Vec::new();
    for line in &lines {
        if SUMMARY.is_match(js::trim(line)) {
            break;
        }
        if let Some(seat) = SEAT_LINE.captures(js::trim(line)) {
            seats.push(DraftSeat {
                seat: JsNumber::parse(group(&seat, 1)),
                name: js::trim(group(&seat, 2)).to_owned(),
                starting_stack: strict_amount(group(&seat, 3), &unit, "a seat line")?,
                dealt_in: true,
                is_hero: false,
                dealt_cards: Vec::new(),
            });
        }
    }
    if seats.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The chunk has no seat lines."));
    }
    let names = names_by_length(&seats.iter().map(|s| s.name.clone()).collect::<Vec<_>>());

    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    // `Map<string, Amount>`: a repeated name keeps its first position.
    let mut reported_net: Vec<(String, JsNumber)> = Vec::new();
    let mut street = DraftStreet::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut button_seat: Option<JsNumber> = None;
    let mut max_seats = JsNumber::ZERO;
    let mut played_at: Option<String> = None;
    let mut stated_rake: Option<JsNumber> = None;
    let mut stated_pot = JsNumber::ZERO;
    let mut in_summary = false;
    // Reveals appear only in the summary: tagged with the last street dealt.
    let mut last_street = DraftStreet::Preflop;

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let line = js::trim(raw_line);
        let line_no = line_number(i);
        if line.is_empty()
            || line == "---"
            || line == "Dealing pocket cards"
            || CLOSE_BANNER.is_match(line)
        {
            continue;
        }
        if SUMMARY.is_match(line) {
            in_summary = true;
            continue;
        }

        if !in_summary {
            if let Some(start) = START_LINE.captures(line) {
                let zone = group(&start, 6);
                if !known_zone(zone) {
                    warnings.push(PhfWarning {
                        code: "unknown-timezone".to_owned(),
                        message: format!(
                            "Timezone \"{zone}\" is not in the offset table; the hand is timed \
                             as UTC."
                        ),
                        line: line_no,
                    });
                }
                played_at = iso_from_party_date(
                    &expand_month(group(&start, 1)),
                    group(&start, 2),
                    group(&start, 3),
                    group(&start, 4),
                    group(&start, 5),
                    zone,
                    group(&start, 7),
                );
                continue;
            }
            if TABLE_LINE.is_match(line) {
                continue;
            }
            if let Some(button) = BUTTON_LINE.captures(line) {
                button_seat = Some(JsNumber::parse(group(&button, 1)));
                continue;
            }
            if let Some(count) = COUNT_LINE.captures(line) {
                max_seats = JsNumber::parse(group(&count, 1));
                continue;
            }
            if SEAT_LINE.is_match(line) {
                continue; // read in the seat pass
            }
            if let Some(marker) = STREET_LINE.captures(line) {
                let cards = extract_cards(group(&marker, 2));
                street = match js::to_lower_case(group(&marker, 1)).as_str() {
                    "flop" => DraftStreet::Flop,
                    "turn" => DraftStreet::Turn,
                    _ => DraftStreet::River,
                };
                last_street = street;
                match street {
                    DraftStreet::Flop => flop = Some(cards),
                    DraftStreet::Turn => turn = cards.into_iter().next(),
                    _ => river = cards.into_iter().next(),
                }
                continue;
            }

            if let Some(hit) = leading_name(line, &names)
                && read_action(hit.rest, hit.name, &unit, street, &mut actions)?
            {
                continue;
            }
            warnings.push(PhfWarning {
                code: "unknown-line".to_owned(),
                message: line.to_owned(),
                line: line_no,
            });
            continue;
        }

        if let Some(pot) = POT_LINE.captures(line) {
            stated_pot = stated_pot + strict_amount(group(&pot, 2), &unit, "a summary pot line")?;
            collected.push(DraftCollect {
                player: js::trim(group(&pot, 3)).to_owned(),
                amount: strict_amount(group(&pot, 4), &unit, "a summary pot line")?,
                pot_name: Some(format!("{} pot", js::to_lower_case(group(&pot, 1)))),
                half: None,
            });
            continue;
        }
        if let Some(rake) = RAKE_LINE.captures(line) {
            stated_rake = Some(strict_amount(group(&rake, 1), &unit, "the rake line")?);
            continue;
        }
        if let Some(seat) = SUMMARY_SEAT_LINE.captures(line) {
            let name = js::trim(group(&seat, 2));
            if names.iter().any(|known| known == name) {
                if let Some(net) = seat.get(4) {
                    let amount = strict_amount(net.as_str(), &unit, "a summary seat line")?;
                    if let Some(entry) = reported_net.iter_mut().find(|(n, _)| n == name) {
                        entry.1 = amount;
                    } else {
                        reported_net.push((name.to_owned(), amount));
                    }
                }
                let cards = group(&seat, 5);
                if !cards.is_empty() {
                    // A player shown here reached a showdown: a reveal.
                    let mut show = DraftAction::new(last_street, name, DraftKind::Show);
                    show.cards = Some(extract_cards(cards));
                    actions.push(show);
                }
                continue;
            }
        }
        warnings.push(PhfWarning {
            code: "unknown-line".to_owned(),
            message: line.to_owned(),
            line: line_no,
        });
    }

    if collected.is_empty() {
        return Err(skip(
            SkipReason::NoWinner,
            "No `Main pot: ... won by` line, so the source never says who was given the pot.",
        ));
    }
    if let Some(cards) = &flop
        && cards.len() != 3
    {
        return Err(skip(
            SkipReason::BoardSize,
            format!(
                "The flop line lists {} readable cards, so the hand is corrupt.",
                cards.len()
            ),
        ));
    }

    // The object literal's order: the stakes are read (and may refuse) here.
    let header_small_blind = strict_amount(small_blind, &unit, "the table stakes")?;
    let header_big_blind = strict_amount(big_blind, &unit, "the table stakes")?;
    let max_seats = max_seats.max_of(fallback_max_seats(&seats));
    let draft = HandDraft {
        site_id: "ongame".to_owned(),
        site_name: "Ongame Network".to_owned(),
        parser_id: "ongame".to_owned(),
        parser_version: ONGAME_PARSER_VERSION.to_owned(),
        hand_prefix: "OG-".to_owned(),
        hand_id,
        game_label: canonical_game_label(variant_of(game_token), limit_of(limit_token), false),
        unit,
        decimals: DecimalStyle::Fixed2,
        header_small_blind,
        header_big_blind,
        table_name: (!table_name.is_empty()).then(|| table_name.to_owned()),
        max_seats,
        button_seat,
        played_at,
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        // `Main pot:` is already net of the uncalled bet.
        collected_includes_uncalled: false,
        raw_text: source.to_owned(),
        warnings,
    };

    let mut hand = build_hand(&draft, ctx)?;
    cross_check(&mut hand, stated_pot, stated_rake, &reported_net);
    Ok(hand)
}

/// `ongameParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OngameParser;

impl SiteParser for OngameParser {
    fn id(&self) -> &'static str {
        "ongame"
    }

    fn name(&self) -> &'static str {
        "Ongame Network"
    }

    fn version(&self) -> &'static str {
        ONGAME_PARSER_VERSION
    }

    /// 0.95 for a `***** History for hand <id> *****` line.
    fn detect(&self, text: &str) -> u32 {
        if matches_at_line_start(&DETECT, text) {
            950
        } else {
            0
        }
    }

    /// A chunk per banner at a line start, a BOM and the edges trimmed, kept
    /// when its first line is a whole banner.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(text, &CHUNK_START)
            .into_iter()
            .map(|chunk| js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk)))
            .filter(|chunk| OPEN_BANNER.is_match(split_lines(chunk)[0]))
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

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/ongame.ts");

    #[test]
    fn patterns_and_messages_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"const OPEN_BANNER = /^\*{5}\s*History for hand\s+(\S+)\s*\*{5}\s*$/;",
            r"const CLOSE_BANNER = /^\*{5}\s*End of hand\s+\S+\s*\*{5}\s*$/;",
            r"/^Start hand:\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\S+)\s+(\d{4})\s*$/;",
            r"const TABLE_LINE = /^Table:\s+(.*?)\s*\[(\d+)\]\s*\((\S+)\s+(\S+)\s+(\S+?)\/(\S+?),\s*(.*?)\)\s*$/;",
            r"const BUTTON_LINE = /^Button:\s*seat\s+(\d+)\s*$/i;",
            r"const COUNT_LINE = /^Players in round:\s*(\d+)\s*$/i;",
            r"const SEAT_LINE = /^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)\s*$/;",
            r"const STREET_LINE = /^---\s*Dealing\s+(flop|turn|river)\s*\[([^\]]*)\]\s*$/i;",
            r"const POT_LINE = /^(Main|Side)\s+pot(?:\s+\d+)?:\s+(\S+)\s+won by\s+(.+)\s+\((\S+)\)\s*$/i;",
            r"const RAKE_LINE = /^Rake taken:\s+(\S+)\s*$/i;",
            r"/^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)(?:,\s*net:\s*(\S+?))?(?:,\s*\[([^\]]*)\])?\s*$/;",
            r"if (/^\*{5}\s*History for hand\s+\S+\s*\*{5}\s*$/m.test(text)) {",
            "return 0.95;",
            r".split(/(?=^\*{5}\s*History for hand\s)/m)",
            r"/^Summary:\s*$/i",
            r"if (!/real\s*money/i.test(money)) {",
            r"body.match(/\s*\[all in\]\s*$/i)",
            r"body.match(/^posts\s+(small|big)\s+blind\s+\((\S+)\)$/i)",
            r"body.match(/^posts\s+ante\s+\((\S+)\)$/i)",
            r"/^folds$/i.test(body)",
            r"/^checks$/i.test(body)",
            r"body.match(/^calls\s+(\S+)$/i)",
            r"body.match(/^bets\s+(\S+)$/i)",
            r"body.match(/^raises\s+\S+\s+to\s+(\S+)$/i)",
            r"body.match(/^(?:shows|mucks|doesn't show)\s*(?:\[([^\]]*)\])?$/i)",
            r"/^shows/i.test(body)",
            r"/^POT_LIMIT$/i.test(limit)",
            r"/^LIMIT$/i.test(limit)",
            "[2, 6, 9, 10]",
            "const VERSION = \"1.0.0\";",
            "handPrefix: \"OG-\",",
            "\"The chunk does not open with an Ongame hand banner.\"",
            "\"The chunk has no readable `Table:` line.\"",
            "`The table is \"${money}\", not a real-money table.`",
            "\"The chunk has no seat lines.\"",
            "`Timezone \"${start[6]}\" is not in the offset table; the hand is timed as UTC.`,",
            "\"No `Main pot: ... won by` line, so the source never says who was given the pot.\",",
            "`The flop line lists ${flop.length} readable cards, so the hand is corrupt.`,",
            "`The summary states a pot of ${statedPot} but the stream accounts for ` +",
            "`${hand.results.totalPot}.`,",
            "`The summary states a rake of ${statedRake} but the reconstruction derives ` +",
            "`${hand.results.fees.rake}.`,",
            "`${result.player}: the summary states a net of ${stated}, the reconstruction ` +",
            "`${result.net}.`,",
            "\"a seat line\"",
            "\"a summary pot line\"",
            "\"the rake line\"",
            "\"a summary seat line\"",
            "\"the table stakes\"",
            "\"a blind post\"",
            "\"an ante\"",
            "\"a call\"",
            "\"a bet\"",
            "\"a raise\"",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    /// The `m`-flag detection probe at JavaScript line starts, recorded from
    /// Node.
    #[test]
    fn detects_a_banner_at_any_line_start() {
        for (text, expected) in [
            ("***** History for hand R5-1 *****", 950),
            ("x\n***** History for hand R5-1 *****\ny", 950),
            ("x\r***** History for hand R5-1 *****\ry", 950),
            ("x\u{2028}***** History for hand R5-1 *****\u{2029}y", 950),
            ("***** History for hand R5-1 ***** x", 0),
            ("***** History for hand\nR5-1\n*****\n\n", 950),
            (" ***** History for hand R5-1 *****", 0),
            ("***** History for hand  *****", 0),
        ] {
            assert_eq!(OngameParser.detect(text), expected, "{text:?}");
        }
    }

    #[test]
    fn limits_and_table_sizes() {
        assert_eq!(limit_of("pot_limit"), LimitType::Pl);
        assert_eq!(limit_of("LIMIT"), LimitType::Fl);
        assert_eq!(limit_of("NO_LIMIT"), LimitType::Nl);
        assert_eq!(limit_of("FIXED_LIMIT"), LimitType::Nl);
    }
}
