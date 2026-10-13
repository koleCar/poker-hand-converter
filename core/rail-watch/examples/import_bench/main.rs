//! The import benchmark (docs/RAIL-PLAN.md R1.6; guideline §1: local import
//! of old hands at >= 5 000 hands/s).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     [--hands 100000] [--workers N] [--runs 1] [--min-rate 5000] \
//!     [--min-efficiency PERCENT] [--keep] [--dir PATH]
//! ```
//!
//! 1. Builds a **generated** dataset of about `--hands` hands in a temporary
//!    directory: copies of the repository's corpus with rewritten hand ids
//!    (`dataset.rs`; labelled `GENERATED.md`, removed afterwards unless
//!    `--keep`; never under `testdata/` or a fixture tree).
//! 2. Measures a **reference rate on this machine**: one thread converts the
//!    corpus templates (copy 0 of the dataset, ~7 300 hands held in memory:
//!    no file reads, no store, no watcher) with the reader's options, hands
//!    per second. It is `rail_core` alone, the CPU work an import thread
//!    does per hand before the store, so it moves with the machine's speed
//!    (a shared CI runner's included) and not with the pipeline. It is
//!    measured again after every import. Printed beside it, not part of
//!    it: what the statistics (R2.3, `PreparedStats::from_phf`) add to an
//!    import thread's work per hand.
//! 3. Opens an **empty** store, starts the real watcher (`Watcher::start`,
//!    the app's pipeline: walk, workers, conversion, the one writer) and adds
//!    the dataset's folder with "import everything" - the backfill a user
//!    gets when they confirm a folder of old hand histories.
//! 4. Times it until every file is committed to its end, then reports hands
//!    stored per second, the folder's progress as `status()` showed it, the
//!    cost of `Watcher::status()` and of the store's counts at that size, and
//!    the database's size, and the run's **pipeline efficiency**: hands
//!    stored per second / (reference hands per second x import threads),
//!    in percent - how much of the threads' conversion speed the whole
//!    import (reading, the writer, the watcher) keeps.
//!
//! With `--runs N` steps 3-4 are repeated (each import into a fresh store);
//! a run's reference is the mean of the passes just before and just after
//! its import, so a runner that slows down mid-job slows both sides of the
//! ratio, and the best run counts. Exits with status 1 when
//! the best efficiency is below `--min-efficiency` (CI's gate: a regression
//! in the pipeline, whatever the runner's speed) or the best hands stored
//! per second fall below `--min-rate` (an absolute floor). The efficiency
//! does not see a slowdown of `rail_core` itself (it slows the reference
//! too); the reference rate is printed for that. `--workers` defaults to
//! the app's default (`WatchConfig::default()`).

mod dataset;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rail_core::convert::convert_file;
use rail_store::Store;
use rail_watch::{WatchConfig, WatchEvent, Watcher};

#[derive(Debug)]
struct Args {
    hands: u64,
    workers: Option<usize>,
    min_rate: Option<u64>,
    /// Percent.
    min_efficiency: Option<u64>,
    keep: bool,
    dir: Option<PathBuf>,
    runs: usize,
}

fn args() -> Args {
    let mut args = Args {
        hands: 100_000,
        workers: None,
        min_rate: None,
        min_efficiency: None,
        keep: false,
        dir: None,
        runs: 1,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().unwrap_or_else(|| panic!("{arg} needs a value"));
        match arg.as_str() {
            "--hands" => args.hands = value().parse().expect("--hands"),
            "--workers" => args.workers = Some(value().parse().expect("--workers")),
            "--min-rate" => args.min_rate = Some(value().parse().expect("--min-rate")),
            "--min-efficiency" => {
                args.min_efficiency = Some(value().parse().expect("--min-efficiency"));
            }
            "--dir" => args.dir = Some(PathBuf::from(value())),
            "--runs" => args.runs = value().parse().expect("--runs"),
            "--keep" => args.keep = true,
            other => panic!("unknown argument {other}"),
        }
    }
    args
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}

