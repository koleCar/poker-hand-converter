//! `ipoker`: the iPoker network (`frontend/src/lib/parsers/ipoker.ts`) -
//! Betfair, Titan, Paddy Power, Betclic, Red Star, NetBet and the other
//! skins, which all export the same XML.
//!
//! A file is one or more `<session>` documents, each a shared `<general>`
//! block and any number of `<game>` elements. The split re-emits every game
//! as a session of its own (`<session sessioncode="..">` + the session's
//! `<general>` + the game), so that is the chunk - and `meta.rawText` -
//! rather than a slice of the file. In a game:
//!
//! - `no` on an `<action>` is the running order; document order is not (a
//!   round lists its actions grouped by player). They are sorted by
//!   `Number(no)` exactly as V8 sorts ([`js::sort`]), a `NaN` included.
//! - action types are numbers; `sum` is an increment except for `23` (the
//!   street total). An unknown code that moves chips refuses the hand.
//! - cards are suit first (`D5`, `H10`, `c10`); `X` is a card not shown.
//! - nothing states the seat count, the hero, the pot, the rake or an
//!   uncalled bet; [`build_hand`] derives the last three, and `win` has the
//!   uncalled bet still in it.
//!
//! The XML reader is [`parse_xml`] (the TypeScript's Node path). The action
//! and round tables are object literals, so a `type` or `no` naming a member
//! of `Object.prototype` (`toString`, `__proto__`) finds that member - an
//! inert action ([`DraftKind::Unmatched`]) or a street the builder has no
//! lines for ([`DraftStreet::Unlisted`]) - as in the TypeScript.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft, build_hand,
    object_prototype_member,
};
use super::shared::p2_xml::{
    XmlElement, child, child_text, children, parse_xml, unrepresentable_outcome,
};
use super::shared::variant_lock::{
    HOLDEM_OMAHA, canonical_game_label, unsupported_variant_skip, variant_of,
};
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::{EUR, GBP, USD, parse_amount_js, unit_for_symbol};
use crate::phf::serialize::{date_utc, to_iso_string};
use crate::phf::{CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant};

/// `VERSION`.
pub const IPOKER_PARSER_VERSION: &str = "1.0.0";

/// `IPOKER_VARIANTS`: Hold'em and four-card Omaha.
const IPOKER_VARIANTS: &[Variant] = HOLDEM_OMAHA;

static SESSION: LazyLock<Regex> = crate::js_regex_lazy!(r"<session\b", "i");
static GAMETYPE_TAG: LazyLock<Regex> = crate::js_regex_lazy!(r"<gametype>", "i");
static ROUND_NO: LazyLock<Regex> = crate::js_regex_lazy!(r"<round\b[^>]*no=", "i");
static ACTION_TYPE: LazyLock<Regex> = crate::js_regex_lazy!(r"<action\b[^>]*\btype=", "i");
static SESSION_CODE: LazyLock<Regex> =
    crate::js_regex_lazy!(r#"<session\b[^>]*sessioncode="([^"]*)""#, "i");
static GAME_OPEN: LazyLock<Regex> = crate::js_regex_lazy!(r"<game\b", "i");
static GENERAL: LazyLock<Regex> = crate::js_regex_lazy!(r"<general>[\s\S]*?<\/general>", "i");
static GAME: LazyLock<Regex> = crate::js_regex_lazy!(r"<game\b[\s\S]*?<\/game>", "gi");
static GAMETYPE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(\S+)\s+(NL|PL|FL|L)\s+(.*)$", "i");
static SYMBOL: LazyLock<Regex> = crate::js_regex_lazy!(r"[$€£]", "");
static CARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^([shdcSHDC])(10|[2-9tjqkaTJQKA])$", "");
static DATE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})", "");
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^PL$", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:FL|L)$", "i");
static HEADS_UP: LazyLock<Regex> = crate::js_regex_lazy!(r"heads\s*-?\s*up", "i");
static TABLE_SUFFIX: LazyLock<Regex> = crate::js_regex_lazy!(r",\s*\d+\s*$", "");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

fn warning(code: &str, message: String) -> PhfWarning {
    PhfWarning {
        code: code.to_owned(),
        message,
        line: None,
    }
}

