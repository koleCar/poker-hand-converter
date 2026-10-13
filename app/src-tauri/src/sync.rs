//! The sync worker (`rail_sync::worker`, docs/RAIL-PLAN.md R1.9) inside the
//! app: started in `setup` after the store and the account, woken by every
//! import (the watcher) and every account change, stopped on exit before the
//! store closes. It shows in Settings → Account, on Today and in the tray's
//! third line; the window's controls are the commands below.
//!
//! Sync needs an account: without a Supabase configuration in this build
//! (or without a store) there is no worker, and [`sync_status`] answers
//! `null` ("sync is off"). Signed out, offline, paused: the worker says so
//! and waits; none of them is an error.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use rail_sync::ingest::IngestClient;
use rail_sync::worker::{StoreAccess, SyncConfig, SyncPhase, SyncStatus, SyncWorker};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::account::AccountState;
use crate::commands::StoreState;
use crate::{strings, tray};

/// The window event that says the sync status changed; at most once a
/// second. No payload: the window asks `sync_status`.
pub const CHANGED_EVENT: &str = "sync-changed";

/// Where the worker is, once it exists: the watcher wakes it through this
/// (it starts before the worker).
pub type SyncSlot = Arc<OnceLock<SyncWorker>>;

/// The worker, as app state. `None`: sync is off (no account configuration,
/// or no store).
#[derive(Debug)]
pub struct SyncState {
    worker: Option<SyncWorker>,
    dirty: Arc<AtomicBool>,
}

impl SyncState {
    pub fn status(&self) -> Option<SyncStatus> {
        self.worker.as_ref().map(SyncWorker::status)
    }

    /// The account changed: look again now.
    pub fn account_changed(&self) {
        if let Some(worker) = &self.worker {
            worker.account_changed();
        }
    }

    /// Stop the worker (on exit): it lets go of the store's writer at once.
    pub fn stop(&self) {
        if let Some(worker) = &self.worker {
            worker.stop();
        }
    }
}

/// The computer's name as the user knows it, for the server's list of
/// folders ("WePlay - hands on Hrvoje's MacBook").
fn device_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            && output.status.success()
        {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !name.is_empty() {
                return Some(name.chars().take(64).collect());
            }
        }
    }
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|var| std::env::var(var).ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().chars().take(64).collect::<String>())
        .filter(|name| !name.is_empty())
}

/// Start the worker (when there is an account configuration and a store)
/// and manage [`SyncState`]. Called once from `setup`, after the account.
pub fn setup<R: Runtime>(app: &AppHandle<R>, slot: &SyncSlot) {
    let dirty = Arc::new(AtomicBool::new(true));
    let worker = start(app, &dirty);
    if let Some(worker) = &worker {
        let _ = slot.set(worker.clone());
    }
    app.manage(SyncState { worker, dirty });
    refresh_tray(app);
    spawn_refresher(app);
}

fn start<R: Runtime>(app: &AppHandle<R>, dirty: &Arc<AtomicBool>) -> Option<SyncWorker> {
    let account = app.try_state::<AccountState>()?.0.clone()?;
    let store_state = app.try_state::<StoreState>()?;
    let store = store_state.store.as_ref()?;
    let client = match IngestClient::new(account.config()) {
        Ok(client) => client,
        Err(error) => {
            log::error!("sync: no HTTP client: {error}");
            return None;
        }
    };
    let access = match store
        .writer()
        .and_then(|writer| StoreAccess::open(store.path(), writer))
    {
        Ok(access) => access,
        Err(error) => {
            log::error!("sync: the store: {error}");
            return None;
        }
    };
    let config = SyncConfig {
        device_name: device_name(),
        ..SyncConfig::default()
    };
    let flag = Arc::clone(dirty);
    let (worker, task) = SyncWorker::new(
        config,
        account,
        client,
        access,
        Box::new(move || flag.store(true, Ordering::Relaxed)),
    );
    tauri::async_runtime::spawn(task.run());
    log::info!("sync: started");
    Some(worker)
}

