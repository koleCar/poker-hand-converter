//! Custom statistics (docs/RAIL-PLAN.md R2.10, amendment A11;
//! docs/STATS-SPEC.md §14): a user's own counter over decision events
//! ([`crate::events`]) and a user's own displayed statistic.
//!
//! - **A counter** is a predicate (`rail_config::stats::predicate`): an
//!   opportunity filter and an action filter over a seat's
//!   [`DecisionEvent`]s, with a mode - `first`, `any` (once per hand, as the
//!   coded preflop counters count) or `each`. [`CustomCounter::count`] gives
//!   a seat's `(made, opportunities)` in one hand. The fields it can read are
//!   [`FIELDS`]; [`EVENTS_VERSION`] changes when one of them changes
//!   meaning.
//! - **A statistic** ([`CustomDef`]) is an R2.4 definition - label, name,
//!   description, formula, format, sample, bands - stored in the user's
//!   store, not in `config/stats/`. With a predicate it has two counters of
//!   its own, `<id>` (made) and `<id>_opp`, which its formula (by default
//!   `pct(<id>, <id>_opp)`) and other custom formulas may read beside the
//!   ninety coded ones. [`CustomSet`] validates and compiles a user's
//!   definitions; [`CustomSet::sums`] puts the counters' sums where the
//!   formulas read them ([`crate::display::Sums::custom`]).
//!
//! Evaluated in Rust only: the desktop app is the consumer. The web would
//! need the events and the predicate evaluator in TypeScript (or the WASM
//! core, R4.1) to show a user's statistic; it does not yet.

use rail_config::stats::predicate::{
    self, Cmp, Cond, FieldDef, FieldKind, Literal, Mode, Predicate, PredicateError, Test,
};
use rail_config::stats::{Expr, Players, Stat, StatDef, StatProblem, Vocabulary, parse_formula};
use rail_core::phf::{ActionType, Position, Street};
use serde::{Deserialize, Serialize};

use crate::display::{DisplayStat, HERO_ONLY_NAMES, Sums, Variable, variable_names};
use crate::events::{DecisionEvent, Facing, HandEvents, SeatEvents};

/// The meaning of the decision events and of every field: stored with the
/// custom counters, which are counted again when it changes.
pub const EVENTS_VERSION: &str = "events/1";

/// The longest id of a statistic with a counter: its `_opp` name must still
/// be an id (64 bytes).
pub const MAX_COUNTER_ID: usize = 60;

const STREETS: [&str; 4] = ["preflop", "flop", "turn", "river"];
const ACTIONS: [&str; 5] = ["fold", "check", "call", "bet", "raise"];
const FACING: [&str; 4] = ["none", "limp", "bet", "raise"];
const POSITIONS: [&str; 10] = [
    "utg", "utg1", "utg2", "mp", "lj", "hj", "co", "btn", "sb", "bb",
];

macro_rules! fields {
    ($($variant:ident => $name:literal : $kind:expr),* $(,)?) => {
        /// A field of the predicate language.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum Field {
            $($variant,)*
        }

        impl Field {
            /// In [`FIELDS`] order.
            pub const ALL: [Field; [$($name,)*].len()] = [$(Field::$variant,)*];
        }

        /// Every field, its name and kind: the vocabulary the parser
        /// checks a predicate against. Index = [`Field::ALL`] index.
        pub const FIELDS: [FieldDef<'static>; [$($name,)*].len()] = [
            $(FieldDef { name: $name, kind: $kind },)*
        ];
    };
}

use FieldKind::{Bool, Choice, Number};

