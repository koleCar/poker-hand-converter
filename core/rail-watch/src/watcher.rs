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
//!   run [`FileReader::poll`] - read the new bytes, convert, commit through
//!   the store's writer. A large read is cut into batches that convert in
//!   parallel on the same threads (work stealing: no more threads than the
//!   pool). At most as many files are in flight as the pool has threads
//!   (or [`Watcher::set_import_threads`] allows); the writer's queue is
//!   bounded, so when it is full the threads block and the coordinator
//!   keeps the files queued (back-pressure without unbounded memory).
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
//! [`SourceStatus::backfill`] and [`WatchEvent::Progress`].
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
use crate::reader::{FileReader, FileRef, FileTrack, ImportLimits, Polled, ReadConfig};
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
    },
    /// A folder changed state.
    Source {
        id: i64,
        state: SourceState,
        error: Option<String>,
    },
    /// A folder's backfill moved on (at most every 200 ms), or ended
    /// (`None`).
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
    Stop,
}

/// Everything the coordinator waits for.
enum Msg {
    Fs(notify::Result<notify::Event>),
    Done(Box<Done>),
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
            threads,
            limits: Arc::clone(&limits),
            shared: Arc::clone(&shared),
            paused: Arc::clone(&paused),
            on_event,
            sources: HashMap::new(),
            files: HashMap::new(),
            in_flight: HashSet::new(),
            queue: VecDeque::new(),
            queued: HashSet::new(),
            again: HashMap::new(),
            rechecks: BTreeSet::new(),
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
        let marked = if options.only_new {
            self.mark_existing(id, path, options.recursive, options.site.as_deref())
        } else {
            0
        };
        self.send(Command::Reload)?;
        Ok(AddedSource { id, marked })
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

    /// Watch a folder's subfolders too, or only its top level. Files read
    /// from subfolders before keep their hands.
    pub fn set_source_recursive(&self, id: i64, recursive: bool) -> Result<bool> {
        let found = self.writer.set_source_recursive(id, recursive)?;
        self.send(Command::Reload)?;
        Ok(found)
    }

    /// Read every file of a folder with one parser (a `rail_core` parser
    /// id), or `None` to detect the room per file again - the user's choice
    /// when detection fails. The files the new choice reads differently are
    /// read again from their start
    /// ([`WriterHandle::set_source_site_override`]); hands stay and dedupe.
    ///
    /// A file a worker is reading at that very moment may be committed with
    /// the old choice; it is read with the new one when it next changes.
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
        let change = self.writer.set_source_site_override(id, parser)?;
        if change.found {
            log::info!(
                "folder {id}: room {}, {} files to read again",
                parser.unwrap_or("detected per file"),
                change.reset
            );
        }
        self.send(Command::Reload)?;
        Ok(change)
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
    pub fn set_source_path(&self, id: i64, path: &Path, only_new: bool) -> Result<SourceMoved> {
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

/// One read, on an import thread.
fn run_job(mut job: Job, reader: &FileReader, inbox: &Sender<Msg>) {
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
    let _ = inbox.send(Msg::Done(Box::new(done)));
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
        }
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
    threads: usize,
    limits: Arc<ImportLimits>,
    shared: Arc<Mutex<Shared>>,
    paused: Arc<AtomicBool>,
    on_event: OnEvent,
    sources: HashMap<i64, SourceRt>,
    files: HashMap<PathBuf, FileRt>,
    in_flight: HashSet<PathBuf>,
    /// Files to read, in order (see "Which file goes first"), and the same
    /// set for lookups.
    queue: VecDeque<PathBuf>,
    queued: HashSet<PathBuf>,
    /// Files that changed while a read had them: queued again when it
    /// answers (`true`: at the front).
    again: HashMap<PathBuf, bool>,
    /// Recheck times, earliest first.
    rechecks: BTreeSet<(i64, PathBuf)>,
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
        while !self.in_flight.is_empty() {
            match self.messages.recv_timeout(Duration::from_millis(50)) {
                Ok(Msg::Done(done)) => {
                    self.in_flight.remove(&done.path);
                }
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        // Dropping the pool ends its threads (nothing is queued in it).
        self.pool = None;
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
                    Command::Stop => {}
                }
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
        if self.in_flight.contains(&path) {
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
        let Some(pool) = &self.pool else {
            return;
        };
        let cap = self.limits.cap(self.threads);
        while self.in_flight.len() < cap {
            let Some(path) = self.queue.pop_front() else {
                break;
            };
            if !self.queued.remove(&path) {
                continue; // a stale entry: moved up, or its folder dropped
            }
            let Some(file) = self.files.get_mut(&path) else {
                continue;
            };
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
            };
            self.in_flight.insert(path);
            let (reader, inbox) = (Arc::clone(&self.reader), self.inbox.clone());
            pool.spawn(move || run_job(job, &reader, &inbox));
        }
    }

    fn on_done(&mut self, done: Done) {
        let Done {
            path,
            track,
            result,
        } = done;
        self.in_flight.remove(&path);
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
        let mut more = false;
        match result {
            Ok(Polled::Gone) => {}
            Ok(polled) => {
                recheck = polled.recheck_at();
                if let Some(file) = self.files.get_mut(&path) {
                    file.error = false;
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
                let id = source.id;
                self.emit(WatchEvent::Progress {
                    source_id: id,
                    backfill: None,
                });
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

    /// Copy what `status` reads into the shared state, and report the runs
    /// that moved on - at most every [`PUBLISH_MS`], or at once after a
    /// command.
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
        for (source_id, backfill) in progress {
            self.emit(WatchEvent::Progress {
                source_id,
                backfill: Some(backfill),
            });
        }
    }
}
