//! The store's behaviour: migrations, pragmas, import, dedupe, the offset
//! rule, quarantine, the registry, the outbox and the queries.

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use rail_store::import::{ImportOptions, convert_bytes, path_key};
use rail_store::migrate::{self, LATEST, MIGRATIONS};
use rail_store::{Error, FileImport, FileState, Store, import_file};
use rusqlite::Connection;

use common::{PARSED_AT, assert_integrity, corpus_file, scratch_dir, snapshot};

const CHICO: &str =
    "fixtures/samples/chico/fpdb3-regression-corpus/cash__PLO-10max-USD-0.05-0.10-201209.txt";
const BOSSMEDIA: &str = "fixtures/samples/bossmedia/06-allin-showdown.txt";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

fn imported(result: FileImport) -> rail_store::ImportOutcome {
    match result {
        FileImport::Imported(outcome) => outcome,
        FileImport::Unchanged => panic!("expected an import"),
    }
}

/// The schema as SQLite records it: every table, index and trigger.
fn schema(conn: &Connection) -> Vec<(String, String, String)> {
    conn.prepare(
        "SELECT type, name, coalesce(sql, '') FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .expect("prepare")
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
    .expect("query")
    .collect::<Result<_, _>>()
    .expect("rows")
}

#[test]
fn migrations_are_numbered_and_named_in_order() {
    assert_eq!(usize::try_from(LATEST).ok(), Some(MIGRATIONS.len()));
    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let number = format!("{:04}_", index + 1);
        assert!(
            migration.name.starts_with(&number),
            "{} should start with {number}",
            migration.name
        );
        assert!(migration.name.ends_with(".sql"));
    }
}

/// From an empty file and from every earlier version, migrating ends at the
/// same schema; rows written at an earlier version survive.
#[test]
fn migrates_from_empty_and_from_every_earlier_version() {
    let dir = scratch_dir("migrate");
    let mut reference = Connection::open(dir.join("reference.db")).expect("open");
    assert_eq!(migrate::version(&reference).expect("version"), 0);
    let applied = migrate::migrate(&mut reference).expect("migrate");
    assert_eq!(applied, (1..=LATEST).collect::<Vec<_>>());
    assert_eq!(migrate::version(&reference).expect("version"), LATEST);
    let expected = schema(&reference);
    assert!(expected.iter().any(|(_, name, _)| name == "hands"));

    for start in 0..=LATEST {
        let mut conn = Connection::open(dir.join(format!("from-{start}.db"))).expect("open");
        migrate::migrate_to(&mut conn, start).expect("migrate_to");
        assert_eq!(migrate::version(&conn).expect("version"), start);
        if start >= 1 {
            // A row every version since 1 has: it must survive.
            conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('probe', 'kept', 1)",
                [],
            )
            .expect("insert at version 1+");
        }
        let applied = migrate::migrate(&mut conn).expect("migrate");
        assert_eq!(applied, (start + 1..=LATEST).collect::<Vec<_>>());
        assert_eq!(schema(&conn), expected, "schema from version {start}");
        if start >= 1 {
            let value: String = conn
                .query_row("SELECT value FROM kv WHERE key = 'probe'", [], |row| {
                    row.get(0)
                })
                .expect("probe");
            assert_eq!(value, "kept");
        }
        // Idempotent.
        assert!(migrate::migrate(&mut conn).expect("again").is_empty());
    }
}

#[test]
fn a_newer_schema_is_refused_untouched() {
    let dir = scratch_dir("newer");
    let path = dir.join("rail.db");
    {
        let conn = Connection::open(&path).expect("open");
        conn.pragma_update(None, "user_version", LATEST + 1)
            .expect("bump");
    }
    match Store::open(&path) {
        Err(Error::NewerSchema { found, known }) => {
            assert_eq!((found, known), (LATEST + 1, LATEST));
        }
        other => panic!("expected NewerSchema, got {other:?}"),
    }
    let conn = Connection::open(&path).expect("open");
    assert!(schema(&conn).is_empty(), "nothing was created");
}

