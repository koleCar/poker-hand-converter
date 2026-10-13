//! One exact hand against a weighted range: `frontend/src/lib/equity/range.ts`.
//!
//! The range notation (`QQ+`, `ATs+`, `T9s-65s`, `A5s:0.5`), card removal,
//! and the hero's equity against every holding the opponent could have,
//! weighted, over every runout (or a seeded sample). Hold'em only.
//!
//! **Doubles, replayed.** Unlike an all-in, a range carries arbitrary
//! weights (`0.5`, `0.25`), and the TypeScript sums them, divides them and
//! compares them in doubles, in a fixed order. Every one of those operations
//! is a [`JsNumber`] operation here, in the same order (combos in map order,
//! runouts in lexicographic order, the sampler's draws in sequence), so a
//! result is the TypeScript's double, not an approximation of it.

use std::collections::BTreeSet;

use rail_core::cards::RANKS;
use rail_core::eval::{STANDARD, card_index, evaluate_masks};
use rail_core::js::JsNumber;
use rail_core::js::sort::sort_by;

use crate::enumerate::{
    Computation, DEFAULT_SEED, EquityInputError, EquityMethod, EquityOptions, Mulberry32,
};

/// `WeightedCombo`: two card indices (`rank * 4 + suit`, each below 52) and
/// a relative weight in (0, 1].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeightedCombo {
    pub cards: [u8; 2],
    pub weight: JsNumber,
}

/// `ClassWeights`: hand classes with weights, in insertion order (a
/// JavaScript `Map`: setting an existing key keeps its place).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClassWeights {
    entries: Vec<(String, JsNumber)>,
}

impl ClassWeights {
    pub fn new() -> Self {
        Self::default()
    }

    /// `map.get(name)`.
    pub fn get(&self, name: &str) -> Option<JsNumber> {
        self.entries
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, weight)| *weight)
    }

    /// `map.set(name, weight)`.
    pub fn set(&mut self, name: &str, weight: JsNumber) {
        match self.entries.iter_mut().find(|(key, _)| key == name) {
            Some(entry) => entry.1 = weight,
            None => self.entries.push((name.to_owned(), weight)),
        }
    }

    /// `map.size`.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The entries in map order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, JsNumber)> {
        self.entries
            .iter()
            .map(|(name, weight)| (name.as_str(), *weight))
    }
}

impl<S: Into<String>> FromIterator<(S, JsNumber)> for ClassWeights {
    fn from_iter<I: IntoIterator<Item = (S, JsNumber)>>(iter: I) -> Self {
        let mut out = Self::new();
        for (name, weight) in iter {
            out.set(&name.into(), weight);
        }
        out
    }
}

/// `ClassWeights | readonly WeightedCombo[]`: an opponent's holdings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Range {
    Classes(ClassWeights),
    Combos(Vec<WeightedCombo>),
}

/// What `parseRange` throws: an [`EquityInputError`] for anything it cannot
/// read, and a JavaScript `TypeError` where the TypeScript reads a character
/// past the end of a token (`"A"`, `"+"`, `":0.5"`: `undefined.toUpperCase()`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeError {
    Input(EquityInputError),
    /// `TypeError: Cannot read properties of undefined (reading
    /// 'toUpperCase')`.
    Type,
}

impl From<EquityInputError> for RangeError {
    fn from(error: EquityInputError) -> Self {
        Self::Input(error)
    }
}

impl std::fmt::Display for RangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Input(error) => error.fmt(f),
            Self::Type => {
                f.write_str("Cannot read properties of undefined (reading 'toUpperCase')")
            }
        }
    }
}

impl std::error::Error for RangeError {}

/// `RangeEquityRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeEquityRequest {
    /// The hero's two hole cards, as codes like `"Ah"`.
    pub hero: Vec<String>,
    pub range: Range,
    /// 0, 3, 4 or 5 board cards.
    pub board: Vec<String>,
    /// Cards known to be out of play that neither hand holds.
    pub dead: Vec<String>,
    /// `None` fields take this module's defaults
    /// ([`DEFAULT_RANGE_EXHAUSTIVE_LIMIT`], [`DEFAULT_RANGE_TRIALS`],
    /// `DEFAULT_SEED`).
    pub options: EquityOptions,
}

/// `RangeEquityResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeEquityResult {
    /// Hero's share of the pot: wins plus half of ties, weighted.
    pub equity: JsNumber,
    pub win: JsNumber,
    pub tie: JsNumber,
    /// Combos left in the range after card removal.
    pub combos: usize,
    pub method: Computation,
    /// (combo, runout) pairs enumerated or sampled.
    pub samples: u64,
}

