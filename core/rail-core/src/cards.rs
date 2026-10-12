//! Card codes: the parts of `frontend/src/lib/cards.ts` the core needs -
//! reading a card (`parseCard`, which the validator and the evaluator use),
//! pulling cards out of text (`extractCards`, which the parsers use) and rank
//! order (`rankValue`). The starting-hand classes (`handClass`,
//! `omahaHandClass`) belong to the stats engine (R2.1) and the filter-box
//! helpers to the UI; neither is here.

/// `RANKS`: deuce to ace; a rank's index is its [`rank_value`].
pub const RANKS: [char; 13] = [
    '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
];

/// `SUIT_ORDER`: spades, hearts, diamonds, clubs - also the suit order of the
/// evaluator's card index ([`crate::eval::card_index`]).
pub const SUITS: [char; 4] = ['s', 'h', 'd', 'c'];

/// `Card`: a parsed card. `rank` is the index into [`RANKS`] (0 = deuce),
/// `suit` the index into [`SUITS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Card {
    pub rank: u8,
    pub suit: u8,
}

impl Card {
    /// The rank character, `'2'`..`'A'`.
    pub fn rank_char(self) -> char {
        RANKS[usize::from(self.rank)]
    }

    /// The suit character, `'s'`, `'h'`, `'d'` or `'c'`.
    pub fn suit_char(self) -> char {
        SUITS[usize::from(self.suit)]
    }

    /// `card.code`: the canonical two-character code, e.g. `"Ah"`.
    pub fn code(self) -> String {
        let mut code = String::with_capacity(2);
        code.push(self.rank_char());
        code.push(self.suit_char());
        code
    }
}

fn index_of(set: &[char], c: char) -> Option<u8> {
    set.iter()
        .position(|candidate| *candidate == c)
        .and_then(|i| u8::try_from(i).ok())
}

/// `parseCard`: `"Ah"`, `"ah"`, `"AH"` (JavaScript-trimmed) into a card;
/// `None` for junk.
///
/// The TypeScript checks `trimmed.length !== 2` in UTF-16 code units and then
/// upper-cases the first unit and lower-cases the second. Only ASCII can pass:
/// no non-ASCII character's case mapping is a single rank or suit letter
/// (`ı` → `I`, `ſ` → `S` and the Kelvin sign `K` → `k` are the near misses,
/// and none of `I`, `S`, `k` is a rank or a suit), and a lone surrogate
/// half maps to itself. So a two-*byte* ASCII string is the whole domain.
pub fn parse_card(raw: &str) -> Option<Card> {
    let trimmed = crate::js::trim(raw);
    let &[rank, suit] = trimmed.as_bytes() else {
        return None;
    };
    if !rank.is_ascii() || !suit.is_ascii() {
        return None;
    }
    let rank = index_of(&RANKS, char::from(rank.to_ascii_uppercase()))?;
    let suit = index_of(&SUITS, char::from(suit.to_ascii_lowercase()))?;
    Some(Card { rank, suit })
}

/// `rankValue`: the rank's index in [`RANKS`] (deuce 0, ace 12); `None` for
/// a character that is not a rank.
pub fn rank_value(rank: char) -> Option<u8> {
    index_of(&RANKS, rank)
}

/// `extractCards`: every distinct card code in free text, in order of first
/// appearance, canonicalised - `"Ah Kd"`, `"AhKd"`, `"[Ah Kd]"`, comma
/// separated. The TypeScript is `raw.match(/[2-9TJQKAtjqka][shdcSHDC]/g)`:
/// non-overlapping two-character matches, left to right. Both characters are
/// ASCII, and an ASCII byte never occurs inside a multi-byte UTF-8 sequence,
/// so scanning bytes finds exactly the matches JavaScript finds.
pub fn extract_cards(raw: &str) -> Vec<String> {
    let bytes = raw.as_bytes();
    let is_rank = |b: u8| {
        matches!(
            b,
            b'2'..=b'9' | b'T' | b'J' | b'Q' | b'K' | b'A' | b't' | b'j' | b'q' | b'k' | b'a'
        )
    };
    let is_suit = |b: u8| matches!(b, b's' | b'h' | b'd' | b'c' | b'S' | b'H' | b'D' | b'C');
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if is_rank(bytes[i]) && is_suit(bytes[i + 1]) {
            let card = Card {
                rank: index_of(&RANKS, char::from(bytes[i].to_ascii_uppercase())).unwrap_or(0),
                suit: index_of(&SUITS, char::from(bytes[i + 1].to_ascii_lowercase())).unwrap_or(0),
            };
            let code = card.code();
            if !out.contains(&code) {
                out.push(code);
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_any_case_and_trims_like_javascript() {
        assert_eq!(parse_card("Ah").map(Card::code).as_deref(), Some("Ah"));
        assert_eq!(parse_card("ah").map(Card::code).as_deref(), Some("Ah"));
        assert_eq!(parse_card("AH").map(Card::code).as_deref(), Some("Ah"));
        assert_eq!(
            parse_card(" tC\u{FEFF}").map(Card::code).as_deref(),
            Some("Tc")
        );
        assert_eq!(
            parse_card("\u{A0}Qd").map(Card::code).as_deref(),
            Some("Qd")
        );
        // U+0085 is not JavaScript whitespace.
        assert_eq!(parse_card("\u{85}Qd"), None);
        for junk in [
            "",
            "A",
            "Ahh",
            "10h",
            "1s",
            "Xx",
            "Ka",
            "ıs",
            "Aſ",
            "A\u{212A}",
        ] {
            assert_eq!(parse_card(junk), None, "{junk:?}");
        }
        assert_eq!(parse_card("2c"), Some(Card { rank: 0, suit: 3 }));
        assert_eq!(rank_value('A'), Some(12));
        assert_eq!(rank_value('1'), None);
    }

    #[test]
    fn extracts_distinct_cards_from_free_text() {
        assert_eq!(extract_cards("[Ah Kd]"), ["Ah", "Kd"]);
        assert_eq!(extract_cards("AhKd,ah, 2C"), ["Ah", "Kd", "2c"]);
        // Non-overlapping, left to right: "AKs" reads K-s, not A-K.
        assert_eq!(extract_cards("AKs"), ["Ks"]);
        assert_eq!(extract_cards("€Ah😀Td"), ["Ah", "Td"]);
        assert!(extract_cards("no cards 10").is_empty());
    }
}
