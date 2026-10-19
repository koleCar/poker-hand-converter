//! The overlays on Windows with real windows (docs/RAIL-PLAN.md R3.4), in
//! CI on the Windows runner (its desktop session runs R3.3's test too).
//! Elsewhere this file is empty.
//!
//! The table simulator opens three PokerStars-like tables (6, 9 and 2
//! seats); the Windows backend, given the simulator's test-only room entry,
//! finds them and draws a panel for every seat. Then, per table: the
//! overlay window exists, is **owned by the table's window**, has the
//! layered / tool / no-activate styles (and not app-window or topmost),
//! covers exactly the table's client rect, and shows; its panels are where
//! the default layout puts the seats' panels - next to the simulator's
//! seat plates (`rail_hud_sim::draw::seat_center`, held equal to
//! `layout::seat_center`) - and a panel's pixels are the panel colour in
//! the surface and on the screen, composed over the table, while the
//! table's centre is transparent; a click at the table's centre reaches the
//! table, one on a panel the overlay. A minimised table hides its overlay,
//! a restored one shows it again, a moved one moves it without a repaint;
//! the same frame twice is painted once; a frame permitted for another room
//! is refused. Last, the HUD process itself (`rail-hud --standalone
//! --sim-site ...`): overlays on the three tables when the room is allowed,
//! **no overlay window at all** when it is not.
//!
//! `twelve_tables_perf` (ignored; CI runs it on its own with
//! `--ignored --nocapture`) measures paints and idle CPU with twelve
//! tables.
//!
//! A failure prints what the overlay thread knew, what the simulator said
//! and every window Windows reported.

#![cfg(windows)]

mod support;

use std::time::{Duration, Instant};

use rail_config::stats::Tone;
use rail_hud::compliance::Compliance;
use rail_hud::layout;
use rail_hud::panel::{PanelDesign, StatCell};
use rail_hud::platform::windows::{OVERLAY_CLASS, WindowsBackend, drive, ex_style, probe};
use rail_hud::platform::{
    OverlayFrame, PanelWords, Platform, Rect, SeatPanel, TableWindow, WindowId,
};
use rail_hud::scene::{self, PANEL};
use support::{Hud, Seen, Sim, find_until, listing, matcher, simulator, title_regex, wait_for};

/// The simulator's client size, logical pixels.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;

/// One test at a time: each starts its own simulator, and the test-only
/// room entry takes every simulator window on the desktop.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A frame with a panel on every seat: the default design's statistics,
/// one band each, full and dimmed.
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
        seating: rail_hud::platform::Seating::default(),
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
        legend: Vec::new(),
        design: PanelDesign::default(),
    }
}

/// The client rect `found` has, as the simulator said it.
fn client_of(seen: &Seen, number: u64) -> Option<Rect> {
    let event = seen.windows.get(&number)?;
    let int = |key: &str| event[key].as_i64().unwrap_or(i64::MIN);
    Some(Rect {
        x: i32::try_from(int("clientX")).ok()?,
        y: i32::try_from(int("clientY")).ok()?,
        width: u32::try_from(int("width")).ok()?,
        height: u32::try_from(int("height")).ok()?,
    })
}

fn three_tables(found: &[TableWindow], seen: &Seen) -> Result<(), String> {
    if found.len() != 3 {
        return Err(format!("{} tables found, 3 expected", found.len()));
    }
    for window in found {
        let number = seen
            .table_titled(&window.title)
            .ok_or_else(|| format!("{:?}: not a simulator table", window.title))?;
        if Some(window.client) != client_of(seen, number) || window.minimized {
            return Err(format!(
                "table {number}: {:?}, the simulator says {:?}",
                window.client,
                client_of(seen, number)
            ));
        }
    }
    Ok(())
}

/// A point of the panel's bottom margin, below its figures: only the
/// panel's own colour there.
fn margin_point(panel: &Rect) -> (u32, u32) {
    (
        u32::try_from(panel.x).unwrap_or(0) + panel.width / 2,
        u32::try_from(panel.y).unwrap_or(0) + panel.height - 2,
    )
}

