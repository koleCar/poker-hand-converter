//! The HUD's one loop: what it is attached to, what it shows, and what it
//! tells the app.
//!
//! - Every [`Settings::find_every`] it asks the platform for table windows;
//!   a new one is attached (followed, an overlay "waiting for first hand")
//!   when compliance mode allows its room, else refused - once per window,
//!   the app told why ([`HudMessage::AttachRefused`]). Windows that are gone
//!   are dropped. Whenever the number attached changes, the app hears it
//!   ([`HudMessage::TablesOpen`]).
//!   A window already attached is compared with what the find saw: its
//!   title (a tournament table move), client area, scale and minimise.
//!   Since R3.5 the Windows backend's hooks say all of that as it happens
//!   ([`Platform::poll_events`], drained every [`Settings::tick`], one
//!   event per window and kind however many the hooks saw - the overlay
//!   itself has followed every one on the backend's own thread); the
//!   periodic find stays as the safety net for anything a hook missed, and
//!   a window a followed process shows ([`TableEvent::Appeared`]) makes the
//!   HUD look at once.
//! - **Table identity** (R3.3): a window is (room, table name, seats). A
//!   `hand_imported` goes to the attached window of that room (by the
//!   store's site) whose title's table name equals the hand's
//!   ([`crate::platform::table_key`]: white space aside, exactly - `Table 1`
//!   is not `Table 11`). Two attached windows with the same name cannot be
//!   told apart: neither gets the hand, both say so. A window whose title
//!   gives no seats takes them from the hand (`hands.max_seats`). A hand
//!   that no window takes makes the HUD look at the windows at once (its
//!   table may have just been retitled). The hand's players are re-read,
//!   the window redrawn, and the latency reported
//!   ([`HudMessage::TableUpdated`]). A hand of a table the HUD is not
//!   attached to - a refused room's above all - is not read; its players
//!   are remembered (the last hand of up to 256 tables), so a window found
//!   a moment later starts from them.
//! - Until its first hand a window shows [`WAITING`]; the health report
//!   counts the attached tables still waiting.
//! - **Drawing** (R3.4): each re-read becomes one panel per seated player -
//!   the design's statistics over their rollups (`crate::panel`), the hand
//!   count, the seat - and every frame carries compliance's
//!   [`crate::compliance::Permit`], asked for again before each draw: a
//!   window whose room is (no longer) allowed gets no frame and loses its
//!   overlay. A window that moves, resizes, changes scale or is minimised is
//!   handed to the backend ([`Platform::follow`]) to keep its overlay on it.
//! - **The data path** (R3.7): a table's numbers are its players' rollups
//!   over **the table's segment** - the segment its hand is summed in
//!   (`Reader::hud_hand`: site, format, variant, limit, table-size class and
//!   stake as the hand has them, so the table's own hands always count) -
//!   and, on a room whose rules allow statistics from the user's own hands
//!   only (`ownHandsOnly`: PokerStars, Winamax, ACR), without the hands the
//!   user did not play (`Reader::hud_own_totals`). An opaque-id room's
//!   villain is keyed by the session scope the store wrote with the hand
//!   (`PlayerRef.scope`), never across sessions. A design with the user's
//!   own statistics (R2.10) reads their counts too; those lag the hand by
//!   one step of the app's background pass. **Nothing from the hand in
//!   play**: the store only ever holds complete hands - the watcher imports
//!   a hand once the room has finished writing it (R1.3's completeness
//!   rule) - and this process reads nothing but the store.
//! - **Attaching to a table that already has hands** (R3.7): a window with
//!   no hand announced since this process started (a restarted HUD, a table
//!   opened before it) is filled from its table's newest stored hand, when
//!   that hand was played and imported in the last [`RESTART_WINDOW`] - an
//!   older one could seat players who have left.
//! - **Latency** (R3.7): every hand's chain - the watcher noticing its file,
//!   the import, the app sending `hand_imported`, its arrival here, the
//!   rollups re-read, the frame handed to the backend - goes back to the app
//!   in `table_updated`, into `--latency-report` (JSON lines) when asked,
//!   and, in a debug build only, onto the table as a small line.
//! - `stats_changed` and `resync` re-read every attached table; so does the
//!   store's own `data_version` moving without a message (checked every
//!   [`Settings::store_every`]): the HUD keeps drawing from the store when
//!   the app is busy.
//! - `policy` merges the app's remote `sites.json`; tables whose room is no
//!   longer allowed are detached at once.
//! - **Seats and layouts** (R3.6): each window's hero seat comes with its
//!   hands (`crate::seats::hero_after`; forgotten on a table move); a frame
//!   carries the room's layout for the table size, the hero's seat when the
//!   room's client rotates the table (the user's word, else `sites.json`),
//!   and the panels the user placed ([`crate::seats::Rooms`], read from the
//!   store at start and on `layout_changed` / `settings_changed`). A panel
//!   the user drags ([`TableEvent::PanelMoved`], from the backend's overlay
//!   thread) is remembered at once, every table of that room and size is
//!   redrawn with it, and the app is told
//!   ([`HudMessage::SeatPositionChanged`]) - it writes the store, which
//!   this process only reads.
//! - **Panel and popup** (R3.8): a click on a seat's panel
//!   ([`TableEvent::PanelClicked`]: pressed and released without a drag)
//!   asks the app for the popup of the player at that slot
//!   ([`HudMessage::OpenPopup`]: the room, the player as the table's last
//!   hand had them, the table's segment, the panel on the screen) - the app
//!   opens it in a webview of its own and reads what it shows; this process
//!   never writes. Where the room allows labelling players (the design's
//!   `player_labels` under the permit: Winamax today, never PokerStars or
//!   ACR) each named opponent's colour tag, labels and note mark are read
//!   with their rollups (`Reader::player_notes`, a key lookup) - never for
//!   an opaque-id seat (its name is a session's token) nor for the hero.
//!   Every frame carries the panel statistics' colour bands for the legend.
//! - `shutdown`, the connection closing or standard input ending (the app is
//!   gone) end the loop; the overlays are removed.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rail_hud_ipc::protocol::{
    AppMessage, HandTiming, HealthReport, HudMessage, LatencyChain, PlayerHands, PlayerRef,
    RefusalReason, ScreenRect,
};
use rail_stats::custom::{CustomDef, CustomSet};
use rail_stats::display::Display;

use crate::compliance::Compliance;
use crate::data::StoreView;
use crate::latency::{Latencies, micros};
use crate::layout::TableLayout;
use crate::panel::{PanelDesign, PanelStats};
use crate::platform::{
    OverlayFrame, PanelWords, Platform, Rect, SeatPanel, Seating, TableEvent, TableMatcher,
    TableWindow, TagColour, WindowId, table_key,
};
use crate::seats::{self, Rooms};

/// What the loop is fed.
#[derive(Debug)]
pub enum Input {
    /// A message from the app, with the moment it was read.
    App(AppMessage, Instant),
    /// The connection to the app closed (`Some`: why).
    AppClosed(Option<String>),
    /// Standard input ended: the app is gone.
    AppGone,
}

/// Why the loop ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    Shutdown,
    AppClosed(Option<String>),
    AppGone,
}

/// The loop's rhythm.
#[derive(Debug, Clone, Copy)]
pub struct Settings {
    /// How long the loop waits for a message before looking at the windows.
    pub tick: Duration,
    pub find_every: Duration,
    pub store_every: Duration,
    /// (R3.7) How recent a table's newest stored hand must be for a window
    /// attached after it to start from its players ([`RESTART_WINDOW`]).
    pub restart_window: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            tick: Duration::from_millis(50),
            find_every: Duration::from_millis(500),
            store_every: Duration::from_secs(2),
            restart_window: RESTART_WINDOW,
        }
    }
}

/// Tables whose last announced hand is remembered.
const RECENT_TABLES: usize = 256;

/// Shown before a table's first hand (§3.3).
pub const WAITING: &str = "waiting for first hand";

/// (R3.7) How recent a table's newest stored hand must be - played and
/// imported - for a window attached after it to start from its players.
pub const RESTART_WINDOW: Duration = Duration::from_secs(15 * 60);

/// (R3.7) At most this many of the newest imported hands are looked at for
/// a table's newest hand (a backfill that just imported old hands is not
/// read through).
pub const RESTART_SCAN: u32 = 5_000;

/// Now, in Unix microseconds.
pub fn unix_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

/// A past instant of this process in Unix microseconds.
fn unix_us_at(at: Instant) -> i64 {
    unix_us() - i64::try_from(at.elapsed().as_micros()).unwrap_or(0)
}

/// (R3.7) The debug build's line: the chain up to the re-read, as the
/// table shows it.
pub fn debug_line(chain: &LatencyChain) -> String {
    let ms = |from: Option<i64>, to: Option<i64>| match (from, to) {
        (Some(from), Some(to)) => format!("{}", (to - from) / 1000),
        _ => "-".to_owned(),
    };
    let us =
        |from: Option<i64>, to: i64| from.map_or_else(|| "-".to_owned(), |f| format!("{}", to - f));
    format!(
        "debug: file to HUD {} ms (import {} ms, app {} ms, ipc {} us, read {} us)",
        ms(chain.noticed_us, Some(chain.read_us)),
        ms(chain.noticed_us, chain.imported_us),
        ms(chain.imported_us, chain.sent_us),
        us(chain.sent_us, chain.arrived_us),
        chain.read_us - chain.arrived_us,
    )
}

