//! The Analytics stat checker (docs/ANALYTICS.md §3, Step 3): the grouped
//! sums of the checker rows (`rail_store::checker`, the web's
//! `analytics_checker`) judged against their targets. Pure.
//!
//! The twin of `web/src/lib/stats/checker.ts`, which documents the method
//! (player %, target %, band, tone, cost, coverage, the breakdowns per spot,
//! size bucket and hand class, and the findings merged by family). Both are
//! held to the same output, field for field, by the fixture in
//! `tests/data/analytics/checker/` (`tests/checker.rs` and
//! `tests/test/analyticsChecker.test.ts`).
//!
//! **Arithmetic.** The inputs are floats (the reference's shares and EV
//! losses), so this module computes in `f64`, one IEEE operation at a time in
//! the TypeScript's order, summing groups in their input order: the doubles
//! are the TypeScript's bit for bit (`sqrt` is correctly rounded in both).
//! Every number out is rounded half away from zero to 6 decimals; every
//! decision (tone, order) is made on the unrounded values.
//!
//! The words (headlines and why-sentences, EN and HR) are rendered from a
//! [`Finding`]'s numbers by `packages/ui/analytics/findings.ts`: both apps
//! show them from the same shared screen.

// The checker's inputs are floats (JSON shares and EV), its counts small
// integers (exact as doubles).
#![allow(clippy::float_arithmetic, clippy::cast_precision_loss)]

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use rail_core::phf::Street;
use serde::{Deserialize, Serialize};

use crate::analytics::{ActionClass, Catalogue, CatalogueStat, StatKind};
use crate::analytics_rows::round_half_away;

/// One group of the checker's sums (`CheckerGroup`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupIn {
    pub stat: String,
    pub spot: String,
    pub size: String,
    pub hand_class: String,
    pub opps: i64,
    pub opps_taken: i64,
    pub n: i64,
    pub taken: i64,
    pub ref_share: f64,
    pub ev_high: f64,
    pub ev_low: f64,
    pub hands: i64,
}

/// What the checker reads of `CheckerSums`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SumsIn {
    pub hands: i64,
    pub pending: i64,
    pub groups: Vec<GroupIn>,
}

/// A coded stat's counts from the player's rollups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct CodedIn {
    pub made: i64,
    pub opp: i64,
}

/// How a judged set compares with its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Ok,
    Off,
    Far,
    Few,
    None,
}

/// The gap's sign.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    High,
    Low,
}

/// A finding's direction in play: too much folding or too little of
/// anything else is `Tight`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lean {
    Loose,
    Tight,
}

/// Where a target comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Charts,
    Solver,
}

/// One judged set of decisions (`CheckerFigures`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Figures {
    pub opps: i64,
    pub opps_taken: i64,
    pub n: i64,
    pub taken: i64,
    pub player: Option<f64>,
    pub target: Option<f64>,
    pub half: Option<f64>,
    pub band_low: Option<f64>,
    pub band_high: Option<f64>,
    pub gap: Option<f64>,
    pub direction: Option<Direction>,
    pub tone: Tone,
    pub cost_high: f64,
    pub cost_low: f64,
    pub cost: f64,
    pub coverage: Option<f64>,
}

impl Figures {
    const fn none() -> Self {
        Self {
            opps: 0,
            opps_taken: 0,
            n: 0,
            taken: 0,
            player: None,
            target: None,
            half: None,
            band_low: None,
            band_high: None,
            gap: None,
            direction: None,
            tone: Tone::None,
            cost_high: 0.0,
            cost_low: 0.0,
            cost: 0.0,
            coverage: None,
        }
    }
}

/// One breakdown row (`CheckerRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(flatten)]
    pub figures: Figures,
    pub key: String,
    pub share_of_taken: Option<f64>,
    pub worth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weak: Option<bool>,
}

/// One catalogue stat judged (`CheckedStat`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub id: String,
    pub kind: &'static str,
    pub source: Option<Source>,
    #[serde(flatten)]
    pub figures: Figures,
    pub spots: Vec<Row>,
    pub sizes: Vec<Row>,
    pub classes: Vec<Row>,
}

