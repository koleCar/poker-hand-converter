//! (T3, docs/research/TABLE-TILING.md §4.3 - §4.5) The user's table tiling
//! and RNG settings: the one model the app stores (`hud_layouts` kinds
//! `tiling` and `rng`, key [`SETTINGS_KEY`], synced last writer wins), sends
//! (`tiling_changed`, `rng_changed`) and the HUD applies. Serde camelCase;
//! every field has a default, so an older or newer peer's object still
//! reads.
//!
//! - [`TilingSettings`]: off by default; the layout in force ([`LayoutRef`]:
//!   the auto grid or one of the user's [`Layout`]s), auto-switch rules for
//!   the auto grid, close gaps, and a per-room switch (on unless the user
//!   turned a room off). Whether a room may be tiled at all is the policy's
//!   (T0's `TilingPermit`), never this.
//! - [`RngSettings`]: off by default; the range (1 - 100), colour bands,
//!   when it rolls, per room.
//!
//! [`TilingSettings::validate`] and [`RngSettings::validate`] are what the
//! app checks before it stores or sends, and what the HUD checks again on
//! arrival (defence in depth): a refused object changes nothing.
//!
//! Tiling and the RNG are free (no entitlement): nothing here is gated.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

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

/// The RNG's largest number.
pub const RNG_LIMIT: u32 = 10_000;
/// Colour bands at most.
pub const MAX_BANDS: usize = 10;
/// The longest band label, characters.
pub const MAX_LABEL: usize = 24;
/// The longest timer, seconds.
pub const MAX_TIMER_SECS: u32 = 3600;

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

/// What a slot holds. `action` and `inHand` come later (§4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotKind {
    #[default]
    Play,
    /// A room's lobby window: stored, never given a table.
    Lobby,
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
        check_size(self, "the tiling settings")
    }
}

// ---------------------------------------------------------------------
// RNG.

/// A colour band: the numbers up to `up_to` (from the band before's, or
/// the range's start) are drawn in `colour`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RngBand {
    pub up_to: u32,
    /// `#rrggbb`.
    pub colour: String,
    /// What the user calls it (`None`: unnamed, the default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// When a table's RNG rolls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RngTriggers {
    /// On every new hand at that table (when its last hand is imported).
    pub new_hand: bool,
    /// On a click on the widget.
    pub click: bool,
    /// Every this many seconds (`None`: no timer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timer_secs: Option<u32>,
}

impl Default for RngTriggers {
    fn default() -> Self {
        Self {
            new_hand: true,
            click: true,
            timer_secs: None,
        }
    }
}

/// The user's RNG settings (`hud_layouts` kind `rng`; T4 draws it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RngSettings {
    /// Off by default.
    pub enabled: bool,
    /// The range, both ends included: 1 - 100 by default (0 - 99 is the
    /// other common choice).
    pub min: u32,
    pub max: u32,
    /// Ascending; the last one ends at `max`.
    pub bands: Vec<RngBand>,
    pub triggers: RngTriggers,
    /// The user's switch per room (`sites.json` id); a room not listed is
    /// on. The room's RNG policy (T0's `RngPermit`) decides first.
    pub per_room: BTreeMap<String, bool>,
}

/// The default bands: three, unnamed, in neutral greys.
fn default_bands() -> Vec<RngBand> {
    [(33, "#5c6370"), (66, "#8b929e"), (100, "#c5cad3")]
        .into_iter()
        .map(|(up_to, colour)| RngBand {
            up_to,
            colour: colour.to_owned(),
            label: None,
        })
        .collect()
}

impl Default for RngSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            min: 1,
            max: 100,
            bands: default_bands(),
            triggers: RngTriggers::default(),
            per_room: BTreeMap::new(),
        }
    }
}

