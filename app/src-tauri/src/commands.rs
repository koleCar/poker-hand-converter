//! The commands the window calls (`invoke` in `app/src/lib/ipc.ts`, whose
//! types mirror these). JSON field names are camelCase on both sides.

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

#[cfg(test)]
mod tests {
    use super::core_info;

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
