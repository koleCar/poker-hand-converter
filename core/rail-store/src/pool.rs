//! The Analytics Pool tab (docs/ANALYTICS.md Step 10; tables in `SCHEMA.md`
//! "The Pool tab", migration 28): how the hero's opponents play the
//! catalogue's rates, by Rail's player types, against the hero's targets.
//!
//! - **Rates**: the catalogue's rates are installed as custom statistics
//!   `an_<id>` ([`install_analytics_stats`], on open): the custom pass
//!   ([`crate::custom`]) counts them on every kept seat into
//!   `custom_player_rollups`, the hero's rows left out. They never show in
//!   the user's own list.
//! - **Results**: what that pass cannot count - each opponent's result and
//!   its square, so the regs' win rate has a measured standard error - is
//!   this module's own background step ([`pool_step`]): the seat rows of
//!   hands the hero played, summed per `player_rollups` key into
//!   `pool_player_results` (bomb pots and money-less hands out). Its mark is
//!   `kv` `pool.counted_to`; it is reset with the custom counts and takes a
//!   deleted hand's part out ([`uncount_pool`]).
//! - **Reads**: [`Reader::pool_sums`] types every opponent by the rule the
//!   Hands filter's "vs type" uses (`hand_list.rs`: `player_rollups`, scope
//!   '', every segment; fish VPIP ≥ 40, reg VPIP 15–30 and PFR ≥ 0.6·VPIP,
//!   30+ hands) and sums each type's results and rates over the hands they
//!   played with the hero (`custom_player_rollups` − `_observed`).

use std::collections::{BTreeMap, HashMap};

use rail_stats::analytics::{MEMBERSHIP_VERSION, catalogue};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use crate::custom::{delete_custom_stat, is_analytics_key, save_custom_stat};
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::recompute::custom_on_hold;
use crate::stats::{Exclusions, current_gen, decode_seat, kv_i64, kv_set};
use crate::stats_read::kind_from;

/// Hands per step of the pool pass (seat rows decoded, no PHF read).
pub const POOL_PAGE: u32 = 5000;

/// `kv`: the `hand_stats.id` the pool pass has summed up to.
pub const KV_POOL_COUNTED: &str = "pool.counted_to";

/* ------------------------------------------------------------ install - */

/// Bring the `an_<id>` custom statistics in line with the catalogue this
/// build ships: a missing rate added, one whose definition changed saved
/// again (a changed predicate is counted again), one the catalogue no longer
/// has deleted with its counts. Returns how many rows changed.
pub fn install_analytics_stats(conn: &Connection) -> Result<usize> {
    let defs = catalogue().custom_defs();
    let mut stored: BTreeMap<String, (Option<String>, String)> = BTreeMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT stat_key, predicate, definition FROM custom_stats
             WHERE substr(stat_key, 1, 3) = 'an_'",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            stored.insert(row.get(0)?, (row.get(1)?, row.get(2)?));
        }
    }
    let now = crate::time::now_ms();
    let mut changed = 0;
    for def in &defs {
        let key = def.def.id.as_str();
        let definition = serde_json::to_string(&def.def)
            .map_err(|error| Error::Corrupt(format!("analytics statistic: {error}")))?;
        match stored.remove(key) {
            Some((predicate, saved)) if predicate == def.predicate && saved == definition => {}
            Some(_) => {
                save_custom_stat(conn, Some(key), def, now)?;
                changed += 1;
            }
            None => {
                save_custom_stat(conn, None, def, now)?;
                changed += 1;
            }
        }
    }
    for key in stored.keys() {
        if is_analytics_key(key) {
            delete_custom_stat(conn, key)?;
            changed += 1;
        }
    }
    Ok(changed)
}

/* --------------------------------------------------------- the results - */

/// (site, player, scope, segment).
type Key = (String, String, String, i64);

/// Summed results of one key.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Results {
    hands: i64,
    net_bb_milli: i64,
    /// Σ (result in bb)², in thousandths of a bb², each hand's rounded.
    net_bb_sq_milli: i64,
    hero_hands: i64,
}

