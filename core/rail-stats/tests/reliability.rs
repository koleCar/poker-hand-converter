//! Sample reliability (docs/RAIL-PLAN.md R2.5) against the web's:
//! `tests/data/reliability-vectors.json`, written by `reliability-vectors.mjs`
//! from `web/src/lib/stats/reliability.ts` and `display.ts`'s
//! `statReliability` - which that script holds to `lib/analysis/reports.ts`'s
//! independent Wilson interval (within 1e-9 points) and to R2.4's `full`
//! before writing a case.
//!
//! - **The corpus and the synthetic totals** of `display-vectors.json` (whose
//!   corpus totals `tests/display.rs` re-derives from the Rust rows): every
//!   shipped statistic's level, opacity, interval bounds (bit for bit) and
//!   their text.
//! - **Wilson at the edges**: n = 0, made = 0, made = n, made outside 0..n,
//!   fractions, 2^53 and beyond, 1e308; and 3 000 seeded cases.
//! - **Levels and opacity** at the edges of every `sample.min` shape.
//! - **`Math.sqrt`** (`JsNumber::sqrt`) over random doubles of every exponent.

mod support;

use rail_config::stats::SHIPPED_STATS;
use rail_core::js::JsNumber;
use rail_stats::COUNTER_COUNT;
use rail_stats::display::{Display, MONEY_COUNT, Reliability, Sums};
use rail_stats::reliability::{sample_reliability, wilson};
use serde_json::Value;
use support::{read_json, root, sha256_hex};

fn vectors() -> &'static Value {
    static VECTORS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    VECTORS.get_or_init(|| {
        read_json(&root().join("core/rail-stats/tests/data/reliability-vectors.json"))
    })
}

fn display_vectors() -> &'static Value {
    static VECTORS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    VECTORS
        .get_or_init(|| read_json(&root().join("core/rail-stats/tests/data/display-vectors.json")))
}

/// The display vectors' cases, groups then synthetic: what the reliability
/// vectors were computed over.
fn display_cases() -> Vec<&'static Value> {
    let vectors = display_vectors();
    ["groups", "synthetic"]
        .iter()
        .flat_map(|section| vectors[section].as_array().expect("cases"))
        .collect()
}

fn sums_of(totals: &Value) -> Sums {
    let values = totals.as_array().expect("totals");
    assert_eq!(values.len(), COUNTER_COUNT + MONEY_COUNT + 2);
    let int = |i: usize| values[i].as_i64().unwrap_or_else(|| panic!("totals[{i}]"));
    let mut sums = Sums::default();
    for (i, slot) in sums.counters.iter_mut().enumerate() {
        *slot = int(i);
    }
    for (i, slot) in sums.money.iter_mut().enumerate() {
        *slot = int(COUNTER_COUNT + i);
    }
    sums.money_hands = int(COUNTER_COUNT + MONEY_COUNT);
    sums.ev_net_bb_milli = values[COUNTER_COUNT + MONEY_COUNT + 1].as_i64();
    sums
}

/// `String(x)`, but `-0` for negative zero (as the generator writes it).
fn text(x: JsNumber) -> String {
    if x.strict_equals(JsNumber::ZERO) && x.is_sign_negative() {
        "-0".to_owned()
    } else {
        x.to_js_string()
    }
}

fn optional(x: Option<JsNumber>) -> String {
    x.map(text).unwrap_or_default()
}

/// The vectors' form: `level|opacity|low|high|low text|high text`.
fn line(r: &Reliability) -> String {
    let (low_text, high_text) = r.interval_text.clone().unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{low_text}|{high_text}",
        r.level.as_str(),
        text(r.opacity),
        optional(r.interval.map(|i| i.low)),
        optional(r.interval.map(|i| i.high)),
    )
}

