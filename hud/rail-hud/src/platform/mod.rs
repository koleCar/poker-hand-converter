//! The one platform trait (docs/RAIL-PLAN.md §3.1, R3.2): finding table
//! windows, following them, drawing over them. Windows finds tables since
//! R3.3, draws over them since R3.4 and follows them with WinEvent hooks
//! since R3.5 ([`windows`]; the platform-free half of following is
//! [`tracking`]); macOS finds tables since R3.11 ([`macos`]: the window
//! server's list for bounds, the Accessibility API for titles - and so the
//! Accessibility permission, [`Permission`]) and draws over them since
//! R3.12 (AppKit on the main thread, the engine beside it); its tracking
//! is R3.13. [`sim::SimBackend`] is a fake driven by the table
//! simulator's events (R3.1), so the data path runs end to end without any
//! window API, on every OS and in CI.
//!
//! (T1, docs/research/TABLE-TILING.md §4.2) Table tiling's two platform
//! calls: [`Platform::monitors`] (each monitor's bounds and work area) and
//! [`Platform::place`] (move and resize a table, the rect it accepted read
//! back). The tiling engine is T2 (`crate::tiling`, `crate::placer`), which
//! adds what it needs of a backend: [`Platform::frame_insets`] (the frame
//! around a table's client area, so tables tile on their outer rects) and
//! [`Platform::placer`], a [`Placer`] that places windows and reads the
//! mouse ([`MouseState`]: the safety rule that never moves a table under a
//! click) from a thread of its own, so twelve placements never hold the
//! loop.
//!
//! Units: positions and sizes are **physical pixels** of the client area
//! (what the table is drawn in, without the frame), the scale is the
//! window's monitor's in thousandths (1000 = 100 % = 96 dpi on Windows,
//! 2000 = Retina). No floating point (the workspace's lints). On macOS,
//! whose window APIs speak points, "physical pixels" are the points times
//! the backing scale of the window's screen - what winit calls a physical
//! position - so points come back exactly as the rect divided by the
//! scale ([`macos`] has the rule).
//!
//! (T4, §4.4) The RNG overlay: a frame may carry the table's roll
//! ([`OverlayFrame::rng`], under the room's [`RngPermit`]); a frame of a
//! room whose HUD is refused - or of any room while the plan holds the
//! panels back - carries the roll alone ([`OverlayFrame::rng_only`]: no
//! HUD [`Permit`], so no panel, status or legend can be drawn). Its widget
//! is dragged and clicked through the same overlay code as a seat's panel,
//! under the pseudo-slot [`RNG_SLOT`].
//!
//! `unsafe` stays `deny` here (the crate's level) rather than `forbid`: a
//! `forbid` would bind [`windows`] and [`macos`], whose system wrappers
//! allow it one function at a time. Every other module below forbids it.

use std::fmt;

use rail_config::stats::Tone;

use crate::compliance::{Permit, RngPermit};
use crate::layout::{Positions, TableLayout};
use crate::panel::{PanelDesign, StatCell};
use crate::scene::Rgba;

pub mod drag;
pub mod macos;
pub mod matcher;
pub mod none;
pub mod sim;
pub mod tracking;
pub mod windows;

pub use matcher::{Redactor, SIM_PROCESS, TableMatcher, TitleMatch, table_key};

/// A window's identity on its system: an `HWND` (Windows), a `CGWindowID`
/// (macOS), the simulator's table number. Stable while the window lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WindowId(pub u64);

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    /// The right edge (exclusive).
    pub fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    /// The bottom edge (exclusive).
    pub fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// Whether `other` lies wholly inside this rect.
    pub fn contains(&self, other: &Rect) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.right() <= self.right()
            && other.bottom() <= self.bottom()
    }

    /// The area two rects share, square pixels.
    pub fn overlap(&self, other: &Rect) -> u64 {
        let w = self.right().min(other.right()) - i64::from(self.x.max(other.x));
        let h = self.bottom().min(other.bottom()) - i64::from(self.y.max(other.y));
        if w <= 0 || h <= 0 {
            0
        } else {
            u64::try_from(w).unwrap_or(0) * u64::try_from(h).unwrap_or(0)
        }
    }
}

/// (T1) The window rect whose client area is `want`, for a window whose
/// client area is `client` inside its window rect `outer` now: the frame
/// (title bar, borders) kept as it is around the new client area. What
/// both systems hand their move call, which takes the whole window.
pub fn outer_for(client: &Rect, outer: &Rect, want: &Rect) -> Rect {
    let left = i64::from(client.x) - i64::from(outer.x);
    let top = i64::from(client.y) - i64::from(outer.y);
    let extra_w = i64::from(outer.width) - i64::from(client.width);
    let extra_h = i64::from(outer.height) - i64::from(client.height);
    let int = |v: i64| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
    let uint = |v: i64| u32::try_from(v.max(0)).unwrap_or(u32::MAX);
    Rect {
        x: int(i64::from(want.x) - left),
        y: int(i64::from(want.y) - top),
        width: uint(i64::from(want.width) + extra_w),
        height: uint(i64::from(want.height) + extra_h),
    }
}

