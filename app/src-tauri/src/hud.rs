//! The HUD process (`rail-hud`, docs/RAIL-PLAN.md §3.2, R3.2) from the app's
//! side: started in `setup` before the watcher, supervised by
//! `rail_hud_ipc::supervisor` (restarted with a backoff when it dies or
//! stops answering), stopped first on exit.
//!
//! - **The binary** is the app's Tauri sidecar (`bundle.externalBin` in
//!   `tauri.hud.conf.json`): next to the app's own executable - in
//!   `Rail.app/Contents/MacOS/` on macOS, beside `Rail.exe` on Windows, in
//!   `target/<profile>/` in development (`cargo build -p rail-hud`). Not
//!   there: the status says so. `RAIL_HUD=off` in the environment does not
//!   start it at all.
//! - **What it hears**: `hand_imported` for the newest hands of every file
//!   an import added to ([`HudFeed`], a thread of its own with its own
//!   read-only connection - the watcher's callback only queues the file),
//!   with the hand's timing (R3.7: when the watcher noticed the file, when
//!   the commit was reported, when it was sent - the HUD completes the
//!   latency chain and reports it in `table_updated`),
//!   `stats_changed` when a recompute swaps (from `stats::spawn_refresher`),
//!   `shutdown` on exit. Nothing here ever waits for the HUD: every send is
//!   queued or dropped.
//! - **What it says**: `tables_open` pauses the statistics pass's heavy
//!   parts and lowers sync's bandwidth while any table is attached
//!   (`StatsWorker::set_tables_open`, `SyncWorker::set_tables_open`); when
//!   the HUD goes away the tables count as closed. `attach_refused` is
//!   logged and listed; (R3.10) every health answer brings the tables
//!   attached and the windows refused (with why), which [`hud_status`]
//!   gives the HUD screen and Today, and the tray's HUD line follows;
//!   `open_in_app` shows the window and emits [`OPEN_PLAYER_EVENT`];
//!   (R3.8) `open_popup` (a click on a panel) opens the HUD popup
//!   (`crate::popup`), and the window hears [`TABLES_OPEN_EVENT`] on the
//!   edges of `tables_open` - while tables are open it hides its analysis
//!   (A10), and the popup closes when the last table does;
//!   `seat_position_changed` (R3.6: the user dragged a panel) is written to
//!   the store by a thread of its own ([`LayoutWrites`]) - the HUD's
//!   connection is read-only, and the supervisor's callback never waits for
//!   a commit.
//! - **The user's HUD settings** (R3.6): [`hud_set_preferred_seat`] (their
//!   client rotates the table on a room, or not, or as `sites.json` says)
//!   and [`hud_reset_seat_positions`] write the store and tell the HUD
//!   (`settings_changed`, `layout_changed`), which reads them again.
//! - **Permissions** (R3.11, macOS): the HUD reads window titles through
//!   the Accessibility API, and every health answer says when that
//!   permission is missing *and would make a difference* - a supported
//!   client (an allowed room with a macOS matcher) is running, or the
//!   simulator's test entry is on (`permission_needed`) - or is missing
//!   with nothing to gain (`permission_deferred`). [`hud_status`] passes
//!   both on: the HUD screen explains and offers the first; for the second
//!   it, Today and the tray say only that no supported client is running,
//!   and ask for nothing. The
//!   permission's TCC entry is the *responsible* process's - Rail.app,
//!   which starts the sidecar - so it is granted to Rail, keyed by its
//!   code signature: an ad-hoc signed build (development, CI) is a new
//!   identity with every build and has to be granted again, a Developer ID
//!   signed release (P3) keeps the grant across updates. Only the user's
//!   click ([`hud_request_permission`]) makes the HUD ask macOS for its
//!   prompt and opens System Settings at the pane; nothing here changes a
//!   setting.
//! - **Policy** (R3.10, `crate::policy`): the HUD is started with
//!   `--policy <the cached remote sites.json>` (read before its first look
//!   for tables), and hears `policy {remote}` on every connection and every
//!   change - stricter only, merged by the HUD itself.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rail_hud_ipc::protocol::{
    AppMessage, AttachedTable, HandTiming, HealthReport, HudMessage, PlayerRef, RefusalReason,
};
use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::StoreState;
use crate::stats::StatsState;
use crate::sync::SyncSlot;

/// The window event for "show this player" from a HUD popup (R3.8); the
/// payload is `{site, name, scope}`.
pub const OPEN_PLAYER_EVENT: &str = "hud-open-player";

/// (R3.8, A10) The window event on the edges of the HUD's `tables_open`:
/// the payload is whether any table is open now. While one is, the window
/// hides its analysis (guideline §7: no help during play).
pub const TABLES_OPEN_EVENT: &str = "hud-tables-open";

/// The environment variable that keeps the HUD from starting (`off`).
pub const DISABLE_VAR: &str = "RAIL_HUD";

/// Hands per import told to the HUD: it needs a table's newest hand (its
/// players); the rollups it reads count every hand.
const HANDS_PER_IMPORT: u32 = 10;

/// Imports waiting for the feeder; more are dropped (a backfill's flood -
/// the HUD's own store check catches up).
const FEED_QUEUE: usize = 256;

/// Windows refused that the status keeps.
const REFUSED_KEPT: usize = 32;

/// The window event when the HUD's tables or refusals changed (R3.10; no
/// payload: the window asks [`hud_status`] again).
pub const STATUS_EVENT: &str = "hud-status-changed";

/// Dragged panels waiting for the store (R3.6); more are dropped (a drag is
/// a user's hand on the mouse - this never fills).
const LAYOUT_QUEUE: usize = 64;

/// The binary next to the app's own.
fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(
        exe.parent()?
            .join(format!("rail-hud{}", std::env::consts::EXE_SUFFIX)),
    )
}

/// A window compliance mode refused, for the status.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefusedDto {
    pub site: String,
    pub window: u64,
    /// (R3.10) The table name from the window's title, once a health answer
    /// has listed it.
    pub table: Option<String>,
    pub reason: RefusalReason,
}

