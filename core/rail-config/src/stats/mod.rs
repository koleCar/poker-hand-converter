//! `config/stats/`: the statistics Rail displays, as data (docs/RAIL-PLAN.md
//! R2.4, amendment A11; docs/STATS-SPEC.md §13).
//!
//! Two layers. The ~90 counters of `stats/2` stay code (`rail_stats`, ported
//! and golden-tested; each encodes a documented judgement call). What is
//! *displayed* - VPIP, 3-bet, bb/100 - is a definition here: a formula over
//! those counters ([`formula`]), a format, colour bands, the sample behind
//! the value, labels in every language, and default HUD membership.
//!
//! This module parses and validates; it does not know the counters. The
//! caller passes the [`Vocabulary`] - `rail_stats::display::vocabulary()` -
//! so this crate stays free of the core (as `sites.json` takes the parser
//! ids). Evaluation is `rail_stats::display`, in JavaScript's arithmetic, so
//! the web's `frontend/src/lib/stats/display.ts` prints the same digits.
//!
//! - [`SHIPPED_STATS`]: `config/stats/standard.json`, the starting set.
//! - [`load_stats`]: parse, check the version, validate every definition
//!   against the vocabulary, parse every formula.

pub mod formula;
pub mod model;

use std::collections::HashSet;
use std::fmt;

pub use formula::{Expr, Op, ParseError, parse as parse_formula};
pub use model::{
    Band, Format, Group, HudPlace, Players, SampleDef, StatDef, StatsFile, Text, Tone, Unit,
};

/// The `version` of a stats file this build reads.
pub const STATS_FILE_VERSION: u32 = 1;

/// The definitions shipped with this build: `config/stats/standard.json`.
pub const SHIPPED_STATS: &str = include_str!("../../../../config/stats/standard.json");

/// The names a formula may use, from the caller.
#[derive(Debug, Clone, Copy)]
pub struct Vocabulary<'a> {
    /// Every name a formula may read.
    pub names: &'a [&'a str],
    /// The subset that exists for the hero's rows only: a definition reading
    /// one must say `"players": "hero"`.
    pub hero_only: &'a [&'a str],
}

/// One thing wrong with a stats file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatProblem {
    /// The definition's id, when the problem is in one.
    pub stat: Option<String>,
    pub message: String,
}

impl fmt::Display for StatProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.stat {
            Some(stat) => write!(f, "{stat}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

/// Why a stats file was not loaded.
#[derive(Debug)]
pub enum StatsError {
    /// Not JSON, or not this shape (an unknown field, a wrong type).
    Json(serde_json::Error),
    /// A `version` this build does not read.
    Version { found: u32, expected: u32 },
    /// Read, but wrong: every problem found.
    Invalid(Vec<StatProblem>),
}

impl fmt::Display for StatsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "the stats file is not readable: {error}"),
            Self::Version { found, expected } => {
                write!(f, "stats file version {found}, expected {expected}")
            }
            Self::Invalid(problems) => {
                f.write_str("the stats file is invalid:")?;
                for problem in problems {
                    write!(f, "\n- {problem}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for StatsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Version { .. } | Self::Invalid(_) => None,
        }
    }
}

/// A validated definition with its formulas parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct Stat {
    pub def: StatDef,
    /// The value.
    pub formula: Expr,
    /// The sample size: `sample.of`, or the opportunities of a `pct` formula.
    pub sample: Expr,
}

impl Stat {
    /// `(made, opportunities)` when the value is `pct(made, opportunities)`:
    /// what a confidence interval for a rate is computed from (R2.5).
    pub fn rate(&self) -> Option<(&Expr, &Expr)> {
        match &self.formula {
            Expr::Pct(made, opp) => Some((made, opp)),
            _ => None,
        }
    }
}

/// A loaded stats file: every definition valid, in file order.
#[derive(Debug, Clone, PartialEq)]
pub struct Definitions {
    pub stats: Vec<Stat>,
}

impl Definitions {
    /// The definition with this id.
    pub fn get(&self, id: &str) -> Option<&Stat> {
        self.stats.iter().find(|stat| stat.def.id == id)
    }
}

/// Parse `text` and check its version; no other validation.
pub fn parse_stats(text: &str) -> Result<StatsFile, StatsError> {
    let file: StatsFile = serde_json::from_str(text).map_err(StatsError::Json)?;
    if file.version != STATS_FILE_VERSION {
        return Err(StatsError::Version {
            found: file.version,
            expected: STATS_FILE_VERSION,
        });
    }
    Ok(file)
}

