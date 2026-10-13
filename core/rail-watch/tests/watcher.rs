//! The watcher service on the real clock and the OS's notifications:
//! folders, a second file, subfolders, pause and resume, a folder that is
//! not there, a poll-only folder, disabling and removing, and the latency
//! from an append to the committed batch.
//!
//! Waits are bounded polls of the store (never fixed sleeps that must be
//! long enough); a sleep only proves that nothing happens.

mod common;

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use rail_core::detect::PINNED_PARSED_AT;
use rail_store::Store;
use rail_watch::{NewSource, ReadConfig, SourceState, WatchConfig, WatchEvent, Watcher};

const STARS: &str = "fixtures/samples/pokerstars/27-cash-multi-hand-file-blank-line-separator.txt";
const WINAMAX: &str =
    "fixtures/samples/winamax/hhsmithy-corpus/CashGame_MultipleHandsTests_10MultipleHands.txt";

struct Running {
    // Stopped before the store closes: the store waits for every writer
    // handle, and the watcher holds some.
    watcher: Watcher,
    store: Store,
    dir: PathBuf,
    events: Arc<Mutex<Vec<WatchEvent>>>,
}

fn fast() -> WatchConfig {
    WatchConfig {
        read: ReadConfig {
            quiet_ms: 100,
            settle_ms: 300,
            give_up_ms: 1_000,
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
        },
        // Notifications must do the work: no rescan during a test.
        rescan: Duration::from_secs(600),
        poll_interval: Duration::from_millis(200),
        workers: 2,
        detect_network: false,
        file_globs: BTreeMap::new(),
    }
}

fn start(name: &str, config: WatchConfig) -> Running {
    let dir = scratch_dir(name);
    let store = Store::open(dir.join("rail.db")).expect("open");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
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

fn corpus(relative: &str) -> Vec<u8> {
    fs::read(repo_root().join(relative)).expect("corpus file")
}

fn hands(store: &Store) -> u64 {
    store.status().expect("status").hands
}

fn state_of(running: &Running, id: i64) -> Option<SourceState> {
    running
        .watcher
        .status()
        .expect("status")
        .sources
        .into_iter()
        .find(|source| source.id == id)
        .map(|source| source.state)
}

fn append(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open");
    file.write_all(bytes).expect("append");
}

#[test]
fn watches_new_files_appends_and_subfolders() {
    let running = start("watch", fast());
    let folder = running.dir.join("hh");
    fs::create_dir_all(&folder).expect("folder");
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    wait_for("the folder is watched", 20, || {
        state_of(&running, id) == Some(SourceState::Watching)
    });

    // A new file, written in two pieces.
    let stars = corpus(STARS);
    let starts = hand_starts(&stars);
    let table = folder.join("table one.txt");
    append(&table, &stars[..starts[4]]);
    wait_for("5 hands", 20, || hands(&running.store) == 5);
    append(&table, &stars[starts[4]..]);
    wait_for("10 hands", 20, || hands(&running.store) == 10);

    // A second file, in a new subfolder.
    let sub = folder.join("2026").join("10");
    fs::create_dir_all(&sub).expect("subfolder");
    fs::write(sub.join("winamax.txt"), corpus(WINAMAX)).expect("write");
    wait_for("the second file's hands", 20, || {
        hands(&running.store) == 20
    });

    let status = running.watcher.status().expect("status");
    let source = &status.sources[0];
    assert_eq!(
        (source.files, source.hands, source.hands_today, source.state),
        (2, 20, 20, SourceState::Watching)
    );
    let imported = running
        .events
        .lock()
        .expect("events")
        .iter()
        .filter(|event| matches!(event, WatchEvent::Imported { .. }))
        .count();
    assert!(imported >= 3, "{imported} imports reported");
    running.watcher.stop();
}

#[test]
fn pause_and_resume() {
    let running = start("pause", fast());
    let folder = running.dir.join("hh");
    fs::create_dir_all(&folder).expect("folder");
    let id = running
        .watcher
        .add_source(&folder, false, Some(false))
        .expect("add");
    wait_for("the folder is watched", 20, || {
        state_of(&running, id) == Some(SourceState::Watching)
    });

    running.watcher.pause().expect("pause");
    wait_for("paused", 5, || running.watcher.is_paused());
    fs::write(folder.join("stars.txt"), corpus(STARS)).expect("write");
    std::thread::sleep(Duration::from_millis(1_500));
    assert_eq!(hands(&running.store), 0, "nothing is read while paused");

    running.watcher.resume().expect("resume");
    wait_for("the hands after resuming", 20, || {
        hands(&running.store) == 10
    });
    assert!(!running.watcher.is_paused());
    let events = running.events.lock().expect("events").clone();
    assert!(events.contains(&WatchEvent::Paused(true)));
    assert!(events.contains(&WatchEvent::Paused(false)));
    running.watcher.stop();
}

#[test]
fn a_folder_that_is_not_there_is_retried_and_comes_back() {
    let config = WatchConfig {
        rescan: Duration::from_millis(300),
        ..fast()
    };
    let running = start("unplugged", config);
    let folder = running.dir.join("drive").join("hh");
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    wait_for("unavailable", 20, || {
        state_of(&running, id) == Some(SourceState::Unavailable)
    });
    let stored = running.store.reader().sources().expect("sources");
    assert_eq!(stored[0].status, "unavailable");
    assert!(stored[0].last_error.is_some());

    // The drive comes back, with a file on it.
    fs::create_dir_all(&folder).expect("folder");
    fs::write(folder.join("stars.txt"), corpus(STARS)).expect("write");
    wait_for("the hands from the folder", 20, || {
        hands(&running.store) == 10
    });
    wait_for("watching", 20, || {
        state_of(&running, id) == Some(SourceState::Watching)
    });

    // Unplugged again: the offsets stay, the folder is unavailable.
    // (Windows may refuse while its notification handle is open: retry.)
    wait_for("the drive removed", 20, || {
        fs::remove_dir_all(running.dir.join("drive")).is_ok() || !running.dir.join("drive").exists()
    });
    // Gone (or, on Windows, delete-pending and unreadable).
    wait_for("unavailable again", 20, || {
        matches!(
            state_of(&running, id),
            Some(SourceState::Unavailable | SourceState::Error)
        )
    });
    let files = running.store.reader().files().expect("files");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].read_offset, files[0].size, "the offset is kept");
    running.watcher.stop();
}

