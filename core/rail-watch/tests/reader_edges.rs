//! The incremental reader's edge cases, on the test's own clock (nothing
//! sleeps): the completeness rule step by step, truncation, a replaced
//! file, rename, deletion, a refused tail, a hand without a line end, an
//! encoding that turns out to be another, a file nothing claims.

mod common;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use common::*;
use rail_core::detect::PINNED_PARSED_AT;
use rail_store::{ImportOptions, Store, import_file};
use rail_watch::{Attempt, FileReader, FileRef, FileTrack, Finished, Polled, ReadConfig, Started};

const STARS: &str = "fixtures/samples/pokerstars/27-cash-multi-hand-file-blank-line-separator.txt";
const STARS_58: &str = "fixtures/samples/pokerstars/28-cash-multi-hand-file-no-blank-separator.txt";
const STUD: &str =
    "fixtures/samples/ignition/fpdb3-regression-corpus/cash__7-Stud-USD-2.00-4.00-201205.txt";
const UNKNOWN: &str = "fixtures/samples/bossmedia/02-fixed-limit-holdem.txt";
const HOME_GAME: &str = "fixtures/samples/pokerstars/33-cash-homegame-playmoney-nlhe.txt";

struct Setup {
    // Dropped before the store: the store waits for every writer handle.
    reader: FileReader,
    dir: PathBuf,
    store: Store,
    config: ReadConfig,
}

fn setup(name: &str) -> Setup {
    let dir = scratch_dir(name);
    let store = Store::open(dir.join("rail.db")).expect("open");
    let config = ReadConfig {
        parsed_at: Some(PINNED_PARSED_AT.to_owned()),
        ..ReadConfig::default()
    };
    let reader = FileReader::new(
        store.path(),
        store.writer().expect("writer"),
        config.clone(),
    )
    .expect("reader");
    fs::create_dir_all(dir.join("hh")).expect("hh");
    Setup {
        dir,
        store,
        reader,
        config,
    }
}

fn corpus(relative: &str) -> Vec<u8> {
    fs::read(repo_root().join(relative)).expect("corpus file")
}

/// Write `bytes` as the file's whole content, with the mtime at `clock`.
fn write_at(path: &Path, bytes: &[u8], clock: i64) {
    fs::write(path, bytes).expect("write");
    set_mtime(path, clock);
}

fn append_at(path: &Path, bytes: &[u8], clock: i64) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open");
    file.write_all(bytes).expect("append");
    drop(file);
    set_mtime(path, clock);
}

fn hands(store: &Store) -> u64 {
    store.status().expect("status").hands
}

fn offset(store: &Store, path: &Path) -> u64 {
    store
        .reader()
        .file_state(&rail_store::import::path_key(path))
        .expect("state")
        .map_or(0, |state| u64::try_from(state.read_offset).expect("offset"))
}

fn committed(polled: &Polled) -> (u64, u64, u32, u32) {
    match polled {
        Polled::Committed {
            outcome, from, to, ..
        } => (*from, *to, outcome.inserted, outcome.duplicates),
        other => panic!("expected a commit, got {other:?}"),
    }
}

fn whole_file(bytes: &[u8], name: &str) -> Held {
    let dir = scratch_dir("whole");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write");
    import_file(
        &store,
        &path,
        &ImportOptions {
            parsed_at: Some(PINNED_PARSED_AT.to_owned()),
            source_id: None,
        },
    )
    .expect("import");
    held(&store)
}

#[test]
fn a_hand_is_complete_when_the_next_starts_or_the_file_is_quiet() {
    let s = setup("rule");
    let bytes = corpus(STARS);
    let starts = hand_starts(&bytes);
    let (b1, b2) = (starts[0], starts[1]);
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    let quiet = s.config.quiet_ms;

    // Hand 1 and the first line of hand 2: hand 1 is complete at once.
    let cut = b1 + 40;
    write_at(&path, &bytes[..cut], T0);
    let polled = s.reader.poll(&file, &mut track, T0).expect("poll");
    assert_eq!(committed(&polled), (0, b1 as u64, 1, 0));
    // Quiet, but hand 2 does not validate yet: it waits for the give-up
    // time, the offset stays at its start.
    let polled = s.reader.poll(&file, &mut track, T0 + quiet).expect("poll");
    assert_eq!(
        polled,
        Polled::Waiting {
            recheck_at: Some(T0 + s.config.give_up_ms)
        }
    );
    assert_eq!(offset(&s.store, &path), b1 as u64);

    // The rest of hand 2, up to hand 3's first byte: not before the quiet
    // period...
    append_at(&path, &bytes[cut..b2], T0 + 100);
    let polled = s.reader.poll(&file, &mut track, T0 + 100).expect("poll");
    assert!(matches!(polled, Polled::Waiting { .. }), "{polled:?}");
    assert_eq!(hands(&s.store), 1);
    // ... and then whole.
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + 100 + quiet)
        .expect("poll");
    assert_eq!(committed(&polled), (b1 as u64, b2 as u64, 1, 0));
    assert_eq!(hands(&s.store), 2);
    assert_eq!(
        s.reader.poll(&file, &mut track, T0 + 10_000).expect("poll"),
        Polled::Unchanged
    );

    // Several hands at once: all but the last at once, the last when quiet.
    let b5 = starts[4];
    append_at(&path, &bytes[b2..b5 + 40], T0 + 20_000);
    let polled = s.reader.poll(&file, &mut track, T0 + 20_000).expect("poll");
    assert_eq!(committed(&polled), (b2 as u64, b5 as u64, 3, 0));
    assert_eq!(hands(&s.store), 5);
}

