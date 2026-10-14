//! End-to-end check on a development machine (docs/RAIL-PLAN.md R3.1):
//! the simulator writes hands -> the watcher (R1.3) imports them into a
//! fresh store -> the rollups of that table's players are readable (the
//! HUD's lookup, `Reader::hud_totals`) - and how long that takes, against
//! the latency budget (§3.3: < 1 s, aim < 250 ms).
//!
//! ```text
//! cargo build -p rail-hud-sim
//! cargo run -p rail-hud-sim --example e2e -- [--windows] [--room acr]
//!     [--tables 3] [--hands 30] [--speed 6] [--release-sim]
//! ```
//!
//! It runs the simulator **binary** (`target/<profile>/rail-hud-sim`, the
//! same profile as this example; build it first), headless unless
//! `--windows`, into a temporary folder that the watcher was told about
//! first, and reads its `hand` events from standard output. For each hand
//! the latency is from the event (the hand is in the file) until the store
//! has the hand **and** every player of it has a rollup counting at least
//! as many hands as the simulator has written for them. Everything is
//! deleted afterwards.

use std::collections::HashMap;
use std::io::BufRead as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rail_store::Store;
use rail_watch::{WatchConfig, Watcher};

struct Pending {
    key: String,
    site: String,
    /// (player, hands written for them so far, this one included).
    players: Vec<(String, i64)>,
    written: Instant,
}

fn arg(args: &[String], name: &str, default: &str) -> String {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| default.to_owned())
}

fn percentile(sorted: &[Duration], p: usize) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let windows = args.iter().any(|a| a == "--windows");
    let room = arg(&args, "--room", "pokerstars");
    let tables = arg(&args, "--tables", "3");
    let hands: usize = arg(&args, "--hands", "30").parse().expect("--hands");
    let speed = arg(&args, "--speed", "6");

    let exe = std::env::current_exe().expect("own path");
    let sim: PathBuf = exe
        .parent()
        .and_then(|examples| examples.parent())
        .map(|dir| dir.join(format!("rail-hud-sim{}", std::env::consts::EXE_SUFFIX)))
        .expect("target dir");
    assert!(
        sim.is_file(),
        "{} is not built: run `cargo build -p rail-hud-sim` first",
        sim.display()
    );

    let base = std::env::temp_dir().join(format!("rail-hud-sim-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let folder = base.join("hand-history");
    std::fs::create_dir_all(&folder).expect("folder");
    let db = base.join("rail.db");
    let store = Store::open(&db).expect("store");
    let watcher = Watcher::start(
        &db,
        store.writer().expect("writer"),
        WatchConfig::default(),
        |_| {},
    )
    .expect("watcher");
    watcher
        .add_source(&folder, true, Some(false))
        .expect("source");
    // The OS watch is set before the first walk; give it a moment.
    std::thread::sleep(Duration::from_millis(1500));

    let mut command = Command::new(&sim);
    command
        .args([
            "--room",
            &room,
            "--tables",
            &tables,
            "--speed",
            &speed,
            "--no-stdin",
        ])
        .args(["--hands", &hands.to_string(), "--linger", "500", "--out"])
        .arg(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if !windows {
        command.arg("--headless");
    }
    let mut child = command.spawn().expect("simulator");
    let stdout = child.stdout.take().expect("stdout");
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if tx.send(event).is_err() {
                break;
            }
        }
    });

    let reader = store.reader();
    let mut seen: HashMap<String, i64> = HashMap::new();
    let mut pending: Vec<Pending> = Vec::new();
    let mut latencies: Vec<Duration> = Vec::new();
    let mut received = 0;
    let deadline = Instant::now() + Duration::from_secs(600);
    while latencies.len() < hands {
        assert!(Instant::now() < deadline, "timed out");
        while let Ok(event) = rx.try_recv() {
            match event["event"].as_str() {
                Some("hand") => {
                    received += 1;
                    let players = event["players"]
                        .as_array()
                        .map(|list| {
                            list.iter()
                                .filter_map(|p| p.as_str())
                                .map(|p| {
                                    let n = seen.entry(p.to_owned()).or_default();
                                    *n += 1;
                                    (p.to_owned(), *n)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let key = event["handKey"].as_str().unwrap_or("").to_owned();
                    let site = key.split(':').next().unwrap_or("").to_owned();
                    pending.push(Pending {
                        key,
                        site,
                        players,
                        written: Instant::now(),
                    });
                }
                Some("error") => panic!("simulator: {event}"),
                _ => {}
            }
        }
        if !pending.is_empty() {
            let keys: Vec<String> = pending.iter().map(|p| p.key.clone()).collect();
            let rows = reader.hand_rows(&keys).expect("hand rows");
            pending.retain(|p| {
                if !rows.iter().any(|r| r.hand_key == p.key) {
                    return true;
                }
                let table: Vec<(&str, &str)> =
                    p.players.iter().map(|(n, _)| (n.as_str(), "")).collect();
                let totals = reader
                    .hud_totals(&p.site, &table, None)
                    .expect("hud totals");
                let current = totals
                    .iter()
                    .zip(&p.players)
                    .all(|(t, (_, n))| t.counters[0] >= *n);
                if current {
                    latencies.push(p.written.elapsed());
                }
                !current
            });
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let status = child.wait().expect("simulator exits");
    watcher.stop();
    store.close();
    let _ = std::fs::remove_dir_all(&base);

    latencies.sort_unstable();
    let over = latencies
        .iter()
        .filter(|d| **d >= Duration::from_secs(1))
        .count();
    println!(
        "{room}: {received} hands written by {tables} tables at {speed}/min{}; simulator exit {status}",
        if windows { " (windows)" } else { " (headless)" }
    );
    println!(
        "hand in file -> in the store with its players' rollups: p50 {} ms, p95 {} ms, max {} ms; {over} of {} over 1 s",
        percentile(&latencies, 50).as_millis(),
        percentile(&latencies, 95).as_millis(),
        percentile(&latencies, 100).as_millis(),
        latencies.len()
    );
    if over > 0 || !status.success() {
        std::process::exit(1);
    }
}
