//! R3.7: the HUD's reads - a room that allows statistics from the user's
//! own hands only (`ownHandsOnly`), a table's segment, a table's latest
//! hand - and store migration 14 (`player_rollups_observed`,
//! `custom_player_rollups_observed`).
//!
//! The hands: one PokerStars cash hand with no hero (an observed hand: the
//! corpus file as it is) and the same hand under another number with a
//! `Dealt to` line (a hand the user played) - the same six players, the
//! same table and stakes, so every player's rollup in the table's segment
//! counts both and their own-hands part one.

mod common;

use std::path::{Path, PathBuf};

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_stats::custom::CustomDef;
use rail_store::custom::save_custom_stat;
use rail_store::import::ImportOptions;
use rail_store::{Store, Totals, background, import_file};
use rusqlite::Connection;

use common::{PARSED_AT, assert_integrity, assert_rollups, corpus_file, scratch_dir};

const OBSERVED: &str = "fixtures/samples/pokerstars/01-cash-nlhe-6max-ante.txt";

const VPIP: &str = "any street = preflop and not bomb_pot and not (walk and big_blind) \
                    => action in (call, bet, raise)";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// The two hand files in `dir`: (observed, played).
fn hand_files(dir: &Path) -> (PathBuf, PathBuf) {
    let text = std::fs::read_to_string(corpus_file(OBSERVED)).expect("the corpus file");
    assert!(!text.contains("Dealt to"), "the corpus hand has no hero");
    let played = text
        .replace("Game #109681344065", "Game #109681344066")
        .replace(
            "*** HOLE CARDS ***\n",
            "*** HOLE CARDS ***\nDealt to Nightfox82 [Ad 7d]\n",
        );
    assert!(
        played.contains("Dealt to Nightfox82"),
        "the hero line went in"
    );
    let observed_path = dir.join("observed.txt");
    let played_path = dir.join("played.txt");
    std::fs::write(&observed_path, text).expect("write");
    std::fs::write(&played_path, played).expect("write");
    (observed_path, played_path)
}

fn text(value: &str) -> Text {
    Text {
        en: value.to_owned(),
        hr: value.to_owned(),
    }
}

