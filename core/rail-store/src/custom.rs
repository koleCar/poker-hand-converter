//! The user's own statistics (docs/RAIL-PLAN.md R2.10; tables in
//! `SCHEMA.md` "Custom statistics", migration 11).
//!
//! - **Definitions** live here, in the user's store, not in `config/stats/`:
//!   [`save_custom_stat`], [`delete_custom_stat`], [`Reader::custom_stats`].
//!   The store keeps what the app validated (`rail_stats::custom::CustomSet`
//!   is the validator); a definition this build cannot compile any more is
//!   skipped by the pass and reported by the app.
//! - **Counting** is the background pass's ([`custom_step`], run by
//!   [`crate::StatsWorker`] after the rebuild and the players' index, before
//!   the EV queue): the next [`CUSTOM_PAGE`] hands in `hand_stats` id order
//!   past the lowest `counted_to`, each read back from its stored PHF, its
//!   decision events built once (`rail_stats::events::hand_events`) and
//!   every statistic whose `counted_to` is below the hand counted on the
//!   seats the store keeps. Imports only wake the pass: the import's writer
//!   and threads do no more work per hand than before (measured: building
//!   the events and evaluating 57 counters costs ~14 µs a hand, cheap on
//!   the import threads, but the writes - a row and rollup increments per
//!   statistic and kept seat - would land in the writer, the import's
//!   bottleneck; see docs/RAIL-PLAN.md R2.10 *As built*). A new hand is
//!   counted within a step of its commit when nothing else is queued.
//! - **Sums** as the coded statistics have them: the hero's per hand
//!   (`custom_hero_rows`) and per (segment, position, day, kind), every
//!   kept seat's per (site, player, scope, segment) with bomb pots left out.
//!   [`Reader::custom_hero_totals`] answers a report's filter (whole days
//!   from the rollup, the partial days from the rows, `aggregate`'s
//!   exclusions by kind) and [`Reader::custom_player_totals`] the HUD's.
//! - **Resets**: a statistic's predicate changed - its counts go and it is
//!   counted again; `rail_stats::custom::EVENTS_VERSION` changes, or a
//!   recompute of the coded statistics moves a hand's seats between rollup
//!   keys (R2.11, [`crate::recompute`]: its segment, kind or day, or a seat's
//!   player, scope or position) - every statistic's counts go
//!   ([`reset_custom_counts`]). Any other recompute leaves them: a hand
//!   keeps its `hand_stats.id`, and the counts are made from the decision
//!   events and the kept seats, which it did not change. While a recompute
//!   runs that will reset them, the pass waits.

use std::collections::{BTreeMap, HashMap};

use rail_stats::custom::{CustomCounter, CustomDef};
use rail_stats::events::hand_events;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::background::hand_from;
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::recompute::custom_on_hold;
use crate::stats::{Exclusions, current_gen, day_of, kv_get, kv_set};
use crate::stats_read::{HeroFilter, bound, day_ranges, in_list, kind_from};

/// Hands per step of the custom pass.
pub const CUSTOM_PAGE: u32 = 1000;

/// `kv`: the `EVENTS_VERSION` the stored counts were made under.
pub const KV_EVENTS_VERSION: &str = "custom.events_version";

/// One saved statistic.
#[derive(Debug, Clone, PartialEq)]
pub struct CustomStatRow {
    /// Never reused.
    pub id: i64,
    /// Changes when the predicate does.
    pub rev: i64,
    pub def: CustomDef,
    /// The `hand_stats.id` its counter is counted up to.
    pub counted_to: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Counts summed: `(made, opportunities)`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CustomCounts {
    pub made: i64,
    pub opp: i64,
}

impl CustomCounts {
    fn add(&mut self, made: i64, opp: i64) {
        self.made += made;
        self.opp += opp;
    }
}

/// How far the pass is with one statistic's counter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomProgress {
    pub id: i64,
    pub key: String,
    /// Hands not counted yet.
    pub remaining: u64,
    /// Hands in the store.
    pub total: u64,
}