/// (R3.10) A table the HUD is attached to, for the status.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDto {
    pub site: String,
    pub window: u64,
    pub table: Option<String>,
    /// Still "waiting for first hand".
    pub waiting: bool,
}

/// What the HUD last said about its windows (R3.10).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Windows {
    attached: Vec<TableDto>,
    /// The windows refused that are still open: the health answer's list,
    /// with each `attach_refused` heard since added at once.
    refused: Vec<RefusedDto>,
    remote_policy: bool,
    /// (R3.11) A permission the HUD needs and does not have, and granting
    /// it would find tables now (`accessibility` on macOS).
    permission_needed: Option<String>,
    /// (R3.11) Missing too, but no supported client runs: ask nothing.
    permission_deferred: Option<String>,
}

impl Windows {
    /// The HUD's own lists, from a health answer.
    fn from_health(report: &HealthReport) -> Self {
        Self {
            attached: report
                .tables
                .iter()
                .map(|t: &AttachedTable| TableDto {
                    site: t.site.clone(),
                    window: t.window,
                    table: t.table.clone(),
                    waiting: t.waiting,
                })
                .collect(),
            refused: report
                .refused_tables
                .iter()
                .map(|r| RefusedDto {
                    site: r.site.clone(),
                    window: r.window,
                    table: r.table.clone(),
                    reason: r.reason,
                })
                .collect(),
            remote_policy: report.remote_policy,
            permission_needed: report.permission_needed.clone(),
            permission_deferred: report.permission_deferred.clone(),
        }
    }

    /// An `attach_refused`: listed now, before the next health answer.
    fn refused(&mut self, refused: RefusedDto) {
        self.attached.retain(|t| t.window != refused.window);
        match self.refused.iter_mut().find(|r| r.window == refused.window) {
            Some(known) => {
                known.site = refused.site;
                known.reason = refused.reason;
            }
            None => self.refused.push(refused),
        }
        let excess = self.refused.len().saturating_sub(REFUSED_KEPT);
        self.refused.drain(..excess);
    }
}

#[derive(Debug, Default)]
struct Shared {
    tables_open: AtomicU32,
    windows: Mutex<Windows>,
}

impl Shared {
    fn windows(&self) -> std::sync::MutexGuard<'_, Windows> {
        self.windows.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Now, in Unix microseconds (the latency chain's clock, R3.7).
fn unix_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

/// An import the feeder tells the HUD about.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fed {
    path: PathBuf,
    inserted: u32,
    /// (R3.7) The hand's way through the app so far: the watcher's notice
    /// and the commit's report.
    timing: HandTiming,
}

/// Where the watcher's callback drops a file that got new hands.
#[derive(Debug, Clone, Default)]
pub struct HudFeed(Option<SyncSender<Fed>>);

impl HudFeed {
    /// `inserted` new hands were stored from `path` (the watcher noticed the
    /// change at `noticed_ms`, Unix ms); never waits.
    pub fn imported(&self, path: &std::path::Path, inserted: u32, noticed_ms: Option<i64>) {
        let fed = Fed {
            path: path.to_owned(),
            inserted,
            timing: HandTiming {
                noticed_us: noticed_ms.map(|ms| ms.saturating_mul(1000)),
                imported_us: Some(unix_us()),
                sent_us: None,
            },
        };
        if let Some(tx) = &self.0
            && let Err(TrySendError::Disconnected(_)) = tx.try_send(fed)
        {
            log::debug!("hud: the feeder is gone");
        }
    }
}

/// A panel the user dragged, for the store (R3.6).
#[derive(Debug, Clone, PartialEq, Eq)]
struct SeatWrite {
    site: String,
    size: u32,
    slot: u32,
    x: u32,
    y: u32,
}

/// Where the supervisor's callback drops a dragged panel's position: a
/// thread of its own writes it (`hud_seat_positions`), so the callback
/// never waits for a commit.
#[derive(Debug, Clone, Default)]
pub struct LayoutWrites(Option<SyncSender<SeatWrite>>);

impl LayoutWrites {
    /// The writer thread over the store's writer; (R3.9) each position
    /// written wakes the sync worker, so the drag reaches the account's
    /// other computers without waiting for another event here.
    fn start(writer: rail_store::WriterHandle, sync: SyncSlot) -> Self {
        let (tx, rx) = mpsc::sync_channel::<SeatWrite>(LAYOUT_QUEUE);
        let spawned = std::thread::Builder::new()
            .name("rail-hud-layouts".to_owned())
            .spawn(move || {
                while let Ok(write) = rx.recv() {
                    match writer.set_hud_seat_position(
                        &write.site,
                        write.size,
                        write.slot,
                        write.x,
                        write.y,
                    ) {
                        Ok(()) => {
                            log::info!(
                                "hud: {} {}-seat panel {} now at ({}, {})",
                                write.site,
                                write.size,
                                write.slot,
                                write.x,
                                write.y
                            );
                            if let Some(worker) = sync.get() {
                                worker.wake();
                            }
                        }
                        Err(error) => log::warn!("hud: a panel position was not kept: {error}"),
                    }
                }
            });
        match spawned {
            Ok(_) => Self(Some(tx)),
            Err(error) => {
                log::error!("hud: layout thread: {error}");
                Self(None)
            }
        }
    }

    /// Queue one; never waits.
    fn queue(&self, write: SeatWrite) {
        if let Some(tx) = &self.0
            && tx.try_send(write).is_err()
        {
            log::warn!("hud: a panel position was dropped");
        }
    }
}

/// Where the supervisor is once it started (R6.4: it may start after the
/// app did, when the plan allows the HUD); the feeder looks here.
type SupervisorSlot = Arc<OnceLock<Arc<Supervisor>>>;

/// (R6.4) What starting the HUD needs, kept until the plan allows it.
struct Pending {
    config: SupervisorConfig,
    on_event: Box<dyn Fn(Event) + Send + Sync>,
}

impl std::fmt::Debug for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pending").finish_non_exhaustive()
    }
}

