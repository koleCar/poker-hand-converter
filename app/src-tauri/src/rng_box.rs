//! The RNG box (the owner's brief of 2026-11-16): one small window of the
//! app's, showing one number from 1 to 100. A click on it shows a new one.
//! It replaces T4's RNG drawn over each table: nothing of it is attached
//! to, drawn over or placed by a poker table.
//!
//! - **When it shows** ([`wanted`]): the user's RNG switch is on
//!   (Settings, `RngSettings.enabled`, stored and synced as before) **and**
//!   a table is in play - the live session is live (the hero's newest hand
//!   is within the session gap of now, Live's rule:
//!   `rail_store::report::SESSION_GAP_MINUTES`) or the HUD has a table
//!   open (`tables_open`). Rail learns of a hand when the room writes it,
//!   so the box comes up after the first hand of a session ends, and goes
//!   away a session gap after the last one (or when the switch goes off).
//!   It also shows while Settings' RNG section is on screen
//!   ([`rng_box_preview`]), so the user sees what they style and place.
//! - **Its look and place** (the owner's brief of 2026-11-17) are the
//!   user's, in `RngSettings`: size, the number's size, background and
//!   number colours, where it sits, and whether it is locked. Unlocked, the
//!   box is dragged anywhere on the screen and resized from its corner (the
//!   page moves the window with [`rng_box_place`] and saves the end with
//!   [`rng_box_save_frame`]); locked, it stays put. With no place saved,
//!   or a saved place on no monitor now (another computer's, a monitor
//!   unplugged), it sits in the primary monitor's top-right corner
//!   ([`placed`]). "Reposition" ([`rng_box_reposition`]) puts it in the
//!   middle of the primary monitor, unlocked, to be placed again.
//! - **Right-click** (the owner's brief of 2026-11-17) opens the RNG panel
//!   ([`rng_panel_toggle`]): a small window of its own beside the box with
//!   the lock, "Reposition" and the look, so nothing needs the main
//!   window's Settings. A second right-click, Esc or its close button
//!   closes it; it goes with the box. It does not close when it loses the
//!   keyboard: the system's colour picker takes it.
//! - Every save of the RNG settings tells every window which window saved
//!   it ([`RNG_SETTINGS_EVENT`]), so Settings and the panel read again
//!   what the other (or the box) changed.
//! - **Looked at** every [`LOOK_EVERY`], and at once when the switch
//!   changes ([`refresh`]). The look is one row of the store
//!   (`Reader::newest_hand_at`).
//! - **The number** comes from the operating system's CSPRNG with
//!   rejection sampling (`crate::rng::roll`: no modulo bias, nothing
//!   reproducible). The box rolls when it first shows and on every
//!   click ([`rng_box_roll`]); the "Roll the RNG" hotkey rolls it too
//!   ([`roll_from_hotkey`]) and tells the box ([`ROLLED_EVENT`]).
//! - **The window** is always on top, frameless, without a taskbar entry
//!   and shown without taking the keyboard (`focused(false)`, as the HUD
//!   popup). A click into it does give Rail the keyboard - the system's
//!   rule for a click on an ordinary window - so the table's bet keys wait
//!   for a click back on the table.
//! - **Free**: no plan needed (the owner's word of 2026-11-11 for tiling
//!   and the RNG), and the HUD process is not needed for it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rail_hud_ipc::protocol::ScreenRect;
use rail_hud_ipc::settings::{RNG_BOX_MAX, RNG_BOX_MIN, RngPosition, RngSettings};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::commands::StoreState;
use crate::hud::HudState;

/// The box's window label.
pub const RNG_BOX_WINDOW: &str = "rng-box";

/// The page's route the box shows (`src/rngBox/RngBox.tsx`).
pub const RNG_BOX_ROUTE: &str = "index.html#/rng-box";

/// The box's window event when the number changed outside it (the hotkey);
/// the payload is the number.
pub const ROLLED_EVENT: &str = "rng-box-rolled";

/// The box's window event when its look changed (Settings saved, a sync
/// pull); the payload is the `RngSettings`.
pub const STYLE_EVENT: &str = "rng-box-style";

/// The RNG panel's window label and route (`src/rngBox/RngPanel.tsx`).
pub const RNG_PANEL_WINDOW: &str = "rng-panel";
pub const RNG_PANEL_ROUTE: &str = "index.html#/rng-panel";

