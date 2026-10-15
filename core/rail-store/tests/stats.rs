//! Local statistics (docs/RAIL-PLAN.md R2.3): the seat rows a corpus import
//! stores are the engine's rows, the rollups their sums, the EV rows the
//! web's, a rebuild reproduces an import, an older store gets its
//! statistics, and the read API answers what the rows say.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use rail_core::phf::PhfHand;
use rail_stats::display::{AggregateOptions, Display, Sums, aggregate};
use rail_stats::{
    COUNTER_KEYS, DIMENSION_COLUMNS, MONEY_KEYS, Segment, SiteAnonymization, StatsRow,
    session_scope, stored_rows,
};
use rail_store::background::{self, Activity};
use rail_store::batch::decompress_phf;
use rail_store::import::ImportOptions;
use rail_store::stats::{decode_seat, kind_of};
use rail_store::{
    Exclusions, HeroFilter, PreparedHand, SeatValues, StatsWorker, Store, Totals, import_file,
};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use common::{
    DOWN_FROM_9, PARSED_AT, assert_integrity, corpus_files, scratch_dir, snapshot, stats_snapshot,
};

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// Import `files` into the store at `path`.
fn import_into(path: &Path, files: &[PathBuf]) {
    let store = Store::open(path).expect("open");
    for file in files {
        import_file(&store, file, &options()).expect("import");
    }
    store.close();
}

/// The whole corpus, imported once per test binary (no background pass:
/// its preflop all-ins wait in `ev_pending`). Tests copy it.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let dir = scratch_dir("stats-corpus");
        let path = dir.join("corpus.db");
        let started = Instant::now();
        import_into(&path, &corpus_files());
        eprintln!("corpus imported in {:.1?}", started.elapsed());
        path
    })
}

/// A private copy of the corpus store.
fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

/// Every stored hand, parsed back.
fn stored_hands(conn: &Connection) -> Vec<PhfHand> {
    let mut stmt = conn
        .prepare("SELECT phf, phf_size FROM hands ORDER BY hand_key")
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    let mut hands = Vec::new();
    while let Some(row) = rows.next().expect("row") {
        let blob: Vec<u8> = row.get(0).expect("phf");
        let size: i64 = row.get(1).expect("size");
        let json = decompress_phf(&blob, u64::try_from(size).expect("size")).expect("phf");
        hands.push(serde_json::from_str(&json).expect("a stored PHF parses"));
    }
    hands
}

/// Where each column of the engine's row is stored: `d` is `hand_stats`,
/// `s` `seat_stats`, `h` `hands`; the counters and money are `s.totals`.
fn source_of(column: &str) -> String {
    match column {
        "hand_id" => "h.site_hand_id".to_owned(),
        "hand_key"
        | "stats_version"
        | "site_id"
        | "currency_minor_units"
        | "player_count"
        | "tournament_id"
        | "fast_fold"
        | "has_straddle"
        | "is_bomb_pot"
        | "is_big_blind_ante"
        | "is_run_it_twice"
        | "has_cashout"
        | "is_walk"
        | "street_reached"
        | "pot_type"
        | "total_pot"
        | "house_into_pot"
        | "fees"
        | "played_at" => {
            format!("d.{column}")
        }
        "variant" | "limit_type" | "game_format" | "currency" | "small_blind" | "big_blind"
        | "max_seats" | "table_name" => format!("h.{column}"),
        _ => format!("s.{column}"),
    }
}

const BOOLEAN_COLUMNS: [&str; 7] = [
    "has_straddle",
    "is_bomb_pot",
    "is_big_blind_ante",
    "is_run_it_twice",
    "has_cashout",
    "is_walk",
    "is_hero",
];