/// The HUD, as app state.
#[derive(Debug)]
pub struct HudState {
    supervisor: SupervisorSlot,
    /// (R6.4) Not started yet: what it takes. Taken by the first
    /// [`HudState::apply_plan`] that allows the HUD.
    pending: Mutex<Option<Pending>>,
    /// (R6.4) The plan held the start back (enforcement on, no Pro).
    locked: AtomicBool,
    error: Mutex<Option<String>>,
    shared: Arc<Shared>,
    feed: HudFeed,
    sync: SyncSlot,
}

impl HudState {
    /// Prepare the HUD (unless switched off or there is no store). It
    /// starts at the first [`HudState::apply_plan`] that allows it (R6.4):
    /// at once while enforcement is off, as today.
    pub fn start<R: Runtime>(
        app: &AppHandle<R>,
        store: &StoreState,
        stats: StatsState,
        sync: SyncSlot,
        policy_file: Option<PathBuf>,
    ) -> Self {
        let shared = Arc::new(Shared::default());
        let off = |error: String| Self {
            supervisor: SupervisorSlot::default(),
            pending: Mutex::new(None),
            locked: AtomicBool::new(false),
            error: Mutex::new(Some(error)),
            shared: Arc::clone(&shared),
            feed: HudFeed::default(),
            sync: Arc::clone(&sync),
        };
        if std::env::var(DISABLE_VAR).is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
            log::info!("hud: switched off ({DISABLE_VAR}=off)");
            return off(format!("switched off ({DISABLE_VAR}=off)"));
        }
        if store.store.is_none() {
            return off("the store is not open".to_owned());
        }
        let Some(program) = sidecar_path() else {
            return off("the app's own path is not known".to_owned());
        };
        let mut config = SupervisorConfig::new(program);
        config.args = vec!["--store".into(), store.path.clone().into_os_string()];
        // (R3.10) The cached remote sites.json, read before the HUD's first
        // look for tables.
        if let Some(file) = policy_file {
            config.args.push("--policy".into());
            config.args.push(file.into_os_string());
        }
        let layouts = match store.store.as_ref().map(rail_store::Store::writer) {
            Some(Ok(writer)) => LayoutWrites::start(writer, Arc::clone(&sync)),
            _ => LayoutWrites::default(),
        };

        let on_event = {
            let app = app.clone();
            let shared = Arc::clone(&shared);
            let sync = Arc::clone(&sync);
            move |event: Event| on_event(&app, &shared, &stats, &sync, &layouts, event)
        };
        let supervisor = SupervisorSlot::default();
        let feed = start_feeder(&store.path, Arc::clone(&supervisor));
        Self {
            supervisor,
            pending: Mutex::new(Some(Pending {
                config,
                on_event: Box::new(on_event),
            })),
            locked: AtomicBool::new(false),
            error: Mutex::new(None),
            shared,
            feed,
            sync,
        }
    }

    fn supervisor(&self) -> Option<&Arc<Supervisor>> {
        self.supervisor.get()
    }

    /// (R6.4) The plan's word on the HUD (`crate::entitlements`), on every
    /// change of it. Allowed: the HUD starts if it has not. Not allowed: a
    /// HUD not started stays so (the screen shows the lock); **one already
    /// running is never stopped** - a session at the tables is not cut
    /// mid-hand; the plan applies from the app's next start.
    pub fn apply_plan(&self, allowed: bool) {
        if self.supervisor().is_some() {
            if !allowed {
                log::info!("hud: the plan no longer includes the HUD; it stops at the next start");
            }
            return;
        }
        self.locked.store(!allowed, Ordering::SeqCst);
        if !allowed {
            return;
        }
        let Some(pending) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        else {
            return;
        };
        let Pending { config, on_event } = pending;
        match Supervisor::start(config, on_event) {
            Ok(supervisor) => {
                let _ = self.supervisor.set(Arc::new(supervisor));
                // The sync worker may have started first.
                self.sync_started();
            }
            Err(error) => {
                log::error!("hud: the supervisor did not start: {error}");
                *self.error.lock().unwrap_or_else(PoisonError::into_inner) =
                    Some(error.to_string());
            }
        }
    }

    /// The handle the watcher's callback uses.
    pub fn feed(&self) -> HudFeed {
        self.feed.clone()
    }

    /// The sync worker exists now (it starts after the HUD): tell it
    /// whether tables are open already.
    pub fn sync_started(&self) {
        if self.shared.tables_open.load(Ordering::SeqCst) > 0
            && let Some(worker) = self.sync.get()
        {
            worker.set_tables_open(true);
        }
    }

    /// A recompute swapped new statistics in.
    pub fn stats_changed(&self, epoch: i64) {
        if let Some(supervisor) = self.supervisor() {
            supervisor.send(AppMessage::StatsChanged { epoch });
        }
    }

    /// The user changed a HUD setting (R3.6: the preferred seat): the HUD
    /// reads them again.
    pub fn settings_changed(&self) {
        if let Some(supervisor) = self.supervisor() {
            supervisor.send(AppMessage::SettingsChanged);
        }
    }

    /// The user's panel positions changed outside the HUD (a reset): the
    /// HUD reads them again.
    pub fn layout_changed(&self) {
        if let Some(supervisor) = self.supervisor() {
            supervisor.send(AppMessage::LayoutChanged);
        }
    }

    /// (R3.9) The editor wrote designs, assignments or panel positions: the
    /// HUD reads them again, and the sync worker sends them now.
    pub fn layouts_written(&self) {
        self.layout_changed();
        self.wake_sync();
    }

    /// (R3.9) The user's per-room settings were written: the HUD reads them
    /// again, and the sync worker sends them now.
    pub fn settings_written(&self) {
        self.settings_changed();
        self.wake_sync();
    }

    fn wake_sync(&self) {
        if let Some(worker) = self.sync.get() {
            worker.wake();
        }
    }

    /// (R3.10) A new policy is in force: the HUD merges it (stricter only)
    /// and detaches what it no longer allows.
    pub fn policy_changed(&self, remote: Option<String>) {
        if let Some(supervisor) = self.supervisor() {
            supervisor.send(AppMessage::Policy { remote });
        }
    }

    /// (R3.11) The user clicked to grant a permission the HUD reported
    /// missing: the HUD asks the system for its own prompt (macOS: it also
    /// lists Rail in System Settings, switched off). Whether it was sent.
    pub fn request_permission(&self, permission: &str) -> bool {
        match self.supervisor() {
            Some(supervisor) => supervisor.send(AppMessage::RequestPermission {
                permission: permission.to_owned(),
            }),
            None => false,
        }
    }

    /// (R5.4, A10) The poker tables the HUD has open now: the analysis does
    /// not run while there is one.
    pub fn tables_open(&self) -> u32 {
        self.shared.tables_open.load(Ordering::SeqCst)
    }

    /// Shut the HUD down (on exit, first).
    pub fn stop(&self) {
        if let Some(supervisor) = self.supervisor() {
            supervisor.stop();
            log::info!("hud: stopped");
        }
    }

    pub fn status(&self) -> HudStatusDto {
        let windows = self.shared.windows().clone();
        let tables_open = self.shared.tables_open.load(Ordering::SeqCst);
        let Some(supervisor) = self.supervisor() else {
            let error = self
                .error
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let waiting = error.is_none()
                && self
                    .pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .is_some();
            // (R6.4) Held by the plan, or about to start (the plan is read
            // right after the account, a moment into the app's start).
            let phase = match (waiting, self.locked.load(Ordering::SeqCst)) {
                (true, true) => "locked",
                (true, false) => "starting",
                _ => "off",
            };
            return HudStatusDto {
                phase,
                error,
                tables_open,
                ..HudStatusDto::default()
            };
        };
        let status = supervisor.status();
        let health = status.health.unwrap_or_default();
        HudStatusDto {
            phase: status.phase.as_str(),
            error: None,
            pid: status.pid,
            starts: status.starts,
            last_exit: status.last_exit,
            tables_open,
            tables: windows.attached,
            refused: windows.refused,
            remote_policy: windows.remote_policy,
            permission_needed: windows.permission_needed,
            permission_deferred: windows.permission_deferred,
            store_open: health.store_open,
            platform: (!health.platform.is_empty()).then_some(health.platform),
            reread_p50_us: health.reread.p50_us,
            reread_p95_us: health.reread.p95_us,
            tables_waiting: health.waiting,
            health_age_ms: status
                .health_age
                .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX)),
            dropped: status.dropped,
        }
    }
}

