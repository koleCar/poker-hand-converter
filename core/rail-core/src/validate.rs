//! The hand validator: `validateHand` of `web/src/lib/phf/validate.ts`.
//!
//! A hand history is user-supplied data from a room we do not control, and
//! rooms do emit broken hands. The checks, in the TypeScript's order: seating
//! (duplicate names and seats, no players, the button, the hero); every
//! actor seated; every card readable, in the deck and dealt once; hole-card
//! counts per variant; legal boards and the street reached; chip conservation
//! (in = pot) and payout conservation (out = pot, or pot minus fees); no stack
//! below zero; no uncalled return above the street's commitment; hi/lo halves
//! only on collects of a hi/lo hand, no payout the shown cards contradict,
//! halves of one pot the same size; the results block against the stream;
//! the big blind; and last the parser's own `meta.warnings`, re-reported.
//!
//! `error` means the hand must not be stored; `warning` that it is usable but
//! odd. The pipeline ([`crate::convert`](mod@crate::convert)) refuses a hand
//! with any error at stage `validate`, reason = the first error's code,
//! message = every error message joined by `; `.
//!
//! Exactness notes:
//!
//! - Sums and differences are JavaScript number arithmetic ([`JsNumber`]),
//!   so a sum past 2^53 rounds as it does there, and numbers in messages are
//!   printed with `String(n)`.
//! - `bad-schema` cannot occur: [`PhfHand::schema`] has one value, and a hand
//!   tagged otherwise does not deserialize in the first place.
//! - The TypeScript throws from inside `validateHand` when a hi/lo payout
//!   check meets a card the evaluator cannot read (`not a card: …`); that is
//!   the `Err` here (see [`crate::convert::HandChecks`]).

use std::collections::{HashMap, HashSet};

use crate::cards::parse_card;
use crate::js::{JsError, JsNumber};
use crate::phf::hilo::{hi_lo_payout_contradictions, hi_lo_pot_groups};
use crate::phf::{
    ActionType, Amount, CurrencyKind, PhfHand, PotHalf, Street, card_in_deck, hole_card_count,
    resolve_runout,
};

/// `Severity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    /// `"error"` or `"warning"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// A value in a problem's `context` (`Record<string, string | number>`; every
/// number the validator puts there is an integer).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ContextValue {
    Text(String),
    Integer(i64),
}

/// `ValidationProblem`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ValidationProblem {
    /// Short machine code; doubles as the `reason` of a validate-stage
    /// `ConversionFailure`.
    pub code: String,
    pub message: String,
    pub severity: Severity,
    /// Player, seat, action index - in insertion order, as the TypeScript
    /// object literal has them. `None` is an absent `context`.
    pub context: Option<Vec<(String, ContextValue)>>,
}

/// `ValidationReport`: every problem in the order found; `ok`, `errors` and
/// `warnings` are views of it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct ValidationReport {
    pub problems: Vec<ValidationProblem>,
}

impl ValidationReport {
    /// `report.ok`: no errors.
    pub fn ok(&self) -> bool {
        self.errors().next().is_none()
    }

    /// `report.errors`.
    pub fn errors(&self) -> impl Iterator<Item = &ValidationProblem> {
        self.problems
            .iter()
            .filter(|p| p.severity == Severity::Error)
    }

    /// `report.warnings`.
    pub fn warnings(&self) -> impl Iterator<Item = &ValidationProblem> {
        self.problems
            .iter()
            .filter(|p| p.severity == Severity::Warning)
    }
}

/// `TOLERANCE`: one minor unit of slack on every sum.
const TOLERANCE: i64 = 1;

/// One card of the hand and where it was dealt (`distinctCardUses`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardUse {
    pub card: String,
    /// `seat 3 (Name)`, `board`, `runout 1 flop`, …
    pub place: String,
}

