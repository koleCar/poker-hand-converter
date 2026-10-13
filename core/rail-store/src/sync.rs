//! What the sync worker (`rail-sync`, docs/RAIL-PLAN.md R1.9) reads and
//! writes here: the outbox in send order, its outcomes, the hands the server
//! refused, the owner of the store's hands, and the hands pulled from the
//! server.
//!
//! **Send order** ([`Reader::outbox_next`]). Two tiers: first the hands
//! queued in the last minutes (`enqueued_at >= live_since`), **newest played
//! first** - the hand just played goes out before anything else, even while
//! a large backfill is being queued at the same time (its hands were played
//! earlier); then everything older, oldest due first (the order they were
//! queued, or of their next retry). Both read the outbox only, through
//! covering indexes (`outbox_recent_idx`, `outbox_due_idx`); the PHF is read
//! for the chosen keys alone.
//!
//! **The owner** (`kv` [`OWNER_KEY`]): the account this store's hands are
//! synced to. The first account to sign in becomes it; another account syncs
//! nothing until the user agrees to upload this computer's hands to it
//! ([`WriterHandle::sync_set_owner`] with `requeue`), so an outbox is never
//! sent to an account other than the one it was meant for.

use std::collections::HashSet;

use rusqlite::{OptionalExtension, params};

use crate::batch::{PreparedHand, decompress_phf};
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::writer::WriterHandle;

/// `kv`: the account the store's hands sync to, `{"userId":..,"email":..}`.
pub const OWNER_KEY: &str = "sync.owner";

/// A hand waiting to be sent, with what the worker needs to send it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub hand_key: String,
    /// The watched folder of the file it came from (`files.source_id`);
    /// `None` when the file is in no folder (removed folder, a file imported
    /// by hand).
    pub source_id: Option<i64>,
    /// Failed sends so far.
    pub attempts: i64,
    /// From the first tier: queued in the last minutes.
    pub live: bool,
    /// The canonical PHF JSON.
    pub phf: String,
}

/// The outbox's state for the status line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SyncCounts {
    /// Hands waiting to be sent.
    pub outbox: u64,
    /// Of them, queued in the last minutes.
    pub live: u64,
    /// Of them, waiting for a retry after a failed send.
    pub retrying: u64,
    /// The earliest retry still in the future, ms.
    pub next_retry_at: Option<i64>,
    /// Refused hands per reason, most frequent first.
    pub rejected: Vec<(String, u64)>,
}

/// A hand the server refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub hand_key: String,
    pub reason: String,
    pub field: Option<String>,
}

/// What [`WriterHandle::import_pulled`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PulledOutcome {
    /// New hands stored.
    pub inserted: u64,
    /// Hands the store had already.
    pub present: u64,
}

fn count(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::OutOfRange("count"))
}

