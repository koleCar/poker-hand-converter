//! The watcher service: what the app starts after the store.
//!
//! # Threads
//!
//! - **Coordinator** (one): owns the OS notification watcher (`notify`:
//!   FSEvents, ReadDirectoryChangesW, inotify), the list of folders, and
//!   what is known of every file. It turns notifications, rescans and
//!   recheck times into "this file may have something new" and hands those
//!   files to the workers - never the same file to two workers at once. It
//!   does no file reading and no conversion itself.
//! - **Workers** (a few, [`WatchConfig::workers`]): run
//!   [`FileReader::poll`] - read the new bytes, convert, commit through the
//!   store's writer. The writer's queue is bounded: when it is full the
//!   workers block, the job queue fills, and the coordinator keeps the files
//!   marked until a worker is free (back-pressure without unbounded memory).
//!
//! # When a file is looked at
//!
//! - on an OS notification for it (or for a new folder under a recursive
//!   folder, which is walked at once);
//! - on the **periodic rescan** of every folder, every
//!   [`WatchConfig::rescan`] (60 s): a file whose size or mtime differs
//!   from the last walk - the safety net for missed or coalesced
//!   notifications. A folder's OS watch is set before its first walk, and
//!   it is walked once more a second later: notifications start a moment
//!   after the watch is set;
//! - for a **poll-only** folder (a network share, detected or set by the
//!   user), only by rescan, every [`WatchConfig::poll_interval`];
//! - at the recheck time a read asked for (a trailing hand waiting for the
//!   quiet period, a refused tail waiting for the give-up time).
//!
//! # Folders that go away
//!
//! A folder that cannot be read (an unplugged drive, a share that dropped,
//! no permission) is marked `unavailable` / `error` with the reason and
//! tried again only at the next rescan - no spinning. Its files keep their
//! offsets; when it comes back it is watched again and read from where it
//! stood. A file that disappears while its folder is there is forgotten
//! ([`FileReader::forget`]). A file that cannot be read (permissions) is
//! reported ([`WatchEvent::FileError`]) and tried again at the next rescan.
//!
//! # Stopping
//!
//! [`Watcher::stop`] (or dropping it) finishes the reads in progress and
//! ends the threads. Stop the watcher **before** the store closes: closing
//! the store waits for every handle on its writer, and the watcher holds
//! some.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher as _};
use rail_store::{WriterHandle, time};

use crate::error::{Error, Result};
use crate::reader::{FileReader, FileRef, FileTrack, Polled, ReadConfig};
use crate::scan;

/// The service's settings.
#[derive(Debug, Clone)]
pub struct WatchConfig {
    /// The reader's timing (quiet period, give-up time).
    pub read: ReadConfig,
    /// Every folder is walked this often, notifications or not.
    pub rescan: Duration,
    /// A poll-only folder is walked this often.
    pub poll_interval: Duration,
    /// Threads that read and convert.
    pub workers: usize,
    /// Mark a folder on a network volume poll-only when it is added.
    pub detect_network: bool,
    /// `files.glob` per `sites.json` id ([`crate::discover::file_globs`]): a
    /// folder whose `sources.site` has one reads only the files matching it
    /// ([`scan::is_candidate_for`]); every other folder reads
    /// [`scan::EXTENSIONS`]. Empty: no narrowing.
    pub file_globs: BTreeMap<String, String>,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            read: ReadConfig::default(),
            rescan: Duration::from_secs(60),
            poll_interval: Duration::from_secs(3),
            workers: 2,
            detect_network: true,
            file_globs: BTreeMap::new(),
        }
    }
}

/// How a folder is added ([`Watcher::add_source_with`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSource {
    /// Its subfolders too.
    pub recursive: bool,
    /// `None`: poll only when it is on a network volume.
    pub poll_only: Option<bool>,
    /// The room it is the default folder of (`sites.json` id), as discovery
    /// found it: stored as `sources.site`, narrows the files read to the
    /// room's `files.glob`.
    pub site: Option<String>,
    /// "Only new hands": the files there now are stored as read to their
    /// end without importing them ([`FileReader::mark_read`]); `false`
    /// imports everything, from offset 0.
    pub only_new: bool,
}

impl Default for NewSource {
    fn default() -> Self {
        Self {
            recursive: true,
            poll_only: None,
            site: None,
            only_new: false,
        }
    }
}