fields! {
    // The hand.
    BombPot => "bomb_pot": Bool,
    Straddle => "straddle": Bool,
    ButtonBlind => "button_blind": Bool,
    Walk => "walk": Bool,
    Dealt => "dealt": Number,
    MaxSeats => "max_seats": Number,
    PreflopRaises => "preflop_raises": Number,
    // The seat.
    Hero => "hero": Bool,
    Position => "position": Choice(&POSITIONS),
    PostedBlind => "posted_blind": Bool,
    BigBlind => "big_blind": Bool,
    PreflopAggressor => "preflop_aggressor": Bool,
    StackBb => "stack_bb": Number,
    EffectiveBb => "effective_bb": Number,
    SawFlop => "saw_flop": Bool,
    SawTurn => "saw_turn": Bool,
    SawRiver => "saw_river": Bool,
    Showdown => "showdown": Bool,
    Won => "won": Bool,
    // The decision.
    Street => "street": Choice(&STREETS),
    Action => "action": Choice(&ACTIONS),
    AllIn => "all_in": Bool,
    Facing => "facing": Choice(&FACING),
    RaiseLevel => "raise_level": Number,
    Limpers => "limpers": Number,
    Callers => "callers": Number,
    FirstOnStreet => "first_on_street": Bool,
    FirstAtLevel => "first_at_level": Bool,
    CheckedBefore => "checked_before": Bool,
    OwnRaise => "own_raise": Number,
    FacingSteal => "facing_steal": Bool,
    FacingCbet => "facing_cbet": Bool,
    Barrels => "barrels": Number,
    Initiative => "initiative": Bool,
    AheadOfAggressor => "ahead_of_aggressor": Bool,
    InPosition => "in_position": Bool,
    Players => "players": Number,
    Multiway => "multiway": Bool,
    PotBb => "pot_bb": Number,
    SizeBb => "size_bb": Number,
    SizePot => "size_pot": Number,
    FacingSizePot => "facing_size_pot": Number,
}

/// A field's value for one event; `None` fails every test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Val {
    None,
    Bool(bool),
    /// Thousandths.
    Num(i64),
    Choice(usize),
}

fn num(n: u32) -> Val {
    Val::Num(i64::from(n) * 1000)
}

fn opt(value: Option<i64>) -> Val {
    value.map_or(Val::None, Val::Num)
}

fn position_index(position: Position) -> usize {
    match position {
        Position::Utg => 0,
        Position::Utg1 => 1,
        Position::Utg2 => 2,
        Position::Mp => 3,
        Position::Lj => 4,
        Position::Hj => 5,
        Position::Co => 6,
        Position::Btn => 7,
        Position::Sb => 8,
        Position::Bb => 9,
    }
}

fn value(field: Field, hand: &HandEvents, seat: &SeatEvents, event: &DecisionEvent) -> Val {
    use Field as F;
    match field {
        F::BombPot => Val::Bool(hand.bomb_pot),
        F::Straddle => Val::Bool(hand.straddle),
        F::ButtonBlind => Val::Bool(hand.button_blind),
        F::Walk => Val::Bool(hand.walk),
        F::Dealt => num(hand.dealt),
        F::MaxSeats => num(hand.max_seats),
        F::PreflopRaises => num(hand.preflop_raises),
        F::Hero => Val::Bool(seat.hero),
        F::Position => seat
            .position
            .map_or(Val::None, |position| Val::Choice(position_index(position))),
        F::PostedBlind => Val::Bool(seat.posted_blind),
        F::BigBlind => Val::Bool(seat.big_blind),
        F::PreflopAggressor => Val::Bool(seat.preflop_aggressor),
        F::StackBb => opt(seat.stack_bb),
        F::EffectiveBb => opt(seat.effective_bb),
        F::SawFlop => Val::Bool(seat.saw_flop),
        F::SawTurn => Val::Bool(seat.saw_turn),
        F::SawRiver => Val::Bool(seat.saw_river),
        F::Showdown => Val::Bool(seat.showdown),
        F::Won => Val::Bool(seat.won),
        F::Street => match event.street {
            Street::Preflop => Val::Choice(0),
            Street::Flop => Val::Choice(1),
            Street::Turn => Val::Choice(2),
            Street::River => Val::Choice(3),
            Street::Showdown => Val::None,
        },
        F::Action => match event.action {
            ActionType::Fold => Val::Choice(0),
            ActionType::Check => Val::Choice(1),
            ActionType::Call => Val::Choice(2),
            ActionType::Bet => Val::Choice(3),
            ActionType::Raise => Val::Choice(4),
            _ => Val::None,
        },
        F::AllIn => Val::Bool(event.all_in),
        F::Facing => Val::Choice(match event.facing {
            Facing::None => 0,
            Facing::Limp => 1,
            Facing::Bet => 2,
            Facing::Raise => 3,
        }),
        F::RaiseLevel => num(event.raise_level),
        F::Limpers => num(event.limpers),
        F::Callers => num(event.callers),
        F::FirstOnStreet => Val::Bool(event.first_on_street),
        F::FirstAtLevel => Val::Bool(event.first_at_level),
        F::CheckedBefore => Val::Bool(event.checked_before),
        F::OwnRaise => num(event.own_raise),
        F::FacingSteal => Val::Bool(event.facing_steal),
        F::FacingCbet => Val::Bool(event.facing_cbet),
        F::Barrels => num(event.barrels),
        F::Initiative => Val::Bool(event.initiative),
        F::AheadOfAggressor => Val::Bool(event.ahead_of_aggressor),
        F::InPosition => event.in_position.map_or(Val::None, Val::Bool),
        F::Players => num(event.players),
        F::Multiway => Val::Bool(event.players >= 3),
        F::PotBb => opt(event.pot_bb),
        F::SizeBb => opt(event.size_bb),
        F::SizePot => opt(event.size_pot),
        F::FacingSizePot => opt(event.facing_size_pot),
    }
}

