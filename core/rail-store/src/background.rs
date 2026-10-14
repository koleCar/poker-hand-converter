//! The background statistics pass (docs/RAIL-PLAN.md R2.3, R2.11): one
//! low-priority thread that, a step at a time,
//!
//! 1. writes the opponents of the hands imported since it last did to
//!    `player_hands` (R2.7c, the Players screen's "hands with this player"),
//!    [`INDEX_PAGE`] hands a transaction, sorted - the import leaves them,
//!    as a page of that name-ordered table touched per opponent per import
//!    transaction cost it 4-5 % of its rate;
//! 2. counts the user's own statistics (R2.10, [`crate::custom`]);
//! 3. runs a **recompute's rows job** (R2.11, [`crate::recompute`]: a
//!    `STATS_VERSION` or `SEGMENT_VERSION` bump, a store from before R2.3, or
//!    "rebuild statistics", [`StatsWorker::rebuild_stats`]) - a page of hands
//!    per writer transaction, in `hands` row order, the cursor in `kv`
//!    (resumable after a crash or a quit), the statistics the screens read
//!    swapped at the end;
//! 4. computes the **EV rows** the import left for later: hands whose
//!    all-in was completed preflop (an enumeration of 1.7M boards, 25-46 ms
//!    each) - a few hands per transaction, newest first, so a session just
//!    played is evaluated before a backlog;
//! 5. runs a recompute's **EV job** (an `EV_VERSION` bump, or "compute
//!    all-in EV again", [`StatsWorker::recompute_ev`]).
//!
//! It **pauses** while a backfill imports ([`StatsWorker::set_backfill`]:
//! the import threads have the CPU) and its heavy parts - the recompute and
//! EV - while poker tables are open ([`StatsWorker::set_tables_open`], for
//! the HUD of Phase 3: the HUD should not share the CPU with them, and a
//! recompute shows its result only when it is done anyway). The players'
//! index and the custom counts go on: they are cheap and keep new hands
//! complete. Before any of it, once, it **warms up** the store (R2.9,
//! [`Reader::warm_up`]): what Today, Reports and Players read first, into
//! the OS cache, so a large store's first report does not wait for the
//! disk. Work is read through its own read connection and written
//! through the store's single writer, like everything else; the writer
//! interleaves its transactions with the import's. [`drain`] runs the same
//! steps to the end on the caller's thread (tests, examples).

use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use rail_core::phf::PhfHand;
use rail_equity::EvRow;

use crate::batch::decompress_phf;
use crate::error::{Error, Result};
use crate::read::Reader;
use crate::recompute::{EvRecomputeState, RebuildState};
use crate::stats::apply_ev_rows;
use crate::writer::WriterHandle;

/// Hands per page of a recompute's rows job (~60 us of derivation each).
pub const REBUILD_PAGE: u32 = crate::recompute::ROWS_PAGE;

/// Hands per EV transaction: up to ~0.4 s of preflop enumeration, so a
/// pause or a quit is answered within that.
pub const EV_PAGE: u32 = 8;

/// Hands per `player_hands` transaction (R2.7c): ~4-5 opponents each, so a
/// transaction writes ~90k entries sorted - large, because each one rewrites
/// most of the table's pages wherever its entries fall (measured at 500k
/// hands: see docs/RAIL-PLAN.md, R2.7c *As built*).
pub const INDEX_PAGE: u32 = 20_000;

/// How long the idle thread sleeps before looking for work again on its own
/// (new work normally wakes it: [`StatsWorker::wake`]).
pub const IDLE_WAIT: Duration = Duration::from_secs(60);

/// What the thread is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Activity {
    /// Nothing to do.
    #[default]
    Idle,
    /// A recompute's rows job: the statistics worked out again (R2.11).
    Rebuilding,
    /// Writing the opponents of new hands to `player_hands` (R2.7c).
    Indexing,
    /// Counting the user's own statistics (R2.10).
    Counting,
    /// Computing EV rows.
    Computing,
    /// A recompute's EV job: every hero hand's all-in EV again (R2.11).
    Reevaluating,
    /// Paused: a backfill is importing.
    PausedBackfill,
    /// The heavy parts (a recompute, EV) paused: tables are open.
    PausedTables,
    /// Stopped (or never started).
    Stopped,
}

