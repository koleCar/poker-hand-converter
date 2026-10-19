//! (R3.9) HUD designs on Windows with real windows, in CI on the Windows
//! runner. Elsewhere this file is empty.
//!
//! The HUD's engine in this process over the real Windows backend (shared
//! with the test, which reads what each overlay painted), the table
//! simulator's window posing as an allowed room, and a real store the test
//! writes as the app does - a user's statistic whose predicate reads the
//! cards, a design of the user's - while the engine reads it read-only:
//!
//! - `an_assigned_design_changes_what_the_overlay_draws` (posing as
//!   Winamax): with nothing assigned the overlay draws the cash preset (R3.4's
//!   six statistics, three to a row); the user's design assigned to every
//!   room and `layout_changed` told, the same overlay draws the design's
//!   cells - its four columns make every panel wider - its card-split
//!   statistic included (Winamax allows it);
//! - `a_card_split_statistic_is_refused_on_pokerstars`: the same assignment
//!   (it reached the store from elsewhere - the editor would refuse it
//!   there) posing as PokerStars: the renderer drops the card-split
//!   statistic and draws the rest.
//!
//! Every step prints what it saw (`step ok: ...`).

#![cfg(windows)]

mod support;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::design::{Cell, Presets};
use rail_hud::engine::{Hud, Input, Settings};
use rail_hud::platform::windows::{OverlayInfo, WindowsBackend};
use rail_hud::platform::{
    OverlayFrame, Platform, PlatformError, TableEvent, TableMatcher, TableWindow, WindowId,
};
use rail_hud_ipc::protocol::{AppMessage, PlayerRef};
use rail_stats::custom::CustomDef;
use serde_json::Value;
use support::{Seen, Sim, simulator, title_regex, wait_for};

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The Windows backend, shared: the engine draws through it, the test
/// reads what it painted.
struct Shared(Rc<RefCell<WindowsBackend>>);

impl Platform for Shared {
    fn name(&self) -> &'static str {
        "windows"
    }
    fn find_tables(
        &mut self,
        matchers: &[TableMatcher],
    ) -> Result<Vec<TableWindow>, PlatformError> {
        self.0.borrow_mut().find_tables(matchers)
    }
    fn track(&mut self, window: &TableWindow) -> Result<(), PlatformError> {
        self.0.borrow_mut().track(window)
    }
    fn untrack(&mut self, id: WindowId) {
        self.0.borrow_mut().untrack(id);
    }
    fn follow(&mut self, window: &TableWindow) {
        self.0.borrow_mut().follow(window);
    }
    fn poll_events(&mut self) -> Vec<TableEvent> {
        self.0.borrow_mut().poll_events()
    }
    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError> {
        self.0.borrow_mut().overlay(id, frame)
    }
    fn remove_overlay(&mut self, id: WindowId) {
        self.0.borrow_mut().remove_overlay(id);
    }
}

fn words(s: &str) -> Text {
    Text {
        en: s.into(),
        hr: s.into(),
    }
}

/// A made-up statistic of the user's that reads the cards.
fn pairs() -> CustomDef {
    CustomDef {
        def: StatDef {
            id: "pair_raise".into(),
            group: Group::Preflop,
            players: Players::Any,
            label: words("PR"),
            name: words("Pairs raised"),
            description: words("made up"),
            formula: "pct(pair_raise, pair_raise_opp)".into(),
            format: Format {
                unit: Unit::Percent,
                decimals: 1,
            },
            sample: SampleDef { of: None, min: 10 },
            bands: Vec::new(),
            hud: HudPlace::None,
        },
        predicate: Some("first street = preflop and pocket_pair => action = raise".into()),
    }
}

/// The store, as the app keeps it: the user's statistic and design saved
/// (assigned or not).
fn store(name: &str, assigned: bool) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("rail-hud-designs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join(rail_store::FILE_NAME);
    let store = rail_store::Store::open(&path).expect("store");
    let writer = store.writer().expect("writer");
    let def = pairs();
    writer
        .write(move |tx| rail_store::custom::save_custom_stat(tx, None, &def, 1))
        .expect("the user's statistic");
    writer
        .save_hud_layout("d-wide", &wide().to_json())
        .expect("the design");
    if assigned {
        assign(&writer);
    }
    drop(writer);
    store.close();
    (path, dir)
}

fn assign(writer: &rail_store::WriterHandle) {
    writer
        .set_hud_layout_assignment("*", 0, "*", Some("d-wide"))
        .expect("assigned");
}

/// Four to a row: VPIP, PFR, 3B, Steal, and the user's card-split one.
fn wide() -> rail_hud::design::HudDesign {
    let mut design = Presets::shipped().get("cash").expect("cash").design.clone();
    design.name = "Wide".into();
    design.columns = 4;
    design.cells = ["vpip", "pfr", "three_bet", "steal", "pair_raise"]
        .into_iter()
        .map(|stat| Cell {
            stat: stat.into(),
            when: None,
        })
        .collect();
    design
}

