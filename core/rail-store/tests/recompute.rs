//! Targeted recompute (docs/RAIL-PLAN.md R2.11): the dependency map names
//! every derived table; each job writes only what the map says, brings a
//! store whose rows an "older engine" made (rows changed by hand,
//! `common::older`) to exactly what a clean import of the corpus holds,
//! keeps every hand's id and the user's own counts when no seat moved, and
//! readers - reports, the HUD's lookup, the Players list - see the old
//! statistics whole or the new ones whole while it runs, never a mix.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_stats::custom::CustomDef;
use rail_store::background::{self, Step};
use rail_store::custom::save_custom_stat;
use rail_store::import::ImportOptions;
use rail_store::recompute::{
    self, Change, DEPENDENCIES, Extent, RowsJob, Table, Work, apply_rows_page, rows_page,
};
use rail_store::{HeroFilter, PlayerQuery, Reader, ReportFilter, Store, import_file};
use rusqlite::Connection;

use common::{
    PARSED_AT, Rng, assert_integrity, corpus_files, older, scratch_dir, stats_snapshot, table_rows,
    write_rollups,
};

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// The whole corpus, imported and its background pass drained (EV
/// included): the reference every recompute must come back to.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("recompute-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        for file in corpus_files() {
            import_file(&store, &file, &options()).expect("import");
        }
        background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
        store.close();
        path
    })
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

fn text(value: &str) -> Text {
    Text {
        en: value.to_owned(),
        hr: value.to_owned(),
    }
}

const VPIP: &str = "any street = preflop and not bomb_pot and not (walk and big_blind) \
                    => action in (call, bet, raise)";

/// A user's VPIP in the predicate language, saved and counted.
fn save_vpip(store: &Store) -> i64 {
    let def = CustomDef {
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
    };
    let id = store
        .writer()
        .expect("writer")
        .write(move |tx| save_custom_stat(tx, None, &def, 1))
        .expect("save");
    background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    id
}

/// `kv` `stats.epoch`.
fn epoch(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT coalesce((SELECT CAST(value AS INTEGER) FROM kv WHERE key = 'stats.epoch'), 0)",
        [],
        |row| row.get(0),
    )
    .expect("epoch")
}

/// `hand_key` -> `hand_stats.id`.
fn ids(conn: &Connection) -> BTreeMap<String, i64> {
    conn.prepare("SELECT hand_key, id FROM hand_stats")
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("ids")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// The custom tables, as rows.
fn custom_rows(conn: &Connection) -> Vec<Vec<String>> {
    [
        "custom_hero_rows",
        "custom_hero_rollups",
        "custom_player_rollups",
    ]
    .iter()
    .map(|table| table_rows(conn, table))
    .collect()
}

/// Every table a change's line does not name, as rows.
fn untouched(conn: &Connection, change: Change) -> BTreeMap<&'static str, Vec<String>> {
    let line = recompute::dependency(change);
    Table::ALL
        .iter()
        .filter(|table| !line.writes.iter().any(|(written, _)| written == *table))
        .map(|table| (table.name(), table_rows(conn, table.name())))
        .collect()
}

/// Run the rows job page by page; returns (hands, staged hands).
fn run_rows(store: &Store) -> (usize, usize) {
    let writer = store.writer().expect("writer");
    let (mut hands, mut staged) = (0, 0);
    loop {
        let Some(page) = rows_page(store.reader(), &writer).expect("page") else {
            return (hands, staged);
        };
        if page.hands() == 0 {
            writer
                .write(|tx| recompute::finish_rows(tx))
                .expect("finish");
            continue;
        }
        hands += page.hands();
        staged += page.staged();
        assert!(
            writer
                .write(move |tx| apply_rows_page(tx, page))
                .expect("apply"),
            "a page went stale with nothing else running"
        );
    }
}

/* ------------------------------------------------------------------ map - */

/// Tables a definition change never touches: the import's and sync's, the
/// user's words, the definitions, and the recompute's own work tables.
const NOT_DERIVED: &[&str] = &[
    "kv",
    "sources",
    "files",
    "source_totals",
    "source_days",
    "hands",
    "quarantine",
    "unsupported",
    "outbox",
    "sync_rejected",
    "hand_notes",
    "hand_tags",
    "saved_filters",
    "players",
    "player_labels",
    "custom_stats",
];

