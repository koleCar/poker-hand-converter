//! (T7, docs/research/TABLE-TILING.md §4.3, §5) Global hotkeys for table
//! tiling: the bindings the user stores in [`TilingSettings::hotkeys`]
//! (synced with the rest of tiling's settings), their validation, and what
//! each one does ([`dispatch`]) - the one place both the app (which owns
//! the keys) and the tests that drive the HUD's engine read it from.
//!
//! **Window management only.** Every action moves table windows or rolls
//! the RNG widget, through the permits that already decide them: the
//! tiling actions reach the HUD as `tiling_changed` / `retile`, and the
//! HUD's tiler holds only the tables of rooms whose policy gives a
//! `TilingPermit`; [`HotkeyAction::RollRng`] reaches it as `roll_rng`,
//! which rolls only over a table whose room gives an `RngPermit` (none
//! today, so it is inert). Nothing here clicks, types or acts inside a
//! table - no fold / call / bet keys: the rooms forbid them, and they are
//! out of scope.
//!
//! **Keys** ([`HotkeyBinding::keys`]): `Ctrl`, `Alt`, `Shift`, `Super`
//! (Command on macOS, the Windows key) in that order, then one key named
//! as the browser's `KeyboardEvent.code` names it (`KeyR`, `Digit1`,
//! `F5`, `ArrowUp`, `Numpad3`) - e.g. `Ctrl+Alt+KeyR`. The app hands the
//! same text to the system (`tauri-plugin-global-shortcut` parses it).
//! [`check_keys`] refuses what would hijack typing or the system: a key
//! other than F1 - F24 needs Ctrl, Alt or Super; a lone Ctrl or Super
//! with A, C, Q, S, V, W, X, Y or Z (every app's copy, paste, save, quit,
//! close); Alt+F4.
//!
//! **No binding by default**: a global hotkey takes its keys from every
//! other program - the poker clients' own hotkeys included - and no
//! combination is free on every machine, so Rail binds nothing until the
//! user records a key.

use serde::{Deserialize, Serialize};

use crate::protocol::AppMessage;
use crate::settings::{Invalid, LayoutRef, TilingSettings};

/// Bindings a user keeps at most.
pub const MAX_HOTKEYS: usize = 16;

/// The modifiers, in the order a binding names them.
pub const MODIFIERS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Super"];

/// What a hotkey does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    /// Lay every tiled table out again, the ones moved by hand too (the
    /// tray's "Re-tile tables").
    Retile,
    /// The next layout in force: the auto grid, then the user's layouts in
    /// their order, round.
    NextLayout,
    /// The layout before.
    PreviousLayout,
    /// Tiling on or off.
    ToggleTiling,
    /// Roll the RNG on the table in front, where the room allows the RNG.
    RollRng,
    /// An action of a newer build: kept in the list (its keys still count
    /// as taken), never run.
    #[serde(other)]
    Unknown,
}

impl HotkeyAction {
    /// Every action this build runs, in the order the app lists them.
    pub const ALL: [Self; 5] = [
        Self::Retile,
        Self::NextLayout,
        Self::PreviousLayout,
        Self::ToggleTiling,
        Self::RollRng,
    ];
}

/// One binding: an action and its keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBinding {
    pub action: HotkeyAction,
    /// `Ctrl+Alt+KeyR` (see the module's documentation).
    pub keys: String,
}

/// The keys a binding may end with (`KeyboardEvent.code`).
pub fn key_allowed(key: &str) -> bool {
    let tail = |prefix: &str| key.strip_prefix(prefix);
    if let Some(letter) = tail("Key") {
        return letter.len() == 1 && letter.bytes().all(|b| b.is_ascii_uppercase());
    }
    if let Some(digit) = tail("Digit")
        .or_else(|| tail("Numpad"))
        .filter(|d| d.len() == 1)
    {
        return digit.bytes().all(|b| b.is_ascii_digit());
    }
    if function_key(key).is_some() {
        return true;
    }
    matches!(
        key,
        "NumpadAdd"
            | "NumpadSubtract"
            | "NumpadMultiply"
            | "NumpadDivide"
            | "NumpadDecimal"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "Insert"
            | "Delete"
            | "Space"
            | "Backquote"
            | "Minus"
            | "Equal"
            | "BracketLeft"
            | "BracketRight"
            | "Backslash"
            | "Semicolon"
            | "Quote"
            | "Comma"
            | "Period"
            | "Slash"
    )
}