/// The panel's size, points, and its gap from the box.
const PANEL_WIDTH: u32 = 430;
const PANEL_HEIGHT: u32 = 500;
const PANEL_GAP: i32 = 8;

/// Every window's event when the RNG settings were saved; the payload
/// says which window saved them ([`RngSaved`]).
pub const RNG_SETTINGS_EVENT: &str = "rng-settings-changed";

/// [`RNG_SETTINGS_EVENT`]'s payload.
#[derive(Debug, Clone, Serialize)]
pub struct RngSaved {
    pub from: String,
}

/// Tell every window the RNG settings were saved by `from`.
pub fn tell_saved<R: Runtime>(app: &AppHandle<R>, from: &str) {
    let payload = RngSaved {
        from: from.to_owned(),
    };
    if let Err(error) = app.emit(RNG_SETTINGS_EVENT, payload) {
        log::debug!("{RNG_SETTINGS_EVENT}: {error}");
    }
}

/// The numbers, both ends included.
pub const MIN: u32 = 1;
pub const MAX: u32 = 100;

/// The box's distance from the work area's edges in its corner, in points.
const MARGIN: i32 = 12;

/// How often whether the box should show is looked at.
const LOOK_EVERY: Duration = Duration::from_secs(10);

/// The number shown (0: none rolled yet), and whether Settings' RNG
/// section is on screen (the box then shows to be styled and placed).
#[derive(Debug, Default)]
pub struct RngBoxState {
    number: AtomicU32,
    preview: AtomicBool,
}

impl RngBoxState {
    /// The number shown, rolling the first one.
    pub fn number(&self) -> Result<u32, String> {
        match self.number.load(Ordering::SeqCst) {
            0 => self.roll(),
            n => Ok(n),
        }
    }

    /// A new number.
    pub fn roll(&self) -> Result<u32, String> {
        let n = crate::rng::roll(MIN, MAX).map_err(|error| error.to_string())?;
        self.number.store(n, Ordering::SeqCst);
        Ok(n)
    }
}

/// Whether the box shows: the switch is on and it is being styled in
/// Settings (`preview`) or a table is in play - the HUD has one open, or
/// the hero's newest hand (`newest_ms`) is within the session gap of
/// `now_ms`.
pub fn wanted(
    enabled: bool,
    preview: bool,
    tables_open: u32,
    newest_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    let gap_ms = rail_store::report::SESSION_GAP_MINUTES * 60_000;
    enabled
        && (preview || tables_open > 0 || newest_ms.is_some_and(|newest| now_ms - newest <= gap_ms))
}

/// The user's RNG settings as the app holds them.
fn settings<R: Runtime>(app: &AppHandle<R>) -> RngSettings {
    app.try_state::<HudState>()
        .map(|hud| hud.table_settings().rng)
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The box wanted now, from the app's state.
fn wanted_now<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(hud) = app.try_state::<HudState>() else {
        return false;
    };
    if !hud.table_settings().rng.enabled {
        return false;
    }
    let preview = app
        .try_state::<RngBoxState>()
        .is_some_and(|state| state.preview.load(Ordering::SeqCst));
    if preview {
        return true;
    }
    let newest = app
        .try_state::<StoreState>()
        .and_then(|store| {
            let reader = store.store.as_ref()?.reader();
            match reader.newest_hand_at() {
                Ok(newest) => newest,
                Err(error) => {
                    log::debug!("rng box: the newest hand: {error}");
                    None
                }
            }
        })
        .and_then(|at| rail_store::time::ms_from_iso(&at));
    wanted(true, false, hud.tables_open(), newest, now_ms())
}

/// Show or close the box as [`wanted`] says now.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let show = wanted_now(app);
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let open = handle.get_webview_window(RNG_BOX_WINDOW);
        match (show, open) {
            (true, None) => {
                if let Err(error) = open_box(&handle) {
                    log::warn!("rng box: {error}");
                }
            }
            (false, Some(window)) => {
                let _ = window.destroy();
                if let Some(panel) = handle.get_webview_window(RNG_PANEL_WINDOW) {
                    let _ = panel.destroy();
                }
            }
            _ => {}
        }
    });
    if let Err(error) = result {
        log::debug!("rng box: {error}");
    }
}

