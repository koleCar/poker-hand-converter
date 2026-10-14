//! The sync worker's side of the store (R1.9): send order, outcomes,
//! refused hands, the owner and an account change, pulled hands, and the
//! migration that brought them.

mod common;

use rail_store::import::ImportOptions;
use rail_store::migrate;
use rail_store::sync::OWNER_KEY;
use rail_store::{PreparedHand, Rejection, Store, import_file};
use rusqlite::Connection;

use common::{DOWN_FROM_9, PARSED_AT, assert_integrity, corpus_file, scratch_dir};

const CHICO: &str =
    "fixtures/samples/chico/fpdb3-regression-corpus/cash__PLO-10max-USD-0.05-0.10-201209.txt";
const STARS: &str = "fixtures/samples/pokerstars/01-cash-nlhe-6max-ante.txt";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

fn keys(entries: &[rail_store::OutboxEntry]) -> Vec<String> {
    entries.iter().map(|e| e.hand_key.clone()).collect()
}

/// Every hand of the store with its played time, from a raw connection.
fn played(conn: &Connection) -> Vec<(String, Option<String>)> {
    conn.prepare("SELECT hand_key, played_at FROM hands ORDER BY hand_key")
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn recent_hands_go_first_newest_played_first_then_the_backlog_in_order() {
    let dir = scratch_dir("sync-order");
    let store = Store::open(dir.join("rail.db")).expect("open");
    import_file(&store, &corpus_file(CHICO), &options()).expect("import");
    import_file(&store, &corpus_file(STARS), &options()).expect("import");
    let conn = Connection::open(store.path()).expect("open");
    let all = played(&conn);
    assert!(all.len() >= 3, "{}", all.len());

    // The outbox carries the played time.
    let copied: i64 = conn
        .query_row(
            "SELECT count(*) FROM outbox o JOIN hands h USING (hand_key)
             WHERE o.played_at IS h.played_at",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(usize::try_from(copied).ok(), Some(all.len()));

    // Make it a backlog queued long ago, with distinct queue times in key
    // order, plus two hands queued "now".
    for (i, (key, _)) in all.iter().enumerate() {
        conn.execute(
            "UPDATE outbox SET enqueued_at = ?2, next_attempt_at = ?2 WHERE hand_key = ?1",
            rusqlite::params![key, 1_000 + i64::try_from(i).expect("i")],
        )
        .expect("age");
    }
    let now = rail_store::time::now_ms();
    let (recent_a, recent_b) = (&all[1].0, &all[2].0);
    conn.execute(
        "UPDATE outbox SET enqueued_at = ?2, next_attempt_at = ?2, played_at = ?3
         WHERE hand_key = ?1",
        rusqlite::params![recent_a, now - 1_000, "2026-10-13T10:00:00.000Z"],
    )
    .expect("recent a");
    conn.execute(
        "UPDATE outbox SET enqueued_at = ?2, next_attempt_at = ?2, played_at = ?3
         WHERE hand_key = ?1",
        rusqlite::params![recent_b, now - 2_000, "2026-10-13T11:00:00.000Z"],
    )
    .expect("recent b");

    let live_since = now - 60_000;
    let next = store
        .reader()
        .outbox_next(now, live_since, 4)
        .expect("next");
    assert_eq!(
        keys(&next),
        [
            recent_b.clone(),
            recent_a.clone(),
            all[0].0.clone(),
            all[3].0.clone()
        ],
        "recent first, newest played first; then the backlog in queue order"
    );
    assert_eq!(
        next.iter().map(|e| e.live).collect::<Vec<_>>(),
        [true, true, false, false]
    );
    assert!(next.iter().all(|e| e.phf.starts_with('{')));
    assert!(next.iter().all(|e| e.source_id.is_none()));

    // A failed hand waits for its retry.
    store
        .outbox_mark_failed(vec![recent_b.clone()], "offline", now + 60_000)
        .expect("failed");
    let next = store
        .reader()
        .outbox_next(now, live_since, 2)
        .expect("next");
    assert_eq!(keys(&next), [recent_a.clone(), all[0].0.clone()]);
    let counts = store.reader().sync_counts(now, live_since).expect("counts");
    assert_eq!(counts.outbox, u64::try_from(all.len()).expect("n"));
    assert_eq!((counts.live, counts.retrying), (2, 1));
    assert_eq!(counts.next_retry_at, Some(now + 60_000));
    assert_eq!(store.reader().local_hands().expect("local"), counts.outbox);
}

#[test]
fn refused_hands_leave_the_outbox_with_their_reason_until_tried_again() {
    let dir = scratch_dir("sync-reject");
    let store = Store::open(dir.join("rail.db")).expect("open");
    import_file(&store, &corpus_file(CHICO), &options()).expect("import");
    let now = rail_store::time::now_ms();
    let all = keys(&store.reader().outbox_next(now, now, 100).expect("next"));
    let writer = store.writer().expect("writer");

    let rejected = writer
        .outbox_reject(
            vec![
                Rejection {
                    hand_key: all[0].clone(),
                    reason: "invalid".into(),
                    field: Some("hero_cards".into()),
                },
                Rejection {
                    hand_key: all[1].clone(),
                    reason: "invalid".into(),
                    field: None,
                },
                Rejection {
                    hand_key: all[2].clone(),
                    reason: "shape".into(),
                    field: None,
                },
                Rejection {
                    hand_key: "nope:1".into(),
                    reason: "shape".into(),
                    field: None,
                },
            ],
            now,
        )
        .expect("reject");
    assert_eq!(rejected, 3, "a key not in the outbox is not recorded");
    let counts = store.reader().sync_counts(now, now).expect("counts");
    assert_eq!(
        counts.rejected,
        [("invalid".to_owned(), 2), ("shape".to_owned(), 1)]
    );
    let next = keys(&store.reader().outbox_next(now, now, 100).expect("next"));
    assert_eq!(next.len(), all.len() - 3);
    assert!(!next.contains(&all[0]));
    let list = store.reader().sync_rejected(10).expect("list");
    assert_eq!(list.len(), 3);
    assert!(
        list.iter()
            .any(|r| r.hand_key == all[0] && r.field.as_deref() == Some("hero_cards"))
    );

    assert_eq!(writer.rejected_requeue(now).expect("requeue"), 3);
    assert!(
        store
            .reader()
            .sync_counts(now, now)
            .expect("counts")
            .rejected
            .is_empty()
    );
    assert_eq!(
        store
            .reader()
            .outbox_next(now, now, 100)
            .expect("next")
            .len(),
        all.len()
    );
    drop(writer);
    assert_integrity(&Connection::open(store.path()).expect("open"));
}

#[test]
fn another_owner_gets_every_local_hand_queued_again_but_no_pulled_one() {
    let dir = scratch_dir("sync-owner");
    let store = Store::open(dir.join("rail.db")).expect("open");
    import_file(&store, &corpus_file(CHICO), &options()).expect("import");
    let now = rail_store::time::now_ms();
    let writer = store.writer().expect("writer");
    let all = keys(&store.reader().outbox_next(now, now, 100).expect("next"));

    // Owner A: everything sent but one refused hand.
    assert_eq!(
        writer
            .sync_set_owner(r#"{"userId":"a"}"#.into(), false, now)
            .expect("owner"),
        0
    );
    writer
        .outbox_reject(
            vec![Rejection {
                hand_key: all[0].clone(),
                reason: "shape".into(),
                field: None,
            }],
            now,
        )
        .expect("reject");
    writer
        .outbox_mark_sent(all[1..].to_vec(), now)
        .expect("sent");
    assert_eq!(store.status().expect("status").outbox, 0);

    // A pulled hand (from another store's PHF, under another key).
    let other_dir = scratch_dir("sync-owner-other");
    let other = Store::open(other_dir.join("rail.db")).expect("open");
    import_file(&other, &corpus_file(STARS), &options()).expect("import");
    let later = rail_store::time::now_ms() + 1;
    let pulled_key = keys(&other.reader().outbox_next(later, later, 1).expect("next")).remove(0);
    let phf = other
        .reader()
        .hand_phf(&pulled_key)
        .expect("phf")
        .expect("there");
    let hand: rail_core::phf::PhfHand = serde_json::from_str(&phf).expect("parse");
    let prepared = PreparedHand::from_phf(&hand).expect("prepare");
    assert_eq!(prepared.hand_key, pulled_key);
    let outcome = writer
        .import_pulled(vec![prepared.clone()], None, now)
        .expect("pulled");
    assert_eq!((outcome.inserted, outcome.present), (1, 0));
    assert_eq!(store.status().expect("status").outbox, 0, "not queued");

    // Owner B, upload: the local hands again, refused one included, the
    // pulled one not.
    let queued = writer
        .sync_set_owner(r#"{"userId":"b"}"#.into(), true, now)
        .expect("owner");
    assert_eq!(queued, u64::try_from(all.len()).expect("n"));
    assert_eq!(
        store.reader().kv(OWNER_KEY).expect("kv").as_deref(),
        Some(r#"{"userId":"b"}"#)
    );
    let mut next = keys(&store.reader().outbox_next(now, now, 100).expect("next"));
    next.sort();
    let mut expected = all.clone();
    expected.sort();
    assert_eq!(next, expected);
    let counts = store.reader().sync_counts(now, now).expect("counts");
    assert!(counts.rejected.is_empty());
    assert_eq!(
        store.reader().local_hands().expect("local"),
        u64::try_from(all.len()).expect("n")
    );
    let conn = Connection::open(store.path()).expect("open");
    let synced: i64 = conn
        .query_row(
            "SELECT count(*) FROM hands WHERE synced_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("synced");
    assert_eq!(synced, 1, "only the pulled hand is on the (old) server");
    drop(writer);
    assert_integrity(&conn);
}

#[test]
fn pulled_hands_are_stored_once_with_their_cursor_and_never_queued() {
    let dir = scratch_dir("sync-pull");
    let source = Store::open(dir.join("source.db")).expect("open");
    import_file(&source, &corpus_file(CHICO), &options()).expect("import");
    let now = rail_store::time::now_ms();
    let all = keys(&source.reader().outbox_next(now, now, 100).expect("next"));
    let prepared: Vec<PreparedHand> = all
        .iter()
        .map(|key| {
            let phf = source.reader().hand_phf(key).expect("phf").expect("there");
            let hand: rail_core::phf::PhfHand = serde_json::from_str(&phf).expect("parse");
            PreparedHand::from_phf(&hand).expect("prepare")
        })
        .collect();

    let store = Store::open(dir.join("rail.db")).expect("open");
    // One hand is already here from a file.
    import_file(&store, &corpus_file(CHICO), &options()).expect("import");
    let writer = store.writer().expect("writer");
    writer
        .outbox_mark_sent(all[1..].to_vec(), now)
        .expect("sent");
    let present = store.reader().hands_present(&all).expect("present");
    assert_eq!(present.len(), all.len());

    let fresh = Store::open(dir.join("fresh.db")).expect("open");
    let writer = fresh.writer().expect("writer");
    let outcome = writer
        .import_pulled(
            prepared.clone(),
            Some(("sync.pull.u".into(), "c1".into())),
            now,
        )
        .expect("pull");
    assert_eq!(outcome.inserted, u64::try_from(prepared.len()).expect("n"));
    let again = writer
        .import_pulled(
            prepared.clone(),
            Some(("sync.pull.u".into(), "c2".into())),
            now,
        )
        .expect("pull again");
    assert_eq!(
        (again.inserted, again.present),
        (0, u64::try_from(prepared.len()).expect("n"))
    );
    assert_eq!(
        fresh.reader().kv("sync.pull.u").expect("kv").as_deref(),
        Some("c2")
    );
    let status = fresh.status().expect("status");
    assert_eq!(status.outbox, 0, "pulled hands are never queued");
    assert_eq!(status.hands, u64::try_from(prepared.len()).expect("n"));
    assert_eq!(fresh.reader().local_hands().expect("local"), 0);
    for key in &all {
        assert_eq!(
            fresh.reader().hand_phf(key).expect("phf"),
            source.reader().hand_phf(key).expect("phf"),
            "the same canonical PHF"
        );
    }
    drop(writer);
    assert_integrity(&Connection::open(fresh.path()).expect("open"));
}

/// A version-4 store with queued hands: the migration copies each hand's
/// played time into the outbox.
#[test]
fn the_migration_fills_the_outbox_played_time() {
    let dir = scratch_dir("sync-migrate");
    let path = dir.join("rail.db");
    let store = Store::open(&path).expect("open");
    import_file(&store, &corpus_file(CHICO), &options()).expect("import");
    store.close();

    // Back to version 4's outbox (versions 5 and 6 are additive).
    let conn = Connection::open(&path).expect("open");
    conn.execute_batch(DOWN_FROM_9).expect("back to version 8");
    conn.execute_batch(
        "DROP TABLE hand_list; DROP TABLE hand_notes; DROP TABLE hand_tags;
         DROP TABLE saved_filters;
         DROP TABLE ev_pending; DROP TABLE ev_rows; DROP TABLE hero_rollups;
         DROP TABLE player_rollups; DROP TABLE seat_stats; DROP TABLE hand_stats;
         DROP TABLE segments;
         DELETE FROM kv WHERE key LIKE 'stats.%' OR key LIKE 'ev.%';
         DROP INDEX outbox_recent_idx;
         DROP INDEX outbox_retry_idx;
         ALTER TABLE outbox DROP COLUMN played_at;
         DROP TABLE sync_rejected;
         DROP INDEX hands_pulled_idx;
         ALTER TABLE hands DROP COLUMN pulled_at;
         PRAGMA user_version = 4;",
    )
    .expect("downgrade");
    drop(conn);

    let store = Store::open(&path).expect("reopen");
    assert_eq!(
        store.status().expect("status").schema_version,
        migrate::LATEST
    );
    let conn = Connection::open(&path).expect("open");
    let missing: i64 = conn
        .query_row(
            "SELECT count(*) FROM outbox o JOIN hands h USING (hand_key)
             WHERE o.played_at IS NOT h.played_at",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(missing, 0);
    let queued: i64 = conn
        .query_row(
            "SELECT count(*) FROM outbox WHERE played_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert!(queued > 0);
    assert_integrity(&conn);
}

/// How long the send-order query takes with a large backlog: 500 000
/// synthetic hands queued in the last minutes (a backfill being queued) and
/// as many queued earlier. Run by hand: `cargo test --release -p rail-store
/// --test sync -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, ~1 minute"]
fn the_send_order_query_with_a_large_backlog() {
    let dir = scratch_dir("sync-bench");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let now = rail_store::time::now_ms();
    let old = now - 3_600_000;
    let conn = Connection::open(store.path()).expect("open");
    conn.execute_batch("BEGIN").expect("begin");
    conn.execute(
        "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999999)
         INSERT INTO hands (hand_key, site, site_hand_id, played_at, game_format, variant,
                            limit_type, currency, small_blind, big_blind, ante, max_seats,
                            schema_version, parser_id, parser_version, phf, phf_size,
                            imported_at)
         SELECT 'x:' || i, 'x', i, strftime('%Y-%m-%dT%H:%M:%fZ', 1600000000 + i, 'unixepoch'),
                'cash', 'holdem', 'nl', 'USD', 1, 2, 0, 6, 'phf/1', 'x', '1', ?3, 2,
                CASE WHEN i < 500000 THEN ?1 ELSE ?2 END
         FROM n",
        rusqlite::params![old, now, zstd::bulk::compress(b"{}", 3).expect("zstd")],
    )
    .expect("hands");
    conn.execute_batch(
        "INSERT INTO outbox (hand_key, enqueued_at, next_attempt_at, played_at)
         SELECT hand_key, imported_at, imported_at, played_at FROM hands WHERE true;
         COMMIT;",
    )
    .expect("outbox");
    let reader = store.reader();
    let window = now - 600_000;
    let started = std::time::Instant::now();
    let live = reader.outbox_next(now + 1, window, 500).expect("next");
    let live_ms = started.elapsed().as_millis();
    let started = std::time::Instant::now();
    let older = reader.outbox_next(now + 1, now + 2, 500).expect("next");
    let backlog_ms = started.elapsed().as_millis();
    let started = std::time::Instant::now();
    let counts = reader.sync_counts(now, window).expect("counts");
    let counts_ms = started.elapsed().as_millis();
    println!(
        "1M queued (500k in the window): live tier {live_ms} ms, backlog tier {backlog_ms} ms, \
         counts {counts_ms} ms"
    );
    assert_eq!(live.len(), 500);
    assert_eq!(live[0].hand_key, "x:999999", "the newest played first");
    assert!(live.iter().all(|e| e.live));
    assert_eq!(older.len(), 500);
    assert_eq!(older[0].hand_key, "x:0", "the oldest queued first");
    assert_eq!(counts.outbox, 1_000_000);
}