/// `F1` - `F24`: its number.
fn function_key(key: &str) -> Option<u32> {
    let digits = key.strip_prefix('F')?;
    let n: u32 = digits.parse().ok()?;
    (!digits.starts_with('0')
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (1..=24).contains(&n))
    .then_some(n)
}

/// A binding's keys split: the modifiers (in [`MODIFIERS`] order, each
/// once) and the key; `Err` says what is wrong.
pub fn parse_keys(keys: &str) -> Result<(Vec<&str>, &str), Invalid> {
    let bad = |why: &str| Err(Invalid(format!("hotkey {keys:?}: {why}")));
    let mut parts: Vec<&str> = keys.split('+').collect();
    let Some(key) = parts.pop() else {
        return bad("no key");
    };
    if !key_allowed(key) {
        return bad("not a key Rail can bind");
    }
    let mut last = None;
    for part in &parts {
        let Some(place) = MODIFIERS.iter().position(|m| m == part) else {
            return bad("modifiers are Ctrl, Alt, Shift and Super");
        };
        if last.is_some_and(|l| place <= l) {
            return bad("modifiers go once each, as Ctrl+Alt+Shift+Super");
        }
        last = Some(place);
    }
    Ok((parts, key))
}

/// Whether `keys` is a binding Rail accepts (see the module's
/// documentation).
pub fn check_keys(keys: &str) -> Result<(), Invalid> {
    let (modifiers, key) = parse_keys(keys)?;
    let has = |m: &str| modifiers.contains(&m);
    let bad = |why: &str| Err(Invalid(format!("hotkey {keys:?}: {why}")));
    if function_key(key).is_none() && !(has("Ctrl") || has("Alt") || has("Super")) {
        return bad("needs Ctrl, Alt or Super (a function key alone is fine)");
    }
    let lone = modifiers.len() == 1 && (has("Ctrl") || has("Super"));
    if lone
        && matches!(
            key,
            "KeyA" | "KeyC" | "KeyQ" | "KeyS" | "KeyV" | "KeyW" | "KeyX" | "KeyY" | "KeyZ"
        )
    {
        return bad("every program uses it");
    }
    if modifiers == ["Alt"] && key == "F4" {
        return bad("it closes windows");
    }
    Ok(())
}

/// The bindings: at most [`MAX_HOTKEYS`], valid keys, each action once
/// (an [`HotkeyAction::Unknown`] may repeat) and each key combination
/// once.
pub fn check(bindings: &[HotkeyBinding]) -> Result<(), Invalid> {
    if bindings.len() > MAX_HOTKEYS {
        return Err(Invalid(format!("at most {MAX_HOTKEYS} hotkeys")));
    }
    for (i, binding) in bindings.iter().enumerate() {
        check_keys(&binding.keys)?;
        let before = &bindings[..i];
        if binding.action != HotkeyAction::Unknown
            && before.iter().any(|b| b.action == binding.action)
        {
            return Err(Invalid(format!(
                "two hotkeys for {:?}",
                serde_json::to_value(binding.action).unwrap_or_default()
            )));
        }
        if before.iter().any(|b| b.keys == binding.keys) {
            return Err(Invalid(format!("hotkey {:?} is bound twice", binding.keys)));
        }
    }
    Ok(())
}

/// What a hotkey comes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyEffect {
    /// New tiling settings: the app stores them, sends `tiling_changed`
    /// and the window shows them (another layout, tiling on or off).
    Settings(TilingSettings),
    /// A message for the HUD (`retile`, `roll_rng`).
    Message(AppMessage),
    /// Nothing to do, and why (for the log).
    Nothing(&'static str),
}

