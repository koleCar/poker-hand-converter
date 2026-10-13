//! Settings, Folders (R1.5; guideline §3 "Upravljanje mapama"): the watched
//! folders and everything the user can change about them.
//!
//! The list itself is `watcher_status` (`watch.rs`); these commands are
//! thin: they check their input and call the watcher (`rail-watch`), whose
//! methods write `sources` (`rail-store`) and reload. Paths from the window
//! must be absolute, without `.` / `..` components, and name an existing
//! directory ([`checked_folder`]); folder ids must exist.
//!
//! - `add_folder`: a folder picked by hand (external and network drives
//!   too; poll-only when on a network volume unless the user says),
//!   "import everything" or "only new hands";
//! - `set_folder_path`: a new path for a folder (a moved folder continues
//!   from its offsets, another one is read from scratch; see
//!   `Watcher::set_source_path`);
//! - `set_folder_room`: the room chosen by hand when detection fails (a
//!   parser forced for every file of the folder, `sources.site_override`);
//! - `set_folder_enabled`, `set_folder_recursive`, `set_folder_poll_only`;
//! - `remove_folder` (its hands stay);
//! - `folder_rooms`: the rooms that can be chosen; `folder_quarantine`: a
//!   folder's refused hands with their reasons (the raw text and "try
//!   again after an update" are `quarantine.rs`, R1.6).

use std::path::{Component, Path, PathBuf};

use rail_core::detect::SiteParser;
use rail_watch::NewSource;
use serde::Serialize;
use tauri::State;

use crate::commands::StoreState;
use crate::watch::WatcherState;

/// How many refused hands of a folder the list shows at most.
pub const QUARANTINE_LIMIT: u32 = 200;

/// A folder path from the window, checked: absolute, no `..` component (no
/// way to name one folder through another), no NUL, and an existing
/// directory (following links, as the watcher does). Returned rebuilt from
/// its components, so `a/./b` and a trailing separator name the folder as
/// `a/b` does (one `sources` row per folder).
pub fn checked_folder(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("no folder was given".to_owned());
    }
    if path.contains('\0') {
        return Err("the folder's path is not valid".to_owned());
    }
    let folder = Path::new(path);
    if !folder.is_absolute() {
        return Err(format!("{path}: not a full path"));
    }
    if folder
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("{path}: the path may not contain .."));
    }
    let folder: PathBuf = folder.components().collect();
    match std::fs::metadata(&folder) {
        Ok(metadata) if metadata.is_dir() => Ok(folder),
        Ok(_) => Err(format!("{path}: not a folder")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{path}: no such folder"))
        }
        Err(error) => Err(format!("{path}: {error}")),
    }
}

fn found(found: bool, id: i64) -> Result<(), String> {
    if found {
        Ok(())
    } else {
        Err(format!("there is no folder {id}"))
    }
}

/// Run `f` on the watcher, mapping both failures to text, and have the
/// tray redrawn.
fn on_watcher<T>(
    state: &WatcherState,
    f: impl FnOnce(&rail_watch::Watcher) -> rail_watch::Result<T>,
) -> Result<T, String> {
    let result = state.with(f)?.map_err(|error| error.to_string());
    state.mark_dirty();
    result
}

/// A folder added by hand.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedFolder {
    id: i64,
    path: String,
    /// Files stored as read without importing ("only new hands").
    marked: u32,
}

/// Watch a folder picked by hand. `poll_only: None` decides by whether it
/// is on a network volume (a share mapped to a drive letter is not
/// detected: the user can tick "poll only").
#[tauri::command]
pub async fn add_folder(
    watcher: State<'_, WatcherState>,
    path: String,
    only_new: bool,
    recursive: bool,
    poll_only: Option<bool>,
) -> Result<AddedFolder, String> {
    let folder = checked_folder(&path)?;
    let options = NewSource {
        recursive,
        poll_only,
        site: None,
        only_new,
    };
    let added = on_watcher(&watcher, |w| w.add_source_with(&folder, &options))?;
    log::info!(
        "folder {} added by hand: {} ({})",
        added.id,
        folder.display(),
        if only_new {
            format!("only new hands, {} files skipped", added.marked)
        } else {
            "importing everything".to_owned()
        }
    );
    Ok(AddedFolder {
        id: added.id,
        path: folder.display().to_string(),
        marked: added.marked,
    })
}

