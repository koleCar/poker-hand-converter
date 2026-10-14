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

/* ------------------------------------------------- a recompute (R2.11) - */

/// The recompute child's database path; unset, [`child_recompute`] does
/// nothing.
const CHILD_RECOMPUTE_DB: &str = "RAIL_STORE_CRASH_RECOMPUTE_DB";
/// Set: hold the next swap (the rows job's, else the EV job's) in an open
/// transaction.
const CHILD_HOLD_SWAP: &str = "RAIL_STORE_CRASH_HOLD_SWAP";

const STEP: &str = "RAIL-STORE-STEP";

/// The child of [`crash_mid_recompute_is_consistent_and_resumes`]: open the
/// store (which begins its recompute, or finds it begun) and run the
/// recompute's steps to the end, one line per step.
#[test]
#[ignore = "the child process of crash_mid_recompute_is_consistent_and_resumes"]
fn child_recompute() {
    use rail_store::recompute;
    let Some(db) = std::env::var_os(CHILD_RECOMPUTE_DB) else {
        return;
    };
    let hold = std::env::var_os(CHILD_HOLD_SWAP).is_some();
    let store = Store::open(PathBuf::from(db)).expect("open the store");
    let writer = store.writer().expect("writer");
    let reader = store.reader();
    loop {
        if hold {
            if let Some(page) = recompute::rows_page(reader, &writer).expect("page") {
                if page.hands() == 0 {
                    hold_swap(&writer, |tx| recompute::finish_rows(tx));
                }
                let n = page.hands();
                writer
                    .write(move |tx| recompute::apply_rows_page(tx, page))
                    .expect("apply");
                say(&format!("{STEP} rows {n}"));
                continue;
            }
            if let Some(page) = recompute::ev_page(reader).expect("page") {
                if page.hands() == 0 {
                    hold_swap(&writer, |tx| recompute::finish_ev(tx));
                }
                let n = page.hands();
                writer
                    .write(move |tx| recompute::apply_ev_page(tx, &page))
                    .expect("apply");
                say(&format!("{STEP} ev {n}"));
                continue;
            }
        }
        if let Some(n) = recompute::rows_step(reader, &writer).expect("rows step") {
            say(&format!("{STEP} rows {n}"));
            continue;
        }
        if let Some((n, _)) = recompute::ev_step(reader, &writer).expect("ev step") {
            say(&format!("{STEP} ev {n}"));
            continue;
        }
        break;
    }
    drop(writer);
    store.close();
    say(DONE);
}