#[test]
fn the_map_names_every_derived_table_and_every_change() {
    let dir = scratch_dir("recompute-map");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    let tables: BTreeSet<String> = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("tables")
        .collect::<Result<_, _>>()
        .expect("rows");
    let derived: BTreeSet<String> = Table::ALL.iter().map(|t| t.name().to_owned()).collect();
    for table in &tables {
        assert!(
            derived.contains(table)
                || NOT_DERIVED.contains(&table.as_str())
                || table.starts_with("recompute_"),
            "{table}: a table the dependency map does not know"
        );
    }
    for table in &derived {
        assert!(tables.contains(table), "{table}: not in the store");
        assert!(
            DEPENDENCIES
                .iter()
                .any(|line| line.writes.iter().any(|(t, _)| t.name() == table)),
            "{table}: no change writes it"
        );
    }
    // One line per change, and the light ones write nothing.
    for change in [
        Change::Display,
        Change::Formula,
        Change::Predicate,
        Change::Events,
        Change::Stats,
        Change::Segments,
        Change::Ev,
    ] {
        assert_eq!(
            DEPENDENCIES
                .iter()
                .filter(|line| line.change == change)
                .count(),
            1,
            "{change:?}"
        );
    }
    for change in [Change::Display, Change::Formula] {
        let line = recompute::dependency(change);
        assert_eq!((line.work, line.writes.len()), (Work::Nothing, 0));
    }
    let predicate = recompute::dependency(Change::Predicate);
    assert!(
        predicate
            .writes
            .iter()
            .all(|(_, extent)| *extent == Extent::OneStatistic)
    );
    // A segment change derives nothing: the seat rows are not written.
    let segments = recompute::dependency(Change::Segments);
    assert_eq!(segments.work, Work::Regroup);
    assert!(
        !segments
            .writes
            .iter()
            .any(|(t, _)| matches!(t, Table::SeatStats | Table::EvRows | Table::PlayerHands))
    );
    // An EV change writes the EV rows and the list's flag only.
    assert_eq!(
        recompute::dependency(Change::Ev)
            .writes
            .iter()
            .map(|(t, _)| *t)
            .collect::<Vec<_>>(),
        [Table::EvRows, Table::HandList]
    );
    store.close();
}

/* ----------------------------------------------------------------- jobs - */

/// "Rebuild statistics" on a store whose rows are right: every hand is
/// derived and compared, none staged, nothing but the rollups' twins
/// written - and the result is the store as it was.
#[test]
fn a_rebuild_that_finds_nothing_rewrites_nothing() {
    let path = copy_of_corpus("recompute-nothing");
    let conn = Connection::open(&path).expect("open");
    let before = stats_snapshot(&conn);
    let tables: BTreeMap<_, _> = Table::ALL
        .iter()
        .filter(|t| {
            !matches!(
                t,
                Table::PlayerRollups
                    | Table::HeroRollups
                    | Table::PlayerSummary
                    | Table::PlayerHidden
            )
        })
        .map(|t| (t.name(), table_rows(&conn, t.name())))
        .collect();
    let epoch_before = epoch(&conn);
    let store = Store::open(&path).expect("open");
    let total = store
        .writer()
        .expect("writer")
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("begin");
    let (hands, staged) = run_rows(&store);
    assert_eq!(u64::try_from(hands).expect("n"), total);
    assert_eq!(staged, 0, "a hand whose rows are right is not staged");
    let status = store.reader().stats_status().expect("status");
    assert_eq!((status.rebuild, status.epoch), (None, epoch_before + 1));
    store.close();
    assert_integrity(&conn);
    assert!(stats_snapshot(&conn) == before);
    for (table, rows) in tables {
        assert_eq!(table_rows(&conn, table), rows, "{table}");
    }
}

