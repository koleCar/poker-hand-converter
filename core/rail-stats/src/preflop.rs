//! Preflop counters: `web/src/lib/stats/preflop.ts`.
//!
//! A preflop opportunity is 0 or 1 per hand, counted at the seat's first
//! qualifying decision; the raise level (voluntary raises only - a straddle
//! is a blind, PT4's call) is the spine (docs/STATS-SPEC.md §3.1, §4.1).

use rail_core::phf::{ActionType, Position, Street};

use crate::context::{Decision, StatsContext};
use crate::counters::{Counter, SeatCounters};

/// `STEAL_POSITIONS`.
fn is_steal_position(position: Option<Position>) -> bool {
    matches!(position, Some(Position::Co | Position::Btn | Position::Sb))
}

/// `leg`: facing a bet there are three replies. A `bet` counts as the
/// raise leg, as in the TypeScript.
fn leg(counters: &mut SeatCounters, decision: &Decision, legs: [Counter; 3]) {
    let [fold, call, raise] = legs;
    match decision.kind {
        ActionType::Fold => counters[fold] += 1,
        ActionType::Call => counters[call] += 1,
        ActionType::Raise | ActionType::Bet => counters[raise] += 1,
        _ => {}
    }
}

/// `stealPossible`: no bomb pot, no straddle, no button blind, three or more
/// dealt in (docs/STATS-SPEC.md §4.5).
fn steal_possible(context: &StatsContext<'_>) -> bool {
    !context.is_bomb_pot
        && !context.has_straddle
        && !context.has_button_blind
        && context.dealt_in_seats.len() >= 3
}

fn is_steal_attempt(context: &StatsContext<'_>, decision: &Decision) -> bool {
    if !steal_possible(context) {
        return false;
    }
    if decision.street != Street::Preflop || decision.kind != ActionType::Raise {
        return false;
    }
    if decision.raises_before != 0 || !decision.entered_before.is_empty() {
        return false;
    }
    is_steal_position(context.position.get(&decision.seat).copied().flatten())
}

/// `stealAttempt`: the hand's steal attempt, if there was one.
pub fn steal_attempt<'c>(context: &'c StatsContext<'_>) -> Option<&'c Decision> {
    context
        .street(Street::Preflop)
        .find(|decision| is_steal_attempt(context, decision))
}

/// `preflopCounters`: every preflop counter for one seat.
pub fn preflop_counters(context: &StatsContext<'_>, seat: u32, counters: &mut SeatCounters) {
    use Counter as C;

    // A bomb pot has no preflop betting round (§8).
    if context.is_bomb_pot {
        return;
    }

    let decisions = context.seat_street(seat, Street::Preflop);

    // A walk gives the big blind no opportunity at all (PT4, §4.2) - an
    // explicit guard, so a printed "checks" for the walked blind changes
    // nothing.
    if context.is_walk && Some(seat) == context.big_blind_seat {
        return;
    }
    let Some(&first) = decisions.first() else {
        return;
    };

    counters[C::vpip_opp] = 1;
    counters[C::pfr_opp] = 1;
    for decision in &decisions {
        if matches!(
            decision.kind,
            ActionType::Call | ActionType::Bet | ActionType::Raise
        ) {
            counters[C::vpip] = 1;
        }
        if decision.kind == ActionType::Raise {
            counters[C::pfr] = 1;
        }
    }

    /* ------------------------------------------------- the unopened spectrum - */

    let unopened = first.raises_before == 0 && first.entered_before.is_empty();
    let limpers_in = first.raises_before == 0 && !first.entered_before.is_empty();

    if unopened {
        counters[C::rfi_opp] = 1;
        if first.kind == ActionType::Raise {
            counters[C::rfi] = 1;
        }
    }
    if limpers_in {
        counters[C::iso_opp] = 1;
        if first.kind == ActionType::Raise {
            counters[C::iso] = 1;
        }
    }
    if first.raises_before == 0 && first.kind != ActionType::Check {
        counters[C::limp_opp] = 1;
        if first.kind == ActionType::Call {
            counters[C::limp] = 1;
        }
    }

    /* -------------------------------------------------------- steal attempts - */

    if unopened
        && steal_possible(context)
        && is_steal_position(context.position.get(&seat).copied().flatten())
    {
        counters[C::steal_opp] = 1;
        if first.kind == ActionType::Raise {
            counters[C::steal] = 1;
        }
    }

    if let Some(steal) = steal_attempt(context)
        && steal.seat != seat
        && context.blind_seats.contains(&seat)
    {
        // The first decision after the attempt with nobody having re-raised,
        // and it must be the seat's first decision of the hand.
        let facing = decisions
            .iter()
            .find(|decision| decision.order > steal.order && decision.raises_before == 1);
        if let Some(facing) = facing
            && facing.order == first.order
        {
            counters[C::fold_to_steal_opp] = 1;
            leg(
                counters,
                facing,
                [C::fold_to_steal, C::call_steal, C::three_bet_vs_steal],
            );
        }
    }

    /* ----------------------------------------------------------- raise levels - */

    if !context.blind_seats.contains(&seat) && first.raises_before >= 1 {
        counters[C::cold_call_opp] = 1;
        if first.kind == ActionType::Call {
            counters[C::cold_call] = 1;
        }
    }

    let at_level = |level: u32| -> Option<&Decision> {
        decisions
            .iter()
            .copied()
            .find(|decision| decision.raises_before == level)
    };

    let facing_open = at_level(1);
    if let Some(facing_open) = facing_open {
        counters[C::three_bet_opp] = 1;
        if facing_open.kind == ActionType::Raise {
            counters[C::three_bet] = 1;
        }
        if facing_open.callers_since_aggression >= 1 {
            counters[C::squeeze_opp] = 1;
            if facing_open.kind == ActionType::Raise {
                counters[C::squeeze] = 1;
            }
        }
    }

    let facing_three_bet = at_level(2);
    if let Some(facing_three_bet) = facing_three_bet {
        counters[C::four_bet_opp] = 1;
        if facing_three_bet.kind == ActionType::Raise {
            counters[C::four_bet] = 1;
        }
    }

    let facing_four_bet = at_level(3);
    if let Some(facing_four_bet) = facing_four_bet {
        counters[C::five_bet_opp] = 1;
        if facing_four_bet.kind == ActionType::Raise {
            counters[C::five_bet] = 1;
        }
    }

    /* ------------------------------------------- responses to a re-raise of me - */

    let opened = decisions
        .iter()
        .any(|decision| decision.kind == ActionType::Raise && decision.raises_before == 0);
    if opened && let Some(facing_three_bet) = facing_three_bet {
        counters[C::fold_to_three_bet_opp] = 1;
        leg(
            counters,
            facing_three_bet,
            [
                C::fold_to_three_bet,
                C::call_three_bet,
                C::raise_vs_three_bet,
            ],
        );
    }

    let three_bet = decisions
        .iter()
        .any(|decision| decision.kind == ActionType::Raise && decision.raises_before == 1);
    if three_bet && let Some(facing_four_bet) = facing_four_bet {
        counters[C::fold_to_four_bet_opp] = 1;
        leg(
            counters,
            facing_four_bet,
            [C::fold_to_four_bet, C::call_four_bet, C::raise_vs_four_bet],
        );
    }
}
