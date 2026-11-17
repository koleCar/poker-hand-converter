//! (T3, docs/research/TABLE-TILING.md §4.3 - §4.5) The user's table tiling
//! and RNG settings: the one model the app stores (`hud_layouts` kinds
//! `tiling` and `rng`, key [`SETTINGS_KEY`], synced last writer wins);
//! tiling's it sends (`tiling_changed`) and the HUD applies. Serde camelCase;
//! every field has a default, so an older or newer peer's object still
//! reads.
//!
//! - [`TilingSettings`]: off by default; the layout in force ([`LayoutRef`]:
//!   the auto grid or one of the user's [`Layout`]s), auto-switch rules for
//!   the auto grid, close gaps, a per-room switch (on unless the user
//!   turned a room off) and (T7) the global hotkeys
//!   ([`crate::hotkeys`]). Whether a room may be tiled at all is the
//!   policy's (T0's `TilingPermit`), never this.
//! - [`RngSettings`]: the switch of the app's RNG box (2026-11-16), off by
//!   default, and its look and place (2026-11-17). It never reaches the HUD.
//!
//! [`TilingSettings::validate`] and [`RngSettings::validate`] are what the
//! app checks before it stores or sends, and what the HUD checks again on
//! arrival (defence in depth): a refused object changes nothing.
//!
//! Tiling and the RNG are free (no entitlement): nothing here is gated.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::hotkeys::HotkeyBinding;

/// The auto grid's layout id ([`LayoutRef::Auto`], an [`AutoSwitch`]
/// target). No user layout may take it.
pub const AUTO_LAYOUT: &str = "auto";

/// The store's key for both settings rows (one of each per account).
pub const SETTINGS_KEY: &str = "default";

/// The largest settings object, bytes of JSON: what one `hud_layouts` row's
/// body may hold on the server (32 KiB).
pub const MAX_SETTINGS_BYTES: usize = 32 * 1024;

/// Layouts a user keeps at most.
pub const MAX_LAYOUTS: usize = 32;
/// Slots a layout has at most.
pub const MAX_SLOTS: usize = 64;
/// Auto-switch rules a list has at most.
pub const MAX_RULES: usize = 16;
/// The longest id (a layout's, a slot's, a room's).
pub const MAX_ID: usize = 64;
/// The longest layout name.
pub const MAX_NAME: usize = 80;
/// Rooms a per-room map or a slot's filter names at most.
pub const MAX_ROOMS: usize = 64;
/// A slot's monitor (its place in the monitor order) is below this.
pub const MAX_MONITORS: u32 = 16;

/// Why a settings object was refused: the field and what is wrong with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Invalid {}

fn invalid<T>(message: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid(message.into()))
}

fn check_id(id: &str, what: &str) -> Result<(), Invalid> {
    if id.is_empty() || id.chars().count() > MAX_ID {
        return invalid(format!("{what}: 1 - {MAX_ID} characters"));
    }
    Ok(())
}

fn check_rooms<'a>(
    rooms: impl ExactSizeIterator<Item = &'a String>,
    what: &str,
) -> Result<(), Invalid> {
    if rooms.len() > MAX_ROOMS {
        return invalid(format!("{what}: at most {MAX_ROOMS} rooms"));
    }
    for room in rooms {
        check_id(room, what)?;
    }
    Ok(())
}

