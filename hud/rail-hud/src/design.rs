//! HUD designs, presets and assignments (docs/RAIL-PLAN.md R3.9; guideline
//! §7: "a visual editor: drag-and-drop statistics, presets for cash, MTT and
//! Spin, layouts per room and number of seats").
//!
//! - **A design** ([`HudDesign`]) is what a seat's panel and its popup show:
//!   the panel's cells in order (a statistic id each - a shipped R2.4
//!   definition or the user's own R2.10 statistic - laid out `columns` to a
//!   row), the user's **overrides** keyed by statistic id (colour bands,
//!   decimals, the sample for full opacity: a layer over the definitions,
//!   never an edit of `config/stats/`), the popup's sections, the legend,
//!   the player's words and the number of colour thresholds. A cell may
//!   show only at some stack depths ([`StackWhen`]): that is display
//!   switching by game state, which PokerStars and Winamax forbid.
//! - **Presets** ([`Presets::shipped`], `config/hud/presets.json`): cash,
//!   tournament, Spin - each complies with every allowed room - and
//!   "tournament by stack depth" (only where switching by game state is
//!   allowed: ACR). A user's design starts as a copy of one and remembers
//!   it (`preset`) for "reset to preset".
//! - **Assignments** ([`Assignments`]): which design a table gets per room
//!   (or every room), table size (or every size) and game format (or
//!   every format); the most specific wins - room, then format, then size
//!   ([`Assignments::resolve`]) - and nothing assigned is the format's
//!   preset.
//! - **Restrictions** ([`check_for_room`]): a design is checked against
//!   each room it is assigned to (`sites.json` `hud.restrictions`): on
//!   PokerStars no card-split statistic (an R2.10 statistic whose predicate
//!   reads the cards, [`rail_stats::custom::CustomSet::card_split`]), no
//!   cell that switches with the stack, at most two colour thresholds and
//!   no labels; on Winamax no switching; on ACR no labels. What a room
//!   refuses ([`Severity::Refuse`]) cannot be assigned there (the app's
//!   editor says why); what it only leaves out ([`Severity::Note`]: the
//!   player's words) is said. The renderer enforces the same rules on
//!   whatever reaches it ([`crate::panel::PanelDesign::enforce`]): defence
//!   in depth, for a design that changed after it was assigned (a user's
//!   statistic edited to read the cards) or came from another computer.
//!
//! Structural, so not checked per design: statistics only from the user's
//! own hands (the data path, R3.7), nothing from the hand in play (only
//! finished hands are stored; a stack-depth cell reads the stack of the
//! table's last finished hand), raw counts (every formula reads the
//! player's own counters), no charts or graphs (the panel has no such
//! item).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

use rail_config::model::HudRestrictions;
use rail_config::stats::{Band, Group, HudPlace, MAX_SAMPLE_MIN, Players, Text, Unit};
use rail_stats::custom::CustomSet;
use rail_stats::display::Display;
use serde::{Deserialize, Serialize};

use crate::panel::{PanelDesign, PanelStats, StatSlot, Switching};

/// The presets, compiled in.
pub const SHIPPED_PRESETS: &str = include_str!("../../../config/hud/presets.json");

/// The design format this build writes and reads; a newer design (from a
/// newer build on another computer) is not read.
pub const DESIGN_VERSION: u32 = 1;
/// At most this many cells on a panel.
pub const MAX_CELLS: usize = 12;
/// At most this many cells to a row.
pub const MAX_COLUMNS: u32 = 6;
/// A design's name, characters.
pub const MAX_NAME: usize = 60;
/// Popup sections, and statistics in all of them.
pub const MAX_POPUP_SECTIONS: usize = 8;
pub const MAX_POPUP_STATS: usize = 40;
/// A popup section's title, characters.
pub const MAX_TITLE: usize = 40;
/// Decimals a cell may show (the panel's default is none).
pub const MAX_DECIMALS: u32 = 2;
/// A stack bound, big blinds.
pub const MAX_STACK_BB: u32 = 1000;
/// Colour bands an override may have.
pub const MAX_BANDS: usize = 5;

/// The game a table plays, as designs are assigned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameFormat {
    Cash,
    /// Tournaments and sit-and-gos.
    Mtt,
    Spin,
}

impl GameFormat {
    pub const ALL: [Self; 3] = [Self::Cash, Self::Mtt, Self::Spin];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cash => "cash",
            Self::Mtt => "mtt",
            Self::Spin => "spin",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.as_str() == text)
    }

    /// The format of a hand's segment (`rail_core::phf::GameFormat`).
    pub fn of_hand(format: rail_core::phf::GameFormat) -> Self {
        match format {
            rail_core::phf::GameFormat::Cash => Self::Cash,
            rail_core::phf::GameFormat::Tournament | rail_core::phf::GameFormat::Sng => Self::Mtt,
            rail_core::phf::GameFormat::Spin => Self::Spin,
        }
    }
}

