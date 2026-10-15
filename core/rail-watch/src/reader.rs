//! The incremental reader: one file, from its stored offset to the last
//! complete hand, committed as one [`ImportBatch`].
//!
//! # When a hand is complete
//!
//! A read takes the file's new bytes (from the stored `read_offset`),
//! decodes them ([`crate::codec`]) and asks the core how they split: the
//! best parser for the text (`detect_site`, or the folder's forced parser)
//! and its `split_hands`. Every chunk is then located in the text, in order.
//!
//! - **The next hand has started.** Every chunk but the last is complete:
//!   it converts (`convert_any` on the text up to the last chunk's start)
//!   and the stored offset moves to the **byte where the last chunk
//!   starts**. The next read starts exactly at a hand header, which is how
//!   the whole-file conversion splits the same text (checked on every corpus
//!   file, below).
//! - **The file is quiet.** The last chunk has nothing after it. It is
//!   complete when the file has not changed for [`ReadConfig::quiet_ms`]
//!   **and** it converts into a hand (it validates) **and** the file does
//!   not end inside a code unit or UTF-8 sequence **and** the text ends
//!   with a line end - or, without the line end, after
//!   [`ReadConfig::settle_ms`]. Then everything read is committed and the
//!   offset moves to the end of what was decoded.
//! - **It never becomes a hand.** A last chunk that is refused (an
//!   unsupported game, a broken hand) is committed with its refusal after
//!   [`ReadConfig::give_up_ms`] of quiet; a writer is never that slow in the
//!   middle of a hand. Then the file is also taken as finished: a half code
//!   unit at its end is the core's replacement character, as in a
//!   whole-file read.
//!
//! The assumption behind the quiet rule: a room writes a hand within the
//! quiet period (they write it whole when it ends). A writer that stops in
//! the middle of a hand for longer, at a line end, with what it wrote so far
//! valid as a hand, would have the start of that hand stored without its
//! end; nothing in the corpus or in a room's behaviour suggests one.
//!
//! "Quiet" is measured from the file's mtime when it has milliseconds; a
//! coarse one (whole seconds: FAT, HFS+, some shares) may be up to two
//! seconds early, so then from the moment this reader saw the size or mtime
//! change.
//!
//! # When a piece cannot be read on its own
//!
//! A chunk that is not found verbatim in the text (iPoker assembles each
//! hand from the session header and one `<game>`), or a piece from a
//! non-zero offset that no parser claims or that splits into nothing,
//! cannot be continued from an offset. Such a file is read **whole** every
//! time it changes and has been quiet ([`FileTrack::whole_file`]): from
//! offset 0 (always accepted by the store; dedupe keeps the hands once).
//! A file nothing claims at all is committed from offset 0 as the core's
//! file-level refusal (with its registry record) after the give-up time.
//!
//! # Encodings
//!
//! Decided by the core from offset 0 and remembered once something is
//! stored ([`crate::codec`]). A file read as strict UTF-8 that meets an
//! invalid byte is decided again from the whole file: Windows-1252 after an
//! all-ASCII start, or lossy UTF-8, continue from the stored offset (the
//! text before it is the same in either reading); anything else is re-read
//! from 0.
//!
//! # A large read
//!
//! A read with many complete hands (the backfill of a big file, or a file
//! that grew a lot while import was paused) is not one batch: the hands
//! the next hand's start proves complete are cut at hand starts into
//! batches of at most [`ReadConfig::batch_hands`] hands, converted in
//! parallel on the import threads (rayon; as many at a time as
//! [`ImportLimits::threads`] allows) and committed **in order**, each with
//! its own offsets - batch *k* starts where batch *k - 1* ended, so the
//! store's offset rule holds for each, and a crash keeps a prefix of them.
//! The last hand is read by the next look, at once. Between groups of
//! batches the reader stops early when [`ImportLimits::interrupt`] is set
//! (pause, stop) or its folder is stopped ([`ImportLimits::stop_folder`]:
//! the watcher changes it), with what it committed so far.
//!
//! # Truncation, rotation, deletion
//!
//! A file smaller than its stored offset was truncated or replaced: it is
//! read again from 0. A file whose first bytes changed (compared with what
//! this reader saw at its last commit) was replaced by another of at least
//! the same size: also read from 0. A deleted file's row is reset to offset
//! 0 ([`FileReader::forget`]) so a new file at the same path starts from
//! its beginning; its hands stay.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use rail_core::convert::{
    Candidate, ConversionResult, FileConversion, convert_any, convert_any_detected,
};
use rail_core::decode::Encoding;
use rail_core::detect::{ConvertOptions, DetectionCandidate, FORCED_PERMILLE};
use rail_core::js::JsError;
use rail_store::import::path_key;
use rail_store::read::StoredFile;
use rail_store::{
    FileState, ImportBatch, ImportOutcome, PendingImport, Reader, WriterHandle, time,
};
use rayon::prelude::*;

use crate::codec::{self, Codec, Decision};
use crate::error::{Error, Result};

/// How many leading bytes of a file are compared to notice that it was
/// replaced by another one.
const HEAD_LEN: usize = 256;

