//! The tray (Windows notification area, macOS menu bar) icon and its menu.
//!
//! The menu's first line is a disabled status line. Today it only ever says
//! that no folder is watched; the watcher (R1.3) and the import pipeline
//! (R1.6) report through [`set_status`], and "Pause import" is enabled when
//! there is an import to pause.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::strings;

/// The tray icon's id.
pub const TRAY_ID: &str = "rail";

const STATUS: &str = "status";
const OPEN: &str = "open";
const PAUSE_IMPORT: &str = "pause-import";
const QUIT: &str = "quit";

/// The menu items other code changes, kept as app state.
pub struct TrayMenu<R: Runtime> {
    status: MenuItem<R>,
    pause_import: MenuItem<R>,
}

// `MenuItem<R>` is `Debug` only for the default runtime.
impl<R: Runtime> std::fmt::Debug for TrayMenu<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrayMenu")
            .field("status", self.status.id())
            .field("pause_import", self.pause_import.id())
            .finish()
    }
}

/// Create the tray icon. Called once, from `setup`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let text = strings::tray();
    let status = MenuItem::with_id(app, STATUS, text.status_idle, false, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN, text.open, true, None::<&str>)?;
    // A placeholder until there is an import to pause (R1.3 / R1.6).
    let pause_import =
        MenuItem::with_id(app, PAUSE_IMPORT, text.pause_import, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, text.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
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

/// Enable or disable "Pause import" (R1.6 enables it while importing).
pub fn set_pause_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> tauri::Result<()> {
    match app.try_state::<TrayMenu<R>>() {
        Some(menu) => menu.pause_import.set_enabled(enabled),
        None => Ok(()),
    }
}
