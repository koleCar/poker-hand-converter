//! Deleting hands (store version 26; 2026-11-19, the owner: "delete a
//! single hand, select several hands and delete them, or delete all").
//!
//! - **One hand or a selection** ([`WriterHandle::delete_hands`]): in one
//!   writer transaction each hand's rows go - `hands` and, by cascade, its
//!   statistics rows, list row, EV row, analysis, outbox entry and refusal;
//!   its notes and tags; its custom-statistics rows - and every sum it was
//!   counted in is taken back **exactly**: the rollups (`player_rollups`,
//!   `player_rollups_observed`, `hero_rollups`, `player_summary`,
//!   `player_hidden`) lose the sums of its stored seat rows, summed by the
//!   same code an import adds them with ([`crate::stats::Pending`], negated);
//!   a row left with no hands goes; a newest or earliest date the hand held
//!   is looked up again among the rows left; the custom statistics lose what
//!   their pass counted for it ([`crate::custom`]); the folder counters
//!   (`files.hands`, `source_days`; `source_totals` by trigger) count it no
//!   more. A recompute running meanwhile starts again (its twins have summed
//!   the hand).
//! - **Every hand** ([`WriterHandle::delete_all_hands`]): the same tables
//!   emptied by bulk statements (the per-row triggers dropped and created
//!   again inside the transaction), so 500 000 hands go in seconds; the
//!   folders keep their files and read offsets.
//! - **Tombstones** (`deleted_hands`): every deleted key, so neither a
//!   folder read again nor a manual import brings it back; the pull skips a
//!   key whose server copy is still owed a deletion, and takes back (the
//!   tombstone dropped) one the server serves again after its deletion was
//!   done - a hand uploaded again on purpose.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Error, Result};
use crate::read::Reader;
use crate::stats::{
    Exclusions, HandSum, KIND_BOMB_POT, KIND_CASHOUT, KIND_STRADDLED, KV_PLAYERS_INDEXED, Pending,
    SeatSum, SeatValues, current_gen, day_of, decode_seat, kv_i64,
};
use crate::writer::WriterHandle;

/// `kv`: a "delete every hand" the account's server copy still owes (the
/// instant it was asked, ms); the sync worker runs `delete_all_hands` and
/// removes it.
pub const KV_SERVER_WIPE: &str = "sync.delete_all";

/// The per-row triggers the bulk delete drops and creates again.
const BULK_TRIGGERS: [&str; 2] = ["seat_stats_player_delete", "hand_stats_list_delete"];

/// One stored seat row of a hand that goes.
struct GoneSeat {
    player: String,
    scope: String,
    is_hero: bool,
    position: String,
    values: SeatValues,
}

/// A hand's statistics rows, as the rollups counted them.
struct GoneStats {
    id: i64,
    counted: bool,
    segment_id: i64,
    site: String,
    cash: bool,
    played_at: Option<String>,
    kind: i64,
    seats: Vec<GoneSeat>,
}

/// A rollup key of `player_rollups` / `player_rollups_observed`.
type PlayerKey = (String, String, String, i64);

/// What the hands that go were counted in: each key with the newest date
/// they gave it, so it is looked up again only when one of them held it.
#[derive(Default)]
struct Touched {
    /// key -> (newest date, whether a hero seat of it went).
    players: HashMap<PlayerKey, (Option<String>, bool)>,
    observed: HashMap<PlayerKey, Option<String>>,
    heroes: HashSet<(i64, String, String, i64)>,
    /// (site, player) -> (earliest, newest).
    summary: HashMap<(String, String), (Option<String>, Option<String>)>,
    hidden: HashSet<String>,
}

fn later(a: &mut Option<String>, b: Option<&str>) {
    if b > a.as_deref() {
        *a = b.map(str::to_owned);
    }
}

fn earlier(a: &mut Option<String>, b: Option<&str>) {
    if let Some(b) = b
        && a.as_deref().is_none_or(|own| b < own)
    {
        *a = Some(b.to_owned());
    }
}