/// The numbers a finding's why-sentence reads (`CheckerWhy`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Why {
    pub stat: String,
    pub source: Source,
    pub spot: Option<String>,
    pub spot_player: Option<f64>,
    pub spot_target: Option<f64>,
    pub hand_class: Option<String>,
    pub class_player: Option<f64>,
    pub class_target: Option<f64>,
    pub class_share: Option<f64>,
    pub class_worth: Option<f64>,
}

/// A finding's stat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FindingStat {
    pub id: String,
    pub counted: bool,
}

/// Stats off target merged by family and lean (`CheckerFinding`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finding {
    pub family: String,
    pub lean: Lean,
    pub tone: Tone,
    pub cost: f64,
    pub stats: Vec<FindingStat>,
    pub lead: String,
    pub direction: Direction,
    pub why: Why,
}

/// The checker's answer (`CheckerResult`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckResult {
    pub hands: i64,
    pub pending: i64,
    pub stats: Vec<Checked>,
    pub findings: Vec<Finding>,
}

/* ------------------------------------------------------------- sums -- */

#[derive(Debug, Clone, Copy, Default)]
struct Acc {
    opps: i64,
    opps_taken: i64,
    n: i64,
    taken: i64,
    reference: f64,
    ev_high: f64,
    ev_low: f64,
}

impl Acc {
    fn add(&mut self, group: &GroupIn) {
        self.opps += group.opps;
        self.opps_taken += group.opps_taken;
        self.n += group.n;
        self.taken += group.taken;
        self.reference += group.ref_share;
        self.ev_high += group.ev_high;
        self.ev_low += group.ev_low;
    }
}

#[derive(Debug, Clone, Copy)]
struct Raw {
    opps: i64,
    opps_taken: i64,
    num: i64,
    den: i64,
    ref_num: f64,
    ref_den: f64,
    ev_high: f64,
    ev_low: f64,
}

fn rate_raw(acc: &Acc) -> Raw {
    Raw {
        opps: acc.opps,
        opps_taken: acc.opps_taken,
        num: acc.taken,
        den: acc.n,
        ref_num: acc.reference,
        ref_den: acc.n as f64,
        ev_high: acc.ev_high,
        ev_low: acc.ev_low,
    }
}

const fn share_raw(all: &Acc, part: &Acc) -> Raw {
    Raw {
        opps: all.opps_taken,
        opps_taken: part.opps_taken,
        num: part.taken,
        den: all.taken,
        ref_num: part.reference,
        ref_den: all.reference,
        ev_high: part.ev_high,
        ev_low: part.ev_low,
    }
}

#[derive(Debug, Clone, Copy)]
struct Rules {
    floor: f64,
    sample_min: i64,
    hands: i64,
}

#[derive(Debug, Clone)]
struct Judged {
    figures: Figures,
    cost_high: f64,
    cost_low: f64,
    cost: f64,
    raw: Raw,
}

fn r6(x: f64) -> f64 {
    round_half_away(x, 6)
}

fn cost_of(ev: f64, hands: i64) -> f64 {
    if hands > 0 {
        (ev * 100.0) / hands as f64
    } else {
        0.0
    }
}

fn judge(raw: Raw, rules: Rules) -> Judged {
    let den = raw.den as f64;
    let player = (raw.den > 0).then(|| (raw.num as f64 * 100.0) / den);
    let target = (raw.den > 0 && raw.ref_den > 0.0).then(|| (raw.ref_num * 100.0) / raw.ref_den);
    let cost_high = cost_of(raw.ev_high, rules.hands);
    let cost_low = cost_of(raw.ev_low, rules.hands);
    let mut figures = Figures {
        opps: raw.opps,
        opps_taken: raw.opps_taken,
        n: raw.den,
        taken: raw.num,
        player: player.map(r6),
        target: target.map(r6),
        cost_high: r6(cost_high),
        cost_low: r6(cost_low),
        coverage: (raw.opps > 0).then(|| r6(den / raw.opps as f64)),
        ..Figures::none()
    };
    let mut cost = 0.0;
    if let (Some(player), Some(target)) = (player, target) {
        let t = (raw.ref_num / raw.ref_den).clamp(0.0, 1.0);
        let half = rules
            .floor
            .max(1.96 * ((t * (1.0 - t)) / den).sqrt() * 100.0);
        let gap = player - target;
        let direction = if gap > 0.0 {
            Some(Direction::High)
        } else if gap < 0.0 {
            Some(Direction::Low)
        } else {
            None
        };
        let outside = gap.abs() - half;
        let tone = if outside <= 0.0 {
            Tone::Ok
        } else if raw.den < rules.sample_min {
            Tone::Few
        } else if outside > 2.0 * half {
            Tone::Far
        } else {
            Tone::Off
        };
        cost = match direction {
            Some(Direction::High) => cost_high,
            Some(Direction::Low) => cost_low,
            None => 0.0,
        };
        figures.half = Some(r6(half));
        figures.band_low = Some(r6((target - half).max(0.0)));
        figures.band_high = Some(r6((target + half).min(100.0)));
        figures.gap = Some(r6(gap));
        figures.direction = direction;
        figures.tone = tone;
    }
    figures.cost = r6(cost);
    Judged {
        figures,
        cost_high,
        cost_low,
        cost,
        raw,
    }
}

