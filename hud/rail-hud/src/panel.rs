//! What a seat's panel says (R3.4; the popup and the legend are R3.8, the
//! editor R3.9), and the rooms' restrictions on it (R3.0, `sites.json`
//! `hud.restrictions`).
//!
//! - **Statistics**: the shipped definitions whose `hud` is `panel`
//!   (`config/stats/standard.json`, R2.4: VPIP, PFR, 3B, F3B, CB, AFq), each
//!   evaluated over the player's summed rollups (`Totals::sums`) - its value
//!   as a whole number, its R2.4 colour band ([`Tone`]) and R2.5's
//!   reliability opacity (0.6 with no sample up to 1 at `sample.min`) - and
//!   the hand count. Nothing else: no name, no label, nothing about the hand
//!   in play (the rollups count finished hands the room wrote to disk).
//! - **The default design** ([`PanelDesign::default`]) is made to comply with
//!   every permitted room at once (the stricter of PokerStars' and ACR's
//!   rules, [`rail_config::model::HudRestrictions::STRICTEST`]): one fixed
//!   list of statistics for every seat and situation, colour by at most two
//!   fixed thresholds, no labels, no charts or graphs, panels clear of the
//!   table's graphics.
//! - **Enforcement** ([`PanelDesign::enforce`]): whatever the design, the
//!   room's restrictions are applied before drawing - statistics split by
//!   card values or switching with game state or tendencies are dropped,
//!   colour bands are collapsed to the allowed number of thresholds
//!   ([`collapse_tone`]), labels are dropped, and panels that would cover
//!   table graphics are dropped ([`crate::layout::place_panels`]). R3.9's
//!   editor builds designs; this is where a room's rules bind them.

#![forbid(unsafe_code)]

use rail_config::model::HudRestrictions;
use rail_config::stats::{HudPlace, Tone};
use rail_core::js::JsNumber;
use rail_stats::display::{Display, DisplayStat, Sums, format_fixed};

/// How a statistic's display may vary at the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Switching {
    /// The same statistic in every situation.
    Fixed,
    /// Switches with position, stacks or other game state (R3.9 could
    /// offer it; PokerStars forbids it).
    ByGameState,
    /// Switches with the opponent's tendencies (PokerStars forbids it).
    ByTendencies,
}

/// One statistic a design shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatSlot {
    /// The definition's id (`vpip`).
    pub id: String,
    /// Split by card values (an R2.10 statistic with a card predicate).
    pub card_split: bool,
    pub switching: Switching,
}

impl StatSlot {
    pub fn fixed(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            card_split: false,
            switching: Switching::Fixed,
        }
    }
}

/// A panel design: what each seat's panel shows and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelDesign {
    pub stats: Vec<StatSlot>,
    /// Colour by at most this many fixed thresholds (`None`: every band
    /// of the definition).
    pub max_colour_thresholds: Option<u32>,
    /// Never place a panel over the table's own graphics.
    pub avoid_table_graphics: bool,
    /// Show a player's label (R3.8 notes / tags) when the panel has one.
    pub player_labels: bool,
}

/// At most this many statistics on a panel (guideline §7: four to six).
pub const MAX_PANEL_STATS: usize = 6;

impl Default for PanelDesign {
    /// The shipped panel statistics, fixed; two thresholds; clear of the
    /// table's graphics; no labels.
    fn default() -> Self {
        let stats = Display::shipped()
            .map(|display| {
                display
                    .stats
                    .iter()
                    .filter(|stat| stat.def.hud == HudPlace::Panel)
                    .take(MAX_PANEL_STATS)
                    .map(|stat| StatSlot::fixed(stat.id()))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            stats,
            max_colour_thresholds: Some(2),
            avoid_table_graphics: true,
            player_labels: false,
        }
    }
}

impl PanelDesign {
    /// The design as a room with `rules` may show it.
    #[must_use]
    pub fn enforce(&self, rules: &HudRestrictions) -> Self {
        let stats = self
            .stats
            .iter()
            .filter(|slot| !(rules.no_card_split_stats && slot.card_split))
            .filter(|slot| match slot.switching {
                Switching::Fixed => true,
                Switching::ByGameState => !rules.no_game_state_switching,
                Switching::ByTendencies => !rules.no_tendency_switching,
            })
            .cloned()
            .collect();
        let max_colour_thresholds = match (self.max_colour_thresholds, rules.max_colour_thresholds)
        {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        Self {
            stats,
            max_colour_thresholds,
            avoid_table_graphics: self.avoid_table_graphics || rules.no_overlap_table_graphics,
            player_labels: self.player_labels && !rules.no_player_labels,
        }
    }

    /// Whether a cell of this statistic may be shown.
    pub fn shows(&self, id: &str) -> bool {
        self.stats.iter().any(|slot| slot.id == id)
    }
}

/// A band's tone with the thresholds beyond `max` merged away. The five
/// tones have four thresholds between them (very low | low | normal | high
/// | very high); they are kept in the order low|normal, normal|high,
/// very low|low, high|very high, so two thresholds give low, normal and
/// high, one gives low and normal, none gives normal.
pub fn collapse_tone(tone: Tone, max: Option<u32>) -> Tone {
    let Some(max) = max else {
        return tone;
    };
    let keep_low = max >= 1;
    let keep_high = max >= 2;
    let keep_very_low = max >= 3;
    let keep_very_high = max >= 4;
    match tone {
        Tone::VeryLow if keep_very_low => Tone::VeryLow,
        Tone::VeryLow | Tone::Low if keep_low => Tone::Low,
        Tone::VeryHigh if keep_very_high => Tone::VeryHigh,
        Tone::VeryHigh | Tone::High if keep_high => Tone::High,
        _ => Tone::Normal,
    }
}

/// One statistic as a panel shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatCell {
    /// The definition's id.
    pub id: String,
    /// The value as a whole number (`-` without one: no opportunity yet).
    pub text: String,
    /// R2.4's band, before any restriction ([`collapse_tone`] at drawing).
    pub tone: Option<Tone>,
    /// R2.5's reliability opacity, thousandths (600 - 1000).
    pub opacity_permille: u32,
}

/// The compiled panel statistics, evaluated per player.
#[derive(Debug, Clone)]
pub struct PanelStats {
    stats: Vec<DisplayStat>,
}

impl PanelStats {
    /// The design's statistics from the shipped definitions (an id the
    /// definitions do not have is left out).
    pub fn new(design: &PanelDesign) -> Self {
        let stats = Display::shipped()
            .map(|display| {
                design
                    .stats
                    .iter()
                    .filter_map(|slot| display.get(&slot.id).cloned())
                    .collect()
            })
            .unwrap_or_default();
        Self { stats }
    }