impl Touched {
    /// The keys [`Pending::count`] adds a seat to, for `hand`.
    fn note(&mut self, hand: &GoneStats, seat: &GoneSeat, has_hero: bool) {
        let (counted, _) = Exclusions::default().admits(hand.kind);
        let at = hand.played_at.as_deref();
        if counted {
            let key = (
                hand.site.clone(),
                seat.player.clone(),
                seat.scope.clone(),
                hand.segment_id,
            );
            if !has_hero {
                later(self.observed.entry(key.clone()).or_default(), at);
            }
            let entry = self.players.entry(key).or_default();
            later(&mut entry.0, at);
            entry.1 |= seat.is_hero;
            if !seat.is_hero {
                if seat.scope.is_empty() {
                    if !seat.player.is_empty() {
                        let entry = self
                            .summary
                            .entry((hand.site.clone(), seat.player.clone()))
                            .or_default();
                        earlier(&mut entry.0, at);
                        later(&mut entry.1, at);
                    }
                } else {
                    self.hidden.insert(hand.site.clone());
                }
            }
        }
        if seat.is_hero {
            self.heroes.insert((
                hand.segment_id,
                seat.position.clone(),
                day_of(at).to_owned(),
                hand.kind,
            ));
        }
    }
}

/// A hand's statistics rows, if it has any.
fn gone_stats(conn: &Connection, hand_key: &str, generation: i64) -> Result<Option<GoneStats>> {
    let head = conn
        .prepare_cached(
            "SELECT d.id, d.gen, d.segment_id, g.site, g.game_format, d.played_at,
                    d.is_bomb_pot, d.has_straddle, d.has_cashout
             FROM hand_stats d JOIN segments g ON g.id = d.segment_id
             WHERE d.hand_key = ?1",
        )?
        .query_row([hand_key], |row| {
            let kind = (if row.get::<_, bool>(6)? {
                KIND_BOMB_POT
            } else {
                0
            }) | (if row.get::<_, bool>(7)? {
                KIND_STRADDLED
            } else {
                0
            }) | (if row.get::<_, bool>(8)? {
                KIND_CASHOUT
            } else {
                0
            });
            Ok(GoneStats {
                id: row.get(0)?,
                counted: row.get::<_, i64>(1)? == generation,
                segment_id: row.get(2)?,
                site: row.get(3)?,
                cash: row.get::<_, String>(4)? == "cash",
                played_at: row.get(5)?,
                kind,
                seats: Vec::new(),
            })
        })
        .optional()?;
    let Some(mut stats) = head else {
        return Ok(None);
    };
    let mut seats = conn.prepare_cached(
        "SELECT player, scope, is_hero, coalesce(position, ''), totals
         FROM seat_stats WHERE hand_id = ?1 ORDER BY seat",
    )?;
    let mut rows = seats.query([stats.id])?;
    while let Some(row) = rows.next()? {
        stats.seats.push(GoneSeat {
            player: row.get(0)?,
            scope: row.get(1)?,
            is_hero: row.get(2)?,
            position: row.get(3)?,
            values: decode_seat(&row.get::<_, Vec<u8>>(4)?)?,
        });
    }
    Ok(Some(stats))
}

/// Restart a rows job that is running (its twins summed hands that are
/// gone) and drop the gone hands from the EV job's list.
fn recompute_after(conn: &Connection) -> Result<()> {
    if let Some(state) = crate::recompute::rows_state(conn)? {
        crate::recompute::begin_rows(conn, state.job)?;
    }
    conn.execute(
        "DELETE FROM recompute_ev WHERE hand_key NOT IN (SELECT hand_key FROM hands)",
        [],
    )?;
    Ok(())
}

/// A custom statistic counted up to an id the store no longer has would
/// skip the next hand given that id again: no mark past the last row.
fn clamp_custom_marks(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE custom_stats SET counted_to = (SELECT coalesce(max(id), 0) FROM hand_stats)
         WHERE counted_to > (SELECT coalesce(max(id), 0) FROM hand_stats)",
        [],
    )?;
    Ok(())
}