/// `text.split(/(?=X)/)` for a pattern `X` whose matches cannot overlap: a
/// cut before every match that does not start at 0. (`""` splits into
/// `[""]`.)
pub(crate) fn split_before<'a>(text: &'a str, pattern: &Regex) -> Vec<&'a str> {
    let mut pieces = Vec::new();
    let mut last = 0;
    for found in pattern.find_iter(text) {
        if found.start() > last {
            pieces.push(&text[last..found.start()]);
            last = found.start();
        }
    }
    pieces.push(&text[last..]);
    pieces
}

/// `` `${value}` `` of an attribute that may be `undefined`.
pub(crate) fn template(value: Option<&str>) -> &str {
    value.unwrap_or("undefined")
}

/// `Number(value ?? 0)`.
pub(crate) fn number_or_zero(value: Option<&str>) -> JsNumber {
    value.map_or(JsNumber::ZERO, JsNumber::parse)
}

/// `!n` of a number: `0`, `-0` and `NaN` are falsy.
pub(crate) fn falsy(value: JsNumber) -> bool {
    value.is_nan() || value.strict_equals(JsNumber::ZERO)
}

/// `ROUND_STREETS[no]`: `0` is the blind round, `1` the deal.
fn round_street(no: &str) -> Option<DraftStreet> {
    match no {
        "0" | "1" => Some(DraftStreet::Preflop),
        "2" => Some(DraftStreet::Flop),
        "3" => Some(DraftStreet::Turn),
        "4" => Some(DraftStreet::River),
        other => object_prototype_member(other).map(DraftStreet::Unlisted),
    }
}

/// `ACTION_TYPES[code]`, checked against the corpus' `bet` and `win`
/// totals.
fn action_kind(code: &str) -> Option<DraftKind> {
    match code {
        "0" => Some(DraftKind::Fold),
        "1" => Some(DraftKind::SmallBlind),
        "2" => Some(DraftKind::BigBlind),
        "3" => Some(DraftKind::Call),
        "4" => Some(DraftKind::Check),
        "5" => Some(DraftKind::Bet),
        "7" => Some(DraftKind::Allin),
        "15" => Some(DraftKind::Ante),
        "23" => Some(DraftKind::Raise),
        other => object_prototype_member(other).map(|_| DraftKind::Unmatched),
    }
}

/// `ipokerCard(token)`: `D5` -> `5d`, `H10` -> `Th`, `c10` -> `Tc`; `None`
/// for `X` (not shown) and anything else.
fn ipoker_card(token: &str) -> Option<String> {
    let captures = CARD.captures(js::trim(token))?;
    let rank = js::to_upper_case(&captures[2]);
    Some(format!(
        "{}{}",
        if rank == "10" { "T" } else { &rank },
        js::to_lower_case(&captures[1])
    ))
}

/// `unitOf(players, tableCurrency)`: the first symbol on a player's
/// `chips` wins over `<tablecurrency>` (which real files contradict).
fn unit_of(players: &[&XmlElement], table_currency: &str) -> CurrencyUnit {
    for player in players {
        if let Some(symbol) = SYMBOL.find(player.attr("chips").unwrap_or("")) {
            return unit_for_symbol(symbol.as_str()).unit();
        }
    }
    match js::to_upper_case(table_currency).as_str() {
        "EUR" => EUR.unit(),
        "GBP" => GBP.unit(),
        _ => USD.unit(),
    }
}

/// The `Date.UTC(...)` of a `YYYY-MM-DD[ T]H:MM:SS` stamp as ISO, `None` when
/// there is none or it is out of range (iPoker's and MicroGaming's
/// identical `isoFrom...Date`; server time, no zone).
pub(crate) fn iso_from_xml_date(value: &str) -> Option<String> {
    let captures = DATE.captures(value)?;
    let field = |i: usize| JsNumber::parse(&captures[i]).to_i64();
    date_utc(
        field(1)?,
        field(2)? - 1,
        field(3)?,
        field(4)?,
        field(5)?,
        field(6)?,
    )
    .map(to_iso_string)
}

/// `limitOf(limit)`.
pub(crate) fn limit_of(limit: &str) -> LimitType {
    if POT_LIMIT.is_match(limit) {
        return LimitType::Pl;
    }
    if FIXED_LIMIT.is_match(limit) {
        LimitType::Fl
    } else {
        LimitType::Nl
    }
}

