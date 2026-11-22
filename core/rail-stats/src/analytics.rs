//! The Analytics stat catalogue (docs/ANALYTICS.md Step 1,
//! `config/stats/analytics.json`, schema `analytics.schema.json`): the
//! statistics the Analytics screen checks against a target.
//!
//! Three kinds of entry:
//!
//! - **rate** - a counter in the decision-event language
//!   (docs/STATS-SPEC.md §14, [`crate::custom`]): `count` is
//!   `mode opportunity => action`, and the action must be exactly a test of
//!   `action` against the stat's action class (`fold`, `call`, `raise`,
//!   `bet`, `vpip`, `pfr`). The same text counts the hero and every
//!   opponent ([`Catalogue::counts`], or through [`CustomSet`] with
//!   [`Catalogue::custom_defs`]), and names the decisions whose analysed
//!   reference gives the target ([`Catalogue::membership`]).
//! - **share** - of the actions of the rate `of`, the share made with a hand
//!   class in `weak` (the composition stats: "river bets made with third
//!   pair or worse"). The hand classes come from the analysis facts
//!   ([`Catalogue::hand_class`]); hero only, it needs the cards.
//! - **coded** - a shipped statistic of `standard.json` (WTSD, W$SD, WWSF),
//!   shown with the player's number and no target.
//!
//! **Membership** (what Step 2 stores per analysed decision): for a rate in
//! `first` or `any` mode the member is the seat's *first* event that passes
//! the opportunity - one per hand, the decision the per-hand counter
//! counts; in `each` mode every passing event. "Taken" is whether that
//! event passes the action, i.e. whether the decision's action is in the
//! class. For `any` mode the per-hand `made` can come from a later event
//! (VPIP: a blind that checks, then calls a raise); the decision-level
//! "taken" is the first decision's.
//!
//! The web has a TypeScript twin (`web/src/lib/stats/analytics.ts`, over
//! the port of [`crate::events`] in `events.ts`); `npm run golden:emit`
//! writes its counts and membership for every corpus hand to
//! `testdata/golden-analytics/`, and `tests/analytics_corpus.rs` holds the
//! two equal.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::OnceLock;

use rail_config::stats::predicate::{Cmp, Cond, Literal, Test};
use rail_config::stats::{
    Expr, Format, Group as StatGroup, HudPlace, Players, SampleDef, StatDef, StatsFile, Text, Unit,
    parse_formula,
};
use rail_core::phf::{ActionType, Street};
use serde::Deserialize;

use crate::custom::{Counts, CustomCounter, CustomDef, FIELDS, Field, default_formula};
use crate::events::{HandEvents, SeatEvents};

/// The catalogue shipped with this build.
pub const SHIPPED_ANALYTICS: &str = include_str!("../../../config/stats/analytics.json");

/// The `version` of a catalogue this build reads.
pub const ANALYTICS_FILE_VERSION: u32 = 1;

/// A rate's custom counter is `an_<id>` (and `an_<id>_opp`): catalogue ids
/// such as `vpip` are also coded counter names, which a custom formula
/// would read first.
pub const COUNTER_PREFIX: &str = "an_";

/// What the stored membership of a decision was computed under (Step 2
/// stores it beside each analysed decision's stats): bumped whenever a
/// rate's id, class or count changes, or a rate is added or removed, so the
/// stored rows are computed again. `tests/analytics.rs` pins
/// [`Catalogue::membership_fingerprint`] to this version; the web's
/// `ANALYTICS_MEMBERSHIP_VERSION` is the same string. It also stands for
/// what a stored checker row reads besides the rates
/// ([`Catalogue::rows_fingerprint`], pinned by `tests/analytics_rows.rs`)
/// and for the row derivation itself ([`crate::analytics_rows`]): a change
/// to either bumps it too.
pub const MEMBERSHIP_VERSION: &str = "analytics/1";

/// The longest catalogue id: `an_<id>` must fit a custom counter id.
pub const MAX_ID: usize = crate::custom::MAX_COUNTER_ID - COUNTER_PREFIX.len();

