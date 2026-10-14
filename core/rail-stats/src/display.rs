//! Displayed statistics: the definitions of `config/stats/` evaluated over
//! summed counters (docs/RAIL-PLAN.md R2.4, docs/STATS-SPEC.md §13).
//!
//! `rail_config::stats` parses and validates a definition file against the
//! names this module binds ([`vocabulary`]); [`Display::compile`] turns each
//! formula into a tree over [`Variable`]s and evaluates it over [`Sums`] - a
//! rollup, `hud_totals`, `hero_totals`, or [`aggregate`]d rows.
//!
//! **Arithmetic.** A formula is evaluated as JavaScript evaluates it: every
//! input is a `number` (an IEEE-754 double; sums of counters and money are
//! integers far below 2^53, so exact), every operation is one correctly
//! rounded double operation in the formula's order, done here in
//! [`JsNumber`] (integer arithmetic; the workspace denies float arithmetic).
//! So `pct(three_bet, three_bet_opp)` is `rates.ts`'s `(made * 100) / opp`
//! bit for bit, and the order of operations is part of the definition:
//! `(23 * 100) / 80` is 28.75 and prints "28.8" at one decimal, `(23 / 80) *
//! 100` is 28.749999999999996 and prints "28.7".
//!
//! **Text** ([`format_fixed`]) is what the web's `Intl.NumberFormat` prints
//! with that many minimum and maximum fraction digits: the shortest decimal
//! that reads back as the double (`String(x)`, [`JsNumber::to_js_string`]),
//! rounded half away from zero, a minus sign on any negative value. Not
//! `toFixed`, which rounds the exact binary value: `(-0.15).toFixed(1)` is
//! "-0.1", the web prints "-0.2". `tests/display.rs` holds this module and
//! `frontend/src/lib/stats/display.ts` to the same vectors, and the vectors'
//! generator holds those to `rates.ts` and `Intl`.
//!
//! **No value** (`None`, `null` in TypeScript): a division by zero, `pct`
//! over no opportunities (`opp > 0` fails, as in `rates.ts`), an input the
//! caller does not have (`ev_net_bb_milli` outside the hero's totals), or a
//! result that is not finite.

use rail_config::stats::{
    Definitions, Expr, Op, Stat, StatDef, StatsError, Tone, Unit, Vocabulary, load_stats,
};
use rail_core::js::JsNumber;

use crate::counters::{COUNTER_COUNT, COUNTER_KEYS, Counter, MONEY_KEYS};
use crate::mapping::StatsRow;
use crate::reliability::{Interval, Level, sample_reliability, wilson};

/// How many money columns a row carries ([`MONEY_KEYS`]).
pub const MONEY_COUNT: usize = MONEY_KEYS.len();

/// The inputs a formula can read besides the counters and money columns.
pub const EXTRA_NAMES: [&str; 2] = ["money_hands", "ev_net_bb_milli"];

/// The inputs that exist for the hero's totals only.
pub const HERO_ONLY_NAMES: [&str; 1] = ["ev_net_bb_milli"];

/// Every name a formula may read: [`COUNTER_KEYS`], [`MONEY_KEYS`], then
/// [`EXTRA_NAMES`].
pub fn variable_names() -> Vec<&'static str> {
    COUNTER_KEYS
        .iter()
        .chain(MONEY_KEYS.iter())
        .chain(EXTRA_NAMES.iter())
        .copied()
        .collect()
}

/// One input of a formula.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Variable {
    /// A counter: summed over every counted row.
    Counter(Counter),
    /// A money column ([`MONEY_KEYS`] index): summed over the money rows only.
    Money(usize),
    /// How many hands the money columns are summed over (`moneyHands`):
    /// what bb/100 divides by.
    MoneyHands,
    /// `net_bb_milli` with each evaluated all-in's luck taken out (the
    /// hero's `ev_net_bb_milli` summed over the money rows).
    EvNetBbMilli,
    /// A user's counter (R2.10, [`crate::custom`]): an index into
    /// [`Sums::custom`].
    Custom(u32),
}

