//! The table simulator as a child process, for the Windows overlay tests
//! (R3.4) and the macOS ones (R3.11): start it, read its events, send it
//! commands, find its windows. Everything it said is kept, so a failure can
//! print it.

#![cfg(any(windows, target_os = "macos"))]
#![allow(dead_code)] // each test file uses part of it

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

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
    /// The simulator closed its standard output (it exited): nothing more
    /// will come.
    pub ended: bool,
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
            (Some("ended"), _) => self.ended = true,
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
    /// everything said - its standard error included).
    pub fn until(
        &mut self,
        events: &Receiver<Value>,
        timeout: Duration,
        what: &str,
        done: impl Fn(&Self) -> bool,
    ) {
        if let Err(why) = self.try_until(events, timeout, what, done) {
            panic!("{why}");
        }
    }

    /// [`Seen::until`], the failure returned: a timeout, or the simulator
    /// gone before `done` held (no use waiting out the timeout then).
    pub fn try_until(
        &mut self,
        events: &Receiver<Value>,
        timeout: Duration,
        what: &str,
        done: impl Fn(&Self) -> bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        while !done(self) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || self.ended {
                return Err(format!(
                    "{} waiting for {what}; the simulator said (stdout events and stderr lines):\n{}",
                    if self.ended {
                        "the simulator ended its output"
                    } else {
                        "timed out"
                    },
                    self.log.join("\n")
                ));
            }
            if let Ok(event) = events.recv_timeout(left.min(Duration::from_millis(200))) {
                self.take(event);
            }
        }
        eprintln!("step ok: {what}");
        Ok(())
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
    /// Start it with `args` and a fresh folder of its own for the hands:
    /// `rail-hud-sim-<name>-<pid>`, a name no test's own folder takes (the
    /// simulator refuses a folder it did not make, and a test's store kept
    /// open in a folder of the same name could not be removed on Windows -
    /// R3.8's first popup test met exactly that). Its standard error is
    /// echoed and also arrives as `stderr` events, and the end of its output
    /// as an `ended` event, so a failure says why it stopped.
    pub fn start(sim: &Path, name: &str, args: &[&str]) -> Self {
        let out = Self::folder(name);
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).expect("out folder");
        Self::start_into(sim, out, args, None)
    }

    /// (R3.14) The folder [`Sim::start`] gives the simulator `name`.
    pub fn folder(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rail-hud-sim-{name}-{}", std::process::id()))
    }

    /// (R3.14) Start it writing into `out` - an empty folder the caller
    /// made (and may watch already); removed when the simulator is
    /// dropped - and, with `tee`, every line of its standard output also
    /// copied to that file as it comes (what `rail-hud --platform sim`
    /// tails).
    pub fn start_into(sim: &Path, out: PathBuf, args: &[&str], tee: Option<PathBuf>) -> Self {
        let mut tee = tee.map(|path| std::fs::File::create(path).expect("the events file"));
        let mut child = Command::new(sim)
            .args(args)
            .arg("--out")
            .arg(&out)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the simulator starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let (tx, events) = mpsc::channel();
        let errors = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("{line}");
                if errors
                    .send(serde_json::json!({"event": "stderr", "line": line}))
                    .is_err()
                {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(file) = tee.as_mut() {
                    let _ = writeln!(file, "{line}").and_then(|()| file.flush());
                }
                if let Ok(event) = serde_json::from_str::<Value>(&line)
                    && tx.send(event).is_err()
                {
                    return;
                }
            }
            let _ = tx.send(serde_json::json!({"event": "ended"}));
        });
        Self {
            child,
            stdin,
            events,
            out,
        }
    }

    /// [`Seen::until`] on this simulator's events; a failure also says
    /// whether it is still running or how it exited.
    pub fn until(
        &mut self,
        seen: &mut Seen,
        timeout: Duration,
        what: &str,
        done: impl Fn(&Seen) -> bool,
    ) {
        if let Err(why) = seen.try_until(&self.events, timeout, what, done) {
            // Its last words (stderr) may still be on the way.
            std::thread::sleep(Duration::from_millis(300));
            let before = seen.log.len();
            seen.drain(&self.events);
            panic!(
                "{why}\nthen:\n{}\n{}",
                seen.log[before..].join("\n"),
                self.status()
            );
        }
    }

    /// Whether the simulator is still running, or its exit status.
    pub fn status(&mut self) -> String {
        match self.child.try_wait() {
            Ok(Some(status)) => format!("the simulator exited: {status}"),
            Ok(None) => "the simulator is still running".to_owned(),
            Err(error) => format!("the simulator's status: {error}"),
        }
    }

    /// The folder it writes its hands into.
    pub fn out(&self) -> &Path {
        &self.out
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
#[cfg(windows)]
pub fn listing() -> String {
    match rail_hud::platform::windows::enumerate() {
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

/// (R3.11) Every ordinary window the macOS window server lists (bounds,
/// pid, on screen), then the simulator's windows as the backend joins them
/// with their accessibility titles (none without the permission), for
/// failure messages.
#[cfg(target_os = "macos")]
pub fn listing() -> String {
    use rail_hud::platform::macos;
    let mut out = match macos::cg_windows() {
        Ok(all) => all
            .iter()
            .filter(|w| w.layer == 0)
            .map(|w| {
                format!(
                    "  #{} pid {} {:?} bounds {:?}{}",
                    w.id,
                    w.pid,
                    w.owner,
                    w.bounds,
                    if w.onscreen { "" } else { " off screen" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Err(error) => format!("  the window list failed: {error}"),
    };
    let sim = |p: &str| rail_hud::platform::matcher::same_process(p, "rail-hud-sim");
    match macos::enumerate(&sim) {
        Ok(all) => {
            for w in all {
                out.push_str(&format!(
                    "\n  sim #{} {:?} subrole {:?} client {:?} dpi {}{}{}",
                    w.id.0,
                    w.title,
                    w.class,
                    w.client,
                    w.monitor_dpi,
                    if w.minimized { " minimised" } else { "" },
                    if w.cloaked { " off screen" } else { "" },
                ));
            }
        }
        Err(error) => out.push_str(&format!("\n  enumerate failed: {error}")),
    }
    out
}

/// Find the simulator's tables until `ok` holds (windows settle after the
/// simulator's events), else fail with everything seen.
pub fn find_until(
    backend: &mut impl Platform,
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