/// What [`Watcher::add_source_with`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddedSource {
    /// The folder's id in `sources`.
    pub id: i64,
    /// Files stored as read without importing them ("only new hands").
    pub marked: u32,
}

/// What the watcher is doing with a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceState {
    /// OS notifications plus the periodic rescan.
    Watching,
    /// Rescans only (a network or poll-only folder).
    Polling,
    /// The folder is not there (an unplugged drive, a dropped share).
    Unavailable,
    /// The folder is there but cannot be read or watched.
    Error,
    /// Switched off by the user; its hands stay.
    Disabled,
}

impl SourceState {
    /// The text in `sources.status`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Watching => "watching",
            Self::Polling => "polling",
            Self::Unavailable => "unavailable",
            Self::Error => "error",
            Self::Disabled => "disabled",
        }
    }
}

/// One folder's status: the watcher's state and the store's counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatus {
    pub id: i64,
    pub path: String,
    pub recursive: bool,
    pub poll_only: bool,
    /// The room it is the default folder of (`sources.site`), if known.
    pub site: Option<String>,
    pub state: SourceState,
    /// Why the folder is unavailable or in error.
    pub error: Option<String>,
    /// Files whose last read failed (permissions, I/O), now.
    pub file_errors: u32,
    /// Files with new bytes that are not a complete hand yet.
    pub pending: u32,
    /// From the store.
    pub files: i64,
    pub hands: i64,
    pub hands_today: i64,
    pub quarantined: i64,
    /// ms since the epoch.
    pub last_import_at: Option<i64>,
}

/// The whole watcher's status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherStatus {
    pub running: bool,
    pub paused: bool,
    pub sources: Vec<SourceStatus>,
}

/// What the watcher reports as it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// A batch was committed.
    Imported {
        source_id: Option<i64>,
        path: PathBuf,
        inserted: u32,
        duplicates: u32,
        quarantined: u32,
        from: u64,
        to: u64,
    },
    /// A folder changed state.
    Source {
        id: i64,
        state: SourceState,
        error: Option<String>,
    },
    /// A file could not be read.
    FileError { path: PathBuf, error: String },
    /// Import was paused (`true`) or resumed.
    Paused(bool),
}

/// The status callback.
type OnEvent = Arc<dyn Fn(WatchEvent) + Send + Sync>;

/// Commands from the handle to the coordinator.
#[derive(Debug)]
enum Command {
    /// The folders changed in the store: load them again.
    Reload,
    Pause,
    Resume,
    /// Walk every folder now.
    Rescan,
    Stop,
}

/// Everything the coordinator waits for.
enum Msg {
    Fs(notify::Result<notify::Event>),
    Done(Box<Done>),
    Cmd(Command),
}

/// A worker's answer.
struct Done {
    path: PathBuf,
    track: FileTrack,
    result: Result<Polled>,
}

/// A worker's job.
struct Job {
    path: PathBuf,
    source_id: i64,
    site_override: Option<String>,
    track: FileTrack,
}

/// What the coordinator shares with the handle (for `status`).
#[derive(Debug, Default)]
struct Shared {
    running: bool,
    sources: HashMap<i64, SourceShared>,
}

#[derive(Debug, Clone, Default)]
struct SourceShared {
    state: Option<SourceState>,
    error: Option<String>,
    file_errors: u32,
    pending: u32,
    poll_only: bool,
}

/// The running watcher. Dropping it stops it.
pub struct Watcher {
    inbox: Sender<Msg>,
    writer: WriterHandle,
    reader: Arc<FileReader>,
    shared: Arc<Mutex<Shared>>,
    paused: Arc<AtomicBool>,
    detect_network: bool,
    file_globs: BTreeMap<String, String>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watcher")
            .field("paused", &self.is_paused())
            .finish_non_exhaustive()
    }
}

