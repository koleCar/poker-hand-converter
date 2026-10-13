//! The tray (Windows notification area, macOS menu bar) icon and its menu.
//!
//! The menu's first two lines are disabled. The status line says what the
//! watcher (R1.3) is doing ("Watching 2 folders · 37 hands today", "Import
//! paused"), set through [`set_status`] by `watch::refresh_tray`; the account
//! line under it (R1.7: "Signed in as ...", "Not signed in") through
//! [`set_account`] by `account::refresh_tray`. "Pause import" pauses
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
const OPEN: &str = "open";
const PAUSE_IMPORT: &str = "pause-import";
const QUIT: &str = "quit";

/// The menu items other code changes, kept as app state.
pub struct TrayMenu<R: Runtime> {
    status: MenuItem<R>,
    account: MenuItem<R>,
    pause_import: MenuItem<R>,
}

// `MenuItem<R>` is `Debug` only for the default runtime.
impl<R: Runtime> std::fmt::Debug for TrayMenu<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrayMenu")
            .field("status", self.status.id())
            .field("account", self.account.id())
            .field("pause_import", self.pause_import.id())
            .finish()
    }
}

/// Create the tray icon. Called once, from `setup`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let text = strings::tray();
    let status = MenuItem::with_id(app, STATUS, text.status_idle, false, None::<&str>)?;
    // The account (R1.7), set by `account::refresh_tray`.
    let account = MenuItem::with_id(app, ACCOUNT, text.account_signed_out, false, None::<&str>)?;
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
        pause_import,
    });
    Ok(())
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