    /// How many statistics a panel shows.
    pub fn len(&self) -> usize {
        self.stats.len()
    }

    pub fn is_empty(&self) -> bool {
        self.stats.is_empty()
    }

    /// The cells of one player's summed rollups.
    pub fn cells(&self, sums: &Sums) -> Vec<StatCell> {
        self.stats
            .iter()
            .map(|stat| {
                let shown = stat.show(sums, None);
                StatCell {
                    id: stat.id().to_owned(),
                    text: shown
                        .value
                        .map_or_else(|| "-".to_owned(), |value| format_fixed(value, 0)),
                    tone: shown.tone,
                    opacity_permille: permille(shown.reliability.opacity),
                }
            })
            .collect()
    }
}

/// An opacity (0 - 1) in thousandths.
fn permille(opacity: JsNumber) -> u32 {
    (opacity * JsNumber::from_u64(1000))
        .round()
        .to_i64()
        .and_then(|v| u32::try_from(v.clamp(0, 1000)).ok())
        .unwrap_or(1000)
}

/// A hand count in at most five characters: `987`, `12345`, `123k`, `4.5M`.
pub fn hands_text(hands: i64) -> String {
    let hands = hands.max(0);
    if hands < 100_000 {
        hands.to_string()
    } else if hands < 1_000_000 {
        format!("{}k", hands / 1000)
    } else {
        format!("{}.{}M", hands / 1_000_000, hands % 1_000_000 / 100_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_stats::counters::Counter;

    fn sums(pairs: &[(&str, i64)]) -> Sums {
        let mut sums = Sums::default();
        for &(name, value) in pairs {
            let counter = Counter::from_name(name).unwrap_or_else(|| panic!("{name}"));
            sums.counters[counter.index()] = value;
        }
        sums
    }

    /// R2.4's `hud: panel` statistics, in the file's order: four to six.
    #[test]
    fn the_default_design_is_the_shipped_panel() {
        let design = PanelDesign::default();
        let ids: Vec<&str> = design.stats.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "vpip",
                "pfr",
                "three_bet",
                "fold_to_three_bet",
                "cbet_flop",
                "aggression_frequency"
            ]
        );
        assert!((4..=MAX_PANEL_STATS).contains(&ids.len()));
        assert_eq!(design.max_colour_thresholds, Some(2));
        assert!(design.avoid_table_graphics);
        assert!(!design.player_labels);
        assert!(
            design
                .stats
                .iter()
                .all(|s| !s.card_split && s.switching == Switching::Fixed)
        );
    }

    /// The default design already complies with the strictest rules: the
    /// stricter of PokerStars' and ACR's changes nothing.
    #[test]
    fn the_default_design_complies_with_every_room() {
        let design = PanelDesign::default();
        assert_eq!(design.enforce(&HudRestrictions::STRICTEST), design);
        let config =
            rail_config::load_shipped(&rail_core::parsers::REGISTRATION_ORDER).expect("shipped");
        for site in config.sites.iter().filter(|s| s.hud_permitted()) {
            let rules = site
                .hud
                .restrictions
                .expect("a permitted room's restrictions");
            assert_eq!(design.enforce(&rules), design, "{}", site.id);
        }
    }

    /// A design beyond the rules (R3.9 could build one) is cut down to them.
    #[test]
    fn restrictions_cut_a_design_down() {
        let design = PanelDesign {
            stats: vec![
                StatSlot::fixed("vpip"),
                StatSlot {
                    card_split: true,
                    ..StatSlot::fixed("vpip_with_pairs")
                },
                StatSlot {
                    switching: Switching::ByGameState,
                    ..StatSlot::fixed("pfr_by_position")
                },
                StatSlot {
                    switching: Switching::ByTendencies,
                    ..StatSlot::fixed("adaptive")
                },
            ],
            max_colour_thresholds: None,
            avoid_table_graphics: false,
            player_labels: true,
        };
        let ids = |d: &PanelDesign| d.stats.iter().map(|s| s.id.clone()).collect::<Vec<_>>();

        assert_eq!(design.enforce(&HudRestrictions::NONE), design);

        let stars = design.enforce(&HudRestrictions {
            max_colour_thresholds: Some(2),
            no_card_split_stats: true,
            no_game_state_switching: true,
            no_tendency_switching: true,
            no_player_labels: true,
            ..HudRestrictions::NONE
        });
        assert_eq!(ids(&stars), ["vpip"]);
        assert_eq!(stars.max_colour_thresholds, Some(2));
        assert!(!stars.player_labels);
        assert!(!stars.avoid_table_graphics);
        assert!(stars.shows("vpip") && !stars.shows("adaptive"));

        let acr = design.enforce(&HudRestrictions {
            no_overlap_table_graphics: true,
            no_player_labels: true,
            ..HudRestrictions::NONE
        });
        assert_eq!(ids(&acr).len(), 4, "ACR allows every statistic");
        assert!(acr.avoid_table_graphics);
        assert!(!acr.player_labels);
        assert_eq!(acr.max_colour_thresholds, None);

        // A design stricter than the room stays as strict.
        let one = PanelDesign {
            max_colour_thresholds: Some(1),
            ..design.clone()
        };
        assert_eq!(
            one.enforce(&HudRestrictions {
                max_colour_thresholds: Some(2),
                ..HudRestrictions::NONE
            })
            .max_colour_thresholds,
            Some(1)
        );
    }

    /// At most `max` thresholds survive, on every band list of the shipped
    /// definitions.
    #[test]
    fn tones_collapse_to_the_allowed_thresholds() {
        let all = [
            Tone::VeryLow,
            Tone::Low,
            Tone::Normal,
            Tone::High,
            Tone::VeryHigh,
        ];
        let collapsed = |max: Option<u32>| all.map(|tone| collapse_tone(tone, max)).to_vec();
        assert_eq!(collapsed(None), all);
        assert_eq!(collapsed(Some(4)), all);
        assert_eq!(
            collapsed(Some(2)),
            [Tone::Low, Tone::Low, Tone::Normal, Tone::High, Tone::High]
        );
        assert_eq!(
            collapsed(Some(1)),
            [
                Tone::Low,
                Tone::Low,
                Tone::Normal,
                Tone::Normal,
                Tone::Normal
            ]
        );
        assert_eq!(collapsed(Some(0)), [Tone::Normal; 5]);
        let display = Display::shipped().expect("shipped");
        for stat in &display.stats {
            for max in 0..=4 {
                let tones: Vec<Tone> = stat
                    .def
                    .bands
                    .iter()
                    .map(|band| collapse_tone(band.tone, Some(max)))
                    .collect();
                let thresholds = tones.windows(2).filter(|w| w[0] != w[1]).count();
                assert!(
                    thresholds <= usize::try_from(max).expect("small"),
                    "{}: {thresholds} thresholds with at most {max}",
                    stat.id()
                );
            }
        }
    }

    /// Values, bands and dimming from the summed counters.
    #[test]
    fn cells_from_rollups() {
        let stats = PanelStats::new(&PanelDesign::default());
        assert_eq!(stats.len(), 6);
        let none = stats.cells(&Sums::default());
        assert!(none.iter().all(|c| c.text == "-" && c.tone.is_none()));
        assert!(none.iter().all(|c| c.opacity_permille == 600), "{none:?}");
        // 45 of 150 hands voluntarily: 30 % (the "high" band from 30), a
        // full sample (min 100).
        let cells = stats.cells(&sums(&[("vpip", 45), ("vpip_opp", 150)]));
        let vpip = &cells[0];
        assert_eq!((vpip.id.as_str(), vpip.text.as_str()), ("vpip", "30"));
        assert_eq!(vpip.tone, Some(Tone::High));
        assert_eq!(vpip.opacity_permille, 1000);
        // 1 of 4: 25 %, a quarter of the sample: 0.6 + 0.4 * sqrt(0.04) =
        // 0.68.
        let cells = stats.cells(&sums(&[("vpip", 1), ("vpip_opp", 4)]));
        assert_eq!(cells[0].text, "25");
        assert_eq!(cells[0].opacity_permille, 680);
    }

    #[test]
    fn hand_counts_fit_five_characters() {
        for (hands, text) in [
            (0, "0"),
            (-3, "0"),
            (987, "987"),
            (99_999, "99999"),
            (123_456, "123k"),
            (4_567_890, "4.5M"),
        ] {
            assert_eq!(hands_text(hands), text);
            assert!(text.len() <= 5);
        }
    }
}