/// The reader's timing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadConfig {
    /// A trailing hand counts as complete after this long without a change
    /// (and only if it validates and ends with a line end). Rooms write a
    /// hand in one go at its end; this covers a write split in a few
    /// flushes. It is most of the latency from "the hand ended" to "the HUD
    /// has it" (docs/RAIL-PLAN.md §3.3).
    pub quiet_ms: i64,
    /// A trailing hand that validates but has no line end after it waits
    /// this long.
    pub settle_ms: i64,
    /// A trailing chunk that does not validate, or a file nothing claims, is
    /// committed as refused after this long without a change.
    pub give_up_ms: i64,
    /// `meta.parsedAt` for every hand; `None` stamps the current time.
    /// Tests pin it.
    pub parsed_at: Option<String>,
    /// A read with more complete hands than this is committed as several
    /// batches of at most this many, converted in parallel (see "A large
    /// read" in the module docs).
    pub batch_hands: usize,
}

/// [`ReadConfig::batch_hands`]' default: a few hundred hands convert in
/// ~0.2 s on one thread, so a group of batches on every thread commits a
/// few times a second, and a pause takes effect as quickly.
pub const BATCH_HANDS: usize = 500;

impl Default for ReadConfig {
    fn default() -> Self {
        Self {
            quiet_ms: 500,
            settle_ms: 5_000,
            give_up_ms: 30_000,
            parsed_at: None,
            batch_hands: BATCH_HANDS,
        }
    }
}

/// What the watcher can change while a read runs: how many import threads
/// a large read may use at once, and a request to stop early - every read,
/// or the reads of some folders.
#[derive(Debug, Default)]
pub struct ImportLimits {
    /// 0: every thread of the pool the read runs on.
    threads: AtomicUsize,
    interrupt: AtomicBool,
    /// Folders whose reads stop early (the watcher's fenced folders).
    stopped: Mutex<HashSet<i64>>,
}

impl ImportLimits {
    /// Use at most `threads` threads at once (0: all of them).
    pub fn set_threads(&self, threads: usize) {
        self.threads.store(threads, Ordering::Relaxed);
    }

    /// The threads a large read uses at once: the limit, within the pool
    /// it runs on (rayon's current pool, or the global one).
    pub fn threads(&self) -> usize {
        self.cap(rayon::current_num_threads())
    }

    /// The limit within a pool of `pool` threads (at least 1).
    pub fn cap(&self, pool: usize) -> usize {
        let pool = pool.max(1);
        match self.threads.load(Ordering::Relaxed) {
            0 => pool,
            limit => limit.min(pool),
        }
    }

    /// Ask reads in progress to stop after the batches they are committing
    /// (`true`: pause or stop), or let them run.
    pub fn interrupt(&self, stop: bool) {
        self.interrupt.store(stop, Ordering::SeqCst);
    }

    pub fn interrupted(&self) -> bool {
        self.interrupt.load(Ordering::SeqCst)
    }

    /// Ask the reads of folder `source_id` in progress to stop after the
    /// batches they are committing (`true`), or let them run - the
    /// interrupt for one folder, while the watcher changes it.
    pub fn stop_folder(&self, source_id: i64, stop: bool) {
        let mut stopped = self.stopped.lock().unwrap_or_else(PoisonError::into_inner);
        if stop {
            stopped.insert(source_id);
        } else {
            stopped.remove(&source_id);
        }
    }

    /// Whether a read of folder `source_id` (none: a file of no folder) is
    /// to stop early.
    pub fn stops(&self, source_id: Option<i64>) -> bool {
        self.interrupted()
            || source_id.is_some_and(|id| {
                self.stopped
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .contains(&id)
            })
    }
}

/// What the reader remembers about a file between reads (in memory; the
/// store holds the offset).
#[derive(Debug, Clone, Default)]
pub struct FileTrack {
    /// The codec once something of the file is stored.
    codec: Option<Codec>,
    /// The file's chunks cannot be read from an offset: read it whole.
    whole_file: bool,
    /// Size and mtime when last looked at.
    seen: Option<(u64, Option<i64>)>,
    /// When the reader saw them change.
    changed_at: i64,
    /// The file's first bytes at the last commit.
    head: Option<Vec<u8>>,
    /// Counters, for tests and the log.
    pub stats: TrackStats,
}

impl FileTrack {
    /// Whether the file is read whole every time (see the module docs).
    pub const fn whole_file(&self) -> bool {
        self.whole_file
    }

    /// The codec the file is read with, once known.
    pub const fn codec(&self) -> Option<Codec> {
        self.codec
    }

    fn reset(&mut self) {
        self.codec = None;
        self.whole_file = false;
        self.head = None;
    }
}

/// How often each path was taken for one file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrackStats {
    /// Reads that looked at new bytes.
    pub reads: u32,
    /// Batches committed.
    pub commits: u32,
    /// Re-reads from 0 for a truncated or replaced file.
    pub restarts: u32,
    /// Re-reads from 0 because a piece could not be read on its own, or the
    /// encoding had to be decided again.
    pub from_zero: u32,
    /// Encoding switches that kept the offset (UTF-8 to Windows-1252 or to
    /// lossy UTF-8).
    pub recoded: u32,
    /// Large reads committed as several batches.
    pub splits: u32,
}

/// The result of one look at a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Polled {
    /// The file is gone (deleted, renamed away, or not a file).
    Gone,
    /// Nothing new since the stored offset.
    Unchanged,
    /// New bytes, but no complete hand yet. Look again at `recheck_at`
    /// (ms) even without a change; `None`: only on a change.
    Waiting { recheck_at: Option<i64> },
    /// A batch was committed (or several in a row: a large read, R1.6;
    /// `outcome` is their sum, `from` the first one's start, `to` the last
    /// one's end).
    Committed {
        outcome: ImportOutcome,
        from: u64,
        to: u64,
        recheck_at: Option<i64>,
    },
}

