//! `entraction`: the Entraction network (`web/src/lib/parsers/entraction.ts`)
//! - Redbet, Nordicbet and the rest; bought by IGT in 2011 and wound down.
//!
//! Column-formatted plain text, `Game # <id> - <game> <limit> <CUR> <sb>/<bb>
//! - Table "<name>"`:
//!
//! - every amount is an increment, `Raise` included - the shape
//!   [`build_hand`] takes;
//! - `Payback` is the uncalled bet, read for the cross-check only (the builder
//!   derives the return);
//! - boards are cumulative (`River  4d - 2d - Js - 5s - As`): only the new
//!   tail is taken;
//! - the only timestamp is `Game ended`, with its stated GMT offset applied;
//! - nothing identifies the hero; names can contain spaces, so lines are
//!   matched against the seat list ([`leading_name`]).
//!
//! Omaha Hi/Lo is read (`hi_lo_variants`): one unlabelled `wins:` line per
//! award, the halves from the cards.

use std::sync::LazyLock;

use regex::Regex;

use super::ipoker::{highest_seat, next_table_size};
use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
};
use super::shared::p2_partygaming::split_lines;
use super::shared::p4_textroom::{leading_name, names_by_length, refuse_lossy_text, strict_amount};
use super::shared::ps_gg_hand::split_before_line_starts;
use super::shared::variant_lock::{
    OMAHA_HI_LO, canonical_game_label, unsupported_variant_skip, variant_of,
};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::unit_for_code;
use crate::phf::serialize::{date_utc, matches_at_line_start, to_iso_string};
use crate::phf::{
    ActionType, CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant, is_hi_lo_label,
};

/// `VERSION`.
pub const ENTRACTION_PARSER_VERSION: &str = "1.0.0";

/// `ENTRACTION_VARIANTS`: Hold'em, four- and five-card Omaha.
const ENTRACTION_VARIANTS: &[Variant] = &[Variant::Holdem, Variant::Omaha, Variant::Omaha5];
/// `ENTRACTION_HI_LO`: four-card `Omaha Hi/Lo`.
const ENTRACTION_HI_LO: &[Variant] = OMAHA_HI_LO;

static HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r#"^Game\s#\s*(\d+)\s+-\s+(.+?)\s+(No Limit|Pot Limit|Fixed Limit)\s+([A-Z]{3})\s+([\d.,]+)\/([\d.,]+)\s+-\s+Table\s+"(.*)"\s*$"#,
    ""
);
static MAX_SEATS: LazyLock<Regex> = crate::js_regex_lazy!(r"^Players\(max\s+(\d+)\)\s*:\s*$", "i");
static SEAT_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.*?)\s+\(([A-Z]{3})\s+([\d.,]+)\s+in seat\s+(\d+)\)\s*$",
    ""
);
static DEALER_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealer:\s+(.+?)\s*$", "");
static BLIND_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(Small|Big)\s+Blind:\s+(.+?)\s+\(([\d.,]+)\)\s*$", "i");
static STREET_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(Flop|Turn|River)\s+(\S.*?)\s*$", "");
static RAKE_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Rake:\s+[A-Z]{3}\s+([\d.,]+)\s*$", "");
static ENDED_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Game ended\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(?:GMT([+-]\d{2}):?(\d{2}))?\s*$",
    ""
);

/// `detect`'s second probe, `/^Game\s#\s*\d+\s+-\s+.+\s+-\s+Table\s+"/m`, at
/// every JavaScript line start.
static DETECT_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r#"^Game\s#\s*\d+\s+-\s+.+\s+-\s+Table\s+""#, "");
/// `splitHands`' `/(?=^Game\s#\s*\d+\s+-\s)/m`, at line starts.
static CHUNK_START: LazyLock<Regex> = crate::js_regex_lazy!(r"^Game\s#\s*\d+\s+-\s", "");