impl Watcher {
    /// Start watching the enabled folders in the store at `store_path`,
    /// committing through `writer`. `on_event` is called from the
    /// watcher's thread; keep it short.
    pub fn start(
        store_path: &Path,
        writer: WriterHandle,
        config: WatchConfig,
        on_event: impl Fn(WatchEvent) + Send + Sync + 'static,
    ) -> Result<Self> {
        let reader = Arc::new(FileReader::new(
            store_path,
            writer.clone(),
            config.read.clone(),
        )?);
        let (inbox, messages) = mpsc::channel();
        let fs_inbox = inbox.clone();
        let notifier = notify::recommended_watcher(move |event| {
            let _ = fs_inbox.send(Msg::Fs(event));
        })?;
        let shared = Arc::new(Mutex::new(Shared {
            running: true,
            ..Shared::default()
        }));
        let paused = Arc::new(AtomicBool::new(false));
        let on_event: OnEvent = Arc::new(on_event);

        let workers = config.workers.max(1);
        let (jobs, job_queue) = mpsc::sync_channel::<Job>(workers * 2);
        let job_queue = Arc::new(Mutex::new(job_queue));
        let mut worker_threads = Vec::new();
        for n in 0..workers {
            let job_queue = Arc::clone(&job_queue);
            let reader = Arc::clone(&reader);
            let inbox = inbox.clone();
            let thread = thread::Builder::new()
                .name(format!("rail-watch-worker-{n}"))
                .spawn(move || work(&job_queue, &reader, &inbox))
                .map_err(|error| Error::io("rail-watch-worker", error))?;
            worker_threads.push(thread);
        }

        let detect_network = config.detect_network;
        let file_globs = config.file_globs.clone();
        let coordinator = Coordinator {
            config,
            reader: Arc::clone(&reader),
            writer: writer.clone(),
            notifier,
            messages,
            jobs: Some(jobs),
            workers: worker_threads,
            shared: Arc::clone(&shared),
            paused: Arc::clone(&paused),
            on_event,
            sources: HashMap::new(),
            files: HashMap::new(),
            in_flight: HashSet::new(),
            dirty: HashSet::new(),
        };
        let thread = thread::Builder::new()
            .name("rail-watch".to_owned())
            .spawn(move || coordinator.run())
            .map_err(|error| Error::io("rail-watch", error))?;
        let watcher = Self {
            inbox,
            writer,
            reader,
            shared,
            paused,
            detect_network,
            file_globs,
            thread: Some(thread),
        };
        watcher.send(Command::Reload)?;
        Ok(watcher)
    }

    fn send(&self, command: Command) -> Result<()> {
        self.inbox
            .send(Msg::Cmd(command))
            .map_err(|_| Error::Stopped)
    }

    /// Stop reading new bytes; notifications are still noted, and resuming
    /// reads everything that changed meanwhile.
    pub fn pause(&self) -> Result<()> {
        self.send(Command::Pause)
    }

