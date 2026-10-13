//! The single writer: one thread owns the only write connection and takes
//! commands from a bounded channel. Every command is one transaction.
//!
//! SQLite allows one writer at a time anyway; owning it on one thread means
//! no `SQLITE_BUSY` between our own writers, a natural back-pressure point
//! for the import pipeline (a full channel blocks the producers, R1.6), and
//! one place where the invariant of R1.2 lives: **a file's read offset
//! advances in the same transaction as the hands read up to it** (see
//! [`apply_import`]).

use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::batch::{ImportBatch, ImportOutcome};
use crate::error::{Error, Result};

/// Commands waiting for the writer. Small: a command is a whole file's
/// batch, and a full queue should push back on the readers, not buffer
/// thousands of hands in memory.
pub const QUEUE_DEPTH: usize = 16;

/// A write job: opens its transaction on the writer's connection, commits
/// it, and answers its caller.
type Job = Box<dyn FnOnce(&mut Connection) + Send>;

/// What the writer thread is asked to do.
enum Command {
    /// Store one read of one file (one transaction), and answer.
    Import(Box<ImportBatch>, SyncSender<Result<ImportOutcome>>),
    /// Any other write, as a closure that answers on its own channel.
    Write(Job),
}

/// A cloneable handle on the writer: what producers (the import pipeline,
/// the sync worker) hold. Every call blocks until its transaction has
/// committed (or failed).
#[derive(Clone)]
pub struct WriterHandle {
    sender: SyncSender<Command>,
}

impl std::fmt::Debug for WriterHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriterHandle").finish_non_exhaustive()
    }
}

impl WriterHandle {
    /// Commit one batch: the file's new state, its new hands (each queued in
    /// `outbox`), its refusals and its registry record, in one transaction.
    pub fn import(&self, batch: ImportBatch) -> Result<ImportOutcome> {
        let (reply, answer) = mpsc::sync_channel(1);
        self.sender
            .send(Command::Import(Box::new(batch), reply))
            .map_err(|_| Error::WriterGone)?;
        answer.recv().map_err(|_| Error::WriterGone)?
    }

    /// Run `job` in a transaction on the writer thread and return what it
    /// returns. The transaction commits when `job` returns `Ok`.
    pub fn write<T, F>(&self, job: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction<'_>) -> Result<T> + Send + 'static,
    {
        let (reply, answer) = mpsc::sync_channel(1);
        let job: Job = Box::new(move |conn| {
            let _ = reply.send(in_transaction(conn, job));
        });
        self.sender
            .send(Command::Write(job))
            .map_err(|_| Error::WriterGone)?;
        answer.recv().map_err(|_| Error::WriterGone)?
    }
}

/// The writer thread and the handle that feeds it.
pub(crate) struct Writer {
    handle: Option<WriterHandle>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Writer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Writer").finish_non_exhaustive()
    }
}

