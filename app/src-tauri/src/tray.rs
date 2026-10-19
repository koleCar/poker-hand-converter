//! The tray (Windows notification area, macOS menu bar) icon and its menu.
//!
//! The menu's first four lines are disabled. The status line says what the
//! watcher (R1.3) is doing ("Watching 2 folders · 37 hands today", "Import
//! paused"), set through [`set_status`] by `watch::refresh_tray`; the account
//! line under it (R1.7: "Signed in as ...", "Not signed in") through
//! [`set_account`] by `account::refresh_tray`; the sync line (R1.9: "Syncing
//! 120 of 4 000 hands", "Synced: up to date") through [`set_sync`] by
//! `sync::refresh_tray`; the HUD line (R3.10: "HUD: 2 tables", "HUD: 1
//! table · 1 not allowed", "HUD off") through [`set_hud`] by
//! `hud::refresh_tray`. "Pause import" pauses
//! and resumes the watcher (its text follows, [`set_pause_text`]); it is
//! enabled when there is something to pause.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::strings;

/// The tray icon's id.
pub const TRAY_ID: &str = "rail";

const STATUS: &str = "status";
const ACCOUNT: &str = "account";
const SYNC: &str = "sync";
const HUD: &str = "hud";
const OPEN: &str = "open";
const PAUSE_IMPORT: &str = "pause-import";
const QUIT: &str = "quit";

/// The menu items other code changes, kept as app state.
pub struct TrayMenu<R: Runtime> {
    status: MenuItem<R>,
    account: MenuItem<R>,
    sync: MenuItem<R>,
    hud: MenuItem<R>,
    open: MenuItem<R>,
    pause_import: MenuItem<R>,
    quit: MenuItem<R>,
}

// `MenuItem<R>` is `Debug` only for the default runtime.
impl<R: Runtime> std::fmt::Debug for TrayMenu<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrayMenu")
            .field("status", self.status.id())
            .field("account", self.account.id())
            .field("sync", self.sync.id())
            .field("hud", self.hud.id())
            .field("open", self.open.id())
            .field("pause_import", self.pause_import.id())
            .field("quit", self.quit.id())
            .finish()
    }
}

/// Create the tray icon. Called once, from `setup`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let text = strings::tray();
    let status = MenuItem::with_id(app, STATUS, text.status_idle, false, None::<&str>)?;
    // The account (R1.7), set by `account::refresh_tray`.
    let account = MenuItem::with_id(app, ACCOUNT, text.account_signed_out, false, None::<&str>)?;
    // Sync (R1.9), set by `sync::refresh_tray`.
    let sync = MenuItem::with_id(app, SYNC, text.sync_off, false, None::<&str>)?;
    // The HUD (R3.10), set by `hud::refresh_tray`.
    let hud = MenuItem::with_id(app, HUD, text.hud_starting, false, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN, text.open, true, None::<&str>)?;
    // Enabled once the watcher runs with a folder (`watch::refresh_tray`).
    let pause_import =
        MenuItem::with_id(app, PAUSE_IMPORT, text.pause_import, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, text.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &account,
            &sync,
            &hud,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &pause_import,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(text.tooltip)
        .menu(&menu)
        // macOS convention: a click on a menu-bar item opens its menu.
        // Windows convention: a left click opens the app, a right click the
        // menu.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => crate::show_main_window(app),
            PAUSE_IMPORT => crate::watch::toggle_pause(app),
            QUIT => {
                log::info!("quit from the tray");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(not(target_os = "macos"))
                && matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                )
            {
                crate::show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    app.manage(TrayMenu {
        status,
        account,
        sync,
        hud,
        open,
        pause_import,
        quit,
    });
    Ok(())
}

/// Every line in the language just chosen (R2.8, `commands::set_locale`):
/// the fixed items and the tooltip here, the status (with "Pause import"),
/// account and sync lines by their own refreshers.
pub fn relabel<R: Runtime>(app: &AppHandle<R>) {
    let text = strings::tray();
    if let Some(menu) = app.try_state::<TrayMenu<R>>() {
        for (item, label) in [(&menu.open, text.open), (&menu.quit, text.quit)] {
            if let Err(error) = item.set_text(label) {
                log::debug!("tray relabel: {error}");
            }
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID)
        && let Err(error) = tray.set_tooltip(Some(text.tooltip))
    {
        log::debug!("tray tooltip: {error}");
    }
    if let Some(watcher) = app.try_state::<crate::watch::WatcherState>() {
        crate::watch::refresh_tray(app, &watcher);
    }
    crate::account::refresh_tray(app);
    crate::sync::refresh_tray(app);
    crate::hud::refresh_tray(app);
}

/// Replace the status line (R1.3 / R1.6: "Watching 3 folders", "Importing
/// 1 204 hands").
pub fn set_status<R: Runtime>(app: &AppHandle<R>, text: &str) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.status.set_text(text),
        None => Ok(()),
    }
}

/// Replace the account line (R1.7): "Signed in as ...", "Not signed in".
pub fn set_account<R: Runtime>(app: &AppHandle<R>, text: &str) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.account.set_text(text),
        None => Ok(()),
    }
}

/// Replace the sync line (R1.9).
pub fn set_sync<R: Runtime>(app: &AppHandle<R>, text: &str) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.sync.set_text(text),
        None => Ok(()),
    }
}

/// Replace the HUD line (R3.10).
pub fn set_hud<R: Runtime>(app: &AppHandle<R>, text: &str) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.hud.set_text(text),
        None => Ok(()),
    }
}

/// "Pause import" or "Resume import".
pub fn set_pause_text<R: Runtime>(app: &AppHandle<R>, text: &str) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.pause_import.set_text(text),
        None => Ok(()),
    }
}

/// Enable or disable "Pause import".
pub fn set_pause_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.pause_import.set_enabled(enabled),
        None => Ok(()),
    }
}
