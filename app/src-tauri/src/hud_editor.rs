//! The HUD editor (docs/RAIL-PLAN.md R3.9; guideline §7): the window's HUD
//! screen builds panel designs, copies presets, assigns a design per room,
//! table size and game format, and previews it - over the same model and
//! the same renderer as the HUD process (`rail_hud::design`,
//! `rail_hud::scene`), so what the preview shows is what a table shows.
//!
//! - **State** ([`hud_editor_state`]): the presets, the user's designs
//!   (`hud_layouts` in the store), the assignments, the rooms whose HUD is
//!   allowed with their restrictions, every statistic a design may name
//!   (the shipped definitions and the user's own, each flagged card-split /
//!   hero-only / money), and each design's problems on each room.
//! - **Checks** ([`hud_design_check`]): a draft against every allowed room
//!   (`rail_hud::design::check_for_room`); saving refuses a design that is
//!   broken or that a room it is assigned to would refuse
//!   ([`hud_design_save`]), assigning refuses a design the room would
//!   refuse ([`hud_assign`]) - and says why, by problem code.
//! - **Preview** ([`hud_preview`]): a table of the size with made-up players
//!   and made-up numbers (never anyone's), the user's dragged panels of that
//!   room and size, laid out by `rail_hud::scene::compose` under the room's
//!   permit - the room's rules cut the design down exactly as on a table.
//! - Every write tells the HUD (`layout_changed`: it reads the store again)
//!   and wakes the sync worker (the rows go to the account, R3.9's sync).
//!   [`HUD_LAYOUTS_EVENT`] tells the window when a sync brought another
//!   computer's rows.

use std::collections::BTreeMap;

use rail_config::model::HudRestrictions;
use rail_config::stats::{Band, Group, HudPlace, Text, Tone, Unit};
use rail_core::js::JsNumber;
use rail_hud::design::{
    self, ANY, Assignment, Assignments, Catalog, GameFormat, HudDesign, MAX_CELLS, MAX_COLUMNS,
    MAX_DECIMALS, MAX_POPUP_SECTIONS, MAX_POPUP_STATS, Presets, Problem, StackWhen,
};
use rail_hud::layout::{Positions, TableLayout};
use rail_hud::panel::{PanelStats, StatCell};
use rail_hud::platform::{OverlayFrame, PanelWords, Rect, SeatPanel, Seating, TagColour};
use rail_hud::scene::{self, Align, Item};
use rail_stats::custom::CustomSet;
use rail_stats::display::format_fixed;
use serde::Serialize;
use tauri::State;

use crate::commands::StoreState;
use crate::hud::HudState;

/// The window event that says a sync changed the HUD's layouts here (no
/// payload: the screen asks [`hud_editor_state`] again).
pub const HUD_LAYOUTS_EVENT: &str = "hud-layouts-changed";

/// The preview's client area (the simulator's 4:3, a little larger).
pub const PREVIEW_WIDTH: u32 = 800;
pub const PREVIEW_HEIGHT: u32 = 600;

fn text(error: rail_store::Error) -> String {
    error.to_string()
}

fn open(store: &StoreState) -> Result<&rail_store::Store, String> {
    store
        .store
        .as_ref()
        .ok_or_else(|| "the store is not open".to_owned())
}

/// A room whose HUD is allowed, as the editor shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDto {
    pub id: String,
    pub name: String,
    pub restrictions: HudRestrictions,
}

/// A statistic a design may name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDto {
    pub id: String,
    pub label: Text,
    pub name: Text,
    pub description: Text,
    pub group: Group,
    pub unit: Unit,
    /// The definition's decimals (the popup's; the panel shows none unless
    /// the design says).
    pub decimals: u32,
    pub min_sample: u64,
    pub bands: Vec<Band>,
    pub hud: HudPlace,
    /// The user's own (R2.10).
    pub custom: bool,
    /// Split by the cards: never on PokerStars.
    pub card_split: bool,
    /// The hero's only: never on a panel or popup.
    pub hero_only: bool,
    /// Money: never on a HUD.
    pub money: bool,
}

/// A shipped preset.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetDto {
    pub id: String,
    pub name: Text,
    pub description: Text,
    pub design: HudDesign,
}

/// A user's design.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDesignDto {
    pub id: String,
    pub design: HudDesign,
    pub updated_at: i64,
}

