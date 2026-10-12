//! `pokerbros`: PokerBros (`frontend/src/lib/parsers/pokerbros.ts`).
//!
//! PokerBros has no published native export; every file is third-party
//! converter output, and the two real files are the *same hand* in two
//! converter dialects:
//!
//! - **Dialect A**, party-classic: `***** Hand History for Game N *****
//!   (PokerBros)`, bracketed amounts, HUD stats on the seat lines, no
//!   SUMMARY, no uncalled return - read with the PartyGaming machinery
//!   ([`p2_partygaming`](super::shared::p2_partygaming),
//!   [`p2_handbuilder`](super::shared::p2_handbuilder)). A `raises [$2.50]`
//!   is the raise-to total, a `calls [$2.00]` the chips added.
//! - **Dialect B**, PokerStars-family: `PokerBros Hand #…`, read with
//!   [`parse_stars_family_body`] into a [`StarsHandDraft`].
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `pokerbros.ts`). The two multiline (`/m`) patterns are matched at every
//! JavaScript line start (after `\n`, `\r`, U+2028, U+2029); the banner's
//! trailing `\s*$` under `m` is checked as code (`ends_a_line`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::{Captures, Regex};

use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
};
use super::shared::p2_partygaming::{
    PARTY_DATE_REGEX, PARTY_GAME_REGEX, bracket_amount, is_noise_line, iso_from_party_date,
    known_zone, split_lines, unit_for,
};
use super::shared::p3_draft::{
    DraftGame, StarsHandDraft, detect_decimals, detect_pad_hour, has_unsupported_currency,
    limit_from_label, normalize_newlines, strip_bom, to_lines, unit_for_stakes, variant_from_label,
};
use super::shared::p3_stars_dialect::parse_stars_family_body;
use super::shared::ps_gg_hand::{BuildError, DraftInit, split_before_line_starts, unseated};
use crate::cards::extract_cards;
use crate::detect::{ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError};
use crate::js::{self, JsNumber};
use crate::phf::money::{CHIPS, parse_amount, parse_amount_js};
use crate::phf::serialize::{line_starts, parse_instant, to_iso_string};
use crate::phf::{
    Amount, CurrencyUnit, DecimalStyle, GameFormat, PhfHand, PhfTextStyle, PhfWarning, Variant,
};

/// `POKERBROS_PARSER_VERSION`.
pub const POKERBROS_PARSER_VERSION: &str = "1.0.0";

/* -------------------------------------------------------------- detection */

/// `PARTY_BANNER_REGEX` (`/…\s*$/im`) without its trailing `\s*$`, which
/// [`ends_a_line`] checks.
const PARTY_BANNER_BODY: &str =
    r"^\*{3,}\s*Hand History for Game\s+(\d+)\s*\*{3,}\s*\((PokerBros)\)";
static PARTY_BANNER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(PARTY_BANNER_BODY, "i"));
/// The split's lookahead body (`m` only: case-sensitive).
static PARTY_BANNER_SPLIT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*{3,}\s*Hand History for Game\s+\d+\s*\*{3,}\s*\(PokerBros\)",
    ""
);

static STARS_HEADER_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^PokerBros Hand #(\d+):\s*(.*)$", "");
/// `STARS_HEADER_PREFIX`, and the body of `STARS_HEADER_LINE` (`/m`).
static STARS_HEADER_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^PokerBros Hand #\d+:", "");
static BRANDING: LazyLock<Regex> = crate::js_regex_lazy!(r"\bPokerBros\b", "");

/// Whether `\s*$` under the `m` flag matches at the start of `rest`: a run of
/// JavaScript whitespace that reaches the end or holds a line terminator.
fn ends_a_line(rest: &str) -> bool {
    for c in rest.chars() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            return true;
        }
        if !js::is_whitespace(c) {
            return false;
        }
    }
    true
}

