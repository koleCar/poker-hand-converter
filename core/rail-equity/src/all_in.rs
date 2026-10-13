//! All-in EV: `frontend/src/lib/equity/allInEv.ts`.
//!
//! What each seat would have netted had the pot been split by equity at the
//! moment the money went in, rather than by the board that came:
//!
//! ```text
//! evNet(seat) = sum over pots  equity(seat, pot) x pot  -  contributed(seat)
//! ```
//!
//! See the TypeScript for when it applies, how side pots are layered, how
//! the rake comes off and why folded cards stay in the deck. Amounts are
//! `i64` minor units, exact like the TypeScript's doubles for every amount a
//! PHF holds. The one place the TypeScript computes in doubles is
//! `apportion` (a pot split by equity, the deductions split by pot size);
//! [`apportion`] performs the same double operations in [`JsNumber`], in the
//! same order, on the same doubles [`equity`] returns, so every share is the
//! TypeScript's.

use std::collections::{BTreeMap, BTreeSet};

use rail_core::eval::short_deck_rule_for;
use rail_core::js::JsNumber;
use rail_core::js::sort::sort_by;
use rail_core::phf::{
    ActionType, Amount, PhfAction, PhfHand, Street, Variant, house_into_pot, runout_through_street,
    seat_out_of_pot, total_fees,
};
use serde_json::{Map, Value};

use crate::enumerate::{
    Computation, EquityGame, EquityOptions, EquityRequest, equity, hole_cards_for,
};

/// `EV_VERSION`: schema tag for EV rows, versioned separately from
/// `STATS_VERSION` (an equity or side-pot fix re-derives EV and nothing
/// else).
pub const EV_VERSION: &str = "ev/1";

/// `AllInSkipReason`: why a hand has no EV adjustment. Every one of them
/// means "use `net`".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AllInSkipReason {
    /// Stud, draw, razz or anything else without a community board.
    UnsupportedVariant,
    /// A split-pot game; nothing here scores a low half.
    HiLo,
    /// Two boards dealt before the betting.
    DoubleBoard,
    /// No action ever left two or more players with no decision left.
    NoAllIn,
    /// The all-in was called on the river.
    NoStreetToCome,
    /// A live player's hole cards were never shown.
    UnknownHoleCards,
    /// The board the all-in happened on is not in the hand.
    UnknownBoard,
    /// Cards are present but impossible together.
    InvalidCards,
    /// The stream has betting after the point where none should be possible.
    ActionAfterAllIn,
}

impl AllInSkipReason {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedVariant => "unsupported-variant",
            Self::HiLo => "hi-lo",
            Self::DoubleBoard => "double-board",
            Self::NoAllIn => "no-all-in",
            Self::NoStreetToCome => "no-street-to-come",
            Self::UnknownHoleCards => "unknown-hole-cards",
            Self::UnknownBoard => "unknown-board",
            Self::InvalidCards => "invalid-cards",
            Self::ActionAfterAllIn => "action-after-all-in",
        }
    }
}

/// `EvPot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvPot {
    /// What this pot paid out: its chips, plus any house drop, less its share
    /// of the fees.
    pub amount: Amount,
    /// Chips the players put into this layer.
    pub gross: Amount,
    /// Seats that can win it, ascending.
    pub eligible_seats: Vec<u32>,
    /// Equity of each eligible seat in this pot (the TypeScript's double).
    pub equity: Vec<JsNumber>,
    /// The same equity exactly: units of `1 / UNIT` of a board's pot, over
    /// [`AllInEv::denominator`].
    pub equity_units: Vec<u64>,
    /// `amount` divided by equity; sums to `amount` exactly.
    pub shares: Vec<Amount>,
}

/// `EvSeat`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvSeat {
    pub seat: u32,
    pub player: String,
    /// Live at the all-in. Seats that had folded have no equity.
    pub live: bool,
    pub contributed: Amount,
    /// Sum of this seat's shares of every pot.
    pub ev_won: Amount,
    /// `ev_won - contributed`, in the hand's minor units.
    pub ev_net: Amount,
}

