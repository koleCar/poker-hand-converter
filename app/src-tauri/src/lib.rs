//! Rail desktop: the Tauri 2 shell (docs/RAIL-PLAN.md R1.1).
//!
//! What the shell does today:
//!
//! - one instance only: a second launch focuses the first one's window
//!   (`tauri-plugin-single-instance`, registered first, as it must be);
//! - a tray icon with a status menu ([`tray`]); closing the window hides it,
//!   Rail keeps running in the tray and "Quit Rail" ends it;
//! - optional start at login (`tauri-plugin-autostart`), off by default, a
//!   setting; a login start passes [`MINIMIZED_ARG`] and stays in the tray;
//! - log files in the OS log directory, rotated (`tauri-plugin-log`), and
//!   panics logged there too;
//! - crash-safe settings ([`settings`]);
//! - the local store (`rail-store`, R1.2), opened in `setup` under the app's
//!   local data directory and managed as [`commands::StoreState`]; the Today
//!   screen shows its counts (`store_status`);
//! - the watcher (`rail-watch`, R1.3), started right after the store and
//!   managed as [`watch::WatcherState`]: it reads the folders in the store's
//!   `sources` into the store, reports in the tray's status line, and is
//!   paused and resumed from the tray; the Today screen shows its folders
//!   (`watcher_status`). It is stopped on exit before anything else, since
//!   the store waits for the watcher's handles on its writer.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

pub mod commands;
#[cfg(debug_assertions)]
pub mod dev;
pub mod settings;
pub mod strings;
pub mod tray;
pub mod watch;

/// The main window's label (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Passed by the login item: start in the tray, window hidden.
pub const MINIMIZED_ARG: &str = "--minimized";

/// Show, unminimise and focus the main window.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("no main window to show");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn log_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .targets([
            // `rail.log` in the OS log directory: ~/Library/Logs/<identifier>
            // on macOS, %LOCALAPPDATA%\<identifier>\logs on Windows.
            Target::new(TargetKind::LogDir {
                file_name: Some("rail".into()),
            }),
            Target::new(TargetKind::Stdout),
        ])
        // At 5 MB the file is renamed with its date and a new one started;
        // the five newest are kept.
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .level(log::LevelFilter::Info)
        .level_for(
            "rail_app",
            if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            },
        )
        .build()
}

/// Panics go to the log file as well as stderr: a user's report then has
/// them.
fn log_panics() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default_hook(info);
    }));
}

fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    log_panics();
    log::info!(
        "Rail {} starting ({}, {})",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );

    let settings_path = app.path().app_config_dir()?.join(settings::FILE_NAME);
    let (store, loaded) = settings::Store::load(settings_path);
    match &loaded {
        settings::Loaded::Ok | settings::Loaded::Missing => {}
        other => log::warn!("settings at {}: {other:?}", store.path().display()),
    }
    let start_at_login = store.get().start_at_login;
    app.manage(commands::SettingsState(Mutex::new(store)));

    // The local store (R1.2): hands, quarantine, registry, outbox. In the
    // data directory, not the config one (which holds settings.json only),
    // and the *local* one: on Windows `app_data_dir` is the roaming profile
    // (%APPDATA%), which a domain may copy at every logon - no place for a
    // database of gigabytes; `app_local_data_dir` is %LOCALAPPDATA%. On
    // macOS the two are the same folder.
    // A store that does not open is logged and reported by `store_status`;
    // the shell still starts, so the user sees why.
    let store_path = app.path().app_local_data_dir()?.join(rail_store::FILE_NAME);
    let store = commands::StoreState::open(store_path);

    // The watcher (R1.3), after the store: it commits through the store's
    // writer. Without a store it does not start; the tray and the Today
    // screen say so.
    let watcher = watch::WatcherState::start(&store);
    app.manage(store);
    app.manage(watcher);

    commands::reconcile_login_item(app, start_at_login);
    tray::build(app)?;
    if let Some(watcher) = app.try_state::<watch::WatcherState>() {
        watch::refresh_tray(app, &watcher);
    }
    watch::spawn_tray_refresher(app);

    // The window is created hidden (`visible: false`) so a login start can
    // stay in the tray.
    if std::env::args().any(|arg| arg == MINIMIZED_ARG) {
        log::info!("started at login: window stays hidden");
    } else {
        show_main_window(app);
    }
    Ok(())
}

/// Build and run the app. Returns when the app exits.
pub fn run() {
    let builder = tauri::Builder::default()
        // Must be the first plugin: a second instance exits inside it,
        // before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!("second instance started: focusing this one");
            show_main_window(app);
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_ARG]),
        ));

    #[cfg(debug_assertions)]
    let builder =
        builder
            .plugin(tauri_plugin_dialog::init())
            .invoke_handler(tauri::generate_handler![
                commands::core_info,
                commands::app_info,
                commands::get_settings,
                commands::set_theme,
                commands::set_start_at_login,
                commands::store_status,
                watch::watcher_status,
                watch::set_import_paused,
                dev::dev_pick_file,
                dev::convert_file,
                dev::dev_add_folder,
            ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::core_info,
        commands::app_info,
        commands::get_settings,
        commands::set_theme,
        commands::set_start_at_login,
        commands::store_status,
        watch::watcher_status,
        watch::set_import_paused,
    ]);

    let app = builder
        .setup(|app| setup(app.handle()))
        .on_window_event(|window, event| {
            // Closing the window hides it; Rail keeps watching from the
            // tray. "Quit Rail" in the tray menu (or Cmd+Q) ends it.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == MAIN_WINDOW
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("the Tauri app could not be built");

    app.run(|app, event| match event {
        // The watcher first: the store waits for its writer handles.
        tauri::RunEvent::Exit => {
            if let Some(watcher) = app.try_state::<watch::WatcherState>() {
                watcher.stop();
            }
        }
        // macOS: a click on the Dock icon while the window is hidden.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    });
}
