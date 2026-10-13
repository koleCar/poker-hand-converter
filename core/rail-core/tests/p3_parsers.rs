//! The Full Tilt and Run It Once halves of the TypeScript suite, translated
//! (docs/RAIL-PLAN.md R0.10c): the Full Tilt and Run It Once parts of
//! `p3Parsers.test.ts` (both corpora, every Full Tilt and Run It Once test,
//! the shared detection namespace) and the Full Tilt part of `phfHiLo`.
//!
//! Left out, and why: the replayer checks (`buildReplay`, not ported - the
//! replayer half of "pays the whole pot out and never goes below zero") and
//! `phfHiLo`'s all-in EV check (`analyzeAllIn`, R2.2). The PokerBros parts of
//! `p3Parsers.test.ts` are `tests/p2pb_parsers.rs` (R0.8). `phfDetect`,
//! `phfOmaha` and `phfPositions` have no Full Tilt or Run It Once part. One
//! Rust test per TypeScript `it` (an `it.each` is one loop), named after it.

mod psgg_support;

use std::path::Path;
use std::sync::LazyLock;

use psgg_support::{STANDARD, all_invariants, blind_spots, parse, root};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, ParseError, ParseSkip, SiteParser};
use rail_core::parsers::builtin;
use rail_core::parsers::fulltilt::FullTiltParser;
use rail_core::parsers::pokerbros::PokerBrosParser;
use rail_core::parsers::runitonce::RunItOnceParser;
use rail_core::phf::serialize::{matches_at_line_start, parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, CurrencyKind, GameFormat, LimitType, PhfHand, Position, PotHalf, Street, Variant,
    contributions_from_actions, house_into_pot, total_fees,
};
use rail_core::validate::validate_hand;
use serde_json::json;

/* ----------------------------------------------------------------- corpus */

/// `SampleFile` of `tests/test/support/p2Corpus.ts`.
#[derive(Debug, Clone)]
struct SampleFile {
    name: String,
    relative_path: String,
    text: String,
}

