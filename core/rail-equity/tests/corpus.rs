//! All-in EV over the whole golden corpus (docs/RAIL-PLAN.md R2.2).
//!
//! - **The golden diff** (the step's exit check): for every accepted hand of
//!   every golden, the hero's `hand_stats_ev` row ([`ev_row_for`]) and the
//!   full analysis ([`analyze_all_in`], default options) hash to what the
//!   TypeScript's hash to (`testdata/golden-ev/`, written by `npm run
//!   golden:emit` in `tests/`), every equity bit for bit (written as
//!   `String(x)`); the per-file outcome counts and row totals agree. When a
//!   hash differs and the gitignored `testdata/golden-ev-full/` is there, the
//!   failure shows both documents.
//! - **`equityCorpus.test.ts`**: on every applicable hand, evNet and net
//!   split the same money, one evNet per stats seat, every pot paid out
//!   exactly, equities summing to 1 (exactly); and the same over the corpus
//!   outside `fixtures/samples/` with the sampled options it uses there
//!   (`exhaustiveLimit: 50_000, trials: 200`).

// Timings are printed in milliseconds, the one float in this file.
#![allow(clippy::float_arithmetic)]

mod support;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use rail_core::phf::{Street, Variant};
use rail_equity::{
    AllInEvOutcome, AllInSkipReason, Computation, EV_VERSION, EquityOptions, analyze_all_in,
    ev_row_for,
};
use serde_json::Value;
use support::{canonical, corpus, json_files, problems, read_json, root, sha256_hex};

const MAX_REPORTED: usize = 20;

/// Time spent per kind of all-in, for the performance note.
#[derive(Default)]
struct Timing {
    hands: u32,
    total: Duration,
    worst: Duration,
}

fn kind(outcome: &AllInEvOutcome) -> String {
    match outcome {
        AllInEvOutcome::Skipped { .. } => "skipped".to_owned(),
        AllInEvOutcome::Applicable(ev) => format!(
            "{} {} {}-way",
            ev.street.as_str(),
            ev.method.as_str(),
            ev.seats.iter().filter(|seat| seat.live).count()
        ),
    }
}

#[test]
fn every_corpus_hand_gives_the_typescript_ev_row_and_analysis() {
    let corpus = corpus();
    let ev_dir = root().join("testdata/golden-ev");
    let ev_full_dir = root().join("testdata/golden-ev-full");
    assert_eq!(
        json_files(&ev_dir),
        corpus
            .files
            .iter()
            .map(|(file, _)| file.clone())
            .collect::<Vec<_>>(),
        "testdata/golden-ev/ and testdata/golden/ hold different files; run \
         `npm run golden:emit` in tests/"
    );

    let mut hands = 0_usize;
    let mut rows = 0_usize;
    let mut rows_matched = 0_usize;
    let mut analyses_matched = 0_usize;
    let mut applicable_rows = 0_usize;
    let mut applicable = 0_usize;
    let mut monte_carlo = 0_usize;
    let mut short_deck = 0_usize;
    let mut hi_lo = 0_usize;
    let mut failures: Vec<String> = Vec::new();
    let mut timing: BTreeMap<String, Timing> = BTreeMap::new();

    for (file, golden_hands) in &corpus.files {
        let committed = read_json(&ev_dir.join(file));
        assert_eq!(
            committed["format"].as_str(),
            Some("rail-ev-golden/1"),
            "{file}"
        );
        assert_eq!(
            committed["evVersion"].as_str(),
            Some(EV_VERSION),
            "{file}: the oracle's EV_VERSION is not the port's"
        );
        let expected_hands = committed["hands"].as_array().expect("hands");
        assert_eq!(
            expected_hands.len(),
            golden_hands.len(),
            "{file}: the EV golden lists a different number of hands"
        );
        let full = ev_full_dir
            .join(file)
            .is_file()
            .then(|| read_json(&ev_full_dir.join(file)));

        let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
        let mut file_rows = 0_u64;
        let mut ev_net_total = 0_i64;
        let mut ev_net_bb_milli_total = 0_i64;
        for (i, (expected, golden)) in expected_hands.iter().zip(golden_hands).enumerate() {
            hands += 1;
            let where_ = format!("{file} hands[{i}] ({})", golden.hand_id);
            assert_eq!(
                expected["phf"].as_str(),
                Some(golden.phf_hash.as_str()),
                "{where_}: the EV golden was derived from another PHF; run `npm run \
                 golden:emit` in tests/"
            );
            assert_eq!(expected["index"].as_u64(), Some(golden.index), "{file}");

            let started = Instant::now();
            let outcome = analyze_all_in(&golden.hand, &EquityOptions::default());
            let elapsed = started.elapsed();
            let entry = timing.entry(kind(&outcome)).or_default();
            entry.hands += 1;
            entry.total += elapsed;
            entry.worst = entry.worst.max(elapsed);

            let key = match &outcome {
                AllInEvOutcome::Applicable(ev) => {
                    applicable += 1;
                    if ev.method == Computation::MonteCarlo {
                        monte_carlo += 1;
                    }
                    if golden.hand.game.variant == Variant::Shortdeck {
                        short_deck += 1;
                    }
                    format!("applicable/{}", ev.method.as_str())
                }
                AllInEvOutcome::Skipped { reason, .. } => {
                    if *reason == AllInSkipReason::HiLo {
                        hi_lo += 1;
                    }
                    reason.as_str().to_owned()
                }
            };
            *outcomes.entry(key).or_insert(0) += 1;
            assert_eq!(
                expected["reason"].as_str(),
                outcome.reason().map(AllInSkipReason::as_str),
                "{where_}: skip reason"
            );

            let analysis = outcome.to_json();
            if expected["analysis"].as_str()
                == Some(sha256_hex(&canonical(analysis.clone())).as_str())
            {
                analyses_matched += 1;
            } else {
                let theirs = full
                    .as_ref()
                    .map_or(Value::Null, |full| full["hands"][i]["analysis"].clone());
                failures.push(format!(
                    "{where_}: analysis\n  ours   {analysis}\n  theirs {theirs}"
                ));
            }

            let row = ev_row_for(&golden.hand);
            if let Some(row) = &row {
                rows += 1;
                file_rows += 1;
                ev_net_total += row.ev_net;
                ev_net_bb_milli_total += row.ev_net_bb_milli;
                if row.applicable {
                    applicable_rows += 1;
                }
            }
            let row_hash = row
                .as_ref()
                .map(|row| sha256_hex(&canonical(row.to_json())));
            if expected["row"].as_str() == row_hash.as_deref() {
                if row.is_some() {
                    rows_matched += 1;
                }
            } else {
                let theirs = full
                    .as_ref()
                    .map_or(Value::Null, |full| full["hands"][i]["row"].clone());
                failures.push(format!(
                    "{where_}: row\n  ours   {:?}\n  theirs {theirs}",
                    row.as_ref().map(|row| row.to_json())
                ));
            }

            failures.extend(problems(&golden.hand, &outcome));
        }

        assert_eq!(committed["rows"].as_u64(), Some(file_rows), "{file}: rows");
        let expected_outcomes: BTreeMap<String, u64> = committed["outcomes"]
            .as_object()
            .expect("outcomes")
            .iter()
            .map(|(key, value)| (key.clone(), value.as_u64().expect("count")))
            .collect();
        if expected_outcomes != outcomes {
            failures.push(format!(
                "{file}: outcomes {outcomes:?}, the oracle has {expected_outcomes:?}"
            ));
        }
        for (key, ours) in [
            ("ev_net", ev_net_total),
            ("ev_net_bb_milli", ev_net_bb_milli_total),
        ] {
            let theirs = committed["totals"][key].as_i64();
            if theirs != Some(ours) {
                failures.push(format!(
                    "{file}: total {key} is {ours}, the oracle has {theirs:?}"
                ));
            }
        }
    }

    assert!(hands > 0, "the goldens hold no hands");
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(MAX_REPORTED).cloned().collect();
        panic!(
            "{rows_matched} of {rows} EV rows and {analyses_matched} of {hands} analyses equal \
             the TypeScript's; {} problems:\n{}{}",
            failures.len(),
            shown.join("\n"),
            if failures.len() > MAX_REPORTED {
                format!("\n... and {} more", failures.len() - MAX_REPORTED)
            } else {
                String::new()
            }
        );
    }
    println!(
        "{rows_matched} of {rows} EV rows ({applicable_rows} applicable) and {analyses_matched} \
         of {hands} analyses ({applicable} applicable: {monte_carlo} Monte Carlo, {short_deck} \
         short deck; {hi_lo} declined as hi/lo) equal the TypeScript's in {} files",
        corpus.files.len()
    );
    for (kind, entry) in &timing {
        println!(
            "  {kind}: {} hands, {:.2} ms mean, {:.2} ms worst",
            entry.hands,
            entry.total.as_secs_f64() * 1e3 / f64::from(entry.hands.max(1)),
            entry.worst.as_secs_f64() * 1e3
        );
    }
}