    pub fn resume(&self) -> Result<()> {
        self.send(Command::Resume)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Walk every folder now.
    pub fn rescan(&self) -> Result<()> {
        self.send(Command::Rescan)
    }

    /// Watch a folder (stored in `sources`). `poll_only: None` decides by
    /// whether it is on a network volume. Returns its id; a folder already
    /// there keeps its row and id.
    pub fn add_source(&self, path: &Path, recursive: bool, poll_only: Option<bool>) -> Result<i64> {
        let options = NewSource {
            recursive,
            poll_only,
            ..NewSource::default()
        };
        Ok(self.add_source_with(path, &options)?.id)
    }

    /// Watch a folder as `options` say: its room (`sources.site`, which
    /// narrows its files to the room's `files.glob`) and whether the files
    /// already there are imported or only what is written from now on
    /// ([`NewSource::only_new`]). The files are marked before the watcher
    /// takes the folder up, so none of their hands is read in between. A
    /// folder already there keeps its row and id; its room is updated, and
    /// "only new" leaves the files it already has rows for alone.
    pub fn add_source_with(&self, path: &Path, options: &NewSource) -> Result<AddedSource> {
        let poll_only = options
            .poll_only
            .unwrap_or_else(|| self.detect_network && scan::is_network_path(path));
        let id = self.writer.add_source(
            &rail_store::import::path_key(path),
            options.recursive,
            None,
            poll_only,
        )?;
        if let Some(site) = &options.site {
            self.writer.set_source_site(id, Some(site))?;
        }
        let mut marked = 0;
        if options.only_new {
            let glob = options
                .site
                .as_ref()
                .and_then(|site| self.file_globs.get(site))
                .map(String::as_str);
            // A folder that is not there (yet) has nothing to skip.
            if let Ok(walk) = scan::walk_matching(path, options.recursive, glob) {
                for (file, _, _) in walk.files {
                    let file_ref = FileRef {
                        path: &file,
                        source_id: Some(id),
                        site_override: None,
                    };
                    match self.reader.mark_read(&file_ref) {
                        Ok(true) => marked += 1,
                        Ok(false) => {}
                        // Read in full later instead: better than lost.
                        Err(error) => log::warn!("{}: not skipped: {error}", file.display()),
                    }
                }
            }
            log::info!(
                "{}: {marked} existing files marked as read (only new hands)",
                path.display()
            );
        }
        self.send(Command::Reload)?;
        Ok(AddedSource { id, marked })
    }

    /// Stop watching a folder and forget it; its hands stay.
    pub fn remove_source(&self, id: i64) -> Result<bool> {
        let removed = self.writer.remove_source(id)?;
        self.send(Command::Reload)?;
        Ok(removed)
    }

    /// Enable or disable a folder; a disabled folder keeps its hands.
    pub fn set_source_enabled(&self, id: i64, enabled: bool) -> Result<bool> {
        let found = self.writer.set_source_enabled(id, enabled)?;
        self.send(Command::Reload)?;
        Ok(found)
    }

    /// Read a folder by polling only, or with notifications again.
    pub fn set_source_poll_only(&self, id: i64, poll_only: bool) -> Result<bool> {
        let found = self.writer.set_source_poll_only(id, poll_only)?;
        self.send(Command::Reload)?;
        Ok(found)
    }

    /// Every folder with its state and counts.
    pub fn status(&self) -> Result<WatcherStatus> {
        let rows = self.reader.store_reader().sources()?;
        let shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        let sources = rows
            .into_iter()
            .map(|row| {
                let live = shared.sources.get(&row.id).cloned().unwrap_or_default();
                let state = live.state.unwrap_or(if row.enabled {
                    SourceState::Watching
                } else {
                    SourceState::Disabled
                });
                SourceStatus {
                    id: row.id,
                    path: row.path,
                    recursive: row.recursive,
                    poll_only: row.poll_only || live.poll_only,
                    site: row.site,
                    state,
                    error: live.error,
                    file_errors: live.file_errors,
                    pending: live.pending,
                    files: row.files,
                    hands: row.hands,
                    hands_today: row.hands_today,
                    quarantined: row.quarantined,
                    last_import_at: row.last_import_at,
                }
            })
            .collect();
        Ok(WatcherStatus {
            running: shared.running,
            paused: self.is_paused(),
            sources,
        })
    }

    /// Stop: finish the reads in progress, then end the threads.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let _ = self.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn work(queue: &Mutex<Receiver<Job>>, reader: &FileReader, inbox: &Sender<Msg>) {
    loop {
        let job = {
            let queue = queue.lock().unwrap_or_else(PoisonError::into_inner);
            queue.recv()
        };
        let Ok(mut job) = job else {
            return; // the coordinator closed the queue
        };
        let file = FileRef {
            path: &job.path,
            source_id: Some(job.source_id),
            site_override: job.site_override.as_deref(),
        };
        let result = reader.poll(&file, &mut job.track, time::now_ms());
        let done = Done {
            path: job.path,
            track: job.track,
            result,
        };
        if inbox.send(Msg::Done(Box::new(done))).is_err() {
            return;
        }
    }
}

/// A folder as the coordinator runs it.
#[derive(Debug)]
struct SourceRt {
    id: i64,
    path: PathBuf,
    /// `path` with links resolved: notifications may name files through it
    /// (macOS reports `/private/var/...` for `/var/...`).
    real_path: PathBuf,
    recursive: bool,
    enabled: bool,
    poll_only: bool,
    site_override: Option<String>,
    /// The room's `files.glob` (from `sources.site`): which files are read.
    glob: Option<String>,
    state: Option<SourceState>,
    error: Option<String>,
    /// Registered with the OS notifier.
    watched: bool,
    next_scan: i64,
}

/// A file as the coordinator knows it.
#[derive(Debug)]
struct FileRt {
    source_id: i64,
    /// `None` while a worker has it.
    track: Option<FileTrack>,
    /// Size and mtime at the last walk.
    walked: Option<(u64, Option<i64>)>,
    recheck_at: Option<i64>,
    error: bool,
    pending: bool,
}

struct Coordinator {
    config: WatchConfig,
    reader: Arc<FileReader>,
    writer: WriterHandle,
    notifier: notify::RecommendedWatcher,
    messages: Receiver<Msg>,
    jobs: Option<SyncSender<Job>>,
    workers: Vec<JoinHandle<()>>,
    shared: Arc<Mutex<Shared>>,
    paused: Arc<AtomicBool>,
    on_event: OnEvent,
    sources: HashMap<i64, SourceRt>,
    files: HashMap<PathBuf, FileRt>,
    in_flight: HashSet<PathBuf>,
    dirty: HashSet<PathBuf>,
}

/// A folder is walked again this long after its OS watch was set.
const WATCH_SETTLE_MS: i64 = 1_000;

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl Coordinator {
    fn run(mut self) {
        loop {
            let now = time::now_ms();
            let wait = self
                .next_wake(now)
                .map_or(1_000, |at| (at - now).clamp(0, 1_000));
            let message = self
                .messages
                .recv_timeout(Duration::from_millis(u64::try_from(wait).unwrap_or(0)));
            match message {
                Ok(Msg::Cmd(Command::Stop)) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(message) => self.handle(message),
                Err(RecvTimeoutError::Timeout) => {}
            }
            // Drain what else is waiting before acting on it.
            while let Ok(message) = self.messages.try_recv() {
                if matches!(message, Msg::Cmd(Command::Stop)) {
                    self.finish();
                    return;
                }
                self.handle(message);
            }
            if !self.paused.load(Ordering::SeqCst) {
                let now = time::now_ms();
                self.scan_due(now);
                self.recheck_due(now);
                self.dispatch();
            }
            self.publish();
        }
        self.finish();
    }

    /// Close the job queue, let the workers finish their reads, and end.
    fn finish(&mut self) {
        self.jobs = None;
        // Workers answer into the inbox while finishing; keep draining it so
        // none blocks.
        for worker in std::mem::take(&mut self.workers) {
            while !worker.is_finished() {
                let _ = self.messages.recv_timeout(Duration::from_millis(10));
            }
            let _ = worker.join();
        }
        let mut shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        shared.running = false;
    }

    fn next_wake(&self, now: i64) -> Option<i64> {
        if self.paused.load(Ordering::SeqCst) {
            return None;
        }
        let scans = self
            .sources
            .values()
            .filter(|source| source.enabled)
            .map(|source| source.next_scan);
        let rechecks = self.files.values().filter_map(|file| file.recheck_at);
        scans.chain(rechecks).min().map(|at| at.max(now))
    }

    fn emit(&self, event: WatchEvent) {
        (self.on_event)(event);
    }

    fn handle(&mut self, message: Msg) {
        match message {
            Msg::Fs(Ok(event)) => self.on_fs_event(&event),
            Msg::Fs(Err(error)) => {
                log::warn!("file notifications: {error}");
                // Something was missed: walk everything at once.
                let now = time::now_ms();
                for source in self.sources.values_mut() {
                    source.next_scan = now;
                }
            }
            Msg::Done(done) => self.on_done(*done),
            Msg::Cmd(Command::Reload) => self.reload(),
            Msg::Cmd(Command::Pause) => {
                if !self.paused.swap(true, Ordering::SeqCst) {
                    log::info!("import paused");
                    self.emit(WatchEvent::Paused(true));
                }
            }
            Msg::Cmd(Command::Resume) => {
                if self.paused.swap(false, Ordering::SeqCst) {
                    log::info!("import resumed");
                    let now = time::now_ms();
                    for source in self.sources.values_mut() {
                        source.next_scan = now;
                    }
                    self.emit(WatchEvent::Paused(false));
                }
            }
            Msg::Cmd(Command::Rescan) => {
                let now = time::now_ms();
                for source in self.sources.values_mut() {
                    source.next_scan = now;
                }
            }
            Msg::Cmd(Command::Stop) => {}
        }
    }

    /// The folders from the store: start what is new or enabled, stop what
    /// went away or was disabled.
    fn reload(&mut self) {
        let rows = match self.reader.store_reader().sources() {
            Ok(rows) => rows,
            Err(error) => {
                log::error!("watcher: the folders could not be read: {error}");
                return;
            }
        };
        let now = time::now_ms();
        let wanted: HashSet<i64> = rows.iter().map(|row| row.id).collect();
        let gone: Vec<i64> = self
            .sources
            .keys()
            .copied()
            .filter(|id| !wanted.contains(id))
            .collect();
        for id in gone {
            if let Some(source) = self.sources.remove(&id) {
                self.unwatch(&source.path, source.watched);
                self.files.retain(|_, file| file.source_id != id);
                log::info!("stopped watching {}", source.path.display());
            }
        }
        for row in rows {
            let path = PathBuf::from(&row.path);
            let poll_only = row.poll_only
                || (self.config.detect_network && row.enabled && scan::is_network_path(&path));
            let glob = row
                .site
                .as_ref()
                .and_then(|site| self.config.file_globs.get(site))
                .cloned();
            let changed = self.sources.get(&row.id).is_none_or(|known| {
                known.enabled != row.enabled
                    || known.poll_only != poll_only
                    || known.recursive != row.recursive
                    || known.site_override != row.site_override
                    || known.glob != glob
            });
            if !changed {
                continue;
            }
            if let Some(old) = self.sources.remove(&row.id) {
                self.unwatch(&old.path, old.watched);
                if old.glob != glob {
                    // Other files are read now: start from the next walk.
                    self.files.retain(|_, file| file.source_id != row.id);
                }
            }
            let mut source = SourceRt {
                id: row.id,
                real_path: std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone()),
                path,
                recursive: row.recursive,
                enabled: row.enabled,
                poll_only,
                site_override: row.site_override,
                glob,
                state: None,
                error: None,
                watched: false,
                next_scan: now,
            };
            if source.enabled {
                log::info!(
                    "watching {} ({}{})",
                    source.path.display(),
                    if source.recursive {
                        "recursive"
                    } else {
                        "top level"
                    },
                    if source.poll_only { ", poll only" } else { "" }
                );
            } else {
                self.files.retain(|_, file| file.source_id != row.id);
                self.set_state(&mut source, SourceState::Disabled, None);
            }
            self.sources.insert(row.id, source);
        }
    }

