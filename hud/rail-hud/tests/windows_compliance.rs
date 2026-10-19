//! Compliance mode on Windows with real windows (docs/RAIL-PLAN.md R3.10),
//! in CI on the Windows runner. Elsewhere this file is empty.
//!
//! The HUD process under the real supervisor (this test plays the app), the
//! table simulator's real window posing as a room (`--sim-site`; test-only,
//! nothing of it is in `sites.json`):
//!
//! - **posing as GGPoker** (prohibited): `attach_refused` with `prohibited`,
//!   and every health answer lists the window - its room, its table name,
//!   the reason - in `refusedTables`, which is the list the app's HUD screen
//!   shows as it is (`app/src-tauri/src/hud.rs`, `Windows::from_health`);
//!   no table attached, `tables_open` never above 0, and no overlay window
//!   of the HUD's anywhere;
//! - **posing as PokerStars with the app's remote copy switching it off**
//!   (`--policy <file>`, the app's cache): refused from the first look, the
//!   health answer says the remote policy is in force; the app's `policy`
//!   back to the shipped copy attaches it (an overlay appears); the remote
//!   copy again detaches it - the overlay goes - and lists it as refused.
//!
//! Every step prints what it saw (`step ok: ...`).

#![cfg(windows)]

mod support;

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use rail_hud::platform::WindowId;
use rail_hud::platform::windows::{OVERLAY_CLASS, WindowsBackend, probe};
use rail_hud_ipc::protocol::{AppMessage, HealthReport, HudMessage, RefusalReason};
use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
use support::{Seen, Sim, find_until, listing, matcher, simulator, title_regex, wait_for};

/// The app's half: the supervisor and what the HUD said.
struct App {
    supervisor: Supervisor,
    events: Receiver<Event>,
    said: Vec<HudMessage>,
}

impl App {
    fn start(db: &std::path::Path, args: &[&str]) -> Self {
        let (tx, events) = mpsc::channel();
        let mut config = SupervisorConfig::new(env!("CARGO_BIN_EXE_rail-hud"));
        config.args = vec!["--store".into(), db.as_os_str().to_owned()];
        config.args.extend(args.iter().map(Into::into));
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

    fn until(
        &mut self,
        timeout: Duration,
        what: &str,
        mut done: impl FnMut(&Event) -> bool,
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
                if done(&event) {
                    eprintln!("step ok: {what}");
                    return event;
                }
            }
        }
    }

    /// The next health answer (the supervisor asks every 2 s) for which
    /// `ok` holds.
    fn health(&mut self, what: &str, ok: impl Fn(&HealthReport) -> bool) -> HealthReport {
        let event = self.until(
            Duration::from_secs(15),
            what,
            |e| matches!(e, Event::Message(HudMessage::Health { report, .. }, _) if ok(report)),
        );
        let Event::Message(HudMessage::Health { report, .. }, _) = event else {
            unreachable!()
        };
        report
    }

    fn pid(&self) -> u32 {
        self.supervisor.status().pid.expect("a HUD process")
    }

    /// The HUD never had a table open (nor drew a number).
    fn never_attached(&self) -> bool {
        !self.said.iter().any(|m| {
            matches!(m, HudMessage::TablesOpen { count } if *count > 0)
                || matches!(m, HudMessage::TableUpdated { .. })
        })
    }
}

/// The HUD process's overlay windows (over any table).
fn overlays(pid: u32) -> Vec<WindowId> {
    probe::windows_of(pid)
        .into_iter()
        .filter(|(_, class)| class == OVERLAY_CLASS)
        .map(|(w, _)| w)
        .collect()
}

/// The HUD process's overlay over `table`.
fn overlay_of(pid: u32, table: WindowId) -> Option<WindowId> {
    overlays(pid)
        .into_iter()
        .find(|w| probe::owner(*w) == Some(table))
}

/// The shipped `sites.json` with PokerStars' HUD switched off: what a
/// re-check that found the permission withdrawn would publish.
fn pokerstars_off() -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(rail_config::SHIPPED).expect("shipped json");
    for site in value["sites"].as_array_mut().expect("sites") {
        if site["id"] == "pokerstars" {
            site["hud"]["allowed"] = serde_json::Value::Bool(false);
        }
    }
    value.to_string()
}