/// A design's problems: its own (it cannot be saved) and per allowed room
/// (refusals: it cannot be assigned there; notes: what the room leaves
/// out).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDto {
    pub problems: Vec<Problem>,
    pub rooms: BTreeMap<String, Vec<Problem>>,
}

/// An assignment as the editor shows it, with what its room(s) refuse of
/// the design today (a user's statistic edited since, a design synced from
/// another computer: the renderer drops it, the editor says so).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentDto {
    #[serde(flatten)]
    pub assignment: Assignment,
    pub refused: BTreeMap<String, Vec<Problem>>,
}

/// Which design a table of a room, size (`None`: one whose size is not
/// known) and format gets: the HUD's own resolution, for the matrix.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDto {
    pub site: String,
    pub size: Option<u32>,
    pub format: GameFormat,
    pub layout: String,
    /// Assigned (else the format's preset).
    pub assigned: bool,
}

/// Dragged panels of one room and size (R3.6).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionsDto {
    pub site: String,
    pub size: u32,
    pub panels: u32,
}

/// The user's per-room answer (R3.6).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettingDto {
    pub site: String,
    pub preferred_seat: Option<bool>,
}

/// The editor's limits (the model's).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsDto {
    pub max_cells: usize,
    pub max_columns: u32,
    pub max_decimals: u32,
    pub max_popup_sections: usize,
    pub max_popup_stats: usize,
}

/// Everything the HUD screen shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorStateDto {
    pub presets: Vec<PresetDto>,
    /// Each format's preset when nothing is assigned.
    pub defaults: BTreeMap<GameFormat, String>,
    pub designs: Vec<UserDesignDto>,
    pub assignments: Vec<AssignmentDto>,
    /// Every allowed room x size x format: the design its tables get.
    pub resolved: Vec<ResolvedDto>,
    pub rooms: Vec<RoomDto>,
    pub stats: Vec<StatDto>,
    /// By design id (presets' and the user's).
    pub checks: BTreeMap<String, CheckDto>,
    pub positions: Vec<PositionsDto>,
    pub room_settings: Vec<RoomSettingDto>,
    pub limits: LimitsDto,
}

/// The rooms whose HUD is allowed (R3.10: in the merged `sites.json`, as
/// the HUD decides), with their restrictions.
pub fn rooms() -> Result<Vec<RoomDto>, String> {
    let config = crate::policy::config();
    Ok(config
        .sites
        .iter()
        .filter(|site| site.hud_permitted())
        .map(|site| RoomDto {
            id: site.id.clone(),
            name: site.name.clone(),
            restrictions: site.hud.restrictions.unwrap_or(HudRestrictions::STRICTEST),
        })
        .collect())
}

/// The user's statistics compiled (none without a store).
fn custom(reader: &rail_store::Reader) -> CustomSet {
    crate::custom_stats::custom_set(reader).map_or_else(|_| CustomSet::default(), |(set, _, _)| set)
}

/// The user's designs that this build reads, by id.
fn user_designs(reader: &rail_store::Reader) -> Result<Vec<(String, HudDesign, i64)>, String> {
    let presets = Presets::shipped();
    Ok(reader
        .hud_layouts()
        .map_err(text)?
        .into_iter()
        .filter(|row| !presets.is_preset(&row.id))
        .filter_map(|row| Some((row.id, HudDesign::parse(&row.design)?, row.updated_at)))
        .collect())
}

/// The assignments in force.
fn assignments(reader: &rail_store::Reader) -> Result<Assignments, String> {
    Ok(Assignments(
        reader
            .hud_layout_assignments()
            .map_err(text)?
            .iter()
            .filter_map(Assignment::from_store)
            .collect(),
    ))
}

/// A design by id: the user's, else a preset's.
pub fn load_design(reader: &rail_store::Reader, id: &str) -> Option<HudDesign> {
    let presets = Presets::shipped();
    if let Some(preset) = presets.get(id) {
        return Some(preset.design.clone());
    }
    user_designs(reader)
        .ok()?
        .into_iter()
        .find(|(user, _, _)| user == id)
        .map(|(_, design, _)| design)
}

/// `design` on every allowed room.
fn check_all(design: &HudDesign, catalog: &Catalog, rooms: &[RoomDto]) -> CheckDto {
    CheckDto {
        problems: design::check(design, catalog),
        rooms: rooms
            .iter()
            .map(|room| {
                (
                    room.id.clone(),
                    design::check_for_room(design, &room.restrictions, catalog),
                )
            })
            .collect(),
    }
}

