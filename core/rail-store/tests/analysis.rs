//! The hand analysis in the store (docs/RAIL-PLAN.md R5.4, migration 16) on
//! the corpus: the runner's read side walks every hand once, newest first,
//! across pages and versions; a save replaces a hand's row, computes the
//! aggregates as the web's `save_hand_analysis` does and reads back in the
//! shape of `analysis_hand`; hands analysed without the flop library come
//! back once it can be reached; the opponents' counters are the web's
//! `villain_counters`; and the chart sets keep their limits.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rail_store::analysis::{CHART_SETS_MAX, PENDING_MAX};
use rail_store::import::ImportOptions;
use rail_store::{
    ChartSetRow, DecisionRowIn, Error, HandAnalysisIn, PendingCursor, Store, background,
    import_file,
};
use rusqlite::Connection;
use serde_json::{Value, json};

use common::{PARSED_AT, corpus_files, scratch_dir};

const V1: &str = "analysis/34";
const V2: &str = "analysis/35";

fn options() -> ImportOptions {
    ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    }
}

/// The whole corpus with its players indexed, imported once per binary.
fn corpus_store() -> &'static Path {
    static STORE: OnceLock<PathBuf> = OnceLock::new();
    STORE.get_or_init(|| {
        let path = scratch_dir("analysis-corpus").join("corpus.db");
        let store = Store::open(&path).expect("open");
        for file in corpus_files() {
            import_file(&store, &file, &options()).expect("import");
        }
        let writer = store.writer().expect("writer");
        loop {
            match background::step(store.reader(), &writer, false).expect("step") {
                background::Step::Nothing => break,
                _ => continue,
            }
        }
        drop(writer);
        store.close();
        path
    })
}

fn copy_of_corpus(name: &str) -> PathBuf {
    let path = scratch_dir(name).join("rail.db");
    std::fs::copy(corpus_store(), &path).expect("copy");
    path
}

/// Every hand key in the runner's order: newest first, undated last.
fn expected_order(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT hand_key FROM hands
             ORDER BY played_at IS NULL, played_at DESC, hand_key DESC",
        )
        .expect("prepare");
    stmt.query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// Every pending hand, page by page.
fn walk(store: &Store, version: &str, page: u32) -> Vec<String> {
    let mut out = Vec::new();
    let mut after: Option<PendingCursor> = None;
    loop {
        let rows = store
            .reader()
            .analysis_pending(version, after.as_ref(), page)
            .expect("pending");
        if rows.is_empty() {
            return out;
        }
        assert!(rows.len() <= page as usize);
        for row in &rows {
            let phf: Value = serde_json::from_str(&row.phf).expect("PHF is JSON");
            assert!(
                phf.get("actions").is_some(),
                "{} is a PHF hand",
                row.hand_key
            );
        }
        let last = rows.last().expect("a row");
        after = Some(PendingCursor {
            played_at: last.played_at.clone(),
            hand_key: last.hand_key.clone(),
        });
        out.extend(rows.into_iter().map(|row| row.hand_key));
    }
}

fn decision(ord: i64, street: &str, grade: Option<&str>, flags: Value) -> DecisionRowIn {
    DecisionRowIn {
        ord,
        action_index: ord * 2 + 3,
        street: street.to_owned(),
        action: "call".to_owned(),
        status: if grade.is_some() {
            "analysed"
        } else {
            "not-analysed"
        }
        .to_owned(),
        reason: if grade.is_some() {
            None
        } else {
            Some("no-reference".to_owned())
        },
        node: "BB vs BTN open".to_owned(),
        scenario: "vs-open".to_owned(),
        source: "chart".to_owned(),
        grade: grade.map(str::to_owned),
        score: grade.map(|_| 87.5),
        ev_loss_bb: grade.map(|_| 0.125),
        ev_loss_pot: grade.map(|_| 0.0125),
        freq_diff: None,
        options: json!([{"action": "call", "freq": 0.6, "ev": 1.5}, {"action": "fold", "freq": 0.4, "ev": 0.0}]),
        chosen: Some(0),
        flags,
        approximations: vec!["population-ranges".to_owned()],
        facing_bet: true,
        pot_bb: Some(5.5),
        pot_odds: Some(0.25),
        mdf: Some(0.667),
        facts: json!({"scenario": "vs-open", "position": "BB", "chart": {"line": "ffffr", "set": "nlhe-cash-6max-100bb"}}),
        spot_key: "preflop|vs-open|ffffr|BB|call|call".to_owned(),
        chart_set: "nlhe-cash-6max-100bb".to_owned(),
        best: "call".to_owned(),
        preflop: (street == "preflop").then(|| rail_store::PreflopFields {
            chart_key: "vs-open:BB:BTN".to_owned(),
            chart_table: 6,
            hand_class: 21,
            chart_action: "call".to_owned(),
            depth_band: 100,
        }),
    }
}

fn row(
    hand_key: &str,
    version: &str,
    flop_library: bool,
    decisions: Vec<DecisionRowIn>,
) -> HandAnalysisIn {
    HandAnalysisIn {
        hand_key: hand_key.to_owned(),
        analysis_version: version.to_owned(),
        status: "partial".to_owned(),
        reason: None,
        hero_seat: Some(3),
        grade: Some("mistake".to_owned()),
        score: Some(42.25),
        ev_loss_bb: Some(1.5),
        ev_loss_pot: Some(0.2),
        approximations: vec![],
        pot_type: "single-raised".to_owned(),
        hero_position: Some("BB".to_owned()),
        flop_library,
        decisions,
    }
}