impl Polled {
    /// When to look again without a change.
    pub const fn recheck_at(&self) -> Option<i64> {
        match self {
            Self::Waiting { recheck_at } | Self::Committed { recheck_at, .. } => *recheck_at,
            Self::Gone | Self::Unchanged => None,
        }
    }
}

/// What a look at a file has been through so far: [`FileReader::poll`]
/// re-reads a truncated file once, and once more when the stored offset
/// moved under its batch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Attempt {
    restarted: bool,
    retried: bool,
}

/// What [`FileReader::start`] got to.
#[derive(Debug)]
pub enum Started {
    /// The look is over (nothing to commit, or a large read committed).
    Done(Polled),
    /// A one-batch read is with the writer.
    Committing(Committing),
}

/// A one-batch read queued with the writer, not yet waited for. Batches are
/// committed in the order they were queued, whoever waits for them.
#[derive(Debug)]
pub struct Committing {
    pending: PendingImport,
    from: u64,
    to: u64,
    codec: Option<Codec>,
    head: Option<Vec<u8>>,
    recheck_at: Option<i64>,
    attempt: Attempt,
}

/// What [`Committing::wait`] concluded.
#[derive(Debug)]
pub enum Finished {
    /// Committed: the look is over.
    Done(Polled),
    /// The stored offset moved under the batch (nothing of it stored):
    /// look again, [`FileReader::start`] with this attempt.
    Again(Attempt),
}

impl Committing {
    /// Wait for the commit and update `track` (the file's, as
    /// [`FileReader::start`] left it).
    pub fn wait(self, track: &mut FileTrack) -> Result<Finished> {
        let Self {
            pending,
            from,
            to,
            codec,
            head,
            recheck_at,
            attempt,
        } = self;
        match pending.wait() {
            Ok(outcome) => {
                track.stats.commits += 1;
                if codec.is_some() {
                    track.codec = codec;
                }
                if head.is_some() {
                    track.head = head;
                }
                Ok(Finished::Done(Polled::Committed {
                    outcome,
                    from,
                    to,
                    recheck_at,
                }))
            }
            // The stored offset moved under us: read again.
            Err(rail_store::Error::OffsetMismatch { .. }) if !attempt.retried => {
                Ok(Finished::Again(Attempt {
                    retried: true,
                    ..attempt
                }))
            }
            Err(error) => Err(error.into()),
        }
    }
}

/// The batch a read makes, before it is committed.
#[derive(Debug)]
enum Step {
    Gone,
    Unchanged,
    /// Truncated or replaced: reset the row, read again.
    Restart,
    Waiting(Option<i64>),
    Commit {
        batch: Box<ImportBatch>,
        codec: Option<Codec>,
        head: Option<Vec<u8>>,
        recheck_at: Option<i64>,
    },
    /// A large read: several batches, converted in parallel.
    Split(Box<Split>),
}

/// A large read cut into batches at hand starts ("A large read").
#[derive(Debug)]
struct Split {
    /// The decoded text of the read.
    text: String,
    options: ConvertOptions,
    encoding: Encoding,
    detected: Vec<Candidate>,
    codec: Codec,
    head: Option<Vec<u8>>,
    /// The file's state for every batch (offsets set per piece).
    file: FileState,
    /// The folder's forced parser, recorded as the file's site.
    forced: Option<String>,
    pieces: Vec<SplitPiece>,
}

/// One batch of a [`Split`].
#[derive(Debug, Clone)]
struct SplitPiece {
    /// Its text within [`Split::text`].
    text: Range<usize>,
    /// Its bytes in the file.
    from: u64,
    to: u64,
    /// The chunks (hands) it holds.
    chunks: usize,
}

/// What [`FileReader::interpret`] concluded.
enum Interpreted {
    Step(Step),
    /// Read the file again from offset 0.
    FromZero,
    /// Strict UTF-8 met an invalid byte: decide the encoding again.
    Recode,
}

/// Which file, for a read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef<'a> {
    pub path: &'a Path,
    /// The watched folder it belongs to.
    pub source_id: Option<i64>,
    /// The folder's forced parser, if any (`sources.site_override`).
    pub site_override: Option<&'a str>,
}

impl<'a> FileRef<'a> {
    /// A file with no folder and no forced parser.
    pub const fn new(path: &'a Path) -> Self {
        Self {
            path,
            source_id: None,
            site_override: None,
        }
    }
}

/// Reads files incrementally into the store. Cheap to share between
/// threads by reference; per-file state is the caller's [`FileTrack`].
#[derive(Debug)]
pub struct FileReader {
    config: ReadConfig,
    reader: Reader,
    writer: WriterHandle,
    limits: Arc<ImportLimits>,
}

/// One read's facts, passed around while it is interpreted.
struct ReadCtx<'a> {
    file: &'a FileRef<'a>,
    start: u64,
    size: u64,
    mtime: Option<i64>,
    /// The store has nothing of this file yet (or it was truncated): the
    /// registry record of a file nothing claims may be sent.
    fresh: bool,
    quiet: i64,
    last_change: i64,
}

impl FileReader {
    /// A reader on the store at `store_path` (its own read connections) that
    /// commits through `writer`.
    pub fn new(store_path: &Path, writer: WriterHandle, config: ReadConfig) -> Result<Self> {
        Ok(Self {
            config,
            reader: Reader::open(store_path, 2)?,
            writer,
            limits: Arc::default(),
        })
    }

