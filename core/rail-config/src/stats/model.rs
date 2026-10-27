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
/// `web/src/lib/i18n/types.ts` and of `app/src/i18n/types.ts`).
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

impl Tone {
    /// (R3.8) This tone with the thresholds beyond `max` merged away - a
    /// room that allows colour by at most `max` fixed thresholds
    /// (`hud.restrictions.maxColourThresholds`: PokerStars 2). The five
    /// tones have four thresholds between them (very low | low | normal |
    /// high | very high); they are kept in the order low|normal,
    /// normal|high, very low|low, high|very high, so two thresholds give
    /// low, normal and high, one gives low and normal, none gives normal.
    /// `None`: every tone.
    #[must_use]
    pub fn collapse(self, max: Option<u32>) -> Self {
        let Some(max) = max else {
            return self;
        };
        let keep_low = max >= 1;
        let keep_high = max >= 2;
        let keep_very_low = max >= 3;
        let keep_very_high = max >= 4;
        match self {
            Self::VeryLow if keep_very_low => Self::VeryLow,
            Self::VeryLow | Self::Low if keep_low => Self::Low,
            Self::VeryHigh if keep_very_high => Self::VeryHigh,
            Self::VeryHigh | Self::High if keep_high => Self::High,
            _ => Self::Normal,
        }
    }
}

/// (R3.8) A definition's bands as a room with at most `max` colour
/// thresholds shows them: every tone collapsed ([`Tone::collapse`]) and
/// neighbouring bands of one tone merged into one (it ends where the last of
/// them ended). What a legend lists: the thresholds actually in use.
pub fn collapse_bands(bands: &[Band], max: Option<u32>) -> Vec<Band> {
    let mut out: Vec<Band> = Vec::with_capacity(bands.len());
    for band in bands {
        let tone = band.tone.collapse(max);
        match out.last_mut() {
            Some(last) if last.tone == tone => last.below = band.below,
            _ => out.push(Band {
                below: band.below,
                tone,
            }),
        }
    }
    out
}

/// Default HUD membership.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HudPlace {
    Panel,
    Popup,
    None,
}