/// `walk(dir)`: `.txt` and `.xml` files, sorted, recursively.
fn walk(dir: &Path, prefix: &str, out: &mut Vec<SampleFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let path = dir.join(&name);
        if path.is_dir() {
            walk(&path, &format!("{prefix}/{name}"), out);
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if !(lower.ends_with(".txt") || lower.ends_with(".xml")) {
            continue;
        }
        let bytes = std::fs::read(&path).expect("read sample");
        out.push(SampleFile {
            relative_path: format!("{prefix}/{name}"),
            name,
            text: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
}

/// `sampleFiles(site)`: `fixtures/samples/<site>/`, empty files dropped.
fn sample_files(site: &str) -> Vec<SampleFile> {
    let mut out = Vec::new();
    walk(
        &root().join("fixtures/samples").join(site),
        &format!("fixtures/samples/{site}"),
        &mut out,
    );
    out.retain(|file| !rail_core::js::trim(&file.text).is_empty());
    out
}

/// `otherSampleSites(exclude)`.
fn other_sample_sites(exclude: &[&str]) -> Vec<String> {
    let mut dirs: Vec<String> = std::fs::read_dir(root().join("fixtures/samples"))
        .expect("samples")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !exclude.contains(&name.as_str()))
        .collect();
    dirs.sort();
    dirs
}

/// `sample(relative)` of `phfHiLo`: UTF-8 with the BOM dropped.
fn sample(relative: &str) -> String {
    let bytes = std::fs::read(root().join("fixtures/samples").join(relative)).expect("sample");
    let text = String::from_utf8_lossy(&bytes).into_owned();
    text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_owned()
}

fn convert(text: &str, filename: Option<&str>) -> ConversionResult {
    rail_core::convert_any(
        text,
        &ConvertOptions {
            source_filename: filename.map(str::to_owned),
            ..ConvertOptions::default()
        },
    )
    .expect("convertAny threw")
}

fn hands(result: &ConversionResult) -> Vec<&PhfHand> {
    result.hands.iter().map(|h| &h.hand).collect()
}

fn ranked(text: &str) -> Vec<(&'static str, u32)> {
    builtin()
        .detect_site(text)
        .iter()
        .map(|c| (c.parser.id(), c.permille))
        .collect()
}

fn error_codes(hand: &PhfHand) -> Vec<String> {
    validate_hand(hand)
        .expect("validateHand threw")
        .errors()
        .map(|p| p.code.clone())
        .collect()
}

/// `contributionsOf(hand)`.
fn contributions_of(hand: &PhfHand) -> i64 {
    contributions_from_actions(hand)
        .iter()
        .map(|(_, amount)| amount)
        .sum()
}

/// `MY_DIRS`.
const MY_DIRS: [&str; 3] = ["full-tilt", "run-it-once", "pokerbros"];

/// One entry of `SITES`.
struct Site {
    id: &'static str,
    dir: &'static str,
    parser: &'static dyn SiteParser,
    signature: &'static LazyLock<regex::Regex>,
    reasons: &'static [&'static str],
    key_prefix: &'static str,
}

static FT_SIGNATURE: LazyLock<regex::Regex> =
    rail_core::js_regex_lazy!(r"^Full Tilt Poker Game #\d+:", "");
static RIO_SIGNATURE: LazyLock<regex::Regex> =
    rail_core::js_regex_lazy!(r"^Run It Once Poker (?:Hand|Tournament) #\d+", "");

const FULLTILT: Site = Site {
    id: "fulltilt",
    dir: "full-tilt",
    parser: &FullTiltParser,
    signature: &FT_SIGNATURE,
    reasons: &[
        "unsupported-variant",
        "unsupported-hi-lo",
        "no-seat-block",
        "tournament-unsupported",
        "unsupported-currency",
        "hand-cancelled",
        "normalized-unparseable",
        "unseated-actor",
    ],
    key_prefix: "FT",
};

const RUNITONCE: Site = Site {
    id: "runitonce",
    dir: "run-it-once",
    parser: &RunItOnceParser,
    signature: &RIO_SIGNATURE,
    reasons: &[
        "unsupported-variant",
        "no-hands",
        "no-seat-block",
        "unsupported-currency",
        "normalized-unparseable",
        "unseated-actor",
    ],
    key_prefix: "RIO",
};

/// `ALLOWED_WARNINGS`.
const ALLOWED_WARNINGS: [&str; 10] = [
    "run-it-twice-summary",
    "button-seat-empty",
    "hero-attribution",
    "ambiguous-timestamp",
    "unknown-timezone",
    "uncalled-includes-promo",
    "house-chips-mismatch",
    "rake-inferred",
    "no-summary",
    "board-from-summary",
];

/// `siteFiles(site)`: every sample whose *text* has the room's signature.
fn site_files(site: &Site) -> Vec<SampleFile> {
    let mut dirs: Vec<String> = MY_DIRS.iter().map(|d| (*d).to_owned()).collect();
    dirs.extend(other_sample_sites(&MY_DIRS));
    dirs.iter()
        .flat_map(|dir| sample_files(dir))
        .filter(|file| matches_at_line_start(site.signature, &file.text))
        .collect()
}

/// `handsOf(dir, prefix, parser)`.
fn hands_of(dir: &str, prefix: &str, parser: &dyn SiteParser) -> Vec<PhfHand> {
    let file = sample_files(dir)
        .into_iter()
        .find(|entry| entry.name.starts_with(prefix))
        .unwrap_or_else(|| panic!("fixture {prefix} is missing from fixtures/samples/{dir}/"));
    parser
        .split_hands(&file.text)
        .expect("split")
        .iter()
        .map(|chunk| parse(parser, chunk).expect("parsed"))
        .collect()
}

/// `skipFor(dir, prefix, parser)`.
fn skip_for(dir: &str, prefix: &str, parser: &dyn SiteParser) -> ParseSkip {
    let file = sample_files(dir)
        .into_iter()
        .find(|entry| entry.name.starts_with(prefix))
        .unwrap_or_else(|| panic!("fixture {prefix} is missing from fixtures/samples/{dir}/"));
    let chunks = parser.split_hands(&file.text).expect("split");
    let chunk = chunks.first().map_or(file.text.as_str(), String::as_str);
    match parse(parser, chunk) {
        Err(ParseError::Skip(skip)) => skip,
        other => panic!("{prefix} was expected to be refused, got {other:?}"),
    }
}

fn file_of(dir: &str, prefix: &str) -> SampleFile {
    sample_files(dir)
        .into_iter()
        .find(|entry| entry.name.starts_with(prefix))
        .expect("fixture")
}

/* ===================================================== the corpora */

fn finds_its_corpus(site: &Site) {
    let files = site_files(site);
    assert!(!files.is_empty(), "{}", site.id);
    let misplaced: Vec<&str> = files
        .iter()
        .filter(|file| !file.relative_path.contains(&format!("/{}/", site.dir)))
        .map(|file| file.relative_path.as_str())
        .collect();
    assert!(misplaced.is_empty(), "{misplaced:?}");
}

fn is_attributed_to_its_own_parser(site: &Site) {
    for file in site_files(site) {
        let ranking = ranked(&file.text);
        assert!(
            ranking
                .first()
                .is_some_and(|c| c.0 == site.id && c.1 >= 900),
            "{}: {ranking:?}",
            file.relative_path
        );
        let ids: Vec<&str> = ranking.iter().map(|c| c.0).collect();
        assert_eq!(ids, [site.id], "{}", file.relative_path);
    }
}

fn converts_or_refuses_with_a_machine_readable_reason(site: &Site) {
    for file in site_files(site) {
        let result = convert(&file.text, Some(&file.name));
        assert!(result.stats.total > 0, "{}", file.name);
        for failure in &result.failures {
            assert!(
                site.reasons.contains(&failure.reason.as_str()),
                "{}: {}",
                failure.reason.as_str(),
                failure.message
            );
            assert_eq!(failure.detected_site.as_deref(), Some(site.id));
            assert!(failure.message.chars().count() > 10);
            assert!(!failure.raw_text.is_empty());
        }
        for hand in hands(&result) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            assert_eq!(hand.meta.site_id, site.id, "{at}");
            assert_eq!(hand.meta.parser_id, site.id, "{at}");
            assert_eq!(hand.meta.parser_version, site.parser.version(), "{at}");
            assert_eq!(
                hand.meta.hand_key,
                format!("{}{}", site.key_prefix, hand.meta.hand_id),
                "{at}"
            );
            assert!(!hand.meta.raw_text.is_empty(), "{at}");
            // Full Tilt's `FL Omaha H/L` is the one non-Hold'em hand here.
            if hand.game.variant != Variant::Holdem {
                assert_eq!(
                    (site.id, hand.game.variant, hand.game.hi_lo),
                    ("fulltilt", Variant::Omaha, true),
                    "{at}"
                );
            }
            assert!(error_codes(hand).is_empty(), "{at}");
        }
    }
}

