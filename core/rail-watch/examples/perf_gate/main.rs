//! The performance gate (docs/RAIL-PLAN.md R2.9; guideline §1): a
//! **generated** store of about a million hands, built through the real
//! import pipeline, and every guideline §1 target that exists before the
//! HUD measured on it.
//!
//! ```text
//! cargo run --release -p rail-watch --example perf_gate -- \
//!     [--hands 1000000] [--dir PATH] [--workers N] [--reuse] [--keep] \
//!     [--ev-budget SECONDS] [--runs 7] [--json FILE] [--markdown FILE] \
//!     [--gate] [--tolerance 1.5] [--m2-reference HANDS_PER_S] [--no-cold]
//! ```
//!
//! 1. **Dataset** (`../import_bench/dataset.rs`, `--rename-players
//!    --spread`): the repository's corpus replicated with fresh hand ids,
//!    fresh villain names (a real store's number of opponents, the corpus's
//!    regulars kept as heavy regulars) and every copy played a week before
//!    the one after it (a real day's volume: the corpus's sessions, tables
//!    and pace). Written to `--dir`, labelled `GENERATED.md`, deleted once
//!    imported (unless `--keep`); never under `testdata/` or a fixture tree.
//! 2. **Import** through the real watcher into an empty store (the backfill
//!    of "import everything"), with a reference conversion rate on this
//!    machine before and after it (as `import_bench`): hands stored per
//!    second and the pipeline efficiency.
//! 3. **The background pass** after the backfill, timed: the opponents'
//!    `player_hands` catching up, then the all-in EV queue (to its end, or
//!    for `--ev-budget` seconds and extrapolated).
//! 4. **HUD delay** (plan §3.3, the part that exists before the HUD): with
//!    the watcher running, a hand appended to a live table file, until the
//!    store has it (`hand_rows`) plus the HUD's lookup of its players
//!    (`hud_totals`) - one table, then twelve tables finishing a hand at the
//!    same moment.
//! 5. **The screens' queries**, each the first call after a commit (the
//!    reports' caches are per commit; the OS cache warm) and again: Reports
//!    opening (`hero_totals` + the graph) and its breakdown tabs, Today, the
//!    Hands list (first page, the worst filters, the chip counts), Players
//!    (the list, a profile, hands with a player, every page of the heaviest
//!    regular), the HUD's lookup for 9 players, the store's counts.
//! 6. **Cold**: the store's pages dropped from the OS cache (Linux:
//!    `posix_fadvise(POSIX_FADV_DONTNEED)`; macOS: the file rewritten
//!    through `F_NOCACHE`, so none of its pages is cached, then the flag
//!    cleared - no `sudo purge`), then the app's start: open the store,
//!    Today, Reports, a breakdown tab, Hands, Players; Reports as the very
//!    first screen; and the start as built - the background warm-up
//!    (`Reader::warm_up`, which the statistics pass runs when the app
//!    starts), timed, then the screens. The cold reads are reported, not
//!    gated (they measure the disk); the screens after the warm-up are.
//!
//! `--reuse` skips 1-4 when `--dir` already holds a store (iterating on a
//! query). Every time is also printed **normalised to the owner's M2 Pro**:
//! times this machine's reference rate / `--m2-reference` (the M2 Pro's,
//! measured on an idle machine; the queries are single-threaded CPU work, so
//! a slower runner's times shrink by the same factor); a dataset smaller
//! than 1M is scaled up linearly for the queries that read every hand.
//! With `--gate` the run exits 1 when a normalised time exceeds its budget
//! x `--tolerance`, or the import's efficiency falls below its floor
//! (budgets in [`BUDGETS`]; I/O-bound cold reads and the HUD delay are
//! absolute). `--json` / `--markdown` write the report.

// Times and rates are printed as decimals.
#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

#[allow(dead_code)]
#[path = "../import_bench/dataset.rs"]
mod dataset;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rail_core::convert::convert_file;
use rail_store::background::{self, Step};
use rail_store::hand_list::{HandCursor, HandFilter, PlayerRef};
use rail_store::players::{GameKind, PlayerQuery};
use rail_store::report::{ReportFilter, SESSION_GAP_MINUTES};
use rail_store::{HeroFilter, Reader, Store};
use rail_watch::{WatchConfig, WatchEvent, Watcher};

/// The owner's M2 Pro's reference rate (one thread converting the corpus,
/// `import_bench`'s reference), measured idle on 2026-10-14.
const M2_REFERENCE: u64 = 4_200;

/// Hands per copy of the corpus; the guideline's database is a million.
const MILLION: f64 = 1_000_000.0;

#[derive(Debug)]
struct Args {
    hands: u64,
    dir: PathBuf,
    workers: Option<usize>,
    reuse: bool,
    keep: bool,
    ev_budget: Option<u64>,
    runs: usize,
    json: Option<PathBuf>,
    markdown: Option<PathBuf>,
    gate: bool,
    tolerance: f64,
    m2_reference: u64,
    cold: bool,
    min_efficiency: Option<u64>,
}

fn args() -> Args {
    let mut args = Args {
        hands: 1_000_000,
        dir: std::env::temp_dir().join("rail-perf-gate"),
        workers: None,
        reuse: false,
        keep: false,
        ev_budget: None,
        runs: 7,
        json: None,
        markdown: None,
        gate: false,
        tolerance: 1.5,
        m2_reference: M2_REFERENCE,
        cold: true,
        min_efficiency: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().unwrap_or_else(|| panic!("{arg} needs a value"));
        match arg.as_str() {
            "--hands" => args.hands = value().parse().expect("--hands"),
            "--dir" => args.dir = PathBuf::from(value()),
            "--workers" => args.workers = Some(value().parse().expect("--workers")),
            "--reuse" => args.reuse = true,
            "--keep" => args.keep = true,
            "--ev-budget" => args.ev_budget = Some(value().parse().expect("--ev-budget")),
            "--runs" => args.runs = value().parse().expect("--runs"),
            "--json" => args.json = Some(PathBuf::from(value())),
            "--markdown" => args.markdown = Some(PathBuf::from(value())),
            "--gate" => args.gate = true,
            "--tolerance" => args.tolerance = value().parse().expect("--tolerance"),
            "--m2-reference" => args.m2_reference = value().parse().expect("--m2-reference"),
            "--no-cold" => args.cold = false,
            "--min-efficiency" => {
                args.min_efficiency = Some(value().parse().expect("--min-efficiency"));
            }
            other => panic!("unknown argument {other}"),
        }
    }
    args
}