/// (T2) The frame a window draws around its client area, physical pixels
/// on each side: title bar, borders - on Windows the **visible** frame
/// (DWM's extended frame bounds, without the invisible resize borders), on
/// macOS the title bar. Table tiling lays the outer rects edge to edge and
/// sizes the client areas from them, so rooms whose frames differ still
/// tile without gaps or overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Insets {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl Insets {
    /// The outer rect around `client`.
    pub fn outer(&self, client: &Rect) -> Rect {
        let int = |v: i64| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
        Rect {
            x: int(i64::from(client.x) - i64::from(self.left)),
            y: int(i64::from(client.y) - i64::from(self.top)),
            width: client.width.saturating_add(self.width()),
            height: client.height.saturating_add(self.height()),
        }
    }

    /// The client area inside `outer`.
    pub fn client(&self, outer: &Rect) -> Rect {
        let int = |v: i64| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
        Rect {
            x: int(i64::from(outer.x) + i64::from(self.left)),
            y: int(i64::from(outer.y) + i64::from(self.top)),
            width: outer.width.saturating_sub(self.width()),
            height: outer.height.saturating_sub(self.height()),
        }
    }

    /// Left plus right.
    pub fn width(&self) -> u32 {
        self.left.saturating_add(self.right)
    }

    /// Top plus bottom.
    pub fn height(&self) -> u32 {
        self.top.saturating_add(self.bottom)
    }

    /// Measured at scale `from`, as it is at scale `to` (thousandths;
    /// rounded): a frame scales with its monitor's dpi (Windows'
    /// per-monitor frames, macOS's title bar in points).
    pub fn scaled(&self, from: u32, to: u32) -> Self {
        if from == to || from == 0 {
            return *self;
        }
        let scale = |v: u32| {
            let n = u64::from(v) * u64::from(to);
            let d = u64::from(from);
            u32::try_from((n + d / 2) / d).unwrap_or(u32::MAX)
        };
        Self {
            left: scale(self.left),
            top: scale(self.top),
            right: scale(self.right),
            bottom: scale(self.bottom),
        }
    }

    /// The insets of a window whose client area is `client` inside its
    /// outer rect `outer` (0 on a side where the client area pokes out).
    pub fn between(client: &Rect, outer: &Rect) -> Self {
        let side = |v: i64| u32::try_from(v.max(0)).unwrap_or(0);
        Self {
            left: side(i64::from(client.x) - i64::from(outer.x)),
            top: side(i64::from(client.y) - i64::from(outer.y)),
            right: side(outer.right() - client.right()),
            bottom: side(outer.bottom() - client.bottom()),
        }
    }
}

/// (T2) The mouse as the tiling safety rules need it: a table is never
/// moved while a button is down, nor within
/// [`crate::placer::QUIET_AFTER_CLICK`] of the last click (anywhere: the
/// system does not say on which window, and a click near a table is reason
/// enough to wait). Read without any permission on either system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MouseState {
    /// A mouse button is down now.
    pub down: bool,
    /// How long ago the last button went down, when the system says
    /// (macOS); `None`: it does not (Windows, which has no such query
    /// without a hook - [`crate::placer`] samples `down` instead, and a
    /// press since the last sample reads as a click now).
    pub since_click: Option<std::time::Duration>,
}

/// (T2) What table tiling's worker thread needs of a backend
/// ([`Platform::placer`]): placing a window as [`Platform::place`] does,
/// and the mouse. `Send`: it runs beside the loop, so a placement that
/// waits for its read-back (300 ms on Windows) never stalls the overlays.
pub trait Placer: Send {
    /// As [`Platform::place`].
    fn place(&mut self, id: WindowId, want: Rect) -> Result<Rect, PlatformError>;

    /// The mouse now: cheap, sampled every few tens of milliseconds.
    fn mouse(&mut self) -> MouseState;
}

/// (T1) A monitor's identity on its system: the `HMONITOR` (Windows), the
/// `CGDirectDisplayID` (macOS), the simulator's number. Stable while the
/// display configuration does not change - not across machines, nor on
/// Windows across a reconnect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MonitorId(pub u64);

/// (T1) A monitor, in the space and units of [`TableWindow::client`]:
/// physical pixels, the primary monitor's top-left the origin, y down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Monitor {
    pub id: MonitorId,
    /// The primary monitor (Windows: the taskbar's and the origin's;
    /// macOS: the main display, the one with the menu bar).
    pub primary: bool,
    /// The whole monitor.
    pub bounds: Rect,
    /// What windows may use: the bounds less the taskbar (Windows' `rcWork`)
    /// or the menu bar and the Dock (macOS' `visibleFrame`).
    pub work_area: Rect,
    /// Its scale in thousandths (96 dpi = 1000, Retina 2000), as
    /// [`TableWindow::scale_permille`].
    pub scale_permille: u32,
}

/// The process that owns a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    /// `None` when the backend cannot tell (the simulator's event stream).
    pub pid: Option<u32>,
    /// The executable's name: `PokerStars.exe`, `PokerStars`, ...
    pub name: String,
}

/// A window that looks like a poker table of a room `sites.json` knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableWindow {
    pub id: WindowId,
    /// The `sites.json` id of the room whose matcher took the window.
    /// Compliance mode decides on this (crate::compliance).
    pub site: String,
    pub process: ProcessInfo,
    pub title: String,
    /// The title's `table` group through [`table_key`]: the table name the
    /// room's hands carry (`Table 'Hygiea IV 40-100 bb'`), how a hand is
    /// matched to its window (equal keys, nothing looser).
    pub table: Option<String>,
    /// Seats: the title's `seats` group, else (the engine) the table's last
    /// hand; the simulator says.
    pub size: Option<u32>,
    /// The client area, physical pixels.
    pub client: Rect,
    /// The monitor's scale in thousandths.
    pub scale_permille: u32,
    pub minimized: bool,
}

/// A visible top-level window as the system reports it: what
/// [`windows::enumerate`] lists (R3.3), before any room's matcher looks at
/// it. `--list-windows` prints these; [`table_of`] makes tables of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawWindow {
    pub id: WindowId,
    pub pid: u32,
    /// The executable's file name (`PokerStars.exe`); empty when the
    /// process could not be asked (another user's, a protected one).
    pub process: String,
    /// The window class (`GetClassNameW`): not matched on yet, but captured
    /// with the titles in case a room needs it.
    pub class: String,
    pub title: String,
    /// The client area in physical pixels, screen coordinates; empty while
    /// minimised (an iconic window has no client area to speak of).
    pub client: Rect,
    /// The effective dpi of the monitor the window is on (0: unknown).
    pub monitor_dpi: u32,
    /// The window's own dpi (`GetDpiForWindow`): 96 for a client that is
    /// not per-monitor aware, which Windows then stretches as a bitmap.
    pub window_dpi: u32,
    pub awareness: DpiAwareness,
    pub minimized: bool,
    /// Hidden by the window manager although "visible": on another virtual
    /// desktop, or a suspended app's window (`DWMWA_CLOAKED`).
    pub cloaked: bool,
}

