//! `tests/test/pokerstarsParser.test.ts` and `tests/test/ggpokerParser.test.ts`
//! translated, with the PokerStars and GGPoker parts of `phfDetect`,
//! `phfOmaha`, `phfHiLo` and `shortDeck` (docs/RAIL-PLAN.md R0.7a).
//!
//! Left out, and why: the replayer checks (`buildReplay`, not ported), the
//! statistics and equity checks of `phfHiLo` and `shortDeck` (`handFacts`,
//! `analyzeAllIn`: R2.1, R2.2), and the ACR short-deck file (R0.10). Everything
//! else is here, one Rust test per TypeScript `it`, named after it.

mod psgg_support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use psgg_support::{
    CorpusFile, FOREIGN_SITES, STANDARD, all_invariants, error_codes, gg_corpus_files,
    own_fixtures, parse, parse_with, sample_files, validates,
};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, ParseError, ParseSkip, SiteParser, SkipReason};
use rail_core::parsers::builtin;
use rail_core::parsers::ggpoker::GgPokerParser;
use rail_core::parsers::pokerstars::PokerStarsParser;
use rail_core::phf::hilo::assign_hi_lo_halves;
use rail_core::phf::serialize::{parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, AnteModel, CurrencyKind, DecimalStyle, GameFormat, LimitType, PhfAction, PhfFees,
    PhfHand, PhfPot, Position, PotHalf, Street, Variant, card_in_deck, cash_unit, is_button_blind,
};

/* ----------------------------------------------------------------- shared */

fn top(text: &str) -> Option<(&'static str, u32)> {
    builtin()
        .detect_site(text)
        .first()
        .map(|c| (c.parser.id(), c.permille))
}

fn convert(text: &str, filename: Option<&str>) -> ConversionResult {
    let options = ConvertOptions {
        source_filename: filename.map(str::to_owned),
        ..ConvertOptions::default()
    };
    rail_core::convert_any(text, &options).expect("convertAny threw")
}

fn reasons(result: &ConversionResult) -> Vec<String> {
    result
        .failures
        .iter()
        .map(|f| f.reason.as_str().to_owned())
        .collect()
}

fn by_site(result: &ConversionResult) -> Vec<(String, u32)> {
    result.stats.by_site.clone()
}

fn warning_codes(hand: &PhfHand) -> Vec<&str> {
    hand.meta.warnings.iter().map(|w| w.code.as_str()).collect()
}

fn names(hand: &PhfHand) -> Vec<&str> {
    hand.players.iter().map(|p| p.name.as_str()).collect()
}

fn halves(hand: &PhfHand) -> Vec<(String, i64, Option<PotHalf>)> {
    hand.results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount, w.half))
        .collect()
}

fn skip_of(result: Result<PhfHand, ParseError>) -> ParseSkip {
    match result {
        Err(ParseError::Skip(skip)) => skip,
        Err(ParseError::Bug(message)) => panic!("threw, not a refusal: {message}"),
        Ok(hand) => panic!("{} was expected to be refused", hand.meta.hand_id),
    }
}

fn lines(text: &[&str]) -> String {
    text.join("\n")
}

/// A corpus chunk and what the parser made of it (`Parsed`).
struct Parsed {
    file: String,
    raw: String,
    outcome: Result<PhfHand, ParseError>,
}

impl Parsed {
    fn hand(&self) -> Option<&PhfHand> {
        self.outcome.as_ref().ok()
    }
    fn skip(&self) -> Option<&ParseSkip> {
        match &self.outcome {
            Err(ParseError::Skip(skip)) => Some(skip),
            _ => None,
        }
    }
}

fn parse_all(parser: &dyn SiteParser, files: &[CorpusFile]) -> Vec<Parsed> {
    files
        .iter()
        .flat_map(|file| {
            parser
                .split_hands(&file.text)
                .expect("split")
                .into_iter()
                .map(|raw| Parsed {
                    file: file.name.clone(),
                    outcome: parse(parser, &raw),
                    raw,
                })
        })
        .collect()
}

/* ================================================== pokerstarsParser.test */

static PS_CORPUS: LazyLock<Vec<CorpusFile>> = LazyLock::new(|| sample_files("pokerstars"));
/// Every corpus file that actually contains a hand.
static PS_FULL_FILES: LazyLock<Vec<CorpusFile>> = LazyLock::new(|| {
    PS_CORPUS
        .iter()
        .filter(|file| {
            !PokerStarsParser
                .split_hands(&file.text)
                .expect("split")
                .is_empty()
        })
        .cloned()
        .collect()
});
static PS_PARSED: LazyLock<Vec<Parsed>> =
    LazyLock::new(|| parse_all(&PokerStarsParser, &PS_FULL_FILES));

fn ps_hands() -> Vec<&'static PhfHand> {
    PS_PARSED.iter().filter_map(Parsed::hand).collect()
}

fn ps_file(prefix: &str) -> &'static CorpusFile {
    PS_CORPUS
        .iter()
        .find(|file| file.name.starts_with(prefix))
        .unwrap_or_else(|| panic!("fixture {prefix} is missing"))
}

/// `parseFile(name)`: every chunk, each of which must convert.
fn ps_parse_file(prefix: &str) -> Vec<PhfHand> {
    PokerStarsParser
        .split_hands(&ps_file(prefix).text)
        .expect("split")
        .iter()
        .map(|chunk| parse(&PokerStarsParser, chunk).expect("converts"))
        .collect()
}

/// `skipFor(name)`: the refusal of the file's first chunk.
fn ps_skip_for(prefix: &str) -> ParseSkip {
    let file = ps_file(prefix);
    let chunks = PokerStarsParser.split_hands(&file.text).expect("split");
    let chunk = chunks.first().cloned().unwrap_or_else(|| file.text.clone());
    skip_of(parse(&PokerStarsParser, &chunk))
}

fn ps_skip_for_text(text: &str) -> ParseSkip {
    skip_of(parse(&PokerStarsParser, text))
}

/* ------------------------------------------------- PokerStars detection */

#[test]
fn pokerstars_every_full_file_is_attributed_to_pokerstars() {
    for file in PS_FULL_FILES.iter() {
        let (id, permille) = top(&file.text).expect("detected");
        assert_eq!(id, "pokerstars", "{}", file.relative_path);
        assert!(permille >= 900, "{}", file.relative_path);
    }
}

#[test]
fn pokerstars_does_not_claim_a_single_file_from_a_foreign_site() {
    for site in FOREIGN_SITES {
        let claimed: Vec<String> = sample_files(site)
            .into_iter()
            .filter(|file| PokerStarsParser.detect(&file.text) > 0)
            .map(|file| file.relative_path)
            .collect();
        assert!(claimed.is_empty(), "{site}: {claimed:?}");
    }
}

#[test]
fn pokerstars_does_not_claim_the_gg_reference_corpus() {
    let files = gg_corpus_files();
    assert!(
        files
            .iter()
            .all(|file| PokerStarsParser.detect(&file.text) == 0)
    );
}

#[test]
fn pokerstars_does_not_claim_our_own_standard_output() {
    assert_eq!(PokerStarsParser.detect(&gg_corpus_files()[0].text), 0);
}

#[test]
fn pokerstars_never_throws_whatever_it_is_handed() {
    for text in ["", "hello", " ", "PokerStars", "Poker Hand #1:"] {
        let _ = PokerStarsParser.detect(text);
    }
}

/* ---------------------------------------------------- PokerStars corpus */

#[test]
fn pokerstars_has_hands_to_work_with() {
    assert!(ps_hands().len() > 80);
}

#[test]
fn pokerstars_either_converts_a_hand_or_refuses_it_with_a_machine_readable_reason() {
    let reason = rail_core::js::regex::js_regex(r"^[a-z][a-z-]+$", "");
    for entry in PS_PARSED.iter() {
        assert!(
            entry.hand().is_some() || entry.skip().is_some(),
            "{} crashed",
            entry.file
        );
        if let Some(skip) = entry.skip() {
            assert!(reason.is_match(skip.reason.as_str()));
            assert!(rail_core::js::utf16_len(&skip.message) > 10);
        }
    }
}