/// Redraw the tray line and tell the window, once a second at most.
fn spawn_refresher<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("rail-sync-status".to_owned())
        .spawn(move || {
            loop {
                let Some(state) = app.try_state::<SyncState>() else {
                    return;
                };
                if state.dirty.swap(false, Ordering::Relaxed) {
                    refresh_tray(&app);
                    if let Err(error) = app.emit(CHANGED_EVENT, ()) {
                        log::debug!("{CHANGED_EVENT}: {error}");
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    if let Err(error) = spawned {
        log::warn!("sync status thread: {error}");
    }
}

/// The tray's sync line for a status (`None`: sync is off).
pub fn tray_line(status: Option<&SyncStatus>) -> String {
    let text = strings::tray();
    let Some(status) = status else {
        return text.sync_off.to_owned();
    };
    match &status.phase {
        SyncPhase::Starting => text.sync_starting.to_owned(),
        SyncPhase::SignedOut => text.sync_signed_out.to_owned(),
        SyncPhase::Paused => text.sync_paused.to_owned(),
        SyncPhase::AccountMismatch { .. } => text.sync_question.to_owned(),
        SyncPhase::Declined { .. } => text.sync_declined.to_owned(),
        SyncPhase::Syncing => (text.sync_syncing)(status.sent, status.total.max(status.sent)),
        SyncPhase::UpToDate => text.sync_up_to_date.to_owned(),
        SyncPhase::Offline { .. } => (text.sync_offline)(status.outbox),
        SyncPhase::RateLimited { .. } => text.sync_rate_limited.to_owned(),
        SyncPhase::Failed { .. } => text.sync_failed.to_owned(),
    }
}

pub fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    let status = app
        .try_state::<SyncState>()
        .and_then(|state| state.status());
    if let Err(error) = tray::set_sync(app, &tray_line(status.as_ref())) {
        log::debug!("tray sync line: {error}");
    }
}

fn worker(state: &SyncState) -> Result<&SyncWorker, String> {
    state
        .worker
        .as_ref()
        .ok_or_else(|| "Sync is not available in this build.".to_owned())
}

/// The status; `null` when sync is off.
#[tauri::command]
pub fn sync_status(state: State<'_, SyncState>) -> Option<SyncStatus> {
    state.status()
}

/// "Sync now": retry what waits and pull, at once.
#[tauri::command]
pub fn sync_now(state: State<'_, SyncState>) -> Result<SyncStatus, String> {
    let worker = worker(&state)?;
    worker.sync_now();
    Ok(worker.status())
}

/// "Pause sync" / "Resume sync" (remembered across restarts).
#[tauri::command]
pub fn sync_set_paused(state: State<'_, SyncState>, paused: bool) -> Result<SyncStatus, String> {
    let worker = worker(&state)?;
    worker
        .set_paused(paused)
        .map_err(|error| error.to_string())?;
    Ok(worker.status())
}

/// The upload cap while a large backlog syncs, bytes a second (`null`: no
/// cap).
#[tauri::command]
pub fn sync_set_cap(state: State<'_, SyncState>, cap: Option<u64>) -> Result<SyncStatus, String> {
    let worker = worker(&state)?;
    worker.set_cap(cap).map_err(|error| error.to_string())?;
    Ok(worker.status())
}

/// The answer to "upload this computer's hands to the account now signed
/// in?", for the account signed in now.
#[tauri::command]
pub fn sync_answer_account(
    state: State<'_, SyncState>,
    account: State<'_, AccountState>,
    upload: bool,
) -> Result<SyncStatus, String> {
    let worker = worker(&state)?;
    let user = account
        .0
        .as_ref()
        .and_then(|account| account.user())
        .ok_or_else(|| "Not signed in.".to_owned())?;
    worker.answer_account(&user.0, upload);
    Ok(worker.status())
}

/// Queue the hands the server refused again.
#[tauri::command]
pub fn sync_retry_rejected(state: State<'_, SyncState>) -> Result<SyncStatus, String> {
    let worker = worker(&state)?;
    worker.retry_rejected();
    Ok(worker.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_line_follows_the_phase() {
        assert_eq!(tray_line(None), "Sync off");
        let status = |phase| SyncStatus {
            phase,
            sent: 120,
            total: 4000,
            outbox: 3880,
            ..SyncStatus::default()
        };
        assert_eq!(
            tray_line(Some(&status(SyncPhase::Syncing))),
            "Syncing 120 of 4000 hands"
        );
        assert_eq!(
            tray_line(Some(&status(SyncPhase::UpToDate))),
            "Synced: up to date"
        );
        assert_eq!(
            tray_line(Some(&status(SyncPhase::Offline { retry_at_ms: 0 }))),
            "Offline · 3880 hands wait to sync"
        );
        assert_eq!(
            tray_line(Some(&status(SyncPhase::SignedOut))),
            "Sync: sign in to sync"
        );
    }

    #[test]
    fn a_device_name_is_short() {
        if let Some(name) = device_name() {
            assert!(!name.is_empty() && name.chars().count() <= 64);
        }
    }
}
