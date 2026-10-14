//! The targeted recompute on a large store (docs/RAIL-PLAN.md R2.11): how
//! long each kind of definition change takes to bring the statistics up to
//! date, and how long its swap holds the writer.
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     --hands 500000 --keep --dir /tmp/bench --rename-players --spread
//! cargo run --release -p rail-store --example recompute_bench -- \
//!     /tmp/bench/bench-store/rail.db [--cases predicate,segments,rebuild,counters,list,ev] \
//!     [--ev-seconds 120]
//! ```
//!
//! **Writes to the store** (a generated benchmark store, never a user's).
//! Each case changes something and times the work that brings the store up
//! to date again, one thread, release:
//!
//! - `predicate`: a custom statistic's predicate edited (saved first if the
//!   store has none) - the custom pass counts that statistic again; and a
//!   formula and label edit, which counts nothing;
//! - `segments`: the segment definition's version moved on - the segments
//!   job (each hand's segment from its PHF, the stored seat rows summed
//!   into the rollups' twins, the swap);
//! - `rebuild`: "rebuild statistics" on a store whose rows are right - the
//!   rows job derives and compares every hand, stages none;
//! - `counters`: a counter of every tenth opponent seat changed by hand, as
//!   a `STATS_VERSION` bump that changes a counter would find it - the rows
//!   job stages those hands;
//! - `list`: every hero hand's list row changed by hand (the hero's `wtsd`
//!   flag), the most a rows job can stage - the swap's worst case;
//! - `ev`: the `EV_VERSION` moved on - the EV job over every hero hand not
//!   waiting in the EV queue, for up to `--ev-seconds`, the rest
//!   extrapolated; the preflop all-ins still queued after the import (a
//!   real store has evaluated them, and the job would evaluate them again)
//!   are timed on a sample and added.

// Rates and seconds are printed as decimals.
#![allow(clippy::float_arithmetic)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_stats::Counter;
use rail_stats::custom::CustomDef;
use rail_store::background::{self, Step};
use rail_store::recompute::{self, RowsJob};
use rail_store::stats::{decode_seat, encode_seat};
use rail_store::{Reader, Store, WriterHandle};
use rusqlite::params;

const VPIP: &str = "any street = preflop and not bomb_pot and not (walk and big_blind) \
                    => action in (call, bet, raise)";
const CBET: &str = "first street = flop and first_on_street and preflop_aggressor \
                    and barrels = 0 and facing = none and not bomb_pot => action = bet";

struct Args {
    db: PathBuf,
    cases: Vec<String>,
    ev_seconds: u64,
}

fn args() -> Args {
    let mut it = std::env::args().skip(1);
    let mut args = Args {
        db: PathBuf::new(),
        cases: ["predicate", "segments", "rebuild", "counters", "list", "ev"]
            .map(str::to_owned)
            .to_vec(),
        ev_seconds: 120,
    };
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--cases" => {
                args.cases = it
                    .next()
                    .expect("--cases a,b")
                    .split(',')
                    .map(str::to_owned)
                    .collect();
            }
            "--ev-seconds" => {
                args.ev_seconds = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--ev-seconds N");
            }
            other => args.db = PathBuf::from(other),
        }
    }
    assert!(
        args.db.is_file(),
        "usage: recompute_bench <rail.db> [--cases ...] [--ev-seconds N]"
    );
    args
}

/// A count as a float (counts here are far under 2^32).
fn float(n: impl TryInto<u32>) -> f64 {
    f64::from(n.try_into().unwrap_or(u32::MAX))
}

fn text(value: &str) -> Text {
    Text {
        en: value.to_owned(),
        hr: value.to_owned(),
    }
}

