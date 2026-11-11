//! (T1, docs/research/TABLE-TILING.md §4.2) Table tiling's platform calls
//! on Windows with real windows, in CI on the Windows runner: the monitors
//! (`EnumDisplayMonitors`, `rcWork`), and the simulator's tables moved and
//! resized through `Platform::place` - `SetWindowPos` with
//! `SWP_ASYNCWINDOWPOS`, the client area read back. Elsewhere this file is
//! empty.
//!
//! The steps: the monitors are sane (one primary, first; work areas inside
//! them) and every table is on one; a table's client area placed inside
//! the primary work area at another size reads back exactly, the
//! simulator reports the same (its own `window` event) and the find
//! agrees; a minimised table is restored and placed; placing again moves
//! it again; a window that does not exist is refused (`Gone`); a placement
//! returns well within its bound (`PLACE_WAIT`), the asynchronous move
//! notwithstanding.
//!
//! A hung client (`NotResponding`) is not simulated: Windows calls a window
//! hung after 5 s without messages, longer than a CI step should sleep.

#![cfg(windows)]

mod support;

use std::time::{Duration, Instant};

use rail_hud::platform::windows::{PLACE_WAIT, WindowsBackend};
use rail_hud::platform::{Platform, PlatformError, Rect, TableWindow, WindowId};
use support::{
    Seen, Sim, check_monitors, event_client, find_until, listing, matcher, simulator, title_regex,
};

/// The client size asked of the simulator, in logical pixels.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;

/// Wait for the simulator's own report of table `number`'s client area to
/// be `want`, not minimised.
fn the_simulator_agrees(sim: &mut Sim, seen: &mut Seen, number: u64, want: Rect) {
    sim.until(
        seen,
        Duration::from_secs(20),
        &format!("the simulator reports table {number} at {want:?}"),
        |s| {
            s.windows
                .get(&number)
                .is_some_and(|e| event_client(e) == want && e["minimized"].as_bool() == Some(false))
        },
    );
}

/// `place`, timed: it must answer within its bound (twice for a minimised
/// window: the restore, then the move) plus scheduling slack.
fn place_timed(backend: &mut WindowsBackend, id: WindowId, want: Rect) -> Rect {
    let started = Instant::now();
    let placed = backend
        .place(id, want)
        .unwrap_or_else(|e| panic!("place {id:?} at {want:?}: {e}\nwindows:\n{}", listing()));
    let took = started.elapsed();
    eprintln!("  placed {id:?} at {placed:?} in {} ms", took.as_millis());
    assert!(
        took < PLACE_WAIT * 2 + Duration::from_millis(500),
        "place took {took:?}"
    );
    placed
}

#[test]
fn tables_are_placed() {
    let mut backend = WindowsBackend::default();
    let monitors = backend.monitors();
    if let Err(why) = check_monitors(&monitors) {
        panic!("the monitors: {why}");
    }
    eprintln!("step ok: the monitors");

    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let mut sim = Sim::start(
        &sim_path,
        "windows-place",
        &[
            "--tables",
            "2",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "1",
            "--seed",
            "41",
        ],
    );
    let mut seen = Seen::default();
    sim.until(
        &mut seen,
        Duration::from_secs(120),
        "2 shown windows",
        |s| s.tables.len() == 2 && s.windows.len() == 2,
    );
    let matcher = matcher("pokerstars", &regex);
    let found = find_until(
        &mut backend,
        &matcher,
        &mut seen,
        &sim.events,
        "the two tables",
        |found, _| {
            if found.len() == 2 && found.iter().all(|w| !w.minimized) {
                Ok(())
            } else {
                Err(format!("{} found", found.len()))
            }
        },
    );
    for table in &found {
        assert!(
            monitors.iter().any(|m| m.bounds.overlap(&table.client) > 0),
            "table {:?} at {:?} is on no monitor",
            table.title,
            table.client
        );
    }
    let number_of = |seen: &Seen, w: &TableWindow| {
        seen.table_titled(&w.title)
            .unwrap_or_else(|| panic!("no simulator table titled {:?}", w.title))
    };
    let (first, second) = (&found[0], &found[1]);
    let (n1, n2) = (number_of(&seen, first), number_of(&seen, second));

    // Inside the primary monitor's work area, in its physical pixels: one
    // table at the left, the other at the right, at sizes of their own.
    let primary = &monitors[0];
    let scale = primary.scale_permille;
    let px = |logical: u32| logical * scale / 1000;
    let at = |logical: u32| i32::try_from(px(logical)).expect("small");
    let work = primary.work_area;
    let want1 = Rect {
        x: work.x + at(20),
        y: work.y + at(60),
        width: px(720),
        height: px(540),
    };
    let want2 = Rect {
        x: work.x + i32::try_from(work.width).expect("small") - at(640),
        y: work.y + at(80),
        width: px(600),
        height: px(450),
    };
    assert!(work.contains(&want1) && work.contains(&want2), "{work:?}");

    let placed = place_timed(&mut backend, first.id, want1);
    assert_eq!(placed, want1, "table 1's client area read back");
    the_simulator_agrees(&mut sim, &mut seen, n1, want1);
    find_until(
        &mut backend,
        &matcher,
        &mut seen,
        &sim.events,
        "the find agrees with the placement",
        |found, _| match found.iter().find(|w| w.id == first.id) {
            Some(w) if w.client == want1 => Ok(()),
            other => Err(format!("table 1: {other:?}")),
        },
    );
    eprintln!("step ok: a table placed at {want1:?}, read back, reported and found there");

    // A minimised table is restored (not activated), then placed.
    sim.command(&format!("minimize {n2}"));
    sim.until(&mut seen, Duration::from_secs(20), "the minimise", |s| {
        s.windows
            .get(&n2)
            .is_some_and(|e| e["minimized"].as_bool() == Some(true))
    });
    let placed = place_timed(&mut backend, second.id, want2);
    assert_eq!(placed, want2, "the minimised table's client area read back");
    the_simulator_agrees(&mut sim, &mut seen, n2, want2);
    eprintln!("step ok: a minimised table restored and placed at {want2:?}");

    // Table 1 again, somewhere else.
    let again = Rect {
        y: want1.y + at(30),
        width: px(680),
        ..want1
    };
    assert_eq!(place_timed(&mut backend, first.id, again), again);
    the_simulator_agrees(&mut sim, &mut seen, n1, again);

    // A window that does not exist.
    let nowhere = WindowId(0x7fff_fff0);
    assert_eq!(
        backend.place(nowhere, want1),
        Err(PlatformError::Gone(nowhere))
    );
    eprintln!("step ok: placing again moves it again; a window that does not exist is gone");
}