/// `text.match(PARTY_BANNER_REGEX)`: the first match at a JavaScript line
/// start whose banner ends its line.
fn party_banner(text: &str) -> Option<Captures<'_>> {
    line_starts(text).find_map(|start| {
        let captures = PARTY_BANNER.captures(&text[start..])?;
        let end = captures.get(0).map_or(0, |m| m.end());
        ends_a_line(&text[start + end..]).then_some(captures)
    })
}

/// `STARS_HEADER_LINE.test(text)`.
fn has_stars_header_line(text: &str) -> bool {
    line_starts(text).any(|start| STARS_HEADER_PREFIX.is_match(&text[start..]))
}

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

/* ---------------------------------------------------------- dialect B (PS) */

static STARS_CASH: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$", "");
static BLINDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\s*(\S+)\/(\S+)", "");
static STARS_PLAYED_AT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})", "");

/// `blindsFrom(stakesText, unit)`.
fn blinds_from(stakes_text: &str, unit: &CurrencyUnit) -> (Amount, Amount) {
    match BLINDS.captures(stakes_text) {
        None => (0, parse_amount(js::trim(stakes_text), unit)),
        Some(c) => (parse_amount(&c[1], unit), parse_amount(&c[2], unit)),
    }
}

/// `buttonBeforeSmallBlind(seats, smallBlindSeat)`: heads-up the small
/// blind itself, else the occupied seat before it, wrapping round.
fn button_before_small_blind(seats: &[u32], small_blind_seat: Option<u32>) -> Option<u32> {
    let small_blind_seat = small_blind_seat?;
    if seats.len() < 2 {
        return None;
    }
    let mut sorted = seats.to_vec();
    sorted.sort_unstable();
    let index = sorted.iter().position(|seat| *seat == small_blind_seat)?;
    if sorted.len() == 2 {
        return Some(small_blind_seat);
    }
    Some(sorted[(index + sorted.len() - 1) % sorted.len()])
}

struct StarsHeader {
    hand_id: String,
    payload: String,
    game: DraftGame,
}

/// `parseStarsHeader(line)`: `Hold'em No Limit ($0.5/$1 USD) - 2021/03/19
/// 19:51:54 UTC`.
fn parse_stars_header(line: &str) -> Option<StarsHeader> {
    let header = STARS_HEADER_REGEX.captures(line)?;
    let cash = STARS_CASH.captures(&header[2])?;
    let label = js::trim(&cash[1]).to_owned();
    let unit = unit_for_stakes(&cash[2], &CHIPS.unit())?;
    let (small_blind, big_blind) = blinds_from(&cash[2], &unit);
    Some(StarsHeader {
        hand_id: header[1].to_owned(),
        payload: header[2].to_owned(),
        game: DraftGame {
            variant: variant_from_label(&label),
            limit: limit_from_label(&label),
            format: GameFormat::Cash,
            label,
            unit,
            small_blind,
            big_blind,
        },
    })
}

/// `parseStarsPlayedAt(payload)`: the stated time, read as UTC.
fn parse_stars_played_at(payload: &str) -> Option<String> {
    let c = STARS_PLAYED_AT.captures(payload)?;
    let hour = &c[4];
    let hour = if hour.len() < 2 {
        format!("0{hour}")
    } else {
        hour.to_owned()
    };
    let iso = format!("{}-{}-{}T{hour}:{}:{}Z", &c[1], &c[2], &c[3], &c[5], &c[6]);
    parse_instant(&iso).map(to_iso_string)
}

