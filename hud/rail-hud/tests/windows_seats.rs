//! Seats and layouts on Windows with real windows (docs/RAIL-PLAN.md R3.6),
//! in CI on the Windows runner. Elsewhere this file is empty.
//!
//! - `panels_sit_at_the_drawn_seats`: the table simulator's tables (6, 9
//!   and 2 seats), with `--preferred-seat` off and on; the backend draws a
//!   panel on every seat with the hero's rotation as the HUD computes it
//!   (`rail_hud::seats`). Every panel is next to the plate the simulator
//!   itself draws for that seat (`rail_hud_sim::draw::seat_center` with the
//!   simulator's own rotation), and the screen shows the simulator's gold
//!   hero frame where the HUD puts the hero's seat - at the bottom when it
//!   rotates.
//! - `acr_keeps_a_dragged_panel_off_its_graphics`: a panel dragged (the
//!   mouse messages posted to the overlay, as the system queues a real
//!   drag's) onto the board: posing as ACR (`noOverlapTableGraphics`) it
//!   lands at the nearest place clear of every seat plate and the board,
//!   posing as PokerStars where it was dropped; each drop is one
//!   `PanelMoved` for the engine, and a frame that carries the position
//!   keeps it there.
//! - `a_dragged_panel_is_remembered`: the HUD process under the real
//!   supervisor (this test plays the app: the store, `hand_imported`), the
//!   simulator with `--preferred-seat` and the user's "my client rotates"
//!   in the store; the hero's panel is dragged, the HUD says
//!   `seat_position_changed`, the app's call writes the store, the panel is
//!   at its new place (a click there reaches the overlay, its old place the
//!   table); the HUD restarted puts it there again from the store.
//!
//! Every step prints what it saw (`step ok: ...`); a failure prints what
//! the overlay thread knew, what the simulator said and every window.

#![cfg(windows)]

mod support;

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::layout::{self, Positions, TableLayout};
use rail_hud::panel::{PanelDesign, StatCell};
use rail_hud::platform::windows::{OVERLAY_CLASS, WindowsBackend, drive, probe};
use rail_hud::platform::{
    OverlayFrame, Platform, Rect, SeatPanel, Seating, TableEvent, TableWindow, WindowId,
};
use rail_hud::scene;
use rail_hud::seats;
use rail_hud_ipc::protocol::{AppMessage, HudMessage, PlayerRef};
use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
use serde_json::Value;
use support::{Seen, Sim, find_until, listing, matcher, simulator, title_regex, wait_for};

/// The simulator's client size, logical pixels.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;

/// The simulator's frame around the hero's seat (`draw::HERO`), RGB.
const HERO: [u8; 3] = [0xd4, 0xa0, 0x17];

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn cells() -> Vec<StatCell> {
    PanelDesign::default()
        .stats
        .iter()
        .map(|s| StatCell {
            id: s.id.clone(),
            text: "24".into(),
            tone: None,
            opacity_permille: 1000,
        })
        .collect()
}

/// A frame with a panel on each of `seats`, the hero's rotation given.
fn frame(site: &str, size: u32, seats: &[u32], rotate_to: Option<u32>) -> OverlayFrame {
    let permit = Compliance::shipped()
        .expect("shipped")
        .permit(site)
        .expect("permitted");
    OverlayFrame {
        permit,
        status: None,
        size: Some(size),
        seating: Seating {
            rotate_to,
            ..Seating::default()
        },
        panels: seats
            .iter()
            .map(|&seat| SeatPanel {
                player: format!("Player{seat}"),
                seat: Some(seat),
                hands: 50,
                stats: cells(),
                label: None,
            })
            .collect(),
    }
}

fn middle(r: &Rect) -> (i32, i32) {
    (
        r.x + i32::try_from(r.width / 2).unwrap_or(0),
        r.y + i32::try_from(r.height / 2).unwrap_or(0),
    )
}

fn near(a: [u8; 3], b: [u8; 3], tolerance: u8) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= tolerance)
}