/// What the rooms an assignment of `site` covers refuse of `design` (only
/// refusals; empty: it may be assigned).
fn refused_on(
    site: &str,
    design: &HudDesign,
    catalog: &Catalog,
    rooms: &[RoomDto],
) -> BTreeMap<String, Vec<Problem>> {
    rooms
        .iter()
        .filter(|room| site == ANY || room.id == site)
        .filter_map(|room| {
            let refused: Vec<Problem> = design::check_for_room(design, &room.restrictions, catalog)
                .into_iter()
                .filter(|p| p.severity() == design::Severity::Refuse)
                .collect();
            (!refused.is_empty()).then(|| (room.id.clone(), refused))
        })
        .collect()
}

fn stats(catalog: &Catalog) -> Result<Vec<StatDto>, String> {
    let shipped = crate::reports::display()?;
    let mut out: Vec<StatDto> = shipped
        .stats
        .iter()
        .map(|stat| (stat.def.clone(), false))
        .chain(
            catalog
                .custom()
                .stats
                .iter()
                .map(|stat| (stat.def.def.clone(), true)),
        )
        .filter_map(|(def, custom)| {
            let info = catalog.info(&def.id)?;
            Some(StatDto {
                id: def.id.clone(),
                label: def.label.clone(),
                name: def.name.clone(),
                description: def.description.clone(),
                group: def.group,
                unit: def.format.unit,
                decimals: def.format.decimals,
                min_sample: def.sample.min,
                bands: def.bands.clone(),
                hud: def.hud,
                custom,
                card_split: info.card_split,
                hero_only: info.hero_only,
                money: info.money,
            })
        })
        .collect();
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}

/// The editor's state from the store.
pub fn build_state(reader: &rail_store::Reader) -> Result<EditorStateDto, String> {
    let presets = Presets::shipped();
    let catalog = Catalog::new(custom(reader));
    let rooms = rooms()?;
    let designs = user_designs(reader)?;
    let mut checks = BTreeMap::new();
    for preset in &presets.presets {
        checks.insert(
            preset.id.clone(),
            check_all(&preset.design, &catalog, &rooms),
        );
    }
    for (id, design, _) in &designs {
        checks.insert(id.clone(), check_all(design, &catalog, &rooms));
    }
    let find = |id: &str| -> Option<&HudDesign> {
        presets
            .get(id)
            .map(|p| &p.design)
            .or_else(|| designs.iter().find(|(d, _, _)| d == id).map(|(_, d, _)| d))
    };
    let all = assignments(reader)?;
    let mut resolved = Vec::new();
    for room in &rooms {
        for size in std::iter::once(None).chain((2..=10).map(Some)) {
            for format in GameFormat::ALL {
                let (layout, source) =
                    all.resolve(&room.id, size, format, &presets, |id| find(id).is_some());
                resolved.push(ResolvedDto {
                    site: room.id.clone(),
                    size,
                    format,
                    layout,
                    assigned: source == design::Source::Assigned,
                });
            }
        }
    }
    let assigned = all
        .0
        .into_iter()
        .map(|assignment| {
            let refused = find(&assignment.layout)
                .map(|design| refused_on(&assignment.site, design, &catalog, &rooms))
                .unwrap_or_default();
            AssignmentDto {
                assignment,
                refused,
            }
        })
        .collect();
    let mut positions: Vec<PositionsDto> = Vec::new();
    for position in reader.hud_seat_positions().map_err(text)? {
        match positions
            .iter_mut()
            .find(|p| p.site == position.site && p.size == position.size)
        {
            Some(found) => found.panels += 1,
            None => positions.push(PositionsDto {
                site: position.site,
                size: position.size,
                panels: 1,
            }),
        }
    }
    let room_settings = reader
        .hud_room_settings()
        .map_err(text)?
        .into_iter()
        .map(|s| RoomSettingDto {
            site: s.site,
            preferred_seat: s.preferred_seat,
        })
        .collect();
    Ok(EditorStateDto {
        presets: presets
            .presets
            .iter()
            .map(|p| PresetDto {
                id: p.id.clone(),
                name: p.name.clone(),
                description: p.description.clone(),
                design: p.design.clone(),
            })
            .collect(),
        defaults: presets.defaults.clone(),
        designs: designs
            .into_iter()
            .map(|(id, design, updated_at)| UserDesignDto {
                id,
                design,
                updated_at,
            })
            .collect(),
        assignments: assigned,
        resolved,
        rooms,
        stats: stats(&catalog)?,
        checks,
        positions,
        room_settings,
        limits: LimitsDto {
            max_cells: MAX_CELLS,
            max_columns: MAX_COLUMNS,
            max_decimals: MAX_DECIMALS,
            max_popup_sections: MAX_POPUP_SECTIONS,
            max_popup_stats: MAX_POPUP_STATS,
        },
    })
}