/// The HUD's table count; on its edges (none -> some -> none) the
/// statistics pass and sync hear it. Returns whether it was an edge.
fn set_tables_open(shared: &Shared, stats: &StatsState, sync: &SyncSlot, count: u32) -> bool {
    let before = shared.tables_open.swap(count, Ordering::SeqCst);
    let edge = (before > 0) != (count > 0);
    if edge {
        let open = count > 0;
        log::info!("hud: tables {}", if open { "open" } else { "closed" });
        stats.set_tables_open(open);
        if let Some(worker) = sync.get() {
            worker.set_tables_open(open);
        }
    }
    edge
}

/// (R3.8) The window hears an edge of `tables_open` (A10); with no table
/// open the popup closes.
fn tables_edge<R: Runtime>(app: &AppHandle<R>, open: bool) {
    if let Err(error) = app.emit(TABLES_OPEN_EVENT, open) {
        log::debug!("{TABLES_OPEN_EVENT}: {error}");
    }
    if !open {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(state) = handle.try_state::<crate::popup::PopupState>() {
                crate::popup::close(&handle, &state);
            }
        });
    }
}

/// (R3.10) The window hears that the tables or refusals changed.
fn status_changed<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.emit(STATUS_EVENT, ()) {
        log::debug!("{STATUS_EVENT}: {error}");
    }
}

