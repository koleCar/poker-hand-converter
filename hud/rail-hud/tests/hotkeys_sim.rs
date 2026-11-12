//! (T7, docs/research/TABLE-TILING.md §4.3, §5) Global hotkeys from the
//! key to the windows, headless on the sim backend with the real placement
//! worker: each hotkey goes through `rail_hud_ipc::hotkeys::dispatch` -
//! what the app does when the system reports the key - to the messages the
//! app sends (`tiling_changed` with the settings the hotkey made, `retile`,
//! `roll_rng`), and those through the HUD's engine. Checked:
//!
//! - "Re-tile" puts a table the user dragged back in its slot;
//! - "Next layout" / "Previous layout" lay the tables out in the user's
//!   layouts and the auto grid, round;
//! - "Tiling on / off" switches it, and off nothing moves;
//! - a table of a room whose policy gives no `TilingPermit` (Winamax) is
//!   never moved by any of them;
//! - "Roll the RNG" rolls the table in front only where the room gives an
//!   `RngPermit` - on the shipped policy (no room does) it does nothing at
//!   all; on a test policy it rolls the table in front and no other.

use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Input, Settings};
use rail_hud::platform::sim::{SimBackend, SimControl, SimFeed};
use rail_hud::platform::{Monitor, MonitorId, Rect, WindowId};
use rail_hud_ipc::hotkeys::{HotkeyAction, HotkeyEffect, dispatch};
use rail_hud_ipc::protocol::{AppMessage, HudMessage};
use rail_hud_ipc::settings::{
    Layout, LayoutRef, RngSettings, Slot, SlotKind, SlotRect, TilingSettings,
};

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

/// The shipped policy with `rng.allowed: true` for `sites` (tests only:
/// `Compliance::from_sites_json`, behind the `test-policy` feature).
fn allowing_rng(sites: &[&str]) -> Compliance {
    let mut config: serde_json::Value =
        serde_json::from_str(rail_config::SHIPPED).expect("shipped json");
    for entry in config["sites"].as_array_mut().expect("sites") {
        if sites.contains(&entry["id"].as_str().unwrap_or_default()) {
            entry["rng"]["allowed"] = serde_json::Value::Bool(true);
        }
    }
    Compliance::from_sites_json(&config.to_string()).expect("a test policy")
}

