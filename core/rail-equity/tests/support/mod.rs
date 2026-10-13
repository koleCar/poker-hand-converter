//! What the rail-equity tests share: the golden corpus (every accepted hand
//! of `testdata/golden-full/`, checked against the committed hashes first,
//! as in rail-stats), canonical hashing, and the equity identities of
//! `tests/test/equityCorpus.test.ts`.

#![allow(dead_code, clippy::unwrap_used)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_core::canonical::value_to_canonical_json;
use rail_core::phf::PhfHand;
use rail_equity::AllInEvOutcome;
use rail_stats::hand_facts;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

pub fn canonical(value: Value) -> String {
    value_to_canonical_json(value).expect("canonical JSON")
}

/// Every `*.json` below `dir`, as `/`-separated relative paths, sorted.
pub fn json_files(dir: &Path) -> Vec<String> {
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

pub fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// One accepted hand of the golden corpus.
pub struct GoldenHand {
    /// Chunk index (`hands[i].index`).
    pub index: u64,
    pub hand_id: String,
    /// sha-256 of the canonical PHF.
    pub phf_hash: String,
    pub hand: PhfHand,
}

pub struct Corpus {
    /// Every golden file (its path below `testdata/golden/`), in order, with
    /// its hands.
    pub files: Vec<(String, Vec<GoldenHand>)>,
}

impl Corpus {
    /// The hands of one corpus input (`gg-hh/....txt`).
    pub fn file(&self, input: &str) -> &[GoldenHand] {
        let name = format!("{input}.json");
        self.files
            .iter()
            .find(|(file, _)| *file == name)
            .map(|(_, hands)| hands.as_slice())
            .unwrap_or_else(|| panic!("no golden for {input}"))
    }

    /// The hand with this id in one corpus input.
    pub fn hand(&self, input: &str, hand_id: &str) -> &PhfHand {
        &self
            .file(input)
            .iter()
            .find(|golden| golden.hand_id == hand_id)
            .unwrap_or_else(|| panic!("{input} has no hand {hand_id}"))
            .hand
    }
}

/// The golden corpus, loaded once per test binary. Fails, rather than
/// skipping, when `testdata/golden-full/` is missing or stale.
pub fn corpus() -> &'static Corpus {
    static CORPUS: OnceLock<Corpus> = OnceLock::new();
    CORPUS.get_or_init(load_corpus)
}

fn load_corpus() -> Corpus {
    let golden_dir = root().join("testdata/golden");
    let full_dir = root().join("testdata/golden-full");
    assert!(
        full_dir.is_dir(),
        "testdata/golden-full/ is missing. It holds the PHF bodies these tests need and is \
         gitignored; generate it with\n\n    cd tests && npm ci && npm run golden:emit\n\n\
         (see testdata/golden/README.md)."
    );
    let committed_files = json_files(&golden_dir);
    assert!(
        !committed_files.is_empty(),
        "no goldens under testdata/golden/"
    );
    assert_eq!(
        committed_files,
        json_files(&full_dir),
        "testdata/golden-full/ does not hold the same files as testdata/golden/; regenerate \
         it with `npm run golden:emit` in tests/."
    );

    let mut files = Vec::with_capacity(committed_files.len());
    for file in committed_files {
        let committed = read_json(&golden_dir.join(&file));
        let full = read_json(&full_dir.join(&file));
        let committed_hands = committed["hands"].as_array().expect("hands");
        let full_hands = full["hands"].as_array().expect("hands");
        assert_eq!(
            committed_hands.len(),
            full_hands.len(),
            "{file}: testdata/golden-full/ is stale; regenerate it"
        );
        let mut hands = Vec::with_capacity(full_hands.len());
        for (i, (summary, body)) in committed_hands.iter().zip(full_hands).enumerate() {
            let phf_text = value_to_canonical_json(body["phf"].clone())
                .unwrap_or_else(|e| panic!("{file} hands[{i}].phf: {e}"));
            let phf_hash = sha256_hex(&phf_text);
            assert_eq!(
                summary["phf"].as_str(),
                Some(phf_hash.as_str()),
                "{file} hands[{i}]: testdata/golden-full/ does not match the committed \
                 golden; regenerate it with `npm run golden:emit` in tests/."
            );
            let hand: PhfHand = serde_json::from_str(&phf_text)
                .unwrap_or_else(|e| panic!("{file} hands[{i}]: {e}"));
            hands.push(GoldenHand {
                index: summary["index"].as_u64().expect("index"),
                hand_id: summary["handId"].as_str().expect("handId").to_owned(),
                phf_hash,
                hand,
            });
        }
        files.push((file, hands));
    }
    Corpus { files }
}

/// `problems({ hand, outcome })` of `equityCorpus.test.ts`: every broken
/// property of one hand's EV. evNet and net are two divisions of the same
/// money, so they sum to the same total over the seats; there is one evNet
/// per stats seat; every pot pays out exactly its amount; every pot's
/// equities sum to 1 - here exactly, as rationals, where the TypeScript
/// allows 1e-9 on the doubles.
pub fn problems(hand: &PhfHand, outcome: &AllInEvOutcome) -> Vec<String> {
    let Some(ev) = outcome.ev() else {
        return Vec::new();
    };
    let id = format!("{} {}", hand.meta.site_id, hand.meta.hand_id);
    let mut out = Vec::new();

    let facts = hand_facts(hand);
    let net: i64 = facts.seats.iter().map(|seat| seat.money.net).sum();
    let ev_net: i64 = ev.seats.iter().map(|seat| seat.ev_net).sum();
    if net != ev_net {
        out.push(format!("{id}: seats net {net}, evNet {ev_net}"));
    }
    let stat_seats: Vec<u32> = facts.seats.iter().map(|seat| seat.seat).collect();
    let ev_seats: Vec<u32> = ev.seats.iter().map(|seat| seat.seat).collect();
    if stat_seats != ev_seats {
        out.push(format!(
            "{id}: stats seats {stat_seats:?}, ev seats {ev_seats:?}"
        ));
    }
    for pot in &ev.pots {
        let shares: i64 = pot.shares.iter().sum();
        if shares != pot.amount {
            out.push(format!("{id}: pot of {} paid out {shares}", pot.amount));
        }
        let units: u128 = pot.equity_units.iter().map(|&u| u128::from(u)).sum();
        if units != ev.denominator() {
            out.push(format!(
                "{id}: pot equity sums to {units} / {}",
                ev.denominator()
            ));
        }
    }
    out
}