impl Reader {
    /// Up to `limit` hands to send now (`next_attempt_at <= now_ms`), in send
    /// order: those queued at or after `live_since_ms` newest played first,
    /// then the rest oldest due first.
    pub fn outbox_next(
        &self,
        now_ms: i64,
        live_since_ms: i64,
        limit: u32,
    ) -> Result<Vec<OutboxEntry>> {
        self.with(|conn| {
            let mut keys: Vec<(String, bool)> = Vec::new();
            {
                let mut live = conn.prepare_cached(
                    "SELECT hand_key FROM outbox INDEXED BY outbox_recent_idx
                     WHERE enqueued_at >= ?1 AND next_attempt_at <= ?2
                     ORDER BY played_at DESC, hand_key
                     LIMIT ?3",
                )?;
                let rows = live.query_map(params![live_since_ms, now_ms, limit], |row| {
                    row.get::<_, String>(0)
                })?;
                for key in rows {
                    keys.push((key?, true));
                }
            }
            let left = limit.saturating_sub(u32::try_from(keys.len()).unwrap_or(limit));
            if left > 0 {
                let mut rest = conn.prepare_cached(
                    "SELECT hand_key FROM outbox INDEXED BY outbox_due_idx
                     WHERE next_attempt_at <= ?1 AND enqueued_at < ?2
                     ORDER BY next_attempt_at, enqueued_at
                     LIMIT ?3",
                )?;
                let rows = rest.query_map(params![now_ms, live_since_ms, left], |row| {
                    row.get::<_, String>(0)
                })?;
                for key in rows {
                    keys.push((key?, false));
                }
            }
            let mut detail = conn.prepare_cached(
                "SELECT o.attempts, f.source_id, h.phf, h.phf_size
                 FROM outbox o JOIN hands h ON h.hand_key = o.hand_key
                 LEFT JOIN files f ON f.id = h.file_id
                 WHERE o.hand_key = ?1",
            )?;
            let mut entries = Vec::with_capacity(keys.len());
            for (hand_key, live) in keys {
                let row: Option<(i64, Option<i64>, Vec<u8>, i64)> = detail
                    .query_row([&hand_key], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })
                    .optional()?;
                let Some((attempts, source_id, blob, size)) = row else {
                    continue;
                };
                let size = u64::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
                entries.push(OutboxEntry {
                    hand_key,
                    source_id,
                    attempts,
                    live,
                    phf: decompress_phf(&blob, size)?,
                });
            }
            Ok(entries)
        })
    }

    /// The outbox and the refused hands, for the status line. Every count
    /// is an index range (measured at a million queued hands: see the
    /// ignored test `the_send_order_query_with_a_large_backlog`).
    pub fn sync_counts(&self, now_ms: i64, live_since_ms: i64) -> Result<SyncCounts> {
        self.with(|conn| {
            let outbox: i64 =
                conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))?;
            let live: i64 = conn.query_row(
                "SELECT count(*) FROM outbox INDEXED BY outbox_recent_idx WHERE enqueued_at >= ?1",
                [live_since_ms],
                |row| row.get(0),
            )?;
            let retrying: i64 = conn.query_row(
                "SELECT count(*) FROM outbox INDEXED BY outbox_retry_idx WHERE attempts > 0",
                [],
                |row| row.get(0),
            )?;
            let next_retry_at: Option<i64> = conn.query_row(
                "SELECT min(next_attempt_at) FROM outbox WHERE next_attempt_at > ?1",
                [now_ms],
                |row| row.get(0),
            )?;
            let mut stmt = conn.prepare_cached(
                "SELECT reason, count(*) AS n FROM sync_rejected GROUP BY reason
                 ORDER BY n DESC, reason",
            )?;
            let rejected = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .map(|row| {
                    let (reason, n) = row?;
                    Ok((reason, count(n)?))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(SyncCounts {
                outbox: count(outbox)?,
                live: count(live)?,
                retrying: count(retrying)?,
                next_retry_at,
                rejected,
            })
        })
    }

    /// Hands from this computer's files (not pulled): what uploading to
    /// another account would send. The hands minus the pulled ones, both
    /// index counts.
    pub fn local_hands(&self) -> Result<u64> {
        self.with(|conn| {
            let all: i64 = conn.query_row("SELECT count(*) FROM hands", [], |row| row.get(0))?;
            let pulled: i64 = conn.query_row(
                "SELECT count(*) FROM hands INDEXED BY hands_pulled_idx WHERE pulled_at IS NOT NULL",
                [],
                |row| row.get(0),
            )?;
            count(all - pulled)
        })
    }

    /// Hands the server refused, newest first (for a list in the UI).
    pub fn sync_rejected(&self, limit: u32) -> Result<Vec<Rejection>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT hand_key, reason, field FROM sync_rejected
                 ORDER BY rejected_at DESC, hand_key LIMIT ?1",
            )?;
            let rows = stmt.query_map([limit], |row| {
                Ok(Rejection {
                    hand_key: row.get(0)?,
                    reason: row.get(1)?,
                    field: row.get(2)?,
                })
            })?;
            Ok(rows.collect::<std::result::Result<_, _>>()?)
        })
    }

    /// Which of `keys` the store holds.
    pub fn hands_present(&self, keys: &[String]) -> Result<HashSet<String>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached("SELECT 1 FROM hands WHERE hand_key = ?1")?;
            let mut present = HashSet::new();
            for key in keys {
                if stmt.exists([key])? {
                    present.insert(key.clone());
                }
            }
            Ok(present)
        })
    }
}