/// A coded counter changed (a `STATS_VERSION` bump): only the hands whose
/// rows come out different are staged and rewritten; the rollups are
/// summed again and swapped in; every hand keeps its id; the user's own
/// counts survive (no seat moved) and nothing is counted again; the tables
/// the map leaves out are untouched.
#[test]
fn a_counter_change_rewrites_only_its_hands() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    let path = copy_of_corpus("recompute-counters");
    let store = Store::open(&path).expect("open");
    let custom = save_vpip(&store);
    store.close();
    let conn = Connection::open(&path).expect("open");
    let mut rng = Rng::new(11);
    let changed = older::counters(&conn, &mut rng, 100);
    assert!(changed.len() > 100, "{} hands changed", changed.len());
    write_rollups(&conn);
    older::stats_version(&conn);
    assert_integrity(&conn);
    let old = stats_snapshot(&conn);
    assert!(old != reference);
    let ids_before = ids(&conn);
    let customs = custom_rows(&conn);
    let kept = untouched(&conn, Change::Stats);
    let epoch_before = epoch(&conn);

    let store = Store::open(&path).expect("open");
    let status = store.reader().stats_status().expect("status");
    let state = status.rebuild.expect("opening starts the rows job");
    assert_eq!((state.job, state.done, state.fills), (RowsJob::Rows, 0, 0));
    // Until the swap the screens read the old statistics, whole.
    assert!(stats_snapshot(&conn) == old);
    let (_, staged) = run_rows(&store);
    assert_eq!(
        staged,
        changed.len(),
        "exactly the changed hands are staged"
    );
    assert_eq!(
        background::drain(store.reader(), &store.writer().expect("writer"))
            .expect("drain")
            .counted,
        0,
        "the user's counts are not counted again"
    );
    let status = store.reader().stats_status().expect("status");
    assert_eq!(
        status.stats_version.as_deref(),
        Some(rail_stats::STATS_VERSION)
    );
    assert_eq!(status.epoch, epoch_before + 1);
    assert_eq!(
        store.reader().custom_progress().expect("progress")[0].remaining,
        0
    );
    store.close();
    assert_integrity(&conn);
    assert!(stats_snapshot(&conn) == reference, "back to a clean import");
    assert_eq!(ids(&conn), ids_before, "every hand keeps its id");
    assert_eq!(custom_rows(&conn), customs, "the user's counts survive");
    assert_eq!(untouched(&conn, Change::Stats), kept);
    let _ = custom;
}

/// The money changed: the hero's result is in the list and the Players
/// list's lines too, and the EV of those hands is decided again.
#[test]
fn a_money_change_rewrites_the_list_rows_and_the_summary() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    let path = copy_of_corpus("recompute-money");
    let conn = Connection::open(&path).expect("open");
    let mut rng = Rng::new(12);
    let changed = older::money(&conn, &mut rng, 150);
    assert!(changed.len() > 100);
    write_rollups(&conn);
    older::stats_version(&conn);
    assert_integrity(&conn);
    let old = stats_snapshot(&conn);
    assert!(old.list != reference.list && old.summary != reference.summary);
    let store = Store::open(&path).expect("open");
    let (_, staged) = run_rows(&store);
    assert_eq!(staged, changed.len());
    store.close();
    assert_integrity(&conn);
    assert!(stats_snapshot(&conn) == reference, "back to a clean import");
}

/// The segment definition changed: the stored seat rows are summed under
/// each hand's segment again - nothing derived, no seat row, EV row or
/// opponent entry written; the user's counts, whose rollups are by
/// segment, are counted again.
#[test]
fn a_segment_change_regroups_the_stored_rows() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    let path = copy_of_corpus("recompute-segments");
    let store = Store::open(&path).expect("open");
    let custom = save_vpip(&store);
    let clean_custom = custom_rows(&Connection::open(&path).expect("open"));
    store.close();
    let conn = Connection::open(&path).expect("open");
    let mut rng = Rng::new(13);
    let changed = older::segments(&conn, &mut rng, 200);
    assert!(changed.len() > 500);
    write_rollups(&conn);
    older::segment_version(&conn);
    assert_integrity(&conn);
    assert!(stats_snapshot(&conn) != reference);
    let kept = untouched(&conn, Change::Segments);

    let store = Store::open(&path).expect("open");
    let state = store
        .reader()
        .stats_status()
        .expect("status")
        .rebuild
        .expect("opening starts the segments job");
    assert_eq!(state.job, RowsJob::Segments);
    let (_, staged) = run_rows(&store);
    assert_eq!(staged, changed.len());
    assert!(
        store
            .reader()
            .custom_progress()
            .expect("progress")
            .iter()
            .all(|p| p.remaining == p.total),
        "a seat moved: the user's counts start again"
    );
    let drained =
        background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    assert!(drained.counted > 0);
    assert_eq!(
        store
            .reader()
            .stats_status()
            .expect("status")
            .stats_version
            .as_deref(),
        Some(rail_stats::STATS_VERSION)
    );
    store.close();
    assert_integrity(&conn);
    assert!(stats_snapshot(&conn) == reference, "back to a clean import");
    assert_eq!(untouched(&conn, Change::Segments), kept);
    assert_eq!(
        custom_rows(&conn),
        clean_custom,
        "counted again to the same"
    );
    let _ = custom;
}

