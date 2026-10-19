//! The few user-facing strings the Rust side shows itself: the tray icon's
//! tooltip and menu. Everything in the window comes from the web side's
//! dictionaries (`app/src/i18n/`); these mirror its `tray` keys, and the two
//! are kept in step by hand. The language is the settings' `locale` (R2.8):
//! set at start and by `set_locale`, which relabels the tray at once.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::settings::Locale;

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
    /// The status line while old hands are imported (R1.6): percent of the
    /// bytes, hands so far.
    pub status_importing: fn(u64, u64) -> String,
    /// The account line (R1.7): signed in, with the email.
    pub account_signed_in: fn(&str) -> String,
    /// Signed in, but the last refresh did not reach the server.
    pub account_offline: fn(&str) -> String,
    pub account_signing_in: &'static str,
    pub account_signed_out: &'static str,
    /// A build without Supabase: no account at all.
    pub account_offline_only: &'static str,
    /// The sync line (R1.9): no sync in this build (or no store).
    pub sync_off: &'static str,
    pub sync_starting: &'static str,
    /// Not signed in: hands stay here.
    pub sync_signed_out: &'static str,
    pub sync_paused: &'static str,
    /// Signed in as another account: the window asks.
    pub sync_question: &'static str,
    /// The user kept this computer's hands apart from the signed-in account.
    pub sync_declined: &'static str,
    /// Sending: hands sent of hands to send.
    pub sync_syncing: fn(u64, u64) -> String,
    pub sync_up_to_date: &'static str,
    /// Offline: hands waiting.
    pub sync_offline: fn(u64) -> String,
    pub sync_rate_limited: &'static str,
    pub sync_failed: &'static str,
    /// (R3.10) The HUD line: the HUD process is not running.
    pub hud_off: &'static str,
    /// Starting, or starting again.
    pub hud_starting: &'static str,
    /// Running: tables attached, windows refused by compliance mode.
    pub hud_tables: fn(u32, u32) -> String,
    /// (R3.11) Running, but it cannot see tables until the user grants the
    /// Accessibility permission (macOS).
    pub hud_permission: &'static str,
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

fn importing_en(percent: u64, hands: u64) -> String {
    if hands == 1 {
        format!("Importing {percent}% · 1 hand")
    } else {
        format!("Importing {percent}% · {hands} hands")
    }
}

fn importing_hr(percent: u64, hands: u64) -> String {
    format!("Uvoz {percent} % · ruke: {hands}")
}

fn signed_in_en(email: &str) -> String {
    format!("Signed in as {email}")
}

fn offline_en(email: &str) -> String {
    format!("{email} · offline")
}

fn signed_in_hr(email: &str) -> String {
    format!("Prijavljen: {email}")
}

fn offline_hr(email: &str) -> String {
    format!("{email} · izvan mreže")
}

fn syncing_en(sent: u64, total: u64) -> String {
    format!("Syncing {sent} of {total} hands")
}

fn syncing_hr(sent: u64, total: u64) -> String {
    format!("Sinkronizacija: {sent} od {total} ruku")
}

fn sync_offline_en(waiting: u64) -> String {
    if waiting == 1 {
        "Offline · 1 hand waits to sync".to_owned()
    } else {
        format!("Offline · {waiting} hands wait to sync")
    }
}

fn sync_offline_hr(waiting: u64) -> String {
    format!("Izvan mreže · ruke koje čekaju: {waiting}")
}

fn hud_tables_en(attached: u32, refused: u32) -> String {
    let tables = match attached {
        0 => "HUD: no table open".to_owned(),
        1 => "HUD: 1 table".to_owned(),
        n => format!("HUD: {n} tables"),
    };
    if refused == 0 {
        tables
    } else {
        format!("{tables} · {refused} not allowed")
    }
}

