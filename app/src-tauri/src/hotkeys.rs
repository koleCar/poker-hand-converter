//! (T7, docs/research/TABLE-TILING.md §4.3, §5) Table tiling's global
//! hotkeys from the app's side: the user's bindings (`TilingSettings.hotkeys`,
//! stored and synced with the rest of tiling's settings) registered with the
//! system, and a key pressed turned into what it does
//! (`rail_hud_ipc::hotkeys::dispatch`).
//!
//! - **Why here, through `tauri-plugin-global-shortcut`**: the app is the
//!   process that always runs while the HUD does (the HUD is its sidecar),
//!   it already owns the settings, the store and the IPC to the HUD, and it
//!   has the window to say what went wrong. The plugin (`global-hotkey`)
//!   registers with `RegisterHotKey` on Windows and Carbon's
//!   `RegisterEventHotKey` on macOS: no new permission on either (no
//!   Accessibility, no Input Monitoring - a key-event tap would need one),
//!   and the key never reaches another program while it is bound. The HUD
//!   would have needed both APIs written by hand and its own event loop on
//!   macOS's main thread, which AppKit's overlays already hold.
//! - **What a key does** ([`run`]): another layout or tiling on / off is a
//!   settings change - stored, sent to the HUD (`tiling_changed`), synced,
//!   the window told ([`crate::tiling::SETTINGS_EVENT`]) - exactly as if the
//!   user had clicked it on the Tables screen; "Re-tile" sends `retile`;
//!   "Roll the RNG" sends `roll_rng`. The HUD's permits decide every
//!   window: the tiler holds only the tables of rooms with a
//!   `TilingPermit`, and a roll needs the table's `RngPermit` (no room has
//!   one today, so that key is inert). Nothing here acts inside a table.
//! - **A key another program holds** is not an error: its binding is
//!   reported as `taken` ([`HotkeyStatusDto`], [`STATUS_EVENT`]) and the
//!   others still work. Windows refuses a combination another program
//!   registered; macOS refuses only one held exclusively (the system's own
//!   shortcuts take precedence without telling).
//! - **Recording a key** in the window: [`hotkeys_pause`] lets every key go
//!   while the window listens (a bound key never reaches the window), and
//!   binds them again after.

use std::collections::BTreeMap;
use std::sync::{Mutex, PoisonError};

use rail_hud_ipc::hotkeys::{HotkeyAction, HotkeyBinding, HotkeyEffect, dispatch};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::StoreState;
use crate::hud::HudState;

/// The window event when a binding's state changed (bound, taken, paused);
/// no payload: the window asks [`hotkey_status`] again.
pub const STATUS_EVENT: &str = "hotkeys-changed";

/// How a binding stands with the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Bound {
    /// Registered: the key works.
    Active,
    /// Another program holds the combination.
    Taken,
    /// The system refused it for another reason (a key it cannot bind).
    Failed,
    /// Let go while the window records a key.
    Paused,
}

/// One binding and how it stands, for the Tables screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatusDto {
    pub action: HotkeyAction,
    pub keys: String,
    pub state: Bound,
}

/// Why the system did not register a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisterError {
    Taken,
    Failed(String),
}

/// The system's hotkeys as [`bind`] uses them: the plugin in the app, a
/// fake in tests.
pub trait Keys {
    /// Register `keys`; the id the system's events carry.
    fn register(&mut self, keys: &str) -> Result<u32, RegisterError>;
    /// Let every key this app registered go.
    fn unregister_all(&mut self);
}

/// What is bound now.
#[derive(Debug, Default)]
struct Inner {
    /// The user's bindings as last applied.
    bindings: Vec<HotkeyBinding>,
    /// The system's id of each registered key, and its action.
    registered: BTreeMap<u32, HotkeyAction>,
    status: Vec<HotkeyStatusDto>,
    /// The window is recording a key: nothing is registered.
    paused: bool,
}

/// The hotkeys, kept as app state.
#[derive(Debug, Default)]
pub struct HotkeyState(Mutex<Inner>);