/// The analysis' made-hand classes (`web/src/lib/analysis/types.ts`
/// `MadeHandClass`).
pub const MADE_CLASSES: [&str; 17] = [
    "straight-flush",
    "quads",
    "full-house",
    "flush",
    "straight",
    "set",
    "trips",
    "two-pair",
    "overpair",
    "top-pair",
    "pocket-pair-below-top",
    "second-pair",
    "weak-pair",
    "underpair",
    "ace-high",
    "high-card",
    "board",
];

/// The analysis' draw classes (`DrawClass`).
pub const DRAW_CLASSES: [&str; 7] = [
    "flush-draw",
    "nut-flush-draw",
    "oesd",
    "gutshot",
    "backdoor-flush",
    "backdoor-straight",
    "overcards",
];

/* ------------------------------------------------------------ the model - */

/// A rate's action class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionClass {
    Fold,
    Call,
    Raise,
    Bet,
    Vpip,
    Pfr,
}

impl ActionClass {
    pub const ALL: [Self; 6] = [
        Self::Fold,
        Self::Call,
        Self::Raise,
        Self::Bet,
        Self::Vpip,
        Self::Pfr,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fold => "fold",
            Self::Call => "call",
            Self::Raise => "raise",
            Self::Bet => "bet",
            Self::Vpip => "vpip",
            Self::Pfr => "pfr",
        }
    }
}

/// A decision's action, as the events and the analysis name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Fold,
    Check,
    Call,
    Bet,
    Raise,
}

impl Action {
    pub const ALL: [Self; 5] = [Self::Fold, Self::Check, Self::Call, Self::Bet, Self::Raise];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fold => "fold",
            Self::Check => "check",
            Self::Call => "call",
            Self::Bet => "bet",
            Self::Raise => "raise",
        }
    }

    /// The action of an event (`None` for a type that is not a decision).
    pub fn of(kind: ActionType) -> Option<Self> {
        match kind {
            ActionType::Fold => Some(Self::Fold),
            ActionType::Check => Some(Self::Check),
            ActionType::Call => Some(Self::Call),
            ActionType::Bet => Some(Self::Bet),
            ActionType::Raise => Some(Self::Raise),
            _ => None,
        }
    }

    /// By name (`"fold"`, ...).
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.as_str() == name)
    }
}

/// A postflop hand class: the first whose conditions hold is the hand's.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandClass {
    pub id: String,
    pub label: Text,
    /// The made class is one of these.
    #[serde(default)]
    pub made: Option<Vec<String>>,
    /// At least one of these draws.
    #[serde(default)]
    pub draws: Option<Vec<String>>,
}

impl HandClass {
    fn matches(&self, made: &str, draws: &[&str]) -> bool {
        self.made
            .as_ref()
            .is_none_or(|list| list.iter().any(|m| m == made))
            && self
                .draws
                .as_ref()
                .is_none_or(|list| list.iter().any(|d| draws.contains(&d.as_str())))
    }
}

/// A bet-size bucket (docs/ANALYTICS.md §3): a postflop decision that
/// faces a bet of `facts.facingPot` falls in the last bucket whose `min`
/// (thousandths of the pot) the size reaches ([`Catalogue::size_bucket`]).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SizeBucket {
    pub id: String,
    /// Thousandths of the pot (400 = 40%).
    pub min: u32,
    pub label: Text,
}

/// A block of the Streets tab, a heading of All stats.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatGroupDef {
    pub id: String,
    pub street: Street,
    pub label: Text,
}

/// The gap in words.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Words {
    /// Above the band ("Folds too much").
    pub high: Text,
    /// Below the band ("Folds too little").
    pub low: Text,
}