impl Activity {
    /// `idle`, `rebuilding`, `indexing`, `counting`, `computing`,
    /// `recomputing-ev`, `paused-backfill`, `paused-tables`, `stopped`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Rebuilding => "rebuilding",
            Self::Indexing => "indexing",
            Self::Counting => "counting",
            Self::Computing => "computing",
            Self::Reevaluating => "recomputing-ev",
            Self::PausedBackfill => "paused-backfill",
            Self::PausedTables => "paused-tables",
            Self::Stopped => "stopped",
        }
    }
}

/// The worker's state for a status line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkerStatus {
    pub activity: Activity,
    /// A recompute's rows job in progress: hands done of hands to do.
    pub rebuild: Option<RebuildState>,
    /// A recompute's EV job in progress.
    pub ev_recompute: Option<EvRecomputeState>,
    /// The store's epoch (`kv` `stats.epoch`): it moves on when a recompute
    /// swaps its statistics in, so a screen knows to read them again.
    pub epoch: i64,
    /// Hands waiting for an EV row.
    pub ev_pending: u64,
    /// Hands whose opponents are not in `player_hands` yet (R2.7c).
    pub players_unindexed: u64,
    /// EV rows computed by this worker since it started, and the time they
    /// took (the enumeration, not the writes).
    pub ev_computed: u64,
    pub ev_millis: u64,
    /// The last error, if the last step failed.
    pub last_error: Option<String>,
}

#[derive(Debug, Default)]
struct Control {
    stop: bool,
    backfill: bool,
    tables_open: bool,
    /// Work may have arrived since the thread last looked.
    kicked: bool,
}

#[derive(Debug, Default)]
struct Shared {
    control: Mutex<Control>,
    wake: Condvar,
    status: Mutex<WorkerStatus>,
}

impl Shared {
    fn control(&self) -> std::sync::MutexGuard<'_, Control> {
        self.control.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn status(&self) -> std::sync::MutexGuard<'_, WorkerStatus> {
        self.status.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What one step did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// A page of a recompute's rows job: hands gone through (0: its end -
    /// the swap, or new hands to go through first).
    Rebuilt(usize),
    /// Hands whose opponents went to `player_hands`.
    Indexed(usize),
    /// Hands counted for the user's own statistics (0: a page went stale).
    Counted(usize),
    /// EV rows computed, and the time the computation took.
    Computed(usize, Duration),
    /// A page of a recompute's EV job: hands evaluated (0: its end), and
    /// the time it took.
    Reevaluated(usize, Duration),
    /// Nothing left (of what was allowed).
    Nothing,
}

/// A stored PHF back as a hand.
pub(crate) fn hand_from(blob: &[u8], size: i64) -> Result<PhfHand> {
    let size = u64::try_from(size).map_err(|_| Error::OutOfRange("PHF size"))?;
    let json = decompress_phf(blob, size)?;
    serde_json::from_str(&json).map_err(|error| Error::Corrupt(format!("stored PHF: {error}")))
}

type StoredPhf = (String, Vec<u8>, i64);

/// One page of the EV queue, newest first.
fn ev_step(reader: &Reader, writer: &WriterHandle) -> Result<Option<(usize, Duration)>> {
    let rows = reader.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT p.hand_key, h.phf, h.phf_size FROM ev_pending p
             JOIN hands h ON h.hand_key = p.hand_key
             ORDER BY p.id DESC LIMIT ?1",
        )?;
        Ok(stmt
            .query_map([EV_PAGE], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<StoredPhf>>>()?)
    })?;
    if rows.is_empty() {
        return Ok(None);
    }
    let started = Instant::now();
    let computed: Vec<(String, Option<EvRow>)> = rows
        .into_iter()
        .map(|(hand_key, blob, size)| {
            let row = match hand_from(&blob, size) {
                Ok(hand) => rail_equity::ev_row_for(&hand),
                Err(error) => {
                    log::warn!("EV pass: {hand_key}: {error}");
                    None
                }
            };
            (hand_key, row)
        })
        .collect();
    let took = started.elapsed();
    let n = computed.len();
    writer.write(move |tx| apply_ev_rows(tx, &computed))?;
    Ok(Some((n, took)))
}