/// The panel colour premultiplied, as the surface holds it.
fn panel_premultiplied() -> [u8; 4] {
    let p = |c: u8| u8::try_from(u32::from(c) * u32::from(PANEL.a) / 255).unwrap_or(0);
    [p(PANEL.b), p(PANEL.g), p(PANEL.r), PANEL.a]
}

fn near(a: u8, b: u8, tolerance: u8) -> bool {
    a.abs_diff(b) <= tolerance
}

#[test]
fn overlays_sit_on_their_tables() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let room = matcher("pokerstars", &regex);
    let mut sim = Sim::start(
        &sim_path,
        "overlay",
        &[
            "--tables",
            "3",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "0.5",
            "--seed",
            "11",
        ],
    );
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
        three_tables,
    );

    // Which test points no other window covers (the simulator's windows
    // may overlap on a small screen): only there can a click be expected
    // to reach the table or its overlay. Read before any overlay exists.
    let mut uncovered = Vec::new();
    for window in &found {
        let number = seen.table_titled(&window.title).expect("table");
        let seats = seen.tables[&number].2;
        let frame = frame("pokerstars", seats, 100);
        let (w, h) = (window.client.width, window.client.height);
        let expected = scene::compose(&frame, w, h, window.scale_permille, &PanelDesign::default());
        let centre = (w / 2, h * layout::TABLE_CENTER.1 / 1000);
        let margin = expected.panels.first().map(margin_point);
        let free = |(x, y): (u32, u32)| {
            probe::window_at(
                window.client.x + i32::try_from(x).unwrap_or(0),
                window.client.y + i32::try_from(y).unwrap_or(0),
            ) == Some(window.id)
        };
        uncovered.push((free(centre), margin.is_some_and(free)));
    }
    eprintln!("uncovered (centre, first panel) per table: {uncovered:?}");
    assert!(
        uncovered.iter().any(|&(c, p)| c && p),
        "every table is covered by another window\nwindows:\n{}",
        listing()
    );

    // A panel on every seat of every table.
    let mut frames = Vec::new();
    for window in &found {
        let number = seen.table_titled(&window.title).expect("table");
        let seats = seen.tables[&number].2;
        backend.track(window).expect("track");
        let frame = frame("pokerstars", seats, 100);
        backend.overlay(window.id, &frame).expect("overlay");
        frames.push((window.clone(), number, frame));
    }

    let mut screen_checked = None;
    for ((window, number, frame), (centre_free, panel_free)) in frames.iter().zip(&uncovered) {
        let info = wait_for(
            Duration::from_secs(10),
            "the overlay is painted",
            || match backend.overlay_info(window.id) {
                Some(info) if info.renders >= 1 && info.shown => Ok(info),
                other => Err(format!("table {number}: {other:?}")),
            },
        );
        eprintln!("table {number}: {info:?}");
        let overlay = info.window.expect("an overlay window");
        let context = || {
            format!(
                "table {number} {:#x}, overlay {:#x}: {info:?}\nwindows:\n{}",
                window.id.0,
                overlay.0,
                listing()
            )
        };

        // Owned by the table: above it, minimised and closed with it.
        assert_eq!(probe::owner(overlay), Some(window.id), "{}", context());
        // Layered, a tool window, never activated; not on the taskbar,
        // not above everything.
        let style = probe::ex_style(overlay);
        for (bit, name) in [
            (ex_style::LAYERED, "WS_EX_LAYERED"),
            (ex_style::TOOLWINDOW, "WS_EX_TOOLWINDOW"),
            (ex_style::NOACTIVATE, "WS_EX_NOACTIVATE"),
        ] {
            assert!(
                style & bit != 0,
                "{name} missing: {style:#x}; {}",
                context()
            );
        }
        for (bit, name) in [
            (ex_style::APPWINDOW, "WS_EX_APPWINDOW"),
            (ex_style::TOPMOST, "WS_EX_TOPMOST"),
        ] {
            assert!(style & bit == 0, "{name} set: {style:#x}; {}", context());
        }
        // Exactly over the client area, physical pixels.
        assert_eq!(
            probe::window_rect(overlay),
            Some(window.client),
            "{}",
            context()
        );
        assert!(probe::visible(overlay), "{}", context());
        assert_eq!(info.painted, (window.client.width, window.client.height));

        // Every seat's panel, where the default layout puts it: next to
        // the simulator's own seat plate.
        let (w, h) = (window.client.width, window.client.height);
        let expected = scene::compose(frame, w, h, window.scale_permille, &PanelDesign::default());
        assert!(info.dropped.is_empty(), "{}", context());
        assert_eq!(info.panels, expected.panels, "{}", context());
        let seats = frame.size.expect("size");
        assert_eq!(info.panels.len(), usize::try_from(seats).expect("seats"));
        for (seat, panel) in (1..=seats).zip(&info.panels) {
            let plate =
                layout::seat_plate(w, h, rail_hud_sim::draw::seat_center(seats, seat, None));
            let gap = layout::Metrics::for_client(h, window.scale_permille).gap + 1;
            let reach = i32::try_from(gap).unwrap_or(8);
            let around = Rect {
                x: plate.x - reach,
                y: plate.y - reach,
                width: plate.width + 2 * gap,
                height: plate.height + 2 * gap,
            };
            assert!(
                layout::intersects(panel, &around) && !layout::intersects(panel, &plate),
                "seat {seat}: panel {panel:?}, plate {plate:?}; {}",
                context()
            );
        }

        // The surface: the panel colour on a panel, nothing at the centre.
        let first = info.panels[0];
        let (px, py) = margin_point(&first);
        let pixel = backend.overlay_pixel(window.id, px, py).expect("a pixel");
        let want = panel_premultiplied();
        assert!(
            pixel.iter().zip(want).all(|(a, b)| near(*a, b, 3)),
            "panel pixel {pixel:?}, expected {want:?}; {}",
            context()
        );
        let (cx, cy) = (w / 2, h * layout::TABLE_CENTER.1 / 1000);
        assert_eq!(
            backend.overlay_pixel(window.id, cx, cy),
            Some([0, 0, 0, 0]),
            "the table's centre is transparent; {}",
            context()
        );
        // Some figure is drawn: a light pixel somewhere in the first row.
        let figures = (0..first.width).any(|dx| {
            (0..first.height / 2).any(|dy| {
                backend
                    .overlay_pixel(
                        window.id,
                        u32::try_from(first.x).unwrap_or(0) + dx,
                        u32::try_from(first.y).unwrap_or(0) + dy,
                    )
                    .is_some_and(|p| p[3] > 200 && p[0].max(p[1]).max(p[2]) > 120)
            })
        });
        assert!(figures, "no figure drawn in {first:?}; {}", context());

        // Clicks: the table's centre reaches the table, a panel the
        // overlay.
        let screen = |x: u32, y: u32| {
            (
                window.client.x + i32::try_from(x).unwrap_or(0),
                window.client.y + i32::try_from(y).unwrap_or(0),
            )
        };
        if *centre_free {
            let (sx, sy) = screen(cx, cy);
            assert_eq!(
                probe::window_at(sx, sy),
                Some(window.id),
                "a click at the table's centre ({sx}, {sy}); {}",
                context()
            );
        }
        if *panel_free {
            let (sx, sy) = screen(px, py);
            assert_eq!(
                probe::window_at(sx, sy),
                Some(overlay),
                "a click on a panel ({sx}, {sy}); {}",
                context()
            );
            screen_checked.get_or_insert((window.clone(), *number));
        }
    }

    // On screen: a panel's margin is the panel colour composed over what
    // the table draws there (read with the overlay hidden, then shown).
    let (window, number) = &screen_checked.expect("an uncovered panel");
    let info = backend.overlay_info(window.id).expect("info");
    let (px, py) = margin_point(&info.panels[0]);
    let (sx, sy) = (
        window.client.x + i32::try_from(px).expect("x"),
        window.client.y + i32::try_from(py).expect("y"),
    );
    // Hidden by hand (the backend places overlays from the table as it is,
    // R3.5, so it cannot be told the table is minimised when it is not);
    // nothing makes the overlay thread look at this table meanwhile.
    let overlay_window = info.window.expect("window");
    let mut last = String::new();
    let composed = (0..3).any(|_| {
        drive::show_window(overlay_window, false);
        wait_for(Duration::from_secs(5), "hidden for the screen read", || {
            if probe::visible(info.window.expect("window")) {
                Err("still visible".to_owned())
            } else {
                Ok(())
            }
        });
        std::thread::sleep(Duration::from_millis(300));
        let under = probe::screen_pixel(sx, sy);
        drive::show_window(overlay_window, true);
        wait_for(Duration::from_secs(5), "shown again", || {
            if probe::visible(info.window.expect("window")) {
                Ok(())
            } else {
                Err("not visible".to_owned())
            }
        });
        std::thread::sleep(Duration::from_millis(300));
        let over = probe::screen_pixel(sx, sy);
        let (Some(under), Some(over)) = (under, over) else {
            last = "the screen could not be read".to_owned();
            return false;
        };
        let a = u32::from(PANEL.a);
        let expect = |bg: u8, below: u8| {
            u8::try_from((u32::from(bg) * a + u32::from(below) * (255 - a)) / 255).unwrap_or(0)
        };
        let want = [
            expect(PANEL.r, under[0]),
            expect(PANEL.g, under[1]),
            expect(PANEL.b, under[2]),
        ];
        last = format!(
            "table {number} at ({sx}, {sy}): under {under:?}, over {over:?}, expected {want:?}"
        );
        eprintln!("screen: {last}");
        over.iter().zip(want).all(|(o, w)| near(*o, w, 6))
    });
    assert!(composed, "{last}\nwindows:\n{}", listing());

    // Minimised: hidden; restored: shown at the table again.
    let (window, number, _) = frames[1].clone();
    let overlay = backend
        .overlay_info(window.id)
        .and_then(|i| i.window)
        .expect("overlay");
    let renders = backend.overlay_info(window.id).expect("info").renders;
    sim.command(&format!("minimize {number}"));
    seen.until(&sim.events, Duration::from_secs(20), "the minimise", |s| {
        s.windows
            .get(&number)
            .is_some_and(|e| e["minimized"].as_bool() == Some(true))
    });
    let minimised = find_until(
        &mut backend,
        &room,
        &mut seen,
        &sim.events,
        "the minimised table",
        |found, _| match found.iter().find(|w| w.id == window.id) {
            Some(w) if w.minimized => Ok(()),
            other => Err(format!("{other:?}")),
        },
    );
    let table = minimised
        .iter()
        .find(|w| w.id == window.id)
        .expect("table")
        .clone();
    backend.follow(&table);
    wait_for(
        Duration::from_secs(10),
        "hidden while minimised",
        || match backend.overlay_info(window.id) {
            Some(info) if !info.shown && !probe::visible(overlay) => Ok(()),
            other => Err(format!("{other:?}")),
        },
    );
    sim.command(&format!("restore {number}"));
    seen.until(&sim.events, Duration::from_secs(20), "the restore", |s| {
        s.windows
            .get(&number)
            .is_some_and(|e| e["minimized"].as_bool() == Some(false))
    });
    let restored = find_until(
        &mut backend,
        &room,
        &mut seen,
        &sim.events,
        "the restored table",
        |found, _| match found.iter().find(|w| w.id == window.id) {
            Some(w) if !w.minimized && w.client.width > 0 => Ok(()),
            other => Err(format!("{other:?}")),
        },
    );
    let table = restored
        .iter()
        .find(|w| w.id == window.id)
        .expect("table")
        .clone();
    backend.follow(&table);
    wait_for(
        Duration::from_secs(10),
        "shown again on its table",
        || match backend.overlay_info(window.id) {
            Some(info) if info.shown && probe::window_rect(overlay) == Some(table.client) => Ok(()),
            other => Err(format!("{other:?} at {:?}", probe::window_rect(overlay))),
        },
    );

    // Moved: the overlay follows without being painted again.
    let renders_before_move = backend.overlay_info(window.id).expect("info").renders;
    sim.command(&format!(
        "move {number} {} {}",
        table.client.x + 37,
        table.client.y + 23
    ));
    let moved = find_until(
        &mut backend,
        &room,
        &mut seen,
        &sim.events,
        "the moved table",
        |found, _| match found.iter().find(|w| w.id == window.id) {
            Some(w) if w.client != table.client && w.client.width == table.client.width => Ok(()),
            other => Err(format!("{other:?}")),
        },
    );
    let table = moved
        .iter()
        .find(|w| w.id == window.id)
        .expect("table")
        .clone();
    backend.follow(&table);
    wait_for(Duration::from_secs(10), "the overlay moved with it", || {
        if probe::window_rect(overlay) == Some(table.client) {
            Ok(())
        } else {
            Err(format!(
                "{:?} vs {:?}",
                probe::window_rect(overlay),
                table.client
            ))
        }
    });
    let info = backend.overlay_info(window.id).expect("info");
    assert_eq!(info.renders, renders_before_move, "a move is not a repaint");
    assert!(info.renders >= renders, "{info:?}");

    // The same frame twice is painted once; a new one is painted.
    let same = frame("pokerstars", seen.tables[&number].2, 100);
    backend.overlay(window.id, &same).expect("overlay");
    let info = backend.overlay_info(window.id).expect("info");
    assert_eq!(
        info.renders, renders_before_move,
        "the same frame: no paint"
    );
    let newer = frame("pokerstars", seen.tables[&number].2, 101);
    backend.overlay(window.id, &newer).expect("overlay");
    let info = backend.overlay_info(window.id).expect("info");
    assert_eq!(
        info.renders,
        renders_before_move + 1,
        "a new frame: one paint"
    );

    // A frame permitted for another room is refused; so is a window that
    // is not tracked.
    let other_room = frame("winamax", 6, 1);
    assert!(backend.overlay(window.id, &other_room).is_err());
    assert!(backend.overlay(WindowId(1), &newer).is_err());

    // Removed: the window is gone.
    backend.remove_overlay(window.id);
    wait_for(Duration::from_secs(5), "the overlay is destroyed", || {
        if backend.overlay_info(window.id).is_none() && !probe::visible(overlay) {
            Ok(())
        } else {
            Err("still there".to_owned())
        }
    });
    drop(sim);
}

