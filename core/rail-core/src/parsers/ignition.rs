//! `ignition`: Ignition / Bodog / Bovada, the PaiWangLuo network
//! (`frontend/src/lib/parsers/ignition.ts`, R0.10b).
//!
//! **There are no player names.** Every seat is printed as its position
//! relative to the button (`Dealer`, `Small Blind`, `UTG+2`, ...) and the hero
//! carries `[ME]`; those pseudonyms are stored as the player names, the hero
//! renamed `Hero`. The button is the seat called `Dealer` (`Set dealer [n]` is
//! trusted only when it names a seat). The rest:
//!
//! - `Showdown [...]` is a best five, never hole cards; `Draw for dealer`
//!   cards are dropped;
//! - `Raises X` is a street total, `Raises X to Y` an increment and a total;
//! - a lone `Ante chip` is a live post (`lone-ante-posted-live`);
//! - the 2021 Zone Poker export writes an empty summary (`derived-pot`);
//! - the 2012 exports print no street markers: the streets are rebuilt from
//!   betting closure, checked against the board (`streets-inferred`,
//!   `missing-street-markers`);
//! - four-card Omaha Hi/Lo is read, its `HI` / `LOW` summary totals checked
//!   against the cards once built.
//!
//! Patterns are the TypeScript source verbatim (a test holds them to
//! `ignition.ts`); the brand-built header patterns are written out, the
//! `m`-flag probes and the lookahead split run at every JavaScript line
//! start.

use std::cmp::Ordering;
use std::sync::LazyLock;

use regex::Regex;

use super::shared::p2_partygaming::{iso_from_888_date, split_lines};
use super::shared::p5_handdraft::{
    P5Action, P5Collect, P5Draft, P5Kind, P5Seat, P5Street, P5Tournament, p5_build_hand,
};
use super::shared::ps_gg_hand::split_before_line_starts;
use super::shared::variant_lock::{
    HOLDEM_OMAHA, OMAHA_HI_LO, canonical_game_label, unsupported_variant_skip, variant_of,
};
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::game::hole_card_count;
use crate::phf::hilo::{StatedTotals, check_stated_totals};
use crate::phf::money::{CHIPS, parse_amount_js, unit_for_symbol};
use crate::phf::serialize::matches_at_line_start;
use crate::phf::{DecimalStyle, LimitType, PhfHand, PhfWarning, Variant, is_hi_lo_label};

/// `VERSION`.
pub const IGNITION_PARSER_VERSION: &str = "1.0.0";

/// `IGNITION_VARIANTS`: Hold'em and four-card Omaha.
const IGNITION_VARIANTS: &[Variant] = HOLDEM_OMAHA;
/// `IGNITION_HI_LO`: four-card `OMAHA HiLo`.
const IGNITION_HI_LO: &[Variant] = OMAHA_HI_LO;

const SITE_ID: &str = "ignition";
const SITE_NAME: &str = "Ignition / Bodog / Bovada";

/// `BRANDS`, every brand string, longest alternative first.
const BRANDS: &str = r"Ignition|Bovada|Bodog\.com|Bodog\.eu|Bodog UK|Bodog Canada|Bodog88|Bodog";

/// `HEADER_RE`: `` new RegExp(String.raw`^(?:${BRANDS})\s+Hand\s+#(\S+?):?\s+(.*)$`) ``.
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    js::regex::js_regex(&format!(r"^(?:{BRANDS})\s+Hand\s+#(\S+?):?\s+(.*)$"), "")
});
/// `SPLIT_RE` without its lookahead, and the detection probe: `^(?:${BRANDS})\s+Hand\s+#`.
static BRAND_HAND: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"^(?:{BRANDS})\s+Hand\s+#"), ""));
/// `ANY_HEADER_RE`: `(?:${BRANDS})\s+Hand\s+#\d`, anywhere.
static ANY_HEADER: LazyLock<Regex> =
    LazyLock::new(|| js::regex::js_regex(&format!(r"(?:{BRANDS})\s+Hand\s+#\d"), ""));

static DATE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+UTC)?\s*$",
    ""
);
static NOISE_VERB: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Leave\(Auto\)|Enter\(Auto\)|Table enter user|Table leave user|Table deposit\b|Seat sit out|Seat sit down|Seat re-join|Seat stand|Sit out|Sitout \(wait for bb\)|Re-join|Stand|Ranking\b|Prize Cash\b|Rebuyin\b|BOUNTY PRIZE\b|Draw for dealer\b)",
    "i"
);
static NOISE_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Enter\(Auto\)|Table enter user|Table leave user|Table deposit\b|Seat sit out|Seat sit down|Seat re-join|Seat stand|Seating Info:)",
    "i"
);
static GAME: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(HOLDEM|OMAHA|7CARD|NCARD)(ZonePoker)?(\s+HiLo)?(ZonePoker)?\b",
    ""
);
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"\bPot Limit\b", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"\bFixed Limit\b", "i");
static DATE_DASH: LazyLock<Regex> = crate::js_regex_lazy!(r"\s*-\s*$", "");
static MVS_SPACED: LazyLock<Regex> = crate::js_regex_lazy!(r"\s*\[MVS\]\s*", "");
static TOURNAMENT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(.+?)\s+Tournament\s+#(\S+)\s+TBL#([^,]+),\s*(.*?)\s*-\s*Level\s+(\S+)\s*\(([^)]*)\)$",
    ""
);
static SPEED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"\b(?:No|Pot|Fixed)\s+Limit\b", "i");
static CASH: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:Zone Poker ID#(\S+)|TBL#(\S+))\s+(.*)$", "");
static CARD: LazyLock<Regex> = crate::js_regex_lazy!(r"\b(?:10|[2-9TJQKA])[cdhs]\b", "g");
static BRACKET: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");

static DETECT_SPOT: LazyLock<Regex> = crate::js_regex_lazy!(r"^.* : Card dealt to a spot \[", "");
static DETECT_DEALER: LazyLock<Regex> =
    crate::js_regex_lazy!(r": Set dealer(?:\/Bring in spot)? \[", "");

static HOLE_CARDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*HOLE CARDS", "i");
static SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*SUMMARY", "i");
static ANTE_POSTER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(.*?)\s*(?:\[ME\])?\s*:\s*Ante chip\b", "");
static TOTAL_POT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Total Pot\(([^)]*)\)(?:\s*\|\s*Rake\s*\(([^)]*)\))?", "i");
static SUMMARY_BOARD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Board\s*\[", "i");
static SUMMARY_SEAT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat\s*\+?\s*\d+\s*:", "");
static MARKER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*(.*)$", "i");
static TABLE_CARDS: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Card (?:dealt to|to the) table\s*\[([^\]]*)\]", "i");
static SEAT: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Seat\s+(\d+):\s+(.+?)\s*(\[ME\])?\s*\((.+?)\s+in chips\)$",
    ""
);
static TABLE_INFO: LazyLock<Regex> = crate::js_regex_lazy!(r"^Table Info:", "i");
static STAKES: LazyLock<Regex> =
    crate::js_regex_lazy!(r"Stakes:\s*\$?([\d.,]+)\s*-\s*\$?([\d.,]+)", "i");