impl Variable {
    /// The input with this name.
    pub fn from_name(name: &str) -> Option<Self> {
        if let Some(counter) = Counter::from_name(name) {
            return Some(Self::Counter(counter));
        }
        if let Some(index) = MONEY_KEYS.iter().position(|key| *key == name) {
            return Some(Self::Money(index));
        }
        match name {
            "money_hands" => Some(Self::MoneyHands),
            "ev_net_bb_milli" => Some(Self::EvNetBbMilli),
            _ => None,
        }
    }
}

/// The numbers a formula reads: summed counters and money.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sums {
    /// In [`COUNTER_KEYS`] order.
    pub counters: [i64; COUNTER_COUNT],
    /// In [`MONEY_KEYS`] order, over the money rows only.
    pub money: [i64; MONEY_COUNT],
    /// The rows whose money is in `money` (`aggregate`'s `moneyHands`).
    pub money_hands: i64,
    /// The hero's all-in-EV result over the money rows, thousandths of a big
    /// blind: `money[net_bb_milli]` plus the EV adjustment
    /// (`rail_store::EvAdjust::bb_milli`). `None` when not known (villains,
    /// or a caller that does not read EV).
    pub ev_net_bb_milli: Option<i64>,
    /// A user's counters (R2.10), in the order of the
    /// [`crate::custom::CustomSet`] that reads them; empty for everything
    /// else (a formula naming one then has no value).
    pub custom: Vec<i64>,
}

impl Default for Sums {
    fn default() -> Self {
        Self {
            counters: [0; COUNTER_COUNT],
            money: [0; MONEY_COUNT],
            money_hands: 0,
            ev_net_bb_milli: None,
            custom: Vec::new(),
        }
    }
}

impl Sums {
    /// The value of one input.
    pub fn get(&self, variable: Variable) -> Option<i64> {
        match variable {
            Variable::Counter(counter) => Some(self.counters[counter.index()]),
            Variable::Money(index) => self.money.get(index).copied(),
            Variable::MoneyHands => Some(self.money_hands),
            Variable::EvNetBbMilli => self.ev_net_bb_milli,
            Variable::Custom(index) => self.custom.get(usize::try_from(index).ok()?).copied(),
        }
    }

    /// Add another sum. The EV result stays known only if both know it.
    pub fn add(&mut self, other: &Self) {
        for (sum, value) in self.counters.iter_mut().zip(other.counters) {
            *sum += value;
        }
        for (sum, value) in self.money.iter_mut().zip(other.money) {
            *sum += value;
        }
        self.money_hands += other.money_hands;
        self.ev_net_bb_milli = self
            .ev_net_bb_milli
            .zip(other.ev_net_bb_milli)
            .map(|(a, b)| a + b);
        if self.custom.len() < other.custom.len() {
            self.custom.resize(other.custom.len(), 0);
        }
        for (sum, value) in self.custom.iter_mut().zip(&other.custom) {
            *sum += value;
        }
    }

    /// Add one row: its counters, and its money (and one money hand) when
    /// `money`.
    pub fn add_row(&mut self, row: &StatsRow, money: bool) {
        for (sum, value) in self.counters.iter_mut().zip(row.seat.counters.0) {
            *sum += i64::from(value);
        }
        if money {
            for (sum, (_, value)) in self.money.iter_mut().zip(row.seat.money.columns()) {
                *sum += value;
            }
            self.money_hands += i64::from(row.seat.counters.get(Counter::hands));
        }
    }
}

/// `AggregateOptions` of `rates.ts`; the default is `aggregate`'s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AggregateOptions {
    /// Include bomb pots (default false).
    pub bomb_pots: bool,
    /// Include EV-cashout hands in the money (default false).
    pub cashouts: bool,
    /// Include straddled hands (default true).
    pub straddled: bool,
}

impl Default for AggregateOptions {
    fn default() -> Self {
        Self {
            bomb_pots: false,
            cashouts: false,
            straddled: true,
        }
    }
}

/// `aggregate` of `rates.ts`: rows summed with its exclusions (bomb pots out
/// of everything, EV-cashout hands out of the money, straddled hands kept
/// unless asked). `ev_net_bb_milli` stays `None`.
pub fn aggregate<'a>(
    rows: impl IntoIterator<Item = &'a StatsRow>,
    options: AggregateOptions,
) -> Sums {
    let mut sums = Sums::default();
    for row in rows {
        if !options.bomb_pots && row.hand.is_bomb_pot {
            continue;
        }
        if !options.straddled && row.hand.has_straddle {
            continue;
        }
        sums.add_row(row, options.cashouts || !row.hand.has_cashout);
    }
    sums
}

