//! The source check and the line-start probes written as code. The parser's
//! behaviour is held to the TypeScript by `tests/golden_sites.rs` (the
//! corpus), `tests/p2pb_vectors.rs` (mutated hands) and
//! `tests/p2pb_parsers.rs` (the translated tests).

use super::*;

const SOURCE: &str = include_str!("../../../../../frontend/src/lib/parsers/pokerbros.ts");

#[test]
fn patterns_are_the_typescript_source() {
    let source = SOURCE.replace("\r\n", "\n");
    let banner = format!("/{PARTY_BANNER_BODY}\\s*$/im");
    for literal in [
        banner.as_str(),
        r"/^PokerBros Hand #(\d+):\s*(.*)$/",
        r"/^PokerBros Hand #\d+:/",
        r"/^PokerBros Hand #\d+:/m",
        r"/(?=^PokerBros Hand #\d+:)/m",
        r"/(?=^\*{3,}\s*Hand History for Game\s+\d+\s*\*{3,}\s*\(PokerBros\))/m",
        r"/\bPokerBros\b/",
        r"/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/",
        r"/^\s*(\S+)\/(\S+)/",
        r"/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/",
        r"/^Table\s+(.+?)\s+\((Real|Play) Money\)\s*$/i",
        r"/^Seat\s+(\d+)\s+is the button\s*$/i",
        r"/^Seat\s+(\d+):\s+(.+?)\s+\(\s*([^)]*?)\s*\)(?:\s+-\s+\(([^)]*)\))?\s*$/",
        r"/^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?/i",
        r"/^Total number of players\s*:\s*(\d+)/i",
        r"/(?:texas\s+)?hold\s*'?em|holdem/i",
        r"/^Dealt to\s+(.+?)\s*\[\s*([^\]]*?)\s*\]\s*$/",
        r"/^(.+?)\s+posts\s+(small|big)\s+blind\s+\[([^\]]*)\]\.?\s*$/i",
        r"/^(.+?)\s+(folds|checks)\s*$/i",
        r"/^(.+?)\s+(bets|calls|raises)\s+\[([^\]]*)\]\s*$/i",
        r"/^(.+?)\s+wins\s+([^\s]+)\s*(?:USD|EUR|GBP)?\s*(?:from (?:the )?(.+?))?\s*$/i",
        r"/[^\d.,]/g",
        "/^\u{FEFF}/",
        r"/\r?\n/",
    ] {
        assert!(source.contains(literal), "{literal}");
    }
    assert!(source.contains("export const POKERBROS_PARSER_VERSION = \"1.0.0\";"));
}

/// `/…\s*$/im` - recorded from Node: the banner must end its JavaScript line
/// (any terminator) or the text.
#[test]
fn the_banner_ends_a_javascript_line() {
    let banner = "***** Hand History for Game 1 ***** (PokerBros)";
    for (text, expected) in [
        (banner.to_owned(), true),
        (format!("{banner}  "), true),
        (format!("{banner} \n x"), true),
        (format!("{banner}\r"), true),
        (format!("{banner} \u{2028}x"), true),
        (format!("{banner} x"), false),
        (format!("x\u{2029}{banner}"), true),
        (format!("x {banner}"), false),
        (
            "***** hand history for game 1 ***** (pokerbros)".to_owned(),
            true,
        ),
        (format!("{banner}x\n{banner}"), true),
    ] {
        assert_eq!(party_banner(&text).is_some(), expected, "{text:?}");
    }
}

#[test]
fn the_button_is_the_seat_before_the_small_blind() {
    assert_eq!(
        button_before_small_blind(&[1, 3, 4, 5, 6], Some(3)),
        Some(1)
    );
    assert_eq!(button_before_small_blind(&[6, 1, 3], Some(1)), Some(6));
    assert_eq!(button_before_small_blind(&[2, 7], Some(7)), Some(7));
    assert_eq!(button_before_small_blind(&[2, 7], None), None);
    assert_eq!(button_before_small_blind(&[2], Some(2)), None);
    assert_eq!(button_before_small_blind(&[2, 4, 5], Some(3)), None);
}
