//! Targeted recompute (docs/RAIL-PLAN.md R2.11; guideline §5, "ciljani
//! preračun": when a definition changes, a background job recomputes only
//! what it touches, not the whole store).
//!
//! - **The dependency map** ([`DEPENDENCIES`]): for each kind of change - a
//!   definition's display fields, a formula, a custom predicate, the
//!   decision events, a coded statistic (`STATS_VERSION`), the segment
//!   definition (`SEGMENT_VERSION`), the all-in EV (`EV_VERSION`) - the work
//!   it needs and every table that work writes, with how much of it. What
//!   a change does not name it leaves alone, and the tests check that table
//!   by table (`tests/recompute.rs`).
//! - **Three jobs**, run by the background pass ([`crate::background`]),
//!   resumable (their state is in `kv`), paused while a backfill imports or
//!   tables are open:
//!   - the **rows** job ([`RowsJob::Rows`]: a `STATS_VERSION` bump,
//!     "rebuild statistics", a store an older build left mid-rebuild):
//!     every hand derived again from its stored PHF, in `hands` row order,
//!     and compared with its stored rows. Only a hand whose rows come out
//!     different is staged (`recompute_hands`, `recompute_seats`,
//!     `recompute_list`, by part: the hand's columns, its seat rows, its
//!     list row); one whose rows are the same is not rewritten (its
//!     `hand_stats.stats_version` is stamped). Every hand's new rows are
//!     summed into the rollups' twins (`recompute_player_rollups`, ...). A
//!     hand without rows (a store from before R2.3) gets them at once, as an
//!     import would.
//!   - the **segments** job ([`RowsJob::Segments`]: a `SEGMENT_VERSION`
//!     bump): each hand's segment from its PHF, the stored seat rows summed
//!     under it into the twins - no statistic derived again; a hand whose
//!     segment changed has its `segment_id` staged.
//!   - the **EV** job (an `EV_VERSION` bump, "compute all-in EV again"):
//!     every hero hand evaluated again into `recompute_ev`.
//! - **Swapped in whole.** Each job ends with one transaction that writes
//!   the staged rows, renames the twins into place and moves `kv`
//!   `stats.epoch` on. Until it commits a reader sees the old statistics,
//!   whole; after it, the new ones - never a rollup half rebuilt (R2.3's
//!   rebuild emptied the rollups and refilled them). A reader that spreads
//!   one answer over several connections compares the epoch before and
//!   after ([`Reader::report_open`], the breakdowns' pass).
//! - **Stable ids.** A hand keeps its `hand_stats.id` (R2.3's rebuild gave
//!   every hand a new one, which cleared every custom count). The user's own
//!   statistics are counted by id, on the kept seats: they survive any
//!   recompute that moves no seat between rollup keys (segment, kind, day,
//!   seat, player, scope, position); one that does clears them and the
//!   custom pass counts them again after the swap.
//!
//! Imports go on meanwhile: a new hand is derived by this build, written
//! and counted at once (the screens' rollups), and the job reaches it too
//! (it has a higher `hands` rowid) and sums it into the twins.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use rail_core::phf::GameFormat;
use rail_equity::EV_VERSION;
use rail_stats::{SEGMENT_VERSION, STATS_VERSION, Segment};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::background::hand_from;
use crate::batch::{EvPlan, PreparedStats};
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::stats::{
    HandSum, KIND_BOMB_POT, KIND_CASHOUT, KIND_STRADDLED, KV_EPOCH, KV_EV_VERSION, KV_GEN,
    KV_PLAYERS_INDEXED, KV_REBUILD_CURSOR, KV_REBUILD_DONE, KV_REBUILD_TOTAL, KV_SEGMENT_VERSION,
    KV_VERSION, Pending, SeatSum, SeatValues, Summed, Target, current_gen, decode_seat, enqueue_ev,
    kv_get, kv_i64, kv_set, set_list_all_in, settle_ev,
};
use crate::writer::WriterHandle;

/* ----------------------------------------------------- the dependency map - */

/// A table the statistics derive (every one of them: the tests check it
/// against the schema).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Table {
    Segments,
    HandStats,
    SeatStats,
    HandList,
    PlayerRollups,
    /// (R3.7) `player_rollups`' part from hands without a hero seat.
    PlayerRollupsObserved,
    HeroRollups,
    PlayerSummary,
    PlayerHidden,
    PlayerHands,
    EvRows,
    EvPending,
    CustomHeroRows,
    CustomHeroRollups,
    CustomPlayerRollups,
    /// (R3.7) `custom_player_rollups`' part from hands without a hero seat.
    CustomPlayerRollupsObserved,
}

impl Table {
    /// Every derived table.
    pub const ALL: [Self; 16] = [
        Self::Segments,
        Self::HandStats,
        Self::SeatStats,
        Self::HandList,
        Self::PlayerRollups,
        Self::PlayerRollupsObserved,
        Self::HeroRollups,
        Self::PlayerSummary,
        Self::PlayerHidden,
        Self::PlayerHands,
        Self::EvRows,
        Self::EvPending,
        Self::CustomHeroRows,
        Self::CustomHeroRollups,
        Self::CustomPlayerRollups,
        Self::CustomPlayerRollupsObserved,
    ];

    /// The table's name in the store.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Segments => "segments",
            Self::HandStats => "hand_stats",
            Self::SeatStats => "seat_stats",
            Self::HandList => "hand_list",
            Self::PlayerRollups => "player_rollups",
            Self::PlayerRollupsObserved => "player_rollups_observed",
            Self::HeroRollups => "hero_rollups",
            Self::PlayerSummary => "player_summary",
            Self::PlayerHidden => "player_hidden",
            Self::PlayerHands => "player_hands",
            Self::EvRows => "ev_rows",
            Self::EvPending => "ev_pending",
            Self::CustomHeroRows => "custom_hero_rows",
            Self::CustomHeroRollups => "custom_hero_rollups",
            Self::CustomPlayerRollups => "custom_player_rollups",
            Self::CustomPlayerRollupsObserved => "custom_player_rollups_observed",
        }
    }
}

/// How much of a table a change writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Extent {
    /// Summed again from every hand's (new) rows into the table's twin,
    /// swapped in at the end.
    Resummed,
    /// The rows of the hands whose derived values come out different
    /// (staged, written by the swap); `hand_stats` also has its
    /// `stats_version` stamped on the others.
    Changed,
    /// A row for a segment the store has not seen yet.
    Added,
    /// The hands whose hero seat or result changed: their EV row kept,
    /// replaced, dropped or queued again by the swap.
    HeroChanged,
    /// Every hero hand's EV evaluated again (beside), swapped in; the
    /// list's all-in flag of the hands whose row came or went.
    Reevaluated,
    /// One custom statistic's counts: cleared, and counted again by the
    /// custom pass.
    OneStatistic,
    /// Every custom statistic's counts: cleared and counted again.
    AllStatistics,
    /// Every custom statistic's counts, cleared and counted again **only if**
    /// a hand's seats moved between rollup keys (segment, kind, day, seat,
    /// player, scope, position); otherwise untouched.
    IfSeatsMoved,
}

/// What changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// A definition's label, name, description, format, colour bands,
    /// sample or HUD membership (R2.4): nothing stored depends on them.
    Display,
    /// A formula over counters the store has, shipped or custom: evaluated
    /// when read (`rail_stats::display`), over sums that do not change.
    Formula,
    /// A custom statistic's predicate (R2.10).
    Predicate,
    /// `rail_stats::custom::EVENTS_VERSION`: the decision events every
    /// predicate reads.
    Events,
    /// `STATS_VERSION`: a coded counter, the money, a hand or seat column,
    /// or which seats are kept.
    Stats,
    /// `rail_stats::SEGMENT_VERSION`: which segment a hand is in.
    Segments,
    /// `rail_equity::EV_VERSION`: the all-in EV.
    Ev,
}

/// The work a change needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    /// None: the change is read where it is shown.
    Nothing,
    /// The custom pass counts again (`custom_stats.counted_to` back to 0).
    Recount,
    /// The rows job ([`RowsJob::Rows`]).
    Rows,
    /// The segments job ([`RowsJob::Segments`]).
    Regroup,
    /// The EV job.
    Reevaluate,
}

/// One line of the dependency map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dependency {
    pub change: Change,
    pub work: Work,
    /// Every table the work writes, and how much of it; any other derived
    /// table is left as it is.
    pub writes: &'static [(Table, Extent)],
}

