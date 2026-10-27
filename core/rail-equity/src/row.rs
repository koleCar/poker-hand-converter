//! The stored EV row: `handEvRow` of `web/src/lib/db/statsRows.ts`.
//!
//! One row per hand with a hero, applicable or not: a hand without an
//! all-in (or one the engine cannot evaluate) still gets a row, with
//! `ev_net = net`, which is what lets a backfill tell "not evaluated yet"
//! from "evaluated, nothing to adjust".

use rail_core::phf::{Amount, PhfHand, Street};
use rail_stats::{StatsRow, rows_for, to_bb_milli};
use serde_json::{Map, Value};

use crate::all_in::{EV_VERSION, all_in_street, ev_net_by_seat};
use crate::enumerate::EquityOptions;

/// `HandEvInsert`: one row as `save_hand_ev` takes it (`hand_stats_ev`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvRow {
    pub hand_key: String,
    pub seat: u32,
    pub ev_version: &'static str,
    /// True when there was an all-in with cards to come.
    pub applicable: bool,
    /// The seat's all-in-EV net, or its `net` when not applicable.
    pub ev_net: Amount,
    /// `ev_net` in thousandths of a big blind (`net_bb_milli` when not
    /// applicable, or when the big blind is 0).
    pub ev_net_bb_milli: i64,
}

impl EvRow {
    /// The row as the TypeScript object, keys as `save_hand_ev` takes them.
    pub fn to_json(&self) -> Value {
        let mut row = Map::new();
        row.insert("hand_key".to_owned(), Value::from(self.hand_key.clone()));
        row.insert("seat".to_owned(), Value::from(self.seat));
        row.insert("ev_version".to_owned(), Value::from(self.ev_version));
        row.insert("applicable".to_owned(), Value::Bool(self.applicable));
        row.insert("ev_net".to_owned(), Value::from(self.ev_net));
        row.insert(
            "ev_net_bb_milli".to_owned(),
            Value::from(self.ev_net_bb_milli),
        );
        Value::Object(row)
    }
}

/// `handEvRow(hand, hero)`: the hero's all-in-EV row, given the hero's
/// statistics row (from [`rail_stats::rows_for`] of the same hand).
///
/// Computed with the default options, as every stored row is. A result of
/// `-0` for `ev_net_bb_milli` (a loss under half a thousandth of a big blind)
/// is 0, as the integer column stores it.
pub fn ev_row(hand: &PhfHand, hero: &StatsRow) -> EvRow {
    let seat = hero.seat.seat;
    let ev_net = ev_net_by_seat(hand, &EquityOptions::default())
        .and_then(|by_seat| by_seat.get(&seat).copied());
    match ev_net {
        None => not_applicable(hero),
        Some(ev_net) => EvRow {
            hand_key: hero.hand.hand_key.clone(),
            seat,
            ev_version: EV_VERSION,
            applicable: true,
            ev_net,
            ev_net_bb_milli: if hero.hand.big_blind != 0 {
                to_bb_milli(ev_net, hero.hand.big_blind)
            } else {
                hero.seat.money.net_bb_milli
            },
        },
    }
}

/// The row of a hand without an adjustment: `ev_net = net`.
fn not_applicable(hero: &StatsRow) -> EvRow {
    EvRow {
        hand_key: hero.hand.hand_key.clone(),
        seat: hero.seat.seat,
        ev_version: EV_VERSION,
        applicable: false,
        ev_net: hero.seat.money.net,
        ev_net_bb_milli: hero.seat.money.net_bb_milli,
    }
}

/// [`ev_row`], unless the hand's all-in was completed **preflop** (the
/// expensive case: 1.7M boards enumerated, or 20 000 sampled for Omaha):
/// `None` then, for a caller that computes those later (R2.3's background
/// pass). A hand [`all_in_street`] finds no all-in in gets its row without
/// running the analysis a second time; the row is [`ev_row`]'s either way.
pub fn ev_row_unless_preflop(hand: &PhfHand, hero: &StatsRow) -> Option<EvRow> {
    match all_in_street(hand) {
        None => Some(not_applicable(hero)),
        Some(Street::Preflop) => None,
        Some(_) => Some(ev_row(hand, hero)),
    }
}

/// The row the web's writer stores for a hand: derives the statistics rows,
/// takes the first hero row (`derived.find((row) => row.is_hero)` in
/// `app/api/stats/rebuild/route.ts`) and computes its EV row; `None` for a
/// hand without a hero, which gets no EV row.
pub fn ev_row_for(hand: &PhfHand) -> Option<EvRow> {
    rows_for(hand)
        .iter()
        .find(|row| row.seat.is_hero)
        .map(|hero| ev_row(hand, hero))
}
