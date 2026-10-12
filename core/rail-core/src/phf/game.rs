//! Game descriptors and table geometry: the "descriptors" functions of
//! `frontend/src/lib/phf/types.ts` - reading a variant and the hi/lo flag out
//! of a room's game label, the deck and deal size of a variant, and the pure
//! position geometry (`positionRing`, `resolvePositions`, `hasDeadButton`,
//! `buttonBlindRing`).
//!
//! `assignPositions`, which resolves positions from a hand's blinds, is
//! R0.5b's (`crate::positions`); it builds on the geometry here.
//!
//! The label readers are the TypeScript regular expressions verbatim, compiled
//! with JavaScript semantics by [`crate::js::regex`]; a test checks each one
//! still appears, character for character, in `types.ts`.

use std::sync::LazyLock;

use regex::Regex;

use super::{PhfHand, Position, Variant};

/// `cardInDeck`: whether a card (already parsed) can be dealt in the variant.
/// Short deck strips the deuces through fives; every other game deals 52.
pub fn card_in_deck(code: &str, variant: Variant) -> bool {
    variant != Variant::Shortdeck || !code.starts_with(['2', '3', '4', '5'])
}

/// `holeCardCount`: hole cards the variant deals, or `None` for games whose
/// deal changes by street (stud, razz, draw) and `other`.
pub fn hole_card_count(variant: Variant) -> Option<u32> {
    match variant {
        Variant::Holdem | Variant::Shortdeck => Some(2),
        Variant::Omaha => Some(4),
        Variant::Omaha5 => Some(5),
        Variant::Omaha6 => Some(6),
        Variant::Stud | Variant::Razz | Variant::Draw | Variant::Other => None,
    }
}

/// The `(pattern, flags)` pairs of `variantFromLabel`, in order, with the
/// variant each one decides.
const VARIANT_PATTERNS: [(&str, &str, Variant); 8] = [
    (
        r"6\s*card\s*omaha|omaha\s*6|\bPLO-?6\b",
        "i",
        Variant::Omaha6,
    ),
    (
        r"5\s*card\s*omaha|omaha\s*5|\bPLO-?5\b",
        "i",
        Variant::Omaha5,
    ),
    (r"omaha|omahl|\bPLO\b|\bNLO\b", "i", Variant::Omaha),
    (
        r"short\s*deck|6\s*\+|\bsix[\s-]*plus\b",
        "i",
        Variant::Shortdeck,
    ),
    (r"\brazz\b", "i", Variant::Razz),
    (r"\bstud\b", "i", Variant::Stud),
    (r"\bdraw\b|badugi", "i", Variant::Draw),
    (r"hold\s*'?em", "i", Variant::Holdem),
];

static VARIANT_REGEXES: LazyLock<Vec<(Regex, Variant)>> = LazyLock::new(|| {
    VARIANT_PATTERNS
        .iter()
        .map(|(pattern, flags, variant)| (crate::js::regex::js_regex(pattern, flags), *variant))
        .collect()
});

/// `variantFromLabel`: the deal a room's game label describes. `Omaha Hi/Lo`
/// is `omaha` - hi/lo is the award rule, answered by [`is_hi_lo_label`].
pub fn variant_from_label(label: &str) -> Variant {
    VARIANT_REGEXES
        .iter()
        .find(|(regex, _)| regex.is_match(label))
        .map_or(Variant::Other, |(_, variant)| *variant)
}

/// The `(pattern, flags)` pairs of `isHiLoLabel`.
const HI_LO_PATTERNS: [(&str, &str); 7] = [
    (r"\bhi[\s/._-]?lo(?:w)?\b", "i"),
    (r"\bh\s?\/\s?l\b", "i"),
    (r"omahl", "i"),
    (r"\b(?:PL|NL|FL)?O-?8\b", "i"),
    (r"\bomaha[\s/-]*8\b", "i"),
    (r"\bstud[\s/-]*8\b", "i"),
    (r"\b(?:8|eight)[\s-]*or[\s-]*better\b", "i"),
];

static HI_LO_REGEXES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    HI_LO_PATTERNS
        .iter()
        .map(|(pattern, flags)| crate::js::regex::js_regex(pattern, flags))
        .collect()
});

/// `isHiLoLabel`: every spelling of "high-low split" in the corpus.
/// Deliberately generous; only ever fed a game label, never a whole hand.
pub fn is_hi_lo_label(label: &str) -> bool {
    HI_LO_REGEXES.iter().any(|regex| regex.is_match(label))
}