/// The watcher's import threads queue a batch and leave the wait for its
/// commit to the committer (`FileReader::start`, `Committing::wait`). A
/// batch whose stored offset moved before the writer got to it stores
/// nothing, and the same look goes on from the new offset
/// (`Finished::Again`) - what `poll` did inline before.
#[test]
fn a_batch_whose_offset_moved_before_its_commit_is_read_again() {
    let s = setup("moved");
    let bytes = corpus(STARS);
    let starts = hand_starts(&bytes);
    let (b1, b2) = (starts[0], starts[1]);
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &bytes[..b1 + 40], T0);
    let polled = s.reader.poll(&file, &mut track, T0).expect("poll");
    assert_eq!(committed(&polled), (0, b1 as u64, 1, 0));
    // Hand 2 is complete once hand 3 starts.
    append_at(&path, &bytes[b1 + 40..b2 + 40], T0 + 100);

    // The writer is held by a job that, once the batch is queued behind
    // it, sets the file's offset back to 0 (as a reset would).
    let writer = s.store.writer().expect("writer");
    let key = rail_store::import::path_key(&path);
    let (started, running) = std::sync::mpsc::channel();
    let (go, wait) = std::sync::mpsc::channel::<()>();
    let blocker = std::thread::spawn(move || {
        writer.write(move |tx| {
            started.send(()).expect("started");
            wait.recv().expect("go");
            tx.execute("UPDATE files SET read_offset = 0 WHERE path = ?1", [key])?;
            Ok(())
        })
    });
    running.recv().expect("the job runs");
    let Started::Committing(committing) = s
        .reader
        .start(&file, &mut track, T0 + 100, Attempt::default())
        .expect("start")
    else {
        panic!("expected a batch with the writer");
    };
    go.send(()).expect("go");
    blocker.join().expect("join").expect("offset moved");
    let Finished::Again(attempt) = committing.wait(&mut track).expect("wait") else {
        panic!("expected the look to go on");
    };
    assert_eq!(hands(&s.store), 1, "the stale batch stored nothing");
    assert_eq!(offset(&s.store, &path), 0);

    // The rest of the look reads from the moved offset: hand 1 again (known)
    // and hand 2.
    let Started::Committing(committing) = s
        .reader
        .start(&file, &mut track, T0 + 100, attempt)
        .expect("start")
    else {
        panic!("expected a batch with the writer");
    };
    let Finished::Done(polled) = committing.wait(&mut track).expect("wait") else {
        panic!("expected a commit");
    };
    assert_eq!(committed(&polled), (0, b2 as u64, 1, 1));
    assert_eq!(hands(&s.store), 2);
    assert_eq!(offset(&s.store, &path), b2 as u64);
}

/// "Only new hands" (R1.4): a file marked as read imports nothing of what
/// it held, then exactly the hands written after it.
#[test]
fn a_file_marked_as_read_imports_only_what_follows() {
    let s = setup("mark");
    let bytes = corpus(STARS);
    let starts = hand_starts(&bytes);
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    let quiet = s.config.quiet_ms;

    write_at(&path, &bytes[..starts[4]], T0);
    assert!(s.reader.mark_read(&file).expect("mark"));
    assert_eq!(offset(&s.store, &path), starts[4] as u64);
    assert_eq!(hands(&s.store), 0);
    // Marked once: a file the store has a row for is left alone.
    assert!(!s.reader.mark_read(&file).expect("mark again"));
    assert_eq!(
        s.reader.poll(&file, &mut track, T0 + quiet).expect("poll"),
        Polled::Unchanged
    );

    append_at(&path, &bytes[starts[4]..], T0 + 1_000);
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + 1_000 + quiet)
        .expect("poll");
    let (from, _, inserted, duplicates) = committed(&polled);
    assert_eq!((from, inserted, duplicates), (starts[4] as u64, 5, 0));
    assert_eq!(hands(&s.store), 5);

    // A missing or empty file is not marked.
    let empty = s.dir.join("hh/empty.txt");
    write_at(&empty, b"", T0);
    assert!(!s.reader.mark_read(&FileRef::new(&empty)).expect("empty"));
    let missing = s.dir.join("hh/missing.txt");
    assert!(
        !s.reader
            .mark_read(&FileRef::new(&missing))
            .expect("missing")
    );
}