fn is_hex_colour(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

impl RngSettings {
    /// Whether the user wants the RNG on this room's tables (on unless
    /// switched off).
    pub fn room_enabled(&self, site: &str) -> bool {
        self.per_room.get(site).copied().unwrap_or(true)
    }

    /// The band `n` is drawn in (`None` outside the range).
    pub fn band_for(&self, n: u32) -> Option<&RngBand> {
        if n < self.min || n > self.max {
            return None;
        }
        self.bands.iter().find(|band| n <= band.up_to)
    }

    /// A range of at least one number up to [`RNG_LIMIT`]; one to
    /// [`MAX_BANDS`] bands, strictly ascending inside the range, the last
    /// ending at `max`; `#rrggbb` colours; labels of 1 - [`MAX_LABEL`]
    /// characters or none; a timer of 1 s - 1 h or none.
    pub fn validate(&self) -> Result<(), Invalid> {
        if self.max > RNG_LIMIT {
            return invalid(format!("the RNG's largest number is {RNG_LIMIT}"));
        }
        if self.max < self.min {
            return invalid("the RNG's range ends before it starts");
        }
        if self.bands.is_empty() || self.bands.len() > MAX_BANDS {
            return invalid(format!("1 - {MAX_BANDS} colour bands"));
        }
        let mut floor: Option<u32> = None;
        for band in &self.bands {
            if band.up_to < self.min || band.up_to > self.max {
                return invalid(format!("a band ends at {}, outside the range", band.up_to));
            }
            if floor.is_some_and(|f| band.up_to <= f) {
                return invalid("the bands must be in ascending order");
            }
            floor = Some(band.up_to);
            if !is_hex_colour(&band.colour) {
                return invalid(format!("a band's colour {:?} is not #rrggbb", band.colour));
            }
            if let Some(label) = &band.label
                && (label.trim().is_empty() || label.chars().count() > MAX_LABEL)
            {
                return invalid(format!(
                    "a band's label: 1 - {MAX_LABEL} characters, or none"
                ));
            }
        }
        if floor != Some(self.max) {
            return invalid("the last band must end at the range's end");
        }
        if let Some(secs) = self.triggers.timer_secs
            && !(1..=MAX_TIMER_SECS).contains(&secs)
        {
            return invalid(format!("the timer: 1 - {MAX_TIMER_SECS} seconds"));
        }
        check_rooms(self.per_room.keys(), "a room")?;
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
        }
    }

    /// The defaults are the plan's: tiling off on the auto grid, every
    /// room on; the RNG off, 1 - 100, three unnamed bands, rolling on a new
    /// hand and a click, no timer. Both are valid.
    #[test]
    fn defaults() {
        let t = TilingSettings::default();
        assert!(!t.enabled && t.active == LayoutRef::Auto && t.layouts.is_empty());
        assert!(t.room_enabled("pokerstars"));
        assert_eq!(t.validate(), Ok(()));
        let r = RngSettings::default();
        assert!(!r.enabled);
        assert_eq!((r.min, r.max), (1, 100));
        assert_eq!(r.bands.len(), 3);
        assert!(r.bands.iter().all(|b| b.label.is_none()));
        assert_eq!(r.bands.last().map(|b| b.up_to), Some(100));
        assert_eq!(
            r.triggers,
            RngTriggers {
                new_hand: true,
                click: true,
                timer_secs: None
            }
        );
        assert_eq!(r.validate(), Ok(()));
        assert_eq!(r.band_for(1).map(|b| b.up_to), Some(33));
        assert_eq!(r.band_for(34).map(|b| b.up_to), Some(66));
        assert_eq!(r.band_for(100).map(|b| b.up_to), Some(100));
        assert_eq!(r.band_for(0), None);
        assert_eq!(r.band_for(101), None);
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

        let r = RngSettings {
            triggers: RngTriggers {
                timer_secs: Some(30),
                ..RngTriggers::default()
            },
            ..RngSettings::default()
        };
        let text = serde_json::to_string(&r).expect("json");
        assert!(
            text.contains(r#""triggers":{"newHand":true,"click":true,"timerSecs":30}"#),
            "{text}"
        );
        assert!(text.contains(r#""upTo":33"#) && !text.contains("label"));
        assert_eq!(serde_json::from_str::<RngSettings>(&text).expect("back"), r);
        assert_eq!(
            serde_json::from_str::<RngSettings>(r#"{"enabled":true}"#).expect("defaults"),
            RngSettings {
                enabled: true,
                ..RngSettings::default()
            }
        );
        // A newer peer's field is ignored.
        assert!(serde_json::from_str::<RngSettings>(r#"{"size":3}"#).is_ok());
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

    #[test]
    fn rng_validation() {
        let refused = |change: &dyn Fn(&mut RngSettings)| {
            let mut r = RngSettings::default();
            change(&mut r);
            r.validate().expect_err("refused")
        };
        refused(&|r| r.max = 0);
        refused(&|r| {
            r.max = RNG_LIMIT + 1;
            r.bands.last_mut().expect("band").up_to = RNG_LIMIT + 1;
        });
        refused(&|r| r.bands.clear());
        refused(&|r| r.bands.swap(0, 1));
        refused(&|r| r.bands[1].up_to = 33);
        refused(&|r| r.bands[0].up_to = 0);
        refused(&|r| {
            r.bands.pop();
        });
        refused(&|r| r.bands[2].up_to = 101);
        refused(&|r| r.bands[0].colour = "red".into());
        refused(&|r| r.bands[0].colour = "#12345g".into());
        refused(&|r| r.bands[0].label = Some(String::new()));
        refused(&|r| r.bands[0].label = Some("x".repeat(MAX_LABEL + 1)));
        refused(&|r| r.triggers.timer_secs = Some(0));
        refused(&|r| r.triggers.timer_secs = Some(MAX_TIMER_SECS + 1));
        refused(&|r| {
            r.bands = (1..=11)
                .map(|i| RngBand {
                    up_to: i * 9 + 1,
                    colour: "#000000".into(),
                    label: None,
                })
                .collect();
        });
        // 0 - 99 with named bands and a timer.
        let r = RngSettings {
            enabled: true,
            min: 0,
            max: 99,
            bands: vec![
                RngBand {
                    up_to: 49,
                    colour: "#1A2b3C".into(),
                    label: Some("Call".into()),
                },
                RngBand {
                    up_to: 99,
                    colour: "#ffffff".into(),
                    label: Some("Raise".into()),
                },
            ],
            triggers: RngTriggers {
                new_hand: false,
                click: true,
                timer_secs: Some(MAX_TIMER_SECS),
            },
            per_room: [("ggpoker".to_owned(), false)].into_iter().collect(),
        };
        assert_eq!(r.validate(), Ok(()));
        assert_eq!(r.band_for(0).and_then(|b| b.label.as_deref()), Some("Call"));
        assert_eq!(
            r.band_for(50).and_then(|b| b.label.as_deref()),
            Some("Raise")
        );
        assert!(!r.room_enabled("ggpoker") && r.room_enabled("acr"));
        // A one-number range with one band.
        let one = RngSettings {
            min: 7,
            max: 7,
            bands: vec![RngBand {
                up_to: 7,
                colour: "#000000".into(),
                label: None,
            }],
            ..RngSettings::default()
        };
        assert_eq!(one.validate(), Ok(()));
    }
}
