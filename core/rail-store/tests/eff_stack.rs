//! The hero's effective stack on the Hands list (docs/ANALYTICS.md Step 11,
//! schema 29): written with every list row from the PHF
//! (`facts::derive`), filled for the rows stored before by the background
//! pass (`eff_stack::backfill_step`, idempotent), and read by the Effective
//! stack chips (`HandFilter::eff_stacks`) - the list, its counts and a report
//! over the list's hands alike. The values are the pinned hands' of
//! `core/rail-stats/tests/data/effective-stack/expected.json` (the web's
//! twin reads the same file).

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use rail_store::eff_stack::{DONE, KV_AFTER, backfill_step};
use rail_store::hand_list::HandFilter;
use rail_store::import::ImportOptions;
use rail_store::{Store, background, import_file};
use rusqlite::Connection;
use serde_json::Value;

use common::{PARSED_AT, repo_root, scratch_dir};

/// The fixture store and, per hand key, its expected tenths and bucket.
fn fixture_store(name: &str) -> (PathBuf, Store, BTreeMap<String, (i64, String)>) {
    let path = scratch_dir(name).join("rail.db");
    let store = Store::open(&path).expect("open");
    let expected: Value = serde_json::from_str(
        &fs::read_to_string(
            repo_root().join("core/rail-stats/tests/data/effective-stack/expected.json"),
        )
        .expect("expected.json"),
    )
    .expect("json");
    let options = ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    };
    let conn = Connection::open(&path).expect("open");
    let mut keys = BTreeMap::new();
    for case in expected["cases"].as_array().expect("cases") {
        import_file(
            &store,
            &repo_root().join(case["file"].as_str().expect("file")),
            &options,
        )
        .expect("import");
        let key: String = conn
            .query_row(
                "SELECT hand_key FROM hands ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("hand key");
        let tenths = case["thousandths"].as_i64().expect("thousandths") / 100;
        keys.insert(
            key,
            (tenths, case["bucket"].as_str().expect("bucket").to_owned()),
        );
    }
    (path, store, keys)
}

fn stored(conn: &Connection) -> BTreeMap<String, Option<i64>> {
    conn.prepare("SELECT hand_key, eff_stack_tenths FROM hand_list")
        .expect("prepare")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("query")
        .collect::<rusqlite::Result<_>>()
        .expect("rows")
}

fn listed(store: &Store, filter: &HandFilter) -> Vec<String> {
    let mut keys: Vec<String> = store
        .reader()
        .hand_page(filter, None, 500)
        .expect("page")
        .rows
        .into_iter()
        .map(|row| row.hand_key)
        .collect();
    keys.sort();
    keys
}

fn drain(store: &Store) -> background::Drained {
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain")
}

#[test]
fn every_list_row_is_written_with_its_effective_stack() {
    let (path, store, keys) = fixture_store("eff-stack-written");
    let conn = Connection::open(&path).expect("open");
    let want: BTreeMap<String, Option<i64>> = keys
        .iter()
        .map(|(key, (tenths, _))| (key.clone(), Some(*tenths)))
        .collect();
    assert_eq!(stored(&conn), want);
    // A new store has nothing to fill: the pass ends at once.
    drain(&store);
    let after: String = conn
        .query_row("SELECT value FROM kv WHERE key = ?1", [KV_AFTER], |r| {
            r.get(0)
        })
        .expect("kv");
    assert_eq!(after, DONE);
    assert_eq!(stored(&conn), want);
}

#[test]
fn the_chips_filter_the_list_and_its_counts() {
    let (_path, store, keys) = fixture_store("eff-stack-filter");
    let mut by_bucket: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (key, (_, bucket)) in &keys {
        by_bucket
            .entry(bucket.clone())
            .or_default()
            .push(key.clone());
    }
    assert!(
        by_bucket.len() >= 3,
        "the fixture spans buckets: {by_bucket:?}"
    );
    for (bucket, want) in &by_bucket {
        let filter = HandFilter {
            eff_stacks: vec![bucket.clone()],
            ..HandFilter::default()
        };
        assert_eq!(&listed(&store, &filter), want, "{bucket}");
        let facets = store.reader().hand_facets(&filter).expect("facets");
        assert_eq!(
            facets.total,
            u64::try_from(want.len()).expect("n"),
            "{bucket}: count"
        );
        assert!(filter.beyond_rollups(), "a report reads the list's hands");
    }
    // Several chips: any of them.
    let two = HandFilter {
        eff_stacks: vec!["40-80".to_owned(), "120+".to_owned()],
        ..HandFilter::default()
    };
    let mut want: Vec<String> = by_bucket["40-80"]
        .iter()
        .chain(&by_bucket["120+"])
        .cloned()
        .collect();
    want.sort();
    assert_eq!(listed(&store, &two), want);
    // An id that is no bucket matches nothing.
    let none = HandFilter {
        eff_stacks: vec!["90-95".to_owned()],
        ..HandFilter::default()
    };
    assert!(listed(&store, &none).is_empty());
    // No chip: every hand.
    let all = HandFilter::default();
    assert_eq!(listed(&store, &all).len(), keys.len());
}

#[test]
fn the_background_pass_fills_rows_stored_before_and_is_idempotent() {
    let (path, store, keys) = fixture_store("eff-stack-backfill");
    let conn = Connection::open(&path).expect("open");
    let want = stored(&conn);
    assert_eq!(want.len(), keys.len());
    // As a store migrated to schema 29 finds them: the column empty, the
    // fill at its start.
    conn.execute("UPDATE hand_list SET eff_stack_tenths = NULL", [])
        .expect("empty");
    conn.execute("UPDATE kv SET value = '' WHERE key = ?1", [KV_AFTER])
        .expect("restart");
    let drained = drain(&store);
    assert_eq!(drained.stacked, keys.len());
    assert_eq!(stored(&conn), want);
    // Done: nothing more to do.
    assert_eq!(
        backfill_step(store.reader(), &store.writer().expect("writer")).expect("step"),
        None
    );
    // Run again from the start: the same numbers.
    conn.execute("UPDATE kv SET value = '' WHERE key = ?1", [KV_AFTER])
        .expect("restart");
    assert_eq!(drain(&store).stacked, keys.len());
    assert_eq!(stored(&conn), want);
}