#[test]
fn a_room_that_is_not_allowed_is_refused_and_listed() {
    let sim_path = simulator();
    let regex = title_regex(&sim_path);
    let dir: PathBuf =
        std::env::temp_dir().join(format!("rail-hud-compliance-store-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let db = dir.join(rail_store::FILE_NAME);
    let store = rail_store::Store::open(&db).expect("store");

    let mut sim = Sim::start(
        &sim_path,
        "compliance",
        &[
            "--tables", "1", "--sizes", "6", "--window", "640x480", "--speed", "6", "--seed", "44",
        ],
    );
    let mut seen = Seen::default();
    sim.until(
        &mut seen,
        Duration::from_secs(90),
        "one table window",
        |s| s.tables.len() == 1 && s.windows.len() == 1,
    );
    let mut finder = WindowsBackend::default();
    let found = find_until(
        &mut finder,
        &matcher("ggpoker", &regex),
        &mut seen,
        &sim.events,
        "the table window",
        |found, _| {
            if found.len() == 1 {
                Ok(())
            } else {
                Err(format!("{} found", found.len()))
            }
        },
    );
    let window = found[0].clone();
    let id = window.id.0;
    assert!(window.table.is_some(), "{window:?}");

    // Posing as GGPoker: prohibited.
    let mut app = App::start(&db, &["--sim-site", "ggpoker", "--sim-title", &regex]);
    app.until(Duration::from_secs(20), "attach_refused: prohibited", |e| {
        matches!(
            e,
            Event::Message(HudMessage::AttachRefused { site, window, reason }, _)
                if site == "ggpoker" && *window == id && *reason == RefusalReason::Prohibited
        )
    });
    let report = app.health("the app's list: refused, prohibited", |r| {
        r.refused_tables.iter().any(|t| t.window == id)
    });
    let refused = report
        .refused_tables
        .iter()
        .find(|t| t.window == id)
        .expect("listed");
    assert_eq!(
        (refused.site.as_str(), refused.reason, &refused.table),
        ("ggpoker", RefusalReason::Prohibited, &window.table)
    );
    assert!(
        report.tables.is_empty() && report.attached == 0,
        "{report:?}"
    );
    assert!(!report.remote_policy);
    let pid = app.pid();
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        overlays(pid).is_empty(),
        "no overlay at all: {:?}",
        probe::windows_of(pid)
    );
    assert!(app.never_attached(), "{:?}", app.said);
    eprintln!("step ok: GGPoker refused, listed with its table and reason, no overlay");
    app.supervisor.stop();

    // Posing as PokerStars (allowed in the shipped copy) with the app's
    // remote copy switching it off, read at start.
    let policy = dir.join("sites.json");
    std::fs::write(&policy, pokerstars_off()).expect("the remote copy");
    let policy_arg = policy.to_string_lossy().into_owned();
    let mut app = App::start(
        &db,
        &[
            "--sim-site",
            "pokerstars",
            "--sim-title",
            &regex,
            "--policy",
            &policy_arg,
        ],
    );
    app.until(
        Duration::from_secs(20),
        "attach_refused by the remote copy",
        |e| {
            matches!(
                e,
                Event::Message(HudMessage::AttachRefused { site, window, reason }, _)
                    if site == "pokerstars" && *window == id && *reason == RefusalReason::Prohibited
            )
        },
    );
    let report = app.health("listed, the remote policy in force", |r| {
        r.remote_policy && r.refused_tables.iter().any(|t| t.window == id)
    });
    assert!(report.tables.is_empty(), "{report:?}");
    let pid = app.pid();
    assert!(overlays(pid).is_empty(), "{:?}", probe::windows_of(pid));
    assert!(app.never_attached(), "never attached, not for a moment");

    // The shipped policy alone: attached, an overlay over the table.
    app.supervisor.send(AppMessage::Policy { remote: None });
    app.until(
        Duration::from_secs(20),
        "attached with the shipped policy",
        |e| matches!(e, Event::Message(HudMessage::TablesOpen { count: 1 }, _)),
    );
    wait_for(Duration::from_secs(10), "an overlay over the table", || {
        overlay_of(pid, window.id).ok_or_else(|| format!("{:?}", probe::windows_of(pid)))
    });

    // The remote copy again: detached at once, the overlay gone, listed.
    app.supervisor.send(AppMessage::Policy {
        remote: Some(pokerstars_off()),
    });
    app.until(
        Duration::from_secs(20),
        "detached by the remote copy",
        |e| matches!(e, Event::Message(HudMessage::TablesOpen { count: 0 }, _)),
    );
    wait_for(Duration::from_secs(10), "no overlay any more", || {
        if overlays(pid).is_empty() {
            Ok(())
        } else {
            Err(format!("{:?}", probe::windows_of(pid)))
        }
    });
    let report = app.health("listed as refused again", |r| {
        r.remote_policy && r.tables.is_empty() && r.refused_tables.iter().any(|t| t.window == id)
    });
    assert_eq!(
        report.refused_tables[0].reason,
        RefusalReason::Prohibited,
        "{report:?}"
    );
    app.supervisor.stop();
    store.close();
    drop(sim);
    let _ = std::fs::remove_dir_all(&dir);
}
