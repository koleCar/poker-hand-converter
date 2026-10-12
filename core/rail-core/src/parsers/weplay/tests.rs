//! The source check and the hand-written probes. The parser's behaviour is
//! held to the TypeScript by `tests/golden_sites.rs` (the corpus),
//! `tests/wpcp_vectors.rs` (mutated hands) and `tests/wpcp_parsers.rs` (the
//! translated WePlay tests).

use super::*;

const SOURCE: &str = include_str!("../../../../../frontend/src/lib/parsers/weplay.ts");

/// `/literal/flags` as the source writes them.
const LITERALS: &[&str] = &[
    r"/(?=^Weplay Hand #\d+:)/gm",
    r"/^\*\*\* (?:FIRST |SECOND )?(?:FLOP|TURN|RIVER)\b/",
    r"/^(.+?): shows \[.*#.*\].*$/",
    r"/^Seat\s+\d+:\s+(.+?)\s+\((.+) in chips\)$/",
    r"/^(.+?): (?:posts|raises|calls|bets|folds|checks|shows|mucks|doesn't show)/",
    r"/^(.+?) collected /",
    r"/Tournament/i",
    r"/\(\d+\)/",
    r"/\s+\(Money 3\)/",
    r"/\s{2,}/g",
    r"/Rake\s+([$€£\d.]+)/",
    r"/folded/i",
    r"/\s+showed \[[^\]]*\]/i",
    r"/\s+and lost with .+$/i",
    r"/showed \[[^\]]*#[^\]]*\]/i",
    r"/^Weplay Hand #(\d+):\s*(.+)$/",
    r"/\s+UTC$/",
    r"/\bactivates time bank\b/i",
    r"/\bdeclines straddle\b/i",
    r"/\bwas run two times\b/i",
    r"/\bis disconnected\b/i",
    r"/\bis connected\b/i",
    r"/\bOmaha\b/i",
    r"/\bPLO\b/i",
    r"/\*\*\*\s*BOMB POT\s*\*\*\*/i",
    r"/posts bomb pot/i",
    r"/posts the ante/i",
    r"/posts (?:small|big) blind/i",
    r"/All-in or Fold/i",
    r"/: posts big blind /i",
    r"/: posts small blind /i",
    r"/^[$€£]?0(?:\.0+)?$/",
    r"/[.*+?^${}()|[\]\\]/g",
    r"/^\*\*\* (?:FIRST |SECOND )?FLOP\b/",
    r"/^\*\*\* (?:FIRST |SECOND )?TURN\b/",
    r"/^\*\*\* (?:FIRST |SECOND )?RIVER\b/",
    r"/: (?:posts|raises|calls|bets|shows|collected)/",
    r"/ collected /",
    r"/^Dealt to /",
    r"/^Board \[/",
    r"/\r?\n/",
    r"/(?:^|\n)\uFEFF?Weplay Hand #\d+:/",
    r"/FIRST/",
    r"/SECOND/",
];

/// `String.raw` templates (with `${AMOUNT}`).
const TEMPLATES: &[&str] = &[
    r"(?:\$|€|£)?(\d+(?:\.\d+)?)",
    r"^(.+?): raises ${AMOUNT} to ${AMOUNT}( and is all-in)?$",
    r"^Uncalled bet \(${AMOUNT}\) returned to (.+)$",
    r"\(${AMOUNT}\/${AMOUNT}\)",
    r": posts (?:small|big) blind ${AMOUNT}",
    r": posts ${AMOUNT}",
    r": bets ${AMOUNT}",
    r": posts small blind ${AMOUNT} and is all-in",
    r": posts big blind ${AMOUNT} and is all-in",
    r"^(.+?): posts the ante ${AMOUNT}",
    r"^(.+?): posts (small|big) blind ${AMOUNT}( and is all-in)?$",
    r"^(.+?): calls ${AMOUNT}( and is all-in)?$",
    r"^(.+?): bets ${AMOUNT}",
];