fn remove_store(db: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = db.as_os_str().to_owned();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

/// Median of `runs` timings of `f`, in microseconds.
fn time_us(runs: usize, mut f: impl FnMut()) -> u128 {
    let mut times: Vec<u128> = (0..runs)
        .map(|_| {
            let started = Instant::now();
            f();
            started.elapsed().as_micros()
        })
        .collect();
    times.sort_unstable();
    times[times.len() / 2]
}

fn main() {
    let args = args();
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let base = args
        .dir
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join("rail-import-bench"));
    let data_dir = base.join("generated-hands");
    let db = base.join("bench-store").join(rail_store::FILE_NAME);

    // 1. The dataset. Spotlight is asked not to index it (macOS).
    std::fs::create_dir_all(&base).expect("bench dir");
    let _ = std::fs::write(base.join(".metadata_never_index"), b"");
    let started = Instant::now();
    let selection = dataset::templates(&root, cores);
    let per_copy: usize = selection.templates.iter().map(|t| t.hands).sum();
    let copies = usize::try_from(
        args.hands
            .div_ceil(u64::try_from(per_copy.max(1)).expect("n")),
    )
    .expect("copies")
    .max(1);
    let data = dataset::write(&data_dir, &selection, copies, cores);
    println!(
        "dataset (GENERATED, {}): {} of {} corpus files replicated ({} without hands, {} whose \
         ids could not be rewritten, {} repeating another file's hands), {} parsers; {} copies \
         -> {} files, {:.1} MiB, {} hands; built in {:.1} s",
        data.dir.display(),
        selection.templates.len(),
        selection.corpus_files,
        selection.no_hands,
        selection.not_rewritable,
        selection.repeats,
        selection.parsers.len(),
        data.copies,
        data.files.len(),
        mib(data.bytes),
        data.hands,
        started.elapsed().as_secs_f64()
    );

    // 2.-4. A reference, then each run: an import into an empty store and
    // a reference after it. A run's reference is the mean of the two around
    // it (a reference pass is ~3 s, the import ~10x that, and a shared
    // runner's speed moves within seconds); the gates take the best run.
    let workers = args.workers.unwrap_or(WatchConfig::default().workers);
    let (mut best_rate, mut best_reference, mut best_efficiency) = (0, 0, 0);
    let mut before = reference_rate(&selection);
    stats_cost(&selection);
    best_reference = best_reference.max(before);
    for run in 1..=args.runs.max(1) {
        if args.runs > 1 {
            println!("run {run} of {}:", args.runs);
        }
        let rate = import_once(&data, &db, workers, cores);
        let after = reference_rate(&selection);
        let reference = before.midpoint(after);
        let efficiency = efficiency_percent(rate, reference, workers);
        println!(
            "efficiency: {rate} hands stored/s / ({reference} hands/s, the mean of {before} \
             before and {after} after, x {workers} threads) = {efficiency} %"
        );
        println!(
            "RUN rate={rate} reference={reference} reference_before={before} \
             reference_after={after} workers={workers} efficiency_pct={efficiency}"
        );
        before = after;
        best_reference = best_reference.max(after);
        best_rate = best_rate.max(rate);
        best_efficiency = best_efficiency.max(efficiency);
    }
    if !args.keep {
        let _ = std::fs::remove_dir_all(&base);
    }
    println!(
        "best of {}: import {best_rate} hands stored/s, reference {best_reference} hands/s on 1 \
         thread, efficiency {best_efficiency} % ({workers} threads)",
        args.runs.max(1)
    );
    let mut failed = false;
    if let Some(min) = args.min_efficiency {
        if best_efficiency < min {
            eprintln!("FAIL: pipeline efficiency {best_efficiency} % is below the gate of {min} %");
            failed = true;
        } else {
            println!("PASS: pipeline efficiency {best_efficiency} %, the gate is {min} %");
        }
    }
    if let Some(min) = args.min_rate {
        if best_rate < min {
            eprintln!("FAIL: {best_rate} hands/s is below the floor of {min} hands/s");
            failed = true;
        } else {
            println!("PASS: {best_rate} hands/s, the floor is {min} hands/s");
        }
    }
    if failed {
        std::process::exit(1);
    }
}

