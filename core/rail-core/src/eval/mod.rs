//! Poker hand evaluation, full deck and short deck: the port of
//! `frontend/src/lib/equity/evaluator.ts` (and of `omaha.ts`, in
//! [`omaha`]).
//!
//! It lives in the core rather than in `rail-equity` because the core needs
//! it first: the hi/lo validator ([`crate::phf::hilo`]) decides who won which
//! half from the cards. All-in EV (R2.2, `rail-equity`) builds on the same
//! tables and functions - [`evaluate_masks`] is the hot path its enumerator
//! will call, and [`suit_masks`], [`omaha::hole_pair_masks`] /
//! [`omaha::board_triple_masks`] prepare its input - and adds the
//! enumeration, the Monte Carlo sampler and ranges on top; nothing here needs
//! to change for that.
//!
//! **Representation.** A card is an integer `rank * 4 + suit`, rank 0..=12 for
//! 2..A and suit 0..=3 for s, h, d, c. A *hand* is four 13-bit rank masks, one
//! per suit. **Value**: `strength << 20` followed by five 4-bit rank nibbles,
//! most significant first; higher beats lower, equal ties. Values compare only
//! between hands evaluated with the same table and the same card count.
//!
//! **Short deck is two more tables, not a flag** (see `evaluator.ts`):
//! [`SHORT_DECK`] (three of a kind over a straight) and
//! [`SHORT_DECK_STRAIGHT_OVER_TRIPS`] (GGPoker's rule), picked per room by
//! [`short_deck_rule_for`].
//!
//! Everything is integer arithmetic, as in the TypeScript (which works on
//! 32-bit integers in `number`s). Where the TypeScript returns `-1` or
//! `undefined` for "none", this returns `None`; where it throws, an
//! [`JsError`] with the same message.

pub mod omaha;

use std::sync::LazyLock;

use crate::cards::{RANKS, SUITS, parse_card};
use crate::js::JsError;

/* ---------------------------------------------------------------- cards - */

/// `cardIndex`: the index of a card code like `"Ah"` (`rank * 4 + suit`),
/// or `None` (TypeScript: `-1`) for anything that is not a card. Read with
/// [`parse_card`], so `" ah"` is a card.
pub fn card_index(code: &str) -> Option<u8> {
    let card = parse_card(code)?;
    Some(card.rank * 4 + card.suit)
}

/// `cardCode`: the code of a card index; `None` past 51, where the
/// TypeScript would build a string out of `undefined`.
pub fn card_code(index: u8) -> Option<String> {
    let rank = RANKS.get(usize::from(index >> 2))?;
    let suit = SUITS[usize::from(index & 3)];
    Some(format!("{rank}{suit}"))
}

/* ------------------------------------------------------------ categories - */

/// `HandCategory`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HandCategory {
    HighCard,
    Pair,
    TwoPair,
    Trips,
    Straight,
    Flush,
    FullHouse,
    Quads,
    StraightFlush,
}

/// `HAND_CATEGORIES`, in that order: a category's position here is its index
/// into a table's `shift`.
pub const HAND_CATEGORIES: [HandCategory; 9] = [
    HandCategory::HighCard,
    HandCategory::Pair,
    HandCategory::TwoPair,
    HandCategory::Trips,
    HandCategory::Straight,
    HandCategory::Flush,
    HandCategory::FullHouse,
    HandCategory::Quads,
    HandCategory::StraightFlush,
];

impl HandCategory {
    /// The TypeScript string, e.g. `"full-house"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HighCard => "high-card",
            Self::Pair => "pair",
            Self::TwoPair => "two-pair",
            Self::Trips => "trips",
            Self::Straight => "straight",
            Self::Flush => "flush",
            Self::FullHouse => "full-house",
            Self::Quads => "quads",
            Self::StraightFlush => "straight-flush",
        }
    }

    /// The index into [`HAND_CATEGORIES`] (the TypeScript constants
    /// `HIGH_CARD` = 0 .. `STRAIGHT_FLUSH` = 8).
    const fn index(self) -> usize {
        match self {
            Self::HighCard => 0,
            Self::Pair => 1,
            Self::TwoPair => 2,
            Self::Trips => 3,
            Self::Straight => 4,
            Self::Flush => 5,
            Self::FullHouse => 6,
            Self::Quads => 7,
            Self::StraightFlush => 8,
        }
    }
}

/* --------------------------------------------------------------- tables - */

const MASKS: usize = 8192;

/// A 13-bit rank mask as a table index.
#[inline]
fn at(mask: u32) -> usize {
    // Masks are 13 bits wide; the `& 0x1fff` keeps an index in range even
    // for a caller that hands in a wider one (where the TypeScript would read
    // `undefined` out of its typed array).
    usize::try_from(mask & 0x1fff).unwrap_or(0)
}