fn hud_tables_hr(attached: u32, refused: u32) -> String {
    let tables = if attached == 0 {
        "HUD: nema otvorenog stola".to_owned()
    } else {
        format!("HUD: stolovi: {attached}")
    };
    if refused == 0 {
        tables
    } else {
        format!("{tables} · nije dopušteno: {refused}")
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
    status_importing: importing_en,
    account_signed_in: signed_in_en,
    account_offline: offline_en,
    account_signing_in: "Signing in in your browser…",
    account_signed_out: "Not signed in",
    account_offline_only: "Working offline",
    sync_off: "Sync off",
    sync_starting: "Sync starting…",
    sync_signed_out: "Sync: sign in to sync",
    sync_paused: "Sync paused",
    sync_question: "Sync waits for your answer",
    sync_declined: "Not syncing with this account",
    sync_syncing: syncing_en,
    sync_up_to_date: "Synced: up to date",
    sync_offline: sync_offline_en,
    sync_rate_limited: "Sync waits: the account's limit for now",
    sync_failed: "Sync problem: see Settings",
    hud_off: "HUD off",
    hud_starting: "HUD starting…",
    hud_tables: hud_tables_en,
    hud_permission: "HUD: needs the Accessibility permission",
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
    status_importing: importing_hr,
    account_signed_in: signed_in_hr,
    account_offline: offline_hr,
    account_signing_in: "Prijava u pregledniku…",
    account_signed_out: "Nema prijave",
    account_offline_only: "Rad bez mreže",
    sync_off: "Sinkronizacija isključena",
    sync_starting: "Sinkronizacija se pokreće…",
    sync_signed_out: "Sinkronizacija: prijavi se",
    sync_paused: "Sinkronizacija pauzirana",
    sync_question: "Sinkronizacija čeka tvoj odgovor",
    sync_declined: "Bez sinkronizacije s ovim računom",
    sync_syncing: syncing_hr,
    sync_up_to_date: "Sinkronizirano",
    sync_offline: sync_offline_hr,
    sync_rate_limited: "Sinkronizacija čeka: ograničenje računa",
    sync_failed: "Problem sa sinkronizacijom: vidi Postavke",
    hud_off: "HUD isključen",
    hud_starting: "HUD se pokreće…",
    hud_tables: hud_tables_hr,
    hud_permission: "HUD: treba dopuštenje Pristupačnost",
    open: "Otvori Rail",
    pause_import: "Pauziraj uvoz",
    resume_import: "Nastavi uvoz",
    quit: "Zatvori Rail",
};

/// Croatian chosen (`settings.locale`); English otherwise.
static CROATIAN: AtomicBool = AtomicBool::new(false);

/// Choose the tray's language. The callers relabel what is already drawn.
pub fn set_locale(locale: Locale) {
    CROATIAN.store(locale == Locale::Hr, Ordering::Relaxed);
}

/// The strings in one language.
pub const fn tray_in(locale: Locale) -> &'static Tray {
    match locale {
        Locale::En => &TRAY_EN,
        Locale::Hr => &TRAY_HR,
    }
}

/// The strings in use: the settings' language.
pub fn tray() -> &'static Tray {
    tray_in(if CROATIAN.load(Ordering::Relaxed) {
        Locale::Hr
    } else {
        Locale::En
    })
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
        assert_eq!(
            (TRAY_EN.status_importing)(37, 12_345),
            "Importing 37% · 12345 hands"
        );
        assert_eq!((TRAY_HR.status_importing)(37, 5), "Uvoz 37 % · ruke: 5");
        assert_eq!(
            (TRAY_EN.account_signed_in)("p@example.test"),
            "Signed in as p@example.test"
        );
        assert_eq!(
            (TRAY_EN.account_offline)("p@example.test"),
            "p@example.test · offline"
        );
        assert_eq!((TRAY_EN.sync_syncing)(1, 2), "Syncing 1 of 2 hands");
        assert_eq!((TRAY_EN.sync_offline)(1), "Offline · 1 hand waits to sync");
        assert_eq!((TRAY_HR.sync_syncing)(1, 2), "Sinkronizacija: 1 od 2 ruku");
        assert_eq!((TRAY_EN.hud_tables)(0, 0), "HUD: no table open");
        assert_eq!((TRAY_EN.hud_tables)(1, 0), "HUD: 1 table");
        assert_eq!((TRAY_EN.hud_tables)(2, 1), "HUD: 2 tables · 1 not allowed");
        assert_eq!(
            (TRAY_HR.hud_tables)(0, 2),
            "HUD: nema otvorenog stola · nije dopušteno: 2"
        );
    }

    #[test]
    fn the_locale_picks_the_strings() {
        // `tray()` itself reads a global the other tests leave at English;
        // the choice it makes is this one.
        assert_eq!(tray_in(Locale::Hr).quit, "Zatvori Rail");
        assert_eq!(tray_in(Locale::En).quit, "Quit Rail");
        assert_eq!(tray().quit, "Quit Rail");
    }
}
