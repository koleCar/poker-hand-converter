//! The counter set and the structural rulebook: `web/src/lib/stats/types.ts`.
//!
//! One counter per member of `ZERO_COUNTERS`, in its declaration order, which
//! is the column order of `mapping.ts`. The names are the TypeScript (and
//! database column) names exactly, so [`Counter`]'s variants are snake case.
//! `tests/columns.rs` reads `types.ts` and fails when the two lists drift.

use std::ops::{Index, IndexMut};

use rail_core::phf::Amount;

macro_rules! counters {
    ($($name:ident),* $(,)?) => {
        /// One integer counter of a seat's row (`CounterKey` in `types.ts`).
        ///
        /// The variant is the column name; [`Counter::ALL`] is the column
        /// order.
        #[allow(non_camel_case_types)]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum Counter {
            $($name,)*
        }

        /// How many counters a row carries.
        pub const COUNTER_COUNT: usize = [$(stringify!($name),)*].len();

        /// `COUNTER_KEYS`: every counter name, in declaration order.
        pub const COUNTER_KEYS: [&str; COUNTER_COUNT] = [$(stringify!($name),)*];

        impl Counter {
            /// Every counter, in declaration order.
            pub const ALL: [Counter; COUNTER_COUNT] = [$(Counter::$name,)*];

            /// The column name.
            pub const fn name(self) -> &'static str {
                match self {
                    $(Counter::$name => stringify!($name),)*
                }
            }

            /// The counter with this column name.
            pub fn from_name(name: &str) -> Option<Self> {
                match name {
                    $(stringify!($name) => Some(Counter::$name),)*
                    _ => None,
                }
            }
        }
    };
}

counters! {
    hands,

    vpip_opp,
    vpip,
    pfr_opp,
    pfr,
    rfi_opp,
    rfi,
    iso_opp,
    iso,
    limp_opp,
    limp,
    cold_call_opp,
    cold_call,
    three_bet_opp,
    three_bet,
    four_bet_opp,
    four_bet,
    five_bet_opp,
    five_bet,
    squeeze_opp,
    squeeze,
    steal_opp,
    steal,
    fold_to_steal_opp,
    fold_to_steal,
    call_steal,
    three_bet_vs_steal,
    fold_to_three_bet_opp,
    fold_to_three_bet,
    call_three_bet,
    raise_vs_three_bet,
    fold_to_four_bet_opp,
    fold_to_four_bet,
    call_four_bet,
    raise_vs_four_bet,

    flop_seen,
    turn_seen,
    river_seen,
    cbet_flop_opp,
    cbet_flop,
    cbet_turn_opp,
    cbet_turn,
    cbet_river_opp,
    cbet_river,
    fold_to_cbet_flop_opp,
    fold_to_cbet_flop,
    call_cbet_flop,
    raise_cbet_flop,
    fold_to_cbet_turn_opp,
    fold_to_cbet_turn,
    call_cbet_turn,
    raise_cbet_turn,
    fold_to_cbet_river_opp,
    fold_to_cbet_river,
    call_cbet_river,
    raise_cbet_river,
    donk_flop_opp,
    donk_flop,
    donk_turn_opp,
    donk_turn,
    donk_river_opp,
    donk_river,
    check_raise_flop_opp,
    check_raise_flop,
    check_raise_turn_opp,
    check_raise_turn,
    check_raise_river_opp,
    check_raise_river,

    bet_flop,
    raise_flop,
    call_flop,
    check_flop,
    fold_flop,
    bet_turn,
    raise_turn,
    call_turn,
    check_turn,
    fold_turn,
    bet_river,
    raise_river,
    call_river,
    check_river,
    fold_river,

    wwsf_opp,
    wwsf,
    wtsd_opp,
    wtsd,
    wsd_opp,
    wsd,

    cashed_out,
}

impl Counter {
    /// The counter's position in [`Counter::ALL`].
    pub fn index(self) -> usize {
        // A fieldless enum's discriminant is its declaration index.
        self as usize
    }
}

/// `SeatCounters`: every counter of one seat in one hand.
///
/// Every value is 0 or 1 except the raw postflop action counts (`bet_flop`
/// and friends), which count every such action. Indexed by [`Counter`]; the
/// array form is what a rollup (R2.3) sums.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SeatCounters(pub [u32; COUNTER_COUNT]);

impl Default for SeatCounters {
    /// `emptyCounters()`: every counter at zero.
    fn default() -> Self {
        Self([0; COUNTER_COUNT])
    }
}

impl SeatCounters {
    /// The value of `counter`.
    pub fn get(&self, counter: Counter) -> u32 {
        self[counter]
    }

    /// Every counter with its value, in column order.
    pub fn iter(&self) -> impl Iterator<Item = (Counter, u32)> + '_ {
        Counter::ALL.iter().map(|&counter| (counter, self[counter]))
    }
}

impl Index<Counter> for SeatCounters {
    type Output = u32;
    fn index(&self, counter: Counter) -> &u32 {
        &self.0[counter.index()]
    }
}

