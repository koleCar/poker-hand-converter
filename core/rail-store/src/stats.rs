//! Local statistics, the write side (docs/RAIL-PLAN.md §3.4, R2.3): the
//! rows of a hand, the rollups they add to, and the hero's EV row, written
//! in the transaction that stores the hand.
//!
//! - **`hand_stats`** (one per hand with kept rows) and **`seat_stats`**
//!   (one per kept seat: [`rail_stats::stored_rows`], the hero always,
//!   villains unless the room is positionally anonymised), derived on the
//!   producer's thread ([`PreparedStats`]). A seat's 90 counters and 7 money
//!   values are one blob ([`encode_seat`]); together with `hands` the rows
//!   give back the engine's `StatsRow` exactly (`tests/stats.rs`).
//! - **`player_rollups`** (site, player, scope, segment): the sums of the
//!   current generation's seat rows with `aggregate`'s default exclusions
//!   (`frontend/src/lib/stats/rates.ts`: bomb pots left out, EV-cashout
//!   hands left out of the money, `money_hands` counted). **`hero_rollups`**
//!   (segment, position, UTC day, kind): the hero's rows, nothing excluded,
//!   kept apart by [`kind_of`] so a report can apply any of `aggregate`'s
//!   options.
//! - **Summed in memory, added once** ([`Pending`]): a batch's (or a whole
//!   group of batches', `writer::commit_group`) new rows are summed per
//!   rollup key and added with one upsert per key, so a backfill writes a
//!   rollup row per player and segment per transaction, not per seat. A
//!   duplicate hand stores nothing and adds nothing.
//! - **Generations** (`kv` `stats.gen`; `hand_stats.gen`): a rebuild
//!   ([`begin_rebuild`]: a `STATS_VERSION` bump, or "rebuild statistics")
//!   starts a new generation and empties the rollups; the background pass
//!   then replaces each hand's older rows with new ones and counts them
//!   ([`apply_rebuild_page`]), while imports keep counting their new hands in
//!   the new generation. At every commit **the rollups equal the sums of the
//!   seat rows of the current generation** (`tests/common::assert_rollups`,
//!   after every kill of the crash test too), and no row is counted twice.
//! - **EV** (`ev_rows`, `ev_pending`): the hero's EV is computed with the hand
//!   unless its all-in was completed preflop (1.7M boards, 25-46 ms): those
//!   wait in `ev_pending` for the background pass (`crate::background`), as
//!   does every hero hand after an `EV_VERSION` bump. Only rows that differ
//!   from the result are stored (`applicable`); any other hero hand's row is
//!   `ev_net = net` (`handEvRow`), implied by its absence from both tables.
//!
//! Nothing here deletes a hand: `hand_stats`, `seat_stats`, `ev_rows` and
//! `ev_pending` cascade with one, but the rollups would keep its counts. A
//! future path that deletes hands must subtract their rows first.

use std::collections::HashMap;
use std::sync::OnceLock;

use rail_equity::{EV_VERSION, EvRow};
use rail_stats::{
    COUNTER_COUNT, COUNTER_KEYS, Counter, MONEY_KEYS, STATS_VERSION, Segment, StatsRow,
};
use rusqlite::{Connection, OptionalExtension, Statement, params};

use crate::batch::{EvPlan, PreparedStats};
use crate::error::{Error, Result};

/// `kv`: the generation the rollups count.
pub const KV_GEN: &str = "stats.gen";
/// `kv`: the `STATS_VERSION` the current generation is derived under.
pub const KV_VERSION: &str = "stats.version";
/// `kv`: while a rebuild runs, the last `hand_key` it finished...
pub const KV_REBUILD_CURSOR: &str = "stats.rebuild.cursor";
/// ...how many hands it has gone through...
pub const KV_REBUILD_DONE: &str = "stats.rebuild.done";
/// ...and how many there were when it started.
pub const KV_REBUILD_TOTAL: &str = "stats.rebuild.total";
/// `kv`: the `EV_VERSION` every hero hand has been evaluated at or is
/// queued for.
pub const KV_EV_VERSION: &str = "ev.version";

/// How many money columns follow the counters.
pub const MONEY_COUNT: usize = MONEY_KEYS.len();

/// `hero_rollups.kind`: a bomb pot (left out of every default sum)...
pub const KIND_BOMB_POT: i64 = 1;
/// ...a straddled hand (in by default)...
pub const KIND_STRADDLED: i64 = 2;
/// ...an EV-cashout hand (its money left out by default).
pub const KIND_CASHOUT: i64 = 4;

