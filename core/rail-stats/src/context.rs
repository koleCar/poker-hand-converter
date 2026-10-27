//! The shared read of a hand every counter walks: `web/src/lib/stats/context.ts`.
//!
//! Two rules from the TypeScript govern it (docs/STATS-SPEC.md §3, §5): facts
//! come from the action stream, never from `game` (`game.straddles` and
//! `game.anteModel` are filled by two parsers of nineteen), and only `fold`,
//! `check`, `call`, `bet` and `raise` are decisions.
//!
//! Maps are `BTreeMap`s: the TypeScript's `Map`s are only ever looked up, never
//! iterated in an order that reaches a row, so any map gives the same rows,
//! and a B-tree needs no hasher (the crate builds for `wasm32`).

use std::collections::{BTreeMap, BTreeSet};

use rail_core::phf::{
    ActionType, Amount, AnteModel, PhfAction, PhfHand, PhfPlayer, Position, STREET_ORDER, Street,
    house_into_pot, is_button_blind, is_posting_action, resolve_runout, total_fees,
};

/// `POSTFLOP_STREETS`: the three streets with their own betting round after
/// the flop is dealt.
pub const POSTFLOP_STREETS: [Street; 3] = [Street::Flop, Street::Turn, Street::River];

/// `isDecision`: a seat chose something - `fold`, `check`, `call`, `bet` or
/// `raise`. Postings (forced money), `uncalled` (bookkeeping), and the
/// results (`show`, `muck`, `collect`, cashouts) are not.
pub fn is_decision(action: &PhfAction) -> bool {
    if action.seat.is_none() || is_posting_action(action.kind) {
        return false;
    }
    matches!(
        action.kind,
        ActionType::Fold
            | ActionType::Check
            | ActionType::Call
            | ActionType::Bet
            | ActionType::Raise
    )
}

/// `Decision`: one decision with the betting state immediately before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    /// Index into [`StatsContext::decisions`].
    pub order: usize,
    /// Index of the action in `hand.actions`.
    pub action_index: usize,
    pub seat: u32,
    pub street: Street,
    pub kind: ActionType,
    /// Voluntary raises already made on this street. A straddle is not one.
    pub raises_before: u32,
    /// Opening bets already made on this street.
    pub bets_before: u32,
    /// `raises_before + bets_before`.
    pub aggression_before: u32,
    /// Seats that had already voluntarily put chips in on this street, in
    /// the order they first did.
    pub entered_before: Vec<u32>,
    /// Calls since the last bet or raise on this street.
    pub callers_since_aggression: u32,
    /// The seat's first decision on this street.
    pub first_on_street: bool,
    /// The seat had already checked on this street.
    pub checked_before: bool,
}

/// `StatsContext`: everything the counters need to know about the shape of
/// the hand, decided once.
#[derive(Debug, Clone)]
pub struct StatsContext<'h> {
    pub hand: &'h PhfHand,
    pub big_blind: Amount,

    /// Seats dealt in, ascending (with duplicates when two players share a
    /// seat number, as in the TypeScript). One row per entry.
    pub dealt_in_seats: Vec<u32>,
    /// Seat to player; the last player with a seat number wins, as `Map.set`.
    pub players: BTreeMap<u32, &'h PhfPlayer>,
    pub position: BTreeMap<u32, Option<Position>>,
    /// Seats that posted a blind, a dead post, a missed blind or a straddle.
    pub blind_seats: BTreeSet<u32>,
    pub straddle_seats: BTreeSet<u32>,
    pub big_blind_seat: Option<u32>,
    pub small_blind_seat: Option<u32>,

    /// Every decision, in stream order.
    pub decisions: Vec<Decision>,
    /// Decision indexes per street, in stream order.
    pub by_street: BTreeMap<Street, Vec<usize>>,

    pub street_reached: Street,
    /// Postflop streets whose cards were dealt (or that carry actions).
    pub dealt: BTreeSet<Street>,

    /// The street of each seat's first fold.
    pub folded_on: BTreeMap<u32, Street>,
    /// Dealt-in seats that never folded.
    pub live_seats: Vec<u32>,

    /// Last seat to raise preflop; `None` in a limped pot.
    pub preflop_aggressor: Option<u32>,
    /// Last seat to bet or raise on each postflop street.
    pub street_aggressor: BTreeMap<Street, Option<u32>>,

    pub has_straddle: bool,
    pub has_button_blind: bool,
    pub is_bomb_pot: bool,
    pub ante_model: AnteModel,
    pub is_big_blind_ante: bool,
    pub is_run_it_twice: bool,
    pub has_cashout: bool,
    pub is_walk: bool,

    pub house_into_pot: Amount,
    pub fees: Amount,
}