#[derive(Debug)]
struct Attached {
    window: TableWindow,
    /// The store's site of the window's room.
    store_site: String,
    /// The players of the table's last hand.
    players: Vec<PlayerRef>,
    /// The seats the title gives (its `seats` group); `None`: the window's
    /// `size` comes from its hands.
    title_seats: Option<u32>,
    /// The hero's seat at this table (R3.6), from its hands.
    hero_seat: Option<u32>,
    /// The last panel drag of this window the engine took in (R3.6).
    drags_seen: u64,
    /// (R3.7) The table's segment: its last hand's (`None` before one, or
    /// when the store has no statistics rows for it - then every segment of
    /// the site).
    segment: Option<i64>,
    /// (R3.7) Debug builds: the last hand's latency line.
    debug: Option<String>,
    /// What it shows: a status line or panels (redrawn when the layout or
    /// the user's positions change).
    shown: (Option<String>, Vec<SeatPanel>),
}

/// The HUD.
pub struct Hud {
    platform: Box<dyn Platform>,
    compliance: Compliance,
    store: StoreView,
    settings: Settings,
    attached: BTreeMap<WindowId, Attached>,
    /// Windows refused, with their room (each reported once).
    refused: BTreeMap<WindowId, String>,
    reported_open: u32,
    latencies: Latencies,
    started: Instant,
    next_find: Instant,
    next_store: Instant,
    /// Look for tables at the next tick, whatever `next_find` says.
    find_soon: bool,
    last_find_error: Option<String>,
    /// The last hand announced per (store site, table), for windows that
    /// attach after it (bounded by [`RECENT_TABLES`]).
    recent: BTreeMap<(String, String), (String, Vec<PlayerRef>)>,
    /// Test-only room entries: the simulator's windows posing as a room
    /// ([`Hud::add_simulator_room`]), after `sites.json`'s matchers.
    test_matchers: Vec<TableMatcher>,
    /// The panel's design (the default, R3.4; R3.9's editor will set it).
    design: PanelDesign,
    /// The panel's statistics, compiled for [`Hud::design`].
    panel_stats: PanelStats,
    /// (R3.7) The user's statistics with a counter that the design shows:
    /// (statistic id, its row id in the store).
    custom_ids: Vec<(String, i64)>,
    /// The design's statistics are compiled against the store's user
    /// statistics (or need none).
    custom_read: bool,
    /// (R3.7) `--latency-report`: one JSON line per hand's chain.
    latency_report: Option<Box<dyn std::io::Write>>,
    /// Where each room draws its tables and where the user put panels
    /// (R3.6).
    rooms: Rooms,
    /// The user's layouts were read from the store (once it opens, and
    /// again on `layout_changed` / `settings_changed`).
    user_layouts_read: bool,
}

impl std::fmt::Debug for Hud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hud")
            .field("platform", &self.platform.name())
            .field("attached", &self.attached.len())
            .field("refused", &self.refused.len())
            .finish_non_exhaustive()
    }
}

impl Hud {
    pub fn new(
        platform: Box<dyn Platform>,
        compliance: Compliance,
        store: StoreView,
        settings: Settings,
    ) -> Self {
        let now = Instant::now();
        let mut rooms = Rooms::default();
        rooms.set_config(compliance.config());
        Self {
            platform,
            compliance,
            store,
            settings,
            attached: BTreeMap::new(),
            refused: BTreeMap::new(),
            reported_open: 0,
            latencies: Latencies::default(),
            started: now,
            next_find: now,
            next_store: now,
            find_soon: false,
            last_find_error: None,
            recent: BTreeMap::new(),
            test_matchers: Vec::new(),
            design: PanelDesign::default(),
            panel_stats: PanelStats::new(&PanelDesign::default()),
            custom_ids: Vec::new(),
            custom_read: false,
            latency_report: None,
            rooms,
            user_layouts_read: false,
        }
    }

    /// (R3.7) Write every hand's latency chain to `out`, one JSON object a
    /// line (`--latency-report`, for tests and measurements).
    pub fn set_latency_report(&mut self, out: Box<dyn std::io::Write>) {
        self.latency_report = Some(out);
    }

    /// (R3.7; R3.9's editor) Show `design`: its statistics are compiled
    /// again - a user's own statistic (R2.10) from the store's definitions -
    /// and every table read again.
    pub fn set_design(&mut self, design: PanelDesign, out: &mut dyn FnMut(HudMessage)) {
        self.design = design;
        self.custom_read = false;
        self.read_custom_stats();
        self.reread_all(Instant::now(), out);
    }

    /// Compile the design's statistics; read the user's own from the store
    /// when it shows any (at most once per change: `custom_read`).
    fn read_custom_stats(&mut self) {
        let all_shipped = Display::shipped().is_ok_and(|display| {
            self.design
                .stats
                .iter()
                .all(|slot| display.get(&slot.id).is_some())
        });
        if all_shipped {
            self.panel_stats = PanelStats::new(&self.design);
            self.custom_ids.clear();
            self.custom_read = true;
            return;
        }
        let Some(rows) = self.store.custom_stats() else {
            // No store yet: the shipped ones now, the rest once it opens.
            self.panel_stats = PanelStats::new(&self.design);
            return;
        };
        let defs: Vec<CustomDef> = rows.iter().map(|row| row.def.clone()).collect();
        let (set, refused) = CustomSet::compile(&defs);
        for (id, problems) in refused {
            eprintln!("rail-hud: the user's statistic {id} does not compile: {problems:?}");
        }
        self.custom_ids = rows
            .iter()
            .filter(|row| row.def.predicate.is_some())
            .map(|row| (row.def.def.id.clone(), row.id))
            .collect();
        self.panel_stats = PanelStats::with_custom(&self.design, &set);
        self.custom_read = true;
    }

    /// A test-only room entry (R3.3; R3.1 / R3.2 notes): the table
    /// simulator's real windows - its process only, titled as `title`
    /// (`rail-hud-sim --title-regex`) reads - found by the system's backend
    /// as tables of `site`. Compliance mode decides on `site` as for a real
    /// window. The simulator's process is the only one it takes, so it can
    /// never attach to a real client; nothing of it is in `sites.json`.
    pub fn add_simulator_room(&mut self, site: &str, title: regex::Regex) {
        self.test_matchers
            .push(TableMatcher::simulator(site.to_owned(), title));
    }