fn leaves_no_source_line_unread(site: &Site) {
    for file in site_files(site) {
        let result = convert(&file.text, Some(&file.name));
        let blind: Vec<String> = hands(&result).into_iter().flat_map(blind_spots).collect();
        assert!(blind.is_empty(), "{blind:?}");
        let unexpected: Vec<String> = hands(&result)
            .iter()
            .flat_map(|hand| {
                hand.meta
                    .warnings
                    .iter()
                    .filter(|w| !ALLOWED_WARNINGS.contains(&w.code.as_str()))
                    .map(|w| format!("{} {}: {}", hand.meta.hand_id, w.code, w.message))
            })
            .collect();
        assert!(unexpected.is_empty(), "{unexpected:?}");
    }
}

fn holds_every_invariant_in_every_hand(site: &Site) {
    for file in site_files(site) {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            let broken = all_invariants(hand);
            assert!(
                broken.is_empty(),
                "{} {}: {broken:?}",
                file.name,
                hand.meta.hand_id
            );
        }
    }
}

/// The replayer half of the TypeScript test (`buildReplay`) is not ported.
fn pays_the_whole_pot_out(site: &Site) {
    for file in site_files(site) {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            let paid: i64 = hand.results.winners.iter().map(|w| w.amount).sum();
            assert_eq!(
                paid + total_fees(&hand.results.fees),
                hand.results.total_pot,
                "{at} out"
            );
            assert_eq!(
                contributions_of(hand) + house_into_pot(hand),
                hand.results.total_pot,
                "{at} in"
            );
            assert!(hand.results.fees.rake >= 0, "{at} rake");
        }
    }
}

#[test]
fn full_tilt_finds_its_corpus() {
    finds_its_corpus(&FULLTILT);
}

#[test]
fn full_tilt_every_file_is_attributed_to_its_own_parser() {
    is_attributed_to_its_own_parser(&FULLTILT);
}

#[test]
fn full_tilt_converts_or_refuses_with_a_machine_readable_reason() {
    converts_or_refuses_with_a_machine_readable_reason(&FULLTILT);
}

#[test]
fn full_tilt_leaves_no_source_line_unread() {
    leaves_no_source_line_unread(&FULLTILT);
}

