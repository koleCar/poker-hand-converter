//! The WePlay and CoinPoker halves of the TypeScript suite, translated
//! (docs/RAIL-PLAN.md R0.7b): all of `weplayParserPhf.test.ts` and
//! `coinpokerParser.test.ts`, `byteCompat.test.ts` (against the frozen
//! pre-PHF converter's output, recorded in `tests/data/wpcp-vectors.json`),
//! and the WePlay parts of `phfRoundTrip`, `phfPositions`, `phfDetect`,
//! `phfValidate` and `handParser`.
//!
//! Left out, and why: the replayer checks (`buildReplay`, not ported) and
//! `toBigBlinds` (a display helper, not ported - no floats in the core).
//! `handParser`'s WePlay test drives `converter.ts`'s `convertCashWeplayFile`,
//! the UI's legacy facade, which is not part of the core: its few lines are
//! reproduced here as test support. One Rust test per TypeScript `it`
//! (an `it.each` is one loop), named after it.

mod psgg_support;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use psgg_support::{
    CorpusFile, STANDARD, blind_spots, chip_conservation, gg_corpus_files, no_negative_stacks,
    pot_fully_awarded, read_tree, root, round_trips_through_standard_text, sample_files,
    seats_and_cards, uncalled_within_commitment,
};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext, SkipReason};
use rail_core::parsers::builtin;
use rail_core::parsers::coinpoker::{CoinPokerParser, looks_like_coinpoker};
use rail_core::parsers::weplay::WePlayParser;
use rail_core::phf::serialize::{parse_standard_hand, split_standard_hands, to_standard_text};
use rail_core::phf::{
    ActionType, AnteModel, CurrencyKind, GameFormat, PhfHand, PhfStraddle, PhfWinner, Position,
    SeatOutcome, Street,
};
use rail_core::positions::assign_positions;
use rail_core::validate::validate_hand;
use serde_json::Value;

/* ----------------------------------------------------------------- shared */

fn convert_with(text: &str, options: &ConvertOptions) -> ConversionResult {
    rail_core::convert_any(text, options).expect("convertAny threw")
}

fn convert(text: &str, filename: &str) -> ConversionResult {
    convert_with(
        text,
        &ConvertOptions {
            source_filename: Some(filename.to_owned()),
            ..ConvertOptions::default()
        },
    )
}

fn hands(result: &ConversionResult) -> Vec<&PhfHand> {
    result.hands.iter().map(|h| &h.hand).collect()
}

fn reasons(result: &ConversionResult) -> Vec<&str> {
    result.failures.iter().map(|f| f.reason.as_str()).collect()
}

fn top(text: &str) -> Option<(&'static str, u32)> {
    builtin()
        .detect_site(text)
        .first()
        .map(|c| (c.parser.id(), c.permille))
}

fn by_site(result: &ConversionResult, site: &str) -> Option<u32> {
    result
        .stats
        .by_site
        .iter()
        .find(|(id, _)| id == site)
        .map(|(_, n)| *n)
}

/// `weplayFiles()` of `tests/test/support/corpus.ts`: both account folders
/// of `weplay-hh/`, each sorted, read as UTF-8 as they are (BOM kept).
static WEPLAY_FILES: LazyLock<Vec<CorpusFile>> = LazyLock::new(|| {
    let base = root().join("weplay-hh");
    let mut dirs: Vec<String> = std::fs::read_dir(&base)
        .expect("weplay-hh/")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    // `localeCompare`; the two folder names order the same way bytewise.
    dirs.sort();
    dirs.iter()
        .flat_map(|dir| read_tree(&base.join(dir), &format!("weplay-hh/{dir}")))
        .collect()
});

/// Every WePlay file converted once, as `convertAny(file.text, {
/// sourceFilename })` - shared by the round-trip, position, detection and
/// validation tests.
static WEPLAY_CONVERTED: LazyLock<Vec<ConversionResult>> = LazyLock::new(|| {
    WEPLAY_FILES
        .iter()
        .map(|file| convert(&file.text, &file.name))
        .collect()
});

/* =================================================== weplayParserPhf.test */

fn weplay_fixture(name: &str) -> String {
    let path = root().join("tests/test/fixtures/weplay").join(name);
    String::from_utf8_lossy(&std::fs::read(&path).expect("fixture")).into_owned()
}

struct Converted {
    result: ConversionResult,
    text: String,
}

impl Converted {
    fn reasons(&self) -> Vec<&str> {
        reasons(&self.result)
    }
    fn hands(&self) -> Vec<&PhfHand> {
        hands(&self.result)
    }
}

/// `convert(name, options)`: cash only and no bomb pots unless overridden.
fn convert_fixture(name: &str, cash_only: bool, skip_bomb_pots: bool) -> Converted {
    let result = convert_with(
        &weplay_fixture(name),
        &ConvertOptions {
            source_filename: Some(name.to_owned()),
            cash_only,
            skip_bomb_pots,
            ..ConvertOptions::default()
        },
    );
    let text = result
        .hands
        .iter()
        .map(|h| to_standard_text(&h.hand))
        .collect::<Vec<_>>()
        .join("\n\n");
    Converted { result, text }
}

fn fixture_default(name: &str) -> Converted {
    convert_fixture(name, true, true)
}

#[test]
fn weplay_normalizes_the_showdown_token_and_strips_utc_from_the_header() {
    let result = convert_fixture("tournament-sample.txt", false, true);
    assert!(result.text.contains("*** SHOWDOWN ***"));
    assert!(!result.text.contains("*** SHOW DOWN ***"));
    assert!(!result.text.contains("UTC"));
}

#[test]
fn weplay_rewrites_an_sb_open_from_chips_added_to_raise_over() {
    let result = fixture_default("raise-sb-open.txt");
    assert!(result.text.contains("antananarivo: raises $2 to $3"));
    assert!(!result.text.contains("raises $2.50 to $3"));
}

#[test]
fn weplay_rewrites_a_button_open_to_raise_over_the_current_bet() {
    let result = fixture_default("raise-button-open.txt");
    assert!(result.text.contains("antananarivo: raises $1.50 to $2.50"));
    assert!(!result.text.contains("raises $2.50 to $2.50"));
}