/// `AllInEv`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllInEv {
    pub ev_version: &'static str,
    /// Street the all-in was completed on: preflop, flop or turn.
    pub street: Street,
    /// `PhfAction.index` of the action that completed it.
    pub action_index: u32,
    /// Board cards out at that moment.
    pub board: Vec<String>,
    pub method: Computation,
    /// Boards enumerated or sampled.
    pub boards: u64,
    /// Main pot first, then each side pot.
    pub pots: Vec<EvPot>,
    /// One entry per seat that appears in the action stream, ascending.
    pub seats: Vec<EvSeat>,
}

impl AllInEv {
    /// The common denominator of every [`EvPot::equity_units`]: `boards *
    /// UNIT`.
    pub fn denominator(&self) -> u128 {
        u128::from(self.boards) * u128::from(crate::enumerate::UNIT)
    }

    /// `evNet` per seat (`evNetBySeat`).
    pub fn ev_net_by_seat(&self) -> BTreeMap<u32, Amount> {
        self.seats
            .iter()
            .map(|seat| (seat.seat, seat.ev_net))
            .collect()
    }
}

/// `AllInEvOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllInEvOutcome {
    Applicable(AllInEv),
    Skipped {
        reason: AllInSkipReason,
        detail: String,
    },
}

impl AllInEvOutcome {
    /// The analysis, or `None` when the hand has none (`allInEv`).
    pub fn ev(&self) -> Option<&AllInEv> {
        match self {
            Self::Applicable(ev) => Some(ev),
            Self::Skipped { .. } => None,
        }
    }

    /// The skip reason, or `None` when applicable.
    pub fn reason(&self) -> Option<AllInSkipReason> {
        match self {
            Self::Applicable(_) => None,
            Self::Skipped { reason, .. } => Some(*reason),
        }
    }

    /// The outcome as JSON, the shape the EV goldens store
    /// (`tests/scripts/golden/ev.ts`): the TypeScript object with every
    /// equity written as `String(x)` (the shortest round-trip form of the
    /// double, so equal strings are equal doubles).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        match self {
            Self::Skipped { reason, detail } => {
                out.insert("applicable".to_owned(), Value::Bool(false));
                out.insert("reason".to_owned(), Value::from(reason.as_str()));
                out.insert("detail".to_owned(), Value::from(detail.clone()));
            }
            Self::Applicable(ev) => {
                out.insert("applicable".to_owned(), Value::Bool(true));
                out.insert("evVersion".to_owned(), Value::from(ev.ev_version));
                out.insert("street".to_owned(), Value::from(ev.street.as_str()));
                out.insert("actionIndex".to_owned(), Value::from(ev.action_index));
                out.insert(
                    "board".to_owned(),
                    Value::Array(ev.board.iter().cloned().map(Value::from).collect()),
                );
                out.insert("method".to_owned(), Value::from(ev.method.as_str()));
                out.insert("boards".to_owned(), Value::from(ev.boards));
                let pots = ev
                    .pots
                    .iter()
                    .map(|pot| {
                        let mut doc = Map::new();
                        doc.insert("amount".to_owned(), Value::from(pot.amount));
                        doc.insert("gross".to_owned(), Value::from(pot.gross));
                        doc.insert(
                            "eligibleSeats".to_owned(),
                            Value::Array(pot.eligible_seats.iter().map(|&s| s.into()).collect()),
                        );
                        doc.insert(
                            "equity".to_owned(),
                            Value::Array(
                                pot.equity
                                    .iter()
                                    .map(|x| Value::from(x.to_js_string()))
                                    .collect(),
                            ),
                        );
                        doc.insert(
                            "shares".to_owned(),
                            Value::Array(pot.shares.iter().map(|&s| s.into()).collect()),
                        );
                        Value::Object(doc)
                    })
                    .collect();
                out.insert("pots".to_owned(), Value::Array(pots));
                let seats = ev
                    .seats
                    .iter()
                    .map(|seat| {
                        let mut doc = Map::new();
                        doc.insert("seat".to_owned(), Value::from(seat.seat));
                        doc.insert("player".to_owned(), Value::from(seat.player.clone()));
                        doc.insert("live".to_owned(), Value::Bool(seat.live));
                        doc.insert("contributed".to_owned(), Value::from(seat.contributed));
                        doc.insert("evWon".to_owned(), Value::from(seat.ev_won));
                        doc.insert("evNet".to_owned(), Value::from(seat.ev_net));
                        Value::Object(doc)
                    })
                    .collect();
                out.insert("seats".to_owned(), Value::Array(seats));
            }
        }
        Value::Object(out)
    }
}

