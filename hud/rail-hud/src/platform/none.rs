//! Systems without a HUD (Linux: not shipped, built in CI): no tables, ever.

use super::{
    OverlayFrame, Platform, PlatformError, TableEvent, TableMatcher, TableWindow, WindowId,
};

#[derive(Debug, Default)]
pub struct NoBackend;

impl Platform for NoBackend {
    fn name(&self) -> &'static str {
        "none"
    }

    fn find_tables(&mut self, _: &[TableMatcher]) -> Result<Vec<TableWindow>, PlatformError> {
        Ok(Vec::new())
    }

    fn track(&mut self, _: &TableWindow) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("no HUD on this system"))
    }

    fn untrack(&mut self, _: WindowId) {}

    fn poll_events(&mut self) -> Vec<TableEvent> {
        Vec::new()
    }

    fn overlay(&mut self, _: WindowId, _: &OverlayFrame) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("no HUD on this system"))
    }

    fn remove_overlay(&mut self, _: WindowId) {}
}