    fn unwatch(&mut self, path: &Path, watched: bool) {
        if watched && let Err(error) = self.notifier.unwatch(path) {
            log::debug!("unwatch {}: {error}", path.display());
        }
    }

    /// Record a folder's state; report and store it when it changed.
    fn set_state(&self, source: &mut SourceRt, state: SourceState, error: Option<String>) {
        if source.state == Some(state) && source.error == error {
            return;
        }
        source.state = Some(state);
        source.error.clone_from(&error);
        if let Err(store_error) =
            self.writer
                .set_source_status(source.id, state.as_str(), error.as_deref())
        {
            log::warn!("folder status not stored: {store_error}");
        }
        match &error {
            Some(why) => log::warn!("{}: {} ({why})", source.path.display(), state.as_str()),
            None => log::info!("{}: {}", source.path.display(), state.as_str()),
        }
        self.emit(WatchEvent::Source {
            id: source.id,
            state,
            error,
        });
    }

    /// Walk every folder whose rescan is due; (re)register notifications
    /// for a folder that is (back) available.
    fn scan_due(&mut self, now: i64) {
        let due: Vec<i64> = self
            .sources
            .values()
            .filter(|source| source.enabled && source.next_scan <= now)
            .map(|source| source.id)
            .collect();
        for id in due {
            let Some(mut source) = self.sources.remove(&id) else {
                continue;
            };
            self.scan_source(&mut source, now);
            self.sources.insert(id, source);
        }
    }