/// `positionRing(n)`: position names from the small blind around to the
/// button for `n` players dealt in. Heads-up is `[SB, BB]` - no seat is `BTN`.
pub fn position_ring(n: usize) -> Vec<Position> {
    use Position::{Bb, Btn, Co, Hj, Lj, Mp, Sb, Utg, Utg1, Utg2};
    match n {
        0 => vec![],
        1 => vec![Btn],
        2 => vec![Sb, Bb],
        3 => vec![Sb, Bb, Btn],
        4 => vec![Sb, Bb, Co, Btn],
        5 => vec![Sb, Bb, Utg, Co, Btn],
        6 => vec![Sb, Bb, Utg, Hj, Co, Btn],
        7 => vec![Sb, Bb, Utg, Lj, Hj, Co, Btn],
        8 => vec![Sb, Bb, Utg, Utg1, Lj, Hj, Co, Btn],
        9 => vec![Sb, Bb, Utg, Utg1, Utg2, Lj, Hj, Co, Btn],
        _ => {
            // 10+: pad the middle with MP so the named seats keep their meaning.
            let mut ring = vec![Sb, Bb, Utg, Utg1, Utg2];
            ring.extend(std::iter::repeat_n(Mp, n - 9));
            ring.extend([Lj, Hj, Co, Btn]);
            ring
        }
    }
}

/// Sets `seat` in an insertion-ordered map, as `Map.prototype.set` does: a new
/// key goes last, an existing one keeps its place and takes the new value.
pub(crate) fn map_set<K: PartialEq, V>(map: &mut Vec<(K, V)>, key: K, value: V) {
    if let Some(slot) = map.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = value;
    } else {
        map.push((key, value));
    }
}

/// `resolvePositions(seatNumbers, buttonSeat)`: pure geometry, every seat to
/// its position, as `(seat, position)` pairs in the order the TypeScript `Map`
/// iterates them. Empty when the button is unknown or not among the seats.
pub fn resolve_positions(seat_numbers: &[u32], button_seat: Option<u32>) -> Vec<(u32, Position)> {
    let mut out = Vec::new();
    let mut seats = seat_numbers.to_vec();
    seats.sort_unstable();
    let Some(button_seat) = button_seat else {
        return out;
    };
    let Some(button_index) = seats.iter().position(|seat| *seat == button_seat) else {
        return out;
    };
    let ring = position_ring(seats.len());
    // ring[0] is the small blind: one past the button, except heads-up.
    let small_blind_index = if seats.len() == 2 {
        button_index
    } else {
        (button_index + 1) % seats.len()
    };
    for (offset, position) in ring.iter().enumerate() {
        map_set(
            &mut out,
            seats[(small_blind_index + offset) % seats.len()],
            *position,
        );
    }
    out
}

/// `dealtInSeatsOf`: seats that took part - anyone who put a chip in or made a
/// move - in seat order; every seated player when fewer than two acted.
pub fn dealt_in_seats(hand: &PhfHand) -> Vec<u32> {
    let mut seated: Vec<u32> = hand.players.iter().map(|player| player.seat).collect();
    seated.sort_unstable();
    let acted = |seat: &u32| hand.actions.iter().any(|action| action.seat == Some(*seat));
    let dealt_in: Vec<u32> = seated.iter().copied().filter(acted).collect();
    if dealt_in.len() >= 2 {
        dealt_in
    } else {
        seated
    }
}

/// `hasDeadButton(hand, dealtInSeats?)`: the button is on a seat that was not
/// dealt in.
pub fn has_dead_button(hand: &PhfHand, dealt_in: Option<&[u32]>) -> bool {
    let Some(button_seat) = hand.table.button_seat else {
        return false;
    };
    let computed;
    let seats = if let Some(seats) = dealt_in {
        seats
    } else {
        computed = dealt_in_seats(hand);
        &computed
    };
    !seats.is_empty() && !seats.contains(&button_seat)
}

/// `buttonBlindRing(n)`: the ring of an ante-only table whose one blind is the
/// button's - seats named by their distance from the button, as if the two
/// blind seats did not exist.
pub fn button_blind_ring(n: usize) -> Vec<Position> {
    if n == 0 {
        return vec![];
    }
    position_ring(n + 2).split_off(2)
}

#[cfg(test)]
mod tests {
    //! The label tests of `tests/test/phfOmaha.test.ts` and
    //! `tests/test/shortDeck.test.ts`, and the geometry tests of
    //! `tests/test/phfPositions.test.ts` ("resolvePositions (pure geometry)").