#[test]
fn opens_with_wal_normal_sync_and_foreign_keys() {
    let dir = scratch_dir("pragmas");
    let store = Store::open(dir.join("nested/rail.db")).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal_mode");
    assert_eq!(mode, "wal");
    // `synchronous` and `foreign_keys` are per connection: the writer's own.
    let (sync, fk) = store
        .writer()
        .expect("writer")
        .write(|tx| {
            let sync: i64 = tx.query_row("PRAGMA synchronous", [], |row| row.get(0))?;
            let fk: i64 = tx.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
            Ok((sync, fk))
        })
        .expect("pragmas");
    assert_eq!(
        (sync, fk),
        (1, 1),
        "synchronous = NORMAL, foreign_keys = ON"
    );
    assert_eq!(store.status().expect("status").schema_version, LATEST);
    store.close();
    // Reopening a current store applies nothing and keeps working.
    let store = Store::open(dir.join("nested/rail.db")).expect("reopen");
    assert_eq!(store.status().expect("status").hands, 0);
}

#[test]
fn imports_a_file_once_and_dedupes_its_copy() {
    let dir = scratch_dir("dedupe");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let source = corpus_file(CHICO);

    let first = imported(import_file(&store, &source, &options()).expect("import"));
    assert_eq!((first.inserted, first.duplicates), (4, 0));
    assert_eq!(first.quarantined, 13);
    assert!(!first.unrecognized);

    // Unchanged: nothing read.
    assert_eq!(
        import_file(&store, &source, &options()).expect("again"),
        FileImport::Unchanged
    );

    // The same bytes under another name: every hand is a duplicate, and
    // its refusals are that file's own.
    let copy = dir.join("copy.txt");
    fs::copy(&source, &copy).expect("copy");
    let second = imported(import_file(&store, &copy, &options()).expect("copy import"));
    assert_eq!((second.inserted, second.duplicates), (0, 4));
    assert_eq!(second.quarantined, 13);

    let status = store.status().expect("status");
    assert_eq!(status.hands, 4);
    assert_eq!(status.hands_today, 4);
    assert_eq!(status.outbox, 4);
    assert_eq!(status.files, 2);
    assert_eq!(status.quarantined, 26);
    assert_eq!(
        store
            .reader()
            .hands_imported_since(rail_store::time::now_ms() + 60_000)
            .expect("since"),
        0
    );

    // A changed file (here: appended to) is read again from the start;
    // dedupe keeps the hands once and the quarantine is refreshed, not
    // doubled.
    let mut bytes = fs::read(&copy).expect("read");
    bytes.extend_from_slice(b"\n\n");
    fs::write(&copy, &bytes).expect("append");
    let third = imported(import_file(&store, &copy, &options()).expect("re-read"));
    assert_eq!((third.inserted, third.duplicates), (0, 4));
    let status = store.status().expect("status");
    assert_eq!((status.hands, status.quarantined), (4, 26));
    let stored = store
        .reader()
        .file_state(&path_key(&copy))
        .expect("state")
        .expect("row");
    assert_eq!(
        u64::try_from(stored.read_offset).ok(),
        Some(bytes.len() as u64)
    );

    let files = store.reader().files().expect("files");
    assert_eq!(files.len(), 2);
    assert_eq!(files.iter().map(|f| f.hands).sum::<i64>(), 4);
    assert!(files.iter().all(|f| f.site.as_deref() == Some("chico")));

    let reasons = store.reader().quarantine_reasons().expect("reasons");
    assert_eq!(reasons.iter().map(|(_, n)| n).sum::<i64>(), 26);
    let listed = store.reader().quarantine(100).expect("quarantine");
    assert_eq!(listed.len(), 26);
    let raw = store
        .reader()
        .quarantine_raw_text(listed[0].id)
        .expect("raw")
        .expect("present");
    assert!(!raw.is_empty());

    let conn = Connection::open(store.path()).expect("open");
    assert_integrity(&conn);
}

