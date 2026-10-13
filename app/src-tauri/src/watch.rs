//! The watcher (`rail-watch`, R1.3) inside the app: started in `setup`
//! right after the store, reported in the tray's status line and on the
//! Today screen, paused and resumed from the tray ("Pause import").
//!
//! Folders come from the store's `sources`, added by the first-run screen
//! (`folders.rs`, R1.4) and later by Settings → Folders (R1.5). A folder
//! found for a room reads only the room's files (`files.glob` of the
//! shipped `sites.json`, [`WatchConfig::file_globs`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use rail_watch::{SourceState, WatchConfig, WatchEvent, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::commands::StoreState;
use crate::{strings, tray};

/// The watcher, as app state. `None` when the store did not open or the
/// watcher did not start (`error` says why), and after it was stopped.
#[derive(Debug)]
pub struct WatcherState {
    watcher: Mutex<Option<Watcher>>,
    error: Option<String>,
    /// Something was imported since the tray was last refreshed.
    dirty: Arc<AtomicBool>,
}

impl WatcherState {
    /// Start watching the store's enabled folders.
    pub fn start(store: &StoreState) -> Self {
        let dirty = Arc::new(AtomicBool::new(true));
        let Some(store) = &store.store else {
            return Self {
                watcher: Mutex::new(None),
                error: Some("the store is not open".to_owned()),
                dirty,
            };
        };
        let started = store
            .writer()
            .map_err(|e| e.to_string())
            .and_then(|writer| {
                let flag = Arc::clone(&dirty);
                let config = WatchConfig {
                    file_globs: crate::folders::sites()
                        .map(rail_watch::discover::file_globs)
                        .unwrap_or_default(),
                    ..WatchConfig::default()
                };
                Watcher::start(store.path(), writer, config, move |event| {
                    on_event(&flag, &event);
                })
                .map_err(|e| e.to_string())
            });
        match started {
            Ok(watcher) => {
                log::info!("watcher started");
                Self {
                    watcher: Mutex::new(Some(watcher)),
                    error: None,
                    dirty,
                }
            }
            Err(error) => {
                log::error!("the watcher did not start: {error}");
                Self {
                    watcher: Mutex::new(None),
                    error: Some(error),
                    dirty,
                }
            }
        }
    }

    /// Run `f` on the running watcher.
    pub fn with<T>(&self, f: impl FnOnce(&Watcher) -> T) -> Result<T, String> {
        let guard = self.watcher.lock().unwrap_or_else(PoisonError::into_inner);
        match guard.as_ref() {
            Some(watcher) => Ok(f(watcher)),
            None => Err(self
                .error
                .clone()
                .unwrap_or_else(|| "the watcher is not running".to_owned())),
        }
    }

    /// Have the tray redrawn (folders were added).
    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Stop it (on exit): before the store closes, which waits for the
    /// watcher's handles on its writer.
    pub fn stop(&self) {
        let watcher = self
            .watcher
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(watcher) = watcher {
            watcher.stop();
            log::info!("watcher stopped");
        }
    }

    /// What the Today screen shows.
    pub fn status(&self) -> WatchStatus {
        match self.with(Watcher::status) {
            Ok(Ok(status)) => WatchStatus {
                running: status.running,
                paused: status.paused,
                error: None,
                sources: status
                    .sources
                    .into_iter()
                    .map(|source| WatchSource {
                        id: source.id,
                        path: source.path,
                        enabled: source.enabled,
                        site_name: source.site.as_deref().and_then(|site| {
                            crate::folders::sites()
                                .ok()
                                .and_then(|config| config.site(site))
                                .map(|site| site.name.clone())
                        }),
                        site: source.site,
                        site_override: source.site_override,
                        state: source.state.as_str(),
                        error: source.error,
                        recursive: source.recursive,
                        poll_only: source.poll_only,
                        files: source.files,
                        hands: source.hands,
                        hands_today: source.hands_today,
                        quarantined: source.quarantined,
                        file_errors: source.file_errors,
                        pending: source.pending,
                        last_import_at: source.last_import_at,
                    })
                    .collect(),
            },
            Ok(Err(error)) => WatchStatus::failed(error.to_string()),
            Err(error) => WatchStatus::failed(error),
        }
    }
}

/// The watcher's events: the log, and a mark for the tray, which
/// [`spawn_tray_refresher`] redraws at most once a second (a backfill
/// imports thousands of files).
fn on_event(dirty: &AtomicBool, event: &WatchEvent) {
    match event {
        WatchEvent::Imported {
            path,
            inserted,
            duplicates,
            quarantined,
            ..
        } => {
            log::debug!(
                "imported {}: {inserted} new, {duplicates} known, {quarantined} refused",
                path.display()
            );
            dirty.store(true, Ordering::Relaxed);
        }
        WatchEvent::FileError { path, error } => {
            log::warn!("{}: {error}", path.display());
        }
        WatchEvent::Source { .. } | WatchEvent::Paused(_) => {
            dirty.store(true, Ordering::Relaxed);
        }
    }
}