fn check_size(value: &impl Serialize, what: &str) -> Result<(), Invalid> {
    let bytes = serde_json::to_vec(value).map_or(usize::MAX, |b| b.len());
    if bytes > MAX_SETTINGS_BYTES {
        return invalid(format!("{what}: larger than {MAX_SETTINGS_BYTES} bytes"));
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Layouts (T2's model; `rail_hud::tiling` re-exports them).

/// A saved arrangement: slots on monitors, and rules that switch to another
/// layout by the number of tables.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub slots: Vec<Slot>,
    #[serde(default)]
    pub auto_switch: Vec<AutoSwitch>,
}

/// A rectangle of a monitor's work area that holds a table (or a stack).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub id: String,
    /// The monitor's place in the HUD's monitor order
    /// (`rail_hud::tiling::monitor_order`): 0 the primary, then left to
    /// right (top to bottom on a tie). Missing: the primary.
    #[serde(default)]
    pub monitor: u32,
    /// Thousandths of the monitor's work area.
    pub rect: SlotRect,
    #[serde(default)]
    pub kind: SlotKind,
    /// The rooms (`sites.json` ids) it takes; `None`: any.
    #[serde(default)]
    pub rooms: Option<Vec<String>>,
    /// It may hold a stack when every slot is full.
    #[serde(default)]
    pub stack: bool,
}

/// A slot's place, thousandths of the work area (0 - 1000).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// What a slot holds.
///
/// (T7) There is no "In-Hand" kind, on purpose: moving a table because the
/// user is in the hand reacts to a player's action, which PokerStars'
/// Reference Guide forbids a script to do (docs/research/TILING-POLICIES.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotKind {
    #[default]
    Play,
    /// A room's lobby window: stored, never given a table.
    Lobby,
    /// (T7) "Action Required": a table moves here while its room's client
    /// signals that it is the user's turn, and back to its own slot after;
    /// only for a room whose policy allows it (`sites.json` `actionSlot`,
    /// none today). Never a table's own slot.
    Action,
    /// A kind of a newer build: stored, never given a table. (Builds
    /// before T7 cannot read a layout with an `action` slot at all: they
    /// read the whole tiling settings as the defaults.)
    #[serde(other)]
    Other,
}

/// From `min_tables` open tables on, layout `layout_id` ([`AUTO_LAYOUT`]
/// for the auto grid).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitch {
    pub min_tables: u32,
    pub layout_id: String,
}

impl Layout {
    fn validate(&self) -> Result<(), Invalid> {
        check_id(&self.id, "a layout's id")?;
        if self.id == AUTO_LAYOUT {
            return invalid(format!("a layout's id: {AUTO_LAYOUT:?} is the auto grid's"));
        }
        if self.name.trim().is_empty() || self.name.chars().count() > MAX_NAME {
            return invalid(format!(
                "layout {:?}: a name of 1 - {MAX_NAME} characters",
                self.id
            ));
        }
        if self.slots.len() > MAX_SLOTS {
            return invalid(format!("layout {:?}: at most {MAX_SLOTS} slots", self.id));
        }
        for (i, slot) in self.slots.iter().enumerate() {
            check_id(&slot.id, "a slot's id")?;
            if self.slots[..i].iter().any(|s| s.id == slot.id) {
                return invalid(format!("layout {:?}: slot {:?} twice", self.id, slot.id));
            }
            if slot.monitor >= MAX_MONITORS {
                return invalid(format!(
                    "slot {:?}: monitor {} is out of range",
                    slot.id, slot.monitor
                ));
            }
            let r = slot.rect;
            if r.width == 0
                || r.height == 0
                || r.x.saturating_add(r.width) > 1000
                || r.y.saturating_add(r.height) > 1000
            {
                return invalid(format!(
                    "slot {:?}: its rect must lie inside the work area (thousandths)",
                    slot.id
                ));
            }
            if let Some(rooms) = &slot.rooms {
                check_rooms(rooms.iter(), "a slot's room")?;
            }
        }
        Ok(())
    }
}

