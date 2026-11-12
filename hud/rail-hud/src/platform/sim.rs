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
//!
//! (T1) **Monitors and placing**, so table tiling runs headless: the
//! monitors are a set the test chooses ([`SimBackend::set_monitors`]; one
//! 1920 x 1080 monitor with a 40 px taskbar by default), and
//! [`Platform::place`] records every placement ([`SimBackend::placements`]),
//! gives the client area a client would accept ([`SimBackend::set_accept`]:
//! all of it by default; a room that keeps its aspect ratio, say,
//! otherwise) and puts the table there - restored - as a window manager
//! would, so the next `poll_events` reports the move. The simulator's own
//! windows are not moved: a later `window` event of its own wins.
//!
//! (T2) **Table tiling's engine, headless.** A table reports the scale of
//! the monitor its centre is on ([`scale_at`]), as a per-monitor aware
//! client does; its frame ([`Platform::frame_insets`]) is the test's,
//! given at 100 % and scaled with it; a test may pose single tables as
//! other rooms ([`SimControl::pose`]), give one table a client that
//! refuses sizes ([`SimControl::set_accept_for`]) and press the mouse
//! ([`SimControl::press`]). All of it lives behind a [`SimControl`] that
//! the test keeps after handing the backend to the engine, and that the
//! backend's [`Placer`] places through from the tiling worker's thread.
//!
//! (T4) **The overlays' pointer, headless.** A test reads the frame and the
//! scene over a table ([`SimControl::frame`], [`SimControl::scene`]) and
//! clicks or drags on it ([`SimControl::click`], [`SimControl::drag`]):
//! the next `poll_events` runs the press, the move and the release through
//! the overlays' shared [`super::drag::Drag`] over the scene as painted -
//! what the Windows and macOS overlay threads do with their mouse - and
//! reports `PanelClicked` / `PanelMoved` as they would, the drop kept on
//! the overlay until the engine's frame carries it.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

pub use super::SIM_PROCESS;
use super::drag::{self, Drag};
use super::{
    Insets, Monitor, MonitorId, MouseState, OverlayFrame, Placer, Platform, PlatformError,
    ProcessInfo, Rect, TableEvent, TableMatcher, TableWindow, WindowId,
};
use crate::layout::Positions;
use crate::scene::{Scene, compose_with};

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
                    // The client area's origin (`clientX`, since R3.3);
                    // older simulators gave the frame's only.
                    let at = |client: &str, frame: &str| {
                        event[client]
                            .as_i64()
                            .or_else(|| event[frame].as_i64())
                            .and_then(|v| i32::try_from(v).ok())
                            .unwrap_or(0)
                    };
                    entry.client = Rect {
                        x: at("clientX", "x"),
                        y: at("clientY", "y"),
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
    /// (T1 / T2) What a test sets and reads while the engine owns the
    /// backend: monitors, placements, the accepted sizes, frames, the
    /// mouse, rooms posed per table.
    control: SimControl,
    /// Ends the tailing thread.
    stop: Arc<AtomicBool>,
}

/// (T1) One placement the sim backend carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub id: WindowId,
    pub want: Rect,
    pub accepted: Rect,
}

/// (T1) The sim backend's monitors until a test sets its own: one 1920 x
/// 1080 monitor at 100 %, a 40 px taskbar at the bottom.
pub fn default_monitors() -> Vec<Monitor> {
    vec![Monitor {
        id: MonitorId(1),
        primary: true,
        bounds: Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        },
        work_area: Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        },
        scale_permille: 1000,
    }]
}

/// (T2) The scale of the monitor whose bounds hold the centre of `client`
/// (the primary's when none does; 1000 without monitors): a simulator
/// table placed on a 125 % monitor reports 1250, as a per-monitor aware
/// client on Windows does.
pub fn scale_at(monitors: &[Monitor], client: &Rect) -> u32 {
    let cx = i64::from(client.x) + i64::from(client.width / 2);
    let cy = i64::from(client.y) + i64::from(client.height / 2);
    monitors
        .iter()
        .find(|m| {
            cx >= i64::from(m.bounds.x)
                && cx < m.bounds.right()
                && cy >= i64::from(m.bounds.y)
                && cy < m.bounds.bottom()
        })
        .or_else(|| monitors.iter().find(|m| m.primary))
        .map_or(1000, |m| m.scale_permille)
}