impl HotkeyState {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every binding and how it stands.
    pub fn status(&self) -> Vec<HotkeyStatusDto> {
        self.inner().status.clone()
    }

    /// The action of the key the system reported (its id), if one of ours.
    pub fn action_of(&self, id: u32) -> Option<HotkeyAction> {
        self.inner().registered.get(&id).copied()
    }

    /// Bind `bindings` with `keys` (every earlier key let go first), or
    /// none while paused; each binding's state kept. Whether any state
    /// changed.
    pub fn bind(&self, bindings: &[HotkeyBinding], keys: &mut dyn Keys) -> bool {
        let mut inner = self.inner();
        inner.bindings = bindings.to_vec();
        apply(&mut inner, keys)
    }

    /// Pause (the window records a key) or bind again. Whether any state
    /// changed.
    pub fn set_paused(&self, paused: bool, keys: &mut dyn Keys) -> bool {
        let mut inner = self.inner();
        if inner.paused == paused {
            return false;
        }
        inner.paused = paused;
        apply(&mut inner, keys)
    }
}

/// Register `inner.bindings` afresh; whether the states changed.
fn apply(inner: &mut Inner, keys: &mut dyn Keys) -> bool {
    keys.unregister_all();
    inner.registered.clear();
    let mut status = Vec::new();
    for binding in &inner.bindings {
        if binding.action == HotkeyAction::Unknown {
            continue; // a newer build's: never run here
        }
        let state = if inner.paused {
            Bound::Paused
        } else {
            match keys.register(&binding.keys) {
                Ok(id) => {
                    inner.registered.insert(id, binding.action);
                    Bound::Active
                }
                Err(RegisterError::Taken) => {
                    log::info!("hotkeys: {} is taken by another program", binding.keys);
                    Bound::Taken
                }
                Err(RegisterError::Failed(error)) => {
                    log::warn!("hotkeys: {}: {error}", binding.keys);
                    Bound::Failed
                }
            }
        };
        status.push(HotkeyStatusDto {
            action: binding.action,
            keys: binding.keys.clone(),
            state,
        });
    }
    let changed = status != inner.status;
    inner.status = status;
    changed
}

/// The plugin as [`Keys`].
struct PluginKeys<'a, R: Runtime>(&'a tauri_plugin_global_shortcut::GlobalShortcut<R>);

impl<R: Runtime> Keys for PluginKeys<'_, R> {
    fn register(&mut self, keys: &str) -> Result<u32, RegisterError> {
        let shortcut = keys
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|e| RegisterError::Failed(e.to_string()))?;
        match self.0.register(shortcut) {
            Ok(()) => Ok(shortcut.id()),
            Err(error) => Err(classify(&error.to_string())),
        }
    }

    fn unregister_all(&mut self) {
        if let Err(error) = self.0.unregister_all() {
            log::warn!("hotkeys: letting the keys go: {error}");
        }
    }
}

/// The plugin's error as a [`RegisterError`]: Windows says a combination
/// is "already registered" (`ERROR_HOTKEY_ALREADY_REGISTERED`), macOS that
/// `RegisterEventHotKey` failed (another program holds it exclusively).
pub fn classify(error: &str) -> RegisterError {
    let lower = error.to_ascii_lowercase();
    if lower.contains("already registered") || lower.contains("registereventhotkey failed") {
        RegisterError::Taken
    } else {
        RegisterError::Failed(error.to_owned())
    }
}

/// The plugin, with the handler that runs a pressed key.
fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                pressed(app, shortcut.id());
            }
        })
        .build()
}

/// At start (`setup`): the state, the plugin - added here rather than on
/// the builder, so a system that refuses it (no hotkey manager) leaves the
/// app running without hotkeys - and the stored bindings bound.
pub fn setup<R: Runtime>(app: &AppHandle<R>, bindings: &[HotkeyBinding]) {
    app.manage(HotkeyState::default());
    if let Err(error) = app.plugin(plugin()) {
        log::warn!("hotkeys: unavailable on this system: {error}");
        return;
    }
    apply_bindings(app, bindings);
}

