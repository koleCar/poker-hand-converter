//! R1.6 on the running watcher: a backfill reports its progress (bytes of
//! bytes, files, hands) on the folder's status and as events, and ends;
//! "try again after an update" reads again the files whose refusals an
//! older parser version made; fewer import threads can be asked for.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use rail_core::detect::PINNED_PARSED_AT;
use rail_store::Store;
use rail_watch::{Backfill, ReadConfig, WatchConfig, WatchEvent, Watcher};

/// One hand, refused (`truncated-hand`).
const REFUSED: &str = "fixtures/samples/888poker/13-invalid-hand-truncated-flop.txt";

struct Running {
    // Stopped before the store closes.
    watcher: Watcher,
    store: Store,
    dir: PathBuf,
    events: Arc<Mutex<Vec<WatchEvent>>>,
}

fn start(name: &str, workers: usize) -> Running {
    let dir = scratch_dir(name);
    let store = Store::open(dir.join("rail.db")).expect("open");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let config = WatchConfig {
        read: ReadConfig {
            quiet_ms: 100,
            settle_ms: 300,
            give_up_ms: 1_000,
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
            ..ReadConfig::default()
        },
        rescan: Duration::from_secs(600),
        poll_interval: Duration::from_millis(200),
        workers,
        detect_network: false,
        file_globs: BTreeMap::new(),
    };
    let watcher = Watcher::start(
        store.path(),
        store.writer().expect("writer"),
        config,
        move |event| sink.lock().expect("events").push(event),
    )
    .expect("start");
    Running {
        watcher,
        store,
        dir,
        events,
    }
}

/// Copy corpus files with hands into `folder` until there are `bytes`,
/// their mtime an hour back (old files: no quiet period to wait for).
fn fill(folder: &std::path::Path, bytes: u64) -> (u64, usize) {
    fs::create_dir_all(folder).expect("folder");
    let (mut total, mut files) = (0, 0);
    for golden in all_goldens() {
        if golden.hands == 0 || golden.unknown_site.is_some() {
            continue;
        }
        let name = golden.path.replace(['/', '\\'], "_");
        let path = folder.join(name);
        fs::copy(repo_root().join(&golden.path), &path).expect("copy");
        set_mtime(&path, now_ms() - 3_600_000);
        total += golden.bytes;
        files += 1;
        if total >= bytes {
            break;
        }
    }
    (total, files)
}

