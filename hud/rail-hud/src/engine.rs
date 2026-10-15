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
//! - `stats_changed` and `resync` re-read every attached table; so does the
//!   store's own `data_version` moving without a message (checked every
//!   [`Settings::store_every`]): the HUD keeps drawing from the store when
//!   the app is busy.
//! - `policy` merges the app's remote `sites.json`; tables whose room is no
//!   longer allowed are detached at once.
//! - `shutdown`, the connection closing or standard input ending (the app is
//!   gone) end the loop; the overlays are removed.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use rail_hud_ipc::protocol::{
    AppMessage, HealthReport, HudMessage, PlayerHands, PlayerRef, RefusalReason,
};

use crate::compliance::Compliance;
use crate::data::StoreView;
use crate::latency::{Latencies, micros};
use crate::panel::{PanelDesign, PanelStats};
use crate::platform::{
    OverlayFrame, Platform, SeatPanel, TableEvent, TableMatcher, TableWindow, WindowId, table_key,
};

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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            tick: Duration::from_millis(50),
            find_every: Duration::from_millis(500),
            store_every: Duration::from_secs(2),
        }
    }
}

/// Tables whose last announced hand is remembered.
const RECENT_TABLES: usize = 256;

/// Shown before a table's first hand (§3.3).
pub const WAITING: &str = "waiting for first hand";

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
    /// The panel's statistics (the default design's, R3.4).
    panel_stats: PanelStats,
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
            panel_stats: PanelStats::new(&PanelDesign::default()),
        }
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
                        }
                        self.fill_seats(id, &hand_key);
                        self.reread(id, Some(&hand_key), at, out);
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
            }
            AppMessage::Health { seq } => out(HudMessage::Health {
                seq,
                report: self.health(),
            }),
            AppMessage::LayoutChanged | AppMessage::SettingsChanged => {
                // Layouts (R3.6) and settings (R3.9) are not read yet.
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

    /// A window whose title gives no seats takes the table size of its
    /// hand (`hands.max_seats`).
    fn fill_seats(&mut self, id: WindowId, hand_key: &str) {
        let wanted = self
            .attached
            .get(&id)
            .is_some_and(|a| a.title_seats.is_none());
        if !wanted {
            return;
        }
        if let Some(seats) = self.store.hand_seats(hand_key)
            && let Some(attached) = self.attached.get_mut(&id)
        {
            attached.window.size = Some(seats);
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
        let Some((hand_key, players)) = self.recent.get(&(site, table)).cloned() else {
            return;
        };
        if let Some(attached) = self.attached.get_mut(&id) {
            attached.players = players;
        }
        self.fill_seats(id, &hand_key);
        self.reread(id, Some(&hand_key), Instant::now(), out);
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
                            // A tournament table move: other players.
                            a.window.table = table;
                            a.players.clear();
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
            }
        }
        self.report_open(out);
    }

    fn reread_all(&mut self, since: Instant, out: &mut dyn FnMut(HudMessage)) {
        let ids: Vec<WindowId> = self.attached.keys().copied().collect();
        for id in ids {
            self.reread(id, None, since, out);
        }
    }

    /// Read the table's players' rollups again and redraw it.
    fn reread(
        &mut self,
        id: WindowId,
        hand_key: Option<&str>,
        since: Instant,
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
        let keys: Vec<(&str, &str)> = players
            .iter()
            .map(|p| (p.name.as_str(), p.scope.as_str()))
            .collect();
        let totals = match self.store.totals(&site, &keys) {
            Ok(totals) => totals,
            Err(error) => {
                self.draw(id, Some(format!("no statistics: {error}")), Vec::new());
                return;
            }
        };
        let elapsed = since.elapsed();
        self.latencies.record(elapsed);
        let panels: Vec<SeatPanel> = players
            .iter()
            .zip(&totals)
            .map(|(player, totals)| SeatPanel {
                player: player.name.clone(),
                seat: player.seat,
                hands: totals.hands(),
                stats: self.panel_stats.cells(&totals.sums()),
                label: None,
            })
            .collect();
        out(HudMessage::TableUpdated {
            window: id.0,
            site,
            table: self.attached.get(&id).and_then(|a| a.window.table.clone()),
            hand_key: hand_key.map(str::to_owned),
            players: panels
                .iter()
                .map(|p| PlayerHands {
                    name: p.player.clone(),
                    hands: p.hands,
                })
                .collect(),
            reread_us: micros(elapsed),
        });
        self.draw(id, None, panels);
    }

    /// Show a status line or panels over an attached window. Compliance is
    /// asked again here (guideline §7, R3.4): no frame - and so nothing
    /// drawn - without its permit for the window's room; a window that has
    /// lost it loses its overlay.
    fn draw(&mut self, id: WindowId, status: Option<String>, panels: Vec<SeatPanel>) {
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
        let frame = OverlayFrame {
            permit,
            status,
            size: attached.window.size,
            panels,
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