/// Bind `bindings` with the system (at start, after every save and pull),
/// the window told when a state changed. Without the plugin (tests):
/// nothing.
pub fn apply_bindings<R: Runtime>(app: &AppHandle<R>, bindings: &[HotkeyBinding]) {
    let (Some(state), Some(plugin)) = (
        app.try_state::<HotkeyState>(),
        app.try_state::<tauri_plugin_global_shortcut::GlobalShortcut<R>>(),
    ) else {
        return;
    };
    if state.bind(bindings, &mut PluginKeys(plugin.inner())) {
        notify(app);
    }
}

fn notify<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.emit(STATUS_EVENT, ()) {
        log::debug!("{STATUS_EVENT}: {error}");
    }
}

/// A key of ours was pressed: its action, off the thread that reported it
/// (the store's write waits for the writer).
fn pressed<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let Some(action) = app
        .try_state::<HotkeyState>()
        .and_then(|state| state.action_of(id))
    else {
        return;
    };
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("rail-hotkey".to_owned())
        .spawn(move || run(&app, action));
    if let Err(error) = spawned {
        log::warn!("hotkeys: no thread for {action:?}: {error}");
    }
}

/// What `action` does now (see the module's documentation). Whether
/// anything was done.
pub fn run<R: Runtime>(app: &AppHandle<R>, action: HotkeyAction) -> bool {
    let (Some(store), Some(hud)) = (app.try_state::<StoreState>(), app.try_state::<HudState>())
    else {
        return false;
    };
    match dispatch(action, &hud.table_settings().tiling) {
        HotkeyEffect::Settings(next) => {
            let saved = crate::tiling::writer(&store)
                .and_then(|writer| crate::tiling::write_tiling(&writer, &next));
            if let Err(error) = saved {
                log::warn!("hotkeys: {action:?}: {error}");
                return false;
            }
            log::info!("hotkeys: {action:?}");
            hud.tiling_written(next);
            if let Err(error) = app.emit(crate::tiling::SETTINGS_EVENT, ()) {
                log::debug!("{}: {error}", crate::tiling::SETTINGS_EVENT);
            }
            true
        }
        HotkeyEffect::Message(message) => {
            let sent = hud.send(message);
            log::info!(
                "hotkeys: {action:?}{}",
                if sent {
                    ""
                } else {
                    " (the HUD is not running)"
                }
            );
            sent
        }
        HotkeyEffect::Nothing(why) => {
            log::info!("hotkeys: {action:?}: {why}");
            false
        }
    }
}

/// Every binding and how it stands with the system (none bound: empty).
#[tauri::command]
pub fn hotkey_status(state: State<'_, HotkeyState>) -> Vec<HotkeyStatusDto> {
    state.status()
}

