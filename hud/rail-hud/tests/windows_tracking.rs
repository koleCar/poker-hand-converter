//! Following tables on Windows with real windows (docs/RAIL-PLAN.md R3.5),
//! in CI on the Windows runner (the `core` job's `cargo test`). Elsewhere
//! this file is empty.
//!
//! - `hooks_follow_every_change`: the Windows backend in this process, the
//!   table simulator's three tables (one process). A scripted
//!   `SetWindowPos` sequence on one table: its overlay covers the table's
//!   client rect again after every move (the lag measured, p50 / p95),
//!   never repainted, the other tables' overlays untouched, and
//!   `poll_events` gives the engine one `Moved`. Then the simulator's own
//!   `move`, a resize (one repaint at the new size), minimise and restore,
//!   each overlay directly above its table once shown and after a raise
//!   and a focus, and put back by the overlay thread's 250 ms look when a
//!   window slips in between, a tournament-style table move (the
//!   new table's name through the room's matcher, long before any re-find
//!   would), a hidden and shown table (gone, then `Appeared`), a storm of a
//!   hundred moves in one second (lag, the overlay thread's CPU), a closed
//!   table and the process's exit (every overlay gone, the process
//!   unhooked).
//! - `the_hud_follows_the_tracking_script`: `rail-hud --standalone` and the
//!   simulator running `hud/rail-hud-sim/scripts/tracking.txt`: after each
//!   step the simulator reports (`window`, `table`, `closed`), the HUD's
//!   overlay of that table is where the table is, hidden while it is
//!   minimised, gone when it closed; a table move is seen as one.
//! - `the_hud_follows_a_drag`: the HUD process during a hundred moves in a
//!   second - lag per move, its CPU, and the overlay never going back to
//!   an older position or hiding (the periodic re-find does not fight the
//!   hooks); a hidden and shown table; the simulator killed.
//!
//! Each step prints `step ok: ...`; a failure prints what the backend knew,
//! what the simulator said and every window Windows reported. Lines
//! starting `R3.5 ` are the measurements docs/RAIL-PLAN.md records.
//!
//! Not tested here: a monitor of another dpi (the runner has one 96 dpi
//! monitor). `platform::tracking`'s unit tests hold the scale logic (a
//! monitor change at the same size repaints at the new scale), and the
//! scale read here is printed.

#![cfg(windows)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::platform::tracking::Stacking;
use rail_hud::platform::windows::{OVERLAY_CLASS, WindowsBackend, drive, enumerate, probe};
use rail_hud::platform::{OverlayFrame, Platform, Rect, TableEvent, TableWindow, WindowId};
use serde_json::Value;
use support::{Hud, Seen, Sim, find_until, listing, matcher, simulator, title_regex, wait_for};

/// The simulator's client size, logical pixels.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;

/// One frame at 60 Hz.
const FRAME: Duration = Duration::from_micros(16_667);

/// One test at a time: each starts its own simulator, and the test-only
/// room entry takes every simulator window on the desktop.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn waiting(seats: u32) -> OverlayFrame {
    let permit = Compliance::shipped()
        .expect("shipped")
        .permit("pokerstars")
        .expect("permitted");
    OverlayFrame::status(permit, Some(seats), "waiting for first hand")
}

fn percentile(sorted: &[Duration], p: usize) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

fn summary(lags: &[Duration]) -> (Duration, Duration, Duration) {
    let mut sorted = lags.to_vec();
    sorted.sort_unstable();
    (
        percentile(&sorted, 50),
        percentile(&sorted, 95),
        sorted.last().copied().unwrap_or_default(),
    )
}

fn us(d: Duration) -> u128 {
    d.as_micros()
}

/// Spin until `overlay` covers `target` and shows; how long that took.
fn until_covers(overlay: WindowId, target: Rect, limit: Duration) -> Result<Duration, String> {
    let started = Instant::now();
    loop {
        let now = probe::window_rect(overlay);
        if now == Some(target) && probe::visible(overlay) {
            return Ok(started.elapsed());
        }
        if started.elapsed() > limit {
            return Err(format!(
                "overlay {:#x} at {now:?} (shown {}), the table's client area {target:?}",
                overlay.0,
                probe::visible(overlay)
            ));
        }
        std::thread::yield_now();
    }
}

/// Spin until `check` holds; how long that took.
fn until(limit: Duration, mut check: impl FnMut() -> bool) -> Option<Duration> {
    let started = Instant::now();
    loop {
        if check() {
            return Some(started.elapsed());
        }
        if started.elapsed() > limit {
            return None;
        }
        std::thread::sleep(Duration::from_micros(200));
    }
}

/// The frame position that puts table `id` at offset (`dx`, `dy`) from
/// `origin`.
fn moved(origin: Rect, dx: i32, dy: i32) -> (i32, i32) {
    (origin.x + dx, origin.y + dy)
}