/// The hand-level flags `aggregate` decides on, as a `kind`.
pub fn kind_of(row: &StatsRow) -> i64 {
    let hand = &row.hand;
    (if hand.is_bomb_pot { KIND_BOMB_POT } else { 0 })
        | (if hand.has_straddle { KIND_STRADDLED } else { 0 })
        | (if hand.has_cashout { KIND_CASHOUT } else { 0 })
}

/// A seat's counters and money, as `seat_stats.totals` holds them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatValues {
    pub counters: [u32; COUNTER_COUNT],
    pub money: [i64; MONEY_COUNT],
}

impl SeatValues {
    /// The values of an engine row.
    pub fn of(row: &StatsRow) -> Self {
        let mut money = [0; MONEY_COUNT];
        for (slot, (_, value)) in money.iter_mut().zip(row.seat.money.columns()) {
            *slot = value;
        }
        Self {
            counters: row.seat.counters.0,
            money,
        }
    }

    /// `net` (minor units).
    pub fn net(&self) -> i64 {
        self.money[2]
    }

    /// `net_bb_milli`.
    pub fn net_bb_milli(&self) -> i64 {
        self.money[3]
    }
}

fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = u8::try_from(value & 0x7f).unwrap_or(0);
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(bytes: &[u8], at: &mut usize) -> Result<u64> {
    let mut value: u64 = 0;
    for shift in (0..64).step_by(7) {
        let byte = *bytes
            .get(*at)
            .ok_or_else(|| Error::Corrupt("seat totals: truncated".to_owned()))?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(Error::Corrupt("seat totals: varint too long".to_owned()))
}

/// `seat_stats.totals`: every value that is not 0, in column order, as a
/// pair of LEB128 varints - the column's index (counters `0..90`, then the
/// money `90..97`) and the value zigzagged. A typical seat is 15-40 bytes
/// where a column per value took ~130.
pub fn encode_seat(values: &SeatValues) -> Vec<u8> {
    let mut out = Vec::with_capacity(48);
    let all = values
        .counters
        .iter()
        .map(|&value| i64::from(value))
        .chain(values.money.iter().copied());
    for (index, value) in all.enumerate() {
        if value != 0 {
            push_varint(&mut out, u64::try_from(index).unwrap_or(u64::MAX));
            // Zigzag: 0, -1, 1, -2, ... -> 0, 1, 2, 3, ...
            let zigzag = (value << 1) ^ (value >> 63);
            push_varint(&mut out, u64::from_ne_bytes(zigzag.to_ne_bytes()));
        }
    }
    out
}

/// Back from [`encode_seat`].
pub fn decode_seat(bytes: &[u8]) -> Result<SeatValues> {
    let mut values = SeatValues {
        counters: [0; COUNTER_COUNT],
        money: [0; MONEY_COUNT],
    };
    let mut at = 0;
    while at < bytes.len() {
        let index = usize::try_from(read_varint(bytes, &mut at)?)
            .map_err(|_| Error::Corrupt("seat totals: index".to_owned()))?;
        let zigzag = i64::from_ne_bytes(read_varint(bytes, &mut at)?.to_ne_bytes());
        let value = ((zigzag >> 1) & i64::MAX) ^ -(zigzag & 1);
        if index < COUNTER_COUNT {
            values.counters[index] = u32::try_from(value)
                .map_err(|_| Error::Corrupt("seat totals: counter".to_owned()))?;
        } else if let Some(slot) = values.money.get_mut(index - COUNTER_COUNT) {
            *slot = value;
        } else {
            return Err(Error::Corrupt("seat totals: column".to_owned()));
        }
    }
    Ok(values)
}

/// Summed counters and money: a rollup row, or any sum of seat rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Totals {
    /// In [`COUNTER_KEYS`] order; `counters[0]` is `hands`.
    pub counters: [i64; COUNTER_COUNT],
    /// In [`MONEY_KEYS`] order: minor units (one currency only within a
    /// cash segment), `net_bb_milli` in thousandths of a big blind.
    pub money: [i64; MONEY_COUNT],
    /// The hands whose money is in `money` (`aggregate`'s `moneyHands`):
    /// bb/100 divides by this, not by `hands`.
    pub money_hands: i64,
}

impl Default for Totals {
    fn default() -> Self {
        Self {
            counters: [0; COUNTER_COUNT],
            money: [0; MONEY_COUNT],
            money_hands: 0,
        }
    }
}