/// The stored rows as the engine's JSON rows (`StatsRow::to_json`), put
/// together from `hand_stats`, `seat_stats` and `hands`, keyed by (hand,
/// seat).
fn stored_rows_json(conn: &Connection) -> BTreeMap<(String, u32), Value> {
    let select: Vec<String> = DIMENSION_COLUMNS.iter().map(|c| source_of(c)).collect();
    let sql = format!(
        "SELECT {}, s.totals FROM seat_stats s JOIN hand_stats d ON d.id = s.hand_id
         JOIN hands h ON h.hand_key = d.hand_key",
        select.join(", ")
    );
    let mut stmt = conn.prepare(&sql).expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    let mut out = BTreeMap::new();
    while let Some(row) = rows.next().expect("row") {
        let mut json = Map::new();
        for (i, column) in DIMENSION_COLUMNS.iter().enumerate() {
            let value = match row.get_ref(i).expect("column") {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) if BOOLEAN_COLUMNS.contains(column) => Value::Bool(n != 0),
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Text(text) => {
                    let text = String::from_utf8(text.to_vec()).expect("utf-8");
                    if *column == "hole_cards" {
                        Value::Array(
                            text.split(' ')
                                .filter(|card| !card.is_empty())
                                .map(|card| Value::String(card.to_owned()))
                                .collect(),
                        )
                    } else {
                        Value::String(text)
                    }
                }
                other => panic!("{column}: unexpected {other:?}"),
            };
            json.insert((*column).to_owned(), value);
        }
        let blob: Vec<u8> = row.get(DIMENSION_COLUMNS.len()).expect("totals");
        let values = decode_seat(&blob).expect("decode");
        for (key, value) in COUNTER_KEYS.iter().zip(values.counters) {
            json.insert((*key).to_owned(), Value::from(value));
        }
        for (key, value) in MONEY_KEYS.iter().zip(values.money) {
            json.insert((*key).to_owned(), Value::from(value));
        }
        let key = (
            json["hand_key"].as_str().expect("key").to_owned(),
            u32::try_from(json["seat"].as_u64().expect("seat")).expect("seat"),
        );
        out.insert(key, Value::Object(json));
    }
    out
}

#[test]
fn the_tables_have_the_engine_columns() {
    let dir = scratch_dir("stats-columns");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let names = |table: &str| -> Vec<String> {
        conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("names")
    };
    // Every column of the engine's row has its place.
    for column in DIMENSION_COLUMNS {
        let source = source_of(column);
        let (table, name) = source.split_once('.').expect("qualified");
        let table = match table {
            "d" => "hand_stats",
            "s" => "seat_stats",
            _ => "hands",
        };
        assert!(names(table).iter().any(|c| c == name), "{column}: {source}");
    }
    let totals: Vec<String> = common::total_columns()
        .into_iter()
        .map(str::to_owned)
        .collect();
    assert_eq!(totals.len(), COUNTER_KEYS.len() + MONEY_KEYS.len() + 1);
    let player = names("player_rollups");
    assert_eq!(
        player[..5],
        ["site", "player", "scope", "segment_id", "last_played_at"]
    );
    assert_eq!(player[5..], totals[..]);
    let hero = names("hero_rollups");
    assert_eq!(hero[..4], ["segment_id", "position", "day", "kind"]);
    assert_eq!(hero[4..], totals[..]);
    // A new store is at the current versions, with nothing to rebuild.
    let status = store.reader().stats_status().expect("status");
    assert_eq!(
        status.stats_version.as_deref(),
        Some(rail_stats::STATS_VERSION)
    );
    assert_eq!(status.ev_version.as_deref(), Some(rail_equity::EV_VERSION));
    assert_eq!(
        (status.generation, status.rebuild, status.ev_pending),
        (1, None, 0)
    );
}

/// The rows a store should keep for `hands`, with their scope and segment.
fn expected_rows(hands: &[PhfHand]) -> Vec<(StatsRow, String, Segment, SiteAnonymization)> {
    let mut out = Vec::new();
    for hand in hands {
        let stored = stored_rows(hand, true);
        for row in stored.rows {
            let scope = rail_stats::rollup_scope(stored.anonymization, &row);
            out.push((row, scope, stored.segment.clone(), stored.anonymization));
        }
    }
    out
}

