//! (T3, docs/research/TABLE-TILING.md §4.1, §5) The app's tiling settings
//! reaching the HUD's engine over its messages, headless on the sim
//! backend with the real placement worker:
//!
//! - `tiling_changed` with `enabled: true` tiles the simulator's tables
//!   of rooms whose policy gives a `TilingPermit` (T0) - CoinPoker's too,
//!   whose HUD is refused - and says so in `tiling_status`; a room the user
//!   switched off is not moved until switched on; a room the policy says no
//!   to (Winamax) is never moved, whatever the user's switch; settings that
//!   do not validate change nothing;
//! - `retile` places a table the user dragged (pinned) back in its slot;
//! - `tiling_changed` with `enabled: false` stops every move;
//! - `rng_changed` is kept, and drawn on no room without an `RngPermit`;
//!   `panels {allowed: false}` attaches nothing while tiling goes on;
//! - (T5) `tiling_status` carries the monitors (tiling on or off) and each
//!   tiled table's outer rect, name, monitor and stack; `capture_layout`
//!   is answered with a slot per place.

use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Input, Settings};
use rail_hud::platform::sim::{SimBackend, SimControl, SimFeed};
use rail_hud::platform::{Insets, Monitor, MonitorId, Rect, WindowId};
use rail_hud_ipc::protocol::{AppMessage, HudMessage, ScreenRect, TiledTable};
use rail_hud_ipc::settings::{LayoutRef, RngSettings, SlotKind, TilingSettings};

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

struct Rig {
    hud: Hud,
    feed: SimFeed,
    control: SimControl,
    sent: Vec<HudMessage>,
}

