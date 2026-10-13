//! Shared by the watcher's tests: the corpus and its goldens, encoders for
//! the line-end variants, a seeded generator, a manual clock for the
//! reader, and what a store holds.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rail_core::decode::{Encoding, decode_source, decode_windows_1252};
use rail_store::Store;
use rail_watch::codec::{self, Decision};
use rail_watch::reader::locate;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// A fresh, empty directory under the target directory, unique per call.
pub fn scratch_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("rail-watch-{name}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// SplitMix64, so a failing run can be replayed from the seed it prints.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// In `0..bound` (`bound` > 0).
    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }

    /// In `low..=high`.
    pub fn between(&mut self, low: u64, high: u64) -> u64 {
        low + self.below(high - low + 1)
    }
}

/// The base seed: `RAIL_WATCH_SEED`, or a fixed one.
pub fn base_seed() -> u64 {
    std::env::var("RAIL_WATCH_SEED")
        .ok()
        .and_then(|seed| seed.parse().ok())
        .unwrap_or(0x5EED_1203)
}

/// A corpus file's golden (`testdata/golden/<path>.json`).
#[derive(Debug, Clone)]
pub struct Golden {
    pub path: String,
    pub encoding: String,
    pub top: Option<String>,
    pub hands: usize,
    /// sha-256 of each hand's canonical PHF (parsedAt pinned).
    pub phf: BTreeSet<String>,
    /// The hand id of each PHF hash.
    pub hand_id: BTreeMap<String, String>,
    /// (fingerprint, stage, reason, message, site, parser version) of each
    /// chunk refusal.
    pub refusals: BTreeSet<(String, String, String, String, Option<String>, String)>,
    /// The fingerprint of a file-level `unknown-site` refusal (the
    /// registry's).
    pub unknown_site: Option<String>,
    pub bytes: u64,
}

pub fn golden(relative: &str) -> Golden {
    let root = repo_root();
    let text = fs::read_to_string(
        root.join("testdata/golden")
            .join(format!("{relative}.json")),
    )
    .expect("golden");
    let doc: Value = serde_json::from_str(&text).expect("golden json");
    let str_of = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let hands = doc["hands"].as_array().cloned().unwrap_or_default();
    let mut refusals = BTreeSet::new();
    let mut unknown_site = None;
    for refusal in doc["refusals"].as_array().cloned().unwrap_or_default() {
        if refusal["index"].is_null() && refusal["reason"] == "unknown-site" {
            unknown_site = Some(str_of(&refusal["fingerprint"]));
            continue;
        }
        refusals.insert((
            str_of(&refusal["fingerprint"]),
            str_of(&refusal["stage"]),
            str_of(&refusal["reason"]),
            str_of(&refusal["message"]),
            refusal["site"].as_str().map(str::to_owned),
            str_of(&refusal["parserVersion"]),
        ));
    }
    Golden {
        path: relative.to_owned(),
        encoding: str_of(&doc["decode"]["encoding"]),
        top: doc["detected"]["top"].as_str().map(str::to_owned),
        hands: hands.len(),
        phf: hands.iter().map(|hand| str_of(&hand["phf"])).collect(),
        hand_id: hands
            .iter()
            .map(|hand| (str_of(&hand["phf"]), str_of(&hand["handId"])))
            .collect(),
        refusals,
        unknown_site,
        bytes: doc["input"]["bytes"].as_u64().unwrap_or_default(),
    }
}

