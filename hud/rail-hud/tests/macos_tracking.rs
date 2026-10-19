//! Following tables on macOS with real windows (docs/RAIL-PLAN.md R3.13),
//! in CI on the macOS runner and on a developer's Mac; elsewhere it says it
//! skipped. Its own `main`, as `macos_overlay.rs`: AppKit runs on the
//! test's main thread (`with_appkit`), the checks on the engine's thread.
//!
//! - **Always** (no permission: the simulator's tables made from the window
//!   server's list and its own events): the backend's overlays and its
//!   observers' thread over two tables. A description that is not where
//!   the table is never places the overlay - the thread reads the table and
//!   puts it where it is, and the engine is told so; a table moved by the
//!   simulator, then described, is followed; a Space change (the
//!   notification posted in this process: a real one cannot be made on a
//!   runner) makes the thread read every table again; the simulator killed,
//!   its overlays go at once (`kqueue`) and the engine hears `Closed`.
//! - **With the Accessibility permission** (CI's runner has it): the
//!   observers. The backend's own find; one observer for the simulator's
//!   process, the window notifications on each table; a move this process
//!   makes through `AXPosition` (recorded); a drag of 40 moves the
//!   simulator makes itself (its window moved by its own process, as a
//!   client's is under a user's drag), each followed without the engine -
//!   lag p50 / p95, no repaint, one `Moved`; a resize repainted at
//!   the new size; minimise and restore; focus and activation restacking
//!   at once; a real click on the focused table (does it raise the table
//!   over its overlay? measured and printed); a tournament table move
//!   (`Retitled`); the application hidden and shown; **100 moves in 1 s**
//!   (lag, the observers' and AppKit's CPU, the overlay never back at an
//!   older place and never hidden, one `Moved`); a closed table. Then the
//!   HUD process with the simulator's `scripts/tracking.txt`: after each
//!   `window` event the HUD's overlay is over that table's client area,
//!   directly above it (gone while minimised and once closed), a table move
//!   is logged as one.
//!
//! Every step prints `step ok: ...`, measurements `R3.13 ...` lines, and
//! what was skipped for lack of permission. It never prompts and never
//! changes a setting.

mod support;