/* ------------------------------------------------------------ metrics - */

/// How a metric is judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Single-threaded CPU work over the store (normalised to the M2 Pro).
    Cpu,
    /// Reads from the disk (absolute).
    Io,
    /// Wall-clock latency of the pipeline (absolute).
    Latency,
    /// Reported, not gated.
    Info,
}

#[derive(Debug, Clone)]
struct Metric {
    id: String,
    what: String,
    value: f64,
    unit: &'static str,
    kind: Kind,
    /// Grows with the number of hands (scaled to 1M when the dataset is
    /// smaller).
    linear: bool,
}

/// Budgets (M2-equivalent milliseconds for `Cpu`, absolute for the rest):
/// the guideline's 1 s for what a screen shows when it opens, the plan's
/// §3.3 for the HUD, and a regression budget for what is far under it.
const BUDGETS: &[(&str, f64, &str)] = &[
    (
        "hud.delay.1.p95",
        1000.0,
        "guideline §1: HUD < 1 s after the hand",
    ),
    (
        "hud.delay.12.p95",
        1000.0,
        "guideline §1, 12 tables at once",
    ),
    (
        "hud.lookup.9",
        10.0,
        "plan §3.3: query 6-9 players' rollups < 10 ms",
    ),
    ("app.open", 1000.0, "the store opens (migrations checked)"),
    (
        "reports.open.cash.first",
        1000.0,
        "guideline §1: report over 1M < 1 s",
    ),
    ("reports.open.everything.first", 1000.0, "guideline §1"),
    ("reports.open.stake.first", 1000.0, "guideline §1"),
    ("reports.open.month.first", 1000.0, "guideline §1"),
    ("reports.open.button.first", 1000.0, "guideline §1"),
    ("reports.breakdowns.cash.first", 1000.0, "guideline §1"),
    (
        "reports.breakdowns.everything.first",
        1000.0,
        "guideline §1",
    ),
    ("reports.breakdowns.stake.first", 1000.0, "guideline §1"),
    ("reports.breakdowns.month.first", 1000.0, "guideline §1"),
    ("reports.breakdowns.button.first", 1000.0, "guideline §1"),
    ("today.first", 1000.0, "the Today screen"),
    ("store.status", 50.0, "Today's tiles, every 5 s"),
    ("hands.page.first", 100.0, "the Hands list's first page"),
    (
        "hands.page.worst",
        1000.0,
        "the slowest filter's first page",
    ),
    ("hands.facets.first", 1000.0, "the chip counts"),
    (
        "players.list.first",
        1000.0,
        "the Players list after a commit",
    ),
    ("players.profile.top", 100.0, "a profile"),
    ("players.positions.top", 1000.0, "a profile's positions"),
    (
        "players.hands.first",
        1000.0,
        "hands with a player, first page",
    ),
    (
        "players.hands.page.max",
        1000.0,
        "hands with a player, any page",
    ),
    ("warmed.today", 1000.0, "after the start's warm-up: Today"),
    (
        "warmed.reports.open",
        1000.0,
        "after the warm-up: Reports (guideline §1)",
    ),
    (
        "warmed.reports.breakdowns",
        1000.0,
        "after the warm-up: a breakdown tab",
    ),
    ("warmed.players.list", 1000.0, "after the warm-up: Players"),
    // The cold reads (`cold.*`) are reported, not gated: they measure the
    // machine's disk as much as the store (a shared runner's disk is
    // several times an NVMe's latency). What the gate holds is the same
    // start after the background warm-up (`warmed.*`, CPU from there).
];

#[derive(Debug, Default)]
struct Report {
    metrics: Vec<Metric>,
    notes: Vec<String>,
}

impl Report {
    fn add(
        &mut self,
        id: &str,
        what: &str,
        value: f64,
        unit: &'static str,
        kind: Kind,
        linear: bool,
    ) {
        println!("{id:<40} {value:>12.2} {unit:<8} {what}");
        self.metrics.push(Metric {
            id: id.to_owned(),
            what: what.to_owned(),
            value,
            unit,
            kind,
            linear,
        });
    }

    fn ms(&mut self, id: &str, what: &str, d: Duration, kind: Kind, linear: bool) {
        self.add(id, what, d.as_secs_f64() * 1000.0, "ms", kind, linear);
    }

    fn note(&mut self, text: String) {
        println!("{text}");
        self.notes.push(text);
    }
}

/// The first call's time and the median of `runs` more.
fn times(runs: usize, mut f: impl FnMut()) -> (Duration, Duration) {
    let mut once = || {
        let started = Instant::now();
        f();
        started.elapsed()
    };
    let first = once();
    let mut rest: Vec<Duration> = (0..runs).map(|_| once()).collect();
    rest.sort_unstable();
    (first, rest.get(rest.len() / 2).copied().unwrap_or(first))
}

fn timed<T>(f: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let out = f();
    (out, started.elapsed())
}

/* ---------------------------------------------------------- the cache - */

/// Drop `path`'s pages from the OS cache (the store must be closed); says
/// how.
#[cfg(target_os = "linux")]
fn evict(path: &Path) -> Result<&'static str, String> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn posix_fadvise(fd: i32, offset: i64, len: i64, advice: i32) -> i32;
    }
    const POSIX_FADV_DONTNEED: i32 = 4;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    // SAFETY: a valid open descriptor; the call only advises the kernel.
    let rc = unsafe { posix_fadvise(file.as_raw_fd(), 0, 0, POSIX_FADV_DONTNEED) };
    if rc == 0 {
        Ok("posix_fadvise(POSIX_FADV_DONTNEED) on the store file")
    } else {
        Err(format!("posix_fadvise failed: {rc}"))
    }
}