/// `panel` is within the gap (+1) of `plate` and does not cover it.
fn next_to(panel: &Rect, plate: &Rect, gap: u32) -> bool {
    let reach = i32::try_from(gap + 1).unwrap_or(8);
    let around = Rect {
        x: plate.x - reach,
        y: plate.y - reach,
        width: plate.width + 2 * (gap + 1),
        height: plate.height + 2 * (gap + 1),
    };
    layout::intersects(panel, &around) && !layout::intersects(panel, plate)
}

/// The simulator's tables, found, each with its hero seat and a hand
/// drawn (so the hero's plate has its frame).
fn tables_with_hands(
    backend: &mut WindowsBackend,
    sim: &Sim,
    room: &rail_hud::platform::TableMatcher,
    seen: &mut Seen,
    count: usize,
) -> Vec<TableWindow> {
    seen.until(
        &sim.events,
        Duration::from_secs(90),
        &format!("{count} windows, each with its hero seat and a hand"),
        |s| {
            s.tables.len() == count
                && s.windows.len() == count
                && s.heroes.len() == count
                && s.hands.len() == count
        },
    );
    find_until(
        backend,
        room,
        seen,
        &sim.events,
        "the tables",
        |found, seen| {
            if found.len() != count {
                return Err(format!("{} found, {count} expected", found.len()));
            }
            for window in found {
                if seen.table_titled(&window.title).is_none() {
                    return Err(format!("{:?}: not a simulator table", window.title));
                }
            }
            Ok(())
        },
    )
}

#[test]
fn panels_sit_at_the_drawn_seats() {
    let _serial = serial();
    for preferred in [false, true] {
        drawn_seats(preferred);
    }
}

fn drawn_seats(preferred: bool) {
    eprintln!("--- preferred seat {preferred}");
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let room = matcher("pokerstars", &regex);
    let window = format!("{WIDTH}x{HEIGHT}");
    let mut args = vec![
        "--tables", "3", "--sizes", "6,9,2", "--window", &window, "--speed", "60", "--seed", "23",
    ];
    if preferred {
        args.push("--preferred-seat");
    }
    let sim = Sim::start(
        &sim_path,
        if preferred { "seats-on" } else { "seats-off" },
        &args,
    );
    let mut seen = Seen::default();
    let mut backend = WindowsBackend::default();
    let found = tables_with_hands(&mut backend, &sim, &room, &mut seen, 3);

    for window in &found {
        let number = seen.table_titled(&window.title).expect("table");
        let size = seen.tables[&number].2;
        let hero = seen.heroes[&number];
        let rotate_to = preferred.then_some(hero);
        let seats: Vec<u32> = (1..=size).collect();
        backend.track(window).expect("track");
        backend
            .overlay(window.id, &frame("pokerstars", size, &seats, rotate_to))
            .expect("overlay");
        let info = wait_for(
            Duration::from_secs(10),
            &format!("table {number} ({size} seats, hero {hero}) painted"),
            || match backend.overlay_info(window.id) {
                Some(info) if info.renders >= 1 && info.shown => Ok(info),
                other => Err(format!("{other:?}")),
            },
        );
        eprintln!("table {number}: size {size}, hero {hero}, {info:?}");
        let context = || {
            format!(
                "table {number} (size {size}, hero {hero}, preferred {preferred}): {info:?}\nthe simulator said:\n{}\nwindows:\n{}",
                seen.log.join("\n"),
                listing()
            )
        };
        let (w, h) = (window.client.width, window.client.height);
        let gap = layout::Metrics::for_client(h, window.scale_permille).gap;
        let table = TableLayout::simulator(size);
        assert_eq!(info.size, size, "{}", context());
        assert_eq!(
            info.seat_panels.len(),
            usize::try_from(size).expect("size"),
            "{}",
            context()
        );
        for seat in 1..=size {
            // Where the simulator draws the seat, by its own rotation.
            let drawn = rail_hud_sim::draw::seat_center(size, seat, rotate_to);
            let plate = layout::seat_plate(w, h, drawn);
            // Where the HUD puts it.
            let slot = seats::slot_of(&table, seat, rotate_to).expect("a slot");
            assert_eq!(table.slot_center(slot), Some(drawn), "{}", context());
            let panel = info
                .seat_panels
                .iter()
                .find(|(s, _)| *s == slot)
                .map(|(_, r)| *r)
                .unwrap_or_else(|| panic!("no panel at slot {slot}; {}", context()));
            assert!(
                next_to(&panel, &plate, gap),
                "seat {seat} (slot {slot}): panel {panel:?}, plate {plate:?}; {}",
                context()
            );
        }
        eprintln!("step ok: table {number}: every panel next to the simulator's seat");

        // The hero's plate on the screen: the simulator's gold frame, where
        // the HUD puts the hero's seat (the bottom when it rotates).
        let hero_slot = seats::slot_of(&table, hero, rotate_to).expect("hero slot");
        if preferred {
            assert_eq!(hero_slot, 0, "{}", context());
        }
        let plate = table.plate(w, h, hero_slot).expect("plate");
        let (x, y) = (
            window.client.x + plate.x + i32::try_from(plate.width / 2).unwrap_or(0),
            window.client.y + plate.y,
        );
        drive::raise(window.id).expect("raise");
        let pixel = wait_for(
            Duration::from_secs(5),
            &format!("table {number}: the hero's frame at ({x}, {y})"),
            || {
                if probe::window_at(x, y) != Some(window.id) {
                    return Err(format!(
                        "covered by {:?}",
                        probe::window_at(x, y).map(|w| w.0)
                    ));
                }
                let pixel = probe::screen_pixel(x, y).ok_or("no pixel")?;
                let below = probe::screen_pixel(x, y + 1).ok_or("no pixel")?;
                if near(pixel, HERO, 8) || near(below, HERO, 8) {
                    Ok(pixel)
                } else {
                    Err(format!("{pixel:?} / {below:?}, expected {HERO:?}"))
                }
            },
        );
        eprintln!("step ok: table {number}: hero frame {pixel:?} at slot {hero_slot}");
    }
    for window in &found {
        backend.untrack(window.id);
    }
    drop(sim);
}