#[test]
fn full_tilt_holds_every_invariant_in_every_hand() {
    holds_every_invariant_in_every_hand(&FULLTILT);
}

#[test]
fn full_tilt_pays_the_whole_pot_out_and_never_goes_below_zero() {
    pays_the_whole_pot_out(&FULLTILT);
}

#[test]
fn run_it_once_finds_its_corpus() {
    finds_its_corpus(&RUNITONCE);
}

#[test]
fn run_it_once_every_file_is_attributed_to_its_own_parser() {
    is_attributed_to_its_own_parser(&RUNITONCE);
}

#[test]
fn run_it_once_converts_or_refuses_with_a_machine_readable_reason() {
    converts_or_refuses_with_a_machine_readable_reason(&RUNITONCE);
}

#[test]
fn run_it_once_leaves_no_source_line_unread() {
    leaves_no_source_line_unread(&RUNITONCE);
}

#[test]
fn run_it_once_holds_every_invariant_in_every_hand() {
    holds_every_invariant_in_every_hand(&RUNITONCE);
}

#[test]
fn run_it_once_pays_the_whole_pot_out_and_never_goes_below_zero() {
    pays_the_whole_pot_out(&RUNITONCE);
}

/* ========================================================== Full Tilt */

#[test]
fn reads_both_header_generations() {
    let modern = hands_of("full-tilt", "01-", &FullTiltParser).remove(0);
    assert_eq!(modern.game.label, "NL Hold'em");
    assert_eq!(
        (modern.game.small_blind, modern.game.big_blind),
        (500, 1000)
    );
    assert_eq!(modern.table.name.as_deref(), Some("Goldring"));
    assert_eq!(modern.table.max_seats, 2);

    let legacy = hands_of("full-tilt", "06-", &FullTiltParser).remove(0);
    assert_eq!(legacy.game.label, "$15 Cap No Limit Hold'em");
    assert_eq!((legacy.game.small_blind, legacy.game.big_blind), (25, 50));
    assert_eq!(legacy.table.name.as_deref(), Some("Bri"));
    assert_eq!(legacy.table.max_seats, 6);
}

#[test]
fn reads_the_of_phrased_uncalled_return() {
    let hand = hands_of("full-tilt", "01-", &FullTiltParser).remove(0);
    let uncalled = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(uncalled.amount, -2000);
    assert_eq!(uncalled.player, "Rene Lacoste");
    assert_eq!(hand.results.total_pot, 4000);
}

#[test]
fn does_not_read_and_is_capped_as_all_in() {
    let hand = hands_of("full-tilt", "02-", &FullTiltParser).remove(0);
    let capped: Vec<_> = hand
        .actions
        .iter()
        .filter(|a| a.raw_line.contains("capped"))
        .collect();
    assert_eq!(capped.len(), 2);
    assert!(capped.iter().all(|a| !a.all_in));
}

#[test]
fn splits_a_run_it_twice_hand_into_two_runouts_and_pays_one_pot_to_each() {
    let hand = hands_of("full-tilt", "02-", &FullTiltParser).remove(0);
    assert_eq!(hand.board.runouts.len(), 2);
    assert_eq!(hand.board.runouts[1].flop, None);
    assert_eq!(hand.board.runouts[1].turn, None);
    assert_eq!(hand.board.runouts[1].river.as_deref(), Some("2h"));
    assert_eq!(
        serde_json::to_value(&hand.results.winners).expect("json"),
        json!([
            { "player": "Darkking_pt", "seat": 6, "amount": 31100, "runoutIndex": 0 },
            { "player": "1mperial", "seat": 4, "amount": 31100, "runoutIndex": 1 },
        ])
    );
    assert!(hand.meta.text_style.run_it_twice_note);
}

#[test]
fn keeps_the_fold_streets_the_summary_block_states() {
    let hand = hands_of("full-tilt", "02-", &FullTiltParser).remove(0);
    let seat = |n: u32| {
        hand.results
            .players
            .iter()
            .find(|p| p.seat == n)
            .expect("seat")
    };
    assert_eq!(seat(3).folded_street, Some(Street::Preflop));
    assert_eq!(seat(2).folded_street, Some(Street::Flop));
    assert!(seat(5).didnt_bet);
}