/// `Math.max(seats.length, ...seats.map((seat) => seat.seat))`.
pub(crate) fn highest_seat(seats: &[DraftSeat]) -> JsNumber {
    let count = u64::try_from(seats.len()).unwrap_or(u64::MAX);
    seats
        .iter()
        .fold(JsNumber::from_u64(count), |max, seat| max.max_of(seat.seat))
}

/// `sizes.find((size) => size >= highest) ?? highest`.
pub(crate) fn next_table_size(sizes: &[u64], highest: JsNumber) -> JsNumber {
    sizes
        .iter()
        .map(|size| JsNumber::from_u64(*size))
        .find(|size| {
            matches!(
                size.compare(highest),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            )
        })
        .unwrap_or(highest)
}

/// `maxSeatsFor(tableName, seats)`: 2 on a heads-up table, else the next
/// real table size at or above the highest seat.
fn max_seats_for(table_name: &str, seats: &[DraftSeat]) -> JsNumber {
    if HEADS_UP.is_match(table_name) {
        return JsNumber::from_u64(2);
    }
    next_table_size(&[6, 9, 10], highest_seat(seats))
}

/// `resolveHero(nickname, pocket, seats)`: the export's `<nickname>` when it
/// is seated, else the one seated player whose cards are known.
fn resolve_hero(
    nickname: &str,
    pocket: &[(String, Vec<String>)],
    seat_by_name: &HashMap<String, usize>,
) -> Option<String> {
    if !nickname.is_empty() && nickname != "N/A" && seat_by_name.contains_key(nickname) {
        return Some(nickname.to_owned());
    }
    let known: Vec<&String> = pocket
        .iter()
        .map(|(name, _)| name)
        .filter(|name| seat_by_name.contains_key(name.as_str()))
        .collect();
    match known.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// A `Map.set` on an insertion-ordered list.
fn set_entry<T>(map: &mut Vec<(String, T)>, key: &str, value: T) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

struct Ordered<'a> {
    order: JsNumber,
    street: DraftStreet,
    node: &'a XmlElement,
}

/// `ipokerParser.parseHand`.
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let document = parse_xml(raw);
    let outcome = read_hand(raw, document.root.as_ref(), ctx);
    unrepresentable_outcome(document.lone_surrogates, raw, outcome)
}