    /// Share `limits` (the watcher's) instead of this reader's own.
    #[must_use]
    pub fn with_limits(mut self, limits: Arc<ImportLimits>) -> Self {
        self.limits = limits;
        self
    }

    /// The limits large reads follow.
    pub fn limits(&self) -> &Arc<ImportLimits> {
        &self.limits
    }

    pub const fn config(&self) -> &ReadConfig {
        &self.config
    }

    /// The store's read pool this reader uses.
    pub const fn store_reader(&self) -> &Reader {
        &self.reader
    }

    /// Look at a file at time `now` (ms since the epoch) and commit what is
    /// complete: [`FileReader::start`], then [`Committing::wait`] on this
    /// thread.
    pub fn poll(&self, file: &FileRef<'_>, track: &mut FileTrack, now: i64) -> Result<Polled> {
        let mut attempt = Attempt::default();
        loop {
            match self.start(file, track, now, attempt)? {
                Started::Done(polled) => return Ok(polled),
                Started::Committing(committing) => match committing.wait(track)? {
                    Finished::Done(polled) => return Ok(polled),
                    Finished::Again(next) => attempt = next,
                },
            }
        }
    }

    /// [`FileReader::poll`] up to the commit of a one-batch read: the batch
    /// is queued with the writer and the caller waits for its commit when
    /// it likes ([`Committing::wait`]) - the watcher's import threads go on
    /// to the next file meanwhile (a commit's wait was ~15 % of their time,
    /// measured). Everything else (nothing to commit, a large read, whose
    /// batches are committed in order before it returns) is answered here.
    /// `attempt` is [`Attempt::default`] for a new look, or what
    /// [`Finished::Again`] gave.
    pub fn start(
        &self,
        file: &FileRef<'_>,
        track: &mut FileTrack,
        now: i64,
        mut attempt: Attempt,
    ) -> Result<Started> {
        let key = path_key(file.path);
        loop {
            let stored = self.reader.file_state(&key)?;
            let polled = match self.prepare(file, stored.as_ref(), track, now)? {
                Step::Gone => Polled::Gone,
                // Truncated or replaced: the row goes back to 0 first (so the
                // next look reads from the start even if this one stores
                // nothing), then the file is read from its start.
                Step::Restart if !attempt.restarted => {
                    attempt.restarted = true;
                    self.reset_row(file)?;
                    continue;
                }
                Step::Restart => Polled::Waiting { recheck_at: None },
                Step::Unchanged => Polled::Unchanged,
                Step::Waiting(recheck_at) => Polled::Waiting { recheck_at },
                Step::Split(split) => self.commit_split(*split, track, now)?,
                Step::Commit {
                    batch,
                    codec,
                    head,
                    recheck_at,
                } => {
                    let (from, to) = (batch.file.from_offset, batch.file.to_offset);
                    return Ok(Started::Committing(Committing {
                        pending: self.writer.queue(*batch)?,
                        from,
                        to,
                        codec,
                        head,
                        recheck_at,
                        attempt,
                    }));
                }
            };
            return Ok(Started::Done(polled));
        }
    }

    /// The file is gone: reset its stored offset to 0, so a new file at the
    /// same path is read from its start. Its hands stay.
    pub fn forget(&self, file: &FileRef<'_>, track: &mut FileTrack) -> Result<()> {
        *track = FileTrack {
            stats: track.stats,
            ..FileTrack::default()
        };
        self.reset_row(file)
    }

    /// "Only new hands" (R1.4): store a file as read up to its current end
    /// without importing anything in it, so that only what the room writes
    /// from now on is read. One batch with no hands, `from_offset` 0 and
    /// `to_offset` the end of what is complete (a writer cut inside a UTF-16
    /// code unit or a UTF-8 sequence leaves that tail for the next read),
    /// with the encoding the core decides on the whole file - the next read
    /// continues from there as after any commit.
    ///
    /// A file the store already has a row for is left alone (it is being
    /// read, or was), as is an empty one; returns whether it was marked.
    ///
    /// A hand the room is writing at that moment is cut: the next read
    /// starts inside it, which no parser claims, and the file is then read
    /// whole from 0 (see the module docs) - that one file's old hands come
    /// in after all. Files whose hands cannot be read from an offset
    /// (iPoker) are read whole whenever they change, too.
    pub fn mark_read(&self, file: &FileRef<'_>) -> Result<bool> {
        let key = path_key(file.path);
        if self.reader.file_state(&key)?.is_some() {
            return Ok(false);
        }
        let metadata = match std::fs::metadata(file.path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(Error::io(file.path, error)),
        };
        let mtime = metadata.modified().ok().and_then(time::system_time_ms);
        let bytes = std::fs::read(file.path).map_err(|error| Error::io(file.path, error))?;
        if bytes.is_empty() {
            return Ok(false);
        }
        let (encoding, complete) = match codec::decide(&bytes) {
            Decision::Text(codec) => (
                Some(codec.encoding().label().to_owned()),
                codec::complete_len(codec, &bytes),
            ),
            // Not text (binary, nothing but a BOM): nothing to continue.
            Decision::Problem(_) => (None, bytes.len()),
        };
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        self.writer.import(ImportBatch {
            file: FileState {
                path: key,
                source_id: file.source_id,
                from_offset: 0,
                to_offset: u64::try_from(complete).unwrap_or(size),
                size,
                mtime_ms: mtime,
                encoding,
                site: None,
                last_error: None,
            },
            hands: Vec::new(),
            refusals: Vec::new(),
            unrecognized: None,
        })?;
        Ok(true)
    }