/// macOS has no per-file eviction without `sudo purge`: the file is
/// copied with `F_NOCACHE` on both ends (the copy's pages never enter the
/// unified buffer cache) and renamed over the original, whose cached pages
/// go with its inode.
#[cfg(target_os = "macos")]
fn evict(path: &Path) -> Result<&'static str, String> {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    const F_NOCACHE: i32 = 48;
    let nocache = |file: &std::fs::File| -> Result<(), String> {
        // SAFETY: a valid open descriptor; F_NOCACHE takes an int.
        let rc = unsafe { fcntl(file.as_raw_fd(), F_NOCACHE, 1_i32) };
        if rc == -1 {
            Err("fcntl(F_NOCACHE) failed".to_owned())
        } else {
            Ok(())
        }
    };
    let mut copy_path = path.as_os_str().to_owned();
    copy_path.push(".evict");
    let copy_path = PathBuf::from(copy_path);
    {
        let mut from = std::fs::File::open(path).map_err(|e| e.to_string())?;
        nocache(&from)?;
        let mut to = std::fs::File::create(&copy_path).map_err(|e| e.to_string())?;
        nocache(&to)?;
        let mut buffer = vec![0_u8; 8 << 20];
        loop {
            let n = from.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            to.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        to.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&copy_path, path).map_err(|e| e.to_string())?;
    // F_NOCACHE is a flag of the file (its vnode), not of the descriptor:
    // left on, every later read would bypass the cache, the warm runs
    // included. Off again: nothing of the file is cached, and reads cache
    // as usual from here.
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    // SAFETY: a valid open descriptor; F_NOCACHE takes an int.
    if unsafe { fcntl(file.as_raw_fd(), F_NOCACHE, 0_i32) } == -1 {
        return Err("fcntl(F_NOCACHE, 0) failed".to_owned());
    }
    Ok("the store file rewritten through F_NOCACHE (no sudo purge), then caching on again")
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn evict(_path: &Path) -> Result<&'static str, String> {
    Err("no eviction on this platform".to_owned())
}

/* ----------------------------------------------------------- the import - */

fn remove_store(db: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = db.as_os_str().to_owned();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

/// One thread converting every template from memory: `rail_core` alone.
fn reference_rate(selection: &dataset::Selection) -> u64 {
    let started = Instant::now();
    let mut hands = 0_u64;
    for template in &selection.templates {
        let conversion = convert_file(&template.bytes, &dataset::options(&template.relative));
        if let Some(Ok(result)) = conversion.result.as_ref() {
            hands += u64::try_from(result.hands.len()).expect("hands");
        }
    }
    let rate = u64::try_from(u128::from(hands) * 1000 / started.elapsed().as_millis().max(1))
        .unwrap_or(u64::MAX);
    println!("reference: 1 thread converts {hands} hands in memory -> {rate} hands/s");
    rate
}

/// The import of the dataset through the watcher; returns hands stored per
/// second and leaves the store closed.
fn import(data: &dataset::Dataset, db: &Path, workers: usize) -> (u64, u64, Duration) {
    remove_store(db);
    let store = Store::open(db).expect("store");
    // Per file (relative to the dataset), how far it is committed.
    let committed: Arc<Mutex<HashMap<PathBuf, u64>>> = Arc::default();
    let root_dir = data.dir.clone();
    let watcher = {
        let committed = Arc::clone(&committed);
        Watcher::start(
            db,
            store.writer().expect("writer"),
            WatchConfig {
                workers,
                ..WatchConfig::default()
            },
            move |event| {
                if let WatchEvent::Imported { path, to, .. } = event {
                    let relative = path.strip_prefix(&root_dir).unwrap_or(&path).to_path_buf();
                    let mut map = committed.lock().expect("committed");
                    let entry = map.entry(relative).or_insert(0);
                    *entry = (*entry).max(to);
                }
            },
        )
        .expect("watcher")
    };
    let want: Vec<(PathBuf, u64)> = data
        .files
        .iter()
        .map(|(path, size)| {
            (
                path.strip_prefix(&data.dir).expect("inside").to_path_buf(),
                *size,
            )
        })
        .collect();
    let started = Instant::now();
    watcher
        .add_source(&data.dir, true, Some(false))
        .expect("add the folder");
    let mut last = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let done = {
            let map = committed.lock().expect("committed");
            want.iter()
                .filter(|(path, size)| map.get(path).is_some_and(|to| to >= size))
                .count()
        };
        if last.elapsed() >= Duration::from_secs(10) {
            last = Instant::now();
            eprintln!(
                "  {:>6.1} s: {done}/{} files",
                started.elapsed().as_secs_f64(),
                data.files.len()
            );
        }
        if done == data.files.len() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(4 * 3600),
            "the import did not finish in four hours"
        );
    }
    let elapsed = started.elapsed();
    let stored = store.status().expect("status").hands;
    watcher.stop();
    store.close();
    let rate =
        u64::try_from(u128::from(stored) * 1000 / elapsed.as_millis().max(1)).unwrap_or(u64::MAX);
    (rate, stored, elapsed)
}

/* ------------------------------------------------- the background pass - */

fn background_pass(db: &Path, budget: Option<u64>, report: &mut Report) {
    let store = Store::open(db).expect("open");
    let writer = store.writer().expect("writer");
    let reader = store.reader();
    let pending = reader.stats_status().expect("status").ev_pending;
    let (mut indexed, mut index_time) = (0_usize, Duration::ZERO);
    let (mut ev_rows, mut ev_time, mut ev_compute) = (0_usize, Duration::ZERO, Duration::ZERO);
    let started = Instant::now();
    let mut stopped = false;
    loop {
        let step_started = Instant::now();
        match background::step(reader, &writer, true).expect("step") {
            Step::Rebuilt(_) => {}
            Step::Indexed(n) => {
                indexed += n;
                index_time += step_started.elapsed();
            }
            Step::Computed(n, took) => {
                ev_rows += n;
                ev_time += step_started.elapsed();
                ev_compute += took;
                if budget.is_some_and(|b| ev_time >= Duration::from_secs(b)) {
                    stopped = true;
                    break;
                }
            }
            Step::Nothing => break,
        }
    }
    report.add(
        "background.players.s",
        &format!("the opponents' index catching up after the backfill ({indexed} hands)"),
        index_time.as_secs_f64(),
        "s",
        Kind::Info,
        true,
    );
    let per = ev_time.as_secs_f64() / ev_rows.max(1) as f64;
    let total = if stopped {
        per * pending as f64
    } else {
        ev_time.as_secs_f64()
    };
    report.add(
        "background.ev.s",
        &format!(
            "the all-in EV queue after the backfill: {pending} preflop all-ins, {ev_rows} done{}, \
             {:.1} ms each ({:.1} ms computing)",
            if stopped {
                ", the rest extrapolated"
            } else {
                ""
            },
            per * 1000.0,
            ev_compute.as_secs_f64() * 1000.0 / ev_rows.max(1) as f64
        ),
        total,
        "s",
        Kind::Info,
        true,
    );
    println!("background pass: {:.1?}", started.elapsed());
    drop(writer);
    store.close();
}

