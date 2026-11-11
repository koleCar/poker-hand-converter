//! (T1, docs/research/TABLE-TILING.md §4.2) Table tiling's platform calls
//! on macOS with real windows: the monitors, and the simulator's tables
//! moved and resized through `Platform::place`. Its own `main`: AppKit runs
//! on the test's main thread (`with_appkit`), so the monitors' work areas
//! come from `NSScreen` through the AppKit thread, as in the HUD process;
//! the checks run on the engine's thread. Elsewhere it says it skipped.
//!
//! - **Always** (no permission): the monitors - the main display first and
//!   the only primary, one per display the window server lists, bounds in
//!   pixels at each display's scale, the work area inside them and, on the
//!   main display, without the menu bar (`NSScreen.visibleFrame`) -; a
//!   backend without the AppKit thread reports the same displays, whole.
//! - **With Accessibility**: a table's client area placed inside the main
//!   display's work area, at another size, read back exactly; the
//!   simulator reports the same client area (its own `window` event) and
//!   the find agrees; a minimised table brought back and placed; a window
//!   that does not exist refused (`Gone`).
//! - **Without it**: `place` refuses (`PermissionNeeded`) and the test says
//!   what it skipped. It never asks for the permission.
//!
//! A full-screen table (refused, `FullScreen`) is not driven here: entering
//! full screen moves the window to a Space of its own with an animation the
//! CI runner's window server does not finish reliably; the refusal is one
//! check of `AXFullScreen` before anything is set.

mod support;

fn main() {
    #[cfg(target_os = "macos")]
    macos::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("macos_place: macOS only; nothing to run here");
}

#[cfg(target_os = "macos")]
mod macos {
    use std::time::Duration;

    use rail_hud::platform::macos::{self, MacosBackend};
    use rail_hud::platform::{
        Monitor, Permission, Platform, PlatformError, Rect, TableWindow, WindowId,
    };

    use super::support::{
        Seen, Sim, check_monitors, event_client, find_until, matcher, simulator, title_regex,
        wait_for,
    };

    /// The simulator's client size, points.
    const WIDTH: u32 = 640;
    const HEIGHT: u32 = 480;