/// The dependency map: one line per [`Change`].
pub const DEPENDENCIES: [Dependency; 7] = [
    Dependency {
        change: Change::Display,
        work: Work::Nothing,
        writes: &[],
    },
    Dependency {
        change: Change::Formula,
        work: Work::Nothing,
        writes: &[],
    },
    Dependency {
        change: Change::Predicate,
        work: Work::Recount,
        writes: &[
            (Table::CustomHeroRows, Extent::OneStatistic),
            (Table::CustomHeroRollups, Extent::OneStatistic),
            (Table::CustomPlayerRollups, Extent::OneStatistic),
            (Table::CustomPlayerRollupsObserved, Extent::OneStatistic),
        ],
    },
    Dependency {
        change: Change::Events,
        work: Work::Recount,
        writes: &[
            (Table::CustomHeroRows, Extent::AllStatistics),
            (Table::CustomHeroRollups, Extent::AllStatistics),
            (Table::CustomPlayerRollups, Extent::AllStatistics),
            (Table::CustomPlayerRollupsObserved, Extent::AllStatistics),
        ],
    },
    Dependency {
        change: Change::Stats,
        work: Work::Rows,
        writes: &[
            (Table::Segments, Extent::Added),
            (Table::HandStats, Extent::Changed),
            (Table::SeatStats, Extent::Changed),
            (Table::HandList, Extent::Changed),
            (Table::PlayerRollups, Extent::Resummed),
            (Table::PlayerRollupsObserved, Extent::Resummed),
            (Table::HeroRollups, Extent::Resummed),
            (Table::PlayerSummary, Extent::Resummed),
            (Table::PlayerHidden, Extent::Resummed),
            (Table::PlayerHands, Extent::Changed),
            (Table::EvRows, Extent::HeroChanged),
            (Table::EvPending, Extent::HeroChanged),
            (Table::CustomHeroRows, Extent::IfSeatsMoved),
            (Table::CustomHeroRollups, Extent::IfSeatsMoved),
            (Table::CustomPlayerRollups, Extent::IfSeatsMoved),
            (Table::CustomPlayerRollupsObserved, Extent::IfSeatsMoved),
        ],
    },
    Dependency {
        change: Change::Segments,
        work: Work::Regroup,
        writes: &[
            (Table::Segments, Extent::Added),
            (Table::HandStats, Extent::Changed),
            (Table::HandList, Extent::Changed),
            (Table::PlayerRollups, Extent::Resummed),
            (Table::PlayerRollupsObserved, Extent::Resummed),
            (Table::HeroRollups, Extent::Resummed),
            (Table::PlayerSummary, Extent::Resummed),
            (Table::PlayerHidden, Extent::Resummed),
            (Table::CustomHeroRows, Extent::IfSeatsMoved),
            (Table::CustomHeroRollups, Extent::IfSeatsMoved),
            (Table::CustomPlayerRollups, Extent::IfSeatsMoved),
            (Table::CustomPlayerRollupsObserved, Extent::IfSeatsMoved),
        ],
    },
    Dependency {
        change: Change::Ev,
        work: Work::Reevaluate,
        writes: &[
            (Table::EvRows, Extent::Reevaluated),
            (Table::HandList, Extent::Reevaluated),
        ],
    },
];

/// The line of `change`.
pub fn dependency(change: Change) -> &'static Dependency {
    DEPENDENCIES
        .iter()
        .find(|line| line.change == change)
        .unwrap_or(&DEPENDENCIES[0])
}

/* ------------------------------------------------------------ job state - */

/// `kv`: the rows job running, `rows` or `segments`...
const KV_ROWS_JOB: &str = "recompute.rows.job";
/// ...the versions it works out (`<STATS_VERSION> <SEGMENT_VERSION>`; a
/// build of other versions starts it again)...
const KV_ROWS_TARGET: &str = "recompute.rows.target";
/// ...the last `hands` rowid it has gone through...
const KV_ROWS_CURSOR: &str = "recompute.rows.cursor";
/// ...how many hands that is...
const KV_ROWS_DONE: &str = "recompute.rows.done";
/// ...how many there were when it began...
const KV_ROWS_TOTAL: &str = "recompute.rows.total";
/// ...of which without rows of the current generation (they are written
/// as the job goes: the screens grow)...
const KV_ROWS_FILLS: &str = "recompute.rows.fills";
/// ...and `1` once a hand's seats moved between rollup keys: the swap clears
/// the custom counts.
const KV_ROWS_CUSTOM: &str = "recompute.rows.custom";
/// `kv`: the EV job's `EV_VERSION`...
const KV_EV_TARGET: &str = "recompute.ev.target";
/// ...the hands it has evaluated...
const KV_EV_DONE: &str = "recompute.ev.done";
/// ...and how many it had to.
const KV_EV_TOTAL: &str = "recompute.ev.total";

/// Hands per page of the rows job (one writer transaction each).
pub const ROWS_PAGE: u32 = 500;
/// Hands per page of the EV job, read at once...
pub const EV_PAGE: u32 = 256;
/// ...and evaluated until this much time has gone (a preflop all-in takes
/// 25-46 ms), so a pause or a quit is answered within it.
pub const EV_BUDGET: Duration = Duration::from_millis(250);

/// Which rows job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowsJob {
    /// Every hand derived again from its PHF and compared.
    Rows,
    /// Only the segments: the stored seat rows regrouped.
    Segments,
}

impl RowsJob {
    /// `rows`, `segments`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rows => "rows",
            Self::Segments => "segments",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "rows" => Some(Self::Rows),
            "segments" => Some(Self::Segments),
            _ => None,
        }
    }
}

/// Where the rows job stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildState {
    pub job: RowsJob,
    /// The last `hands` rowid done (0 before the first page).
    pub cursor: i64,
    pub done: u64,
    pub total: u64,
    /// Hands that had no rows of the current generation when it began: the
    /// job writes theirs as it goes, so the screens grow meanwhile. With 0,
    /// the screens show the old statistics, whole, until the swap.
    pub fills: u64,
}

/// Where the EV job stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvRecomputeState {
    pub done: u64,
    pub total: u64,
}

fn count(conn: &Connection, key: &str) -> Result<u64> {
    Ok(u64::try_from(kv_i64(conn, key)?.unwrap_or(0)).unwrap_or(0))
}

fn target() -> String {
    format!("{STATS_VERSION} {SEGMENT_VERSION}")
}

/// The running rows job, if any.
pub fn rows_state(conn: &Connection) -> Result<Option<RebuildState>> {
    let Some(job) = kv_get(conn, KV_ROWS_JOB)? else {
        return Ok(None);
    };
    let job = RowsJob::from_name(&job)
        .ok_or_else(|| Error::Corrupt(format!("kv {KV_ROWS_JOB}: {job}")))?;
    Ok(Some(RebuildState {
        job,
        cursor: kv_i64(conn, KV_ROWS_CURSOR)?.unwrap_or(0),
        done: count(conn, KV_ROWS_DONE)?,
        total: count(conn, KV_ROWS_TOTAL)?,
        fills: count(conn, KV_ROWS_FILLS)?,
    }))
}

/// The running EV job, if any.
pub fn ev_state(conn: &Connection) -> Result<Option<EvRecomputeState>> {
    if kv_get(conn, KV_EV_TARGET)?.is_none() {
        return Ok(None);
    }
    Ok(Some(EvRecomputeState {
        done: count(conn, KV_EV_DONE)?,
        total: count(conn, KV_EV_TOTAL)?,
    }))
}

/// The store's epoch: moved on by every swap.
pub fn epoch(conn: &Connection) -> Result<i64> {
    Ok(kv_i64(conn, KV_EPOCH)?.unwrap_or(0))
}

fn next_epoch(conn: &Connection) -> Result<()> {
    kv_set(conn, KV_EPOCH, &(epoch(conn)? + 1).to_string())
}

/// The custom pass waits: a rows job runs that will clear the custom counts
/// when it swaps (a hand's seats moved).
pub(crate) fn custom_on_hold(conn: &Connection) -> Result<bool> {
    Ok(kv_get(conn, KV_ROWS_JOB)?.is_some()
        && kv_get(conn, KV_ROWS_CUSTOM)?.as_deref() == Some("1"))
}

fn delete_kv(conn: &Connection, keys: &[&str]) -> Result<()> {
    let mut stmt = conn.prepare_cached("DELETE FROM kv WHERE key = ?1")?;
    for key in keys {
        stmt.execute([key])?;
    }
    Ok(())
}

/// Empty the rows job's staging tables and the twins.
fn clear_rows_work(conn: &Connection) -> Result<()> {
    for table in ["recompute_hands", "recompute_seats", "recompute_list"] {
        conn.execute(&format!("DELETE FROM {table}"), [])?;
    }
    for summed in Summed::ALL {
        conn.execute(&format!("DELETE FROM {}", Target::Shadow.table(summed)), [])?;
    }
    delete_kv(
        conn,
        &[
            KV_ROWS_JOB,
            KV_ROWS_TARGET,
            KV_ROWS_CURSOR,
            KV_ROWS_DONE,
            KV_ROWS_TOTAL,
            KV_ROWS_FILLS,
            KV_ROWS_CUSTOM,
        ],
    )
}