/// `parseStarsDialect(raw, ctx)`.
fn parse_stars_dialect(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(strip_bom(raw));
    let lines = to_lines(text);
    let first = lines.first().copied().unwrap_or("");
    if has_unsupported_currency(first) {
        return Err(skip(
            SkipReason::UnsupportedCurrency,
            format!("PHF has no unit for the currency in \"{first}\"."),
        ));
    }
    let Some(header) = parse_stars_header(first) else {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The chunk has no readable PokerBros header.",
        ));
    };
    if header.game.variant != Variant::Holdem {
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "{} is not supported yet; the hand is kept for a future parser.",
                header.game.label
            ),
        ));
    }

    let unit = header.game.unit.clone();
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "pokerbros".to_owned(),
        site_name: "PokerBros".to_owned(),
        parser_id: "pokerbros".to_owned(),
        parser_version: POKERBROS_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        hand_key: format!("PB{}", header.hand_id),
        raw_text: text.to_owned(),
        original_filename: ctx.source_filename.map(str::to_owned),
        game: header.game,
        tournament: None,
        played_at: parse_stars_played_at(&header.payload),
        text_style: PhfTextStyle {
            decimals: detect_decimals(text),
            pad_hour: detect_pad_hour(&header.payload),
            ..PhfTextStyle::default()
        },
        repair_missing_uncalled: false,
        parsed_at: ctx.parsed_at().to_owned(),
    });

    let body = parse_stars_family_body(&lines, &mut draft, &unit)?;

    if draft.player_count() == 0 {
        return Err(skip(
            SkipReason::NoSeatBlock,
            "The hand lists no seats, so nobody can be attributed.",
        ));
    }
    // A button on an empty seat is this converter's made-up number (its
    // dialect-A twin says seat 1): corrected only from a posted small blind,
    // with the printed seat kept in the warning.
    // The button as the JavaScript number it is: one beyond `u32` is on no
    // seat either, and is corrected like any other.
    if let Some(button) = body.button_seat_number
        && !body
            .seats
            .iter()
            .any(|seat| JsNumber::from_u64(u64::from(*seat)).strict_equals(button))
    {
        let derived = button_before_small_blind(&body.seats, body.small_blind_seat);
        draft.warn(
            "button-seat-empty",
            format!(
                "The table line puts the button on seat {}, which nobody occupies{}",
                button.to_js_string(),
                derived.map_or_else(
                    || "; no small blind was posted, so the button is left as printed.".to_owned(),
                    |derived| format!(
                        "; it was read as seat {derived}, the seat before the small blind."
                    ),
                )
            ),
            None,
        );
        if let Some(derived) = derived {
            draft.set_table_numbers(
                body.table_name.clone(),
                body.max_seats_number,
                Some(JsNumber::from_u64(u64::from(derived))),
                None,
            );
        }
    }

    let mut hand = match draft.build() {
        Ok(hand) => hand,
        Err(BuildError::Thrown(thrown)) => return Err(ParseError::Bug(thrown.message)),
        Err(BuildError::UnseatedStraddler) => {
            return Err(unseated(draft.first_unseated_actor().unwrap_or_default()));
        }
    };
    // Promotional chips the room put in itself, not actions.
    if !body.chip_movements.is_empty() {
        hand.chip_movements = Some(body.chip_movements);
    }
    let seated = draft.seated_names();
    if let Some(stranger) = hand
        .actions
        .iter()
        .find(|action| !seated.contains(&action.player))
    {
        return Err(unseated(&stranger.player));
    }
    Ok(hand)
}

/* ------------------------------------------------------ dialect A (party) */

static A_TABLE_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Table\s+(.+?)\s+\((Real|Play) Money\)\s*$", "i");
static A_BUTTON_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+)\s+is the button\s*$", "i");
static A_SEAT_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Seat\s+(\d+):\s+(.+?)\s+\(\s*([^)]*?)\s*\)(?:\s+-\s+\(([^)]*)\))?\s*$",
    ""
);
static A_STREET_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?",
    "i"
);
static A_SEAT_COUNT_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Total number of players\s*:\s*(\d+)", "i");
static HOLDEM: LazyLock<Regex> = crate::js_regex_lazy!(r"(?:texas\s+)?hold\s*'?em|holdem", "i");
static A_DEALT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Dealt to\s+(.+?)\s*\[\s*([^\]]*?)\s*\]\s*$", "");
static A_BLIND: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+posts\s+(small|big)\s+blind\s+\[([^\]]*)\]\.?\s*$",
    "i"
);
static A_SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?)\s+(folds|checks)\s*$", "i");
static A_WAGER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+(bets|calls|raises)\s+\[([^\]]*)\]\s*$", "i");
static A_WINS: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+wins\s+([^\s]+)\s*(?:USD|EUR|GBP)?\s*(?:from (?:the )?(.+?))?\s*$",
    "i"
);
static NOT_AMOUNT: LazyLock<Regex> = crate::js_regex_lazy!(r"[^\d.,]", "g");

