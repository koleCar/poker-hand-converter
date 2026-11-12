//! (T4, docs/research/TABLE-TILING.md §4.4, §5) The RNG overlay through the
//! HUD's engine, headless on the sim backend, the overlays' pointer run
//! through the shared drag ([`SimControl::click`], [`SimControl::drag`]).
//!
//! No shipped room allows the RNG yet (`rng.allowed` is `null` or `false`
//! everywhere), so the engine runs on a test policy - the shipped
//! `sites.json` with `rng.allowed: true` for the rooms the simulator's
//! tables pose as ([`Compliance::from_sites_json`], never reachable from
//! the binary). With it:
//!
//! - a table of a room whose HUD is allowed (PokerStars) shows the RNG
//!   beside its panels; a room whose HUD is refused but whose RNG is
//!   allowed (GGPoker, in this test policy) gets an RNG-only overlay - no
//!   panel, under the RNG's permit alone; a room without an RNG permit
//!   (Winamax) shows none; the number's colour is its band's;
//! - a new hand at a table rolls it (and only it), a click on the widget
//!   rolls it, the timer rolls it; each trigger switched off rolls nothing;
//! - a drag moves the widget for every table of that room and size and
//!   tells the app (`rng_position_changed`), never as a seat's panel;
//! - with the panels off (the Free plan) every table of an allowed room
//!   shows the RNG alone;
//! - switched off, or switched off for a room, the RNG goes; and on the
//!   shipped policy nothing is ever drawn.

use std::time::{Duration, Instant};

use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Input, Settings};
use rail_hud::platform::sim::{SimBackend, SimControl, SimFeed};
use rail_hud::platform::{OverlayFrame, RNG_SLOT, Rect, WindowId};
use rail_hud::scene::Rgba;
use rail_hud_ipc::protocol::{AppMessage, HudMessage, PlayerRef};
use rail_hud_ipc::settings::{RngBand, RngSettings, RngTriggers};

/// The shipped policy with `rng.allowed: true` for `sites`.
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

/// The simulator's table `n`, posing as `site`, at a place of its own.
fn open(feed: &SimFeed, control: &SimControl, n: u32, site: &str) {
    control.pose(n, site);
    let title = format!("T{n} - $0.05/$0.10");
    feed.push_line(&format!(
        r#"{{"event":"table","table":{n},"title":"{title}","size":6}}"#
    ));
    feed.push_line(&format!(
        r#"{{"event":"window","table":{n},"title":"{title}","x":{x},"y":{y},"width":800,"height":580,"minimized":false}}"#,
        x = 40 * n,
        y = 30 * n
    ));
}

struct Rig {
    hud: Hud,
    feed: SimFeed,
    control: SimControl,
    sent: Vec<HudMessage>,
}