const CASH: [&str; 6] = [
    "vpip",
    "pfr",
    "three_bet",
    "fold_to_three_bet",
    "cbet_flop",
    "aggression_frequency",
];

/// The engine, the backend and the simulator's one 6-seat table posing
/// as `site`, attached, with a hand announced as the app does.
struct Rig {
    hud: Hud,
    backend: Rc<RefCell<WindowsBackend>>,
    window: WindowId,
    sim: Sim,
}

impl Rig {
    fn start(site: &str, db: &std::path::Path) -> Self {
        let sim_path = simulator();
        let regex = title_regex(&sim_path);
        let mut sim = Sim::start(
            &sim_path,
            &format!("designs-{site}"),
            &[
                "--tables", "1", "--sizes", "6", "--window", "640x480", "--speed", "60", "--seed",
                "41",
            ],
        );
        let mut seen = Seen::default();
        sim.until(
            &mut seen,
            Duration::from_secs(90),
            "a window with a hand",
            |s| s.windows.len() == 1 && s.hands.len() == 1,
        );
        let backend = Rc::new(RefCell::new(WindowsBackend::default()));
        let compliance = Compliance::shipped().expect("shipped");
        let store_site = compliance.store_site(site);
        let mut hud = Hud::new(
            Box::new(Shared(Rc::clone(&backend))),
            compliance,
            StoreView::new(Some(db.to_path_buf())),
            Settings::default(),
        );
        hud.add_simulator_room(site, regex::Regex::new(&regex).expect("regex"));
        let window = wait_for(Duration::from_secs(30), "attached", || {
            hud.tick(Instant::now(), &mut |_| {});
            std::thread::sleep(Duration::from_millis(50));
            hud.attached()
                .first()
                .map(|(id, _)| *id)
                .ok_or_else(|| "not yet".to_owned())
        });
        eprintln!("step ok: {site}: the simulator's table attached");
        let hand: Value = seen.hands.values().next().expect("a hand").clone();
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
        hud.handle(
            Input::App(
                AppMessage::HandImported {
                    site: store_site,
                    table: hand["tableName"].as_str().map(str::to_owned),
                    hand_key: hand["handKey"].as_str().unwrap_or_default().to_owned(),
                    players,
                    timing: None,
                },
                Instant::now(),
            ),
            &mut |_| {},
        );
        Self {
            hud,
            backend,
            window,
            sim,
        }
    }

    /// What the overlay painted, once every panel shows `cells`.
    fn painted(&mut self, what: &str, cells: &[&str]) -> OverlayInfo {
        let want: Vec<String> = cells.iter().map(|s| (*s).to_owned()).collect();
        let info = wait_for(Duration::from_secs(20), what, || {
            self.hud.tick(Instant::now(), &mut |_| {});
            std::thread::sleep(Duration::from_millis(50));
            let info = self
                .backend
                .borrow()
                .overlay_info(self.window)
                .ok_or("no overlay")?;
            let ok = info.renders >= 1
                && !info.seat_cells.is_empty()
                && info.seat_cells.iter().all(|(_, shown)| *shown == want);
            if ok {
                Ok(info)
            } else {
                Err(format!("{:?}", info.seat_cells))
            }
        });
        eprintln!(
            "step ok: {what}: {} panels, each {:?}, {} wide",
            info.seat_panels.len(),
            cells,
            info.seat_panels.first().map_or(0, |(_, r)| r.width)
        );
        info
    }
}

#[test]
fn an_assigned_design_changes_what_the_overlay_draws() {
    let _serial = serial();
    let (db, dir) = store("assigned", false);
    let mut rig = Rig::start("winamax", &db);
    let before = rig.painted("nothing assigned: the cash preset", &CASH);
    // The editor assigns the design to every room; the app tells the HUD.
    let app = rail_store::Store::open(&db).expect("the app's store");
    assign(&app.writer().expect("writer"));
    rig.hud.handle(
        Input::App(AppMessage::LayoutChanged, Instant::now()),
        &mut |_| {},
    );
    let after = rig.painted(
        "assigned: the user's design",
        &["vpip", "pfr", "three_bet", "steal", "pair_raise"],
    );
    assert_eq!(before.seat_panels.len(), after.seat_panels.len());
    for ((_, a), (_, b)) in before.seat_panels.iter().zip(&after.seat_panels) {
        assert!(b.width > a.width, "four to a row is wider: {a:?} -> {b:?}");
    }
    assert!(after.renders > before.renders);
    rig.hud.shutdown();
    drop(rig);
    drop(app);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_card_split_statistic_is_refused_on_pokerstars() {
    let _serial = serial();
    let (db, dir) = store("stars", true);
    let mut rig = Rig::start("pokerstars", &db);
    rig.painted(
        "PokerStars: the design without its card-split statistic",
        &["vpip", "pfr", "three_bet", "steal"],
    );
    rig.hud.shutdown();
    let _ = rig.sim.child.kill();
    drop(rig);
    let _ = std::fs::remove_dir_all(&dir);
}
