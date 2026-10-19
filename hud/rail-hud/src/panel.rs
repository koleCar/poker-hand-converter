//! What a seat's panel says (R3.4; the legend and the player's tag R3.8,
//! the editor R3.9), and the rooms' restrictions on it (R3.0, `sites.json`
//! `hud.restrictions`).
//!
//! - **Statistics**: the shipped definitions whose `hud` is `panel`
//!   (`config/stats/standard.json`, R2.4: VPIP, PFR, 3B, F3B, CB, AFq), each
//!   evaluated over the player's summed rollups (`Totals::sums`) - its value
//!   as a whole number, its R2.4 colour band ([`Tone`]) and R2.5's
//!   reliability opacity (0.6 with no sample up to 1 at `sample.min`) - and
//!   the hand count. (R3.8) Where the room allows labelling players, the
//!   user's colour tag, labels and a note mark (R2.7c's words, read by the
//!   engine). Never a name, nothing about the hand in play (the rollups
//!   count finished hands the room wrote to disk).
//! - **The legend** (R3.8): the colour bands the panel's statistics use
//!   ([`PanelStats::legend_tones`]), collapsed to what the room allows
//!   ([`collapse_tone`]: on PokerStars low, normal and high) - drawn as a
//!   small key on the table (`crate::scene`); the popup lists each
//!   statistic's thresholds in words.
//! - **The default design** ([`PanelDesign::default`]) is made to comply with
//!   every permitted room at once (the stricter of PokerStars' and ACR's
//!   rules, [`rail_config::model::HudRestrictions::STRICTEST`]): one fixed
//!   list of statistics for every seat and situation, colour by at most two
//!   fixed thresholds, no charts or graphs, panels clear of the table's
//!   graphics. The one thing it asks for that a room may refuse is the
//!   player's words (R3.8): enforcement drops them on PokerStars and ACR
//!   (`noPlayerLabels`), so they show on Winamax only today.
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
use rail_stats::custom::{CustomSet, custom_sums};
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
    /// Show the player's colour tag, labels and note mark (R3.8) when the
    /// room allows labelling players.
    pub player_labels: bool,
    /// (R3.8) Show the colour legend on the table.
    pub legend: bool,
}

/// At most this many statistics on a panel (guideline §7: four to six).
pub const MAX_PANEL_STATS: usize = 6;

impl Default for PanelDesign {
    /// The shipped panel statistics, fixed; two thresholds; clear of the
    /// table's graphics; the legend; the player's words where the room
    /// allows them (R3.8).
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
            player_labels: true,
            legend: true,
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
            legend: self.legend,
        }
    }

    /// Whether a cell of this statistic may be shown.
    pub fn shows(&self, id: &str) -> bool {
        self.stats.iter().any(|slot| slot.id == id)
    }
}

/// A band's tone with the thresholds beyond `max` merged away
/// ([`Tone::collapse`], shared with the app's popup): two thresholds give
/// low, normal and high, one gives low and normal, none gives normal.
pub fn collapse_tone(tone: Tone, max: Option<u32>) -> Tone {
    tone.collapse(max)
}