impl Writer {
    /// Start the writer thread on `conn` (already configured and migrated).
    pub(crate) fn start(conn: Connection) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_DEPTH);
        let thread = thread::Builder::new()
            .name("rail-store-writer".to_owned())
            .spawn(move || run(conn, &receiver))
            .map_err(|source| Error::Io {
                path: "rail-store-writer".into(),
                source,
            })?;
        Ok(Self {
            handle: Some(WriterHandle { sender }),
            thread: Some(thread),
        })
    }

    pub(crate) fn handle(&self) -> Result<&WriterHandle> {
        self.handle.as_ref().ok_or(Error::WriterGone)
    }

    /// Close the channel and wait for the queued commands to finish.
    pub(crate) fn shutdown(&mut self) {
        self.handle = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run(mut conn: Connection, commands: &Receiver<Command>) {
    // Ends when every handle is dropped.
    while let Ok(command) = commands.recv() {
        match command {
            Command::Import(batch, reply) => {
                let result = in_transaction(&mut conn, |tx| apply_import(tx, &batch));
                let _ = reply.send(result);
            }
            Command::Write(job) => job(&mut conn),
        }
    }
    // Leave the WAL small for the next start (best effort).
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
}

/// Run `f` in a transaction: commit on `Ok`, roll back (by drop) on `Err`.
fn in_transaction<T>(
    conn: &mut Connection,
    f: impl FnOnce(&Transaction<'_>) -> Result<T>,
) -> Result<T> {
    let tx = conn.transaction()?;
    let value = f(&tx)?;
    tx.commit()?;
    Ok(value)
}

fn to_i64(value: u64, what: &'static str) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::OutOfRange(what))
}

/// One batch, inside the caller's transaction:
///
/// 1. the stored offset must be where the batch's read started (or the
///    read started at 0), else [`Error::OffsetMismatch`] and nothing is
///    written;
/// 2. the file's row gets its new offset, size, mtime, encoding, site and
///    error;
/// 3. each hand is inserted unless its `hand_key` is already stored, and a
///    newly inserted hand enters `outbox`;
/// 4. refusals go to `quarantine` (one row per file and fingerprint,
///    refreshed on a re-read);
/// 5. a registry record is inserted, or its `count` bumped.
///
/// Because all five happen in one transaction, a crash leaves either the
/// old offset and none of this batch's rows, or the new offset and all of
/// them.
pub fn apply_import(tx: &Transaction<'_>, batch: &ImportBatch) -> Result<ImportOutcome> {
    let now = crate::time::now_ms();
    let file = &batch.file;

    let stored: Option<i64> = tx
        .query_row(
            "SELECT read_offset FROM files WHERE path = ?1",
            [&file.path],
            |row| row.get(0),
        )
        .optional()?;
    let stored = u64::try_from(stored.unwrap_or(0)).map_err(|_| Error::OutOfRange("offset"))?;
    if file.from_offset != 0 && file.from_offset != stored {
        return Err(Error::OffsetMismatch {
            path: file.path.clone(),
            stored,
            batch_from: file.from_offset,
        });
    }

    let file_id: i64 = tx
        .prepare_cached(
            "INSERT INTO files (path, source_id, size, mtime, read_offset, encoding, site,
                                last_error, first_seen, last_import_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT (path) DO UPDATE SET
               source_id      = coalesce(excluded.source_id, files.source_id),
               size           = excluded.size,
               mtime          = excluded.mtime,
               read_offset    = excluded.read_offset,
               encoding       = coalesce(excluded.encoding, files.encoding),
               site           = coalesce(excluded.site, files.site),
               last_error     = excluded.last_error,
               last_import_at = excluded.last_import_at
             RETURNING id",
        )?
        .query_row(
            params![
                file.path,
                file.source_id,
                to_i64(file.size, "file size")?,
                file.mtime_ms,
                to_i64(file.to_offset, "offset")?,
                file.encoding,
                file.site,
                file.last_error,
                now,
            ],
            |row| row.get(0),
        )?;

    let mut outcome = ImportOutcome {
        file_id,
        ..ImportOutcome::default()
    };

    let mut insert_hand = tx.prepare_cached(
        "INSERT INTO hands (hand_key, site, site_hand_id, played_at, game_format, variant,
                            limit_type, currency, small_blind, big_blind, ante, table_name,
                            max_seats, hero_seat, hero_name, schema_version, parser_id,
                            parser_version, phf, phf_size, file_id, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT (hand_key) DO NOTHING",
    )?;
    let mut enqueue = tx.prepare_cached(
        "INSERT INTO outbox (hand_key, enqueued_at, next_attempt_at) VALUES (?1, ?2, ?2)
         ON CONFLICT (hand_key) DO NOTHING",
    )?;
    for hand in &batch.hands {
        let inserted = insert_hand.execute(params![
            hand.hand_key,
            hand.site,
            hand.site_hand_id,
            hand.played_at,
            hand.game_format,
            hand.variant,
            hand.limit_type,
            hand.currency,
            hand.small_blind,
            hand.big_blind,
            hand.ante,
            hand.table_name,
            hand.max_seats,
            hand.hero_seat,
            hand.hero_name,
            hand.schema_version,
            hand.parser_id,
            hand.parser_version,
            hand.phf_zstd,
            to_i64(hand.phf_size, "PHF size")?,
            file_id,
            now,
        ])?;
        if inserted == 1 {
            enqueue.execute(params![hand.hand_key, now])?;
            outcome.inserted += 1;
        } else {
            outcome.duplicates += 1;
        }
    }

    let read_from = to_i64(file.from_offset, "offset")?;
    let mut quarantine = tx.prepare_cached(
        "INSERT INTO quarantine (file_id, read_offset, chunk_index, fingerprint, stage, reason,
                                 message, detected_site, detection_permille, parser_version,
                                 raw_text, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
         ON CONFLICT (file_id, fingerprint) DO UPDATE SET
           read_offset        = excluded.read_offset,
           chunk_index        = excluded.chunk_index,
           stage              = excluded.stage,
           reason             = excluded.reason,
           message            = excluded.message,
           detected_site      = excluded.detected_site,
           detection_permille = excluded.detection_permille,
           parser_version     = excluded.parser_version,
           last_seen          = excluded.last_seen",
    )?;
    for refusal in &batch.refusals {
        quarantine.execute(params![
            file_id,
            read_from,
            refusal.chunk_index,
            refusal.fingerprint,
            refusal.stage,
            refusal.reason,
            refusal.message,
            refusal.detected_site,
            refusal.detection_permille,
            refusal.parser_version,
            refusal.raw_text,
            now,
        ])?;
        outcome.quarantined += 1;
    }

    if let Some(record) = &batch.unrecognized {
        tx.prepare_cached(
            "INSERT INTO unsupported (fingerprint, header_sample, guessed_site, confidence,
                                      guess_basis, shape, file_path, encoding, count,
                                      first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)
             ON CONFLICT (fingerprint) DO UPDATE SET
               count         = unsupported.count + 1,
               header_sample = excluded.header_sample,
               guessed_site  = excluded.guessed_site,
               confidence    = excluded.confidence,
               guess_basis   = excluded.guess_basis,
               file_path     = excluded.file_path,
               encoding      = excluded.encoding,
               last_seen     = excluded.last_seen",
        )?
        .execute(params![
            record.fingerprint,
            record.header_sample,
            record.guessed_site,
            record.confidence,
            record.guess_basis,
            record.shape,
            file.path,
            file.encoding.as_deref().unwrap_or(""),
            now,
        ])?;
        outcome.unrecognized = true;
    }

    Ok(outcome)
}
