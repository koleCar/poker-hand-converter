//! The Analytics checker rows in the store (docs/ANALYTICS.md Step 2,
//! migration 27, `rail_store::checker`): the fixture
//! (`core/rail-stats/tests/data/analytics/rows/`: hands with a made-up
//! stored analysis) saved through `save_analysis` stores exactly the rows
//! `rows.json` names and sums to exactly `sums.json` - the web's
//! `analytics_checker` answer over the same decisions (pgTAP
//! `analytics_checker`). The backfill derives the same rows again from the
//! stored PHF and decisions, and doing it twice changes nothing; the
//! filters, the examples and a deleted hand behave as the web's.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use rail_store::checker::{CheckerFilters, CheckerSide, ExampleQuery, backfill_step};
use rail_store::import::ImportOptions;
use rail_store::{DecisionRowIn, HandAnalysisIn, Store, import_file};
use rusqlite::Connection;
use serde_json::{Value, json};

use common::{PARSED_AT, repo_root, scratch_dir};

const VERSION: &str = "analysis/50";
const DIR: &str = "core/rail-stats/tests/data/analytics/rows";

fn read(name: &str) -> Value {
    let text = fs::read_to_string(repo_root().join(DIR).join(name)).expect("fixture");
    serde_json::from_str(&text).expect("json")
}

/// JSON with every number as an `f64` (the TypeScript writes `0`, Rust `0.0`).
fn numbers_as_f64(value: Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().expect("a number")),
        Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_f64).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, numbers_as_f64(value)))
                .collect(),
        ),
        other => other,
    }
}

/// A store holding the fixture's hands, analysed; the case files' hand keys in case order.
fn fixture_store(name: &str) -> (PathBuf, Store, Vec<String>) {
    let path = scratch_dir(name).join("rail.db");
    let store = Store::open(&path).expect("open");
    let cases = read("cases.json");
    let mut keys = Vec::new();
    let options = ImportOptions {
        parsed_at: Some(PARSED_AT.to_owned()),
        source_id: None,
    };
    let conn = Connection::open(&path).expect("open");
    for case in cases["cases"].as_array().expect("cases") {
        let file = repo_root().join(case["file"].as_str().expect("file"));
        let before: i64 = conn
            .query_row("SELECT count(*) FROM hands", [], |r| r.get(0))
            .expect("count");
        import_file(&store, &file, &options).expect("import");
        let key: String = conn
            .query_row(
                "SELECT hand_key FROM hands ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("hand key");
        let after: i64 = conn
            .query_row("SELECT count(*) FROM hands", [], |r| r.get(0))
            .expect("count");
        assert_eq!(after, before + 1, "{} stored one hand", file.display());
        keys.push(key);
    }
    let rows: Vec<HandAnalysisIn> = cases["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .zip(&keys)
        .map(|(case, key)| analysis_of(case, key))
        .collect();
    store
        .writer()
        .expect("writer")
        .save_analysis(rows, 1)
        .expect("save");
    (path, store, keys)
}

fn analysis_of(case: &Value, key: &str) -> HandAnalysisIn {
    let decisions: Vec<DecisionRowIn> = case["decisions"]
        .as_array()
        .expect("decisions")
        .iter()
        .map(|d| {
            let analysed = d["status"] == "analysed";
            DecisionRowIn {
                ord: d["ord"].as_i64().expect("ord"),
                action_index: d["action_index"].as_i64().expect("action index"),
                street: d["street"].as_str().expect("street").to_owned(),
                action: d["action"].as_str().expect("action").to_owned(),
                status: d["status"].as_str().expect("status").to_owned(),
                reason: (!analysed).then(|| "no-reference".to_owned()),
                node: "n".to_owned(),
                scenario: d["facts"]["scenario"].as_str().unwrap_or("x").to_owned(),
                source: "solver".to_owned(),
                grade: analysed.then(|| "good".to_owned()),
                score: None,
                ev_loss_bb: d["ev_loss_bb"].as_f64(),
                ev_loss_pot: None,
                freq_diff: None,
                options: d["options"].clone(),
                chosen: d["chosen"].as_i64(),
                flags: json!([]),
                approximations: Vec::new(),
                facing_bet: false,
                pot_bb: Some(5.0),
                pot_odds: None,
                mdf: None,
                facts: d["facts"].clone(),
                spot_key: format!(
                    "{}|x||BB|{}|",
                    d["street"].as_str().unwrap_or(""),
                    d["action"].as_str().unwrap_or("")
                ),
                chart_set: String::new(),
                best: String::new(),
                preflop: None,
            }
        })
        .collect();
    let analysed = decisions.iter().filter(|d| d.status == "analysed").count();
    let status = if analysed == decisions.len() {
        "full"
    } else if analysed > 0 {
        "partial"
    } else {
        "not-analysed"
    };
    HandAnalysisIn {
        hand_key: key.to_owned(),
        analysis_version: VERSION.to_owned(),
        status: status.to_owned(),
        reason: (analysed == 0).then(|| "no-reference".to_owned()),
        hero_seat: None,
        grade: None,
        score: None,
        ev_loss_bb: None,
        ev_loss_pot: None,
        approximations: Vec::new(),
        pot_type: "single-raised".to_owned(),
        hero_position: None,
        flop_library: true,
        decisions,
    }
}

/// The reader's sums in `sums.json`'s shape.
fn sums_json(store: &Store, filters: &CheckerFilters) -> Value {
    let sums = store.reader().checker_sums(VERSION, filters).expect("sums");
    numbers_as_f64(json!({
        "hands": sums.hands,
        "groups": sums.groups.iter().map(|g| json!({
            "stat": g.stat, "spot": g.spot, "size": g.size, "handClass": g.hand_class,
            "opps": g.opps, "oppsTaken": g.opps_taken, "n": g.n, "taken": g.taken,
            "refShare": g.ref_share, "evHigh": g.ev_high, "evLow": g.ev_low, "hands": g.hands,
        })).collect::<Vec<_>>(),
    }))
}

/// The stored rows per hand, in `rows.json`'s shape (case order).
fn stored_rows(conn: &Connection, keys: &[String]) -> Value {
    let cases = read("cases.json");
    let mut by_key: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT hand_key, ord, action_index, stat, taken, ref_share, best_in, ev_loss_bb, size,
                    hand_class, spot, multiway
             FROM analysis_checker_rows",
        )
        .expect("prepare");
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                json!({
                    "ord": r.get::<_, i64>(1)?,
                    "actionIndex": r.get::<_, i64>(2)?,
                    "stat": r.get::<_, String>(3)?,
                    "taken": r.get::<_, bool>(4)?,
                    "refShare": r.get::<_, Option<f64>>(5)?,
                    "bestIn": r.get::<_, Option<bool>>(6)?,
                    "evLossBb": r.get::<_, f64>(7)?,
                    "size": r.get::<_, String>(8)?,
                    "handClass": r.get::<_, String>(9)?,
                    "spot": r.get::<_, String>(10)?,
                    "multiway": r.get::<_, bool>(11)?,
                }),
            ))
        })
        .expect("query");
    for row in rows {
        let (key, value) = row.expect("row");
        by_key.entry(key).or_default().push(value);
    }
    // Catalogue order within a decision, as derived.
    let order: Vec<&str> = rail_stats::analytics::catalogue()
        .stats
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    let rank = |v: &Value| {
        (
            v["ord"].as_i64().unwrap_or(0),
            order
                .iter()
                .position(|s| Some(*s) == v["stat"].as_str())
                .unwrap_or(usize::MAX),
        )
    };
    numbers_as_f64(Value::Array(
        cases["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .zip(keys)
            .map(|(case, key)| {
                let mut rows = by_key.remove(key).unwrap_or_default();
                rows.sort_by_key(rank);
                json!({ "file": case["file"], "rows": rows })
            })
            .collect(),
    ))
}

