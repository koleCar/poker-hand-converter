//! The exit check of R1.3 (docs/RAIL-PLAN.md): a corpus file appended to a
//! watched file in random chunks - single bytes included, with random small
//! delays - imports exactly the hands of that file, once.
//!
//! For a representative set of corpus files (per parser and encoding, every
//! encoding the corpus has: UTF-8, UTF-8 with BOM, UTF-16 LE, Windows-1252),
//! each as it is and with the other line ends (CRLF <-> LF, same decoded
//! text), the file is written into an empty file from its first byte to its
//! last:
//!
//! - chunk sizes are random: a third of the runs write **one byte at a
//!   time**, the rest mix 1 byte, 2-16, 17-256 and 257-4096;
//! - between two writes the clock moves 0-249 ms (less than the quiet
//!   period: a writer in the middle of a hand), and the reader looks at the
//!   file at random moments;
//! - where a hand ends (the next hand's first byte, from the whole file's
//!   split) the writer stops half the time for longer than the quiet period
//!   (a room between two hands), and the reader looks;
//! - at the end the clock passes the give-up time and the reader looks
//!   twice.
//!
//! Time is the test's own clock (the file's mtime is set to it), so nothing
//! sleeps and a run is replayable from its seed (`RAIL_WATCH_SEED`). Then
//! the store must hold exactly the golden's hands (sha-256 of each canonical
//! PHF), refusals and registry record, the same as a whole-file import of
//! the same bytes, the file read to its last byte; and each hand must have
//! been delivered once (no duplicate deliveries beyond the whole-file
//! import's own, except for a file read whole every time).
//!
//! `RAIL_WATCH_FILES=all` runs every corpus file (a soak; minutes).

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::Instant;

use common::*;
use rail_core::detect::PINNED_PARSED_AT;
use rail_store::{ImportOptions, Store, import_file};
use rail_watch::{FileReader, FileRef, FileTrack, Polled, ReadConfig};

/// Files above this size are left out of the default selection.
const MAX_BYTES: u64 = 40_000;

/// Files that exercise a path no per-parser pick would: a file split into
/// no hands (a file-level refusal).
const EXTRA: &[&str] = &["fixtures/samples/run-it-once/04-tournament-summary-sng.txt"];

/// Per (parser, encoding): the file with the most hands and refusals under
/// [`MAX_BYTES`] (the smallest one when none is that small).
fn selection() -> Vec<Golden> {
    let all = all_goldens();
    if std::env::var("RAIL_WATCH_FILES").as_deref() == Ok("all") {
        return all;
    }
    let mut groups: BTreeMap<(String, String), Vec<Golden>> = BTreeMap::new();
    for golden in &all {
        let top = golden.top.clone().unwrap_or_else(|| "none".to_owned());
        groups
            .entry((top, golden.encoding.clone()))
            .or_default()
            .push(golden.clone());
    }
    let mut picked: Vec<Golden> = groups
        .into_values()
        .filter_map(|group| {
            let small = group.iter().filter(|g| g.bytes <= MAX_BYTES);
            let best = small.max_by_key(|g| (g.hands + g.refusals.len(), u64::MAX - g.bytes));
            best.or_else(|| group.iter().min_by_key(|g| g.bytes))
                .cloned()
        })
        .collect();
    for extra in EXTRA {
        if !picked.iter().any(|g| g.path == *extra) {
            picked.push(golden(extra));
        }
    }
    picked
}

#[derive(Debug, Default)]
struct Run {
    appends: u64,
    polls: u64,
    commits: u64,
    inserted: u64,
    duplicates: u64,
    /// Commits that ended at an odd byte before the end of the file (in a
    /// UTF-16 file: inside a code unit).
    odd_ends: u64,
    track: FileTrack,
}