/// A monitor's work area in points. In points on both systems (the
/// builder's position is logical): the primary monitor's origin is the
/// screen's, so its physical pixels over its scale are its points
/// (`crate::popup::to_points`). Another monitor of another scale is
/// approximate (good enough to tell whether a saved place is on it).
fn area_in_points(monitor: &tauri::Monitor) -> ScreenRect {
    let area = monitor.work_area();
    crate::popup::to_points(
        ScreenRect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        crate::popup::permille(monitor.scale_factor()),
    )
}

/// A monitor's whole screen (the taskbar or dock too) in points, as
/// [`area_in_points`].
fn bounds_in_points(monitor: &tauri::Monitor) -> ScreenRect {
    let (at, size) = (monitor.position(), monitor.size());
    crate::popup::to_points(
        ScreenRect {
            x: at.x,
            y: at.y,
            width: size.width,
            height: size.height,
        },
        crate::popup::permille(monitor.scale_factor()),
    )
}

/// The primary monitor's work area (for its corner and middle), and every
/// monitor's whole screen (a saved place over the taskbar or dock is still
/// on a monitor), in points.
fn work_areas<R: Runtime>(app: &AppHandle<R>) -> (Option<ScreenRect>, Vec<ScreenRect>) {
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| area_in_points(&m));
    let all = app
        .available_monitors()
        .map(|monitors| monitors.iter().map(bounds_in_points).collect())
        .unwrap_or_default();
    (primary, all)
}

/// Whether a point is on a rect.
fn on_rect(a: &ScreenRect, x: i64, y: i64) -> bool {
    (i64::from(a.x)..i64::from(a.x) + i64::from(a.width)).contains(&x)
        && (i64::from(a.y)..i64::from(a.y) + i64::from(a.height)).contains(&y)
}

/// (Windows) A place in points as the pixels of the monitor the box's
/// middle is on: each monitor's points are its pixels over its own scale
/// ([`frame_of`], [`bounds_in_points`]), so this is the exact inverse of
/// how the place was saved. A logical place given to Windows is turned into
/// pixels with the scale of the first monitor it seems to fit (tao), and
/// one that fits none goes to the system's default place - the box did not
/// come back where the user left it.
#[cfg(windows)]
#[allow(clippy::float_arithmetic)]
fn physical_of<R: Runtime>(
    app: &AppHandle<R>,
    (x, y): (i32, i32),
    (width, height): (u32, u32),
) -> Option<tauri::PhysicalPosition<i32>> {
    let mx = i64::from(x) + i64::from(width / 2);
    let my = i64::from(y) + i64::from(height / 2);
    let monitors = app.available_monitors().ok()?;
    let scale = monitors
        .iter()
        .find(|m| on_rect(&bounds_in_points(m), mx, my))
        .map(tauri::Monitor::scale_factor)
        .or_else(|| {
            app.primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.scale_factor())
        })?;
    Some(tauri::PhysicalPosition::new(
        points(f64::from(x) * scale),
        points(f64::from(y) * scale),
    ))
}

/// Put the box at a place in points: on Windows in the pixels of the
/// monitor it is on ([`physical_of`]), elsewhere as points (macOS's screen
/// is in points).
fn move_box<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    at: (i32, i32),
    size: (u32, u32),
) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(pixels) = physical_of(app, at, size) {
        return window.set_position(pixels).map_err(|e| e.to_string());
    }
    let _ = (app, size);
    window
        .set_position(LogicalPosition::new(f64::from(at.0), f64::from(at.1)))
        .map_err(|e| e.to_string())
}

fn to_i32(v: u32) -> i32 {
    i32::try_from(v).unwrap_or(i32::MAX)
}

/// The box's top-left corner in the top-right corner of a work area given
/// in points, [`MARGIN`] in.
fn corner_of(area: ScreenRect, width: u32) -> (i32, i32) {
    (
        area.x
            .saturating_add(to_i32(area.width))
            .saturating_sub(to_i32(width).saturating_add(MARGIN)),
        area.y.saturating_add(MARGIN),
    )
}

/// The box's top-left corner in the middle of a work area given in points.
fn middle_of(area: ScreenRect, width: u32, height: u32) -> (i32, i32) {
    (
        area.x
            .saturating_add((to_i32(area.width).saturating_sub(to_i32(width))) / 2),
        area.y
            .saturating_add((to_i32(area.height).saturating_sub(to_i32(height))) / 2),
    )
}

