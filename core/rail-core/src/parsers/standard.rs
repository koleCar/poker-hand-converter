//! `standard`: the app's own standard text, read back in
//! (`web/src/lib/parsers/standard.ts`).
//!
//! Re-uploading a file this app produced has to work - users download the
//! converted text, import it into a tracker, and drop the same file back in -
//! and this parser is also what makes `parse(serialize(h)) == h` testable.
//! It scores low on the headers real rooms share (`PokerStars Hand #`,
//! `GG Hand #`) so that a dedicated parser always wins those.
//!
//! The reader itself is [`crate::phf::serialize`].

use std::sync::LazyLock;

use regex::Regex;

use crate::detect::{ParseError, SiteParser, SiteParserContext, SplitError};
use crate::phf::serialize::{
    STANDARD_TEXT_PARSER_VERSION, StandardContext, parse_standard_hand, split_standard_hands,
};
use crate::phf::{PhfHand, Variant};

/// `/^Poker Hand #/m` without the `m`, tried at every JavaScript line start.
static OWN: LazyLock<Regex> = crate::js_regex_lazy!(r"^Poker Hand #", "");
/// `/^(?:PokerStars|GG) Hand #/m`, likewise.
static SHARED: LazyLock<Regex> = crate::js_regex_lazy!(r"^(?:PokerStars|GG) Hand #", "");

/// `standardParser`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StandardParser;

impl SiteParser for StandardParser {
    fn id(&self) -> &'static str {
        "standard"
    }

    fn name(&self) -> &'static str {
        "Rail standard"
    }

    fn version(&self) -> &'static str {
        STANDARD_TEXT_PARSER_VERSION
    }

    /// 0.9 for our own `Poker Hand #` at a line start (JavaScript's `m`:
    /// after `\n`, `\r`, U+2028 or U+2029), 0.25 for `PokerStars Hand #` /
    /// `GG Hand #`, so a room's own parser outranks this one.
    fn detect(&self, text: &str) -> u32 {
        if crate::phf::serialize::matches_at_line_start(&OWN, text) {
            900
        } else if crate::phf::serialize::matches_at_line_start(&SHARED, text) {
            250
        } else {
            0
        }
    }

    fn split_hands(&self, text: &str) -> Result<Vec<String>, SplitError> {
        Ok(split_standard_hands(text))
    }

    fn parse_hand(&self, raw: &str, ctx: &SiteParserContext<'_>) -> Result<PhfHand, ParseError> {
        let context = StandardContext {
            site_id: "standard",
            site_name: "Rail standard",
            original_filename: ctx.source_filename,
            parser_id: Some("standard"),
            parser_version: Some(STANDARD_TEXT_PARSER_VERSION),
            parsed_at: ctx.parsed_at(),
        };
        match parse_standard_hand(raw, &context) {
            Ok(Some(mut hand)) => {
                label_origin(&mut hand);
                Ok(hand)
            }
            Ok(None) => Err(ParseError::Bug("Not a standard-format hand.".to_owned())),
            Err(thrown) => Err(ParseError::Bug(thrown.message)),
        }
    }

    /// Every Omaha Hi/Lo hand a room parser converts is written out in this
    /// format and has to come back in (the halves are read from the cards).
    fn hi_lo_variants(&self) -> &'static [Variant] {
        &[Variant::Omaha]
    }

    /// Likewise every short-deck hand.
    fn short_deck(&self) -> bool {
        true
    }
}

/// `GG_CASH_HAND_ID` (`/^HD\d+$/`): GG's own cash hand id. Public for the
/// desktop store, whose migration 21 moves the hands an older build filed
/// under `standard`.
pub fn is_gg_cash_hand_id(id: &str) -> bool {
    id.strip_prefix("HD")
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// `labelOrigin`: a plain GG cash hand is read by this parser on purpose (see
/// `parsers/ggpoker.rs`) but is still a GGPoker hand, and the room is what the
/// user filters and groups by. The hand key stays the bare id, so the stored
/// `ggpoker:<id>` matches what the GG parser would write for the same hand.
fn label_origin(hand: &mut PhfHand) {
    if is_gg_cash_hand_id(&hand.meta.hand_id) {
        "ggpoker".clone_into(&mut hand.meta.site_id);
        "GGPoker".clone_into(&mut hand.meta.site_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_gg_cash_hand_is_labelled_ggpoker() {
        assert!(is_gg_cash_hand_id("HD2735958902"));
        for other in ["HD", "HDx1", "RC2735958902", "2735958902", "hd1", " HD1"] {
            assert!(!is_gg_cash_hand_id(other), "{other}");
        }
        let source = include_str!("../../../../web/src/lib/parsers/standard.ts");
        assert!(source.contains(r"GG_CASH_HAND_ID = /^HD\d+$/;"));
        assert!(source.contains(r#"hand.meta.siteId = "ggpoker";"#));
        assert!(source.contains(r#"hand.meta.siteName = "GGPoker";"#));
    }

    #[test]
    fn claims_its_own_header_and_only_weakly_the_rooms_that_share_it() {
        let parser = StandardParser;
        assert_eq!(parser.detect("x\nPoker Hand #1: y"), 900);
        assert_eq!(parser.detect("x\rPoker Hand #1: y"), 900);
        assert_eq!(parser.detect("PokerStars Hand #1: y"), 250);
        assert_eq!(parser.detect("x\u{2028}GG Hand #1: y"), 250);
        assert_eq!(parser.detect(" Poker Hand #1: y"), 0);
        assert_eq!(parser.detect("poker hand #1: y"), 0);
        let source = include_str!("../../../../web/src/lib/parsers/standard.ts");
        for pattern in [r"/^Poker Hand #/m", r"/^(?:PokerStars|GG) Hand #/m"] {
            assert!(source.contains(pattern), "{pattern}");
        }
        for (id, name) in [
            ("id", "standard"),
            ("name", "Rail standard"),
            ("hiLoVariants", "omaha"),
        ] {
            assert!(
                source.contains(&format!("{id}: \"{name}\""))
                    || source.contains(&format!("{id}: [\"{name}\"]")),
                "{id}"
            );
        }
        assert!(source.contains("shortDeck: true"));
        assert!(source.contains("return 0.9;") && source.contains("return 0.25;"));
        assert!(source.contains(r#"throw new Error("Not a standard-format hand.");"#));
    }
}
