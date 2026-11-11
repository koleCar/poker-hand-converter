//! Migration 21: the plain GG cash hands an older build filed under the
//! `standard` site move to `ggpoker`, and the store ends up as a fresh
//! import by this build would leave it.

mod common;

use std::path::Path;

use rail_core::phf::PhfHand;
use rail_store::batch::{PreparedHand, decompress_phf};
use rail_store::import::ImportOptions;
use rail_store::{Store, background, hand_list, import_file};
use rusqlite::{Connection, params};

use common::{
    PARSED_AT, assert_integrity, corpus_file, scratch_dir, snapshot, stats_snapshot, table_rows,
};

const GG_A: &str = "gg-hh/GG20260217-0405 - NLHPurple70 - 0.25 - 0.5 - 6max.txt";
const GG_B: &str = "gg-hh/GG20260217-0406 - NLHPurple6 - 0.25 - 0.5 - 6max.txt";
const STARS: &str = "fixtures/samples/pokerstars/01-cash-nlhe-6max-ante.txt";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

fn drain(store: &Store) {
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
}

/// The keys of the store's hands of one site, sorted.
fn keys(conn: &Connection, site: &str) -> Vec<String> {
    conn.prepare("SELECT hand_key FROM hands WHERE site = ?1 ORDER BY hand_key")
        .expect("prepare")
        .query_map([site], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// A store with the two GG files and a PokerStars one imported by this
/// build, drained, with a note and a tag on the first GG hand.
fn imported(path: &Path) -> String {
    let store = Store::open(path).expect("open");
    for file in [GG_A, GG_B, STARS] {
        import_file(&store, &corpus_file(file), &options()).expect("import");
    }
    drain(&store);
    let conn = Connection::open(path).expect("open");
    let first = keys(&conn, "ggpoker")[0].clone();
    let key = first.clone();
    store
        .writer()
        .expect("writer")
        .write(move |tx| {
            hand_list::set_note(tx, &key, "check-raised the river", 5)?;
            hand_list::add_tag(tx, &key, "review", 6)?;
            Ok(())
        })
        .expect("note and tag");
    store.close();
    first
}

/// What an older build stored: every GG cash hand under `standard`, its key
/// `standard:<id>` in every table, and the derived rows rebuilt from that.
/// Left at schema version 20, so the next open runs migration 21.
fn as_an_older_build_stored_it(path: &Path) {
    {
        let mut conn = Connection::open(path).expect("open");
        conn.pragma_update(None, "foreign_keys", true).expect("fk");
        let tx = conn.transaction().expect("tx");
        tx.pragma_update(None, "defer_foreign_keys", true)
            .expect("defer");
        let tables: Vec<String> = tx
            .prepare(
                "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p
                  WHERE m.type = 'table' AND p.name = 'hand_key' AND m.name <> 'hands'",
            )
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        let rows: Vec<(String, Vec<u8>, i64)> = tx
            .prepare("SELECT hand_key, phf, phf_size FROM hands WHERE site = 'ggpoker'")
            .expect("prepare")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert!(rows.len() > 50, "{} GG hands", rows.len());
        for (key, blob, size) in rows {
            let json = decompress_phf(&blob, u64::try_from(size).expect("size")).expect("phf");
            let mut hand: PhfHand = serde_json::from_str(&json).expect("PHF");
            hand.meta.site_id = "standard".to_owned();
            hand.meta.site_name = "Rail standard".to_owned();
            let old = PreparedHand::from_phf(&hand).expect("prepare");
            assert_eq!(old.hand_key, key.replacen("ggpoker:", "standard:", 1));
            for table in &tables {
                tx.execute(
                    &format!("UPDATE {table} SET hand_key = ?2 WHERE hand_key = ?1"),
                    params![key, old.hand_key],
                )
                .expect("rekey");
            }
            tx.execute(
                "UPDATE hands SET hand_key = ?2, site = 'standard', phf = ?3, phf_size = ?4
                  WHERE hand_key = ?1",
                params![
                    key,
                    old.hand_key,
                    old.phf_zstd,
                    i64::try_from(old.phf_size).expect("size")
                ],
            )
            .expect("hand");
        }
        tx.execute("DELETE FROM kv WHERE key = 'stats.version'", [])
            .expect("kv");
        tx.commit().expect("commit");
    }
    // The derived rows as that build had them: grouped under `standard`.
    let store = Store::open(path).expect("open");
    drain(&store);
    store.close();
    let conn = Connection::open(path).expect("open");
    assert!(keys(&conn, "ggpoker").is_empty());
    conn.pragma_update(None, "user_version", 20)
        .expect("version 20");
}

#[test]
fn moves_the_gg_cash_hands_an_older_build_filed_under_standard() {
    let reference = scratch_dir("site-fix-reference").join("rail.db");
    let first = imported(&reference);
    let old = scratch_dir("site-fix-old").join("rail.db");
    assert_eq!(imported(&old), first);
    as_an_older_build_stored_it(&old);
    let before = Connection::open(&old).expect("open");
    let stars = keys(&before, "pokerstars");
    assert!(!stars.is_empty());
    let standard = keys(&before, "standard");
    drop(before);

    // The open migrates (21) and the background pass rebuilds.
    let store = Store::open(&old).expect("open");
    drain(&store);
    store.close();

    let conn = Connection::open(&old).expect("open");
    let expected = Connection::open(&reference).expect("open");
    assert!(keys(&conn, "standard").is_empty());
    assert_eq!(
        keys(&conn, "ggpoker"),
        standard
            .iter()
            .map(|k| k.replacen("standard:", "ggpoker:", 1))
            .collect::<Vec<_>>()
    );
    assert_eq!(keys(&conn, "pokerstars"), stars);
    assert_eq!(snapshot(&conn), snapshot(&expected));
    assert_eq!(stats_snapshot(&conn), stats_snapshot(&expected));
    for table in [
        "hand_list",
        "hand_notes",
        "hand_tags",
        "player_summary",
        "player_hidden",
    ] {
        assert_eq!(
            table_rows(&conn, table),
            table_rows(&expected, table),
            "{table}"
        );
    }
    // The old build's `standard` segment row stays, as any regrouping leaves
    // one; nothing is in it, and the Hands screen's rooms are counted from
    // the hands.
    let in_standard: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM hand_list l JOIN segments s ON s.id = l.segment_id
                      WHERE s.site = 'standard')
                  + (SELECT count(*) FROM hand_stats h JOIN segments s ON s.id = h.segment_id
                      WHERE s.site = 'standard')",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(in_standard, 0);
    assert_eq!(
        table_rows(&conn, "hand_notes"),
        vec![format!("'{first}'|'check-raised the river'|5")]
    );
    assert_integrity(&conn);
}

#[test]
fn keeps_the_copy_already_stored_under_ggpoker_and_moves_the_note_to_it() {
    let path = scratch_dir("site-fix-duplicate").join("rail.db");
    let first = imported(&path);
    as_an_older_build_stored_it(&path);
    let old_first = first.replacen("ggpoker:", "standard:", 1);
    // This build imports the same hands again from a copy of the file: the
    // old build's `standard` rows and these `ggpoker` ones side by side.
    let copy = scratch_dir("site-fix-duplicate-copy").join("gg-a.txt");
    std::fs::copy(corpus_file(GG_A), &copy).expect("copy");
    {
        let conn = Connection::open(&path).expect("open");
        conn.pragma_update(None, "user_version", 21)
            .expect("version 21");
    }
    let store = Store::open(&path).expect("open");
    import_file(&store, &copy, &options()).expect("import the copy");
    drain(&store);
    store.close();
    let conn = Connection::open(&path).expect("open");
    let doubled = keys(&conn, "ggpoker");
    assert!(doubled.contains(&first));
    assert!(keys(&conn, "standard").contains(&old_first));
    let total: i64 = conn
        .query_row("SELECT count(*) FROM hands", [], |r| r.get(0))
        .expect("count");
    conn.pragma_update(None, "user_version", 20)
        .expect("version 20");
    drop(conn);

    let store = Store::open(&path).expect("open");
    drain(&store);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert!(keys(&conn, "standard").is_empty());
    let after: i64 = conn
        .query_row("SELECT count(*) FROM hands", [], |r| r.get(0))
        .expect("count");
    assert_eq!(after, total - i64::try_from(doubled.len()).expect("len"));
    assert_eq!(
        table_rows(&conn, "hand_notes"),
        vec![format!("'{first}'|'check-raised the river'|5")]
    );
    assert_eq!(
        table_rows(&conn, "hand_tags"),
        vec![format!("'{first}'|'review'|6")]
    );
    assert_integrity(&conn);
}

#[test]
fn leaves_a_store_without_such_hands_as_it_was() {
    let path = scratch_dir("site-fix-none").join("rail.db");
    imported(&path);
    let conn = Connection::open(&path).expect("open");
    let before = (snapshot(&conn), table_rows(&conn, "kv"));
    conn.pragma_update(None, "user_version", 20)
        .expect("version 20");
    drop(conn);
    Store::open(&path).expect("open").close();
    let conn = Connection::open(&path).expect("open");
    assert_eq!((snapshot(&conn), table_rows(&conn, "kv")), before);
}