/// What an entry counts.
#[derive(Debug, Clone, PartialEq)]
pub enum StatKind {
    Rate {
        /// The predicate, as written.
        count: String,
        counter: CustomCounter,
        class: ActionClass,
        /// A shipped statistic it equals on every corpus row.
        coded: Option<String>,
        /// A rate whose opportunities hold all of this one's.
        within: Option<String>,
    },
    Share {
        /// The rate whose actions it splits.
        of: String,
        /// Hand class ids.
        weak: Vec<String>,
    },
    Coded {
        /// A `standard.json` id.
        coded: String,
    },
}

/// One catalogue entry.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogueStat {
    pub id: String,
    pub kind: StatKind,
    /// `Showdown` for the showdown stats.
    pub street: Street,
    pub group: String,
    pub family: String,
    pub label: Text,
    pub sub: Option<Text>,
    pub words: Words,
    /// Opportunities (a share: the parent's actions) under which the stat
    /// is grey.
    pub sample_min: u32,
    /// The band's smallest half-width, percentage points.
    pub band_floor: f64,
}

impl CatalogueStat {
    /// Its counter, when it is a rate.
    pub fn counter(&self) -> Option<&CustomCounter> {
        match &self.kind {
            StatKind::Rate { counter, .. } => Some(counter),
            _ => None,
        }
    }

    /// Its action class, when it is a rate.
    pub fn class(&self) -> Option<ActionClass> {
        match &self.kind {
            StatKind::Rate { class, .. } => Some(*class),
            _ => None,
        }
    }

    /// `an_<id>`: the id of its custom statistic and made counter.
    pub fn counter_id(&self) -> String {
        format!("{COUNTER_PREFIX}{}", self.id)
    }
}

/// The catalogue, validated.
#[derive(Debug, Clone, PartialEq)]
pub struct Catalogue {
    pub action_classes: BTreeMap<ActionClass, Vec<Action>>,
    pub hand_classes: Vec<HandClass>,
    pub size_buckets: Vec<SizeBucket>,
    pub groups: Vec<StatGroupDef>,
    pub families: Vec<String>,
    pub stats: Vec<CatalogueStat>,
}

/// A decision that belongs to one or more rates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionMembership {
    /// `Decision::order` (the analysis row's `ord`).
    pub order: usize,
    pub seat: u32,
    /// `(index into Catalogue::stats, taken)`, in catalogue order.
    pub stats: Vec<(usize, bool)>,
}

/* -------------------------------------------------------------- loading - */

/// Why a catalogue was not loaded.
#[derive(Debug)]
pub enum CatalogueError {
    /// Not JSON, or not this shape.
    Json(serde_json::Error),
    Version {
        found: u32,
        expected: u32,
    },
    /// Read, but wrong: every problem, `<id>: message`.
    Invalid(Vec<String>),
}

impl fmt::Display for CatalogueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "analytics catalogue: {error}"),
            Self::Version { found, expected } => {
                write!(
                    f,
                    "analytics catalogue version {found}, expected {expected}"
                )
            }
            Self::Invalid(problems) => {
                write!(f, "analytics catalogue: {}", problems.join("; "))
            }
        }
    }
}

