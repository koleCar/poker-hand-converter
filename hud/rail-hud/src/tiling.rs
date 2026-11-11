//! (T2, docs/research/TABLE-TILING.md §4.3) Table tiling's engine: where
//! each table window goes. Platform-free and deterministic - no window
//! API, no thread, no clock of its own (every call is given `now`) - so it
//! is unit-tested here and runs headless on the simulator
//! (`crate::platform::sim`). The engine (`crate::engine`) feeds it what the
//! platform sees and hands its moves to the placement worker
//! (`crate::placer`), which applies the safety rules and calls
//! `Platform::place`.
//!
//! - **Layouts** ([`Layout`], [`Slot`]): slots on monitors, in thousandths
//!   of a monitor's work area; a monitor is named by its place in
//!   [`monitor_order`] (the primary first, then left to right), never by
//!   the system's id, which differs between machines and reconnects - a
//!   slot whose monitor is missing falls back to the primary and scales
//!   with it. Serde (camelCase), so T3 stores them in `hud_layouts`.
//! - **Auto grid** ([`AUTO_LAYOUT`], the default; [`auto_grid`]): for N
//!   tables, the rows x columns on each monitor that give the largest
//!   tables of every room's aspect ratio, spread over the monitors (the
//!   split whose smallest table is largest; the largest work area first),
//!   each monitor's grid a block of equal cells **edge to edge** centred
//!   in its work area. A room's minimum size caps how many cells fit;
//!   tables beyond that stack. The grid is recomputed when the table count
//!   changes, and **kept** when the current one still holds the tables at
//!   the best size there is (so a table opening into a free cell, or one
//!   closing, moves nothing else).
//! - **Assignment**: a new table takes the first free slot that accepts its
//!   room; when every slot is full it stacks on the stackable slot with the
//!   fewest tables. A closed table frees its slot; the most recently
//!   stacked table that fits moves into it, and with `close_gaps` the last
//!   table moves into a hole. **Stable**: a placed table never moves
//!   because another opened, except when the auto grid's shape changes. A
//!   table the user moved by hand is **pinned** - left where it is, its
//!   slot free for the next table (it still counts for the auto grid's
//!   shape, so pulling one out moves no other) - until [`Tiler::retile`].
//! - **Fit** ([`fit`], [`fit_in`]): a table gets the largest client area
//!   of its room's aspect ratio whose **outer rect** (client plus the
//!   window's own frame, [`Insets`], at the target monitor's scale) fits
//!   its slot, centred. Tiling the outer rects is what keeps tables edge
//!   to edge whatever frame a room's client or the system draws. A room's
//!   aspect ratio when nobody measured it: the window's client area as
//!   first seen.
//! - **Read-back**: the client area the platform reports after a placement
//!   is taken as it is. When the client refused the size it keeps its own
//!   size and is centred in its slot again - at most one retry per
//!   placement, never a loop.
//! - **Auto-switch**: a layout's `autoSwitch` rules pick another layout by
//!   the number of tables ([`AutoSwitch`]).
//! - **User moves**: a table whose rect changes while a mouse button is
//!   down, or was lately ([`Mouse`], the placement worker's samples) and the
//!   table is not settling from a placement of ours, is the user's doing:
//!   it is pinned, and a placement still queued for it is cancelled.
//!
//! Rooms the policy does not allow are never handed to the tiler (the
//! engine filters them), so nothing here can move them. Lobby slots
//! ([`SlotKind::Lobby`]) are stored but take no table: Rail finds tables
//! only.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::platform::{Insets, Monitor, PlatformError, Rect, WindowId};

/// The auto grid's layout id ([`Options::active`], an [`AutoSwitch`]
/// target).
pub const AUTO_LAYOUT: &str = "auto";

/// A room's aspect ratio when nothing says otherwise and the window gave
/// none (it was minimised when first seen).
pub const DEFAULT_ASPECT: Aspect = Aspect {
    width: 4,
    height: 3,
};

/// After a placement's answer, how long changes to the table are the
/// client settling (a dpi change on another monitor, a late resize) rather
/// than the user.
pub const SETTLE_GRACE: Duration = Duration::from_millis(1500);

/// A change counts as the user's when a mouse button was down this
/// recently ([`Mouse::Recent`]).
pub const USER_MOVE_CLICK: Duration = Duration::from_secs(2);

/// The mouse when a table's rect changed: whose doing the change was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mouse {
    /// No button down in the last [`USER_MOVE_CLICK`]: the client's own
    /// change (or ours).
    #[default]
    Idle,
    /// A button was down lately: the user's, unless the table is settling
    /// from a placement of ours ([`SETTLE_GRACE`]).
    Recent,
    /// A button is down now: the user's (no placement starts while one is).
    Down,
}

/// Pixels two rects may differ by and still count as the same place.
pub const TOLERANCE: u32 = 2;

/// The auto grid spreads over at most this many monitors (the largest).
const MAX_GRID_MONITORS: usize = 4;

// ---------------------------------------------------------------------
// Layouts as stored (T3: `hud_layouts` kind `tiling`).

/// A saved arrangement: slots on monitors, and rules that switch to another
/// layout by the number of tables.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub slots: Vec<Slot>,
    #[serde(default)]
    pub auto_switch: Vec<AutoSwitch>,
}

/// A rectangle of a monitor's work area that holds a table (or a stack).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub id: String,
    /// The monitor's place in [`monitor_order`]: 0 the primary, then left
    /// to right (top to bottom on a tie). Missing: the primary.
    #[serde(default)]
    pub monitor: u32,
    /// Thousandths of the monitor's work area.
    pub rect: SlotRect,
    #[serde(default)]
    pub kind: SlotKind,
    /// The rooms (`sites.json` ids) it takes; `None`: any.
    #[serde(default)]
    pub rooms: Option<Vec<String>>,
    /// It may hold a stack when every slot is full.
    #[serde(default)]
    pub stack: bool,
}

/// A slot's place, thousandths of the work area (0 - 1000).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// What a slot holds. `action` and `inHand` come later (§4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotKind {
    #[default]
    Play,
    /// A room's lobby window: stored, never given a table.
    Lobby,
}

/// From `min_tables` open tables on, layout `layout_id` ([`AUTO_LAYOUT`]
/// for the auto grid).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitch {
    pub min_tables: u32,
    pub layout_id: String,
}

// ---------------------------------------------------------------------
// Rooms and options.

/// An aspect ratio, width to height.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Aspect {
    pub width: u32,
    pub height: u32,
}

impl Aspect {
    /// `width : height` in lowest terms; `None` for an empty size.
    pub fn of(width: u32, height: u32) -> Option<Self> {
        if width == 0 || height == 0 {
            return None;
        }
        let g = gcd(width, height);
        Some(Self {
            width: width / g,
            height: height / g,
        })
    }

    /// Whether `width x height` has this ratio, to within a pixel of
    /// rounding.
    pub fn holds(&self, width: u32, height: u32) -> bool {
        let lhs = u64::from(width) * u64::from(self.height);
        let rhs = u64::from(height) * u64::from(self.width);
        lhs.abs_diff(rhs) <= u64::from(self.width.max(self.height))
    }
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a.max(1) } else { gcd(b, a % b) }
}

/// A room's table geometry (T6 measures it into `sites.json`
/// `tables.geometry`; until then the window's own).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RoomGeometry {
    /// The client area's aspect ratio; `None`: the window's as first seen.
    pub aspect: Option<Aspect>,
    /// The smallest client area the room draws its table in, logical
    /// pixels (at 100 %): `(width, height)`.
    pub min_client: Option<(u32, u32)>,
}

/// What the user chose (T3 sends it over the IPC; `--tiling auto` for
/// development).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The user's layouts.
    pub layouts: Vec<Layout>,
    /// The layout in force: one of `layouts`' ids, or [`AUTO_LAYOUT`].
    pub active: String,
    pub rooms: BTreeMap<String, RoomGeometry>,
    /// A closed table's hole is filled by the last table.
    pub close_gaps: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            layouts: Vec::new(),
            active: AUTO_LAYOUT.to_owned(),
            rooms: BTreeMap::new(),
            close_gaps: false,
        }
    }
}

// ---------------------------------------------------------------------
// Geometry.