/// A new design id: `d-` and 32 random hex digits.
fn new_design_id() -> String {
    let mut seed = [0u8; 16];
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut seed).is_err() {
        let now = rail_store::time::now_ms().unsigned_abs();
        seed[..8].copy_from_slice(&now.to_le_bytes());
        seed[8..12].copy_from_slice(&std::process::id().to_le_bytes());
    }
    design::new_id(seed)
}

/// What saving answered: the design's id when it was saved, else why not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDto {
    pub id: Option<String>,
    pub problems: Vec<Problem>,
    /// Rooms it is assigned to that would refuse it.
    pub refused: BTreeMap<String, Vec<Problem>>,
}

/// Save `design` as the user's `id` (`None`: a new one). Refused when the
/// design is broken, or when a room it is assigned to would refuse it.
pub fn save_design(
    store: &rail_store::Store,
    id: Option<&str>,
    design: &HudDesign,
) -> Result<SaveDto, String> {
    let reader = store.reader();
    let presets = Presets::shipped();
    let catalog = Catalog::new(custom(reader));
    let problems = design::check(design, &catalog);
    if let Some(id) = id
        && !design::valid_user_id(id, &presets)
    {
        return Err(format!("{id} is not a design id of yours"));
    }
    let rooms = rooms()?;
    let mut refused = BTreeMap::new();
    if let Some(id) = id {
        for assignment in assignments(reader)?.of_layout(id) {
            refused.extend(refused_on(&assignment.site, design, &catalog, &rooms));
        }
    }
    if !problems.is_empty() || !refused.is_empty() {
        return Ok(SaveDto {
            id: None,
            problems,
            refused,
        });
    }
    let id = id.map_or_else(new_design_id, str::to_owned);
    store
        .writer()
        .and_then(|writer| writer.save_hud_layout(&id, &design.to_json()))
        .map_err(text)?;
    Ok(SaveDto {
        id: Some(id),
        problems,
        refused,
    })
}

/// What assigning answered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignDto {
    pub ok: bool,
    pub refused: BTreeMap<String, Vec<Problem>>,
}

/// Use `layout` (`None`: clear) for tables of `site` (or `*`), `size`
/// (`None`: every size) and `format` (`None`: every format).
pub fn assign(
    store: &rail_store::Store,
    site: &str,
    size: Option<u32>,
    format: Option<GameFormat>,
    layout: Option<&str>,
) -> Result<AssignDto, String> {
    let rooms = rooms()?;
    if site != ANY && !rooms.iter().any(|room| room.id == site) {
        return Err(format!("{site}: no HUD is allowed there"));
    }
    if size.is_some_and(|s| !(2..=10).contains(&s)) {
        return Err("a table has 2 to 10 seats".into());
    }
    let reader = store.reader();
    if let Some(layout) = layout {
        let design =
            load_design(reader, layout).ok_or_else(|| format!("{layout}: no such design"))?;
        let catalog = Catalog::new(custom(reader));
        let refused = refused_on(site, &design, &catalog, &rooms);
        if !refused.is_empty() {
            return Ok(AssignDto { ok: false, refused });
        }
    }
    store
        .writer()
        .and_then(|writer| {
            writer.set_hud_layout_assignment(
                site,
                size.unwrap_or(0),
                format.map_or(ANY, GameFormat::as_str),
                layout,
            )
        })
        .map_err(text)?;
    Ok(AssignDto {
        ok: true,
        refused: BTreeMap::new(),
    })
}

/// A rectangle for the window.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct RectDto {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl From<Rect> for RectDto {
    fn from(r: Rect) -> Self {
        Self {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
        }
    }
}

