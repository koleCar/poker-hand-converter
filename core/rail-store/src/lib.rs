#![forbid(unsafe_code)]
//! The local SQLite store the app writes and the HUD reads
//! (docs/RAIL-PLAN.md §3.4, R1.2; guideline §4, local-first: a hand is
//! written here first, then synced to Supabase in batches).
//!
//! - **One file**, SQLite compiled in (`rusqlite`, `bundled`), WAL mode,
//!   `synchronous = NORMAL` (a commit survives a crash of the process; an OS
//!   crash or power cut may lose the last commits, never consistency),
//!   foreign keys on, a busy timeout.
//! - **Migrations** ([`migrate`]): embedded SQL files, versioned by `PRAGMA
//!   user_version`, forward-only, each in its own transaction.
//! - **One writer** ([`writer`]): a thread owns the write connection and
//!   takes commands from a bounded channel. An [`ImportBatch`] - one read of
//!   one file - commits in one transaction with the file's new read offset,
//!   so a crash can neither store hands without moving the offset nor move
//!   the offset without storing the hands. Hands dedupe by `hand_key`, and a
//!   newly stored hand enters the sync `outbox` in the same transaction.
//! - **Readers** ([`read`]): a small pool of read-only connections for the
//!   UI; WAL readers never wait for the writer.
//! - **Import** ([`import`]): `import_file` runs `rail_core` on a whole file
//!   and commits it; R1.3's incremental reader sends the same batches.
//! - **The Hands screen** (R2.7a, [`hand_list`]): the list with its
//!   filters and counts, "go to hand", notes, tags and saved filters.
//! - **Reports** (R2.7b, [`report`]): the win-rate graph, the latest
//!   session and the breakdowns by situation.
//! - **Players** (R2.7c, [`players`]): the opponents with their hands and
//!   result together, a profile, and the user's colour tags, labels and
//!   notes.
//! - **Statistics** (R2.3, [`stats`], [`stats_read`], [`background`]): a
//!   hand's seat rows, rollup increments and EV row are derived with the
//!   hand (on the producer's thread) and written in its transaction; a
//!   background pass computes the expensive EV rows (preflop all-ins).
//! - **Targeted recompute** (R2.11, [`recompute`]): after a definition
//!   changes, the background pass works out only what the change touches,
//!   beside the statistics the screens read, and swaps it in whole.
//! - **The HUD's layouts** (R3.6, [`hud`]): where the user dragged a seat's
//!   panel and whether their client rotates the table; written by the app
//!   for the HUD process, which only reads.
//!
//! The schema is documented table by table in `SCHEMA.md`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, params};

pub mod background;
pub mod batch;
pub mod custom;
pub mod error;
pub mod hand_list;
pub mod hud;
pub mod import;
pub mod migrate;
pub mod players;
pub mod read;
pub mod recompute;
pub mod report;
pub mod sources;
pub mod stats;
pub mod stats_read;
pub mod sync;
pub mod time;
pub mod writer;

pub use background::{Activity, StatsWorker, WorkerStatus};
pub use batch::{
    EvPlan, FileState, ImportBatch, ImportOutcome, ListFacts, PreparedHand, PreparedSeat,
    PreparedStats, Refusal, UnrecognizedFile,
};
pub use custom::{CustomCounts, CustomProgress, CustomStatRow};
pub use error::{Error, Result};
pub use hand_list::{
    Annotations, FacetCount, HandCursor, HandFacets, HandFilter, HandPage, HandRow, PlayerRef,
    SavedFilter, StakeFacet,
};
pub use hud::{
    HudSyncApplied, HudSyncKind, HudSyncRow, LayoutAssignment, RoomSettings, SeatPosition,
    StoredLayout,
};
pub use import::{FileImport, ImportOptions, import_file};
pub use players::{GameKind, PlayerList, PlayerNotes, PlayerProfile, PlayerQuery, PlayerRow};
pub use read::{Reader, StaleRefusals, StoreStatus};
pub use recompute::{EvRecomputeState, RebuildState, RowsJob};
pub use report::{Breakdowns, Graph, GraphPoint, ReportFilter, Session, Units};
pub use sources::{FileMove, OverrideChange, ParserVersions, PathChange, ResetFile};
pub use stats::{Exclusions, PlayerSeen, SeatValues, Totals};
pub use stats_read::{
    EvAdjust, HandSeat, HeroFilter, HeroSum, HeroTotal, HudHand, ImportedHand, Rollup, SegmentRow,
    StatsStatus,
};
pub use sync::{OutboxEntry, PulledOutcome, Rejection, SyncCounts};
pub use writer::{PendingImport, WriterHandle};