/// `aggregate`'s options (`AggregateOptions`), as exclusions: the default
/// (all `false`) is `aggregate`'s default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Exclusions {
    /// Include bomb pots (`bombPots: true`).
    pub bomb_pots: bool,
    /// Include EV-cashout hands' money (`cashouts: true`).
    pub cashouts: bool,
    /// Leave straddled hands out (`straddled: false`).
    pub no_straddled: bool,
}

impl Exclusions {
    /// Whether rows of `kind` count at all, and whether their money does.
    pub fn admits(self, kind: i64) -> (bool, bool) {
        let counted = (kind & KIND_BOMB_POT == 0 || self.bomb_pots)
            && (kind & KIND_STRADDLED == 0 || !self.no_straddled);
        (
            counted,
            counted && (kind & KIND_CASHOUT == 0 || self.cashouts),
        )
    }
}

impl Totals {
    /// Add one seat's values: its counters, and its money when `money`.
    pub fn add_seat(&mut self, values: &SeatValues, money: bool) {
        for (sum, value) in self.counters.iter_mut().zip(values.counters) {
            *sum += i64::from(value);
        }
        if money {
            for (sum, value) in self.money.iter_mut().zip(values.money) {
                *sum += value;
            }
            self.money_hands += i64::from(values.counters[Counter::hands.index()]);
        }
    }

    /// Add another sum; only its counters unless `money`.
    pub fn add(&mut self, other: &Self, money: bool) {
        for (sum, value) in self.counters.iter_mut().zip(other.counters) {
            *sum += value;
        }
        if money {
            for (sum, value) in self.money.iter_mut().zip(other.money) {
                *sum += value;
            }
            self.money_hands += other.money_hands;
        }
    }

    /// One counter.
    pub fn get(&self, counter: Counter) -> i64 {
        self.counters[counter.index()]
    }

    /// The `hands` counter.
    pub fn hands(&self) -> i64 {
        self.get(Counter::hands)
    }

    /// A money column by its name (`net`, `net_bb_milli`, ...).
    pub fn money(&self, key: &str) -> Option<i64> {
        MONEY_KEYS
            .iter()
            .position(|name| *name == key)
            .map(|index| self.money[index])
    }

    /// The inputs of a display definition (`rail_stats::display`, R2.4),
    /// without all-in EV (see [`crate::stats_read::HeroTotal::sums`]).
    pub fn sums(&self) -> rail_stats::display::Sums {
        rail_stats::display::Sums {
            counters: self.counters,
            money: self.money,
            money_hands: self.money_hands,
            ev_net_bb_milli: None,
        }
    }

    /// Read the counters, money and `money_hands` from `row`, starting at
    /// column `first` (the order of [`rollup_columns`]).
    pub(crate) fn from_row(row: &rusqlite::Row<'_>, first: usize) -> rusqlite::Result<Self> {
        let mut totals = Self::default();
        let get = |i: usize| -> rusqlite::Result<i64> {
            Ok(row.get::<_, Option<i64>>(first + i)?.unwrap_or(0))
        };
        for (i, value) in totals.counters.iter_mut().enumerate() {
            *value = get(i)?;
        }
        for (i, value) in totals.money.iter_mut().enumerate() {
            *value = get(COUNTER_COUNT + i)?;
        }
        totals.money_hands = get(COUNTER_COUNT + MONEY_COUNT)?;
        Ok(totals)
    }
}

/// The rollups' counter, money and `money_hands` columns, in table order.
pub fn rollup_columns() -> impl Iterator<Item = &'static str> {
    COUNTER_KEYS
        .into_iter()
        .chain(MONEY_KEYS)
        .chain(["money_hands"])
}

/// [`rollup_columns`], comma-separated, each wrapped by `wrap` (`sum({c})`,
/// `{c} = {c} + excluded.{c}`, ...).
pub(crate) fn total_columns(wrap: impl Fn(&str) -> String) -> String {
    rollup_columns().map(wrap).collect::<Vec<_>>().join(", ")
}

/// How many columns [`total_columns`] names.
const TOTAL_COUNT: usize = COUNTER_COUNT + MONEY_COUNT + 1;

fn placeholders(n: usize) -> String {
    (1..=n)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn upsert_player_sql() -> &'static str {
    static SQL: OnceLock<String> = OnceLock::new();
    SQL.get_or_init(|| {
        format!(
            "INSERT INTO player_rollups (site, player, scope, segment_id, last_played_at, {})
             VALUES ({})
             ON CONFLICT (site, player, scope, segment_id) DO UPDATE SET
               last_played_at = CASE WHEN excluded.last_played_at > coalesce(last_played_at, '')
                                     THEN excluded.last_played_at ELSE last_played_at END,
               {}",
            total_columns(str::to_owned),
            placeholders(5 + TOTAL_COUNT),
            total_columns(|c| format!("{c} = {c} + excluded.{c}"))
        )
    })
}