/// `parseHand` from the parsed document on.
#[allow(clippy::too_many_lines)]
fn read_hand(
    raw: &str,
    root: Option<&XmlElement>,
    ctx: &SiteParserContext<'_>,
) -> Result<PhfHand, ParseError> {
    let Some(root) = root.filter(|root| js::to_lower_case(&root.tag) == "session") else {
        return Err(skip(
            SkipReason::MalformedXml,
            "The chunk is not a well-formed iPoker session.",
        ));
    };
    let session_general = child(Some(root), "general");
    let Some(game) = child(Some(root), "game") else {
        return Err(skip(
            SkipReason::NoHands,
            "The session contains no <game> element.",
        ));
    };
    let hand_id = game.attr("gamecode").unwrap_or("");
    if hand_id.is_empty() {
        return Err(skip(
            SkipReason::NoHeader,
            "The <game> element has no gamecode.",
        ));
    }

    let game_type = child_text(session_general, "gametype");
    let Some(parsed_type) = GAMETYPE.captures(game_type) else {
        return Err(skip(
            SkipReason::NoHeader,
            format!("Unreadable <gametype> \"{game_type}\"."),
        ));
    };
    let label = &parsed_type[1];
    if let Some(refusal) = unsupported_game_skip(label, &[])
        .or_else(|| unsupported_variant_skip(label, IPOKER_VARIANTS))
    {
        return Err(refusal.into());
    }

    let game_general = child(Some(game), "general");
    let player_nodes = children(child(game_general, "players"), "player");
    if player_nodes.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The <players> block is empty."));
    }

    let unit = unit_of(&player_nodes, child_text(session_general, "tablecurrency"));
    let mut warnings: Vec<PhfWarning> = Vec::new();

    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut stacks: HashMap<String, JsNumber> = HashMap::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    let mut button_seat: Option<JsNumber> = None;
    for node in &player_nodes {
        let name = node.attr("name").unwrap_or("");
        let seat = number_or_zero(node.attr("seat"));
        if name.is_empty() || falsy(seat) {
            return Err(skip(
                SkipReason::NoPlayers,
                "A <player> element has no name or no seat.",
            ));
        }
        let stack = parse_amount_js(node.attr("chips").unwrap_or(""), &unit);
        seats.push(DraftSeat {
            seat,
            name: name.to_owned(),
            starting_stack: stack,
            dealt_in: false,
            is_hero: false,
            dealt_cards: Vec::new(),
        });
        stacks.insert(name.to_owned(), stack);
        if node.attr("dealer") == Some("1") {
            button_seat = Some(seat);
        }
        let win = parse_amount_js(node.attr("win").unwrap_or(""), &unit);
        if win.greater_than(JsNumber::ZERO) {
            collected.push(DraftCollect {
                player: name.to_owned(),
                amount: win,
                pot_name: None,
                half: None,
            });
        }
    }
    // `new Map(seats.map(...))`: a repeated name maps to its last seat.
    let seat_by_name: HashMap<String, usize> = seats
        .iter()
        .enumerate()
        .map(|(i, seat)| (seat.name.clone(), i))
        .collect();

    /* ------------------------------------------------------------ rounds */

    let mut pocket: Vec<(String, Vec<String>)> = Vec::new();
    let mut dealt: HashSet<String> = HashSet::new();
    let mut folded: HashSet<String> = HashSet::new();
    let mut ordered: Vec<Ordered<'_>> = Vec::new();
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut last_street = DraftStreet::Preflop;

    for round in children(Some(game), "round") {
        let no = round.attr("no");
        let Some(street) = round_street(no.unwrap_or("")) else {
            return Err(skip(
                SkipReason::UnknownRound,
                format!("Unknown <round no=\"{}\">.", template(no)),
            ));
        };
        for card in children(Some(round), "cards") {
            let kind = js::to_lower_case(card.attr("type").unwrap_or(""));
            let known: Vec<String> = card
                .text
                .split(js::is_whitespace)
                .filter(|token| !token.is_empty())
                .filter_map(ipoker_card)
                .collect();
            if kind == "pocket" {
                let owner = card.attr("player").unwrap_or("");
                dealt.insert(owner.to_owned());
                if !known.is_empty() {
                    set_entry(&mut pocket, owner, known);
                }
                continue;
            }
            match kind.as_str() {
                "flop" => {
                    flop = Some(known);
                    last_street = DraftStreet::Flop;
                }
                "turn" => {
                    turn = known.into_iter().next();
                    last_street = DraftStreet::Turn;
                }
                "river" => {
                    river = known.into_iter().next();
                    last_street = DraftStreet::River;
                }
                _ => warnings.push(warning(
                    "unknown-line",
                    format!("<cards type=\"{}\">", template(card.attr("type"))),
                )),
            }
        }
        for action in children(Some(round), "action") {
            ordered.push(Ordered {
                order: number_or_zero(action.attr("no")),
                street,
                node: action,
            });
        }
    }
    js::sort::sort_by(&mut ordered, |a, b| a.order - b.order);

    let mut actions: Vec<DraftAction> = Vec::new();
    let mut street_commit: HashMap<String, JsNumber> = HashMap::new();
    let mut hand_commit: HashMap<String, JsNumber> = HashMap::new();
    for entry in &ordered {
        let player = entry.node.attr("player").unwrap_or("");
        let code = entry.node.attr("type").unwrap_or("");
        let sum = parse_amount_js(entry.node.attr("sum").unwrap_or(""), &unit);
        if !seat_by_name.contains_key(player) {
            // An action for a seat iPoker never listed cannot be
            // reconstructed, and inventing the seat would move the ring.
            return Err(skip(
                SkipReason::UnseatedActor,
                format!("\"{player}\" acts but is not in <players>."),
            ));
        }
        let Some(kind) = action_kind(code) else {
            if !sum.strict_equals(JsNumber::ZERO) {
                return Err(skip(
                    SkipReason::UnknownActionType,
                    format!(
                        "Action type \"{code}\" moves {} and is not in the code table.",
                        sum.to_js_string()
                    ),
                ));
            }
            // A zero-sum code changes no pot maths (type 8 for a seat never
            // dealt in): dropped, without dealing the seat in.
            continue;
        };

        dealt.insert(player.to_owned());
        if kind == DraftKind::Fold {
            folded.insert(player.to_owned());
            actions.push(DraftAction::new(entry.street, player, kind));
            continue;
        }
        if kind == DraftKind::Check {
            actions.push(DraftAction::new(entry.street, player, kind));
            continue;
        }

        // `23` states the street total, every other code an increment; both
        // tracked only to tell which action put a player all in.
        let to_total = code == "23";
        let key = format!("{} {player}", entry.street.as_str());
        let previous_street = street_commit.get(&key).copied().unwrap_or(JsNumber::ZERO);
        let added = if to_total {
            JsNumber::ZERO.max_of(sum - previous_street)
        } else {
            sum
        };
        street_commit.insert(key, previous_street + added);
        let total = hand_commit.get(player).copied().unwrap_or(JsNumber::ZERO) + added;
        hand_commit.insert(player.to_owned(), total);
        let stack = stacks
            .get(player)
            .copied()
            .unwrap_or(JsNumber::Infinite { negative: false });
        let mut action = DraftAction::new(entry.street, player, kind);
        action.amount = Some(sum);
        action.to_total = to_total;
        action.all_in = matches!(
            total.compare(stack),
            Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
        );
        actions.push(action);
    }

    /* ---------------------------------------------------------- showdown */

    for (player, cards) in &pocket {
        if !seat_by_name.contains_key(player) {
            continue;
        }
        // A revealed hand that folded is a muck.
        let kind = if folded.contains(player) {
            DraftKind::Muck
        } else {
            DraftKind::Show
        };
        let mut action = DraftAction::new(last_street, player, kind);
        action.cards = Some(cards.clone());
        actions.push(action);
    }

    let nickname = child_text(session_general, "nickname");
    let hero = resolve_hero(nickname, &pocket, &seat_by_name);
    for seat in &mut seats {
        seat.dealt_in = dealt.contains(&seat.name);
        if hero.as_deref() == Some(seat.name.as_str()) {
            seat.is_hero = true;
            seat.dealt_cards = pocket
                .iter()
                .find(|(name, _)| *name == seat.name)
                .map(|(_, cards)| cards.clone())
                .unwrap_or_default();
            seat.dealt_in = true;
        }
    }
    for entry in &collected {
        if let Some(&index) = seat_by_name.get(&entry.player) {
            seats[index].dealt_in = true;
        }
    }

    let table_name = child_text(session_general, "tablename");
    let stakes: Vec<&str> = parsed_type[3].split('/').collect();
    let trimmed_table = TABLE_SUFFIX.replace(table_name, "");
    let flop_size = flop.as_ref().map(Vec::len);
    let draft = HandDraft {
        site_id: "ipoker".to_owned(),
        site_name: "iPoker Network".to_owned(),
        parser_id: "ipoker".to_owned(),
        parser_version: IPOKER_PARSER_VERSION.to_owned(),
        hand_prefix: "IPN-".to_owned(),
        hand_id: hand_id.to_owned(),
        game_label: canonical_game_label(variant_of(label), limit_of(&parsed_type[2]), false),
        decimals: DecimalStyle::Fixed2,
        // On a fixed-limit table these are the small and big *bet*: only a
        // fallback for what was posted.
        header_small_blind: parse_amount_js(stakes[0], &unit),
        header_big_blind: parse_amount_js(stakes.get(1).copied().unwrap_or(stakes[0]), &unit),
        unit,
        table_name: (!trimmed_table.is_empty()).then(|| trimmed_table.into_owned()),
        max_seats: max_seats_for(table_name, &seats),
        button_seat,
        played_at: iso_from_xml_date(child_text(game_general, "startdate")),
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        // iPoker never returns an uncalled bet; it comes back inside `win`.
        collected_includes_uncalled: true,
        raw_text: js::trim(raw).to_owned(),
        warnings,
    };

    if let Some(size) = flop_size
        && size != 3
    {
        return Err(skip(
            SkipReason::BoardSize,
            format!("The flop lists {size} readable cards, so the hand is corrupt."),
        ));
    }

    build_hand(&draft, ctx)
}

