//! `partypoker`: partypoker (`web/src/lib/parsers/partypoker.ts`).
//!
//! The PartyGaming skeleton 888 shares, with partypoker's own differences:
//!
//! - the stakes line is `$0.05/$0.10 USD NL Texas Hold'em - Monday, January
//!   06, 08:54:23 EST 2014`, and on pot-limit and older no-limit tables
//!   `$100 USD PL Omaha` (the maximum buy-in, no blinds at all), so the
//!   blinds always come from what was posted;
//! - the date carries a zone abbreviation and is converted to UTC;
//! - there is no summary block: showdowns, mucks and winnings are
//!   interleaved with the action;
//! - an uncalled bet is never returned; it comes back inside `wins`, often as
//!   a pot of its own (`wins $1.87 USD from the side pot 1`);
//! - table chat is interleaved with the action.
//!
//! Everything from the pot reconstruction on is
//! [`build_hand`]. Patterns are the
//! TypeScript source verbatim (a test holds them to `partypoker.ts`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
};
use super::shared::p2_partygaming::{
    BANNER_REGEX, P888_STAKES_REGEX, PARTY_DATE_REGEX, PARTY_GAME_REGEX, banner_and_stakes,
    bracket_amount, dealing_board, is_chat_line, is_noise_line, iso_from_party_date, known_zone,
    split_bannered_hands, split_lines, unit_for,
};
use super::shared::variant_lock::{
    HOLDEM_OMAHA, OMAHA_HI_LO, canonical_game_label, unsupported_variant_skip,
};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::parse_amount_js;
use crate::phf::{
    DecimalStyle, LimitType, PhfHand, PhfWarning, PotHalf, Variant, is_hi_lo_label,
    variant_from_label,
};

/// `VERSION`.
pub const PARTYPOKER_PARSER_VERSION: &str = "1.0.0";

/// `PARTY_VARIANTS`: Hold'em and four-card Omaha (no `omaha5` sample).
const PARTY_VARIANTS: &[Variant] = HOLDEM_OMAHA;
/// `PARTY_HI_LO`: `PL Omaha Hi-Lo` (fixture 08).
const PARTY_HI_LO: &[Variant] = OMAHA_HI_LO;

static STREET_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?",
    "i"
);
static SEAT_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$", "");
static TABLE_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Table\s+(.+?)\s+\((Real|Play) Money\)\s*$", "i");
static BUTTON_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+)\s+is the button\s*$", "");
static SEAT_COUNT_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Total number of players\s*:\s*(\d+)(?:\/(\d+))?", "");
static BRANDED: LazyLock<Regex> = crate::js_regex_lazy!(r"\b(?:partypoker|party poker)\b", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt to\s+(.+?)\s*\[([^\]]*)\]\s*$", "");
static WINS: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+wins\s+([$€£]?[\d,]+(?:\.\d+)?)(?:\s+[A-Z]{3})?(?:\s+from the (main pot|side pot)(?:\s+\d+)?)?(?:\s+with\s+.+)?\.?\s*$",
    ""
);
static WINS_HALF: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+wins\s+(Hi|Lo)\s+\(([$€£]?[\d,]+(?:\.\d+)?)(?:\s+[A-Z]{3})?\)(?:\s+from the (main pot|side pot)(?:\s+\d+)?)?(?:\s+with\s+.+)?\.?\s*$",
    "i"
);
static LOW_SHOWN: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+shows\s*[A2-8](?:,[A2-8]){4}\s+for low\.?\s*$",
    "i"
);
static POSTED: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+posts\s+(small blind|big blind \+ dead|big blind|ante|dead blind)\s*\[([^\]]*)\]\.?\s*$",
    "i"
);
static SIMPLE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.+?)\s+(folds|checks)\s*$", "");
static WAGER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+(calls|bets|raises)\s*\[([^\]]*)\]\s*$", "");
static ALL_IN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+is all-In\s*\[([^\]]*)\]\s*$", "i");
static REVEALED: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+(shows|doesn't show)\s*\[([^\]]*)\]\s*(.*?)\.?\s*$",
    ""
);
static NO_SHOW: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.+?)\s+does not show cards\.?\s*$", "i");
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:PL|Pot Limit)$", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:FL|Fixed Limit|Limit)$", "i");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

