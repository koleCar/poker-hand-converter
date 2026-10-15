//! The HUD's data path end to end, headless (docs/RAIL-PLAN.md R3.2), on
//! every OS in CI:
//!
//! ```text
//! rail-hud-sim --headless --out <folder>   writes hands; stdout -> events file
//!   -> rail_watch::Watcher -> rail_store (the app's import)
//!   -> Reader::newest_hands_of_file -> Supervisor::send(hand_imported)
//!   -> rail-hud (sim backend posing as a room, compliance mode)
//!   -> Reader::hud_totals read-only -> table_updated
//! ```
//!
//! The test plays the app (watcher, store, supervisor - the same calls the
//! app makes) and starts the real `rail-hud` binary through the real
//! supervisor; the simulator's windows come from its event stream (the
//! fake backend). Latency is reported three ways: the hand's bytes written
//! (the simulator's `atMs`) to `table_updated` read by the app; the app's
//! `hand_imported` sent to `table_updated` read; and inside the HUD, the
//! message's arrival to the rollups re-read (`rereadUs`).
//!
//! Bigger runs on a development machine:
//! `RAIL_HUD_E2E_TABLES=12 RAIL_HUD_E2E_HANDS=96 RAIL_HUD_E2E_SPEED=30 \
//!  cargo test -p rail-hud --test e2e -- --nocapture`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rail_hud_ipc::protocol::{AppMessage, HudMessage, PlayerRef, RefusalReason};
use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
use rail_store::Store;
use rail_watch::{WatchConfig, WatchEvent, Watcher};
use serde_json::Value;

fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn env_number(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// The simulator binary, built next to this crate's (same profile). A
/// workspace `cargo test` has built it; alone, it is built here.
fn simulator() -> PathBuf {
    let dir = Path::new(env!("CARGO_BIN_EXE_rail-hud"))
        .parent()
        .expect("target dir")
        .to_path_buf();
    let sim = dir.join(format!("rail-hud-sim{}", std::env::consts::EXE_SUFFIX));
    if !sim.is_file() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let mut build = Command::new(cargo);
        build.args(["build", "-p", "rail-hud-sim"]);
        if dir.file_name().is_some_and(|n| n == "release") {
            build.arg("--release");
        }
        let status = build.status().expect("cargo runs");
        assert!(status.success(), "cargo build -p rail-hud-sim");
    }
    assert!(sim.is_file(), "{} is not built", sim.display());
    sim
}

/// A `table_updated`: the players' hands, the re-read in microseconds, and
/// when the app read it (unix ms, instant).
type Updated = (Vec<(String, i64)>, u64, i64, Instant);

/// What one run saw.
#[derive(Debug, Default)]
struct Run {
    /// The simulator's hands: key -> (table, players, atMs).
    hands: Vec<(String, u32, Vec<String>, i64)>,
    /// `table_updated` for a hand: key -> (players' hands, reread us,
    /// arrival unix ms, arrival instant).
    updated: HashMap<String, Updated>,
    /// `hand_imported` sent: key -> instant.
    sent: HashMap<String, Instant>,
    refused: Vec<(String, u64, RefusalReason)>,
    max_open: u32,
}

