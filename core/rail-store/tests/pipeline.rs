//! R1.6 in the store: import batches that wait together commit together
//! (each still whole or not at all), the folder rollups of schema version 4
//! (equal to the rows, carried over from version 3), and "try again after
//! an update" for refusals an older parser version made.

mod common;

use std::fs;
use std::path::Path;
use std::sync::mpsc;

use rail_store::import::{ImportOptions, convert_bytes, path_key, whole_file_batch};
use rail_store::migrate;
use rail_store::{Error, FileState, ParserVersions, Store, import_file};
use rusqlite::Connection;

use common::{PARSED_AT, assert_integrity, corpus_file, scratch_dir, snapshot};

const CHICO: &str =
    "fixtures/samples/chico/fpdb3-regression-corpus/cash__PLO-10max-USD-0.05-0.10-201209.txt";
const BOSSMEDIA: &str = "fixtures/samples/bossmedia/06-allin-showdown.txt";
/// One hand, refused (`truncated-hand`).
const REFUSED: &str = "fixtures/samples/888poker/13-invalid-hand-truncated-flop.txt";
const PARTY: &str = "fixtures/samples/partypoker/14-multiple-hands-concatenated.txt";

fn options(source_id: Option<i64>) -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id,
    }
}

/// The parsers of this build with their versions.
fn current_versions() -> ParserVersions {
    ParserVersions::new(
        rail_core::parsers::builtin()
            .parsers()
            .map(|parser| (parser.id(), parser.version())),
    )
}

fn copy_into(folder: &Path, name: &str, corpus: &str) -> std::path::PathBuf {
    fs::create_dir_all(folder).expect("folder");
    let path = folder.join(name);
    fs::copy(corpus_file(corpus), &path).expect("copy");
    path
}

/// Batches queued while the writer is busy are committed in one
/// transaction; a stale one among them is refused alone and the others are
/// stored, exactly as if each had been sent on its own.
#[test]
fn queued_batches_commit_together_and_each_is_whole() {
    let dir = scratch_dir("group");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let writer = store.writer().expect("writer");
    let a = copy_into(&dir, "a.txt", CHICO);
    let b = copy_into(&dir, "b.txt", BOSSMEDIA);
    let c = copy_into(&dir, "c.txt", PARTY);

    // Hold the writer so the three batches wait in its queue together.
    let (release, held) = mpsc::channel::<()>();
    let (started, running) = mpsc::channel::<()>();
    let blocker = {
        let writer = writer.clone();
        std::thread::spawn(move || {
            writer
                .write(move |_| {
                    started.send(()).expect("started");
                    held.recv().expect("release");
                    Ok(())
                })
                .expect("held write");
        })
    };
    running.recv().expect("the writer is held");

    let first = writer
        .import_async(whole_file_batch(&a, &options(None)).expect("a"))
        .expect("queue a");
    // b, read "from" an offset the store does not have: stale.
    let bytes = fs::read(&b).expect("b");
    let size = u64::try_from(bytes.len()).expect("size");
    let stale = convert_bytes(
        FileState {
            path: path_key(&b),
            source_id: None,
            from_offset: 7,
            to_offset: size,
            size,
            mtime_ms: None,
            encoding: None,
            site: None,
            last_error: None,
        },
        &b,
        &bytes,
        &options(None),
    )
    .expect("b");
    let second = writer.import_async(stale).expect("queue b");
    let third = writer
        .import_async(whole_file_batch(&c, &options(None)).expect("c"))
        .expect("queue c");
    release.send(()).expect("release");
    blocker.join().expect("blocker");

    let first = first.wait().expect("a is stored");
    assert!(first.inserted > 0);
    assert!(matches!(
        second.wait(),
        Err(Error::OffsetMismatch {
            stored: 0,
            batch_from: 7,
            ..
        })
    ));
    let third = third.wait().expect("c is stored");
    assert!(third.inserted > 0);

    let conn = Connection::open(store.path()).expect("open");
    assert_integrity(&conn);
    let snap = snapshot(&conn);
    assert_eq!(snap.files.len(), 2, "b wrote nothing");
    assert!(!snap.files.contains_key(&path_key(&b)));

    // The same three on their own give the same store.
    let alone = Store::open(dir.join("alone.db")).expect("open");
    import_file(&alone, &a, &options(None)).expect("a");
    import_file(&alone, &c, &options(None)).expect("c");
    let mut expected = snapshot(&Connection::open(alone.path()).expect("open"));
    let mut actual = snap;
    // `files` rows carry no time; hands and quarantine are compared whole.
    expected.files.clear();
    actual.files.clear();
    assert_eq!(actual, expected);
}