/// Start (or start again) a rows job: every hand to go through, the
/// statistics the screens read untouched until the swap. Returns the hands
/// to go through.
pub fn begin_rows(conn: &Connection, job: RowsJob) -> Result<u64> {
    clear_rows_work(conn)?;
    if kv_get(conn, KV_GEN)?.is_none() {
        kv_set(conn, KV_GEN, "1")?;
    }
    let generation = current_gen(conn)?;
    let hands: i64 = conn.query_row("SELECT count(*) FROM hands", [], |row| row.get(0))?;
    let current: i64 = conn.query_row(
        "SELECT count(*) FROM hand_stats WHERE gen = ?1",
        [generation],
        |row| row.get(0),
    )?;
    kv_set(conn, KV_ROWS_JOB, job.as_str())?;
    kv_set(conn, KV_ROWS_TARGET, &target())?;
    kv_set(conn, KV_ROWS_CURSOR, "0")?;
    kv_set(conn, KV_ROWS_DONE, "0")?;
    kv_set(conn, KV_ROWS_TOTAL, &hands.to_string())?;
    kv_set(conn, KV_ROWS_FILLS, &(hands - current).max(0).to_string())?;
    if hands == 0 {
        finish_rows(conn)?;
    }
    u64::try_from(hands).map_err(|_| Error::OutOfRange("hands"))
}

/// Start (or start again) the EV job: every hero hand not in the EV queue
/// evaluated again, the stored rows kept until the swap. Returns the hands
/// to evaluate.
pub fn begin_ev(conn: &Connection) -> Result<u64> {
    conn.execute("DELETE FROM recompute_ev", [])?;
    let queued = conn.execute(
        "INSERT INTO recompute_ev (hand_key)
         SELECT d.hand_key FROM hand_stats d
         WHERE EXISTS (SELECT 1 FROM seat_stats s WHERE s.hand_id = d.id AND s.is_hero = 1)
           AND NOT EXISTS (SELECT 1 FROM ev_pending p WHERE p.hand_key = d.hand_key)",
        [],
    )?;
    kv_set(conn, KV_EV_TARGET, EV_VERSION)?;
    kv_set(conn, KV_EV_DONE, "0")?;
    kv_set(conn, KV_EV_TOTAL, &queued.to_string())?;
    if queued == 0 {
        finish_ev(conn)?;
    }
    u64::try_from(queued).map_err(|_| Error::OutOfRange("queued"))
}

/// On open: statistics of another `STATS_VERSION` (or none yet, or a
/// rebuild an older build had not finished) start the rows job; rollups
/// grouped under another `SEGMENT_VERSION` the segments job; EV rows of
/// another `EV_VERSION` the EV job. A job this build started before (the
/// app quit, crashed) goes on where it stopped.
pub(crate) fn ensure_current(conn: &Connection) -> Result<()> {
    // R2.3's rebuild, left running by an older build: its rows of the
    // older generation are not counted; the rows job brings them in.
    let legacy = kv_get(conn, KV_REBUILD_CURSOR)?.is_some();
    if legacy {
        delete_kv(
            conn,
            &[KV_REBUILD_CURSOR, KV_REBUILD_DONE, KV_REBUILD_TOTAL],
        )?;
    }
    // R2.3's "compute EV again" queued hands that kept their old row: the
    // queue wins (the reports read every stored row since R2.11). Looked for
    // first: an open writes nothing when the store is current (several
    // processes may open it at once).
    let both = conn
        .prepare_cached(
            "SELECT 1 FROM ev_pending p JOIN ev_rows e ON e.hand_key = p.hand_key LIMIT 1",
        )?
        .exists([])?;
    if both {
        conn.execute(
            "DELETE FROM ev_rows WHERE hand_key IN (SELECT hand_key FROM ev_pending)",
            [],
        )?;
    }
    let running = rows_state(conn)?;
    let stats_current = kv_get(conn, KV_VERSION)?.as_deref() == Some(STATS_VERSION);
    if kv_get(conn, KV_SEGMENT_VERSION)?.is_none() && stats_current && !legacy && running.is_none()
    {
        // A store from before R2.11 is grouped by the first definition.
        kv_set(conn, KV_SEGMENT_VERSION, SEGMENT_VERSION)?;
    }
    let segments_current = kv_get(conn, KV_SEGMENT_VERSION)?.as_deref() == Some(SEGMENT_VERSION);
    let wanted = if legacy || !stats_current {
        Some(RowsJob::Rows)
    } else if !segments_current {
        Some(RowsJob::Segments)
    } else {
        None
    };
    let resumable = kv_get(conn, KV_ROWS_TARGET)?.as_deref() == Some(target().as_str());
    match (running, wanted) {
        (Some(state), Some(job)) => {
            if legacy || !resumable || (job == RowsJob::Rows && state.job == RowsJob::Segments) {
                begin_rows(conn, job)?;
            }
        }
        (Some(state), None) => {
            if !resumable {
                begin_rows(conn, state.job)?;
            }
        }
        (None, Some(job)) => {
            begin_rows(conn, job)?;
        }
        (None, None) => {}
    }
    let ev_current = kv_get(conn, KV_EV_VERSION)?.as_deref() == Some(EV_VERSION);
    let ev_running = kv_get(conn, KV_EV_TARGET)?;
    match ev_running {
        Some(running) if running != EV_VERSION => {
            begin_ev(conn)?;
        }
        None if !ev_current => {
            begin_ev(conn)?;
        }
        _ => {}
    }
    Ok(())
}

/* ------------------------------------------------------- stored values - */

/// `hand_stats`' columns a recompute compares and writes, in this order.
const HAND_COLUMNS: [&str; 20] = [
    "played_at",
    "segment_id",
    "stats_version",
    "site_anonymization",
    "site_id",
    "currency_minor_units",
    "player_count",
    "tournament_id",
    "fast_fold",
    "has_straddle",
    "is_bomb_pot",
    "is_big_blind_ante",
    "is_run_it_twice",
    "has_cashout",
    "is_walk",
    "street_reached",
    "pot_type",
    "total_pot",
    "house_into_pot",
    "fees",
];
const HAND_PLAYED_AT: usize = 0;
const HAND_SEGMENT: usize = 1;
const HAND_VERSION: usize = 2;
const HAND_STRADDLE: usize = 9;
const HAND_BOMB: usize = 10;
const HAND_CASHOUT: usize = 13;

/// `seat_stats`' columns but `hand_id`, in this order.
const SEAT_COLUMNS: [&str; 10] = [
    "seat",
    "player",
    "scope",
    "is_hero",
    "position",
    "hole_cards",
    "hand_class",
    "starting_stack",
    "starting_stack_bb_tenths",
    "totals",
];
const SEAT_SEAT: usize = 0;
const SEAT_PLAYER: usize = 1;
const SEAT_SCOPE: usize = 2;
const SEAT_HERO: usize = 3;
const SEAT_POSITION: usize = 4;
const SEAT_TOTALS: usize = 9;

/// `hand_list`'s columns, in this order.
const LIST_COLUMNS: [&str; 18] = [
    "played_at",
    "hand_key",
    "site_hand_id",
    "segment_id",
    "hero_position",
    "hero_cards",
    "hero_net",
    "hero_net_bb_milli",
    "hero_stack_bb_tenths",
    "board",
    "all_in",
    "showdown",
    "pot_type",
    "currency_symbol",
    "kind",
    "hero_wtsd",
    "currency",
    "minor_units",
];
const LIST_SEGMENT: usize = 3;
const LIST_ALL_IN: usize = 10;
const LIST_KIND: usize = 14;

fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

fn opt_text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, text)
}

fn flag(value: bool) -> Value {
    Value::Integer(i64::from(value))
}

fn int(value: impl Into<i64>) -> Value {
    Value::Integer(value.into())
}

fn usize_int(value: usize) -> Result<Value> {
    Ok(Value::Integer(
        i64::try_from(value).map_err(|_| Error::OutOfRange("count"))?,
    ))
}

/// What the import writes into `hand_stats` for `stats` (it has rows).
fn hand_values(stats: &PreparedStats, segment_id: i64) -> Result<Vec<Value>> {
    let Some(first) = stats.rows.first() else {
        return Err(Error::Corrupt("a hand without rows".to_owned()));
    };
    let hand = &first.row.hand;
    Ok(vec![
        opt_text(hand.played_at.as_deref()),
        int(segment_id),
        text(hand.stats_version),
        text(stats.anonymization.as_str()),
        text(&hand.site_id),
        int(hand.currency_minor_units),
        usize_int(hand.player_count)?,
        opt_text(hand.tournament_id.as_deref()),
        opt_text(hand.fast_fold.as_deref()),
        flag(hand.has_straddle),
        flag(hand.is_bomb_pot),
        flag(hand.is_big_blind_ante),
        flag(hand.is_run_it_twice),
        flag(hand.has_cashout),
        flag(hand.is_walk),
        text(hand.street_reached.as_str()),
        text(hand.pot_type.as_str()),
        int(hand.total_pot),
        int(hand.house_into_pot),
        int(hand.fees),
    ])
}