/// Delete these hands (keys the store does not hold are left alone) and
/// take them out of every sum; tombstone each key, with the server's
/// deletion owed when `owe_server`. Returns the hands deleted.
pub(crate) fn delete_hands(
    conn: &Connection,
    keys: &[String],
    at_ms: i64,
    owe_server: bool,
) -> Result<u64> {
    let generation = current_gen(conn)?;
    let mut pending = Pending::new(conn)?;
    let mut touched = Touched::default();
    let mut stat_ids = Vec::new();
    let mut gone = Vec::new();
    let mut seen = HashSet::new();
    {
        let mut read = conn.prepare_cached(
            "SELECT h.file_id, h.imported_at, f.source_id
             FROM hands h LEFT JOIN files f ON f.id = h.file_id
             WHERE h.hand_key = ?1",
        )?;
        for key in keys {
            if !seen.insert(key.as_str()) {
                continue;
            }
            let row: Option<(Option<i64>, i64, Option<i64>)> = read
                .query_row([key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()?;
            let Some((file_id, imported_at, source_id)) = row else {
                continue;
            };
            if let Some(stats) = gone_stats(conn, key, generation)? {
                stat_ids.push(stats.id);
                if stats.counted {
                    let hero = stats.seats.iter().find(|seat| seat.is_hero);
                    let sum = HandSum {
                        site: &stats.site,
                        segment_id: stats.segment_id,
                        played_at: stats.played_at.as_deref(),
                        kind: stats.kind,
                        cash: stats.cash,
                        hero_net: hero.map(|seat| seat.values.net_bb_milli()),
                    };
                    for seat in &stats.seats {
                        pending.count(
                            &sum,
                            &SeatSum {
                                player: &seat.player,
                                scope: &seat.scope,
                                is_hero: seat.is_hero,
                                position: &seat.position,
                                values: &seat.values,
                            },
                        );
                        touched.note(&stats, seat, hero.is_some());
                    }
                }
            }
            gone.push((key.clone(), file_id, imported_at, source_id));
        }
    }
    if gone.is_empty() {
        return Ok(0);
    }

    // The custom statistics read the hands' PHF and seats: before they go.
    crate::custom::uncount_hands(conn, &stat_ids)?;

    let mut tombstone = conn.prepare_cached(
        "INSERT INTO deleted_hands (hand_key, deleted_at, server) VALUES (?1, ?2, ?3)
         ON CONFLICT (hand_key) DO UPDATE SET deleted_at = excluded.deleted_at,
           server = max(server, excluded.server)",
    )?;
    let mut file_count = conn.prepare_cached("UPDATE files SET hands = hands - 1 WHERE id = ?1")?;
    let mut day_count = conn.prepare_cached(
        "UPDATE source_days SET hands = hands - 1
         WHERE source_id = ?1 AND day = date(?2 / 1000, 'unixepoch', 'localtime')",
    )?;
    let mut drop_day = conn.prepare_cached(
        "DELETE FROM source_days
         WHERE source_id = ?1 AND day = date(?2 / 1000, 'unixepoch', 'localtime') AND hands <= 0",
    )?;
    let mut notes = conn.prepare_cached("DELETE FROM hand_notes WHERE hand_key = ?1")?;
    let mut tags = conn.prepare_cached("DELETE FROM hand_tags WHERE hand_key = ?1")?;
    let mut hand = conn.prepare_cached("DELETE FROM hands WHERE hand_key = ?1")?;
    for (key, file_id, imported_at, source_id) in &gone {
        tombstone.execute(params![key, at_ms, owe_server])?;
        if let Some(file_id) = file_id {
            file_count.execute([file_id])?;
            if let Some(source_id) = source_id {
                day_count.execute(params![source_id, imported_at])?;
                drop_day.execute(params![source_id, imported_at])?;
            }
        }
        notes.execute([key])?;
        tags.execute([key])?;
        hand.execute([key])?;
    }

    pending.negate();
    pending.flush(conn)?;
    settle(conn, &touched, generation)?;
    clamp_custom_marks(conn)?;
    recompute_after(conn)?;
    u64::try_from(gone.len()).map_err(|_| Error::OutOfRange("deleted"))
}

/// After the sums were taken back: rows left with no hands go, and a date
/// one of the gone hands held is looked up again.
fn settle(conn: &Connection, touched: &Touched, generation: i64) -> Result<()> {
    let indexed = kv_i64(conn, KV_PLAYERS_INDEXED)?.unwrap_or(0);
    for (table, observed) in [("player_rollups", false), ("player_rollups_observed", true)] {
        let mut read = conn.prepare_cached(&format!(
            "SELECT hands, last_played_at FROM {table}
             WHERE site = ?1 AND player = ?2 AND scope = ?3 AND segment_id = ?4"
        ))?;
        let mut drop = conn.prepare_cached(&format!(
            "DELETE FROM {table} WHERE site = ?1 AND player = ?2 AND scope = ?3 AND segment_id = ?4"
        ))?;
        let mut set = conn.prepare_cached(&format!(
            "UPDATE {table} SET last_played_at = ?5
             WHERE site = ?1 AND player = ?2 AND scope = ?3 AND segment_id = ?4"
        ))?;
        let keys: Vec<(&PlayerKey, Option<&String>, bool)> = if observed {
            touched
                .observed
                .iter()
                .map(|(key, last)| (key, last.as_ref(), false))
                .collect()
        } else {
            touched
                .players
                .iter()
                .map(|(key, (last, hero))| (key, last.as_ref(), *hero))
                .collect()
        };
        for ((site, player, scope, segment), gone_last, hero) in keys {
            let row: Option<(i64, Option<String>)> = read
                .query_row(params![site, player, scope, segment], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()?;
            let Some((hands, last)) = row else { continue };
            if hands <= 0 {
                drop.execute(params![site, player, scope, segment])?;
                continue;
            }
            if let Some(gone_last) = gone_last
                && last.as_ref() == Some(gone_last)
            {
                let key = Seat {
                    site,
                    player,
                    scope,
                    segment: Some(*segment),
                    observed,
                };
                let found = newest_left(conn, &key, gone_last, hero, generation, indexed)?;
                set.execute(params![site, player, scope, segment, found])?;
            }
        }
    }

    let mut drop_hero = conn.prepare_cached(
        "DELETE FROM hero_rollups
         WHERE segment_id = ?1 AND position = ?2 AND day = ?3 AND kind = ?4 AND hands <= 0",
    )?;
    for (segment, position, day, kind) in &touched.heroes {
        drop_hero.execute(params![segment, position, day, kind])?;
    }

    let mut read = conn.prepare_cached(
        "SELECT hands, first_played_at, last_played_at FROM player_summary
         WHERE site = ?1 AND player = ?2",
    )?;
    let mut drop =
        conn.prepare_cached("DELETE FROM player_summary WHERE site = ?1 AND player = ?2")?;
    let mut set = conn.prepare_cached(
        "UPDATE player_summary SET first_played_at = ?3, last_played_at = ?4
         WHERE site = ?1 AND player = ?2",
    )?;
    for ((site, player), (gone_first, gone_last)) in &touched.summary {
        let row: Option<(i64, Option<String>, Option<String>)> = read
            .query_row(params![site, player], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()?;
        let Some((hands, first, last)) = row else {
            continue;
        };
        if hands <= 0 {
            drop.execute(params![site, player])?;
            continue;
        }
        let first_gone = gone_first.is_some() && first == *gone_first;
        let last_gone = gone_last.is_some() && last == *gone_last;
        if first_gone || last_gone {
            let (new_first, new_last) =
                named_bounds(conn, site, player, None, false, generation, indexed)?;
            set.execute(params![
                site,
                player,
                if first_gone { new_first } else { first },
                if last_gone { new_last } else { last },
            ])?;
        }
    }

    let mut drop_hidden =
        conn.prepare_cached("DELETE FROM player_hidden WHERE site = ?1 AND hands <= 0")?;
    for site in &touched.hidden {
        drop_hidden.execute([site])?;
    }
    Ok(())
}

/// A rollup key whose date is looked up again.
struct Seat<'a> {
    site: &'a str,
    player: &'a str,
    scope: &'a str,
    /// `None`: every segment of the site (`player_summary`).
    segment: Option<i64>,
    /// Only hands without a hero seat (`player_rollups_observed`).
    observed: bool,
}

/// SQL: the hand `d` has no hero seat.
const NO_HERO: &str =
    "NOT EXISTS (SELECT 1 FROM seat_stats x WHERE x.hand_id = d.id AND x.is_hero = 1)";

/// The newest `played_at` among the counted rows left under `key`, at or
/// before `below` (the date that went; nothing left is newer).
fn newest_left(
    conn: &Connection,
    key: &Seat<'_>,
    below: &str,
    hero: bool,
    generation: i64,
    indexed: i64,
) -> Result<Option<String>> {
    let observed = if key.observed {
        format!("AND {NO_HERO}")
    } else {
        String::new()
    };
    if !key.scope.is_empty() {
        // A session's scope (`<table>@<day>`, R3.7): its hands are of one
        // UTC day.
        let day = key.scope.rsplit_once('@').map_or("", |(_, day)| day);
        if day.is_empty() {
            return Ok(None);
        }
        let found: Option<String> = conn
            .prepare_cached(&format!(
                "SELECT max(d.played_at) FROM hand_stats d
                 JOIN seat_stats s ON s.hand_id = d.id
                 WHERE d.played_at >= ?1 AND d.played_at < ?1 || '~'
                   AND d.segment_id = ?2 AND d.gen = ?3 AND d.is_bomb_pot = 0
                   AND s.player = ?4 AND s.scope = ?5 {observed}"
            ))?
            .query_row(
                params![day, key.segment, generation, key.player, key.scope],
                |row| row.get(0),
            )?;
        return Ok(found);
    }
    if hero || key.player.is_empty() {
        // The hero's name (in nearly every hand: found within a few), or a
        // seat without a name (not in `player_hands`): the segment's list,
        // newest first.
        let found: Option<String> = conn
            .prepare_cached(&format!(
                "SELECT l.played_at FROM hand_list l
                 JOIN hand_stats d ON d.hand_key = l.hand_key
                 WHERE l.played_at <> '' AND l.played_at <= ?1 AND l.segment_id = ?2
                   AND d.gen = ?3 AND d.is_bomb_pot = 0
                   AND EXISTS (SELECT 1 FROM seat_stats s
                               WHERE s.hand_id = d.id AND s.player = ?4 AND s.scope = '')
                   {observed}
                 ORDER BY l.played_at DESC LIMIT 1"
            ))?
            .query_row(params![below, key.segment, generation, key.player], |row| {
                row.get(0)
            })
            .optional()?;
        return Ok(found);
    }
    Ok(named_bounds(
        conn,
        key.site,
        key.player,
        key.segment,
        key.observed,
        generation,
        indexed,
    )?
    .1)
}

/// The earliest and newest `played_at` of an opponent's counted rows by
/// name (scope `''`): from `player_hands` (the background pass's index, by
/// name) for the hands up to its mark, and the few after it read directly.
fn named_bounds(
    conn: &Connection,
    site: &str,
    player: &str,
    segment: Option<i64>,
    observed: bool,
    generation: i64,
    indexed: i64,
) -> Result<(Option<String>, Option<String>)> {
    let observed = if observed {
        format!("AND {NO_HERO}")
    } else {
        String::new()
    };
    let indexed_part: (Option<String>, Option<String>) = conn
        .prepare_cached(&format!(
            "SELECT min(d.played_at), max(d.played_at) FROM player_hands p
             JOIN hand_stats d ON d.id = p.hand_id
             JOIN segments g ON g.id = d.segment_id
             WHERE p.player = ?1 AND g.site = ?2 AND (?3 IS NULL OR d.segment_id = ?3)
               AND d.gen = ?4 AND d.is_bomb_pot = 0 {observed}"
        ))?
        .query_row(params![player, site, segment, generation], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let tail: (Option<String>, Option<String>) = conn
        .prepare_cached(&format!(
            "SELECT min(d.played_at), max(d.played_at) FROM hand_stats d
             JOIN segments g ON g.id = d.segment_id
             JOIN seat_stats s ON s.hand_id = d.id
             WHERE d.id > ?5 AND s.player = ?1 AND s.scope = '' AND s.is_hero = 0
               AND g.site = ?2 AND (?3 IS NULL OR d.segment_id = ?3)
               AND d.gen = ?4 AND d.is_bomb_pot = 0 {observed}"
        ))?
        .query_row(params![player, site, segment, generation, indexed], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let mut first = indexed_part.0;
    earlier(&mut first, tail.0.as_deref());
    let mut last = indexed_part.1;
    later(&mut last, tail.1.as_deref());
    Ok((first, last))
}

/// Delete every hand: the derived tables emptied in bulk, every key
/// tombstoned (nothing owed one by one: the server's copy goes with
/// `delete_all_hands`, [`KV_SERVER_WIPE`]). The folders keep their files
/// and read offsets. Returns the hands deleted.
pub(crate) fn delete_all(conn: &Connection, at_ms: i64) -> Result<u64> {
    let hands: i64 = conn.query_row("SELECT count(*) FROM hands", [], |row| row.get(0))?;
    conn.execute(
        "INSERT INTO deleted_hands (hand_key, deleted_at, server)
         SELECT hand_key, ?1, 0 FROM hands WHERE true
         ON CONFLICT (hand_key) DO UPDATE SET deleted_at = excluded.deleted_at, server = 0",
        [at_ms],
    )?;
    let mut triggers = Vec::new();
    for name in BULK_TRIGGERS {
        let sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(sql) = sql {
            conn.execute(&format!("DROP TRIGGER {name}"), [])?;
            triggers.push(sql);
        }
    }
    for table in [
        "player_hands",
        "hand_list",
        "seat_stats",
        "hand_stats",
        "ev_rows",
        "ev_pending",
        "outbox",
        "sync_rejected",
        "analysis_checker_rows",
        "decision_analysis",
        "analysis_leak_rows",
        "chart_decisions",
        "hand_analysis",
        "hand_notes",
        "hand_tags",
        "player_rollups",
        "player_rollups_observed",
        "hero_rollups",
        "player_summary",
        "player_hidden",
        "custom_hero_rows",
        "custom_hero_rollups",
        "custom_player_rollups",
        "custom_player_rollups_observed",
        "source_days",
        "hands",
    ] {
        conn.execute(&format!("DELETE FROM {table}"), [])?;
    }
    for sql in triggers {
        conn.execute(&sql, [])?;
    }
    conn.execute("UPDATE files SET hands = 0 WHERE hands <> 0", [])?;
    conn.execute("UPDATE custom_stats SET counted_to = 0", [])?;
    recompute_after(conn)?;
    if crate::recompute::ev_state(conn)?.is_some() {
        crate::recompute::begin_ev(conn)?;
    }
    u64::try_from(hands).map_err(|_| Error::OutOfRange("hands"))
}

/// What a server tombstone page did here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Applied {
    /// Hands deleted here.
    pub deleted: u64,
}

impl WriterHandle {
    /// Delete these hands here (one transaction), every sum kept exact, and
    /// owe the account's copy a deletion (the sync worker sends it).
    /// Returns the hands deleted.
    pub fn delete_hands(&self, keys: Vec<String>, at_ms: i64) -> Result<u64> {
        self.write(move |tx| delete_hands(tx, &keys, at_ms, true))
    }

    /// Delete every hand here. With `owe_server`, the account's copy is
    /// owed a "delete every hand" ([`KV_SERVER_WIPE`]). Returns the hands
    /// deleted.
    pub fn delete_all_hands(&self, at_ms: i64, owe_server: bool) -> Result<u64> {
        self.write(move |tx| {
            let deleted = delete_all(tx, at_ms)?;
            if owe_server {
                crate::stats::kv_set(tx, KV_SERVER_WIPE, &at_ms.to_string())?;
            }
            Ok(deleted)
        })
    }

    /// The server deleted these keys (its answer to our request): nothing
    /// is owed for them any more.
    pub fn deletions_done(&self, keys: Vec<String>) -> Result<()> {
        self.write(move |tx| {
            let mut done =
                tx.prepare_cached("UPDATE deleted_hands SET server = 0 WHERE hand_key = ?1")?;
            for key in &keys {
                done.execute([key])?;
            }
            Ok(())
        })
    }

    /// The server's "delete every hand" is done: forget it.
    pub fn server_wipe_done(&self, asked_at_ms: i64) -> Result<()> {
        self.write(move |tx| {
            tx.execute(
                "DELETE FROM kv WHERE key = ?1 AND value = ?2",
                params![KV_SERVER_WIPE, asked_at_ms.to_string()],
            )?;
            Ok(())
        })
    }

    /// The server says these hands were deleted (on the web, or by another
    /// computer): delete them here too, nothing owed, and write `cursor`
    /// (a `kv` pair) in the same transaction.
    pub fn apply_server_deletions(
        &self,
        keys: Vec<String>,
        cursor: Option<(String, String)>,
        at_ms: i64,
    ) -> Result<Applied> {
        self.write(move |tx| {
            let deleted = delete_hands(tx, &keys, at_ms, false)?;
            // Every key, held here or not: a file read later must not bring
            // it back either.
            let mut done = tx.prepare_cached(
                "INSERT INTO deleted_hands (hand_key, deleted_at, server) VALUES (?1, ?2, 0)
                 ON CONFLICT (hand_key) DO UPDATE SET server = 0",
            )?;
            for key in &keys {
                done.execute(params![key, at_ms])?;
            }
            write_cursor(tx, cursor, at_ms)?;
            Ok(Applied { deleted })
        })
    }

    /// The server says every hand it stored up to `before_ms` was deleted:
    /// delete here every hand the server confirmed by then (`synced_at` at
    /// or before it; a hand still waiting in the outbox stays and is sent).
    /// The two clocks are not compared beyond that: a hand synced in the
    /// same moment on a computer whose clock runs ahead may stay.
    pub fn apply_server_wipe(
        &self,
        before_ms: i64,
        cursor: Option<(String, String)>,
        at_ms: i64,
    ) -> Result<Applied> {
        self.write(move |tx| {
            let keys: Vec<String> = tx
                .prepare(
                    "SELECT hand_key FROM hands
                     WHERE synced_at IS NOT NULL AND synced_at <= ?1
                       AND hand_key NOT IN (SELECT hand_key FROM outbox)",
                )?
                .query_map([before_ms], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let total: i64 = tx.query_row("SELECT count(*) FROM hands", [], |row| row.get(0))?;
            let deleted = if !keys.is_empty() && i64::try_from(keys.len()).ok() == Some(total) {
                delete_all(tx, at_ms)?
            } else {
                delete_hands(tx, &keys, at_ms, false)?
            };
            write_cursor(tx, cursor, at_ms)?;
            Ok(Applied { deleted })
        })
    }
}

fn write_cursor(conn: &Connection, cursor: Option<(String, String)>, at_ms: i64) -> Result<()> {
    if let Some((key, value)) = cursor {
        conn.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                             updated_at = excluded.updated_at",
            params![key, value, at_ms],
        )?;
    }
    Ok(())
}

impl Reader {
    /// Up to `limit` deleted keys whose server copy is still owed a
    /// deletion, oldest first.
    pub fn deletions_owed(&self, limit: u32) -> Result<Vec<String>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT hand_key FROM deleted_hands INDEXED BY deleted_hands_owed_idx
                 WHERE server = 1 ORDER BY deleted_at, hand_key LIMIT ?1",
            )?;
            let keys = stmt
                .query_map([limit], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(keys)
        })
    }

    /// A "delete every hand" the server still owes: when it was asked, ms.
    pub fn server_wipe_owed(&self) -> Result<Option<i64>> {
        self.with(|conn| kv_i64(conn, KV_SERVER_WIPE))
    }

    /// Whether `hand_key` was deleted here.
    pub fn is_deleted(&self, hand_key: &str) -> Result<bool> {
        self.with(|conn| {
            Ok(conn
                .prepare_cached("SELECT 1 FROM deleted_hands WHERE hand_key = ?1")?
                .exists([hand_key])?)
        })
    }
}