    /// Run until told to stop; `out` sends to the app (never blocks).
    pub fn run(&mut self, inputs: &Receiver<Input>, out: &mut dyn FnMut(HudMessage)) -> Exit {
        let exit = loop {
            match inputs.recv_timeout(self.settings.tick) {
                Ok(input) => {
                    if let Some(exit) = self.handle(input, out) {
                        break exit;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break Exit::AppGone,
            }
            self.tick(Instant::now(), out);
        };
        self.shutdown();
        exit
    }

    /// Remove every overlay and stop following every window.
    pub fn shutdown(&mut self) {
        let ids: Vec<WindowId> = self.attached.keys().copied().collect();
        for id in ids {
            self.detach(id);
        }
    }

    /// The state for a health answer.
    pub fn health(&self) -> HealthReport {
        HealthReport {
            uptime_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            attached: u32::try_from(self.attached.len()).unwrap_or(u32::MAX),
            refused: u32::try_from(self.refused.len()).unwrap_or(u32::MAX),
            store_open: self.store.is_open(),
            platform: self.platform.name().to_owned(),
            reread: self.latencies.summary(),
            waiting: u32::try_from(
                self.attached
                    .values()
                    .filter(|a| a.players.is_empty())
                    .count(),
            )
            .unwrap_or(u32::MAX),
        }
    }

    /// An attached window as the HUD knows it (tests).
    pub fn window(&self, id: WindowId) -> Option<&TableWindow> {
        self.attached.get(&id).map(|a| &a.window)
    }

    /// The players a window shows (tests).
    pub fn players_of(&self, id: WindowId) -> Vec<String> {
        self.attached
            .get(&id)
            .map(|a| a.players.iter().map(|p| p.name.clone()).collect())
            .unwrap_or_default()
    }

    /// The tables attached, by window.
    pub fn attached(&self) -> Vec<(WindowId, Option<String>)> {
        self.attached
            .iter()
            .map(|(id, a)| (*id, a.window.table.clone()))
            .collect()
    }

    /// One input; `Some` ends the loop.
    pub fn handle(&mut self, input: Input, out: &mut dyn FnMut(HudMessage)) -> Option<Exit> {
        let (message, at) = match input {
            Input::App(message, at) => (message, at),
            Input::AppClosed(reason) => return Some(Exit::AppClosed(reason)),
            Input::AppGone => return Some(Exit::AppGone),
        };
        match message {
            AppMessage::HandImported {
                site,
                table,
                hand_key,
                players,
                timing,
            } => {
                let table = table.as_deref().map(table_key).filter(|t| !t.is_empty());
                let targets = table
                    .as_deref()
                    .map(|t| self.windows_of(&site, t))
                    .unwrap_or_default();
                match targets.as_slice() {
                    [] => {
                        // Its window may have just been retitled (a
                        // tournament move) or opened: look now.
                        if table.is_some() && !self.attached.is_empty() {
                            self.next_find = Instant::now();
                        }
                    }
                    [id] => {
                        let id = *id;
                        if let Some(attached) = self.attached.get_mut(&id) {
                            attached.players.clone_from(&players);
                            attached.hero_seat = seats::hero_after(&players, attached.hero_seat);
                        }
                        self.read_hand(id, &hand_key);
                        self.reread(id, Some(&hand_key), at, timing, out);
                    }
                    several => {
                        let ids = several.to_vec();
                        self.ambiguous(&ids, table.as_deref().unwrap_or_default());
                    }
                }
                // What this message made us read is seen.
                self.store.changed();
                if let Some(table) = table {
                    self.recent.insert((site, table), (hand_key, players));
                    if self.recent.len() > RECENT_TABLES {
                        self.recent.pop_first();
                    }
                }
            }
            AppMessage::StatsChanged { .. } | AppMessage::Resync => {
                // A recompute's swap may have recounted the user's own
                // statistics too: their definitions again, then every table.
                self.custom_read = false;
                self.read_custom_stats();
                self.reread_all(at, out);
                self.store.changed();
            }
            AppMessage::Policy { remote } => {
                match self.compliance.apply_remote(remote.as_deref()) {
                    Ok(notes) => eprintln!(
                        "rail-hud: policy {} ({} notes)",
                        if remote.is_some() {
                            "shipped + remote"
                        } else {
                            "shipped"
                        },
                        notes.len()
                    ),
                    Err(error) => eprintln!("rail-hud: the remote policy was refused: {error}"),
                }
                // Table data (layouts, preferred seat) may have changed too.
                self.rooms.set_config(self.compliance.config());
                // Decide again: detach what is no longer allowed now, and
                // look at refused windows afresh at the next find.
                let ids: Vec<(WindowId, String)> = self
                    .attached
                    .iter()
                    .map(|(id, a)| (*id, a.window.site.clone()))
                    .collect();
                self.refused.clear();
                for (id, site) in ids {
                    if let Err(reason) = self.compliance.decide(&site) {
                        self.detach(id);
                        self.refuse(id, &site, reason, out);
                    }
                }
                self.report_open(out);
                self.next_find = Instant::now();
                self.repaint_all();
            }
            AppMessage::Health { seq } => out(HudMessage::Health {
                seq,
                report: self.health(),
            }),
            AppMessage::LayoutChanged | AppMessage::SettingsChanged => {
                // The user's positions and preferred seat (R3.6); R3.9's
                // presets will be read here too, and the user's own
                // statistics (R3.7) may have changed.
                self.read_user_layouts();
                if !self.custom_ids.is_empty() || !self.custom_read {
                    self.custom_read = false;
                    self.read_custom_stats();
                    self.reread_all(at, out);
                }
                self.repaint_all();
            }
            AppMessage::Shutdown => return Some(Exit::Shutdown),
            AppMessage::Unknown => {}
        }
        None
    }

    /// Windows and the store, on the loop's rhythm.
    pub fn tick(&mut self, now: Instant, out: &mut dyn FnMut(HudMessage)) {
        let events = self.platform.poll_events();
        if !events.is_empty() {
            self.apply(events, out);
        }
        if now >= self.next_find || std::mem::take(&mut self.find_soon) {
            self.next_find = now + self.settings.find_every;
            self.find(out);
        }
        if now >= self.next_store {
            self.next_store = now + self.settings.store_every;
            self.store.ensure_open();
            if !self.user_layouts_read && self.store.is_open() {
                self.read_user_layouts();
                self.repaint_all();
            }
            if !self.custom_read && self.store.is_open() {
                self.read_custom_stats();
            }
            if self.store.changed() {
                self.reread_all(now, out);
            }
        }
    }

    fn find(&mut self, out: &mut dyn FnMut(HudMessage)) {
        let mut matchers = self.compliance.matchers();
        matchers.extend(self.test_matchers.iter().cloned());
        let found = match self.platform.find_tables(&matchers) {
            Ok(found) => {
                self.last_find_error = None;
                found
            }
            Err(error) => {
                let error = error.to_string();
                if self.last_find_error.as_ref() != Some(&error) {
                    eprintln!("rail-hud: finding tables: {error}");
                    self.last_find_error = Some(error);
                }
                return;
            }
        };
        let seen: Vec<WindowId> = found.iter().map(|w| w.id).collect();
        let mut changed = Vec::new();
        for window in found {
            if let Some(attached) = self.attached.get_mut(&window.id) {
                // What the hooks (R3.5) report as it happens, seen here by
                // looking again: the safety net for a missed event.
                if window.size.is_some() {
                    attached.title_seats = window.size;
                    attached.window.size = window.size;
                }
                if attached.window.client != window.client
                    || attached.window.scale_permille != window.scale_permille
                {
                    changed.push(TableEvent::Moved {
                        id: window.id,
                        client: window.client,
                        scale_permille: window.scale_permille,
                    });
                }
                if attached.window.minimized != window.minimized {
                    changed.push(TableEvent::Minimized {
                        id: window.id,
                        minimized: window.minimized,
                    });
                }
                if attached.window.title != window.title {
                    changed.push(TableEvent::Retitled {
                        id: window.id,
                        title: window.title,
                        table: window.table,
                    });
                }
                continue;
            }
            if self.refused.contains_key(&window.id) {
                continue;
            }
            match self.compliance.decide(&window.site) {
                Ok(()) => self.attach(window, out),
                Err(reason) => {
                    let (id, site) = (window.id, window.site);
                    self.refuse(id, &site, reason, out);
                }
            }
        }
        let gone: Vec<WindowId> = self
            .attached
            .keys()
            .filter(|id| !seen.contains(id))
            .copied()
            .collect();
        for id in gone {
            self.detach(id);
        }
        self.refused.retain(|id, _| seen.contains(id));
        if changed.is_empty() {
            self.report_open(out);
        } else {
            self.apply(changed, out);
        }
    }

    /// The attached windows of `site` (the store's) whose table name is
    /// `table` (a [`table_key`]).
    fn windows_of(&self, site: &str, table: &str) -> Vec<WindowId> {
        self.attached
            .iter()
            .filter(|(_, a)| a.store_site == site && a.window.table.as_deref() == Some(table))
            .map(|(id, _)| *id)
            .collect()
    }

    /// Several windows carry one table name: none of them can be given a
    /// hand of that name (whose would it be?). They say so and wait.
    fn ambiguous(&mut self, ids: &[WindowId], table: &str) {
        for id in ids {
            if let Some(attached) = self.attached.get_mut(id) {
                attached.players.clear();
            }
            self.draw(
                *id,
                Some(format!(
                    "{} tables named {table:?}: cannot tell them apart",
                    ids.len()
                )),
                Vec::new(),
            );
        }
    }

    /// What the table takes from its stored hand (R3.7): the segment its
    /// players are read over, and - for a window whose title gives no
    /// seats - the table size (`hands.max_seats`; R3.6 lays the table out
    /// at it). A hand the store does not have (yet) changes nothing.
    fn read_hand(&mut self, id: WindowId, hand_key: &str) {
        let Some(hand) = self.store.hud_hand(hand_key) else {
            return;
        };
        if let Some(attached) = self.attached.get_mut(&id) {
            attached.segment = Some(hand.segment.id);
            if attached.title_seats.is_none()
                && let Some(seats) = hand.max_seats
            {
                attached.window.size = Some(seats);
            }
        }
    }

    fn attach(&mut self, window: TableWindow, out: &mut dyn FnMut(HudMessage)) {
        if let Err(error) = self.platform.track(&window) {
            eprintln!("rail-hud: window {}: {error}", window.id.0);
            return;
        }
        eprintln!(
            "rail-hud: attached to window {} ({}, table {:?})",
            window.id.0, window.site, window.table
        );
        let id = window.id;
        let store_site = self.compliance.store_site(&window.site);
        self.attached.insert(
            id,
            Attached {
                title_seats: window.size,
                window,
                store_site,
                players: Vec::new(),
                hero_seat: None,
                drags_seen: 0,
                segment: None,
                debug: None,
                shown: (None, Vec::new()),
            },
        );
        self.draw(id, Some(WAITING.to_owned()), Vec::new());
        self.adopt_recent(id, out);
    }

    /// A window attached (or moved to another table) after its table's last
    /// hand was announced starts from that hand's players.
    fn adopt_recent(&mut self, id: WindowId, out: &mut dyn FnMut(HudMessage)) {
        let Some(attached) = self.attached.get(&id) else {
            return;
        };
        let Some(table) = attached.window.table.clone() else {
            return;
        };
        let site = attached.store_site.clone();
        let same_name = self.windows_of(&site, &table);
        if same_name.len() > 1 {
            self.ambiguous(&same_name, &table);
            return;
        }
        let recent = self.recent.get(&(site.clone(), table.clone())).cloned();
        let from_store = recent.is_none();
        let Some((hand_key, players)) = recent.or_else(|| self.stored_hand(&site, &table)) else {
            return;
        };
        if let Some(attached) = self.attached.get_mut(&id) {
            attached.hero_seat = seats::hero_after(&players, attached.hero_seat);
            attached.players = players;
        }
        self.read_hand(id, &hand_key);
        self.reread(id, Some(&hand_key), Instant::now(), None, out);
        if from_store {
            // What this read is seen (the store's first look would read
            // every table again for nothing).
            self.store.changed();
        }
    }

    /// (R3.7) A table's newest stored hand, when it was played and imported
    /// in the last [`Settings::restart_window`]: what a window attached without a
    /// hand announced to this process (a restarted HUD, a table opened
    /// before it) starts from.
    fn stored_hand(&mut self, site: &str, table: &str) -> Option<(String, Vec<PlayerRef>)> {
        let window_ms = i64::try_from(self.settings.restart_window.as_millis()).unwrap_or(i64::MAX);
        let since = unix_us() / 1000 - window_ms;
        let hand = self.store.latest_hand_of_table(
            site,
            &|name| table_key(name) == table,
            since,
            RESTART_SCAN,
        )?;
        eprintln!(
            "rail-hud: table {table:?} starts from its stored hand {}",
            hand.hand_key
        );
        let players = hand
            .players
            .into_iter()
            .map(|seat| PlayerRef {
                name: seat.player,
                scope: seat.scope,
                seat: Some(seat.seat),
                hero: seat.hero,
            })
            .collect();
        Some((hand.hand_key, players))
    }

    fn refuse(
        &mut self,
        id: WindowId,
        site: &str,
        reason: RefusalReason,
        out: &mut dyn FnMut(HudMessage),
    ) {
        if self.refused.insert(id, site.to_owned()).is_none() {
            eprintln!(
                "rail-hud: not attaching to window {} ({site}): {reason:?}",
                id.0
            );
            out(HudMessage::AttachRefused {
                site: site.to_owned(),
                window: id.0,
                reason,
            });
        }
    }

    fn detach(&mut self, id: WindowId) {
        if self.attached.remove(&id).is_some() {
            self.platform.remove_overlay(id);
            self.platform.untrack(id);
        }
    }

    fn apply(&mut self, events: Vec<TableEvent>, out: &mut dyn FnMut(HudMessage)) {
        for event in events {
            match event {
                TableEvent::Moved {
                    id,
                    client,
                    scale_permille,
                } => {
                    if let Some(a) = self.attached.get_mut(&id) {
                        a.window.client = client;
                        a.window.scale_permille = scale_permille;
                        self.platform.follow(&a.window);
                    }
                }
                TableEvent::Minimized { id, minimized } => {
                    if let Some(a) = self.attached.get_mut(&id) {
                        a.window.minimized = minimized;
                        self.platform.follow(&a.window);
                    }
                }
                TableEvent::Retitled { id, title, table } => {
                    let moved = self.attached.get_mut(&id).is_some_and(|a| {
                        a.window.title = title;
                        let moved = a.window.table != table;
                        if moved {
                            // A tournament table move: other players, and
                            // the hero at another seat.
                            a.window.table = table;
                            a.players.clear();
                            a.hero_seat = None;
                            a.segment = None;
                            a.debug = None;
                        }
                        moved
                    });
                    if moved {
                        eprintln!(
                            "rail-hud: window {} moved to table {:?}",
                            id.0,
                            self.attached.get(&id).and_then(|a| a.window.table.clone())
                        );
                        self.draw(id, Some(WAITING.to_owned()), Vec::new());
                        self.adopt_recent(id, out);
                    }
                }
                TableEvent::Closed { id } => {
                    self.detach(id);
                    self.refused.remove(&id);
                }
                TableEvent::Appeared => self.find_soon = true,
                TableEvent::PanelMoved {
                    id,
                    size,
                    slot,
                    x,
                    y,
                    seq,
                } => self.panel_moved(id, size, slot, (x, y), seq, out),
                TableEvent::PanelClicked {
                    id,
                    slot,
                    panel,
                    scale_permille,
                } => self.panel_clicked(id, slot, panel, scale_permille, out),
            }
        }
        self.report_open(out);
    }

    /// (R3.8) The user clicked the panel at `slot`: the app is asked for the
    /// popup of the player sitting there (by the table's last hand, the
    /// room's layout and the hero's rotation - as the panel was placed). A
    /// room no longer allowed, or a slot nobody sits in (a hand changed the
    /// table between the paint and the click), opens nothing.
    fn panel_clicked(
        &mut self,
        id: WindowId,
        slot: u32,
        panel: Rect,
        scale_permille: u32,
        out: &mut dyn FnMut(HudMessage),
    ) {
        let Some(attached) = self.attached.get(&id) else {
            return;
        };
        let site = attached.window.site.as_str();
        if self.compliance.permit(site).is_err() {
            return;
        }
        let size = Self::size_of(attached);
        let layout = self
            .rooms
            .layout(site, size)
            .unwrap_or_else(|| TableLayout::simulator(size));
        let rotate_to = if self.rooms.rotates(site) {
            attached.hero_seat
        } else {
            None
        };
        let Some(player) = attached.players.iter().find(|player| {
            player
                .seat
                .and_then(|seat| seats::slot_of(&layout, seat, rotate_to))
                == Some(slot)
        }) else {
            eprintln!(
                "rail-hud: window {}: a click on slot {slot}, where nobody sits now",
                id.0
            );
            return;
        };
        eprintln!(
            "rail-hud: window {}: the panel at slot {slot} clicked: its popup",
            id.0
        );
        out(HudMessage::OpenPopup {
            window: id.0,
            site: site.to_owned(),
            store_site: attached.store_site.clone(),
            table: attached.window.table.clone(),
            player: player.clone(),
            segment: attached.segment,
            slot,
            anchor: ScreenRect {
                x: panel.x,
                y: panel.y,
                width: panel.width,
                height: panel.height,
            },
            scale_permille,
        });
    }

    /// (R3.8) The user's words on each of `players` that their panels may
    /// show: only where the room allows labelling players and the design
    /// shows them, and only for a named opponent (an opaque-id seat's name
    /// is a session's token; the hero takes none).
    fn words_of(
        &mut self,
        window_site: &str,
        site: &str,
        players: &[PlayerRef],
    ) -> Vec<PanelWords> {
        let allowed = self.design.player_labels
            && self
                .compliance
                .permit(window_site)
                .is_ok_and(|permit| !permit.restrictions().no_player_labels);
        players
            .iter()
            .map(|player| {
                if !allowed || player.hero || !player.scope.is_empty() {
                    return PanelWords::default();
                }
                self.store
                    .player_notes(site, &player.name)
                    .map(|notes| PanelWords {
                        colour: notes.colour.as_deref().and_then(TagColour::from_name),
                        label: (!notes.labels.is_empty()).then(|| notes.labels.join(", ")),
                        noted: !notes.note.trim().is_empty(),
                    })
                    .unwrap_or_default()
            })
            .collect()
    }

    /// The user dropped a seat's panel somewhere (R3.6): remembered for the
    /// room and table size at once, every table of that room and size
    /// redrawn with it, and the app told - it writes the store.
    fn panel_moved(
        &mut self,
        id: WindowId,
        size: u32,
        slot: u32,
        at: (u32, u32),
        seq: u64,
        out: &mut dyn FnMut(HudMessage),
    ) {
        let Some(attached) = self.attached.get_mut(&id) else {
            return;
        };
        attached.drags_seen = attached.drags_seen.max(seq);
        let site = attached.window.site.clone();
        if !(2..=10).contains(&size) || slot >= size || at.0 > 1000 || at.1 > 1000 {
            return;
        }
        eprintln!(
            "rail-hud: window {}: the panel at slot {slot} of a {size}-seat {site} table moved to ({}, {})",
            id.0, at.0, at.1
        );
        self.rooms.set_position(&site, size, slot, at);
        out(HudMessage::SeatPositionChanged {
            site: site.clone(),
            size,
            slot,
            x: at.0,
            y: at.1,
        });
        let same: Vec<WindowId> = self
            .attached
            .iter()
            .filter(|(other, a)| {
                **other == id || (a.window.site == site && Self::size_of(a) == size)
            })
            .map(|(other, _)| *other)
            .collect();
        for other in same {
            self.repaint(other);
        }
    }

    /// Read the user's layouts from the store (R3.6); a store that cannot
    /// say keeps what is known.
    fn read_user_layouts(&mut self) {
        match self.store.user_layouts() {
            None => {}
            Some(Ok((positions, settings))) => {
                eprintln!(
                    "rail-hud: {} panel positions and {} room settings from the store",
                    positions.len(),
                    settings.len()
                );
                self.rooms.set_user(positions, settings);
                self.user_layouts_read = true;
            }
            Some(Err(error)) => {
                eprintln!("rail-hud: the HUD layouts did not read: {error}");
                self.user_layouts_read = true;
            }
        }
    }

    /// The table size a window is laid out at: its own (title, hands),
    /// unless a hand names a seat past it (`crate::seats::table_size`).
    fn size_of(attached: &Attached) -> u32 {
        seats::table_size(
            attached.window.size,
            attached.shown.1.iter().filter_map(|p| p.seat),
        )
    }

    fn reread_all(&mut self, since: Instant, out: &mut dyn FnMut(HudMessage)) {
        let ids: Vec<WindowId> = self.attached.keys().copied().collect();
        for id in ids {
            self.reread(id, None, since, None, out);
        }
    }

    /// Read the table's players' rollups again - over the table's segment,
    /// and only the user's own hands where the room says so (R3.7) - and
    /// redraw it. `hand_key`: the hand that caused it (its chain is
    /// reported, `timing` the app's part of it).
    fn reread(
        &mut self,
        id: WindowId,
        hand_key: Option<&str>,
        since: Instant,
        timing: Option<HandTiming>,
        out: &mut dyn FnMut(HudMessage),
    ) {
        let Some(attached) = self.attached.get(&id) else {
            return;
        };
        if attached.players.is_empty() {
            return;
        }
        let site = attached.store_site.clone();
        let players = attached.players.clone();
        let segments: Option<Vec<i64>> = attached.segment.map(|segment| vec![segment]);
        // `ownHandsOnly`: statistics from hands the user played only. A room
        // without a permit is not drawn at all (`repaint`); read as strictly.
        let own_hands_only = self
            .compliance
            .permit(&attached.window.site)
            .map_or(true, |permit| permit.restrictions().own_hands_only);
        let keys: Vec<(&str, &str)> = players
            .iter()
            .map(|p| (p.name.as_str(), p.scope.as_str()))
            .collect();
        let totals = match self
            .store
            .totals(&site, &keys, segments.as_deref(), own_hands_only)
        {
            Ok(totals) => totals,
            Err(error) => {
                self.draw(id, Some(format!("no statistics: {error}")), Vec::new());
                return;
            }
        };
        let custom = self.custom_counts(&site, &players, segments.as_deref(), own_hands_only);
        let window_site = attached_site(&self.attached, id);
        let mut words = self.words_of(&window_site, &site, &players).into_iter();
        let elapsed = since.elapsed();
        self.latencies.record(elapsed);
        let read_us = unix_us();
        let panels: Vec<SeatPanel> = players
            .iter()
            .zip(&totals)
            .enumerate()
            .map(|(index, (player, totals))| SeatPanel {
                player: player.name.clone(),
                seat: player.seat,
                hands: totals.hands(),
                stats: self.panel_stats.cells_with(&totals.sums(), |key| {
                    custom
                        .get(index)
                        .and_then(|counts| counts.get(key).copied())
                }),
                words: words.next().unwrap_or_default(),
            })
            .collect();
        let shown: Vec<PlayerHands> = panels
            .iter()
            .map(|p| PlayerHands {
                name: p.player.clone(),
                hands: p.hands,
            })
            .collect();
        let mut chain = hand_key.map(|_| LatencyChain {
            noticed_us: timing.and_then(|t| t.noticed_us),
            imported_us: timing.and_then(|t| t.imported_us),
            sent_us: timing.and_then(|t| t.sent_us),
            arrived_us: unix_us_at(since),
            read_us,
            painted_us: read_us,
        });
        // A debug build shows the hand's latency on the table; a release
        // build never does.
        if cfg!(debug_assertions)
            && let Some(chain) = chain.as_ref().filter(|c| c.noticed_us.is_some())
            && let Some(attached) = self.attached.get_mut(&id)
        {
            attached.debug = Some(debug_line(chain));
        }
        self.draw(id, None, panels);
        if let Some(chain) = &mut chain {
            chain.painted_us = unix_us();
        }
        let table = self.attached.get(&id).and_then(|a| a.window.table.clone());
        if let (Some(report), Some(chain), Some(hand_key)) =
            (&mut self.latency_report, &chain, hand_key)
        {
            let line = serde_json::json!({
                "window": id.0,
                "site": site,
                "table": table,
                "handKey": hand_key,
                "chain": chain,
                "totalUs": chain.total_us(),
            });
            if writeln!(report, "{line}")
                .and_then(|()| report.flush())
                .is_err()
            {
                eprintln!("rail-hud: the latency report could not be written");
                self.latency_report = None;
            }
        }
        out(HudMessage::TableUpdated {
            window: id.0,
            site,
            table,
            hand_key: hand_key.map(str::to_owned),
            players: shown,
            reread_us: micros(elapsed),
            chain,
        });
    }

    /// (R3.7) Each player's counts of the user's statistics the design
    /// shows, by statistic id (empty when it shows none).
    fn custom_counts(
        &mut self,
        site: &str,
        players: &[PlayerRef],
        segments: Option<&[i64]>,
        own_hands_only: bool,
    ) -> Vec<BTreeMap<String, (i64, i64)>> {
        if self.custom_ids.is_empty() || !self.panel_stats.reads_custom() {
            return Vec::new();
        }
        let wanted = self.custom_ids.clone();
        let ids: Vec<i64> = wanted.iter().map(|(_, id)| *id).collect();
        players
            .iter()
            .map(|player| {
                match self.store.custom_totals(
                    (site, &player.name, &player.scope),
                    segments,
                    &ids,
                    own_hands_only,
                ) {
                    Ok(counts) => wanted
                        .iter()
                        .filter_map(|(key, id)| {
                            counts.get(id).map(|c| (key.clone(), (c.made, c.opp)))
                        })
                        .collect(),
                    Err(error) => {
                        eprintln!("rail-hud: the user's statistics of a player: {error}");
                        BTreeMap::new()
                    }
                }
            })
            .collect()
    }

    /// Show a status line or panels over an attached window.
    fn draw(&mut self, id: WindowId, status: Option<String>, panels: Vec<SeatPanel>) {
        let Some(attached) = self.attached.get_mut(&id) else {
            return;
        };
        attached.shown = (status, panels);
        self.repaint(id);
    }

    /// Every attached window again (a layout or a preferred seat changed).
    fn repaint_all(&mut self) {
        let ids: Vec<WindowId> = self.attached.keys().copied().collect();
        for id in ids {
            self.repaint(id);
        }
    }

    /// Hand the window's frame to the backend: what it shows, where (the
    /// room's layout for the table size, the hero's rotation, the user's
    /// positions - R3.6). Compliance is asked again here (guideline §7,
    /// R3.4): no frame - and so nothing drawn - without its permit for the
    /// window's room; a window that has lost it loses its overlay.
    fn repaint(&mut self, id: WindowId) {
        let Some(attached) = self.attached.get(&id) else {
            return;
        };
        let permit = match self.compliance.permit(&attached.window.site) {
            Ok(permit) => permit,
            Err(reason) => {
                eprintln!(
                    "rail-hud: not drawing on window {} ({}): {reason:?}",
                    id.0, attached.window.site
                );
                self.platform.remove_overlay(id);
                return;
            }
        };
        let site = attached.window.site.as_str();
        let size = Self::size_of(attached);
        let seating = Seating {
            layout: self.rooms.layout(site, size),
            rotate_to: if self.rooms.rotates(site) {
                attached.hero_seat
            } else {
                None
            },
            positions: self.rooms.positions(site, size),
            drags_seen: attached.drags_seen,
        };
        let (status, panels) = attached.shown.clone();
        let frame = OverlayFrame {
            permit,
            // Only ever set in a debug build (`reread`).
            debug: attached.debug.clone().filter(|_| status.is_none()),
            status,
            size: Some(size),
            seating,
            panels,
            legend: self.panel_stats.legend_tones(),
        };
        if let Err(error) = self.platform.overlay(id, &frame) {
            eprintln!("rail-hud: overlay on window {}: {error}", id.0);
        }
    }

    fn report_open(&mut self, out: &mut dyn FnMut(HudMessage)) {
        let count = u32::try_from(self.attached.len()).unwrap_or(u32::MAX);
        if count != self.reported_open {
            self.reported_open = count;
            out(HudMessage::TablesOpen { count });
        }
    }
}

/// The `sites.json` room of an attached window (empty when it is gone).
fn attached_site(attached: &BTreeMap<WindowId, Attached>, id: WindowId) -> String {
    attached
        .get(&id)
        .map(|a| a.window.site.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::sim::{SimBackend, SimFeed};

    fn started(feed: &SimFeed) {
        feed.push_line(r#"{"event":"started","titleRegex":"^(?P<table>.+?) - .*$"}"#);
    }

    fn table(feed: &SimFeed, n: u32, title: &str) {
        feed.push_line(&format!(
            r#"{{"event":"table","table":{n},"title":"{title}","size":6}}"#
        ));
    }

    fn hud(site: &str) -> (Hud, SimFeed) {
        let (backend, feed) = SimBackend::new(site);
        started(&feed);
        let hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            Settings::default(),
        );
        (hud, feed)
    }

    fn step(hud: &mut Hud) -> Vec<HudMessage> {
        let mut sent = Vec::new();
        hud.next_find = Instant::now();
        hud.tick(Instant::now(), &mut |m| sent.push(m));
        sent
    }

    /// An allowed room: attached, counted, detached when the window closes.
    #[test]
    fn allowed_room_attaches() {
        let (mut hud, feed) = hud("pokerstars");
        table(&feed, 1, "Hygiea IV - $0.05/$0.10");
        table(&feed, 2, "Florence 03 - $0.05/$0.10");
        let sent = step(&mut hud);
        assert_eq!(sent, [HudMessage::TablesOpen { count: 2 }]);
        assert_eq!(
            hud.attached(),
            [
                (WindowId(1), Some("Hygiea IV".into())),
                (WindowId(2), Some("Florence 03".into()))
            ]
        );
        assert!(step(&mut hud).is_empty(), "nothing new");
        feed.push_line(r#"{"event":"closed","table":1}"#);
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        let mut sent = Vec::new();
        let health = hud.handle(
            Input::App(AppMessage::Health { seq: 9 }, Instant::now()),
            &mut |m| sent.push(m),
        );
        assert_eq!(health, None);
        match &sent[..] {
            [HudMessage::Health { seq: 9, report }] => {
                assert_eq!((report.attached, report.refused), (1, 0));
                assert_eq!(report.platform, "sim");
                assert!(!report.store_open);
            }
            other => panic!("{other:?}"),
        }
    }

    /// A prohibited room, an unknown one and an id nobody knows: never
    /// attached, each window reported once, its hands never read.
    #[test]
    fn disallowed_rooms_are_refused_once() {
        for (site, reason) in [
            ("ggpoker", RefusalReason::Prohibited),
            ("888poker", RefusalReason::Unknown),
            ("ipoker", RefusalReason::NotARoom),
            ("sim-test-room", RefusalReason::UnknownSite),
        ] {
            let (mut hud, feed) = hud(site);
            table(&feed, 4, "T - x");
            assert_eq!(
                step(&mut hud),
                [HudMessage::AttachRefused {
                    site: site.into(),
                    window: 4,
                    reason
                }],
                "{site}"
            );
            assert!(step(&mut hud).is_empty(), "reported once");
            assert!(hud.attached().is_empty());
            let mut sent = Vec::new();
            hud.handle(
                Input::App(
                    AppMessage::HandImported {
                        site: site.into(),
                        table: Some("T".into()),
                        hand_key: format!("{site}:1"),
                        players: vec![PlayerRef::named("P")],
                        timing: None,
                    },
                    Instant::now(),
                ),
                &mut |m| sent.push(m),
            );
            assert!(sent.is_empty(), "{site}: nothing read for a refused table");
        }
    }

    /// A remote policy that switches the room off detaches its tables at
    /// once; the shipped policy back attaches them again.
    #[test]
    fn a_stricter_policy_detaches() {
        let (mut hud, feed) = hud("winamax");
        table(&feed, 1, "Table A - x");
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        let mut remote: serde_json::Value =
            serde_json::from_str(rail_config::SHIPPED).expect("json");
        for site in remote["sites"].as_array_mut().expect("sites") {
            if site["id"] == "winamax" {
                site["hud"]["allowed"] = serde_json::Value::Bool(false);
            }
        }
        let mut sent = Vec::new();
        hud.handle(
            Input::App(
                AppMessage::Policy {
                    remote: Some(remote.to_string()),
                },
                Instant::now(),
            ),
            &mut |m| sent.push(m),
        );
        assert_eq!(
            sent,
            [
                HudMessage::AttachRefused {
                    site: "winamax".into(),
                    window: 1,
                    reason: RefusalReason::Prohibited
                },
                HudMessage::TablesOpen { count: 0 }
            ]
        );
        assert!(step(&mut hud).is_empty());
        let mut sent = Vec::new();
        hud.handle(
            Input::App(AppMessage::Policy { remote: None }, Instant::now()),
            &mut |m| sent.push(m),
        );
        assert!(sent.is_empty());
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
    }

    /// A tournament table move (the title's table changes) forgets the
    /// players; a hand for the old table no longer matches.
    #[test]
    fn a_table_move_waits_for_the_next_hand() {
        let (mut hud, feed) = hud("pokerstars");
        table(&feed, 1, "Old - x");
        step(&mut hud);
        table(&feed, 1, "New - x");
        assert!(step(&mut hud).is_empty());
        assert_eq!(hud.attached(), [(WindowId(1), Some("New".into()))]);
    }

    /// A hand announced before its table's window is found: the window
    /// starts from its players once attached (and a table move to a table
    /// with a known hand does too).
    #[test]
    fn a_hand_before_its_window() {
        let (mut hud, feed) = hud("acr");
        let hand = |table: &str, player: &str| {
            Input::App(
                AppMessage::HandImported {
                    site: "acrwpn".into(),
                    table: Some(table.into()),
                    hand_key: format!("acrwpn:{player}"),
                    players: vec![PlayerRef::named(player)],
                    timing: None,
                },
                Instant::now(),
            )
        };
        hud.handle(hand("Miramar", "Ana"), &mut |_| {});
        hud.handle(hand("Florence", "Bo"), &mut |_| {});
        table(&feed, 1, "Miramar - x");
        step(&mut hud);
        assert_eq!(hud.players_of(WindowId(1)), ["Ana"]);
        table(&feed, 1, "Florence - x");
        step(&mut hud);
        assert_eq!(hud.players_of(WindowId(1)), ["Bo"]);
        table(&feed, 1, "Elsewhere - x");
        step(&mut hud);
        assert!(hud.players_of(WindowId(1)).is_empty());
    }

    #[test]
    fn the_loop_ends_on_shutdown_or_when_the_app_goes() {
        let (mut hud, _feed) = hud("pokerstars");
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(Input::App(AppMessage::Unknown, Instant::now()))
            .expect("send");
        tx.send(Input::App(AppMessage::Shutdown, Instant::now()))
            .expect("send");
        assert_eq!(hud.run(&rx, &mut |_| {}), Exit::Shutdown);
        tx.send(Input::AppGone).expect("send");
        assert_eq!(hud.run(&rx, &mut |_| {}), Exit::AppGone);
        tx.send(Input::AppClosed(Some("x".into()))).expect("send");
        assert_eq!(hud.run(&rx, &mut |_| {}), Exit::AppClosed(Some("x".into())));
        drop(tx);
        assert_eq!(hud.run(&rx, &mut |_| {}), Exit::AppGone);
    }

    fn hand(site: &str, table: &str, player: &str) -> Input {
        Input::App(
            AppMessage::HandImported {
                site: site.into(),
                table: Some(table.into()),
                hand_key: format!("{site}:{player}"),
                players: vec![PlayerRef::named(player)],
                timing: None,
            },
            Instant::now(),
        )
    }

    /// Identity is the whole name (R3.3): `Table 1` is not `Table 11`,
    /// `Hygiea IV` is not `Hygiea IV 40-100 bb`; white space aside.
    #[test]
    fn similar_names_are_different_tables() {
        let (mut hud, feed) = hud("pokerstars");
        table(&feed, 1, "Table 1 - x");
        table(&feed, 2, "Table 11 - x");
        table(&feed, 3, "Hygiea IV - x");
        table(&feed, 4, "Hygiea IV 40-100 bb - x");
        step(&mut hud);
        assert_eq!(hud.health().waiting, 4);
        hud.handle(hand("pokerstars", "Table 1", "Ana"), &mut |_| {});
        hud.handle(hand("pokerstars", " Table  11 ", "Bo"), &mut |_| {});
        hud.handle(hand("pokerstars", "Hygiea IV 40-100 bb", "Cy"), &mut |_| {});
        hud.handle(hand("pokerstars", "Hygiea", "Di"), &mut |_| {});
        assert_eq!(hud.players_of(WindowId(1)), ["Ana"]);
        assert_eq!(hud.players_of(WindowId(2)), ["Bo"]);
        assert!(hud.players_of(WindowId(3)).is_empty());
        assert_eq!(hud.players_of(WindowId(4)), ["Cy"]);
        assert_eq!(hud.health().waiting, 1, "Hygiea IV has had no hand");
        // Another room's hand of the same name is not this table's.
        hud.handle(hand("winamax", "Hygiea IV", "Ed"), &mut |_| {});
        assert!(hud.players_of(WindowId(3)).is_empty());
    }

    /// Two windows with one table name cannot be told apart: neither takes
    /// the hand. Once one closes, the other does.
    #[test]
    fn one_name_on_two_windows_is_ambiguous() {
        let (mut hud, feed) = hud("pokerstars");
        table(&feed, 1, "Same - x");
        step(&mut hud);
        hud.handle(hand("pokerstars", "Same", "Ana"), &mut |_| {});
        assert_eq!(hud.players_of(WindowId(1)), ["Ana"]);
        table(&feed, 2, "Same - y");
        step(&mut hud);
        assert!(hud.players_of(WindowId(1)).is_empty(), "no longer known");
        hud.handle(hand("pokerstars", "Same", "Bo"), &mut |_| {});
        assert!(hud.players_of(WindowId(1)).is_empty());
        assert!(hud.players_of(WindowId(2)).is_empty());
        assert_eq!(hud.health().waiting, 2);
        feed.push_line(r#"{"event":"closed","table":2}"#);
        step(&mut hud);
        hud.handle(hand("pokerstars", "Same", "Cy"), &mut |_| {});
        assert_eq!(hud.players_of(WindowId(1)), ["Cy"]);
        assert_eq!(hud.health().waiting, 0);
    }

    /// A backend without events (Windows before R3.5's hooks): what it
    /// finds is all the engine learns.
    #[derive(Default)]
    struct Polled(std::rc::Rc<std::cell::RefCell<Vec<TableWindow>>>);

    impl Platform for Polled {
        fn name(&self) -> &'static str {
            "polled"
        }
        fn find_tables(
            &mut self,
            _: &[TableMatcher],
        ) -> Result<Vec<TableWindow>, crate::platform::PlatformError> {
            Ok(self.0.borrow().clone())
        }
        fn track(&mut self, _: &TableWindow) -> Result<(), crate::platform::PlatformError> {
            Ok(())
        }
        fn untrack(&mut self, _: WindowId) {}
        fn poll_events(&mut self) -> Vec<TableEvent> {
            Vec::new()
        }
        fn overlay(
            &mut self,
            _: WindowId,
            _: &OverlayFrame,
        ) -> Result<(), crate::platform::PlatformError> {
            Ok(())
        }
        fn remove_overlay(&mut self, _: WindowId) {}
    }

    fn polled_window(title: &str, table: &str, size: Option<u32>) -> TableWindow {
        TableWindow {
            id: WindowId(9),
            site: "pokerstars".into(),
            process: crate::platform::ProcessInfo {
                pid: Some(1),
                name: "PokerStars.exe".into(),
            },
            title: title.into(),
            table: Some(table.into()),
            size,
            client: crate::platform::Rect {
                x: 0,
                y: 0,
                width: 800,
                height: 550,
            },
            scale_permille: 1000,
            minimized: false,
        }
    }

    /// Without hooks, the re-find sees a tournament table move (the title),
    /// a move or resize, a minimise, and the seats a title gives.
    #[test]
    fn the_re_find_follows_a_window() {
        let windows = std::rc::Rc::new(std::cell::RefCell::new(vec![polled_window(
            "T 1 - x", "T 1", None,
        )]));
        let mut hud = Hud::new(
            Box::new(Polled(windows.clone())),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            Settings::default(),
        );
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        hud.handle(hand("pokerstars", "T 1", "Ana"), &mut |_| {});
        hud.handle(hand("pokerstars", "T 2", "Bo"), &mut |_| {});
        assert_eq!(hud.players_of(WindowId(9)), ["Ana"]);
        assert_eq!(hud.window(WindowId(9)).and_then(|w| w.size), None);

        let mut moved = polled_window("T 2 - x", "T 2", Some(9));
        moved.client.x = 300;
        moved.scale_permille = 1500;
        moved.minimized = true;
        windows.borrow_mut()[0] = moved;
        assert!(step(&mut hud).is_empty());
        let seen = hud.window(WindowId(9)).expect("attached").clone();
        assert_eq!(seen.table.as_deref(), Some("T 2"));
        assert_eq!((seen.client.x, seen.scale_permille), (300, 1500));
        assert!(seen.minimized);
        assert_eq!(seen.size, Some(9));
        assert_eq!(hud.players_of(WindowId(9)), ["Bo"], "T 2's last hand");

        windows.borrow_mut().clear();
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 0 }]);
    }

    /// A backend with hooks (Windows since R3.5): its events, and how many
    /// times it was asked to find.
    #[derive(Default)]
    struct Hooked {
        windows: std::rc::Rc<std::cell::RefCell<Vec<TableWindow>>>,
        events: std::rc::Rc<std::cell::RefCell<Vec<TableEvent>>>,
        finds: std::rc::Rc<std::cell::Cell<u32>>,
        followed: std::rc::Rc<std::cell::RefCell<Vec<crate::platform::Rect>>>,
    }

    impl Platform for Hooked {
        fn name(&self) -> &'static str {
            "hooked"
        }
        fn find_tables(
            &mut self,
            _: &[TableMatcher],
        ) -> Result<Vec<TableWindow>, crate::platform::PlatformError> {
            self.finds.set(self.finds.get() + 1);
            Ok(self.windows.borrow().clone())
        }
        fn track(&mut self, _: &TableWindow) -> Result<(), crate::platform::PlatformError> {
            Ok(())
        }
        fn untrack(&mut self, _: WindowId) {}
        fn follow(&mut self, window: &TableWindow) {
            self.followed.borrow_mut().push(window.client);
        }
        fn poll_events(&mut self) -> Vec<TableEvent> {
            std::mem::take(&mut *self.events.borrow_mut())
        }
        fn overlay(
            &mut self,
            _: WindowId,
            _: &OverlayFrame,
        ) -> Result<(), crate::platform::PlatformError> {
            Ok(())
        }
        fn remove_overlay(&mut self, _: WindowId) {}
    }

