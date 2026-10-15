//! The statistics pass (`rail_store::StatsWorker`, docs/RAIL-PLAN.md R2.3)
//! inside the app: started in `setup` right after the store, before the
//! watcher, which wakes it after every import with new hands and pauses it
//! while a folder's backfill runs (the import threads have the CPU then).
//! Stopped on exit with the watcher and sync, before the store closes (it
//! holds a handle on the store's writer).
//!
//! The pass recomputes the statistics after a definition changes (R2.11:
//! a stats, segment or EV version bump - or when asked: [`stats_rebuild`],
//! [`stats_recompute_ev`], debug buttons under Settings) beside the ones
//! the screens show and swaps them in when done, and computes the all-in EV
//! of preflop all-ins in the background. Its status is [`stats_status`];
//! when a recompute swaps, the window hears [`CHANGED_EVENT`] and the
//! screens read again, and so does the HUD (`stats_changed`, R3.2). While
//! the HUD is attached to any table its heavy parts pause
//! ([`StatsState::set_tables_open`], from `hud`).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rail_store::{StatsWorker, WorkerStatus};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// The event the window hears when a recompute has swapped new statistics
/// in (R2.11): every screen that shows statistics reads them again.
pub const CHANGED_EVENT: &str = "stats-changed";

use crate::commands::StoreState;

/// The pass, as app state (a clone goes to the watcher's callback). No
/// worker when the store did not open or the thread did not start (`error`
/// says why).
#[derive(Debug, Clone)]
pub struct StatsState {
    worker: Option<Arc<StatsWorker>>,
    error: Option<String>,
    /// The folders whose backfill runs: the pass waits while any does.
    backfilling: Arc<Mutex<BTreeSet<i64>>>,
}

impl StatsState {
    /// Start the pass on the store.
    pub fn start(store: &StoreState) -> Self {
        let started = match &store.store {
            None => Err("the store is not open".to_owned()),
            Some(store) => store
                .writer()
                .and_then(|writer| StatsWorker::start(store.path(), writer))
                .map_err(|error| error.to_string()),
        };
        match started {
            Ok(worker) => {
                log::info!("statistics pass started");
                Self {
                    worker: Some(Arc::new(worker)),
                    error: None,
                    backfilling: Arc::default(),
                }
            }
            Err(error) => {
                log::error!("the statistics pass did not start: {error}");
                Self {
                    worker: None,
                    error: Some(error),
                    backfilling: Arc::default(),
                }
            }
        }
    }

    /// Hands were imported: there may be EV rows to compute.
    pub fn wake(&self) {
        if let Some(worker) = &self.worker {
            worker.wake();
        }
    }

    /// A folder's backfill started (`true`) or ended: the pass pauses while
    /// any runs.
    pub fn backfill(&self, source_id: i64, running: bool) {
        let mut set = self
            .backfilling
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let changed = if running {
            set.insert(source_id)
        } else {
            set.remove(&source_id)
        };
        if changed && let Some(worker) = &self.worker {
            worker.set_backfill(!set.is_empty());
        }
    }

    /// The folders whose backfill the watcher's status shows: corrects the
    /// set when an end was never reported (a folder removed or switched off
    /// mid-backfill).
    pub fn reconcile(&self, running: impl IntoIterator<Item = i64>) {
        let running: BTreeSet<i64> = running.into_iter().collect();
        let mut set = self
            .backfilling
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *set != running {
            *set = running;
            if let Some(worker) = &self.worker {
                worker.set_backfill(!set.is_empty());
            }
        }
    }

    /// Poker tables are open (the HUD says so, R3.2): the pass pauses its
    /// heavy parts - a recompute, the EV - until they close.
    pub fn set_tables_open(&self, open: bool) {
        if let Some(worker) = &self.worker {
            worker.set_tables_open(open);
        }
    }

    /// The pass itself, for tests.
    #[cfg(test)]
    pub(crate) fn worker(&self) -> Option<Arc<StatsWorker>> {
        self.worker.clone()
    }

    /// Stop the thread (on exit): it lets go of the store's writer.
    pub fn stop(&self) {
        if let Some(worker) = &self.worker {
            worker.stop();
            log::info!("statistics pass stopped");
        }
    }

    fn with<T>(
        &self,
        f: impl FnOnce(&StatsWorker) -> Result<T, rail_store::Error>,
    ) -> Result<T, String> {
        match &self.worker {
            Some(worker) => f(worker).map_err(|error| error.to_string()),
            None => Err(self
                .error
                .clone()
                .unwrap_or_else(|| "the statistics pass is not running".to_owned())),
        }
    }
}