/// Parse, validate and compile the formulas of a stats file.
pub fn load_stats(text: &str, vocabulary: Vocabulary<'_>) -> Result<Definitions, StatsError> {
    let file = parse_stats(text)?;
    let mut problems = Vec::new();
    let mut stats = Vec::new();
    if file.stats.is_empty() {
        problems.push(StatProblem {
            stat: None,
            message: "no statistics".to_owned(),
        });
    }
    let mut seen = HashSet::new();
    for def in file.stats {
        let mut report = |message: String| {
            problems.push(StatProblem {
                stat: Some(def.id.clone()),
                message,
            });
        };
        if !seen.insert(def.id.clone()) {
            report("duplicate id".to_owned());
        }
        if let Some(stat) = check_stat(&def, vocabulary, &mut report) {
            stats.push(Stat {
                def,
                formula: stat.0,
                sample: stat.1,
            });
        }
    }
    if problems.is_empty() {
        Ok(Definitions { stats })
    } else {
        Err(StatsError::Invalid(problems))
    }
}

/// [`SHIPPED_STATS`], loaded.
pub fn load_shipped_stats(vocabulary: Vocabulary<'_>) -> Result<Definitions, StatsError> {
    load_stats(SHIPPED_STATS, vocabulary)
}

fn is_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && id.len() <= 64
}

/// The checks of one definition; its parsed formula and sample when they
/// parse.
fn check_stat(
    def: &StatDef,
    vocabulary: Vocabulary<'_>,
    report: &mut impl FnMut(String),
) -> Option<(Expr, Expr)> {
    if !is_id(&def.id) {
        report(format!("id {:?} is not [a-z][a-z0-9_]*", def.id));
    }
    for (field, text) in [
        ("label", &def.label),
        ("name", &def.name),
        ("description", &def.description),
    ] {
        for (locale, value) in text.entries() {
            if value.trim().is_empty() {
                report(format!("{field}.{locale} is empty"));
            } else if value.trim() != value {
                report(format!("{field}.{locale} has spaces at an end"));
            }
        }
    }
    if def.format.decimals > 6 {
        report(format!("{} decimals; at most 6", def.format.decimals));
    }
    if def.format.unit == Unit::Count && def.format.decimals != 0 {
        report("a count has no decimals".to_owned());
    }
    check_bands(&def.bands, report);

    let check_formula = |what: &str, text: &str, report: &mut dyn FnMut(String)| {
        match formula::parse(text) {
            Ok(expr) => {
                for name in expr.names() {
                    if !vocabulary.names.contains(&name) {
                        report(format!("{what} reads {name:?}, which is not a counter"));
                    } else if vocabulary.hero_only.contains(&name) && def.players != Players::Hero {
                        report(format!(
                            "{what} reads {name:?}, which exists for the hero only; say \"players\": \"hero\""
                        ));
                    }
                }
                Some(expr)
            }
            Err(error) => {
                report(format!("{what} {text:?} does not parse: {error}"));
                None
            }
        }
    };
    let formula = check_formula("the formula", &def.formula, report);
    let sample = match (&def.sample.of, &formula) {
        (Some(of), _) => check_formula("the sample", of, report),
        (None, Some(Expr::Pct(_, opp))) => Some((**opp).clone()),
        (None, Some(_)) => {
            report(
                "the formula is not pct(made, opportunities), so the sample needs \"of\""
                    .to_owned(),
            );
            None
        }
        (None, None) => None,
    };
    Some((formula?, sample?))
}