impl Rig {
    fn new() -> Self {
        let (mut backend, feed) = SimBackend::new("pokerstars");
        backend.set_monitors(monitors());
        let control = backend.control();
        control.set_insets(Insets {
            left: 1,
            top: 31,
            right: 1,
            bottom: 1,
        });
        feed.push_line(r#"{"event":"started","titleRegex":"^(?P<table>.+?) - .*$"}"#);
        let settings = Settings {
            tick: Duration::from_millis(5),
            find_every: Duration::from_millis(30),
            find_every_notified: Duration::from_millis(30),
            ..Settings::default()
        };
        let hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            settings,
        );
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

    /// Ticks until the tiler has nothing due and no placement came for
    /// 300 ms; the windows placed meanwhile.
    fn settle(&mut self) -> Vec<u64> {
        let before = self.control.placements().len();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut count = before;
        let mut quiet_since = Instant::now();
        loop {
            self.run_for(Duration::from_millis(20));
            let now = self.control.placements().len();
            if now != count {
                count = now;
                quiet_since = Instant::now();
            }
            let settled = self
                .hud
                .tiler()
                .is_none_or(rail_hud::tiling::Tiler::settled);
            if settled && quiet_since.elapsed() >= Duration::from_millis(300) {
                break;
            }
            assert!(Instant::now() < deadline, "tiling did not settle");
        }
        let mut ids: Vec<u64> = self.control.placements()[before..]
            .iter()
            .map(|p| p.id.0)
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    fn statuses(&self) -> Vec<(bool, u32, Option<String>)> {
        self.sent
            .iter()
            .filter_map(|m| match m {
                HudMessage::TilingStatus {
                    enabled,
                    tables,
                    layout,
                    ..
                } => Some((*enabled, *tables, layout.clone())),
                _ => None,
            })
            .collect()
    }
}

fn on() -> TilingSettings {
    TilingSettings {
        enabled: true,
        per_room: [("acr".to_owned(), false)].into_iter().collect(),
        ..TilingSettings::default()
    }
}

#[test]
fn the_apps_settings_switch_tiling_on_and_off() {
    let mut rig = Rig::new();
    for n in 1..=3 {
        open(&rig.feed, &rig.control, n, "pokerstars");
    }
    // ACR: tiling allowed, switched off by the user.
    open(&rig.feed, &rig.control, 9, "acr");
    // Winamax: the policy says no to tiling (its HUD is allowed).
    open(&rig.feed, &rig.control, 10, "winamax");
    // CoinPoker: no HUD, tiling allowed.
    open(&rig.feed, &rig.control, 11, "coinpoker");
    rig.run_for(Duration::from_millis(200));
    assert!(
        rig.control.placements().is_empty(),
        "off until the app says"
    );
    assert!(
        rig.statuses().iter().all(|s| *s == (false, 0, None)),
        "off: nothing but the monitors"
    );

    // Settings that do not validate change nothing.
    rig.send(AppMessage::TilingChanged {
        settings: TilingSettings {
            active: LayoutRef::Custom { id: "gone".into() },
            ..on()
        },
    });
    rig.run_for(Duration::from_millis(200));
    assert!(rig.hud.tiler().is_none() && rig.control.placements().is_empty());

    // On: the permitted rooms' tables are tiled; the room switched off and
    // the room the policy refuses are not.
    rig.send(AppMessage::TilingChanged { settings: on() });
    assert!(rig.hud.tiler().is_some());
    assert_eq!(rig.settle(), [1, 2, 3, 11]);
    assert_eq!(rig.control.client_of(9), Some(rect(270, 180, 640, 480)));
    assert_eq!(rig.control.client_of(10), Some(rect(300, 200, 640, 480)));
    assert_eq!(
        rig.statuses().last(),
        Some(&(true, 4, Some("auto".to_owned())))
    );
    let tiled = [1, 2, 3, 11];

    // The user drags table 2 (the mouse down): pinned where it is.
    let cells: Vec<Rect> = tiled
        .iter()
        .map(|n| rig.control.client_of(*n).expect("open"))
        .collect();
    rig.control.press();
    rig.run_for(Duration::from_millis(250));
    rig.feed.push_line(
        r#"{"event":"window","table":2,"title":"T2 - $0.05/$0.10","x":500,"y":300,"width":640,"height":480,"minimized":false}"#,
    );
    rig.run_for(Duration::from_millis(150));
    rig.control.release();
    assert!(rig.hud.tiler().is_some_and(|t| t.pinned(WindowId(2))));
    assert_eq!(rig.settle(), Vec::<u64>::new(), "a pinned table stays");
    assert_eq!(rig.control.client_of(2), Some(rect(500, 300, 640, 480)));

    // `retile` (the tray's "Re-tile tables"): every table laid out again,
    // the dragged one back in the grid.
    rig.send(AppMessage::Retile);
    let moved = rig.settle();
    assert!(moved.contains(&2), "{moved:?}");
    assert!(!rig.hud.tiler().is_some_and(|t| t.pinned(WindowId(2))));
    assert!(
        rig.hud
            .tiler()
            .and_then(|t| t.slot_of(WindowId(2)))
            .is_some()
    );
    let mut again: Vec<Rect> = tiled
        .iter()
        .map(|n| rig.control.client_of(*n).expect("open"))
        .collect();
    let mut before = cells;
    again.sort_by_key(|r| (r.y, r.x));
    before.sort_by_key(|r| (r.y, r.x));
    assert_eq!(again, before, "the grid's places again");

    // The user switches ACR on: its table joins the grid. Winamax's switch
    // on changes nothing: the policy says no.
    rig.send(AppMessage::TilingChanged {
        settings: TilingSettings {
            per_room: [("winamax".to_owned(), true)].into_iter().collect(),
            ..on()
        },
    });
    let moved = rig.settle();
    assert!(moved.contains(&9), "{moved:?}");
    assert!(
        rig.control
            .placements()
            .iter()
            .all(|p| p.id != WindowId(10)),
        "Winamax's table never moved"
    );
    assert_eq!(rig.control.client_of(10), Some(rect(300, 200, 640, 480)));

    // Off: nothing moves any more, windows stay where they are.
    rig.send(AppMessage::TilingChanged {
        settings: TilingSettings::default(),
    });
    assert!(rig.hud.tiler().is_none());
    assert_eq!(rig.statuses().last(), Some(&(false, 0, None)));
    let before = rig.control.placements().len();
    open(&rig.feed, &rig.control, 4, "pokerstars");
    rig.send(AppMessage::Retile);
    rig.run_for(Duration::from_millis(400));
    assert_eq!(rig.control.placements().len(), before, "off: no move");
    assert_eq!(rig.control.client_of(4), Some(rect(120, 80, 640, 480)));
}

/// `rng_changed` is kept (valid only); `panels {allowed: false}` (the Free
/// plan) attaches no table, and tiling goes on; panels allowed again
/// attach at the next look.
#[test]
fn rng_settings_are_kept_and_panels_can_be_off() {
    let mut rig = Rig::new();
    assert!(rig.hud.rng_settings().is_none());
    let rng = RngSettings {
        enabled: true,
        ..RngSettings::default()
    };
    rig.send(AppMessage::RngChanged {
        settings: rng.clone(),
    });
    assert_eq!(rig.hud.rng_settings(), Some(&rng));
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            max: 0,
            ..RngSettings::default()
        },
    });
    assert_eq!(rig.hud.rng_settings(), Some(&rng), "a refused one is not");
    // (T4 draws it) Only with the room's RngPermit: no shipped room gives
    // one yet (PokerStars: unknown; CoinPoker: no), whatever the settings.
    assert!(rig.hud.rng_for("pokerstars").is_none());
    assert!(rig.hud.rng_for("coinpoker").is_none());
    // (T5 follow-up) The user's switch per room on, and a new size and
    // opacity, change nothing of that: the policy decides first.
    let switched = RngSettings {
        per_room: [
            ("pokerstars".to_owned(), true),
            ("coinpoker".to_owned(), true),
        ]
        .into_iter()
        .collect(),
        scale: 200,
        opacity: 30,
        ..rng.clone()
    };
    rig.send(AppMessage::RngChanged {
        settings: switched.clone(),
    });
    assert_eq!(rig.hud.rng_settings(), Some(&switched));
    assert!(rig.hud.rng_for("pokerstars").is_none());
    assert!(rig.hud.rng_for("coinpoker").is_none());

    rig.send(AppMessage::Panels { allowed: false });
    assert!(!rig.hud.panels());
    rig.send(AppMessage::TilingChanged {
        settings: TilingSettings {
            enabled: true,
            ..TilingSettings::default()
        },
    });
    open(&rig.feed, &rig.control, 1, "pokerstars");
    // CoinPoker: its HUD is refused, its tiling allowed.
    open(&rig.feed, &rig.control, 2, "coinpoker");
    assert_eq!(rig.settle(), [1, 2], "tiled without panels");
    assert!(rig.hud.attached().is_empty(), "no panel attached");
    assert!(
        !rig.sent.iter().any(|m| matches!(
            m,
            HudMessage::TablesOpen { .. } | HudMessage::AttachRefused { .. }
        )),
        "nothing attached, nothing refused: {:?}",
        rig.sent
    );
    rig.send(AppMessage::Panels { allowed: true });
    rig.run_for(Duration::from_millis(200));
    assert_eq!(rig.hud.attached().len(), 1, "the allowed room attaches");
    assert!(rig.sent.contains(&HudMessage::TablesOpen { count: 1 }));
}

