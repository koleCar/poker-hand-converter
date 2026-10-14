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
        move |event| {
            let end = matches!(event, WatchEvent::Progress { backfill: None, .. });
            sink.lock().expect("events").push(event);
            if end {
                // Hold the watcher's thread a moment after an end is out:
                // whatever it has not written to the status yet stays
                // unwritten while the test reads it (an end used to be
                // reported before the status was; a few microseconds on
                // macOS, enough on Linux CI).
                std::thread::sleep(Duration::from_millis(100));
            }
        },
    )
    .expect("start");
    Running {
        watcher,
        store,
        dir,
        events,
    }
}

/// Import threads for the backfill test: `RAIL_WATCH_THREADS` (1 or 2 shake
/// out timing), else 2.
fn backfill_threads() -> usize {
    std::env::var("RAIL_WATCH_THREADS")
        .ok()
        .and_then(|threads| threads.parse().ok())
        .filter(|threads| *threads > 0)
        .unwrap_or(2)
}

/// The folder's progress events, in order (`None`: an end).
fn progress_of(events: &Mutex<Vec<WatchEvent>>, id: i64) -> Vec<Option<Backfill>> {
    events
        .lock()
        .expect("events")
        .iter()
        .filter_map(|event| match event {
            WatchEvent::Progress {
                source_id,
                backfill,
            } if *source_id == id => Some(*backfill),
            _ => None,
        })
        .collect()
}

#[test]
fn a_backfill_reports_its_progress_and_ends() {
    let threads = backfill_threads();
    let running = start("backfill", threads);
    let folder = running.dir.join("hh");
    let (bytes, files) = fill(&folder, 2 * 1024 * 1024);
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    let ended = || progress_of(&running.events, id).contains(&None);
    // On the folder's status while it runs (the first walk queues them all).
    let mut seen: Option<Backfill> = None;
    wait_for("the backfill on the status", 60, || {
        let status = running.watcher.status().expect("status");
        let source = status.sources.iter().find(|s| s.id == id).expect("folder");
        if let Some(backfill) = source.backfill {
            seen = Some(backfill);
        }
        seen.is_some() || ended()
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !ended() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    // Read at once: the status shows the end by the time it is reported (it
    // used to be published up to a loop turn later; Linux CI read
    // `Some(309 of 312 files)` here).
    let status = running.watcher.status().expect("status");
    if !ended() {
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
            "the backfill did not end: {} queued, {} reading; status {:?}; {} files imported (max {} times), \
             {} files copied, {} events, errors {errors:?}, last progress {:?}",
            status.queued,
            status.reading,
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
    let source = status.sources.iter().find(|s| s.id == id).expect("folder");
    assert_eq!(source.backfill, None, "reported over, still on the status");
    // Over: off the status, and every file read.
    wait_for("the backfill over and every file read", 30, || {
        let status = running.watcher.status().expect("status");
        let source = status.sources.iter().find(|s| s.id == id).expect("folder");
        source.backfill.is_none() && usize::try_from(source.files).ok() == Some(files)
    });
    let status = running.watcher.status().expect("status");
    let source = status.sources.iter().find(|s| s.id == id).expect("folder");
    assert!(source.hands > 0);
    assert_eq!(status.threads, threads);
    // Appending a hand afterwards is no backfill.
    running.watcher.set_import_threads(Some(1));
    assert_eq!(running.watcher.status().expect("status").threads_allowed, 1);
    running.watcher.set_import_threads(None);
    // Stopped: every event is out.
    running.watcher.stop();

    let events = progress_of(&running.events, id);
    let end = events
        .iter()
        .position(Option::is_none)
        .expect("the end event");
    let reports: Vec<Backfill> = events[..end].iter().flatten().copied().collect();
    let all: Vec<Backfill> = reports.iter().copied().chain(seen).collect();
    assert!(!all.is_empty(), "no progress was reported");
    let started_at = all[0].started_at;
    for report in &all {
        assert_eq!(report.started_at, started_at, "one backfill: {report:?}");
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
        assert!(pair[0].files_done <= pair[1].files_done, "{pair:?}");
        assert!(pair[0].hands <= pair[1].hands, "{pair:?}");
    }
    // It ended once, and nothing of it came after its end.
    assert_eq!(
        events.iter().filter(|event| event.is_none()).count(),
        1,
        "ends: {events:?}"
    );
    let after: Vec<&Backfill> = events[end + 1..]
        .iter()
        .flatten()
        .filter(|report| report.started_at == started_at)
        .collect();
    assert!(after.is_empty(), "progress after its end: {after:?}");
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
