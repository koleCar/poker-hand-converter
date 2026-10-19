//! Finding tables on macOS with real windows (docs/RAIL-PLAN.md R3.11), in
//! CI on the macOS runner (it has a window server session; the job's
//! windowed simulator smoke step runs there too) and on a developer's Mac.
//! Elsewhere this file is empty.
//!
//! The table simulator opens three windows of PokerStars-like tables at a
//! fixed logical size. Two paths, by what this test process may do:
//!
//! - **Always - the window server alone** (no permission needed): the
//!   simulator's process has exactly three ordinary on-screen windows in
//!   `CGWindowListCopyWindowInfo`, whose bounds times their screen's
//!   backing scale are exactly the frames the simulator reports (winit's
//!   physical positions); then the backend's join (`macos::assemble`) of
//!   those real windows with accessibility windows *made from the
//!   simulator's own events* (titles for identity, frames, a title bar
//!   where the simulator says its client area starts) gives three tables
//!   with the hands' table names and client rects equal to the simulator's.
//! - **With the Accessibility permission** (the test's responsible
//!   process - the terminal, or the CI runner - has it): the backend finds
//!   exactly those three by itself (titles through `AXTitle`), client rects
//!   equal to the simulator's own; a minimised table is found and marked; a
//!   tournament-style table move retitles the same window; `rail-hud
//!   --list-windows` lists the three, redacted; `rail-hud --standalone
//!   --sim-site ...` attaches to them (an allowed room) or refuses them (a
//!   prohibited one).
//! - **Without it**: the backend refuses to find (`PermissionNeeded`) and
//!   says so (`permission_needed`, the HUD's health answer); `--list-windows`
//!   says it is not granted and shows no title; the HUD process says why it
//!   finds nothing. The test prints what it skipped. It never asks for the
//!   permission (no prompt, no setting changed).
//!
//! Everything found is printed when an assertion fails.

#![cfg(target_os = "macos")]

mod support;

use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud as Engine, Settings};
use rail_hud::platform::macos::{
    self, AxWindow, CgWindow, Frame, MacosBackend, Snapshot, assemble,
};
use rail_hud::platform::matcher::same_process;
use rail_hud::platform::{
    Permission, Platform, PlatformError, TableMatcher, TableWindow, table_key, table_of,
};
use serde_json::Value;
use support::{Hud, Seen, Sim, find_until, listing, matcher, simulator, title_regex};

/// The client size asked of the simulator, in points (winit's logical
/// size).
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;

fn int(event: &Value, key: &str) -> i64 {
    event[key].as_i64().unwrap_or(i64::MIN)
}

/// The simulator's ordinary on-screen windows, front to back.
fn sim_windows(pid: u32) -> Vec<CgWindow> {
    macos::cg_windows()
        .unwrap_or_else(|e| panic!("the window list: {e}"))
        .into_iter()
        .filter(|w| w.pid == pid && w.layer == 0 && w.onscreen)
        .collect()
}

/// The window server's window whose frame is the simulator's table
/// `event`'s: (window, its screen's scale).
fn window_for(windows: &[CgWindow], event: &Value) -> Option<(CgWindow, u32)> {
    let displays = macos::displays();
    windows.iter().find_map(|w| {
        let scale = macos::display_scale(&w.bounds, &displays);
        let px = macos::to_pixels(&w.bounds, scale);
        let bottom = i64::from(px.y) + i64::from(px.height);
        let ok = i64::from(px.x) == int(event, "x")
            && i64::from(px.y) == int(event, "y")
            && i64::from(px.width) == int(event, "width")
            && (bottom - (int(event, "clientY") + int(event, "height"))).abs() <= 1;
        ok.then(|| (w.clone(), scale))
    })
}