/// What the import writes into `seat_stats` for each kept seat, by seat.
fn seat_values(stats: &PreparedStats) -> Vec<Vec<Value>> {
    let mut seats: Vec<Vec<Value>> = stats
        .rows
        .iter()
        .map(|prepared| {
            let seat = &prepared.row.seat;
            vec![
                int(seat.seat),
                text(&seat.player),
                text(&prepared.scope),
                flag(seat.is_hero),
                opt_text(seat.position.map(|position| position.as_str())),
                text(&prepared.hole_cards),
                opt_text(seat.hand_class.as_deref()),
                int(seat.starting_stack),
                int(seat.starting_stack_bb_tenths),
                Value::Blob(prepared.totals.clone()),
            ]
        })
        .collect();
    seats.sort_by_key(|seat| match seat[SEAT_SEAT] {
        Value::Integer(n) => n,
        _ => 0,
    });
    seats
}

/// What the import writes into `hand_list` for `stats`.
fn list_values(hand_key: &str, stats: &PreparedStats, segment_id: i64) -> Result<Vec<Value>> {
    let Some(first) = stats.rows.first() else {
        return Err(Error::Corrupt("a hand without rows".to_owned()));
    };
    let hand = &first.row.hand;
    let hero = stats.rows.iter().find(|seat| seat.row.seat.is_hero);
    Ok(vec![
        text(hand.played_at.as_deref().unwrap_or("")),
        text(hand_key),
        text(&hand.hand_id),
        int(segment_id),
        opt_text(hero.and_then(|seat| seat.row.seat.position.map(|position| position.as_str()))),
        opt_text(hero.map(|seat| seat.hole_cards.as_str())),
        hero.map_or(Value::Null, |seat| int(seat.values.net())),
        hero.map_or(Value::Null, |seat| int(seat.values.net_bb_milli())),
        hero.map_or(Value::Null, |seat| {
            int(seat.row.seat.starting_stack_bb_tenths)
        }),
        text(&stats.list.board),
        flag(stats.list.all_in),
        flag(stats.list.showdown),
        text(hand.pot_type.as_str()),
        text(&stats.list.currency_symbol),
        int(crate::stats::kind_of(&first.row)),
        flag(hero.is_some_and(|seat| seat.values.counters[rail_stats::Counter::wtsd.index()] > 0)),
        text(&stats.list.currency),
        int(hand.currency_minor_units),
    ])
}

/// Equal but at `skip`.
fn same_but(a: &[Value], b: &[Value], skip: usize) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .enumerate()
            .all(|(i, (x, y))| i == skip || x == y)
}

fn as_i64(value: &Value) -> i64 {
    match value {
        Value::Integer(n) => *n,
        _ => 0,
    }
}

fn as_str(value: &Value) -> &str {
    match value {
        Value::Text(text) => text,
        _ => "",
    }
}

/// A hand's stored rows.
#[derive(Debug)]
struct Stored {
    id: i64,
    generation: i64,
    hand: Vec<Value>,
    seats: Vec<Vec<Value>>,
    list: Option<Vec<Value>>,
}

