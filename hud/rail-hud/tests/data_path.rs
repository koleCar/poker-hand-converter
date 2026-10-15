//! The HUD's data path against a real store (docs/RAIL-PLAN.md R3.7), on
//! every OS: the engine (`rail_hud::engine::Hud`) with a backend that keeps
//! every frame, the app's store written by `rail_store` as the app's import
//! writes it.
//!
//! - a room that allows statistics from the user's own hands only never
//!   counts a hand the user did not play;
//! - a table's numbers are over its hand's segment;
//! - a HUD attached to a table whose hands it was never told of (restarted,
//!   or opened after them) starts from the table's newest stored hand - a
//!   recent one only;
//! - a recompute's swap is read again on `stats_changed`;
//! - the user's own statistics (R2.10) in a design;
//! - the latency chain and the debug build's line.
//!
//! The hands: one PokerStars cash hand with no hero (observed, the corpus
//! file as it is) and the same hand under another number with a `Dealt to`
//! line (played) - the same six players at the same table and stakes.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use rail_config::stats::{Format, Group, HudPlace, Players, SampleDef, StatDef, Text, Unit};
use rail_hud::compliance::Compliance;
use rail_hud::data::StoreView;
use rail_hud::engine::{Hud, Input, Settings, WAITING};
use rail_hud::panel::{PanelDesign, StatSlot};
use rail_hud::platform::{
    OverlayFrame, Platform, PlatformError, ProcessInfo, Rect, TableEvent, TableMatcher,
    TableWindow, WindowId,
};
use rail_hud_ipc::protocol::{AppMessage, HandTiming, HudMessage, PlayerRef};
use rail_stats::custom::CustomDef;
use rail_store::import::ImportOptions;
use rail_store::{ImportedHand, Store, import_file};

const OBSERVED: &str = "fixtures/samples/pokerstars/01-cash-nlhe-6max-ante.txt";
const TABLE: &str = "Skat III 100-250 bb, Ante";

/// A backend whose windows a test sets and which keeps every frame.
#[derive(Default, Clone)]
struct Kept {
    windows: Rc<RefCell<Vec<TableWindow>>>,
    frames: Rc<RefCell<BTreeMap<WindowId, OverlayFrame>>>,
}

impl Platform for Kept {
    fn name(&self) -> &'static str {
        "kept"
    }
    fn find_tables(&mut self, _: &[TableMatcher]) -> Result<Vec<TableWindow>, PlatformError> {
        Ok(self.windows.borrow().clone())
    }
    fn track(&mut self, _: &TableWindow) -> Result<(), PlatformError> {
        Ok(())
    }
    fn untrack(&mut self, _: WindowId) {}
    fn poll_events(&mut self) -> Vec<TableEvent> {
        Vec::new()
    }
    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError> {
        self.frames.borrow_mut().insert(id, frame.clone());
        Ok(())
    }
    fn remove_overlay(&mut self, id: WindowId) {
        self.frames.borrow_mut().remove(&id);
    }
}