/// One step: the opponents of a page of new hands, else a page of the
/// user's own statistics (R2.10, [`crate::custom`]), else - when `heavy`
/// allows (no tables open) - a page of a recompute's rows job (R2.11,
/// [`crate::recompute`]), a page of EV rows, a page of a recompute's EV job.
pub fn step(reader: &Reader, writer: &WriterHandle, heavy: bool) -> Result<Step> {
    let indexed = writer.write(|tx| crate::stats::index_players(tx, INDEX_PAGE))?;
    if indexed > 0 {
        return Ok(Step::Indexed(indexed));
    }
    if let Some(n) = crate::custom::custom_step(reader, writer)? {
        return Ok(Step::Counted(n));
    }
    if !heavy {
        return Ok(Step::Nothing);
    }
    if let Some(n) = crate::recompute::rows_step(reader, writer)? {
        return Ok(Step::Rebuilt(n));
    }
    if let Some((n, took)) = ev_step(reader, writer)? {
        return Ok(Step::Computed(n, took));
    }
    if let Some((n, took)) = crate::recompute::ev_step(reader, writer)? {
        return Ok(Step::Reevaluated(n, took));
    }
    Ok(Step::Nothing)
}

/// What [`drain`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Drained {
    pub rebuilt: usize,
    pub indexed: usize,
    /// Hands counted for the user's own statistics.
    pub counted: usize,
    pub ev_rows: usize,
    pub ev_time: Duration,
    /// Hands a recompute's EV job evaluated.
    pub reevaluated: usize,
}

/// Run the pass to the end on this thread: every step until none is left.
pub fn drain(reader: &Reader, writer: &WriterHandle) -> Result<Drained> {
    let mut drained = Drained::default();
    loop {
        match step(reader, writer, true)? {
            Step::Rebuilt(n) => drained.rebuilt += n,
            Step::Indexed(n) => drained.indexed += n,
            Step::Counted(n) => drained.counted += n,
            Step::Computed(n, took) => {
                drained.ev_rows += n;
                drained.ev_time += took;
            }
            Step::Reevaluated(n, _) => drained.reevaluated += n,
            Step::Nothing => return Ok(drained),
        }
    }
}

