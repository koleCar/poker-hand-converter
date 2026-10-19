//! The one platform trait (docs/RAIL-PLAN.md §3.1, R3.2): finding table
//! windows, following them, drawing over them. Windows finds tables since
//! R3.3, draws over them since R3.4 and follows them with WinEvent hooks
//! since R3.5 ([`windows`]; the platform-free half of following is
//! [`tracking`]); macOS (R3.11 - R3.13) is a stub that finds nothing.
//! [`sim::SimBackend`] is a fake driven by the table simulator's events
//! (R3.1), so the data path runs end to end without any window API, on
//! every OS and in CI.
//!
//! Units: positions and sizes are **physical pixels** of the client area
//! (what the table is drawn in, without the frame), the scale is the
//! window's monitor's in thousandths (1000 = 100 % = 96 dpi on Windows,
//! 2000 = Retina). No floating point (the workspace's lints).
//!
//! `unsafe` stays `deny` here (the crate's level) rather than `forbid`: a
//! `forbid` would bind [`windows`], whose Win32 wrappers allow it one
//! function at a time. Every other module below forbids it.

use std::fmt;

use rail_config::stats::Tone;

use crate::compliance::Permit;
use crate::layout::{Positions, TableLayout};
use crate::panel::StatCell;

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
    /// app for the popup of the player at that slot.
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
}

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
    /// Panels the user placed, by slot (this room and table size).
    pub positions: Positions,
    /// The last [`TableEvent::PanelMoved`] (`seq`) the engine took in.
    pub drags_seen: u64,
}

/// What an overlay shows (R3.4): the data; `crate::scene::compose` lays it
/// out under the permit's restrictions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayFrame {
    /// Compliance mode's yes for the window's room: no frame exists for a
    /// room without a HUD.
    pub permit: Permit,
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
}

impl OverlayFrame {
    /// A frame with a status line and no panels.
    pub fn status(permit: Permit, size: Option<u32>, status: impl Into<String>) -> Self {
        Self {
            permit,
            status: Some(status.into()),
            debug: None,
            size,
            seating: Seating::default(),
            panels: Vec::new(),
            legend: Vec::new(),
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

/// Why a backend call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    /// Not implemented on this backend yet.
    Unsupported(&'static str),
    /// The window is gone.
    Gone(WindowId),
    /// The system said no (a permission, a handle).
    Os(String),
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(what) => write!(f, "not supported here: {what}"),
            Self::Gone(id) => write!(f, "window {} is gone", id.0),
            Self::Os(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for PlatformError {}

/// A windowing backend. Called from the HUD's one loop thread only (macOS
/// overlays must be made on the main thread), so it need not be `Send`.
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
}

/// This system's backend.
pub fn native() -> Box<dyn Platform> {
    if cfg!(windows) {
        Box::new(windows::WindowsBackend::default())
    } else if cfg!(target_os = "macos") {
        Box::new(macos::MacosBackend)
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

    /// The stubs find nothing, so nothing is ever drawn by them. Windows'
    /// backend finds what matches (nothing, with no matcher) and, on
    /// Windows, follows a window it is given (R3.5 adds the hooks); its
    /// overlays are `tests/windows_overlay.rs`'s (a window id that is no
    /// window is refused).
    #[test]
    fn the_stub_backends_find_nothing() {
        for mut backend in [
            Box::new(windows::WindowsBackend::default()) as Box<dyn Platform>,
            Box::new(macos::MacosBackend),
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
            let tracks = cfg!(windows) && backend.name() == "windows";
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
        }
    }
}