/// (T6) What `--list-windows` shows of a window for table tiling: its
/// frame and whether it can be resized, read the same way tiling reads
/// them and nothing more (no message is sent to the client, nothing inside
/// the window is read). `None`: the system did not say, or there is no
/// read-only way to ask.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowDetails {
    /// The outer rect, physical pixels: Windows' **visible** frame (DWM's
    /// extended frame bounds, without the invisible resize borders), the
    /// whole window on macOS (title bar included). What tiling lays edge to
    /// edge.
    pub outer: Option<Rect>,
    /// The frame around the client area: `Insets::between(client, outer)`,
    /// what [`Platform::frame_insets`] gives the tiler.
    pub insets: Option<Insets>,
    /// It can be resized: Windows' `WS_THICKFRAME` style, macOS's `AXSize`
    /// settable.
    pub resizable: Option<bool>,
    /// It can be moved (macOS: `AXPosition` settable; Windows: any window
    /// can be).
    pub movable: Option<bool>,
    /// Its smallest and largest size, physical pixels of the outer rect,
    /// when the system says so without asking the client.
    pub min_size: Option<(u32, u32)>,
    pub max_size: Option<(u32, u32)>,
}

/// (T6) [`WindowDetails`] of `windows` on this system (Windows, macOS; empty
/// elsewhere), by id. Read-only.
pub fn window_details(
    windows: &[RawWindow],
) -> std::collections::BTreeMap<WindowId, WindowDetails> {
    if cfg!(target_os = "macos") {
        macos::details(windows)
    } else {
        self::windows::details(windows)
    }
}

/// A window's DPI awareness (how Windows scales it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DpiAwareness {
    /// Drawn at 96 dpi and stretched by Windows.
    Unaware,
    /// Drawn at the primary monitor's dpi, stretched on others.
    System,
    /// Drawn at its monitor's dpi.
    PerMonitor,
    #[default]
    Unknown,
}

impl DpiAwareness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unaware => "unaware",
            Self::System => "system",
            Self::PerMonitor => "per-monitor",
            Self::Unknown => "unknown",
        }
    }
}

/// A dpi as a scale in thousandths (96 dpi = 1000); 0 counts as 96.
pub fn dpi_permille(dpi: u32) -> u32 {
    if dpi == 0 { 1000 } else { dpi * 1000 / 96 }
}

/// The table `window` is, if one of `matchers` takes it: the first that
/// does (`sites.json` order, then test-only entries). A minimised or
/// cloaked window is still a table - the HUD stays attached and shows
/// nothing over it until it is back.
pub fn table_of(window: &RawWindow, matchers: &[TableMatcher]) -> Option<TableWindow> {
    // A window without a title is never a table, whatever a pattern
    // accepts: helper windows can report themselves visible (winit's
    // "Winit Thread Event Target", seen on the Windows CI runner).
    if window.title.trim().is_empty() {
        return None;
    }
    matchers.iter().find_map(|matcher| {
        let found = matcher.matches(&window.process, &window.title)?;
        Some(TableWindow {
            id: window.id,
            site: matcher.site.clone(),
            process: ProcessInfo {
                pid: Some(window.pid),
                name: window.process.clone(),
            },
            title: window.title.clone(),
            table: found.table,
            size: found.seats,
            client: window.client,
            // The monitor's scale is what an overlay draws at; a window
            // that is not per-monitor aware says 96 for itself.
            scale_permille: tracking::scale_of(window.monitor_dpi, window.window_dpi),
            minimized: window.minimized || window.cloaked,
        })
    })
}

/// What happened to a tracked window since the last poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TableEvent {
    Moved {
        id: WindowId,
        client: Rect,
        scale_permille: u32,
    },
    Minimized {
        id: WindowId,
        minimized: bool,
    },
    /// The title changed: a tournament table move, or the room renamed the
    /// table. The `table` group is read again.
    Retitled {
        id: WindowId,
        title: String,
        table: Option<String>,
    },
    Closed {
        id: WindowId,
    },
    /// A followed process showed a top-level window (R3.5): perhaps a new
    /// table, or one shown again - look for tables now rather than at the
    /// next periodic find.
    Appeared,
    /// The user dragged a seat's panel to a new place (R3.6): remembered
    /// for the room, the table `size` and the `slot` (the visual seat).
    /// (T4) `slot` [`RNG_SLOT`]: the RNG widget was dragged.
    PanelMoved {
        id: WindowId,
        size: u32,
        slot: u32,
        /// The panel's centre, thousandths of the client area - already
        /// inside it, and clear of the table graphics where the room
        /// forbids covering them.
        x: u32,
        y: u32,
        /// The backend's count of drags (increasing): the engine hands the
        /// last it took back in [`Seating::drags_seen`], so the overlay
        /// stops showing its own copy once the frame carries the position.
        seq: u64,
    },
    /// (R3.8) The user clicked a seat's panel - pressed and released it
    /// without dragging it ([`drag::Drag::is_click`]): the engine asks the
    /// app for the popup of the player at that slot. (T4) `slot`
    /// [`RNG_SLOT`]: the RNG widget was clicked (a roll, when the user's
    /// triggers say so).
    PanelClicked {
        id: WindowId,
        /// The panel's visual seat (R3.6).
        slot: u32,
        /// The panel on the screen, physical pixels (the client area's
        /// origin plus the panel's place in it): where the popup goes.
        panel: Rect,
        /// The table's monitor scale, thousandths.
        scale_permille: u32,
    },
    /// (T7) A table's own window gave one of the signals a client gives by
    /// itself - its taskbar button flashed, it came to the foreground or
    /// was raised above other programs - for the Action Required slot.
    /// Reported only for the programs the engine asked to watch
    /// ([`Platform::watch_turn_signals`]); nothing inside the table is read.
    Signalled {
        id: WindowId,
        signal: rail_config::SignalKind,
    },
}