#[test]
fn weplay_rewrites_a_3_bet_chain_with_the_right_over_amounts() {
    let result = fixture_default("raise-3bet.txt");
    assert!(result.text.contains("Tone91: raises $1.50 to $2.50"));
    assert!(result.text.contains("kole1992: raises $9.51 to $12.01"));
    assert!(!result.text.contains("raises $11.01 to $12.01"));
}

#[test]
fn weplay_rewrites_a_short_covering_all_in_raise_below_the_current_bet_to_a_call() {
    let result = fixture_default("short-allin-raise-cover.txt");
    assert_eq!(result.hands().len(), 1);
    assert!(result.text.contains("kole1992: calls $7.40 and is all-in"));
    assert!(!result.text.contains("raises $7.40 to $7.90"));
}

#[test]
fn weplay_rewrites_hidden_showdown_cards_to_a_muck() {
    let result = fixture_default("hidden-showdown-cards.txt");
    assert!(result.text.contains("KratkiLucky: doesn't show hand"));
    assert!(!result.text.contains("##"));
}

#[test]
fn weplay_scrubs_hidden_cards_from_summary_showed_lines() {
    let result = fixture_default("summary-hidden-cards.txt");
    assert_eq!(result.hands().len(), 1);
    assert!(!result.text.contains("##"));
    assert!(
        result
            .text
            .contains("LukasFlopovski (button) folded before Flop")
    );
    assert!(!result.text.contains("folded before Flop showed"));
    assert!(
        result
            .text
            .contains("petit_blaireau (small blind) showed [Jd Tc]")
    );
}

#[test]
fn weplay_strips_phantom_river_boards_on_preflop_walks() {
    let result = fixture_default("phantom-river-walk.txt");
    assert_eq!(result.hands().len(), 1);
    assert!(!result.text.contains("*** RIVER ***"));
    assert!(!result.text.contains("Board ["));
    assert!(result.text.contains("petike21 collected $2 from pot"));
}

#[test]
fn weplay_records_a_ghost_ante_as_a_failure_rather_than_converting_it() {
    let result = fixture_default("ghost-ante.txt");
    assert!(result.hands().is_empty());
    assert!(result.reasons().contains(&"ghost-ante"));
}

#[test]
fn weplay_records_a_zero_stack_actor_as_a_failure() {
    let result = fixture_default("zero-stack-actor.txt");
    assert!(result.hands().is_empty());
    assert!(result.reasons().contains(&"zero-stack-actor"));
}

#[test]
fn weplay_records_a_bb_only_walk_as_a_failure() {
    let result = fixture_default("bb-only-walk.txt");
    assert!(result.hands().is_empty());
    assert!(result.reasons().contains(&"bb-only-walk"));
}

#[test]
fn weplay_records_a_short_all_in_small_blind_as_a_failure() {
    let result = fixture_default("short-sb-allin.txt");
    assert!(result.hands().is_empty());
    assert!(result.reasons().contains(&"short-allin-small-blind"));
}

#[test]
fn weplay_keeps_omaha_for_a_future_parser_instead_of_mangling_it() {
    let result = fixture_default("omaha-6card.txt");
    assert!(result.hands().is_empty());
    assert!(result.reasons().contains(&"unsupported-variant"));
    assert!(result.result.failures[0].raw_text.contains("Weplay Hand #"));
}

#[test]
fn weplay_skips_bomb_pots_on_request_but_converts_them_by_default() {
    let skipped = fixture_default("bomb-pot-ante.txt");
    assert!(skipped.hands().is_empty());
    assert!(skipped.reasons().contains(&"bomb-pot"));

    let kept = convert_fixture("bomb-pot-ante.txt", true, false);
    assert_eq!(kept.hands().len(), 1);
    assert!(kept.hands()[0].game.bomb_pot.is_some());
    assert_eq!(kept.hands()[0].game.ante_model, AnteModel::PostedPerPlayer);
}

#[test]
fn weplay_converts_tournaments_with_the_level_and_buy_in_parsed() {
    let result = convert_fixture("tournament-sample.txt", false, true);
    assert_eq!(result.hands().len(), 1);
    let hand = result.hands()[0];
    assert_eq!(hand.game.format, GameFormat::Tournament);
    assert_eq!(hand.game.unit.kind, CurrencyKind::Chips);
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert!(!tournament.id.is_empty());
    assert!(tournament.buy_in > 0);
    assert!(tournament.level_number.is_some_and(|n| n > 0));
}

#[test]
fn weplay_parses_a_straddle_into_the_pot_math() {
    let text = [
        "Weplay Hand #90000001:  Hold'em No Limit ($1/$2) - 2026/01/03 22:12:42 UTC",
        "Table 'Lisbon #1'(11485806) 6-max (Money 3) Seat #5 is the button",
        "Seat 1: kole1992 ($200 in chips)",
        "Seat 2: Kadiddy ($136.34 in chips)",
        "Seat 3: UribnP ($221.17 in chips)",
        "kole1992: posts small blind $1",
        "Kadiddy: posts big blind $2",
        "UribnP: posts straddle $4",
        "*** HOLE CARDS ***",
        "Dealt to kole1992 [Ad Js]",
        "kole1992: raises $13 to $14",
        "Kadiddy: folds",
        "UribnP: folds",
        "Uncalled bet ($10) returned to kole1992",
        "*** SHOW DOWN ***",
        "kole1992: doesn't show hand",
        "kole1992 collected $10 from pot",
        "*** SUMMARY ***",
        "Total pot $10 | Rake $0",
        "Seat 1: kole1992 (small blind) collected ($10)",
        "Seat 2: Kadiddy (big blind) folded before Flop",
        "Seat 3: UribnP folded before Flop",
    ]
    .join("\n");
    let result = convert(&text, "straddle.txt");
    assert_eq!(result.hands.len(), 1);
    let hand = &result.hands[0].hand;
    assert_eq!(
        hand.game.straddles,
        [PhfStraddle {
            seat: 3,
            player: "UribnP".to_owned(),
            amount: 400,
            order: 1,
        }]
    );
    // The raise is reported over the straddle, not over the big blind.
    assert!(to_standard_text(hand).contains("kole1992: raises $10 to $14"));
}

/* =================================================== coinpokerParser.test */

static CP_FILES: LazyLock<Vec<CorpusFile>> = LazyLock::new(|| sample_files("coinpoker"));

