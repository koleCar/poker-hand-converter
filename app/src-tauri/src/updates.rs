//! Settings, Updates: a newer Rail from the release, checked, downloaded and
//! installed from inside the app (`tauri-plugin-updater`).
//!
//! Where the answer comes from: the release workflow
//! (`.github/workflows/release.yml`) publishes `latest.json` beside the
//! installers of every full release, and `tauri.conf.json` points the
//! updater at `releases/latest/download/latest.json`. A pre-release is never
//! "latest", so it is never offered. The manifest names, per platform, the
//! package to download and its minisign signature; the package is verified
//! against the public key in `tauri.conf.json` before anything is installed,
//! so a package the release key did not sign is refused.
//!
//! The flow, one step at a time and each one the user's (nothing downloads
//! or installs on its own):
//!
//! 1. **Check** - "Check for updates" in Settings, and (setting
//!    `checkForUpdates`, on by default) once shortly after start and then
//!    every few hours. An automatic check that fails says nothing; a manual
//!    one says why.
//! 2. **Download** - the package into memory, its progress reported to the
//!    window, then verified. A failed download can be tried again.
//! 3. **Install and restart** - macOS: the new `Rail.app` replaces this one
//!    in place, then the app restarts (the usual exit stops the HUD, sync,
//!    the watcher and the statistics pass first). Windows: the NSIS
//!    installer runs in passive mode (a progress bar, no questions) and
//!    starts Rail again; the app stops its background work - the HUD
//!    sidecar above all, whose `.exe` the installer must replace - and exits.
//!
//! The window hears every change as [`CHANGED_EVENT`] with the new
//! [`UpdateStatus`].

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::commands::SettingsState;

/// The event the window listens to; its payload is the [`UpdateStatus`].
pub const CHANGED_EVENT: &str = "updates-changed";

/// The first automatic check: after start has settled (the store, the
/// statistics pass and a backfill come first).
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(60);
/// Then every few hours, for an app that stays in the tray for days.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// A check is one small JSON file.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Download progress reaches the window at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

/// Which step failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Check,
    Download,
    Install,
}

/// Why a step failed, as far as the window words it differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailKind {
    /// No connection, a timeout, a server error.
    Network,
    /// The latest release has no `latest.json` (yet).
    NoRelease,
    /// The manifest has no package for this computer.
    NoBuild,
    /// The package's signature is not the release key's.
    Signature,
    /// Anything else; `reason` says what.
    Other,
}

/// Where the update stands.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Phase {
    /// Not checked since start.
    Idle,
    Checking,
    /// The last check found nothing newer.
    UpToDate,
    /// A newer version, not downloaded.
    Available {
        version: String,
        /// The release notes, as published.
        notes: Option<String>,
        /// When it was published, ms since the epoch.
        date_ms: Option<i64>,
    },
    Downloading {
        version: String,
        downloaded: u64,
        /// `None` when the server did not say.
        total: Option<u64>,
    },
    /// Downloaded and verified: "Install and restart".
    Ready {
        version: String,
        notes: Option<String>,
    },
    /// The install is running; the app restarts or exits next.
    Installing {
        version: String,
    },
    Failed {
        stage: Stage,
        kind: FailKind,
        reason: String,
        /// The version it was about, past the check.
        version: Option<String>,
    },
}

/// Why this copy cannot install an update itself (it can still check).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallBlocker {
    /// A debug build (`tauri dev`): there is no bundle to replace.
    DevBuild,
    /// macOS: run from the disk image or from a quarantined download
    /// (App Translocation), a read-only copy. Moving Rail to Applications
    /// fixes it.
    ReadOnlyLocation,
}

/// What the window shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// This build's version.
    pub current: String,
    pub phase: Phase,
    /// The last check that got an answer, ms since the epoch.
    pub last_checked_ms: Option<i64>,
    /// The setting: check by itself.
    pub automatic: bool,
    pub install_blocker: Option<InstallBlocker>,
}

#[derive(Default)]
struct Inner {
    phase: Option<Phase>,
    last_checked_ms: Option<i64>,
    /// The update the last check found.
    update: Option<Update>,
    /// Its package, downloaded and verified.
    package: Option<Arc<Vec<u8>>>,
}

