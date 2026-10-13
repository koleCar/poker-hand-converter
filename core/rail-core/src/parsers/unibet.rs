//! `unibet`: Unibet Poker's own plain-text export
//! (`frontend/src/lib/parsers/unibet.ts`), not its iPoker skin.
//!
//! Two header generations, one body grammar:
//!
//! - **2021**: `Game #<id>: Table <cur><n> <LIMIT> - <sb>/<bb> - <game> -
//!   <time> <date>` - no table line, no zone (read as UTC), the `€1 NL` token
//!   is the table name;
//! - **2026** (Relax Gaming): `Unibet Hand #<id> - <sb>/<bb> - <game> - UTC
//!   <time> <date>` and a `Table "<name>" <n>-max` line; tournaments insert
//!   `, Tournament #<id>, <buy-in> + <fee>` and `- Total prize <amount>`.
//!
//! The board repeats itself in brackets (only the last group is new); `Total
//! pot` is gross (uncalled money included) and only cross-checked; the hero's
//! name carries a session token (`hero[Unibet_28204e08...]`), stripped before
//! anything reads a name; a Windows-1252 export decoded as UTF-8 is refused
//! (`refuse_lossy_text`). The body goes through `draft_to_standard_text`; a
//! tournament's first line is rewritten before the text is re-read, since the
//! shared builder writes only the cash header.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::ipoker::{highest_seat, next_table_size};
use super::shared::p2_handbuilder::{
    DraftAction, DraftCollect, DraftKind, DraftSeat, DraftStreet, HandDraft,
    draft_to_standard_text, format_header_date,
};
use super::shared::p2_partygaming::split_lines;
use super::shared::p4_textroom::{
    currency_symbol_of, leading_name, names_by_length, refuse_lossy_text, strict_amount,
};
use super::shared::ps_gg_hand::split_before_line_starts;
use super::shared::variant_lock::{
    HOLDEM_OMAHA, canonical_game_label, unsupported_variant_skip, variant_of,
};
use crate::cards::extract_cards;
use crate::detect::{
    ParseError, ParseSkip, SiteParser, SiteParserContext, SkipReason, SplitError,
    unsupported_game_skip,
};
use crate::js::{self, JsNumber};
use crate::phf::money::{
    chips_unit_for, format_amount_digits_js, format_amount_js, parse_amount, parse_buy_in_token_js,
    unit_for_symbol,
};
use crate::phf::serialize::{
    StandardContext, line_starts, matches_at_line_start, parse_instant, parse_standard_hand,
    to_iso_string,
};
use crate::phf::{ActionType, CurrencyUnit, DecimalStyle, LimitType, PhfHand, PhfWarning, Variant};

/// `VERSION`.
pub const UNIBET_PARSER_VERSION: &str = "1.0.0";

/// `UNIBET_VARIANTS`: Hold'em and four-card Omaha.
const UNIBET_VARIANTS: &[Variant] = HOLDEM_OMAHA;

/* ------------------------------------------------------------------ headers */

static LEGACY_HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Game\s+#(\d+):\s+Table\s+(\S+)\s+(PL|NL|FL)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)\s+-\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$",
    ""
);
static MODERN_CASH_HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Unibet\s+Hand\s+#(\d+)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)\s+-\s+(?:UTC\s+)?(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$",
    ""
);
static MODERN_TOUR_HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Unibet\s+Hand\s+#(\d+),\s+Tournament\s+#(\S+?),\s+(\S+)\s+\+\s+(\S+)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)(?:\s+-\s+Total\s+prize\s+(\S+))?\s+-\s+(?:UTC\s+)?(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$",
    ""
);
static SUMMARY_FILE_HEADER: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Unibet\s+Tournament\s+#(\S+?),", "");
/// `CHUNK_START`'s lookahead, `/(?=^(?:...))/m`, at line starts.
static CHUNK_START: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Unibet\s+(?:Hand|Tournament)\s+#|Game\s+#\d+:\s+Table\s)",
    ""
);

static TABLE_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r#"^Table\s+"([^"]*)"\s+(\d+)-max\s*$"#, "");
static SEAT_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)$", "");
static SECTION_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^\*\*\*\s*(.+?)\s*\*\*\*(.*)$", "");
static SUMMARY_SEAT_LINE: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Seat\s+(\d+):\s+(.+):\s+bet\s+(\S+)\s+and\s+won\s+(\S+),\s+net\s+result:\s+(\S+)\s*$",
    ""
);
static TOTAL_POT_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Total\s+pot\s+(\S+)(?:\s+Rake\s+(\S+))?\s*$", "");
static UNCALLED_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Uncalled\s+bet\s+returned\s+to\s+(.+):\s+(\S+)\s*$", "");

static HERO_TOKEN: LazyLock<Regex> = crate::js_regex_lazy!(r"\[Unibet_[0-9a-fA-F]+\]", "g");
/// `HERO_SEAT` (`m`): anchored, tried at every JavaScript line start.
static HERO_SEAT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Seat\s+\d+:\s+(.+?)\[Unibet_[0-9a-fA-F]+\]\s+\(", "");

/* detect's probes */
static XML_ROOT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"<\s*(?:session|game|description)\b", "i");
static DETECT_MODERN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Unibet\s+Hand\s+#\d+(?:,\s+Tournament\s+#|\s+-\s)", "");
static DETECT_LEGACY: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^Game\s+#\d+:\s+Table\s+\S+\s+(?:PL|NL|FL)\s+-\s+[\d.,]+\/[\d.,]+\s+-\s",
    ""
);
static DETECT_SUMMARY: LazyLock<Regex> = crate::js_regex_lazy!(r"^Unibet\s+Tournament\s+#\S+,", "");

/* parseHand's other patterns */
static SITTING_OUT: LazyLock<Regex> = crate::js_regex_lazy!(r"\s*\(sitting out\)\s*$", "i");
static BRACKETS: LazyLock<Regex> = crate::js_regex_lazy!(r"\[([^\]]*)\]", "g");
static DEALT_TO: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^Dealt\s+to\s+(.+)\s+\[([^\]]*)\]\s*$", "");
static DEALT_IN: LazyLock<Regex> = crate::js_regex_lazy!(r"^Dealt\s+in\s+(.+)\s*$", "");
static FIRST_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^(Poker Hand #\S+:).*", "");

/* limitFromLabel and fastFoldOf */
static POT_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"\bpot\s+limit\b", "i");
static FIXED_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"\b(?:fixed\s+limit|limit)\b", "i");
static NO_LIMIT: LazyLock<Regex> = crate::js_regex_lazy!(r"\bno\s+limit\b", "i");
static BANZAI: LazyLock<Regex> = crate::js_regex_lazy!(r"\bbanzai\b", "i");
static WHOLE_CHIPS: LazyLock<Regex> = crate::js_regex_lazy!(r"^(\d+)\.0+$", "");

/* readAction's patterns */
static DECORATION: LazyLock<Regex> =
    crate::js_regex_lazy!(r"\s+\((?:timed out|disconnect(?:ed)?|time out)\)\s*$", "i");