/// The overlay's seat panel at `slot` now.
fn panel_at(backend: &WindowsBackend, id: WindowId, slot: u32) -> Option<Rect> {
    backend
        .overlay_info(id)?
        .seat_panels
        .into_iter()
        .find(|(s, _)| *s == slot)
        .map(|(_, r)| r)
}

#[test]
fn acr_keeps_a_dragged_panel_off_its_graphics() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    for (site, clear) in [("acr", true), ("pokerstars", false)] {
        eprintln!("--- posing as {site}");
        let room = matcher(site, &regex);
        let window = format!("{WIDTH}x{HEIGHT}");
        let sim = Sim::start(
            &sim_path,
            &format!("drag-{site}"),
            &[
                "--tables", "1", "--sizes", "6", "--window", &window, "--speed", "60", "--seed",
                "31",
            ],
        );
        let mut seen = Seen::default();
        let mut backend = WindowsBackend::default();
        let found = tables_with_hands(&mut backend, &sim, &room, &mut seen, 1);
        let window = &found[0];
        let (w, h) = (window.client.width, window.client.height);
        backend.track(window).expect("track");
        let six = frame(site, 6, &[1, 2, 3, 4, 5, 6], None);
        backend.overlay(window.id, &six).expect("overlay");
        let info = wait_for(Duration::from_secs(10), "painted", || {
            match backend.overlay_info(window.id) {
                Some(info) if info.renders >= 1 && info.shown => Ok(info),
                other => Err(format!("{other:?}")),
            }
        });
        let overlay = info.window.expect("an overlay window");
        let before = panel_at(&backend, window.id, 0).expect("slot 0's panel");
        // Onto the board, at the table's centre.
        let from = middle(&before);
        let to = (
            i32::try_from(w / 2).unwrap_or(0),
            i32::try_from(h * layout::TABLE_CENTER.1 / 1000).unwrap_or(0),
        );
        let started = Instant::now();
        drive::drag(overlay, from, to, 10).expect("the drag's messages");
        let info = wait_for(Duration::from_secs(10), "the drop", || {
            match backend.overlay_info(window.id) {
                Some(info) if info.drags >= 1 => Ok(info),
                other => Err(format!("{other:?}")),
            }
        });
        eprintln!("{site}: dropped in {:?}: {info:?}", started.elapsed());
        let after = panel_at(&backend, window.id, 0).expect("slot 0's panel");
        assert!(info.placed_by_user.contains(&0), "{info:?}");
        assert_ne!(after, before, "the panel moved");
        let graphics = layout::table_graphics(w, h, 6);
        let covers = graphics.iter().any(|g| layout::intersects(&after, g));
        assert_eq!(
            covers, !clear,
            "{site}: {after:?} against {graphics:?}; {info:?}"
        );
        assert!(layout::inside(&after, w, h));
        if !clear {
            // Where the pointer took it (within the thousandths' pixel).
            let (mx, my) = middle(&after);
            assert!(
                (mx - to.0).abs() <= 2 && (my - to.1).abs() <= 2,
                "{after:?}"
            );
        }
        eprintln!("step ok: {site}: the dropped panel {after:?} (covers graphics: {covers})");

        // The engine hears the drop once, with where the panel is.
        let events = wait_for(Duration::from_secs(5), "the PanelMoved event", || {
            let events = backend.poll_events();
            if events
                .iter()
                .any(|e| matches!(e, TableEvent::PanelMoved { .. }))
            {
                Ok(events)
            } else {
                Err(format!("{events:?}"))
            }
        });
        let moved: Vec<&TableEvent> = events
            .iter()
            .filter(|e| matches!(e, TableEvent::PanelMoved { .. }))
            .collect();
        assert_eq!(moved.len(), 1, "{events:?}");
        let TableEvent::PanelMoved {
            id,
            size,
            slot,
            x,
            y,
            seq,
        } = *moved[0]
        else {
            unreachable!()
        };
        assert_eq!((id, size, slot), (window.id, 6, 0));
        let shown = layout::center_permille(&after, w, h);
        assert!(
            x.abs_diff(shown.0) <= 2 && y.abs_diff(shown.1) <= 2,
            "({x}, {y}) vs {shown:?}"
        );
        eprintln!("step ok: {site}: PanelMoved slot 0 at ({x}, {y}), seq {seq}");

        // The engine's frame with the position: the panel stays.
        let mut kept = six.clone();
        let mut positions = Positions::new();
        positions.insert(0, (x, y));
        kept.seating.positions = positions;
        kept.seating.drags_seen = seq;
        backend.overlay(window.id, &kept).expect("overlay");
        let info = wait_for(
            Duration::from_secs(5),
            "the kept frame painted",
            || match backend.overlay_info(window.id) {
                Some(info) if info.placed_by_user == [0] => Ok(info),
                other => Err(format!("{other:?}")),
            },
        );
        let again = panel_at(&backend, window.id, 0).expect("slot 0's panel");
        assert!(
            (again.x - after.x).abs() <= 1 && (again.y - after.y).abs() <= 1,
            "{again:?} vs {after:?}; {info:?}"
        );
        eprintln!("step ok: {site}: the frame keeps it at {again:?}");

        // A click (no move) is not a drag.
        let (cx, cy) = middle(&again);
        drive::drag(overlay, (cx, cy), (cx + 1, cy), 1).expect("a click");
        std::thread::sleep(Duration::from_millis(300));
        let info = backend.overlay_info(window.id).expect("info");
        assert_eq!(info.drags, 1, "a click is not a drag: {info:?}");
        assert!(
            !backend
                .poll_events()
                .iter()
                .any(|e| matches!(e, TableEvent::PanelMoved { .. }))
        );
        eprintln!("step ok: {site}: a click moved nothing");
        backend.untrack(window.id);
        drop(sim);
    }
}

