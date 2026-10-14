//! Per-seat decision events (docs/RAIL-PLAN.md R2.10, amendment A11;
//! docs/STATS-SPEC.md §14.1): every decision of a hand, with the betting
//! state it was made in, read from the same [`StatsContext`] the counters
//! walk - the same decisions (§3: `fold`, `check`, `call`, `bet`, `raise`),
//! the same raise levels (a straddle is a blind), the same preflop
//! aggressor, continuation-bet chain and steal attempt. A custom statistic
//! ([`crate::custom`]) is a filter over these.
//!
//! Nothing here changes a counter: the counters do not read events, and
//! [`hand_events`] builds its own context.
//!
//! Sizes are integers in **thousandths** (of a big blind, or of a
//! percentage point), rounded down; a size the hand cannot give (no big
//! blind, an empty pot) is `None`.

use rail_core::phf::{ActionType, Amount, PhfHand, Position, Street, is_posting_action};

use crate::context::{Decision, StatsContext, build_context};
use crate::derive::positioned;
use crate::money::{money_by_seat, money_for};
use crate::postflop::{CbetLink, cbet_chain};
use crate::preflop::steal_attempt;

/// What a decision faced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Facing {
    /// Preflop: an unopened pot (only blinds and straddles, no limper).
    /// Postflop: nothing bet yet on the street.
    None,
    /// Preflop: one or more players limped (called) and nobody raised.
    Limp,
    /// Postflop: a bet, not raised.
    Bet,
    /// A voluntary raise (preflop: the open or more; postflop: a raise of a
    /// bet).
    Raise,
}

/// One decision of one seat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionEvent {
    pub street: Street,
    /// `Fold`, `Check`, `Call`, `Bet` or `Raise`.
    pub action: ActionType,
    /// The action put the seat all in.
    pub all_in: bool,
    pub facing: Facing,
    /// Voluntary raises already made on this street (`raises_before`).
    pub raise_level: u32,
    /// Preflop with no raise yet: players who limped before. 0 otherwise.
    pub limpers: u32,
    /// Calls since the last bet or raise on this street.
    pub callers: u32,
    /// The seat's first decision on this street.
    pub first_on_street: bool,
    /// The seat's first decision on this street at this raise level.
    pub first_at_level: bool,
    /// The seat checked earlier on this street.
    pub checked_before: bool,
    /// The level this seat's latest raise on this street made (1: it
    /// opened, 2: it 3-bet, ...); 0 if it has not raised on this street.
    pub own_raise: u32,
    /// Preflop: the hand's steal attempt (STATS-SPEC §6.1) was made by
    /// another seat, and it is still the only raise.
    pub facing_steal: bool,
    /// The preflop raiser's continuation bet on this street was made by
    /// another seat before this decision, and nobody has raised since.
    pub facing_cbet: bool,
    /// The continuation bets of earlier streets, each called and not
    /// raised, in an unbroken chain from the flop (0-2; STATS-SPEC §4.4).
    pub barrels: u32,
    /// The seat made the last bet or raise of the previous street (on the
    /// flop: the preflop raiser). Preflop: false.
    pub initiative: bool,
    /// The previous street's aggressor is another seat, still in the hand
    /// on this street, that has not acted on it yet. Preflop: false.
    pub ahead_of_aggressor: bool,
    /// Postflop: the seat is the last to make its first decision on this
    /// street. `None` preflop.
    pub in_position: Option<bool>,
    /// Seats still in the hand when the street began (all-in seats
    /// included).
    pub players: u32,
    /// The pot before this decision, thousandths of a big blind.
    pub pot_bb: Option<i64>,
    /// A call, bet or raise: the seat's total on this street after it
    /// (the "to" of a raise), thousandths of a big blind.
    pub size_bb: Option<i64>,
    /// A bet: its chips as a percentage of the pot before it. A raise: the
    /// chips over the call, as a percentage of the pot after the call.
    /// Thousandths of a percentage point.
    pub size_pot: Option<i64>,
    /// The `size_pot` of the last bet or raise on this street before this
    /// decision; `None` when nothing voluntary was bet yet.
    pub facing_size_pot: Option<i64>,
}