/// `distinctCardUses(hand)`: every card in the hand. A later runout counts
/// only the streets it re-dealt, so a shared flop is not three duplicates
/// (`run.flop` counts whenever it is not `null`, even empty; a turn or river
/// only when it is a non-empty string - JavaScript truthiness).
pub fn distinct_card_uses(hand: &PhfHand) -> Vec<CardUse> {
    let mut uses = Vec::new();
    let mut add = |card: &str, place: String| {
        uses.push(CardUse {
            card: card.to_owned(),
            place,
        });
    };
    for player in &hand.players {
        for card in &player.hole_cards {
            add(card, format!("seat {} ({})", player.seat, player.name));
        }
    }
    for (i, run) in hand.board.runouts.iter().enumerate() {
        let resolved = resolve_runout(&hand.board, i);
        if i == 0 {
            for card in &resolved {
                add(card, "board".to_owned());
            }
            continue;
        }
        if run.flop.is_some() {
            for card in resolved.iter().take(3) {
                add(card, format!("runout {i} flop"));
            }
        }
        if let Some(turn) = truthy(run.turn.as_ref()) {
            add(turn, format!("runout {i} turn"));
        }
        if let Some(river) = truthy(run.river.as_ref()) {
            add(river, format!("runout {i} river"));
        }
    }
    uses
}

/// A `string | null` as JavaScript's truthiness sees it.
fn truthy(text: Option<&String>) -> Option<&String> {
    text.filter(|text| !text.is_empty())
}

/// An amount as a JavaScript number.
fn js(amount: Amount) -> JsNumber {
    JsNumber::from_i64(amount)
}

/// `${amount}`.
fn show(amount: Amount) -> String {
    js(amount).to_js_string()
}

/// `Math.abs(difference) > limit`.
fn exceeds(difference: JsNumber, limit: JsNumber) -> bool {
    difference.abs().greater_than(limit)
}

/// `Math.abs(difference) <= limit`.
fn within(difference: JsNumber, limit: JsNumber) -> bool {
    !difference.is_nan() && !exceeds(difference, limit)
}

/// A JavaScript number as a context integer. Sums of amounts are integers;
/// one beyond `i64` (a chip total past 9.2 × 10^18) saturates - the canonical
/// form could not hold it either.
fn integer(value: JsNumber) -> ContextValue {
    ContextValue::Integer(value.to_i64().unwrap_or(if value.is_sign_negative() {
        i64::MIN
    } else {
        i64::MAX
    }))
}

fn text(value: &str) -> ContextValue {
    ContextValue::Text(value.to_owned())
}

/// `action.sourceLine ?? -1`.
fn line_or_minus_one(line: Option<u32>) -> ContextValue {
    ContextValue::Integer(line.map_or(-1, i64::from))
}

/// A `Map<string, number>` in insertion order, as the TypeScript sums its
/// values in that order.
#[derive(Default)]
struct Totals {
    entries: Vec<(String, JsNumber)>,
    index: HashMap<String, usize>,
}

impl Totals {
    fn get(&self, key: &str) -> Option<JsNumber> {
        self.index.get(key).map(|i| self.entries[*i].1)
    }

    /// `map.set(key, (map.get(key) ?? 0) + amount)`.
    fn add(&mut self, key: &str, amount: JsNumber) {
        match self.index.get(key) {
            Some(i) => self.entries[*i].1 = self.entries[*i].1 + amount,
            None => {
                self.index.insert(key.to_owned(), self.entries.len());
                self.entries.push((key.to_owned(), JsNumber::ZERO + amount));
            }
        }
    }

    /// `[...map.values()].reduce((sum, value) => sum + value, 0)`.
    fn sum(&self) -> JsNumber {
        self.entries
            .iter()
            .fold(JsNumber::ZERO, |sum, (_, value)| sum + *value)
    }
}

struct Problems(Vec<ValidationProblem>);

impl Problems {
    fn push(
        &mut self,
        severity: Severity,
        code: &str,
        message: String,
        context: Option<Vec<(&str, ContextValue)>>,
    ) {
        self.0.push(ValidationProblem {
            code: code.to_owned(),
            message,
            severity,
            context: context.map(|entries| {
                entries
                    .into_iter()
                    .map(|(key, value)| (key.to_owned(), value))
                    .collect()
            }),
        });
    }

    fn error(&mut self, code: &str, message: String, context: Option<Vec<(&str, ContextValue)>>) {
        self.push(Severity::Error, code, message, context);
    }

    fn warn(&mut self, code: &str, message: String, context: Option<Vec<(&str, ContextValue)>>) {
        self.push(Severity::Warning, code, message, context);
    }
}

