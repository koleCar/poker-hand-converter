//! The three field shapes, the tags and the strictness, one case each.
//!
//! The golden round trip covers what the corpus contains; these cover what it
//! does not (no corpus hand has `fastFold: null`, an explicit `null` where a
//! field is optional, or an unknown field).

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{
    ActionType, PhfFees, PhfPot, PhfSchema, PhfTable, PhfTextStyle, PhfWarning, Position,
    STREET_ORDER, Street,
};

fn read<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}

fn write<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Reads `value`, requires success, and requires it to write back unchanged.
fn round_trip<T: DeserializeOwned + Serialize>(value: Value) -> T {
    let parsed: T = match read(value.clone()) {
        Ok(parsed) => parsed,
        Err(e) => panic!("{value} does not deserialize: {e}"),
    };
    assert_eq!(write(&parsed), value);
    parsed
}

#[test]
fn optional_and_nullable_fast_fold_keeps_all_three_states() {
    let absent: PhfTable = round_trip(json!({ "name": "T", "maxSeats": 6, "buttonSeat": 3 }));
    assert_eq!(absent.fast_fold, None);

    let null: PhfTable = round_trip(json!({
        "name": "T", "maxSeats": 6, "buttonSeat": 3, "fastFold": null,
    }));
    assert_eq!(null.fast_fold, Some(None));

    let zoom: PhfTable = round_trip(json!({
        "name": "T", "maxSeats": 6, "buttonSeat": 3, "fastFold": "Zoom",
    }));
    assert_eq!(zoom.fast_fold, Some(Some("Zoom".to_owned())));
}

#[test]
fn nullable_fields_are_written_as_null_and_required_on_read() {
    let table: PhfTable = round_trip(json!({ "name": null, "maxSeats": 2, "buttonSeat": null }));
    assert_eq!(table.name, None);
    assert_eq!(table.button_seat, None);

    let missing = read::<PhfTable>(json!({ "maxSeats": 2, "buttonSeat": 1 }));
    assert!(
        missing
            .as_ref()
            .is_err_and(|e| e.contains("missing field `name`")),
        "{missing:?}"
    );
}

#[test]
fn optional_fields_are_omitted_and_refuse_null() {
    let warning: PhfWarning = round_trip(json!({ "code": "c", "message": "m" }));
    assert_eq!(warning.line, None);
    let warning: PhfWarning = round_trip(json!({ "code": "c", "message": "m", "line": 7 }));
    assert_eq!(warning.line, Some(7));

    let null = read::<PhfWarning>(json!({ "code": "c", "message": "m", "line": null }));
    assert!(null.is_err(), "{null:?}");
}

#[test]
fn unknown_fields_are_refused() {
    let extra = read::<PhfPot>(json!({ "name": "Main", "amount": 5, "currency": "USD" }));
    assert!(
        extra
            .as_ref()
            .is_err_and(|e| e.contains("unknown field `currency`")),
        "{extra:?}"
    );
}

#[test]
fn amounts_are_integers() {
    assert!(read::<PhfPot>(json!({ "name": "Main", "amount": 0.5 })).is_err());
    assert!(read::<PhfPot>(json!({ "name": "Main", "amount": 1.0 })).is_err());
    let pot: PhfPot = round_trip(json!({ "name": "Main", "amount": -9_007_199_254_740_991_i64 }));
    assert_eq!(pot.amount, -9_007_199_254_740_991);
}

#[test]
fn tags_match_types_ts() {
    assert_eq!(write(&PhfSchema::V1), json!("phf/1"));
    assert!(read::<PhfSchema>(json!("phf/2")).is_err());
    assert_eq!(write(&Position::Utg1), json!("UTG+1"));
    assert_eq!(write(&Position::Btn), json!("BTN"));
    assert_eq!(write(&ActionType::CashoutChoose), json!("cashout-choose"));
    assert_eq!(write(&ActionType::MissedBlind), json!("missed-blind"));
    assert_eq!(
        write(&STREET_ORDER),
        json!(["preflop", "flop", "turn", "river", "showdown"])
    );
    assert!(STREET_ORDER.windows(2).all(|w| w[0] < w[1]));
    assert!(Street::Preflop < Street::Showdown);
}

/// `DEFAULT_TEXT_STYLE` and `ZERO_FEES` in `types.ts`.
#[test]
fn defaults_match_types_ts() {
    assert_eq!(
        write(&PhfTextStyle::default()),
        json!({
            "decimals": "minimal",
            "dealtLinesForAllPlayers": false,
            "showdownSection": true,
            "holeCardsSection": true,
            "showdownLabels": [""],
            "runItTwiceNote": false,
            "padHour": true,
        })
    );
    assert_eq!(
        write(&PhfFees::ZERO),
        json!({ "rake": 0, "jackpot": 0, "bingo": 0, "fortune": 0, "tax": 0, "other": 0 })
    );
}