pub const DEFAULT_RANGE_EXHAUSTIVE_LIMIT: u64 = 120_000;
pub const DEFAULT_RANGE_TRIALS: u64 = 6_000;

/* --------------------------------------------------------------- classes - */

/// `RANK_INDEX.get(text)`: the rank of a one-character rank string.
fn rank_index(text: &str) -> Option<u8> {
    let mut chars = text.chars();
    let rank = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    RANKS
        .iter()
        .position(|&r| r == rank)
        .and_then(|i| u8::try_from(i).ok())
}

/// The rank character of a rank index (`RANKS[rank]`).
fn rank_char(rank: u8) -> char {
    RANKS[usize::from(rank)]
}

/// A string's UTF-16 code unit `i` as the one-unit string JavaScript's
/// `text[i]` is; a lone surrogate (half of a pair) is `"\u{FFFD}"`, which is
/// no rank either - all the callers ask of it.
fn unit_at(units: &[u16], i: usize) -> Option<String> {
    let unit = *units.get(i)?;
    Some(char::from_u32(u32::from(unit)).map_or_else(|| "\u{FFFD}".to_owned(), String::from))
}

/// `text.slice(from)` by UTF-16 code units, at a character boundary.
fn slice_units(units: &[u16], from: usize) -> String {
    String::from_utf16_lossy(units.get(from..).unwrap_or(&[]))
}

/// `allClasses()`: the 169 classes, pairs first, then by high card and
/// kicker, suited before offsuit.
pub fn all_classes() -> Vec<String> {
    let mut out = Vec::with_capacity(169);
    for high in (0..13_u8).rev() {
        out.push(format!("{0}{0}", rank_char(high)));
    }
    for high in (0..13_u8).rev() {
        for low in (0..high).rev() {
            out.push(format!("{}{}s", rank_char(high), rank_char(low)));
            out.push(format!("{}{}o", rank_char(high), rank_char(low)));
        }
    }
    out
}

/// `classCombos(name)`: the combos of one class before card removal - 6 for
/// a pair, 4 suited, 12 offsuit.
pub fn class_combos(name: &str) -> Result<Vec<[u8; 2]>, EquityInputError> {
    let units: Vec<u16> = name.encode_utf16().collect();
    let refuse = || EquityInputError(format!("not a hand class: {name}"));
    let high = unit_at(&units, 0).and_then(|c| rank_index(&c));
    let low = unit_at(&units, 1).and_then(|c| rank_index(&c));
    let (Some(high), Some(low)) = (high, low) else {
        return Err(refuse());
    };
    let mut out = Vec::new();
    if high == low {
        if units.len() != 2 {
            return Err(refuse());
        }
        for a in 0..4 {
            for b in a + 1..4 {
                out.push([high * 4 + a, high * 4 + b]);
            }
        }
        return Ok(out);
    }
    let third = units.get(2).copied();
    let suited = third == Some(u16::from(b's'));
    if units.len() != 3
        || (third != Some(u16::from(b's')) && third != Some(u16::from(b'o')))
        || high < low
    {
        return Err(refuse());
    }
    for a in 0..4 {
        for b in 0..4 {
            if (a == b) == suited {
                out.push([high * 4 + a, low * 4 + b]);
            }
        }
    }
    Ok(out)
}

/// `rankOf(char, token)`: the rank a character names, upper-cased the
/// JavaScript way; `None` (`undefined`) is the `TypeError`.
fn rank_of(unit: Option<String>, token: &str) -> Result<u8, RangeError> {
    let Some(unit) = unit else {
        return Err(RangeError::Type);
    };
    rank_index(&rail_core::js::to_upper_case(&unit))
        .ok_or_else(|| EquityInputError(format!("not a range token: {token}")).into())
}