fn ctx_parse(raw: &str, options: &ConvertOptions) -> Result<PhfHand, ParseError> {
    CoinPokerParser.parse_hand(
        raw,
        &SiteParserContext {
            source_filename: None,
            options,
        },
    )
}

fn cp_parse(raw: &str) -> Result<PhfHand, ParseError> {
    ctx_parse(raw, &ConvertOptions::default())
}

/// `parseOrSkip`: the hand with positions assigned, or the refusal reason.
fn parse_or_skip(chunk: &str) -> Result<PhfHand, SkipReason> {
    match cp_parse(chunk) {
        Ok(mut hand) => {
            assign_positions(&mut hand);
            Ok(hand)
        }
        Err(ParseError::Skip(skip)) => Err(skip.reason),
        Err(ParseError::Bug(message)) => panic!("threw: {message}"),
    }
}

struct CpParsed {
    file: String,
    result: Result<PhfHand, SkipReason>,
}

static CP_PARSED: LazyLock<Vec<CpParsed>> = LazyLock::new(|| {
    CP_FILES
        .iter()
        .flat_map(|file| {
            CoinPokerParser
                .split_hands(&file.text)
                .expect("split")
                .into_iter()
                .filter(|chunk| looks_like_coinpoker(chunk))
                .map(|chunk| CpParsed {
                    file: file.relative_path.clone(),
                    result: parse_or_skip(&chunk),
                })
        })
        .collect()
});

fn cp_hands() -> Vec<&'static PhfHand> {
    CP_PARSED
        .iter()
        .filter_map(|p| p.result.as_ref().ok())
        .collect()
}

fn cp_file(prefix: &str) -> &'static CorpusFile {
    CP_FILES
        .iter()
        .find(|file| file.name.starts_with(prefix))
        .unwrap_or_else(|| panic!("fixture {prefix} is missing from fixtures/samples/coinpoker/"))
}

fn cp_first_chunk(text: &str) -> String {
    CoinPokerParser.split_hands(text).expect("split")[0].clone()
}

/// `fixture(prefix)`: the file's first hand, parsed, positions assigned.
fn cp_fixture(prefix: &str) -> PhfHand {
    parse_or_skip(&cp_first_chunk(&cp_file(prefix).text))
        .unwrap_or_else(|reason| panic!("fixture {prefix} was skipped as {reason}"))
}

/* -------------------------------------------------------- the corpus --- */

#[test]
fn coinpoker_has_the_16_real_fixtures_the_research_pass_shipped() {
    assert_eq!(CP_FILES.len(), 16);
    // 22 hands across 16 files: 01 and 16 hold four each, the rest one.
    assert_eq!(CP_PARSED.len(), 22);
}

#[test]
fn coinpoker_splits_on_the_header_because_one_blank_line_separates_hands() {
    let multi = cp_file("01");
    assert!(!multi.text.contains("\n\n\n"));
    assert_eq!(
        CoinPokerParser
            .split_hands(&multi.text)
            .expect("split")
            .len(),
        4
    );
}

#[test]
fn coinpoker_parses_with_no_unknown_lines() {
    for (i, entry) in CP_PARSED.iter().enumerate() {
        match &entry.result {
            // A refusal has to be machine-readable.
            Err(reason) => assert!(
                reason
                    .as_str()
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '-'),
                "{} #{i}",
                entry.file
            ),
            Ok(hand) => assert_eq!(
                blind_spots(hand),
                Vec::<String>::new(),
                "{} #{i}",
                entry.file
            ),
        }
    }
}

#[test]
fn coinpoker_hand_holds_the_chip_invariants() {
    for hand in cp_hands() {
        let problems = [
            chip_conservation(hand),
            no_negative_stacks(hand),
            pot_fully_awarded(hand),
            uncalled_within_commitment(hand),
            seats_and_cards(hand),
        ]
        .concat();
        assert!(problems.is_empty(), "{}: {problems:?}", hand.meta.hand_id);
    }
}

#[test]
fn coinpoker_hand_validates_with_zero_errors() {
    for hand in cp_hands() {
        let report = validate_hand(hand).expect("validateHand threw");
        assert_eq!(report.errors().count(), 0, "{}", hand.meta.hand_id);
        assert!(report.ok());
    }
}

#[test]
fn coinpoker_hand_survives_a_round_trip_through_standard_text() {
    for hand in cp_hands() {
        assert_eq!(
            round_trips_through_standard_text(hand),
            Vec::<String>::new(),
            "{}",
            hand.meta.hand_id
        );
    }
}

#[test]
fn coinpoker_converts_every_hand_it_does_not_deliberately_refuse() {
    let mut converted = 0;
    let mut refused = 0;
    for file in CP_FILES.iter() {
        let result = convert(&file.text, &file.name);
        converted += result.stats.converted;
        refused += result.stats.failed;
        // Nothing may fail but the one cancelled hand.
        assert!(
            reasons(&result).iter().all(|r| *r == "hand-cancelled"),
            "{}",
            file.name
        );
        assert!(hands(&result).iter().all(|h| h.meta.site_id == "coinpoker"));
    }
    assert_eq!(converted, 21);
    assert_eq!(refused, 1);
}

/* ------------------------------------------------------- detection --- */

