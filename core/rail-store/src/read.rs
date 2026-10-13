//! Read connections and the queries the next steps need.
//!
//! A [`Reader`] is a small pool of read-only connections. In WAL mode a
//! reader never blocks the writer and the writer never blocks a reader: each
//! read sees the database as of its last commit. The HUD (Phase 3) opens its
//! own [`Reader`] on the same file from its own process.
//!
//! Kept simple on purpose: counts for the Today screen and the folders view
//! (R1.5), the quarantine list, the outbox batch for the sync worker (R1.9)
//! and the registry. Reporting is Phase 2.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};

use crate::batch::decompress_phf;
use crate::error::{Error, Result};

/// Start of today in local time, as ms since the epoch (SQLite's own
/// `localtime`, the OS time zone).
const TODAY_START_MS: &str =
    "CAST(strftime('%s', 'now', 'localtime', 'start of day', 'utc') AS INTEGER) * 1000";

/// A pool of read-only connections.
#[derive(Debug)]
pub struct Reader {
    conns: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl Reader {
    /// Open `size` (at least 1) read-only connections on an existing store.
    pub fn open(path: &Path, size: usize) -> Result<Self> {
        let mut conns = Vec::new();
        for _ in 0..size.max(1) {
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            conn.busy_timeout(crate::BUSY_TIMEOUT)?;
            conn.pragma_update(None, "query_only", true)?;
            conns.push(Mutex::new(conn));
        }
        Ok(Self {
            conns,
            next: AtomicUsize::new(0),
        })
    }

    /// Run `f` on a free connection (or wait for the next one in turn).
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        for conn in &self.conns {
            if let Ok(conn) = conn.try_lock() {
                return f(&conn);
            }
        }
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.conns.len();
        let conn = self.conns[index]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        f(&conn)
    }

    /// The counts the Today screen shows.
    pub fn status(&self) -> Result<StoreStatus> {
        self.with(|conn| {
            let count = |sql: &str| -> Result<u64> {
                let n: i64 = conn.query_row(sql, [], |row| row.get(0))?;
                u64::try_from(n).map_err(|_| Error::OutOfRange("count"))
            };
            Ok(StoreStatus {
                schema_version: crate::migrate::version(conn)?,
                hands: count("SELECT count(*) FROM hands")?,
                hands_today: count(&format!(
                    "SELECT count(*) FROM hands WHERE imported_at >= {TODAY_START_MS}"
                ))?,
                files: count("SELECT count(*) FROM files")?,
                files_with_errors: count(
                    "SELECT count(*) FROM files WHERE last_error IS NOT NULL",
                )?,
                sources: count("SELECT count(*) FROM sources")?,
                quarantined: count("SELECT count(*) FROM quarantine")?,
                unsupported: count("SELECT count(*) FROM unsupported")?,
                outbox: count("SELECT count(*) FROM outbox")?,
            })
        })
    }