/// `validateHand(hand)`: every problem, in the TypeScript's order, with its
/// codes, messages and context. `Err` exactly where the TypeScript throws.
pub fn validate_hand(hand: &PhfHand) -> Result<ValidationReport, JsError> {
    let mut problems = Problems(Vec::new());
    let tolerance = js(TOLERANCE);

    // `hand.schema !== "phf/1"` (bad-schema) cannot be true of a `PhfHand`.

    /* ------------------------------------------------------------ seating */

    let mut seated: HashSet<&str> = HashSet::new();
    let mut seat_numbers: HashSet<u32> = HashSet::new();
    for player in &hand.players {
        if seated.contains(player.name.as_str()) {
            problems.error(
                "duplicate-player",
                format!("Player \"{}\" is seated twice.", player.name),
                Some(vec![("player", text(&player.name))]),
            );
        }
        if seat_numbers.contains(&player.seat) {
            problems.error(
                "duplicate-seat",
                format!("Seat {} is occupied twice.", player.seat),
                Some(vec![(
                    "seat",
                    ContextValue::Integer(i64::from(player.seat)),
                )]),
            );
        }
        seated.insert(&player.name);
        seat_numbers.insert(player.seat);
    }

    if hand.players.is_empty() {
        problems.error(
            "no-players",
            "The hand has no seated players.".to_owned(),
            None,
        );
    }
    match hand.table.button_seat {
        None => problems.warn(
            "missing-button",
            "The button seat is unknown, so positions cannot be resolved.".to_owned(),
            None,
        ),
        Some(seat) if !seat_numbers.contains(&seat) => problems.warn(
            "button-not-seated",
            format!("The button is on seat {seat}, which is empty."),
            Some(vec![("seat", ContextValue::Integer(i64::from(seat)))]),
        ),
        Some(_) => {}
    }
    if !hand.players.iter().any(|player| player.is_hero) {
        problems.warn("no-hero", "No seat is marked as the hero.".to_owned(), None);
    }

    /* ------------------------------------------------------------- actors */

    for action in &hand.actions {
        if !seated.contains(action.player.as_str()) {
            problems.error(
                "unseated-actor",
                format!("\"{}\" acts but is not seated.", action.player),
                Some(vec![
                    ("player", text(&action.player)),
                    ("action", ContextValue::Integer(i64::from(action.index))),
                    ("line", line_or_minus_one(action.source_line)),
                ]),
            );
        }
    }

    /* -------------------------------------------------------------- cards */

    let mut seen: HashMap<String, String> = HashMap::new();
    for card_use in distinct_card_uses(hand) {
        let CardUse { card, place } = card_use;
        if parse_card(&card).is_none() {
            problems.error(
                "invalid-card",
                format!("\"{card}\" is not a valid card ({place})."),
                None,
            );
            continue;
        }
        // A deuce through five cannot be dealt from a short deck: not odd but
        // impossible, so an error.
        if !card_in_deck(&card, hand.game.variant) {
            problems.error(
                "card-not-in-deck",
                format!(
                    "{card} ({place}) is not in the 36-card deck {} is dealt from.",
                    hand.game.variant.as_str()
                ),
                Some(vec![("card", text(&card))]),
            );
            continue;
        }
        if let Some(previous) = seen.get(&card) {
            problems.error(
                "duplicate-card",
                format!("{card} appears in both {previous} and {place}."),
                Some(vec![("card", text(&card))]),
            );
            continue;
        }
        seen.insert(card, place);
    }

    // Too few hole cards is a partial reveal (warning); too many is
    // impossible (error).
    if let Some(expected) = hole_card_count(hand.game.variant) {
        let expected = usize::try_from(expected).unwrap_or(usize::MAX);
        for player in &hand.players {
            let count = player.hole_cards.len();
            if count == 0 || count == expected {
                continue;
            }
            let detail = format!(
                "{} has {count} hole cards; {} deals {expected}.",
                player.name,
                hand.game.variant.as_str()
            );
            let context = Some(vec![("player", text(&player.name))]);
            if count > expected {
                problems.error("hole-card-overflow", detail, context);
            } else {
                problems.warn("hole-card-count", detail, context);
            }
        }
    }

    /* -------------------------------------------------------------- board */

    let first = hand.board.runouts.first();
    for (i, run) in hand.board.runouts.iter().enumerate() {
        let cards = resolve_runout(&hand.board, i);
        let runout = || Some(vec![("runout", integer_of(i))]);
        if ![0, 3, 4, 5].contains(&cards.len()) {
            problems.error(
                "board-size",
                format!(
                    "Runout {i} has {} cards, which is not a legal board.",
                    cards.len()
                ),
                runout(),
            );
        }
        // `!(run.flop ?? runouts[0]?.flop)`: an array is truthy even empty.
        let flop = run
            .flop
            .as_ref()
            .or_else(|| first.and_then(|f| f.flop.as_ref()));
        if truthy(run.turn.as_ref()).is_some() && flop.is_none() {
            problems.error(
                "turn-without-flop",
                format!("Runout {i} has a turn but no flop."),
                runout(),
            );
        }
        // `!(run.turn ?? runouts[0]?.turn)`: `??` keeps an empty string, which
        // is falsy.
        let turn = run
            .turn
            .as_ref()
            .or_else(|| first.and_then(|f| f.turn.as_ref()));
        if truthy(run.river.as_ref()).is_some() && truthy(turn).is_none() {
            problems.error(
                "river-without-turn",
                format!("Runout {i} has a river but no turn."),
                runout(),
            );
        }
    }

    let primary = resolve_runout(&hand.board, 0);
    let expected = match hand.results.street_reached {
        Street::Preflop => 0,
        Street::Flop => 3,
        Street::Turn => 4,
        Street::River => 5,
        Street::Showdown => primary.len(),
    };
    if primary.len() != expected {
        problems.warn(
            "board-street-mismatch",
            format!(
                "Street reached is {} but the board has {} cards.",
                hand.results.street_reached.as_str(),
                primary.len()
            ),
            None,
        );
    }

    /* --------------------------------------------------------- chip flows */

    let mut contributed = Totals::default();
    let mut collected = Totals::default();
    let mut stacks: HashMap<&str, JsNumber> = HashMap::new();
    for player in &hand.players {
        stacks.insert(&player.name, js(player.starting_stack));
    }

    for action in &hand.actions {
        if action.kind == ActionType::Collect {
            collected.add(&action.player, js(action.amount));
            continue;
        }
        if action.amount == 0 {
            continue;
        }
        contributed.add(&action.player, js(action.amount));
        let Some(stack) = stacks.get_mut(action.player.as_str()) else {
            continue;
        };
        let next = *stack - js(action.amount);
        *stack = next;
        if next.less_than(-tolerance) {
            problems.error(
                "negative-stack",
                format!(
                    "{} is {} below zero after \"{}\".",
                    action.player,
                    (-next).to_js_string(),
                    action.raw_line
                ),
                Some(vec![
                    ("player", text(&action.player)),
                    ("action", ContextValue::Integer(i64::from(action.index))),
                    ("line", line_or_minus_one(action.source_line)),
                ]),
            );
        }
    }

    // House chips into the pot are nobody's contribution; a jackpot drop
    // leaves a stack without reaching the pot.
    let movements = hand.chip_movements.as_deref().unwrap_or_default();
    for movement in movements {
        if movement.amount <= 0 {
            problems.warn(
                "empty-chip-movement",
                format!("A {} movement carries no chips.", movement.kind),
                None,
            );
        }
        let Some(from_seat) = movement.from_seat else {
            continue;
        };
        if !seat_numbers.contains(&from_seat) {
            problems.error(
                "unseated-chip-movement",
                format!(
                    "A {} movement charges seat {from_seat}, which is empty.",
                    movement.kind
                ),
                Some(vec![("seat", ContextValue::Integer(i64::from(from_seat)))]),
            );
            continue;
        }
        // Kept for fidelity; nothing below reads the stacks again.
        if !movement.to_pot
            && let Some(from_player) = truthy(movement.from_player.as_ref())
            && let Some(stack) = stacks.get_mut(from_player.as_str())
        {
            *stack = *stack - js(movement.amount);
        }
    }

    let house_into_pot = movements
        .iter()
        .filter(|movement| movement.to_pot)
        .fold(JsNumber::ZERO, |sum, movement| sum + js(movement.amount));
    let total_in = house_into_pot + contributed.sum();
    let total_out = collected.sum();
    let fees = {
        let f = &hand.results.fees;
        js(f.rake) + js(f.jackpot) + js(f.bingo) + js(f.fortune) + js(f.tax) + js(f.other)
    };
    let pot = js(hand.results.total_pot);

    if exceeds(total_in - pot, tolerance) {
        let promo = if house_into_pot.strict_equals(JsNumber::ZERO) {
            String::new()
        } else {
            format!(
                " (including {} the house added)",
                house_into_pot.to_js_string()
            )
        };
        problems.error(
            "chip-mismatch",
            format!(
                "Players put in {}{promo} but the hand reports a pot of {}.",
                total_in.to_js_string(),
                pot.to_js_string()
            ),
            Some(vec![("in", integer(total_in)), ("pot", integer(pot))]),
        );
    }

    // "Total pot" before the rake (GG) or alongside it (WePlay): both are
    // consistent, only a third answer is an error.
    if total_out.greater_than(JsNumber::ZERO) {
        let fees_deducted = within(total_out + fees - pot, tolerance);
        let fees_separate = within(total_out - pot, tolerance);
        if !fees_deducted && !fees_separate {
            problems.error(
                "payout-mismatch",
                format!(
                    "Winners collected {} and fees were {}, which matches neither the reported \
                     pot of {} nor that pot minus fees.",
                    total_out.to_js_string(),
                    fees.to_js_string(),
                    pot.to_js_string()
                ),
                Some(vec![
                    ("out", integer(total_out)),
                    ("fees", integer(fees)),
                    ("pot", integer(pot)),
                ]),
            );
        }
    }

    if total_out.strict_equals(JsNumber::ZERO) {
        problems.warn("no-winner", "Nobody collected the pot.".to_owned(), None);
    }

    // An uncalled return can never exceed what the player put in on the
    // street (per runout).
    let mut street_commit: HashMap<&str, JsNumber> = HashMap::new();
    let mut current = (Street::Preflop, 0_u32);
    for action in &hand.actions {
        let key = (action.street, action.runout_index);
        if key != current {
            current = key;
            street_commit.clear();
        }
        let committed = street_commit
            .get(action.player.as_str())
            .copied()
            .unwrap_or(JsNumber::ZERO);
        if action.kind == ActionType::Uncalled {
            let returned = -js(action.amount);
            if returned.greater_than(committed + tolerance) {
                problems.error(
                    "uncalled-exceeds-commitment",
                    format!(
                        "{} is returned {} but only committed {}.",
                        action.player,
                        returned.to_js_string(),
                        committed.to_js_string()
                    ),
                    Some(vec![
                        ("player", text(&action.player)),
                        ("action", ContextValue::Integer(i64::from(action.index))),
                    ]),
                );
            }
        }
        street_commit.insert(&action.player, committed + js(action.amount));
    }

    /* ------------------------------------------------------- hi/lo halves */

    // A half only means something on a collect of a split-pot game; anywhere
    // else it would make a high-only pot read as split.
    for action in &hand.actions {
        let Some(half) = action.half else {
            continue;
        };
        if !hand.game.hi_lo || action.kind != ActionType::Collect {
            problems.error(
                "stray-pot-half",
                format!(
                    "A {} by {} is marked as the {} half, {}",
                    action.kind.as_str(),
                    action.player,
                    half.as_str(),
                    if hand.game.hi_lo {
                        "but only a collect can be."
                    } else {
                        "but the game is not hi/lo."
                    }
                ),
                Some(vec![
                    ("player", text(&action.player)),
                    ("action", ContextValue::Integer(i64::from(action.index))),
                ]),
            );
        }
    }
    if !hand.game.hi_lo && hand.results.winners.iter().any(|w| w.half.is_some()) {
        problems.error(
            "stray-pot-half",
            "A winner is marked with a pot half, but the game is not hi/lo.".to_owned(),
            None,
        );
    }

    // Within one pot the halves are the same size, give or take the table's
    // odd chip: a tenth of the big blind, at least one unit.
    let odd_chip = tolerance.max_of((js(hand.game.big_blind) / js(10)).floor());
    if hand.game.hi_lo {
        for message in hi_lo_payout_contradictions(hand)? {
            problems.error("hi-lo-payout-contradiction", message, None);
        }
        for group in hi_lo_pot_groups(hand) {
            let collects: Vec<_> = group.collects.iter().map(|i| &hand.actions[*i]).collect();
            let half_sum = |half: PotHalf| {
                let mut any = false;
                let sum = collects
                    .iter()
                    .filter(|action| action.half == Some(half))
                    .fold(JsNumber::ZERO, |sum, action| {
                        any = true;
                        sum + js(action.amount)
                    });
                any.then_some(sum)
            };
            let (Some(hi_sum), Some(lo_sum)) = (half_sum(PotHalf::Hi), half_sum(PotHalf::Lo))
            else {
                continue;
            };
            let count = JsNumber::from_u64(u64::try_from(collects.len()).unwrap_or(u64::MAX));
            if exceeds(hi_sum - lo_sum, odd_chip.max_of(count)) {
                problems.warn(
                    "hi-lo-halves-unbalanced",
                    format!(
                        "The {} paid {} high and {} low; the two halves of a split pot differ \
                         by the odd chip at most.",
                        if group.key.is_empty() {
                            "pot"
                        } else {
                            &group.key
                        },
                        hi_sum.to_js_string(),
                        lo_sum.to_js_string()
                    ),
                    Some(vec![(
                        "runout",
                        ContextValue::Integer(i64::from(group.runout_index)),
                    )]),
                );
            }
        }
    }

    /* ------------------------------------------------------ reported sums */

    for result in &hand.results.players {
        let actual = contributed.get(&result.player).unwrap_or(JsNumber::ZERO);
        if exceeds(actual - js(result.contributed), tolerance) {
            problems.warn(
                "contribution-mismatch",
                format!(
                    "{}: results say {} in, the stream says {}.",
                    result.player,
                    show(result.contributed),
                    actual.to_js_string()
                ),
                Some(vec![("player", text(&result.player))]),
            );
        }
        let won = collected.get(&result.player).unwrap_or(JsNumber::ZERO);
        if exceeds(won - js(result.won), tolerance) {
            problems.warn(
                "winnings-mismatch",
                format!(
                    "{}: results say {} won, the stream says {}.",
                    result.player,
                    show(result.won),
                    won.to_js_string()
                ),
                Some(vec![("player", text(&result.player))]),
            );
        }
    }

    if hand.game.big_blind <= 0 && hand.game.unit.kind == CurrencyKind::Cash {
        problems.warn(
            "missing-blinds",
            "The hand does not state a big blind.".to_owned(),
            None,
        );
    }

    /* ------------------------------------------------ parser-side warnings */

    for warning in &hand.meta.warnings {
        // `warning.line ? { line } : undefined`: line 0 is falsy.
        let context = warning
            .line
            .filter(|line| *line != 0)
            .map(|line| vec![("line", ContextValue::Integer(i64::from(line)))]);
        problems.warn(&warning.code, warning.message.clone(), context);
    }

    Ok(ValidationReport {
        problems: problems.0,
    })
}

/// A runout index for a context.
fn integer_of(i: usize) -> ContextValue {
    ContextValue::Integer(i64::try_from(i).unwrap_or(i64::MAX))
}

/// `describeReport(report)`: the one-line summary for logs - `valid`, or
/// the error codes and the distinct warning codes.
pub fn describe_report(report: &ValidationReport) -> String {
    let errors: Vec<&str> = report.errors().map(|p| p.code.as_str()).collect();
    let mut warnings: Vec<&str> = Vec::new();
    for problem in report.warnings() {
        if !warnings.contains(&problem.code.as_str()) {
            warnings.push(&problem.code);
        }
    }
    let warning_count = report.warnings().count();
    if errors.is_empty() && warning_count == 0 {
        return "valid".to_owned();
    }
    let mut parts = Vec::new();
    if !errors.is_empty() {
        parts.push(format!("{} error(s): {}", errors.len(), errors.join(", ")));
    }
    if warning_count > 0 {
        parts.push(format!(
            "{warning_count} warning(s): {}",
            warnings.join(", ")
        ));
    }
    parts.join("; ")
}