/* ------------------------------------------------------------- helpers - */

/// `GAMES[variant]`.
fn game_for(variant: Variant) -> Option<EquityGame> {
    match variant {
        Variant::Holdem => Some(EquityGame::Holdem),
        Variant::Shortdeck => Some(EquityGame::Shortdeck),
        Variant::Omaha => Some(EquityGame::Omaha),
        Variant::Omaha5 => Some(EquityGame::Omaha5),
        Variant::Omaha6 => Some(EquityGame::Omaha6),
        Variant::Stud | Variant::Razz | Variant::Draw | Variant::Other => None,
    }
}

/// `DEAD_POSTS`: forced money that does not count toward the bet to match.
fn is_dead_post(kind: ActionType) -> bool {
    matches!(kind, ActionType::Ante | ActionType::BombAnte)
}

/// `BETTING`: action types that can put chips in or take a player out.
fn is_betting(kind: ActionType) -> bool {
    matches!(
        kind,
        ActionType::Ante
            | ActionType::SmallBlind
            | ActionType::BigBlind
            | ActionType::Straddle
            | ActionType::Post
            | ActionType::MissedBlind
            | ActionType::BombAnte
            | ActionType::Fold
            | ActionType::Call
            | ActionType::Bet
            | ActionType::Raise
    )
}

fn skip(reason: AllInSkipReason, detail: impl Into<String>) -> AllInEvOutcome {
    AllInEvOutcome::Skipped {
        reason,
        detail: detail.into(),
    }
}

/// `contributions(hand)`: chips each seat put in, net of uncalled returns
/// (the arithmetic of `contributedBySeat` in `stats/money.ts`). A `Map` in
/// the TypeScript; only its values are ever iterated, as sums, so key order
/// does not matter.
fn contributions(hand: &PhfHand) -> BTreeMap<u32, Amount> {
    let mut out = BTreeMap::new();
    for action in &hand.actions {
        let Some(seat) = action.seat else {
            continue;
        };
        if action.amount == 0 {
            continue;
        }
        if matches!(action.kind, ActionType::Collect | ActionType::CashoutPay) {
            continue;
        }
        *out.entry(seat).or_insert(0) += action.amount;
    }
    out
}

/// `awardedTotal(hand)`: the collects, less the fees when the room wrote its
/// collect lines gross.
fn awarded_total(hand: &PhfHand) -> Amount {
    let collected: Amount = hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Collect && action.seat.is_some())
        .map(|action| action.amount)
        .sum();
    let fees = total_fees(&hand.results.fees);
    let pot = hand.results.total_pot;
    if fees > 0 && pot > 0 && (collected - pot).abs() < (collected - (pot - fees)).abs() {
        return collected - fees;
    }
    collected
}

/// JavaScript truthiness of a number: not `0`, `-0` or `NaN`.
fn truthy(value: JsNumber) -> bool {
    !value.is_nan() && value.compare(JsNumber::ZERO) != Some(std::cmp::Ordering::Equal)
}

/// The integer a `JsNumber` holds (every value converted here is a sum of
/// `Math.floor` results and ones; `-0` is 0).
fn integer(value: JsNumber) -> Amount {
    value.to_i64().unwrap_or(0)
}

