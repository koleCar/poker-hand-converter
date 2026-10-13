//! The display definitions (docs/RAIL-PLAN.md R2.4) against the web's
//! evaluator: `tests/data/display-vectors.json`, written by
//! `display-vectors.mjs` from `frontend/src/lib/stats/display.ts` - which
//! that script holds to `rates.ts` (the same doubles) and to the web's
//! `Intl.NumberFormat` (the same text) before writing a case.
//!
//! - **The corpus** summed as reports sum it (every golden file, directory,
//!   position and game format, the hero's, the whole corpus): the totals of
//!   [`rows_for`] through [`aggregate`] are the TypeScript's, then every
//!   shipped statistic's value (bit for bit), text, tone, sample and opacity.
//! - **Synthetic totals**: rounding ties, empty samples, huge and negative
//!   values, all-in EV.
//! - **Formulas** outside the shipped set: the parse or the error message,
//!   and the values.
//! - **Formatting**: [`format_fixed`] against the web's text for 5 000
//!   doubles and decimals.
//!
//! And the CI rule of guideline §14 on the Rust side: the shipped file
//! loads (every name a counter, ids unique, bands ascending), and the
//! vectors were written from it (a stale file says so).

mod support;

use std::collections::BTreeMap;

use rail_config::stats::{SHIPPED_STATS, parse_formula};
use rail_core::js::JsNumber;
use rail_stats::display::{
    AggregateOptions, Display, Formula, MONEY_COUNT, Shown, Sums, aggregate, format_fixed,
    variable_names,
};
use rail_stats::{COUNTER_COUNT, StatsRow, rows_for};
use serde_json::Value;
use support::{corpus, read_json, root, sha256_hex};

fn vectors() -> &'static Value {
    static VECTORS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    VECTORS
        .get_or_init(|| read_json(&root().join("core/rail-stats/tests/data/display-vectors.json")))
}

fn sums_of(totals: &Value) -> Sums {
    let values = totals.as_array().expect("totals");
    assert_eq!(
        values.len(),
        COUNTER_COUNT + MONEY_COUNT + 2,
        "totals width"
    );
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

fn totals_of(sums: &Sums) -> Vec<Value> {
    sums.counters
        .iter()
        .chain(sums.money.iter())
        .chain(std::iter::once(&sums.money_hands))
        .map(|&v| Value::from(v))
        .chain(std::iter::once(
            sums.ev_net_bb_milli.map_or(Value::Null, Value::from),
        ))
        .collect()
}

/// A shown statistic in the vectors' form: `value|text|tone|sample|full`.
fn line(shown: &Shown) -> String {
    let number = |n: Option<JsNumber>| n.map(JsNumber::to_js_string).unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{}",
        number(shown.value),
        shown.text.clone().unwrap_or_default(),
        shown.tone.map(|t| t.as_str()).unwrap_or_default(),
        number(shown.sample),
        u8::from(shown.full)
    )
}

/// Every shipped statistic over one case; the differences, named.
fn compare(
    display: &Display,
    key: &str,
    sums: &Sums,
    expected: &Value,
    failures: &mut Vec<String>,
) {
    let expected = expected.as_array().expect("out");
    assert_eq!(
        expected.len(),
        display.stats.len(),
        "{key}: one output per statistic"
    );
    for (stat, want) in display.stats.iter().zip(expected) {
        // The vectors print money with two minor digits.
        let got = line(&stat.show(sums, Some(2)));
        let want = want.as_str().expect("an output line");
        if got != want {
            failures.push(format!("{key} {}: {got} != {want}", stat.id()));
        }
    }
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
fn the_shipped_definitions_load_and_the_vectors_are_theirs() {
    let display = Display::shipped().unwrap_or_else(|e| panic!("{e}"));
    let meta = &vectors()["meta"];
    assert_eq!(
        meta["definitions"].as_str(),
        Some(sha256_hex(SHIPPED_STATS).as_str()),
        "display-vectors.json was written from another config/stats/standard.json; run \
         `node core/rail-stats/tests/data/display-vectors.mjs`"
    );
    let ids: Vec<&str> = display.stats.iter().map(|s| s.id()).collect();
    let theirs: Vec<&str> = meta["stats"]
        .as_array()
        .expect("stats")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(ids, theirs);
    let names: Vec<&str> = meta["totals"]
        .as_array()
        .expect("totals")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        names,
        variable_names(),
        "the TypeScript binds the same names"
    );
    assert!(
        display.stats.len() >= 30,
        "the starting set of guideline §5"
    );
}

