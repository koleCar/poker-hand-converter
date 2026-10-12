//! PHF → standard text: `toStandardText`, `toStandardTextFile` and the
//! presentation rules of `resolveTextStyle`.
//!
//! JavaScript-isms kept, because they are in the bytes:
//!
//! - truthiness: a runout's `flop: []` is a flop (an empty array is truthy),
//!   `turn: ""` is not; an empty `potName`, `description` or tournament name
//!   is kept where the TypeScript writes `x ?? y` and dropped where it writes
//!   `x ? … : …`;
//! - a missing array element in a template prints `undefined` (a TURN marker
//!   whose runout resolves to fewer than four cards);
//! - `RUN_PREFIXES[i]` past the fourth runout is `undefined`, which prints no
//!   prefix; `RUN_WORDS[n]` past four is `"n times"`;
//! - a fee column named after an `Object.prototype` member (`toString`,
//!   `constructor`, …) reads a function off the plain object, and the amount
//!   prints as `NaN`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::date::format_played_at;
use super::read::parse_header;
use super::{
    HEADER, RUN_PREFIXES, find_at_line_start, first_line, has_board_label_line, js_lines,
    line_starts, strip_bom,
};
use crate::js;
use crate::phf::money::{format_amount, format_amount_digits};
use crate::phf::{
    ActionType, Amount, ChipMovementAnchor, CurrencyUnit, DecimalStyle, PhfAction, PhfHand,
    PhfPlayer, PhfPlayerResult, PhfRunout, PotHalf, SeatOutcome, Street, Variant, is_button_blind,
    resolve_runout,
};

/// `RUN_WORDS`: `Hand was run <word>`.
const RUN_WORDS: [&str; 5] = ["", "once", "two times", "three times", "four times"];

/// `DEFAULT_FEE_COLUMNS`.
const DEFAULT_FEE_COLUMNS: [&str; 5] = ["Rake", "Jackpot", "Bingo", "Fortune", "Tax"];

/// The own-property-less names a plain object literal still answers:
/// `Object.prototype`'s members (`byName[name] ?? 0` finds them).
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

static TOTAL_POT_LINE: LazyLock<Regex> = crate::js_regex_lazy!(r"^Total pot\s+.*", "");
static FEE_COLUMN: LazyLock<Regex> = crate::js_regex_lazy!(r"^([A-Za-z][A-Za-z ]*?)\s+\S+$", "");
static TOURNAMENT_CLAUSE: LazyLock<Regex> = crate::js_regex_lazy!(r":\s*(Tournament\b.*)$", "");
static SHOW_DOWN: LazyLock<Regex> =
    crate::js_regex_lazy!(r"\*\*\*\s*(?:FIRST |SECOND |THIRD )?SHOW DOWN\s*\*\*\*", "");
static PAREN_NAME: LazyLock<Regex> = crate::js_regex_lazy!(r"^Tournament\s*\(", "");
static LEVEL_SPACE: LazyLock<Regex> = crate::js_regex_lazy!(r"Level\s*\S+?\s\(", "");
static LEVEL: LazyLock<Regex> = crate::js_regex_lazy!(r"Level", "");
static FLOP_GAP: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^\*\*\* (?:FIRST |SECOND |THIRD )?FLOP \*\*\* {2}\[", "");
static DIGITS: LazyLock<Regex> = crate::js_regex_lazy!(r"^\d+$", "");
static WHITESPACE_END: LazyLock<Regex> = crate::js_regex_lazy!(r"\s$", "");

/// The writer's patterns as written in `serialize.ts` (the `m`-flag ones are
/// matched line by line above, so their source text differs from the
/// compiled one), for the test that holds them to the source.
#[cfg(test)]
pub(super) const SOURCE_PATTERNS: &[&str] = &[
    r"^Dealt to (?!.*\[).*$",
    r"\s$",
    r"^Total pot\s+.*$",
    r"^([A-Za-z][A-Za-z ]*?)\s+\S+$",
    r"\d,\d{3}(?!\d)",
    r":\s*(Tournament\b.*)$",
    r"\*\*\*\s*(?:FIRST |SECOND |THIRD )?SHOW DOWN\s*\*\*\*",
    r"^Tournament\s*\(",
    r"Level\s*\S+?\s\(",
    r"^\*\*\* (?:FIRST |SECOND |THIRD )?FLOP \*\*\* {2}\[",
    r"^\d+$",
];

/// `SerializeOptions`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SerializeOptions {
    /// Regenerate summary seat lines from structured data instead of
    /// replaying the captured `raw` line. Only tests use it.
    pub regenerate_summary: bool,
}