fn upsert_hero_sql() -> &'static str {
    static SQL: OnceLock<String> = OnceLock::new();
    SQL.get_or_init(|| {
        format!(
            "INSERT INTO hero_rollups (segment_id, position, day, kind, {})
             VALUES ({})
             ON CONFLICT (segment_id, position, day, kind) DO UPDATE SET {}",
            total_columns(str::to_owned),
            placeholders(4 + TOTAL_COUNT),
            total_columns(|c| format!("{c} = {c} + excluded.{c}"))
        )
    })
}

const INSERT_HAND_SQL: &str =
    "INSERT INTO hand_stats (hand_key, gen, played_at, segment_id, stats_version,
        site_anonymization, site_id, currency_minor_units, player_count, tournament_id,
        fast_fold, has_straddle, is_bomb_pot, is_big_blind_ante, is_run_it_twice, has_cashout,
        is_walk, street_reached, pot_type, total_pot, house_into_pot, fees)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, ?21, ?22)";

const INSERT_SEAT_SQL: &str = "INSERT INTO seat_stats (hand_id, seat, player, scope, is_hero,
        position, hole_cards, hand_class, starting_stack, starting_stack_bb_tenths, totals)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)";

const INSERT_LIST_SQL: &str = "INSERT INTO hand_list (played_at, hand_key, site_hand_id,
        segment_id, hero_position, hero_cards, hero_net, hero_net_bb_milli, hero_stack_bb_tenths,
        board, all_in, showdown, pot_type, currency_symbol)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)";

const UPSERT_EV_SQL: &str =
    "INSERT INTO ev_rows (hand_key, seat, ev_version, ev_net, ev_net_bb_milli)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (hand_key) DO UPDATE SET
       seat = excluded.seat, ev_version = excluded.ev_version, ev_net = excluded.ev_net,
       ev_net_bb_milli = excluded.ev_net_bb_milli";

/// Bind `totals` from parameter `first` on.
fn bind_totals(stmt: &mut Statement<'_>, first: usize, totals: &Totals) -> Result<()> {
    for (i, value) in totals.counters.iter().enumerate() {
        stmt.raw_bind_parameter(first + i, value)?;
    }
    for (i, value) in totals.money.iter().enumerate() {
        stmt.raw_bind_parameter(first + COUNTER_COUNT + i, value)?;
    }
    stmt.raw_bind_parameter(first + COUNTER_COUNT + MONEY_COUNT, totals.money_hands)?;
    Ok(())
}

fn to_i64(value: usize, what: &'static str) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::OutOfRange(what))
}

/// A `kv` value.
pub(crate) fn kv_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT value FROM kv WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
        .optional()?)
}

/// Set a `kv` value.
pub(crate) fn kv_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                         updated_at = excluded.updated_at",
    )?
    .execute(params![key, value, crate::time::now_ms()])?;
    Ok(())
}

fn kv_i64(conn: &Connection, key: &str) -> Result<Option<i64>> {
    kv_get(conn, key)?
        .map(|value| {
            value
                .parse()
                .map_err(|_| Error::Corrupt(format!("kv {key} is not a number: {value}")))
        })
        .transpose()
}

/// The generation the rollups count (0 before the first one).
pub fn current_gen(conn: &Connection) -> Result<i64> {
    Ok(kv_i64(conn, KV_GEN)?.unwrap_or(0))
}

/// `segments.id` of `segment`, added when new.
fn segment_id(conn: &Connection, segment: &Segment) -> Result<i64> {
    let stake = segment.stake.key();
    let key = params![
        segment.site,
        segment.format.as_str(),
        segment.variant.as_str(),
        segment.limit.as_str(),
        segment.size.as_str(),
        stake
    ];
    let found: Option<i64> = conn
        .prepare_cached(
            "SELECT id FROM segments WHERE site = ?1 AND game_format = ?2 AND variant = ?3
                                       AND limit_type = ?4 AND size_class = ?5 AND stake = ?6",
        )?
        .query_row(key, |row| row.get(0))
        .optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    Ok(conn
        .prepare_cached(
            "INSERT INTO segments (site, game_format, variant, limit_type, size_class, stake)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
        )?
        .query_row(key, |row| row.get(0))?)
}

