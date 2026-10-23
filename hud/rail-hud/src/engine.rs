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
    AppMessage, AttachedTable, HandTiming, HealthReport, HudMessage, LatencyChain, PlayerHands,
    PlayerRef, RefusalReason, RefusedTable, ScreenRect,
};
use rail_stats::custom::{CustomDef, CustomSet};
use rail_stats::display::Display;

use std::sync::Arc;

use crate::compliance::Compliance;
use crate::data::StoreView;
use crate::design::{Assignment, Compiled, DesignSet as Designs, FORCED, GameFormat, HudDesign};
use crate::latency::{Latencies, micros};
use crate::layout::TableLayout;
use crate::panel::PanelDesign;
use crate::platform::{
    OverlayFrame, PanelWords, Permission, Platform, Rect, SeatPanel, Seating, TableEvent,
    TableMatcher, TableWindow, TagColour, WindowId, permission_matters, table_key,
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
    /// (R3.14) How often to look while every tracked table is followed by
    /// the system's notifications alone ([`Platform::notified`]: macOS's
    /// observers, a client seen to post moves) - the look is then only the
    /// safety net, and its Accessibility calls are most of the HUD's idle
    /// cost. A hand of a table no window takes still looks at once.
    pub find_every_notified: Duration,
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
            find_every_notified: Duration::from_secs(2),
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
    /// (R3.9) The table's game format: its last hand's (cash until one
    /// says): which design is assigned.
    format: GameFormat,
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
    /// Windows refused, with their room, table and reason (each reported
    /// once; listed in every health answer, R3.10).
    refused: BTreeMap<WindowId, RefusedTable>,
    reported_open: u32,
    latencies: Latencies,
    started: Instant,
    next_find: Instant,
    next_store: Instant,
    /// Look for tables at the next tick, whatever `next_find` says.
    find_soon: bool,
    last_find_error: Option<String>,
    /// (R3.11) At the last look, with a permission missing: a running
    /// process belongs to an allowed room with a matcher, so granting it
    /// would find tables (`platform::permission_matters`).
    client_running: bool,
    /// The last hand announced per (store site, table), for windows that
    /// attach after it (bounded by [`RECENT_TABLES`]).
    recent: BTreeMap<(String, String), (String, Vec<PlayerRef>)>,
    /// Test-only room entries: the simulator's windows posing as a room
    /// ([`Hud::add_simulator_room`]), after `sites.json`'s matchers.
    test_matchers: Vec<TableMatcher>,
    /// (R3.9) The designs: the presets, the user's and their assignments,
    /// each compiled once for drawing.
    designs: Designs,
    /// (R3.7 / R3.9) One design for every table, whatever is assigned
    /// ([`Hud::set_design`]: tests and tools).
    forced: Option<PanelDesign>,
    /// (R3.7) The user's statistics with a counter: (statistic id, its row
    /// id in the store).
    custom_ids: Vec<(String, i64)>,
    /// The designs and the user's statistics were read from the store (or
    /// none is needed).
    designs_read: bool,
    /// (R3.7) `--latency-report`: one JSON line per hand's chain.
    latency_report: Option<Box<dyn std::io::Write>>,
    /// (R3.14) `--perf-report`: one JSON object at shutdown
    /// ([`Hud::perf`]).
    perf_report: Option<Box<dyn std::io::Write>>,
    /// (R3.14) Looks for tables so far, and the interval chosen at the
    /// last one.
    finds: u64,
    find_interval: Duration,
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
            client_running: false,
            recent: BTreeMap::new(),
            test_matchers: Vec::new(),
            designs: Designs::default(),
            forced: None,
            custom_ids: Vec::new(),
            designs_read: false,
            latency_report: None,
            perf_report: None,
            finds: 0,
            find_interval: settings.find_every,
            rooms,
            user_layouts_read: false,
        }
    }

    /// (R3.7) Write every hand's latency chain to `out`, one JSON object a
    /// line (`--latency-report`, for tests and measurements).
    pub fn set_latency_report(&mut self, out: Box<dyn std::io::Write>) {
        self.latency_report = Some(out);
    }

    /// (R3.7) Show `design` on every table, whatever is assigned (tests and
    /// tools; the app assigns designs through the store, R3.9): its
    /// statistics are compiled again - a user's own statistic (R2.10) from
    /// the store's definitions - and every table read again.
    pub fn set_design(&mut self, design: PanelDesign, out: &mut dyn FnMut(HudMessage)) {
        self.forced = Some(design);
        self.designs_read = false;
        self.read_designs();
        self.reread_all(Instant::now(), out);
    }

    /// (R3.9) Read the user's designs, their assignments and - when a
    /// design names one - the user's own statistics (R2.10) from the store;
    /// the compiled designs are dropped, to be compiled again as tables
    /// draw. Without a store: the presets alone, read again once it opens.
    fn read_designs(&mut self) {
        let Some(read) = self.store.hud_designs() else {
            self.designs
                .reset(Vec::new(), Vec::new(), CustomSet::default());
            return;
        };
        let (stored, assigned) = read.unwrap_or_else(|error| {
            eprintln!("rail-hud: the HUD designs did not read: {error}");
            (Vec::new(), Vec::new())
        });
        let mut user = Vec::new();
        for row in stored {
            match HudDesign::parse(&row.design) {
                Some(design) => user.push((row.id, design)),
                None => eprintln!("rail-hud: the design {} is not readable here", row.id),
            }
        }
        let assignments: Vec<Assignment> =
            assigned.iter().filter_map(Assignment::from_store).collect();
        let shipped = Display::shipped().ok();
        let is_shipped = |id: &str| shipped.as_ref().is_some_and(|d| d.get(id).is_some());
        let needs_custom = user
            .iter()
            .flat_map(|(_, design)| design.stat_ids().map(str::to_owned).collect::<Vec<_>>())
            .chain(
                self.forced
                    .iter()
                    .flat_map(|design| design.stats.iter().map(|slot| slot.id.clone())),
            )
            .any(|id| !is_shipped(&id));
        let mut custom = CustomSet::default();
        self.custom_ids.clear();
        if needs_custom && let Some(rows) = self.store.custom_stats() {
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
            custom = set;
        }
        eprintln!(
            "rail-hud: {} designs and {} assignments from the store",
            user.len(),
            assignments.len()
        );
        self.designs.reset(user, assignments, custom);
        self.designs_read = true;
    }

    /// (R3.9) The design a window is drawn with: the forced one, else the
    /// one assigned to its room, table size and format (the format's
    /// preset when none is).
    fn design_of(&mut self, id: WindowId) -> Arc<Compiled> {
        // The store opened since: its designs before the first table's.
        if !self.designs_read && self.store.is_open() {
            self.read_designs();
        }
        if let Some(forced) = &self.forced {
            return self.designs.compile_panel(FORCED, forced.clone(), None);
        }
        let key = match self.attached.get(&id) {
            Some(attached) => self.designs.resolve(
                &attached.window.site,
                Some(Self::size_of(attached)),
                attached.format,
            ),
            None => self
                .designs
                .presets
                .default_for(GameFormat::Cash)
                .to_owned(),
        };
        self.designs.compiled(&key)
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

    /// (R3.14) Write [`Hud::perf`] to `out` once, at shutdown
    /// (`--perf-report`, for the twelve-table measurement).
    pub fn set_perf_report(&mut self, out: Box<dyn std::io::Write>) {
        self.perf_report = Some(out);
    }

    /// (R3.14) What the process measured of itself: the backend's paints and
    /// follows (p50 / p95 / max µs), the hands' re-reads, how many looks for
    /// tables and the interval in force, the tables attached. Asks the
    /// backend's thread for its times: not for the loop's hot path.
    pub fn perf(&self) -> serde_json::Value {
        serde_json::json!({
            "platform": self.platform.name(),
            "uptimeMs": u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "attached": self.attached.len(),
            "refused": self.refused.len(),
            "paint": crate::latency::summarize(self.platform.paint_times_us()),
            "follow": crate::latency::summarize(self.platform.follow_times_us()),
            "reread": self.latencies.summary(),
            "finds": self.finds,
            "findEveryMs": u64::try_from(self.find_interval.as_millis()).unwrap_or(u64::MAX),
            "notified": self.platform.notified(),
        })
    }

    /// Remove every overlay and stop following every window (the
    /// `--perf-report` written first, while the overlays' times are there).
    pub fn shutdown(&mut self) {
        if let Some(mut out) = self.perf_report.take() {
            let perf = self.perf();
            if let Err(error) = writeln!(out, "{perf}").and_then(|()| out.flush()) {
                eprintln!("rail-hud: --perf-report: {error}");
            }
        }
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
            tables: self
                .attached
                .iter()
                .map(|(id, a)| AttachedTable {
                    window: id.0,
                    site: a.window.site.clone(),
                    table: a.window.table.clone(),
                    waiting: a.players.is_empty(),
                })
                .collect(),
            refused_tables: self.refused.values().cloned().collect(),
            remote_policy: self.compliance.has_remote(),
            // (R3.11) Asked of the system now (macOS: Accessibility), so
            // the app sees a grant within one health answer - and reported
            // as needed only when granting it would find something.
            permission_needed: self
                .missing_permission()
                .filter(|_| self.permission_matters())
                .map(|p| p.as_str().to_owned()),
            permission_deferred: self
                .missing_permission()
                .filter(|_| !self.permission_matters())
                .map(|p| p.as_str().to_owned()),
        }
    }

    /// (R3.11) A permission the backend lacks to find tables.
    fn missing_permission(&self) -> Option<Permission> {
        self.platform.permission_needed()
    }

    /// (R3.11) Whether granting a missing permission would make a
    /// difference now: the simulator's test entry is active, or at the last
    /// look a running process belonged to an allowed room with a matcher.
    /// Otherwise the app is told to ask for nothing.
    fn permission_matters(&self) -> bool {
        !self.test_matchers.is_empty() || self.client_running
    }

    /// (R3.11) With a permission missing: does a running process belong to
    /// an allowed room whose matcher could take its windows? (No
    /// permission is needed to tell.)
    fn look_for_clients(&mut self) {
        if self.missing_permission().is_none() {
            self.client_running = false;
            return;
        }
        let allowed: Vec<TableMatcher> = self
            .compliance
            .matchers()
            .into_iter()
            .filter(|m| self.compliance.decide(&m.site).is_ok())
            .collect();
        let running = self.platform.running_processes();
        self.client_running = permission_matters(running.as_deref(), &allowed, false);
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
                self.read_designs();
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
                let ids: Vec<(WindowId, String, Option<String>)> = self
                    .attached
                    .iter()
                    .map(|(id, a)| (*id, a.window.site.clone(), a.window.table.clone()))
                    .collect();
                self.refused.clear();
                for (id, site, table) in ids {
                    if let Err(reason) = self.compliance.decide(&site) {
                        self.detach(id);
                        self.refuse(id, &site, table, reason, out);
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
                // The user's positions and preferred seat (R3.6), their
                // designs and assignments (R3.9) and their own statistics
                // (R3.7): read again, every table again with them.
                self.read_user_layouts();
                self.read_designs();
                self.reread_all(at, out);
                self.repaint_all();
            }
            AppMessage::Shutdown => return Some(Exit::Shutdown),
            // (R3.11) The user clicked for it in the app: the system's own
            // prompt, if the permission is still missing and would make a
            // difference (what the health answer offered); then look again.
            AppMessage::RequestPermission { permission } => {
                match Permission::from_name(&permission) {
                    Some(permission)
                        if self.missing_permission() == Some(permission)
                            && self.permission_matters() =>
                    {
                        self.platform.request_permission(permission);
                        self.next_find = Instant::now();
                    }
                    Some(_) => {}
                    None => eprintln!("rail-hud: no permission {permission:?} to ask for"),
                }
            }
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
            self.finds += 1;
            self.find(out);
            // (R3.14) Slower while the system's notifications follow every
            // table (asked after each look, so what it saw counts: a table
            // not observed - a new one, a client that stopped posting, a
            // window whose title is not readable yet - brings the pace
            // back).
            let interval = if self.platform.notified() {
                self.settings.find_every_notified
            } else {
                self.settings.find_every
            };
            if interval != self.find_interval {
                // (R3.14) The find's pace in the log (a new table waits for
                // the quick one until its title bar is measured).
                eprintln!(
                    "rail-hud: looking for tables every {} ms",
                    interval.as_millis()
                );
            }
            self.find_interval = interval;
            self.next_find = now + self.find_interval;
        }
        if now >= self.next_store {
            self.next_store = now + self.settings.store_every;
            self.store.ensure_open();
            if !self.user_layouts_read && self.store.is_open() {
                self.read_user_layouts();
                self.repaint_all();
            }
            if !self.designs_read && self.store.is_open() {
                self.read_designs();
                self.repaint_all();
            }
            if self.store.changed() {
                self.reread_all(now, out);
            }
        }
    }

    fn find(&mut self, out: &mut dyn FnMut(HudMessage)) {
        self.look_for_clients();
        let mut matchers = self.compliance.matchers();
        matchers.extend(self.test_matchers.iter().cloned());
        let found = match self.platform.find_tables(&matchers) {
            Ok(found) => {
                self.last_find_error = None;
                found
            }
            Err(error) => {
                let revoked = matches!(error, crate::platform::PlatformError::PermissionNeeded(_));
                let error = error.to_string();
                if self.last_find_error.as_ref() != Some(&error) {
                    eprintln!("rail-hud: finding tables: {error}");
                    self.last_find_error = Some(error);
                }
                // (R3.13) The permission was taken away while tables were
                // attached (macOS: Accessibility switched off): no title
                // can be read any more, so none of them is known to be the
                // table it was - detach them all (their overlays go) rather
                // than draw over stale tables. The health answer says the
                // permission is needed (R3.11's rule: only when it would
                // find something), and the next look after a grant attaches
                // again.
                if revoked && !self.attached.is_empty() {
                    let ids: Vec<WindowId> = self.attached.keys().copied().collect();
                    eprintln!(
                        "rail-hud: the permission to read window titles is gone: detaching {} \
                         table(s)",
                        ids.len()
                    );
                    for id in ids {
                        self.detach(id);
                    }
                    self.refused.clear();
                    self.report_open(out);
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
                    let (id, site, table) = (window.id, window.site, window.table);
                    self.refuse(id, &site, table, reason, out);
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
            attached.format = GameFormat::of_hand(hand.segment.segment.format);
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
                format: GameFormat::Cash,
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
                stack_bb_tenths: seat.stack_bb_tenths,
            })
            .collect();
        Some((hand.hand_key, players))
    }

    fn refuse(
        &mut self,
        id: WindowId,
        site: &str,
        table: Option<String>,
        reason: RefusalReason,
        out: &mut dyn FnMut(HudMessage),
    ) {
        let refused = RefusedTable {
            window: id.0,
            site: site.to_owned(),
            table,
            reason,
        };
        if self.refused.insert(id, refused).is_none() {
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
        let format = attached.format;
        let design = if self.forced.is_some() {
            None
        } else {
            Some(self.designs.resolve(site, Some(size), format))
        };
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
            design,
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
        player_labels: bool,
    ) -> Vec<PanelWords> {
        let allowed = player_labels
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
        let design = self.design_of(id);
        let custom = self.custom_counts(
            &design,
            &site,
            &players,
            segments.as_deref(),
            own_hands_only,
        );
        let window_site = attached_site(&self.attached, id);
        let mut words = self
            .words_of(&window_site, &site, &players, design.panel.player_labels)
            .into_iter();
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
                stats: design.stats.cells_with(
                    &totals.sums(),
                    |key| {
                        custom
                            .get(index)
                            .and_then(|counts| counts.get(key).copied())
                    },
                    player.stack_bb_tenths,
                ),
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
        design: &Compiled,
        site: &str,
        players: &[PlayerRef],
        segments: Option<&[i64]>,
        own_hands_only: bool,
    ) -> Vec<BTreeMap<String, (i64, i64)>> {
        if self.custom_ids.is_empty() || !design.stats.reads_custom() {
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
        let design = self.design_of(id);
        let Some(attached) = self.attached.get(&id) else {
            return;
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
            // The bands the design's statistics use - the user's own where
            // they changed them (R3.9).
            legend: design.stats.legend_tones(),
            design: design.panel.clone(),
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
                // (R3.10) The app's list: the table still open, waiting.
                assert_eq!(
                    report.tables,
                    [AttachedTable {
                        window: 2,
                        site: "pokerstars".into(),
                        table: Some("Florence 03".into()),
                        waiting: true,
                    }]
                );
                assert!(report.refused_tables.is_empty());
                assert!(!report.remote_policy);
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
            // (R3.10) Listed with its reason in every health answer while
            // it is open, for the app's HUD screen.
            assert_eq!(
                hud.health().refused_tables,
                [RefusedTable {
                    window: 4,
                    site: site.into(),
                    table: Some("T".into()),
                    reason,
                }],
                "{site}"
            );
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
        // (R3.10) The app's lists say so: refused, by the remote policy.
        let health = hud.health();
        assert!(health.remote_policy && health.tables.is_empty());
        assert_eq!(
            health.refused_tables,
            [RefusedTable {
                window: 1,
                site: "winamax".into(),
                table: Some("Table A".into()),
                reason: RefusalReason::Prohibited,
            }]
        );
        let mut sent = Vec::new();
        hud.handle(
            Input::App(AppMessage::Policy { remote: None }, Instant::now()),
            &mut |m| sent.push(m),
        );
        assert!(sent.is_empty());
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        let health = hud.health();
        assert!(!health.remote_policy && health.refused_tables.is_empty());
        assert_eq!(health.tables.len(), 1);
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

    /// (R3.11) A backend that needs a permission the user has not granted
    /// (macOS: Accessibility): whether it is granted, and how many times
    /// the system was asked to prompt.
    #[derive(Default)]
    struct Locked {
        granted: std::rc::Rc<std::cell::Cell<bool>>,
        asked: std::rc::Rc<std::cell::Cell<u32>>,
        /// (R3.13) Overlays removed and windows untracked.
        removed: std::rc::Rc<std::cell::Cell<u32>>,
        untracked: std::rc::Rc<std::cell::Cell<u32>>,
    }

    impl Platform for Locked {
        fn name(&self) -> &'static str {
            "locked"
        }
        fn find_tables(
            &mut self,
            _: &[TableMatcher],
        ) -> Result<Vec<TableWindow>, crate::platform::PlatformError> {
            if self.granted.get() {
                Ok(vec![polled_window("T 1 - x", "T 1", None)])
            } else {
                Err(crate::platform::PlatformError::PermissionNeeded(
                    Permission::Accessibility,
                ))
            }
        }
        fn track(&mut self, _: &TableWindow) -> Result<(), crate::platform::PlatformError> {
            Ok(())
        }
        fn untrack(&mut self, _: WindowId) {
            self.untracked.set(self.untracked.get() + 1);
        }
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
        fn remove_overlay(&mut self, _: WindowId) {
            self.removed.set(self.removed.get() + 1);
        }
        fn permission_needed(&self) -> Option<Permission> {
            (!self.granted.get()).then_some(Permission::Accessibility)
        }
        fn request_permission(&mut self, _: Permission) {
            self.asked.set(self.asked.get() + 1);
        }
        /// No poker client: a browser and a terminal.
        fn running_processes(&mut self) -> Option<Vec<String>> {
            Some(vec!["Safari".into(), "Terminal".into()])
        }
    }

    fn locked_hud(backend: Locked) -> Hud {
        Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            Settings::default(),
        )
    }

    fn request(name: &str) -> Input {
        Input::App(
            AppMessage::RequestPermission {
                permission: name.into(),
            },
            Instant::now(),
        )
    }

    /// (R3.11) A missing permission that would find nothing - no running
    /// client of an allowed room with a matcher (none has a macOS one
    /// today), no simulator entry - is not offered: the health answer says
    /// it is deferred (the app shows a neutral line), never needed, and a
    /// request is not passed to the system.
    #[test]
    fn a_missing_permission_without_a_supported_client_is_not_offered() {
        let backend = Locked::default();
        let asked = backend.asked.clone();
        let mut hud = locked_hud(backend);
        assert!(step(&mut hud).is_empty());
        let health = hud.health();
        assert_eq!(health.permission_needed, None);
        assert_eq!(health.permission_deferred.as_deref(), Some("accessibility"));
        hud.handle(request("accessibility"), &mut |_| {});
        assert_eq!(asked.get(), 0, "nothing to gain: not asked");
    }

    /// (R3.11) With the simulator's test entry the permission is offered:
    /// every health answer says it is needed; the system is asked to prompt
    /// only on the app's `request_permission` (the user's click), and only
    /// while it is missing; once granted the next look attaches.
    #[test]
    fn a_missing_permission_is_reported_and_asked_for_on_request() {
        let backend = Locked::default();
        let (granted, asked) = (backend.granted.clone(), backend.asked.clone());
        let mut hud = locked_hud(backend);
        hud.add_simulator_room(
            "pokerstars",
            regex::Regex::new("^(?P<table>.+) - ").expect("regex"),
        );
        assert!(step(&mut hud).is_empty());
        assert!(step(&mut hud).is_empty());
        assert_eq!(asked.get(), 0, "never prompted unattended");
        assert_eq!(
            hud.health().permission_needed.as_deref(),
            Some("accessibility")
        );
        assert_eq!(hud.health().permission_deferred, None);
        assert_eq!(hud.health().attached, 0);

        hud.handle(request("screen-recording"), &mut |_| {});
        assert_eq!(asked.get(), 0, "no such permission");
        hud.handle(request("accessibility"), &mut |_| {});
        assert_eq!(asked.get(), 1);

        granted.set(true);
        assert_eq!(hud.health().permission_needed, None);
        assert_eq!(hud.health().permission_deferred, None);
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        hud.handle(request("accessibility"), &mut |_| {});
        assert_eq!(asked.get(), 1, "not asked once granted");
    }

    /// (R3.13) The permission taken away while a table is attached (the
    /// system's "API disabled" from every accessibility call, here the
    /// backend's `PermissionNeeded`): the table is detached and its overlay
    /// removed at the next look, the app hears no table is open, the
    /// health answer says the permission is needed (a client is attached -
    /// it would matter) and nothing prompts; granted again, the next look
    /// attaches.
    #[test]
    fn a_revoked_permission_detaches_every_table() {
        let backend = Locked::default();
        let (granted, asked) = (backend.granted.clone(), backend.asked.clone());
        let (removed, untracked) = (backend.removed.clone(), backend.untracked.clone());
        granted.set(true);
        let mut hud = locked_hud(backend);
        hud.add_simulator_room(
            "pokerstars",
            regex::Regex::new("^(?P<table>.+) - ").expect("regex"),
        );
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        assert_eq!(hud.health().attached, 1);

        granted.set(false);
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 0 }]);
        assert_eq!(hud.health().attached, 0);
        assert_eq!((removed.get(), untracked.get()), (1, 1), "overlay gone");
        assert_eq!(
            hud.health().permission_needed.as_deref(),
            Some("accessibility")
        );
        assert_eq!(asked.get(), 0, "never prompted unattended");
        // Still revoked: nothing more to detach, nothing said.
        assert!(step(&mut hud).is_empty());
        assert_eq!(removed.get(), 1);

        granted.set(true);
        assert_eq!(step(&mut hud), [HudMessage::TablesOpen { count: 1 }]);
        assert_eq!(hud.health().permission_needed, None);
    }

    /// A backend with hooks (Windows since R3.5): its events, and how many
    /// times it was asked to find.
    #[derive(Default)]
    struct Hooked {
        windows: std::rc::Rc<std::cell::RefCell<Vec<TableWindow>>>,
        events: std::rc::Rc<std::cell::RefCell<Vec<TableEvent>>>,
        finds: std::rc::Rc<std::cell::Cell<u32>>,
        followed: std::rc::Rc<std::cell::RefCell<Vec<crate::platform::Rect>>>,
        /// (R3.14) What `notified` answers.
        notified: std::rc::Rc<std::cell::Cell<bool>>,
    }

    impl Platform for Hooked {
        fn name(&self) -> &'static str {
            "hooked"
        }
        fn notified(&self) -> bool {
            self.notified.get()
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

    /// (R3.14) While the backend's notifications follow every table the
    /// periodic look slows to `find_every_notified`; once one is not
    /// followed it is back at `find_every`; the perf report says which.
    #[test]
    fn the_look_slows_while_notifications_follow_every_table() {
        let backend = Hooked::default();
        let (windows, finds, notified) = (
            backend.windows.clone(),
            backend.finds.clone(),
            backend.notified.clone(),
        );
        windows
            .borrow_mut()
            .push(polled_window("T 1 - x", "T 1", Some(6)));
        let settings = Settings::default();
        assert!(settings.find_every_notified > settings.find_every);
        let mut hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(None),
            settings,
        );
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        hud.tick(start, &mut |_| {});
        assert_eq!(finds.get(), 1);
        notified.set(true);
        hud.tick(at(500), &mut |_| {});
        assert_eq!(finds.get(), 2, "the period was the usual one");
        assert_eq!(hud.perf()["findEveryMs"], 2000);
        assert_eq!(hud.perf()["notified"], true);
        hud.tick(at(1500), &mut |_| {});
        assert_eq!(finds.get(), 2, "slower now");
        hud.tick(at(2500), &mut |_| {});
        assert_eq!(finds.get(), 3);
        // A hand no window takes still looks at once.
        hud.handle(hand("pokerstars", "T 9", "Al"), &mut |_| {});
        hud.tick(at(2600), &mut |_| {});
        assert_eq!(finds.get(), 4, "looked at once");
        notified.set(false);
        hud.tick(at(4600), &mut |_| {});
        assert_eq!(finds.get(), 5);
        hud.tick(at(5100), &mut |_| {});
        assert_eq!(finds.get(), 6, "back at the usual period");
        let perf = hud.perf();
        assert_eq!(perf["findEveryMs"], 500);
        assert_eq!(perf["finds"], 6);
        assert_eq!(perf["attached"], 1);
        assert_eq!(perf["paint"]["count"], 0, "this backend paints nothing");
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
            crate::panel::PanelStats::new(&PanelDesign::default()).legend_tones()
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
                // Nothing assigned: a cash table's preset.
                design: Some("cash".into()),
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

    /// (R3.9) The design assigned in the store reaches every table's frame
    /// and the room's rules cut it down when it is laid out: a user's design
    /// for every room - two columns, a card-split statistic of the user's,
    /// a cell shown below 20 big blinds - draws all of it on ACR (the cell
    /// by stack depth for the short stack only), no stack cell on Winamax,
    /// and neither on PokerStars; cleared, the cash preset again. The
    /// user's bands colour the legend.
    #[test]
    fn designs_follow_the_assignments() {
        use rail_config::stats::{Band, Format, Group, HudPlace, Players, SampleDef, Text, Unit};
        let words = |s: &str| Text {
            en: s.into(),
            hr: s.into(),
        };
        let pairs = CustomDef {
            def: rail_config::stats::StatDef {
                id: "pair_raise".into(),
                group: Group::Preflop,
                players: Players::Any,
                label: words("PR"),
                name: words("Pairs raised"),
                description: words("made up"),
                formula: "pct(pair_raise, pair_raise_opp)".into(),
                format: Format {
                    unit: Unit::Percent,
                    decimals: 1,
                },
                sample: SampleDef { of: None, min: 10 },
                bands: Vec::new(),
                hud: HudPlace::None,
            },
            predicate: Some("first street = preflop and pocket_pair => action = raise".into()),
        };
        let mut design = crate::design::Presets::shipped()
            .get("cash")
            .expect("cash")
            .design
            .clone();
        design.name = "Mine".into();
        design.columns = 2;
        design.cells = vec![
            crate::design::Cell {
                stat: "vpip".into(),
                when: None,
            },
            crate::design::Cell {
                stat: "pfr".into(),
                when: None,
            },
            crate::design::Cell {
                stat: "pair_raise".into(),
                when: None,
            },
            crate::design::Cell {
                stat: "steal".into(),
                when: Some(crate::design::StackWhen {
                    below_bb: Some(20),
                    at_least_bb: None,
                }),
            },
        ];
        design.max_colour_thresholds = None;
        design.overrides.insert(
            "vpip".into(),
            crate::design::StatOverride {
                bands: Some(vec![
                    Band {
                        below: Some(25.0),
                        tone: rail_config::stats::Tone::Low,
                    },
                    Band {
                        below: None,
                        tone: rail_config::stats::Tone::High,
                    },
                ]),
                ..crate::design::StatOverride::default()
            },
        );
        let json = design.to_json();
        let (path, dir) = store_with("designs", move |writer| {
            writer
                .write(move |tx| rail_store::custom::save_custom_stat(tx, None, &pairs, 1))
                .expect("a user's statistic");
            writer.save_hud_layout("d-mine", &json).expect("design");
            writer
                .set_hud_layout_assignment("*", 0, "*", Some("d-mine"))
                .expect("assigned");
        });
        let backend = Drawn::default();
        let (windows, frames) = (backend.windows.clone(), backend.frames.clone());
        let sites = ["acr", "winamax", "pokerstars"];
        for (n, site) in (1_u64..).zip(sites) {
            let mut window = polled_window(&format!("{site} 1 - x"), &format!("{site} 1"), Some(6));
            window.id = WindowId(n);
            window.site = site.into();
            windows.borrow_mut().push(window);
        }
        let mut hud = Hud::new(
            Box::new(backend),
            Compliance::shipped().expect("shipped"),
            StoreView::new(Some(path.clone())),
            Settings::default(),
        );
        step(&mut hud);
        for site in sites {
            let store_site = if site == "acr" { "acrwpn" } else { site };
            let mut hand = seated(store_site, &format!("{site} 1"), site, Some(1), &[1, 2]);
            if let Input::App(AppMessage::HandImported { players, .. }, _) = &mut hand {
                players[0].stack_bb_tenths = Some(150);
                players[1].stack_bb_tenths = Some(800);
            }
            hud.handle(hand, &mut |_| {});
        }
        let shown = |id: u64| {
            let frames = frames.borrow();
            let frame = frames.get(&WindowId(id)).expect("a frame");
            let scene = crate::scene::compose(frame, 800, 550, 1000, &frame.design);
            let mut cells = scene.seat_cells.clone();
            cells.sort();
            (frame.design.columns, cells, frame.legend.clone())
        };
        let ids = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        // ACR: everything; the steal cell beside the 15 bb stack only.
        let (columns, cells, legend) = shown(1);
        assert_eq!(columns, Some(2));
        assert_eq!(
            cells,
            [
                (0, ids(&["vpip", "pfr", "pair_raise", "steal"])),
                (1, ids(&["vpip", "pfr", "pair_raise"])),
            ]
        );
        assert!(legend.contains(&rail_config::stats::Tone::Low));
        // Winamax: no switching by game state.
        assert_eq!(
            shown(2).1,
            [
                (0, ids(&["vpip", "pfr", "pair_raise"])),
                (1, ids(&["vpip", "pfr", "pair_raise"])),
            ]
        );
        // PokerStars: no card-split statistic either.
        assert_eq!(
            shown(3).1,
            [(0, ids(&["vpip", "pfr"])), (1, ids(&["vpip", "pfr"]))]
        );

        // Cleared: the cash preset (R3.4's six statistics) on every table.
        let app = rail_store::Store::open(&path).expect("the app's store");
        app.writer()
            .expect("writer")
            .set_hud_layout_assignment("*", 0, "*", None)
            .expect("cleared");
        hud.handle(
            Input::App(AppMessage::LayoutChanged, Instant::now()),
            &mut |_| {},
        );
        let six = ids(&[
            "vpip",
            "pfr",
            "three_bet",
            "fold_to_three_bet",
            "cbet_flop",
            "aggression_frequency",
        ]);
        for id in 1..=3 {
            let (columns, cells, _) = shown(id);
            assert_eq!(columns, Some(3));
            assert_eq!(cells, [(0, six.clone()), (1, six.clone())], "window {id}");
        }
        drop(app);
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
