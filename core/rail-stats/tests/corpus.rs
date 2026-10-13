//! The stats engine over the whole golden corpus (docs/RAIL-PLAN.md R2.1).
//!
//! - **The golden diff** (the step's exit check): for every accepted hand of
//!   every golden, the canonical JSON of [`rows_for`] hashes to what the
//!   TypeScript engine's rows hash to (`testdata/golden-stats/`, written by
//!   `npm run golden:emit` in `tests/`), the seats are the same, and the
//!   per-file column totals agree. When a hash differs and the gitignored
//!   `testdata/golden-stats-full/` is there, the failure names the columns.
//! - **The invariants** of `tests/test/support/statsInvariants.ts` on every
//!   hand (`statsDerive.test.ts`'s "every invariant holds on every hand").

mod support;

use std::collections::BTreeMap;

use rail_stats::{COUNTER_KEYS, MONEY_KEYS, STATS_VERSION, StatsRow, rows_for};
use serde_json::Value;
use support::{corpus, json_files, read_json, root, rows_canonical, sha256_hex};

const MAX_REPORTED: usize = 20;

/// Column by column, where a row the port derived differs from the oracle's.
fn describe_difference(ours: &[StatsRow], theirs: &Value) -> String {
    let Some(theirs) = theirs.as_array() else {
        return "the full stats golden has no rows".to_owned();
    };
    if ours.len() != theirs.len() {
        return format!("{} rows, the oracle has {}", ours.len(), theirs.len());
    }
    let mut out = Vec::new();
    for (row, expected) in ours.iter().zip(theirs) {
        let actual = row.to_json();
        let (Some(actual), Some(expected)) = (actual.as_object(), expected.as_object()) else {
            continue;
        };
        for (key, value) in expected {
            if actual.get(key) != Some(value) {
                out.push(format!(
                    "seat {}: {key} is {:?}, the oracle has {value}",
                    row.seat.seat,
                    actual.get(key)
                ));
            }
        }
        for key in actual.keys() {
            if !expected.contains_key(key) {
                out.push(format!("seat {}: extra column {key}", row.seat.seat));
            }
        }
    }
    out.join("; ")
}

