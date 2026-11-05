//! Import (the sidebar's Import screen): hand histories picked by hand - a
//! few files, or a folder with everything under it - read **once** into the
//! store, without watching anything afterwards.
//!
//! The files go through the watcher's own reader ([`FileReader`], R1.3 /
//! R1.6): the same conversion, dedupe by hand key, refusals to quarantine
//! and unrecognised files to the registry. A file the store already read to
//! its end (a watched folder's, or one imported before) comes back
//! unchanged and counts as "already imported". A file of a watched folder
//! keeps its folder (`files.source_id` is kept when a read names none), and
//! a read of it here at the same time as the watcher's is safe: a batch
//! must start at the stored offset or it is refused and read again.
//!
//! One import runs at a time, on a thread of its own with a pool of
//! [`default_workers`] import threads. While it runs the statistics pass
//! waits (as for a folder's backfill), and it is woken - with the sync
//! worker - as hands come in. The window hears [`CHANGED_EVENT`] (at most
//! every [`PUBLISH_MS`]) and asks [`manual_import_status`]; screens that
//! show hands hear the watcher's event too, so they reload.
//!
//! The import stops early on [`manual_import_cancel`] and on exit
//! ([`ManualImportState::stop`]): the store waits for its writer handle.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use rail_store::time;
use rail_watch::{FileReader, FileRef, FileTrack, Polled, ReadConfig, default_workers, scan};
use rayon::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::StoreState;
use crate::stats::StatsState;
use crate::sync::SyncSlot;

/// The window event that says the import's status changed. No payload: the
/// window asks [`manual_import_status`].
pub const CHANGED_EVENT: &str = "manual-import-changed";

/// How often the status is published while files are read, at most.
const PUBLISH_MS: i64 = 200;

/// The id the statistics pass knows this import's "backfill" by (watched
/// folders have positive ids).
const STATS_BACKFILL_ID: i64 = -1;

/// The longest one file is looked at before it is left as it is: a file a
/// room is still writing would otherwise keep the import open.
const FILE_DEADLINE_MS: i64 = 10_000;

/// How many refusals of unreadable paths the status keeps.
const ERRORS_KEPT: usize = 20;

/// The reader's timing here: the files are not being written (or are left
/// as they stand), so a trailing hand is taken after a short quiet instead
/// of the watcher's wait for a slow writer.
fn read_config() -> ReadConfig {
    ReadConfig {
        quiet_ms: 300,
        settle_ms: 1_000,
        give_up_ms: 2_000,
        ..ReadConfig::default()
    }
}

/// Where the import stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Nothing has been imported since the app started.
    #[default]
    Idle,
    /// Looking for hand histories under the picked folders.
    Finding,
    /// Reading the files.
    Importing,
    /// Every file was read.
    Done,
    /// Stopped by the user before the end.
    Cancelled,
    /// The import could not run (`error` says why).
    Failed,
}

/// The current (or last) import, for the window.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatus {
    phase: Phase,
    /// Hand-history files found.
    files: u32,
    /// Files read so far.
    files_done: u32,
    /// Bytes of the files found, and of those read.
    bytes: u64,
    bytes_done: u64,
    /// Hands new to the store.
    inserted: u32,
    /// Hands the store already had.
    duplicates: u32,
    /// Hands refused (in quarantine, with their reasons, as a folder's).
    refused: u32,
    /// Files no parser reads.
    unrecognized: u32,
    /// Files read to their end before (nothing new in them).
    unchanged: u32,
    /// Paths that could not be read, with why (the first [`ERRORS_KEPT`]).
    errors: Vec<String>,
    /// How many paths could not be read.
    error_count: u32,
    /// Why the import failed.
    error: Option<String>,
    /// When it started and ended, ms since the epoch.
    started_at: Option<i64>,
    finished_at: Option<i64>,
}

impl ImportStatus {
    fn error(&mut self, text: String) {
        self.error_count += 1;
        if self.errors.len() < ERRORS_KEPT {
            self.errors.push(text);
        }
    }
}

/// A running import.
#[derive(Debug)]
struct Run {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

/// The import, as app state.
#[derive(Debug)]
pub struct ManualImportState {
    status: Arc<Mutex<ImportStatus>>,
    run: Mutex<Option<Run>>,
    /// The sync worker, once it exists: woken as hands come in.
    sync: SyncSlot,
}

impl ManualImportState {
    pub fn new(sync: SyncSlot) -> Self {
        Self {
            status: Arc::default(),
            run: Mutex::new(None),
            sync,
        }
    }

    fn status(&self) -> ImportStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn running(&self) -> bool {
        self.run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|run| !run.thread.is_finished())
    }