fn sums_fixture() -> Value {
    numbers_as_f64(read("sums.json"))
}

#[test]
fn a_save_stores_the_fixtures_rows_and_sums() {
    let (path, store, keys) = fixture_store("checker-save");
    let conn = Connection::open(&path).expect("open");
    assert_eq!(
        stored_rows(&conn, &keys),
        numbers_as_f64(read("rows.json")),
        "the stored rows are rows.json"
    );
    assert_eq!(
        sums_json(&store, &CheckerFilters::default()),
        sums_fixture(),
        "the sums are sums.json (the web's analytics_checker)"
    );
    let sums = store
        .reader()
        .checker_sums(VERSION, &CheckerFilters::default())
        .expect("sums");
    assert_eq!(
        (sums.pending, sums.membership_version.as_str()),
        (0, rail_stats::analytics::MEMBERSHIP_VERSION)
    );
    // Nothing for the backfill.
    let writer = store.writer().expect("writer");
    assert_eq!(backfill_step(store.reader(), &writer).expect("step"), None);
}

#[test]
fn the_backfill_derives_the_same_rows_and_is_idempotent() {
    let (path, store, keys) = fixture_store("checker-backfill");
    let conn = Connection::open(&path).expect("open");
    let saved = stored_rows(&conn, &keys);
    // As a store analysed before migration 27, and one at another version.
    conn.execute_batch(
        "DELETE FROM analysis_checker_rows;
         UPDATE hand_analysis SET checker_version = '', checker_position = '';
         UPDATE hand_analysis SET checker_version = 'analytics/0'
          WHERE hand_key IN (SELECT hand_key FROM hand_analysis ORDER BY hand_key LIMIT 3);",
    )
    .expect("reset");
    let pending = store
        .reader()
        .checker_sums(VERSION, &CheckerFilters::default())
        .expect("sums");
    assert_eq!(
        (pending.pending, pending.groups.len()),
        (i64::try_from(keys.len()).expect("n"), 0)
    );
    let writer = store.writer().expect("writer");
    let mut steps = 0;
    while let Some(n) = backfill_step(store.reader(), &writer).expect("step") {
        assert!(n > 0);
        steps += 1;
        assert!(steps < 10, "the backfill ends");
    }
    assert_eq!(
        stored_rows(&conn, &keys),
        saved,
        "the backfill's rows are the save's"
    );
    assert_eq!(
        sums_json(&store, &CheckerFilters::default()),
        sums_fixture()
    );
    // Again: nothing to do, nothing moves.
    assert_eq!(backfill_step(store.reader(), &writer).expect("step"), None);
    conn.execute_batch("UPDATE hand_analysis SET checker_version = 'analytics/0'")
        .expect("stale");
    while backfill_step(store.reader(), &writer)
        .expect("step")
        .is_some()
    {}
    assert_eq!(
        stored_rows(&conn, &keys),
        saved,
        "a second backfill writes the same rows"
    );
    assert_eq!(
        sums_json(&store, &CheckerFilters::default()),
        sums_fixture()
    );
    // The background pass runs it.
    conn.execute_batch("UPDATE hand_analysis SET checker_version = ''")
        .expect("stale");
    let drained = rail_store::background::drain(store.reader(), &writer).expect("drain");
    assert_eq!(drained.checked, keys.len());
    assert_eq!(
        sums_json(&store, &CheckerFilters::default()),
        sums_fixture()
    );
}