impl Rig {
    fn new(compliance: Compliance) -> Self {
        let (backend, feed) = SimBackend::new("pokerstars");
        let control = backend.control();
        feed.push_line(r#"{"event":"started","titleRegex":"^(?P<table>.+?) - .*$"}"#);
        let settings = Settings {
            tick: Duration::from_millis(5),
            find_every: Duration::from_millis(20),
            find_every_notified: Duration::from_millis(20),
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

    fn step(&mut self) {
        self.run_for(Duration::from_millis(100));
    }

    fn frame(&self, n: u32) -> Option<OverlayFrame> {
        self.control.frame(n)
    }

    /// Table `n`'s roll count, from its frame.
    fn seq(&self, n: u32) -> u64 {
        self.frame(n).and_then(|f| f.rng).map_or(0, |rng| rng.seq)
    }

    /// The middle of table `n`'s RNG widget, client pixels.
    fn widget(&self, n: u32) -> (i32, i32) {
        let scene = self.control.scene(n).expect("a scene");
        let rect = scene.rng.expect("the widget").rect;
        middle(&rect)
    }

    fn hand(&mut self, site: &str, n: u32) {
        self.send(AppMessage::HandImported {
            site: site.into(),
            table: Some(format!("T{n}")),
            hand_key: format!("{site}:{n}:{}", self.sent.len()),
            players: vec![PlayerRef::named("Villain").at(2)],
            timing: None,
        });
    }

    fn rng_moves(&self) -> Vec<(String, u32, u32, u32)> {
        self.sent
            .iter()
            .filter_map(|m| match m {
                HudMessage::RngPositionChanged { site, size, x, y } => {
                    Some((site.clone(), *size, *x, *y))
                }
                _ => None,
            })
            .collect()
    }
}

fn middle(r: &Rect) -> (i32, i32) {
    (
        r.x + i32::try_from(r.width / 2).unwrap_or(0),
        r.y + i32::try_from(r.height / 2).unwrap_or(0),
    )
}

/// On, 1 - 100, three named bands.
fn on() -> RngSettings {
    RngSettings {
        enabled: true,
        bands: vec![
            RngBand {
                up_to: 30,
                colour: "#5c9ded".into(),
                label: Some("fold".into()),
            },
            RngBand {
                up_to: 60,
                colour: "#e0e0e0".into(),
                label: Some("call".into()),
            },
            RngBand {
                up_to: 100,
                colour: "#f0a040".into(),
                label: None,
            },
        ],
        ..RngSettings::default()
    }
}

/// Where it draws, and in what colour: beside the panels of an allowed
/// room, alone over a room whose HUD is refused, nowhere without the
/// room's RNG permit; a fresh roll as each table shows it; off again, it
/// goes.
#[test]
fn where_the_rng_draws() {
    let mut rig = Rig::new(allowing_rng(&["pokerstars", "ggpoker"]));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "ggpoker");
    open(&rig.feed, &rig.control, 3, "winamax");
    rig.step();
    // Before any settings: panels as ever, no RNG anywhere.
    assert!(rig.frame(1).expect("attached").rng.is_none());
    assert!(rig.frame(2).is_none(), "refused, nothing drawn");
    assert!(rig.frame(3).expect("attached").rng.is_none());
    assert!(rig.sent.contains(&HudMessage::AttachRefused {
        site: "ggpoker".into(),
        window: 2,
        reason: rail_hud_ipc::protocol::RefusalReason::Prohibited,
    }));

    let settings = on();
    rig.send(AppMessage::RngChanged {
        settings: settings.clone(),
    });
    rig.step();
    let stars = rig.frame(1).expect("attached");
    let rng = stars.rng.as_ref().expect("beside the panels");
    assert!(stars.permit.is_some());
    assert_eq!(rng.permit.site(), "pokerstars");
    assert_eq!(rng.seq, 1, "a fresh roll");
    assert!((1..=100).contains(&rng.value));
    let band = settings.band_for(rng.value).expect("a band");
    assert_eq!(rng.colour, Rgba::from_hex(&band.colour).expect("hex"));
    assert_eq!(rng.label, band.label);
    assert_eq!(rng.digits, 3);
    assert_eq!(rig.hud.rng_value(WindowId(1)), Some(rng.value));

    let gg = rig.frame(2).expect("the RNG alone");
    assert!(gg.permit.is_none(), "no HUD permit");
    assert!(gg.panels.is_empty() && gg.status.is_none() && gg.legend.is_empty());
    assert_eq!(gg.rng.as_ref().expect("rng").permit.site(), "ggpoker");
    let scene = rig.control.scene(2).expect("a scene");
    assert!(scene.seat_panels.is_empty() && scene.legend.is_none());
    assert_eq!(scene.panels.len(), 1, "the widget alone takes clicks");
    assert_eq!(rig.hud.rng_only_tables(), [WindowId(2)]);
    assert_eq!(
        rig.hud.attached().len(),
        2,
        "the RNG-only table is not attached"
    );

    assert!(rig.frame(3).expect("attached").rng.is_none(), "no permit");
    assert_eq!(rig.hud.rng_value(WindowId(3)), None);

    // The user switches GGPoker off: its overlay goes.
    let mut off_there = settings.clone();
    off_there.per_room.insert("ggpoker".into(), false);
    rig.send(AppMessage::RngChanged {
        settings: off_there,
    });
    rig.step();
    assert!(rig.frame(2).is_none());
    assert!(rig.frame(1).expect("attached").rng.is_some());
    // Off: gone everywhere, the panels stay.
    rig.send(AppMessage::RngChanged {
        settings: RngSettings::default(),
    });
    rig.step();
    assert!(rig.frame(1).expect("attached").rng.is_none());
    assert!(rig.frame(2).is_none());
    assert!(rig.hud.rng_only_tables().is_empty());
    // A refused object changes nothing.
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            enabled: true,
            max: 0,
            ..RngSettings::default()
        },
    });
    rig.step();
    assert!(rig.frame(1).expect("attached").rng.is_none());
}

/// On the shipped policy no room allows the RNG: whatever the settings,
/// nothing is drawn.
#[test]
fn nothing_without_a_permit() {
    let mut rig = Rig::new(Compliance::shipped().expect("shipped"));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "ggpoker");
    rig.send(AppMessage::RngChanged { settings: on() });
    rig.step();
    assert!(rig.frame(1).expect("attached").rng.is_none());
    assert!(rig.frame(2).is_none());
    assert!(rig.hud.rng_only_tables().is_empty());
    assert_eq!(rig.hud.rng_value(WindowId(1)), None);
}