    /// Hands stored at or after `since_ms`.
    pub fn hands_imported_since(&self, since_ms: i64) -> Result<u64> {
        self.with(|conn| {
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM hands WHERE imported_at >= ?1",
                [since_ms],
                |row| row.get(0),
            )?;
            u64::try_from(n).map_err(|_| Error::OutOfRange("count"))
        })
    }

    /// Where a file stands: what R1.3's reader resumes from.
    pub fn file_state(&self, path: &str) -> Result<Option<StoredFile>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, read_offset, size, mtime FROM files WHERE path = ?1",
                    [path],
                    |row| {
                        Ok(StoredFile {
                            id: row.get(0)?,
                            read_offset: row.get(1)?,
                            size: row.get(2)?,
                            mtime_ms: row.get(3)?,
                        })
                    },
                )
                .optional()?)
        })
    }

    /// Every file with its counts, most recently imported first.
    pub fn files(&self) -> Result<Vec<FileSummary>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT f.id, f.path, f.source_id, f.size, f.read_offset, f.encoding, f.site,
                        f.last_error, f.last_import_at,
                        (SELECT count(*) FROM hands h WHERE h.file_id = f.id),
                        (SELECT count(*) FROM quarantine q WHERE q.file_id = f.id)
                 FROM files f
                 ORDER BY f.last_import_at DESC, f.path",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(FileSummary {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    source_id: row.get(2)?,
                    size: row.get(3)?,
                    read_offset: row.get(4)?,
                    encoding: row.get(5)?,
                    site: row.get(6)?,
                    last_error: row.get(7)?,
                    last_import_at: row.get(8)?,
                    hands: row.get(9)?,
                    quarantined: row.get(10)?,
                })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    /// Every watched folder with its counts.
    pub fn sources(&self) -> Result<Vec<SourceSummary>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT s.id, s.path, s.site_override, s.enabled, s.recursive, s.status,
                        s.last_error,
                        (SELECT count(*) FROM files f WHERE f.source_id = s.id),
                        (SELECT count(*) FROM hands h JOIN files f ON f.id = h.file_id
                          WHERE f.source_id = s.id),
                        (SELECT count(*) FROM hands h JOIN files f ON f.id = h.file_id
                          WHERE f.source_id = s.id AND h.imported_at >= {TODAY_START_MS}),
                        (SELECT count(*) FROM quarantine q JOIN files f ON f.id = q.file_id
                          WHERE f.source_id = s.id),
                        (SELECT max(f.last_import_at) FROM files f WHERE f.source_id = s.id)
                 FROM sources s
                 ORDER BY s.path"
            ))?;
            let rows = stmt.query_map([], |row| {
                Ok(SourceSummary {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    site_override: row.get(2)?,
                    enabled: row.get(3)?,
                    recursive: row.get(4)?,
                    status: row.get(5)?,
                    last_error: row.get(6)?,
                    files: row.get(7)?,
                    hands: row.get(8)?,
                    hands_today: row.get(9)?,
                    quarantined: row.get(10)?,
                    last_import_at: row.get(11)?,
                })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    /// The quarantine, most recent first, without the raw text (see
    /// [`Reader::quarantine_raw_text`]).
    pub fn quarantine(&self, limit: u32) -> Result<Vec<QuarantineEntry>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT q.id, f.path, q.read_offset, q.chunk_index, q.fingerprint, q.stage,
                        q.reason, q.message, q.detected_site, q.parser_version, q.first_seen,
                        q.last_seen
                 FROM quarantine q JOIN files f ON f.id = q.file_id
                 ORDER BY q.last_seen DESC, q.id DESC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map([limit], |row| {
                Ok(QuarantineEntry {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    read_offset: row.get(2)?,
                    chunk_index: row.get(3)?,
                    fingerprint: row.get(4)?,
                    stage: row.get(5)?,
                    reason: row.get(6)?,
                    message: row.get(7)?,
                    detected_site: row.get(8)?,
                    parser_version: row.get(9)?,
                    first_seen: row.get(10)?,
                    last_seen: row.get(11)?,
                })
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    /// Quarantined chunks per reason code, most frequent first.
    pub fn quarantine_reasons(&self) -> Result<Vec<(String, i64)>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT reason, count(*) AS n FROM quarantine GROUP BY reason
                 ORDER BY n DESC, reason",
            )?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    /// A quarantined chunk's raw text.
    pub fn quarantine_raw_text(&self, id: i64) -> Result<Option<String>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT raw_text FROM quarantine WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?)
        })
    }

    /// Up to `limit` outbox entries due at `now_ms`, oldest first, with
    /// their PHF: what the sync worker (R1.9) sends next.
    pub fn outbox_due(&self, now_ms: i64, limit: u32) -> Result<Vec<OutboxItem>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT o.hand_key, o.attempts, o.last_error, h.phf, h.phf_size
                 FROM outbox o JOIN hands h ON h.hand_key = o.hand_key
                 WHERE o.next_attempt_at <= ?1
                 ORDER BY o.enqueued_at, o.hand_key
                 LIMIT ?2",
            )?;
            let mut rows = stmt.query(params![now_ms, limit])?;
            let mut items = Vec::new();
            while let Some(row) = rows.next()? {
                let blob: Vec<u8> = row.get(3)?;
                let size: i64 = row.get(4)?;
                let size = u64::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
                items.push(OutboxItem {
                    hand_key: row.get(0)?,
                    attempts: row.get(1)?,
                    last_error: row.get(2)?,
                    phf: decompress_phf(&blob, size)?,
                });
            }
            Ok(items)
        })
    }

    /// The unsupported-format registry, most recently seen first.
    pub fn unsupported(&self) -> Result<Vec<UnsupportedEntry>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT fingerprint, header_sample, guessed_site, confidence, guess_basis, shape,
                        file_path, encoding, count, first_seen, last_seen, consented_at,
                        sent_at, anonymiser_version
                 FROM unsupported
                 ORDER BY last_seen DESC, fingerprint",
            )?;
            let rows = stmt.query_map([], unsupported_row)?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    /// One stored hand's canonical PHF JSON.
    pub fn hand_phf(&self, hand_key: &str) -> Result<Option<String>> {
        self.with(|conn| {
            let row: Option<(Vec<u8>, i64)> = conn
                .query_row(
                    "SELECT phf, phf_size FROM hands WHERE hand_key = ?1",
                    [hand_key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            row.map(|(blob, size)| {
                let size = u64::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
                decompress_phf(&blob, size)
            })
            .transpose()
        })
    }

    /// A `kv` value.
    pub fn kv(&self, key: &str) -> Result<Option<String>> {
        self.with(|conn| {
            Ok(conn
                .query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
                    row.get(0)
                })
                .optional()?)
        })
    }
}