/// A player's rollup key: site, player, scope, segment.
type PlayerKey = (String, String, String, i64);
/// A hero rollup key: segment, position (`""` for none), UTC day, kind.
type HeroKey = (i64, String, String, i64);

/// The UTC day of an ISO `played_at`, `""` without one.
pub(crate) fn day_of(played_at: Option<&str>) -> &str {
    played_at.and_then(|at| at.get(..10)).unwrap_or("")
}

/// Statistics written in one transaction: the rows as they come, the
/// rollups summed in memory and added by [`Pending::flush`]. A group of
/// batches (`writer::commit_group`) gives each batch a [`Pending::child`]
/// and [`Pending::merge`]s it once the batch's savepoint commits.
#[derive(Debug)]
pub(crate) struct Pending {
    generation: i64,
    segments: HashMap<Segment, i64>,
    players: HashMap<PlayerKey, (Totals, Option<String>)>,
    heroes: HashMap<HeroKey, Totals>,
}

impl Pending {
    /// For the current generation.
    pub(crate) fn new(conn: &Connection) -> Result<Self> {
        Ok(Self {
            generation: current_gen(conn)?,
            segments: HashMap::new(),
            players: HashMap::new(),
            heroes: HashMap::new(),
        })
    }

    /// An empty one for a batch inside this one's transaction (the
    /// segments known so far shared).
    pub(crate) fn child(&self) -> Self {
        Self {
            generation: self.generation,
            segments: self.segments.clone(),
            players: HashMap::new(),
            heroes: HashMap::new(),
        }
    }

    /// Take a committed batch's sums (and the segments it added).
    pub(crate) fn merge(&mut self, child: Self) {
        self.segments.extend(child.segments);
        for (key, (totals, last)) in child.players {
            let (sum, newest) = self.players.entry(key).or_default();
            sum.add(&totals, true);
            if last > *newest {
                *newest = last;
            }
        }
        for (key, totals) in child.heroes {
            self.heroes.entry(key).or_default().add(&totals, true);
        }
    }

    fn segment_id(&mut self, conn: &Connection, segment: &Segment) -> Result<i64> {
        if let Some(&id) = self.segments.get(segment) {
            return Ok(id);
        }
        let id = segment_id(conn, segment)?;
        self.segments.insert(segment.clone(), id);
        Ok(id)
    }

    /// Write a hand's rows (it has none) and count them.
    fn add_rows(&mut self, conn: &Connection, hand_key: &str, stats: &PreparedStats) -> Result<()> {
        let Some(first) = stats.rows.first().map(|seat| &seat.row) else {
            return Ok(());
        };
        let segment_id = self.segment_id(conn, &stats.segment)?;
        let hand = &first.hand;
        conn.prepare_cached(INSERT_HAND_SQL)?.execute(params![
            hand_key,
            self.generation,
            hand.played_at,
            segment_id,
            hand.stats_version,
            stats.anonymization.as_str(),
            hand.site_id,
            hand.currency_minor_units,
            to_i64(hand.player_count, "player_count")?,
            hand.tournament_id,
            hand.fast_fold,
            hand.has_straddle,
            hand.is_bomb_pot,
            hand.is_big_blind_ante,
            hand.is_run_it_twice,
            hand.has_cashout,
            hand.is_walk,
            hand.street_reached.as_str(),
            hand.pot_type.as_str(),
            hand.total_pot,
            hand.house_into_pot,
            hand.fees,
        ])?;
        // `execute` + the rowid rather than `RETURNING id` through
        // `query_row`: profiled, that spent a third of the insert's time in
        // resetting the statement.
        let hand_id = conn.last_insert_rowid();
        let kind = kind_of(first);
        let (counted, money) = Exclusions::default().admits(kind);
        let played_at = hand.played_at.as_deref();
        let day = day_of(played_at);
        // The Hands list's row (R2.7a), deleted with the `hand_stats` row by
        // a trigger.
        let hero = stats.rows.iter().find(|seat| seat.row.seat.is_hero);
        conn.prepare_cached(INSERT_LIST_SQL)?.execute(params![
            played_at.unwrap_or(""),
            hand_key,
            hand.hand_id,
            segment_id,
            hero.and_then(|seat| seat.row.seat.position.map(|position| position.as_str())),
            hero.map(|seat| seat.hole_cards.as_str()),
            hero.map(|seat| seat.values.net()),
            hero.map(|seat| seat.values.net_bb_milli()),
            hero.map(|seat| seat.row.seat.starting_stack_bb_tenths),
            stats.list.board,
            stats.list.all_in,
            stats.list.showdown,
            hand.pot_type.as_str(),
            stats.list.currency_symbol,
        ])?;
        let mut insert = conn.prepare_cached(INSERT_SEAT_SQL)?;
        for prepared in &stats.rows {
            let (seat, scope, values) = (&prepared.row.seat, &prepared.scope, &prepared.values);
            let position = seat.position.map(|position| position.as_str());
            insert.execute(params![
                hand_id,
                seat.seat,
                seat.player,
                scope,
                seat.is_hero,
                position,
                prepared.hole_cards,
                seat.hand_class,
                seat.starting_stack,
                seat.starting_stack_bb_tenths,
                prepared.totals,
            ])?;
            // The HUD's sums: `aggregate`'s defaults.
            if counted {
                let (totals, last) = self
                    .players
                    .entry((
                        stats.segment.site.clone(),
                        seat.player.clone(),
                        scope.clone(),
                        segment_id,
                    ))
                    .or_default();
                totals.add_seat(values, money);
                if played_at > last.as_deref() {
                    *last = played_at.map(str::to_owned);
                }
            }
            // The hero's: everything, by kind.
            if seat.is_hero {
                self.heroes
                    .entry((
                        segment_id,
                        position.unwrap_or("").to_owned(),
                        day.to_owned(),
                        kind,
                    ))
                    .or_default()
                    .add_seat(values, true);
            }
        }
        Ok(())
    }