/// What `action` does with the tiling settings in force. The layout
/// actions step through the auto grid and the user's layouts in their
/// order, round (a rule by table count still wins over the layout chosen,
/// as it does over the screen's picker); the tiling actions do nothing
/// while tiling is off, except switching it on.
pub fn dispatch(action: HotkeyAction, tiling: &TilingSettings) -> HotkeyEffect {
    match action {
        HotkeyAction::ToggleTiling => HotkeyEffect::Settings(TilingSettings {
            enabled: !tiling.enabled,
            ..tiling.clone()
        }),
        HotkeyAction::Retile if tiling.enabled => HotkeyEffect::Message(AppMessage::Retile),
        HotkeyAction::NextLayout | HotkeyAction::PreviousLayout if tiling.enabled => {
            let ring: Vec<LayoutRef> = std::iter::once(LayoutRef::Auto)
                .chain(
                    tiling
                        .layouts
                        .iter()
                        .map(|l| LayoutRef::Custom { id: l.id.clone() }),
                )
                .collect();
            if ring.len() < 2 {
                return HotkeyEffect::Nothing("no layout to switch to");
            }
            let at = ring.iter().position(|r| *r == tiling.active).unwrap_or(0);
            let next = if action == HotkeyAction::NextLayout {
                (at + 1) % ring.len()
            } else {
                (at + ring.len() - 1) % ring.len()
            };
            HotkeyEffect::Settings(TilingSettings {
                active: ring[next].clone(),
                ..tiling.clone()
            })
        }
        HotkeyAction::Retile | HotkeyAction::NextLayout | HotkeyAction::PreviousLayout => {
            HotkeyEffect::Nothing("tiling is off")
        }
        HotkeyAction::RollRng => HotkeyEffect::Message(AppMessage::RollRng),
        HotkeyAction::Unknown => HotkeyEffect::Nothing("an action of a newer Rail"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Layout, Slot, SlotKind, SlotRect};

    fn bind(action: HotkeyAction, keys: &str) -> HotkeyBinding {
        HotkeyBinding {
            action,
            keys: keys.into(),
        }
    }

    #[test]
    fn keys() {
        for good in [
            "Ctrl+Alt+KeyR",
            "Alt+Shift+Digit1",
            "Super+ArrowRight",
            "F5",
            "Shift+F13",
            "Ctrl+Shift+Super+Numpad3",
            "Alt+NumpadAdd",
            "Ctrl+Alt+Shift+Super+Slash",
            "Ctrl+KeyR",
            "Ctrl+Shift+KeyC",
            "Alt+KeyC",
            "Ctrl+F4",
        ] {
            assert_eq!(check_keys(good), Ok(()), "{good}");
        }
        for bad in [
            "",
            "KeyR",
            "Shift+KeyR",
            "Ctrl+Ctrl+KeyR",
            "Alt+Ctrl+KeyR",
            "Ctrl+",
            "Ctrl+Alt",
            "Ctrl+Alt+R",
            "Ctrl+Alt+Keyr",
            "Ctrl+Alt+Escape",
            "Ctrl+Alt+Tab",
            "Ctrl+Alt+Enter",
            "Ctrl+Alt+F25",
            "Ctrl+Alt+F0",
            "Ctrl+Alt+F05",
            "Meta+KeyR",
            "ctrl+KeyR",
            "Ctrl+KeyC",
            "Super+KeyQ",
            "Super+KeyW",
            "Ctrl+KeyV",
            "Alt+F4",
            "Ctrl+Alt+Digit10",
            "Ctrl+Alt+NumpadEnter",
        ] {
            assert!(check_keys(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            parse_keys("Ctrl+Shift+F2").expect("parsed"),
            (vec!["Ctrl", "Shift"], "F2")
        );
    }

    #[test]
    fn bindings() {
        let list = vec![
            bind(HotkeyAction::Retile, "Ctrl+Alt+KeyR"),
            bind(HotkeyAction::NextLayout, "Ctrl+Alt+ArrowRight"),
            bind(HotkeyAction::Unknown, "F9"),
            bind(HotkeyAction::Unknown, "F10"),
        ];
        assert_eq!(check(&list), Ok(()));
        let mut twice = list.clone();
        twice.push(bind(HotkeyAction::Retile, "F11"));
        assert!(
            check(&twice)
                .expect_err("action twice")
                .0
                .contains("retile")
        );
        let mut same_keys = list.clone();
        same_keys.push(bind(HotkeyAction::ToggleTiling, "Ctrl+Alt+KeyR"));
        assert!(
            check(&same_keys)
                .expect_err("keys twice")
                .0
                .contains("twice")
        );
        let mut unknown_same_keys = list.clone();
        unknown_same_keys.push(bind(HotkeyAction::ToggleTiling, "F9"));
        assert!(
            check(&unknown_same_keys).is_err(),
            "a newer action's keys are taken"
        );
        let many: Vec<HotkeyBinding> = (1..=17)
            .map(|n| bind(HotkeyAction::Unknown, &format!("F{n}")))
            .collect();
        assert!(check(&many).is_err());
        assert!(check(&[bind(HotkeyAction::RollRng, "KeyR")]).is_err());
    }

    /// The wire and storage form; an action this build does not know reads
    /// as `Unknown` instead of refusing the whole settings object.
    #[test]
    fn json() {
        let text =
            serde_json::to_string(&bind(HotkeyAction::PreviousLayout, "Alt+F2")).expect("json");
        assert_eq!(text, r#"{"action":"previousLayout","keys":"Alt+F2"}"#);
        let newer: HotkeyBinding =
            serde_json::from_str(r#"{"action":"focusNext","keys":"Alt+F3"}"#).expect("reads");
        assert_eq!(newer.action, HotkeyAction::Unknown);
        for action in HotkeyAction::ALL {
            let text = serde_json::to_string(&action).expect("json");
            assert_eq!(
                serde_json::from_str::<HotkeyAction>(&text).expect("back"),
                action
            );
        }
    }

    fn layout(id: &str) -> Layout {
        Layout {
            id: id.into(),
            name: id.to_uppercase(),
            slots: vec![Slot {
                id: "s1".into(),
                monitor: 0,
                rect: SlotRect {
                    x: 0,
                    y: 0,
                    width: 1000,
                    height: 1000,
                },
                kind: SlotKind::Play,
                rooms: None,
                stack: true,
            }],
            auto_switch: Vec::new(),
        }
    }

    #[test]
    fn what_each_action_does() {
        let on = TilingSettings {
            enabled: true,
            layouts: vec![layout("a"), layout("b")],
            ..TilingSettings::default()
        };
        let active = |effect: HotkeyEffect| match effect {
            HotkeyEffect::Settings(s) => s.active,
            other => panic!("{other:?}"),
        };
        let custom = |id: &str| LayoutRef::Custom { id: id.into() };
        // Auto -> a -> b -> auto, and back.
        assert_eq!(active(dispatch(HotkeyAction::NextLayout, &on)), custom("a"));
        let at_b = TilingSettings {
            active: custom("b"),
            ..on.clone()
        };
        assert_eq!(
            active(dispatch(HotkeyAction::NextLayout, &at_b)),
            LayoutRef::Auto
        );
        assert_eq!(
            active(dispatch(HotkeyAction::PreviousLayout, &on)),
            custom("b")
        );
        assert_eq!(
            active(dispatch(HotkeyAction::PreviousLayout, &at_b)),
            custom("a")
        );
        // No user layout: nothing to switch to.
        let alone = TilingSettings {
            layouts: Vec::new(),
            ..on.clone()
        };
        assert!(matches!(
            dispatch(HotkeyAction::NextLayout, &alone),
            HotkeyEffect::Nothing(_)
        ));
        assert_eq!(
            dispatch(HotkeyAction::Retile, &on),
            HotkeyEffect::Message(AppMessage::Retile)
        );
        assert_eq!(
            dispatch(HotkeyAction::RollRng, &on),
            HotkeyEffect::Message(AppMessage::RollRng)
        );
        // Tiling off: only the switch acts.
        let off = TilingSettings {
            enabled: false,
            ..on.clone()
        };
        for action in [
            HotkeyAction::Retile,
            HotkeyAction::NextLayout,
            HotkeyAction::PreviousLayout,
            HotkeyAction::Unknown,
        ] {
            assert!(
                matches!(dispatch(action, &off), HotkeyEffect::Nothing(_)),
                "{action:?}"
            );
        }
        match dispatch(HotkeyAction::ToggleTiling, &off) {
            HotkeyEffect::Settings(s) => assert_eq!(s, on),
            other => panic!("{other:?}"),
        }
        match dispatch(HotkeyAction::ToggleTiling, &on) {
            HotkeyEffect::Settings(s) => assert_eq!(s, off),
            other => panic!("{other:?}"),
        }
        // Every result is still valid settings.
        for action in HotkeyAction::ALL {
            if let HotkeyEffect::Settings(s) = dispatch(action, &at_b) {
                assert_eq!(s.validate(), Ok(()), "{action:?}");
            }
        }
    }
}
