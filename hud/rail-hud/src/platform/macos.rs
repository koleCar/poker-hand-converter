//! macOS (R3.11 - R3.13), a stub until then: it finds no tables.
//!
//! - R3.11 `find_tables`: the Accessibility API per poker process
//!   (`AXUIElementCreateApplication`, `kAXWindowsAttribute`, `AXTitle`) for
//!   titles - the Accessibility permission only; bounds and order from
//!   `CGWindowListCopyWindowInfo` (its window names would need Screen
//!   Recording, so they are not used). Points times the backing scale =
//!   physical pixels; the scale from the window's screen (2000 on Retina).
//! - R3.12 `overlay`: a borderless, transparent, non-activating `NSPanel`
//!   per table ordered above it - AppKit wants the main thread, which is
//!   why [`super::Platform`] is driven from the HUD's one loop thread; that
//!   loop will run inside the AppKit run loop then.
//! - R3.13 `track` / `poll_events`: an `AXObserver` per process (moved,
//!   resized, miniaturised, destroyed, title changed), `CGWindowList`
//!   polling as the fallback.

use super::{
    OverlayFrame, Platform, PlatformError, TableEvent, TableMatcher, TableWindow, WindowId,
};

#[derive(Debug, Default)]
pub struct MacosBackend;

impl Platform for MacosBackend {
    fn name(&self) -> &'static str {
        "macos"
    }

    fn find_tables(&mut self, _: &[TableMatcher]) -> Result<Vec<TableWindow>, PlatformError> {
        Ok(Vec::new())
    }

    fn track(&mut self, _: &TableWindow) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("tracking windows (R3.13)"))
    }

    fn untrack(&mut self, _: WindowId) {}

    fn poll_events(&mut self) -> Vec<TableEvent> {
        Vec::new()
    }

    fn overlay(&mut self, _: WindowId, _: &OverlayFrame) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("overlays (R3.12)"))
    }

    fn remove_overlay(&mut self, _: WindowId) {}
}
