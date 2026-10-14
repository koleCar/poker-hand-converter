//! The statistics read path and background pass on a large store
//! (docs/RAIL-PLAN.md R2.3; the HUD's lookup for a table must be well under
//! 10 ms).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     --hands 500000 --keep --dir /tmp/bench          # a generated store
//! cargo run --release -p rail-store --example stats_queries -- \
//!     /tmp/bench/bench-store/rail.db [--pad 300000] [--seconds 60]
//! ```
//!
//! **Writes to the store** (it is meant for a generated benchmark store,
//! never a user's): `--pad N` adds N made-up players to `player_rollups`
//! (`pad-<n>`, spread over the store's segments and sites), because the
//! benchmark dataset rewrites hand ids but not names, so its players are
//! the corpus's few thousand; a real 500k-hand history has 10^5 opponents.
//! Then it times:
//!
//! - the HUD's lookup ([`Reader::hud_totals`]) for 9 players of one site,
//!   the table's segment and all of the site's segments;
//! - one rollup ([`Reader::player_rollup`]);
//! - the hero's totals ([`Reader::hero_totals`]): everything, a date range,
//!   a segment and position filter;
//! - the status ([`Reader::stats_status`]);
//! - the background pass for up to `--seconds` each: the EV queue (preflop
//!   all-ins), then a full rebuild (rates, and the time to the end when it
//!   gets there).

// Rates and milliseconds are printed as decimals.
#![allow(clippy::float_arithmetic)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rail_store::background::{self, Step};
use rail_store::{HeroFilter, Reader, Store};
use rusqlite::{Connection, params};

struct Args {
    db: PathBuf,
    pad: u64,
    seconds: u64,
}

fn args() -> Args {
    let mut it = std::env::args().skip(1);
    let mut args = Args {
        db: PathBuf::new(),
        pad: 0,
        seconds: 60,
    };
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--pad" => args.pad = it.next().and_then(|v| v.parse().ok()).expect("--pad N"),
            "--seconds" => {
                args.seconds = it.next().and_then(|v| v.parse().ok()).expect("--seconds N");
            }
            other => args.db = PathBuf::from(other),
        }
    }
    assert!(
        args.db.is_file(),
        "usage: stats_queries <rail.db> [--pad N]"
    );
    args
}

/// Microseconds of each of `runs` calls of `f`, sorted.
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
    let at = |q: usize| times[(times.len() - 1) * q / 100];
    println!(
        "{what}: median {} us, p99 {} us, max {} us ({} runs)",
        at(50),
        at(99),
        times[times.len() - 1],
        times.len()
    );
}

fn pad(db: &PathBuf, n: u64) {
    let mut conn = Connection::open(db).expect("open");
    let segments: Vec<(i64, String)> = conn
        .prepare("SELECT id, site FROM segments")
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("segments");
    let started = Instant::now();
    let tx = conn.transaction().expect("tx");
    {
        // Plausible sums for a player with ?4 hands: each counter a fraction
        // of them, money a small loss.
        let columns: Vec<&str> = rail_store::stats::rollup_columns().collect();
        let values: Vec<String> = columns
            .iter()
            .enumerate()
            .map(|(i, column)| match *column {
                "hands" | "money_hands" => "?4".to_owned(),
                "net" | "net_bb_milli" => "-?4 * 25".to_owned(),
                _ => format!("?4 / {}", 2 + i % 23),
            })
            .collect();
        let sql = format!(
            "INSERT OR IGNORE INTO player_rollups (site, player, scope, segment_id,
                                                   last_played_at, {})
             VALUES (?1, ?2, '', ?3, '2026-01-01T00:00:00.000Z', {})",
            columns.join(", "),
            values.join(", ")
        );
        let mut insert = tx.prepare(&sql).expect("prepare");
        // A seeded spread: SplitMix64.
        let mut state: u64 = 0x5EED;
        let mut next = || {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        for i in 0..n {
            // Most opponents are seen in one or two segments.
            let spread = 1 + next() % 3;
            for _ in 0..spread {
                let (segment, site) =
                    &segments[usize::try_from(next()).unwrap_or(0) % segments.len()];
                let hands = i64::try_from(1 + next() % 400).unwrap_or(1);
                insert
                    .execute(params![site, format!("pad-{i}"), segment, hands])
                    .expect("insert");
            }
        }
    }
    tx.commit().expect("commit");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM player_rollups", [], |row| row.get(0))
        .expect("count");
    println!(
        "padded: {n} made-up players added in {:.1} s; player_rollups now {rows} rows",
        started.elapsed().as_secs_f64()
    );
}