static SHOVE: LazyLock<Regex> = crate::js_regex_lazy!(r",\s*and\s+is\s+all-in\s*$", "i");
static HAS_BUTTON: LazyLock<Regex> = crate::js_regex_lazy!(r"^has the button$", "i");
static SITTING: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:is\s+)?sitting out$", "i");
static SITS_OUT: LazyLock<Regex> = crate::js_regex_lazy!(r"^sits out$", "i");
static POSTED: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^posts\s+(small blind|big blind|small & big blinds|button blind|straddle|the ante?)\s+(\S+)$",
    "i"
);
static FOLDS: LazyLock<Regex> = crate::js_regex_lazy!(r"^folds$", "i");
static CHECKS: LazyLock<Regex> = crate::js_regex_lazy!(r"^checks$", "i");
static CALLED: LazyLock<Regex> = crate::js_regex_lazy!(r"^calls\s+(\S+)$", "i");
static BET: LazyLock<Regex> = crate::js_regex_lazy!(r"^bets\s+(\S+)$", "i");
static RAISED: LazyLock<Regex> = crate::js_regex_lazy!(r"^raises\s+\S+\s+to\s+(\S+)$", "i");
static SHOWS: LazyLock<Regex> = crate::js_regex_lazy!(r"^shows\s+\[([^\]]*)\](?:,\s*(.*))?$", "i");
static MUCKS: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:mucks|does not show(?: cards)?|doesn't show(?: hand)?)(?:\s+\[([^\]]*)\])?$",
    "i"
);
static SIDE_POT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^wins\s+(main|side)\s+pot(?:\s+#\d+)?,\s+(\S+)$", "i");
static WINS: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^wins\s+(\S+)(?:\s+from\s+(main|side)\s+pot(?:\s+#\d+)?)?$",
    "i"
);
static CASHED_OUT: LazyLock<Regex> = crate::js_regex_lazy!(r"^cashed out the hand for\b", "i");
static BOUNTY: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^wins\s+(?:the\s+)?\S+\s+(?:bounty\s+)?for eliminating\b",
    "i"
);
static TOURNAMENT_WIN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^wins the tournament and receives\b", "i");
static PLACING: LazyLock<Regex> = crate::js_regex_lazy!(r"^finished the tournament in\b", "i");

fn skip(reason: SkipReason, message: impl Into<String>) -> ParseError {
    ParseError::Skip(ParseSkip::new(reason, message))
}

fn line_number(i: usize) -> Option<u32> {
    u32::try_from(i + 1).ok()
}

fn group<'t>(captures: &regex::Captures<'t>, i: usize) -> &'t str {
    captures.get(i).map_or("", |m| m.as_str())
}

/// `{ id, buyInToken, prizeToken }`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Tournament {
    id: String,
    buy_in_token: String,
    prize_token: Option<String>,
}

/// `Header` (its `gameLabel` is never read; not carried).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Header {
    hand_id: String,
    variant_word: String,
    limit: LimitType,
    small_blind: String,
    big_blind: String,
    played_at: String,
    /// Table name, when the header carries one (2021 only).
    table_name: Option<String>,
    /// Fast-fold brand from the game label (`Banzai`).
    fast_fold: Option<&'static str>,
    tournament: Option<Tournament>,
}

/// What `toISOString` throws on an invalid date.
const INVALID_TIME_VALUE: &str = "Invalid time value";

/// `isoAt(h, mi, s, y, mo, d)`: `new Date("<y>-<mo>-<d>T<hh>:<mi>:<s>Z")
/// .toISOString()`, read as UTC in both eras; `Err` is the `RangeError`.
fn iso_at(h: &str, mi: &str, s: &str, y: &str, mo: &str, d: &str) -> Result<String, String> {
    let hour = if h.len() < 2 {
        format!("0{h}")
    } else {
        h.to_owned()
    };
    parse_instant(&format!("{y}-{mo}-{d}T{hour}:{mi}:{s}Z"))
        .map(to_iso_string)
        .ok_or_else(|| INVALID_TIME_VALUE.to_owned())
}

/// `limitFromLabel(label, token?)`.
fn limit_from_label(label: &str, token: Option<&str>) -> LimitType {
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        return match token {
            "PL" => LimitType::Pl,
            "FL" => LimitType::Fl,
            _ => LimitType::Nl,
        };
    }
    if POT_LIMIT.is_match(label) {
        return LimitType::Pl;
    }
    if FIXED_LIMIT.is_match(label) && !NO_LIMIT.is_match(label) {
        return LimitType::Fl;
    }
    LimitType::Nl
}

/// `fastFoldOf(gameLabel)`: Unibet's fast-fold brand inside the label.
fn fast_fold_of(label: &str) -> Option<&'static str> {
    BANZAI.is_match(label).then_some("Banzai")
}

/// `readHeader(line)`: the tournament, cash and legacy shapes in that order;
/// `Err` when the matching header's date is invalid (`isoAt` throws).
fn read_header(line: &str) -> Result<Option<Header>, String> {
    if let Some(tour) = MODERN_TOUR_HEADER.captures(line) {
        let game = group(&tour, 7);
        return Ok(Some(Header {
            hand_id: group(&tour, 1).to_owned(),
            variant_word: game.to_owned(),
            limit: limit_from_label(game, None),
            small_blind: group(&tour, 5).to_owned(),
            big_blind: group(&tour, 6).to_owned(),
            played_at: iso_at(
                group(&tour, 9),
                group(&tour, 10),
                group(&tour, 11),
                group(&tour, 12),
                group(&tour, 13),
                group(&tour, 14),
            )?,
            table_name: None,
            fast_fold: fast_fold_of(game),
            tournament: Some(Tournament {
                id: group(&tour, 2).to_owned(),
                buy_in_token: format!("{}+{}", group(&tour, 3), group(&tour, 4)),
                prize_token: tour.get(8).map(|m| m.as_str().to_owned()),
            }),
        }));
    }
    if let Some(cash) = MODERN_CASH_HEADER.captures(line) {
        let game = group(&cash, 4);
        return Ok(Some(Header {
            hand_id: group(&cash, 1).to_owned(),
            variant_word: game.to_owned(),
            limit: limit_from_label(game, None),
            small_blind: group(&cash, 2).to_owned(),
            big_blind: group(&cash, 3).to_owned(),
            played_at: iso_at(
                group(&cash, 5),
                group(&cash, 6),
                group(&cash, 7),
                group(&cash, 8),
                group(&cash, 9),
                group(&cash, 10),
            )?,
            table_name: None,
            fast_fold: fast_fold_of(game),
            tournament: None,
        }));
    }
    if let Some(legacy) = LEGACY_HEADER.captures(line) {
        let game = group(&legacy, 6);
        return Ok(Some(Header {
            hand_id: group(&legacy, 1).to_owned(),
            variant_word: game.to_owned(),
            limit: limit_from_label(game, Some(group(&legacy, 3))),
            small_blind: group(&legacy, 4).to_owned(),
            big_blind: group(&legacy, 5).to_owned(),
            played_at: iso_at(
                group(&legacy, 7),
                group(&legacy, 8),
                group(&legacy, 9),
                group(&legacy, 10),
                group(&legacy, 11),
                group(&legacy, 12),
            )?,
            // The `€1 NL` token is the only thing naming a 2021 table.
            table_name: Some(format!("{} {}", group(&legacy, 2), group(&legacy, 3))),
            fast_fold: fast_fold_of(game),
            tournament: None,
        }));
    }
    Ok(None)
}