/// The updater's state, managed by the app.
#[derive(Default)]
pub struct UpdatesState {
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for UpdatesState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdatesState")
            .field("phase", &self.phase())
            .finish_non_exhaustive()
    }
}

impl UpdatesState {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut inner)
    }

    fn phase(&self) -> Phase {
        self.with(|inner| inner.phase.clone().unwrap_or(Phase::Idle))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A step in flight: a second click does not start another.
fn busy(phase: &Phase) -> bool {
    matches!(
        phase,
        Phase::Checking | Phase::Downloading { .. } | Phase::Installing { .. }
    )
}

fn classify(error: &UpdaterError) -> FailKind {
    match error {
        UpdaterError::ReleaseNotFound => FailKind::NoRelease,
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => FailKind::NoBuild,
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            FailKind::Signature
        }
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => FailKind::Network,
        _ => FailKind::Other,
    }
}

/// Why this copy cannot install, if it cannot.
fn install_blocker() -> Option<InstallBlocker> {
    if cfg!(debug_assertions) {
        return Some(InstallBlocker::DevBuild);
    }
    if cfg!(target_os = "macos") {
        let exe = std::env::current_exe().ok()?;
        let path = exe.to_string_lossy();
        if path.starts_with("/Volumes/") || path.contains("/AppTranslocation/") {
            return Some(InstallBlocker::ReadOnlyLocation);
        }
    }
    None
}

fn automatic<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<SettingsState>()
        .is_some_and(|settings| settings.get().check_for_updates)
}

/// The status, for the window.
pub fn status<R: Runtime>(app: &AppHandle<R>, state: &UpdatesState) -> UpdateStatus {
    let (phase, last_checked_ms) = state.with(|inner| {
        (
            inner.phase.clone().unwrap_or(Phase::Idle),
            inner.last_checked_ms,
        )
    });
    UpdateStatus {
        current: app.package_info().version.to_string(),
        phase,
        last_checked_ms,
        automatic: automatic(app),
        install_blocker: install_blocker(),
    }
}

/// Set the phase and tell the window.
fn set_phase<R: Runtime>(app: &AppHandle<R>, state: &UpdatesState, phase: Phase) {
    state.with(|inner| inner.phase = Some(phase));
    notify(app, state);
}

fn notify<R: Runtime>(app: &AppHandle<R>, state: &UpdatesState) {
    if let Err(error) = app.emit(CHANGED_EVENT, status(app, state)) {
        log::debug!("{CHANGED_EVENT}: {error}");
    }
}

/// Ask the release whether there is a newer version. `manual`: the user
/// asked, so a failure is shown; an automatic check that fails leaves the
/// status as it was.
pub async fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let Some(state) = app.try_state::<UpdatesState>() else {
        return;
    };
    let before = state.phase();
    if busy(&before) {
        return;
    }
    // A package already downloaded stays ready: a check finds the same
    // version (or a newer one, which replaces it below).
    if manual {
        set_phase(app, &state, Phase::Checking);
    }

    // Windows: `install` starts the installer and exits the process
    // (`std::process::exit`, no exit event), so the background work stops
    // first - the HUD sidecar's `.exe` must not be running while the
    // installer replaces it. (A no-op elsewhere: there the restart's exit
    // event stops it.) The hook travels with the update this check finds.
    let handle = app.clone();
    let builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(move || {
            log::info!("updates: stopping the background work before the installer runs");
            crate::stop_background(&handle);
        });
    let result = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };

    match result {
        Ok(found) => {
            // Judged by the phase before this check: a manual check shows
            // "checking" meanwhile.
            let ready_version = state.with(|inner| {
                inner.last_checked_ms = Some(now_ms());
                match (&before, inner.package.is_some()) {
                    (Phase::Ready { version, .. }, true) => Some(version.clone()),
                    _ => None,
                }
            });
            match found {
                Some(update) if ready_version.as_deref() == Some(update.version.as_str()) => {
                    // The same version, downloaded already.
                    log::info!("updates: {} is downloaded and ready", update.version);
                    set_phase(app, &state, before_or_ready(before, &update));
                }
                Some(update) => {
                    log::info!(
                        "updates: {} is available (this is {})",
                        update.version,
                        update.current_version
                    );
                    let phase = Phase::Available {
                        version: update.version.clone(),
                        notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
                        date_ms: update
                            .date
                            .map(|date| date.unix_timestamp().saturating_mul(1000)),
                    };
                    state.with(|inner| {
                        inner.update = Some(update);
                        inner.package = None;
                    });
                    set_phase(app, &state, phase);
                }
                None => {
                    log::info!("updates: up to date");
                    state.with(|inner| {
                        inner.update = None;
                        inner.package = None;
                    });
                    set_phase(app, &state, Phase::UpToDate);
                }
            }
        }
        Err(error) => {
            let kind = classify(&error);
            if manual {
                log::warn!("updates: the check failed: {error}");
                set_phase(
                    app,
                    &state,
                    Phase::Failed {
                        stage: Stage::Check,
                        kind,
                        reason: error.to_string(),
                        version: None,
                    },
                );
            } else {
                log::info!("updates: the automatic check failed ({kind:?}): {error}");
            }
        }
    }
}

