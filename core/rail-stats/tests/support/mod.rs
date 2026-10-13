//! What the rail-stats tests share: the golden corpus (every accepted hand of
//! `testdata/golden-full/`, checked against the committed hashes first), the
//! canonical form of a hand's rows, and the invariants of
//! `tests/test/support/statsInvariants.ts`.

#![allow(dead_code, clippy::unwrap_used)]

pub mod invariants;

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_core::canonical::value_to_canonical_json;
use rail_core::phf::PhfHand;
use rail_stats::StatsRow;
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

/// The canonical JSON of a hand's rows: what the oracle hashes.
pub fn rows_canonical(rows: &[StatsRow]) -> String {
    let value = Value::Array(rows.iter().map(StatsRow::to_json).collect());
    value_to_canonical_json(value).expect("rows are canonical JSON")
}

/// One accepted hand of the golden corpus.
pub struct GoldenHand {
    /// The golden's path below `testdata/golden/`.
    pub file: String,
    /// Chunk index (`hands[i].index`).
    pub index: u64,
    pub hand_id: String,
    /// sha-256 of the canonical PHF.
    pub phf_hash: String,
    pub hand: PhfHand,
}

pub struct Corpus {
    /// Every golden file, in order, with its hands.
    pub files: Vec<(String, Vec<GoldenHand>)>,
}

impl Corpus {
    pub fn hands(&self) -> impl Iterator<Item = &GoldenHand> {
        self.files.iter().flat_map(|(_, hands)| hands)
    }

    /// The hands of one corpus input (`gg-hh/....txt`).
    pub fn file(&self, input: &str) -> &[GoldenHand] {
        let name = format!("{input}.json");
        self.files
            .iter()
            .find(|(file, _)| *file == name)
            .map(|(_, hands)| hands.as_slice())
            .unwrap_or_else(|| panic!("no golden for {input}"))
    }
}

/// The golden corpus, loaded once per test binary.
///
/// Fails, rather than skipping, when `testdata/golden-full/` is missing or is
/// not the committed oracle (the same check as rail-core's
/// `golden_roundtrip.rs`).
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
                file: file.clone(),
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