/// A compiled formula.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Const(JsNumber),
    Var(Variable),
    Neg(Box<Node>),
    Binary(Op, Box<Node>, Box<Node>),
    Pct(Box<Node>, Box<Node>),
    Sum(Vec<Node>),
}

fn finite(value: JsNumber) -> Option<JsNumber> {
    value.is_finite().then_some(value)
}

/// How a compiled formula finds its inputs: [`Variable::from_name`], or a
/// caller's own (R2.10's custom counters).
type Resolve<'r> = &'r dyn Fn(&str) -> Option<Variable>;

impl Node {
    fn compile(expr: &Expr) -> Option<Self> {
        Self::compile_with(expr, &Variable::from_name)
    }

    fn compile_with(expr: &Expr, resolve: Resolve<'_>) -> Option<Self> {
        let compile = |inner: &Expr| Self::compile_with(inner, resolve).map(Box::new);
        Some(match expr {
            Expr::Number(text) => Self::Const(JsNumber::parse(text)),
            Expr::Name(name) => Self::Var(resolve(name)?),
            Expr::Neg(inner) => Self::Neg(compile(inner)?),
            Expr::Binary { op, left, right } => Self::Binary(*op, compile(left)?, compile(right)?),
            Expr::Pct(made, opp) => Self::Pct(compile(made)?, compile(opp)?),
            Expr::Sum(terms) => Self::Sum(
                terms
                    .iter()
                    .map(|term| Self::compile_with(term, resolve))
                    .collect::<Option<_>>()?,
            ),
        })
    }

    fn eval(&self, sums: &Sums) -> Option<JsNumber> {
        match self {
            Self::Const(value) => Some(*value),
            Self::Var(variable) => sums.get(*variable).map(JsNumber::from_i64),
            Self::Neg(inner) => finite(-inner.eval(sums)?),
            Self::Binary(op, left, right) => {
                let (a, b) = (left.eval(sums)?, right.eval(sums)?);
                finite(match op {
                    Op::Add => a + b,
                    Op::Sub => a - b,
                    Op::Mul => a * b,
                    Op::Div if b.strict_equals(JsNumber::ZERO) => return None,
                    Op::Div => a / b,
                })
            }
            Self::Pct(made, opp) => {
                let (made, opp) = (made.eval(sums)?, opp.eval(sums)?);
                if !opp.greater_than(JsNumber::ZERO) {
                    return None;
                }
                finite((made * JsNumber::from_i64(100)) / opp)
            }
            Self::Sum(terms) => {
                let mut terms = terms.iter();
                let mut total = terms.next()?.eval(sums)?;
                for term in terms {
                    total = finite(total + term.eval(sums)?)?;
                }
                Some(total)
            }
        }
    }
}

/// `"999"` + 1 = `"1000"`, on decimal digit strings.
fn increment(digits: &str) -> String {
    let mut out: Vec<u8> = digits.bytes().collect();
    for digit in out.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return String::from_utf8_lossy(&out).into_owned();
        }
    }
    format!("1{}", String::from_utf8_lossy(&out))
}

/// `value` with exactly `decimals` digits after the point, as the web's
/// `Intl.NumberFormat` prints it (`minimumFractionDigits` and
/// `maximumFractionDigits` both `decimals`, no grouping): the shortest
/// round-trip decimal ([`JsNumber::to_js_string`]) rounded half away from
/// zero, in plain notation, with a minus sign whenever the value is negative
/// (-0 included). `formatFixed` in `frontend/src/lib/stats/display.ts`.
pub fn format_fixed(value: JsNumber, decimals: u32) -> String {
    let negative = value.is_sign_negative();
    let shortest = value.abs().to_js_string();
    let (mantissa, exponent) = shortest.split_once('e').unwrap_or((&shortest, "0"));
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let exponent: i64 = exponent.parse().unwrap_or(0);
    // value = digits * 10^(exponent - fraction.len()); shift it by `decimals`.
    let shift = exponent - i64::try_from(fraction.len()).unwrap_or(0) + i64::from(decimals);
    let scaled = if shift >= 0 {
        format!(
            "{digits}{}",
            "0".repeat(usize::try_from(shift).unwrap_or(0))
        )
    } else {
        let drop = usize::try_from(shift.unsigned_abs()).unwrap_or(usize::MAX);
        if drop > digits.len() {
            "0".to_owned()
        } else {
            let cut = digits.len() - drop;
            let kept = if cut == 0 { "0" } else { &digits[..cut] };
            if digits.as_bytes()[cut] >= b'5' {
                increment(kept)
            } else {
                kept.to_owned()
            }
        }
    };
    let trimmed = scaled.trim_start_matches('0');
    let width = usize::try_from(decimals).unwrap_or(0) + 1;
    let padded = format!("{trimmed:0>width$}");
    let text = if decimals == 0 {
        padded
    } else {
        let (int, frac) = padded.split_at(padded.len() - (width - 1));
        format!("{int}.{frac}")
    };
    if negative { format!("-{text}") } else { text }
}