/* ----------------------------------------------------------- hand shape - */

/// `dealtInSeatsOf`: seats that put a chip in or made a move; every seat
/// when fewer than two did.
fn dealt_in_seats_of(hand: &PhfHand) -> Vec<u32> {
    let acted: BTreeSet<u32> = hand
        .actions
        .iter()
        .filter_map(|action| action.seat)
        .collect();
    // `.sort((a, b) => a - b)`: numeric and stable, which for numbers is the
    // only order there is.
    let mut seated: Vec<u32> = hand.players.iter().map(|player| player.seat).collect();
    seated.sort_unstable();
    let dealt_in: Vec<u32> = seated
        .iter()
        .copied()
        .filter(|seat| acted.contains(seat))
        .collect();
    if dealt_in.len() >= 2 {
        dealt_in
    } else {
        seated
    }
}

/// `detectBombPot`: a `bomb-ante`, or two or more ante posters and no blind.
pub fn detect_bomb_pot(hand: &PhfHand) -> bool {
    if hand
        .actions
        .iter()
        .any(|action| action.kind == ActionType::BombAnte)
    {
        return true;
    }
    let mut ante_posters: BTreeSet<u32> = BTreeSet::new();
    let mut has_blind = false;
    for action in &hand.actions {
        if action.kind == ActionType::Ante
            && let Some(seat) = action.seat
        {
            ante_posters.insert(seat);
        }
        if matches!(action.kind, ActionType::SmallBlind | ActionType::BigBlind) {
            has_blind = true;
        }
    }
    ante_posters.len() >= 2 && !has_blind
}

/// `detectAnteModel`: one ante poster at a table of more than one dealt-in
/// seat is a big-blind ante.
pub fn detect_ante_model(hand: &PhfHand) -> AnteModel {
    let posters: BTreeSet<u32> = hand
        .actions
        .iter()
        .filter(|action| matches!(action.kind, ActionType::Ante | ActionType::BombAnte))
        .filter_map(|action| action.seat)
        .collect();
    if posters.is_empty() {
        return AnteModel::None;
    }
    let dealt_in = dealt_in_seats_of(hand).len();
    if posters.len() == 1 && dealt_in > 1 {
        AnteModel::BigBlindAnte
    } else {
        AnteModel::PostedPerPlayer
    }
}

/// `streetsDealt`: the widest runout, plus every postflop street that
/// carries an action.
fn streets_dealt(hand: &PhfHand) -> BTreeSet<Street> {
    let mut out = BTreeSet::new();
    let widest = (0..hand.board.runouts.len())
        .map(|index| resolve_runout(&hand.board, index).len())
        .max()
        .unwrap_or(0);
    if widest >= 3 {
        out.insert(Street::Flop);
    }
    if widest >= 4 {
        out.insert(Street::Turn);
    }
    if widest >= 5 {
        out.insert(Street::River);
    }
    for action in &hand.actions {
        if POSTFLOP_STREETS.contains(&action.street) {
            out.insert(action.street);
        }
    }
    out
}

/* ------------------------------------------------------- decision stream - */