#[test]
fn takes_fixed_limit_blinds_from_what_was_posted_not_from_the_header() {
    let hand = hands_of("full-tilt", "07-", &FullTiltParser).remove(0);
    assert_eq!(hand.game.limit, LimitType::Fl);
    assert_eq!((hand.game.small_blind, hand.game.big_blind), (2, 5));
}

#[test]
fn leaves_a_sitting_out_seat_out_of_the_position_ring() {
    let file = file_of("full-tilt", "05-");
    let result = convert(&file.text, Some(&file.name));
    let position = |seat: u32| {
        result.hands[0]
            .hand
            .players
            .iter()
            .find(|p| p.seat == seat)
            .and_then(|p| p.position)
    };
    assert_eq!(position(8), None);
    assert_eq!(position(7), Some(Position::Utg));
    assert_eq!(position(9), Some(Position::Utg1));
    assert_eq!(position(4), Some(Position::Btn));
    assert_eq!(position(5), Some(Position::Sb));
}

#[test]
fn splits_a_multi_hand_file_on_the_header_not_on_the_blank_lines() {
    let hands = hands_of("full-tilt", "05-", &FullTiltParser);
    assert_eq!(hands.len(), 10);
    let mut ids: Vec<&str> = hands.iter().map(|h| h.meta.hand_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 5);
}

#[test]
fn keeps_table_chat_out_of_the_action_stream() {
    let text = [
        "Full Tilt Poker Game #1: Table Vernon - NL Hold'em - $0.50/$1 - 15:45:47 ET - 2014/01/06",
        "Seat 5: WTFseeB8 ($114.95)",
        "Seat 6: pupsaa ($60.30)",
        "WTFseeB8 posts the small blind of $0.50",
        "pupsaa posts the big blind of $1",
        "The button is in seat #5",
        "*** HOLE CARDS ***",
        "pupsaa: idi0t lucker",
        "WTFseeB8 folds",
        "Uncalled bet of $0.50 returned to pupsaa",
        "pupsaa mucks",
        "pupsaa wins the pot ($1)",
        "*** SUMMARY ***",
        "Total pot $1 | Rake $0",
        "Seat 5: WTFseeB8 (small blind) folded before the Flop",
        "Seat 6: pupsaa (big blind) collected ($1), mucked",
    ]
    .join("\n");
    let hand = parse(&FullTiltParser, &text).expect("hand");
    assert!(hand.meta.warnings.is_empty(), "{:?}", hand.meta.warnings);
    assert!(!hand.actions.iter().any(|a| a.raw_line.contains("idi0t")));
    assert!(error_codes(&hand).is_empty());
}

#[test]
fn refuses_a_hand_that_has_no_seat_listing() {
    let skip = skip_for("full-tilt", "13-", &FullTiltParser);
    assert_eq!(skip.reason.as_str(), "no-seat-block");
}

/// A winner's player, amount and half.
type Half<'a> = (&'a str, i64, Option<PotHalf>);

#[test]
fn splits_its_omaha_by_the_header_high_reads_high_hi_lo_reads_both_halves() {
    let cases: [(&str, &str, Vec<Half>); 3] = [
        (
            "03-",
            "PL Omaha H/L",
            vec![
                ("ReydelMundo", 6155, Some(PotHalf::Hi)),
                ("pupsaa", 6155, Some(PotHalf::Lo)),
            ],
        ),
        (
            "08-",
            "FL Omaha H/L",
            // $7.75 split at the table's nickel: the odd five cents go high.
            vec![
                ("Greszik", 390, Some(PotHalf::Hi)),
                ("SomeStupid", 385, Some(PotHalf::Lo)),
            ],
        ),
        // Uncontested: nothing was split, so no half.
        ("14-", "PL Omaha H/L", vec![("pupsaa", 100, None)]),
    ];
    for (fixture, label, halves) in cases {
        let hand = hands_of("full-tilt", fixture, &FullTiltParser).remove(0);
        assert_eq!(hand.game.label, label, "{fixture}");
        assert!(hand.game.hi_lo, "{fixture}");
        assert!(hand.meta.warnings.is_empty(), "{fixture}");
        let winners: Vec<Half> = hand
            .results
            .winners
            .iter()
            .map(|w| (w.player.as_str(), w.amount, w.half))
            .collect();
        assert_eq!(winners, halves, "{fixture}");
        let pots: Vec<Option<&str>> = hand
            .actions
            .iter()
            .filter(|a| a.kind == ActionType::Collect)
            .map(|a| a.pot_name.as_deref())
            .collect();
        assert_eq!(pots, vec![Some("pot"); halves.len()], "{fixture}");
    }

    let high = hands_of("full-tilt", "11-", &FullTiltParser).remove(0);
    assert_eq!(high.game.variant, Variant::Omaha);
    assert_eq!(high.game.limit, LimitType::Pl);
    assert!(!high.game.hi_lo);
    assert!(high.meta.warnings.is_empty());
}