/// `ResolvedStyle`: every presentational decision, made.
#[derive(Debug, Clone)]
struct ResolvedStyle {
    decimals: DecimalStyle,
    group_thousands: bool,
    dealt_line_trailing_space: bool,
    summary_fee_columns: Vec<String>,
    /// Verbatim header text to replay, or `None` to generate one.
    header_payload: Option<String>,
    /// `SHOWDOWN` or the spaced `SHOW DOWN` some builds emit.
    showdown_token: &'static str,
    inline_tournament_name: bool,
    level_paren_space: bool,
    /// `FIRST` on a line of its own above `Board [..]`.
    board_label_own_line: bool,
    flop_marker_gap: &'static str,
}

/// `inferGroupThousands`: a `\d,\d{3}(?!\d)` below the header line.
fn infer_group_thousands(source: &str) -> bool {
    // `source.slice(source.indexOf("\n") + 1)`: the whole text without a `\n`.
    let body = source.split_once('\n').map_or(source, |(_, rest)| rest);
    let chars: Vec<char> = body.chars().collect();
    let digit = |i: usize| chars.get(i).is_some_and(char::is_ascii_digit);
    (0..chars.len()).any(|i| {
        digit(i)
            && chars.get(i + 1) == Some(&',')
            && digit(i + 2)
            && digit(i + 3)
            && digit(i + 4)
            && !digit(i + 5)
    })
}

/// `inferDealtLineTrailingSpace`: the first `BLANK_DEALT_LINE`
/// (`/^Dealt to (?!.*\[).*$/m`: a `Dealt to ` line with no `[`) ends in
/// whitespace; `true` when there is none.
fn infer_dealt_line_trailing_space(source: &str) -> bool {
    js_lines(source)
        .find(|line| line.starts_with("Dealt to ") && !line.contains('['))
        .is_none_or(|line| WHITESPACE_END.is_match(line))
}

/// `inferFeeColumns`.
fn infer_fee_columns(source: &str) -> Vec<String> {
    let defaults = || {
        DEFAULT_FEE_COLUMNS
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    };
    let Some(line) = find_at_line_start(&TOTAL_POT_LINE, source) else {
        return defaults();
    };
    if !line.contains('|') {
        // GG tournaments print a bare `Total pot 588`: no columns.
        return Vec::new();
    }
    let columns: Vec<String> = line
        .split('|')
        .skip(1)
        .filter_map(|part| FEE_COLUMN.captures(js::trim(part)).map(|c| c[1].to_owned()))
        .collect();
    if columns.is_empty() {
        defaults()
    } else {
        columns
    }
}

/// `sourcePreservesDialect`: the source's header carries this hand's id, so
/// the parser kept the source's dialect.
fn source_preserves_dialect(hand: &PhfHand) -> bool {
    HEADER
        .captures(first_line(strip_bom(&hand.meta.raw_text)))
        .is_some_and(|c| c[1] == hand.meta.hand_id)
}

/// `capturedHeaderPayload`: the source's header text, when it demonstrably
/// belongs to this hand.
fn captured_header_payload(hand: &PhfHand) -> Option<String> {
    if let Some(pinned) = &hand.meta.text_style.header_payload {
        return Some(pinned.clone());
    }
    let first = first_line(strip_bom(&hand.meta.raw_text));
    let c = HEADER.captures(first)?;
    if c[1] != hand.meta.hand_id {
        return None;
    }
    let payload = c.get(2).map_or("", |m| m.as_str());

    let reread = parse_header(&hand.meta.hand_id, payload, payload);
    if reread.tournament.is_none() != hand.tournament.is_none() {
        return None;
    }
    if reread.small_blind != hand.game.small_blind
        || reread.big_blind != hand.game.big_blind
        || reread.played_at != hand.played_at
        || reread.game_label != hand.game.label
    {
        return None;
    }
    if let (Some(tour), Some(again)) = (&hand.tournament, &reread.tournament)
        && (again.id != tour.id
            || again.level_small_blind != tour.level_small_blind
            || again.level_big_blind != tour.level_big_blind)
    {
        return None;
    }
    Some(payload.to_owned())
}

