//! Finding tables on Windows with real windows (docs/RAIL-PLAN.md R3.3), in
//! CI on the Windows runner (it has a desktop session; the job's windowed
//! simulator smoke step runs there too). Elsewhere this file is empty.
//!
//! The table simulator opens three windows of PokerStars-like tables at a
//! fixed logical size; the Windows backend, given the simulator's test-only
//! room entry (its process and its own `--title-regex`), must find exactly
//! those three - by `EnumWindows`, titles and the owning process - with the
//! table names the simulator's hands carry, client rects equal to what the
//! simulator itself reports (physical pixels), sizes that are the logical
//! size times the monitor's scale, and nothing else. Then: a minimised
//! table is still found and marked; a tournament-style table move retitles
//! the same window; `rail-hud --list-windows` lists the three, redacted;
//! `rail-hud --standalone --sim-site ...` attaches to them (an allowed
//! room) or refuses them (a prohibited one).
//!
//! Everything found is printed when an assertion fails, so a CI failure
//! says what Windows reported.

#![cfg(windows)]

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use rail_hud::platform::matcher::same_process;
use rail_hud::platform::windows::{WindowsBackend, enumerate};
use rail_hud::platform::{Platform, TableMatcher, TableWindow, table_key};
use regex::Regex;
use serde_json::Value;

/// The client size asked of the simulator, in logical pixels.
const WIDTH: u32 = 640;
const HEIGHT: u32 = 480;

/// The simulator binary, built next to this crate's (same profile).
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

/// What the simulator said about its tables.
#[derive(Debug, Default)]
struct Seen {
    /// table -> (title, table name)
    tables: BTreeMap<u64, (String, String)>,
    /// table -> its latest `window` event
    windows: BTreeMap<u64, Value>,
    log: Vec<String>,
}

impl Seen {
    fn take(&mut self, event: Value) {
        let table = event["table"].as_u64();
        match (event["event"].as_str(), table) {
            (Some("table"), Some(t)) => {
                self.tables.insert(
                    t,
                    (
                        event["title"].as_str().unwrap_or_default().to_owned(),
                        event["tableName"].as_str().unwrap_or_default().to_owned(),
                    ),
                );
            }
            (Some("window"), Some(t)) => {
                self.windows.insert(t, event.clone());
            }
            (Some("closed"), Some(t)) => {
                self.tables.remove(&t);
                self.windows.remove(&t);
            }
            _ => {}
        }
        if event["event"] != "hand" {
            self.log.push(event.to_string());
        }
    }

    /// Read events until `done` holds or `timeout` passes.
    fn until(
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
    }
}

struct Sim {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<Value>,
    out: PathBuf,
}

