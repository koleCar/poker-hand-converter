//! Migration 21 (`migrations/0021_gg_cash_site.sql`): the plain GG cash
//! hands an older build stored under the `standard` site move to `ggpoker`.

use rail_core::parsers::standard::is_gg_cash_hand_id;
use rail_core::phf::PhfHand;
use rusqlite::{Connection, OptionalExtension, params};

use crate::batch::{PreparedHand, decompress_phf};
use crate::error::{Error, Result};

/// The tables whose rows are the user's own words on a hand: moved to the
/// kept copy rather than dropped with a duplicate.
const USER_TABLES: [&str; 2] = ["hand_notes", "hand_tags"];

/// What [`move_gg_cash_hands`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Moved {
    /// Hands given their new key.
    pub rekeyed: u64,
    /// Hands dropped because the store already had them under the new key.
    pub duplicates: u64,
}

/// Move every `standard` hand whose id is GG's cash id to the GGPoker site:
/// its PHF, `hands.site`, and its key in every table that has one. Runs in
/// the migration's transaction.
pub(crate) fn move_gg_cash_hands(conn: &Connection) -> Result<Moved> {
    let mut found: Vec<(String, Vec<u8>, i64)> = Vec::new();
    {
        let mut read = conn.prepare(
            "SELECT hand_key, site_hand_id, phf, phf_size FROM hands
              WHERE site = 'standard' AND site_hand_id GLOB 'HD[0-9]*'",
        )?;
        let mut rows = read.query([])?;
        while let Some(row) = rows.next()? {
            let site_hand_id: String = row.get(1)?;
            if is_gg_cash_hand_id(&site_hand_id) {
                found.push((row.get(0)?, row.get(2)?, row.get(3)?));
            }
        }
    }
    let mut moved = Moved::default();
    if found.is_empty() {
        return Ok(moved);
    }

    // `hands.hand_key` is referenced without ON UPDATE: the children are
    // moved one by one, and the keys agree again by the commit.
    conn.pragma_update(None, "defer_foreign_keys", true)?;
    let tables = hand_key_tables(conn)?;
    for (old_key, blob, size) in found {
        let size = u64::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
        let json = decompress_phf(&blob, size)?;
        let mut hand: PhfHand = serde_json::from_str(&json)
            .map_err(|error| Error::Corrupt(format!("PHF of {old_key}: {error}")))?;
        "ggpoker".clone_into(&mut hand.meta.site_id);
        "GGPoker".clone_into(&mut hand.meta.site_name);
        let prepared = PreparedHand::from_phf(&hand)?;
        let new_key = prepared.hand_key.as_str();
        let duplicate = conn
            .query_row("SELECT 1 FROM hands WHERE hand_key = ?1", [new_key], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        for table in &tables {
            let user = USER_TABLES.contains(&table.as_str());
            if !duplicate || user {
                conn.execute(
                    &format!("UPDATE OR IGNORE {table} SET hand_key = ?2 WHERE hand_key = ?1"),
                    params![old_key, new_key],
                )?;
            }
            conn.execute(
                &format!("DELETE FROM {table} WHERE hand_key = ?1"),
                [&old_key],
            )?;
        }
        if duplicate {
            // The file that delivered it counts one hand fewer (the folder's
            // totals follow by trigger).
            conn.execute(
                "UPDATE files SET hands = hands - 1
                  WHERE id = (SELECT file_id FROM hands WHERE hand_key = ?1)",
                [&old_key],
            )?;
            conn.execute("DELETE FROM hands WHERE hand_key = ?1", [&old_key])?;
            moved.duplicates += 1;
        } else {
            let phf_size =
                i64::try_from(prepared.phf_size).map_err(|_| Error::OutOfRange("PHF size"))?;
            conn.execute(
                "UPDATE hands SET hand_key = ?2, site = ?3, phf = ?4, phf_size = ?5
                  WHERE hand_key = ?1",
                params![old_key, new_key, prepared.site, prepared.phf_zstd, phf_size],
            )?;
            moved.rekeyed += 1;
        }
    }

    // `files.site` is the parser that read the file (still `standard`), not
    // the room: left as a fresh import writes it.
    //
    // Every derived row of a moved hand is rebuilt from its PHF: forget the
    // statistics version, and restart a rows job an older build left running
    // (it has passed hands under their old site).
    conn.execute(
        "DELETE FROM kv WHERE key IN (?1, 'recompute.rows.target')",
        [crate::stats::KV_VERSION],
    )?;
    log::info!(
        "migration 21: {} GG cash hands moved from standard to ggpoker, {} duplicates dropped",
        moved.rekeyed,
        moved.duplicates
    );
    Ok(moved)
}

/// Every table but `hands` with a `hand_key` column, in a fixed order.
fn hand_key_tables(conn: &Connection) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p
          WHERE m.type = 'table' AND p.name = 'hand_key' AND m.name <> 'hands'
          ORDER BY m.name",
    )?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}
