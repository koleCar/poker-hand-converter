//! [`HandFacts`] to the flat rows a database stores: `web/src/lib/stats/mapping.ts`.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::counters::{COUNTER_COUNT, COUNTER_KEYS, MONEY_KEYS};
use crate::derive::{HandDimensions, HandFacts, SeatFacts};

/// `DIMENSION_COLUMNS`: the dimension columns, in order. The counters
/// ([`COUNTER_KEYS`]) and the money ([`MONEY_KEYS`]) follow.
pub const DIMENSION_COLUMNS: [&str; 36] = [
    "stats_version",
    "hand_key",
    "site_id",
    "hand_id",
    "played_at",
    "variant",
    "limit_type",
    "game_format",
    "currency",
    "currency_minor_units",
    "small_blind",
    "big_blind",
    "player_count",
    "max_seats",
    "table_name",
    "tournament_id",
    "fast_fold",
    "has_straddle",
    "is_bomb_pot",
    "is_big_blind_ante",
    "is_run_it_twice",
    "has_cashout",
    "is_walk",
    "street_reached",
    "pot_type",
    "total_pot",
    "house_into_pot",
    "fees",
    "seat",
    "player",
    "is_hero",
    "position",
    "hole_cards",
    "hand_class",
    "starting_stack",
    "starting_stack_bb_tenths",
];

/// How many columns a row has.
pub const STATS_COLUMN_COUNT: usize = DIMENSION_COLUMNS.len() + COUNTER_COUNT + MONEY_KEYS.len();

/// `STATS_COLUMNS`: every column of a row, in order.
pub fn stats_columns() -> Vec<&'static str> {
    DIMENSION_COLUMNS
        .iter()
        .chain(COUNTER_KEYS.iter())
        .chain(MONEY_KEYS.iter())
        .copied()
        .collect()
}

/// `StatsRow`: one seat of one hand - the hand's dimensions and the seat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatsRow {
    pub hand: HandDimensions,
    pub seat: SeatFacts,
}

/// A PHF enum's JSON string (its serde name, which is the TypeScript's).
fn tag<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn optional(value: Option<&String>) -> Value {
    value.map_or(Value::Null, |text| Value::String(text.clone()))
}

impl StatsRow {
    /// The row as the TypeScript's `StatsRow` object: exactly
    /// [`stats_columns`] as keys, integers as numbers, absent text as `null`.
    pub fn to_json(&self) -> Value {
        let hand = &self.hand;
        let seat = &self.seat;
        let mut row = Map::new();
        let mut put = |key: &str, value: Value| {
            row.insert(key.to_owned(), value);
        };
        put("stats_version", Value::from(hand.stats_version));
        put("hand_key", Value::from(hand.hand_key.clone()));
        put("site_id", Value::from(hand.site_id.clone()));
        put("hand_id", Value::from(hand.hand_id.clone()));
        put("played_at", optional(hand.played_at.as_ref()));
        put("variant", tag(&hand.variant));
        put("limit_type", tag(&hand.limit));
        put("game_format", tag(&hand.format));
        put("currency", Value::from(hand.currency.clone()));
        put(
            "currency_minor_units",
            Value::from(hand.currency_minor_units),
        );
        put("small_blind", Value::from(hand.small_blind));
        put("big_blind", Value::from(hand.big_blind));
        put("player_count", Value::from(hand.player_count));
        put("max_seats", Value::from(hand.max_seats));
        put("table_name", optional(hand.table_name.as_ref()));
        put("tournament_id", optional(hand.tournament_id.as_ref()));
        put("fast_fold", optional(hand.fast_fold.as_ref()));
        put("has_straddle", Value::from(hand.has_straddle));
        put("is_bomb_pot", Value::from(hand.is_bomb_pot));
        put("is_big_blind_ante", Value::from(hand.is_big_blind_ante));
        put("is_run_it_twice", Value::from(hand.is_run_it_twice));
        put("has_cashout", Value::from(hand.has_cashout));
        put("is_walk", Value::from(hand.is_walk));
        put("street_reached", tag(&hand.street_reached));
        put("pot_type", Value::from(hand.pot_type.as_str()));
        put("total_pot", Value::from(hand.total_pot));
        put("house_into_pot", Value::from(hand.house_into_pot));
        put("fees", Value::from(hand.fees));
        put("seat", Value::from(seat.seat));
        put("player", Value::from(seat.player.clone()));
        put("is_hero", Value::from(seat.is_hero));
        put("position", seat.position.as_ref().map_or(Value::Null, tag));
        put(
            "hole_cards",
            Value::Array(seat.hole_cards.iter().cloned().map(Value::from).collect()),
        );
        put("hand_class", optional(seat.hand_class.as_ref()));
        put("starting_stack", Value::from(seat.starting_stack));
        put(
            "starting_stack_bb_tenths",
            Value::from(seat.starting_stack_bb_tenths),
        );
        for (counter, value) in seat.counters.iter() {
            put(counter.name(), Value::from(value));
        }
        for (key, value) in seat.money.columns() {
            put(key, Value::from(value));
        }
        Value::Object(row)
    }
}

/// `statsRows`: one row per dealt-in seat.
pub fn stats_rows(facts: &HandFacts) -> Vec<StatsRow> {
    facts
        .seats
        .iter()
        .map(|seat| StatsRow {
            hand: facts.hand.clone(),
            seat: seat.clone(),
        })
        .collect()
}