static DASHES: LazyLock<Regex> = crate::js_regex_lazy!(r"\s+-\s+", "g");
static FLOP: LazyLock<Regex> = crate::js_regex_lazy!(r"^flop$", "i");
static TURN: LazyLock<Regex> = crate::js_regex_lazy!(r"^turn$", "i");
static SMALL: LazyLock<Regex> = crate::js_regex_lazy!(r"^small$", "i");
static PAYBACK: LazyLock<Regex> = crate::js_regex_lazy!(r"^Payback\s+\(([\d.,]+)\)$", "i");

/* readAction's patterns */
static WAGERED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(Call|Bet|Raise|All-In)\s+\(([\d.,]+)\)$", "i");
static FOLD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Fold$", "i");
static CHECK: LazyLock<Regex> = crate::js_regex_lazy!(r"^Check$", "i");
static SHOWS: LazyLock<Regex> = crate::js_regex_lazy!(r"^shows:\s+(.+)$", "i");
static MUCKED: LazyLock<Regex> = crate::js_regex_lazy!(r"^didn't show hand(?:\s+\((.+)\))?$", "i");
static WINS: LazyLock<Regex> = crate::js_regex_lazy!(r"^wins:\s+[A-Z]{3}\s+([\d.,]+)$", "i");

/* limitOf's patterns */
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Pot Limit$", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Fixed Limit$", "i");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

fn line_number(i: usize) -> Option<u32> {
    u32::try_from(i + 1).ok()
}

fn group<'t>(captures: &regex::Captures<'t>, i: usize) -> &'t str {
    captures.get(i).map_or("", |m| m.as_str())
}

/// `extractCards(text.replace(/\s+-\s+/g, " "))`: a dash-separated card list.
fn dashed_cards(text: &str) -> Vec<String> {
    extract_cards(&DASHES.replace_all(text, " "))
}

