//! The shape of `config/sites.json`, field for field with
//! `config/sites.schema.json`. Unknown fields are refused; `null` is
//! "unknown", never a default.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The whole file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// The editor hint `"./sites.schema.json"`; not interpreted.
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// [`crate::VERSION`].
    pub version: u32,
    pub sites: Vec<Site>,
}

impl Config {
    /// The entry with this id.
    pub fn site(&self, id: &str) -> Option<&Site> {
        self.sites.iter().find(|site| site.id == id)
    }

    /// The entries read by this parser, in file order.
    pub fn sites_for_parser<'a>(&'a self, parser: &'a str) -> impl Iterator<Item = &'a Site> {
        self.sites
            .iter()
            .filter(move |site| site.parser.as_deref() == Some(parser))
    }
}

/// One client (room or skin), one network standing in for clients not yet
/// told apart, or Rail's own format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Site {
    pub id: String,
    pub name: String,
    pub kind: SiteKind,
    /// A `rail_core` parser id; `None` for a client no parser reads.
    pub parser: Option<String>,
    pub network: Option<String>,
    /// `Some(false)`: the client is closed. `None`: not established.
    pub operating: Option<bool>,
    pub skins: Vec<String>,
    pub paths: Paths,
    pub files: Files,
    pub tables: Tables,
    pub hud: Hud,
    pub anonymisation: Option<Anonymisation>,
    pub docs: Vec<String>,
    pub notes: String,
}

impl Site {
    /// Compliance mode (guideline §7, R3.10): the HUD may attach to this
    /// client's tables only when its policy is explicitly `true`, and only to
    /// a room - never to a network placeholder or a format. Unknown is no.
    pub fn hud_permitted(&self) -> bool {
        self.kind == SiteKind::Room && self.hud.allowed == Some(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SiteKind {
    /// A client a player installs: a room or a skin.
    Room,
    /// Several clients we cannot tell apart yet; R1.4 / R3.0 split it.
    Network,
    /// Not a client (Rail's standard text).
    Format,
}

/// Default hand-history folders per OS. Empty when unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Paths {
    pub windows: Vec<PathEntry>,
    pub macos: Vec<PathEntry>,
}

/// One folder. `%NAME%` is a Windows environment variable, `~` the home
/// folder, `*` one folder level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PathEntry {
    pub path: String,
    /// `true` only once seen on a real install (R1.4), with `checked_at`.
    pub verified: bool,
    pub source: String,
    /// `YYYY-MM-DD`.
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Files {
    pub glob: Option<String>,
    pub encoding: Encoding,
    /// Whether the client writes hands to disk while you play.
    pub live: Option<bool>,
    /// Whether `glob` and `live` were checked on a real install.
    pub verified: bool,
    pub source: String,
    pub notes: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Encoding {
    /// `rail_core::decode::decode_source` sniffs each file.
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "windows-1252")]
    Windows1252,
}

/// What the HUD needs to find a table window. `None` is unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Tables {
    pub process: Processes,
    /// Rust `regex` syntax with a named group `table`.
    pub title: Option<String>,
    /// Table size (`"2"`..`"10"`) to where the client draws the seats and
    /// its other table graphics (R3.6), measured on a real install; a size
    /// without one gets the HUD's default (the table simulator's geometry).
    pub seat_layouts: Option<BTreeMap<String, SeatLayout>>,
    /// Whether the client rotates the table so the hero always sits in one
    /// place ("preferred seat"; the layout's `hero_slot`). `None`: unknown,
    /// read as "does not rotate" unless the user says otherwise (R3.6).
    pub preferred_seat: Option<bool>,
    /// `true` only once the titles were seen on a real install (R3.3,
    /// `docs/research/CAPTURING-TABLES.md`), with `checked_at`.
    pub verified: bool,
    pub source: Option<String>,
    /// `YYYY-MM-DD`: when the titles were captured.
    pub checked_at: Option<String>,
}

impl Tables {
    /// Nothing known about the windows.
    pub fn is_unknown(&self) -> bool {
        self.process.windows.is_none()
            && self.process.macos.is_none()
            && self.title.is_none()
            && self.seat_layouts.is_none()
            && self.preferred_seat.is_none()
    }
}

/// One table size's geometry as a room's client draws it (R3.6), in
/// thousandths of the table window's **client area** (0 - 1000 on each
/// axis, so it holds at any window size and DPI). Measured on a real
/// install, like the titles (`docs/research/CAPTURING-TABLES.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeatLayout {
    /// The centre of each seat's plate, `[x, y]`, clockwise, in the order
    /// the client draws seat 1, 2, ... when it does not rotate the table.
    pub seats: Vec<[u32; 2]>,
    /// A seat plate's size, `[width, height]`, centred on its seat.
    pub plate: [u32; 2],
    /// The table's centre: a panel goes on the side of its seat away from
    /// it first.
    pub center: [u32; 2],
    /// Where a rotating client draws the hero: an index into `seats`
    /// (`0` when the hero sits at the first one, usually bottom centre).
    pub hero_slot: u32,
    /// The client's other table graphics a panel must not cover - the
    /// board and pot, the dealer tray, buttons - as `[x, y, width,
    /// height]`. ACR's policy (4.2.11, `noOverlapTableGraphics`) makes
    /// them binding there.
    pub graphics: Vec<[u32; 4]>,
    /// The hand history's seat number of each entry of `seats`, when the
    /// room does not number a table's seats `1..=size` (a 6-max table
    /// written with a 9-max table's numbers); `None`: `1..=size`.
    pub seat_numbers: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Processes {
    pub windows: Option<Vec<String>>,
    pub macos: Option<Vec<String>>,
}