/// `limitOf(limit)`: partypoker's limit token (`FL` matches none of the
/// shared `limitFromLabel` patterns).
fn limit_of(limit: &str) -> LimitType {
    if POT_LIMIT.is_match(limit) {
        return LimitType::Pl;
    }
    if FIXED_LIMIT.is_match(limit) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

/// `fallbackMaxSeats(seats)` (partypoker's and 888's copies are identical):
/// the next real table size at or above the highest seat (or the seat
/// count), else that number.
pub(crate) fn fallback_max_seats(seats: &[DraftSeat]) -> JsNumber {
    let count = u64::try_from(seats.len()).unwrap_or(u64::MAX);
    let highest = seats
        .iter()
        .fold(JsNumber::from_u64(count), |max, seat| max.max_of(seat.seat));
    [2_u64, 4, 6, 9, 10]
        .into_iter()
        .map(JsNumber::from_u64)
        .find(|size| {
            matches!(
                size.compare(highest),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            )
        })
        .unwrap_or(highest)
}

/// `line.replace(/^\uFEFF/, "").trim()`.
fn clean(line: &str) -> &str {
    js::trim(line.strip_prefix('\u{FEFF}').unwrap_or(line))
}

/// `Number(digits)`.
fn number(digits: &str) -> JsNumber {
    JsNumber::parse(digits)
}

/// `partypokerParser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let without_bom = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let lines = split_lines(without_bom);
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let banner_index = lines
        .iter()
        .position(|line| BANNER_REGEX.is_match(js::trim(line)));
    let Some((banner_index, banner)) =
        banner_index.and_then(|i| BANNER_REGEX.captures(js::trim(lines[i])).map(|c| (i, c)))
    else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk has no partypoker banner line.",
        ));
    };
    let hand_id = banner[2].to_owned();

    let stakes_line = banner_and_stakes(raw).map_or(String::new(), |head| head.stakes);
    let date = PARTY_DATE_REGEX.captures(&stakes_line);
    let game = date
        .as_ref()
        .and_then(|date| PARTY_GAME_REGEX.captures(date.get(1).map_or("", |m| m.as_str())));
    let (Some(date), Some(game)) = (date, game) else {
        return Err(skip(
            SkipReason::NoHeader,
            "The partypoker stakes line is missing or unreadable, so the game is unknown.",
        ));
    };
    let label = &game[7];
    // Hi/lo first, so a refused one keeps its own reason.
    if let Some(refusal) = unsupported_game_skip(label, PARTY_HI_LO)
        .or_else(|| unsupported_variant_skip(label, PARTY_VARIANTS))
    {
        return Err(refusal.into());
    }
    if !known_zone(&date[7]) {
        warnings.push(PhfWarning {
            code: "unknown-timezone".to_owned(),
            message: format!(
                "Timezone \"{}\" is not in the offset table; the hand is timed as UTC.",
                &date[7]
            ),
            line: None,
        });
    }
    let played_at = iso_from_party_date(
        &date[2], &date[3], &date[4], &date[5], &date[6], &date[7], &date[8],
    );
    let symbol = match game.get(1).map_or("", |m| m.as_str()) {
        "" => game.get(3).map_or("", |m| m.as_str()),
        symbol => symbol,
    };
    let unit = unit_for(symbol);

    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut seat_names: HashSet<String> = HashSet::new();
    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    let mut acted: HashSet<String> = HashSet::new();
    let mut table_name: Option<String> = None;
    let mut max_seats = JsNumber::ZERO;
    let mut button_seat: Option<JsNumber> = None;
    let mut street = DraftStreet::Preflop;
    let mut big_blind = JsNumber::ZERO;
    let mut hero_name: Option<String> = None;

    // `act(player, action)`: an action that makes its player dealt in.
    let act = |acted: &mut HashSet<String>, actions: &mut Vec<DraftAction>, action: DraftAction| {
        acted.insert(action.player.clone());
        actions.push(action);
    };

    for (i, raw_line) in lines.iter().enumerate().skip(banner_index + 1) {
        let line = clean(raw_line);
        let line_no = u32::try_from(i + 1).ok();
        if line.is_empty() || line == stakes_line {
            continue;
        }

        if let Some(count) = SEAT_COUNT_REGEX.captures(line) {
            max_seats = number(count.get(2).map_or(&count[1], |m| m.as_str()));
            continue;
        }
        if is_noise_line(line) {
            continue;
        }

        if let Some(table) = TABLE_REGEX.captures(line) {
            table_name = Some(js::trim(&table[1]).to_owned());
            continue;
        }

        if let Some(button) = BUTTON_REGEX.captures(line) {
            button_seat = Some(number(&button[1]));
            continue;
        }

        if let Some(seat) = SEAT_REGEX.captures(line) {
            let name = seat[2].to_owned();
            seats.push(DraftSeat {
                seat: number(&seat[1]),
                name: name.clone(),
                starting_stack: parse_amount_js(&seat[3], &unit),
                dealt_in: false,
                is_hero: false,
                dealt_cards: Vec::new(),
            });
            seat_names.insert(name);
            continue;
        }

        if let Some(marker) = STREET_REGEX.captures(line) {
            match js::to_lower_case(&marker[1]).as_str() {
                "flop" => street = DraftStreet::Flop,
                "turn" => street = DraftStreet::Turn,
                "river" => street = DraftStreet::River,
                _ => {}
            }
            continue;
        }

        if let Some(dealt) = DEALT.captures(line) {
            if let Some(player) = seats.iter_mut().find(|entry| entry.name == dealt[1]) {
                player.is_hero = true;
                player.dealt_cards = extract_cards(&dealt[2]);
                hero_name = Some(player.name.clone());
            }
            continue;
        }

        if let Some(wins) = WINS.captures(line)
            && seat_names.contains(&wins[1])
        {
            collected.push(DraftCollect {
                player: wins[1].to_owned(),
                amount: parse_amount_js(&wins[2], &unit),
                pot_name: Some(wins.get(3).map_or("pot", |m| m.as_str()).to_owned()),
                half: None,
            });
            continue;
        }

        // `wins Lo ($28.75 USD) from the main pot with 7,5,4,2,A.`
        if let Some(half) = WINS_HALF.captures(line)
            && seat_names.contains(&half[1])
        {
            collected.push(DraftCollect {
                player: half[1].to_owned(),
                amount: parse_amount_js(&half[3], &unit),
                pot_name: Some(half.get(4).map_or("pot", |m| m.as_str()).to_owned()),
                half: Some(if js::to_lower_case(&half[2]) == "lo" {
                    PotHalf::Lo
                } else {
                    PotHalf::Hi
                }),
            });
            continue;
        }

        // `fistfock123 shows7,5,4,2,A  for low.`: nothing of its own.
        if let Some(low) = LOW_SHOWN.captures(line)
            && seat_names.contains(&low[1])
        {
            continue;
        }

        if let Some(posted) = POSTED.captures(line)
            && seat_names.contains(&posted[1])
        {
            let player = &posted[1];
            let kind = js::to_lower_case(&posted[2]);
            let amount = bracket_amount(&posted[3], &unit);
            let mut action = DraftAction::new(street, player, DraftKind::Post);
            match kind.as_str() {
                "small blind" => {
                    action.kind = DraftKind::SmallBlind;
                    action.amount = Some(amount);
                }
                "big blind" => {
                    big_blind = big_blind.max_of(amount);
                    action.kind = DraftKind::BigBlind;
                    action.amount = Some(amount);
                }
                "ante" => {
                    action.kind = DraftKind::Ante;
                    action.amount = Some(amount);
                }
                _ => {
                    // `posts big blind + dead [$3]`: one big blind plus dead
                    // money nobody has to match.
                    let blind = if big_blind.is_nan() || big_blind.strict_equals(JsNumber::ZERO) {
                        amount
                    } else {
                        big_blind
                    };
                    let live = blind.min_of(amount);
                    action.amount = Some(live);
                    action.dead = Some(amount - live);
                }
            }
            act(&mut acted, &mut actions, action);
            continue;
        }

        if let Some(simple) = SIMPLE.captures(line)
            && seat_names.contains(&simple[1])
        {
            let kind = if &simple[2] == "folds" {
                DraftKind::Fold
            } else {
                DraftKind::Check
            };
            act(
                &mut acted,
                &mut actions,
                DraftAction::new(street, &simple[1], kind),
            );
            continue;
        }

        if let Some(wager) = WAGER.captures(line)
            && seat_names.contains(&wager[1])
        {
            let kind = match &wager[2] {
                "calls" => DraftKind::Call,
                "bets" => DraftKind::Bet,
                _ => DraftKind::Raise,
            };
            let mut action = DraftAction::new(street, &wager[1], kind);
            action.amount = Some(bracket_amount(&wager[3], &unit));
            act(&mut acted, &mut actions, action);
            continue;
        }

        if let Some(all_in) = ALL_IN.captures(line)
            && seat_names.contains(&all_in[1])
        {
            let mut action = DraftAction::new(street, &all_in[1], DraftKind::Allin);
            action.amount = Some(bracket_amount(&all_in[2], &unit));
            action.all_in = true;
            act(&mut acted, &mut actions, action);
            continue;
        }

        // `shows [ 8c, 8d ]three of a kind, Eights.`; `doesn't show` still
        // reveals the cards (an auto-mucked losing hand).
        if let Some(revealed) = REVEALED.captures(line)
            && seat_names.contains(&revealed[1])
        {
            let kind = if &revealed[2] == "shows" {
                DraftKind::Show
            } else {
                DraftKind::Muck
            };
            let mut action = DraftAction::new(street, &revealed[1], kind);
            action.cards = Some(extract_cards(&revealed[3]));
            let description = &revealed[4];
            action.description = (!description.is_empty()).then(|| description.to_owned());
            actions.push(action);
            continue;
        }

        if let Some(no_show) = NO_SHOW.captures(line)
            && seat_names.contains(&no_show[1])
        {
            let mut action = DraftAction::new(street, &no_show[1], DraftKind::Muck);
            action.cards = Some(Vec::new());
            actions.push(action);
            continue;
        }

        if is_chat_line(line, &seat_names) {
            continue;
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
            "No `wins` line, so the hand text was cut off before it was settled.",
        ));
    }

    for seat in &mut seats {
        seat.dealt_in = acted.contains(&seat.name) || hero_name.as_deref() == Some(&seat.name);
    }
    for entry in &collected {
        // The big blind of a walk never acts but is dealt in.
        if let Some(seat) = seats.iter_mut().find(|seat| seat.name == entry.player) {
            seat.dealt_in = true;
        }
    }

    let flop = dealing_board(raw, "flop");
    let first =
        |street: &str| dealing_board(raw, street).and_then(|cards| cards.into_iter().next());
    let header_blinds = game.get(4).is_some_and(|m| !m.as_str().is_empty());
    let max_seats = if max_seats.is_nan() || max_seats.strict_equals(JsNumber::ZERO) {
        fallback_max_seats(&seats)
    } else {
        max_seats
    };
    let flop_size = flop.as_ref().map(Vec::len);
    let draft = HandDraft {
        site_id: "partypoker".to_owned(),
        site_name: "partypoker".to_owned(),
        parser_id: "partypoker".to_owned(),
        parser_version: PARTYPOKER_PARSER_VERSION.to_owned(),
        hand_prefix: "PTY-".to_owned(),
        hand_id,
        game_label: canonical_game_label(
            variant_from_label(label),
            limit_of(&game[6]),
            is_hi_lo_label(label),
        ),
        decimals: DecimalStyle::Fixed2,
        header_small_blind: if header_blinds {
            parse_amount_js(&game[2], &unit)
        } else {
            JsNumber::ZERO
        },
        header_big_blind: if header_blinds {
            parse_amount_js(&game[4], &unit)
        } else {
            JsNumber::ZERO
        },
        unit,
        table_name,
        max_seats,
        button_seat,
        played_at,
        seats,
        actions,
        flop,
        turn: first("turn"),
        river: first("river"),
        collected,
        // The uncalled bet stays in the pot and comes back inside `wins`.
        collected_includes_uncalled: true,
        raw_text: js::trim(without_bom).to_owned(),
        warnings,
    };

    if let Some(size) = flop_size
        && size != 3
    {
        return Err(skip(
            SkipReason::BoardSize,
            format!("The flop line lists {size} cards, so the hand is corrupt."),
        ));
    }

    build_hand(&draft, ctx)
}