    /// A hand new to the store: its rows, and its EV row or its place in the
    /// EV queue.
    pub(crate) fn add_hand(
        &mut self,
        conn: &Connection,
        hand_key: &str,
        stats: &PreparedStats,
    ) -> Result<()> {
        self.add_rows(conn, hand_key, stats)?;
        match &stats.ev {
            EvPlan::NoHero => {}
            EvPlan::Row(row) => {
                if row.applicable {
                    upsert_ev(conn, row)?;
                }
            }
            EvPlan::Deferred => enqueue_ev(conn, hand_key)?,
        }
        Ok(())
    }

    /// Add the sums to the rollups.
    pub(crate) fn flush(self, conn: &Connection) -> Result<()> {
        if !self.players.is_empty() {
            let mut upsert = conn.prepare_cached(upsert_player_sql())?;
            for ((site, player, scope, segment_id), (totals, last)) in &self.players {
                upsert.raw_bind_parameter(1, site)?;
                upsert.raw_bind_parameter(2, player)?;
                upsert.raw_bind_parameter(3, scope)?;
                upsert.raw_bind_parameter(4, segment_id)?;
                upsert.raw_bind_parameter(5, last)?;
                bind_totals(&mut upsert, 6, totals)?;
                upsert.raw_execute()?;
            }
        }
        if !self.heroes.is_empty() {
            let mut upsert = conn.prepare_cached(upsert_hero_sql())?;
            for ((segment_id, position, day, kind), totals) in &self.heroes {
                upsert.raw_bind_parameter(1, segment_id)?;
                upsert.raw_bind_parameter(2, position)?;
                upsert.raw_bind_parameter(3, day)?;
                upsert.raw_bind_parameter(4, kind)?;
                bind_totals(&mut upsert, 5, totals)?;
                upsert.raw_execute()?;
            }
        }
        Ok(())
    }
}

/// Store (or replace) an applicable EV row.
fn upsert_ev(conn: &Connection, row: &EvRow) -> Result<()> {
    conn.prepare_cached(UPSERT_EV_SQL)?.execute(params![
        row.hand_key,
        row.seat,
        row.ev_version,
        row.ev_net,
        row.ev_net_bb_milli
    ])?;
    Ok(())
}

/// A hand's EV is known now: an applicable row is stored, any other leaves
/// none; the hand leaves the queue.
fn settle_ev(conn: &Connection, hand_key: &str, row: Option<&EvRow>) -> Result<()> {
    match row.filter(|row| row.applicable) {
        Some(row) => upsert_ev(conn, row)?,
        None => {
            conn.prepare_cached("DELETE FROM ev_rows WHERE hand_key = ?1")?
                .execute([hand_key])?;
        }
    }
    conn.prepare_cached("DELETE FROM ev_pending WHERE hand_key = ?1")?
        .execute([hand_key])?;
    Ok(())
}

/// Queue a hand for the background EV pass.
fn enqueue_ev(conn: &Connection, hand_key: &str) -> Result<()> {
    conn.prepare_cached("INSERT OR IGNORE INTO ev_pending (hand_key) VALUES (?1)")?
        .execute([hand_key])?;
    Ok(())
}

