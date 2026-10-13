//! R1.6: a read with many complete hands is committed as several batches,
//! cut at hand starts, converted in parallel and committed in order, each
//! with its own offsets - and the store ends exactly as a whole-file import
//! of the same bytes leaves it. With batches of two hands every corpus file
//! of more than three hands is split: per (parser, encoding) the file with
//! most hands, as it is and with the other line ends (CRLF <-> LF), so the
//! byte offsets of the cuts are checked through CRLF, BOMs and UTF-16.
//! Then a pause in the middle of a large read: it stops after the batches
//! it is committing and continues from there.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::*;
use rail_core::detect::PINNED_PARSED_AT;
use rail_store::{ImportOptions, Store, import_file};
use rail_watch::{FileReader, FileRef, FileTrack, Polled, ReadConfig};

/// Batches of this many hands: every file with more than this plus one is
/// split.
const BATCH: usize = 2;

fn reader_for(store: &Store) -> FileReader {
    FileReader::new(
        store.path(),
        store.writer().expect("writer"),
        ReadConfig {
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
            batch_hands: BATCH,
            ..ReadConfig::default()
        },
    )
    .expect("reader")
}

/// Read `path` until nothing is left, the clock well past every wait.
/// Returns the reads that committed and the track.
fn read_to_end(reader: &FileReader, path: &Path) -> (u32, FileTrack) {
    let mut track = FileTrack::default();
    let now = T0 + 3_600_000;
    let mut committed = 0;
    for _ in 0..10_000 {
        match reader
            .poll(&FileRef::new(path), &mut track, now)
            .expect("poll")
        {
            Polled::Committed { .. } => committed += 1,
            Polled::Unchanged | Polled::Gone => return (committed, track),
            Polled::Waiting { recheck_at } => {
                assert!(
                    recheck_at.is_none_or(|at| at <= now),
                    "{}: waits until {recheck_at:?}",
                    path.display()
                );
                if recheck_at.is_none() {
                    return (committed, track);
                }
            }
        }
    }
    panic!("{}: never finished", path.display());
}

fn whole(dir: &Path, name: &str, bytes: &[u8]) -> Held {
    let store = Store::open(dir.join(format!("{name}-whole.db"))).expect("open");
    // The same file name: it is in every hand (`meta.originalFilename`).
    let folder = dir.join(format!("{name}-whole"));
    fs::create_dir_all(&folder).expect("folder");
    let path = folder.join("hh.txt");
    fs::write(&path, bytes).expect("write");
    import_file(
        &store,
        &path,
        &ImportOptions {
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
            source_id: None,
        },
    )
    .expect("whole import");
    held(&store)
}

/// The files to split: per (parser, encoding) the one with most hands whose
/// chunks are in the text verbatim (iPoker's are not: read whole, never
/// split), under 300 KB.
fn picks() -> Vec<(Golden, Vec<u8>)> {
    let mut best: BTreeMap<(String, String), (Golden, Vec<u8>)> = BTreeMap::new();
    for golden in all_goldens() {
        if golden.hands <= BATCH + 1 || golden.bytes > 300_000 {
            continue;
        }
        let bytes = fs::read(repo_root().join(&golden.path)).expect("corpus file");
        if hand_starts(&bytes).is_empty() {
            continue;
        }
        let key = (
            golden.top.clone().unwrap_or_default(),
            golden.encoding.clone(),
        );
        if best
            .get(&key)
            .is_none_or(|(known, _)| golden.hands > known.hands)
        {
            best.insert(key, (golden, bytes));
        }
    }
    best.into_values().collect()
}

#[test]
fn a_large_read_is_split_and_ends_as_a_whole_import() {
    let picks = picks();
    assert!(picks.len() >= 15, "only {} files", picks.len());
    let mut encodings = std::collections::BTreeSet::new();
    for (index, (golden, original)) in picks.iter().enumerate() {
        for (variant, bytes) in [
            ("as is", original.clone()),
            ("other line ends", other_line_ends(original)),
        ] {
            let dir = scratch_dir(&format!("split-{index}"));
            let store = Store::open(dir.join("rail.db")).expect("open");
            let path = dir.join("hh.txt");
            fs::write(&path, &bytes).expect("write");
            set_mtime(&path, T0);
            let reader = reader_for(&store);
            let (committed, track) = read_to_end(&reader, &path);
            let label = format!("{} ({variant})", golden.path);
            assert!(track.stats.splits >= 1, "{label}: not split");
            assert!(
                track.stats.commits >= 2,
                "{label}: {} commits",
                track.stats.commits
            );
            assert!(committed >= 1, "{label}");
            let stored = store
                .reader()
                .file_state(&rail_store::import::path_key(&path))
                .expect("state")
                .expect("row");
            assert_eq!(
                u64::try_from(stored.read_offset).ok(),
                Some(u64::try_from(bytes.len()).expect("len")),
                "{label}: read to the end"
            );
            assert_eq!(
                held(&store),
                whole(&dir, "w", &bytes),
                "{label}: differs from a whole-file import"
            );
            drop(reader);
            encodings.insert(golden.encoding.clone());
        }
    }
    assert!(
        encodings.iter().any(|e| e.starts_with("UTF-16")),
        "{encodings:?}"
    );
}

/// Paused in the middle: the first group of batches commits, the read stops
/// and asks to be looked at again; resumed, it continues from the stored
/// offset to the same end.
#[test]
fn a_pause_stops_a_large_read_between_batches() {
    let (golden, bytes) = picks()
        .into_iter()
        .max_by_key(|(golden, _)| golden.hands)
        .expect("a file");
    let dir = scratch_dir("split-pause");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let path = dir.join("hh.txt");
    fs::write(&path, &bytes).expect("write");
    set_mtime(&path, T0);
    let reader = reader_for(&store);
    reader.limits().set_threads(1);
    reader.limits().interrupt(true);
    let mut track = FileTrack::default();
    let now = T0 + 3_600_000;
    let first = reader
        .poll(&FileRef::new(&path), &mut track, now)
        .expect("poll");
    let Polled::Committed {
        outcome,
        from,
        to,
        recheck_at,
    } = first
    else {
        panic!("{}: {first:?}", golden.path);
    };
    assert_eq!(from, 0);
    assert!(to < u64::try_from(bytes.len()).expect("len"));
    assert_eq!(recheck_at, Some(now), "the rest at once");
    assert!(
        usize::try_from(outcome.inserted + outcome.duplicates + outcome.quarantined)
            .expect("small")
            <= BATCH,
        "one batch of at most {BATCH} hands before the pause took effect: {outcome:?}"
    );
    reader.limits().interrupt(false);
    reader.limits().set_threads(0);
    let (_, _) = read_to_end(&reader, &path);
    assert_eq!(held(&store), whole(&dir, "w", &bytes), "{}", golden.path);
}
