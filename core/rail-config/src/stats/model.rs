//! The shape of `config/stats/standard.json`, field for field with
//! `config/stats/stats.schema.json`. Unknown fields are refused.

use serde::{Deserialize, Serialize};

/// The whole file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatsFile {
    /// The editor hint `"./stats.schema.json"`; not interpreted.
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// [`super::STATS_FILE_VERSION`].
    pub version: u32,
    pub stats: Vec<StatDef>,
}

/// One displayed statistic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatDef {
    pub id: String,
    pub group: Group,
    pub players: Players,
    /// The short label a HUD panel prints.
    pub label: Text,
    pub name: Text,
    pub description: Text,
    /// The value: see [`super::formula`].
    pub formula: String,
    pub format: Format,
    pub sample: SampleDef,
    /// Colour thresholds, ascending; the last has no `below`.
    pub bands: Vec<Band>,
    pub hud: HudPlace,
}

/// A string in every language the app and the web speak (`LOCALES` of
/// `frontend/src/lib/i18n/types.ts` and of `app/src/i18n/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Text {
    pub en: String,
    pub hr: String,
}

impl Text {
    /// The string in `locale`, English for a locale the file does not have.
    pub fn get(&self, locale: &str) -> &str {
        match locale {
            "hr" => &self.hr,
            _ => &self.en,
        }
    }

    /// Every `(locale, string)`.
    pub fn entries(&self) -> [(&'static str, &str); 2] {
        [("en", &self.en), ("hr", &self.hr)]
    }
}

/// Where a statistic is listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    Preflop,
    Postflop,
    Showdown,
    Results,
}

/// Whose rows a statistic can be computed for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Players {
    /// Any player: the hero and villains alike.
    Any,
    /// The hero only (all-in EV is computed for the hero's hands only).
    Hero,
}

/// How the value is printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Format {
    pub unit: Unit,
    /// Digits after the point, 0-6 (`rail_stats::display::format_fixed`).
    /// For money, of the major unit.
    pub decimals: u32,
}

/// What the value is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    /// Percentage points (the UI adds `%`).
    Percent,
    /// Big blinds per 100 hands.
    #[serde(rename = "bb_per_100")]
    BbPer100,
    /// Big blinds.
    Bb,
    /// A plain ratio.
    Ratio,
    /// A whole number.
    Count,
    /// Minor units of the sample's one currency.
    Money,
}

/// The sample a value stands on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SampleDef {
    /// A formula for the sample size; absent when the value is
    /// `pct(made, opportunities)` (then it is `opportunities`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub of: Option<String>,
    /// Full opacity (reliability `ok`) from this sample upwards; at most
    /// [`MAX_SAMPLE_MIN`](super::MAX_SAMPLE_MIN). `rail_stats::reliability`
    /// has the rule below it.
    pub min: u64,
}

/// One colour band: values below `below` (and not below the previous
/// band's), or the rest when `below` is absent.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Band {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below: Option<f64>,
    pub tone: Tone,
}

/// A position on the colour scale; the app, the web and the HUD map it to
/// their theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tone {
    VeryLow,
    Low,
    Normal,
    High,
    VeryHigh,
}

impl Tone {
    /// The JSON name (`very-low`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VeryLow => "very-low",
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
            Self::VeryHigh => "very-high",
        }
    }
}

/// Default HUD membership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HudPlace {
    Panel,
    Popup,
    None,
}