/// The HUD process: overlays on an allowed room's tables, owned by them;
/// on a prohibited room's, no overlay window at all.
#[test]
fn the_hud_draws_only_on_allowed_rooms() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let sim = Sim::start(
        &sim_path,
        "overlay-hud",
        &[
            "--tables",
            "3",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "0.5",
            "--seed",
            "12",
        ],
    );
    let mut seen = Seen::default();
    seen.until(
        &sim.events,
        Duration::from_secs(90),
        "3 shown windows",
        |s| s.tables.len() == 3 && s.windows.len() == 3,
    );
    let sim_pid = sim.child.id();
    let sim_windows: Vec<WindowId> = probe::windows_of(sim_pid)
        .into_iter()
        .map(|(id, _)| id)
        .collect();

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
    let overlays = wait_for(Duration::from_secs(15), "three overlay windows", || {
        let overlays: Vec<WindowId> = probe::windows_of(pid)
            .into_iter()
            .filter(|(id, class)| class == OVERLAY_CLASS && probe::visible(*id))
            .map(|(id, _)| id)
            .collect();
        if overlays.len() == 3 {
            Ok(overlays)
        } else {
            Err(format!(
                "{} shown: {:?}\n{}",
                overlays.len(),
                probe::windows_of(pid),
                hud.log()
            ))
        }
    });
    for overlay in &overlays {
        let owner = probe::owner(*overlay);
        assert!(
            owner.is_some_and(|o| sim_windows.contains(&o)),
            "{overlay:?} is owned by {owner:?}, not a table; the tables: {sim_windows:?}"
        );
    }
    eprintln!("rail-hud (pokerstars):\n{}", hud.log());
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
    // Give it time to do whatever it would.
    hud.until("never printed", 1, Duration::from_secs(2));
    let pid = hud.child.id();
    let windows = probe::windows_of(pid);
    assert!(
        !windows.iter().any(|(_, class)| class == OVERLAY_CLASS),
        "an overlay window on a prohibited room: {windows:?}\n{}",
        hud.log()
    );
    assert!(!hud.log().contains("attached to window"), "{}", hud.log());
    eprintln!("rail-hud (ggpoker):\n{}", hud.log());
    drop(sim);
}