    pub fn main() {
        let code = macos::with_appkit(|link| {
            let link = link.expect("AppKit runs on this test's main thread");
            let granted = macos::accessibility_granted();
            eprintln!(
                "T1: this process {} the Accessibility permission",
                if granted { "HAS" } else { "does NOT have" }
            );
            let mut backend = MacosBackend::with_overlays(Some(link));
            let monitors = the_monitors(&mut backend);
            let sim_path = simulator();
            let regex = title_regex(&sim_path);
            let mut sim = Sim::start(
                &sim_path,
                "macos-place",
                &[
                    "--tables",
                    "2",
                    "--window",
                    &format!("{WIDTH}x{HEIGHT}"),
                    "--speed",
                    "0.5",
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
            if granted {
                placements(&mut backend, &mut sim, &mut seen, &regex, &monitors);
            } else {
                without_permission(&mut backend, &sim);
                eprintln!(
                    "T1: SKIPPED (no Accessibility, which moving another process's window \
                     needs): a table placed and read back, the simulator agreeing, a \
                     minimised table brought back and placed. To run them, grant the terminal \
                     Accessibility and run: cargo test -p rail-hud --test macos_place -- \
                     --nocapture"
                );
            }
            0
        });
        // 101: a step panicked on the engine's thread (its message above).
        assert_eq!(code, 0, "a step failed (see the panic above)");
        eprintln!("macos_place: ok");
    }

    /// The monitors, through the AppKit thread and without it.
    fn the_monitors(backend: &mut MacosBackend) -> Vec<Monitor> {
        let monitors = backend.monitors();
        if let Err(why) = check_monitors(&monitors) {
            panic!("the monitors: {why}");
        }
        let displays = macos::displays();
        assert_eq!(monitors.len(), displays.len(), "one per display");
        for (monitor, display) in monitors.iter().zip(&displays) {
            assert_eq!(monitor.id.0, u64::from(display.id));
            assert_eq!(
                monitor.bounds,
                macos::to_pixels(&display.bounds, display.scale_permille)
            );
            assert_eq!(monitor.scale_permille, display.scale_permille);
        }
        // The main display has a menu bar: AppKit's visible frame leaves it
        // out (it is shown on every display with "Displays have separate
        // Spaces", always on the main one).
        let main = &monitors[0];
        assert!(
            main.work_area.y > main.bounds.y,
            "the main display's work area {:?} starts at its top {:?}: no menu bar",
            main.work_area,
            main.bounds
        );
        // Off the main thread and without the AppKit thread: the displays,
        // whole.
        let bare = MacosBackend::default().monitors();
        assert_eq!(bare.len(), monitors.len());
        for (b, m) in bare.iter().zip(&monitors) {
            assert_eq!((b.id, b.bounds, b.work_area), (m.id, m.bounds, m.bounds));
        }
        eprintln!("step ok: the monitors, work areas from NSScreen through the AppKit thread");
        monitors
    }

    /// Without Accessibility: refused, nothing moved.
    fn without_permission(backend: &mut MacosBackend, sim: &Sim) {
        let pid = sim.child.id();
        // The simulator's `window` event can come before the window server
        // lists the window on screen.
        let window = wait_for(
            Duration::from_secs(20),
            "a simulator window in the window list",
            || {
                macos::cg_windows()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|w| w.pid == pid && w.layer == 0 && w.onscreen)
                    .ok_or_else(|| "none yet".to_owned())
            },
        );
        let want = Rect {
            x: 0,
            y: 100,
            width: 800,
            height: 600,
        };
        assert_eq!(
            backend.place(WindowId(u64::from(window.id)), want),
            Err(PlatformError::PermissionNeeded(Permission::Accessibility))
        );
        eprintln!("step ok: without Accessibility `place` says the permission is needed");
    }

    /// Wait for the simulator's own report of table `number`'s client area
    /// to be `want` (its title bar within a point, as the find measures it)
    /// and not minimised.
    fn the_simulator_agrees(sim: &mut Sim, seen: &mut Seen, number: u64, want: Rect, scale: u32) {
        let slack = i64::from(scale / 1000).max(1);
        sim.until(
            seen,
            Duration::from_secs(20),
            &format!("the simulator reports table {number} at {want:?}"),
            |s| {
                s.windows.get(&number).is_some_and(|e| {
                    let c = event_client(e);
                    c.x == want.x
                        && (i64::from(c.y) - i64::from(want.y)).abs() <= slack
                        && c.width == want.width
                        && c.bottom() == want.bottom()
                        && e["minimized"].as_bool() == Some(false)
                })
            },
        );
    }

    fn placements(
        backend: &mut MacosBackend,
        sim: &mut Sim,
        seen: &mut Seen,
        regex: &str,
        monitors: &[Monitor],
    ) {
        let matcher = matcher("pokerstars", regex);
        let found = find_until(
            backend,
            &matcher,
            seen,
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
        let number_of = |seen: &Seen, w: &TableWindow| {
            seen.table_titled(&w.title)
                .unwrap_or_else(|| panic!("no simulator table titled {:?}", w.title))
        };
        let (first, second) = (&found[0], &found[1]);
        let (n1, n2) = (number_of(seen, first), number_of(seen, second));

        // Inside the main display's work area, in its pixels: one table at
        // the left, the other at the right, both at sizes of their own.
        let main = &monitors[0];
        let scale = main.scale_permille;
        let px = |points: u32| points * scale / 1000;
        let work = main.work_area;
        let pt = |pixels: u32| i32::try_from(px(pixels)).expect("small");
        let want1 = Rect {
            x: work.x + pt(20),
            y: work.y + pt(60),
            width: px(720),
            height: px(540),
        };
        let want2 = Rect {
            x: work.x + i32::try_from(work.width).expect("small") - pt(620),
            y: work.y + pt(80),
            width: px(600),
            height: px(450),
        };
        assert!(work.contains(&want1) && work.contains(&want2), "{work:?}");

        let placed = backend.place(first.id, want1).expect("table 1 placed");
        assert_eq!(placed, want1, "table 1's client area read back");
        the_simulator_agrees(sim, seen, n1, want1, scale);
        find_until(
            backend,
            &matcher,
            seen,
            &sim.events,
            "the find agrees with the placement",
            |found, _| match found.iter().find(|w| w.id == first.id) {
                Some(w) if w.client == want1 => Ok(()),
                other => Err(format!("table 1: {other:?}")),
            },
        );
        eprintln!("step ok: a table placed at {want1:?}, read back, reported and found there");

        // A minimised table is brought back from the Dock, then placed.
        sim.command(&format!("minimize {n2}"));
        sim.until(seen, Duration::from_secs(20), "the minimise", |s| {
            s.windows
                .get(&n2)
                .is_some_and(|e| e["minimized"].as_bool() == Some(true))
        });
        let placed = backend.place(second.id, want2).expect("table 2 placed");
        assert_eq!(placed, want2, "the minimised table's client area read back");
        the_simulator_agrees(sim, seen, n2, want2, scale);
        eprintln!("step ok: a minimised table brought back and placed at {want2:?}");

        // Table 1 again, somewhere else: placing twice is not sticky.
        let again = Rect {
            y: want1.y + pt(30),
            width: px(680),
            ..want1
        };
        assert_eq!(backend.place(first.id, again), Ok(again));
        the_simulator_agrees(sim, seen, n1, again, scale);

        // A window that does not exist.
        let nowhere = WindowId(u64::from(u32::MAX - 7));
        assert_eq!(
            backend.place(nowhere, want1),
            Err(PlatformError::Gone(nowhere))
        );
        eprintln!("step ok: placing again moves it again; a window that does not exist is gone");
    }
}
