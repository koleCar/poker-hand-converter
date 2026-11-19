//! Deleting hands (store version 26): a selection takes every sum back
//! exactly - the rollups, the list, the players' index, the custom
//! statistics, the folder counters - while a recompute runs too; every hand
//! goes in bulk; a deleted hand is never imported again, and a pulled one
//! only once its server copy's deletion is done.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_core::phf::PhfHand;
use rail_stats::custom::CustomDef;
use rail_store::batch::decompress_phf;
use rail_store::custom::{reset_custom_counts, save_custom_stat};
use rail_store::import::{ImportOptions, path_key};
use rail_store::{PreparedHand, Store, background, import_file};
use rusqlite::Connection;

use common::{PARSED_AT, assert_integrity, corpus_files, scratch_dir, table_rows};

const VPIP: &str = "any street = preflop and not bomb_pot and not (walk and big_blind) \
                    => action in (call, bet, raise)";

fn text(value: &str) -> Text {
    Text {
        en: value.to_owned(),
        hr: value.to_owned(),
    }
}

fn my_vpip() -> CustomDef {
    CustomDef {
        def: StatDef {
            id: "my_vpip".to_owned(),
            group: Group::Preflop,
            players: Players::Any,
            label: text("L"),
            name: text("N"),
            description: text("D"),
            formula: "pct(my_vpip, my_vpip_opp)".to_owned(),
            format: Format {
                unit: Unit::Percent,
                decimals: 1,
            },
            sample: SampleDef { of: None, min: 50 },
            bands: Vec::new(),
            hud: HudPlace::None,
        },
        predicate: Some(VPIP.to_owned()),
    }
}

/// The corpus in a watched folder, a custom statistic counted, the
/// players' index done: imported once per test binary.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let dir = scratch_dir("delete-corpus");
        let path = dir.join("corpus.db");
        let store = Store::open(&path).expect("open");
        let folder = path_key(&common::repo_root());
        let source = store.add_source(&folder, true, None).expect("folder");
        for file in corpus_files() {
            import_file(
                &store,
                &file,
                &ImportOptions {
                    parsed_at: Some(PARSED_AT.to_owned()),
                    source_id: Some(source),
                },
            )
            .expect("import");
        }
        let def = my_vpip();
        store
            .writer()
            .expect("writer")
            .write(move |tx| save_custom_stat(tx, None, &def, 1))
            .expect("save");
        drain(&store);
        store.close();
        path
    })
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

fn drain(store: &Store) {
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect(sql)
}

const CUSTOM_TABLES: [&str; 4] = [
    "custom_hero_rows",
    "custom_hero_rollups",
    "custom_player_rollups",
    "custom_player_rollups_observed",
];

/// The custom statistics' tables, as rows of text.
fn custom_tables(conn: &Connection) -> BTreeMap<&'static str, Vec<String>> {
    CUSTOM_TABLES
        .iter()
        .map(|table| (*table, table_rows(conn, table)))
        .collect()
}

/// `source_days` against the hands it counts.
fn assert_folder_days(conn: &Connection) {
    let off = count(
        conn,
        "SELECT count(*) FROM (
           SELECT f.source_id, date(h.imported_at / 1000, 'unixepoch', 'localtime') AS day,
                  count(*) AS n
           FROM hands h JOIN files f ON f.id = h.file_id WHERE f.source_id IS NOT NULL
           GROUP BY 1, 2) x
         FULL JOIN source_days d ON d.source_id = x.source_id AND d.day = x.day
         WHERE x.n IS NOT d.hands",
    );
    assert_eq!(off, 0, "source_days");
}

/// Every hand of the newest day (they hold the players' newest dates), a
/// hand without a hero, and every seventh hand.
fn a_selection(conn: &Connection) -> Vec<String> {
    conn.prepare(
        "SELECT hand_key FROM hands
         WHERE substr(played_at, 1, 10) = (SELECT max(substr(played_at, 1, 10)) FROM hands)
            OR rowid % 7 = 0
            OR hand_key = (SELECT hand_key FROM hands WHERE hero_seat IS NULL LIMIT 1)
         ORDER BY rowid",
    )
    .expect("prepare")
    .query_map([], |row| row.get(0))
    .expect("query")
    .collect::<Result<_, _>>()
    .expect("keys")
}