impl IndexMut<Counter> for SeatCounters {
    fn index_mut(&mut self, counter: Counter) -> &mut u32 {
        &mut self.0[counter.index()]
    }
}

/// `SeatMoney`: money for one seat in one hand, in PHF minor units unless
/// stated (`types.ts` has the definition of every field).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct SeatMoney {
    /// Chips that landed in the stack, from every pot and runout, after fees.
    pub won: Amount,
    /// Chips put in, net of uncalled returns.
    pub contributed: Amount,
    /// `won - contributed`.
    pub net: Amount,
    /// `net` in thousandths of a big blind, rounded half away from zero.
    pub net_bb_milli: i64,
    /// The fees this seat bore (attributed to the winners).
    pub rake_paid: Amount,
    /// Chips that left the stack without reaching the pot.
    pub out_of_pot: Amount,
    /// GG EV-cashout risk paid, settled outside the pot.
    pub cashout_risk: Amount,
}

/// `MONEY_KEYS`: the money columns, in declaration order.
pub const MONEY_KEYS: [&str; 7] = [
    "won",
    "contributed",
    "net",
    "net_bb_milli",
    "rake_paid",
    "out_of_pot",
    "cashout_risk",
];

impl SeatMoney {
    /// Every money column with its value, in [`MONEY_KEYS`] order.
    pub fn columns(&self) -> [(&'static str, i64); 7] {
        [
            ("won", self.won),
            ("contributed", self.contributed),
            ("net", self.net),
            ("net_bb_milli", self.net_bb_milli),
            ("rake_paid", self.rake_paid),
            ("out_of_pot", self.out_of_pot),
            ("cashout_risk", self.cashout_risk),
        ]
    }
}

/* ------------------------------------------------- the structural rulebook - */

use Counter as C;

/// `OPPORTUNITY_PAIRS`: `(opp, made)`; `made <= opp` on every row.
pub const OPPORTUNITY_PAIRS: [(Counter, Counter); 23] = [
    (C::vpip_opp, C::vpip),
    (C::pfr_opp, C::pfr),
    (C::rfi_opp, C::rfi),
    (C::iso_opp, C::iso),
    (C::limp_opp, C::limp),
    (C::cold_call_opp, C::cold_call),
    (C::three_bet_opp, C::three_bet),
    (C::four_bet_opp, C::four_bet),
    (C::five_bet_opp, C::five_bet),
    (C::squeeze_opp, C::squeeze),
    (C::steal_opp, C::steal),
    (C::cbet_flop_opp, C::cbet_flop),
    (C::cbet_turn_opp, C::cbet_turn),
    (C::cbet_river_opp, C::cbet_river),
    (C::donk_flop_opp, C::donk_flop),
    (C::donk_turn_opp, C::donk_turn),
    (C::donk_river_opp, C::donk_river),
    (C::check_raise_flop_opp, C::check_raise_flop),
    (C::check_raise_turn_opp, C::check_raise_turn),
    (C::check_raise_river_opp, C::check_raise_river),
    (C::wwsf_opp, C::wwsf),
    (C::wtsd_opp, C::wtsd),
    (C::wsd_opp, C::wsd),
];

/// `LEG_SETS`: `(opp, [fold, call, raise])`; the legs sum to `opp` exactly.
pub const LEG_SETS: [(Counter, [Counter; 3]); 6] = [
    (
        C::fold_to_steal_opp,
        [C::fold_to_steal, C::call_steal, C::three_bet_vs_steal],
    ),
    (
        C::fold_to_three_bet_opp,
        [
            C::fold_to_three_bet,
            C::call_three_bet,
            C::raise_vs_three_bet,
        ],
    ),
    (
        C::fold_to_four_bet_opp,
        [C::fold_to_four_bet, C::call_four_bet, C::raise_vs_four_bet],
    ),
    (
        C::fold_to_cbet_flop_opp,
        [C::fold_to_cbet_flop, C::call_cbet_flop, C::raise_cbet_flop],
    ),
    (
        C::fold_to_cbet_turn_opp,
        [C::fold_to_cbet_turn, C::call_cbet_turn, C::raise_cbet_turn],
    ),
    (
        C::fold_to_cbet_river_opp,
        [
            C::fold_to_cbet_river,
            C::call_cbet_river,
            C::raise_cbet_river,
        ],
    ),
];

/// `STREET_CHAINS`: counters that cannot grow along each chain.
pub const STREET_CHAINS: [&[Counter]; 3] = [
    &[C::hands, C::flop_seen, C::turn_seen, C::river_seen],
    &[C::flop_seen, C::wtsd, C::wsd],
    &[C::vpip_opp, C::vpip, C::pfr],
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counter_list_is_consistent() {
        assert_eq!(Counter::ALL.len(), COUNTER_KEYS.len());
        for (i, counter) in Counter::ALL.iter().enumerate() {
            assert_eq!(counter.index(), i);
            assert_eq!(counter.name(), COUNTER_KEYS[i]);
            assert_eq!(Counter::from_name(COUNTER_KEYS[i]), Some(*counter));
        }
        assert_eq!(Counter::from_name("nope"), None);
    }
}