/* ------------------------------------------------------- the HUD delay - */

/// A live table: hand texts to append one at a time.
#[derive(Debug)]
struct LiveTable {
    path: PathBuf,
    /// (hand key, text with its line ends, players).
    hands: Vec<(String, String, Vec<String>)>,
}

/// `tables` live tables from PokerStars cash templates, each a fresh copy
/// (ids never seen by the store).
fn live_tables(
    selection: &dataset::Selection,
    dir: &Path,
    tables: usize,
    first_copy: usize,
) -> Vec<LiveTable> {
    // Text rooms whose hands follow each other with blank lines between
    // them: the room's own files, a hand at a time.
    let mut candidates: Vec<&dataset::Template> = selection
        .templates
        .iter()
        .filter(|t| {
            let path = t.relative.to_string_lossy();
            (path.contains("pokerstars") || path.starts_with("weplay-hh")) && t.hands >= 16
        })
        .collect();
    candidates.sort_by_key(|t| std::cmp::Reverse(t.hands));
    assert!(
        !candidates.is_empty(),
        "a PokerStars or WePlay template with 16 hands"
    );
    let perms = dataset::permutations(first_copy + tables + 1);
    (0..tables)
        .map(|i| {
            let template = candidates[i % candidates.len()];
            let copy = first_copy + i;
            let bytes = template.rewrite(&perms[copy], copy);
            let conversion = convert_file(&bytes, &dataset::options(&template.relative));
            let result = conversion
                .result
                .and_then(Result::ok)
                .expect("the live table converts");
            let hands = result
                .hands
                .into_iter()
                .map(|converted| {
                    let hand = converted.hand;
                    let mut text = hand.meta.raw_text.trim_end().to_owned();
                    text.push_str("\n\n\n");
                    let players = hand.players.iter().map(|p| p.name.clone()).collect();
                    (rail_store::batch::hand_key_of(&hand), text, players)
                })
                .collect();
            LiveTable {
                path: dir.join(format!("table-{i:02}.txt")),
                hands,
            }
        })
        .collect()
}