/// The app's half for the process test: the store, the supervisor and
/// what the HUD said.
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
        app.until(Duration::from_secs(30), "the HUD connects", |e, _| {
            matches!(e, Event::Connected { .. })
        });
        app
    }

    /// Read the HUD's events until `done` says so.
    fn until(
        &mut self,
        timeout: Duration,
        what: &str,
        mut done: impl FnMut(&Event, &[HudMessage]) -> bool,
    ) -> Event {
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
                if done(&event, &self.said) {
                    eprintln!("step ok: {what}");
                    return event;
                }
            }
        }
    }

    /// `hand_imported` for the simulator's `hand` event, as the app sends
    /// it (its seats, the hero).
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
            })
            .collect();
        self.supervisor.send(AppMessage::HandImported {
            site: hand["site"].as_str().unwrap_or_default().to_owned(),
            table: hand["tableName"].as_str().map(str::to_owned),
            hand_key: hand["handKey"].as_str().unwrap_or_default().to_owned(),
            players,
        });
    }

    fn pid(&self) -> u32 {
        self.supervisor.status().pid.expect("a HUD process")
    }
}

/// The HUD process's overlay over `table`.
fn overlay_of(pid: u32, table: WindowId) -> Option<WindowId> {
    probe::windows_of(pid)
        .into_iter()
        .find(|(w, class)| class == OVERLAY_CLASS && probe::owner(*w) == Some(table))
        .map(|(w, _)| w)
}