/// Auto-switch rules: each `min_tables` once, at least 1, to a layout that
/// exists (or the auto grid).
fn check_rules(rules: &[AutoSwitch], layouts: &[Layout]) -> Result<(), Invalid> {
    if rules.len() > MAX_RULES {
        return invalid(format!("at most {MAX_RULES} auto-switch rules"));
    }
    for (i, rule) in rules.iter().enumerate() {
        if rule.min_tables == 0 {
            return invalid("an auto-switch rule starts at 1 table or more");
        }
        if rules[..i].iter().any(|r| r.min_tables == rule.min_tables) {
            return invalid(format!(
                "two auto-switch rules at {} tables",
                rule.min_tables
            ));
        }
        if rule.layout_id != AUTO_LAYOUT && !layouts.iter().any(|l| l.id == rule.layout_id) {
            return invalid(format!(
                "auto-switch to {:?}: no such layout",
                rule.layout_id
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Tiling.

/// The layout in force: the auto grid, or one of the user's.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LayoutRef {
    #[default]
    Auto,
    Custom {
        id: String,
    },
}

impl LayoutRef {
    /// The layout's id ([`AUTO_LAYOUT`] for the auto grid).
    pub fn id(&self) -> &str {
        match self {
            Self::Auto => AUTO_LAYOUT,
            Self::Custom { id } => id,
        }
    }
}

/// The user's table tiling settings (`hud_layouts` kind `tiling`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TilingSettings {
    /// Tiling is on. Off by default; switching it off leaves every window
    /// where it is.
    pub enabled: bool,
    /// The layout in force.
    pub active: LayoutRef,
    /// The user's layouts.
    pub layouts: Vec<Layout>,
    /// Rules by table count while the auto grid is in force (a user layout
    /// carries its own, [`Layout::auto_switch`]).
    pub auto_switch: Vec<AutoSwitch>,
    /// A closed table's hole is filled by the last table.
    pub close_gaps: bool,
    /// The user's switch per room (`sites.json` id); a room not listed is
    /// on. The room's policy decides first: a switch never allows a room
    /// the policy does not.
    pub per_room: BTreeMap<String, bool>,
    /// (T7) The user's global hotkeys ([`crate::hotkeys`]); none by
    /// default. Missing (an older peer's settings): none. An older app
    /// build that saves these settings drops them (it does not know them).
    pub hotkeys: Vec<HotkeyBinding>,
}

impl TilingSettings {
    /// Whether the user lets tiling move this room's tables (on unless
    /// switched off).
    pub fn room_enabled(&self, site: &str) -> bool {
        self.per_room.get(site).copied().unwrap_or(true)
    }

    /// Whole and consistent: ids, slots inside the work area, the active
    /// layout and every rule's target exist, bounded sizes.
    pub fn validate(&self) -> Result<(), Invalid> {
        if self.layouts.len() > MAX_LAYOUTS {
            return invalid(format!("at most {MAX_LAYOUTS} layouts"));
        }
        for (i, layout) in self.layouts.iter().enumerate() {
            layout.validate()?;
            if self.layouts[..i].iter().any(|l| l.id == layout.id) {
                return invalid(format!("layout {:?} twice", layout.id));
            }
        }
        for layout in &self.layouts {
            check_rules(&layout.auto_switch, &self.layouts)?;
        }
        check_rules(&self.auto_switch, &self.layouts)?;
        if let LayoutRef::Custom { id } = &self.active
            && !self.layouts.iter().any(|l| &l.id == id)
        {
            return invalid(format!("the active layout {id:?} does not exist"));
        }
        check_rooms(self.per_room.keys(), "a room")?;
        crate::hotkeys::check(&self.hotkeys)?;
        check_size(self, "the tiling settings")
    }
}

// ---------------------------------------------------------------------
// RNG.

/// The user's RNG box (`hud_layouts` kind `rng`): whether the app shows
/// it (2026-11-16, `app/src-tauri/src/rng_box.rs`), and how it looks and
/// where it sits (2026-11-17). Rows an older Rail wrote also carry the
/// per-table overlay's range, bands, triggers, rooms, size and opacity:
/// they are read past. Every field has a default, so a row with only the
/// switch reads as the box in its corner, at its first size. An older Rail
/// reads this object with its own defaults for the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RngSettings {
    pub enabled: bool,
    /// The box's width and height, points ([`RNG_BOX_MIN`] - [`RNG_BOX_MAX`]).
    pub width: u32,
    pub height: u32,
    /// The number's size, points ([`RNG_NUMBER_MIN`] - [`RNG_NUMBER_MAX`]).
    pub number_size: u32,
    /// The box's background and the number's colour, `#rrggbb`; absent:
    /// the app's theme.
    pub background: Option<String>,
    pub color: Option<String>,
    /// Where the user put the box: its top-left corner, points on the
    /// screen; absent: the primary monitor's top-right corner.
    pub position: Option<RngPosition>,
    /// Locked: the box cannot be dragged or resized (a click still rolls).
    pub locked: bool,
}

/// The box's top-left corner, points on the screen (may be negative: a
/// monitor left of or above the primary one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RngPosition {
    pub x: i32,
    pub y: i32,
}

/// The box's side at first, and the smallest and largest it may be.
pub const RNG_BOX_DEFAULT: u32 = 56;
pub const RNG_BOX_MIN: u32 = 32;
pub const RNG_BOX_MAX: u32 = 480;
/// The number's size at first, and the smallest and largest.
pub const RNG_NUMBER_DEFAULT: u32 = 20;
pub const RNG_NUMBER_MIN: u32 = 10;
pub const RNG_NUMBER_MAX: u32 = 320;
/// How far off the screen's origin a position may be, points.
pub const RNG_POSITION_MAX: i32 = 100_000;

impl Default for RngSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            width: RNG_BOX_DEFAULT,
            height: RNG_BOX_DEFAULT,
            number_size: RNG_NUMBER_DEFAULT,
            background: None,
            color: None,
            position: None,
            locked: false,
        }
    }
}