#[test]
fn a_poll_only_folder_is_read_by_polling() {
    let running = start("poll", fast());
    let folder = running.dir.join("share");
    fs::create_dir_all(&folder).expect("folder");
    let id = running
        .watcher
        .add_source(&folder, true, Some(true))
        .expect("add");
    wait_for("polling", 20, || {
        state_of(&running, id) == Some(SourceState::Polling)
    });
    fs::write(folder.join("stars.txt"), corpus(STARS)).expect("write");
    wait_for("the hands", 20, || hands(&running.store) == 10);
    let status = running.watcher.status().expect("status");
    assert!(status.sources[0].poll_only);
    running.watcher.stop();
}

#[test]
fn a_disabled_folder_is_not_read_and_a_removed_one_keeps_its_hands() {
    let running = start("disable", fast());
    let folder = running.dir.join("hh");
    fs::create_dir_all(&folder).expect("folder");
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    fs::write(folder.join("stars.txt"), corpus(STARS)).expect("write");
    wait_for("the hands", 20, || hands(&running.store) == 10);

    assert!(
        running
            .watcher
            .set_source_enabled(id, false)
            .expect("disable")
    );
    wait_for("disabled", 20, || {
        state_of(&running, id) == Some(SourceState::Disabled)
    });
    fs::write(folder.join("winamax.txt"), corpus(WINAMAX)).expect("write");
    std::thread::sleep(Duration::from_millis(1_000));
    assert_eq!(hands(&running.store), 10, "a disabled folder is not read");

    assert!(
        running
            .watcher
            .set_source_enabled(id, true)
            .expect("enable")
    );
    wait_for("the new file after enabling", 20, || {
        hands(&running.store) == 20
    });

    assert!(running.watcher.remove_source(id).expect("remove"));
    assert!(
        running
            .store
            .reader()
            .sources()
            .expect("sources")
            .is_empty()
    );
    assert_eq!(hands(&running.store), 20, "hands stay");
    running.watcher.stop();
}

