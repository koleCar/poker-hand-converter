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
//!   the store waits for the watcher's handles on its writer;
//! - the first-run screen's commands ([`folders`], R1.4): discovery of the
//!   rooms' default folders, adding the confirmed ones ("import everything"
//!   or "only new hands"), and the system folder picker
//!   (`tauri-plugin-dialog`, called from Rust; no plugin API is exposed to
//!   the window);
//! - Settings, Folders ([`folder_settings`], R1.5): add a folder by hand,
//!   change its path or room, switch it on or off, recursive, poll only,
//!   remove it, and its refused hands with their reasons;
//! - the import pipeline's face (R1.6): backfill progress in the tray and
//!   the window (`watch::CHANGED_EVENT`), refused hands app-wide with their
//!   raw text and "Try again after an update" ([`quarantine`]);
//! - the account ([`account`], R1.7): sign-in through the system browser and
//!   a `rail://` callback (`tauri-plugin-deep-link`; a second process started
//!   by a link forwards it here through the single-instance plugin), the
//!   session's refresh token in the OS keychain, refreshed in the
//!   background, and its line in the tray;
//! - sync ([`sync`], R1.9): the worker that sends the outbox to Supabase and
//!   pulls the account's other hands, woken by imports and account changes,
//!   with its line in the tray and its controls in Settings → Account. It is
//!   stopped on exit with the watcher, before the store closes;
//! - the statistics pass ([`stats`], R2.3): rebuilds the local statistics
//!   after a stats version bump (or when asked from Settings) and computes
//!   the all-in EV of preflop all-ins in the background; woken by imports,
//!   paused while a backfill runs, stopped on exit with the watcher;
//! - the Hands screen ([`hands`], R2.7a): the list with its filters and
//!   counts, a hand's PHF for the replayer, notes, tags and saved filters;
//! - the HUD process ([`hud`], R3.2): the `rail-hud` sidecar, started and
//!   supervised (restarted with a backoff, health-checked), told of every
//!   import, stopped first on exit; while it is attached to tables the
//!   statistics pass and sync slow down.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