fn matches_literal(value: Val, cmp: Cmp, literal: Literal) -> bool {
    match (value, literal) {
        (Val::Bool(a), Literal::Bool(b)) => matches!(cmp, Cmp::Eq | Cmp::Ne) && cmp.holds(&a, &b),
        (Val::Num(a), Literal::Number(b)) => cmp.holds(&a, &b),
        (Val::Choice(a), Literal::Choice(b)) => {
            matches!(cmp, Cmp::Eq | Cmp::Ne) && cmp.holds(&a, &b)
        }
        _ => false,
    }
}

fn holds(cond: &Cond, hand: &HandEvents, seat: &SeatEvents, event: &DecisionEvent) -> bool {
    match cond {
        Cond::Test { field, test } => {
            let Some(field) = Field::ALL.get(*field).copied() else {
                return false;
            };
            let value = value(field, hand, seat, event);
            match test {
                Test::IsTrue => value == Val::Bool(true),
                Test::Cmp(cmp, literal) => matches_literal(value, *cmp, *literal),
                Test::In(list) => list
                    .iter()
                    .any(|literal| matches_literal(value, Cmp::Eq, *literal)),
            }
        }
        Cond::Not(inner) => !holds(inner, hand, seat, event),
        Cond::And(parts) => parts.iter().all(|part| holds(part, hand, seat, event)),
        Cond::Or(parts) => parts.iter().any(|part| holds(part, hand, seat, event)),
    }
}

/// A seat's counts in one hand.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub made: u32,
    pub opp: u32,
}

/// A user's counter, parsed against [`FIELDS`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomCounter(Predicate);

impl CustomCounter {
    /// Parse a predicate (errors with byte offsets for an editor).
    pub fn parse(text: &str) -> Result<Self, PredicateError> {
        predicate::parse(text, &FIELDS).map(Self)
    }

    /// The mode.
    pub fn mode(&self) -> Mode {
        self.0.mode
    }

    /// One seat's `(made, opportunities)` in one hand.
    pub fn count(&self, hand: &HandEvents, seat: &SeatEvents) -> Counts {
        let Predicate {
            mode,
            opportunity,
            action,
        } = &self.0;
        let made = |event: &DecisionEvent| {
            action
                .as_ref()
                .is_none_or(|action| holds(action, hand, seat, event))
        };
        let mut counts = Counts::default();
        for event in &seat.events {
            if !holds(opportunity, hand, seat, event) {
                continue;
            }
            match mode {
                Mode::First => {
                    return Counts {
                        made: u32::from(made(event)),
                        opp: 1,
                    };
                }
                Mode::Any => {
                    counts.opp = 1;
                    if made(event) {
                        counts.made = 1;
                        break;
                    }
                }
                Mode::Each => {
                    counts.opp += 1;
                    counts.made += u32::from(made(event));
                }
            }
        }
        counts
    }

