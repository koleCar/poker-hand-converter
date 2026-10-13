//! Import the whole corpus into an empty store and report the time and the
//! database size (docs/RAIL-PLAN.md R1.2's performance sanity check; the
//! R1.6 target is >= 5 000 hands/s).
//!
//! ```text
//! cargo run --release -p rail-store --example import_corpus -- [threads] [db]
//! ```
//!
//! `threads` (default: the machine's parallelism) convert files in
//! parallel and feed the one writer through its bounded queue - the shape
//! R1.6 builds on; `1` is the sequential baseline. `db` defaults to a fresh
//! file in the system temp directory, removed first.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use rail_store::Store;
use rail_store::import::{ImportOptions, whole_file_batch};

fn corpus(root: &Path) -> Vec<PathBuf> {
    let golden = root.join("testdata/golden");
    let mut files = Vec::new();
    let mut stack = vec![golden.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("testdata/golden") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let relative = path
                    .strip_prefix(&golden)
                    .expect("prefix")
                    .with_extension("");
                files.push(root.join(relative));
            }
        }
    }
    files.sort();
    files
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let threads: usize = args
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, usize::from));
    let db = args.next().map_or_else(
        || std::env::temp_dir().join("rail-store-import-corpus.db"),
        PathBuf::from,
    );
    for suffix in ["", "-wal", "-shm"] {
        let mut name = db.clone().into_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let files = corpus(&root);
    let input_bytes: u64 = files.iter().map(|f| size_of(f)).sum();
    let options = ImportOptions::default();

    let started = Instant::now();
    let store = Store::open(&db).expect("open");
    let queue = Mutex::new(files.iter());
    let converted = AtomicU64::new(0);
    let writing_us = AtomicU64::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            let writer = store.writer().expect("writer");
            let (queue, options, converted, writing_us) =
                (&queue, &options, &converted, &writing_us);
            scope.spawn(move || {
                loop {
                    let next = queue.lock().expect("queue").next();
                    let Some(path) = next else { break };
                    let batch = whole_file_batch(path, options).expect("convert");
                    let hands = u64::try_from(batch.hands.len()).expect("count");
                    converted.fetch_add(hands, Ordering::Relaxed);
                    let commit = Instant::now();
                    writer.import(batch).expect("import");
                    let waited = u64::try_from(commit.elapsed().as_micros()).unwrap_or(u64::MAX);
                    writing_us.fetch_add(waited, Ordering::Relaxed);
                }
            });
        }
    });
    let status = store.status().expect("status");
    store.close();
    let elapsed = started.elapsed();

    let hands_converted = converted.load(Ordering::Relaxed);
    let millis = elapsed.as_millis().max(1);
    let per_second = u128::from(hands_converted) * 1000 / millis;
    println!(
        "{} files ({} KiB) -> {} hands stored ({} converted, the rest duplicates across files), \
         {} quarantined, {} unsupported",
        files.len(),
        input_bytes / 1024,
        status.hands,
        hands_converted,
        status.quarantined,
        status.unsupported
    );
    println!(
        "{threads} thread(s): {millis} ms, {per_second} converted hands/s (open, convert, compress, commit); \
         {} ms waiting for the writer, summed over threads",
        writing_us.load(Ordering::Relaxed) / 1000
    );
    println!(
        "database: {} KiB ({} bytes per stored hand), WAL checkpointed on close",
        size_of(&db) / 1024,
        size_of(&db) / status.hands.max(1)
    );
}