/// The stored PHF is the canonical JSON of the hand the core produced.
#[test]
fn stores_the_canonical_phf_compressed() {
    let dir = scratch_dir("phf");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let source = corpus_file(CHICO);
    let bytes = fs::read(&source).expect("read");
    let conversion = rail_core::convert::convert_file(
        &bytes,
        &rail_core::detect::ConvertOptions {
            source_filename: Some("cash__PLO-10max-USD-0.05-0.10-201209.txt".to_owned()),
            parsed_at: PARSED_AT.to_owned(),
            ..Default::default()
        },
    );
    import_file(&store, &source, &options()).expect("import");
    let hands = &conversion
        .result
        .as_ref()
        .expect("result")
        .as_ref()
        .expect("ok")
        .hands;
    assert_eq!(hands.len(), 4);
    for converted in hands {
        let key = rail_store::batch::hand_key_of(&converted.hand);
        assert!(key.starts_with("chico:"), "{key}");
        let stored = store
            .reader()
            .hand_phf(&key)
            .expect("read")
            .expect("stored");
        let canonical =
            rail_core::canonical::to_canonical_json(&converted.hand).expect("canonical");
        assert_eq!(stored, canonical);
    }
    let conn = Connection::open(store.path()).expect("open");
    let (raw, packed): (i64, i64) = conn
        .query_row(
            "SELECT sum(phf_size), sum(length(phf)) FROM hands",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("sizes");
    assert!(packed * 3 < raw, "zstd: {packed} of {raw} bytes");
}

/// A batch from an offset the store is not at is refused whole.
#[test]
fn a_stale_batch_is_refused_and_writes_nothing() {
    let dir = scratch_dir("offset");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let source = corpus_file(CHICO);
    let bytes = fs::read(&source).expect("read");
    let size = bytes.len() as u64;
    let state = |from| FileState {
        path: path_key(&source),
        source_id: None,
        from_offset: from,
        to_offset: size,
        size,
        mtime_ms: None,
        encoding: None,
        site: None,
        last_error: None,
    };
    let batch = convert_bytes(state(10), &source, &bytes, &options()).expect("convert");
    match store.import(batch) {
        Err(Error::OffsetMismatch {
            stored, batch_from, ..
        }) => assert_eq!((stored, batch_from), (0, 10)),
        other => panic!("expected OffsetMismatch, got {other:?}"),
    }
    let status = store.status().expect("status");
    assert_eq!((status.hands, status.files, status.quarantined), (0, 0, 0));

    // From 0 is always accepted; then from the stored offset.
    let batch = convert_bytes(state(0), &source, &bytes, &options()).expect("convert");
    store.import(batch).expect("from 0");
    let batch = convert_bytes(state(size), &source, &[], &options()).expect("convert");
    let outcome = store.import(batch).expect("from the stored offset");
    assert_eq!(outcome.inserted, 0);
    let batch = convert_bytes(state(size - 1), &source, &bytes, &options()).expect("convert");
    assert!(matches!(
        store.import(batch),
        Err(Error::OffsetMismatch { .. })
    ));
}

/// A file no parser claims goes to the registry once; a repeat bumps the
/// count; consent comes before a send.
#[test]
fn unrecognised_files_go_to_the_registry() {
    let dir = scratch_dir("registry");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let source = corpus_file(BOSSMEDIA);
    let outcome = imported(import_file(&store, &source, &options()).expect("import"));
    assert!(outcome.unrecognized);
    assert_eq!((outcome.inserted, outcome.quarantined), (0, 0));

    let entries = store.reader().unsupported().expect("registry");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.count, 1);
    assert_eq!(entry.guessed_site.as_deref(), Some("bossmedia"));
    assert_eq!(entry.guess_basis.as_deref(), Some("known-format"));
    assert_eq!(entry.confidence, 1000);
    assert_eq!(entry.file_path, path_key(&source));
    assert!(!entry.header_sample.is_empty());
    assert_eq!(entry.consented_at, None);

    // Seen again (unchanged: not read, not counted).
    assert_eq!(
        import_file(&store, &source, &options()).expect("again"),
        FileImport::Unchanged
    );
    let copy = dir.join("copy.txt");
    fs::copy(&source, &copy).expect("copy");
    import_file(&store, &copy, &options()).expect("copy");
    let entries = store.reader().unsupported().expect("registry");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].count, 2);
    assert_eq!(entries[0].file_path, path_key(&copy));

    // No send without consent (the table's check).
    let fingerprint = entries[0].fingerprint.clone();
    assert!(
        store
            .unsupported_mark_sent(&fingerprint, 5, rail_core::anonymise::ANONYMISER_VERSION)
            .is_err()
    );
    assert!(store.unsupported_consent(&fingerprint, 4).expect("consent"));
    assert!(
        store
            .unsupported_mark_sent(&fingerprint, 5, rail_core::anonymise::ANONYMISER_VERSION)
            .expect("sent")
    );
    let entry = &store.reader().unsupported().expect("registry")[0];
    assert_eq!((entry.consented_at, entry.sent_at), (Some(4), Some(5)));
    assert_eq!(
        entry.anonymiser_version.as_deref(),
        Some(rail_core::anonymise::ANONYMISER_VERSION)
    );
    assert_eq!(store.status().expect("status").unsupported, 1);
}