fn main() {
    #[cfg(target_os = "macos")]
    macos::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("macos_tracking: macOS only; nothing to run here");
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::process::Command;
    use std::time::{Duration, Instant};

    use rail_hud::compliance::Compliance;
    use rail_hud::platform::macos::{
        self, CgWindow, Frame, MacosBackend, OverlayInfo, Stacking, TrackerInfo, drive,
    };
    use rail_hud::platform::{
        OverlayFrame, Platform, ProcessInfo, Rect, TableEvent, TableWindow, WindowId,
    };
    use serde_json::Value;

    use super::support::{Hud, Seen, Sim, matcher, simulator, title_regex, wait_for};

    /// The simulator's client size, points.
    const WIDTH: u32 = 640;
    const HEIGHT: u32 = 480;

    /// One frame at 60 Hz.
    const FRAME: Duration = Duration::from_micros(16_667);

    /// How often the test asks the window server while it waits.
    const POLL: Duration = Duration::from_millis(2);

    /// (R3.14) A real Mac, not a CI runner's virtual display: latency tails
    /// are gated only then (`RAIL_HUD_REAL_HW=1`).
    fn real_hardware() -> bool {
        std::env::var("RAIL_HUD_REAL_HW").is_ok_and(|v| v == "1")
    }

    pub fn main() {
        let code = macos::with_appkit(|link| {
            let link = link.expect("AppKit runs on this test's main thread");
            let granted = macos::accessibility_granted();
            eprintln!(
                "R3.13: this process {} the Accessibility permission",
                if granted { "HAS" } else { "does NOT have" }
            );
            without_observers(link.clone());
            if granted {
                with_observers(link);
                the_hud_follows_the_tracking_script();
            } else {
                eprintln!(
                    "R3.13: SKIPPED (no Accessibility, so no observer can be made): the \
                     observers' notifications - a scripted drag and its lag, the simulator's \
                     move, resize, minimise and restore, focus and activation restacking, a \
                     real click, a table move, the application hidden and shown, 100 moves in \
                     1 s, a closed table - and the HUD process with the tracking script. To \
                     run them, grant the terminal Accessibility and run: cargo test -p rail-hud \
                     --test macos_tracking -- --nocapture"
                );
            }
            0
        });
        // 101: a step panicked on the engine's thread (its message above);
        // `with_appkit` returns the thread's exit, so this only repeats it.
        assert_eq!(code, 0, "a step failed (see the panic above)");
        eprintln!("macos_tracking: ok");
    }

    fn int(event: &Value, key: &str) -> i64 {
        event[key].as_i64().unwrap_or(i64::MIN)
    }

    /// A status frame for an allowed room (a pill: cheap to paint).
    fn frame(seats: u32) -> OverlayFrame {
        let permit = Compliance::shipped()
            .expect("shipped")
            .permit("pokerstars")
            .expect("permitted");
        OverlayFrame::status(permit, Some(seats), "R3.13 tracking")
    }

    fn number(id: WindowId) -> u32 {
        u32::try_from(id.0).unwrap_or(0)
    }

    /// The simulator's window whose frame is its `window` event: its number
    /// and its screen's scale (the window server's list, no permission).
    fn window_of_event(pid: u32, event: &Value) -> Option<(u32, u32)> {
        let displays = macos::displays();
        macos::cg_windows()
            .ok()?
            .into_iter()
            .filter(|w| w.pid == pid && w.layer == 0)
            .find_map(|w| {
                let scale = macos::display_scale(&w.bounds, &displays);
                let px = macos::to_pixels(&w.bounds, scale);
                let bottom = i64::from(px.y) + i64::from(px.height);
                (i64::from(px.x) == int(event, "x")
                    && i64::from(px.y) == int(event, "y")
                    && i64::from(px.width) == int(event, "width")
                    && (bottom - (int(event, "clientY") + int(event, "height"))).abs() <= 1)
                    .then_some((w.id, scale))
            })
    }

    fn client_of(event: &Value) -> Rect {
        Rect {
            x: i32::try_from(int(event, "clientX")).unwrap_or(0),
            y: i32::try_from(int(event, "clientY")).unwrap_or(0),
            width: u32::try_from(int(event, "width")).unwrap_or(0),
            height: u32::try_from(int(event, "height")).unwrap_or(0),
        }
    }

    /// The simulator's tables as the engine would describe them, made
    /// without any permission (as `macos_overlay.rs` does).
    fn tables(seen: &Seen, pid: u32) -> Result<Vec<(u64, TableWindow)>, String> {
        let mut out = Vec::new();
        for (n, event) in &seen.windows {
            let (id, scale) = window_of_event(pid, event)
                .ok_or_else(|| format!("table {n}: no window with the frame {event}"))?;
            let (title, _, seats) = seen
                .tables
                .get(n)
                .cloned()
                .ok_or_else(|| format!("table {n}: no table event"))?;
            out.push((
                *n,
                TableWindow {
                    id: WindowId(u64::from(id)),
                    site: "pokerstars".into(),
                    process: ProcessInfo {
                        pid: Some(pid),
                        name: "rail-hud-sim".into(),
                    },
                    title,
                    table: None,
                    size: Some(seats),
                    client: client_of(event),
                    scale_permille: scale,
                    minimized: event["minimized"].as_bool() == Some(true),
                },
            ));
        }
        Ok(out)
    }

    fn start_sim(name: &str, count: usize, sizes: &str, seed: &str) -> (Sim, Seen) {
        let mut sim = Sim::start(
            &simulator(),
            name,
            &[
                "--tables",
                &count.to_string(),
                "--sizes",
                sizes,
                "--window",
                &format!("{WIDTH}x{HEIGHT}"),
                "--speed",
                "0.5",
                "--seed",
                seed,
            ],
        );
        let mut seen = Seen::default();
        sim.until(
            &mut seen,
            Duration::from_secs(120),
            &format!("{count} shown windows"),
            |s| s.tables.len() == count && s.windows.len() == count,
        );
        std::thread::sleep(Duration::from_millis(500));
        seen.drain(&sim.events);
        (sim, seen)
    }

    /// Where the overlay window of `id` is on screen (the window server's
    /// bounds, points), `None` while it is not shown.
    fn overlay_bounds(backend: &MacosBackend, id: WindowId) -> Option<Frame> {
        let info = backend.overlay_info(id)?;
        macos::window_now(info.window?)
            .filter(|w| w.onscreen)
            .map(|w| w.bounds)
    }

    /// The overlay's window number, kept to watch it without asking the
    /// AppKit thread.
    fn overlay_number(backend: &MacosBackend, id: WindowId) -> u32 {
        backend
            .overlay_info(id)
            .and_then(|i| i.window)
            .unwrap_or_else(|| panic!("no overlay for window {}", id.0))
    }

    /// The table's client area now, points: the window server's bounds
    /// less the title bar.
    fn client_now(table: u32, bar: i64) -> Option<Frame> {
        let window = macos::window_now(table)?;
        Some(macos::client_frame(&window.bounds, bar))
    }

    /// The title bar of a table as the engine described it.
    fn bar_of(window: &TableWindow) -> i64 {
        let bounds = macos::window_now(number(window.id))
            .expect("the table in the window list")
            .bounds;
        macos::title_bar_between(&bounds, &window.client, window.scale_permille)
    }

    fn info_of(backend: &MacosBackend, id: WindowId) -> OverlayInfo {
        backend
            .overlay_info(id)
            .unwrap_or_else(|| panic!("no overlay for window {}", id.0))
    }

    fn tracker(backend: &MacosBackend) -> TrackerInfo {
        backend.tracker_info().expect("the observers' thread")
    }

    /// The overlay of `table` directly above it in the window server's
    /// order, its click windows directly above it.
    fn stacked(backend: &MacosBackend, table: WindowId) -> Stacking {
        let Some(info) = backend.overlay_info(table) else {
            return Stacking::Restack;
        };
        let hits: Vec<i64> = info
            .hits
            .iter()
            .filter(|h| h.shown)
            .map(|h| i64::from(h.window))
            .collect();
        let order: Vec<i64> = macos::onscreen_order()
            .unwrap_or_default()
            .into_iter()
            .map(i64::from)
            .collect();
        macos::stacking(
            &order,
            i64::from(number(table)),
            i64::from(info.window.unwrap_or(0)),
            &hits,
        )
    }

    /// Poll `check` every 2 ms until it holds or `limit` passes: how long
    /// it took. (Not tighter: every check asks the window server, and a
    /// test hammering it on the runner's VM slows the very thing it
    /// measures - the first CI runs saw 0.5 s stalls polling at 0.2 ms.)
    fn until(limit: Duration, mut check: impl FnMut() -> bool) -> Option<Duration> {
        let started = Instant::now();
        loop {
            if check() {
                return Some(started.elapsed());
            }
            if started.elapsed() > limit {
                return None;
            }
            std::thread::sleep(POLL);
        }
    }

    fn events_until(
        backend: &mut MacosBackend,
        what: &str,
        done: impl Fn(&[TableEvent]) -> bool,
    ) -> Vec<TableEvent> {
        let mut all = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            all.extend(backend.poll_events());
            if done(&all) {
                eprintln!("step ok: {what}");
                return all;
            }
            assert!(Instant::now() < deadline, "{what}: only {all:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn percentile(sorted: &[Duration], p: usize) -> Duration {
        if sorted.is_empty() {
            return Duration::ZERO;
        }
        sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
    }

    fn summary(lags: &[Duration]) -> (u128, u128, u128) {
        let mut sorted = lags.to_vec();
        sorted.sort_unstable();
        (
            percentile(&sorted, 50).as_micros(),
            percentile(&sorted, 95).as_micros(),
            sorted.last().copied().unwrap_or_default().as_micros(),
        )
    }

    fn summary_us(times: &[u64]) -> (u64, u64, u64) {
        let mut sorted = times.to_vec();
        sorted.sort_unstable();
        let at = |p: usize| {
            sorted
                .get((sorted.len() * p / 100).min(sorted.len().saturating_sub(1)))
                .copied()
                .unwrap_or(0)
        };
        (at(50), at(95), sorted.last().copied().unwrap_or(0))
    }

    /// CPU time of process `pid` so far (`ps`; 10 ms resolution).
    fn cpu_time(pid: u32) -> Duration {
        let out = Command::new("ps")
            .args(["-o", "time=", "-p", &pid.to_string()])
            .output()
            .expect("ps");
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let (rest, centis) = text.split_once('.').unwrap_or((&text, "0"));
        let mut seconds = 0u64;
        for part in rest.split(':') {
            let part = part.rsplit('-').next().unwrap_or(part);
            seconds = seconds * 60 + part.parse::<u64>().unwrap_or(0);
        }
        Duration::from_millis(seconds * 1000 + centis.parse::<u64>().unwrap_or(0) * 10)
    }

    // ---------------------------------------------------------------------
    // Without any permission.

    fn without_observers(link: macos::Link) {
        let (mut sim, mut seen) = start_sim("macos-tracking-a", 2, "6,9", "31");
        let pid = sim.child.id();
        let windows = wait_for(
            Duration::from_secs(20),
            "the tables in the window list",
            || {
                seen.drain(&sim.events);
                let tables = tables(&seen, pid)?;
                if tables.len() == 2 {
                    Ok(tables)
                } else {
                    Err(format!("{} of 2", tables.len()))
                }
            },
        );
        let mut backend = MacosBackend::with_overlays(Some(link));
        let mut bars = BTreeMap::new();
        for (_, window) in &windows {
            bars.insert(window.id, bar_of(window));
            backend.track(window).expect("track");
            backend
                .overlay(window.id, &frame(window.size.unwrap_or(6)))
                .expect("overlay");
        }
        let covers = |backend: &MacosBackend, id: WindowId| -> Result<(), String> {
            let want = client_now(number(id), bars[&id]).ok_or("the table is gone")?;
            match overlay_bounds(backend, id) {
                Some(at) if at.close_to(&want) => Ok(()),
                other => Err(format!(
                    "the overlay at {other:?}, the table's client at {want:?}"
                )),
            }
        };
        for (n, window) in &windows {
            wait_for(
                Duration::from_secs(10),
                &format!("table {n}'s overlay over its client area"),
                || covers(&backend, window.id),
            );
        }
        let info = tracker(&backend);
        eprintln!(
            "step: the observers' thread: {} process(es) {:?}, tables {:?}",
            info.processes.len(),
            info.processes,
            info.tables
                .iter()
                .map(|(id, element, notes, _)| (id.0, *element, notes.len()))
                .collect::<Vec<_>>()
        );
        let _ = backend.poll_events();

        // (1) A description that is not where the table is (an older
        // re-find, say): the overlay is put where the table is - read from
        // the window server - never where the description says, and the
        // engine is told where it really is.
        let (_, first) = windows[0].clone();
        let resyncs = tracker(&backend).resyncs;
        let mut wrong = first.clone();
        wrong.client.x += 333;
        wrong.client.y += 77;
        backend.follow(&wrong);
        wait_for(
            Duration::from_secs(5),
            "the engine's description re-read",
            || {
                if tracker(&backend).resyncs > resyncs {
                    Ok(())
                } else {
                    Err("no resync".into())
                }
            },
        );
        std::thread::sleep(Duration::from_millis(300));
        covers(&backend, first.id)
            .unwrap_or_else(|why| panic!("placed from a description, not from the table: {why}"));
        let told = events_until(&mut backend, "the engine told where the table is", |e| {
            e.iter()
                .any(|e| matches!(e, TableEvent::Moved { id, .. } if *id == first.id))
        });
        assert!(
            told.iter().any(|e| matches!(
                e,
                TableEvent::Moved { id, client, .. } if *id == first.id && *client == first.client
            )),
            "{told:?}"
        );
        eprintln!("step ok: a wrong description never places the overlay");

        // (2) Moved by the simulator, then described (the re-find): there.
        let (n0, _) = windows[0];
        let x0 = first.client.x;
        sim.command(&format!("move {n0} 360 240"));
        sim.until(&mut seen, Duration::from_secs(20), "the move", |s| {
            s.windows
                .get(&n0)
                .is_some_and(|e| int(e, "clientX") != i64::from(x0))
        });
        std::thread::sleep(Duration::from_millis(300));
        seen.drain(&sim.events);
        let moved = tables(&seen, pid)
            .expect("tables")
            .into_iter()
            .find(|(n, _)| *n == n0)
            .map(|(_, w)| w)
            .expect("the moved table");
        backend.follow(&moved);
        wait_for(Duration::from_secs(5), "the moved table followed", || {
            covers(&backend, first.id)
        });

        // (3) A Space change (posted in this process: a runner has one
        // Space and no way to switch): every table read again, at once.
        let before = tracker(&backend).space_changes;
        let seen_before = backend.space_changes().unwrap_or(0);
        assert!(backend.simulate_space_change(), "posted");
        wait_for(
            Duration::from_secs(5),
            "a Space change reads every table",
            || {
                let info = tracker(&backend);
                if info.space_changes > before {
                    Ok(())
                } else {
                    Err(format!("{info:?}"))
                }
            },
        );
        assert!(backend.space_changes().unwrap_or(0) > seen_before);
        for (_, window) in &windows {
            covers(&backend, window.id).expect("still over its table after the Space change");
        }
        eprintln!(
            "R3.13: a real Space switch is not testable on the runner (one Space, no API to \
             switch without a private one): SIMULATED - the notification posted in-process; \
             the hide / show on a switch is the unit test a_space_change_hides_and_shows"
        );

        // (4) The simulator killed: its overlays go at once, the engine
        // hears `Closed` for both.
        let numbers: Vec<u32> = windows
            .iter()
            .map(|(_, w)| overlay_number(&backend, w.id))
            .collect();
        let killed = Instant::now();
        let _ = sim.child.kill();
        let _ = sim.child.wait();
        let gone = until(Duration::from_secs(5), || {
            numbers
                .iter()
                .all(|n| macos::window_now(*n).is_none_or(|w| !w.onscreen))
        });
        let gone = gone.unwrap_or_else(|| panic!("overlays outlived the simulator"));
        let events = events_until(&mut backend, "Closed for both tables", |e| {
            windows.iter().all(|(_, w)| {
                e.iter()
                    .any(|e| matches!(e, TableEvent::Closed { id } if *id == w.id))
            })
        });
        assert!(
            tracker(&backend).exited.contains(&pid),
            "the exit seen through the kqueue"
        );
        eprintln!(
            "R3.13 exit: the simulator killed -> its overlays gone in {} ms ({} ms with the \
             kill's own wait; {} events), no find needed",
            gone.as_millis(),
            killed.elapsed().as_millis(),
            events.len()
        );
        drop(backend);
        drop(sim);
    }

    // ---------------------------------------------------------------------
    // With the Accessibility permission: the observers.

    #[allow(clippy::too_many_lines)]
    fn with_observers(link: macos::Link) {
        let regex = title_regex(&simulator());
        let room = matcher("pokerstars", &regex);
        let (mut sim, mut seen) = start_sim("macos-tracking-b", 3, "6,9,6", "37");
        let pid = sim.child.id();
        let mut backend = MacosBackend::with_overlays(Some(link));
        let found = wait_for(Duration::from_secs(20), "the backend's own find", || {
            let found: Vec<TableWindow> = backend
                .find_tables(std::slice::from_ref(&room))
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|t| t.process.pid == Some(pid))
                .collect();
            if found.len() == 3 {
                Ok(found)
            } else {
                Err(format!("{} of 3", found.len()))
            }
        });
        // The simulator's numbers, by title.
        let mut tables: BTreeMap<u64, TableWindow> = BTreeMap::new();
        for table in found {
            let n = seen.table_titled(&table.title).expect("a simulator table");
            tables.insert(n, table);
        }
        let mut bars = BTreeMap::new();
        for table in tables.values() {
            bars.insert(table.id, bar_of(table));
            backend.track(table).expect("track");
            backend
                .overlay(table.id, &frame(table.size.unwrap_or(6)))
                .expect("overlay");
        }
        let covers = |backend: &MacosBackend, id: WindowId| -> Result<(), String> {
            let want = client_now(number(id), bars[&id]).ok_or("the table is gone")?;
            match overlay_bounds(backend, id) {
                Some(at) if at.close_to(&want) => Ok(()),
                other => Err(format!(
                    "the overlay at {other:?}, the table's client at {want:?}"
                )),
            }
        };
        let info = wait_for(
            Duration::from_secs(10),
            "one observer for the simulator, the window notifications on each table",
            || {
                let info = tracker(&backend);
                let process = info
                    .processes
                    .iter()
                    .find(|(p, _, _)| *p == pid)
                    .ok_or("no observer for the simulator")?;
                if process.1.len() < 4 {
                    return Err(format!("application notifications: {process:?}"));
                }
                if info.tables.len() == 3
                    && info.tables.iter().all(|(_, element, notes, _)| {
                        *element && notes.iter().any(|n| n == "AXWindowMoved")
                    })
                {
                    Ok(info)
                } else {
                    Err(format!("{:?}", info.tables))
                }
            },
        );
        eprintln!(
            "step: the simulator's process observed with {:?}; each table with {:?}",
            info.processes[0].1,
            info.tables.first().map(|t| t.2.clone()).unwrap_or_default()
        );
        for table in tables.values() {
            wait_for(
                Duration::from_secs(10),
                "an overlay over each table",
                || covers(&backend, table.id),
            );
        }

        let (&na, a) = tables.iter().next().expect("a table");
        let a = a.clone();
        sim.command(&format!("focus {na}"));
        std::thread::sleep(Duration::from_millis(400));
        let overlay_a = overlay_number(&backend, a.id);

        // A move made by this process through the Accessibility API
        // (`AXPosition`): followed through this process's own observer too?
        // Recorded (the HUD never moves a table); the overlay put right by
        // the engine's description if not.
        let handle = drive::ax_handle(pid, number(a.id)).expect("the table's element");
        let before = tracker(&backend).notes;
        let here = macos::window_now(number(a.id)).expect("table").bounds;
        handle
            .move_to(here.x + 5_000, here.y + 5_000)
            .expect("AXPosition");
        let own = until(Duration::from_secs(1), || {
            macos::window_now(number(a.id)).is_some_and(|w| {
                macos::window_now(overlay_a).is_some_and(|o| {
                    o.bounds
                        .close_to(&macos::client_frame(&w.bounds, bars[&a.id]))
                }) && w.bounds != here
            })
        });
        let info = tracker(&backend);
        eprintln!(
            "R3.13: a move made by this process through AXPosition: {} ({} notification(s) \
             meanwhile: {:?})",
            match own {
                Some(lag) => format!("followed in {} us", lag.as_micros()),
                None => "NOT notified to this process's own observer".to_owned(),
            },
            info.notes - before,
            info.by_note
        );
        if own.is_none() {
            let mut put = a.clone();
            put.client.x += 1;
            backend.follow(&put);
            wait_for(Duration::from_secs(5), "the overlay put right", || {
                covers(&backend, a.id)
            });
        }

        // A drag: the simulator moves its own window 40 times (as the
        // client does under a user's drag), each followed by the observers
        // alone (no `follow` from the engine).
        let renders = info_of(&backend, a.id).renders;
        let _ = backend.poll_events();
        let origin = macos::to_pixels(
            &macos::window_now(number(a.id)).expect("table").bounds,
            a.scale_permille,
        );
        let mut lags = Vec::new();
        let mut totals = Vec::new();
        for i in 1..=40 {
            let to = (origin.x + i * 9, origin.y + i * 3);
            let (lag, total) = sim_move(&mut sim, na, &a, to, overlay_a, bars[&a.id])
                .unwrap_or_else(|why| {
                    panic!(
                        "move {i}: {why}; the observers: {:?}",
                        backend.tracker_info()
                    )
                });
            lags.push(lag);
            totals.push(total);
        }
        let (p50, p95, max) = summary(&lags);
        let (t50, t95, _) = summary(&totals);
        let after = info_of(&backend, a.id);
        assert_eq!(after.renders, renders, "a move is not a repaint");
        std::thread::sleep(Duration::from_millis(100));
        let events = backend.poll_events();
        let moved: Vec<&TableEvent> = events
            .iter()
            .filter(|e| matches!(e, TableEvent::Moved { id, .. } if *id == a.id))
            .collect();
        assert_eq!(moved.len(), 1, "one Moved for the engine: {events:?}");
        let (f50, f95, fmax) = summary_us(&backend.follow_times_us());
        eprintln!(
            "R3.13 drag: 40 moves (the simulator's own) -> table moved (the window server's \
             bounds) -> overlay moved p50 {p50} us, p95 {p95} us, max {max} us; command -> \
             overlay moved p50 {t50} us, p95 {t95} us; inside, notification -> overlay moved p50 \
             {f50} us, p95 {f95} us, max {fmax} us; no repaint, one Moved"
        );
        assert!(p50 < 2 * FRAME.as_micros(), "p50 {p50} us");
        eprintln!("step ok: a drag followed move by move");

        // The simulator's own move: followed without the engine.
        let prev = macos::window_now(number(a.id)).expect("table").bounds;
        sim.command(&format!("move {na} 200 150"));
        let lag = until(Duration::from_secs(5), || {
            macos::window_now(number(a.id)).is_some_and(|w| {
                w.bounds != prev
                    && overlay_bounds(&backend, a.id)
                        .is_some_and(|o| o.close_to(&macos::client_frame(&w.bounds, bars[&a.id])))
            })
        })
        .unwrap_or_else(|| panic!("the simulator's move: {:?}", covers(&backend, a.id)));
        eprintln!(
            "R3.13 move: the simulator's move command -> overlay moved {} ms (its own handling \
             included)",
            lag.as_millis()
        );

        // A resize: repainted at the new size.
        let renders = info_of(&backend, a.id).renders;
        sim.command(&format!("resize {na} 800 560"));
        let lag = until(Duration::from_secs(5), || {
            backend
                .overlay_info(a.id)
                .is_some_and(|i| i.renders > renders && i.painted == (800, 560))
                && covers(&backend, a.id).is_ok()
        })
        .unwrap_or_else(|| {
            panic!(
                "resize: {:?} {:?}",
                backend.overlay_info(a.id).map(|i| (i.renders, i.painted)),
                covers(&backend, a.id)
            )
        });
        eprintln!(
            "R3.13 resize: -> repainted at the new size (800 x 560 px) {} ms after the command",
            lag.as_millis()
        );
        let _ = backend.poll_events();

        // Minimise and restore.
        let overlay_a = overlay_number(&backend, a.id);
        sim.command(&format!("minimize {na}"));
        let hidden = until(Duration::from_secs(5), || {
            macos::window_now(overlay_a).is_none_or(|w| !w.onscreen)
                && backend.overlay_info(a.id).is_some_and(|i| !i.shown)
        })
        .unwrap_or_else(|| panic!("minimised: the overlay still shows"));
        events_until(&mut backend, "Minimized for the engine", |e| {
            e.iter()
                .any(|e| matches!(e, TableEvent::Minimized { id, minimized: true } if *id == a.id))
        });
        sim.command(&format!("restore {na}"));
        let shown = until(Duration::from_secs(5), || {
            covers(&backend, a.id).is_ok() && stacked(&backend, a.id) == Stacking::Fine
        })
        .unwrap_or_else(|| panic!("restored: {:?}", covers(&backend, a.id)));
        events_until(&mut backend, "restored for the engine", |e| {
            e.iter()
                .any(|e| matches!(e, TableEvent::Minimized { id, minimized: false } if *id == a.id))
        });
        eprintln!(
            "R3.13 minimise: overlay ordered out {} ms after the command, back over the table {} \
             ms after the restore",
            hidden.as_millis(),
            shown.as_millis()
        );

        // Focus and activation: the table raised over its overlay is put
        // back at once (not at the slower safety-net look).
        let (&nb, b) = tables.iter().nth(1).expect("a second table");
        let b = b.clone();
        let restacked = info_of(&backend, b.id).restacked;
        sim.command(&format!("focus {nb}"));
        let back = until(Duration::from_secs(5), || {
            backend
                .overlay_info(b.id)
                .is_some_and(|i| i.restacked > restacked)
                && stacked(&backend, b.id) == Stacking::Fine
        });
        match back {
            Some(lag) => eprintln!(
                "R3.13 focus: the focused table's overlay put back above it {} ms after the \
                 command (the safety-net look is {} ms now)",
                lag.as_millis(),
                macos::restack_every(true).as_millis()
            ),
            None => assert_eq!(
                stacked(&backend, b.id),
                Stacking::Fine,
                "focused: the overlay is not above its table"
            ),
        }

        // A real click on the focused table (where a user bets): does it
        // raise the table over its overlay? Measured for R3.14.
        if drive::can_post() {
            let before = info_of(&backend, b.id).restacked;
            let now = macos::window_now(number(b.id)).expect("table").bounds;
            let client = macos::client_frame(&now, bars[&b.id]);
            let at = (client.x + client.width / 2, client.y + client.height / 2);
            drive::click(at.0, at.1).expect("a click");
            let mut below = 0;
            let watch = Instant::now();
            while watch.elapsed() < Duration::from_millis(600) {
                if stacked(&backend, b.id) != Stacking::Fine {
                    below += 1;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let after = info_of(&backend, b.id).restacked;
            eprintln!(
                "R3.13 click: a real click on the focused table -> restacked {} time(s), the \
                 overlay not directly above it in {below} samples of 5 ms",
                after - before
            );
            assert_eq!(stacked(&backend, b.id), Stacking::Fine, "after the click");
        } else {
            eprintln!("R3.13: this process may NOT post events: SKIPPED the real click");
        }

        // A tournament table move: the new title through the room's
        // matcher, the new table's name.
        let _ = backend.poll_events();
        let title = b.title.clone();
        let moved_at = Instant::now();
        sim.command(&format!("tablemove {nb}"));
        let events = events_until(&mut backend, "Retitled for the moved table", |e| {
            e.iter()
                .any(|e| matches!(e, TableEvent::Retitled { id, title: t, .. } if *id == b.id && *t != title))
        });
        let retitled = moved_at.elapsed();
        seen.drain(&sim.events);
        let name = seen.tables[&nb].1.clone();
        let table = events.iter().find_map(|e| match e {
            TableEvent::Retitled { id, table, .. } if *id == b.id => table.clone(),
            _ => None,
        });
        assert_eq!(
            table.as_deref(),
            Some(rail_hud::platform::table_key(&name).as_str()),
            "the hands' table name"
        );
        eprintln!(
            "R3.13 table move: Retitled ({name:?}) within {} ms of the command",
            retitled.as_millis()
        );

        // The application hidden and shown (Cmd-H, the Dock).
        let _ = backend.poll_events();
        if drive::hide_app(pid, true) {
            hidden_and_shown(&mut backend, pid, &tables, &covers);
        } else {
            eprintln!(
                "R3.13: the system refused to hide the simulator (NSRunningApplication.hide): \
                 SKIPPED the hidden application"
            );
        }

        // A hundred moves in a second.
        sim.command(&format!("focus {na}"));
        std::thread::sleep(Duration::from_millis(400));
        storm(&mut backend, &mut sim, na, &a, bars[&a.id]);

        // Closed: the overlay goes, the engine hears it.
        let (&nc, c) = tables.iter().nth(2).expect("a third table");
        let c = c.clone();
        let closed_at = Instant::now();
        sim.command(&format!("close {nc}"));
        events_until(&mut backend, "Closed for the closed table", |e| {
            e.iter()
                .any(|e| matches!(e, TableEvent::Closed { id } if *id == c.id))
        });
        assert!(backend.overlay_info(c.id).is_none(), "its overlay is gone");
        eprintln!(
            "R3.13 close: Closed and the overlay gone {} ms after the command",
            closed_at.elapsed().as_millis()
        );
        drop(backend);
        drop(sim);
    }

    /// The simulator's application hidden (the request sent): every overlay
    /// ordered out, the engine told; shown again: every overlay back.
    fn hidden_and_shown(
        backend: &mut MacosBackend,
        pid: u32,
        tables: &BTreeMap<u64, TableWindow>,
        covers: &dyn Fn(&MacosBackend, WindowId) -> Result<(), String>,
    ) {
        let hidden = until(Duration::from_secs(5), || {
            tables
                .values()
                .all(|t| backend.overlay_info(t.id).is_some_and(|i| !i.shown))
        })
        .unwrap_or_else(|| panic!("hidden: an overlay still shows"));
        events_until(backend, "hidden tables for the engine", |e| {
            tables.values().all(|t| {
                e.iter().any(
                    |e| matches!(e, TableEvent::Minimized { id, minimized: true } if *id == t.id),
                )
            })
        });
        assert!(drive::hide_app(pid, false), "unhide");
        let shown = until(Duration::from_secs(5), || {
            tables.values().all(|t| covers(backend, t.id).is_ok())
        })
        .unwrap_or_else(|| panic!("shown: an overlay is missing"));
        eprintln!(
            "R3.13 hide: the application hidden -> every overlay ordered out in {} ms, shown -> \
             back in {} ms",
            hidden.as_millis(),
            shown.as_millis()
        );
        let _ = backend.poll_events();
    }

    /// 100 moves in 1 s through the Accessibility API: each followed, the
    /// overlay never back at an older place nor hidden, one `Moved`, no
    /// repaint; the observers' and the AppKit thread's CPU.
    fn storm(backend: &mut MacosBackend, sim: &mut Sim, n: u64, a: &TableWindow, bar: i64) {
        let start = macos::to_pixels(
            &macos::window_now(number(a.id)).expect("table").bounds,
            a.scale_permille,
        );
        let overlay = overlay_number(backend, a.id);
        let renders = info_of(backend, a.id).renders;
        let _ = backend.poll_events();
        let tracker_cpu = tracker(backend).cpu_us;
        let appkit_cpu = backend.appkit_cpu_us().unwrap_or(0);
        let me = std::process::id();
        let process_cpu = cpu_time(me);
        // The moves are sent at 10 ms slots without waiting (a real drag
        // does not wait for the HUD); between them the window server is
        // sampled: each new place of the table (`targets`), when the
        // overlay first covered it (the lag), the overlay never over an
        // older place once over a newer one, never hidden.
        let started = Instant::now();
        let mut targets: Vec<(Frame, Instant, Option<Duration>)> = Vec::new();
        let mut covered = 0_usize;
        let mut backwards = Vec::new();
        let mut hidden = 0;
        let sample = |targets: &mut Vec<(Frame, Instant, Option<Duration>)>,
                      covered: &mut usize,
                      backwards: &mut Vec<(usize, usize)>,
                      hidden: &mut i32| {
            if let Some(table) = macos::window_now(number(a.id)) {
                let client = macos::client_frame(&table.bounds, bar);
                if targets.last().is_none_or(|(t, _, _)| !t.close_to(&client)) {
                    targets.push((client, Instant::now(), None));
                }
            }
            match macos::window_now(overlay) {
                Some(w) if w.onscreen => {
                    if let Some(index) = targets.iter().rposition(|(t, _, _)| t.close_to(&w.bounds))
                    {
                        if index < *covered {
                            backwards.push((index, *covered));
                        } else {
                            *covered = index;
                            let (_, seen, lag) = &mut targets[index];
                            if lag.is_none() {
                                *lag = Some(seen.elapsed());
                            }
                        }
                    }
                }
                _ => *hidden += 1,
            }
        };
        for i in 0..100_i32 {
            let slot = started + Duration::from_millis(10) * u32::try_from(i).unwrap_or(0);
            while Instant::now() < slot {
                sample(&mut targets, &mut covered, &mut backwards, &mut hidden);
                std::thread::sleep(POLL);
            }
            let to = (start.x + 4 + (i % 25) * 6, start.y + 4 + (i / 25) * 9);
            sim.command(&format!("move {n} {} {}", to.0, to.1));
        }
        let sent = started.elapsed();
        // Until the overlay is over the table's last place.
        let settled = Instant::now();
        while settled.elapsed() < Duration::from_secs(3) {
            sample(&mut targets, &mut covered, &mut backwards, &mut hidden);
            if targets.last().is_some_and(|(_, _, lag)| lag.is_some())
                && settled.elapsed() > Duration::from_millis(300)
            {
                break;
            }
            std::thread::sleep(POLL);
        }
        let lags: Vec<Duration> = targets.iter().filter_map(|(_, _, lag)| *lag).collect();
        let places = targets.len();
        let targets: Vec<Frame> = targets.iter().map(|(t, _, _)| *t).collect();
        eprintln!(
            "step: 100 moves sent in {} ms; the table showed {places} places, the overlay covered \
             {} of them",
            sent.as_millis(),
            lags.len()
        );
        let tracker_used = tracker(backend).cpu_us.saturating_sub(tracker_cpu);
        let appkit_used = backend
            .appkit_cpu_us()
            .unwrap_or(0)
            .saturating_sub(appkit_cpu);
        let process_used = cpu_time(me).saturating_sub(process_cpu);
        let last = *targets.last().expect("a target");
        std::thread::sleep(Duration::from_millis(600));
        let at = macos::window_now(overlay).expect("the overlay").bounds;
        assert!(
            at.close_to(&last),
            "moved after the storm: {at:?} vs {last:?}"
        );
        let events = backend.poll_events();
        let moved = events
            .iter()
            .filter(|e| matches!(e, TableEvent::Moved { id, .. } if *id == a.id))
            .count();
        let (p50, p95, max) = summary(&lags);
        eprintln!(
            "R3.13 storm: 100 moves (the simulator's own, 10 ms apart, not waited for) in {} ms; table moved -> overlay moved p50 {p50} \
             us, p95 {p95} us, max {max} us; CPU over the storm: the observers' thread {} ms, the \
             AppKit thread {} ms (this whole process, which also drives the moves and watches: \
             {} ms); back to an older place {} times, hidden in {hidden} samples; {moved} Moved \
             for the engine; the observers' slowest notification {} us, slowest read {} us",
            sent.as_millis(),
            tracker_used / 1000,
            appkit_used / 1000,
            process_used.as_millis(),
            backwards.len(),
            tracker(backend).slowest_note_us,
            tracker(backend).slowest_read_us
        );
        assert!(backwards.is_empty(), "the overlay went back: {backwards:?}");
        assert_eq!(hidden, 0, "the overlay hid during the storm");
        assert_eq!(moved, 1, "one Moved: {events:?}");
        assert_eq!(info_of(backend, a.id).renders, renders, "no repaint");
        // Correctness is strict everywhere: the overlay ends over the
        // table's last place, was never back at an older one nor hidden
        // (above); a place the table only passed through may be skipped (a
        // newer one came first). Latency: the typical place is covered
        // within two frames everywhere; the tail is gated only on real
        // hardware (`RAIL_HUD_REAL_HW=1`: R3.14, the owner's Mac, three
        // frames as on Windows). On CI it is a measurement, not a gate: the
        // runner's virtual window server now and then answers one reading
        // after half a second (the observers' slowest read is printed
        // above; the same code measured p95 85 ms and 0.52 s on two runs).
        assert!(p50 < 2 * FRAME.as_micros(), "p50 {p50} us");
        if real_hardware() {
            assert!(p95 < 3 * FRAME.as_micros(), "p95 {p95} us");
        } else {
            eprintln!(
                "R3.13 storm: p95 not gated here (set RAIL_HUD_REAL_HW=1 on real hardware to \
                 hold it to three frames)"
            );
        }
        assert!(
            tracker_used + appkit_used < 500_000,
            "following 100 moves cost {tracker_used} + {appkit_used} us"
        );
        eprintln!("step ok: a hundred moves in a second");
    }

    /// Move table `n` with the simulator's own `move` (its window moved by
    /// its own process, as a client's is under a user's drag) to `to`
    /// (pixels), then watch: the time from the window server showing the
    /// table there to the overlay over its client area, and from the
    /// command to the overlay.
    fn sim_move(
        sim: &mut Sim,
        n: u64,
        table: &TableWindow,
        to: (i32, i32),
        overlay: u32,
        bar: i64,
    ) -> Result<(Duration, Duration), String> {
        let want = macos::rect_points(
            &Rect {
                x: to.0,
                y: to.1,
                width: 0,
                height: 0,
            },
            table.scale_permille,
        );
        let sent = Instant::now();
        sim.command(&format!("move {n} {} {}", to.0, to.1));
        let mut moved: Option<Instant> = None;
        loop {
            if let Some(w) = macos::window_now(number(table.id))
                && (w.bounds.x - want.x).abs() <= 1_000
                && (w.bounds.y - want.y).abs() <= 1_000
            {
                let at = *moved.get_or_insert_with(Instant::now);
                let client = macos::client_frame(&w.bounds, bar);
                if macos::window_now(overlay).is_some_and(|o| o.bounds.close_to(&client)) {
                    return Ok((at.elapsed(), sent.elapsed()));
                }
            }
            if sent.elapsed() > Duration::from_secs(3) {
                return Err(format!(
                    "{} the overlay not over it: table {:?}, overlay {:?}",
                    if moved.is_some() {
                        "moved,"
                    } else {
                        "the table not moved;"
                    },
                    macos::window_now(number(table.id)).map(|w| w.bounds),
                    macos::window_now(overlay).map(|w| w.bounds)
                ));
            }
            std::thread::sleep(POLL);
        }
    }

    // ---------------------------------------------------------------------
    // The HUD process with the simulator's tracking script.

    /// The HUD's overlay over `client` (points): an on-screen window of the
    /// HUD at exactly that place.
    fn hud_overlay(hud: u32, client: &Frame) -> Option<CgWindow> {
        macos::cg_windows()
            .ok()?
            .into_iter()
            .find(|w| w.pid == hud && w.onscreen && w.layer == 0 && w.bounds.close_to(client))
    }

    /// The HUD's overlay over `client` is directly above `table` (its own
    /// click windows, inside it, may be between).
    fn hud_stacked(hud: u32, table: u32, client: &Frame) -> Result<(), String> {
        let all = macos::cg_windows().map_err(|e| e.to_string())?;
        let overlay = all
            .iter()
            .find(|w| w.pid == hud && w.onscreen && w.layer == 0 && w.bounds.close_to(client))
            .ok_or("no overlay there")?;
        let order: Vec<i64> = macos::onscreen_order()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(i64::from)
            .collect();
        let o = order
            .iter()
            .position(|&n| n == i64::from(overlay.id))
            .ok_or("the overlay is not on screen")?;
        let inside = |b: &Frame| {
            b.x >= overlay.bounds.x
                && b.y >= overlay.bounds.y
                && b.x + b.width <= overlay.bounds.x + overlay.bounds.width
                && b.y + b.height <= overlay.bounds.y + overlay.bounds.height
        };
        let hits: Vec<i64> = order[..o]
            .iter()
            .rev()
            .map_while(|&n| {
                all.iter()
                    .find(|w| i64::from(w.id) == n && w.pid == hud && inside(&w.bounds))
                    .map(|w| i64::from(w.id))
            })
            .collect();
        match macos::stacking(&order, i64::from(table), i64::from(overlay.id), &hits) {
            Stacking::Fine => Ok(()),
            other => Err(format!("{other:?}")),
        }
    }

    fn the_hud_follows_the_tracking_script() {
        let sim_path = simulator();
        let regex = title_regex(&sim_path);
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../rail-hud-sim/scripts/tracking.txt");
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
            "macos-tracking-script",
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
                "41",
                "--script",
                &script_arg,
            ],
        );
        let pid = sim.child.id();
        let hud_pid = hud.child.id();
        let mut windows: BTreeMap<u64, (u32, Frame)> = BTreeMap::new();
        let mut log: Vec<String> = Vec::new();
        let mut steps = 0;
        let deadline = Instant::now() + Duration::from_secs(120);
        let fail = |what: String, log: &[String], hud: &mut Hud| -> ! {
            hud.until("never printed", 1, Duration::from_millis(300));
            panic!(
                "{what}\nthe simulator said:\n{}\nrail-hud:\n{}",
                log.join("\n"),
                hud.log()
            );
        };
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
            let n = event["table"].as_u64();
            match (event["event"].as_str(), n) {
                (Some("window"), Some(n)) => {
                    if event["minimized"].as_bool() == Some(true) {
                        let Some((_, client)) = windows.get(&n).copied() else {
                            continue;
                        };
                        if until(Duration::from_secs(3), || {
                            hud_overlay(hud_pid, &client).is_none()
                        })
                        .is_none()
                        {
                            fail(
                                format!("table {n} minimised, its overlay shows"),
                                &log,
                                &mut hud,
                            );
                        }
                    } else {
                        // Settled windows only (the event comes once the
                        // window has settled, but give it a moment).
                        let found = wait_for_window(pid, &event);
                        let Some((id, scale)) = found else {
                            fail(format!("table {n}: no window for {event}"), &log, &mut hud);
                        };
                        let client = macos::rect_points(&client_of(&event), scale);
                        windows.insert(n, (id, client));
                        let covered = until(Duration::from_secs(3), || {
                            hud_overlay(hud_pid, &client).is_some()
                                && hud_stacked(hud_pid, id, &client).is_ok()
                        });
                        if covered.is_none() {
                            fail(
                                format!(
                                    "table {n} at {client:?}: {:?}",
                                    hud_stacked(hud_pid, id, &client)
                                ),
                                &log,
                                &mut hud,
                            );
                        }
                    }
                    steps += 1;
                    eprintln!("step ok: window event {steps} (table {n}) - the overlay agrees");
                }
                (Some("table"), Some(n)) if event["moved"].as_bool() == Some(true) => {
                    let Some((id, _)) = windows.get(&n).copied() else {
                        continue;
                    };
                    let marker = format!("window {id} moved to table");
                    if !hud.until(&marker, 1, Duration::from_secs(2)) {
                        fail(
                            format!("table {n}: the HUD did not see the move"),
                            &log,
                            &mut hud,
                        );
                    }
                    eprintln!("step ok: table {n} moved, the HUD saw it");
                }
                (Some("closed"), Some(n)) => {
                    if let Some((_, client)) = windows.remove(&n)
                        && until(Duration::from_secs(2), || {
                            hud_overlay(hud_pid, &client).is_none()
                        })
                        .is_none()
                    {
                        fail(
                            format!("table {n} closed, its overlay is still there"),
                            &log,
                            &mut hud,
                        );
                    }
                    eprintln!("step ok: table {n} closed, no overlay left");
                }
                (Some("done"), _) => break,
                _ => {}
            }
        }
        assert!(steps >= 10, "only {steps} window events checked");
        hud.until("never printed", 1, Duration::from_millis(500));
        eprintln!("rail-hud:\n{}", hud.log());
        drop(sim);
    }

    /// The simulator's window for a `window` event, looked for a moment
    /// (the window server may trail the event by a frame).
    fn wait_for_window(pid: u32, event: &Value) -> Option<(u32, u32)> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(found) = window_of_event(pid, event) {
                return Some(found);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