/// (R3.10) The tray's HUD line: off, no table, tables attached, windows
/// refused.
pub fn tray_line(status: &HudStatusDto) -> String {
    let text = crate::strings::tray();
    match status.phase {
        "off" | "not-installed" | "stopped" => text.hud_off.to_owned(),
        // (R6.4) The plan held it back.
        "locked" => text.hud_locked.to_owned(),
        "starting" | "backoff" => text.hud_starting.to_owned(),
        // (R3.11) It runs but cannot see a table until the user grants it.
        _ if status.permission_needed.is_some() && status.tables_open == 0 => {
            text.hud_permission.to_owned()
        }
        // Nothing to gain from the permission now: a neutral line, no ask.
        _ if status.permission_deferred.is_some() && status.tables_open == 0 => {
            text.hud_no_client.to_owned()
        }
        _ => (text.hud_tables)(status.tables_open, count(status.refused.len())),
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Set the tray's HUD line from the status.
pub fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    let Some(hud) = app.try_state::<HudState>() else {
        return;
    };
    if let Err(error) = crate::tray::set_hud(app, &tray_line(&hud.status())) {
        log::debug!("tray HUD line: {error}");
    }
}

/// The tray's HUD line follows the HUD's phase too (starting, not
/// installed, backoff), which no event announces: looked at every 2 s,
/// set when it changed.
pub fn spawn_tray_refresher<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("rail-tray-hud".to_owned())
        .spawn(move || {
            let mut last = String::new();
            loop {
                let Some(hud) = app.try_state::<HudState>() else {
                    return;
                };
                let line = tray_line(&hud.status());
                if line != last {
                    if let Err(error) = crate::tray::set_hud(&app, &line) {
                        log::debug!("tray HUD line: {error}");
                    }
                    last = line;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
    if let Err(error) = spawned {
        log::warn!("tray HUD thread: {error}");
    }
}

/// The supervisor's events, on its threads: quick, never blocking.
fn on_event<R: Runtime>(
    app: &AppHandle<R>,
    shared: &Shared,
    stats: &StatsState,
    sync: &SyncSlot,
    layouts: &LayoutWrites,
    event: Event,
) {
    match event {
        Event::Connected { pid } => {
            log::debug!("hud: pid {pid} connected");
            // (R3.10) The policy in force now (it may be newer than the
            // file the process read at start).
            if let Some(hud) = app.try_state::<HudState>() {
                hud.policy_changed(crate::policy::remote());
            }
            refresh_tray(app);
        }
        Event::Disconnected { reason } => {
            log::info!("hud: gone ({reason})");
            if set_tables_open(shared, stats, sync, 0) {
                tables_edge(app, false);
            }
            let changed = {
                let mut windows = shared.windows();
                let changed = *windows != Windows::default();
                *windows = Windows::default();
                changed
            };
            if changed {
                status_changed(app);
            }
            refresh_tray(app);
        }
        Event::Message(message, _) => match message {
            HudMessage::TablesOpen { count } => {
                if set_tables_open(shared, stats, sync, count) {
                    tables_edge(app, count > 0);
                }
            }
            HudMessage::OpenPopup {
                window,
                site,
                store_site,
                table,
                player,
                segment,
                slot,
                anchor,
                scale_permille,
                design,
            } => crate::popup::request(
                app,
                crate::popup::PopupTarget {
                    window,
                    site,
                    store_site,
                    table,
                    player,
                    segment,
                    slot,
                    anchor,
                    scale_permille,
                    design,
                },
            ),
            HudMessage::AttachRefused {
                site,
                window,
                reason,
            } => {
                log::info!("hud: compliance mode refused a {site} window ({reason:?})");
                shared.windows().refused(RefusedDto {
                    site,
                    window,
                    table: None,
                    reason,
                });
                status_changed(app);
                refresh_tray(app);
            }
            HudMessage::Health { report, .. } => {
                let now = Windows::from_health(&report);
                let changed = {
                    let mut windows = shared.windows();
                    let changed = *windows != now;
                    *windows = now;
                    changed
                };
                if changed {
                    status_changed(app);
                    refresh_tray(app);
                }
            }
            HudMessage::OpenInApp { site, player } => {
                crate::show_main_window(app);
                if let Err(error) = app.emit(OPEN_PLAYER_EVENT, OpenPlayer::new(site, player)) {
                    log::debug!("{OPEN_PLAYER_EVENT}: {error}");
                }
            }
            HudMessage::TableUpdated {
                hand_key,
                reread_us,
                ..
            } => log::debug!("hud: table updated ({hand_key:?}, re-read {reread_us} us)"),
            HudMessage::SeatPositionChanged {
                site,
                size,
                slot,
                x,
                y,
            } => layouts.queue(SeatWrite {
                site,
                size,
                slot,
                x,
                y,
            }),
            HudMessage::Unknown => {}
        },
    }
}

/// The feeder: imports in, `hand_imported` out, with its own read-only
/// connection. Waiting imports of one file are folded into one look.
fn start_feeder(store_path: &std::path::Path, supervisor: SupervisorSlot) -> HudFeed {
    let (tx, rx) = mpsc::sync_channel::<Fed>(FEED_QUEUE);
    let path = store_path.to_owned();
    let spawned = std::thread::Builder::new()
        .name("rail-hud-feed".to_owned())
        .spawn(move || {
            let reader = match rail_store::Reader::open(&path, 1) {
                Ok(reader) => reader,
                Err(error) => {
                    log::error!("hud: the feeder's store: {error}");
                    return;
                }
            };
            while let Ok(first) = rx.recv() {
                let mut files = vec![first];
                while let Ok(more) = rx.try_recv() {
                    files.push(more);
                }
                let Some(supervisor) = supervisor.get() else {
                    continue;
                };
                if !supervisor.is_connected() {
                    continue;
                }
                // One look per file; its first import's timing (the
                // earliest: a chain is never made to look shorter).
                let mut folded: Vec<Fed> = Vec::new();
                for fed in files {
                    match folded.iter_mut().find(|f| f.path == fed.path) {
                        Some(f) => f.inserted += fed.inserted,
                        None => folded.push(fed),
                    }
                }
                for Fed {
                    path: file,
                    inserted,
                    timing,
                } in folded
                {
                    let hands =
                        match reader.newest_hands_of_file(&file, inserted.min(HANDS_PER_IMPORT)) {
                            Ok(hands) => hands,
                            Err(error) => {
                                log::warn!("hud: {}: {error}", file.display());
                                continue;
                            }
                        };
                    // Oldest first: the HUD ends on the newest players.
                    for hand in hands.into_iter().rev() {
                        supervisor.send(AppMessage::HandImported {
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
                                sent_us: Some(unix_us()),
                                ..timing
                            }),
                        });
                    }
                }
                // A backfill's flood: let it gather between looks.
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    match spawned {
        Ok(_) => HudFeed(Some(tx)),
        Err(error) => {
            log::error!("hud: feeder thread: {error}");
            HudFeed(None)
        }
    }
}

/// [`OPEN_PLAYER_EVENT`]'s payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenPlayer {
    site: String,
    name: String,
    scope: String,
}

impl OpenPlayer {
    pub(crate) fn new(site: String, player: PlayerRef) -> Self {
        Self {
            site,
            name: player.name,
            scope: player.scope,
        }
    }
}

/// The HUD's status for the window (Settings, debug; R3.10 builds on it).
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HudStatusDto {
    /// `off`, `not-installed`, `starting`, `running`, `backoff`, `stopped`;
    /// (R6.4) `locked`: not started, the plan does not include the HUD.
    phase: &'static str,
    error: Option<String>,
    pid: Option<u32>,
    starts: u32,
    last_exit: Option<String>,
    tables_open: u32,
    /// Of those, the tables still "waiting for first hand" (R3.3).
    tables_waiting: u32,
    /// (R3.10) The tables attached.
    tables: Vec<TableDto>,
    /// (R3.10) The windows compliance mode refused that are still open.
    refused: Vec<RefusedDto>,
    /// (R3.10) The HUD's policy has the remote `sites.json` merged in.
    remote_policy: bool,
    /// (R3.11) A system permission the HUD needs to find tables and does
    /// not have: `accessibility` on macOS. Set only when granting it would
    /// find tables now. The HUD screen explains it.
    permission_needed: Option<String>,
    /// (R3.11) Missing, but no supported client runs: the screens say so
    /// neutrally and ask for nothing.
    permission_deferred: Option<String>,
    store_open: bool,
    platform: Option<String>,
    reread_p50_us: u64,
    reread_p95_us: u64,
    health_age_ms: Option<u64>,
    dropped: u64,
}

/// The HUD process's status.
#[tauri::command]
pub fn hud_status(state: State<'_, HudState>) -> HudStatusDto {
    state.status()
}

/// (R3.11) System Settings at Privacy & Security, Accessibility.
pub const ACCESSIBILITY_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// Where the user grants `permission` (`accessibility`): a System Settings
/// pane. `None` for a permission this system has no pane for.
pub fn permission_settings(permission: &str) -> Option<&'static str> {
    (cfg!(target_os = "macos") && permission == "accessibility").then_some(ACCESSIBILITY_SETTINGS)
}

/// (R3.11) The user clicked "Open System Settings" on the HUD screen: the
/// HUD asks macOS for its own Accessibility prompt (which lists Rail in the
/// pane, switched off - the user switches it on; nothing here changes a
/// setting), and System Settings opens at the pane. The HUD screen then
/// sees the grant in the status it polls.
#[tauri::command]
pub fn hud_request_permission(
    state: State<'_, HudState>,
    permission: String,
) -> Result<(), String> {
    let pane = permission_settings(&permission)
        .ok_or_else(|| format!("{permission}: nothing to grant on this system"))?;
    if !state.request_permission(&permission) {
        log::info!("hud: the HUD is not connected; opening the settings only");
    }
    open::that_detached(pane).map_err(|error| error.to_string())
}

/// Whether the user's poker client rotates the table on room `site` so they
/// always sit in one place (R3.6, "preferred seat"): `true`, `false`, or
/// `null` to go by `sites.json`. The HUD lays the seats out again at once.
#[tauri::command]
pub async fn hud_set_preferred_seat(
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    site: String,
    preferred: Option<bool>,
) -> Result<(), String> {
    let store = store.store.as_ref().ok_or("the store is not open")?;
    store
        .writer()
        .and_then(|writer| writer.set_hud_preferred_seat(&site, preferred))
        .map_err(|error| error.to_string())?;
    hud.settings_written();
    Ok(())
}

/// Put a room's panels back where the layout places them (R3.6): one table
/// size, or every size when `size` is `null`. How many positions went.
#[tauri::command]
pub async fn hud_reset_seat_positions(
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    site: String,
    size: Option<u32>,
) -> Result<u64, String> {
    let store = store.store.as_ref().ok_or("the store is not open")?;
    let gone = store
        .writer()
        .and_then(|writer| writer.clear_hud_seat_positions(&site, size))
        .map_err(|error| error.to_string())?;
    hud.layouts_written();
    Ok(gone)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sidecar is looked for beside the app's executable (where Tauri's
    /// bundler puts `externalBin`, and where cargo builds it in
    /// development).
    #[test]
    fn the_sidecar_is_next_to_the_app() {
        let path = sidecar_path().expect("path");
        let exe = std::env::current_exe().expect("exe");
        assert_eq!(path.parent(), exe.parent());
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some(format!("rail-hud{}", std::env::consts::EXE_SUFFIX).as_str())
        );
    }

    /// The statistics pass and sync hear only the edges: no tables -> some
    /// tables -> none. (R3.7) While the HUD says tables are open a
    /// recompute waits - nothing of it is worked out, the screens and the
    /// HUD keep their numbers - and it runs once they close.
    #[test]
    fn tables_open_is_passed_on_at_its_edges() {
        use rail_store::Activity;
        let dir = std::env::temp_dir().join(format!("rail-app-hud-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let hands = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../fixtures/samples/pokerstars/03-cash-plo-run-it-twice-sidepot-dualtimestamp.txt",
        );
        rail_store::import_file(
            store.store.as_ref().expect("the store"),
            &hands,
            &rail_store::ImportOptions::default(),
        )
        .expect("a hand to recompute");
        let stats = StatsState::start(&store);
        let sync = SyncSlot::default();
        let shared = Shared::default();
        let worker = stats.worker().expect("the pass");
        let until = |what: &str, done: &dyn Fn(&rail_store::WorkerStatus) -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                let status = worker.status();
                if done(&status) {
                    return status;
                }
                assert!(std::time::Instant::now() < deadline, "{what}: {status:?}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        set_tables_open(&shared, &stats, &sync, 2);
        assert_eq!(shared.tables_open.load(Ordering::SeqCst), 2);
        assert!(worker.rebuild_stats().expect("rebuild") > 0);
        let epoch = until("paused for the tables", &|s| {
            s.activity == Activity::PausedTables && s.rebuild.is_some()
        })
        .epoch;
        std::thread::sleep(Duration::from_millis(300));
        let status = worker.status();
        assert_eq!(
            (status.rebuild.map(|r| r.done), status.epoch),
            (Some(0), epoch),
            "nothing recomputed, nothing swapped while tables are open"
        );
        set_tables_open(&shared, &stats, &sync, 5);
        set_tables_open(&shared, &stats, &sync, 0);
        assert_eq!(shared.tables_open.load(Ordering::SeqCst), 0);
        let done = until("recomputed once closed", &|s| {
            s.rebuild.is_none() && s.epoch > epoch
        });
        assert_eq!(done.last_error, None);
        stats.stop();
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A dragged panel the HUD reports reaches the store through the
    /// layout thread (R3.6), and the HUD's read-only view of the store
    /// sees it.
    #[test]
    fn a_dragged_panel_is_written() {
        let dir = std::env::temp_dir().join(format!("rail-app-hud-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let opened = store.store.as_ref().expect("store");
        let layouts = LayoutWrites::start(opened.writer().expect("writer"), SyncSlot::default());
        layouts.queue(SeatWrite {
            site: "acr".into(),
            size: 6,
            slot: 2,
            x: 300,
            y: 640,
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let reader = rail_store::Reader::open(&store.path, 1).expect("reader");
        loop {
            let found = reader.hud_seat_positions().expect("read");
            if let [p] = found.as_slice() {
                assert_eq!(
                    (p.site.as_str(), p.size, p.slot, p.x, p.y),
                    ("acr", 6, 2, 300, 640)
                );
                break;
            }
            assert!(std::time::Instant::now() < deadline, "not written");
            std::thread::sleep(Duration::from_millis(20));
        }
        // A position out of range is refused, quietly (logged).
        layouts.queue(SeatWrite {
            site: "acr".into(),
            size: 6,
            slot: 9,
            x: 0,
            y: 0,
        });
        drop((layouts, reader));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (R3.8) The app's half of a click on a panel: the HUD's
    /// `open_popup` opens the popup window (Tauri's mock runtime), the
    /// window hears the tables' edges, and the last table closing closes
    /// the popup. A room whose HUD is not allowed gets no window.
    #[test]
    fn open_popup_from_the_hud_opens_the_window() {
        use rail_hud_ipc::protocol::ScreenRect;
        use tauri::Listener;

        let dir = std::env::temp_dir().join(format!("rail-app-hud-popup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let stats = StatsState::start(&store);
        let (sync, shared, layouts) = (
            SyncSlot::default(),
            Shared::default(),
            LayoutWrites::default(),
        );
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app");
        eprintln!("step ok: the mock app");
        let handle = app.handle();
        handle.manage(crate::popup::PopupState::default());
        let edges = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::clone(&edges);
        handle.listen(TABLES_OPEN_EVENT, move |event| {
            heard
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(event.payload().to_owned());
        });
        let message = |site: &str| {
            Event::Message(
                HudMessage::OpenPopup {
                    window: 3,
                    site: site.into(),
                    store_site: site.into(),
                    table: Some("Made-up".into()),
                    player: PlayerRef::named("Villain").at(4),
                    segment: Some(1),
                    slot: 3,
                    anchor: ScreenRect {
                        x: 100,
                        y: 100,
                        width: 90,
                        height: 40,
                    },
                    scale_permille: 1000,
                    design: None,
                },
                std::time::Instant::now(),
            )
        };
        let event = |e: Event| on_event(handle, &shared, &stats, &sync, &layouts, e);
        event(Event::Message(
            HudMessage::TablesOpen { count: 1 },
            std::time::Instant::now(),
        ));
        event(message("ggpoker"));
        let popup = handle.state::<crate::popup::PopupState>();
        assert_eq!(popup.label(), None, "no popup for a room without a HUD");
        event(message("pokerstars"));
        let label = popup.label().expect("a popup");
        assert!(handle.get_webview_window(&label).is_some());
        eprintln!("step ok: open_popup opened {label}");
        let target = popup.target().expect("its target");
        assert_eq!(
            (
                target.site.as_str(),
                target.player.name.as_str(),
                target.slot
            ),
            ("pokerstars", "Villain", 3)
        );
        event(Event::Message(
            HudMessage::TablesOpen { count: 0 },
            std::time::Instant::now(),
        ));
        assert_eq!(popup.label(), None, "no table, no popup");
        eprintln!("step ok: the last table closed the popup");
        assert_eq!(
            *edges.lock().unwrap_or_else(PoisonError::into_inner),
            ["true", "false"]
        );
        stats.stop();
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (R3.10) What the HUD screen lists: a refusal at once (no table name
    /// yet), then the HUD's own lists from each health answer - a refused
    /// window with its table and reason, the tables attached - and nothing
    /// once the HUD is gone. The tray's line says the same in a few words.
    #[test]
    fn the_status_lists_what_the_hud_said() {
        use rail_hud_ipc::protocol::RefusedTable;
        use tauri::Listener;

        let dir = std::env::temp_dir().join(format!("rail-app-hud-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let stats = StatsState::start(&store);
        let (sync, shared, layouts) = (
            SyncSlot::default(),
            Shared::default(),
            LayoutWrites::default(),
        );
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app");
        let handle = app.handle();
        let heard = Arc::new(AtomicU32::new(0));
        let count = Arc::clone(&heard);
        handle.listen(STATUS_EVENT, move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let event = |e: Event| on_event(handle, &shared, &stats, &sync, &layouts, e);
        let message = |m: HudMessage| Event::Message(m, std::time::Instant::now());

        event(message(HudMessage::AttachRefused {
            site: "ggpoker".into(),
            window: 7,
            reason: RefusalReason::Prohibited,
        }));
        event(message(HudMessage::AttachRefused {
            site: "ggpoker".into(),
            window: 7,
            reason: RefusalReason::Prohibited,
        }));
        assert_eq!(
            shared.windows().refused,
            [RefusedDto {
                site: "ggpoker".into(),
                window: 7,
                table: None,
                reason: RefusalReason::Prohibited,
            }],
            "once per window"
        );
        let report = HealthReport {
            attached: 1,
            refused: 2,
            tables: vec![AttachedTable {
                window: 3,
                site: "pokerstars".into(),
                table: Some("Made-up II".into()),
                waiting: false,
            }],
            refused_tables: vec![
                RefusedTable {
                    window: 7,
                    site: "ggpoker".into(),
                    table: Some("Made-up I".into()),
                    reason: RefusalReason::Prohibited,
                },
                RefusedTable {
                    window: 8,
                    site: "888poker".into(),
                    table: None,
                    reason: RefusalReason::Unknown,
                },
            ],
            remote_policy: true,
            ..HealthReport::default()
        };
        event(message(HudMessage::Health {
            seq: 1,
            report: report.clone(),
        }));
        let windows = shared.windows().clone();
        assert_eq!(windows, Windows::from_health(&report));
        assert_eq!(windows.refused[0].table.as_deref(), Some("Made-up I"));
        assert_eq!(windows.attached[0].table.as_deref(), Some("Made-up II"));
        assert!(windows.remote_policy);
        let before = heard.load(Ordering::SeqCst);
        event(message(HudMessage::Health {
            seq: 2,
            report: report.clone(),
        }));
        assert_eq!(heard.load(Ordering::SeqCst), before, "unchanged: not told");
        // (R3.11) A missing permission is news, and so is its grant.
        let needed = HealthReport {
            permission_needed: Some("accessibility".into()),
            ..report.clone()
        };
        event(message(HudMessage::Health {
            seq: 3,
            report: needed,
        }));
        assert_eq!(
            shared.windows().permission_needed.as_deref(),
            Some("accessibility")
        );
        let told = heard.load(Ordering::SeqCst);
        assert!(told > before, "the window hears a permission is needed");
        // Deferred (no supported client) is news too.
        let deferred = HealthReport {
            permission_deferred: Some("accessibility".into()),
            ..report.clone()
        };
        let told = heard.load(Ordering::SeqCst);
        event(message(HudMessage::Health {
            seq: 4,
            report: deferred,
        }));
        assert_eq!(shared.windows().permission_needed, None);
        assert_eq!(
            shared.windows().permission_deferred.as_deref(),
            Some("accessibility")
        );
        assert!(heard.load(Ordering::SeqCst) > told);
        let told = heard.load(Ordering::SeqCst);
        event(message(HudMessage::Health { seq: 5, report }));
        assert_eq!(shared.windows().permission_needed, None);
        assert_eq!(shared.windows().permission_deferred, None);
        assert!(
            heard.load(Ordering::SeqCst) > told,
            "and that it was granted"
        );
        let before = heard.load(Ordering::SeqCst);
        event(Event::Disconnected {
            reason: "gone".into(),
        });
        assert_eq!(*shared.windows(), Windows::default());
        assert!(heard.load(Ordering::SeqCst) > before);

        let status = |phase: &'static str, tables_open: u32, refused: usize| HudStatusDto {
            phase,
            tables_open,
            refused: vec![
                RefusedDto {
                    site: "ggpoker".into(),
                    window: 1,
                    table: None,
                    reason: RefusalReason::Prohibited,
                };
                refused
            ],
            ..HudStatusDto::default()
        };
        assert_eq!(tray_line(&status("off", 0, 0)), "HUD off");
        assert_eq!(tray_line(&status("not-installed", 0, 0)), "HUD off");
        assert_eq!(tray_line(&status("starting", 0, 0)), "HUD starting…");
        assert_eq!(tray_line(&status("running", 0, 0)), "HUD: no table open");
        assert_eq!(
            tray_line(&status("running", 2, 1)),
            "HUD: 2 tables · 1 not allowed"
        );
        // (R3.11) Running without the permission it needs to see tables.
        let locked = HudStatusDto {
            permission_needed: Some("accessibility".into()),
            ..status("running", 0, 0)
        };
        assert_eq!(
            tray_line(&locked),
            "HUD: needs the Accessibility permission"
        );
        let starting = HudStatusDto {
            permission_needed: Some("accessibility".into()),
            ..status("starting", 0, 0)
        };
        assert_eq!(tray_line(&starting), "HUD starting…");
        // Missing with no supported client running: neutral, no ask.
        let idle = HudStatusDto {
            permission_deferred: Some("accessibility".into()),
            ..status("running", 0, 0)
        };
        assert_eq!(
            tray_line(&idle),
            "HUD on macOS: no supported poker client running"
        );
        // Where it is granted: macOS's pane, nothing elsewhere or for
        // anything else.
        assert_eq!(
            permission_settings("accessibility"),
            cfg!(target_os = "macos").then_some(ACCESSIBILITY_SETTINGS)
        );
        assert_eq!(permission_settings("screen-recording"), None);
        stats.stop();
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_feed_without_a_hud_drops_quietly() {
        HudFeed::default().imported(std::path::Path::new("/x/HH1.txt"), 3, None);
        let (tx, rx) = mpsc::sync_channel(1);
        let feed = HudFeed(Some(tx));
        let before = unix_us();
        feed.imported(std::path::Path::new("/x/HH1.txt"), 3, Some(1_000));
        feed.imported(std::path::Path::new("/x/HH2.txt"), 1, None); // full: dropped
        let fed = rx.try_recv().expect("queued");
        assert_eq!(
            (fed.path, fed.inserted, fed.timing.noticed_us),
            (PathBuf::from("/x/HH1.txt"), 3, Some(1_000_000))
        );
        // (R3.7) The commit's report is stamped when the watcher says so.
        assert!(fed.timing.imported_us.is_some_and(|at| at >= before));
        assert_eq!(fed.timing.sent_us, None, "stamped when sent");
        assert!(rx.try_recv().is_err());
    }

    /// (R6.4) The HUD waits for the plan's first answer; a plan without the
    /// HUD keeps it from starting (the screen and the tray say why), a plan
    /// with it starts it, and a running HUD is never stopped by the plan -
    /// it applies at the next start.
    #[test]
    fn the_plan_holds_the_hud_back_and_never_stops_a_running_one() {
        if std::env::var(DISABLE_VAR).is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
            return;
        }
        let dir = std::env::temp_dir().join(format!("rail-app-hud-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let stats = StatsState::start(&store);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app");
        let hud = HudState::start(
            app.handle(),
            &store,
            stats.clone(),
            SyncSlot::default(),
            None,
        );
        assert_eq!(hud.status().phase, "starting", "prepared, not started");
        hud.apply_plan(false);
        assert_eq!(hud.status().phase, "locked");
        assert_eq!(tray_line(&hud.status()), "HUD: needs Rail Pro");
        hud.apply_plan(false);
        assert_eq!(hud.status().phase, "locked", "still held");
        hud.apply_plan(true);
        let started = hud.status().phase;
        assert!(!matches!(started, "locked" | "off"), "started: {started}");
        assert!(hud.supervisor().is_some());
        hud.apply_plan(false);
        assert!(
            hud.supervisor().is_some() && hud.status().phase != "locked",
            "a running HUD is not stopped"
        );
        hud.stop();
        stats.stop();
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