/// `apportion(total, weights)`: `total` split in proportion to `weights`
/// so the parts sum to `total` exactly - floor every share, then hand the
/// remaining units to the largest fractional parts, ties to the lower index.
///
/// In doubles, as the TypeScript computes it: `Math.max(0, w)` summed left
/// to right, `(w * |total|) / sum`, `Math.floor`, `value - Math.floor(value)`
/// and the comparator `b.fraction - a.fraction || a.index - b.index`, each a
/// [`JsNumber`] operation. A negative total is split as its magnitude and
/// negated (the TypeScript's `sign * part` can be `-0`, which every caller
/// adds to something and so reads as 0).
pub fn apportion(total: Amount, weights: &[JsNumber]) -> Vec<Amount> {
    let zero = JsNumber::ZERO;
    let negative = total < 0;
    let magnitude = JsNumber::from_i64(total).abs();
    let clamped: Vec<JsNumber> = weights.iter().map(|&weight| zero.max_of(weight)).collect();
    let sum = clamped.iter().fold(zero, |acc, &weight| acc + weight);
    // `magnitude === 0 || sum <= 0` (a `NaN` sum goes on, as in JavaScript).
    if total == 0
        || matches!(
            sum.compare(zero),
            Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
        )
    {
        return vec![0; weights.len()];
    }
    let exact: Vec<JsNumber> = clamped
        .iter()
        .map(|&weight| (weight * magnitude) / sum)
        .collect();
    let mut parts: Vec<JsNumber> = exact.iter().map(|value| value.floor()).collect();
    let mut left = magnitude - parts.iter().fold(zero, |acc, &part| acc + part);
    let mut order: Vec<(usize, JsNumber)> = exact
        .iter()
        .enumerate()
        .map(|(index, &value)| (index, value - value.floor()))
        .collect();
    sort_by(&mut order, |a, b| {
        let by_fraction = b.1 - a.1;
        if truthy(by_fraction) {
            by_fraction
        } else {
            JsNumber::from_u64(u64::try_from(a.0).unwrap_or(u64::MAX))
                - JsNumber::from_u64(u64::try_from(b.0).unwrap_or(u64::MAX))
        }
    });
    let one = JsNumber::from_i64(1);
    for &(index, _) in &order {
        if !left.greater_than(zero) {
            break;
        }
        parts[index] = parts[index] + one;
        left = left - one;
    }
    parts
        .into_iter()
        .map(|part| {
            let part = integer(part);
            if negative { -part } else { part }
        })
        .collect()
}

/// `holeCardsOf(hand, seat, count)`: hole cards from wherever the hand
/// recorded them.
fn hole_cards_of(hand: &PhfHand, seat: u32, count: usize) -> Option<Vec<String>> {
    if let Some(player) = hand.players.iter().find(|player| player.seat == seat)
        && player.hole_cards.len() == count
    {
        return Some(player.hole_cards.clone());
    }
    if let Some(result) = hand.results.players.iter().find(|entry| entry.seat == seat)
        && result.shown_cards.len() == count
    {
        return Some(result.shown_cards.clone());
    }
    hand.actions
        .iter()
        .find(|action| {
            action.seat == Some(seat)
                && action.kind == ActionType::Show
                && action
                    .cards
                    .as_ref()
                    .is_some_and(|cards| cards.len() == count)
        })
        .and_then(|action| action.cards.clone())
}

/// The seats that appear in the action stream, ascending
/// (`[...new Set(seats)].sort((a, b) => a - b)`).
fn seats_in_play(hand: &PhfHand) -> Vec<u32> {
    let mut seats: Vec<u32> = Vec::new();
    for action in &hand.actions {
        if let Some(seat) = action.seat
            && !seats.contains(&seat)
        {
            seats.push(seat);
        }
    }
    sort_by(&mut seats, |a, b| {
        JsNumber::from_u64(u64::from(*a)) - JsNumber::from_u64(u64::from(*b))
    });
    seats
}

/* ---------------------------------------------------------- the moment - */

struct AllInMoment<'h> {
    action: &'h PhfAction,
    /// Position of `action` in `hand.actions`.
    position: usize,
    live: Vec<u32>,
}

