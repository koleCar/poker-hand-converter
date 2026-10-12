//! `tests/test/equityEvaluator.test.ts` (all of it: the named hands, and the
//! random hands against a brute-force reference that shares no code with the
//! evaluator), the evaluator tests of `tests/test/shortDeck.test.ts` ("trips
//! against a straight, per room", minus the equity ones, which are R2.2), and
//! "the eight-or-better low" of `tests/test/phfHiLo.test.ts`.
//!
//! The random hands come from the same generator with the same seeds as the
//! TypeScript (`mulberry32`, in integer arithmetic: `floor(random() * n)` is
//! `(u * n) >> 32` exactly for a 32-bit `u` and a small `n`), so these are the
//! very hands the TypeScript checks.

use super::omaha::{evaluate_omaha, evaluate_omaha_low};
use super::*;

/* ------------------------------------------------------------ reference - */

const STANDARD_ORDER: [HandCategory; 9] = HAND_CATEGORIES;
const SHORT_ORDER: [HandCategory; 9] = [
    HighCard,
    Pair,
    TwoPair,
    Straight,
    Trips,
    FullHouse,
    Flush,
    Quads,
    StraightFlush,
];

#[derive(Debug, Clone)]
struct RefHand {
    category: HandCategory,
    /// Category strength, then the tiebreak ranks: compare lexicographically.
    key: Vec<i32>,
}

/// Five cards, the slow way.
fn reference5(cards: &[u8], short: bool) -> RefHand {
    let mut ranks: Vec<i32> = cards.iter().map(|card| i32::from(card >> 2)).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    let flush = cards.iter().all(|card| card & 3 == cards[0] & 3);
    let mut distinct = ranks.clone();
    distinct.dedup();
    let mut straight_top = -1;
    if distinct.len() == 5 {
        if ranks[0] - ranks[4] == 4 {
            straight_top = ranks[0];
        } else if !short && ranks == [12, 3, 2, 1, 0] {
            straight_top = 3;
        } else if short && ranks == [12, 7, 6, 5, 4] {
            straight_top = 7;
        }
    }
    let mut groups: Vec<(i32, usize)> = Vec::new();
    for rank in &ranks {
        match groups.iter_mut().find(|(r, _)| r == rank) {
            Some((_, count)) => *count += 1,
            None => groups.push((*rank, 1)),
        }
    }
    groups.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));
    let shape: String = groups.iter().map(|(_, count)| count.to_string()).collect();

    let category = if straight_top >= 0 && flush {
        StraightFlush
    } else if shape == "41" {
        Quads
    } else if shape == "32" {
        FullHouse
    } else if flush {
        Flush
    } else if straight_top >= 0 {
        Straight
    } else if shape == "311" {
        Trips
    } else if shape == "221" {
        TwoPair
    } else if shape == "2111" {
        Pair
    } else {
        HighCard
    };
    let order = if short { SHORT_ORDER } else { STANDARD_ORDER };
    let strength = order.iter().position(|c| *c == category).unwrap_or(0);
    let mut key = vec![i32::try_from(strength).unwrap_or(0)];
    if straight_top >= 0 {
        key.push(straight_top);
    } else {
        key.extend(groups.iter().map(|(rank, _)| *rank));
    }
    RefHand { category, key }
}

fn compare_keys(a: &[i32], b: &[i32]) -> i32 {
    for i in 0..a.len().max(b.len()) {
        let diff = a.get(i).copied().unwrap_or(-1) - b.get(i).copied().unwrap_or(-1);
        if diff != 0 {
            return diff;
        }
    }
    0
}

fn subsets(items: &[u8], k: usize) -> Vec<Vec<u8>> {
    if k == 0 {
        return vec![Vec::new()];
    }
    items
        .iter()
        .enumerate()
        .flat_map(|(i, item)| {
            subsets(&items[i + 1..], k - 1)
                .into_iter()
                .map(move |rest| {
                    let mut out = vec![*item];
                    out.extend(rest);
                    out
                })
        })
        .collect()
}

