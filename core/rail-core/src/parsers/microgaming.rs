//! `microgaming`: the MicroGaming Poker Network
//! (`frontend/src/lib/parsers/microgaming.ts`) - Betsafe, Ladbrokes,
//! Unibet's pre-2019 rooms and the other skins, shut down in 2016.
//!
//! One `<Game>` element per hand, everything in attributes, read with
//! [`parse_xml`]:
//!
//! - every `value` is an increment, `Raise` included;
//! - names carry their own lossless copy: `unicodealias` is Base64 of the
//!   UTF-16LE name and wins over `alias`; `currencysymbol` is the only place
//!   the currency is stated, encoded the same way;
//! - `MoneyReturned` is the uncalled bet, read only to cross-check the one
//!   [`build_hand`] derives (and to tell whether `Win` still holds it);
//! - `BadBeatContribution` is a jackpot drop: a chip movement off the table
//!   (`toPot: false`), added to the built hand;
//! - `Disconnect`'s `value` is milliseconds, not money.
//!
//! The street table is an object literal, so an `<Action type>` naming a
//! member of `Object.prototype` (`toString`) reads as a deal and leaves a
//! street the builder has no lines for ([`DraftStreet::Unlisted`]), as in
//! the TypeScript.

use std::sync::LazyLock;

use regex::Regex;

use super::ipoker::{
    falsy, highest_seat, iso_from_xml_date, limit_of, next_table_size, number_or_zero,
    split_before, template,
};
use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
    object_prototype_member,
};
use super::shared::p2_xml::{XmlElement, child, children, parse_xml, unrepresentable_outcome};
use super::shared::p4_textroom::{decode_base64_utf16_lossy, strict_amount};
use super::shared::variant_lock::{
    HOLDEM_OMAHA, OMAHA_HI_LO, canonical_game_label, normalize_game_name, unsupported_variant_skip,
    variant_of,
};
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::{parse_amount, parse_amount_js, unit_for_symbol};
use crate::phf::{
    ChipMovementAnchor, CurrencyUnit, DecimalStyle, PhfChipMovement, PhfHand, PhfWarning, Variant,
    is_hi_lo_label,
};

/// `VERSION`.
pub const MICROGAMING_PARSER_VERSION: &str = "1.0.0";

/// `MICROGAMING_VARIANTS`: Hold'em and four-card Omaha.
const MICROGAMING_VARIANTS: &[Variant] = HOLDEM_OMAHA;
/// `MICROGAMING_HI_LO`: `Omaha H/L` (two fixtures, both split).
const MICROGAMING_HI_LO: &[Variant] = OMAHA_HI_LO;

