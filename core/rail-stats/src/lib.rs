#![forbid(unsafe_code)]
//! Per-seat statistics counters, ported from `frontend/src/lib/stats`
//! (docs/STATS-SPEC.md; docs/RAIL-PLAN.md R2.1, later R2.3-R2.5, R2.10-R2.11).
//!
//! ```text
//! PhfHand ──hand_facts()──▶ HandFacts ──stats_rows()──▶ Vec<StatsRow>  (one per seat)
//! ```
//!
//! The TypeScript engine is the reference (it stays the oracle until R4.x):
//! for every corpus hand the rows here equal the rows the TypeScript derives,
//! byte for byte in canonical JSON (`testdata/golden-stats/`, written by
//! `npm run golden:emit` in `tests/`). Every judgement call of
//! `docs/STATS-SPEC.md` - straddle as a blind, the walked big blind, RFI vs
//! isolation, the called-cbet chain, no heads-up / straddled / button-blind
//! steals, bomb pots, gross collects - is the TypeScript's, ported as is.
//!
//! - [`counters`]: the ~90 counters ([`Counter`], [`SeatCounters`]), the
//!   money ([`SeatMoney`]) and the structural rulebook (`types.ts`).
//! - [`context`]: the decision stream and the hand's shape (`context.ts`).
//! - [`preflop`], [`postflop`], [`showdown`], [`money`]: the counter walks.
//! - [`derive`]: [`hand_facts`] (`derive.ts`).
//! - [`mapping`]: the flat row ([`StatsRow`], `mapping.ts`).
//! - For a store (R2.3): [`anonymization`] (`detectAnonymization`),
//!   [`segment`] (what rollups sum over), [`stored`] (which rows a store
//!   keeps - `handStatsRows` - and the identity they are summed under).
//! - [`display`] (R2.4): the displayed statistics of `config/stats/`,
//!   formulas over summed counters evaluated as the web evaluates them, and
//!   `rates.ts`'s `aggregate`.
//!
//! Integers only: amounts are `i64` minor units, counters `u32`. The three
//! divisions the TypeScript does in doubles (`net_bb_milli`,
//! `starting_stack_bb_tenths`, the fee split) go through
//! [`rail_core::js::JsNumber`], so they round as the browser rounds.

pub mod anonymization;
pub mod context;
pub mod counters;
pub mod derive;
pub mod display;
pub mod mapping;
pub mod money;
pub mod postflop;
pub mod preflop;
pub mod reliability;
pub mod segment;
pub mod showdown;
pub mod stored;

pub use anonymization::{SiteAnonymization, detect_anonymization};
pub use segment::{Segment, SizeClass, Stake, site_key};
pub use stored::{StoredRows, rollup_scope, session_scope, stored_rows};

pub use counters::{
    COUNTER_COUNT, COUNTER_KEYS, Counter, LEG_SETS, MONEY_KEYS, OPPORTUNITY_PAIRS, STREET_CHAINS,
    SeatCounters, SeatMoney,
};
pub use derive::{
    HandDimensions, HandFacts, PotType, STATS_VERSION, SeatFacts, hand_class, hand_facts,
};
pub use mapping::{DIMENSION_COLUMNS, STATS_COLUMN_COUNT, StatsRow, stats_columns, stats_rows};
pub use money::to_bb_milli;

use rail_core::phf::PhfHand;

/// `statsRows(handFacts(hand))`: the rows of one hand, one per dealt-in seat
/// (hero and villains alike; which of them a writer keeps is the writer's
/// business, as in `lib/db/statsRows.ts`).
pub fn rows_for(hand: &PhfHand) -> Vec<StatsRow> {
    stats_rows(&hand_facts(hand))
}