/// When a cell shows: the player's starting stack in the table's last
/// finished hand, in whole big blinds. Display switching by game state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackWhen {
    /// Shown below this many big blinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below_bb: Option<u32>,
    /// Shown from this many big blinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_least_bb: Option<u32>,
}

impl StackWhen {
    /// Whether a stack of `tenths` tenths of a big blind is in range;
    /// `None` (unknown) never is.
    pub fn holds(&self, tenths: Option<i64>) -> bool {
        let Some(tenths) = tenths else {
            return false;
        };
        self.below_bb.is_none_or(|bb| tenths < i64::from(bb) * 10)
            && self
                .at_least_bb
                .is_none_or(|bb| tenths >= i64::from(bb) * 10)
    }

    fn valid(&self) -> bool {
        let bound = |bb: Option<u32>| bb.is_none_or(|bb| (1..=MAX_STACK_BB).contains(&bb));
        (self.below_bb.is_some() || self.at_least_bb.is_some())
            && bound(self.below_bb)
            && bound(self.at_least_bb)
            && match (self.at_least_bb, self.below_bb) {
                (Some(low), Some(high)) => low < high,
                _ => true,
            }
    }
}

/// One cell of the panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    /// The statistic's id.
    pub stat: String,
    /// Shown only at these stack depths (switching by game state).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<StackWhen>,
}

/// The user's overrides of one statistic's display (R2.4's note: a layer
/// keyed by id).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatOverride {
    /// Colour bands, ascending (the last has no `below`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bands: Option<Vec<Band>>,
    /// Decimals on the panel (it shows whole numbers by default) and in
    /// the popup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u32>,
    /// Full opacity from this sample (R2.5's `sample.min`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_sample: Option<u64>,
}

impl StatOverride {
    pub fn is_empty(&self) -> bool {
        self.bands.is_none() && self.decimals.is_none() && self.min_sample.is_none()
    }
}

/// One section of the popup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupSection {
    /// A definitions' group (its title in the app's words).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<Group>,
    /// The user's title (over the group's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub stats: Vec<String>,
}

/// A panel and popup design.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudDesign {
    /// [`DESIGN_VERSION`].
    pub version: u32,
    /// The user's name for it (a preset's comes from the presets file).
    #[serde(default)]
    pub name: String,
    /// The preset it was copied from ("reset to preset").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// The game it is made for (the editor's default assignment).
    pub format: GameFormat,
    /// Cells to a row.
    pub columns: u32,
    pub cells: Vec<Cell>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub overrides: BTreeMap<String, StatOverride>,
    #[serde(default)]
    pub popup: Vec<PopupSection>,
    pub legend: bool,
    /// The player's colour tag, labels and note mark, where a room allows
    /// labelling players (Winamax; never PokerStars or ACR).
    pub player_labels: bool,
    /// Colour by at most this many thresholds (`None`: every band).
    pub max_colour_thresholds: Option<u32>,
}

impl HudDesign {
    /// A design from its stored JSON; `None` when this build cannot read
    /// it (a newer format, a broken row).
    pub fn parse(text: &str) -> Option<Self> {
        let design: Self = serde_json::from_str(text).ok()?;
        (design.version == DESIGN_VERSION).then_some(design)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Every statistic it names: cells, then popup sections.
    pub fn stat_ids(&self) -> impl Iterator<Item = &str> {
        self.cells.iter().map(|c| c.stat.as_str()).chain(
            self.popup
                .iter()
                .flat_map(|s| s.stats.iter().map(String::as_str)),
        )
    }
}

/// A shipped preset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: Text,
    pub description: Text,
    pub design: HudDesign,
}

/// `config/hud/presets.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presets {
    pub version: u32,
    /// The preset of each format when nothing is assigned.
    pub defaults: BTreeMap<GameFormat, String>,
    pub presets: Vec<Preset>,
}

impl Presets {
    /// The compiled-in presets (a test holds them valid).
    pub fn shipped() -> Self {
        serde_json::from_str(SHIPPED_PRESETS).unwrap_or_else(|_| Self {
            version: 1,
            defaults: BTreeMap::new(),
            presets: Vec::new(),
        })
    }

    pub fn get(&self, id: &str) -> Option<&Preset> {
        self.presets.iter().find(|p| p.id == id)
    }

    /// The preset of `format` when nothing is assigned.
    pub fn default_for(&self, format: GameFormat) -> &str {
        self.defaults
            .get(&format)
            .map_or(format.as_str(), String::as_str)
    }

    /// Whether `id` is a preset's (a user's design may not take it).
    pub fn is_preset(&self, id: &str) -> bool {
        self.get(id).is_some()
    }
}