#[test]
fn coinpoker_ranks_coinpoker_first() {
    for file in CP_FILES.iter() {
        assert_eq!(
            top(&file.text),
            Some(("coinpoker", 950)),
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn coinpoker_scores_0_on_every_other_sites_fixtures() {
    let others = [
        "888poker",
        "bossmedia",
        "entraction",
        "ggpoker",
        "ipoker",
        "merge",
        "microgaming",
        "ongame",
        "partypoker",
        "pokerbros",
        "pokerstars",
        "unibet",
        "weplay",
        "winamax",
        "wpt-global",
    ];
    for site in others {
        for file in sample_files(site) {
            assert_eq!(
                CoinPokerParser.detect(&file.text),
                0,
                "{site}/{}",
                file.name
            );
        }
    }
}

#[test]
fn coinpoker_does_not_claim_the_pokerstars_grammar_it_is_descended_from() {
    let stars = [
        "PokerStars Hand #123456789:  Hold'em No Limit ($0.01/$0.02 USD) - 2021/01/01 1:00:00 ET",
        "Table 'Test' 6-max Seat #1 is the button",
        "Seat 1: alice ($2 in chips)",
    ]
    .join("\n");
    assert_eq!(CoinPokerParser.detect(&stars), 0);
    assert_eq!(top(&stars).map(|(id, _)| id), Some("pokerstars"));

    let coin = &CP_FILES[0].text;
    let pokerstars = builtin().get("pokerstars").expect("pokerstars");
    assert_eq!(pokerstars.detect(coin), 0);
    assert_eq!(CoinPokerParser.detect(coin), 950);
}

#[test]
fn coinpoker_claims_a_header_less_coinpoker_paste_only_weakly() {
    assert_eq!(CoinPokerParser.detect("exported from CoinPoker"), 300);
    assert_eq!(CoinPokerParser.detect("Seat 1: alice (2.00 in chips)"), 0);
    assert_eq!(
        CoinPokerParser.detect("Game ended: 2025/06/19 18:53:39 GMT"),
        0
    );
}

/* ----------------------------------------------------------- money --- */

#[test]
fn coinpoker_denominates_cash_hands_in_usdt_at_one_hundred_minor_units() {
    let hand = cp_fixture("02");
    let unit = &hand.game.unit;
    assert_eq!(
        (
            unit.code.as_str(),
            unit.symbol.as_str(),
            unit.minor_units,
            unit.kind
        ),
        ("USDT", "$", 100, CurrencyKind::Cash)
    );
    assert_eq!(hand.game.small_blind, 1);
    assert_eq!(hand.game.big_blind, 2);
    let stack = hand
        .players
        .iter()
        .find(|p| p.name == "cp17par")
        .map(|p| p.starting_stack);
    assert_eq!(stack, Some(224));
    assert_eq!(hand.results.total_pot, 11);
    assert_eq!(hand.results.fees.rake, 1);
}

#[test]
fn coinpoker_every_printed_amount_in_the_corpus_fits_two_decimal_places() {
    let three_places = rail_core::js::regex::js_regex(r"\d+\.\d{3,}", "");
    for file in CP_FILES.iter() {
        let count = file
            .text
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .filter(|line| !line.starts_with("CoinPoker Hand #"))
            .filter(|line| three_places.is_match(line))
            .count();
        assert_eq!(count, 0, "{}", file.name);
    }
}

fn skip_reason(result: Result<PhfHand, ParseError>) -> SkipReason {
    match result {
        Err(ParseError::Skip(skip)) => skip.reason,
        Err(ParseError::Bug(message)) => panic!("threw: {message}"),
        Ok(_) => panic!("expected a refusal"),
    }
}

#[test]
fn coinpoker_refuses_a_hand_it_cannot_hold_exactly_rather_than_rounding_it() {
    let over = cp_file("02")
        .text
        .replacen("posts small blind 0.01", "posts small blind 0.015", 1);
    let result = cp_parse(&cp_first_chunk(&over));
    let Err(ParseError::Skip(skip)) = &result else {
        panic!("expected a refusal");
    };
    assert!(skip.message.contains("more precision"));
    assert_eq!(skip.reason, SkipReason::UnsupportedPrecision);
}

#[test]
fn coinpoker_keeps_tournament_stacks_in_chips_and_refuses_a_fractional_one() {
    let hand = cp_fixture("12");
    assert_eq!(hand.game.unit.minor_units, 1);
    let stack = hand
        .players
        .iter()
        .find(|p| p.name == "nlin")
        .map(|p| p.starting_stack);
    assert_eq!(stack, Some(5000));
    assert_eq!(hand.game.big_blind, 100);
    // `toBigBlinds(5000, bigBlind) == 50`: a display helper, not ported.

    let fractional = cp_file("12")
        .text
        .replacen("posts the ante 13", "posts the ante 13.5", 1);
    assert_eq!(
        skip_reason(cp_parse(&cp_first_chunk(&fractional))),
        SkipReason::UnsupportedPrecision
    );
}

#[test]
fn coinpoker_does_not_read_the_tournament_names_amounts_as_a_buy_in() {
    let hand = cp_fixture("13");
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert_eq!(
        tournament.name.as_deref(),
        Some("₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD")
    );
    assert_eq!(tournament.buy_in, 0);
    assert_eq!(tournament.fee, 0);
    assert!(
        hand.meta
            .warnings
            .iter()
            .any(|w| w.code == "buy-in-not-stated")
    );
    // A freeroll's zero buy-in is the truth, so it carries no flag.
    assert!(cp_fixture("12").meta.warnings.is_empty());
}

/* ---------------------------------------------------- line grammar --- */

fn action<'h>(
    hand: &'h PhfHand,
    player: &str,
    kind: ActionType,
) -> impl Iterator<Item = &'h rail_core::phf::PhfAction> {
    let player = player.to_owned();
    hand.actions
        .iter()
        .filter(move |a| a.player == player && a.kind == kind)
}

fn result_of<'h>(hand: &'h PhfHand, player: &str) -> &'h rail_core::phf::PhfPlayerResult {
    hand.results
        .players
        .iter()
        .find(|p| p.player == player)
        .unwrap_or_else(|| panic!("no result for {player}"))
}

#[test]
fn coinpoker_reads_an_all_in_raise_that_has_no_to_as_chips_added_fixture_05() {
    let hand = cp_fixture("05");
    let raise = action(&hand, "waqqas", ActionType::Raise)
        .next()
        .expect("raise");
    assert_eq!(raise.raw_line, "waqqas: raises 0.46 and is all-in");
    assert!(raise.all_in);
    assert_eq!(raise.amount, 46);
    assert_eq!(raise.street_total, 46);
    assert_eq!(result_of(&hand, "waqqas").contributed, 64);
    let normal = action(&hand, "StoicMind", ActionType::Raise)
        .next()
        .expect("raise");
    assert_eq!(normal.raw_line, "StoicMind: raises 0.16 to 0.18");
    assert_eq!(normal.street_total, 18);
}

#[test]
fn coinpoker_adds_an_all_in_raise_to_what_the_player_already_had_in_fixture_01() {
    let hand = cp_hands()
        .into_iter()
        .find(|h| h.meta.hand_id == "352695201")
        .expect("hand 352695201");
    // IFriendsY raises twice; the all-in is the second one.
    let raise = action(hand, "IFriendsY", ActionType::Raise)
        .nth(1)
        .expect("raise");
    assert_eq!(raise.raw_line, "IFriendsY: raises 2.00 and is all-in");
    assert_eq!(raise.street_total, 205);
    assert_eq!(raise.amount, 200);
    assert_eq!(hand.results.total_pot, 416);
}