#[test]
fn pokerstars_emits_no_hand_the_validator_rejects() {
    let problems: Vec<String> = ps_hands()
        .into_iter()
        .filter(|hand| !validates(hand))
        .map(|hand| format!("{}: {:?}", hand.meta.hand_id, error_codes(hand)))
        .collect();
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn pokerstars_understands_every_line_it_is_given() {
    let problems: Vec<String> = ps_hands()
        .into_iter()
        .flat_map(|hand| {
            hand.meta
                .warnings
                .iter()
                .filter(|w| w.code.starts_with("unknown"))
                .map(|w| format!("{} line {:?}: {}", hand.meta.hand_id, w.line, w.message))
        })
        .collect();
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn pokerstars_every_hand_holds_every_invariant() {
    for hand in ps_hands() {
        assert_eq!(
            all_invariants(hand),
            Vec::<String>::new(),
            "{}",
            hand.meta.hand_id
        );
    }
}

#[test]
fn pokerstars_stamps_provenance_on_every_hand() {
    for hand in ps_hands() {
        assert_eq!(hand.meta.site_id, "pokerstars");
        assert_eq!(hand.meta.parser_id, "pokerstars");
        assert_eq!(hand.meta.parser_version, PokerStarsParser.version());
        assert_eq!(hand.meta.hand_key, format!("PS{}", hand.meta.hand_id));
        assert!(!hand.meta.raw_text.is_empty());
    }
}

#[test]
fn pokerstars_reads_the_button_seat_off_every_hand() {
    assert!(
        ps_hands()
            .iter()
            .all(|hand| hand.table.button_seat.is_some())
    );
}

#[test]
fn pokerstars_leaves_positions_to_the_core_resolver() {
    assert!(
        ps_hands()
            .iter()
            .all(|hand| hand.players.iter().all(|p| p.position.is_none()))
    );
}

#[test]
fn pokerstars_comes_out_of_the_pipeline_with_positions_resolved() {
    let file = ps_file("27-");
    let result = convert(&file.text, Some(&file.name));
    assert!(!result.hands.is_empty());
    for converted in &result.hands {
        let hand = &converted.hand;
        let dealt_in: Vec<_> = hand
            .players
            .iter()
            .filter(|p| hand.actions.iter().any(|a| a.seat == Some(p.seat)))
            .collect();
        assert!(dealt_in.len() > 1);
        assert!(dealt_in.iter().all(|p| p.position.is_some()));
        let count = |position| {
            dealt_in
                .iter()
                .filter(|p| p.position == Some(position))
                .count()
        };
        assert_eq!(count(Position::Sb), 1);
        assert_eq!(count(Position::Bb), 1);
    }
}

/* -------------------------------------------------- PokerStars refusals */

#[test]
fn pokerstars_converts_every_high_only_omaha_hand_with_four_hole_cards_each() {
    let omaha = rail_core::js::regex::js_regex("omaha|plo", "");
    let excluded = rail_core::js::regex::js_regex("hilo|cancelled", "");
    let entries: Vec<&Parsed> = PS_PARSED
        .iter()
        .filter(|e| omaha.is_match(&e.file) && !excluded.is_match(&e.file))
        .collect();
    assert!(entries.len() > 2);
    for entry in entries {
        let hand = entry
            .hand()
            .unwrap_or_else(|| panic!("{} refused", entry.file));
        assert_eq!(hand.game.variant, Variant::Omaha, "{}", entry.file);
        assert_eq!(hand.game.limit, LimitType::Pl, "{}", entry.file);
        assert!(!hand.game.hi_lo, "{}", entry.file);
        assert!(hand.meta.warnings.is_empty(), "{}", entry.file);
        for player in &hand.players {
            assert!(
                player.hole_cards.is_empty() || player.hole_cards.len() == 4,
                "{} {}",
                entry.file,
                player.name
            );
        }
    }
}

#[test]
fn pokerstars_reads_omaha_hi_lo_with_every_awards_half_and_refuses_stud_hi_lo_as_hi_lo() {
    let entries: Vec<&Parsed> = PS_PARSED
        .iter()
        .filter(|e| e.file.contains("hilo"))
        .collect();
    assert!(entries.len() > 3);
    let mut seen: BTreeMap<String, Vec<(String, i64, Option<PotHalf>)>> = BTreeMap::new();
    for entry in entries {
        if entry.file.contains("7stud") {
            let skip = entry.skip().expect("refused");
            assert_eq!(skip.reason, SkipReason::UnsupportedHiLo, "{}", entry.file);
            assert!(skip.message.contains("high-low split"), "{}", entry.file);
            continue;
        }
        let hand = entry
            .hand()
            .unwrap_or_else(|| panic!("{} refused", entry.file));
        assert_eq!((hand.game.variant, hand.game.hi_lo), (Variant::Omaha, true));
        assert!(hand.meta.warnings.is_empty(), "{}", entry.file);
        seen.insert(entry.file[..3].to_owned(), halves(hand));
    }
    let w = |player: &str, amount: i64, half: Option<PotHalf>| (player.to_owned(), amount, half);
    let (hi, lo) = (Some(PotHalf::Hi), Some(PotHalf::Lo));
    let expected: BTreeMap<String, Vec<_>> = [
        ("14-", vec![w("wo_ooly :D", 250, None)]),
        (
            "15-",
            vec![
                w("Bluf_To_Much", 210_000, hi),
                w("LewisFriend", 210_000, lo),
                w("Crazy Elior", 263_750, hi),
                w("LewisFriend", 263_750, lo),
            ],
        ),
        ("17-", vec![w("HELVER4728", 1706, hi)]),
        ("21-", vec![w("boysDcrye", 167, hi)]),
        (
            "26-",
            vec![
                w("Mindster", 955, hi),
                w("Aphily8", 478, lo),
                w("Mindster", 477, lo),
            ],
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(seen, expected);
}

#[test]
fn pokerstars_refuses_stud_razz_badugi_and_draw_for_the_variant() {
    for (fixture, label) in [("43-", "Badugi"), ("45-", "Razz"), ("46-", "Badugi")] {
        let skip = ps_skip_for(fixture);
        assert_eq!(skip.reason, SkipReason::UnsupportedVariant, "{fixture}");
        assert!(skip.message.contains(label), "{fixture}");
    }
    let stud = ps_skip_for("44-");
    assert_eq!(stud.reason, SkipReason::UnsupportedHiLo);
    assert!(stud.message.contains("7 Card Stud Hi/Lo"));
}

#[test]
fn pokerstars_never_emits_a_hand_outside_the_allowlist() {
    let variants: BTreeSet<&str> = ps_hands().iter().map(|h| h.game.variant.as_str()).collect();
    assert_eq!(
        variants.into_iter().collect::<Vec<_>>(),
        ["holdem", "omaha"]
    );
    let hi_lo: BTreeSet<&str> = ps_hands()
        .iter()
        .filter(|h| h.game.hi_lo)
        .map(|h| h.game.variant.as_str())
        .collect();
    assert_eq!(hi_lo.into_iter().collect::<Vec<_>>(), ["omaha"]);
}

#[test]
fn pokerstars_refuses_a_cancelled_hand() {
    let skip = ps_skip_for("12-");
    assert!(matches!(
        skip.reason,
        SkipReason::HandCancelled | SkipReason::UnsupportedVariant
    ));
}

#[test]
fn pokerstars_refuses_a_hand_whose_actors_are_not_in_its_own_seat_block() {
    let skip = ps_skip_for_text(&lines(&[
        "PokerStars Hand #500000000001:  Hold'em No Limit ($0.08/$0.16 USD) - 2012/04/06 4:02:16 ET",
        "Table 'Berenike' 6-max Seat #1 is the button",
        "Seat 1: neverJa(1)ger ($22.07 in chips) ",
        "Seat 2: s1N91 ($16.56 in chips) ",
        "s1N91: posts small blind $0.08",
        "neverJager: posts big blind $0.16",
        "*** HOLE CARDS ***",
        "s1N91: folds ",
        "Uncalled bet ($0.08) returned to neverJager",
        "neverJager collected $0.16 from pot",
        "*** SUMMARY ***",
        "Total pot $0.16 | Rake $0 ",
        "Seat 1: neverJager (button) (big blind) collected ($0.16)",
        "Seat 2: s1N91 (small blind) folded before Flop",
    ]));
    assert_eq!(skip.reason, SkipReason::UnseatedActor);
    assert!(skip.message.contains("neverJager"));
}

#[test]
fn pokerstars_still_converts_the_seat_name_torture_cases_that_are_internally_consistent() {
    assert!(names(&ps_parse_file("04-")[0]).contains(&"/\\ntiHer[]"));
    assert!(names(&ps_parse_file("05-")[0]).contains(&"wo_olly :D"));
}

#[test]
fn pokerstars_refuses_a_currency_phf_has_no_unit_for() {
    let skip = ps_skip_for_text(&lines(&[
        "PokerStars Hand #400000000001:  Hold'em No Limit (¥100/¥200 CNY) - 2019/01/01 10:00:00 ET",
        "Table 'Yen' 6-max Seat #1 is the button",
        "Seat 1: Alpha (¥20000 in chips)",
    ]));
    assert_eq!(skip.reason, SkipReason::UnsupportedCurrency);
}

#[test]
fn pokerstars_keeps_the_stated_currency_code_apart_from_the_shared_dollar_symbol() {
    let hand = parse(
        &PokerStarsParser,
        &lines(&[
            "PokerStars Hand #400000000002:  Hold'em No Limit ($0.25/$0.50 CAD) - 2019/01/01 10:00:00 ET",
            "Table 'Loonie' 6-max Seat #1 is the button",
            "Seat 1: Alpha ($50 in chips)",
            "Seat 2: Beta ($50 in chips)",
            "Alpha: posts small blind $0.25",
            "Beta: posts big blind $0.50",
            "*** HOLE CARDS ***",
            "Alpha: folds ",
            "Uncalled bet ($0.25) returned to Beta",
            "Beta collected $0.50 from pot",
            "*** SUMMARY ***",
            "Total pot $0.50 | Rake $0 ",
            "Seat 1: Alpha (button) (small blind) folded before Flop",
            "Seat 2: Beta (big blind) collected ($0.50)",
        ]),
    )
    .expect("converts");
    assert_eq!(hand.game.unit, cash_unit("CAD", "$"));
    assert!(validates(&hand));
}

#[test]
fn pokerstars_skips_tournaments_in_cash_only_mode() {
    let tournament = lines(&[
        "PokerStars Hand #200000000001: Tournament #3000000001, $10+$1 USD Hold'em No Limit - Level V (75/150) - 2019/05/05 12:00:00 ET",
        "Table '3000000001 5' 9-max Seat #1 is the button",
        "Seat 1: Alpha (1500 in chips)",
        "Seat 2: Beta (1500 in chips)",
        "Alpha: posts small blind 75",
        "Beta: posts big blind 150",
        "*** HOLE CARDS ***",
        "Alpha: folds",
        "Uncalled bet (75) returned to Beta",
        "Beta collected 150 from pot",
        "*** SUMMARY ***",
        "Total pot 150 | Rake 0",
        "Seat 1: Alpha (button) (small blind) folded before Flop",
        "Seat 2: Beta (big blind) collected (150)",
    ]);
    let options = ConvertOptions {
        cash_only: true,
        ..ConvertOptions::default()
    };
    let skip = skip_of(parse_with(&PokerStarsParser, &tournament, &options));
    assert!(skip.message.contains("cash-only"));
    assert!(parse(&PokerStarsParser, &tournament).is_ok());
}

/* ------------------------------------- PokerStars line-shape regressions */

#[test]
fn pokerstars_splits_a_file_whose_only_line_separator_is_a_bare_carriage_return() {
    let hands = ps_parse_file("11-");
    let hand = &hands[0];
    assert_eq!(hand.meta.hand_id, "78782145143");
    assert_eq!(hand.game.unit.code, "GBP");
    assert_eq!(hand.results.total_pot, 50);
}

#[test]
fn pokerstars_reads_a_player_name_that_contains_a_colon_and_a_space() {
    let hand = &ps_parse_file("05-")[0];
    assert!(names(hand).contains(&"wo_olly :D"));
    assert!(hand.actions.iter().any(|a| a.player == "wo_olly :D"));
}

#[test]
fn pokerstars_reads_a_player_name_made_of_slashes_and_brackets() {
    assert!(names(&ps_parse_file("04-")[0]).contains(&"/\\ntiHer[]"));
}

#[test]
fn pokerstars_keeps_the_cap_clause_out_of_the_all_in_flag() {
    let hand = &ps_parse_file("08-")[0];
    let raise = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Raise && a.player == "DarkEvilus")
        .expect("the raise");
    assert_eq!(raise.street_total, 4000);
    assert!(!raise.all_in);
}

#[test]
fn pokerstars_rebuilds_an_uncalled_return_the_export_dropped() {
    let hand = &ps_parse_file("07-")[0];
    let uncalled = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Uncalled)
        .expect("rebuilt");
    assert_eq!(uncalled.player, "Mohamedali13");
    assert_eq!(uncalled.amount, -250);
    assert!(warning_codes(hand).contains(&"uncalled-return-reconstructed"));
    assert!(validates(hand));
}

#[test]
fn pokerstars_derives_the_rake_when_the_client_died_before_the_summary() {
    let hand = &ps_parse_file("13-")[0];
    assert!(warning_codes(hand).contains(&"rake-inferred"));
    assert_eq!(hand.results.total_pot, 102);
    assert_eq!(hand.results.fees.rake, 5);
    assert!(validates(hand));
}

#[test]
fn pokerstars_reads_a_side_pot_and_pays_both_pots_out() {
    let hand = &ps_parse_file("09-")[0];
    assert_eq!(
        hand.results.pots,
        [
            PhfPot {
                name: "Main".to_owned(),
                amount: 3037
            },
            PhfPot {
                name: "Side".to_owned(),
                amount: 791
            }
        ]
    );
    let mut amounts: Vec<i64> = hand.results.winners.iter().map(|w| w.amount).collect();
    amounts.sort_unstable();
    assert_eq!(amounts, [791, 3037]);
}

#[test]
fn pokerstars_keeps_a_single_revealed_card_without_inventing_the_other_one() {
    let hand = &ps_parse_file("20-")[0];
    let zaza = hand
        .players
        .iter()
        .find(|p| p.name == "Zaza5573")
        .expect("Zaza5573");
    assert_eq!(zaza.hole_cards, ["Qc"]);
    assert_eq!(hand.game.limit, LimitType::Fl);
}

#[test]
fn pokerstars_treats_a_play_money_home_game_as_chips() {
    let hands = ps_parse_file("33-");
    assert_eq!(hands.len(), 2);
    assert_eq!(hands[0].game.unit.minor_units, 1);
    assert_eq!(hands[0].game.big_blind, 100);
    assert!(warning_codes(&hands[0]).contains(&"home-game"));
    let blinds = hands[1]
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::BigBlind)
        .count();
    assert_eq!(blinds, 2);
}

#[test]
fn pokerstars_reads_the_zoom_header_and_its_utc_timestamp() {
    let hand = &ps_parse_file("31-")[0];
    assert_eq!(hand.meta.hand_id, "171598493667");
    assert_eq!(hand.played_at.as_deref(), Some("2017-06-10T17:17:14.000Z"));
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.is_hero)
            .map(|p| p.name.as_str()),
        Some("yakka34")
    );
}