/// The EV changed: every hero hand evaluated again beside the stored rows,
/// which the reports read until the swap; nothing else written.
#[test]
fn an_ev_change_reevaluates_beside_the_rows() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    let path = copy_of_corpus("recompute-ev");
    let conn = Connection::open(&path).expect("open");
    assert!(older::ev(&conn) > 100);
    let old = stats_snapshot(&conn);
    let kept = untouched(&conn, Change::Ev);
    let store = Store::open(&path).expect("open");
    let job = store
        .reader()
        .stats_status()
        .expect("status")
        .ev_recompute
        .expect("opening starts the EV job");
    assert!(job.total > 7000 && job.done == 0, "{job:?}");
    let all = store
        .reader()
        .hero_totals(&HeroFilter::default())
        .expect("totals");
    let writer = store.writer().expect("writer");
    // A few pages: the reports still read the old rows.
    for _ in 0..3 {
        recompute::ev_step(store.reader(), &writer).expect("step");
    }
    assert!(stats_snapshot(&conn) == old);
    assert_eq!(
        store
            .reader()
            .hero_totals(&HeroFilter::default())
            .expect("totals"),
        all
    );
    let evaluated = recompute::run_ev_job(store.reader(), &writer).expect("job");
    assert!(evaluated > 0);
    drop(writer);
    assert_eq!(
        store
            .reader()
            .stats_status()
            .expect("status")
            .ev_version
            .as_deref(),
        Some(rail_equity::EV_VERSION)
    );
    store.close();
    assert_integrity(&conn);
    assert!(stats_snapshot(&conn) == reference, "back to a clean import");
    assert_eq!(untouched(&conn, Change::Ev), kept);
}

/// A store an older build left in the middle of R2.3's rebuild (a newer
/// generation begun, part of the hands still on the older one, the rollups
/// counting only the newer): the rows job finishes it.
#[test]
fn a_rebuild_left_by_an_older_build_is_finished() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    let path = copy_of_corpus("recompute-legacy");
    let conn = Connection::open(&path).expect("open");
    conn.execute_batch(
        "UPDATE kv SET value = '2' WHERE key = 'stats.gen';
         UPDATE hand_stats SET gen = 2 WHERE id % 3 <> 0;
         INSERT INTO kv (key, value, updated_at) VALUES ('stats.rebuild.cursor', 'x', 1),
           ('stats.rebuild.done', '5000', 1), ('stats.rebuild.total', '8000', 1);",
    )
    .expect("an older build's rebuild");
    write_rollups(&conn);
    assert_integrity(&conn);
    let store = Store::open(&path).expect("open");
    let state = store
        .reader()
        .stats_status()
        .expect("status")
        .rebuild
        .expect("a rows job");
    assert!(state.fills > 2000, "{state:?}");
    let (_, staged) = run_rows(&store);
    assert!(staged > 2000);
    store.close();
    assert_integrity(&conn);
    let after = stats_snapshot(&conn);
    assert!(after == reference, "back to a clean import");
    let legacy: i64 = conn
        .query_row(
            "SELECT count(*) FROM kv WHERE key LIKE 'stats.rebuild.%'",
            [],
            |row| row.get(0),
        )
        .expect("kv");
    assert_eq!(legacy, 0);
}

/* ---------------------------------------------------------- consistency - */

/// What the screens and the HUD read, each answer one call (one read
/// transaction, or several connections checked against the epoch): its
/// name and its value as text.
fn answers(reader: &Reader, site: &str, players: &[(String, String)]) -> Answers {
    let players: Vec<(&str, &str)> = players
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    let cash = ReportFilter {
        formats: vec!["cash".to_owned()],
        ..ReportFilter::default()
    };
    vec![
        (
            "hero totals",
            format!(
                "{:?}",
                reader
                    .hero_totals(&HeroFilter::default())
                    .expect("hero totals")
            ),
        ),
        (
            "the HUD's lookup",
            format!(
                "{:?}",
                reader.hud_totals(site, &players, None).expect("hud")
            ),
        ),
        (
            "the Players list",
            format!(
                "{:?}",
                reader
                    .player_list(&PlayerQuery {
                        limit: 50,
                        ..PlayerQuery::default()
                    })
                    .expect("list")
            ),
        ),
        (
            "the breakdowns",
            format!(
                "{:?}",
                reader
                    .report_breakdowns(&ReportFilter::default())
                    .expect("breakdowns")
            ),
        ),
        (
            "Reports opening, cash",
            format!("{:?}", reader.report_open(&cash, 60).expect("open")),
        ),
        (
            "Reports opening, everything",
            format!(
                "{:?}",
                reader
                    .report_open(&ReportFilter::default(), 60)
                    .expect("open")
            ),
        ),
    ]
}