/// The window server alone: three windows, frames equal to the
/// simulator's, then joined with accessibility windows made from the
/// simulator's events - the tables, names and rects it reports.
fn window_server_path(pid: u32, seen: &Seen, matcher: &TableMatcher) {
    let windows = sim_windows(pid);
    assert_eq!(
        windows.len(),
        3,
        "the simulator's on-screen windows: {windows:#?}\nall:\n{}",
        listing()
    );
    let displays = macos::displays();
    let mut ax = Vec::new();
    for (number, event) in &seen.windows {
        let (window, scale) = window_for(&windows, event).unwrap_or_else(|| {
            panic!(
                "table {number}: no window with the frame {event}\nwindows: {windows:#?}\nall:\n{}",
                listing()
            )
        });
        // Where the simulator says its client area starts: the title bar,
        // as an accessibility close button in its middle would place it.
        let bar_px = int(event, "clientY") - int(event, "y");
        let bar = bar_px * 1_000_000 / i64::from(scale);
        assert!(
            (0..=100_000).contains(&bar),
            "table {number}: a title bar of {bar_px} px at scale {scale}"
        );
        eprintln!(
            "step: table {number} is window #{} at {:?} (scale {scale}), title bar {} pt",
            window.id,
            window.bounds,
            bar / 1000
        );
        let (title, _, _) = &seen.tables[number];
        ax.push(AxWindow {
            title: title.clone(),
            frame: Some(window.bounds),
            subrole: "AXStandardWindow".into(),
            close_button: Some(Frame {
                x: window.bounds.x + 7_000,
                y: window.bounds.y + bar / 2 - 7_000,
                width: 14_000,
                height: 14_000,
            }),
            ..AxWindow::default()
        });
    }
    let snapshot = Snapshot {
        cg: macos::cg_windows().expect("the window list"),
        names: BTreeMap::from([(pid, "rail-hud-sim".to_owned())]),
        ax: BTreeMap::from([(pid, Ok(ax))]),
        displays,
    };
    let raw = assemble(&snapshot, &mut BTreeMap::new());
    let tables: Vec<TableWindow> = raw
        .iter()
        .filter_map(|w| table_of(w, std::slice::from_ref(matcher)))
        .collect();
    if let Err(why) = check(&tables, seen, pid, 0) {
        panic!("the window server's windows with the simulator's titles: {why}\n{tables:#?}");
    }
    eprintln!("step ok: the window server's three windows, joined with the simulator's titles");
}

/// Whether `found` agrees with the simulator: three tables of its
/// process, the hands' table names, client rects equal to its own (within
/// `slack` px on the top edge, where the title bar is measured).
fn check(found: &[TableWindow], seen: &Seen, pid: u32, slack: i64) -> Result<(), String> {
    if found.len() != 3 {
        return Err(format!("{} tables found, 3 expected", found.len()));
    }
    for window in found {
        if window.process.pid != Some(pid) || !same_process(&window.process.name, "rail-hud-sim") {
            return Err(format!("{window:?} is not the simulator's (pid {pid})"));
        }
        let Some(number) = seen.table_titled(&window.title) else {
            return Err(format!(
                "{:?}: no simulator table has this title",
                window.title
            ));
        };
        let (_, name, _) = &seen.tables[&number];
        if window.table.as_deref() != Some(table_key(name).as_str()) {
            return Err(format!(
                "{:?}: table {:?}, the hands say {name:?}",
                window.title, window.table
            ));
        }
        let event = seen
            .windows
            .get(&number)
            .ok_or_else(|| format!("table {number}: no window event"))?;
        let c = window.client;
        let (x, y, w, h) = (
            i64::from(c.x),
            i64::from(c.y),
            i64::from(c.width),
            i64::from(c.height),
        );
        let (ex, ey, ew, eh) = (
            int(event, "clientX"),
            int(event, "clientY"),
            int(event, "width"),
            int(event, "height"),
        );
        if x != ex || w != ew || (y - ey).abs() > slack || (y + h) != (ey + eh) {
            return Err(format!(
                "table {number}: client {:?}, the simulator says ({ex}, {ey}, {ew}, {eh}) (x, y, w, h)",
                (x, y, w, h)
            ));
        }
        if (y - ey).abs() > 0 {
            eprintln!(
                "note: table {number}'s title bar measured {} px off the simulator's",
                y - ey
            );
        }
        let scale = window.scale_permille;
        if c.width.abs_diff(WIDTH * scale / 1000) > 2 {
            return Err(format!(
                "table {number}: {} px wide is not {WIDTH} pt at scale {scale}",
                c.width
            ));
        }
        if window.minimized {
            return Err(format!("table {number} is minimised"));
        }
    }
    Ok(())
}

