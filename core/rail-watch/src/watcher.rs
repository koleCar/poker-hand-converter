//! The watcher service: what the app starts after the store.
//!
//! # Threads
//!
//! - **Coordinator** (one): owns the OS notification watcher (`notify`:
//!   FSEvents, ReadDirectoryChangesW, inotify), the list of folders, and
//!   what is known of every file. It turns notifications, rescans and
//!   recheck times into "this file may have something new" and hands those
//!   files to the import threads - never the same file to two at once. It
//!   does no file reading and no conversion itself.
//! - **Import threads** (a rayon pool of [`WatchConfig::workers`], R1.6):
//!   run [`FileReader::start`] - read the new bytes, convert, queue the
//!   batch with the store's writer - and go on to the next file without
//!   waiting for the commit. A large read is cut into batches that convert
//!   in parallel on the same threads (work stealing: no more threads than
//!   the pool) and commits them before it returns. At most as many files
//!   are being read as the pool has threads (or
//!   [`Watcher::set_import_threads`] allows); the writer's queue is
//!   bounded, so when it is full the threads block and the coordinator
//!   keeps the files queued (back-pressure without unbounded memory).
//! - **Committer** (one): waits for the commits of the batches the import
//!   threads queued, in order, and answers the coordinator as the import
//!   thread did before (a file stays in flight - never read twice at once -
//!   until its commit is answered). Waiting for each commit on the import
//!   thread was ~15 % of its time with a commit at ~1 ms (measured, 3
//!   threads), more on a machine with no core to spare for the writer.
//!
//! # Which file goes first
//!
//! Files the OS reported (a room writing a hand) and files whose recheck
//! time came go to the **front** of the queue; files a walk found (a
//! backfill, a rescan) to the back. So a hand being played is read before
//! the rest of a backfill.
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
//!   quiet period, a refused tail waiting for the give-up time, the rest of
//!   a large read).
//!
//! # Backfill progress
//!
//! Per folder, the coordinator counts what it has to read (each queued
//! file's size minus its stored offset) and what has been committed of it,
//! files and hands: a **run** lasts while any of the folder's files is
//! queued or being read. A run of at least [`BACKFILL_MIN_BYTES`] - a
//! backfill, not a hand being played - is reported:
//! [`SourceStatus::backfill`] and [`WatchEvent::Progress`]. A run ends
//! once, after the last of its files is read (`Progress { backfill: None }`),
//! and the status is written before a progress event goes out: a status
//! read on one shows what it says, or later. New bytes after the end are a
//! new run (a new `started_at`).
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
//! # Changing a folder under its reads
//!
//! A change of a folder that a read in flight would get wrong first
//! **fences** the folder: the coordinator starts no new read of its files,
//! asks a large read of it to stop after the batches it is committing
//! ([`ImportLimits::stop_folder`]), and answers once none is in flight (a
//! read ends with its commit answered, so nothing of it is still with the
//! writer); then the store is changed, and the reload that follows lets
//! the folder's reads go again under the new settings (or drops them). A
//! read that ran across the change used to commit under the old settings:
//!
//! - [`Watcher::set_source_path`]: a read of the old path that looked at
//!   the store after the move found no row there, read the whole file
//!   again from 0 and gave the folder a second row for the old path (its
//!   hands deduped, but the folder counted a file too many and detached
//!   it at its next change);
//! - [`Watcher::set_source_site_override`]: its batch met the reset offset
//!   and was read again with the old room;
//! - [`Watcher::remove_source`]: its batch named the deleted folder and
//!   failed (`FOREIGN KEY constraint failed`, a [`WatchEvent::FileError`],
//!   the read lost), or - a folder added right after gets the removed
//!   one's id when that was the highest, as SQLite numbers rows - joined
//!   the new folder with the old folder's file and hands;
//! - [`Watcher::set_source_enabled`] (off): its hands were committed after
//!   the folder showed disabled, a large read's to the end of the file;
//! - [`Watcher::set_source_recursive`] (off) and a room given to a folder
//!   already there ([`Watcher::add_source_with`], whose `files.glob` may
//!   leave files out): a file the folder no longer covers was read on.
//!
//! A folder being added with a room or "only new hands"
//! ([`Watcher::add_source_with`]) is in the store a moment before its room
//! and marks are; a reload already on its way (the one [`Watcher::start`]
//! sends, or another folder's) could load it then and read it with
//! neither - its old hands, other rooms' files. The coordinator is told
//! first to **hold** every folder a reload loads for the first time (it is
//! fenced) and lets them go after the reload that follows the setup.
//!
//! Not fenced, because no read in flight can go wrong across them:
//! [`Watcher::set_source_poll_only`] (only how changes are noticed, not how
//! a file is read or committed), enabling a folder and switching its
//! subfolders on (every read in flight is of a file the folder still
//! covers, read as before; the reload's walk reads each file on from the
//! store's offset, which the store moves only with a batch that starts
//! where it stands), and [`Watcher::retry_refused`] (its reset is guarded
//! the same way: a batch from the old offset is refused and read again
//! from 0, and the coordinator starts the file afresh after its read).
//!
//! # Stopping
//!
//! [`Watcher::stop`] (or dropping it) asks large reads to stop after the
//! batches they are committing, finishes the reads in progress and ends the
//! threads. Stop the watcher **before** the store closes: closing the store
//! waits for every handle on its writer, and the watcher holds some.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecursiveMode, Watcher as _};
use rail_store::{ParserVersions, WriterHandle, time};

use crate::error::{Error, Result};
use crate::reader::{
    Attempt, Committing, FileReader, FileRef, FileTrack, Finished, ImportLimits, Polled,
    ReadConfig, Started,
};
use crate::scan;

/// The most import threads [`default_workers`] picks.
pub const MAX_DEFAULT_WORKERS: usize = 8;

/// A run of a folder is a backfill worth showing from this many bytes to
/// read: a hand being played is a few KB.
pub const BACKFILL_MIN_BYTES: u64 = 1024 * 1024;

/// How often the coordinator copies its state for [`Watcher::status`] and
/// reports progress, at most.
const PUBLISH_MS: i64 = 200;

/// The default number of import threads: the machine's physical cores minus
/// one (the poker client and the HUD keep a core), at least 1, at most
/// [`MAX_DEFAULT_WORKERS`].
pub fn default_workers() -> usize {
    num_cpus::get_physical()
        .saturating_sub(1)
        .clamp(1, MAX_DEFAULT_WORKERS)
}

/// The service's settings.
#[derive(Debug, Clone)]
pub struct WatchConfig {
    /// The reader's timing (quiet period, give-up time) and batch size.
    pub read: ReadConfig,
    /// Every folder is walked this often, notifications or not.
    pub rescan: Duration,
    /// A poll-only folder is walked this often.
    pub poll_interval: Duration,
    /// Import threads: files read and converted in parallel, and the
    /// batches of a large read (default [`default_workers`]).
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
            workers: default_workers(),
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

/// What [`Watcher::set_source_path`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SourceMoved {
    /// The store's side: files moved with their offsets, adopted, detached
    /// (`found: false` when there is no such folder).
    pub change: rail_store::PathChange,
    /// Files of the new folder stored as read without importing them
    /// ("only new hands").
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

/// A folder's backfill in progress: what it has to read and what is done
/// (see "Backfill progress" in the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Backfill {
    /// Bytes read and committed of `bytes_total`.
    pub bytes_done: u64,
    /// Bytes to read: each queued file's size minus its stored offset when
    /// it was queued (a file that grows meanwhile adds its growth).
    pub bytes_total: u64,
    /// Files finished of `files_total`.
    pub files_done: u32,
    pub files_total: u32,
    /// Hands stored by this run.
    pub hands: u64,
    /// When the run started, ms since the epoch.
    pub started_at: i64,
}

/// One folder's status: the watcher's state and the store's counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatus {
    pub id: i64,
    pub path: String,
    /// Switched on (a disabled folder keeps its hands).
    pub enabled: bool,
    pub recursive: bool,
    pub poll_only: bool,
    /// The room it is the default folder of (`sources.site`), if known.
    pub site: Option<String>,
    /// The parser forced for every file of it (`sources.site_override`),
    /// the user's choice when detection fails.
    pub site_override: Option<String>,
    pub state: SourceState,
    /// Why the folder is unavailable or in error.
    pub error: Option<String>,
    /// Files whose last read failed (permissions, I/O), now.
    pub file_errors: u32,
    /// Files with new bytes that are not a complete hand yet.
    pub pending: u32,
    /// A backfill in progress (R1.6), when there is one worth showing.
    pub backfill: Option<Backfill>,
    /// From the store (rollups: constant cost, R1.6).
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
    /// Import threads, and how many may run at once now.
    pub threads: usize,
    pub threads_allowed: usize,
    /// Files waiting to be read, and being read now.
    pub queued: usize,
    pub reading: usize,
    pub sources: Vec<SourceStatus>,
}