/// A seat and its decisions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatEvents {
    pub seat: u32,
    pub hero: bool,
    pub position: Option<Position>,
    /// Posted a blind, a dead post, a missed blind or a straddle.
    pub posted_blind: bool,
    /// The big blind (the first `big-blind` poster; a button blind too).
    pub big_blind: bool,
    /// The last preflop raiser.
    pub preflop_aggressor: bool,
    /// Starting stack, thousandths of a big blind.
    pub stack_bb: Option<i64>,
    /// The smaller of the seat's starting stack and the largest other
    /// dealt-in seat's, thousandths of a big blind.
    pub effective_bb: Option<i64>,
    /// Still in the hand when the street was dealt (`flop_seen`, ...).
    pub saw_flop: bool,
    pub saw_turn: bool,
    pub saw_river: bool,
    /// Two or more seats never folded, and this is one (`wtsd`).
    pub showdown: bool,
    /// Collected chips from a pot (`wwsf`'s "won").
    pub won: bool,
    pub events: Vec<DecisionEvent>,
}

/// One hand's events: per dealt-in seat, in [`crate::rows_for`]'s order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandEvents {
    pub bomb_pot: bool,
    pub straddle: bool,
    pub button_blind: bool,
    pub walk: bool,
    /// Seats dealt in.
    pub dealt: u32,
    pub max_seats: u32,
    /// Voluntary preflop raises (0: limped pot, 1: single raised, 2: 3-bet
    /// pot, ...).
    pub preflop_raises: u32,
    pub seats: Vec<SeatEvents>,
}