/// Every golden, by its path from the repository root.
pub fn all_goldens() -> Vec<Golden> {
    let root = repo_root().join("testdata/golden");
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("read golden dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let relative = path
                    .strip_prefix(&root)
                    .expect("under golden")
                    .with_extension("")
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(golden(&relative));
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Text in an encoding, BOM included where the encoding has one.
pub fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    match encoding {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf8Bom => [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat(),
        Encoding::Utf16Le | Encoding::Utf16LeNoBom => {
            let mut out = if encoding == Encoding::Utf16Le {
                vec![0xff, 0xfe]
            } else {
                Vec::new()
            };
            for unit in text.encode_utf16() {
                out.extend(unit.to_le_bytes());
            }
            out
        }
        Encoding::Utf16Be | Encoding::Utf16BeNoBom => {
            let mut out = if encoding == Encoding::Utf16Be {
                vec![0xfe, 0xff]
            } else {
                Vec::new()
            };
            for unit in text.encode_utf16() {
                out.extend(unit.to_be_bytes());
            }
            out
        }
        Encoding::Windows1252 => {
            let all: Vec<u8> = (0..=255).collect();
            let table: HashMap<char, u8> = decode_windows_1252(&all).chars().zip(all).collect();
            text.chars()
                .map(|ch| *table.get(&ch).expect("a Windows-1252 character"))
                .collect()
        }
    }
}

/// The corpus file's bytes with the other line ends: CRLF when it has
/// none, LF when it has some. Same decoded text, so the same golden.
pub fn other_line_ends(bytes: &[u8]) -> Vec<u8> {
    let decoded = decode_source(bytes);
    let has_cr = decoded_has_cr(bytes, decoded.encoding);
    let text = if has_cr {
        decoded.text.clone()
    } else {
        decoded.text.replace('\n', "\r\n")
    };
    let out = encode(&text, decoded.encoding);
    let again = decode_source(&out);
    assert_eq!(
        (again.encoding, again.text.as_str()),
        (decoded.encoding, decoded.text.as_str()),
        "the variant decodes as the original"
    );
    out
}

fn decoded_has_cr(bytes: &[u8], encoding: Encoding) -> bool {
    match encoding {
        Encoding::Utf16Le | Encoding::Utf16LeNoBom => bytes.windows(2).any(|w| w == [b'\r', 0]),
        Encoding::Utf16Be | Encoding::Utf16BeNoBom => bytes.windows(2).any(|w| w == [0, b'\r']),
        _ => bytes.contains(&b'\r'),
    }
}

/// Whether the bytes use CR line ends anywhere.
pub fn has_cr(bytes: &[u8]) -> bool {
    decoded_has_cr(bytes, decode_source(bytes).encoding)
}

/// A clock the test moves. Not on a whole second: the reader trusts a
/// millisecond mtime, and one on a whole second looks coarse (FAT, HFS+).
pub const T0: i64 = 1_800_000_000_123;

/// Set a file's mtime (the reader's quiet period counts from it).
pub fn set_mtime(path: &Path, ms: i64) {
    let time = UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).expect("positive"));
    let file = fs::File::options().write(true).open(path).expect("open");
    file.set_modified(time).expect("set mtime");
}

pub fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("after 1970")
            .as_millis(),
    )
    .expect("ms")
}

/// What a store holds, for comparisons.
#[derive(Debug, PartialEq, Eq)]
pub struct Held {
    /// hand_key -> sha-256 of the canonical PHF.
    pub hands: BTreeMap<String, String>,
    pub refusals: BTreeSet<(String, String, String, String, Option<String>, String)>,
    pub unsupported: BTreeSet<String>,
    pub outbox: usize,
}

pub fn held(store: &Store) -> Held {
    let reader = store.reader();
    let mut hands = BTreeMap::new();
    for item in reader.outbox_due(i64::MAX, u32::MAX).expect("outbox") {
        hands.insert(item.hand_key, sha256_hex(item.phf.as_bytes()));
    }
    let outbox = hands.len();
    let refusals = reader
        .quarantine(u32::MAX)
        .expect("quarantine")
        .into_iter()
        .map(|entry| {
            (
                entry.fingerprint,
                entry.stage,
                entry.reason,
                entry.message,
                entry.detected_site,
                entry.parser_version,
            )
        })
        .collect();
    let unsupported = reader
        .unsupported()
        .expect("unsupported")
        .into_iter()
        .map(|entry| entry.fingerprint)
        .collect();
    let status = store.status().expect("status");
    assert_eq!(
        usize::try_from(status.hands).ok(),
        Some(outbox),
        "every stored hand is in the outbox"
    );
    Held {
        hands,
        refusals,
        unsupported,
        outbox,
    }
}

/// Wait until `check` holds, or fail after `seconds`.
pub fn wait_for(what: &str, seconds: u64, mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(check(), "timed out waiting for {what}");
}

/// Where each hand after the first starts, in bytes, from the whole file's
/// split (empty when the parser's chunks are not in the text verbatim).
pub fn hand_starts(bytes: &[u8]) -> Vec<usize> {
    let Decision::Text(codec) = codec::decide(bytes) else {
        return Vec::new();
    };
    let Ok(piece) = codec::decode_piece(codec, bytes, true, false) else {
        return Vec::new();
    };
    let registry = rail_core::parsers::builtin();
    let Some(primary) = registry.detect_site(&piece.text).first().copied() else {
        return Vec::new();
    };
    let chunks = primary.parser.split_hands(&piece.text).unwrap_or_default();
    let Some(starts) = locate(&piece.text, &chunks) else {
        return Vec::new();
    };
    starts
        .into_iter()
        .skip(1)
        .filter_map(|position| codec::byte_offset_of(codec, bytes, true, position).ok())
        .collect()
}