/// (T4) An overlay's drops not taken in yet: (drag number, slot, centre).
type Kept = Vec<(u64, u32, (u32, u32))>;

/// (T4) A test's pointer gesture: table, press, release (`None`: where it
/// was pressed).
type Gesture = (u32, (i32, i32), Option<(i32, i32)>);

#[derive(Debug)]
struct Control {
    monitors: Vec<Monitor>,
    placements: Vec<Placement>,
    accept: fn(Rect) -> Rect,
    /// (T2) Per simulator table: a client of another room.
    accept_for: BTreeMap<u32, fn(Rect) -> Rect>,
    /// (T2) Every table's frame at 100 %, and per table.
    insets: Insets,
    insets_for: BTreeMap<u32, Insets>,
    /// (T2) The room a table poses as, where not the backend's.
    sites: BTreeMap<u32, String>,
    /// (T2) The mouse: a button down, the last press.
    down: bool,
    last_press: Option<Instant>,
    /// (T4) Each overlay's frame and its table's client area, as last drawn.
    frames: BTreeMap<u32, (OverlayFrame, Rect)>,
    /// (T4) Each overlay's drops the engine has not taken in yet: (drag
    /// number, slot, centre).
    kept: BTreeMap<u32, Kept>,
    /// (T4) Pointer gestures for the next `poll_events`: table, press, and
    /// where the pointer is released (`None`: where it was pressed).
    pointer: Vec<Gesture>,
    /// (T4) Drops so far.
    drag_seq: u64,
    /// (T7) The table in front ([`Platform::focused_window`]).
    focused: Option<u32>,
}

impl Control {
    fn insets_of(&self, number: u32, scale_permille: u32) -> Insets {
        self.insets_for
            .get(&number)
            .copied()
            .unwrap_or(self.insets)
            .scaled(1000, scale_permille)
    }
}

/// (T2) A handle on the sim backend's test controls that stays with the
/// test after the backend is handed to the engine (and is what its
/// [`Placer`] places through, from the tiling worker's thread).
#[derive(Debug, Clone)]
pub struct SimControl {
    control: Arc<Mutex<Control>>,
    feed: SimFeed,
}

impl SimControl {
    fn lock(&self) -> std::sync::MutexGuard<'_, Control> {
        self.control.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// (T1) Every placement so far, in order.
    pub fn placements(&self) -> Vec<Placement> {
        self.lock().placements.clone()
    }

    /// (T1) The client area every placement ends with, from the one asked
    /// for (a client that keeps its aspect ratio or a minimum size).
    pub fn set_accept(&self, accept: fn(Rect) -> Rect) {
        self.lock().accept = accept;
    }

    /// (T2) As [`SimControl::set_accept`], for simulator table `number`
    /// only.
    pub fn set_accept_for(&self, number: u32, accept: fn(Rect) -> Rect) {
        self.lock().accept_for.insert(number, accept);
    }

    /// (T2) Every table's frame around its client area, at 100 % (scaled
    /// with the monitor a table is on).
    pub fn set_insets(&self, insets: Insets) {
        self.lock().insets = insets;
    }

    /// (T2) Table `number`'s frame, at 100 %.
    pub fn set_insets_for(&self, number: u32, insets: Insets) {
        self.lock().insets_for.insert(number, insets);
    }

    /// (T2) Table `number` poses as `site` (another room than the
    /// backend's).
    pub fn pose(&self, number: u32, site: &str) {
        self.lock().sites.insert(number, site.to_owned());
    }

    /// (T2) A mouse button goes down (a click starts).
    pub fn press(&self) {
        let mut control = self.lock();
        control.down = true;
        control.last_press = Some(Instant::now());
    }

    /// (T2) The button is released.
    pub fn release(&self) {
        self.lock().down = false;
    }