pub mod account;
pub mod commands;
pub mod custom_stats;
#[cfg(debug_assertions)]
pub mod dev;
pub mod folder_settings;
pub mod folders;
pub mod hands;
pub mod hud;
pub mod players;
pub mod quarantine;
pub mod reports;
pub mod settings;
pub mod stats;
pub mod strings;
pub mod sync;
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
    // The tray's words in the chosen language (R2.8), before it is built.
    strings::set_locale(store.get().locale);
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
    let sync_slot = sync::SyncSlot::default();
    // The statistics pass (R2.3), before the watcher: imports wake it and a
    // backfill pauses it.
    let stats = stats::StatsState::start(&store);
    // The HUD (R3.2), before the watcher: imports feed it.
    let hud = hud::HudState::start(
        app,
        &store,
        stats.clone(),
        std::sync::Arc::clone(&sync_slot),
    );
    let watcher = watch::WatcherState::start(
        &store,
        std::sync::Arc::clone(&sync_slot),
        stats.clone(),
        hud.feed(),
    );
    app.manage(hud);
    app.manage(stats);
    app.manage(store);
    // The custom statistics editor's preview hands (R2.10).
    app.manage(custom_stats::CustomState::default());
    app.manage(watcher);

    commands::reconcile_login_item(app, start_at_login);
    tray::build(app)?;
    if let Some(watcher) = app.try_state::<watch::WatcherState>() {
        watch::refresh_tray(app, &watcher);
    }
    watch::spawn_tray_refresher(app);

    // The account (R1.7): after the tray (it sets the account line), and
    // before the window shows, so a link that started the app is handled.
    account::setup(app);
    // Sync (R1.9): after the store and the account it uses.
    sync::setup(app, &sync_slot);
    if let Some(hud) = app.try_state::<hud::HudState>() {
        hud.sync_started();
    }
    // A recompute's swap tells the window (R2.11).
    stats::spawn_refresher(app);

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
        // before anything else starts. With its `deep-link` feature, a
        // `rail://` link in the second instance's arguments (Windows, Linux)
        // arrives here as a deep-link event (`account::setup`).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!("second instance started: focusing this one");
            show_main_window(app);
        }))
        // `rail://` links (R1.7), handled in Rust; no permission for the window.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(log_plugin())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_ARG]),
        ))
        // The folder picker of the first-run screen (and the dev panel's
        // file picker), called from Rust only.
        .plugin(tauri_plugin_dialog::init());

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::core_info,
        commands::app_info,
        commands::get_settings,
        commands::set_theme,
        commands::set_density,
        commands::set_locale,
        commands::set_start_at_login,
        commands::set_first_run_done,
        commands::store_status,
        watch::watcher_status,
        watch::set_import_paused,
        folders::discover_folders,
        folders::add_folders,
        folders::pick_folder,
        folder_settings::add_folder,
        folder_settings::set_folder_path,
        folder_settings::set_folder_room,
        folder_settings::set_folder_enabled,
        folder_settings::set_folder_recursive,
        folder_settings::set_folder_poll_only,
        folder_settings::remove_folder,
        folder_settings::folder_rooms,
        folder_settings::folder_quarantine,
        quarantine::quarantine_summary,
        quarantine::quarantine_entries,
        quarantine::quarantine_raw_text,
        quarantine::retry_refused,
        account::account_status,
        account::account_sign_in,
        account::account_open_sign_in_page,
        account::account_cancel_sign_in,
        account::account_sign_out,
        sync::sync_status,
        sync::sync_now,
        sync::sync_set_paused,
        sync::sync_set_cap,
        sync::sync_answer_account,
        sync::sync_retry_rejected,
        stats::stats_status,
        stats::stats_rebuild,
        stats::stats_recompute_ev,
        hands::hands_page,
        hands::hands_facets,
        hands::hands_by_key,
        hands::hands_find,
        hands::hand_phf,
        hands::hand_annotations,
        hands::hand_set_note,
        hands::hand_add_tag,
        hands::hand_remove_tag,
        hands::saved_filters,
        hands::save_filter,
        hands::delete_saved_filter,
        reports::stat_definitions,
        custom_stats::custom_stats_list,
        custom_stats::custom_stat_check,
        custom_stats::custom_stat_save,
        custom_stats::custom_stat_delete,
        reports::report,
        reports::report_breakdowns,
        reports::today,
        players::players_list,
        players::player_profile,
        players::player_sites,
        players::player_labels,
        players::player_set_note,
        players::player_set_colour,
        players::player_add_label,
        players::player_remove_label,
        hud::hud_status,
        dev::dev_pick_file,
        dev::convert_file,
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::core_info,
        commands::app_info,
        commands::get_settings,
        commands::set_theme,
        commands::set_density,
        commands::set_locale,
        commands::set_start_at_login,
        commands::set_first_run_done,
        commands::store_status,
        watch::watcher_status,
        watch::set_import_paused,
        folders::discover_folders,
        folders::add_folders,
        folders::pick_folder,
        folder_settings::add_folder,
        folder_settings::set_folder_path,
        folder_settings::set_folder_room,
        folder_settings::set_folder_enabled,
        folder_settings::set_folder_recursive,
        folder_settings::set_folder_poll_only,
        folder_settings::remove_folder,
        folder_settings::folder_rooms,
        folder_settings::folder_quarantine,
        quarantine::quarantine_summary,
        quarantine::quarantine_entries,
        quarantine::quarantine_raw_text,
        quarantine::retry_refused,
        account::account_status,
        account::account_sign_in,
        account::account_open_sign_in_page,
        account::account_cancel_sign_in,
        account::account_sign_out,
        sync::sync_status,
        sync::sync_now,
        sync::sync_set_paused,
        sync::sync_set_cap,
        sync::sync_answer_account,
        sync::sync_retry_rejected,
        stats::stats_status,
        stats::stats_rebuild,
        stats::stats_recompute_ev,
        hands::hands_page,
        hands::hands_facets,
        hands::hands_by_key,
        hands::hands_find,
        hands::hand_phf,
        hands::hand_annotations,
        hands::hand_set_note,
        hands::hand_add_tag,
        hands::hand_remove_tag,
        hands::saved_filters,
        hands::save_filter,
        hands::delete_saved_filter,
        reports::stat_definitions,
        custom_stats::custom_stats_list,
        custom_stats::custom_stat_check,
        custom_stats::custom_stat_save,
        custom_stats::custom_stat_delete,
        reports::report,
        reports::report_breakdowns,
        reports::today,
        players::players_list,
        players::player_profile,
        players::player_sites,
        players::player_labels,
        players::player_set_note,
        players::player_set_colour,
        players::player_add_label,
        players::player_remove_label,
        hud::hud_status,
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
        // The HUD first (its overlays go at once), then the watcher, the
        // sync worker and the statistics pass: the store waits for their
        // writer handles.
        tauri::RunEvent::Exit => {
            if let Some(hud) = app.try_state::<hud::HudState>() {
                hud.stop();
            }
            if let Some(sync) = app.try_state::<sync::SyncState>() {
                sync.stop();
            }
            if let Some(watcher) = app.try_state::<watch::WatcherState>() {
                watcher.stop();
            }
            if let Some(stats) = app.try_state::<stats::StatsState>() {
                stats.stop();
            }
        }
        // macOS: a click on the Dock icon while the window is hidden.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    });
}