/// The triggers: a new hand at a table rolls that table only (attached or
/// RNG-only; a hand of an unknown table rolls nothing), a click on the
/// widget rolls it, the timer rolls it; each switched off, nothing.
#[test]
fn new_hand_click_and_timer_roll() {
    let mut rig = Rig::new(allowing_rng(&["pokerstars", "ggpoker"]));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "ggpoker");
    rig.send(AppMessage::RngChanged { settings: on() });
    rig.step();
    assert_eq!((rig.seq(1), rig.seq(2)), (1, 1));

    // A new hand.
    rig.hand("pokerstars", 1);
    rig.step();
    assert_eq!((rig.seq(1), rig.seq(2)), (2, 1));
    rig.hand("ggpoker", 2);
    rig.step();
    assert_eq!((rig.seq(1), rig.seq(2)), (2, 2), "the RNG-only table too");
    assert!(
        !rig.sent.iter().any(|m| matches!(
            m,
            HudMessage::TableUpdated { site, .. } if site == "ggpoker"
        )),
        "a refused room's hand is never read"
    );
    rig.hand("pokerstars", 9);
    rig.step();
    assert_eq!((rig.seq(1), rig.seq(2)), (2, 2), "no such table");

    // A click on the widget.
    for n in [1, 2] {
        let at = rig.widget(n);
        rig.control.click(n, at);
    }
    rig.step();
    assert_eq!((rig.seq(1), rig.seq(2)), (3, 3));
    assert!(
        !rig.sent
            .iter()
            .any(|m| matches!(m, HudMessage::OpenPopup { .. })),
        "a click on the RNG is not a panel's"
    );
    // A click beside it: nothing.
    rig.control.click(2, (5, 570));
    rig.step();
    assert_eq!(rig.seq(2), 3);

    // Triggers off: neither a hand nor a click rolls.
    let quiet = RngSettings {
        triggers: RngTriggers {
            new_hand: false,
            click: false,
            timer_secs: None,
        },
        ..on()
    };
    rig.send(AppMessage::RngChanged { settings: quiet });
    rig.step();
    let before = (rig.seq(1), rig.seq(2));
    assert_eq!(before, (3, 3), "the same range keeps the numbers");
    rig.hand("pokerstars", 1);
    let at = rig.widget(2);
    rig.control.click(2, at);
    rig.step();
    assert_eq!((rig.seq(1), rig.seq(2)), before);

    // The timer: every second, each table.
    let timed = RngSettings {
        triggers: RngTriggers {
            new_hand: false,
            click: false,
            timer_secs: Some(1),
        },
        ..on()
    };
    rig.send(AppMessage::RngChanged { settings: timed });
    rig.run_for(Duration::from_millis(300));
    assert_eq!((rig.seq(1), rig.seq(2)), before, "not yet");
    rig.run_for(Duration::from_millis(2000));
    assert!(rig.seq(1) > before.0 && rig.seq(2) > before.1);

    // A new range: every table rolls afresh in it.
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            enabled: true,
            min: 0,
            max: 9,
            bands: vec![RngBand {
                up_to: 9,
                colour: "#ffffff".into(),
                label: None,
            }],
            ..RngSettings::default()
        },
    });
    rig.step();
    for n in [1, 2] {
        let rng = rig.frame(n).and_then(|f| f.rng).expect("rng");
        assert!(rng.value <= 9 && rng.digits == 1 && rng.seq == 1, "{rng:?}");
    }
}