    /// (T4) The frame drawn over table `number`'s overlay now.
    pub fn frame(&self, number: u32) -> Option<OverlayFrame> {
        self.lock()
            .frames
            .get(&number)
            .map(|(frame, _)| frame.clone())
    }

    /// (T4) What the overlay over table `number` paints now (at 100 %),
    /// with the drops the engine has not taken in yet.
    pub fn scene(&self, number: u32) -> Option<Scene> {
        let control = self.lock();
        let (frame, client) = control.frames.get(&number)?;
        Some(compose_with(
            frame,
            client.width,
            client.height,
            1000,
            &frame.design,
            &overrides(control.kept.get(&number)),
        ))
    }

    /// (T4) A click at client pixel `at` of table `number`'s overlay, taken
    /// at the next `poll_events`.
    pub fn click(&self, number: u32, at: (i32, i32)) {
        self.lock().pointer.push((number, at, None));
    }

    /// (T4) A press at client pixel `from` of table `number`'s overlay,
    /// moved to `to` and released there, taken at the next `poll_events`.
    pub fn drag(&self, number: u32, from: (i32, i32), to: (i32, i32)) {
        self.lock().pointer.push((number, from, Some(to)));
    }

    /// (T7) The user is at table `number` now (`None`: at another
    /// program): what [`Platform::focused_window`] answers.
    pub fn focus(&self, number: Option<u32>) {
        self.lock().focused = number;
    }

    /// (T2) Table `number`'s client area now, as the simulator has it.
    pub fn client_of(&self, number: u32) -> Option<Rect> {
        let feed = self.feed.0.lock().unwrap_or_else(PoisonError::into_inner);
        feed.tables.get(&number).map(|t| t.client)
    }

    /// (T2) Table `number`'s outer rect now: its client area with its frame
    /// at the scale of the monitor it is on.
    pub fn outer_of(&self, number: u32) -> Option<Rect> {
        let client = self.client_of(number)?;
        let control = self.lock();
        let scale = scale_at(&control.monitors, &client);
        Some(control.insets_of(number, scale).outer(&client))
    }

    /// (T2) The scale of the monitor table `number` is on.
    pub fn scale_of(&self, number: u32) -> Option<u32> {
        let client = self.client_of(number)?;
        Some(scale_at(&self.lock().monitors, &client))
    }

    /// (T1) The table of window `id` - tracked or not, as long as the
    /// simulator has it - put where the client accepts, restored.
    fn place(&self, id: WindowId, want: Rect) -> Result<Rect, PlatformError> {
        let number = u32::try_from(id.0).map_err(|_| PlatformError::Gone(id))?;
        let accept = {
            let control = self.lock();
            control
                .accept_for
                .get(&number)
                .copied()
                .unwrap_or(control.accept)
        };
        let accepted = accept(want);
        let mut feed = self.feed.0.lock().unwrap_or_else(PoisonError::into_inner);
        let table = feed
            .tables
            .get_mut(&number)
            .ok_or(PlatformError::Gone(id))?;
        table.client = accepted;
        table.minimized = false;
        drop(feed);
        self.lock()
            .placements
            .push(Placement { id, want, accepted });
        Ok(accepted)
    }

    fn mouse(&self) -> MouseState {
        let control = self.lock();
        MouseState {
            down: control.down,
            since_click: control.last_press.map(|at| at.elapsed()),
        }
    }
}

/// (T2) The sim backend's [`Placer`]: its [`SimControl`].
#[derive(Debug)]
struct SimPlacer(SimControl);

impl Placer for SimPlacer {
    fn place(&mut self, id: WindowId, want: Rect) -> Result<Rect, PlatformError> {
        self.0.place(id, want)
    }

