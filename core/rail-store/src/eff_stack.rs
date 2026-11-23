//! The hero's effective stack on the Hands list (docs/ANALYTICS.md Step 11,
//! schema 29): `hand_list.eff_stack_tenths`, the Effective stack filter's
//! column. New rows get it where they are written ([`crate::facts::derive`]);
//! the rows stored before schema 29 are filled here, a page at a time, by
//! the background pass ([`crate::background::Step::Stacked`]).
//!
//! The pass walks the list in its key order (`played_at`, `hand_key`) from
//! `kv` [`KV_AFTER`]: '' at the start, the last key filled, `done` at the
//! end. Idempotent: a page filled twice writes the same numbers.

use rusqlite::params;

use crate::background::hand_from;
use crate::error::Result;
use crate::read::Reader;
use crate::writer::WriterHandle;

/// Where the fill has got to.
pub const KV_AFTER: &str = "eff_stack.after";

/// What [`KV_AFTER`] holds once every row is filled.
pub const DONE: &str = "done";

/// Rows per page.
const PAGE: i64 = 500;

/// The separator of `played_at` and `hand_key` in [`KV_AFTER`].
const SEP: char = '\t';

/// One page of the fill: the rows filled, `None` when there is nothing left.
pub fn backfill_step(reader: &Reader, writer: &WriterHandle) -> Result<Option<usize>> {
    let after = reader.kv(KV_AFTER)?;
    // No key: a store that never needed the fill (or a finished one).
    let Some(after) = after.filter(|after| after != DONE) else {
        return Ok(None);
    };
    let (played_at, hand_key) = after.split_once(SEP).unwrap_or(("", ""));
    let start = after.is_empty();
    type Page = Vec<(String, String, Option<Vec<u8>>, Option<i64>)>;
    let page: Page = reader.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT l.played_at, l.hand_key, h.phf, h.phf_size
             FROM hand_list l LEFT JOIN hands h ON h.hand_key = l.hand_key
             WHERE ?1 OR (l.played_at, l.hand_key) > (?2, ?3)
             ORDER BY l.played_at, l.hand_key LIMIT ?4",
        )?;
        Ok(stmt
            .query_map(params![start, played_at, hand_key, PAGE], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Page>>()?)
    })?;
    let n = page.len();
    let filled: Vec<(String, String, Option<i64>)> = page
        .into_iter()
        .map(|(played_at, hand_key, blob, size)| {
            let tenths = match (blob, size) {
                (Some(blob), Some(size)) => match hand_from(&blob, size) {
                    // The writer's own derivation (its hero is the kept
                    // rows' one), so a filled row equals a written one.
                    Ok(hand) => {
                        crate::batch::PreparedStats::from_phf(&hand)
                            .list
                            .extras
                            .eff_stack_tenths
                    }
                    Err(error) => {
                        log::warn!("effective stack of {hand_key}: {error}; left empty");
                        None
                    }
                },
                _ => None,
            };
            (played_at, hand_key, tenths)
        })
        .collect();
    let next = if i64::try_from(n).unwrap_or(i64::MAX) < PAGE {
        DONE.to_owned()
    } else {
        filled
            .last()
            .map_or_else(|| DONE.to_owned(), |(p, k, _)| format!("{p}{SEP}{k}"))
    };
    writer.write(move |tx| {
        let mut update = tx.prepare_cached(
            "UPDATE hand_list SET eff_stack_tenths = ?3 WHERE played_at = ?1 AND hand_key = ?2",
        )?;
        for (played_at, hand_key, tenths) in &filled {
            if tenths.is_some() {
                update.execute(params![played_at, hand_key, tenths])?;
            }
        }
        tx.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                             updated_at = excluded.updated_at",
            params![KV_AFTER, next, crate::time::now_ms()],
        )?;
        Ok(())
    })?;
    Ok(Some(n))
}
