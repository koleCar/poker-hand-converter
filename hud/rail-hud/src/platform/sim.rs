//! A fake backend driven by the table simulator (`rail-hud-sim`, R3.1):
//! its events on standard output - JSON lines `started` (with the
//! simulator's own title regex), `table`, `window`, `closed` - are the
//! windows. No window API is touched, so the HUD's data path (find, attach,
//! compliance, `hand_imported`, re-read, overlay) runs on any OS, headless
//! too, and in CI.
//!
//! **A test-only room entry.** The simulator's windows are no room's. The
//! backend is told which `sites.json` id to pose as (`--sim-site`) and
//! takes a window when the simulator's own title regex (printed in its
//! `started` event; `room::title_regex`, which claims nothing about real
//! clients) reads a `table` from its title - the matcher a real room gets
//! from `sites.json` `tables` in R3.3 / R3.11. Nothing of this is in
//! `sites.json`. Compliance mode then decides on the posed id exactly as it
//! would for a real window: pose as `pokerstars` and the HUD attaches, pose
//! as `ggpoker` and it refuses. It cannot help a real client past
//! compliance: this backend only ever reports the simulator's tables, and
//! its "overlays" are records in memory.
//!
//! The events reach the backend through a [`SimFeed`]: from a file the
//! simulator's standard output is written to ([`SimBackend::tail`], the
//! HUD's `--sim-events`), or line by line in tests.

use std::collections::BTreeMap;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use super::{
    OverlayFrame, Platform, PlatformError, ProcessInfo, Rect, TableEvent, TableMatcher,
    TableWindow, WindowId,
};

/// The simulator's process name (R3.1: the process is `rail-hud-sim`).
pub const SIM_PROCESS: &str = "rail-hud-sim";

#[derive(Debug, Clone, PartialEq, Eq)]
struct SimTable {
    title: String,
    size: Option<u32>,
    client: Rect,
    minimized: bool,
}

#[derive(Debug, Default)]
struct Feed {
    title_regex: Option<Regex>,
    tables: BTreeMap<u32, SimTable>,
    /// Lines that were not an event (logged once).
    bad_lines: u64,
}

/// Where the simulator's event lines go in.
#[derive(Debug, Clone, Default)]
pub struct SimFeed(Arc<Mutex<Feed>>);

fn number(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|n| u32::try_from(n).ok())
}

impl SimFeed {
    /// One line of the simulator's standard output.
    pub fn push_line(&self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let mut feed = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            feed.bad_lines += 1;
            return;
        };
        let table = number(&event["table"]);
        match event["event"].as_str() {
            Some("started") => match event["titleRegex"].as_str().map(Regex::new) {
                Some(Ok(regex)) => feed.title_regex = Some(regex),
                Some(Err(error)) => eprintln!("rail-hud: the simulator's title regex: {error}"),
                None => {}
            },
            Some("table") => {
                if let (Some(table), Some(title)) = (table, event["title"].as_str()) {
                    let entry = feed.tables.entry(table).or_insert_with(|| SimTable {
                        title: String::new(),
                        size: None,
                        client: Rect::default(),
                        minimized: false,
                    });
                    title.clone_into(&mut entry.title);
                    entry.size = number(&event["size"]);
                }
            }
            Some("window") => {
                if let Some(entry) = table.and_then(|t| feed.tables.get_mut(&t)) {
                    entry.client = Rect {
                        x: event["x"]
                            .as_i64()
                            .and_then(|x| i32::try_from(x).ok())
                            .unwrap_or(0),
                        y: event["y"]
                            .as_i64()
                            .and_then(|y| i32::try_from(y).ok())
                            .unwrap_or(0),
                        width: number(&event["width"]).unwrap_or(0),
                        height: number(&event["height"]).unwrap_or(0),
                    };
                    entry.minimized = event["minimized"].as_bool().unwrap_or(false);
                    if let Some(title) = event["title"].as_str() {
                        title.clone_into(&mut entry.title);
                    }
                }
            }
            Some("closed") => {
                if let Some(table) = table {
                    feed.tables.remove(&table);
                }
            }
            _ => {}
        }
    }
}

/// The fake backend.
#[derive(Debug)]
pub struct SimBackend {
    feed: SimFeed,
    /// The `sites.json` id the simulator's tables pose as.
    site: String,
    tracked: BTreeMap<WindowId, SimTable>,
    overlays: BTreeMap<WindowId, OverlayFrame>,
    /// Ends the tailing thread.
    stop: Arc<AtomicBool>,
}

