//! The overlays on macOS with real windows (docs/RAIL-PLAN.md R3.12), in CI
//! on the macOS runner (it has a window server session) and on a
//! developer's Mac. Elsewhere it prints that it skipped.
//!
//! AppKit's windows belong to the main thread, so this test has its own
//! `main` (no libtest harness, whose tests run on other threads): AppKit
//! runs here as in the HUD process (`with_appkit`), the checks on the
//! engine's thread beside it.
//!
//! The table simulator opens three PokerStars-like tables (6, 9 and 2
//! seats). Two parts, by what this process may do:
//!
//! - **Always - the backend's overlays over the simulator's real windows**
//!   (no permission: the tables are made from the window server's list,
//!   which needs none, and the simulator's own events - the frames, the
//!   titles - instead of the Accessibility API's): per table the overlay
//!   exists, ignores the mouse, covers exactly the table's client area (the
//!   window server's bounds, compared in points), is ordered directly above
//!   its table with a click window directly above it per panel (the window
//!   server's order), its pixels are the panels' (the panel colour in a
//!   panel's margin, nothing at the table's centre); the same frame twice
//!   paints once; a moved table moves it without a repaint; a minimised
//!   table orders it out (and its click windows) and a restored one in
//!   again, above the table; a table raised over its overlay is put back
//!   under it; a click and a drag on a panel (events put on this process's
//!   own queue) are `PanelClicked` and `PanelMoved`; a frame permitted for
//!   another room and a window not tracked are refused; removed, its
//!   windows are gone.
//! - **With the Accessibility permission** (the test's responsible
//!   process, the terminal or the CI runner, has it): real clicks posted to the
//!   window server - on a panel the overlay takes it (`PanelClicked`), at
//!   the table's centre the simulator gets it (its `clicked` event): click
//!   through, with no permission asked by the HUD; then the HUD process
//!   (`rail-hud --standalone --sim-site ...`): an overlay window over each
//!   of the three tables posing as PokerStars, directly above it, and **no
//!   window at all** posing as GGPoker (prohibited); and under the real
//!   supervisor, a click on a villain's panel is `open_popup` for him.
//!   Without it the test says what it skipped.
//!
//! `-- --perf` instead measures twelve tables (the `R3.12 perf:` line).
//! It never prompts and never changes a setting.

mod support;