/// A user's statistic with a counter (R2.10): VPIP by predicate.
fn my_vpip() -> CustomDef {
    CustomDef {
        def: StatDef {
            id: "my_vpip".to_owned(),
            group: Group::Preflop,
            players: Players::Any,
            label: text("V"),
            name: text("My VPIP"),
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

/// A store of `files`, with the user's statistic counted.
fn store_of(name: &str, files: &[&Path]) -> (Store, PathBuf) {
    let path = scratch_dir(name).join("rail.db");
    let store = Store::open(&path).expect("open");
    let def = my_vpip();
    store
        .writer()
        .expect("writer")
        .write(move |tx| save_custom_stat(tx, None, &def, 1))
        .expect("save");
    for file in files {
        import_file(&store, file, &options()).expect("import");
    }
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    (store, path)
}

/// The played hand's players as the HUD keys them, and its segment.
fn table_of(store: &Store, played: &Path) -> (String, Vec<(String, String)>, i64) {
    let hand = store
        .reader()
        .newest_hands_of_file(played, 1)
        .expect("newest")
        .pop()
        .expect("the played hand");
    let segment = store
        .reader()
        .hud_hand(&hand.hand_key)
        .expect("hud_hand")
        .expect("a hand with statistics");
    assert_eq!(segment.max_seats, Some(6));
    assert_eq!(segment.segment.segment.site, hand.site);
    let players = hand
        .players
        .into_iter()
        .map(|seat| (seat.player, seat.scope))
        .collect();
    (hand.site, players, segment.segment.id)
}

fn keys(players: &[(String, String)]) -> Vec<(&str, &str)> {
    players
        .iter()
        .map(|(name, scope)| (name.as_str(), scope.as_str()))
        .collect()
}

/// The HUD on a restricted room never counts a hand the user did not play:
/// with an observed hand and a played one, every player's own-hands totals
/// equal - every counter and money column - a store that only ever had the
/// played hand, and the unrestricted totals count both. The user's own
/// statistics the same way.
#[test]
fn own_hands_only_leaves_out_observed_hands() {
    let dir = scratch_dir("observed-files");
    let (observed, played) = hand_files(&dir);
    let (both, both_path) = store_of("observed-both", &[&observed, &played]);
    let (own, own_path) = store_of("observed-own", &[&played]);
    for path in [&both_path, &own_path] {
        let conn = Connection::open(path).expect("open");
        assert_integrity(&conn);
        assert_rollups(&conn);
    }
    let conn = Connection::open(&both_path).expect("open");
    let observed_rows: i64 = conn
        .query_row("SELECT count(*) FROM player_rollups_observed", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(observed_rows, 6, "one row per player of the observed hand");
    let own_conn = Connection::open(&own_path).expect("open");
    let none: i64 = own_conn
        .query_row("SELECT count(*) FROM player_rollups_observed", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(none, 0, "a store of played hands has no observed part");

    let (site, players, segment) = table_of(&both, &played);
    let (own_site, own_players, own_segment) = table_of(&own, &played);
    assert_eq!((&site, &players), (&own_site, &own_players));
    assert_eq!(players.len(), 6);
    let keys = keys(&players);
    let reader = both.reader();
    for segments in [Some(vec![segment]), None] {
        let all = reader
            .hud_totals(&site, &keys, segments.as_deref())
            .expect("all");
        let mine = reader
            .hud_own_totals(&site, &keys, segments.as_deref())
            .expect("own");
        let own_segments = segments.as_ref().map(|_| vec![own_segment]);
        let expected = own
            .reader()
            .hud_totals(&site, &keys, own_segments.as_deref())
            .expect("expected");
        assert!(all.iter().all(|t| t.hands() == 2), "both hands counted");
        assert!(mine.iter().all(|t| t.hands() == 1), "the played one only");
        assert_eq!(mine, expected, "exactly the played hand's sums");
        assert_ne!(mine, all);
    }
    // Another segment: nothing.
    let other = reader
        .hud_own_totals(&site, &keys, Some(&[segment + 1000]))
        .expect("other");
    assert!(other.iter().all(|t| *t == Totals::default()));

    // The user's statistic: counted over both hands, its own-hands part
    // that of the played hand only.
    let stat = reader.custom_stats().expect("stats")[0].id;
    let own_stat = own.reader().custom_stats().expect("stats")[0].id;
    let mut observed_opp = 0;
    for (name, scope) in &players {
        let all = reader
            .custom_player_totals(&site, name, scope, Some(&[segment]), &[stat], false)
            .expect("all");
        let mine = reader
            .custom_player_totals(&site, name, scope, Some(&[segment]), &[stat], true)
            .expect("own");
        let expected = own
            .reader()
            .custom_player_totals(&site, name, scope, Some(&[own_segment]), &[own_stat], false)
            .expect("expected");
        let get = |m: &std::collections::BTreeMap<i64, rail_store::CustomCounts>, id| {
            m.get(&id).copied().unwrap_or_default()
        };
        assert_eq!(get(&mine, stat), get(&expected, own_stat), "{name}");
        observed_opp += get(&all, stat).opp - get(&mine, stat).opp;
    }
    assert_eq!(
        observed_opp, 6,
        "every player had a VPIP chance in the observed hand"
    );
    both.close();
    own.close();
}

/// (R3.8) The HUD popup's "by position" on a restricted room: an
/// opponent's rows by position over the hands the user played only - the
/// same as a store that only ever had the played hand - while the
/// unrestricted rows count both hands.
#[test]
fn positions_from_own_hands_only() {
    let dir = scratch_dir("observed-positions-files");
    let (observed, played) = hand_files(&dir);
    let (both, _) = store_of("observed-positions-both", &[&observed, &played]);
    let (own, _) = store_of("observed-positions-own", &[&played]);
    let (site, players, segment) = table_of(&both, &played);
    let (_, _, own_segment) = table_of(&own, &played);
    let mut checked = 0;
    for (name, _) in players.iter().filter(|(name, _)| name != "Nightfox82") {
        let all = both
            .reader()
            .player_positions(&site, name, Some(&[segment]))
            .expect("all");
        let mine = both
            .reader()
            .player_own_positions(&site, name, Some(&[segment]))
            .expect("own");
        let expected = own
            .reader()
            .player_positions(&site, name, Some(&[own_segment]))
            .expect("expected");
        let hands = |p: &rail_store::players::PlayerPositions| -> i64 {
            p.positions.values().map(Totals::hands).sum()
        };
        assert_eq!(hands(&all), 2, "{name}: both hands");
        assert_eq!(hands(&mine), 1, "{name}: the played one");
        assert_eq!(mine.positions, expected.positions, "{name}");
        checked += 1;
    }
    assert_eq!(checked, 5, "every opponent of the hero");
    both.close();
    own.close();
}

/// A recompute (R2.11) sums the observed part again beside the rest and
/// swaps it in with them: after "rebuild statistics" the rollups, the
/// observed part included, are the sums of the rows.
#[test]
fn the_observed_part_survives_a_recompute() {
    let dir = scratch_dir("observed-recompute-files");
    let (observed, played) = hand_files(&dir);
    let (store, path) = store_of("observed-recompute", &[&observed, &played]);
    let conn = Connection::open(&path).expect("open");
    let before: Vec<Vec<String>> = observed_rows(&conn);
    // Spoil the live observed part: the swap must replace it whole.
    conn.execute("DELETE FROM player_rollups_observed", [])
        .expect("spoil");
    let total = store
        .writer()
        .expect("writer")
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("begin");
    assert!(total > 0);
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    assert_rollups(&conn);
    assert_eq!(observed_rows(&conn), before);
    store.close();
}

fn observed_rows(conn: &Connection) -> Vec<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT site, player, scope, segment_id, hands, vpip, net
             FROM player_rollups_observed ORDER BY 1, 2, 3, 4",
        )
        .expect("prepare");
    stmt.query_map([], |row| {
        (0..7)
            .map(|i| {
                row.get::<_, rusqlite::types::Value>(i)
                    .map(|v| format!("{v:?}"))
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .expect("rows")
    .collect::<Result<_, _>>()
    .expect("collect")
}

/// Migration 14 on a store with hands (a store of version 13): the observed
/// part filled from the seat rows, the user's statistics counted again
/// (their observed part needs the decision events), a rows job the older
/// build left running begun again (its twins had no observed part).
#[test]
fn migration_14_fills_the_observed_part() {
    let dir = scratch_dir("observed-migration-files");
    let (observed, played) = hand_files(&dir);
    let (store, path) = store_of("observed-migration", &[&observed, &played]);
    let (site, players, segment) = table_of(&store, &played);
    let keys = keys(&players);
    let expected = store
        .reader()
        .hud_own_totals(&site, &keys, Some(&[segment]))
        .expect("own");
    // A rows job running when the older build stopped.
    store
        .writer()
        .expect("writer")
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("begin");
    store.close();

    // Back to version 13: as an older build left it.
    let conn = Connection::open(&path).expect("open");
    conn.execute_batch(
        "DROP TABLE player_rollups_observed; DROP TABLE recompute_player_rollups_observed;
         DROP TABLE custom_player_rollups_observed; PRAGMA user_version = 13;",
    )
    .expect("back to 13");
    let counted: i64 = conn
        .query_row("SELECT min(counted_to) FROM custom_stats", [], |row| {
            row.get(0)
        })
        .expect("counted");
    assert!(counted > 0, "the statistic was counted");
    drop(conn);

    let store = Store::open(&path).expect("migrated");
    let conn = Connection::open(&path).expect("open");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, i64::from(rail_store::migrate::LATEST));
    assert_rollups(&conn);
    assert_eq!(
        store
            .reader()
            .hud_own_totals(&site, &keys, Some(&[segment]))
            .expect("own"),
        expected,
        "filled by the migration, before any job ran"
    );
    let counted: i64 = conn
        .query_row("SELECT max(counted_to) FROM custom_stats", [], |row| {
            row.get(0)
        })
        .expect("counted");
    assert_eq!(counted, 0, "the user's statistics are counted again");
    let status = store.reader().stats_status().expect("status");
    assert_eq!(
        status.rebuild.map(|r| r.done),
        Some(0),
        "the rows job begun again"
    );
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    assert_integrity(&conn);
    assert_rollups(&conn);
    assert_eq!(
        store
            .reader()
            .hud_own_totals(&site, &keys, Some(&[segment]))
            .expect("own"),
        expected
    );
    let stat = store.reader().custom_stats().expect("stats")[0].id;
    let mut observed_opp = 0;
    for (name, scope) in &players {
        let all = store
            .reader()
            .custom_player_totals(&site, name, scope, None, &[stat], false)
            .expect("all");
        let mine = store
            .reader()
            .custom_player_totals(&site, name, scope, None, &[stat], true)
            .expect("own");
        observed_opp += all.get(&stat).map_or(0, |c| c.opp) - mine.get(&stat).map_or(0, |c| c.opp);
    }
    assert_eq!(observed_opp, 6, "counted again with their observed part");
    store.close();
}

/// A table's newest stored hand (R3.7: a HUD started while the table is
/// open): the newest imported hand of that site and table, only when played
/// and imported recently enough; the query walks `hands_imported_at_idx`
/// newest first, never sorting.
#[test]
fn a_tables_latest_hand() {
    let dir = scratch_dir("observed-latest-files");
    let (observed, played) = hand_files(&dir);
    let (store, path) = store_of("observed-latest", &[&observed, &played]);
    let reader = store.reader();
    let newest = reader
        .newest_hands_of_file(&played, 1)
        .expect("newest")
        .pop()
        .expect("played");
    let table = newest.table.clone().expect("a table name");
    let same = |name: &str| name == table;
    let long_ago = "2000-01-01T00:00:00.000Z";
    let found = reader
        .latest_hand_of_table("pokerstars", &same, 0, long_ago, 100)
        .expect("lookup")
        .expect("found");
    assert_eq!(found, newest, "the newest of the table, with its seats");
    assert!(found.players.iter().any(|seat| seat.hero));
    // Another table, another site: none.
    assert_eq!(
        reader
            .latest_hand_of_table("pokerstars", &|_| false, 0, long_ago, 100)
            .expect("lookup"),
        None
    );
    assert_eq!(
        reader
            .latest_hand_of_table("winamax", &same, 0, long_ago, 100)
            .expect("lookup"),
        None
    );
    // Played too long ago, or imported too long ago: none.
    assert_eq!(
        reader
            .latest_hand_of_table("pokerstars", &same, 0, "2020-01-01T00:00:00.000Z", 100)
            .expect("lookup"),
        None,
        "the hands were played in 2014"
    );
    let later = rail_store::time::now_ms() + 3_600_000;
    assert_eq!(
        reader
            .latest_hand_of_table("pokerstars", &same, later, long_ago, 100)
            .expect("lookup"),
        None
    );
    // The scan is bounded: with one hand looked at it is the newest.
    assert_eq!(
        reader
            .latest_hand_of_table("pokerstars", &same, 0, long_ago, 1)
            .expect("lookup"),
        Some(newest)
    );
    let conn = Connection::open(&path).expect("open");
    let plan: Vec<String> = conn
        .prepare(
            "EXPLAIN QUERY PLAN SELECT hand_key, table_name, played_at FROM hands
             WHERE imported_at >= ?1 ORDER BY imported_at DESC, rowid DESC LIMIT ?2",
        )
        .expect("plan")
        .query_map([0, 10], |row| row.get::<_, String>(3))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert!(
        plan.iter()
            .any(|step| step.contains("hands_imported_at_idx"))
            && !plan.iter().any(|step| step.contains("TEMP B-TREE")),
        "{plan:?}"
    );
    store.close();
}