/// A hundred distinct offsets, a zigzag of about 150 x 40 pixels.
fn storm_offsets() -> Vec<(i32, i32)> {
    (0..100)
        .map(|i: i32| ((i % 25) * 6 - 72, (i / 25) * 10 - 15))
        .collect()
}

/// Poll the backend until an event `want` accepts arrives (or `limit`);
/// every event seen.
fn poll_until(
    backend: &mut WindowsBackend,
    limit: Duration,
    want: impl Fn(&TableEvent) -> bool,
) -> (Option<Duration>, Vec<TableEvent>) {
    let started = Instant::now();
    let mut all = Vec::new();
    loop {
        let events = backend.poll_events();
        let found = events.iter().any(&want);
        all.extend(events);
        if found {
            return (Some(started.elapsed()), all);
        }
        if started.elapsed() > limit {
            return (None, all);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

struct Table {
    window: TableWindow,
    number: u64,
    overlay: WindowId,
}

fn state(backend: &WindowsBackend, tables: &[Table]) -> String {
    tables
        .iter()
        .map(|t| {
            format!(
                "  table {} {:#x}: client {:?}, overlay {:#x} at {:?} shown {} exists {}; {:?}",
                t.number,
                t.window.id.0,
                probe::client_area(t.window.id),
                t.overlay.0,
                probe::window_rect(t.overlay),
                probe::visible(t.overlay),
                probe::exists(t.overlay),
                backend.overlay_info(t.window.id)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The tables whose overlay is not directly above them (the overlay
/// thread's own rule, `tracking::stacking`), each with where it is and
/// the first window it covers; empty when every overlay is in place.
fn misstacked(tables: &[Table]) -> Vec<String> {
    tables
        .iter()
        .filter_map(|t| {
            let (stacking, covered) = probe::stacking(t.overlay, t.window.id);
            (stacking != Stacking::Directly).then(|| {
                format!(
                    "table {}: overlay {:#x} {stacking}{}",
                    t.number,
                    t.overlay.0,
                    covered.map_or_else(String::new, |w| format!(" (first covered: {:#x})", w.0))
                )
            })
        })
        .collect()
}

/// Every overlay's restacks so far (when, why, where it was, what it was
/// put after, where it is then), for the step's output.
fn restacks(backend: &WindowsBackend, tables: &[Table]) -> String {
    tables
        .iter()
        .map(|t| {
            let info = backend.overlay_info(t.window.id).unwrap_or_default();
            format!(
                "  table {}: restacked {}{}",
                t.number,
                info.restacked,
                info.restacks
                    .iter()
                    .map(|line| format!("\n    {line}"))
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Wait up to `limit` for every overlay to be directly above its table;
/// how long that took, or a failure naming each misplaced overlay, every
/// restack the overlay thread made and the whole z-order.
fn until_stacked(
    backend: &WindowsBackend,
    tables: &[Table],
    limit: Duration,
    context: impl Fn() -> String,
) -> Duration {
    until(limit, || misstacked(tables).is_empty()).unwrap_or_else(|| {
        panic!(
            "an overlay is not directly above its table after {limit:?}:\n  {}\nrestacks:\n{}\n{}",
            misstacked(tables).join("\n  "),
            restacks(backend, tables),
            context()
        )
    })
}

#[test]
fn hooks_follow_every_change() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let room = matcher("pokerstars", &regex);
    let mut sim = Sim::start(
        &sim_path,
        "tracking",
        &[
            "--tables",
            "3",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "0.5",
            "--seed",
            "21",
        ],
    );
    let sim_pid = sim.child.id();
    let mut seen = Seen::default();
    seen.until(
        &sim.events,
        Duration::from_secs(90),
        "3 shown windows",
        |s| s.tables.len() == 3 && s.windows.len() == 3,
    );
    let mut backend = WindowsBackend::default();
    let found = find_until(
        &mut backend,
        &room,
        &mut seen,
        &sim.events,
        "the three tables",
        |found, _| {
            if found.len() == 3 && found.iter().all(|w| !w.minimized && w.client.width > 0) {
                Ok(())
            } else {
                Err(format!("{} tables found", found.len()))
            }
        },
    );
    eprintln!(
        "R3.5 runner: scale {} (one monitor; no dpi change is possible here)",
        found[0].scale_permille
    );

    let mut tables = Vec::new();
    for window in &found {
        let number = seen.table_titled(&window.title).expect("a simulator table");
        backend.track(window).expect("track");
        backend
            .overlay(window.id, &waiting(seen.tables[&number].2))
            .expect("overlay");
        let info = wait_for(
            Duration::from_secs(10),
            "an overlay shown",
            || match backend.overlay_info(window.id) {
                Some(info) if info.shown && info.renders >= 1 => Ok(info),
                other => Err(format!("table {number}: {other:?}")),
            },
        );
        tables.push(Table {
            window: window.clone(),
            number,
            overlay: info.window.expect("an overlay window"),
        });
    }
    assert_eq!(
        backend.hooked_processes(),
        [sim_pid],
        "one process, hooked once"
    );
    let context = |backend: &WindowsBackend, tables: &[Table], seen: &Seen| {
        format!(
            "{}\nthe simulator said:\n{}\nwindows:\n{}",
            state(backend, tables),
            seen.log.join("\n"),
            listing()
        )
    };
    // Whatever tracking found so far (nothing should have moved).
    eprintln!("after tracking: {:?}", backend.poll_events());
    eprintln!("step ok: three tables tracked, overlays shown");

    // 0. Each overlay directly above its own table as soon as it shows.
    //    Windows shows a window that does not activate where its own rules
    //    say (CI: under the runner's terminal, far below the table, #255),
    //    so the overlay thread puts it there itself; its restacks say
    //    whether it had to.
    let lag = until_stacked(&backend, &tables, Duration::from_secs(1), || {
        context(&backend, &tables, &seen)
    });
    eprintln!(
        "step ok: every overlay directly above its table once shown ({lag:?}); restacks:\n{}",
        restacks(&backend, &tables)
    );

    // 1. A scripted SetWindowPos sequence on table A: its overlay follows
    //    each move at once, as a move (no repaint); B and C stay put.
    let a = &tables[0];
    let others: Vec<(WindowId, Option<Rect>)> = tables[1..]
        .iter()
        .map(|t| (t.overlay, probe::window_rect(t.overlay)))
        .collect();
    let before = backend.overlay_info(a.window.id).expect("info");
    let origin = probe::window_rect(a.window.id).expect("A's frame");
    let mut lags = Vec::new();
    for i in 0..40_i32 {
        let (x, y) = moved(origin, (i % 8) * 19 - 60, (i / 8) * 13 - 20);
        drive::move_window(a.window.id, x, y).expect("SetWindowPos");
        let target = probe::client_area(a.window.id).expect("A's client area");
        let lag = until_covers(a.overlay, target, Duration::from_secs(2))
            .unwrap_or_else(|why| panic!("move {i}: {why}\n{}", context(&backend, &tables, &seen)));
        lags.push(lag);
        std::thread::sleep(Duration::from_millis(15));
    }
    let after = backend.overlay_info(a.window.id).expect("info");
    assert_eq!(after.renders, before.renders, "a move is not a repaint");
    assert!(
        after.moves >= before.moves + 40,
        "{} moves for 40",
        after.moves - before.moves
    );
    for (overlay, rect) in &others {
        assert_eq!(
            probe::window_rect(*overlay),
            *rect,
            "another table's overlay moved"
        );
    }
    let (p50, p95, max) = summary(&lags);
    let inside = backend.follow_times_us();
    eprintln!(
        "R3.5 follow (backend, 40 SetWindowPos): table moved -> overlay moved p50 {} us, p95 {} us, max {} us; \
         inside the overlay thread (hook callback -> overlay moved) last 40: {:?} us",
        us(p50),
        us(p95),
        us(max),
        &inside[inside.len().saturating_sub(40)..]
    );
    let events = backend.poll_events();
    let target = probe::client_area(a.window.id).expect("A's client area");
    assert_eq!(
        events,
        [TableEvent::Moved {
            id: a.window.id,
            client: target,
            scale_permille: a.window.scale_permille
        }],
        "forty moves are one Moved for the engine"
    );
    assert!(p50 < FRAME, "p50 {p50:?} is over one frame");
    assert!(p95 < 3 * FRAME, "p95 {p95:?} is over three frames");
    eprintln!("step ok: a scripted SetWindowPos sequence");

    // 2. The simulator's own move.
    let previous = probe::client_area(a.window.id).expect("A");
    sim.command(&format!(
        "move {} {} {}",
        a.number,
        origin.x + 31,
        origin.y + 17
    ));
    let lag = until(Duration::from_secs(5), || {
        let now = probe::client_area(a.window.id);
        now != Some(previous)
            && now.is_some()
            && probe::window_rect(a.overlay) == now
            && probe::visible(a.overlay)
    })
    .unwrap_or_else(|| panic!("the move command\n{}", context(&backend, &tables, &seen)));
    let now = probe::client_area(a.window.id);
    seen.until(
        &sim.events,
        Duration::from_secs(10),
        "the move's window event",
        |s| s.windows.get(&a.number).map(client_of) == now,
    );
    let reported = client_of(&seen.windows[&a.number]);
    assert_eq!(
        probe::window_rect(a.overlay),
        Some(reported),
        "as the simulator says"
    );
    eprintln!("step ok: the simulator's move (command -> overlay moved {lag:?})");

    // 3. Resized: painted once more, at the new size.
    let renders = backend.overlay_info(a.window.id).expect("info").renders;
    sim.command(&format!("resize {} 800 560", a.number));
    let lag = until(Duration::from_secs(5), || {
        backend
            .overlay_info(a.window.id)
            .is_some_and(|i| i.painted == (800, 560))
            && probe::client_area(a.window.id).is_some_and(|c| (c.width, c.height) == (800, 560))
            && probe::window_rect(a.overlay) == probe::client_area(a.window.id)
    })
    .unwrap_or_else(|| panic!("the resize\n{}", context(&backend, &tables, &seen)));
    let info = backend.overlay_info(a.window.id).expect("info");
    assert!(info.renders > renders, "{info:?}");
    eprintln!(
        "step ok: resized, repainted at 800 x 560 ({} paints, command -> painted {lag:?})",
        info.renders - renders
    );

    // 4. Minimised: hidden; restored: shown on the table again.
    let b = &tables[1];
    let _ = backend.poll_events();
    sim.command(&format!("minimize {}", b.number));
    let lag = until(Duration::from_secs(5), || !probe::visible(b.overlay)).unwrap_or_else(|| {
        panic!(
            "hidden while minimised\n{}",
            context(&backend, &tables, &seen)
        )
    });
    let (got, events) = poll_until(&mut backend, Duration::from_secs(3), |e| {
        *e == TableEvent::Minimized {
            id: b.window.id,
            minimized: true,
        }
    });
    assert!(got.is_some(), "no Minimized: {events:?}");
    sim.command(&format!("restore {}", b.number));
    let shown = until(Duration::from_secs(5), || {
        probe::visible(b.overlay)
            && probe::client_area(b.window.id).is_some_and(|c| c.width > 0)
            && probe::window_rect(b.overlay) == probe::client_area(b.window.id)
    })
    .unwrap_or_else(|| {
        panic!(
            "shown after the restore\n{}",
            context(&backend, &tables, &seen)
        )
    });
    let (got, events) = poll_until(&mut backend, Duration::from_secs(3), |e| {
        *e == TableEvent::Minimized {
            id: b.window.id,
            minimized: false,
        }
    });
    assert!(got.is_some(), "no Minimized false: {events:?}");
    eprintln!("step ok: minimised (hidden after {lag:?}), restored (shown after {shown:?})");

    // 5. Z-order: each overlay directly above its own table, after one is
    //    raised and another focused.
    //    Directly above: nothing that shows between the two. (Up to #255
    //    this only asked for "above", over 3 s, and still failed: the table
    //    never raised kept its overlay at the bottom of the z-order, where
    //    Windows had shown it, since the overlay thread only looked on its
    //    own table's foreground.)
    drive::raise(b.window.id).expect("raise");
    sim.command(&format!("focus {}", a.number));
    let lag = until_stacked(&backend, &tables, Duration::from_secs(2), || {
        context(&backend, &tables, &seen)
    });
    eprintln!(
        "step ok: z-order after a raise and a focus ({lag:?}); restacks:\n{}",
        restacks(&backend, &tables)
    );

    // 5b. Something slips in between an overlay and its table with no
    //     event about that table (B put directly under C's overlay: a
    //     z-order change only, which the hooks do not take): the overlay
    //     thread's 250 ms look puts C's overlay back directly above C.
    let c = &tables[2];
    let before = backend.overlay_info(c.window.id).expect("info").restacked;
    drive::place_below(b.window.id, c.overlay).expect("place B under C's overlay");
    let (slipped, _) = probe::stacking(c.overlay, c.window.id);
    let lag = until_stacked(&backend, &tables, Duration::from_secs(2), || {
        context(&backend, &tables, &seen)
    });
    let after = backend.overlay_info(c.window.id).expect("info").restacked;
    if slipped == Stacking::Directly {
        // Windows did not take the order (or the look ran in between).
        eprintln!("R3.5 restack look: B under C's overlay left C's overlay directly above C");
    } else {
        assert!(
            after > before,
            "C's overlay was {slipped} and is in place again, but not restacked by the HUD\n{}",
            restacks(&backend, &tables)
        );
        eprintln!(
            "R3.5 restack look: C's overlay {slipped} -> directly above C again in {lag:?} \
             (the look runs every 250 ms)"
        );
    }
    eprintln!(
        "step ok: a window slipped between an overlay and its table; restacks:\n{}",
        restacks(&backend, &tables)
    );

    // 6. A tournament-style table move: the title changes; the hooks say
    //    so with the new table's name as the room's matcher reads it.
    let c = &tables[2];
    let old_name = seen.tables[&c.number].1.clone();
    let _ = backend.poll_events();
    sim.command(&format!("tablemove {}", c.number));
    let (got, events) = poll_until(
        &mut backend,
        Duration::from_secs(5),
        |e| matches!(e, TableEvent::Retitled { id, .. } if *id == c.window.id),
    );
    let lag = got.unwrap_or_else(|| {
        panic!(
            "no Retitled: {events:?}\n{}",
            context(&backend, &tables, &seen)
        )
    });
    seen.until(&sim.events, Duration::from_secs(10), "the new table", |s| {
        s.tables[&c.number].1 != old_name
    });
    let new_name = seen.tables[&c.number].1.clone();
    let retitled = events
        .iter()
        .find_map(|e| match e {
            TableEvent::Retitled { id, table, .. } if *id == c.window.id => Some(table.clone()),
            _ => None,
        })
        .flatten();
    assert_eq!(
        retitled.as_deref(),
        Some(rail_hud::platform::table_key(&new_name).as_str()),
        "the hands' table name"
    );
    eprintln!(
        "step ok: table move {old_name:?} -> {new_name:?} seen after {lag:?} (the re-find would take up to 500 ms)"
    );

    // 7. Hidden by its client: the overlay goes at once and the engine
    //    hears Closed; shown again: Appeared, found and followed anew.
    drive::show_window(c.window.id, false);
    let gone = until(Duration::from_secs(3), || !probe::visible(c.overlay))
        .unwrap_or_else(|| panic!("hidden table\n{}", context(&backend, &tables, &seen)));
    let (got, events) = poll_until(&mut backend, Duration::from_secs(3), |e| {
        *e == TableEvent::Closed { id: c.window.id }
    });
    assert!(got.is_some(), "no Closed for the hidden table: {events:?}");
    backend.untrack(c.window.id);
    drive::show_window(c.window.id, true);
    let (got, events) = poll_until(&mut backend, Duration::from_secs(3), |e| {
        *e == TableEvent::Appeared
    });
    assert!(got.is_some(), "no Appeared for the shown table: {events:?}");
    let again = find_until(
        &mut backend,
        &room,
        &mut seen,
        &sim.events,
        "the shown table found again",
        |found, _| {
            if found.iter().any(|w| w.id == c.window.id) {
                Ok(())
            } else {
                Err("not found".to_owned())
            }
        },
    );
    let c_window = again
        .iter()
        .find(|w| w.id == c.window.id)
        .expect("C")
        .clone();
    backend.track(&c_window).expect("track");
    backend
        .overlay(c_window.id, &waiting(seen.tables[&c.number].2))
        .expect("overlay");
    let c_overlay = wait_for(Duration::from_secs(10), "C's new overlay", || match backend
        .overlay_info(c_window.id)
    {
        Some(info) if info.shown => Ok(info.window.expect("window")),
        other => Err(format!("{other:?}")),
    });
    assert_eq!(
        probe::window_rect(c_overlay),
        probe::client_area(c_window.id)
    );
    eprintln!("step ok: hidden (overlay gone after {gone:?}), shown, followed again");
    let tables = vec![
        Table {
            window: a.window.clone(),
            number: a.number,
            overlay: a.overlay,
        },
        Table {
            window: b.window.clone(),
            number: b.number,
            overlay: b.overlay,
        },
        Table {
            window: c_window,
            number: c.number,
            overlay: c_overlay,
        },
    ];
    let a = &tables[0];

    // 8. A storm: a hundred moves in one second.
    let _ = backend.poll_events();
    let thread = backend.overlay_thread_id().expect("the overlay thread");
    let cpu_before = probe::thread_cpu_time(thread).expect("thread CPU");
    let renders = backend.overlay_info(a.window.id).expect("info").renders;
    let origin = probe::window_rect(a.window.id).expect("A's frame");
    let started = Instant::now();
    let mut lags = Vec::new();
    for (i, (dx, dy)) in storm_offsets().into_iter().enumerate() {
        let slot = started + Duration::from_millis(10) * u32::try_from(i).expect("i");
        if let Some(wait) = slot.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        let (x, y) = moved(origin, dx, dy);
        drive::move_window(a.window.id, x, y).expect("SetWindowPos");
        let target = probe::client_area(a.window.id).expect("A");
        lags.push(
            until_covers(a.overlay, target, Duration::from_secs(2)).unwrap_or_else(|why| {
                panic!(
                    "storm move {i}: {why}\n{}",
                    context(&backend, &tables, &seen)
                )
            }),
        );
    }
    let wall = started.elapsed();
    let cpu = probe::thread_cpu_time(thread)
        .expect("thread CPU")
        .saturating_sub(cpu_before);
    let info = backend.overlay_info(a.window.id).expect("info");
    assert_eq!(info.renders, renders, "the storm repainted");
    let events = backend.poll_events();
    assert_eq!(events.len(), 1, "one Moved for a hundred moves: {events:?}");
    let (p50, p95, max) = summary(&lags);
    eprintln!(
        "R3.5 storm (backend): 100 moves in {} ms; table moved -> overlay moved p50 {} us, p95 {} us, \
         max {} us; overlay thread CPU {} ms over the storm; engine events: {}",
        wall.as_millis(),
        us(p50),
        us(p95),
        us(max),
        cpu.as_millis(),
        events.len()
    );
    assert!(p50 < FRAME, "storm p50 {p50:?}");
    assert!(p95 < 3 * FRAME, "storm p95 {p95:?}");
    assert!(
        cpu < Duration::from_millis(500),
        "the overlay thread used {cpu:?} for a hundred moves"
    );
    eprintln!("step ok: a hundred moves in a second");

    // 9. Closed by the simulator: Closed, the overlay destroyed.
    let b = &tables[1];
    sim.command(&format!("close {}", b.number));
    let (got, events) = poll_until(&mut backend, Duration::from_secs(5), |e| {
        *e == TableEvent::Closed { id: b.window.id }
    });
    assert!(
        got.is_some(),
        "no Closed: {events:?}\n{}",
        context(&backend, &tables, &seen)
    );
    let destroyed = until(Duration::from_secs(3), || !probe::exists(b.overlay));
    assert!(destroyed.is_some(), "B's overlay still exists");
    backend.untrack(b.window.id);
    eprintln!("step ok: closed (Closed after {got:?})");

    // 10. The process exits: every overlay of it gone, Closed for each,
    //     and the process unhooked once nothing of it is left.
    let _ = sim.child.kill();
    let _ = sim.child.wait();
    let mut closed = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while closed.len() < 2 && Instant::now() < deadline {
        for event in backend.poll_events() {
            if let TableEvent::Closed { id } = event {
                closed.push(id);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    closed.sort_unstable();
    let mut expected = vec![tables[0].window.id, tables[2].window.id];
    expected.sort_unstable();
    assert_eq!(
        closed,
        expected,
        "Closed for the process's tables\n{}",
        state(&backend, &tables)
    );
    for t in [&tables[0], &tables[2]] {
        assert!(
            until(Duration::from_secs(3), || !probe::exists(t.overlay)).is_some(),
            "table {}'s overlay outlived its process",
            t.number
        );
        backend.untrack(t.window.id);
    }
    let _ = backend.find_tables(std::slice::from_ref(&room));
    assert!(
        backend.hooked_processes().is_empty(),
        "still hooked: {:?}",
        backend.hooked_processes()
    );
    eprintln!("step ok: the process exited; overlays gone, unhooked");
    drop(sim);
}

/// The HUD's overlay owned by `table`, if any.
fn hud_overlay(hud_pid: u32, table: WindowId) -> Option<WindowId> {
    probe::windows_of(hud_pid)
        .into_iter()
        .find(|(id, class)| class == OVERLAY_CLASS && probe::owner(*id) == Some(table))
        .map(|(id, _)| id)
}

/// The simulator's window titled `title`.
fn sim_window(pid: u32, title: &str) -> Option<WindowId> {
    enumerate()
        .ok()?
        .into_iter()
        .find(|w| w.pid == pid && w.title == title)
        .map(|w| w.id)
}

fn client_of(event: &Value) -> Rect {
    let int = |key: &str| event[key].as_i64().unwrap_or(0);
    Rect {
        x: i32::try_from(int("clientX")).unwrap_or(0),
        y: i32::try_from(int("clientY")).unwrap_or(0),
        width: u32::try_from(int("width")).unwrap_or(0),
        height: u32::try_from(int("height")).unwrap_or(0),
    }
}

/// A failed step of the script: everything said, then panic.
fn fail(what: &str, log: &[String], hud: &mut Hud) -> ! {
    hud.until("never printed", 1, Duration::from_millis(300));
    panic!(
        "{what}\nthe simulator said:\n{}\nrail-hud said:\n{}\nwindows:\n{}",
        log.join("\n"),
        hud.log(),
        listing()
    )
}

/// The tracking script (R3.1's `tracking.txt`, extended here) with the HUD
/// process: what each step's `window` / `table` / `closed` event says is
/// where the HUD's overlay is.
#[test]
fn the_hud_follows_the_tracking_script() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../rail-hud-sim/scripts/tracking.txt");
    // The HUD first, so it is attached before the script's first step.
    let mut hud = Hud::start(&[
        "--standalone",
        "--sim-site",
        "pokerstars",
        "--sim-title",
        &regex,
    ]);
    let script_arg = script.to_string_lossy().into_owned();
    let mut sim = Sim::start(
        &sim_path,
        "tracking-script",
        &[
            "--tables",
            "3",
            "--sizes",
            "6",
            "--speed",
            "6",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--seed",
            "22",
            "--script",
            &script_arg,
        ],
    );
    let pid = sim.child.id();
    let hud_pid = hud.child.id();
    let mut windows: std::collections::BTreeMap<u64, WindowId> = Default::default();
    let mut log: Vec<String> = Vec::new();
    let mut steps = 0;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        assert!(Instant::now() < deadline, "the script did not finish");
        let Ok(event) = sim.events.recv_timeout(Duration::from_millis(500)) else {
            if matches!(sim.child.try_wait(), Ok(Some(_))) {
                break;
            }
            continue;
        };
        if event["event"] != "hand" {
            log.push(event.to_string());
        }
        let number = event["table"].as_u64();
        match (event["event"].as_str(), number) {
            (Some("window"), Some(n)) => {
                let title = event["title"].as_str().unwrap_or_default();
                let Some(table) = windows.get(&n).copied().or_else(|| sim_window(pid, title))
                else {
                    fail(
                        &format!("table {n}: no window titled {title:?}"),
                        &log,
                        &mut hud,
                    );
                };
                windows.insert(n, table);
                if event["minimized"].as_bool() == Some(true) {
                    let hidden = until(Duration::from_secs(3), || {
                        hud_overlay(hud_pid, table).is_none_or(|o| !probe::visible(o))
                    });
                    if hidden.is_none() {
                        fail(
                            &format!("table {n} minimised, its overlay shows"),
                            &log,
                            &mut hud,
                        );
                    }
                } else {
                    let client = client_of(&event);
                    let covered = until(Duration::from_secs(3), || {
                        hud_overlay(hud_pid, table).is_some_and(|o| {
                            probe::visible(o) && probe::window_rect(o) == Some(client)
                        })
                    });
                    if covered.is_none() {
                        fail(
                            &format!(
                                "table {n} at {client:?}: overlay {:?} at {:?}",
                                hud_overlay(hud_pid, table),
                                hud_overlay(hud_pid, table).and_then(probe::window_rect)
                            ),
                            &log,
                            &mut hud,
                        );
                    }
                    if !hud_overlay(hud_pid, table).is_some_and(|o| probe::is_above(o, table)) {
                        fail(
                            &format!("table {n}'s overlay is not above it"),
                            &log,
                            &mut hud,
                        );
                    }
                }
                steps += 1;
                eprintln!("step ok: window event {steps} (table {n}) - the overlay agrees");
            }
            (Some("table"), Some(n)) if event["moved"].as_bool() == Some(true) => {
                let Some(table) = windows.get(&n).copied() else {
                    continue;
                };
                let marker = format!("window {} moved to table", table.0);
                if !hud.until(&marker, 1, Duration::from_secs(2)) {
                    fail(
                        &format!("table {n}: the HUD did not see the move"),
                        &log,
                        &mut hud,
                    );
                }
                eprintln!("step ok: table {n} moved, the HUD saw it");
            }
            (Some("closed"), Some(n)) => {
                if let Some(table) = windows.remove(&n) {
                    let gone = until(Duration::from_secs(2), || {
                        hud_overlay(hud_pid, table).is_none()
                    });
                    if gone.is_none() {
                        fail(
                            &format!("table {n} closed, its overlay is still there"),
                            &log,
                            &mut hud,
                        );
                    }
                }
                eprintln!("step ok: table {n} closed, no overlay left");
            }
            (Some("done"), _) => break,
            _ => {}
        }
        if event["event"] == "status" {
            // The script's last status: what is left must be covered.
            eprintln!("status: {event}");
        }
    }
    assert!(steps >= 10, "only {steps} window events checked");
    hud.until("never printed", 1, Duration::from_millis(500));
    eprintln!("rail-hud:\n{}", hud.log());
    drop(sim);
}

/// The HUD process during a drag: lag per move, its CPU, no fight with the
/// periodic re-find; a hidden and shown table; the simulator killed.
#[test]
fn the_hud_follows_a_drag() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let mut sim = Sim::start(
        &sim_path,
        "tracking-hud",
        &[
            "--tables",
            "3",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "0.5",
            "--seed",
            "23",
        ],
    );
    let mut seen = Seen::default();
    seen.until(
        &sim.events,
        Duration::from_secs(90),
        "3 shown windows",
        |s| s.tables.len() == 3 && s.windows.len() == 3,
    );
    let pid = sim.child.id();
    let mut hud = Hud::start(&[
        "--standalone",
        "--sim-site",
        "pokerstars",
        "--sim-title",
        &regex,
    ]);
    assert!(
        hud.until("attached to window", 3, Duration::from_secs(30)),
        "{}",
        hud.log()
    );
    let hud_pid = hud.child.id();
    let tables: Vec<WindowId> = seen
        .tables
        .values()
        .filter_map(|(title, _, _)| sim_window(pid, title))
        .collect();
    assert_eq!(tables.len(), 3, "{tables:?}\n{}", listing());
    let overlays: Vec<WindowId> = tables
        .iter()
        .map(|t| {
            wait_for(Duration::from_secs(15), "the HUD's overlay", || {
                hud_overlay(hud_pid, *t)
                    .filter(|o| probe::visible(*o))
                    .ok_or_else(|| format!("{:?}\n{}", probe::windows_of(hud_pid), hud.log()))
            })
        })
        .collect();
    let (table, overlay) = (tables[0], overlays[0]);

    // A hundred moves in a second, each followed; positions only ever
    // forward (the re-find, which runs twice meanwhile, never puts the
    // overlay back), never hidden.
    let origin = probe::window_rect(table).expect("frame");
    let cpu_before = probe::cpu_time(hud_pid).expect("CPU");
    let started = Instant::now();
    let mut targets: Vec<Rect> = Vec::new();
    let mut lags = Vec::new();
    let mut backwards = Vec::new();
    let mut hidden = 0;
    for (i, (dx, dy)) in storm_offsets().into_iter().enumerate() {
        let slot = started + Duration::from_millis(10) * u32::try_from(i).expect("i");
        if let Some(wait) = slot.checked_duration_since(Instant::now()) {
            // Watch the overlay while waiting for the slot.
            let until_slot = Instant::now() + wait;
            while Instant::now() < until_slot {
                let at = probe::window_rect(overlay);
                if !probe::visible(overlay) {
                    hidden += 1;
                }
                if let Some(at) = at
                    && let Some(index) = targets.iter().position(|t| *t == at)
                    && index + 1 < targets.len()
                {
                    backwards.push((i, index));
                }
                std::thread::sleep(Duration::from_micros(500));
            }
        }
        let (x, y) = moved(origin, dx, dy);
        drive::move_window(table, x, y).expect("SetWindowPos");
        let target = probe::client_area(table).expect("client");
        targets.push(target);
        lags.push(
            until_covers(overlay, target, Duration::from_secs(2))
                .unwrap_or_else(|why| panic!("HUD storm move {i}: {why}\n{}", hud.log())),
        );
    }
    let wall = started.elapsed();
    let cpu = probe::cpu_time(hud_pid)
        .expect("CPU")
        .saturating_sub(cpu_before);
    // Half a second more: the re-find runs again and must leave it be.
    let last = *targets.last().expect("a target");
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(
        probe::window_rect(overlay),
        Some(last),
        "moved after the drag"
    );
    let (p50, p95, max) = summary(&lags);
    eprintln!(
        "R3.5 storm (rail-hud process): 100 moves in {} ms; table moved -> overlay moved p50 {} us, \
         p95 {} us, max {} us; rail-hud CPU {} ms over the storm; back to an older position {} times, \
         hidden in {} samples",
        wall.as_millis(),
        us(p50),
        us(p95),
        us(max),
        cpu.as_millis(),
        backwards.len(),
        hidden
    );
    assert!(backwards.is_empty(), "the overlay went back: {backwards:?}");
    assert_eq!(hidden, 0, "the overlay hid during the drag");
    assert!(p50 < FRAME, "HUD p50 {p50:?}");
    assert!(p95 < 3 * FRAME, "HUD p95 {p95:?}");
    assert!(
        cpu < Duration::from_millis(500),
        "rail-hud used {cpu:?} for a hundred moves"
    );
    eprintln!("step ok: the HUD followed a hundred moves");

    // Hidden by the client: the overlay goes at once; shown: the HUD finds
    // it again at once (Appeared), not at the next periodic find.
    let (table, overlay) = (tables[1], overlays[1]);
    drive::show_window(table, false);
    let gone = until(Duration::from_secs(2), || {
        !probe::exists(overlay) || !probe::visible(overlay)
    })
    .unwrap_or_else(|| panic!("hidden table\n{}", hud.log()));
    std::thread::sleep(Duration::from_millis(300));
    drive::show_window(table, true);
    let back = until(Duration::from_secs(3), || {
        hud_overlay(hud_pid, table).is_some_and(|o| {
            probe::visible(o) && probe::window_rect(o) == probe::client_area(table)
        })
    })
    .unwrap_or_else(|| panic!("shown table\n{}\n{}", hud.log(), listing()));
    eprintln!(
        "R3.5 hide/show (rail-hud process): overlay gone {} us after the hide, back {} ms after the show",
        us(gone),
        back.as_millis()
    );
    eprintln!("step ok: hidden and shown");

    // The simulator killed: every overlay goes with its table.
    let _ = sim.child.kill();
    let _ = sim.child.wait();
    let cleared = until(Duration::from_secs(5), || {
        !probe::windows_of(hud_pid)
            .iter()
            .any(|(_, class)| class == OVERLAY_CLASS)
    });
    assert!(
        cleared.is_some(),
        "overlays outlived the tables: {:?}\n{}",
        probe::windows_of(hud_pid),
        hud.log()
    );
    eprintln!(
        "step ok: the simulator exited, every overlay gone after {:?}",
        cleared.unwrap_or_default()
    );
    eprintln!("rail-hud:\n{}", hud.log());
    drop(sim);
}
