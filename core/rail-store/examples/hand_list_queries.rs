//! The Hands screen's queries on a large store (docs/RAIL-PLAN.md R2.7a:
//! the first page of the list in under 50 ms at 500k hands).
//!
//! ```text
//! cargo run --release -p rail-watch --example import_bench -- \
//!     --hands 500000 --keep --dir /tmp/bench          # a generated store
//! cargo run --release -p rail-store --example hand_list_queries -- \
//!     /tmp/bench/bench-store/rail.db [--runs 21]
//! ```
//!
//! **Writes to the store** (it is meant for a generated benchmark store,
//! never a user's): notes and tags on a seeded 0.5 % of the hands, so the
//! note and tag filters have something to find. Opening it also finishes
//! a pending migration (and its rebuild, run here to the end first).
//!
//! Times the first page (100 rows) with no filter and with each kind of
//! filter, a deep page (the 200th, through the cursor), the chip counts
//! (after a commit, so the counting pass runs; then with a chip clicked,
//! which reuses it), "go to hand" by an id prefix, and one hand's PHF out
//! of the store.

// Milliseconds are printed as decimals.
#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

use std::path::PathBuf;
use std::time::Instant;

use rail_store::background::{self, Step};
use rail_store::hand_list::{self, HandCursor, HandFilter};
use rail_store::{Reader, Store};

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

fn report(what: &str, times: &[u128], rows: usize) {
    let ms = |us: u128| us as f64 / 1000.0;
    println!(
        "{what:<44} median {:>8.2} ms  max {:>8.2} ms  ({rows} rows)",
        ms(times[times.len() / 2]),
        ms(times[times.len() - 1]),
    );
}

fn page(reader: &Reader, filter: &HandFilter, runs: usize, what: &str) {
    let mut rows = 0;
    let t = times(runs, || {
        rows = reader
            .hand_page(filter, None, 100)
            .expect("page")
            .rows
            .len();
    });
    report(what, &t, rows);
}