/// `parseRange(text)`: the usual shorthand read into class weights.
///
/// Comma-separated tokens, each optionally `:weight` in (0, 1]; a class
/// named twice keeps its larger weight. Anything unreadable is an error
/// rather than skipped.
pub fn parse_range(text: &str) -> Result<ClassWeights, RangeError> {
    let mut out = ClassWeights::new();
    for raw in text.split(',') {
        let token = rail_core::js::trim(raw);
        if token.is_empty() {
            continue;
        }
        // `const [body, weightText] = token.split(":")`: a third part is
        // ignored.
        let mut parts = token.split(':');
        let body = parts.next().unwrap_or("");
        let weight = parts.next().map_or(JsNumber::from_i64(1), JsNumber::parse);
        if !weight.is_finite()
            || !weight.greater_than(JsNumber::ZERO)
            || weight.greater_than(JsNumber::from_i64(1))
        {
            return Err(EquityInputError(format!("bad weight in range token: {token}")).into());
        }
        for name in expand_token(rail_core::js::trim(body))? {
            // `Math.max(out.get(name) ?? 0, weight)`
            let current = out.get(&name).unwrap_or(JsNumber::ZERO);
            out.set(&name, current.max_of(weight));
        }
    }
    Ok(out)
}

fn expand_token(token: &str) -> Result<Vec<String>, RangeError> {
    if token == "*" || rail_core::js::to_lower_case(token) == "any" {
        return Ok(all_classes());
    }
    if let Some(dash) = token.find('-')
        && dash > 0
    {
        return expand_span(token, &token[..dash], &token[dash + 1..]);
    }
    let plus = token.ends_with('+');
    let body = if plus {
        &token[..token.len() - 1]
    } else {
        token
    };
    let units: Vec<u16> = body.encode_utf16().collect();
    let high = rank_of(unit_at(&units, 0), token)?;
    let low = rank_of(unit_at(&units, 1), token)?;
    let suffix = slice_units(&units, 2);
    if high < low {
        return Err(EquityInputError(format!("write the higher rank first: {token}")).into());
    }
    if !plus {
        return with_suffix(high, low, &suffix, token);
    }
    let mut out = Vec::new();
    if high == low {
        // 77+: every pair from here up.
        for rank in high..=12 {
            out.extend(with_suffix(rank, rank, &suffix, token)?);
        }
        return Ok(out);
    }
    // ATs+: the kicker climbs to one below the high card.
    for kicker in low..high {
        out.extend(with_suffix(high, kicker, &suffix, token)?);
    }
    Ok(out)
}

struct SpanEnd {
    high: u8,
    low: u8,
    suffix: String,
}

/// `expandSpan(token, first, second)`: a span between two classes of the
/// same shape, written in either order.
fn expand_span(token: &str, first: &str, second: &str) -> Result<Vec<String>, RangeError> {
    let span_error =
        || -> RangeError { EquityInputError(format!("not a range span: {token}")).into() };
    let end = |part: &str| -> Result<SpanEnd, RangeError> {
        let units: Vec<u16> = part.encode_utf16().collect();
        if units.len() < 2 {
            return Err(span_error());
        }
        let high = rank_of(unit_at(&units, 0), token)?;
        let low = rank_of(unit_at(&units, 1), token)?;
        if high < low {
            return Err(EquityInputError(format!("write the higher rank first: {token}")).into());
        }
        Ok(SpanEnd {
            high,
            low,
            suffix: slice_units(&units, 2),
        })
    };
    let a = end(rail_core::js::trim(first))?;
    let b = end(rail_core::js::trim(second))?;
    if a.suffix != b.suffix {
        return Err(span_error());
    }
    let suffix = a.suffix.as_str();
    let mut out = Vec::new();
    let a_pair = a.high == a.low;
    let b_pair = b.high == b.low;
    if a_pair || b_pair {
        if !(a_pair && b_pair) {
            return Err(span_error());
        }
        for rank in (a.high.min(b.high)..=a.high.max(b.high)).rev() {
            out.extend(with_suffix(rank, rank, suffix, token)?);
        }
        return Ok(out);
    }
    if a.high == b.high {
        for kicker in (a.low.min(b.low)..=a.low.max(b.low)).rev() {
            out.extend(with_suffix(a.high, kicker, suffix, token)?);
        }
        return Ok(out);
    }
    if a.high - a.low == b.high - b.low {
        let top = if a.high > b.high { &a } else { &b };
        let steps = a.high.abs_diff(b.high);
        for step in 0..=steps {
            out.extend(with_suffix(top.high - step, top.low - step, suffix, token)?);
        }
        return Ok(out);
    }
    Err(span_error())
}

