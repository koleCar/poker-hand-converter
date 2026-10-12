//! The draft -> PHF builder of Winamax and the Chico network
//! (`frontend/src/lib/parsers/shared/p6-handbuilder.ts`, R0.10a).
//!
//! Both rooms state a hand the same way - a seat list, an ordered action
//! stream in "chips added" form, and a settlement block - so each site parser
//! reads its own dialect into a [`P6Draft`] and this module
//!
//! 1. replays the betting into per-street commitments (which turns Chico's
//!    `raises 120.00 to 120.00` into `raises 60 to 120`),
//! 2. derives the uncalled return (Winamax never prints one),
//! 3. reconciles the derived pot and rake against the numbers the source
//!    printed, and **refuses the hand when the two disagree**
//!    (`inconsistent-pot`, `uncalled-mismatch`, `payout-mismatch`,
//!    `rake-mismatch`) - the difference from its sibling
//!    [`super::p2_handbuilder`], which has to infer a rake,
//! 4. writes GG-style standard text and reads it with [`parse_standard_hand`]
//!    (the route WePlay takes), then puts the site's own text back on
//!    `meta.rawText`.
//!
//! **Amounts are JavaScript numbers** ([`JsNumber`]), as in
//! [`super::p2_handbuilder`]: the TypeScript computes in doubles and prints
//! the results into the text it re-reads, and its refusal messages print them
//! (`Players put in 1e+21 …`). Seats, the table size and the button are
//! JavaScript numbers for the same reason (`Seat 007:` prints as `Seat 7:`).

use std::cmp::Ordering;
use std::collections::HashMap;

use super::p2_handbuilder::format_header_date;
use crate::detect::{ParseError, ParseSkip, SiteParserContext, SkipReason};
use crate::js::{self, JsNumber};
use crate::phf::money::format_amount_js;
use crate::phf::serialize::{StandardContext, parse_standard_hand};
use crate::phf::{CurrencyUnit, DecimalStyle, PhfHand, PhfWarning};

/// `P6Street`. `showdown` is generated, never drafted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum P6Street {
    Preflop,
    Flop,
    Turn,
    River,
}

impl P6Street {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preflop => "preflop",
            Self::Flop => "flop",
            Self::Turn => "turn",
            Self::River => "river",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Preflop => 0,
            Self::Flop => 1,
            Self::Turn => 2,
            Self::River => 3,
        }
    }

    /// `capitalize(street)`.
    const fn capitalized(self) -> &'static str {
        match self {
            Self::Preflop => "Preflop",
            Self::Flop => "Flop",
            Self::Turn => "Turn",
            Self::River => "River",
        }
    }
}

/// `P6_STREETS`.
pub const P6_STREETS: [P6Street; 4] = [
    P6Street::Preflop,
    P6Street::Flop,
    P6Street::Turn,
    P6Street::River,
];

/// `TOLERANCE`: one minor unit of slack, the validator's.
fn tolerance() -> JsNumber {
    JsNumber::from_u64(1)
}

/// `P6Seat`. Seats that sat the hand out are dropped (`dealt_in: false`), so
/// the position ring is not shifted by an observer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P6Seat {
    /// `Number(...)` of the seat digits.
    pub seat: JsNumber,
    pub name: String,
    pub starting_stack: JsNumber,
    pub dealt_in: bool,
    pub is_hero: bool,
    /// Cards the source showed at deal time; normally the hero's only.
    pub dealt_cards: Vec<String>,
}

/// `P6Kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum P6Kind {
    Ante,
    SmallBlind,
    BigBlind,
    Post,
    Fold,
    Check,
    Call,
    Bet,
    Raise,
    Show,
    Muck,
}

/// `P6Action`. `undefined` optional fields are `None` / `false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P6Action {
    pub street: P6Street,
    pub player: String,
    pub kind: P6Kind,
    /// Chips this action adds (or, with `to_total`, the actor's street total).
    pub amount: Option<JsNumber>,
    /// `amount` is the actor's total for the street, not the increment.
    pub to_total: bool,
    /// Chips added alongside `amount` that do not count toward the street
    /// bet (Chico's `post dead`).
    pub dead: Option<JsNumber>,
    /// The source flagged the action as all-in.
    pub all_in: bool,
    /// Cards a `show` / `muck` revealed.
    pub cards: Option<Vec<String>>,
    /// Showdown hand description, e.g. "One pair : Queens".
    pub description: Option<String>,
    /// 1-based line number in the site's own text.
    pub line: Option<u32>,
}

impl P6Action {
    /// `{ street, player, kind }` with every optional field absent.
    pub fn new(street: P6Street, player: &str, kind: P6Kind) -> Self {
        Self {
            street,
            player: player.to_owned(),
            kind,
            amount: None,
            to_total: false,
            dead: None,
            all_in: false,
            cards: None,
            description: None,
            line: None,
        }
    }
}

/// `P6Collect`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P6Collect {
    pub player: String,
    pub amount: JsNumber,
    /// "pot" | "main pot" | "side pot", as the source named it.
    pub pot_name: Option<String>,
}

/// `P6Draft.tournament`: the id and the level blinds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P6Tournament {
    pub id: String,
    pub level_small_blind: JsNumber,
    pub level_big_blind: JsNumber,
}

/// An entry of `P6Draft.printedUncalled`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P6PrintedUncalled {
    pub player: String,
    pub amount: JsNumber,
}

