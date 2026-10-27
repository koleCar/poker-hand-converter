//! Postflop counters: `web/src/lib/stats/postflop.ts`.
//!
//! Streets seen (a denominator, not an opportunity: an all-in player sees
//! every street), the continuation-bet chain (a turn cbet needs the flop cbet
//! *called*, PT4's call, docs/STATS-SPEC.md §4.4), donk bets, check-raises
//! and the raw action counts.

use std::collections::BTreeMap;

use rail_core::phf::{ActionType, Street};

use crate::context::{POSTFLOP_STREETS, StatsContext};
use crate::counters::{Counter, SeatCounters};

/// The counter names for one street (`KEYS[street]`).
struct StreetKeys {
    seen: Counter,
    cbet_opp: Counter,
    cbet: Counter,
    fold_to_cbet_opp: Counter,
    fold_to_cbet: Counter,
    call_cbet: Counter,
    raise_cbet: Counter,
    donk_opp: Counter,
    donk: Counter,
    check_raise_opp: Counter,
    check_raise: Counter,
    bet: Counter,
    raise: Counter,
    call: Counter,
    check: Counter,
    fold: Counter,
}

fn keys(street: Street) -> StreetKeys {
    use Counter as C;
    match street {
        Street::Flop => StreetKeys {
            seen: C::flop_seen,
            cbet_opp: C::cbet_flop_opp,
            cbet: C::cbet_flop,
            fold_to_cbet_opp: C::fold_to_cbet_flop_opp,
            fold_to_cbet: C::fold_to_cbet_flop,
            call_cbet: C::call_cbet_flop,
            raise_cbet: C::raise_cbet_flop,
            donk_opp: C::donk_flop_opp,
            donk: C::donk_flop,
            check_raise_opp: C::check_raise_flop_opp,
            check_raise: C::check_raise_flop,
            bet: C::bet_flop,
            raise: C::raise_flop,
            call: C::call_flop,
            check: C::check_flop,
            fold: C::fold_flop,
        },
        Street::Turn => StreetKeys {
            seen: C::turn_seen,
            cbet_opp: C::cbet_turn_opp,
            cbet: C::cbet_turn,
            fold_to_cbet_opp: C::fold_to_cbet_turn_opp,
            fold_to_cbet: C::fold_to_cbet_turn,
            call_cbet: C::call_cbet_turn,
            raise_cbet: C::raise_cbet_turn,
            donk_opp: C::donk_turn_opp,
            donk: C::donk_turn,
            check_raise_opp: C::check_raise_turn_opp,
            check_raise: C::check_raise_turn,
            bet: C::bet_turn,
            raise: C::raise_turn,
            call: C::call_turn,
            check: C::check_turn,
            fold: C::fold_turn,
        },
        _ => StreetKeys {
            seen: C::river_seen,
            cbet_opp: C::cbet_river_opp,
            cbet: C::cbet_river,
            fold_to_cbet_opp: C::fold_to_cbet_river_opp,
            fold_to_cbet: C::fold_to_cbet_river,
            call_cbet: C::call_cbet_river,
            raise_cbet: C::raise_cbet_river,
            donk_opp: C::donk_river_opp,
            donk: C::donk_river,
            check_raise_opp: C::check_raise_river_opp,
            check_raise: C::check_raise_river,
            bet: C::bet_river,
            raise: C::raise_river,
            call: C::call_river,
            check: C::check_river,
            fold: C::fold_river,
        },
    }
}

/// `CbetLink`: one street of the continuation-bet chain.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CbetLink {
    /// The preflop raiser had a decision here with no bet in front of it.
    pub opportunity: bool,
    /// ...and bet: the order of that decision.
    pub made: Option<usize>,
    /// The bet was called and not raised.
    pub called: bool,
}

