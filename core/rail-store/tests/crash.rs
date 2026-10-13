//! The exit check of R1.2 (docs/RAIL-PLAN.md): **a crash mid-import (killed
//! process) leaves the database consistent and the import resumes where it
//! stopped.**
//!
//! The test re-runs its own test binary as a child process (the ignored
//! test [`child_import`], which does nothing unless [`CHILD_DB`] is set).
//! The child imports every corpus file into one store, in order, printing a
//! line after each committed file. It converts six files at a time and
//! sends their batches together (`import_async`), so they wait in the
//! writer's queue together and commit in one grouped transaction, each in
//! its savepoint (R1.6) - a kill then loses the whole group or nothing. The parent kills it - `SIGKILL` on Unix,
//! `TerminateProcess` on Windows (`Child::kill`): no chance to clean up.
//! Two kinds of kill, chosen at random:
//!
//! - **at a random moment**: after a random number of commits plus a random
//!   delay (or before the first commit, possibly during the migration), so
//!   the kill lands anywhere - converting a file, a batch queued, inside the
//!   writer's transaction, between a commit and the line that reports it;
//! - **inside the transaction**: the child applies a whole batch (a file of
//!   at least [`HOLD_MIN_HANDS`] hands: its rows, its new offset, its outbox
//!   entries) inside a writer transaction with the store's own
//!   `writer::apply_import`, reports it, and waits; the parent kills it
//!   there. Nothing of that batch may survive.
//!
//! After every kill the parent opens the database and checks:
//!
//! - `PRAGMA integrity_check` is `ok` and no foreign key dangles;
//! - every file row is read to its end (a whole-file batch moves the offset
//!   from 0 to the size or not at all);
//! - the hands stored are **exactly** the hands of the files whose offset
//!   moved - no hand without its file's offset, no offset without its
//!   hands - and every one of them is in the outbox;
//! - the quarantine and the registry are exactly those files' refusals and
//!   records, each registry count the number of such files;
//! - (R2.3) the seat rows, EV rows and EV queue are exactly those hands'
//!   (as a clean import has them), and the rollups equal the sums of the
//!   seat rows (`player_rollups` and `hero_rollups`, every column).
//!
//! The next child resumes: it skips every file already committed (the skip
//! count it reports equals the stored count) and goes on with the next.
//! Finally a child runs to the end, and the store must equal one clean,
//! uninterrupted import of the corpus (same hands, PHF, files, offsets,
//! quarantine, registry and outbox; no duplicates).
//!
//! `RAIL_STORE_CRASH_SEED` replays a run; `RAIL_STORE_CRASH_KILLS` sets the
//! number of kills (default 12).

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use rail_store::Store;
use rail_store::import::{ImportOptions, is_unchanged, path_key, whole_file_batch};
use rusqlite::Connection;

use common::{PARSED_AT, Rng, Snapshot, assert_integrity, corpus_files, scratch_dir, snapshot};

/// The child's database path; unset, [`child_import`] does nothing.
const CHILD_DB: &str = "RAIL_STORE_CRASH_CHILD_DB";
/// Set: after this many commits, hold the next big batch in an open
/// transaction.
const CHILD_HOLD_AFTER: &str = "RAIL_STORE_CRASH_HOLD_AFTER";
/// A held batch has at least this many hands.
const HOLD_MIN_HANDS: usize = 20;
/// The child converts this many files, then sends their batches at once.
const WINDOW: usize = 6;

const COMMITTED: &str = "RAIL-STORE-COMMITTED";
const SKIPPED: &str = "RAIL-STORE-SKIPPED";
const HOLDING: &str = "RAIL-STORE-HOLDING";
const DONE: &str = "RAIL-STORE-DONE";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").expect("stdout");
    out.flush().expect("flush");
}

