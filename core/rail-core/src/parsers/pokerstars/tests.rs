//! The source check and the hand-written probes. The parser's behaviour is
//! held to the TypeScript by `tests/golden_sites.rs` (the corpus),
//! `tests/psgg_vectors.rs` (mutated hands) and `tests/psgg_parsers.rs` (the
//! translated `pokerstarsParser.test.ts`).

use super::*;

const SOURCE: &str = include_str!("../../../../../frontend/src/lib/parsers/pokerstars.ts");

const LITERALS: &[&str] = &[
    r"/^PokerStars(?: ([A-Za-z ]+?))? (?:Hand|Game) #(\d+):\s*(?:\{([^}]*)\}\s*)?(.*)$/",
    r"/^PokerStars(?: [A-Za-z ]+?)? (?:Hand|Game) #\d+:/",
    r"/^Table '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$/",
    r"/^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$/",
    r"/^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i",
    r#"["FIRST", "SECOND", "THIRD", "FOURTH"]"#,
    r"/and is all-in/",
    r"/^(.+?) wins (?:the )?(\S+) (?:bounty|for splitting the elimination)\b.*$/",
    r"/^\s*(\S+)\/(\S+)/",
    r"/^Tournament #(\S+?), (.+?) - (?:Match Round ([IVXLCDM]+), )?Level ([^\s(]+)\s*\(([^)]*)\)\s+-\s+(.*)$/",
    r"/^(\S+(?:\+\S+)*)\s+(?:(USD|EUR|GBP|CAD|CNY|NOK|SEK|INR|RUB)\s+)?(.+)$/",
    r"/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/",
    r"/\b(?:Fusion|Split Hold'?em|Unfold|Power Up|Tempest)\b/i",
    r"/^Hand cancelled\s*$/i",
    r"/pre-?flop/i",
    r"/post-?flop/i",
    r"/^\*\*\*\s*SUMMARY\s*\*\*\*/i",
    r"/^Hand was run (?:twice|two times|three times|four times)$/i",
    r"/^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]/i",
    r"/^Seat (\d+):/",
    r"/Zoom/",
    r"/\bZoom\b/",
    r"/\bis sitting out\b/i",
    r"/\s+/g",
    r"/\[([^\]]*)\]/g",
    r"/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i",
    r"/^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$/",
    r"/^(.+?): (folds|checks)(?: \[([^\]]*)\])?$/",
    r"/^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$/",
    r"/^(.+?): (mucks hand|doesn't show hand)$/i",
    r"/^(.+?)[: ]+(?:is sitting out|sits out)\s*$/i",
    r"/(?:^|[\r\n])PokerStars.{0,40}#\d+:/",
    r"/\bPokerStars\b/",
    r"/(?=^PokerStars(?: [A-Za-z ]+?)? (?:Hand|Game) #\d+:)/m",
];
const TEMPLATES: &[&str] = &[
    r"((?: and (?:is all-in|has reached the \S+ cap))*)",
    r"Rake ${MONEY}",
    r"^Total pot ${MONEY}",
    r"(Main|Side) pot(-\d+)? ${MONEY}\.",
    r"^Uncalled bet \(${MONEY}\) returned to (.+)$",
    r"^(.+?) collected ${MONEY} from (?:the )?(.+?)$",
    r"^(.+?): posts the ante ${MONEY}${SUFFIX}$",
    r"^(.+?): posts (small|big) blind ${MONEY}${SUFFIX}$",
    r"^(.+?): posts small (?:&|and) big blinds? ${MONEY}${SUFFIX}$",
    r"^(.+?): posts ${MONEY}${SUFFIX}$",
    r"^(.+?): (calls|bets) ${MONEY}${SUFFIX}$",
    r"^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$",
];

#[test]
fn patterns_are_the_typescript_source() {
    for pattern in LITERALS {
        assert!(SOURCE.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES.iter().chain(&CHATTER_MEMBERS) {
        assert!(
            SOURCE.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    assert!(SOURCE.contains(r#"].join("|"),"#));
    assert!(SOURCE.contains(&format!(
        "export const POKERSTARS_PARSER_VERSION = \"{POKERSTARS_PARSER_VERSION}\";"
    )));
    for (key, value) in [("id", "pokerstars"), ("name", "PokerStars")] {
        assert!(SOURCE.contains(&format!("  {key}: \"{value}\",")), "{key}");
    }
    assert!(SOURCE.contains("const POKERSTARS_VARIANTS = HOLDEM_OMAHA;"));
    assert!(SOURCE.contains("const POKERSTARS_HI_LO = OMAHA_HI_LO;"));
    assert!(SOURCE.contains("return 0.95;") && SOURCE.contains("return 0.3;"));
    assert_eq!(PokerStarsParser.hi_lo_variants(), [Variant::Omaha]);
    assert!(!PokerStarsParser.short_deck());
}

#[test]
fn the_header_probe_counts_utf16_units_and_stops_at_a_line_end() {
    assert!(header_anywhere("PokerStars Hand #1:"));
    assert!(header_anywhere("x\rPokerStars #12:"));
    assert!(header_anywhere(&format!(
        "x\nPokerStars{}#1:",
        "a".repeat(40)
    )));
    assert!(!header_anywhere(&format!(
        "x\nPokerStars{}#1:",
        "a".repeat(41)
    )));
    assert!(header_anywhere(&format!(
        "PokerStars{}#1:",
        "😀".repeat(20)
    )));
    assert!(!header_anywhere(&format!(
        "PokerStars{}a#1:",
        "😀".repeat(20)
    )));
    assert!(!header_anywhere("PokerStars\u{2028}#1:"));
    assert!(!header_anywhere("xPokerStars #1:"));
    assert!(!header_anywhere("PokerStars #:"));
    assert!(!header_anywhere("PokerStars #1"));
    assert!(header_anywhere("PokerStars #1 #2:"));
}

#[test]
fn detects_a_header_or_the_branding() {
    let parser = PokerStarsParser;
    assert_eq!(parser.detect("\u{FEFF}PokerStars Zoom Hand #1: x"), 950);
    assert_eq!(parser.detect("a PokerStars summary"), 300);
    assert_eq!(parser.detect("PokerStarsX"), 0);
    assert_eq!(parser.detect(""), 0);
    assert_eq!(parser.detect("Poker Hand #1:"), 0);
}
