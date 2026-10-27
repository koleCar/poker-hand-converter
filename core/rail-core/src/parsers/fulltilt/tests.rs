//! The source check and the hand-written probes. The parser's behaviour is
//! held to the TypeScript by `tests/golden_sites.rs` (the corpus),
//! `tests/p3_vectors.rs` (mutated hands) and `tests/p3_parsers.rs` (the
//! translated `p3Parsers.test.ts`).

use super::*;
use crate::detect::ConvertOptions;

const SOURCE: &str = include_str!("../../../../../web/src/lib/parsers/fulltilt.ts");

const LITERALS: &[&str] = &[
    r"/^Full Tilt Poker Game #(\d+):\s*(.*)$/",
    r"/^Full Tilt Poker Game #\d+:/",
    r"/^Table (.+?)(?: \(([^)]*)\))? - (.+) - (\d{1,2}):(\d{2}):(\d{2}) ([A-Za-z]+) - (\d{4})\/(\d{2})\/(\d{2})(?: \[.*\])?\s*$/",
    r"/^\*\*\*\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*(\d+)?\s*\*\*\*(.*)$/i",
    r"/^\*\*\*\s*SUMMARY\s*(\d+)?\s*\*\*\*/i",
    r#"["FIRST", "SECOND", "THIRD", "FOURTH"]"#,
    r"/and is all in/",
    r"/\bFL\b|fixed\s*limit/i",
    r"/\bPL\b|pot\s*limit/i",
    r"/\bNL\b|no\s*limit/i",
    r"/\blimit\b/i",
    r"/(\d+)\s*max/i",
    r"/heads up/i",
    r"/^\s*(\S+)\/([^\s]+)/",
    r"/\bfolded before the Flop\b/i",
    r"/\bdidn't bet \(folded\)/i",
    r"/^Hand #\d+ has been cance?l?led\s*$/i",
    r"/\bTournament\b|\bSit & Go\b|\bMatch #/i",
    r"/^Board:?\s*\[([^\]]*)\]/i",
    r"/^Seat (\d+): (.*)$/",
    r"/\bis sitting out$/i",
    r"/\bis sitting out\b/i",
    r"/^The button is in seat #(\d+)\s*$/i",
    r"/\s+/g",
    r"/\[([^\]]*)\]/g",
    r"/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i",
    r"/^Dealt to (.+?) \[([^\]]*)\]\s*$/",
    r"/^(.+?) (folds|checks)$/",
    r"/^(.+?) mucks$/",
    r"/^(.+?) shows(?: \[([^\]]*)\])?(?: (.+))?$/",
    r"/^Players agree to Run It Twice$/i",
    r"/^(.+?) is sitting out$/i",
    r"/^(.+?): /",
    r"/^pot (\d+)$/",
    r"/^Full Tilt Poker Game #\d+:/m",
    r"/\bFull Tilt Poker\b/",
    r"/(?=^Full Tilt Poker Game #\d+:)/m",
];
const TEMPLATES: &[&str] = &[
    STAKES,
    SUFFIX,
    r"^${STAKES}\s+-\s+(.+)$",
    r"^(.+?)\s+-\s+${STAKES}$",
    r"Rake ${MONEY}",
    r"^Total pot ${MONEY}",
    r"^Pot \d+ ${MONEY}$",
    r"^Seat (\d+): (.+?) \(${MONEY}\)(.*)$",
    r"^(.+?) posts (?:a (dead) )?(?:the )?(small|big) blind of ${MONEY}$",
    r"^(.+?) antes ${MONEY}$",
    r"^(.+?) posts ${MONEY}$",
    r"^(?:Uncalled bet|Ante) of ${MONEY} returned to (.+)$",
    r"^(.+?) wins (?:the (high |low )?pot|pot (\d+)) \(${MONEY}\)(?: with .+)?$",
    r"^(.+?) (bets|calls) ${MONEY}${SUFFIX}$",
    r"^(.+?) raises to ${MONEY}${SUFFIX}$",
];