    fn cancel(&self) {
        if let Some(run) = self
            .run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            run.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Stop the import and wait for its thread (on exit: the store waits
    /// for the writer handle it holds).
    pub fn stop(&self) {
        let run = self
            .run
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(run) = run {
            run.stop.store(true, Ordering::Relaxed);
            let _ = run.thread.join();
        }
    }
}

/// A path from the window, checked: absolute, no `..` component, no NUL,
/// and an existing file or folder.
fn checked_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("the path is not valid".to_owned());
    }
    let given = Path::new(path);
    if !given.is_absolute() {
        return Err(format!("{path}: not a full path"));
    }
    if given
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("{path}: the path may not contain .."));
    }
    let checked: PathBuf = given.components().collect();
    match std::fs::metadata(&checked) {
        Ok(metadata) if metadata.is_dir() || metadata.is_file() => Ok(checked),
        Ok(_) => Err(format!("{path}: not a file or a folder")),
        Err(error) => Err(format!("{path}: {error}")),
    }
}

/// The files to read: every picked file as it is (whatever its name - the
/// user chose it), and the hand-history files under every picked folder,
/// its subfolders too. Each file once, in a stable order.
fn find_files(
    paths: &[PathBuf],
    stop: &AtomicBool,
    status: &mut ImportStatus,
) -> Option<Vec<(PathBuf, u64)>> {
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    for path in paths {
        if path.is_dir() {
            match scan::walk_matching_until(path, true, None, &|| stop.load(Ordering::Relaxed)) {
                Ok(walk) => {
                    files.extend(walk.files.into_iter().map(|(file, size, _)| (file, size)));
                    for (place, error) in walk.errors {
                        status.error(format!("{}: {error}", place.display()));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => return None,
                Err(error) => status.error(format!("{}: {error}", path.display())),
            }
        } else {
            match std::fs::metadata(path) {
                Ok(metadata) => files.push((path.clone(), metadata.len())),
                Err(error) => status.error(format!("{}: {error}", path.display())),
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.dedup_by(|a, b| a.0 == b.0);
    Some(files)
}

/// What one file came to.
#[derive(Debug, Default)]
struct FileResult {
    inserted: u32,
    duplicates: u32,
    refused: u32,
    unrecognized: bool,
    unchanged: bool,
}

/// Read one file to its end (or to [`FILE_DEADLINE_MS`]).
fn read_file(
    reader: &FileReader,
    path: &Path,
    stop: &AtomicBool,
) -> rail_watch::Result<FileResult> {
    let file = FileRef::new(path);
    let mut track = FileTrack::default();
    let mut result = FileResult::default();
    let mut committed = false;
    let deadline = time::now_ms() + FILE_DEADLINE_MS;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let now = time::now_ms();
        let recheck_at = match reader.poll(&file, &mut track, now)? {
            Polled::Gone => break,
            Polled::Unchanged => {
                result.unchanged = !committed;
                break;
            }
            Polled::Waiting { recheck_at } => recheck_at,
            Polled::Committed {
                outcome,
                recheck_at,
                ..
            } => {
                committed = true;
                result.inserted += outcome.inserted;
                result.duplicates += outcome.duplicates;
                result.refused += outcome.quarantined;
                result.unrecognized |= outcome.unrecognized;
                recheck_at
            }
        };
        let Some(at) = recheck_at else { break };
        if at >= deadline {
            break;
        }
        let wait = u64::try_from(at.saturating_sub(time::now_ms())).unwrap_or(0);
        if wait > 0 {
            std::thread::sleep(Duration::from_millis(wait.min(250)));
        }
    }
    Ok(result)
}

/// What the import thread needs of the app.
struct Context<R: Runtime> {
    app: AppHandle<R>,
    status: Arc<Mutex<ImportStatus>>,
    stop: Arc<AtomicBool>,
    stats: Option<StatsState>,
    sync: SyncSlot,
}

impl<R: Runtime> Context<R> {
    fn update(&self, f: impl FnOnce(&mut ImportStatus)) {
        f(&mut self.status.lock().unwrap_or_else(PoisonError::into_inner));
    }

    fn publish(&self, imported: bool) {
        if let Err(error) = self.app.emit(CHANGED_EVENT, ()) {
            log::debug!("{CHANGED_EVENT}: {error}");
        }
        if imported {
            // Screens that show hands reload on the watcher's event.
            if let Err(error) = self.app.emit(crate::watch::CHANGED_EVENT, ()) {
                log::debug!("{}: {error}", crate::watch::CHANGED_EVENT);
            }
            if let Some(worker) = self.sync.get() {
                worker.wake();
            }
        }
    }
}

fn run<R: Runtime>(ctx: &Context<R>, reader: &FileReader, paths: &[PathBuf]) {
    let mut found = ImportStatus::default();
    let Some(files) = find_files(paths, &ctx.stop, &mut found) else {
        ctx.update(|status| status.phase = Phase::Cancelled);
        return;
    };
    let bytes: u64 = files.iter().map(|(_, size)| size).sum();
    ctx.update(|status| {
        status.phase = Phase::Importing;
        status.files = u32::try_from(files.len()).unwrap_or(u32::MAX);
        status.bytes = bytes;
        status.errors = found.errors;
        status.error_count = found.error_count;
    });
    ctx.publish(false);
    log::info!("import by hand: {} files, {bytes} bytes", files.len());

    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(default_workers())
        .thread_name(|index| format!("rail-import-{index}"))
        .build()
    {
        Ok(pool) => pool,
        Err(error) => {
            ctx.update(|status| {
                status.phase = Phase::Failed;
                status.error = Some(error.to_string());
            });
            return;
        }
    };
    let published = Mutex::new(time::now_ms());
    let new_hands = AtomicBool::new(false);
    pool.install(|| {
        files.par_iter().for_each(|(path, size)| {
            if ctx.stop.load(Ordering::Relaxed) {
                return;
            }
            let read = read_file(reader, path, &ctx.stop);
            let inserted = read.as_ref().map_or(0, |result| result.inserted);
            ctx.update(|status| {
                status.files_done += 1;
                status.bytes_done += size;
                match read {
                    Ok(result) => {
                        status.inserted += result.inserted;
                        status.duplicates += result.duplicates;
                        status.refused += result.refused;
                        status.unrecognized += u32::from(result.unrecognized);
                        status.unchanged += u32::from(result.unchanged);
                    }
                    Err(error) => status.error(format!("{}: {error}", path.display())),
                }
            });
            if inserted > 0 {
                new_hands.store(true, Ordering::Relaxed);
            }
            let now = time::now_ms();
            let mut last = published.lock().unwrap_or_else(PoisonError::into_inner);
            if now - *last >= PUBLISH_MS {
                *last = now;
                drop(last);
                ctx.publish(new_hands.swap(false, Ordering::Relaxed));
            }
        });
    });
    let cancelled = ctx.stop.load(Ordering::Relaxed);
    ctx.update(|status| {
        status.phase = if cancelled {
            Phase::Cancelled
        } else {
            Phase::Done
        };
    });
    ctx.publish(true);
}

/// Start importing `paths` (files and folders, any mix). Fails when an
/// import is already running or a path is not valid.
#[tauri::command]
pub async fn manual_import_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ManualImportState>,
    store: State<'_, StoreState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing was picked".to_owned());
    }
    let paths = paths
        .iter()
        .map(|path| checked_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    let Some(opened) = &store.store else {
        return Err(store
            .error
            .clone()
            .unwrap_or_else(|| "the store is not open".to_owned()));
    };
    let writer = opened.writer().map_err(|error| error.to_string())?;
    let reader =
        FileReader::new(opened.path(), writer, read_config()).map_err(|error| error.to_string())?;

    let mut slot = state.run.lock().unwrap_or_else(PoisonError::into_inner);
    if slot.as_ref().is_some_and(|run| !run.thread.is_finished()) {
        return Err("an import is already running".to_owned());
    }
    if let Some(done) = slot.take() {
        let _ = done.thread.join();
    }
    *state.status.lock().unwrap_or_else(PoisonError::into_inner) = ImportStatus {
        phase: Phase::Finding,
        started_at: Some(time::now_ms()),
        ..ImportStatus::default()
    };
    let stop = Arc::new(AtomicBool::new(false));
    let ctx = Context {
        status: Arc::clone(&state.status),
        stop: Arc::clone(&stop),
        stats: app.try_state::<StatsState>().map(|stats| (*stats).clone()),
        sync: Arc::clone(&state.sync),
        app: app.clone(),
    };
    let thread = std::thread::Builder::new()
        .name("rail-manual-import".to_owned())
        .spawn(move || {
            if let Some(stats) = &ctx.stats {
                stats.backfill(STATS_BACKFILL_ID, true);
            }
            run(&ctx, &reader, &paths);
            ctx.update(|status| status.finished_at = Some(time::now_ms()));
            // The reader (and its writer handle) goes before the pass is
            // let go, so nothing of the import is still queued.
            drop(reader);
            if let Some(stats) = &ctx.stats {
                stats.backfill(STATS_BACKFILL_ID, false);
                stats.wake();
            }
            let status = ctx
                .status
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            log::info!(
                "import by hand {:?}: {} of {} files, {} new hands, {} already stored, {} refused",
                status.phase,
                status.files_done,
                status.files,
                status.inserted,
                status.duplicates,
                status.refused
            );
            ctx.publish(false);
        })
        .map_err(|error| error.to_string())?;
    *slot = Some(Run { stop, thread });
    drop(slot);
    if let Err(error) = app.emit(CHANGED_EVENT, ()) {
        log::debug!("{CHANGED_EVENT}: {error}");
    }
    Ok(())
}

/// The current (or last) import.
#[tauri::command]
pub async fn manual_import_status(
    state: State<'_, ManualImportState>,
) -> Result<ImportStatus, String> {
    let mut status = state.status();
    // A thread that ended without saying so (it panicked) is not running.
    if matches!(status.phase, Phase::Finding | Phase::Importing) && !state.running() {
        status.phase = Phase::Failed;
    }
    Ok(status)
}

/// Stop the running import after the files being read.
#[tauri::command]
pub async fn manual_import_cancel(state: State<'_, ManualImportState>) -> Result<(), String> {
    state.cancel();
    Ok(())
}

/// The system file picker, several hand-history files at once. `None` when
/// cancelled.
#[tauri::command]
pub async fn pick_import_files<R: Runtime>(app: AppHandle<R>) -> Option<Vec<String>> {
    // Not on the main thread: async commands run on the async runtime.
    app.dialog()
        .file()
        .add_filter("Hand histories", scan::EXTENSIONS)
        .blocking_pick_files()
        .map(|picked| {
            picked
                .into_iter()
                .filter_map(|file| file.into_path().ok())
                .map(|path| path.display().to_string())
                .collect()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_from_the_window_are_checked() {
        assert!(checked_path("").is_err());
        assert!(checked_path("relative/file.txt").is_err());
        let dir = std::env::temp_dir();
        let dotted = format!("{}/x/../y", dir.display());
        assert!(checked_path(&dotted).is_err());
        assert!(checked_path(&dir.display().to_string()).is_ok());
    }

    /// A real file through the reader into a store: its hands come in once;
    /// read again it is "already imported"; the same hands under another
    /// path are duplicates; a broken hand is refused.
    #[test]
    fn files_are_read_into_the_store_once() {
        let dir =
            std::env::temp_dir().join(format!("rail-manual-import-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = StoreState::open(dir.join("data").join(rail_store::FILE_NAME));
        let store = state.store.as_ref().expect("open");
        let reader = FileReader::new(store.path(), store.writer().expect("writer"), read_config())
            .expect("reader");
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/samples");
        let stars = samples.join("pokerstars/27-cash-multi-hand-file-blank-line-separator.txt");
        let stop = AtomicBool::new(false);

        let first = read_file(&reader, &stars, &stop).expect("first read");
        assert!(first.inserted > 0, "{first:?}");
        assert!(!first.unchanged);

        let again = read_file(&reader, &stars, &stop).expect("second read");
        assert_eq!(again.inserted, 0);
        assert!(again.unchanged, "{again:?}");

        let copy = dir.join("copy.txt");
        std::fs::copy(&stars, &copy).expect("copy");
        let copied = read_file(&reader, &copy, &stop).expect("copy read");
        assert_eq!(copied.inserted, 0);
        assert_eq!(copied.duplicates, first.inserted);

        let broken = samples.join("888poker/13-invalid-hand-truncated-flop.txt");
        let refused = read_file(&reader, &broken, &stop).expect("broken read");
        assert!(refused.refused > 0, "{refused:?}");

        drop(reader);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folders_give_their_hand_histories_and_files_count_as_picked() {
        let dir = std::env::temp_dir().join(format!("rail-manual-import-{}", std::process::id()));
        let sub = dir.join("2026-11-05");
        std::fs::create_dir_all(&sub).expect("dirs");
        std::fs::write(dir.join("a.txt"), "x").expect("a");
        std::fs::write(sub.join("b.xml"), "yy").expect("b");
        std::fs::write(dir.join("notes.pdf"), "z").expect("pdf");
        let picked = dir.join("picked.hh");
        std::fs::write(&picked, "zzz").expect("picked");

        let stop = AtomicBool::new(false);
        let mut status = ImportStatus::default();
        let files = find_files(
            &[dir.clone(), picked.clone(), dir.join("a.txt")],
            &stop,
            &mut status,
        )
        .expect("not stopped");
        let names: Vec<_> = files
            .iter()
            .map(|(path, _)| path.strip_prefix(&dir).expect("under dir").to_path_buf())
            .collect();
        assert_eq!(
            names,
            vec![
                PathBuf::from("2026-11-05/b.xml"),
                PathBuf::from("a.txt"),
                PathBuf::from("picked.hh"),
            ]
        );
        assert_eq!(status.error_count, 0);
        std::fs::remove_dir_all(&dir).expect("clean up");
    }
}