impl std::error::Error for CatalogueError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FileIn {
    #[serde(rename = "$schema", default)]
    _schema: Option<String>,
    version: u32,
    action_classes: BTreeMap<ActionClass, Vec<Action>>,
    hand_classes: Vec<HandClass>,
    size_buckets: Vec<SizeBucket>,
    groups: Vec<StatGroupDef>,
    families: Vec<String>,
    stats: Vec<StatIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum KindIn {
    Rate,
    Share,
    Coded,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SampleIn {
    min: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BandIn {
    floor: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatIn {
    id: String,
    kind: KindIn,
    street: Street,
    group: String,
    family: String,
    label: Text,
    #[serde(default)]
    sub: Option<Text>,
    #[serde(default)]
    count: Option<String>,
    #[serde(default)]
    class: Option<ActionClass>,
    #[serde(default)]
    coded: Option<String>,
    #[serde(default)]
    within: Option<String>,
    #[serde(default)]
    of: Option<String>,
    #[serde(default)]
    weak: Option<Vec<String>>,
    words: Words,
    sample: SampleIn,
    band: BandIn,
}

fn valid_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && id.len() <= MAX_ID
}

fn street_name(street: Street) -> &'static str {
    match street {
        Street::Preflop => "preflop",
        Street::Flop => "flop",
        Street::Turn => "turn",
        Street::River => "river",
        Street::Showdown => "showdown",
    }
}

fn field_index(field: Field) -> usize {
    Field::ALL
        .iter()
        .position(|candidate| *candidate == field)
        .unwrap_or(usize::MAX)
}

fn choice_index(field: Field, word: &str) -> Option<usize> {
    match FIELDS.get(field_index(field))?.kind {
        rail_config::stats::predicate::FieldKind::Choice(words) => {
            words.iter().position(|candidate| *candidate == word)
        }
        _ => None,
    }
}

/// The actions a rate's action condition accepts, when it is exactly a test
/// of `action` (`action = x`, `action in (x, y)`); `None` otherwise.
fn action_set(cond: &Cond) -> Option<BTreeSet<Action>> {
    let Cond::Test { field, test } = cond else {
        return None;
    };
    if *field != field_index(Field::Action) {
        return None;
    }
    let literals: Vec<Literal> = match test {
        Test::Cmp(Cmp::Eq, literal) => vec![*literal],
        Test::In(list) => list.clone(),
        _ => return None,
    };
    literals
        .into_iter()
        .map(|literal| match literal {
            Literal::Choice(index) => Action::ALL.get(index).copied(),
            _ => None,
        })
        .collect()
}

/// Whether the opportunity is `street = <street> and ...` at its top level.
fn pins_street(cond: &Cond, street: Street) -> bool {
    let Some(want) = choice_index(Field::Street, street_name(street)) else {
        return false;
    };
    let is_street = |cond: &Cond| {
        matches!(cond, Cond::Test { field, test: Test::Cmp(Cmp::Eq, Literal::Choice(index)) }
            if *field == field_index(Field::Street) && *index == want)
    };
    match cond {
        Cond::And(parts) => parts.iter().any(is_street),
        other => is_street(other),
    }
}

/// The shipped definitions of `standard.json`, by id.
fn shipped_defs() -> BTreeMap<String, StatDef> {
    serde_json::from_str::<StatsFile>(rail_config::stats::SHIPPED_STATS)
        .map(|file| {
            file.stats
                .into_iter()
                .map(|def| (def.id.clone(), def))
                .collect()
        })
        .unwrap_or_default()
}

/// The `(made, opportunities)` counter names of a shipped statistic whose
/// formula is `pct(made, opportunities)`.
pub fn coded_counters(id: &str) -> Option<(String, String)> {
    let def = shipped_defs().remove(id)?;
    match parse_formula(&def.formula).ok()? {
        Expr::Pct(made, opp) => match (*made, *opp) {
            (Expr::Name(made), Expr::Name(opp)) => Some((made, opp)),
            _ => None,
        },
        _ => None,
    }
}

/// Parse and validate a catalogue.
pub fn load_catalogue(text: &str) -> Result<Catalogue, CatalogueError> {
    let file: FileIn = serde_json::from_str(text).map_err(CatalogueError::Json)?;
    if file.version != ANALYTICS_FILE_VERSION {
        return Err(CatalogueError::Version {
            found: file.version,
            expected: ANALYTICS_FILE_VERSION,
        });
    }
    let mut problems: Vec<String> = Vec::new();
    let mut problem = |what: &str, message: String| problems.push(format!("{what}: {message}"));

    // Action classes: every class, none empty.
    for class in ActionClass::ALL {
        match file.action_classes.get(&class) {
            None => problem("actionClasses", format!("{} is missing", class.as_str())),
            Some(list) if list.is_empty() => {
                problem("actionClasses", format!("{} is empty", class.as_str()));
            }
            Some(_) => {}
        }
    }

    // Hand classes.
    let mut seen = BTreeSet::new();
    let last = file.hand_classes.len().saturating_sub(1);
    for (index, class) in file.hand_classes.iter().enumerate() {
        let id = class.id.as_str();
        if !valid_id(id) || !seen.insert(id) {
            problem(id, "a hand class needs a unique id".to_owned());
        }
        for made in class.made.iter().flatten() {
            if !MADE_CLASSES.contains(&made.as_str()) {
                problem(id, format!("{made} is not a made class"));
            }
        }
        for draw in class.draws.iter().flatten() {
            if !DRAW_CLASSES.contains(&draw.as_str()) {
                problem(id, format!("{draw} is not a draw class"));
            }
        }
        let open = class.made.is_none() && class.draws.is_none();
        if open != (index == last) {
            problem(
                id,
                "the last hand class, and only it, has no conditions".to_owned(),
            );
        }
        if class.label.en.is_empty() || class.label.hr.is_empty() {
            problem(id, "a label in every language".to_owned());
        }
    }
    if file.hand_classes.len() < 2 {
        problem("handClasses", "at least two".to_owned());
    }

    // Size buckets: unique ids, the first at 0, rising.
    let mut bucket_ids = BTreeSet::new();
    for (index, bucket) in file.size_buckets.iter().enumerate() {
        let id = bucket.id.as_str();
        if id.is_empty() || id.contains('|') || !bucket_ids.insert(id) {
            problem(id, "a size bucket needs a unique id".to_owned());
        }
        let rising = match index {
            0 => bucket.min == 0,
            _ => file.size_buckets[index - 1].min < bucket.min,
        };
        if !rising {
            problem(id, "size buckets start at 0 and rise strictly".to_owned());
        }
        if bucket.label.en.is_empty() || bucket.label.hr.is_empty() {
            problem(id, "a label in every language".to_owned());
        }
    }
    if file.size_buckets.len() < 2 {
        problem("sizeBuckets", "at least two".to_owned());
    }

    // Groups and families.
    let mut group_ids = BTreeSet::new();
    for group in &file.groups {
        if !valid_id(&group.id) || !group_ids.insert(group.id.as_str()) {
            problem(&group.id, "a group needs a unique id".to_owned());
        }
    }
    let mut family_ids = BTreeSet::new();
    for family in &file.families {
        if !valid_id(family) || !family_ids.insert(family.as_str()) {
            problem(family, "a family needs a unique id".to_owned());
        }
    }

    // Stats: ids first, so references can be checked in any order.
    let mut ids: BTreeMap<&str, &StatIn> = BTreeMap::new();
    for stat in &file.stats {
        if !valid_id(&stat.id) {
            problem(
                &stat.id,
                format!("an id is [a-z][a-z0-9_]*, at most {MAX_ID} bytes"),
            );
        }
        if ids.insert(stat.id.as_str(), stat).is_some() {
            problem(&stat.id, "a second stat with this id".to_owned());
        }
    }
    let shipped = shipped_defs();
    let mut stats = Vec::with_capacity(file.stats.len());
    for stat in &file.stats {
        let id = stat.id.as_str();
        match file.groups.iter().find(|group| group.id == stat.group) {
            None => problem(id, format!("no group {}", stat.group)),
            Some(group) if group.street != stat.street => {
                problem(id, format!("group {} is on another street", stat.group))
            }
            Some(_) => {}
        }
        if !family_ids.contains(stat.family.as_str()) {
            problem(id, format!("no family {}", stat.family));
        }
        let texts = [
            Some(&stat.label),
            stat.sub.as_ref(),
            Some(&stat.words.high),
            Some(&stat.words.low),
        ];
        if texts
            .into_iter()
            .flatten()
            .any(|text| text.en.trim().is_empty() || text.hr.trim().is_empty())
        {
            problem(id, "every text in every language".to_owned());
        }
        if stat.sample.min == 0 {
            problem(id, "sample.min is at least 1".to_owned());
        }
        if !(stat.band.floor > 0.0 && stat.band.floor <= 50.0) {
            problem(id, "band.floor is above 0 and at most 50".to_owned());
        }
        let extra = |kind: &str, names: &[(&str, bool)]| -> Vec<String> {
            names
                .iter()
                .filter(|(_, present)| *present)
                .map(|(name, _)| format!("a {kind} has no {name}"))
                .collect()
        };
        let kind = match stat.kind {
            KindIn::Rate => {
                for message in extra(
                    "rate",
                    &[("of", stat.of.is_some()), ("weak", stat.weak.is_some())],
                ) {
                    problem(id, message);
                }
                let (Some(count), Some(class)) = (&stat.count, stat.class) else {
                    problem(id, "a rate has a count and a class".to_owned());
                    continue;
                };
                if stat.street == Street::Showdown {
                    problem(id, "a rate is on a betting street".to_owned());
                }
                let counter = match CustomCounter::parse(count) {
                    Ok(counter) => counter,
                    Err(error) => {
                        problem(id, format!("count: {error}"));
                        continue;
                    }
                };
                let predicate = counter.predicate();
                match predicate.action.as_ref().and_then(action_set) {
                    None => problem(
                        id,
                        "the count's action is exactly a test of action (action = x, action in (x, y))".to_owned(),
                    ),
                    Some(set) => {
                        let want: BTreeSet<Action> = file
                            .action_classes
                            .get(&class)
                            .into_iter()
                            .flatten()
                            .copied()
                            .collect();
                        if set != want {
                            problem(
                                id,
                                format!("the count's action is not class {}", class.as_str()),
                            );
                        }
                    }
                }
                if !pins_street(&predicate.opportunity, stat.street) {
                    problem(
                        id,
                        format!(
                            "the opportunity starts with street = {}",
                            street_name(stat.street)
                        ),
                    );
                }
                if counter.reads_cards() {
                    problem(id, "a rate counts every player: no card fields".to_owned());
                }
                if let Some(coded) = &stat.coded
                    && !shipped.contains_key(coded)
                {
                    problem(id, format!("no shipped statistic {coded}"));
                } else if let Some(coded) = &stat.coded
                    && coded_counters(coded).is_none()
                {
                    problem(id, format!("{coded} is not pct(made, opportunities)"));
                }
                if let Some(within) = &stat.within {
                    match ids.get(within.as_str()) {
                        Some(parent)
                            if matches!(parent.kind, KindIn::Rate)
                                && parent.street == stat.street
                                && parent.class == stat.class
                                && parent.id != stat.id => {}
                        _ => problem(
                            id,
                            format!("within {within}: a rate of the same street and class"),
                        ),
                    }
                }
                StatKind::Rate {
                    count: count.clone(),
                    counter,
                    class,
                    coded: stat.coded.clone(),
                    within: stat.within.clone(),
                }
            }
            KindIn::Share => {
                for message in extra(
                    "share",
                    &[
                        ("count", stat.count.is_some()),
                        ("class", stat.class.is_some()),
                        ("coded", stat.coded.is_some()),
                        ("within", stat.within.is_some()),
                    ],
                ) {
                    problem(id, message);
                }
                let (Some(of), Some(weak)) = (&stat.of, &stat.weak) else {
                    problem(id, "a share has of and weak".to_owned());
                    continue;
                };
                match ids.get(of.as_str()) {
                    Some(parent)
                        if matches!(parent.kind, KindIn::Rate) && parent.street == stat.street => {}
                    _ => problem(id, format!("of {of}: a rate of the same street")),
                }
                if matches!(stat.street, Street::Preflop | Street::Showdown) {
                    problem(id, "a share is postflop: hand classes are".to_owned());
                }
                let mut seen = BTreeSet::new();
                if weak.is_empty() {
                    problem(id, "weak lists at least one hand class".to_owned());
                }
                for class in weak {
                    if !file.hand_classes.iter().any(|known| known.id == *class)
                        || !seen.insert(class.as_str())
                    {
                        problem(id, format!("weak: {class} is not a hand class, or twice"));
                    }
                }
                StatKind::Share {
                    of: of.clone(),
                    weak: weak.clone(),
                }
            }
            KindIn::Coded => {
                for message in extra(
                    "coded stat",
                    &[
                        ("count", stat.count.is_some()),
                        ("class", stat.class.is_some()),
                        ("within", stat.within.is_some()),
                        ("of", stat.of.is_some()),
                        ("weak", stat.weak.is_some()),
                    ],
                ) {
                    problem(id, message);
                }
                let Some(coded) = &stat.coded else {
                    problem(id, "a coded stat names its shipped statistic".to_owned());
                    continue;
                };
                if !shipped.contains_key(coded) {
                    problem(id, format!("no shipped statistic {coded}"));
                }
                StatKind::Coded {
                    coded: coded.clone(),
                }
            }
        };
        stats.push(CatalogueStat {
            id: stat.id.clone(),
            kind,
            street: stat.street,
            group: stat.group.clone(),
            family: stat.family.clone(),
            label: stat.label.clone(),
            sub: stat.sub.clone(),
            words: stat.words.clone(),
            sample_min: stat.sample.min,
            band_floor: stat.band.floor,
        });
    }
    for group in &file.groups {
        if !file.stats.iter().any(|stat| stat.group == group.id) {
            problem(&group.id, "a group no stat is in".to_owned());
        }
    }
    for family in &file.families {
        if !file.stats.iter().any(|stat| stat.family == *family) {
            problem(family, "a family no stat is in".to_owned());
        }
    }
    if file.stats.is_empty() {
        problem("stats", "at least one".to_owned());
    }
    if !problems.is_empty() {
        return Err(CatalogueError::Invalid(problems));
    }
    Ok(Catalogue {
        action_classes: file.action_classes,
        hand_classes: file.hand_classes,
        size_buckets: file.size_buckets,
        groups: file.groups,
        families: file.families,
        stats,
    })
}

/// [`SHIPPED_ANALYTICS`], loaded once. The shipped file is valid
/// (`tests/analytics.rs`); a build where it is not panics here.
pub fn catalogue() -> &'static Catalogue {
    static SHIPPED: OnceLock<Catalogue> = OnceLock::new();
    SHIPPED.get_or_init(|| {
        load_catalogue(SHIPPED_ANALYTICS).expect("config/stats/analytics.json is valid")
    })
}

/* ------------------------------------------------------------- counting - */

impl Catalogue {
    /// The stat with this id, and its index.
    pub fn get(&self, id: &str) -> Option<(usize, &CatalogueStat)> {
        self.stats
            .iter()
            .enumerate()
            .find(|(_, stat)| stat.id == id)
    }