/// num − refNum / refDen × den, in `direction`; `None` without a target.
fn excess(raw: &Raw, direction: Direction) -> Option<f64> {
    if raw.den <= 0 || raw.ref_den <= 0.0 {
        return None;
    }
    let expected = (raw.ref_num / raw.ref_den) * raw.den as f64;
    let num = raw.num as f64;
    Some(match direction {
        Direction::High => num - expected,
        Direction::Low => expected - num,
    })
}

/* ------------------------------------------------------- breakdowns -- */

#[derive(Debug, Clone)]
struct RowJudged {
    row: Row,
    judged: Judged,
}

/// Keys in first-seen order, each with its groups' sums.
fn by_key<'a>(
    groups: impl IntoIterator<Item = &'a GroupIn>,
    key: impl Fn(&GroupIn) -> &str,
) -> Vec<(String, Acc)> {
    let mut out: Vec<(String, Acc)> = Vec::new();
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    for group in groups {
        let k = key(group);
        let slot = match index.get(k) {
            Some(&i) => i,
            None => {
                index.insert(k.to_owned(), out.len());
                out.push((k.to_owned(), Acc::default()));
                out.len() - 1
            }
        };
        out[slot].1.add(group);
    }
    out
}

fn acc_of<'a>(accs: &'a [(String, Acc)], key: &str) -> Option<&'a Acc> {
    accs.iter().find(|(k, _)| k == key).map(|(_, acc)| acc)
}

/// Catalogue ids first in their order, then any other key in byte order; '' dropped.
fn in_order(accs: &[(String, Acc)], order: &[String]) -> Vec<String> {
    let present: BTreeSet<&str> = accs
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !k.is_empty())
        .collect();
    let mut out: Vec<String> = order
        .iter()
        .filter(|id| present.contains(id.as_str()))
        .cloned()
        .collect();
    out.extend(
        present
            .iter()
            .filter(|k| !order.iter().any(|id| id == *k))
            .map(|k| (*k).to_owned()),
    );
    out
}

fn row_of(key: String, judged: Judged, stat_taken: i64, weak: Option<bool>) -> RowJudged {
    let raw = judged.raw;
    let row = Row {
        figures: judged.figures.clone(),
        key,
        share_of_taken: (stat_taken > 0).then(|| r6(raw.num as f64 / stat_taken as f64)),
        worth: (raw.num > 0).then(|| r6(raw.ev_high / raw.num as f64)),
        weak,
    };
    RowJudged { row, judged }
}

fn spot_weight(judged: &Judged, direction: Option<Direction>) -> f64 {
    match direction {
        Some(Direction::High) => judged.cost_high,
        Some(Direction::Low) => judged.cost_low,
        None => judged.cost_high + judged.cost_low,
    }
}

/// Larger first, for two distinct finite doubles (the TypeScript's `b > a ? 1 : -1`).
fn desc(a: f64, b: f64) -> Ordering {
    if b > a {
        Ordering::Greater
    } else {
        Ordering::Less
    }
}

fn sort_spots(rows: &mut [RowJudged], direction: Option<Direction>) {
    rows.sort_by(|a, b| {
        let wa = spot_weight(&a.judged, direction);
        let wb = spot_weight(&b.judged, direction);
        if wa != wb {
            return desc(wa, wb);
        }
        if a.judged.raw.den != b.judged.raw.den {
            return b.judged.raw.den.cmp(&a.judged.raw.den);
        }
        a.row.key.as_bytes().cmp(b.row.key.as_bytes())
    });
}

