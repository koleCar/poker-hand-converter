//! Shared by the store's integration tests: the corpus, scratch
//! directories, a seeded generator, and a snapshot of a store's contents.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use rail_store::batch::decompress_phf;
use rusqlite::Connection;

/// The `meta.parsedAt` every test import stamps, so two imports of the
/// same file store the same PHF.
pub const PARSED_AT: &str = "2026-10-13T00:00:00.000Z";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// Every corpus file the goldens cover (testdata/golden/<path>.json is the
/// golden of <path>), sorted, as absolute paths. 556 files.
pub fn corpus_files() -> Vec<PathBuf> {
    let root = repo_root();
    let golden = root.join("testdata/golden");
    let mut files = Vec::new();
    let mut stack = vec![golden.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("read testdata/golden") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let relative = path
                    .strip_prefix(&golden)
                    .expect("under golden")
                    .with_extension("");
                let input = root.join(relative);
                assert!(input.is_file(), "{} has no input", path.display());
                files.push(input);
            }
        }
    }
    files.sort();
    files
}

/// A corpus file by its path from the repository root.
pub fn corpus_file(relative: &str) -> PathBuf {
    let path = repo_root().join(relative);
    assert!(path.is_file(), "{relative} is not in the corpus");
    path
}

/// A fresh, empty directory under the target directory, unique per call.
pub fn scratch_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("rail-store-{name}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// SplitMix64: a small seeded generator, so a failing run can be replayed
/// from the seed it prints.
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

    /// Uniform-ish in `0..bound` (`bound` > 0).
    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}

/// Everything a store holds that does not depend on when it was written:
/// two stores with equal snapshots hold the same data.
#[derive(Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// hand_key -> every column but `imported_at` / `file_id`, the PHF
    /// decompressed, and the delivering file's path.
    pub hands: BTreeMap<String, Vec<String>>,
    /// path -> size, offset, encoding, site, error.
    pub files: BTreeMap<String, Vec<String>>,
    /// (path, fingerprint) -> stage, reason, message, site, chunk, raw text.
    pub quarantine: BTreeMap<(String, String), Vec<String>>,
    /// fingerprint -> fields and count.
    pub unsupported: BTreeMap<String, Vec<String>>,
    pub outbox: BTreeSet<String>,
}

fn text(row: &rusqlite::Row<'_>, index: usize) -> String {
    use rusqlite::types::ValueRef;
    match row.get_ref(index).expect("column") {
        ValueRef::Null => "NULL".to_owned(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(_) => panic!("no REAL columns in the store"),
        ValueRef::Text(t) => format!("'{}'", String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => format!("blob:{}", b.len()),
    }
}

pub fn snapshot(conn: &Connection) -> Snapshot {
    let mut hands = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT h.hand_key, h.site, h.site_hand_id, h.played_at, h.game_format, h.variant,
                    h.limit_type, h.currency, h.small_blind, h.big_blind, h.ante, h.table_name,
                    h.max_seats, h.hero_seat, h.hero_name, h.schema_version, h.parser_id,
                    h.parser_version, h.phf_size, f.path, h.synced_at, h.phf
             FROM hands h LEFT JOIN files f ON f.id = h.file_id",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        let mut fields: Vec<String> = (1..21).map(|i| text(row, i)).collect();
        let blob: Vec<u8> = row.get(21).expect("phf");
        let size: i64 = row.get(18).expect("phf_size");
        fields.push(decompress_phf(&blob, u64::try_from(size).expect("size")).expect("decompress"));
        hands.insert(row.get(0).expect("key"), fields);
    }

    let mut files = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT path, size, read_offset, encoding, site, last_error, mtime, source_id
             FROM files",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        files.insert(
            row.get(0).expect("path"),
            (1..8).map(|i| text(row, i)).collect(),
        );
    }

    let mut quarantine = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT f.path, q.fingerprint, q.read_offset, q.chunk_index, q.stage, q.reason,
                    q.message, q.detected_site, q.detection_permille, q.parser_version,
                    q.raw_text
             FROM quarantine q JOIN files f ON f.id = q.file_id",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        quarantine.insert(
            (row.get(0).expect("path"), row.get(1).expect("fp")),
            (2..11).map(|i| text(row, i)).collect(),
        );
    }

    let mut unsupported = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT fingerprint, header_sample, guessed_site, confidence, guess_basis, shape,
                    file_path, encoding, count, consented_at, sent_at, anonymiser_version
             FROM unsupported",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        unsupported.insert(
            row.get(0).expect("fp"),
            (1..12).map(|i| text(row, i)).collect(),
        );
    }

    let mut outbox = BTreeSet::new();
    let mut stmt = conn
        .prepare("SELECT hand_key FROM outbox")
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        outbox.insert(row.get(0).expect("key"));
    }

    Snapshot {
        hands,
        files,
        quarantine,
        unsupported,
        outbox,
    }
}

/// `PRAGMA integrity_check` says `ok`, no foreign key is dangling, and the
/// folder rollups of schema version 4 (`files.hands`, `files.quarantined`,
/// `source_totals`) equal what the rows say.
pub fn assert_integrity(conn: &Connection) {
    let integrity: Vec<String> = conn
        .prepare("PRAGMA integrity_check")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(integrity, ["ok"], "integrity_check");
    let dangling: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("foreign_key_check");
    assert_eq!(dangling, 0, "foreign_key_check");
    let files_off: i64 = conn
        .query_row(
            "SELECT count(*) FROM files f
             WHERE f.hands <> (SELECT count(*) FROM hands h WHERE h.file_id = f.id)
                OR f.quarantined <> (SELECT count(*) FROM quarantine q WHERE q.file_id = f.id)",
            [],
            |row| row.get(0),
        )
        .expect("file counters");
    assert_eq!(files_off, 0, "files.hands / files.quarantined");
    let sources_off: i64 = conn
        .query_row(
            "SELECT count(*) FROM sources s LEFT JOIN source_totals t ON t.source_id = s.id
             WHERE t.source_id IS NULL
                OR t.files <> (SELECT count(*) FROM files f WHERE f.source_id = s.id)
                OR t.hands <> (SELECT coalesce(sum(f.hands), 0) FROM files f
                                WHERE f.source_id = s.id)
                OR t.quarantined <> (SELECT coalesce(sum(f.quarantined), 0) FROM files f
                                      WHERE f.source_id = s.id)",
            [],
            |row| row.get(0),
        )
        .expect("folder totals");
    assert_eq!(sources_off, 0, "source_totals");
    let orphans: i64 = conn
        .query_row(
            "SELECT count(*) FROM source_totals t
             WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = t.source_id)",
            [],
            |row| row.get(0),
        )
        .expect("orphan totals");
    assert_eq!(orphans, 0, "source_totals without a folder");
}