/// One formula, compiled: what an editor previews as the user types (R2.10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formula(Node);

impl Formula {
    /// `None` when the formula names an input this module does not bind.
    pub fn compile(expr: &Expr) -> Option<Self> {
        Node::compile(expr).map(Self)
    }

    /// The value, or `None` (see the module header).
    pub fn eval(&self, sums: &Sums) -> Option<JsNumber> {
        self.0.eval(sums)
    }
}

/// One definition, compiled.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayStat {
    pub def: StatDef,
    value: Node,
    sample: Node,
    rate: Option<(Node, Node)>,
    bands: Vec<(Option<JsNumber>, Tone)>,
}

/// A statistic as shown: its value, text, colour and sample.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    pub value: Option<JsNumber>,
    /// [`format_fixed`]; `None` without a value (and for money without a
    /// currency).
    pub text: Option<String>,
    pub tone: Option<Tone>,
    /// The sample size (`sample.of`, or the `pct`'s opportunities).
    pub sample: Option<JsNumber>,
    /// The sample reaches `sample.min`: shown at full opacity.
    pub full: bool,
    /// [`DisplayStat::reliability`].
    pub reliability: Reliability,
}

/// How far to trust a value (R2.5, [`crate::reliability`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reliability {
    /// [`Level::Ok`] exactly when [`Shown::full`].
    pub level: Level,
    /// 1 from `sample.min`, down to 0.6 with no sample.
    pub opacity: JsNumber,
    /// A rate's 95% Wilson interval in percentage points; `None` for other
    /// statistics.
    pub interval: Option<Interval>,
    /// The bounds as text at the definition's decimals ([`format_fixed`]).
    pub interval_text: Option<(String, String)>,
}

impl DisplayStat {
    fn compile(stat: &Stat) -> Option<Self> {
        Self::compile_with(stat, &Variable::from_name)
    }

    /// Compile a definition whose names `resolve` binds - a user's statistic
    /// (R2.10), whose formula may read its own counters
    /// ([`Variable::Custom`]). `None` when a name does not resolve.
    pub fn compile_with(stat: &Stat, resolve: &dyn Fn(&str) -> Option<Variable>) -> Option<Self> {
        let compile = |expr: &Expr| Node::compile_with(expr, resolve);
        Some(Self {
            def: stat.def.clone(),
            value: compile(&stat.formula)?,
            sample: compile(&stat.sample)?,
            rate: match stat.rate() {
                Some((made, opp)) => Some((compile(made)?, compile(opp)?)),
                None => None,
            },
            bands: stat
                .def
                .bands
                .iter()
                .map(|band| (band.below.map(JsNumber::from_f64), band.tone))
                .collect(),
        })
    }

    /// The definition's id.
    pub fn id(&self) -> &str {
        &self.def.id
    }

    /// The value, or `None` (see the module header).
    pub fn value(&self, sums: &Sums) -> Option<JsNumber> {
        self.value.eval(sums)
    }

    /// `(made, opportunities)` of a `pct(made, opportunities)` definition:
    /// the inputs of a rate's confidence interval (R2.5). `None` for other
    /// formulas or when either has no value.
    pub fn rate(&self, sums: &Sums) -> Option<(JsNumber, JsNumber)> {
        let (made, opp) = self.rate.as_ref()?;
        Some((made.eval(sums)?, opp.eval(sums)?))
    }