/// The background thread and its controls.
#[derive(Debug)]
pub struct StatsWorker {
    shared: Arc<Shared>,
    /// Dropped by [`StatsWorker::stop`]: the store closes only when every
    /// handle on its writer is gone.
    writer: Mutex<Option<WriterHandle>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl StatsWorker {
    /// Start the thread on the store at `path` (its own read connection)
    /// and its writer.
    pub fn start(path: &Path, writer: WriterHandle) -> Result<Self> {
        let reader = Reader::open(path, 1)?;
        // The warm-up's own connections (R2.9), closed once it is done.
        let warm = Reader::open(path, crate::report::WARM_UP_CONNECTIONS)?;
        let shared = Arc::new(Shared::default());
        shared.control().kicked = true;
        let thread = {
            let (shared, writer) = (Arc::clone(&shared), writer.clone());
            thread::Builder::new()
                .name("rail-stats-pass".to_owned())
                .spawn(move || {
                    warm_up(&shared, warm);
                    run(&shared, &reader, &writer);
                })
                .map_err(|source| Error::Io {
                    path: "rail-stats-pass".into(),
                    source,
                })?
        };
        Ok(Self {
            shared,
            writer: Mutex::new(Some(writer)),
            thread: Mutex::new(Some(thread)),
        })
    }

    /// New work may be there (hands were imported, a rebuild was asked).
    pub fn wake(&self) {
        self.shared.control().kicked = true;
        self.shared.wake.notify_all();
    }

    /// A backfill is importing (pause everything) or not. A pause takes
    /// effect after the step in flight (a rebuild page, or up to
    /// [`EV_PAGE`] EV rows): the status says `PausedBackfill` once it has.
    pub fn set_backfill(&self, active: bool) {
        self.shared.control().backfill = active;
        self.wake();
    }

    /// Poker tables are open (pause the heavy parts: a recompute, EV) or
    /// not. The HUD's hook (Phase 3).
    pub fn set_tables_open(&self, open: bool) {
        self.shared.control().tables_open = open;
        self.wake();
    }

    /// What it is doing.
    pub fn status(&self) -> WorkerStatus {
        self.shared.status().clone()
    }

    /// "Rebuild statistics": a recompute's rows job over every hand (R2.11:
    /// the screens keep the statistics they show until it swaps the new
    /// ones in). Returns the hands to go through.
    pub fn rebuild_stats(&self) -> Result<u64> {
        let total = self.writer()?.write(|tx| crate::stats::begin_rebuild(tx))?;
        self.wake();
        Ok(total)
    }

    /// "Compute all-in EV again": a recompute's EV job over every hero hand
    /// (the stored rows stay until it swaps the new ones in). Returns how
    /// many it evaluates.
    pub fn recompute_ev(&self) -> Result<u64> {
        let queued = self.writer()?.write(|tx| crate::recompute::begin_ev(tx))?;
        self.wake();
        Ok(queued)
    }

    fn writer(&self) -> Result<WriterHandle> {
        self.writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(Error::WriterGone)
    }

    /// Stop the thread (after its current step), wait for it, and let go of
    /// the store's writer.
    pub fn stop(&self) {
        self.shared.control().stop = true;
        self.shared.wake.notify_all();
        let thread = self
            .thread
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        self.writer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.shared.status().activity = Activity::Stopped;
    }
}

impl Drop for StatsWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Refresh the counts of the status.
fn refresh(shared: &Shared, reader: &Reader, activity: Activity) {
    let counts = reader.stats_status();
    let mut status = shared.status();
    status.activity = activity;
    match counts {
        Ok(counts) => {
            status.rebuild = counts.rebuild;
            status.ev_recompute = counts.ev_recompute;
            status.epoch = counts.epoch;
            status.ev_pending = counts.ev_pending;
            status.players_unindexed = counts.players_unindexed;
        }
        Err(error) => status.last_error = Some(error.to_string()),
    }
}

/// Wait until kicked, stopped or `timeout`; returns whether to stop.
fn wait(shared: &Shared, timeout: Duration) -> bool {
    let mut control = shared.control();
    let deadline = Instant::now() + timeout;
    while !control.stop && !control.kicked {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        control = shared
            .wake
            .wait_timeout(control, left)
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
    control.kicked = false;
    control.stop
}

/// First thing after the app starts (R2.9): read what the screens read
/// first ([`Reader::warm_up`]) into the OS cache, unless the pass is
/// already stopping.
fn warm_up(shared: &Shared, warm: Reader) {
    if shared.control().stop {
        return;
    }
    let started = Instant::now();
    match warm.warm_up() {
        Ok(()) => log::info!("store warmed up in {:.1?}", started.elapsed()),
        Err(error) => log::warn!("store warm-up: {error}"),
    }
}

fn run(shared: &Shared, reader: &Reader, writer: &WriterHandle) {
    refresh(shared, reader, Activity::Idle);
    loop {
        let (stop, backfill, tables_open) = {
            let control = shared.control();
            (control.stop, control.backfill, control.tables_open)
        };
        if stop {
            return;
        }
        if backfill {
            refresh(shared, reader, Activity::PausedBackfill);
            if wait(shared, IDLE_WAIT) {
                return;
            }
            continue;
        }
        match step(reader, writer, !tables_open) {
            Ok(Step::Rebuilt(_)) => {
                shared.status().last_error = None;
                refresh(shared, reader, Activity::Rebuilding);
            }
            Ok(Step::Indexed(_)) => {
                shared.status().last_error = None;
                refresh(shared, reader, Activity::Indexing);
            }
            Ok(Step::Counted(_)) => {
                shared.status().last_error = None;
                refresh(shared, reader, Activity::Counting);
            }
            Ok(Step::Computed(n, took)) => {
                {
                    let mut status = shared.status();
                    status.last_error = None;
                    status.ev_computed += u64::try_from(n).unwrap_or(0);
                    status.ev_millis += u64::try_from(took.as_millis()).unwrap_or(u64::MAX);
                }
                refresh(shared, reader, Activity::Computing);
            }
            Ok(Step::Reevaluated(..)) => {
                shared.status().last_error = None;
                refresh(shared, reader, Activity::Reevaluating);
            }
            Ok(Step::Nothing) => {
                let activity = if tables_open {
                    Activity::PausedTables
                } else {
                    Activity::Idle
                };
                refresh(shared, reader, activity);
                if wait(shared, IDLE_WAIT) {
                    return;
                }
                continue;
            }
            Err(Error::WriterGone) => return,
            Err(error) => {
                log::warn!("statistics pass: {error}");
                shared.status().last_error = Some(error.to_string());
                if wait(shared, Duration::from_secs(5)) {
                    return;
                }
                continue;
            }
        }
        thread::yield_now();
    }
}