#[test]
fn every_corpus_hand_derives_the_typescript_rows() {
    let corpus = corpus();
    let stats_dir = root().join("testdata/golden-stats");
    let stats_full_dir = root().join("testdata/golden-stats-full");
    let files = json_files(&stats_dir);
    assert_eq!(
        files,
        corpus
            .files
            .iter()
            .map(|(file, _)| file.clone())
            .collect::<Vec<_>>(),
        "testdata/golden-stats/ and testdata/golden/ hold different files; run \
         `npm run golden:emit` in tests/"
    );

    let mut hands = 0_usize;
    let mut hands_matched = 0_usize;
    let mut rows_total = 0_usize;
    let mut rows_matched = 0_usize;
    let mut failures: Vec<String> = Vec::new();

    for (file, golden_hands) in &corpus.files {
        let committed = read_json(&stats_dir.join(file));
        assert_eq!(
            committed["format"].as_str(),
            Some("rail-stats-golden/1"),
            "{file}"
        );
        assert_eq!(
            committed["statsVersion"].as_str(),
            Some(STATS_VERSION),
            "{file}: the oracle's STATS_VERSION is not the port's"
        );
        let expected_hands = committed["hands"].as_array().expect("hands");
        assert_eq!(
            expected_hands.len(),
            golden_hands.len(),
            "{file}: the stats golden lists a different number of hands"
        );
        let full = stats_full_dir
            .join(file)
            .is_file()
            .then(|| read_json(&stats_full_dir.join(file)));

        let mut totals: BTreeMap<&str, i64> = BTreeMap::new();
        let mut file_rows = 0_usize;
        for (i, (expected, golden)) in expected_hands.iter().zip(golden_hands).enumerate() {
            hands += 1;
            assert_eq!(
                expected["phf"].as_str(),
                Some(golden.phf_hash.as_str()),
                "{file} hands[{i}]: the stats golden was derived from another PHF; run \
                 `npm run golden:emit` in tests/"
            );
            assert_eq!(expected["index"].as_u64(), Some(golden.index), "{file}");
            assert_eq!(
                expected["handId"].as_str(),
                Some(golden.hand_id.as_str()),
                "{file}"
            );

            let rows = rows_for(&golden.hand);
            file_rows += rows.len();
            rows_total += rows.len();
            for row in &rows {
                for (counter, value) in row.seat.counters.iter() {
                    *totals.entry(counter.name()).or_insert(0) += i64::from(value);
                }
                for (key, value) in row.seat.money.columns() {
                    *totals.entry(key).or_insert(0) += value;
                }
            }

            let seats: Vec<u64> = rows.iter().map(|row| u64::from(row.seat.seat)).collect();
            let expected_seats: Vec<u64> = expected["seats"]
                .as_array()
                .expect("seats")
                .iter()
                .filter_map(Value::as_u64)
                .collect();
            let hash = sha256_hex(&rows_canonical(&rows));
            if seats == expected_seats && expected["rows"].as_str() == Some(hash.as_str()) {
                hands_matched += 1;
                rows_matched += rows.len();
                continue;
            }
            let detail = full.as_ref().map_or_else(
                || {
                    "(no testdata/golden-stats-full/ to name the columns; run `npm run \
                     golden:emit` in tests/)"
                        .to_owned()
                },
                |full| describe_difference(&rows, &full["hands"][i]["rows"]),
            );
            failures.push(format!(
                "{file} hands[{i}] ({}): seats {seats:?} vs {expected_seats:?}: {detail}",
                golden.hand_id
            ));
        }

        assert_eq!(
            committed["rows"].as_u64(),
            u64::try_from(file_rows).ok(),
            "{file}: row count"
        );
        let expected_totals = committed["totals"].as_object().expect("totals");
        for key in COUNTER_KEYS.iter().chain(MONEY_KEYS.iter()) {
            let ours = totals.get(key).copied().unwrap_or(0);
            let theirs = expected_totals
                .get(*key)
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if ours != theirs {
                failures.push(format!(
                    "{file}: total {key} is {ours}, the oracle has {theirs}"
                ));
            }
        }
    }

    assert!(hands > 0, "the goldens hold no hands");
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(MAX_REPORTED).cloned().collect();
        panic!(
            "{hands_matched} of {hands} hands ({rows_matched} of {rows_total} rows) derive the \
             TypeScript rows; {} problems:\n{}{}",
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
        "{hands_matched} of {hands} hands, {rows_matched} of {rows_total} rows, equal the \
         TypeScript's in {} files",
        files.len()
    );
}

#[test]
fn every_invariant_holds_on_every_corpus_hand() {
    let corpus = corpus();
    let mut problems: Vec<String> = Vec::new();
    let mut hands = 0_usize;
    for hand in corpus.hands() {
        hands += 1;
        for problem in support::invariants::all_stats_invariants(&hand.hand) {
            problems.push(format!("{}: {problem}", hand.file));
        }
    }
    assert!(hands > 5000, "only {hands} corpus hands");
    assert!(
        problems.is_empty(),
        "{} invariant failures:\n{}",
        problems.len(),
        problems
            .iter()
            .take(MAX_REPORTED)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_corpus_is_what_the_typescript_suite_says_it_is() {
    // `statsDerive.test.ts`: six short-deck hands ride through every property,
    // every row is stamped, and every hand has at least two rows on average.
    let corpus = corpus();
    let hands: Vec<_> = corpus.hands().collect();
    let short_deck = hands
        .iter()
        .filter(|hand| hand.hand.game.variant == rail_core::phf::Variant::Shortdeck)
        .count();
    assert_eq!(short_deck, 6);
    let rows: usize = hands.iter().map(|hand| rows_for(&hand.hand).len()).sum();
    assert!(rows > hands.len() * 2);
}
