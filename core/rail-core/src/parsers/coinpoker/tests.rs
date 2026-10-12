//! The source check and the hand-written probes. The parser's behaviour is
//! held to the TypeScript by `tests/golden_sites.rs` (the corpus),
//! `tests/wpcp_vectors.rs` (mutated hands) and `tests/wpcp_parsers.rs` (the
//! translated `coinpokerParser.test.ts`).

use super::*;

const SOURCE: &str = include_str!("../../../../../frontend/src/lib/parsers/coinpoker.ts");

const LITERALS: &[&str] = &[
    r"/^CoinPoker Hand #\d+:/",
    r"/^CoinPoker Hand #(\d+): (.*)$/",
    r"/^(.*?)\s*((?:\d[\s-]*Card\s+)?(?:Hold'?em|Omaha(?:\s+Hi\/Lo)?|Short\s*Deck|Stud(?:\s+Hi\/Lo)?|Razz|Badugi|(?:Triple\s+)?Draw)(?:\s+(?:No|Pot|Fixed)\s+Limit|\s+Limit)?)$/",
    r"/^Table '(.*)' (\d+)-max Seat #(\d+) is the button$/",
    r"/^\*\*\*\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i",
    r"/\bhas timed out$|\bis disconnected$|\bhas reconnected$|\bactivated time-bank \(\d+ seconds?\)$|: didn't post (?:small|big) blind$/",
    r"/^(Seat \d+: .*?)( \(straddle\))(.*)$/",
    r"/(?:^|[\s(])\d+\.\d/",
    r"/(?:^|[\s(])\d+\.\d{3,}/",
    r"/^\*\*\*\s*HAND CANCELLED\s*\*\*\*/i",
    r"/freeroll/i",
    r"/^\*\*\*\s*SUMMARY\s*\*\*\*/i",
    r"/^Board \[([^\]]*)\]$/",
    r"/^Seat (\d+):/",
    r"/\[([^\]]*)\]/g",
    r"/^\*\*\*\s*HOLE CARDS\s*\*\*\*$/i",
    r"/^Dealt to (.+?) \[([^\]]*)\]$/",
    r"/^(.+?): (folds|checks)$/",
    r"/^(.+?): shows \[([^\]]*)\](?: \((.+)\))?$/",
    r"/^(.+?): (mucks hand|doesn't show hand)$/",
    r"/(?:^|[\r\n])CoinPoker Hand #\d+:/",
    r"/\bCoinPoker\b/",
    r"/(?=^CoinPoker Hand #\d+:)/m",
    r"/\s+/g",
];

const TEMPLATES: &[&str] = &[
    r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}",
    r"(\d+(?:\.\d{1,2})?)",
    r"^(.+?) \(${NUM}/${NUM} \) (${STAMP}) GMT$",
    r"^Tournament #(\d+), (.+) \((\d+)/(\d+)(?: ante (\d+))?(?: play)?\) (${STAMP}) GMT$",
    r"^Seat (\d+): (.+?) \(${NUM} in chips\)(?: (is sitting out|out of hand))?$",
    r"^Total pot ${NUM} \| Rake ${NUM}$",
    r"^Game ended: ${STAMP} GMT$",
    r"^Uncalled bet \(${NUM}\) returned to (.+)$",
    r"^(.+?) collected ${NUM} from (.+)$",
    r"^(.+?): posts the ante ${NUM}( and is all-in)?$",
    r"^(.+?): posts (?:small|big) blind \(dead\) ${NUM}$",
    r"^(.+?): posts (small|big) blind ${NUM}( and is all-in)?$",
    r"^(.+?): posts straddle ${NUM}$",
    r"^(.+?): (calls|bets) ${NUM}( and is all-in)?$",
    r"^(.+?): raises ${NUM} to ${NUM}( and is all-in)?$",
    r"^(.+?): raises ${NUM} and is all-in$",
];