    /// Set the file's row to offset 0, size 0 (if it has one).
    fn reset_row(&self, file: &FileRef<'_>) -> Result<()> {
        let key = path_key(file.path);
        let Some(stored) = self.reader.file_state(&key)? else {
            return Ok(());
        };
        if stored.read_offset == 0 && stored.size == 0 {
            return Ok(());
        }
        self.writer.import(ImportBatch {
            file: FileState {
                path: key,
                source_id: file.source_id,
                from_offset: 0,
                to_offset: 0,
                size: 0,
                mtime_ms: None,
                encoding: None,
                site: None,
                last_error: None,
            },
            hands: Vec::new(),
            refusals: Vec::new(),
            unrecognized: None,
        })?;
        Ok(())
    }

    fn options(&self, file: &FileRef<'_>) -> ConvertOptions {
        ConvertOptions {
            source_filename: file
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            site_id: file.site_override.map(str::to_owned),
            validate: true,
            parsed_at: self.config.parsed_at.clone().unwrap_or_else(time::iso_now),
            ..ConvertOptions::default()
        }
    }

    fn prepare(
        &self,
        file: &FileRef<'_>,
        stored: Option<&StoredFile>,
        track: &mut FileTrack,
        now: i64,
    ) -> Result<Step> {
        let metadata = match std::fs::metadata(file.path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => return Ok(Step::Gone),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Step::Gone),
            Err(error) => return Err(Error::io(file.path, error)),
        };
        let size = metadata.len();
        let mtime = metadata.modified().ok().and_then(time::system_time_ms);
        // A millisecond mtime says when the file was last written; a coarse
        // one (whole seconds: FAT, HFS+, some shares) may be up to two
        // seconds early, so then the moment the change was seen counts.
        let precise = mtime.is_some_and(|mtime| mtime % 1000 != 0);
        match track.seen {
            None => track.changed_at = mtime.map_or(now, |mtime| mtime.min(now)),
            Some(seen) if seen != (size, mtime) => {
                track.changed_at = match mtime {
                    Some(mtime) if precise => mtime.min(now),
                    _ => now,
                };
            }
            Some(_) => {}
        }
        track.seen = Some((size, mtime));
        let last_change = mtime.map_or(track.changed_at, |mtime| {
            mtime.min(now).max(track.changed_at)
        });
        let quiet = now.saturating_sub(last_change).max(0);

        let stored_offset = stored.map_or(0, |s| u64::try_from(s.read_offset).unwrap_or(0));
        if track.codec.is_none() {
            track.codec = stored
                .and_then(|s| s.encoding.as_deref())
                .and_then(Codec::from_label);
        }
        if !track.whole_file && size == stored_offset && stored.is_some_and(|s| s.mtime_ms == mtime)
        {
            return Ok(Step::Unchanged);
        }
        // A file read whole, unchanged since: nothing to do - decided from
        // the metadata alone, without opening it (R1.6: on Linux every open
        // is an inotify event, and a look that opens an unchanged file
        // would wake the watcher for it again, forever).
        if track.whole_file
            && stored.is_some_and(|s| {
                stored_offset == size
                    && u64::try_from(s.size).ok() == Some(size)
                    && s.mtime_ms == mtime
            })
        {
            return Ok(Step::Unchanged);
        }
        let mut start = stored_offset;
        let fresh = stored_offset == 0;
        // Truncated (or replaced by something shorter), or replaced by
        // another file at least as long: from the start.
        if size < stored_offset || (start > 0 && !self.same_head(file.path, start, track)?) {
            track.reset();
            track.stats.restarts += 1;
            return Ok(Step::Restart);
        }
        if track.whole_file {
            if quiet < self.config.quiet_ms {
                return Ok(Step::Waiting(Some(last_change + self.config.quiet_ms)));
            }
            start = 0;
        }
        if start >= size {
            return Ok(Step::Unchanged);
        }