/// What the watcher reports as it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// A batch was committed (or the batches of a large read).
    Imported {
        source_id: Option<i64>,
        path: PathBuf,
        inserted: u32,
        duplicates: u32,
        quarantined: u32,
        from: u64,
        to: u64,
        /// (R3.7) When the watcher first noticed the change this commit
        /// completes - the OS's notification, or a walk that found the file
        /// changed - in Unix milliseconds: where the HUD's latency chain
        /// starts. The bytes a commit leaves behind (a file not yet quiet,
        /// a large read's later batches) keep the latest change noticed
        /// before it, so their commit has a stamp too. `None` for a read no
        /// change started (a reset, a recheck of a file whose bytes were
        /// all committed).
        noticed_ms: Option<i64>,
    },
    /// A folder changed state.
    Source {
        id: i64,
        state: SourceState,
        error: Option<String>,
    },
    /// A folder's backfill moved on (at most every 200 ms), or ended
    /// (`None`, once per backfill). [`Watcher::status`] shows it by the
    /// time it is reported.
    Progress {
        source_id: i64,
        backfill: Option<Backfill>,
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
    /// These files (path, folder) were set back to offset 0 in the store:
    /// read them again.
    Reread(Vec<(PathBuf, i64)>),
    /// Start no read of the folder's files; answer once none is in flight.
    Fence(i64, Sender<()>),
    /// Undo one `Fence` of the folder (after the reload that follows it).
    Unfence(i64),
    /// Fence every folder a reload loads for the first time from now on
    /// (a folder being added: its row is in the store before its room and
    /// "only new" marks are); answer at once.
    HoldNew(Sender<()>),
    /// Undo one `HoldNew`: with none left, the folders it fenced go.
    ReleaseNew,
    Stop,
}

/// Everything the coordinator waits for.
enum Msg {
    Fs(notify::Result<notify::Event>),
    Done(Box<Done>),
    /// The file's batch is with the writer: its import thread is free.
    Committing(PathBuf),
    /// The stored offset moved under the file's batch: read it again at
    /// once (the rest of the same look, [`Finished::Again`]).
    Again(Box<Job>),
    Cmd(Command),
}

/// A read's answer.
struct Done {
    path: PathBuf,
    track: FileTrack,
    result: Result<Polled>,
}

/// A read to do.
struct Job {
    path: PathBuf,
    source_id: i64,
    site_override: Option<String>,
    track: FileTrack,
    attempt: Attempt,
}

/// A read whose batch is with the writer, for the committer.
struct Commit {
    job: Job,
    committing: Committing,
}

/// What the coordinator shares with the handle (for `status`).
#[derive(Debug, Default)]
struct Shared {
    running: bool,
    queued: usize,
    reading: usize,
    sources: HashMap<i64, SourceShared>,
}

#[derive(Debug, Clone, Default)]
struct SourceShared {
    state: Option<SourceState>,
    error: Option<String>,
    file_errors: u32,
    pending: u32,
    poll_only: bool,
    backfill: Option<Backfill>,
}

/// The running watcher. Dropping it stops it.
pub struct Watcher {
    inbox: Sender<Msg>,
    writer: WriterHandle,
    reader: Arc<FileReader>,
    shared: Arc<Mutex<Shared>>,
    paused: Arc<AtomicBool>,
    limits: Arc<ImportLimits>,
    threads: usize,
    detect_network: bool,
    file_globs: BTreeMap<String, String>,
    thread: Option<JoinHandle<()>>,
}

/// A folder fenced by [`Watcher::fence`]: its reads go again when this is
/// dropped.
struct Fence<'a> {
    watcher: &'a Watcher,
    id: i64,
}

impl Drop for Fence<'_> {
    fn drop(&mut self) {
        let _ = self.watcher.send(Command::Unfence(self.id));
    }
}

/// New folders held by [`Watcher::hold_new`]: they go when this is dropped.
struct HeldNew<'a> {
    watcher: &'a Watcher,
}