/// The window starts (`true`) or stops recording a key: every key is let
/// go meanwhile, so the one pressed reaches the window, then bound again.
#[tauri::command]
pub async fn hotkeys_pause<R: Runtime>(app: AppHandle<R>, paused: bool) {
    let (Some(state), Some(plugin)) = (
        app.try_state::<HotkeyState>(),
        app.try_state::<tauri_plugin_global_shortcut::GlobalShortcut<R>>(),
    ) else {
        return;
    };
    if state.set_paused(paused, &mut PluginKeys(plugin.inner())) {
        notify(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_hud_ipc::settings::TilingSettings;

    /// The system as a test sets it up: combinations another program holds,
    /// and one it cannot bind.
    #[derive(Default)]
    struct FakeKeys {
        taken: Vec<&'static str>,
        broken: Vec<&'static str>,
        registered: Vec<String>,
        next: u32,
    }

    impl Keys for FakeKeys {
        fn register(&mut self, keys: &str) -> Result<u32, RegisterError> {
            if self.taken.contains(&keys) {
                return Err(RegisterError::Taken);
            }
            if self.broken.contains(&keys) {
                return Err(RegisterError::Failed("no scancode".into()));
            }
            self.registered.push(keys.to_owned());
            self.next += 1;
            Ok(self.next)
        }

        fn unregister_all(&mut self) {
            self.registered.clear();
        }
    }

    fn bind(action: HotkeyAction, keys: &str) -> HotkeyBinding {
        HotkeyBinding {
            action,
            keys: keys.into(),
        }
    }

    /// A taken key is reported and the others still work; a newer build's
    /// action is never registered; binding again lets the old keys go;
    /// pausing lets every key go and resuming binds them again.
    #[test]
    fn bindings_and_taken_keys() {
        let state = HotkeyState::default();
        let mut keys = FakeKeys {
            taken: vec!["Ctrl+Alt+KeyT"],
            broken: vec!["F13"],
            ..FakeKeys::default()
        };
        assert!(state.status().is_empty());
        let bindings = vec![
            bind(HotkeyAction::Retile, "Ctrl+Alt+KeyR"),
            bind(HotkeyAction::ToggleTiling, "Ctrl+Alt+KeyT"),
            bind(HotkeyAction::NextLayout, "F13"),
            bind(HotkeyAction::Unknown, "F9"),
        ];
        assert!(state.bind(&bindings, &mut keys));
        let states: Vec<(HotkeyAction, Bound)> =
            state.status().iter().map(|s| (s.action, s.state)).collect();
        assert_eq!(
            states,
            [
                (HotkeyAction::Retile, Bound::Active),
                (HotkeyAction::ToggleTiling, Bound::Taken),
                (HotkeyAction::NextLayout, Bound::Failed),
            ]
        );
        assert_eq!(keys.registered, ["Ctrl+Alt+KeyR"]);
        assert_eq!(state.action_of(1), Some(HotkeyAction::Retile));
        assert_eq!(state.action_of(2), None);
        assert!(!state.bind(&bindings, &mut keys), "the same again");

        // Paused: nothing registered, every binding says so; then back.
        assert!(state.set_paused(true, &mut keys));
        assert!(keys.registered.is_empty());
        assert!(state.status().iter().all(|s| s.state == Bound::Paused));
        assert_eq!(state.action_of(1), None);
        assert!(!state.set_paused(true, &mut keys));
        assert!(state.set_paused(false, &mut keys));
        assert_eq!(keys.registered, ["Ctrl+Alt+KeyR"]);

        // Fewer bindings: the old keys go.
        assert!(state.bind(&[], &mut keys));
        assert!(keys.registered.is_empty() && state.status().is_empty());
    }

    #[test]
    fn errors_are_sorted() {
        assert_eq!(
            classify("HotKey already registered: HotKey { mods: CONTROL, key: KeyR, id: 1 }"),
            RegisterError::Taken
        );
        assert_eq!(
            classify("Unable to register hotkey: RegisterEventHotKey failed for KeyR"),
            RegisterError::Taken
        );
        assert!(matches!(
            classify("Unable to register hotkey: Unknown VKCode for F24"),
            RegisterError::Failed(_)
        ));
    }

    /// Every key a binding may name is one the plugin reads, as the same
    /// key: what the window records is what the system registers.
    #[test]
    fn every_allowed_key_parses() {
        let mut keys: Vec<String> = Vec::new();
        keys.extend((b'A'..=b'Z').map(|c| format!("Key{}", char::from(c))));
        keys.extend((0..=9).map(|d| format!("Digit{d}")));
        keys.extend((0..=9).map(|d| format!("Numpad{d}")));
        keys.extend((1..=24).map(|n| format!("F{n}")));
        keys.extend(
            [
                "NumpadAdd",
                "NumpadSubtract",
                "NumpadMultiply",
                "NumpadDivide",
                "NumpadDecimal",
                "ArrowUp",
                "ArrowDown",
                "ArrowLeft",
                "ArrowRight",
                "Home",
                "End",
                "PageUp",
                "PageDown",
                "Insert",
                "Delete",
                "Space",
                "Backquote",
                "Minus",
                "Equal",
                "BracketLeft",
                "BracketRight",
                "Backslash",
                "Semicolon",
                "Quote",
                "Comma",
                "Period",
                "Slash",
            ]
            .map(str::to_owned),
        );
        for key in &keys {
            assert!(rail_hud_ipc::hotkeys::key_allowed(key), "{key}");
            let text = format!("Ctrl+Alt+Shift+Super+{key}");
            let shortcut: tauri_plugin_global_shortcut::Shortcut =
                text.parse().unwrap_or_else(|e| panic!("{text}: {e}"));
            use tauri_plugin_global_shortcut::Modifiers;
            assert!(shortcut.mods.contains(
                Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER
            ));
            assert_eq!(format!("{:?}", shortcut.key), *key, "{text}");
        }
        assert!(!rail_hud_ipc::hotkeys::key_allowed("Escape"));
    }

    /// The app's side of a key with no HUD and no store: nothing happens
    /// and nothing breaks.
    #[test]
    fn a_key_without_the_app_state_does_nothing() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app");
        assert!(!run(app.handle(), HotkeyAction::Retile));
        apply_bindings(app.handle(), &TilingSettings::default().hotkeys);
    }

    /// A key pressed in the app: "Tiling on / off" and the layout keys are
    /// saved as the Tables screen saves them (the store, the HUD's copy);
    /// "Re-tile" with no HUD running sends nothing; the layout keys with
    /// tiling off do nothing.
    #[test]
    fn a_key_changes_the_saved_settings() {
        use rail_hud_ipc::settings::{Layout, LayoutRef, Slot, SlotKind, SlotRect};
        let dir = std::env::temp_dir().join(format!("rail-app-hotkeys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        let stats = crate::stats::StatsState::start(&store);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("a mock app");
        let hud = HudState::start(
            app.handle(),
            &store,
            stats.clone(),
            crate::sync::SyncSlot::default(),
            None,
        );
        let layout = Layout {
            id: "two".into(),
            name: "Two".into(),
            slots: vec![Slot {
                id: "s1".into(),
                monitor: 0,
                rect: SlotRect {
                    x: 0,
                    y: 0,
                    width: 500,
                    height: 1000,
                },
                kind: SlotKind::Play,
                rooms: None,
                stack: true,
            }],
            auto_switch: Vec::new(),
        };
        let saved = TilingSettings {
            layouts: vec![layout],
            hotkeys: vec![bind(HotkeyAction::ToggleTiling, "Ctrl+Alt+KeyT")],
            ..TilingSettings::default()
        };
        crate::tiling::write_tiling(&crate::tiling::writer(&store).expect("writer"), &saved)
            .expect("saved");
        hud.settings_pulled(crate::tiling::read_store(&store));
        app.manage(store);
        app.manage(hud);
        let handle = app.handle();
        let stored = || crate::tiling::read_store(&handle.state::<StoreState>()).tiling;

        assert!(!run(handle, HotkeyAction::NextLayout), "tiling is off");
        assert!(run(handle, HotkeyAction::ToggleTiling));
        assert!(stored().enabled);
        assert!(handle.state::<HudState>().table_settings().tiling.enabled);
        assert_eq!(stored().hotkeys, saved.hotkeys, "the bindings stay");
        assert!(run(handle, HotkeyAction::NextLayout));
        assert_eq!(stored().active, LayoutRef::Custom { id: "two".into() });
        assert!(run(handle, HotkeyAction::PreviousLayout));
        assert_eq!(stored().active, LayoutRef::Auto);
        assert!(!run(handle, HotkeyAction::Retile), "no HUD running");
        assert!(!run(handle, HotkeyAction::RollRng), "no HUD running");
        assert!(run(handle, HotkeyAction::ToggleTiling));
        assert!(!stored().enabled);
        handle.state::<HudState>().stop();
        stats.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
