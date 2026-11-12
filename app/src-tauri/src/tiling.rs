//! (T3, docs/research/TABLE-TILING.md §4.1, §4.5) Table tiling and the RNG
//! from the app's side: the user's settings kept in the store, synced, and
//! sent to the HUD process, which does the tiling (and, from T4, draws the
//! RNG). The Tables screen (T5) calls the commands.
//!
//! - **The model** is `rail_hud_ipc::settings` ([`TilingSettings`],
//!   [`RngSettings`]), shared with the HUD. Every write is validated first
//!   (a refused object is an error to the window and is not stored).
//! - **Storage**: the local store's `hud_settings`, kinds `tiling` and
//!   `rng`, key [`SETTINGS_KEY`] (`rail_store::HudSettingKind`). The sync
//!   worker sends them as Supabase `hud_layouts` rows of the same kinds and
//!   takes the account's back, last writer wins (R3.9's path); a pull that
//!   brought new settings reaches the HUD and the window
//!   ([`SETTINGS_EVENT`]). Rows that do not parse or validate read as the
//!   defaults (tiling and the RNG off).
//! - **To the HUD** (`crate::hud::HudState`): `tiling_changed` /
//!   `rng_changed` on every write, and both again after every handshake, so
//!   a restarted HUD has them; `retile` from [`retile_tables`] and the
//!   tray's "Re-tile tables".
//! - (T7) **Hotkeys**: the bindings in the tiling settings are bound with
//!   the system after every save and pull (`crate::hotkeys`).
//! - **Free**: tiling and the RNG need no plan. Where the plan holds the
//!   HUD's panels back (R6.4, Free with enforcement on), the HUD process
//!   still starts when either is on, with no panels (`--panels off`).
//!   Their *sync* is `desktop_sync`, as all of the HUD's.
//! - **Whose windows move** is the HUD's policy first (T0's
//!   `TilingPermit`, `sites.json` `tiling.allowed`), then the user's
//!   per-room switch here; the RNG likewise needs the room's `RngPermit`.
//!   A switch never allows a room the policy does not.

use rail_hud_ipc::settings::{Invalid, RngSettings, SETTINGS_KEY, Slot, TilingSettings};
use rail_store::HudSettingKind;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::StoreState;
use crate::hud::HudState;

/// The window event when the settings changed outside the window (a pull
/// from another computer); no payload: the window asks again.
pub const SETTINGS_EVENT: &str = "tiling-settings-changed";

/// The user's tiling and RNG settings together.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableSettings {
    pub tiling: TilingSettings,
    pub rng: RngSettings,
}

impl TableSettings {
    /// Either is on: the HUD process is wanted for them even when the plan
    /// holds its panels back.
    pub fn wanted(&self) -> bool {
        self.tiling.enabled || self.rng.enabled
    }
}

/// One kind's settings from the store: the defaults when there are none or
/// they do not parse or validate (logged).
fn read_one<T>(
    reader: &rail_store::Reader,
    kind: HudSettingKind,
    validate: fn(&T) -> Result<(), Invalid>,
) -> T
where
    T: DeserializeOwned + Default,
{
    let text = match reader.hud_setting(kind, SETTINGS_KEY) {
        Ok(Some((text, _))) => text,
        Ok(None) => return T::default(),
        Err(error) => {
            log::warn!("tiling: reading the {} settings: {error}", kind.as_str());
            return T::default();
        }
    };
    match serde_json::from_str::<T>(&text) {
        Ok(settings) => match validate(&settings) {
            Ok(()) => settings,
            Err(error) => {
                log::warn!("tiling: the stored {} settings: {error}", kind.as_str());
                T::default()
            }
        },
        Err(error) => {
            log::warn!("tiling: the stored {} settings: {error}", kind.as_str());
            T::default()
        }
    }
}

/// Both settings from the store.
pub fn read(reader: &rail_store::Reader) -> TableSettings {
    TableSettings {
        tiling: read_one(reader, HudSettingKind::Tiling, TilingSettings::validate),
        rng: read_one(reader, HudSettingKind::Rng, RngSettings::validate),
    }
}

