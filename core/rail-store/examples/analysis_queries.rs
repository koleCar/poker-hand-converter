//! The analysis runner's store calls on a large store (docs/RAIL-PLAN.md
//! R5.4): the next page of hands to analyse (first, and deep into the walk
//! once most hands are analysed), the counts, a page of rows written, one
//! hand's analysis read back, the opponents' counters of a page, and the
//! screens' readers (session review, own charts compared, top leaks).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     --hands 1000000 --keep --dir /tmp/bench          # a generated store
//! cargo run --release -p rail-store --example analysis_queries -- \
//!     /tmp/bench/bench-store/rail.db [--runs 11]
//! ```
//!
//! **Writes to the store** (it is meant for a generated benchmark store,
//! never a user's): synthetic analysis rows for every hand but the newest
//! 1 000 (two decisions each, the size of a real row), then removes them.

// Milliseconds are printed as decimals.
#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

use std::path::PathBuf;
use std::time::Instant;

use rail_store::{DecisionRowIn, HandAnalysisIn, PendingCursor, Store};
use serde_json::json;

const VERSION: &str = "analysis/34";

fn times(runs: usize, mut f: impl FnMut()) -> Vec<u128> {
    let mut out: Vec<u128> = (0..runs)
        .map(|_| {
            let started = Instant::now();
            f();
            started.elapsed().as_micros()
        })
        .collect();
    out.sort_unstable();
    out
}

fn report(what: &str, times: &[u128]) {
    let ms = |us: u128| us as f64 / 1000.0;
    println!(
        "{what:<52} median {:>9.2} ms  max {:>9.2} ms",
        ms(times[times.len() / 2]),
        ms(times[times.len() - 1]),
    );
}

fn decision(ord: i64) -> DecisionRowIn {
    DecisionRowIn {
        ord,
        action_index: ord * 3 + 4,
        street: if ord == 0 { "preflop" } else { "flop" }.to_owned(),
        action: "call".to_owned(),
        status: "analysed".to_owned(),
        reason: None,
        node: "BB vs BTN open, 2.5bb".to_owned(),
        scenario: "vs-open".to_owned(),
        source: "chart".to_owned(),
        grade: Some("good".to_owned()),
        score: Some(91.25),
        ev_loss_bb: Some(0.042),
        ev_loss_pot: Some(0.0071),
        freq_diff: Some(0.12),
        options: json!([
            {"action": "fold", "freq": 0.31, "ev": 0.0, "sizeBb": 1.0},
            {"action": "call", "freq": 0.52, "ev": 0.41, "sizeBb": 2.5},
            {"action": "raise", "freq": 0.17, "ev": 0.38, "sizeBb": 11.0}
        ]),
        chosen: Some(1),
        flags: json!([{"code": "thin-call", "severity": "note"}]),
        approximations: vec!["population-ranges".to_owned()],
        facing_bet: true,
        pot_bb: Some(4.0),
        pot_odds: Some(0.25),
        mdf: Some(0.6),
        facts: json!({
            "scenario": "vs-open", "position": "BB", "potBb": 4.0, "potOdds": 0.25, "mdf": 0.6,
            "chart": {"set": "nlhe-cash-6max-100bb", "line": "ffffr", "node": "vs-open:BB:BTN"},
            "handClass": "A9s", "equity": 0.512, "texture": {"paired": false, "suits": 2}
        }),
        spot_key: "preflop|vs-open|ffffr|BB|call|call".to_owned(),
        chart_set: "nlhe-cash-6max-100bb".to_owned(),
        best: "call".to_owned(),
        preflop: (ord == 0).then(|| rail_store::PreflopFields {
            chart_key: "vs-open:BB:BTN".to_owned(),
            chart_table: 6,
            hand_class: 21,
            chart_action: "call".to_owned(),
            depth_band: 100,
        }),
    }
}

fn row(hand_key: &str) -> HandAnalysisIn {
    HandAnalysisIn {
        hand_key: hand_key.to_owned(),
        analysis_version: VERSION.to_owned(),
        status: "full".to_owned(),
        reason: None,
        hero_seat: Some(4),
        grade: Some("good".to_owned()),
        score: Some(91.25),
        ev_loss_bb: Some(0.084),
        ev_loss_pot: Some(0.0142),
        approximations: vec![],
        pot_type: "single-raised".to_owned(),
        hero_position: Some("BB".to_owned()),
        flop_library: true,
        decisions: vec![decision(0), decision(1)],
    }
}