fn main() {
    let mut db = PathBuf::new();
    let mut runs = 21;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--runs" => runs = it.next().and_then(|v| v.parse().ok()).expect("--runs N"),
            other => db = PathBuf::from(other),
        }
    }
    assert!(
        db.is_file(),
        "usage: hand_list_queries <rail.db> [--runs N]"
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
        let mut hands = 0;
        loop {
            match background::step(store.reader(), &writer, false).expect("step") {
                Step::Rebuilt(n) => hands += n,
                Step::Nothing => break,
                Step::Computed(..) | Step::Indexed(_) | Step::Counted(_) => {}
            }
        }
        println!(
            "rebuild (the list rows of an older store): {hands} hands in {:.1?}",
            started.elapsed()
        );
    }
    let reader = store.reader();
    let hands = store.status().expect("status").hands;
    println!("{hands} hands");

    // Notes and tags on a seeded sample.
    let keys: Vec<String> = {
        let mut keys = Vec::new();
        let mut after: Option<HandCursor> = None;
        let filter = HandFilter::default();
        loop {
            let page = reader
                .hand_page(&filter, after.as_ref(), hand_list::PAGE_MAX)
                .expect("page");
            keys.extend(page.rows.iter().map(|row| row.hand_key.clone()));
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        keys
    };
    let started = Instant::now();
    let sample: Vec<String> = keys.iter().step_by(200).cloned().collect();
    let tagged = sample.len();
    writer
        .write(move |tx| {
            for (i, key) in sample.iter().enumerate() {
                if i % 2 == 0 {
                    hand_list::set_note(tx, key, "bench note", 1)?;
                }
                hand_list::add_tag(tx, key, if i % 3 == 0 { "bench-a" } else { "bench-b" }, 1)?;
            }
            Ok(())
        })
        .expect("annotate");
    println!(
        "walked the whole list ({} rows) and tagged {tagged} hands in {:.1?}",
        keys.len(),
        started.elapsed()
    );

    let newest = keys.first().cloned().unwrap_or_default();
    let segments = reader.segments().expect("segments");
    let common_stake = segments
        .iter()
        .map(|s| s.segment.stake.key())
        .find(|stake| stake != "chips")
        .unwrap_or_default();
    let site = segments
        .first()
        .map(|s| s.segment.site.clone())
        .unwrap_or_default();
    let newest_row = reader
        .hand_rows(std::slice::from_ref(&newest))
        .expect("row");
    let newest_at = newest_row
        .first()
        .and_then(|row| row.played_at.clone())
        .unwrap_or_default();
    // The newest hand's month (`YYYY-MM-`): a recent date range.
    let month = newest_at[..newest_at.len().min(8)].to_owned();
    println!("newest hand played at {newest_at}");

    let any = HandFilter::default();
    page(reader, &any, runs, "first page, no filter");
    page(
        reader,
        &HandFilter {
            positions: vec!["BTN".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, hero on the BTN",
    );
    page(
        reader,
        &HandFilter {
            stakes: vec![common_stake.clone()],
            ..HandFilter::default()
        },
        runs,
        &format!("first page, stake {common_stake}"),
    );
    page(
        reader,
        &HandFilter {
            sites: vec![site.clone()],
            sizes: vec!["6max".to_owned()],
            ..HandFilter::default()
        },
        runs,
        &format!("first page, {site} 6-max"),
    );
    page(
        reader,
        &HandFilter {
            results: vec!["won".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, hero won",
    );
    page(
        reader,
        &HandFilter {
            pot_types: vec!["3bet".to_owned()],
            stacks: vec!["80-120".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, 3-bet pot, 80-120 bb",
    );
    page(
        reader,
        &HandFilter {
            all_in: Some(true),
            ..HandFilter::default()
        },
        runs,
        "first page, all in",
    );
    page(
        reader,
        &HandFilter {
            from: Some(month.clone()),
            ..HandFilter::default()
        },
        runs,
        &format!("first page, from {month}01 (newest month)"),
    );
    page(
        reader,
        &HandFilter {
            to: Some("2015-01-01".to_owned()),
            ..HandFilter::default()
        },
        runs,
        "first page, before 2015",
    );
    page(
        reader,
        &HandFilter {
            has_note: Some(true),
            ..HandFilter::default()
        },
        runs,
        "first page, with a note",
    );
    page(
        reader,
        &HandFilter {
            tags: vec!["bench-a".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, tag bench-a",
    );
    page(
        reader,
        &HandFilter {
            positions: vec!["SB".to_owned()],
            results: vec!["won".to_owned()],
            all_in: Some(true),
            pot_types: vec!["4bet+".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, SB won 4-bet+ all in (rare)",
    );
    page(
        reader,
        &HandFilter {
            sites: vec!["no-such-room".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, a room with no hands",
    );
    page(
        reader,
        &HandFilter {
            positions: vec!["no-such-position".to_owned()],
            ..HandFilter::default()
        },
        runs,
        "first page, matching nothing (full scan)",
    );

    // A deep page: the 200th of 100, reached through the cursor.
    let deep = keys.get(199 * 100 - 1).and_then(|key| {
        reader
            .hand_rows(std::slice::from_ref(key))
            .expect("row")
            .first()
            .map(|row| row.cursor())
    });
    if let Some(cursor) = deep {
        let mut rows = 0;
        let t = times(runs, || {
            rows = reader
                .hand_page(&any, Some(&cursor), 100)
                .expect("page")
                .rows
                .len();
        });
        report("the 200th page, no filter", &t, rows);
    }

    for (what, filter) in [
        ("chip counts, no filter", HandFilter::default()),
        (
            "chip counts, filtered (BTN, won)",
            HandFilter {
                positions: vec!["BTN".to_owned()],
                results: vec!["won".to_owned()],
                ..HandFilter::default()
            },
        ),
        (
            "chip counts, a date range",
            HandFilter {
                from: Some(month.clone()),
                ..HandFilter::default()
            },
        ),
        (
            "chip counts, a tag",
            HandFilter {
                tags: vec!["bench-a".to_owned()],
                ..HandFilter::default()
            },
        ),
    ] {
        // A pass of its own each run: a commit between runs (a note
        // written and taken off) makes the cached one stale.
        let mut total = 0;
        let t = times(runs.min(7), || {
            let key = newest.clone();
            writer
                .write(move |tx| {
                    hand_list::set_note(tx, &key, "x", 2)?;
                    hand_list::set_note(tx, &key, "", 2)
                })
                .expect("commit");
            total = reader.hand_facets(&filter).expect("facets").total;
        });
        report(what, &t, usize::try_from(total).unwrap_or(0));
        // Then chips clicked over the same date range, notes and tags: the
        // pass is reused.
        let mut clicked = filter.clone();
        let t = times(runs, || {
            clicked.positions = if clicked.positions.is_empty() {
                vec!["CO".to_owned()]
            } else {
                Vec::new()
            };
            total = reader.hand_facets(&clicked).expect("facets").total;
        });
        report(
            "  ... a chip clicked (pass reused)",
            &t,
            usize::try_from(total).unwrap_or(0),
        );
    }

    let id = newest_row
        .first()
        .map(|row| row.site_hand_id.clone())
        .unwrap_or_default();
    let prefix = &id[..id.len().saturating_sub(3)];
    let mut found = 0;
    let t = times(runs, || {
        found = reader.find_hands(prefix, 20).expect("find").len();
    });
    report(&format!("go to hand, id prefix {prefix}"), &t, found);
    let t = times(runs, || {
        found = reader.find_hands(&id, 20).expect("find").len();
    });
    report("go to hand, a whole id", &t, found);
    let mut size = 0;
    let t = times(runs, || {
        size = reader
            .hand_phf(&newest)
            .expect("phf")
            .map_or(0, |json| json.len());
    });
    report(
        "one hand's PHF (decompressed JSON)",
        &t,
        usize::from(size > 0),
    );

    drop(writer);
    store.close();
}