fn report(what: &str, failures: &[String]) {
    assert!(
        failures.is_empty(),
        "{what}: {} differences, the first:\n{}",
        failures.len(),
        failures
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_vectors_are_current() {
    let meta = &vectors()["meta"];
    assert_eq!(
        meta["definitions"].as_str(),
        Some(sha256_hex(SHIPPED_STATS).as_str()),
        "reliability-vectors.json was written from another config/stats/standard.json; run \
         `node core/rail-stats/tests/data/reliability-vectors.mjs`"
    );
    let inputs: Vec<Value> = display_cases()
        .iter()
        .map(|case| Value::Array(vec![case["key"].clone(), case["totals"].clone()]))
        .collect();
    let inputs = serde_json::to_string(&Value::Array(inputs)).expect("serialise");
    assert_eq!(
        meta["inputs"].as_str(),
        Some(sha256_hex(&inputs).as_str()),
        "reliability-vectors.json was written from another display-vectors.json; run \
         `node core/rail-stats/tests/data/reliability-vectors.mjs`"
    );
    let display = Display::shipped().expect("definitions");
    let ids: Vec<&str> = display.stats.iter().map(|s| s.id()).collect();
    let theirs: Vec<&str> = meta["stats"]
        .as_array()
        .expect("stats")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(ids, theirs);
    assert_eq!(meta["z"].as_str(), Some(rail_stats::reliability::WILSON_Z));
    assert_eq!(
        meta["opacityFloor"].as_str(),
        Some(rail_stats::reliability::OPACITY_FLOOR)
    );
}

#[test]
fn every_statistic_is_as_reliable_as_on_the_web() {
    let display = Display::shipped().expect("definitions");
    let cases = vectors()["stats"].as_array().expect("stats");
    let inputs = display_cases();
    assert_eq!(cases.len(), inputs.len(), "one case per display case");
    let mut failures = Vec::new();
    let mut intervals = 0;
    for (case, input) in cases.iter().zip(inputs) {
        let key = case["key"].as_str().expect("key");
        assert_eq!(input["key"].as_str(), Some(key), "the same order");
        let sums = sums_of(&input["totals"]);
        let want = case["out"].as_array().expect("out");
        assert_eq!(want.len(), display.stats.len(), "{key}");
        for (stat, want) in display.stats.iter().zip(want) {
            let shown = stat.show(&sums, Some(2));
            let reliability = &shown.reliability;
            assert_eq!(
                reliability.level == rail_stats::reliability::Level::Ok,
                shown.full,
                "{key} {}: ok exactly when full",
                stat.id()
            );
            intervals += usize::from(reliability.interval.is_some());
            let got = line(reliability);
            if Some(got.as_str()) != want.as_str() {
                failures.push(format!("{key} {}: {got} != {want}", stat.id()));
            }
        }
    }
    report("statistics", &failures);
    assert!(intervals > 10_000, "{intervals} intervals");
    eprintln!(
        "{} cases x {} statistics as on the web ({intervals} intervals)",
        cases.len(),
        display.stats.len()
    );
}

#[test]
fn wilson_is_the_webs() {
    let mut failures = Vec::new();
    let cases = vectors()["wilson"].as_array().expect("wilson");
    for case in cases {
        let made = case[0].as_str().expect("made");
        let n = case[1].as_str().expect("n");
        let interval = wilson(JsNumber::parse(made), JsNumber::parse(n));
        let got = [
            optional(interval.map(|i| i.low)),
            optional(interval.map(|i| i.high)),
        ];
        let want = [
            case[2].as_str().unwrap_or("?"),
            case[3].as_str().unwrap_or("?"),
        ];
        if got != want {
            failures.push(format!("wilson({made}, {n}): {got:?} != {want:?}"));
        }
    }
    report("wilson", &failures);
    assert!(cases.len() >= 3000);
}

#[test]
fn levels_and_opacity_are_the_webs() {
    let mut failures = Vec::new();
    let cases = vectors()["samples"].as_array().expect("samples");
    for case in cases {
        let sample = case[0].as_str().map(JsNumber::parse);
        let min = case[1].as_u64().expect("min");
        let (level, opacity) = sample_reliability(sample, min);
        let got = (level.as_str(), text(opacity));
        let want = (
            case[2].as_str().unwrap_or("?"),
            case[3].as_str().unwrap_or("?").to_owned(),
        );
        if got != want {
            failures.push(format!("{case}: {got:?} != {want:?}"));
        }
    }
    report("samples", &failures);
    assert!(cases.len() >= 2000);
}

#[test]
fn square_roots_are_math_sqrt() {
    let mut failures = Vec::new();
    let cases = vectors()["sqrt"].as_array().expect("sqrt");
    for case in cases {
        let x = case[0].as_str().expect("x");
        let got = text(JsNumber::parse(x).sqrt());
        if Some(got.as_str()) != case[1].as_str() {
            failures.push(format!("sqrt({x}): {got} != {}", case[1]));
        }
    }
    report("sqrt", &failures);
    assert!(cases.len() >= 3000);
}
