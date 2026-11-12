//! (T7, docs/research/TABLE-TILING.md §4.6) The Action Required slot
//! through the HUD's engine, headless on the sim backend with the real
//! placement worker: the simulator's tables give the window signals a
//! client gives by itself (`SimControl::signal`: a taskbar flash, the
//! foreground) and the engine moves them.
//!
//! No shipped room allows the slot (`actionSlot` is `null` everywhere), so
//! the mechanism runs on a test policy - the shipped `sites.json` with
//! PokerStars' `actionSlot` allowed on its taskbar flash
//! (`Compliance::from_sites_json`, never reachable from the binary).
//! Checked:
//!
//! - a flash moves the table into the action slot, and it goes back to its
//!   own slot once the flashes stop (`hold`);
//! - another signal than the room's (the foreground) moves nothing;
//! - two tables' turns at once queue for the one slot;
//! - a table closed while in the slot lets the next one in;
//! - with a mouse button held nothing moves; released, the table moves;
//! - a room without the permit (ACR: tiling yes, slot no; Winamax: no
//!   tiling) never moves, and on the shipped policy nothing does and no
//!   program is watched.

use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Input, Settings};
use rail_hud::platform::sim::{SIM_PROCESS, SimBackend, SimControl, SimFeed};
use rail_hud::platform::{Monitor, MonitorId, Rect, WindowId};
use rail_hud::tiling::ActionTiming;
use rail_hud_ipc::protocol::{AppMessage, HudMessage};
use rail_hud_ipc::settings::{Layout, LayoutRef, Slot, SlotKind, SlotRect, TilingSettings};

use rail_config::SignalKind;

fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn monitors() -> Vec<Monitor> {
    vec![Monitor {
        id: MonitorId(1),
        primary: true,
        bounds: rect(0, 0, 1920, 1080),
        work_area: rect(0, 0, 1920, 1040),
        scale_permille: 1000,
    }]
}

/// The shipped policy with `actionSlot` allowed on PokerStars (tiling is
/// allowed there already), its taskbar flash the signal on both systems.
fn allowing_the_slot() -> Compliance {
    let mut config: serde_json::Value =
        serde_json::from_str(rail_config::SHIPPED).expect("shipped json");
    for entry in config["sites"].as_array_mut().expect("sites") {
        if entry["id"] == "pokerstars" {
            entry["actionSlot"] = serde_json::json!({
                "allowed": true,
                "source": "https://example.invalid/tools",
                "checkedAt": "2026-11-12",
                "notes": null,
                "signal": { "windows": "flash", "macos": "flash" }
            });
        }
    }
    Compliance::from_sites_json(&config.to_string()).expect("a test policy")
}

/// The simulator's table `n`, posing as `site`, at a place of its own.
fn open(feed: &SimFeed, control: &SimControl, n: u32, site: &str) {
    control.pose(n, site);
    let title = format!("T{n} - $0.05/$0.10");
    feed.push_line(&format!(
        r#"{{"event":"table","table":{n},"title":"{title}","size":6}}"#
    ));
    feed.push_line(&format!(
        r#"{{"event":"window","table":{n},"title":"{title}","x":{x},"y":{y},"width":640,"height":480,"minimized":false}}"#,
        x = 30 * n,
        y = 20 * n
    ));
}

/// Two play slots on the top half, the Action Required slot under them.
fn settings() -> TilingSettings {
    let slot = |id: &str, x: u32, y: u32, kind: SlotKind| Slot {
        id: id.into(),
        monitor: 0,
        rect: SlotRect {
            x,
            y,
            width: 500,
            height: 500,
        },
        kind,
        rooms: None,
        stack: true,
    };
    TilingSettings {
        enabled: true,
        active: LayoutRef::Custom { id: "act".into() },
        layouts: vec![Layout {
            id: "act".into(),
            name: "Act".into(),
            slots: vec![
                slot("p1", 0, 0, SlotKind::Play),
                slot("p2", 500, 0, SlotKind::Play),
                slot("a", 250, 500, SlotKind::Action),
            ],
            auto_switch: Vec::new(),
        }],
        ..TilingSettings::default()
    }
}