impl WriterHandle {
    /// Set a `kv` value.
    pub fn set_kv(&self, key: &str, value: &str) -> Result<()> {
        let (key, value) = (key.to_owned(), value.to_owned());
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                                 updated_at = excluded.updated_at",
                params![key, value, crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// Remove a `kv` value.
    pub fn delete_kv(&self, key: &str) -> Result<()> {
        let key = key.to_owned();
        self.write(move |tx| {
            tx.execute("DELETE FROM kv WHERE key = ?1", [key])?;
            Ok(())
        })
    }

    /// The server has these hands: they leave the outbox and are marked
    /// synced. Returns how many left.
    pub fn outbox_mark_sent(&self, hand_keys: Vec<String>, at_ms: i64) -> Result<u64> {
        self.write(move |tx| {
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
    /// `next_attempt_at_ms` (the backoff is the sync worker's).
    pub fn outbox_mark_failed(
        &self,
        hand_keys: Vec<String>,
        error: &str,
        next_attempt_at_ms: i64,
    ) -> Result<()> {
        let error = error.to_owned();
        self.write(move |tx| {
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

    /// "Sync now": every hand waiting for a retry is due at `at_ms`.
    pub fn outbox_retry_now(&self, at_ms: i64) -> Result<u64> {
        self.write(move |tx| {
            let n = tx.execute(
                "UPDATE outbox SET next_attempt_at = ?1 WHERE attempts > 0 AND next_attempt_at > ?1",
                [at_ms],
            )?;
            Ok(u64::try_from(n).unwrap_or(0))
        })
    }

    /// The server refused these hands (or they cannot be sent): out of the
    /// outbox, into `sync_rejected` with their reason.
    pub fn outbox_reject(&self, rejections: Vec<Rejection>, at_ms: i64) -> Result<u64> {
        self.write(move |tx| {
            let mut delete = tx.prepare_cached("DELETE FROM outbox WHERE hand_key = ?1")?;
            let mut insert = tx.prepare_cached(
                "INSERT INTO sync_rejected (hand_key, reason, field, rejected_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (hand_key) DO UPDATE SET reason = excluded.reason,
                   field = excluded.field, rejected_at = excluded.rejected_at",
            )?;
            let mut moved = 0;
            for rejection in &rejections {
                if delete.execute([&rejection.hand_key])? == 1 {
                    insert.execute(params![
                        rejection.hand_key,
                        rejection.reason,
                        rejection.field,
                        at_ms
                    ])?;
                    moved += 1;
                }
            }
            Ok(moved)
        })
    }

    /// Queue every refused hand again (after an update that may accept
    /// them). Returns how many.
    pub fn rejected_requeue(&self, at_ms: i64) -> Result<u64> {
        self.write(move |tx| {
            let moved = tx.execute(
                "INSERT INTO outbox (hand_key, enqueued_at, next_attempt_at, played_at)
                 SELECT r.hand_key, h.imported_at, ?1, h.played_at
                 FROM sync_rejected r JOIN hands h ON h.hand_key = r.hand_key
                 WHERE true
                 ON CONFLICT (hand_key) DO NOTHING",
                [at_ms],
            )?;
            tx.execute("DELETE FROM sync_rejected", [])?;
            Ok(u64::try_from(moved).unwrap_or(0))
        })
    }

    /// Make `owner` (a JSON text, [`OWNER_KEY`]) the account this store
    /// syncs to. With `requeue`, every hand from this computer's files goes
    /// back into the outbox (in its original import order) and loses its
    /// synced mark, and the refused hands are tried again: the new account
    /// has none of them. Pulled hands (another account's library) are not
    /// queued. Returns how many hands were queued.
    pub fn sync_set_owner(&self, owner: String, requeue: bool, at_ms: i64) -> Result<u64> {
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                                 updated_at = excluded.updated_at",
                params![OWNER_KEY, owner, at_ms],
            )?;
            if !requeue {
                return Ok(0);
            }
            tx.execute("DELETE FROM sync_rejected", [])?;
            tx.execute(
                "UPDATE hands SET synced_at = NULL WHERE pulled_at IS NULL AND synced_at IS NOT NULL",
                [],
            )?;
            tx.execute(
                "UPDATE outbox SET attempts = 0, last_error = NULL, next_attempt_at = ?1",
                [at_ms],
            )?;
            let queued = tx.execute(
                "INSERT INTO outbox (hand_key, enqueued_at, next_attempt_at, played_at)
                 SELECT hand_key, imported_at, ?1, played_at FROM hands
                 WHERE pulled_at IS NULL
                 ON CONFLICT (hand_key) DO NOTHING",
                [at_ms],
            )?;
            Ok(u64::try_from(queued).unwrap_or(0))
        })
    }

    /// Store hands pulled from the server: no file, not queued for upload,
    /// already synced. Hands the store has are left as they are. `cursor` is
    /// a `kv` pair written in the same transaction, so a crash can neither
    /// store a page without moving the cursor nor move it past unstored
    /// hands.
    pub fn import_pulled(
        &self,
        hands: Vec<PreparedHand>,
        cursor: Option<(String, String)>,
        at_ms: i64,
    ) -> Result<PulledOutcome> {
        self.write(move |tx| {
            let mut insert = tx.prepare_cached(
                "INSERT INTO hands (hand_key, site, site_hand_id, played_at, game_format, variant,
                                    limit_type, currency, small_blind, big_blind, ante,
                                    table_name, max_seats, hero_seat, hero_name, schema_version,
                                    parser_id, parser_version, phf, phf_size, file_id,
                                    imported_at, synced_at, pulled_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                         ?17, ?18, ?19, ?20, NULL, ?21, ?21, ?21)
                 ON CONFLICT (hand_key) DO NOTHING",
            )?;
            let mut outcome = PulledOutcome::default();
            for hand in &hands {
                let inserted = insert.execute(params![
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
                    i64::try_from(hand.phf_size).map_err(|_| Error::OutOfRange("PHF size"))?,
                    at_ms,
                ])?;
                if inserted == 1 {
                    outcome.inserted += 1;
                } else {
                    outcome.present += 1;
                }
            }
            if let Some((key, value)) = cursor {
                tx.execute(
                    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                                     updated_at = excluded.updated_at",
                    params![key, value, at_ms],
                )?;
            }
            Ok(outcome)
        })
    }
}