fn build_decisions(hand: &PhfHand) -> Vec<Decision> {
    let mut out: Vec<Decision> = Vec::new();

    let mut street: Option<Street> = None;
    let mut raises = 0_u32;
    let mut bets = 0_u32;
    let mut entered: Vec<u32> = Vec::new();
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    let mut checked: BTreeSet<u32> = BTreeSet::new();
    let mut callers = 0_u32;

    for (action_index, action) in hand.actions.iter().enumerate() {
        if !is_decision(action) {
            continue;
        }
        let Some(seat) = action.seat else {
            continue;
        };
        if street != Some(action.street) {
            street = Some(action.street);
            raises = 0;
            bets = 0;
            entered = Vec::new();
            seen = BTreeSet::new();
            checked = BTreeSet::new();
            callers = 0;
        }
        out.push(Decision {
            order: out.len(),
            action_index,
            seat,
            street: action.street,
            kind: action.kind,
            raises_before: raises,
            bets_before: bets,
            aggression_before: raises + bets,
            entered_before: entered.clone(),
            callers_since_aggression: callers,
            first_on_street: !seen.contains(&seat),
            checked_before: checked.contains(&seat),
        });
        seen.insert(seat);
        match action.kind {
            ActionType::Raise => {
                raises += 1;
                callers = 0;
            }
            ActionType::Bet => {
                bets += 1;
                callers = 0;
            }
            ActionType::Call => callers += 1,
            ActionType::Check => {
                checked.insert(seat);
            }
            _ => {}
        }
        if matches!(
            action.kind,
            ActionType::Call | ActionType::Bet | ActionType::Raise
        ) && !entered.contains(&seat)
        {
            entered.push(seat);
        }
    }

    out
}

/* ------------------------------------------------------------- the build - */

/// `buildContext`, for a hand whose positions are already settled.
///
/// The TypeScript calls `assignPositions(hand)` here when every position is
/// null, mutating its argument; [`crate::hand_facts`] does that on a copy
/// before it gets here, so this function never writes to the hand.
pub fn build_context(hand: &PhfHand) -> StatsContext<'_> {
    let dealt_in_seats = dealt_in_seats_of(hand);
    let mut players = BTreeMap::new();
    let mut position = BTreeMap::new();
    for player in &hand.players {
        players.insert(player.seat, player);
        position.insert(player.seat, player.position);
    }

    let mut blind_seats = BTreeSet::new();
    let mut straddle_seats = BTreeSet::new();
    for action in &hand.actions {
        let Some(seat) = action.seat else {
            continue;
        };
        if matches!(
            action.kind,
            ActionType::SmallBlind
                | ActionType::BigBlind
                | ActionType::Post
                | ActionType::MissedBlind
        ) {
            blind_seats.insert(seat);
        }
        if action.kind == ActionType::Straddle {
            straddle_seats.insert(seat);
            blind_seats.insert(seat);
        }
    }

    let decisions = build_decisions(hand);
    let mut by_street: BTreeMap<Street, Vec<usize>> = BTreeMap::new();
    for decision in &decisions {
        by_street
            .entry(decision.street)
            .or_default()
            .push(decision.order);
    }

    let mut folded_on: BTreeMap<u32, Street> = BTreeMap::new();
    for decision in &decisions {
        if decision.kind == ActionType::Fold {
            folded_on.entry(decision.seat).or_insert(decision.street);
        }
    }
    let live_seats: Vec<u32> = dealt_in_seats
        .iter()
        .copied()
        .filter(|seat| !folded_on.contains_key(seat))
        .collect();

    let on_street = |street: Street| {
        by_street
            .get(&street)
            .into_iter()
            .flatten()
            .map(|&order| &decisions[order])
    };

    // The last raise: searched from the end, which finds the same one.
    let preflop_aggressor = on_street(Street::Preflop)
        .rev()
        .find(|decision| decision.kind == ActionType::Raise)
        .map(|decision| decision.seat);

    let mut street_aggressor = BTreeMap::new();
    for street in POSTFLOP_STREETS {
        let last = on_street(street)
            .rev()
            .find(|decision| matches!(decision.kind, ActionType::Bet | ActionType::Raise))
            .map(|decision| decision.seat);
        street_aggressor.insert(street, last);
    }

    let dealt = streets_dealt(hand);
    let street_reached = if dealt.contains(&Street::River) {
        Street::River
    } else if dealt.contains(&Street::Turn) {
        Street::Turn
    } else if dealt.contains(&Street::Flop) {
        Street::Flop
    } else {
        Street::Preflop
    };

    let ante_model = detect_ante_model(hand);
    let is_bomb_pot = detect_bomb_pot(hand);

    let big_blind_seat = hand
        .actions
        .iter()
        .find(|action| action.kind == ActionType::BigBlind && action.seat.is_some())
        .and_then(|action| action.seat);
    let small_blind_seat = hand
        .actions
        .iter()
        .find(|action| action.kind == ActionType::SmallBlind && action.seat.is_some())
        .and_then(|action| action.seat);
    // A walk: a big blind was posted, every preflop decision is a fold, and
    // none of them is the big blind's.
    let preflop_count = on_street(Street::Preflop).count();
    let is_walk = !is_bomb_pot
        && big_blind_seat.is_some()
        && preflop_count > 0
        && on_street(Street::Preflop).all(|decision| {
            decision.kind == ActionType::Fold && Some(decision.seat) != big_blind_seat
        });

    StatsContext {
        hand,
        big_blind: hand.game.big_blind,
        dealt_in_seats,
        players,
        position,
        blind_seats,
        straddle_seats,
        big_blind_seat,
        small_blind_seat,
        by_street,
        decisions,
        street_reached,
        dealt,
        folded_on,
        live_seats,
        preflop_aggressor,
        street_aggressor,
        has_straddle: hand
            .actions
            .iter()
            .any(|action| action.kind == ActionType::Straddle),
        has_button_blind: hand.actions.iter().any(is_button_blind),
        is_bomb_pot,
        ante_model,
        is_big_blind_ante: ante_model == AnteModel::BigBlindAnte,
        is_run_it_twice: hand.board.runouts.len() > 1,
        has_cashout: hand.actions.iter().any(|action| {
            matches!(
                action.kind,
                ActionType::CashoutChoose | ActionType::CashoutPay
            )
        }),
        is_walk,
        house_into_pot: house_into_pot(hand),
        fees: total_fees(&hand.results.fees),
    }
}

