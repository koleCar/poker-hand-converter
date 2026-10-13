//! First run (R1.4; guideline §3 "Prvo pokretanje", §6): find the rooms'
//! default hand-history folders on this computer, let the user confirm
//! them, and watch the confirmed ones - importing everything already there,
//! or only the hands written from now on.
//!
//! - `discover_folders`: `rail_watch::discover` over the shipped
//!   `config/sites.json` for this OS, with the folders already watched
//!   marked, plus the rooms looked for (for the empty state).
//! - `add_folders`: `Watcher::add_source_with` per confirmed folder (its
//!   room, recursive, poll-only when on a network volume, "only new hands"
//!   or not).
//! - `pick_folder`: the system folder picker, for "Add a folder
//!   manually...".
//!
//! The shipped `sites.json` is loaded once ([`sites`]); fetching a newer
//! copy over HTTPS comes later (§3.6).

use std::path::PathBuf;
use std::sync::OnceLock;

use rail_config::Config;
use rail_watch::NewSource;
use rail_watch::discover::{self, Env, Limits, Os, Watched};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::watch::WatcherState;

/// The shipped `config/sites.json`, loaded once.
pub fn sites() -> Result<&'static Config, String> {
    static SITES: OnceLock<Result<Config, String>> = OnceLock::new();
    SITES
        .get_or_init(|| {
            rail_config::load_shipped(&rail_core::parsers::REGISTRATION_ORDER).map_err(|error| {
                log::error!("the shipped sites.json does not load: {error}");
                error.to_string()
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// What discovery found, for the first-run screen.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// `macos` / `windows`; `None` where no room has a client (Linux).
    os: Option<&'static str>,
    folders: Vec<FoundFolder>,
    /// Every room with a default folder for this OS, looked for whether
    /// found or not, in `sites.json` order.
    rooms: Vec<RoomLookedFor>,
}

/// One folder found (`rail_watch::discover::Found`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFolder {
    site: String,
    name: String,
    path: String,
    /// Hand-history files in it; a lower bound when `complete` is false.
    files: u64,
    complete: bool,
    /// The newest file's mtime, ms since the epoch.
    newest_ms: Option<i64>,
    /// The template was seen on a real install.
    verified: bool,
    /// When the room's file names are unknown: files sampled, and how many
    /// of them the core says are this room's.
    sample_looked: Option<u32>,
    sample_claimed: Option<u32>,
    /// Watched already.
    watched: bool,
}

/// A room discovery looks for on this OS.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLookedFor {
    site: String,
    name: String,
    /// Every one of its folder templates was seen on a real install.
    verified: bool,
}

/// Run discovery: off the main thread (it walks folders).
#[tauri::command]
pub async fn discover_folders(watcher: State<'_, WatcherState>) -> Result<Discovery, String> {
    let config = sites()?;
    let Some(env) = Env::current() else {
        return Ok(Discovery {
            os: None,
            folders: Vec::new(),
            rooms: Vec::new(),
        });
    };
    let watched: Vec<Watched> = watcher
        .with(rail_watch::Watcher::status)
        .ok()
        .and_then(Result::ok)
        .map(|status| {
            status
                .sources
                .into_iter()
                .map(|source| Watched {
                    path: PathBuf::from(source.path),
                    recursive: source.recursive,
                })
                .collect()
        })
        .unwrap_or_default();
    let started = std::time::Instant::now();
    let found = discover::discover(config, &env, &watched, &Limits::default());
    log::info!(
        "discovery: {} folders in {} ms",
        found.len(),
        started.elapsed().as_millis()
    );
    let rooms = config
        .sites
        .iter()
        .filter(|site| !env.os.templates(site).is_empty())
        .map(|site| RoomLookedFor {
            site: site.id.clone(),
            name: site.name.clone(),
            verified: env.os.templates(site).iter().all(|entry| entry.verified),
        })
        .collect();
    Ok(Discovery {
        os: Some(match env.os {
            Os::Macos => "macos",
            Os::Windows => "windows",
        }),
        folders: found
            .into_iter()
            .map(|folder| FoundFolder {
                site: folder.site,
                name: folder.name,
                path: folder.path.display().to_string(),
                files: folder.files,
                complete: folder.complete,
                newest_ms: folder.newest_ms,
                verified: folder.verified,
                sample_looked: folder.sample.map(|sample| sample.looked),
                sample_claimed: folder.sample.map(|sample| sample.claimed),
                watched: folder.watched,
            })
            .collect(),
        rooms,
    })
}

/// A folder the user confirmed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedFolder {
    path: String,
    /// The room discovery found it for; `None` for a folder added by hand.
    site: Option<String>,
}

/// One folder added.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedFolder {
    path: String,
    id: i64,
    /// Files stored as read without importing ("only new hands").
    marked: u32,
}

/// Watch the confirmed folders (recursive; poll-only on a network
/// volume). `only_new`: the files there now are marked as read and only
/// hands written from now on are imported; otherwise everything is.
#[tauri::command]
pub async fn add_folders(
    watcher: State<'_, WatcherState>,
    folders: Vec<ConfirmedFolder>,
    only_new: bool,
) -> Result<Vec<AddedFolder>, String> {
    let config = sites().ok();
    let mut added = Vec::with_capacity(folders.len());
    for folder in folders {
        // A room id this build does not know is dropped, not stored.
        let site = folder
            .site
            .filter(|site| config.is_some_and(|config| config.site(site).is_some()));
        let options = NewSource {
            site,
            only_new,
            ..NewSource::default()
        };
        let path = crate::folder_settings::checked_folder(&folder.path)?;
        let result = watcher
            .with(|watcher| watcher.add_source_with(&path, &options))?
            .map_err(|error| format!("{}: {error}", folder.path))?;
        log::info!(
            "watching {} (folder {}, room {:?}, {})",
            folder.path,
            result.id,
            options.site,
            if only_new {
                format!("only new hands, {} files skipped", result.marked)
            } else {
                "importing everything".to_owned()
            }
        );
        added.push(AddedFolder {
            path: folder.path,
            id: result.id,
            marked: result.marked,
        });
    }
    watcher.mark_dirty();
    Ok(added)
}

/// The system folder picker. `None` when cancelled.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    // Not on the main thread: async commands run on the async runtime.
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_sites_load() {
        let config = sites().expect("loads");
        assert!(config.site("weplay").is_some());
        let globs = discover::file_globs(config);
        assert_eq!(globs.get("weplay").map(String::as_str), Some("HH*.txt"));
    }
}