/// What a new path did to a folder's files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMoved {
    /// Files found again under the new path: they continue from where
    /// they were read to.
    moved: u32,
    /// Files of the new folder read before: they keep their own offsets.
    adopted: u32,
    /// Files not in the new folder: their hands stay, without a folder.
    detached: u32,
    /// Files of the new folder stored as read ("only new hands").
    marked: u32,
}

/// Give a folder a new path (the user picked it again elsewhere).
#[tauri::command]
pub async fn set_folder_path(
    watcher: State<'_, WatcherState>,
    id: i64,
    path: String,
    only_new: bool,
) -> Result<FolderMoved, String> {
    let folder = checked_folder(&path)?;
    let moved = on_watcher(&watcher, |w| w.set_source_path(id, &folder, only_new))?;
    found(moved.change.found, id)?;
    Ok(FolderMoved {
        moved: moved.change.moved,
        adopted: moved.change.adopted,
        detached: moved.change.detached,
        marked: moved.marked,
    })
}

/// The room chosen by hand: a parser id from [`folder_rooms`], or `None`
/// to detect the room per file. Returns how many files are read again.
#[tauri::command]
pub async fn set_folder_room(
    watcher: State<'_, WatcherState>,
    id: i64,
    parser: Option<String>,
) -> Result<u32, String> {
    let change = on_watcher(&watcher, |w| {
        w.set_source_site_override(id, parser.as_deref())
    })?;
    found(change.found, id)?;
    Ok(change.reset)
}

/// Switch a folder on or off; its hands stay either way.
#[tauri::command]
pub async fn set_folder_enabled(
    watcher: State<'_, WatcherState>,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    found(
        on_watcher(&watcher, |w| w.set_source_enabled(id, enabled))?,
        id,
    )
}

/// Watch a folder's subfolders too, or its top level only.
#[tauri::command]
pub async fn set_folder_recursive(
    watcher: State<'_, WatcherState>,
    id: i64,
    recursive: bool,
) -> Result<(), String> {
    found(
        on_watcher(&watcher, |w| w.set_source_recursive(id, recursive))?,
        id,
    )
}

/// Read a folder by polling only (a network share whose notifications
/// do not arrive), or with notifications again.
#[tauri::command]
pub async fn set_folder_poll_only(
    watcher: State<'_, WatcherState>,
    id: i64,
    poll_only: bool,
) -> Result<(), String> {
    found(
        on_watcher(&watcher, |w| w.set_source_poll_only(id, poll_only))?,
        id,
    )
}

/// Stop watching a folder. Its hands stay.
#[tauri::command]
pub async fn remove_folder(watcher: State<'_, WatcherState>, id: i64) -> Result<(), String> {
    found(on_watcher(&watcher, |w| w.remove_source(id))?, id)
}

/// A room the user can choose for a folder.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomChoice {
    /// The parser id (`sources.site_override`).
    parser: &'static str,
    /// Its name in `sites.json` (the entry of the same id, else the first
    /// entry it parses for), else the id.
    name: String,
}

/// Every parser this build has, as a room to choose, sorted by name.
pub fn room_choices() -> Vec<RoomChoice> {
    let config = crate::folders::sites().ok();
    let mut rooms: Vec<RoomChoice> = rail_core::parsers::builtin()
        .parsers()
        .map(SiteParser::id)
        .map(|parser| {
            let name = config
                .and_then(|config| {
                    config.site(parser).or_else(|| {
                        config
                            .sites
                            .iter()
                            .find(|site| site.parser.as_deref() == Some(parser))
                    })
                })
                .map_or_else(|| parser.to_owned(), |site| site.name.clone());
            RoomChoice { parser, name }
        })
        .collect();
    rooms.sort_by_key(|room| room.name.to_lowercase());
    rooms
}