/// `31 - Math.clz32(mask)`: the index of the highest set bit (`mask` > 0).
const fn highest_bit(mask: u32) -> u32 {
    31 - mask.leading_zeros()
}

/// `POP`: bits set in a 13-bit mask.
static POP: [u8; MASKS] = {
    let mut table = [0_u8; MASKS];
    let mut mask = 1;
    while mask < MASKS {
        table[mask] = table[mask >> 1] + if mask & 1 == 1 { 1 } else { 0 };
        mask += 1;
    }
    table
};

/// `TOP`: the index of the highest set bit, or 0 for an empty mask.
static TOP: [u32; MASKS] = {
    let mut table = [0_u32; MASKS];
    // `index` and `mask` count together: the one indexes, the other is the
    // same number as a `u32`, so no cast is needed.
    let (mut index, mut mask) = (1_usize, 1_u32);
    while index < MASKS {
        table[index] = highest_bit(mask);
        index += 1;
        mask += 1;
    }
    table
};

/// `TOP5`: the five highest ranks of a mask packed as nibbles, highest at bits
/// 16-19. A mask with fewer than five ranks is padded with nibble 0 - the same
/// nibble as a deuce, exactly as in the TypeScript.
static TOP5: [u32; MASKS] = {
    let mut table = [0_u32; MASKS];
    let (mut index, mut mask) = (1_usize, 1_u32);
    while index < MASKS {
        let mut packed = 0_u32;
        let mut rest = mask;
        let mut i = 0;
        while i < 5 {
            let top = if rest != 0 { highest_bit(rest) } else { 0 };
            packed = (packed << 4) | top;
            rest &= !(1 << top);
            i += 1;
        }
        table[index] = packed;
        index += 1;
        mask += 1;
    }
    table
};

/// `RankingTable["name"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TableName {
    Standard,
    ShortDeck,
    ShortDeckStraightOverTrips,
}

impl TableName {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::ShortDeck => "short-deck",
            Self::ShortDeckStraightOverTrips => "short-deck-straight-over-trips",
        }
    }
}

/// `RankingTable`: everything that distinguishes one game's hand ranking from
/// another's.
pub struct RankingTable {
    pub name: TableName,
    /// Ranks the deck is built from, low to high (0 = deuce).
    pub deck_ranks: &'static [u8],
    /// `straight[mask]`: one more than the top rank of the best straight in
    /// the rank set, or 0 for none.
    straight: Vec<u8>,
    /// `shift[category]`: the category's strength, already shifted into
    /// place.
    shift: [u32; 9],
    /// `byStrength`: the category for each strength, the inverse of `shift`.
    by_strength: [HandCategory; 9],
}

impl std::fmt::Debug for RankingTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RankingTable")
            .field("name", &self.name)
            .field("deck_ranks", &self.deck_ranks)
            .field("by_strength", &self.by_strength)
            .finish_non_exhaustive()
    }
}

impl PartialEq for RankingTable {
    /// Tables are compared by name: there is one of each.
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

impl RankingTable {
    /// `table.straight[mask]`.
    pub fn straight(&self, mask: u32) -> u8 {
        self.straight[at(mask)]
    }

    /// `table.shift[category]`.
    pub fn shift(&self, category: HandCategory) -> u32 {
        self.shift[category.index()]
    }