#[test]
fn a_backfill_reports_its_progress_and_ends() {
    let running = start("backfill", 2);
    let folder = running.dir.join("hh");
    let (bytes, files) = fill(&folder, 2 * 1024 * 1024);
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    // On the folder's status while it runs (the first walk queues them all).
    let mut seen: Option<Backfill> = None;
    wait_for("the backfill on the status", 60, || {
        let status = running.watcher.status().expect("status");
        let source = status.sources.iter().find(|s| s.id == id).expect("folder");
        if let Some(backfill) = source.backfill {
            seen = Some(backfill);
        }
        seen.is_some()
            || running
                .events
                .lock()
                .expect("events")
                .contains(&WatchEvent::Progress {
                    source_id: id,
                    backfill: None,
                })
    });
    let ended = || {
        running
            .events
            .lock()
            .expect("events")
            .contains(&WatchEvent::Progress {
                source_id: id,
                backfill: None,
            })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !ended() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !ended() {
        let status = running.watcher.status().expect("status");
        let events = running.events.lock().expect("events").clone();
        let imported: std::collections::BTreeMap<PathBuf, usize> =
            events.iter().fold(BTreeMap::new(), |mut map, event| {
                if let WatchEvent::Imported { path, .. } = event {
                    *map.entry(path.clone()).or_default() += 1;
                }
                map
            });
        let errors: Vec<&WatchEvent> = events
            .iter()
            .filter(|e| matches!(e, WatchEvent::FileError { .. }))
            .collect();
        panic!(
            "the backfill did not end: status {:?}; {} files imported (max {} times), \
             {} files copied, {} events, errors {errors:?}, last progress {:?}",
            status.sources,
            imported.len(),
            imported.values().max().copied().unwrap_or(0),
            files,
            events.len(),
            events
                .iter()
                .rev()
                .find(|e| matches!(e, WatchEvent::Progress { .. }))
        );
    }
    let reports: Vec<Backfill> = running
        .events
        .lock()
        .expect("events")
        .iter()
        .filter_map(|event| match event {
            WatchEvent::Progress {
                source_id,
                backfill: Some(backfill),
            } if *source_id == id => Some(*backfill),
            _ => None,
        })
        .collect();
    let all: Vec<Backfill> = reports.iter().copied().chain(seen).collect();
    assert!(!all.is_empty(), "no progress was reported");
    for report in &all {
        assert_eq!(report.bytes_total, bytes, "{report:?}");
        assert_eq!(
            usize::try_from(report.files_total).ok(),
            Some(files),
            "{report:?}"
        );
        assert!(report.bytes_done <= report.bytes_total, "{report:?}");
        assert!(report.files_done <= report.files_total, "{report:?}");
    }
    // Monotonic.
    for pair in reports.windows(2) {
        assert!(pair[0].bytes_done <= pair[1].bytes_done, "{pair:?}");
        assert!(pair[0].hands <= pair[1].hands, "{pair:?}");
    }
    let status = running.watcher.status().expect("status");
    let source = status.sources.iter().find(|s| s.id == id).expect("folder");
    assert_eq!(source.backfill, None, "over");
    assert_eq!(
        usize::try_from(source.files).ok(),
        Some(files),
        "every file read"
    );
    assert!(source.hands > 0);
    assert_eq!(status.threads, 2);
    // Appending a hand afterwards is no backfill.
    running.watcher.set_import_threads(Some(1));
    assert_eq!(running.watcher.status().expect("status").threads_allowed, 1);
    running.watcher.set_import_threads(None);
    running.watcher.stop();
    drop(running.store);
}

#[test]
fn refusals_by_an_older_parser_are_read_again() {
    let running = start("retry", 2);
    let folder = running.dir.join("hh");
    fs::create_dir_all(&folder).expect("folder");
    let file = folder.join("refused.txt");
    fs::copy(repo_root().join(REFUSED), &file).expect("copy");
    set_mtime(&file, now_ms() - 3_600_000);
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    wait_for("the refusal", 30, || {
        running.store.status().expect("status").quarantined == 1
    });
    let versions = Watcher::parser_versions();
    assert_eq!(
        running
            .store
            .reader()
            .stale_refusals(&versions, Some(id))
            .expect("stale")
            .files,
        0
    );
    // Nothing to read again yet.
    assert_eq!(running.watcher.retry_refused(Some(id)).expect("retry"), 0);

    // As if an older build had refused it.
    let conn = rusqlite::Connection::open(running.store.path()).expect("open");
    conn.busy_timeout(Duration::from_secs(5)).expect("busy");
    conn.execute("UPDATE quarantine SET parser_version = '0.0.1'", [])
        .expect("older");
    let before = imports_of(&running, &file);
    assert_eq!(running.watcher.retry_refused(None).expect("retry"), 1);
    wait_for("read again", 30, || imports_of(&running, &file) > before);
    wait_for("refused again, by today's version", 30, || {
        running
            .store
            .reader()
            .stale_refusals(&versions, None)
            .expect("stale")
            .files
            == 0
            && running.store.status().expect("status").quarantined == 1
    });
    running.watcher.stop();
}

fn imports_of(running: &Running, file: &std::path::Path) -> usize {
    running
        .events
        .lock()
        .expect("events")
        .iter()
        .filter(|event| matches!(event, WatchEvent::Imported { path, .. } if path == file))
        .count()
}