/// The store's pages in use, in bytes (page count less the free list).
fn used_bytes(path: &std::path::Path) -> i64 {
    let conn = rusqlite::Connection::open(path).expect("open");
    let pragma = |name: &str| -> i64 {
        conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .unwrap_or(0)
    };
    (pragma("page_count") - pragma("freelist_count")) * pragma("page_size")
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(args.next().expect("the store's path"));
    let runs = match (args.next().as_deref(), args.next()) {
        (Some("--runs"), Some(n)) => n.parse().expect("--runs N"),
        _ => 11,
    };
    let store = Store::open(&path).expect("open");
    let reader = store.reader();
    let writer = store.writer().expect("writer");
    let counts = reader.analysis_counts(VERSION).expect("counts");
    println!(
        "{} hands, {} analysed at {VERSION}",
        counts.hands, counts.current
    );

    report(
        "counts",
        &times(runs, || {
            reader.analysis_counts(VERSION).expect("counts");
        }),
    );
    report(
        "first page (20 hands, nothing analysed)",
        &times(runs, || {
            assert_eq!(
                reader
                    .analysis_pending(VERSION, None, 20)
                    .expect("page")
                    .len(),
                20
            );
        }),
    );

    // Analyse "everything" but the newest 1 000 in big transactions, timing
    // a page of 20 rows the way the runner writes them.
    let mut cursor: Option<PendingCursor> = None;
    let mut keys = Vec::new();
    loop {
        let page = reader
            .analysis_pending(VERSION, cursor.as_ref(), 200)
            .expect("page");
        let Some(last) = page.last() else { break };
        cursor = Some(PendingCursor {
            played_at: last.played_at.clone(),
            hand_key: last.hand_key.clone(),
        });
        keys.extend(page.into_iter().map(|hand| hand.hand_key));
    }
    let newest: Vec<String> = keys.iter().take(1_000).cloned().collect();
    let before_bytes = used_bytes(&path);
    let started = Instant::now();
    for chunk in keys[1_000..].chunks(200) {
        writer
            .save_analysis(chunk.iter().map(|key| row(key)).collect(), 0)
            .expect("save");
    }
    println!(
        "wrote {} rows in {:.1} s",
        keys.len() - 1_000,
        started.elapsed().as_secs_f64()
    );
    let analysis_bytes = used_bytes(&path) - before_bytes;
    println!(
        "the analysis tables: {:.0} MiB ({} bytes a hand)",
        analysis_bytes as f64 / 1_048_576.0,
        analysis_bytes / i64::try_from(keys.len().max(1)).unwrap_or(1)
    );
    report(
        "a page of 20 rows written",
        &times(runs, || {
            writer
                .save_analysis(newest[..20].iter().map(|key| row(key)).collect(), 0)
                .expect("save");
        }),
    );
    report(
        "next page, 1 000 newest left",
        &times(runs, || {
            reader.analysis_pending(VERSION, None, 20).expect("page");
        }),
    );
    report(
        "counts, everything analysed but 1 000",
        &times(runs, || {
            reader.analysis_counts(VERSION).expect("counts");
        }),
    );
    report(
        "one hand's analysis read back",
        &times(runs, || {
            reader
                .hand_analysis(&keys[keys.len() / 2])
                .expect("read")
                .expect("a row");
        }),
    );
    let phf: Vec<serde_json::Value> = reader
        .analysis_pending(VERSION, None, 20)
        .expect("page")
        .iter()
        .map(|hand| serde_json::from_str(&hand.phf).expect("phf"))
        .collect();
    let players: Vec<(String, String)> = phf
        .iter()
        .flat_map(|hand| {
            let site = hand["meta"]["siteId"].as_str().unwrap_or("").to_owned();
            hand["players"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|p| p["isHero"] != json!(true))
                .filter_map(move |p| p["name"].as_str().map(|n| (site.clone(), n.to_owned())))
        })
        .collect();
    report(
        &format!("opponents' counters of a page ({} players)", players.len()),
        &times(runs, || {
            reader
                .villain_counters(&players, Some("cash"), 30)
                .expect("counters");
        }),
    );
    // The analysis screens' readers (R5.4) over the analysed store.
    let review_query = |at: Option<String>| rail_store::review::ReviewQuery {
        at,
        gap_minutes: 30,
        limit: 20,
        version: VERSION.to_owned(),
        now_ms: i64::MAX / 4,
    };
    report(
        "session review, the latest session",
        &times(runs, || {
            reader.session_review(&review_query(None)).expect("review");
        }),
    );
    let sessions = reader.review_sessions(30, None, 100_000).expect("sessions");
    let biggest = sessions.iter().max_by_key(|s| s.hands).expect("a session");
    println!(
        "{} sessions; the biggest {} hands",
        sessions.len(),
        biggest.hands
    );
    report(
        "session review, the biggest session",
        &times(runs, || {
            reader
                .session_review(&review_query(Some(biggest.started_at.clone())))
                .expect("review");
        }),
    );
    let middle = &sessions[sessions.len() / 2];
    report(
        "session review, a session in the middle",
        &times(runs, || {
            reader
                .session_review(&review_query(Some(middle.started_at.clone())))
                .expect("review");
        }),
    );
    report(
        "the picker, every session",
        &times(runs.min(3), || {
            reader.review_sessions(30, None, 200).expect("sessions");
        }),
    );
    let compare = |period: &str| rail_store::review::CompareQuery {
        version: VERSION.to_owned(),
        period: period.to_owned(),
        game_format: "cash".to_owned(),
        table_size: 6,
        min_bb: 80,
        max_bb: 120,
    };
    for period in ["all", "365d", "30d"] {
        report(
            &format!("own chart compared, {period}"),
            &times(runs.min(5), || {
                reader.chart_played(&compare(period)).expect("played");
            }),
        );
    }
    report(
        "own chart examples, all time",
        &times(runs, || {
            reader
                .chart_examples(&compare("all"), "vs-open:BB:BTN", 21, "call", 5)
                .expect("examples");
        }),
    );
    let filters = rail_store::leaks::LeakFilters::default();
    for period in ["30d", "all"] {
        report(
            &format!("top leaks, {period}"),
            &times(runs.min(5), || {
                reader.top_leaks(VERSION, &filters, period).expect("top");
            }),
        );
    }
    let keys = ["preflop|vs-open|ffffr|BB|call|call".to_owned()];
    report(
        "a leak's examples, all time",
        &times(runs, || {
            reader
                .leak_examples(VERSION, &filters, None, &keys, 30)
                .expect("examples");
        }),
    );
    let removed = writer.clear_analysis().expect("clear");
    println!("removed {removed} rows");
    drop(writer);
    store.close();
}
