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
    /// The status line while folders are watched: folders, hands today.
    pub status_watching: fn(usize, u64) -> String,
    /// The status line while import is paused.
    pub status_paused: &'static str,
    /// The status line when folders cannot be read: how many.
    pub status_unavailable: fn(usize) -> String,
    /// The status line when the store or the watcher did not start.
    pub status_error: &'static str,
    pub open: &'static str,
    pub pause_import: &'static str,
    pub resume_import: &'static str,
    pub quit: &'static str,
}

fn watching_en(folders: usize, hands_today: u64) -> String {
    let folders = if folders == 1 {
        "1 folder".to_owned()
    } else {
        format!("{folders} folders")
    };
    let hands = if hands_today == 1 {
        "1 hand today".to_owned()
    } else {
        format!("{hands_today} hands today")
    };
    format!("Watching {folders} · {hands}")
}

fn unavailable_en(folders: usize) -> String {
    if folders == 1 {
        "1 folder cannot be read".to_owned()
    } else {
        format!("{folders} folders cannot be read")
    }
}

fn watching_hr(folders: usize, hands_today: u64) -> String {
    format!("Mape: {folders} · ruke danas: {hands_today}")
}

fn unavailable_hr(folders: usize) -> String {
    format!("Mape koje se ne mogu čitati: {folders}")
}

pub const TRAY_EN: Tray = Tray {
    tooltip: "Rail",
    status_idle: "No folders watched yet",
    status_watching: watching_en,
    status_paused: "Import paused",
    status_unavailable: unavailable_en,
    status_error: "Import is not running",
    open: "Open Rail",
    pause_import: "Pause import",
    resume_import: "Resume import",
    quit: "Quit Rail",
};

pub const TRAY_HR: Tray = Tray {
    tooltip: "Rail",
    status_idle: "Još se ne prate mape",
    status_watching: watching_hr,
    status_paused: "Uvoz je pauziran",
    status_unavailable: unavailable_hr,
    status_error: "Uvoz nije pokrenut",
    open: "Otvori Rail",
    pause_import: "Pauziraj uvoz",
    resume_import: "Nastavi uvoz",
    quit: "Zatvori Rail",
};

/// The strings in use. English until a locale setting exists.
pub const fn tray() -> &'static Tray {
    &TRAY_EN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines_read_well() {
        assert_eq!(
            (TRAY_EN.status_watching)(1, 1),
            "Watching 1 folder · 1 hand today"
        );
        assert_eq!(
            (TRAY_EN.status_watching)(3, 1204),
            "Watching 3 folders · 1204 hands today"
        );
        assert_eq!((TRAY_EN.status_unavailable)(2), "2 folders cannot be read");
        assert_eq!((TRAY_HR.status_watching)(2, 5), "Mape: 2 · ruke danas: 5");
    }
}