/// The HUD's nine busiest players of the busiest site.
fn hud_table(conn: &Connection) -> (String, Vec<(String, String)>) {
    let site: String = conn
        .query_row(
            "SELECT site FROM player_rollups GROUP BY site ORDER BY sum(hands) DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("site");
    let players = conn
        .prepare(
            "SELECT player, scope FROM player_rollups WHERE site = ?1
             GROUP BY player, scope ORDER BY sum(hands) DESC LIMIT 9",
        )
        .expect("prepare")
        .query_map([&site], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("players")
        .collect::<Result<_, _>>()
        .expect("rows");
    (site, players)
}

/// Each answer's name and value as text.
type Answers = Vec<(&'static str, String)>;

/// Run the background pass while readers - the store's own pool and a
/// second process's `Reader`, as the HUD opens it - ask the screens'
/// questions over and over: each answer is the old one or the new one,
/// never anything else. Returns how many answers of each were seen.
fn watch_recompute(
    path: &Path,
    before: &Answers,
    after: &Answers,
    site: &str,
    players: &[(String, String)],
) -> (usize, usize) {
    let store = Store::open(path).expect("open");
    let hud = Reader::open(path, 2).expect("a second reader");
    let stop = AtomicBool::new(false);
    let (old, new) = (AtomicUsize::new(0), AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for reader in [store.reader(), &hud] {
            let (stop, old, new) = (&stop, &old, &new);
            scope.spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let seen = answers(reader, site, players);
                    for (i, (what, value)) in seen.iter().enumerate() {
                        if *value == before[i].1 {
                            old.fetch_add(1, Ordering::Relaxed);
                        } else if *value == after[i].1 {
                            new.fetch_add(1, Ordering::Relaxed);
                        } else {
                            stop.store(true, Ordering::Relaxed);
                            panic!("{what}: neither the old statistics nor the new");
                        }
                    }
                }
            });
        }
        let writer = store.writer().expect("writer");
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match background::step(store.reader(), &writer, true).expect("step") {
                Step::Nothing => break,
                _ => std::thread::sleep(std::time::Duration::from_millis(2)),
            }
        }
        // A few more rounds after the swap.
        std::thread::sleep(std::time::Duration::from_millis(400));
        stop.store(true, Ordering::Relaxed);
    });
    assert_eq!(answers(store.reader(), site, players), *after);
    store.close();
    (old.into_inner(), new.into_inner())
}

/// Reports, the HUD's lookup and the Players list run while a recompute
/// works and swaps: every answer is the old statistics or the new ones,
/// whole (the rows job: a counter and the money changed; the EV job).
#[test]
fn readers_never_see_a_half_done_recompute() {
    let conn = Connection::open(corpus_store()).expect("open");
    let (site, players) = hud_table(&conn);
    let reference = Store::open(corpus_store()).expect("open");
    let after = answers(reference.reader(), &site, &players);
    reference.close();
    drop(conn);

    // The rows job.
    let path = copy_of_corpus("recompute-readers-rows");
    {
        let conn = Connection::open(&path).expect("open");
        let mut rng = Rng::new(21);
        older::counters(&conn, &mut rng, 150);
        older::money(&conn, &mut rng, 150);
        write_rollups(&conn);
        older::stats_version(&conn);
    }
    let before = {
        let reader = Reader::open(&path, 2).expect("reader");
        answers(&reader, &site, &players)
    };
    for ((what, old), (_, new)) in before.iter().zip(&after) {
        assert!(old != new, "{what}: the older engine's rows do not show");
    }
    let (old, new) = watch_recompute(&path, &before, &after, &site, &players);
    eprintln!("rows job: {old} answers before the swap, {new} after");
    assert!(old > 0 && new > 0);
    assert_integrity(&Connection::open(&path).expect("open"));

    // The EV job.
    let path = copy_of_corpus("recompute-readers-ev");
    older::ev(&Connection::open(&path).expect("open"));
    let before = {
        let reader = Reader::open(&path, 2).expect("reader");
        answers(&reader, &site, &players)
    };
    assert!(before[0].1 != after[0].1, "the EV adjustment differs");
    let (old, new) = watch_recompute(&path, &before, &after, &site, &players);
    eprintln!("EV job: {old} answers before the swap, {new} after");
    assert!(old > 0 && new > 0);
    assert_integrity(&Connection::open(&path).expect("open"));
}