/// Without the permission: no find, the reason reported everywhere, no
/// title listed - and nothing asked of the user.
fn permission_path(matcher: &TableMatcher, title_regex: &str) {
    let mut backend = MacosBackend::default();
    assert_eq!(
        backend.find_tables(std::slice::from_ref(matcher)),
        Err(PlatformError::PermissionNeeded(Permission::Accessibility))
    );
    assert_eq!(backend.permission_needed(), Some(Permission::Accessibility));
    // No matcher, nothing to find: no permission asked for.
    assert_eq!(backend.find_tables(&[]), Ok(Vec::new()));

    let mut engine = Engine::new(
        Box::new(MacosBackend::default()),
        Compliance::shipped().expect("shipped"),
        StoreView::new(None),
        Settings::default(),
    );
    engine.add_simulator_room("pokerstars", regex::Regex::new(title_regex).expect("regex"));
    let health = engine.health();
    assert_eq!(health.permission_needed.as_deref(), Some("accessibility"));
    assert_eq!((health.platform.as_str(), health.attached), ("macos", 0));
    eprintln!("step ok: the backend and the HUD's health say Accessibility is needed");

    let listed = Command::new(env!("CARGO_BIN_EXE_rail-hud"))
        .args(["--list-windows", "--process", "rail-hud-sim", "--no-store"])
        .output()
        .expect("--list-windows");
    let text = String::from_utf8_lossy(&listed.stdout).into_owned();
    eprintln!("--list-windows:\n{text}");
    assert!(listed.status.success(), "{text}");
    assert!(text.contains("Accessibility: NOT granted"), "{text}");
    assert!(
        text.contains("0 window(s) with a title (3 without one not shown)"),
        "{text}"
    );
    assert!(text.contains("Screen Recording: not used"), "{text}");

    let mut hud = Hud::start(&[
        "--standalone",
        "--sim-site",
        "pokerstars",
        "--sim-title",
        title_regex,
    ]);
    let said = hud.until(
        "Accessibility permission is needed",
        1,
        Duration::from_secs(30),
    );
    eprintln!("rail-hud (no permission):\n{}", hud.log());
    assert!(said, "{}", hud.log());
    assert!(!hud.log().contains("attached to window"), "{}", hud.log());
    eprintln!("step ok: --list-windows and the HUD process say why nothing is found");
}