/// `findMoment(hand)`: the first action after which no live player has a
/// decision left.
fn find_moment(hand: &PhfHand) -> Option<AllInMoment<'_>> {
    let in_play = seats_in_play(hand);
    // `new Map(players.map(...))`: a later player on the same seat wins.
    let mut stacks: BTreeMap<u32, Amount> = BTreeMap::new();
    for player in &hand.players {
        stacks.insert(
            player.seat,
            player.starting_stack - seat_out_of_pot(hand, player.seat),
        );
    }
    let mut committed: BTreeMap<u32, Amount> = BTreeMap::new();
    let mut on_street: BTreeMap<u32, Amount> = BTreeMap::new();
    let mut all_in: BTreeSet<u32> = BTreeSet::new();
    let mut folded: BTreeSet<u32> = BTreeSet::new();
    let mut street: Option<Street> = None;

    for (position, action) in hand.actions.iter().enumerate() {
        let Some(seat) = action.seat else {
            continue;
        };
        if !is_betting(action.kind) {
            continue;
        }
        if street != Some(action.street) {
            street = Some(action.street);
            on_street.clear();
        }
        if action.kind == ActionType::Fold {
            folded.insert(seat);
        } else {
            let total = committed.get(&seat).copied().unwrap_or(0) + action.amount;
            committed.insert(seat, total);
            if !is_dead_post(action.kind) {
                *on_street.entry(seat).or_insert(0) += action.amount;
            }
            let stack = stacks.get(&seat).copied().unwrap_or(0);
            if action.all_in || (stack > 0 && total >= stack) {
                all_in.insert(seat);
            }
        }

        let live: Vec<u32> = in_play
            .iter()
            .copied()
            .filter(|entry| !folded.contains(entry))
            .collect();
        if live.len() < 2 {
            continue;
        }
        let open: Vec<u32> = live
            .iter()
            .copied()
            .filter(|entry| !all_in.contains(entry))
            .collect();
        if open.len() > 1 {
            continue;
        }
        if let [only] = open.as_slice() {
            let highest = live
                .iter()
                .map(|entry| on_street.get(entry).copied().unwrap_or(0))
                .max()
                .unwrap_or(0);
            if on_street.get(only).copied().unwrap_or(0) < highest {
                continue;
            }
        }
        return Some(AllInMoment {
            action,
            position,
            live,
        });
    }
    None
}

/* --------------------------------------------------------------- pots - */

struct Layer {
    gross: Amount,
    eligible: Vec<u32>,
}

/// `buildPots(contributed, live)`: one layer per distinct positive level a
/// live seat put in, each contested by the live seats that reached it.
fn build_pots(contributed: &BTreeMap<u32, Amount>, live: &[u32]) -> Vec<Layer> {
    let level_of = |seat: &u32| contributed.get(seat).copied().unwrap_or(0);
    let mut levels: Vec<Amount> = Vec::new();
    for amount in live.iter().map(level_of).filter(|&amount| amount > 0) {
        if !levels.contains(&amount) {
            levels.push(amount);
        }
    }
    sort_by(&mut levels, |a, b| {
        JsNumber::from_i64(*a) - JsNumber::from_i64(*b)
    });
    let mut pots: Vec<Layer> = Vec::with_capacity(levels.len());
    let mut previous: Amount = 0;
    for &level in &levels {
        let gross: Amount = contributed
            .values()
            .map(|&amount| 0.max(amount.min(level) - amount.min(previous)))
            .sum();
        pots.push(Layer {
            gross,
            eligible: live
                .iter()
                .copied()
                .filter(|seat| level_of(seat) >= level)
                .collect(),
        });
        previous = level;
    }
    let above: Amount = contributed
        .values()
        .map(|&amount| 0.max(amount - previous))
        .sum();
    if above > 0
        && let Some(last) = pots.last_mut()
    {
        last.gross += above;
    }
    pots
}

/* ---------------------------------------------------------------- api - */

