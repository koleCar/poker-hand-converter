//! The Players screen's queries on a large store (docs/RAIL-PLAN.md R2.7c).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     --hands 500000 --keep --rename-players --dir /tmp/bench   # a generated store
//! cargo run --release -p rail-store --example players_queries -- \
//!     /tmp/bench/bench-store/rail.db [--runs 11] [--pad 300000]
//! ```
//!
//! Opening the store finishes a pending migration (version 9 builds the
//! player index on the existing seat rows) and its rebuild (the summary),
//! both timed. Read-only otherwise, except `--pad N`, which adds N made-up
//! opponents (`pad-<n>`, never anyone's name) to `player_summary` so the
//! list is measured at a larger cardinality than the generated dataset
//! gives (the summary only: their profiles and hands do not exist).
//!
//! Times, each the first (cold) call and the median of `--runs` after it:
//! the list (everybody, a kind, a search of one and of three letters, the
//! palette's eight), a profile and its positions' pass for the opponent
//! with the most hands and for a median one, and "hands with this player"
//! (the first page of 100, the chip counts, every page).

// Milliseconds are printed as decimals.
#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

use std::path::PathBuf;
use std::time::Instant;

use rail_store::background;
use rail_store::hand_list::{HandCursor, HandFilter, PlayerRef};
use rail_store::players::{GameKind, PlayerQuery};
use rail_store::{Reader, Store};
use rusqlite::{Connection, params};

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

/// N made-up opponents in the summary, spread over the store's sites.
fn pad(db: &PathBuf, n: u64) {
    let started = Instant::now();
    let mut conn = Connection::open(db).expect("open");
    let sites: Vec<String> = conn
        .prepare("SELECT DISTINCT site FROM player_summary ORDER BY site")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("sites")
        .collect::<Result<_, _>>()
        .expect("rows");
    let tx = conn.transaction().expect("tx");
    {
        let mut insert = tx
            .prepare(
                "INSERT OR IGNORE INTO player_summary (site, player, hands, first_played_at,
                    last_played_at, cash_hands, chips_hands, cash_money_hands,
                    cash_net_bb_milli, chips_money_hands, chips_net_bb_milli)
                 VALUES (?1, ?2, ?3, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
                         ?3, 0, ?3, ?4, 0, 0)",
            )
            .expect("prepare");
        for i in 0..n {
            let site = &sites[usize::try_from(i).expect("i") % sites.len().max(1)];
            let hands = 1 + i64::try_from(i % 97).expect("small");
            insert
                .execute(params![site, format!("pad-{i}"), hands, -150 * hands])
                .expect("insert");
        }
    }
    tx.commit().expect("commit");
    println!(
        "padded: {n} made-up opponents added to player_summary in {:.1?}",
        started.elapsed()
    );
}

fn list(reader: &Reader, query: &PlayerQuery, runs: usize, what: &str) {
    let mut detail = String::new();
    let t = times(runs, || {
        let found = reader.player_list(query).expect("list");
        detail = format!(
            "({} rows of {} matching, {} players in scope)",
            found.rows.len(),
            found.matching,
            found.players
        );
    });
    report(what, t, &detail);
}