fn with_suffix(high: u8, low: u8, suffix: &str, token: &str) -> Result<Vec<String>, RangeError> {
    let name = format!("{}{}", rank_char(high), rank_char(low));
    if high == low {
        if !suffix.is_empty() {
            return Err(EquityInputError(format!("a pair has no suit suffix: {token}")).into());
        }
        return Ok(vec![name]);
    }
    match suffix {
        "s" | "o" => Ok(vec![format!("{name}{suffix}")]),
        "" => Ok(vec![format!("{name}s"), format!("{name}o")]),
        _ => Err(EquityInputError(format!("not a range token: {token}")).into()),
    }
}

/// `rangeCombos(range, dead)`: class weights expanded to combos, every combo
/// touching a dead card dropped; map order, then suit order.
pub fn range_combos(
    range: &ClassWeights,
    dead: &BTreeSet<u8>,
) -> Result<Vec<WeightedCombo>, EquityInputError> {
    let one = JsNumber::from_i64(1);
    let mut out = Vec::new();
    for (name, weight) in range.iter() {
        if !weight.greater_than(JsNumber::ZERO) {
            continue;
        }
        for cards in class_combos(name)? {
            if !dead.contains(&cards[0]) && !dead.contains(&cards[1]) {
                out.push(WeightedCombo {
                    cards,
                    weight: one.min_of(weight),
                });
            }
        }
    }
    Ok(out)
}

/// Combos already expanded, filtered as `isComboList` ranges are: a
/// positive weight and no dead card. A card index past 51 - which the
/// TypeScript would read out of its arrays as `undefined` - is refused (the
/// one place the port refuses what the TypeScript computes something for).
pub(crate) fn live_combos(
    range: &Range,
    seen: &BTreeSet<u8>,
) -> Result<Vec<WeightedCombo>, EquityInputError> {
    match range {
        Range::Classes(classes) => range_combos(classes, seen),
        Range::Combos(combos) => {
            if let Some(bad) = combos
                .iter()
                .flat_map(|combo| combo.cards)
                .find(|&card| card > 51)
            {
                return Err(EquityInputError(format!("not a card: {bad}")));
            }
            Ok(combos
                .iter()
                .filter(|combo| {
                    combo.weight.greater_than(JsNumber::ZERO)
                        && !seen.contains(&combo.cards[0])
                        && !seen.contains(&combo.cards[1])
                })
                .copied()
                .collect())
        }
    }
}

/// `card(code, seen)` of `range.ts` / `multiway.ts`: the full deck, no deck
/// check.
pub(crate) fn take_card(code: &str, seen: &mut BTreeSet<u8>) -> Result<u8, EquityInputError> {
    let Some(index) = card_index(code) else {
        return Err(EquityInputError(format!("not a card: {code}")));
    };
    if !seen.insert(index) {
        return Err(EquityInputError(format!("{code} appears twice")));
    }
    Ok(index)
}

pub(crate) fn masks_of(cards: &[u8]) -> [u32; 4] {
    let mut masks = [0_u32; 4];
    for &card in cards {
        masks[usize::from(card & 3)] |= 1 << (card >> 2);
    }
    masks
}

/// `strongestOfRange(range, board, share, dead)`: the strongest `share` of
/// a range on a board, by the hand each combo holds now; ties at the cut all
/// go in.
pub fn strongest_of_range(
    range: &Range,
    board: &[String],
    share: JsNumber,
    dead: &[String],
) -> Result<Vec<WeightedCombo>, EquityInputError> {
    let mut seen = BTreeSet::new();
    let mut board_cards = Vec::with_capacity(board.len());
    for code in board {
        board_cards.push(take_card(code, &mut seen)?);
    }
    if board_cards.len() < 3 {
        return Err(EquityInputError(
            "strongestOfRange needs a flop or later".to_owned(),
        ));
    }
    for code in dead {
        take_card(code, &mut seen)?;
    }
    let masks = masks_of(&board_cards);
    let combos = live_combos(range, &seen)?;
    let mut scored: Vec<(WeightedCombo, u32)> = combos
        .into_iter()
        .map(|combo| {
            let mut own = masks;
            for card in combo.cards {
                own[usize::from(card & 3)] |= 1 << (card >> 2);
            }
            let value = evaluate_masks(&STANDARD, own[0], own[1], own[2], own[3]);
            (combo, value)
        })
        .collect();
    sort_by(&mut scored, |a, b| {
        JsNumber::from_u64(u64::from(b.1)) - JsNumber::from_u64(u64::from(a.1))
    });
    let total = scored
        .iter()
        .fold(JsNumber::ZERO, |sum, (combo, _)| sum + combo.weight);
    let mut out = Vec::new();
    let mut taken = JsNumber::ZERO;
    let mut cut: Option<u32> = None;
    for &(combo, value) in &scored {
        if cut.is_some_and(|cut| value < cut) {
            break;
        }
        out.push(combo);
        taken = taken + combo.weight;
        // `taken >= share * total` (false when either side is `NaN`).
        if cut.is_none()
            && matches!(
                taken.compare(share * total),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            )
        {
            cut = Some(value);
        }
    }
    Ok(out)
}