/// The largest `width x height` of `aspect` inside `avail_w x avail_h`:
/// the height is the width's (rounded down), and the width the largest
/// whose height fits. Idempotent: a size it returns fits itself exactly.
pub fn fit(avail_w: u32, avail_h: u32, aspect: Aspect) -> (u32, u32) {
    if aspect.width == 0 || aspect.height == 0 {
        return (avail_w, avail_h);
    }
    let (aw, ah) = (u64::from(aspect.width), u64::from(aspect.height));
    let by_height = ((u64::from(avail_h) + 1) * aw - 1) / ah;
    let w = u64::from(avail_w).min(by_height);
    let h = w * ah / aw;
    (
        u32::try_from(w).unwrap_or(avail_w),
        u32::try_from(h).unwrap_or(avail_h),
    )
}

/// The outer rect of a table of `aspect` with frame `insets` fitted into
/// `cell` ([`fit`] of the client area), centred.
pub fn fit_in(cell: &Rect, insets: &Insets, aspect: Aspect) -> Rect {
    let (w, h) = fit(
        cell.width.saturating_sub(insets.width()),
        cell.height.saturating_sub(insets.height()),
        aspect,
    );
    centred(
        cell,
        w.saturating_add(insets.width()),
        h.saturating_add(insets.height()),
    )
}

/// A `width x height` rect centred in `cell` (it may stick out of a cell
/// smaller than itself, equally on both sides).
pub fn centred(cell: &Rect, width: u32, height: u32) -> Rect {
    let offset = |space: u32, size: u32| (i64::from(space) - i64::from(size)) / 2;
    let int = |v: i64| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
    Rect {
        x: int(i64::from(cell.x) + offset(cell.width, width)),
        y: int(i64::from(cell.y) + offset(cell.height, height)),
        width,
        height,
    }
}

/// Whether two rects are the same place to within [`TOLERANCE`].
pub fn close(a: &Rect, b: &Rect) -> bool {
    let t = i64::from(TOLERANCE);
    (i64::from(a.x) - i64::from(b.x)).abs() <= t
        && (i64::from(a.y) - i64::from(b.y)).abs() <= t
        && a.width.abs_diff(b.width) <= TOLERANCE
        && a.height.abs_diff(b.height) <= TOLERANCE
}

/// The monitors as layouts name them: indexes into `monitors`, the primary
/// first, then left to right, top to bottom on a tie.
pub fn monitor_order(monitors: &[Monitor]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..monitors.len()).collect();
    order.sort_by_key(|&i| {
        let m = &monitors[i];
        (!m.primary, m.bounds.x, m.bounds.y, i)
    });
    order
}

/// A slot's thousandths of `work` in pixels.
pub fn slot_rect(work: &Rect, rect: &SlotRect) -> Rect {
    let part = |size: u32, permille: u32| {
        u32::try_from(u64::from(size) * u64::from(permille.min(1000)) / 1000).unwrap_or(size)
    };
    let int = |v: i64| i32::try_from(v).unwrap_or(i32::MAX);
    let x0 = part(work.width, rect.x);
    let y0 = part(work.height, rect.y);
    let x1 = part(work.width, rect.x.saturating_add(rect.width));
    let y1 = part(work.height, rect.y.saturating_add(rect.height));
    Rect {
        x: int(i64::from(work.x) + i64::from(x0)),
        y: int(i64::from(work.y) + i64::from(y0)),
        width: x1.saturating_sub(x0),
        height: y1.saturating_sub(y0),
    }
}

/// Physical pixels at `scale_permille` as logical ones (100 %).
fn logical(px: u32, scale_permille: u32) -> u64 {
    u64::from(px) * 1000 / u64::from(scale_permille.max(1))
}

// ---------------------------------------------------------------------
// The auto grid.

/// The tables of one kind as the grid sizes them: a room's aspect ratio,
/// the window frame (at 100 %) and the room's minimum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Class {
    pub aspect: Aspect,
    pub insets: InsetsKey,
    pub min_client: Option<(u32, u32)>,
}

/// [`Insets`] as an ordered key (left, top, right, bottom).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct InsetsKey(pub u32, pub u32, pub u32, pub u32);

impl InsetsKey {
    pub fn of(insets: &Insets) -> Self {
        Self(insets.left, insets.top, insets.right, insets.bottom)
    }

    pub fn insets(&self) -> Insets {
        Insets {
            left: self.0,
            top: self.1,
            right: self.2,
            bottom: self.3,
        }
    }
}

/// One monitor's grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorGrid {
    /// Index into the monitors.
    pub monitor: usize,
    pub cols: u32,
    pub rows: u32,
    /// One cell, pixels: the representative table's outer rect.
    pub cell_w: u32,
    pub cell_h: u32,
    /// The smallest table's logical area of every class in a cell.
    pub score: u64,
}

impl MonitorGrid {
    fn capacity(&self) -> usize {
        usize::try_from(self.cols * self.rows).unwrap_or(usize::MAX)
    }
}

/// The best grid on one monitor for `k` tables: the cell of
/// `work / (cols, rows)` holding the representative table, every class
/// fitted in it and meeting its minimum; the largest smallest table wins,
/// then the fewest cells, then the fewest rows. `None`: no shape meets
/// the minimums.
pub fn grid_on(
    index: usize,
    monitor: &Monitor,
    k: u32,
    classes: &[Class],
    rep: &Class,
) -> Option<MonitorGrid> {
    let scale = monitor.scale_permille;
    let work = &monitor.work_area;
    let mut best: Option<MonitorGrid> = None;
    for cols in 1..=k {
        let rows = k.div_ceil(cols);
        let rep_insets = rep.insets.insets().scaled(1000, scale);
        let (cw, ch) = fit(
            (work.width / cols).saturating_sub(rep_insets.width()),
            (work.height / rows).saturating_sub(rep_insets.height()),
            rep.aspect,
        );
        if cw == 0 || ch == 0 {
            continue;
        }
        let cell_w = cw + rep_insets.width();
        let cell_h = ch + rep_insets.height();
        let mut score = u64::MAX;
        let mut feasible = true;
        for class in classes.iter().chain(std::iter::once(rep)) {
            let insets = class.insets.insets().scaled(1000, scale);
            let (w, h) = fit(
                cell_w.saturating_sub(insets.width()),
                cell_h.saturating_sub(insets.height()),
                class.aspect,
            );
            let (lw, lh) = (logical(w, scale), logical(h, scale));
            if let Some((min_w, min_h)) = class.min_client
                && (lw < u64::from(min_w) || lh < u64::from(min_h))
            {
                feasible = false;
                break;
            }
            score = score.min(lw * lh);
        }
        if !feasible || score == 0 {
            continue;
        }
        let candidate = MonitorGrid {
            monitor: index,
            cols,
            rows,
            cell_w,
            cell_h,
            score,
        };
        let better = match &best {
            None => true,
            Some(b) => {
                (
                    candidate.score,
                    std::cmp::Reverse(cols * rows),
                    std::cmp::Reverse(rows),
                ) > (
                    b.score,
                    std::cmp::Reverse(b.cols * b.rows),
                    std::cmp::Reverse(b.rows),
                )
            }
        };
        if better {
            best = Some(candidate);
        }
    }
    best
}

/// An auto grid: one block of cells per monitor used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grid {
    pub monitors: Vec<MonitorGrid>,
    /// The smallest table's logical area (the size the split maximised).
    pub score: u64,
}

impl Grid {
    /// How many tables it holds.
    pub fn capacity(&self) -> usize {
        self.monitors.iter().map(MonitorGrid::capacity).sum()
    }

    /// Its cells as slots: per monitor (in the grid's order) a block of
    /// `cols x rows` cells edge to edge, centred in the work area, row by
    /// row.
    pub fn slots(&self, monitors: &[Monitor]) -> Vec<ResolvedSlot> {
        let mut out = Vec::new();
        for g in &self.monitors {
            let Some(monitor) = monitors.get(g.monitor) else {
                continue;
            };
            let work = &monitor.work_area;
            let block = centred(work, g.cols * g.cell_w, g.rows * g.cell_h);
            for row in 0..g.rows {
                for col in 0..g.cols {
                    let at = |origin: i32, n: u32, size: u32| {
                        i32::try_from(i64::from(origin) + i64::from(n) * i64::from(size))
                            .unwrap_or(i32::MAX)
                    };
                    out.push(ResolvedSlot {
                        id: format!("auto-{}-{row}-{col}", g.monitor),
                        monitor: g.monitor,
                        cell: Rect {
                            x: at(block.x, col, g.cell_w),
                            y: at(block.y, row, g.cell_h),
                            width: g.cell_w,
                            height: g.cell_h,
                        },
                        kind: SlotKind::Play,
                        rooms: None,
                        stack: true,
                    });
                }
            }
        }
        out
    }
}

