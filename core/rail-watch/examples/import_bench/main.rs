//! The import benchmark (docs/RAIL-PLAN.md R1.6; guideline §1: local import
//! of old hands at >= 5 000 hands/s).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     [--hands 100000] [--workers N] [--runs 1] [--min-rate 5000] [--keep] [--dir PATH]
//! ```
//!
//! 1. Builds a **generated** dataset of about `--hands` hands in a temporary
//!    directory: copies of the repository's corpus with rewritten hand ids
//!    (`dataset.rs`; labelled `GENERATED.md`, removed afterwards unless
//!    `--keep`; never under `testdata/` or a fixture tree).
//! 2. Opens an **empty** store, starts the real watcher (`Watcher::start`,
//!    the app's pipeline: walk, workers, conversion, the one writer) and adds
//!    the dataset's folder with "import everything" - the backfill a user
//!    gets when they confirm a folder of old hand histories.
//! 3. Times it until every file is committed to its end, then reports hands
//!    stored per second, the folder's progress as `status()` showed it, the
//!    cost of `Watcher::status()` and of the store's counts at that size, and
//!    the database's size.
//!
//! Exits with status 1 when hands stored per second fall below
//! `--min-rate` (CI's gate); with `--runs N` the import is repeated into a
//! fresh store and the best run counts (a shared CI runner is noisy).
//! `--workers` defaults to the app's default (`WatchConfig::default()`).

mod dataset;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rail_store::Store;
use rail_watch::{WatchConfig, WatchEvent, Watcher};

#[derive(Debug)]
struct Args {
    hands: u64,
    workers: Option<usize>,
    min_rate: Option<u64>,
    keep: bool,
    dir: Option<PathBuf>,
    runs: usize,
}

fn args() -> Args {
    let mut args = Args {
        hands: 100_000,
        workers: None,
        min_rate: None,
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

    // 2.-3. Each run into an empty store; the gate takes the best.
    let mut best = 0;
    for run in 1..=args.runs.max(1) {
        if args.runs > 1 {
            println!("run {run} of {}:", args.runs);
        }
        best = best.max(import_once(&args, &data, &db, cores));
    }
    if !args.keep {
        let _ = std::fs::remove_dir_all(&base);
    }
    if let Some(min) = args.min_rate {
        if best < min {
            eprintln!("FAIL: {best} hands/s is below the gate of {min} hands/s");
            std::process::exit(1);
        }
        println!("PASS: {best} hands/s, the gate is {min} hands/s");
    }
}

/// One import of the dataset into an empty store; returns hands stored/s.
fn import_once(args: &Args, data: &dataset::Dataset, db: &Path, cores: usize) -> u64 {
    remove_store(db);
    let store = Store::open(db).expect("store");
    let config = WatchConfig {
        workers: args.workers.unwrap_or(WatchConfig::default().workers),
        ..WatchConfig::default()
    };
    let workers = config.workers;
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
