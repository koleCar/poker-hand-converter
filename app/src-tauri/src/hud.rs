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
//!   `stats_changed` when a recompute swaps (from `stats::spawn_refresher`),
//!   `shutdown` on exit. Nothing here ever waits for the HUD: every send is
//!   queued or dropped.
//! - **What it says**: `tables_open` pauses the statistics pass's heavy
//!   parts and lowers sync's bandwidth while any table is attached
//!   (`StatsWorker::set_tables_open`, `SyncWorker::set_tables_open`); when
//!   the HUD goes away the tables count as closed. `attach_refused` is
//!   logged and kept for the status (R3.10 shows it in the app);
//!   `open_in_app` shows the window and emits [`OPEN_PLAYER_EVENT`];
//!   `seat_position_changed` (R3.6: the user dragged a panel) is written to
//!   the store by a thread of its own ([`LayoutWrites`]) - the HUD's
//!   connection is read-only, and the supervisor's callback never waits for
//!   a commit.
//! - **The user's HUD settings** (R3.6): [`hud_set_preferred_seat`] (their
//!   client rotates the table on a room, or not, or as `sites.json` says)
//!   and [`hud_reset_seat_positions`] write the store and tell the HUD
//!   (`settings_changed`, `layout_changed`), which reads them again. No
//!   screen calls them yet (R3.9's HUD editor, R3.10's HUD screen).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rail_hud_ipc::protocol::{AppMessage, HudMessage, PlayerRef, RefusalReason};
use rail_hud_ipc::supervisor::{Event, Supervisor, SupervisorConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::commands::StoreState;
use crate::stats::StatsState;
use crate::sync::SyncSlot;

/// The window event for "show this player" from a HUD popup (R3.8); the
/// payload is `{site, name, scope}`.
pub const OPEN_PLAYER_EVENT: &str = "hud-open-player";

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
    pub reason: RefusalReason,
}

#[derive(Debug, Default)]
struct Shared {
    tables_open: AtomicU32,
    refused: Mutex<Vec<RefusedDto>>,
}

/// Where the watcher's callback drops a file that got new hands.
#[derive(Debug, Clone, Default)]
pub struct HudFeed(Option<SyncSender<(PathBuf, u32)>>);