fn main() {
    #[cfg(target_os = "macos")]
    macos::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("macos_overlay: macOS only; nothing to run here");
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    use rail_config::stats::Tone;
    use rail_hud::compliance::Compliance;
    use rail_hud::layout;
    use rail_hud::panel::{PanelDesign, StatCell};
    use rail_hud::platform::macos::{
        self, CgWindow, Frame, MacosBackend, Mouse, OverlayInfo, Stacking, drive,
    };
    use rail_hud::platform::{
        OverlayFrame, PanelWords, Platform, PlatformError, ProcessInfo, Rect, SeatPanel, Seating,
        TableEvent, TableWindow, WindowId,
    };
    use rail_hud::scene::{self, PANEL};
    use rail_hud_ipc::protocol::{AppMessage, HudMessage, PlayerRef};
    use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
    use serde_json::Value;

    use super::support::{Hud, Seen, Sim, listing, simulator, title_regex, wait_for};

    /// The simulator's client size, points (winit's logical size).
    const WIDTH: u32 = 640;
    const HEIGHT: u32 = 480;

    pub fn main() {
        let perf = std::env::args().any(|a| a == "--perf");
        let code = macos::with_appkit(move |link| {
            if perf {
                twelve_tables_perf(link);
            } else {
                overlays_sit_on_their_tables(link);
                if macos::accessibility_granted() {
                    the_hud_process_draws_only_on_allowed_rooms();
                } else {
                    eprintln!(
                        "R3.12: this process does NOT have the Accessibility permission. \
                         SKIPPED: the HUD process's own overlays (it needs the titles), \
                         allowed / prohibited, and the popup through the supervisor. To run \
                         them, grant the terminal Accessibility and run: cargo test -p \
                         rail-hud --test macos_overlay -- --nocapture"
                    );
                }
            }
            0
        });
        assert_eq!(code, 0);
        eprintln!("macos_overlay: ok");
    }

    fn int(event: &Value, key: &str) -> i64 {
        event[key].as_i64().unwrap_or(i64::MIN)
    }

    /// A frame with a panel on every seat: the default design's
    /// statistics, one band each, full and dimmed.
    fn frame(site: &str, seats: u32, hands: i64) -> OverlayFrame {
        let permit = Compliance::shipped()
            .expect("shipped")
            .permit(site)
            .expect("permitted");
        let tones = [Tone::Low, Tone::Normal, Tone::High, Tone::VeryHigh];
        OverlayFrame {
            permit,
            status: None,
            debug: None,
            size: Some(seats),
            seating: Seating::default(),
            panels: (1..=seats)
                .map(|seat| SeatPanel {
                    player: format!("Player{seat}"),
                    seat: Some(seat),
                    hands: hands + i64::from(seat),
                    stats: PanelDesign::default()
                        .stats
                        .iter()
                        .zip(0_u32..)
                        .map(|(slot, i)| StatCell {
                            id: slot.id.clone(),
                            text: format!("{}", 10 + i * 7),
                            tone: Some(tones[usize::try_from(i).unwrap_or(0) % tones.len()]),
                            opacity_permille: if i % 2 == 0 { 1000 } else { 650 },
                        })
                        .collect(),
                    words: PanelWords::default(),
                })
                .collect(),
            legend: vec![Tone::Low, Tone::Normal, Tone::High],
            design: PanelDesign::default(),
        }
    }

    /// The simulator's ordinary on-screen windows, front to back.
    fn sim_windows(pid: u32) -> Vec<CgWindow> {
        macos::cg_windows()
            .unwrap_or_else(|e| panic!("the window list: {e}"))
            .into_iter()
            .filter(|w| w.pid == pid && w.layer == 0 && w.onscreen)
            .collect()
    }

    /// The simulator's tables as the engine would describe them, made
    /// without any permission: the window server's window whose frame is
    /// the simulator's `window` event (its number is the window id), the
    /// client rect and the screen's scale from it, the title and seats from
    /// the simulator's `table` event.
    fn tables(seen: &Seen, pid: u32) -> Result<Vec<(u64, TableWindow)>, String> {
        let windows = sim_windows(pid);
        let displays = macos::displays();
        let mut out = Vec::new();
        for (number, event) in &seen.windows {
            let found = windows.iter().find_map(|w| {
                let scale = macos::display_scale(&w.bounds, &displays);
                let px = macos::to_pixels(&w.bounds, scale);
                let bottom = i64::from(px.y) + i64::from(px.height);
                (i64::from(px.x) == int(event, "x")
                    && i64::from(px.y) == int(event, "y")
                    && i64::from(px.width) == int(event, "width")
                    && (bottom - (int(event, "clientY") + int(event, "height"))).abs() <= 1)
                    .then_some((w.id, scale))
            });
            let Some((id, scale)) = found else {
                return Err(format!("table {number}: no window with the frame {event}"));
            };
            let (title, _, seats) = seen
                .tables
                .get(number)
                .cloned()
                .ok_or_else(|| format!("table {number}: no table event"))?;
            let client = Rect {
                x: i32::try_from(int(event, "clientX")).map_err(|e| e.to_string())?,
                y: i32::try_from(int(event, "clientY")).map_err(|e| e.to_string())?,
                width: u32::try_from(int(event, "width")).map_err(|e| e.to_string())?,
                height: u32::try_from(int(event, "height")).map_err(|e| e.to_string())?,
            };
            out.push((
                *number,
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
                    client,
                    scale_permille: scale,
                    minimized: event["minimized"].as_bool() == Some(true),
                },
            ));
        }
        Ok(out)
    }

    /// The window server's on-screen windows, front to back.
    /// (`cg_windows`' list is not in z-order.)
    fn order() -> Vec<i64> {
        macos::onscreen_order()
            .unwrap_or_default()
            .into_iter()
            .map(i64::from)
            .collect()
    }

    fn cg_window(id: u32) -> Option<CgWindow> {
        macos::cg_windows()
            .unwrap_or_default()
            .into_iter()
            .find(|w| w.id == id)
    }

    /// Two frames the same within a point (the window server rounds).
    fn same_place(a: &Frame, b: &Frame) -> bool {
        a.close_to(b)
    }

    /// The overlay of `window` as the window server has it: on screen, of
    /// this process, at the table's client area in points, directly above
    /// the table with its click windows directly above it, each over its
    /// panel.
    fn sits_on(window: &TableWindow, info: &OverlayInfo, me: u32) -> Result<(), String> {
        let number = info.window.ok_or("no overlay window")?;
        let overlay = cg_window(number).ok_or("the overlay is not in the window list")?;
        if overlay.pid != me || overlay.layer != 0 || !overlay.onscreen {
            return Err(format!("the overlay window: {overlay:?}"));
        }
        let expected = macos::rect_points(&window.client, window.scale_permille);
        if !same_place(&overlay.bounds, &expected) {
            return Err(format!(
                "the overlay at {:?} (points), the table's client area at {expected:?}",
                overlay.bounds
            ));
        }
        if !info.ignores_mouse {
            return Err("the overlay takes the mouse".into());
        }
        if info.hits.len() != info.panels.len() || info.panels.is_empty() {
            return Err(format!(
                "{} click windows for {} panels",
                info.hits.len(),
                info.panels.len()
            ));
        }
        for hit in &info.hits {
            let cg = cg_window(hit.window).ok_or("a click window is not in the window list")?;
            let screen = Rect {
                x: window.client.x + hit.rect.x,
                y: window.client.y + hit.rect.y,
                ..hit.rect
            };
            let expected = macos::rect_points(&screen, window.scale_permille);
            if !hit.takes_mouse || !cg.onscreen || !same_place(&cg.bounds, &expected) {
                return Err(format!(
                    "click window {hit:?}: {cg:?}, expected at {expected:?} taking the mouse"
                ));
            }
        }
        let hits: Vec<i64> = info.hits.iter().map(|h| i64::from(h.window)).collect();
        let order = order();
        match macos::stacking(
            &order,
            i64::from(table_number(window)),
            i64::from(number),
            &hits,
        ) {
            Stacking::Fine => Ok(()),
            other => Err(format!(
                "stacking {other:?}: table #{} overlay #{number} hits {hits:?}; the order: {:?}",
                table_number(window),
                &order[..order.len().min(40)]
            )),
        }
    }

    fn table_number(window: &TableWindow) -> u32 {
        u32::try_from(window.id.0).unwrap_or(0)
    }

    /// A point of the panel's bottom margin, below its figures: only the
    /// panel's own colour there.
    fn margin_point(panel: &Rect) -> (u32, u32) {
        (
            u32::try_from(panel.x).unwrap_or(0) + panel.width / 2,
            u32::try_from(panel.y).unwrap_or(0) + panel.height - 2,
        )
    }

    /// The panel colour premultiplied, as the bitmap holds it (B, G, R, A).
    fn panel_premultiplied() -> [u8; 4] {
        let p = |c: u8| u8::try_from(u32::from(c) * u32::from(PANEL.a) / 255).unwrap_or(0);
        [p(PANEL.b), p(PANEL.g), p(PANEL.r), PANEL.a]
    }

    fn near(a: u8, b: u8, tolerance: u8) -> bool {
        a.abs_diff(b) <= tolerance
    }

    fn info_of(backend: &MacosBackend, id: WindowId) -> OverlayInfo {
        backend
            .overlay_info(id)
            .unwrap_or_else(|| panic!("no overlay for window {}", id.0))
    }

    /// The middle of a client rect, client pixels.
    fn middle(r: &Rect) -> (i32, i32) {
        (
            r.x + i32::try_from(r.width / 2).unwrap_or(0),
            r.y + i32::try_from(r.height / 2).unwrap_or(0),
        )
    }

    /// A client pixel of `window` in the global top-left space,
    /// thousandths of a point (where `drive` clicks).
    fn global(window: &TableWindow, at: (i32, i32)) -> (i64, i64) {
        let p = macos::rect_points(
            &Rect {
                x: window.client.x + at.0,
                y: window.client.y + at.1,
                width: 0,
                height: 0,
            },
            window.scale_permille,
        );
        (p.x, p.y)
    }

    /// Engine events from the backend until `done` says so.
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
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn start_sim(name: &str, tables: &str, sizes: &str, seed: &str) -> (Sim, Seen) {
        let sim_path = simulator();
        let mut sim = Sim::start(
            &sim_path,
            name,
            &[
                "--tables",
                tables,
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
        let count: usize = tables.parse().expect("a number");
        let mut seen = Seen::default();
        sim.until(
            &mut seen,
            Duration::from_secs(120),
            &format!("{count} shown windows"),
            |s| s.tables.len() == count && s.windows.len() == count,
        );
        // The `window` events come once a window has settled; take the
        // latest.
        std::thread::sleep(Duration::from_millis(500));
        seen.drain(&sim.events);
        (sim, seen)
    }

    fn found(sim: &mut Sim, seen: &mut Seen, count: usize) -> Vec<(u64, TableWindow)> {
        let pid = sim.child.id();
        wait_for(
            Duration::from_secs(20),
            "the tables in the window list",
            || {
                seen.drain(&sim.events);
                let tables = tables(seen, pid)?;
                if tables.len() == count {
                    Ok(tables)
                } else {
                    Err(format!("{} of {count}", tables.len()))
                }
            },
        )
    }

    fn overlays_sit_on_their_tables(link: Option<macos::Link>) {
        assert!(link.is_some(), "AppKit runs on this test's main thread");
        let me = std::process::id();
        let (mut sim, mut seen) = start_sim("macos-overlay", "3", "6,9,2", "11");
        let windows = found(&mut sim, &mut seen, 3);
        let mut backend = MacosBackend::with_overlays(link);
        for (number, window) in &windows {
            eprintln!(
                "step: table {number} is window #{} client {:?} scale {}",
                window.id.0, window.client, window.scale_permille
            );
            backend.track(window).expect("track");
            let seats = window.size.expect("seats");
            backend
                .overlay(window.id, &frame("pokerstars", seats, 100))
                .expect("overlay");
        }

        // Per table: where it is, what it shows, how it is stacked. Each
        // table is brought to the front first (the simulator's windows
        // overlap on a small screen, the CI runner's): its overlay is put
        // back above it, and nothing of anyone else's covers it.
        for (number, window) in &windows {
            let seats = window.size.expect("seats");
            sim.command(&format!("focus {number}"));
            // The simulator raises it on its own thread, a moment later.
            std::thread::sleep(Duration::from_millis(300));
            let info = wait_for(
                Duration::from_secs(10),
                &format!("table {number} in front, its overlay over its client area, above it"),
                || {
                    let info = info_of(&backend, window.id);
                    sits_on(window, &info, me)?;
                    let centre = middle(&Rect {
                        x: 0,
                        y: 0,
                        width: window.client.width,
                        height: window.client.height,
                    });
                    match backend.window_at(global(window, centre), 0) {
                        Some(n) if n == table_number(window) => {}
                        other => return Err(format!("in front at its centre: {other:?}")),
                    }
                    // Every panel's click window in front of the table too
                    // (the overlay may still be on its way back over it).
                    let all = info.seat_panels.iter().all(|(_, r)| {
                        let at = backend.window_at(global(window, middle(r)), 0);
                        info.hits.iter().any(|h| Some(h.window) == at)
                    });
                    if all {
                        Ok(info)
                    } else {
                        Err("a panel's press goes elsewhere".into())
                    }
                },
            );
            assert_eq!(info.renders, 1, "{info:?}");
            assert_eq!(info.contents_scale, window.scale_permille);
            assert_eq!(info.painted, (window.client.width, window.client.height));
            let expected = scene::compose(
                &frame("pokerstars", seats, 100),
                window.client.width,
                window.client.height,
                window.scale_permille,
                &PanelDesign::default(),
            );
            assert_eq!(info.panels, expected.panels, "the layout's panels");
            assert_eq!(info.seat_panels.len(), usize::try_from(seats).unwrap_or(0));
            let (mx, my) = margin_point(&info.seat_panels[0].1);
            let pixel = backend.overlay_pixel(window.id, mx, my).expect("pixel");
            let want = panel_premultiplied();
            assert!(
                (0..4).all(|i| near(pixel[i], want[i], 2)),
                "the panel's margin is {pixel:?}, the panel colour premultiplied {want:?}"
            );
            let centre = (
                window.client.width / 2,
                window.client.height * layout::TABLE_CENTER.1 / 1000,
            );
            assert!(
                !info.panels.iter().any(|p| layout::contains(
                    p,
                    i32::try_from(centre.0).unwrap_or(0),
                    i32::try_from(centre.1).unwrap_or(0),
                )),
                "a panel covers the centre"
            );
            let clear = backend
                .overlay_pixel(window.id, centre.0, centre.1)
                .expect("pixel");
            assert_eq!(clear, [0, 0, 0, 0], "the table's centre is transparent");
            let drawn = info.seat_panels.iter().any(|(_, r)| {
                (0..r.height).any(|dy| {
                    (0..r.width).any(|dx| {
                        backend
                            .overlay_pixel(
                                window.id,
                                u32::try_from(r.x).unwrap_or(0) + dx,
                                u32::try_from(r.y).unwrap_or(0) + dy,
                            )
                            .is_some_and(|p| p[0] > 150 && p[1] > 150 && p[2] > 150)
                    })
                })
            });
            assert!(drawn, "a light figure is drawn on a panel");
            // What the window server shows of the overlay window (this
            // process's own: no permission): the panel where it was
            // painted, nothing at the centre.
            let shown = info
                .window
                .and_then(|w| drive::own_window_pixels(w, &[(mx, my), centre]));
            match shown.as_deref() {
                Some([panel_px, centre_px]) => {
                    assert!(
                        (0..4).all(|i| near(panel_px[i], want[i], 3)),
                        "on screen the panel's margin is {panel_px:?}, painted {want:?}"
                    );
                    assert_eq!(centre_px[3], 0, "on screen the centre is {centre_px:?}");
                }
                _ => eprintln!(
                    "R3.12: the window server gave no image of the overlay window: SKIPPED \
                     the on-screen pixels"
                ),
            }
            // Where a press would go, as the window server hit-tests it
            // (no permission): through the overlay to the table at its
            // centre, to a click window on every panel.
            let at_centre = backend.window_at(
                global(
                    window,
                    (
                        i32::try_from(centre.0).unwrap_or(0),
                        i32::try_from(centre.1).unwrap_or(0),
                    ),
                ),
                0,
            );
            assert_ne!(at_centre, info.window, "the overlay lets the press through");
            assert_eq!(
                at_centre,
                Some(table_number(window)),
                "a press at the centre reaches the table"
            );
            for (slot, r) in &info.seat_panels {
                let at = backend.window_at(global(window, middle(r)), 0);
                assert!(
                    info.hits.iter().any(|h| Some(h.window) == at),
                    "slot {slot}'s panel: a press there goes to {at:?}, not a click window: \
                     {info:?}"
                );
            }
            eprintln!(
                "step ok: table {number}: overlay #{} with {} click windows (every panel takes \
                 a press, the centre goes to the table), painted in {} us, on screen as painted",
                info.window.unwrap_or(0),
                info.hits.len(),
                info.last_render_us
            );
        }

        let (first_number, first) = windows[0].clone();
        let seats = first.size.expect("seats");
        // The same frame twice is painted once.
        backend
            .overlay(first.id, &frame("pokerstars", seats, 100))
            .expect("overlay");
        assert_eq!(info_of(&backend, first.id).renders, 1);
        eprintln!("step ok: the same frame again is not painted again");

        // Refused: a frame permitted for another room, a window not tracked.
        let refused = backend.overlay(first.id, &frame("acr", seats, 1));
        assert!(matches!(refused, Err(PlatformError::Os(_))), "{refused:?}");
        assert_eq!(
            backend.overlay(WindowId(1), &frame("pokerstars", 6, 1)),
            Err(PlatformError::Gone(WindowId(1)))
        );
        eprintln!("step ok: another room's frame and an untracked window are refused");

        // A click on a seat's panel and a drag of another, through this
        // process's own event queue (no permission): the same handling as
        // the user's mouse.
        let info = info_of(&backend, first.id);
        let (slot, panel) = info.seat_panels[1];
        let at = middle(&panel);
        assert!(backend.inject_mouse(first.id, Mouse::Press(at.0, at.1)));
        assert!(backend.inject_mouse(first.id, Mouse::Release(at.0, at.1)));
        let events = events_until(&mut backend, "a click on a panel is PanelClicked", |e| {
            !e.is_empty()
        });
        match &events[..] {
            [
                TableEvent::PanelClicked {
                    id,
                    slot: clicked,
                    panel: on_screen,
                    scale_permille,
                },
            ] => {
                assert_eq!((*id, *clicked), (first.id, slot));
                assert_eq!(*scale_permille, first.scale_permille);
                assert_eq!(
                    (on_screen.x, on_screen.y),
                    (first.client.x + panel.x, first.client.y + panel.y)
                );
            }
            other => panic!("a click: {other:?}"),
        }
        let (slot, panel) = info.seat_panels[0];
        let from = middle(&panel);
        let to = (
            from.0,
            from.1 + i32::try_from(first.client.height / 10).unwrap_or(40),
        );
        assert!(backend.inject_mouse(first.id, Mouse::Press(from.0, from.1)));
        for step in 1..=5 {
            let y = from.1 + (to.1 - from.1) * step / 5;
            assert!(backend.inject_mouse(first.id, Mouse::Move(from.0, y)));
        }
        assert!(backend.inject_mouse(first.id, Mouse::Release(to.0, to.1)));
        let events = events_until(&mut backend, "a drag of a panel is PanelMoved", |e| {
            !e.is_empty()
        });
        match &events[..] {
            [
                TableEvent::PanelMoved {
                    id, slot: moved, ..
                },
            ] => {
                assert_eq!((*id, *moved), (first.id, slot));
            }
            other => panic!("a drag: {other:?}"),
        }
        let dragged = info_of(&backend, first.id);
        assert_eq!((dragged.drags, dragged.clicks), (1, 1));
        assert!(dragged.placed_by_user.contains(&slot), "{dragged:?}");
        wait_for(
            Duration::from_secs(5),
            "the click windows follow the dropped panel",
            || sits_on(&first, &info_of(&backend, first.id), me),
        );

        // Real clicks through the window server: needs the permission to
        // post events (Accessibility).
        if drive::can_post() {
            real_clicks(&mut backend, &mut sim, &mut seen, first_number, &first);
        } else {
            eprintln!(
                "R3.12: this process may NOT post events (Accessibility). SKIPPED: real clicks - \
                 on a panel taken by the overlay, at the table's centre reaching the table."
            );
        }

        // A moved table: the overlay moves, no repaint.
        let renders = info_of(&backend, first.id).renders;
        let x0 = first.client.x;
        sim.command(&format!("move {first_number} 300 260"));
        sim.until(&mut seen, Duration::from_secs(20), "the move", |s| {
            s.windows
                .get(&first_number)
                .is_some_and(|e| int(e, "clientX") != i64::from(x0))
        });
        std::thread::sleep(Duration::from_millis(300));
        seen.drain(&sim.events);
        let moved = tables(&seen, sim.child.id())
            .expect("tables")
            .into_iter()
            .find(|(n, _)| *n == first_number)
            .map(|(_, w)| w)
            .expect("the moved table");
        backend.follow(&moved);
        let info = wait_for(
            Duration::from_secs(10),
            "the overlay follows the move",
            || {
                let info = info_of(&backend, first.id);
                sits_on(&moved, &info, me).map(|()| info)
            },
        );
        assert_eq!(info.renders, renders, "a move is not a repaint");
        assert!(info.moves >= 1, "{info:?}");
        eprintln!("step ok: moved without a repaint");

        // Raised over its overlay (the simulator focuses the table: its app
        // comes forward with this window first): put back under it.
        let restacked = info.restacked;
        sim.command(&format!("focus {first_number}"));
        wait_for(
            Duration::from_secs(10),
            "the raised table's overlay put back",
            || {
                let info = info_of(&backend, moved.id);
                if info.restacked > restacked {
                    sits_on(&moved, &info, me)
                } else {
                    Err(format!("restacked {} times", info.restacked))
                }
            },
        );

        // Minimised: ordered out with its click windows; restored: in again,
        // above the table.
        sim.command(&format!("minimize {first_number}"));
        sim.until(&mut seen, Duration::from_secs(20), "the minimise", |s| {
            s.windows
                .get(&first_number)
                .is_some_and(|e| e["minimized"].as_bool() == Some(true))
        });
        let mut hidden = moved.clone();
        hidden.minimized = true;
        hidden.client = Rect::default();
        backend.follow(&hidden);
        let info = wait_for(Duration::from_secs(10), "minimised: ordered out", || {
            let info = info_of(&backend, first.id);
            let overlay = info.window.and_then(cg_window);
            let hits_on = info
                .hits
                .iter()
                .filter_map(|h| cg_window(h.window))
                .any(|w| w.onscreen);
            if !info.shown && overlay.is_some_and(|w| !w.onscreen) && !hits_on {
                Ok(info)
            } else {
                Err(format!("{info:?}"))
            }
        });
        let table = cg_window(table_number(&first)).expect("the table");
        assert!(!table.onscreen, "the table is minimised: {table:?}");
        sim.command(&format!("restore {first_number}"));
        sim.until(&mut seen, Duration::from_secs(20), "the restore", |s| {
            s.windows
                .get(&first_number)
                .is_some_and(|e| e["minimized"].as_bool() == Some(false))
        });
        std::thread::sleep(Duration::from_millis(500));
        seen.drain(&sim.events);
        backend.follow(&moved);
        wait_for(
            Duration::from_secs(10),
            "restored: above the table again",
            || sits_on(&moved, &info_of(&backend, first.id), me),
        );
        assert_eq!(info_of(&backend, first.id).renders, info.renders);

        // Removed: its windows are gone.
        let gone = info_of(&backend, first.id);
        backend.remove_overlay(first.id);
        assert!(backend.overlay_info(first.id).is_none());
        let numbers: Vec<u32> = gone
            .hits
            .iter()
            .map(|h| h.window)
            .chain(gone.window)
            .collect();
        wait_for(
            Duration::from_secs(5),
            "removed: its windows are gone",
            || {
                let left: Vec<CgWindow> = numbers
                    .iter()
                    .filter_map(|n| cg_window(*n))
                    .filter(|w| w.onscreen)
                    .collect();
                if left.is_empty() {
                    Ok(())
                } else {
                    Err(format!("{left:?}"))
                }
            },
        );
        drop(backend);
        wait_for(
            Duration::from_secs(5),
            "no overlay left with the backend",
            || {
                let mine: Vec<CgWindow> = macos::cg_windows()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|w| w.pid == me && w.onscreen)
                    .collect();
                if mine.is_empty() {
                    Ok(())
                } else {
                    Err(format!("{mine:?}"))
                }
            },
        );
        drop(sim);
    }

    /// Clicks posted to the window server: on a panel the overlay takes it;
    /// at the table's centre the table gets it.
    fn real_clicks(
        backend: &mut MacosBackend,
        sim: &mut Sim,
        seen: &mut Seen,
        number: u64,
        window: &TableWindow,
    ) {
        let _ = backend.poll_events();
        // In front, so that nothing covers the points clicked.
        sim.command(&format!("focus {number}"));
        // The simulator raises it on its own thread, a moment later.
        std::thread::sleep(Duration::from_millis(300));
        let me = std::process::id();
        let info = wait_for(Duration::from_secs(10), "the table in front", || {
            let info = info_of(backend, window.id);
            sits_on(window, &info, me)?;
            let at = global(window, middle(&info.seat_panels[0].1));
            match backend.window_at(at, 0) {
                Some(n) if info.hits.iter().any(|h| h.window == n) => Ok(info),
                other => Err(format!("at a panel: {other:?}")),
            }
        });
        let (slot, panel) = info.seat_panels[2.min(info.seat_panels.len() - 1)];
        let at = global(window, middle(&panel));
        drive::click(at.0, at.1).expect("a click");
        let events = events_until(backend, "a real click on a panel is PanelClicked", |e| {
            !e.is_empty()
        });
        assert!(
            matches!(&events[..], [TableEvent::PanelClicked { slot: s, .. }] if *s == slot),
            "{events:?}"
        );
        let centre = (
            i32::try_from(window.client.width / 2).unwrap_or(0),
            i32::try_from(window.client.height * layout::TABLE_CENTER.1 / 1000).unwrap_or(0),
        );
        let at = global(window, centre);
        drive::click(at.0, at.1).expect("a click");
        sim.until(
            seen,
            Duration::from_secs(10),
            "a real click at the centre reaches the table",
            |s| {
                s.log.iter().any(|l| {
                    l.contains("\"event\":\"clicked\"")
                        && l.contains(&format!("\"table\":{number}"))
                })
            },
        );
        assert!(
            backend.poll_events().is_empty(),
            "the overlay saw nothing of it"
        );
    }

    /// The HUD process with the Accessibility permission: overlays over the
    /// three tables posing as PokerStars, none posing as GGPoker; and the
    /// popup through the supervisor.
    fn the_hud_process_draws_only_on_allowed_rooms() {
        let sim_path = simulator();
        let regex = title_regex(&sim_path);
        let (mut sim, mut seen) = start_sim("macos-overlay-hud", "3", "6,9,2", "17");
        let windows = found(&mut sim, &mut seen, 3);
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
        let pid = hud.child.id();
        for (number, window) in &windows {
            wait_for(
                Duration::from_secs(10),
                &format!("the HUD's overlay over table {number}, directly above it"),
                || {
                    let all = macos::cg_windows().map_err(|e| e.to_string())?;
                    let expected = macos::rect_points(&window.client, window.scale_permille);
                    let overlay = all
                        .iter()
                        .find(|w| w.pid == pid && w.onscreen && same_place(&w.bounds, &expected))
                        .ok_or_else(|| format!("none of {pid}'s windows at {expected:?}"))?;
                    let order = order();
                    // Its click windows: the HUD's windows directly above
                    // it and inside it (the "waiting" pill's, if any).
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
                                .find(|w| i64::from(w.id) == n && w.pid == pid && inside(&w.bounds))
                                .map(|w| i64::from(w.id))
                        })
                        .collect();
                    match macos::stacking(
                        &order,
                        i64::from(table_number(window)),
                        i64::from(overlay.id),
                        &hits,
                    ) {
                        Stacking::Fine => Ok(()),
                        other => Err(format!(
                            "{other:?}: overlay #{} table #{} order {:?}",
                            overlay.id,
                            table_number(window),
                            &order[..order.len().min(40)]
                        )),
                    }
                },
            );
        }
        drop(hud);
        let mut hud = Hud::start(&[
            "--standalone",
            "--sim-site",
            "ggpoker",
            "--sim-title",
            &regex,
        ]);
        assert!(
            hud.until("not attaching to window", 3, Duration::from_secs(30)),
            "{}",
            hud.log()
        );
        std::thread::sleep(Duration::from_secs(1));
        let pid = hud.child.id();
        let theirs: Vec<CgWindow> = macos::cg_windows()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| w.pid == pid && w.onscreen)
            .collect();
        assert!(
            theirs.is_empty(),
            "a prohibited room: no window on screen at all: {theirs:?}"
        );
        // Nor one made and hidden: none of its windows, on screen or not,
        // has a table's place (AppKit's own helper windows may exist).
        let overlays: Vec<CgWindow> = macos::cg_windows()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| {
                w.pid == pid
                    && windows.iter().any(|(_, t)| {
                        same_place(&w.bounds, &macos::rect_points(&t.client, t.scale_permille))
                    })
            })
            .collect();
        assert!(
            overlays.is_empty(),
            "a prohibited room's overlay: {overlays:?}"
        );
        eprintln!("step ok: the HUD process draws posing as PokerStars, nothing as GGPoker");
        drop(hud);
        drop(sim);

        if drive::can_post() {
            a_click_on_a_panel_opens_the_popup(&regex);
        } else {
            eprintln!(
                "R3.12: this process may NOT post events. SKIPPED: the popup through the \
                 supervisor (a real click on a panel)."
            );
        }
    }

    /// The app's half: the store, the supervisor and what the HUD said.
    struct App {
        supervisor: Supervisor,
        events: Receiver<Event>,
        said: Vec<HudMessage>,
    }

    impl App {
        fn start(db: &std::path::Path, regex: &str) -> Self {
            let (tx, events) = mpsc::channel();
            let mut config = SupervisorConfig::new(env!("CARGO_BIN_EXE_rail-hud"));
            config.args = vec![
                "--store".into(),
                db.as_os_str().to_owned(),
                "--sim-site".into(),
                "pokerstars".into(),
                "--sim-title".into(),
                regex.into(),
            ];
            let supervisor = Supervisor::start(config, move |event| {
                let _ = tx.send(event);
            })
            .expect("supervisor");
            let mut app = Self {
                supervisor,
                events,
                said: Vec::new(),
            };
            app.until(Duration::from_secs(30), "the HUD connects", |e| {
                matches!(e, Event::Connected { .. })
            });
            app
        }

        fn until(&mut self, timeout: Duration, what: &str, done: impl Fn(&Event) -> bool) -> Event {
            let deadline = Instant::now() + timeout;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !left.is_zero(),
                    "timed out waiting for {what}; the HUD said {:?}\nwindows:\n{}",
                    self.said,
                    listing()
                );
                if let Ok(event) = self
                    .events
                    .recv_timeout(left.min(Duration::from_millis(200)))
                {
                    if let Event::Message(message, _) = &event {
                        self.said.push(message.clone());
                    }
                    if let Event::Disconnected { reason } = &event {
                        panic!("the HUD went away: {reason}; it said {:?}", self.said);
                    }
                    if done(&event) {
                        eprintln!("step ok: {what}");
                        return event;
                    }
                }
            }
        }

        fn hand(&self, hand: &Value) {
            let players = hand["seated"]
                .as_array()
                .expect("seated")
                .iter()
                .map(|p| PlayerRef {
                    name: p["name"].as_str().unwrap_or_default().to_owned(),
                    scope: String::new(),
                    seat: p["seat"].as_u64().and_then(|s| u32::try_from(s).ok()),
                    hero: p["hero"].as_bool().unwrap_or(false),
                    stack_bb_tenths: None,
                })
                .collect();
            self.supervisor.send(AppMessage::HandImported {
                site: hand["site"].as_str().unwrap_or_default().to_owned(),
                table: hand["tableName"].as_str().map(str::to_owned),
                hand_key: hand["handKey"].as_str().unwrap_or_default().to_owned(),
                players,
                timing: None,
            });
        }
    }

    /// (R3.8 on macOS) The HUD under the real supervisor, the simulator's
    /// table posing as PokerStars: a real click on a villain's panel is
    /// `open_popup` for him, the panel on the screen around the click.
    fn a_click_on_a_panel_opens_the_popup(regex: &str) {
        let dir: PathBuf =
            std::env::temp_dir().join(format!("rail-hud-macos-popup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = dir.join(rail_store::FILE_NAME);
        let store = rail_store::Store::open(&db).expect("store");
        let sim_path = simulator();
        let mut sim = Sim::start(
            &sim_path,
            "macos-popup",
            &[
                "--tables",
                "1",
                "--sizes",
                "6",
                "--window",
                &format!("{WIDTH}x{HEIGHT}"),
                "--speed",
                "6",
                "--seed",
                "43",
            ],
        );
        let mut seen = Seen::default();
        sim.until(
            &mut seen,
            Duration::from_secs(120),
            "a table with a hand",
            |s| s.windows.len() == 1 && s.hands.len() == 1,
        );
        std::thread::sleep(Duration::from_millis(500));
        seen.drain(&sim.events);
        let windows = found(&mut sim, &mut seen, 1);
        let (number, window) = windows[0].clone();
        sim.command(&format!("focus {number}"));
        // The simulator raises it on its own thread, a moment later.
        std::thread::sleep(Duration::from_millis(300));
        let mut app = App::start(&db, regex);
        app.until(Duration::from_secs(30), "one table attached", |e| {
            matches!(e, Event::Message(HudMessage::TablesOpen { count: 1 }, _))
        });
        seen.drain(&sim.events);
        let hand = seen.hands[&number].clone();
        app.hand(&hand);
        app.until(Duration::from_secs(20), "the hand drawn", |e| {
            matches!(
                e,
                Event::Message(
                    HudMessage::TableUpdated {
                        hand_key: Some(_),
                        ..
                    },
                    _
                )
            )
        });
        let seated: Vec<(u32, String, bool)> = hand["seated"]
            .as_array()
            .expect("seated")
            .iter()
            .map(|p| {
                (
                    u32::try_from(p["seat"].as_u64().unwrap_or(0)).unwrap_or(0),
                    p["name"].as_str().unwrap_or_default().to_owned(),
                    p["hero"].as_bool().unwrap_or(false),
                )
            })
            .collect();
        let mut by_seat: BTreeMap<u32, (String, bool)> = BTreeMap::new();
        for (seat, name, hero) in &seated {
            by_seat.insert(*seat, (name.clone(), *hero));
        }
        let (seat, (name, _)) = by_seat
            .iter()
            .find(|(_, (_, hero))| !hero)
            .map(|(s, v)| (*s, v.clone()))
            .expect("a villain");
        let mut layout_frame = frame("pokerstars", 6, 1);
        layout_frame
            .panels
            .retain(|p| by_seat.contains_key(&p.seat.unwrap_or(0)));
        let scene = scene::compose(
            &layout_frame,
            window.client.width,
            window.client.height,
            window.scale_permille,
            &PanelDesign::default(),
        );
        let panel = scene
            .seat_panels
            .iter()
            .find(|(slot, _)| *slot == seat - 1)
            .map(|(_, r)| *r)
            .expect("the villain's panel");
        let at = middle(&panel);
        let point = global(&window, at);
        // The HUD's click window there, frontmost (its panels are painted
        // a moment after `table_updated`).
        let pid = app.supervisor.status().pid.expect("a HUD process");
        wait_for(
            Duration::from_secs(10),
            "the villain's panel takes clicks",
            || {
                let all = macos::cg_windows().map_err(|e| e.to_string())?;
                let order = order();
                let front = order
                    .iter()
                    .filter_map(|n| all.iter().find(|w| i64::from(w.id) == *n))
                    .find(|w| {
                        w.layer == 0
                            && point.0 >= w.bounds.x
                            && point.1 >= w.bounds.y
                            && point.0 < w.bounds.x + w.bounds.width
                            && point.1 < w.bounds.y + w.bounds.height
                    })
                    .ok_or("no window there")?;
                let table = macos::rect_points(&window.client, window.scale_permille);
                if front.pid == pid && front.bounds.width < table.width {
                    Ok(())
                } else {
                    Err(format!("in front there: {front:?}"))
                }
            },
        );
        drive::click(point.0, point.1).expect("a click");
        let said = app.until(Duration::from_secs(10), "open_popup", |e| {
            matches!(e, Event::Message(HudMessage::OpenPopup { .. }, _))
        });
        let Event::Message(
            HudMessage::OpenPopup {
                site,
                player,
                slot,
                anchor,
                ..
            },
            _,
        ) = said
        else {
            unreachable!()
        };
        assert_eq!(site, "pokerstars");
        assert_eq!(
            (player.name.as_str(), player.seat),
            (name.as_str(), Some(seat))
        );
        assert_eq!(slot, seat - 1);
        let (sx, sy) = (window.client.x + at.0, window.client.y + at.1);
        assert!(
            sx >= anchor.x
                && sy >= anchor.y
                && sx < anchor.x + i32::try_from(anchor.width).unwrap_or(0)
                && sy < anchor.y + i32::try_from(anchor.height).unwrap_or(0),
            "the click ({sx}, {sy}) is in the anchor {anchor:?}"
        );
        eprintln!("step ok: a real click on {name}'s panel is open_popup (slot {slot})");
        app.supervisor.stop();
        store.close();
        drop(sim);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// CPU time of process `pid` so far (`ps`; 10 ms resolution).
    fn cpu_time(pid: u32) -> Duration {
        let out = Command::new("ps")
            .args(["-o", "time=", "-p", &pid.to_string()])
            .output()
            .expect("ps");
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        // [[dd-]hh:]mm:ss.cc
        let (rest, centis) = text.split_once('.').unwrap_or((&text, "0"));
        let mut seconds = 0u64;
        for part in rest.split(':') {
            let part = part.rsplit('-').next().unwrap_or(part);
            seconds = seconds * 60 + part.parse::<u64>().unwrap_or(0);
        }
        let centis: u64 = centis.parse().unwrap_or(0);
        Duration::from_millis(seconds * 1000 + centis * 10)
    }

    fn percentile(sorted: &[u64], p: usize) -> u64 {
        if sorted.is_empty() {
            return 0;
        }
        sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
    }

    fn percent(cpu: Duration, over: Duration) -> String {
        let hundredths = cpu.as_micros() * 10_000 / over.as_micros().max(1);
        format!("{}.{:02} %", hundredths / 100, hundredths % 100)
    }

    /// Twelve tables: every overlay painted 20 times with new figures (the
    /// paint's p50 / p95 / max), then this process idle with the twelve
    /// shown for 10 s; with Accessibility, the HUD process attached to the
    /// twelve and idle for 10 s too.
    fn twelve_tables_perf(link: Option<macos::Link>) {
        let (mut sim, mut seen) = start_sim("macos-overlay-perf", "12", "9,6", "13");
        let windows = found(&mut sim, &mut seen, 12);
        let mut backend = MacosBackend::with_overlays(link);
        for (_, window) in &windows {
            backend.track(window).expect("track");
        }
        let started = Instant::now();
        for round in 0..20 {
            for (_, window) in &windows {
                backend
                    .overlay(
                        window.id,
                        &frame("pokerstars", window.size.unwrap_or(9), round * 13),
                    )
                    .expect("overlay");
            }
        }
        let mut times = wait_for(Duration::from_secs(60), "240 paints", || {
            let times = backend.render_times_us();
            if times.len() >= 240 {
                Ok(times)
            } else {
                Err(format!("{} paints", times.len()))
            }
        });
        let wall = started.elapsed();
        times.sort_unstable();
        let (p50, p95, max) = (
            percentile(&times, 50),
            percentile(&times, 95),
            times.last().copied().unwrap_or(0),
        );
        let me = std::process::id();
        std::thread::sleep(Duration::from_secs(1));
        let before = cpu_time(me);
        std::thread::sleep(Duration::from_secs(10));
        let idle = cpu_time(me).saturating_sub(before);
        let bitmaps: u64 = windows
            .iter()
            .map(|(_, w)| u64::from(w.client.width) * u64::from(w.client.height) * 4)
            .sum();
        let hud = if macos::accessibility_granted() {
            drop(backend);
            let regex = title_regex(&simulator());
            let mut hud = Hud::start(&[
                "--standalone",
                "--sim-site",
                "pokerstars",
                "--sim-title",
                &regex,
            ]);
            assert!(
                hud.until("attached to window", 12, Duration::from_secs(60)),
                "{}",
                hud.log()
            );
            std::thread::sleep(Duration::from_secs(2));
            let pid = hud.child.id();
            let before = cpu_time(pid);
            std::thread::sleep(Duration::from_secs(10));
            let used = cpu_time(pid).saturating_sub(before);
            format!(
                "rail-hud attached to 12 tables, idle 10 s: {} ms CPU ({} of one core)",
                used.as_millis(),
                percent(used, Duration::from_secs(10))
            )
        } else {
            "rail-hud process: SKIPPED (no Accessibility: it finds no table)".to_owned()
        };
        println!(
            "R3.12 perf: {} paints of 12 tables (6- and 9-max, {WIDTH}x{HEIGHT} pt, scale {}): \
             p50 {p50} us, p95 {p95} us, max {max} us; 240 frames handed over and painted in {} \
             ms; overlays shown, idle 10 s: this process {} ms CPU ({} of one core); {hud}; \
             bitmaps {} KiB",
            times.len(),
            windows[0].1.scale_permille,
            wall.as_millis(),
            idle.as_millis(),
            percent(idle, Duration::from_secs(10)),
            bitmaps / 1024
        );
        assert!(p95 < 16_000, "a paint's p95 is {p95} us, over 16 ms");
        drop(sim);
    }
}