/// One thing the preview paints (the HUD's scene, item for item).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemDto {
    Fill {
        rect: RectDto,
        radius: u32,
        /// `[r, g, b, a]`, straight alpha.
        color: [u8; 4],
    },
    Text {
        rect: RectDto,
        text: String,
        px: u32,
        color: [u8; 4],
        bold: bool,
        align: &'static str,
    },
}

/// The preview of a design on one room's table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDto {
    pub width: u32,
    pub height: u32,
    pub size: u32,
    /// The table under the overlay: the seat plates by slot and the board.
    pub plates: Vec<RectDto>,
    pub board: RectDto,
    pub hero_slot: u32,
    /// What the overlay paints.
    pub items: Vec<ItemDto>,
    /// Each seat panel by slot, and the statistics it shows there.
    pub panels: Vec<PanelDto>,
    pub legend: Option<RectDto>,
    /// What the room refuses or leaves out of the design.
    pub problems: Vec<Problem>,
}

/// One seat's panel in the preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelDto {
    pub slot: u32,
    pub rect: RectDto,
    pub stats: Vec<String>,
    pub placed_by_user: bool,
    /// The made-up player's stack, big blinds.
    pub stack_bb: u32,
}

/// A made-up value for statistic `index` at `seat`, inside one of its
/// bands (so the preview shows its colours): the middle of a band picked by
/// seat; a statistic without bands gets a number between 10 and 60.
fn made_up(bands: &[Band], seat: u32, index: u32) -> JsNumber {
    let n = |v: u32| JsNumber::from_u64(u64::from(v));
    if bands.is_empty() {
        return n(10 + (seat * 7 + index * 11) % 50);
    }
    let count = u32::try_from(bands.len()).unwrap_or(1);
    let pick = (seat + index) % count;
    let at = usize::try_from(pick).unwrap_or(0);
    let below = bands[at].below.map(JsNumber::from_f64);
    let previous = at
        .checked_sub(1)
        .and_then(|i| bands[i].below)
        .map(JsNumber::from_f64);
    let two = n(2);
    match (previous, below) {
        (Some(low), Some(high)) => (low + high) / two,
        (None, Some(high)) => high / two,
        (Some(low), None) => low + low / n(4) + n(1),
        (None, None) => n(25),
    }
}

/// The band a value falls in (`DisplayStat::tone`'s rule).
fn tone_of(bands: &[Band], value: JsNumber) -> Option<Tone> {
    bands
        .iter()
        .find(|band| {
            band.below
                .is_none_or(|below| value.less_than(JsNumber::from_f64(below)))
        })
        .map(|band| band.tone)
}