/// (R3.8) The legend's tones: `tones` (the bands a panel's statistics use)
/// collapsed to at most `max` thresholds, each once, in the scale's order.
pub fn legend_tones(tones: &[Tone], max: Option<u32>) -> Vec<Tone> {
    const SCALE: [Tone; 5] = [
        Tone::VeryLow,
        Tone::Low,
        Tone::Normal,
        Tone::High,
        Tone::VeryHigh,
    ];
    SCALE
        .into_iter()
        .filter(|tone| tones.iter().any(|t| collapse_tone(*t, max) == *tone))
        .collect()
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

/// One statistic of a panel, compiled.
#[derive(Debug, Clone)]
struct PanelStat {
    display: DisplayStat,
    /// (R3.7) A user's statistic (R2.10): the custom counter names its
    /// formulas read ([`rail_stats::custom::CustomStat::names`]), filled per
    /// player from their `custom_player_rollups`. `None`: a shipped one.
    custom: Option<Vec<String>>,
}

/// The compiled panel statistics, evaluated per player.
#[derive(Debug, Clone)]
pub struct PanelStats {
    stats: Vec<PanelStat>,
}

impl PanelStats {
    /// The design's statistics from the shipped definitions (an id the
    /// definitions do not have is left out).
    pub fn new(design: &PanelDesign) -> Self {
        Self::with_custom(design, &CustomSet::default())
    }

    /// (R3.7) The design's statistics: a shipped definition by its id, else
    /// the user's own statistic of that id (R2.10, from the store), else
    /// left out. A shipped id wins (the editor never lets a user's take one).
    pub fn with_custom(design: &PanelDesign, custom: &CustomSet) -> Self {
        let shipped = Display::shipped().ok();
        let stats = design
            .stats
            .iter()
            .filter_map(|slot| {
                if let Some(stat) = shipped.as_ref().and_then(|d| d.get(&slot.id)) {
                    return Some(PanelStat {
                        display: stat.clone(),
                        custom: None,
                    });
                }
                let stat = custom.get(&slot.id)?;
                Some(PanelStat {
                    display: stat.display.clone(),
                    custom: Some(stat.names.clone()),
                })
            })
            .collect();
        Self { stats }
    }

    /// Whether a statistic reads the user's own counters: the HUD then
    /// reads each player's `custom_player_rollups` too.
    pub fn reads_custom(&self) -> bool {
        self.stats
            .iter()
            .any(|stat| stat.custom.as_ref().is_some_and(|names| !names.is_empty()))
    }

    /// (R3.8) Every tone the statistics' bands use, in the scale's order:
    /// what the legend can show before a room collapses it.
    pub fn legend_tones(&self) -> Vec<Tone> {
        let used: Vec<Tone> = self
            .stats
            .iter()
            .flat_map(|stat| stat.display.def.bands.iter().map(|band| band.tone))
            .collect();
        legend_tones(&used, None)
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
        self.cells_with(sums, |_| None)
    }

    /// The cells of one player's summed rollups and their counts of the
    /// user's statistics: `counts(id)` is the `(made, opportunities)` of
    /// the user's statistic `id` for this player (`None`: none counted).
    /// Read through the definitions: a user's statistic's formula over
    /// [`custom_sums`], a shipped one's over the rollups.
    pub fn cells_with(
        &self,
        sums: &Sums,
        counts: impl Fn(&str) -> Option<(i64, i64)>,
    ) -> Vec<StatCell> {
        self.stats
            .iter()
            .map(|panel_stat| {
                let stat = &panel_stat.display;
                let shown = match &panel_stat.custom {
                    Some(names) => stat.show(&custom_sums(names, sums, &counts), None),
                    None => stat.show(sums, None),
                };
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
    use rail_config::stats::Expr;
    use rail_stats::counters::Counter;

    /// Rollups in which the shipped rate `id` (a `pct(made, opportunities)`
    /// definition) was made `made` times in `opportunities`: its inputs are
    /// read from the definition (guideline §14), not named here.
    fn rate_sums(id: &str, made: i64, opportunities: i64) -> Sums {
        let display = Display::shipped().expect("shipped");
        let def = &display.get(id).expect("a shipped statistic").def;
        let formula = rail_config::stats::parse_formula(&def.formula).expect("formula");
        let Expr::Pct(top, bottom) = formula else {
            panic!("{id} is not a rate");
        };
        let mut sums = Sums::default();
        for (input, value) in [(*top, made), (*bottom, opportunities)] {
            let Expr::Name(name) = input else {
                panic!("{id}: an input is not one counter");
            };
            let counter = Counter::from_name(&name).unwrap_or_else(|| panic!("{name}"));
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
        assert!(design.player_labels && design.legend);
        assert!(
            design
                .stats
                .iter()
                .all(|s| !s.card_split && s.switching == Switching::Fixed)
        );
    }

    /// The default design already complies with the strictest rules but
    /// for the player's words (R3.8), which it shows only where a room
    /// allows labelling players: under the stricter of PokerStars' and
    /// ACR's rules, or either's alone, they go and nothing else changes;
    /// on Winamax nothing changes.
    #[test]
    fn the_default_design_complies_with_every_room() {
        let design = PanelDesign::default();
        let without_words = PanelDesign {
            player_labels: false,
            ..design.clone()
        };
        assert_eq!(design.enforce(&HudRestrictions::STRICTEST), without_words);
        let config =
            rail_config::load_shipped(&rail_core::parsers::REGISTRATION_ORDER).expect("shipped");
        let mut labels = Vec::new();
        for site in config.sites.iter().filter(|s| s.hud_permitted()) {
            let rules = site
                .hud
                .restrictions
                .expect("a permitted room's restrictions");
            let enforced = design.enforce(&rules);
            let expected = if rules.no_player_labels {
                &without_words
            } else {
                labels.push(site.id.as_str());
                &design
            };
            assert_eq!(&enforced, expected, "{}", site.id);
        }
        assert_eq!(labels, ["winamax"], "label suppression per room");
    }

    /// (R3.8) The legend shows the thresholds actually in use: the panel's
    /// statistics use all five tones; PokerStars' two thresholds leave low,
    /// normal and high; ACR and Winamax (no colour restriction) keep the
    /// default design's two as well, an unrestricted design all five.
    #[test]
    fn the_legend_follows_the_rooms_thresholds() {
        let all = [
            Tone::VeryLow,
            Tone::Low,
            Tone::Normal,
            Tone::High,
            Tone::VeryHigh,
        ];
        let stats = PanelStats::new(&PanelDesign::default());
        assert_eq!(stats.legend_tones(), all);
        let config =
            rail_config::load_shipped(&rail_core::parsers::REGISTRATION_ORDER).expect("shipped");
        let three = [Tone::Low, Tone::Normal, Tone::High];
        for site in config.sites.iter().filter(|s| s.hud_permitted()) {
            let rules = site.hud.restrictions.expect("restrictions");
            let design = PanelDesign::default().enforce(&rules);
            assert_eq!(
                legend_tones(&stats.legend_tones(), design.max_colour_thresholds),
                three,
                "{}",
                site.id
            );
            let open = PanelDesign {
                max_colour_thresholds: None,
                ..PanelDesign::default()
            }
            .enforce(&rules);
            let expected: &[Tone] = if rules.max_colour_thresholds.is_some() {
                &three
            } else {
                &all
            };
            assert_eq!(
                legend_tones(&stats.legend_tones(), open.max_colour_thresholds),
                expected,
                "{}",
                site.id
            );
        }
        assert_eq!(legend_tones(&all, Some(1)), [Tone::Low, Tone::Normal]);
        assert_eq!(legend_tones(&all, Some(0)), [Tone::Normal]);
        assert!(legend_tones(&[], Some(2)).is_empty());
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
            legend: true,
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
        let cells = stats.cells(&rate_sums("vpip", 45, 150));
        let vpip = &cells[0];
        assert_eq!((vpip.id.as_str(), vpip.text.as_str()), ("vpip", "30"));
        assert_eq!(vpip.tone, Some(Tone::High));
        assert_eq!(vpip.opacity_permille, 1000);
        // 1 of 4: 25 %, a quarter of the sample: 0.6 + 0.4 * sqrt(0.04) =
        // 0.68.
        let cells = stats.cells(&rate_sums("vpip", 1, 4));
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