/// `P6Draft`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P6Draft {
    pub site_id: String,
    pub site_name: String,
    pub parser_id: String,
    pub parser_version: String,
    /// Put in front of the site's hand number (`WMX-`, `CHC-`).
    pub hand_prefix: String,
    pub hand_id: String,
    /// Canonical GG-style label, e.g. "Hold'em No Limit".
    pub game_label: String,
    pub unit: CurrencyUnit,
    pub decimals: DecimalStyle,
    /// Blinds from the header; overridden by what was actually posted.
    pub header_small_blind: JsNumber,
    pub header_big_blind: JsNumber,
    pub table_name: Option<String>,
    pub max_seats: JsNumber,
    pub button_seat: Option<JsNumber>,
    /// Tournament id and level blinds, or `None` on a cash hand.
    pub tournament: Option<P6Tournament>,
    /// ISO 8601, or `None` when the source has no usable timestamp.
    pub played_at: Option<String>,
    pub seats: Vec<P6Seat>,
    pub actions: Vec<P6Action>,
    /// `Some(vec![])` is the TypeScript's `[]`: truthy, so the flop marker is
    /// still written.
    pub flop: Option<Vec<String>>,
    pub turn: Option<String>,
    pub river: Option<String>,
    pub collected: Vec<P6Collect>,
    /// Whether `collected` already contains the winner's own uncalled bet
    /// (Winamax: yes; Chico: no).
    pub collected_includes_uncalled: bool,
    /// Uncalled returns the source printed; cross-checked against the derived
    /// one.
    pub printed_uncalled: Vec<P6PrintedUncalled>,
    /// Total chips that went in, per the source.
    pub reported_gross: Option<JsNumber>,
    /// Total paid out net of fees, per the source.
    pub reported_payout: Option<JsNumber>,
    /// Rake the source printed.
    pub reported_rake: Option<JsNumber>,
    pub raw_text: String,
    pub warnings: Vec<PhfWarning>,
}

/* ------------------------------------------------------------ betting state */

/// A `Map<string, number>`, in insertion order.
type Commits = Vec<(String, JsNumber)>;

fn get_or_zero(map: &Commits, key: &str) -> JsNumber {
    map.iter()
        .find(|(k, _)| k == key)
        .map_or(JsNumber::ZERO, |(_, v)| *v)
}

fn set(map: &mut Commits, key: &str, value: JsNumber) {
    if let Some(entry) = map.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        map.push((key.to_owned(), value));
    }
}

/// A JavaScript number's truthiness (`0`, `-0` and `NaN` are falsy).
fn truthy(value: JsNumber) -> bool {
    !value.is_nan() && !value.strict_equals(JsNumber::ZERO)
}

/// `Math.abs(a - b) > TOLERANCE` (false when either is `NaN`).
fn off_by_more_than_tolerance(a: JsNumber, b: JsNumber) -> bool {
    (a - b).abs().greater_than(tolerance())
}

#[derive(Debug, Clone)]
struct Reveal {
    player: String,
    cards: Vec<String>,
    description: Option<String>,
}

/// `Replay`. (`contributed` is kept by the TypeScript and never read; not
/// ported.)
#[derive(Debug, Clone)]
struct Replay {
    lines: [Vec<String>; 4],
    totals: [Commits; 4],
    gross: JsNumber,
    /// Player -> the street they folded on (last fold wins, first position).
    folded: Vec<(String, P6Street)>,
    small_blind: JsNumber,
    big_blind: JsNumber,
    small_poster: Option<String>,
    big_poster: Option<String>,
    shows: Vec<Reveal>,
    mucks: Vec<Reveal>,
}

fn money(amount: JsNumber, unit: &CurrencyUnit, decimals: DecimalStyle) -> String {
    format_amount_js(amount, unit, decimals, false)
}

/// `put(player, live, dead)`: the live chips count toward the street bet.
fn put(
    commit: &mut Commits,
    bet: &mut JsNumber,
    gross: &mut JsNumber,
    player: &str,
    live: JsNumber,
    dead: JsNumber,
) -> JsNumber {
    let next = get_or_zero(commit, player) + live;
    set(commit, player, next);
    *bet = bet.max_of(next);
    *gross = *gross + (live + dead);
    next
}