/// `headerBlind(token, unit, where)`: a whole-chip unit tolerates a purely
/// decorative fractional part (`25.00`).
fn header_blind(token: &str, unit: &CurrencyUnit, place: &str) -> Result<JsNumber, ParseSkip> {
    let whole = if unit.minor_units == 1 {
        WHOLE_CHIPS.captures(js::trim(token))
    } else {
        None
    };
    match whole {
        Some(whole) => strict_amount(group(&whole, 1), unit, place),
        None => strict_amount(token, unit, place),
    }
}

/// A seat line of the first pass (`seatLines`; its `sittingOut` is never
/// read, not carried).
struct SeatLine {
    seat: JsNumber,
    name: String,
    stack: String,
}

/// `unitFor(header, seatLines, body, warnings)`: the seat stacks' symbol;
/// none is chips, and only allowed for a tournament.
fn unit_for(
    header: &Header,
    seat_lines: &[SeatLine],
    body: &str,
    warnings: &mut Vec<PhfWarning>,
) -> Result<CurrencyUnit, ParseSkip> {
    let symbol = seat_lines
        .iter()
        .map(|entry| currency_symbol_of(&entry.stack))
        .find(|symbol| !symbol.is_empty())
        .unwrap_or("");
    if symbol.is_empty() {
        if header.tournament.is_none() {
            return Err(ParseSkip::new(
                SkipReason::NoCurrency,
                "No seat stack carries a currency symbol and the header is not a tournament \
                 header, so the amounts cannot be read as either cash or chips.",
            ));
        }
        return Ok(chips_unit_for(body).unit());
    }
    if header.tournament.is_some() {
        warnings.push(PhfWarning {
            code: "unexpected-currency".to_owned(),
            message: format!(
                "Tournament stacks carry the symbol \"{symbol}\"; read as chips anyway."
            ),
            line: None,
        });
        return Ok(chips_unit_for(body).unit());
    }
    Ok(unit_for_symbol(symbol).unit())
}

/// `fallbackMaxSeats(seats)`: the 2021 header states no table size.
fn fallback_max_seats(seats: &[DraftSeat]) -> JsNumber {
    next_table_size(&[2, 3, 4, 6, 9, 10], highest_seat(seats))
}

/// What `readAction` returns: `true`, `"button"`, `"big-blind"`, `"refuse"`
/// or `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handled {
    Yes,
    Button,
    BigBlind,
    Refuse,
    No,
}

/// `ActionContext`, plus the street `act` closes over.
struct ActionContext<'a> {
    player: &'a str,
    unit: &'a CurrencyUnit,
    big_blind: JsNumber,
    street: DraftStreet,
    actions: &'a mut Vec<DraftAction>,
    collected: &'a mut Vec<DraftCollect>,
    shown: &'a mut HashSet<String>,
    warnings: &'a mut Vec<PhfWarning>,
    line: Option<u32>,
}

impl ActionContext<'_> {
    fn act(&mut self, kind: DraftKind) -> &mut DraftAction {
        self.actions
            .push(DraftAction::new(self.street, self.player, kind));
        self.actions.last_mut().expect("just pushed")
    }

    fn warn(&mut self, code: &str, message: String) {
        self.warnings.push(PhfWarning {
            code: code.to_owned(),
            message,
            line: self.line,
        });
    }
}

/// `readAction(rest, ctx)`: the part of an action line after the name.
#[allow(clippy::too_many_lines)]
fn read_action(rest: &str, ctx: &mut ActionContext<'_>) -> Result<Handled, ParseSkip> {
    let unit = ctx.unit;
    // `folds  (timed out)`, `folds (disconnect)`: decoration.
    let undecorated = DECORATION.replacen(rest, 1, "");
    let mut body = js::trim(&undecorated);
    let mut all_in = false;
    if let Some(shove) = SHOVE.find(body) {
        all_in = true;
        body = js::trim(&body[..shove.start()]);
    }

    if HAS_BUTTON.is_match(body) {
        return Ok(Handled::Button);
    }
    if SITTING.is_match(body) || SITS_OUT.is_match(body) {
        return Ok(Handled::Yes);
    }

    if let Some(posted) = POSTED.captures(body) {
        let kind = js::to_lower_case(group(&posted, 1));
        let amount = strict_amount(group(&posted, 2), unit, "a posting line")?;
        match kind.as_str() {
            "small blind" => {
                let post = ctx.act(DraftKind::SmallBlind);
                post.amount = Some(amount);
                post.all_in = all_in;
                return Ok(Handled::Yes);
            }
            "big blind" => {
                let post = ctx.act(DraftKind::BigBlind);
                post.amount = Some(amount);
                post.all_in = all_in;
                return Ok(Handled::BigBlind);
            }
            "the ant" | "the ante" => {
                if kind == "the ant" {
                    ctx.warn(
                        "unconfirmed-line",
                        format!("Ante written as \"posts the ant\": {body}"),
                    );
                }
                let post = ctx.act(DraftKind::Ante);
                post.amount = Some(amount);
                post.all_in = all_in;
                return Ok(Handled::Yes);
            }
            "small & big blinds" => {
                // The big blind live plus a dead small blind on one line.
                let big_blind =
                    if ctx.big_blind.is_nan() || ctx.big_blind.strict_equals(JsNumber::ZERO) {
                        amount
                    } else {
                        ctx.big_blind
                    };
                let live = big_blind.min_of(amount);
                ctx.warn(
                    "unconfirmed-line",
                    format!(
                        "Combined blind post read as {} live: {body}",
                        live.to_js_string()
                    ),
                );
                let post = ctx.act(DraftKind::Post);
                post.amount = Some(live);
                post.dead = Some(amount - live);
                post.all_in = all_in;
                return Ok(Handled::Yes);
            }
            _ => {
                ctx.warn(
                    "unconfirmed-line",
                    format!("Posting shape read as a live post: {body}"),
                );
                let post = ctx.act(if kind == "straddle" {
                    DraftKind::Straddle
                } else {
                    DraftKind::Post
                });
                post.amount = Some(amount);
                post.all_in = all_in;
                return Ok(Handled::Yes);
            }
        }
    }

    if FOLDS.is_match(body) {
        ctx.act(DraftKind::Fold);
        return Ok(Handled::Yes);
    }
    if CHECKS.is_match(body) {
        ctx.act(DraftKind::Check);
        return Ok(Handled::Yes);
    }
    for (pattern, kind, place) in [
        (&*CALLED, DraftKind::Call, "a call"),
        (&*BET, DraftKind::Bet, "a bet"),
    ] {
        if let Some(found) = pattern.captures(body) {
            let amount = strict_amount(group(&found, 1), unit, place)?;
            let wager = ctx.act(kind);
            wager.amount = Some(amount);
            wager.all_in = all_in;
            return Ok(Handled::Yes);
        }
    }
    if let Some(raised) = RAISED.captures(body) {
        // Only the "to" total is reliable.
        let amount = strict_amount(group(&raised, 1), unit, "a raise")?;
        let raise = ctx.act(DraftKind::Raise);
        raise.amount = Some(amount);
        raise.to_total = true;
        raise.all_in = all_in;
        return Ok(Handled::Yes);
    }

    if let Some(shows) = SHOWS.captures(body) {
        ctx.shown.insert(ctx.player.to_owned());
        let description = shows
            .get(2)
            .map(|m| js::trim(m.as_str()))
            .filter(|d| !d.is_empty())
            .map(str::to_owned);
        let show = ctx.act(DraftKind::Show);
        show.cards = Some(extract_cards(group(&shows, 1)));
        show.description = description;
        return Ok(Handled::Yes);
    }
    if let Some(mucks) = MUCKS.captures(body) {
        ctx.shown.insert(ctx.player.to_owned());
        let muck = ctx.act(DraftKind::Muck);
        muck.cards = Some(extract_cards(group(&mucks, 1)));
        return Ok(Handled::Yes);
    }

    // `wins side pot #1, <amt>` / `wins <amt> from main pot` / `wins <amt>`.
    if let Some(side) = SIDE_POT.captures(body) {
        let amount = strict_amount(group(&side, 2), unit, "a side-pot win line")?;
        ctx.collected.push(DraftCollect {
            player: ctx.player.to_owned(),
            amount,
            pot_name: Some(format!("{} pot", js::to_lower_case(group(&side, 1)))),
            half: None,
        });
        return Ok(Handled::Yes);
    }
    if let Some(wins) = WINS.captures(body) {
        let amount = strict_amount(group(&wins, 1), unit, "a win line")?;
        ctx.collected.push(DraftCollect {
            player: ctx.player.to_owned(),
            amount,
            pot_name: Some(match wins.get(2) {
                Some(pot) if !pot.as_str().is_empty() => {
                    format!("{} pot", js::to_lower_case(pot.as_str()))
                }
                _ => "pot".to_owned(),
            }),
            half: None,
        });
        return Ok(Handled::Yes);
    }

    // Money that settles outside the pot.
    if CASHED_OUT.is_match(body) {
        return Ok(Handled::Refuse);
    }
    if BOUNTY.is_match(body) || TOURNAMENT_WIN.is_match(body) || PLACING.is_match(body) {
        let message = format!(
            "Bounty or placing payment recorded in the raw text only: {} {body}",
            ctx.player
        );
        ctx.warn("outside-pot", message);
        return Ok(Handled::Yes);
    }

    Ok(Handled::No)
}