#[test]
fn the_rest_of_the_corpus_splits_the_same_money_with_sampled_equity() {
    // `equityCorpus.test.ts` "all-in EV over the rest of the corpus, sampled
    // equity": the identity does not depend on how equity was computed.
    let options = EquityOptions {
        exhaustive_limit: Some(50_000),
        trials: Some(200),
        ..EquityOptions::default()
    };
    let corpus = corpus();
    let mut rest = 0_usize;
    let mut applicable = 0_usize;
    let mut sampled = 0_usize;
    let mut failures = Vec::new();
    for (file, hands) in &corpus.files {
        if file.starts_with("fixtures/samples/") {
            continue;
        }
        for golden in hands {
            rest += 1;
            let outcome = analyze_all_in(&golden.hand, &options);
            if let Some(ev) = outcome.ev() {
                applicable += 1;
                if ev.method == Computation::MonteCarlo {
                    sampled += 1;
                }
            }
            failures.extend(problems(&golden.hand, &outcome));
        }
    }
    assert!(rest > 6000, "{rest} hands outside fixtures/samples/");
    assert!(applicable > 300, "{applicable} applicable");
    assert!(sampled > 0, "nothing was sampled");
    assert_eq!(failures, Vec::<String>::new());
}

#[test]
fn the_samples_find_all_ins_worth_adjusting_and_skip_only_for_a_reason() {
    // `equityCorpus.test.ts` "all-in EV over fixtures/samples, default
    // options": a floor on the all-ins found, and "no-all-in" among the
    // reasons.
    let corpus = corpus();
    let mut samples = 0_usize;
    let mut applicable = 0_usize;
    let mut no_all_in = false;
    for (file, hands) in &corpus.files {
        if !file.starts_with("fixtures/samples/") {
            continue;
        }
        for golden in hands {
            samples += 1;
            match analyze_all_in(&golden.hand, &EquityOptions::default()) {
                AllInEvOutcome::Applicable(ev) => {
                    applicable += 1;
                    assert!(matches!(
                        ev.street,
                        Street::Preflop | Street::Flop | Street::Turn
                    ));
                }
                AllInEvOutcome::Skipped { reason, .. } => {
                    no_all_in |= reason == AllInSkipReason::NoAllIn;
                }
            }
        }
    }
    assert!(samples > 1500, "{samples} sample hands");
    assert!(applicable > 100, "{applicable} applicable");
    assert!(no_all_in);
}
