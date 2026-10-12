//! The per-parser variant allowlist and the canonical game label
//! (`frontend/src/lib/parsers/shared/variant-lock.ts`).
//!
//! A variant goes on a parser's list only once that parser's own fixtures for
//! it come out clean; short deck is its own entry, tested by spelling before
//! the list; hi/lo is a separate list ([`OMAHA_HI_LO`], `SiteParser::
//! hi_lo_variants`) checked first by [`crate::detect::unsupported_game_skip`].
//! The patterns are the TypeScript source verbatim (a test checks), compiled
//! with JavaScript semantics.

use std::sync::LazyLock;

use regex::Regex;

use crate::detect::{ParseSkip, SkipReason, short_deck_skip};
use crate::js;
use crate::js::regex::js_regex;
use crate::phf::{LimitType, Variant, variant_from_label};

/// Hold'em only: the list a parser has until its own fixtures say otherwise.
pub const HOLDEM_ONLY: &[Variant] = &[Variant::Holdem];
/// Hold'em plus four-card Omaha.
pub const HOLDEM_OMAHA: &[Variant] = &[Variant::Holdem, Variant::Omaha];
/// Hold'em, four-card Omaha and short deck.
pub const HOLDEM_OMAHA_SHORTDECK: &[Variant] =
    &[Variant::Holdem, Variant::Omaha, Variant::Shortdeck];
/// Hold'em plus the whole big-O family.
pub const HOLDEM_OMAHA_FAMILY: &[Variant] = &[
    Variant::Holdem,
    Variant::Omaha,
    Variant::Omaha5,
    Variant::Omaha6,
];
/// The hi/lo list of a parser whose four-card Omaha Hi/Lo fixtures are clean.
pub const OMAHA_HI_LO: &[Variant] = &[Variant::Omaha];
/// No hi/lo at all.
pub const NO_HI_LO: &[Variant] = &[];

/// `isShortDeckLabel`'s patterns, in order.
const SHORT_DECK_PATTERNS: [(&str, &str); 4] = [
    (r"short\s*deck", "i"),
    (r"\b6\s*\+", ""),
    (r"\bsix[\s-]*plus\b", "i"),
    (r"\bshortdeck\b", "i"),
];

static SHORT_DECK: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    SHORT_DECK_PATTERNS
        .iter()
        .map(|(pattern, flags)| js_regex(pattern, flags))
        .collect()
});

/// `isShortDeckLabel`: every spelling of short deck in the corpus, plus the
/// near misses. Deliberately generous.
pub fn is_short_deck_label(label: &str) -> bool {
    SHORT_DECK.iter().any(|regex| regex.is_match(label))
}

/// `normalizeGameName`'s two regex replacements (the first is `_` → space).
const NORMALIZE_PATTERNS: [(&str, &str, &str); 2] = [
    (r"(\d)\s*-\s*card\b", "gi", "${1} card"),
    (r"\b(omaha|stud)\s*-?\s*h\s*\/?\s*l\b", "gi", "${1} Hi/Lo"),
];

static NORMALIZE: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    NORMALIZE_PATTERNS
        .iter()
        .map(|(pattern, flags, replacement)| (js_regex(pattern, flags), *replacement))
        .collect()
});