/// What a statistic is, as a design needs to know.
#[derive(Debug, Clone, PartialEq)]
pub struct StatInfo {
    /// A user's (R2.10).
    pub custom: bool,
    /// Split by the cards (an R2.10 predicate reads them).
    pub card_split: bool,
    /// The hero's only (`players: hero`): never on a villain's panel.
    pub hero_only: bool,
    /// Money: never shown on a HUD (an opponent's money is not shown).
    pub money: bool,
    /// The definition's bands.
    pub bands: Vec<Band>,
    /// Shipped `hud` membership.
    pub hud: HudPlace,
}

/// The statistics a design may name: the shipped definitions and the
/// user's own.
#[derive(Debug, Clone)]
pub struct Catalog {
    shipped: Option<Display>,
    custom: CustomSet,
}

impl Catalog {
    pub fn new(custom: CustomSet) -> Self {
        Self {
            shipped: Display::shipped().ok(),
            custom,
        }
    }

    /// The shipped definitions only.
    pub fn shipped() -> Self {
        Self::new(CustomSet::default())
    }

    pub fn custom(&self) -> &CustomSet {
        &self.custom
    }

    /// A statistic by id: a shipped definition wins (a user's may never
    /// take a shipped id).
    pub fn info(&self, id: &str) -> Option<StatInfo> {
        if let Some(stat) = self.shipped.as_ref().and_then(|d| d.get(id)) {
            return Some(StatInfo {
                custom: false,
                card_split: false,
                hero_only: stat.def.players == Players::Hero,
                money: stat.def.format.unit == Unit::Money,
                bands: stat.def.bands.clone(),
                hud: stat.def.hud,
            });
        }
        let stat = self.custom.get(id)?;
        Some(StatInfo {
            custom: true,
            card_split: self.custom.card_split(id),
            hero_only: stat.def.def.players == Players::Hero,
            money: stat.def.def.format.unit == Unit::Money,
            bands: stat.def.def.bands.clone(),
            hud: stat.def.def.hud,
        })
    }
}

/// How bad a problem is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// The design cannot be saved (any room) or assigned (that room).
    Refuse,
    /// The room leaves this part out; the design may be assigned.
    Note,
}

/// One thing a design cannot do (anywhere, or on one room). The app's
/// editor says each in the user's language by its `code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Problem {
    /// Not a format this build reads.
    Version,
    NameTooLong,
    NoCells,
    TooManyCells,
    Columns,
    /// Neither a shipped definition nor one of the user's.
    UnknownStat {
        stat: String,
    },
    /// On the panel twice.
    DuplicateStat {
        stat: String,
    },
    /// The hero's only (all-in EV): a panel describes every player.
    HeroOnlyStat {
        stat: String,
    },
    /// Money: an opponent's money is never shown.
    MoneyStat {
        stat: String,
    },
    /// The stack range is empty or out of bounds.
    BadWhen {
        stat: String,
    },
    /// Override bands not ascending, too many, not finite.
    BadBands {
        stat: String,
    },
    BadDecimals {
        stat: String,
    },
    BadSample {
        stat: String,
    },
    TooManyPopup,
    TitleTooLong,
    /// (room) Split by the cards: PokerStars forbids it.
    CardSplit {
        stat: String,
    },
    /// (room) Shown at some stack depths only: no display switching.
    GameStateSwitching {
        stat: String,
    },
    /// (room) Coloured by more thresholds than the room allows.
    ColourThresholds {
        stat: String,
        count: u32,
        max: u32,
    },
    /// (room) The player's words are never shown there.
    Labels,
    /// (room) The room's HUD is not allowed (or unknown).
    RoomNotAllowed,
}

impl Problem {
    pub fn severity(&self) -> Severity {
        match self {
            Self::Labels => Severity::Note,
            _ => Severity::Refuse,
        }
    }
}

fn bands_ok(bands: &[Band]) -> bool {
    if bands.is_empty() || bands.len() > MAX_BANDS {
        return false;
    }
    let (last, rest) = match bands.split_last() {
        Some(split) => split,
        None => return false,
    };
    if last.below.is_some() {
        return false;
    }
    let mut previous: Option<f64> = None;
    for band in rest {
        let Some(below) = band.below else {
            return false;
        };
        if !below.is_finite() || previous.is_some_and(|p| below <= p) {
            return false;
        }
        previous = Some(below);
    }
    true
}