struct Rig {
    hud: Hud,
    feed: SimFeed,
    control: SimControl,
    /// The settings as the app has them (what each hotkey starts from).
    tiling: TilingSettings,
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
        let hud = Hud::new(
            Box::new(backend),
            compliance,
            StoreView::new(None),
            settings,
        );
        Self {
            hud,
            feed,
            control,
            tiling: TilingSettings::default(),
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

    /// The settings saved in the app: stored, and sent as the app does.
    fn save(&mut self, settings: TilingSettings) {
        self.tiling = settings.clone();
        self.send(AppMessage::TilingChanged { settings });
    }

    /// The user presses the hotkey for `action`: what the app does
    /// (`rail_app::hotkeys`), the effect reaching the engine. The effect.
    fn hotkey(&mut self, action: HotkeyAction) -> HotkeyEffect {
        let effect = dispatch(action, &self.tiling);
        match &effect {
            HotkeyEffect::Settings(next) => self.save(next.clone()),
            HotkeyEffect::Message(message) => self.send(message.clone()),
            HotkeyEffect::Nothing(_) => {}
        }
        effect
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

    fn never_placed(&self, n: u64) -> bool {
        self.control
            .placements()
            .iter()
            .all(|p| p.id != WindowId(n))
    }

    /// The RNG rolls table `n` has shown so far.
    fn rolls(&self, n: u32) -> u64 {
        self.control
            .frame(n)
            .and_then(|f| f.rng)
            .map_or(0, |rng| rng.seq)
    }
}

/// One slot, the whole width, `x` to `x + width` thousandths.
fn layout(id: &str, x: u32, width: u32) -> Layout {
    Layout {
        id: id.into(),
        name: id.to_uppercase(),
        slots: vec![Slot {
            id: "s1".into(),
            monitor: 0,
            rect: SlotRect {
                x,
                y: 0,
                width,
                height: 1000,
            },
            kind: SlotKind::Play,
            rooms: None,
            stack: true,
        }],
        auto_switch: Vec::new(),
    }
}

#[test]
fn hotkeys_move_only_permitted_rooms_tables() {
    let mut rig = Rig::new(Compliance::shipped().expect("shipped"));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "coinpoker");
    // Winamax: the policy says no to tiling (its HUD is allowed).
    open(&rig.feed, &rig.control, 9, "winamax");
    let winamax = rig.control.client_of(9);
    rig.run_for(Duration::from_millis(150));

    // Tiling off: re-tile and the layout keys do nothing.
    for action in [
        HotkeyAction::Retile,
        HotkeyAction::NextLayout,
        HotkeyAction::PreviousLayout,
    ] {
        assert!(matches!(rig.hotkey(action), HotkeyEffect::Nothing(_)));
    }
    rig.run_for(Duration::from_millis(150));
    assert!(rig.control.placements().is_empty());

    // "Tiling on / off": on, with two layouts of the user's.
    rig.tiling.layouts = vec![layout("left", 0, 500), layout("right", 500, 500)];
    assert!(matches!(
        rig.hotkey(HotkeyAction::ToggleTiling),
        HotkeyEffect::Settings(_)
    ));
    assert!(rig.tiling.enabled && rig.hud.tiler().is_some());
    assert_eq!(rig.settle(), [1, 2], "the auto grid; Winamax not");
    let grid = (rig.control.client_of(1), rig.control.client_of(2));

    // "Next layout": the first of the user's - both stacked in the left half.
    rig.hotkey(HotkeyAction::NextLayout);
    assert_eq!(rig.tiling.active, LayoutRef::Custom { id: "left".into() });
    rig.settle();
    for n in [1, 2] {
        let client = rig.control.client_of(n).expect("open");
        assert!(
            client.x + i32::try_from(client.width).expect("w") <= 960,
            "{n}: {client:?}"
        );
    }
    // Again: the right half.
    rig.hotkey(HotkeyAction::NextLayout);
    assert_eq!(rig.tiling.active, LayoutRef::Custom { id: "right".into() });
    assert_eq!(rig.settle(), [1, 2]);
    for n in [1, 2] {
        assert!(rig.control.client_of(n).expect("open").x >= 960, "{n}");
    }
    // "Previous layout" twice: back to the auto grid, the same places.
    rig.hotkey(HotkeyAction::PreviousLayout);
    rig.settle();
    rig.hotkey(HotkeyAction::PreviousLayout);
    assert_eq!(rig.tiling.active, LayoutRef::Auto);
    rig.settle();
    assert_eq!((rig.control.client_of(1), rig.control.client_of(2)), grid);

    // The user drags table 1 (the mouse down): pinned. "Re-tile" puts it
    // back.
    rig.control.press();
    rig.run_for(Duration::from_millis(250));
    rig.feed.push_line(
        r#"{"event":"window","table":1,"title":"T1 - $0.05/$0.10","x":700,"y":500,"width":640,"height":480,"minimized":false}"#,
    );
    rig.run_for(Duration::from_millis(150));
    rig.control.release();
    assert!(rig.hud.tiler().is_some_and(|t| t.pinned(WindowId(1))));
    assert_eq!(
        rig.hotkey(HotkeyAction::Retile),
        HotkeyEffect::Message(AppMessage::Retile)
    );
    assert!(rig.settle().contains(&1));
    // The grid's two places again (the tables may have swapped them).
    let mut now = [rig.control.client_of(1), rig.control.client_of(2)];
    let mut was = [grid.0, grid.1];
    now.sort_by_key(|r| r.map(|r| (r.y, r.x)));
    was.sort_by_key(|r| r.map(|r| (r.y, r.x)));
    assert_eq!(now, was);

    // No hotkey ever moved Winamax's table.
    assert!(rig.never_placed(9));
    assert_eq!(rig.control.client_of(9), winamax);

    // "Tiling on / off" again: off; a new table and "Re-tile" move nothing.
    rig.hotkey(HotkeyAction::ToggleTiling);
    assert!(!rig.tiling.enabled && rig.hud.tiler().is_none());
    let before = rig.control.placements().len();
    open(&rig.feed, &rig.control, 3, "pokerstars");
    assert!(matches!(
        rig.hotkey(HotkeyAction::Retile),
        HotkeyEffect::Nothing(_)
    ));
    rig.send(AppMessage::Retile);
    rig.run_for(Duration::from_millis(300));
    assert_eq!(rig.control.placements().len(), before, "off: no move");
    assert!(
        rig.sent
            .iter()
            .any(|m| matches!(m, HudMessage::TilingStatus { enabled: false, .. })),
        "the app hears it is off"
    );
}

/// The RNG on the shipped policy: no room gives an `RngPermit`, so "Roll
/// the RNG" does nothing - no overlay, no number - whatever is in front.
#[test]
fn roll_is_inert_without_an_rng_permit() {
    let mut rig = Rig::new(Compliance::shipped().expect("shipped"));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "coinpoker");
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            enabled: true,
            ..RngSettings::default()
        },
    });
    rig.run_for(Duration::from_millis(150));
    for n in [1, 2] {
        rig.control.focus(Some(n));
        assert_eq!(
            rig.hotkey(HotkeyAction::RollRng),
            HotkeyEffect::Message(AppMessage::RollRng)
        );
        rig.run_for(Duration::from_millis(50));
        assert_eq!(rig.hud.rng_value(WindowId(u64::from(n))), None);
        assert_eq!(rig.rolls(n), 0);
        assert_eq!(rig.hud.roll_focused(), None);
    }
    assert!(rig.hud.rng_only_tables().is_empty());
}

