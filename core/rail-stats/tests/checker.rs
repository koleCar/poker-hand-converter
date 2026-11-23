//! The Analytics stat checker (docs/ANALYTICS.md Step 3,
//! `rail_stats::checker`) against its TypeScript twin
//! (`web/src/lib/stats/checker.ts`):
//!
//! - **Golden vectors.** Every case of `tests/data/analytics/checker/
//!   cases.json` gives exactly the result in `expected.json`, which
//!   `tests/test/analyticsChecker.test.ts` writes from the TypeScript (and
//!   holds the words of, in English and Croatian): every number bit for bit,
//!   every tone, order and finding.
//! - **Properties** over random sums: no tone stronger than `few` below a
//!   stat's `sample.min` (breakdown rows included), and a player equal to the
//!   reference is always `ok`.

#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

mod support;

use std::collections::BTreeMap;

use rail_stats::analytics::{StatKind, catalogue};
use rail_stats::checker::{CheckResult, CodedIn, Figures, GroupIn, SumsIn, Tone, check_stats};
use serde::Deserialize;
use serde_json::Value;
use support::{read_json, root};

const DIR: &str = "core/rail-stats/tests/data/analytics/checker";

#[derive(Deserialize)]
struct Case {
    name: String,
    sums: SumsIn,
    coded: BTreeMap<String, CodedIn>,
}

/// JSON equality with numbers compared as doubles (the TypeScript writes
/// `0` where serde writes `0.0`).
fn same(path: &str, a: &Value, b: &Value) -> Result<(), String> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64(), y.as_f64());
            if x == y {
                Ok(())
            } else {
                Err(format!("{path}: {x:?} != {y:?}"))
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Err(format!("{path}: {} items != {}", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .try_for_each(|(i, (x, y))| same(&format!("{path}[{i}]"), x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            let keys_x: Vec<&String> = x.keys().collect();
            let keys_y: Vec<&String> = y.keys().collect();
            if keys_x != keys_y {
                return Err(format!("{path}: keys {keys_x:?} != {keys_y:?}"));
            }
            x.iter()
                .try_for_each(|(k, v)| same(&format!("{path}.{k}"), v, &y[k]))
        }
        _ if a == b => Ok(()),
        _ => Err(format!("{path}: {a} != {b}")),
    }
}

#[test]
fn the_golden_vectors_are_the_typescripts() {
    let cases = read_json(&root().join(DIR).join("cases.json"));
    let expected = read_json(&root().join(DIR).join("expected.json"));
    let cases: Vec<Case> =
        serde_json::from_value(cases["cases"].clone()).expect("cases.json reads");
    let expected = expected["cases"].as_array().expect("expected cases");
    assert_eq!(cases.len(), expected.len(), "one expectation per case");
    assert!(cases.len() >= 9, "the fixture holds its cases");
    for (case, want) in cases.iter().zip(expected) {
        assert_eq!(want["name"], case.name.as_str());
        let got = check_stats(catalogue(), &case.sums, &case.coded);
        let got = serde_json::to_value(&got).expect("serialises");
        if let Err(diff) = same(&case.name, &got, &want["result"]) {
            panic!("{diff}");
        }
    }
}

#[test]
fn the_cases_say_what_they_are_for() {
    let cases = read_json(&root().join(DIR).join("cases.json"));
    let cases: Vec<Case> =
        serde_json::from_value(cases["cases"].clone()).expect("cases.json reads");
    let run = |name: &str| -> CheckResult {
        let case = cases.iter().find(|c| c.name == name).expect(name);
        check_stats(catalogue(), &case.sums, &case.coded)
    };

    let over = run("overfolder");
    let flop = over
        .stats
        .iter()
        .find(|s| s.id == "flop_fold_vs_bet")
        .expect("flop fold");
    assert_eq!(flop.figures.tone, Tone::Far);
    assert!(flop.figures.cost > 0.0);
    let first = &over.findings[0];
    assert_eq!(first.family, "gives_up");
    let probe = first
        .stats
        .iter()
        .find(|s| s.id == "turn_fold_vs_probe")
        .expect("probe in the finding");
    assert!(!probe.counted, "the probe is inside turn fold");

    let perfect = run("perfect");
    assert!(perfect.findings.is_empty());
    for stat in &perfect.stats {
        if stat.kind != "coded" {
            assert_eq!(stat.figures.tone, Tone::Ok, "{}", stat.id);
        }
    }

    let few = run("few");
    assert!(few.findings.is_empty());
    assert!(
        few.stats
            .iter()
            .any(|s| s.figures.tone == Tone::Few && s.id == "flop_fold_vs_bet")
    );
}

/* ------------------------------------------------------- properties -- */

/// Park-Miller, as the TypeScript's.
struct Random(i64);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = (self.0 * 16807) % 2_147_483_647;
        self.0 as f64 / 2_147_483_647.0
    }

    #[allow(clippy::cast_possible_truncation)]
    fn below(&mut self, n: i64) -> i64 {
        (self.next() * n as f64).floor() as i64
    }
}