/* ----------------------------------------------------------------- utils - */

impl StatsContext<'_> {
    /// Decisions on a street, in stream order.
    pub fn street(&self, street: Street) -> impl Iterator<Item = &Decision> + '_ {
        self.by_street
            .get(&street)
            .into_iter()
            .flatten()
            .map(|&order| &self.decisions[order])
    }

    /// `seatStreet`: the seat's decisions on a street, in order.
    pub fn seat_street(&self, seat: u32, street: Street) -> Vec<&Decision> {
        self.street(street)
            .filter(|decision| decision.seat == seat)
            .collect()
    }

    /// `firstDecision`: the seat's first decision on a street.
    pub fn first_decision(&self, seat: u32, street: Street) -> Option<&Decision> {
        self.street(street).find(|decision| decision.seat == seat)
    }

    /// `liveOnStreet`: the street was dealt and the seat had not folded
    /// before it.
    pub fn live_on_street(&self, seat: u32, street: Street) -> bool {
        if !self.dealt.contains(&street) {
            return false;
        }
        let Some(folded) = self.folded_on.get(&seat) else {
            return true;
        };
        street_index(*folded) >= street_index(street)
    }

    /// The street aggressor of a postflop street (`streetAggressor.get`).
    pub fn aggressor_on(&self, street: Street) -> Option<u32> {
        self.street_aggressor.get(&street).copied().flatten()
    }
}

/// `["preflop", "flop", "turn", "river", "showdown"].indexOf(street)`.
fn street_index(street: Street) -> usize {
    STREET_ORDER
        .iter()
        .position(|candidate| *candidate == street)
        .unwrap_or(0)
}
