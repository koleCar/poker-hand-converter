//! The RNG box (the owner's brief of 2026-11-16): one small window of the
//! app's in the top-right corner of the primary monitor, showing one number
//! from 1 to 100. A click on it shows a new one. It replaces T4's RNG
//! drawn over each table: nothing of it is attached to, drawn over or
//! placed by a poker table.
//!
//! - **When it shows** ([`wanted`]): the user's RNG switch is on
//!   (Settings, `RngSettings.enabled`, stored and synced as before) **and**
//!   a table is in play - the live session is live (the hero's newest hand
//!   is within the session gap of now, Live's rule:
//!   `rail_store::report::SESSION_GAP_MINUTES`) or the HUD has a table
//!   open (`tables_open`). Rail learns of a hand when the room writes it,
//!   so the box comes up after the first hand of a session ends, and goes
//!   away a session gap after the last one (or when the switch goes off).
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

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rail_hud_ipc::protocol::ScreenRect;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

use crate::commands::StoreState;
use crate::hud::HudState;

/// The box's window label.
pub const RNG_BOX_WINDOW: &str = "rng-box";

/// The page's route the box shows (`src/rngBox/RngBox.tsx`).
pub const RNG_BOX_ROUTE: &str = "index.html#/rng-box";

/// The box's window event when the number changed outside it (the hotkey);
/// the payload is the number.
pub const ROLLED_EVENT: &str = "rng-box-rolled";

/// The numbers, both ends included.
pub const MIN: u32 = 1;
pub const MAX: u32 = 100;

/// The box's side and its distance from the work area's edges, in points.
const SIDE: i32 = 56;
const MARGIN: i32 = 12;

/// How often whether the box should show is looked at.
const LOOK_EVERY: Duration = Duration::from_secs(10);

/// The number shown (0: none rolled yet).
#[derive(Debug, Default)]
pub struct RngBoxState {
    number: AtomicU32,
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

/// Whether the box shows: the switch is on and a table is in play - the
/// HUD has one open, or the hero's newest hand (`newest_ms`) is within the
/// session gap of `now_ms`.
pub fn wanted(enabled: bool, tables_open: u32, newest_ms: Option<i64>, now_ms: i64) -> bool {
    let gap_ms = rail_store::report::SESSION_GAP_MINUTES * 60_000;
    enabled && (tables_open > 0 || newest_ms.is_some_and(|newest| now_ms - newest <= gap_ms))
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
    wanted(true, hud.tables_open(), newest, now_ms())
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
            }
            _ => {}
        }
    });
    if let Err(error) = result {
        log::debug!("rng box: {error}");
    }
}

/// The box's top-left corner in points: the primary monitor's work area's
/// top-right corner, [`MARGIN`] in. `None` without a monitor. In points on
/// both systems (the builder's position is logical): the primary monitor's
/// origin is the screen's, so its physical pixels over its scale are its
/// points (`crate::popup::to_points`).
fn corner<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32)> {
    let monitor = app.primary_monitor().ok()??;
    let area = monitor.work_area();
    let area = crate::popup::to_points(
        ScreenRect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        crate::popup::permille(monitor.scale_factor()),
    );
    Some(corner_of(area))
}

/// [`corner`] in a work area given in points.
fn corner_of(area: ScreenRect) -> (i32, i32) {
    let width = i32::try_from(area.width).unwrap_or(i32::MAX);
    (
        area.x.saturating_add(width).saturating_sub(SIDE + MARGIN),
        area.y.saturating_add(MARGIN),
    )
}

/// Open the box (on the main thread).
fn open_box<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(state) = app.try_state::<RngBoxState>() {
        // A new session shows a new number.
        state.roll()?;
    }
    let mut builder =
        WebviewWindowBuilder::new(app, RNG_BOX_WINDOW, WebviewUrl::App(RNG_BOX_ROUTE.into()))
            .title("Rail RNG")
            .inner_size(f64::from(SIDE), f64::from(SIDE))
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
    if let Some((x, y)) = corner(app) {
        builder = builder.position(f64::from(x), f64::from(y));
    }
    let window = builder.build().map_err(|error| error.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;

    /// The switch first; then a table open or a hand within the session
    /// gap.
    #[test]
    fn the_box_shows_while_a_table_is_in_play() {
        let now = 1_000 * MINUTE;
        assert!(!wanted(false, 3, Some(now), now), "switched off");
        assert!(wanted(true, 1, None, now), "a table open, no hand yet");
        assert!(wanted(true, 0, Some(now - 30 * MINUTE), now));
        assert!(
            !wanted(true, 0, Some(now - 31 * MINUTE), now),
            "the session ended"
        );
        assert!(!wanted(true, 0, None, now), "no hand at all");
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
        assert_eq!(corner_of(area), (1512 - 56 - 12, 25 + 12));
        // A primary monitor right of the origin (another system's layout).
        let moved = ScreenRect { x: 1920, ..area };
        assert_eq!(corner_of(moved).0, 1920 + 1512 - 68);
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