/// `normalizeGameName`: a room's own game name spelled the way the shared
/// readers expect - `OMAHA_HI_LO` → `OMAHA HI LO`, `5-Card Omaha` →
/// `5 card Omaha`, `Pot Limit OmahaHL` → `Pot Limit Omaha Hi/Lo`.
pub fn normalize_game_name(label: &str) -> String {
    let mut out = label.replace('_', " ");
    for (regex, replacement) in NORMALIZE.iter() {
        out = regex.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// `variantOf`: the variant a room's own game name describes.
pub fn variant_of(label: &str) -> Variant {
    variant_from_label(&normalize_game_name(label))
}

/// `describe`: human wording for a variant, for refusal messages.
fn describe(variant: Variant) -> &'static str {
    match variant {
        Variant::Holdem => "Hold'em",
        Variant::Omaha => "Omaha",
        Variant::Omaha5 => "five-card Omaha",
        Variant::Omaha6 => "six-card Omaha",
        Variant::Shortdeck => "short-deck Hold'em",
        Variant::Stud => "seven-card stud",
        Variant::Razz => "razz",
        Variant::Draw => "a draw game",
        Variant::Other => "a game this converter does not recognise",
    }
}

/// `listOf`: `a`, `a and b`, `a, b and c`.
fn list_of(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// `unsupportedVariantSkip(label, allowed)`: the refusal for a variant this
/// parser has not been proven against, or `None`. Call it after
/// [`crate::detect::unsupported_game_skip`] so hi/lo keeps its own reason.
pub fn unsupported_variant_skip(label: &str, allowed: &[Variant]) -> Option<ParseSkip> {
    let trimmed = js::trim(label);
    let named = if trimmed.is_empty() {
        "This hand".to_owned()
    } else {
        format!("\"{trimmed}\"")
    };
    if is_short_deck_label(&normalize_game_name(label)) {
        return if allowed.contains(&Variant::Shortdeck) && variant_of(label) == Variant::Shortdeck {
            None
        } else {
            Some(short_deck_skip(label))
        };
    }
    let variant = variant_of(label);
    if allowed.contains(&variant) {
        return None;
    }
    let reads: Vec<&str> = allowed.iter().copied().map(describe).collect();
    Some(ParseSkip::new(
        SkipReason::UnsupportedVariant,
        format!(
            "{named} is {}, which this parser has not been verified against. It reads {}.",
            describe(variant),
            list_of(&reads)
        ),
    ))
}

/// `canonicalGameLabel(variant, limit, hiLo)`: the PokerStars-worded label
/// the standard-text readers round-trip (`Omaha Hi/Lo Pot Limit`).
pub fn canonical_game_label(variant: Variant, limit: LimitType, hi_lo: bool) -> String {
    let game = match variant {
        Variant::Omaha => "Omaha",
        Variant::Omaha5 => "5 Card Omaha",
        Variant::Omaha6 => "6 Card Omaha",
        Variant::Shortdeck => "6+ Hold'em",
        _ => "Hold'em",
    };
    let suffix = match limit {
        LimitType::Pl => "Pot Limit",
        LimitType::Fl => "Limit",
        LimitType::Nl => "No Limit",
    };
    format!("{game}{} {suffix}", if hi_lo { " Hi/Lo" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phf::is_hi_lo_label;

    const SOURCE: &str =
        include_str!("../../../../../frontend/src/lib/parsers/shared/variant-lock.ts");

    #[test]
    fn every_pattern_is_the_typescript_source_verbatim() {
        for (pattern, flags) in SHORT_DECK_PATTERNS {
            let literal = format!("/{pattern}/{flags}");
            assert!(SOURCE.contains(&literal), "{literal}");
        }
        for (pattern, flags, replacement) in NORMALIZE_PATTERNS {
            let js_replacement = replacement.replace("${1}", "$1");
            let literal = format!("/{pattern}/{flags}, \"{js_replacement}\"");
            assert!(SOURCE.contains(&literal), "{literal}");
        }
        assert!(SOURCE.contains(r#".replace(/_/g, " ")"#));
    }

    #[test]
    fn short_deck_spellings() {
        for label in [
            "Six Plus Hold'em",
            "NLHold'em Short Deck",
            "Short Deck",
            "6+ Hold'em",
            "ShortDeck",
            "six-plus",
        ] {
            assert!(is_short_deck_label(label), "{label}");
        }
        for label in ["Hold'em No Limit", "16+ players", "Omaha"] {
            assert!(!is_short_deck_label(label), "{label}");
        }
    }

    #[test]
    fn normalizes_the_room_spellings_the_shared_readers_miss() {
        assert_eq!(normalize_game_name("OMAHA_HI_LO"), "OMAHA HI LO");
        assert!(is_hi_lo_label(&normalize_game_name("OMAHA_HI_LO")));
        assert!(!is_hi_lo_label("OMAHA_HI_LO"));
        assert_eq!(
            normalize_game_name("Pot Limit OmahaHL"),
            "Pot Limit Omaha Hi/Lo"
        );
        assert_eq!(
            normalize_game_name("5-Card Omaha High"),
            "5 card Omaha High"
        );
        assert_eq!(variant_of("5-Card Omaha High"), Variant::Omaha5);
        assert_eq!(normalize_game_name("Stud H/L"), "Stud Hi/Lo");
        assert_eq!(normalize_game_name("PLO-5"), "PLO-5");
        assert_eq!(variant_of("PLO-5"), Variant::Omaha5);
    }

    #[test]
    fn refuses_unlisted_variants_with_the_typescript_wording() {
        assert!(unsupported_variant_skip("Hold'em No Limit", HOLDEM_ONLY).is_none());
        let skip = unsupported_variant_skip(" Omaha Pot Limit ", HOLDEM_ONLY).expect("refused");
        assert_eq!(skip.reason, SkipReason::UnsupportedVariant);
        assert_eq!(
            skip.message,
            "\"Omaha Pot Limit\" is Omaha, which this parser has not been verified against. \
             It reads Hold'em."
        );
        let skip = unsupported_variant_skip("Razz", HOLDEM_OMAHA_FAMILY).expect("refused");
        assert_eq!(
            skip.message,
            "\"Razz\" is razz, which this parser has not been verified against. It reads \
             Hold'em, Omaha, five-card Omaha and six-card Omaha."
        );
        let skip = unsupported_variant_skip("", NO_HI_LO).expect("refused");
        assert_eq!(
            skip.message,
            "This hand is a game this converter does not recognise, which this parser has \
             not been verified against. It reads ."
        );
    }

    #[test]
    fn short_deck_needs_its_own_entry() {
        let skip = unsupported_variant_skip("Six Plus Hold'em", HOLDEM_OMAHA).expect("refused");
        assert!(
            skip.message
                .starts_with("\"Six Plus Hold'em\" is a short-deck game")
        );
        assert!(unsupported_variant_skip("Six Plus Hold'em", HOLDEM_OMAHA_SHORTDECK).is_none());
        assert!(unsupported_variant_skip("ShortDeck No Limit", HOLDEM_OMAHA_SHORTDECK).is_none());
    }

    #[test]
    fn canonical_labels_round_trip_through_the_readers() {
        // phfOmahaParsers.test.ts asserts this over every combination.
        for variant in [
            Variant::Holdem,
            Variant::Omaha,
            Variant::Omaha5,
            Variant::Omaha6,
            Variant::Shortdeck,
        ] {
            for limit in [LimitType::Nl, LimitType::Pl, LimitType::Fl] {
                for hi_lo in [false, true] {
                    let label = canonical_game_label(variant, limit, hi_lo);
                    assert_eq!(variant_from_label(&label), variant, "{label}");
                    assert_eq!(is_hi_lo_label(&label), hi_lo, "{label}");
                }
            }
        }
        assert_eq!(
            canonical_game_label(Variant::Omaha, LimitType::Pl, true),
            "Omaha Hi/Lo Pot Limit"
        );
        assert_eq!(
            canonical_game_label(Variant::Shortdeck, LimitType::Nl, false),
            "6+ Hold'em No Limit"
        );
        assert_eq!(
            canonical_game_label(Variant::Stud, LimitType::Fl, false),
            "Hold'em Limit"
        );
    }
}