/// `cpu` as a percentage of one core over `over`, two decimals.
fn percent(cpu: Duration, over: Duration) -> String {
    let hundredths = cpu.as_micros() * 10_000 / over.as_micros().max(1);
    format!("{}.{:02} %", hundredths / 100, hundredths % 100)
}

fn percentile(sorted: &[u64], p: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

/// Twelve tables (R3.4's budget, R3.14's exit): every table's overlay
/// painted 20 times with new figures - each paint timed - then the
/// overlays left alone for ten seconds (this process's CPU over that time),
/// then the HUD process attached to all twelve and idle for ten seconds
/// (its CPU). Printed as `R3.4 perf: ...`; a paint's p95 must stay under
/// 16 ms.
#[test]
#[ignore = "a measurement: CI runs it on its own (--ignored --nocapture)"]
fn twelve_tables_perf() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let room = matcher("pokerstars", &regex);
    let sim = Sim::start(
        &sim_path,
        "overlay-perf",
        &[
            "--tables",
            "12",
            "--sizes",
            "9,6",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "0.5",
            "--seed",
            "13",
        ],
    );
    let mut seen = Seen::default();
    seen.until(
        &sim.events,
        Duration::from_secs(180),
        "12 shown windows",
        |s| s.tables.len() == 12 && s.windows.len() == 12,
    );
    let mut backend = WindowsBackend::default();
    let found = find_until(
        &mut backend,
        &room,
        &mut seen,
        &sim.events,
        "twelve tables",
        |found, _| {
            if found.len() == 12 {
                Ok(())
            } else {
                Err(format!("{} found", found.len()))
            }
        },
    );
    for window in &found {
        backend.track(window).expect("track");
    }
    let started = Instant::now();
    for round in 0..20 {
        for window in &found {
            let number = seen.table_titled(&window.title).expect("table");
            let seats = seen.tables[&number].2;
            backend
                .overlay(window.id, &frame("pokerstars", seats, round * 13))
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
    let before = probe::cpu_time(me).expect("cpu");
    std::thread::sleep(Duration::from_secs(10));
    let idle = probe::cpu_time(me).expect("cpu").saturating_sub(before);

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
    let hud_before = probe::cpu_time(pid).expect("cpu");
    std::thread::sleep(Duration::from_secs(10));
    let hud_idle = probe::cpu_time(pid)
        .expect("cpu")
        .saturating_sub(hud_before);
    let surfaces: u64 = found
        .iter()
        .map(|w| u64::from(w.client.width) * u64::from(w.client.height) * 4)
        .sum();
    println!(
        "R3.4 perf: {} paints of 12 tables (6- and 9-max, {}x{} logical, scale {}): \
         p50 {p50} us, p95 {p95} us, max {max} us; 240 frames handed over and painted in \
         {} ms; overlays idle 10 s: this process {} ms CPU ({} of one core); rail-hud \
         attached to 12 tables, idle 10 s: {} ms CPU ({} of one core); surfaces {} KiB",
        times.len(),
        WIDTH,
        HEIGHT,
        found[0].scale_permille,
        wall.as_millis(),
        idle.as_millis(),
        percent(idle, Duration::from_secs(10)),
        hud_idle.as_millis(),
        percent(hud_idle, Duration::from_secs(10)),
        surfaces / 1024
    );
    assert!(p95 < 16_000, "a paint's p95 is {p95} us, over 16 ms");
    drop(hud);
    drop(sim);
}