    fn mouse(&mut self) -> MouseState {
        self.0.mouse()
    }
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
        let control = SimControl {
            control: Arc::new(Mutex::new(Control {
                monitors: default_monitors(),
                placements: Vec::new(),
                accept: |want| want,
                accept_for: BTreeMap::new(),
                insets: Insets::default(),
                insets_for: BTreeMap::new(),
                sites: BTreeMap::new(),
                down: false,
                last_press: None,
                frames: BTreeMap::new(),
                kept: BTreeMap::new(),
                pointer: Vec::new(),
                drag_seq: 0,
                focused: None,
            })),
            feed: feed.clone(),
        };
        (
            Self {
                feed: feed.clone(),
                site: site.into(),
                tracked: BTreeMap::new(),
                overlays: BTreeMap::new(),
                control,
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

    /// (T2) The test controls, which stay with the test after the backend
    /// is handed to the engine.
    pub fn control(&self) -> SimControl {
        self.control.clone()
    }

    /// (T1) The monitors `monitors` reports from now on.
    pub fn set_monitors(&mut self, monitors: Vec<Monitor>) {
        self.control.lock().monitors = monitors;
    }

    /// (T1) The client area a placement ends with, from the one asked for
    /// (a client that keeps its aspect ratio or a minimum size).
    pub fn set_accept(&mut self, accept: fn(Rect) -> Rect) {
        self.control.set_accept(accept);
    }

    /// (T1) Every placement so far, in order.
    pub fn placements(&self) -> Vec<Placement> {
        self.control.placements()
    }

    /// What the Windows backend would paint over a window now: its last
    /// frame laid out over its client area with the frame's design (R3.9).
    pub fn scene(&self, id: WindowId) -> Option<crate::scene::Scene> {
        let frame = self.overlays.get(&id)?;
        let table = self.tracked.get(&id)?;
        Some(crate::scene::compose(
            frame,
            table.client.width,
            table.client.height,
            1000,
            &frame.design,
        ))
    }

    fn matcher(&self) -> Option<TableMatcher> {
        let feed = self.feed.0.lock().unwrap_or_else(PoisonError::into_inner);
        feed.title_regex
            .as_ref()
            .map(|regex| TableMatcher::simulator(self.site.clone(), regex.clone()))
    }

    fn snapshot(&self) -> BTreeMap<u32, SimTable> {
        self.feed
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .tables
            .clone()
    }

    fn scale_of(&self, client: &Rect) -> u32 {
        scale_at(&self.control.lock().monitors, client)
    }

    /// (T4) The room table `id` poses as.
    fn site_of(&self, id: WindowId) -> Option<String> {
        let number = u32::try_from(id.0).ok()?;
        let posed = self.control.lock().sites.get(&number).cloned();
        Some(posed.unwrap_or_else(|| self.site.clone()))
    }

    /// (T4) The test's pointer gestures since the last poll, through the
    /// overlays' shared drag over each scene as painted: a press that never
    /// moved is a click, a drag dropped somewhere it may be is kept and
    /// reported (as the Windows overlay thread does).
    fn pointer_events(&mut self) -> Vec<TableEvent> {
        let mut control = self.control.lock();
        let gestures = std::mem::take(&mut control.pointer);
        let mut events = Vec::new();
        for (number, from, to) in gestures {
            let Some((frame, client)) = control.frames.get(&number).cloned() else {
                continue;
            };
            let (w, h) = (client.width, client.height);
            let mut positions = overrides(control.kept.get(&number));
            let scene = compose_with(&frame, w, h, 1000, &frame.design, &positions);
            let Some(mut drag) = Drag::press(&scene, from.0, from.1) else {
                continue;
            };
            if let Some(to) = to {
                drag.moved(to.0, to.1, drag::threshold(1000), w, h);
            }
            let id = WindowId(u64::from(number));
            if drag.is_click() {
                if let Some(rect) = scene.draggable(drag.slot) {
                    events.push(TableEvent::PanelClicked {
                        id,
                        slot: drag.slot,
                        panel: Rect {
                            x: client.x.saturating_add(rect.x),
                            y: client.y.saturating_add(rect.y),
                            ..rect
                        },
                        scale_permille: 1000,
                    });
                }
                continue;
            }
            if let Some(at) = drag.at {
                positions.insert(drag.slot, at);
            }
            let dropped = compose_with(&frame, w, h, 1000, &frame.design, &positions);
            let Some(at) = drag.release(&dropped) else {
                continue;
            };
            control.drag_seq += 1;
            let seq = control.drag_seq;
            control
                .kept
                .entry(number)
                .or_default()
                .push((seq, drag.slot, at));
            events.push(TableEvent::PanelMoved {
                id,
                size: dropped.size,
                slot: drag.slot,
                x: at.0,
                y: at.1,
                seq,
            });
        }
        events
    }
}

/// (T4) The positions an overlay shows over its frame's: its drops not
/// taken in yet.
fn overrides(kept: Option<&Kept>) -> Positions {
    kept.into_iter()
        .flatten()
        .map(|&(_, slot, at)| (slot, at))
        .collect()
}

impl Platform for SimBackend {
    fn name(&self) -> &'static str {
        "sim"
    }

    /// The simulator's tables whose titles its own regex reads, posing as
    /// the configured room (or, T2, the one a test posed the table as);
    /// `_matchers` (the real rooms') never match them.
    fn find_tables(
        &mut self,
        _matchers: &[TableMatcher],
    ) -> Result<Vec<TableWindow>, PlatformError> {
        let Some(matcher) = self.matcher() else {
            return Ok(Vec::new()); // no `started` event yet
        };
        let sites = self.control.lock().sites.clone();
        Ok(self
            .snapshot()
            .into_iter()
            .filter_map(|(number, table)| {
                let found = matcher.matches(SIM_PROCESS, &table.title)?;
                Some(TableWindow {
                    id: WindowId(u64::from(number)),
                    site: sites
                        .get(&number)
                        .cloned()
                        .unwrap_or_else(|| matcher.site.clone()),
                    process: ProcessInfo {
                        pid: None,
                        name: SIM_PROCESS.to_owned(),
                    },
                    title: table.title,
                    table: found.table,
                    size: found.seats.or(table.size),
                    scale_permille: self.scale_of(&table.client),
                    client: table.client,
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

    fn follow(&mut self, window: &TableWindow) {
        if let Some(table) = self.tracked.get_mut(&window.id) {
            table.client = window.client;
            table.minimized = window.minimized;
        }
        if let Ok(number) = u32::try_from(window.id.0)
            && let Some((_, client)) = self.control.lock().frames.get_mut(&number)
        {
            *client = window.client;
        }
    }

    fn poll_events(&mut self) -> Vec<TableEvent> {
        let now = self.snapshot();
        let regex = self.matcher();
        let monitors = self.control.lock().monitors.clone();
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
                    scale_permille: scale_at(&monitors, &current.client),
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
                        .and_then(|found| found.table),
                });
            }
            *seen = current.clone();
        }
        for event in &events {
            if let TableEvent::Closed { id } = event {
                self.tracked.remove(id);
            }
        }
        events.extend(self.pointer_events());
        events
    }

    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError> {
        let Some(table) = self.tracked.get(&id) else {
            return Err(PlatformError::Gone(id));
        };
        // (T4) As the native backends: every permit is the window's room's.
        if let Some(site) = self.site_of(id)
            && let Err(error) = frame.permitted_for(&site)
        {
            return Err(PlatformError::Os(format!("window {}: {error}", id.0)));
        }
        if let Ok(number) = u32::try_from(id.0) {
            let mut control = self.control.lock();
            let seen = frame.seating.drags_seen;
            if let Some(kept) = control.kept.get_mut(&number) {
                kept.retain(|(seq, _, _)| *seq > seen);
            }
            control.frames.insert(number, (frame.clone(), table.client));
        }
        self.overlays.insert(id, frame.clone());
        Ok(())
    }

    fn remove_overlay(&mut self, id: WindowId) {
        self.overlays.remove(&id);
        if let Ok(number) = u32::try_from(id.0) {
            let mut control = self.control.lock();
            control.frames.remove(&number);
            control.kept.remove(&number);
        }
    }

    fn monitors(&mut self) -> Vec<Monitor> {
        self.control.lock().monitors.clone()
    }

    /// (T1) The table of window `id` - tracked or not, as long as the
    /// simulator has it - put where the client accepts, restored.
    fn place(&mut self, id: WindowId, want: Rect) -> Result<Rect, PlatformError> {
        self.control.place(id, want)
    }

    /// (T2) The table's frame as the test set it, at its scale.
    fn frame_insets(&mut self, window: &TableWindow) -> Option<Insets> {
        let number = u32::try_from(window.id.0).ok()?;
        Some(self.control.lock().insets_of(number, window.scale_permille))
    }

    /// (T2) Placing through the shared controls, the mouse as the test
    /// presses it.
    fn placer(&mut self) -> Option<Box<dyn Placer>> {
        Some(Box::new(SimPlacer(self.control.clone())))
    }

    /// (T7) The table the test put in front ([`SimControl::focus`]).
    fn focused_window(&mut self) -> Option<WindowId> {
        self.control.lock().focused.map(|n| WindowId(u64::from(n)))
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
        let permit = crate::compliance::Compliance::shipped()
            .expect("shipped")
            .permit("pokerstars")
            .expect("permitted");
        let frame = OverlayFrame::status(permit, Some(6), "waiting for first hand");
        backend.overlay(WindowId(1), &frame).expect("overlay");
        assert_eq!(backend.overlays().len(), 1);
        let scene = backend.scene(WindowId(1)).expect("a scene");
        assert_eq!((scene.width, scene.height), (800, 600));
        assert_eq!(scene.panels.len(), 1, "the status pill");
        assert_eq!(
            backend.overlay(WindowId(2), &frame),
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

    /// (T1) The sim backend's monitors are the test's, and a placement is
    /// recorded, takes what the client accepts, restores a minimised table
    /// and reaches `poll_events` as a move.
    #[test]
    fn placements_are_recorded_and_applied() {
        let (mut backend, feed) = SimBackend::new("pokerstars");
        started(&feed);
        table(&feed, 1, "Hygiea - $0.05/$0.10");
        table(&feed, 2, "Florence - $0.05/$0.10");
        assert_eq!(backend.monitors(), default_monitors());
        let two = vec![
            default_monitors().remove(0),
            Monitor {
                id: MonitorId(2),
                primary: false,
                bounds: Rect {
                    x: 1920,
                    y: 0,
                    width: 2560,
                    height: 1440,
                },
                work_area: Rect {
                    x: 1920,
                    y: 0,
                    width: 2560,
                    height: 1400,
                },
                scale_permille: 1250,
            },
        ];
        backend.set_monitors(two.clone());
        assert_eq!(backend.monitors(), two);

        let found = backend.find_tables(&[]).expect("find");
        backend.track(&found[0]).expect("track");
        let want = Rect {
            x: 1920,
            y: 0,
            width: 1280,
            height: 700,
        };
        assert_eq!(backend.place(WindowId(1), want), Ok(want));
        // (T2) On the second monitor: its scale, as a per-monitor aware
        // client reports.
        assert_eq!(
            backend.poll_events(),
            [TableEvent::Moved {
                id: WindowId(1),
                client: want,
                scale_permille: 1250
            }]
        );
        // A client that keeps 4:3 by its width; a minimised table restored.
        backend.set_accept(|want| Rect {
            height: want.width * 3 / 4,
            ..want
        });
        feed.push_line(
            &serde_json::json!({"event": "window", "table": 2, "title": "Florence - $0.05/$0.10",
                "x": 0, "y": 0, "width": 640, "height": 480, "minimized": true})
            .to_string(),
        );
        let accepted = backend.place(WindowId(2), want).expect("placed");
        assert_eq!(accepted.height, 960);
        let table = backend
            .find_tables(&[])
            .expect("find")
            .into_iter()
            .find(|t| t.id == WindowId(2))
            .expect("table 2");
        assert_eq!((table.client, table.minimized), (accepted, false));
        assert_eq!(
            backend.place(WindowId(9), want),
            Err(PlatformError::Gone(WindowId(9)))
        );
        assert_eq!(
            backend.placements(),
            [
                Placement {
                    id: WindowId(1),
                    want,
                    accepted: want
                },
                Placement {
                    id: WindowId(2),
                    want,
                    accepted
                }
            ]
        );
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