#[test]
fn coinpoker_keeps_the_seat_line_suffixes_after_the_closing_paren_fixture_10() {
    let hand = cp_fixture("10");
    assert_eq!(hand.players.len(), 7);
    let sitting_out = |name: &str| {
        hand.players
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.sitting_out)
    };
    assert_eq!(sitting_out("BehiAce"), Some(true));
    assert_eq!(sitting_out("KERK3K"), Some(true));
    assert_eq!(sitting_out("waqqas"), Some(false));
}

#[test]
fn coinpoker_treats_a_dead_small_blind_as_dead_money_fixture_10() {
    let hand = cp_fixture("10");
    let dead = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::MissedBlind)
        .expect("dead blind");
    assert_eq!(dead.raw_line, "waqqas: posts small blind (dead) 0.01");
    assert_eq!(dead.street_total, 0);
    let call = action(&hand, "waqqas", ActionType::Call)
        .next()
        .expect("call");
    assert_eq!(call.street_total, 6);
    assert_eq!(result_of(&hand, "waqqas").contributed, 7);
}

#[test]
fn coinpoker_reads_a_second_live_big_blind_without_moving_the_ring_fixtures_06_11() {
    let hand = cp_fixture("06");
    let posts: Vec<_> = hand
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::BigBlind)
        .collect();
    assert_eq!(
        posts.iter().map(|a| a.player.as_str()).collect::<Vec<_>>(),
        ["waqqas", "HornyMelon"]
    );
    let position = |name: &str| {
        hand.players
            .iter()
            .find(|p| p.name == name)
            .and_then(|p| p.position)
    };
    assert_eq!(position("waqqas"), Some(Position::Bb));
    assert_eq!(position("HornyMelon"), Some(Position::Hj));
    assert_eq!(posts[1].street_total, 2);
}

#[test]
fn coinpoker_tags_the_straddler_and_still_classifies_their_summary_line_fixture_04() {
    let hand = cp_fixture("04");
    assert_eq!(
        hand.game.straddles,
        [PhfStraddle {
            seat: 3,
            player: "donkme123".to_owned(),
            amount: 4,
            order: 1,
        }]
    );
    let straddler = result_of(&hand, "donkme123");
    assert_eq!(straddler.position_labels, ["(straddle)"]);
    assert_eq!(straddler.outcome, SeatOutcome::Lost);
    assert_eq!(straddler.shown_cards, ["3h", "Ts"]);
    let position = hand
        .players
        .iter()
        .find(|p| p.name == "donkme123")
        .and_then(|p| p.position);
    assert_eq!(position, Some(Position::Utg));
}

#[test]
fn coinpoker_keeps_coinpokers_own_hand_description_wording_fixtures_08_09() {
    let trips = cp_fixture("08");
    assert_eq!(
        result_of(&trips, "crabcruncher")
            .hand_description
            .as_deref(),
        Some("three of kind, Queens")
    );
    let boat = cp_fixture("09");
    assert_eq!(
        result_of(&boat, "2waHang").hand_description.as_deref(),
        Some("a full house, Sevens over Nines")
    );
    let show = action(&boat, "nlin", ActionType::Show)
        .next()
        .expect("show");
    assert_eq!(
        show.description.as_deref(),
        Some("a full house, Sevens over Eights")
    );
}

#[test]
fn coinpoker_reads_the_space_padded_summary_board_and_the_empty_one_fixtures_01_07() {
    let walk = cp_fixture("07");
    assert_eq!(walk.board.runouts[0].summary_cards, Some(Vec::new()));
    assert_eq!(walk.results.street_reached, Street::Preflop);
    let turn = cp_parse(&cp_first_chunk(&cp_file("01").text)).expect("hand");
    let runout = &turn.board.runouts[0];
    assert_eq!(
        runout.summary_cards.as_deref(),
        Some(&["Jd", "6c", "5h", "5c"].map(str::to_owned)[..])
    );
    assert_eq!(
        runout.flop.as_deref(),
        Some(&["Jd", "6c", "5h"].map(str::to_owned)[..])
    );
    assert_eq!(runout.turn.as_deref(), Some("5c"));
}

#[test]
fn coinpoker_pays_a_side_pot_coinpoker_spells_with_a_hyphen_fixture_14() {
    let hand = cp_fixture("14");
    let winner = |player: &str, seat: u32, amount: i64| PhfWinner {
        player: player.to_owned(),
        seat: Some(seat),
        amount,
        runout_index: 0,
        ..hand.results.winners[0].clone()
    };
    assert_eq!(
        hand.results.winners,
        [
            winner("Alena160520", 5, 52),
            winner("LegendaryHacker", 7, 7611)
        ]
    );
    assert!(hand.results.winners.iter().all(|w| w.half.is_none()));
    let pots: Vec<_> = hand
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::Collect)
        .map(|a| a.pot_name.as_deref())
        .collect();
    assert_eq!(pots, [Some("side-pot 1"), Some("pot")]);
    assert_eq!(hand.results.total_pot, 7663);
}

#[test]
fn coinpoker_balances_an_all_in_raise_that_was_never_returned_fixture_13() {
    let hand = cp_fixture("13");
    assert!(!hand.actions.iter().any(|a| a.kind == ActionType::Uncalled));
    assert_eq!(hand.results.total_pot, 5715);
    let winner = result_of(&hand, "rmanamiri");
    assert_eq!(winner.contributed, 5000);
    assert_eq!(winner.won, 5715);
    assert_eq!(winner.net, 715);
}

#[test]
fn coinpoker_drops_the_time_bank_and_disconnect_vocabulary_fixtures_06_16() {
    let time_bank = rail_core::js::regex::js_regex(r"activated time-bank \(\d+ seconds\)", "");
    let noise = rail_core::js::regex::js_regex(r"time-bank|disconnect", "");
    for prefix in ["06", "16"] {
        let file = cp_file(prefix);
        assert!(time_bank.is_match(&file.text));
        for chunk in CoinPokerParser.split_hands(&file.text).expect("split") {
            let hand = cp_parse(&chunk).expect("hand");
            assert!(hand.meta.warnings.is_empty());
            assert!(!hand.actions.iter().any(|a| noise.is_match(&a.raw_line)));
        }
    }
}