/// A UTF-16 file cut inside a code unit is marked to the last whole unit:
/// the next read starts on a unit boundary.
#[test]
fn a_utf16_file_is_marked_to_a_whole_code_unit() {
    let s = setup("mark-utf16");
    let path = s.dir.join("hh/utf16.txt");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "PokerStars Hand #1: text\n".encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    bytes.push(b'P');
    write_at(&path, &bytes, T0);
    assert!(s.reader.mark_read(&FileRef::new(&path)).expect("mark"));
    assert_eq!(offset(&s.store, &path), (bytes.len() - 1) as u64);
}

#[test]
fn a_hand_without_a_line_end_waits_to_settle() {
    let s = setup("settle");
    let bytes = corpus(STARS);
    let end = bytes.len()
        - bytes
            .iter()
            .rev()
            .take_while(|b| b.is_ascii_whitespace())
            .count();
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &bytes[..end], T0);
    // All hands but the last at once; the last has no line end after it.
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.quiet_ms)
        .expect("poll");
    let (_, to, inserted, _) = committed(&polled);
    assert_eq!(inserted, 9);
    assert!(to < end as u64);
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.quiet_ms + 1)
        .expect("poll");
    assert!(matches!(polled, Polled::Waiting { .. }), "{polled:?}");
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.settle_ms)
        .expect("poll");
    assert_eq!(committed(&polled), (to, end as u64, 1, 0));
    assert_eq!(hands(&s.store), 10);
}

#[test]
fn a_refused_tail_waits_for_the_give_up_time() {
    let s = setup("refused-tail");
    let bytes = corpus(STUD);
    let path = s.dir.join("hh/stud.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &bytes, T0);
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.quiet_ms)
        .expect("poll");
    committed(&polled);
    assert_eq!(s.store.status().expect("status").quarantined, 3);
    assert!(offset(&s.store, &path) < bytes.len() as u64);
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.give_up_ms)
        .expect("poll");
    assert_eq!(committed(&polled).1, bytes.len() as u64);
    assert_eq!(s.store.status().expect("status").quarantined, 4);
}

#[test]
fn truncation_reads_again_from_the_start() {
    let s = setup("truncate");
    let bytes = corpus(STARS);
    let starts = hand_starts(&bytes);
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &bytes[..starts[3]], T0);
    s.reader.poll(&file, &mut track, T0 + 1_000).expect("poll");
    assert_eq!(hands(&s.store), 4);

    // Truncated, then hands 1-2 written again: read from 0, nothing new.
    write_at(&path, &bytes[..starts[1]], T0 + 2_000);
    let polled = s.reader.poll(&file, &mut track, T0 + 3_000).expect("poll");
    assert_eq!(committed(&polled), (0, starts[1] as u64, 0, 2));
    assert_eq!(track.stats.restarts, 1);
    assert_eq!(offset(&s.store, &path), starts[1] as u64);

    // Emptied and filled with other hands: all of them are new.
    let other = corpus(STARS_58);
    write_at(&path, &[], T0 + 4_000);
    s.reader.poll(&file, &mut track, T0 + 4_100).expect("poll");
    write_at(&path, &other, T0 + 5_000);
    let polled = s.reader.poll(&file, &mut track, T0 + 6_000).expect("poll");
    assert_eq!(committed(&polled).0, 0);
    // The two files share hands: the store has each once.
    let mut keys: std::collections::BTreeSet<String> = whole_file(&bytes[..starts[3]], "stars.txt")
        .hands
        .into_keys()
        .collect();
    keys.extend(whole_file(&other, "stars.txt").hands.into_keys());
    assert_eq!(
        held(&s.store)
            .hands
            .into_keys()
            .collect::<std::collections::BTreeSet<_>>(),
        keys
    );
}