/// Run a swap inside a writer transaction and wait there to be killed.
fn hold_swap(
    writer: &rail_store::WriterHandle,
    swap: impl FnOnce(&rusqlite::Transaction<'_>) -> rail_store::Result<bool> + Send + 'static,
) -> ! {
    let _ = writer.write(move |tx| -> rail_store::Result<()> {
        let swapped = swap(tx)?;
        say(&format!("{HOLDING} the swap ({swapped}), not committed"));
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    unreachable!("the held transaction never returns");
}

#[derive(Debug, Clone, Copy)]
enum RecomputeKill {
    /// After this many reported steps, plus the delay.
    At(u64, Duration),
    /// Inside the next swap's transaction.
    InsideSwap,
    /// Let it finish.
    Never,
}

fn run_recompute_child(db: &Path, kill: RecomputeKill) -> Run {
    let exe = std::env::current_exe().expect("test binary");
    let mut command = Command::new(exe);
    command
        .args([
            "child_recompute",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_RECOMPUTE_DB, db)
        .env_remove(CHILD_HOLD_SWAP)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let RecomputeKill::InsideSwap = kill {
        command.env(CHILD_HOLD_SWAP, "1");
    }
    let mut child = command.spawn().expect("spawn the child");
    let stdout = child.stdout.take().expect("child stdout");
    let mut run = Run::default();
    if let RecomputeKill::At(0, delay) = kill {
        std::thread::sleep(delay);
        let _ = child.kill();
    }
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Some(start) = line.find("RAIL-STORE-") else {
            continue;
        };
        let line = line[start..].to_owned();
        let tag = line.split_once(' ').map_or(line.as_str(), |(tag, _)| tag);
        let kill_now = match tag {
            STEP => {
                run.committed += 1;
                matches!(kill, RecomputeKill::At(after, _) if after == run.committed)
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
            if let RecomputeKill::At(_, delay) = kill {
                std::thread::sleep(delay);
            }
            let _ = child.kill();
            break;
        }
    }
    let status = child.wait().expect("wait for the child");
    if matches!(kill, RecomputeKill::Never) {
        assert!(
            status.success() && run.finished,
            "the last child failed: {status}"
        );
    }
    run
}

/// The statistics a screen reads, without the EV: the seat rows, the
/// rollups, the list, the Players list's lines.
fn rows_part(stats: &common::StatsSnapshot) -> String {
    format!(
        "{:?}",
        (
            &stats.seats,
            &stats.players,
            &stats.heroes,
            &stats.list,
            &stats.summary,
            &stats.hidden
        )
    )
}

fn ev_part(stats: &common::StatsSnapshot) -> String {
    format!("{:?}", (&stats.ev_rows, &stats.ev_pending))
}

/// How far each job is: (rows done, EV done) - 0 before it began,
/// `u64::MAX` once swapped.
fn progress(conn: &Connection) -> (u64, u64) {
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .ok()
    };
    let job = |running: &str, done: &str, version: &str, current: &str| {
        if get(running).is_some() {
            get(done).map_or(0, |n| n.parse().expect("a count"))
        } else if get(version).as_deref() == Some(current) {
            u64::MAX
        } else {
            0
        }
    };
    (
        job(
            "recompute.rows.job",
            "recompute.rows.done",
            "stats.version",
            rail_stats::STATS_VERSION,
        ),
        job(
            "recompute.ev.target",
            "recompute.ev.done",
            "ev.version",
            rail_equity::EV_VERSION,
        ),
    )
}

/// R2.11's crash check: **a recompute killed at any moment - between its
/// pages, inside a page's transaction, inside the swap's - leaves the store
/// consistent and showing either the old statistics or the new ones, and
/// the next start goes on where it stopped.**
///
/// The store is a clean import of the corpus whose rows an "older engine"
/// made (`common::older`: a counter, the money, the segments, the all-in
/// EV changed by hand, the rollups rewritten from the rows), so opening it
/// begins the rows job and the EV job. A child process runs them and is
/// killed (`SIGKILL` / `TerminateProcess`) after a random number of steps
/// plus a random delay, or inside a swap it holds open; after every kill:
///
/// - `PRAGMA integrity_check`, foreign keys, the rollups equal the sums of
///   the seat rows, the list its rows (`assert_integrity`);
/// - what the screens read is the old statistics or the clean import's,
///   whole: the rows (seat rows, rollups, list, summary) one or the other,
///   the EV rows one or the other, and never new EV over old rows (the rows
///   job swaps first);
/// - each job's progress never goes back: the next child resumes it.
///
/// Then a child runs to the end, and the store equals the clean import.
/// `RAIL_STORE_CRASH_SEED` replays a run; `RAIL_STORE_CRASH_KILLS` sets the
/// number of kills (default 12).
#[test]
fn crash_mid_recompute_is_consistent_and_resumes() {
    let seed = std::env::var("RAIL_STORE_CRASH_SEED")
        .ok()
        .and_then(|seed| seed.parse().ok())
        .unwrap_or_else(|| u64::try_from(rail_store::time::now_ms()).expect("clock after 1970"));
    let kills: u64 = std::env::var("RAIL_STORE_CRASH_KILLS")
        .ok()
        .and_then(|kills| kills.parse().ok())
        .unwrap_or(12);
    eprintln!("recompute crash test: seed {seed}, {kills} kills (RAIL_STORE_CRASH_SEED replays)");
    let mut rng = Rng::new(seed);
    let dir = scratch_dir("crash-recompute");

    // The reference: one clean import.
    let clean = Store::open(dir.join("clean.db")).expect("open clean");
    for path in corpus_files() {
        clean
            .import(whole_file_batch(&path, &options()).expect("convert"))
            .expect("import");
    }
    let clean_path = clean.path().to_path_buf();
    clean.close();
    let reference = snapshot(&Connection::open(&clean_path).expect("open clean"));

    // The same store as an older engine left it.
    let db = dir.join("recompute.db");
    std::fs::copy(&clean_path, &db).expect("copy");
    let old = {
        let conn = Connection::open(&db).expect("open");
        let mut tamper = Rng::new(seed ^ 0x5eed);
        common::older::counters(&conn, &mut tamper, 100);
        common::older::money(&conn, &mut tamper, 100);
        common::older::segments(&conn, &mut tamper, 100);
        common::older::ev(&conn);
        common::write_rollups(&conn);
        common::older::stats_version(&conn);
        assert_integrity(&conn);
        snapshot(&conn)
    };
    let (old_rows, old_ev) = (rows_part(&old.stats), ev_part(&old.stats));
    let (new_rows, new_ev) = (rows_part(&reference.stats), ev_part(&reference.stats));
    assert!(old_rows != new_rows && old_ev != new_ev);

    let mut last = (0, 0);
    let (mut killed, mut inside) = (0, 0);
    let mut ev_swap_held = false;
    for round in 0..kills {
        // The first kill before the first step; the second inside the rows
        // job's swap; the first after the rows swapped inside the EV job's.
        let kill = if round == 0 {
            RecomputeKill::At(0, Duration::from_millis(rng.below(400)))
        } else if round == 1 || (last.0 == u64::MAX && last.1 != u64::MAX && !ev_swap_held) {
            ev_swap_held = last.0 == u64::MAX;
            RecomputeKill::InsideSwap
        } else if rng.below(5) == 0 {
            RecomputeKill::InsideSwap
        } else {
            RecomputeKill::At(1 + rng.below(6), Duration::from_millis(rng.below(300)))
        };
        let run = run_recompute_child(&db, kill);
        let conn = Connection::open(&db).expect("open after the kill");
        assert_integrity(&conn);
        let now = snapshot(&conn);
        let (rows, ev) = (rows_part(&now.stats), ev_part(&now.stats));
        let rows_new = if rows == new_rows {
            true
        } else {
            assert!(rows == old_rows, "round {round}: rows neither old nor new");
            false
        };
        let ev_new = if ev == new_ev {
            true
        } else {
            assert!(ev == old_ev, "round {round}: EV neither old nor new");
            false
        };
        assert!(rows_new || !ev_new, "round {round}: new EV over old rows");
        assert!(
            now.hands == reference.hands && now.files == reference.files,
            "round {round}: the hands changed"
        );
        let at = progress(&conn);
        assert!(
            at.0 >= last.0 && at.1 >= last.1,
            "round {round}: a job went back from {last:?} to {at:?} - it did not resume:\n{}",
            run.log.join("\n")
        );
        last = at;
        if !run.finished {
            if run.held {
                inside += 1;
            } else {
                killed += 1;
            }
        }
        eprintln!(
            "round {round}: {kill:?}; {} steps{}; progress {at:?}, rows {}, EV {}",
            run.committed,
            if run.held {
                ", killed inside the swap"
            } else if run.finished {
                ", finished before the kill"
            } else {
                ""
            },
            if rows_new { "new" } else { "old" },
            if ev_new { "new" } else { "old" },
        );
        if run.finished {
            break;
        }
    }
    assert!(killed + inside > 0, "no kill landed before the end");

    let run = run_recompute_child(&db, RecomputeKill::Never);
    assert!(run.finished);
    let conn = Connection::open(&db).expect("open");
    assert_integrity(&conn);
    let finished = snapshot(&conn);
    assert!(
        finished == reference,
        "the recomputed store differs from a clean import"
    );
    eprintln!(
        "recompute crash test: {killed} kills between or inside pages, {inside} inside a swap; \
         {} hands - equal to a clean import",
        finished.hands.len()
    );
}