impl Stored {
    fn read(conn: &Connection, hand_key: &str) -> Result<Option<Self>> {
        let sql = format!(
            "SELECT id, gen, {} FROM hand_stats WHERE hand_key = ?1",
            HAND_COLUMNS.join(", ")
        );
        let found = conn
            .prepare_cached(&sql)?
            .query_row([hand_key], |row| {
                let mut hand = Vec::with_capacity(HAND_COLUMNS.len());
                for i in 0..HAND_COLUMNS.len() {
                    hand.push(row.get::<_, Value>(2 + i)?);
                }
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, hand))
            })
            .optional()?;
        let Some((id, generation, hand)) = found else {
            return Ok(None);
        };
        let sql = format!(
            "SELECT {} FROM seat_stats WHERE hand_id = ?1 ORDER BY seat",
            SEAT_COLUMNS.join(", ")
        );
        let seats = conn
            .prepare_cached(&sql)?
            .query_map([id], |row| {
                (0..SEAT_COLUMNS.len())
                    .map(|i| row.get::<_, Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let sql = format!(
            "SELECT {} FROM hand_list WHERE played_at = ?1 AND hand_key = ?2",
            LIST_COLUMNS.join(", ")
        );
        let list = conn
            .prepare_cached(&sql)?
            .query_row(params![as_str(&hand[HAND_PLAYED_AT]), hand_key], |row| {
                (0..LIST_COLUMNS.len())
                    .map(|i| row.get::<_, Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .optional()?;
        Ok(Some(Self {
            id,
            generation,
            hand,
            seats,
            list,
        }))
    }

    fn kind(&self) -> i64 {
        (if as_i64(&self.hand[HAND_BOMB]) != 0 {
            KIND_BOMB_POT
        } else {
            0
        }) | (if as_i64(&self.hand[HAND_STRADDLE]) != 0 {
            KIND_STRADDLED
        } else {
            0
        }) | (if as_i64(&self.hand[HAND_CASHOUT]) != 0 {
            KIND_CASHOUT
        } else {
            0
        })
    }
}

/// The hero's seat, net and net in thousandths of a big blind: an EV result
/// stays valid while these do not change (`handEvRow` reads nothing else of
/// the statistics).
type HeroFacts = (i64, i64, i64);

fn stored_hero(seats: &[(Vec<Value>, SeatValues)]) -> Option<HeroFacts> {
    seats
        .iter()
        .find(|(seat, _)| as_i64(&seat[SEAT_HERO]) != 0)
        .map(|(seat, values)| {
            (
                as_i64(&seat[SEAT_SEAT]),
                values.net(),
                values.net_bb_milli(),
            )
        })
}

fn derived_hero(stats: &PreparedStats) -> Option<HeroFacts> {
    stats.hero().map(|row| {
        (
            i64::from(row.seat.seat),
            row.seat.money.net,
            row.seat.money.net_bb_milli,
        )
    })
}

/// What a hand's seats are counted under, by the custom statistics too:
/// its segment, kind and day and each seat's key.
type SeatKeys = (i64, i64, String, Vec<(i64, String, String, i64, Value)>);

fn seat_keys(segment: i64, kind: i64, played_at: &Value, seats: &[Vec<Value>]) -> SeatKeys {
    (
        segment,
        kind,
        crate::stats::day_of(Some(as_str(played_at))).to_owned(),
        seats
            .iter()
            .map(|seat| {
                (
                    as_i64(&seat[SEAT_SEAT]),
                    as_str(&seat[SEAT_PLAYER]).to_owned(),
                    as_str(&seat[SEAT_SCOPE]).to_owned(),
                    as_i64(&seat[SEAT_HERO]),
                    seat[SEAT_POSITION].clone(),
                )
            })
            .collect(),
    )
}

/// Decode stored seat rows' blobs.
fn decoded(seats: &[Vec<Value>]) -> Result<Vec<(Vec<Value>, SeatValues)>> {
    seats
        .iter()
        .map(|seat| {
            let values = match &seat[SEAT_TOTALS] {
                Value::Blob(blob) => decode_seat(blob)?,
                _ => return Err(Error::Corrupt("seat totals: not a blob".to_owned())),
            };
            Ok((seat.clone(), values))
        })
        .collect()
}

/// Sum stored rows into `shadow`, in segment `segment_id` of `site`.
fn count_stored(
    shadow: &mut Pending,
    stored: &Stored,
    seats: &[(Vec<Value>, SeatValues)],
    site: &str,
    segment_id: i64,
    cash: bool,
) {
    let played_at = match &stored.hand[HAND_PLAYED_AT] {
        Value::Text(at) => Some(at.as_str()),
        _ => None,
    };
    let hand = HandSum {
        site,
        segment_id,
        played_at,
        kind: stored.kind(),
        cash,
        hero_net: stored_hero(seats).map(|(_, _, net)| net),
    };
    for (seat, values) in seats {
        shadow.count(
            &hand,
            &SeatSum {
                player: as_str(&seat[SEAT_PLAYER]),
                scope: as_str(&seat[SEAT_SCOPE]),
                is_hero: as_i64(&seat[SEAT_HERO]) != 0,
                position: as_str(&seat[SEAT_POSITION]),
                values,
            },
        );
    }
}

/// Sum a derived hand into `shadow`.
fn count_derived(shadow: &mut Pending, stats: &PreparedStats, segment_id: i64) {
    if let Some(hand) = HandSum::of(stats, segment_id) {
        for seat in &stats.rows {
            shadow.count(&hand, &SeatSum::of(seat));
        }
    }
}

/* ------------------------------------------------------------- segments - */

type SegmentKey = (String, String, String, String, String, String);

fn segment_key(segment: &Segment) -> SegmentKey {
    (
        segment.site.clone(),
        segment.format.as_str().to_owned(),
        segment.variant.as_str().to_owned(),
        segment.limit.as_str().to_owned(),
        segment.size.as_str().to_owned(),
        segment.stake.key(),
    )
}

/// The `segments` table: by key, and each id's site and whether it is cash.
#[derive(Debug, Default)]
struct Segments {
    ids: HashMap<SegmentKey, i64>,
    by_id: HashMap<i64, (String, bool)>,
}

impl Segments {
    fn read(conn: &Connection) -> Result<Self> {
        let mut out = Self::default();
        let mut stmt = conn.prepare_cached(
            "SELECT id, site, game_format, variant, limit_type, size_class, stake FROM segments",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let key: SegmentKey = (
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            );
            out.by_id
                .insert(id, (key.0.clone(), key.1 == GameFormat::Cash.as_str()));
            out.ids.insert(key, id);
        }
        Ok(out)
    }

    fn id(&self, segment: &Segment) -> Option<i64> {
        self.ids.get(&segment_key(segment)).copied()
    }
}

/// Make sure every segment of `wanted` has its row (a segment new to the
/// store is added through the writer, in its own small transaction - rows
/// of `segments` are never deleted, so one added for a page that goes stale
/// does no harm).
fn resolve_segments(
    reader: &Reader,
    writer: &WriterHandle,
    wanted: &[Segment],
) -> Result<Segments> {
    let known = reader.with(Segments::read)?;
    let missing: Vec<Segment> = wanted
        .iter()
        .filter(|segment| known.id(segment).is_none())
        .cloned()
        .collect();
    if missing.is_empty() {
        return Ok(known);
    }
    writer.write(move |tx| {
        for segment in &missing {
            crate::stats::segment_id(tx, segment)?;
        }
        Ok(())
    })?;
    reader.with(Segments::read)
}

/* ------------------------------------------------------- the rows job - */

/// A hand's rows staged for the swap.
#[derive(Debug)]
struct Staged {
    hand_id: i64,
    hand_key: String,
    parts: i64,
    hand: Option<Vec<Value>>,
    seats: Vec<Vec<Value>>,
    list: Option<Vec<Value>>,
    /// What the swap does with the hand's EV (`ev_plan`) and its row.
    ev_plan: i64,
    ev_row: Option<rail_equity::EvRow>,
}

/// `recompute_hands.parts`: the `hand_stats` columns...
pub const PART_HAND: i64 = 1;
/// ...the seat rows...
pub const PART_SEATS: i64 = 2;
/// ...the list row...
pub const PART_LIST: i64 = 4;
/// ...or no rows any more...
pub const PART_DROP: i64 = 8;
/// ...or only the seat rows' counters and money (`totals`), the seats
/// otherwise the same: written in one statement for every such hand.
pub const PART_TOTALS: i64 = 16;

const EV_KEEP: i64 = 0;
const EV_ROW: i64 = 1;
const EV_NONE: i64 = 2;
const EV_QUEUE: i64 = 3;

/// One page of a rows job, worked out on the background pass's thread.
#[derive(Debug)]
pub struct RowsPage {
    job: RowsJob,
    target: String,
    /// The cursor it was read after: if the job moved on (or started again)
    /// since, the page is stale and dropped.
    after: i64,
    /// The last `hands` rowid of the page.
    last: i64,
    hands: usize,
    /// Hands with no rows: written at once, as an import writes them.
    inserts: Vec<(String, PreparedStats)>,
    /// Hands whose rows came out the same: `stats_version` stamped.
    stamp: Vec<i64>,
    staged: Vec<Staged>,
    shadow: Pending,
    /// A hand's seats moved between rollup keys.
    custom: bool,
}

impl RowsPage {
    /// Hands in the page (0: the job has gone through every hand).
    pub fn hands(&self) -> usize {
        self.hands
    }

    /// Hands of the page whose rows are staged for the swap.
    pub fn staged(&self) -> usize {
        self.staged.len()
    }
}

/// Plan a hand's EV after its hero changed (from `None` or other facts).
fn ev_plan_of(stats: Option<&PreparedStats>) -> (i64, Option<rail_equity::EvRow>) {
    match stats.map(|stats| &stats.ev) {
        None | Some(EvPlan::NoHero) => (EV_NONE, None),
        Some(EvPlan::Row(row)) if row.applicable => (EV_ROW, Some(row.clone())),
        Some(EvPlan::Row(_)) => (EV_NONE, None),
        Some(EvPlan::Deferred) => (EV_QUEUE, None),
    }
}

type PageHand = (i64, String, Vec<u8>, i64, Option<Stored>);

/// Work out the next page of the running rows job: `None` when no rows job
/// runs; a page of 0 hands when it has gone through every hand (the caller
/// then asks [`finish_rows`]).
pub fn rows_page(reader: &Reader, writer: &WriterHandle) -> Result<Option<RowsPage>> {
    let read = reader.with(|conn| {
        let Some(state) = rows_state(conn)? else {
            return Ok(None);
        };
        let target = kv_get(conn, KV_ROWS_TARGET)?.unwrap_or_default();
        let generation = current_gen(conn)?;
        let mut stmt = conn.prepare_cached(
            "SELECT rowid, hand_key, phf, phf_size FROM hands
             WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![state.cursor, ROWS_PAGE], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<(i64, String, Vec<u8>, i64)>>>()?;
        let mut hands: Vec<PageHand> = Vec::with_capacity(rows.len());
        for (rowid, hand_key, phf, size) in rows {
            let stored = Stored::read(conn, &hand_key)?;
            hands.push((rowid, hand_key, phf, size, stored));
        }
        Ok(Some((state, target, generation, hands)))
    })?;
    let Some((state, target, generation, hands)) = read else {
        return Ok(None);
    };
    let mut page = RowsPage {
        job: state.job,
        target,
        after: state.cursor,
        last: hands.last().map_or(state.cursor, |hand| hand.0),
        hands: hands.len(),
        inserts: Vec::new(),
        stamp: Vec::new(),
        staged: Vec::new(),
        shadow: Pending::shadow(),
        custom: false,
    };
    if hands.is_empty() {
        return Ok(Some(page));
    }
    // Each hand read back (the expensive part, outside any transaction).
    let parsed: Vec<(String, Option<Stored>, Option<rail_core::phf::PhfHand>)> = hands
        .into_iter()
        .map(|(_, hand_key, phf, size, stored)| {
            let hand = match hand_from(&phf, size) {
                Ok(hand) => Some(hand),
                Err(error) => {
                    log::warn!("recompute: {hand_key}: {error}");
                    None
                }
            };
            (hand_key, stored, hand)
        })
        .collect();
    match state.job {
        RowsJob::Rows => rows_hands(reader, writer, &mut page, parsed, generation)?,
        RowsJob::Segments => segment_hands(reader, writer, &mut page, parsed, generation)?,
    }
    Ok(Some(page))
}

/// The rows job's work on a page: derive, compare, stage, sum.
fn rows_hands(
    reader: &Reader,
    writer: &WriterHandle,
    page: &mut RowsPage,
    parsed: Vec<(String, Option<Stored>, Option<rail_core::phf::PhfHand>)>,
    generation: i64,
) -> Result<()> {
    let derived: Vec<(String, Option<Stored>, Option<PreparedStats>)> = parsed
        .into_iter()
        .map(|(key, stored, hand)| {
            let stats = hand.as_ref().map(PreparedStats::from_phf);
            (key, stored, stats)
        })
        .collect();
    let wanted: Vec<Segment> = derived
        .iter()
        .filter_map(|(_, _, stats)| stats.as_ref().map(|stats| stats.segment.clone()))
        .collect();
    let segments = resolve_segments(reader, writer, &wanted)?;
    for (hand_key, stored, stats) in derived {
        match (stats, stored) {
            (Some(stats), None) => {
                if let Some(segment_id) = segments.id(&stats.segment)
                    && !stats.rows.is_empty()
                {
                    count_derived(&mut page.shadow, &stats, segment_id);
                    page.inserts.push((hand_key, stats));
                }
            }
            (Some(stats), Some(stored)) => {
                let Some(segment_id) = segments.id(&stats.segment) else {
                    continue;
                };
                compare(page, hand_key, &stats, &stored, segment_id, generation)?;
            }
            (None, Some(stored)) => {
                // Its PHF does not read back: its rows stay as they are.
                if stored.generation == generation {
                    let segment = as_i64(&stored.hand[HAND_SEGMENT]);
                    let (site, cash) = segments.by_id.get(&segment).cloned().unwrap_or_default();
                    let seats = decoded(&stored.seats)?;
                    count_stored(&mut page.shadow, &stored, &seats, &site, segment, cash);
                }
            }
            (None, None) => {}
        }
    }
    Ok(())
}

/// Compare a hand's derived rows with its stored ones: stage what differs,
/// sum the new rows.
fn compare(
    page: &mut RowsPage,
    hand_key: String,
    stats: &PreparedStats,
    stored: &Stored,
    segment_id: i64,
    generation: i64,
) -> Result<()> {
    let old_seats = decoded(&stored.seats)?;
    let old_hero = stored_hero(&old_seats);
    let old_keys = seat_keys(
        as_i64(&stored.hand[HAND_SEGMENT]),
        stored.kind(),
        &stored.hand[HAND_PLAYED_AT],
        &stored.seats,
    );
    let older = stored.generation != generation;
    if stats.rows.is_empty() {
        // The hand keeps no rows any more.
        let (ev_plan, ev_row) = if old_hero.is_some() {
            ev_plan_of(None)
        } else {
            (EV_KEEP, None)
        };
        page.staged.push(Staged {
            hand_id: stored.id,
            hand_key,
            parts: PART_DROP,
            hand: None,
            seats: Vec::new(),
            list: None,
            ev_plan,
            ev_row,
        });
        page.custom = true;
        return Ok(());
    }
    let hand = hand_values(stats, segment_id)?;
    let seats = seat_values(stats);
    let list = list_values(&hand_key, stats, segment_id)?;
    let mut parts = 0;
    if older || !same_but(&hand, &stored.hand, HAND_VERSION) {
        parts |= PART_HAND;
    }
    if older || seats.len() != stored.seats.len() {
        parts |= PART_SEATS;
    } else if seats != stored.seats {
        let only_totals = seats
            .iter()
            .zip(&stored.seats)
            .all(|(new, old)| same_but(new, old, SEAT_TOTALS));
        parts |= if only_totals { PART_TOTALS } else { PART_SEATS };
    }
    if stored
        .list
        .as_ref()
        .is_none_or(|old| !same_but(&list, old, LIST_ALL_IN))
    {
        parts |= PART_LIST;
    }
    let new_hero = derived_hero(stats);
    let (ev_plan, ev_row) = if parts & (PART_SEATS | PART_TOTALS) != 0 && new_hero != old_hero {
        ev_plan_of(Some(stats))
    } else {
        (EV_KEEP, None)
    };
    let new_keys = seat_keys(
        segment_id,
        as_i64(&list[LIST_KIND]),
        &hand[HAND_PLAYED_AT],
        &seats,
    );
    if older || new_keys != old_keys {
        page.custom = true;
    }
    if parts & PART_HAND == 0 && stored.hand[HAND_VERSION] != hand[HAND_VERSION] {
        page.stamp.push(stored.id);
    }
    if parts != 0 {
        page.staged.push(Staged {
            hand_id: stored.id,
            hand_key,
            parts,
            hand: (parts & PART_HAND != 0).then_some(hand),
            seats: if parts & (PART_SEATS | PART_TOTALS) != 0 {
                seats
            } else {
                Vec::new()
            },
            list: (parts & PART_LIST != 0).then_some(list),
            ev_plan,
            ev_row,
        });
    }
    count_derived(&mut page.shadow, stats, segment_id);
    Ok(())
}

/// The segments job's work on a page: each hand's segment again, its stored
/// rows summed under it.
fn segment_hands(
    reader: &Reader,
    writer: &WriterHandle,
    page: &mut RowsPage,
    parsed: Vec<(String, Option<Stored>, Option<rail_core::phf::PhfHand>)>,
    generation: i64,
) -> Result<()> {
    let wanted: Vec<Segment> = parsed
        .iter()
        .filter_map(|(_, _, hand)| hand.as_ref().map(Segment::of))
        .collect();
    let segments = resolve_segments(reader, writer, &wanted)?;
    for (hand_key, stored, hand) in parsed {
        let Some(stored) = stored.filter(|stored| stored.generation == generation) else {
            continue;
        };
        let old = as_i64(&stored.hand[HAND_SEGMENT]);
        let new = hand
            .as_ref()
            .and_then(|hand| segments.id(&Segment::of(hand)))
            .unwrap_or(old);
        let (site, cash) = segments.by_id.get(&new).cloned().unwrap_or_default();
        let seats = decoded(&stored.seats)?;
        count_stored(&mut page.shadow, &stored, &seats, &site, new, cash);
        if new != old {
            let mut hand = stored.hand.clone();
            hand[HAND_SEGMENT] = Value::Integer(new);
            let list = stored.list.clone().map(|mut list| {
                list[LIST_SEGMENT] = Value::Integer(new);
                list
            });
            page.staged.push(Staged {
                hand_id: stored.id,
                hand_key,
                parts: PART_HAND | if list.is_some() { PART_LIST } else { 0 },
                hand: Some(hand),
                seats: Vec::new(),
                list,
                ev_plan: EV_KEEP,
                ev_row: None,
            });
            page.custom = true;
        }
    }
    Ok(())
}

/// Write a page of the rows job: the hands without rows (their rows, at
/// once), the stamps, the staged rows and the twins' sums, and the cursor.
/// Returns whether it applied (`false`: stale - the job moved on or started
/// again since it was read).
pub fn apply_rows_page(conn: &Connection, page: RowsPage) -> Result<bool> {
    let Some(state) = rows_state(conn)? else {
        return Ok(false);
    };
    if state.cursor != page.after
        || state.job != page.job
        || kv_get(conn, KV_ROWS_TARGET)?.as_deref() != Some(page.target.as_str())
    {
        return Ok(false);
    }
    let mut live = Pending::new(conn)?;
    for (hand_key, stats) in &page.inserts {
        let exists = conn
            .prepare_cached("SELECT 1 FROM hand_stats WHERE hand_key = ?1")?
            .exists([hand_key])?;
        if !exists {
            live.add_hand(conn, hand_key, stats)?;
        }
    }
    live.flush(conn)?;
    if !page.stamp.is_empty() {
        let mut stamp = conn.prepare_cached(
            "UPDATE hand_stats SET stats_version = ?2 WHERE id = ?1 AND stats_version <> ?2",
        )?;
        for id in &page.stamp {
            stamp.execute(params![id, STATS_VERSION])?;
        }
    }
    stage(conn, &page.staged)?;
    page.shadow.flush(conn)?;
    if page.custom {
        kv_set(conn, KV_ROWS_CUSTOM, "1")?;
    }
    kv_set(conn, KV_ROWS_CURSOR, &page.last.to_string())?;
    let done = state.done + u64::try_from(page.hands).unwrap_or(0);
    kv_set(conn, KV_ROWS_DONE, &done.to_string())?;
    Ok(true)
}

fn placeholders(from: usize, n: usize) -> String {
    (from..from + n)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Write staged rows into the staging tables.
fn stage(conn: &Connection, staged: &[Staged]) -> Result<()> {
    if staged.is_empty() {
        return Ok(());
    }
    let hand_sql = format!(
        "INSERT OR REPLACE INTO recompute_hands (hand_id, hand_key, parts, {}, ev_plan, ev_seat,
           ev_version, ev_net, ev_net_bb_milli)
         VALUES (?1, ?2, ?3, {}, {})",
        HAND_COLUMNS.join(", "),
        placeholders(4, HAND_COLUMNS.len()),
        placeholders(4 + HAND_COLUMNS.len(), 5)
    );
    let seat_sql = format!(
        "INSERT OR REPLACE INTO recompute_seats (hand_id, {}) VALUES (?1, {})",
        SEAT_COLUMNS.join(", "),
        placeholders(2, SEAT_COLUMNS.len())
    );
    let list_sql = format!(
        "INSERT OR REPLACE INTO recompute_list (hand_id, {}) VALUES (?1, {})",
        LIST_COLUMNS.join(", "),
        placeholders(2, LIST_COLUMNS.len())
    );
    for hand in staged {
        let mut values: Vec<Value> = vec![
            Value::Integer(hand.hand_id),
            Value::Text(hand.hand_key.clone()),
            Value::Integer(hand.parts),
        ];
        match &hand.hand {
            Some(columns) => values.extend(columns.iter().cloned()),
            None => values.extend(std::iter::repeat_n(Value::Null, HAND_COLUMNS.len())),
        }
        values.push(Value::Integer(hand.ev_plan));
        match &hand.ev_row {
            Some(row) => values.extend([
                int(row.seat),
                text(row.ev_version),
                int(row.ev_net),
                int(row.ev_net_bb_milli),
            ]),
            None => values.extend(std::iter::repeat_n(Value::Null, 4)),
        }
        conn.prepare_cached(&hand_sql)?
            .execute(params_from_iter(values))?;
        for seat in &hand.seats {
            let mut values = vec![Value::Integer(hand.hand_id)];
            values.extend(seat.iter().cloned());
            conn.prepare_cached(&seat_sql)?
                .execute(params_from_iter(values))?;
        }
        if let Some(list) = &hand.list {
            let mut values = vec![Value::Integer(hand.hand_id)];
            values.extend(list.iter().cloned());
            conn.prepare_cached(&list_sql)?
                .execute(params_from_iter(values))?;
        }
    }
    Ok(())
}

/// The end of a rows job: when no hand is left past its cursor, the swap -
/// the staged rows written, the twins renamed into place, the versions
/// set, the epoch moved on - in the caller's transaction. Returns whether
/// it swapped (`false`: no job, or hands arrived past the cursor since the
/// last page was read: the next step reads them).
pub fn finish_rows(conn: &Connection) -> Result<bool> {
    let Some(state) = rows_state(conn)? else {
        return Ok(false);
    };
    let more = conn
        .prepare_cached("SELECT 1 FROM hands WHERE rowid > ?1")?
        .exists([state.cursor])?;
    if more {
        return Ok(false);
    }
    if kv_get(conn, KV_ROWS_TARGET)?.as_deref() != Some(target().as_str()) {
        // Begun by a build of other versions: begin again.
        begin_rows(conn, state.job)?;
        return Ok(false);
    }
    swap_staged(conn)?;
    for summed in Summed::ALL {
        let (live, twin) = (Target::Live.table(summed), Target::Shadow.table(summed));
        conn.execute_batch(&format!(
            "ALTER TABLE {live} RENAME TO recompute_swap;
             ALTER TABLE {twin} RENAME TO {live};
             ALTER TABLE recompute_swap RENAME TO {twin};
             DELETE FROM {twin};"
        ))?;
    }
    if kv_get(conn, KV_ROWS_CUSTOM)?.as_deref() == Some("1") {
        crate::custom::reset_custom_counts(conn)?;
    }
    kv_set(conn, KV_VERSION, STATS_VERSION)?;
    kv_set(conn, KV_SEGMENT_VERSION, SEGMENT_VERSION)?;
    next_epoch(conn)?;
    clear_rows_work(conn)?;
    Ok(true)
}

/// A staged hand as the swap reads it: id, key, parts, EV plan, and the EV
/// row's seat, version, net, net in thousandths of a big blind.
type StagedRow = (
    i64,
    String,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<i64>,
);

/// The staged rows into `hand_stats`, `seat_stats` and `hand_list`, and
/// the EV of the hands whose hero changed.
fn swap_staged(conn: &Connection) -> Result<()> {
    let generation = current_gen(conn)?;
    let indexed = kv_i64(conn, KV_PLAYERS_INDEXED)?.unwrap_or(0);
    // The common cases in one statement each: a counter's change rewrites
    // only seat blobs; a list column's, only list rows (measured at 500k:
    // 250k hands' seats one statement each took 6.5 s of the writer).
    conn.execute(
        "UPDATE seat_stats SET totals = r.totals
         FROM recompute_seats r JOIN recompute_hands h ON h.hand_id = r.hand_id
         WHERE h.parts & 16 <> 0 AND seat_stats.hand_id = r.hand_id
           AND seat_stats.seat = r.seat",
        [],
    )?;
    let list_set: Vec<String> = LIST_COLUMNS
        .iter()
        .filter(|&&c| !matches!(c, "played_at" | "hand_key" | "all_in"))
        .map(|c| format!("{c} = r.{c}"))
        .collect();
    conn.execute(
        &format!(
            "UPDATE hand_list SET {}
             FROM recompute_list r JOIN recompute_hands h ON h.hand_id = r.hand_id
             WHERE h.parts & ~(4 | 16) = 0 AND h.ev_plan = 0
               AND hand_list.played_at = r.played_at AND hand_list.hand_key = r.hand_key",
            list_set.join(", ")
        ),
        [],
    )?;
    // A list row the hand did not have (a store from before the list's
    // migration): its flag from the EV as it stands.
    let list_cols = LIST_COLUMNS.join(", ");
    let list_values: Vec<String> = LIST_COLUMNS
        .iter()
        .map(|&c| {
            if c == "all_in" {
                "(EXISTS (SELECT 1 FROM ev_rows e WHERE e.hand_key = r.hand_key)
                  OR EXISTS (SELECT 1 FROM ev_pending p WHERE p.hand_key = r.hand_key))"
                    .to_owned()
            } else {
                format!("r.{c}")
            }
        })
        .collect();
    conn.execute(
        &format!(
            "INSERT INTO hand_list ({list_cols})
             SELECT {} FROM recompute_list r JOIN recompute_hands h ON h.hand_id = r.hand_id
             WHERE h.parts & ~(4 | 16) = 0 AND h.ev_plan = 0
               AND NOT EXISTS (SELECT 1 FROM hand_list l
                               WHERE l.played_at = r.played_at AND l.hand_key = r.hand_key)",
            list_values.join(", ")
        ),
        [],
    )?;
    // Every other staged hand, one at a time.
    let staged: Vec<StagedRow> = conn
        .prepare(
            "SELECT hand_id, hand_key, parts, ev_plan, ev_seat, ev_version, ev_net,
                    ev_net_bb_milli
             FROM recompute_hands
             WHERE NOT (parts & ~(4 | 16) = 0 AND ev_plan = 0)
             ORDER BY hand_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let update_hand = format!(
        "UPDATE hand_stats SET ({cols}) = (SELECT {cols} FROM recompute_hands WHERE hand_id = ?1),
           gen = ?2
         WHERE id = ?1",
        cols = HAND_COLUMNS.join(", ")
    );
    let insert_seats = format!(
        "INSERT INTO seat_stats (hand_id, {cols}) SELECT hand_id, {cols} FROM recompute_seats
         WHERE hand_id = ?1",
        cols = SEAT_COLUMNS.join(", ")
    );
    let list_cols: Vec<&str> = LIST_COLUMNS
        .iter()
        .map(|&c| if c == "all_in" { "?2" } else { c })
        .collect();
    let insert_list = format!(
        "INSERT INTO hand_list ({}) SELECT {} FROM recompute_list WHERE hand_id = ?1",
        LIST_COLUMNS.join(", "),
        list_cols.join(", ")
    );
    for (hand_id, hand_key, parts, ev_plan, ev_seat, ev_version, ev_net, ev_bb) in staged {
        // The list's all-in flag as it is, before anything changes.
        let old_all_in: Option<bool> = conn
            .prepare_cached(
                "SELECT l.all_in FROM hand_stats d
                 JOIN hand_list l ON l.played_at = coalesce(d.played_at, '')
                                 AND l.hand_key = d.hand_key
                 WHERE d.id = ?1",
            )?
            .query_row([hand_id], |row| row.get(0))
            .optional()?;
        if parts & (PART_LIST | PART_DROP) != 0 {
            conn.prepare_cached(
                "DELETE FROM hand_list WHERE hand_key = ?1
                   AND played_at = (SELECT coalesce(played_at, '') FROM hand_stats WHERE id = ?2)",
            )?
            .execute(params![hand_key, hand_id])?;
        }
        if parts & PART_DROP != 0 {
            conn.prepare_cached("DELETE FROM hand_stats WHERE id = ?1")?
                .execute([hand_id])?;
        } else {
            if parts & PART_HAND != 0 {
                conn.prepare_cached(&update_hand)?
                    .execute(params![hand_id, generation])?;
            }
            if parts & PART_SEATS != 0 {
                conn.prepare_cached("DELETE FROM seat_stats WHERE hand_id = ?1")?
                    .execute([hand_id])?;
                conn.prepare_cached(&insert_seats)?.execute([hand_id])?;
                if hand_id <= indexed {
                    conn.prepare_cached(
                        "INSERT OR IGNORE INTO player_hands (player, hand_id, seat)
                         SELECT player, hand_id, seat FROM recompute_seats
                         WHERE hand_id = ?1 AND is_hero = 0 AND scope = '' AND player <> ''",
                    )?
                    .execute([hand_id])?;
                }
            }
        }
        let all_in = match ev_plan {
            EV_ROW => {
                conn.prepare_cached(crate::stats::UPSERT_EV_SQL)?
                    .execute(params![hand_key, ev_seat, ev_version, ev_net, ev_bb])?;
                conn.prepare_cached("DELETE FROM ev_pending WHERE hand_key = ?1")?
                    .execute([&hand_key])?;
                Some(true)
            }
            EV_NONE => {
                settle_ev(conn, &hand_key, None)?;
                Some(false)
            }
            EV_QUEUE => {
                enqueue_ev(conn, &hand_key)?;
                Some(true)
            }
            _ => None,
        };
        if all_in.is_some() {
            // The EV job leaves this hand to what was just decided.
            conn.prepare_cached("DELETE FROM recompute_ev WHERE hand_key = ?1")?
                .execute([&hand_key])?;
        }
        if parts & PART_DROP != 0 {
            continue;
        }
        if parts & PART_LIST != 0 {
            let flag = match (all_in, old_all_in) {
                (Some(flag), _) | (None, Some(flag)) => flag,
                (None, None) => conn
                    .prepare_cached(
                        "SELECT EXISTS (SELECT 1 FROM ev_rows WHERE hand_key = ?1)
                             OR EXISTS (SELECT 1 FROM ev_pending WHERE hand_key = ?1)",
                    )?
                    .query_row([&hand_key], |row| row.get(0))?,
            };
            conn.prepare_cached(&insert_list)?
                .execute(params![hand_id, flag])?;
        } else if let Some(flag) = all_in {
            set_list_all_in(conn, &hand_key, flag)?;
        }
    }
    Ok(())
}

/* --------------------------------------------------------- the EV job - */

/// A page of the EV job: per hand its new row (`None`: no row - not
/// applicable, no hero after all, or its PHF did not read back).
#[derive(Debug)]
pub struct EvPage {
    target: String,
    rows: Vec<(String, Option<rail_equity::EvRow>)>,
    /// The time the evaluations took.
    pub took: Duration,
}

impl EvPage {
    /// Hands evaluated (0: none left, the caller asks [`finish_ev`]).
    pub fn hands(&self) -> usize {
        self.rows.len()
    }
}

/// Evaluate the next hands of the running EV job, until [`EV_BUDGET`] has
/// gone. `None` when no EV job runs.
pub fn ev_page(reader: &Reader) -> Result<Option<EvPage>> {
    let read = reader.with(|conn| {
        let Some(target) = kv_get(conn, KV_EV_TARGET)? else {
            return Ok(None);
        };
        let mut stmt = conn.prepare_cached(
            "SELECT r.hand_key, h.phf, h.phf_size FROM recompute_ev r
             JOIN hands h ON h.hand_key = r.hand_key
             WHERE r.done = 0 ORDER BY r.hand_key LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([EV_PAGE], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<(String, Vec<u8>, i64)>>>()?;
        Ok(Some((target, rows)))
    })?;
    let Some((target, hands)) = read else {
        return Ok(None);
    };
    let started = Instant::now();
    let mut rows = Vec::new();
    for (hand_key, blob, size) in hands {
        let row = match hand_from(&blob, size) {
            Ok(hand) => {
                // No all-in the analysis would evaluate: no row, without
                // deriving the statistics (`ev_row_unless_preflop`'s rule).
                if rail_equity::all_in_street(&hand).is_none() {
                    None
                } else {
                    rail_equity::ev_row_for(&hand).filter(|row| row.applicable)
                }
            }
            Err(error) => {
                log::warn!("EV recompute: {hand_key}: {error}");
                None
            }
        };
        rows.push((hand_key, row));
        if started.elapsed() >= EV_BUDGET {
            break;
        }
    }
    Ok(Some(EvPage {
        target,
        rows,
        took: started.elapsed(),
    }))
}

/// Write a page of the EV job into `recompute_ev`. Returns whether it
/// applied (`false`: stale).
pub fn apply_ev_page(conn: &Connection, page: &EvPage) -> Result<bool> {
    if kv_get(conn, KV_EV_TARGET)?.as_deref() != Some(page.target.as_str()) {
        return Ok(false);
    }
    let mut update = conn.prepare_cached(
        "UPDATE recompute_ev SET done = 1, seat = ?2, ev_version = ?3, ev_net = ?4,
           ev_net_bb_milli = ?5, applicable = ?6
         WHERE hand_key = ?1 AND done = 0",
    )?;
    let mut n: u64 = 0;
    for (hand_key, row) in &page.rows {
        n += u64::try_from(match row {
            Some(row) => update.execute(params![
                hand_key,
                row.seat,
                row.ev_version,
                row.ev_net,
                row.ev_net_bb_milli,
                true
            ])?,
            None => update.execute(params![
                hand_key,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                false
            ])?,
        })
        .unwrap_or(0);
    }
    let done = count(conn, KV_EV_DONE)? + n;
    kv_set(conn, KV_EV_DONE, &done.to_string())?;
    Ok(true)
}

/// An evaluated hand as the EV swap reads it: key, applicable, seat,
/// version, net, net in thousandths of a big blind, whether it has a row.
type EvResult = (
    String,
    bool,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    bool,
);

/// The end of the EV job: when every hand is evaluated, the swap - the new
/// rows into `ev_rows` (a hand the EV queue has meanwhile is the queue's),
/// the list's all-in flag of the hands whose row came or went, `ev.version`
/// set, the epoch moved on. Returns whether it swapped.
pub fn finish_ev(conn: &Connection) -> Result<bool> {
    let Some(target) = kv_get(conn, KV_EV_TARGET)? else {
        return Ok(false);
    };
    let waiting = conn
        .prepare_cached("SELECT 1 FROM recompute_ev WHERE done = 0")?
        .exists([])?;
    if waiting {
        return Ok(false);
    }
    if target != EV_VERSION {
        begin_ev(conn)?;
        return Ok(false);
    }
    let rows: Vec<EvResult> = conn
        .prepare(
            "SELECT r.hand_key, r.applicable, r.seat, r.ev_version, r.ev_net, r.ev_net_bb_milli,
                    EXISTS (SELECT 1 FROM ev_rows e WHERE e.hand_key = r.hand_key)
             FROM recompute_ev r
             WHERE NOT EXISTS (SELECT 1 FROM ev_pending p WHERE p.hand_key = r.hand_key)
               AND (r.applicable = 1
                    OR EXISTS (SELECT 1 FROM ev_rows e WHERE e.hand_key = r.hand_key))",
        )?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (hand_key, applicable, seat, version, net, bb, had_row) in rows {
        if applicable {
            conn.prepare_cached(crate::stats::UPSERT_EV_SQL)?
                .execute(params![hand_key, seat, version, net, bb])?;
        } else if had_row {
            conn.prepare_cached("DELETE FROM ev_rows WHERE hand_key = ?1")?
                .execute([&hand_key])?;
        }
        set_list_all_in(conn, &hand_key, applicable)?;
    }
    kv_set(conn, KV_EV_VERSION, EV_VERSION)?;
    next_epoch(conn)?;
    conn.execute("DELETE FROM recompute_ev", [])?;
    delete_kv(conn, &[KV_EV_TARGET, KV_EV_DONE, KV_EV_TOTAL])?;
    Ok(true)
}

/* --------------------------------------------------------- the steps - */

/// One page of the rows job, or its end. `None`: no rows job runs;
/// `Some(0)`: it swapped (or found new hands to go through first).
pub fn rows_step(reader: &Reader, writer: &WriterHandle) -> Result<Option<usize>> {
    let Some(page) = rows_page(reader, writer)? else {
        return Ok(None);
    };
    let hands = page.hands();
    if hands == 0 {
        writer.write(|tx| finish_rows(tx))?;
        return Ok(Some(0));
    }
    writer.write(move |tx| apply_rows_page(tx, page))?;
    Ok(Some(hands))
}

/// One page of the EV job, or its end. `None`: no EV job runs.
pub fn ev_step(reader: &Reader, writer: &WriterHandle) -> Result<Option<(usize, Duration)>> {
    let Some(page) = ev_page(reader)? else {
        return Ok(None);
    };
    let (hands, took) = (page.hands(), page.took);
    if hands == 0 {
        writer.write(|tx| finish_ev(tx))?;
        return Ok(Some((0, took)));
    }
    writer.write(move |tx| apply_ev_page(tx, &page))?;
    Ok(Some((hands, took)))
}

/// Run the rows job to its swap on this thread (tests, examples). Returns
/// the hands it went through.
pub fn run_rows_job(reader: &Reader, writer: &WriterHandle) -> Result<usize> {
    let mut hands = 0;
    while let Some(n) = rows_step(reader, writer)? {
        hands += n;
    }
    Ok(hands)
}

/// Run the EV job to its swap on this thread (tests, examples). Returns
/// the hands it evaluated.
pub fn run_ev_job(reader: &Reader, writer: &WriterHandle) -> Result<usize> {
    let mut hands = 0;
    while let Some((n, _)) = ev_step(reader, writer)? {
        hands += n;
    }
    Ok(hands)
}

/// The staging tables' row counts, for tests and the benchmark: hands,
/// seats, list rows.
pub fn staged_counts(conn: &Connection) -> Result<BTreeMap<&'static str, i64>> {
    let mut out = BTreeMap::new();
    for table in [
        "recompute_hands",
        "recompute_seats",
        "recompute_list",
        "recompute_ev",
    ] {
        let n: i64 = conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })?;
        out.insert(table, n);
    }
    Ok(out)
}