    /// The hooks' events between two finds: a move is followed at the next
    /// tick, a retitle moves the table, `Appeared` makes the HUD look at
    /// once rather than at the next periodic find, `Closed` detaches.
    #[test]
    fn hook_events_between_finds() {
        let backend = Hooked::default();
        let (windows, events, finds, followed) = (
            backend.windows.clone(),
            backend.events.clone(),
            backend.finds.clone(),
            backend.followed.clone(),
        );
        windows
            .borrow_mut()
            .push(polled_window("T 1 - x", "T 1", Some(6)));
        let mut hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            Settings::default(),
        );
        let start = Instant::now();
        let mut sent = Vec::new();
        hud.tick(start, &mut |m| sent.push(m));
        assert_eq!(finds.get(), 1);
        assert_eq!(sent, [HudMessage::TablesOpen { count: 1 }]);
        hud.handle(hand("pokerstars", "T 2", "Bo"), &mut |_| {});

        // Moved and retitled by the hooks, well before the next find.
        let mut client = polled_window("", "", None).client;
        client.x = 640;
        events.borrow_mut().extend([
            TableEvent::Moved {
                id: WindowId(9),
                client,
                scale_permille: 1250,
            },
            TableEvent::Retitled {
                id: WindowId(9),
                title: "T 2 - x".into(),
                table: Some("T 2".into()),
            },
        ]);
        hud.tick(start, &mut |_| {});
        assert_eq!(finds.get(), 1, "no find yet");
        let window = hud.window(WindowId(9)).expect("attached").clone();
        assert_eq!((window.client.x, window.scale_permille), (640, 1250));
        assert_eq!(*followed.borrow(), [client]);
        assert_eq!(window.table.as_deref(), Some("T 2"));
        assert_eq!(hud.players_of(WindowId(9)), ["Bo"], "T 2's last hand");