#[test]
fn refuses_a_tournament_rather_than_inventing_a_grammar_for_one() {
    let text = "Full Tilt Poker Game #1: $10 + $1 Sit & Go (123456), Table 1 - 15/30 - No Limit \
                Hold'em - 20:00:00 ET - 2010/01/01\nSeat 1: x (1500)";
    match parse(&FullTiltParser, text) {
        Err(ParseError::Skip(skip)) => {
            assert_eq!(skip.reason.as_str(), "tournament-unsupported");
            assert!(skip.message.contains("unconfirmed"));
        }
        other => panic!("a tournament hand was expected to be refused, got {other:?}"),
    }
}

#[test]
fn refuses_a_cancelled_hand() {
    let text = [
        "Full Tilt Poker Game #2: Table Bri (6 max) - NL Hold'em - $0.25/$0.50 - 18:46:08 ET - 2011/02/28",
        "Seat 1: a ($56.15)",
        "Seat 2: b ($36.60)",
        "a posts the small blind of $0.25",
        "Hand #2 has been canceled",
    ]
    .join("\n");
    match parse(&FullTiltParser, &text) {
        Err(ParseError::Skip(skip)) => assert_eq!(skip.reason.as_str(), "hand-cancelled"),
        other => panic!("a cancelled hand was expected to be refused, got {other:?}"),
    }
}

#[test]
fn does_not_claim_a_headerless_fragment() {
    let file = file_of("full-tilt", "09-");
    assert_eq!(FullTiltParser.detect(&file.text), 0);
    assert!(ranked(&file.text).is_empty());
    let result = convert(&file.text, Some(&file.name));
    assert_eq!(result.failures[0].reason.as_str(), "unknown-site");
}

/* ======================================================= Run It Once */

#[test]
fn reads_the_one_word_showdown_marker_and_the_table_id_line() {
    let hand = hands_of("run-it-once", "03-", &RunItOnceParser).remove(0);
    assert!(hand.meta.text_style.showdown_section);
    assert_eq!(hand.table.name.as_deref(), Some("55582350"));
    assert_eq!(hand.table.max_seats, 3);
    assert_eq!(hand.table.button_seat, Some(5));
}

#[test]
fn puts_the_uncalled_return_back_on_the_street_it_was_bet_on() {
    let hand = hands_of("run-it-once", "03-", &RunItOnceParser).remove(0);
    let uncalled = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(uncalled.street, Street::Turn);
    assert_eq!(uncalled.amount, -80);
    assert!(error_codes(&hand).is_empty());
}

#[test]
fn reads_a_tournament_header_that_has_no_level_and_does_have_a_name() {
    let hand = hands_of("run-it-once", "03-", &RunItOnceParser).remove(0);
    assert_eq!(hand.game.format, GameFormat::Tournament);
    assert_eq!(hand.game.unit.kind, CurrencyKind::Chips);
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert_eq!(tournament.id, "158168");
    assert_eq!(tournament.name.as_deref(), Some("Cub3d"));
    assert_eq!((tournament.buy_in, tournament.fee), (469, 31));
    assert_eq!(tournament.level_label, None);
    assert_eq!(
        (tournament.level_small_blind, tournament.level_big_blind),
        (10, 20)
    );
    assert_eq!(tournament.buy_in_unit.code, "EUR");
    assert_eq!((hand.game.small_blind, hand.game.big_blind), (10, 20));
    assert_eq!(hand.played_at.as_deref(), Some("2021-04-12T16:01:00.000Z"));
}

#[test]
fn names_the_hero_from_the_seat_tag_rather_than_the_first_deal_line() {
    let hand = hands_of("run-it-once", "03-", &RunItOnceParser).remove(0);
    let heroes: Vec<&str> = hand
        .players
        .iter()
        .filter(|p| p.is_hero)
        .map(|p| p.name.as_str())
        .collect();
    assert_eq!(heroes, ["Doc"]);
    assert_eq!(hand.results.hero_net, Some(-40));
}