/// The child: import the corpus, one line per file.
#[test]
#[ignore = "the child process of crash_mid_import_is_consistent_and_resumes"]
fn child_import() {
    let Some(db) = std::env::var_os(CHILD_DB) else {
        return;
    };
    let hold_after: Option<u64> = std::env::var(CHILD_HOLD_AFTER)
        .ok()
        .and_then(|n| n.parse().ok());
    let store = Store::open(PathBuf::from(db)).expect("open the store");
    let writer = store.writer().expect("writer");
    let mut committed = 0;
    // Converted batches not sent yet: sent together, so they wait in the
    // writer's queue together and commit in one grouped transaction (R1.6).
    let mut window: Vec<(String, rail_store::ImportBatch)> = Vec::new();
    let flush = |window: &mut Vec<(String, rail_store::ImportBatch)>, committed: &mut u64| {
        let pending: Vec<_> = window
            .drain(..)
            .map(|(shown, batch)| (shown, writer.import_async(batch).expect("queue")))
            .collect();
        for (shown, pending) in pending {
            pending.wait().expect("import");
            say(&format!("{COMMITTED} {shown}"));
            *committed += 1;
        }
    };
    for path in corpus_files() {
        let shown = path.display().to_string();
        match hold_after {
            Some(n) if committed + u64::try_from(window.len()).expect("small") >= n => {
                flush(&mut window, &mut committed);
                if is_unchanged(&store, &path).expect("state") {
                    say(&format!("{SKIPPED} {shown}"));
                    continue;
                }
                let batch = whole_file_batch(&path, &options()).expect("batch");
                if batch.hands.len() >= HOLD_MIN_HANDS {
                    hold(&store, batch);
                }
                store.import(batch).expect("import");
                say(&format!("{COMMITTED} {shown}"));
                committed += 1;
            }
            _ => {
                if is_unchanged(&store, &path).expect("state") {
                    say(&format!("{SKIPPED} {shown}"));
                    continue;
                }
                let batch = whole_file_batch(&path, &options()).expect("batch");
                window.push((shown, batch));
                if window.len() >= WINDOW {
                    flush(&mut window, &mut committed);
                }
            }
        }
    }
    flush(&mut window, &mut committed);
    drop(writer);
    store.close();
    say(DONE);
}