/// What is wrong with `design` on any room (empty: it may be saved).
pub fn check(design: &HudDesign, catalog: &Catalog) -> Vec<Problem> {
    let mut out = Vec::new();
    if design.version != DESIGN_VERSION {
        out.push(Problem::Version);
    }
    if design.name.chars().count() > MAX_NAME {
        out.push(Problem::NameTooLong);
    }
    if design.cells.is_empty() {
        out.push(Problem::NoCells);
    }
    if design.cells.len() > MAX_CELLS {
        out.push(Problem::TooManyCells);
    }
    if !(1..=MAX_COLUMNS).contains(&design.columns) {
        out.push(Problem::Columns);
    }
    let mut seen: Vec<&str> = Vec::new();
    for cell in &design.cells {
        if seen.contains(&cell.stat.as_str()) {
            out.push(Problem::DuplicateStat {
                stat: cell.stat.clone(),
            });
        }
        seen.push(&cell.stat);
        if cell.when.is_some_and(|when| !when.valid()) {
            out.push(Problem::BadWhen {
                stat: cell.stat.clone(),
            });
        }
    }
    let mut named: Vec<&str> = Vec::new();
    for id in design.stat_ids() {
        if named.contains(&id) {
            continue;
        }
        named.push(id);
        let stat = id.to_owned();
        match catalog.info(id) {
            None => out.push(Problem::UnknownStat { stat }),
            Some(info) if info.hero_only => out.push(Problem::HeroOnlyStat { stat }),
            Some(info) if info.money => out.push(Problem::MoneyStat { stat }),
            Some(_) => {}
        }
    }
    for (id, over) in &design.overrides {
        let stat = id.clone();
        if over.bands.as_deref().is_some_and(|bands| !bands_ok(bands)) {
            out.push(Problem::BadBands { stat: stat.clone() });
        }
        if over.decimals.is_some_and(|d| d > MAX_DECIMALS) {
            out.push(Problem::BadDecimals { stat: stat.clone() });
        }
        if over.min_sample.is_some_and(|m| m > MAX_SAMPLE_MIN) {
            out.push(Problem::BadSample { stat });
        }
    }
    let popup_stats: usize = design.popup.iter().map(|s| s.stats.len()).sum();
    if design.popup.len() > MAX_POPUP_SECTIONS || popup_stats > MAX_POPUP_STATS {
        out.push(Problem::TooManyPopup);
    }
    if design.popup.iter().any(|s| {
        s.title
            .as_ref()
            .is_some_and(|t| t.chars().count() > MAX_TITLE)
    }) {
        out.push(Problem::TitleTooLong);
    }
    out
}

/// A statistic's bands in `design`: the user's override, else the
/// definition's.
pub fn bands_of(design: &HudDesign, id: &str, info: &StatInfo) -> Vec<Band> {
    design
        .overrides
        .get(id)
        .and_then(|o| o.bands.clone())
        .unwrap_or_else(|| info.bands.clone())
}

/// The colour thresholds a statistic's bands show under at most `max`.
fn thresholds(bands: &[Band], max: Option<u32>) -> u32 {
    let collapsed = rail_config::stats::collapse_bands(bands, max);
    u32::try_from(collapsed.len().saturating_sub(1)).unwrap_or(u32::MAX)
}

/// What a room with `rules` refuses or leaves out of `design` (the
/// design's own problems are [`check`]'s).
pub fn check_for_room(
    design: &HudDesign,
    rules: &HudRestrictions,
    catalog: &Catalog,
) -> Vec<Problem> {
    let mut out = Vec::new();
    let mut named: Vec<&str> = Vec::new();
    for id in design.stat_ids() {
        if named.contains(&id) {
            continue;
        }
        named.push(id);
        if rules.no_card_split_stats && catalog.info(id).is_some_and(|i| i.card_split) {
            out.push(Problem::CardSplit {
                stat: id.to_owned(),
            });
        }
    }
    if rules.no_game_state_switching {
        for cell in design.cells.iter().filter(|c| c.when.is_some()) {
            out.push(Problem::GameStateSwitching {
                stat: cell.stat.clone(),
            });
        }
    }
    if let Some(max) = rules.max_colour_thresholds {
        for cell in &design.cells {
            let Some(info) = catalog.info(&cell.stat) else {
                continue;
            };
            let count = thresholds(
                &bands_of(design, &cell.stat, &info),
                design.max_colour_thresholds,
            );
            if count > max {
                out.push(Problem::ColourThresholds {
                    stat: cell.stat.clone(),
                    count,
                    max,
                });
            }
        }
    }
    if rules.no_player_labels && design.player_labels {
        out.push(Problem::Labels);
    }
    out
}

/// Whether `problems` let the design be assigned (only notes).
pub fn assignable(problems: &[Problem]) -> bool {
    problems.iter().all(|p| p.severity() == Severity::Note)
}

/// The panel the renderer draws for `design` (statistics flagged with what
/// a room may refuse: card-split, switching). Overrides are the panel's
/// statistics' (`crate::panel::PanelStats::compile`).
pub fn panel_design(design: &HudDesign, catalog: &Catalog) -> PanelDesign {
    PanelDesign {
        stats: design
            .cells
            .iter()
            .map(|cell| StatSlot {
                id: cell.stat.clone(),
                card_split: catalog.info(&cell.stat).is_some_and(|i| i.card_split),
                switching: if cell.when.is_some() {
                    Switching::ByGameState
                } else {
                    Switching::Fixed
                },
                when: cell.when,
            })
            .collect(),
        max_colour_thresholds: design.max_colour_thresholds,
        avoid_table_graphics: true,
        player_labels: design.player_labels,
        legend: design.legend,
        columns: Some(design.columns.clamp(1, MAX_COLUMNS)),
    }
}