/// Where the box sits, in points: the user's place while the box's middle
/// is on one of the monitors (`areas`, whole screens; or no monitor is
/// known), else the primary monitor's top-right corner. `None`: no place
/// saved and no monitor.
fn placed(
    rng: &RngSettings,
    primary: Option<ScreenRect>,
    areas: &[ScreenRect],
) -> Option<(i32, i32)> {
    if let Some(RngPosition { x, y }) = rng.position {
        let mx = i64::from(x) + i64::from(rng.width / 2);
        let my = i64::from(y) + i64::from(rng.height / 2);
        if areas.is_empty() || areas.iter().any(|a| on_rect(a, mx, my)) {
            return Some((x, y));
        }
        log::info!(
            "rng box: the saved place {x},{y} ({}x{}) is on no monitor now {areas:?}; in the corner",
            rng.width,
            rng.height
        );
    }
    primary.map(|area| corner_of(area, rng.width))
}

/// Open the box (on the main thread).
fn open_box<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(state) = app.try_state::<RngBoxState>() {
        // A new session shows a new number.
        state.roll()?;
    }
    let rng = settings(app);
    let mut builder =
        WebviewWindowBuilder::new(app, RNG_BOX_WINDOW, WebviewUrl::App(RNG_BOX_ROUTE.into()))
            .title("Rail RNG")
            .inner_size(f64::from(rng.width), f64::from(rng.height))
            .visible(false)
            .focused(false)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .shadow(true);
    #[cfg(target_os = "macos")]
    {
        // The first click on the box (Rail not in front) drags or rolls it
        // rather than only bringing Rail forward.
        builder = builder.accept_first_mouse(true);
    }
    let (primary, areas) = work_areas(app);
    let at = placed(&rng, primary, &areas);
    if let Some((x, y)) = at {
        builder = builder.position(f64::from(x), f64::from(y));
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    // The builder's place is approximate on Windows (`move_box`): put it
    // exactly before it shows.
    if let Some(at) = at
        && let Err(error) = move_box(app, &window, at, (rng.width, rng.height))
    {
        log::warn!("rng box: placing it: {error}");
    }
    log::info!(
        "rng box: shown at {at:?} (saved {:?})",
        rng.position.map(|p| (p.x, p.y))
    );
    window.show().map_err(|error| error.to_string())
}

/// The loop: the box shows and goes as [`wanted`] says, looked at every
/// [`LOOK_EVERY`].
pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app);
            tokio::time::sleep(LOOK_EVERY).await;
        }
    });
}

/// (T7) The "Roll the RNG" hotkey: a new number in the box, when it shows.
/// Whether it did.
pub fn roll_from_hotkey<R: Runtime>(app: &AppHandle<R>) -> bool {
    if app.get_webview_window(RNG_BOX_WINDOW).is_none() {
        return false;
    }
    let Some(state) = app.try_state::<RngBoxState>() else {
        return false;
    };
    match state.roll() {
        Ok(n) => {
            if let Err(error) = app.emit_to(RNG_BOX_WINDOW, ROLLED_EVENT, n) {
                log::debug!("{ROLLED_EVENT}: {error}");
            }
            true
        }
        Err(error) => {
            log::warn!("rng box: {error}");
            false
        }
    }
}

/// The number the box shows.
#[tauri::command]
pub fn rng_box_number(state: State<'_, RngBoxState>) -> Result<u32, String> {
    state.number()
}

/// A click on the box: a new number.
#[tauri::command]
pub fn rng_box_roll(state: State<'_, RngBoxState>) -> Result<u32, String> {
    state.roll()
}

/// The settings changed (saved in Settings, pulled from another
/// computer): the box shows or goes, and an open box takes its new size
/// and place and tells its page the new look ([`STYLE_EVENT`]).
pub fn restyle<R: Runtime>(app: &AppHandle<R>) {
    refresh(app);
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(RNG_BOX_WINDOW) else {
            return;
        };
        let rng = settings(&handle);
        let _ = window.set_size(LogicalSize::new(
            f64::from(rng.width),
            f64::from(rng.height),
        ));
        let (primary, areas) = work_areas(&handle);
        if let Some(at) = placed(&rng, primary, &areas) {
            let _ = move_box(&handle, &window, at, (rng.width, rng.height));
        }
        if let Err(error) = handle.emit_to(RNG_BOX_WINDOW, STYLE_EVENT, &rng) {
            log::debug!("{STYLE_EVENT}: {error}");
        }
    });
    if let Err(error) = result {
        log::debug!("rng box: {error}");
    }
}