    /// The actions of a class.
    pub fn actions(&self, class: ActionClass) -> &[Action] {
        self.action_classes.get(&class).map_or(&[], Vec::as_slice)
    }

    /// Whether `action` (`"fold"`, ...) is in the class: the decision's
    /// chosen option, or an option the target sums.
    pub fn in_class(&self, class: ActionClass, action: &str) -> bool {
        Action::from_name(action).is_some_and(|action| self.actions(class).contains(&action))
    }

    /// The hand class of a postflop decision from its analysis facts
    /// (`facts.made.class`, `facts.draws`); `None` without a made hand
    /// (preflop, or no cards).
    pub fn hand_class(&self, made: Option<&str>, draws: &[&str]) -> Option<&HandClass> {
        let made = made?;
        self.hand_classes
            .iter()
            .find(|class| class.matches(made, draws))
    }

    /// The size bucket of a bet of `facing_pot` (a fraction of the pot
    /// before it, `facts.facingPot`): the last whose `min` the size, in
    /// thousandths rounded half away from zero, reaches. `None` for no bet
    /// (absent, zero or negative).
    #[allow(clippy::float_arithmetic)] // the analysis' sizes are fractions of the pot
    pub fn size_bucket(&self, facing_pot: Option<f64>) -> Option<&SizeBucket> {
        let pot = facing_pot.filter(|pot| pot.is_finite() && *pot > 0.0)?;
        let thousandths = (pot * 1000.0).round();
        self.size_buckets
            .iter()
            .rev()
            .find(|bucket| thousandths >= f64::from(bucket.min))
    }