/// Refresh the tray when something changed, once a second, for the app's
/// lifetime.
pub fn spawn_tray_refresher<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("rail-tray-status".to_owned())
        .spawn(move || {
            loop {
                let Some(state) = app.try_state::<WatcherState>() else {
                    return;
                };
                if state.dirty.swap(false, Ordering::Relaxed) {
                    refresh_tray(&app, &state);
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    if let Err(error) = spawned {
        log::warn!("tray status thread: {error}");
    }
}

/// The tray's status line and its "Pause import" / "Resume import" item.
pub fn refresh_tray<R: Runtime>(app: &AppHandle<R>, state: &WatcherState) {
    let text = strings::tray();
    let status = state.status();
    let enabled: Vec<&WatchSource> = status
        .sources
        .iter()
        .filter(|source| source.state != SourceState::Disabled.as_str())
        .collect();
    let unreadable = enabled
        .iter()
        .filter(|source| {
            source.state == SourceState::Unavailable.as_str()
                || source.state == SourceState::Error.as_str()
        })
        .count();
    let line = if status.error.is_some() || !status.running {
        text.status_error.to_owned()
    } else if status.paused {
        text.status_paused.to_owned()
    } else if enabled.is_empty() {
        text.status_idle.to_owned()
    } else if unreadable > 0 {
        (text.status_unavailable)(unreadable)
    } else {
        let today = enabled
            .iter()
            .map(|source| u64::try_from(source.hands_today).unwrap_or(0))
            .sum();
        (text.status_watching)(enabled.len(), today)
    };
    let pause_label = if status.paused {
        text.resume_import
    } else {
        text.pause_import
    };
    let can_pause = status.running && (status.paused || !enabled.is_empty());
    for result in [
        tray::set_status(app, &line),
        tray::set_pause_text(app, pause_label),
        tray::set_pause_enabled(app, can_pause),
    ] {
        if let Err(error) = result {
            log::warn!("tray: {error}");
        }
    }
}

/// "Pause import" / "Resume import" in the tray.
pub fn toggle_pause<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<WatcherState>() else {
        return;
    };
    let result = state.with(|watcher| {
        if watcher.is_paused() {
            watcher.resume()
        } else {
            watcher.pause()
        }
    });
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("pause / resume: {error}"),
        Err(error) => log::warn!("pause / resume: {error}"),
    }
    // The coordinator applies it at once; show it without waiting.
    std::thread::sleep(Duration::from_millis(50));
    refresh_tray(app, &state);
}

/// The watcher's state for the Today screen (`rail_watch::WatcherStatus`).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    running: bool,
    paused: bool,
    /// Set when the watcher is not running, and why.
    error: Option<String>,
    sources: Vec<WatchSource>,
}

impl WatchStatus {
    fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::default()
        }
    }
}

/// One watched folder (`rail_watch::SourceStatus`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSource {
    id: i64,
    path: String,
    /// Switched on (a disabled folder keeps its hands).
    enabled: bool,
    /// The room it is the default folder of (`sites.json` id), if known.
    site: Option<String>,
    /// That room's name in `sites.json`.
    site_name: Option<String>,
    /// The room chosen by hand: a parser forced for every file (R1.5).
    site_override: Option<String>,
    /// `watching`, `polling`, `unavailable`, `error`, `disabled`.
    state: &'static str,
    error: Option<String>,
    recursive: bool,
    poll_only: bool,
    files: i64,
    hands: i64,
    hands_today: i64,
    quarantined: i64,
    /// Files whose last read failed.
    file_errors: u32,
    /// Files with an unfinished hand at the end.
    pending: u32,
    /// ms since the epoch.
    last_import_at: Option<i64>,
}

#[tauri::command]
pub async fn watcher_status(state: State<'_, WatcherState>) -> Result<WatchStatus, String> {
    Ok(state.status())
}

/// Pause (`true`) or resume import, from the window.
#[tauri::command]
pub fn set_import_paused(state: State<'_, WatcherState>, paused: bool) -> Result<(), String> {
    state
        .with(|watcher| {
            if paused {
                watcher.pause()
            } else {
                watcher.resume()
            }
        })?
        .map_err(|error| error.to_string())?;
    state.dirty.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Without a store there is no watcher, and the status says why.
    #[test]
    fn no_store_no_watcher() {
        let state = WatcherState {
            watcher: Mutex::new(None),
            error: Some("the store is not open".to_owned()),
            dirty: Arc::new(AtomicBool::new(false)),
        };
        let status = state.status();
        assert!(!status.running);
        assert_eq!(status.error.as_deref(), Some("the store is not open"));
        state.stop();
    }

    /// The watcher starts on a real store, reports its folders, and stops
    /// before the store closes.
    #[test]
    fn starts_on_a_store_and_stops_first() {
        let dir = std::env::temp_dir().join(format!("rail-app-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let writer = store
            .store
            .as_ref()
            .expect("open")
            .writer()
            .expect("writer");
        let folder = dir.join("hh");
        std::fs::create_dir_all(&folder).expect("folder");
        let watcher = Watcher::start(
            store.store.as_ref().expect("open").path(),
            writer,
            WatchConfig::default(),
            |_| {},
        )
        .expect("start");
        let id = watcher.add_source(&folder, true, Some(false)).expect("add");
        let state = WatcherState {
            watcher: Mutex::new(Some(watcher)),
            error: None,
            dirty: Arc::new(AtomicBool::new(false)),
        };
        let status = state.status();
        assert!(status.running);
        assert_eq!(status.sources.len(), 1);
        assert_eq!(status.sources[0].id, id);
        state.stop();
        assert!(state.with(|_| ()).is_err());
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