impl HudFeed {
    /// `inserted` new hands were stored from `path`; never waits.
    pub fn imported(&self, path: &std::path::Path, inserted: u32) {
        if let Some(tx) = &self.0
            && let Err(TrySendError::Disconnected(_)) = tx.try_send((path.to_owned(), inserted))
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
    /// The writer thread over the store's writer.
    fn start(writer: rail_store::WriterHandle) -> Self {
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
                        Ok(()) => log::info!(
                            "hud: {} {}-seat panel {} now at ({}, {})",
                            write.site,
                            write.size,
                            write.slot,
                            write.x,
                            write.y
                        ),
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

/// The HUD, as app state.
#[derive(Debug)]
pub struct HudState {
    supervisor: Option<Arc<Supervisor>>,
    error: Option<String>,
    shared: Arc<Shared>,
    feed: HudFeed,
    sync: SyncSlot,
}

impl HudState {
    /// Start supervising the HUD (unless switched off or there is no
    /// store).
    pub fn start<R: Runtime>(
        app: &AppHandle<R>,
        store: &StoreState,
        stats: StatsState,
        sync: SyncSlot,
    ) -> Self {
        let shared = Arc::new(Shared::default());
        let off = |error: String| Self {
            supervisor: None,
            error: Some(error),
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
        let layouts = match store.store.as_ref().map(rail_store::Store::writer) {
            Some(Ok(writer)) => LayoutWrites::start(writer),
            _ => LayoutWrites::default(),
        };

        let on_event = {
            let app = app.clone();
            let shared = Arc::clone(&shared);
            let sync = Arc::clone(&sync);
            move |event: Event| on_event(&app, &shared, &stats, &sync, &layouts, event)
        };
        let supervisor = match Supervisor::start(config, on_event) {
            Ok(supervisor) => Arc::new(supervisor),
            Err(error) => {
                log::error!("hud: the supervisor did not start: {error}");
                return off(error.to_string());
            }
        };
        let feed = start_feeder(&store.path, Arc::clone(&supervisor));
        Self {
            supervisor: Some(supervisor),
            error: None,
            shared,
            feed,
            sync,
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
        if let Some(supervisor) = &self.supervisor {
            supervisor.send(AppMessage::StatsChanged { epoch });
        }
    }

    /// The user changed a HUD setting (R3.6: the preferred seat): the HUD
    /// reads them again.
    pub fn settings_changed(&self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.send(AppMessage::SettingsChanged);
        }
    }

    /// The user's panel positions changed outside the HUD (a reset): the
    /// HUD reads them again.
    pub fn layout_changed(&self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.send(AppMessage::LayoutChanged);
        }
    }

    /// Shut the HUD down (on exit, first).
    pub fn stop(&self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.stop();
            log::info!("hud: stopped");
        }
    }

    pub fn status(&self) -> HudStatusDto {
        let refused = self
            .shared
            .refused
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let tables_open = self.shared.tables_open.load(Ordering::SeqCst);
        let Some(supervisor) = &self.supervisor else {
            return HudStatusDto {
                phase: "off",
                error: self.error.clone(),
                tables_open,
                refused,
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
            refused,
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

fn set_tables_open(shared: &Shared, stats: &StatsState, sync: &SyncSlot, count: u32) {
    let before = shared.tables_open.swap(count, Ordering::SeqCst);
    if (before > 0) != (count > 0) {
        let open = count > 0;
        log::info!("hud: tables {}", if open { "open" } else { "closed" });
        stats.set_tables_open(open);
        if let Some(worker) = sync.get() {
            worker.set_tables_open(open);
        }
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
        Event::Connected { pid } => log::debug!("hud: pid {pid} connected"),
        Event::Disconnected { reason } => {
            log::info!("hud: gone ({reason})");
            set_tables_open(shared, stats, sync, 0);
        }
        Event::Message(message, _) => match message {
            HudMessage::TablesOpen { count } => set_tables_open(shared, stats, sync, count),
            HudMessage::AttachRefused {
                site,
                window,
                reason,
            } => {
                log::info!("hud: compliance mode refused a {site} window ({reason:?})");
                let mut refused = shared
                    .refused
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                refused.push(RefusedDto {
                    site,
                    window,
                    reason,
                });
                let excess = refused.len().saturating_sub(REFUSED_KEPT);
                refused.drain(..excess);
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
            HudMessage::Health { .. } | HudMessage::Unknown => {}
        },
    }
}

/// The feeder: imports in, `hand_imported` out, with its own read-only
/// connection. Waiting imports of one file are folded into one look.
fn start_feeder(store_path: &std::path::Path, supervisor: Arc<Supervisor>) -> HudFeed {
    let (tx, rx) = mpsc::sync_channel::<(PathBuf, u32)>(FEED_QUEUE);
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
                if !supervisor.is_connected() {
                    continue;
                }
                let mut folded: Vec<(PathBuf, u32)> = Vec::new();
                for (file, inserted) in files {
                    match folded.iter_mut().find(|(f, _)| *f == file) {
                        Some((_, n)) => *n += inserted,
                        None => folded.push((file, inserted)),
                    }
                }
                for (file, inserted) in folded {
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
                                })
                                .collect(),
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
struct OpenPlayer {
    site: String,
    name: String,
    scope: String,
}

impl OpenPlayer {
    fn new(site: String, player: PlayerRef) -> Self {
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
    /// `off`, `not-installed`, `starting`, `running`, `backoff`, `stopped`.
    phase: &'static str,
    error: Option<String>,
    pid: Option<u32>,
    starts: u32,
    last_exit: Option<String>,
    tables_open: u32,
    /// Of those, the tables still "waiting for first hand" (R3.3).
    tables_waiting: u32,
    refused: Vec<RefusedDto>,
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
    hud.settings_changed();
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
    hud.layout_changed();
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
    /// tables -> none.
    #[test]
    fn tables_open_is_passed_on_at_its_edges() {
        let dir = std::env::temp_dir().join(format!("rail-app-hud-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let stats = StatsState::start(&store);
        let sync = SyncSlot::default();
        let shared = Shared::default();
        set_tables_open(&shared, &stats, &sync, 2);
        assert_eq!(shared.tables_open.load(Ordering::SeqCst), 2);
        set_tables_open(&shared, &stats, &sync, 5);
        set_tables_open(&shared, &stats, &sync, 0);
        assert_eq!(shared.tables_open.load(Ordering::SeqCst), 0);
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
        let layouts = LayoutWrites::start(opened.writer().expect("writer"));
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

    #[test]
    fn a_feed_without_a_hud_drops_quietly() {
        HudFeed::default().imported(std::path::Path::new("/x/HH1.txt"), 3);
        let (tx, rx) = mpsc::sync_channel(1);
        let feed = HudFeed(Some(tx));
        feed.imported(std::path::Path::new("/x/HH1.txt"), 3);
        feed.imported(std::path::Path::new("/x/HH2.txt"), 1); // full: dropped
        assert_eq!(rx.try_recv().ok(), Some((PathBuf::from("/x/HH1.txt"), 3)));
        assert!(rx.try_recv().is_err());
    }
}