static PLAYER_INFO: LazyLock<Regex> = crate::js_regex_lazy!(r"^Player Info:", "i");
static PLAYER_HASH: LazyLock<Regex> = crate::js_regex_lazy!(r"P(\d+)-([0-9a-f]{32})", "g");
static ACTOR: LazyLock<Regex> = crate::js_regex_lazy!(r"^(.*?)\s*(\[ME\])?\s*:\s*(.*)$", "");
static SET_DEALER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Set dealer(?:\/Bring in spot)?\s*\[(\d+)\]", "i");
static DEALT: LazyLock<Regex> = crate::js_regex_lazy!(r"^Card dealt to a spot\s*\[([^\]]*)\]", "i");
static BLIND: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Ante\/)?(Small [Bb]lind|Big [Bb]lind(?:\/Bring in)?)\s+\$?([\d,.]+)$",
    ""
);
static SMALL: LazyLock<Regex> = crate::js_regex_lazy!(r"^Small", "i");
static ANTE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Ante chip\s+\$?([\d,.]+)$", "i");
static POST: LazyLock<Regex> = crate::js_regex_lazy!(r"^Posts (dead )?chip\s+\$?([\d,.]+)$", "i");
static FOLDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^Folds?\b", "i");
static CHECKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^Checks\b", "i");
static CALL: LazyLock<Regex> = crate::js_regex_lazy!(r"^Calls?\s+\$?([\d,.]+)$", "i");
static BET: LazyLock<Regex> = crate::js_regex_lazy!(r"^Bets?\s+\$?([\d,.]+)$", "i");
static RAISE_TO: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Raises|All-in\(raise[^)]*\))(?:\(timeout\))?\s+\$?([\d,.]+)\s+to\s+\$?([\d,.]+)$",
    "i"
);
static RAISE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Raises|All-in\(raise[^)]*\))(?:\(timeout\))?\s+\$?([\d,.]+)$",
    "i"
);
static ALL_IN_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"All-in", "i");
static ALL_IN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^All-in(?:\([^)]*\))?\s+\$?([\d,.]+)$", "i");
static UNCALLED: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Return uncalled portion of bet\s+\$?([\d,.]+)$", "i");
static SHOWDOWN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Showdown\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))?$", "i");
static REVEAL: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(Does not show|Mucks|Shows)\s*\[([^\]]*)\]\s*(?:\(([^)]*)\))?$",
    "i"
);
static SHOWS_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Shows$", "i");
static MUCKS_WORD: LazyLock<Regex> = crate::js_regex_lazy!(r"^Mucks$", "i");
static RESULT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Hand [Rr]esult(-Side [Pp]ot)?\s+\$?([\d,.]+)$", "");
static SUMMARY_PREFIX: LazyLock<Regex> = crate::js_regex_lazy!(r"^Seat\s*\+?\s*\d+\s*:\s*", "");
static STATED_HI: LazyLock<Regex> = crate::js_regex_lazy!(r"\bHI\s+([\d,.]+)", "");
static STATED_LO: LazyLock<Regex> = crate::js_regex_lazy!(r"\bLOW\s+([\d,.]+)", "");
static BUY_IN: LazyLock<Regex> = crate::js_regex_lazy!(r"^Table Info:.*\bBuyin:\s*([^,]+)", "i");

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

/// `Map.set` on a vector of pairs (insertion order, the value replaced).
fn set_entry<V>(map: &mut Vec<(String, V)>, key: &str, value: V) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

fn get_entry<'m, V>(map: &'m [(String, V)], key: &str) -> Option<&'m V> {
    map.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// A JavaScript number's truthiness (`0`, `-0` and `NaN` are falsy).
fn truthy(value: JsNumber) -> bool {
    !value.is_nan() && !value.strict_equals(JsNumber::ZERO)
}

/// `name.length` as a JavaScript number (UTF-16 code units).
fn utf16_length(name: &str) -> JsNumber {
    JsNumber::from_u64(u64::try_from(js::utf16_len(name)).unwrap_or(u64::MAX))
}

fn count(n: usize) -> JsNumber {
    JsNumber::from_u64(u64::try_from(n).unwrap_or(u64::MAX))
}

/* ------------------------------------------------------------------ header */

/// `IgnitionHeader`, the fields the parser reads (`limitStated`,
/// `zonePoker` and `mvs` are computed by the TypeScript and never read).
#[derive(Debug, Clone)]
struct IgnitionHeader {
    hand_id: String,
    /// The room's own game token, `HOLDEM`, `OMAHA HiLo`, `7CARD` ...
    variant_label: String,
    /// The same game in the prose the shared label readers understand.
    game_name: String,
    limit: &'static str,
    table_id: Option<String>,
    tournament_id: Option<String>,
    /// `Turbo`, `Normal`, ... - the speed word glued to the level clause.
    speed: Option<String>,
    level_label: Option<String>,
    level_small_blind: JsNumber,
    level_big_blind: JsNumber,
    played_at: Option<String>,
}

/// `parseGameToken(token)`: `{ gameName, label }` (`zone` is not read).
fn parse_game_token(token: &str) -> (String, String) {
    let Some(game) = GAME.captures(token) else {
        return (token.to_owned(), token.to_owned());
    };
    let name = match &game[1] {
        "HOLDEM" => "Hold'em",
        "OMAHA" => "Omaha",
        "7CARD" => "7 Card Stud",
        other => other,
    };
    let hi_lo = game.get(3).is_some_and(|m| !m.as_str().is_empty());
    (
        format!("{name}{}", if hi_lo { " Hi/Lo" } else { "" }),
        game[0].to_owned(),
    )
}

/// `parseLimit(text).limit`.
fn parse_limit(text: &str) -> &'static str {
    if POT_LIMIT.is_match(text) {
        "Pot Limit"
    } else if FIXED_LIMIT.is_match(text) {
        "Fixed Limit"
    } else {
        // `No Limit`, stated or not: a tournament prints its speed word there.
        "No Limit"
    }
}

/// `limitTypeOf(limit)`.
fn limit_type_of(limit: &str) -> LimitType {
    match limit {
        "Pot Limit" => LimitType::Pl,
        "Fixed Limit" => LimitType::Fl,
        _ => LimitType::Nl,
    }
}

/// `parseHeaderLine(line)`.
fn parse_header_line(line: &str) -> Result<Option<IgnitionHeader>, ParseError> {
    let Some(header) = HEADER.captures(line) else {
        return Ok(None);
    };
    let hand_id = header[1].to_owned();
    let mut rest = js::trim(&header[2]).to_owned();

    let mut played_at = None;
    if let Some(date) = DATE.captures(&rest) {
        played_at = Some(
            iso_from_888_date(&date[3], &date[2], &date[1], &date[4], &date[5], &date[6])
                .ok_or_else(|| ParseError::Bug("Invalid time value".to_owned()))?,
        );
        let start = date.get(0).map_or(0, |m| m.start());
        let before = DATE_DASH.replace(&rest[..start], "").into_owned();
        rest = js::trim(&before).to_owned();
    }
    let spaced = MVS_SPACED.replace(&rest, " ").into_owned();
    let rest = js::trim(&spaced);

    if let Some(tournament) = TOURNAMENT.captures(rest) {
        let (game_name, label) = parse_game_token(&tournament[1]);
        let stakes: Vec<&str> = tournament[6].split('/').collect();
        let speed = SPEED_LIMIT.replace(&tournament[4], "");
        let speed = js::trim(&speed);
        return Ok(Some(IgnitionHeader {
            hand_id,
            variant_label: label,
            game_name,
            limit: parse_limit(&tournament[4]),
            table_id: Some(js::trim(&tournament[3]).to_owned()),
            tournament_id: Some(tournament[2].to_owned()),
            speed: Some(speed.to_owned()).filter(|speed| !speed.is_empty()),
            level_label: Some(tournament[5].to_owned()),
            level_small_blind: parse_amount_js(stakes[0], &CHIPS.unit()),
            level_big_blind: parse_amount_js(
                stakes.get(1).copied().unwrap_or(stakes[0]),
                &CHIPS.unit(),
            ),
            played_at,
        }));
    }

    // Cash: `TBL#10916521 HOLDEM No Limit` or `Zone Poker ID#1232 HOLDEMZonePoker No Limit`.
    let Some(cash) = CASH.captures(rest) else {
        return Ok(None);
    };
    let (game_name, label) = parse_game_token(js::trim(&cash[3]));
    Ok(Some(IgnitionHeader {
        hand_id,
        variant_label: label,
        game_name,
        limit: parse_limit(&cash[3]),
        table_id: match (cash.get(1), cash.get(2)) {
            (Some(zone), _) => Some(format!("Zone Poker {}", zone.as_str())),
            (None, Some(table)) => Some(table.as_str().to_owned()),
            (None, None) => None,
        },
        tournament_id: None,
        speed: None,
        level_label: None,
        level_small_blind: JsNumber::ZERO,
        level_big_blind: JsNumber::ZERO,
        played_at,
    }))
}