#[test]
fn coinpoker_drops_didnt_post_big_blind_which_is_not_a_bet_fixture_07() {
    let hand = cp_fixture("07");
    assert!(!hand.actions.iter().any(|a| a.player == "pddro11"));
    let position = hand
        .players
        .iter()
        .find(|p| p.name == "pddro11")
        .map(|p| p.position);
    assert_eq!(position, Some(None));
    assert_eq!(hand.results.total_pot, 3);
}

#[test]
fn coinpoker_refuses_a_cancelled_hand_rather_than_reporting_a_seven_way_split() {
    let result = parse_or_skip(&cp_first_chunk(&cp_file("15").text));
    assert_eq!(result.err(), Some(SkipReason::HandCancelled));
}

#[test]
fn coinpoker_refuses_a_variant_it_has_not_been_written_for() {
    let omaha = cp_file("02")
        .text
        .replacen("Hold'em No Limit", "Omaha Pot Limit", 1);
    let result = parse_or_skip(&cp_first_chunk(&omaha));
    assert_eq!(result.err(), Some(SkipReason::UnsupportedVariant));
}

#[test]
fn coinpoker_refuses_a_tournament_in_cash_only_mode() {
    let chunk = cp_first_chunk(&cp_file("12").text);
    let options = ConvertOptions {
        cash_only: true,
        ..ConvertOptions::default()
    };
    assert!(matches!(
        ctx_parse(&chunk, &options),
        Err(ParseError::Skip(_))
    ));
}

/* -------------------------------------------------------- positions --- */

#[test]
fn coinpoker_hand_agrees_with_its_own_summary_position_words() {
    for hand in cp_hands() {
        let acted: HashSet<Option<u32>> = hand.actions.iter().map(|a| a.seat).collect();
        for result in &hand.results.players {
            let player = hand
                .players
                .iter()
                .find(|p| p.seat == result.seat)
                .expect("seated");
            for label in &result.position_labels {
                let expected = match label.as_str() {
                    "(small blind)" => Some(Position::Sb),
                    "(big blind)" => Some(Position::Bb),
                    // Only when that seat was dealt in (fixtures 13, 14).
                    "(button)" if acted.contains(&Some(result.seat)) => Some(Position::Btn),
                    _ => None,
                };
                if let Some(expected) = expected {
                    assert_eq!(player.position, Some(expected), "{}", result.player);
                }
            }
        }
    }
}

#[test]
fn coinpoker_names_no_button_when_the_button_seat_is_dead_fixture_14() {
    let hand = cp_fixture("14");
    assert_eq!(hand.table.button_seat, Some(2));
    let position = |seat: u32| {
        hand.players
            .iter()
            .find(|p| p.seat == seat)
            .and_then(|p| p.position)
    };
    assert_eq!(position(2), None);
    assert_eq!(position(1), Some(Position::Co));
    assert!(
        !hand
            .players
            .iter()
            .any(|p| p.position == Some(Position::Btn))
    );
}

/* ------------------------------------------------------- provenance --- */

#[test]
fn coinpoker_hand_carries_the_sites_own_text_and_a_stable_key() {
    let played_at =
        rail_core::js::regex::js_regex(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$", "");
    for hand in cp_hands() {
        let meta = &hand.meta;
        assert_eq!(meta.site_id, "coinpoker");
        assert_eq!(meta.site_name, "CoinPoker");
        assert_eq!(meta.parser_id, "coinpoker");
        assert_eq!(meta.parser_version, CoinPokerParser.version());
        assert_eq!(meta.hand_key, format!("CP{}", meta.hand_id));
        assert!(
            meta.raw_text
                .starts_with(&format!("CoinPoker Hand #{}:", meta.hand_id))
        );
        assert!(played_at.is_match(hand.played_at.as_deref().unwrap_or("")));
        assert_eq!(hand.table.max_seats, 7);
    }
}

#[test]
fn coinpoker_re_generates_the_summary_seat_lines_so_every_amount_keeps_its_symbol() {
    for hand in cp_hands() {
        for result in &hand.results.players {
            assert_ne!(result.outcome, SeatOutcome::Unknown);
            assert_eq!(result.raw, None);
        }
    }
    let text = to_standard_text(&cp_fixture("04"));
    assert!(text.contains("Seat 3: donkme123 (straddle) showed [3h Ts] and lost"));
    assert!(text.contains(
        "Seat 7: NorthKing (button) showed [Ad 9h] and won ($0.20) with a pair of Nines"
    ));
    // Chip amounts stay bare, because the tournament unit has no symbol.
    assert!(
        to_standard_text(&cp_fixture("13"))
            .contains("Seat 4: rmanamiri (big blind) collected (5715)")
    );
}

#[test]
fn coinpoker_identifies_the_hero_from_the_deal_line_since_there_is_no_hero_literal() {
    for hand in cp_hands() {
        let heroes: Vec<_> = hand.players.iter().filter(|p| p.is_hero).collect();
        assert_eq!(heroes.len(), 1);
        assert_eq!(heroes[0].name, "nlin");
        assert!(hand.results.hero_net.is_some());
    }
}

/* ======================================================= byteCompat.test */

static LEGACY: LazyLock<Value> = LazyLock::new(|| {
    let vectors: Value =
        serde_json::from_str(include_str!("data/wpcp-vectors.json")).expect("wpcp-vectors.json");
    vectors["legacy"].clone()
});

/// `classify(oldText, newText)`: the three reviewed kinds of difference.
fn classify(old_text: &str, new_text: &str) -> Option<&'static str> {
    let a: Vec<&str> = old_text.split('\n').collect();
    let b: Vec<&str> = new_text.split('\n').collect();
    let only_old: Vec<&str> = a.iter().copied().filter(|line| !b.contains(line)).collect();
    let only_new: Vec<&str> = b.iter().copied().filter(|line| !a.contains(line)).collect();
    if only_old.is_empty() && only_new.is_empty() {
        return Some("duplicate-hole-cards-block");
    }
    if only_old
        .iter()
        .all(|line| line.contains("activates time bank"))
        && only_new.is_empty()
    {
        return Some("time-bank-line");
    }
    if old_text.contains(": posts straddle ")
        && only_old.iter().all(|line| line.contains(": raises "))
        && only_new.iter().all(|line| line.contains(": raises "))
    {
        return Some("straddle-raise-amount");
    }
    None
}