    /// Every seat's counts, in the hand's seat order.
    pub fn count_hand(&self, hand: &HandEvents) -> Vec<Counts> {
        hand.seats
            .iter()
            .map(|seat| self.count(hand, seat))
            .collect()
    }
}

/* ------------------------------------------------------- the statistics - */

/// A user's statistic as the store keeps it and the editor edits it: an
/// R2.4 definition and, optionally, the predicate of its own counter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomDef {
    pub def: StatDef,
    /// `None`: a formula over the existing counters only.
    pub predicate: Option<String>,
}

impl CustomDef {
    /// The names of its counters, `(made, opportunities)`, when it has a
    /// predicate.
    pub fn counter_names(&self) -> Option<(String, String)> {
        self.predicate
            .as_ref()
            .map(|_| (self.def.id.clone(), format!("{}_opp", self.def.id)))
    }
}

/// Which part of a definition a problem is in, for the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Id,
    Predicate,
    Formula,
    Sample,
    Other,
}

/// One thing wrong with a user's definition; `offset` and `length` (bytes)
/// when it is about a span of the predicate or a formula.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProblem {
    pub part: Part,
    pub offset: Option<usize>,
    pub length: Option<usize>,
    pub message: String,
}

impl CustomProblem {
    fn new(part: Part, message: String) -> Self {
        Self {
            part,
            offset: None,
            length: None,
            message,
        }
    }

    fn at(part: Part, offset: usize, length: usize, message: String) -> Self {
        Self {
            part,
            offset: Some(offset),
            length: Some(length),
            message,
        }
    }
}

/// Byte spans of `name` as a whole word in a formula.
fn word_spans(text: &str, name: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_';
    text.match_indices(name)
        .map(|(at, _)| at)
        .filter(|&at| {
            (at == 0 || !word(bytes[at - 1]))
                && bytes.get(at + name.len()).is_none_or(|&b| !word(b))
        })
        .collect()
}

/// The problems of a formula: where it does not parse, or names an input
/// nobody binds.
fn formula_problems(part: Part, text: &str, names: &[&str]) -> Vec<CustomProblem> {
    match parse_formula(text) {
        Err(error) => {
            let length = text[error.offset.min(text.len())..]
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                .count()
                .max(usize::from(error.offset < text.len()));
            vec![CustomProblem::at(part, error.offset, length, error.message)]
        }
        Ok(expr) => {
            let mut out = Vec::new();
            let mut seen: Vec<&str> = Vec::new();
            for name in expr.names() {
                if names.contains(&name) || seen.contains(&name) {
                    continue;
                }
                seen.push(name);
                let message = format!("{name} is not a counter");
                match word_spans(text, name).first() {
                    Some(&at) => out.push(CustomProblem::at(part, at, name.len(), message)),
                    None => out.push(CustomProblem::new(part, message)),
                }
            }
            out
        }
    }
}

/// One compiled statistic of a [`CustomSet`].
#[derive(Debug, Clone, PartialEq)]
pub struct CustomStat {
    pub def: CustomDef,
    /// Its counter, when it has a predicate.
    pub counter: Option<CustomCounter>,
    /// Where its counter's made and opportunities go in [`Sums::custom`]
    /// (`slot`, `slot + 1`).
    pub slot: Option<usize>,
    pub display: DisplayStat,
    /// The custom counter names its formulas read by index
    /// ([`Variable::Custom`]): fill [`Sums::custom`] with [`custom_sums`].
    pub names: Vec<String>,
}

impl CustomStat {
    /// Whether its formula or sample reads a custom counter (its own or
    /// another statistic's): without one it is a function of the coded
    /// counters alone.
    pub fn reads_custom(&self) -> bool {
        let def = &self.def.def;
        [Some(def.formula.as_str()), def.sample.of.as_deref()]
            .into_iter()
            .flatten()
            .any(|text| {
                parse_formula(text).is_ok_and(|expr| {
                    expr.names()
                        .iter()
                        .any(|name| self.names.iter().any(|custom| custom == name))
                })
            })
    }
}