impl Results {
    fn add_seat(&mut self, net_bb_milli: i64, sign: i64) {
        self.hands += sign;
        self.net_bb_milli += sign * net_bb_milli;
        self.net_bb_sq_milli += sign * square_milli(net_bb_milli);
    }
}

/// A result's square in thousandths of a bb² (`x` in thousandths of a bb):
/// x² / 1000, rounded half away from zero; saturated far past any stack.
fn square_milli(x: i64) -> i64 {
    let square = i128::from(x) * i128::from(x);
    i64::try_from((square + 500) / 1000).unwrap_or(i64::MAX)
}

struct SeatRow {
    hand_id: i64,
    player: String,
    scope: String,
    is_hero: bool,
    totals: Vec<u8>,
}

struct HandRow {
    id: i64,
    segment_id: i64,
    site: String,
    kind: i64,
}

/// Sum the seats of `hands` into `out` (`sign` 1 to count, -1 to take out):
/// hands without a hero seat, bomb pots and hands whose money does not
/// count are left out.
fn sum_hands(
    hands: &[HandRow],
    seats: &HashMap<i64, Vec<SeatRow>>,
    sign: i64,
    out: &mut HashMap<Key, Results>,
) -> Result<()> {
    for hand in hands {
        let (_, money) = Exclusions::default().admits(hand.kind);
        if !money {
            continue;
        }
        let Some(rows) = seats.get(&hand.id) else {
            continue;
        };
        if !rows.iter().any(|seat| seat.is_hero) {
            continue;
        }
        for seat in rows {
            let key = (
                hand.site.clone(),
                seat.player.clone(),
                seat.scope.clone(),
                hand.segment_id,
            );
            let entry = out.entry(key).or_default();
            if seat.is_hero {
                entry.hero_hands += sign;
            } else {
                entry.add_seat(decode_seat(&seat.totals)?.net_bb_milli(), sign);
            }
        }
    }
    Ok(())
}

fn read_seats(
    stmt: &mut rusqlite::CachedStatement<'_>,
    p: impl rusqlite::Params,
) -> Result<HashMap<i64, Vec<SeatRow>>> {
    let mut seats: HashMap<i64, Vec<SeatRow>> = HashMap::new();
    let mut rows = stmt.query(p)?;
    while let Some(row) = rows.next()? {
        let seat = SeatRow {
            hand_id: row.get(0)?,
            player: row.get(1)?,
            scope: row.get(2)?,
            is_hero: row.get(3)?,
            totals: row.get(4)?,
        };
        seats.entry(seat.hand_id).or_default().push(seat);
    }
    Ok(seats)
}

fn hand_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HandRow> {
    Ok(HandRow {
        id: row.get(0)?,
        segment_id: row.get(1)?,
        site: row.get(2)?,
        kind: kind_from(row, 3)?,
    })
}

/// One page of the pool pass, read on the pass's thread.
#[derive(Debug, Default)]
pub struct PoolPage {
    generation: i64,
    from: i64,
    last: i64,
    hands: usize,
    sums: HashMap<Key, Results>,
}

