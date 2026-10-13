//! The commands the window calls (`invoke` in `app/src/lib/ipc.ts`, whose
//! types mirror these). JSON field names are camelCase on both sides.

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use rail_core::detect::SiteParser;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_autostart::ManagerExt;

use crate::settings::{Settings, Store, Theme};

/// The settings store, as app state.
#[derive(Debug)]
pub struct SettingsState(pub Mutex<Store>);

impl SettingsState {
    fn with<T>(&self, f: impl FnOnce(&mut Store) -> T) -> T {
        let mut store = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut store)
    }
}

/// What the core in this build is: the link between the shell and
/// `rail-core` / `rail-config`, shown under Settings, About.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    /// The workspace version, which `rail-core` shares with the app.
    core_version: &'static str,
    /// `rail_core::PHF_SCHEMA`.
    phf_schema: &'static str,
    /// The built-in parsers, in registration order.
    parsers: Vec<&'static str>,
    /// The `sites.json` version this build reads.
    config_version: u32,
    /// Entries in the shipped `config/sites.json`, when it loads.
    sites: Option<usize>,
    /// Why it did not load (it always should: `cargo test` checks it).
    config_error: Option<String>,
}

#[tauri::command]
pub fn core_info() -> CoreInfo {
    let parsers: Vec<&'static str> = rail_core::parsers::builtin()
        .parsers()
        .map(SiteParser::id)
        .collect();
    let (sites, config_error) = match rail_config::load_shipped(&parsers) {
        Ok(config) => (Some(config.sites.len()), None),
        Err(error) => {
            log::error!("the shipped sites.json does not load: {error}");
            (None, Some(error.to_string()))
        }
    };
    CoreInfo {
        core_version: env!("CARGO_PKG_VERSION"),
        phf_schema: rail_core::PHF_SCHEMA,
        parsers,
        config_version: rail_config::VERSION,
        sites,
        config_error,
    }
}

/// Where the app keeps its files, and how it was built.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    identifier: String,
    log_dir: Option<String>,
    settings_file: String,
    /// A debug build: the dev-only commands exist.
    debug: bool,
}

#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>, settings: State<'_, SettingsState>) -> AppInfo {
    let config = app.config();
    AppInfo {
        version: app.package_info().version.to_string(),
        identifier: config.identifier.clone(),
        log_dir: app
            .path()
            .app_log_dir()
            .ok()
            .map(|dir| dir.display().to_string()),
        settings_file: settings.with(|store| store.path().display().to_string()),
        debug: cfg!(debug_assertions),
    }
}

#[tauri::command]
pub fn get_settings(settings: State<'_, SettingsState>) -> Settings {
    settings.with(|store| store.get().clone())
}

#[tauri::command]
pub fn set_theme(settings: State<'_, SettingsState>, theme: Theme) -> Result<Settings, String> {
    settings.with(|store| {
        store
            .update(|s| s.theme = theme)
            .cloned()
            .map_err(|error| error.to_string())
    })
}

/// Turn start-at-login on or off: the OS login item first, then the setting,
/// so the setting never claims what the OS refused.
#[tauri::command]
pub fn set_start_at_login<R: Runtime>(
    app: AppHandle<R>,
    settings: State<'_, SettingsState>,
    enabled: bool,
) -> Result<Settings, String> {
    apply_login_item(&app, enabled)?;
    settings.with(|store| {
        store
            .update(|s| s.start_at_login = enabled)
            .cloned()
            .map_err(|error| error.to_string())
    })
}

/// Make the OS login item match `enabled`.
pub fn apply_login_item<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let autostart = app.autolaunch();
    let result = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    result.map_err(|error| {
        log::warn!("start at login ({enabled}) failed: {error}");
        error.to_string()
    })
}

/// On start: the login item follows the setting (it may have been removed
/// in the OS settings, or the app moved).
pub fn reconcile_login_item<R: Runtime>(app: &AppHandle<R>, wanted: bool) {
    match app.autolaunch().is_enabled() {
        Ok(actual) if actual == wanted => {}
        Ok(actual) => {
            log::info!(
                "start at login is {actual} in the OS, {wanted} in settings; applying settings"
            );
            let _ = apply_login_item(app, wanted);
        }
        Err(error) => log::warn!("start at login state unknown: {error}"),
    }
}