/// A user's statistics, validated and compiled, in their order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CustomSet {
    pub stats: Vec<CustomStat>,
    /// The custom counter names, index = [`Sums::custom`] index.
    names: Vec<String>,
}

impl CustomSet {
    /// Compile `defs` (already saved, so valid when this build saved them).
    /// A definition that no longer compiles (a field or counter this build
    /// does not have) is left out and reported.
    pub fn compile(defs: &[CustomDef]) -> (Self, Vec<(String, Vec<CustomProblem>)>) {
        let mut set = Self::default();
        let mut refused = Vec::new();
        // Every counter name first: a formula may read a later definition's.
        for def in defs {
            if let Some((made, opp)) = def.counter_names()
                && CustomCounter::parse(def.predicate.as_deref().unwrap_or("")).is_ok()
            {
                set.names.push(made);
                set.names.push(opp);
            }
        }
        for def in defs {
            match set.check(def) {
                Ok(stat) => set.stats.push(stat),
                Err(problems) => refused.push((def.def.id.clone(), problems)),
            }
        }
        (set, refused)
    }

    /// The statistic with this id.
    pub fn get(&self, id: &str) -> Option<&CustomStat> {
        self.stats.iter().find(|stat| stat.def.def.id == id)
    }

    /// The custom counter names, in [`Sums::custom`] order.
    pub fn counter_names(&self) -> &[String] {
        &self.names
    }

    /// The statistics with a counter, and their slots.
    pub fn counters(&self) -> impl Iterator<Item = (&CustomStat, &CustomCounter, usize)> {
        self.stats
            .iter()
            .filter_map(|stat| Some((stat, stat.counter.as_ref()?, stat.slot?)))
    }

    /// `base` with the custom counters' sums put where this set's formulas
    /// read them: `counts(id)` is the `(made, opportunities)` of the
    /// statistic `id`.
    pub fn sums(&self, base: &Sums, counts: impl Fn(&str) -> Option<(i64, i64)>) -> Sums {
        custom_sums(&self.names, base, counts)
    }

    /// Validate a draft as it would be saved: replacing the statistic
    /// `replacing` (its old id) or new. The editor's check; errors carry
    /// offsets into the predicate and formulas.
    pub fn validate(
        &self,
        draft: &CustomDef,
        replacing: Option<&str>,
        shipped_ids: &[&str],
    ) -> Result<CustomStat, Vec<CustomProblem>> {
        let mut names = self.names.clone();
        // The draft's own counters: the old ones out, the new ones in.
        if let Some(old) = replacing.and_then(|id| self.get(id))
            && let Some((made, opp)) = old.def.counter_names()
        {
            names.retain(|name| *name != made && *name != opp);
        }
        let mut scratch = Self {
            stats: Vec::new(),
            names,
        };
        if let Some((made, opp)) = draft.counter_names() {
            scratch.names.push(made);
            scratch.names.push(opp);
        }
        let mut problems = Vec::new();
        let id = &draft.def.id;
        let taken = shipped_ids.contains(&id.as_str())
            || variable_names().contains(&id.as_str())
            || self
                .stats
                .iter()
                .any(|stat| stat.def.def.id == *id && Some(id.as_str()) != replacing)
            || self.names.iter().any(|name| {
                name == id
                    && !replacing
                        .and_then(|old| self.get(old))
                        .and_then(|old| old.def.counter_names())
                        .is_some_and(|(made, opp)| *name == made || *name == opp)
            });
        if taken {
            problems.push(CustomProblem::new(
                Part::Id,
                format!("{id} is already the name of a statistic or a counter"),
            ));
        }
        if let Some((_, opp)) = draft.counter_names() {
            let base = variable_names();
            if id.len() > MAX_COUNTER_ID {
                problems.push(CustomProblem::new(
                    Part::Id,
                    format!("an id with a counter has at most {MAX_COUNTER_ID} characters"),
                ));
            } else if base.contains(&opp.as_str())
                || self.stats.iter().any(|stat| {
                    stat.def.def.id == opp && Some(stat.def.def.id.as_str()) != replacing
                })
            {
                problems.push(CustomProblem::new(
                    Part::Id,
                    format!("{opp} is already the name of a counter"),
                ));
            }
        }
        if let Some(old) = replacing
            && old != id
            && let Some(user) = self.reader_of(old)
        {
            problems.push(CustomProblem::new(
                Part::Id,
                format!("{user} reads this statistic's counters; change it first"),
            ));
        }
        match scratch.check(draft) {
            Ok(stat) if problems.is_empty() => Ok(stat),
            Ok(_) => Err(problems),
            Err(more) => {
                problems.extend(more);
                Err(problems)
            }
        }
    }