/// `rangeShare(range)`: share of the 1,326 starting combos a range holds,
/// weights counted.
pub fn range_share(range: &ClassWeights) -> Result<JsNumber, EquityInputError> {
    let one = JsNumber::from_i64(1);
    let mut total = JsNumber::ZERO;
    for (name, weight) in range.iter() {
        let combos = class_combos(name)?.len();
        total = total
            + JsNumber::from_u64(u64::try_from(combos).unwrap_or(0))
                * one.min_of(JsNumber::ZERO.max_of(weight));
    }
    Ok(total / JsNumber::from_i64(1326))
}

/* ---------------------------------------------------------------- equity - */

/// `choose(n, k)` of `range.ts` and `multiway.ts`, which (unlike
/// `enumerate.ts`'s) has no guard: `n` may be negative, and the loop then
/// computes the generalized binomial `n (n-1) ... (n-k+1) / k!`. Every
/// intermediate is an integer, so this is exact.
pub(crate) fn choose_any(n: i64, k: i64) -> i128 {
    let mut out: i128 = 1;
    let mut i: i64 = 0;
    while i < k {
        out = out * i128::from(n - i) / i128::from(i + 1);
        i += 1;
    }
    out
}

pub(crate) fn js_int(value: i128) -> JsNumber {
    JsNumber::from_integer(value < 0, value.unsigned_abs())
}

pub(crate) fn js_usize(value: usize) -> JsNumber {
    JsNumber::from_u64(u64::try_from(value).unwrap_or(u64::MAX))
}

/// `walkRunouts(stub, missing, boardMasks, visit)`: every way to deal
/// `missing` cards from `stub`, in lexicographic order.
pub(crate) fn walk_runouts(
    stub: &[u8],
    missing: usize,
    board_masks: [u32; 4],
    visit: &mut impl FnMut([u32; 4]),
) {
    fn recurse(
        stub: &[u8],
        masks: &mut [u32; 4],
        from: usize,
        left: usize,
        visit: &mut impl FnMut([u32; 4]),
    ) {
        if left == 0 {
            visit(*masks);
            return;
        }
        if stub.len() < left {
            return;
        }
        for i in from..=(stub.len() - left) {
            let index = stub[i];
            let suit = usize::from(index & 3);
            let before = masks[suit];
            masks[suit] |= 1 << (index >> 2);
            recurse(stub, masks, i + 1, left - 1, visit);
            masks[suit] = before;
        }
    }
    let mut masks = board_masks;
    recurse(stub, &mut masks, 0, missing, visit);
}