/* ------------------------------------------------------------------- cards */

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

/* ---------------------------------------------------------- street closure */

/// `ClosureSeat`.
#[derive(Debug, Clone, Copy)]
struct ClosureSeat {
    remaining: JsNumber,
    live: bool,
}

/// `isBetting(kind)`.
const fn is_betting(kind: P5Kind) -> bool {
    matches!(
        kind,
        P5Kind::Fold | P5Kind::Check | P5Kind::Call | P5Kind::Bet | P5Kind::Raise | P5Kind::Allin
    )
}

/// `splitIntoRounds(actions, seats)`: the betting round of every action,
/// rebuilt from closure (a round ends when every live player has acted since
/// the last aggression and everyone still in matches the bet).
fn split_into_rounds(actions: &[P5Action], seats: &[P5Seat]) -> Vec<usize> {
    let mut state: Vec<(String, ClosureSeat)> = Vec::new();
    for seat in seats {
        set_entry(
            &mut state,
            &seat.name,
            ClosureSeat {
                remaining: seat.starting_stack,
                live: true,
            },
        );
    }

    let mut rounds = Vec::with_capacity(actions.len());
    let mut round = 0;
    let mut commit: Vec<(String, JsNumber)> = Vec::new();
    let mut bet = JsNumber::ZERO;
    let mut acted: Vec<String> = Vec::new();
    let mut closed = false;

    for action in actions {
        if closed && is_betting(action.kind) {
            round += 1;
            commit.clear();
            bet = JsNumber::ZERO;
            acted.clear();
            // `closed = false`: `evaluate()` below sets it again.
        }
        rounds.push(round);

        let player = action.player.as_str();
        let already = get_entry(&commit, player)
            .copied()
            .unwrap_or(JsNumber::ZERO);
        let stated = action.amount.unwrap_or(JsNumber::ZERO);
        let live = if action.to_total {
            JsNumber::ZERO.max_of(stated - already)
        } else {
            stated
        };
        let entry = state
            .iter_mut()
            .find(|(name, _)| name == player)
            .map(|(_, entry)| entry);

        match action.kind {
            P5Kind::Fold => {
                if let Some(entry) = entry {
                    entry.live = false;
                }
            }
            P5Kind::Check => {
                if !acted.iter().any(|name| name == player) {
                    acted.push(player.to_owned());
                }
            }
            P5Kind::Ante => {
                if let Some(entry) = entry {
                    entry.remaining = entry.remaining - live;
                }
            }
            P5Kind::Uncalled => {
                set_entry(&mut commit, player, already - stated);
                if let Some(entry) = entry {
                    entry.remaining = entry.remaining + stated;
                }
            }
            _ => {
                let next = already + live;
                set_entry(&mut commit, player, next);
                if let Some(entry) = entry {
                    entry.remaining =
                        entry.remaining - (live + action.dead.unwrap_or(JsNumber::ZERO));
                }
                if next.greater_than(bet) {
                    bet = next;
                    // A raise re-opens the round; a blind raises the bet but
                    // is not the poster's turn.
                    acted.clear();
                }
                // Blind and dead posts are money, not a turn to act.
                if is_betting(action.kind) && !acted.iter().any(|name| name == player) {
                    acted.push(player.to_owned());
                }
            }
        }

        // `evaluate()`.
        let live_seats: Vec<&(String, ClosureSeat)> =
            state.iter().filter(|(_, entry)| entry.live).collect();
        closed = live_seats.len() <= 1
            || live_seats.iter().all(|(name, entry)| {
                matches!(
                    entry.remaining.compare(JsNumber::ZERO),
                    Some(Ordering::Less | Ordering::Equal)
                ) || (acted.iter().any(|a| a == name)
                    && matches!(
                        get_entry(&commit, name)
                            .copied()
                            .unwrap_or(JsNumber::ZERO)
                            .compare(bet),
                        Some(Ordering::Greater | Ordering::Equal)
                    ))
            });
    }
    rounds
}

/* ------------------------------------------------------------------ parser */

/// `mvsBuyIn(lines)`: `Table Info: ..., Buyin: $25+$2.50, ...` -> `$25+$2.50`.
fn mvs_buy_in(lines: &[&str]) -> Option<String> {
    lines.iter().find_map(|line| {
        BUY_IN.captures(line).map(|buy_in| {
            js::trim(&buy_in[1])
                .chars()
                .filter(|c| !js::is_whitespace(*c))
                .collect()
        })
    })
}