#[test]
fn books_splash_the_pot_chips_as_house_money_rather_than_a_players_bet() {
    let hand = hands_of("run-it-once", "01-", &RunItOnceParser).remove(0);
    assert_eq!(
        serde_json::to_value(&hand.chip_movements).expect("json"),
        json!([{
            "kind": "splash-the-pot",
            "fromSeat": null,
            "fromPlayer": null,
            "toPot": true,
            "amount": 50,
            "raw": "STP added: \u{20ac}0.50",
            "anchor": "after-hole-cards",
        }])
    );
    assert_eq!(hand.results.total_pot, 75);
    assert_eq!(contributions_of(&hand), 25);
    assert!(error_codes(&hand).is_empty());

    let winner = hand
        .results
        .players
        .iter()
        .find(|p| p.player == "Galen U")
        .expect("winner");
    assert_eq!((winner.contributed, winner.won, winner.net), (10, 71, 61));
}

#[test]
fn caps_an_uncalled_return_that_the_room_inflated_with_the_splash() {
    let hand = hands_of("run-it-once", "01-", &RunItOnceParser).remove(0);
    let uncalled = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("uncalled");
    assert_eq!(uncalled.amount, -21);
    assert_eq!(uncalled.street, Street::Flop);
    assert!(
        hand.meta
            .warnings
            .iter()
            .any(|w| w.code == "uncalled-includes-promo")
    );
}

#[test]
fn round_trips_the_splash_line_through_standard_text() {
    let hand = hands_of("run-it-once", "01-", &RunItOnceParser).remove(0);
    let text = to_standard_text(&hand);
    assert!(text.contains("STP added: \u{20ac}0.50"));
    let back = parse_standard_hand(&text, &STANDARD)
        .expect("reader threw")
        .expect("hand");
    assert_eq!(back.chip_movements, hand.chip_movements);
    assert_eq!(back.results.total_pot, hand.results.total_pot);
    assert_eq!(to_standard_text(&back), text);
}

#[test]
fn refuses_the_omaha_hand_for_its_variant() {
    let skip = skip_for("run-it-once", "02-", &RunItOnceParser);
    assert_eq!(skip.reason.as_str(), "unsupported-variant");
    assert!(skip.message.contains("Omaha Pot Limit"), "{}", skip.message);
}

#[test]
fn claims_a_tournament_summary_file_but_finds_no_hands_in_it() {
    let file = file_of("run-it-once", "04-");
    assert_eq!(RunItOnceParser.detect(&file.text), 950);
    assert!(
        RunItOnceParser
            .split_hands(&file.text)
            .expect("split")
            .is_empty()
    );
    let result = convert(&file.text, Some(&file.name));
    assert_eq!(result.failures[0].reason.as_str(), "no-hands");
    assert_eq!(
        result.failures[0].detected_site.as_deref(),
        Some("runitonce")
    );
}

#[test]
fn is_not_claimed_by_the_pokerstars_parser_and_does_not_claim_pokerstars() {
    let rio = &sample_files("run-it-once")[0].text;
    let ids: Vec<&str> = ranked(rio).into_iter().map(|c| c.0).collect();
    assert_eq!(ids, ["runitonce"]);
    let stars = [
        "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
        "Table 'Aaltje II' 6-max Seat #2 is the button",
        "Seat 1: villain ($10 in chips)",
    ]
    .join("\n");
    assert_eq!(RunItOnceParser.detect(&stars), 0);
}

/* ============================================ the shared namespace */