/// `resolveTextStyle`.
fn resolve_text_style(hand: &PhfHand) -> ResolvedStyle {
    let style = &hand.meta.text_style;
    let source = if source_preserves_dialect(hand) {
        hand.meta.raw_text.as_str()
    } else {
        ""
    };
    let header_payload = captured_header_payload(hand);
    let source_header = first_line(source);
    let tournament_clause = TOURNAMENT_CLAUSE
        .captures(source_header)
        .and_then(|c| c.get(1))
        .map_or("", |m| m.as_str());
    ResolvedStyle {
        decimals: style.decimals,
        group_thousands: style
            .group_thousands
            .unwrap_or_else(|| infer_group_thousands(source)),
        dealt_line_trailing_space: style
            .dealt_line_trailing_space
            .unwrap_or_else(|| infer_dealt_line_trailing_space(source)),
        summary_fee_columns: style
            .summary_fee_columns
            .clone()
            .unwrap_or_else(|| infer_fee_columns(source)),
        header_payload,
        showdown_token: if SHOW_DOWN.is_match(source) {
            "SHOW DOWN"
        } else {
            "SHOWDOWN"
        },
        inline_tournament_name: !tournament_clause.is_empty()
            && !PAREN_NAME.is_match(tournament_clause),
        level_paren_space: LEVEL_SPACE.is_match(tournament_clause)
            || !LEVEL.is_match(tournament_clause),
        board_label_own_line: has_board_label_line(source),
        flop_marker_gap: if line_starts(source).any(|start| FLOP_GAP.is_match(&source[start..])) {
            "  "
        } else {
            " "
        },
    }
}

/// `formatAmount(amount, unit, decimals, groupThousands)`.
fn money(amount: Amount, unit: &CurrencyUnit, style: &ResolvedStyle) -> String {
    format_amount(amount, unit, style.decimals, style.group_thousands)
}