/// Both settings from the app's store (the defaults without one).
pub fn read_store(store: &StoreState) -> TableSettings {
    store
        .store
        .as_ref()
        .map(|store| read(store.reader()))
        .unwrap_or_default()
}

fn write_one(
    writer: &rail_store::WriterHandle,
    kind: HudSettingKind,
    settings: &impl Serialize,
) -> Result<(), String> {
    let json = serde_json::to_string(settings).map_err(|error| error.to_string())?;
    writer
        .save_hud_setting(kind, SETTINGS_KEY, &json)
        .map_err(|error| error.to_string())
}

/// Validate and store the tiling settings.
pub fn write_tiling(
    writer: &rail_store::WriterHandle,
    settings: &TilingSettings,
) -> Result<(), String> {
    settings.validate().map_err(|error| error.to_string())?;
    write_one(writer, HudSettingKind::Tiling, settings)
}

/// Validate and store the RNG settings.
pub fn write_rng(writer: &rail_store::WriterHandle, settings: &RngSettings) -> Result<(), String> {
    settings.validate().map_err(|error| error.to_string())?;
    write_one(writer, HudSettingKind::Rng, settings)
}

pub(crate) fn writer(store: &StoreState) -> Result<rail_store::WriterHandle, String> {
    store
        .store
        .as_ref()
        .ok_or("the store is not open")?
        .writer()
        .map_err(|error| error.to_string())
}

/// The user's table tiling settings (the defaults until they saved some).
#[tauri::command]
pub fn get_tiling_settings(store: State<'_, StoreState>) -> TilingSettings {
    read_store(&store).tiling
}

/// Save the table tiling settings (refused when they do not validate), then
/// the HUD applies them and the sync worker sends them.
#[tauri::command]
pub async fn set_tiling_settings<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    settings: TilingSettings,
) -> Result<(), String> {
    write_tiling(&writer(&store)?, &settings)?;
    // (T7) The hotkeys as saved, bound with the system.
    crate::hotkeys::apply_bindings(&app, &settings.hotkeys);
    hud.tiling_written(settings);
    Ok(())
}

/// The user's RNG settings (the defaults until they saved some).
#[tauri::command]
pub fn get_rng_settings(store: State<'_, StoreState>) -> RngSettings {
    read_store(&store).rng
}

/// Save the RNG settings (refused when they do not validate), then the HUD
/// keeps them and the sync worker sends them.
#[tauri::command]
pub async fn set_rng_settings(
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    settings: RngSettings,
) -> Result<(), String> {
    write_rng(&writer(&store)?, &settings)?;
    hud.rng_written(settings);
    Ok(())
}

/// Lay every tiled table out again, the ones moved by hand too. Whether the
/// HUD heard it (it is not running: nothing to do).
#[tauri::command]
pub fn retile_tables(hud: State<'_, HudState>) -> bool {
    hud.retile()
}

/// (T5) "Save current arrangement": the slots of the places the tiled
/// tables take now (the HUD measures them), for a layout the Tables screen
/// names and saves with [`set_tiling_settings`]. Empty while tiling is off
/// or tiles no table.
#[tauri::command]
pub async fn capture_tiling_layout(hud: State<'_, HudState>) -> Result<Vec<Slot>, String> {
    hud.capture_layout().await
}

/// The tray's "Re-tile tables".
pub fn retile_from_tray<R: Runtime>(app: &AppHandle<R>) {
    let sent = app.try_state::<HudState>().is_some_and(|hud| hud.retile());
    log::info!(
        "tray: re-tile tables{}",
        if sent {
            ""
        } else {
            " (the HUD is not running)"
        }
    );
}