fn check_bands(bands: &[Band], report: &mut impl FnMut(String)) {
    let Some((last, rest)) = bands.split_last() else {
        return;
    };
    if last.below.is_some() {
        report("the last band has \"below\"; it holds the rest".to_owned());
    }
    let mut previous: Option<f64> = None;
    for (i, band) in rest.iter().enumerate() {
        match band.below {
            None => report(format!(
                "band {i} has no \"below\"; only the last may omit it"
            )),
            Some(below) => {
                if previous.is_some_and(|previous| below <= previous) {
                    report(format!(
                        "band {i}'s \"below\" is not above the previous one"
                    ));
                }
                previous = Some(below);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: [&str; 6] = [
        "vpip",
        "vpip_opp",
        "hands",
        "net_bb_milli",
        "money_hands",
        "ev",
    ];
    const VOCABULARY: Vocabulary<'static> = Vocabulary {
        names: &NAMES,
        hero_only: &["ev"],
    };

    fn file(stats: &str) -> String {
        format!(r#"{{ "version": 1, "stats": [{stats}] }}"#)
    }

    fn stat(id: &str, formula: &str, extra: &str) -> String {
        format!(
            r#"{{ "id": "{id}", "group": "preflop", "players": "any",
                "label": {{ "en": "L", "hr": "L" }}, "name": {{ "en": "N", "hr": "N" }},
                "description": {{ "en": "D", "hr": "D" }}, "formula": "{formula}",
                "format": {{ "unit": "percent", "decimals": 1 }}, "sample": {{ "min": 10 }},
                "bands": [], "hud": "panel" {extra} }}"#
        )
    }

    fn problems(text: &str) -> Vec<String> {
        match load_stats(text, VOCABULARY) {
            Ok(_) => Vec::new(),
            Err(StatsError::Invalid(problems)) => {
                problems.iter().map(ToString::to_string).collect()
            }
            Err(other) => vec![other.to_string()],
        }
    }

    #[test]
    fn a_pct_formula_defaults_its_sample() {
        let defs =
            load_stats(&file(&stat("v", "pct(vpip, vpip_opp)", "")), VOCABULARY).expect("valid");
        let v = defs.get("v").expect("v");
        assert_eq!(v.sample, Expr::Name("vpip_opp".to_owned()));
        assert!(v.rate().is_some());
    }

    #[test]
    fn refuses_unknown_names_duplicates_and_missing_samples() {
        let text = file(
            &[
                stat("a", "pct(vpip, vpip_op)", ""),
                stat("a", "vpip", ""),
                stat("b", "net_bb_milli / money_hands", ""),
                stat("c", "ev / money_hands", r#", "x": 1"#),
            ]
            .join(","),
        );
        let unreadable = problems(&text);
        assert_eq!(unreadable.len(), 1);
        assert!(
            unreadable[0].starts_with("the stats file is not readable: unknown field `x`"),
            "{unreadable:?}"
        );
        let text = file(
            &[
                stat("a", "pct(vpip, vpip_op)", ""),
                stat("a", "vpip", ""),
                stat("b", "net_bb_milli / money_hands", ""),
                stat("c", "ev / money_hands", ""),
                stat("D", "pct(vpip,", ""),
            ]
            .join(","),
        );
        assert_eq!(
            problems(&text),
            [
                "a: the formula reads \"vpip_op\", which is not a counter",
                "a: duplicate id",
                "a: the formula is not pct(made, opportunities), so the sample needs \"of\"",
                "b: the formula is not pct(made, opportunities), so the sample needs \"of\"",
                "c: the formula reads \"ev\", which exists for the hero only; say \"players\": \"hero\"",
                "c: the formula is not pct(made, opportunities), so the sample needs \"of\"",
                "D: id \"D\" is not [a-z][a-z0-9_]*",
                "D: the formula \"pct(vpip,\" does not parse: expected a number, a name or \"(\", found the end at offset 9",
            ]
        );
    }

    #[test]
    fn refuses_bad_bands_and_formats() {
        let bands =
            |b: &str| file(&stat("a", "pct(vpip, vpip_opp)", "").replace(r#""bands": []"#, b));
        assert!(
            problems(&bands(
                r#""bands": [{ "below": 5, "tone": "low" }, { "tone": "high" }]"#
            ))
            .is_empty()
        );
        assert_eq!(
            problems(&bands(
                r#""bands": [{ "below": 5, "tone": "low" }, { "below": 5, "tone": "normal" }, { "tone": "high" }]"#
            )),
            ["a: band 1's \"below\" is not above the previous one"]
        );
        assert_eq!(
            problems(&bands(
                r#""bands": [{ "tone": "low" }, { "below": 9, "tone": "high" }]"#
            )),
            [
                "a: the last band has \"below\"; it holds the rest",
                "a: band 0 has no \"below\"; only the last may omit it"
            ]
        );
        let count = file(&stat("a", "hands", r#""#).replace(
            r#""format": { "unit": "percent", "decimals": 1 }, "sample": { "min": 10 }"#,
            r#""format": { "unit": "count", "decimals": 2 }, "sample": { "of": "hands", "min": 0 }"#,
        ));
        assert_eq!(problems(&count), ["a: a count has no decimals"]);
        let empty =
            file(&stat("a", "pct(vpip, vpip_opp)", "").replace(r#""hr": "N""#, r#""hr": " ""#));
        assert_eq!(problems(&empty), ["a: name.hr is empty"]);
    }

    #[test]
    fn refuses_another_version() {
        assert!(matches!(
            load_stats(r#"{ "version": 2, "stats": [] }"#, VOCABULARY),
            Err(StatsError::Version {
                found: 2,
                expected: 1
            })
        ));
        assert_eq!(problems(&file("")), ["no statistics"]);
    }
}