#[test]
fn pokerstars_survives_blank_lines_between_every_source_line() {
    let hand = &ps_parse_file("10-")[0];
    assert_eq!(hand.game.unit.code, "EUR");
    assert_eq!(hand.results.total_pot, 1350);
}

#[test]
fn pokerstars_splits_a_multi_hand_file_with_and_without_blank_separators() {
    assert_eq!(ps_parse_file("27-").len(), 10);
    assert!(ps_parse_file("28-").len() > 50);
}

#[test]
fn pokerstars_keeps_antes_out_of_the_street_commitment() {
    let hand = &ps_parse_file("01-")[0];
    assert_eq!(hand.game.ante_model, AnteModel::PostedPerPlayer);
    assert_eq!(hand.game.ante, 2);
    let first = |kind| {
        hand.actions
            .iter()
            .find(|a| a.kind == kind)
            .expect("action")
    };
    assert_eq!(first(ActionType::Ante).street_total, 0);
    assert_eq!(first(ActionType::BigBlind).street_total, 10);
}

/* --------------------------- PokerStars shapes not covered by the corpus */

const RUN_IT_TWICE: &[&str] = &[
    "PokerStars Hand #124689908715:  Hold'em No Limit ($10/$20 USD) - 2014/11/08 0:40:18 WET [2014/11/07 19:40:18 ET]",
    "Table 'Pomona III' 6-max Seat #1 is the button",
    "Seat 1: ridziarz ($1000 in chips) ",
    "Seat 2: nFruit ($1000 in chips) ",
    "ridziarz: posts small blind $10",
    "nFruit: posts big blind $20",
    "*** HOLE CARDS ***",
    "ridziarz: raises $980 to $1000 and is all-in",
    "nFruit: calls $980 and is all-in",
    "*** FIRST FLOP *** [2d 7d 6c]",
    "*** FIRST TURN *** [2d 7d 6c] [Tc]",
    "*** FIRST RIVER *** [2d 7d 6c Tc] [5h]",
    "*** SECOND FLOP *** [Jc 4c Td]",
    "*** SECOND TURN *** [Jc 4c Td] [Th]",
    "*** SECOND RIVER *** [Jc 4c Td Th] [6d]",
    "*** FIRST SHOW DOWN ***",
    "ridziarz: shows [Ah 5c] (two pair, Sixes and Fives)",
    "nFruit: shows [Qc Qh] (a pair of Queens)",
    "nFruit collected $995 from pot",
    "*** SECOND SHOW DOWN ***",
    "ridziarz: shows [Ah 5c] (a pair of Tens)",
    "nFruit: shows [Qc Qh] (two pair, Queens and Tens)",
    "nFruit collected $995 from pot",
    "*** SUMMARY ***",
    "Total pot $2000 | Rake $10 ",
    "Hand was run twice",
    "FIRST Board [2d 7d 6c Tc 5h]",
    "SECOND Board [Jc 4c Td Th 6d]",
    "Seat 1: ridziarz (button) (small blind) showed [Ah 5c] and lost with two pair, Sixes and Fives, and lost with a pair of Tens",
    "Seat 2: nFruit (big blind) showed [Qc Qh] and won ($995) with a pair of Queens, and won ($995) with two pair, Queens and Tens",
];

#[test]
fn pokerstars_reads_a_run_it_twice_hand_as_two_runouts_and_two_showdowns() {
    let hand = parse(&PokerStarsParser, &lines(RUN_IT_TWICE)).expect("converts");
    assert!(validates(&hand));
    assert_eq!(hand.board.runouts.len(), 2);
    assert_eq!(
        hand.board.runouts[1].flop.as_deref(),
        Some(&["Jc".to_owned(), "4c".to_owned(), "Td".to_owned()][..])
    );
    assert_eq!(hand.meta.text_style.showdown_labels, ["FIRST", "SECOND"]);
    assert!(hand.meta.text_style.run_it_twice_note);
    let runouts: Vec<u32> = hand
        .results
        .winners
        .iter()
        .map(|w| w.runout_index)
        .collect();
    assert_eq!(runouts, [0, 1]);
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn pokerstars_splits_a_small_and_big_blind_post_into_its_live_and_dead_halves() {
    let hand = parse(
        &PokerStarsParser,
        &lines(&[
            "PokerStars Hand #199999999999:  Hold'em No Limit ($0.25/$0.50 USD) - 2015/01/01 10:00:00 ET",
            "Table 'Nix' 6-max Seat #1 is the button",
            "Seat 1: Alpha ($50 in chips) ",
            "Seat 2: Beta ($50 in chips) ",
            "Seat 3: Gamma ($50 in chips) ",
            "Beta: posts small blind $0.25",
            "Gamma: posts big blind $0.50",
            "Alpha: posts small & big blinds $0.75",
            "*** HOLE CARDS ***",
            "Alpha: checks ",
            "Beta: folds ",
            "Gamma: checks ",
            "*** FLOP *** [2d 7d 6c]",
            "Gamma: checks ",
            "Alpha: checks ",
            "*** TURN *** [2d 7d 6c] [Tc]",
            "Gamma: checks ",
            "Alpha: bets $1",
            "Gamma: folds ",
            "Uncalled bet ($1) returned to Alpha",
            "Alpha collected $1.45 from pot",
            "*** SUMMARY ***",
            "Total pot $1.50 | Rake $0.05 ",
            "Board [2d 7d 6c Tc]",
            "Seat 1: Alpha (button) collected ($1.45)",
            "Seat 2: Beta (small blind) folded before Flop",
            "Seat 3: Gamma (big blind) folded on the Turn",
        ]),
    )
    .expect("converts");
    assert!(validates(&hand));
    let alpha: Vec<&PhfAction> = hand
        .actions
        .iter()
        .filter(|a| a.player == "Alpha")
        .collect();
    assert_eq!(
        (alpha[0].kind, alpha[0].amount, alpha[0].street_total),
        (ActionType::BigBlind, 50, 50)
    );
    assert_eq!(
        (alpha[1].kind, alpha[1].amount, alpha[1].street_total),
        (ActionType::MissedBlind, 25, 0)
    );
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn pokerstars_reads_numbered_side_pots_which_sit_after_the_word_pot() {
    let hand = parse(
        &PokerStarsParser,
        &lines(&[
            "PokerStars Hand #300000000001:  Hold'em No Limit ($1/$2 USD) - 2015/01/01 10:00:00 ET",
            "Table 'Multi' 6-max Seat #1 is the button",
            "Seat 1: Alpha ($200 in chips) is sitting out ",
            "Seat 2: Beta ($20 in chips) ",
            "Seat 3: Gamma ($50 in chips) ",
            "Seat 4: Delta ($100 in chips) ",
            "Beta: posts small blind $1",
            "Gamma: posts big blind $2",
            "*** HOLE CARDS ***",
            "Delta: raises $98 to $100 and is all-in",
            "Alpha: folds ",
            "Beta: calls $19 and is all-in",
            "Gamma: calls $48 and is all-in",
            "*** FLOP *** [2c 7d Ts]",
            "*** TURN *** [2c 7d Ts] [Jh]",
            "*** RIVER *** [2c 7d Ts Jh] [3s]",
            "*** SHOW DOWN ***",
            "Delta: shows [Ah Kd] (high card Ace)",
            "Gamma: shows [Qh Qs] (a pair of Queens)",
            "Beta: shows [9c 9h] (a pair of Nines)",
            "Gamma collected $60 from side pot-1",
            "Delta collected $2 from side pot-2",
            "Gamma collected $60 from main pot",
            "*** SUMMARY ***",
            "Total pot $170 Main pot $60. Side pot-1 $60. Side pot-2 $2. | Rake $48 ",
            "Board [2c 7d Ts Jh 3s]",
            "Seat 1: Alpha (button) folded before Flop (didn't bet)",
            "Seat 2: Beta (small blind) showed [9c 9h] and lost with a pair of Nines",
            "Seat 3: Gamma (big blind) showed [Qh Qs] and won ($120) with a pair of Queens",
            "Seat 4: Delta showed [Ah Kd] and won ($2) with high card Ace",
        ]),
    )
    .expect("converts");
    assert!(validates(&hand));
    let pots: Vec<(&str, i64)> = hand
        .results
        .pots
        .iter()
        .map(|p| (p.name.as_str(), p.amount))
        .collect();
    assert_eq!(pots, [("Main", 6000), ("Side-1", 6000), ("Side-2", 200)]);
    assert!(
        hand.players
            .iter()
            .any(|p| p.name == "Alpha" && p.sitting_out)
    );
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn pokerstars_refuses_the_holdem_spin_offs_that_do_not_deal_like_holdem() {
    for label in [
        "Fusion No Limit",
        "Split Hold'em No Limit",
        "Unfold Hold'em No Limit",
    ] {
        let skip = ps_skip_for_text(&lines(&[
            &format!("PokerStars Hand #1: {label} ($0.01/$0.02 USD) - 2019/01/01 10:00:00 ET"),
            "Table 'X' 6-max Seat #1 is the button",
            "Seat 1: Alpha ($2 in chips)",
        ]));
        assert_eq!(skip.reason, SkipReason::UnsupportedVariant, "{label}");
    }
}

#[test]
fn pokerstars_refuses_6_plus_holdem_which_is_a_short_deck() {
    let skip = ps_skip_for_text(&lines(&[
        "PokerStars Hand #2: 6+ Hold'em No Limit ($0.05 ante/$0.10) - 2019/01/01 10:00:00 ET",
        "Table 'X' 6-max Seat #1 is the button",
        "Seat 1: Alpha ($2 in chips)",
    ]));
    assert_eq!(skip.reason, SkipReason::UnsupportedVariant);
}

/* ------------------------------------------------- PokerStars tournaments */

#[test]
fn pokerstars_has_the_real_tournament_corpus_and_puts_stacks_in_chips() {
    let tournaments: Vec<&PhfHand> = PS_PARSED
        .iter()
        .filter(|e| e.file.starts_with('3') || e.file.starts_with('4'))
        .filter_map(Parsed::hand)
        .filter(|h| h.tournament.is_some())
        .collect();
    assert!(tournaments.len() >= 8);
    let digits = rail_core::js::regex::js_regex(r"^\d+$", "");
    for hand in tournaments {
        let tournament = hand.tournament.as_ref().expect("tournament");
        assert_eq!(hand.game.format, GameFormat::Tournament);
        assert_eq!(hand.game.unit.minor_units, 1);
        assert!(digits.is_match(&tournament.id));
        assert!(tournament.level_number.is_some());
        assert!(hand.game.big_blind > 0);
    }
}

#[test]
fn pokerstars_reads_a_play_money_buy_in_as_chips_not_as_dollars() {
    let hand = &ps_parse_file("37-")[0];
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert_eq!(
        (tournament.id.as_str(), tournament.buy_in, tournament.fee),
        ("518183000", 2000, 110)
    );
    assert_eq!(tournament.buy_in_unit.minor_units, 1);
    assert_eq!(tournament.buy_in_unit.kind, CurrencyKind::Chips);
    let blind = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::BigBlind)
        .expect("big blind");
    assert!(blind.all_in);
    assert_eq!(all_invariants(hand), Vec::<String>::new());
}

#[test]
fn pokerstars_keeps_a_knockout_buy_ins_three_components_apart() {
    let hand = &ps_parse_file("42-")[0];
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert_eq!(
        (tournament.buy_in, tournament.bounty, tournament.fee),
        (100, Some(25), 15)
    );
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.name == "Hero")
            .and_then(|p| p.bounty),
        Some(25)
    );
    assert!(!hand.actions.iter().any(|a| a.raw_line.contains("bounty")));
    assert_eq!(hand.game.ante_model, AnteModel::PostedPerPlayer);
    assert_eq!(all_invariants(hand), Vec::<String>::new());
}