fn unsupported_row(row: &Row<'_>) -> rusqlite::Result<UnsupportedEntry> {
    Ok(UnsupportedEntry {
        fingerprint: row.get(0)?,
        header_sample: row.get(1)?,
        guessed_site: row.get(2)?,
        confidence: row.get(3)?,
        guess_basis: row.get(4)?,
        shape: row.get(5)?,
        file_path: row.get(6)?,
        encoding: row.get(7)?,
        count: row.get(8)?,
        first_seen: row.get(9)?,
        last_seen: row.get(10)?,
        consented_at: row.get(11)?,
        sent_at: row.get(12)?,
        anonymiser_version: row.get(13)?,
    })
}

/// The Today screen's counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StoreStatus {
    pub schema_version: u32,
    pub hands: u64,
    /// Stored since local midnight.
    pub hands_today: u64,
    pub files: u64,
    pub files_with_errors: u64,
    pub sources: u64,
    pub quarantined: u64,
    pub unsupported: u64,
    /// Hands not yet synced.
    pub outbox: u64,
}

/// Where a file stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoredFile {
    pub id: i64,
    pub read_offset: i64,
    pub size: i64,
    pub mtime_ms: Option<i64>,
}

/// A file and its counts. `hands` counts the hands this file was the first
/// to deliver (a hand stored from another file first is that file's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSummary {
    pub id: i64,
    pub path: String,
    pub source_id: Option<i64>,
    pub size: i64,
    pub read_offset: i64,
    pub encoding: Option<String>,
    pub site: Option<String>,
    pub last_error: Option<String>,
    pub last_import_at: Option<i64>,
    pub hands: i64,
    pub quarantined: i64,
}

/// A watched folder and its counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSummary {
    pub id: i64,
    pub path: String,
    pub site_override: Option<String>,
    pub enabled: bool,
    pub recursive: bool,
    pub status: String,
    pub last_error: Option<String>,
    pub files: i64,
    pub hands: i64,
    pub hands_today: i64,
    pub quarantined: i64,
    pub last_import_at: Option<i64>,
}

/// A refused chunk, for the list (raw text separately).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantineEntry {
    pub id: i64,
    pub file_path: String,
    pub read_offset: i64,
    pub chunk_index: Option<i64>,
    pub fingerprint: String,
    pub stage: String,
    pub reason: String,
    pub message: String,
    pub detected_site: Option<String>,
    pub parser_version: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

/// A hand waiting to be synced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxItem {
    pub hand_key: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    /// The canonical PHF JSON.
    pub phf: String,
}

/// A registry row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedEntry {
    pub fingerprint: String,
    pub header_sample: String,
    pub guessed_site: Option<String>,
    pub confidence: i64,
    pub guess_basis: Option<String>,
    pub shape: String,
    pub file_path: String,
    pub encoding: String,
    pub count: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub consented_at: Option<i64>,
    pub sent_at: Option<i64>,
    pub anonymiser_version: Option<String>,
}
