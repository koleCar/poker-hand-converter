#![forbid(unsafe_code)]
//! All-in EV, ported from `frontend/src/lib/equity` (docs/RAIL-PLAN.md R2.2).
//!
//! ```text
//! rail_core::eval   5-7 card values, full and short deck, Omaha (R0.5b)
//! enumerate         equity per pot over every runout, or a seeded sample
//! range             one hand against a weighted range, card removal applied
//! multiway          one hand against several ranges at once
//! all_in            PhfHand -> pots at the all-in -> evNet per seat
//! row               the stored hand_stats_ev row (`handEvRow`)
//! ```
//!
//! **Exactness.** The enumeration is integer arithmetic: a player's share of
//! a pot is `units / (boards * 27720)` exactly. Where the TypeScript leaves
//! the integers - the one division that makes an equity a double, the
//! apportioning of a pot by those doubles, range weights - the port performs
//! the same IEEE-754 operations in [`rail_core::js::JsNumber`], in the same
//! order, so every stored value (and every equity) is the TypeScript's, bit
//! for bit. The Monte Carlo path (Omaha preflop) draws with the same
//! `mulberry32` and the same Fisher-Yates, so it is exact too, not within a
//! tolerance.
//!
//! **For R2.3**: [`ev_row`] (given the hero's [`rail_stats::StatsRow`]) or
//! [`ev_row_for`] gives the `hand_stats_ev` row; [`EV_VERSION`] is its
//! version. [`analyze_all_in`] is the full analysis (pots, equities, seats).

pub mod all_in;
pub mod enumerate;
pub mod multiway;
pub mod range;
pub mod row;

pub use all_in::{
    AllInEv, AllInEvOutcome, AllInSkipReason, EV_VERSION, EvPot, EvSeat, all_in_ev, analyze_all_in,
    apportion, ev_net_by_seat,
};
pub use enumerate::{
    Computation, DEFAULT_EXHAUSTIVE_LIMIT, DEFAULT_SEED, DEFAULT_TRIALS, EquityGame,
    EquityInputError, EquityMethod, EquityOptions, EquityRequest, EquityResult, Mulberry32, Plan,
    UNIT, equity, hole_cards_for, plan, table_for,
};
pub use multiway::{
    DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT, DEFAULT_MULTIWAY_TRIALS, MultiwayEquityRequest,
    MultiwayEquityResult, equity_vs_ranges,
};
pub use range::{
    ClassWeights, DEFAULT_RANGE_EXHAUSTIVE_LIMIT, DEFAULT_RANGE_TRIALS, Range, RangeEquityRequest,
    RangeEquityResult, RangeError, WeightedCombo, all_classes, class_combos, equity_vs_range,
    parse_range, range_combos, range_share, strongest_of_range,
};
pub use row::{EvRow, ev_row, ev_row_for};
