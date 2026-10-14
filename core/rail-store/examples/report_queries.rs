//! The Today and Reports screens' queries on a large store
//! (docs/RAIL-PLAN.md R2.7b; guideline §1: a report over 1M hands opens in
//! under a second).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     --hands 500000 --keep --dir /tmp/bench          # a generated store
//! cargo run --release -p rail-store --example report_queries -- \
//!     /tmp/bench/bench-store/rail.db [--runs 11]
//! ```
//!
//! Opening the store finishes a pending migration and its rebuild (run here
//! to the end first; the EV queue is left as it is, as the app would show
//! it while the background pass works). Read-only otherwise.
//!
//! Times, each the first (cold) call and the median of `--runs` after it:
//! what opening Reports reads - the hero's totals (`hero_totals`) and the
//! win-rate graph (`report_graph`, 1 500 points), with no filter, one
//! stake, a month and the button - then a breakdown tab's pass
//! (`report_breakdowns`), Today's latest session, and every session.
//! The graph and the breakdowns are cached until the next commit, so the
//! median of a repeated call is the cache's; the first call is the pass.

// Milliseconds are printed as decimals.
#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

use std::path::PathBuf;
use std::time::Instant;

use rail_store::report::{ReportFilter, SESSION_GAP_MINUTES};
use rail_store::{Reader, Store};

fn ms(us: u128) -> f64 {
    us as f64 / 1000.0
}

/// The first call's time and the median of `runs` more, in microseconds.
fn times(runs: usize, mut f: impl FnMut()) -> (u128, u128) {
    let mut once = || {
        let started = Instant::now();
        f();
        started.elapsed().as_micros()
    };
    let first = once();
    let mut rest: Vec<u128> = (0..runs).map(|_| once()).collect();
    rest.sort_unstable();
    (first, rest.get(rest.len() / 2).copied().unwrap_or(first))
}

fn report(what: &str, (first, median): (u128, u128), detail: &str) {
    println!(
        "{what:<52} first {:>8.1} ms  then {:>8.1} ms  {detail}",
        ms(first),
        ms(median)
    );
}

fn open_report(reader: &Reader, filter: &ReportFilter, runs: usize, what: &str) {
    let mut detail = String::new();
    let t = times(runs, || {
        let hero = reader.report_hero_filter(filter).expect("filter");
        let totals = reader.hero_totals(&hero).expect("totals");
        let graph = reader.report_graph(filter, 1500).expect("graph");
        detail = format!(
            "({} groups, {} hands, {} points)",
            totals.len(),
            graph.hands,
            graph.points.len()
        );
    });
    report(&format!("open Reports: {what}"), t, &detail);
    let t = times(runs, || {
        let hero = reader.report_hero_filter(filter).expect("filter");
        reader.hero_totals(&hero).expect("totals");
    });
    report(&format!("  of which hero_totals: {what}"), t, "");
}

fn main() {
    let mut db = PathBuf::new();
    let mut runs = 11;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--runs" => runs = it.next().and_then(|v| v.parse().ok()).expect("--runs N"),
            other => db = PathBuf::from(other),
        }
    }
    assert!(db.is_file(), "usage: report_queries <rail.db> [--runs N]");

    let started = Instant::now();
    let store = Store::open(&db).expect("open");
    println!("open (and migrate): {:.1?}", started.elapsed());
    let writer = store.writer().expect("writer");
    if store
        .reader()
        .stats_status()
        .expect("status")
        .rebuild
        .is_some()
    {
        let started = Instant::now();
        let hands =
            rail_store::recompute::run_rows_job(store.reader(), &writer).expect("recompute");
        println!(
            "rebuild (the list's new columns): {hands} hands in {:.1?}",
            started.elapsed()
        );
    }
    drop(writer);
    let reader = store.reader();
    let status = reader.stats_status().expect("status");
    println!(
        "{} hands, {} waiting for their all-in EV",
        store.status().expect("status").hands,
        status.ev_pending
    );

    // A stake with many hands, the newest month, the button.
    let segments = reader.segments().expect("segments");
    let mut stakes: Vec<String> = segments.iter().map(|row| row.segment.stake.key()).collect();
    stakes.sort();
    stakes.dedup();
    let mut by_stake: Vec<(String, i64)> = Vec::new();
    for stake in stakes {
        let hero = reader
            .report_hero_filter(&ReportFilter {
                stakes: vec![stake.clone()],
                ..ReportFilter::default()
            })
            .expect("filter");
        let hands: i64 = reader
            .hero_totals(&hero)
            .expect("totals")
            .iter()
            .map(|t| t.totals.hands())
            .sum();
        by_stake.push((stake, hands));
    }
    by_stake.sort_by_key(|(_, hands)| -hands);
    let stake = by_stake.first().map(|(s, _)| s.clone()).unwrap_or_default();
    let newest = reader
        .latest_session(SESSION_GAP_MINUTES, 0)
        .expect("session")
        .map(|s| s.ended_at)
        .unwrap_or_default();
    let month_start = format!("{}-01T00:00:00.000Z", newest.get(..7).unwrap_or("2026-01"));

    let filters = [
        ("everything", ReportFilter::default()),
        (
            "cash",
            ReportFilter {
                formats: vec!["cash".to_owned()],
                ..ReportFilter::default()
            },
        ),
        (
            "one stake",
            ReportFilter {
                stakes: vec![stake.clone()],
                ..ReportFilter::default()
            },
        ),
        (
            "the newest month",
            ReportFilter {
                from: Some(month_start),
                ..ReportFilter::default()
            },
        ),
        (
            "the button",
            ReportFilter {
                positions: vec!["BTN".to_owned()],
                ..ReportFilter::default()
            },
        ),
    ];
    for (what, filter) in &filters {
        open_report(reader, filter, runs, &format!("{what} ({stake})"));
    }
    for (what, filter) in &filters {
        let mut detail = String::new();
        let t = times(runs, || {
            let found = reader.report_breakdowns(filter).expect("breakdowns");
            detail = format!(
                "({} pot types, {} starting hands)",
                found.pot_type.len(),
                found.hand_class.len()
            );
        });
        report(&format!("breakdowns by situation: {what}"), t, &detail);
    }
    let mut detail = String::new();
    let t = times(runs, || {
        let session = reader
            .latest_session(SESSION_GAP_MINUTES, 5)
            .expect("session");
        detail = session.map_or_else(String::new, |s| format!("({} hands)", s.hands));
    });
    report("Today: the latest session", t, &detail);
    let t = times(runs.min(3), || {
        let all = reader
            .sessions(SESSION_GAP_MINUTES, usize::MAX, None)
            .expect("sessions");
        detail = format!("({} sessions)", all.len());
    });
    report("every session", t, &detail);
    store.close();
}