impl Drop for SimBackend {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl SimBackend {
    /// A backend fed by hand (tests): push the simulator's lines into the
    /// returned feed.
    pub fn new(site: impl Into<String>) -> (Self, SimFeed) {
        let feed = SimFeed::default();
        (
            Self {
                feed: feed.clone(),
                site: site.into(),
                tracked: BTreeMap::new(),
                overlays: BTreeMap::new(),
                stop: Arc::new(AtomicBool::new(false)),
            },
            feed,
        )
    }

    /// A backend fed from `path`, the simulator's standard output as it is
    /// written: read from the start, then followed (every 10 ms) as it grows.
    pub fn tail(path: PathBuf, site: impl Into<String>) -> std::io::Result<Self> {
        let (backend, feed) = Self::new(site);
        let stop = Arc::clone(&backend.stop);
        std::thread::Builder::new()
            .name("rail-hud-sim-events".to_owned())
            .spawn(move || {
                let mut file = None;
                let mut offset = 0u64;
                let mut pending = Vec::new();
                while !stop.load(Ordering::SeqCst) {
                    if file.is_none() {
                        file = std::fs::File::open(&path).ok();
                    }
                    if let Some(f) = file.as_mut() {
                        let mut chunk = Vec::new();
                        if f.seek(SeekFrom::Start(offset)).is_ok()
                            && f.read_to_end(&mut chunk).is_ok()
                        {
                            offset += u64::try_from(chunk.len()).unwrap_or(0);
                            pending.extend_from_slice(&chunk);
                            while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                                let line: Vec<u8> = pending.drain(..=end).collect();
                                feed.push_line(&String::from_utf8_lossy(&line));
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            })?;
        Ok(backend)
    }

    /// The last frame drawn over each window (what a test checks).
    pub fn overlays(&self) -> &BTreeMap<WindowId, OverlayFrame> {
        &self.overlays
    }

    fn matcher(&self) -> Option<TableMatcher> {
        let feed = self.feed.0.lock().unwrap_or_else(PoisonError::into_inner);
        feed.title_regex.as_ref().map(|regex| TableMatcher {
            site: self.site.clone(),
            processes: vec![SIM_PROCESS.to_owned()],
            title: regex.clone(),
        })
    }

    fn snapshot(&self) -> BTreeMap<u32, SimTable> {
        self.feed
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .tables
            .clone()
    }
}

impl Platform for SimBackend {
    fn name(&self) -> &'static str {
        "sim"
    }

    /// The simulator's tables whose titles its own regex reads, posing as
    /// the configured room; `_matchers` (the real rooms') never match them.
    fn find_tables(
        &mut self,
        _matchers: &[TableMatcher],
    ) -> Result<Vec<TableWindow>, PlatformError> {
        let Some(matcher) = self.matcher() else {
            return Ok(Vec::new()); // no `started` event yet
        };
        Ok(self
            .snapshot()
            .into_iter()
            .filter_map(|(number, table)| {
                let group = matcher.matches(SIM_PROCESS, &table.title)?;
                Some(TableWindow {
                    id: WindowId(u64::from(number)),
                    site: matcher.site.clone(),
                    process: ProcessInfo {
                        pid: None,
                        name: SIM_PROCESS.to_owned(),
                    },
                    title: table.title,
                    table: group,
                    size: table.size,
                    client: table.client,
                    scale_permille: 1000,
                    minimized: table.minimized,
                })
            })
            .collect())
    }

    fn track(&mut self, window: &TableWindow) -> Result<(), PlatformError> {
        let number = u32::try_from(window.id.0).map_err(|_| PlatformError::Gone(window.id))?;
        let table = self
            .snapshot()
            .remove(&number)
            .ok_or(PlatformError::Gone(window.id))?;
        self.tracked.insert(window.id, table);
        Ok(())
    }

    fn untrack(&mut self, id: WindowId) {
        self.tracked.remove(&id);
    }

    fn poll_events(&mut self) -> Vec<TableEvent> {
        let now = self.snapshot();
        let regex = self.matcher();
        let mut events = Vec::new();
        for (id, seen) in &mut self.tracked {
            let current = u32::try_from(id.0).ok().and_then(|n| now.get(&n));
            let Some(current) = current else {
                events.push(TableEvent::Closed { id: *id });
                continue;
            };
            if current.client != seen.client {
                events.push(TableEvent::Moved {
                    id: *id,
                    client: current.client,
                    scale_permille: 1000,
                });
            }
            if current.minimized != seen.minimized {
                events.push(TableEvent::Minimized {
                    id: *id,
                    minimized: current.minimized,
                });
            }
            if current.title != seen.title {
                events.push(TableEvent::Retitled {
                    id: *id,
                    title: current.title.clone(),
                    table: regex
                        .as_ref()
                        .and_then(|m| m.matches(SIM_PROCESS, &current.title))
                        .flatten(),
                });
            }
            *seen = current.clone();
        }
        for event in &events {
            if let TableEvent::Closed { id } = event {
                self.tracked.remove(id);
            }
        }
        events
    }

    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError> {
        if !self.tracked.contains_key(&id) {
            return Err(PlatformError::Gone(id));
        }
        self.overlays.insert(id, frame.clone());
        Ok(())
    }

    fn remove_overlay(&mut self, id: WindowId) {
        self.overlays.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGEX: &str = r"^(?P<table>.+?) - .*$";

    fn started(feed: &SimFeed) {
        feed.push_line(
            &serde_json::json!({"event": "started", "room": "pokerstars", "titleRegex": REGEX})
                .to_string(),
        );
    }

    fn table(feed: &SimFeed, n: u32, title: &str) {
        feed.push_line(
            &serde_json::json!({"event": "table", "table": n, "title": title, "tableName": "x",
                "size": 6, "game": "g", "heroSeat": 1, "moved": false})
            .to_string(),
        );
    }

    #[test]
    fn tables_come_from_the_simulators_events() {
        let (mut backend, feed) = SimBackend::new("pokerstars");
        table(&feed, 1, "Hygiea - $0.05/$0.10");
        assert!(
            backend.find_tables(&[]).expect("find").is_empty(),
            "nothing before `started`"
        );
        started(&feed);
        feed.push_line("not json");
        let found = backend.find_tables(&[]).expect("find");
        assert_eq!(found.len(), 1);
        let window = &found[0];
        assert_eq!(window.site, "pokerstars");
        assert_eq!(window.table.as_deref(), Some("Hygiea"));
        assert_eq!(window.size, Some(6));
        assert_eq!(window.process.name, SIM_PROCESS);

        backend.track(window).expect("track");
        assert!(backend.poll_events().is_empty());
        feed.push_line(
            &serde_json::json!({"event": "window", "table": 1, "title": "Hygiea - $0.05/$0.10",
                "x": -20, "y": 30, "width": 800, "height": 600, "minimized": false})
            .to_string(),
        );
        assert_eq!(
            backend.poll_events(),
            [TableEvent::Moved {
                id: WindowId(1),
                client: Rect {
                    x: -20,
                    y: 30,
                    width: 800,
                    height: 600
                },
                scale_permille: 1000
            }]
        );
        table(&feed, 1, "Florence 03 - $0.05/$0.10");
        assert_eq!(
            backend.poll_events(),
            [TableEvent::Retitled {
                id: WindowId(1),
                title: "Florence 03 - $0.05/$0.10".into(),
                table: Some("Florence 03".into())
            }]
        );
        backend
            .overlay(WindowId(1), &OverlayFrame::default())
            .expect("overlay");
        assert_eq!(backend.overlays().len(), 1);
        assert_eq!(
            backend.overlay(WindowId(2), &OverlayFrame::default()),
            Err(PlatformError::Gone(WindowId(2)))
        );
        feed.push_line(r#"{"event":"closed","table":1}"#);
        assert_eq!(
            backend.poll_events(),
            [TableEvent::Closed { id: WindowId(1) }]
        );
        assert!(backend.poll_events().is_empty());
        assert!(backend.find_tables(&[]).expect("find").is_empty());
    }

    /// A title the simulator's regex does not read is not a table.
    #[test]
    fn untitled_windows_are_not_tables() {
        let (mut backend, feed) = SimBackend::new("winamax");
        feed.push_line(
            &serde_json::json!({"event": "started", "titleRegex": r"^Table (?P<table>\d+)$"})
                .to_string(),
        );
        table(&feed, 1, "Table 7");
        table(&feed, 2, "Lobby");
        let found = backend.find_tables(&[]).expect("find");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].table.as_deref(), Some("7"));
    }

    #[test]
    fn a_file_is_followed_as_it_grows() {
        let dir = std::env::temp_dir().join(format!("rail-hud-sim-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("events.jsonl");
        let mut backend = SimBackend::tail(path.clone(), "acr").expect("tail");
        let started = serde_json::json!({"event": "started", "titleRegex": REGEX}).to_string();
        std::fs::write(
            &path,
            format!("{started}\n{{\"event\":\"table\",\"table\":3,"),
        )
        .expect("write");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        std::io::Write::write_all(&mut file, b"\"title\":\"T9 - x\",\"size\":9}\n")
            .expect("append");
        let found = loop {
            let found = backend.find_tables(&[]).expect("find");
            if !found.is_empty() || std::time::Instant::now() > deadline {
                break found;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, WindowId(3));
        assert_eq!(found[0].table.as_deref(), Some("T9"));
        drop(backend);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