        // A window shown by the client: looked for at once.
        let mut second = polled_window("T 3 - x", "T 3", Some(6));
        second.id = WindowId(10);
        windows.borrow_mut()[0] = window;
        windows.borrow_mut().push(second);
        events.borrow_mut().push(TableEvent::Appeared);
        let mut sent = Vec::new();
        hud.tick(start, &mut |m| sent.push(m));
        assert_eq!(finds.get(), 2, "found at once");
        assert_eq!(sent, [HudMessage::TablesOpen { count: 2 }]);
        hud.tick(start, &mut |_| {});
        assert_eq!(finds.get(), 2, "and then on the period again");

        events
            .borrow_mut()
            .push(TableEvent::Closed { id: WindowId(10) });
        let mut sent = Vec::new();
        hud.tick(start, &mut |m| sent.push(m));
        assert_eq!(sent, [HudMessage::TablesOpen { count: 1 }]);
    }

    /// A backend that keeps every frame (R3.6) and gives the events a test
    /// queues - the overlay thread's drags among them.
    #[derive(Default)]
    struct Drawn {
        windows: std::rc::Rc<std::cell::RefCell<Vec<TableWindow>>>,
        events: std::rc::Rc<std::cell::RefCell<Vec<TableEvent>>>,
        frames: std::rc::Rc<std::cell::RefCell<BTreeMap<WindowId, OverlayFrame>>>,
    }

    impl Platform for Drawn {
        fn name(&self) -> &'static str {
            "drawn"
        }
        fn find_tables(
            &mut self,
            _: &[TableMatcher],
        ) -> Result<Vec<TableWindow>, crate::platform::PlatformError> {
            Ok(self.windows.borrow().clone())
        }
        fn track(&mut self, _: &TableWindow) -> Result<(), crate::platform::PlatformError> {
            Ok(())
        }
        fn untrack(&mut self, _: WindowId) {}
        fn poll_events(&mut self) -> Vec<TableEvent> {
            std::mem::take(&mut *self.events.borrow_mut())
        }
        fn overlay(
            &mut self,
            id: WindowId,
            frame: &OverlayFrame,
        ) -> Result<(), crate::platform::PlatformError> {
            self.frames.borrow_mut().insert(id, frame.clone());
            Ok(())
        }
        fn remove_overlay(&mut self, id: WindowId) {
            self.frames.borrow_mut().remove(&id);
        }
    }

    fn seated(site: &str, table: &str, key: &str, hero: Option<u32>, seats: &[u32]) -> Input {
        Input::App(
            AppMessage::HandImported {
                site: site.into(),
                table: Some(table.into()),
                hand_key: key.into(),
                players: seats
                    .iter()
                    .map(|&seat| PlayerRef {
                        hero: hero == Some(seat),
                        ..PlayerRef::named(format!("P{seat}")).at(seat)
                    })
                    .collect(),
                timing: None,
            },
            Instant::now(),
        )
    }

    /// The app's store with the user's layouts (R3.6), as the app writes
    /// them; the HUD reads it read-only.
    fn store_with(
        name: &str,
        write: impl FnOnce(&rail_store::WriterHandle),
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("rail-hud-engine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(rail_store::FILE_NAME);
        let store = rail_store::Store::open(&path).expect("store");
        let writer = store.writer().expect("writer");
        write(&writer);
        drop(writer);
        store.close();
        (path, dir)
    }

    /// Seats and layouts through the engine (R3.6): the hero's seat from
    /// the hands, rotation only where the room's client rotates (the
    /// user's word from the store), the hero kept while not dealt in,
    /// forgotten on a table move; a drag remembered for every table of that
    /// room and size, told to the app; the store's positions read at start
    /// and on `layout_changed`.
    #[test]
    fn seats_rotation_and_drags() {
        let (path, dir) = store_with("seats", |writer| {
            writer
                .set_hud_seat_position("pokerstars", 9, 4, 111, 222)
                .expect("a position");
        });
        let backend = Drawn::default();
        let (windows, events, frames) = (
            backend.windows.clone(),
            backend.events.clone(),
            backend.frames.clone(),
        );
        let mut one = polled_window("T 1 - x", "T 1", Some(6));
        one.id = WindowId(1);
        let mut two = polled_window("T 2 - x", "T 2", Some(6));
        two.id = WindowId(2);
        let mut nine = polled_window("T 9 - x", "T 9", Some(9));
        nine.id = WindowId(3);
        windows.borrow_mut().extend([one, two, nine]);
        let mut hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(Some(path.clone())),
            Settings::default(),
        );
        step(&mut hud);
        let seating = |id: u64| {
            frames
                .borrow()
                .get(&WindowId(id))
                .map(|f| f.seating.clone())
                .expect("a frame")
        };
        assert_eq!(
            seating(3).positions.get(&4),
            Some(&(111, 222)),
            "read from the store at start"
        );
        assert!(seating(1).positions.is_empty(), "another size");

        // PokerStars' preferred seat is unknown: no rotation.
        hud.handle(
            seated("pokerstars", "T 1", "h1", Some(4), &[1, 2, 4]),
            &mut |_| {},
        );
        assert_eq!(seating(1).rotate_to, None);
        // The user says their client rotates: from the store, on
        // `settings_changed`.
        let writer_store = rail_store::Store::open(&path).expect("the app's store");
        writer_store
            .writer()
            .expect("writer")
            .set_hud_preferred_seat("pokerstars", Some(true))
            .expect("on");
        hud.handle(
            Input::App(AppMessage::SettingsChanged, Instant::now()),
            &mut |_| {},
        );
        assert_eq!(seating(1).rotate_to, Some(4));
        // Not dealt in: the seat kept while empty; someone else in it: no
        // rotation.
        hud.handle(
            seated("pokerstars", "T 1", "h2", None, &[1, 2]),
            &mut |_| {},
        );
        assert_eq!(seating(1).rotate_to, Some(4));
        hud.handle(
            seated("pokerstars", "T 1", "h3", None, &[1, 4]),
            &mut |_| {},
        );
        assert_eq!(seating(1).rotate_to, None);
        hud.handle(
            seated("pokerstars", "T 1", "h4", Some(2), &[1, 2]),
            &mut |_| {},
        );
        assert_eq!(seating(1).rotate_to, Some(2));
        // A table move forgets it.
        events.borrow_mut().push(TableEvent::Retitled {
            id: WindowId(1),
            title: "T 5 - x".into(),
            table: Some("T 5".into()),
        });
        hud.tick(Instant::now(), &mut |_| {});
        assert_eq!(seating(1).rotate_to, None);

        // A drag on table 1 (6 seats): the app is told, both 6-seat tables
        // get the position, the 9-seat one does not; the frame says the
        // drag was taken in.
        events.borrow_mut().push(TableEvent::PanelMoved {
            id: WindowId(1),
            size: 6,
            slot: 2,
            x: 300,
            y: 400,
            seq: 7,
        });
        let mut sent = Vec::new();
        hud.tick(Instant::now(), &mut |m| sent.push(m));
        assert_eq!(
            sent,
            [HudMessage::SeatPositionChanged {
                site: "pokerstars".into(),
                size: 6,
                slot: 2,
                x: 300,
                y: 400
            }]
        );
        assert_eq!(seating(1).positions.get(&2), Some(&(300, 400)));
        assert_eq!(seating(1).drags_seen, 7);
        assert_eq!(seating(2).positions.get(&2), Some(&(300, 400)));
        assert_eq!(seating(2).drags_seen, 0);
        assert!(!seating(3).positions.contains_key(&2));
        // Nonsense from a backend is not passed on.
        events.borrow_mut().push(TableEvent::PanelMoved {
            id: WindowId(1),
            size: 6,
            slot: 6,
            x: 300,
            y: 400,
            seq: 8,
        });
        let mut sent = Vec::new();
        hud.tick(Instant::now(), &mut |m| sent.push(m));
        assert!(sent.is_empty());

        // The app wrote the drag; `layout_changed` reads the store again
        // (which now has both).
        writer_store
            .writer()
            .expect("writer")
            .set_hud_seat_position("pokerstars", 6, 2, 300, 400)
            .expect("the app writes");
        hud.handle(
            Input::App(AppMessage::LayoutChanged, Instant::now()),
            &mut |_| {},
        );
        assert_eq!(seating(2).positions.get(&2), Some(&(300, 400)));
        assert_eq!(seating(3).positions.get(&4), Some(&(111, 222)));
        hud.shutdown();
        drop(hud);
        writer_store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (R3.8) A click on a panel asks the app for the popup of the player
    /// at that slot (with the room, the store's site, the table, the
    /// segment and the panel on the screen); a slot nobody sits in asks for
    /// nothing. The player's words reach the panel on Winamax only, never
    /// for the hero nor on PokerStars; every frame carries the legend's
    /// tones.
    #[test]
    fn clicks_open_the_popup_and_words_follow_the_room() {
        let (path, dir) = store_with("popup", |writer| {
            writer
                .write(|tx| {
                    for site in ["winamax", "pokerstars"] {
                        for player in ["P1", "P2"] {
                            tx.execute(
                                "INSERT INTO player_summary (site, player, hands,
                                    first_played_at, last_played_at, cash_hands, chips_hands,
                                    cash_money_hands, cash_net_bb_milli, chips_money_hands,
                                    chips_net_bb_milli)
                                 VALUES (?1, ?2, 10, NULL, NULL, 10, 0, 10, 0, 0, 0)",
                                [site, player],
                            )?;
                            rail_store::players::set_colour(tx, site, player, Some("red"), 1)?;
                            rail_store::players::set_note(tx, site, player, "made-up note", 1)?;
                            rail_store::players::add_label(tx, site, player, "regular", 1)?;
                        }
                    }
                    Ok(())
                })
                .expect("the user's words");
        });
        let backend = Drawn::default();
        let (windows, events, frames) = (
            backend.windows.clone(),
            backend.events.clone(),
            backend.frames.clone(),
        );
        let mut winamax = polled_window("W 1 - x", "W 1", Some(6));
        winamax.id = WindowId(1);
        winamax.site = "winamax".into();
        let mut stars = polled_window("S 1 - x", "S 1", Some(6));
        stars.id = WindowId(2);
        windows.borrow_mut().extend([winamax, stars]);
        let mut hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(Some(path.clone())),
            Settings::default(),
        );
        step(&mut hud);
        hud.handle(
            seated("winamax", "W 1", "w1", Some(1), &[1, 2, 3]),
            &mut |_| {},
        );
        hud.handle(
            seated("pokerstars", "S 1", "s1", Some(1), &[1, 2, 3]),
            &mut |_| {},
        );
        let words = |id: u64| -> Vec<PanelWords> {
            frames
                .borrow()
                .get(&WindowId(id))
                .expect("a frame")
                .panels
                .iter()
                .map(|p| p.words.clone())
                .collect()
        };
        let noted = PanelWords {
            colour: Some(TagColour::Red),
            label: Some("regular".into()),
            noted: true,
        };
        // The hero (P1) takes none; P3 has none.
        assert_eq!(
            words(1),
            [PanelWords::default(), noted, PanelWords::default()]
        );
        assert_eq!(words(2), vec![PanelWords::default(); 3], "PokerStars");
        assert_eq!(
            frames.borrow()[&WindowId(1)].legend,
            PanelStats::new(&PanelDesign::default()).legend_tones()
        );

        // A click on P2's panel (seat 2: slot 1, no rotation).
        let panel = Rect {
            x: -900,
            y: 300,
            width: 90,
            height: 40,
        };
        events.borrow_mut().push(TableEvent::PanelClicked {
            id: WindowId(1),
            slot: 1,
            panel,
            scale_permille: 1250,
        });
        let mut sent = Vec::new();
        hud.tick(Instant::now(), &mut |m| sent.push(m));
        assert_eq!(
            sent,
            [HudMessage::OpenPopup {
                window: 1,
                site: "winamax".into(),
                store_site: "winamax".into(),
                table: Some("W 1".into()),
                player: PlayerRef::named("P2").at(2),
                segment: None,
                slot: 1,
                anchor: ScreenRect {
                    x: -900,
                    y: 300,
                    width: 90,
                    height: 40
                },
                scale_permille: 1250,
            }]
        );
        // The hero's own panel opens the hero's popup.
        events.borrow_mut().push(TableEvent::PanelClicked {
            id: WindowId(2),
            slot: 0,
            panel,
            scale_permille: 1000,
        });
        let mut sent = Vec::new();
        hud.tick(Instant::now(), &mut |m| sent.push(m));
        assert!(
            matches!(&sent[..], [HudMessage::OpenPopup { player, site, .. }]
                if player.hero && player.name == "P1" && site == "pokerstars"),
            "{sent:?}"
        );
        // Nobody at slot 4; a window not attached.
        events.borrow_mut().push(TableEvent::PanelClicked {
            id: WindowId(1),
            slot: 4,
            panel,
            scale_permille: 1000,
        });
        events.borrow_mut().push(TableEvent::PanelClicked {
            id: WindowId(77),
            slot: 0,
            panel,
            scale_permille: 1000,
        });
        let mut sent = Vec::new();
        hud.tick(Instant::now(), &mut |m| sent.push(m));
        assert!(
            !sent
                .iter()
                .any(|m| matches!(m, HudMessage::OpenPopup { .. })),
            "{sent:?}"
        );
        hud.shutdown();
        drop(hud);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The test-only room entry adds the simulator's matcher to the find.
    #[test]
    fn a_simulator_room_is_offered_to_the_backend() {
        struct Offered(std::rc::Rc<std::cell::RefCell<Vec<String>>>);
        impl Platform for Offered {
            fn name(&self) -> &'static str {
                "offered"
            }
            fn find_tables(
                &mut self,
                matchers: &[TableMatcher],
            ) -> Result<Vec<TableWindow>, crate::platform::PlatformError> {
                *self.0.borrow_mut() = matchers
                    .iter()
                    .map(|m| format!("{} {}", m.site, m.processes.join(",")))
                    .collect();
                Ok(Vec::new())
            }
            fn track(&mut self, _: &TableWindow) -> Result<(), crate::platform::PlatformError> {
                Ok(())
            }
            fn untrack(&mut self, _: WindowId) {}
            fn poll_events(&mut self) -> Vec<TableEvent> {
                Vec::new()
            }
            fn overlay(
                &mut self,
                _: WindowId,
                _: &OverlayFrame,
            ) -> Result<(), crate::platform::PlatformError> {
                Ok(())
            }
            fn remove_overlay(&mut self, _: WindowId) {}
        }
        let offered = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let mut hud = Hud::new(
            Box::new(Offered(offered.clone())),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            Settings::default(),
        );
        step(&mut hud);
        assert!(offered.borrow().is_empty(), "no room has a tables block");
        hud.add_simulator_room("acr", regex::Regex::new("^(?P<table>.+)$").expect("regex"));
        step(&mut hud);
        assert_eq!(*offered.borrow(), ["acr rail-hud-sim"]);
    }
}