fn best_of(hands: Vec<RefHand>) -> RefHand {
    let mut iter = hands.into_iter();
    let first = iter.next().expect("at least one hand");
    iter.fold(first, |best, hand| {
        if compare_keys(&hand.key, &best.key) > 0 {
            hand
        } else {
            best
        }
    })
}

fn reference(cards: &[u8], short: bool) -> RefHand {
    best_of(
        subsets(cards, 5)
            .iter()
            .map(|five| reference5(five, short))
            .collect(),
    )
}

fn reference_omaha(hole: &[u8], board: &[u8]) -> RefHand {
    let mut hands = Vec::new();
    for two in subsets(hole, 2) {
        for three in subsets(board, 3) {
            let mut five = two.clone();
            five.extend(three);
            hands.push(reference5(&five, false));
        }
    }
    best_of(hands)
}

/// `mulberry32(seed)`, returning the 32-bit integer the TypeScript divides by
/// 2^32.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }

    /// `Math.floor(random() * n)`.
    fn below(&mut self, n: usize) -> usize {
        let n = u64::try_from(n).expect("small");
        usize::try_from((u64::from(self.next()) * n) >> 32).expect("below n")
    }
}

/// `dealer(seed, ranks)`: `count` distinct random cards from the deck built
/// of `ranks`, the deck carrying over between deals.
struct Dealer {
    random: Mulberry32,
    deck: Vec<u8>,
}

impl Dealer {
    fn new(seed: u32, ranks: &[u8]) -> Self {
        Self {
            random: Mulberry32(seed),
            deck: ranks
                .iter()
                .flat_map(|rank| (0..4).map(move |suit| rank * 4 + suit))
                .collect(),
        }
    }

    fn deal(&mut self, count: usize) -> Vec<u8> {
        for i in 0..count {
            let j = i + self.random.below(self.deck.len() - i);
            self.deck.swap(i, j);
        }
        self.deck[..count].to_vec()
    }
}