/// Read and sum the next page, if any hand is past the mark (and no
/// recompute that will reset the counts is running).
pub fn pool_page(reader: &Reader) -> Result<Option<PoolPage>> {
    reader.with(|conn| {
        if custom_on_hold(conn)? {
            return Ok(None);
        }
        let generation = current_gen(conn)?;
        let from = kv_i64(conn, KV_POOL_COUNTED)?.unwrap_or(0);
        let hands = conn
            .prepare_cached(
                "SELECT d.id, d.segment_id, s.site, d.is_bomb_pot, d.has_straddle, d.has_cashout
                 FROM hand_stats d JOIN segments s ON s.id = d.segment_id
                 WHERE d.id > ?1 ORDER BY d.id LIMIT ?2",
            )?
            .query_map(params![from, POOL_PAGE], hand_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some(last) = hands.last().map(|hand| hand.id) else {
            return Ok(None);
        };
        let mut stmt = conn.prepare_cached(
            "SELECT hand_id, player, scope, is_hero, totals
             FROM seat_stats WHERE hand_id > ?1 AND hand_id <= ?2",
        )?;
        let seats = read_seats(&mut stmt, params![from, last])?;
        let mut sums = HashMap::new();
        sum_hands(&hands, &seats, 1, &mut sums)?;
        Ok(Some(PoolPage {
            generation,
            from,
            last,
            hands: hands.len(),
            sums,
        }))
    })
}

fn write_sums(conn: &Connection, sums: &HashMap<Key, Results>) -> Result<()> {
    let mut upsert = conn.prepare_cached(
        "INSERT INTO pool_player_results
           (site, player, scope, segment_id, hands, net_bb_milli, net_bb_sq_milli, hero_hands)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (site, player, scope, segment_id) DO UPDATE SET
           hands = hands + excluded.hands,
           net_bb_milli = net_bb_milli + excluded.net_bb_milli,
           net_bb_sq_milli = net_bb_sq_milli + excluded.net_bb_sq_milli,
           hero_hands = hero_hands + excluded.hero_hands",
    )?;
    for ((site, player, scope, segment), r) in sums {
        upsert.execute(params![
            site,
            player,
            scope,
            segment,
            r.hands,
            r.net_bb_milli,
            r.net_bb_sq_milli,
            r.hero_hands
        ])?;
    }
    conn.execute(
        "DELETE FROM pool_player_results WHERE hands <= 0 AND hero_hands <= 0",
        [],
    )?;
    Ok(())
}

/// Write a page unless the store moved meanwhile (another generation, the
/// mark moved, a recompute that resets the counts began). Returns whether
/// it was written.
pub fn apply_pool_page(conn: &Connection, page: &PoolPage) -> Result<bool> {
    if custom_on_hold(conn)?
        || current_gen(conn)? != page.generation
        || kv_i64(conn, KV_POOL_COUNTED)?.unwrap_or(0) != page.from
    {
        return Ok(false);
    }
    write_sums(conn, &page.sums)?;
    kv_set(conn, KV_POOL_COUNTED, &page.last.to_string())?;
    Ok(true)
}

/// One step of the pool pass. `None`: nothing to sum.
pub fn pool_step(reader: &Reader, writer: &crate::WriterHandle) -> Result<Option<usize>> {
    let Some(page) = pool_page(reader)? else {
        return Ok(None);
    };
    let hands = page.hands;
    let applied = writer.write(move |tx| apply_pool_page(tx, &page))?;
    Ok(Some(if applied { hands } else { 0 }))
}

/// Empty the results and sum them again from the first hand.
pub(crate) fn reset_pool(conn: &Connection) -> Result<()> {
    // An older store being migrated (an earlier migration resets the custom
    // counts) has no table yet: nothing to reset.
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'pool_player_results')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }
    conn.execute("DELETE FROM pool_player_results", [])?;
    kv_set(conn, KV_POOL_COUNTED, "0")?;
    Ok(())
}

/// (Hand deletion) Take these hands' part out of the results before their
/// seat rows go. `ids` are `hand_stats.id`s still stored; only those the
/// pass already summed are taken out.
pub(crate) fn uncount_pool(conn: &Connection, ids: &[i64]) -> Result<()> {
    let counted = kv_i64(conn, KV_POOL_COUNTED)?.unwrap_or(0);
    let wanted: Vec<i64> = ids.iter().copied().filter(|id| *id <= counted).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let mut read_hand = conn.prepare_cached(
        "SELECT d.id, d.segment_id, s.site, d.is_bomb_pot, d.has_straddle, d.has_cashout
         FROM hand_stats d JOIN segments s ON s.id = d.segment_id WHERE d.id = ?1",
    )?;
    let mut read = conn.prepare_cached(
        "SELECT hand_id, player, scope, is_hero, totals FROM seat_stats WHERE hand_id = ?1",
    )?;
    let mut sums = HashMap::new();
    for id in wanted {
        let Some(hand) = read_hand.query_row([id], hand_row).optional()? else {
            continue;
        };
        let seats = read_seats(&mut read, [id])?;
        sum_hands(std::slice::from_ref(&hand), &seats, -1, &mut sums)?;
    }
    write_sums(conn, &sums)
}