/// `no Full Tilt / RIO / PokerBros parser claims a %s sample`, for every
/// other sample directory (PokerBros is also `tests/p2pb_parsers.rs`).
#[test]
fn no_full_tilt_rio_pokerbros_parser_claims_another_rooms_sample() {
    let parsers: [&dyn SiteParser; 3] = [&FullTiltParser, &RunItOnceParser, &PokerBrosParser];
    let mut claims = Vec::new();
    for dir in other_sample_sites(&MY_DIRS) {
        for file in sample_files(&dir) {
            for parser in parsers {
                let score = parser.detect(&file.text);
                if score > 0 {
                    claims.push(format!(
                        "{} claims {} at {score}",
                        parser.id(),
                        file.relative_path
                    ));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

/// `no other parser claims a %s sample`, for the three directories (over
/// the ported parsers).
#[test]
fn no_other_parser_claims_a_full_tilt_rio_or_pokerbros_sample() {
    let mine = ["fulltilt", "runitonce", "pokerbros"];
    let mut claims = Vec::new();
    for dir in MY_DIRS {
        for file in sample_files(dir) {
            for (id, _) in ranked(&file.text) {
                if !mine.contains(&id) {
                    claims.push(format!("{id} claims {}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn never_throws_whatever_it_is_handed() {
    let parsers: [&dyn SiteParser; 3] = [&FullTiltParser, &RunItOnceParser, &PokerBrosParser];
    for parser in parsers {
        for text in [
            "",
            " ",
            "hello",
            "Poker Hand #1:",
            "PokerStars Hand #1:",
            "*****",
        ] {
            let _ = parser.detect(text);
            parser.split_hands(text).expect("split");
        }
    }
}

#[test]
fn claims_branding_without_a_header_only_weakly() {
    assert_eq!(
        FullTiltParser.detect("posted on Full Tilt Poker in 2011"),
        300
    );
    assert_eq!(
        RunItOnceParser.detect("Run It Once Poker closed in 2022"),
        300
    );
    assert_eq!(PokerBrosParser.detect("a PokerBros club game"), 300);
}

/* ====================================================== phfHiLo */

/// `hand(relative)` of `phfHiLo`: converted with no refusal, one hand.
fn hi_lo_hand(relative: &str) -> PhfHand {
    let mut result = convert(&sample(relative), Some(relative));
    assert!(result.failures.is_empty(), "{relative}");
    assert_eq!(result.hands.len(), 1, "{relative}");
    result.hands.remove(0).hand
}

fn halves(hand: &PhfHand) -> Vec<(String, i64, Option<PotHalf>)> {
    hand.results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount, w.half))
        .collect()
}

#[test]
fn pays_a_two_way_split_high_and_low_full_tilt_the_rooms_own_words() {
    assert_eq!(
        halves(&hi_lo_hand(
            "full-tilt/03-cash-plo-hilo-showdown-hi-lo-split.txt"
        )),
        [
            ("ReydelMundo".to_owned(), 6155, Some(PotHalf::Hi)),
            ("pupsaa".to_owned(), 6155, Some(PotHalf::Lo)),
        ]
    );
}

/// `every converted hi/lo fixture` for Full Tilt's three files; the
/// `analyzeAllIn` check is R2.2.
#[test]
fn every_converted_hi_lo_fixture_validates_balances_and_round_trips_with_its_halves() {
    for file in [
        "full-tilt/03-cash-plo-hilo-showdown-hi-lo-split.txt",
        "full-tilt/08-cash-flo8-fixed-limit-omaha-hilo.txt",
        "full-tilt/14-cash-plo-hilo-chatline-uncalled-bet.txt",
    ] {
        let result = convert(&sample(file), Some(file));
        assert!(result.failures.is_empty(), "{file}");
        assert!(!result.hands.is_empty(), "{file}");
        for converted in &result.hands {
            let subject = &converted.hand;
            let at = format!("{file} {}", subject.meta.hand_id);
            assert!(subject.game.hi_lo, "{at}");
            assert_eq!(subject.game.variant, Variant::Omaha, "{at}");
            let notes: Vec<&str> = subject
                .meta
                .warnings
                .iter()
                .map(|w| w.code.as_str())
                .filter(|code| *code != "streets-inferred")
                .collect();
            assert!(notes.is_empty(), "{at}: {notes:?}");
            let report = validate_hand(subject).expect("validateHand threw");
            assert_eq!(report.errors().count(), 0, "{at}");
            assert_eq!(
                report
                    .warnings()
                    .filter(|w| w.code.starts_with("hi-lo"))
                    .count(),
                0,
                "{at}"
            );
            let collects: Vec<Option<PotHalf>> = subject
                .actions
                .iter()
                .filter(|a| a.kind == ActionType::Collect)
                .map(|a| a.half)
                .collect();
            let winners: Vec<Option<PotHalf>> =
                subject.results.winners.iter().map(|w| w.half).collect();
            assert_eq!(winners, collects, "{at}");

            let text = to_standard_text(subject);
            let back = parse_standard_hand(&text, &STANDARD)
                .expect("reader threw")
                .expect("hand");
            assert!(back.meta.warnings.is_empty(), "{at}");
            assert!(back.game.hi_lo, "{at}");
            assert_eq!(halves(&back), halves(subject), "{at}");
            assert_eq!(to_standard_text(&back), text, "{at}");
        }
    }
}