/// (T5) The last `tiling_status` in full.
fn last_status(sent: &[HudMessage]) -> Option<&HudMessage> {
    sent.iter()
        .rev()
        .find(|m| matches!(m, HudMessage::TilingStatus { .. }))
}

/// (T5) What the Tables screen draws: the monitors while tiling is off,
/// then every tiled table at its outer rect with its name and monitor; a
/// dragged table pinned; `capture_layout` answered with one slot per
/// place, valid as a layout; nothing captured while off.
#[test]
fn the_status_carries_monitors_and_tables_and_a_layout_can_be_captured() {
    let mut rig = Rig::new();
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "pokerstars");
    rig.run_for(Duration::from_millis(100));
    assert!(
        last_status(&rig.sent).is_none(),
        "nothing until the app speaks of tiling"
    );
    // After a handshake the app always sends its settings: off here.
    rig.send(AppMessage::TilingChanged {
        settings: TilingSettings::default(),
    });
    rig.run_for(Duration::from_millis(100));
    let Some(HudMessage::TilingStatus {
        enabled: false,
        monitors,
        windows,
        ..
    }) = last_status(&rig.sent)
    else {
        panic!("a status while off: {:?}", rig.sent);
    };
    assert_eq!(monitors.len(), 1);
    assert_eq!(monitors[0].index, 0);
    assert!(monitors[0].primary);
    assert_eq!(
        monitors[0].work_area,
        ScreenRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040
        }
    );
    assert!(windows.is_empty());
    rig.send(AppMessage::CaptureLayout { request: 1 });
    assert!(
        rig.sent.contains(&HudMessage::LayoutCaptured {
            request: 1,
            slots: Vec::new()
        }),
        "off: nothing to capture"
    );

    rig.send(AppMessage::TilingChanged {
        settings: TilingSettings {
            enabled: true,
            ..TilingSettings::default()
        },
    });
    assert_eq!(rig.settle(), [1, 2]);
    rig.run_for(Duration::from_millis(300));
    let Some(HudMessage::TilingStatus {
        enabled: true,
        tables: 2,
        windows,
        ..
    }) = last_status(&rig.sent)
    else {
        panic!("a status with the tables: {:?}", rig.sent);
    };
    let outer = |n: u32| {
        let c = rig.control.client_of(n).expect("open");
        ScreenRect {
            x: c.x - 1,
            y: c.y - 31,
            width: c.width + 2,
            height: c.height + 32,
        }
    };
    assert_eq!(
        windows,
        &vec![
            TiledTable {
                site: "pokerstars".into(),
                table: Some("T1".into()),
                rect: outer(1),
                monitor: 0,
                stacked: false,
                pinned: false,
            },
            TiledTable {
                site: "pokerstars".into(),
                table: Some("T2".into()),
                rect: outer(2),
                monitor: 0,
                stacked: false,
                pinned: false,
            },
        ]
    );

    // Captured: a slot per table, thousandths of the work area.
    rig.send(AppMessage::CaptureLayout { request: 2 });
    let slots = rig
        .sent
        .iter()
        .find_map(|m| match m {
            HudMessage::LayoutCaptured { request: 2, slots } => Some(slots.clone()),
            _ => None,
        })
        .expect("answered");
    assert_eq!(slots.len(), 2, "{slots:?}");
    assert!(
        slots
            .iter()
            .all(|s| s.monitor == 0 && s.kind == SlotKind::Play && s.stack)
    );
    let layout = rail_hud_ipc::settings::Layout {
        id: "mine".into(),
        name: "Mine".into(),
        slots,
        auto_switch: Vec::new(),
    };
    let saved = TilingSettings {
        enabled: true,
        active: LayoutRef::Custom { id: "mine".into() },
        layouts: vec![layout],
        ..TilingSettings::default()
    };
    assert_eq!(saved.validate(), Ok(()));
    // In force, the captured layout keeps the tables where they are.
    rig.send(AppMessage::TilingChanged { settings: saved });
    rig.settle();
    rig.run_for(Duration::from_millis(300));
    let Some(HudMessage::TilingStatus {
        layout, windows, ..
    }) = last_status(&rig.sent)
    else {
        panic!("a status");
    };
    assert_eq!(layout.as_deref(), Some("mine"));
    assert_eq!(windows.len(), 2);

    // Dragged by the user: pinned in the status.
    rig.control.press();
    rig.run_for(Duration::from_millis(250));
    rig.feed.push_line(
        r#"{"event":"window","table":2,"title":"T2 - $0.05/$0.10","x":700,"y":400,"width":640,"height":480,"minimized":false}"#,
    );
    rig.run_for(Duration::from_millis(150));
    rig.control.release();
    rig.run_for(Duration::from_millis(400));
    let Some(HudMessage::TilingStatus { windows, .. }) = last_status(&rig.sent) else {
        panic!("a status");
    };
    let two = windows
        .iter()
        .find(|w| w.table.as_deref() == Some("T2"))
        .expect("T2");
    assert!(two.pinned, "{two:?}");
    assert_eq!((two.rect.x, two.rect.y), (699, 369));
}