/// Save RNG settings changed here (not by the Settings page): stored, kept,
/// sent by the sync worker, and every window told ([`tell_saved`]) - from
/// the box (a drag, "Reposition" from the window `from`).
fn save<R: Runtime>(app: &AppHandle<R>, rng: &RngSettings, from: &str) -> Result<(), String> {
    let store = app
        .try_state::<StoreState>()
        .ok_or("the store is not open")?;
    crate::tiling::write_rng(&crate::tiling::writer(&store)?, rng)?;
    if let Some(hud) = app.try_state::<HudState>() {
        hud.rng_written(rng.clone());
    }
    tell_saved(app, from);
    Ok(())
}

/// The box's place and size, in points (the page's drag starts from it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RngFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[allow(clippy::cast_possible_truncation)]
fn points(v: f64) -> i32 {
    v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn frame_of<R: Runtime>(window: &WebviewWindow<R>) -> Result<RngFrame, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let at = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok(RngFrame {
        x: points(at.x),
        y: points(at.y),
        width: clamp_side(points(size.width)),
        height: clamp_side(points(size.height)),
    })
}

/// A side within the box's bounds.
fn clamp_side(v: i32) -> u32 {
    u32::try_from(v.max(0))
        .unwrap_or(0)
        .clamp(RNG_BOX_MIN, RNG_BOX_MAX)
}

fn the_box<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window(RNG_BOX_WINDOW)
        .ok_or_else(|| "the RNG box is not showing".to_owned())
}

fn unlocked<R: Runtime>(app: &AppHandle<R>) -> Result<RngSettings, String> {
    let rng = settings(app);
    if rng.locked {
        return Err("the RNG box is locked".to_owned());
    }
    Ok(rng)
}

/// The box's place and size now, in points.
#[tauri::command]
pub fn rng_box_frame<R: Runtime>(app: AppHandle<R>) -> Result<RngFrame, String> {
    frame_of(&the_box(&app)?)
}

/// Move and size the box while it is dragged or resized (not saved;
/// refused while it is locked). Sides are held within their bounds.
#[tauri::command]
pub fn rng_box_place<R: Runtime>(
    app: AppHandle<R>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    unlocked(&app)?;
    let window = the_box(&app)?;
    window
        .set_position(LogicalPosition::new(f64::from(x), f64::from(y)))
        .map_err(|e| e.to_string())?;
    window
        .set_size(LogicalSize::new(
            f64::from(clamp_side(width)),
            f64::from(clamp_side(height)),
        ))
        .map_err(|e| e.to_string())
}

/// The drag or resize ended: the box's place and size now are saved.
/// Refused while it is locked.
#[tauri::command]
pub fn rng_box_save_frame<R: Runtime>(app: AppHandle<R>) -> Result<RngSettings, String> {
    let mut rng = unlocked(&app)?;
    let frame = frame_of(&the_box(&app)?)?;
    rng.position = Some(RngPosition {
        x: frame.x,
        y: frame.y,
    });
    rng.width = frame.width;
    rng.height = frame.height;
    save(&app, &rng, RNG_BOX_WINDOW)?;
    // The panel, if open, follows the box.
    place_panel(&app);
    Ok(rng)
}

/// Settings' "Reposition": the box in the middle of the primary monitor,
/// unlocked, to be dragged where the user wants it. The new settings.
/// `async` because it may open the box ([`rng_box_preview`] says why).
#[tauri::command]
pub async fn rng_box_reposition<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
) -> Result<RngSettings, String> {
    let mut rng = settings(&app);
    let (primary, _) = work_areas(&app);
    let area = primary.ok_or("no monitor")?;
    let (x, y) = middle_of(area, rng.width, rng.height);
    rng.position = Some(RngPosition { x, y });
    rng.locked = false;
    save(&app, &rng, window.label())?;
    restyle(&app);
    place_panel(&app);
    Ok(rng)
}

/// Settings' RNG section came on screen (`true`) or went: while on screen
/// the box shows (the switch on), to be styled and placed.
///
/// `async`, never a plain command: a plain one runs on the main thread
/// inside WebView2's message handler, where [`refresh`] runs at once and
/// builds the box's window - on Windows that deadlocks (the Tauri
/// `WebviewWindowBuilder::build` note), and the app hangs as Settings
/// opens. Off the main thread, `refresh` queues the window for the event
/// loop instead.
#[tauri::command]
pub async fn rng_box_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, RngBoxState>,
    on: bool,
) -> Result<(), String> {
    state.preview.store(on, Ordering::SeqCst);
    refresh(&app);
    Ok(())
}