#[test]
fn patterns_are_the_typescript_source() {
    // `SOURCE` may have CRLF line ends on a Windows checkout; the patterns
    // are single-line.
    for pattern in LITERALS {
        assert!(SOURCE.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES {
        assert!(
            SOURCE.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    assert_eq!(TEMPLATES[0], STAMP);
    assert_eq!(TEMPLATES[1], NUM);
    assert!(SOURCE.contains(r#"const CASH_UNIT: CurrencyUnit = unitForCode("USDT", "$");"#));
    assert!(SOURCE.contains(&format!(
        "export const COINPOKER_PARSER_VERSION = \"{COINPOKER_PARSER_VERSION}\";"
    )));
    for (key, value) in [("id", "coinpoker"), ("name", "CoinPoker")] {
        assert!(SOURCE.contains(&format!("  {key}: \"{value}\",")), "{key}");
    }
    assert!(SOURCE.contains("return 0.95;") && SOURCE.contains("return 0.3;"));
    assert!(!SOURCE.contains("hiLoVariants:") && !SOURCE.contains("shortDeck:"));
    assert!(CoinPokerParser.hi_lo_variants().is_empty());
    assert!(!CoinPokerParser.short_deck());
    for message in [
        "The hand has no CoinPoker header line.",
        "is not supported yet; the hand is kept for a future parser.",
        "CoinPoker cancelled the hand and refunded every stake.",
        "needs more precision than ${unit.code} gives (1/${unit.minorUnits}); ",
        "\"the hand is kept rather than rounded.\"",
        "`CoinPoker's header states no buy-in for \"${header.tournament.name}\"; `",
        "\"tournament.buyIn is 0.\"",
        "The hand has no seat lines.",
        "acts but is not in the seat block.",
        "verb: \"posts small blind (dead)\"",
        "verb: \"posts straddle\"",
        "handKey: `CP${header.handId}`",
        "decimals: \"fixed2\"",
        "padHour: true",
        "repairMissingUncalled: false",
    ] {
        assert!(SOURCE.contains(message), "{message}");
    }
}

#[test]
fn the_cash_unit_is_usdt_written_with_a_dollar() {
    let unit = cash_unit();
    assert_eq!(unit.code, "USDT");
    assert_eq!(unit.symbol, "$");
    assert_eq!(unit.minor_units, 100);
}

#[test]
fn detects_the_header_or_the_branding() {
    let parser = CoinPokerParser;
    assert_eq!(parser.detect("\u{FEFF}CoinPoker Hand #1: x"), 950);
    assert_eq!(parser.detect("x\rCoinPoker Hand #12: y"), 950);
    assert_eq!(parser.detect("x\u{2028}CoinPoker Hand #12: y"), 300);
    assert_eq!(parser.detect("exported from CoinPoker"), 300);
    assert_eq!(parser.detect("CoinPokerX"), 0);
    assert_eq!(parser.detect(""), 0);
}

#[test]
fn reads_a_tournament_name_up_to_the_last_game_label() {
    let header = parse_header(
        "CoinPoker Hand #1: Tournament #1287469, ₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats \
         GTD Hold'em No Limit (50/100 ante 13 play) 2025/06/19 18:53:04 GMT",
    )
    .expect("header");
    let tournament = header.tournament.expect("tournament");
    assert_eq!(
        tournament.name.as_deref(),
        Some("₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD")
    );
    assert_eq!(header.game.label, "Hold'em No Limit");
    assert_eq!(tournament.level_ante, 13);
    assert_eq!(
        header.played_at.as_deref(),
        Some("2025-06-19T18:53:04.000Z")
    );
    // An empty name is `null`; no game label is no header.
    let nameless = parse_header(
        "CoinPoker Hand #1: Tournament #1, Hold'em No Limit (50/100) 2025/06/19 18:53:04 GMT",
    )
    .expect("header");
    assert_eq!(nameless.tournament.expect("tournament").name, None);
    assert!(
        parse_header("CoinPoker Hand #1: Tournament #1, Daily (50/100) 2025/06/19 18:53:04 GMT")
            .is_none()
    );
    let cash =
        parse_header("CoinPoker Hand #2: Hold'em No Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT")
            .expect("cash header");
    assert_eq!((cash.game.small_blind, cash.game.big_blind), (1, 2));
    assert!(
        parse_header("CoinPoker Hand #2: Hold'em No Limit (0.01/0.02) 2025/06/19 18:53:04 GMT")
            .is_none()
    );
}