/// A room's HUD policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Hud {
    /// `Some(true)` allowed (R3.0, sourced and dated), `Some(false)`
    /// prohibited, `None` unknown - which the HUD treats as prohibited.
    pub allowed: Option<bool>,
    pub source: Option<String>,
    pub checked_at: Option<String>,
    /// What the room's policy forbids a permitted HUD to show or do (R3.4),
    /// enforced by the HUD's renderer. Required when `allowed` is `true`
    /// ([`crate::validate`]); `None` elsewhere. A file without the field
    /// reads as `None` (and is then refused for an allowed room).
    #[serde(default)]
    pub restrictions: Option<HudRestrictions>,
    pub notes: String,
}

/// A permitted room's HUD restrictions (R3.4), from its own policy page
/// (`docs/research/HUD-POLICIES.md`). Every field is a restriction: `true`
/// (or a number) restricts, `false` (or `null`) does not. A remote file can
/// only add restrictions ([`HudRestrictions::stricter`],
/// [`crate::merge_remote`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HudRestrictions {
    /// Statistics only from hands the user played themselves (PokerStars,
    /// ACR). The data path's (R3.7): observed or imported hands of others
    /// must not be counted.
    pub own_hands_only: bool,
    /// Values are raw counts over opportunities, nothing adjusted by
    /// population tendencies (PokerStars).
    pub raw_counts_only: bool,
    /// At most this many fixed colour thresholds per statistic (PokerStars:
    /// 2, "two different thresholds"); `None`: the statistic's own bands.
    pub max_colour_thresholds: Option<u32>,
    /// No statistic split by card values (PokerStars): R2.10 statistics
    /// with card predicates are not shown.
    pub no_card_split_stats: bool,
    /// The display does not switch with game state - position, stacks -
    /// other than the game format (PokerStars).
    pub no_game_state_switching: bool,
    /// The display does not switch with the opponent's tendencies
    /// (PokerStars).
    pub no_tendency_switching: bool,
    /// No rating, labelling or categorising of players (PokerStars, ACR).
    pub no_player_labels: bool,
    /// No hand charts (PokerStars).
    pub no_hand_charts: bool,
    /// No graph of more than one data point (PokerStars).
    pub no_graphs: bool,
    /// Nothing from the hand in play (ACR).
    pub no_hand_in_play: bool,
    /// Panels must not overlap the client's own table graphics (ACR 4.2.11).
    pub no_overlap_table_graphics: bool,
}

impl HudRestrictions {
    /// Every restriction on, colour by at most two thresholds: what the
    /// HUD's default panel already complies with (R3.4).
    pub const STRICTEST: Self = Self {
        own_hands_only: true,
        raw_counts_only: true,
        max_colour_thresholds: Some(2),
        no_card_split_stats: true,
        no_game_state_switching: true,
        no_tendency_switching: true,
        no_player_labels: true,
        no_hand_charts: true,
        no_graphs: true,
        no_hand_in_play: true,
        no_overlap_table_graphics: true,
    };

    /// No restriction at all.
    pub const NONE: Self = Self {
        own_hands_only: false,
        raw_counts_only: false,
        max_colour_thresholds: None,
        no_card_split_stats: false,
        no_game_state_switching: false,
        no_tendency_switching: false,
        no_player_labels: false,
        no_hand_charts: false,
        no_graphs: false,
        no_hand_in_play: false,
        no_overlap_table_graphics: false,
    };

    /// Both sets at once: every restriction either has, the lower
    /// threshold count.
    #[must_use]
    pub fn stricter(&self, other: &Self) -> Self {
        Self {
            own_hands_only: self.own_hands_only || other.own_hands_only,
            raw_counts_only: self.raw_counts_only || other.raw_counts_only,
            max_colour_thresholds: match (self.max_colour_thresholds, other.max_colour_thresholds) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            },
            no_card_split_stats: self.no_card_split_stats || other.no_card_split_stats,
            no_game_state_switching: self.no_game_state_switching || other.no_game_state_switching,
            no_tendency_switching: self.no_tendency_switching || other.no_tendency_switching,
            no_player_labels: self.no_player_labels || other.no_player_labels,
            no_hand_charts: self.no_hand_charts || other.no_hand_charts,
            no_graphs: self.no_graphs || other.no_graphs,
            no_hand_in_play: self.no_hand_in_play || other.no_hand_in_play,
            no_overlap_table_graphics: self.no_overlap_table_graphics
                || other.no_overlap_table_graphics,
        }
    }

    /// Whether `self` restricts at least everything `other` does.
    pub fn at_least_as_strict_as(&self, other: &Self) -> bool {
        self.stricter(other) == *self
    }
}

/// What player names in the files are (docs/DATABASE.md, "Player identity
/// and anonymized rooms").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anonymisation {
    None,
    Positional,
    OpaqueId,
}