/// How long a connection waits for a lock before `SQLITE_BUSY`. Only
/// another process (the HUD reading, a checkpoint) can hold one: our own
/// writes are serialised by the writer thread.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The page size of a new store. A compressed PHF is ~2.5 KB on average;
/// with SQLite's default 4 KiB pages a row holds at most ~1 KB of it and
/// spills the rest into a mostly empty overflow page (measured on the
/// corpus: 4.4 KB per hand on disk). 16 KiB pages keep a typical hand in
/// its leaf page.
pub const PAGE_SIZE: u32 = 16_384;

/// The write connection's page cache, in KiB (16 MiB; SQLite's default is
/// 2 MB). Measured with `import_bench --writer-only`: -6 % of the writer's
/// time per hand; 64 MiB did no better.
pub const WRITE_CACHE_KIB: i64 = 16_384;

/// The write connection checkpoints the WAL into the database once it holds
/// this many pages (SQLite's default: 1 000). Measured with `import_bench
/// --writer-only`: -6 % of the writer's time per hand.
pub const WAL_AUTOCHECKPOINT: u32 = 4_096;

/// Read connections in the pool [`Store::open`] makes: the Reports
/// breakdown pass's [`report::PASS_THREADS`] and one for the other screens
/// meanwhile (R2.9; four before).
pub const READERS: usize = report::PASS_THREADS + 1;

/// The store's file name in the app's data directory.
pub const FILE_NAME: &str = "rail.db";

/// An open store: the writer thread and the read pool.
#[derive(Debug)]
pub struct Store {
    path: PathBuf,
    writer: writer::Writer,
    reader: Reader,
}

/// Open (creating if needed) the write connection, with the store's pragmas.
fn open_write_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // A file from a newer Rail is refused before anything here touches it.
    let found = migrate::version(&conn)?;
    if found > migrate::LATEST {
        return Err(Error::NewerSchema {
            found,
            known: migrate::LATEST,
        });
    }
    // Takes effect only on a new, empty file (before WAL is switched on);
    // a no-op on an existing store.
    conn.pragma_update(None, "page_size", PAGE_SIZE)?;
    // WAL is persistent (a property of the file), and returns the mode.
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(Error::Corrupt(format!(
            "journal mode is {mode}, WAL was asked for"
        )));
    }
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    // Each import batch runs in a savepoint (R1.6), and SQLite copies every
    // page a savepoint first changes into a statement journal - a temporary
    // file once it passes 64 KiB, opened, written and closed per group of
    // batches. In memory instead: with R2.3's statistics a batch touches
    // several times more pages, and those file calls were a third of the
    // writer's time (measured; the import threads lost the CPU to it on a
    // 3-core runner). A group's journal is a few MB.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // SQLite's default page cache is 2 MB - 128 of our 16 KiB pages, fewer
    // than one import transaction touches once the indexes keyed by hand
    // have grown: pages were read back from the OS between transactions.
    conn.pragma_update(None, "cache_size", -WRITE_CACHE_KIB)?;
    // A checkpoint every 4 096 WAL pages (64 MiB) instead of 1 000: an
    // import rewrites the same index and rollup pages in transaction after
    // transaction, and a checkpoint copies each page once however often it
    // changed, with one sync of the database. The WAL is truncated when the
    // store closes.
    conn.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT)?;
    Ok(conn)
}

