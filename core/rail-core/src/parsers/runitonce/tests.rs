//! The source check and the hand-written probes. The parser's behaviour is
//! held to the TypeScript by `tests/golden_sites.rs` (the corpus),
//! `tests/p3_vectors.rs` (mutated hands) and `tests/p3_parsers.rs` (the
//! translated `p3Parsers.test.ts`).

use super::*;
use crate::detect::ConvertOptions;

const SOURCE: &str = include_str!("../../../../../web/src/lib/parsers/runitonce.ts");

const LITERALS: &[&str] = &[
    r"/^Run It Once Poker Hand #(\d+):\s*(.*)$/",
    r"/^Run It Once Poker Hand #\d+:/",
    r"/^Run It Once Poker (?:Hand|Tournament) #\d+/m",
    r"/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC/",
    r"/^\s*(\S+)\/(\S+)/",
    r"/^Tournament #([^,]+), (\S+(?:\+\S+)*)\s+(.*?), (.+?)\s*\(([^)]*)\)\s+-\s+.*$/",
    r"/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/",
    r"/\bRun It Once Poker\b/",
    r"/(?=^Run It Once Poker Hand #\d+:)/m",
];

#[test]
fn patterns_are_the_typescript_source() {
    let source = SOURCE.replace("\r\n", "\n");
    for pattern in LITERALS {
        assert!(source.contains(pattern), "{pattern}");
    }
    assert!(source.contains(&format!(
        "export const RUNITONCE_PARSER_VERSION = \"{RUNITONCE_PARSER_VERSION}\";"
    )));
    for (key, value) in [("id", "runitonce"), ("name", "Run It Once Poker")] {
        assert!(source.contains(&format!("  {key}: \"{value}\",")), "{key}");
    }
    assert!(source.contains(r#"const RUNITONCE_VARIANTS = ["holdem"] as const;"#));
    // No hi/lo list: every hi/lo label is refused.
    assert!(source.contains("unsupportedGameSkip(header.game.label) ??"));
    assert!(!source.contains("hiLoVariants"));
    for message in [
        "The chunk has no readable Run It Once Poker header line.",
        "Tournament hand skipped because the converter is in cash-only mode.",
        "The hand lists no seats, so nobody can be attributed.",
        r#"`The table line puts the button on seat ${body.buttonSeat}, which nobody occupies; ` +"#,
        r#""the seat number is kept as printed and the ring is resolved from the blinds.","#,
        "handKey: `RIO${header.handId}`,",
        "padHour: true,",
        "name: name.trim() || null,",
        r#"`${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${s ?? "00"}Z`"#,
    ] {
        assert!(source.contains(message), "{message}");
    }
}

fn parse(text: &str, cash_only: bool) -> Result<PhfHand, ParseError> {
    let options = ConvertOptions {
        cash_only,
        ..ConvertOptions::default()
    };
    let ctx = SiteParserContext {
        source_filename: None,
        options: &options,
    };
    parse_one_hand(text, &ctx)
}

#[test]
fn the_utc_timestamp_is_the_one_read() {
    assert_eq!(
        parse_played_at_utc("x - 2019/06/25 16:12 UTC [2019/06/25 17:12 CET]").as_deref(),
        Some("2019-06-25T16:12:00.000Z")
    );
    assert_eq!(
        parse_played_at_utc("2021/04/12 7:01:17 UTC").as_deref(),
        Some("2021-04-12T07:01:17.000Z")
    );
    assert_eq!(parse_played_at_utc("2019/06/25 16:12 CET"), None);
    assert_eq!(parse_played_at_utc("2019/13/40 25:61 UTC"), None);
}

#[test]
fn a_tournament_header_has_a_name_and_no_level() {
    let header = parse_header(
        "Run It Once Poker Hand #55582352: Tournament #158168, \u{20ac}4.69+\u{20ac}0.31 Cub3d, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC [2021/04/12 17:01 CET]",
    )
    .expect("header");
    let tournament = header.tournament.expect("tournament");
    assert_eq!(tournament.name.as_deref(), Some("Cub3d"));
    assert_eq!((tournament.buy_in, tournament.fee), (469, 31));
    assert_eq!(tournament.level_label, None);
    assert_eq!(header.game.format, GameFormat::Tournament);
    // A stake in a currency PHF has no unit fails the tournament reading,
    // and the cash reading is tried on the same payload.
    let fallback = parse_header(
        "Run It Once Poker Hand #1: Tournament #1, \u{a5}5 Cub3d, Hold'em No Limit (\u{a5}10/\u{a5}20) - 2021/04/12 16:01 UTC",
    );
    assert!(fallback.is_none());
}

#[test]
fn refusals_keep_the_typescript_wording() {
    let skip_of = |text: &str, cash_only: bool| match parse(text, cash_only) {
        Err(ParseError::Skip(skip)) => (skip.reason.as_str().to_owned(), skip.message),
        other => panic!("expected a refusal, got {other:?}"),
    };
    assert_eq!(
        skip_of("Run It Once Poker Hand #1: garbage", false),
        (
            "normalized-unparseable".to_owned(),
            "The chunk has no readable Run It Once Poker header line.".to_owned()
        )
    );
    assert_eq!(
        skip_of(
            "Run It Once Poker Hand #1:  Omaha Hi/Lo Pot Limit (\u{20ac}0.05/\u{20ac}0.10) - 2019/06/25 16:12 UTC",
            false
        )
        .0,
        "unsupported-hi-lo"
    );
    assert_eq!(
        skip_of(
            "Run It Once Poker Hand #1: Tournament #1, \u{20ac}5 X, Hold'em No Limit (10/20) - 2021/04/12 16:01 UTC",
            true
        ),
        (
            "tournament-in-cash-mode".to_owned(),
            "Tournament hand skipped because the converter is in cash-only mode.".to_owned()
        )
    );
    assert_eq!(
        skip_of(
            "Run It Once Poker Hand #1:  Hold'em No Limit (\u{20ac}0.05/\u{20ac}0.10) - 2019/06/25 16:12 UTC",
            false
        ),
        (
            "no-seat-block".to_owned(),
            "The hand lists no seats, so nobody can be attributed.".to_owned()
        )
    );
}

/// `/^Run It Once Poker (?:Hand|Tournament) #\d+/m` after every JavaScript
/// line terminator (recorded from Node).
#[test]
fn detection_runs_at_every_javascript_line_start() {
    for (text, expected) in [
        ("Run It Once Poker Hand #1", 950),
        ("Run It Once Poker Tournament #1", 950),
        ("x\u{2029}Run It Once Poker Hand #1", 950),
        ("\u{FEFF}Run It Once Poker Tournament #9", 950),
        (" Run It Once Poker Hand #1", 300),
        ("Run It Once Poker Hand #", 300),
        ("Run It Once Pokers", 0),
    ] {
        assert_eq!(RunItOnceParser.detect(text), expected, "{text:?}");
    }
}