/// `design` on a `size`-seat table of `site` with made-up players and
/// numbers, the user's dragged panels of that room and size, under the
/// room's permit (its rules cut the design down as on a real table).
pub fn preview(
    reader: Option<&rail_store::Reader>,
    design: &HudDesign,
    site: &str,
    size: u32,
) -> Result<PreviewDto, String> {
    let size = size.clamp(2, 10);
    let compliance = crate::policy::compliance()?;
    let permit = compliance
        .permit(site)
        .map_err(|reason| format!("{site}: no HUD there ({reason:?})"))?;
    let restrictions = *permit.restrictions();
    let catalog = Catalog::new(reader.map(custom).unwrap_or_default());
    let panel = design::panel_design(design, &catalog);
    let compiled = PanelStats::compile(&panel, &design.overrides, catalog.custom());
    let positions: Positions = reader
        .and_then(|r| r.hud_seat_positions().ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.site == site && p.size == size)
        .map(|p| (p.slot, (p.x, p.y)))
        .collect();
    // Made-up players: seat 1 is the hero; stacks alternate short and deep
    // (so a cell by stack depth shows on some panels); one villain has a
    // colour tag, a label and a note (shown only where the room allows).
    let stack_of = |seat: u32| if seat.is_multiple_of(2) { 12 } else { 60 };
    let panels: Vec<SeatPanel> = (1..=size)
        .map(|seat| {
            let tenths = Some(i64::from(stack_of(seat)) * 10);
            let stats: Vec<StatCell> = design
                .cells
                .iter()
                .zip(0_u32..)
                .filter(|(cell, _)| cell.when.is_none_or(|when: StackWhen| when.holds(tenths)))
                .filter_map(|(cell, index)| {
                    let info = catalog.info(&cell.stat)?;
                    let bands = design::bands_of(design, &cell.stat, &info);
                    let value = made_up(&bands, seat, index);
                    let decimals = design
                        .overrides
                        .get(&cell.stat)
                        .and_then(|o| o.decimals)
                        .unwrap_or(0);
                    Some(StatCell {
                        id: cell.stat.clone(),
                        text: format_fixed(value, decimals),
                        tone: tone_of(&bands, value),
                        // A thin sample on one seat: R2.5's dimming.
                        opacity_permille: if seat == 3 { 700 } else { 1000 },
                    })
                })
                .collect();
            SeatPanel {
                player: format!("Player {seat}"),
                seat: Some(seat),
                hands: i64::from(40 + seat * 173),
                stats,
                words: if seat == 2 {
                    PanelWords {
                        colour: Some(TagColour::Green),
                        label: Some("made-up".into()),
                        noted: true,
                    }
                } else {
                    PanelWords::default()
                },
            }
        })
        .collect();
    let frame = OverlayFrame {
        permit,
        status: None,
        debug: None,
        size: Some(size),
        seating: Seating {
            layout: None,
            rotate_to: None,
            positions,
            drags_seen: 0,
        },
        panels,
        legend: compiled.legend_tones(),
        design: panel.clone(),
    };
    let scene = scene::compose(&frame, PREVIEW_WIDTH, PREVIEW_HEIGHT, 1000, &frame.design);
    let table = TableLayout::simulator(size);
    let plates = (0..size)
        .filter_map(|slot| table.plate(PREVIEW_WIDTH, PREVIEW_HEIGHT, slot))
        .map(RectDto::from)
        .collect();
    let colour = |c: scene::Rgba| [c.r, c.g, c.b, c.a];
    let items = scene
        .items
        .iter()
        .map(|item| match item {
            Item::Fill {
                rect,
                radius,
                color,
            } => ItemDto::Fill {
                rect: (*rect).into(),
                radius: *radius,
                color: colour(*color),
            },
            Item::Text {
                rect,
                text,
                px,
                color,
                bold,
                align,
            } => ItemDto::Text {
                rect: (*rect).into(),
                text: text.clone(),
                px: *px,
                color: colour(*color),
                bold: *bold,
                align: match align {
                    Align::Center => "center",
                },
            },
        })
        .collect();
    let panels = scene
        .seat_panels
        .iter()
        .map(|(slot, rect)| PanelDto {
            slot: *slot,
            rect: (*rect).into(),
            stats: scene
                .seat_cells
                .iter()
                .find(|(s, _)| s == slot)
                .map(|(_, cells)| cells.clone())
                .unwrap_or_default(),
            placed_by_user: scene.placed_by_user.contains(slot),
            stack_bb: stack_of(slot + 1),
        })
        .collect();
    Ok(PreviewDto {
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        size,
        plates,
        board: rail_hud::layout::board_area(PREVIEW_WIDTH, PREVIEW_HEIGHT).into(),
        hero_slot: 0,
        items,
        panels,
        legend: scene.legend.as_ref().map(|(rect, _)| (*rect).into()),
        problems: design::check_for_room(design, &restrictions, &catalog),
    })
}

/// The HUD screen's state.
#[tauri::command]
pub async fn hud_editor_state(store: State<'_, StoreState>) -> Result<EditorStateDto, String> {
    build_state(open(&store)?.reader())
}

/// A draft's problems, on every allowed room.
#[tauri::command]
pub async fn hud_design_check(
    store: State<'_, StoreState>,
    design: HudDesign,
) -> Result<CheckDto, String> {
    let catalog = Catalog::new(open(&store).map(|s| custom(s.reader())).unwrap_or_default());
    Ok(check_all(&design, &catalog, &rooms()?))
}

/// Save a design (`id` `null`: a new one).
#[tauri::command]
pub async fn hud_design_save(
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    id: Option<String>,
    design: HudDesign,
) -> Result<SaveDto, String> {
    let saved = save_design(open(&store)?, id.as_deref(), &design)?;
    if saved.id.is_some() {
        hud.layouts_written();
    }
    Ok(saved)
}