static DETECT: LazyLock<Regex> =
    crate::js_regex_lazy!(r#"<Game\s+hhversion="\d+"\s+id="\d+""#, "i");
static GAME_OPEN: LazyLock<Regex> = crate::js_regex_lazy!(r"<Game\s+hhversion=", "i");
static CHUNK: LazyLock<Regex> = crate::js_regex_lazy!(r"^<Game\s+hhversion=", "i");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

/// `WAGERS[type]`: the `<Action type>`s that move chips into the pot.
fn wager(kind: &str) -> Option<DraftKind> {
    Some(match kind {
        "SmallBlind" => DraftKind::SmallBlind,
        "BigBlind" => DraftKind::BigBlind,
        "Ante" => DraftKind::Ante,
        "Call" => DraftKind::Call,
        "Bet" => DraftKind::Bet,
        "Raise" => DraftKind::Raise,
        "AllIn" => DraftKind::Allin,
        _ => return None,
    })
}

/// `STREETS[type]`, `Object.prototype` included.
fn deal_street(kind: &str) -> Option<DraftStreet> {
    match kind {
        "DealFlop" => Some(DraftStreet::Flop),
        "DealTurn" => Some(DraftStreet::Turn),
        "DealRiver" => Some(DraftStreet::River),
        other => object_prototype_member(other).map(DraftStreet::Unlisted),
    }
}

/// `cardOf(node)`: `<Card value="10" suit="c"/>` -> `Tc`.
fn card_of(node: &XmlElement) -> String {
    let value = js::to_upper_case(node.attr("value").unwrap_or(""));
    let suit = js::to_lower_case(node.attr("suit").unwrap_or(""));
    format!("{}{suit}", if value == "10" { "T" } else { &value })
}

/// `fallbackMaxSeats(seats)`: `tablesize` is missing or zero.
fn fallback_max_seats(seats: &[DraftSeat]) -> JsNumber {
    next_table_size(&[2, 6, 9, 10], highest_seat(seats))
}

/// `bySeat`: a `Map<number, DraftSeat>` (SameValueZero keys; a repeated
/// number maps to its last seat), as indices into `seats`.
#[derive(Default)]
struct BySeat(Vec<(JsNumber, usize)>);

impl BySeat {
    fn set(&mut self, number: JsNumber, index: usize) {
        if let Some(entry) = self.0.iter_mut().find(|(n, _)| n.strict_equals(number)) {
            entry.1 = index;
        } else {
            self.0.push((number, index));
        }
    }

    fn get(&self, number: JsNumber) -> Option<usize> {
        self.0
            .iter()
            .find(|(n, _)| n.strict_equals(number))
            .map(|(_, index)| *index)
    }
}

/// `{ player, amount }` of a `MoneyReturned`.
struct StatedReturn {
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

/// `microgamingParser.parseHand`.
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let source = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    let document = parse_xml(source);
    let mut lone = document.lone_surrogates;
    let outcome = read_hand(source, document.root.as_ref(), ctx, &mut lone);
    unrepresentable_outcome(lone, source, outcome)
}

/// `parseHand` from the parsed document on; `lone` is raised when a Base64
/// name decodes to a lone surrogate (U+FFFD stands in for it).
#[allow(clippy::too_many_lines)]
fn read_hand(
    source: &str,
    game: Option<&XmlElement>,
    ctx: &SiteParserContext<'_>,
    lone: &mut bool,
) -> Result<PhfHand, ParseError> {
    let Some(game) = game.filter(|game| js::to_lower_case(&game.tag) == "game") else {
        return Err(skip(
            SkipReason::MalformedXml,
            "The chunk is not a well-formed <Game> element.",
        ));
    };
    let mut decode = |value: Option<&str>| {
        let (text, unpaired) = decode_base64_utf16_lossy(value.unwrap_or(""));
        *lone |= unpaired;
        text
    };

    let hand_id = game.attr("id").unwrap_or("");
    if hand_id.is_empty() {
        return Err(skip(SkipReason::NoHeader, "The <Game> element has no id."));
    }
    let game_type = game.attr("gametype").unwrap_or("");
    // `Omaha H/L` first, so a refused one keeps the split pot as its reason.
    if let Some(refusal) = unsupported_game_skip(game_type, MICROGAMING_HI_LO)
        .or_else(|| unsupported_variant_skip(game_type, MICROGAMING_VARIANTS))
    {
        return Err(refusal.into());
    }
    if game.attr("istournament") == Some("1") {
        return Err(skip(
            SkipReason::TournamentUnsupported,
            "MicroGaming tournament hands are not covered yet; the buy-in is not stated in \
             the hand, so a tournament could only be recorded with an invented one.",
        ));
    }
    if game.attr("realmoney") == Some("false") {
        return Err(skip(
            SkipReason::PlayMoney,
            "The table is play money, not real money.",
        ));
    }

    let mut warnings: Vec<PhfWarning> = Vec::new();
    // The symbol lives only in `currencysymbol`. One that decodes to a lone
    // surrogate is a symbol no unit has: chips, as in the TypeScript.
    let (symbol, _) = decode_base64_utf16_lossy(game.attr("currencysymbol").unwrap_or(""));
    if symbol.is_empty() {
        warnings.push(warning(
            "unknown-currency",
            "The hand states no decodable currency symbol; amounts are read as USD.".to_owned(),
        ));
    }
    let unit: CurrencyUnit = if symbol.is_empty() {
        unit_for_symbol("$").unit()
    } else {
        unit_for_symbol(&symbol).unit()
    };

    let stakes: Vec<&str> = game.attr("stakes").unwrap_or("").split('|').collect();

    /* ------------------------------------------------------------- seats */

    let seat_nodes = children(child(Some(game), "Seats"), "Seat");
    if seat_nodes.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The <Seats> block is empty."));
    }
    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut by_seat = BySeat::default();
    let mut button_seat: Option<JsNumber> = None;
    for node in &seat_nodes {
        let num = number_or_zero(node.attr("num"));
        let decoded = decode(node.attr("unicodealias"));
        let name = if decoded.is_empty() {
            node.attr("alias").unwrap_or("").to_owned()
        } else {
            decoded
        };
        if falsy(num) || name.is_empty() {
            return Err(skip(
                SkipReason::NoPlayers,
                "A <Seat> element has no number or no alias.",
            ));
        }
        let starting_stack = strict_amount(
            node.attr("balance").unwrap_or(""),
            &unit,
            "a <Seat> balance",
        )?;
        by_seat.set(num, seats.len());
        seats.push(DraftSeat {
            seat: num,
            name,
            starting_stack,
            // A seat sitting out was not dealt in; anybody else is confirmed
            // below by having acted.
            dealt_in: false,
            is_hero: false,
            dealt_cards: Vec::new(),
        });
        if node.attr("dealer") == Some("true") {
            button_seat = Some(num);
        }
    }

    /* ----------------------------------------------------------- actions */

    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    let mut street = DraftStreet::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut stated_return: Option<StatedReturn> = None;
    let mut chip_movements: Vec<(JsNumber, String, i64)> = Vec::new();

    let gameplay = child(Some(game), "Gameplay");
    for node in children(gameplay, "Action") {
        let kind = node.attr("type").unwrap_or("");

        if kind == "Win" {
            for winner in children(Some(node), "Seat") {
                let Some(index) = by_seat.get(number_or_zero(winner.attr("num"))) else {
                    return Err(skip(
                        SkipReason::UnseatedActor,
                        format!(
                            "A <Win> names seat {}, which is not in <Seats>.",
                            template(winner.attr("num"))
                        ),
                    ));
                };
                seats[index].dealt_in = true;
                collected.push(DraftCollect {
                    player: seats[index].name.clone(),
                    amount: strict_amount(
                        winner.attr("amount").unwrap_or(""),
                        &unit,
                        "a <Win> amount",
                    )?,
                    pot_name: None,
                    half: None,
                });
            }
            continue;
        }

        if let Some(dealt) = deal_street(kind) {
            let cards: Vec<String> = children(Some(node), "Card")
                .into_iter()
                .map(card_of)
                .collect();
            street = dealt;
            match dealt {
                DraftStreet::Flop => flop = Some(cards),
                DraftStreet::Turn => turn = cards.into_iter().next(),
                _ => river = cards.into_iter().next(),
            }
            continue;
        }

        let Some(index) = by_seat.get(number_or_zero(node.attr("seat"))) else {
            if kind == "BadBeatContribution" || kind == "Disconnect" {
                continue;
            }
            return Err(skip(
                SkipReason::UnseatedActor,
                format!(
                    "Action {} ({kind}) names seat {}, which is not in <Seats>.",
                    node.attr("seq").unwrap_or("?"),
                    template(node.attr("seat"))
                ),
            ));
        };
        seats[index].dealt_in = true;
        let player = seats[index].name.clone();

        if let Some(wager) = wager(kind) {
            let mut action = DraftAction::new(street, &player, wager);
            action.amount = Some(parse_amount_js(node.attr("value").unwrap_or(""), &unit));
            action.all_in = kind == "AllIn";
            actions.push(action);
            continue;
        }
        match kind {
            "Fold" => actions.push(DraftAction::new(street, &player, DraftKind::Fold)),
            "Check" => actions.push(DraftAction::new(street, &player, DraftKind::Check)),
            "ShowCards" | "MuckCards" => {
                let reveal = if kind == "ShowCards" {
                    DraftKind::Show
                } else {
                    DraftKind::Muck
                };
                let mut action = DraftAction::new(street, &player, reveal);
                action.cards = Some(
                    children(Some(node), "Card")
                        .into_iter()
                        .map(card_of)
                        .collect(),
                );
                actions.push(action);
            }
            "MoneyReturned" => {
                // For the cross-check only; the builder derives the return.
                stated_return = Some(StatedReturn {
                    player,
                    amount: strict_amount(
                        node.attr("value").unwrap_or(""),
                        &unit,
                        "a MoneyReturned value",
                    )?,
                });
            }
            "BadBeatContribution" => {
                // A jackpot drop: off the stack, never into the pot.
                chip_movements.push((
                    seats[index].seat,
                    player,
                    parse_amount(node.attr("value").unwrap_or(""), &unit),
                ));
            }
            // A timeout in milliseconds, not chips.
            "Disconnect" => {}
            _ => warnings.push(warning("unknown-line", format!("<Action type=\"{kind}\">"))),
        }
    }

    if collected.is_empty() {
        return Err(skip(
            SkipReason::NoWinner,
            "No <Action type=\"Win\"> element, so the source never says who was given the pot.",
        ));
    }
    if let Some(cards) = &flop
        && cards.len() != 3
    {
        return Err(skip(
            SkipReason::BoardSize,
            format!(
                "The DealFlop action lists {} readable cards, so the hand is corrupt.",
                cards.len()
            ),
        ));
    }

    // The object literal's order: the stakes are read (and may refuse)
    // before the table name is decoded.
    let header_small_blind = strict_amount(stakes[0], &unit, "the header stakes")?;
    let header_big_blind = strict_amount(
        stakes.get(1).copied().unwrap_or(stakes[0]),
        &unit,
        "the header stakes",
    )?;
    let decoded_table = decode(game.attr("unicodetablename"));
    let table_name = if decoded_table.is_empty() {
        game.attr("tablename").map(str::to_owned)
    } else {
        Some(decoded_table)
    };
    let size = number_or_zero(game.attr("tablesize"));
    let max_seats = if falsy(size) {
        fallback_max_seats(&seats)
    } else {
        size
    };
    let draft = HandDraft {
        site_id: "microgaming".to_owned(),
        site_name: "MicroGaming Network".to_owned(),
        parser_id: "microgaming".to_owned(),
        parser_version: MICROGAMING_PARSER_VERSION.to_owned(),
        hand_prefix: "MG-".to_owned(),
        hand_id: hand_id.to_owned(),
        game_label: canonical_game_label(
            variant_of(game_type),
            limit_of(game.attr("betlimit").unwrap_or("NL")),
            is_hi_lo_label(&normalize_game_name(game_type)),
        ),
        unit,
        decimals: DecimalStyle::Fixed2,
        header_small_blind,
        header_big_blind,
        table_name,
        max_seats,
        button_seat,
        played_at: iso_from_xml_date(game.attr("date").unwrap_or("")),
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        // `MoneyReturned` only follows an all-in, and then the money is
        // already out of `Win`; a bet simply folded to comes back inside it.
        collected_includes_uncalled: stated_return.is_none(),
        raw_text: source.to_owned(),
        warnings,
    };

    let mut hand = build_hand(&draft, ctx)?;
    if !chip_movements.is_empty() {
        // After the build: the drop never touches the pot.
        let mut movements = hand.chip_movements.take().unwrap_or_default();
        for (seat, player, amount) in chip_movements {
            let Some(from_seat) = seat.to_i64().and_then(|n| u32::try_from(n).ok()) else {
                return Err(ParseError::Bug(
                    crate::parsers::shared::ps_gg_hand::unrepresentable("a chip movement's seat")
                        .message,
                ));
            };
            movements.push(PhfChipMovement {
                kind: "bad-beat-drop".to_owned(),
                from_seat: Some(from_seat),
                from_player: Some(player),
                to_pot: false,
                amount,
                // `toStandardText` writes `raw` verbatim and the grammar has
                // no seat-to-house line: the drop lives in the PHF only.
                raw: None,
                // MicroGaming drops it before the blinds are posted.
                anchor: ChipMovementAnchor::BeforePostings,
            });
        }
        hand.chip_movements = Some(movements);
    }
    cross_check(&mut hand, stated_return.as_ref());
    Ok(hand)
}