/// The first `HERO_SEAT` match's name (`source.match(HERO_SEAT)?.[1]`).
fn hero_name(source: &str) -> Option<String> {
    line_starts(source).find_map(|start| {
        HERO_SEAT
            .captures(&source[start..])
            .map(|seat| group(&seat, 1).to_owned())
    })
}

/// `String.prototype.replace`'s `GetSubstitution` for a replacement
/// template: `$$`, `$&`, `` $` ``, `$'`, `$n` / `$nn` (two digits only when
/// that group exists, else one), `$<` without named groups; anything else
/// is literal.
fn get_substitution(
    matched: &str,
    before: &str,
    after: &str,
    captures: &[Option<&str>],
    template: &str,
) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(dollar) = rest.find('$') {
        out.push_str(&rest[..dollar]);
        let tail = &rest[dollar..];
        let bytes = tail.as_bytes();
        let consumed = match bytes.get(1).copied() {
            Some(b'$') => {
                out.push('$');
                2
            }
            Some(b'&') => {
                out.push_str(matched);
                2
            }
            Some(b'`') => {
                out.push_str(before);
                2
            }
            Some(b'\'') => {
                out.push_str(after);
                2
            }
            Some(first) if first.is_ascii_digit() => {
                let second = bytes.get(2).copied().filter(u8::is_ascii_digit);
                let one = usize::from(first - b'0');
                let (count, index) = match second {
                    Some(second) if one * 10 + usize::from(second - b'0') <= captures.len() => {
                        (2, one * 10 + usize::from(second - b'0'))
                    }
                    _ => (1, one),
                };
                if (1..=captures.len()).contains(&index) {
                    out.push_str(captures[index - 1].unwrap_or(""));
                } else {
                    out.push_str(&tail[..=count]);
                }
                1 + count
            }
            Some(b'<') => {
                // No named groups: `$<` is literal.
                out.push_str("$<");
                2
            }
            _ => {
                out.push('$');
                1
            }
        };
        rest = &tail[consumed..];
    }
    out.push_str(rest);
    out
}

/// `text.replace(/^(Poker Hand #\S+:).*$/m, `$1 ${payload}`)`: the first
/// line that opens a hand, rewritten, `$` patterns in the payload expanded
/// as JavaScript expands them.
fn rewrite_first_line(text: &str, payload: &str) -> String {
    for start in line_starts(text) {
        if let Some(found) = FIRST_LINE.captures(&text[start..]) {
            let whole = found.get(0).expect("the match");
            let (from, to) = (start + whole.start(), start + whole.end());
            let replacement = get_substitution(
                whole.as_str(),
                &text[..from],
                &text[to..],
                &[found.get(1).map(|m| m.as_str())],
                &format!("$1 {payload}"),
            );
            return format!("{}{replacement}{}", &text[..from], &text[to..]);
        }
    }
    text.to_owned()
}

/// `buildUnibetHand(draft, header, ctx)`: the shared builder's text, with a
/// tournament's first line rewritten, read back.
fn build_unibet_hand(
    draft: &HandDraft,
    header: &Header,
    ctx: &SiteParserContext<'_>,
) -> Result<PhfHand, ParseError> {
    if draft.seats.iter().filter(|seat| seat.dealt_in).count() < 2 {
        return Err(skip(
            SkipReason::TooFewPlayers,
            "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
        ));
    }

    let mut text = draft_to_standard_text(draft)?;
    if let Some(tournament) = &header.tournament {
        let buy_in_unit = unit_for_symbol(currency_symbol_of(&tournament.buy_in_token)).unit();
        let [buy_in, _, fee] = parse_buy_in_token_js(&tournament.buy_in_token, &buy_in_unit);
        let buy_in = format_amount_js(buy_in, &buy_in_unit, DecimalStyle::Fixed2, false);
        let fee = format_amount_js(fee, &buy_in_unit, DecimalStyle::Fixed2, false);
        let stakes = format!(
            "{}/{}",
            format_amount_digits_js(
                draft.header_small_blind,
                &draft.unit,
                DecimalStyle::Fixed2,
                false
            ),
            format_amount_digits_js(
                draft.header_big_blind,
                &draft.unit,
                DecimalStyle::Fixed2,
                false
            )
        );
        let date = match draft.played_at.as_deref() {
            Some(iso) if !iso.is_empty() => format_header_date(iso),
            _ => String::new(),
        };
        // No `Level` clause: Unibet states blinds but never a level.
        let payload = format!(
            "Tournament #{}, {buy_in}+{fee} {} - ({stakes}) - {date}",
            tournament.id, draft.game_label
        );
        text = rewrite_first_line(&text, &payload);
    }

    let context = StandardContext {
        site_id: &draft.site_id,
        site_name: &draft.site_name,
        original_filename: ctx.source_filename,
        parser_id: Some(&draft.parser_id),
        parser_version: Some(&draft.parser_version),
        parsed_at: ctx.parsed_at(),
    };
    let mut hand = match parse_standard_hand(&text, &context) {
        Ok(Some(hand)) => hand,
        Ok(None) => {
            return Err(skip(
                SkipReason::NormalizedUnparseable,
                "The normalized text was not readable as a standard-format hand.",
            ));
        }
        Err(thrown) => return Err(ParseError::Bug(thrown.message)),
    };

    hand.meta.raw_text.clone_from(&draft.raw_text);
    let mut warnings = draft.warnings.clone();
    warnings.append(&mut hand.meta.warnings);
    hand.meta.warnings = warnings;
    hand.meta.hand_key.clone_from(&hand.meta.hand_id);
    if let Some(brand) = header.fast_fold {
        hand.table.fast_fold = Some(Some(brand.to_owned()));
    }
    if let (Some(tournament), Some(prize)) = (
        hand.tournament.as_mut(),
        header
            .tournament
            .as_ref()
            .and_then(|t| t.prize_token.as_deref()),
    ) {
        // `Total prize €4` is real money like the buy-in.
        tournament.prize_pool = Some(parse_amount(prize, &tournament.buy_in_unit));
    }
    Ok(hand)
}

