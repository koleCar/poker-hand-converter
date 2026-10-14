//! The one platform trait (docs/RAIL-PLAN.md §3.1, R3.2): finding table
//! windows, following them, drawing over them. Windows (R3.3 - R3.5) and
//! macOS (R3.11 - R3.13) implement it; until then their backends are stubs
//! that find nothing. [`sim::SimBackend`] is a fake driven by the table
//! simulator's events (R3.1), so the data path runs end to end without any
//! window API, on every OS and in CI.
//!
//! Units: positions and sizes are **physical pixels** of the client area
//! (what the table is drawn in, without the frame), the scale is the
//! window's monitor's in thousandths (1000 = 100 % = 96 dpi on Windows,
//! 2000 = Retina). No floating point (the workspace's lints).

use std::fmt;

use regex::Regex;

pub mod macos;
pub mod none;
pub mod sim;
pub mod windows;

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
    /// The title's `table` group: the table name the room's hands carry
    /// (`Table 'Hygiea IV 40-100 bb'`), how a hand is matched to its window.
    pub table: Option<String>,
    /// Seats, when the backend knows (R3.6 reads it from the title or the
    /// layout; the simulator says).
    pub size: Option<u32>,
    /// The client area, physical pixels.
    pub client: Rect,
    /// The monitor's scale in thousandths.
    pub scale_permille: u32,
    pub minimized: bool,
}

/// How a room's tables are recognised: its processes and a title pattern
/// with a `table` group (`sites.json` `tables`, R3.3 / R3.11).
#[derive(Debug, Clone)]
pub struct TableMatcher {
    pub site: String,
    /// Executable names, compared without case.
    pub processes: Vec<String>,
    pub title: Regex,
}

impl TableMatcher {
    /// `Some(table group)` when a window of `process` titled `title` is one
    /// of this room's tables.
    pub fn matches(&self, process: &str, title: &str) -> Option<Option<String>> {
        if !self
            .processes
            .iter()
            .any(|p| p.eq_ignore_ascii_case(process))
        {
            return None;
        }
        let caps = self.title.captures(title)?;
        Some(caps.name("table").map(|m| m.as_str().to_owned()))
    }
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
        Box::new(windows::WindowsBackend)
    } else if cfg!(target_os = "macos") {
        Box::new(macos::MacosBackend)
    } else {
        Box::new(none::NoBackend)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matcher_needs_the_process_and_the_title() {
        let matcher = TableMatcher {
            site: "pokerstars".into(),
            processes: vec!["PokerStars.exe".into()],
            title: Regex::new(r"^(?P<table>.+?) - \$").expect("regex"),
        };
        assert_eq!(
            matcher.matches("pokerstars.EXE", "Hygiea IV - $0.05/$0.10"),
            Some(Some("Hygiea IV".into()))
        );
        assert_eq!(matcher.matches("other.exe", "Hygiea IV - $0.05"), None);
        assert_eq!(matcher.matches("PokerStars.exe", "Lobby"), None);
    }

    /// The stubs find nothing, so nothing is ever drawn by them.
    #[test]
    fn the_stub_backends_find_nothing() {
        for mut backend in [
            Box::new(windows::WindowsBackend) as Box<dyn Platform>,
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
            assert!(matches!(
                backend.track(&window),
                Err(PlatformError::Unsupported(_))
            ));
            assert!(matches!(
                backend.overlay(WindowId(1), &OverlayFrame::default()),
                Err(PlatformError::Unsupported(_))
            ));
        }
    }
}