/// (T4) The pseudo-slot of the RNG widget: what the overlays' shared drag
/// ([`drag::Drag`]) picks it up as, what a dragged widget is kept under
/// ([`Seating::positions`]: the user's place for it on this room and table
/// size) and what [`TableEvent::PanelMoved`] / [`TableEvent::PanelClicked`]
/// carry for it. No seat is ever this slot (a table has at most ten).
pub const RNG_SLOT: u32 = u32::MAX;

/// Where a frame's panels go (R3.6): the room's layout for the table size,
/// the hero's rotation and the panels the user placed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Seating {
    /// Where the room's client draws this table size; `None`: the table
    /// simulator's geometry (the default until a room's is measured).
    pub layout: Option<TableLayout>,
    /// The hero's seat when the room's client rotates the table so the hero
    /// is always in one place; `None`: drawn by seat number.
    pub rotate_to: Option<u32>,
    /// Panels the user placed, by slot (this room and table size); (T4)
    /// the RNG widget's under [`RNG_SLOT`].
    pub positions: Positions,
    /// The last [`TableEvent::PanelMoved`] (`seq`) the engine took in.
    pub drags_seen: u64,
}

/// (T4) The table's roll as its RNG widget shows it: one large number in
/// its band's colour, the band's name under it when the user gave one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RngShown {
    /// The room's yes for the RNG (T0, `sites.json` `rng.allowed`,
    /// independent of its HUD policy): no widget exists without it.
    pub permit: RngPermit,
    /// The number rolled.
    pub value: u32,
    /// Its band's colour.
    pub colour: Rgba,
    /// Its band's name, if the user gave it one.
    pub label: Option<String>,
    /// The digits of the range's widest number: the plate keeps its size
    /// from roll to roll.
    pub digits: u32,
    /// The table's rolls so far: a new roll is a new frame (painted again)
    /// even when it repeats the number.
    pub seq: u64,
    /// (T5 follow-up) The widget's size, percent of its size at the
    /// table's scale (`RngSettings::scale`, 50 - 200).
    pub scale_pct: u32,
    /// (T5 follow-up) Its opacity, percent (`RngSettings::opacity`,
    /// 30 - 100): the plate and the number alike.
    pub opacity_pct: u32,
}

/// What an overlay shows (R3.4): the data; `crate::scene::compose` lays it
/// out under the permit's restrictions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayFrame {
    /// Compliance mode's yes for the window's room: no panel, status line
    /// or legend is drawn for a room without a HUD. (T4) `None` only in an
    /// RNG-only frame ([`OverlayFrame::rng_only`]), which shows nothing but
    /// [`OverlayFrame::rng`].
    pub permit: Option<Permit>,
    /// A line instead of panels: "waiting for first hand", "no store".
    pub status: Option<String>,
    /// (R3.7) **Debug builds only**: the latency of the hand the frame
    /// shows, a small line in a corner of the table. Never set in a release
    /// build (`crate::engine` makes it under `cfg!(debug_assertions)`).
    pub debug: Option<String>,
    /// The table's seats (the title's, else its hands'); `None`: from the
    /// players' seat numbers.
    pub size: Option<u32>,
    /// Where the panels go (R3.6).
    pub seating: Seating,
    pub panels: Vec<SeatPanel>,
    /// (R3.8) The colour bands the panel's statistics use (each
    /// definition's tones, in the scale's order): the legend shows them as
    /// the room allows (two thresholds on PokerStars: low, normal, high).
    /// Empty: no legend.
    pub legend: Vec<Tone>,
    /// (R3.9) The design the table is drawn with - the one assigned to its
    /// room, size and format (`crate::design`) - flagged with what a room
    /// may refuse; `crate::scene::compose` cuts it down to the permit's
    /// restrictions before anything is laid out.
    pub design: PanelDesign,
    /// (T4) The table's RNG widget, where the room's policy and the user's
    /// settings allow it.
    pub rng: Option<RngShown>,
}

impl OverlayFrame {
    /// A frame with a status line and no panels.
    pub fn status(permit: Permit, size: Option<u32>, status: impl Into<String>) -> Self {
        Self {
            permit: Some(permit),
            status: Some(status.into()),
            debug: None,
            size,
            seating: Seating::default(),
            panels: Vec::new(),
            legend: Vec::new(),
            design: PanelDesign::default(),
            rng: None,
        }
    }

    /// (T4) A frame with the RNG widget and nothing else, under the RNG's
    /// permit alone: the room refuses a HUD, or the plan holds the panels
    /// back.
    pub fn rng_only(rng: RngShown, size: Option<u32>, seating: Seating) -> Self {
        Self {
            permit: None,
            status: None,
            debug: None,
            size,
            seating,
            panels: Vec::new(),
            legend: Vec::new(),
            design: PanelDesign::default(),
            rng: Some(rng),
        }
    }

    /// (T4) Whether the frame may be drawn over a window of room `site`:
    /// it carries at least one permit, and every permit it carries is that
    /// room's - the check each backend makes again where drawing starts.
    pub fn permitted_for(&self, site: &str) -> Result<(), String> {
        let sites: Vec<&str> = self
            .permit
            .iter()
            .map(Permit::site)
            .chain(self.rng.iter().map(|rng| rng.permit.site()))
            .collect();
        if sites.is_empty() {
            return Err("a frame without a permit".to_owned());
        }
        match sites.iter().find(|s| **s != site) {
            Some(other) => Err(format!("a frame permitted for {other} is not for {site}")),
            None => Ok(()),
        }
    }
}