/// `pickWeighted(cumulative, target)`: the first index whose cumulative
/// weight exceeds `target`.
pub(crate) fn pick_weighted(cumulative: &[JsNumber], target: JsNumber) -> usize {
    let mut lo = 0;
    let mut hi = cumulative.len().saturating_sub(1);
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if cumulative[mid].greater_than(target) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

/// `equityVsRange(request)`: the hero's equity against a range, over every
/// runout of the board.
///
/// An impossible request (a duplicated card, a board of two) is an error. An
/// opponent range card removal empties is not: it returns `combos: 0` and an
/// equity of 1.
pub fn equity_vs_range(
    request: &RangeEquityRequest,
) -> Result<RangeEquityResult, EquityInputError> {
    if request.hero.len() != 2 {
        return Err(EquityInputError(format!(
            "the hero needs two hole cards, got {}",
            request.hero.len()
        )));
    }
    let mut seen = BTreeSet::new();
    let mut hero = Vec::with_capacity(2);
    for code in &request.hero {
        hero.push(take_card(code, &mut seen)?);
    }
    let mut board = Vec::with_capacity(request.board.len());
    for code in &request.board {
        board.push(take_card(code, &mut seen)?);
    }
    if board.len() > 5 || board.len() == 1 || board.len() == 2 {
        return Err(EquityInputError(format!(
            "a board of {} cards is not a street",
            board.len()
        )));
    }
    for code in &request.dead {
        take_card(code, &mut seen)?;
    }

    let combos = live_combos(&request.range, &seen)?;
    let missing = 5 - board.len();
    let one = JsNumber::from_i64(1);
    if combos.is_empty() {
        return Ok(RangeEquityResult {
            equity: one,
            win: one,
            tie: JsNumber::ZERO,
            combos: 0,
            method: Computation::Exhaustive,
            samples: 0,
        });
    }

    let seen_count = i64::try_from(seen.len()).unwrap_or(0);
    let missing_i = i64::try_from(missing).unwrap_or(0);
    let runouts = choose_any(52 - seen_count - 2, missing_i);
    let options = &request.options;
    let exhaustive = match options.method {
        EquityMethod::Exhaustive => true,
        EquityMethod::MonteCarlo => false,
        EquityMethod::Auto => {
            let work = js_usize(combos.len()) * js_int(runouts);
            let limit = JsNumber::from_u64(
                options
                    .exhaustive_limit
                    .unwrap_or(DEFAULT_RANGE_EXHAUSTIVE_LIMIT),
            );
            !work.greater_than(limit) && !work.is_nan()
        }
    };

    let hero_masks = masks_of(&hero);
    let board_masks = masks_of(&board);
    let mut win = JsNumber::ZERO;
    let mut tie = JsNumber::ZERO;
    let mut total = JsNumber::ZERO;
    let mut samples = 0_u64;

    let mut score = |m: [u32; 4], villain: &WeightedCombo, w: JsNumber| {
        let ours = evaluate_masks(
            &STANDARD,
            m[0] | hero_masks[0],
            m[1] | hero_masks[1],
            m[2] | hero_masks[2],
            m[3] | hero_masks[3],
        );
        let mut vs = m;
        for card in villain.cards {
            vs[usize::from(card & 3)] |= 1 << (card >> 2);
        }
        let theirs = evaluate_masks(&STANDARD, vs[0], vs[1], vs[2], vs[3]);
        if ours > theirs {
            win = win + w;
        } else if ours == theirs {
            tie = tie + w;
        }
        total = total + w;
        samples += 1;
    };

    if exhaustive {
        for villain in &combos {
            let stub: Vec<u8> = (0..52_u8)
                .filter(|index| {
                    !seen.contains(index)
                        && *index != villain.cards[0]
                        && *index != villain.cards[1]
                })
                .collect();
            let runouts = choose_any(i64::try_from(stub.len()).unwrap_or(0), missing_i);
            let per = villain.weight / one.max_of(js_int(runouts));
            walk_runouts(&stub, missing, board_masks, &mut |m| score(m, villain, per));
        }
    } else {
        let mut random = Mulberry32::new(options.seed.unwrap_or(DEFAULT_SEED));
        let mut cumulative = Vec::with_capacity(combos.len());
        let mut sum = JsNumber::ZERO;
        for combo in &combos {
            sum = sum + combo.weight;
            cumulative.push(sum);
        }
        let trials = options.trials.unwrap_or(DEFAULT_RANGE_TRIALS).max(1);
        let mut used = [false; 52];
        for &index in &seen {
            used[usize::from(index)] = true;
        }
        let mut drawn: Vec<usize> = Vec::with_capacity(5);
        for _ in 0..trials {
            let pick = pick_weighted(&cumulative, random.random() * sum);
            let villain = combos[pick];
            used[usize::from(villain.cards[0])] = true;
            used[usize::from(villain.cards[1])] = true;
            let mut masks = board_masks;
            drawn.clear();
            while drawn.len() < missing {
                let index = random.below(52);
                if used[index] {
                    continue;
                }
                used[index] = true;
                drawn.push(index);
                masks[index & 3] |= 1 << (index >> 2);
            }
            score(masks, &villain, one);
            for &index in &drawn {
                used[index] = false;
            }
            used[usize::from(villain.cards[0])] = false;
            used[usize::from(villain.cards[1])] = false;
        }
    }

    let positive = total.greater_than(JsNumber::ZERO);
    let win_share = if positive {
        win / total
    } else {
        JsNumber::ZERO
    };
    let tie_share = if positive {
        tie / total
    } else {
        JsNumber::ZERO
    };
    Ok(RangeEquityResult {
        equity: win_share + tie_share / JsNumber::from_i64(2),
        win: win_share,
        tie: tie_share,
        combos: combos.len(),
        method: if exhaustive {
            Computation::Exhaustive
        } else {
            Computation::MonteCarlo
        },
        samples,
    })
}
