//! The one platform trait (docs/RAIL-PLAN.md §3.1, R3.2): finding table
//! windows, following them, drawing over them. Windows finds tables since
//! R3.3 ([`windows`]; following and drawing are R3.4 - R3.5); macOS
//! (R3.11 - R3.13) is a stub that finds nothing. [`sim::SimBackend`] is a
//! fake driven by the table simulator's events (R3.1), so the data path
//! runs end to end without any window API, on every OS and in CI.
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

pub mod macos;
pub mod matcher;
pub mod none;
pub mod sim;
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
            scale_permille: dpi_permille(if window.monitor_dpi == 0 {
                window.window_dpi
            } else {
                window.monitor_dpi
            }),
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
}

/// What an overlay shows. The panels' look is R3.8; this is the data.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OverlayFrame {
    /// A line instead of panels: "waiting for first hand", "no store".
    pub status: Option<String>,
    pub panels: Vec<SeatPanel>,
}

/// One player's panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatPanel {
    pub player: String,
    /// Hands the player's rollups count.
    pub hands: i64,
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

    /// What happened to the tracked windows since the last call; never
    /// blocks.
    fn poll_events(&mut self) -> Vec<TableEvent>;

    /// Show `frame` over the window (creating its overlay on first use):
    /// above the table, below other windows, never taking focus.
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
    /// Windows, follows a window it is given (R3.5 adds the hooks); it
    /// draws nothing yet (R3.4).
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
            assert!(matches!(
                backend.overlay(WindowId(1), &OverlayFrame::default()),
                Err(PlatformError::Unsupported(_))
            ));
        }
    }
}