fn window(site: &str) -> TableWindow {
    TableWindow {
        id: WindowId(1),
        site: site.into(),
        process: ProcessInfo {
            pid: Some(1),
            name: "PokerStars.exe".into(),
        },
        title: format!("{TABLE} - $0.05/$0.10"),
        table: Some(TABLE.into()),
        size: None,
        client: Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 550,
        },
        scale_permille: 1000,
        minimized: false,
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("rail-hud-data-path-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

/// The two hand files in `dir`: (observed, played).
fn hand_files(dir: &Path) -> (PathBuf, PathBuf) {
    let text = std::fs::read_to_string(repo_root().join(OBSERVED)).expect("the corpus file");
    let played = text
        .replace("Game #109681344065", "Game #109681344066")
        .replace(
            "*** HOLE CARDS ***\n",
            "*** HOLE CARDS ***\nDealt to Nightfox82 [Ad 7d]\n",
        );
    assert!(played.contains("Dealt to Nightfox82"));
    let (observed_path, played_path) = (dir.join("observed.txt"), dir.join("played.txt"));
    std::fs::write(&observed_path, text).expect("write");
    std::fs::write(&played_path, played).expect("write");
    (observed_path, played_path)
}

fn text(value: &str) -> Text {
    Text {
        en: value.to_owned(),
        hr: value.to_owned(),
    }
}

/// A store with both hands (and a user's statistic counted); the hands as
/// the app tells the HUD of them: (observed, played).
fn store(name: &str) -> (Store, PathBuf, ImportedHand, ImportedHand) {
    let dir = scratch(name);
    let (observed, played) = hand_files(&dir);
    let path = dir.join(rail_store::FILE_NAME);
    let store = Store::open(&path).expect("store");
    let def = CustomDef {
        def: StatDef {
            id: "my_vpip".to_owned(),
            group: Group::Preflop,
            players: Players::Any,
            label: text("V"),
            name: text("My VPIP"),
            description: text("D"),
            formula: "pct(my_vpip, my_vpip_opp)".to_owned(),
            format: Format {
                unit: Unit::Percent,
                decimals: 1,
            },
            sample: SampleDef { of: None, min: 50 },
            bands: Vec::new(),
            hud: HudPlace::None,
        },
        predicate: Some(
            "any street = preflop and not bomb_pot and not (walk and big_blind) \
             => action in (call, bet, raise)"
                .to_owned(),
        ),
    };
    store
        .writer()
        .expect("writer")
        .write(move |tx| rail_store::custom::save_custom_stat(tx, None, &def, 1))
        .expect("save");
    let options = ImportOptions::default();
    import_file(&store, &observed, &options).expect("observed");
    import_file(&store, &played, &options).expect("played");
    rail_store::background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    let newest = |file: &Path| {
        store
            .reader()
            .newest_hands_of_file(file, 1)
            .expect("newest")
            .pop()
            .expect("a hand")
    };
    let (observed, played) = (newest(&observed), newest(&played));
    (store, path, observed, played)
}

fn players_of(hand: &ImportedHand) -> Vec<PlayerRef> {
    hand.players
        .iter()
        .map(|seat| PlayerRef {
            name: seat.player.clone(),
            scope: seat.scope.clone(),
            seat: Some(seat.seat),
            hero: seat.hero,
        })
        .collect()
}

fn announce(hand: &ImportedHand, timing: Option<HandTiming>) -> Input {
    Input::App(
        AppMessage::HandImported {
            site: hand.site.clone(),
            table: hand.table.clone(),
            hand_key: hand.hand_key.clone(),
            players: players_of(hand),
            timing,
        },
        Instant::now(),
    )
}

fn hud(path: &Path, backend: &Kept, settings: Settings) -> Hud {
    Hud::new(
        Box::new(backend.clone()),
        Compliance::shipped().expect("shipped"),
        StoreView::new(Some(path.to_owned())),
        settings,
    )
}

/// The `table_updated`s among `sent`: (hand key, players' hands).
fn updates(sent: &[HudMessage]) -> Vec<(Option<String>, Vec<i64>)> {
    sent.iter()
        .filter_map(|m| match m {
            HudMessage::TableUpdated {
                hand_key, players, ..
            } => Some((hand_key.clone(), players.iter().map(|p| p.hands).collect())),
            _ => None,
        })
        .collect()
}

/// PokerStars, Winamax and ACR allow statistics from the user's own hands
/// only: the HUD's numbers count the played hand and never the observed
/// one - whichever hand is announced - while the store counts both. Over
/// the table's segment: a player's hands elsewhere do not count.
#[test]
fn a_restricted_room_never_counts_observed_hands() {
    let (store, path, observed, played) = store("restricted");
    let all = store
        .reader()
        .hud_totals(
            &played.site,
            &players_of(&played)
                .iter()
                .map(|p| (p.name.as_str(), p.scope.as_str()))
                .collect::<Vec<_>>(),
            None,
        )
        .expect("all");
    assert!(all.iter().all(|t| t.hands() == 2), "the store counts both");
    for site in ["pokerstars", "winamax", "acr"] {
        let restrictions = Compliance::shipped()
            .expect("shipped")
            .permit(site)
            .expect("allowed")
            .restrictions()
            .own_hands_only;
        assert!(restrictions, "{site} allows own hands only");
    }
    let backend = Kept::default();
    backend.windows.borrow_mut().push(window("pokerstars"));
    let mut hud = hud(&path, &backend, Settings::default());
    let mut sent = Vec::new();
    hud.tick(Instant::now(), &mut |m| sent.push(m));
    for hand in [&played, &observed, &played] {
        let mut sent = Vec::new();
        hud.handle(announce(hand, None), &mut |m| sent.push(m));
        assert_eq!(
            updates(&sent),
            [(Some(hand.hand_key.clone()), vec![1; 6])],
            "{}: the played hand only",
            hand.hand_key
        );
        let frames = backend.frames.borrow();
        let frame = frames.get(&WindowId(1)).expect("a frame");
        assert!(frame.panels.iter().all(|p| p.hands == 1));
        assert_eq!(frame.panels.len(), 6);
    }
    hud.shutdown();
    store.close();
}

/// A HUD that attaches to a table it was never told of (restarted, or the
/// table opened before it) starts from the table's newest stored hand at
/// once - when that hand is recent; an old one would seat players who
/// left, so then the table waits for its next hand.
#[test]
fn a_restarted_hud_starts_from_the_stored_hand() {
    let (store, path, _, played) = store("restart");
    // The corpus hand was played in 2014: older than the default window.
    let backend = Kept::default();
    backend.windows.borrow_mut().push(window("pokerstars"));
    let mut waiting = hud(&path, &backend, Settings::default());
    let mut sent = Vec::new();
    waiting.tick(Instant::now(), &mut |m| sent.push(m));
    assert!(updates(&sent).is_empty(), "too old to be this table's");
    assert_eq!(
        backend.frames.borrow()[&WindowId(1)].status.as_deref(),
        Some(WAITING)
    );
    assert_eq!(waiting.health().waiting, 1);
    waiting.shutdown();

    let backend = Kept::default();
    backend.windows.borrow_mut().push(window("pokerstars"));
    let settings = Settings {
        restart_window: Duration::from_secs(20 * 366 * 24 * 3600),
        ..Settings::default()
    };
    let mut restarted = hud(&path, &backend, settings);
    let mut sent = Vec::new();
    restarted.tick(Instant::now(), &mut |m| sent.push(m));
    assert_eq!(
        updates(&sent),
        [(Some(played.hand_key.clone()), vec![1; 6])],
        "the newest hand of the table, at once"
    );
    assert_eq!(restarted.health().waiting, 0);
    let frames = backend.frames.borrow();
    let frame = &frames[&WindowId(1)];
    assert_eq!(frame.status, None);
    assert_eq!(frame.size, Some(6), "the hand's table size");
    assert_eq!(
        frame.seating.rotate_to, None,
        "PokerStars' preferred seat is unknown"
    );
    let mut seats: Vec<u32> = frame.panels.iter().filter_map(|p| p.seat).collect();
    seats.sort_unstable();
    assert_eq!(seats, [1, 2, 3, 4, 5, 6]);
    drop(frames);
    restarted.shutdown();
    store.close();
}

/// A recompute (R2.11) swaps new statistics in; `stats_changed` makes the
/// HUD read every table again and it shows the new numbers.
#[test]
fn a_recompute_swap_is_read_again() {
    let (store, path, _, played) = store("swap");
    let backend = Kept::default();
    backend.windows.borrow_mut().push(window("pokerstars"));
    let mut hud = hud(&path, &backend, Settings::default());
    hud.tick(Instant::now(), &mut |_| {});
    hud.handle(announce(&played, None), &mut |_| {});
    let right = backend.frames.borrow()[&WindowId(1)].panels.clone();

    // Older statistics (as an older build's counters would have them).
    store
        .writer()
        .expect("writer")
        .write(|tx| Ok(tx.execute("UPDATE player_rollups SET vpip = 0, pfr = 0", [])?))
        .expect("older numbers");
    let mut sent = Vec::new();
    hud.handle(Input::App(AppMessage::Resync, Instant::now()), &mut |m| {
        sent.push(m)
    });
    assert_eq!(updates(&sent).len(), 1);
    let older = backend.frames.borrow()[&WindowId(1)].panels.clone();
    assert_ne!(older, right, "the HUD shows what the store has");

    // The recompute: worked out beside, swapped in, the epoch moved on.
    let epoch = store.reader().stats_status().expect("status").epoch;
    store
        .writer()
        .expect("writer")
        .write(|tx| rail_store::stats::begin_rebuild(tx))
        .expect("begin");
    rail_store::background::drain(store.reader(), &store.writer().expect("writer")).expect("drain");
    let now = store.reader().stats_status().expect("status").epoch;
    assert!(now > epoch, "swapped");
    let mut sent = Vec::new();
    hud.handle(
        Input::App(AppMessage::StatsChanged { epoch: now }, Instant::now()),
        &mut |m| sent.push(m),
    );
    assert_eq!(
        updates(&sent),
        [(None, vec![1; 6])],
        "every table read again"
    );
    assert_eq!(backend.frames.borrow()[&WindowId(1)].panels, right);
    hud.shutdown();
    store.close();
}

/// A design with the user's own statistic (R2.10; R3.9's editor makes
/// them): its value read from their counts, own hands only on a restricted
/// room.
#[test]
fn a_users_statistic_in_a_design() {
    let (store, path, _, played) = store("custom");
    let backend = Kept::default();
    backend.windows.borrow_mut().push(window("pokerstars"));
    let mut hud = hud(&path, &backend, Settings::default());
    hud.tick(Instant::now(), &mut |_| {});
    let mut design = PanelDesign::default();
    design.stats.push(StatSlot::fixed("my_vpip"));
    hud.set_design(design, &mut |_| {});
    hud.handle(announce(&played, None), &mut |_| {});
    let frames = backend.frames.borrow();
    let panels = &frames[&WindowId(1)].panels;
    let shown: BTreeMap<String, String> = panels
        .iter()
        .map(|p| {
            let cell = p
                .stats
                .iter()
                .find(|c| c.id == "my_vpip")
                .expect("the user's statistic");
            let vpip = p.stats.iter().find(|c| c.id == "vpip").expect("vpip");
            assert_eq!(cell.text, vpip.text, "{}: same predicate as VPIP", p.player);
            (p.player.clone(), cell.text.clone())
        })
        .collect();
    // One hand each (the played one): VPIP is 0 or 100.
    assert!(shown.values().all(|v| v == "0" || v == "100"), "{shown:?}");
    assert!(shown.values().any(|v| v == "100"));
    drop(frames);
    hud.shutdown();
    store.close();
}

/// Every hand's chain goes back to the app in `table_updated`; a debug
/// build also shows it on the table, a release build never.
#[test]
fn the_latency_chain_and_the_debug_line() {
    let (store, path, _, played) = store("chain");
    let backend = Kept::default();
    backend.windows.borrow_mut().push(window("pokerstars"));
    let mut hud = hud(&path, &backend, Settings::default());
    hud.tick(Instant::now(), &mut |_| {});
    let now = rail_hud::engine::unix_us();
    let timing = HandTiming {
        noticed_us: Some(now - 520_000),
        imported_us: Some(now - 10_000),
        sent_us: Some(now - 2_000),
    };
    let mut sent = Vec::new();
    hud.handle(announce(&played, Some(timing)), &mut |m| sent.push(m));
    let chain = sent
        .iter()
        .find_map(|m| match m {
            HudMessage::TableUpdated { chain, .. } => *chain,
            _ => None,
        })
        .expect("a chain");
    assert_eq!(
        (chain.noticed_us, chain.imported_us, chain.sent_us),
        (timing.noticed_us, timing.imported_us, timing.sent_us)
    );
    assert!(chain.arrived_us <= chain.read_us && chain.read_us <= chain.painted_us);
    assert!(chain.total_us().is_some_and(|t| t >= 520_000));
    let debug = backend.frames.borrow()[&WindowId(1)].debug.clone();
    if cfg!(debug_assertions) {
        let line = debug.expect("a debug build shows the chain");
        assert!(line.starts_with("debug: file to HUD 52"), "{line}");
        assert!(line.is_ascii());
    } else {
        assert_eq!(debug, None, "never in a release build");
    }
    // A re-read no hand caused has no chain.
    let mut sent = Vec::new();
    hud.handle(Input::App(AppMessage::Resync, Instant::now()), &mut |m| {
        sent.push(m)
    });
    assert!(
        sent.iter()
            .all(|m| matches!(m, HudMessage::TableUpdated { chain: None, .. }))
    );
    hud.shutdown();
    store.close();
}