/// The panel's top-left corner beside the box (`frame`), in the work area
/// `area` (both in points): right of the box when it fits, else left, else
/// over it; its top level with the box's, held inside the area.
fn panel_at(frame: RngFrame, area: ScreenRect) -> (i32, i32) {
    let (w, h) = (to_i32(PANEL_WIDTH), to_i32(PANEL_HEIGHT));
    let left_edge = area.x;
    let right_edge = area.x.saturating_add(to_i32(area.width));
    let bottom_edge = area.y.saturating_add(to_i32(area.height));
    let right = frame
        .x
        .saturating_add(to_i32(frame.width))
        .saturating_add(PANEL_GAP);
    let left = frame.x.saturating_sub(PANEL_GAP).saturating_sub(w);
    let x = if right.saturating_add(w) <= right_edge {
        right
    } else if left >= left_edge {
        left
    } else {
        right_edge.saturating_sub(w).max(left_edge)
    };
    let y = frame.y.min(bottom_edge.saturating_sub(h)).max(area.y);
    (x, y)
}

/// The work area (points) of the monitor the box is on: the primary's
/// when the box is on none known.
fn area_of_box<R: Runtime>(app: &AppHandle<R>, frame: RngFrame) -> Option<ScreenRect> {
    let (primary, areas) = work_areas(app);
    let mx = i64::from(frame.x) + i64::from(frame.width / 2);
    let my = i64::from(frame.y) + i64::from(frame.height / 2);
    areas
        .into_iter()
        .find(|a| {
            (i64::from(a.x)..i64::from(a.x) + i64::from(a.width)).contains(&mx)
                && (i64::from(a.y)..i64::from(a.y) + i64::from(a.height)).contains(&my)
        })
        .or(primary)
}

/// Where the panel goes now, beside the box (`None` without a box).
fn panel_place<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32)> {
    let frame = frame_of(&app.get_webview_window(RNG_BOX_WINDOW)?).ok()?;
    let area = area_of_box(app, frame)?;
    Some(panel_at(frame, area))
}

/// Move an open panel beside the box (after the box moved).
fn place_panel<R: Runtime>(app: &AppHandle<R>) {
    let Some(panel) = app.get_webview_window(RNG_PANEL_WINDOW) else {
        return;
    };
    if let Some((x, y)) = panel_place(app) {
        let _ = panel.set_position(LogicalPosition::new(f64::from(x), f64::from(y)));
    }
}

/// A right-click on the box: the RNG panel opens beside it, or closes when
/// it is open.
#[tauri::command]
pub async fn rng_panel_toggle<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(RNG_PANEL_WINDOW) {
        return panel.destroy().map_err(|e| e.to_string());
    }
    let mut builder = WebviewWindowBuilder::new(
        &app,
        RNG_PANEL_WINDOW,
        WebviewUrl::App(RNG_PANEL_ROUTE.into()),
    )
    .title("Rail RNG")
    .inner_size(f64::from(PANEL_WIDTH), f64::from(PANEL_HEIGHT))
    .visible(false)
    .decorations(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .shadow(true);
    if let Some((x, y)) = panel_place(&app) {
        builder = builder.position(f64::from(x), f64::from(y));
    }
    let panel = builder.build().map_err(|e| e.to_string())?;
    panel.show().map_err(|e| e.to_string())?;
    panel.set_focus().map_err(|e| e.to_string())
}