/// One assignment: tables of `site` (or [`ANY`]), `size` (`None`: every
/// size) and `format` (`None`: every format) get `layout`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub site: String,
    pub size: Option<u32>,
    pub format: Option<GameFormat>,
    pub layout: String,
}

/// Every room.
pub const ANY: &str = "*";

impl Assignment {
    /// From the store's row (`size` 0 and format `*` are "every").
    pub fn from_store(row: &rail_store::LayoutAssignment) -> Option<Self> {
        let format = match row.format.as_str() {
            ANY => None,
            other => Some(GameFormat::parse(other)?),
        };
        Some(Self {
            site: row.site.clone(),
            size: (row.size != 0).then_some(row.size),
            format,
            layout: row.layout_id.clone(),
        })
    }
}

/// Where a table's design came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Assigned,
    /// Nothing assigned: the format's preset.
    Default,
}

/// The user's assignments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Assignments(pub Vec<Assignment>);

impl Assignments {
    /// The design for a table of `site`, `size` seats (when known) and
    /// `format`: the most specific assignment whose design `exists` - room
    /// before every room, then format before every format, then size
    /// before every size - else the format's preset.
    pub fn resolve(
        &self,
        site: &str,
        size: Option<u32>,
        format: GameFormat,
        presets: &Presets,
        exists: impl Fn(&str) -> bool,
    ) -> (String, Source) {
        // An unknown size takes only "every size".
        let sizes: &[Option<u32>] = if size.is_some() {
            &[size, None]
        } else {
            &[None]
        };
        for room in [site, ANY] {
            for f in [Some(format), None] {
                for &s in sizes {
                    if let Some(found) = self
                        .0
                        .iter()
                        .find(|a| a.site == room && a.format == f && a.size == s)
                        && exists(&found.layout)
                    {
                        return (found.layout.clone(), Source::Assigned);
                    }
                }
            }
        }
        (presets.default_for(format).to_owned(), Source::Default)
    }

    /// Every assignment of `layout`.
    pub fn of_layout<'a>(&'a self, layout: &'a str) -> impl Iterator<Item = &'a Assignment> {
        self.0.iter().filter(move |a| a.layout == layout)
    }
}

/// A design compiled for drawing: the panel the renderer lays out and the
/// statistics the engine evaluates per player (with the user's overrides).
#[derive(Debug)]
pub struct Compiled {
    /// The design's id (a preset's, a user's, or [`FORCED`]).
    pub id: String,
    pub panel: PanelDesign,
    pub stats: PanelStats,
}

/// The id a forced design is compiled under (`Hud::set_design`).
pub const FORCED: &str = "*forced*";

/// The designs the HUD draws with (R3.9): the presets, the user's designs
/// and assignments from the store, the statistics they may name, and each
/// design compiled once.
#[derive(Debug)]
pub struct DesignSet {
    pub presets: Presets,
    user: BTreeMap<String, HudDesign>,
    assignments: Assignments,
    catalog: Catalog,
    compiled: BTreeMap<String, Arc<Compiled>>,
}

impl Default for DesignSet {
    fn default() -> Self {
        Self {
            presets: Presets::shipped(),
            user: BTreeMap::new(),
            assignments: Assignments::default(),
            catalog: Catalog::shipped(),
            compiled: BTreeMap::new(),
        }
    }
}

