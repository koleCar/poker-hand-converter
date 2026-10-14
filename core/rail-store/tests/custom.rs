//! The user's own statistics in the store (docs/RAIL-PLAN.md R2.10): the
//! background pass counts a predicate over every stored hand and the sums
//! answer the same filters as the coded statistics' - for the standard
//! counters re-expressed in the language, the very same numbers; edits,
//! renames, deletes and rebuilds keep the counts right; imports are counted
//! as they come; an older store gets the tables.

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_stats::Counter;
use rail_stats::custom::CustomDef;
use rail_store::background;
use rail_store::custom::{apply_custom_page, custom_page, delete_custom_stat, save_custom_stat};
use rail_store::import::ImportOptions;
use rail_store::{CustomCounts, Exclusions, HeroFilter, Store, import_file};
use rusqlite::Connection;

use common::{DOWN_FROM_9, PARSED_AT, assert_integrity, corpus_files, scratch_dir};

const VPIP: &str = "any street = preflop and not bomb_pot and not (walk and big_blind) \
                    => action in (call, bet, raise)";
const CBET: &str = "first street = flop and first_on_street and preflop_aggressor \
                    and barrels = 0 and facing = none and not bomb_pot => action = bet";
const THREE_BET: &str = "first street = preflop and not bomb_pot and not (walk and big_blind) and raise_level = 1 \
     => action = raise";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

fn text(value: &str) -> Text {
    Text {
        en: value.to_owned(),
        hr: value.to_owned(),
    }
}

fn custom(id: &str, predicate: Option<&str>, formula: &str) -> CustomDef {
    CustomDef {
        def: StatDef {
            id: id.to_owned(),
            group: Group::Preflop,
            players: Players::Any,
            label: text("L"),
            name: text("N"),
            description: text("D"),
            formula: formula.to_owned(),
            format: Format {
                unit: Unit::Percent,
                decimals: 1,
            },
            sample: SampleDef { of: None, min: 50 },
            bands: Vec::new(),
            hud: HudPlace::None,
        },
        predicate: predicate.map(str::to_owned),
    }
}

/// Half of the corpus (every other file) and the rest, imported once.
fn corpus_halves() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let files = corpus_files();
    let (mut first, mut second) = (Vec::new(), Vec::new());
    for (i, file) in files.into_iter().enumerate() {
        if i % 2 == 0 {
            first.push(file);
        } else {
            second.push(file);
        }
    }
    (first, second)
}

fn import_into(store: &Store, files: &[PathBuf]) {
    for file in files {
        import_file(store, file, &options()).expect("import");
    }
}

/// The whole corpus, imported once per test binary. Tests copy it.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("custom-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        let (first, second) = corpus_halves();
        import_into(&store, &first);
        import_into(&store, &second);
        store.close();
        path
    })
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

fn save(store: &Store, replacing: Option<&str>, def: &CustomDef) -> i64 {
    let (replacing, def) = (replacing.map(str::to_owned), def.clone());
    store
        .writer()
        .expect("writer")
        .write(move |tx| save_custom_stat(tx, replacing.as_deref(), &def, 1))
        .expect("save")
}

fn drain(store: &Store) -> usize {
    background::drain(store.reader(), &store.writer().expect("writer"))
        .expect("drain")
        .counted
}

/// The coded counters' hero sums over `filter`.
fn coded(store: &Store, filter: &HeroFilter, made: Counter, opp: Counter) -> CustomCounts {
    let mut out = CustomCounts::default();
    for total in store.reader().hero_totals(filter).expect("hero totals") {
        out.made += total.totals.get(made);
        out.opp += total.totals.get(opp);
    }
    out
}

fn ours(store: &Store, filter: &HeroFilter, id: i64) -> CustomCounts {
    store
        .reader()
        .custom_hero_totals(filter, &[id])
        .expect("custom totals")
        .get(&id)
        .copied()
        .unwrap_or_default()
}

/// Filters over the store's dates: everything, ranges with partial days,
/// one day, segments and positions, `aggregate`'s options.
fn filters(store: &Store, conn: &Connection) -> Vec<HeroFilter> {
    let mut played: Vec<String> = conn
        .prepare(
            "SELECT d.played_at FROM hand_stats d
             JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
             WHERE d.played_at IS NOT NULL ORDER BY d.played_at",
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
    let _ = store;
    vec![
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
        HeroFilter {
            from: Some(at(50)),
            to: Some(format!("{}T23:59:59.999Z", &at(50)[..10])),
            ..HeroFilter::default()
        },
        HeroFilter {
            segments: Some(busiest),
            positions: Some(vec!["BTN".to_owned(), "BB".to_owned(), String::new()]),
            from: Some(at(5)),
            to: Some(at(95)),
            ..HeroFilter::default()
        },
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
                cashouts: false,
                no_straddled: true,
            },
            ..HeroFilter::default()
        },
    ]
}