    /// One seat's `(made, opportunities)` of every stat, index-aligned with
    /// [`Self::stats`]; zero for a share or a coded stat.
    pub fn counts(&self, hand: &HandEvents, seat: &SeatEvents) -> Vec<Counts> {
        self.stats
            .iter()
            .map(|stat| {
                stat.counter()
                    .map_or_else(Counts::default, |counter| counter.count(hand, seat))
            })
            .collect()
    }

    /// Every decision of the hand that belongs to a rate, in decision
    /// order, with whether it took the rate's action (module docs).
    pub fn membership(&self, hand: &HandEvents) -> Vec<DecisionMembership> {
        let mut by_order: BTreeMap<usize, DecisionMembership> = BTreeMap::new();
        for seat in &hand.seats {
            for (index, stat) in self.stats.iter().enumerate() {
                let Some(counter) = stat.counter() else {
                    continue;
                };
                for (event, taken) in counter.members(hand, seat) {
                    by_order
                        .entry(event.order)
                        .or_insert_with(|| DecisionMembership {
                            order: event.order,
                            seat: seat.seat,
                            stats: Vec::new(),
                        })
                        .stats
                        .push((index, taken));
                }
            }
        }
        by_order.into_values().collect()
    }

    /// The rates as the membership reads them, one `id|class|count` line
    /// each: what [`MEMBERSHIP_VERSION`] stands for.
    pub fn membership_fingerprint(&self) -> String {
        self.stats
            .iter()
            .filter_map(|stat| match &stat.kind {
                StatKind::Rate { count, class, .. } => {
                    Some(format!("{}|{}|{count}\n", stat.id, class.as_str()))
                }
                _ => None,
            })
            .collect()
    }

