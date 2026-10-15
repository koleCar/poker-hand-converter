//! The table simulator as a child process, for the Windows overlay tests
//! (R3.4): start it, read its events, send it commands, find its windows.
//! Everything it said is kept, so a failure can print it.

#![cfg(windows)]
#![allow(dead_code)] // each test file uses part of it

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use rail_hud::platform::windows::{WindowsBackend, enumerate};
use rail_hud::platform::{Platform, TableMatcher, TableWindow};
use regex::Regex;
use serde_json::Value;

/// The simulator binary, built next to this crate's (same profile).
pub fn simulator() -> PathBuf {
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

/// The simulator's own title regex (`--title-regex`).
pub fn title_regex(sim: &Path) -> String {
    let out = Command::new(sim)
        .arg("--title-regex")
        .output()
        .expect("--title-regex");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// The test-only room entry: the simulator's windows as `site`'s.
pub fn matcher(site: &str, regex: &str) -> TableMatcher {
    TableMatcher::simulator(site, Regex::new(regex).expect("the simulator's regex"))
}

/// What the simulator said about its tables.
#[derive(Debug, Default)]
pub struct Seen {
    /// table -> (title, table name, seats)
    pub tables: BTreeMap<u64, (String, String, u32)>,
    /// table -> its latest `window` event
    pub windows: BTreeMap<u64, Value>,
    /// table -> the hero's seat (R3.6: the `table` event's `heroSeat`)
    pub heroes: BTreeMap<u64, u32>,
    /// table -> its latest `hand` event (R3.6: `seated` has the seats)
    pub hands: BTreeMap<u64, Value>,
    pub log: Vec<String>,
}

impl Seen {
    pub fn take(&mut self, event: Value) {
        let table = event["table"].as_u64();
        match (event["event"].as_str(), table) {
            (Some("hand"), Some(t)) => {
                self.hands.insert(t, event.clone());
            }
            (Some("table"), Some(t)) => {
                if let Some(hero) = event["heroSeat"]
                    .as_u64()
                    .and_then(|h| u32::try_from(h).ok())
                {
                    self.heroes.insert(t, hero);
                }
                self.tables.insert(
                    t,
                    (
                        event["title"].as_str().unwrap_or_default().to_owned(),
                        event["tableName"].as_str().unwrap_or_default().to_owned(),
                        u32::try_from(event["size"].as_u64().unwrap_or(0)).unwrap_or(0),
                    ),
                );
            }
            (Some("window"), Some(t)) => {
                self.windows.insert(t, event.clone());
            }
            (Some("closed"), Some(t)) => {
                self.tables.remove(&t);
                self.windows.remove(&t);
                self.heroes.remove(&t);
                self.hands.remove(&t);
            }
            _ => {}
        }
        if event["event"] != "hand" {
            self.log.push(event.to_string());
        }
    }

    /// Read events until `done` holds or `timeout` passes (then fail with
    /// everything said).
    pub fn until(
        &mut self,
        events: &Receiver<Value>,
        timeout: Duration,
        what: &str,
        done: impl Fn(&Self) -> bool,
    ) {
        let deadline = Instant::now() + timeout;
        while !done(self) {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero(),
                "timed out waiting for {what}; the simulator said:\n{}",
                self.log.join("\n")
            );
            if let Ok(event) = events.recv_timeout(left.min(Duration::from_millis(200))) {
                self.take(event);
            }
        }
        eprintln!("step ok: {what}");
    }

    /// Take whatever arrived, without waiting.
    pub fn drain(&mut self, events: &Receiver<Value>) {
        while let Ok(event) = events.try_recv() {
            self.take(event);
        }
    }

    /// The simulator's table whose title is `title`.
    pub fn table_titled(&self, title: &str) -> Option<u64> {
        self.tables
            .iter()
            .find(|(_, (t, _, _))| t == title)
            .map(|(n, _)| *n)
    }
}

/// The simulator, running.
pub struct Sim {
    pub child: Child,
    stdin: ChildStdin,
    pub events: Receiver<Value>,
    out: PathBuf,
}

impl Sim {
    /// Start it with `args` (and a fresh folder of its own for the hands).
    pub fn start(sim: &Path, name: &str, args: &[&str]) -> Self {
        let out = std::env::temp_dir().join(format!("rail-hud-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).expect("out folder");
        let mut child = Command::new(sim)
            .args(args)
            .arg("--out")
            .arg(&out)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the simulator starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(event) = serde_json::from_str::<Value>(&line)
                    && tx.send(event).is_err()
                {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            events,
            out,
        }
    }

    pub fn command(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").expect("a command");
        self.stdin.flush().expect("flush");
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "quit");
        let _ = self.stdin.flush();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.out);
    }
}

/// Every visible top-level window Windows reports, for failure messages.
pub fn listing() -> String {
    match enumerate() {
        Ok(all) => all
            .iter()
            .map(|w| {
                format!(
                    "  {:#x} pid {} {:?} class {:?} title {:?} client {:?} dpi {}/{}{}{}",
                    w.id.0,
                    w.pid,
                    w.process,
                    w.class,
                    w.title,
                    w.client,
                    w.monitor_dpi,
                    w.window_dpi,
                    if w.minimized { " minimised" } else { "" },
                    if w.cloaked { " cloaked" } else { "" },
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Err(error) => format!("  enumerate failed: {error}"),
    }
}

/// Find the simulator's tables until `ok` holds (windows settle after the
/// simulator's events), else fail with everything seen.
pub fn find_until(
    backend: &mut WindowsBackend,
    matcher: &TableMatcher,
    seen: &mut Seen,
    events: &Receiver<Value>,
    what: &str,
    ok: impl Fn(&[TableWindow], &Seen) -> Result<(), String>,
) -> Vec<TableWindow> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        seen.drain(events);
        let found = backend
            .find_tables(std::slice::from_ref(matcher))
            .unwrap_or_else(|e| panic!("find_tables: {e}\nwindows:\n{}", listing()));
        match ok(&found, seen) {
            Ok(()) => {
                eprintln!("step ok: {what}");
                return found;
            }
            Err(why) if Instant::now() >= deadline => panic!(
                "{what}: {why}\nfound:\n{found:#?}\nthe simulator said:\n{}\nwindows:\n{}",
                seen.log.join("\n"),
                listing()
            ),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// Poll `check` until it gives `Some` or `timeout` passes; `what` and the
/// last state explain a failure.
pub fn wait_for<T>(
    timeout: Duration,
    what: &str,
    mut check: impl FnMut() -> Result<T, String>,
) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        match check() {
            Ok(value) => {
                eprintln!("step ok: {what}");
                return value;
            }
            Err(why) if Instant::now() >= deadline => {
                panic!("{what}: {why}\nwindows:\n{}", listing())
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// `rail-hud` as a child, its standard error read line by line.
pub struct Hud {
    pub child: Child,
    lines: Receiver<String>,
    pub seen: Vec<String>,
}

impl Hud {
    pub fn start(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rail-hud"))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("rail-hud starts");
        let stderr = child.stderr.take().expect("stderr");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            lines,
            seen: Vec::new(),
        }
    }

    /// Read its standard error until `count` lines contain `marker` (or
    /// `timeout`); whether they did.
    pub fn until(&mut self, marker: &str, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.seen.iter().filter(|l| l.contains(marker)).count() >= count {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            if let Ok(line) = self.lines.recv_timeout(Duration::from_millis(200)) {
                self.seen.push(line);
            }
        }
    }

    pub fn log(&self) -> String {
        self.seen.join("\n")
    }
}

impl Drop for Hud {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