    /// The sample size.
    pub fn sample(&self, sums: &Sums) -> Option<JsNumber> {
        self.sample.eval(sums)
    }

    /// Whether the sample reaches `sample.min` (always, when it is 0).
    pub fn full(&self, sums: &Sums) -> bool {
        let min = self.def.sample.min;
        min == 0
            || self
                .sample(sums)
                .is_some_and(|sample| !sample.less_than(JsNumber::from_u64(min)))
    }

    /// The level and opacity of the value's sample against `sample.min`, and
    /// for a `pct(made, opportunities)` its Wilson interval
    /// ([`crate::reliability`]). `statReliability` in `display.ts`.
    pub fn reliability(&self, sums: &Sums) -> Reliability {
        let (level, opacity) = sample_reliability(self.sample(sums), self.def.sample.min);
        let interval = self
            .rate(sums)
            .and_then(|(made, opportunities)| wilson(made, opportunities));
        let decimals = self.def.format.decimals;
        Reliability {
            level,
            opacity,
            interval,
            interval_text: interval.map(|i| {
                (
                    format_fixed(i.low, decimals),
                    format_fixed(i.high, decimals),
                )
            }),
        }
    }

    /// The value as text ([`format_fixed`]); for money, of the value in
    /// major units (`value / 10^minor_units`), and `None` without
    /// `minor_units`.
    pub fn text(&self, value: JsNumber, minor_units: Option<u32>) -> Option<String> {
        let decimals = self.def.format.decimals;
        if self.def.format.unit == Unit::Money {
            let scale = 10_u64.checked_pow(minor_units?)?;
            return Some(format_fixed(value / JsNumber::from_u64(scale), decimals));
        }
        Some(format_fixed(value, decimals))
    }

    /// The colour band the (unrounded) value falls in.
    pub fn tone(&self, value: JsNumber) -> Option<Tone> {
        self.bands
            .iter()
            .find(|(below, _)| below.is_none_or(|below| value.less_than(below)))
            .map(|(_, tone)| *tone)
    }

    /// Everything shown for `sums`.
    pub fn show(&self, sums: &Sums, minor_units: Option<u32>) -> Shown {
        let value = self.value(sums);
        Shown {
            value,
            text: value.and_then(|value| self.text(value, minor_units)),
            tone: value.and_then(|value| self.tone(value)),
            sample: self.sample(sums),
            full: self.full(sums),
            reliability: self.reliability(sums),
        }
    }
}

/// A compiled definition file.
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    pub stats: Vec<DisplayStat>,
}

impl Display {
    /// Compile loaded definitions. `None` when a name is not one of this
    /// module's - which [`load_stats`] with [`vocabulary`] rules out.
    pub fn compile(definitions: &Definitions) -> Option<Self> {
        Some(Self {
            stats: definitions
                .stats
                .iter()
                .map(DisplayStat::compile)
                .collect::<Option<_>>()?,
        })
    }

    /// Load, validate and compile a definition file.
    pub fn load(text: &str) -> Result<Self, StatsError> {
        let names = variable_names();
        let definitions = load_stats(text, vocabulary(&names))?;
        Self::compile(&definitions).ok_or_else(|| {
            StatsError::Invalid(vec![rail_config::stats::StatProblem {
                stat: None,
                message: "a formula names an input this build does not bind".to_owned(),
            }])
        })
    }

    /// The shipped definitions (`config/stats/standard.json`).
    pub fn shipped() -> Result<Self, StatsError> {
        Self::load(rail_config::stats::SHIPPED_STATS)
    }

    /// The definition with this id.
    pub fn get(&self, id: &str) -> Option<&DisplayStat> {
        self.stats.iter().find(|stat| stat.id() == id)
    }
}