/// Every (site, player, scope, segment) of `player_rollups` with the coded
/// pair, against the custom rollup: the rows that differ.
fn player_differences(conn: &Connection, id: i64, made: &str, opp: &str) -> i64 {
    conn.query_row(
        &format!(
            "SELECT count(*) FROM (
               SELECT p.site, p.player, p.scope, p.segment_id, p.{made} AS made, p.{opp} AS opp
               FROM player_rollups p WHERE p.{opp} > 0 OR p.{made} > 0
             ) a
             FULL OUTER JOIN (
               SELECT site, player, scope, segment_id, made, opp
               FROM custom_player_rollups WHERE stat_id = ?1
             ) b USING (site, player, scope, segment_id)
             WHERE a.made IS NOT b.made OR a.opp IS NOT b.opp"
        ),
        [id],
        |row| row.get(0),
    )
    .expect("compare")
}

fn assert_same(store: &Store, conn: &Connection, id: i64, made: Counter, opp: Counter) {
    for filter in filters(store, conn) {
        let coded = coded(store, &filter, made, opp);
        assert!(coded.opp > 0 || filter.from.is_some(), "{filter:?}");
        assert_eq!(
            ours(store, &filter, id),
            coded,
            "{} over {filter:?}",
            made.name()
        );
    }
    assert_eq!(
        player_differences(conn, id, made.name(), opp.name()),
        0,
        "{}: player rollups",
        made.name()
    );
}

#[test]
fn the_standard_counters_in_the_language_sum_to_the_coded_ones() {
    let path = copy_of_corpus("custom-equal");
    let store = Store::open(&path).expect("open");
    let vpip = save(
        &store,
        None,
        &custom("my_vpip", Some(VPIP), "pct(my_vpip, my_vpip_opp)"),
    );
    let cbet = save(
        &store,
        None,
        &custom("my_cbet", Some(CBET), "pct(my_cbet, my_cbet_opp)"),
    );
    let formula = save(&store, None, &custom("pfr_share", None, "pct(pfr, vpip)"));
    let progress = store.reader().custom_progress().expect("progress");
    assert_eq!(
        progress.len(),
        2,
        "only statistics with a counter are counted"
    );
    assert!(
        progress
            .iter()
            .all(|p| p.remaining == p.total && p.total > 7000)
    );
    let counted = drain(&store);
    assert!(counted > 7000, "{counted}");
    assert!(
        store
            .reader()
            .custom_progress()
            .expect("progress")
            .iter()
            .all(|p| p.remaining == 0)
    );
    let conn = Connection::open(&path).expect("open");
    assert_same(&store, &conn, vpip, Counter::vpip, Counter::vpip_opp);
    assert_same(
        &store,
        &conn,
        cbet,
        Counter::cbet_flop,
        Counter::cbet_flop_opp,
    );
    // A formula-only statistic has no counts.
    assert!(ours(&store, &HeroFilter::default(), formula).opp == 0);
    let saved = store.reader().custom_stats().expect("stats");
    assert_eq!(
        saved
            .iter()
            .map(|s| s.def.def.id.as_str())
            .collect::<Vec<_>>(),
        ["my_vpip", "my_cbet", "pfr_share"]
    );
    store.close();
    assert_integrity(&Connection::open(&path).expect("open"));
}

#[test]
fn edits_renames_deletes_and_rebuilds_keep_the_counts_right() {
    let path = copy_of_corpus("custom-edits");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let id = save(
        &store,
        None,
        &custom("mine", Some(VPIP), "pct(mine, mine_opp)"),
    );
    drain(&store);
    let all = HeroFilter::default();
    let vpip = coded(&store, &all, Counter::vpip, Counter::vpip_opp);
    assert_eq!(ours(&store, &all, id), vpip);

    // A rename (and a new formula) keeps the counts: nothing to count again.
    let renamed = custom("mine_too", Some(VPIP), "pct(mine_too, mine_too_opp) / 2");
    assert_eq!(save(&store, Some("mine"), &renamed), id);
    assert_eq!(drain(&store), 0);
    assert_eq!(ours(&store, &all, id), vpip);

    // Another predicate: the old counts go, the new ones come.
    let three_bet = custom("mine_too", Some(THREE_BET), "pct(mine_too, mine_too_opp)");
    assert_eq!(save(&store, Some("mine_too"), &three_bet), id);
    assert_eq!(ours(&store, &all, id), CustomCounts::default());
    assert!(drain(&store) > 7000);
    let coded_3b = coded(&store, &all, Counter::three_bet, Counter::three_bet_opp);
    assert_same(
        &store,
        &conn,
        id,
        Counter::three_bet,
        Counter::three_bet_opp,
    );

    // A page computed before an edit is not written after it.
    let other = save(
        &store,
        None,
        &custom("other", Some(VPIP), "pct(other, other_opp)"),
    );
    let page = custom_page(store.reader())
        .expect("page")
        .expect("work to do");
    save(
        &store,
        Some("other"),
        &custom("other", Some(CBET), "pct(other, other_opp)"),
    );
    let applied = store
        .writer()
        .expect("writer")
        .write(move |tx| apply_custom_page(tx, &page))
        .expect("apply");
    assert_eq!(applied, 0, "stale");
    drain(&store);
    assert_same(
        &store,
        &conn,
        other,
        Counter::cbet_flop,
        Counter::cbet_flop_opp,
    );

    // A rebuild of the coded statistics gives the hands new ids: everything
    // is counted again after it, to the same numbers.
    store
        .writer()
        .expect("writer")
        .write(|tx| rail_store::stats::begin_rebuild(tx).map(drop))
        .expect("rebuild");
    assert_eq!(ours(&store, &all, id), CustomCounts::default());
    drain(&store);
    assert_eq!(ours(&store, &all, id), coded_3b);
    assert_same(
        &store,
        &conn,
        other,
        Counter::cbet_flop,
        Counter::cbet_flop_opp,
    );

    // A delete takes every count with it.
    let gone = store
        .writer()
        .expect("writer")
        .write(|tx| delete_custom_stat(tx, "mine_too"))
        .expect("delete");
    assert!(gone);
    for table in [
        "custom_hero_rows",
        "custom_hero_rollups",
        "custom_player_rollups",
    ] {
        let left: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE stat_id = ?1"),
                [id],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(left, 0, "{table}");
    }
    // Ids are never reused.
    let next = save(
        &store,
        None,
        &custom("mine", Some(VPIP), "pct(mine, mine_opp)"),
    );
    assert!(next > other);
    store.close();
    assert_integrity(&Connection::open(&path).expect("open"));
}