impl Drop for HeldNew<'_> {
    fn drop(&mut self) {
        let _ = self.watcher.send(Command::ReleaseNew);
    }
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watcher")
            .field("paused", &self.is_paused())
            .field("threads", &self.threads)
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
        let limits = Arc::new(ImportLimits::default());
        let reader = Arc::new(
            FileReader::new(store_path, writer.clone(), config.read.clone())?
                .with_limits(Arc::clone(&limits)),
        );
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

        let threads = config.workers.max(1);
        // A hook for later (docs/RAIL-PLAN.md R1.6): a lower OS priority for
        // these threads while tables are played belongs in `start_handler`;
        // fewer of them is `Watcher::set_import_threads`.
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|n| format!("rail-import-{n}"))
            .build()
            .map_err(|error| Error::io("rail-import", std::io::Error::other(error)))?;

        let (commits, commit_queue) = mpsc::channel();
        let committer = {
            let inbox = inbox.clone();
            thread::Builder::new()
                .name("rail-commit".to_owned())
                .spawn(move || run_committer(&commit_queue, &inbox))
                .map_err(|error| Error::io("rail-commit", error))?
        };

        let detect_network = config.detect_network;
        let file_globs = config.file_globs.clone();
        let coordinator = Coordinator {
            config,
            reader: Arc::clone(&reader),
            writer: writer.clone(),
            notifier,
            messages,
            inbox: inbox.clone(),
            pool: Some(pool),
            commits: Some(commits),
            committer: Some(committer),
            threads,
            limits: Arc::clone(&limits),
            shared: Arc::clone(&shared),
            paused: Arc::clone(&paused),
            on_event,
            sources: HashMap::new(),
            files: HashMap::new(),
            in_flight: HashMap::new(),
            committing: HashSet::new(),
            queue: VecDeque::new(),
            queued: HashSet::new(),
            again: HashMap::new(),
            rechecks: BTreeSet::new(),
            fenced: HashMap::new(),
            fence_waiters: Vec::new(),
            holding_new: 0,
            held_new: Vec::new(),
            ended: Vec::new(),
            last_publish: 0,
            publish_now: true,
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
            limits,
            threads,
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

    /// Fence folder `id` (see "Changing a folder under its reads"): returns
    /// once none of its files is being read, and none is started until the
    /// fence is dropped. Waits for the reads in flight (one look per file;
    /// a large read stops after the batches it is committing). Not from the
    /// `on_event` callback, which runs on the coordinator.
    fn fence(&self, id: i64) -> Result<Fence<'_>> {
        let (reply, answer) = mpsc::channel();
        self.send(Command::Fence(id, reply))?;
        // Undone on every way out, a failed wait included.
        let fence = Fence { watcher: self, id };
        answer.recv().map_err(|_| Error::Stopped)?;
        Ok(fence)
    }

    /// Make `change` to folder `id` in the store under a fence, then
    /// reload; the folder's reads go again (or are dropped) after the
    /// reload. A failed change reloads nothing.
    fn change_fenced<T>(&self, id: i64, change: impl FnOnce() -> Result<T>) -> Result<T> {
        let _fence = self.fence(id)?;
        let value = change()?;
        self.send(Command::Reload)?;
        Ok(value)
    }

    /// Stop reading new bytes; notifications are still noted, and resuming
    /// reads everything that changed meanwhile. A large read stops after
    /// the batches it is committing.
    pub fn pause(&self) -> Result<()> {
        self.limits.interrupt(true);
        self.send(Command::Pause)
    }

    pub fn resume(&self) -> Result<()> {
        self.limits.interrupt(false);
        self.send(Command::Resume)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Use at most `threads` import threads at once (`None`: all of
    /// [`WatchConfig::workers`]) - the hook for importing more gently while
    /// tables are played (Phase 3 knows when; nothing calls it yet). Takes
    /// effect for the next files and the next group of a large read.
    pub fn set_import_threads(&self, threads: Option<usize>) {
        self.limits.set_threads(threads.unwrap_or(0));
        // Wake the coordinator so it dispatches up to the new limit.
        let _ = self.send(Command::Rescan);
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
    ///
    /// The room and the marks are written after the folder's row (see
    /// "Changing a folder under its reads"). A new folder is held until
    /// they are: a reload already on its way (the one [`Watcher::start`]
    /// sends, another folder's) would otherwise load it in between and
    /// read it with neither - its old hands, files of other rooms. A folder
    /// already there given a room is fenced: under the room's glob it may
    /// cover fewer files, and a read of one it no longer covers would go
    /// on. Without a room, "only new" on a folder already there needs
    /// neither: it marks only files the store has no row for, and a first
    /// read of one already in flight commits from 0 either way (always
    /// accepted) - the file is read as it was being read.
    pub fn add_source_with(&self, path: &Path, options: &NewSource) -> Result<AddedSource> {
        let poll_only = options
            .poll_only
            .unwrap_or_else(|| self.detect_network && scan::is_network_path(path));
        let set_up = options.site.is_some() || options.only_new;
        let _held = if set_up { Some(self.hold_new()?) } else { None };
        let id = self.writer.add_source(
            &rail_store::import::path_key(path),
            options.recursive,
            None,
            poll_only,
        )?;
        // Undone after the reload below, before the hold (dropped in
        // reverse order).
        let _fence = if options.site.is_some() {
            Some(self.fence(id)?)
        } else {
            None
        };
        if let Some(site) = &options.site {
            self.writer.set_source_site(id, Some(site))?;
        }
        let marked = if options.only_new {
            self.mark_existing(id, path, options.recursive, options.site.as_deref())
        } else {
            0
        };
        self.send(Command::Reload)?;
        Ok(AddedSource { id, marked })
    }

    /// Hold the folders a reload loads for the first time from now on (they
    /// are fenced) until the guard is dropped. Returns once the coordinator
    /// has handled every command sent before, so a reload that comes before
    /// it cannot see a folder added after it returns.
    fn hold_new(&self) -> Result<HeldNew<'_>> {
        let (reply, answer) = mpsc::channel();
        self.send(Command::HoldNew(reply))?;
        let held = HeldNew { watcher: self };
        answer.recv().map_err(|_| Error::Stopped)?;
        Ok(held)
    }

    /// "Only new hands": store the folder's matching files that the store
    /// has no row for as read to their end ([`FileReader::mark_read`]).
    /// Returns how many were marked.
    fn mark_existing(&self, id: i64, path: &Path, recursive: bool, site: Option<&str>) -> u32 {
        let glob = site
            .and_then(|site| self.file_globs.get(site))
            .map(String::as_str);
        let mut marked = 0;
        // A folder that is not there (yet) has nothing to skip.
        if let Ok(walk) = scan::walk_matching(path, recursive, glob) {
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
        marked
    }

    /// Stop watching a folder and forget it; its hands stay.
    ///
    /// The folder's reads in progress finish first (see "Changing a folder
    /// under its reads"): what they read is stored under the folder, then
    /// detached with the rest, and nothing of it comes after - a batch
    /// after the removal named a folder that was gone, or the next folder
    /// added, which may get the same id.
    pub fn remove_source(&self, id: i64) -> Result<bool> {
        self.change_fenced(id, || Ok(self.writer.remove_source(id)?))
    }

    /// Enable or disable a folder; a disabled folder keeps its hands.
    ///
    /// Disabling waits for the folder's reads in progress (see "Changing a
    /// folder under its reads"): once it returns, nothing more of the
    /// folder is stored. Enabling needs no fence: a disabled folder has no
    /// read in flight, and an enabled one reads on as before.
    pub fn set_source_enabled(&self, id: i64, enabled: bool) -> Result<bool> {
        if enabled {
            let found = self.writer.set_source_enabled(id, enabled)?;
            self.send(Command::Reload)?;
            return Ok(found);
        }
        self.change_fenced(id, || Ok(self.writer.set_source_enabled(id, enabled)?))
    }

    /// Read a folder by polling only, or with notifications again.
    ///
    /// Not fenced: this changes only how the folder's changes are noticed
    /// (OS notifications, or a walk every poll interval), not which files
    /// are read nor how a read is committed. A read in flight commits as
    /// it would have, and the reload keeps the folder's tracked files and
    /// backfill (it re-registers the OS watch only).
    pub fn set_source_poll_only(&self, id: i64, poll_only: bool) -> Result<bool> {
        let found = self.writer.set_source_poll_only(id, poll_only)?;
        self.send(Command::Reload)?;
        Ok(found)
    }

    /// Watch a folder's subfolders too, or only its top level. Files read
    /// from subfolders before keep their hands.
    ///
    /// Switching subfolders off waits for the folder's reads in progress
    /// (see "Changing a folder under its reads"): once it returns, no file
    /// of a subfolder is read any more. Switching them on needs no fence:
    /// every read in flight is of a file the folder still covers, read as
    /// before, and the reload's walk reads each file on from the store's
    /// offset.
    pub fn set_source_recursive(&self, id: i64, recursive: bool) -> Result<bool> {
        if recursive {
            let found = self.writer.set_source_recursive(id, recursive)?;
            self.send(Command::Reload)?;
            return Ok(found);
        }
        self.change_fenced(id, || {
            Ok(self.writer.set_source_recursive(id, recursive)?)
        })
    }

    /// Read every file of a folder with one parser (a `rail_core` parser
    /// id), or `None` to detect the room per file again - the user's choice
    /// when detection fails. The files the new choice reads differently are
    /// read again from their start
    /// ([`WriterHandle::set_source_site_override`]); hands stay and dedupe.
    /// The folder's reads in progress finish first, and none starts until
    /// the watcher has the new choice (see "Changing a folder under its
    /// reads").
    pub fn set_source_site_override(
        &self,
        id: i64,
        parser: Option<&str>,
    ) -> Result<rail_store::OverrideChange> {
        if let Some(parser) = parser
            && rail_core::parsers::builtin().get(parser).is_none()
        {
            return Err(Error::UnknownParser(parser.to_owned()));
        }
        self.change_fenced(id, || {
            let change = self.writer.set_source_site_override(id, parser)?;
            if change.found {
                log::info!(
                    "folder {id}: room {}, {} files to read again",
                    parser.unwrap_or("detected per file"),
                    change.reset
                );
            }
            Ok(change)
        })
    }

    /// The parsers of this build with their versions, as the store compares
    /// them with a refusal's.
    pub fn parser_versions() -> ParserVersions {
        ParserVersions::new(
            rail_core::parsers::builtin()
                .parsers()
                .map(|parser| (parser.id(), parser.version())),
        )
    }

    /// "Try again after an update" (R1.6): the files of folder `source_id`
    /// (or of every folder) holding refused hands that an older version of
    /// their parser refused go back to offset 0 without those refusals
    /// ([`WriterHandle::reset_stale_refusals`]) and are read again now with
    /// this build's parsers; hands stay and dedupe. Returns how many files
    /// are read again.
    pub fn retry_refused(&self, source_id: Option<i64>) -> Result<u32> {
        let reset = self
            .writer
            .reset_stale_refusals(&Self::parser_versions(), source_id)?;
        let count = u32::try_from(reset.len()).unwrap_or(u32::MAX);
        log::info!(
            "{count} files with refusals by an older parser version to read again{}",
            source_id.map_or_else(String::new, |id| format!(" (folder {id})"))
        );
        if !reset.is_empty() {
            self.send(Command::Reread(
                reset
                    .into_iter()
                    .map(|file| (PathBuf::from(file.path), file.source_id))
                    .collect(),
            ))?;
        }
        Ok(count)
    }

    /// Give a folder a new path, keeping its settings (Settings → Folders,
    /// R1.5).
    ///
    /// Each file the folder has read is looked for under the new path at
    /// the same relative path; one that is there, a file at least as long
    /// as what was read of it, is taken to be the same file (a folder moved
    /// or copied, a drive mounted elsewhere): its row moves with its offset
    /// and the watcher continues where it stopped. The rest are detached
    /// with their hands kept, so a folder with none of the old files is
    /// remove + add with the same settings. Should the file found differ
    /// after all, the reader notices (the bytes at the offset start no
    /// hand) and reads it whole from 0, with dedupe keeping hands once.
    ///
    /// `only_new`: the new folder's files that no row covers are marked as
    /// read ("only new hands", as when adding a folder); otherwise they are
    /// imported. Fails with the store's `PathTaken` when another folder has
    /// the path.
    ///
    /// The folder's reads in progress finish first, and none starts until
    /// the watcher has the new path (see "Changing a folder under its
    /// reads"): the offsets compared are final, and no read of an old path
    /// lands after its row moved.
    pub fn set_source_path(&self, id: i64, path: &Path, only_new: bool) -> Result<SourceMoved> {
        // The folder and its files as they stand once its reads are done.
        let _fence = self.fence(id)?;
        let Some(row) = self
            .reader
            .store_reader()
            .sources()?
            .into_iter()
            .find(|row| row.id == id)
        else {
            return Ok(SourceMoved::default());
        };
        let old = PathBuf::from(&row.path);
        let mut moves = Vec::new();
        for file in self.reader.store_reader().source_files(id)? {
            let Ok(relative) = Path::new(&file.path).strip_prefix(&old) else {
                continue;
            };
            let candidate = path.join(relative);
            let read = u64::try_from(file.read_offset).unwrap_or(u64::MAX);
            let same = std::fs::metadata(&candidate)
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() >= read);
            if same {
                moves.push(rail_store::FileMove {
                    from: file.path,
                    to: rail_store::import::path_key(&candidate),
                });
            }
        }
        let change = self
            .writer
            .set_source_path(id, &rail_store::import::path_key(path), moves)?;
        let marked = if only_new && change.found {
            self.mark_existing(id, path, row.recursive, row.site.as_deref())
        } else {
            0
        };
        log::info!(
            "folder {id}: {} -> {}: {} files moved, {} adopted, {} detached, {marked} marked",
            old.display(),
            path.display(),
            change.moved,
            change.adopted,
            change.detached
        );
        self.send(Command::Reload)?;
        Ok(SourceMoved { change, marked })
    }

    /// Every folder with its state, counts and backfill progress. Cheap at
    /// any store size: the counts are the store's rollups (R1.6).
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
                    enabled: row.enabled,
                    recursive: row.recursive,
                    poll_only: row.poll_only || live.poll_only,
                    site: row.site,
                    site_override: row.site_override,
                    state,
                    error: live.error,
                    file_errors: live.file_errors,
                    pending: live.pending,
                    backfill: live.backfill,
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
            threads: self.threads,
            threads_allowed: self.limits.cap(self.threads),
            queued: shared.queued,
            reading: shared.reading,
            sources,
        })
    }

    /// Stop: finish the reads in progress, then end the threads.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.limits.interrupt(true);
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

/// One read, on an import thread: up to its batch being queued with the
/// writer, whose commit the committer waits for.
fn run_job(mut job: Job, reader: &FileReader, inbox: &Sender<Msg>, commits: &Sender<Commit>) {
    let file = FileRef {
        path: &job.path,
        source_id: Some(job.source_id),
        site_override: job.site_override.as_deref(),
    };
    let message = match reader.start(&file, &mut job.track, time::now_ms(), job.attempt) {
        Ok(Started::Committing(committing)) => {
            // Before the committer can answer: the coordinator sees this
            // first (one channel, sent in this order).
            let _ = inbox.send(Msg::Committing(job.path.clone()));
            match commits.send(Commit { job, committing }) {
                Ok(()) => return,
                // No committer (it is only ended after the last read): wait
                // here.
                Err(mpsc::SendError(commit)) => settle(commit),
            }
        }
        Ok(Started::Done(polled)) => done(job, Ok(polled)),
        Err(error) => done(job, Err(error)),
    };
    let _ = inbox.send(message);
}

fn done(job: Job, result: Result<Polled>) -> Msg {
    Msg::Done(Box::new(Done {
        path: job.path,
        track: job.track,
        result,
    }))
}