/// `numberToRoman`.
fn number_to_roman(value: u32) -> String {
    const TABLE: [(u32, &str); 13] = [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut left = value;
    let mut out = String::new();
    for (amount, letters) in TABLE {
        while left >= amount {
            out.push_str(letters);
            left -= amount;
        }
    }
    out
}

/// `headerPayload`: the generated header text after `Poker Hand #<id>: `.
fn header_payload(hand: &PhfHand, style: &ResolvedStyle) -> String {
    let unit = &hand.game.unit;
    let date = format_played_at(hand.played_at.as_deref(), hand.meta.text_style.pad_hour);

    if let Some(tour) = &hand.tournament {
        let buy_in_money = |amount: Amount| money(amount, &tour.buy_in_unit, style);
        // `$4.50+$4.50+$1` knockout, `$15+$1.50` plain, `$55` alone; never an
        // invented `+$0`.
        let bounty = tour.bounty.unwrap_or(0);
        let mut parts = vec![buy_in_money(tour.buy_in)];
        if bounty != 0 {
            parts.push(buy_in_money(bounty));
        }
        if tour.fee != 0 || bounty != 0 {
            parts.push(buy_in_money(tour.fee));
        }
        let buy_in_token = parts.join("+");

        let printed_level = tour
            .level_label
            .clone()
            .or_else(|| tour.level_number.map(number_to_roman));
        let level = printed_level.map_or_else(String::new, |printed| {
            format!(
                "Level{}{printed}{}",
                if DIGITS.is_match(&printed) { "" } else { " " },
                if style.level_paren_space { " " } else { "" }
            )
        });
        let digits = |amount: Amount| {
            format_amount_digits(amount, unit, style.decimals, style.group_thousands)
        };
        let stakes = format!(
            "({}/{})",
            digits(tour.level_small_blind),
            digits(tour.level_big_blind)
        );

        if !style.inline_tournament_name {
            let name = match tour.name.as_deref() {
                Some(name) if !name.is_empty() => format!("({name})"),
                _ => String::new(),
            };
            return format!(
                "Tournament {name}#{}, {buy_in_token} {} - {level}{stakes} - {date}",
                tour.id, hand.game.label
            );
        }
        // Inline: GG writes the name, buy-in text and all, between the id and
        // the game label.
        let lead = tour.name.as_deref().unwrap_or(&buy_in_token);
        return format!(
            "Tournament #{}, {lead} {} - {level}{stakes} - {date}",
            tour.id, hand.game.label
        );
    }

    // GG's ante-only short deck prints one stake, `ShortDeck No Limit ($0.02)`.
    let stakes = if hand.game.variant == Variant::Shortdeck && hand.game.small_blind == 0 {
        money(hand.game.big_blind, unit, style)
    } else {
        format!(
            "{}/{}",
            money(hand.game.small_blind, unit, style),
            money(hand.game.big_blind, unit, style)
        )
    };
    format!("{} ({stakes}) - {date}", hand.game.label)
}

/// `sameCardSet`.
fn same_card_set(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut left = a.to_vec();
    let mut right = b.to_vec();
    // `Array.prototype.sort` without a comparator: UTF-16 code unit order,
    // which for card codes (ASCII) is byte order.
    left.sort();
    right.sort();
    left == right
}

/// `markerPrefixOrder`: the order a TURN or RIVER marker re-lists the board
/// in - the summary's order when it is a reordering of the same flop.
fn marker_prefix_order(runout: &PhfRunout, resolved: &[String]) -> Vec<String> {
    let Some(summary) = &runout.summary_cards else {
        return resolved.to_vec();
    };
    if summary.len() != resolved.len() || summary.len() < 3 {
        return resolved.to_vec();
    }
    if !same_card_set(&summary[..3], &resolved[..3]) {
        return resolved.to_vec();
    }
    summary.clone()
}

/// `tableLine`.
fn table_line(hand: &PhfHand) -> String {
    let button = hand
        .table
        .button_seat
        .map_or_else(String::new, |seat| format!(" Seat #{seat} is the button"));
    format!(
        "Table '{}' {}-max{button}",
        hand.table.name.as_deref().unwrap_or(""),
        hand.table.max_seats
    )
}

/// `arr[i]` in a template literal: the element, or `undefined`.
fn element(items: &[String], i: usize) -> &str {
    items.get(i).map_or("undefined", String::as_str)
}

/// `arr.slice(0, n).join(" ")`.
fn joined(items: &[String], n: usize) -> String {
    items[..n.min(items.len())].join(" ")
}

/// `actionLine(action, unit, style, currentBet)`.
fn action_line(
    action: &PhfAction,
    unit: &CurrencyUnit,
    style: &ResolvedStyle,
    current_bet: Amount,
) -> String {
    let money = |amount: Amount| money(amount.saturating_abs(), unit, style);
    let all_in = if action.all_in { " and is all-in" } else { "" };
    let player = &action.player;
    match action.kind {
        ActionType::Ante => format!("{player}: posts the ante {}{all_in}", money(action.amount)),
        ActionType::SmallBlind => {
            format!(
                "{player}: posts small blind {}{all_in}",
                money(action.amount)
            )
        }
        ActionType::BigBlind => {
            let verb = if is_button_blind(action) {
                crate::phf::BUTTON_BLIND_VERB
            } else {
                "posts big blind"
            };
            format!("{player}: {verb} {}{all_in}", money(action.amount))
        }
        ActionType::MissedBlind => {
            format!("{player}: posts missed blind {}", money(action.amount))
        }
        ActionType::Straddle => {
            // GG's bare verb states the street total.
            let printed = if action.verb.as_deref() == Some("straddle") {
                action.street_total
            } else {
                action.amount
            };
            format!(
                "{player}: {} {}{all_in}",
                action.verb.as_deref().unwrap_or("posts"),
                money(printed)
            )
        }
        ActionType::Post | ActionType::BombAnte => format!(
            "{player}: {} {}{all_in}",
            action.verb.as_deref().unwrap_or("posts"),
            money(action.amount)
        ),
        ActionType::Fold => format!("{player}: folds"),
        ActionType::Check => format!("{player}: checks"),
        ActionType::Call => format!("{player}: calls {}{all_in}", money(action.amount)),
        ActionType::Bet => format!("{player}: bets {}{all_in}", money(action.amount)),
        ActionType::Raise => format!(
            "{player}: raises {} to {}{all_in}",
            money(action.street_total.saturating_sub(current_bet)),
            money(action.street_total)
        ),
        ActionType::Uncalled => {
            format!(
                "Uncalled bet ({}) returned to {player}",
                money(action.amount)
            )
        }
        ActionType::Collect => format!(
            "{player} collected {} from {}",
            money(action.amount),
            action.pot_name.as_deref().unwrap_or("pot")
        ),
        ActionType::Show => {
            let cards = action.cards.as_deref().unwrap_or_default().join(" ");
            let description = match action.description.as_deref() {
                Some(d) if !d.is_empty() => format!(" ({d})"),
                _ => String::new(),
            };
            format!("{player}: shows [{cards}]{description}")
        }
        ActionType::Muck => format!(
            "{player}: {}",
            action.description.as_deref().unwrap_or("doesn't show hand")
        ),
        ActionType::CashoutChoose => format!("{player}: Chooses to EV Cashout"),
        ActionType::CashoutPay => {
            let printed = action.description.clone().unwrap_or_else(|| money(0));
            format!("{player}: Pays Cashout Risk ({printed})")
        }
    }
}

/// `summaryPotLine`.
fn summary_pot_line(hand: &PhfHand, style: &ResolvedStyle) -> String {
    let unit = &hand.game.unit;
    let fees = &hand.results.fees;
    // "Total pot $103.11 Main pot $37.15. Side pot $65.96."
    let breakdown: String = hand
        .results
        .pots
        .iter()
        .map(|pot| format!(" {} pot {}.", pot.name, money(pot.amount, unit, style)))
        .collect();
    let columns: String = style
        .summary_fee_columns
        .iter()
        .map(|name| {
            let amount = match name.as_str() {
                "Rake" => Some(fees.rake),
                "Jackpot" => Some(fees.jackpot),
                "Bingo" => Some(fees.bingo),
                "Fortune" => Some(fees.fortune),
                "Tax" => Some(fees.tax),
                other if OBJECT_PROTOTYPE.contains(&other) => None,
                _ => Some(0),
            };
            // `formatAmount(<a function>)`: `Math.abs` of it is NaN.
            let printed = amount.map_or_else(
                || format!("{}NaN", unit.symbol),
                |amount| money(amount, unit, style),
            );
            format!(" | {name} {printed}")
        })
        .collect();
    format!(
        "Total pot {}{breakdown}{columns}",
        money(hand.results.total_pot, unit, style)
    )
}

/// `boardLines`.
fn board_lines(hand: &PhfHand, style: &ResolvedStyle) -> Vec<String> {
    let runouts = &hand.board.runouts;
    if runouts.len() == 1 {
        let cards = runouts[0]
            .summary_cards
            .clone()
            .unwrap_or_else(|| resolve_runout(&hand.board, 0));
        return if cards.is_empty() {
            Vec::new()
        } else {
            vec![format!("Board [{}]", cards.join(" "))]
        };
    }
    let mut out = Vec::new();
    // `RUN_PREFIXES[i]` is `undefined` past the fourth runout: a template
    // prints that as `undefined`, `lines.join` as an empty line.
    let mut board = |label: Option<&str>, cards: &[String]| {
        if style.board_label_own_line {
            out.push(label.unwrap_or_default().to_owned());
            out.push(format!("Board [{}]", cards.join(" ")));
        } else {
            out.push(format!(
                "{} Board [{}]",
                label.unwrap_or("undefined"),
                cards.join(" ")
            ));
        }
    };
    for (i, run) in runouts.iter().enumerate() {
        let label = RUN_PREFIXES.get(i).copied();
        if let Some(summary) = &run.summary_cards {
            board(label, summary);
            continue;
        }
        if i == 0 {
            board(label, &resolve_runout(&hand.board, 0));
            continue;
        }
        // Later runouts list only the cards that differ. A missing card is
        // `undefined` in the array, which `join` prints as nothing.
        let resolved = resolve_runout(&hand.board, i);
        let mut cards: Vec<String> = Vec::new();
        if run.flop.is_some() {
            cards.extend(resolved.iter().take(3).cloned());
        }
        if run.turn.as_deref().is_some_and(|t| !t.is_empty()) {
            cards.push(resolved.get(3).cloned().unwrap_or_default());
        }
        if run.river.as_deref().is_some_and(|r| !r.is_empty()) {
            cards.push(resolved.get(4).cloned().unwrap_or_default());
        }
        board(label, &cards);
    }
    out
}

/// `capitalize`.
fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// `generateSummarySeatLine`: the summary line for a seat without `raw`.
fn generate_summary_seat_line(
    hand: &PhfHand,
    player: &PhfPlayer,
    result: &PhfPlayerResult,
    style: &ResolvedStyle,
) -> Option<String> {
    let unit = &hand.game.unit;
    let labels = if result.position_labels.is_empty() {
        String::new()
    } else {
        format!(" {}", result.position_labels.join(" "))
    };
    let head = format!("Seat {}: {}{labels}", player.seat, player.name);
    let shown = result.shown_cards.join(" ");
    let with = match result.hand_description.as_deref() {
        Some(d) if !d.is_empty() => format!(" with {d}"),
        _ => String::new(),
    };
    Some(match result.outcome {
        SeatOutcome::Folded => {
            let street_name = |s: Street| match s {
                Street::Preflop => "preflop",
                Street::Flop => "flop",
                Street::Turn => "turn",
                Street::River => "river",
                Street::Showdown => "showdown",
            };
            let where_ = match result.folded_street {
                None | Some(Street::Preflop) => "folded before Flop".to_owned(),
                Some(street) => format!("folded on the {}", capitalize(street_name(street))),
            };
            let didnt = if result.didnt_bet {
                " (didn't bet)"
            } else {
                ""
            };
            format!("{head} {where_}{didnt}")
        }
        SeatOutcome::Mucked => format!("{head} mucked"),
        SeatOutcome::Collected => {
            format!("{head} collected ({})", money(result.won, unit, style))
        }
        SeatOutcome::Won if !result.shown_cards.is_empty() => format!(
            "{head} showed [{shown}] and won ({}){with}",
            money(result.won, unit, style)
        ),
        SeatOutcome::Won => format!("{head} won ({})", money(result.won, unit, style)),
        SeatOutcome::Lost => format!("{head} showed [{shown}] and lost{with}"),
        SeatOutcome::Showed => format!("{head} showed [{shown}]"),
        SeatOutcome::Unknown => {
            if result.won > 0 {
                format!("{head} collected ({})", money(result.won, unit, style))
            } else {
                return None;
            }
        }
    })
}

/// `wentAllHigh`: a hi/lo showdown block whose every award went high.
fn went_all_high(hand: &PhfHand, runout_index: Option<u32>) -> bool {
    let collects: Vec<&PhfAction> = hand
        .actions
        .iter()
        .filter(|a| {
            a.kind == ActionType::Collect
                && a.street == Street::Showdown
                && runout_index.is_none_or(|i| a.runout_index == i)
        })
        .collect();
    !collects.is_empty() && collects.iter().all(|a| a.half == Some(PotHalf::Hi))
}

/// `players` sorted by seat (a stable sort, as `Array.prototype.sort`).
fn by_seat(hand: &PhfHand) -> Vec<&PhfPlayer> {
    let mut players: Vec<&PhfPlayer> = hand.players.iter().collect();
    players.sort_by_key(|p| p.seat);
    players
}

/// `toStandardText(hand)`: the hand as standard text, no trailing newline.
pub fn to_standard_text(hand: &PhfHand) -> String {
    to_standard_text_with(hand, SerializeOptions::default())
}

/// `toStandardText(hand, options)`.
#[allow(clippy::too_many_lines)]
pub fn to_standard_text_with(hand: &PhfHand, options: SerializeOptions) -> String {
    let unit = &hand.game.unit;
    let style = resolve_text_style(hand);
    let text_style = &hand.meta.text_style;
    let mut lines: Vec<String> = Vec::new();

    // `raises X to Y` prints X over the current bet, so rendering tracks the
    // betting state of the street.
    let mut current_bet: Amount = 0;
    let render = |action: &PhfAction, current_bet: &mut Amount| -> String {
        let line = action_line(action, unit, &style, *current_bet);
        match action.kind {
            ActionType::Bet | ActionType::Raise => *current_bet = action.street_total,
            ActionType::SmallBlind
            | ActionType::BigBlind
            | ActionType::Straddle
            | ActionType::Post => *current_bet = (*current_bet).max(action.street_total),
            _ => {}
        }
        line
    };

    let header = style
        .header_payload
        .clone()
        .unwrap_or_else(|| header_payload(hand, &style));
    lines.push(format!("Poker Hand #{}: {header}", hand.meta.hand_id));
    lines.push(table_line(hand));

    let players = by_seat(hand);
    for player in &players {
        lines.push(format!(
            "Seat {}: {} ({} in chips)",
            player.seat,
            player.name,
            money(player.starting_stack, unit, &style)
        ));
    }

    let drops = hand.chip_movements.as_deref().unwrap_or_default();
    let emit_drops = |anchor: ChipMovementAnchor, lines: &mut Vec<String>| {
        for movement in drops {
            if movement.anchor != anchor {
                continue;
            }
            if let Some(raw) = movement.raw.as_ref().filter(|raw| !raw.is_empty()) {
                lines.push(raw.clone());
            }
        }
    };

    emit_drops(ChipMovementAnchor::BeforePostings, &mut lines);

    let is_pre_deal = |a: &PhfAction| {
        matches!(
            a.kind,
            ActionType::Ante
                | ActionType::SmallBlind
                | ActionType::BigBlind
                | ActionType::MissedBlind
        ) || (a.kind == ActionType::Straddle && a.street == Street::Preflop)
    };
    for action in hand.actions.iter().filter(|a| is_pre_deal(a)) {
        lines.push(render(action, &mut current_bet));
    }

    if text_style.hole_cards_section {
        lines.push("*** HOLE CARDS ***".to_owned());
        emit_drops(ChipMovementAnchor::AfterHoleCards, &mut lines);
        for player in &players {
            if !player.dealt_announced {
                continue;
            }
            // A seat with unknown cards still gets a line - with a trailing
            // space where the room writes one; trackers match on it.
            lines.push(if player.dealt_cards.is_empty() {
                format!(
                    "Dealt to {}{}",
                    player.name,
                    if style.dealt_line_trailing_space {
                        " "
                    } else {
                        ""
                    }
                )
            } else {
                format!(
                    "Dealt to {} [{}]",
                    player.name,
                    player.dealt_cards.join(" ")
                )
            });
        }
    }

    // `bodyActions` by index; `emitted` likewise.
    let body: Vec<usize> = (0..hand.actions.len())
        .filter(|&i| !is_pre_deal(&hand.actions[i]))
        .collect();
    let mut emitted: HashSet<usize> = HashSet::new();
    let mut emit_for =
        |street: Street, runout: Option<u32>, lines: &mut Vec<String>, current_bet: &mut Amount| {
            for &i in &body {
                let action = &hand.actions[i];
                if action.street == street
                    && runout.is_none_or(|r| action.runout_index == r)
                    && emitted.insert(i)
                {
                    lines.push(render(action, current_bet));
                }
            }
        };

    emit_for(Street::Preflop, Some(0), &mut lines, &mut current_bet);

    let run_count = hand.board.runouts.len();
    for (run_index, run) in hand.board.runouts.iter().enumerate() {
        let resolved = resolve_runout(&hand.board, run_index);
        let index = u32::try_from(run_index).unwrap_or(u32::MAX);
        // The prefix the source used, or the positional one.
        let prefix = |printed: Option<&String>| {
            let label = match printed {
                Some(label) => label.as_str(),
                None if run_count > 1 => RUN_PREFIXES.get(run_index).copied().unwrap_or(""),
                None => "",
            };
            if label.is_empty() {
                String::new()
            } else {
                format!("{label} ")
            }
        };
        if run.flop.is_some() {
            lines.push(format!(
                "*** {}FLOP ***{}[{}]",
                prefix(run.marker_labels.flop.as_ref()),
                style.flop_marker_gap,
                joined(&resolved, 3)
            ));
            current_bet = 0;
            emit_for(Street::Flop, Some(index), &mut lines, &mut current_bet);
        }
        let listed = marker_prefix_order(run, &resolved);
        if run.turn.as_deref().is_some_and(|t| !t.is_empty()) {
            lines.push(format!(
                "*** {}TURN *** [{}] [{}]",
                prefix(run.marker_labels.turn.as_ref()),
                joined(&listed, 3),
                element(&resolved, 3)
            ));
            current_bet = 0;
            emit_for(Street::Turn, Some(index), &mut lines, &mut current_bet);
        }
        if run.river.as_deref().is_some_and(|r| !r.is_empty()) {
            lines.push(format!(
                "*** {}RIVER *** [{}] [{}]",
                prefix(run.marker_labels.river.as_ref()),
                joined(&listed, 4),
                element(&resolved, 4)
            ));
            current_bet = 0;
            emit_for(Street::River, Some(index), &mut lines, &mut current_bet);
        }
    }

    if text_style.showdown_section {
        let labels: Vec<String> = if text_style.showdown_labels.is_empty() {
            vec![if run_count > 1 {
                RUN_PREFIXES[0].to_owned()
            } else {
                String::new()
            }]
        } else {
            text_style.showdown_labels.clone()
        };
        for (i, label) in labels.iter().enumerate() {
            let prefix = if label.is_empty() {
                String::new()
            } else {
                format!("{label} ")
            };
            lines.push(format!("*** {prefix}{} ***", style.showdown_token));
            // One block settles every runout; several split them by runout.
            let runout = (labels.len() != 1).then(|| u32::try_from(i).unwrap_or(u32::MAX));
            emit_for(Street::Showdown, runout, &mut lines, &mut current_bet);
            if hand.game.hi_lo && went_all_high(hand, runout) {
                lines.push("No low hand qualified".to_owned());
            }
        }
    }

    // Anything the rules above did not place.
    for &i in &body {
        if emitted.insert(i) {
            lines.push(render(&hand.actions[i], &mut current_bet));
        }
    }

    lines.push("*** SUMMARY ***".to_owned());
    lines.push(summary_pot_line(hand, &style));
    if text_style.run_it_twice_note && run_count > 1 {
        lines.push(format!(
            "Hand was run {}",
            RUN_WORDS
                .get(run_count)
                .map_or_else(|| format!("{run_count} times"), |w| (*w).to_owned())
        ));
    }
    lines.extend(board_lines(hand, &style));
    for player in &players {
        let Some(result) = hand.results.players.iter().find(|r| r.seat == player.seat) else {
            continue;
        };
        if !options.regenerate_summary
            && let Some(raw) = result.raw.as_ref().filter(|raw| !raw.is_empty())
        {
            lines.push(raw.clone());
            continue;
        }
        if let Some(generated) = generate_summary_seat_line(hand, player, result, &style) {
            lines.push(generated);
        }
    }

    lines.join("\n")
}

/// `toStandardTextFile(hands)`: many hands to one file, a blank line between
/// them - the converter's per-file download.
pub fn to_standard_text_file(hands: &[PhfHand]) -> String {
    to_standard_text_file_with(hands, SerializeOptions::default())
}

/// `toStandardTextFile(hands, options)`.
pub fn to_standard_text_file_with(hands: &[PhfHand], options: SerializeOptions) -> String {
    hands
        .iter()
        .map(|hand| to_standard_text_with(hand, options))
        .collect::<Vec<_>>()
        .join("\n\n")
}