/// `#rrggbb`.
fn is_hex_colour(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl RngSettings {
    /// What the app checks before it stores it: sizes in range, colours
    /// `#rrggbb`, a position near the screens, and the size every settings
    /// object is held to.
    pub fn validate(&self) -> Result<(), Invalid> {
        for (value, what) in [
            (self.width, "the box's width"),
            (self.height, "the box's height"),
        ] {
            if !(RNG_BOX_MIN..=RNG_BOX_MAX).contains(&value) {
                return invalid(format!("{what}: {RNG_BOX_MIN} to {RNG_BOX_MAX}"));
            }
        }
        if !(RNG_NUMBER_MIN..=RNG_NUMBER_MAX).contains(&self.number_size) {
            return invalid(format!(
                "the number's size: {RNG_NUMBER_MIN} to {RNG_NUMBER_MAX}"
            ));
        }
        for (colour, what) in [
            (&self.background, "the background"),
            (&self.color, "the number's colour"),
        ] {
            if let Some(colour) = colour
                && !is_hex_colour(colour)
            {
                return invalid(format!("{what}: #rrggbb, not {colour:?}"));
            }
        }
        if let Some(RngPosition { x, y }) = self.position
            && (x.abs() > RNG_POSITION_MAX || y.abs() > RNG_POSITION_MAX)
        {
            return invalid(format!("the box's position: within {RNG_POSITION_MAX}"));
        }
        check_size(self, "the RNG settings")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(id: &str, x: u32, width: u32) -> Slot {
        Slot {
            id: id.into(),
            monitor: 0,
            rect: SlotRect {
                x,
                y: 0,
                width,
                height: 1000,
            },
            kind: SlotKind::Play,
            rooms: None,
            stack: false,
        }
    }

    fn halves() -> Layout {
        Layout {
            id: "halves".into(),
            name: "Halves".into(),
            slots: vec![slot("l", 0, 500), slot("r", 500, 500)],
            auto_switch: Vec::new(),
        }
    }

    fn tiling() -> TilingSettings {
        TilingSettings {
            enabled: true,
            active: LayoutRef::Custom {
                id: "halves".into(),
            },
            layouts: vec![halves()],
            auto_switch: vec![AutoSwitch {
                min_tables: 5,
                layout_id: "halves".into(),
            }],
            close_gaps: true,
            per_room: [("winamax".to_owned(), false)].into_iter().collect(),
            hotkeys: vec![HotkeyBinding {
                action: crate::hotkeys::HotkeyAction::Retile,
                keys: "Ctrl+Alt+KeyR".into(),
            }],
        }
    }

    /// The defaults are the plan's: tiling off on the auto grid, every
    /// room on; the RNG off. Both are valid.
    #[test]
    fn defaults() {
        let t = TilingSettings::default();
        assert!(!t.enabled && t.active == LayoutRef::Auto && t.layouts.is_empty());
        assert!(t.room_enabled("pokerstars"));
        assert_eq!(t.validate(), Ok(()));
        let r = RngSettings::default();
        assert!(!r.enabled);
        assert_eq!(r.validate(), Ok(()));
    }

    /// The wire and storage form: camelCase, the layout reference tagged,
    /// every field defaulted (an empty object reads as the defaults).
    #[test]
    fn camel_case_json_round_trips() {
        let t = tiling();
        let text = serde_json::to_string(&t).expect("json");
        assert!(
            text.contains(r#""active":{"kind":"custom","id":"halves"}"#),
            "{text}"
        );
        assert!(
            text.contains(r#""closeGaps":true"#) && text.contains(r#""perRoom":{"winamax":false}"#)
        );
        assert!(text.contains(r#""autoSwitch":[{"minTables":5,"layoutId":"halves"}]"#));
        assert_eq!(
            serde_json::from_str::<TilingSettings>(&text).expect("back"),
            t
        );
        assert_eq!(
            serde_json::to_string(&LayoutRef::Auto).expect("json"),
            r#"{"kind":"auto"}"#
        );
        assert_eq!(
            serde_json::from_str::<TilingSettings>("{}").expect("defaults"),
            TilingSettings::default()
        );
        assert!(!t.room_enabled("winamax") && t.room_enabled("acr"));
    }

    /// (T7) The hotkeys travel with the tiling settings: a T6 row (none)
    /// reads with none, a newer one round-trips, and what an older build
    /// keeps of it is everything but them.
    #[test]
    fn hotkeys_round_trip() {
        let old = r#"{"enabled":true,"active":{"kind":"auto"},"layouts":[],"autoSwitch":[],"closeGaps":false,"perRoom":{"acr":false}}"#;
        let t: TilingSettings = serde_json::from_str(old).expect("reads");
        assert!(t.hotkeys.is_empty() && t.enabled && !t.room_enabled("acr"));
        assert_eq!(t.validate(), Ok(()));

        let t = tiling();
        let text = serde_json::to_string(&t).expect("json");
        assert!(
            text.contains(r#""hotkeys":[{"action":"retile","keys":"Ctrl+Alt+KeyR"}]"#),
            "{text}"
        );
        assert_eq!(
            serde_json::from_str::<TilingSettings>(&text).expect("back"),
            t
        );
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct OlderTiling {
            enabled: bool,
            close_gaps: bool,
            per_room: BTreeMap<String, bool>,
        }
        let older: OlderTiling = serde_json::from_str(&text).expect("older reads");
        assert!(older.enabled && older.close_gaps);
        assert_eq!(older.per_room.get("winamax"), Some(&false));
    }

    /// (T7) The slot kinds on the wire: `action` for the Action Required
    /// slot; a newer build's kind reads as `Other` rather than refusing
    /// the whole settings object.
    #[test]
    fn slot_kinds() {
        let mut t = tiling();
        t.layouts[0].slots[1].kind = SlotKind::Action;
        let text = serde_json::to_string(&t).expect("json");
        assert!(text.contains(r#""kind":"action""#), "{text}");
        assert_eq!(
            serde_json::from_str::<TilingSettings>(&text).expect("back"),
            t
        );
        assert_eq!(t.validate(), Ok(()));
        let newer = text.replace(r#""kind":"action""#, r#""kind":"inHand""#);
        let read: TilingSettings = serde_json::from_str(&newer).expect("reads");
        assert_eq!(read.layouts[0].slots[1].kind, SlotKind::Other);
        assert_eq!(read.validate(), Ok(()));
    }

    #[test]
    fn tiling_validation() {
        assert_eq!(tiling().validate(), Ok(()));
        let refused = |change: &dyn Fn(&mut TilingSettings)| {
            let mut t = tiling();
            change(&mut t);
            t.validate().expect_err("refused")
        };
        refused(&|t| t.active = LayoutRef::Custom { id: "gone".into() });
        refused(&|t| t.layouts.push(halves()));
        refused(&|t| t.layouts[0].id = AUTO_LAYOUT.into());
        refused(&|t| t.layouts[0].id = String::new());
        refused(&|t| t.layouts[0].name = " ".into());
        refused(&|t| t.layouts[0].slots[1].id = "l".into());
        refused(&|t| t.layouts[0].slots[1].rect.width = 501);
        refused(&|t| t.layouts[0].slots[0].rect.height = 0);
        refused(&|t| t.layouts[0].slots[0].rect.y = 1);
        refused(&|t| t.layouts[0].slots[0].monitor = MAX_MONITORS);
        refused(&|t| t.layouts[0].slots[0].rooms = Some(vec![String::new()]));
        refused(&|t| t.auto_switch[0].min_tables = 0);
        refused(&|t| t.auto_switch[0].layout_id = "gone".into());
        refused(&|t| t.auto_switch.push(t.auto_switch[0].clone()));
        refused(&|t| {
            t.layouts[0].auto_switch = vec![AutoSwitch {
                min_tables: 2,
                layout_id: "nope".into(),
            }];
        });
        refused(&|t| {
            t.per_room.insert("x".repeat(MAX_ID + 1), true);
        });
        // (T7) Hotkeys: the same keys twice, an action twice, keys that
        // would hijack typing.
        refused(&|t| {
            t.hotkeys.push(HotkeyBinding {
                action: crate::hotkeys::HotkeyAction::ToggleTiling,
                keys: "Ctrl+Alt+KeyR".into(),
            });
        });
        refused(&|t| t.hotkeys.push(t.hotkeys[0].clone()));
        refused(&|t| t.hotkeys[0].keys = "KeyR".into());
        refused(&|t| {
            t.layouts = (0..=MAX_LAYOUTS)
                .map(|i| Layout {
                    id: format!("l{i}"),
                    ..halves()
                })
                .collect();
            t.active = LayoutRef::Auto;
            t.auto_switch.clear();
        });
        // Larger than a row's body may be on the server.
        refused(&|t| {
            t.active = LayoutRef::Auto;
            t.auto_switch.clear();
            t.layouts = (0..MAX_LAYOUTS)
                .map(|i| Layout {
                    id: format!("l{i}"),
                    name: format!("Layout {i}"),
                    slots: (0..MAX_SLOTS)
                        .map(|s| slot(&format!("s{s}"), 0, 10))
                        .collect(),
                    auto_switch: Vec::new(),
                })
                .collect();
        });
        // The auto grid's rules may go to the auto grid; a missing monitor
        // is fine (the primary takes its slots).
        let mut t = tiling();
        t.auto_switch.push(AutoSwitch {
            min_tables: 9,
            layout_id: AUTO_LAYOUT.into(),
        });
        t.layouts[0].slots[0].monitor = 3;
        assert_eq!(t.validate(), Ok(()));
    }

    /// (T5 follow-up) What the app's slot editor and auto-switch list save
    /// (`app/src/screens/tables/slots.ts`, captured from the screen): a
    /// drawn layout on a second monitor with a room filter, overlapping
    /// slots, whole thousandths, the rules unsorted - it reads and
    /// validates here as it did there.
    #[test]
    fn the_editors_json_validates() {
        let json = r#"{"enabled":true,"active":{"kind":"custom","id":"layout-2"},"layouts":[{"id":"layout-1","name":"Halves","slots":[{"id":"s1","monitor":0,"rect":{"x":0,"y":0,"width":500,"height":1000},"kind":"play","rooms":null,"stack":true},{"id":"s2","monitor":0,"rect":{"x":500,"y":0,"width":500,"height":1000},"kind":"play","rooms":null,"stack":false},{"id":"s3","monitor":1,"rect":{"x":542,"y":166,"width":458,"height":834},"kind":"play","rooms":["pokerstars"],"stack":true}],"autoSwitch":[]},{"id":"layout-2","name":"Layout 2","slots":[{"id":"s1","monitor":0,"rect":{"x":0,"y":0,"width":600,"height":500},"kind":"play","rooms":null,"stack":true},{"id":"s3","monitor":0,"rect":{"x":400,"y":0,"width":600,"height":1000},"kind":"play","rooms":null,"stack":true}],"autoSwitch":[]}],"autoSwitch":[{"minTables":4,"layoutId":"auto"},{"minTables":2,"layoutId":"layout-1"}],"closeGaps":false,"perRoom":{}}"#;
        let t: TilingSettings = serde_json::from_str(json).expect("reads");
        assert_eq!(t.validate(), Ok(()));
        assert_eq!(
            t.layouts[0].slots[2].rooms.as_deref(),
            Some(&["pokerstars".to_owned()][..])
        );
        assert_eq!(t.auto_switch[1].min_tables, 2);
    }

    /// (2026-11-16) An older Rail's row (the per-table overlay's fields)
    /// reads as its switch, with the box at its first look and place; an
    /// empty object reads as the defaults.
    #[test]
    fn rng_reads_older_rows() {
        let old = r##"{"enabled":true,"min":1,"max":100,"bands":[{"upTo":50,"colour":"#112233"},{"upTo":100,"colour":"#445566"}],"triggers":{"newHand":true,"click":false},"perRoom":{"acr":false},"scale":150,"opacity":40}"##;
        let r: RngSettings = serde_json::from_str(old).expect("reads");
        assert_eq!(
            r,
            RngSettings {
                enabled: true,
                ..RngSettings::default()
            }
        );
        assert_eq!(
            serde_json::from_str::<RngSettings>("{}").expect("defaults"),
            RngSettings::default()
        );
        assert_eq!(
            serde_json::from_str::<RngSettings>(r#"{"enabled":true}"#).expect("reads"),
            r,
            "the switch alone (2026-11-16's rows)"
        );
        assert_eq!(r.validate(), Ok(()));
    }

    /// (2026-11-17) The box's look and place: camelCase on the wire, and
    /// sizes, colours and positions checked.
    #[test]
    fn rng_box_look_and_place() {
        let r = RngSettings {
            enabled: true,
            width: 120,
            height: 80,
            number_size: 48,
            background: Some("#1a2B3c".into()),
            color: Some("#ffffff".into()),
            position: Some(RngPosition { x: -1200, y: 40 }),
            locked: true,
        };
        assert_eq!(r.validate(), Ok(()));
        let json = serde_json::to_string(&r).expect("json");
        assert!(
            json.contains(r#""numberSize":48"#)
                && json.contains(r#""position":{"x":-1200,"y":40}"#),
            "{json}"
        );
        assert_eq!(
            serde_json::from_str::<RngSettings>(&json).expect("reads"),
            r
        );

        let refused = [
            RngSettings {
                width: RNG_BOX_MIN - 1,
                ..r.clone()
            },
            RngSettings {
                height: RNG_BOX_MAX + 1,
                ..r.clone()
            },
            RngSettings {
                number_size: RNG_NUMBER_MIN - 1,
                ..r.clone()
            },
            RngSettings {
                number_size: RNG_NUMBER_MAX + 1,
                ..r.clone()
            },
            RngSettings {
                background: Some("red".into()),
                ..r.clone()
            },
            RngSettings {
                color: Some("#12345".into()),
                ..r.clone()
            },
            RngSettings {
                color: Some("#12345g".into()),
                ..r.clone()
            },
            RngSettings {
                position: Some(RngPosition {
                    x: RNG_POSITION_MAX + 1,
                    y: 0,
                }),
                ..r.clone()
            },
        ];
        for settings in refused {
            assert!(settings.validate().is_err(), "{settings:?}");
        }
    }
}
