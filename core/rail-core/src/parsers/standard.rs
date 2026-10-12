//! `standard`: the app's own standard text, read back in
//! (`frontend/src/lib/parsers/standard.ts`).
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
            Ok(Some(hand)) => Ok(hand),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_its_own_header_and_only_weakly_the_rooms_that_share_it() {
        let parser = StandardParser;
        assert_eq!(parser.detect("x\nPoker Hand #1: y"), 900);
        assert_eq!(parser.detect("x\rPoker Hand #1: y"), 900);
        assert_eq!(parser.detect("PokerStars Hand #1: y"), 250);
        assert_eq!(parser.detect("x\u{2028}GG Hand #1: y"), 250);
        assert_eq!(parser.detect(" Poker Hand #1: y"), 0);
        assert_eq!(parser.detect("poker hand #1: y"), 0);
        let source = include_str!("../../../../frontend/src/lib/parsers/standard.ts");
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