/// `crossCheck(hand, statedReturn)`: a warning only where the derived
/// uncalled return and the stated `MoneyReturned` disagree.
fn cross_check(hand: &mut PhfHand, stated: Option<&StatedReturn>) {
    let Some(stated) = stated else {
        return;
    };
    let derived = hand
        .actions
        .iter()
        .find(|action| action.kind == crate::phf::ActionType::Uncalled)
        .map(|action| (action.player.clone(), JsNumber::from_i64(action.amount)));
    let message = match derived {
        None => Some(format!(
            "The hand returns {} to {} but the betting stream leaves nothing uncalled.",
            stated.amount.to_js_string(),
            stated.player
        )),
        Some((player, amount)) => {
            let returned = -amount;
            let off = (returned - stated.amount)
                .abs()
                .greater_than(JsNumber::from_i64(1));
            (player != stated.player || off).then(|| {
                format!(
                    "The hand returns {} to {}; the stream returns {} to {player}.",
                    stated.amount.to_js_string(),
                    stated.player,
                    returned.to_js_string()
                )
            })
        }
    };
    if let Some(message) = message {
        hand.meta
            .warnings
            .push(warning("uncalled-mismatch", message));
    }
}

/// `microgamingParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct MicroGamingParser;

impl SiteParser for MicroGamingParser {
    fn id(&self) -> &'static str {
        "microgaming"
    }

    fn name(&self) -> &'static str {
        "MicroGaming Network"
    }

    fn version(&self) -> &'static str {
        MICROGAMING_PARSER_VERSION
    }

    fn hi_lo_variants(&self) -> &'static [Variant] {
        MICROGAMING_HI_LO
    }

    /// 0.95 for `<Game hhversion="N" id="N"`, which nothing else writes.
    fn detect(&self, text: &str) -> u32 {
        if DETECT.is_match(text) { 950 } else { 0 }
    }

    /// One chunk per `<Game hhversion=`, a BOM and the edges trimmed.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before(text, &GAME_OPEN)
            .into_iter()
            .map(|chunk| js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk)))
            .filter(|chunk| CHUNK.is_match(chunk))
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

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/microgaming.ts");

    #[test]
    fn patterns_and_messages_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r#"/<Game\s+hhversion="\d+"\s+id="\d+"/i"#,
            r"/(?=<Game\s+hhversion=)/i",
            r"/^<Game\s+hhversion=/i",
            r"/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/",
            r"/^PL$/i",
            r"/^(?:FL|L)$/i",
            "\"The chunk is not a well-formed <Game> element.\"",
            "\"The <Game> element has no id.\"",
            "\"MicroGaming tournament hands are not covered yet; the buy-in is not stated \" +",
            "\"in the hand, so a tournament could only be recorded with an invented one.\",",
            "\"The table is play money, not real money.\"",
            "\"The hand states no decodable currency symbol; amounts are read as USD.\",",
            "\"The <Seats> block is empty.\"",
            "\"A <Seat> element has no number or no alias.\"",
            "`A <Win> names seat ${winner.attrs.num}, which is not in <Seats>.`,",
            "`Action ${node.attrs.seq ?? \"?\"} (${type}) names seat ${node.attrs.seat}, ` +",
            "\"which is not in <Seats>.\",",
            "`<Action type=\"${type}\">`",
            "'No <Action type=\"Win\"> element, so the source never says who was given the pot.',",
            "`The DealFlop action lists ${flop.length} readable cards, so the hand is corrupt.`,",
            "`The hand returns ${statedReturn.amount} to ${statedReturn.player} but the betting ` +",
            "\"stream leaves nothing uncalled.\",",
            "`The hand returns ${statedReturn.amount} to ${statedReturn.player}; the stream ` +",
            "`returns ${-derived.amount} to ${derived.player}.`,",
            "Math.abs(-derived.amount - statedReturn.amount) > 1",
            "[2, 6, 9, 10]",
            "const VERSION = \"1.0.0\";",
            "handPrefix: \"MG-\",",
            "\"a <Seat> balance\"",
            "\"a <Win> amount\"",
            "\"a MoneyReturned value\"",
            "\"the header stakes\"",
            "kind: \"bad-beat-drop\",",
            "anchor: \"before-postings\",",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    #[test]
    fn cards_and_tables() {
        let card = XmlElement {
            tag: "Card".to_owned(),
            attrs: vec![
                ("value".to_owned(), "10".to_owned()),
                ("suit".to_owned(), "C".to_owned()),
            ],
            children: Vec::new(),
            text: String::new(),
        };
        assert_eq!(card_of(&card), "Tc");
        assert_eq!(wager("AllIn"), Some(DraftKind::Allin));
        assert_eq!(wager("toString"), None);
        assert_eq!(
            deal_street("valueOf"),
            Some(DraftStreet::Unlisted(
                "function valueOf() { [native code] }"
            ))
        );
        assert_eq!(deal_street("Fold"), None);
    }

    #[test]
    fn splits_on_every_game_element() {
        let chunks = MicroGamingParser
            .split_hands("\u{FEFF}<Game hhversion=\"4\" id=\"1\"/>\n  <game  HHVERSION=\"4\"/> x<Gamehhversion=")
            .expect("split");
        assert_eq!(
            chunks,
            [
                "<Game hhversion=\"4\" id=\"1\"/>",
                "<game  HHVERSION=\"4\"/> x<Gamehhversion="
            ]
        );
    }
}