/// Start a new generation: empty rollups, every stored hand to be derived
/// again by the background pass (resumable, through `kv`). Returns the hands
/// to go through.
pub fn begin_rebuild(conn: &Connection) -> Result<u64> {
    let generation = current_gen(conn)? + 1;
    kv_set(conn, KV_GEN, &generation.to_string())?;
    kv_set(conn, KV_VERSION, STATS_VERSION)?;
    conn.execute("DELETE FROM player_rollups", [])?;
    conn.execute("DELETE FROM hero_rollups", [])?;
    let total: i64 = conn.query_row("SELECT count(*) FROM hands", [], |row| row.get(0))?;
    if total > 0 {
        kv_set(conn, KV_REBUILD_CURSOR, "")?;
        kv_set(conn, KV_REBUILD_DONE, "0")?;
        kv_set(conn, KV_REBUILD_TOTAL, &total.to_string())?;
    } else {
        end_rebuild(conn)?;
    }
    u64::try_from(total).map_err(|_| Error::OutOfRange("hands"))
}

fn end_rebuild(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM kv WHERE key IN (?1, ?2, ?3)",
        params![KV_REBUILD_CURSOR, KV_REBUILD_DONE, KV_REBUILD_TOTAL],
    )?;
    Ok(())
}

/// Every hero hand to the EV queue (an `EV_VERSION` bump, or "compute EV
/// again"). Returns how many were queued.
pub fn requeue_ev(conn: &Connection) -> Result<u64> {
    kv_set(conn, KV_EV_VERSION, EV_VERSION)?;
    let queued = conn.execute(
        "INSERT OR IGNORE INTO ev_pending (hand_key)
         SELECT d.hand_key FROM hand_stats d
         WHERE EXISTS (SELECT 1 FROM seat_stats s WHERE s.hand_id = d.id AND s.is_hero = 1)
         ORDER BY d.id",
        [],
    )?;
    u64::try_from(queued).map_err(|_| Error::OutOfRange("queued"))
}

