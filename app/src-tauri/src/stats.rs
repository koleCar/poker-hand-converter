//! The statistics pass (`rail_store::StatsWorker`, docs/RAIL-PLAN.md R2.3)
//! inside the app: started in `setup` right after the store, before the
//! watcher, which wakes it after every import with new hands and pauses it
//! while a folder's backfill runs (the import threads have the CPU then).
//! Stopped on exit with the watcher and sync, before the store closes (it
//! holds a handle on the store's writer).
//!
//! The pass rebuilds the statistics after a stats version bump (or when
//! asked: [`stats_rebuild`], a debug button under Settings until R2.7's
//! real screens) and computes the all-in EV of preflop all-ins in the
//! background. Its status is [`stats_status`]. Tables open (the HUD of
//! Phase 3) will pause its EV part through `StatsWorker::set_tables_open`.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, PoisonError};

use rail_store::{StatsWorker, WorkerStatus};
use serde::Serialize;
use tauri::State;

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

/// `rail_store::WorkerStatus` for the window.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatsStatusDto {
    /// `idle`, `rebuilding`, `computing`, `paused-backfill`,
    /// `paused-tables`, `stopped`.
    activity: &'static str,
    /// A rebuild in progress: hands done, of hands to do.
    rebuild_done: Option<u64>,
    rebuild_total: Option<u64>,
    /// Hands waiting for their all-in EV.
    ev_pending: u64,
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
            ev_pending: status.ev_pending,
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

/// Rebuild every hand's statistics from its stored hand (in the
/// background). Returns the hands to go through.
#[tauri::command]
pub async fn stats_rebuild(state: State<'_, StatsState>) -> Result<u64, String> {
    state.with(StatsWorker::rebuild_stats)
}

/// Compute every hero hand's all-in EV again (in the background). Returns
/// the hands queued.
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