/// The phase a check leaves when it finds the version already downloaded.
fn before_or_ready(before: Phase, update: &Update) -> Phase {
    match before {
        ready @ Phase::Ready { .. } => ready,
        _ => Phase::Ready {
            version: update.version.clone(),
            notes: update.body.clone(),
        },
    }
}

/// Download the update the last check found, in the background.
fn start_download<R: Runtime>(app: &AppHandle<R>, state: &UpdatesState) -> Result<(), String> {
    let update = state.with(|inner| {
        if inner.phase.as_ref().is_some_and(busy) {
            return Err("an update step is already running".to_owned());
        }
        inner
            .update
            .clone()
            .ok_or_else(|| "there is no update to download; check first".to_owned())
    })?;
    let version = update.version.clone();
    let notes = update.body.clone().filter(|notes| !notes.trim().is_empty());
    set_phase(
        app,
        state,
        Phase::Downloading {
            version: version.clone(),
            downloaded: 0,
            total: None,
        },
    );
    log::info!("updates: downloading {version}");

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<UpdatesState>() else {
            return;
        };
        let mut downloaded: u64 = 0;
        let mut told = Instant::now();
        let result = update
            .download(
                |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    if told.elapsed() >= PROGRESS_EVERY {
                        told = Instant::now();
                        set_phase(
                            &app,
                            &state,
                            Phase::Downloading {
                                version: version.clone(),
                                downloaded,
                                total,
                            },
                        );
                    }
                },
                || {},
            )
            .await;
        match result {
            Ok(package) => {
                log::info!("updates: {version} downloaded and verified");
                state.with(|inner| inner.package = Some(Arc::new(package)));
                set_phase(&app, &state, Phase::Ready { version, notes });
            }
            Err(error) => {
                let kind = classify(&error);
                log::warn!("updates: the download of {version} failed: {error}");
                set_phase(
                    &app,
                    &state,
                    Phase::Failed {
                        stage: Stage::Download,
                        kind,
                        reason: error.to_string(),
                        version: Some(version),
                    },
                );
            }
        }
    });
    Ok(())
}

/// Install the downloaded package and restart into it.
fn install<R: Runtime>(app: &AppHandle<R>, state: &UpdatesState) -> Result<(), String> {
    if let Some(blocker) = install_blocker() {
        return Err(format!(
            "this copy of Rail cannot update itself ({blocker:?})"
        ));
    }
    let (update, package) =
        state.with(
            |inner| match (&inner.phase, &inner.update, &inner.package) {
                (Some(Phase::Ready { .. }), Some(update), Some(package)) => {
                    Ok((update.clone(), Arc::clone(package)))
                }
                _ => Err("there is no downloaded update to install".to_owned()),
            },
        )?;
    let version = update.version.clone();
    set_phase(
        app,
        state,
        Phase::Installing {
            version: version.clone(),
        },
    );
    log::info!("updates: installing {version}");

    // Windows: the hook set in `check` stops the background work, then the
    // installer starts and this process exits inside `install`.
    match update.install(package.as_slice()) {
        Ok(()) => {
            // macOS: the bundle was replaced; the restart runs the new one
            // (and the exit event stops the background work first).
            log::info!("updates: {version} installed, restarting");
            app.restart();
        }
        Err(error) => {
            let kind = classify(&error);
            log::error!("updates: the install of {version} failed: {error}");
            set_phase(
                app,
                state,
                Phase::Failed {
                    stage: Stage::Install,
                    kind,
                    reason: error.to_string(),
                    version: Some(version),
                },
            );
            Err(error.to_string())
        }
    }
}