    /// What a stored checker row reads besides the rates (Step 2): the
    /// hand classes (`id|made|draws`) and the size buckets (`id|min`), one
    /// line each. Pinned with [`MEMBERSHIP_VERSION`] by a test, so a change
    /// here bumps the version and the stored rows are derived again.
    pub fn rows_fingerprint(&self) -> String {
        let classes = self.hand_classes.iter().map(|class| {
            let list = |items: &Option<Vec<String>>| {
                items
                    .as_ref()
                    .map_or_else(|| "*".to_owned(), |l| l.join(","))
            };
            format!(
                "class|{}|{}|{}\n",
                class.id,
                list(&class.made),
                list(&class.draws)
            )
        });
        let buckets = self
            .size_buckets
            .iter()
            .map(|bucket| format!("size|{}|{}\n", bucket.id, bucket.min));
        classes.chain(buckets).collect()
    }

    /// Every rate as a user's custom statistic (`an_<id>`, its rate as the
    /// formula), for [`crate::custom::CustomSet`] and the store's background
    /// count: the same predicates count every kept seat into
    /// `custom_player_rollups`.
    pub fn custom_defs(&self) -> Vec<CustomDef> {
        self.stats
            .iter()
            .filter_map(|stat| {
                let StatKind::Rate { count, .. } = &stat.kind else {
                    return None;
                };
                let id = stat.counter_id();
                let description = stat.sub.clone().unwrap_or_else(|| stat.label.clone());
                Some(CustomDef {
                    def: StatDef {
                        formula: default_formula(&id),
                        id,
                        group: if stat.street == Street::Preflop {
                            StatGroup::Preflop
                        } else {
                            StatGroup::Postflop
                        },
                        players: Players::Any,
                        label: stat.label.clone(),
                        name: stat.label.clone(),
                        description,
                        format: Format {
                            unit: Unit::Percent,
                            decimals: 1,
                        },
                        sample: SampleDef {
                            of: None,
                            min: u64::from(stat.sample_min),
                        },
                        bands: Vec::new(),
                        hud: HudPlace::None,
                    },
                    predicate: Some(count.clone()),
                })
            })
            .collect()
    }
}
