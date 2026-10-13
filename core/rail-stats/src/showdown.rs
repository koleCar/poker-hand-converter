//! Showdown counters: `frontend/src/lib/stats/showdown.ts`.
//!
//! WWSF, WTSD and W$SD over `flop_seen`. Reaching a showdown is structural -
//! two or more dealt-in seats never folded - never `results.wentToShowdown`
//! (docs/STATS-SPEC.md §4.8). "Won" is collected chips from a pot.

use crate::context::StatsContext;
use crate::counters::{Counter, SeatCounters, SeatMoney};

/// `showdownCounters`: the showdown counters for one seat, after the
/// postflop ones (it reads `flop_seen`) and the money.
pub fn showdown_counters(
    context: &StatsContext<'_>,
    seat: u32,
    counters: &mut SeatCounters,
    money: &SeatMoney,
) {
    use Counter as C;

    if counters[C::flop_seen] != 1 {
        return;
    }

    counters[C::wwsf_opp] = 1;
    if money.won > 0 {
        counters[C::wwsf] = 1;
    }

    counters[C::wtsd_opp] = 1;

    let showdown = context.live_seats.len() >= 2 && context.live_seats.contains(&seat);
    if !showdown {
        return;
    }

    counters[C::wtsd] = 1;
    counters[C::wsd_opp] = 1;
    if money.won > 0 {
        counters[C::wsd] = 1;
    }
}
