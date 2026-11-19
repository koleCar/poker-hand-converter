//! Deleting hands (2026-11-19, the owner: delete one hand, a selection, or
//! every hand; a confirmation first, in the window):
//!
//! - `hands_delete(handKeys)`: these hands, from this computer's store
//!   (every statistic kept exact, `rail_store::delete`) and - through the
//!   sync worker - from the account's server copy; in transactions of
//!   [`CHUNK`] hands, each telling the window how far it is
//!   ([`PROGRESS_EVENT`]);
//! - `hands_delete_all()`: every hand, in one transaction (bulk); the
//!   account's copy too when this computer syncs to one;
//! - `hands_count()`: how many hands the store holds (the "type the number"
//!   confirmation).
//!
//! A deleted hand is never imported again (its key is kept,
//! `deleted_hands`). Afterwards the screens hear `stats-changed` and
//! `watcher-changed` and read again; the sync worker is woken.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::StoreState;

/// The window event of a delete's progress: `{done, total}`.
pub const PROGRESS_EVENT: &str = "hands-delete-progress";

/// Hands per transaction of `hands_delete` (each a few ms to a few tens).
const CHUNK: usize = 500;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: u64,
    total: u64,
}

fn store(state: &StoreState) -> Result<&rail_store::Store, String> {
    state
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

/// The screens read again; the sync worker sends the deletions.
fn after_delete<R: Runtime>(app: &AppHandle<R>) {
    for event in [crate::stats::CHANGED_EVENT, crate::watch::CHANGED_EVENT] {
        if let Err(error) = app.emit(event, ()) {
            log::debug!("{event}: {error}");
        }
    }
    if let Some(sync) = app.try_state::<crate::sync::SyncState>() {
        sync.wake();
    }
}

/// Delete these hands here and (by the sync worker) on the account.
/// Returns how many were deleted.
#[tauri::command]
pub async fn hands_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, StoreState>,
    hand_keys: Vec<String>,
) -> Result<u64, String> {
    let writer = store(&state)?.writer().map_err(|error| error.to_string())?;
    let total = u64::try_from(hand_keys.len()).unwrap_or(u64::MAX);
    let emitter = app.clone();
    let deleted = tauri::async_runtime::spawn_blocking(move || {
        let mut deleted = 0;
        let mut done = 0;
        for chunk in hand_keys.chunks(CHUNK) {
            deleted += writer.delete_hands(chunk.to_vec(), rail_store::time::now_ms())?;
            done += u64::try_from(chunk.len()).unwrap_or(0);
            if total > u64::try_from(CHUNK).unwrap_or(0) {
                let _ = emitter.emit(PROGRESS_EVENT, Progress { done, total });
            }
        }
        Ok::<u64, rail_store::Error>(deleted)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string());
    after_delete(&app);
    let deleted = deleted?;
    log::info!("{deleted} hands deleted");
    Ok(deleted)
}

/// Delete every hand here, and the account's copy when this computer's
/// hands sync to one. Returns how many were deleted here.
#[tauri::command]
pub async fn hands_delete_all<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, StoreState>,
) -> Result<u64, String> {
    let store = store(&state)?;
    let owned = store
        .reader()
        .kv(rail_store::sync::OWNER_KEY)
        .map_err(|error| error.to_string())?
        .is_some();
    let writer = store.writer().map_err(|error| error.to_string())?;
    let deleted = tauri::async_runtime::spawn_blocking(move || {
        writer.delete_all_hands(rail_store::time::now_ms(), owned)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string());
    after_delete(&app);
    let deleted = deleted?;
    log::info!("every hand deleted ({deleted})");
    Ok(deleted)
}

/// How many hands the store holds.
#[tauri::command]
pub async fn hands_count(state: State<'_, StoreState>) -> Result<u64, String> {
    let store = store(&state)?;
    Ok(store.status().map_err(|error| error.to_string())?.hands)
}