#[test]
fn deleting_a_selection_keeps_every_sum_exact() {
    let path = copy_of_corpus("delete-selection");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let before = count(&conn, "SELECT count(*) FROM hands");
    let keys = a_selection(&conn);
    assert!(keys.len() > 50 && keys.len() < usize::try_from(before).expect("n") / 2);
    assert!(count(&conn, "SELECT count(*) FROM custom_hero_rows") > 0);
    assert!(count(&conn, "SELECT count(*) FROM player_hands") > 0);
    // A note and a tag go with their hand.
    let first = keys[0].clone();
    store
        .writer()
        .expect("writer")
        .write(move |tx| {
            rail_store::hand_list::set_note(tx, &first, "a note", 5)?;
            rail_store::hand_list::add_tag(tx, &first, "review", 5)?;
            Ok(())
        })
        .expect("note");

    let writer = store.writer().expect("writer");
    let (half, rest) = keys.split_at(keys.len() / 2);
    let mut deleted = writer.delete_hands(half.to_vec(), 1_000).expect("delete");
    // Unknown keys and keys twice are left alone.
    let mut again = rest.to_vec();
    again.push(rest[0].clone());
    again.push("nowhere:1".to_owned());
    deleted += writer.delete_hands(again, 2_000).expect("delete");
    assert_eq!(deleted, u64::try_from(keys.len()).expect("n"));
    assert_eq!(
        count(&conn, "SELECT count(*) FROM hands"),
        before - i64::try_from(keys.len()).expect("n")
    );
    assert_integrity(&conn);
    assert_folder_days(&conn);
    assert_eq!(count(&conn, "SELECT count(*) FROM hand_notes"), 0);
    assert_eq!(count(&conn, "SELECT count(*) FROM hand_tags"), 0);
    assert_eq!(
        count(&conn, "SELECT count(*) FROM deleted_hands WHERE server = 1"),
        i64::try_from(keys.len()).expect("n")
    );
    assert_eq!(
        store.reader().deletions_owed(10).expect("owed").len(),
        10,
        "owed oldest first"
    );

    // The custom statistics: what a count from the start gives.
    let kept = custom_tables(&conn);
    writer.write(|tx| reset_custom_counts(tx)).expect("reset");
    drain(&store);
    assert_eq!(custom_tables(&conn), kept, "custom counts after the delete");

    // Read again, the corpus brings none of them back.
    let source = count(&conn, "SELECT id FROM sources");
    for file in corpus_files() {
        import_file(
            &store,
            &file,
            &ImportOptions {
                parsed_at: Some(PARSED_AT.to_owned()),
                source_id: Some(source),
            },
        )
        .expect("import");
    }
    assert_eq!(
        count(&conn, "SELECT count(*) FROM hands"),
        before - i64::try_from(keys.len()).expect("n")
    );
    assert_integrity(&conn);
    drop(writer);
    store.close();
}

#[test]
fn a_recompute_running_meanwhile_starts_again() {
    let path = copy_of_corpus("delete-recompute");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    writer
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("rebuild");
    // A page of the job, then a delete of hands it has gone past.
    rail_store::recompute::rows_step(store.reader(), &writer).expect("step");
    let keys: Vec<String> = conn
        .prepare("SELECT hand_key FROM hands ORDER BY rowid LIMIT 40")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("keys");
    assert_eq!(writer.delete_hands(keys, 1).expect("delete"), 40);
    drain(&store);
    assert_integrity(&conn);
    drop(writer);
    store.close();
}