/// `cbetChain`: the chain for the hand, keyed by postflop street.
pub fn cbet_chain(context: &StatsContext<'_>) -> BTreeMap<Street, CbetLink> {
    let mut chain: BTreeMap<Street, CbetLink> = POSTFLOP_STREETS
        .iter()
        .map(|&street| (street, CbetLink::default()))
        .collect();

    let Some(aggressor) = context.preflop_aggressor else {
        return chain;
    };
    if context.is_bomb_pot {
        return chain;
    }

    for street in POSTFLOP_STREETS {
        let Some(decision) = context.first_decision(aggressor, street) else {
            // No decision: all-in, folded, or never dealt.
            break;
        };
        if decision.aggression_before > 0 {
            // Led into: a donk spot, not a continuation bet.
            break;
        }
        let link = chain.entry(street).or_default();
        link.opportunity = true;
        if decision.kind != ActionType::Bet {
            break;
        }
        link.made = Some(decision.order);

        let mut called = false;
        for later in context.street(street) {
            if later.order <= decision.order {
                continue;
            }
            if later.kind == ActionType::Raise {
                called = false;
                break;
            }
            if later.kind == ActionType::Call {
                called = true;
            }
        }
        link.called = called;
        if !called {
            break;
        }
    }

    chain
}

/// `postflopCounters`: every postflop counter for one seat.
pub fn postflop_counters(
    context: &StatsContext<'_>,
    seat: u32,
    counters: &mut SeatCounters,
    chain: &BTreeMap<Street, CbetLink>,
) {
    let aggressor = context.preflop_aggressor;

    for street in POSTFLOP_STREETS {
        let keys = keys(street);
        if !context.live_on_street(seat, street) {
            continue;
        }

        counters[keys.seen] = 1;

        let mine = context.seat_street(seat, street);
        for decision in &mine {
            match decision.kind {
                ActionType::Bet => counters[keys.bet] += 1,
                ActionType::Raise => counters[keys.raise] += 1,
                ActionType::Call => counters[keys.call] += 1,
                ActionType::Check => counters[keys.check] += 1,
                ActionType::Fold => counters[keys.fold] += 1,
                _ => {}
            }
        }

        let first = mine.first().copied();
        let link = chain.get(&street).copied().unwrap_or_default();

        /* --------------------------------------------------- continuation bets - */

        if Some(seat) == aggressor {
            if link.opportunity {
                counters[keys.cbet_opp] = 1;
                if link.made.is_some() {
                    counters[keys.cbet] = 1;
                }
            }
        } else if let Some(cbet) = link.made {
            // The seat's first decision after the cbet with nobody having
            // raised in between; a check before it does not disqualify.
            let facing = mine
                .iter()
                .find(|decision| decision.order > cbet && decision.raises_before == 0);
            if let Some(facing) = facing {
                counters[keys.fold_to_cbet_opp] = 1;
                match facing.kind {
                    ActionType::Fold => counters[keys.fold_to_cbet] += 1,
                    ActionType::Call => counters[keys.call_cbet] += 1,
                    ActionType::Raise | ActionType::Bet => counters[keys.raise_cbet] += 1,
                    _ => {}
                }
            }
        }

        /* --------------------------------------------------------- donk bets - */

        let previous = if street == Street::Flop {
            aggressor
        } else {
            context.aggressor_on(if street == Street::Turn {
                Street::Flop
            } else {
                Street::Turn
            })
        };
        if let (Some(first), Some(previous)) = (first, previous)
            && previous != seat
            && context.live_on_street(previous, street)
            && first.aggression_before == 0
            && !context
                .street(street)
                .any(|decision| decision.seat == previous && decision.order < first.order)
        {
            counters[keys.donk_opp] = 1;
            if first.kind == ActionType::Bet {
                counters[keys.donk] = 1;
            }
        }

        /* ------------------------------------------------------- check-raises - */

        let returned = mine
            .iter()
            .find(|decision| decision.checked_before && decision.aggression_before > 0);
        if let Some(returned) = returned {
            counters[keys.check_raise_opp] = 1;
            if returned.kind == ActionType::Raise {
                counters[keys.check_raise] = 1;
            }
        }
    }
}
