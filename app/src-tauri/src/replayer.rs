//! The replayer's own window: a hand chosen on the Hands screen (or from the
//! command palette, or a player's hands) opens there, never beside the list.
//!
//! - **One window, reused.** The first hand builds it
//!   ([`REPLAYER_WINDOW`], on the app's page at [`REPLAYER_ROUTE`]); every
//!   later one is handed to it ([`REPLAYER_HAND_EVENT`]), which reads the
//!   hand again in place. The window asks for its hand when it loads
//!   ([`replayer_hand`]), so a hand chosen while it was being built is not
//!   lost.
//! - **Focus.** Stepping through the list with the arrow keys swaps the hand
//!   without taking the keyboard from the list: a new window is built
//!   unfocused, an open one is only told. A click on a row, Enter, or a hand
//!   opened from elsewhere brings it forward with the keyboard
//!   (`focus: true`).
//! - **Closing.** Its close button ([`replayer_close`]) or the system's;
//!   either way the main window is told ([`REPLAYER_CLOSED_EVENT`]) and the
//!   list lets go of the hand ([`closed`], from the window's `Destroyed`).
//!   The main window hiding to the tray leaves it open.

use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

use crate::MAIN_WINDOW;

/// The replayer window's label.
pub const REPLAYER_WINDOW: &str = "replayer";

/// Its page: the app's own, on the replayer's route.
pub const REPLAYER_ROUTE: &str = "index.html#/replayer";

/// Told to the replayer window: show this hand (its key).
pub const REPLAYER_HAND_EVENT: &str = "replayer-hand";

/// Told to the main window: the replayer window closed.
pub const REPLAYER_CLOSED_EVENT: &str = "replayer-closed";

/// Told to the main window: go to this screen (a link in the replayer
/// window, such as the hand's analysis), as `#/...`.
pub const OPEN_ROUTE_EVENT: &str = "open-route";

/// The window's first size, in logical pixels: the web's replayer at its
/// width, so the felt is the same wide table (a stage at least 1.54 times as
/// wide as it is tall; `seatLayout.shapeFor`), with the chips in front of the
/// seats.
const DEFAULT_SIZE: (f64, f64) = (1040.0, 760.0);

/// The smallest the window goes: still the wide table, large enough that
/// the names, stacks and bets read.
const MIN_SIZE: (f64, f64) = (760.0, 560.0);

/// The hand the window shows (or is being built to show).
#[derive(Debug, Default)]
pub struct ReplayerState {
    hand: Mutex<Option<String>>,
    /// One open at a time: two quick clicks must not build two windows.
    opening: tokio::sync::Mutex<()>,
}

impl ReplayerState {
    fn hand(&self) -> Option<String> {
        self.hand
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Set the hand; whether it changed.
    fn set(&self, hand_key: Option<String>) -> bool {
        let mut hand = self.hand.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = *hand != hand_key;
        *hand = hand_key;
        changed
    }
}

/// Show a hand in the replayer window, building it the first time.
#[tauri::command]
pub async fn replayer_open(
    app: AppHandle,
    state: State<'_, ReplayerState>,
    hand_key: String,
    focus: bool,
) -> Result<(), String> {
    let _opening = state.opening.lock().await;
    let changed = state.set(Some(hand_key.clone()));
    if let Some(window) = app.get_webview_window(REPLAYER_WINDOW) {
        if changed {
            app.emit_to(REPLAYER_WINDOW, REPLAYER_HAND_EVENT, &hand_key)
                .map_err(|error| error.to_string())?;
        }
        if focus {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        REPLAYER_WINDOW,
        WebviewUrl::App(REPLAYER_ROUTE.into()),
    )
    .title("Rail")
    .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
    .resizable(true)
    .visible(false)
    .focused(focus)
    .build()
    .map_err(|error| {
        state.set(None);
        error.to_string()
    })?;
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
    Ok(())
}

/// The hand the window should show (`None`: none chosen).
#[tauri::command]
pub fn replayer_hand(state: State<'_, ReplayerState>) -> Option<String> {
    state.hand()
}

/// Close the replayer window (its close button).
#[tauri::command]
pub fn replayer_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(REPLAYER_WINDOW) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// A link in the replayer window to another screen: the main window comes
/// forward on it. Only the app's own routes (`#/<screen>...`).
#[tauri::command]
pub fn replayer_open_in_main(app: AppHandle, href: String) -> Result<(), String> {
    if !is_route(&href) {
        return Err("not a screen of the app".to_owned());
    }
    crate::show_main_window(&app);
    app.emit_to(MAIN_WINDOW, OPEN_ROUTE_EVENT, &href)
        .map_err(|error| error.to_string())
}

/// `#/` and a screen's name, then its parameter: no scheme, no host.
fn is_route(href: &str) -> bool {
    href.strip_prefix("#/").is_some_and(|rest| {
        rest.len() < 2048
            && rest
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_lowercase())
            && !rest.contains(['\\', '\n', '\r'])
    })
}

/// The window is gone (`WindowEvent::Destroyed`): forget the hand, tell the
/// main window.
pub fn closed<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<ReplayerState>() {
        state.set(None);
    }
    if let Err(error) = app.emit_to(MAIN_WINDOW, REPLAYER_CLOSED_EVENT, ()) {
        log::debug!("replayer: the main window was not told it closed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{ReplayerState, is_route};

    #[test]
    fn only_the_app_s_own_routes_open_in_the_main_window() {
        assert!(is_route("#/analysis/h%3Aabc"));
        assert!(!is_route("https://example.com"));
        assert!(!is_route("#//example.com"));
        assert!(!is_route("#/"));
    }

    #[test]
    fn the_same_hand_again_is_not_a_change() {
        let state = ReplayerState::default();
        assert!(state.set(Some("a".into())));
        assert!(!state.set(Some("a".into())));
        assert!(state.set(Some("b".into())));
        assert_eq!(state.hand().as_deref(), Some("b"));
        assert!(state.set(None));
        assert_eq!(state.hand(), None);
    }
}