/// What `crossCheck` is given.
struct Stated<'a> {
    pot: Option<JsNumber>,
    rake: Option<JsNumber>,
    uncalled: Option<&'a (String, JsNumber)>,
    /// `reported`: name -> `{ won, net }`, only `net` is read.
    reported: &'a [(String, (JsNumber, JsNumber))],
}

fn warning(code: &str, message: String) -> PhfWarning {
    PhfWarning {
        code: code.to_owned(),
        message,
        line: None,
    }
}

/// `crossCheck(hand, input)`: the room's own figures against the
/// reconstruction.
fn cross_check(hand: &mut PhfHand, stated: &Stated<'_>) {
    let one = JsNumber::from_i64(1);
    let n = JsNumber::from_i64;
    let mut found = Vec::new();
    let rake = n(hand.results.fees.rake);
    if let Some(stated_rake) = stated.rake
        && (stated_rake - rake).abs().greater_than(one)
    {
        found.push(warning(
            "rake-mismatch",
            format!(
                "The summary states a rake of {} but the reconstruction derives {}.",
                stated_rake.to_js_string(),
                rake.to_js_string()
            ),
        ));
    }

    if let Some(stated_pot) = stated.pot {
        // Unibet's `Total pot` is gross: it counts money returned uncalled.
        let returned = hand
            .actions
            .iter()
            .filter(|action| action.kind == ActionType::Uncalled)
            .fold(JsNumber::ZERO, |sum, action| sum - n(action.amount));
        let accounted = n(hand.results.total_pot) + returned;
        if (accounted - stated_pot).abs().greater_than(one) {
            found.push(warning(
                "pot-mismatch",
                format!(
                    "The summary states a pot of {} but the stream accounts for {}.",
                    stated_pot.to_js_string(),
                    accounted.to_js_string()
                ),
            ));
        }
    }

    let derived = hand
        .actions
        .iter()
        .find(|action| action.kind == ActionType::Uncalled)
        .map(|action| (action.player.clone(), -n(action.amount)));
    match (stated.uncalled, derived) {
        (Some((player, amount)), None) => found.push(warning(
            "uncalled-mismatch",
            format!(
                "The source returns {} to {player} but the betting stream leaves nothing \
                 uncalled.",
                amount.to_js_string()
            ),
        )),
        (Some((player, amount)), Some((derived_player, returned)))
            if derived_player != *player || (returned - *amount).abs().greater_than(one) =>
        {
            found.push(warning(
                "uncalled-mismatch",
                format!(
                    "The source returns {} to {player}; the stream returns {} to \
                     {derived_player}.",
                    amount.to_js_string(),
                    returned.to_js_string()
                ),
            ));
        }
        _ => {}
    }

    for result in &hand.results.players {
        let Some((_, (_, net))) = stated
            .reported
            .iter()
            .find(|(name, _)| *name == result.player)
        else {
            continue;
        };
        let reconstructed = n(result.net);
        if (*net - reconstructed).abs().greater_than(one) {
            found.push(warning(
                "net-result-mismatch",
                format!(
                    "{}: the summary states a net of {}, the reconstruction {}.",
                    result.player,
                    net.to_js_string(),
                    reconstructed.to_js_string()
                ),
            ));
        }
    }

    let fees = &hand.results.fees;
    let total = [
        fees.rake,
        fees.jackpot,
        fees.bingo,
        fees.fortune,
        fees.tax,
        fees.other,
    ]
    .into_iter()
    .fold(JsNumber::ZERO, |sum, fee| sum + n(fee));
    if total.less_than(JsNumber::ZERO) {
        found.push(warning(
            "negative-rake",
            "The derived rake is negative.".to_owned(),
        ));
    }
    hand.meta.warnings.append(&mut found);
}

/// `Map.set` on a list of pairs: a new key goes last, an old one keeps its
/// place.
fn map_set<V>(map: &mut Vec<(String, V)>, key: &str, value: V) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