        let mut ctx = ReadCtx {
            file,
            start,
            size,
            mtime,
            fresh,
            quiet,
            last_change,
        };
        let mut recoded = false;
        loop {
            track.stats.reads += 1;
            let bytes = read_range(file.path, ctx.start, size)?;
            match self.interpret(&ctx, &bytes, track)? {
                Interpreted::Step(step) => return Ok(step),
                Interpreted::FromZero if ctx.start > 0 => {
                    track.stats.from_zero += 1;
                    ctx.start = 0;
                }
                Interpreted::Recode if ctx.start > 0 && !recoded => {
                    recoded = true;
                    let whole = read_range(file.path, 0, size)?;
                    let prefix = usize::try_from(ctx.start)
                        .map_or(whole.len(), |start| start.min(whole.len()));
                    match codec::decide(&whole) {
                        // Windows-1252 and UTF-8 agree on ASCII; lossy UTF-8
                        // and strict agree on valid UTF-8: the stored text is
                        // the same in the new reading, keep the offset.
                        Decision::Text(Codec::Windows1252) if whole[..prefix].is_ascii() => {
                            track.codec = Some(Codec::Windows1252);
                            track.stats.recoded += 1;
                        }
                        Decision::Text(codec @ Codec::Utf8 { lossy: true, .. }) => {
                            track.codec = Some(codec);
                            track.stats.recoded += 1;
                        }
                        _ => {
                            track.codec = None;
                            track.stats.from_zero += 1;
                            ctx.start = 0;
                        }
                    }
                }
                // From 0 already: the core's decision is final.
                Interpreted::FromZero | Interpreted::Recode => {
                    return Ok(Step::Waiting(Some(last_change + self.config.give_up_ms)));
                }
            }
        }
    }

    /// Whether the file still starts with the bytes it started with at the
    /// last commit (on the first look after a start, it is taken as it is).
    fn same_head(&self, path: &Path, stored_offset: u64, track: &mut FileTrack) -> Result<bool> {
        let want = track.head.as_ref().map_or_else(
            || usize::try_from(stored_offset).map_or(HEAD_LEN, |offset| offset.min(HEAD_LEN)),
            Vec::len,
        );
        let head = read_range(
            path,
            0,
            u64::try_from(want)
                .map_err(|_| Error::io(path, std::io::ErrorKind::InvalidInput.into()))?,
        )?;
        match &track.head {
            Some(known) => Ok(*known == head),
            None => {
                track.head = Some(head);
                Ok(true)
            }
        }
    }

    fn interpret(
        &self,
        ctx: &ReadCtx<'_>,
        bytes: &[u8],
        track: &mut FileTrack,
    ) -> Result<Interpreted> {
        let config = &self.config;
        let at_start = ctx.start == 0;
        let wait = |ms: i64| Interpreted::Step(Step::Waiting(Some(ctx.last_change + ms)));

        let codec = if at_start {
            match codec::decide(bytes) {
                Decision::Text(codec) => codec,
                Decision::Problem(rail_core::decode::SourceProblem::Binary) => {
                    if ctx.quiet < config.quiet_ms {
                        return Ok(wait(config.quiet_ms));
                    }
                    // Not text: the core's file-level answer, offset at the end.
                    let conversion =
                        rail_core::convert::convert_file(bytes, &self.options(ctx.file));
                    let to = len_u64(bytes.len());
                    return self.commit(ctx, to, &conversion, None, None, None);
                }
                // Empty or blank so far: more may come.
                Decision::Problem(_) => return Ok(Interpreted::Step(Step::Waiting(None))),
            }
        } else {
            track.codec.unwrap_or(Codec::Utf8 {
                bom: false,
                lossy: false,
            })
        };
        // After the give-up time the writer is done: an unfinished unit at
        // the end is decoded as the core decodes it.
        let at_eof = ctx.quiet >= config.give_up_ms;
        let Ok(piece) = codec::decode_piece(codec, bytes, at_start, at_eof) else {
            return Ok(Interpreted::Recode);
        };
        let text = piece.text.as_str();
        let end = ctx.start + len_u64(piece.consumed);
        if rail_core::js::trim(text).is_empty() {
            return Ok(Interpreted::Step(Step::Waiting(None)));
        }
        let head = at_start.then(|| bytes[..bytes.len().min(HEAD_LEN)].to_vec());

        let options = self.options(ctx.file);
        let registry = rail_core::parsers::builtin();
        let forced = ctx.file.site_override.and_then(|id| registry.get(id));
        let candidates: Vec<DetectionCandidate<'_>> = match forced {
            Some(parser) => vec![DetectionCandidate {
                parser,
                permille: FORCED_PERMILLE,
            }],
            None => registry.detect_site(text),
        };
        let chunks = candidates
            .first()
            .and_then(|primary| primary.parser.split_hands(text).ok())
            .filter(|chunks| !chunks.is_empty());
        let Some(chunks) = chunks else {
            // Nothing claims the piece, or it splits into nothing.
            if !at_start {
                return Ok(if ctx.quiet >= config.quiet_ms {
                    Interpreted::FromZero
                } else {
                    wait(config.quiet_ms)
                });
            }
            if ctx.quiet < config.give_up_ms {
                return Ok(wait(config.give_up_ms));
            }
            // The core's file-level refusal (and registry record) for what
            // is there.
            let complete = &bytes[..piece.consumed];
            let conversion = rail_core::convert::convert_file(complete, &options);
            return self.commit(ctx, end, &conversion, Some(codec), head, None);
        };
        let detected: Vec<Candidate> = candidates
            .iter()
            .map(|candidate| Candidate {
                parser: candidate.parser.id().to_owned(),
                permille: candidate.permille,
            })
            .collect();

        let starts = locate(text, &chunks);
        if starts.is_none() {
            if !at_start {
                return Ok(if ctx.quiet >= config.quiet_ms {
                    Interpreted::FromZero
                } else {
                    wait(config.quiet_ms)
                });
            }
            track.whole_file = true;
        } else if at_start {
            track.whole_file = false;
        }
        let n = chunks.len();
        // Many complete hands: several batches ("A large read").
        if let Some(starts) = starts.as_ref()
            && !track.whole_file
            && n > 1
            && n - 1 > config.batch_hands.max(1)
            && let Some(split) = self.plan_split(ctx, bytes, at_start, codec, starts, head.clone())
        {
            let mut split = split;
            split.text = text.to_owned();
            split.options = options;
            split.detected = detected;
            return Ok(Interpreted::Step(Step::Split(Box::new(split))));
        }
        let byte_at = |position: usize| -> u64 {
            codec::byte_offset_of(codec, bytes, at_start, position)
                .map_or(end, |offset| ctx.start + len_u64(offset))
        };
        let conversion = |result: Result<ConversionResult, JsError>| FileConversion {
            encoding: codec.encoding(),
            problem: None,
            detected: detected.clone(),
            result: Some(result),
            unrecognized: None,
        };

        if ctx.quiet < config.quiet_ms {
            // Only what the next hand's start proves complete.
            let Some(starts) = starts.filter(|_| n >= 2) else {
                return Ok(wait(config.quiet_ms));
            };
            let cut = starts[n - 1];
            let result = convert_any(&text[..cut], &options);
            if let Ok(result) = &result
                && usize::try_from(result.chunks).ok() != Some(n - 1)
            {
                // The prefix does not split as the whole did: read whole.
                track.whole_file = true;
                return Ok(wait(config.quiet_ms));
            }
            return self.commit(
                ctx,
                byte_at(cut),
                &conversion(result),
                Some(codec),
                head,
                Some(ctx.last_change + config.quiet_ms),
            );
        }

        // Quiet: everything, if the last chunk is done. Detection ran on
        // this very text above: handed over, not run again.
        let result = match convert_any_detected(text, &options, candidates.clone()) {
            Ok(result) => result,
            Err(error) => {
                return self.commit(ctx, end, &conversion(Err(error)), Some(codec), head, None);
            }
        };
        let total = result.chunks;
        let last = total.saturating_sub(1);
        // A file that ends inside a code unit or sequence is not finished
        // (or is broken there, and the core puts a replacement character
        // into its last hand): its last hand waits for the give-up time.
        let trailing_valid =
            result.hands.iter().any(|hand| hand.index == last) && piece.consumed == bytes.len();
        let trailing_done = ctx.quiet >= config.give_up_ms
            || (trailing_valid && (text.ends_with('\n') || ctx.quiet >= config.settle_ms));
        let recheck_at = ctx.last_change
            + if trailing_valid {
                config.settle_ms
            } else {
                config.give_up_ms
            };
        if trailing_done {
            return self.commit(ctx, end, &conversion(Ok(result)), Some(codec), head, None);
        }
        match starts {
            Some(starts) if n >= 2 && usize::try_from(total).ok() == Some(n) => {
                let to = byte_at(starts[n - 1]);
                let before_last = keep_before(result, last);
                self.commit(
                    ctx,
                    to,
                    &conversion(Ok(before_last)),
                    Some(codec),
                    head,
                    Some(recheck_at),
                )
            }
            _ => Ok(Interpreted::Step(Step::Waiting(Some(recheck_at)))),
        }
    }

    /// Cut the complete hands of a read (every chunk but the last) into
    /// batches of at most [`ReadConfig::batch_hands`] at hand starts, with
    /// each batch's byte offsets. `None` when the offsets cannot be mapped
    /// (then the read goes on as one batch).
    fn plan_split(
        &self,
        ctx: &ReadCtx<'_>,
        bytes: &[u8],
        at_start: bool,
        codec: Codec,
        starts: &[usize],
        head: Option<Vec<u8>>,
    ) -> Option<Split> {
        let size = self.config.batch_hands.max(1);
        let complete = starts.len() - 1;
        // Text positions where batches start (after the first, which starts
        // where the read does), and where the last one ends.
        let mut cuts: Vec<usize> = (size..complete).step_by(size).map(|i| starts[i]).collect();
        cuts.push(starts[complete]);
        let offsets = codec::byte_offsets_of(codec, bytes, at_start, &cuts).ok()?;
        let mut pieces = Vec::with_capacity(cuts.len());
        let (mut text_from, mut byte_from, mut first_chunk) = (0, ctx.start, 0);
        for (k, (&cut, &offset)) in cuts.iter().zip(&offsets).enumerate() {
            let to = ctx.start + len_u64(offset);
            let last_chunk = if k + 1 == cuts.len() {
                complete
            } else {
                (k + 1) * size
            };
            pieces.push(SplitPiece {
                text: text_from..cut,
                from: byte_from,
                to,
                chunks: last_chunk - first_chunk,
            });
            (text_from, byte_from, first_chunk) = (cut, to, last_chunk);
        }
        let forced = ctx
            .file
            .site_override
            .filter(|forced| rail_core::parsers::builtin().get(forced).is_some())
            .map(str::to_owned);
        Some(Split {
            text: String::new(),
            options: ConvertOptions::default(),
            encoding: codec.encoding(),
            detected: Vec::new(),
            codec,
            head,
            file: FileState {
                path: path_key(ctx.file.path),
                source_id: ctx.file.source_id,
                from_offset: ctx.start,
                to_offset: ctx.start,
                size: ctx.size,
                mtime_ms: ctx.mtime,
                encoding: None,
                site: None,
                last_error: None,
            },
            forced,
            pieces,
        })
    }

    /// Convert a split read's batches, as many at a time as the limits
    /// allow (in parallel on the current rayon pool), and commit each group
    /// in order - queued back to back, so the writer commits a group in one
    /// transaction, each batch in its savepoint. Stops early on an
    /// interrupt, a stale offset (someone else moved it: the next look
    /// reads again from the store's offset) or a batch that does not split
    /// as the whole did (then the file is read whole from now on, as the
    /// one-batch path does). The rest of the file - its last hand at least -
    /// is looked at again at once.
    fn commit_split(&self, split: Split, track: &mut FileTrack, now: i64) -> Result<Polled> {
        let mut total = ImportOutcome::default();
        let mut done: Option<(u64, u64)> = None;
        let mut first = true;
        'groups: for group in split.pieces.chunks(self.limits.threads().max(1)) {
            if !first && self.limits.stops(split.file.source_id) {
                break;
            }
            let batches: Vec<Option<Result<ImportBatch>>> = group
                .par_iter()
                .map(|piece| self.split_batch(&split, piece))
                .collect();
            let mut pending = Vec::with_capacity(batches.len());
            let mut whole = false;
            for (piece, batch) in group.iter().zip(batches) {
                match batch {
                    Some(batch) => pending.push((piece, self.writer.import_async(batch?)?)),
                    None => {
                        whole = true;
                        break;
                    }
                }
            }
            for (piece, pending) in pending {
                match pending.wait() {
                    Ok(outcome) => {
                        track.stats.commits += 1;
                        if first {
                            track.codec = Some(split.codec);
                            if split.head.is_some() {
                                track.head.clone_from(&split.head);
                            }
                            first = false;
                        }
                        total.file_id = outcome.file_id;
                        total.inserted += outcome.inserted;
                        total.duplicates += outcome.duplicates;
                        total.quarantined += outcome.quarantined;
                        total.unrecognized |= outcome.unrecognized;
                        done = Some((done.map_or(piece.from, |(from, _)| from), piece.to));
                    }
                    Err(rail_store::Error::OffsetMismatch { .. }) => break 'groups,
                    Err(error) => return Err(error.into()),
                }
            }
            if whole {
                track.whole_file = true;
                break;
            }
        }
        track.stats.splits += 1;
        Ok(match done {
            Some((from, to)) => Polled::Committed {
                outcome: total,
                from,
                to,
                recheck_at: Some(now),
            },
            None => Polled::Waiting {
                recheck_at: Some(now),
            },
        })
    }

    /// One batch of a split read; `None` when its text does not split into
    /// its own chunks (then nothing of it is committed).
    fn split_batch(&self, split: &Split, piece: &SplitPiece) -> Option<Result<ImportBatch>> {
        let result = convert_any(&split.text[piece.text.clone()], &split.options);
        if let Ok(result) = &result
            && usize::try_from(result.chunks).ok() != Some(piece.chunks)
        {
            return None;
        }
        let conversion = FileConversion {
            encoding: split.encoding,
            problem: None,
            detected: split.detected.clone(),
            result: Some(result),
            unrecognized: None,
        };
        let file = FileState {
            from_offset: piece.from,
            to_offset: piece.to,
            ..split.file.clone()
        };
        Some(
            ImportBatch::from_conversion(file, &conversion)
                .map(|mut batch| {
                    if split.forced.is_some() {
                        batch.file.site.clone_from(&split.forced);
                    }
                    batch
                })
                .map_err(Error::from),
        )
    }

    /// The batch for `conversion`, read from `ctx.start` to `to`.
    fn commit(
        &self,
        ctx: &ReadCtx<'_>,
        to: u64,
        conversion: &FileConversion,
        codec: Option<Codec>,
        head: Option<Vec<u8>>,
        recheck_at: Option<i64>,
    ) -> Result<Interpreted> {
        let mut batch = ImportBatch::from_conversion(
            FileState {
                path: path_key(ctx.file.path),
                source_id: ctx.file.source_id,
                from_offset: ctx.start,
                to_offset: to,
                size: ctx.size,
                mtime_ms: ctx.mtime,
                encoding: None,
                site: None,
                last_error: None,
            },
            conversion,
        )?;
        // Under the folder's forced parser the file is that parser's,
        // whatever detection would say (R1.5: a change of the room reads
        // again exactly the files another parser read).
        if let Some(forced) = ctx.file.site_override
            && rail_core::parsers::builtin().get(forced).is_some()
        {
            batch.file.site = Some(forced.to_owned());
        }
        // `unsupported.count` goes up on every batch that carries the
        // record: only a file's first read (or one after truncation) does.
        if !ctx.fresh {
            batch.unrecognized = None;
        }
        Ok(Interpreted::Step(Step::Commit {
            batch: Box::new(batch),
            codec,
            head,
            recheck_at,
        }))
    }
}