/// `amount * 1000 / unit`, rounded down; `None` unless `unit > 0` and
/// `amount >= 0`.
fn thousandths_of(amount: i128, unit: i128) -> Option<i64> {
    if unit <= 0 || amount < 0 {
        return None;
    }
    i64::try_from(amount * 1000 / unit).ok()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The betting state of the stream before each action: the pot, and per
/// seat the street total.
struct Money {
    pot: Amount,
    street: Option<Street>,
    totals: Vec<(u32, Amount)>,
    /// The `size_pot` of the last voluntary bet or raise on the street.
    last_size: Option<i64>,
}

impl Money {
    fn total(&self, seat: u32) -> Amount {
        self.totals
            .iter()
            .find(|(candidate, _)| *candidate == seat)
            .map_or(0, |(_, total)| *total)
    }

    fn high(&self) -> Amount {
        self.totals
            .iter()
            .map(|(_, total)| *total)
            .max()
            .unwrap_or(0)
    }

    fn set(&mut self, seat: u32, total: Amount) {
        match self
            .totals
            .iter_mut()
            .find(|(candidate, _)| *candidate == seat)
        {
            Some(entry) => entry.1 = total,
            None => self.totals.push((seat, total)),
        }
    }
}

/// The size facts of one action, from the state before it.
struct Sizes {
    pot_bb: Option<i64>,
    size_bb: Option<i64>,
    size_pot: Option<i64>,
    facing_size_pot: Option<i64>,
}

fn sizes(
    money: &Money,
    seat: u32,
    kind: ActionType,
    amount: Amount,
    total: Amount,
    bb: Amount,
) -> Sizes {
    let (bb, pot) = (i128::from(bb), i128::from(money.pot));
    let size_bb = matches!(kind, ActionType::Call | ActionType::Bet | ActionType::Raise)
        .then(|| thousandths_of(i128::from(total), bb))
        .flatten();
    let size_pot = match kind {
        ActionType::Bet => thousandths_of(i128::from(amount) * 100, pot),
        ActionType::Raise => {
            let high = i128::from(money.high());
            let call = high - i128::from(money.total(seat));
            thousandths_of((i128::from(total) - high) * 100, pot + call)
        }
        _ => None,
    };
    Sizes {
        pot_bb: thousandths_of(pot, bb),
        size_bb,
        size_pot,
        facing_size_pot: money.last_size,
    }
}

/// The aggressor of the street before `street` (the flop's is the preflop
/// raiser); `None` preflop.
fn previous_aggressor(context: &StatsContext<'_>, street: Street) -> Option<u32> {
    match street {
        Street::Flop => context.preflop_aggressor,
        Street::Turn => context.aggressor_on(Street::Flop),
        Street::River => context.aggressor_on(Street::Turn),
        _ => None,
    }
}

/// Called continuation bets before `street`, in an unbroken chain.
fn barrels_before(chain: &std::collections::BTreeMap<Street, CbetLink>, street: Street) -> u32 {
    let mut barrels = 0;
    for earlier in [Street::Flop, Street::Turn] {
        if earlier >= street {
            break;
        }
        let link = chain.get(&earlier).copied().unwrap_or_default();
        if link.made.is_none() || !link.called {
            break;
        }
        barrels += 1;
    }
    barrels
}

/// Every seat's decision events in one hand (positions assigned first when
/// the hand has none, as [`crate::hand_facts`] does).
pub fn hand_events(hand: &PhfHand) -> HandEvents {
    let hand = positioned(hand);
    events_of(&hand)
}

fn events_of(hand: &PhfHand) -> HandEvents {
    let context = build_context(hand);
    let money = money_by_seat(&context);
    let chain = cbet_chain(&context);
    let steal = steal_attempt(&context).map(|decision| (decision.seat, decision.order));
    let bb = context.big_blind;

    // The size facts of every decision, from one walk of the stream.
    let mut sized: Vec<Option<Sizes>> = Vec::with_capacity(context.decisions.len());
    {
        let mut state = Money {
            pot: 0,
            street: None,
            totals: Vec::new(),
            last_size: None,
        };
        let mut next = context.decisions.iter().peekable();
        for (index, action) in hand.actions.iter().enumerate() {
            if state.street != Some(action.street) {
                state.street = Some(action.street);
                state.totals.clear();
                state.last_size = None;
            }
            let decision = next.next_if(|decision| decision.action_index == index);
            let seat = action.seat;
            if let (Some(decision), Some(seat)) = (decision, seat) {
                let facts = sizes(
                    &state,
                    seat,
                    decision.kind,
                    action.amount,
                    action.street_total,
                    bb,
                );
                let size_pot = facts.size_pot;
                sized.push(Some(facts));
                if matches!(decision.kind, ActionType::Bet | ActionType::Raise) {
                    state.last_size = size_pot;
                }
            }
            let moves_chips = is_posting_action(action.kind)
                || matches!(
                    action.kind,
                    ActionType::Call | ActionType::Bet | ActionType::Raise | ActionType::Uncalled
                );
            if moves_chips {
                state.pot += action.amount;
            }
            if let Some(seat) = seat
                && (matches!(
                    action.kind,
                    ActionType::Call | ActionType::Bet | ActionType::Raise
                ) || (is_posting_action(action.kind)
                    && !matches!(action.kind, ActionType::Ante | ActionType::BombAnte)))
            {
                state.set(seat, action.street_total);
            }
        }
        // A decision whose action was not found (never: decisions come from
        // the stream) gets no sizes rather than another's.
        sized.resize_with(context.decisions.len(), || None);
    }

    // Who makes the last first decision on each postflop street.
    let last_first = |street: Street| -> Option<u32> {
        let mut seen: Vec<u32> = Vec::new();
        for decision in context.street(street) {
            if !seen.contains(&decision.seat) {
                seen.push(decision.seat);
            }
        }
        seen.last().copied()
    };
    let last_to_act: Vec<(Street, Option<u32>)> = [Street::Flop, Street::Turn, Street::River]
        .into_iter()
        .map(|street| (street, last_first(street)))
        .collect();
    let players_on = |street: Street| -> u32 {
        if street == Street::Preflop {
            return count(context.dealt_in_seats.len());
        }
        count(
            context
                .dealt_in_seats
                .iter()
                .filter(|seat| context.live_on_street(**seat, street))
                .count(),
        )
    };

    let stacks: Vec<(u32, Amount)> = context
        .dealt_in_seats
        .iter()
        .map(|&seat| {
            let stack = context
                .players
                .get(&seat)
                .map_or(0, |player| player.starting_stack);
            (seat, stack)
        })
        .collect();

    let event = |decision: &Decision, mine: &[&Decision]| -> DecisionEvent {
        let seat = decision.seat;
        let street = decision.street;
        let earlier: Vec<&&Decision> = mine
            .iter()
            .filter(|other| other.street == street && other.order < decision.order)
            .collect();
        let facing = if street == Street::Preflop {
            if decision.raises_before >= 1 {
                Facing::Raise
            } else if decision.entered_before.is_empty() {
                Facing::None
            } else {
                Facing::Limp
            }
        } else if decision.raises_before >= 1 {
            Facing::Raise
        } else if decision.bets_before >= 1 {
            Facing::Bet
        } else {
            Facing::None
        };
        let own_raise = earlier
            .iter()
            .rev()
            .find(|other| other.kind == ActionType::Raise)
            .map_or(0, |other| other.raises_before + 1);
        let facing_steal = street == Street::Preflop
            && decision.raises_before == 1
            && steal.is_some_and(|(stealer, order)| stealer != seat && decision.order > order);
        let link = chain.get(&street).copied().unwrap_or_default();
        let facing_cbet = street != Street::Preflop
            && Some(seat) != context.preflop_aggressor
            && link
                .made
                .is_some_and(|cbet| decision.order > cbet && decision.raises_before == 0);
        let previous = previous_aggressor(&context, street);
        let ahead_of_aggressor = previous.is_some_and(|aggressor| {
            aggressor != seat
                && context.live_on_street(aggressor, street)
                && !context
                    .street(street)
                    .any(|other| other.seat == aggressor && other.order < decision.order)
        });
        let in_position = (street != Street::Preflop).then(|| {
            last_to_act
                .iter()
                .find(|(candidate, _)| *candidate == street)
                .and_then(|(_, last)| *last)
                == Some(seat)
        });
        let facts = sized.get(decision.order).and_then(Option::as_ref);
        DecisionEvent {
            street,
            action: decision.kind,
            all_in: hand
                .actions
                .get(decision.action_index)
                .is_some_and(|action| action.all_in),
            facing,
            raise_level: decision.raises_before,
            limpers: if street == Street::Preflop && decision.raises_before == 0 {
                count(decision.entered_before.len())
            } else {
                0
            },
            callers: decision.callers_since_aggression,
            first_on_street: decision.first_on_street,
            first_at_level: !earlier
                .iter()
                .any(|other| other.raises_before == decision.raises_before),
            checked_before: decision.checked_before,
            own_raise,
            facing_steal,
            facing_cbet,
            barrels: if street == Street::Preflop {
                0
            } else {
                barrels_before(&chain, street)
            },
            initiative: previous == Some(seat),
            ahead_of_aggressor,
            in_position,
            players: players_on(street),
            pot_bb: facts.and_then(|f| f.pot_bb),
            size_bb: facts.and_then(|f| f.size_bb),
            size_pot: facts.and_then(|f| f.size_pot),
            facing_size_pot: facts.and_then(|f| f.facing_size_pot),
        }
    };

    let seats = context
        .dealt_in_seats
        .iter()
        .map(|&seat| {
            let player = context.players.get(&seat).copied();
            let mine: Vec<&Decision> = context
                .decisions
                .iter()
                .filter(|decision| decision.seat == seat)
                .collect();
            let events = mine.iter().map(|decision| event(decision, &mine)).collect();
            let stack = player.map_or(0, |player| player.starting_stack);
            let others = stacks
                .iter()
                .filter(|(other, _)| *other != seat)
                .map(|(_, stack)| *stack)
                .max();
            let effective = others.map_or(stack, |other| other.min(stack));
            SeatEvents {
                seat,
                hero: player.is_some_and(|player| player.is_hero),
                position: context.position.get(&seat).copied().flatten(),
                posted_blind: context.blind_seats.contains(&seat),
                big_blind: context.big_blind_seat == Some(seat),
                preflop_aggressor: context.preflop_aggressor == Some(seat),
                stack_bb: thousandths_of(i128::from(stack), i128::from(bb)),
                effective_bb: thousandths_of(i128::from(effective), i128::from(bb)),
                saw_flop: context.live_on_street(seat, Street::Flop),
                saw_turn: context.live_on_street(seat, Street::Turn),
                saw_river: context.live_on_street(seat, Street::River),
                showdown: context.live_seats.len() >= 2 && context.live_seats.contains(&seat),
                won: money_for(&money, seat).is_some_and(|money| money.won > 0),
                events,
            }
        })
        .collect();

    HandEvents {
        bomb_pot: context.is_bomb_pot,
        straddle: context.has_straddle,
        button_blind: context.has_button_blind,
        walk: context.is_walk,
        dealt: count(context.dealt_in_seats.len()),
        max_seats: hand.table.max_seats,
        preflop_raises: count(
            context
                .street(Street::Preflop)
                .filter(|decision| decision.kind == ActionType::Raise)
                .count(),
        ),
        seats,
    }
}