impl DesignSet {
    /// What the store says now; every compiled design is dropped.
    pub fn reset(
        &mut self,
        user: Vec<(String, HudDesign)>,
        assignments: Vec<Assignment>,
        custom: CustomSet,
    ) {
        self.user = user
            .into_iter()
            .filter(|(id, _)| !self.presets.is_preset(id))
            .collect();
        self.assignments = Assignments(assignments);
        self.catalog = Catalog::new(custom);
        self.compiled.clear();
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    /// A design by id: the user's, else a preset's.
    pub fn design(&self, id: &str) -> Option<&HudDesign> {
        self.user
            .get(id)
            .or_else(|| self.presets.get(id).map(|p| &p.design))
    }

    /// The design id for a table ([`Assignments::resolve`]).
    pub fn resolve(&self, site: &str, size: Option<u32>, format: GameFormat) -> String {
        self.assignments
            .resolve(site, size, format, &self.presets, |id| {
                self.design(id).is_some()
            })
            .0
    }

    /// The design `id` compiled (once); an id that is no design draws R3.4's
    /// default panel.
    pub fn compiled(&mut self, id: &str) -> Arc<Compiled> {
        if let Some(found) = self.compiled.get(id) {
            return Arc::clone(found);
        }
        let (panel, overrides) = match self.design(id) {
            Some(design) => (
                panel_design(design, &self.catalog),
                design.overrides.clone(),
            ),
            None => (PanelDesign::default(), BTreeMap::new()),
        };
        self.compile_panel(id, panel, Some(&overrides))
    }

    /// `panel` compiled under `id` (kept until the next [`DesignSet::reset`]
    /// unless it differs from the one kept).
    pub fn compile_panel(
        &mut self,
        id: &str,
        panel: PanelDesign,
        overrides: Option<&BTreeMap<String, StatOverride>>,
    ) -> Arc<Compiled> {
        if let Some(found) = self.compiled.get(id).filter(|c| c.panel == panel) {
            return Arc::clone(found);
        }
        let empty = BTreeMap::new();
        let stats = PanelStats::compile(&panel, overrides.unwrap_or(&empty), self.catalog.custom());
        let compiled = Arc::new(Compiled {
            id: id.to_owned(),
            panel,
            stats,
        });
        self.compiled.insert(id.to_owned(), Arc::clone(&compiled));
        compiled
    }
}

/// A user's design id: `d-` and 32 hex digits from `seed` bytes.
pub fn new_id(seed: [u8; 16]) -> String {
    let mut id = String::with_capacity(34);
    id.push_str("d-");
    for byte in seed {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

/// Whether `id` is a user's design id this build makes or takes: 1 - 64
/// of `a-z 0-9 -`, not a preset's.
pub fn valid_user_id(id: &str, presets: &Presets) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !presets.is_preset(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_config::stats::{Format, SampleDef, StatDef, Tone};
    use rail_stats::custom::CustomDef;

    fn config() -> rail_config::Config {
        rail_config::load_shipped(&rail_core::parsers::REGISTRATION_ORDER).expect("shipped")
    }

    fn words(value: &str) -> Text {
        Text {
            en: value.to_owned(),
            hr: value.to_owned(),
        }
    }

    fn custom(id: &str, predicate: &str) -> CustomDef {
        CustomDef {
            def: StatDef {
                id: id.to_owned(),
                group: Group::Preflop,
                players: Players::Any,
                label: words("PP"),
                name: words("Pairs raised"),
                description: words("made up"),
                formula: format!("pct({id}, {id}_opp)"),
                format: Format {
                    unit: Unit::Percent,
                    decimals: 1,
                },
                sample: SampleDef { of: None, min: 10 },
                bands: Vec::new(),
                hud: HudPlace::None,
            },
            predicate: Some(predicate.to_owned()),
        }
    }

    fn catalog() -> Catalog {
        let (set, refused) = CustomSet::compile(&[
            custom(
                "pair_raise",
                "first street = preflop and pocket_pair => action = raise",
            ),
            custom(
                "open_shove",
                "first street = preflop and facing = none => all_in",
            ),
        ]);
        assert!(refused.is_empty(), "{refused:?}");
        Catalog::new(set)
    }

    fn rules(site: &str) -> HudRestrictions {
        config()
            .site(site)
            .and_then(|s| s.hud.restrictions)
            .expect("restrictions")
    }

    /// Every preset loads, is valid, and complies with every allowed room,
    /// but "tournament by stack depth", which switches with the stack:
    /// only ACR takes it; PokerStars and Winamax refuse it, saying why.
    /// The cash preset is the default panel (R3.4 / R3.8).
    #[test]
    fn presets_comply_where_they_should() {
        let presets = Presets::shipped();
        assert_eq!(presets.version, 1);
        let ids: Vec<&str> = presets.presets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["cash", "mtt", "spin", "mtt-stack"]);
        for format in GameFormat::ALL {
            let id = presets.default_for(format);
            assert_eq!(
                presets.get(id).expect("a default preset").design.format,
                format
            );
        }
        let catalog = Catalog::shipped();
        let config = config();
        for preset in &presets.presets {
            assert!(check(&preset.design, &catalog).is_empty(), "{}", preset.id);
            assert!(preset.design.cells.len() >= 4 && preset.design.cells.len() <= 7);
            for site in config.sites.iter().filter(|s| s.hud_permitted()) {
                let rules = site.hud.restrictions.expect("restrictions");
                let problems = check_for_room(&preset.design, &rules, &catalog);
                let refused = !assignable(&problems);
                let expected = preset.id == "mtt-stack" && site.id != "acr";
                assert_eq!(
                    refused, expected,
                    "{} on {}: {problems:?}",
                    preset.id, site.id
                );
                if expected {
                    assert!(
                        problems.iter().all(|p| matches!(
                            p,
                            Problem::GameStateSwitching { .. } | Problem::Labels
                        )),
                        "{problems:?}"
                    );
                }
            }
        }
        let cash = panel_design(&presets.get("cash").expect("cash").design, &catalog);
        let default = PanelDesign::default();
        assert_eq!(cash.stats, default.stats);
        assert_eq!(
            (cash.max_colour_thresholds, cash.player_labels, cash.legend),
            (
                default.max_colour_thresholds,
                default.player_labels,
                default.legend
            )
        );
        assert_eq!(cash.columns, Some(3));
    }

    /// The design's own checks, each refusal by its code.
    #[test]
    fn a_design_is_checked() {
        let catalog = catalog();
        let mut design = Presets::shipped().get("cash").expect("cash").design.clone();
        design.name = "x".repeat(MAX_NAME + 1);
        design.columns = 7;
        design.cells.push(Cell {
            stat: "vpip".into(),
            when: None,
        });
        design.cells.push(Cell {
            stat: "nonsense".into(),
            when: None,
        });
        design.cells.push(Cell {
            stat: "allin_ev_bb_per_100".into(),
            when: Some(StackWhen {
                below_bb: Some(10),
                at_least_bb: Some(20),
            }),
        });
        design.popup[0].stats.push("rake_per_100".into());
        design.overrides.insert(
            "pfr".into(),
            StatOverride {
                bands: Some(vec![
                    Band {
                        below: Some(20.0),
                        tone: Tone::Low,
                    },
                    Band {
                        below: Some(10.0),
                        tone: Tone::Normal,
                    },
                    Band {
                        below: None,
                        tone: Tone::High,
                    },
                ]),
                decimals: Some(3),
                min_sample: Some(MAX_SAMPLE_MIN + 1),
            },
        );
        let codes: Vec<String> = check(&design, &catalog)
            .iter()
            .map(|p| serde_json::to_value(p).expect("json")["code"].to_string())
            .collect();
        assert_eq!(
            codes,
            [
                "\"nameTooLong\"",
                "\"columns\"",
                "\"duplicateStat\"",
                "\"badWhen\"",
                "\"unknownStat\"",
                "\"heroOnlyStat\"",
                "\"moneyStat\"",
                "\"badBands\"",
                "\"badDecimals\"",
                "\"badSample\"",
            ]
        );
        let empty = HudDesign {
            cells: Vec::new(),
            ..design
        };
        assert!(check(&empty, &catalog).contains(&Problem::NoCells));
        let json = serde_json::to_string(&Problem::ColourThresholds {
            stat: "vpip".into(),
            count: 4,
            max: 2,
        })
        .expect("json");
        assert_eq!(
            json,
            r#"{"code":"colourThresholds","stat":"vpip","count":4,"max":2}"#
        );
    }

    /// Per room: a card-split statistic refused on PokerStars only; a cell
    /// by stack depth refused on PokerStars and Winamax; more than two
    /// thresholds refused on PokerStars; labels a note on PokerStars and
    /// ACR.
    #[test]
    fn rooms_refuse_what_they_forbid() {
        let catalog = catalog();
        let mut design = Presets::shipped().get("cash").expect("cash").design.clone();
        design.cells.push(Cell {
            stat: "pair_raise".into(),
            when: None,
        });
        design.cells.push(Cell {
            stat: "open_shove".into(),
            when: Some(StackWhen {
                below_bb: Some(15),
                at_least_bb: None,
            }),
        });
        design.max_colour_thresholds = None;
        assert!(check(&design, &catalog).is_empty());
        let stars = check_for_room(&design, &rules("pokerstars"), &catalog);
        assert!(stars.contains(&Problem::CardSplit {
            stat: "pair_raise".into()
        }));
        assert!(stars.contains(&Problem::GameStateSwitching {
            stat: "open_shove".into()
        }));
        assert!(stars.contains(&Problem::ColourThresholds {
            stat: "vpip".into(),
            count: 4,
            max: 2
        }));
        assert!(stars.contains(&Problem::Labels));
        assert!(!assignable(&stars));
        let winamax = check_for_room(&design, &rules("winamax"), &catalog);
        assert_eq!(
            winamax,
            [Problem::GameStateSwitching {
                stat: "open_shove".into()
            }]
        );
        let acr = check_for_room(&design, &rules("acr"), &catalog);
        assert_eq!(acr, [Problem::Labels]);
        assert!(assignable(&acr));

        // Two thresholds again, by the design's limit or by the user's own
        // bands; the card-split cell alone is then what PokerStars refuses
        // (labels aside).
        design.max_colour_thresholds = Some(2);
        design.cells.pop();
        let stars = check_for_room(&design, &rules("pokerstars"), &catalog);
        assert_eq!(
            stars,
            [
                Problem::CardSplit {
                    stat: "pair_raise".into()
                },
                Problem::Labels
            ]
        );
        design.cells.pop();
        design.max_colour_thresholds = None;
        design.overrides.clear();
        for cell in &design.cells {
            design.overrides.insert(
                cell.stat.clone(),
                StatOverride {
                    bands: Some(vec![
                        Band {
                            below: Some(10.0),
                            tone: Tone::Low,
                        },
                        Band {
                            below: Some(30.0),
                            tone: Tone::Normal,
                        },
                        Band {
                            below: None,
                            tone: Tone::High,
                        },
                    ]),
                    ..StatOverride::default()
                },
            );
        }
        design.player_labels = false;
        assert!(check_for_room(&design, &rules("pokerstars"), &catalog).is_empty());
        // The renderer's view of it: the flags travel to the panel.
        let mut flagged = design.clone();
        flagged.cells.push(Cell {
            stat: "pair_raise".into(),
            when: Some(StackWhen {
                below_bb: None,
                at_least_bb: Some(30),
            }),
        });
        let panel = panel_design(&flagged, &catalog);
        let last = panel.stats.last().expect("a slot");
        assert!(last.card_split && last.switching == Switching::ByGameState);
        assert!(!panel.enforce(&rules("pokerstars")).shows("pair_raise"));
        assert!(!panel.enforce(&rules("winamax")).shows("pair_raise"));
        assert!(panel.enforce(&rules("acr")).shows("pair_raise"));
    }

    /// The most specific assignment wins: room, then format, then size;
    /// an assignment of a design that is gone is passed over; nothing: the
    /// format's preset.
    #[test]
    fn assignments_fall_back() {
        let presets = Presets::shipped();
        let a =
            |site: &str, size: Option<u32>, format: Option<GameFormat>, layout: &str| Assignment {
                site: site.into(),
                size,
                format,
                layout: layout.into(),
            };
        let all = Assignments(vec![
            a(ANY, None, None, "everywhere"),
            a(ANY, Some(6), None, "six"),
            a(ANY, None, Some(GameFormat::Mtt), "any-mtt"),
            a("pokerstars", None, None, "stars"),
            a(
                "pokerstars",
                Some(9),
                Some(GameFormat::Cash),
                "stars-9-cash",
            ),
            a("acr", Some(6), None, "acr-6"),
            a("acr", None, Some(GameFormat::Spin), "acr-spin"),
            a("winamax", None, None, "gone"),
        ]);
        let exists = |id: &str| id != "gone";
        let r = |site: &str, size: Option<u32>, format: GameFormat| {
            all.resolve(site, size, format, &presets, exists).0
        };
        assert_eq!(r("pokerstars", Some(9), GameFormat::Cash), "stars-9-cash");
        assert_eq!(r("pokerstars", Some(6), GameFormat::Cash), "stars");
        assert_eq!(r("pokerstars", None, GameFormat::Mtt), "stars");
        assert_eq!(r("acr", Some(6), GameFormat::Cash), "acr-6");
        assert_eq!(
            r("acr", Some(6), GameFormat::Spin),
            "acr-spin",
            "format before size"
        );
        assert_eq!(r("acr", Some(9), GameFormat::Mtt), "any-mtt");
        assert_eq!(
            r("winamax", Some(6), GameFormat::Mtt),
            "any-mtt",
            "gone passed over"
        );
        assert_eq!(r("winamax", Some(6), GameFormat::Cash), "six");
        assert_eq!(r("winamax", None, GameFormat::Cash), "everywhere");
        let none = Assignments::default();
        for format in GameFormat::ALL {
            assert_eq!(
                none.resolve("acr", Some(6), format, &presets, exists),
                (presets.default_for(format).to_owned(), Source::Default)
            );
        }
    }

    /// Stack depths, in tenths of a big blind; unknown never shows.
    #[test]
    fn stack_ranges() {
        let short = StackWhen {
            below_bb: Some(20),
            at_least_bb: None,
        };
        let deep = StackWhen {
            below_bb: None,
            at_least_bb: Some(20),
        };
        assert!(short.holds(Some(199)) && !short.holds(Some(200)) && !short.holds(None));
        assert!(deep.holds(Some(200)) && !deep.holds(Some(199)) && !deep.holds(None));
        assert!(short.valid() && deep.valid());
        assert!(
            !StackWhen {
                below_bb: None,
                at_least_bb: None
            }
            .valid()
        );
        assert!(
            !StackWhen {
                below_bb: Some(10),
                at_least_bb: Some(10)
            }
            .valid()
        );
    }

    /// The stored form round-trips; another version is not read.
    #[test]
    fn designs_round_trip() {
        let design = Presets::shipped()
            .get("mtt-stack")
            .expect("preset")
            .design
            .clone();
        let json = design.to_json();
        assert!(json.contains(r#""when":{"atLeastBb":20}"#), "{json}");
        assert_eq!(HudDesign::parse(&json), Some(design.clone()));
        let newer = json.replacen(r#""version":1"#, r#""version":2"#, 1);
        assert_eq!(HudDesign::parse(&newer), None);
        assert_eq!(HudDesign::parse("{"), None);
        let presets = Presets::shipped();
        let id = new_id([0xab; 16]);
        assert_eq!(id.len(), 34);
        assert!(valid_user_id(&id, &presets));
        assert!(!valid_user_id("cash", &presets));
        assert!(!valid_user_id("D-1", &presets));
    }
}