    /// Another statistic whose formula reads `id`'s counters, if any (what
    /// stops a delete or a rename).
    pub fn reader_of(&self, id: &str) -> Option<String> {
        let (made, opp) = self.get(id)?.def.counter_names()?;
        self.stats
            .iter()
            .filter(|stat| stat.def.def.id != id)
            .find(|stat| {
                let texts = [
                    Some(stat.def.def.formula.as_str()),
                    stat.def.def.sample.of.as_deref(),
                ];
                texts.into_iter().flatten().any(|text| {
                    parse_formula(text)
                        .map(|expr| expr.names().iter().any(|n| *n == made || *n == opp))
                        .unwrap_or(false)
                })
            })
            .map(|stat| stat.def.def.id.clone())
    }

    /// The checks of one definition against this set's names; on success
    /// the compiled statistic, its slot taken from the names.
    fn check(&self, draft: &CustomDef) -> Result<CustomStat, Vec<CustomProblem>> {
        let mut problems = Vec::new();
        let counter = match draft.predicate.as_deref() {
            None => None,
            Some(text) => match CustomCounter::parse(text) {
                Ok(counter) => Some(counter),
                Err(error) => {
                    problems.push(CustomProblem::at(
                        Part::Predicate,
                        error.offset,
                        error.length,
                        error.message,
                    ));
                    None
                }
            },
        };
        let base = variable_names();
        let mut names: Vec<&str> = base.clone();
        names.extend(self.names.iter().map(String::as_str));
        problems.extend(formula_problems(Part::Formula, &draft.def.formula, &names));
        if let Some(of) = &draft.def.sample.of {
            problems.extend(formula_problems(Part::Sample, of, &names));
        }
        let mut def = draft.def.clone();
        // A formula that reads the hero's all-in EV is the hero's.
        let hero_only = parse_formula(&def.formula)
            .map(|expr| expr.names().iter().any(|n| HERO_ONLY_NAMES.contains(n)))
            .unwrap_or(false);
        def.players = if hero_only {
            Players::Hero
        } else {
            Players::Any
        };
        if !problems.is_empty() {
            return Err(problems);
        }
        let vocabulary = Vocabulary {
            names: &names,
            hero_only: &HERO_ONLY_NAMES,
        };
        let stat: Stat = rail_config::stats::check_definition(def, vocabulary).map_err(
            |problems: Vec<StatProblem>| {
                problems
                    .into_iter()
                    .map(|problem| {
                        let part = if problem.message.contains("sample") {
                            Part::Sample
                        } else if problem.message.starts_with("id ") {
                            Part::Id
                        } else {
                            Part::Other
                        };
                        CustomProblem::new(part, problem.message)
                    })
                    .collect::<Vec<_>>()
            },
        )?;
        let resolve = |name: &str| {
            Variable::from_name(name).or_else(|| {
                self.names
                    .iter()
                    .position(|candidate| candidate == name)
                    .and_then(|index| u32::try_from(index).ok())
                    .map(Variable::Custom)
            })
        };
        let display = DisplayStat::compile_with(&stat, &resolve).ok_or_else(|| {
            vec![CustomProblem::new(
                Part::Formula,
                "the formula names an input this build does not bind".to_owned(),
            )]
        })?;
        let slot = draft
            .counter_names()
            .and_then(|(made, _)| self.names.iter().position(|name| *name == made));
        Ok(CustomStat {
            def: CustomDef {
                def: stat.def,
                predicate: draft.predicate.clone(),
            },
            counter,
            slot,
            display,
            names: self.names.clone(),
        })
    }
}