fn warning(code: &str, message: impl Into<String>, line: Option<u32>) -> PhfWarning {
    PhfWarning {
        code: code.to_owned(),
        message: message.into(),
        line,
    }
}

/// `parsePartyDialect(raw, ctx)`.
#[allow(clippy::too_many_lines)]
fn parse_party_dialect(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim_end(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    let lines = split_lines(text);
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let banner = lines
        .iter()
        .position(|line| party_banner(js::trim(line)).is_some())
        .and_then(|i| party_banner(js::trim(lines[i])).map(|c| (i, c[1].to_owned())));
    let Some((banner_index, hand_id)) = banner else {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The chunk has no PokerBros banner line.",
        ));
    };

    let stakes_line = js::trim(lines.get(banner_index + 1).copied().unwrap_or(""));
    let date = PARTY_DATE_REGEX.captures(stakes_line);
    let game = date
        .as_ref()
        .and_then(|date| PARTY_GAME_REGEX.captures(date.get(1).map_or("", |m| m.as_str())));
    let (Some(date), Some(game)) = (date, game) else {
        return Err(skip(
            SkipReason::NormalizedUnparseable,
            "The PokerBros stakes line is missing or unreadable, so the game is unknown.",
        ));
    };
    if !HOLDEM.is_match(&game[7]) {
        return Err(skip(
            SkipReason::UnsupportedVariant,
            format!(
                "Round one is Hold'em only; this hand is \"{}\".",
                js::trim(&game[7])
            ),
        ));
    }
    // The single number is the table's maximum buy-in, not the stakes.
    let symbol = match game.get(1).map_or("", |m| m.as_str()) {
        "" => game.get(3).map_or("", |m| m.as_str()),
        symbol => symbol,
    };
    let unit = unit_for(symbol);
    let played_at = iso_from_party_date(
        &date[2], &date[3], &date[4], &date[5], &date[6], &date[7], &date[8],
    );
    if !known_zone(&date[7]) {
        warnings.push(warning(
            "unknown-timezone",
            format!(
                "Timezone \"{}\" is not in the offset table; the hand is timed as UTC.",
                &date[7]
            ),
            None,
        ));
    }
    // A 12-hour clock without a meridiem: kept as printed, and flagged.
    warnings.push(warning(
        "ambiguous-timestamp",
        format!(
            "The header time \"{}:{}:{} {}\" is a 12-hour clock with no AM/PM marker, so the \
             hand may be twelve hours out.",
            &date[4], &date[5], &date[6], &date[7]
        ),
        None,
    ));

    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    let mut street = DraftStreet::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut button_seat: Option<JsNumber> = None;
    let mut table_name: Option<String> = None;
    let mut max_seats = JsNumber::ZERO;
    let mut seat_names: HashSet<String> = HashSet::new();

    for (i, raw_line) in lines.iter().enumerate() {
        if i == banner_index || i == banner_index + 1 {
            continue;
        }
        let line = js::trim(raw_line);
        let line_no = u32::try_from(i + 1).ok();
        if line.is_empty() {
            continue;
        }

        if let Some(table) = A_TABLE_REGEX.captures(line) {
            table_name = Some(table[1].to_owned());
            continue;
        }
        if let Some(button) = A_BUTTON_REGEX.captures(line) {
            button_seat = Some(JsNumber::parse(&button[1]));
            continue;
        }
        if let Some(count) = A_SEAT_COUNT_REGEX.captures(line) {
            max_seats = JsNumber::parse(&count[1]);
            continue;
        }
        if let Some(seat) = A_SEAT_REGEX.captures(line) {
            // The fourth group is the converter's HUD tuple: dropped.
            let stack = NOT_AMOUNT.replace_all(&seat[3], "");
            seats.push(DraftSeat {
                seat: JsNumber::parse(&seat[1]),
                name: seat[2].to_owned(),
                starting_stack: parse_amount_js(&stack, &unit),
                dealt_in: true,
                is_hero: &seat[2] == "Hero",
                dealt_cards: Vec::new(),
            });
            seat_names.insert(seat[2].to_owned());
            continue;
        }

        if let Some(marker) = A_STREET_REGEX.captures(line) {
            let kind = js::to_lower_case(&marker[1]);
            let cards = extract_cards(marker.get(2).map_or("", |m| m.as_str()));
            match kind.as_str() {
                "down cards" => street = DraftStreet::Preflop,
                "flop" => {
                    street = DraftStreet::Flop;
                    flop = Some(cards.into_iter().take(3).collect());
                }
                "turn" => {
                    street = DraftStreet::Turn;
                    turn = cards.last().cloned();
                }
                _ => {
                    street = DraftStreet::River;
                    river = cards.last().cloned();
                }
            }
            continue;
        }

        if let Some(dealt) = A_DEALT.captures(line) {
            if let Some(target) = seats.iter_mut().find(|entry| entry.name == dealt[1]) {
                target.dealt_cards = extract_cards(&dealt[2]);
            } else {
                warnings.push(warning("dealt-to-unseated", line, line_no));
            }
            continue;
        }

        if let Some(blind) = A_BLIND.captures(line) {
            let kind = if js::to_lower_case(&blind[2]) == "small" {
                DraftKind::SmallBlind
            } else {
                DraftKind::BigBlind
            };
            let mut action = DraftAction::new(street, &blind[1], kind);
            action.amount = Some(bracket_amount(&blind[3], &unit));
            actions.push(action);
            continue;
        }

        if let Some(simple) = A_SIMPLE.captures(line)
            && seat_names.contains(&simple[1])
        {
            let kind = if js::to_lower_case(&simple[2]) == "folds" {
                DraftKind::Fold
            } else {
                DraftKind::Check
            };
            actions.push(DraftAction::new(street, &simple[1], kind));
            continue;
        }

        if let Some(wager) = A_WAGER.captures(line)
            && seat_names.contains(&wager[1])
        {
            let verb = js::to_lower_case(&wager[2]);
            let kind = match verb.as_str() {
                "raises" => DraftKind::Raise,
                "calls" => DraftKind::Call,
                _ => DraftKind::Bet,
            };
            let mut action = DraftAction::new(street, &wager[1], kind);
            action.amount = Some(bracket_amount(&wager[3], &unit));
            // A raise states the total it raises to; a bet and a call the
            // chips added.
            action.to_total = verb == "raises";
            actions.push(action);
            continue;
        }

        if let Some(wins) = A_WINS.captures(line)
            && seat_names.contains(&wins[1])
        {
            collected.push(DraftCollect {
                player: wins[1].to_owned(),
                amount: parse_amount_js(&wins[2], &unit),
                pot_name: wins.get(3).map(|m| js::trim(m.as_str()).to_owned()),
                half: None,
            });
            continue;
        }

        if is_noise_line(line) {
            continue;
        }
        warnings.push(warning("unknown-line", line, line_no));
    }

    if seats.is_empty() {
        return Err(skip(
            SkipReason::NoSeatBlock,
            "The hand lists no seats, so nobody can be attributed.",
        ));
    }
    // The seat named `Hero` and the face-up cards disagree in the one
    // confirmed file: the source is followed, the disagreement flagged.
    let named_hero = seats.iter().position(|entry| entry.is_hero);
    let dealt_to = seats.iter().position(|entry| !entry.dealt_cards.is_empty());
    if let (Some(named), Some(dealt)) = (named_hero, dealt_to)
        && named != dealt
    {
        let (named, dealt) = (&seats[named], &seats[dealt]);
        warnings.push(warning(
            "hero-attribution",
            format!(
                "Seat {} is named \"{}\" but the face-up cards were dealt to seat {} ({}); this \
                 converter is known to mis-attribute them.",
                named.seat.to_js_string(),
                named.name,
                dealt.seat.to_js_string(),
                dealt.name
            ),
            None,
        ));
    }

    let max_seats = if max_seats.is_nan() || max_seats.strict_equals(JsNumber::ZERO) {
        seats
            .iter()
            .fold(JsNumber::Infinite { negative: true }, |max, entry| {
                max.max_of(entry.seat)
            })
    } else {
        max_seats
    };
    let draft = HandDraft {
        site_id: "pokerbros".to_owned(),
        site_name: "PokerBros".to_owned(),
        parser_id: "pokerbros".to_owned(),
        parser_version: POKERBROS_PARSER_VERSION.to_owned(),
        hand_prefix: "PB".to_owned(),
        hand_id: hand_id.clone(),
        game_label: "Hold'em No Limit".to_owned(),
        unit,
        decimals: DecimalStyle::Fixed2,
        // The header states a maximum buy-in, never the blinds.
        header_small_blind: JsNumber::ZERO,
        header_big_blind: JsNumber::ZERO,
        table_name,
        max_seats,
        button_seat,
        played_at,
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        // No uncalled return is ever printed: it comes back inside `wins`.
        collected_includes_uncalled: true,
        raw_text: text.to_owned(),
        warnings,
    };

    let mut hand = build_hand(&draft, ctx)?;
    // PHF wants the site's own id on `handId` and the namespaced one as key.
    hand.meta.hand_key = format!("PB{hand_id}");
    hand.meta.hand_id = hand_id;
    Ok(hand)
}