fn append_randomly(store: &Store, bytes: &[u8], name: &str, seed: u64) -> (Run, u64) {
    let config = ReadConfig {
        parsed_at: Some(PINNED_PARSED_AT.to_owned()),
        ..ReadConfig::default()
    };
    let (quiet, settle, give_up) = (config.quiet_ms, config.settle_ms, config.give_up_ms);
    let reader =
        FileReader::new(store.path(), store.writer().expect("writer"), config).expect("reader");
    let dir = store.path().parent().expect("dir").join("hh");
    fs::create_dir_all(&dir).expect("dir");
    let path = dir.join(name);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .expect("create");

    let mut rng = Rng::new(seed);
    let byte_by_byte = rng.below(3) == 0;
    let chunk = |rng: &mut Rng| -> u64 {
        if byte_by_byte {
            return 1;
        }
        match rng.below(10) {
            0..=3 => 1,
            4..=6 => rng.between(2, 16),
            7..=8 => rng.between(17, 256),
            _ => rng.between(257, 4096),
        }
    };
    let expected_appends = if byte_by_byte {
        bytes.len()
    } else {
        bytes.len() / 200 + 1
    };
    let poll_one_in = u64::try_from(expected_appends / 250).unwrap_or(1).max(1);
    let boundaries = hand_starts(bytes);

    let mut run = Run::default();
    let mut clock = T0;
    let poll = |clock: i64, run: &mut Run| {
        run.polls += 1;
        let polled = reader
            .poll(&FileRef::new(&path), &mut run.track, clock)
            .expect("poll");
        if std::env::var("RAIL_WATCH_DEBUG").is_ok() {
            eprintln!(
                "poll at {} ({} bytes): {polled:?}",
                clock - T0,
                fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            );
        }
        if let Polled::Committed { outcome, to, .. } = polled {
            if to % 2 == 1 && to != u64::try_from(bytes.len()).expect("len") {
                run.odd_ends += 1;
            }
            run.commits += 1;
            run.inserted += u64::from(outcome.inserted);
            run.duplicates += u64::from(outcome.duplicates);
        }
    };
    let mut pos = 0;
    while pos < bytes.len() {
        let next_boundary = boundaries
            .iter()
            .copied()
            .find(|&b| b > pos)
            .unwrap_or(bytes.len());
        let size = usize::try_from(chunk(&mut rng))
            .unwrap_or(1)
            .min(next_boundary - pos);
        file.write_all(&bytes[pos..pos + size]).expect("append");
        file.flush().expect("flush");
        pos += size;
        run.appends += 1;
        clock += i64::try_from(rng.below(u64::try_from(quiet / 2).expect("ms"))).expect("ms");
        set_mtime(&path, clock);
        if rng.below(poll_one_in) == 0 {
            poll(clock, &mut run);
        }
        if pos == next_boundary && rng.below(2) == 0 {
            // A room between two hands: quiet for a while.
            clock +=
                quiet + i64::try_from(rng.below(u64::try_from(settle).expect("ms"))).expect("ms");
            poll(clock, &mut run);
        }
    }
    // The end: the reader looks after the give-up time, and again (as at
    // the recheck time it asks for).
    clock += give_up + 1_000;
    poll(clock, &mut run);
    clock += give_up + 1_000;
    poll(clock, &mut run);
    let stored = store
        .reader()
        .file_state(&rail_store::import::path_key(&path))
        .expect("state")
        .map_or(0, |state| u64::try_from(state.read_offset).expect("offset"));
    (run, stored)
}

fn whole_file_import(bytes: &[u8], name: &str) -> (Held, u64) {
    let dir = scratch_dir("whole");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write");
    let outcome = match import_file(
        &store,
        &path,
        &ImportOptions {
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
            source_id: None,
        },
    )
    .expect("import")
    {
        rail_store::FileImport::Imported(outcome) => outcome,
        rail_store::FileImport::Unchanged => panic!("a new store has nothing"),
    };
    let held = held(&store);
    store.close();
    let _ = fs::remove_dir_all(&dir);
    (held, u64::from(outcome.duplicates))
}