/// The auto grid for `n` tables of `classes` (`rep` the most common) over
/// `monitors`: the split over the (at most four) largest monitors - by
/// logical work area - whose smallest table is largest, then whose tables
/// cover the most, then with more tables on the larger monitors; each
/// monitor's count at its best shape ([`grid_on`]). More tables than the
/// minimums let fit: the grid that holds the most. `None`: no table fits
/// anywhere (or no table, no monitor).
pub fn auto_grid(n: usize, monitors: &[Monitor], classes: &[Class], rep: &Class) -> Option<Grid> {
    if n == 0 || monitors.is_empty() {
        return None;
    }
    let mut order: Vec<usize> = (0..monitors.len()).collect();
    order.sort_by_key(|&i| {
        let m = &monitors[i];
        let area = logical(m.work_area.width, m.scale_permille)
            * logical(m.work_area.height, m.scale_permille);
        (std::cmp::Reverse(area), !m.primary, i)
    });
    order.truncate(MAX_GRID_MONITORS);
    let n32 = u32::try_from(n).unwrap_or(u32::MAX);
    // options[j][k]: monitor order[j]'s best grid for k tables.
    let options: Vec<Vec<Option<MonitorGrid>>> = order
        .iter()
        .map(|&i| {
            (0..=n32)
                .map(|k| {
                    if k == 0 {
                        None
                    } else {
                        grid_on(i, &monitors[i], k, classes, rep)
                    }
                })
                .collect()
        })
        .collect();
    let most: Vec<usize> = options
        .iter()
        .map(|o| o.iter().rposition(Option::is_some).unwrap_or(0))
        .collect();
    let target = n.min(most.iter().sum());
    if target == 0 {
        return None;
    }
    let mut best: Option<(Key, Vec<usize>)> = None;
    let mut counts = vec![0usize; order.len()];
    split(0, target, &most, &options, &mut counts, &mut best);
    let (key, counts) = best?;
    let grids = counts
        .iter()
        .enumerate()
        .filter(|(_, c)| **c > 0)
        .filter_map(|(j, c)| options[j][*c])
        .collect();
    Some(Grid {
        monitors: grids,
        score: key.0,
    })
}

/// A split's rank: the smallest table, the area covered, then the counts
/// (more on the earlier, larger monitors).
type Key = (u64, u64, Vec<usize>);

fn split(
    j: usize,
    left: usize,
    most: &[usize],
    options: &[Vec<Option<MonitorGrid>>],
    counts: &mut [usize],
    best: &mut Option<(Key, Vec<usize>)>,
) {
    if j == most.len() {
        if left > 0 {
            return;
        }
        let mut smallest = u64::MAX;
        let mut covered = 0u64;
        for (j, &c) in counts.iter().enumerate() {
            if c == 0 {
                continue;
            }
            let Some(g) = options[j][c] else { return };
            smallest = smallest.min(g.score);
            covered = covered.saturating_add(g.score * u64::try_from(c).unwrap_or(0));
        }
        let key = (smallest, covered, counts.to_vec());
        if best.as_ref().is_none_or(|(b, _)| key > *b) {
            *best = Some((key, counts.to_vec()));
        }
        return;
    }
    for c in 0..=left.min(most[j]) {
        counts[j] = c;
        split(j + 1, left - c, most, options, counts, best);
    }
    counts[j] = 0;
}

// ---------------------------------------------------------------------
// The tiler.

/// A slot resolved to pixels on this machine's monitors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSlot {
    pub id: String,
    /// Index into the monitors.
    pub monitor: usize,
    /// The outer rect a table (or stack) fills, pixels.
    pub cell: Rect,
    pub kind: SlotKind,
    pub rooms: Option<Vec<String>>,
    pub stack: bool,
}

impl ResolvedSlot {
    fn takes(&self, site: &str) -> bool {
        self.kind == SlotKind::Play
            && self
                .rooms
                .as_ref()
                .is_none_or(|rooms| rooms.iter().any(|r| r == site))
    }
}

/// A table window as the engine sees it at a look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub id: WindowId,
    pub site: String,
    pub client: Rect,
    pub scale_permille: u32,
    pub minimized: bool,
    /// Its frame now, at `scale_permille`; `None`: the platform cannot tell
    /// now (a minimised window, a title bar not measured yet) - the last
    /// known is kept (none for a new table).
    pub insets: Option<Insets>,
}

/// A placement for the worker: window `id`'s client area to `want` (its
/// outer rect `outer`); `seq` comes back with the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Move {
    pub id: WindowId,
    pub seq: u64,
    pub want: Rect,
    pub outer: Rect,
}

#[derive(Debug, Clone)]
struct Table {
    site: String,
    client: Rect,
    minimized: bool,
    insets: Insets,
    /// The scale `insets` was measured at.
    insets_scale: u32,
    aspect: Aspect,
    min_client: Option<(u32, u32)>,
    /// When it was first seen (the order tables fill slots in).
    order: u64,
    slot: Option<usize>,
    /// When it took its slot (the most recent stacked table moves first).
    assigned: u64,
    pinned: bool,
    /// The client area last asked for at its slot: what plan compares with.
    goal: Option<Rect>,
    /// A placement asked for and not answered yet (its `seq`).
    in_flight: Option<u64>,
    /// The one retry after a refused size, when one is due.
    retry: Option<Rect>,
    /// The retry for `goal` is spent.
    retried: bool,
    /// Changes before this are the client settling after our placement.
    settle_until: Option<Instant>,
}

impl Table {
    fn class(&self) -> Class {
        Class {
            aspect: self.aspect,
            insets: InsetsKey::of(&self.insets.scaled(self.insets_scale, 1000)),
            min_client: self.min_client,
        }
    }
}

/// What the layout in force is, to tell when it changes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Current {
    Auto(Grid),
    Fixed(String),
}

/// The tiling engine's state.
#[derive(Debug)]
pub struct Tiler {
    options: Options,
    monitors: Vec<Monitor>,
    tables: BTreeMap<WindowId, Table>,
    slots: Vec<ResolvedSlot>,
    current: Option<Current>,
    next_order: u64,
    next_seq: u64,
    cancels: Vec<WindowId>,
}