/// On a test policy that allows the RNG on PokerStars: the table in front
/// rolls, another does not; a Winamax table in front (no permit), the RNG
/// switched off and nothing in front all do nothing.
#[test]
fn roll_rolls_the_table_in_front_where_permitted() {
    let mut rig = Rig::new(allowing_rng(&["pokerstars"]));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "pokerstars");
    open(&rig.feed, &rig.control, 9, "winamax");
    let rng = RngSettings {
        enabled: true,
        ..RngSettings::default()
    };
    rig.send(AppMessage::RngChanged {
        settings: rng.clone(),
    });
    rig.run_for(Duration::from_millis(200));
    assert_eq!((rig.rolls(1), rig.rolls(2)), (1, 1), "a first roll each");

    rig.control.focus(Some(2));
    rig.hotkey(HotkeyAction::RollRng);
    rig.run_for(Duration::from_millis(30));
    assert_eq!((rig.rolls(1), rig.rolls(2)), (1, 2));

    // Winamax in front: no permit, no roll anywhere.
    rig.control.focus(Some(9));
    rig.hotkey(HotkeyAction::RollRng);
    rig.run_for(Duration::from_millis(30));
    assert_eq!((rig.rolls(1), rig.rolls(2)), (1, 2));
    assert_eq!(rig.hud.rng_value(WindowId(9)), None);

    // Another program in front.
    rig.control.focus(None);
    assert_eq!(rig.hud.roll_focused(), None);

    // The user's RNG off for PokerStars: nothing.
    rig.control.focus(Some(1));
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            per_room: [("pokerstars".to_owned(), false)].into_iter().collect(),
            ..rng
        },
    });
    rig.run_for(Duration::from_millis(30));
    let shown = rig.rolls(1);
    rig.hotkey(HotkeyAction::RollRng);
    rig.run_for(Duration::from_millis(30));
    assert_eq!(rig.hud.roll_focused(), None);
    assert!(rig.rolls(1) <= shown, "no new roll");
}