/// A drag moves the widget - on every table of that room and size, the
/// app told - and is never a seat's panel's; a press that stays is a click.
#[test]
fn a_drag_moves_the_widget_for_the_room_and_size() {
    let mut rig = Rig::new(allowing_rng(&["pokerstars", "ggpoker"]));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "ggpoker");
    open(&rig.feed, &rig.control, 3, "ggpoker");
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            triggers: RngTriggers {
                click: false,
                ..RngTriggers::default()
            },
            ..on()
        },
    });
    rig.step();
    let (x, y) = rig.widget(2);
    let seq = rig.seq(2);
    rig.control.drag(2, (x, y), (x - 300, y + 200));
    rig.step();
    let moves = rig.rng_moves();
    assert_eq!(moves.len(), 1, "{:?}", rig.sent);
    let (site, size, px, py) = moves[0].clone();
    assert_eq!((site.as_str(), size), ("ggpoker", 6));
    assert!(
        !rig.sent
            .iter()
            .any(|m| matches!(m, HudMessage::SeatPositionChanged { .. })),
        "not a seat's panel"
    );
    assert_eq!(rig.seq(2), seq, "a drag is not a roll");
    for n in [2, 3] {
        let frame = rig.frame(n).expect("the RNG alone");
        assert_eq!(
            frame.seating.positions.get(&RNG_SLOT),
            Some(&(px, py)),
            "{n}"
        );
        let scene = rig.control.scene(n).expect("scene");
        let rect = scene.rng.expect("drawn").rect;
        // Thousandths to pixels and back: within a pixel or two.
        let (cx, cy) = rail_hud::layout::center_permille(&rect, 800, 580);
        assert!(
            cx.abs_diff(px) <= 2 && cy.abs_diff(py) <= 2,
            "{n}: {cx} {cy}"
        );
    }
    // PokerStars' tables keep their own spot.
    let stars = rig.frame(1).expect("attached");
    assert!(!stars.seating.positions.contains_key(&RNG_SLOT));
    // The widget on an attached table, dragged: its room's position.
    let (x, y) = rig.widget(1);
    rig.control.drag(1, (x, y), (x - 200, y + 100));
    rig.step();
    let moves = rig.rng_moves();
    assert_eq!(moves.len(), 2);
    assert_eq!((moves[1].0.as_str(), moves[1].1), ("pokerstars", 6));
    assert_eq!(
        rig.frame(1)
            .expect("attached")
            .seating
            .positions
            .get(&RNG_SLOT),
        Some(&(moves[1].2, moves[1].3))
    );
    // Within the drag threshold it stays a click (and clicks are off).
    let (x, y) = rig.widget(3);
    rig.control.drag(3, (x, y), (x + 2, y + 1));
    rig.step();
    assert_eq!(rig.rng_moves().len(), 2);
}

/// The panels off (the Free plan): every table of a room the RNG may draw
/// on shows it alone, and panels allowed again bring the panels back with
/// the RNG beside them.
#[test]
fn panels_off_shows_the_rng_alone() {
    let mut rig = Rig::new(allowing_rng(&["pokerstars"]));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    rig.send(AppMessage::RngChanged { settings: on() });
    rig.step();
    assert!(rig.frame(1).expect("attached").permit.is_some());
    rig.send(AppMessage::Panels { allowed: false });
    rig.step();
    let alone = rig.frame(1).expect("the RNG alone");
    assert!(alone.permit.is_none() && alone.panels.is_empty());
    assert!(alone.rng.is_some());
    assert!(rig.hud.attached().is_empty());
    assert_eq!(rig.hud.rng_only_tables(), [WindowId(1)]);
    // A hand still rolls it (nothing is read).
    let seq = rig.seq(1);
    rig.hand("pokerstars", 1);
    rig.step();
    assert_eq!(rig.seq(1), seq + 1);
    rig.send(AppMessage::Panels { allowed: true });
    rig.step();
    let back = rig.frame(1).expect("attached again");
    assert!(back.permit.is_some() && back.rng.is_some());
    assert!(rig.hud.rng_only_tables().is_empty());
    // The table closes: its overlay goes.
    rig.feed.push_line(r#"{"event":"closed","table":1}"#);
    rig.step();
    assert!(rig.frame(1).is_none());
    assert_eq!(rig.hud.rng_value(WindowId(1)), None);
}

/// (T5 follow-up) The user's size and opacity reach every table's widget
/// at once - a larger plate, fainter - without a new roll.
#[test]
fn size_and_opacity_redraw_the_widget() {
    let mut rig = Rig::new(allowing_rng(&["pokerstars", "ggpoker"]));
    open(&rig.feed, &rig.control, 1, "pokerstars");
    open(&rig.feed, &rig.control, 2, "ggpoker");
    rig.send(AppMessage::RngChanged { settings: on() });
    rig.step();
    let before: Vec<Rect> = [1, 2]
        .iter()
        .map(|&n| {
            rig.control
                .scene(n)
                .and_then(|s| s.rng)
                .expect("drawn")
                .rect
        })
        .collect();
    let seqs = [rig.seq(1), rig.seq(2)];
    rig.send(AppMessage::RngChanged {
        settings: RngSettings {
            scale: 150,
            opacity: 50,
            ..on()
        },
    });
    rig.step();
    for (i, n) in [1_u32, 2].into_iter().enumerate() {
        let rng = rig.frame(n).and_then(|f| f.rng).expect("rng");
        assert_eq!((rng.scale_pct, rng.opacity_pct), (150, 50));
        let drawn = rig.control.scene(n).and_then(|s| s.rng).expect("drawn");
        assert!(drawn.rect.width > before[i].width * 13 / 10, "{drawn:?}");
        assert!(drawn.rect.height > before[i].height * 13 / 10, "{drawn:?}");
        assert!(drawn.colour.a < 200, "fainter: {drawn:?}");
    }
    assert_eq!([rig.seq(1), rig.seq(2)], seqs, "not a new roll");
}