fn custom(predicate: &str, label: &str) -> CustomDef {
    CustomDef {
        def: StatDef {
            id: "my_vpip".to_owned(),
            group: Group::Preflop,
            players: Players::Any,
            label: text(label),
            name: text("My statistic"),
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
        predicate: Some(predicate.to_owned()),
    }
}

/// The custom pass to its end: (hands counted, seconds).
fn count_custom(reader: &Reader, writer: &WriterHandle) -> (usize, f64) {
    let started = Instant::now();
    let mut hands = 0;
    while let Some(n) = rail_store::custom::custom_step(reader, writer).expect("custom step") {
        hands += n;
    }
    (hands, started.elapsed().as_secs_f64())
}

/// A rows job to its swap, page by page: (hands, staged, seconds of
/// pages, seconds of the swap).
fn rows_job(reader: &Reader, writer: &WriterHandle) -> (usize, usize, f64, f64) {
    let (mut hands, mut staged) = (0, 0);
    let started = Instant::now();
    let mut swap = 0.0;
    while let Some(page) = recompute::rows_page(reader, writer).expect("page") {
        if page.hands() == 0 {
            let t = Instant::now();
            writer
                .write(|tx| recompute::finish_rows(tx))
                .expect("finish");
            swap += t.elapsed().as_secs_f64();
            continue;
        }
        hands += page.hands();
        staged += page.staged();
        writer
            .write(move |tx| recompute::apply_rows_page(tx, page))
            .expect("apply");
    }
    let total = started.elapsed().as_secs_f64();
    (hands, staged, total - swap, swap)
}

fn print_rows(what: &str, job: (usize, usize, f64, f64)) {
    let (hands, staged, pages, swap) = job;
    println!(
        "{what}: {hands} hands in {pages:.1} s ({:.0} hands/s), {staged} staged; the swap {:.0} ms; \
         {:.1} s in all",
        float(hands) / pages.max(0.001),
        swap * 1000.0,
        pages + swap
    );
}

fn main() {
    let args = args();
    let started = Instant::now();
    let store = Store::open(&args.db).expect("open");
    println!("open (and migrate): {:.1?}", started.elapsed());
    let writer = store.writer().expect("writer");
    let reader = store.reader();
    println!("{} hands", store.status().expect("status").hands);
    // Whatever is left to do but EV (the players' index, custom counts).
    let t = Instant::now();
    while background::step(reader, &writer, false).expect("step") != Step::Nothing {}
    println!("catch-up: {:.1?}", t.elapsed());

    for case in &args.cases {
        match case.as_str() {
            "predicate" => {
                let has = !reader.custom_stats().expect("stats").is_empty();
                if !has {
                    let def = custom(VPIP, "V");
                    writer
                        .write(move |tx| rail_store::custom::save_custom_stat(tx, None, &def, 1))
                        .expect("save");
                    let (hands, secs) = count_custom(reader, &writer);
                    println!("a new custom statistic: {hands} hands counted in {secs:.1} s");
                }
                let def = custom(CBET, "V");
                writer
                    .write(move |tx| {
                        rail_store::custom::save_custom_stat(tx, Some("my_vpip"), &def, 2)
                    })
                    .expect("save");
                let (hands, secs) = count_custom(reader, &writer);
                println!(
                    "predicate edited: {hands} hands counted again in {secs:.1} s ({:.0} hands/s)",
                    float(hands) / secs.max(0.001)
                );
                let def = custom(CBET, "C");
                writer
                    .write(move |tx| {
                        rail_store::custom::save_custom_stat(tx, Some("my_vpip"), &def, 3)
                    })
                    .expect("save");
                let (hands, secs) = count_custom(reader, &writer);
                println!("label edited: {hands} hands counted ({secs:.3} s)");
            }
            "segments" => {
                writer
                    .write(|tx| recompute::begin_rows(tx, RowsJob::Segments))
                    .expect("begin");
                print_rows("segments job", rows_job(reader, &writer));
                let (hands, secs) = count_custom(reader, &writer);
                println!("  then custom counts: {hands} hands ({secs:.1} s)");
            }
            "rebuild" => {
                writer
                    .write(|tx| recompute::begin_rows(tx, RowsJob::Rows))
                    .expect("begin");
                print_rows("rows job, nothing changed", rows_job(reader, &writer));
                let (hands, secs) = count_custom(reader, &writer);
                println!("  then custom counts: {hands} hands ({secs:.1} s)");
            }
            "counters" => {
                let t = Instant::now();
                let changed = writer
                    .write(|tx| {
                        let seats: Vec<(i64, i64, Vec<u8>)> = tx
                            .prepare(
                                "SELECT hand_id, seat, totals FROM seat_stats
                                 WHERE is_hero = 0 AND (hand_id + seat) % 10 = 0",
                            )?
                            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                            .collect::<rusqlite::Result<_>>()?;
                        let mut update = tx.prepare(
                            "UPDATE seat_stats SET totals = ?3 WHERE hand_id = ?1 AND seat = ?2",
                        )?;
                        for (hand, seat, blob) in &seats {
                            let mut values = decode_seat(blob)?;
                            values.counters[Counter::cbet_flop_opp.index()] += 1;
                            update.execute(params![hand, seat, encode_seat(&values)])?;
                        }
                        recompute::begin_rows(tx, RowsJob::Rows)?;
                        Ok(seats.len())
                    })
                    .expect("change a counter");
                println!(
                    "a counter changed on {changed} opponent seats ({:.1?})",
                    t.elapsed()
                );
                print_rows("rows job, a counter changed", rows_job(reader, &writer));
                let (hands, secs) = count_custom(reader, &writer);
                println!("  then custom counts: {hands} hands ({secs:.1} s)");
            }
            "list" => {
                let changed = writer
                    .write(|tx| {
                        let n = tx.execute(
                            "UPDATE hand_list SET hero_wtsd = 1 - hero_wtsd
                             WHERE hero_net IS NOT NULL",
                            [],
                        )?;
                        recompute::begin_rows(tx, RowsJob::Rows)?;
                        Ok(n)
                    })
                    .expect("change the list");
                println!("the list rows of {changed} hero hands changed");
                print_rows("rows job, every hero list row", rows_job(reader, &writer));
            }
            "ev" => {
                // The preflop all-ins the import left queued: their cost, on
                // a sample.
                let sample: Vec<(Vec<u8>, i64)> = reader
                    .with(|conn| {
                        Ok(conn
                            .prepare(
                                "SELECT h.phf, h.phf_size FROM ev_pending p
                                 JOIN hands h ON h.hand_key = p.hand_key
                                 ORDER BY p.id LIMIT 120",
                            )?
                            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                            .collect::<rusqlite::Result<_>>()?)
                    })
                    .expect("sample");
                let queued = reader.stats_status().expect("status").ev_pending;
                let t = Instant::now();
                for (blob, size) in &sample {
                    let json = rail_store::batch::decompress_phf(
                        blob,
                        u64::try_from(*size).expect("size"),
                    )
                    .expect("phf");
                    let hand: rail_core::phf::PhfHand = serde_json::from_str(&json).expect("hand");
                    let _ = rail_equity::ev_row_for(&hand);
                }
                let per_preflop = t.elapsed().as_secs_f64() / float(sample.len().max(1));
                let total = writer.write(|tx| recompute::begin_ev(tx)).expect("begin");
                let t = Instant::now();
                let (mut hands, mut computing) = (0, Duration::ZERO);
                let mut finished = false;
                while t.elapsed() < Duration::from_secs(args.ev_seconds) {
                    match recompute::ev_step(reader, &writer).expect("step") {
                        None => {
                            finished = true;
                            break;
                        }
                        Some((n, took)) => {
                            hands += n;
                            computing += took;
                        }
                    }
                }
                let secs = t.elapsed().as_secs_f64();
                let rate = float(hands) / secs.max(0.001);
                let left = total.saturating_sub(hands as u64);
                let rest = if finished {
                    0.0
                } else {
                    float(left) / rate.max(0.001)
                };
                println!(
                    "EV job: {hands} of {total} hero hands in {secs:.1} s ({rate:.0} hands/s, \
                     {:.1} s computing){}; the {queued} preflop all-ins {:.1} ms each on a sample \
                     of {}: {:.0} s more in a store that has evaluated them; about {:.0} s in all",
                    computing.as_secs_f64(),
                    if finished {
                        ", swapped".to_owned()
                    } else {
                        format!(", {left} left: ~{rest:.0} s more")
                    },
                    per_preflop * 1000.0,
                    sample.len(),
                    float(queued) * per_preflop,
                    secs + rest + float(queued) * per_preflop
                );
            }
            other => println!("no such case: {other}"),
        }
    }
    drop(writer);
    store.close();
}
