//! Crash-safe settings (docs/RAIL-PLAN.md R1.1).
//!
//! One JSON file, `settings.json`, in the OS config directory of the app
//! (`app_config_dir`). Every save is atomic: the new contents go to
//! `settings.json.tmp`, are flushed to disk, and the temp file is renamed
//! over the old one. A crash or power cut mid-save leaves either the old file
//! or the new one, never half of each; a stray `.tmp` from such a crash is
//! ignored and overwritten by the next save.
//!
//! The file carries a `version`. A file from a newer build is read for what
//! this build understands and never written back (it would drop the fields
//! this build does not know); a file that is not readable at all is moved
//! aside to `settings.json.corrupt` and the defaults are used, so a bad file
//! can be looked at rather than silently lost.
//!
//! Folders, rooms and the account are not here: they belong to the local
//! store (R1.2) and to sign-in (R1.7). This file is for preferences a fresh
//! install can live without.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The `version` this build writes.
pub const VERSION: u32 = 1;

/// The file name inside the app's config directory.
pub const FILE_NAME: &str = "settings.json";

/// Colour theme. `System` follows the OS (`prefers-color-scheme`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Dark,
    Light,
}

/// The settings document. Every field has a default, so a file missing a
/// field (an older version, or one edited by hand) still loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub theme: Theme,
    /// Start Rail when the user logs in (`tauri-plugin-autostart`). Off by
    /// default; the OS login item is reconciled with this on every start.
    pub start_at_login: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: VERSION,
            theme: Theme::default(),
            start_at_login: false,
        }
    }
}

/// How the file was found on start, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    /// Read and current.
    Ok,
    /// No file yet: defaults, written on the first change.
    Missing,
    /// An older version, upgraded in memory; written on the first change.
    Migrated { from: u32 },
    /// A newer version: read, never written by this build.
    Newer { found: u32 },
    /// Not readable; moved aside to `moved_to` (when the move worked) and
    /// replaced by the defaults.
    Corrupt {
        error: String,
        moved_to: Option<PathBuf>,
    },
}

/// The settings and where they live.
#[derive(Debug)]
pub struct Store {
    path: PathBuf,
    settings: Settings,
    /// False for a file written by a newer build.
    writable: bool,
}

impl Store {
    /// Load `path`, or the defaults; see [`Loaded`]. Never fails: settings
    /// are not worth refusing to start over.
    pub fn load(path: PathBuf) -> (Self, Loaded) {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return (Self::fresh(path), Loaded::Missing);
            }
            Err(error) => return Self::corrupt(path, error.to_string()),
        };
        match serde_json::from_slice::<Settings>(&bytes) {
            // Read as far as this build understands; `version` keeps the
            // newer number, which is what `update` refuses on.
            Ok(settings) if settings.version > VERSION => {
                let found = settings.version;
                (
                    Self {
                        path,
                        settings,
                        writable: false,
                    },
                    Loaded::Newer { found },
                )
            }
            Ok(mut settings) => {
                let from = settings.version;
                // No migration exists yet: version 1 is the first. A future
                // version adds its step here, before the stamp.
                settings.version = VERSION;
                let loaded = if from == VERSION {
                    Loaded::Ok
                } else {
                    Loaded::Migrated { from }
                };
                (
                    Self {
                        path,
                        settings,
                        writable: true,
                    },
                    loaded,
                )
            }
            Err(error) => Self::corrupt(path, error.to_string()),
        }
    }

    fn fresh(path: PathBuf) -> Self {
        Self {
            path,
            settings: Settings::default(),
            writable: true,
        }
    }

    fn corrupt(path: PathBuf, error: String) -> (Self, Loaded) {
        let aside = sibling(&path, ".corrupt");
        let moved_to = fs::rename(&path, &aside).ok().map(|()| aside);
        (Self::fresh(path), Loaded::Corrupt { error, moved_to })
    }

    pub fn get(&self) -> &Settings {
        &self.settings
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Change the settings and save them atomically. On a failed save the
    /// change is not kept in memory either, so what the UI shows is what is
    /// on disk.
    pub fn update(&mut self, change: impl FnOnce(&mut Settings)) -> Result<&Settings, SaveError> {
        if !self.writable {
            return Err(SaveError::NewerFile {
                found: self.settings.version,
            });
        }
        let mut next = self.settings.clone();
        change(&mut next);
        next.version = VERSION;
        let mut json = serde_json::to_vec_pretty(&next).map_err(SaveError::Json)?;
        json.push(b'\n');
        write_atomic(&self.path, &json).map_err(SaveError::Io)?;
        self.settings = next;
        Ok(&self.settings)
    }
}

/// Why a change was not saved.
#[derive(Debug)]
pub enum SaveError {
    NewerFile { found: u32 },
    Json(serde_json::Error),
    Io(io::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NewerFile { found } => write!(
                f,
                "settings were written by a newer Rail (version {found}); this version does not change them"
            ),
            Self::Json(error) => write!(f, "settings could not be encoded: {error}"),
            Self::Io(error) => write!(f, "settings could not be saved: {error}"),
        }
    }
}

impl std::error::Error for SaveError {}