#[test]
fn the_outbox_hands_out_due_batches_and_forgets_sent_hands() {
    let dir = scratch_dir("outbox");
    let store = Store::open(dir.join("rail.db")).expect("open");
    import_file(&store, &corpus_file(CHICO), &options()).expect("import");
    let now = rail_store::time::now_ms();

    let due = store.reader().outbox_due(now, 3).expect("due");
    assert_eq!(due.len(), 3);
    assert!(due.iter().all(|item| item.attempts == 0));
    assert!(due.iter().all(|item| item.phf.starts_with('{')));

    let failed: Vec<String> = due.iter().map(|item| item.hand_key.clone()).collect();
    store
        .outbox_mark_failed(failed.clone(), "network down", now + 60_000)
        .expect("failed");
    let due = store.reader().outbox_due(now, 10).expect("due");
    assert_eq!(due.len(), 1, "the failed three wait for their next attempt");
    let later = store.reader().outbox_due(now + 60_000, 10).expect("later");
    assert_eq!(later.len(), 4);
    let retried = later
        .iter()
        .find(|item| item.hand_key == failed[0])
        .expect("retried");
    assert_eq!(retried.attempts, 1);
    assert_eq!(retried.last_error.as_deref(), Some("network down"));

    let keys: Vec<String> = later.iter().map(|item| item.hand_key.clone()).collect();
    assert_eq!(store.outbox_mark_sent(keys, now).expect("sent"), 4);
    assert_eq!(store.status().expect("status").outbox, 0);
    let conn = Connection::open(store.path()).expect("open");
    let synced: i64 = conn
        .query_row(
            "SELECT count(*) FROM hands WHERE synced_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("synced");
    assert_eq!(synced, 4);
}

#[test]
fn sources_and_kv() {
    let dir = scratch_dir("sources");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let folder = path_key(Path::new(&dir));
    let id = store.add_source(&folder, true, None).expect("add");
    assert_eq!(store.add_source(&folder, true, None).expect("again"), id);

    let copy = dir.join("hands.txt");
    fs::copy(corpus_file(CHICO), &copy).expect("copy");
    import_file(
        &store,
        &copy,
        &ImportOptions {
            parsed_at: Some(PARSED_AT.to_owned()),
            source_id: Some(id),
        },
    )
    .expect("import");
    let sources = store.reader().sources().expect("sources");
    assert_eq!(sources.len(), 1);
    let source = &sources[0];
    assert_eq!(
        (
            source.files,
            source.hands,
            source.hands_today,
            source.quarantined
        ),
        (1, 4, 4, 13)
    );
    assert!(source.enabled && source.recursive);

    // The watcher's writes (R1.3).
    let writer = store.writer().expect("writer");
    assert!(writer.set_source_poll_only(id, true).expect("poll only"));
    assert!(writer.set_source_enabled(id, false).expect("disable"));
    writer
        .set_source_status(id, "unavailable", Some("gone"))
        .expect("status");
    // Discovery's room (R1.4).
    assert_eq!(store.reader().sources().expect("sources")[0].site, None);
    assert!(writer.set_source_site(id, Some("weplay")).expect("site"));
    assert!(
        !writer
            .set_source_site(id + 100, None)
            .expect("no such folder")
    );
    let source = &store.reader().sources().expect("sources")[0];
    assert!(source.poll_only && !source.enabled);
    assert_eq!(source.site.as_deref(), Some("weplay"));
    assert_eq!(
        (source.status.as_str(), source.last_error.as_deref()),
        ("unavailable", Some("gone"))
    );
    assert!(
        !writer
            .set_source_enabled(id + 100, true)
            .expect("no such folder")
    );
    let other = writer
        .add_source("/elsewhere", false, None, true)
        .expect("add");
    assert!(writer.remove_source(id).expect("remove"));
    assert!(!writer.remove_source(id).expect("removed already"));
    let sources = store.reader().sources().expect("sources");
    assert_eq!(sources.len(), 1);
    assert_eq!((sources[0].id, sources[0].poll_only), (other, true));
    // The removed folder's file and hands stay, without a folder.
    let files = store.reader().files().expect("files");
    assert_eq!((files[0].source_id, files[0].hands), (None, 4));

    store.set_kv("sync.cursor", "abc").expect("set");
    store.set_kv("sync.cursor", "def").expect("set again");
    assert_eq!(
        store.reader().kv("sync.cursor").expect("kv").as_deref(),
        Some("def")
    );
    assert_eq!(store.reader().kv("missing").expect("kv"), None);
}

/// Not text: the file is recorded with its error and its offset at the end,
/// so it is not read again until it changes.
#[test]
fn an_unreadable_file_is_recorded_with_its_error() {
    let dir = scratch_dir("binary");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let path = dir.join("noise.txt");
    fs::write(&path, (0u8..=255).cycle().take(4096).collect::<Vec<_>>()).expect("write");
    let outcome = imported(import_file(&store, &path, &options()).expect("import"));
    assert_eq!(outcome.inserted, 0);
    let files = store.reader().files().expect("files");
    assert!(
        files[0]
            .last_error
            .as_deref()
            .is_some_and(|error| error.starts_with("not readable as text")),
        "{:?}",
        files[0].last_error
    );
    assert_eq!(store.status().expect("status").files_with_errors, 1);
    assert_eq!(
        import_file(&store, &path, &options()).expect("again"),
        FileImport::Unchanged
    );
}

/// Readers see committed data while the writer works, from other threads.
#[test]
fn readers_and_writer_from_many_threads() {
    let dir = scratch_dir("threads");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let files: Vec<_> = common::corpus_files().into_iter().take(40).collect();
    std::thread::scope(|scope| {
        for chunk in files.chunks(10) {
            let store = &store;
            scope.spawn(move || {
                for path in chunk {
                    import_file(store, path, &options()).expect("import");
                    store.status().expect("status");
                }
            });
        }
    });
    let conn = Connection::open(store.path()).expect("open");
    assert_integrity(&conn);
    let snap = snapshot(&conn);
    assert_eq!(snap.files.len(), 40);
    assert_eq!(
        snap.outbox,
        snap.hands.keys().cloned().collect::<BTreeSet<_>>()
    );
}