/// The exit check of the import path: every stored seat row is the
/// engine's row, the kept rows are exactly `handStatsRows`' (villains of
/// positional rooms dropped), opaque tokens are scoped to their session,
/// and the rollups are the sums.
#[test]
fn corpus_seat_rows_are_the_engine_rows_and_the_rollups_their_sums() {
    let conn = Connection::open(corpus_store()).expect("open");
    assert_integrity(&conn);
    let hands = stored_hands(&conn);
    let expected = expected_rows(&hands);
    let stored = stored_rows_json(&conn);
    assert_eq!(stored.len(), expected.len(), "one row per kept seat");
    let mut by_anonymization: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (row, scope, _, anonymization) in &expected {
        let key = (row.hand.hand_key.clone(), row.seat.seat);
        let ours = stored.get(&key).expect("a stored row per kept seat");
        assert_eq!(ours, &row.to_json(), "{key:?}");
        let counts = by_anonymization.entry(anonymization.as_str()).or_default();
        if row.seat.is_hero {
            counts.0 += 1;
        } else {
            counts.1 += 1;
        }
        match (anonymization, row.seat.is_hero) {
            (SiteAnonymization::Positional, false) => panic!("{key:?}: a positional villain"),
            (SiteAnonymization::OpaqueId, false) => assert_eq!(
                scope,
                &session_scope(
                    row.hand.table_name.as_deref(),
                    row.hand.played_at.as_deref()
                )
            ),
            _ => assert_eq!(scope, ""),
        }
    }
    eprintln!("kept rows by room kind (hero, villains): {by_anonymization:?}");
    for kind in ["none", "positional", "opaque-id"] {
        assert!(
            by_anonymization.contains_key(kind),
            "the corpus has {kind} hands"
        );
    }

    // The read API: each player's rollups are the sums of their rows.
    let store = Store::open(corpus_store()).expect("open");
    let reader = store.reader();
    let mut sums: BTreeMap<(String, String, String, i64), Totals> = BTreeMap::new();
    for (row, scope, segment, _) in &expected {
        let id = reader
            .segment_id(segment)
            .expect("segment")
            .expect("a stored segment");
        // `aggregate`'s defaults: bomb pots out, EV-cashout money out.
        let (counted, money) = Exclusions::default().admits(kind_of(row));
        if counted {
            sums.entry((
                segment.site.clone(),
                row.seat.player.clone(),
                scope.clone(),
                id,
            ))
            .or_default()
            .add_seat(&SeatValues::of(row), money);
        }
    }
    for ((site, player, scope, id), totals) in &sums {
        let rollup = reader
            .player_rollup(site, player, scope, *id)
            .expect("rollup")
            .expect("a rollup per player and segment");
        assert_eq!(&rollup.totals, totals, "{site} {player} {scope} {id}");
    }
    let segments = reader.segments().expect("segments");
    assert_eq!(
        segments.len(),
        expected
            .iter()
            .map(|(_, _, segment, _)| segment.key())
            .collect::<BTreeSet<_>>()
            .len()
    );
    eprintln!(
        "{} hands, {} seat rows, {} player rollups, {} segments",
        hands.len(),
        stored.len(),
        sums.len(),
        segments.len()
    );
    store.close();
}

/// The HUD's lookup sums a player's segments of a site.
#[test]
fn hud_totals_sum_a_players_segments() {
    let store = Store::open(corpus_store()).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    // The players with the most segments on one site.
    let players: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT site, player, scope FROM player_rollups
             GROUP BY site, player, scope ORDER BY count(*) DESC, sum(hands) DESC LIMIT 9",
        )
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let reader = store.reader();
    for (site, player, scope) in &players {
        let rollups = reader.player_rollups(site, player, scope).expect("rollups");
        let mut all = Totals::default();
        for rollup in &rollups {
            all.add(&rollup.totals, true);
        }
        let first = rollups.first().expect("a rollup").segment_id;
        let found = reader
            .hud_totals(site, &[(player, scope)], None)
            .expect("hud");
        assert_eq!(found, [all.clone()]);
        let one = reader
            .hud_totals(site, &[(player, scope)], Some(&[first]))
            .expect("hud");
        assert_eq!(one[0], rollups[0].totals);
        assert!(all.hands() >= one[0].hands());
    }
    // An unknown player has nothing.
    let none = reader
        .hud_totals("pokerstars", &[("nobody at all", "")], None)
        .expect("hud");
    assert_eq!(none, [Totals::default()]);
    store.close();
}