/// (Sync) A pull brought the account's rows: settings that changed reach
/// the HUD, and the window hears it.
pub fn pulled<R: Runtime>(app: &AppHandle<R>) {
    let (Some(store), Some(hud)) = (app.try_state::<StoreState>(), app.try_state::<HudState>())
    else {
        return;
    };
    let now = read_store(&store);
    let hotkeys = now.tiling.hotkeys.clone();
    if hud.settings_pulled(now) {
        // (T7) Another computer's hotkeys, bound here too.
        crate::hotkeys::apply_bindings(app, &hotkeys);
        if let Err(error) = app.emit(SETTINGS_EVENT, ()) {
            log::debug!("{SETTINGS_EVENT}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_hud_ipc::settings::{LayoutRef, RngBand};

    /// Saved and read back through the store; refused settings are not
    /// stored; a stored row that does not validate reads as the defaults;
    /// both travel as dirty sync rows of their kinds.
    #[test]
    fn settings_round_trip_through_the_store() {
        let dir = std::env::temp_dir().join(format!("rail-app-tiling-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = StoreState::open(dir.join(rail_store::FILE_NAME));
        assert_eq!(read_store(&store), TableSettings::default());
        assert!(!read_store(&store).wanted());

        let w = writer(&store).expect("writer");
        let tiling = TilingSettings {
            enabled: true,
            close_gaps: true,
            per_room: [("winamax".to_owned(), false)].into_iter().collect(),
            // (T7) The hotkeys travel with them.
            hotkeys: vec![rail_hud_ipc::hotkeys::HotkeyBinding {
                action: rail_hud_ipc::hotkeys::HotkeyAction::Retile,
                keys: "Ctrl+Alt+KeyR".into(),
            }],
            ..TilingSettings::default()
        };
        write_tiling(&w, &tiling).expect("saved");
        let rng = RngSettings {
            enabled: true,
            min: 0,
            max: 99,
            bands: vec![RngBand {
                up_to: 99,
                colour: "#336699".into(),
                label: Some("Go".into()),
            }],
            // (T5 follow-up) The widget's size and opacity travel too.
            scale: 160,
            opacity: 55,
            ..RngSettings::default()
        };
        write_rng(&w, &rng).expect("saved");
        let read = read_store(&store);
        assert_eq!(read.tiling, tiling);
        assert_eq!(read.rng, rng);
        assert!(read.wanted());

        // Refused: nothing stored, the error says why.
        let error = write_tiling(
            &w,
            &TilingSettings {
                active: LayoutRef::Custom { id: "gone".into() },
                ..tiling.clone()
            },
        )
        .expect_err("refused");
        assert!(error.contains("gone"), "{error}");
        // (T7) The same keys for two actions.
        let mut twice = tiling.clone();
        twice.hotkeys.push(rail_hud_ipc::hotkeys::HotkeyBinding {
            action: rail_hud_ipc::hotkeys::HotkeyAction::ToggleTiling,
            keys: "Ctrl+Alt+KeyR".into(),
        });
        assert!(write_tiling(&w, &twice).is_err());
        assert!(
            write_rng(
                &w,
                &RngSettings {
                    max: 0,
                    ..RngSettings::default()
                }
            )
            .is_err()
        );
        assert_eq!(read_store(&store).tiling, tiling);

        // A row from elsewhere that does not validate: the defaults.
        w.save_hud_setting(HudSettingKind::Rng, SETTINGS_KEY, r#"{"min":5,"max":1}"#)
            .expect("raw");
        assert_eq!(read_store(&store).rng, RngSettings::default());
        w.save_hud_setting(HudSettingKind::Rng, SETTINGS_KEY, r#"{"opacity":5}"#)
            .expect("raw");
        assert_eq!(read_store(&store).rng, RngSettings::default());
        // (T5 follow-up) A T4 row (no size, no opacity) reads with both at 100 %.
        w.save_hud_setting(HudSettingKind::Rng, SETTINGS_KEY, r#"{"enabled":true}"#)
            .expect("raw");
        let old = read_store(&store).rng;
        assert!(old.enabled);
        assert_eq!((old.scale, old.opacity), (100, 100));

        let opened = store.store.as_ref().expect("store");
        let kinds: Vec<&str> = opened
            .reader()
            .hud_sync_dirty()
            .expect("dirty")
            .iter()
            .map(|row| row.kind.as_str())
            .collect();
        assert!(
            kinds.contains(&"tiling") && kinds.contains(&"rng"),
            "{kinds:?}"
        );
        drop((w, store));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