/// One run: `tables` tables of `room` posing as `site`, `hands` hands.
fn run(room: &str, site: &str, tables: u32, hands: u32, speed: u32) -> Run {
    let sim = simulator();
    let base =
        std::env::temp_dir().join(format!("rail-hud-e2e-{}-{room}-{site}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("hand-history");
    std::fs::create_dir_all(&folder).expect("folder");
    let events_path = base.join("sim-events.jsonl");
    let db = base.join(rail_store::FILE_NAME);

    // The app: the store, the watcher, the supervisor.
    let store = Store::open(&db).expect("store");
    let (imported_tx, imported_rx) = mpsc::channel::<(PathBuf, u32)>();
    let watcher = Watcher::start(
        &db,
        store.writer().expect("writer"),
        WatchConfig::default(),
        move |event| {
            if let WatchEvent::Imported { path, inserted, .. } = event
                && inserted > 0
            {
                let _ = imported_tx.send((path, inserted));
            }
        },
    )
    .expect("watcher");
    watcher
        .add_source(&folder, true, Some(false))
        .expect("source");
    let (event_tx, event_rx) = mpsc::channel::<(Event, i64)>();
    let mut config = SupervisorConfig::new(env!("CARGO_BIN_EXE_rail-hud"));
    config.args = vec![
        "--store".into(),
        db.clone().into_os_string(),
        "--platform".into(),
        "sim".into(),
        "--sim-events".into(),
        events_path.clone().into_os_string(),
        "--sim-site".into(),
        site.into(),
    ];
    let supervisor = Supervisor::start(config, move |event| {
        let _ = event_tx.send((event, unix_ms()));
    })
    .expect("supervisor");
    wait_connected(&event_rx);
    // The OS watch is set before the first walk; give it a moment.
    std::thread::sleep(Duration::from_millis(1500));

    let events_file = std::fs::File::create(&events_path).expect("events file");
    let mut child = Command::new(&sim)
        .args(["--room", room, "--tables", &tables.to_string()])
        .args(["--speed", &speed.to_string(), "--jitter", "10"])
        .args(["--hands", &hands.to_string(), "--linger", "500"])
        .args(["--no-stdin", "--headless", "--out"])
        .arg(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::from(events_file))
        .stderr(Stdio::inherit())
        .spawn()
        .expect("simulator");

    let reader = store.reader();
    let mut seen = Run::default();
    let mut imported = 0u32;
    let allowed = site_allowed(site);
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut sim_done_at: Option<Instant> = None;
    loop {
        assert!(Instant::now() < deadline, "timed out: {seen:?}");
        // The app's half: every import becomes `hand_imported`, oldest first.
        while let Ok((path, inserted)) = imported_rx.try_recv() {
            imported += inserted;
            let mut newest = reader
                .newest_hands_of_file(&path, inserted)
                .expect("newest hands");
            newest.reverse();
            for hand in newest {
                seen.sent.insert(hand.hand_key.clone(), Instant::now());
                supervisor.send(AppMessage::HandImported {
                    site: hand.site,
                    table: hand.table,
                    hand_key: hand.hand_key,
                    players: hand
                        .players
                        .into_iter()
                        .map(|p| PlayerRef {
                            name: p.player,
                            scope: p.scope,
                            seat: Some(p.seat),
                            hero: p.hero,
                        })
                        .collect(),
                });
            }
        }
        while let Ok((event, arrived_ms)) = event_rx.try_recv() {
            match event {
                Event::Message(
                    HudMessage::TableUpdated {
                        hand_key: Some(key),
                        players,
                        reread_us,
                        ..
                    },
                    at,
                ) => {
                    let players = players.into_iter().map(|p| (p.name, p.hands)).collect();
                    seen.updated
                        .entry(key)
                        .or_insert((players, reread_us, arrived_ms, at));
                }
                Event::Message(HudMessage::TablesOpen { count }, _) => {
                    seen.max_open = seen.max_open.max(count);
                }
                Event::Message(
                    HudMessage::AttachRefused {
                        site,
                        window,
                        reason,
                    },
                    _,
                ) => {
                    seen.refused.push((site, window, reason));
                }
                Event::Disconnected { reason } => panic!("the HUD went away: {reason}"),
                _ => {}
            }
        }
        if sim_done_at.is_none() && child.try_wait().expect("simulator").is_some() {
            sim_done_at = Some(Instant::now());
        }
        let all_imported = imported >= hands;
        let finished = if allowed {
            all_imported && seen.updated.len() >= usize::try_from(hands).unwrap_or(usize::MAX)
        } else {
            // Nothing will come: give the HUD a second to do something
            // wrong after the last import.
            all_imported && sim_done_at.is_some_and(|at| at.elapsed() > Duration::from_secs(1))
        };
        if finished {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let status = child.wait().expect("simulator exits");
    assert!(status.success(), "simulator: {status}");
    let health = supervisor.status().health;
    supervisor.stop();
    watcher.stop();
    store.close();

    for line in std::fs::read_to_string(&events_path)
        .expect("events")
        .lines()
    {
        let event: Value = serde_json::from_str(line).expect("event line");
        if event["event"] == "hand" {
            seen.hands.push((
                event["handKey"].as_str().unwrap_or("").to_owned(),
                u32::try_from(event["table"].as_u64().unwrap_or(0)).unwrap_or(0),
                event["players"]
                    .as_array()
                    .map(|p| {
                        p.iter()
                            .filter_map(|n| n.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                event["atMs"].as_i64().unwrap_or(0),
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&base);
    if let Some(health) = health {
        eprintln!("{room} as {site}: HUD health at the end: {health:?}");
    }
    seen
}

fn site_allowed(site: &str) -> bool {
    matches!(site, "pokerstars" | "winamax" | "acr")
}

fn wait_connected(rx: &Receiver<(Event, i64)>) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left).expect("the HUD connects").0 {
            Event::Connected { .. } => return,
            Event::Disconnected { reason } => panic!("{reason}"),
            _ => {}
        }
    }
}

fn percentiles(mut values: Vec<u64>) -> (u64, u64, u64) {
    values.sort_unstable();
    let at = |p: usize| values[(values.len() - 1) * p / 100];
    (at(50), at(95), at(100))
}

/// Every hand reached the HUD of an allowed room, each player's numbers
/// counting at least the hands they played at that table so far.
fn check_allowed(room: &str, site: &str, run: &Run, tables: u32, hands: u32) {
    assert_eq!(run.hands.len(), usize::try_from(hands).expect("hands"));
    assert!(run.refused.is_empty(), "{:?}", run.refused);
    assert_eq!(run.max_open, tables, "every table attached");
    let mut played: BTreeMap<(u32, String), i64> = BTreeMap::new();
    let mut file_to_hud = Vec::new();
    let mut app_to_hud = Vec::new();
    let mut reread = Vec::new();
    for (key, table, players, at_ms) in &run.hands {
        let (shown, reread_us, arrived_ms, arrived) = run
            .updated
            .get(key)
            .unwrap_or_else(|| panic!("{key}: no table_updated"));
        for player in players {
            let count = played.entry((*table, player.clone())).or_default();
            *count += 1;
            let hands = shown
                .iter()
                .find(|(name, _)| name == player)
                .map(|(_, n)| *n)
                .unwrap_or_else(|| panic!("{key}: {player} not shown"));
            assert!(
                hands >= *count,
                "{key}: {player} shows {hands}, played {count}"
            );
        }
        file_to_hud.push(u64::try_from(arrived_ms - at_ms).unwrap_or(0));
        let sent = run.sent.get(key).expect("sent");
        app_to_hud
            .push(u64::try_from(arrived.saturating_duration_since(*sent).as_micros()).unwrap_or(0));
        reread.push(*reread_us);
    }
    let (f50, f95, fmax) = percentiles(file_to_hud);
    let (a50, a95, amax) = percentiles(app_to_hud);
    let (r50, r95, rmax) = percentiles(reread);
    eprintln!(
        "{room} as {site}, {tables} tables, {hands} hands:\n  \
         hand in file -> HUD re-read (app saw table_updated): p50 {f50} ms, p95 {f95} ms, max {fmax} ms\n  \
         app sent hand_imported -> app saw table_updated: p50 {a50} us, p95 {a95} us, max {amax} us\n  \
         inside the HUD, hand_imported -> rollups re-read: p50 {r50} us, p95 {r95} us, max {rmax} us"
    );
    // §3.3's budget is < 1 s on a user's machine; shared CI runners get
    // five times that before this fails.
    assert!(fmax < 5_000, "a hand took {fmax} ms to reach the HUD");
}

#[test]
fn hands_reach_the_hud_of_an_allowed_room() {
    let tables = env_number("RAIL_HUD_E2E_TABLES", 3);
    let hands = env_number("RAIL_HUD_E2E_HANDS", 12);
    let speed = env_number("RAIL_HUD_E2E_SPEED", 40);
    let run_ps = run("pokerstars", "pokerstars", tables, hands, speed);
    check_allowed("pokerstars", "pokerstars", &run_ps, tables, hands);
    // ACR: the room `acr`, its hands the parser's `acrwpn` in the store.
    let run_acr = run("acr", "acr", 2, 6, 60);
    check_allowed("acr", "acr", &run_acr, 2, 6);
}

/// Compliance mode: the same tables posing as a prohibited room and as one
/// whose policy is unknown are refused - every window, with the reason - and
/// the HUD neither attaches nor reads a single hand of theirs.
#[test]
fn a_disallowed_room_gets_no_hud() {
    for (site, reason) in [
        ("ggpoker", RefusalReason::Prohibited),
        ("888poker", RefusalReason::Unknown),
    ] {
        let run = run("pokerstars", site, 2, 4, 60);
        assert_eq!(run.hands.len(), 4);
        assert_eq!(run.max_open, 0, "{site}: attached");
        assert!(
            run.updated.is_empty(),
            "{site}: read {:?}",
            run.updated.keys()
        );
        let mut windows: Vec<u64> = run
            .refused
            .iter()
            .map(|(s, w, r)| {
                assert_eq!((s.as_str(), *r), (site, reason));
                *w
            })
            .collect();
        windows.sort_unstable();
        assert_eq!(windows, [1, 2], "{site}: each window refused once");
    }
}