/// The rollups equal the rows after imports into two folders, a quarantine
/// row, a move of a file between folders and a folder removed; "hands
/// today" is the folder's hands stored today.
#[test]
fn folder_rollups_equal_the_rows() {
    let dir = scratch_dir("rollups");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let writer = store.writer().expect("writer");
    let one = dir.join("one");
    let two = dir.join("two");
    let id_one = store.add_source(&path_key(&one), true, None).expect("one");
    let id_two = store.add_source(&path_key(&two), true, None).expect("two");
    for (folder, id, name, corpus) in [
        (&one, id_one, "chico.txt", CHICO),
        (&one, id_one, "refused.txt", REFUSED),
        (&two, id_two, "party.txt", PARTY),
        // The same hands again: duplicates, counted for the first file only.
        (&two, id_two, "chico-again.txt", CHICO),
    ] {
        let path = copy_into(folder, name, corpus);
        import_file(&store, &path, &options(Some(id))).expect("import");
    }
    let check = |label: &str| {
        let rollups = store.reader().sources().expect("sources");
        let recounted = store.reader().sources_recounted().expect("recount");
        assert_eq!(rollups.len(), recounted.len(), "{label}");
        for (rollup, counted) in rollups.iter().zip(&recounted) {
            assert_eq!(rollup.id, counted.id, "{label}");
            assert_eq!(
                (
                    rollup.files,
                    rollup.hands,
                    rollup.quarantined,
                    rollup.hands_today
                ),
                (
                    counted.files,
                    counted.hands,
                    counted.quarantined,
                    counted.hands_today
                ),
                "{label}: folder {}",
                rollup.id
            );
        }
        assert_integrity(&Connection::open(store.path()).expect("open"));
        rollups
    };
    let before = check("imported");
    // The Chico file: 4 hands and 13 refusals; the 888 file: 1 refusal.
    let first = before.iter().find(|s| s.id == id_one).expect("one");
    assert_eq!((first.files, first.hands, first.quarantined), (2, 4, 14));
    assert_eq!(first.hands_today, 4);
    assert!(first.last_import_at.is_some());
    let second = before.iter().find(|s| s.id == id_two).expect("two");
    let party_hands = store
        .reader()
        .source_files(id_two)
        .expect("files")
        .iter()
        .find(|file| file.path.ends_with("party.txt"))
        .expect("party")
        .hands;
    assert_eq!(
        (second.files, second.hands),
        (2, party_hands),
        "the repeated Chico hands are counted for the first file only"
    );

    // Folder two's path changes and keeps none of its files: detached.
    writer
        .set_source_path(id_two, &path_key(&dir.join("three")), Vec::new())
        .expect("move");
    let after = check("detached");
    let second = after.iter().find(|s| s.id == id_two).expect("two");
    assert_eq!((second.files, second.hands, second.quarantined), (0, 0, 0));

    // A room change resets folder one's refused file with its quarantine.
    writer
        .set_source_site_override(id_one, Some("chico"))
        .expect("override");
    let after = check("override");
    let first = after.iter().find(|s| s.id == id_one).expect("one");
    assert_eq!(first.quarantined, 13, "the 888 file is reset, Chico's stay");

    // Removed: its totals go with it, its files and hands stay.
    assert!(writer.remove_source(id_one).expect("remove"));
    check("removed");
    assert_eq!(
        store.status().expect("status").hands,
        u64::try_from(4 + party_hands).expect("count")
    );
}