/// `unibetParser.parseHand`.
#[allow(clippy::too_many_lines)]
fn parse_hand(raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    let source = js::trim(raw.strip_prefix('\u{FEFF}').unwrap_or(raw));
    refuse_lossy_text(source, "Unibet")?;

    if SUMMARY_FILE_HEADER.is_match(split_lines(source)[0]) {
        return Err(skip(
            SkipReason::TournamentSummary,
            "This is a Unibet tournament-summary record, not a hand history; there are no hands \
             in it to convert.",
        ));
    }

    // The session token goes before anything reads a name.
    let hero = hero_name(source);
    let stripped = HERO_TOKEN.replace_all(source, "");
    let lines = split_lines(&stripped);

    let Some(header) = read_header(lines[0]).map_err(ParseError::Bug)? else {
        return Err(skip(
            SkipReason::NoHeader,
            "The chunk does not open with a Unibet header line.",
        ));
    };
    if let Some(refusal) = unsupported_game_skip(&header.variant_word, &[])
        .or_else(|| unsupported_variant_skip(&header.variant_word, UNIBET_VARIANTS))
    {
        return Err(refusal.into());
    }
    if ctx.options.cash_only && header.tournament.is_some() {
        return Err(skip(
            SkipReason::TournamentInCashMode,
            "Tournament hand skipped.",
        ));
    }

    let mut warnings: Vec<PhfWarning> = Vec::new();
    let mut seats: Vec<DraftSeat> = Vec::new();
    let mut actions: Vec<DraftAction> = Vec::new();
    let mut collected: Vec<DraftCollect> = Vec::new();
    // `Map<string, string[]>`, in insertion order.
    let mut dealt: Vec<(String, Vec<String>)> = Vec::new();
    let mut shown: HashSet<String> = HashSet::new();
    let mut reported: Vec<(String, (JsNumber, JsNumber))> = Vec::new();

    let mut table_name = header.table_name.clone();
    let mut max_seats = JsNumber::ZERO;
    let mut button_seat: Option<JsNumber> = None;
    let mut street = DraftStreet::Preflop;
    let mut flop: Option<Vec<String>> = None;
    let mut turn: Option<String> = None;
    let mut river: Option<String> = None;
    let mut in_summary = false;
    let mut stated_pot: Option<JsNumber> = None;
    let mut stated_rake: Option<JsNumber> = None;
    let mut stated_uncalled: Option<(String, JsNumber)> = None;
    let mut big_blind = JsNumber::ZERO;

    // The seats and the unit first: the 2026 cash header's blinds carry no
    // symbol, only the stacks do.
    let mut seat_lines: Vec<SeatLine> = Vec::new();
    for line in &lines {
        let text = js::trim(line);
        let unmarked = SITTING_OUT.replacen(text, 1, "");
        if let Some(seat) = SEAT_LINE.captures(&unmarked)
            && !SUMMARY_SEAT_LINE.is_match(text)
        {
            seat_lines.push(SeatLine {
                seat: JsNumber::parse(group(&seat, 1)),
                name: js::trim(group(&seat, 2)).to_owned(),
                stack: group(&seat, 3).to_owned(),
            });
        }
    }
    if seat_lines.is_empty() {
        return Err(skip(
            SkipReason::NoPlayers,
            "The chunk has no `*** Seated players ***` block.",
        ));
    }

    // `chipsUnitFor` is asked about the hand body only.
    let body = lines[1..].join("\n");
    let unit = unit_for(&header, &seat_lines, &body, &mut warnings)?;
    let names = names_by_length(
        &seat_lines
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>(),
    );
    for entry in &seat_lines {
        seats.push(DraftSeat {
            seat: entry.seat,
            name: entry.name.clone(),
            starting_stack: strict_amount(&entry.stack, &unit, "a seat stack")?,
            dealt_in: false,
            is_hero: hero.as_deref() == Some(entry.name.as_str()),
            dealt_cards: Vec::new(),
        });
    }

    for (i, raw_line) in lines.iter().enumerate().skip(1) {
        let line = js::trim(raw_line);
        let line_no = line_number(i);
        if line.is_empty()
            || line == "=== HAND HISTORIES ==="
            || line == "=== TOURNAMENT SUMMARIES ==="
        {
            continue;
        }

        if let Some(section) = SECTION_LINE.captures(line) {
            let name = js::to_lower_case(group(&section, 1));
            // Turn and river repeat every earlier street: only the last
            // bracket is new.
            let last = BRACKETS
                .captures_iter(group(&section, 2))
                .last()
                .map_or(String::new(), |found| group(&found, 1).to_owned());
            let fresh = extract_cards(&last);
            match name.as_str() {
                "flop" => {
                    street = DraftStreet::Flop;
                    flop = Some(fresh);
                }
                "turn" => {
                    street = DraftStreet::Turn;
                    turn = fresh.into_iter().next();
                }
                "river" => {
                    street = DraftStreet::River;
                    river = fresh.into_iter().next();
                }
                "summary" => in_summary = true,
                _ => {}
            }
            continue;
        }

        if in_summary {
            if let Some(pot) = TOTAL_POT_LINE.captures(line) {
                stated_pot = Some(strict_amount(
                    group(&pot, 1),
                    &unit,
                    "the summary total pot",
                )?);
                stated_rake = match pot.get(2) {
                    None => None,
                    Some(rake) => Some(strict_amount(rake.as_str(), &unit, "the summary rake")?),
                };
                continue;
            }
            if let Some(seat) = SUMMARY_SEAT_LINE.captures(line) {
                let won = strict_amount(group(&seat, 4), &unit, "a summary seat line")?;
                let net = strict_amount(group(&seat, 5), &unit, "a summary seat line")?;
                map_set(&mut reported, js::trim(group(&seat, 2)), (won, net));
                continue;
            }
            warnings.push(PhfWarning {
                code: "unknown-line".to_owned(),
                message: line.to_owned(),
                line: line_no,
            });
            continue;
        }

        let unmarked = SITTING_OUT.replacen(line, 1, "");
        if let Some(seat) = SEAT_LINE.captures(&unmarked) {
            let number = JsNumber::parse(group(&seat, 1));
            if seat_lines
                .iter()
                .any(|entry| entry.seat.strict_equals(number))
            {
                continue; // already read in the seat pass
            }
        }

        if let Some(table) = TABLE_LINE.captures(line) {
            table_name = Some(group(&table, 1).to_owned());
            max_seats = JsNumber::parse(group(&table, 2));
            continue;
        }

        if let Some(dealt_to) = DEALT_TO.captures(line) {
            let name = js::trim(group(&dealt_to, 1));
            if names.iter().any(|known| known == name) {
                map_set(&mut dealt, name, extract_cards(group(&dealt_to, 2)));
                continue;
            }
        }
        if let Some(dealt_in) = DEALT_IN.captures(line) {
            let name = js::trim(group(&dealt_in, 1));
            if names.iter().any(|known| known == name) {
                map_set(&mut dealt, name, Vec::new());
                continue;
            }
        }

        if let Some(uncalled) = UNCALLED_LINE.captures(line) {
            let name = js::trim(group(&uncalled, 1));
            if names.iter().any(|known| known == name) {
                stated_uncalled = Some((
                    name.to_owned(),
                    strict_amount(group(&uncalled, 2), &unit, "an uncalled-bet line")?,
                ));
                continue;
            }
        }

        if let Some(hit) = leading_name(line, &names) {
            let mut action_ctx = ActionContext {
                player: hit.name,
                unit: &unit,
                big_blind,
                street,
                actions: &mut actions,
                collected: &mut collected,
                shown: &mut shown,
                warnings: &mut warnings,
                line: line_no,
            };
            match read_action(hit.rest, &mut action_ctx)? {
                Handled::Button => {
                    button_seat = seats
                        .iter()
                        .find(|entry| entry.name == hit.name)
                        .map(|entry| entry.seat);
                    continue;
                }
                Handled::BigBlind => {
                    let last = actions
                        .last()
                        .and_then(|action| action.amount)
                        .unwrap_or(JsNumber::ZERO);
                    big_blind = big_blind.max_of(last);
                    continue;
                }
                Handled::Refuse => {
                    return Err(skip(
                        SkipReason::Cashout,
                        "The hand contains an EV cash-out, which settles outside the pot and is \
                         not modelled for this room yet.",
                    ));
                }
                Handled::Yes => continue,
                Handled::No => {}
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
            "No `wins` line, so the source never says who was given the pot. Unibet omits the \
             winner on some preflop-fold hands and the pot cannot be assigned without guessing.",
        ));
    }

    // A `Dealt to` line for somebody other than the hero is a retroactive
    // reveal; with a `shows` line it is only cross-checked.
    for seat in &mut seats {
        let cards = dealt
            .iter()
            .find(|(name, _)| *name == seat.name)
            .map(|(_, cards)| cards.clone());
        seat.dealt_in = cards.is_some();
        let Some(cards) = cards.filter(|cards| !cards.is_empty()) else {
            continue;
        };
        if seat.is_hero {
            seat.dealt_cards = cards;
            continue;
        }
        if !shown.contains(&seat.name) {
            let mut muck = DraftAction::new(street, &seat.name, DraftKind::Muck);
            muck.cards = Some(cards);
            actions.push(muck);
        }
    }
    // Without a session token, exactly one known hand is the export's owner.
    if hero.as_deref().is_none_or(str::is_empty) {
        let known: Vec<&(String, Vec<String>)> = dealt
            .iter()
            .filter(|(_, cards)| !cards.is_empty())
            .collect();
        if let [(owner, cards)] = known.as_slice()
            && let Some(seat) = seats.iter_mut().find(|entry| entry.name == *owner)
        {
            seat.is_hero = true;
            seat.dealt_cards.clone_from(cards);
            if let Some(muck) = actions
                .iter()
                .position(|action| action.kind == DraftKind::Muck && action.player == seat.name)
            {
                actions.remove(muck);
            }
        }
    }
    for entry in &collected {
        if let Some(seat) = seats.iter_mut().find(|seat| seat.name == entry.player) {
            // The big blind of a walk is dealt in whether or not a `Dealt`
            // line said so.
            seat.dealt_in = true;
        }
    }

    if let Some(cards) = &flop
        && cards.len() != 3
    {
        return Err(skip(
            SkipReason::BoardSize,
            format!(
                "The flop marker lists {} readable cards, so the hand is corrupt.",
                cards.len()
            ),
        ));
    }

    let game_label = canonical_game_label(variant_of(&header.variant_word), header.limit, false);
    let header_small_blind = header_blind(&header.small_blind, &unit, "the header small blind")?;
    let header_big_blind = header_blind(&header.big_blind, &unit, "the header big blind")?;
    let max_seats = if max_seats.is_nan() || max_seats.strict_equals(JsNumber::ZERO) {
        fallback_max_seats(&seats)
    } else {
        max_seats
    };
    let draft = HandDraft {
        site_id: "unibet".to_owned(),
        site_name: "Unibet Poker".to_owned(),
        parser_id: "unibet".to_owned(),
        parser_version: UNIBET_PARSER_VERSION.to_owned(),
        hand_prefix: "UB-".to_owned(),
        hand_id: header.hand_id.clone(),
        game_label,
        unit,
        decimals: DecimalStyle::Fixed2,
        header_small_blind,
        header_big_blind,
        table_name,
        max_seats,
        button_seat,
        played_at: Some(header.played_at.clone()),
        seats,
        actions,
        flop,
        turn,
        river,
        collected,
        // A shove nobody called comes back inside `wins` unless the room
        // printed the return line.
        collected_includes_uncalled: stated_uncalled.is_none(),
        raw_text: source.to_owned(),
        warnings,
    };

    let mut hand = build_unibet_hand(&draft, &header, ctx)?;
    cross_check(
        &mut hand,
        &Stated {
            pot: stated_pot,
            rake: stated_rake,
            uncalled: stated_uncalled.as_ref(),
            reported: &reported,
        },
    );
    Ok(hand)
}