const SIZES: [&str; 4] = ["20-40", "40-60", "60-85", "85-125"];

fn random_sums(rnd: &mut Random, equal: bool) -> SumsIn {
    let cat = catalogue();
    let mut groups = Vec::new();
    for stat in &cat.stats {
        if !matches!(stat.kind, StatKind::Rate { .. }) {
            continue;
        }
        let preflop = stat.group.starts_with("preflop");
        for s in 0..=rnd.below(3) {
            let classes: Vec<String> = if preflop {
                vec![String::new()]
            } else {
                cat.hand_classes
                    .iter()
                    .filter(|_| rnd.next() < 0.4)
                    .map(|c| c.id.clone())
                    .collect()
            };
            for class in classes {
                let n = if rnd.next() < 0.8 {
                    rnd.below(60)
                } else {
                    rnd.below(3000)
                };
                let taken = rnd.below(n.max(1)).min(n);
                let size = if preflop {
                    String::new()
                } else {
                    SIZES[usize::try_from(rnd.below(4)).unwrap_or(0)].to_owned()
                };
                groups.push(GroupIn {
                    stat: stat.id.clone(),
                    spot: format!("single-raised|caller|BB|S{s}"),
                    size,
                    hand_class: class,
                    opps: n + rnd.below(5),
                    opps_taken: taken,
                    n,
                    taken,
                    ref_share: if equal {
                        taken as f64
                    } else {
                        (rnd.next() * n as f64 * 1e6).round() / 1e6
                    },
                    ev_high: rnd.next() * taken as f64,
                    ev_low: rnd.next() * (n - taken) as f64,
                    hands: n,
                });
            }
        }
    }
    SumsIn {
        hands: 1 + rnd.below(50_000),
        pending: 0,
        groups,
    }
}

fn all_figures(result: &CheckResult) -> Vec<(&str, &Figures)> {
    let mut out = Vec::new();
    for stat in &result.stats {
        out.push((stat.id.as_str(), &stat.figures));
        for row in stat.spots.iter().chain(&stat.sizes).chain(&stat.classes) {
            out.push((stat.id.as_str(), &row.figures));
        }
    }
    out
}

#[test]
fn no_tone_stronger_than_few_below_the_sample_minimum() {
    let cat = catalogue();
    let mut rnd = Random(7);
    let none = BTreeMap::new();
    for _ in 0..300 {
        let result = check_stats(cat, &random_sums(&mut rnd, false), &none);
        for (id, figures) in all_figures(&result) {
            let min = i64::from(cat.get(id).expect("a stat").1.sample_min);
            if figures.n < min {
                assert!(
                    !matches!(figures.tone, Tone::Off | Tone::Far),
                    "{id}: n {} under {min} is {:?}",
                    figures.n,
                    figures.tone
                );
            }
        }
    }
}

#[test]
fn a_player_equal_to_the_reference_is_ok() {
    let cat = catalogue();
    let mut rnd = Random(13);
    let none = BTreeMap::new();
    for _ in 0..300 {
        let result = check_stats(cat, &random_sums(&mut rnd, true), &none);
        for (id, figures) in all_figures(&result) {
            if figures.n > 0 && figures.target.is_some() {
                assert_eq!(figures.tone, Tone::Ok, "{id}");
            }
        }
        assert!(result.findings.is_empty());
    }
}
