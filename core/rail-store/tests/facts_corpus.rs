//! The filter builder's facts over the whole golden corpus (2026-11-16, the
//! owner: one filter everywhere, app and web).
//!
//! For every hand of every golden, [`rail_store::facts::derive`] (through
//! `PreparedStats::from_phf`, as the store writes `hand_list`) must equal
//! what the web's TypeScript port derives (`web/src/lib/stats/builderFacts.ts`,
//! written to `testdata/golden-facts/` by `npm run golden:emit` in `tests/`),
//! field by field: the web's builder filters then mean the app's.

use std::path::{Path, PathBuf};

use rail_core::phf::PhfHand;
use rail_store::batch::PreparedStats;
use rail_store::facts::HandExtras;
use serde_json::{Value, json};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            json_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "json") {
            out.push(path);
        }
    }
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The Rust facts in the TypeScript port's shape (`BuilderFacts`).
fn as_json(extras: &HandExtras) -> Value {
    json!({
        "openTenths": extras.open_tenths,
        "betPct": extras.bet_pct,
        "made": extras.made,
        "kicker": extras.kicker,
        "draws": extras.draws,
        "playersFlop": extras.players_flop,
        "heroIp": extras.hero_ip,
        "vsSeats": extras.vs_seats,
        "vsPositions": extras.vs_positions,
        "buyInCents": extras.buy_in_cents,
        "bounty": extras.bounty,
        "level": extras.level,
        "bluff": extras.bluff,
    })
}

#[test]
fn every_corpus_hand_derives_the_typescript_facts() {
    let facts_dir = root().join("testdata/golden-facts");
    let full_dir = root().join("testdata/golden-full");
    assert!(
        full_dir.is_dir(),
        "testdata/golden-full/ is missing (gitignored); generate it with\n\n    cd tests && npm ci && \
         npm run golden:emit\n"
    );
    let mut files = Vec::new();
    json_files(&facts_dir, &mut files);
    assert!(
        files.len() > 100,
        "testdata/golden-facts/ holds {} files; run `npm run golden:emit` in tests/",
        files.len()
    );

    let (mut hands, mut failures) = (0_usize, Vec::new());
    for path in &files {
        let relative = path.strip_prefix(&facts_dir).expect("under the facts dir");
        let golden = read_json(path);
        let full = read_json(&full_dir.join(relative));
        let expected = golden["hands"].as_array().expect("hands");
        let bodies = full["hands"].as_array().expect("hands");
        assert_eq!(
            expected.len(),
            bodies.len(),
            "{}: testdata/golden-full/ is stale; regenerate it",
            relative.display()
        );
        for (i, (want, body)) in expected.iter().zip(bodies).enumerate() {
            hands += 1;
            let hand: PhfHand = serde_json::from_value(body["phf"].clone())
                .unwrap_or_else(|e| panic!("{} hands[{i}]: {e}", relative.display()));
            let ours = as_json(&PreparedStats::from_phf(&hand).list.extras);
            let theirs = &want["facts"];
            if &ours != theirs {
                let mut fields = Vec::new();
                for (key, value) in theirs.as_object().into_iter().flatten() {
                    if ours.get(key) != Some(value) {
                        fields.push(format!(
                            "{key}: ours {:?}, the web's {value}",
                            ours.get(key)
                        ));
                    }
                }
                failures.push(format!(
                    "{} hands[{i}] ({}): {}",
                    relative.display(),
                    want["handId"],
                    fields.join("; ")
                ));
            }
        }
    }
    assert!(hands > 1000, "only {hands} hands in the corpus");
    assert!(
        failures.is_empty(),
        "{} of {hands} hands differ; the first:\n{}",
        failures.len(),
        failures
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