impl Sim {
    fn start(sim: &Path) -> Self {
        let out =
            std::env::temp_dir().join(format!("rail-hud-windows-tables-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).expect("out folder");
        let mut child = Command::new(sim)
            .args([
                "--tables",
                "3",
                "--window",
                &format!("{WIDTH}x{HEIGHT}"),
                "--speed",
                "1",
                "--seed",
                "7",
                "--out",
            ])
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

    fn command(&mut self, line: &str) {
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
fn listing() -> String {
    match enumerate() {
        Ok(all) => all
            .iter()
            .map(|w| {
                format!(
                    "  {:#x} pid {} {:?} class {:?} title {:?} client {:?} dpi {}/{} {:?}{}{}",
                    w.id.0,
                    w.pid,
                    w.process,
                    w.class,
                    w.title,
                    w.client,
                    w.monitor_dpi,
                    w.window_dpi,
                    w.awareness,
                    if w.minimized { " minimised" } else { "" },
                    if w.cloaked { " cloaked" } else { "" },
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Err(error) => format!("  enumerate failed: {error}"),
    }
}

fn find(backend: &mut WindowsBackend, matcher: &TableMatcher) -> Vec<TableWindow> {
    backend
        .find_tables(std::slice::from_ref(matcher))
        .unwrap_or_else(|e| panic!("find_tables: {e}\nwindows:\n{}", listing()))
}

/// `a` within 2 px of `b` (rounding of a scaled size).
fn close(a: u32, b: u32) -> bool {
    a.abs_diff(b) <= 2
}

fn int(event: &Value, key: &str) -> i64 {
    event[key].as_i64().unwrap_or(i64::MIN)
}

/// Whether `found` agrees with the simulator: table name, rect, scale.
fn check(found: &[TableWindow], seen: &Seen, pid: u32) -> Result<(), String> {
    if found.len() != 3 {
        return Err(format!("{} tables found, 3 expected", found.len()));
    }
    for window in found {
        if window.process.pid != Some(pid) || !same_process(&window.process.name, "rail-hud-sim") {
            return Err(format!("{window:?} is not the simulator's (pid {pid})"));
        }
        let Some((number, (_, name))) = seen
            .tables
            .iter()
            .find(|(_, (title, _))| *title == window.title)
        else {
            return Err(format!(
                "{:?}: no simulator table has this title",
                window.title
            ));
        };
        if window.table.as_deref() != Some(table_key(name).as_str()) {
            return Err(format!(
                "{:?}: table {:?}, the hands say {name:?}",
                window.title, window.table
            ));
        }
        let event = seen
            .windows
            .get(number)
            .ok_or_else(|| format!("table {number}: no window event"))?;
        let c = window.client;
        let expected = (
            int(event, "clientX"),
            int(event, "clientY"),
            int(event, "width"),
            int(event, "height"),
        );
        let got = (
            i64::from(c.x),
            i64::from(c.y),
            i64::from(c.width),
            i64::from(c.height),
        );
        if got != expected {
            return Err(format!(
                "table {number}: client {got:?}, the simulator says {expected:?} (x, y, w, h)"
            ));
        }
        let scale = window.scale_permille;
        if !close(c.width, WIDTH * scale / 1000) || !close(c.height, HEIGHT * scale / 1000) {
            return Err(format!(
                "table {number}: {}x{} is not {WIDTH}x{HEIGHT} at scale {scale}",
                c.width, c.height
            ));
        }
        if window.minimized {
            return Err(format!("table {number} is minimised"));
        }
    }
    Ok(())
}

/// Find until `ok` (windows settle after the simulator's events), else fail
/// with everything seen.
fn find_until(
    backend: &mut WindowsBackend,
    matcher: &TableMatcher,
    seen: &mut Seen,
    events: &Receiver<Value>,
    what: &str,
    ok: impl Fn(&[TableWindow], &Seen) -> Result<(), String>,
) -> Vec<TableWindow> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        while let Ok(event) = events.try_recv() {
            seen.take(event);
        }
        let found = find(backend, matcher);
        let verdict = ok(&found, seen);
        match verdict {
            Ok(()) => return found,
            Err(why) if Instant::now() >= deadline => panic!(
                "{what}: {why}\nfound:\n{found:#?}\nthe simulator said:\n{}\nwindows:\n{}",
                seen.log.join("\n"),
                listing()
            ),
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
}

/// Run `rail-hud` with `args` until `lines` lines of its standard error
/// contain `marker` (or 30 s), then stop it; its standard error.
fn hud_until(args: &[&str], marker: &str, lines: usize) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rail-hud"))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("rail-hud starts");
    let stderr = child.stderr.take().expect("stderr");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut seen = Vec::new();
    while seen.iter().filter(|l: &&String| l.contains(marker)).count() < lines
        && Instant::now() < deadline
    {
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
            seen.push(line);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    seen.join("\n")
}

#[test]
fn the_simulators_windows_are_found() {
    let sim_path = simulator();
    let regex = Command::new(&sim_path)
        .arg("--title-regex")
        .output()
        .expect("--title-regex");
    let title_regex = String::from_utf8_lossy(&regex.stdout).trim().to_owned();
    let matcher = TableMatcher::simulator(
        "pokerstars",
        Regex::new(&title_regex).expect("the simulator's regex"),
    );

    let mut sim = Sim::start(&sim_path);
    let pid = sim.child.id();
    let mut seen = Seen::default();
    seen.until(
        &sim.events,
        Duration::from_secs(90),
        "3 shown windows",
        |s| s.tables.len() == 3 && s.windows.len() == 3,
    );

    let mut backend = WindowsBackend::default();
    let found = find_until(
        &mut backend,
        &matcher,
        &mut seen,
        &sim.events,
        "the three tables",
        |found, seen| check(found, seen, pid),
    );
    eprintln!("found:\n{found:#?}");

    // Visible top-level windows only: a pattern that takes any title of
    // the simulator's process still finds exactly its three tables.
    let any = TableMatcher::simulator("pokerstars", Regex::new("^.*$").expect("regex"));
    let all = find(&mut backend, &any);
    assert_eq!(
        all.len(),
        3,
        "the simulator's visible windows: {all:#?}\nwindows:\n{}",
        listing()
    );
    // No matcher, nothing; a matcher of another process, nothing.
    assert!(
        find(
            &mut backend,
            &TableMatcher {
                site: "pokerstars".into(),
                processes: vec!["PokerStars.exe".into()],
                title: Regex::new("^.*$").expect("regex"),
            }
        )
        .is_empty()
    );

    // A minimised table is still a table, marked so.
    let (&first, _) = seen.tables.iter().next().expect("a table");
    let first_id = found
        .iter()
        .find(|w| Some(&w.title) == seen.tables.get(&first).map(|(t, _)| t))
        .map(|w| w.id)
        .expect("the first table's window");
    sim.command(&format!("minimize {first}"));
    seen.until(&sim.events, Duration::from_secs(20), "the minimise", |s| {
        s.windows
            .get(&first)
            .is_some_and(|e| e["minimized"].as_bool() == Some(true))
    });
    find_until(
        &mut backend,
        &matcher,
        &mut seen,
        &sim.events,
        "a minimised table",
        |found, _| {
            let window = found.iter().find(|w| w.id == first_id);
            match window {
                Some(w) if w.minimized && found.len() == 3 => Ok(()),
                other => Err(format!("{} found, table {first}: {other:?}", found.len())),
            }
        },
    );
    sim.command(&format!("restore {first}"));
    seen.until(&sim.events, Duration::from_secs(20), "the restore", |s| {
        s.windows
            .get(&first)
            .is_some_and(|e| e["minimized"].as_bool() == Some(false))
    });

    // A table move retitles the same window: found again, with the new
    // table's name.
    let before = seen.tables.get(&first).cloned().expect("first table");
    sim.command(&format!("tablemove {first}"));
    seen.until(
        &sim.events,
        Duration::from_secs(20),
        "the table move",
        |s| s.tables.get(&first).is_some_and(|t| *t != before),
    );
    let after = seen.tables.get(&first).cloned().expect("moved table");
    find_until(
        &mut backend,
        &matcher,
        &mut seen,
        &sim.events,
        "the moved table",
        |found, _| match found.iter().find(|w| w.id == first_id) {
            Some(w)
                if w.title == after.0
                    && w.table.as_deref() == Some(table_key(&after.1).as_str()) =>
            {
                Ok(())
            }
            other => Err(format!(
                "table {first} after the move: {other:?}, expected {after:?}"
            )),
        },
    );

    // The diagnostic: the three, redacted (the titles end "Logged In as
    // <hero>").
    let listed = Command::new(env!("CARGO_BIN_EXE_rail-hud"))
        .args([
            "--list-windows",
            "--process",
            "rail-hud-sim.exe",
            "--no-store",
            "--try-title",
            &title_regex,
        ])
        .output()
        .expect("--list-windows");
    let text = String::from_utf8_lossy(&listed.stdout).into_owned();
    eprintln!("--list-windows:\n{text}");
    assert!(
        listed.status.success(),
        "{text}\n{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    assert_eq!(
        text.matches("process: rail-hud-sim.exe").count(),
        3,
        "{text}"
    );
    assert_eq!(text.matches("Logged In as <you>").count(), 3, "{text}");
    assert!(
        !text.contains("SimHero"),
        "the hero's name is redacted: {text}"
    );
    assert_eq!(text.matches("try:     table Some(").count(), 3, "{text}");
    assert!(text.contains(&format!(
        "{}x{} physical px",
        found[0].client.width, found[0].client.height
    )));

    // The HUD process with the native backend and the simulator's room:
    // attached when the room is allowed, refused when it is not.
    let attached = hud_until(
        &[
            "--standalone",
            "--sim-site",
            "pokerstars",
            "--sim-title",
            &title_regex,
        ],
        "attached to window",
        3,
    );
    eprintln!("rail-hud (pokerstars):\n{attached}");
    assert_eq!(
        attached.matches("attached to window").count(),
        3,
        "{attached}"
    );
    for (_, name) in seen.tables.values() {
        assert!(
            attached.contains(&format!("table Some({:?})", table_key(name))),
            "{name}: {attached}"
        );
    }
    let refused = hud_until(
        &[
            "--standalone",
            "--sim-site",
            "ggpoker",
            "--sim-title",
            &title_regex,
        ],
        "not attaching to window",
        3,
    );
    eprintln!("rail-hud (ggpoker):\n{refused}");
    assert_eq!(
        refused.matches("not attaching to window").count(),
        3,
        "{refused}"
    );
    assert!(!refused.contains("attached to window"), "{refused}");
}