#[tauri::command]
pub fn folder_rooms() -> Vec<RoomChoice> {
    room_choices()
}

/// A reason and how many of a folder's refused hands have it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCount {
    reason: String,
    count: i64,
}

impl ReasonCount {
    pub const fn new(reason: String, count: i64) -> Self {
        Self { reason, count }
    }

    pub const fn count(&self) -> i64 {
        self.count
    }
}

/// One refused hand (no raw text: `quarantine_raw_text` fetches it).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedHand {
    id: i64,
    file: String,
    stage: String,
    reason: String,
    message: String,
    detected_site: Option<String>,
    /// The version of the parser that refused it (`0`: none did).
    parser_version: String,
    /// ms since the epoch.
    last_seen: i64,
}

impl From<rail_store::read::QuarantineEntry> for RefusedHand {
    fn from(entry: rail_store::read::QuarantineEntry) -> Self {
        Self {
            id: entry.id,
            file: entry.file_path,
            stage: entry.stage,
            reason: entry.reason,
            message: entry.message,
            detected_site: entry.detected_site,
            parser_version: entry.parser_version,
            last_seen: entry.last_seen,
        }
    }
}

/// A folder's quarantine: counts per reason, and the most recent entries.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderQuarantine {
    reasons: Vec<ReasonCount>,
    entries: Vec<RefusedHand>,
    /// More entries exist than are listed.
    truncated: bool,
    /// Refused by an older parser version: "Try again after an update"
    /// reads them again (R1.6).
    retryable: crate::quarantine::Retryable,
}

#[tauri::command]
pub async fn folder_quarantine(
    store: State<'_, StoreState>,
    id: i64,
) -> Result<FolderQuarantine, String> {
    let store = store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())?;
    let reader = store.reader();
    let reasons: Vec<ReasonCount> = reader
        .source_quarantine_reasons(id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(reason, count)| ReasonCount { reason, count })
        .collect();
    let entries: Vec<RefusedHand> = reader
        .source_quarantine(id, QUARANTINE_LIMIT)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(RefusedHand::from)
        .collect();
    let total: i64 = reasons.iter().map(|reason| reason.count).sum();
    let retryable = reader
        .stale_refusals(&rail_watch::Watcher::parser_versions(), Some(id))
        .map_err(|error| error.to_string())?
        .into();
    Ok(FolderQuarantine {
        truncated: usize::try_from(total).is_ok_and(|total| total > entries.len()),
        reasons,
        entries,
        retryable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rail-app-folders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn folder_paths_are_checked() {
        let dir = scratch("check");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").expect("file");
        let text = |path: &Path| path.display().to_string();

        assert_eq!(checked_folder(&text(&dir)), Ok(dir.clone()));
        assert!(checked_folder("").is_err());
        assert!(checked_folder("relative/folder").is_err());
        assert!(checked_folder(&text(&file)).is_err(), "a file");
        assert!(checked_folder(&text(&dir.join("missing"))).is_err());
        assert!(checked_folder(&format!("{}\0x", text(&dir))).is_err());
        // Through `..`, even when it resolves to a real folder.
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("sub");
        assert!(checked_folder(&text(&sub.join(".."))).is_err());
        // `.` and a trailing separator name the same folder.
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            checked_folder(&format!("{}{sep}.{sep}sub{sep}", text(&dir))),
            Ok(sub.clone())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_parser_is_a_room_to_choose() {
        let rooms = room_choices();
        assert_eq!(rooms.len(), rail_core::parsers::REGISTRATION_ORDER.len());
        let stars = rooms
            .iter()
            .find(|room| room.parser == "pokerstars")
            .expect("PokerStars");
        assert_eq!(stars.name, "PokerStars");
        let mut names: Vec<String> = rooms.iter().map(|room| room.name.to_lowercase()).collect();
        let sorted = names.clone();
        names.sort();
        assert_eq!(names, sorted, "sorted by name");
    }
}