impl Tiler {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            monitors: Vec::new(),
            tables: BTreeMap::new(),
            slots: Vec::new(),
            current: None,
            next_order: 0,
            next_seq: 0,
            cancels: Vec::new(),
        }
    }

    /// The options in force.
    pub fn options(&self) -> &Options {
        &self.options
    }

    /// New options (T3: the app's layouts): everything laid out again.
    pub fn set_options(&mut self, options: Options) {
        self.options = options;
        for table in self.tables.values_mut() {
            if let Some(room) = self.options.rooms.get(&table.site) {
                if let Some(aspect) = room.aspect {
                    table.aspect = aspect;
                }
                table.min_client = room.min_client;
            }
        }
        self.current = None;
        self.arrange();
    }

    /// The monitors now; a change lays everything out again.
    pub fn set_monitors(&mut self, monitors: Vec<Monitor>) {
        if monitors != self.monitors {
            self.monitors = monitors;
            self.current = None;
            self.arrange();
        }
    }

    pub fn monitors(&self) -> &[Monitor] {
        &self.monitors
    }

    /// The slots in force.
    pub fn slots(&self) -> &[ResolvedSlot] {
        &self.slots
    }

    /// The slot table `id` is in.
    pub fn slot_of(&self, id: WindowId) -> Option<usize> {
        self.tables.get(&id)?.slot
    }

    /// Whether the user moved table `id` by hand (left alone until
    /// [`Tiler::retile`]).
    pub fn pinned(&self, id: WindowId) -> bool {
        self.tables.get(&id).is_some_and(|t| t.pinned)
    }

    /// The tables it knows.
    pub fn tables(&self) -> Vec<WindowId> {
        self.tables.keys().copied().collect()
    }

    /// The auto grid in force, if that is the layout.
    pub fn grid(&self) -> Option<&Grid> {
        match &self.current {
            Some(Current::Auto(grid)) => Some(grid),
            _ => None,
        }
    }

    /// Nothing asked and unanswered, no retry due, every table where it
    /// was last asked to be: what tests wait for.
    pub fn settled(&self) -> bool {
        self.tables.values().all(|t| {
            t.in_flight.is_none()
                && t.retry.is_none()
                && (t.pinned
                    || t.minimized
                    || t.slot.is_none()
                    || self.target(t).is_none_or(|g| t.goal == Some(g)))
        })
    }

    /// Placements still queued that must not happen (the user moved the
    /// table meanwhile), since the last call.
    pub fn take_cancels(&mut self) -> Vec<WindowId> {
        std::mem::take(&mut self.cancels)
    }

    /// Every table window the policy lets tiling manage, as a look saw
    /// them: new ones take slots, missing ones free theirs, the others'
    /// rects are taken in ([`Tiler::moved`]), with the mouse as it is.
    pub fn sync(&mut self, windows: &[Observed], now: Instant, mouse: Mouse) {
        let mut changed = false;
        for window in windows {
            if let Some(table) = self.tables.get_mut(&window.id) {
                if let Some(insets) = window.insets {
                    table.insets = insets;
                    table.insets_scale = window.scale_permille;
                }
                self.observe(window.id, window.client, window.minimized, now, mouse);
                continue;
            }
            let room = self.options.rooms.get(&window.site).copied();
            let aspect = room
                .and_then(|r| r.aspect)
                .or_else(|| Aspect::of(window.client.width, window.client.height))
                .unwrap_or(DEFAULT_ASPECT);
            self.next_order += 1;
            self.tables.insert(
                window.id,
                Table {
                    site: window.site.clone(),
                    client: window.client,
                    minimized: window.minimized,
                    insets: window.insets.unwrap_or_default(),
                    insets_scale: window.scale_permille,
                    aspect,
                    min_client: room.and_then(|r| r.min_client),
                    order: self.next_order,
                    slot: None,
                    assigned: 0,
                    pinned: false,
                    goal: None,
                    in_flight: None,
                    retry: None,
                    retried: false,
                    settle_until: None,
                },
            );
            changed = true;
        }
        let gone: Vec<WindowId> = self
            .tables
            .keys()
            .filter(|id| !windows.iter().any(|w| w.id == **id))
            .copied()
            .collect();
        for id in gone {
            self.forget(id);
            changed = true;
        }
        if changed {
            self.arrange();
        }
    }

    /// Table `id` moved or was resized (the platform's event, between
    /// looks).
    pub fn moved(&mut self, id: WindowId, client: Rect, now: Instant, mouse: Mouse) {
        let minimized = self.tables.get(&id).is_some_and(|t| t.minimized);
        self.observe(id, client, minimized, now, mouse);
    }

    /// Table `id` was minimised or restored.
    pub fn minimized(&mut self, id: WindowId, minimized: bool) {
        if let Some(table) = self.tables.get_mut(&id) {
            table.minimized = minimized;
        }
    }

    /// Table `id` is gone (closed).
    pub fn gone(&mut self, id: WindowId) {
        if self.tables.contains_key(&id) {
            self.forget(id);
            self.arrange();
        }
    }

    fn observe(&mut self, id: WindowId, client: Rect, minimized: bool, now: Instant, mouse: Mouse) {
        let target = self.tables.get(&id).and_then(|t| t.goal);
        let Some(table) = self.tables.get_mut(&id) else {
            return;
        };
        table.minimized = minimized;
        if minimized || client.width == 0 || client.height == 0 || close(&client, &table.client) {
            if !minimized && client.width > 0 {
                table.client = client;
            }
            return;
        }
        table.client = client;
        if table.pinned || mouse == Mouse::Idle {
            return;
        }
        let user = if table.in_flight.is_some() {
            // Queued or under way: a change that is not our placement
            // landing, with the mouse in use, is the user dragging it.
            target.is_none_or(|t| !close(&client, &t))
        } else {
            table.goal.is_some()
                && (mouse == Mouse::Down || table.settle_until.is_none_or(|until| now >= until))
        };
        if user {
            self.pin(id);
        }
    }

    /// The user moved table `id`: it keeps its place and leaves its slot.
    fn pin(&mut self, id: WindowId) {
        let Some(table) = self.tables.get_mut(&id) else {
            return;
        };
        if table.in_flight.take().is_some() {
            self.cancels.push(id);
        }
        table.pinned = true;
        table.retry = None;
        let freed = table.slot.take();
        if let Some(slot) = freed {
            self.refill(slot);
        }
        self.arrange();
    }

    /// Lay every table out again: pins dropped, every table placed at its
    /// slot (a hotkey or the tray's "Re-tile", T3).
    pub fn retile(&mut self) {
        for table in self.tables.values_mut() {
            table.pinned = false;
            table.goal = None;
            table.retry = None;
            table.retried = false;
        }
        self.current = None;
        self.arrange();
    }

    fn forget(&mut self, id: WindowId) {
        if let Some(table) = self.tables.remove(&id)
            && let Some(slot) = table.slot
        {
            self.refill(slot);
        }
    }

    /// Tables in `slot`.
    fn count(&self, slot: usize) -> usize {
        self.tables
            .values()
            .filter(|t| t.slot == Some(slot))
            .count()
    }

    /// `slot` was emptied: the most recently stacked table it takes moves
    /// in; else, with `close_gaps`, the last table alone in a later slot.
    fn refill(&mut self, slot: usize) {
        let Some(target) = self.slots.get(slot).cloned() else {
            return;
        };
        if self.count(slot) > 0 {
            return;
        }
        let stacked = self
            .tables
            .iter()
            .filter(|(_, t)| !t.pinned && target.takes(&t.site))
            .filter(|(_, t)| t.slot.is_some_and(|s| self.count(s) > 1))
            .max_by_key(|(_, t)| t.assigned)
            .map(|(id, _)| *id);
        let mover = stacked.or_else(|| {
            if !self.options.close_gaps {
                return None;
            }
            self.tables
                .iter()
                .filter(|(_, t)| !t.pinned && target.takes(&t.site))
                .filter(|(_, t)| t.slot.is_some_and(|s| s > slot))
                .max_by_key(|(_, t)| (t.slot, t.assigned))
                .map(|(id, _)| *id)
        });
        if let Some(id) = mover {
            let emptied = self.tables.get(&id).and_then(|t| t.slot);
            self.next_order += 1;
            let stamp = self.next_order;
            if let Some(table) = self.tables.get_mut(&id) {
                table.slot = Some(slot);
                table.assigned = stamp;
            }
            // A table moved up from the end leaves a hole of its own.
            if stacked.is_none()
                && let Some(emptied) = emptied
            {
                self.refill(emptied);
            }
        }
    }

    /// The layout the table count picks: the active one, or the
    /// auto-switch rule with the largest `min_tables` reached.
    fn effective(&self, n: usize) -> Option<&Layout> {
        let n = u32::try_from(n).unwrap_or(u32::MAX);
        let id = self.options.active.as_str();
        let base = self.options.layouts.iter().find(|l| l.id == id);
        let switched = base.and_then(|layout| {
            layout
                .auto_switch
                .iter()
                .filter(|rule| rule.min_tables <= n)
                .max_by_key(|rule| rule.min_tables)
        });
        match switched {
            Some(rule) if rule.layout_id == AUTO_LAYOUT => None,
            Some(rule) => self
                .options
                .layouts
                .iter()
                .find(|l| l.id == rule.layout_id)
                .or(base),
            None => base,
        }
    }

    fn classes(&self, managed: &[WindowId]) -> (Vec<Class>, Option<Class>) {
        let mut counts: BTreeMap<Class, (usize, std::cmp::Reverse<u64>)> = BTreeMap::new();
        for id in managed {
            if let Some(t) = self.tables.get(id) {
                let entry = counts
                    .entry(t.class())
                    .or_insert((0, std::cmp::Reverse(t.order)));
                entry.0 += 1;
                entry.1 = entry.1.max(std::cmp::Reverse(t.order));
            }
        }
        let rep = counts
            .iter()
            .max_by_key(|(_, rank)| **rank)
            .map(|(c, _)| *c);
        (counts.into_keys().collect(), rep)
    }

    /// Slots for the layout the tables call for, and every table that has
    /// none given one. The slots change only when the layout does (another
    /// layout, other monitors, or an auto grid of another shape); then
    /// every table is assigned again in its old order.
    fn arrange(&mut self) {
        let mut managed: Vec<WindowId> = self
            .tables
            .iter()
            .filter(|(_, t)| !t.pinned)
            .map(|(id, _)| *id)
            .collect();
        managed.sort_by_key(|id| self.tables.get(id).map_or(0, |t| t.order));
        // A table the user pinned still counts for the layout (its slot
        // stays free for the next table): pulling one out of the grid
        // moves no other.
        let all: Vec<WindowId> = self.tables.keys().copied().collect();
        let next = match self.effective(all.len()).cloned() {
            Some(layout) => {
                let key = Current::Fixed(layout.id.clone());
                (self.current.as_ref() != Some(&key)).then(|| (key, self.resolve(&layout)))
            }
            None => self.next_grid(&all),
        };
        if let Some((current, slots)) = next {
            self.current = Some(current);
            self.slots = slots;
            let mut order: Vec<(usize, u64, WindowId)> = managed
                .iter()
                .filter_map(|id| {
                    let t = self.tables.get(id)?;
                    Some((t.slot.unwrap_or(usize::MAX), t.order, *id))
                })
                .collect();
            order.sort();
            for table in self.tables.values_mut() {
                table.slot = None;
            }
            for (_, _, id) in order {
                self.assign(id);
            }
        } else {
            for id in managed {
                if self.tables.get(&id).is_some_and(|t| t.slot.is_none()) {
                    self.assign(id);
                }
            }
        }
    }

    /// The auto grid to switch to, if the current one will not do: none
    /// yet, another layout before, or it holds fewer tables than the best
    /// grid or smaller ones (the best grid's smallest table is larger).
    fn next_grid(&self, tables: &[WindowId]) -> Option<(Current, Vec<ResolvedSlot>)> {
        let (classes, rep) = self.classes(tables);
        let best = rep.and_then(|rep| auto_grid(tables.len(), &self.monitors, &classes, &rep));
        let keep = match (&self.current, &best, rep) {
            (Some(Current::Auto(now)), Some(best), Some(rep)) => {
                let still = self.rescore(now, &classes, &rep);
                now.capacity() >= best.capacity().min(tables.len())
                    && still.is_some_and(|score| score >= best.score)
            }
            (Some(Current::Auto(_)), None, _) => tables.is_empty(),
            _ => false,
        };
        if keep {
            return None;
        }
        Some(match best {
            Some(grid) => {
                let slots = grid.slots(&self.monitors);
                (Current::Auto(grid), slots)
            }
            None => (
                Current::Auto(Grid {
                    monitors: Vec::new(),
                    score: 0,
                }),
                Vec::new(),
            ),
        })
    }

    /// The current grid's smallest table with today's classes (a new room
    /// may not fit its cells): `None` when a minimum is not met.
    fn rescore(&self, grid: &Grid, classes: &[Class], rep: &Class) -> Option<u64> {
        let mut smallest = u64::MAX;
        for g in &grid.monitors {
            let monitor = self.monitors.get(g.monitor)?;
            let scale = monitor.scale_permille;
            for class in classes.iter().chain(std::iter::once(rep)) {
                let insets = class.insets.insets().scaled(1000, scale);
                let (w, h) = fit(
                    g.cell_w.saturating_sub(insets.width()),
                    g.cell_h.saturating_sub(insets.height()),
                    class.aspect,
                );
                let (lw, lh) = (logical(w, scale), logical(h, scale));
                if let Some((min_w, min_h)) = class.min_client
                    && (lw < u64::from(min_w) || lh < u64::from(min_h))
                {
                    return None;
                }
                smallest = smallest.min(lw * lh);
            }
        }
        Some(smallest)
    }

    /// A stored layout's slots on this machine's monitors (a missing
    /// monitor: the primary).
    fn resolve(&self, layout: &Layout) -> Vec<ResolvedSlot> {
        let order = monitor_order(&self.monitors);
        layout
            .slots
            .iter()
            .filter_map(|slot| {
                let index = usize::try_from(slot.monitor)
                    .ok()
                    .and_then(|m| order.get(m))
                    .or_else(|| order.first())
                    .copied()?;
                let monitor = self.monitors.get(index)?;
                Some(ResolvedSlot {
                    id: slot.id.clone(),
                    monitor: index,
                    cell: slot_rect(&monitor.work_area, &slot.rect),
                    kind: slot.kind,
                    rooms: slot.rooms.clone(),
                    stack: slot.stack,
                })
            })
            .collect()
    }

    /// Table `id` into the first free slot that takes its room, else onto
    /// the stackable one with the fewest tables (the first on a tie); else
    /// it stays where it is, unmanaged.
    fn assign(&mut self, id: WindowId) {
        let Some(site) = self.tables.get(&id).map(|t| t.site.clone()) else {
            return;
        };
        let counts: Vec<usize> = (0..self.slots.len()).map(|s| self.count(s)).collect();
        let free = self
            .slots
            .iter()
            .enumerate()
            .find(|(s, slot)| counts[*s] == 0 && slot.takes(&site))
            .map(|(s, _)| s);
        let slot = free.or_else(|| {
            self.slots
                .iter()
                .enumerate()
                .filter(|(_, slot)| slot.stack && slot.takes(&site))
                .min_by_key(|(s, _)| (counts[*s], *s))
                .map(|(s, _)| s)
        });
        self.next_order += 1;
        let stamp = self.next_order;
        if let Some(table) = self.tables.get_mut(&id) {
            table.slot = slot;
            table.assigned = stamp;
        }
    }

    /// Where table `id` belongs: its room's largest client area in its
    /// slot, the frame at the slot's monitor's scale, centred.
    fn target(&self, table: &Table) -> Option<Rect> {
        let slot = self.slots.get(table.slot?)?;
        let insets = self.insets_on(table, slot.monitor);
        let outer = fit_in(&slot.cell, &insets, table.aspect);
        Some(insets.client(&outer))
    }

    fn insets_on(&self, table: &Table, monitor: usize) -> Insets {
        let scale = self
            .monitors
            .get(monitor)
            .map_or(table.insets_scale, |m| m.scale_permille);
        table.insets.scaled(table.insets_scale, scale)
    }

    /// The placements due: every managed, visible table not where it was
    /// last asked to be at its slot (a new table, a new slot, a new grid),
    /// and the one retry of a refused size. A table already asked and not
    /// answered is asked again only for a new place (the worker keeps the
    /// latest); never twice for the same.
    pub fn plan(&mut self) -> Vec<Move> {
        let mut moves = Vec::new();
        let ids: Vec<WindowId> = self.tables.keys().copied().collect();
        for id in ids {
            let Some(table) = self.tables.get(&id) else {
                continue;
            };
            if table.pinned || table.minimized {
                continue;
            }
            let Some(target) = self.target(table) else {
                continue;
            };
            let outer_insets = table
                .slot
                .and_then(|s| self.slots.get(s))
                .map(|s| self.insets_on(table, s.monitor))
                .unwrap_or_default();
            let want = if table.goal == Some(target) {
                if table.in_flight.is_some() {
                    continue;
                }
                match table.retry {
                    Some(retry) => retry,
                    None => continue,
                }
            } else {
                target
            };
            self.next_seq += 1;
            let seq = self.next_seq;
            if let Some(table) = self.tables.get_mut(&id) {
                if table.goal != Some(target) {
                    table.goal = Some(target);
                    table.retried = false;
                }
                table.retry = None;
                table.in_flight = Some(seq);
            }
            moves.push(Move {
                id,
                seq,
                want,
                outer: outer_insets.outer(&want),
            });
        }
        moves
    }

    /// The answer to placement `seq` of table `id`: the client area it has
    /// now, or why it was not moved. A refused size is kept and centred in
    /// the slot once more (one retry per placement). An answer to a
    /// placement since replaced is only the table's rect.
    pub fn placed(
        &mut self,
        id: WindowId,
        seq: u64,
        result: &Result<Rect, PlatformError>,
        now: Instant,
    ) {
        let cell = self
            .tables
            .get(&id)
            .and_then(|t| t.slot)
            .and_then(|s| self.slots.get(s))
            .map(|s| (s.cell, s.monitor));
        let insets = cell
            .and_then(|(_, monitor)| self.tables.get(&id).map(|t| self.insets_on(t, monitor)))
            .unwrap_or_default();
        let Some(table) = self.tables.get_mut(&id) else {
            return;
        };
        if let Ok(accepted) = result
            && accepted.width > 0
        {
            table.client = *accepted;
        }
        if table.in_flight != Some(seq) {
            return;
        }
        table.in_flight = None;
        table.settle_until = Some(now + SETTLE_GRACE);
        let (Ok(accepted), Some(goal), Some((cell, _))) = (result, table.goal, cell) else {
            return;
        };
        let refused =
            accepted.width.abs_diff(goal.width) > 1 || accepted.height.abs_diff(goal.height) > 1;
        if !refused || table.retried {
            return;
        }
        table.retried = true;
        let outer = centred(
            &cell,
            accepted.width.saturating_add(insets.width()),
            accepted.height.saturating_add(insets.height()),
        );
        let again = insets.client(&outer);
        if !close(&again, accepted) {
            table.retry = Some(again);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::MonitorId;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn monitor(id: u64, primary: bool, bounds: Rect, work: Rect, scale: u32) -> Monitor {
        Monitor {
            id: MonitorId(id),
            primary,
            bounds,
            work_area: work,
            scale_permille: scale,
        }
    }

    /// A 1920 x 1080 primary (a 40 px taskbar) and a 2560 x 1440 one at
    /// 125 % to its right.
    fn two_monitors() -> Vec<Monitor> {
        vec![
            monitor(
                1,
                true,
                rect(0, 0, 1920, 1080),
                rect(0, 0, 1920, 1040),
                1000,
            ),
            monitor(
                2,
                false,
                rect(1920, 0, 2560, 1440),
                rect(1920, 0, 2560, 1400),
                1250,
            ),
        ]
    }

    const FRAME: Insets = Insets {
        left: 0,
        top: 30,
        right: 0,
        bottom: 0,
    };

    fn window(id: u64, site: &str, frame: Insets) -> Observed {
        Observed {
            id: WindowId(id),
            site: site.to_owned(),
            client: rect(0, 0, 640, 480),
            scale_permille: 1000,
            minimized: false,
            insets: Some(frame),
        }
    }

    /// The world the tiler moves: each table's client area and frame at
    /// 100 %; a placement takes what `accept` gives.
    struct World {
        tiler: Tiler,
        windows: BTreeMap<WindowId, Observed>,
        accept: fn(Rect) -> Rect,
    }

    impl World {
        fn new(options: Options, monitors: Vec<Monitor>) -> Self {
            let mut tiler = Tiler::new(options);
            tiler.set_monitors(monitors);
            Self {
                tiler,
                windows: BTreeMap::new(),
                accept: |r| r,
            }
        }

        fn scale_at(&self, client: &Rect) -> u32 {
            crate::platform::sim::scale_at(self.tiler.monitors(), client)
        }

        fn open(&mut self, id: u64, site: &str, frame: Insets) {
            self.windows.insert(WindowId(id), window(id, site, frame));
        }

        fn close(&mut self, id: u64) {
            self.windows.remove(&WindowId(id));
        }

        fn look(&mut self, now: Instant) {
            let seen: Vec<Observed> = self
                .windows
                .values()
                .map(|w| {
                    let scale = self.scale_at(&w.client);
                    Observed {
                        scale_permille: scale,
                        insets: w.insets.map(|i| i.scaled(1000, scale)),
                        ..w.clone()
                    }
                })
                .collect();
            self.tiler.sync(&seen, now, Mouse::Idle);
        }

        /// Looks and places until nothing is due; the moves made.
        fn settle(&mut self, now: Instant) -> Vec<Move> {
            let mut made = Vec::new();
            for _ in 0..5 {
                self.look(now);
                let moves = self.tiler.plan();
                if moves.is_empty() {
                    break;
                }
                for m in moves {
                    let accepted = (self.accept)(m.want);
                    if let Some(w) = self.windows.get_mut(&m.id) {
                        w.client = accepted;
                    }
                    self.tiler.placed(m.id, m.seq, &Ok(accepted), now);
                    made.push(m);
                }
            }
            assert!(self.tiler.settled(), "settled");
            made
        }

        fn outer(&self, id: u64) -> Rect {
            let w = &self.windows[&WindowId(id)];
            let scale = self.scale_at(&w.client);
            w.insets
                .unwrap_or_default()
                .scaled(1000, scale)
                .outer(&w.client)
        }
    }

    fn no_overlap(rects: &[Rect]) {
        for (i, a) in rects.iter().enumerate() {
            for b in &rects[i + 1..] {
                assert_eq!(a.overlap(b), 0, "{a:?} overlaps {b:?}");
            }
        }
    }

    /// The fit: the largest size of the aspect ratio, idempotent, never
    /// larger than the space.
    #[test]
    fn fitting_keeps_the_aspect_ratio() {
        let four_three = Aspect::of(640, 480).expect("aspect");
        assert_eq!(
            four_three,
            Aspect {
                width: 4,
                height: 3
            }
        );
        assert_eq!(fit(1000, 1000, four_three), (1000, 750));
        assert_eq!(
            fit(1000, 600, four_three),
            (801, 600),
            "the largest whose height fits"
        );
        for (w, h) in [
            (853, 639),
            (1001, 333),
            (5, 3),
            (1, 1),
            (0, 9),
            (1919, 1009),
        ] {
            let (fw, fh) = fit(w, h, four_three);
            assert!(fw <= w && fh <= h, "{w}x{h} -> {fw}x{fh}");
            assert!(four_three.holds(fw, fh), "{fw}x{fh}");
            assert_eq!(fit(fw, fh, four_three), (fw, fh), "idempotent");
        }
        let odd = Aspect::of(1094, 798).expect("aspect");
        let (w, h) = fit(700, 700, odd);
        assert!(odd.holds(w, h) && w == 700 && h < 700);
        // Centred, frame included.
        let cell = rect(100, 100, 900, 700);
        let outer = fit_in(&cell, &FRAME, four_three);
        assert_eq!(outer, rect(103, 100, 894, 700));
        assert_eq!(FRAME.client(&outer), rect(103, 130, 894, 670));
        assert_eq!(centred(&cell, 1000, 700), rect(50, 100, 1000, 700));
    }

    /// Slots name monitors by order (primary, then left to right) and fall
    /// back to the primary; thousandths become pixels of the work area.
    #[test]
    fn slots_resolve_on_the_monitors() {
        let mut monitors = two_monitors();
        monitors.reverse();
        monitors.push(monitor(
            3,
            false,
            rect(-1280, 0, 1280, 1024),
            rect(-1280, 0, 1280, 1024),
            1000,
        ));
        assert_eq!(monitor_order(&monitors), [1, 2, 0]);
        let work = rect(1920, 0, 2560, 1400);
        assert_eq!(
            slot_rect(
                &work,
                &SlotRect {
                    x: 500,
                    y: 0,
                    width: 500,
                    height: 1000
                }
            ),
            rect(3200, 0, 1280, 1400)
        );
        let layout = Layout {
            id: "two".into(),
            name: "Two".into(),
            slots: vec![
                Slot {
                    id: "a".into(),
                    monitor: 2,
                    rect: SlotRect {
                        x: 0,
                        y: 0,
                        width: 1000,
                        height: 1000,
                    },
                    kind: SlotKind::Play,
                    rooms: None,
                    stack: false,
                },
                Slot {
                    id: "gone".into(),
                    monitor: 7,
                    rect: SlotRect {
                        x: 0,
                        y: 0,
                        width: 500,
                        height: 500,
                    },
                    kind: SlotKind::Play,
                    rooms: None,
                    stack: false,
                },
            ],
            auto_switch: Vec::new(),
        };
        let mut tiler = Tiler::new(Options {
            layouts: vec![layout],
            active: "two".into(),
            ..Options::default()
        });
        tiler.set_monitors(monitors);
        tiler.sync(
            &[window(1, "pokerstars", FRAME)],
            Instant::now(),
            Mouse::Idle,
        );
        let slots = tiler.slots();
        assert_eq!(slots[0].monitor, 0, "the third in order: the 2560 one");
        assert_eq!(slots[0].cell, work);
        assert_eq!(slots[1].monitor, 1, "missing: the primary");
        assert_eq!(slots[1].cell, rect(0, 0, 960, 520));
    }

    /// Layouts round-trip through JSON in camelCase, defaults filled.
    #[test]
    fn layouts_are_stored_as_camel_case_json() {
        let json = r#"{"id":"l","name":"Mine","slots":[{"id":"s","rect":{"x":0,"y":0,"width":500,"height":1000},"kind":"lobby","rooms":["winamax"],"stack":true}],"autoSwitch":[{"minTables":3,"layoutId":"auto"}]}"#;
        let layout: Layout = serde_json::from_str(json).expect("parse");
        assert_eq!(layout.slots[0].monitor, 0);
        assert_eq!(layout.slots[0].kind, SlotKind::Lobby);
        assert_eq!(layout.auto_switch[0].min_tables, 3);
        let back = serde_json::to_string(&layout).expect("write");
        assert!(back.contains("\"autoSwitch\"") && back.contains("\"layoutId\""));
        let again: Layout = serde_json::from_str(&back).expect("again");
        assert_eq!(again, layout);
        let bare: Layout =
            serde_json::from_str(r#"{"id":"b","name":"B","slots":[{"id":"s","rect":{"x":0,"y":0,"width":1,"height":1}}]}"#)
                .expect("defaults");
        assert_eq!(bare.slots[0].kind, SlotKind::Play);
        assert!(bare.auto_switch.is_empty() && !bare.slots[0].stack);
    }

    /// The auto grid: one table per monitor before two on one; the largest
    /// monitor first; edge to edge, centred, inside the work areas; a
    /// minimum size caps the cells and the rest stack.
    #[test]
    fn the_auto_grid_spreads_and_packs() {
        let monitors = two_monitors();
        let class = Class {
            aspect: DEFAULT_ASPECT,
            insets: InsetsKey::of(&FRAME),
            min_client: None,
        };
        let one = auto_grid(1, &monitors, &[class], &class).expect("grid");
        assert_eq!(one.monitors.len(), 1);
        assert_eq!(one.monitors[0].monitor, 1, "the larger monitor");
        let two = auto_grid(2, &monitors, &[class], &class).expect("grid");
        assert_eq!(
            two.monitors.iter().map(|g| g.monitor).collect::<Vec<_>>(),
            [1, 0],
            "spread: one table on each"
        );
        for n in 1..=16 {
            let grid = auto_grid(n, &monitors, &[class], &class).expect("grid");
            assert!(grid.capacity() >= n);
            let slots = grid.slots(&monitors);
            let cells: Vec<Rect> = slots.iter().map(|s| s.cell).collect();
            no_overlap(&cells);
            for slot in &slots {
                assert!(monitors[slot.monitor].work_area.contains(&slot.cell), "{n}");
            }
        }
        // A 600 x 450 minimum: three by two on each monitor, twelve at most.
        let small = Class {
            min_client: Some((600, 450)),
            ..class
        };
        let full = auto_grid(30, &monitors, &[small], &small).expect("grid");
        assert_eq!(full.capacity(), 12);
        assert!(full.monitors.iter().all(|g| (g.cols, g.rows) == (3, 2)));
        let huge = Class {
            min_client: Some((5000, 5000)),
            ..class
        };
        assert_eq!(auto_grid(1, &monitors, &[huge], &huge), None);
        assert_eq!(auto_grid(0, &monitors, &[class], &class), None);
        assert_eq!(auto_grid(3, &[], &[class], &class), None);
    }

    /// Six tables: tiled edge to edge on outer rects, the aspect kept,
    /// nothing overlapping; a table opening into a free cell moves no
    /// other; closing one moves nothing while the grid holds.
    #[test]
    fn tables_tile_and_stay_put() {
        let room = RoomGeometry {
            aspect: Some(DEFAULT_ASPECT),
            min_client: Some((600, 450)),
        };
        let mut world = World::new(
            Options {
                rooms: [("pokerstars".to_owned(), room)].into_iter().collect(),
                ..Options::default()
            },
            two_monitors(),
        );
        let now = Instant::now();
        for id in 1..=11 {
            world.open(id, "pokerstars", FRAME);
        }
        world.settle(now);
        let grid = world.tiler.grid().expect("auto").clone();
        assert_eq!(grid.capacity(), 12);
        let outers: Vec<Rect> = (1..=11).map(|id| world.outer(id)).collect();
        no_overlap(&outers);
        for id in 1..=11 {
            let c = world.windows[&WindowId(id)].client;
            assert!(DEFAULT_ASPECT.holds(c.width, c.height), "{c:?}");
            let slot = world.tiler.slot_of(WindowId(id)).expect("slot");
            assert_eq!(
                world.outer(id),
                world.tiler.slots()[slot].cell,
                "fills its cell"
            );
        }
        // The twelfth: into the free cell, nobody else moves.
        world.open(12, "pokerstars", FRAME);
        let moved = world.settle(now);
        assert_eq!(
            moved.iter().map(|m| m.id).collect::<Vec<_>>(),
            [WindowId(12)]
        );
        // The thirteenth stacks on a cell; nobody else moves.
        world.open(13, "pokerstars", FRAME);
        let moved = world.settle(now);
        assert_eq!(
            moved.iter().map(|m| m.id).collect::<Vec<_>>(),
            [WindowId(13)]
        );
        let stacked = world.tiler.slot_of(WindowId(13)).expect("stacked");
        assert_eq!(world.tiler.count(stacked), 2);
        // One closes: the stacked table takes its cell, nothing else moves.
        let freed = world.tiler.slot_of(WindowId(4)).expect("slot");
        world.close(4);
        let moved = world.settle(now);
        assert_eq!(
            moved.iter().map(|m| m.id).collect::<Vec<_>>(),
            [WindowId(13)]
        );
        assert_eq!(world.tiler.slot_of(WindowId(13)), Some(freed));
        // Another closes: a hole, nothing moves (the grid still holds).
        world.close(7);
        assert!(world.settle(now).is_empty());
        assert_eq!(world.tiler.grid(), Some(&grid));
    }

    /// Fewer tables, larger ones: when the count drops so far that a grid
    /// of larger tables exists, the grid changes and the tables move.
    #[test]
    fn the_grid_grows_when_tables_close() {
        let mut world = World::new(Options::default(), two_monitors());
        let now = Instant::now();
        for id in 1..=8 {
            world.open(id, "pokerstars", FRAME);
        }
        world.settle(now);
        let before = world.tiler.grid().expect("grid").score;
        for id in 3..=8 {
            world.close(id);
        }
        let moved = world.settle(now);
        assert!(!moved.is_empty());
        assert!(world.tiler.grid().expect("grid").score > before);
        no_overlap(&[world.outer(1), world.outer(2)]);
    }

    /// Mixed rooms: two aspect ratios and two frames; every table inside
    /// its cell with its own aspect, none overlapping.
    #[test]
    fn mixed_rooms_keep_their_aspects() {
        let wide = Aspect {
            width: 16,
            height: 10,
        };
        let mut world = World::new(
            Options {
                rooms: [(
                    "winamax".to_owned(),
                    RoomGeometry {
                        aspect: Some(wide),
                        min_client: None,
                    },
                )]
                .into_iter()
                .collect(),
                ..Options::default()
            },
            two_monitors(),
        );
        let mac = Insets {
            left: 0,
            top: 28,
            right: 0,
            bottom: 0,
        };
        let win = Insets {
            left: 1,
            top: 31,
            right: 1,
            bottom: 1,
        };
        for id in 1..=5 {
            world.open(id, "pokerstars", mac);
        }
        for id in 6..=9 {
            world.open(id, "winamax", win);
        }
        world.settle(Instant::now());
        let outers: Vec<Rect> = (1..=9).map(|id| world.outer(id)).collect();
        no_overlap(&outers);
        for id in 1..=9 {
            let c = world.windows[&WindowId(id)].client;
            let aspect = if id <= 5 { DEFAULT_ASPECT } else { wide };
            assert!(aspect.holds(c.width, c.height), "{id}: {c:?}");
            let slot = world.tiler.slot_of(WindowId(id)).expect("slot");
            assert!(world.tiler.slots()[slot].cell.contains(&world.outer(id)));
        }
    }

    /// A client that refuses the size: its own size is kept and centred in
    /// the slot - one retry, never more.
    #[test]
    fn a_refused_size_is_centred_once() {
        let mut world = World::new(Options::default(), two_monitors());
        // Only widths in steps of 100.
        world.accept = |want| {
            let width = want.width / 100 * 100;
            Rect {
                width,
                height: width * 3 / 4,
                ..want
            }
        };
        world.open(1, "winamax", FRAME);
        world.open(2, "winamax", FRAME);
        let moves = world.settle(Instant::now());
        assert_eq!(moves.len(), 4, "a placement and one retry each");
        for id in 1..=2 {
            let slot = world.tiler.slot_of(WindowId(id)).expect("slot");
            let cell = world.tiler.slots()[slot].cell;
            let outer = world.outer(id);
            assert_eq!(outer.width % 100, 0);
            assert_eq!(outer, centred(&cell, outer.width, outer.height), "centred");
        }
        // A client that answers differently each time is not chased.
        world.accept = |want| Rect {
            x: want.x + 20,
            width: want.width - 13,
            ..want
        };
        world.tiler.retile();
        let moves = world.settle(Instant::now());
        assert_eq!(moves.len(), 4, "still one retry each");
    }

    /// A table the user drags is pinned: left alone, out of its slot,
    /// which the next table takes; a placement queued for it is cancelled;
    /// `retile` takes it back.
    #[test]
    fn a_dragged_table_is_pinned() {
        // Twelve cells at most (the minimum size): the grid cannot grow.
        let room = RoomGeometry {
            aspect: Some(DEFAULT_ASPECT),
            min_client: Some((600, 450)),
        };
        let mut world = World::new(
            Options {
                rooms: [("pokerstars".to_owned(), room)].into_iter().collect(),
                ..Options::default()
            },
            two_monitors(),
        );
        let start = Instant::now();
        for id in 1..=12 {
            world.open(id, "pokerstars", FRAME);
        }
        world.settle(start);
        let later = start + SETTLE_GRACE + Duration::from_millis(1);
        // A change without the mouse: the client's own; not pinned.
        let dragged = rect(50, 60, 640, 480);
        world.tiler.moved(WindowId(2), dragged, later, Mouse::Idle);
        assert!(!world.tiler.pinned(WindowId(2)));
        // With the mouse: the user's.
        let slot = world.tiler.slot_of(WindowId(2));
        world
            .tiler
            .moved(WindowId(2), rect(70, 60, 640, 480), later, Mouse::Recent);
        assert!(world.tiler.pinned(WindowId(2)));
        assert_eq!(world.tiler.slot_of(WindowId(2)), None);
        world.windows.get_mut(&WindowId(2)).expect("2").client = rect(70, 60, 640, 480);
        // The next table takes its slot (it still counts for the grid,
        // so nothing else moves) rather than stacking.
        world.open(13, "pokerstars", FRAME);
        let moved = world.settle(later);
        assert_eq!(
            moved.iter().map(|m| m.id).collect::<Vec<_>>(),
            [WindowId(13)]
        );
        assert_eq!(world.tiler.slot_of(WindowId(13)), slot, "its slot reused");
        // Within the settle grace after our own placement: the client.s.
        world
            .tiler
            .moved(WindowId(13), rect(1, 1, 640, 480), later, Mouse::Recent);
        assert!(!world.tiler.pinned(WindowId(13)), "settling");
        // ... unless a button is down now: the user's, grace or not.
        world
            .tiler
            .moved(WindowId(13), rect(5, 1, 640, 480), later, Mouse::Down);
        assert!(world.tiler.pinned(WindowId(13)), "dragged");
        world.windows.get_mut(&WindowId(13)).expect("13").client = rect(5, 1, 640, 480);
        // A queued placement for a table the user then drags: cancelled.
        world.open(14, "pokerstars", FRAME);
        world.look(later);
        let moves = world.tiler.plan();
        assert_eq!(
            moves.iter().map(|m| m.id).collect::<Vec<_>>(),
            [WindowId(14)]
        );
        world
            .tiler
            .moved(WindowId(14), rect(900, 900, 640, 480), later, Mouse::Recent);
        assert!(world.tiler.pinned(WindowId(14)));
        assert_eq!(world.tiler.take_cancels(), [WindowId(14)]);
        // Re-tile: both back in the layout.
        world.tiler.retile();
        let moved = world.settle(later);
        assert!(moved.iter().any(|m| m.id == WindowId(2)));
        assert!(!world.tiler.pinned(WindowId(2)));
        assert!(world.tiler.slot_of(WindowId(14)).is_some());
    }

    /// Fixed layouts: room filters, stacking only where allowed, close
    /// gaps, auto-switch by table count.
    #[test]
    fn fixed_layouts_and_auto_switch() {
        let half = |id: &str, x: u32, rooms: Option<Vec<String>>, stack: bool| Slot {
            id: id.into(),
            monitor: 0,
            rect: SlotRect {
                x,
                y: 0,
                width: 500,
                height: 1000,
            },
            kind: SlotKind::Play,
            rooms,
            stack,
        };
        let quarter = |id: &str, x: u32, y: u32| Slot {
            id: id.into(),
            monitor: 0,
            rect: SlotRect {
                x,
                y,
                width: 500,
                height: 500,
            },
            kind: SlotKind::Play,
            rooms: None,
            stack: false,
        };
        let halves = Layout {
            id: "halves".into(),
            name: "Halves".into(),
            slots: vec![
                half("left", 0, Some(vec!["winamax".into()]), false),
                half("right", 500, None, true),
            ],
            auto_switch: vec![AutoSwitch {
                min_tables: 3,
                layout_id: "quarters".into(),
            }],
        };
        let quarters = Layout {
            id: "quarters".into(),
            name: "Quarters".into(),
            slots: vec![
                quarter("a", 0, 0),
                quarter("b", 500, 0),
                quarter("c", 0, 500),
                quarter("d", 500, 500),
            ],
            auto_switch: Vec::new(),
        };
        let mut world = World::new(
            Options {
                layouts: vec![halves, quarters],
                active: "halves".into(),
                rooms: BTreeMap::new(),
                close_gaps: true,
            },
            two_monitors(),
        );
        let now = Instant::now();
        world.open(1, "pokerstars", Insets::default());
        world.settle(now);
        assert_eq!(
            world.tiler.slot_of(WindowId(1)),
            Some(1),
            "left is Winamax's"
        );
        world.open(2, "pokerstars", Insets::default());
        world.settle(now);
        assert_eq!(world.tiler.slot_of(WindowId(2)), Some(1), "stacked right");
        // The third table: four quarters, everyone placed again.
        world.open(3, "winamax", Insets::default());
        world.settle(now);
        assert_eq!(world.tiler.slots().len(), 4);
        let slots: Vec<_> = (1..=3)
            .map(|id| world.tiler.slot_of(WindowId(id)))
            .collect();
        assert_eq!(slots, [Some(0), Some(1), Some(2)]);
        world.open(4, "pokerstars", Insets::default());
        world.settle(now);
        // Close gaps: the first closes, the last moves into its hole.
        world.close(1);
        let moved = world.settle(now);
        assert_eq!(world.tiler.slot_of(WindowId(4)), Some(0));
        assert_eq!(
            moved.iter().map(|m| m.id).collect::<Vec<_>>(),
            [WindowId(4)]
        );
        // Two tables: back to halves.
        world.close(2);
        world.settle(now);
        assert_eq!(world.tiler.slots().len(), 2);
        assert_eq!(world.tiler.slot_of(WindowId(3)), Some(0), "Winamax left");
        // Lobby slots take no table.
        let mut lobby = quarter("lobby", 0, 0);
        lobby.kind = SlotKind::Lobby;
        assert!(
            !ResolvedSlot {
                id: lobby.id,
                monitor: 0,
                cell: rect(0, 0, 1, 1),
                kind: lobby.kind,
                rooms: None,
                stack: true,
            }
            .takes("pokerstars")
        );
    }

    /// Minimised tables keep their slot and are not placed until restored;
    /// monitors changing lay everything out again.
    #[test]
    fn minimised_tables_and_monitor_changes() {
        let mut world = World::new(Options::default(), two_monitors());
        let now = Instant::now();
        world.open(1, "pokerstars", FRAME);
        world.windows.get_mut(&WindowId(1)).expect("1").minimized = true;
        world.look(now);
        assert!(world.tiler.plan().is_empty(), "minimised: not placed");
        assert!(world.tiler.slot_of(WindowId(1)).is_some());
        world.windows.get_mut(&WindowId(1)).expect("1").minimized = false;
        let moved = world.settle(now);
        assert_eq!(moved.len(), 1);
        // The second monitor unplugged: the table moves to the primary.
        world.tiler.set_monitors(vec![two_monitors().remove(0)]);
        world.settle(now);
        assert!(two_monitors()[0].work_area.contains(&world.outer(1)));
    }
}