#[test]
fn imports_are_counted_as_they_come() {
    let path = scratch_dir("custom-incremental").join("rail.db");
    let store = Store::open(&path).expect("open");
    let (first, second) = corpus_halves();
    import_into(&store, &first);
    let id = save(
        &store,
        None,
        &custom("mine", Some(VPIP), "pct(mine, mine_opp)"),
    );
    drain(&store);
    let all = HeroFilter::default();
    assert_eq!(
        ours(&store, &all, id),
        coded(&store, &all, Counter::vpip, Counter::vpip_opp)
    );
    import_into(&store, &second);
    let progress = store.reader().custom_progress().expect("progress");
    assert!(progress[0].remaining > 0, "the new hands wait for the pass");
    let counted = drain(&store);
    assert!(
        counted > 0 && counted < 7000,
        "only the new hands: {counted}"
    );
    let conn = Connection::open(&path).expect("open");
    assert_same(&store, &conn, id, Counter::vpip, Counter::vpip_opp);
    store.close();
}

/// A version-10 store (R2.9, before the custom statistics) gets the tables
/// and counts a statistic saved after the upgrade.
#[test]
fn an_older_store_gets_the_tables() {
    let path = copy_of_corpus("custom-older");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "DROP TABLE custom_stats; DROP TABLE custom_hero_rows;
             DROP TABLE custom_hero_rollups; DROP TABLE custom_player_rollups;
             DELETE FROM kv WHERE key LIKE 'custom.%';
             PRAGMA user_version = 10;",
        )
        .expect("back to version 10");
    }
    let store = Store::open(&path).expect("open");
    assert_eq!(
        store.status().expect("status").schema_version,
        rail_store::migrate::LATEST
    );
    assert!(store.reader().custom_stats().expect("stats").is_empty());
    let id = save(
        &store,
        None,
        &custom("mine", Some(CBET), "pct(mine, mine_opp)"),
    );
    drain(&store);
    let conn = Connection::open(&path).expect("open");
    assert_same(
        &store,
        &conn,
        id,
        Counter::cbet_flop,
        Counter::cbet_flop_opp,
    );
    store.close();
    // And back from the latest version with the shared downgrade.
    let conn = Connection::open(&path).expect("open");
    conn.execute_batch(DOWN_FROM_9).expect("back to version 8");
}

/// What the background pass costs (docs/RAIL-PLAN.md R2.10 *As built*): the
/// corpus counted for one statistic, then for three more at once. Run
/// optimised, `cargo test --release -p rail-store --test custom -- --ignored
/// --nocapture`.
#[test]
#[ignore = "a measurement, not a check"]
fn the_pass_counts_this_fast() {
    use std::time::Instant;
    let path = copy_of_corpus("custom-speed");
    let store = Store::open(&path).expect("open");
    let hands = store.status().expect("status").hands;
    // The rest of the pass first (the EV queue, the players' index).
    drain(&store);
    save(
        &store,
        None,
        &custom("one", Some(VPIP), "pct(one, one_opp)"),
    );
    let started = Instant::now();
    let counted = drain(&store);
    let one = started.elapsed();
    for (id, predicate) in [("two", CBET), ("three", THREE_BET), ("four", VPIP)] {
        save(
            &store,
            None,
            &custom(id, Some(predicate), &format!("pct({id}, {id}_opp)")),
        );
    }
    let started = Instant::now();
    drain(&store);
    let three = started.elapsed();
    let per = |took: std::time::Duration| took / u32::try_from(counted.max(1)).unwrap_or(1);
    println!(
        "{hands} hands stored, {counted} counted: one statistic {one:?} ({:?} a hand), \
         three more at once {three:?} ({:?} a hand)",
        per(one),
        per(three)
    );
    store.close();
}
