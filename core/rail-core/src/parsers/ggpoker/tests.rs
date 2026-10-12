//! The source check and the rewritten lookahead. Behaviour is held to the
//! TypeScript by `tests/golden_sites.rs`, `tests/psgg_vectors.rs` and
//! `tests/psgg_parsers.rs` (the translated `ggpokerParser.test.ts`).

use super::*;

const SOURCE: &str = include_str!("../../../../../frontend/src/lib/parsers/ggpoker.ts");

const LITERALS: &[&str] = &[
    r"/^Poker Hand #\S+:\s*(?:ShortDeck|Hold'?em\s+Short\s*Deck|PLO(?:-\d)?|NLO\d?)\b/m",
    r"/^(?:GG\s*)?Poker Hand #([A-Za-z0-9_-]+):\s*(.*)$/",
    r"/^(?:GG\s*)?Poker Hand #[A-Za-z0-9_-]+:/",
    r"/(?=^(?:GG\s*)?Poker Hand #)/m",
    r"/^Table '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$/",
    r"/^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$/",
    r"/^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i",
    r"/^Total pot [^|\n]*\|\s*Rake /m",
    r"/: (?:Chooses to EV Cashout|Pays Cashout Risk)/",
    r"/: (?:get an all-in insurance|pay premium of all-in insurance)/",
    r"/\b(?:GGPoker|GGPOKER|Natural8|NATURAL8|BestPoker|ClubGG|Rush\s*&\s*Cash)\b/",
    r"/\b(?:PokerStars|888poker|Pacific Poker|PartyPoker|WPT Global|iPoker)\b/i",
    r"/(?:^|[\r\n])(?:GG\s*)?Poker Hand #/",
    r"/-\s*Level\s*(?:[IVXLCDM]+|\d+)\s*\(/",
    r"/(?:^|[\r\n])(?:GG\s*)?Poker Hand #(?:RC|TM|SD|OM|PL|SG|BR)/i",
    r"/and is all-in/",
    r"/^\s*(\S+?)\s*\/\s*(\S+)/",
    r"/(?:^|\s)((?:[$€£]\s?[\d.,]+)(?:\+[$€£]?\s?[\d.,]+)*|\d[\d.,]*(?:\+\d[\d.,]*)+|Freeroll)(?=\s|$)/i",
    r"/^Tournament\s*(?:\(([^]*?)\))?\s*#(\S+?),\s*(.+?)\s+-\s+Level\s*([IVXLCDM]+|\d+)\s*\(([^)]*)\)\s+-\s+(.*)$/",
    r"/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/",
    r"/^\*{3}\s*PREFLOP\s*\*{3}/im",
    r"/^\*\*\*\s*SUMMARY\s*\*\*\*/i",
    r"/^Hand was run (?:two|three|four) times$/i",
    r"/^(?:FIRST|SECOND|THIRD)$/i",
    r"/^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]/i",
    r"/^Seat (\d+):/",
    r"/^RushAndCash/i",
    r"/\bsitting out\b/i",
    r"/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i",
    r"/^\*\*\*\s*BOMB POT\s*\*\*\*/i",
    r"/^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$/",
    r"/^(.+?): (folds|checks)$/",
    r"/^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$/",
    r"/^(.+?): (mucks hand|doesn't show hand)$/i",
    r"/^(.+?): Chooses to EV Cashout$/",
    r"/^(.+?): (get an all-in insurance|pay premium of all-in insurance)\b(.*)$/",
];
const TEMPLATES: &[&str] = &[
    r"((?: and is all-in)*)",
    r"${name} ${MONEY}",
    r"^Total pot ${MONEY}",
    r"(Main|Side) pot(-\d+)? ${MONEY}\.",
    r"^Uncalled bet \(${MONEY}\) returned to (.+)$",
    r"^(.+?) collected ${MONEY} from (?:the )?(.+?)$",
    r"^(.+?): posts the ante ${MONEY}${SUFFIX}$",
    r"^(.+?): posts (small|big|button) blind ${MONEY}${SUFFIX}$",
    r"^(.+?): posts missed blind ${MONEY}$",
    r"^(.+?): straddle ${MONEY}${SUFFIX}$",
    r"^(.+?): posts (straddle )?${MONEY}${SUFFIX}$",
    r"^(.+?): (calls|bets) ${MONEY}${SUFFIX}$",
    r"^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$",
    r"^(.+?): Pays Cashout Risk \(${MONEY}\)$",
    r"^Cash Drop to Pot\s*:\s*total ${MONEY}$",
];

#[test]
fn patterns_are_the_typescript_source() {
    for pattern in LITERALS {
        assert!(SOURCE.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES
        .iter()
        .chain(&CHATTER_MEMBERS)
        .chain(&GAME_LABEL_TAIL_PARTS)
    {
        assert!(
            SOURCE.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    for name in ["Rake", "Jackpot", "Bingo", "Fortune", "Tax"] {
        assert!(SOURCE.contains(&format!("pick(\"{name}\")")), "{name}");
    }
    assert!(BUY_IN_TOKEN_BODY.ends_with("|Freeroll)"));
    assert!(SOURCE.contains(&format!("/{BUY_IN_TOKEN_BODY}(?=\\s|$)/i")));
    assert!(SOURCE.contains(&format!(
        "export const GGPOKER_PARSER_VERSION = \"{GGPOKER_PARSER_VERSION}\";"
    )));
    assert!(SOURCE.contains(
        r#"const GGPOKER_VARIANTS: readonly Variant[] = ["holdem", "omaha", "omaha5", "shortdeck"];"#
    ));
    for (prefix, product) in [
        ("HD", "Hold'em cash"),
        ("RC", "Rush & Cash"),
        ("TM", "tournament"),
        ("SD", "Short Deck"),
        ("OM", "Omaha"),
        ("PL", "Omaha"),
        ("SG", "Spin & Gold"),
        ("BR", "Battle Royale"),
    ] {
        assert!(
            SOURCE.contains(&format!("  {prefix}: \"{product}\",")),
            "{prefix}"
        );
        assert_eq!(product_for(prefix), Some(product));
    }
    assert_eq!(product_for("XX"), None);
    assert!(SOURCE.contains("shortDeck: true,"));
    assert!(GgPokerParser.short_deck() && GgPokerParser.hi_lo_variants().is_empty());
}

#[test]
fn the_buy_in_token_is_what_the_lookahead_pattern_captures() {
    // `(?=\s|$)` consumed as `(?:\s|$)`: the first match's group 1 is the
    // same (values recorded from Node).
    let token = |name: &str| {
        BUY_IN_TOKEN
            .captures(name)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_owned())
    };
    assert_eq!(token("Daily Special $55").as_deref(), Some("$55"));
    assert_eq!(token("$55abc Daily"), None);
    assert_eq!(token("H-04: $1,050 GGMasters").as_deref(), Some("$1,050"));
    assert_eq!(
        token("Mystery € 5,50+€0,50").as_deref(),
        Some("€ 5,50+€0,50")
    );
    assert_eq!(token("2000+110").as_deref(), Some("2000+110"));
    assert_eq!(token("Big 10+1x 20+2").as_deref(), Some("20+2"));
    assert_eq!(token("freeroll").as_deref(), Some("freeroll"));
    assert_eq!(token("Freerolls $5").as_deref(), Some("$5"));
}
