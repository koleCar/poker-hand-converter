//! The few user-facing strings the Rust side shows itself: the tray icon's
//! tooltip and menu. Everything in the window comes from the web side's
//! dictionaries (`app/src/i18n/`); these mirror its `tray` keys, and the two
//! are kept in step by hand until there is a locale setting to pick between
//! them (Croatian is prepared, not yet selectable).

/// The tray icon's strings.
#[derive(Debug, Clone, Copy)]
pub struct Tray {
    pub tooltip: &'static str,
    /// The first, disabled line of the menu: what Rail is doing.
    pub status_idle: &'static str,
    pub open: &'static str,
    pub pause_import: &'static str,
    pub quit: &'static str,
}

pub const TRAY_EN: Tray = Tray {
    tooltip: "Rail",
    status_idle: "No folders watched yet",
    open: "Open Rail",
    pause_import: "Pause import",
    quit: "Quit Rail",
};

pub const TRAY_HR: Tray = Tray {
    tooltip: "Rail",
    status_idle: "Još se ne prate mape",
    open: "Otvori Rail",
    pause_import: "Pauziraj uvoz",
    quit: "Zatvori Rail",
};

/// The strings in use. English until a locale setting exists.
pub const fn tray() -> &'static Tray {
    &TRAY_EN
}