#[test]
fn pending_walks_every_hand_once_newest_first() {
    let path = copy_of_corpus("analysis-walk");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let expected = expected_order(&conn);
    assert!(
        expected.len() > 7_000,
        "the corpus is in: {}",
        expected.len()
    );
    // Pages of the largest size and of an awkward one cover the same hands
    // in the same order, each once.
    let all = walk(&store, V1, PENDING_MAX);
    assert_eq!(all, expected);
    assert_eq!(walk(&store, V1, 37), expected);
    let counts = store.reader().analysis_counts(V1).expect("counts");
    assert_eq!(counts.hands, expected.len() as u64);
    assert_eq!(
        (counts.current, counts.stale, counts.missing()),
        (0, 0, expected.len() as u64)
    );

    // Analysed hands drop out; the rest keep their order.
    let writer = store.writer().expect("writer");
    let done: Vec<String> = expected.iter().step_by(3).cloned().collect();
    for chunk in done.chunks(200) {
        let rows = chunk.iter().map(|key| row(key, V1, true, vec![])).collect();
        let outcome = writer.save_analysis(rows, 1_000).expect("save");
        assert_eq!(outcome.saved, chunk.len() as u64);
    }
    let done_set: BTreeSet<&String> = done.iter().collect();
    let left: Vec<String> = expected
        .iter()
        .filter(|k| !done_set.contains(k))
        .cloned()
        .collect();
    assert_eq!(walk(&store, V1, 200), left);
    let counts = store.reader().analysis_counts(V1).expect("counts");
    assert_eq!(
        (counts.current, counts.missing()),
        (done.len() as u64, left.len() as u64)
    );

    // A version bump: every hand is pending again, the old rows are stale.
    assert_eq!(walk(&store, V2, 200), expected);
    let counts = store.reader().analysis_counts(V2).expect("counts");
    assert_eq!((counts.current, counts.stale), (0, done.len() as u64));

    // Hands without statistics (a rebuild filling them) come last, by key.
    conn.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
    let unlisted: Vec<String> = [5, 900, 3000]
        .iter()
        .map(|&i| expected[i].clone())
        .collect();
    for key in &unlisted {
        conn.execute("DELETE FROM hand_stats WHERE hand_key = ?1", [key])
            .expect("delete");
    }
    let mut want: Vec<String> = expected
        .iter()
        .filter(|k| !unlisted.contains(k))
        .cloned()
        .collect();
    let mut rest = unlisted.clone();
    rest.sort_by(|a, b| b.cmp(a));
    want.extend(rest);
    assert_eq!(walk(&store, V2, 200), want);
    assert_eq!(walk(&store, V2, 7), want);
    drop(writer);
    store.close();
}