/// Hands per second one thread converts: every template (copy 0 of the
/// dataset) from memory with the reader's options, no store, no watcher.
fn reference_rate(selection: &dataset::Selection) -> u64 {
    let started = Instant::now();
    let mut hands = 0_u64;
    for template in &selection.templates {
        let conversion = convert_file(&template.bytes, &dataset::options(&template.relative));
        if let Some(Ok(result)) = conversion.result.as_ref() {
            hands += u64::try_from(result.hands.len()).expect("hands");
        }
    }
    let elapsed = started.elapsed();
    let rate =
        u64::try_from(u128::from(hands) * 1000 / elapsed.as_millis().max(1)).unwrap_or(u64::MAX);
    println!(
        "reference: 1 thread converts {hands} hands ({} corpus files, in memory, no store) in \
         {:.2} s -> {rate} hands/s",
        selection.templates.len(),
        elapsed.as_secs_f64()
    );
    rate
}

/// What the statistics (R2.3) add to an import thread's work per hand:
/// `PreparedStats::from_phf` (the kept rows, the segment, the scopes, the EV
/// row unless the all-in was preflop) over the templates' hands, against
/// their conversion. Printed only; the reference above stays `rail_core`.
fn stats_cost(selection: &dataset::Selection) {
    let mut hands = Vec::new();
    let started = Instant::now();
    for template in &selection.templates {
        let conversion = convert_file(&template.bytes, &dataset::options(&template.relative));
        if let Some(Ok(result)) = conversion.result {
            hands.extend(result.hands.into_iter().map(|converted| converted.hand));
        }
    }
    let convert = started.elapsed();
    let started = Instant::now();
    let mut deferred = 0_u64;
    for hand in &hands {
        if rail_store::PreparedStats::from_phf(hand).ev == rail_store::EvPlan::Deferred {
            deferred += 1;
        }
    }
    let stats = started.elapsed();
    let n = u128::try_from(hands.len().max(1)).expect("hands");
    println!(
        "statistics: {} us a hand ({} hands; their conversion {} us a hand, so +{} %); \
         {deferred} preflop all-ins left to the background pass",
        stats.as_micros() / n,
        hands.len(),
        convert.as_micros() / n,
        stats.as_micros() * 100 / convert.as_micros().max(1)
    );
}

/// `rate / (reference x workers)`, in percent.
fn efficiency_percent(rate: u64, reference: u64, workers: usize) -> u64 {
    let ideal = u128::from(reference) * u128::try_from(workers.max(1)).expect("workers");
    u64::try_from(u128::from(rate) * 100 / ideal.max(1)).unwrap_or(u64::MAX)
}