/* ------------------------------------------------------------ check -- */

#[derive(Debug)]
struct StatWork<'a> {
    stat: &'a CatalogueStat,
    index: usize,
    checked: Checked,
    judged: Option<Judged>,
    spots: Vec<RowJudged>,
    classes: Vec<RowJudged>,
}

const fn kind_name(stat: &CatalogueStat) -> &'static str {
    match stat.kind {
        StatKind::Rate { .. } => "rate",
        StatKind::Share { .. } => "share",
        StatKind::Coded { .. } => "coded",
    }
}

fn source_of(stat: &CatalogueStat) -> Option<Source> {
    match (&stat.kind, stat.street) {
        (StatKind::Coded { .. }, _) | (_, Street::Showdown) => None,
        (_, Street::Preflop) => Some(Source::Charts),
        _ => Some(Source::Solver),
    }
}

fn lean_of(stat: &CatalogueStat, direction: Direction) -> Lean {
    let tighter_when_high = matches!(
        stat.kind,
        StatKind::Rate {
            class: ActionClass::Fold,
            ..
        }
    );
    if (direction == Direction::High) == tighter_when_high {
        Lean::Tight
    } else {
        Lean::Loose
    }
}

fn checked(stat: &CatalogueStat, figures: Figures) -> Checked {
    Checked {
        id: stat.id.clone(),
        kind: kind_name(stat),
        source: source_of(stat),
        figures,
        spots: Vec::new(),
        sizes: Vec::new(),
        classes: Vec::new(),
    }
}