/// Delete a user's design (and its assignments).
#[tauri::command]
pub async fn hud_design_delete(
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    id: String,
) -> Result<bool, String> {
    let gone = open(&store)?
        .writer()
        .and_then(|writer| writer.delete_hud_layout(&id))
        .map_err(text)?;
    hud.layouts_written();
    Ok(gone)
}

/// Assign a design to tables of a room (or `*`), size and format.
#[tauri::command]
pub async fn hud_assign(
    store: State<'_, StoreState>,
    hud: State<'_, HudState>,
    site: String,
    size: Option<u32>,
    format: Option<GameFormat>,
    layout: Option<String>,
) -> Result<AssignDto, String> {
    let answer = assign(open(&store)?, &site, size, format, layout.as_deref())?;
    if answer.ok {
        hud.layouts_written();
    }
    Ok(answer)
}

/// The preview of a draft on one room's table of `size` seats.
#[tauri::command]
pub async fn hud_preview(
    store: State<'_, StoreState>,
    design: HudDesign,
    site: String,
    size: u32,
) -> Result<PreviewDto, String> {
    preview(open(&store).ok().map(|s| s.reader()), &design, &site, size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_config::stats::{Format, Players, SampleDef, StatDef};
    use rail_stats::custom::CustomDef;

    fn store(name: &str) -> (rail_store::Store, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("rail-app-hud-editor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = rail_store::Store::open(dir.join(rail_store::FILE_NAME)).expect("store");
        (store, dir)
    }

    fn words(s: &str) -> Text {
        Text {
            en: s.into(),
            hr: s.into(),
        }
    }

    /// A user's statistic whose predicate reads the cards (made up).
    fn card_stat(store: &rail_store::Store) {
        let def = CustomDef {
            def: StatDef {
                id: "pair_raise".into(),
                group: Group::Preflop,
                players: Players::Any,
                label: words("PR"),
                name: words("Pairs raised"),
                description: words("made up"),
                formula: "pct(pair_raise, pair_raise_opp)".into(),
                format: Format {
                    unit: Unit::Percent,
                    decimals: 1,
                },
                sample: SampleDef { of: None, min: 10 },
                bands: Vec::new(),
                hud: HudPlace::None,
            },
            predicate: Some("first street = preflop and pocket_pair => action = raise".into()),
        };
        store
            .writer()
            .expect("writer")
            .write(move |tx| rail_store::custom::save_custom_stat(tx, None, &def, 1))
            .expect("saved");
    }

    fn cash() -> HudDesign {
        Presets::shipped().get("cash").expect("cash").design.clone()
    }

    /// The state lists the presets, the three allowed rooms, every shipped
    /// statistic and the user's (flagged card-split), and each preset's
    /// problems per room: only "by stack depth" is refused, and not on ACR.
    #[test]
    fn the_state() {
        let (store, dir) = store("state");
        card_stat(&store);
        let state = build_state(store.reader()).expect("state");
        assert_eq!(
            state
                .rooms
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["pokerstars", "winamax", "acr"]
        );
        assert_eq!(state.presets.len(), 4);
        let pair = state
            .stats
            .iter()
            .find(|s| s.id == "pair_raise")
            .expect("the user's statistic");
        assert!(pair.custom && pair.card_split);
        assert!(state.stats.iter().any(|s| s.id == "vpip" && !s.card_split));
        for (id, check) in &state.checks {
            assert!(check.problems.is_empty(), "{id}");
            for (room, problems) in &check.rooms {
                let refused = !design::assignable(problems);
                assert_eq!(
                    refused,
                    id == "mtt-stack" && room != "acr",
                    "{id} on {room}"
                );
            }
        }
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Saving and assigning: a design with a card-split statistic saves, may
    /// be assigned to Winamax and ACR but not to PokerStars (nor to every
    /// room); a design assigned to PokerStars cannot be saved with one; a
    /// broken design is not saved; a preset's id is not the user's.
    #[test]
    fn save_and_assign_refuse_what_a_room_forbids() {
        let (store, dir) = store("assign");
        card_stat(&store);
        let mut design = cash();
        design.name = "With pairs".into();
        design.cells.push(design::Cell {
            stat: "pair_raise".into(),
            when: None,
        });
        let saved = save_design(&store, None, &design).expect("save");
        let id = saved.id.expect("saved");
        assert!(id.starts_with("d-") && id.len() == 34, "{id}");
        let refused = assign(
            &store,
            "pokerstars",
            None,
            Some(GameFormat::Cash),
            Some(&id),
        )
        .expect("answer");
        assert!(!refused.ok);
        assert!(matches!(
            refused.refused["pokerstars"][..],
            [Problem::CardSplit { .. }]
        ));
        let everywhere = assign(&store, ANY, None, None, Some(&id)).expect("answer");
        assert!(!everywhere.ok && everywhere.refused.contains_key("pokerstars"));
        assert!(
            assign(&store, "winamax", Some(6), None, Some(&id))
                .expect("answer")
                .ok
        );
        assert!(
            assign(&store, "acr", None, Some(GameFormat::Mtt), Some(&id))
                .expect("answer")
                .ok
        );
        // The stack-depth preset: ACR only.
        assert!(
            !assign(&store, "winamax", None, None, Some("mtt-stack"))
                .expect("answer")
                .ok
        );
        assert!(
            assign(
                &store,
                "acr",
                None,
                Some(GameFormat::Mtt),
                Some("mtt-stack")
            )
            .expect("answer")
            .ok
        );
        assert!(assign(&store, "ggpoker", None, None, Some("cash")).is_err());
        assert!(assign(&store, "acr", Some(11), None, Some("cash")).is_err());
        assert!(assign(&store, "acr", None, None, Some("nope")).is_err());
        // Assigned to PokerStars (cash preset), then edited to show the
        // card-split statistic there: the save is refused, saying where.
        let mut plain = cash();
        plain.name = "Plain".into();
        let plain_id = save_design(&store, None, &plain)
            .expect("save")
            .id
            .expect("id");
        assert!(
            assign(&store, "pokerstars", None, None, Some(&plain_id))
                .expect("answer")
                .ok
        );
        plain.cells.push(design::Cell {
            stat: "pair_raise".into(),
            when: None,
        });
        let again = save_design(&store, Some(&plain_id), &plain).expect("answer");
        assert!(again.id.is_none() && again.refused.contains_key("pokerstars"));
        // Broken: refused with its problems; a preset's id is not the user's.
        let mut broken = cash();
        broken.cells.clear();
        let answer = save_design(&store, None, &broken).expect("answer");
        assert!(answer.id.is_none() && answer.problems.contains(&Problem::NoCells));
        assert!(save_design(&store, Some("cash"), &cash()).is_err());
        let state = build_state(store.reader()).expect("state");
        assert_eq!(state.designs.len(), 2);
        // Winamax 6-max, ACR tournaments (the stack-depth preset replaced the
        // first design there), PokerStars.
        assert_eq!(state.assignments.len(), 3);
        assert!(state.assignments.iter().all(|a| a.refused.is_empty()));
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The preview is the HUD's scene: the user's columns; on PokerStars the
    /// card-split statistic and the stack cell are gone, the labels too; on
    /// ACR the stack cell shows beside the short stacks only.
    #[test]
    fn the_preview_is_the_renderers() {
        let (store, dir) = store("preview");
        card_stat(&store);
        let mut design = cash();
        design.columns = 2;
        design.cells = vec![
            design::Cell {
                stat: "vpip".into(),
                when: None,
            },
            design::Cell {
                stat: "pair_raise".into(),
                when: None,
            },
            design::Cell {
                stat: "steal".into(),
                when: Some(StackWhen {
                    below_bb: Some(20),
                    at_least_bb: None,
                }),
            },
        ];
        let stars = preview(Some(store.reader()), &design, "pokerstars", 6).expect("preview");
        assert_eq!(stars.panels.len(), 6);
        assert!(stars.panels.iter().all(|p| p.stats == ["vpip"]));
        assert!(stars.problems.contains(&Problem::CardSplit {
            stat: "pair_raise".into()
        }));
        let acr = preview(Some(store.reader()), &design, "acr", 6).expect("preview");
        for panel in &acr.panels {
            let short = panel.stack_bb < 20;
            assert_eq!(
                panel.stats.contains(&"steal".to_owned()),
                short,
                "{panel:?}"
            );
            assert!(panel.stats.contains(&"pair_raise".to_owned()));
        }
        assert_eq!(acr.plates.len(), 6);
        assert!(acr.legend.is_some());
        let winamax = preview(None, &design, "winamax", 9).expect("preview");
        assert_eq!(winamax.panels.len(), 9);
        assert!(preview(None, &design, "ggpoker", 6).is_err());
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