#[test]
fn patterns_are_the_typescript_source() {
    for pattern in LITERALS {
        assert!(SOURCE.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES {
        assert!(
            SOURCE.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    assert_eq!(TEMPLATES[0], AMOUNT);
    // The two `gi` probes.
    assert_eq!(SOURCE.matches(r#"and is all-in`, "gi")"#).count(), 2);
    assert!(SOURCE.contains(&format!(
        "export const WEPLAY_PARSER_VERSION = \"{WEPLAY_PARSER_VERSION}\";"
    )));
    for (key, value) in [("id", "weplay"), ("name", "WePlay")] {
        assert!(SOURCE.contains(&format!("  {key}: \"{value}\",")), "{key}");
    }
    assert!(SOURCE.contains("return 0.99;"));
    assert!(!SOURCE.contains("hiLoVariants") && !SOURCE.contains("shortDeck"));
    assert!(WePlayParser.hi_lo_variants().is_empty());
    assert!(!WePlayParser.short_deck());
    // The messages of every refusal, verbatim.
    for message in [
        "All-in or Fold table.",
        "Big blind posted without a small blind (BB-only walk).",
        "Small blind posted all-in for less than the stated blind.",
        "Big blind posted all-in for less than the stated blind.",
        "`A player with a zero stack acted (${name}).`",
        "A turn was dealt without a flop.",
        "A second turn was dealt without a flop.",
        "A river was dealt without a turn.",
        "A second river was dealt without a turn.",
        "`Uncalled bet is larger than what ${player} committed.`",
        "`Ante posted by an unseated player (${player}).`",
        "`An unseated player acted (${actor}).`",
        "An all-in call preflop is smaller than the big blind.",
        "Omaha is not supported yet; the hand is kept for a future parser.",
        "Tournament hand skipped because the converter is in cash-only mode.",
        "Bomb pot hand skipped by request.",
        "The hand normalized cleanly but the result could not be parsed.",
    ] {
        assert!(SOURCE.contains(message), "{message}");
    }
}

#[test]
fn splits_lines_as_javascript_splits_on_cr_lf() {
    assert_eq!(split_lines("a\r\nb\nc\r"), ["a", "b", "c\r"]);
    assert_eq!(split_lines("a\r\rb"), ["a\r\rb"]);
    assert_eq!(split_lines(""), [""]);
    assert_eq!(split_lines("\n"), ["", ""]);
    assert_eq!(split_lines("a\r\r\n"), ["a\r", ""]);
}

#[test]
fn a_remainder_of_zero_is_an_exact_multiple() {
    let n = |text: &str| JsNumber::parse(text);
    assert!(n("0").is_multiple_of(100));
    assert!((-n("0")).is_multiple_of(100));
    assert!(n("300").is_multiple_of(100));
    assert!(n("-300").is_multiple_of(100));
    assert!(!n("250").is_multiple_of(100));
    assert!(!n("0.5").is_multiple_of(100));
    assert!(!n("Infinity").is_multiple_of(100));
    assert!(!JsNumber::Nan.is_multiple_of(100));
    // 2^60 = 1152921504606846976, and 1e22 (an exact double).
    assert!(!n("1152921504606846976").is_multiple_of(100));
    assert!(n("1e22").is_multiple_of(100));
    assert!(!n("1e300").is_multiple_of(100));
    assert!(!n("1e23").is_multiple_of(100));
    assert!(!n("1180591620717411303424").is_multiple_of(100));
}

#[test]
fn formats_units_in_the_weplay_money_style() {
    let cash = Money {
        symbol: "$",
        minor_units: 100,
    };
    let chips = Money {
        symbol: "",
        minor_units: 1,
    };
    let units = |raw: &str| parse_units(raw, &cash);
    assert_eq!(format_units(units("2"), &cash), "$2");
    assert_eq!(format_units(units("2.5"), &cash), "$2.50");
    assert_eq!(format_units(units("0.29"), &cash), "$0.29");
    assert_eq!(format_units(units("1.005"), &cash), "$1");
    assert_eq!(format_units(units("12.01"), &cash), "$12.01");
    assert_eq!(format_units(parse_units("1500", &chips), &chips), "1500");
    assert_eq!(
        format_units(parse_units("1e400", &chips), &chips),
        "Infinity"
    );
    assert_eq!(format_units(JsNumber::Nan, &cash), "$NaN");
}

#[test]
fn rewrites_raises_over_the_current_bet() {
    let cash = Money {
        symbol: "$",
        minor_units: 100,
    };
    let bet = |raw: &str| parse_units(raw, &cash);
    let rewrite =
        |line: &str, current: &str| rewrite_raise_line(line, bet(current), &cash).map(|r| r.line);
    assert_eq!(
        rewrite("a: raises $2.50 to $3", "1").as_deref(),
        Some("a: raises $2 to $3")
    );
    assert_eq!(
        rewrite("a: raises $1 to $2", "1").as_deref(),
        Some("a: raises $1 to $2")
    );
    assert_eq!(
        rewrite("a: raises $7.40 to $7.90 and is all-in", "10").as_deref(),
        Some("a: calls $7.40 and is all-in")
    );
    assert_eq!(
        rewrite("a: raises $3 to $3", "5").as_deref(),
        Some("a: raises $3 to $3")
    );
    assert_eq!(rewrite("a: calls $3", "5"), None);
}

#[test]
fn the_zero_stack_probe_is_the_escaped_prefix() {
    assert!(is_money_action_by("a.b: posts $1", "a.b"));
    assert!(!is_money_action_by("axb: posts $1", "a.b"));
    assert!(is_money_action_by("x (1): bets", "x (1)"));
    assert!(!is_money_action_by("x: postsx", "x"));
    assert!(is_money_action_by("x: posts-", "x"));
    assert!(is_money_action_by("x: callsé", "x"));
    assert!(!is_money_action_by("x: folds", "x"));
    assert!(!is_money_action_by(" x: posts", "x"));
}

#[test]
fn detects_the_header_at_the_start_or_after_a_line_feed() {
    let parser = WePlayParser;
    assert_eq!(parser.detect("Weplay Hand #1: x"), 990);
    assert_eq!(parser.detect("\u{FEFF}Weplay Hand #1: x"), 990);
    assert_eq!(parser.detect("x\n\u{FEFF}Weplay Hand #1:"), 990);
    assert_eq!(parser.detect("x\rWeplay Hand #1:"), 0);
    assert_eq!(parser.detect(" Weplay Hand #1:"), 0);
    assert_eq!(parser.detect("Weplay Hand #:"), 0);
    assert_eq!(parser.detect("weplay hand #1:"), 0);
}

#[test]
fn splits_at_every_javascript_line_start() {
    let split = |text: &str| WePlayParser.split_hands(text).expect("split");
    assert_eq!(
        split(
            "\u{FEFF}Weplay Hand #1: a\r\nWeplay Hand #2: b\rWeplay Hand #3: c\u{2028}Weplay Hand #4: d"
        ),
        [
            "Weplay Hand #1: a",
            "Weplay Hand #2: b",
            "Weplay Hand #3: c",
            "Weplay Hand #4: d"
        ]
    );
    // A BOM inside the text is no line start: the chunk keeps its junk.
    assert!(split("junk\n\u{FEFF}Weplay Hand #1: a\n\n").is_empty());
    // Only the prefix is checked: `#x` is a chunk too.
    assert_eq!(split("Weplay Hand #x: a"), ["Weplay Hand #x: a"]);
}