    fn scan_source(&mut self, source: &mut SourceRt, now: i64) {
        let interval = if source.poll_only {
            self.config.poll_interval
        } else {
            self.config.rescan
        };
        source.next_scan = now + duration_ms(interval);
        // The OS watch first, then the walk: a file written in between is
        // seen by one or the other. And once more shortly after: FSEvents
        // and friends start delivering a moment after the watch is set, and
        // what is written in that moment is in no notification.
        let mut just_watched = false;
        if !source.poll_only && !source.watched && source.path.is_dir() {
            let mode = if source.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            match self.notifier.watch(&source.path, mode) {
                Ok(()) => {
                    source.watched = true;
                    just_watched = true;
                }
                Err(error) => {
                    // Rescans still read it; notifications are retried at the
                    // next one.
                    log::warn!(
                        "{}: no change notifications ({error}); rescans only",
                        source.path.display()
                    );
                }
            }
        }
        if just_watched {
            source.next_scan = now + WATCH_SETTLE_MS;
        }
        let walk = match scan::walk_matching(&source.path, source.recursive, source.glob.as_deref())
        {
            Ok(walk) => walk,
            Err(error) => {
                // Not there, or not readable: say so, try at the next rescan.
                self.unwatch(&source.path, source.watched);
                source.watched = false;
                let state = if error.kind() == std::io::ErrorKind::NotFound {
                    SourceState::Unavailable
                } else {
                    SourceState::Error
                };
                self.set_state(source, state, Some(error.to_string()));
                return;
            }
        };
        if let Ok(real) = std::fs::canonicalize(&source.path) {
            source.real_path = real;
        }
        let state = if source.poll_only || !source.watched {
            SourceState::Polling
        } else {
            SourceState::Watching
        };
        let error = walk
            .errors
            .first()
            .map(|(path, error)| format!("{}: {error}", path.display()));
        self.set_state(source, state, error);

        let mut present = HashSet::new();
        for (path, size, mtime) in walk.files {
            present.insert(path.clone());
            let file = self.files.entry(path.clone()).or_insert_with(|| FileRt {
                source_id: source.id,
                track: Some(FileTrack::default()),
                walked: None,
                recheck_at: None,
                error: false,
                pending: false,
            });
            if file.walked != Some((size, mtime)) || file.error {
                file.walked = Some((size, mtime));
                self.dirty.insert(path);
            }
        }
        // Files of this folder the walk did not find: let a read confirm it.
        let missing: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(path, file)| file.source_id == source.id && !present.contains(*path))
            .map(|(path, _)| path.clone())
            .collect();
        self.dirty.extend(missing);
    }

    /// The enabled folder a path belongs to (the deepest one), with the
    /// path as the folder's walk names it.
    fn source_of(&self, path: &Path) -> Option<(&SourceRt, PathBuf)> {
        self.sources
            .values()
            .filter(|source| source.enabled)
            .filter_map(|source| {
                let relative = path
                    .strip_prefix(&source.path)
                    .or_else(|_| path.strip_prefix(&source.real_path))
                    .ok()?;
                let inside = source.recursive || relative.components().count() == 1;
                inside.then(|| (source, source.path.join(relative)))
            })
            .max_by_key(|(source, _)| source.path.as_os_str().len())
    }

    fn on_fs_event(&mut self, event: &notify::Event) {
        if event.need_rescan() {
            let now = time::now_ms();
            for source in self.sources.values_mut() {
                source.next_scan = now;
            }
        }
        for path in &event.paths {
            let Some((source, path)) = self.source_of(path) else {
                continue;
            };
            let (source_id, recursive) = (source.id, source.recursive);
            let glob = source.glob.clone();
            let path = &path;
            let folder_created = matches!(
                event.kind,
                EventKind::Create(notify::event::CreateKind::Folder)
            ) || (matches!(event.kind, EventKind::Create(_)) && path.is_dir());
            if folder_created {
                // A new subfolder: its files may predate the OS watch on it.
                if recursive && let Ok(walk) = scan::walk_matching(path, true, glob.as_deref()) {
                    for (file, _, _) in walk.files {
                        self.mark(file, source_id);
                    }
                }
                continue;
            }
            if scan::is_candidate_for(path, glob.as_deref()) || self.files.contains_key(path) {
                self.mark(path.clone(), source_id);
            }
        }
    }

    fn mark(&mut self, path: PathBuf, source_id: i64) {
        self.files.entry(path.clone()).or_insert_with(|| FileRt {
            source_id,
            track: Some(FileTrack::default()),
            walked: None,
            recheck_at: None,
            error: false,
            pending: false,
        });
        self.dirty.insert(path);
    }

    fn recheck_due(&mut self, now: i64) {
        for (path, file) in &mut self.files {
            if file.recheck_at.is_some_and(|at| at <= now) {
                file.recheck_at = None;
                self.dirty.insert(path.clone());
            }
        }
    }

    /// Hand dirty files to free workers; what does not fit stays dirty.
    fn dispatch(&mut self) {
        let Some(jobs) = self.jobs.clone() else {
            return;
        };
        let ready: Vec<PathBuf> = self
            .dirty
            .iter()
            .filter(|path| !self.in_flight.contains(*path))
            .cloned()
            .collect();
        for path in ready {
            let Some(file) = self.files.get_mut(&path) else {
                self.dirty.remove(&path);
                continue;
            };
            let Some(source) = self.sources.get(&file.source_id).filter(|s| s.enabled) else {
                self.dirty.remove(&path);
                continue;
            };
            let Some(track) = file.track.take() else {
                continue;
            };
            let job = Job {
                path: path.clone(),
                source_id: file.source_id,
                site_override: source.site_override.clone(),
                track,
            };
            match jobs.try_send(job) {
                Ok(()) => {
                    self.dirty.remove(&path);
                    self.in_flight.insert(path);
                }
                Err(TrySendError::Full(job) | TrySendError::Disconnected(job)) => {
                    file.track = Some(job.track);
                    break;
                }
            }
        }
    }

    fn on_done(&mut self, done: Done) {
        let Done {
            path,
            track,
            result,
        } = done;
        self.in_flight.remove(&path);
        let Some(file) = self.files.get_mut(&path) else {
            return; // its folder was removed meanwhile
        };
        file.track = Some(track);
        let source_id = file.source_id;
        if matches!(result, Ok(Polled::Gone)) {
            self.on_gone(&path, source_id);
            return;
        }
        let Some(file) = self.files.get_mut(&path) else {
            return;
        };
        match result {
            Ok(Polled::Gone) => {}
            Ok(polled) => {
                file.error = false;
                file.recheck_at = polled.recheck_at();
                file.pending = matches!(
                    polled,
                    Polled::Waiting {
                        recheck_at: Some(_)
                    }
                ) || matches!(
                    polled,
                    Polled::Committed {
                        recheck_at: Some(_),
                        ..
                    }
                );
                if let Polled::Committed {
                    outcome, from, to, ..
                } = polled
                {
                    log::debug!(
                        "{}: {from}..{to}, {} new, {} known, {} refused",
                        path.display(),
                        outcome.inserted,
                        outcome.duplicates,
                        outcome.quarantined
                    );
                    self.emit(WatchEvent::Imported {
                        source_id: Some(source_id),
                        path,
                        inserted: outcome.inserted,
                        duplicates: outcome.duplicates,
                        quarantined: outcome.quarantined,
                        from,
                        to,
                    });
                }
            }
            Err(error) => {
                // Permissions, I/O, the store: noted, tried again at the next
                // rescan (not at once: no spinning on a file that cannot be
                // read).
                file.error = true;
                file.recheck_at = None;
                log::warn!("{}: {error}", path.display());
                self.emit(WatchEvent::FileError {
                    path,
                    error: error.to_string(),
                });
            }
        }
    }

    /// A file is gone. With its folder still there it was deleted or renamed
    /// away: forget it (offset 0, hands kept). Without the folder (a drive
    /// pulled out) keep everything and walk the folder at once, which marks
    /// it unavailable.
    fn on_gone(&mut self, path: &Path, source_id: i64) {
        let root_there = self
            .sources
            .get(&source_id)
            .is_some_and(|source| source.path.is_dir());
        if !root_there {
            if let Some(file) = self.files.get_mut(path) {
                file.recheck_at = None;
            }
            if let Some(source) = self.sources.get_mut(&source_id) {
                source.next_scan = time::now_ms();
            }
            return;
        }
        if let Some(mut file) = self.files.remove(path) {
            let mut track = file.track.take().unwrap_or_default();
            let file_ref = FileRef {
                path,
                source_id: Some(source_id),
                site_override: None,
            };
            match self.reader.forget(&file_ref, &mut track) {
                Ok(()) => log::info!("{}: gone", path.display()),
                Err(error) => log::warn!("{}: {error}", path.display()),
            }
        }
    }

    /// Copy what `status` reads into the shared state.
    fn publish(&self) {
        let mut counts: HashMap<i64, (u32, u32)> = HashMap::new();
        for file in self.files.values() {
            let entry = counts.entry(file.source_id).or_default();
            entry.0 += u32::from(file.error);
            entry.1 += u32::from(file.pending);
        }
        let mut shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        shared.sources = self
            .sources
            .values()
            .map(|source| {
                let (file_errors, pending) = counts.get(&source.id).copied().unwrap_or_default();
                (
                    source.id,
                    SourceShared {
                        state: source.state,
                        error: source.error.clone(),
                        file_errors,
                        pending,
                        poll_only: source.poll_only,
                    },
                )
            })
            .collect();
    }
}