    use super::*;
    use Position::{Bb, Btn, Co, Hj, Sb, Utg};

    #[test]
    fn every_pattern_is_the_typescript_source_verbatim() {
        let types_ts = include_str!("../../../../frontend/src/lib/phf/types.ts");
        let patterns = VARIANT_PATTERNS
            .iter()
            .map(|(pattern, flags, _)| (*pattern, *flags))
            .chain(HI_LO_PATTERNS);
        for (pattern, flags) in patterns {
            let literal = format!("/{pattern}/{flags}");
            assert!(
                types_ts.contains(&literal),
                "{literal} is not in types.ts any more"
            );
        }
        assert!(types_ts.contains("!/^[2-5]/.test(code)"));
    }

    #[test]
    fn reads_every_hi_lo_spelling_the_sample_corpus_contains() {
        for label in [
            "Omaha Hi/Lo Pot Limit",
            "Omaha Hi/Lo Limit",
            "7 Card Stud Hi/Lo Limit",
            "PL Omaha Hi-Lo",
            "Omaha Hi/Lo Fixed Limit",
            "Omaha H/L",
            "OMAHA HiLo",
            "Omaha HiLow",
            "GAME_OMAHL",
            "PLO8",
            "Omaha/8",
            "$1/$2 Omaha 8 or Better",
        ] {
            assert!(is_hi_lo_label(label), "{label}");
        }
    }

    #[test]
    fn does_not_see_hi_lo_where_there_is_none() {
        for label in [
            "Hold'em No Limit",
            "Omaha Pot Limit",
            "Omaha Hi",
            "PLO-5",
            "PLO",
            "5 Card Omaha Pot Limit",
            "ShortDeck No Limit",
            "Razz Limit",
            "NL Hold'em 8-max",
            "Badugi Limit",
            // JavaScript's `\b` and `/i` are ASCII: these are not word
            // boundaries / letters to it.
            "OMAHA_HI_LO",
            "Omaha \u{17F}tud 8",
        ] {
            assert!(!is_hi_lo_label(label), "{label}");
        }
    }

    #[test]
    fn keeps_the_variant_deal_shaped() {
        assert_eq!(variant_from_label("Omaha Hi/Lo Pot Limit"), Variant::Omaha);
        assert_eq!(variant_from_label("5 Card Omaha Hi/Lo"), Variant::Omaha5);
        assert_eq!(variant_from_label("7 Card Stud Hi/Lo Limit"), Variant::Stud);
        assert_eq!(
            hole_card_count(variant_from_label("Omaha Hi/Lo Pot Limit")),
            Some(4)
        );
    }

    #[test]
    fn reads_every_omaha_and_short_deck_label_the_rooms_print() {
        for (label, variant) in [
            ("Omaha Pot Limit", Variant::Omaha),
            ("PLO", Variant::Omaha),
            ("Omaha No Limit", Variant::Omaha),
            ("Omaha (NL postflop)", Variant::Omaha),
            ("PLO-5", Variant::Omaha5),
            ("5 Card Omaha Pot Limit", Variant::Omaha5),
            ("PLO-6", Variant::Omaha6),
            ("6 Card Omaha Pot Limit", Variant::Omaha6),
            ("ShortDeck No Limit", Variant::Shortdeck),
            ("6+ Hold'em", Variant::Shortdeck),
            ("Hold'em No Limit", Variant::Holdem),
            // shortDeck.test.ts
            ("Six Plus Hold'em", Variant::Shortdeck),
            // and the rest of the ladder
            ("Razz Limit", Variant::Razz),
            ("Badugi", Variant::Draw),
            ("2-7 Triple Draw", Variant::Draw),
            ("Holdem", Variant::Holdem),
            ("Courchevel", Variant::Other),
            ("", Variant::Other),
        ] {
            assert_eq!(variant_from_label(label), variant, "{label}");
        }
    }

    #[test]
    fn knows_how_many_cards_each_deal_gives_a_seat() {
        assert_eq!(hole_card_count(Variant::Holdem), Some(2));
        assert_eq!(hole_card_count(Variant::Shortdeck), Some(2));
        assert_eq!(hole_card_count(Variant::Omaha), Some(4));
        assert_eq!(hole_card_count(Variant::Omaha5), Some(5));
        assert_eq!(hole_card_count(Variant::Omaha6), Some(6));
        assert_eq!(hole_card_count(Variant::Stud), None);
        assert_eq!(hole_card_count(Variant::Draw), None);
    }