/* ---------------------------------------------------------------- parser */

/// `pokerbrosParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PokerBrosParser;

impl SiteParser for PokerBrosParser {
    fn id(&self) -> &'static str {
        "pokerbros"
    }

    fn name(&self) -> &'static str {
        "PokerBros"
    }

    fn version(&self) -> &'static str {
        POKERBROS_PARSER_VERSION
    }

    /// 0.95 for either dialect's signature, 0.3 for the name alone.
    fn detect(&self, text: &str) -> u32 {
        let head = normalize_newlines(strip_bom(text));
        if has_stars_header_line(&head) || party_banner(&head).is_some() {
            return 950;
        }
        if BRANDING.is_match(&head) {
            return 300;
        }
        0
    }

    /// One dialect per file: split on whichever header it has.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        let normalized = normalize_newlines(strip_bom(text));
        if has_stars_header_line(&normalized) {
            return Ok(split_before_line_starts(&normalized, &STARS_HEADER_PREFIX)
                .into_iter()
                .map(js::trim)
                .filter(|chunk| STARS_HEADER_PREFIX.is_match(chunk))
                .map(str::to_owned)
                .collect());
        }
        Ok(split_before_line_starts(&normalized, &PARTY_BANNER_SPLIT)
            .into_iter()
            .map(js::trim)
            .filter(|chunk| party_banner(chunk).is_some())
            .map(str::to_owned)
            .collect())
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        let text = js::trim_start(strip_bom(raw));
        if STARS_HEADER_PREFIX.is_match(text) {
            return parse_stars_dialect(raw, ctx);
        }
        if party_banner(text).is_some() {
            return parse_party_dialect(raw, ctx);
        }
        Err(skip(
            SkipReason::NormalizedUnparseable,
            "The chunk matches neither PokerBros dialect we have real bytes for.",
        ))
    }
}

#[cfg(test)]
mod tests;
