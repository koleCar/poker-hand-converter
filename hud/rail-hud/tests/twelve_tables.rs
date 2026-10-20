//! Twelve tables (docs/RAIL-PLAN.md R3.14, Phase 3's exit: "HUD on 12
//! simultaneous tables on Windows and macOS within budget (§3.3), only on
//! rooms whose `hud.allowed` is `true`"). A measurement with a report, not
//! a unit test: without `--run` it says how to run it and passes, so the
//! workspace's `cargo test` does not pay for it; CI runs it as its own
//! step on Windows and macOS, and the owner on real hardware.
//!
//! ```text
//! cargo test -p rail-hud --test twelve_tables -- --run [--seconds 60]
//!     [--speed 6] [--idle-seconds 10] [--report-dir <dir>] [--real-hw]
//! ```
//!
//! The test plays the app, as `e2e.rs` does - the store, the watcher, the
//! statistics pass (paused while tables are open, as the app does on
//! `tables_open`) and the real supervisor starting the real `rail-hud` -
//! and the HUD runs with **this system's backend**: the simulator's
//! windows found by process and title, overlays drawn on them, followed by
//! the hooks (Windows) or the accessibility observers (macOS). Two
//! simulators: **twelve PokerStars-titled tables** (6- and 9-max) posing as
//! `pokerstars` (allowed) and **one ACR-titled table** posing as `ggpoker`
//! (prohibited) - the test-only room entries (`--sim-site` / `--sim-title`,
//! one pair each), which take the simulator's process only.
//!
//! 1. **Attach**: twelve tables attached, twelve overlays on screen, the
//!    thirteenth refused (`prohibited`) with no overlay.
//! 2. **Play** for `--seconds` at `--speed` hands per minute per table: each
//!    hand's chain from the bytes written to the frame (the HUD's
//!    `--latency-report`), the HUD's and the app's CPU over the play, the
//!    HUD's memory sampled; a recompute queued meanwhile must stay paused.
//! 3. **Follow**: every table moved twice (Windows: `SetWindowPos` from this
//!    process, as a user's drag; macOS: the simulator moves its own window)
//!    while the hands go on - table there -> overlay over it, polled.
//! 4. **Idle**: the simulators paused, the HUD's CPU with twelve tables
//!    showing numbers; then the overlays counted again.
//! 5. The HUD shut down: its `--perf-report` (paint and follow times, its
//!    looks for tables and their interval).
//!
//! **Report**: `twelve-tables-<os>-<profile>-<time>.json` and `.md` in
//! `--report-dir` (default `target/twelve-tables`), written before any
//! gate is checked; the simulator's data only (names like `SimHero`, no
//! host or user name, no path). **Gates**: correctness everywhere; the
//! latency budget (§3.3: < 1 s from the hand written to the frame, p95)
//! everywhere; a paint's p95 under 16.7 ms on real hardware (on CI
//! recorded - one debug build read 2.8 to 28 ms on Windows runners - with
//! a ceiling of three frames); a follow's p50 under two
//! frames and p95 under three frames on Windows and on real hardware only
//! (a CI Mac's virtual window server stalls ~0.5 s now and then, R3.13:
//! its p50 read 31 ms and 51 ms on two runs of the same code, so there
//! both are recorded; "moves not followed" is a gate everywhere); CPU **relative to the runner** (budgets for an M2 Pro,
//! scaled by a fixed workload timed on this machine, never tightened) and
//! memory absolute. `--real-hw` (or `RAIL_HUD_REAL_HW=1`) marks a real
//! machine's run.
//!
//! **Without the Accessibility permission** (macOS: an agent's shell, a
//! terminal not granted it) the HUD cannot read a table's title, so the
//! overlays, the follow and the refused table cannot run: the data path
//! runs instead with the simulator's event stream as the windows
//! (`--platform sim`, headless simulators), and the report says
//! `incomplete` and lists what it skipped. It never prompts and never
//! changes a setting.

mod support;

fn main() {
    #[cfg(any(windows, target_os = "macos"))]
    scenario::main();
    #[cfg(not(any(windows, target_os = "macos")))]
    eprintln!("twelve_tables: Windows and macOS only; nothing to run here");
}

#[cfg(any(windows, target_os = "macos"))]
mod scenario {
    use std::collections::{BTreeMap, HashMap};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use rail_hud_ipc::protocol::{
        AppMessage, HandTiming, HudMessage, LatencyChain, PlayerRef, RefusalReason,
    };
    use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
    use rail_store::{Activity, StatsWorker, Store};
    use rail_watch::{WatchConfig, WatchEvent, Watcher};
    use serde_json::{Value, json};

    use super::support::{Seen, Sim, simulator};

    /// The allowed room's tables.
    const TABLES: usize = 12;
    /// One frame at 60 Hz, µs.
    const FRAME_US: u64 = 16_667;
    /// §3.3: a hand on the HUD under a second after it ends.
    const BUDGET_CHAIN_US: u64 = 1_000_000;
    /// §3.3's redraw.
    const BUDGET_PAINT_US: u64 = FRAME_US;
    /// The HUD's CPU, hundredths of a percent of one core, on the owner's
    /// M2 Pro (the calibration's reference): with twelve tables showing
    /// numbers and nothing happening, and under twelve tables' hands.
    const BUDGET_HUD_IDLE: u64 = 500;
    const BUDGET_HUD_LOAD: u64 = 1_500;
    /// The app's share while tables play (watcher, import, the paused
    /// statistics pass, the HUD's supervision).
    const BUDGET_APP_PLAY: u64 = 2_000;
    /// The HUD's resident memory with twelve tables.
    const BUDGET_HUD_RSS: u64 = 256 * 1024 * 1024;
    /// The calibration workload on the M2 Pro, µs (the fastest of five),
    /// per build profile: what "runner-relative" scales by.
    const CALIBRATION_REF_DEBUG_US: u64 = 240_000;
    const CALIBRATION_REF_RELEASE_US: u64 = 7_500;