#[test]
fn a_replaced_file_is_read_from_its_start() {
    let s = setup("replace");
    let first = corpus(HOME_GAME);
    let second = corpus(STARS);
    assert!(second.len() > first.len());
    let path = s.dir.join("hh/table.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &first, T0);
    s.reader.poll(&file, &mut track, T0 + 1_000).expect("poll");
    assert_eq!(offset(&s.store, &path), first.len() as u64);

    // Rotated: another file renamed over it, longer than the first.
    let tmp = s.dir.join("hh/table.tmp");
    fs::write(&tmp, &second).expect("write");
    fs::rename(&tmp, &path).expect("rename");
    set_mtime(&path, T0 + 2_000);
    let polled = s.reader.poll(&file, &mut track, T0 + 3_000).expect("poll");
    assert_eq!(committed(&polled).0, 0, "read from the start");
    assert_eq!(track.stats.restarts, 1);
    assert_eq!(offset(&s.store, &path), second.len() as u64);
    assert_eq!(hands(&s.store), 2 + 10);
}

#[test]
fn rename_and_deletion() {
    let s = setup("rename");
    let bytes = corpus(STARS);
    let a = s.dir.join("hh/a.txt");
    let b = s.dir.join("hh/b.txt");
    let mut track_a = FileTrack::default();
    let mut track_b = FileTrack::default();
    write_at(&a, &bytes, T0);
    s.reader
        .poll(&FileRef::new(&a), &mut track_a, T0 + 1_000)
        .expect("poll");
    assert_eq!(hands(&s.store), 10);

    // Renamed: the old name is gone (and forgotten), the new one is read
    // from its start - its hands are known.
    fs::rename(&a, &b).expect("rename");
    let gone = s
        .reader
        .poll(&FileRef::new(&a), &mut track_a, T0 + 2_000)
        .expect("poll");
    assert_eq!(gone, Polled::Gone);
    s.reader
        .forget(&FileRef::new(&a), &mut track_a)
        .expect("forget");
    assert_eq!(offset(&s.store, &a), 0);
    let polled = s
        .reader
        .poll(&FileRef::new(&b), &mut track_b, T0 + 2_000)
        .expect("poll");
    assert_eq!(committed(&polled), (0, bytes.len() as u64, 0, 10));

    // Deleted, then a new file at the old name: from its start.
    fs::remove_file(&b).expect("delete");
    assert_eq!(
        s.reader
            .poll(&FileRef::new(&b), &mut track_b, T0 + 3_000)
            .expect("poll"),
        Polled::Gone
    );
    s.reader
        .forget(&FileRef::new(&b), &mut track_b)
        .expect("forget");
    let other = corpus(STUD);
    write_at(&b, &other, T0 + 4_000);
    let polled = s
        .reader
        .poll(
            &FileRef::new(&b),
            &mut track_b,
            T0 + 4_000 + s.config.give_up_ms,
        )
        .expect("poll");
    assert_eq!(committed(&polled).0, 0);
    assert_eq!(hands(&s.store), 10, "hands stay after their file is gone");
}

/// The first hand ASCII, a later one with a Windows-1252 byte (as a UTF-8
/// file cannot have): the file is Windows-1252, and since what was stored
/// is ASCII the offset stands.
#[test]
fn an_ascii_start_that_turns_out_windows_1252_keeps_its_offset() {
    let s = setup("recode");
    let text = String::from_utf8(corpus(STARS)[3..].to_vec()).expect("ascii");
    assert!(text.is_ascii());
    let bytes = text.as_bytes();
    let starts = hand_starts(bytes);
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &bytes[..starts[2]], T0);
    s.reader.poll(&file, &mut track, T0 + 1_000).expect("poll");
    assert_eq!(hands(&s.store), 3);

    // Hand 3 with a player whose name has an e-acute in Windows-1252.
    let hand3 = &text[starts[2]..starts[3]];
    let name = hand3
        .lines()
        .find_map(|line| line.strip_prefix("Seat 1: "))
        .and_then(|rest| rest.split(" (").next())
        .expect("seat 1")
        .to_owned();
    let mut hand3 = hand3.replace(&name, "Jos\u{e9}").into_bytes();
    // Back to one byte per character.
    hand3 = encode(
        &String::from_utf8(hand3).expect("text"),
        rail_core::decode::Encoding::Windows1252,
    );
    append_at(&path, &hand3, T0 + 2_000);
    let polled = s.reader.poll(&file, &mut track, T0 + 3_000).expect("poll");
    assert_eq!(committed(&polled).0, starts[2] as u64);
    assert_eq!(track.stats.recoded, 1);
    assert_eq!(track.stats.from_zero, 0);
    assert_eq!(track.codec(), Some(rail_watch::codec::Codec::Windows1252));
    let final_bytes = fs::read(&path).expect("read");
    assert_eq!(held(&s.store), whole_file(&final_bytes, "stars.txt"));
}