/* -------------------------------------------------------------- reads - */

/// What the Pool tab is read over (`None`: every value).
#[derive(Debug, Clone, Default)]
pub struct PoolFilters {
    pub game_format: Option<String>,
    /// `cash` or `tournament`.
    pub game_kind: Option<String>,
    /// Rooms (`segments.site`).
    pub sites: Option<Vec<String>>,
}

/// One player type's sums.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolTypeSums {
    pub players: i64,
    /// Their seat rows in hands with the hero.
    pub hands: i64,
    /// Σ result, big blinds.
    pub net_bb: f64,
    /// Σ result², bb².
    pub net_bb_sq: f64,
}

/// One rate's counts for one type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatSums {
    /// The catalogue id (without `an_`).
    pub stat: String,
    /// `reg` or `fish`.
    #[serde(rename = "type")]
    pub kind: String,
    pub made: i64,
    pub opp: i64,
}

/// The web's `analytics_pool`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolSums {
    pub version: String,
    /// Hands either pass has not reached yet.
    pub pending: i64,
    pub reg: PoolTypeSums,
    pub fish: PoolTypeSums,
    /// By (stat, type), catalogue order then reg before fish.
    pub stats: Vec<PoolStatSums>,
}

#[allow(clippy::float_arithmetic)] // Rail's rule: PFR ≥ 0.6·VPIP
/// The type of every named opponent with one (Rail's rule, as `hand_list`'s
/// "vs type" filter reads it).
fn player_types(conn: &Connection) -> Result<HashMap<(String, String), &'static str>> {
    let mut stmt = conn.prepare_cached(
        "SELECT site, player,
                sum(hands),
                sum(vpip) * 100.0 / max(sum(vpip_opp), 1),
                sum(pfr) * 100.0 / max(sum(pfr_opp), 1)
         FROM player_rollups WHERE scope = '' AND player <> '' GROUP BY site, player",
    )?;
    let mut out = HashMap::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let hands: i64 = row.get(2)?;
        let vpip: f64 = row.get(3)?;
        let pfr: f64 = row.get(4)?;
        if hands < 30 {
            continue;
        }
        let kind = if vpip >= 40.0 {
            "fish"
        } else if (15.0..=30.0).contains(&vpip) && pfr >= vpip * 0.6 {
            "reg"
        } else {
            continue;
        };
        out.insert((row.get(0)?, row.get(1)?), kind);
    }
    Ok(out)
}