/// `path` with `suffix` appended to its file name.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Write `bytes` to `path` so that `path` holds either its old contents or
/// all of `bytes`, whatever happens mid-write: temp file in the same
/// directory, flushed, renamed over `path` (atomic on one volume, on
/// Windows too - `std::fs::rename` replaces an existing file there).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no directory"))?;
    fs::create_dir_all(dir)?;
    let tmp = sibling(path, ".tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    // The rename itself is durable once the directory entry is: flush the
    // directory where the OS allows opening one.
    #[cfg(unix)]
    if let Ok(dir) = fs::File::open(dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    /// A fresh, empty directory under the system temp dir; removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("rail-app-settings-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("nested").join(FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_gives_defaults_and_writes_nothing() {
        let dir = TempDir::new();
        let (store, loaded) = Store::load(dir.file());
        assert_eq!(loaded, Loaded::Missing);
        assert_eq!(store.get(), &Settings::default());
        assert!(!dir.file().exists());
    }

    #[test]
    fn a_change_round_trips_and_leaves_no_temp_file() {
        let dir = TempDir::new();
        let (mut store, _) = Store::load(dir.file());
        store
            .update(|s| {
                s.theme = Theme::Light;
                s.start_at_login = true;
            })
            .expect("save");
        assert!(!sibling(&dir.file(), ".tmp").exists());

        let (again, loaded) = Store::load(dir.file());
        assert_eq!(loaded, Loaded::Ok);
        assert_eq!(again.get().theme, Theme::Light);
        assert!(again.get().start_at_login);
        assert_eq!(again.get().version, VERSION);
    }

    #[test]
    fn the_file_is_camel_case_json_with_a_version() {
        let dir = TempDir::new();
        let (mut store, _) = Store::load(dir.file());
        store.update(|s| s.theme = Theme::Dark).expect("save");
        let text = fs::read_to_string(dir.file()).expect("read");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(
            value,
            serde_json::json!({ "version": VERSION, "theme": "dark", "startAtLogin": false })
        );
    }

    #[test]
    fn a_stray_temp_file_from_a_crash_is_ignored() {
        let dir = TempDir::new();
        let (mut store, _) = Store::load(dir.file());
        store.update(|s| s.theme = Theme::Dark).expect("save");
        // A crash between writing the temp file and the rename.
        fs::write(sibling(&dir.file(), ".tmp"), b"{\"theme\":\"li").expect("write tmp");

        let (mut again, loaded) = Store::load(dir.file());
        assert_eq!(loaded, Loaded::Ok);
        assert_eq!(again.get().theme, Theme::Dark);
        again
            .update(|s| s.theme = Theme::Light)
            .expect("save over the stray");
        assert_eq!(Store::load(dir.file()).0.get().theme, Theme::Light);
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_and_defaults_used() {
        let dir = TempDir::new();
        write_atomic(&dir.file(), b"not json").expect("write");
        let (store, loaded) = Store::load(dir.file());
        assert_eq!(store.get(), &Settings::default());
        let Loaded::Corrupt { moved_to, .. } = loaded else {
            panic!("expected Corrupt, got {loaded:?}");
        };
        let moved_to = moved_to.expect("moved aside");
        assert_eq!(fs::read(moved_to).expect("read aside"), b"not json");
        assert!(!dir.file().exists());
    }

    #[test]
    fn missing_and_unknown_fields_are_tolerated() {
        let dir = TempDir::new();
        write_atomic(
            &dir.file(),
            br#"{"version":1,"theme":"light","later":true}"#,
        )
        .expect("write");
        let (store, loaded) = Store::load(dir.file());
        assert_eq!(loaded, Loaded::Ok);
        assert_eq!(store.get().theme, Theme::Light);
        assert!(!store.get().start_at_login);
    }

    #[test]
    fn a_file_without_a_version_is_migrated() {
        let dir = TempDir::new();
        write_atomic(&dir.file(), br#"{"theme":"dark"}"#).expect("write");
        let (store, loaded) = Store::load(dir.file());
        // `version` defaults to the current one when absent; a real older
        // version number is reported as a migration.
        assert_eq!(loaded, Loaded::Ok);
        assert_eq!(store.get().theme, Theme::Dark);

        write_atomic(&dir.file(), br#"{"version":0,"theme":"dark"}"#).expect("write");
        let (store, loaded) = Store::load(dir.file());
        assert_eq!(loaded, Loaded::Migrated { from: 0 });
        assert_eq!(store.get().version, VERSION);
    }

    #[test]
    fn a_newer_file_is_read_but_never_written() {
        let dir = TempDir::new();
        let newer = br#"{"version":99,"theme":"light","fromTheFuture":1}"#;
        write_atomic(&dir.file(), newer).expect("write");
        let (mut store, loaded) = Store::load(dir.file());
        assert_eq!(loaded, Loaded::Newer { found: 99 });
        assert_eq!(store.get().theme, Theme::Light);
        assert!(matches!(
            store.update(|s| s.theme = Theme::Dark),
            Err(SaveError::NewerFile { found: 99 })
        ));
        assert_eq!(fs::read(dir.file()).expect("read"), newer);
        assert_eq!(store.get().theme, Theme::Light);
    }
}