/// From an append to its committed batch, with the default timing (the
/// quiet period of 500 ms) and the OS's notifications: the hand that the
/// next one completes, and the last hand, which waits for the quiet period.
/// docs/RAIL-PLAN.md §3.3 aims at < 1 s; asserted loosely (CI machines),
/// printed for the record.
#[test]
fn latency_from_append_to_commit() {
    let config = WatchConfig {
        read: ReadConfig {
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
            ..ReadConfig::default()
        },
        rescan: Duration::from_secs(600),
        detect_network: false,
        ..WatchConfig::default()
    };
    let running = start("latency", config);
    let folder = running.dir.join("hh");
    fs::create_dir_all(&folder).expect("folder");
    let id = running
        .watcher
        .add_source(&folder, true, Some(false))
        .expect("add");
    wait_for("watching", 20, || {
        state_of(&running, id) == Some(SourceState::Watching)
    });
    // FSEvents and inotify start delivering a moment after the watch.
    std::thread::sleep(Duration::from_millis(300));

    let stars = corpus(STARS);
    let starts = hand_starts(&stars);
    let mut bounds = vec![0];
    bounds.extend(&starts);
    bounds.push(stars.len());
    let path = folder.join("live.txt");
    let mut next_header = Vec::new();
    let mut quiet = Vec::new();
    // Two hands at a time: the first is complete when the second starts,
    // the second when the file has been quiet.
    for pair in bounds.windows(3).step_by(2) {
        let before = hands(&running.store);
        let written = Instant::now();
        append(&path, &stars[pair[0]..pair[2]]);
        wait_for("the first hand", 20, || hands(&running.store) > before);
        next_header.push(written.elapsed());
        wait_for("the second hand", 20, || {
            hands(&running.store) == before + 2
        });
        quiet.push(written.elapsed());
        std::thread::sleep(Duration::from_millis(200));
    }
    let median = |list: &mut Vec<Duration>| {
        list.sort();
        list[list.len() / 2]
    };
    let (first, second) = (median(&mut next_header), median(&mut quiet));
    println!(
        "append to commit, median of {}: next hand started {} ms, quiet {} ms (quiet period 500 ms)",
        next_header.len(),
        first.as_millis(),
        second.as_millis()
    );
    assert!(first < Duration::from_secs(2), "{first:?}");
    assert!(second < Duration::from_secs(3), "{second:?}");
    running.watcher.stop();
}

/// R1.4: a folder added for a room reads only the room's files
/// (`files.glob`), and "only new hands" skips what is there when it is
/// added - the hands written afterwards come in, the old ones never do.
#[test]
fn only_new_hands_and_a_rooms_files() {
    let config = WatchConfig {
        file_globs: BTreeMap::from([("pokerstars".to_owned(), "HH*.txt".to_owned())]),
        ..fast()
    };
    let running = start("only-new", config);
    let folder = running.dir.join("hh");
    fs::create_dir_all(&folder).expect("folder");
    let stars = corpus(STARS);
    let starts = hand_starts(&stars);
    // Five hands already there; a text file that is not the room's.
    let old = folder.join("HH20260101 old table.txt");
    fs::write(&old, &stars[..starts[4]]).expect("write");
    fs::write(folder.join("notes.txt"), corpus(WINAMAX)).expect("write");

    let added = running
        .watcher
        .add_source_with(
            &folder,
            &NewSource {
                recursive: true,
                poll_only: Some(false),
                site: Some("pokerstars".to_owned()),
                only_new: true,
            },
        )
        .expect("add");
    assert_eq!(added.marked, 1, "only the room's file is marked");
    wait_for("the folder is watched", 20, || {
        state_of(&running, added.id) == Some(SourceState::Watching)
    });
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(hands(&running.store), 0, "the old hands are skipped");

    // The table goes on: its next five hands come in.
    append(&old, &stars[starts[4]..]);
    wait_for("the new hands", 20, || hands(&running.store) == 5);
    // A new table of the room: all of it.
    fs::write(folder.join("HH20260102 new table.txt"), corpus(WINAMAX)).expect("write");
    wait_for("the new file", 20, || hands(&running.store) == 15);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(hands(&running.store), 15, "notes.txt is not the room's");

    let status = running.watcher.status().expect("status");
    assert_eq!(status.sources[0].site.as_deref(), Some("pokerstars"));
    assert_eq!(status.sources[0].files, 2);
    running.watcher.stop();
}