/// `replayActions(draft)`: the action list as standard-text lines per street,
/// with the commitments the uncalled return and the pot come from.
#[allow(clippy::too_many_lines)]
fn replay_actions(draft: &P6Draft) -> Replay {
    let (unit, decimals) = (&draft.unit, draft.decimals);
    let mut replay = Replay {
        lines: Default::default(),
        totals: Default::default(),
        gross: JsNumber::ZERO,
        folded: Vec::new(),
        small_blind: JsNumber::ZERO,
        big_blind: JsNumber::ZERO,
        small_poster: None,
        big_poster: None,
        shows: Vec::new(),
        mucks: Vec::new(),
    };
    let mut street = P6Street::Preflop;
    let mut commit: Commits = Vec::new();
    let mut bet = JsNumber::ZERO;

    for action in &draft.actions {
        match action.kind {
            P6Kind::Show => {
                replay.shows.push(Reveal {
                    player: action.player.clone(),
                    cards: action.cards.clone().unwrap_or_default(),
                    description: action.description.clone(),
                });
                continue;
            }
            P6Kind::Muck => {
                replay.mucks.push(Reveal {
                    player: action.player.clone(),
                    cards: action.cards.clone().unwrap_or_default(),
                    description: None,
                });
                continue;
            }
            _ => {}
        }
        // Reveals cannot close a betting street (above): a showdown reveal
        // carries the street it physically happened on.
        if action.street != street {
            replay.totals[street.index()] = std::mem::take(&mut commit);
            street = action.street;
            bet = JsNumber::ZERO;
        }
        let player = action.player.as_str();
        let all_in = if action.all_in { " and is all-in" } else { "" };
        let already = get_or_zero(&commit, player);
        let stated = action.amount.unwrap_or(JsNumber::ZERO);
        let amount = if action.to_total {
            JsNumber::ZERO.max_of(stated - already)
        } else {
            stated
        };
        let dead = action.dead.unwrap_or(JsNumber::ZERO);
        let gross = &mut replay.gross;
        let out = &mut replay.lines[action.street.index()];
        if dead.greater_than(JsNumber::ZERO) {
            // No "+ dead" form in standard text: re-emitted first, as a
            // missed blind (chips in the pot that do not count toward the
            // street bet).
            out.push(format!(
                "{player}: posts missed blind {}",
                money(dead, unit, decimals)
            ));
        }

        match action.kind {
            P6Kind::Ante => {
                // Antes are dead: they never count toward the street bet.
                *gross = *gross + amount;
                out.push(format!(
                    "{player}: posts the ante {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P6Kind::SmallBlind => {
                replay.small_blind = replay.small_blind.max_of(amount);
                if replay.small_poster.is_none() {
                    replay.small_poster = Some(player.to_owned());
                }
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: posts small blind {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P6Kind::BigBlind => {
                replay.big_blind = replay.big_blind.max_of(amount);
                if replay.big_poster.is_none() {
                    replay.big_poster = Some(player.to_owned());
                }
                put(&mut commit, &mut bet, gross, player, amount, dead);
                out.push(format!(
                    "{player}: posts big blind {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P6Kind::Post => {
                put(&mut commit, &mut bet, gross, player, amount, dead);
                // A post that is nothing but dead money was written out as
                // the missed blind above.
                if amount.greater_than(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: posts {}{all_in}",
                        money(amount, unit, decimals)
                    ));
                }
            }
            P6Kind::Fold => {
                if let Some(entry) = replay.folded.iter_mut().find(|(p, _)| p == player) {
                    entry.1 = action.street;
                } else {
                    replay.folded.push((player.to_owned(), action.street));
                }
                out.push(format!("{player}: folds"));
            }
            P6Kind::Check => out.push(format!("{player}: checks")),
            P6Kind::Call => {
                put(&mut commit, &mut bet, gross, player, amount, JsNumber::ZERO);
                out.push(format!(
                    "{player}: calls {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P6Kind::Bet => {
                put(&mut commit, &mut bet, gross, player, amount, JsNumber::ZERO);
                out.push(format!(
                    "{player}: bets {}{all_in}",
                    money(amount, unit, decimals)
                ));
            }
            P6Kind::Raise => {
                // A "raise" that does not get above the bet is a call, one
                // into an unopened street a bet.
                let over = bet;
                let to = put(&mut commit, &mut bet, gross, player, amount, JsNumber::ZERO);
                if matches!(to.compare(over), Some(Ordering::Less | Ordering::Equal)) {
                    out.push(format!(
                        "{player}: calls {}{all_in}",
                        money(amount, unit, decimals)
                    ));
                } else if over.greater_than(JsNumber::ZERO) {
                    out.push(format!(
                        "{player}: raises {} to {}{all_in}",
                        money(to - over, unit, decimals),
                        money(to, unit, decimals)
                    ));
                } else {
                    out.push(format!(
                        "{player}: bets {}{all_in}",
                        money(amount, unit, decimals)
                    ));
                }
            }
            P6Kind::Show | P6Kind::Muck => {}
        }
    }
    replay.totals[street.index()] = commit;
    replay
}

/// The uncalled bet, derived from the betting state.
#[derive(Debug, Clone)]
struct Uncalled {
    player: String,
    amount: JsNumber,
    street: P6Street,
}

/// `deriveUncalled(replay)`: on the last street that saw money, whoever
/// committed more than anybody else gets the difference back; a tie returns
/// nothing.
fn derive_uncalled(replay: &Replay) -> Option<Uncalled> {
    for street in P6_STREETS.iter().rev() {
        let mut entries: Vec<&(String, JsNumber)> = replay.totals[street.index()]
            .iter()
            .filter(|(_, value)| value.greater_than(JsNumber::ZERO))
            .collect();
        if entries.is_empty() {
            continue;
        }
        // `sort((a, b) => b[1] - a[1])`, as V8 sorts.
        js::sort::sort_by(&mut entries, |a, b| b.1 - a.1);
        let (player, top) = entries[0];
        let second = entries.get(1).map_or(JsNumber::ZERO, |entry| entry.1);
        return top.greater_than(second).then(|| Uncalled {
            player: player.clone(),
            amount: *top - second,
            street: *street,
        });
    }
    None
}

/// `Settlement`.
#[derive(Debug, Clone)]
struct Settlement {
    uncalled: Option<Uncalled>,
    collected: Vec<P6Collect>,
    total_pot: JsNumber,
    rake: JsNumber,
}

/// `settle(draft, replay)`: reconciles the contributions with what the source
/// says was won, and refuses anything that does not add up.
fn settle(draft: &P6Draft, replay: &Replay) -> Result<Settlement, ParseSkip> {
    let uncalled = derive_uncalled(replay);

    if let Some(reported) = draft.reported_gross
        && off_by_more_than_tolerance(replay.gross, reported)
    {
        return Err(ParseSkip::new(
            SkipReason::InconsistentPot,
            format!(
                "Players put in {} but the hand's own pot and rake add up to {}.",
                replay.gross.to_js_string(),
                reported.to_js_string()
            ),
        ));
    }

    for printed in &draft.printed_uncalled {
        let Some(derived) = uncalled.as_ref().filter(|u| u.player == printed.player) else {
            let says = uncalled.as_ref().map_or_else(
                || "nothing".to_owned(),
                |u| format!("{} to {}", u.amount.to_js_string(), u.player),
            );
            return Err(ParseSkip::new(
                SkipReason::UncalledMismatch,
                format!(
                    "The source returns {} to {}, but the betting state says {says} was \
                     left unmatched.",
                    printed.amount.to_js_string(),
                    printed.player
                ),
            ));
        };
        if off_by_more_than_tolerance(derived.amount, printed.amount) {
            return Err(ParseSkip::new(
                SkipReason::UncalledMismatch,
                format!(
                    "The source returns {} to {} but only {} was left unmatched.",
                    printed.amount.to_js_string(),
                    printed.player,
                    derived.amount.to_js_string()
                ),
            ));
        }
    }

    // Winnings net of the uncalled return, the standard text's convention.
    let mut entries = draft.collected.clone();
    if draft.collected_includes_uncalled
        && let Some(uncalled) = &uncalled
    {
        let mut remaining = uncalled.amount;
        for entry in &mut entries {
            if entry.player != uncalled.player || remaining.strict_equals(JsNumber::ZERO) {
                continue;
            }
            let take = remaining.min_of(entry.amount);
            entry.amount = entry.amount - take;
            remaining = remaining - take;
        }
        if remaining.greater_than(JsNumber::ZERO) {
            return Err(ParseSkip::new(
                SkipReason::InconsistentPot,
                format!(
                    "{} had {} left unmatched but collected less than that, so the reported \
                     winnings cannot contain the return.",
                    uncalled.player,
                    uncalled.amount.to_js_string()
                ),
            ));
        }
    }

    let kept: Vec<P6Collect> = entries
        .into_iter()
        .filter(|entry| entry.amount.greater_than(JsNumber::ZERO))
        .collect();
    let paid = kept
        .iter()
        .fold(JsNumber::ZERO, |sum, entry| sum + entry.amount);

    if let Some(payout) = draft.reported_payout
        && off_by_more_than_tolerance(paid, payout)
    {
        return Err(ParseSkip::new(
            SkipReason::PayoutMismatch,
            format!(
                "The summary credits {} to named seats but reports pots totalling {}; {} is \
                 unaccounted for.",
                paid.to_js_string(),
                payout.to_js_string(),
                (payout - paid).to_js_string()
            ),
        ));
    }

    let total_pot = replay.gross - uncalled.as_ref().map_or(JsNumber::ZERO, |u| u.amount);
    let rake = total_pot - paid;
    if rake.less_than(-tolerance()) {
        return Err(ParseSkip::new(
            SkipReason::InconsistentPot,
            format!(
                "The contested pot is {} but {} was paid out of it, which would make the rake \
                 negative.",
                total_pot.to_js_string(),
                paid.to_js_string()
            ),
        ));
    }
    if let Some(reported) = draft.reported_rake
        && off_by_more_than_tolerance(rake, reported)
    {
        return Err(ParseSkip::new(
            SkipReason::RakeMismatch,
            format!(
                "The source reports a rake of {} but the contested pot of {} minus the {} paid \
                 out leaves {}.",
                reported.to_js_string(),
                total_pot.to_js_string(),
                paid.to_js_string(),
                rake.to_js_string()
            ),
        ));
    }

    Ok(Settlement {
        uncalled,
        collected: kept,
        total_pot,
        rake: JsNumber::ZERO.max_of(rake),
    })
}

/* ------------------------------------------------------------------ summary */

/// `positionLabelsFor(seat, seats, buttonSeat, blinds)`.
fn position_labels_for(
    seat: JsNumber,
    seats: &[&P6Seat],
    button_seat: Option<JsNumber>,
    replay: &Replay,
) -> Vec<&'static str> {
    let mut labels = Vec::new();
    let name = seats
        .iter()
        .find(|entry| entry.seat.strict_equals(seat))
        .map(|entry| entry.name.as_str());
    if button_seat.is_some_and(|button| seat.strict_equals(button)) {
        labels.push("(button)");
    }
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        if replay.small_poster.as_deref() == Some(name) {
            labels.push("(small blind)");
        }
        if replay.big_poster.as_deref() == Some(name) {
            labels.push("(big blind)");
        }
    }
    labels
}

/// `p6HeaderDate(iso)`: `2014-01-06T22:40:28.000Z` -> `2014/01/06 22:40:28`
/// (the same function as `p2-handbuilder.ts`'s `formatHeaderDate`).
pub fn p6_header_date(iso: &str) -> String {
    format_header_date(iso)
}

/* -------------------------------------------------------------------- build */

/// `p6ToStandardText(draft)`: the draft as standard text; the settlement's
/// refusal when its money does not add up.
#[allow(clippy::too_many_lines)]
pub fn p6_to_standard_text(draft: &P6Draft) -> Result<String, ParseSkip> {
    let (unit, decimals) = (&draft.unit, draft.decimals);
    let replay = replay_actions(draft);
    let settlement = settle(draft, &replay)?;
    let mut seats: Vec<&P6Seat> = draft.seats.iter().filter(|seat| seat.dealt_in).collect();
    // `sort((a, b) => a.seat - b.seat)`, as V8 sorts.
    js::sort::sort_by(&mut seats, |a, b| a.seat - b.seat);

    let small_blind = if truthy(replay.small_blind) {
        replay.small_blind
    } else {
        draft.header_small_blind
    };
    let big_blind = if truthy(replay.big_blind) {
        replay.big_blind
    } else {
        draft.header_big_blind
    };
    let date = match draft.played_at.as_deref() {
        Some(iso) if !iso.is_empty() => p6_header_date(iso),
        _ => String::new(),
    };

    let mut lines: Vec<String> = Vec::new();
    if let Some(tournament) = &draft.tournament {
        // `Level -`: Chico prints the level blinds but never a level number.
        let level = format!(
            "{}/{}",
            money(tournament.level_small_blind, unit, decimals),
            money(tournament.level_big_blind, unit, decimals)
        );
        lines.push(format!(
            "Poker Hand #{}{}: Tournament #{}, 0 {} - Level - ({level}) - {date}",
            draft.hand_prefix, draft.hand_id, tournament.id, draft.game_label
        ));
    } else {
        lines.push(format!(
            "Poker Hand #{}{}: {} ({}/{}) - {date}",
            draft.hand_prefix,
            draft.hand_id,
            draft.game_label,
            money(small_blind, unit, decimals),
            money(big_blind, unit, decimals)
        ));
    }
    lines.push(format!(
        "Table '{}' {}-max{}",
        draft.table_name.as_deref().unwrap_or(""),
        draft.max_seats.to_js_string(),
        draft.button_seat.map_or(String::new(), |button| format!(
            " Seat #{} is the button",
            button.to_js_string()
        ))
    ));
    for seat in &seats {
        lines.push(format!(
            "Seat {}: {} ({} in chips)",
            seat.seat.to_js_string(),
            seat.name,
            money(seat.starting_stack, unit, decimals)
        ));
    }

    // Posting lines go before `*** HOLE CARDS ***`, the rest after it.
    let preflop = &replay.lines[0];
    let posting_count = preflop.iter().position(|line| !line.contains(": posts "));
    let (postings, preflop_body): (&[String], &[String]) = match posting_count {
        None => (preflop, &[]),
        Some(count) => (&preflop[..count], &preflop[count..]),
    };
    lines.extend(postings.iter().cloned());

    lines.push("*** HOLE CARDS ***".to_owned());
    for seat in &seats {
        if !seat.dealt_cards.is_empty() {
            lines.push(format!(
                "Dealt to {} [{}]",
                seat.name,
                seat.dealt_cards.join(" ")
            ));
        } else if seat.is_hero {
            // A deal line with no cards (an observed table): the bare line
            // keeps `dealtAnnounced`.
            lines.push(format!("Dealt to {}", seat.name));
        }
    }
    lines.extend(preflop_body.iter().cloned());
    let uncalled_line = |uncalled: &Uncalled| {
        format!(
            "Uncalled bet ({}) returned to {}",
            money(uncalled.amount, unit, decimals),
            uncalled.player
        )
    };
    let uncalled_on = |street: P6Street| {
        settlement
            .uncalled
            .as_ref()
            .filter(|uncalled| uncalled.street == street)
    };
    if let Some(uncalled) = uncalled_on(P6Street::Preflop) {
        lines.push(uncalled_line(uncalled));
    }

    let turn = draft.turn.as_deref().filter(|card| !card.is_empty());
    let river = draft.river.as_deref().filter(|card| !card.is_empty());
    let mut board: Vec<String> = draft.flop.clone().unwrap_or_default();
    board.extend(turn.map(str::to_owned));
    board.extend(river.map(str::to_owned));
    let emit_street = |lines: &mut Vec<String>, street: P6Street, marker: String| {
        lines.push(marker);
        lines.extend(replay.lines[street.index()].iter().cloned());
        if let Some(uncalled) = uncalled_on(street) {
            lines.push(uncalled_line(uncalled));
        }
    };
    if let Some(flop) = &draft.flop {
        emit_street(
            &mut lines,
            P6Street::Flop,
            format!("*** FLOP *** [{}]", flop.join(" ")),
        );
    }
    if let Some(turn) = turn {
        let before = &board[..board.len().min(3)];
        emit_street(
            &mut lines,
            P6Street::Turn,
            format!("*** TURN *** [{}] [{turn}]", before.join(" ")),
        );
    }
    if let Some(river) = river {
        let before = &board[..board.len().min(4)];
        emit_street(
            &mut lines,
            P6Street::River,
            format!("*** RIVER *** [{}] [{river}]", before.join(" ")),
        );
    }

    // Only a hand where somebody revealed gets a showdown marker.
    if !replay.shows.is_empty() {
        lines.push("*** SHOWDOWN ***".to_owned());
        for show in &replay.shows {
            let description = show
                .description
                .as_deref()
                .filter(|d| !d.is_empty())
                .map_or(String::new(), |d| format!(" ({d})"));
            lines.push(format!(
                "{}: shows [{}]{description}",
                show.player,
                show.cards.join(" ")
            ));
        }
        for muck in &replay.mucks {
            lines.push(format!("{}: doesn't show hand", muck.player));
        }
    }
    for entry in &settlement.collected {
        lines.push(format!(
            "{} collected {} from {}",
            entry.player,
            money(entry.amount, unit, decimals),
            entry.pot_name.as_deref().unwrap_or("pot")
        ));
    }

    lines.push("*** SUMMARY ***".to_owned());
    let zero = money(JsNumber::ZERO, unit, decimals);
    lines.push(format!(
        "Total pot {} | Rake {} | Jackpot {zero} | Bingo {zero} | Fortune {zero} | Tax {zero}",
        money(settlement.total_pot, unit, decimals),
        money(settlement.rake, unit, decimals)
    ));
    if !board.is_empty() {
        lines.push(format!("Board [{}]", board.join(" ")));
    }

    let mut won_by: HashMap<&str, JsNumber> = HashMap::new();
    for entry in &settlement.collected {
        let total = won_by
            .entry(entry.player.as_str())
            .or_insert(JsNumber::ZERO);
        *total = *total + entry.amount;
    }
    // `new Map(shows.map(...))`: the last reveal of a player wins.
    let last_of = |reveals: &'_ [Reveal], name: &str| -> Option<usize> {
        reveals.iter().rposition(|reveal| reveal.player == name)
    };

    for seat in &seats {
        let labels = position_labels_for(seat.seat, &seats, draft.button_seat, &replay);
        let head = if labels.is_empty() {
            format!("Seat {}: {}", seat.seat.to_js_string(), seat.name)
        } else {
            format!(
                "Seat {}: {} {}",
                seat.seat.to_js_string(),
                seat.name,
                labels.join(" ")
            )
        };
        let won = won_by
            .get(seat.name.as_str())
            .copied()
            .unwrap_or(JsNumber::ZERO);
        let shown = last_of(&replay.shows, &seat.name).map(|i| &replay.shows[i]);
        let mucked = last_of(&replay.mucks, &seat.name).map(|i| &replay.mucks[i]);
        let folded = replay
            .folded
            .iter()
            .find(|(player, _)| *player == seat.name)
            .map(|(_, street)| *street);

        if let Some(street) = folded {
            let place = if street == P6Street::Preflop {
                "folded before Flop".to_owned()
            } else {
                format!("folded on the {}", street.capitalized())
            };
            // "(didn't bet)": no voluntary chip; a blind is not voluntary.
            let voluntary = draft.actions.iter().any(|action| {
                action.player == seat.name
                    && matches!(action.kind, P6Kind::Call | P6Kind::Bet | P6Kind::Raise)
            });
            let cards = shown
                .or(mucked)
                .filter(|reveal| !reveal.cards.is_empty())
                .map_or(String::new(), |reveal| {
                    format!(", mucked [{}]", reveal.cards.join(" "))
                });
            lines.push(format!(
                "{head} {place}{}{cards}",
                if voluntary { "" } else { " (didn't bet)" }
            ));
            continue;
        }
        let with = |show: &Reveal| {
            show.description
                .as_deref()
                .filter(|d| !d.is_empty())
                .map_or(String::new(), |d| format!(" with {d}"))
        };
        if let Some(show) = shown {
            if won.greater_than(JsNumber::ZERO) {
                lines.push(format!(
                    "{head} showed [{}] and won ({}){}",
                    show.cards.join(" "),
                    money(won, unit, decimals),
                    with(show)
                ));
            } else {
                lines.push(format!(
                    "{head} showed [{}] and lost{}",
                    show.cards.join(" "),
                    with(show)
                ));
            }
            continue;
        }
        if let Some(muck) = mucked.filter(|muck| !muck.cards.is_empty()) {
            lines.push(format!("{head} mucked [{}]", muck.cards.join(" ")));
            continue;
        }
        if won.greater_than(JsNumber::ZERO) {
            lines.push(format!("{head} collected ({})", money(won, unit, decimals)));
            continue;
        }
        lines.push(format!("{head} mucked"));
    }

    Ok(lines.join("\n"))
}

/// `buildP6Hand(draft, ctx)`: draft in, PHF out. `meta.rawText` is the site's
/// own text, `meta.handKey` the prefixed id; the hero is deliberately not
/// restated (standard text cannot carry a hero whose cards were never
/// shown).
pub fn build_p6_hand(draft: &P6Draft, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
    if draft.seats.iter().filter(|seat| seat.dealt_in).count() < 2 {
        return Err(ParseSkip::new(
            SkipReason::TooFewPlayers,
            "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
        )
        .into());
    }
    if draft.collected.is_empty() {
        return Err(ParseSkip::new(
            SkipReason::NoWinner,
            "The hand does not say who collected the pot.",
        )
        .into());
    }

    let text = p6_to_standard_text(draft)?;
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
            return Err(ParseSkip::new(
                SkipReason::NormalizedUnparseable,
                "The normalized text was not readable as a standard-format hand.",
            )
            .into());
        }
        Err(thrown) => return Err(ParseError::Bug(thrown.message)),
    };

    hand.meta.raw_text.clone_from(&draft.raw_text);
    let mut warnings = draft.warnings.clone();
    warnings.append(&mut hand.meta.warnings);
    hand.meta.warnings = warnings;
    hand.meta.hand_key.clone_from(&hand.meta.hand_id);
    Ok(hand)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phf::money::{CHIPS, EUR};

    const SOURCE: &str =
        include_str!("../../../../../frontend/src/lib/parsers/shared/p6-handbuilder.ts");

    #[test]
    fn literals_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            "const TOLERANCE: Amount = 1;",
            r#"export const P6_STREETS: P6Street[] = ["preflop", "flop", "turn", "river"];"#,
            r#"const allIn = action.allIn ? " and is all-in" : "";"#,
            "`${action.player}: posts missed blind ${money(dead, unit, decimals)}`",
            "`${action.player}: posts the ante ${money(amount, unit, decimals)}${allIn}`",
            "`${action.player}: posts small blind ${money(amount, unit, decimals)}${allIn}`",
            "`${action.player}: posts big blind ${money(amount, unit, decimals)}${allIn}`",
            "`${action.player}: posts ${money(amount, unit, decimals)}${allIn}`",
            "`${action.player}: folds`",
            "`${action.player}: checks`",
            "`${action.player}: calls ${money(amount, unit, decimals)}${allIn}`",
            "`${action.player}: bets ${money(amount, unit, decimals)}${allIn}`",
            "`Players put in ${replay.gross} but the hand's own pot and rake add up to ` +",
            "`The source returns ${printed.amount} to ${printed.player}, but the betting ` +",
            r#"`state says ${uncalled ? `${uncalled.amount} to ${uncalled.player}` : "nothing"} ` +"#,
            r#""was left unmatched.","#,
            "`The source returns ${printed.amount} to ${printed.player} but only ` +",
            "`${uncalled.amount} was left unmatched.`",
            "`${uncalled.player} had ${uncalled.amount} left unmatched but collected less ` +",
            r#""than that, so the reported winnings cannot contain the return.","#,
            "`The summary credits ${paid} to named seats but reports pots totalling ` +",
            "`${draft.reportedPayout}; ${draft.reportedPayout - paid} is unaccounted for.`",
            "`The contested pot is ${totalPot} but ${paid} was paid out of it, which would ` +",
            r#""make the rake negative.","#,
            "`The source reports a rake of ${draft.reportedRake} but the contested pot of ` +",
            "`${totalPot} minus the ${paid} paid out leaves ${rake}.`",
            "`Poker Hand #${draft.handPrefix}${draft.handId}: Tournament #${draft.tournament.id}, ` +",
            "`0 ${draft.gameLabel} - Level - (${level}) - ${date}`,",
            "`Poker Hand #${draft.handPrefix}${draft.handId}: ${draft.gameLabel} (${stakes}) - ${date}`,",
            "`Table '${draft.tableName ?? \"\"}' ${draft.maxSeats}-max` +",
            "(draft.buttonSeat === null ? \"\" : ` Seat #${draft.buttonSeat} is the button`),",
            "`Seat ${seat.seat}: ${seat.name} (${money(seat.startingStack, unit, decimals)} in chips)`,",
            "const postingCount = preflop.findIndex((line) => !/: posts /.test(line));",
            "lines.push(`Dealt to ${seat.name}`);",
            "`Total pot ${money(settlement.totalPot, unit, decimals)} | ` +",
            "`Rake ${money(settlement.rake, unit, decimals)} | Jackpot ${zero} | ` +",
            "`Bingo ${zero} | Fortune ${zero} | Tax ${zero}`,",
            "return `Uncalled bet (${money(uncalled.amount, unit, decimals)}) returned to ${uncalled.player}`;",
            r#""Fewer than two seats were dealt in, so the hand cannot be reconstructed.","#,
            r#"throw new ParseSkip("no-winner", "The hand does not say who collected the pot.");"#,
            r#""The normalized text was not readable as a standard-format hand.","#,
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    fn seat(seat: u64, name: &str, stack: u64) -> P6Seat {
        P6Seat {
            seat: JsNumber::from_u64(seat),
            name: name.to_owned(),
            starting_stack: JsNumber::from_u64(stack),
            dealt_in: true,
            is_hero: false,
            dealt_cards: Vec::new(),
        }
    }

    fn amount(street: P6Street, player: &str, kind: P6Kind, value: u64) -> P6Action {
        let mut action = P6Action::new(street, player, kind);
        action.amount = Some(JsNumber::from_u64(value));
        action
    }

    fn draft() -> P6Draft {
        P6Draft {
            site_id: "winamax".to_owned(),
            site_name: "Winamax".to_owned(),
            parser_id: "winamax".to_owned(),
            parser_version: "1.0.0".to_owned(),
            hand_prefix: "WMX-".to_owned(),
            hand_id: "1-2-3".to_owned(),
            game_label: "Hold'em No Limit".to_owned(),
            unit: EUR.unit(),
            decimals: DecimalStyle::Fixed2,
            header_small_blind: JsNumber::from_u64(25),
            header_big_blind: JsNumber::from_u64(50),
            table_name: Some("T".to_owned()),
            max_seats: JsNumber::from_u64(5),
            button_seat: Some(JsNumber::from_u64(2)),
            tournament: None,
            played_at: Some("2013-11-07T03:53:58.000Z".to_owned()),
            seats: vec![seat(1, "alice", 9936), seat(2, "bob", 6476)],
            actions: vec![
                amount(P6Street::Preflop, "alice", P6Kind::SmallBlind, 25),
                amount(P6Street::Preflop, "bob", P6Kind::BigBlind, 50),
                P6Action::new(P6Street::Preflop, "alice", P6Kind::Fold),
            ],
            flop: None,
            turn: None,
            river: None,
            collected: vec![P6Collect {
                player: "bob".to_owned(),
                amount: JsNumber::from_u64(75),
                pot_name: Some("pot".to_owned()),
            }],
            collected_includes_uncalled: true,
            printed_uncalled: Vec::new(),
            reported_gross: Some(JsNumber::from_u64(75)),
            reported_payout: None,
            reported_rake: Some(JsNumber::ZERO),
            raw_text: "raw".to_owned(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn a_walk_returns_the_big_blinds_excess_and_writes_the_text() {
        let text = p6_to_standard_text(&draft()).expect("text");
        assert_eq!(
            text,
            "Poker Hand #WMX-1-2-3: Hold'em No Limit (€0.25/€0.50) - 2013/11/07 03:53:58\n\
             Table 'T' 5-max Seat #2 is the button\n\
             Seat 1: alice (€99.36 in chips)\n\
             Seat 2: bob (€64.76 in chips)\n\
             alice: posts small blind €0.25\n\
             bob: posts big blind €0.50\n\
             *** HOLE CARDS ***\n\
             alice: folds\n\
             Uncalled bet (€0.25) returned to bob\n\
             bob collected €0.50 from pot\n\
             *** SUMMARY ***\n\
             Total pot €0.50 | Rake €0 | Jackpot €0 | Bingo €0 | Fortune €0 | Tax €0\n\
             Seat 1: alice (small blind) folded before Flop (didn't bet)\n\
             Seat 2: bob (button) (big blind) collected (€0.50)"
        );
    }

    #[test]
    fn every_reconciliation_refuses_with_the_typescript_message() {
        let mut gross = draft();
        gross.reported_gross = Some(JsNumber::from_u64(80));
        let skip = p6_to_standard_text(&gross).expect_err("gross");
        assert_eq!(skip.reason, SkipReason::InconsistentPot);
        assert_eq!(
            skip.message,
            "Players put in 75 but the hand's own pot and rake add up to 80."
        );

        let mut printed = draft();
        printed.printed_uncalled = vec![P6PrintedUncalled {
            player: "alice".to_owned(),
            amount: JsNumber::from_u64(25),
        }];
        let skip = p6_to_standard_text(&printed).expect_err("printed");
        assert_eq!(skip.reason, SkipReason::UncalledMismatch);
        assert_eq!(
            skip.message,
            "The source returns 25 to alice, but the betting state says 25 to bob was left \
             unmatched."
        );
        printed.printed_uncalled[0].player = "bob".to_owned();
        printed.printed_uncalled[0].amount = JsNumber::from_u64(30);
        let skip = p6_to_standard_text(&printed).expect_err("amount");
        assert_eq!(
            skip.message,
            "The source returns 30 to bob but only 25 was left unmatched."
        );

        let mut short = draft();
        short.collected[0].amount = JsNumber::from_u64(10);
        let skip = p6_to_standard_text(&short).expect_err("short");
        assert_eq!(skip.reason, SkipReason::InconsistentPot);
        assert_eq!(
            skip.message,
            "bob had 25 left unmatched but collected less than that, so the reported winnings \
             cannot contain the return."
        );

        let mut payout = draft();
        payout.reported_payout = Some(JsNumber::from_u64(60));
        let skip = p6_to_standard_text(&payout).expect_err("payout");
        assert_eq!(skip.reason, SkipReason::PayoutMismatch);
        assert_eq!(
            skip.message,
            "The summary credits 50 to named seats but reports pots totalling 60; 10 is \
             unaccounted for."
        );

        let mut negative = draft();
        negative.collected_includes_uncalled = false;
        negative.reported_gross = None;
        let skip = p6_to_standard_text(&negative).expect_err("negative");
        assert_eq!(skip.reason, SkipReason::InconsistentPot);
        assert_eq!(
            skip.message,
            "The contested pot is 50 but 75 was paid out of it, which would make the rake \
             negative."
        );

        let mut rake = draft();
        rake.reported_rake = Some(JsNumber::from_u64(5));
        let skip = p6_to_standard_text(&rake).expect_err("rake");
        assert_eq!(skip.reason, SkipReason::RakeMismatch);
        assert_eq!(
            skip.message,
            "The source reports a rake of 5 but the contested pot of 50 minus the 50 paid out \
             leaves 0."
        );
    }

    #[test]
    fn a_tournament_header_has_no_level_number_and_a_dead_post_is_a_missed_blind() {
        let mut tournament = draft();
        tournament.unit = CHIPS.unit();
        tournament.tournament = Some(P6Tournament {
            id: "77".to_owned(),
            level_small_blind: JsNumber::from_u64(25),
            level_big_blind: JsNumber::from_u64(50),
        });
        tournament.collected_includes_uncalled = false;
        tournament.reported_gross = None;
        tournament.reported_rake = None;
        tournament.collected[0].amount = JsNumber::from_u64(60);
        let mut dead = amount(P6Street::Preflop, "alice", P6Kind::Post, 0);
        dead.dead = Some(JsNumber::from_u64(10));
        tournament.actions.insert(2, dead);
        let text = p6_to_standard_text(&tournament).expect("text");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            "Poker Hand #WMX-1-2-3: Tournament #77, 0 Hold'em No Limit - Level - (25/50) - \
             2013/11/07 03:53:58"
        );
        assert_eq!(lines[6], "alice: posts missed blind 10");
        assert_eq!(lines[7], "*** HOLE CARDS ***");
    }

    #[test]
    fn build_refuses_too_few_players_then_no_winner() {
        let options = crate::detect::ConvertOptions::default();
        let ctx = SiteParserContext {
            source_filename: None,
            options: &options,
        };
        let mut lonely = draft();
        lonely.seats[1].dealt_in = false;
        lonely.collected.clear();
        let Err(ParseError::Skip(skip)) = build_p6_hand(&lonely, &ctx) else {
            panic!("expected a refusal");
        };
        assert_eq!(skip.reason, SkipReason::TooFewPlayers);
        let mut unpaid = draft();
        unpaid.collected.clear();
        let Err(ParseError::Skip(skip)) = build_p6_hand(&unpaid, &ctx) else {
            panic!("expected a refusal");
        };
        assert_eq!(skip.reason, SkipReason::NoWinner);
        let hand = build_p6_hand(&draft(), &ctx).expect("hand");
        assert_eq!(hand.meta.raw_text, "raw");
        assert_eq!(hand.meta.hand_key, "WMX-1-2-3");
    }
}