/// `unibetParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnibetParser;

impl SiteParser for UnibetParser {
    fn id(&self) -> &'static str {
        "unibet"
    }

    fn name(&self) -> &'static str {
        "Unibet Poker"
    }

    fn version(&self) -> &'static str {
        UNIBET_PARSER_VERSION
    }

    /// 0 for XML (Unibet's iPoker skin); 0.95 for either header at a line
    /// start; 0.9 for the tournament-summary export.
    fn detect(&self, text: &str) -> u32 {
        if XML_ROOT.is_match(text) {
            return 0;
        }
        if matches_at_line_start(&DETECT_MODERN, text) {
            return 950;
        }
        if matches_at_line_start(&DETECT_LEGACY, text) {
            return 950;
        }
        if matches_at_line_start(&DETECT_SUMMARY, text) {
            return 900;
        }
        0
    }

    /// A chunk per record start at a line start, a BOM and the edges
    /// trimmed, kept when it is a summary record or its first line a header
    /// (a header with an invalid date throws, as `readHeader` does).
    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        let mut chunks = Vec::new();
        for chunk in split_before_line_starts(text, &CHUNK_START) {
            let chunk = js::trim(chunk.strip_prefix('\u{FEFF}').unwrap_or(chunk));
            let keep = SUMMARY_FILE_HEADER.is_match(chunk)
                || read_header(split_lines(chunk)[0])
                    .map_err(SplitError)?
                    .is_some();
            if keep {
                chunks.push(chunk.to_owned());
            }
        }
        Ok(chunks)
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        parse_hand(raw, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../frontend/src/lib/parsers/unibet.ts");

    #[test]
    fn patterns_and_messages_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/^Game\s+#(\d+):\s+Table\s+(\S+)\s+(PL|NL|FL)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)\s+-\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$/;",
            r"/^Unibet\s+Hand\s+#(\d+)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)\s+-\s+(?:UTC\s+)?(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$/;",
            r"/^Unibet\s+Hand\s+#(\d+),\s+Tournament\s+#(\S+?),\s+(\S+)\s+\+\s+(\S+)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)(?:\s+-\s+Total\s+prize\s+(\S+))?\s+-\s+(?:UTC\s+)?(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$/;",
            r"const SUMMARY_FILE_HEADER = /^Unibet\s+Tournament\s+#(\S+?),/;",
            r"const CHUNK_START = /(?=^(?:Unibet\s+(?:Hand|Tournament)\s+#|Game\s+#\d+:\s+Table\s))/m;",
            r#"const TABLE_LINE = /^Table\s+"([^"]*)"\s+(\d+)-max\s*$/;"#,
            r"const SEAT_LINE = /^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)$/;",
            r"const SECTION_LINE = /^\*\*\*\s*(.+?)\s*\*\*\*(.*)$/;",
            r"/^Seat\s+(\d+):\s+(.+):\s+bet\s+(\S+)\s+and\s+won\s+(\S+),\s+net\s+result:\s+(\S+)\s*$/;",
            r"const TOTAL_POT_LINE = /^Total\s+pot\s+(\S+)(?:\s+Rake\s+(\S+))?\s*$/;",
            r"const UNCALLED_LINE = /^Uncalled\s+bet\s+returned\s+to\s+(.+):\s+(\S+)\s*$/;",
            r"const HERO_TOKEN = /\[Unibet_[0-9a-fA-F]+\]/g;",
            r"const HERO_SEAT = /^Seat\s+\d+:\s+(.+?)\[Unibet_[0-9a-fA-F]+\]\s+\(/m;",
            r"if (/<\s*(?:session|game|description)\b/i.test(text)) {",
            r"if (/^Unibet\s+Hand\s+#\d+(?:,\s+Tournament\s+#|\s+-\s)/m.test(text)) {",
            r"if (/^Game\s+#\d+:\s+Table\s+\S+\s+(?:PL|NL|FL)\s+-\s+[\d.,]+\/[\d.,]+\s+-\s/m.test(text)) {",
            r"if (/^Unibet\s+Tournament\s+#\S+,/m.test(text)) {",
            "return 0.9;",
            r#"text.replace(/\s*\(sitting out\)\s*$/i, "")"#,
            r#"line.replace(/\s*\(sitting out\)\s*$/i, "")"#,
            r"section[2].matchAll(/\[([^\]]*)\]/g)",
            r"line.match(/^Dealt\s+to\s+(.+)\s+\[([^\]]*)\]\s*$/)",
            r"line.match(/^Dealt\s+in\s+(.+)\s*$/)",
            r"text.replace(/^(Poker Hand #\S+:).*$/m, `$1 ${payload}`)",
            r"`${y}-${mo}-${d}T${h.padStart(2, ",
            r"if (/\bpot\s+limit\b/i.test(label)) {",
            r"if (/\b(?:fixed\s+limit|limit)\b/i.test(label) && !/\bno\s+limit\b/i.test(label)) {",
            r"return /\bbanzai\b/i.test(gameLabel) ? ",
            r"token.trim().match(/^(\d+)\.0+$/)",
            r#"rest.replace(/\s+\((?:timed out|disconnect(?:ed)?|time out)\)\s*$/i, "")"#,
            r"body.match(/,\s*and\s+is\s+all-in\s*$/i)",
            r"/^has the button$/i.test(body)",
            r"/^(?:is\s+)?sitting out$/i.test(body) || /^sits out$/i.test(body)",
            r"/^posts\s+(small blind|big blind|small & big blinds|button blind|straddle|the ante?)\s+(\S+)$/i,",
            r"/^folds$/i.test(body)",
            r"/^checks$/i.test(body)",
            r"body.match(/^calls\s+(\S+)$/i)",
            r"body.match(/^bets\s+(\S+)$/i)",
            r"body.match(/^raises\s+\S+\s+to\s+(\S+)$/i)",
            r"body.match(/^shows\s+\[([^\]]*)\](?:,\s*(.*))?$/i)",
            r"body.match(/^(?:mucks|does not show(?: cards)?|doesn't show(?: hand)?)(?:\s+\[([^\]]*)\])?$/i)",
            r"body.match(/^wins\s+(main|side)\s+pot(?:\s+#\d+)?,\s+(\S+)$/i)",
            r"body.match(/^wins\s+(\S+)(?:\s+from\s+(main|side)\s+pot(?:\s+#\d+)?)?$/i)",
            r"/^cashed out the hand for\b/i.test(body)",
            r"/^wins\s+(?:the\s+)?\S+\s+(?:bounty\s+)?for eliminating\b/i.test(body) ||",
            r"/^wins the tournament and receives\b/i.test(body) ||",
            r"/^finished the tournament in\b/i.test(body)",
            "[2, 3, 4, 6, 9, 10]",
            "const VERSION = \"1.0.0\";",
            "handPrefix: \"UB-\",",
            "refuseLossyText(source, \"Unibet\");",
            "line === \"=== HAND HISTORIES ===\" || line === \"=== TOURNAMENT SUMMARIES ===\"",
            "\"This is a Unibet tournament-summary record, not a hand history; there are \" +",
            "\"no hands in it to convert.\",",
            "\"The chunk does not open with a Unibet header line.\"",
            "throw new ParseSkip(\"tournament-in-cash-mode\", \"Tournament hand skipped.\");",
            "\"The chunk has no `*** Seated players ***` block.\"",
            "\"The hand contains an EV cash-out, which settles outside the pot and \" +",
            "\"is not modelled for this room yet.\",",
            "\"No `wins` line, so the source never says who was given the pot. Unibet \" +",
            "\"omits the winner on some preflop-fold hands and the pot cannot be \" +",
            "\"assigned without guessing.\",",
            "`The flop marker lists ${flop.length} readable cards, so the hand is corrupt.`,",
            "\"Fewer than two seats were dealt in, so the hand cannot be reconstructed.\",",
            "\"The normalized text was not readable as a standard-format hand.\",",
            "`Tournament #${header.tournament.id}, ${buyIn}+${fee} ${draft.gameLabel} - ` +",
            "`(${stakes}) - ${date}`;",
            "ctx.warn(\"unconfirmed-line\", `Ante written as \"posts the ant\": ${body}`);",
            "ctx.warn(\"unconfirmed-line\", `Combined blind post read as ${live} live: ${body}`);",
            "ctx.warn(\"unconfirmed-line\", `Posting shape read as a live post: ${body}`);",
            "`Bounty or placing payment recorded in the raw text only: ${ctx.player} ${body}`,",
            "`The summary states a rake of ${input.statedRake} but the reconstruction ` +",
            "`derives ${hand.results.fees.rake}.`,",
            "`The summary states a pot of ${input.statedPot} but the stream accounts ` +",
            "`for ${hand.results.totalPot + returned}.`,",
            "`The source returns ${input.statedUncalled.amount} to ${input.statedUncalled.player} ` +",
            "\"but the betting stream leaves nothing uncalled.\",",
            "`The source returns ${input.statedUncalled.amount} to ${input.statedUncalled.player}; ` +",
            "`the stream returns ${-derived.amount} to ${derived.player}.`,",
            "`${result.player}: the summary states a net of ${stated.net}, the ` +",
            "`reconstruction ${result.net}.`,",
            "warn(\"negative-rake\", \"The derived rake is negative.\");",
            "\"No seat stack carries a currency symbol and the header is not a \" +",
            "\"tournament header, so the amounts cannot be read as either cash or chips.\",",
            "message: `Tournament stacks carry the symbol \"${symbol}\"; read as chips anyway.`,",
            "\"a seat stack\"",
            "\"the summary total pot\"",
            "\"the summary rake\"",
            "\"a summary seat line\"",
            "\"an uncalled-bet line\"",
            "\"a posting line\"",
            "\"a call\"",
            "\"a bet\"",
            "\"a raise\"",
            "\"a side-pot win line\"",
            "\"a win line\"",
            "\"the header small blind\"",
            "\"the header big blind\"",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    /// `String.prototype.replace`'s `$` patterns, recorded from Node:
    /// `"ab".replace(/(a)/, template)`.
    #[test]
    fn replacement_patterns_expand_as_in_javascript() {
        let expand = |template: &str| get_substitution("a", "", "b", &[Some("a")], template);
        for (template, expected) in [
            ("$1", "a"),
            ("$01", "a"),
            ("$10", "a0"),
            ("$2", "$2"),
            ("$0", "$0"),
            ("$00", "$00"),
            ("$$", "$"),
            ("$&", "a"),
            ("$`", ""),
            ("$'", "b"),
            ("$<x>", "$<x>"),
            ("$", "$"),
            ("x$", "x$"),
            ("$1.00+$0.07", "a.00+$0.07"),
            ("$99", "$99"),
            ("$19", "a9"),
        ] {
            assert_eq!(expand(template), expected, "{template:?}");
        }
    }

    #[test]
    fn limits_and_brands() {
        assert_eq!(limit_from_label("Pot Limit Omaha", None), LimitType::Pl);
        assert_eq!(limit_from_label("Limit Hold'Em", None), LimitType::Fl);
        assert_eq!(limit_from_label("No Limit Hold'Em", None), LimitType::Nl);
        assert_eq!(limit_from_label("x", Some("FL")), LimitType::Fl);
        assert_eq!(fast_fold_of("No Limit Hold'Em Banzai"), Some("Banzai"));
        assert_eq!(fast_fold_of("No Limit Hold'Em Banzais"), None);
    }
}