/// Apply `batch` inside a writer transaction and wait there to be killed.
fn hold(store: &Store, batch: rail_store::ImportBatch) -> ! {
    let writer = store.writer().expect("writer");
    let _ = writer.write(move |tx| -> rail_store::Result<()> {
        let outcome = rail_store::writer::apply_import(tx, &batch)?;
        say(&format!(
            "{HOLDING} {} ({} hands applied, not committed)",
            batch.file.path, outcome.inserted
        ));
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    unreachable!("the held transaction never returns");
}

/// What one corpus file contributes to a store.
#[derive(Debug, Default)]
struct Expected {
    hands: BTreeSet<String>,
    refusals: BTreeSet<String>,
    unrecognized: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum Kill {
    /// After this many reported commits, plus the delay.
    At(u64, Duration),
    /// Inside the transaction of the first big batch after this many
    /// commits.
    InsideTransaction(u64),
    /// Let it finish.
    Never,
}

/// What a child run reported.
#[derive(Debug, Default)]
struct Run {
    committed: u64,
    skipped: u64,
    held: bool,
    finished: bool,
    log: Vec<String>,
}

fn run_child(db: &Path, kill: Kill) -> Run {
    let exe = std::env::current_exe().expect("test binary");
    let mut command = Command::new(exe);
    command
        .args([
            "child_import",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_DB, db)
        .env_remove(CHILD_HOLD_AFTER)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Kill::InsideTransaction(after) = kill {
        command.env(CHILD_HOLD_AFTER, after.to_string());
    }
    let mut child = command.spawn().expect("spawn the child");
    let stdout = child.stdout.take().expect("child stdout");
    let mut run = Run::default();

    if let Kill::At(0, delay) = kill {
        // Before the first commit: possibly mid-migration.
        std::thread::sleep(delay);
        let _ = child.kill();
    }
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        // libtest writes `test child_import ... ` without a newline before
        // the test's own output: the first tag shares its line.
        let Some(start) = line.find("RAIL-STORE-") else {
            continue;
        };
        let line = line[start..].to_owned();
        let tag = line.split_once(' ').map_or(line.as_str(), |(tag, _)| tag);
        let kill_now = match tag {
            COMMITTED => {
                run.committed += 1;
                matches!(kill, Kill::At(after, _) if after == run.committed)
            }
            SKIPPED => {
                run.skipped += 1;
                false
            }
            HOLDING => {
                run.held = true;
                true
            }
            DONE => {
                run.finished = true;
                false
            }
            _ => false,
        };
        run.log.push(line);
        if kill_now {
            if let Kill::At(_, delay) = kill {
                std::thread::sleep(delay);
            }
            let _ = child.kill();
            break;
        }
    }
    let status = child.wait().expect("wait for the child");
    if matches!(kill, Kill::Never) {
        assert!(
            status.success() && run.finished,
            "the last child failed: {status}"
        );
    }
    run
}

/// The store is exactly the sum of the files whose offset moved. Returns
/// how many files it holds.
fn check_consistent(db: &Path, expected: &BTreeMap<String, Expected>, reference: &Snapshot) -> u64 {
    let conn = Connection::open(db).expect("open after the kill");
    // A kill before the last migration committed leaves an older schema (or
    // none: version 0 is an empty file). Each migration is one transaction and
    // nothing is imported until the store is open, so such a file must be
    // sound and hold no hands; the next child finishes the migration.
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("user_version");
    if version < rail_store::migrate::LATEST {
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity_check");
        assert_eq!(
            integrity, "ok",
            "integrity_check at schema version {version}"
        );
        let has_hands: bool = conn
            .query_row(
                "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'hands'",
                [],
                |row| row.get(0),
            )
            .expect("sqlite_master");
        if has_hands {
            let stored: i64 = conn
                .query_row("SELECT count(*) FROM hands", [], |row| row.get(0))
                .expect("count hands");
            assert_eq!(stored, 0, "hands stored before the schema was complete");
        }
        return 0;
    }
    assert_integrity(&conn);
    let snap = snapshot(&conn);

    let mut hands = BTreeSet::new();
    let mut refusals = BTreeSet::new();
    let mut registry: BTreeMap<String, u64> = BTreeMap::new();
    for (path, fields) in &snap.files {
        // fields: size, read_offset, ...
        assert_eq!(
            fields[0], fields[1],
            "{path}: offset {} of {} - a whole-file batch moves it to the end or not at all",
            fields[1], fields[0]
        );
        let file = expected.get(path).expect("a corpus file");
        hands.extend(file.hands.iter().cloned());
        refusals.extend(file.refusals.iter().map(|fp| (path.clone(), fp.clone())));
        if let Some(fingerprint) = &file.unrecognized {
            *registry.entry(fingerprint.clone()).or_default() += 1;
        }
    }
    let stored: BTreeSet<String> = snap.hands.keys().cloned().collect();
    assert_eq!(
        stored, hands,
        "stored hands are not exactly the committed files' hands"
    );
    assert_eq!(snap.outbox, hands, "every stored hand is in the outbox");
    // R2.3: the statistics went in with their hands - every stored hand's
    // seat rows, EV row or EV queue entry, as a clean import has them, and
    // nothing of a hand that is not stored (the rollups are checked against
    // the rows by `assert_integrity`).
    let stats = &reference.stats;
    assert_eq!(
        snap.stats.seats,
        stats
            .seats
            .iter()
            .filter(|((key, _), _)| hands.contains(key))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        "seat rows are exactly the stored hands' rows"
    );
    assert_eq!(
        snap.stats.ev_rows,
        stats
            .ev_rows
            .iter()
            .filter(|(key, _)| hands.contains(*key))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        "EV rows are exactly the stored hands' rows"
    );
    assert_eq!(
        snap.stats.ev_pending,
        stats
            .ev_pending
            .iter()
            .filter(|key| hands.contains(*key))
            .cloned()
            .collect(),
        "the EV queue holds exactly the stored hands' preflop all-ins"
    );
    assert_eq!(
        snap.quarantine.keys().cloned().collect::<BTreeSet<_>>(),
        refusals
    );
    let counts: BTreeMap<String, u64> = snap
        .unsupported
        .iter()
        .map(|(fingerprint, fields)| {
            // fields[7] is `count`.
            (fingerprint.clone(), fields[7].parse().expect("count"))
        })
        .collect();
    assert_eq!(counts, registry);
    u64::try_from(snap.files.len()).expect("file count")
}

#[test]
fn crash_mid_import_is_consistent_and_resumes() {
    let seed = std::env::var("RAIL_STORE_CRASH_SEED")
        .ok()
        .and_then(|seed| seed.parse().ok())
        .unwrap_or_else(|| u64::try_from(rail_store::time::now_ms()).expect("clock after 1970"));
    let kills: u64 = std::env::var("RAIL_STORE_CRASH_KILLS")
        .ok()
        .and_then(|kills| kills.parse().ok())
        .unwrap_or(12);
    eprintln!("crash test: seed {seed}, {kills} kills (RAIL_STORE_CRASH_SEED replays)");
    let mut rng = Rng::new(seed);
    let dir = scratch_dir("crash");

    // The reference: one clean import, batch by batch, recording what each
    // file contributes.
    let files = corpus_files();
    let clean = Store::open(dir.join("clean.db")).expect("open clean");
    let mut expected = BTreeMap::new();
    for path in &files {
        let batch = whole_file_batch(path, &options()).expect("convert");
        expected.insert(
            path_key(path),
            Expected {
                hands: batch.hands.iter().map(|h| h.hand_key.clone()).collect(),
                refusals: batch
                    .refusals
                    .iter()
                    .map(|r| r.fingerprint.clone())
                    .collect(),
                unrecognized: batch.unrecognized.as_ref().map(|u| u.fingerprint.clone()),
            },
        );
        clean.import(batch).expect("clean import");
    }
    let clean_path = clean.path().to_path_buf();
    clean.close();
    let reference = snapshot(&Connection::open(&clean_path).expect("open clean"));
    assert_eq!(reference.files.len(), files.len());

    // Kill, check, resume.
    let db = dir.join("crashed.db");
    let mut stored_files = 0;
    let (mut at_random, mut inside) = (0, 0);
    for round in 0..kills {
        let kill = match (round, rng.below(6)) {
            // The first kill always before the first commit.
            (0, _) | (_, 0) => Kill::At(0, Duration::from_micros(rng.below(60_000))),
            (_, 1 | 2) => Kill::InsideTransaction(rng.below(20)),
            _ => Kill::At(1 + rng.below(40), Duration::from_micros(rng.below(25_000))),
        };
        let run = run_child(&db, kill);
        let on_disk = if db.exists() {
            check_consistent(&db, &expected, &reference)
        } else {
            0
        };
        // Resumed where it stopped: the files stored before this run (a
        // prefix of the corpus order) are skipped, not read again, and the
        // first file read is the one after them.
        if run.committed > 0 || run.held {
            assert_eq!(
                run.skipped,
                stored_files,
                "round {round}: the child did not resume where it stopped:\n{}",
                run.log.join("\n")
            );
        } else {
            assert!(run.skipped <= stored_files);
        }
        // Every commit the child reported is on disk; more may be (commits
        // between the last line read and the kill), except when the kill
        // came inside a held transaction, which must leave nothing.
        if run.held {
            assert_eq!(
                on_disk,
                stored_files + run.committed,
                "round {round}: the held batch survived the kill"
            );
        } else {
            assert!(
                on_disk >= stored_files + run.committed,
                "round {round}: a commit the child reported is missing"
            );
        }
        stored_files = on_disk;
        if !run.finished {
            match kill {
                Kill::InsideTransaction(_) if run.held => inside += 1,
                _ => at_random += 1,
            }
        }
        eprintln!(
            "round {round}: {kill:?}; reported {} committed, {} skipped{}; {stored_files} files stored",
            run.committed,
            run.skipped,
            if run.held {
                ", killed inside the transaction"
            } else if run.finished {
                ", finished before the kill"
            } else {
                ""
            }
        );
        if run.finished {
            break;
        }
    }
    assert!(at_random + inside > 0, "no kill landed before the end");

    // Run to the end, then compare with the clean import.
    let run = run_child(&db, Kill::Never);
    assert!(run.finished);
    assert_eq!(
        run.skipped, stored_files,
        "the last run resumed where it stopped"
    );
    let conn = Connection::open(&db).expect("open");
    assert_integrity(&conn);
    check_consistent(&db, &expected, &reference);
    let resumed = snapshot(&conn);
    assert_eq!(
        resumed.hands.keys().collect::<Vec<_>>(),
        reference.hands.keys().collect::<Vec<_>>()
    );
    assert!(
        resumed == reference,
        "the resumed store differs from a clean import"
    );
    eprintln!(
        "crash test: {at_random} kills at random moments, {inside} inside a transaction; \
         {} files, {} hands, {} quarantined, {} unsupported - equal to a clean import",
        resumed.files.len(),
        resumed.hands.len(),
        resumed.quarantine.len(),
        resumed.unsupported.len()
    );
}