/// Wait for a read's commit: the coordinator's answer.
fn settle(commit: Commit) -> Msg {
    let Commit {
        mut job,
        committing,
    } = commit;
    match committing.wait(&mut job.track) {
        Ok(Finished::Done(polled)) => done(job, Ok(polled)),
        Ok(Finished::Again(attempt)) => {
            job.attempt = attempt;
            Msg::Again(Box::new(job))
        }
        Err(error) => done(job, Err(error)),
    }
}

/// The committer: answers each queued read once its batch is committed, in
/// the order they were queued (the writer commits in that order too).
fn run_committer(commits: &Receiver<Commit>, inbox: &Sender<Msg>) {
    while let Ok(commit) = commits.recv() {
        let _ = inbox.send(settle(commit));
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
    /// The backfill run in progress.
    run: Option<Run>,
}

/// A folder's run: see "Backfill progress".
#[derive(Debug, Clone, Copy)]
struct Run {
    progress: Backfill,
    /// Big enough to report (it stays reported until it ends).
    shown: bool,
    /// Changed since it was last reported.
    changed: bool,
}

/// A file's part in its folder's run.
#[derive(Debug, Clone, Copy)]
struct FileRun {
    /// The stored offset when it joined.
    start: u64,
    /// Its size then (or later, when it grew).
    target: u64,
    /// Bytes of `start..target` counted as done.
    credited: u64,
}

/// A file as the coordinator knows it.
#[derive(Debug)]
struct FileRt {
    source_id: i64,
    /// `None` while a read has it.
    track: Option<FileTrack>,
    /// Size and mtime at the last walk.
    walked: Option<(u64, Option<i64>)>,
    recheck_at: Option<i64>,
    error: bool,
    pending: bool,
    /// The stored offset as last known (a walk's query, a commit).
    offset: Option<u64>,
    /// In its folder's run.
    run: Option<FileRun>,
    /// Set back in the store while a read had it: start afresh after.
    reset: bool,
    /// (R3.7) The first change noticed since the last commit, Unix ms
    /// ([`WatchEvent::Imported`]'s `noticed_ms`).
    noticed_ms: Option<i64>,
    /// The latest change noticed, Unix ms: what the bytes a commit leaves
    /// behind were noticed by (see [`FileRt::committed`]).
    last_noticed_ms: Option<i64>,
}

impl FileRt {
    fn new(source_id: i64) -> Self {
        Self {
            source_id,
            track: Some(FileTrack::default()),
            walked: None,
            recheck_at: None,
            error: false,
            pending: false,
            offset: None,
            run: None,
            reset: false,
            noticed_ms: None,
            last_noticed_ms: None,
        }
    }

    /// A change of the file was noticed at `now` (a notification, or a walk
    /// that found it changed).
    fn noticed(&mut self, now: i64) {
        self.noticed_ms.get_or_insert(now);
        self.last_noticed_ms = Some(now);
    }

    /// A commit: the stamp it completes (taken), and the stamp the rest
    /// keeps. A commit that leaves bytes behind (`rest`: the file was not
    /// quiet, so only the hands the next one's start proves complete went
    /// in; the last one is committed by a recheck once the file is quiet)
    /// leaves them the latest change noticed before it - they were on disk
    /// when it read, so a change no later than that one brought them. Without
    /// this the rest's commit had no stamp at all (only a new notification
    /// set one, and a hand written whole within the quiet period of the one
    /// before gets none): R3.7's chain lost its start for every second hand
    /// written close behind another (seen on Windows CI).
    fn committed(&mut self, rest: bool) -> Option<i64> {
        let taken = self.noticed_ms.take();
        if rest {
            self.noticed_ms = self.last_noticed_ms.or(taken);
        }
        taken
    }
}

struct Coordinator {
    config: WatchConfig,
    reader: Arc<FileReader>,
    writer: WriterHandle,
    notifier: notify::RecommendedWatcher,
    messages: Receiver<Msg>,
    /// For the import threads' answers.
    inbox: Sender<Msg>,
    pool: Option<rayon::ThreadPool>,
    /// The committer's queue and thread (ended after the pool).
    commits: Option<Sender<Commit>>,
    committer: Option<JoinHandle<()>>,
    threads: usize,
    limits: Arc<ImportLimits>,
    shared: Arc<Mutex<Shared>>,
    paused: Arc<AtomicBool>,
    on_event: OnEvent,
    sources: HashMap<i64, SourceRt>,
    files: HashMap<PathBuf, FileRt>,
    /// The files being read, with their folder (known even when the
    /// folder's files were dropped meanwhile: a fence waits for these too).
    in_flight: HashMap<PathBuf, i64>,
    /// The files of `in_flight` whose batch is with the writer: their
    /// import thread is free for another file.
    committing: HashSet<PathBuf>,
    /// Files to read, in order (see "Which file goes first"), and the same
    /// set for lookups.
    queue: VecDeque<PathBuf>,
    queued: HashSet<PathBuf>,
    /// Files that changed while a read had them: queued again when it
    /// answers (`true`: at the front).
    again: HashMap<PathBuf, bool>,
    /// Recheck times, earliest first.
    rechecks: BTreeSet<(i64, PathBuf)>,
    /// Fenced folders (with how many fences each): none of their files is
    /// dispatched.
    fenced: HashMap<i64, u32>,
    /// Fences to answer once their folder has no read in flight.
    fence_waiters: Vec<(i64, Sender<()>)>,
    /// `HoldNew`s not released yet, and the folders fenced by them.
    holding_new: u32,
    held_new: Vec<i64>,
    /// Folders whose backfill ended since the last publish: reported by
    /// it, after the status shows the end.
    ended: Vec<i64>,
    last_publish: i64,
    publish_now: bool,
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
            self.answer_fences();
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

    /// Let the reads in flight finish (large ones stop early: the handle
    /// set the interrupt), then end the import threads.
    fn finish(&mut self) {
        // A backfill that ended this turn is reported (and shown over).
        self.publish_now = true;
        self.publish();
        while !self.in_flight.is_empty() {
            match self.messages.recv_timeout(Duration::from_millis(50)) {
                Ok(Msg::Done(done)) => {
                    self.in_flight.remove(&done.path);
                    self.committing.remove(&done.path);
                }
                Ok(Msg::Again(job)) => self.again_now(*job),
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        // Dropping the pool ends its threads (nothing is queued in it), and
        // then the committer (nothing is queued in it either).
        self.pool = None;
        self.commits = None;
        if let Some(committer) = self.committer.take() {
            let _ = committer.join();
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
        let recheck = self.rechecks.first().map(|(at, _)| *at);
        scans.chain(recheck).min().map(|at| at.max(now))
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
            Msg::Committing(path) => {
                if self.in_flight.contains_key(&path) {
                    self.committing.insert(path);
                }
            }
            Msg::Again(job) => self.again_now(*job),
            Msg::Cmd(command) => {
                self.publish_now = true;
                match command {
                    Command::Reload => self.reload(),
                    Command::Pause => {
                        if !self.paused.swap(true, Ordering::SeqCst) {
                            log::info!("import paused");
                            self.emit(WatchEvent::Paused(true));
                        }
                    }
                    Command::Resume => {
                        if self.paused.swap(false, Ordering::SeqCst) {
                            log::info!("import resumed");
                            let now = time::now_ms();
                            for source in self.sources.values_mut() {
                                source.next_scan = now;
                            }
                            self.emit(WatchEvent::Paused(false));
                        }
                    }
                    Command::Rescan => {
                        let now = time::now_ms();
                        for source in self.sources.values_mut() {
                            source.next_scan = now;
                        }
                    }
                    Command::Reread(files) => self.reread(files),
                    Command::Fence(id, reply) => {
                        self.fence(id);
                        self.fence_waiters.push((id, reply));
                    }
                    Command::Unfence(id) => self.unfence(id),
                    Command::HoldNew(reply) => {
                        self.holding_new += 1;
                        let _ = reply.send(());
                    }
                    Command::ReleaseNew => {
                        self.holding_new = self.holding_new.saturating_sub(1);
                        if self.holding_new == 0 {
                            for id in std::mem::take(&mut self.held_new) {
                                self.unfence(id);
                            }
                        }
                    }
                    Command::Stop => {}
                }
            }
        }
    }

    /// Fence folder `id` once more: none of its files is dispatched, and a
    /// large read of it stops after the batches it is committing (the
    /// fence waits for one group, not for the rest of a big file).
    fn fence(&mut self, id: i64) {
        *self.fenced.entry(id).or_default() += 1;
        self.limits.stop_folder(id, true);
    }

    /// Undo one fence of folder `id`.
    fn unfence(&mut self, id: i64) {
        if let Some(count) = self.fenced.get_mut(&id) {
            *count -= 1;
            if *count == 0 {
                self.fenced.remove(&id);
                self.limits.stop_folder(id, false);
            }
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
                self.drop_files_of(id);
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
            // What decides which files are read, and how.
            let reads_differently = |known: &SourceRt| {
                known.path != path
                    || known.recursive != row.recursive
                    || known.site_override != row.site_override
                    || known.glob != glob
            };
            let changed = self.sources.get(&row.id).is_none_or(|known| {
                known.enabled != row.enabled
                    || known.poll_only != poll_only
                    || reads_differently(known)
            });
            if !changed {
                continue;
            }
            let mut run = None;
            if let Some(old) = self.sources.remove(&row.id) {
                self.unwatch(&old.path, old.watched);
                if reads_differently(&old) {
                    // Other files, or the same ones read another way (a new
                    // path, the subfolders, the room): forget what is
                    // tracked and start from the next walk, from the
                    // offsets in the store.
                    self.drop_files_of(row.id);
                } else {
                    run = old.run;
                }
            } else if self.holding_new > 0 {
                // A folder being added: not read until it is set up.
                self.fence(row.id);
                self.held_new.push(row.id);
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
                run,
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
                self.drop_files_of(row.id);
                source.run = None;
                self.set_state(&mut source, SourceState::Disabled, None);
            }
            self.sources.insert(row.id, source);
        }
    }

    /// Forget every tracked file of a folder (those a read has now are
    /// forgotten when it answers).
    fn drop_files_of(&mut self, id: i64) {
        let paths: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(_, file)| file.source_id == id)
            .map(|(path, _)| path.clone())
            .collect();
        for path in paths {
            if let Some(file) = self.files.remove(&path)
                && let Some(at) = file.recheck_at
            {
                self.rechecks.remove(&(at, path.clone()));
            }
            self.queued.remove(&path);
            self.again.remove(&path);
        }
        // The queue is cleaned lazily: `dispatch` skips paths not in
        // `queued`.
        if let Some(source) = self.sources.get_mut(&id) {
            source.run = None;
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

        // The store's offsets, once per walk and only when a changed file's
        // is not known yet (the first walk, new files): a backfill's size.
        let mut offsets: Option<HashMap<String, u64>> = None;
        let mut present = HashSet::new();
        for (path, size, mtime) in walk.files {
            present.insert(path.clone());
            let file = self
                .files
                .entry(path.clone())
                .or_insert_with(|| FileRt::new(source.id));
            if file.walked != Some((size, mtime)) || file.error {
                file.walked = Some((size, mtime));
                if file.offset.is_none() {
                    let known = offsets.get_or_insert_with(|| {
                        self.reader
                            .store_reader()
                            .source_offsets(source.id)
                            .unwrap_or_default()
                            .into_iter()
                            .map(|(path, offset)| (path, u64::try_from(offset).unwrap_or(0)))
                            .collect()
                    });
                    file.offset = Some(
                        known
                            .get(&rail_store::import::path_key(&path))
                            .copied()
                            .unwrap_or(0),
                    );
                }
                Self::join_run(source, file, size, now);
                file.noticed(now);
                self.enqueue(path, false);
            }
        }
        // Files of this folder the walk did not find: let a read confirm it.
        let missing: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(path, file)| file.source_id == source.id && !present.contains(*path))
            .map(|(path, _)| path.clone())
            .collect();
        for path in missing {
            self.enqueue(path, false);
        }
    }

    /// A file of `source` with `size` bytes is about to be read: it joins
    /// the folder's run with what it has to read, or extends its part.
    fn join_run(source: &mut SourceRt, file: &mut FileRt, size: u64, now: i64) {
        let offset = file.offset.unwrap_or(0);
        // A file smaller than its offset was truncated: read from 0.
        let start = if size < offset { 0 } else { offset };
        if let Some(part) = &mut file.run {
            if size > part.target
                && let Some(run) = &mut source.run
            {
                run.progress.bytes_total += size - part.target;
                run.changed = true;
                part.target = size;
            }
            return;
        }
        if size <= start {
            return;
        }
        let run = source.run.get_or_insert_with(|| Run {
            progress: Backfill {
                started_at: now,
                ..Backfill::default()
            },
            shown: false,
            changed: true,
        });
        run.progress.files_total += 1;
        run.progress.bytes_total += size - start;
        run.shown |= run.progress.bytes_total >= BACKFILL_MIN_BYTES;
        run.changed = true;
        file.run = Some(FileRun {
            start,
            target: size,
            credited: 0,
        });
    }

    /// Queue a file to be read: at the front (a notification, a recheck)
    /// or the back (a walk). One that a read has now is queued again when
    /// the read answers.
    fn enqueue(&mut self, path: PathBuf, front: bool) {
        if self.in_flight.contains_key(&path) {
            let urgent = self.again.entry(path).or_insert(false);
            *urgent |= front;
            return;
        }
        if self.queued.contains(&path) {
            if front {
                // Move it up: the stale entry further back is skipped.
                self.queue.push_front(path);
            }
            return;
        }
        self.queued.insert(path.clone());
        if front {
            self.queue.push_front(path);
        } else {
            self.queue.push_back(path);
        }
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
        // A file opened or read has no new bytes; only a close after writing
        // may mean new ones. inotify reports every open and every read-only
        // close - the watcher's own reads among them - and acting on those
        // made a feedback loop on Linux (R1.6): each look at a file opened
        // it, the open woke the watcher for the same file at the front of
        // the queue, and two such files held the import threads forever
        // while the rest of a backfill waited.
        if let EventKind::Access(kind) = event.kind
            && kind != AccessKind::Close(AccessMode::Write)
        {
            return;
        }
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
                        self.mark(file, source_id, false);
                    }
                }
                continue;
            }
            if scan::is_candidate_for(path, glob.as_deref()) || self.files.contains_key(path) {
                self.mark(path.clone(), source_id, true);
            }
        }
    }

    /// A file changed (a notification; `front`) or appeared in a new
    /// subfolder: track it, count it in its folder's run, queue it.
    fn mark(&mut self, path: PathBuf, source_id: i64, front: bool) {
        let file = self
            .files
            .entry(path.clone())
            .or_insert_with(|| FileRt::new(source_id));
        file.noticed(time::now_ms());
        if let Some(source) = self.sources.get_mut(&file.source_id)
            && let Ok(metadata) = std::fs::metadata(&path)
        {
            if file.offset.is_none() {
                file.offset = Some(0);
            }
            Self::join_run(source, file, metadata.len(), time::now_ms());
        }
        self.enqueue(path, front);
    }

    /// Files the store set back to offset 0 ("try again after an update"):
    /// read them again from their start.
    fn reread(&mut self, files: Vec<(PathBuf, i64)>) {
        let now = time::now_ms();
        for (path, source_id) in files {
            if !self
                .sources
                .get(&source_id)
                .is_some_and(|source| source.enabled)
            {
                continue; // read when the folder is next enabled and walked
            }
            let file = self
                .files
                .entry(path.clone())
                .or_insert_with(|| FileRt::new(source_id));
            file.offset = Some(0);
            file.walked = None;
            match &mut file.track {
                Some(track) => *track = FileTrack::default(),
                None => file.reset = true,
            }
            if let (Some(source), Ok(metadata)) =
                (self.sources.get_mut(&source_id), std::fs::metadata(&path))
            {
                Self::join_run(source, file, metadata.len(), now);
            }
            self.enqueue(path, false);
        }
    }

    fn set_recheck(&mut self, path: &Path, at: Option<i64>) {
        let Some(file) = self.files.get_mut(path) else {
            return;
        };
        if file.recheck_at == at {
            return;
        }
        if let Some(old) = file.recheck_at {
            self.rechecks.remove(&(old, path.to_path_buf()));
        }
        file.recheck_at = at;
        if let Some(at) = at {
            self.rechecks.insert((at, path.to_path_buf()));
        }
    }

    fn recheck_due(&mut self, now: i64) {
        while let Some((at, _)) = self.rechecks.first()
            && *at <= now
        {
            let Some((_, path)) = self.rechecks.pop_first() else {
                break;
            };
            let Some(file) = self.files.get_mut(&path) else {
                continue;
            };
            file.recheck_at = None;
            self.enqueue(path, true);
        }
    }

    /// Start reads of queued files, as many as may run at once.
    fn dispatch(&mut self) {
        if self.pool.is_none() {
            return;
        }
        let cap = self.limits.cap(self.threads);
        // Files of fenced folders: they stay queued, in their order.
        let mut held = Vec::new();
        // Reads waiting only for their commit do not hold a thread.
        while self.in_flight.len().saturating_sub(self.committing.len()) < cap {
            let Some(path) = self.queue.pop_front() else {
                break;
            };
            if !self.queued.remove(&path) {
                continue; // a stale entry: moved up, or its folder dropped
            }
            let Some(file) = self.files.get_mut(&path) else {
                continue;
            };
            if self.fenced.contains_key(&file.source_id) {
                held.push(path);
                continue;
            }
            let Some(source) = self.sources.get(&file.source_id).filter(|s| s.enabled) else {
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
                attempt: Attempt::default(),
            };
            self.in_flight.insert(path, job.source_id);
            self.spawn(job);
        }
        for path in held.into_iter().rev() {
            self.queued.insert(path.clone());
            self.queue.push_front(path);
        }
    }

    /// Answer the fences whose folder has no read in flight.
    fn answer_fences(&mut self) {
        if self.fence_waiters.is_empty() {
            return;
        }
        let in_flight = &self.in_flight;
        self.fence_waiters.retain(|(id, reply)| {
            if in_flight.values().any(|source_id| source_id == id) {
                return true;
            }
            // A handle that stopped waiting has nothing to answer.
            let _ = reply.send(());
            false
        });
    }

    /// Run `job` on the pool (it is in flight).
    fn spawn(&self, job: Job) {
        let (Some(pool), Some(commits)) = (&self.pool, &self.commits) else {
            return;
        };
        let (reader, inbox, commits) = (
            Arc::clone(&self.reader),
            self.inbox.clone(),
            commits.clone(),
        );
        pool.spawn(move || run_job(job, &reader, &inbox, &commits));
    }

    /// A read whose batch met a moved offset goes on at once, as one look
    /// (paused or not: it had started).
    fn again_now(&mut self, job: Job) {
        self.committing.remove(&job.path);
        if self.pool.is_some() && self.commits.is_some() {
            self.spawn(job);
        } else {
            let path = job.path.clone();
            self.on_done(Done {
                path,
                track: job.track,
                result: Ok(Polled::Waiting {
                    recheck_at: Some(time::now_ms()),
                }),
            });
        }
    }

    fn on_done(&mut self, done: Done) {
        let Done {
            path,
            track,
            result,
        } = done;
        self.in_flight.remove(&path);
        self.committing.remove(&path);
        let again = self.again.remove(&path);
        let Some(file) = self.files.get_mut(&path) else {
            return; // its folder was removed meanwhile
        };
        file.track = Some(if std::mem::take(&mut file.reset) {
            FileTrack::default()
        } else {
            track
        });
        let source_id = file.source_id;
        if matches!(result, Ok(Polled::Gone)) {
            self.finish_part(&path);
            self.on_gone(&path, source_id);
            return;
        }
        let mut recheck = None;
        let mut inserted = 0;
        let mut committed_to = None;
        let mut noticed_ms = None;
        let mut more = false;
        match result {
            Ok(Polled::Gone) => {}
            Ok(polled) => {
                recheck = polled.recheck_at();
                if let Some(file) = self.files.get_mut(&path) {
                    file.error = false;
                    if let Polled::Committed { recheck_at, .. } = &polled {
                        noticed_ms = file.committed(recheck_at.is_some());
                    }
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
                }
                if let Polled::Committed {
                    outcome,
                    from,
                    to,
                    recheck_at,
                } = polled
                {
                    log::debug!(
                        "{}: {from}..{to}, {} new, {} known, {} refused",
                        path.display(),
                        outcome.inserted,
                        outcome.duplicates,
                        outcome.quarantined
                    );
                    inserted = outcome.inserted;
                    committed_to = Some(to);
                    more = recheck_at.is_some();
                    self.emit(WatchEvent::Imported {
                        source_id: Some(source_id),
                        path: path.clone(),
                        inserted: outcome.inserted,
                        duplicates: outcome.duplicates,
                        quarantined: outcome.quarantined,
                        from,
                        to,
                        noticed_ms,
                    });
                }
            }
            Err(error) => {
                // Permissions, I/O, the store: noted, tried again at the next
                // rescan (not at once: no spinning on a file that cannot be
                // read).
                if let Some(file) = self.files.get_mut(&path) {
                    file.error = true;
                }
                log::warn!("{}: {error}", path.display());
                self.emit(WatchEvent::FileError {
                    path: path.clone(),
                    error: error.to_string(),
                });
            }
        }
        self.set_recheck(&path, recheck);
        if let Some(to) = committed_to {
            self.credit(&path, to, inserted);
        }
        if !more {
            self.finish_part(&path);
        }
        if let Some(front) = again {
            self.enqueue(path, front);
        }
    }

    /// A commit up to `to` of a file in a run: count its bytes and hands.
    fn credit(&mut self, path: &Path, to: u64, inserted: u32) {
        let Some(file) = self.files.get_mut(path) else {
            return;
        };
        file.offset = Some(to);
        let Some(source) = self.sources.get_mut(&file.source_id) else {
            return;
        };
        let Some(run) = &mut source.run else {
            return;
        };
        run.progress.hands += u64::from(inserted);
        run.changed = true;
        if let Some(part) = &mut file.run {
            let credited = to
                .saturating_sub(part.start)
                .min(part.target.saturating_sub(part.start));
            if credited > part.credited {
                run.progress.bytes_done += credited - part.credited;
                part.credited = credited;
            }
        }
    }

    /// A file has nothing more to read for now: its part of the run is
    /// done; the run ends with its last file.
    fn finish_part(&mut self, path: &Path) {
        let Some(file) = self.files.get_mut(path) else {
            return;
        };
        let Some(part) = file.run.take() else {
            return;
        };
        let Some(source) = self.sources.get_mut(&file.source_id) else {
            return;
        };
        let Some(run) = &mut source.run else {
            return;
        };
        let size = part.target.saturating_sub(part.start);
        run.progress.bytes_done += size.saturating_sub(part.credited);
        run.progress.files_done += 1;
        run.changed = true;
        if run.progress.files_done >= run.progress.files_total {
            let ended = *run;
            source.run = None;
            if ended.shown {
                log::info!(
                    "{}: backfill done, {} files, {} hands in {} ms",
                    source.path.display(),
                    ended.progress.files_total,
                    ended.progress.hands,
                    time::now_ms() - ended.progress.started_at
                );
                // Reported by `publish`, at the end of this turn, once the
                // status no longer shows the run: reporting it here left a
                // moment where the event was out and `status` still showed
                // the run (seen on Linux CI).
                self.ended.push(source.id);
                self.publish_now = true;
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
            self.set_recheck(path, None);
            if let Some(source) = self.sources.get_mut(&source_id) {
                source.next_scan = time::now_ms();
            }
            return;
        }
        self.set_recheck(path, None);
        if let Some(mut file) = self.files.remove(path) {
            self.queued.remove(path);
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

    /// Copy what `status` reads into the shared state, then report the runs
    /// that ended and those that moved on - at most every [`PUBLISH_MS`],
    /// or at once after a command or an end.
    fn publish(&mut self) {
        let now = time::now_ms();
        if !self.publish_now && now - self.last_publish < PUBLISH_MS {
            return;
        }
        self.publish_now = false;
        self.last_publish = now;
        let mut counts: HashMap<i64, (u32, u32)> = HashMap::new();
        for file in self.files.values() {
            let entry = counts.entry(file.source_id).or_default();
            entry.0 += u32::from(file.error);
            entry.1 += u32::from(file.pending);
        }
        let mut progress = Vec::new();
        for source in self.sources.values_mut() {
            if let Some(run) = &mut source.run
                && run.shown
                && run.changed
            {
                run.changed = false;
                progress.push((source.id, run.progress));
            }
        }
        {
            let mut shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
            shared.queued = self.queued.len();
            shared.reading = self.in_flight.len();
            shared.sources = self
                .sources
                .values()
                .map(|source| {
                    let (file_errors, pending) =
                        counts.get(&source.id).copied().unwrap_or_default();
                    (
                        source.id,
                        SourceShared {
                            state: source.state,
                            error: source.error.clone(),
                            file_errors,
                            pending,
                            poll_only: source.poll_only,
                            backfill: source.run.filter(|run| run.shown).map(|run| run.progress),
                        },
                    )
                })
                .collect();
        }
        // Only now, with the status written: whoever reads `status` on a
        // progress event sees what it says (or later). Ends first: a folder
        // may have ended a backfill and started another since the last turn.
        for source_id in std::mem::take(&mut self.ended) {
            self.emit(WatchEvent::Progress {
                source_id,
                backfill: None,
            });
        }
        for (source_id, backfill) in progress {
            self.emit(WatchEvent::Progress {
                source_id,
                backfill: Some(backfill),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    //! The coordinator's run accounting driven by hand: no threads, no file
    //! system events, no sleeping - each step is a call.

    use super::*;

    /// (R3.7 / R3.8) A commit takes the first change noticed since the last
    /// one; a commit that leaves a hand behind (the file was not quiet)
    /// leaves it the latest change noticed, so its own commit - by a
    /// recheck, with no notification of its own - still has a stamp; a
    /// commit of everything leaves none, and the next change starts afresh.
    #[test]
    fn a_commit_that_leaves_bytes_behind_leaves_them_a_stamp() {
        let mut file = FileRt::new(SOURCE);
        file.noticed(100);
        file.noticed(250);
        assert_eq!(file.committed(true), Some(100));
        assert_eq!(file.committed(false), Some(250));
        assert_eq!(file.committed(false), None);
        file.noticed(900);
        assert_eq!(file.committed(false), Some(900));
        // A later change while the rest waits keeps the rest's (earlier) stamp.
        file.noticed(1000);
        assert_eq!(file.committed(true), Some(1000));
        file.noticed(1300);
        assert_eq!(file.committed(false), Some(1000));
    }

    /// Each event the coordinator reported, with the folder's backfill as
    /// `Watcher::status` showed it at that moment.
    type Seen = Arc<Mutex<Vec<(WatchEvent, Option<Backfill>)>>>;

    const SOURCE: i64 = 1;
    const MB: u64 = 1024 * 1024;

    /// A coordinator with no import threads (nothing is dispatched) on
    /// `store`, and what it reports.
    fn coordinator(store: &rail_store::Store) -> (Coordinator, Seen) {
        let writer = store.writer().expect("writer");
        let reader = Arc::new(
            FileReader::new(store.path(), writer.clone(), ReadConfig::default()).expect("reader"),
        );
        let (inbox, messages) = mpsc::channel();
        let shared = Arc::new(Mutex::new(Shared {
            running: true,
            ..Shared::default()
        }));
        let seen: Seen = Arc::default();
        let on_event: OnEvent = {
            let (seen, shared) = (Arc::clone(&seen), Arc::clone(&shared));
            Arc::new(move |event: WatchEvent| {
                let status = shared
                    .lock()
                    .expect("shared")
                    .sources
                    .get(&SOURCE)
                    .and_then(|source| source.backfill);
                seen.lock().expect("seen").push((event, status));
            })
        };
        let coordinator = Coordinator {
            config: WatchConfig::default(),
            reader,
            writer,
            notifier: notify::recommended_watcher(|_: notify::Result<notify::Event>| {})
                .expect("notifier"),
            messages,
            inbox,
            pool: None,
            commits: None,
            committer: None,
            threads: 1,
            limits: Arc::default(),
            shared,
            paused: Arc::default(),
            on_event,
            sources: HashMap::new(),
            files: HashMap::new(),
            in_flight: HashMap::new(),
            committing: HashSet::new(),
            queue: VecDeque::new(),
            queued: HashSet::new(),
            again: HashMap::new(),
            rechecks: BTreeSet::new(),
            fenced: HashMap::new(),
            fence_waiters: Vec::new(),
            holding_new: 0,
            held_new: Vec::new(),
            ended: Vec::new(),
            last_publish: 0,
            publish_now: true,
        };
        (coordinator, seen)
    }

    fn source() -> SourceRt {
        SourceRt {
            id: SOURCE,
            path: PathBuf::from("hh"),
            real_path: PathBuf::from("hh"),
            recursive: true,
            enabled: true,
            poll_only: false,
            site_override: None,
            glob: None,
            state: Some(SourceState::Watching),
            error: None,
            watched: true,
            next_scan: i64::MAX,
            run: None,
        }
    }

    impl Coordinator {
        /// `path` was queued with `size` bytes at `now`.
        fn join(&mut self, path: &str, size: u64, now: i64) {
            let file = self
                .files
                .entry(PathBuf::from(path))
                .or_insert_with(|| FileRt::new(SOURCE));
            file.offset.get_or_insert(0);
            let source = self.sources.get_mut(&SOURCE).expect("source");
            Self::join_run(source, file, size, now);
        }

        /// A read of `path` committed up to `to` and has nothing more.
        fn read(&mut self, path: &str, to: u64) {
            self.credit(Path::new(path), to, 1);
            self.finish_part(Path::new(path));
        }

        /// The end of a loop turn, without the 200 ms throttle.
        fn turn(&mut self) {
            self.publish_now = true;
            self.publish();
        }
    }

    /// The folder's progress events in order (`None`: an end), each with
    /// the status at that moment.
    fn progress(seen: &Seen) -> Vec<(Option<Backfill>, Option<Backfill>)> {
        seen.lock()
            .expect("seen")
            .iter()
            .filter_map(|(event, status)| match event {
                WatchEvent::Progress {
                    source_id: SOURCE,
                    backfill,
                } => Some((*backfill, *status)),
                _ => None,
            })
            .collect()
    }

    /// A fresh store in the temp directory (removed by the caller).
    fn store(name: &str) -> (rail_store::Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "rail-watch-unit-{name}-{}-{}",
            std::process::id(),
            time::now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        (
            rail_store::Store::open(dir.join("rail.db")).expect("store"),
            dir,
        )
    }

    /// The end of a backfill is on the status before it is reported, so an
    /// app that reads `status` on the event (the tray does) sees it over.
    /// It used to be reported at once and published at the end of the loop
    /// turn: a status read in between still showed the run (Linux CI:
    /// "ended", then `Some(309 of 312 files)` on the status).
    #[test]
    fn a_backfill_ends_once_and_the_status_shows_it_first() {
        let (store, dir) = store("ends");
        let (mut c, seen) = coordinator(&store);
        c.sources.insert(SOURCE, source());

        // A walk queues three files: 3 MiB, a backfill.
        for path in ["a", "b", "c"] {
            c.join(path, MB, 1_000);
        }
        c.turn();
        c.read("a", MB);
        c.read("b", MB / 2); // half committed, then nothing more to read
        c.turn();
        // The last file: the backfill ends, once.
        c.read("c", MB);
        c.turn();
        // A file read again with no part in any run: nothing.
        c.read("a", MB);
        c.turn();
        let events = progress(&seen);
        let ends: Vec<_> = events.iter().filter(|(b, _)| b.is_none()).collect();
        assert_eq!(ends.len(), 1, "{events:?}");
        assert_eq!(*ends[0], (None, None), "the status still showed the run");
        let last = events.iter().rev().find_map(|(b, _)| *b).expect("progress");
        assert_eq!((last.files_done, last.files_total), (2, 3), "{last:?}");
        assert_eq!(last.started_at, 1_000);
        assert_eq!(last.bytes_done, 2 * MB, "a finished part counts whole");

        // New bytes later are a new backfill: its own start, totals and end.
        c.join("a", 3 * MB, 9_000);
        c.turn();
        c.read("a", 3 * MB);
        c.turn();
        let events = progress(&seen);
        let first_end = events.iter().position(|(b, _)| b.is_none()).expect("end");
        assert!(
            events[first_end + 1..]
                .iter()
                .filter_map(|(b, _)| *b)
                .all(|b| b.started_at == 9_000 && b.files_total == 1 && b.bytes_total == 2 * MB),
            "progress of the ended backfill after its end: {events:?}"
        );
        assert_eq!(events.last(), Some(&(None, None)), "{events:?}");
        assert_eq!(events.iter().filter(|(b, _)| b.is_none()).count(), 2);

        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A backfill that ends and a new one that starts before the status is
    /// published again: the end is reported first, then the new one, and
    /// the status never shows the ended one once its end is out.
    #[test]
    fn an_end_and_a_new_backfill_in_one_turn_are_reported_in_order() {
        let (store, dir) = store("order");
        let (mut c, seen) = coordinator(&store);
        c.sources.insert(SOURCE, source());
        c.join("a", 2 * MB, 1_000);
        c.turn();
        c.read("a", 2 * MB);
        c.join("b", 2 * MB, 2_000);
        c.turn();
        let events = progress(&seen);
        let tail = &events[events.len() - 2..];
        assert_eq!(tail[0].0, None, "{events:?}");
        assert!(
            tail[0].1.is_some_and(|b| b.started_at == 2_000),
            "the status at the end: {events:?}"
        );
        assert_eq!(tail[1].0.map(|b| b.started_at), Some(2_000), "{events:?}");
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A backfill whose last file is read just before the watcher stops
    /// still reports its end.
    #[test]
    fn an_end_just_before_stopping_is_reported() {
        let (store, dir) = store("stop");
        let (mut c, seen) = coordinator(&store);
        c.sources.insert(SOURCE, source());
        c.join("a", 2 * MB, 1_000);
        c.turn();
        c.read("a", 2 * MB);
        c.finish();
        assert_eq!(progress(&seen).last(), Some(&(None, None)));
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A path change or a room override fences its folder (see "Changing a
    /// folder under its reads"): no file of the folder is dispatched, and
    /// the fence is answered only once the folder's read in flight has
    /// answered - the move then cannot land under it. Before, a read of the
    /// old path that looked at the store after the move read the file again
    /// from 0 under a new row (macOS CI: the folder had two files, the old
    /// path's among them). The other folders read on; the folder reads
    /// again once every fence on it is undone.
    #[test]
    fn a_fenced_folder_starts_no_read_and_is_answered_after_its_reads() {
        const OTHER: i64 = 2;
        let (store, dir) = store("fence");
        let (mut c, _) = coordinator(&store);
        // Import threads, so that `dispatch` starts reads: these files are
        // not there, and their reads answer `Gone`.
        c.pool = Some(
            rayon::ThreadPoolBuilder::new()
                .num_threads(1)
                .build()
                .expect("pool"),
        );
        let (commits, _commit_queue) = mpsc::channel();
        c.commits = Some(commits);
        c.threads = 4;
        c.sources.insert(SOURCE, source());
        c.sources.insert(
            OTHER,
            SourceRt {
                id: OTHER,
                path: PathBuf::from("other"),
                real_path: PathBuf::from("other"),
                ..source()
            },
        );
        let path = PathBuf::from;
        // A read of the folder's "hh/a" is in flight (its track is with it).
        c.files.insert(
            path("hh/a"),
            FileRt {
                track: None,
                ..FileRt::new(SOURCE)
            },
        );
        c.in_flight.insert(path("hh/a"), SOURCE);

        let (reply, answer) = mpsc::channel();
        c.handle(Msg::Cmd(Command::Fence(SOURCE, reply)));
        let (second, second_answer) = mpsc::channel();
        c.handle(Msg::Cmd(Command::Fence(SOURCE, second)));
        c.answer_fences();
        assert!(answer.try_recv().is_err(), "not while hh/a is read");
        // A large read of the folder stops after its batches committing;
        // the other folder's read on.
        assert!(c.limits.stops(Some(SOURCE)) && !c.limits.stops(Some(OTHER)));

        // A change of the folder's file and of the other folder's.
        for (file, id) in [("hh/b", SOURCE), ("other/c", OTHER)] {
            c.files.insert(path(file), FileRt::new(id));
            c.enqueue(path(file), true);
        }
        c.dispatch();
        assert!(c.in_flight.contains_key(&path("other/c")));
        assert!(!c.in_flight.contains_key(&path("hh/b")), "fenced");
        assert!(c.queued.contains(&path("hh/b")) && c.queue.contains(&path("hh/b")));

        // The read of "hh/a" answers: both fences are answered.
        c.handle(Msg::Done(Box::new(Done {
            path: path("hh/a"),
            track: FileTrack::default(),
            result: Ok(Polled::Unchanged),
        })));
        c.answer_fences();
        assert_eq!(answer.try_recv(), Ok(()));
        assert_eq!(second_answer.try_recv(), Ok(()));

        // Fenced until both fences are undone.
        c.handle(Msg::Cmd(Command::Unfence(SOURCE)));
        c.dispatch();
        assert!(!c.in_flight.contains_key(&path("hh/b")), "one fence left");
        assert!(c.limits.stops(Some(SOURCE)), "one fence left");
        c.handle(Msg::Cmd(Command::Unfence(SOURCE)));
        c.dispatch();
        assert_eq!(c.in_flight.get(&path("hh/b")), Some(&SOURCE));
        assert!(!c.limits.stops(Some(SOURCE)));

        // A folder with nothing in flight is answered at once.
        let (reply, answer) = mpsc::channel();
        c.handle(Msg::Cmd(Command::Fence(OTHER + 1, reply)));
        c.answer_fences();
        assert_eq!(answer.try_recv(), Ok(()));
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Import threads for `c`, so that `dispatch` starts reads (of files
    /// that are not there: they answer `Gone`, unread by the tests). Keep
    /// the returned committer queue while `c` runs.
    fn with_threads(c: &mut Coordinator) -> Receiver<Commit> {
        c.pool = Some(
            rayon::ThreadPoolBuilder::new()
                .num_threads(1)
                .build()
                .expect("pool"),
        );
        let (commits, commit_queue) = mpsc::channel();
        c.commits = Some(commits);
        c.threads = 4;
        commit_queue
    }

    /// A folder `name` under `dir`, stored and loaded by `c`.
    fn stored_folder(c: &mut Coordinator, dir: &Path, name: &str) -> (i64, PathBuf) {
        let folder = dir.join(name);
        let id = c
            .writer
            .add_source(&rail_store::import::path_key(&folder), true, None, false)
            .expect("add");
        c.reload();
        assert!(c.sources.get(&id).is_some_and(|source| source.enabled));
        (id, folder)
    }

    /// What `Watcher::change_fenced` makes the coordinator do, step by step,
    /// with a read of the folder's `reading` in flight and a change of its
    /// `waiting` queued: the fence (the read in flight told to stop early),
    /// answered only once that read has answered - so its commit lands
    /// before the change; `change`, the store write; the reload; the
    /// unfence. No read of the folder starts in between.
    fn fenced_change(
        c: &mut Coordinator,
        id: i64,
        reading: &Path,
        waiting: &Path,
        change: impl FnOnce(&WriterHandle),
    ) {
        c.files.insert(
            reading.to_path_buf(),
            FileRt {
                track: None,
                ..FileRt::new(id)
            },
        );
        c.in_flight.insert(reading.to_path_buf(), id);
        c.files.insert(waiting.to_path_buf(), FileRt::new(id));
        c.enqueue(waiting.to_path_buf(), true);

        let (reply, answer) = mpsc::channel();
        c.handle(Msg::Cmd(Command::Fence(id, reply)));
        c.answer_fences();
        assert!(answer.try_recv().is_err(), "answered with a read in flight");
        assert!(
            c.limits.stops(Some(id)),
            "a large read of the folder goes on"
        );
        c.dispatch();
        assert!(!c.in_flight.contains_key(waiting), "read under the fence");

        // The read in flight commits and answers: the fence is answered.
        c.handle(Msg::Done(Box::new(Done {
            path: reading.to_path_buf(),
            track: FileTrack::default(),
            result: Ok(Polled::Unchanged),
        })));
        c.answer_fences();
        assert_eq!(answer.try_recv(), Ok(()));

        // The store changes; nothing of the folder starts until the reload.
        change(&c.writer);
        c.dispatch();
        assert!(!c.in_flight.contains_key(waiting), "read before the reload");
        c.handle(Msg::Cmd(Command::Reload));
        c.handle(Msg::Cmd(Command::Unfence(id)));
        assert!(!c.fenced.contains_key(&id) && !c.limits.stops(Some(id)));
        c.dispatch();
    }

    /// No file of folder `id` is tracked, queued or being read.
    fn nothing_of(c: &Coordinator, id: i64, waiting: &Path) {
        assert!(c.files.values().all(|file| file.source_id != id));
        assert!(!c.queued.contains(waiting) && !c.in_flight.contains_key(waiting));
    }

    /// `remove_source` is fenced: the folder's read in flight commits
    /// while the folder is there (then its row is detached with it), never
    /// after. A batch after the removal used to name a folder that was
    /// gone (`FOREIGN KEY constraint failed`, the read lost) or - SQLite
    /// gives the next folder the removed one's id when it was the highest,
    /// as here - join the next folder added.
    #[test]
    fn a_removed_folder_is_fenced_until_its_reads_answer() {
        let (store, dir) = store("fence-remove");
        let (mut c, _) = coordinator(&store);
        let _commits = with_threads(&mut c);
        let (id, folder) = stored_folder(&mut c, &dir, "hh");
        let waiting = folder.join("b.txt");
        fenced_change(&mut c, id, &folder.join("a.txt"), &waiting, |writer| {
            assert!(writer.remove_source(id).expect("remove"));
        });
        assert!(!c.sources.contains_key(&id));
        nothing_of(&c, id, &waiting);
        let next = c
            .writer
            .add_source(
                &rail_store::import::path_key(&dir.join("next")),
                true,
                None,
                false,
            )
            .expect("add");
        assert_eq!(next, id, "the removed folder's id, given again");
        c.handle(Msg::Cmd(Command::Reload));
        c.dispatch();
        nothing_of(&c, id, &waiting);
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Disabling is fenced: the folder's read in flight commits before it
    /// shows disabled, and nothing of it is read after (its reads used to
    /// commit after, a large one to the end of its file).
    #[test]
    fn a_disabled_folder_is_fenced_until_its_reads_answer() {
        let (store, dir) = store("fence-disable");
        let (mut c, _) = coordinator(&store);
        let _commits = with_threads(&mut c);
        let (id, folder) = stored_folder(&mut c, &dir, "hh");
        let waiting = folder.join("b.txt");
        fenced_change(&mut c, id, &folder.join("a.txt"), &waiting, |writer| {
            assert!(writer.set_source_enabled(id, false).expect("disable"));
        });
        let source = &c.sources[&id];
        assert!(!source.enabled);
        assert_eq!(source.state, Some(SourceState::Disabled));
        nothing_of(&c, id, &waiting);
        assert!(
            c.source_of(&waiting).is_none(),
            "a notification would read it"
        );
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Switching subfolders off is fenced: a subfolder's read in flight
    /// commits before, and no subfolder file is read after.
    #[test]
    fn subfolders_switched_off_are_fenced_until_their_reads_answer() {
        let (store, dir) = store("fence-recursive");
        let (mut c, _) = coordinator(&store);
        let _commits = with_threads(&mut c);
        let (id, folder) = stored_folder(&mut c, &dir, "hh");
        let waiting = folder.join("sub").join("b.txt");
        assert!(c.source_of(&waiting).is_some());
        let reading = folder.join("sub").join("a.txt");
        fenced_change(&mut c, id, &reading, &waiting, |writer| {
            assert!(writer.set_source_recursive(id, false).expect("recursive"));
        });
        assert!(!c.sources[&id].recursive);
        nothing_of(&c, id, &waiting);
        assert!(
            c.source_of(&waiting).is_none(),
            "a notification would read it"
        );
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A room given to a folder already there (`add_source_with`) is
    /// fenced: its glob may leave files out, and a read of one in flight
    /// commits before; none of them is read after.
    #[test]
    fn a_room_given_to_a_folder_is_fenced_until_its_reads_answer() {
        let (store, dir) = store("fence-room");
        let (mut c, _) = coordinator(&store);
        c.config.file_globs = BTreeMap::from([("pokerstars".to_owned(), "HH*.txt".to_owned())]);
        let _commits = with_threads(&mut c);
        let (id, folder) = stored_folder(&mut c, &dir, "hh");
        let waiting = folder.join("b.txt");
        fenced_change(&mut c, id, &folder.join("a.txt"), &waiting, |writer| {
            assert!(
                writer
                    .set_source_site(id, Some("pokerstars"))
                    .expect("room")
            );
        });
        assert_eq!(c.sources[&id].glob.as_deref(), Some("HH*.txt"));
        assert!(!scan::is_candidate_for(&waiting, Some("HH*.txt")));
        nothing_of(&c, id, &waiting);
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A folder being added with a room or "only new" is held: a reload
    /// that loads it before its room and marks are written (say the one
    /// `start` sends, handled late) fences it, so none of its files is read
    /// until the reload after the setup and the release. A folder loaded
    /// before the hold reads on. Such a reload used to read the new
    /// folder's old hands (`only_new_hands_and_a_rooms_files`, once in 300
    /// stress runs: 9 old hands where none belonged).
    #[test]
    fn a_folder_being_added_is_held_until_it_is_set_up() {
        let (store, dir) = store("hold-new");
        let (mut c, _) = coordinator(&store);
        let _commits = with_threads(&mut c);
        let (known, known_folder) = stored_folder(&mut c, &dir, "known");
        let (reply, answer) = mpsc::channel();
        c.handle(Msg::Cmd(Command::HoldNew(reply)));
        assert_eq!(answer.try_recv(), Ok(()), "answered at once");

        // The new folder's row is in; a reload on its way loads it.
        let added = |c: &Coordinator, name: &str| {
            c.writer
                .add_source(
                    &rail_store::import::path_key(&dir.join(name)),
                    true,
                    None,
                    false,
                )
                .expect("add")
        };
        let id = added(&c, "new");
        c.handle(Msg::Cmd(Command::Reload));
        assert!(c.sources.contains_key(&id) && c.fenced.contains_key(&id));
        assert!(c.limits.stops(Some(id)) && !c.fenced.contains_key(&known));
        let old = dir.join("new").join("old.txt");
        let other = known_folder.join("c.txt");
        for (file, source) in [(&old, id), (&other, known)] {
            c.files.insert(file.clone(), FileRt::new(source));
            c.enqueue(file.clone(), true);
        }
        c.dispatch();
        assert!(!c.in_flight.contains_key(&old), "read before its setup");
        assert!(c.in_flight.contains_key(&other), "a folder known before");

        // Set up and reloaded: still held until the release.
        c.handle(Msg::Cmd(Command::Reload));
        c.dispatch();
        assert!(!c.in_flight.contains_key(&old), "read before the release");
        c.handle(Msg::Cmd(Command::ReleaseNew));
        assert!(c.fenced.is_empty() && c.held_new.is_empty() && !c.limits.stops(Some(id)));
        c.dispatch();
        assert_eq!(c.in_flight.get(&old), Some(&id));

        // Released: a folder loaded now is not held.
        let later = added(&c, "later");
        c.handle(Msg::Cmd(Command::Reload));
        assert!(c.sources.contains_key(&later) && !c.fenced.contains_key(&later));
        drop(c);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