#[test]
fn pokerstars_reads_the_match_round_clause_a_heads_up_sng_inserts_before_the_level() {
    let hand = &ps_parse_file("35-")[0];
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert_eq!(tournament.id, "257640000");
    assert_eq!(tournament.level_label.as_deref(), Some("IV"));
    assert_eq!(tournament.level_number, Some(4));
    assert_eq!(
        (tournament.level_small_blind, tournament.level_big_blind),
        (50, 100)
    );
    assert_eq!(all_invariants(hand), Vec::<String>::new());
}

#[test]
fn pokerstars_reads_a_gbp_buy_in_and_fee() {
    let hand = &ps_parse_file("40-")[0];
    let tournament = hand.tournament.as_ref().expect("tournament");
    assert_eq!((tournament.buy_in, tournament.fee), (500, 50));
    assert_eq!(tournament.buy_in_unit.code, "GBP");
    assert!(!hand.actions.iter().any(|a| a.raw_line.contains("re-buys")));
    assert_eq!(all_invariants(hand), Vec::<String>::new());
}

#[test]
fn pokerstars_reads_the_mixed_game_and_mixed_betting_header_labels() {
    let mixed = &ps_parse_file("39-")[0];
    assert_eq!(mixed.game.label, "Mixed Hold'em (Hold'em Limit)");
    assert_eq!(mixed.game.variant, Variant::Holdem);
    assert_eq!(mixed.game.limit, LimitType::Fl);
    let capped = &ps_parse_file("36-")[0];
    assert_eq!(capped.game.limit, LimitType::Pl);
    assert!(warning_codes(capped).contains(&"mixed-betting-structure"));
}

#[test]
fn pokerstars_reads_a_fold_that_exposes_a_hole_card() {
    let hand = &ps_parse_file("41-")[0];
    let fold = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Fold && a.player == "Player6")
        .expect("the fold");
    assert_eq!(fold.cards.as_deref(), Some(&["Ks".to_owned()][..]));
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.name == "Player6")
            .map(|p| p.hole_cards.clone()),
        Some(vec!["Ks".to_owned()])
    );
    let seat = hand
        .results
        .players
        .iter()
        .find(|s| s.player == "Player6")
        .expect("seat");
    assert_eq!(seat.shown_cards, ["Ks"]);
    assert!(!seat.went_to_showdown);
    assert!(!hand.results.went_to_showdown);
    assert!(warning_codes(hand).contains(&"reveal-not-serializable"));
    assert_eq!(all_invariants(hand), Vec::<String>::new());
}

#[test]
fn pokerstars_tolerates_a_file_a_third_party_tracker_rewrote() {
    let hands = ps_parse_file("48-");
    assert_eq!(hands.len(), 2);
    for hand in &hands {
        assert_eq!(all_invariants(hand), Vec::<String>::new());
    }
}

/* --------------------------------------- PokerStars through the pipeline */

#[test]
fn pokerstars_converts_a_whole_file_through_convert_any_and_attributes_it_correctly() {
    let file = ps_file("27-");
    let result = convert(&file.text, Some(&file.name));
    assert_eq!(by_site(&result), [("pokerstars".to_owned(), 10)]);
    assert!(result.failures.is_empty());
}

#[test]
fn pokerstars_records_a_refused_hand_as_a_failure_rather_than_dropping_it() {
    let file = ps_file("45-");
    let result = convert(&file.text, Some(&file.name));
    assert!(result.hands.is_empty());
    let failure = &result.failures[0];
    assert_eq!(failure.detected_site.as_deref(), Some("pokerstars"));
    assert_eq!(failure.reason.as_str(), "unsupported-variant");
    assert_eq!(failure.stage.as_str(), "parse");
}

#[test]
fn pokerstars_is_registered_and_does_not_shadow_ggpoker() {
    assert_eq!(
        builtin().get("pokerstars").map(SiteParser::name),
        Some("PokerStars")
    );
    for file in gg_corpus_files() {
        assert!(PokerStarsParser.detect(&file.text) < GgPokerParser.detect(&file.text));
    }
}

/* ===================================================== ggpokerParser.test */

/// Files 33-35 are fpdb-3 unit-test fixtures, not captured exports.
fn unverified(name: &str) -> bool {
    ["33-", "34-", "35-"].iter().any(|p| name.starts_with(p))
}

static GG_ALL_FILES: LazyLock<Vec<CorpusFile>> = LazyLock::new(|| {
    [
        gg_corpus_files(),
        sample_files("ggpoker"),
        own_fixtures("ggpoker"),
    ]
    .concat()
});
static GG_FILES: LazyLock<Vec<CorpusFile>> = LazyLock::new(|| {
    GG_ALL_FILES
        .iter()
        .filter(|f| !unverified(&f.name))
        .cloned()
        .collect()
});
static GG_PARSED: LazyLock<Vec<Parsed>> = LazyLock::new(|| parse_all(&GgPokerParser, &GG_FILES));

fn gg_hands() -> Vec<&'static PhfHand> {
    GG_PARSED.iter().filter_map(Parsed::hand).collect()
}

fn gg_hand_by_id(id: &str) -> &'static PhfHand {
    gg_hands()
        .into_iter()
        .find(|h| h.meta.hand_id == id)
        .unwrap_or_else(|| panic!("hand {id} is not in the corpus"))
}

/* ---------------------------------------------------- GGPoker detection */