/// The [`Vocabulary`] for `rail_config::stats::load_stats`, over
/// `names` = [`variable_names`].
pub fn vocabulary<'a>(names: &'a [&'a str]) -> Vocabulary<'a> {
    Vocabulary {
        names,
        hero_only: &HERO_ONLY_NAMES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sums(pairs: &[(&str, i64)]) -> Sums {
        let mut sums = Sums::default();
        for &(name, value) in pairs {
            match Variable::from_name(name).expect(name) {
                Variable::Counter(counter) => sums.counters[counter.index()] = value,
                Variable::Money(index) => sums.money[index] = value,
                Variable::MoneyHands => sums.money_hands = value,
                Variable::EvNetBbMilli => sums.ev_net_bb_milli = Some(value),
                Variable::Custom(_) => unreachable!("no custom names here"),
            }
        }
        sums
    }

    fn display() -> Display {
        Display::shipped().expect("the shipped definitions load")
    }

    #[test]
    fn a_rate_is_rates_ts_pct() {
        let d = display();
        let vpip = d.get("vpip").expect("vpip");
        let s = sums(&[("vpip", 1), ("vpip_opp", 2000)]);
        let value = vpip.value(&s).expect("a value");
        // (1 * 100) / 2000, not (1 / 2000) * 100.
        assert_eq!(value.to_js_string(), "0.05");
        assert_eq!(vpip.text(value, None).as_deref(), Some("0.1"));
        assert_eq!(
            vpip.rate(&s),
            Some((JsNumber::from_i64(1), JsNumber::from_i64(2000)))
        );
        assert_eq!(vpip.value(&sums(&[("vpip", 0), ("vpip_opp", 0)])), None);
        let shown = vpip.show(&sums(&[("vpip", 30), ("vpip_opp", 100)]), None);
        assert_eq!(shown.text.as_deref(), Some("30.0"));
        assert_eq!(shown.tone, Some(Tone::High));
        assert!(shown.full);
        assert!(!vpip.full(&sums(&[("vpip", 30), ("vpip_opp", 99)])));
        assert_eq!(shown.reliability.level, Level::Ok);
        assert_eq!(
            shown.reliability.interval_text,
            Some(("21.9".to_owned(), "39.6".to_owned()))
        );
        let thin = vpip.reliability(&sums(&[("vpip", 3), ("vpip_opp", 25)]));
        assert_eq!(thin.level, Level::Low);
        assert_eq!(thin.opacity.to_js_string(), "0.8");
    }

    #[test]
    fn win_rates_and_money() {
        let d = display();
        let s = sums(&[
            ("hands", 300),
            ("net_bb_milli", -12_345),
            ("money_hands", 250),
            ("rake_paid", 1234),
        ]);
        let bb = d.get("bb_per_100").expect("bb/100");
        assert_eq!(bb.show(&s, None).text.as_deref(), Some("-4.94"));
        assert_eq!(bb.show(&s, None).tone, Some(Tone::Low));
        let ev = d.get("allin_ev_bb_per_100").expect("ev");
        assert_eq!(ev.value(&s), None, "no EV input, no value");
        let mut with_ev = s.clone();
        with_ev.ev_net_bb_milli = Some(5000);
        assert_eq!(ev.show(&with_ev, None).text.as_deref(), Some("2.00"));
        let rake = d.get("rake_per_100").expect("rake");
        assert_eq!(rake.show(&s, None).text, None, "money needs its currency");
        assert_eq!(rake.show(&s, Some(2)).text.as_deref(), Some("4.94"));
        assert_eq!(bb.value(&sums(&[("net_bb_milli", 5)])), None);
        let hands = d.get("hands").expect("hands");
        assert_eq!(hands.show(&s, None).text.as_deref(), Some("300"));
        assert!(hands.full(&Sums::default()));
        // A win rate: no interval, the level from its 10 000-hand minimum.
        let shown = bb.show(&s, None).reliability;
        assert_eq!((shown.level, shown.interval), (Level::Insufficient, None));
    }

    #[test]
    fn aggression() {
        let d = display();
        let s = sums(&[
            ("bet_flop", 3),
            ("raise_turn", 1),
            ("call_river", 3),
            ("fold_flop", 2),
        ]);
        let af = d.get("aggression_factor").expect("af");
        assert_eq!(af.show(&s, None).text.as_deref(), Some("1.33"));
        assert_eq!(af.sample(&s), Some(JsNumber::from_i64(7)));
        let afq = d.get("aggression_frequency").expect("afq");
        assert_eq!(afq.show(&s, None).text.as_deref(), Some("44.4"));
        assert_eq!(af.value(&sums(&[("bet_flop", 3)])), None, "no calls");
    }

    #[test]
    fn every_name_binds() {
        for name in variable_names() {
            assert!(Variable::from_name(name).is_some(), "{name}");
        }
        assert_eq!(Variable::from_name("nope"), None);
    }
}
