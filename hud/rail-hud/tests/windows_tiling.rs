//! (T2, docs/research/TABLE-TILING.md §4.3) Table tiling on Windows with
//! real windows, in CI on the Windows runner: three of the simulator's
//! tables laid out by the tiler (`rail_hud::tiling`) through the placement
//! worker (`rail_hud::placer`) and the Windows backend's `WindowsPlacer`,
//! their frames measured as the engine measures them
//! (`Platform::frame_insets`: DWM's visible frame). Elsewhere this file is
//! empty.
//!
//! The checks: every table's frame is a plausible caption and border; the
//! mouse reads as up (nobody touches the runner); after tiling settles,
//! each table's **visible outer rect** - its client area read back plus its
//! frame read again - is its slot's cell within two pixels (the cells are
//! edge to edge by construction: `tiling`'s unit tests), inside a work
//! area, none overlapping, and its client area keeps the simulator's 4:3.

#![cfg(windows)]

mod support;

use std::time::{Duration, Instant};

use rail_hud::placer::Worker;
use rail_hud::platform::windows::{WindowsBackend, WindowsPlacer};
use rail_hud::platform::{Placer, Platform, Rect, TableWindow};
use rail_hud::tiling::{Aspect, Mouse, Observed, Options, Tiler, close};
use support::{Seen, Sim, check_monitors, find_until, matcher, simulator, title_regex};

fn observe(backend: &mut WindowsBackend, found: &[TableWindow]) -> Vec<Observed> {
    found
        .iter()
        .map(|w| Observed {
            id: w.id,
            site: w.site.clone(),
            client: w.client,
            scale_permille: w.scale_permille,
            minimized: w.minimized,
            insets: backend.frame_insets(w),
        })
        .collect()
}

#[test]
fn tables_are_tiled() {
    let mut backend = WindowsBackend::default();
    let monitors = backend.monitors();
    if let Err(why) = check_monitors(&monitors) {
        panic!("the monitors: {why}");
    }
    assert!(!WindowsPlacer.mouse().down, "a mouse button is down");
    eprintln!("step ok: the monitors; the mouse is up");

    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let mut sim = Sim::start(
        &sim_path,
        "windows-tiling",
        &[
            "--tables", "3", "--window", "640x480", "--speed", "1", "--seed", "43",
        ],
    );
    let mut seen = Seen::default();
    sim.until(
        &mut seen,
        Duration::from_secs(120),
        "3 shown windows",
        |s| s.tables.len() == 3 && s.windows.len() == 3,
    );
    let matcher = matcher("pokerstars", &regex);
    let found = find_until(
        &mut backend,
        &matcher,
        &mut seen,
        &sim.events,
        "the three tables",
        |found, _| {
            if found.len() == 3 && found.iter().all(|w| !w.minimized) {
                Ok(())
            } else {
                Err(format!("{} found", found.len()))
            }
        },
    );
    for window in &found {
        let insets = backend.frame_insets(window).expect("a frame");
        eprintln!("  table {:?}: frame {insets:?}", window.title);
        assert!(
            insets.top >= insets.left && insets.top > 0 && insets.top < 200,
            "{insets:?}"
        );
        assert!(insets.left < 50 && insets.right < 50 && insets.bottom < 50);
    }
    eprintln!("step ok: the frames");

    let mut tiler = Tiler::new(Options::default());
    tiler.set_monitors(monitors.clone());
    let placer = backend.placer().expect("Windows places");
    let worker = Worker::start(placer).expect("the worker");
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut stable_since: Option<(Instant, Vec<Rect>)> = None;
    let found = loop {
        assert!(
            Instant::now() < deadline,
            "tiling did not settle: {tiler:?}"
        );
        seen.drain(&sim.events);
        let found = backend
            .find_tables(std::slice::from_ref(&matcher))
            .expect("find");
        let now = Instant::now();
        tiler.sync(&observe(&mut backend, &found), now, Mouse::Idle);
        for done in worker.results() {
            tiler.placed(done.id, done.seq, &done.result, now);
        }
        for m in tiler.plan() {
            worker.place(m);
        }
        let rects: Vec<Rect> = found.iter().map(|w| w.client).collect();
        if tiler.settled() {
            match &stable_since {
                Some((since, before)) if *before == rects => {
                    if since.elapsed() >= Duration::from_millis(800) {
                        break found;
                    }
                }
                _ => stable_since = Some((Instant::now(), rects)),
            }
        } else {
            stable_since = None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    drop(worker);

    let four_three = Aspect {
        width: 4,
        height: 3,
    };
    let mut outers = Vec::new();
    for window in &found {
        let insets = backend.frame_insets(window).expect("a frame");
        let outer = insets.outer(&window.client);
        let slot = tiler.slot_of(window.id).expect("a slot");
        let cell = tiler.slots()[slot].cell;
        eprintln!(
            "  table {:?}: client {:?}, outer {outer:?}, cell {cell:?}",
            window.title, window.client
        );
        assert!(close(&outer, &cell), "{outer:?} is not its cell {cell:?}");
        assert!(
            four_three.holds(window.client.width, window.client.height),
            "{:?}",
            window.client
        );
        assert!(
            monitors.iter().any(|m| {
                let w = m.work_area;
                let grown = Rect {
                    x: w.x - 2,
                    y: w.y - 2,
                    width: w.width + 4,
                    height: w.height + 4,
                };
                grown.contains(&outer)
            }),
            "{outer:?} is in no work area"
        );
        outers.push(outer);
    }
    for (i, a) in outers.iter().enumerate() {
        for b in &outers[i + 1..] {
            // Within the two pixels `close` allows on each edge.
            assert!(
                a.overlap(b) <= u64::from(a.height.max(a.width)) * 4,
                "{a:?} overlaps {b:?}"
            );
        }
    }
    eprintln!("step ok: three tables tiled on their visible frames, the aspect kept");
}