/// Judge the sums against the catalogue; `coded` holds the player's coded
/// stats by catalogue id.
pub fn check_stats(
    catalogue: &Catalogue,
    sums: &SumsIn,
    coded: &BTreeMap<String, CodedIn>,
) -> CheckResult {
    let hands = sums.hands;
    let size_order: Vec<String> = catalogue
        .size_buckets
        .iter()
        .map(|bucket| bucket.id.clone())
        .collect();
    let class_order: Vec<String> = catalogue
        .hand_classes
        .iter()
        .map(|cls| cls.id.clone())
        .collect();

    let work: Vec<StatWork<'_>> = catalogue
        .stats
        .iter()
        .enumerate()
        .map(|(index, stat)| {
            let rules = Rules {
                floor: stat.band_floor,
                sample_min: i64::from(stat.sample_min),
                hands,
            };
            let parent = match &stat.kind {
                StatKind::Coded { .. } => {
                    let mut figures = Figures::none();
                    if let Some(counts) = coded.get(&stat.id) {
                        figures.opps = counts.opp;
                        figures.opps_taken = counts.made;
                        figures.n = counts.opp;
                        figures.taken = counts.made;
                        figures.player = (counts.opp > 0)
                            .then(|| r6((counts.made as f64 * 100.0) / counts.opp as f64));
                    }
                    return StatWork {
                        stat,
                        index,
                        checked: checked(stat, figures),
                        judged: None,
                        spots: Vec::new(),
                        classes: Vec::new(),
                    };
                }
                StatKind::Share { of, .. } => of.as_str(),
                StatKind::Rate { .. } => stat.id.as_str(),
            };
            let groups: Vec<&GroupIn> = sums.groups.iter().filter(|g| g.stat == parent).collect();
            let (judged, mut spots, sizes, classes) = match &stat.kind {
                StatKind::Share { weak, .. } => {
                    let is_weak = |g: &GroupIn| weak.contains(&g.hand_class);
                    let mut all = Acc::default();
                    let mut weak_all = Acc::default();
                    for group in &groups {
                        all.add(group);
                        if is_weak(group) {
                            weak_all.add(group);
                        }
                    }
                    let judged = judge(share_raw(&all, &weak_all), rules);
                    let split = |key: &dyn Fn(&GroupIn) -> &str, ordered: bool| -> Vec<RowJudged> {
                        let alls = by_key(groups.iter().copied(), key);
                        let weaks = by_key(groups.iter().copied().filter(|g| is_weak(g)), key);
                        let keys: Vec<String> = if ordered {
                            in_order(&alls, &size_order)
                        } else {
                            alls.iter().map(|(k, _)| k.clone()).collect()
                        };
                        keys.into_iter()
                            .map(|k| {
                                let a = acc_of(&alls, &k).copied().unwrap_or_default();
                                let w = acc_of(&weaks, &k).copied().unwrap_or_default();
                                row_of(k, judge(share_raw(&a, &w), rules), all.taken, None)
                            })
                            .collect()
                    };
                    let spots = split(&|g| g.spot.as_str(), false);
                    let sizes = split(&|g| g.size.as_str(), true);
                    let class_accs = by_key(groups.iter().copied(), |g| g.hand_class.as_str());
                    let classes = in_order(&class_accs, &class_order)
                        .into_iter()
                        .map(|k| {
                            let part = acc_of(&class_accs, &k).copied().unwrap_or_default();
                            let is = weak.contains(&k);
                            row_of(k, judge(share_raw(&all, &part), rules), all.taken, Some(is))
                        })
                        .collect();
                    (judged, spots, sizes, classes)
                }
                _ => {
                    let mut all = Acc::default();
                    for group in &groups {
                        all.add(group);
                    }
                    let judged = judge(rate_raw(&all), rules);
                    let rows = |accs: &[(String, Acc)], keys: Vec<String>| -> Vec<RowJudged> {
                        keys.into_iter()
                            .map(|k| {
                                let acc = acc_of(accs, &k).copied().unwrap_or_default();
                                row_of(k, judge(rate_raw(&acc), rules), all.taken, None)
                            })
                            .collect()
                    };
                    let spot_accs = by_key(groups.iter().copied(), |g| g.spot.as_str());
                    let spot_keys = spot_accs.iter().map(|(k, _)| k.clone()).collect();
                    let spots = rows(&spot_accs, spot_keys);
                    let size_accs = by_key(groups.iter().copied(), |g| g.size.as_str());
                    let sizes = rows(&size_accs, in_order(&size_accs, &size_order));
                    let class_accs = by_key(groups.iter().copied(), |g| g.hand_class.as_str());
                    let classes = rows(&class_accs, in_order(&class_accs, &class_order));
                    (judged, spots, sizes, classes)
                }
            };
            sort_spots(&mut spots, judged.figures.direction);
            let mut out = checked(stat, judged.figures.clone());
            out.spots = spots.iter().map(|r| r.row.clone()).collect();
            out.sizes = sizes.into_iter().map(|r| r.row).collect();
            out.classes = classes.iter().map(|r| r.row.clone()).collect();
            StatWork {
                stat,
                index,
                checked: out,
                judged: Some(judged),
                spots,
                classes,
            }
        })
        .collect();

    let findings = findings_of(catalogue, &work);
    CheckResult {
        hands,
        pending: sums.pending,
        stats: work.into_iter().map(|w| w.checked).collect(),
        findings,
    }
}

/* --------------------------------------------------------- findings -- */

/// The stat whose decisions hold all of this one's (`within`, a share's `of`).
fn container(stat: &CatalogueStat) -> Option<&str> {
    match &stat.kind {
        StatKind::Rate { within, .. } => within.as_deref(),
        StatKind::Share { of, .. } => Some(of.as_str()),
        StatKind::Coded { .. } => None,
    }
}

/// Whether two stats of a finding judge the same decisions: one Streets
/// block, or both preflop (the TypeScript's `overlaps`).
fn overlaps(a: &CatalogueStat, b: &CatalogueStat) -> bool {
    a.group == b.group || (a.street == Street::Preflop && b.street == Street::Preflop)
}