    fn unix_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }

    fn unix_us() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }

    fn micros(d: Duration) -> u64 {
        u64::try_from(d.as_micros()).unwrap_or(u64::MAX)
    }

    /// The command line after `--`.
    #[derive(Debug)]
    struct Options {
        run: bool,
        /// Only time the calibration workload (to set the reference).
        calibrate: bool,
        seconds: u64,
        speed: String,
        idle: u64,
        report_dir: PathBuf,
        real_hw: bool,
    }

    fn options() -> Options {
        let mut options = Options {
            run: false,
            calibrate: false,
            seconds: 60,
            speed: "6".to_owned(),
            idle: 10,
            report_dir: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/twelve-tables"),
            real_hw: std::env::var("RAIL_HUD_REAL_HW").is_ok_and(|v| v == "1"),
        };
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        let value = |i: &mut usize| -> String {
            *i += 1;
            args.get(*i)
                .cloned()
                .unwrap_or_else(|| panic!("{} needs a value", args[*i - 1]))
        };
        while i < args.len() {
            match args[i].as_str() {
                "--run" => options.run = true,
                "--calibrate" => options.calibrate = true,
                "--real-hw" => options.real_hw = true,
                "--seconds" => options.seconds = value(&mut i).parse().expect("--seconds"),
                "--idle-seconds" => options.idle = value(&mut i).parse().expect("--idle-seconds"),
                "--speed" => options.speed = value(&mut i),
                "--report-dir" => options.report_dir = PathBuf::from(value(&mut i)),
                // libtest's own flags, should a runner pass them.
                _ => {}
            }
            i += 1;
        }
        options
    }

    pub fn main() {
        let options = options();
        if options.calibrate {
            eprintln!("R3.14 calibration: {} us", calibrate());
            return;
        }
        if !options.run {
            eprintln!(
                "twelve_tables: a measurement (docs/RAIL-PLAN.md R3.14), skipped without --run. \
                 Run: cargo test -p rail-hud --test twelve_tables -- --run [--seconds 60] \
                 [--real-hw]"
            );
            return;
        }
        let full = os::can_find();
        if let Err(why) = &full {
            eprintln!("R3.14: {why}");
        }
        let mut report = run(&options, full.is_ok());
        if let Err(why) = full {
            report.skipped.insert(0, why);
        }
        let (json_path, md_path) = report.write(&options);
        eprintln!(
            "R3.14 report: {}\n{}\n{}",
            report.verdict(),
            json_path.display(),
            md_path.display()
        );
        eprintln!("{}", report.markdown(&options));
        let failed: Vec<String> = report
            .gates
            .iter()
            .filter(|g| g.gated && !g.pass)
            .map(|g| {
                format!(
                    "{}: {} (limit {})",
                    g.name,
                    g.shown(g.value),
                    g.shown(g.limit)
                )
            })
            .collect();
        assert!(
            failed.is_empty(),
            "R3.14 gates failed:\n{}",
            failed.join("\n")
        );
        eprintln!("twelve_tables: ok");
    }

    // ---------------------------------------------------------------------
    // The report.

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Unit {
        Micros,
        /// Hundredths of a percent of one core.
        Core,
        Bytes,
        Count,
    }

    #[derive(Debug, Clone)]
    struct Gate {
        name: String,
        value: u64,
        limit: u64,
        unit: Unit,
        /// `<=` (most) or `==` (counts that must be exact).
        exact: bool,
        gated: bool,
        pass: bool,
    }

    impl Gate {
        fn shown(&self, v: u64) -> String {
            match self.unit {
                Unit::Micros if v >= 10_000 => format!("{} ms", v / 1000),
                Unit::Micros => format!("{}.{} ms", v / 1000, (v % 1000) / 100),
                Unit::Core => format!("{}.{:02} %", v / 100, v % 100),
                Unit::Bytes => format!("{} MiB", v / (1024 * 1024)),
                Unit::Count => v.to_string(),
            }
        }
    }

    #[derive(Debug, Default)]
    struct Report {
        full: bool,
        skipped: Vec<String>,
        gates: Vec<Gate>,
        /// Everything measured, as JSON sections.
        sections: BTreeMap<String, Value>,
    }

    impl Report {
        fn gate(&mut self, name: &str, value: u64, limit: u64, unit: Unit, gated: bool) {
            self.gates.push(Gate {
                name: name.to_owned(),
                value,
                limit,
                unit,
                exact: false,
                gated,
                pass: value <= limit,
            });
        }

        fn exact(&mut self, name: &str, value: u64, want: u64) {
            self.gates.push(Gate {
                name: name.to_owned(),
                value,
                limit: want,
                unit: Unit::Count,
                exact: true,
                gated: true,
                pass: value == want,
            });
        }

        fn verdict(&self) -> &'static str {
            if self.gates.iter().any(|g| g.gated && !g.pass) {
                "FAIL"
            } else if !self.full {
                "INCOMPLETE (pass on what ran)"
            } else {
                "PASS"
            }
        }

        fn json(&self, options: &Options) -> Value {
            let gates: Vec<Value> = self
                .gates
                .iter()
                .map(|g| {
                    json!({
                        "name": g.name,
                        "value": g.value,
                        "limit": g.limit,
                        "unit": format!("{:?}", g.unit),
                        "exact": g.exact,
                        "shown": format!("{} / {}", g.shown(g.value), g.shown(g.limit)),
                        "gated": g.gated,
                        "pass": g.pass,
                    })
                })
                .collect();
            let mut out = json!({
                "step": "R3.14",
                "kind": "twelve-tables",
                "version": 1,
                "verdict": self.verdict(),
                "mode": if self.full { "full" } else { "data-only" },
                "skipped": self.skipped,
                "realHardware": options.real_hw,
                "ci": std::env::var("CI").is_ok_and(|v| v == "true"),
                "gates": gates,
            });
            for (key, value) in &self.sections {
                out[key] = value.clone();
            }
            out
        }

        fn markdown(&self, options: &Options) -> String {
            let machine = &self.sections["machine"];
            let mut md = format!(
                "# R3.14 twelve tables - {}\n\n\
                 - Machine: {} {}, {}, {} logical cores, {} build{}\n\
                 - Mode: {}{}\n\
                 - Scenario: {} tables posing as `pokerstars` (6- and 9-max) + 1 posing as \
                 `ggpoker` (prohibited), {} hands/min/table, {} s of play, {} s idle\n\n",
                self.verdict(),
                machine["os"].as_str().unwrap_or(""),
                machine["arch"].as_str().unwrap_or(""),
                machine["cpu"].as_str().unwrap_or(""),
                machine["cores"],
                machine["profile"].as_str().unwrap_or(""),
                if options.real_hw {
                    ", real hardware"
                } else {
                    ""
                },
                if self.full { "full" } else { "data only" },
                if self.skipped.is_empty() {
                    String::new()
                } else {
                    format!(" - skipped: {}", self.skipped.join("; "))
                },
                TABLES,
                options.speed,
                options.seconds,
                options.idle,
            );
            md.push_str("| Check | Measured | Limit | |\n| --- | ---: | ---: | --- |\n");
            for g in &self.gates {
                md.push_str(&format!(
                    "| {} | {} | {}{} | {} |\n",
                    g.name,
                    g.shown(g.value),
                    if g.exact { "= " } else { "<= " },
                    g.shown(g.limit),
                    match (g.gated, g.pass) {
                        (true, true) => "pass",
                        (true, false) => "**FAIL**",
                        (false, true) => "recorded (within)",
                        (false, false) => "recorded (over)",
                    }
                ));
            }
            md.push_str("\nEverything measured is in the JSON next to this file.\n");
            md
        }

        fn write(&self, options: &Options) -> (PathBuf, PathBuf) {
            std::fs::create_dir_all(&options.report_dir).expect("the report folder");
            let profile = if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            };
            let stem = format!(
                "twelve-tables-{}-{profile}-{}",
                std::env::consts::OS,
                unix_ms() / 1000
            );
            let json_path = options.report_dir.join(format!("{stem}.json"));
            let md_path = options.report_dir.join(format!("{stem}.md"));
            let text = serde_json::to_string_pretty(&self.json(options)).expect("json");
            std::fs::write(&json_path, text + "\n").expect("the JSON report");
            std::fs::write(&md_path, self.markdown(options)).expect("the markdown report");
            (json_path, md_path)
        }
    }

    // ---------------------------------------------------------------------
    // Numbers.

    fn percentiles(mut values: Vec<u64>) -> Value {
        if values.is_empty() {
            return json!({"count": 0});
        }
        values.sort_unstable();
        let at = |p: usize| values[(values.len() - 1) * p / 100];
        json!({
            "count": values.len(),
            "p50Us": at(50),
            "p95Us": at(95),
            "maxUs": values[values.len() - 1],
        })
    }

    fn p(section: &Value, key: &str) -> u64 {
        section[key].as_u64().unwrap_or(0)
    }

    /// CPU over a span, hundredths of a percent of one core.
    fn share(cpu: Duration, over: Duration) -> u64 {
        u64::try_from(cpu.as_micros() * 10_000 / over.as_micros().max(1)).unwrap_or(u64::MAX)
    }

    /// A fixed CPU workload, the fastest of five, µs: how fast this machine
    /// runs this build compared with the M2 Pro's reference.
    fn calibrate() -> u64 {
        let mut best = u64::MAX;
        for _ in 0..5 {
            let started = Instant::now();
            let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
            let mut total = 0u64;
            for _ in 0..3 {
                let mut values: Vec<u64> = (0..200_000)
                    .map(|_| {
                        x ^= x << 13;
                        x ^= x >> 7;
                        x ^= x << 17;
                        x
                    })
                    .collect();
                values.sort_unstable();
                total = total.wrapping_add(values[values.len() / 2]);
            }
            std::hint::black_box(total);
            best = best.min(micros(started.elapsed()));
        }
        best
    }

    // ---------------------------------------------------------------------
    // The app's half (as e2e.rs): imports become `hand_imported`; the HUD's
    // messages are kept.

    /// A hand the simulator wrote: (key, table, atMs).
    type Written = (String, u64, i64);

    struct App {
        store: Store,
        stats: StatsWorker,
        watcher: Option<Watcher>,
        supervisor: Supervisor,
        imported: Receiver<(PathBuf, u32, Option<i64>, i64)>,
        events: Receiver<(Event, i64)>,
        sim_a: Sim,
        sim_b: Sim,
        seen_a: Seen,
        seen_b: Seen,
        written_a: Vec<Written>,
        written_b: Vec<Written>,
        /// hand key -> (app saw `table_updated`, unix ms; its chain).
        updated: HashMap<String, (i64, Option<LatencyChain>)>,
        refused: Vec<(String, u64, RefusalReason)>,
        tables_open: u32,
        max_open: u32,
        imports: u32,
    }

    impl App {
        /// Everything that arrived, without waiting.
        fn pump(&mut self) {
            let reader = self.store.reader();
            while let Ok((path, inserted, noticed_ms, imported_us)) = self.imported.try_recv() {
                self.imports += inserted;
                let mut newest = reader
                    .newest_hands_of_file(&path, inserted)
                    .expect("newest hands");
                newest.reverse();
                for hand in newest {
                    self.supervisor.send(AppMessage::HandImported {
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
                                stack_bb_tenths: p.stack_bb_tenths,
                            })
                            .collect(),
                        timing: Some(HandTiming {
                            noticed_us: noticed_ms.map(|ms| ms * 1000),
                            imported_us: Some(imported_us),
                            sent_us: Some(unix_us()),
                        }),
                    });
                }
            }
            while let Ok((event, arrived_ms)) = self.events.try_recv() {
                match event {
                    Event::Message(
                        HudMessage::TableUpdated {
                            hand_key: Some(key),
                            chain,
                            ..
                        },
                        _,
                    ) => {
                        self.updated.entry(key).or_insert((arrived_ms, chain));
                    }
                    Event::Message(HudMessage::TablesOpen { count }, _) => {
                        // What the app does (R3.2): the statistics pass's
                        // heavy parts pause while tables are open.
                        if (count > 0) != (self.tables_open > 0) {
                            self.stats.set_tables_open(count > 0);
                        }
                        self.tables_open = count;
                        self.max_open = self.max_open.max(count);
                    }
                    Event::Message(
                        HudMessage::AttachRefused {
                            site,
                            window,
                            reason,
                        },
                        _,
                    ) => self.refused.push((site, window, reason)),
                    Event::Disconnected { reason } => panic!("the HUD went away: {reason}"),
                    _ => {}
                }
            }
            for (sim, seen, written) in [
                (&self.sim_a, &mut self.seen_a, &mut self.written_a),
                (&self.sim_b, &mut self.seen_b, &mut self.written_b),
            ] {
                while let Ok(event) = sim.events.try_recv() {
                    if event["event"] == "hand" {
                        written.push((
                            event["handKey"].as_str().unwrap_or_default().to_owned(),
                            event["table"].as_u64().unwrap_or(0),
                            event["atMs"].as_i64().unwrap_or(0),
                        ));
                    }
                    seen.take(event);
                }
            }
        }

        /// Pump for `span`, `step` apart.
        fn pump_for(&mut self, span: Duration) {
            let until = Instant::now() + span;
            while Instant::now() < until {
                self.pump();
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        /// Pump until `done` holds, or fail after `timeout` saying `what`.
        fn pump_until(&mut self, timeout: Duration, what: &str, done: impl Fn(&Self) -> bool) {
            let deadline = Instant::now() + timeout;
            loop {
                self.pump();
                if done(self) {
                    eprintln!("step ok: {what}");
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {what}; the simulators said:\n{}\n{}\nHUD health: {:?}",
                    self.seen_a.log.join("\n"),
                    self.seen_b.log.join("\n"),
                    self.supervisor.status().health
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn hud_pid(&self) -> u32 {
            self.supervisor.status().pid.expect("a HUD process")
        }
    }

    fn wait_connected(rx: &Receiver<(Event, i64)>) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left).expect("the HUD connects").0 {
                Event::Connected { .. } => return,
                Event::Disconnected { reason } => panic!("{reason}"),
                _ => {}
            }
        }
    }

    fn title_regex(sim: &Path, room: &str) -> String {
        let out = Command::new(sim)
            .args(["--room", room, "--title-regex"])
            .output()
            .expect("--title-regex");
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    // ---------------------------------------------------------------------
    // The run.

    #[allow(clippy::too_many_lines)] // one scenario, read top to bottom
    fn run(options: &Options, full: bool) -> Report {
        let mut report = Report {
            full,
            ..Report::default()
        };
        let calibration = calibrate();
        let reference = if cfg!(debug_assertions) {
            CALIBRATION_REF_DEBUG_US
        } else {
            CALIBRATION_REF_RELEASE_US
        };
        // Per mille, never under 1000: a faster machine is not held to more.
        let factor = (calibration * 1000 / reference.max(1)).max(1000);
        let scaled = |budget: u64| budget * factor / 1000;
        report.sections.insert("machine".into(), os::machine());
        report.sections.insert(
            "calibration".into(),
            json!({"us": calibration, "referenceUs": reference, "factorPermille": factor}),
        );

        let sim_path = simulator();
        let regex_a = title_regex(&sim_path, "pokerstars");
        let regex_b = title_regex(&sim_path, "acr");
        let base = std::env::temp_dir().join(format!("rail-hud-twelve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("base folder");
        let db = base.join(rail_store::FILE_NAME);
        let events_a = base.join("a-events.jsonl");
        let latency = base.join("latency.jsonl");
        let perf = base.join("perf.json");

        // The app: the store, the statistics pass, the watcher.
        let store = Store::open(&db).expect("store");
        let stats = StatsWorker::start(&db, store.writer().expect("writer")).expect("stats");
        let (imported_tx, imported) = mpsc::channel();
        let watcher = Watcher::start(
            &db,
            store.writer().expect("writer"),
            WatchConfig::default(),
            move |event| {
                if let WatchEvent::Imported {
                    path,
                    inserted,
                    noticed_ms,
                    ..
                } = event
                    && inserted > 0
                {
                    let _ = imported_tx.send((path, inserted, noticed_ms, unix_us()));
                }
            },
        )
        .expect("watcher");
        let folder_a = Sim::folder("twelve-a");
        let folder_b = Sim::folder("twelve-b");
        for folder in [&folder_a, &folder_b] {
            let _ = std::fs::remove_dir_all(folder);
            std::fs::create_dir_all(folder).expect("folder");
            watcher
                .add_source(folder, true, Some(false))
                .expect("source");
        }

        // The HUD under the real supervisor.
        let mut config = SupervisorConfig::new(env!("CARGO_BIN_EXE_rail-hud"));
        let mut args: Vec<std::ffi::OsString> = vec![
            "--store".into(),
            db.clone().into_os_string(),
            "--latency-report".into(),
            latency.clone().into_os_string(),
            "--perf-report".into(),
            perf.clone().into_os_string(),
        ];
        if full {
            for (site, regex) in [("pokerstars", &regex_a), ("ggpoker", &regex_b)] {
                args.extend([
                    "--sim-site".into(),
                    site.into(),
                    "--sim-title".into(),
                    regex.into(),
                ]);
            }
        } else {
            args.extend([
                "--platform".into(),
                "sim".into(),
                "--sim-events".into(),
                events_a.clone().into_os_string(),
                "--sim-site".into(),
                "pokerstars".into(),
            ]);
        }
        config.args = args;
        // Room for the `--perf-report` at shutdown.
        config.shutdown_grace = Duration::from_secs(10);
        let (event_tx, events) = mpsc::channel::<(Event, i64)>();
        let supervisor = Supervisor::start(config, move |event| {
            let _ = event_tx.send((event, unix_ms()));
        })
        .expect("supervisor");
        wait_connected(&events);
        // The OS watch is set before the first walk; give it a moment.
        std::thread::sleep(Duration::from_millis(1500));

        // The tables. Windows only where the HUD can find them.
        let speed = options.speed.clone();
        let mut common: Vec<&str> = vec!["--speed", &speed];
        if !full {
            common.push("--headless");
        }
        let mut a_args = vec!["--room", "pokerstars", "--tables", "12", "--sizes", "6,9"];
        a_args.extend(["--seed", "1214"]);
        a_args.extend(common.iter().copied());
        let mut b_args = vec!["--room", "acr", "--tables", "1", "--seed", "1215"];
        b_args.extend(common.iter().copied());
        let sim_a = Sim::start_into(&sim_path, folder_a, &a_args, Some(events_a));
        let sim_b = Sim::start_into(&sim_path, folder_b, &b_args, None);
        let mut app = App {
            store,
            stats,
            watcher: Some(watcher),
            supervisor,
            imported,
            events,
            sim_a,
            sim_b,
            seen_a: Seen::default(),
            seen_b: Seen::default(),
            written_a: Vec::new(),
            written_b: Vec::new(),
            updated: HashMap::new(),
            refused: Vec::new(),
            tables_open: 0,
            max_open: 0,
            imports: 0,
        };
        // Quiet until every table is attached.
        app.sim_a.command("pause");
        app.sim_b.command("pause");
        let windows_needed = full;
        app.pump_until(Duration::from_secs(180), "13 tables open", |app| {
            app.seen_a.tables.len() == TABLES
                && app.seen_b.tables.len() == 1
                && (!windows_needed
                    || (app.seen_a.windows.len() == TABLES && app.seen_b.windows.len() == 1))
        });
        let attach_started = Instant::now();
        app.pump_until(Duration::from_secs(120), "12 tables attached", |app| {
            app.tables_open == 12 && (!full || !app.refused.is_empty())
        });
        let attach_ms = attach_started.elapsed().as_millis();
        let hud_pid = app.hud_pid();
        let sim_a_pid = app.sim_a.child.id();
        let sim_b_pid = app.sim_b.child.id();

        // The overlays: one per allowed table, none on the refused one.
        let mut tables: BTreeMap<u64, os::Table> = BTreeMap::new();
        if full {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                app.pump();
                tables.clear();
                for n in app.seen_a.tables.keys().copied().collect::<Vec<_>>() {
                    if let Some(table) = os::locate(sim_a_pid, &app.seen_a, n) {
                        tables.insert(n, table);
                    }
                }
                let covered = tables
                    .values()
                    .filter(|t| os::overlay_of(hud_pid, t).is_some())
                    .count();
                if tables.len() == TABLES && covered == TABLES {
                    eprintln!("step ok: an overlay over each of the 12 tables");
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "{} tables located, {covered} with an overlay\n{}",
                    tables.len(),
                    os::listing(hud_pid)
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let refused_table = if full {
            let n = *app.seen_b.tables.keys().next().expect("the refused table");
            Some(os::locate(sim_b_pid, &app.seen_b, n).expect("the refused table's window"))
        } else {
            None
        };
        let overlays_at_attach = if full { os::count_overlays(hud_pid) } else { 0 };

        // Play.
        let play_started_ms = unix_ms();
        app.sim_a.command("resume");
        app.sim_b.command("resume");
        let play_started = Instant::now();
        let hud_cpu0 = os::cpu_time(hud_pid).expect("the HUD's CPU");
        let app_cpu0 = os::cpu_time(std::process::id()).expect("this process's CPU");
        let mut rss_max = 0u64;
        let mut app_rss_max = 0u64;
        let mut hud_peak = None;
        let mut next_sample = Instant::now();
        let mut recompute: Option<u64> = None;
        let play = Duration::from_secs(options.seconds);
        while play_started.elapsed() < play {
            app.pump();
            if Instant::now() >= next_sample {
                next_sample += Duration::from_secs(5);
                if let Some((rss, peak)) = os::memory(hud_pid) {
                    rss_max = rss_max.max(rss);
                    hud_peak = peak.or(hud_peak);
                }
                if let Some((rss, _)) = os::memory(std::process::id()) {
                    app_rss_max = app_rss_max.max(rss);
                }
            }
            // A recompute asked for while tables are open (what a
            // `STATS_VERSION` bump or the user's "rebuild" does): it must
            // wait until they close.
            if recompute.is_none()
                && play_started.elapsed() >= play / 4
                && app.imports > 0
                && app.tables_open > 0
            {
                recompute = Some(app.stats.rebuild_stats().expect("a recompute"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let played = play_started.elapsed();
        let hud_load = os::cpu_time(hud_pid)
            .expect("the HUD's CPU")
            .saturating_sub(hud_cpu0);
        let app_play = os::cpu_time(std::process::id())
            .expect("this process's CPU")
            .saturating_sub(app_cpu0);
        let rebuild_during_play = app
            .store
            .reader()
            .stats_status()
            .expect("stats status")
            .rebuild
            .map(|r| (r.done, r.total));
        // The pass may be indexing a hand just imported (that part goes on
        // while tables are open): give it a moment to show the pause.
        let mut activity = app.stats.status().activity;
        let paused_by = Instant::now() + Duration::from_secs(3);
        while recompute.is_some()
            && activity != Activity::PausedTables
            && Instant::now() < paused_by
        {
            app.pump_for(Duration::from_millis(20));
            activity = app.stats.status().activity;
        }

        // Follow: every table moved twice, the hands going on.
        let mut follows: Vec<u64> = Vec::new();
        let mut follow_failures: Vec<String> = Vec::new();
        if full {
            let numbers: Vec<u64> = tables.keys().copied().collect();
            for n in numbers {
                for (dx, dy) in [(48, 24), (-48, -24)] {
                    app.pump_for(Duration::from_millis(150));
                    // Its window, as located at attach (the number, title
                    // bar and scale stay; the place is read at the move).
                    let table = tables.get(&n).cloned().expect("the table");
                    match os::follow_once(&mut app, hud_pid, n, &table, dx, dy) {
                        Ok(lag) => follows.push(lag),
                        Err(why) => follow_failures.push(format!("table {n}: {why}")),
                    }
                }
            }
            eprintln!(
                "step ok: {} moves followed, {} not",
                follows.len(),
                follow_failures.len()
            );
        }

        // Every hand of the play shown; then idle.
        app.sim_a.command("pause");
        app.sim_b.command("pause");
        let quiet = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            app.pump();
            let all = app
                .written_a
                .iter()
                .filter(|(_, _, at)| *at >= play_started_ms)
                .all(|(key, _, _)| app.updated.contains_key(key));
            let b_in = usize::try_from(app.imports).unwrap_or(usize::MAX)
                >= app.written_a.len() + app.written_b.len();
            if (all && b_in && quiet.elapsed() > Duration::from_secs(2))
                || Instant::now() >= deadline
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let idle_span = Duration::from_secs(options.idle);
        let hud_idle0 = os::cpu_time(hud_pid).expect("the HUD's CPU");
        let app_idle0 = os::cpu_time(std::process::id()).expect("this process's CPU");
        app.pump_for(idle_span);
        let hud_idle = os::cpu_time(hud_pid)
            .expect("the HUD's CPU")
            .saturating_sub(hud_idle0);
        let app_idle = os::cpu_time(std::process::id())
            .expect("this process's CPU")
            .saturating_sub(app_idle0);
        let hud_memory_end = os::memory(hud_pid);
        if let Some((rss, peak)) = hud_memory_end {
            rss_max = rss_max.max(rss);
            hud_peak = peak.or(hud_peak);
        }
        let overlays_end = if full { os::count_overlays(hud_pid) } else { 0 };
        let refused_overlays = refused_table
            .as_ref()
            .map_or(0, |t| usize::from(os::overlay_of(hud_pid, t).is_some()));
        let health = app.supervisor.status().health;

        // Shut down: the HUD writes its perf report.
        app.supervisor.stop();
        let hud_perf: Value = std::fs::read_to_string(&perf)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        if let Some(watcher) = app.watcher.take() {
            watcher.stop();
        }
        app.stats.stop();
        let mut chains: HashMap<String, LatencyChain> = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(&latency) {
            for line in text.lines() {
                let Ok(entry) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                if let (Some(key), Ok(chain)) = (
                    entry["handKey"].as_str(),
                    serde_json::from_value::<LatencyChain>(entry["chain"].clone()),
                ) {
                    chains.entry(key.to_owned()).or_insert(chain);
                }
            }
        }

        // ---- What it all says.
        let played_a: Vec<&Written> = app
            .written_a
            .iter()
            .filter(|(_, _, at)| *at >= play_started_ms)
            .collect();
        let shown_a = played_a
            .iter()
            .filter(|(key, _, _)| app.updated.contains_key(key))
            .count();
        let shown_b = app
            .written_b
            .iter()
            .filter(|(key, _, _)| app.updated.contains_key(key))
            .count();
        let mut written_to_frame = Vec::new();
        let mut written_to_app = Vec::new();
        let mut stage: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
        for (key, _, at_ms) in &played_a {
            if let Some((arrived_ms, _)) = app.updated.get(key) {
                written_to_app.push(u64::try_from(arrived_ms - at_ms).unwrap_or(0) * 1000);
            }
            let Some(chain) = chains.get(key) else {
                continue;
            };
            written_to_frame.push(u64::try_from(chain.painted_us - at_ms * 1000).unwrap_or(0));
            let mut push = |name: &'static str, v: Option<i64>| {
                if let Some(v) = v {
                    stage
                        .entry(name)
                        .or_default()
                        .push(u64::try_from(v).unwrap_or(0));
                }
            };
            push(
                "writtenToNoticed",
                chain.noticed_us.map(|n| n - at_ms * 1000),
            );
            push(
                "noticedToImported",
                chain.noticed_us.zip(chain.imported_us).map(|(n, i)| i - n),
            );
            push(
                "importedToSent",
                chain.imported_us.zip(chain.sent_us).map(|(i, s)| s - i),
            );
            push("sentToArrived", chain.sent_us.map(|s| chain.arrived_us - s));
            push("arrivedToRead", Some(chain.read_us - chain.arrived_us));
            push("readToFrame", Some(chain.painted_us - chain.read_us));
            push("noticedToFrame", chain.total_us());
        }
        let frame = percentiles(written_to_frame);
        let mut chain_section = json!({
            "writtenToFrame": frame,
            "writtenToAppSawUpdate": percentiles(written_to_app),
        });
        for (name, values) in stage {
            chain_section[name] = percentiles(values);
        }
        report.sections.insert("chain".into(), chain_section);
        report.sections.insert(
            "hands".into(),
            json!({
                "allowedWrittenDuringPlay": played_a.len(),
                "allowedShown": shown_a,
                "allowedWrittenInAll": app.written_a.len(),
                "refusedWritten": app.written_b.len(),
                "refusedShown": shown_b,
                "imported": app.imports,
            }),
        );
        let follow = percentiles(follows.clone());
        report.sections.insert(
            "follow".into(),
            json!({
                "external": follow,
                "how": os::FOLLOW_HOW,
                "failures": follow_failures,
                "inHud": hud_perf["follow"].clone(),
            }),
        );
        report
            .sections
            .insert("paint".into(), hud_perf["paint"].clone());
        report.sections.insert("hud".into(), hud_perf.clone());
        report.sections.insert(
            "cpu".into(),
            json!({
                "hudLoad": {"cpuMs": hud_load.as_millis(), "overMs": played.as_millis(),
                            "percentHundredths": share(hud_load, played)},
                "hudIdle": {"cpuMs": hud_idle.as_millis(), "overMs": idle_span.as_millis(),
                            "percentHundredths": share(hud_idle, idle_span)},
                "appPlay": {"cpuMs": app_play.as_millis(), "overMs": played.as_millis(),
                            "percentHundredths": share(app_play, played),
                            "note": "this test process playing the app: watcher, import, \
                                     the statistics pass (heavy parts paused), supervisor; \
                                     sync is not run (no server)"},
                "appIdle": {"cpuMs": app_idle.as_millis(), "overMs": idle_span.as_millis(),
                            "percentHundredths": share(app_idle, idle_span)},
            }),
        );
        report.sections.insert(
            "memory".into(),
            json!({
                "hudRssMaxSampledBytes": rss_max,
                "hudRssEndBytes": hud_memory_end.map(|(r, _)| r),
                "hudPeakBytes": hud_peak,
                "appRssMaxSampledBytes": app_rss_max,
            }),
        );
        report.sections.insert(
            "overlays".into(),
            json!({
                "atAttach": overlays_at_attach,
                "atEnd": overlays_end,
                "onRefusedTable": refused_overlays,
                "attachMs": attach_ms,
                "tablesOpenMax": app.max_open,
            }),
        );
        let refused_reasons: Vec<Value> = app
            .refused
            .iter()
            .map(|(site, window, reason)| json!({"site": site, "window": window, "reason": format!("{reason:?}")}))
            .collect();
        report.sections.insert(
            "compliance".into(),
            json!({
                "refused": refused_reasons,
                "healthRefusedTables": health.as_ref().map(|h| h.refused_tables.len()),
                "healthAttached": health.as_ref().map(|h| h.attached),
            }),
        );
        report.sections.insert(
            "statsPass".into(),
            json!({
                "recomputeQueued": recompute,
                "recomputeDoneTotalAtPlayEnd": rebuild_during_play,
                "activityAtPlayEnd": format!("{activity:?}"),
            }),
        );
        report.sections.insert(
            "scenario".into(),
            json!({
                "allowedTables": TABLES,
                "allowedRoom": "pokerstars",
                "sizes": "6,9",
                "refusedTables": 1,
                "refusedRoom": "ggpoker (ACR-titled simulator table)",
                "speedHandsPerMinutePerTable": options.speed,
                "playSeconds": options.seconds,
                "idleSeconds": options.idle,
                "displays": os::displays(),
            }),
        );

        // ---- Gates.
        report.exact("tables attached", u64::from(app.max_open), 12);
        report.exact(
            "allowed hands written during play, not shown",
            u64::try_from(played_a.len() - shown_a).unwrap_or(u64::MAX),
            0,
        );
        report.exact(
            "hands of the refused table shown",
            u64::try_from(shown_b).unwrap_or(u64::MAX),
            0,
        );
        report.gate(
            "hand written -> frame, p95 (§3.3)",
            p(&frame, "p95Us"),
            BUDGET_CHAIN_US,
            Unit::Micros,
            true,
        );
        report.gate(
            "hand written -> frame, max",
            p(&frame, "maxUs"),
            5 * BUDGET_CHAIN_US,
            Unit::Micros,
            true,
        );
        if full {
            report.exact(
                "overlays on screen (attach)",
                u64::try_from(overlays_at_attach).unwrap_or(0),
                12,
            );
            report.exact(
                "overlays on screen (end)",
                u64::try_from(overlays_end).unwrap_or(0),
                12,
            );
            report.exact(
                "overlays on the refused table",
                u64::try_from(refused_overlays).unwrap_or(0),
                0,
            );
            let prohibited = app
                .refused
                .iter()
                .filter(|(site, _, reason)| {
                    site == "ggpoker" && *reason == RefusalReason::Prohibited
                })
                .count();
            report.exact(
                "refused as prohibited (ggpoker)",
                u64::try_from(prohibited).unwrap_or(0),
                1,
            );
            report.exact(
                "moves not followed",
                u64::try_from(follow_failures.len()).unwrap_or(0),
                0,
            );
            let paint = &hud_perf["paint"];
            report.exact("paints recorded (> 0)", u64::from(p(paint, "count") > 0), 1);
            // A paint is the runner's as much as the HUD's: on CI the same
            // code measured p95 2.8, 3.1, 4.9, 5.0, 15, 24 and 28 ms (Windows,
            // debug build, 2026-10-20). The budget is gated on real
            // hardware; on CI it is recorded, and a ceiling of three frames
            // still catches a paint gone an order of magnitude slower.
            report.gate(
                "overlay paint, p95",
                p(paint, "p95Us"),
                BUDGET_PAINT_US,
                Unit::Micros,
                options.real_hw,
            );
            if !options.real_hw {
                report.gate(
                    "overlay paint, p95 (CI ceiling, 3 frames)",
                    p(paint, "p95Us"),
                    3 * FRAME_US,
                    Unit::Micros,
                    true,
                );
            }
            // On a CI Mac the follow latency is the virtual window server's
            // (R3.13): the same code measured p50 31 ms and 51 ms on two runs.
            // Recorded there, gated on Windows and on real hardware; "moves not
            // followed" above stays a gate everywhere.
            report.gate(
                "table moved -> overlay over it, p50",
                p(&follow, "p50Us"),
                2 * FRAME_US,
                Unit::Micros,
                cfg!(windows) || options.real_hw,
            );
            report.gate(
                "table moved -> overlay over it, p95",
                p(&follow, "p95Us"),
                3 * FRAME_US,
                Unit::Micros,
                cfg!(windows) || options.real_hw,
            );
        }
        report.exact(
            "recompute progress while tables open",
            rebuild_during_play.map_or(0, |(done, _)| done),
            0,
        );
        if recompute.is_some() {
            report.exact(
                "statistics pass paused for tables (1 = yes)",
                u64::from(activity == Activity::PausedTables),
                1,
            );
        }
        report.gate(
            "HUD CPU, 12 tables idle (of one core)",
            share(hud_idle, idle_span),
            scaled(BUDGET_HUD_IDLE),
            Unit::Core,
            true,
        );
        report.gate(
            "HUD CPU, 12 tables playing (of one core)",
            share(hud_load, played),
            scaled(BUDGET_HUD_LOAD),
            Unit::Core,
            true,
        );
        report.gate(
            "app CPU while playing (of one core)",
            share(app_play, played),
            scaled(BUDGET_APP_PLAY),
            Unit::Core,
            true,
        );
        report.gate(
            "HUD memory (RSS, max sampled)",
            rss_max,
            BUDGET_HUD_RSS,
            Unit::Bytes,
            true,
        );
        if let Some(peak) = hud_peak {
            report.gate(
                "HUD memory (peak working set)",
                peak,
                BUDGET_HUD_RSS,
                Unit::Bytes,
                true,
            );
        }
        if !full {
            report.skipped.push(
                "overlays on screen, overlay paint, follow, the refused table's overlay (the HUD \
                 ran on the simulator's event stream, headless)"
                    .to_owned(),
            );
        }
        drop(app);
        let _ = std::fs::remove_dir_all(&base);
        report
    }

    // ---------------------------------------------------------------------
    // Per system.

    #[cfg(windows)]
    mod os {
        use std::time::{Duration, Instant};

        use rail_hud::platform::windows::{OVERLAY_CLASS, drive, enumerate, probe};
        use rail_hud::platform::{Rect, WindowId};
        use serde_json::{Value, json};

        use super::super::support::Seen;
        use super::{App, micros};

        pub const FOLLOW_HOW: &str = "SetWindowPos from the test process (a user's drag) \
            returned -> the HUD's overlay window rect equals the table's client rect";

        /// A simulator table's window.
        #[derive(Debug, Clone)]
        pub struct Table {
            pub id: WindowId,
        }

        pub fn can_find() -> Result<(), String> {
            Ok(())
        }

        pub fn machine() -> Value {
            json!({
                "os": "windows",
                "arch": std::env::consts::ARCH,
                "cpu": std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default(),
                "cores": std::thread::available_parallelism().map_or(0, std::num::NonZero::get),
                "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            })
        }

        pub fn displays() -> Value {
            let dpis: Vec<u32> = enumerate()
                .map(|all| all.iter().map(|w| w.monitor_dpi).collect())
                .unwrap_or_default();
            let mut dpis = dpis;
            dpis.sort_unstable();
            dpis.dedup();
            json!({"monitorDpis": dpis})
        }

        pub fn cpu_time(pid: u32) -> Option<Duration> {
            probe::cpu_time(pid)
        }

        /// Working set now and at its peak.
        pub fn memory(pid: u32) -> Option<(u64, Option<u64>)> {
            probe::memory(pid).map(|(now, peak)| (now, Some(peak)))
        }

        pub fn locate(pid: u32, seen: &Seen, n: u64) -> Option<Table> {
            let (title, _, _) = seen.tables.get(&n)?;
            enumerate()
                .ok()?
                .into_iter()
                .find(|w| w.pid == pid && &w.title == title)
                .map(|w| Table { id: w.id })
        }

        /// The HUD's overlay of `table`: owned by it, shown.
        pub fn overlay_of(hud: u32, table: &Table) -> Option<WindowId> {
            probe::windows_of(hud)
                .into_iter()
                .find(|(id, class)| {
                    class == OVERLAY_CLASS
                        && probe::owner(*id) == Some(table.id)
                        && probe::visible(*id)
                })
                .map(|(id, _)| id)
        }

        pub fn count_overlays(hud: u32) -> usize {
            probe::windows_of(hud)
                .into_iter()
                .filter(|(id, class)| class == OVERLAY_CLASS && probe::visible(*id))
                .count()
        }

        /// Move the table by (`dx`, `dy`) as a user's drag would; µs from
        /// the move to its overlay over the new client area.
        pub fn follow_once(
            app: &mut App,
            hud: u32,
            _n: u64,
            table: &Table,
            dx: i32,
            dy: i32,
        ) -> Result<u64, String> {
            let overlay = overlay_of(hud, table).ok_or("no overlay before the move")?;
            let frame: Rect = probe::window_rect(table.id).ok_or("the table is gone")?;
            drive::move_window(table.id, frame.x + dx, frame.y + dy)?;
            let moved = Instant::now();
            let target = probe::client_area(table.id).ok_or("the table is gone")?;
            loop {
                if probe::window_rect(overlay) == Some(target) && probe::visible(overlay) {
                    let lag = micros(moved.elapsed());
                    app.pump();
                    return Ok(lag);
                }
                if moved.elapsed() > Duration::from_secs(3) {
                    return Err(format!(
                        "overlay at {:?}, the table's client area {target:?}",
                        probe::window_rect(overlay)
                    ));
                }
                std::thread::sleep(Duration::from_micros(200));
            }
        }

        pub fn listing(hud: u32) -> String {
            format!("{:?}", probe::windows_of(hud))
        }
    }

    #[cfg(target_os = "macos")]
    mod os {
        use std::process::Command;
        use std::time::{Duration, Instant};

        use rail_hud::platform::Rect;
        use rail_hud::platform::macos::{self, Frame};
        use serde_json::{Value, json};

        use super::super::support::Seen;
        use super::{App, micros};

        pub const FOLLOW_HOW: &str = "the simulator moves its own window (as a client's is \
            under a user's drag); from the window server showing the table at its new place to \
            the HUD's overlay window there, both polled every 2 ms";

        /// A simulator table's window: its number, title bar (thousandths
        /// of a point) and the screen's scale.
        #[derive(Debug, Clone)]
        pub struct Table {
            pub id: u32,
            pub bar: i64,
            pub scale: u32,
        }

        pub fn can_find() -> Result<(), String> {
            if macos::accessibility_granted() {
                Ok(())
            } else {
                Err(
                    "this process does NOT have the Accessibility permission, so the HUD cannot \
                     read the tables' titles: SKIPPED the overlays on screen, their paint, the \
                     follow and the refused table's overlay; the data path ran with the \
                     simulator's event stream (headless). Grant the terminal Accessibility \
                     (System Settings, Privacy & Security) and run again for the full report"
                        .to_owned(),
                )
            }
        }

        fn sysctl(name: &str) -> String {
            Command::new("sysctl")
                .args(["-n", name])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .unwrap_or_default()
        }

        pub fn machine() -> Value {
            json!({
                "os": "macos",
                "arch": std::env::consts::ARCH,
                "cpu": sysctl("machdep.cpu.brand_string"),
                "osVersion": sysctl("kern.osproductversion"),
                "cores": std::thread::available_parallelism().map_or(0, std::num::NonZero::get),
                "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            })
        }

        pub fn displays() -> Value {
            let all: Vec<Value> = macos::displays()
                .iter()
                .map(|d| json!(format!("{d:?}")))
                .collect();
            json!(all)
        }

        fn ps(pid: u32, field: &str) -> Option<String> {
            let out = Command::new("ps")
                .args(["-o", field, "-p", &pid.to_string()])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            (!text.is_empty()).then_some(text)
        }

        /// CPU time so far (`ps`; 10 ms resolution).
        pub fn cpu_time(pid: u32) -> Option<Duration> {
            let text = ps(pid, "time=")?;
            // [[dd-]hh:]mm:ss.cc
            let (rest, centis) = text.split_once('.').unwrap_or((&text, "0"));
            let mut seconds = 0u64;
            for part in rest.split(':') {
                let part = part.rsplit('-').next().unwrap_or(part);
                seconds = seconds * 60 + part.parse::<u64>().ok()?;
            }
            let centis: u64 = centis.parse().ok()?;
            Some(Duration::from_millis(seconds * 1000 + centis * 10))
        }

        /// Resident memory now (`ps`); no peak on macOS.
        pub fn memory(pid: u32) -> Option<(u64, Option<u64>)> {
            let kib: u64 = ps(pid, "rss=")?.parse().ok()?;
            Some((kib * 1024, None))
        }

        fn int(event: &Value, key: &str) -> i64 {
            event[key].as_i64().unwrap_or(i64::MIN)
        }

        fn client_of(event: &Value) -> Rect {
            Rect {
                x: i32::try_from(int(event, "clientX")).unwrap_or(0),
                y: i32::try_from(int(event, "clientY")).unwrap_or(0),
                width: u32::try_from(int(event, "width")).unwrap_or(0),
                height: u32::try_from(int(event, "height")).unwrap_or(0),
            }
        }

        /// The simulator's window whose frame is table `n`'s last `window`
        /// event (the window server's list; no permission).
        pub fn locate(pid: u32, seen: &Seen, n: u64) -> Option<Table> {
            let event = seen.windows.get(&n)?;
            let displays = macos::displays();
            macos::cg_windows()
                .ok()?
                .into_iter()
                .filter(|w| w.pid == pid && w.layer == 0)
                .find_map(|w| {
                    let scale = macos::display_scale(&w.bounds, &displays);
                    let px = macos::to_pixels(&w.bounds, scale);
                    let bottom = i64::from(px.y) + i64::from(px.height);
                    let same = i64::from(px.x) == int(event, "x")
                        && i64::from(px.y) == int(event, "y")
                        && i64::from(px.width) == int(event, "width")
                        && (bottom - (int(event, "clientY") + int(event, "height"))).abs() <= 1;
                    same.then(|| Table {
                        id: w.id,
                        bar: macos::title_bar_between(&w.bounds, &client_of(event), scale),
                        scale,
                    })
                })
        }

        /// The table's client area now, points.
        fn client_now(table: &Table) -> Option<Frame> {
            let window = macos::window_now(table.id)?;
            Some(macos::client_frame(&window.bounds, table.bar))
        }

        /// The HUD's window exactly over the table's client area.
        pub fn overlay_of(hud: u32, table: &Table) -> Option<u32> {
            let client = client_now(table)?;
            macos::cg_windows()
                .ok()?
                .into_iter()
                .find(|w| w.pid == hud && w.onscreen && w.layer == 0 && w.bounds.close_to(&client))
                .map(|w| w.id)
        }

        /// The HUD's overlay windows on screen (its click windows, one per
        /// panel, are far smaller than any table).
        pub fn count_overlays(hud: u32) -> usize {
            macos::cg_windows()
                .map(|all| {
                    all.into_iter()
                        .filter(|w| {
                            w.pid == hud
                                && w.onscreen
                                && w.layer == 0
                                && w.bounds.width >= 300 * 1000
                                && w.bounds.height >= 200 * 1000
                        })
                        .count()
                })
                .unwrap_or(0)
        }

        /// Have the simulator move table `n` by (`dx`, `dy`) pixels; µs
        /// from the window server showing it there to the HUD's overlay
        /// there.
        pub fn follow_once(
            app: &mut App,
            hud: u32,
            n: u64,
            table: &Table,
            dx: i32,
            dy: i32,
        ) -> Result<u64, String> {
            let overlay = overlay_of(hud, table).ok_or("no overlay before the move")?;
            let before = client_now(table).ok_or("the table is gone")?;
            let window = macos::window_now(table.id).ok_or("the table is gone")?;
            let px = macos::to_pixels(&window.bounds, table.scale);
            app.sim_a
                .command(&format!("move {n} {} {}", px.x + dx, px.y + dy));
            let sent = Instant::now();
            let mut seen_at: Option<(Instant, Frame)> = None;
            loop {
                let now = client_now(table);
                if let Some(now) = now
                    && now != before
                    && seen_at.is_none_or(|(_, f)| f != now)
                {
                    seen_at = Some((Instant::now(), now));
                }
                if let Some((at, target)) = seen_at
                    && macos::window_now(overlay)
                        .is_some_and(|w| w.onscreen && w.bounds.close_to(&target))
                {
                    let lag = micros(at.elapsed());
                    app.pump();
                    return Ok(lag);
                }
                if sent.elapsed() > Duration::from_secs(3) {
                    return Err(format!(
                        "table at {now:?} (before {before:?}), overlay at {:?}",
                        macos::window_now(overlay).map(|w| w.bounds)
                    ));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        pub fn listing(hud: u32) -> String {
            macos::cg_windows()
                .map(|all| {
                    all.iter()
                        .filter(|w| w.layer == 0)
                        .map(|w| {
                            format!(
                                "  #{} pid {}{} {:?}{}",
                                w.id,
                                w.pid,
                                if w.pid == hud { " (HUD)" } else { "" },
                                w.bounds,
                                if w.onscreen { "" } else { " off screen" }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        }
    }
}