/// `analyzeAllIn(hand, options)`: the full EV analysis of a hand, or the
/// reason there is none. Never fails for a hand that parsed: everything a
/// real hand can get wrong is a skip reason.
pub fn analyze_all_in(hand: &PhfHand, options: &EquityOptions) -> AllInEvOutcome {
    if hand.game.hi_lo {
        return skip(AllInSkipReason::HiLo, "split-pot games are not evaluated");
    }
    let Some(game) = game_for(hand.game.variant) else {
        return skip(
            AllInSkipReason::UnsupportedVariant,
            format!("variant {}", hand.game.variant.as_str()),
        );
    };
    let Some(moment) = find_moment(hand) else {
        return skip(
            AllInSkipReason::NoAllIn,
            "no action left two players without a decision",
        );
    };
    let street = moment.action.street;
    if !matches!(street, Street::Preflop | Street::Flop | Street::Turn) {
        return skip(
            AllInSkipReason::NoStreetToCome,
            format!("all-in completed on the {}", street.as_str()),
        );
    }
    // A second runout with a flop of its own: two boards dealt up front.
    let first_flop = hand
        .board
        .runouts
        .first()
        .and_then(|run| run.flop.as_ref())
        .map(|flop| flop.join(" "))
        .unwrap_or_default();
    let second_flop = hand.board.runouts.iter().any(|run| {
        run.flop
            .as_ref()
            .is_some_and(|flop| flop.join(" ") != first_flop)
    });
    let double_board = hand
        .game
        .bomb_pot
        .as_ref()
        .is_some_and(|bomb| bomb.double_board);
    if second_flop && (street != Street::Preflop || double_board) {
        return skip(
            AllInSkipReason::DoubleBoard,
            "a second flop was dealt before the all-in",
        );
    }

    for action in &hand.actions[moment.position + 1..] {
        if action.seat.is_none() {
            continue;
        }
        if is_betting(action.kind) && (action.amount != 0 || action.kind == ActionType::Fold) {
            return skip(
                AllInSkipReason::ActionAfterAllIn,
                format!(
                    "{} {} after the all-in at #{}",
                    action.player,
                    action.kind.as_str(),
                    moment.action.index
                ),
            );
        }
    }

    let hole_count = hole_cards_for(game);
    let mut hands: Vec<Vec<String>> = Vec::with_capacity(moment.live.len());
    let mut unknown: Vec<String> = Vec::new();
    for &seat in &moment.live {
        match hole_cards_of(hand, seat, hole_count) {
            Some(cards) => hands.push(cards),
            None => unknown.push(seat.to_string()),
        }
    }
    if !unknown.is_empty() {
        return skip(
            AllInSkipReason::UnknownHoleCards,
            format!("no hole cards for seat {}", unknown.join(", ")),
        );
    }

    let board_size = match street {
        Street::Preflop => 0,
        Street::Flop => 3,
        _ => 4,
    };
    let board = if street == Street::Preflop {
        Vec::new()
    } else {
        runout_through_street(&hand.board, 0, street)
    };
    if board.len() != board_size {
        return skip(
            AllInSkipReason::UnknownBoard,
            format!("{} board cards on the {}", board.len(), street.as_str()),
        );
    }

    let contributed = contributions(hand);
    let mut layers = build_pots(&contributed, &moment.live);
    if layers.is_empty() {
        return skip(AllInSkipReason::NoAllIn, "the live players put no chips in");
    }

    // The house drop belongs to the main pot; the fees come off every pot
    // at the same rate.
    layers[0].gross += house_into_pot(hand);
    let gross_total: Amount = layers.iter().map(|layer| layer.gross).sum();
    let deductions = apportion(
        gross_total - awarded_total(hand),
        &layers
            .iter()
            .map(|layer| JsNumber::from_i64(layer.gross))
            .collect::<Vec<_>>(),
    );

    let index_of = |seat: u32| -> i64 {
        moment
            .live
            .iter()
            .position(|&entry| entry == seat)
            .and_then(|i| i64::try_from(i).ok())
            .unwrap_or(-1)
    };
    let request = EquityRequest {
        game,
        // Rooms disagree on trips against a straight in short deck; the room
        // the hand came from decides.
        short_deck_rule: (game == EquityGame::Shortdeck)
            .then(|| short_deck_rule_for(&hand.meta.site_id)),
        hands,
        board: board.clone(),
        dead: Vec::new(),
        pots: Some(
            layers
                .iter()
                .map(|layer| layer.eligible.iter().map(|&seat| index_of(seat)).collect())
                .collect(),
        ),
        options: *options,
    };
    let result = match equity(&request) {
        Ok(result) => result,
        Err(error) => return skip(AllInSkipReason::InvalidCards, error.0),
    };

    let mut won: BTreeMap<u32, Amount> = BTreeMap::new();
    let pots: Vec<EvPot> = layers
        .iter()
        .enumerate()
        .map(|(p, layer)| {
            let amount = layer.gross - deductions[p];
            let live_index = |seat: u32| usize::try_from(index_of(seat)).unwrap_or(0);
            let pot_equity: Vec<JsNumber> = layer
                .eligible
                .iter()
                .map(|&seat| result.pots[p][live_index(seat)])
                .collect();
            let equity_units: Vec<u64> = layer
                .eligible
                .iter()
                .map(|&seat| result.units[p][live_index(seat)])
                .collect();
            let shares = apportion(amount, &pot_equity);
            for (&seat, &share) in layer.eligible.iter().zip(&shares) {
                *won.entry(seat).or_insert(0) += share;
            }
            EvPot {
                amount,
                gross: layer.gross,
                eligible_seats: layer.eligible.clone(),
                equity: pot_equity,
                equity_units,
                shares,
            }
        })
        .collect();

    let seats: Vec<EvSeat> = seats_in_play(hand)
        .into_iter()
        .map(|seat| {
            let put = contributed.get(&seat).copied().unwrap_or(0);
            let ev_won = won.get(&seat).copied().unwrap_or(0);
            EvSeat {
                seat,
                player: hand
                    .players
                    .iter()
                    .find(|player| player.seat == seat)
                    .map(|player| player.name.clone())
                    .unwrap_or_default(),
                live: moment.live.contains(&seat),
                contributed: put,
                ev_won,
                ev_net: ev_won - put,
            }
        })
        .collect();

    AllInEvOutcome::Applicable(AllInEv {
        ev_version: EV_VERSION,
        street,
        action_index: moment.action.index,
        board,
        method: result.method,
        boards: result.boards,
        pots,
        seats,
    })
}