#[test]
fn filters_examples_and_a_deleted_hand() {
    let (path, store, keys) = fixture_store("checker-reads");
    let conn = Connection::open(&path).expect("open");
    let rows = read("rows.json");
    let all_rows: Vec<&Value> = rows
        .as_array()
        .expect("rows")
        .iter()
        .flat_map(|h| h["rows"].as_array().expect("rows").iter())
        .collect();

    // A range before every hand: nothing.
    let none = CheckerFilters {
        to: Some("2000-01-01T00:00:00Z".to_owned()),
        ..CheckerFilters::default()
    };
    let sums = store.reader().checker_sums(VERSION, &none).expect("sums");
    assert_eq!((sums.hands, sums.groups.len()), (0, 0));

    // Pot kind mw: the multiway decisions.
    let mw = CheckerFilters {
        pot_kind: Some("mw".to_owned()),
        ..CheckerFilters::default()
    };
    let sums = store.reader().checker_sums(VERSION, &mw).expect("sums");
    assert_eq!(
        sums.groups.iter().map(|g| g.opps).sum::<i64>(),
        i64::try_from(all_rows.iter().filter(|r| r["multiway"] == true).count()).expect("n")
    );

    // A seat: the rows whose spot's hero is that seat.
    let co = CheckerFilters {
        position: Some("co".to_owned()),
        ..CheckerFilters::default()
    };
    let sums = store.reader().checker_sums(VERSION, &co).expect("sums");
    let co_rows = all_rows
        .iter()
        .filter(|r| {
            r["spot"]
                .as_str()
                .is_some_and(|s| s.split('|').nth(2) == Some("CO"))
        })
        .count();
    assert_eq!(
        sums.groups.iter().map(|g| g.opps).sum::<i64>(),
        i64::try_from(co_rows).expect("n")
    );
    assert!(sums.hands > 0);

    // Examples: the costliest VPIP decisions that took the class.
    let examples = store
        .reader()
        .checker_examples(
            VERSION,
            &CheckerFilters::default(),
            &ExampleQuery {
                stat: "vpip".to_owned(),
                spot: None,
                size: None,
                hand_class: None,
                side: CheckerSide::High,
                limit: 3,
            },
        )
        .expect("examples");
    let mut want: Vec<f64> = all_rows
        .iter()
        .filter(|r| r["stat"] == "vpip" && r["taken"] == true && !r["refShare"].is_null())
        .filter_map(|r| r["evLossBb"].as_f64())
        .collect();
    want.sort_by(|a, b| b.total_cmp(a));
    want.truncate(3);
    assert_eq!(
        examples.iter().map(|e| e.ev_loss_bb).collect::<Vec<_>>(),
        want
    );
    assert_eq!(examples[0].cards, vec!["As".to_owned(), "Kd".to_owned()]);

    // A deleted hand takes its rows.
    let first = keys[0].clone();
    store
        .writer()
        .expect("writer")
        .delete_hands(vec![first.clone()], 1)
        .expect("delete");
    let left: i64 = conn
        .query_row(
            "SELECT count(*) FROM analysis_checker_rows WHERE hand_key = ?1",
            [&first],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(left, 0);
}