/// Rounds of every table finishing a hand at once: per hand, the time from
/// its bytes written to the store having it, plus the HUD's lookup of its
/// players. Returns the delays.
fn hud_rounds(reader: &Reader, tables: &[LiveTable], rounds: usize) -> Vec<Duration> {
    use std::io::Write;
    let mut delays = Vec::new();
    for round in 0..rounds {
        let mut waiting: Vec<(String, String, Vec<String>, Instant)> = Vec::new();
        for table in tables {
            let Some((key, text, players)) = table.hands.get(round) else {
                continue;
            };
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&table.path)
                .expect("live file");
            file.write_all(text.as_bytes()).expect("append");
            file.flush().expect("flush");
            drop(file);
            let site = key.split(':').next().unwrap_or_default().to_owned();
            waiting.push((key.clone(), site, players.clone(), Instant::now()));
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while !waiting.is_empty() {
            let keys: Vec<String> = waiting.iter().map(|w| w.0.clone()).collect();
            let found = reader.hand_rows(&keys).expect("rows");
            let now = Instant::now();
            waiting.retain(|(key, site, players, written)| {
                if !found.iter().any(|row| &row.hand_key == key) {
                    return true;
                }
                let table: Vec<(&str, &str)> = players.iter().map(|p| (p.as_str(), "")).collect();
                reader.hud_totals(site, &table, None).expect("hud");
                delays.push(now.duration_since(*written) + now.elapsed());
                false
            });
            assert!(Instant::now() < deadline, "a live hand never arrived");
            std::thread::sleep(Duration::from_millis(2));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    delays
}

fn percentile(sorted: &[Duration], p: usize) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    sorted[(sorted.len() - 1) * p / 100]
}

fn hud_delay(
    db: &Path,
    selection: &dataset::Selection,
    base: &Path,
    first_copy: usize,
    report: &mut Report,
) {
    let live = base.join("live-tables");
    let _ = std::fs::remove_dir_all(&live);
    std::fs::create_dir_all(&live).expect("live dir");
    let store = Store::open(db).expect("open");
    let watcher = Watcher::start(
        db,
        store.writer().expect("writer"),
        WatchConfig::default(),
        |_| {},
    )
    .expect("watcher");
    watcher
        .add_source(&live, true, Some(false))
        .expect("live folder");
    std::thread::sleep(Duration::from_millis(500));
    for (tables, rounds) in [(1_usize, 15_usize), (12, 8)] {
        let set = live_tables(selection, &live, tables, first_copy + tables * 10);
        let mut delays = hud_rounds(store.reader(), &set, rounds);
        delays.sort_unstable();
        let what = format!(
            "{tables} table(s), {} hands: the hand appended -> in the store + its players' HUD lookup",
            delays.len()
        );
        report.ms(
            &format!("hud.delay.{tables}.p50"),
            &what,
            percentile(&delays, 50),
            Kind::Info,
            false,
        );
        report.ms(
            &format!("hud.delay.{tables}.p95"),
            &what,
            percentile(&delays, 95),
            Kind::Latency,
            false,
        );
        report.ms(
            &format!("hud.delay.{tables}.max"),
            &what,
            percentile(&delays, 100),
            Kind::Info,
            false,
        );
    }
    watcher.stop();
    store.close();
    let _ = std::fs::remove_dir_all(&live);
}

/* -------------------------------------------------------- the queries - */

/// What the screens read, on a freshly opened store.
#[derive(Debug, Default)]
struct Probes {
    stake: String,
    month_from: String,
    top: Option<(String, String)>,
    hud_site: String,
    hud_players: Vec<String>,
}

fn probes(reader: &Reader, db: &Path) -> Probes {
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open");
    let stake: String = conn
        .query_row(
            "SELECT g.stake FROM hand_list l JOIN segments g ON g.id = l.segment_id
             WHERE l.hero_net IS NOT NULL GROUP BY g.stake ORDER BY count(*) DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();
    let newest = reader
        .latest_session(SESSION_GAP_MINUTES, 0)
        .expect("session")
        .map(|s| s.ended_at)
        .unwrap_or_default();
    let month_from = format!("{}-01T00:00:00.000Z", newest.get(..7).unwrap_or("2026-01"));
    let top = reader
        .player_list(&PlayerQuery {
            limit: 1,
            ..PlayerQuery::default()
        })
        .expect("list")
        .rows
        .first()
        .map(|row| (row.site.clone(), row.player.clone()));
    let (hud_site, segment): (String, i64) = conn
        .query_row(
            "SELECT site, segment_id FROM player_rollups GROUP BY 1, 2 ORDER BY sum(hands) DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("busiest segment");
    let hud_players: Vec<String> = conn
        .prepare(
            "SELECT player FROM player_rollups WHERE site = ?1 AND segment_id = ?2 AND scope = ''
             ORDER BY hands DESC LIMIT 9",
        )
        .expect("prepare")
        .query_map(rusqlite::params![hud_site, segment], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("players");
    Probes {
        stake,
        month_from,
        top,
        hud_site,
        hud_players,
    }
}

fn report_filters(p: &Probes) -> Vec<(&'static str, ReportFilter)> {
    vec![
        (
            "cash",
            ReportFilter {
                formats: vec!["cash".to_owned()],
                ..ReportFilter::default()
            },
        ),
        ("everything", ReportFilter::default()),
        (
            "stake",
            ReportFilter {
                stakes: vec![p.stake.clone()],
                ..ReportFilter::default()
            },
        ),
        (
            "month",
            ReportFilter {
                from: Some(p.month_from.clone()),
                ..ReportFilter::default()
            },
        ),
        (
            "button",
            ReportFilter {
                positions: vec!["BTN".to_owned()],
                ..ReportFilter::default()
            },
        ),
    ]
}

/// What opening Reports reads (the app's `build_report`'s store calls).
fn open_reports(reader: &Reader, filter: &ReportFilter) {
    reader.report_open(filter, 1500).expect("report");
    reader.segments().expect("segments");
}

/// A breakdown tab's first click (`build_breakdowns`' store calls).
fn breakdowns(reader: &Reader, filter: &ReportFilter) {
    reader.report_graph(filter, 1).expect("units");
    reader.report_breakdowns(filter).expect("breakdowns");
}

/// Today (`build_today`'s store calls) and the status tiles.
fn today(reader: &Reader) {
    reader.status().expect("status");
    if let Some(session) = reader
        .latest_session(SESSION_GAP_MINUTES, 5)
        .expect("session")
    {
        let hero = HeroFilter {
            from: Some(session.started_at.clone()),
            to: Some(format!("{}~", session.ended_at)),
            ..HeroFilter::default()
        };
        reader.hero_totals(&hero).expect("totals");
        reader.hand_rows(&session.biggest_pots).expect("pots");
    }
}

/// Touch the store (a commit), so every per-commit cache starts again.
fn commit(store: &Store) {
    store
        .writer()
        .expect("writer")
        .write(|tx| {
            tx.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('perf_gate.touch', '1', 0)
                 ON CONFLICT (key) DO UPDATE SET updated_at = updated_at + 1",
                [],
            )?;
            Ok(())
        })
        .expect("touch");
}

fn queries(db: &Path, runs: usize, report: &mut Report) {
    let (store, open) = timed(|| Store::open(db).expect("open"));
    report.ms(
        "app.open",
        "Store::open (OS cache warm)",
        open,
        Kind::Cpu,
        false,
    );
    let reader = store.reader();
    let p = probes(reader, db);

    // HUD lookup.
    let table: Vec<(&str, &str)> = p.hud_players.iter().map(|n| (n.as_str(), "")).collect();
    let mut lookups: Vec<Duration> = (0..2001)
        .map(|_| timed(|| reader.hud_totals(&p.hud_site, &table, None).expect("hud")).1)
        .collect();
    lookups.sort_unstable();
    report.ms(
        "hud.lookup.9",
        &format!("the HUD's lookup, 9 players, every segment of the site (median of 2 000; p99 {:.3} ms)",
            percentile(&lookups, 99).as_secs_f64() * 1000.0),
        percentile(&lookups, 50),
        Kind::Cpu,
        false,
    );

    // Reports.
    // Warm: every report once first, so the OS cache holds what they read
    // (the cold case is measured apart, below).
    for (_, filter) in report_filters(&p) {
        open_reports(reader, &filter);
        breakdowns(reader, &filter);
    }
    for (name, filter) in report_filters(&p) {
        commit(&store);
        let (first, again) = times(runs, || {
            open_reports(reader, &filter);
        });
        report.ms(
            &format!("reports.open.{name}.first"),
            &format!("Reports opens ({name}): hero_totals and the graph at once, first call after a commit"),
            first,
            Kind::Cpu,
            true,
        );
        report.ms(
            &format!("reports.open.{name}.again"),
            "again (cached graph)",
            again,
            Kind::Info,
            true,
        );
        let (_, totals) = times(runs, || {
            let hero = reader.report_hero_filter(&filter).expect("filter");
            reader.hero_totals(&hero).expect("totals");
        });
        report.ms(
            &format!("reports.hero_totals.{name}"),
            "of which hero_totals (median)",
            totals,
            Kind::Info,
            true,
        );
    }
    for (name, filter) in report_filters(&p) {
        commit(&store);
        let (first, again) = times(runs, || breakdowns(reader, &filter));
        report.ms(
            &format!("reports.breakdowns.{name}.first"),
            &format!(
                "a breakdown tab (pot type, stack, hand grid, players, street; {name}), first click"
            ),
            first,
            Kind::Cpu,
            true,
        );
        report.ms(
            &format!("reports.breakdowns.{name}.again"),
            "again",
            again,
            Kind::Info,
            true,
        );
    }

    // Today.
    commit(&store);
    let (first, again) = times(runs, || today(reader));
    report.ms(
        "today.first",
        "Today: status, the latest session, its statistics and pots",
        first,
        Kind::Cpu,
        false,
    );
    report.ms("today.again", "again", again, Kind::Info, false);
    let (_, status) = times(runs, || {
        reader.status().expect("status");
    });
    report.ms(
        "store.status",
        "Store::status (the tiles' counts)",
        status,
        Kind::Cpu,
        true,
    );

    // Hands.
    let worst: Vec<(&str, HandFilter)> = vec![
        ("no filter", HandFilter::default()),
        (
            "one stake",
            HandFilter {
                stakes: vec![p.stake.clone()],
                ..HandFilter::default()
            },
        ),
        (
            "a room and 6-max",
            HandFilter {
                sites: vec![p.hud_site.clone()],
                sizes: vec!["6max".to_owned()],
                ..HandFilter::default()
            },
        ),
        (
            "nothing matches (UTG heads-up)",
            HandFilter {
                sizes: vec!["hu".to_owned()],
                positions: vec!["UTG".to_owned()],
                ..HandFilter::default()
            },
        ),
        (
            "3-bet pots, 80-120 bb",
            HandFilter {
                pot_types: vec!["3bet".to_owned()],
                stacks: vec!["80-120".to_owned()],
                ..HandFilter::default()
            },
        ),
    ];
    let mut worst_first = (Duration::ZERO, "");
    for (i, (name, filter)) in worst.iter().enumerate() {
        let (first, again) = times(runs, || {
            reader.hand_page(filter, None, 100).expect("page");
        });
        if i == 0 {
            report.ms(
                "hands.page.first",
                "Hands: the first page of 100, no filter",
                first,
                Kind::Cpu,
                false,
            );
            report.ms("hands.page.again", "again", again, Kind::Info, false);
        }
        println!(
            "  hands page, {name}: first {:.1} ms, again {:.1} ms",
            first.as_secs_f64() * 1000.0,
            again.as_secs_f64() * 1000.0
        );
        if first > worst_first.0 {
            worst_first = (first, name);
        }
    }
    report.ms(
        "hands.page.worst",
        &format!("Hands: the slowest filter's first page ({})", worst_first.1),
        worst_first.0,
        Kind::Cpu,
        true,
    );
    commit(&store);
    let (first, again) = times(runs, || {
        reader.hand_facets(&HandFilter::default()).expect("facets");
    });
    report.ms(
        "hands.facets.first",
        "Hands: the chip counts over the whole store, after a commit",
        first,
        Kind::Cpu,
        true,
    );
    report.ms(
        "hands.facets.again",
        "again (a chip clicked)",
        again,
        Kind::Info,
        true,
    );

    // Players.
    commit(&store);
    let everyone = PlayerQuery {
        limit: 200,
        ..PlayerQuery::default()
    };
    let (first, again) = times(runs, || {
        reader.player_list(&everyone).expect("list");
    });
    report.ms(
        "players.list.first",
        "Players: the list (200 rows), first call after a commit",
        first,
        Kind::Cpu,
        true,
    );
    report.ms("players.list.again", "again", again, Kind::Info, true);
    let list = reader
        .player_list(&PlayerQuery {
            limit: 1,
            kind: GameKind::All,
            ..PlayerQuery::default()
        })
        .expect("list");
    report.add(
        "dataset.opponents",
        "named opponents with hands together",
        list.players as f64,
        "players",
        Kind::Info,
        false,
    );
    if let Some((site, player)) = &p.top {
        let (first, _) = times(runs, || {
            reader.player_profile(site, player).expect("profile");
        });
        report.ms(
            "players.profile.top",
            "a profile: the opponent with the most hands together",
            first,
            Kind::Cpu,
            false,
        );
        let (first, _) = times(runs.min(3), || {
            reader
                .player_positions(site, player, None)
                .expect("positions");
        });
        report.ms(
            "players.positions.top",
            "their positions",
            first,
            Kind::Cpu,
            true,
        );
        let filter = HandFilter {
            player: Some(PlayerRef {
                site: site.clone(),
                player: player.clone(),
            }),
            ..HandFilter::default()
        };
        let (first, _) = times(runs, || {
            reader.hand_page(&filter, None, 100).expect("page");
        });
        report.ms(
            "players.hands.first",
            "hands with them: the first page",
            first,
            Kind::Cpu,
            true,
        );
        let mut pages: Vec<Duration> = Vec::new();
        let mut after: Option<HandCursor> = None;
        let mut rows = 0;
        let started = Instant::now();
        loop {
            let (page, took) = timed(|| {
                reader
                    .hand_page(&filter, after.as_ref(), 300)
                    .expect("page")
            });
            pages.push(took);
            rows += page.rows.len();
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        let every = started.elapsed();
        let max = pages.iter().copied().max().unwrap_or_default();
        report.add(
            "players.hands.rows",
            "the heaviest regular's hands together",
            rows as f64,
            "hands",
            Kind::Info,
            true,
        );
        report.ms(
            "players.hands.page.max",
            "hands with them: the slowest page of 300 scrolling through all",
            max,
            Kind::Cpu,
            true,
        );
        report.ms(
            "players.hands.every",
            "hands with them: every page (300 a page)",
            every,
            Kind::Info,
            true,
        );
    }
    store.close();
}

/// The app's start on a cold store: Today, Reports, a breakdown tab,
/// Hands, Players - each the first read of its tables.
fn cold(db: &Path, report: &mut Report) {
    match evict(db) {
        Ok(how) => report.note(format!("cold: {how}")),
        Err(why) => {
            report.note(format!("cold: not measured ({why})"));
            return;
        }
    }
    let (store, open) = timed(|| Store::open(db).expect("open"));
    report.ms("cold.open", "cold: Store::open", open, Kind::Io, false);
    let reader = store.reader();
    let (_, t) = timed(|| {
        reader.status().expect("status");
    });
    report.ms(
        "cold.status",
        "cold: the store's counts (Today's tiles)",
        t,
        Kind::Info,
        true,
    );
    let (_, t) = timed(|| today(reader));
    report.ms("cold.today", "cold: then Today", t, Kind::Io, true);
    let cash = ReportFilter {
        formats: vec!["cash".to_owned()],
        ..ReportFilter::default()
    };
    let (_, t) = timed(|| open_reports(reader, &cash));
    report.ms(
        "cold.reports.open",
        "cold: Reports opens (cash)",
        t,
        Kind::Io,
        true,
    );
    let (_, t) = timed(|| breakdowns(reader, &cash));
    report.ms(
        "cold.reports.breakdowns",
        "cold: then a breakdown tab",
        t,
        Kind::Io,
        true,
    );
    let (_, t) = timed(|| {
        reader
            .hand_page(&HandFilter::default(), None, 100)
            .expect("page");
    });
    report.ms(
        "cold.hands.page",
        "cold: then the Hands list",
        t,
        Kind::Io,
        false,
    );
    let (_, t) = timed(|| {
        reader
            .player_list(&PlayerQuery {
                limit: 200,
                ..PlayerQuery::default()
            })
            .expect("list");
    });
    report.ms(
        "cold.players.list",
        "cold: then the Players list",
        t,
        Kind::Io,
        true,
    );
    store.close();
    // Reports first, on a cold store (the R2.7b case).
    if evict(db).is_ok() {
        let store = Store::open(db).expect("open");
        let (_, t) = timed(|| open_reports(store.reader(), &cash));
        report.ms(
            "cold.reports.first",
            "cold: Reports as the first screen (cash)",
            t,
            Kind::Io,
            true,
        );
        let (_, t) = timed(|| breakdowns(store.reader(), &cash));
        report.ms(
            "cold.reports.first.breakdowns",
            "cold: then a breakdown tab",
            t,
            Kind::Io,
            true,
        );
        store.close();
    }
    // The app's start as built: the background pass warms the store up
    // first (`Reader::warm_up`, on its own connections), then the user opens
    // the screens.
    if evict(db).is_ok() {
        let store = Store::open(db).expect("open");
        let (_, t) = timed(|| {
            Reader::open(db, rail_store::report::WARM_UP_CONNECTIONS)
                .expect("reader")
                .warm_up()
                .expect("warm up");
        });
        report.ms(
            "warmed.warm_up",
            "after start: the background warm-up of a cold store",
            t,
            Kind::Info,
            true,
        );
        let reader = store.reader();
        let (_, t) = timed(|| today(reader));
        report.ms(
            "warmed.today",
            "after the warm-up: Today",
            t,
            Kind::Cpu,
            false,
        );
        let (_, t) = timed(|| open_reports(reader, &cash));
        report.ms(
            "warmed.reports.open",
            "after the warm-up: Reports opens (cash)",
            t,
            Kind::Cpu,
            true,
        );
        let (_, t) = timed(|| breakdowns(reader, &cash));
        report.ms(
            "warmed.reports.breakdowns",
            "after the warm-up: a breakdown tab",
            t,
            Kind::Cpu,
            true,
        );
        let (_, t) = timed(|| {
            reader
                .player_list(&PlayerQuery {
                    limit: 200,
                    ..PlayerQuery::default()
                })
                .expect("list");
        });
        report.ms(
            "warmed.players.list",
            "after the warm-up: the Players list",
            t,
            Kind::Cpu,
            true,
        );
        store.close();
    }
}

/// Hands per day and sessions of the dataset as stored.
fn volume(db: &Path, report: &mut Report) {
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open");
    let mut days: Vec<i64> = conn
        .prepare(
            "SELECT count(*) FROM hand_list WHERE hero_net IS NOT NULL AND played_at > ''
             GROUP BY substr(played_at, 1, 10)",
        )
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("days")
        .collect::<Result<_, _>>()
        .expect("rows");
    days.sort_unstable();
    // By hand, not by day: the volume of the day a hand was played on (the
    // corpus's one-hand fixtures make many days of a single hand).
    let total: i64 = days.iter().sum();
    let at = |p: i64| {
        let mut seen = 0;
        for &n in &days {
            seen += n;
            if seen * 100 >= total * p {
                return n as f64;
            }
        }
        0.0
    };
    let span: (String, String) = conn
        .query_row(
            "SELECT min(played_at), max(played_at) FROM hand_list WHERE hero_net IS NOT NULL AND played_at > '2000'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_default();
    report.add(
        "dataset.days",
        &format!("days with hero hands ({} .. {})", span.0, span.1),
        days.len() as f64,
        "days",
        Kind::Info,
        false,
    );
    report.add(
        "dataset.day.median",
        "hero hands on the day of the median hand",
        at(50),
        "hands",
        Kind::Info,
        false,
    );
    report.add(
        "dataset.day.p90",
        "hero hands on the day of the 90th-percentile hand",
        at(90),
        "hands",
        Kind::Info,
        false,
    );
    report.add(
        "dataset.day.max",
        "hero hands on the busiest day",
        at(100),
        "hands",
        Kind::Info,
        false,
    );
    let sessions = rail_store::Store::open(db)
        .expect("open")
        .reader()
        .sessions(SESSION_GAP_MINUTES, usize::MAX, None)
        .expect("sessions");
    let mut lengths: Vec<u64> = sessions.iter().map(|s| s.hands).collect();
    lengths.sort_unstable();
    report.add(
        "dataset.sessions",
        &format!(
            "sessions (30-minute gaps across tables); median {} hands, the longest {}",
            lengths.get(lengths.len() / 2).copied().unwrap_or(0),
            lengths.last().copied().unwrap_or(0)
        ),
        sessions.len() as f64,
        "sessions",
        Kind::Info,
        false,
    );
}

/* ---------------------------------------------------------- the gate - */

fn budget_of(id: &str) -> Option<(f64, &'static str)> {
    BUDGETS
        .iter()
        .find(|(key, _, _)| *key == id)
        .map(|(_, budget, why)| (*budget, *why))
}

fn main() {
    let args = args();
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let base = args.dir.clone();
    let data_dir = base.join("generated-hands");
    let db = base.join("store").join(rail_store::FILE_NAME);
    std::fs::create_dir_all(&base).expect("dir");
    let _ = std::fs::write(base.join(".metadata_never_index"), b"");
    let mut report = Report::default();

    let started = Instant::now();
    let selection = dataset::templates(&root, cores, true, true);
    report.note(format!(
        "templates: {} of {} corpus files; villains renamed in {} ({} keep the corpus's names); \
         dates spread a week per copy in {} ({} keep the corpus's dates, {} hands a copy); {:.1} s",
        selection.templates.len(),
        selection.corpus_files,
        selection.renamed,
        selection.names_kept,
        selection.shifted,
        selection.dates_kept,
        selection.dates_kept_hands,
        started.elapsed().as_secs_f64()
    ));
    let per_copy: usize = selection.templates.iter().map(|t| t.hands).sum();
    let copies = usize::try_from(
        args.hands
            .div_ceil(u64::try_from(per_copy.max(1)).expect("n")),
    )
    .expect("copies")
    .max(1);
    let workers = args.workers.unwrap_or(WatchConfig::default().workers);

    let mut reference = reference_rate(&selection);
    if !(args.reuse && db.is_file()) {
        let started = Instant::now();
        let data = dataset::write(&data_dir, &selection, copies, cores);
        report.note(format!(
            "dataset (GENERATED, {}): {} copies -> {} files, {:.0} MiB, {} hands; {:.1} s",
            data.dir.display(),
            copies,
            data.files.len(),
            data.bytes as f64 / f64::from(1 << 20),
            data.hands,
            started.elapsed().as_secs_f64()
        ));
        let (rate, stored, took) = import(&data, &db, workers);
        let after = reference_rate(&selection);
        let mean = reference.midpoint(after);
        reference = mean;
        let efficiency = rate as f64 * 100.0 / (mean as f64 * workers as f64);
        report.add(
            "import.rate",
            &format!(
                "hands stored per second through the watcher ({stored} hands in {:.1} s, {workers} \
                 import threads on {cores} cores; guideline >= 5 000)",
                took.as_secs_f64()
            ),
            rate as f64,
            "hands/s",
            Kind::Info,
            false,
        );
        report.add(
            "import.efficiency",
            "rate / (reference x threads)",
            efficiency,
            "%",
            Kind::Info,
            false,
        );
        if !args.keep {
            let _ = std::fs::remove_dir_all(&data_dir);
        }
        let size = std::fs::metadata(&db).map_or(0, |m| m.len());
        report.add(
            "store.mib",
            "the store's size after the import",
            size as f64 / f64::from(1 << 20),
            "MiB",
            Kind::Info,
            true,
        );
        report.add(
            "store.bytes_per_hand",
            "bytes a hand",
            size as f64 / stored.max(1) as f64,
            "B",
            Kind::Info,
            false,
        );
        background_pass(&db, args.ev_budget, &mut report);
        hud_delay(&db, &selection, &base, copies + 1000, &mut report);
    }
    report.add(
        "reference",
        "this machine's reference rate (one thread, rail_core)",
        reference as f64,
        "hands/s",
        Kind::Info,
        false,
    );
    let stored = Store::open(&db)
        .expect("open")
        .status()
        .expect("status")
        .hands;
    report.add(
        "dataset.hands",
        "hands in the store",
        stored as f64,
        "hands",
        Kind::Info,
        false,
    );
    volume(&db, &mut report);
    queries(&db, args.runs, &mut report);
    if args.cold {
        cold(&db, &mut report);
    }

    // Normalise and judge.
    let factor = reference as f64 / args.m2_reference as f64;
    let size = MILLION / (stored.max(1) as f64);
    let mut failed = Vec::new();
    let mut lines = String::new();
    let _ = writeln!(
        lines,
        "| metric | measured | M2-equivalent at 1M | budget | |\n| --- | ---: | ---: | ---: | --- |"
    );
    let mut json_metrics = Vec::new();
    for metric in &report.metrics {
        let normalised = match metric.kind {
            Kind::Cpu => metric.value * factor * if metric.linear { size } else { 1.0 },
            Kind::Io | Kind::Latency => metric.value * if metric.linear { size } else { 1.0 },
            Kind::Info => metric.value,
        };
        let budget = budget_of(&metric.id).filter(|_| metric.kind != Kind::Info);
        let verdict = budget.map(|(b, _)| normalised <= b * args.tolerance);
        if verdict == Some(false) {
            failed.push(metric.id.clone());
        }
        let _ = writeln!(
            lines,
            "| `{}` {} | {:.2} {} | {} | {} | {} |",
            metric.id,
            metric.what,
            metric.value,
            metric.unit,
            if metric.kind == Kind::Info {
                String::new()
            } else {
                format!("{normalised:.2}")
            },
            budget.map_or_else(String::new, |(b, why)| format!("{b} ({why})")),
            match (verdict, budget) {
                (Some(true), Some((b, _))) if normalised <= b => "met",
                (Some(true), _) => "over, within the tolerance",
                (Some(false), _) => "**FAIL**",
                (None, _) => "",
            }
        );
        json_metrics.push(serde_json::json!({
            "id": metric.id,
            "what": metric.what,
            "value": metric.value,
            "unit": metric.unit,
            "kind": format!("{:?}", metric.kind),
            "linear": metric.linear,
            "normalised": normalised,
            "budget": budget.map(|(b, _)| b),
            "pass": verdict,
        }));
    }
    let efficiency = report
        .metrics
        .iter()
        .find(|m| m.id == "import.efficiency")
        .map(|m| m.value);
    if let (Some(min), Some(found)) = (args.min_efficiency, efficiency)
        && found < min as f64
    {
        failed.push(format!("import.efficiency {found:.0} % < {min} %"));
    }
    println!(
        "\nnormalised: x {factor:.3} (reference {reference} / M2 Pro {}), x {size:.3} for the \
         queries that read every hand",
        args.m2_reference
    );
    print!("{lines}");
    if let Some(path) = &args.json {
        let json = serde_json::json!({
            "generated": "GENERATED DATA: a store built from copies of the repository's corpus (docs/RAIL-PLAN.md R2.9)",
            "hands": stored,
            "reference": reference,
            "m2_reference": args.m2_reference,
            "factor": factor,
            "size_factor": size,
            "tolerance": args.tolerance,
            "cores": cores,
            "workers": workers,
            "os": std::env::consts::OS,
            "notes": report.notes,
            "metrics": json_metrics,
            "failed": failed,
        });
        std::fs::write(path, serde_json::to_string_pretty(&json).expect("json"))
            .expect("write json");
    }
    if let Some(path) = &args.markdown {
        let mut text = format!(
            "# Rail performance gate (R2.9)\n\nGenerated store: {stored} hands. Reference {reference} \
             hands/s (M2 Pro {}), factor {factor:.3}; size factor {size:.3}; tolerance {}.\n\n",
            args.m2_reference, args.tolerance
        );
        for note in &report.notes {
            let _ = writeln!(text, "- {note}");
        }
        text.push('\n');
        text.push_str(&lines);
        if !failed.is_empty() {
            let _ = writeln!(text, "\n**Failed:** {}", failed.join(", "));
        }
        std::fs::write(path, text).expect("write markdown");
    }
    if !args.keep {
        remove_store(&db);
    }
    if args.gate && !failed.is_empty() {
        eprintln!("FAIL: {}", failed.join(", "));
        std::process::exit(1);
    }
    if args.gate {
        println!(
            "PASS: every gated metric within its budget x {}",
            args.tolerance
        );
    }
}