/// `partypokerParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PartyPokerParser;

impl SiteParser for PartyPokerParser {
    fn id(&self) -> &'static str {
        "partypoker"
    }

    fn name(&self) -> &'static str {
        "partypoker"
    }

    fn version(&self) -> &'static str {
        PARTYPOKER_PARSER_VERSION
    }

    fn hi_lo_variants(&self) -> &'static [Variant] {
        PARTY_HI_LO
    }

    /// 0 when the stakes line is 888's or not partypoker's; 0.95 with the
    /// brand in the banner, 0.9 without.
    fn detect(&self, text: &str) -> u32 {
        let Some(head) = banner_and_stakes(text) else {
            return 0;
        };
        if P888_STAKES_REGEX.is_match(&head.stakes) || !PARTY_DATE_REGEX.is_match(&head.stakes) {
            return 0;
        }
        if BRANDED.is_match(&head.banner) {
            950
        } else {
            900
        }
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_bannered_hands(text))
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_hand(raw, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../web/src/lib/parsers/partypoker.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?/i",
            r"/^Seat\s+(\d+):\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$/",
            r"/^Table\s+(.+?)\s+\((Real|Play) Money\)\s*$/i",
            r"/^Seat\s+(\d+)\s+is the button\s*$/",
            r"/^Total number of players\s*:\s*(\d+)(?:\/(\d+))?/",
            r"/\b(?:partypoker|party poker)\b/i",
            r"/^Dealt to\s+(.+?)\s*\[([^\]]*)\]\s*$/",
            r"/^(.+?)\s+wins\s+([$€£]?[\d,]+(?:\.\d+)?)(?:\s+[A-Z]{3})?(?:\s+from the (main pot|side pot)(?:\s+\d+)?)?(?:\s+with\s+.+)?\.?\s*$/",
            r"/^(.+?)\s+wins\s+(Hi|Lo)\s+\(([$€£]?[\d,]+(?:\.\d+)?)(?:\s+[A-Z]{3})?\)(?:\s+from the (main pot|side pot)(?:\s+\d+)?)?(?:\s+with\s+.+)?\.?\s*$/i",
            r"/^(.+?)\s+shows\s*[A2-8](?:,[A2-8]){4}\s+for low\.?\s*$/i",
            r"/^(.+?)\s+posts\s+(small blind|big blind \+ dead|big blind|ante|dead blind)\s*\[([^\]]*)\]\.?\s*$/i",
            r"/^(.+?)\s+(folds|checks)\s*$/",
            r"/^(.+?)\s+(calls|bets|raises)\s*\[([^\]]*)\]\s*$/",
            r"/^(.+?)\s+is all-In\s*\[([^\]]*)\]\s*$/i",
            r"/^(.+?)\s+(shows|doesn't show)\s*\[([^\]]*)\]\s*(.*?)\.?\s*$/",
            r"/^(.+?)\s+does not show cards\.?\s*$/i",
            r"/^(?:PL|Pot Limit)$/i",
            r"/^(?:FL|Fixed Limit|Limit)$/i",
            r"/^\uFEFF/",
            r"/\r?\n/",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
        assert!(source.contains(&format!(
            "new RegExp(String.raw`{}`, \"im\")",
            super::super::shared::p2_partygaming::BOARD_TEMPLATE
        )));
        assert!(source.contains("const VERSION = \"1.0.0\";"));
        assert!(source.contains("[2, 4, 6, 9, 10]"));
    }

    #[test]
    fn limit_tokens() {
        assert_eq!(limit_of("PL"), LimitType::Pl);
        assert_eq!(limit_of("pot limit"), LimitType::Pl);
        assert_eq!(limit_of("FL"), LimitType::Fl);
        assert_eq!(limit_of("Limit"), LimitType::Fl);
        assert_eq!(limit_of("NL"), LimitType::Nl);
        assert_eq!(limit_of("No Limit"), LimitType::Nl);
    }
}