fn main() {
    let mut db = PathBuf::new();
    let mut runs = 11;
    let mut padding = 0;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--runs" => runs = it.next().and_then(|v| v.parse().ok()).expect("--runs N"),
            "--pad" => padding = it.next().and_then(|v| v.parse().ok()).expect("--pad N"),
            other => db = PathBuf::from(other),
        }
    }
    assert!(
        db.is_file(),
        "usage: players_queries <rail.db> [--runs N] [--pad N]"
    );

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
            "rebuild (the player summary): {hands} hands in {:.1?}",
            started.elapsed()
        );
    }
    // The background pass's `player_hands`, in its transactions.
    let started = Instant::now();
    let (mut hands, mut steps) = (0, 0);
    loop {
        let step_started = Instant::now();
        let n = writer
            .write(|tx| rail_store::stats::index_players(tx, background::INDEX_PAGE))
            .expect("index");
        if n == 0 {
            break;
        }
        steps += 1;
        hands += n;
        if steps <= 3 {
            println!(
                "  player_hands step {steps}: {n} hands in {:.1?}",
                step_started.elapsed()
            );
        }
    }
    println!(
        "player_hands: {hands} hands in {steps} steps, {:.1?}",
        started.elapsed()
    );
    drop(writer);
    if padding > 0 {
        pad(&db, padding);
    }
    let conn = Connection::open(&db).expect("open");
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).expect(sql) };
    println!(
        "{} hands; {} opponents in player_summary; {} seat rows, {} in player_hands",
        store.status().expect("status").hands,
        count("SELECT count(*) FROM player_summary"),
        count("SELECT count(*) FROM seat_stats"),
        count("SELECT count(*) FROM player_hands"),
    );
    let reader = store.reader();

    let everyone = PlayerQuery {
        limit: 200,
        ..PlayerQuery::default()
    };
    list(reader, &everyone, runs, "list: everybody, 200 rows");
    for (kind, what) in [(GameKind::Cash, "cash"), (GameKind::Chips, "tournaments")] {
        list(
            reader,
            &PlayerQuery {
                kind,
                ..everyone.clone()
            },
            runs,
            &format!("list: {what}"),
        );
    }
    let top = reader.player_list(&everyone).expect("list");
    let first = top.rows.first().expect("an opponent").clone();
    let one: String = first.player.chars().take(1).collect();
    let three: String = first.player.chars().take(3).collect();
    list(
        reader,
        &PlayerQuery {
            search: one.clone(),
            ..everyone.clone()
        },
        runs,
        &format!("list: search \"{one}\""),
    );
    list(
        reader,
        &PlayerQuery {
            search: three.clone(),
            ..everyone.clone()
        },
        runs,
        &format!("list: search \"{three}\""),
    );
    list(
        reader,
        &PlayerQuery {
            search: three.clone(),
            limit: 8,
            ..PlayerQuery::default()
        },
        runs,
        "palette: 8 players",
    );

    // The opponent with the most hands together, and a median one.
    let all = reader
        .player_list(&PlayerQuery {
            limit: rail_store::players::LIST_MAX,
            ..PlayerQuery::default()
        })
        .expect("list");
    let median = all.rows[all.rows.len() / 2].clone();
    for (row, what) in [(&first, "most hands"), (&median, "a median opponent")] {
        let mut detail = String::new();
        let t = times(runs, || {
            let profile = reader
                .player_profile(&row.site, &row.player)
                .expect("profile");
            detail = format!("({} segments)", profile.rollups.len());
        });
        report(
            &format!("profile: {what} ({} hands)", row.seen.hands),
            t,
            &detail,
        );
        let t = times(runs, || {
            let positions = reader
                .player_positions(&row.site, &row.player, None)
                .expect("positions");
            detail = format!("({} positions)", positions.positions.len());
        });
        report(&format!("  by position: {what}"), t, &detail);
        let filter = HandFilter {
            player: Some(PlayerRef {
                site: row.site.clone(),
                player: row.player.clone(),
            }),
            ..HandFilter::default()
        };
        let t = times(runs, || {
            let page = reader.hand_page(&filter, None, 100).expect("page");
            detail = format!("({} rows)", page.rows.len());
        });
        report(
            &format!("  hands with them, first page: {what}"),
            t,
            &detail,
        );
        let t = times(runs, || {
            let facets = reader.hand_facets(&filter).expect("facets");
            detail = format!("({} hands)", facets.total);
        });
        report(
            &format!("  hands with them, chip counts: {what}"),
            t,
            &detail,
        );
        let t = times(runs.min(3), || {
            let mut after: Option<HandCursor> = None;
            let mut n = 0;
            loop {
                let page = reader
                    .hand_page(&filter, after.as_ref(), 300)
                    .expect("page");
                n += page.rows.len();
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            detail = format!("({n} rows)");
        });
        report(
            &format!("  hands with them, every page: {what}"),
            t,
            &detail,
        );
    }
    store.close();
}