/// One player's panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatPanel {
    pub player: String,
    /// The hand's seat number: where the panel goes (`None`: not placed).
    pub seat: Option<u32>,
    /// Hands the player's rollups count.
    pub hands: i64,
    /// The design's statistics (`crate::panel`).
    pub stats: Vec<StatCell>,
    /// (R3.8) The user's words on the player that a panel may show: never
    /// drawn where the room forbids labelling players (PokerStars, ACR:
    /// `noPlayerLabels`), and never read for an opaque-id or positional
    /// seat, nor for the hero.
    pub words: PanelWords,
}

/// (R3.8) A player's colour tag, label and note mark as a panel shows
/// them (R2.7c's `players` / `player_labels`: the user's own words).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PanelWords {
    pub colour: Option<TagColour>,
    /// The player's labels, as one short line.
    pub label: Option<String>,
    /// The player has a note (the popup shows it).
    pub noted: bool,
}

/// (R3.8) The six colour tags of R2.7c (`rail_store::players::COLOURS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TagColour {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}

impl TagColour {
    /// The store's name (`red`, ...); `None` for anything else.
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "red" => Self::Red,
            "orange" => Self::Orange,
            "yellow" => Self::Yellow,
            "green" => Self::Green,
            "blue" => Self::Blue,
            "purple" => Self::Purple,
            _ => return None,
        })
    }
}

/// (R3.11) A system permission a backend needs to find tables, which the
/// user grants in the system's settings. The HUD reports it
/// (`HealthReport::permission_needed`) and the app explains it; the HUD
/// never changes a setting itself, and asks the system to prompt only
/// when the user clicked for it ([`Platform::request_permission`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Permission {
    /// macOS: Privacy & Security, Accessibility - to read window titles
    /// (`AXTitle`). Not Screen Recording: nothing reads pixels, and the
    /// window server's own window names (which would need it) are not used.
    Accessibility,
}

impl Permission {
    /// The wire name (`accessibility`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
        }
    }

    /// The wire name read back.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "accessibility" => Some(Self::Accessibility),
            _ => None,
        }
    }
}