fn describe(cards: &[u8]) -> String {
    cards
        .iter()
        .map(|card| card_code(*card).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Sorts by the fast value and checks the reference agrees on every adjacent
/// pair: same order, equal exactly where the fast values are equal.
fn expect_same_order(values: &[u32], refs: &[RefHand], hands: &[Vec<u8>]) {
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by_key(|i| values[*i]);
    for pair in order.windows(2) {
        let (lo, hi) = (pair[0], pair[1]);
        let reference = compare_keys(&refs[lo].key, &refs[hi].key).signum();
        let fast = if values[hi] == values[lo] { 0 } else { -1 };
        assert_eq!(
            reference,
            fast,
            "order disagrees: {} vs {}",
            describe(&hands[lo]),
            describe(&hands[hi])
        );
    }
}

/* ---------------------------------------------------------------- tests - */

fn cards(text: &str) -> Vec<&str> {
    text.split(' ').collect()
}

fn category(text: &str, table: &RankingTable) -> HandCategory {
    category_of(value(text, table), table).expect("a category")
}

fn value(text: &str, table: &RankingTable) -> u32 {
    evaluate(&cards(text), table).expect("valid cards")
}

#[test]
fn names_every_category() {
    let s = &*STANDARD;
    assert_eq!(category("Ah Kd 9c 7s 4h 3d 2c", s), HighCard);
    assert_eq!(category("Ah Ad 9c 7s 4h 3d 2c", s), Pair);
    assert_eq!(category("Ah Ad 9c 9s 4h 3d 2c", s), TwoPair);
    assert_eq!(category("Ah Ad Ac 9s 4h 3d 2c", s), Trips);
    assert_eq!(category("Th Jd Qc Ks Ah 3d 2c", s), Straight);
    assert_eq!(category("2h 7h 9h Jh Kh 3d 2c", s), Flush);
    assert_eq!(category("Ah Ad Ac 9s 9h 3d 2c", s), FullHouse);
    assert_eq!(category("Ah Ad Ac As 9h 3d 2c", s), Quads);
    assert_eq!(category("9h Th Jh Qh Kh 3d 2c", s), StraightFlush);
}

#[test]
fn ranks_the_categories_in_the_usual_order() {
    let ladder: Vec<u32> = [
        "Ah Kd 9c 7s 4h",
        "2h 2d 3c 4s 6h",
        "2h 2d 3c 3s 4h",
        "2h 2d 2c 3s 4h",
        "Ah 2d 3c 4s 5h",
        "2h 3h 4h 5h 7h",
        "2h 2d 2c 3s 3h",
        "2h 2d 2c 2s 3h",
        "Ah 2h 3h 4h 5h",
    ]
    .iter()
    .map(|hand| value(hand, &STANDARD))
    .collect();
    for pair in ladder.windows(2) {
        assert!(pair[1] > pair[0], "{ladder:?}");
    }
}

#[test]
fn plays_the_wheel_as_a_five_high_straight() {
    let s = &*STANDARD;
    assert_eq!(category("Ah 2d 3c 4s 5h", s), Straight);
    assert!(value("Ah 2d 3c 4s 5h", s) < value("2h 3d 4c 5s 6h", s));
    // ...and the steel wheel as the lowest straight flush.
    assert!(value("Ah 2h 3h 4h 5h", s) < value("2h 3h 4h 5h 6h", s));
    assert_eq!(category("Ah 2h 3h 4h 5h", s), StraightFlush);
}

#[test]
fn does_not_wrap_a_straight_round_the_ace() {
    assert_eq!(category("Qh Kd Ac 2s 3h", &STANDARD), HighCard);
}

#[test]
fn settles_kickers_and_ties() {
    let s = &*STANDARD;
    assert!(value("Ah Ad Kc 7s 4h 3d 2c", s) > value("Ah Ad Qc 7s 4h 3d 2c", s));
    // The board plays: the sixth and seventh cards are irrelevant.
    assert_eq!(
        value("Ah Kh Qh Jh 9d 3c 2c", s),
        value("Ah Kh Qh Jh 9d 4c 2s", s)
    );
    // Three pairs: the third pair's rank can still be the kicker.
    assert!(value("Ah Ad Kc Ks 9h 9d 2c", s) > value("Ah Ad Kc Ks 8h 8d 2c", s));
    // Two trips make a full house with the lower trips as the pair.
    assert_eq!(category("Ah Ad Ac Ks Kh Kd 2c", s), FullHouse);
    assert_eq!(
        value("Ah Ad Ac Ks Kh Kd 2c", s),
        value("Ah Ad Ac Ks Kh 3d 2c", s)
    );
}

#[test]
fn evaluates_five_six_and_seven_cards() {
    let s = &*STANDARD;
    assert_eq!(category("Ah Ad Ac 9s 9h", s), FullHouse);
    assert_eq!(category("Ah Ad Ac 9s 9h 2c", s), FullHouse);
    assert_eq!(category("Ah Ad Ac 9s 9h 2c 3d", s), FullHouse);
}

fn random_hands(seed: u32, ranks: &[u8], count: usize, size: usize) -> Vec<Vec<u8>> {
    let mut dealer = Dealer::new(seed, ranks);
    (0..count).map(|_| dealer.deal(size)).collect()
}

#[test]
fn agrees_with_the_brute_force_reference_on_4000_random_seven_card_hands() {
    let hands = random_hands(7, STANDARD.deck_ranks, 4000, 7);
    let values: Vec<u32> = hands
        .iter()
        .map(|hand| evaluate_indices(hand, &STANDARD).expect("cards"))
        .collect();
    let refs: Vec<RefHand> = hands.iter().map(|hand| reference(hand, false)).collect();
    for (i, hand) in hands.iter().enumerate() {
        assert_eq!(
            category_of(values[i], &STANDARD),
            Some(refs[i].category),
            "{}",
            describe(hand)
        );
    }
    expect_same_order(&values, &refs, &hands);
}

#[test]
fn agrees_with_the_reference_on_five_and_six_card_hands() {
    for size in [5, 6] {
        let seed = u32::try_from(size).expect("small");
        let hands = random_hands(seed, STANDARD.deck_ranks, 2000, size);
        let values: Vec<u32> = hands
            .iter()
            .map(|hand| evaluate_indices(hand, &STANDARD).expect("cards"))
            .collect();
        let refs: Vec<RefHand> = hands.iter().map(|hand| reference(hand, false)).collect();
        expect_same_order(&values, &refs, &hands);
    }
}

#[test]
fn the_seeded_dealer_deals_what_the_typescript_deals() {
    // The first hand of `dealer(7, STANDARD.deckRanks)` and the first values
    // of `mulberry32(7)`, from Node.
    let mut random = Mulberry32(7);
    assert_eq!(random.next(), 50_271_532);
    let mut dealer = Dealer::new(7, STANDARD.deck_ranks);
    assert_eq!(describe(&dealer.deal(7)), "2s 3s Ad Jh 9h 8s 8c");
}

#[test]
fn short_deck_plays_a_6_7_8_9_as_the_lowest_straight() {
    let sd = &*SHORT_DECK;
    assert_eq!(category("Ah 6d 7c 8s 9h", sd), Straight);
    assert!(value("Ah 6d 7c 8s 9h", sd) < value("6h 7d 8c 9s Th", sd));
    assert_eq!(category("Ah 6h 7h 8h 9h", sd), StraightFlush);
    // The same five cards are nothing in a full deck.
    assert_eq!(category("Ah 6d 7c 8s 9h", &STANDARD), HighCard);
}

#[test]
fn short_deck_ranks_a_flush_over_a_full_house() {
    let sd = &*SHORT_DECK;
    assert!(value("6h 8h Th Qh Ah", sd) > value("Ah Ad Ac Ks Kh", sd));
    assert!(value("6h 8h Th Qh Ah", &STANDARD) < value("Ah Ad Ac Ks Kh", &STANDARD));
}

#[test]
fn short_deck_ranks_three_of_a_kind_over_a_straight() {
    let sd = &*SHORT_DECK;
    assert!(value("6h 6d 6c 8s 9h", sd) > value("Th Jd Qc Ks Ah", sd));
    assert!(value("6h 6d 6c 8s 9h", &STANDARD) < value("Th Jd Qc Ks Ah", &STANDARD));
}

#[test]
fn short_deck_picks_the_flush_over_the_full_house_when_seven_cards_make_both() {
    let hand = "Ah Kh Qh 9h 6h Ad Ac";
    assert_eq!(category(hand, &SHORT_DECK), Flush);
    assert_eq!(category(hand, &STANDARD), Flush);
}

#[test]
fn short_deck_agrees_with_the_brute_force_reference_on_4000_random_seven_card_hands() {
    let hands = random_hands(11, SHORT_DECK.deck_ranks, 4000, 7);
    let values: Vec<u32> = hands
        .iter()
        .map(|hand| evaluate_indices(hand, &SHORT_DECK).expect("cards"))
        .collect();
    let refs: Vec<RefHand> = hands.iter().map(|hand| reference(hand, true)).collect();
    for (i, hand) in hands.iter().enumerate() {
        assert_eq!(
            category_of(values[i], &SHORT_DECK),
            Some(refs[i].category),
            "{}",
            describe(hand)
        );
    }
    expect_same_order(&values, &refs, &hands);
}

#[test]
fn omaha_needs_two_hearts_from_the_hand_for_a_flush() {
    let board = ["2h", "5h", "9h", "Jh", "Kc"];
    let omaha = |hole: [&str; 4]| {
        category_of(
            evaluate_omaha(&hole, &board, &STANDARD).expect("cards"),
            &STANDARD,
        )
    };
    assert_eq!(omaha(["Ah", "As", "Kd", "Qs"]), Some(Pair));
    assert_eq!(omaha(["Ah", "3h", "Kd", "Qs"]), Some(Flush));
}

#[test]
fn omaha_uses_exactly_three_from_the_board() {
    let omaha = |hole: [&str; 4], board: [&str; 5]| {
        category_of(
            evaluate_omaha(&hole, &board, &STANDARD).expect("cards"),
            &STANDARD,
        )
    };
    // Four to a straight on board and one connector in hand is not a straight.
    assert_eq!(
        omaha(["9c", "Qs", "Qd", "2s"], ["5h", "6c", "7d", "8s", "Kc"]),
        Some(Pair)
    );
    // A board flush with no hearts in hand is no flush at all.
    assert_eq!(
        omaha(["As", "Ad", "Kc", "Ks"], ["2h", "4h", "6h", "8h", "Th"]),
        Some(Pair)
    );
}

#[test]
fn omaha_agrees_with_the_brute_force_reference_on_random_plo_and_plo5_hands() {
    for hole_count in [4_usize, 5] {
        let seed = u32::try_from(hole_count * 13).expect("small");
        let hands = random_hands(seed, STANDARD.deck_ranks, 800, hole_count + 5);
        let values: Vec<u32> = hands
            .iter()
            .map(|cards| {
                let codes: Vec<String> = cards.iter().filter_map(|c| card_code(*c)).collect();
                evaluate_omaha(&codes[..hole_count], &codes[hole_count..], &STANDARD)
                    .expect("cards")
            })
            .collect();
        let refs: Vec<RefHand> = hands
            .iter()
            .map(|cards| reference_omaha(&cards[..hole_count], &cards[hole_count..]))
            .collect();
        expect_same_order(&values, &refs, &hands);
    }
}

#[test]
fn omaha_refuses_junk_with_the_typescript_messages() {
    let error = |hole: &[&str], board: &[&str]| {
        evaluate_omaha(hole, board, &STANDARD)
            .expect_err("junk")
            .message
    };
    assert_eq!(
        error(&["Ah"], &["2c", "3c", "4c"]),
        "Omaha needs at least two hole cards and three board cards"
    );
    assert_eq!(
        error(&["Ah", "Kh"], &["2c", "3c"]),
        "Omaha needs at least two hole cards and three board cards"
    );
    // The hole cards are read before the board.
    assert_eq!(error(&["Ah", "Xx"], &["Yy", "3c", "4c"]), "not a card: Xx");
    assert_eq!(
        error(&["Ah", "Kd"], &["2c", "10h", "4c"]),
        "not a card: 10h"
    );
    assert_eq!(
        evaluate_omaha_low(&["Ah", "2d"], &["Q", "3c", "4c"])
            .expect_err("junk")
            .message,
        "not a card: Q"
    );
    assert_eq!(
        evaluate(&["Ah", "Kd", "", "2c", "3c"], &STANDARD)
            .expect_err("junk")
            .message,
        "not a card: "
    );
    assert_eq!(
        evaluate_indices(&[0, 1, 2, 3, 52], &STANDARD)
            .expect_err("junk")
            .message,
        "not a card: 52"
    );
    assert_eq!(card_code(52), None);
    assert_eq!(card_code(51).as_deref(), Some("Ac"));
    assert_eq!(card_index("ah"), Some(49));
}

/* ------------------------------------------- the eight-or-better low --- */

fn low(ranks: [u32; 5]) -> u32 {
    ranks.iter().fold(0, |sum, rank| sum * 9 + rank)
}

#[test]
fn the_low_plays_exactly_two_cards_from_the_hand_and_three_from_the_board() {
    // 2-4 from the hand, A-3-5 from the board: a wheel, the best low there is.
    assert_eq!(
        evaluate_omaha_low(&["2s", "4c", "Kd", "Kh"], &["Ah", "3d", "5c", "Jh", "Qs"]),
        Ok(Some(low([5, 4, 3, 2, 1])))
    );
    // One low card in the hand is not a low, however good the board.
    assert_eq!(
        evaluate_omaha_low(&["2s", "Kc", "Kd", "Qh"], &["Ah", "3d", "5c", "4h", "6s"]),
        Ok(None)
    );
    // Two low board cards are not enough either.
    assert_eq!(
        evaluate_omaha_low(&["2s", "3c", "Kd", "Qh"], &["Ah", "4d", "Jc", "Th", "9s"]),
        Ok(None)
    );
}

#[test]
fn the_low_is_counterfeited_by_a_pair_and_lower_wins() {
    // A-2 in the hand with an ace on the board: the hand's ace is dead weight.
    assert_eq!(
        evaluate_omaha_low(&["Ac", "2c", "Kd", "Qh"], &["Ah", "2d", "7c", "8h", "9s"]),
        Ok(None)
    );
    let seven_six = evaluate_omaha_low(&["2s", "3c", "Kd", "Qh"], &["Ah", "6d", "7c", "Jh", "Qs"])
        .expect("cards")
        .expect("a low");
    let eight_five = evaluate_omaha_low(&["2s", "3c", "Kd", "Qh"], &["Ah", "5d", "8c", "Jh", "Qs"])
        .expect("cards")
        .expect("a low");
    assert!(seven_six < eight_five);
}

/* --------------------------------------- trips against a straight, per room */

// Fixture 12, first board: GG paid the straight (`951600 showed [Qs Ks] and
// won ($1,354) with Aces-High Straight`, `1802531 ... [Td Ts] and lost with
// Three Tens`). That payout is the whole evidence for GG's rule; the hand
// itself is checked in `tests/golden_checks.rs`.
const BOARD: [&str; 5] = ["Tc", "8h", "Ah", "6h", "Jd"];

#[test]
fn reproduces_gg_s_fixture_12_payout_under_gg_s_table_and_the_reverse_under_the_classic_one() {
    let straight: Vec<&str> = ["Qs", "Ks"].into_iter().chain(BOARD).collect();
    let set: Vec<&str> = ["Td", "Ts"].into_iter().chain(BOARD).collect();
    let gg = &*SHORT_DECK_STRAIGHT_OVER_TRIPS;
    let eval = |cards: &[&str], table: &RankingTable| evaluate(cards, table).expect("cards");
    assert_eq!(category_of(eval(&straight, gg), gg), Some(Straight));
    assert_eq!(category_of(eval(&set, gg), gg), Some(Trips));
    assert!(eval(&straight, gg) > eval(&set, gg));
    assert!(eval(&straight, &SHORT_DECK) < eval(&set, &SHORT_DECK));
    // Both tables still put a flush over a full house.
    for table in [&*SHORT_DECK, &*SHORT_DECK_STRAIGHT_OVER_TRIPS] {
        assert!(
            eval(&["6h", "8h", "Th", "Qh", "Ah"], table)
                > eval(&["Ah", "Ad", "Ac", "Ks", "Kh"], table)
        );
    }
}

#[test]
fn the_short_deck_rule_is_decided_in_one_place_and_only_gg_leaves_the_default() {
    assert_eq!(
        short_deck_rule_for("ggpoker"),
        ShortDeckRule::StraightOverTrips
    );
    assert_eq!(
        short_deck_rule_for(" GGPoker\u{FEFF}"),
        ShortDeckRule::StraightOverTrips
    );
    assert_eq!(
        short_deck_rule_for("acrwpn"),
        ShortDeckRule::TripsOverStraight
    );
    assert_eq!(
        short_deck_rule_for("standard"),
        ShortDeckRule::TripsOverStraight
    );
    assert_eq!(
        short_deck_table(ShortDeckRule::TripsOverStraight),
        &*SHORT_DECK
    );
    assert_eq!(
        short_deck_table(short_deck_rule_for("ggpoker"))
            .name
            .as_str(),
        "short-deck-straight-over-trips"
    );
}

#[test]
fn every_table_keeps_the_typescript_category_order() {
    let names = |table: &RankingTable| -> Vec<&str> {
        table.by_strength().iter().map(|c| c.as_str()).collect()
    };
    assert_eq!(
        names(&SHORT_DECK_STRAIGHT_OVER_TRIPS),
        [
            "high-card",
            "pair",
            "two-pair",
            "trips",
            "straight",
            "full-house",
            "flush",
            "quads",
            "straight-flush"
        ]
    );
    assert_eq!(STANDARD.shift(Straight), 4 << 20);
    assert_eq!(SHORT_DECK.shift(Straight), 3 << 20);
    assert_eq!(SHORT_DECK.shift(Flush), 6 << 20);
}