impl Store {
    /// Open the store at `path`, creating the file and its directory if
    /// needed, and migrate it to the latest schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|source| Error::Io {
                path: dir.to_path_buf(),
                source,
            })?;
        }
        let mut conn = open_write_connection(&path)?;
        migrate::migrate(&mut conn)?;
        // Statistics of another version (or none yet): a rebuild is started,
        // the background pass (`StatsWorker`) does it.
        stats::ensure_current(&mut conn)?;
        let writer = writer::Writer::start(conn)?;
        let reader = Reader::open(&path, READERS)?;
        Ok(Self {
            path,
            writer,
            reader,
        })
    }

    /// The database file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The read pool.
    pub fn reader(&self) -> &Reader {
        &self.reader
    }

    /// A handle on the writer for another thread (the import pipeline, the
    /// sync worker).
    pub fn writer(&self) -> Result<WriterHandle> {
        self.writer.handle().cloned()
    }

    /// Commit one batch (see [`writer::apply_import`]).
    pub fn import(&self, batch: ImportBatch) -> Result<ImportOutcome> {
        self.writer.handle()?.import(batch)
    }

    /// The Today screen's counts.
    pub fn status(&self) -> Result<StoreStatus> {
        self.reader.status()
    }

    /// Add a watched folder, or return the id it already has (see
    /// [`WriterHandle::add_source`]).
    pub fn add_source(
        &self,
        path: &str,
        recursive: bool,
        site_override: Option<&str>,
    ) -> Result<i64> {
        self.writer
            .handle()?
            .add_source(path, recursive, site_override, false)
    }

    /// Set a `kv` value.
    pub fn set_kv(&self, key: &str, value: &str) -> Result<()> {
        self.writer.handle()?.set_kv(key, value)
    }

    /// The server has these hands: they leave the outbox and are marked
    /// synced. Returns how many left.
    pub fn outbox_mark_sent(&self, hand_keys: Vec<String>, at_ms: i64) -> Result<u64> {
        self.writer.handle()?.outbox_mark_sent(hand_keys, at_ms)
    }

    /// A send failed: count the attempt, keep the error, and wait until
    /// `next_attempt_at_ms` (the backoff is the sync worker's, R1.9).
    pub fn outbox_mark_failed(
        &self,
        hand_keys: Vec<String>,
        error: &str,
        next_attempt_at_ms: i64,
    ) -> Result<()> {
        self.writer
            .handle()?
            .outbox_mark_failed(hand_keys, error, next_attempt_at_ms)
    }

    /// The user agreed to share a registry entry's anonymised sample.
    pub fn unsupported_consent(&self, fingerprint: &str, at_ms: i64) -> Result<bool> {
        let fingerprint = fingerprint.to_owned();
        self.writer.handle()?.write(move |tx| {
            Ok(tx.execute(
                "UPDATE unsupported SET consented_at = ?2
                 WHERE fingerprint = ?1 AND consented_at IS NULL",
                params![fingerprint, at_ms],
            )? == 1)
        })
    }

    /// A registry entry's sample was sent, made by `anonymiser_version`.
    /// Refused by the table's check unless consent was recorded first.
    pub fn unsupported_mark_sent(
        &self,
        fingerprint: &str,
        at_ms: i64,
        anonymiser_version: &str,
    ) -> Result<bool> {
        let (fingerprint, version) = (fingerprint.to_owned(), anonymiser_version.to_owned());
        self.writer.handle()?.write(move |tx| {
            Ok(tx.execute(
                "UPDATE unsupported SET sent_at = ?2, anonymiser_version = ?3
                 WHERE fingerprint = ?1",
                params![fingerprint, at_ms, version],
            )? == 1)
        })
    }

    /// Stop the writer after the queued commands, and close.
    pub fn close(mut self) {
        self.writer.shutdown();
    }
}
