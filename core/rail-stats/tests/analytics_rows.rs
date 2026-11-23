//! The Analytics checker rows (docs/ANALYTICS.md Step 2,
//! `rail_stats::analytics_rows`): every hero decision of the fixture
//! (`tests/data/analytics/rows/cases.json`, a made-up stored analysis per
//! decision of the pinned hands) derives exactly `rows.json` - the file the
//! web's twin is held to (`tests/test/analyticsRows.test.ts`); the parts
//! read as documented; and the membership version is pinned to the hand
//! classes and size buckets the rows read.

mod support;

use std::fs;

use rail_core::phf::PhfHand;
use rail_core::phf::serialize::{StandardContext, parse_standard_hand};
use rail_stats::analytics::{MEMBERSHIP_VERSION, catalogue};
use rail_stats::analytics_rows::{
    RowsDecision, analytics_rows, best_option, opponent_of, round_half_away,
};
use rail_stats::events::hand_events;
use serde_json::{Value, json};
use support::{read_json, root};

const DIR: &str = "core/rail-stats/tests/data/analytics/rows";

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};

fn hand(path: &str) -> PhfHand {
    let text = fs::read_to_string(root().join(path)).expect("hand file");
    parse_standard_hand(&text, &CTX)
        .expect("parses")
        .expect("a hand")
}

fn decisions(case: &Value) -> Vec<RowsDecision<'_>> {
    case["decisions"]
        .as_array()
        .expect("decisions")
        .iter()
        .map(|d| RowsDecision {
            ord: d["ord"].as_i64().expect("ord"),
            action_index: d["action_index"].as_i64().expect("action_index"),
            status: d["status"].as_str().expect("status"),
            options: &d["options"],
            ev_loss_bb: d["ev_loss_bb"].as_f64(),
            facts: &d["facts"],
        })
        .collect()
}

/// JSON with every number as an `f64` (the TypeScript writes `0`, Rust `0.0`).
fn numbers_as_f64(value: Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().expect("a number")),
        Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_f64).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, numbers_as_f64(value)))
                .collect(),
        ),
        other => other,
    }
}

#[test]
fn the_fixture_derives_rows_json() {
    let cases = read_json(&root().join(DIR).join("cases.json"));
    let expected = read_json(&root().join(DIR).join("rows.json"));
    let derived: Vec<Value> = cases["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| {
            let file = case["file"].as_str().expect("file");
            let rows = analytics_rows(catalogue(), &hand_events(&hand(file)), &decisions(case));
            json!({ "file": file, "rows": rows })
        })
        .collect();
    assert_eq!(
        numbers_as_f64(Value::Array(derived)),
        numbers_as_f64(expected),
        "rail_stats::analytics_rows and the web's analyticsRows disagree on the fixture"
    );
}

#[test]
fn size_buckets_are_half_open_in_thousandths() {
    let bucket = |x: Option<f64>| {
        catalogue()
            .size_bucket(x)
            .map_or(String::new(), |b| b.id.clone())
    };
    let got: Vec<String> = [
        0.1, 0.3994, 0.3996, 0.4, 0.599, 0.6, 0.849, 0.85, 1.249, 1.2495, 3.0,
    ]
    .into_iter()
    .map(|x| bucket(Some(x)))
    .collect();
    assert_eq!(
        got,
        [
            "20-40", "20-40", "40-60", "40-60", "40-60", "60-85", "60-85", "85-125", "85-125",
            "125+", "125+"
        ]
    );
    for none in [None, Some(0.0), Some(-1.0), Some(f64::NAN)] {
        assert_eq!(bucket(none), "");
    }
}

#[test]
fn the_best_option_is_the_web_ones() {
    let best = |v: Value| best_option(v.as_array().expect("array")).map(str::to_owned);
    assert_eq!(
        best(json!([{"action":"fold","freq":0.2,"ev":0},{"action":"call","freq":0.8,"ev":1}])),
        Some("call".into())
    );
    assert_eq!(
        best(json!([{"action":"fold","freq":0.6,"ev":1},{"action":"call","freq":0.4,"ev":1}])),
        Some("fold".into())
    );
    assert_eq!(
        best(json!([{"action":"call","freq":0.5,"ev":1},{"action":"raise","freq":0.5,"ev":1}])),
        Some("call".into())
    );
    assert_eq!(
        best(json!([{"action":"call","freq":0.9},{"action":"fold","freq":0.1,"ev":-1}])),
        Some("fold".into())
    );
    assert_eq!(best(json!([{"action":"allin","freq":1,"ev":9}])), None);
    assert_eq!(best(json!([])), None);
}

#[test]
fn rounding_is_half_away_from_zero() {
    assert_eq!(
        [
            round_half_away(0.0005, 3),
            round_half_away(-0.0005, 3),
            round_half_away(1.234_567_89, 6)
        ],
        [0.001, -0.001, 1.234_568]
    );
}

#[test]
fn the_opponent_is_the_streets_aggressor() {
    let events = hand_events(&hand(
        "core/rail-stats/tests/data/analytics/05-fold-to-flop-cbet.txt",
    ));
    let hero = events.seats.iter().find(|seat| seat.hero).expect("a hero");
    let pre = &hero.events[0];
    let flop = &hero.events[1];
    assert_eq!(opponent_of(&events, hero.seat, pre.order, pre.street), "HJ");
    assert_eq!(
        opponent_of(&events, hero.seat, flop.order, flop.street),
        "HJ"
    );
}

/// The hand classes and size buckets a stored row reads: a change to either
/// bumps `MEMBERSHIP_VERSION` (and the web's `ANALYTICS_MEMBERSHIP_VERSION`),
/// then re-pin here and in `tests/test/analyticsRows.test.ts`.
#[test]
fn the_rows_fingerprint_is_pinned() {
    let fingerprint = catalogue().rows_fingerprint();
    assert_eq!(
        (
            MEMBERSHIP_VERSION,
            support::sha256_hex(&fingerprint).as_str()
        ),
        (
            "analytics/1",
            "58038ddfe6d6ff103fa8be05348554d855787b3d964f8a08e59d39c177183a4e"
        ),
        "a hand class or size bucket changed: bump MEMBERSHIP_VERSION (Rust and web) and re-pin\n{fingerprint}"
    );
}