    /// `table.byStrength`.
    pub fn by_strength(&self) -> &[HandCategory; 9] {
        &self.by_strength
    }
}

/// Five ranks that make a straight, and the rank it plays as.
struct StraightWindow {
    ranks: [u8; 5],
    top: u8,
}

/// `straightTable(windows)`.
fn straight_table(windows: &[StraightWindow]) -> Vec<u8> {
    // Highest window first, so the first match is the best straight.
    let mut ordered: Vec<(u32, u8)> = windows
        .iter()
        .map(|window| {
            let need = window
                .ranks
                .iter()
                .fold(0_u32, |acc, rank| acc | (1 << rank));
            (need, window.top)
        })
        .collect();
    ordered.sort_by_key(|window| std::cmp::Reverse(window.1));
    (0..MASKS)
        .map(|mask| {
            let mask = u32::try_from(mask).unwrap_or(0);
            ordered
                .iter()
                .find(|(need, _)| mask & need == *need)
                .map_or(0, |(_, top)| top + 1)
        })
        .collect()
}

/// `rankingTable(name, deckRanks, windows, order)`.
fn ranking_table(
    name: TableName,
    deck_ranks: &'static [u8],
    windows: &[StraightWindow],
    order: [HandCategory; 9],
) -> RankingTable {
    let mut shift = [0_u32; 9];
    for (index, category) in HAND_CATEGORIES.iter().enumerate() {
        // Every order lists every category, so `indexOf` is never -1.
        let strength = order.iter().position(|c| c == category).unwrap_or(0);
        shift[index] = u32::try_from(strength).unwrap_or(0) << 20;
    }
    RankingTable {
        name,
        deck_ranks,
        straight: straight_table(windows),
        shift,
        by_strength: order,
    }
}

/// `runs(lowTop)`: five consecutive ranks ending at each top from `lowTop`
/// to the ace.
fn runs(low_top: u8) -> impl Iterator<Item = StraightWindow> {
    (low_top..=12).map(|top| StraightWindow {
        ranks: [top - 4, top - 3, top - 2, top - 1, top],
        top,
    })
}

use HandCategory::{
    Flush, FullHouse, HighCard, Pair, Quads, Straight, StraightFlush, Trips, TwoPair,
};

/// `STANDARD`: the 52-card deck; the wheel A-2-3-4-5 plays as a five-high
/// straight.
pub static STANDARD: LazyLock<RankingTable> = LazyLock::new(|| {
    let windows: Vec<StraightWindow> = std::iter::once(StraightWindow {
        ranks: [12, 0, 1, 2, 3],
        top: 3,
    })
    .chain(runs(4))
    .collect();
    ranking_table(
        TableName::Standard,
        &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        &windows,
        [
            HighCard,
            Pair,
            TwoPair,
            Trips,
            Straight,
            Flush,
            FullHouse,
            Quads,
            StraightFlush,
        ],
    )
});

fn short_deck_windows() -> Vec<StraightWindow> {
    std::iter::once(StraightWindow {
        ranks: [12, 4, 5, 6, 7],
        top: 7,
    })
    .chain(runs(8))
    .collect()
}

const SHORT_DECK_RANKS: &[u8] = &[4, 5, 6, 7, 8, 9, 10, 11, 12];

/// `SHORT_DECK`: sixes to aces; A-6-7-8-9 is the low straight (nine-high); a
/// flush beats a full house and three of a kind beats a straight.
pub static SHORT_DECK: LazyLock<RankingTable> = LazyLock::new(|| {
    ranking_table(
        TableName::ShortDeck,
        SHORT_DECK_RANKS,
        &short_deck_windows(),
        [
            HighCard,
            Pair,
            TwoPair,
            Straight,
            Trips,
            FullHouse,
            Flush,
            Quads,
            StraightFlush,
        ],
    )
});

/// `SHORT_DECK_STRAIGHT_OVER_TRIPS`: the same deck with a straight over three
/// of a kind (GGPoker); a flush still beats a full house.
pub static SHORT_DECK_STRAIGHT_OVER_TRIPS: LazyLock<RankingTable> = LazyLock::new(|| {
    ranking_table(
        TableName::ShortDeckStraightOverTrips,
        SHORT_DECK_RANKS,
        &short_deck_windows(),
        [
            HighCard,
            Pair,
            TwoPair,
            Trips,
            Straight,
            FullHouse,
            Flush,
            Quads,
            StraightFlush,
        ],
    )
});

/// `ShortDeckRule`: where a room ranks three of a kind against a straight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShortDeckRule {
    TripsOverStraight,
    StraightOverTrips,
}

impl ShortDeckRule {
    /// The TypeScript string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TripsOverStraight => "trips-over-straight",
            Self::StraightOverTrips => "straight-over-trips",
        }
    }
}

/// `SHORT_DECK_RULE_BY_SITE`, keyed by `meta.siteId`: the one place the rule
/// is decided; a room that is not listed is `trips-over-straight`. GGPoker
/// pays a straight over trips (`fixtures/samples/ggpoker/12-…`, see
/// `evaluator.ts` for the evidence).
pub const SHORT_DECK_RULE_BY_SITE: &[(&str, ShortDeckRule)] =
    &[("ggpoker", ShortDeckRule::StraightOverTrips)];

/// `shortDeckRuleFor(siteId)`: the room's rule (the id JavaScript-trimmed and
/// lower-cased), the classic one unless the map says otherwise.
pub fn short_deck_rule_for(site_id: &str) -> ShortDeckRule {
    let key = crate::js::to_lower_case(crate::js::trim(site_id));
    SHORT_DECK_RULE_BY_SITE
        .iter()
        .find(|(site, _)| *site == key)
        .map_or(ShortDeckRule::TripsOverStraight, |(_, rule)| *rule)
}

/// `shortDeckTable(rule)` (the TypeScript default is `trips-over-straight`).
pub fn short_deck_table(rule: ShortDeckRule) -> &'static RankingTable {
    match rule {
        ShortDeckRule::StraightOverTrips => &SHORT_DECK_STRAIGHT_OVER_TRIPS,
        ShortDeckRule::TripsOverStraight => &SHORT_DECK,
    }
}

/* ------------------------------------------------------------ evaluator - */