/// Why a backend call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    /// Not implemented on this backend yet.
    Unsupported(&'static str),
    /// The window is gone.
    Gone(WindowId),
    /// (R3.11) The user has not granted a permission the call needs.
    PermissionNeeded(Permission),
    /// (T1) The window is in full screen (macOS: a Space of its own): it is
    /// left where it is.
    FullScreen(WindowId),
    /// (T1) The window's thread does not answer (Windows: a hung client):
    /// nothing was asked of it.
    NotResponding(WindowId),
    /// The system said no (a permission, a handle).
    Os(String),
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(what) => write!(f, "not supported here: {what}"),
            Self::Gone(id) => write!(f, "window {} is gone", id.0),
            Self::PermissionNeeded(Permission::Accessibility) => write!(
                f,
                "the Accessibility permission is needed to read window titles \
                 (System Settings, Privacy & Security, Accessibility)"
            ),
            Self::FullScreen(id) => write!(f, "window {} is in full screen", id.0),
            Self::NotResponding(id) => write!(f, "window {} is not responding", id.0),
            Self::Os(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for PlatformError {}

/// A windowing backend. Called from the HUD's one loop thread only, so it
/// need not be `Send`. Its windows live where the system wants them: on
/// Windows a thread of the backend's own, on macOS the main thread
/// (AppKit's, R3.12: the loop then runs on a thread beside it).
pub trait Platform {
    /// `windows`, `macos`, `sim`, `none`.
    fn name(&self) -> &'static str;

    /// Every window that one of `matchers` takes, with its room. Windows of
    /// rooms the HUD may not attach to are returned too: compliance mode
    /// refuses them and the app says why.
    fn find_tables(&mut self, matchers: &[TableMatcher])
    -> Result<Vec<TableWindow>, PlatformError>;

    /// Start following a window found by `find_tables` (moves, resizes,
    /// minimise, title, close): its changes come from `poll_events`.
    fn track(&mut self, window: &TableWindow) -> Result<(), PlatformError>;

    /// Stop following it.
    fn untrack(&mut self, id: WindowId);

    /// A tracked window moved, was resized, changed monitor or scale, was
    /// minimised, cloaked or restored, or changed size (seats): keep its
    /// overlay on it (R3.4). The engine calls this with what it knows now;
    /// a backend without overlays ignores it. A backend that follows the
    /// windows itself (Windows' hooks, R3.5) has moved the overlay already
    /// and may check the system again rather than trust a description
    /// that can be older than what it saw.
    fn follow(&mut self, _window: &TableWindow) {}

    /// What happened to the tracked windows since the last call; never
    /// blocks.
    fn poll_events(&mut self) -> Vec<TableEvent>;

    /// Show `frame` over the window (creating its overlay on first use):
    /// above the table, below other windows, never taking focus. A frame
    /// equal to the one shown, at the same size, is not drawn again.
    fn overlay(&mut self, id: WindowId, frame: &OverlayFrame) -> Result<(), PlatformError>;

    /// Remove the window's overlay.
    fn remove_overlay(&mut self, id: WindowId);

    /// (R3.11) A permission the backend needs to find tables and does not
    /// have now (macOS: Accessibility). Asked for each health answer, so
    /// cheap; reading it changes nothing and prompts nobody.
    fn permission_needed(&self) -> Option<Permission> {
        None
    }

    /// (R3.11) The user clicked to grant `permission`: ask the system to
    /// show its own prompt (macOS lists the app in System Settings then).
    /// Only on the user's request, never unattended; a no-op where nothing
    /// is needed.
    fn request_permission(&mut self, _permission: Permission) {}

    /// (R3.11) The executables of the processes that have an ordinary
    /// window now, read without any permission (macOS: the window server's
    /// list and `proc_pidpath`): whether asking for a missing permission
    /// would find anything. `None`: the backend cannot tell.
    fn running_processes(&mut self) -> Option<Vec<String>> {
        None
    }

    /// (R3.14) Every tracked table is followed by the system's
    /// notifications alone (macOS: [`macos::fully_observed`]), so the
    /// engine's periodic look is only the safety net and may slow down
    /// ([`crate::engine::Settings::find_every_notified`]). Cheap: asked at
    /// every look. `false` by default (Windows keeps its look: cheap there).
    fn notified(&self) -> bool {
        false
    }

    /// (R3.14) Every overlay paint so far, µs (oldest first; the backend
    /// keeps the last 10 000): for `--perf-report`. Asks the overlays'
    /// thread, so never on the loop's hot path.
    fn paint_times_us(&self) -> Vec<u64> {
        Vec::new()
    }

    /// (R3.14) Every follow so far, µs - the system's event (WinEvent hook,
    /// accessibility notification) to the overlay moved, shown or hidden -
    /// for `--perf-report`, as [`Platform::paint_times_us`].
    fn follow_times_us(&self) -> Vec<u64> {
        Vec::new()
    }

    /// (T1) The monitors now, the primary first: where tables may be
    /// placed. Empty where the backend cannot tell (the default).
    fn monitors(&mut self) -> Vec<Monitor> {
        Vec::new()
    }

    /// (T1) Move and resize table window `id` so that its **client area**
    /// is `want` (the space and units of [`TableWindow::client`]; the
    /// backend puts the window's own frame around it), and return the
    /// client area it has afterwards, read back from the system. A
    /// minimised window is restored first; the window is never activated
    /// and keeps its place in the z-order. The answer may differ from
    /// `want` - a client that keeps its aspect ratio or a minimum size, a
    /// monitor of another scale -: the caller decides what to do about it;
    /// nothing is retried here. Bounded: a client that does not answer
    /// cannot hold the caller for long (each backend says how long). The
    /// move reaches `poll_events` as any other move does.
    fn place(&mut self, id: WindowId, want: Rect) -> Result<Rect, PlatformError> {
        let _ = (id, want);
        Err(PlatformError::Unsupported("placing windows"))
    }

    /// (T2) The frame around `window`'s client area now, at its scale
    /// (`window.scale_permille`); `None` when the backend cannot tell (the
    /// default: tiled as if it had none). Cheap: asked at every look for
    /// each table tiling manages.
    fn frame_insets(&mut self, window: &TableWindow) -> Option<Insets> {
        let _ = window;
        None
    }

    /// (T2) A [`Placer`] for table tiling's worker thread; `None` where the
    /// backend places nothing (the default: tiling stays off).
    fn placer(&mut self) -> Option<Box<dyn Placer>> {
        None
    }

    /// (T7) The window the user is at now - the system's foreground window
    /// (Windows), the front-most ordinary window of the desktop (macOS) -
    /// for a hotkey that acts on "the table in front" (the RNG's roll).
    /// Read only: nothing is activated or raised. `None` where the backend
    /// cannot tell (the default).
    fn focused_window(&mut self) -> Option<WindowId> {
        None
    }

    /// (T7) Watch `processes`' windows for the signals a client gives by
    /// itself on the user's turn, reported as [`TableEvent::Signalled`]
    /// (empty: stop). The engine asks only for rooms whose policy gives an
    /// `ActionPermit` and only while the layout in force has an Action
    /// Required slot - so today never. Read-only: nothing is loaded into a
    /// client, nothing inside a table is read. The default: no source
    /// (macOS, where a Dock bounce is invisible to another program).
    fn watch_turn_signals(&mut self, processes: &[String]) {
        let _ = processes;
    }
}

/// (T1) Whether a placement has settled, for a backend whose move call
/// returns before the window has moved (Windows' `SWP_ASYNCWINDOWPOS`):
/// `samples` are the client areas read since the call, oldest first,
/// `before` the one before it. Settled when the latest is `want`, or when
/// it has left `before` and stayed the same for the last [`SETTLE_SAMPLES`]
/// reads (the client took another size and keeps it). Otherwise the
/// caller reads again until its deadline, and then takes the latest as it
/// is (the client refused, or has not answered yet).
pub fn place_settled(want: &Rect, before: &Rect, samples: &[Rect]) -> bool {
    let Some(last) = samples.last() else {
        return false;
    };
    if last == want {
        return true;
    }
    samples.len() >= SETTLE_SAMPLES
        && last != before
        && samples[samples.len() - SETTLE_SAMPLES..]
            .iter()
            .all(|s| s == last)
}

/// (T1) Equal reads in a row that make a placement settled
/// ([`place_settled`]).
pub const SETTLE_SAMPLES: usize = 3;

/// (R3.11) Whether granting a missing permission would make a difference
/// now: the test-only simulator entry is active, or one of `running` is a
/// process of an allowed room's matcher (`allowed`: the matchers of rooms
/// whose HUD is allowed - a room has one only with a `tables` block for this
/// system). A backend that cannot tell (`None`) counts as yes when there is
/// an allowed matcher at all.
pub fn permission_matters(
    running: Option<&[String]>,
    allowed: &[TableMatcher],
    test_entry: bool,
) -> bool {
    if test_entry {
        return true;
    }
    match running {
        Some(running) => running
            .iter()
            .any(|process| allowed.iter().any(|m| m.takes_process(process))),
        None => !allowed.is_empty(),
    }
}

/// This system's backend.
pub fn native() -> Box<dyn Platform> {
    if cfg!(windows) {
        Box::new(windows::WindowsBackend::default())
    } else if cfg!(target_os = "macos") {
        Box::new(macos::MacosBackend::default())
    } else {
        Box::new(none::NoBackend)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    fn raw(process: &str, title: &str) -> RawWindow {
        RawWindow {
            id: WindowId(0x1234),
            pid: 77,
            process: process.into(),
            class: "Frame".into(),
            title: title.into(),
            client: Rect {
                x: 10,
                y: 40,
                width: 1200,
                height: 830,
            },
            monitor_dpi: 144,
            window_dpi: 144,
            awareness: DpiAwareness::PerMonitor,
            minimized: false,
            cloaked: false,
        }
    }

    fn matchers() -> Vec<TableMatcher> {
        vec![
            TableMatcher {
                site: "pokerstars".into(),
                processes: vec!["PokerStars.exe".into()],
                title: Regex::new(r"^(?P<table>.+?) - \$.*?(?:(?P<seats>\d+)-max)?$")
                    .expect("regex"),
            },
            TableMatcher::simulator("winamax", Regex::new(r"^(?P<table>.+?) / ").expect("regex")),
        ]
    }

    /// A raw window becomes a table of the first room that takes it, with
    /// its name, seats, rect and the monitor's scale.
    #[test]
    fn raw_windows_become_tables() {
        let table = table_of(
            &raw("PokerStars.exe", "Hygiea IV - $0.05 6-max"),
            &matchers(),
        )
        .expect("a table");
        assert_eq!(table.site, "pokerstars");
        assert_eq!(table.table.as_deref(), Some("Hygiea IV"));
        assert_eq!(table.size, Some(6));
        assert_eq!(table.process.pid, Some(77));
        assert_eq!(table.client.width, 1200);
        assert_eq!(table.scale_permille, 1500);
        assert!(!table.minimized);

        let sim = table_of(&raw("rail-hud-sim.exe", "Florence 03 / x"), &matchers())
            .expect("the simulator's");
        assert_eq!(
            (sim.site.as_str(), sim.table.as_deref()),
            ("winamax", Some("Florence 03"))
        );
        // Neither the process nor the title is enough alone.
        assert!(table_of(&raw("rail-hud-sim.exe", "Hygiea IV - $1"), &matchers()).is_none());
        assert!(table_of(&raw("PokerStars.exe", "PokerStars Lobby"), &matchers()).is_none());
        assert!(table_of(&raw("", "Hygiea IV - $1"), &matchers()).is_none());
        // No title, no table - even for a pattern that takes anything.
        let any = [TableMatcher::simulator(
            "pokerstars",
            Regex::new("^.*$").expect("regex"),
        )];
        assert!(table_of(&raw("rail-hud-sim.exe", ""), &any).is_none());
        assert!(table_of(&raw("rail-hud-sim.exe", "  "), &any).is_none());
        assert!(table_of(&raw("rail-hud-sim.exe", "T"), &any).is_some());
    }

    /// Minimised and cloaked tables are tables, marked hidden; a client that
    /// is not per-monitor aware still gets its monitor's scale.
    #[test]
    fn hidden_and_unaware_windows() {
        let mut window = raw("PokerStars.exe", "T - $1");
        window.minimized = true;
        window.client = Rect::default();
        assert!(table_of(&window, &matchers()).expect("table").minimized);
        let mut window = raw("PokerStars.exe", "T - $1");
        window.cloaked = true;
        assert!(table_of(&window, &matchers()).expect("table").minimized);
        let mut window = raw("PokerStars.exe", "T - $1");
        window.window_dpi = 96;
        window.awareness = DpiAwareness::Unaware;
        assert_eq!(
            table_of(&window, &matchers())
                .expect("table")
                .scale_permille,
            1500
        );
        window.monitor_dpi = 0;
        assert_eq!(
            table_of(&window, &matchers())
                .expect("table")
                .scale_permille,
            1000
        );
        assert_eq!(dpi_permille(120), 1250);
        assert_eq!(dpi_permille(192), 2000);
        assert_eq!(dpi_permille(0), 1000);
    }

    /// (R3.11) A missing permission is asked for only when it would find
    /// something: a running client of an allowed room with a matcher, or the
    /// simulator's test entry - never for a prohibited room's client, nor
    /// with no supported client running.
    #[test]
    fn a_permission_matters_only_with_a_supported_client() {
        let stars = TableMatcher {
            site: "pokerstars".into(),
            processes: vec!["PokerStars".into()],
            title: Regex::new("^(?P<table>.+)$").expect("regex"),
        };
        let running = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
        let browser = running(&["Safari", "Terminal"]);
        let client = running(&["Safari", "pokerstars"]);
        // No room has a macOS matcher today: nothing to ask for.
        assert!(!permission_matters(Some(&client), &[], false));
        let allowed = std::slice::from_ref(&stars);
        assert!(!permission_matters(Some(&browser), allowed, false));
        assert!(permission_matters(Some(&client), allowed, false));
        // The simulator's test entry: always.
        assert!(permission_matters(Some(&browser), &[], true));
        // A backend that cannot tell: only if some allowed room could match.
        assert!(permission_matters(None, &[stars], false));
        assert!(!permission_matters(None, &[], false));
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// (T1) A window rect for a wanted client area keeps the frame around
    /// it: a Windows frame with borders on every side, a macOS title bar
    /// only, none at all; negative coordinates (a monitor left of the
    /// primary) too.
    #[test]
    fn the_frame_goes_around_the_wanted_client_area() {
        // Windows 11 at 150 %: 11 px invisible borders, a 45 px caption.
        let client = rect(111, 256, 1200, 830);
        let outer = rect(100, 200, 1222, 897);
        assert_eq!(
            outer_for(&client, &outer, &rect(0, 0, 800, 600)),
            rect(-11, -56, 822, 667)
        );
        assert_eq!(
            outer_for(&client, &outer, &rect(-1920, 40, 640, 480)),
            rect(-1931, -16, 662, 547)
        );
        // macOS: a 28 pt title bar at 2x, no side borders.
        let client = rect(200, 156, 1280, 960);
        let outer = rect(200, 100, 1280, 1016);
        assert_eq!(
            outer_for(&client, &outer, &rect(0, 56, 1000, 700)),
            rect(0, 0, 1000, 756)
        );
        // Borderless: the window is the client area.
        let same = rect(5, 5, 300, 200);
        assert_eq!(
            outer_for(&same, &same, &rect(9, 9, 10, 10)),
            rect(9, 9, 10, 10)
        );
    }

    /// (T2) A frame around a client area: outer and client rects are each
    /// other's inverse, measured from the two rects, scaled with the dpi.
    #[test]
    fn frames_go_around_client_areas() {
        let frame = Insets {
            left: 1,
            top: 31,
            right: 1,
            bottom: 1,
        };
        let client = rect(-1919, 40, 1200, 830);
        let outer = frame.outer(&client);
        assert_eq!(outer, rect(-1920, 9, 1202, 862));
        assert_eq!(frame.client(&outer), client);
        assert_eq!(Insets::between(&client, &outer), frame);
        assert_eq!((frame.width(), frame.height()), (2, 32));
        // 125 %: 31 px becomes 38.75, rounded.
        assert_eq!(
            frame.scaled(1000, 1250),
            Insets {
                left: 1,
                top: 39,
                right: 1,
                bottom: 1
            }
        );
        assert_eq!(frame.scaled(1250, 1250), frame);
        // A client area poking out of its "frame" measures as no border.
        assert_eq!(
            Insets::between(&rect(0, 0, 100, 100), &rect(5, 5, 50, 50)),
            Insets::default()
        );
    }

    /// (T1) Rect arithmetic for monitors and placements.
    #[test]
    fn rects_contain_and_overlap() {
        let work = rect(0, 0, 1920, 1040);
        assert!(work.contains(&rect(0, 0, 1920, 1040)));
        assert!(work.contains(&rect(960, 520, 960, 520)));
        assert!(!work.contains(&rect(961, 520, 960, 520)));
        assert!(!work.contains(&rect(-1, 0, 10, 10)));
        assert_eq!(work.overlap(&rect(1820, 1000, 200, 200)), 100 * 40);
        assert_eq!(work.overlap(&rect(1920, 0, 10, 10)), 0);
        assert_eq!(rect(-1920, 0, 1920, 1080).right(), 0);
        assert_eq!(rect(0, -50, 10, 50).bottom(), 0);
    }

    /// (T1) An asynchronous placement settles when the window is where it
    /// was asked to be, or where the client keeps it after moving - never
    /// on reads that have not changed yet.
    #[test]
    fn a_placement_settles() {
        let before = rect(0, 0, 640, 480);
        let want = rect(100, 100, 800, 600);
        assert!(!place_settled(&want, &before, &[]));
        // The window has not moved yet: keep reading.
        assert!(!place_settled(&want, &before, &[before, before, before]));
        assert!(!place_settled(
            &want,
            &before,
            &[before, before, before, before, before]
        ));
        // There.
        assert!(place_settled(&want, &before, &[before, want]));
        assert!(place_settled(&want, &before, &[want]));
        // A client that keeps its aspect ratio: moved, another size, kept.
        let kept = rect(100, 100, 800, 560);
        assert!(!place_settled(&want, &before, &[kept]));
        assert!(!place_settled(&want, &before, &[before, kept, kept]));
        assert!(place_settled(&want, &before, &[before, kept, kept, kept]));
        // Still changing: not yet.
        let next = rect(100, 100, 790, 560);
        assert!(!place_settled(&want, &before, &[kept, kept, next]));
        // Asked to stay where it is: settled at once.
        assert!(place_settled(&before, &before, &[before]));
    }

    /// The stubs find nothing, so nothing is ever drawn by them. Windows'
    /// and macOS's backends find what matches (nothing, with no matcher -
    /// and without asking for any permission) and, on their own system,
    /// follow a window they are given; their tables are
    /// `tests/windows_tables.rs`' and `tests/macos_tables.rs`'.
    #[test]
    fn the_stub_backends_find_nothing() {
        for mut backend in [
            Box::new(windows::WindowsBackend::default()) as Box<dyn Platform>,
            Box::new(macos::MacosBackend::default()),
            Box::new(none::NoBackend),
            native(),
        ] {
            assert_eq!(
                backend.find_tables(&[]),
                Ok(Vec::new()),
                "{}",
                backend.name()
            );
            assert!(backend.poll_events().is_empty());
            let window = TableWindow {
                id: WindowId(1),
                site: "pokerstars".into(),
                process: ProcessInfo {
                    pid: None,
                    name: "x".into(),
                },
                title: "t".into(),
                table: None,
                size: None,
                client: Rect::default(),
                scale_permille: 1000,
                minimized: false,
            };
            let tracks = (cfg!(windows) && backend.name() == "windows")
                || (cfg!(target_os = "macos") && backend.name() == "macos");
            assert_eq!(backend.track(&window).is_ok(), tracks, "{}", backend.name());
            backend.untrack(WindowId(1));
            let permit = crate::compliance::Compliance::shipped()
                .expect("shipped")
                .permit("pokerstars")
                .expect("permitted");
            let frame = OverlayFrame::status(permit, Some(6), "waiting");
            assert!(
                backend.overlay(WindowId(1), &frame).is_err(),
                "{}",
                backend.name()
            );
            backend.remove_overlay(WindowId(1));
            // (T1) Off their own system the native backends know no
            // monitor and place nothing; `none` keeps the defaults.
            let native = (cfg!(windows) && backend.name() == "windows")
                || (cfg!(target_os = "macos") && backend.name() == "macos");
            if !native {
                assert!(backend.monitors().is_empty(), "{}", backend.name());
                assert!(
                    matches!(
                        backend.place(WindowId(1), Rect::default()),
                        Err(PlatformError::Unsupported(_))
                    ),
                    "{}",
                    backend.name()
                );
            }
        }
    }
}