/// The action slot, pixels (thousandths of the 1920 x 1040 work area).
fn action_cell() -> Rect {
    rect(480, 520, 960, 520)
}

/// Short, with room for a slow CI machine.
const TIMING: ActionTiming = ActionTiming {
    hold: Duration::from_millis(1500),
    max: Duration::from_secs(20),
    dwell: Duration::from_millis(300),
    cooldown: Duration::from_secs(2),
};

struct Rig {
    hud: Hud,
    feed: SimFeed,
    control: SimControl,
    sent: Vec<HudMessage>,
}

impl Rig {
    fn new(compliance: Compliance) -> Self {
        let (mut backend, feed) = SimBackend::new("pokerstars");
        backend.set_monitors(monitors());
        let control = backend.control();
        feed.push_line(r#"{"event":"started","titleRegex":"^(?P<table>.+?) - .*$"}"#);
        let settings = Settings {
            tick: Duration::from_millis(5),
            find_every: Duration::from_millis(30),
            find_every_notified: Duration::from_millis(30),
            ..Settings::default()
        };
        let mut hud = Hud::new(
            Box::new(backend),
            compliance,
            StoreView::new(None),
            settings,
        );
        hud.set_action_timing(TIMING);
        Self {
            hud,
            feed,
            control,
            sent: Vec::new(),
        }
    }

    fn send(&mut self, message: AppMessage) {
        let sent = &mut self.sent;
        let exit = self
            .hud
            .handle(Input::App(message, Instant::now()), &mut |m| sent.push(m));
        assert!(exit.is_none());
    }

    fn run_for(&mut self, d: Duration) {
        let end = Instant::now() + d;
        while Instant::now() < end {
            let sent = &mut self.sent;
            self.hud.tick(Instant::now(), &mut |m| sent.push(m));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn in_slot(&self, n: u32) -> bool {
        self.hud
            .tiler()
            .and_then(|t| t.action_of(WindowId(u64::from(n))))
            .is_some()
    }

    /// Ticks until `cond` holds (at most 10 s).
    fn until(&mut self, what: &str, cond: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond(self) {
            assert!(Instant::now() < deadline, "never: {what}");
            self.run_for(Duration::from_millis(10));
        }
    }

    /// Whether table `n`'s outer rect lies in the action slot.
    fn shown_in_slot(&self, n: u32) -> bool {
        self.control
            .outer_of(n)
            .is_some_and(|outer| action_cell().contains(&outer))
    }

    fn placed(&self, n: u64) -> usize {
        self.control
            .placements()
            .iter()
            .filter(|p| p.id == WindowId(n))
            .count()
    }
}

/// Tiling on with the action layout over tables 1 and 2 (PokerStars),
/// 5 (ACR) and 9 (Winamax); settled.
fn rig(compliance: Compliance) -> Rig {
    let mut rig = Rig::new(compliance);
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "pokerstars");
    open(&rig.feed, &rig.control, 5, "acr");
    open(&rig.feed, &rig.control, 9, "winamax");
    rig.run_for(Duration::from_millis(100));
    rig.send(AppMessage::TilingChanged {
        settings: settings(),
    });
    rig.until("tiled", |r| {
        r.hud
            .tiler()
            .is_some_and(|t| t.table_count() == 3 && t.settled())
            && r.placed(1) > 0
            && r.placed(2) > 0
    });
    rig.run_for(Duration::from_millis(300));
    rig
}

#[test]
fn a_turn_moves_the_table_in_and_back() {
    let mut rig = rig(allowing_the_slot());
    assert_eq!(rig.control.watched(), [SIM_PROCESS], "the clients watched");
    let home = rig.control.outer_of(1).expect("1");
    assert!(!action_cell().contains(&home));

    // Another signal than the room's: nothing.
    rig.control.signal(1, SignalKind::Foreground);
    rig.run_for(Duration::from_millis(200));
    assert!(!rig.in_slot(1));

    // Its flash: in. Flashes keep it there past `hold`.
    rig.control.signal(1, SignalKind::Flash);
    rig.until("in the slot", |r| r.in_slot(1) && r.shown_in_slot(1));
    for _ in 0..4 {
        rig.run_for(Duration::from_millis(500));
        rig.control.signal(1, SignalKind::Flash);
    }
    rig.run_for(Duration::from_millis(100));
    assert!(rig.in_slot(1) && rig.shown_in_slot(1), "still its turn");
    // The flashes stop: home again, where it was.
    rig.until("home", |r| {
        !r.in_slot(1) && r.control.outer_of(1) == Some(home)
    });
    // A flash at once after (the cooldown): ignored.
    rig.control.signal(1, SignalKind::Flash);
    rig.run_for(Duration::from_millis(100));
    assert!(!rig.in_slot(1));

    // Neither ACR (tiling yes, the slot no) nor Winamax (no tiling) ever
    // moves on a flash.
    let acr = rig.placed(5);
    rig.control.signal(5, SignalKind::Flash);
    rig.control.signal(9, SignalKind::Flash);
    rig.run_for(Duration::from_millis(400));
    assert!(!rig.in_slot(5) && !rig.in_slot(9));
    assert_eq!((rig.placed(5), rig.placed(9)), (acr, 0));
}

#[test]
fn two_turns_queue_and_a_closed_table_lets_the_next_in() {
    let mut rig = rig(allowing_the_slot());
    rig.control.signal(1, SignalKind::Flash);
    rig.run_for(Duration::from_millis(30));
    rig.control.signal(2, SignalKind::Flash);
    rig.run_for(Duration::from_millis(30));
    rig.until("1 in", |r| r.in_slot(1) && r.shown_in_slot(1));
    assert!(!rig.in_slot(2), "2 waits");
    assert_eq!(
        rig.hud.tiler().map(|t| t.turns().len()),
        Some(2),
        "both turns on"
    );
    // 1 closes while in the slot: 2 moves in.
    rig.control.signal(2, SignalKind::Flash);
    rig.feed.push_line(r#"{"event":"closed","table":1}"#);
    rig.until("2 in", |r| r.in_slot(2) && r.shown_in_slot(2));
    rig.until("2 home", |r| !r.in_slot(2));
    // Past 2's cooldown.
    rig.run_for(TIMING.cooldown);

    // Queued, not closed: 1 is gone, so 2 and a new table 3.
    open(&rig.feed, &rig.control, 3, "pokerstars");
    rig.run_for(Duration::from_millis(400));
    rig.control.signal(3, SignalKind::Flash);
    rig.run_for(Duration::from_millis(500));
    rig.control.signal(2, SignalKind::Flash);
    rig.until("3 in", |r| r.in_slot(3));
    rig.until("3 out, 2 in", |r| !r.in_slot(3) && r.in_slot(2));
    rig.until("2 home", |r| !r.in_slot(2));
}

#[test]
fn nothing_moves_while_the_mouse_is_held() {
    let mut rig = rig(allowing_the_slot());
    let before = rig.placed(1);
    rig.control.press();
    rig.control.signal(1, SignalKind::Flash);
    rig.run_for(Duration::from_millis(300));
    rig.control.signal(1, SignalKind::Flash);
    rig.run_for(Duration::from_millis(300));
    assert!(rig.in_slot(1), "its turn");
    assert_eq!(rig.placed(1), before, "not moved while the button is down");
    assert!(!rig.shown_in_slot(1));
    rig.control.release();
    // Still its turn (the client goes on flashing): it moves once the
    // mouse is quiet.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !rig.shown_in_slot(1) {
        assert!(Instant::now() < deadline, "never moved after the release");
        rig.control.signal(1, SignalKind::Flash);
        rig.run_for(Duration::from_millis(100));
    }
}

#[test]
fn the_shipped_policy_moves_nothing() {
    let mut rig = rig(Compliance::shipped().expect("shipped"));
    assert!(rig.control.watched().is_empty(), "nothing watched");
    let before = rig.control.placements().len();
    for n in [1, 2, 5, 9] {
        rig.control.signal(n, SignalKind::Flash);
        rig.control.signal(n, SignalKind::Foreground);
        rig.control.signal(n, SignalKind::Raised);
    }
    rig.run_for(Duration::from_millis(500));
    assert_eq!(rig.control.placements().len(), before);
    assert!([1, 2, 5, 9].iter().all(|n| !rig.in_slot(*n)));
    assert!(rig.hud.tiler().is_some_and(|t| t.turns().is_empty()));
}