fn findings_of(catalogue: &Catalogue, work: &[StatWork<'_>]) -> Vec<Finding> {
    // (family, lean) in first-seen order.
    let mut groups: Vec<(String, Lean, Vec<&StatWork<'_>>)> = Vec::new();
    for w in work {
        let Some(judged) = &w.judged else { continue };
        let Some(direction) = judged.figures.direction else {
            continue;
        };
        if !matches!(judged.figures.tone, Tone::Off | Tone::Far) {
            continue;
        }
        let lean = lean_of(w.stat, direction);
        match groups
            .iter_mut()
            .find(|(family, l, _)| *family == w.stat.family && *l == lean)
        {
            Some((_, _, members)) => members.push(w),
            None => groups.push((w.stat.family.clone(), lean, vec![w])),
        }
    }
    let cost_of = |w: &StatWork<'_>| w.judged.as_ref().map_or(0.0, |j| j.cost);
    let mut out: Vec<(Finding, f64, usize)> = Vec::new();
    for (family, lean, mut members) in groups {
        members.sort_by(|a, b| {
            let (ca, cb) = (cost_of(a), cost_of(b));
            if ca != cb {
                return desc(ca, cb);
            }
            a.index.cmp(&b.index)
        });
        let ids: BTreeSet<&str> = members.iter().map(|m| m.stat.id.as_str()).collect();
        let mut cost = 0.0;
        let mut summed: Vec<&CatalogueStat> = Vec::new();
        let stats = members
            .iter()
            .map(|m| {
                let counted = !container(m.stat).is_some_and(|c| ids.contains(c))
                    && !summed.iter().any(|other| overlaps(other, m.stat));
                if counted {
                    cost += cost_of(m);
                    summed.push(m.stat);
                }
                FindingStat {
                    id: m.stat.id.clone(),
                    counted,
                }
            })
            .collect();
        let lead = members[0];
        let direction = lead
            .judged
            .as_ref()
            .and_then(|j| j.figures.direction)
            .unwrap_or(Direction::High);
        let family_index = catalogue
            .families
            .iter()
            .position(|f| *f == family)
            .unwrap_or(usize::MAX);
        let tone = if members.iter().any(|m| m.checked.figures.tone == Tone::Far) {
            Tone::Far
        } else {
            Tone::Off
        };
        out.push((
            Finding {
                family,
                lean,
                tone,
                cost: r6(cost),
                stats,
                lead: lead.stat.id.clone(),
                direction,
                why: why_of(lead, direction),
            },
            cost,
            family_index,
        ));
    }
    out.sort_by(|a, b| {
        if a.1 != b.1 {
            return desc(a.1, b.1);
        }
        if a.2 != b.2 {
            return a.2.cmp(&b.2);
        }
        a.0.lean.cmp(&b.0.lean)
    });
    out.into_iter().map(|(finding, _, _)| finding).collect()
}

/// The row with the most cost in `direction`, then the most excess
/// (`cost_first`), or the reverse; `None` when none has more actions than the
/// reference in that direction (or, `cost_first`, a cost).
fn pick(rows: &[RowJudged], direction: Direction, cost_first: bool) -> Option<&RowJudged> {
    let mut best: Option<(&RowJudged, f64, f64)> = None;
    for row in rows {
        let Some(extra) = excess(&row.judged.raw, direction) else {
            continue;
        };
        let cost = match direction {
            Direction::High => row.judged.cost_high,
            Direction::Low => row.judged.cost_low,
        };
        if extra <= 0.0 && !(cost_first && cost > 0.0) {
            continue;
        }
        let better = match best {
            None => true,
            Some((_, best_cost, best_extra)) => {
                if cost_first {
                    cost > best_cost || (cost == best_cost && extra > best_extra)
                } else {
                    extra > best_extra || (extra == best_extra && cost > best_cost)
                }
            }
        };
        if better {
            best = Some((row, cost, extra));
        }
    }
    best.map(|(row, _, _)| row)
}

fn why_of(lead: &StatWork<'_>, direction: Direction) -> Why {
    let spot = pick(&lead.spots, direction, true);
    let class_rows: Vec<RowJudged> = match lead.stat.kind {
        StatKind::Share { .. } => lead
            .classes
            .iter()
            .filter(|r| r.row.weak == Some(true))
            .cloned()
            .collect(),
        _ => lead.classes.clone(),
    };
    let cls = pick(&class_rows, direction, false);
    Why {
        stat: lead.stat.id.clone(),
        source: lead.checked.source.unwrap_or(Source::Solver),
        spot: spot.map(|r| r.row.key.clone()),
        spot_player: spot.and_then(|r| r.row.figures.player),
        spot_target: spot.and_then(|r| r.row.figures.target),
        hand_class: cls.map(|r| r.row.key.clone()),
        class_player: cls.and_then(|r| r.row.figures.player),
        class_target: cls.and_then(|r| r.row.figures.target),
        class_share: cls.and_then(|r| r.row.share_of_taken),
        class_worth: cls
            .filter(|_| direction == Direction::High)
            .and_then(|r| r.row.worth),
    }
}
