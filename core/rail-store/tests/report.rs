//! The Today and Reports screens' queries (docs/RAIL-PLAN.md R2.7b) on the
//! corpus: the desktop's numbers are the web's (`tests/data/report-vectors.json`,
//! the web's SQL restated in TypeScript over the TypeScript engine's rows),
//! the graph and the breakdowns are cached until a commit, sessions follow
//! the gap rule, and a store from version 7 gets the list's new columns.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use rail_core::js::JsNumber;
use rail_equity::EV_VERSION;
use rail_stats::display::Display;
use rail_stats::{COUNTER_KEYS, MONEY_KEYS, STATS_VERSION};
use rail_store::import::ImportOptions;
use rail_store::report::{ReportFilter, SESSION_GAP_MINUTES};
use rail_store::time::ms_from_iso;
use rail_store::{HeroSum, HeroTotal, Reader, Store, Totals, background, hand_list, import_file};
use rusqlite::Connection;
use serde_json::Value;

use common::{
    DOWN_FROM_9, PARSED_AT, assert_integrity, corpus_files, repo_root, scratch_dir, stats_snapshot,
};

const REGENERATE: &str = "regenerate the vectors: cd tests && npm run golden:emit, then \
                          node core/rail-store/tests/data/report-vectors.mjs";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// The whole corpus in the store tests' order, with the EV pass run to the
/// end; imported once per test binary.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("report-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        for file in corpus_files() {
            import_file(&store, &file, &options()).expect("import");
        }
        background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
        store.close();
        path
    })
}

/// A `count(*)` over the corpus store.
fn count(sql: &str) -> u64 {
    let n: i64 = Connection::open(corpus_store())
        .expect("open")
        .query_row(sql, [], |row| row.get(0))
        .expect("count");
    u64::try_from(n).expect("count")
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy the corpus store");
    path
}

fn vectors() -> &'static Value {
    static VECTORS: OnceLock<Value> = OnceLock::new();
    VECTORS.get_or_init(|| {
        let path = repo_root().join("core/rail-store/tests/data/report-vectors.json");
        let text = std::fs::read_to_string(&path).expect("report-vectors.json");
        serde_json::from_str(&text).expect("vectors parse")
    })
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| list.iter().filter_map(text).collect())
        .unwrap_or_default()
}

fn filter_of(value: &Value) -> ReportFilter {
    ReportFilter {
        sites: strings(&value["sites"]),
        formats: strings(&value["formats"]),
        stakes: strings(&value["stakes"]),
        positions: strings(&value["positions"]),
        from: text(&value["from"]),
        to: text(&value["to"]),
        ..ReportFilter::default()
    }
}

/// The totals as the vectors list them: every counter, every money column,
/// `money_hands`, by name.
fn columns(totals: &Totals) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (name, value) in COUNTER_KEYS.iter().zip(totals.counters) {
        out.insert((*name).to_owned(), value.to_string());
    }
    for (name, value) in MONEY_KEYS.iter().zip(totals.money) {
        out.insert((*name).to_owned(), value.to_string());
    }
    out.insert("money_hands".to_owned(), totals.money_hands.to_string());
    out
}

fn vector_columns(values: &Value) -> BTreeMap<String, String> {
    let names = strings(&vectors()["meta"]["columns"]);
    names.into_iter().zip(strings(values)).collect()
}

fn js(value: Option<JsNumber>) -> Option<String> {
    value.map(JsNumber::to_js_string)
}

/// `hero_totals`' rows grouped by a key and summed.
fn grouped(totals: &[HeroTotal], key: impl Fn(&HeroTotal) -> String) -> BTreeMap<String, HeroSum> {
    let mut out: BTreeMap<String, HeroSum> = BTreeMap::new();
    for total in totals {
        out.entry(key(total)).or_default().add(total);
    }
    out
}