/// What the app tells the HUD after an import (R3.2): a file's newest
/// hands with their site, table and players, each of whom has a rollup.
#[test]
fn newest_hands_of_a_file_for_the_hud() {
    let path = copy_of_corpus("newest-hands");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let (file_id, file, hands): (i64, String, i64) = conn
        .query_row(
            "SELECT id, path, hands FROM files WHERE hands >= 4 ORDER BY hands DESC, id LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("a file with hands");
    let expected: Vec<String> = conn
        .prepare("SELECT hand_key FROM hands WHERE file_id = ?1 ORDER BY rowid DESC LIMIT 3")
        .expect("prepare")
        .query_map([file_id], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let reader = store.reader();
    let newest = reader
        .newest_hands_of_file(Path::new(&file), 3)
        .expect("newest");
    assert_eq!(
        newest
            .iter()
            .map(|h| h.hand_key.clone())
            .collect::<Vec<_>>(),
        expected
    );
    for hand in &newest {
        let (table, seats): (Option<String>, i64) = conn
            .query_row(
                "SELECT h.table_name, (SELECT count(*) FROM seat_stats s
                   WHERE s.hand_id = hs.id AND s.player != '')
                 FROM hands h JOIN hand_stats hs ON hs.hand_key = h.hand_key
                 WHERE h.hand_key = ?1",
                [&hand.hand_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("hand");
        assert_eq!(hand.table, table);
        assert_eq!(i64::try_from(hand.players.len()).expect("len"), seats);
        assert!(!hand.players.is_empty());
        // Seat numbers (R3.4: where the HUD draws), ascending, from 1.
        assert!(hand.players[0].seat >= 1, "{:?}", hand.players);
        assert!(
            hand.players.windows(2).all(|w| w[0].seat < w[1].seat),
            "{:?}",
            hand.players
        );
        assert!(hand.players.iter().filter(|p| p.hero).count() <= 1);
        let players: Vec<(&str, &str)> = hand
            .players
            .iter()
            .map(|p| (p.player.as_str(), p.scope.as_str()))
            .collect();
        let totals = reader
            .hud_totals(&hand.site, &players, None)
            .expect("hud totals");
        assert!(
            totals.iter().all(|t| t.hands() >= 1),
            "every player of {} has a rollup on {}",
            hand.hand_key,
            hand.site
        );
    }
    assert_eq!(
        reader
            .newest_hands_of_file(Path::new(&file), u32::MAX)
            .expect("all")
            .len(),
        usize::try_from(hands).expect("hands")
    );
    assert!(
        reader
            .newest_hands_of_file(Path::new("/no/such/file.txt"), 3)
            .expect("none")
            .is_empty()
    );

    // `data_version` moves when another connection commits.
    let one = rail_store::Reader::open(store.path(), 1).expect("reader");
    let before = one.data_version().expect("version");
    assert_eq!(one.data_version().expect("version"), before);
    conn.execute(
        "INSERT INTO kv (key, value, updated_at) VALUES ('test.hud', '1', 0)",
        [],
    )
    .expect("write");
    assert_ne!(one.data_version().expect("version"), before);

    // R3.3: a hand's table size, and the user's own names (redacted from
    // the window list).
    let (key, max_seats): (String, i64) = conn
        .query_row(
            "SELECT hand_key, max_seats FROM hands ORDER BY rowid LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("a hand");
    assert_eq!(
        reader.hand_seats(&key).expect("seats"),
        Some(u32::try_from(max_seats).expect("seats"))
    );
    assert_eq!(reader.hand_seats("nobody:1").expect("seats"), None);
    let heroes: Vec<String> = conn
        .prepare(
            "SELECT DISTINCT hero_name FROM hands WHERE hero_name IS NOT NULL
             AND hero_name != '' ORDER BY hero_name",
        )
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert!(!heroes.is_empty());
    assert_eq!(reader.hero_names().expect("heroes"), heroes);
    store.close();
}

/// After the background pass, every hero hand has the web's EV row
/// (`handEvRow`), the queue is empty, and a hand without a hero has none.
#[test]
fn ev_rows_are_the_web_rows_after_the_pass() {
    let path = copy_of_corpus("stats-ev");
    let store = Store::open(&path).expect("open");
    let pending = store.reader().stats_status().expect("status").ev_pending;
    assert!(
        pending > 100,
        "the corpus's preflop all-ins wait: {pending}"
    );
    let started = Instant::now();
    let drained =
        background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    eprintln!(
        "EV pass: {} rows in {:.1?} ({:.1?} computing), {} pending before",
        drained.ev_rows,
        started.elapsed(),
        drained.ev_time,
        pending
    );
    assert_eq!(u64::try_from(drained.ev_rows).expect("n"), pending);
    assert_eq!(drained.rebuilt, 0);
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let snap = stats_snapshot(&conn);
    assert!(snap.ev_pending.is_empty());
    // The web's row of every hand, from what is stored: an `ev_rows` row
    // for an all-in with cards to come, else `ev_net = net` from the hero's
    // seat row.
    let mut hero_net: BTreeMap<String, (u32, i64, i64)> = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT d.hand_key, s.seat, s.totals FROM seat_stats s
             JOIN hand_stats d ON d.id = s.hand_id WHERE s.is_hero = 1 ORDER BY s.seat",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(row) = rows.next().expect("row") {
        let values = decode_seat(&row.get::<_, Vec<u8>>(2).expect("blob")).expect("decode");
        hero_net.entry(row.get(0).expect("key")).or_insert((
            row.get(1).expect("seat"),
            values.net(),
            values.net_bb_milli(),
        ));
    }
    let (mut with_hero, mut applicable) = (0, 0);
    for hand in stored_hands(&conn) {
        let key = rail_store::batch::hand_key_of(&hand);
        match rail_equity::ev_row_for(&hand) {
            Some(row) if row.applicable => {
                with_hero += 1;
                applicable += 1;
                let ours = snap.ev_rows.get(&key).expect("a stored applicable EV row");
                assert_eq!(
                    ours,
                    &vec![
                        row.seat.to_string(),
                        format!("'{}'", row.ev_version),
                        row.ev_net.to_string(),
                        row.ev_net_bb_milli.to_string(),
                    ],
                    "{key}"
                );
            }
            Some(row) => {
                with_hero += 1;
                assert!(!snap.ev_rows.contains_key(&key), "{key}: not applicable");
                assert_eq!(
                    hero_net.get(&key),
                    Some(&(row.seat, row.ev_net, row.ev_net_bb_milli)),
                    "{key}: ev_net = net"
                );
            }
            None => assert!(!snap.ev_rows.contains_key(&key), "{key}: no hero, no row"),
        }
    }
    assert_eq!(snap.ev_rows.len(), applicable);
    eprintln!("{with_hero} hero hands, {applicable} all-ins evaluated");
    store.close();
}

/// A rebuild (a new generation) gives the same statistics; imports during a
/// rebuild are counted once.
#[test]
fn a_rebuild_reproduces_the_import_and_imports_during_it_count_once() {
    // The reference: the whole corpus, EV drained.
    let reference_path = copy_of_corpus("stats-rebuild-ref");
    let reference = Store::open(&reference_path).expect("open");
    background::drain(reference.reader(), &reference.writer().expect("w")).expect("drain");
    reference.close();
    let reference = stats_snapshot(&Connection::open(&reference_path).expect("open"));

    // A full rebuild of the same store.
    let path = copy_of_corpus("stats-rebuild");
    let store = Store::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    background::drain(store.reader(), &writer).expect("drain");
    let total = writer
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("rebuild");
    let status = store.reader().stats_status().expect("status");
    assert_eq!(
        status.generation, 1,
        "R2.11: a recompute keeps the generation"
    );
    assert_eq!(
        status.rebuild.as_ref().map(|r| (r.done, r.total, r.fills)),
        Some((0, total, 0))
    );
    // The screens keep the statistics they show until the swap.
    assert_integrity(&Connection::open(&path).expect("open"));
    assert!(
        stats_snapshot(&Connection::open(&path).expect("open")) == reference,
        "a recompute that has not swapped changed what the screens read"
    );
    let started = Instant::now();
    let drained = background::drain(store.reader(), &writer).expect("drain");
    eprintln!(
        "rebuild: {} hands in {:.1?}; then {} EV rows",
        drained.rebuilt,
        started.elapsed(),
        drained.ev_rows
    );
    assert_eq!(u64::try_from(drained.rebuilt).expect("n"), total);
    // The hero rows did not change: no EV row was computed again.
    assert_eq!(drained.ev_rows, 0);
    assert_eq!(store.reader().stats_status().expect("s").rebuild, None);
    drop(writer);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    assert!(
        stats_snapshot(&conn) == reference,
        "a rebuild changed the statistics"
    );

    // Half the corpus, a rebuild started, the other half imported while it
    // runs: the same statistics as one import.
    let files = corpus_files();
    let (first, second) = files.split_at(files.len() / 2);
    let path = scratch_dir("stats-rebuild-mixed").join("rail.db");
    import_into(&path, first);
    let store = Store::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    writer
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("rebuild");
    for _ in 0..3 {
        background::step(store.reader(), &writer, true).expect("step");
    }
    for file in second {
        import_file(&store, file, &options()).expect("import");
    }
    assert_integrity(&Connection::open(&path).expect("open"));
    background::drain(store.reader(), &writer).expect("drain");
    drop(writer);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let mixed = stats_snapshot(&conn);
    assert_eq!(mixed.seats.len(), reference.seats.len());
    assert!(
        mixed == reference,
        "a rebuild with imports differs from one import"
    );
}

/// A store from before R2.3 (version 5, hands and no statistics) gets them:
/// the migration, then a rebuild the background pass runs.
#[test]
fn an_older_store_gets_its_statistics() {
    let reference_path = copy_of_corpus("stats-older-ref");
    let reference = Store::open(&reference_path).expect("open");
    background::drain(reference.reader(), &reference.writer().expect("w")).expect("drain");
    reference.close();
    let reference = snapshot(&Connection::open(&reference_path).expect("open"));

    let path = copy_of_corpus("stats-older");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(DOWN_FROM_9).expect("back to version 8");
        conn.execute_batch(
            "DROP TABLE hand_list; DROP TABLE hand_notes; DROP TABLE hand_tags;
             DROP TABLE saved_filters;
             DROP TABLE ev_pending; DROP TABLE ev_rows; DROP TABLE hero_rollups;
             DROP TABLE hand_stats;
             DROP TABLE player_rollups; DROP TABLE seat_stats; DROP TABLE segments;
             DELETE FROM kv WHERE key LIKE 'stats.%' OR key LIKE 'ev.%';
             PRAGMA user_version = 5;",
        )
        .expect("back to version 5");
    }
    let store = Store::open(&path).expect("open");
    let status = store.reader().stats_status().expect("status");
    let hands = store.status().expect("status").hands;
    assert_eq!(status.rebuild.map(|r| (r.done, r.total)), Some((0, hands)));
    assert_eq!(
        status.ev_pending, 0,
        "no hero rows yet: the rebuild queues them"
    );
    background::drain(store.reader(), &store.writer().expect("w")).expect("drain");
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let upgraded = snapshot(&conn);
    assert!(
        upgraded.stats == reference.stats,
        "an upgraded store's statistics differ from an import's"
    );
}

/// A hand the store has adds nothing, wherever it comes from again.
#[test]
fn duplicates_add_nothing() {
    let path = copy_of_corpus("stats-duplicates");
    let before = stats_snapshot(&Connection::open(&path).expect("open"));
    let store = Store::open(&path).expect("open");
    let dir = path.parent().expect("dir").join("again");
    std::fs::create_dir_all(&dir).expect("dir");
    for (i, file) in corpus_files().iter().take(40).enumerate() {
        let copy = dir.join(format!(
            "{i}-{}",
            file.file_name().expect("name").to_string_lossy()
        ));
        std::fs::copy(file, &copy).expect("copy");
        import_file(&store, &copy, &options()).expect("import");
    }
    // And pulled from the server.
    let hands = stored_hands(&Connection::open(&path).expect("open"));
    let prepared: Vec<PreparedHand> = hands
        .iter()
        .take(200)
        .map(|hand| PreparedHand::from_phf(hand).expect("prepare"))
        .collect();
    let pulled = store
        .writer()
        .expect("writer")
        .import_pulled(prepared, None, 1)
        .expect("pulled");
    assert_eq!(pulled.inserted, 0);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    assert!(
        stats_snapshot(&conn) == before,
        "a duplicate changed the statistics"
    );
}

/// Hands pulled from the server get their statistics like imported ones.
#[test]
fn pulled_hands_get_their_statistics() {
    let conn = Connection::open(corpus_store()).expect("open");
    let hands = stored_hands(&conn);
    let reference = stats_snapshot(&conn);
    let dir = scratch_dir("stats-pulled");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let prepared: Vec<PreparedHand> = hands
        .iter()
        .map(|hand| PreparedHand::from_phf(hand).expect("prepare"))
        .collect();
    for page in prepared.chunks(500) {
        store
            .writer()
            .expect("writer")
            .import_pulled(page.to_vec(), None, 1)
            .expect("pulled");
    }
    let path = store.path().to_path_buf();
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let pulled = stats_snapshot(&conn);
    assert_eq!(pulled.seats, reference.seats);
    assert_eq!(pulled.players, reference.players);
    assert_eq!(pulled.heroes, reference.heroes);
    assert_eq!(pulled.ev_rows, reference.ev_rows);
    assert_eq!(pulled.ev_pending, reference.ev_pending);
    assert_eq!(pulled.list, reference.list);
}

/// What `hero_totals` should say, from the engine's rows.
/// The engine's hero rows of `hands`, with their segment id and EV row.
fn hero_rows(
    hands: &[PhfHand],
    ids: &BTreeMap<String, i64>,
) -> Vec<(i64, StatsRow, Option<rail_equity::EvRow>)> {
    let mut out = Vec::new();
    for hand in hands {
        let stored = stored_rows(hand, true);
        let Some(&id) = ids.get(&stored.segment.key()) else {
            assert!(stored.rows.is_empty());
            continue;
        };
        let ev = rail_equity::ev_row_for(hand);
        for row in stored.rows.into_iter().filter(|row| row.seat.is_hero) {
            out.push((id, row, ev.clone()));
        }
    }
    out
}

fn hero_expected(
    heroes: &[(i64, StatsRow, Option<rail_equity::EvRow>)],
    filter: &HeroFilter,
) -> BTreeMap<(i64, String), (Totals, i64, i64, i64)> {
    let mut out: BTreeMap<(i64, String), (Totals, i64, i64, i64)> = BTreeMap::new();
    for (id, row, ev) in heroes {
        let id = *id;
        {
            let position = row.seat.position.map_or("", |p| p.as_str()).to_owned();
            let played = row.hand.played_at.as_deref();
            if filter.segments.as_ref().is_some_and(|s| !s.contains(&id))
                || filter
                    .positions
                    .as_ref()
                    .is_some_and(|p| !p.contains(&position))
                || filter
                    .from
                    .as_deref()
                    .is_some_and(|from| played.is_none_or(|at| at < from))
                || filter
                    .to
                    .as_deref()
                    .is_some_and(|to| played.is_none_or(|at| at >= to))
            {
                continue;
            }
            let (counted, money) = filter.exclusions.admits(kind_of(row));
            if !counted {
                continue;
            }
            let entry = out.entry((id, position)).or_default();
            entry.0.add_seat(&SeatValues::of(row), money);
            if let Some(ev) = ev
                .as_ref()
                .filter(|ev| money && ev.applicable && ev.seat == row.seat.seat)
            {
                entry.1 += 1;
                entry.2 += ev.ev_net - row.seat.money.net;
                entry.3 += ev.ev_net_bb_milli - row.seat.money.net_bb_milli;
            }
        }
    }
    out
}

/// The hero's totals by segment, position and date range are the rows'
/// sums, whole days from the rollups and the partial days from the rows.
#[test]
fn hero_totals_are_the_rows_sums() {
    let path = copy_of_corpus("stats-hero");
    let store = Store::open(&path).expect("open");
    background::drain(store.reader(), &store.writer().expect("w")).expect("drain");
    let conn = Connection::open(&path).expect("open");
    let hands = stored_hands(&conn);
    let reader = store.reader();
    let ids: BTreeMap<String, i64> = reader
        .segments()
        .expect("segments")
        .into_iter()
        .map(|row| (row.segment.key(), row.id))
        .collect();
    let mut played: Vec<String> = conn
        .prepare(
            "SELECT h.played_at FROM hands h JOIN hand_stats d ON d.hand_key = h.hand_key
             JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
             WHERE h.played_at IS NOT NULL ORDER BY h.played_at",
        )
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    played.dedup();
    let at = |q: usize| played[played.len() * q / 100].clone();
    let busiest: Vec<i64> = conn
        .prepare("SELECT segment_id FROM hero_rollups GROUP BY 1 ORDER BY sum(hands) DESC LIMIT 2")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let filters = [
        HeroFilter::default(),
        HeroFilter {
            from: Some(at(25)),
            to: Some(at(75)),
            ..HeroFilter::default()
        },
        HeroFilter {
            from: Some(at(10)),
            ..HeroFilter::default()
        },
        HeroFilter {
            to: Some(at(90)),
            ..HeroFilter::default()
        },
        // Within one day: the rows only.
        HeroFilter {
            from: Some(at(50)),
            to: Some(format!("{}T23:59:59.999Z", &at(50)[..10])),
            ..HeroFilter::default()
        },
        HeroFilter {
            segments: Some(busiest.clone()),
            positions: Some(vec!["BTN".to_owned(), "BB".to_owned(), String::new()]),
            from: Some(at(5)),
            to: Some(at(95)),
            ..HeroFilter::default()
        },
        // `aggregate`'s options.
        HeroFilter {
            exclusions: Exclusions {
                bomb_pots: true,
                cashouts: true,
                no_straddled: false,
            },
            ..HeroFilter::default()
        },
        HeroFilter {
            from: Some(at(30)),
            exclusions: Exclusions {
                bomb_pots: false,
                cashouts: true,
                no_straddled: true,
            },
            ..HeroFilter::default()
        },
        // Empty.
        HeroFilter {
            from: Some(at(60)),
            to: Some(at(40)),
            ..HeroFilter::default()
        },
    ];
    let heroes = hero_rows(&hands, &ids);
    for filter in &filters {
        let want = hero_expected(&heroes, filter);
        let got = reader.hero_totals(filter).expect("hero totals");
        let got: BTreeMap<(i64, String), (Totals, i64, i64, i64)> = got
            .into_iter()
            .map(|t| {
                assert_eq!(t.ev.pending, 0, "drained");
                (
                    (t.segment_id, t.position),
                    (t.totals, t.ev.applicable, t.ev.net, t.ev.bb_milli),
                )
            })
            .collect();
        assert!(got == want, "hero totals for {filter:?}");
        let hands: i64 = got.values().map(|v| v.0.hands()).sum();
        let applicable: i64 = got.values().map(|v| v.1).sum();
        eprintln!("{filter:?}: {hands} hero hands, {applicable} all-ins evaluated");
    }

    // The display definitions (R2.4) over the hero's totals, all-in EV
    // included, say what they say over the engine's rows summed by
    // `aggregate` with the EV rows' adjustment.
    let display = Display::shipped().expect("the shipped definitions");
    let mut got = Sums {
        ev_net_bb_milli: Some(0),
        ..Sums::default()
    };
    for total in reader
        .hero_totals(&HeroFilter::default())
        .expect("hero totals")
    {
        got.add(&total.sums());
    }
    let mut want = aggregate(
        heroes.iter().map(|(_, row, _)| row),
        AggregateOptions::default(),
    );
    let adjustment: i64 = heroes
        .iter()
        .filter(|(_, row, _)| !row.hand.is_bomb_pot && !row.hand.has_cashout)
        .filter_map(|(_, row, ev)| {
            ev.as_ref()
                .filter(|ev| ev.applicable && ev.seat == row.seat.seat)
                .map(|ev| ev.ev_net_bb_milli - row.seat.money.net_bb_milli)
        })
        .sum();
    want.ev_net_bb_milli = Some(want.money[3] + adjustment);
    assert_eq!(got, want);
    assert_ne!(adjustment, 0, "the corpus's hero has evaluated all-ins");
    for stat in &display.stats {
        assert_eq!(
            stat.show(&got, None),
            stat.show(&want, None),
            "{}",
            stat.id()
        );
    }
    let text = |id: &str| {
        display
            .get(id)
            .and_then(|stat| stat.show(&got, None).text)
            .unwrap_or_default()
    };
    eprintln!(
        "hero: {} bb/100, {} all-in EV bb/100",
        text("bb_per_100"),
        text("allin_ev_bb_per_100")
    );
    store.close();
}

/// The thread: pauses for a backfill, computes the queue when let go, keeps
/// rebuilding while tables are open (EV paused), and stops.
#[test]
fn the_worker_pauses_resumes_and_stops() {
    let path = copy_of_corpus("stats-worker");
    let store = Store::open(&path).expect("open");
    let pending = store.reader().stats_status().expect("s").ev_pending;
    let worker = StatsWorker::start(&path, store.writer().expect("writer")).expect("start");
    worker.set_backfill(true);
    let until = |what: &str, done: &dyn Fn(&rail_store::WorkerStatus) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let status = worker.status();
            if done(&status) {
                return status;
            }
            assert!(Instant::now() < deadline, "{what}: {status:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    // The thread started before the pause and may have begun a page (8
    // hands) already: a pause takes effect between steps, never inside one.
    // Once it says it is paused, nothing more is computed.
    until("paused", &|s| s.activity == Activity::PausedBackfill);
    let paused_at = store.reader().stats_status().expect("s").ev_pending;
    assert!(
        pending - paused_at <= u64::from(background::EV_PAGE),
        "at most the page in flight when the pause came"
    );
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        store.reader().stats_status().expect("s").ev_pending,
        paused_at,
        "nothing computed while paused"
    );
    worker.set_backfill(false);
    let done = until("the queue computed", &|s| {
        s.activity == Activity::Idle && s.ev_pending == 0
    });
    assert_eq!(done.ev_computed, pending);
    assert_eq!(done.last_error, None);
    let computed = stats_snapshot(&Connection::open(&path).expect("open"));

    // Tables open (R2.11): a recompute - the statistics and the all-in EV
    // worked out again - waits, and the screens keep what they show.
    worker.set_tables_open(true);
    let total = worker.rebuild_stats().expect("rebuild");
    assert!(total > 0);
    let queued = worker.recompute_ev().expect("recompute");
    assert!(queued > 0);
    until("paused for tables", &|s| {
        s.activity == Activity::PausedTables
    });
    std::thread::sleep(Duration::from_millis(300));
    let status = store.reader().stats_status().expect("s");
    assert_eq!(
        status.rebuild.map(|r| r.done),
        Some(0),
        "no recompute while tables are open"
    );
    assert_eq!(
        status.ev_recompute.map(|r| (r.done, r.total)),
        Some((0, queued))
    );
    assert!(stats_snapshot(&Connection::open(&path).expect("open")) == computed);
    worker.set_tables_open(false);
    until("recomputed", &|s| {
        s.activity == Activity::Idle
            && s.rebuild.is_none()
            && s.ev_recompute.is_none()
            && s.ev_pending == 0
    });
    worker.stop();
    assert_eq!(worker.status().activity, Activity::Stopped);
    drop(worker);
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    assert!(
        stats_snapshot(&conn) == computed,
        "a rebuild and EV computed again give the same statistics"
    );
}