/// `allInEv(hand, options)`: the EV analysis, or `None` when the hand has
/// none and `ev_net = net`.
pub fn all_in_ev(hand: &PhfHand, options: &EquityOptions) -> Option<AllInEv> {
    match analyze_all_in(hand, options) {
        AllInEvOutcome::Applicable(ev) => Some(ev),
        AllInEvOutcome::Skipped { .. } => None,
    }
}

/// `evNetBySeat(hand, options)`: `evNet` per seat, or `None` when the hand
/// has no adjustment.
pub fn ev_net_by_seat(hand: &PhfHand, options: &EquityOptions) -> Option<BTreeMap<u32, Amount>> {
    all_in_ev(hand, options).map(|ev| ev.ev_net_by_seat())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weights(values: &[i64]) -> Vec<JsNumber> {
        values.iter().map(|&v| JsNumber::from_i64(v)).collect()
    }

    #[test]
    fn apportion_sums_to_the_total_and_keeps_the_sign() {
        assert_eq!(apportion(10, &weights(&[1, 1, 1])), vec![4, 3, 3]);
        assert_eq!(apportion(-10, &weights(&[1, 1, 1])), vec![-4, -3, -3]);
        assert_eq!(apportion(0, &weights(&[1, 2])), vec![0, 0]);
        assert_eq!(apportion(7, &weights(&[0, 0])), vec![0, 0]);
        assert_eq!(apportion(7, &weights(&[-3, 1])), vec![0, 7]);
    }
}
