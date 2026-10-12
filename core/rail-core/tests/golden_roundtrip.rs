//! Every golden hand survives the Rust PHF model unchanged (docs/RAIL-PLAN.md
//! R0.4).
//!
//! For each corpus file the committed golden (`testdata/golden/`) pins every
//! accepted hand by the sha-256 of its canonical JSON; the gitignored full tree
//! (`testdata/golden-full/`, written by `npm run golden:emit` in `tests/`)
//! holds the bodies. This test:
//!
//! 1. checks the full tree is the committed oracle and not the output of some
//!    other checkout: the same files, and each full document equal to its
//!    committed one once every PHF body is replaced by its canonical hash;
//! 2. deserializes every body into [`PhfHand`] - strictly: unknown fields,
//!    a missing `T | null` field and a `null` optional field are all errors;
//! 3. re-serializes it with [`to_canonical_json`] and requires the same bytes,
//!    and so the same hash.
//!
//! The full tree is required. Without it the test fails and says how to make
//! it, rather than passing having checked nothing.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use rail_core::canonical::{to_canonical_json, value_to_canonical_json};
use rail_core::phf::PhfHand;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Failures listed in full before the rest are only counted.
const MAX_REPORTED: usize = 20;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// Every `*.json` below `dir`, as `/`-separated paths relative to it, sorted.
fn json_files(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                walk(base, &path, out);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let relative = path.strip_prefix(base).expect("path below its base");
                let parts: Vec<_> = relative
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(parts.join("/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// Line-level description of where two texts first differ.
fn first_difference(expected: &str, actual: &str) -> String {
    for (n, (e, a)) in expected.lines().zip(actual.lines()).enumerate() {
        if e != a {
            return format!("line {}: expected {e:?}, got {a:?}", n + 1);
        }
    }
    format!(
        "lengths differ: expected {} lines, got {}",
        expected.lines().count(),
        actual.lines().count()
    )
}

#[test]
fn every_golden_hand_round_trips_through_the_rust_model() {
    let golden_dir = root().join("testdata/golden");
    let full_dir = root().join("testdata/golden-full");
    assert!(
        full_dir.is_dir(),
        "testdata/golden-full/ is missing. It holds the PHF bodies this test needs and is \
         gitignored; generate it with\n\n    cd tests && npm ci && npm run golden:emit\n\n\
         (~15 s; see testdata/golden/README.md)."
    );

    let committed_files = json_files(&golden_dir);
    let full_files = json_files(&full_dir);
    assert!(
        !committed_files.is_empty(),
        "no goldens under testdata/golden/"
    );
    assert_eq!(
        committed_files, full_files,
        "testdata/golden-full/ does not hold the same files as testdata/golden/. It is stale \
         or from another checkout; regenerate it with `npm run golden:emit` in tests/."
    );

    let mut hands = 0_usize;
    let mut failures: Vec<String> = Vec::new();

    for file in &committed_files {
        let committed = read_json(&golden_dir.join(file));
        let mut full = read_json(&full_dir.join(file));

        let Some(full_hands) = full.get_mut("hands").and_then(Value::as_array_mut) else {
            panic!("{file}: full golden has no `hands` list");
        };
        let mut bodies = Vec::with_capacity(full_hands.len());
        for (i, hand) in full_hands.iter_mut().enumerate() {
            let Some(slot) = hand.get_mut("phf") else {
                panic!("{file}: hands[{i}] has no `phf`");
            };
            let text = value_to_canonical_json(slot.take())
                .unwrap_or_else(|e| panic!("{file}: hands[{i}].phf: {e}"));
            *slot = Value::String(sha256_hex(&text));
            bodies.push(text);
        }

        // With every body replaced by its hash, the full document must be the
        // committed one: same hashes, and the same everything else.
        assert!(
            full == committed,
            "{file}: testdata/golden-full/ does not match the committed golden. It is stale \
             or from another checkout; regenerate it with `npm run golden:emit` in tests/."
        );

        for (i, expected) in bodies.into_iter().enumerate() {
            hands += 1;
            let hand: PhfHand = match serde_json::from_str(&expected) {
                Ok(hand) => hand,
                Err(e) => {
                    failures.push(format!("{file} hands[{i}]: does not deserialize: {e}"));
                    continue;
                }
            };
            match to_canonical_json(&hand) {
                Ok(actual) if actual == expected => {}
                Ok(actual) => failures.push(format!(
                    "{file} hands[{i}]: re-serializes differently (sha256 {} vs golden {}): {}",
                    sha256_hex(&actual),
                    sha256_hex(&expected),
                    first_difference(&expected, &actual)
                )),
                Err(e) => failures.push(format!("{file} hands[{i}]: {e}")),
            }
        }
    }

    assert!(hands > 0, "the goldens hold no hands");
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(MAX_REPORTED).cloned().collect();
        panic!(
            "{} of {hands} golden hands do not round-trip through the Rust PHF model:\n{}{}",
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
        "{hands} hands in {} golden files round-trip byte for byte",
        committed_files.len()
    );
}