fn json_error(error: serde_json::Error) -> Error {
    Error::Corrupt(format!("custom statistic: {error}"))
}

/* --------------------------------------------------------------- writes - */

fn clear_counts(conn: &Connection, id: i64) -> Result<()> {
    for table in [
        "custom_hero_rows",
        "custom_hero_rollups",
        "custom_player_rollups",
    ] {
        conn.execute(&format!("DELETE FROM {table} WHERE stat_id = ?1"), [id])?;
    }
    Ok(())
}

/// Save a statistic: new, or replacing the one saved as `replacing` (its
/// old id; a rename keeps its counts). A changed predicate clears its counts
/// and starts its count again. Returns its row id. The caller validated it.
pub fn save_custom_stat(
    conn: &Connection,
    replacing: Option<&str>,
    def: &CustomDef,
    now_ms: i64,
) -> Result<i64> {
    let definition = serde_json::to_string(&def.def).map_err(json_error)?;
    let existing: Option<(i64, Option<String>)> = match replacing {
        None => None,
        Some(key) => conn
            .query_row(
                "SELECT id, predicate FROM custom_stats WHERE stat_key = ?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
    };
    match existing {
        Some((id, predicate)) => {
            let recount = predicate != def.predicate;
            conn.execute(
                "UPDATE custom_stats SET stat_key = ?2, definition = ?3, predicate = ?4,
                   updated_at = ?5,
                   rev = rev + ?6,
                   counted_to = CASE WHEN ?6 THEN 0 ELSE counted_to END
                 WHERE id = ?1",
                params![id, def.def.id, definition, def.predicate, now_ms, recount],
            )?;
            if recount {
                clear_counts(conn, id)?;
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO custom_stats (stat_key, rev, definition, predicate, ord, counted_to,
                   created_at, updated_at)
                 VALUES (?1, 1, ?2, ?3,
                   (SELECT coalesce(max(ord), 0) + 1 FROM custom_stats), 0, ?4, ?4)",
                params![def.def.id, definition, def.predicate, now_ms],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

/// Delete a statistic and its counts. Returns whether it existed.
pub fn delete_custom_stat(conn: &Connection, key: &str) -> Result<bool> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM custom_stats WHERE stat_key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(false);
    };
    clear_counts(conn, id)?;
    conn.execute("DELETE FROM custom_stats WHERE id = ?1", [id])?;
    Ok(true)
}

/// Every statistic's counts gone and counted again from the first hand
/// (an `EVENTS_VERSION` change; a recompute that moved a hand's seats
/// between rollup keys, R2.11).
pub fn reset_custom_counts(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM custom_hero_rows", [])?;
    conn.execute("DELETE FROM custom_hero_rollups", [])?;
    conn.execute("DELETE FROM custom_player_rollups", [])?;
    conn.execute("UPDATE custom_stats SET counted_to = 0", [])?;
    kv_set(conn, KV_EVENTS_VERSION, rail_stats::custom::EVENTS_VERSION)?;
    Ok(())
}

/// On open: counts made under another `EVENTS_VERSION` are counted again.
pub(crate) fn ensure_events_version(conn: &Connection) -> Result<()> {
    if kv_get(conn, KV_EVENTS_VERSION)?.as_deref() != Some(rail_stats::custom::EVENTS_VERSION) {
        reset_custom_counts(conn)?;
    }
    Ok(())
}

/* ------------------------------------------------------------- the pass - */

/// One statistic a page counts for.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PageStat {
    id: i64,
    rev: i64,
    counted_to: i64,
}

/// One page of the custom pass, computed on the pass's thread.
#[derive(Debug, Default)]
pub struct CustomPage {
    generation: i64,
    /// The last `hand_stats.id` of the page.
    last: i64,
    /// Hands in the page.
    hands: usize,
    stats: Vec<PageStat>,
    /// (stat, hand) -> counts, the hero's.
    hero_rows: Vec<(i64, i64, i64, i64)>,
    /// (stat, segment, position, day, kind).
    heroes: HashMap<(i64, i64, String, String, i64), CustomCounts>,
    /// (stat, site, player, scope, segment).
    players: HashMap<(i64, String, String, String, i64), CustomCounts>,
}

struct PageHand {
    id: i64,
    hand_key: String,
    segment_id: i64,
    site: String,
    played_at: Option<String>,
    kind: i64,
    phf: Vec<u8>,
    phf_size: i64,
}

struct KeptSeat {
    seat: u32,
    player: String,
    scope: String,
    is_hero: bool,
    position: String,
}

/// Compute the next page, if any statistic has hands left to count (and no
/// recompute of the coded statistics is running that will reset the counts
/// when it swaps, R2.11).
pub fn custom_page(reader: &Reader) -> Result<Option<CustomPage>> {
    let read = reader.with(|conn| {
        if custom_on_hold(conn)? {
            return Ok(None);
        }
        let generation = current_gen(conn)?;
        let mut stmt = conn.prepare_cached(
            "SELECT id, rev, predicate, counted_to FROM custom_stats
             WHERE predicate IS NOT NULL ORDER BY id",
        )?;
        let mut stats: Vec<(PageStat, CustomCounter)> = Vec::new();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let text: String = row.get(2)?;
            match CustomCounter::parse(&text) {
                Ok(counter) => stats.push((
                    PageStat {
                        id: row.get(0)?,
                        rev: row.get(1)?,
                        counted_to: row.get(3)?,
                    },
                    counter,
                )),
                // Saved by a build whose fields this one does not have.
                Err(error) => log::warn!("custom statistic {}: {error}", row.get::<_, i64>(0)?),
            }
        }
        let Some(low) = stats.iter().map(|(stat, _)| stat.counted_to).min() else {
            return Ok(None);
        };
        let mut stmt = conn.prepare_cached(
            "SELECT d.id, d.hand_key, d.segment_id, s.site, d.played_at,
                    d.is_bomb_pot, d.has_straddle, d.has_cashout, h.phf, h.phf_size
             FROM hand_stats d
             JOIN segments s ON s.id = d.segment_id
             JOIN hands h ON h.hand_key = d.hand_key
             WHERE d.id > ?1 ORDER BY d.id LIMIT ?2",
        )?;
        let hands = stmt
            .query_map(params![low, CUSTOM_PAGE], |row| {
                Ok(PageHand {
                    id: row.get(0)?,
                    hand_key: row.get(1)?,
                    segment_id: row.get(2)?,
                    site: row.get(3)?,
                    played_at: row.get(4)?,
                    kind: kind_from(row, 5)?,
                    phf: row.get(8)?,
                    phf_size: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some(last) = hands.last().map(|hand| hand.id) else {
            return Ok(None);
        };
        let mut seats: HashMap<i64, Vec<KeptSeat>> = HashMap::new();
        let mut stmt = conn.prepare_cached(
            "SELECT hand_id, seat, player, scope, is_hero, coalesce(position, '')
             FROM seat_stats WHERE hand_id > ?1 AND hand_id <= ?2",
        )?;
        let mut rows = stmt.query(params![low, last])?;
        while let Some(row) = rows.next()? {
            seats.entry(row.get(0)?).or_default().push(KeptSeat {
                seat: row.get(1)?,
                player: row.get(2)?,
                scope: row.get(3)?,
                is_hero: row.get(4)?,
                position: row.get(5)?,
            });
        }
        Ok(Some((generation, stats, hands, seats, last)))
    })?;
    let Some((generation, stats, hands, seats, last)) = read else {
        return Ok(None);
    };

    let mut page = CustomPage {
        generation,
        last,
        hands: hands.len(),
        stats: stats.iter().map(|(stat, _)| stat.clone()).collect(),
        ..CustomPage::default()
    };
    for hand in hands {
        let wanted: Vec<&(PageStat, CustomCounter)> = stats
            .iter()
            .filter(|(stat, _)| stat.counted_to < hand.id)
            .collect();
        let Some(kept) = seats.get(&hand.id) else {
            continue;
        };
        if wanted.is_empty() {
            continue;
        }
        let phf = match hand_from(&hand.phf, hand.phf_size) {
            Ok(phf) => phf,
            Err(error) => {
                log::warn!("custom statistics: {}: {error}", hand.hand_key);
                continue;
            }
        };
        let events = hand_events(&phf);
        let day = day_of(hand.played_at.as_deref()).to_owned();
        // The HUD's sums: `aggregate`'s defaults (bomb pots out).
        let counted = Exclusions::default().admits(hand.kind).0;
        for seat in kept {
            let Some(seat_events) = events.seats.iter().find(|s| s.seat == seat.seat) else {
                continue;
            };
            for (stat, counter) in &wanted {
                let counts = counter.count(&events, seat_events);
                if counts.opp == 0 && counts.made == 0 {
                    continue;
                }
                let (made, opp) = (i64::from(counts.made), i64::from(counts.opp));
                if seat.is_hero {
                    page.hero_rows.push((stat.id, hand.id, made, opp));
                    page.heroes
                        .entry((
                            stat.id,
                            hand.segment_id,
                            seat.position.clone(),
                            day.clone(),
                            hand.kind,
                        ))
                        .or_default()
                        .add(made, opp);
                }
                if counted {
                    page.players
                        .entry((
                            stat.id,
                            hand.site.clone(),
                            seat.player.clone(),
                            seat.scope.clone(),
                            hand.segment_id,
                        ))
                        .or_default()
                        .add(made, opp);
                }
            }
        }
    }
    Ok(Some(page))
}

/// Write a page: for each statistic still as it was when the page was read
/// (same `rev`, same `counted_to`, the same generation of the coded
/// statistics and no recompute running that will reset the counts), its
/// counts, and its `counted_to` moved to the page's end. Returns the
/// statistics it counted for.
pub fn apply_custom_page(conn: &Connection, page: &CustomPage) -> Result<usize> {
    if custom_on_hold(conn)? || current_gen(conn)? != page.generation {
        return Ok(0);
    }
    let mut valid: Vec<i64> = Vec::new();
    for stat in &page.stats {
        let now: Option<(i64, i64)> = conn
            .prepare_cached("SELECT rev, counted_to FROM custom_stats WHERE id = ?1")?
            .query_row([stat.id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        if now == Some((stat.rev, stat.counted_to)) && stat.counted_to < page.last {
            valid.push(stat.id);
        }
    }
    if valid.is_empty() {
        return Ok(0);
    }
    let mut insert = conn.prepare_cached(
        "INSERT INTO custom_hero_rows (stat_id, hand_id, made, opp) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for &(stat, hand, made, opp) in &page.hero_rows {
        if valid.contains(&stat) {
            insert.execute(params![stat, hand, made, opp])?;
        }
    }
    let mut upsert = conn.prepare_cached(
        "INSERT INTO custom_hero_rollups (stat_id, segment_id, position, day, kind, made, opp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (stat_id, segment_id, position, day, kind)
         DO UPDATE SET made = made + excluded.made, opp = opp + excluded.opp",
    )?;
    for ((stat, segment, position, day, kind), counts) in &page.heroes {
        if valid.contains(stat) {
            upsert.execute(params![
                stat,
                segment,
                position,
                day,
                kind,
                counts.made,
                counts.opp
            ])?;
        }
    }
    let mut upsert = conn.prepare_cached(
        "INSERT INTO custom_player_rollups (stat_id, site, player, scope, segment_id, made, opp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (stat_id, site, player, scope, segment_id)
         DO UPDATE SET made = made + excluded.made, opp = opp + excluded.opp",
    )?;
    for ((stat, site, player, scope, segment), counts) in &page.players {
        if valid.contains(stat) {
            upsert.execute(params![
                stat,
                site,
                player,
                scope,
                segment,
                counts.made,
                counts.opp
            ])?;
        }
    }
    let mut mark = conn.prepare_cached("UPDATE custom_stats SET counted_to = ?2 WHERE id = ?1")?;
    for id in &valid {
        mark.execute(params![id, page.last])?;
    }
    Ok(valid.len())
}

/// One step of the custom pass: a page computed and written. `None`:
/// nothing to count.
pub fn custom_step(reader: &Reader, writer: &crate::WriterHandle) -> Result<Option<usize>> {
    let Some(page) = custom_page(reader)? else {
        return Ok(None);
    };
    let hands = page.hands;
    // A stale page (a statistic changed meanwhile) counts nothing and is
    // read again on the next step.
    let applied = writer.write(move |tx| apply_custom_page(tx, &page))?;
    Ok(Some(if applied > 0 { hands } else { 0 }))
}

/* ---------------------------------------------------------------- reads - */

/// A `custom_stats` row as read: id, rev, definition, predicate,
/// counted_to, created_at, updated_at.
type StatColumns = (i64, i64, String, Option<String>, i64, i64, i64);

fn stat_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<StatColumns> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

impl Reader {
    /// Every saved statistic, in the user's order.
    pub fn custom_stats(&self) -> Result<Vec<CustomStatRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id, rev, definition, predicate, counted_to, created_at, updated_at
                 FROM custom_stats ORDER BY ord, id",
            )?;
            let rows = stmt
                .query_map([], stat_from)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter()
                .map(
                    |(id, rev, definition, predicate, counted_to, created_at, updated_at)| {
                        Ok(CustomStatRow {
                            id,
                            rev,
                            def: CustomDef {
                                def: serde_json::from_str(&definition).map_err(json_error)?,
                                predicate,
                            },
                            counted_to,
                            created_at,
                            updated_at,
                        })
                    },
                )
                .collect()
        })
    }

    /// The hero's `limit` most recent hands (by `played_at`, undated ones
    /// last), read back from their stored PHF: what the editor previews a
    /// counter on while the user types (R2.10). A hand whose PHF cannot be
    /// read back is skipped.
    pub fn recent_hero_hands(&self, limit: u32) -> Result<Vec<rail_core::phf::PhfHand>> {
        let rows = self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT d.hand_key, h.phf, h.phf_size
                 FROM hand_stats d INDEXED BY hand_stats_played_idx
                 CROSS JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
                 CROSS JOIN hands h ON h.hand_key = d.hand_key
                 ORDER BY d.played_at DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map([limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        Ok(rows
            .into_iter()
            .filter_map(|(hand_key, blob, size)| match hand_from(&blob, size) {
                Ok(hand) => Some(hand),
                Err(error) => {
                    log::warn!("custom statistics preview: {hand_key}: {error}");
                    None
                }
            })
            .collect())
    }

    /// How far the pass is with each statistic that has a counter.
    pub fn custom_progress(&self) -> Result<Vec<CustomProgress>> {
        self.with(|conn| {
            let total: i64 =
                conn.query_row("SELECT count(*) FROM hand_stats", [], |row| row.get(0))?;
            let mut stmt = conn.prepare_cached(
                "SELECT c.id, c.stat_key,
                        (SELECT count(*) FROM hand_stats d WHERE d.id > c.counted_to)
                 FROM custom_stats c WHERE c.predicate IS NOT NULL ORDER BY c.ord, c.id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(CustomProgress {
                        id: row.get(0)?,
                        key: row.get(1)?,
                        remaining: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                        total: u64::try_from(total).unwrap_or(0),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// The hero's counts of statistics `ids` over `filter` (the same hands
    /// [`Reader::hero_totals`] sums: whole days from the rollup, partial
    /// days from the rows, `aggregate`'s exclusions by kind).
    pub fn custom_hero_totals(
        &self,
        filter: &HeroFilter,
        ids: &[i64],
    ) -> Result<BTreeMap<i64, CustomCounts>> {
        let mut out: BTreeMap<i64, CustomCounts> = BTreeMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let ranges = day_ranges(filter.from.as_deref(), filter.to.as_deref())?;
        let exclusions = filter.exclusions;
        let ids_list = || Some(ids.iter().map(|&id| Value::Integer(id)).collect());
        let segments = || {
            filter
                .segments
                .as_ref()
                .map(|ids| ids.iter().map(|&id| Value::Integer(id)).collect())
        };
        let positions = || {
            filter
                .positions
                .as_ref()
                .map(|list| list.iter().map(|p| Value::Text(p.clone())).collect())
        };
        self.with(|conn| {
            let generation = current_gen(conn)?;
            if !ranges.no_days {
                let mut params: Vec<Value> = Vec::new();
                let mut sql = "SELECT stat_id, kind, sum(made), sum(opp)
                               FROM custom_hero_rollups WHERE 1"
                    .to_owned();
                sql += &in_list("stat_id", ids_list(), &mut params);
                sql += &in_list("segment_id", segments(), &mut params);
                sql += &in_list("position", positions(), &mut params);
                if let Some(lo) = &ranges.lo {
                    sql += &bound("day", ">", lo, &mut params);
                }
                if let Some(hi) = &ranges.hi {
                    sql += &bound("day", "<", hi, &mut params);
                }
                sql += " GROUP BY stat_id, kind";
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows = stmt.query(params_from_iter(params))?;
                while let Some(row) = rows.next()? {
                    if exclusions.admits(row.get(1)?).0 {
                        out.entry(row.get(0)?)
                            .or_default()
                            .add(row.get(2)?, row.get(3)?);
                    }
                }
            }
            for (lo, hi) in &ranges.edges {
                let mut params: Vec<Value> = vec![Value::Integer(generation)];
                let mut sql = "SELECT c.stat_id, d.is_bomb_pot, d.has_straddle, d.has_cashout,
                                      c.made, c.opp
                               FROM hand_stats d INDEXED BY hand_stats_played_idx
                               CROSS JOIN seat_stats s ON s.hand_id = d.id AND s.is_hero = 1
                               CROSS JOIN custom_hero_rows c ON c.hand_id = d.id
                               WHERE d.gen = ?1"
                    .to_owned();
                sql += &bound("d.played_at", ">=", lo, &mut params);
                sql += &bound("d.played_at", "<", hi, &mut params);
                sql += &in_list("d.segment_id", segments(), &mut params);
                sql += &in_list("coalesce(s.position, '')", positions(), &mut params);
                sql += &in_list("c.stat_id", ids_list(), &mut params);
                let mut stmt = conn.prepare_cached(&sql)?;
                let mut rows = stmt.query(params_from_iter(params))?;
                while let Some(row) = rows.next()? {
                    if exclusions.admits(kind_from(row, 1)?).0 {
                        out.entry(row.get(0)?)
                            .or_default()
                            .add(row.get(4)?, row.get(5)?);
                    }
                }
            }
            Ok(out)
        })
    }

    /// One player's counts of statistics `ids` (bomb pots left out), over
    /// the segments `segments` (`None`: every segment of the site) - the
    /// HUD's lookup for a user's statistic (R3.9).
    pub fn custom_player_totals(
        &self,
        site: &str,
        player: &str,
        scope: &str,
        segments: Option<&[i64]>,
        ids: &[i64],
    ) -> Result<BTreeMap<i64, CustomCounts>> {
        let mut out: BTreeMap<i64, CustomCounts> = BTreeMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT segment_id, made, opp FROM custom_player_rollups
                 WHERE stat_id = ?1 AND site = ?2 AND player = ?3 AND scope = ?4",
            )?;
            for &id in ids {
                let mut rows = stmt.query(params![id, site, player, scope])?;
                while let Some(row) = rows.next()? {
                    let segment: i64 = row.get(0)?;
                    if segments.is_none_or(|wanted| wanted.contains(&segment)) {
                        out.entry(id).or_default().add(row.get(1)?, row.get(2)?);
                    }
                }
            }
            Ok(out)
        })
    }
}