/// One import of the dataset into an empty store; returns hands stored/s.
fn import_once(data: &dataset::Dataset, db: &Path, workers: usize, cores: usize) -> u64 {
    remove_store(db);
    let store = Store::open(db).expect("store");
    let config = WatchConfig {
        workers,
        ..WatchConfig::default()
    };
    // Per file (relative to the dataset), how far it is committed.
    let committed: Arc<Mutex<HashMap<PathBuf, u64>>> = Arc::default();
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let root_dir = data.dir.clone();
    let watcher = {
        let (committed, errors) = (Arc::clone(&committed), Arc::clone(&errors));
        Watcher::start(
            db,
            store.writer().expect("writer"),
            config,
            move |event| match event {
                WatchEvent::Imported { path, to, .. } => {
                    let relative = path.strip_prefix(&root_dir).unwrap_or(&path).to_path_buf();
                    let mut map = committed.lock().expect("committed");
                    let entry = map.entry(relative).or_insert(0);
                    *entry = (*entry).max(to);
                }
                WatchEvent::FileError { path, error } => errors
                    .lock()
                    .expect("errors")
                    .push(format!("{}: {error}", path.display())),
                _ => {}
            },
        )
        .expect("watcher")
    };
    let want: HashMap<PathBuf, u64> = data
        .files
        .iter()
        .map(|(path, size)| {
            (
                path.strip_prefix(&data.dir).expect("inside").to_path_buf(),
                *size,
            )
        })
        .collect();

    let started = Instant::now();
    let id = watcher
        .add_source(&data.dir, true, Some(false))
        .expect("add the folder");
    let mut status_calls = Vec::new();
    let mut last_report = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let done = {
            let map = committed.lock().expect("committed");
            want.iter()
                .filter(|(path, size)| map.get(*path).is_some_and(|to| to >= size))
                .count()
        };
        if last_report.elapsed() >= Duration::from_secs(1) {
            last_report = Instant::now();
            let t = Instant::now();
            let status = watcher.status().expect("status");
            status_calls.push(t.elapsed().as_micros());
            let source = status.sources.iter().find(|s| s.id == id);
            let progress = source
                .and_then(|s| s.backfill)
                .map_or_else(String::new, |b| {
                    format!(
                        "; progress {}/{} MiB, {}/{} files",
                        b.bytes_done >> 20,
                        b.bytes_total >> 20,
                        b.files_done,
                        b.files_total
                    )
                });
            eprintln!(
                "  {:>5.1} s: {done}/{} files, {} hands stored{progress}",
                started.elapsed().as_secs_f64(),
                want.len(),
                source.map_or(0, |s| s.hands)
            );
        }
        if done == want.len() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3600),
            "the import did not finish in an hour"
        );
    }
    let elapsed = started.elapsed();

    // 3. Results.
    let stored = store.status().expect("store status");
    let seconds = elapsed.as_secs_f64();
    let rate = u64::try_from(u128::from(stored.hands) * 1000 / elapsed.as_millis().max(1))
        .unwrap_or(u64::MAX);
    let converted_rate = u64::try_from(u128::from(data.hands) * 1000 / elapsed.as_millis().max(1))
        .unwrap_or(u64::MAX);
    println!(
        "import: {} hands stored of {} in the files (the few others: ids that coincide after \
         rewriting, or a hand a file holds twice), {} refused, {} files; {workers} workers on {cores} cores; {seconds:.2} s -> {rate} hands \
         stored/s ({converted_rate} converted/s, {:.1} MiB/s)",
        stored.hands,
        data.hands,
        stored.quarantined,
        stored.files,
        ratio(mib(data.bytes), seconds),
    );
    status_calls.sort_unstable();
    if let Some(median) = status_calls.get(status_calls.len() / 2) {
        println!(
            "Watcher::status() during the import: median {:.2} ms over {} calls",
            ms(*median),
            status_calls.len()
        );
    }
    let watcher_status = time_us(21, || {
        watcher.status().expect("status");
    });
    let store_status = time_us(21, || {
        store.status().expect("status");
    });
    println!(
        "at {} hands: Watcher::status() {:.2} ms, Store::status() {:.2} ms (median of 21)",
        stored.hands,
        ms(watcher_status),
        ms(store_status)
    );
    let errors = errors.lock().expect("errors").clone();
    watcher.stop();
    let wal = {
        let mut name = db.as_os_str().to_owned();
        name.push("-wal");
        size_of(Path::new(&name))
    };
    store.close();
    let db_size = size_of(db);
    println!(
        "database: {:.1} MiB after the WAL checkpoint ({} bytes per stored hand; WAL was {:.1} \
         MiB before closing)",
        mib(db_size),
        db_size / stored.hands.max(1),
        mib(wal)
    );
    println!(
        "RESULT hands={} seconds={seconds:.3} rate={rate} workers={workers} cores={cores} \
         db_bytes={db_size} watcher_status_us={watcher_status} store_status_us={store_status}",
        stored.hands
    );
    if !errors.is_empty() {
        eprintln!("{} file errors, first: {}", errors.len(), errors[0]);
    }
    rate
}

#[allow(clippy::cast_precision_loss, clippy::float_arithmetic)]
fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

#[allow(clippy::float_arithmetic)]
fn ratio(a: f64, b: f64) -> f64 {
    a / b
}

#[allow(clippy::cast_precision_loss, clippy::float_arithmetic)]
fn ms(us: u128) -> f64 {
    us as f64 / 1000.0
}