/// With the permission: the backend's own find, a minimise, a table move,
/// the listing and the HUD process.
fn accessibility_path(
    sim: &mut Sim,
    seen: &mut Seen,
    pid: u32,
    matcher: &TableMatcher,
    title_regex: &str,
) {
    let mut backend = MacosBackend::default();
    assert_eq!(backend.permission_needed(), None);
    let found = find_until(
        &mut backend,
        matcher,
        seen,
        &sim.events,
        "the three tables, by their accessibility titles",
        |found, seen| {
            // The title bar is measured from the close button: allow one
            // point, which `check` reports when it is used.
            let slack = found
                .first()
                .map_or(2, |w| i64::from(w.scale_permille / 1000).max(1));
            check(found, seen, pid, slack)
        },
    );
    for w in &found {
        eprintln!(
            "  #{} {:?} table {:?} client {:?} scale {}",
            w.id.0, w.title, w.table, w.client, w.scale_permille
        );
    }

    // A catch-all pattern on the simulator's process still finds three.
    let any = support::matcher("pokerstars", "^.*$");
    let all = backend
        .find_tables(std::slice::from_ref(&any))
        .expect("find");
    assert_eq!(all.len(), 3, "{all:#?}\nwindows:\n{}", listing());
    // Another process's matcher: nothing (no other process is asked).
    let other = TableMatcher {
        site: "pokerstars".into(),
        processes: vec!["PokerStars".into()],
        title: regex::Regex::new("^.*$").expect("regex"),
    };
    assert!(backend.find_tables(&[other]).expect("find").is_empty());

    // A minimised table is still a table, marked so.
    let (&first, _) = seen.tables.iter().next().expect("a table");
    let first_id = found
        .iter()
        .find(|w| Some(&w.title) == seen.tables.get(&first).map(|(t, _, _)| t))
        .map(|w| w.id)
        .expect("the first table's window");
    sim.command(&format!("minimize {first}"));
    sim.until(seen, Duration::from_secs(20), "the minimise", |s| {
        s.windows
            .get(&first)
            .is_some_and(|e| e["minimized"].as_bool() == Some(true))
    });
    find_until(
        &mut backend,
        matcher,
        seen,
        &sim.events,
        "a minimised table",
        |found, _| match found.iter().find(|w| w.id == first_id) {
            Some(w) if w.minimized && found.len() == 3 => Ok(()),
            other => Err(format!("{} found, table {first}: {other:?}", found.len())),
        },
    );
    sim.command(&format!("restore {first}"));
    sim.until(seen, Duration::from_secs(20), "the restore", |s| {
        s.windows
            .get(&first)
            .is_some_and(|e| e["minimized"].as_bool() == Some(false))
    });

    // A table move retitles the same window.
    let before = seen.tables.get(&first).cloned().expect("first table");
    sim.command(&format!("tablemove {first}"));
    sim.until(seen, Duration::from_secs(20), "the table move", |s| {
        s.tables.get(&first).is_some_and(|t| t.1 != before.1)
    });
    let after = seen.tables.get(&first).cloned().expect("moved table");
    find_until(
        &mut backend,
        matcher,
        seen,
        &sim.events,
        "the moved table",
        |found, _| match found.iter().find(|w| w.id == first_id) {
            Some(w)
                if w.title == after.0
                    && w.table.as_deref() == Some(table_key(&after.1).as_str()) =>
            {
                Ok(())
            }
            other => Err(format!(
                "table {first} after the move: {other:?}, expected {after:?}"
            )),
        },
    );

    // The diagnostic: the three, redacted.
    let listed = Command::new(env!("CARGO_BIN_EXE_rail-hud"))
        .args([
            "--list-windows",
            "--process",
            "rail-hud-sim",
            "--no-store",
            "--try-title",
            title_regex,
        ])
        .output()
        .expect("--list-windows");
    let text = String::from_utf8_lossy(&listed.stdout).into_owned();
    eprintln!("--list-windows:\n{text}");
    assert!(listed.status.success(), "{text}");
    assert_eq!(text.matches("process: rail-hud-sim").count(), 3, "{text}");
    assert_eq!(text.matches("Logged In as <you>").count(), 3, "{text}");
    assert!(!text.contains("SimHero"), "the hero is redacted: {text}");
    assert_eq!(text.matches("try:     table Some(").count(), 3, "{text}");
    assert!(text.contains("Accessibility: granted"), "{text}");

    // The HUD process: attached when the room is allowed, refused when not.
    let mut hud = Hud::start(&[
        "--standalone",
        "--sim-site",
        "pokerstars",
        "--sim-title",
        title_regex,
    ]);
    assert!(
        hud.until("attached to window", 3, Duration::from_secs(30)),
        "{}",
        hud.log()
    );
    for (_, name, _) in seen.tables.values() {
        assert!(
            hud.log()
                .contains(&format!("table Some({:?})", table_key(name))),
            "{name}: {}",
            hud.log()
        );
    }
    drop(hud);
    let mut hud = Hud::start(&[
        "--standalone",
        "--sim-site",
        "ggpoker",
        "--sim-title",
        title_regex,
    ]);
    assert!(
        hud.until("not attaching to window", 3, Duration::from_secs(30)),
        "{}",
        hud.log()
    );
    assert!(!hud.log().contains("attached to window"), "{}", hud.log());
    eprintln!("step ok: the HUD process attaches (pokerstars) and refuses (ggpoker)");
}

#[test]
fn the_simulators_windows_are_found() {
    let sim_path = simulator();
    let title_regex = title_regex(&sim_path);
    let matcher = matcher("pokerstars", &title_regex);

    let mut sim = Sim::start(
        &sim_path,
        "macos-tables",
        &[
            "--tables",
            "3",
            "--window",
            &format!("{WIDTH}x{HEIGHT}"),
            "--speed",
            "1",
            "--seed",
            "7",
        ],
    );
    let pid = sim.child.id();
    let mut seen = Seen::default();
    sim.until(&mut seen, Duration::from_secs(90), "3 shown windows", |s| {
        s.tables.len() == 3 && s.windows.len() == 3
    });
    // The `window` events come once a window has settled; take the latest.
    std::thread::sleep(Duration::from_millis(500));
    seen.drain(&sim.events);

    window_server_path(pid, &seen, &matcher);

    if macos::accessibility_granted() {
        eprintln!(
            "R3.11: this process has the Accessibility permission: the backend's own find runs"
        );
        accessibility_path(&mut sim, &mut seen, pid, &matcher, &title_regex);
    } else {
        eprintln!(
            "R3.11: this process does NOT have the Accessibility permission (its responsible \
             app - the terminal or the CI runner - is not in System Settings, Privacy & Security, \
             Accessibility). Checked: the window server's windows and the permission-needed path. \
             SKIPPED: the backend's own find by accessibility titles, minimise, table move, \
             --list-windows with titles, the HUD process attaching. To run them, grant the \
             terminal Accessibility and run: cargo test -p rail-hud --test macos_tables -- \
             --nocapture"
        );
        permission_path(&matcher, &title_regex);
    }
}