/// The automatic checks: one shortly after start, then every few hours,
/// while the setting is on.
pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            if automatic(&app) {
                check(&app, false).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Settings, Updates: where it stands.
#[tauri::command]
pub fn update_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdatesState>,
) -> UpdateStatus {
    status(&app, &state)
}

/// "Check for updates". Answers when the check is done.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, String> {
    check(&app, true).await;
    let state = app
        .try_state::<UpdatesState>()
        .ok_or_else(|| "the updater is not running".to_owned())?;
    Ok(status(&app, &state))
}

/// "Download": starts the download; progress arrives as events.
#[tauri::command]
pub fn update_download<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdatesState>,
) -> Result<UpdateStatus, String> {
    start_download(&app, &state)?;
    Ok(status(&app, &state))
}

/// "Install and restart". On success the app restarts (macOS) or exits for
/// the installer (Windows), so the answer is only ever an error.
#[tauri::command]
pub fn update_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdatesState>,
) -> Result<(), String> {
    install(&app, &state)
}

/// The setting: check by itself (on by default).
#[tauri::command]
pub fn set_check_for_updates<R: Runtime>(
    app: AppHandle<R>,
    settings: State<'_, SettingsState>,
    updates: State<'_, UpdatesState>,
    enabled: bool,
) -> Result<UpdateStatus, String> {
    settings.update(|s| s.check_for_updates = enabled)?;
    notify(&app, &updates);
    Ok(status(&app, &updates))
}

/// "Download from the website": the web's /download page in the default
/// browser, for a copy that cannot update itself or an update that failed.
#[tauri::command]
pub fn update_open_download_page() -> Result<(), String> {
    let url = format!(
        "{}/download",
        crate::account::web_url().trim_end_matches('/')
    );
    // Ours: the configured https origin and a fixed path.
    open::that_detached(url).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_phase_is_tagged_camel_case_json() {
        let phase = Phase::Downloading {
            version: "0.2.0".into(),
            downloaded: 10,
            total: Some(20),
        };
        assert_eq!(
            serde_json::to_value(&phase).expect("json"),
            serde_json::json!({
                "state": "downloading",
                "version": "0.2.0",
                "downloaded": 10,
                "total": 20,
            })
        );
        let failed = Phase::Failed {
            stage: Stage::Check,
            kind: FailKind::NoRelease,
            reason: "x".into(),
            version: None,
        };
        assert_eq!(
            serde_json::to_value(&failed).expect("json"),
            serde_json::json!({
                "state": "failed",
                "stage": "check",
                "kind": "noRelease",
                "reason": "x",
                "version": null,
            })
        );
        assert_eq!(
            serde_json::to_value(Phase::UpToDate).expect("json"),
            serde_json::json!({ "state": "upToDate" })
        );
        let available = Phase::Available {
            version: "0.2.0".into(),
            notes: None,
            date_ms: Some(1),
        };
        assert_eq!(
            serde_json::to_value(&available).expect("json")["dateMs"],
            serde_json::json!(1)
        );
    }

    #[test]
    fn only_running_steps_are_busy() {
        assert!(busy(&Phase::Checking));
        assert!(busy(&Phase::Installing {
            version: "1.0.0".into()
        }));
        assert!(!busy(&Phase::Idle));
        assert!(!busy(&Phase::UpToDate));
        assert!(!busy(&Phase::Ready {
            version: "1.0.0".into(),
            notes: None
        }));
    }

    #[test]
    fn errors_are_classified_for_the_window() {
        assert_eq!(
            classify(&UpdaterError::ReleaseNotFound),
            FailKind::NoRelease
        );
        assert_eq!(
            classify(&UpdaterError::TargetsNotFound(vec![
                "darwin-aarch64".into()
            ])),
            FailKind::NoBuild
        );
        assert_eq!(
            classify(&UpdaterError::Network("500".into())),
            FailKind::Network
        );
        assert_eq!(classify(&UpdaterError::EmptyEndpoints), FailKind::Other);
    }

    #[test]
    fn a_debug_build_cannot_install() {
        // `cargo test` builds with debug assertions.
        assert_eq!(install_blocker(), Some(InstallBlocker::DevBuild));
    }
}