/// What the HUD process paints over `window` for `hand` (its seats, the
/// hero's rotation, the user's positions): the same layout code.
fn expected_scene(window: &TableWindow, hand: &Value, positions: &Positions) -> scene::Scene {
    let seated: Vec<(u32, bool)> = hand["seated"]
        .as_array()
        .expect("seated")
        .iter()
        .map(|p| {
            (
                u32::try_from(p["seat"].as_u64().unwrap_or(0)).unwrap_or(0),
                p["hero"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    let hero = seated.iter().find(|(_, h)| *h).map(|(s, _)| *s);
    let seats: Vec<u32> = seated.iter().map(|(s, _)| *s).collect();
    let mut frame = frame("pokerstars", 6, &seats, hero);
    frame.seating.positions = positions.clone();
    scene::compose(
        &frame,
        window.client.width,
        window.client.height,
        window.scale_permille,
        &PanelDesign::default(),
    )
}

/// Whether a click at client point `at` of `window` reaches `target`.
fn reaches(window: &TableWindow, at: (i32, i32), target: WindowId) -> Result<(), String> {
    let hit = probe::window_at(window.client.x + at.0, window.client.y + at.1);
    if hit == Some(target) {
        Ok(())
    } else {
        Err(format!(
            "({}, {}) reaches {:?}",
            at.0,
            at.1,
            hit.map(|w| w.0)
        ))
    }
}

#[test]
fn a_dragged_panel_is_remembered() {
    let _serial = serial();
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let room = matcher("pokerstars", &regex);

    // The app's store: the user says their client rotates.
    let dir: PathBuf = std::env::temp_dir().join(format!("rail-hud-seats-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = dir.join(rail_store::FILE_NAME);
    let store = rail_store::Store::open(&db).expect("store");
    let writer = store.writer().expect("writer");
    writer
        .set_hud_preferred_seat("pokerstars", Some(true))
        .expect("preferred seat");

    let window_size = format!("{WIDTH}x{HEIGHT}");
    let sim = Sim::start(
        &sim_path,
        "remembered",
        &[
            "--tables",
            "1",
            "--sizes",
            "6",
            "--window",
            &window_size,
            "--speed",
            "6",
            "--seed",
            "41",
            "--preferred-seat",
        ],
    );
    let mut seen = Seen::default();
    let mut finder = WindowsBackend::default();
    let found = tables_with_hands(&mut finder, &sim, &room, &mut seen, 1);
    let window = found[0].clone();
    let number = seen.table_titled(&window.title).expect("table");
    drive::raise(window.id).expect("raise");

    let mut app = App::start(&db, &regex);
    app.until(Duration::from_secs(20), "one table attached", |e, _| {
        matches!(e, Event::Message(HudMessage::TablesOpen { count: 1 }, _))
    });
    seen.drain(&sim.events);
    let hand = seen.hands[&number].clone();
    app.hand(&hand);
    app.until(Duration::from_secs(20), "the hand drawn", |e, _| {
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
    let pid = app.pid();
    let overlay = wait_for(Duration::from_secs(10), "the HUD's overlay", || {
        overlay_of(pid, window.id).ok_or_else(|| format!("{:?}", probe::windows_of(pid)))
    });

    // The hero's panel: slot 0 (the client rotates), at the bottom.
    let scene = expected_scene(&window, &hand, &Positions::new());
    let (_, hero_panel) = scene
        .seat_panels
        .iter()
        .find(|(slot, _)| *slot == 0)
        .copied()
        .expect("the hero's panel");
    let from = middle(&hero_panel);
    wait_for(
        Duration::from_secs(10),
        "the hero's panel takes clicks",
        || reaches(&window, from, overlay),
    );

    // Drag it up, onto the felt between its seat and the board (clear of
    // every plate and of the other panels).
    let (w, h) = (window.client.width, window.client.height);
    let to = (
        from.0,
        from.1 - i32::try_from(h * 212 / 1000).unwrap_or(100),
    );
    drive::drag(overlay, from, to, 12).expect("the drag's messages");
    let said = app.until(Duration::from_secs(10), "seat_position_changed", |e, _| {
        matches!(e, Event::Message(HudMessage::SeatPositionChanged { .. }, _))
    });
    let Event::Message(
        HudMessage::SeatPositionChanged {
            site,
            size,
            slot,
            x,
            y,
        },
        _,
    ) = said
    else {
        unreachable!()
    };
    assert_eq!((site.as_str(), size, slot), ("pokerstars", 6, 0));
    let moved = Rect {
        x: hero_panel.x + (to.0 - from.0),
        y: hero_panel.y + (to.1 - from.1),
        ..hero_panel
    };
    let wanted = layout::center_permille(&moved, w, h);
    assert!(
        x.abs_diff(wanted.0) <= 2 && y.abs_diff(wanted.1) <= 2,
        "({x}, {y}) vs {wanted:?}"
    );
    eprintln!("step ok: the HUD said slot 0 of a 6-seat pokerstars table is at ({x}, {y})");

    // The app's call: written to the store.
    writer
        .set_hud_seat_position(&site, size, slot, x, y)
        .expect("the app writes");
    let stored = store.reader().hud_seat_positions().expect("read");
    assert_eq!(stored.len(), 1);
    eprintln!("step ok: stored {stored:?}");

    // On the screen: the panel at its new place, the old one is the table.
    let mut positions = Positions::new();
    positions.insert(0, (x, y));
    let placed = expected_scene(&window, &hand, &positions);
    let (_, new_panel) = placed
        .seat_panels
        .iter()
        .find(|(s, _)| *s == 0)
        .copied()
        .expect("slot 0");
    wait_for(
        Duration::from_secs(5),
        "a click at the new place reaches the panel",
        || reaches(&window, middle(&new_panel), overlay),
    );
    wait_for(
        Duration::from_secs(5),
        "a click at the old place reaches the table",
        || reaches(&window, from, window.id),
    );

    // The HUD restarted: from the store, the panel is there again.
    app.supervisor.stop();
    wait_for(
        Duration::from_secs(10),
        "the old HUD's overlay gone",
        || {
            if overlay_of(pid, window.id).is_none() {
                Ok(())
            } else {
                Err("still there".into())
            }
        },
    );
    let mut app = App::start(&db, &regex);
    app.until(
        Duration::from_secs(20),
        "one table attached again",
        |e, _| matches!(e, Event::Message(HudMessage::TablesOpen { count: 1 }, _)),
    );
    app.hand(&hand);
    app.until(Duration::from_secs(20), "the hand drawn again", |e, _| {
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
    let pid = app.pid();
    let overlay = wait_for(Duration::from_secs(10), "the new HUD's overlay", || {
        overlay_of(pid, window.id).ok_or_else(|| format!("{:?}", probe::windows_of(pid)))
    });
    wait_for(
        Duration::from_secs(10),
        "restored: the new place reaches the panel",
        || reaches(&window, middle(&new_panel), overlay),
    );
    wait_for(
        Duration::from_secs(5),
        "restored: the old place reaches the table",
        || reaches(&window, from, window.id),
    );
    app.supervisor.stop();
    drop(writer);
    store.close();
    drop(sim);
    let _ = std::fs::remove_dir_all(&dir);
}