/// The panel's close button and Esc.
#[tauri::command]
pub fn rng_panel_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    match app.get_webview_window(RNG_PANEL_WINDOW) {
        Some(panel) => panel.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;

    /// The switch first; then a table open or a hand within the session
    /// gap.
    #[test]
    fn the_box_shows_while_a_table_is_in_play() {
        let now = 1_000 * MINUTE;
        assert!(!wanted(false, false, 3, Some(now), now), "switched off");
        assert!(
            wanted(true, false, 1, None, now),
            "a table open, no hand yet"
        );
        assert!(wanted(true, false, 0, Some(now - 30 * MINUTE), now));
        assert!(
            !wanted(true, false, 0, Some(now - 31 * MINUTE), now),
            "the session ended"
        );
        assert!(!wanted(true, false, 0, None, now), "no hand at all");
        assert!(wanted(true, true, 0, None, now), "styled in Settings");
        assert!(
            !wanted(false, true, 0, None, now),
            "styled, but switched off"
        );
    }

    /// The corner of a work area, in points: its right edge less the box
    /// and the margin, its top plus the margin.
    #[test]
    fn the_box_sits_in_the_top_right_corner() {
        let area = ScreenRect {
            x: 0,
            y: 25,
            width: 1512,
            height: 920,
        };
        assert_eq!(corner_of(area, 56), (1512 - 56 - 12, 25 + 12));
        assert_eq!(corner_of(area, 200), (1512 - 200 - 12, 25 + 12));
        // A primary monitor right of the origin (another system's layout).
        let moved = ScreenRect { x: 1920, ..area };
        assert_eq!(corner_of(moved, 56).0, 1920 + 1512 - 68);
    }

    /// The middle of a work area ("Reposition").
    #[test]
    fn reposition_is_the_middle() {
        let area = ScreenRect {
            x: 0,
            y: 25,
            width: 1512,
            height: 920,
        };
        assert_eq!(
            middle_of(area, 100, 60),
            ((1512 - 100) / 2, 25 + (920 - 60) / 2)
        );
    }

    /// The user's place while the box's middle is on a monitor; else the
    /// primary monitor's corner.
    #[test]
    fn a_saved_place_is_kept_while_on_a_monitor() {
        let primary = ScreenRect {
            x: 0,
            y: 25,
            width: 1512,
            height: 920,
        };
        let left = ScreenRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let at = |x, y| RngSettings {
            position: Some(RngPosition { x, y }),
            ..RngSettings::default()
        };
        let areas = [primary, left];
        assert_eq!(
            placed(&RngSettings::default(), Some(primary), &areas),
            Some(corner_of(primary, 56))
        );
        assert_eq!(
            placed(&at(300, 400), Some(primary), &areas),
            Some((300, 400))
        );
        assert_eq!(
            placed(&at(-1000, 500), Some(primary), &areas),
            Some((-1000, 500)),
            "the left monitor"
        );
        // Half off an edge is still on (its middle is).
        assert_eq!(
            placed(&at(1500 - 28, 30), Some(primary), &areas),
            Some((1500 - 28, 30))
        );
        // A monitor that is gone: back in the corner.
        assert_eq!(
            placed(&at(-1000, 500), Some(primary), &[primary]),
            Some(corner_of(primary, 56))
        );
        // Over the taskbar (a whole screen, not its work area): kept.
        let screen = ScreenRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(
            placed(&at(1800, 1030), Some(primary), &[screen]),
            Some((1800, 1030))
        );
        // No monitor known: the place as saved.
        assert_eq!(placed(&at(5, 6), None, &[]), Some((5, 6)));
        assert_eq!(placed(&RngSettings::default(), None, &[]), None);
    }

    /// The panel right of the box, else left, else inside the right edge;
    /// its top level with the box's, held inside the work area.
    #[test]
    fn the_panel_opens_beside_the_box() {
        let area = ScreenRect {
            x: 0,
            y: 25,
            width: 1512,
            height: 920,
        };
        let frame = |x, y| RngFrame {
            x,
            y,
            width: 56,
            height: 56,
        };
        assert_eq!(panel_at(frame(100, 200), area), (100 + 56 + 8, 200));
        // The top-right corner: no room right, so left.
        let corner = frame(1512 - 68, 37);
        assert_eq!(
            panel_at(corner, area),
            (1512 - 68 - 8 - to_i32(PANEL_WIDTH), 37)
        );
        // Low on the screen: held above the bottom edge.
        assert_eq!(
            panel_at(frame(100, 900), area).1,
            25 + 920 - to_i32(PANEL_HEIGHT)
        );
        // A box as wide as the screen: inside the right edge.
        let wide = RngFrame {
            x: 0,
            y: 100,
            width: 1500,
            height: 60,
        };
        assert_eq!(panel_at(wide, area).0, 1512 - to_i32(PANEL_WIDTH));
    }

    /// Every roll is in range, and a first look rolls one.
    #[test]
    fn numbers_are_one_to_a_hundred() {
        let state = RngBoxState::default();
        let first = state.number().expect("rolled");
        assert_eq!(
            state.number().expect("kept"),
            first,
            "kept until rolled again"
        );
        for _ in 0..1_000 {
            let n = state.roll().expect("rolled");
            assert!((MIN..=MAX).contains(&n), "{n}");
        }
    }
}