/// `evaluateMasks`: the value of the best five-card hand in the cards the
/// four suit masks describe. The hot path; at most seven cards (see
/// `evaluator.ts` for why the evaluation order below then holds for every
/// table).
pub fn evaluate_masks(table: &RankingTable, s: u32, h: u32, d: u32, c: u32) -> u32 {
    let pop = |mask: u32| POP[at(mask)];
    let top = |mask: u32| TOP[at(mask)];
    let top5 = |mask: u32| TOP5[at(mask)];

    let flush = if pop(s) >= 5 {
        s
    } else if pop(h) >= 5 {
        h
    } else if pop(d) >= 5 {
        d
    } else if pop(c) >= 5 {
        c
    } else {
        0
    };
    if flush != 0 {
        let straight = u32::from(table.straight(flush));
        if straight != 0 {
            return table.shift(StraightFlush) | ((straight - 1) << 16);
        }
        return table.shift(Flush) | top5(flush);
    }

    let ranks = s | h | d | c;
    let quads = s & h & d & c;
    if quads != 0 {
        let quad = top(quads);
        return table.shift(Quads) | (quad << 16) | (top(ranks ^ (1 << quad)) << 12);
    }

    // Ranks held an odd number of times, then the ranks held in at least three
    // suits; with quads excluded the latter are exactly the trips, and what is
    // in `ranks` but not `odd` exactly the pairs.
    let odd = s ^ h ^ d ^ c;
    let trips = ((s & h) | (d & c)) & ((s & d) | (h & c));
    let pairs = ranks & !odd;

    if trips != 0 {
        let trip = top(trips);
        let filler = (trips ^ (1 << trip)) | pairs;
        if filler != 0 {
            return table.shift(FullHouse) | (trip << 16) | (top(filler) << 12);
        }
    }

    let straight = u32::from(table.straight(ranks));
    let straight_value = if straight != 0 {
        table.shift(Straight) | ((straight - 1) << 16)
    } else {
        0
    };

    let made = if trips != 0 {
        let trip = top(trips);
        table.shift(Trips) | (trip << 16) | (top5(ranks ^ (1 << trip)) >> 12)
    } else if pop(pairs) >= 2 {
        let high = top(pairs);
        let low = top(pairs ^ (1 << high));
        let kicker = top(ranks ^ (1 << high) ^ (1 << low));
        table.shift(TwoPair) | (high << 16) | (low << 12) | (kicker << 8)
    } else if pairs != 0 {
        let pair = top(pairs);
        table.shift(Pair) | (pair << 16) | (top5(ranks ^ (1 << pair)) >> 8)
    } else {
        table.shift(HighCard) | top5(ranks)
    };
    straight_value.max(made)
}

/// `suitMasks`: the suit masks `[s, h, d, c]` of card indices (each < 52).
pub fn suit_masks(cards: &[u8]) -> [u32; 4] {
    let mut masks = [0_u32; 4];
    for card in cards {
        masks[usize::from(card & 3)] |= 1 << (card >> 2);
    }
    masks
}

/// The index of a card code, or the evaluator's `not a card: …` error.
pub(crate) fn index_or_throw(card: &str) -> Result<u8, JsError> {
    card_index(card).ok_or_else(|| JsError::new(format!("not a card: {card}")))
}

/// The same check for an index (`index < 0 || index > 51`).
fn checked_index(index: u8) -> Result<u8, JsError> {
    if index > 51 {
        return Err(JsError::new(format!("not a card: {index}")));
    }
    Ok(index)
}

/// `evaluate(cards, table)` for card codes: the value of the best five-card
/// hand among 5 to 7 cards. An invalid code is an error, as the TypeScript
/// throws on it.
pub fn evaluate<S: AsRef<str>>(cards: &[S], table: &RankingTable) -> Result<u32, JsError> {
    let indices = cards
        .iter()
        .map(|card| index_or_throw(card.as_ref()))
        .collect::<Result<Vec<u8>, JsError>>()?;
    let [s, h, d, c] = suit_masks(&indices);
    Ok(evaluate_masks(table, s, h, d, c))
}

/// `evaluate(cards, table)` for card indices; one past 51 is an error.
pub fn evaluate_indices(cards: &[u8], table: &RankingTable) -> Result<u32, JsError> {
    let indices = cards
        .iter()
        .map(|card| checked_index(*card))
        .collect::<Result<Vec<u8>, JsError>>()?;
    let [s, h, d, c] = suit_masks(&indices);
    Ok(evaluate_masks(table, s, h, d, c))
}

/// `categoryOf(value, table)`; `None` for a value no evaluation produces.
pub fn category_of(value: u32, table: &RankingTable) -> Option<HandCategory> {
    table
        .by_strength
        .get(usize::try_from(value >> 20).ok()?)
        .copied()
}

#[cfg(test)]
mod tests;