/// A hand as the pull would store it: its stored PHF prepared again.
fn prepared(conn: &Connection, hand_key: &str) -> PreparedHand {
    let (blob, size): (Vec<u8>, i64) = conn
        .query_row(
            "SELECT phf, phf_size FROM hands WHERE hand_key = ?1",
            [hand_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("hand");
    let json = decompress_phf(&blob, u64::try_from(size).expect("size")).expect("phf");
    let hand: PhfHand = serde_json::from_str(&json).expect("PHF");
    PreparedHand::from_phf(&hand).expect("prepare")
}

#[test]
fn deleting_every_hand_empties_the_store_and_keeps_the_folders() {
    let path = copy_of_corpus("delete-all");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let before = count(&conn, "SELECT count(*) FROM hands");
    let files = count(&conn, "SELECT count(*) FROM files");
    let keys: Vec<String> = conn
        .prepare("SELECT hand_key FROM hands ORDER BY rowid LIMIT 2")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("keys");
    let (pulled, owed) = (prepared(&conn, &keys[0]), prepared(&conn, &keys[1]));
    let writer = store.writer().expect("writer");
    assert_eq!(
        writer.delete_all_hands(5, true).expect("delete all"),
        u64::try_from(before).expect("n")
    );
    for table in [
        "hands",
        "hand_stats",
        "seat_stats",
        "hand_list",
        "player_hands",
        "player_rollups",
        "player_rollups_observed",
        "hero_rollups",
        "player_summary",
        "player_hidden",
        "outbox",
        "source_days",
        "custom_hero_rows",
        "custom_player_rollups",
    ] {
        assert_eq!(
            count(&conn, &format!("SELECT count(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    assert_eq!(count(&conn, "SELECT count(*) FROM files"), files);
    assert_eq!(count(&conn, "SELECT count(*) FROM deleted_hands"), before);
    assert_eq!(
        store.reader().server_wipe_owed().expect("owed"),
        Some(5),
        "the server's copy is owed its delete-all"
    );
    assert_integrity(&conn);
    // The triggers are back.
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('seat_stats_player_delete', 'hand_stats_list_delete')"
        ),
        2
    );

    // Folders read again from the start bring nothing back.
    conn.execute("UPDATE files SET read_offset = 0", [])
        .expect("reset");
    for file in corpus_files() {
        import_file(
            &store,
            &file,
            &ImportOptions {
                parsed_at: Some(PARSED_AT.to_owned()),
                source_id: None,
            },
        )
        .expect("import");
    }
    assert_eq!(count(&conn, "SELECT count(*) FROM hands"), 0);

    // The pull: a key whose server copy is still owed its deletion is
    // skipped; one the server deleted and serves again is taken back.
    conn.execute(
        "UPDATE deleted_hands SET server = 1 WHERE hand_key = ?1",
        [&keys[1]],
    )
    .expect("owed");
    let outcome = writer
        .import_pulled(vec![pulled, owed], None, 10)
        .expect("pull");
    assert_eq!(outcome.inserted, 1);
    assert_eq!(count(&conn, "SELECT count(*) FROM hands"), 1);
    assert!(!store.reader().is_deleted(&keys[0]).expect("tombstone"));
    assert!(store.reader().is_deleted(&keys[1]).expect("tombstone"));
    assert_integrity(&conn);
    writer.server_wipe_done(5).expect("done");
    assert_eq!(store.reader().server_wipe_owed().expect("owed"), None);
    drop(writer);
    store.close();
}

#[test]
fn the_servers_deletions_are_applied_here() {
    let path = copy_of_corpus("delete-server");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    let keys: Vec<String> = conn
        .prepare("SELECT hand_key FROM hands ORDER BY rowid LIMIT 30")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("keys");
    // One by one, with a key this store never had (tombstoned all the same).
    let mut gone = keys[..10].to_vec();
    gone.push("pokerstars:never-here".to_owned());
    let applied = writer
        .apply_server_deletions(gone, Some(("sync.tombstones.u".into(), "c1".into())), 7)
        .expect("apply");
    assert_eq!(applied.deleted, 10);
    assert!(
        store
            .reader()
            .is_deleted("pokerstars:never-here")
            .expect("t")
    );
    assert_eq!(
        count(&conn, "SELECT count(*) FROM deleted_hands WHERE server = 1"),
        0
    );
    assert_eq!(
        store
            .reader()
            .kv("sync.tombstones.u")
            .expect("kv")
            .as_deref(),
        Some("c1")
    );
    assert_integrity(&conn);

    // Every hand synced by the wipe goes; a hand not synced yet stays.
    store
        .outbox_mark_sent(keys[10..20].to_vec(), 100)
        .expect("sent");
    store
        .outbox_mark_sent(keys[20..30].to_vec(), 300)
        .expect("sent");
    let applied = writer.apply_server_wipe(200, None, 8).expect("wipe");
    assert_eq!(applied.deleted, 10);
    assert_eq!(
        count(
            &conn,
            "SELECT count(*) FROM hands WHERE synced_at IS NOT NULL"
        ),
        10
    );
    assert_integrity(&conn);
    drop(writer);
    store.close();
}
