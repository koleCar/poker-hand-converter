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
    /// Table size (`"2"`..`"10"`) to layout id.
    pub seat_layouts: Option<BTreeMap<String, String>>,
    pub preferred_seat: Option<bool>,
    pub verified: bool,
    pub source: Option<String>,
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
    pub notes: String,
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