#[test]
fn byte_compat_standard_text_is_byte_compatible_with_the_pre_phf_converter() {
    let files = WEPLAY_FILES.as_slice();
    // "has something to compare"
    assert!(files.len() > 50);

    let recorded = LEGACY["files"].as_array().expect("legacy files");
    assert_eq!(recorded.len(), files.len(), "the WePlay corpus changed");
    let mut legacy_hands = 0_usize;
    let mut identical = 0_usize;
    let mut accepted: BTreeMap<&str, usize> = BTreeMap::new();
    let mut dropped = 0_usize;
    let mut unexplained: Vec<String> = Vec::new();

    for (file, record) in files.iter().zip(recorded) {
        assert_eq!(record["path"], file.relative_path.as_str());
        let result = convert_with(
            &file.text,
            &ConvertOptions {
                source_filename: Some(file.name.clone()),
                cash_only: true,
                skip_bomb_pots: true,
                ..ConvertOptions::default()
            },
        );
        let actual: HashMap<&str, String> = result
            .hands
            .iter()
            .map(|h| (h.hand.meta.hand_id.as_str(), to_standard_text(&h.hand)))
            .collect();
        for expected in record["hands"].as_array().expect("hands") {
            legacy_hands += 1;
            let id = expected["id"].as_str().expect("id");
            let Some(fresh) = actual.get(id) else {
                // Dropped hands must be dropped for a stated reason.
                if result
                    .failures
                    .iter()
                    .any(|f| f.raw_text.contains(&id[2..]))
                {
                    dropped += 1;
                } else {
                    unexplained.push(format!("{id}: missing with no failure record"));
                }
                continue;
            };
            let fresh_sha = &sha256_hex(fresh)[..16];
            if expected["sha"].as_str() == Some(fresh_sha) {
                identical += 1;
                continue;
            }
            let Some(old_text) = expected["text"].as_str() else {
                unexplained.push(format!(
                    "{id}: the legacy text was identical and is not any more"
                ));
                continue;
            };
            match classify(old_text, fresh) {
                Some(kind) => *accepted.entry(kind).or_default() += 1,
                None => unexplained.push(format!("{id}: unclassified difference")),
            }
        }
    }
    assert!(unexplained.is_empty(), "{unexplained:#?}");

    // "keeps the overwhelming majority byte identical"
    assert!(legacy_hands > 5000);
    assert!(
        identical * 100 > legacy_hands * 96,
        "{identical} of {legacy_hands}"
    );
    assert!(dropped < 5);
    // And exactly the TypeScript's tally.
    let totals = &LEGACY["totals"];
    assert_eq!(Some(legacy_hands as u64), totals["legacyHands"].as_u64());
    assert_eq!(Some(identical as u64), totals["identical"].as_u64());
    assert_eq!(Some(dropped as u64), totals["dropped"].as_u64());
    let expected_accepted: BTreeMap<&str, usize> = totals["accepted"]
        .as_object()
        .expect("accepted")
        .iter()
        .map(|(k, v)| {
            (
                k.as_str(),
                usize::try_from(v.as_u64().expect("n")).expect("usize"),
            )
        })
        .collect();
    assert_eq!(accepted, expected_accepted);
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/* ===================================================== phfRoundTrip.test */

#[test]
fn round_trip_finds_the_weplay_corpus() {
    assert!(WEPLAY_FILES.len() > 50);
}

#[test]
fn round_trip_round_trips_every_converted_weplay_hand() {
    for (file, result) in WEPLAY_FILES.iter().zip(WEPLAY_CONVERTED.iter()) {
        assert!(result.stats.total > 0, "{}", file.relative_path);
        for converted in &result.hands {
            let text = to_standard_text(&converted.hand);
            let first_line = text.split('\n').next().unwrap_or("");
            let reparsed = parse_standard_hand(&text, &STANDARD)
                .expect("threw")
                .unwrap_or_else(|| panic!("{first_line} did not parse back"));
            // No information is lost on the way out and back in.
            assert_eq!(to_standard_text(&reparsed), text, "{first_line}");
            assert!(reparsed.meta.warnings.is_empty(), "{first_line}");
        }
    }
}

#[test]
fn round_trip_converts_the_overwhelming_majority_of_the_weplay_corpus() {
    let total: u32 = WEPLAY_CONVERTED.iter().map(|r| r.stats.total).sum();
    let converted: u32 = WEPLAY_CONVERTED.iter().map(|r| r.stats.converted).sum();
    assert!(total > 6000);
    assert!(u64::from(converted) * 100 > u64::from(total) * 98);
}

/* ===================================================== phfPositions.test */

/// `positionDisagreements`.
fn position_disagreements(hand: &PhfHand) -> Vec<String> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for result in &hand.results.players {
        for label in &result.position_labels {
            *counts.entry(label.as_str()).or_default() += 1;
        }
    }
    if counts.values().any(|count| *count > 1) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for result in &hand.results.players {
        let player = hand.players.iter().find(|p| p.seat == result.seat);
        let has = |label: &str| result.position_labels.iter().any(|l| l == label);
        let expected = if has("(small blind)") {
            Some(Position::Sb)
        } else if has("(big blind)") {
            Some(Position::Bb)
        } else if has("(button)") {
            Some(Position::Btn)
        } else {
            None
        };
        if let Some(expected) = expected
            && player.and_then(|p| p.position) != Some(expected)
        {
            out.push(format!(
                "{} seat {}: summary says {expected:?}, PHF says {:?}",
                hand.meta.hand_id,
                result.seat,
                player.and_then(|p| p.position)
            ));
        }
    }
    out
}

#[test]
fn positions_agree_with_the_summary_block_over_every_weplay_file() {
    for (file, result) in WEPLAY_FILES.iter().zip(WEPLAY_CONVERTED.iter()) {
        for hand in hands(result) {
            assert_eq!(
                position_disagreements(hand),
                Vec::<String>::new(),
                "{}",
                file.relative_path
            );
        }
    }
}