/// `ignitionParser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let text = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    let lines = split_lines(text);
    let Some(header) = parse_header_line(lines[0])? else {
        return Err(skip(
            SkipReason::NoHeader,
            format!("Unreadable Ignition header: \"{}\".", lines[0]),
        ));
    };
    if let Some(refusal) = unsupported_game_skip(&header.game_name, IGNITION_HI_LO)
        .or_else(|| unsupported_variant_skip(&header.game_name, IGNITION_VARIANTS))
    {
        return Err(refusal.into());
    }
    let variant = variant_of(&header.game_name);
    // Never `None` for an allowed variant (`holeCardCount(variant)!`).
    let Some(hole_count) = hole_card_count(variant) else {
        return Err(ParseError::Bug(format!(
            "no hole-card count for {variant:?}"
        )));
    };
    let hole_count = usize::try_from(hole_count).unwrap_or(usize::MAX);
    if ctx.options.cash_only && header.tournament_id.is_some() {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped.",
        ));
    }

    // Two hands spliced together mid-line parse as one chunk with two deals.
    let hole_markers = lines
        .iter()
        .filter(|line| HOLE_CARDS.is_match(js::trim(line)))
        .count();
    let summaries = lines
        .iter()
        .filter(|line| SUMMARY.is_match(js::trim(line)))
        .count();
    if hole_markers > 1 || summaries > 1 || lines[1..].iter().any(|line| ANY_HEADER.is_match(line))
    {
        return Err(skip(
            SkipReason::CorruptHand,
            "The chunk contains more than one hand; the export spliced them together.",
        ));
    }

    let mut warnings: Vec<PhfWarning> = Vec::new();
    let unit = if header.tournament_id.is_some() {
        CHIPS.unit()
    } else {
        unit_for_symbol("$").unit()
    };

    let mut seats: Vec<P5Seat> = Vec::new();
    // `seatByName`: stored name -> the last seat set under it.
    let mut seat_by_name: Vec<(String, usize)> = Vec::new();
    // `nameOf`: source pseudonym -> the name we store (differs for the hero).
    let mut name_of: Vec<(String, String)> = Vec::new();
    let mut hole_cards: Vec<(String, Vec<String>)> = Vec::new();
    let mut actions: Vec<P5Action> = Vec::new();
    let mut collected: Vec<P5Collect> = Vec::new();

    let mut small_blind = JsNumber::ZERO;
    let mut big_blind = JsNumber::ZERO;
    let mut stated_pot: Option<JsNumber> = None;
    let mut stated_rake: Option<JsNumber> = None;
    let mut button_seat: Option<JsNumber> = None;
    let mut set_dealer_value: Option<JsNumber> = None;
    let mut street = P5Street::Preflop;
    let mut saw_marker = false;
    let mut saw_hole_cards = false;
    let mut in_summary = false;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut summary_board: Vec<String> = Vec::new();
    let mut summary_lines: Vec<&str> = Vec::new();
    let mut player_hashes: Vec<(JsNumber, String)> = Vec::new();

    // `Ante chip` is a real ante whenever more than one seat posts one; a
    // lone one is live money.
    let mut ante_posters: Vec<&str> = Vec::new();
    for line in &lines {
        if let Some(poster) = ANTE_POSTER.captures(line) {
            let name = js::trim(poster.get(1).map_or("", |m| m.as_str()));
            if !ante_posters.contains(&name) {
                ante_posters.push(name);
            }
        }
    }
    let ante_is_dead = ante_posters.len() > 1;

    let action_of = |street: P5Street, player: &str, kind: P5Kind, amount: Option<JsNumber>| {
        let mut action = P5Action::new(street, player, kind);
        action.amount = amount;
        action
    };

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let line = js::trim(raw_line);
        let line_no = u32::try_from(i + 1).ok();
        if line.is_empty() {
            continue;
        }

        if SUMMARY.is_match(line) {
            in_summary = true;
            continue;
        }
        if in_summary {
            if let Some(pot) = TOTAL_POT.captures(line) {
                stated_pot = Some(parse_amount_js(&pot[1], &unit));
                stated_rake = pot.get(2).map(|rake| parse_amount_js(rake.as_str(), &unit));
                continue;
            }
            if SUMMARY_BOARD.is_match(line) {
                summary_board = cards_in(line);
                continue;
            }
            if SUMMARY_SEAT.is_match(line) {
                summary_lines.push(line);
                continue;
            }
            warnings.push(warning("unknown-summary-line", line, line_no));
            continue;
        }

        if HOLE_CARDS.is_match(line) {
            saw_hole_cards = true;
            continue;
        }
        if let Some(marker) = MARKER.captures(line) {
            saw_marker = true;
            let last = BRACKET
                .captures_iter(marker.get(2).map_or("", |m| m.as_str()))
                .last()
                .map(|group| cards_in(&group[1]))
                .unwrap_or_default();
            match js::to_upper_case(&marker[1]).as_str() {
                "FLOP" => {
                    flop = Some(last.into_iter().take(3).collect());
                    street = P5Street::Flop;
                }
                "TURN" => {
                    turn = last.into_iter().next();
                    street = P5Street::Turn;
                }
                _ => {
                    river = last.into_iter().next();
                    street = P5Street::River;
                }
            }
            continue;
        }
        // The 2012 "old format" deals the board with no street banner.
        if let Some(table_cards) = TABLE_CARDS.captures(line) {
            saw_marker = true;
            let cards = cards_in(&table_cards[1]);
            if cards.len() >= 3 && flop.is_none() {
                flop = Some(cards.into_iter().take(3).collect());
                street = P5Street::Flop;
            } else if turn.is_none() {
                turn = cards.into_iter().next();
                street = P5Street::Turn;
            } else {
                river = cards.into_iter().next();
                street = P5Street::River;
            }
            continue;
        }

        if let Some(seat_line) = SEAT.captures(line) {
            let pseudonym = js::trim(&seat_line[2]).to_owned();
            let is_hero = seat_line.get(3).is_some_and(|m| !m.as_str().is_empty());
            let name = if is_hero {
                "Hero".to_owned()
            } else {
                pseudonym.clone()
            };
            let number = JsNumber::parse(&seat_line[1]);
            seats.push(P5Seat {
                seat: number,
                name: name.clone(),
                starting_stack: parse_amount_js(&seat_line[4], &unit),
                is_hero,
                dealt_in: true,
                dealt_cards: Vec::new(),
            });
            set_entry(&mut seat_by_name, &name, seats.len() - 1);
            set_entry(&mut name_of, &pseudonym, name);
            if pseudonym == "Dealer" {
                button_seat = Some(number);
            }
            continue;
        }

        if TABLE_INFO.is_match(line) {
            // `Table Info: Version: 1, Type: MVS, Stakes: $0.25-$0.50, ...`
            if let Some(stakes) = STAKES.captures(line) {
                small_blind = parse_amount_js(&stakes[1], &unit);
                big_blind = parse_amount_js(&stakes[2], &unit);
            }
            continue;
        }
        if PLAYER_INFO.is_match(line) {
            for entry in PLAYER_HASH.captures_iter(line) {
                player_hashes.push((JsNumber::parse(&entry[1]), entry[2].to_owned()));
            }
            continue;
        }
        if NOISE_LINE.is_match(line) {
            continue;
        }

        let Some(actor) = ACTOR.captures(line) else {
            warnings.push(warning("unknown-line", line, line_no));
            continue;
        };
        let pseudonym = js::trim(actor.get(1).map_or("", |m| m.as_str()));
        let verb = js::trim(actor.get(3).map_or("", |m| m.as_str()));

        if let Some(dealer) = SET_DEALER.captures(verb) {
            set_dealer_value = Some(JsNumber::parse(&dealer[1]));
            continue;
        }
        if NOISE_VERB.is_match(verb) {
            continue;
        }

        let Some(player) = get_entry(&name_of, pseudonym).cloned() else {
            warnings.push(warning("unknown-line", line, line_no));
            continue;
        };
        let player = player.as_str();

        if let Some(dealt) = DEALT.captures(verb) {
            let cards = cards_in(&dealt[1]);
            if let Some(&seat) = get_entry(&seat_by_name, player) {
                seats[seat].dealt_cards.clone_from(&cards);
            }
            set_entry(&mut hole_cards, player, cards);
            continue;
        }

        if let Some(blind) = BLIND.captures(verb) {
            let amount = parse_amount_js(&blind[2], &unit);
            if SMALL.is_match(&blind[1]) {
                small_blind = small_blind.max_of(amount);
                actions.push(action_of(street, player, P5Kind::SmallBlind, Some(amount)));
            } else {
                big_blind = big_blind.max_of(amount);
                actions.push(action_of(street, player, P5Kind::BigBlind, Some(amount)));
            }
            continue;
        }

        if let Some(ante) = ANTE.captures(verb) {
            let amount = Some(parse_amount_js(&ante[1], &unit));
            if ante_is_dead {
                actions.push(action_of(street, player, P5Kind::Ante, amount));
            } else {
                warnings.push(warning(
                    "lone-ante-posted-live",
                    format!(
                        "{pseudonym} is the only seat to post an ante; treated as a live post."
                    ),
                    line_no,
                ));
                actions.push(action_of(street, player, P5Kind::Post, amount));
            }
            continue;
        }

        if let Some(post) = POST.captures(verb) {
            let amount = parse_amount_js(&post[2], &unit);
            // Up to one big blind is live; the rest is dead money.
            let live_share = if big_blind.greater_than(JsNumber::ZERO) {
                amount.min_of(big_blind)
            } else {
                amount
            };
            let mut action = action_of(street, player, P5Kind::Post, Some(live_share));
            action.dead = Some(amount - live_share);
            actions.push(action);
            continue;
        }

        if FOLDS.is_match(verb) {
            actions.push(action_of(street, player, P5Kind::Fold, None));
            continue;
        }
        if CHECKS.is_match(verb) {
            actions.push(action_of(street, player, P5Kind::Check, None));
            continue;
        }

        if let Some(call) = CALL.captures(verb) {
            let amount = Some(parse_amount_js(&call[1], &unit));
            actions.push(action_of(street, player, P5Kind::Call, amount));
            continue;
        }
        if let Some(bet) = BET.captures(verb) {
            let amount = Some(parse_amount_js(&bet[1], &unit));
            actions.push(action_of(street, player, P5Kind::Bet, amount));
            continue;
        }
        // `Raises X to Y`: an increment and a total; bare `Raises X`: the
        // street total on its own.
        let raise = RAISE_TO
            .captures(verb)
            .map(|raise| raise[2].to_owned())
            .or_else(|| RAISE.captures(verb).map(|raise| raise[1].to_owned()));
        if let Some(total) = raise {
            let all_in = ALL_IN_WORD.is_match(verb);
            let kind = if all_in { P5Kind::Allin } else { P5Kind::Raise };
            let mut action = action_of(street, player, kind, Some(parse_amount_js(&total, &unit)));
            action.to_total = true;
            action.all_in = all_in;
            actions.push(action);
            continue;
        }
        if let Some(all_in) = ALL_IN.captures(verb) {
            let amount = parse_amount_js(&all_in[1], &unit);
            // Before the deal, a short stack's blind; its pseudonym says which.
            let kind =
                if !saw_hole_cards && (pseudonym == "Small Blind" || pseudonym == "Big Blind") {
                    if pseudonym == "Small Blind" {
                        small_blind = small_blind.max_of(amount);
                        P5Kind::SmallBlind
                    } else {
                        big_blind = big_blind.max_of(amount);
                        P5Kind::BigBlind
                    }
                } else if !saw_hole_cards {
                    P5Kind::Post
                } else {
                    P5Kind::Allin
                };
            let mut action = action_of(street, player, kind, Some(amount));
            action.all_in = true;
            actions.push(action);
            continue;
        }

        if let Some(uncalled) = UNCALLED.captures(verb) {
            let amount = Some(parse_amount_js(&uncalled[1], &unit));
            actions.push(action_of(street, player, P5Kind::Uncalled, amount));
            continue;
        }

        // `Showdown [...]` lists the best five cards, never the hole cards.
        if let Some(showdown) = SHOWDOWN.captures(verb) {
            let mut action = action_of(street, player, P5Kind::Show, None);
            action.cards = Some(get_entry(&hole_cards, player).cloned().unwrap_or_default());
            action.description = showdown.get(2).map(|m| m.as_str().to_owned());
            actions.push(action);
            continue;
        }
        if let Some(reveal) = REVEAL.captures(verb) {
            let cards = cards_in(&reveal[2]);
            // A deal-sized group is the hole cards; anything else a best five.
            if cards.len() == hole_count && get_entry(&hole_cards, player).is_none() {
                set_entry(&mut hole_cards, player, cards);
            }
            let known = get_entry(&hole_cards, player).cloned().unwrap_or_default();
            let description = reveal.get(3).map(|m| m.as_str().to_owned());
            let mut action = if SHOWS_WORD.is_match(&reveal[1]) {
                let mut action = action_of(street, player, P5Kind::Show, None);
                action.cards = Some(known);
                action
            } else if MUCKS_WORD.is_match(&reveal[1]) {
                let mut action = action_of(street, player, P5Kind::Muck, None);
                action.cards = Some(known);
                action
            } else {
                // "Does not show": the pot was not contested.
                let mut action = action_of(street, player, P5Kind::Muck, None);
                action.cards = Some(Vec::new());
                action
            };
            action.description = description;
            actions.push(action);
            continue;
        }

        if let Some(result) = RESULT.captures(verb) {
            collected.push(P5Collect {
                player: player.to_owned(),
                amount: parse_amount_js(&result[2], &unit),
                pot_name: result
                    .get(1)
                    .filter(|m| !m.as_str().is_empty())
                    .map(|_| "side pot".to_owned()),
            });
            continue;
        }

        warnings.push(warning("unknown-line", line, line_no));
    }

    if seats.is_empty() {
        return Err(skip(SkipReason::NoPlayers, "The hand lists no seats."));
    }
    // The deal has to match the header.
    for seat in &seats {
        if !seat.dealt_cards.is_empty() && seat.dealt_cards.len() != hole_count {
            return Err(skip(
                SkipReason::UnsupportedVariant,
                format!(
                    "{} was dealt {} cards; \"{}\" deals {hole_count}.",
                    seat.name,
                    seat.dealt_cards.len(),
                    header.variant_label
                ),
            ));
        }
    }

    /* -------------------------------------------------------------- button */

    if button_seat.is_none()
        && let Some(value) = set_dealer_value
    {
        // `Set dealer [n]` is trusted only when it names a seat in the hand.
        if seats.iter().any(|seat| seat.seat.strict_equals(value)) {
            button_seat = Some(value);
        } else {
            warnings.push(warning(
                "dead-button",
                format!(
                    "No seat is on the button; \"Set dealer [{}]\" names no seated player.",
                    value.to_js_string()
                ),
                None,
            ));
        }
    }

    /* ------------------------------------------------------------- summary */

    let mut pseudonyms: Vec<&str> = name_of
        .iter()
        .map(|(pseudonym, _)| pseudonym.as_str())
        .collect();
    // `sort((a, b) => b.length - a.length)`, as V8 sorts.
    js::sort::sort_by(&mut pseudonyms, |a, b| utf16_length(b) - utf16_length(a));
    let mut stated_split: Vec<(String, StatedTotals)> = Vec::new();
    for line in &summary_lines {
        let rest = SUMMARY_PREFIX.replace(line, "");
        // Matched on the pseudonym, unique per hand: a large-field
        // tournament numbers its summary 1..9.
        let Some(pseudonym) = pseudonyms
            .iter()
            .find(|name| rest.starts_with(**name))
            .filter(|name| !name.is_empty())
        else {
            warnings.push(warning("unknown-summary-line", *line, None));
            continue;
        };
        let Some(player) = get_entry(&name_of, pseudonym).cloned() else {
            return Err(ParseError::Bug(format!("no name for {pseudonym}")));
        };
        // Hi/lo: what the room says the seat was paid for each half.
        let stated_hi = STATED_HI.captures(&rest);
        let stated_lo = STATED_LO.captures(&rest);
        if stated_hi.is_some() || stated_lo.is_some() {
            let half = |captures: &Option<regex::Captures<'_>>| {
                captures
                    .as_ref()
                    .map_or(JsNumber::ZERO, |c| parse_amount_js(&c[1], &unit))
            };
            set_entry(
                &mut stated_split,
                &player,
                StatedTotals {
                    hi: half(&stated_hi),
                    lo: half(&stated_lo),
                },
            );
        }
        if get_entry(&hole_cards, &player).is_some() {
            continue;
        }
        for group in BRACKET.captures_iter(&rest) {
            // `[Kd Qs-Kh Kd Qs Qd 9h]`: the hole cards, a dash, the best five.
            let before_dash = group[1].split('-').next().unwrap_or("");
            let cards = cards_in(before_dash);
            if cards.len() == hole_count {
                set_entry(&mut hole_cards, &player, cards);
                break;
            }
        }
    }

    /* --------------------------------------------------------------- board */

    let mut board: Vec<String> = flop.clone().unwrap_or_default();
    board.extend(turn.clone().filter(|card| !card.is_empty()));
    board.extend(river.clone().filter(|card| !card.is_empty()));
    if summary_board.len() > board.len() {
        if !board.is_empty() && summary_board[..board.len()] != board[..] {
            return Err(skip(
                SkipReason::BoardMismatch,
                format!(
                    "The street markers deal [{}] but the summary lists [{}].",
                    board.join(" "),
                    summary_board.join(" ")
                ),
            ));
        }
        board.clone_from(&summary_board);
        flop = Some(board.iter().take(3).cloned().collect());
        turn = board.get(3).cloned();
        river = board.get(4).cloned();
    }
    if !board.is_empty() && ![3, 4, 5].contains(&board.len()) {
        return Err(skip(
            SkipReason::BoardSize,
            format!("The board has {} cards.", board.len()),
        ));
    }

    /* ----------------------------------------------------- street recovery */

    if !saw_marker && !board.is_empty() {
        let rounds = split_into_rounds(&actions, &seats);
        let postflop = rounds.last().copied().unwrap_or(0);
        let needed = if postflop == 0 { 0 } else { postflop + 2 };
        if postflop > 3 || board.len() < needed {
            return Err(skip(
                SkipReason::MissingStreetMarkers,
                format!(
                    "The hand prints no street markers; {postflop} post-flop betting round(s) \
                     cannot be reconciled with a {}-card board.",
                    board.len()
                ),
            ));
        }
        const ORDER: [P5Street; 4] = [
            P5Street::Preflop,
            P5Street::Flop,
            P5Street::Turn,
            P5Street::River,
        ];
        for (action, round) in actions.iter_mut().zip(rounds) {
            action.street = ORDER[round];
        }
        if postflop > 0 {
            warnings.push(warning(
                "streets-inferred",
                format!(
                    "No street markers; {postflop} post-flop round(s) recovered from betting \
                     closure."
                ),
                None,
            ));
        }
    }

    /* --------------------------------------------------------------- build */

    if small_blind.strict_equals(JsNumber::ZERO) && big_blind.greater_than(JsNumber::ZERO) {
        warnings.push(warning(
            "dead-small-blind",
            "No small blind was posted; the seat to the button's left was empty.",
            None,
        ));
    }
    if header.level_big_blind.greater_than(JsNumber::ZERO)
        && big_blind.greater_than(JsNumber::ZERO)
        && !header.level_big_blind.strict_equals(big_blind)
    {
        warnings.push(warning(
            "stale-level-blinds",
            format!(
                "The level header advertises {}/{} but {}/{} was posted; the posted blinds win.",
                header.level_small_blind.to_js_string(),
                header.level_big_blind.to_js_string(),
                small_blind.to_js_string(),
                big_blind.to_js_string()
            ),
            None,
        ));
    }

    // A seat sitting out is listed with its stack but is not in the hand.
    for seat in &mut seats {
        seat.dealt_in =
            !seat.dealt_cards.is_empty() || actions.iter().any(|action| action.player == seat.name);
    }
    let dealt_in = seats.iter().filter(|seat| seat.dealt_in).count();
    let max_seats = [2_usize, 6, 9, 10]
        .into_iter()
        .find(|size| *size >= dealt_in)
        .unwrap_or(dealt_in);
    let game_label = if variant == Variant::Holdem {
        format!("Hold'em {}", header.limit)
    } else {
        canonical_game_label(
            variant,
            limit_type_of(header.limit),
            is_hi_lo_label(&header.game_name),
        )
    };
    let table_name = match &header.tournament_id {
        Some(id) => Some(
            js::trim(&format!(
                "{id} {}",
                header.table_id.as_deref().unwrap_or("")
            ))
            .to_owned(),
        ),
        None => header.table_id.clone(),
    };
    if stated_pot.is_none() {
        warnings.push(warning(
            "derived-pot",
            "The SUMMARY block states no pot; it was taken from the action stream.",
            None,
        ));
    }
    let draft = P5Draft {
        site_id: SITE_ID.to_owned(),
        site_name: SITE_NAME.to_owned(),
        parser_id: SITE_ID.to_owned(),
        parser_version: IGNITION_PARSER_VERSION.to_owned(),
        hand_id: header.hand_id.clone(),
        game_label,
        unit,
        decimals: DecimalStyle::Fixed2,
        small_blind: if truthy(small_blind) {
            small_blind
        } else {
            header.level_small_blind
        },
        big_blind: if truthy(big_blind) {
            big_blind
        } else {
            header.level_big_blind
        },
        table_name,
        max_seats: count(max_seats),
        button_seat,
        played_at: header.played_at.clone(),
        tournament: header.tournament_id.as_ref().map(|id| P5Tournament {
            id: id.clone(),
            name: header.speed.clone(),
            // Only the 2021 `[MVS]` header carries a buy-in.
            buy_in_token: mvs_buy_in(&lines).unwrap_or_else(|| "$0".to_owned()),
            level_label: header.level_label.clone().unwrap_or_else(|| "1".to_owned()),
        }),
        seats,
        actions,
        flop: flop.filter(|flop| flop.len() == 3),
        turn,
        river,
        collected,
        stated_pot,
        stated_rake,
        stated_contributions: None,
        hole_cards,
        raw_text: text.to_owned(),
        warnings,
    };

    let mut hand = p5_build_hand(&draft, ctx, &format!("IG{}", header.hand_id))?;
    if hand.game.hi_lo {
        let mut checked = check_stated_totals(&hand, &stated_split);
        hand.meta.warnings.append(&mut checked);
    }
    if !player_hashes.is_empty() {
        // Provenance, not identity: whether the hash is stable is unconfirmed.
        let message = player_hashes
            .iter()
            .map(|(seat, hash)| format!("{}={hash}", seat.to_js_string()))
            .collect::<Vec<_>>()
            .join(" ");
        hand.meta
            .warnings
            .push(warning("mvs-player-hashes", message, None));
    }
    Ok(hand)
}