/// UTF-8 with an e-acute stored, then a Windows-1252 byte: the core reads
/// the whole file as Windows-1252, so it is read again from 0. The hand
/// already stored keeps its (right) text; the keys are the core's.
#[test]
fn utf8_that_turns_out_windows_1252_is_read_again() {
    let s = setup("recode-again");
    let text = String::from_utf8(corpus(STARS)[3..].to_vec()).expect("ascii");
    let starts = hand_starts(text.as_bytes());
    let name = text[..starts[0]]
        .lines()
        .find_map(|line| line.strip_prefix("Seat 1: "))
        .and_then(|rest| rest.split(" (").next())
        .expect("seat 1")
        .to_owned();
    let first = text[..starts[0]].replace(&name, "Jos\u{e9}");
    let path = s.dir.join("hh/stars.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, first.as_bytes(), T0);
    s.reader.poll(&file, &mut track, T0 + 1_000).expect("poll");
    assert_eq!(hands(&s.store), 1);

    let mut rest = text.as_bytes()[starts[0]..starts[2]].to_vec();
    rest.extend(b"\n\x80\n");
    append_at(&path, &rest, T0 + 2_000);
    s.reader.poll(&file, &mut track, T0 + 3_000).expect("poll");
    assert_eq!(track.stats.from_zero, 1);
    let final_bytes = fs::read(&path).expect("read");
    let want = whole_file(&final_bytes, "stars.txt");
    let got = held(&s.store);
    assert_eq!(
        got.hands.keys().collect::<Vec<_>>(),
        want.hands.keys().collect::<Vec<_>>()
    );
}

#[test]
fn a_file_nothing_claims_goes_to_the_registry_once() {
    let s = setup("unknown");
    let bytes = corpus(UNKNOWN);
    let path = s.dir.join("hh/boss.txt");
    let file = FileRef::new(&path);
    let mut track = FileTrack::default();
    write_at(&path, &bytes, T0);
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.quiet_ms)
        .expect("poll");
    assert!(matches!(polled, Polled::Waiting { .. }), "{polled:?}");
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + s.config.give_up_ms)
        .expect("poll");
    assert!(committed(&polled).1 == bytes.len() as u64);
    let registry = s.store.reader().unsupported().expect("registry");
    assert_eq!(registry.len(), 1);
    assert_eq!(registry[0].count, 1);
    assert_eq!(
        Some(registry[0].fingerprint.clone()),
        golden(UNKNOWN).unknown_site
    );

    // More of it: read again (nothing claims the new piece), not counted
    // again.
    append_at(&path, b"\n<more/>\n", T0 + 40_000);
    let polled = s
        .reader
        .poll(&file, &mut track, T0 + 40_000 + s.config.give_up_ms)
        .expect("poll");
    committed(&polled);
    let registry = s.store.reader().unsupported().expect("registry");
    assert_eq!(registry[0].count, 1);
}

/// R1.6: a look at a file that has not changed since it was read to its
/// end decides from the metadata alone and does not open it - also for a
/// file read whole every time (iPoker). On Linux every open is an inotify
/// event; a look that opened an unchanged file woke the watcher for it
/// again, forever, and two such files held the import threads while a
/// backfill waited. Proven by taking read permission away: a look that
/// opened the file would fail.
#[cfg(unix)]
#[test]
fn an_unchanged_file_is_not_opened() {
    use std::os::unix::fs::PermissionsExt;

    let s = setup("unchanged");
    for (name, relative) in [
        (
            "ipoker.xml",
            "fixtures/samples/ipoker/01-basic-hand-pl-omaha-eur.xml",
        ),
        ("stars.txt", STARS),
    ] {
        let path = s.dir.join("hh").join(name);
        write_at(&path, &corpus(relative), T0);
        let file = FileRef::new(&path);
        let mut track = FileTrack::default();
        let later = T0 + 60_000;
        let polled = s.reader.poll(&file, &mut track, later).expect("poll");
        assert!(
            matches!(polled, Polled::Committed { .. }),
            "{name}: {polled:?}"
        );
        if name == "ipoker.xml" {
            assert!(track.whole_file(), "iPoker is read whole");
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("chmod");
        let again = s.reader.poll(&file, &mut track, later + 1_000);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod back");
        assert_eq!(again.expect("not opened"), Polled::Unchanged, "{name}");
    }
}