#[test]
fn appending_in_random_chunks_imports_every_hand_once() {
    let mut files = selection();
    if let Ok(only) = std::env::var("RAIL_WATCH_ONLY") {
        files.retain(|g| g.path.contains(&only));
    }
    let base = base_seed();
    let started = Instant::now();
    let mut failures = Vec::new();
    let mut lines = Vec::new();
    let mut seen_encodings = BTreeSet::new();
    let mut seen_parsers = BTreeSet::new();
    for golden in &files {
        let original = fs::read(repo_root().join(&golden.path)).expect("corpus file");
        let variants = [
            ("as is", original.clone()),
            ("line ends", other_line_ends(&original)),
        ];
        for (v, (variant, bytes)) in variants.iter().enumerate() {
            // Per file and variant, independent of the selection.
            let digest = sha256_hex(format!("{}#{v}", golden.path).as_bytes());
            let seed = base ^ u64::from_str_radix(&digest[..16], 16).expect("hex");
            let name = Path::new(&golden.path)
                .file_name()
                .expect("name")
                .to_string_lossy()
                .into_owned();
            let case_started = Instant::now();
            let dir = scratch_dir("append");
            let store = Store::open(dir.join("rail.db")).expect("open");
            let (run, stored_offset) = append_randomly(&store, bytes, &name, seed);
            let got = held(&store);
            let (want, whole_duplicates) = whole_file_import(bytes, &name);

            let label = format!(
                "{} [{variant}, {}{}] seed {seed}",
                golden.path,
                golden.encoding,
                if has_cr(bytes) { ", CRLF" } else { "" }
            );
            let mut problems = Vec::new();
            // The golden's hands, each once: a hand the file holds twice (the
            // same hand id) is stored once, as its first copy.
            let phf: BTreeSet<String> = got.hands.values().cloned().collect();
            let stored_ids: BTreeSet<&String> = phf
                .iter()
                .filter_map(|hash| golden.hand_id.get(hash))
                .collect();
            let all_there = golden
                .hand_id
                .iter()
                .all(|(hash, id)| phf.contains(hash) || stored_ids.contains(id));
            if !phf.is_subset(&golden.phf) || !all_there {
                problems.push(format!(
                    "hands: {} stored, {} golden; {} missing, {} unexpected",
                    phf.len(),
                    golden.phf.len(),
                    golden.phf.difference(&phf).count(),
                    phf.difference(&golden.phf).count()
                ));
            }
            if got.refusals != golden.refusals {
                problems.push(format!(
                    "refusals: {:?} stored, {:?} golden",
                    got.refusals
                        .iter()
                        .map(|r| (&r.2, &r.1))
                        .collect::<Vec<_>>(),
                    golden
                        .refusals
                        .iter()
                        .map(|r| (&r.2, &r.1))
                        .collect::<Vec<_>>()
                ));
            }
            let registry: BTreeSet<String> = golden.unknown_site.iter().cloned().collect();
            if got.unsupported != registry {
                problems.push(format!("registry: {:?} vs {registry:?}", got.unsupported));
            }
            if got != want {
                problems.push("differs from a whole-file import of the same bytes".to_owned());
            }
            if stored_offset != u64::try_from(bytes.len()).expect("len") {
                problems.push(format!("read to {stored_offset} of {} bytes", bytes.len()));
            }
            if run.inserted != u64::try_from(got.hands.len()).expect("len") {
                problems.push(format!(
                    "{} inserted for {} stored",
                    run.inserted,
                    got.hands.len()
                ));
            }
            if golden.encoding.starts_with("UTF-16") && run.odd_ends > 0 {
                problems.push(format!("{} commits ended inside a code unit", run.odd_ends));
            }
            let rereads = run.track.stats.from_zero + run.track.stats.restarts;
            if !run.track.whole_file() && rereads == 0 && run.duplicates != whole_duplicates {
                problems.push(format!(
                    "{} duplicate deliveries, the whole file has {whole_duplicates}",
                    run.duplicates
                ));
            }
            lines.push(format!(
                "{label}: {} bytes, {} appends, {} polls, {} commits, {} hands, {} refusals, \
                 from-zero {}, recoded {}, whole-file {}, {} ms",
                bytes.len(),
                run.appends,
                run.polls,
                run.commits,
                got.hands.len(),
                got.refusals.len(),
                run.track.stats.from_zero,
                run.track.stats.recoded,
                run.track.whole_file(),
                case_started.elapsed().as_millis()
            ));
            if !problems.is_empty() {
                failures.push(format!("{label}: {}", problems.join("; ")));
            }
            seen_encodings.insert(golden.encoding.clone());
            if let Some(top) = &golden.top {
                seen_parsers.insert(top.clone());
            }
            store.close();
            let _ = fs::remove_dir_all(&dir);
        }
    }
    println!("{}", lines.join("\n"));
    println!(
        "{} files x 2 variants, {} parsers, encodings {:?}, {:.1} s",
        files.len(),
        seen_parsers.len(),
        seen_encodings,
        started.elapsed().as_secs_f64()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    if std::env::var("RAIL_WATCH_ONLY").is_ok() {
        return;
    }
    // Representative: every parser and every encoding of the corpus.
    let parsers = rail_core::parsers::builtin().parsers().count();
    assert_eq!(seen_parsers.len(), parsers, "{seen_parsers:?}");
    for encoding in ["UTF-8", "UTF-8 (BOM)", "UTF-16 LE", "Windows-1252"] {
        assert!(seen_encodings.contains(encoding), "{encoding} not covered");
    }
}