/// `chunk.replace(/^\uFEFF/, "").trim()` (a literal BOM in the source).
fn clean_chunk(chunk: &str) -> &str {
    js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk))
}

/// `ignitionParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct IgnitionParser;

impl SiteParser for IgnitionParser {
    fn id(&self) -> &'static str {
        SITE_ID
    }

    fn name(&self) -> &'static str {
        SITE_NAME
    }

    fn version(&self) -> &'static str {
        IGNITION_PARSER_VERSION
    }

    fn hi_lo_variants(&self) -> &'static [Variant] {
        IGNITION_HI_LO
    }

    /// 0.95 for a brand-plus-`Hand #` line, 0.4 for a header-less excerpt
    /// with `Card dealt to a spot` and the mid-hand button marker.
    fn detect(&self, text: &str) -> u32 {
        // A byte-order mark in front of the header.
        let body = text.strip_prefix('\u{FEFF}').unwrap_or(text);
        if matches_at_line_start(&BRAND_HAND, body) {
            return 950;
        }
        if matches_at_line_start(&DETECT_SPOT, body) && DETECT_DEALER.is_match(body) {
            return 400;
        }
        0
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_before_line_starts(text, &BRAND_HAND)
            .into_iter()
            .map(clean_chunk)
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

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/ignition.ts");

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        assert!(source.contains(&format!("const BRANDS = String.raw`{BRANDS}`;")));
        for literal in [
            r#"const VERSION = "1.0.0";"#,
            "const IGNITION_VARIANTS: readonly Variant[] = HOLDEM_OMAHA;",
            "const IGNITION_HI_LO: readonly Variant[] = OMAHA_HI_LO;",
            r"const HEADER_RE = new RegExp(String.raw`^(?:${BRANDS})\s+Hand\s+#(\S+?):?\s+(.*)$`);",
            r#"const SPLIT_RE = new RegExp(String.raw`(?=^(?:${BRANDS})\s+Hand\s+#)`, "m");"#,
            r"const ANY_HEADER_RE = new RegExp(String.raw`(?:${BRANDS})\s+Hand\s+#\d`);",
            r"const DATE_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+UTC)?\s*$/;",
            r"/^(?:Leave\(Auto\)|Enter\(Auto\)|Table enter user|Table leave user|Table deposit\b|Seat sit out|Seat sit down|Seat re-join|Seat stand|Sit out|Sitout \(wait for bb\)|Re-join|Stand|Ranking\b|Prize Cash\b|Rebuyin\b|BOUNTY PRIZE\b|Draw for dealer\b)/i;",
            r"/^(?:Enter\(Auto\)|Table enter user|Table leave user|Table deposit\b|Seat sit out|Seat sit down|Seat re-join|Seat stand|Seating Info:)/i;",
            r"const GAME_RE = /^(HOLDEM|OMAHA|7CARD|NCARD)(ZonePoker)?(\s+HiLo)?(ZonePoker)?\b/;",
            r#"HOLDEM: "Hold'em","#,
            r#"OMAHA: "Omaha","#,
            r#""7CARD": "7 Card Stud","#,
            r#"gameName: `${GAME_NAMES[match[1]] ?? match[1]}${hiLo ? " Hi/Lo" : ""}`,"#,
            r#"if (/\bPot Limit\b/i.test(text)) return { limit: "Pot Limit", stated: true };"#,
            r#"if (/\bFixed Limit\b/i.test(text)) return { limit: "Fixed Limit", stated: true };"#,
            r#"if (/\bNo Limit\b/i.test(text)) return { limit: "No Limit", stated: true };"#,
            r#"return { limit: "No Limit", stated: false };"#,
            r#"rest = rest.slice(0, date.index).replace(/\s*-\s*$/, "").trim();"#,
            r#"rest = rest.replace(/\s*\[MVS\]\s*/, " ").trim();"#,
            r"/^(.+?)\s+Tournament\s+#(\S+)\s+TBL#([^,]+),\s*(.*?)\s*-\s*Level\s+(\S+)\s*\(([^)]*)\)$/,",
            r#"const speed = tournament[4].replace(/\b(?:No|Pot|Fixed)\s+Limit\b/i, "").trim();"#,
            "tableId: tournament[3].trim(),",
            "speed: speed || null,",
            "levelBigBlind: parseAmount(stakes[1] ?? stakes[0], CHIPS),",
            r"const cash = rest.match(/^(?:Zone Poker ID#(\S+)|TBL#(\S+))\s+(.*)$/);",
            "tableId: cash[1] ? `Zone Poker ${cash[1]}` : (cash[2] ?? null),",
            r"const CARD_RE = /\b(?:10|[2-9TJQKA])[cdhs]\b/g;",
            "(card.startsWith(\"10\") ? `T${card[2]}` : card)",
            "state.set(seat.name, { remaining: seat.startingStack, live: true });",
            "if (closed && isBetting(action.kind)) {",
            "? Math.max(0, (action.amount ?? 0) - already)",
            "if (entry) entry.live = false;",
            "if (entry) entry.remaining -= live;",
            "commit.set(action.player, already - (action.amount ?? 0));",
            "if (entry) entry.remaining += action.amount ?? 0;",
            "if (entry) entry.remaining -= live + (action.dead ?? 0);",
            "if (next > bet) {",
            "entry.remaining <= 0 || (acted.has(name) && (commit.get(name) ?? 0) >= bet),",
            "if (live.length <= 1) {",
            "hiLoVariants: IGNITION_HI_LO,",
            r#"const body = text.replace(/^\ufeff/, "");"#,
            r#"if (new RegExp(String.raw`^(?:${BRANDS})\s+Hand\s+#`, "m").test(body)) {"#,
            r"if (/^.* : Card dealt to a spot \[/m.test(body) && /: Set dealer(?:\/Bring in spot)? \[/.test(body)) {",
            "return 0.95;",
            "return 0.4;",
            ".split(SPLIT_RE)",
            ".map((chunk) => chunk.replace(/^\u{FEFF}/, \"\").trim())",
            r#".filter((chunk) => HEADER_RE.test(chunk.split(/\r?\n/)[0] ?? ""));"#,
            "const text = raw.replace(/^\u{FEFF}/, \"\").trim();",
            "throw new ParseSkip(\"no-header\", `Unreadable Ignition header: \"${lines[0]}\".`);",
            "unsupportedGameSkip(header.gameName, IGNITION_HI_LO) ??",
            "unsupportedVariantSkip(header.gameName, IGNITION_VARIANTS);",
            "const variant = variantOf(header.gameName);",
            "if (ctx.options.cashOnly && header.tournamentId) {",
            r"lines.filter((line) => /^\*\*\*\s*HOLE CARDS/i.test(line.trim())).length > 1 ||",
            r"lines.filter((line) => /^\*\*\*\s*SUMMARY/i.test(line.trim())).length > 1 ||",
            "lines.slice(1).some((line) => ANY_HEADER_RE.test(line))",
            r#""corrupt-hand","#,
            r#""The chunk contains more than one hand; the export spliced them together.","#,
            r#"const unit: CurrencyUnit = header.tournamentId ? CHIPS : unitForSymbol("$");"#,
            r".map((line) => line.match(/^(.*?)\s*(?:\[ME\])?\s*:\s*Ante chip\b/))",
            "const anteIsDead = antePosters.size > 1;",
            r"const pot = line.match(/^Total Pot\(([^)]*)\)(?:\s*\|\s*Rake\s*\(([^)]*)\))?/i);",
            "statedRake = pot[2] === undefined ? null : parseAmount(pot[2], unit);",
            r"if (/^Board\s*\[/i.test(line)) {",
            r"if (/^Seat\s*\+?\s*\d+\s*:/.test(line)) {",
            r#"warnings.push({ code: "unknown-summary-line", message: line, line: i + 1 });"#,
            r"if (/^\*\*\*\s*HOLE CARDS/i.test(line)) {",
            r"const marker = line.match(/^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*(.*)$/i);",
            r"const groups = [...marker[2].matchAll(/\[([^\]]*)\]/g)].map((group) => cardsIn(group[1]));",
            r"const tableCards = line.match(/^Card (?:dealt to|to the) table\s*\[([^\]]*)\]/i);",
            "if (cards.length >= 3 && !flop) {",
            "} else if (!turn) {",
            r"const seatLine = line.match(/^Seat\s+(\d+):\s+(.+?)\s*(\[ME\])?\s*\((.+?)\s+in chips\)$/);",
            r#"const name = isHero ? "Hero" : pseudonym;"#,
            r#"if (pseudonym === "Dealer") {"#,
            r"if (/^Table Info:/i.test(line)) {",
            r"const stakes = line.match(/Stakes:\s*\$?([\d.,]+)\s*-\s*\$?([\d.,]+)/i);",
            r"if (/^Player Info:/i.test(line)) {",
            r"for (const entry of line.matchAll(/P(\d+)-([0-9a-f]{32})/g)) {",
            r"const actor = line.match(/^(.*?)\s*(\[ME\])?\s*:\s*(.*)$/);",
            r#"warnings.push({ code: "unknown-line", message: line, line: i + 1 });"#,
            r"const dealer = verb.match(/^Set dealer(?:\/Bring in spot)?\s*\[(\d+)\]/i);",
            r"const dealt = verb.match(/^Card dealt to a spot\s*\[([^\]]*)\]/i);",
            r"/^(?:Ante\/)?(Small [Bb]lind|Big [Bb]lind(?:\/Bring in)?)\s+\$?([\d,.]+)$/,",
            r"if (/^Small/i.test(blind[1])) {",
            r"const ante = verb.match(/^Ante chip\s+\$?([\d,.]+)$/i);",
            r#"code: "lone-ante-posted-live","#,
            "message: `${pseudonym} is the only seat to post an ante; treated as a live post.`,",
            r"const post = verb.match(/^Posts (dead )?chip\s+\$?([\d,.]+)$/i);",
            "const liveShare = bigBlind > 0 ? Math.min(amount, bigBlind) : amount;",
            "dead: amount - liveShare,",
            r"if (/^Folds?\b/i.test(verb)) {",
            r"if (/^Checks\b/i.test(verb)) {",
            r"const call = verb.match(/^Calls?\s+\$?([\d,.]+)$/i);",
            r"const bet = verb.match(/^Bets?\s+\$?([\d,.]+)$/i);",
            r"/^(?:Raises|All-in\(raise[^)]*\))(?:\(timeout\))?\s+\$?([\d,.]+)\s+to\s+\$?([\d,.]+)$/i,",
            r"const raise = verb.match(/^(?:Raises|All-in\(raise[^)]*\))(?:\(timeout\))?\s+\$?([\d,.]+)$/i);",
            r#"kind: /All-in/i.test(verb) ? "allin" : "raise","#,
            "allIn: /All-in/i.test(verb),",
            r"const allIn = verb.match(/^All-in(?:\([^)]*\))?\s+\$?([\d,.]+)$/i);",
            r#"if (!sawHoleCards && (pseudonym === "Small Blind" || pseudonym === "Big Blind")) {"#,
            r#"push({ player, kind: "post", amount, allIn: true });"#,
            r#"push({ player, kind: "allin", amount, allIn: true });"#,
            r"const uncalled = verb.match(/^Return uncalled portion of bet\s+\$?([\d,.]+)$/i);",
            r"const showdown = verb.match(/^Showdown\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))?$/i);",
            "description: showdown[2],",
            r"const reveal = verb.match(/^(Does not show|Mucks|Shows)\s*\[([^\]]*)\]\s*(?:\(([^)]*)\))?$/i);",
            "if (cards.length === holeCount && !holeCards.has(player)) {",
            r"if (/^Shows$/i.test(reveal[1])) {",
            r"} else if (/^Mucks$/i.test(reveal[1])) {",
            r#"push({ player, kind: "muck", cards: [], description: reveal[3] });"#,
            r"const result = verb.match(/^Hand [Rr]esult(-Side [Pp]ot)?\s+\$?([\d,.]+)$/);",
            r#"potName: result[1] ? "side pot" : undefined,"#,
            "`${seat.name} was dealt ${seat.dealtCards.length} cards; \"${header.variantLabel}\" ` +",
            "`deals ${holeCount}.`,",
            "if (buttonSeat === null && setDealerValue !== null) {",
            "if (seats.some((seat) => seat.seat === setDealerValue)) {",
            r#"code: "dead-button","#,
            "message: `No seat is on the button; \"Set dealer [${setDealerValue}]\" names no seated player.`,",
            "const pseudonyms = [...nameOf.keys()].sort((a, b) => b.length - a.length);",
            r#"const rest = line.replace(/^Seat\s*\+?\s*\d+\s*:\s*/, "");"#,
            "const pseudonym = pseudonyms.find((name) => rest.startsWith(name));",
            "if (!pseudonym) {",
            r#"warnings.push({ code: "unknown-summary-line", message: line });"#,
            r"const statedHi = rest.match(/\bHI\s+([\d,.]+)/);",
            r"const statedLo = rest.match(/\bLOW\s+([\d,.]+)/);",
            r"for (const group of rest.matchAll(/\[([^\]]*)\]/g)) {",
            r#"const cards = cardsIn(group[1].split("-")[0]);"#,
            "if (summaryBoard.length > board.length) {",
            "if (board.length > 0 && !summaryBoard.slice(0, board.length).every((c, i) => c === board[i])) {",
            "`The street markers deal [${board.join(\" \")}] but the summary lists ` +",
            "`[${summaryBoard.join(\" \")}].`,",
            "if (board.length > 0 && ![3, 4, 5].includes(board.length)) {",
            "throw new ParseSkip(\"board-size\", `The board has ${board.length} cards.`);",
            "if (!sawMarker && board.length > 0) {",
            "const needed = postflop === 0 ? 0 : postflop + 2;",
            "if (postflop > 3 || board.length < needed) {",
            "`The hand prints no street markers; ${postflop} post-flop betting ` +",
            "`round(s) cannot be reconciled with a ${board.length}-card board.`,",
            r#"code: "streets-inferred","#,
            "message: `No street markers; ${postflop} post-flop round(s) recovered from betting closure.`,",
            "if (smallBlind === 0 && bigBlind > 0) {",
            r#"code: "dead-small-blind","#,
            r#"message: "No small blind was posted; the seat to the button's left was empty.","#,
            "header.levelBigBlind > 0 &&",
            "header.levelBigBlind !== bigBlind",
            r#"code: "stale-level-blinds","#,
            "`The level header advertises ${header.levelSmallBlind}/${header.levelBigBlind} ` +",
            "`but ${smallBlind}/${bigBlind} was posted; the posted blinds win.`,",
            "seat.dealtIn = seat.dealtCards.length > 0 || actors.has(seat.name);",
            r#"siteName: "Ignition / Bodog / Bovada","#,
            r#"? `Hold'em ${header.limit}`"#,
            ": canonicalGameLabel(variant, limitTypeOf(header.limit), isHiLoLabel(header.gameName)),",
            "smallBlind: smallBlind || header.levelSmallBlind,",
            "bigBlind: bigBlind || header.levelBigBlind,",
            r#"? `${header.tournamentId} ${header.tableId ?? ""}`.trim()"#,
            "maxSeats: [2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn,",
            "name: header.speed,",
            r#"buyInToken: mvsBuyIn(lines) ?? "$0","#,
            r#"levelLabel: header.levelLabel ?? "1","#,
            "flop: flop && flop.length === 3 ? flop : null,",
            "rawText: text,",
            r#"code: "derived-pot","#,
            r#"message: "The SUMMARY block states no pot; it was taken from the action stream.","#,
            "const hand = p5BuildHand(draft, ctx, `IG${header.handId}`);",
            "hand.meta.warnings.push(...checkStatedTotals(hand, statedSplit));",
            r#"code: "mvs-player-hashes","#,
            "message: playerHashes.map((entry) => `${entry.seat}=${entry.hash}`).join(\" \"),",
            r#"return limit === "Pot Limit" ? "pl" : limit === "Fixed Limit" ? "fl" : "nl";"#,
            r"const match = line.match(/^Table Info:.*\bBuyin:\s*([^,]+)/i);",
            r#"return match[1].trim().replace(/\s+/g, "");"#,
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    #[test]
    fn game_tokens_and_limits() {
        assert_eq!(
            parse_game_token("OMAHA HiLo"),
            ("Omaha Hi/Lo".to_owned(), "OMAHA HiLo".to_owned())
        );
        assert_eq!(
            parse_game_token("HOLDEMZonePoker No Limit"),
            ("Hold'em".to_owned(), "HOLDEMZonePoker".to_owned())
        );
        assert_eq!(
            parse_game_token("NCARD"),
            ("NCARD".to_owned(), "NCARD".to_owned())
        );
        assert_eq!(
            parse_game_token("RAZZ"),
            ("RAZZ".to_owned(), "RAZZ".to_owned())
        );
        assert_eq!(parse_limit("Turbo-"), "No Limit");
        assert_eq!(parse_limit("OMAHA pot limit"), "Pot Limit");
        assert_eq!(
            mvs_buy_in(&["x", "Table Info: Buyin: $25 + $2.50, TableType: MTT"]),
            Some("$25+$2.50".to_owned())
        );
    }

    #[test]
    fn rounds_close_on_betting() {
        let seat = |name: &str| P5Seat {
            seat: JsNumber::from_u64(1),
            name: name.to_owned(),
            starting_stack: JsNumber::from_u64(1000),
            is_hero: false,
            dealt_in: true,
            dealt_cards: Vec::new(),
        };
        let act = |player: &str, kind: P5Kind, amount: Option<u64>| {
            let mut action = P5Action::new(P5Street::Preflop, player, kind);
            action.amount = amount.map(JsNumber::from_u64);
            action
        };
        let actions = vec![
            act("a", P5Kind::SmallBlind, Some(10)),
            act("b", P5Kind::BigBlind, Some(20)),
            act("a", P5Kind::Call, Some(10)),
            act("b", P5Kind::Check, None),
            act("a", P5Kind::Bet, Some(20)),
            act("b", P5Kind::Call, Some(20)),
            act("a", P5Kind::Check, None),
            act("b", P5Kind::Check, None),
        ];
        assert_eq!(
            split_into_rounds(&actions, &[seat("a"), seat("b")]),
            [0, 0, 0, 0, 1, 1, 2, 2]
        );
    }
}