    #[test]
    fn the_short_deck_is_thirty_six_cards() {
        for rank in ["2", "3", "4", "5"] {
            assert!(!card_in_deck(&format!("{rank}c"), Variant::Shortdeck));
            assert!(card_in_deck(&format!("{rank}c"), Variant::Holdem));
        }
        for card in ["6c", "Tc", "Ac"] {
            assert!(card_in_deck(card, Variant::Shortdeck));
        }
    }

    fn as_map(pairs: Vec<(u32, Position)>) -> std::collections::BTreeMap<u32, Position> {
        pairs.into_iter().collect()
    }

    fn expect(pairs: &[(u32, Position)]) -> std::collections::BTreeMap<u32, Position> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn puts_the_small_blind_on_the_button_heads_up() {
        assert_eq!(
            as_map(resolve_positions(&[1, 2], Some(1))),
            expect(&[(1, Sb), (2, Bb)])
        );
        assert_eq!(
            as_map(resolve_positions(&[1, 2], Some(2))),
            expect(&[(2, Sb), (1, Bb)])
        );
    }

    #[test]
    fn is_heads_up_correct_with_non_adjacent_seat_numbers() {
        assert_eq!(
            as_map(resolve_positions(&[3, 7], Some(7))),
            expect(&[(7, Sb), (3, Bb)])
        );
        assert_eq!(
            as_map(resolve_positions(&[3, 7], Some(3))),
            expect(&[(3, Sb), (7, Bb)])
        );
    }

    #[test]
    fn labels_no_seat_btn_heads_up() {
        assert!(
            resolve_positions(&[1, 2], Some(1))
                .iter()
                .all(|(_, p)| *p != Btn)
        );
        assert_eq!(position_ring(2), vec![Sb, Bb]);
    }

    #[test]
    fn keeps_the_button_on_the_button_three_handed() {
        assert_eq!(
            as_map(resolve_positions(&[1, 2, 3], Some(3))),
            expect(&[(1, Sb), (2, Bb), (3, Btn)])
        );
        assert_eq!(
            as_map(resolve_positions(&[1, 2, 3], Some(1))),
            expect(&[(2, Sb), (3, Bb), (1, Btn)])
        );
        assert_eq!(
            as_map(resolve_positions(&[1, 2, 3], Some(2))),
            expect(&[(3, Sb), (1, Bb), (2, Btn)])
        );
    }

    #[test]
    fn orders_a_six_max_and_a_nine_handed_table() {
        assert_eq!(
            as_map(resolve_positions(&[1, 2, 3, 4, 5, 6], Some(6))),
            expect(&[(1, Sb), (2, Bb), (3, Utg), (4, Hj), (5, Co), (6, Btn)])
        );
        let nine = as_map(resolve_positions(&[1, 2, 3, 4, 5, 6, 7, 8, 9], Some(9)));
        assert_eq!(nine.get(&1), Some(&Sb));
        assert_eq!(nine.get(&2), Some(&Bb));
        assert_eq!(nine.get(&3), Some(&Utg));
        assert_eq!(nine.get(&9), Some(&Btn));
    }

    #[test]
    fn refuses_to_guess_when_the_button_is_unknown_or_not_seated() {
        assert!(resolve_positions(&[1, 2, 3], None).is_empty());
        assert!(resolve_positions(&[1, 2, 3], Some(5)).is_empty());
        assert!(resolve_positions(&[], Some(1)).is_empty());
    }

    #[test]
    fn iterates_like_the_typescript_map() {
        // Insertion order starts at the small blind; a duplicate seat keeps
        // its first place and takes the later value.
        assert_eq!(
            resolve_positions(&[3, 1, 2], Some(1)),
            vec![(2, Sb), (3, Bb), (1, Btn)]
        );
        assert_eq!(
            resolve_positions(&[1, 1, 2], Some(1)),
            vec![(1, Btn), (2, Bb)]
        );
    }

    #[test]
    fn pads_big_tables_and_names_button_blind_tables_from_the_button() {
        let ten = position_ring(10);
        assert_eq!(ten.len(), 10);
        assert_eq!(ten[5], Position::Mp);
        assert_eq!(
            position_ring(12)
                .iter()
                .filter(|p| **p == Position::Mp)
                .count(),
            3
        );
        assert_eq!(button_blind_ring(0), vec![]);
        assert_eq!(button_blind_ring(1), vec![Btn]);
        assert_eq!(button_blind_ring(5), vec![Utg, Position::Lj, Hj, Co, Btn]);
    }
}
