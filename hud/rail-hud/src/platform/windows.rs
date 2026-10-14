//! Windows (R3.3 - R3.5), a stub until then: it finds no tables.
//!
//! - R3.3 `find_tables`: `EnumWindows` + `GetWindowTextW` + the owning
//!   process (`GetWindowThreadProcessId`, `QueryFullProcessImageNameW`);
//!   the title through the room's [`super::TableMatcher`]; the client rect
//!   with `GetClientRect` + `ClientToScreen` in physical pixels (the
//!   process is per-monitor DPI aware v2), the scale from
//!   `GetDpiForWindow` (96 = 1000).
//! - R3.4 `overlay`: one layered, tool, no-activate window per table,
//!   owned by the table window.
//! - R3.5 `track` / `poll_events`: `SetWinEventHook` (location change,
//!   minimise start/end, name change, destroy) on the room's process, its
//!   callback queueing [`super::TableEvent`]s that `poll_events` drains.
//!
//! The Win32 calls need `unsafe`: that module, and only it, will lift the
//! crate's `forbid(unsafe_code)` (a `deny` there with each block justified).

use super::{
    OverlayFrame, Platform, PlatformError, TableEvent, TableMatcher, TableWindow, WindowId,
};

#[derive(Debug, Default)]
pub struct WindowsBackend;

impl Platform for WindowsBackend {
    fn name(&self) -> &'static str {
        "windows"
    }

    fn find_tables(&mut self, _: &[TableMatcher]) -> Result<Vec<TableWindow>, PlatformError> {
        Ok(Vec::new())
    }

    fn track(&mut self, _: &TableWindow) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("tracking windows (R3.5)"))
    }

    fn untrack(&mut self, _: WindowId) {}

    fn poll_events(&mut self) -> Vec<TableEvent> {
        Vec::new()
    }

    fn overlay(&mut self, _: WindowId, _: &OverlayFrame) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("overlays (R3.4)"))
    }

    fn remove_overlay(&mut self, _: WindowId) {}
}