#[test]
fn the_corpus_totals_display_as_on_the_web() {
    let display = Display::shipped().expect("definitions");
    // The rows, grouped as display-vectors.mjs groups them.
    let mut groups: BTreeMap<String, Vec<StatsRow>> = BTreeMap::new();
    for (file, hands) in &corpus().files {
        let directory = file.rsplit_once('/').map_or("", |(dir, _)| dir).to_owned();
        for golden in hands {
            for row in rows_for(&golden.hand) {
                let json = row.to_json();
                let position = json["position"].as_str().unwrap_or("").to_owned();
                let format = json["game_format"].as_str().unwrap_or("").to_owned();
                let mut keys = vec![
                    format!("file:{file}"),
                    format!("dir:{directory}"),
                    "all".to_owned(),
                    format!("position:{position}"),
                    format!("format:{format}"),
                ];
                if row.seat.is_hero {
                    keys.push(format!("hero-dir:{directory}"));
                    keys.push("hero".to_owned());
                    keys.push(format!("hero-position:{position}"));
                }
                for key in keys {
                    groups.entry(key).or_default().push(row.clone());
                }
            }
        }
    }
    let cases = vectors()["groups"].as_array().expect("groups");
    assert_eq!(
        cases
            .iter()
            .map(|c| c["key"].as_str().unwrap_or(""))
            .collect::<Vec<_>>(),
        groups.keys().map(String::as_str).collect::<Vec<_>>(),
        "the same groups"
    );
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in cases {
        let key = case["key"].as_str().expect("key");
        let sums = aggregate(&groups[key], AggregateOptions::default());
        assert_eq!(
            totals_of(&sums),
            *case["totals"].as_array().expect("totals"),
            "{key}: the totals of the Rust rows"
        );
        compare(&display, key, &sums, &case["out"], &mut failures);
        compared += display.stats.len();
    }
    report("corpus groups", &failures);
    eprintln!(
        "{} corpus groups, {compared} statistics shown as on the web",
        cases.len()
    );
}

#[test]
fn synthetic_totals_display_as_on_the_web() {
    let display = Display::shipped().expect("definitions");
    let cases = vectors()["synthetic"].as_array().expect("synthetic");
    let mut failures = Vec::new();
    for case in cases {
        let key = case["key"].as_str().expect("key");
        compare(
            &display,
            key,
            &sums_of(&case["totals"]),
            &case["out"],
            &mut failures,
        );
    }
    report("synthetic totals", &failures);
    assert!(cases.len() >= 500);
}

#[test]
fn formulas_parse_and_evaluate_as_on_the_web() {
    let samples: Vec<Sums> = vectors()["synthetic"]
        .as_array()
        .expect("synthetic")
        .iter()
        .map(|case| sums_of(&case["totals"]))
        .collect();
    let names = variable_names();
    for case in vectors()["formulas"].as_array().expect("formulas") {
        let text = case["text"].as_str().expect("text");
        match (parse_formula(text), case.get("parsed")) {
            (Ok(expr), Some(parsed)) => {
                assert_eq!(Some(expr.to_string().as_str()), parsed.as_str(), "{text:?}");
                assert!(expr.names().iter().all(|n| names.contains(n)), "{text:?}");
                let formula = Formula::compile(&expr).expect("binds");
                for (i, want) in case["values"]
                    .as_array()
                    .expect("values")
                    .iter()
                    .enumerate()
                {
                    let got = formula.eval(&samples[i]).map(JsNumber::to_js_string);
                    assert_eq!(got.as_deref(), want.as_str(), "{text:?} over synthetic:{i}");
                }
            }
            (Err(error), None) => {
                assert_eq!(
                    Some(error.to_string().as_str()),
                    case["error"].as_str(),
                    "{text:?}"
                );
            }
            (got, _) => panic!("{text:?}: Rust says {got:?}, the TypeScript {case}"),
        }
    }
}

#[test]
fn text_is_the_webs() {
    let mut failures = Vec::new();
    let formats = vectors()["formats"].as_array().expect("formats");
    for case in formats {
        let value = case[0].as_str().expect("value");
        let decimals = u32::try_from(case[1].as_u64().expect("decimals")).expect("u32");
        let got = format_fixed(JsNumber::parse(value), decimals);
        if Some(got.as_str()) != case[2].as_str() {
            failures.push(format!("{value} at {decimals}: {got} != {}", case[2]));
        }
    }
    report("format_fixed", &failures);
    assert!(formats.len() >= 5000);
}