/// A version 3 store with folders, files, hands and refusals gets its
/// rollups from the rows when it is migrated to version 4.
#[test]
fn rollups_are_built_from_an_older_store() {
    let dir = scratch_dir("rollups-migrate");
    let path = dir.join("rail.db");
    // Version 3 with data, written by a version 4 store and taken back: the
    // rows are what version 3 holds; the counters are dropped first.
    {
        let store = Store::open(&path).expect("open");
        let folder = dir.join("hh");
        let id = store
            .add_source(&path_key(&folder), true, None)
            .expect("add");
        for (name, corpus) in [("chico.txt", CHICO), ("refused.txt", REFUSED)] {
            let file = copy_into(&folder, name, corpus);
            import_file(&store, &file, &options(Some(id))).expect("import");
        }
        store.close();
    }
    let mut conn = Connection::open(&path).expect("open");
    conn.execute_batch(
        "DROP TABLE hand_list; DROP TABLE hand_notes; DROP TABLE hand_tags;
         DROP TABLE saved_filters;
         DROP TABLE ev_pending; DROP TABLE ev_rows; DROP TABLE hero_rollups;
         DROP TABLE hand_stats;
         DROP TABLE player_rollups; DROP TABLE seat_stats; DROP TABLE segments;
         DELETE FROM kv WHERE key LIKE 'stats.%' OR key LIKE 'ev.%';
         DROP INDEX outbox_recent_idx; DROP INDEX outbox_retry_idx;
         ALTER TABLE outbox DROP COLUMN played_at; DROP TABLE sync_rejected;
         DROP INDEX hands_pulled_idx; ALTER TABLE hands DROP COLUMN pulled_at;
         DROP TRIGGER sources_totals_row; DROP TRIGGER files_totals_insert;
         DROP TRIGGER files_totals_delete; DROP TRIGGER files_totals_update;
         DROP TRIGGER quarantine_count_insert; DROP TRIGGER quarantine_count_delete;
         DROP TABLE source_days; DROP TABLE source_totals;
         DROP INDEX files_source_idx; CREATE INDEX files_source_idx ON files (source_id);
         ALTER TABLE files DROP COLUMN hands; ALTER TABLE files DROP COLUMN quarantined;
         PRAGMA user_version = 3;",
    )
    .expect("back to version 3");
    let applied = migrate::migrate(&mut conn).expect("migrate");
    assert_eq!(applied, (4..=migrate::LATEST).collect::<Vec<_>>());
    assert_integrity(&conn);
    let (files, hands, quarantined): (i64, i64, i64) = conn
        .query_row(
            "SELECT files, hands, quarantined FROM source_totals",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("totals");
    assert_eq!((files, hands, quarantined), (2, 4, 14));
    let today: i64 = conn
        .query_row(
            "SELECT hands FROM source_days WHERE day = date('now', 'localtime')",
            [],
            |row| row.get(0),
        )
        .expect("today");
    assert_eq!(today, 4);
}

/// "Try again after an update": a refusal an older parser version made is
/// found, its file goes back to offset 0 without its quarantine rows; a
/// refusal by today's version, or outside any folder, is left alone.
#[test]
fn stale_refusals_are_read_again() {
    let dir = scratch_dir("stale");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let writer = store.writer().expect("writer");
    let folder = dir.join("hh");
    let id = store
        .add_source(&path_key(&folder), true, None)
        .expect("add");
    let refused = copy_into(&folder, "refused.txt", REFUSED);
    let chico = copy_into(&folder, "chico.txt", CHICO);
    for file in [&refused, &chico] {
        import_file(&store, file, &options(Some(id))).expect("import");
    }
    // Outside any folder: never read again by the watcher, so left alone.
    let loose = copy_into(&dir.join("loose"), "refused.txt", REFUSED);
    import_file(&store, &loose, &options(None)).expect("loose");
    let versions = current_versions();
    let none = store
        .reader()
        .stale_refusals(&versions, None)
        .expect("stale");
    assert_eq!(
        (none.hands, none.files),
        (0, 0),
        "today's version refused it"
    );

    // As if an older build had refused the 888 hands (Chico's 13 refusals
    // stay today's).
    let conn = Connection::open(store.path()).expect("open");
    conn.execute(
        "UPDATE quarantine SET parser_version = '0.0.1'
         WHERE file_id IN (SELECT id FROM files WHERE path LIKE '%refused.txt')",
        [],
    )
    .expect("older");
    let stale = store
        .reader()
        .stale_refusals(&versions, None)
        .expect("stale");
    assert_eq!((stale.hands, stale.files), (1, 1));
    let other_folder = store
        .reader()
        .stale_refusals(&versions, Some(id + 1))
        .expect("stale");
    assert_eq!(other_folder.files, 0);

    let reset = writer
        .reset_stale_refusals(&versions, Some(id))
        .expect("reset");
    assert_eq!(reset.len(), 1);
    assert_eq!(reset[0].path, path_key(&refused));
    assert_eq!(reset[0].source_id, id);
    let state = store
        .reader()
        .file_state(&path_key(&refused))
        .expect("state")
        .expect("row");
    assert_eq!((state.read_offset, state.size), (0, 0));
    let chico_state = store
        .reader()
        .file_state(&path_key(&chico))
        .expect("state")
        .expect("row");
    assert!(chico_state.read_offset > 0, "a file without refusals stays");
    assert_eq!(
        store.status().expect("status").quarantined,
        14,
        "Chico's and the loose one"
    );
    assert_integrity(&conn);

    // Read again with today's parser: refused again, by today's version.
    import_file(&store, &refused, &options(Some(id))).expect("again");
    let again = store
        .reader()
        .stale_refusals(&versions, None)
        .expect("stale");
    assert_eq!(again.files, 0);
    let rows = store
        .reader()
        .quarantine_filtered(Some(id), Some("truncated-hand"), 10)
        .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(
        store
            .reader()
            .quarantine_filtered(None, Some("truncated-hand"), 10)
            .expect("list")
            .len(),
        2
    );
    assert!(
        store
            .reader()
            .quarantine_raw_text(rows[0].id)
            .expect("raw")
            .is_some_and(|text| !text.is_empty())
    );
}

#[test]
fn parser_versions_are_a_json_object() {
    let versions = ParserVersions::new([("a", "1.0"), ("q\"uote", "back\\slash")]);
    assert_eq!(versions.as_json(), r#"{"a":"1.0","q\"uote":"back\\slash"}"#);
    let conn = Connection::open_in_memory().expect("memory");
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM json_each(?1)",
            [versions.as_json()],
            |row| row.get(0),
        )
        .expect("json_each");
    assert_eq!(n, 2);
}