#[test]
fn ggpoker_every_file_is_recognised_as_gg() {
    for file in GG_FILES.iter() {
        assert!(
            GgPokerParser.detect(&file.text) >= 860,
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn ggpoker_never_crashes_on_the_unverified_fpdb3_unit_test_fixtures() {
    for file in GG_ALL_FILES.iter().filter(|f| unverified(&f.name)) {
        let _ = GgPokerParser.detect(&file.text);
        for chunk in GgPokerParser.split_hands(&file.text).expect("split") {
            if let Err(ParseError::Bug(message)) = parse(&GgPokerParser, &chunk) {
                panic!("{}: {message}", file.name);
            }
        }
    }
}

#[test]
fn ggpoker_yields_the_plain_cash_dialect_to_the_standard_parser() {
    for file in gg_corpus_files() {
        assert_eq!(GgPokerParser.detect(&file.text), 860, "{}", file.name);
        assert_eq!(top(&file.text).map(|t| t.0), Some("standard"));
    }
}

#[test]
fn ggpoker_outranks_the_standard_parser_on_gg_products_it_cannot_read() {
    let rush = lines(&[
        "Poker Hand #RC2600000001: Hold'em No Limit ($0.05/$0.1) - 2026/03/01 10:00:00",
        "Table 'Rush & Cash 40' 6-max Seat #1 is the button",
    ]);
    assert_eq!(GgPokerParser.detect(&rush), 950);
    assert_eq!(top(&rush).map(|t| t.0), Some("ggpoker"));
}

#[test]
fn ggpoker_does_not_claim_a_single_file_from_a_foreign_site() {
    for site in FOREIGN_SITES {
        let claimed: Vec<String> = sample_files(site)
            .into_iter()
            .filter(|file| GgPokerParser.detect(&file.text) > 0)
            .map(|file| file.relative_path)
            .collect();
        assert!(claimed.is_empty(), "{site}: {claimed:?}");
    }
}

#[test]
fn ggpoker_does_not_claim_pokerstars_even_when_the_file_looks_gg_shaped() {
    for file in sample_files("pokerstars") {
        assert_eq!(GgPokerParser.detect(&file.text), 0, "{}", file.name);
    }
}

#[test]
fn ggpoker_never_throws_whatever_it_is_handed() {
    for text in ["", "hello", " ", "Poker Hand #", "GG"] {
        let _ = GgPokerParser.detect(text);
    }
}

/* ------------------------------------------------------- GGPoker corpus */

#[test]
fn ggpoker_has_the_whole_reference_corpus_to_work_with() {
    assert!(gg_hands().len() >= 431);
}

#[test]
fn ggpoker_converts_every_hand_or_refuses_it_with_a_machine_readable_reason() {
    let crashed: Vec<&str> = GG_PARSED
        .iter()
        .filter(|e| e.hand().is_none() && e.skip().is_none())
        .map(|e| e.file.as_str())
        .collect();
    assert!(crashed.is_empty(), "{crashed:?}");
}

#[test]
fn ggpoker_emits_no_hand_the_validator_rejects() {
    let problems: Vec<String> = gg_hands()
        .into_iter()
        .filter(|hand| !validates(hand))
        .map(|hand| format!("{}: {:?}", hand.meta.hand_id, error_codes(hand)))
        .collect();
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn ggpoker_understands_every_line_it_is_given() {
    let problems: Vec<String> = gg_hands()
        .into_iter()
        .flat_map(|hand| {
            hand.meta
                .warnings
                .iter()
                .filter(|w| w.code.starts_with("unknown"))
                .map(|w| format!("{} line {:?}: {}", hand.meta.hand_id, w.line, w.message))
        })
        .collect();
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn ggpoker_holds_every_invariant_on_every_hand() {
    let problems: Vec<String> = gg_hands().into_iter().flat_map(all_invariants).collect();
    assert!(
        problems.is_empty(),
        "{:?}",
        &problems[..problems.len().min(10)]
    );
}

#[test]
fn ggpoker_re_serializes_every_hand_byte_for_byte() {
    // One accepted difference: the all-in insurance lines, which are
    // warnings rather than actions.
    let insurance_line = rail_core::js::regex::js_regex(
        r": (?:get an all-in insurance|pay premium of all-in insurance)\b",
        "",
    );
    let mut problems = Vec::new();
    for entry in GG_PARSED.iter() {
        let Some(hand) = entry.hand() else {
            continue;
        };
        let raw = rail_core::js::trim(&entry.raw);
        let expected: Vec<&str> = raw
            .split('\n')
            .filter(|l| !insurance_line.is_match(l))
            .collect();
        if rail_core::js::trim(&to_standard_text(hand)) != expected.join("\n") {
            problems.push(hand.meta.hand_id.clone());
        }
        let lines = raw
            .split('\n')
            .filter(|l| l.contains("all-in insurance"))
            .count();
        let warnings = hand
            .meta
            .warnings
            .iter()
            .filter(|w| w.code == "all-in-insurance")
            .count();
        if lines != warnings {
            problems.push(format!("{}: insurance line dropped", hand.meta.hand_id));
        }
    }
    assert!(
        problems.is_empty(),
        "{:?}",
        &problems[..problems.len().min(5)]
    );
}

#[test]
fn ggpoker_keeps_the_flop_in_the_order_gg_dealt_it() {
    let hand = gg_hand_by_id("TM316262814");
    let run = &hand.board.runouts[0];
    assert_eq!(run.flop.clone().unwrap_or_default(), ["Ad", "7d", "9d"]);
    assert_eq!(
        run.summary_cards.clone().unwrap_or_default(),
        ["7d", "9d", "Ad", "2s", "4h"]
    );
    assert_eq!(all_invariants(hand), Vec::<String>::new());
}

/// The parity R0.6 noted: on the same bytes, `ggpoker` and
/// `parseStandardHand` agree on every cash hand (actions, players, pot, fees
/// and board; `project` of the TypeScript test).
#[test]
fn ggpoker_agrees_with_the_standard_parser_on_every_cash_hand() {
    let project = |hand: &PhfHand| {
        (
            hand.actions
                .iter()
                .map(|a| {
                    (
                        a.street,
                        a.kind,
                        a.amount,
                        a.street_total,
                        a.player.clone(),
                        a.runout_index,
                    )
                })
                .collect::<Vec<_>>(),
            hand.players
                .iter()
                .map(|p| {
                    (
                        p.seat,
                        p.name.clone(),
                        p.starting_stack,
                        p.hole_cards.clone(),
                    )
                })
                .collect::<Vec<_>>(),
            hand.results.total_pot,
            hand.results.fees,
            hand.board.clone(),
        )
    };
    let mut compared = 0;
    let mut problems = Vec::new();
    for entry in GG_PARSED.iter() {
        let Some(hand) = entry.hand().filter(|h| h.tournament.is_none()) else {
            continue;
        };
        compared += 1;
        match parse_standard_hand(&entry.raw, &STANDARD) {
            Ok(Some(standard)) if project(&standard) == project(hand) => {}
            _ => problems.push(hand.meta.hand_id.clone()),
        }
    }
    assert!(
        problems.is_empty(),
        "{:?}",
        &problems[..problems.len().min(5)]
    );
    assert!(compared > 400, "{compared}");
}

#[test]
fn ggpoker_reads_every_gg_tournament_header_including_the_hardest() {
    let label = rail_core::js::regex::js_regex(r"^(?:Hold'em|Omaha|PLO)", "");
    let digits = rail_core::js::regex::js_regex(r"^\d+$", "");
    let tournaments: Vec<&PhfHand> = gg_hands()
        .into_iter()
        .filter(|h| h.tournament.is_some())
        .collect();
    assert!(tournaments.len() > 50);
    for hand in tournaments {
        assert!(label.is_match(&hand.game.label), "{}", hand.meta.hand_id);
        assert!(digits.is_match(&hand.tournament.as_ref().expect("t").id));
    }
    let wsop = gg_hand_by_id("TM316262814");
    assert_eq!(wsop.game.label, "Hold'em No Limit");
    assert_eq!(
        wsop.tournament.as_ref().and_then(|t| t.name.as_deref()),
        Some("WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD")
    );
    let raw = &GG_PARSED
        .iter()
        .find(|e| e.hand().is_some_and(|h| h.meta.hand_id == "TM316262814"))
        .expect("raw")
        .raw;
    let standard = parse_standard_hand(raw, &STANDARD)
        .expect("read")
        .expect("a hand");
    assert_eq!(standard.game.label, wsop.game.label);
}

const PLO6: &[&str] = &[
    "Poker Hand #OM2600000012: PLO-6 ($0.25/$0.5) - 2026/03/01 10:00:00",
    "Table 'PLO6Blue1' 6-max Seat #1 is the button",
    "Seat 1: aaaaaaaa ($50 in chips)",
    "Seat 2: Hero ($50 in chips)",
    "aaaaaaaa: posts small blind $0.25",
    "Hero: posts big blind $0.5",
    "*** HOLE CARDS ***",
    "Dealt to aaaaaaaa ",
    "Dealt to Hero [Ah Kh Qd Jd Tc 9c]",
    "aaaaaaaa: folds",
    "Uncalled bet ($0.25) returned to Hero",
    "*** SHOWDOWN ***",
    "Hero collected $0.5 from pot",
    "*** SUMMARY ***",
    "Total pot $0.5 | Rake $0",
    "Seat 1: aaaaaaaa (button) (small blind) folded before Flop",
    "Seat 2: Hero (big blind) collected ($0.5)",
];

#[test]
fn ggpoker_still_has_to_win_detection_on_gg_hands_for_the_variant_policy() {
    let refused: Vec<_> = GG_PARSED
        .iter()
        .filter(|e| e.hand().is_none())
        .map(|e| e.skip().map(|s| s.reason))
        .collect();
    assert!(refused.is_empty(), "{refused:?}");
    assert!(GG_PARSED.len() > 400);

    let plo6 = lines(PLO6);
    let standard = parse_standard_hand(&plo6, &STANDARD)
        .expect("read")
        .expect("a hand");
    assert_eq!(standard.game.variant, Variant::Omaha6);
    assert!(validates(&standard));
    assert_eq!(top(&plo6).map(|t| t.0), Some("ggpoker"));
    assert!(matches!(
        parse(&GgPokerParser, &plo6),
        Err(ParseError::Skip(_))
    ));
}

#[test]
fn ggpoker_stamps_provenance_and_keeps_the_hand_key_equal_to_the_gg_id() {
    for hand in gg_hands() {
        assert_eq!(hand.meta.site_id, "ggpoker");
        assert_eq!(hand.meta.parser_version, GgPokerParser.version());
        assert_eq!(hand.meta.hand_key, hand.meta.hand_id);
    }
}

/* ---------------------------------------------------- GGPoker specifics */

#[test]
fn ggpoker_names_the_observer_hero_and_leaves_every_villain_anonymous() {
    let hand = gg_hand_by_id("HD2735913251");
    let heroes: Vec<&str> = hand
        .players
        .iter()
        .filter(|p| p.is_hero)
        .map(|p| p.name.as_str())
        .collect();
    assert_eq!(heroes, ["Hero"]);
    let hex = rail_core::js::regex::js_regex(r"^[0-9a-f]{8}$", "");
    for player in hand.players.iter().filter(|p| !p.is_hero) {
        assert!(hex.is_match(&player.name));
    }
}

#[test]
fn ggpoker_keeps_a_villains_empty_deal_line_apart_from_their_hole_cards() {
    let hand = gg_hand_by_id("HD2735913251");
    let villain = hand
        .players
        .iter()
        .find(|p| p.name == "d971c0c0")
        .expect("villain");
    assert!(villain.dealt_announced);
    assert!(villain.dealt_cards.is_empty());
    assert_eq!(villain.hole_cards, ["3d", "2h"]);
    assert!(hand.meta.text_style.dealt_lines_for_all_players);
}

#[test]
fn ggpoker_reads_a_run_it_twice_hand_as_two_runouts_that_share_the_flop() {
    let hand = gg_hand_by_id("HD2735913251");
    let runs = &hand.board.runouts;
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].flop.clone().unwrap_or_default(), ["3s", "6s", "2d"]);
    assert!(runs[1].flop.is_none());
    assert_eq!(runs[1].turn.as_deref(), Some("5d"));
    assert_eq!(runs[1].river.as_deref(), Some("Kh"));
    assert_eq!(
        runs[1].summary_cards.clone().unwrap_or_default(),
        ["5d", "Kh"]
    );
    assert_eq!(hand.meta.text_style.showdown_labels, ["FIRST", "SECOND"]);
    assert!(hand.meta.text_style.run_it_twice_note);
    let runouts: Vec<u32> = hand
        .results
        .winners
        .iter()
        .map(|w| w.runout_index)
        .collect();
    assert_eq!(runouts, [0, 1]);
}

#[test]
fn ggpoker_settles_an_ev_cashout_outside_the_pot() {
    let hand = gg_hand_by_id("HD2735972142");
    let find = |kind| {
        hand.actions
            .iter()
            .find(|a| a.kind == kind)
            .expect("action")
    };
    let (choose, pay) = (
        find(ActionType::CashoutChoose),
        find(ActionType::CashoutPay),
    );
    assert_eq!((choose.amount, pay.amount), (0, 0));
    assert_eq!((choose.street, pay.street), (Street::Turn, Street::River));
    let seat = hand
        .results
        .players
        .iter()
        .find(|s| s.player == "d31522d6")
        .expect("seat");
    assert_eq!(seat.cashout_risk, Some(1900));
    assert_eq!(hand.results.total_pot, 8899);
    assert!(validates(hand));
}

#[test]
fn ggpoker_breaks_the_fee_line_out_into_every_column_gg_reports() {
    let hand = gg_hand_by_id("HD2735972142");
    assert_eq!(
        hand.results.fees,
        PhfFees {
            rake: 400,
            jackpot: 50,
            ..PhfFees::ZERO
        }
    );
    let collected: i64 = hand.results.winners.iter().map(|w| w.amount).sum();
    assert_eq!(collected + 450, hand.results.total_pot);
}

#[test]
fn ggpoker_uses_ggs_minimal_decimal_style() {
    assert_eq!(
        gg_hand_by_id("HD2735972142").meta.text_style.decimals,
        DecimalStyle::Minimal
    );
}

/* -------------------------- GGPoker products the reference corpus lacks */

const TOURNAMENT: &[&str] = &[
    "Poker Hand #TM299841990: Tournament #8205074, Daily Special $55 Hold'em No Limit - Level7 (150/300) - 2020/08/13 16:29:44",
    "Table '5' 9-max Seat #1 is the button",
    "Seat 1: aaaaaaaa (12000 in chips)",
    "Seat 2: bbbbbbbb (9500 in chips)",
    "Seat 3: Hero (30100 in chips)",
    "aaaaaaaa: posts the ante 40",
    "bbbbbbbb: posts the ante 40",
    "Hero: posts the ante 40",
    "bbbbbbbb: posts small blind 150",
    "Hero: posts big blind 300",
    "*** HOLE CARDS ***",
    "Dealt to aaaaaaaa ",
    "Dealt to bbbbbbbb ",
    "Dealt to Hero [Ah Kd]",
    "aaaaaaaa: folds",
    "bbbbbbbb: folds",
    "Uncalled bet (150) returned to Hero",
    "*** SHOWDOWN ***",
    "Hero: doesn't show hand",
    "Hero collected 420 from pot",
    "*** SUMMARY ***",
    "Total pot 420 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0",
    "Seat 1: aaaaaaaa (button) folded before Flop (didn't bet)",
    "Seat 2: bbbbbbbb (small blind) folded before Flop",
    "Seat 3: Hero (big blind) collected (420)",
];

#[test]
fn ggpoker_reads_ggs_own_tournament_header_which_numbers_the_level() {
    let text = lines(TOURNAMENT);
    let hand = parse(&GgPokerParser, &text).expect("converts");
    assert!(validates(&hand));
    assert_eq!(hand.game.format, GameFormat::Tournament);
    assert_eq!(hand.game.unit.minor_units, 1);
    let t = hand.tournament.as_ref().expect("tournament");
    assert_eq!(t.id, "8205074");
    assert_eq!(t.name.as_deref(), Some("Daily Special $55"));
    assert_eq!(t.buy_in, 5500);
    assert_eq!(t.level_label.as_deref(), Some("7"));
    assert_eq!(t.level_number, Some(7));
    assert_eq!((t.level_small_blind, t.level_big_blind), (150, 300));
    assert_eq!(t.buy_in_unit.code, "USD");
    assert_eq!(hand.game.ante_model, AnteModel::PostedPerPlayer);
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
    assert_eq!(GgPokerParser.detect(&text), 950);
    assert_eq!(top(&text).map(|t| t.0), Some("ggpoker"));
}

#[test]
fn ggpoker_reads_the_level_with_no_space_after_the_word() {
    let squashed = lines(TOURNAMENT).replace("- Level7 (150/300) -", "- Level7(150/300) -");
    let hand = parse(&GgPokerParser, &squashed).expect("converts");
    assert_eq!(
        hand.tournament.as_ref().and_then(|t| t.level_number),
        Some(7)
    );
    assert!(validates(&hand));
}

#[test]
fn ggpoker_reads_a_freeroll_buy_in_as_zero_rather_than_as_junk() {
    let freeroll = lines(TOURNAMENT).replace(
        "Daily Special $55 Hold'em No Limit",
        "Freeroll Hold'em No Limit",
    );
    let hand = parse(&GgPokerParser, &freeroll).expect("converts");
    assert_eq!(hand.tournament.as_ref().map(|t| t.buy_in), Some(0));
    assert_eq!(hand.game.label, "Hold'em No Limit");
    assert!(validates(&hand));
}

#[test]
fn ggpoker_reads_a_rush_and_cash_hand_and_claims_it_over_the_generic_reader() {
    let text = lines(&[
        "Poker Hand #RC2600000001: Hold'em No Limit ($0.05/$0.1) - 2026/03/01 10:00:00",
        "Table 'Rush & Cash 40' 6-max Seat #1 is the button",
        "Seat 1: aaaaaaaa ($10 in chips)",
        "Seat 2: bbbbbbbb ($9.5 in chips)",
        "Seat 3: Hero ($12.34 in chips)",
        "bbbbbbbb: posts small blind $0.05",
        "Hero: posts big blind $0.1",
        "*** HOLE CARDS ***",
        "Dealt to aaaaaaaa ",
        "Dealt to bbbbbbbb ",
        "Dealt to Hero [Ah Kd]",
        "aaaaaaaa: folds",
        "bbbbbbbb: folds",
        "Uncalled bet ($0.05) returned to Hero",
        "*** SHOWDOWN ***",
        "Hero: doesn't show hand",
        "Hero collected $0.1 from pot",
        "*** SUMMARY ***",
        "Total pot $0.1 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0",
        "Seat 1: aaaaaaaa (button) folded before Flop (didn't bet)",
        "Seat 2: bbbbbbbb (small blind) folded before Flop",
        "Seat 3: Hero (big blind) collected ($0.1)",
    ]);
    let hand = parse(&GgPokerParser, &text).expect("converts");
    assert!(validates(&hand));
    assert_eq!(hand.game.format, GameFormat::Cash);
    assert_eq!(hand.table.name.as_deref(), Some("Rush & Cash 40"));
    assert_eq!(top(&text).map(|t| t.0), Some("ggpoker"));
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn ggpoker_reads_a_named_straddle_without_treating_it_as_a_raise() {
    let hand = parse(
        &GgPokerParser,
        &lines(&[
            "Poker Hand #HD2600000002: Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
            "Table 'NLHPurple1' 6-max Seat #1 is the button",
            "Seat 1: aaaaaaaa ($50 in chips)",
            "Seat 2: bbbbbbbb ($50 in chips)",
            "Seat 3: Hero ($50 in chips)",
            "bbbbbbbb: posts small blind $0.25",
            "Hero: posts big blind $0.5",
            "aaaaaaaa: posts straddle $1",
            "*** HOLE CARDS ***",
            "Dealt to aaaaaaaa ",
            "Dealt to bbbbbbbb ",
            "Dealt to Hero [Ah Kd]",
            "bbbbbbbb: folds",
            "Hero: folds",
            "Uncalled bet ($0.5) returned to aaaaaaaa",
            "*** SHOWDOWN ***",
            "aaaaaaaa: doesn't show hand",
            "aaaaaaaa collected $1.25 from pot",
            "*** SUMMARY ***",
            "Total pot $1.25 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0",
            "Seat 1: aaaaaaaa (button) collected ($1.25)",
            "Seat 2: bbbbbbbb (small blind) folded before Flop",
            "Seat 3: Hero (big blind) folded before Flop",
        ]),
    )
    .expect("converts");
    assert!(validates(&hand));
    let straddles: Vec<_> = hand
        .game
        .straddles
        .iter()
        .map(|s| (s.seat, s.player.as_str(), s.amount, s.order))
        .collect();
    assert_eq!(straddles, [(1, "aaaaaaaa", 100, 1)]);
    let straddle = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Straddle)
        .expect("straddle");
    assert_eq!(straddle.street_total, 100);
    assert_eq!(straddle.verb.as_deref(), Some("posts straddle"));
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

/* --------------------- GGPoker shapes the reference corpus does not have */

const CASH_DROP_HAND: &[&str] = &[
    "Poker Hand #RC58843004: Hold'em No Limit ($0.01/$0.02) - 2021/04/12 07:43:21",
    "Table 'RushAndCash328990' 6-max Seat #1 is the button",
    "Seat 1: 9d7f4cb8 ($3.26 in chips)",
    "Seat 2: 8d962552 ($2 in chips)",
    "Cash Drop to Pot : total $0.2",
    "8d962552: posts small blind $0.01",
    "9d7f4cb8: posts big blind $0.02",
    "*** HOLE CARDS ***",
    "Dealt to 9d7f4cb8 ",
    "Dealt to 8d962552 ",
    "8d962552: folds",
    "Uncalled bet ($0.01) returned to 9d7f4cb8",
    "9d7f4cb8 collected $0.22 from pot",
    "*** SUMMARY ***",
    "Total pot $0.22 | Rake $0",
    "Seat 1: 9d7f4cb8 (big blind) collected ($0.22)",
    "Seat 2: 8d962552 (small blind) folded before Flop",
];

fn gg_first_hand_of(prefix: &str) -> String {
    let file = sample_files("ggpoker")
        .into_iter()
        .find(|f| f.name.starts_with(prefix))
        .unwrap_or_else(|| panic!("fixture {prefix} is missing"));
    GgPokerParser
        .split_hands(&file.text)
        .expect("split")
        .remove(0)
}

#[test]
fn ggpoker_splits_the_tournament_name_from_the_game_label_by_the_label() {
    let wsop = parse(&GgPokerParser, &gg_first_hand_of("30-")).expect("converts");
    assert_eq!(wsop.game.label, "Hold'em No Limit");
    let t = wsop.tournament.as_ref().expect("tournament");
    assert_eq!(t.id, "9364957");
    assert_eq!(
        t.name.as_deref(),
        Some("WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD")
    );
    assert_eq!(t.buy_in, 500_000);
    assert_eq!(t.level_label.as_deref(), Some("10"));
    assert_eq!((t.level_small_blind, t.level_big_blind), (1000, 2000));

    let masters = parse(&GgPokerParser, &gg_first_hand_of("27-")).expect("converts");
    assert_eq!(masters.game.label, "Hold'em No Limit");
    let t = masters.tournament.as_ref().expect("tournament");
    assert_eq!(
        t.name.as_deref(),
        Some("H-04: $1,050 GGMasters High Rollers")
    );
    assert_eq!(t.buy_in, 105_000);
    assert_eq!(t.level_label.as_deref(), Some("14"));
}

#[test]
fn ggpoker_reads_comma_grouped_chip_counts() {
    let hand = parse(&GgPokerParser, &gg_first_hand_of("27-")).expect("converts");
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.name == "e15d8ef6")
            .map(|p| p.starting_stack),
        Some(21929)
    );
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn ggpoker_survives_a_fee_line_with_no_rake_column_at_all() {
    let hand = parse(&GgPokerParser, &gg_first_hand_of("28-")).expect("converts");
    assert!(hand.results.total_pot > 0);
    assert_eq!(hand.results.fees, PhfFees::ZERO);
    assert!(validates(&hand));
}

#[test]
fn ggpoker_recognises_a_gg_export_whose_hand_id_carries_no_product_prefix() {
    let file = sample_files("ggpoker")
        .into_iter()
        .find(|f| f.name.starts_with("12-"))
        .expect("fixture 12");
    assert_eq!(GgPokerParser.detect(&file.text), 950);
    let hand = parse(&GgPokerParser, &gg_first_hand_of("12-")).expect("converts");
    assert_eq!(hand.game.variant, Variant::Shortdeck);
    assert!(hand.meta.warnings.is_empty());
}

#[test]
fn ggpoker_accounts_for_a_house_funded_cash_drop_instead_of_refusing_the_hand() {
    let text = lines(CASH_DROP_HAND);
    let hand = parse(&GgPokerParser, &text).expect("converts");
    assert!(validates(&hand));
    let movements = hand.chip_movements.clone().expect("movements");
    assert_eq!(
        serde_json::to_value(&movements).expect("json"),
        serde_json::json!([{
            "kind": "cash-drop",
            "fromSeat": null,
            "fromPlayer": null,
            "toPot": true,
            "amount": 20,
            "raw": "Cash Drop to Pot : total $0.2",
            "anchor": "before-postings",
        }])
    );
    assert_eq!(hand.results.total_pot, 22);
    assert_eq!(hand.results.winners[0].amount, 22);
    assert!(
        !hand
            .actions
            .iter()
            .any(|a| a.raw_line.contains("Cash Drop"))
    );
    assert!(hand.meta.warnings.is_empty());
    assert_eq!(
        rail_core::js::trim(&to_standard_text(&hand)),
        rail_core::js::trim(&text)
    );
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn ggpoker_records_rush_and_cash_as_a_fast_fold_pool() {
    let hand = parse(&GgPokerParser, &lines(CASH_DROP_HAND)).expect("converts");
    assert!(hand.meta.hand_id.starts_with("RC"));
    assert_eq!(hand.table.fast_fold, Some(Some("Rush & Cash".to_owned())));
    let ordinary: Vec<&PhfHand> = gg_hands()
        .into_iter()
        .filter(|h| h.meta.hand_id.starts_with("HD"))
        .collect();
    assert!(ordinary.len() > 400);
    assert!(
        ordinary
            .iter()
            .all(|h| h.table.fast_fold.clone().flatten().is_none())
    );
}

#[test]
fn ggpoker_reads_ggs_bare_straddle_verb_which_has_no_posts() {
    let hand = parse(
        &GgPokerParser,
        &lines(&[
            "Poker Hand #RC2600000011: Hold'em No Limit ($0.01/$0.02) - 2021/03/01 10:00:00",
            "Table 'RushAndCash1' 6-max Seat #1 is the button",
            "Seat 1: 27925b27 ($2 in chips)",
            "Seat 2: 8d962552 ($2 in chips)",
            "Seat 3: Hero ($2 in chips)",
            "8d962552: posts small blind $0.01",
            "Hero: posts big blind $0.02",
            "27925b27: straddle $0.04",
            "*** HOLE CARDS ***",
            "Dealt to 27925b27 ",
            "Dealt to 8d962552 ",
            "Dealt to Hero [Ac Kh]",
            "8d962552: folds",
            "Hero: folds",
            "Uncalled bet ($0.02) returned to 27925b27",
            "*** SHOWDOWN ***",
            "27925b27: doesn't show hand",
            "27925b27 collected $0.05 from pot",
            "*** SUMMARY ***",
            "Total pot $0.05 | Rake $0",
            "Seat 1: 27925b27 (button) collected ($0.05)",
            "Seat 2: 8d962552 (small blind) folded before Flop",
            "Seat 3: Hero (big blind) folded before Flop",
        ]),
    )
    .expect("converts");
    assert!(validates(&hand));
    let straddles: Vec<_> = hand
        .game
        .straddles
        .iter()
        .map(|s| (s.seat, s.player.as_str(), s.amount, s.order))
        .collect();
    assert_eq!(straddles, [(1, "27925b27", 4, 1)]);
    let straddle = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Straddle)
        .expect("straddle");
    assert_eq!((straddle.amount, straddle.street_total), (4, 4));
    assert_eq!(straddle.verb.as_deref(), Some("straddle"));
    assert!(hand.meta.warnings.is_empty());
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

#[test]
fn ggpoker_records_all_in_insurance_without_pretending_it_is_an_ev_cashout() {
    let hand = parse(
        &GgPokerParser,
        &lines(&[
            "Poker Hand #HD2600000010: Hold'em No Limit ($0.5/$1) - 2020/04/14 07:58:23",
            "Table 'NLHBronze12' 6-max Seat #2 is the button",
            "Seat 1: 23aca38f ($17 in chips)",
            "Seat 2: Hero ($90 in chips)",
            "23aca38f: posts small blind $0.5",
            "Hero: posts big blind $1",
            "*** HOLE CARDS ***",
            "Dealt to 23aca38f ",
            "Dealt to Hero [Ac Kh]",
            "23aca38f: raises $16 to $17 and is all-in",
            "Hero: calls $16",
            "23aca38f: shows [6s Jd]",
            "Hero: shows [Ac Kh]",
            "23aca38f: get an all-in insurance (premium ($0/$4/$0) for ($0/$10.8/$0) - (Mandatory/Main/Sub))",
            "*** FLOP *** [6c Kd Qc]",
            "23aca38f: pay premium of all-in insurance ($4)",
            "*** TURN *** [6c Kd Qc] [3s]",
            "*** RIVER *** [6c Kd Qc 3s] [6h]",
            "*** SHOWDOWN ***",
            "23aca38f collected $34 from pot",
            "*** SUMMARY ***",
            "Total pot $34",
            "Board [6c Kd Qc 3s 6h]",
            "Seat 1: 23aca38f (small blind) showed [6s Jd] and won ($34) with two pair",
            "Seat 2: Hero (button) (big blind) showed [Ac Kh] and lost with a pair of Kings",
        ]),
    )
    .expect("converts");
    assert!(validates(&hand));
    assert!(
        !hand
            .actions
            .iter()
            .any(|a| a.kind.as_str().starts_with("cashout"))
    );
    assert!(
        hand.results
            .players
            .iter()
            .all(|s| s.cashout_risk.is_none())
    );
    let insurance: Vec<&str> = hand
        .meta
        .warnings
        .iter()
        .filter(|w| w.code == "all-in-insurance")
        .map(|w| w.message.as_str())
        .collect();
    assert_eq!(insurance.len(), 2);
    assert!(insurance[0].contains("get an all-in insurance"));
    assert!(insurance[1].contains("pay premium of all-in insurance"));
    assert_eq!(hand.results.total_pot, 3400);
    assert_eq!(all_invariants(&hand), Vec::<String>::new());
}

/* ----------------------------------------------------- GGPoker refusals */

#[test]
fn ggpoker_refuses_six_card_omaha_which_is_on_no_list_until_a_fixture_exists() {
    let skip = skip_of(parse(
        &GgPokerParser,
        &lines(&[
            "Poker Hand #OM2600000009: PLO-6 ($0.25/$0.5) - 2026/03/01 10:00:00",
            "Table 'PLO6Blue1' 6-max Seat #1 is the button",
            "Seat 1: aaaaaaaa ($50 in chips)",
            "Seat 2: bbbbbbbb ($50 in chips)",
        ]),
    ));
    assert_eq!(skip.reason, SkipReason::UnsupportedVariant);
    assert!(skip.message.contains("six-card Omaha"));
}

#[test]
fn ggpoker_refuses_a_hi_lo_hand_on_its_own_terms() {
    let skip = skip_of(parse(
        &GgPokerParser,
        &lines(&[
            "Poker Hand #OM2600000010: Omaha Hi/Lo Pot Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
            "Table 'PLO8Blue1' 6-max Seat #1 is the button",
            "Seat 1: aaaaaaaa ($50 in chips)",
            "Seat 2: bbbbbbbb ($50 in chips)",
        ]),
    ));
    assert_eq!(skip.reason, SkipReason::UnsupportedHiLo);
}

#[test]
fn ggpoker_reads_short_deck_under_its_6_plus_holdem_name_as_short_deck() {
    let short_deck = |hole: &str| {
        lines(&[
            "Poker Hand #SD2600000009: 6+ Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
            "Table 'ShortDeck1' 6-max Seat #1 is the button",
            "Seat 1: aaaaaaaa ($50 in chips)",
            "Seat 2: Hero ($50 in chips)",
            "aaaaaaaa: posts small blind $0.25",
            "Hero: posts big blind $0.5",
            "*** HOLE CARDS ***",
            "Dealt to aaaaaaaa ",
            &format!("Dealt to Hero [{hole}]"),
            "aaaaaaaa: folds",
            "Uncalled bet ($0.25) returned to Hero",
            "*** SHOWDOWN ***",
            "Hero collected $0.5 from pot",
            "*** SUMMARY ***",
            "Total pot $0.5 | Rake $0",
            "Seat 1: aaaaaaaa (button) (small blind) folded before Flop",
            "Seat 2: Hero (big blind) collected ($0.5)",
        ])
    };
    assert_eq!(GgPokerParser.detect(&short_deck("Ah Kh")), 950);
    let hand = parse(&GgPokerParser, &short_deck("Ah Kh")).expect("converts");
    assert_eq!(hand.game.variant, Variant::Shortdeck);
    assert!(validates(&hand));
    let impossible = parse(&GgPokerParser, &short_deck("Ah 5h")).expect("converts");
    assert_eq!(error_codes(&impossible), ["card-not-in-deck"]);
}

#[test]
fn ggpoker_refuses_a_hand_with_no_seat_block_rather_than_inventing_one() {
    let header_only = "Poker Hand #HD1: Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00";
    assert!(parse(&GgPokerParser, header_only).is_err());
}

/* -------------------------------------------- GGPoker through the pipeline */

#[test]
fn ggpoker_is_registered() {
    assert_eq!(
        builtin().get("ggpoker").map(SiteParser::name),
        Some("GGPoker")
    );
}

#[test]
fn ggpoker_converts_a_forced_gg_upload_end_to_end() {
    let file = &gg_corpus_files()[0];
    let options = ConvertOptions {
        source_filename: Some(file.name.clone()),
        site_id: Some("ggpoker".to_owned()),
        ..ConvertOptions::default()
    };
    let result = rail_core::convert_any(&file.text, &options).expect("convertAny");
    assert!(result.failures.is_empty());
    let count = u32::try_from(result.hands.len()).expect("count");
    assert_eq!(by_site(&result), [("ggpoker".to_owned(), count)]);
    assert!(result.hands.len() > 50);
}

#[test]
fn ggpoker_does_not_disturb_the_pokerstars_corpus() {
    let misrouted: Vec<String> = sample_files("pokerstars")
        .into_iter()
        .filter(|f| PokerStarsParser.detect(&f.text) > 0)
        .filter(|f| top(&f.text).map(|t| t.0) != Some("pokerstars"))
        .map(|f| f.relative_path)
        .collect();
    assert!(misrouted.is_empty(), "{misrouted:?}");
}

/* ===================================== phfDetect, phfOmaha, phfHiLo parts */

#[test]
fn phf_detect_every_gg_reference_file_is_detected_as_our_standard_format() {
    for file in gg_corpus_files() {
        let (id, permille) = top(&file.text).expect("detected");
        assert_eq!(id, "standard", "{}", file.name);
        assert!(permille > 500);
    }
}

/// `sample(relative)` of `phfHiLo`/`phfOmaha`: `TextDecoder("utf-8")`, which
/// drops a BOM.
fn sample(relative: &str) -> String {
    let path = psgg_support::root().join("fixtures/samples").join(relative);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {relative}: {e}"));
    let text = String::from_utf8_lossy(&bytes).into_owned();
    text.strip_prefix('\u{FEFF}')
        .map(str::to_owned)
        .unwrap_or(text)
}

/// `hand(relative)` of `phfHiLo`: the file's one hand, through `convertAny`.
fn converted_hand(relative: &str) -> PhfHand {
    let result = convert(&sample(relative), Some(relative));
    assert!(
        result.failures.is_empty(),
        "{relative}: {:?}",
        reasons(&result)
    );
    assert_eq!(result.hands.len(), 1, "{relative}");
    result.hands[0].hand.clone()
}

const PS_HI_LO: [&str; 5] = [
    "pokerstars/14-cash-omahahilo-strange-names.txt",
    "pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt",
    "pokerstars/17-cash-omahahilo-nolowqualified.txt",
    "pokerstars/21-cash-omahahilo-mucks-hand.txt",
    "pokerstars/26-cash-nolimit-omahahilo.txt",
];

#[test]
fn phf_omaha_reads_the_pokerstars_omaha_hi_lo_fixtures_and_still_refuses_stud_hi_lo() {
    for file in PS_HI_LO {
        let hand = converted_hand(file);
        assert!(hand.game.hi_lo, "{file}");
        assert!(hand.meta.warnings.is_empty(), "{file}");
    }
    let stud = "pokerstars/44-cash-7stud-hilo-brings-in-streets-excerpt.txt";
    let result = convert(&sample(stud), Some(stud));
    assert!(result.hands.is_empty());
    assert_eq!(reasons(&result), ["unsupported-hi-lo"]);
}

#[test]
fn phf_omaha_leaves_the_flag_off_every_hand_the_corpus_does_convert() {
    let result = convert(
        &sample(
            "ggpoker/01-repo-cash-rushcash-GG20260217-0405 - NLHPurple70 - 0.25 - 0.5 - 6max.txt",
        ),
        None,
    );
    assert!(result.hands.len() > 10);
    assert!(result.hands.iter().all(|h| !h.hand.game.hi_lo));
}

#[test]
fn phf_hi_lo_quarters_a_tied_low() {
    let hand = converted_hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    assert_eq!(
        halves(&hand),
        [
            ("Mindster".to_owned(), 955, Some(PotHalf::Hi)),
            ("Aphily8".to_owned(), 478, Some(PotHalf::Lo)),
            ("Mindster".to_owned(), 477, Some(PotHalf::Lo)),
        ]
    );
}

#[test]
fn phf_hi_lo_awards_the_whole_pot_high_when_no_low_qualifies() {
    let hand = converted_hand("pokerstars/17-cash-omahahilo-nolowqualified.txt");
    assert_eq!(
        halves(&hand),
        [("HELVER4728".to_owned(), 1706, Some(PotHalf::Hi))]
    );
}

#[test]
fn phf_hi_lo_splits_a_side_pot_and_the_main_pot_independently() {
    let hand = converted_hand("pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt");
    assert_eq!(
        halves(&hand),
        [
            ("Bluf_To_Much".to_owned(), 210_000, Some(PotHalf::Hi)),
            ("LewisFriend".to_owned(), 210_000, Some(PotHalf::Lo)),
            ("Crazy Elior".to_owned(), 263_750, Some(PotHalf::Hi)),
            ("LewisFriend".to_owned(), 263_750, Some(PotHalf::Lo)),
        ]
    );
}

#[test]
fn phf_hi_lo_leaves_a_pot_nobody_contested_unsplit() {
    let hand = converted_hand("pokerstars/14-cash-omahahilo-strange-names.txt");
    assert_eq!(halves(&hand), [("wo_ooly :D".to_owned(), 250, None)]);
}

#[test]
fn phf_hi_lo_every_converted_pokerstars_fixture_validates_balances_and_round_trips() {
    for file in PS_HI_LO {
        let result = convert(&sample(file), Some(file));
        assert!(result.failures.is_empty(), "{file}");
        assert!(!result.hands.is_empty(), "{file}");
        for converted in &result.hands {
            let hand = &converted.hand;
            assert!(
                hand.game.hi_lo && hand.game.variant == Variant::Omaha,
                "{file}"
            );
            assert!(hand.meta.warnings.is_empty(), "{file}");
            let report = rail_core::validate::validate_hand(hand).expect("validate");
            assert!(report.ok(), "{file}");
            assert!(
                !report.warnings().any(|w| w.code.starts_with("hi-lo")),
                "{file}"
            );
            let collects: Vec<Option<PotHalf>> = hand
                .actions
                .iter()
                .filter(|a| a.kind == ActionType::Collect)
                .map(|a| a.half)
                .collect();
            let winners: Vec<Option<PotHalf>> =
                hand.results.winners.iter().map(|w| w.half).collect();
            assert_eq!(winners, collects, "{file}");
            let text = to_standard_text(hand);
            let back = parse_standard_hand(&text, &STANDARD)
                .expect("read")
                .expect("a hand");
            assert!(back.meta.warnings.is_empty(), "{file}");
            assert!(back.game.hi_lo, "{file}");
            assert_eq!(halves(&back), halves(hand), "{file}");
            assert_eq!(to_standard_text(&back), text, "{file}");
        }
    }
}

#[test]
fn phf_hi_lo_writes_pokerstars_no_low_hand_qualified_back() {
    let text = to_standard_text(&converted_hand(
        "pokerstars/17-cash-omahahilo-nolowqualified.txt",
    ));
    assert!(text.contains("HELVER4728 collected $17.06 from pot\nNo low hand qualified\n"));
    let split = to_standard_text(&converted_hand("pokerstars/26-cash-nolimit-omahahilo.txt"));
    assert!(!split.contains("No low hand qualified"));
}

#[test]
fn phf_hi_lo_takes_our_own_hi_lo_output_back_in_through_an_upload() {
    let hand = converted_hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    let result = convert(&to_standard_text(&hand), None);
    assert!(result.failures.is_empty());
    let sites: Vec<&str> = result
        .hands
        .iter()
        .map(|h| h.hand.meta.site_id.as_str())
        .collect();
    assert_eq!(sites, ["standard"]);
    assert_eq!(halves(&result.hands[0].hand), halves(&hand));
}

#[test]
fn phf_hi_lo_warns_when_the_text_says_no_low_qualified_but_a_low_half_was_paid() {
    let split = to_standard_text(&converted_hand("pokerstars/26-cash-nolimit-omahahilo.txt"));
    let forged = split.replacen(
        "Mindster collected $4.77 from pot",
        "Mindster collected $4.77 from pot\nNo low hand qualified",
        1,
    );
    let back = parse_standard_hand(&forged, &STANDARD)
        .expect("read")
        .expect("a hand");
    assert_eq!(warning_codes(&back), ["hi-lo-half-mismatch"]);
}

#[test]
fn phf_hi_lo_rejects_a_half_on_a_hand_that_is_not_hi_lo() {
    let mut hand = converted_hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    hand.game.hi_lo = false;
    assert!(error_codes(&hand).contains(&"stray-pot-half".to_owned()));
}

#[test]
fn phf_hi_lo_flags_halves_that_cannot_both_be_half_of_the_same_pot() {
    let mut hand = converted_hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    if let Some(action) = hand
        .actions
        .iter_mut()
        .find(|a| a.player == "Aphily8" && a.kind == ActionType::Collect)
    {
        action.half = Some(PotHalf::Hi);
    }
    let report = rail_core::validate::validate_hand(&hand).expect("validate");
    assert!(report.ok());
    assert!(
        report
            .warnings()
            .any(|w| w.code == "hi-lo-halves-unbalanced")
    );
}

#[test]
fn phf_hi_lo_works_the_halves_out_again_and_the_same_way() {
    let mut hand = converted_hand("pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt");
    let before = halves(&hand);
    assert_eq!(assign_hi_lo_halves(&mut hand), Ok(Vec::new()));
    assert_eq!(halves(&hand), before);
}

/* ========================================================== shortDeck */

static SHORT_DECK_HANDS: LazyLock<Vec<PhfHand>> = LazyLock::new(|| {
    let files: Vec<CorpusFile> = psgg_support::read_tree(
        &psgg_support::root().join("fixtures/samples/ggpoker"),
        "fixtures/samples/ggpoker",
    )
    .into_iter()
    .filter(|f| f.name.to_lowercase().contains("shortdeck"))
    .collect();
    assert_eq!(files.len(), 2);
    files
        .iter()
        .flat_map(|file| {
            let result = convert(&file.text, Some(&file.name));
            assert!(
                result.failures.is_empty(),
                "{}: {:?}",
                file.name,
                reasons(&result)
            );
            result.hands.into_iter().map(|h| h.hand)
        })
        .collect()
});

fn short_deck_hand(id: &str) -> &'static PhfHand {
    SHORT_DECK_HANDS
        .iter()
        .find(|h| h.meta.hand_id == id)
        .unwrap_or_else(|| panic!("hand {id} did not convert"))
}

#[test]
fn short_deck_the_gg_fixtures_all_convert_as_clean_short_deck_hands() {
    assert_eq!(SHORT_DECK_HANDS.len(), 5);
    for hand in SHORT_DECK_HANDS.iter() {
        assert_eq!(hand.meta.site_id, "ggpoker");
        assert_eq!(hand.game.variant, Variant::Shortdeck);
        assert_eq!(hand.game.limit, LimitType::Nl);
        assert!(hand.meta.warnings.is_empty(), "{}", hand.meta.hand_id);
        assert!(validates(hand));
        assert_eq!(all_invariants(hand), Vec::<String>::new());
        for player in &hand.players {
            assert!(player.hole_cards.len() <= 2);
            assert!(
                player
                    .hole_cards
                    .iter()
                    .all(|c| card_in_deck(c, Variant::Shortdeck))
            );
        }
    }
}

#[test]
fn short_deck_every_gg_hand_comes_back_from_standard_text_as_the_same_hand() {
    // `semantics()` of shortDeck.test.ts.
    let semantics = |hand: &PhfHand| {
        (
            hand.meta.hand_id.clone(),
            hand.played_at.clone(),
            hand.game.clone(),
            hand.table.clone(),
            hand.players.clone(),
            hand.board.clone(),
            hand.results.clone(),
            hand.actions
                .iter()
                .map(|a| {
                    (
                        a.street,
                        a.runout_index,
                        a.player.clone(),
                        a.kind,
                        a.amount,
                        a.street_total,
                        a.all_in,
                        a.verb.clone(),
                        a.cards.clone(),
                        a.pot_name.clone(),
                    )
                })
                .collect::<Vec<_>>(),
        )
    };
    for hand in SHORT_DECK_HANDS.iter() {
        let text = to_standard_text(hand);
        let back = parse_standard_hand(&text, &STANDARD)
            .expect("read")
            .expect("a hand");
        assert!(back.meta.warnings.is_empty());
        assert_eq!(semantics(&back), semantics(hand), "{}", hand.meta.hand_id);
        let again = convert(&text, None);
        assert!(again.failures.is_empty());
        assert_eq!(semantics(&again.hands[0].hand), semantics(hand));
        assert_eq!(to_standard_text(&back), text);
    }
}

#[test]
fn short_deck_reads_the_button_blind_as_the_tables_one_blind() {
    let hand = short_deck_hand("SD27208838");
    assert_eq!(
        (hand.game.small_blind, hand.game.big_blind, hand.game.ante),
        (0, 2, 2)
    );
    assert_eq!(hand.game.ante_model, AnteModel::PostedPerPlayer);
    assert!(hand.game.bomb_pot.is_none());
    assert_eq!(hand.game.label, "ShortDeck No Limit");
    let blind = hand
        .actions
        .iter()
        .find(|a| is_button_blind(a))
        .expect("button blind");
    assert_eq!(
        (blind.player.as_str(), blind.kind, blind.amount),
        ("27925b27", ActionType::BigBlind, 2)
    );
    assert_eq!(blind.seat, hand.table.button_seat);
    let positions: Vec<(u32, Option<Position>)> =
        hand.players.iter().map(|p| (p.seat, p.position)).collect();
    assert_eq!(
        positions,
        [
            (1, Some(Position::Co)),
            (2, Some(Position::Btn)),
            (3, Some(Position::Utg)),
            (5, Some(Position::Hj)),
        ]
    );
}

#[test]
fn short_deck_reads_a_straddle_as_the_street_total_gg_states() {
    let button = short_deck_hand("SD27208838");
    let straddles: Vec<(i64, i64)> = button
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::Straddle)
        .map(|a| (a.amount, a.street_total))
        .collect();
    assert_eq!(straddles, [(2, 4), (4, 8)]);
    let amounts: Vec<i64> = button.game.straddles.iter().map(|s| s.amount).collect();
    assert_eq!(amounts, [4, 8]);
    let triple = short_deck_hand("SD27208832");
    let totals: Vec<i64> = triple
        .actions
        .iter()
        .filter(|a| a.kind == ActionType::Straddle)
        .map(|a| a.street_total)
        .collect();
    assert_eq!(totals, [4, 8, 16]);
    assert_eq!(triple.results.total_pot, 12);
    assert!(to_standard_text(triple).contains("27925b27: straddle $0.16"));
}

#[test]
fn short_deck_writes_the_single_stake_header_and_the_button_blind_back_verbatim() {
    let hand = short_deck_hand("SD27208848");
    let text = to_standard_text(hand);
    let header = "Poker Hand #SD27208848: ShortDeck No Limit ($0.02) - 2021/03/02 18:22:40";
    assert_eq!(text.split('\n').next(), Some(header));
    assert!(text.contains("Hero: posts button blind $0.02"));
    let mut generated = hand.clone();
    generated.meta.raw_text = String::new();
    assert_eq!(
        to_standard_text(&generated).split('\n').next(),
        Some(header)
    );
}

#[test]
fn short_deck_reads_the_run_it_twice_summary_that_names_each_board_on_its_own_line() {
    let hand = short_deck_hand("1171217378123557259");
    let boards: Vec<Vec<String>> = hand
        .board
        .runouts
        .iter()
        .map(|r| r.summary_cards.clone().unwrap_or_default())
        .collect();
    assert_eq!(
        boards,
        [
            ["Tc", "8h", "Ah", "6h", "Jd"].map(str::to_owned).to_vec(),
            ["9h", "9c", "Kc", "6s", "As"].map(str::to_owned).to_vec(),
        ]
    );
    let positions: Vec<(u32, Option<Position>)> =
        hand.players.iter().map(|p| (p.seat, p.position)).collect();
    assert_eq!(
        positions,
        [
            (1, Some(Position::Utg)),
            (4, Some(Position::Co)),
            (5, Some(Position::Btn)),
        ]
    );
}