/// On open: a store whose rollups were built under another `STATS_VERSION`
/// (or never: a store from before R2.3) starts a rebuild; one evaluated at
/// another `EV_VERSION` queues every hero hand.
pub(crate) fn ensure_current(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    if kv_get(&tx, KV_VERSION)?.as_deref() != Some(STATS_VERSION) {
        begin_rebuild(&tx)?;
    }
    if kv_get(&tx, KV_EV_VERSION)?.as_deref() != Some(EV_VERSION) {
        requeue_ev(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

/// Where a rebuild stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildState {
    /// The last `hand_key` done (`""` before the first page).
    pub cursor: String,
    pub done: u64,
    pub total: u64,
}

/// The running rebuild, if any.
pub fn rebuild_state(conn: &Connection) -> Result<Option<RebuildState>> {
    let Some(cursor) = kv_get(conn, KV_REBUILD_CURSOR)? else {
        return Ok(None);
    };
    let count =
        |key| -> Result<u64> { Ok(u64::try_from(kv_i64(conn, key)?.unwrap_or(0)).unwrap_or(0)) };
    Ok(Some(RebuildState {
        cursor,
        done: count(KV_REBUILD_DONE)?,
        total: count(KV_REBUILD_TOTAL)?,
    }))
}

/// One page of a rebuild, derived by the background pass: per hand its
/// statistics (`None`: its PHF could not be read back - its rows go).
#[derive(Debug)]
pub struct RebuildPage {
    /// The cursor the page was read after: if the rebuild moved on (or
    /// restarted) since, the page is stale and dropped.
    pub after: String,
    pub hands: Vec<(String, Option<PreparedStats>)>,
}

/// The hero's seat, net and net in thousandths of a big blind: an EV result
/// stays valid while these do not change (`handEvRow` reads nothing else of
/// the statistics).
type HeroFacts = (u32, i64, i64);

fn hero_facts(row: &StatsRow) -> HeroFacts {
    (
        row.seat.seat,
        row.seat.money.net,
        row.seat.money.net_bb_milli,
    )
}

/// Apply one rebuild page: each hand whose rows are of an older generation
/// (or that has none) gets new rows, counted in the current one; a hand
/// already counted (imported since the rebuild began) is left. The cursor
/// moves in the same transaction. Returns whether the page applied
/// (`false`: stale).
pub fn apply_rebuild_page(conn: &Connection, page: &RebuildPage) -> Result<bool> {
    let Some(state) = rebuild_state(conn)? else {
        return Ok(false);
    };
    if state.cursor != page.after {
        return Ok(false);
    }
    let mut pending = Pending::new(conn)?;
    for (hand_key, stats) in &page.hands {
        let existing: Option<(i64, i64)> = conn
            .prepare_cached("SELECT id, gen FROM hand_stats WHERE hand_key = ?1")?
            .query_row([hand_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let mut old_hero: Option<HeroFacts> = None;
        if let Some((id, generation)) = existing {
            if generation == pending.generation {
                continue;
            }
            let hero: Option<(u32, Vec<u8>)> = conn
                .prepare_cached(
                    "SELECT seat, totals FROM seat_stats WHERE hand_id = ?1 AND is_hero = 1
                     ORDER BY seat LIMIT 1",
                )?
                .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?;
            if let Some((seat, blob)) = hero {
                let values = decode_seat(&blob)?;
                old_hero = Some((seat, values.net(), values.net_bb_milli()));
            }
            conn.prepare_cached("DELETE FROM hand_stats WHERE id = ?1")?
                .execute([id])?;
        }
        let Some(stats) = stats else {
            continue;
        };
        pending.add_rows(conn, hand_key, stats)?;
        match &stats.ev {
            EvPlan::NoHero => settle_ev(conn, hand_key, None)?,
            EvPlan::Row(row) => settle_ev(conn, hand_key, Some(row))?,
            EvPlan::Deferred => {
                let queued = conn
                    .prepare_cached("SELECT 1 FROM ev_pending WHERE hand_key = ?1")?
                    .exists([hand_key])?;
                // Evaluated before, for the same hero result: still right.
                let valid =
                    !queued && old_hero.is_some() && old_hero == stats.hero().map(hero_facts);
                if valid {
                    // The list's flag is what that evaluation found.
                    let applicable = conn
                        .prepare_cached("SELECT 1 FROM ev_rows WHERE hand_key = ?1")?
                        .exists([hand_key])?;
                    set_list_all_in(conn, hand_key, applicable)?;
                } else {
                    enqueue_ev(conn, hand_key)?;
                }
            }
        }
    }
    pending.flush(conn)?;
    match page.hands.last() {
        Some((last, _)) => {
            let done = state.done + u64::try_from(page.hands.len()).unwrap_or(0);
            kv_set(conn, KV_REBUILD_CURSOR, last)?;
            kv_set(conn, KV_REBUILD_DONE, &done.to_string())?;
        }
        None => end_rebuild(conn)?,
    }
    Ok(true)
}

/// Apply EV results computed by the background pass: per hand its row
/// (`None`: no hero after all, or its PHF could not be read back). Each
/// hand leaves the queue.
pub fn apply_ev_rows(conn: &Connection, rows: &[(String, Option<EvRow>)]) -> Result<()> {
    for (hand_key, row) in rows {
        settle_ev(conn, hand_key, row.as_ref())?;
        set_list_all_in(
            conn,
            hand_key,
            row.as_ref().is_some_and(|row| row.applicable),
        )?;
    }
    Ok(())
}

/// The list's all-in flag of a hand once its EV is known (a preflop
/// all-in's row was written with the flag on, before the pass evaluated
/// it: [`crate::ListFacts::all_in`]).
fn set_list_all_in(conn: &Connection, hand_key: &str, all_in: bool) -> Result<()> {
    conn.prepare_cached(
        "UPDATE hand_list SET all_in = ?2
         WHERE hand_key = ?1
           AND played_at = (SELECT coalesce(played_at, '') FROM hand_stats WHERE hand_key = ?1)
           AND all_in <> ?2",
    )?
    .execute(params![hand_key, all_in])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MONEY_COUNT, SeatValues, decode_seat, encode_seat};
    use rail_stats::COUNTER_COUNT;

    #[test]
    fn seat_values_round_trip() {
        let mut values = SeatValues {
            counters: [0; COUNTER_COUNT],
            money: [0; MONEY_COUNT],
        };
        assert!(encode_seat(&values).is_empty());
        values.counters[0] = 1;
        values.counters[17] = 300;
        values.counters[COUNTER_COUNT - 1] = u32::MAX;
        values.money = [5, -7, i64::MIN, i64::MAX, 1 << 40, -(1 << 40), -1];
        let bytes = encode_seat(&values);
        assert_eq!(decode_seat(&bytes).expect("decode"), values);
        assert!(decode_seat(&bytes[..bytes.len() - 1]).is_err());
        assert!(decode_seat(&[120, 2]).is_err(), "no such column");
    }
}