/// The local store (R1.2), as app state. `store` is `None` when it did not
/// open (`error` says why); the app runs on, and the Today screen shows it.
#[derive(Debug)]
pub struct StoreState {
    pub path: PathBuf,
    pub store: Option<rail_store::Store>,
    pub error: Option<String>,
}

impl StoreState {
    /// Open (create, migrate) the store at `path`.
    pub fn open(path: PathBuf) -> Self {
        match rail_store::Store::open(&path) {
            Ok(store) => {
                log::info!("store open at {}", path.display());
                Self {
                    path,
                    store: Some(store),
                    error: None,
                }
            }
            Err(error) => {
                log::error!("the store at {} did not open: {error}", path.display());
                Self {
                    path,
                    store: None,
                    error: Some(error.to_string()),
                }
            }
        }
    }

    /// What the Today screen shows.
    pub fn status(&self) -> StoreStatus {
        let path = self.path.display().to_string();
        let counts = match &self.store {
            Some(store) => store.status().map_err(|error| error.to_string()),
            None => Err(self
                .error
                .clone()
                .unwrap_or_else(|| "the store is not open".to_owned())),
        };
        match counts {
            Ok(counts) => StoreStatus {
                path,
                error: None,
                schema_version: counts.schema_version,
                hands: counts.hands,
                hands_today: counts.hands_today,
                files: counts.files,
                files_with_errors: counts.files_with_errors,
                sources: counts.sources,
                quarantined: counts.quarantined,
                unsupported: counts.unsupported,
                outbox: counts.outbox,
            },
            Err(error) => StoreStatus {
                path,
                error: Some(error),
                ..StoreStatus::default()
            },
        }
    }
}

/// The store's counts (`rail_store::StoreStatus`), or why there are none.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    path: String,
    /// Set when the store is not open or the counts failed.
    error: Option<String>,
    schema_version: u32,
    hands: u64,
    /// Stored since local midnight.
    hands_today: u64,
    files: u64,
    files_with_errors: u64,
    /// Watched folders (R1.3 / R1.5).
    sources: u64,
    quarantined: u64,
    /// Formats no parser reads (R0.11's registry).
    unsupported: u64,
    /// Hands waiting to be synced (R1.9).
    outbox: u64,
}

/// The local store's counts for the Today screen. Async: it runs off the
/// main thread, so a slow count never blocks the window.
#[tauri::command]
pub async fn store_status(store: State<'_, StoreState>) -> Result<StoreStatus, String> {
    Ok(store.status())
}

#[cfg(test)]
mod tests {
    use super::{StoreState, core_info};

    /// The store opens (creating its directory), migrates, and reports
    /// counts; one that cannot open reports why instead.
    #[test]
    fn store_state_opens_and_reports() {
        let dir = std::env::temp_dir().join(format!("rail-app-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = StoreState::open(dir.join("data").join(rail_store::FILE_NAME));
        let status = state.status();
        assert_eq!(status.error, None);
        assert_eq!(status.schema_version, rail_store::migrate::LATEST);
        assert_eq!((status.hands, status.files, status.outbox), (0, 0, 0));
        drop(state);

        // A directory where the file should be: it cannot open.
        let blocked = dir.join("blocked");
        std::fs::create_dir_all(&blocked).expect("dir");
        let state = StoreState::open(blocked);
        assert!(state.store.is_none());
        assert!(state.status().error.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The shell reaches the core and the shipped config: every built-in
    /// parser, and a `sites.json` that loads against them.
    #[test]
    fn core_info_reaches_the_core_and_the_config() {
        let info = core_info();
        assert_eq!(info.phf_schema, rail_core::PHF_SCHEMA);
        assert_eq!(
            info.parsers.len(),
            rail_core::parsers::builtin().parsers().count()
        );
        assert!(info.parsers.contains(&"pokerstars"));
        assert_eq!(info.config_error, None);
        assert!(info.sites.is_some_and(|sites| sites >= info.parsers.len()));
    }
}