/// `limitOf(limit)`: Entraction's limit clause.
fn limit_of(limit: &str) -> LimitType {
    if POT_LIMIT.is_match(limit) {
        LimitType::Pl
    } else if FIXED_LIMIT.is_match(limit) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

/// `fallbackMaxSeats(seats)`.
fn fallback_max_seats(seats: &[DraftSeat]) -> JsNumber {
    next_table_size(&[2, 6, 9, 10], highest_seat(seats))
}

/// `isoFromEntractionDate(match)`: `Game ended 2012-05-31 23:30:38
/// GMT+01:00` as a UTC instant; no offset is UTC.
fn iso_from_entraction_date(ended: &regex::Captures<'_>) -> Option<String> {
    let field = |i: usize| JsNumber::parse(group(ended, i)).to_i64();
    // Every field is a run of ASCII digits: `Date.UTC` is never `NaN` here.
    let local = date_utc(
        field(1)?,
        field(2)? - 1,
        field(3)?,
        field(4)?,
        field(5)?,
        field(6)?,
    )?;
    let offset = match ended.get(7) {
        Some(hours) => {
            let sign = if hours.as_str().starts_with('-') {
                -1
            } else {
                1
            };
            let minutes = ended
                .get(8)
                .map_or(Some(0), |m| JsNumber::parse(m.as_str()).to_i64())?;
            sign * (JsNumber::parse(hours.as_str()).abs().to_i64()? * 60 + minutes)
        }
        None => 0,
    };
    Some(to_iso_string(local - offset * 60_000))
}

/// `readAction(rest, player, unit, street, actions, collected)`.
fn read_action(
    rest: &str,
    player: &str,
    unit: &CurrencyUnit,
    street: DraftStreet,
    actions: &mut Vec<DraftAction>,
    collected: &mut Vec<DraftCollect>,
) -> Result<bool, ParseSkip> {
    let action = |kind: DraftKind| DraftAction::new(street, player, kind);
    if let Some(wagered) = WAGERED.captures(rest) {
        let verb = js::to_lower_case(group(&wagered, 1));
        // `All-In` covers a call, a bet and a raise alike.
        let kind = match verb.as_str() {
            "all-in" => DraftKind::Allin,
            "call" => DraftKind::Call,
            "bet" => DraftKind::Bet,
            _ => DraftKind::Raise,
        };
        let mut wager = action(kind);
        wager.amount = Some(strict_amount(group(&wagered, 2), unit, "an action line")?);
        wager.all_in = verb == "all-in";
        actions.push(wager);
        return Ok(true);
    }
    if FOLD.is_match(rest) {
        actions.push(action(DraftKind::Fold));
        return Ok(true);
    }
    if CHECK.is_match(rest) {
        actions.push(action(DraftKind::Check));
        return Ok(true);
    }
    if let Some(shows) = SHOWS.captures(rest) {
        let mut show = action(DraftKind::Show);
        show.cards = Some(dashed_cards(group(&shows, 1)));
        actions.push(show);
        return Ok(true);
    }
    // `didn't show hand (Jd - Qh - 6s - Ac)`: a muck the room printed anyway.
    if let Some(mucked) = MUCKED.captures(rest) {
        let mut muck = action(DraftKind::Muck);
        muck.cards = Some(dashed_cards(group(&mucked, 1)));
        actions.push(muck);
        return Ok(true);
    }
    if let Some(wins) = WINS.captures(rest) {
        collected.push(DraftCollect {
            player: player.to_owned(),
            amount: strict_amount(group(&wins, 1), unit, "a wins line")?,
            pot_name: Some("pot".to_owned()),
            half: None,
        });
        return Ok(true);
    }
    Ok(false)
}

/// `{ player, amount }` of a `Payback` line.
struct StatedPayback {
    player: String,
    amount: JsNumber,
}

fn warning(code: &str, message: String) -> PhfWarning {
    PhfWarning {
        code: code.to_owned(),
        message,
        line: None,
    }
}

/// `crossCheck(hand, statedRake, statedPayback)`: the room's `Rake:` and
/// `Payback` against the reconstruction.
fn cross_check(hand: &mut PhfHand, stated_rake: Option<JsNumber>, payback: Option<&StatedPayback>) {
    let one = JsNumber::from_i64(1);
    let rake = JsNumber::from_i64(hand.results.fees.rake);
    let mut found = Vec::new();
    if let Some(stated) = stated_rake
        && (stated - rake).abs().greater_than(one)
    {
        found.push(warning(
            "rake-mismatch",
            format!(
                "The hand states a rake of {} but the reconstruction derives {}.",
                stated.to_js_string(),
                rake.to_js_string()
            ),
        ));
    }
    let derived = hand
        .actions
        .iter()
        .find(|action| action.kind == ActionType::Uncalled)
        .map(|action| (action.player.clone(), -JsNumber::from_i64(action.amount)));
    match (payback, derived) {
        (Some(stated), None) => found.push(warning(
            "payback-mismatch",
            format!(
                "The hand pays {} back to {} but the betting stream leaves nothing uncalled.",
                stated.amount.to_js_string(),
                stated.player
            ),
        )),
        (Some(stated), Some((player, returned))) => {
            if player != stated.player || (returned - stated.amount).abs().greater_than(one) {
                found.push(warning(
                    "payback-mismatch",
                    format!(
                        "The hand pays {} back to {}; the stream returns {} to {player}.",
                        stated.amount.to_js_string(),
                        stated.player,
                        returned.to_js_string()
                    ),
                ));
            }
        }
        (None, Some((player, returned))) => found.push(warning(
            "payback-mismatch",
            format!(
                "The stream returns {} to {player} but the hand prints no `Payback` line.",
                returned.to_js_string()
            ),
        )),
        (None, None) => {}
    }
    hand.meta.warnings.append(&mut found);
}

/// `entractionParser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let source = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    refuse_lossy_text(source, "Entraction")?;
    let lines = split_lines(source);
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let Some(header) = HEADER.captures(lines[0]) else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk does not open with an Entraction header line.",
        ));
    };
    let hand_id = group(&header, 1);
    let game_word = group(&header, 2);
    let limit_word = group(&header, 3);
    let currency = group(&header, 4);
    let small_blind = group(&header, 5);
    let big_blind = group(&header, 6);
    let table_name = group(&header, 7);
    // Hi/lo on its own terms first, so a refused one names the split pot.
    if let Some(refusal) = unsupported_game_skip(game_word, ENTRACTION_HI_LO)
        .or_else(|| unsupported_variant_skip(game_word, ENTRACTION_VARIANTS))
    {
        return Err(refusal.into());
    }
    let variant = variant_of(game_word);
    let unit = unit_for_code(currency, None);

    // The seat list first: names can contain spaces.
    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut max_seats = JsNumber::ZERO;
    for line in &lines {
        if let Some(size) = MAX_SEATS.captures(js::trim(line)) {
            max_seats = JsNumber::parse(group(&size, 1));
            continue;
        }
        if let Some(seat) = SEAT_LINE.captures(line) {
            seats.push(DraftSeat {
                seat: JsNumber::parse(group(&seat, 4)),
                name: js::trim(group(&seat, 1)).to_owned(),
                starting_stack: strict_amount(group(&seat, 3), &unit, "a seat line")?,
                dealt_in: true,
                is_hero: false,
                dealt_cards: Vec::new(),
            });
        }
    }
    if seats.is_empty() {
        return Err(skip(
            SkipReason::NoPlayers,
            "The chunk has no `(<CUR> <amount> in seat <n>)` lines.",
        ));
    }
    let names = names_by_length(&seats.iter().map(|s| s.name.clone()).collect::<Vec<_>>());

    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    let mut street = DraftStreet::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut button_seat: Option<JsNumber> = None;
    let mut played_at: Option<String> = None;
    let mut stated_rake: Option<JsNumber> = None;
    let mut stated_payback: Option<StatedPayback> = None;

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let line = js::trim_end(raw_line);
        let line_no = line_number(i);
        if js::trim(line).is_empty()
            || MAX_SEATS.is_match(js::trim(line))
            || SEAT_LINE.is_match(line)
        {
            continue;
        }

        if let Some(dealer) = DEALER_LINE.captures(line) {
            let name = js::trim(group(&dealer, 1));
            button_seat = seats
                .iter()
                .find(|seat| seat.name == name)
                .map(|seat| seat.seat);
            if button_seat.is_none() {
                warnings.push(PhfWarning {
                    code: "unknown-line".to_owned(),
                    message: format!("Dealer \"{name}\" is not a seated player."),
                    line: line_no,
                });
            }
            continue;
        }

        if let Some(blind) = BLIND_LINE.captures(line) {
            let player = js::trim(group(&blind, 2));
            if names.iter().any(|name| name == player) {
                // The order is kept as the room wrote it.
                let kind = if SMALL.is_match(group(&blind, 1)) {
                    DraftKind::SmallBlind
                } else {
                    DraftKind::BigBlind
                };
                let mut post = DraftAction::new(DraftStreet::Preflop, player, kind);
                post.amount = Some(strict_amount(group(&blind, 3), &unit, "a blind line")?);
                actions.push(post);
                continue;
            }
        }

        if let Some(marker) = STREET_LINE.captures(line) {
            // The line repeats the whole board so far; only the tail is new.
            let cards = dashed_cards(group(&marker, 2));
            let word = group(&marker, 1);
            if FLOP.is_match(word) {
                street = DraftStreet::Flop;
                flop = Some(cards.into_iter().take(3).collect());
            } else if TURN.is_match(word) {
                street = DraftStreet::Turn;
                turn = cards.into_iter().nth(3);
            } else {
                street = DraftStreet::River;
                river = cards.into_iter().nth(4);
            }
            continue;
        }

        if let Some(rake) = RAKE_LINE.captures(line) {
            stated_rake = Some(strict_amount(group(&rake, 1), &unit, "the rake line")?);
            continue;
        }
        if let Some(ended) = ENDED_LINE.captures(line) {
            played_at = iso_from_entraction_date(&ended);
            continue;
        }

        if let Some(hit) = leading_name(js::trim(line), &names) {
            if let Some(payback) = PAYBACK.captures(hit.rest) {
                // For the cross-check only: the builder derives the return.
                stated_payback = Some(StatedPayback {
                    player: hit.name.to_owned(),
                    amount: strict_amount(group(&payback, 1), &unit, "a Payback line")?,
                });
                continue;
            }
            if read_action(
                hit.rest,
                hit.name,
                &unit,
                street,
                &mut actions,
                &mut collected,
            )? {
                continue;
            }
        }

        warnings.push(PhfWarning {
            code: "unknown-line".to_owned(),
            message: js::trim(line).to_owned(),
            line: line_no,
        });
    }

    if collected.is_empty() {
        return Err(skip(
            SkipReason::NoWinner,
            "No `<name> wins:` line, so the source never says who was given the pot.",
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

    let game_label = canonical_game_label(variant, limit_of(limit_word), is_hi_lo_label(game_word));
    let header_small_blind = strict_amount(small_blind, &unit, "the header stakes")?;
    let header_big_blind = strict_amount(big_blind, &unit, "the header stakes")?;
    let max_seats = max_seats.max_of(fallback_max_seats(&seats));
    let draft = HandDraft {
        site_id: "entraction".to_owned(),
        site_name: "Entraction".to_owned(),
        parser_id: "entraction".to_owned(),
        parser_version: ENTRACTION_PARSER_VERSION.to_owned(),
        hand_prefix: "ENT-".to_owned(),
        hand_id: hand_id.to_owned(),
        game_label,
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
        // `Payback` takes the uncalled bet out before `wins:` is printed.
        collected_includes_uncalled: false,
        raw_text: source.to_owned(),
        warnings,
    };

    let mut hand = build_hand(&draft, ctx)?;
    cross_check(&mut hand, stated_rake, stated_payback.as_ref());
    Ok(hand)
}

/// `entractionParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct EntractionParser;

impl SiteParser for EntractionParser {
    fn id(&self) -> &'static str {
        "entraction"
    }

    fn name(&self) -> &'static str {
        "Entraction"
    }

    fn version(&self) -> &'static str {
        ENTRACTION_PARSER_VERSION
    }

    fn hi_lo_variants(&self) -> &'static [Variant] {
        ENTRACTION_HI_LO
    }

    /// 0.95 for the whole header shape (the whole text, or at a line start
    /// up to `Table "`): Unibet's 2021 `Game #1: Table` must not be claimed.
    fn detect(&self, text: &str) -> u32 {
        if HEADER.is_match(text) || matches_at_line_start(&DETECT_LINE, text) {
            950
        } else {
            0
        }
    }

    /// A chunk per `Game # <id> - ` at a line start, a BOM and the edges
    /// trimmed, kept when its first line is a whole header.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(text, &CHUNK_START)
            .into_iter()
            .map(|chunk| js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk)))
            .filter(|chunk| HEADER.is_match(split_lines(chunk)[0]))
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

    const SOURCE: &str = include_str!("../../../../web/src/lib/parsers/entraction.ts");

    #[test]
    fn patterns_and_messages_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r#"/^Game\s#\s*(\d+)\s+-\s+(.+?)\s+(No Limit|Pot Limit|Fixed Limit)\s+([A-Z]{3})\s+([\d.,]+)\/([\d.,]+)\s+-\s+Table\s+"(.*)"\s*$/;"#,
            r"const MAX_SEATS = /^Players\(max\s+(\d+)\)\s*:\s*$/i;",
            r"const SEAT_LINE = /^(.*?)\s+\(([A-Z]{3})\s+([\d.,]+)\s+in seat\s+(\d+)\)\s*$/;",
            r"const DEALER_LINE = /^Dealer:\s+(.+?)\s*$/;",
            r"const BLIND_LINE = /^(Small|Big)\s+Blind:\s+(.+?)\s+\(([\d.,]+)\)\s*$/i;",
            r"const STREET_LINE = /^(Flop|Turn|River)\s+(\S.*?)\s*$/;",
            r"const RAKE_LINE = /^Rake:\s+[A-Z]{3}\s+([\d.,]+)\s*$/;",
            r"const ENDED_LINE = /^Game ended\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(?:GMT([+-]\d{2}):?(\d{2}))?\s*$/;",
            r#"if (HEADER.test(text) || /^Game\s#\s*\d+\s+-\s+.+\s+-\s+Table\s+"/m.test(text)) {"#,
            r".split(/(?=^Game\s#\s*\d+\s+-\s)/m)",
            r"/\s+-\s+/g",
            r"/^flop$/i.test(marker[1])",
            r"/^turn$/i.test(marker[1])",
            r"/^small$/i.test(blind[1])",
            r"hit.rest.match(/^Payback\s+\(([\d.,]+)\)$/i)",
            r"rest.match(/^(Call|Bet|Raise|All-In)\s+\(([\d.,]+)\)$/i)",
            r"/^Fold$/i.test(rest)",
            r"/^Check$/i.test(rest)",
            r"rest.match(/^shows:\s+(.+)$/i)",
            r"rest.match(/^didn't show hand(?:\s+\((.+)\))?$/i)",
            r"rest.match(/^wins:\s+[A-Z]{3}\s+([\d.,]+)$/i)",
            r"/^Pot Limit$/i.test(limit)",
            r"/^Fixed Limit$/i.test(limit)",
            "[2, 6, 9, 10]",
            "const VERSION = \"1.0.0\";",
            "handPrefix: \"ENT-\",",
            "refuseLossyText(source, \"Entraction\");",
            "\"The chunk does not open with an Entraction header line.\"",
            "\"The chunk has no `(<CUR> <amount> in seat <n>)` lines.\"",
            "message: `Dealer \"${dealer[1].trim()}\" is not a seated player.`,",
            "\"No `<name> wins:` line, so the source never says who was given the pot.\",",
            "`The flop line lists ${flop.length} readable cards, so the hand is corrupt.`,",
            "`The hand states a rake of ${statedRake} but the reconstruction derives ` +",
            "`${hand.results.fees.rake}.`,",
            "`The hand pays ${statedPayback.amount} back to ${statedPayback.player} but the ` +",
            "\"betting stream leaves nothing uncalled.\",",
            "`The hand pays ${statedPayback.amount} back to ${statedPayback.player}; the ` +",
            "`stream returns ${-derived.amount} to ${derived.player}.`,",
            "`The stream returns ${-derived.amount} to ${derived.player} but the hand prints ` +",
            "\"no `Payback` line.\",",
            "Math.abs(-derived.amount - statedPayback.amount) > 1",
            "\"a seat line\"",
            "\"a blind line\"",
            "\"the rake line\"",
            "\"a Payback line\"",
            "\"the header stakes\"",
            "\"an action line\"",
            "\"a wins line\"",
            "potName: \"pot\",",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    /// `isoFromEntractionDate`, recorded from Node.
    #[test]
    fn game_ended_is_read_with_its_offset() {
        let at = |line: &str| {
            iso_from_entraction_date(&ENDED_LINE.captures(line).expect("an ended line"))
        };
        assert_eq!(
            at("Game ended 2012-05-31 08:56:27 GMT+01:00").as_deref(),
            Some("2012-05-31T07:56:27.000Z")
        );
        assert_eq!(
            at("Game ended 2012-05-31 23:30:38 GMT-0530").as_deref(),
            Some("2012-06-01T05:00:38.000Z")
        );
        assert_eq!(
            at("Game ended 2012-05-31 23:30:38").as_deref(),
            Some("2012-05-31T23:30:38.000Z")
        );
        // `Date.UTC` rolls every field over, and years below 100 are 19xx.
        assert_eq!(
            at("Game ended 0050-13-32 25:61:61 GMT+99:99").as_deref(),
            Some("1951-01-28T21:23:01.000Z")
        );
    }

    #[test]
    fn detects_the_whole_header_only() {
        for (text, expected) in [
            (
                "Game # 1 - Texas Hold'em No Limit EUR 0.25/0.50 - Table \"B\"",
                950,
            ),
            ("x\rGame # 1 - a - Table \"", 950),
            ("x\u{2028}Game #1 - a - Table \"", 950),
            (
                "Game #1463192545: Table €1 NL - 0.05/0.10 - No Limit Hold'Em",
                0,
            ),
            (" Game # 1 - a - Table \"", 0),
        ] {
            assert_eq!(EntractionParser.detect(text), expected, "{text:?}");
        }
    }
}