/// Where each chunk starts in `text`, searching in order; `None` when one
/// is not in the text verbatim (the parser assembled it).
pub fn locate(text: &str, chunks: &[String]) -> Option<Vec<usize>> {
    let mut starts = Vec::with_capacity(chunks.len());
    let mut cursor = 0;
    for chunk in chunks {
        let found = text[cursor..].find(chunk.as_str())?;
        starts.push(cursor + found);
        cursor += found + chunk.len();
    }
    Some(starts)
}

/// The hands and refusals of chunks before `index`.
fn keep_before(mut result: ConversionResult, index: u32) -> ConversionResult {
    result.hands.retain(|hand| hand.index < index);
    result
        .failures
        .retain(|failure| failure.index.is_some_and(|i| i < index));
    result.chunks = index;
    result
}

fn len_u64(len: usize) -> u64 {
    u64::try_from(len).unwrap_or(u64::MAX)
}

/// The file's bytes from `start` up to `end` (fewer if it shrank meanwhile).
fn read_range(path: &Path, start: u64, end: u64) -> Result<Vec<u8>> {
    let io = |error| Error::io(path, error);
    let mut file = File::open(path).map_err(io)?;
    file.seek(SeekFrom::Start(start)).map_err(io)?;
    let mut bytes = Vec::with_capacity(usize::try_from(end.saturating_sub(start)).unwrap_or(0));
    file.take(end.saturating_sub(start))
        .read_to_end(&mut bytes)
        .map_err(io)?;
    Ok(bytes)
}