impl Reader {
    /// The Pool tab's sums over `filters` (module docs).
    pub fn pool_sums(&self, filters: &PoolFilters) -> Result<PoolSums> {
        let formats = crate::game_kind::formats_json(
            filters.game_format.as_deref(),
            filters.game_kind.as_deref(),
        )?;
        let sites = filters
            .sites
            .as_ref()
            .filter(|sites| !sites.is_empty())
            .map(|sites| serde_json::to_string(sites).unwrap_or_else(|_| "[]".to_owned()));
        let rates: Vec<(String, String)> = catalogue()
            .stats
            .iter()
            .filter(|stat| stat.counter().is_some())
            .map(|stat| (stat.id.clone(), stat.counter_id()))
            .collect();
        self.with(|conn| {
            let types = player_types(conn)?;
            let segments: Vec<i64> = conn
                .prepare_cached(
                    "SELECT id FROM segments
                     WHERE (?1 IS NULL OR game_format IN (SELECT value FROM json_each(?1)))
                       AND (?2 IS NULL OR site IN (SELECT value FROM json_each(?2)))",
                )?
                .query_map(params![formats, sites], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut sums = PoolSums {
                version: MEMBERSHIP_VERSION.to_owned(),
                ..PoolSums::default()
            };
            sums.pending = pending(conn)?;
            if segments.is_empty() {
                return Ok(sums);
            }
            let segment_list = || -> String {
                segments
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            };
            // Each opponent's results over the segments; the members.
            let mut players: HashMap<(String, String), Results> = HashMap::new();
            {
                let mut stmt = conn.prepare(&format!(
                    "SELECT site, player, sum(hands), sum(net_bb_milli), sum(net_bb_sq_milli), sum(hero_hands)
                     FROM pool_player_results
                     WHERE scope = '' AND player <> '' AND segment_id IN ({})
                     GROUP BY site, player",
                    segment_list()
                ))?;
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    players.insert(
                        (row.get(0)?, row.get(1)?),
                        Results {
                            hands: row.get(2)?,
                            net_bb_milli: row.get(3)?,
                            net_bb_sq_milli: row.get(4)?,
                            hero_hands: row.get(5)?,
                        },
                    );
                }
            }
            let mut member: HashMap<(String, String), &'static str> = HashMap::new();
            for (key, results) in &players {
                if results.hands <= 0 || results.hero_hands > 0 {
                    continue;
                }
                let Some(kind) = types.get(key) else { continue };
                member.insert(key.clone(), kind);
                let sum = if *kind == "reg" {
                    &mut sums.reg
                } else {
                    &mut sums.fish
                };
                sum.players += 1;
                sum.hands += results.hands;
                add_results(sum, results);
            }
            // Their rates over the hands they played with the hero.
            let keys: Vec<Value> = rates.iter().map(|(_, key)| Value::Text(key.clone())).collect();
            if keys.is_empty() || member.is_empty() {
                return Ok(sums);
            }
            let placeholders = vec!["?"; keys.len()].join(",");
            let ids: HashMap<i64, String> = conn
                .prepare(&format!(
                    "SELECT id, stat_key FROM custom_stats WHERE stat_key IN ({placeholders})"
                ))?
                .query_map(params_from_iter(keys), |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            if ids.is_empty() {
                return Ok(sums);
            }
            let id_list = ids.keys().map(i64::to_string).collect::<Vec<_>>().join(",");
            let mut counts: HashMap<(String, &'static str), (i64, i64)> = HashMap::new();
            for (table, sign) in [
                ("custom_player_rollups", 1_i64),
                ("custom_player_rollups_observed", -1),
            ] {
                let mut stmt = conn.prepare(&format!(
                    "SELECT stat_id, site, player, sum(made), sum(opp) FROM {table}
                     WHERE scope = '' AND stat_id IN ({id_list}) AND segment_id IN ({})
                     GROUP BY stat_id, site, player",
                    segment_list()
                ))?;
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    let key = (row.get::<_, String>(1)?, row.get::<_, String>(2)?);
                    let Some(kind) = member.get(&key) else { continue };
                    let Some(stat_key) = ids.get(&row.get::<_, i64>(0)?) else {
                        continue;
                    };
                    let entry = counts.entry((stat_key.clone(), kind)).or_default();
                    entry.0 += sign * row.get::<_, i64>(3)?;
                    entry.1 += sign * row.get::<_, i64>(4)?;
                }
            }
            for (id, key) in &rates {
                for kind in ["reg", "fish"] {
                    if let Some(&(made, opp)) = counts.get(&(key.clone(), kind))
                        && opp > 0
                    {
                        sums.stats.push(PoolStatSums {
                            stat: id.clone(),
                            kind: kind.to_owned(),
                            made,
                            opp,
                        });
                    }
                }
            }
            Ok(sums)
        })
    }
}

/// One member's results into its type's sums (bb).
#[allow(clippy::float_arithmetic, clippy::cast_precision_loss)]
fn add_results(sum: &mut PoolTypeSums, results: &Results) {
    sum.net_bb += results.net_bb_milli as f64 / 1000.0;
    sum.net_bb_sq += results.net_bb_sq_milli as f64 / 1000.0;
}

/// Hands either pass (the `an_<id>` counts, the results) has not reached.
fn pending(conn: &Connection) -> Result<i64> {
    let counted: Option<i64> = conn
        .query_row(
            "SELECT min(counted_to) FROM custom_stats WHERE substr(stat_key, 1, 3) = 'an_'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let pool = kv_i64(conn, KV_POOL_COUNTED)?.unwrap_or(0);
    let low = counted.map_or(pool, |counted| counted.min(pool));
    Ok(conn.query_row(
        "SELECT count(*) FROM hand_stats WHERE id > ?1",
        [low],
        |row| row.get(0),
    )?)
}