fn counts(db: &PathBuf) {
    let conn = Connection::open(db).expect("open");
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).expect(sql) };
    println!(
        "store: {} hands, {} seat rows ({} hero), {} player rollups, {} hero rollups, {} segments, \
         {} EV rows, {} EV pending; {:.0} MiB",
        count("SELECT count(*) FROM hands"),
        count("SELECT count(*) FROM seat_stats"),
        count("SELECT count(*) FROM seat_stats WHERE is_hero = 1"),
        count("SELECT count(*) FROM player_rollups"),
        count("SELECT count(*) FROM hero_rollups"),
        count("SELECT count(*) FROM segments"),
        count("SELECT count(*) FROM ev_rows"),
        count("SELECT count(*) FROM ev_pending"),
        f64::from(u32::try_from(std::fs::metadata(db).map_or(0, |m| m.len()) >> 20).unwrap_or(0))
    );
}

fn queries(reader: &Reader, conn: &Connection) {
    // A table: the busiest segment of the busiest site, its 9 most seen
    // players (real ones, not padding).
    let (site, segment): (String, i64) = conn
        .query_row(
            "SELECT site, segment_id FROM player_rollups WHERE player NOT LIKE 'pad-%'
             GROUP BY 1, 2 ORDER BY sum(hands) DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("busiest segment");
    let players: Vec<(String, String)> = conn
        .prepare(
            "SELECT player, scope FROM player_rollups WHERE site = ?1 AND segment_id = ?2
             AND player NOT LIKE 'pad-%' ORDER BY hands DESC LIMIT 9",
        )
        .expect("prepare")
        .query_map(params![site, segment], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("players");
    let table: Vec<(&str, &str)> = players
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    println!(
        "HUD table: {site}, segment {segment}, {} players",
        table.len()
    );
    let started = Instant::now();
    let first = reader
        .hud_totals(&site, &table, Some(&[segment]))
        .expect("hud");
    println!(
        "HUD lookup, first call: {} us ({} hands for the first player)",
        started.elapsed().as_micros(),
        first.first().map_or(0, rail_store::Totals::hands)
    );
    report(
        "HUD lookup, 9 players, the table's segment",
        &times(2000, || {
            reader
                .hud_totals(&site, &table, Some(&[segment]))
                .expect("hud");
        }),
    );
    report(
        "HUD lookup, 9 players, every segment of the site",
        &times(2000, || {
            reader.hud_totals(&site, &table, None).expect("hud");
        }),
    );
    let (player, scope) = &players[0];
    report(
        "one player rollup",
        &times(2000, || {
            reader
                .player_rollup(&site, player, scope, segment)
                .expect("rollup");
        }),
    );
    report(
        "a player's rollups in every segment of the site",
        &times(2000, || {
            reader
                .player_rollups(&site, player, scope)
                .expect("rollups");
        }),
    );

    let played: Vec<String> = conn
        .prepare("SELECT DISTINCT day FROM hero_rollups WHERE day <> '' ORDER BY day")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("days");
    let day = |q: usize| played[(played.len() - 1) * q / 100].clone();
    let busiest: Vec<i64> = conn
        .prepare("SELECT segment_id FROM hero_rollups GROUP BY 1 ORDER BY sum(hands) DESC LIMIT 3")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("segments");
    let filters = [
        ("everything", HeroFilter::default()),
        (
            "a date range (partial days at both ends)",
            HeroFilter {
                from: Some(format!("{}T12:00:00.000Z", day(20))),
                to: Some(format!("{}T12:00:00.000Z", day(80))),
                ..HeroFilter::default()
            },
        ),
        (
            "3 segments x 3 positions, a date range",
            HeroFilter {
                segments: Some(busiest),
                positions: Some(vec!["BTN".to_owned(), "CO".to_owned(), "BB".to_owned()]),
                from: Some(format!("{}T12:00:00.000Z", day(10))),
                to: Some(format!("{}T12:00:00.000Z", day(90))),
                ..HeroFilter::default()
            },
        ),
    ];
    for (what, filter) in &filters {
        let rows = reader.hero_totals(filter).expect("hero");
        let hands: i64 = rows.iter().map(|r| r.totals.hands()).sum();
        report(
            &format!("hero totals, {what} ({} groups, {hands} hands)", rows.len()),
            &times(20, || {
                reader.hero_totals(filter).expect("hero");
            }),
        );
    }
    report(
        "stats status",
        &times(50, || {
            reader.stats_status().expect("status");
        }),
    );
}

fn pass(store: &Store, seconds: u64) {
    let writer = store.writer().expect("writer");
    let reader = store.reader();
    let budget = Duration::from_secs(seconds);
    // The EV queue.
    let started = Instant::now();
    let (mut rows, mut computing) = (0usize, Duration::ZERO);
    while started.elapsed() < budget {
        match background::step(reader, &writer, true).expect("step") {
            Step::Computed(n, took) => {
                rows += n;
                computing += took;
            }
            Step::Rebuilt(_) | Step::Indexed(_) | Step::Counted(_) => {}
            Step::Nothing => break,
        }
    }
    let left = reader.stats_status().expect("status").ev_pending;
    println!(
        "EV pass: {rows} rows in {:.1} s ({:.1} ms of computing each), {left} left",
        started.elapsed().as_secs_f64(),
        computing.as_secs_f64() * 1000.0 / f64::from(u32::try_from(rows.max(1)).unwrap_or(1))
    );
    // A rebuild.
    let total = writer
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("begin");
    let started = Instant::now();
    let mut done = 0usize;
    let mut finished = false;
    while started.elapsed() < budget {
        match background::step(reader, &writer, false).expect("step") {
            Step::Rebuilt(0) => {
                finished = true;
                break;
            }
            Step::Rebuilt(n) => done += n,
            _ => {
                finished = true;
                break;
            }
        }
    }
    let secs = started.elapsed().as_secs_f64();
    println!(
        "rebuild: {done} of {total} hands in {secs:.1} s ({:.0} hands/s){}",
        f64::from(u32::try_from(done).unwrap_or(0)) / secs.max(0.001),
        if finished {
            ", finished"
        } else {
            ", stopped there"
        }
    );
}

/// Finish a rebuild left running (an earlier run's `--seconds` stopped it),
/// so the queries see every hand.
fn finish_rebuild(store: &Store) {
    let writer = store.writer().expect("writer");
    let started = Instant::now();
    let mut done = 0;
    while let Step::Rebuilt(n) = background::step(store.reader(), &writer, false).expect("step") {
        done += n;
    }
    if done > 0 {
        println!(
            "finished a running rebuild: {done} hands in {:.1} s",
            started.elapsed().as_secs_f64()
        );
    }
}

fn main() {
    let args = args();
    let store = Store::open(&args.db).expect("open");
    finish_rebuild(&store);
    if args.pad > 0 {
        pad(&args.db, args.pad);
    }
    counts(&args.db);
    let conn = Connection::open(&args.db).expect("open");
    queries(store.reader(), &conn);
    if args.seconds > 0 {
        pass(&store, args.seconds);
        counts(&args.db);
    }
    store.close();
}