#[test]
fn a_save_replaces_the_row_and_reads_back_as_analysis_hand() {
    let path = copy_of_corpus("analysis-save");
    let store = Store::open(&path).expect("open");
    let writer = store.writer().expect("writer");
    let first = store
        .reader()
        .analysis_pending(V1, None, 2)
        .expect("pending");
    let (a, b) = (first[0].hand_key.clone(), first[1].hand_key.clone());

    let decisions = vec![
        decision(0, "preflop", Some("good"), json!([])),
        decision(
            1,
            "flop",
            Some("mistake"),
            json!([{"code": "thin-value", "severity": "note"}]),
        ),
        decision(
            2,
            "turn",
            None,
            json!([{"code": "a", "severity": "note"}, {"code": "b", "severity": "inaccurate"}]),
        ),
    ];
    let outcome = writer
        .save_analysis(
            vec![
                row(&a, V1, true, decisions.clone()),
                row("no-such-hand", V1, true, vec![]),
            ],
            1_234,
        )
        .expect("save");
    assert_eq!((outcome.saved, outcome.missing), (1, 1));

    let stored = store
        .reader()
        .hand_analysis(&a)
        .expect("read")
        .expect("a row");
    assert_eq!(stored["analysisVersion"], json!(V1));
    assert_eq!(stored["status"], json!("partial"));
    assert_eq!(stored["heroSeat"], json!(3));
    assert_eq!(stored["grade"], json!("mistake"));
    assert_eq!(stored["score"], json!(42.25));
    assert_eq!(stored["evLossBb"], json!(1.5));
    assert_eq!(stored["potType"], json!("single-raised"));
    assert_eq!(stored["flopLibrary"], json!(true));
    assert_eq!(stored["analysedAt"], json!(1_234));
    // The aggregates are the store's, from the decisions.
    assert_eq!(stored["flagCount"], json!(3));
    assert_eq!(stored["worstFlag"], json!("inaccurate"));
    let read: &Vec<Value> = stored["decisions"].as_array().expect("decisions");
    assert_eq!(read.len(), 3);
    assert_eq!(read[1]["ord"], json!(1));
    assert_eq!(read[1]["actionIndex"], json!(5));
    assert_eq!(read[1]["grade"], json!("mistake"));
    assert_eq!(read[1]["worstFlag"], json!("note"));
    assert_eq!(read[2]["worstFlag"], json!("inaccurate"));
    assert_eq!(read[2]["reason"], json!("no-reference"));
    assert_eq!(read[0]["options"], decisions[0].options);
    assert_eq!(read[0]["facts"], decisions[0].facts);
    assert_eq!(read[0]["approximations"], json!(["population-ranges"]));
    assert_eq!(read[0]["evLossPot"], json!(0.0125));

    let conn = Connection::open(&path).expect("open");
    let (decisions_n, analysed, graded): (i64, i64, i64) = conn
        .query_row(
            "SELECT decisions, analysed, graded FROM hand_analysis WHERE hand_key = ?1",
            [&a],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("row");
    assert_eq!((decisions_n, analysed, graded), (3, 2, 2));
    let ranks: Vec<i64> = conn
        .prepare("SELECT grade_rank FROM decision_analysis WHERE hand_key = ?1 ORDER BY ord")
        .expect("prepare")
        .query_map([&a], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(ranks, vec![2, 4, 0]);
    // The narrow rows: a leak row per graded decision, a chart row per
    // preflop chart decision, with the hand's time and format.
    let (played_at, format): (String, String) = conn
        .query_row(
            "SELECT coalesce(played_at, ''), game_format FROM hands WHERE hand_key = ?1",
            [&a],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("hand");
    type Leak = (i64, String, String, String, String, String, String, f64);
    let leaks: Vec<Leak> = conn
        .prepare(
            "SELECT ord, analysis_version, played_at, game_format, hero_position, spot_key, grade,
                    ev_loss_bb
             FROM analysis_leak_rows WHERE hand_key = ?1 ORDER BY ord",
        )
        .expect("prepare")
        .query_map([&a], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(leaks.len(), 2, "the two graded decisions");
    assert_eq!(
        leaks[0],
        (
            0,
            V1.to_owned(),
            played_at.clone(),
            format.clone(),
            "BB".to_owned(),
            "preflop|vs-open|ffffr|BB|call|call".to_owned(),
            "good".to_owned(),
            0.125
        )
    );
    assert_eq!(leaks[1].6, "mistake");
    type Chart = (i64, String, i64, i64, String, i64, String, String);
    let charts: Vec<Chart> = conn
        .prepare(
            "SELECT ord, chart_key, table_size, hand_class, action, depth_band, position, played_at
             FROM chart_decisions WHERE hand_key = ?1 ORDER BY ord",
        )
        .expect("prepare")
        .query_map([&a], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert_eq!(
        charts,
        vec![(
            0,
            "vs-open:BB:BTN".to_owned(),
            6,
            21,
            "call".to_owned(),
            100,
            "BB".to_owned(),
            played_at
        )],
        "the preflop decision only"
    );

    // Analysed again (a version bump): the row and its decisions are replaced.
    writer
        .save_analysis(
            vec![row(
                &a,
                V2,
                false,
                vec![decision(0, "flop", Some("perfect"), json!([]))],
            )],
            2_000,
        )
        .expect("save again");
    let stored = store
        .reader()
        .hand_analysis(&a)
        .expect("read")
        .expect("a row");
    assert_eq!(stored["analysisVersion"], json!(V2));
    assert_eq!(stored["decisions"].as_array().map(Vec::len), Some(1));
    assert_eq!(stored["worstFlag"], Value::Null);
    assert_eq!(stored["flagCount"], json!(0));
    assert!(store.reader().hand_analysis(&b).expect("read").is_none());

    // Analysed without the flop library, with a flop decision: offered
    // again once the library can be reached; one without a flop decision is not.
    writer
        .save_analysis(
            vec![row(
                &b,
                V2,
                false,
                vec![decision(0, "preflop", Some("good"), json!([]))],
            )],
            3_000,
        )
        .expect("save b");
    let offline: Vec<String> = store
        .reader()
        .analysis_offline(V2, 50)
        .expect("offline")
        .into_iter()
        .map(|hand| hand.hand_key)
        .collect();
    assert_eq!(offline, vec![a.clone()]);
    assert_eq!(
        store.reader().analysis_counts(V2).expect("counts").offline,
        1
    );
    writer
        .save_analysis(
            vec![row(
                &a,
                V2,
                true,
                vec![decision(0, "flop", Some("good"), json!([]))],
            )],
            4_000,
        )
        .expect("save with the library");
    assert!(
        store
            .reader()
            .analysis_offline(V2, 50)
            .expect("offline")
            .is_empty()
    );

    // A hand deleted takes its analysis with it.
    conn.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
    conn.execute("DELETE FROM hands WHERE hand_key = ?1", [&a])
        .expect("delete");
    assert!(store.reader().hand_analysis(&a).expect("read").is_none());
    let left: i64 = conn
        .query_row(
            "SELECT count(*) FROM decision_analysis WHERE hand_key = ?1",
            [&a],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(left, 0);

    // Malformed rows are refused, whole.
    let mut bad = row(&b, V2, true, vec![]);
    bad.analysis_version = "v2".to_owned();
    assert!(matches!(
        writer.save_analysis(vec![bad], 0),
        Err(Error::OutOfRange(_))
    ));
    let mut bad = row(
        &b,
        V2,
        true,
        vec![decision(0, "flop", Some("great"), json!([]))],
    );
    bad.grade = None;
    assert!(writer.save_analysis(vec![bad], 0).is_err());
    let bad = row(&b, V2, true, vec![decision(0, "flop", None, json!({}))]);
    assert!(writer.save_analysis(vec![bad], 0).is_err());
    for spoil in [
        |p: &mut rail_store::PreflopFields| p.chart_table = 7,
        |p: &mut rail_store::PreflopFields| p.hand_class = 169,
        |p: &mut rail_store::PreflopFields| p.chart_action = "bet".to_owned(),
        |p: &mut rail_store::PreflopFields| p.depth_band = 1000,
    ] {
        let mut d = decision(0, "preflop", Some("good"), json!([]));
        spoil(d.preflop.as_mut().expect("preflop fields"));
        assert!(
            writer
                .save_analysis(vec![row(&b, V2, true, vec![d])], 0)
                .is_err()
        );
    }
    let many = (0..201)
        .map(|i| row(&format!("k{i}"), V2, true, vec![]))
        .collect();
    assert!(writer.save_analysis(many, 0).is_err());
    let stored = store
        .reader()
        .hand_analysis(&b)
        .expect("read")
        .expect("b kept");
    assert_eq!(stored["analysedAt"], json!(3_000));

    assert_eq!(writer.clear_analysis().expect("clear"), 1);
    assert_eq!(
        store.reader().analysis_counts(V2).expect("counts").current,
        0
    );
    drop(writer);
    store.close();
}

#[test]
fn villain_counters_are_the_opponents_own_cash_rows() {
    let store = Store::open(copy_of_corpus("analysis-villains")).expect("open");
    let conn = Connection::open(store.path()).expect("open");
    // Opponents of rooms with real names that never sat as the hero: their
    // rollups (every seat row of theirs, bomb pots out) in cash segments
    // are exactly their villain rows.
    let heroes: BTreeSet<(String, String)> = conn
        .prepare(
            "SELECT DISTINCT d.site_id, s.player FROM seat_stats s
             JOIN hand_stats d ON d.id = s.hand_id WHERE s.is_hero = 1",
        )
        .expect("prepare")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let mut expected: BTreeMap<(String, String), [i64; 4]> = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT r.site, r.player, r.hands, r.vpip_opp, r.vpip, r.pfr
             FROM player_rollups r JOIN segments g ON g.id = r.segment_id
             WHERE g.game_format = 'cash' AND r.scope = '' AND r.player <> ''
               AND EXISTS (SELECT 1 FROM player_hands p WHERE p.player = r.player)",
        )
        .expect("prepare");
    let mut rows = stmt.query([]).expect("query");
    while let Some(r) = rows.next().expect("row") {
        let key: (String, String) = (r.get(0).expect("site"), r.get(1).expect("player"));
        let sum = expected.entry(key).or_insert([0; 4]);
        for (i, slot) in sum.iter_mut().enumerate() {
            *slot += r.get::<_, i64>(i + 2).expect("counter");
        }
    }
    let candidates: Vec<(String, String)> = expected
        .keys()
        .filter(|key| !heroes.contains(*key))
        .cloned()
        .collect();
    assert!(
        candidates.len() > 50,
        "enough opponents: {}",
        candidates.len()
    );
    let mut asked = 0;
    for chunk in candidates.chunks(500) {
        let got = store
            .reader()
            .villain_counters(chunk, Some("cash"), 1)
            .expect("counters");
        let got: BTreeMap<(String, String), [i64; 4]> = got
            .into_iter()
            .map(|v| ((v.site, v.player), [v.hands, v.vpip_opp, v.vpip, v.pfr]))
            .collect();
        for key in chunk {
            let want = expected[key];
            if want[0] == 0 {
                continue;
            }
            assert_eq!(got.get(key), Some(&want), "{key:?}");
            asked += 1;
        }
    }
    assert!(asked > 50);
    // The minimum sample, an unknown player, the hero's own rows and the cap.
    let (key, want) = expected
        .iter()
        .find(|(key, sum)| !heroes.contains(*key) && sum[0] >= 2)
        .expect("an opponent with two hands");
    let ask = vec![
        key.clone(),
        ("pokerstars".to_owned(), "nobody-at-all".to_owned()),
    ];
    let got = store
        .reader()
        .villain_counters(&ask, Some("cash"), want[0])
        .expect("counters");
    assert_eq!(got.len(), 1);
    let got = store
        .reader()
        .villain_counters(&ask, Some("cash"), want[0] + 1)
        .expect("counters");
    assert!(got.is_empty());
    let hero = heroes.iter().next().expect("a hero").clone();
    let got = store
        .reader()
        .villain_counters(std::slice::from_ref(&hero), None, 1)
        .expect("counters");
    assert!(
        got.iter()
            .all(|v| (v.site.clone(), v.player.clone()) != hero || !expected.contains_key(&hero)),
        "the hero's own rows are never villain rows"
    );
    let too_many: Vec<(String, String)> = (0..501)
        .map(|i| ("x".to_owned(), format!("p{i}")))
        .collect();
    assert!(store.reader().villain_counters(&too_many, None, 1).is_err());
    store.close();
}

#[test]
fn chart_sets_are_kept_with_their_limits() {
    let dir = scratch_dir("analysis-charts");
    let store = Store::open(dir.join("rail.db")).expect("open");
    let writer = store.writer().expect("writer");
    let set = |id: &str| ChartSetRow {
        id: id.to_owned(),
        name: format!("Set {id}"),
        game_format: "cash".to_owned(),
        table_size: 6,
        stack_min_bb: 80,
        stack_max_bb: 120,
        format_version: 1,
        nodes: r#"{"rfi:CO":{"raise":"AAAA"}}"#.to_owned(),
        node_count: 0,
        created_at: 0,
        updated_at: 0,
    };
    assert_eq!(writer.save_chart_set(set("a"), 10).expect("save"), 10);
    let mut renamed = set("a");
    renamed.name = "Renamed".to_owned();
    assert_eq!(writer.save_chart_set(renamed, 20).expect("save"), 20);
    let listed = store.reader().chart_sets().expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (
            listed[0].name.as_str(),
            listed[0].created_at,
            listed[0].updated_at,
            listed[0].node_count
        ),
        ("Renamed", 10, 20, 1)
    );
    assert!(listed[0].nodes.is_empty(), "a listing leaves the nodes out");
    let loaded = store.reader().chart_set("a").expect("load").expect("there");
    assert_eq!(loaded.nodes, r#"{"rfi:CO":{"raise":"AAAA"}}"#);
    let mut bad = set("b");
    bad.nodes = "[]".to_owned();
    assert!(writer.save_chart_set(bad, 0).is_err());
    let mut bad = set("b");
    bad.table_size = 7;
    assert!(writer.save_chart_set(bad, 0).is_err());
    for i in 1..CHART_SETS_MAX {
        writer
            .save_chart_set(set(&format!("s{i}")), 30)
            .expect("save");
    }
    assert!(writer.save_chart_set(set("one-too-many"), 40).is_err());
    assert!(
        writer.save_chart_set(set("s1"), 50).is_ok(),
        "an update is not a new set"
    );
    assert!(writer.delete_chart_set("a").expect("delete"));
    assert!(!writer.delete_chart_set("a").expect("delete again"));
    assert!(store.reader().chart_set("a").expect("load").is_none());
    drop(writer);
    store.close();
}

/* ------------------------------------------------- the session review - */

/// The hero's dated hands (bomb pots out) in time order, cut into sessions
/// at breaks longer than `gap_ms`: (first, last, hand keys).
fn expected_sessions(conn: &Connection, gap_ms: i64) -> Vec<(String, String, Vec<String>)> {
    let mut stmt = conn
        .prepare(
            "SELECT played_at, hand_key FROM hand_list
             WHERE hero_net IS NOT NULL AND played_at > '' AND (kind & 1) = 0
             ORDER BY played_at, hand_key",
        )
        .expect("prepare");
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let mut out: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut last_ms = i64::MIN;
    for (played_at, key) in rows {
        let Some(ms) = rail_store::time::ms_from_iso(&played_at) else {
            continue;
        };
        match out.last_mut() {
            Some(session) if ms - last_ms <= gap_ms => {
                session.1 = played_at;
                session.2.push(key);
            }
            _ => out.push((played_at.clone(), played_at, vec![key])),
        }
        last_ms = ms;
    }
    out
}

fn graded(ord: i64, street: &str, source: &str, grade: &str, ev: f64) -> DecisionRowIn {
    let mut d = decision(ord, street, Some(grade), json!([]));
    d.source = source.to_owned();
    d.ev_loss_bb = Some(ev);
    if street != "preflop" || source != "chart" {
        d.preflop = None;
    }
    d
}

#[test]
fn the_session_review_reads_the_webs_sessions_and_lists() {
    use rail_store::review::{CompareQuery, ReviewQuery};
    let path = copy_of_corpus("analysis-review");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    let gap_ms = 30 * 60_000;
    let expected = expected_sessions(&conn, gap_ms);
    assert!(
        expected.len() > 20,
        "sessions in the corpus: {}",
        expected.len()
    );

    // The picker: every session, newest first.
    let listed = store
        .reader()
        .review_sessions(30, None, 10_000)
        .expect("sessions");
    let bounds: Vec<(String, String, usize)> = listed
        .iter()
        .rev()
        .map(|s| {
            (
                s.started_at.clone(),
                s.ended_at.clone(),
                usize::try_from(s.hands).expect("hands"),
            )
        })
        .collect();
    let want: Vec<(String, String, usize)> = expected
        .iter()
        .map(|s| (s.0.clone(), s.1.clone(), s.2.len()))
        .collect();
    assert_eq!(bounds, want);

    // Each session from any instant in it, with its neighbours' instants.
    let last_ms =
        rail_store::time::ms_from_iso(&expected.last().expect("a session").1).expect("ms");
    let query = |at: Option<&str>, now_ms: i64| ReviewQuery {
        at: at.map(str::to_owned),
        gap_minutes: 30,
        limit: 20,
        version: V1.to_owned(),
        now_ms,
    };
    for (i, (start, end, keys)) in expected.iter().enumerate().step_by(7) {
        let review = store
            .reader()
            .session_review(&query(Some(end), last_ms + 10 * gap_ms))
            .expect("review");
        let session = &review["session"];
        assert_eq!(session["startedAt"], json!(start), "session {i}");
        assert_eq!(session["endedAt"], json!(end), "session {i}");
        assert_eq!(session["hands"], json!(keys.len()), "session {i}");
        let previous = i.checked_sub(1).map(|p| expected[p].1.clone());
        let next = expected.get(i + 1).map(|n| n.0.clone());
        assert_eq!(session["previousAt"], json!(previous), "session {i}");
        assert_eq!(session["nextAt"], json!(next), "session {i}");
        assert_eq!(session["finished"], json!(true));
        assert_eq!(review["coverage"]["analysed"], json!(0));
    }
    // Without an instant: the latest session once it has ended; while it
    // may still be going on, it is named and the one before is reviewed.
    let latest = expected.last().expect("latest");
    let review = store
        .reader()
        .session_review(&query(None, last_ms + gap_ms + 1))
        .expect("review");
    assert_eq!(review["session"]["startedAt"], json!(latest.0));
    assert_eq!(review["ongoing"], Value::Null);
    let review = store
        .reader()
        .session_review(&query(None, last_ms + 60_000))
        .expect("review");
    assert_eq!(review["ongoing"]["startedAt"], json!(latest.0));
    assert_eq!(
        review["session"]["startedAt"],
        json!(expected[expected.len() - 2].0)
    );
    assert_eq!(review["session"]["finished"], json!(true));

    // The lists, on the session with the most hands.
    let (start, end, keys) = expected
        .iter()
        .max_by_key(|s| s.2.len())
        .expect("a session")
        .clone();
    assert!(keys.len() >= 10);
    let writer = store.writer().expect("writer");
    let mut rows = Vec::new();
    for (i, key) in keys.iter().enumerate() {
        let grade = ["inaccurate", "mistake", "blunder", "good"][i % 4];
        let ev = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0][i % 7];
        let flop = if i % 3 == 0 { "blunder" } else { "perfect" };
        let flop_ev = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0][i % 7];
        rows.push(row(
            key,
            V1,
            true,
            vec![
                graded(0, "preflop", "chart", grade, ev),
                graded(1, "flop", "solver", flop, flop_ev),
            ],
        ));
    }
    for chunk in rows.chunks(200) {
        writer.save_analysis(chunk.to_vec(), 0).expect("save");
    }
    let review = store
        .reader()
        .session_review(&query(Some(&start), last_ms + 10 * gap_ms))
        .expect("review");
    assert_eq!(review["session"]["endedAt"], json!(end));
    assert_eq!(review["coverage"]["analysed"], json!(keys.len()));
    assert_eq!(review["coverage"]["graded"], json!(keys.len()));
    let worst = review["worst"].as_array().expect("worst").clone();
    let deviations = review["chartDeviations"]
        .as_array()
        .expect("deviations")
        .clone();
    let pots = review["pots"].as_array().expect("pots").clone();
    assert!(!worst.is_empty() && worst.len() <= 20);
    assert!(!deviations.is_empty() && deviations.len() <= 20);
    assert!(!pots.is_empty() && pots.len() <= 20);
    // Worst: one per hand, worse grade first, then the EV it cost.
    let rank = |g: &Value| {
        ["perfect", "good", "inaccurate", "mistake", "blunder"]
            .iter()
            .position(|x| Some(*x) == g.as_str())
            .expect("a grade")
    };
    for pair in worst.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        assert!(
            rank(&a["grade"]) > rank(&b["grade"])
                || (rank(&a["grade"]) == rank(&b["grade"])
                    && a["evLossBb"].as_f64() >= b["evLossBb"].as_f64()),
            "{a} before {b}"
        );
    }
    let hands_once: BTreeSet<&str> = worst
        .iter()
        .map(|w| w["handId"].as_str().expect("id"))
        .collect();
    assert_eq!(hands_once.len(), worst.len());
    // Deviations: preflop chart decisions of Inaccurate or worse, by EV.
    for d in &deviations {
        assert_eq!(
            (d["street"].as_str(), d["source"].as_str()),
            (Some("preflop"), Some("chart"))
        );
        assert!(rank(&d["grade"]) >= 2);
        assert_eq!(d["best"], json!("call"));
        assert_eq!(d["chosenFreq"], json!(0.6));
        assert_eq!(d["position"], json!("BB"));
    }
    for pair in deviations.windows(2) {
        assert!(pair[0]["evLossBb"].as_f64() >= pair[1]["evLossBb"].as_f64());
    }
    // Pots: biggest in big blinds first.
    for pair in pots.windows(2) {
        assert!(pair[0]["potBb"].as_f64() >= pair[1]["potBb"].as_f64());
    }
    // Every hand a list names has its row; nothing else.
    let named: BTreeSet<&str> = worst
        .iter()
        .chain(&deviations)
        .chain(&pots)
        .map(|v| v["handId"].as_str().expect("id"))
        .collect();
    let rows_of = review["hands"].as_object().expect("hands");
    assert_eq!(
        rows_of.keys().map(String::as_str).collect::<BTreeSet<_>>(),
        named
    );
    for (key, hand) in rows_of {
        assert!(keys.contains(key));
        assert!(hand["grade"].is_string());
        assert!(hand["smallBlind"].as_i64().is_some() && hand["bigBlind"].as_i64().is_some());
        assert!(hand["heroCards"].is_array() && hand["board"].is_array());
    }
    // A smaller limit caps every list.
    let small = store
        .reader()
        .session_review(&ReviewQuery {
            limit: 3,
            ..query(Some(&start), last_ms + 10 * gap_ms)
        })
        .expect("review");
    assert_eq!(small["worst"].as_array().map(Vec::len), Some(3));
    assert_eq!(small["worst"][0], worst[0]);

    // The own charts: the session's preflop decisions, and the rows of hands.
    let preflop = store
        .reader()
        .session_preflop(V1, &start, &end)
        .expect("preflop");
    assert_eq!(preflop.len(), keys.len());
    assert!(
        preflop
            .iter()
            .all(|d| d.key == "vs-open:BB:BTN" && d.cls == 21 && d.depth_band == 100)
    );
    let some: Vec<String> = keys.iter().take(3).cloned().collect();
    let hands = store.reader().review_hands(&some, V1).expect("hands");
    assert_eq!(hands.as_object().map(serde_json::Map::len), Some(3));

    // The comparison over every period: the cells sum to the decisions.
    let compare = |period: &str| CompareQuery {
        version: V1.to_owned(),
        period: period.to_owned(),
        game_format: "cash".to_owned(),
        table_size: 6,
        min_bb: 80,
        max_bb: 120,
    };
    let formats: BTreeMap<String, String> = conn
        .prepare(
            "SELECT s.hand_key, g.game_format FROM hand_stats s JOIN segments g ON g.id = s.segment_id",
        )
        .expect("prepare")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let cash = keys
        .iter()
        .filter(|k| formats.get(*k).map(String::as_str) == Some("cash"))
        .count();
    let decisions = |played: &rail_store::review::Played| -> usize {
        played
            .cells
            .iter()
            .map(|c| usize::try_from(c.decisions).expect("count"))
            .sum()
    };
    let all = store
        .reader()
        .chart_played(&compare("all"))
        .expect("played");
    assert_eq!(decisions(&all), cash);
    assert_eq!(all.to.as_deref(), Some(&end[..10]));
    assert_eq!(all.from.as_deref(), Some(&start[..10]));
    let month = store
        .reader()
        .chart_played(&compare("30d"))
        .expect("played");
    assert_eq!(decisions(&month), cash, "one session is within 30 days");
    let shallow = CompareQuery {
        min_bb: 10,
        max_bb: 50,
        ..compare("all")
    };
    assert!(
        store
            .reader()
            .chart_played(&shallow)
            .expect("played")
            .cells
            .is_empty()
    );
    let nine = CompareQuery {
        table_size: 9,
        ..compare("all")
    };
    assert!(
        store
            .reader()
            .chart_played(&nine)
            .expect("played")
            .cells
            .is_empty()
    );
    if let Some(cell) = all.cells.first() {
        let examples = store
            .reader()
            .chart_examples(&compare("all"), &cell.key, cell.cls, &cell.action, 5)
            .expect("examples");
        assert_eq!(
            examples.len(),
            usize::try_from(cell.decisions.min(5)).expect("count")
        );
        for pair in examples.windows(2) {
            assert!(pair[0].played_at >= pair[1].played_at);
        }
    }
    drop(writer);
    store.close();
}

/// One leak row as the test saved it.
struct Saved {
    hand_key: String,
    played_at: String,
    format: String,
    position: String,
    pot: String,
    ord: i64,
    spot: String,
    set: String,
    grade: String,
    score: f64,
    ev: f64,
    ev_pot: f64,
}

const LEAK_SPOTS: [(&str, &str); 3] = [
    ("preflop|vs-open|ffffr|BB|fold|call", "nlhe-cash-6max-100bb"),
    ("flop|ip-pfr||BTN|check|bet", ""),
    ("river|oop-caller||BB|call|fold", ""),
];
const LEAK_GRADES: [&str; 5] = ["perfect", "good", "inaccurate", "mistake", "blunder"];

/// The sums the web's `analysis_leaks` returns, from the saved rows.
#[allow(clippy::float_arithmetic)] // the sums the store adds up
fn expected_sample(
    saved: &[Saved],
    keep: &dyn Fn(&Saved) -> bool,
) -> rail_store::leaks::LeakSample {
    let mut spots: BTreeMap<(String, String), rail_store::leaks::SpotSums> = BTreeMap::new();
    let mut hands = BTreeSet::new();
    for s in saved.iter().filter(|s| keep(s)) {
        hands.insert(s.hand_key.clone());
        let sums = spots
            .entry((s.spot.clone(), s.set.clone()))
            .or_insert_with(|| rail_store::leaks::SpotSums {
                key: s.spot.clone(),
                set: (!s.set.is_empty()).then(|| s.set.clone()),
                decisions: 0,
                non_perfect: 0,
                mistakes: 0,
                ev_loss_bb: 0.0,
                ev_loss_pot: 0.0,
                score_sum: 0.0,
                score_sq: 0.0,
            });
        sums.decisions += 1;
        sums.non_perfect += i64::from(s.grade != "perfect");
        sums.mistakes += i64::from(matches!(
            s.grade.as_str(),
            "inaccurate" | "mistake" | "blunder"
        ));
        sums.ev_loss_bb += s.ev;
        sums.ev_loss_pot += s.ev_pot;
        sums.score_sum += s.score;
        sums.score_sq += s.score * s.score;
    }
    let rows: Vec<_> = spots.into_values().collect();
    rail_store::leaks::LeakSample {
        hands: i64::try_from(hands.len()).expect("hands"),
        graded: rows.iter().map(|r| r.decisions).sum(),
        rows,
    }
}

#[allow(clippy::float_arithmetic)] // a tolerance
fn assert_sample(
    got: &rail_store::leaks::LeakSample,
    want: &rail_store::leaks::LeakSample,
    what: &str,
) {
    assert_eq!(
        (got.hands, got.graded, got.rows.len()),
        (want.hands, want.graded, want.rows.len()),
        "{what}"
    );
    for (g, w) in got.rows.iter().zip(&want.rows) {
        assert_eq!(
            (&g.key, &g.set, g.decisions, g.non_perfect, g.mistakes),
            (&w.key, &w.set, w.decisions, w.non_perfect, w.mistakes),
            "{what}"
        );
        for (a, b) in [
            (g.ev_loss_bb, w.ev_loss_bb),
            (g.ev_loss_pot, w.ev_loss_pot),
            (g.score_sum, w.score_sum),
            (g.score_sq, w.score_sq),
        ] {
            assert!(
                (a - b).abs() < 1e-6 * b.abs().max(1.0),
                "{what}: {a} != {b}"
            );
        }
    }
}

fn day_before(day: &str, days: i64) -> String {
    let ms = rail_store::time::ms_from_iso(&format!("{day}T00:00:00.000Z")).expect("day");
    rail_store::time::iso_from_ms(ms - days * 86_400_000)[..10].to_owned()
}

#[test]
#[allow(clippy::float_arithmetic)] // the saved EV and scores
fn the_top_leaks_sum_the_leak_rows_by_spot() {
    use rail_store::leaks::LeakFilters;
    let path = copy_of_corpus("analysis-leaks");
    let store = Store::open(&path).expect("open");
    let conn = Connection::open(&path).expect("open");
    // Every 15th hand played before March 2026 (the corpus's January and
    // February fill both 30-day windows); the last one goes to V2.
    let hands: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT hand_key, played_at, game_format FROM hands
             WHERE played_at < '2026-03' ORDER BY played_at DESC, hand_key DESC",
        )
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
        .into_iter()
        .step_by(15)
        .collect();
    assert!(hands.len() > 300, "hands: {}", hands.len());

    let mut saved = Vec::new();
    let mut rows = Vec::new();
    for (i, (key, played_at, format)) in hands.iter().enumerate() {
        let position = if i % 2 == 0 { "BB" } else { "BTN" };
        let pot = if i % 4 < 2 { "single-raised" } else { "3-bet" };
        let mut decisions = Vec::new();
        for ord in 0..2_i64 {
            let n = i + usize::try_from(ord).expect("ord");
            let (spot, set) = LEAK_SPOTS[n % 3];
            let grade = LEAK_GRADES[(n * 7 / 3) % 5];
            let street = spot.split('|').next().expect("street");
            let mut d = decision(ord, street, Some(grade), json!([]));
            let ev = f64::from(u32::try_from(n % 9).expect("n")) * 0.25;
            let score = 100.0 - 7.5 * f64::from(u32::try_from(n % 5).expect("n"));
            d.spot_key = spot.to_owned();
            d.chart_set = set.to_owned();
            d.ev_loss_bb = Some(ev);
            d.ev_loss_pot = Some(ev / 8.0);
            d.score = Some(score);
            saved.push(Saved {
                hand_key: key.clone(),
                played_at: played_at.clone(),
                format: format.clone(),
                position: position.to_owned(),
                pot: pot.to_owned(),
                ord,
                spot: spot.to_owned(),
                set: set.to_owned(),
                grade: grade.to_owned(),
                score,
                ev,
                ev_pot: ev / 8.0,
            });
            decisions.push(d);
        }
        // A decision the analysis did not grade is no leak row.
        decisions.push(decision(2, "turn", None, json!([])));
        let mut r = row(key, V1, true, decisions);
        r.hero_position = Some(position.to_owned());
        r.pot_type = pot.to_owned();
        rows.push(r);
    }
    // The last hand at another version: not in V1's leaks.
    let mut other = rows.pop().expect("a hand");
    let other_key = other.hand_key.clone();
    saved.retain(|s| s.hand_key != other_key);
    other.analysis_version = V2.to_owned();
    rows.push(other);
    let writer = store.writer().expect("writer");
    for chunk in rows.chunks(50) {
        writer.save_analysis(chunk.to_vec(), 1_000).expect("save");
    }

    let reader = store.reader();
    let all = LeakFilters::default();
    let day = |s: &Saved| s.played_at[..10].to_owned();
    let last = saved.iter().map(day).max().expect("a day");
    let current = (day_before(&last, 29), last.clone());
    let prior = (day_before(&last, 59), day_before(&last, 30));
    let within = |s: &Saved, w: &(String, String)| day(s) >= w.0 && day(s) <= w.1;

    let top = reader.top_leaks(V1, &all, "all").expect("top");
    assert_eq!(top.last.as_deref(), Some(last.as_str()));
    assert_eq!(top.current, Some(current.clone()));
    assert_eq!(top.prior, Some(prior.clone()));
    assert_sample(&top.sample, &expected_sample(&saved, &|_| true), "all time");
    assert_sample(
        &top.now,
        &expected_sample(&saved, &|s| within(s, &current)),
        "the last 30 days",
    );
    assert_sample(
        &top.was,
        &expected_sample(&saved, &|s| within(s, &prior)),
        "the 30 before",
    );
    assert!(
        top.now.graded > 0 && top.was.graded > 0 && top.sample.graded > top.now.graded,
        "the sample spans both windows and more"
    );
    let thirty = reader.top_leaks(V1, &all, "30d").expect("top");
    assert_eq!(thirty.sample, thirty.now);
    assert_eq!(thirty.now, top.now);

    // The filters: the hand's format, the hero's seat, the pot type.
    let format = saved[0].format.clone();
    let filters = LeakFilters {
        game_format: Some(format.clone()),
        position: Some("BTN".to_owned()),
        pot_type: Some("3-bet".to_owned()),
    };
    let filtered = reader.top_leaks(V1, &filters, "all").expect("top");
    let keep = |s: &Saved| s.format == format && s.position == "BTN" && s.pot == "3-bet";
    let want = expected_sample(&saved, &keep);
    assert!(want.graded > 0, "the filters keep some rows");
    assert_sample(&filtered.sample, &want, "filtered");
    // Another version has no rows.
    let none = reader.top_leaks("analysis/1", &all, "all").expect("top");
    assert_eq!(none.last, None);
    assert_eq!(none.sample.graded, 0);
    assert_eq!(none.current, None);

    // The examples: worse than Perfect at the leak's keys, costliest first.
    let keys = vec![LEAK_SPOTS[0].0.to_owned(), LEAK_SPOTS[2].0.to_owned()];
    let examples_of = |days: Option<&(String, String)>| -> Vec<(String, i64)> {
        let mut want: Vec<&Saved> = saved
            .iter()
            .filter(|s| {
                s.grade != "perfect" && keys.contains(&s.spot) && days.is_none_or(|w| within(s, w))
            })
            .collect();
        want.sort_by(|a, b| {
            b.ev.total_cmp(&a.ev)
                .then_with(|| b.played_at.cmp(&a.played_at))
                .then_with(|| a.hand_key.cmp(&b.hand_key))
                .then_with(|| a.ord.cmp(&b.ord))
        });
        want.into_iter()
            .take(30)
            .map(|s| (s.hand_key.clone(), s.ord))
            .collect()
    };
    let examples = reader
        .leak_examples(V1, &all, None, &keys, 100)
        .expect("examples");
    assert_eq!(
        examples
            .iter()
            .map(|e| (e.hand_key.clone(), e.ord))
            .collect::<Vec<_>>(),
        examples_of(None)
    );
    assert_eq!(examples.len(), 30);
    for e in &examples {
        let s = saved
            .iter()
            .find(|s| s.hand_key == e.hand_key && s.ord == e.ord)
            .expect("saved");
        assert_eq!(
            (&e.played_at, &e.spot_key, &e.grade),
            (&s.played_at, &s.spot, &s.grade)
        );
        assert_eq!(e.action_index, e.ord * 2 + 3);
        assert!(!e.site.is_empty() && e.big_blind > 0);
    }
    let recent = reader
        .leak_examples(
            V1,
            &all,
            Some((current.0.as_str(), current.1.as_str())),
            &keys,
            5,
        )
        .expect("examples");
    let want: Vec<_> = examples_of(Some(&current)).into_iter().take(5).collect();
    assert_eq!(
        recent
            .iter()
            .map(|e| (e.hand_key.clone(), e.ord))
            .collect::<Vec<_>>(),
        want
    );

    // Refusals.
    assert!(matches!(
        reader.top_leaks(V1, &all, "90d"),
        Err(Error::OutOfRange(_))
    ));
    assert!(matches!(
        reader.leak_examples(V1, &all, None, &["preflop|x".to_owned()], 5),
        Err(Error::OutOfRange(_))
    ));
    assert!(matches!(
        reader.leak_examples(V1, &all, Some(("2026-13-01", "2026-12-31")), &keys, 5),
        Err(Error::OutOfRange(_))
    ));
    let many = vec![LEAK_SPOTS[1].0.to_owned(); 201];
    assert!(matches!(
        reader.leak_examples(V1, &all, None, &many, 5),
        Err(Error::OutOfRange(_))
    ));
    assert!(
        reader
            .leak_examples(V1, &all, None, &[], 5)
            .expect("none")
            .is_empty()
    );
    drop(writer);
    store.close();
}