/// Watch the pass's epoch and tell the window when a recompute swapped its
/// statistics in (once a second at most).
pub fn spawn_refresher<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("rail-stats-status".to_owned())
        .spawn(move || {
            let mut last: Option<i64> = None;
            loop {
                let Some(state) = app.try_state::<StatsState>() else {
                    return;
                };
                let Some(worker) = state.worker.clone() else {
                    return;
                };
                let status = worker.status();
                if status.activity == rail_store::Activity::Stopped {
                    return;
                }
                if last.is_some_and(|last| last != status.epoch) {
                    if let Err(error) = app.emit(CHANGED_EVENT, ()) {
                        log::debug!("{CHANGED_EVENT}: {error}");
                    }
                    // The HUD re-reads every table it shows (R3.2).
                    if let Some(hud) = app.try_state::<crate::hud::HudState>() {
                        hud.stats_changed(status.epoch);
                    }
                }
                last = Some(status.epoch);
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    if let Err(error) = spawned {
        log::warn!("statistics status thread: {error}");
    }
}

/// `rail_store::WorkerStatus` for the window.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatsStatusDto {
    /// `idle`, `rebuilding`, `indexing` (R2.7c), `counting` (R2.10),
    /// `computing`, `recomputing-ev` (R2.11), `paused-backfill`,
    /// `paused-tables`, `stopped`.
    activity: &'static str,
    /// A recompute's rows job in progress (R2.11): hands done, of hands to
    /// do...
    rebuild_done: Option<u64>,
    rebuild_total: Option<u64>,
    /// ...which job (`rows`, `segments`)...
    rebuild_job: Option<&'static str>,
    /// ...and whether it fills a store that had no statistics (the screens
    /// grow as it goes) rather than replacing them when done.
    rebuild_fills: bool,
    /// A recompute's EV job in progress: hands evaluated, of hands to do.
    ev_recompute_done: Option<u64>,
    ev_recompute_total: Option<u64>,
    /// Hands waiting for their all-in EV.
    ev_pending: u64,
    /// Hands whose opponents the pass has not indexed yet (R2.7c: "hands
    /// with this player" and a profile by position miss them until then).
    players_unindexed: u64,
    /// EV rows computed since the app started, and the milliseconds the
    /// computation took.
    ev_computed: u64,
    ev_millis: u64,
    last_error: Option<String>,
}

impl From<WorkerStatus> for StatsStatusDto {
    fn from(status: WorkerStatus) -> Self {
        Self {
            activity: status.activity.as_str(),
            rebuild_done: status.rebuild.as_ref().map(|r| r.done),
            rebuild_total: status.rebuild.as_ref().map(|r| r.total),
            rebuild_job: status.rebuild.as_ref().map(|r| r.job.as_str()),
            rebuild_fills: status.rebuild.as_ref().is_some_and(|r| r.fills > 0),
            ev_recompute_done: status.ev_recompute.as_ref().map(|r| r.done),
            ev_recompute_total: status.ev_recompute.as_ref().map(|r| r.total),
            ev_pending: status.ev_pending,
            players_unindexed: status.players_unindexed,
            ev_computed: status.ev_computed,
            ev_millis: status.ev_millis,
            last_error: status.last_error,
        }
    }
}

/// The pass's status.
#[tauri::command]
pub fn stats_status(state: State<'_, StatsState>) -> Result<StatsStatusDto, String> {
    state.with(|worker| Ok(worker.status().into()))
}

/// Work every hand's statistics out again from its stored hand (in the
/// background; R2.11: swapped in when done). Returns the hands to go
/// through.
#[tauri::command]
pub async fn stats_rebuild(state: State<'_, StatsState>) -> Result<u64, String> {
    state.with(StatsWorker::rebuild_stats)
}

/// Compute every hero hand's all-in EV again (in the background; R2.11:
/// swapped in when done). Returns the hands to evaluate.
#[tauri::command]
pub async fn stats_recompute_ev(state: State<'_, StatsState>) -> Result<u64, String> {
    state.with(StatsWorker::recompute_ev)
}

#[cfg(test)]
mod tests {
    use super::{StatsState, StatsStatusDto, StatsWorker};
    use crate::commands::StoreState;

    /// The pass starts on a new store, says it is idle, pauses for a
    /// backfill and stops; without a store it says why.
    #[test]
    fn starts_reports_pauses_and_stops() {
        let dir = std::env::temp_dir().join(format!("rail-app-stats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let state = StatsState::start(&store);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            let status: StatsStatusDto = state.with(|w| Ok(w.status().into())).expect("status");
            if status.activity == "idle" || std::time::Instant::now() > deadline {
                break status;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(status.activity, "idle");
        assert_eq!((status.ev_pending, status.rebuild_total), (0, None));
        state.backfill(3, true);
        state.backfill(4, true);
        state.backfill(3, false);
        assert_eq!(
            state.with(StatsWorker::rebuild_stats).expect("rebuild"),
            0,
            "an empty store has nothing to rebuild"
        );
        state.backfill(4, false);
        state.stop();
        let status: StatsStatusDto = state.with(|w| Ok(w.status().into())).expect("status");
        assert_eq!(status.activity, "stopped");
        drop(state);
        drop(store);

        let blocked = dir.join("blocked");
        std::fs::create_dir_all(&blocked).expect("dir");
        let state = StatsState::start(&StoreState::open(blocked));
        assert!(state.with(|w| Ok(w.status())).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