#[test]
fn patterns_are_the_typescript_source() {
    let source = SOURCE.replace("\r\n", "\n");
    for pattern in LITERALS {
        assert!(source.contains(pattern), "{pattern}");
    }
    for template in TEMPLATES.iter().chain(&NOISE_MEMBERS) {
        assert!(
            source.contains(&format!("String.raw`{template}`")),
            "{template}"
        );
    }
    assert!(source.contains(r#"].join("|"),"#));
    assert!(source.contains(&format!(
        "export const FULLTILT_PARSER_VERSION = \"{FULLTILT_PARSER_VERSION}\";"
    )));
    for (key, value) in [("id", "fulltilt"), ("name", "Full Tilt Poker")] {
        assert!(source.contains(&format!("  {key}: \"{value}\",")), "{key}");
    }
    assert!(source.contains(r#"const FULLTILT_VARIANTS = ["holdem", "omaha"] as const;"#));
    assert!(source.contains("const FULLTILT_HI_LO = OMAHA_HI_LO;"));
    assert!(source.contains("hiLoVariants: FULLTILT_HI_LO,"));
    // The refusal and warning wordings.
    for message in [
        "Full Tilt cancelled the hand.",
        r#""Full Tilt's tournament hand format is unconfirmed - no real sample exists - " +"#,
        r#""so the hand is kept rather than parsed with an invented grammar.","#,
        "The chunk has no readable Full Tilt Poker header line.",
        r#""The hand states no currency, so it is chips - play money or a tournament - " +"#,
        r#""neither of which is confirmed for Full Tilt.","#,
        "The hand has no seat listing, so there is nothing to attribute the action to.",
        r#""The hand printed one SUMMARY block per runout; the per-seat prose of the first " +"#,
        r#""was kept and the winners' outcomes come from their collect lines.","#,
        r#""folded before Flop (didn't bet)""#,
        r#"verb: blind[2] ? "posts dead blind" : undefined"#,
        r#"draft.muck(mucks[1], "mucks hand","#,
        "PHF has no unit for the currency in",
        "acts but is not in the seat block.",
    ] {
        assert!(source.contains(message), "{message}");
    }
}

fn parse(text: &str) -> Result<PhfHand, ParseError> {
    let options = ConvertOptions::default();
    let ctx = SiteParserContext {
        source_filename: None,
        options: &options,
    };
    parse_one_hand(text, &ctx)
}

fn hand_of(lines: &[&str]) -> Result<PhfHand, ParseError> {
    parse(&lines.join("\n"))
}

const HEAD: &str =
    "Full Tilt Poker Game #1: Table Vernon - NL Hold'em - $0.50/$1 - 15:45:47 ET - 2014/01/06";

fn basic(extra_seat: Option<&str>, tail: &[&str]) -> Vec<String> {
    let mut lines = vec![
        HEAD.to_owned(),
        "Seat 5: a ($100)".to_owned(),
        "Seat 6: b ($100)".to_owned(),
    ];
    lines.extend(extra_seat.map(str::to_owned));
    lines.extend(
        [
            "a posts the small blind of $0.50",
            "b posts the big blind of $1",
            "The button is in seat #5",
            "*** HOLE CARDS ***",
            "a folds",
            "Uncalled bet of $0.50 returned to b",
            "b wins the pot ($1)",
            "*** SUMMARY ***",
            "Total pot $1 | Rake $0",
        ]
        .map(str::to_owned),
    );
    lines.extend(tail.iter().map(|line| (*line).to_owned()));
    lines
}

fn joined(lines: &[String]) -> Result<PhfHand, ParseError> {
    parse(&lines.join("\n"))
}

#[test]
fn the_two_header_generations_read_alike() {
    let modern = parse_header(
        "Full Tilt Poker Game #9: Table Goldring (heads up) - NL Hold'em - $5/$10 - 21:11:15 ET - 2014/01/05",
    )
    .expect("2014 header");
    assert_eq!(modern.game.label, "NL Hold'em");
    assert_eq!(
        (modern.game.small_blind, modern.game.big_blind),
        (500, 1000)
    );
    assert_eq!(modern.max_seats, JsNumber::from_u64(2));
    assert_eq!(
        modern.played_at.as_deref(),
        Some("2014-01-05T21:11:15.000Z")
    );
    let legacy = parse_header(
        "Full Tilt Poker Game #9: Table Bri (6 max) - $0.25/$0.50 - $15 Cap No Limit Hold'em - 18:46:08 ET - 2011/02/28",
    )
    .expect("2011 header");
    assert_eq!(legacy.game.label, "$15 Cap No Limit Hold'em");
    assert_eq!(legacy.game.limit, LimitType::Nl);
    assert_eq!(legacy.max_seats, JsNumber::from_u64(6));
    // `PL Omaha H/L` holds a slash and is no stakes.
    let hi_lo = parse_header(
        "Full Tilt Poker Game #9: Table Vernon - PL Omaha H/L - $0.50/$1 - 15:45:47 ET - 2014/01/06",
    )
    .expect("hi/lo header");
    assert_eq!(hi_lo.game.label, "PL Omaha H/L");
    assert_eq!(hi_lo.max_seats, JsNumber::from_u64(9));
    // A fixed-limit header states bets, not blinds.
    let fixed = parse_header(
        "Full Tilt Poker Game #9: Table Narit (6 max) - FL Hold'em - $0.05/$0.10 - 08:01:08 ET - 2014/01/06",
    )
    .expect("FL header");
    assert_eq!((fixed.game.small_blind, fixed.game.big_blind), (0, 0));
    // A rolled-over date is no instant; a one-digit hour pads.
    let rolled = parse_header(
        "Full Tilt Poker Game #9: Table X - NL Hold'em - $1/$2 - 25:61:61 ET - 2014/13/40",
    )
    .expect("header");
    assert_eq!(rolled.played_at, None);
    let short = parse_header(
        "Full Tilt Poker Game #9: Table X - NL Hold'em - $1/$2 - 1:02:03 ET - 2014/01/06",
    )
    .expect("header");
    assert!(!short.pad_hour);
    assert_eq!(short.played_at.as_deref(), Some("2014-01-06T01:02:03.000Z"));
}

#[test]
fn the_limit_is_read_from_full_tilts_codes() {
    for (label, limit) in [
        ("FL Hold'em", LimitType::Fl),
        ("PL Omaha", LimitType::Pl),
        ("NL Hold'em", LimitType::Nl),
        ("Fixed Limit Hold'em", LimitType::Fl),
        ("Pot Limit Omaha", LimitType::Pl),
        ("Limit Hold'em", LimitType::Fl),
        ("Hold'em", LimitType::Nl),
    ] {
        assert_eq!(limit_from_full_tilt_label(label), limit, "{label}");
    }
}

#[test]
fn the_summary_wording_is_the_familys() {
    assert_eq!(
        normalize_summary_seat("Seat 3: x (small blind) folded before the Flop"),
        "Seat 3: x (small blind) folded before Flop"
    );
    assert_eq!(
        normalize_summary_seat("Seat 5: x didn't bet (folded)"),
        "Seat 5: x folded before Flop (didn't bet)"
    );
}

/// `*** SHOW DOWN 0 ***` is runout -1 (recorded from Node): no runout is
/// added, and a street marker numbered 0 throws.
#[test]
fn a_marker_numbered_zero_is_runout_minus_one() {
    let mut lines = basic(None, &[]);
    lines.insert(8, "*** FLOP 0 *** [2c 3d 4h]".to_owned());
    assert_eq!(
        joined(&lines).expect_err("throws"),
        ParseError::Bug("Cannot set properties of undefined (setting 'flop')".to_owned())
    );

    let mut lines = basic(None, &[]);
    lines.insert(8, "*** SHOW DOWN 0 ***".to_owned());
    match joined(&lines).expect_err("parser error") {
        ParseError::Bug(message) => assert!(message.starts_with("a runout index is beyond")),
        other => panic!("{other:?}"),
    }

    // The collect re-tagged from its pot number leaves nothing at -1.
    let mut lines = basic(None, &[]);
    lines.insert(9, "*** SHOW DOWN 0 ***".to_owned());
    lines[10] = "b wins pot 1 ($1)".to_owned();
    let hand = joined(&lines).expect("hand");
    assert_eq!(hand.board.runouts.len(), 1);
    assert_eq!(hand.meta.text_style.showdown_labels, [""]);
    assert!(hand.actions.iter().all(|action| action.runout_index == 0));
}

#[test]
fn numbers_beyond_u32_are_reported_where_the_typescript_returns() {
    let error = |lines: &[String]| match joined(lines) {
        Err(ParseError::Bug(message)) => message,
        other => panic!("{other:?}"),
    };
    let seat = basic(Some("Seat 99999999999: c ($5)"), &[]);
    assert!(error(&seat).starts_with("a seat number is beyond"));
    // The same seat whose name is already seated is dropped: a hand.
    let duplicate = basic(Some("Seat 99999999999: b ($5)"), &[]);
    let hand = joined(&duplicate).expect("hand");
    assert_eq!(hand.meta.warnings[0].code, "duplicate-seat-line");
    // An unseated actor is refused first, as in the TypeScript.
    let mut unseated = basic(Some("Seat 99999999999: c ($5)"), &[]);
    unseated.insert(4, "zz posts the small blind of $0.50".to_owned());
    assert_eq!(
        joined(&unseated).expect_err("refused"),
        skip(
            SkipReason::UnseatedActor,
            "\"zz\" acts but is not in the seat block."
        )
    );
    let mut button = basic(None, &[]);
    button[5] = "The button is in seat #99999999999".to_owned();
    assert!(error(&button).starts_with("a button seat is beyond"));
    let mut size = basic(None, &[]);
    size[0] = HEAD.replace("Table Vernon", "Table Vernon (99999999999 max)");
    assert!(error(&size).starts_with("a table size is beyond"));
    let mut pot = basic(None, &[]);
    pot[9] = "b wins pot 99999999999 ($1)".to_owned();
    assert!(error(&pot).starts_with("a runout index is beyond"));
    // `4294967296 - 1` fits.
    let mut edge = basic(None, &[]);
    edge[9] = "b wins pot 4294967296 ($1)".to_owned();
    assert_eq!(
        joined(&edge).expect("hand").results.winners[0].runout_index,
        u32::MAX
    );
}

#[test]
fn a_marker_past_the_cap_is_refused_at_its_line() {
    let mut lines = basic(None, &[]);
    lines.insert(8, "*** RIVER 10000 *** [2h]".to_owned());
    assert_eq!(joined(&lines).expect("hand").board.runouts.len(), 10_000);
    lines[8] = "*** RIVER 10001 *** [2h]".to_owned();
    match joined(&lines).expect_err("refused") {
        ParseError::Bug(message) => assert!(message.contains("is beyond what this port builds")),
        other => panic!("{other:?}"),
    }
}

/// `/^Full Tilt Poker Game #\d+:/m` after every JavaScript line terminator
/// (recorded from Node).
#[test]
fn detection_runs_at_every_javascript_line_start() {
    for (text, expected) in [
        ("Full Tilt Poker Game #1:", 950),
        ("x\rFull Tilt Poker Game #1:", 950),
        ("x\u{2028}Full Tilt Poker Game #1:", 950),
        ("\u{FEFF}Full Tilt Poker Game #1:", 950),
        (" Full Tilt Poker Game #1:", 300),
        ("Full Tilt Poker Game #1", 300),
        ("FullTilt", 0),
    ] {
        assert_eq!(FullTiltParser.detect(text), expected, "{text:?}");
    }
    let _ = hand_of;
}
