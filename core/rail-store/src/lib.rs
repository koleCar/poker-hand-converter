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
//!
//! The schema is documented table by table in `SCHEMA.md`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, params};

pub mod batch;
pub mod error;
pub mod import;
pub mod migrate;
pub mod read;
pub mod sources;
pub mod time;
pub mod writer;

pub use batch::{FileState, ImportBatch, ImportOutcome, PreparedHand, Refusal, UnrecognizedFile};
pub use error::{Error, Result};
pub use import::{FileImport, ImportOptions, import_file};
pub use read::{Reader, StoreStatus};
pub use writer::WriterHandle;

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

/// Read connections in the pool [`Store::open`] makes.
pub const READERS: usize = 4;

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
        let (key, value) = (key.to_owned(), value.to_owned());
        self.writer.handle()?.write(move |tx| {
            tx.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                                 updated_at = excluded.updated_at",
                params![key, value, time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// The server has these hands: they leave the outbox and are marked
    /// synced. Returns how many left.
    pub fn outbox_mark_sent(&self, hand_keys: Vec<String>, at_ms: i64) -> Result<u64> {
        self.writer.handle()?.write(move |tx| {
            let mut delete = tx.prepare_cached("DELETE FROM outbox WHERE hand_key = ?1")?;
            let mut mark = tx.prepare_cached(
                "UPDATE hands SET synced_at = ?2 WHERE hand_key = ?1 AND synced_at IS NULL",
            )?;
            let mut removed = 0;
            for key in &hand_keys {
                removed += u64::try_from(delete.execute([key])?).unwrap_or(0);
                mark.execute(params![key, at_ms])?;
            }
            Ok(removed)
        })
    }

    /// A send failed: count the attempt, keep the error, and wait until
    /// `next_attempt_at_ms` (the backoff is the sync worker's, R1.9).
    pub fn outbox_mark_failed(
        &self,
        hand_keys: Vec<String>,
        error: &str,
        next_attempt_at_ms: i64,
    ) -> Result<()> {
        let error = error.to_owned();
        self.writer.handle()?.write(move |tx| {
            let mut update = tx.prepare_cached(
                "UPDATE outbox SET attempts = attempts + 1, last_error = ?2,
                                   next_attempt_at = ?3
                 WHERE hand_key = ?1",
            )?;
            for key in &hand_keys {
                update.execute(params![key, error, next_attempt_at_ms])?;
            }
            Ok(())
        })
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