/// `ipokerParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct IPokerParser;

impl SiteParser for IPokerParser {
    fn id(&self) -> &'static str {
        "ipoker"
    }

    fn name(&self) -> &'static str {
        "iPoker Network"
    }

    fn version(&self) -> &'static str {
        IPOKER_PARSER_VERSION
    }

    /// 0 without `<session` and `<gametype>`; 0.95 with the round/action
    /// shape of a hand history, else 0.4.
    fn detect(&self, text: &str) -> u32 {
        if !SESSION.is_match(text) || !GAMETYPE_TAG.is_match(text) {
            return 0;
        }
        if ROUND_NO.is_match(text) && ACTION_TYPE.is_match(text) {
            return 950;
        }
        400
    }

    /// Every `<game>` of every `<session>`, re-emitted as a session of its
    /// own with the session's code and first `<general>` block.
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        let mut out = Vec::new();
        for session in split_before(text, &SESSION) {
            if !SESSION.is_match(session) {
                continue;
            }
            let code = SESSION_CODE
                .captures(session)
                .and_then(|captures| captures.get(1))
                .map_or("0", |m| m.as_str());
            // The session `<general>` is the one before any `<game>`.
            let head = GAME_OPEN
                .find(session)
                .map_or(session, |found| &session[..found.start()]);
            let general = GENERAL
                .find(head)
                .map_or("<general></general>", |m| m.as_str());
            for game in GAME.find_iter(session) {
                out.push(format!(
                    "<session sessioncode=\"{code}\">\n{general}\n{}\n</session>",
                    game.as_str()
                ));
            }
        }
        Ok(out)
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_hand(raw, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/ipoker.ts");

    #[test]
    fn patterns_and_messages_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/<session\b/i",
            r"/<gametype>/i",
            r"/<round\b[^>]*no=/i",
            r"/<action\b[^>]*\btype=/i",
            r"/(?=<session\b)/i",
            r#"/<session\b[^>]*sessioncode="([^"]*)"/i"#,
            r"/<game\b/i",
            r"/<general>[\s\S]*?<\/general>/i",
            r"/<game\b[\s\S]*?<\/game>/gi",
            r"/^(\S+)\s+(NL|PL|FL|L)\s+(.*)$/i",
            r"/\s+/",
            r"/[$€£]/",
            r"/^([shdcSHDC])(10|[2-9tjqkaTJQKA])$/",
            r"/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/",
            r"/^PL$/i",
            r"/^(?:FL|L)$/i",
            r"/heads\s*-?\s*up/i",
            r"/,\s*\d+\s*$/",
            "`<session sessioncode=\"${code}\">\\n${general}\\n${game}\\n</session>`",
            "\"The chunk is not a well-formed iPoker session.\"",
            "\"The session contains no <game> element.\"",
            "\"The <game> element has no gamecode.\"",
            "`Unreadable <gametype> \"${gameType}\".`",
            "\"The <players> block is empty.\"",
            "\"A <player> element has no name or no seat.\"",
            "`Unknown <round no=\"${round.attrs.no}\">.`",
            "`<cards type=\"${card.attrs.type}\">`",
            "`\"${player}\" acts but is not in <players>.`",
            "`Action type \"${code}\" moves ${sum} and is not in the code table.`,",
            "`The flop lists ${flop.length} readable cards, so the hand is corrupt.`,",
            "[6, 9, 10]",
            "const VERSION = \"1.0.0\";",
            "handPrefix: \"IPN-\",",
            "\"23\": \"raise\",",
            "\"15\": \"ante\",",
            "\"7\": \"allin\",",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    #[test]
    fn cards_are_suit_first() {
        assert_eq!(ipoker_card("D5").as_deref(), Some("5d"));
        assert_eq!(ipoker_card("H10").as_deref(), Some("Th"));
        assert_eq!(ipoker_card("c10").as_deref(), Some("Tc"));
        assert_eq!(ipoker_card("sa").as_deref(), Some("As"));
        assert_eq!(ipoker_card("X"), None);
        assert_eq!(ipoker_card("D1"), None);
    }

    #[test]
    fn lookups_reach_object_prototype() {
        assert_eq!(action_kind("toString"), Some(DraftKind::Unmatched));
        assert_eq!(action_kind("8"), None);
        assert_eq!(
            round_street("__proto__"),
            Some(DraftStreet::Unlisted("[object Object]"))
        );
        assert_eq!(round_street("5"), None);
    }

    #[test]
    fn splits_before_every_session() {
        let pieces = split_before("a<session>b<SESSION x>c", &SESSION);
        assert_eq!(pieces, ["a", "<session>b", "<SESSION x>c"]);
        assert_eq!(split_before("<session>", &SESSION), ["<session>"]);
        assert_eq!(split_before("", &SESSION), [""]);
        assert_eq!(split_before("<sessions>", &SESSION), ["<sessions>"]);
    }
}