/// `base` with [`Sums::custom`] filled for `names` (a [`CustomStat`]'s):
/// `<id>` is the made count of statistic `id`, `<id>_opp` its
/// opportunities, from `counts(id)`; a counter nobody counted is 0.
pub fn custom_sums(
    names: &[String],
    base: &Sums,
    counts: impl Fn(&str) -> Option<(i64, i64)>,
) -> Sums {
    let mut sums = base.clone();
    sums.custom = names
        .iter()
        .map(|name| {
            if let Some((made, _)) = counts(name) {
                return made;
            }
            name.strip_suffix("_opp")
                .and_then(&counts)
                .map_or(0, |(_, opp)| opp)
        })
        .collect();
    sums
}

/// The default formula of a statistic with a counter: its rate.
pub fn default_formula(id: &str) -> String {
    format!("pct({id}, {id}_opp)")
}

/// `true` when `expr` is exactly `pct(<id>, <id>_opp)`.
pub fn is_default_formula(expr: &Expr, id: &str) -> bool {
    matches!(expr, Expr::Pct(made, opp)
        if **made == Expr::Name(id.to_owned()) && **opp == Expr::Name(format!("{id}_opp")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_field_is_named_once_and_is_not_a_keyword() {
        let mut names: Vec<&str> = FIELDS.iter().map(|f| f.name).collect();
        assert_eq!(names.len(), Field::ALL.len());
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), FIELDS.len());
        for name in names {
            assert!(!predicate::KEYWORDS.contains(&name), "{name}");
        }
    }

    use rail_config::stats::{Format, Group, HudPlace, SampleDef, Text, Unit};
    use rail_core::js::JsNumber;

    fn words(value: &str) -> Text {
        Text {
            en: value.to_owned(),
            hr: value.to_owned(),
        }
    }

    fn def(id: &str, predicate: Option<&str>, formula: &str) -> CustomDef {
        CustomDef {
            def: StatDef {
                id: id.to_owned(),
                group: Group::Postflop,
                players: Players::Any,
                label: words("L"),
                name: words("N"),
                description: words("D"),
                formula: formula.to_owned(),
                format: Format {
                    unit: Unit::Percent,
                    decimals: 1,
                },
                sample: SampleDef { of: None, min: 10 },
                bands: Vec::new(),
                hud: HudPlace::None,
            },
            predicate: predicate.map(str::to_owned),
        }
    }

    const SHIPPED: [&str; 2] = ["vpip", "cbet_flop"];
    const FOLD: &str = "first street = flop and facing_cbet => action = fold";

    fn spans(problems: &[CustomProblem]) -> Vec<(Part, Option<usize>, Option<usize>)> {
        problems
            .iter()
            .map(|p| (p.part, p.offset, p.length))
            .collect()
    }

    #[test]
    fn a_set_compiles_and_its_formulas_read_each_others_counters() {
        let defs = [
            def("fcb", Some(FOLD), "pct(fcb, fcb_opp)"),
            // Reads another statistic's counters and a coded one.
            def("fcb_share", None, "pct(fcb, fold_to_cbet_flop)"),
            def("ratio", None, "pct(pfr, vpip)"),
        ];
        let (set, refused) = CustomSet::compile(&defs);
        assert!(refused.is_empty(), "{refused:?}");
        assert_eq!(set.counter_names(), ["fcb", "fcb_opp"]);
        let fcb = set.get("fcb").expect("fcb");
        assert!(fcb.counter.is_some() && fcb.reads_custom());
        assert!(set.get("fcb_share").expect("share").reads_custom());
        assert!(!set.get("ratio").expect("ratio").reads_custom());
        let mut base = Sums::default();
        base.counters[crate::Counter::fold_to_cbet_flop.index()] = 40;
        let counts = |id: &str| (id == "fcb").then_some((30, 120));
        let sums = set.sums(&base, counts);
        assert_eq!(sums.custom, [30, 120]);
        assert_eq!(
            fcb.display
                .value(&sums)
                .map(JsNumber::to_js_string)
                .as_deref(),
            Some("25")
        );
        let share = set.get("fcb_share").expect("share");
        assert_eq!(
            share
                .display
                .value(&custom_sums(&share.names, &base, counts))
                .map(JsNumber::to_js_string)
                .as_deref(),
            Some("75")
        );
        assert_eq!(set.reader_of("fcb").as_deref(), Some("fcb_share"));
        assert_eq!(set.reader_of("ratio"), None);
    }

    #[test]
    fn validation_says_what_and_where() {
        let (set, _) = CustomSet::compile(&[def("fcb", Some(FOLD), "pct(fcb, fcb_opp)")]);
        let check = |d: CustomDef, replacing: Option<&str>| {
            set.validate(&d, replacing, &SHIPPED)
                .err()
                .unwrap_or_default()
        };
        // The predicate's own error, with its span.
        let problems = check(def("x", Some("first street = flp"), "pct(x, x_opp)"), None);
        assert_eq!(spans(&problems), [(Part::Predicate, Some(15), Some(3))]);
        // A formula's unknown name, at its place.
        let problems = check(def("y", None, "pct(vpip, vpipp)"), None);
        assert_eq!(spans(&problems), [(Part::Formula, Some(10), Some(5))]);
        assert_eq!(problems[0].message, "vpipp is not a counter");
        // A formula that does not parse.
        let problems = check(def("y", None, "pct(vpip,"), None);
        assert_eq!(spans(&problems), [(Part::Formula, Some(9), Some(0))]);
        // Ids: a shipped one, a counter, another statistic, a counter of one.
        for taken in ["vpip", "three_bet_opp", "fcb", "fcb_opp"] {
            let problems = check(def(taken, None, "pct(pfr, vpip)"), None);
            assert_eq!(problems[0].part, Part::Id, "{taken}");
        }
        // A counter whose `_opp` name is taken.
        let problems = check(
            def("three_bet", Some(FOLD), "pct(three_bet, three_bet_opp)"),
            None,
        );
        assert!(problems.iter().any(|p| p.part == Part::Id));
        // An id that is not one.
        let problems = check(def("Bad id", None, "pct(pfr, vpip)"), None);
        assert_eq!(problems[0].part, Part::Id);
        // The sample a non-rate needs.
        let problems = check(def("z", None, "pfr / vpip"), None);
        assert_eq!(problems[0].part, Part::Sample);
        // Saving it again under its own id is fine, renaming it too.
        assert!(
            set.validate(
                &def("fcb", Some(FOLD), "pct(fcb, fcb_opp)"),
                Some("fcb"),
                &SHIPPED
            )
            .is_ok()
        );
        let renamed = set
            .validate(
                &def("fcb2", Some(FOLD), "pct(fcb2, fcb2_opp)"),
                Some("fcb"),
                &SHIPPED,
            )
            .expect("rename");
        assert_eq!(renamed.names, ["fcb2", "fcb2_opp"]);
        // A formula reading the hero's all-in EV is the hero's.
        let mut ev = def("ev", None, "ev_net_bb_milli / money_hands");
        ev.def.sample.of = Some("money_hands".to_owned());
        let stat = set.validate(&ev, None, &SHIPPED).expect("valid");
        assert_eq!(stat.def.def.players, Players::Hero);
    }

    #[test]
    fn a_rename_is_refused_while_another_formula_reads_the_counters() {
        let (set, _) = CustomSet::compile(&[
            def("fcb", Some(FOLD), "pct(fcb, fcb_opp)"),
            def("share", None, "pct(fcb, fold_to_cbet_flop)"),
        ]);
        let problems = set
            .validate(
                &def("fcb2", Some(FOLD), "pct(fcb2, fcb2_opp)"),
                Some("fcb"),
                &SHIPPED,
            )
            .expect_err("read by share");
        assert!(
            problems
                .iter()
                .any(|p| p.message.starts_with("share reads"))
        );
    }

    #[test]
    fn word_spans_are_whole_words() {
        assert_eq!(
            word_spans("vpip + vpip_opp - xvpip + vpip", "vpip"),
            [0, 26]
        );
    }
}