#[test]
fn positions_cover_every_table_size_heads_up_included() {
    let mut sizes: BTreeMap<usize, usize> = BTreeMap::new();
    for file in gg_corpus_files() {
        for chunk in split_standard_hands(&file.text) {
            let hand = parse_standard_hand(&chunk, &STANDARD)
                .expect("threw")
                .expect("fixture did not parse");
            *sizes.entry(hand.players.len()).or_default() += 1;
        }
    }
    for result in WEPLAY_CONVERTED.iter() {
        for hand in hands(result) {
            *sizes.entry(hand.players.len()).or_default() += 1;
        }
    }
    assert!(sizes.get(&2).copied().unwrap_or(0) > 50);
    assert!(sizes.get(&3).copied().unwrap_or(0) > 50);
    assert_eq!(
        sizes.keys().copied().collect::<Vec<_>>(),
        [2, 3, 4, 5, 6, 7, 8, 9]
    );
}

/* ======================================================== phfDetect.test */

#[test]
fn detect_ships_the_two_parsers_the_format_architect_owns() {
    let ids: Vec<&str> = builtin().parsers().map(SiteParser::id).collect();
    assert!(ids.contains(&"standard") && ids.contains(&"weplay"));
    assert_eq!(
        builtin().get("weplay").map(SiteParser::name),
        Some("WePlay")
    );
}

#[test]
fn detect_every_weplay_file_is_detected_as_weplay() {
    for file in WEPLAY_FILES.iter() {
        assert_eq!(
            top(&file.text).map(|(id, _)| id),
            Some("weplay"),
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn detect_re_detects_our_own_output_as_the_standard_format() {
    let file = &WEPLAY_FILES[0];
    let result = &WEPLAY_CONVERTED[0];
    let text = result
        .hands
        .iter()
        .map(|h| to_standard_text(&h.hand))
        .collect::<Vec<_>>()
        .join("\n\n");
    assert_eq!(
        top(&text).map(|(id, _)| id),
        Some("standard"),
        "{}",
        file.name
    );

    let again = convert(&text, "roundtrip.txt");
    assert_eq!(again.stats.converted, result.stats.converted);
    assert_eq!(
        again.stats.by_site,
        [("standard".to_owned(), result.stats.converted)]
    );
}

#[test]
fn detect_counts_hands_per_site() {
    let result = &WEPLAY_CONVERTED[0];
    let converted = u32::try_from(result.hands.len()).expect("u32");
    assert_eq!(result.stats.converted, converted);
    assert_eq!(by_site(result, "weplay"), Some(converted));
    assert_eq!(
        result.stats.total,
        result.stats.converted + result.stats.failed
    );
}

#[test]
fn detect_can_be_told_to_skip_tournaments_and_bomb_pots() {
    let tournament = WEPLAY_FILES
        .iter()
        .find(|file| file.text.contains("Tournament"))
        .expect("a tournament file");
    let open = convert(&tournament.text, &tournament.name);
    let cash_only = convert_with(
        &tournament.text,
        &ConvertOptions {
            source_filename: Some(tournament.name.clone()),
            cash_only: true,
            ..ConvertOptions::default()
        },
    );
    assert!(open.stats.converted > 0);
    assert_eq!(cash_only.stats.converted, 0);
    assert!(
        reasons(&cash_only)
            .iter()
            .all(|r| *r == "tournament-in-cash-mode")
    );
}

/* ====================================================== phfValidate.test */

#[test]
fn validate_rejects_every_weplay_hand_it_cannot_vouch_for_with_a_reason() {
    let mut failures = 0;
    let mut all_reasons: HashSet<&str> = HashSet::new();
    for result in WEPLAY_CONVERTED.iter() {
        for failure in &result.failures {
            failures += 1;
            all_reasons.insert(failure.reason.as_str());
            assert!(!failure.message.is_empty());
            assert!(
                failure.fingerprint.len() == 64
                    && failure
                        .fingerprint
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            );
        }
        for hand in hands(result) {
            assert!(
                validate_hand(hand).expect("validateHand threw").ok(),
                "{}",
                hand.meta.hand_id
            );
        }
    }
    assert!(failures > 0);
    assert!(all_reasons.iter().all(|reason| {
        reason
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }));
}

/* ======================================================= handParser.test */

/// `convertCashWeplayFile` (`frontend/src/lib/converter.ts`): the UI's legacy
/// facade, as test support - the WePlay parser with cash only and no bomb
/// pots, validated, joined with blank lines.
fn convert_cash_weplay_file(file_name: &str, input: &str) -> Option<String> {
    let chunks = WePlayParser.split_hands(input).expect("split");
    let options = ConvertOptions {
        source_filename: Some(file_name.to_owned()),
        cash_only: true,
        skip_bomb_pots: true,
        ..ConvertOptions::default()
    };
    let ctx = SiteParserContext {
        source_filename: Some(file_name),
        options: &options,
    };
    let hands: Vec<PhfHand> = chunks
        .iter()
        .filter_map(|chunk| WePlayParser.parse_hand(chunk, &ctx).ok())
        .filter(|hand| validate_hand(hand).expect("validateHand threw").ok())
        .collect();
    (!hands.is_empty()).then(|| {
        hands
            .iter()
            .map(to_standard_text)
            .collect::<Vec<_>>()
            .join("\n\n")
    })
}

#[test]
fn hand_parser_parses_every_hand_the_converter_emits_from_the_real_weplay_files() {
    let dir = root().join("weplay-hh/h.kolaric992@gmail.com");
    let files = read_tree(&dir, "weplay-hh/h.kolaric992@gmail.com");
    assert!(!files.is_empty());

    let mut total = 0;
    let mut failures: Vec<String> = Vec::new();
    let mut unknown: HashSet<String> = HashSet::new();
    for file in &files {
        let Some(output) = convert_cash_weplay_file(&file.name, &file.text) else {
            continue;
        };
        for chunk in split_standard_hands(&output) {
            // `parseHand` of `phf/index.ts` is `parseStandardHand` with the
            // standard context.
            match parse_standard_hand(&chunk, &STANDARD).expect("threw") {
                Some(hand) => {
                    total += 1;
                    unknown.extend(hand.meta.warnings.iter().map(|w| w.code.clone()));
                    // `buildReplay` ends on an award frame: the replayer is
                    // not ported.
                }
                None => failures.push(chunk.split('\n').next().unwrap_or("").to_owned()),
            }
        }
    }
    assert!(total > 50);
    assert!(failures.is_empty(), "{failures:?}");
    assert!(unknown.is_empty(), "{unknown:?}");
}