/// The desktop's reports over the corpus give the web's numbers: the hero's
/// totals and every display definition over them (all-in EV included), the
/// money refusals, the win-rate graph's buckets at two resolutions, the
/// breakdowns by situation and by position, stake, room and format, and the
/// sessions.
#[test]
fn reports_are_the_webs_numbers() {
    let vectors = vectors();
    let meta = &vectors["meta"];
    assert_eq!(
        meta["statsVersion"].as_str(),
        Some(STATS_VERSION),
        "{REGENERATE}"
    );
    assert_eq!(meta["evVersion"].as_str(), Some(EV_VERSION), "{REGENERATE}");
    let store = Store::open(corpus_store()).expect("open");
    let reader = store.reader();
    let display = Display::shipped().expect("definitions");
    let segments: BTreeMap<i64, rail_stats::Segment> = reader
        .segments()
        .expect("segments")
        .into_iter()
        .map(|row| (row.id, row.segment))
        .collect();
    let mut compared = (0, 0, 0, 0);

    let everything = reader
        .report_graph(&ReportFilter::default(), 1)
        .expect("graph");
    let heroes = count("SELECT count(*) FROM hand_list WHERE hero_net IS NOT NULL");
    assert_eq!(
        Some(heroes),
        meta["heroHands"].as_u64(),
        "the store's hero hands are the vectors' ({REGENERATE})"
    );
    assert!(everything.hands > 0);

    for scope in vectors["scopes"].as_array().expect("scopes") {
        let name = scope["name"].as_str().unwrap_or_default();
        let filter = filter_of(&scope["filter"]);
        let graph = reader.report_graph(&filter, 1).expect("graph");
        assert_eq!(Some(graph.hands), scope["hands"].as_u64(), "{name}: hands");
        assert_eq!(
            Some(graph.money_hands),
            scope["moneyHands"].as_u64(),
            "{name}: money hands"
        );
        assert_eq!(
            Some(graph.all_in_hands),
            scope["allInHands"].as_u64(),
            "{name}: all-in hands"
        );
        let units = &scope["units"];
        assert_eq!(
            Some(graph.units.mixed_kind),
            units["mixedKind"].as_bool(),
            "{name}"
        );
        assert_eq!(
            Some(graph.units.mixed_currency),
            units["mixedCurrency"].as_bool(),
            "{name}"
        );
        assert_eq!(graph.units.currency, text(&units["currency"]), "{name}");
        assert_eq!(
            graph.units.minor_units,
            units["minorUnits"].as_i64(),
            "{name}"
        );

        // The summary: the totals, the EV result, every definition.
        let hero = reader.report_hero_filter(&filter).expect("filter");
        let totals = reader.hero_totals(&hero).expect("totals");
        let sum = HeroSum::of(&totals);
        let summary = &scope["summary"];
        assert_eq!(
            columns(&sum.totals),
            vector_columns(&summary["totals"]),
            "{name}: totals"
        );
        let sums = sum.sums();
        assert_eq!(
            sums.ev_net_bb_milli.map(|ev| ev.to_string()),
            text(&summary["evNetBbMilli"]),
            "{name}: all-in EV"
        );
        for (stat, expected) in display
            .stats
            .iter()
            .zip(summary["stats"].as_array().expect("stats"))
        {
            assert_eq!(Some(stat.id()), expected[0].as_str(), "{name}: order");
            let shown = stat.show(&sums, graph.units.money_decimals());
            assert_eq!(js(shown.value), text(&expected[1]), "{name}: {}", stat.id());
            assert_eq!(shown.text, text(&expected[2]), "{name}: {} text", stat.id());
            assert_eq!(
                js(shown.sample),
                text(&expected[3]),
                "{name}: {}",
                stat.id()
            );
            assert_eq!(
                Some(shown.full),
                expected[4].as_bool(),
                "{name}: {}",
                stat.id()
            );
            compared.0 += 1;
        }

        // The graph, bucket by bucket.
        for wanted in scope["graphs"].as_array().expect("graphs") {
            let points = u32::try_from(wanted["points"].as_u64().expect("points")).expect("u32");
            let graph = reader.report_graph(&filter, points).expect("graph");
            let buckets = wanted["buckets"].as_array().expect("buckets");
            assert_eq!(graph.points.len(), buckets.len(), "{name}: {points} points");
            for (index, (point, bucket)) in graph.points.iter().zip(buckets).enumerate() {
                let n = |i: usize| text(&bucket[i]);
                let got = [
                    Some(point.hands.to_string()),
                    Some(point.money_hands.to_string()),
                    point.first_played_at.clone(),
                    point.last_played_at.clone(),
                    Some(point.cum_hands.to_string()),
                    Some(point.cum_money_hands.to_string()),
                    Some(point.cum_net_bb_milli.to_string()),
                    Some(point.cum_sd_bb_milli.to_string()),
                    Some(point.cum_nsd_bb_milli.to_string()),
                    Some(point.cum_ev_bb_milli.to_string()),
                    Some(point.cum_net.to_string()),
                    Some(point.cum_sd_net.to_string()),
                    Some(point.cum_nsd_net.to_string()),
                    Some(point.cum_ev_net.to_string()),
                ];
                for (i, value) in got.iter().enumerate() {
                    assert_eq!(
                        *value,
                        n(i),
                        "{name}: {points} points, bucket {index}, field {i}"
                    );
                }
                compared.1 += 1;
            }
        }
        if graph.units.mixed_kind {
            assert!(
                reader
                    .report_graph(&filter, 60)
                    .expect("graph")
                    .points
                    .is_empty(),
                "{name}: chips with cash draw no graph"
            );
        }

        // The breakdowns by situation...
        let found = reader.report_breakdowns(&filter).expect("breakdowns");
        let breakdowns = &scope["breakdowns"];
        for (what, rows) in [
            ("potType", &found.pot_type),
            ("stack", &found.stack),
            ("handClass", &found.hand_class),
            ("players", &found.players),
            ("street", &found.street),
        ] {
            let expected = breakdowns[what].as_array().expect("breakdown");
            assert_eq!(rows.len(), expected.len(), "{name}: {what} groups");
            for (row, wanted) in rows.iter().zip(expected) {
                assert_eq!(
                    Some(row.key.as_str()),
                    wanted["key"].as_str(),
                    "{name}: {what}"
                );
                assert_eq!(
                    columns(&row.totals),
                    vector_columns(&wanted["totals"]),
                    "{name}: {what} {}",
                    row.key
                );
                compared.2 += 1;
            }
        }
        // ...and by the rollups' dimensions.
        let segment = |t: &HeroTotal| segments.get(&t.segment_id).expect("segment");
        for (what, groups) in [
            ("position", grouped(&totals, |t| t.position.clone())),
            ("stake", grouped(&totals, |t| segment(t).stake.key())),
            ("site", grouped(&totals, |t| segment(t).site.clone())),
            (
                "format",
                grouped(&totals, |t| segment(t).format.as_str().to_owned()),
            ),
        ] {
            let expected = breakdowns[what].as_array().expect("breakdown");
            assert_eq!(
                groups.keys().cloned().collect::<Vec<_>>(),
                expected
                    .iter()
                    .filter_map(|w| text(&w["key"]))
                    .collect::<Vec<_>>(),
                "{name}: {what} groups"
            );
            for ((key, group), wanted) in groups.iter().zip(expected) {
                assert_eq!(
                    columns(&group.totals),
                    vector_columns(&wanted["totals"]),
                    "{name}: {what} {key}"
                );
                assert_eq!(
                    Some(group.ev.bb_milli.to_string()),
                    text(&wanted["evAdjustBbMilli"]),
                    "{name}: {what} {key} EV"
                );
                compared.2 += 1;
            }
        }
    }

    // Sessions over every dated hero hand.
    let sessions = reader
        .sessions(SESSION_GAP_MINUTES, usize::MAX, Some(0))
        .expect("sessions");
    let expected = vectors["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), expected.len(), "sessions");
    for (session, wanted) in sessions.iter().zip(expected) {
        let at = &session.started_at;
        assert_eq!(Some(at.as_str()), wanted["startedAt"].as_str());
        assert_eq!(
            Some(session.ended_at.as_str()),
            wanted["endedAt"].as_str(),
            "{at}"
        );
        assert_eq!(Some(session.hands), wanted["hands"].as_u64(), "{at}");
        assert_eq!(session.tables, wanted["tables"].as_u64(), "{at}");
        let units = &wanted["units"];
        assert_eq!(
            Some(session.units.mixed_kind),
            units["mixedKind"].as_bool(),
            "{at}"
        );
        assert_eq!(
            Some(session.units.mixed_currency),
            units["mixedCurrency"].as_bool(),
            "{at}"
        );
        assert_eq!(
            session.net_bb_milli.map(|v| v.to_string()),
            (!session.units.mixed_kind)
                .then(|| text(&wanted["netBbMilli"]))
                .flatten(),
            "{at}"
        );
        assert_eq!(
            session.net.map(|v| v.to_string()),
            session
                .units
                .money()
                .then(|| text(&wanted["net"]))
                .flatten(),
            "{at}"
        );
        compared.3 += 1;
    }
    eprintln!(
        "report parity: {} statistics, {} graph buckets, {} breakdown rows, {} sessions",
        compared.0, compared.1, compared.2, compared.3
    );
    assert!(compared.0 > 200 && compared.1 > 1000 && compared.2 > 500 && compared.3 > 100);
    store.close();
}

/// The graph's buckets are `ntile`'s; asked for more than there are hands,
/// one a hand; and the graph and the breakdowns are cached until the next
/// commit, then read again.
#[test]
fn graph_buckets_and_the_cache() {
    let path = copy_of_corpus("report-cache");
    let store = Store::open(&path).expect("open");
    let reader = store.reader();
    let cash = ReportFilter {
        formats: vec!["cash".to_owned()],
        ..ReportFilter::default()
    };
    let one = reader.report_graph(&cash, 1).expect("graph");
    assert_eq!(one.points.len(), 1);
    let last = one.points.last().expect("point");
    assert_eq!(last.cum_hands, one.hands);
    assert_eq!(last.cum_money_hands, one.money_hands);
    assert_eq!(
        last.cum_net_bb_milli,
        last.cum_sd_bb_milli + last.cum_nsd_bb_milli
    );
    let hands = usize::try_from(one.hands).expect("hands");
    let all = reader
        .report_graph(&cash, u32::try_from(hands + 5).expect("u32"))
        .expect("graph");
    assert_eq!(all.points.len(), hands.min(4000));
    if hands <= 4000 {
        assert!(all.points.iter().all(|p| p.hands == 1));
    }
    // `ntile`: the first (hands % n) buckets one bigger.
    let seven = reader.report_graph(&cash, 7).expect("graph");
    let sizes: Vec<u64> = seven.points.iter().map(|p| p.hands).collect();
    let (base, extra) = (one.hands / 7, one.hands % 7);
    for (i, size) in sizes.iter().enumerate() {
        assert_eq!(
            *size,
            base + u64::from(u64::try_from(i).expect("i") < extra)
        );
    }
    // The cash total is the hero's totals'.
    let hero = reader.report_hero_filter(&cash).expect("filter");
    let sum = HeroSum::of(&reader.hero_totals(&hero).expect("totals"));
    assert_eq!(
        sum.totals.money("net_bb_milli"),
        Some(last.cum_net_bb_milli)
    );
    assert_eq!(sum.totals.money("net"), Some(last.cum_net));
    assert_eq!(
        sum.sums().ev_net_bb_milli,
        Some(last.cum_ev_bb_milli),
        "the EV line ends at the summary's EV result"
    );

    // Cached...
    let again = reader.report_graph(&cash, 7).expect("graph");
    assert!(Arc::ptr_eq(&seven, &again));
    let breakdowns = reader.report_breakdowns(&cash).expect("breakdowns");
    assert!(Arc::ptr_eq(
        &breakdowns,
        &reader.report_breakdowns(&cash).expect("again")
    ));
    // ...until a commit.
    let writer = store.writer().expect("writer");
    writer
        .write(|tx| hand_list::set_note(tx, "no-such:hand", "a note", 1))
        .expect("note");
    let fresh = reader.report_graph(&cash, 7).expect("graph");
    assert!(!Arc::ptr_eq(&seven, &fresh));
    assert_eq!(*seven, *fresh);
    drop(writer);
    store.close();
}

/// Sessions: the latest is the list's first, with its tables and biggest
/// pots in big blinds; a gap of 0 splits at every new instant; sessions
/// never overlap and hold every dated hero hand.
#[test]
fn sessions_follow_the_gap_rule() {
    let store = Store::open(corpus_store()).expect("open");
    let reader = store.reader();
    let all = reader
        .sessions(SESSION_GAP_MINUTES, usize::MAX, None)
        .expect("sessions");
    assert!(all.len() > 10);
    assert!(
        all.iter()
            .all(|s| s.tables.is_none() && s.biggest_pots.is_empty())
    );
    let latest = reader
        .latest_session(SESSION_GAP_MINUTES, 5)
        .expect("latest")
        .expect("a session");
    assert_eq!(latest.started_at, all[0].started_at);
    assert_eq!(latest.hands, all[0].hands);
    assert!(latest.tables.is_some_and(|t| t > 0));
    let pots = reader.hand_rows(&latest.biggest_pots).expect("rows");
    assert_eq!(pots.len(), latest.biggest_pots.len().min(5));
    let in_bb = |key: &str| {
        let row = pots.iter().find(|r| r.hand_key == key).expect("row");
        (row.total_pot, row.big_blind)
    };
    for pair in latest.biggest_pots.windows(2) {
        let ((pot_a, bb_a), (pot_b, bb_b)) = (in_bb(&pair[0]), in_bb(&pair[1]));
        assert!(
            i128::from(pot_a) * i128::from(bb_b) >= i128::from(pot_b) * i128::from(bb_a),
            "biggest first"
        );
    }
    let mut hands = 0;
    for (newer, older) in all.iter().zip(all.iter().skip(1)) {
        let gap =
            ms_from_iso(&newer.started_at).expect("ms") - ms_from_iso(&older.ended_at).expect("ms");
        assert!(gap > SESSION_GAP_MINUTES * 60_000, "a gap between sessions");
    }
    for session in &all {
        hands += session.hands;
        assert!(session.started_at <= session.ended_at);
    }
    let dated =
        count("SELECT count(*) FROM hand_list WHERE hero_net IS NOT NULL AND played_at <> ''");
    assert_eq!(hands, dated, "every dated hero hand is in one session");
    let instants = count(
        "SELECT count(DISTINCT played_at) FROM hand_list
         WHERE hero_net IS NOT NULL AND played_at <> ''",
    );
    let zero = reader.sessions(0, usize::MAX, None).expect("sessions");
    assert_eq!(u64::try_from(zero.len()).expect("len"), instants);
    assert!(reader.sessions(-1, 1, None).is_err());
    store.close();
}

/// A store from version 7 (the Hands list without the reports' columns)
/// gets them: the migration forgets the statistics version, opening starts
/// a rebuild, and the pass writes the rows an import writes.
#[test]
fn a_version_7_store_gets_the_reports_columns() {
    let reference = stats_snapshot(&Connection::open(corpus_store()).expect("open"));
    let path = copy_of_corpus("report-v7");
    {
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(DOWN_FROM_9).expect("back to version 8");
        conn.execute_batch(
            "ALTER TABLE hand_list DROP COLUMN kind;
             ALTER TABLE hand_list DROP COLUMN hero_wtsd;
             ALTER TABLE hand_list DROP COLUMN currency;
             ALTER TABLE hand_list DROP COLUMN minor_units;
             PRAGMA user_version = 7;",
        )
        .expect("back to version 7");
    }
    let store = Store::open(&path).expect("open");
    let status = store.reader().stats_status().expect("status");
    assert!(status.rebuild.is_some(), "opening starts a rebuild");
    let writer = store.writer().expect("writer");
    background::drain(store.reader(), &writer).expect("drain");
    drop(writer);
    let reader: &Reader = store.reader();
    assert!(reader.report_graph(&ReportFilter::default(), 60).is_ok());
    store.close();
    let conn = Connection::open(&path).expect("open");
    assert_integrity(&conn);
    let upgraded = stats_snapshot(&conn);
    assert!(upgraded.list == reference.list, "the rebuilt list differs");
    assert!(upgraded.seats == reference.seats);
    assert!(upgraded.ev_rows == reference.ev_rows);
}
