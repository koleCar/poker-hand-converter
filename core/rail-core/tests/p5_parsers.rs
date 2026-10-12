//! The Ignition / Bodog / Bovada and ACR / WPN suite, translated
//! (docs/RAIL-PLAN.md R0.10b): `p5Parsers.test.ts` with
//! `support/psggCorpus.ts` and `psggInvariants.ts` as the loaders (files read
//! as `readFileSync(path, "utf8")` does: the UTF-16LE WPN files arrive as
//! mojibake with NULs, which the parser repairs), plus the Ignition and ACR
//! parts of `phfHiLo` (the four Ignition files of "every converted hi/lo
//! fixture") and `shortDeck` (the ACR Six Plus file).
//!
//! Left out, and why: `phfHiLo`'s `analyzeAllIn` check (R2.2), and of
//! `shortDeck` the equity, stats (`handFacts`) and replayer (`buildReplay`)
//! checks - R2.1, R2.2 and a replayer that is not ported -, the
//! `shortDeckRuleFor("acrwpn")` table (parser-free, R0.5b) and the GG parts
//! (R0.7a). `phfOmaha`'s two labels (`OMAHA HiLo`, `Omaha HiLow`) are
//! parser-free (R0.5a); `phfDetect`, `phfPositions` and `phfCoreGaps` have no
//! Ignition or ACR part. Detection is held over the ported parsers (the
//! unported ones cannot claim anything in Rust). One Rust test per
//! TypeScript `it` (an `it.each` is one loop), named after it.

mod psgg_support;

use std::collections::BTreeMap;
use std::sync::LazyLock;

use psgg_support::{CorpusFile, STANDARD, all_invariants, read_tree, root, sample_files};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::parsers::acrwpn::{AcrWpnParser, WpnDialect, wpn_dialect};
use rail_core::parsers::builtin;
use rail_core::parsers::ignition::IgnitionParser;
use rail_core::parsers::shared::p5_encoding::p5_recover_encoding;
use rail_core::phf::serialize::{matches_at_line_start, parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, LimitType, PhfHand, PotHalf, Street, Variant, card_in_deck, variant_from_label,
};
use rail_core::validate::validate_hand;
use regex::Regex;

/* ----------------------------------------------------------------- helpers */

/// `Outcome`.
struct Outcome {
    file: String,
    chunk: String,
    hand: Option<PhfHand>,
    reason: Option<String>,
    message: String,
}

/// `run(parser, site)`: one parser over one corpus directory, chunk by chunk.
fn run(parser: &dyn SiteParser, site: &str) -> Vec<Outcome> {
    let options = ConvertOptions::default();
    let mut out = Vec::new();
    for file in sample_files(site) {
        for chunk in parser.split_hands(&file.text).expect("split") {
            let ctx = SiteParserContext {
                source_filename: Some(&file.name),
                options: &options,
            };
            let (hand, reason, message) = match parser.parse_hand(&chunk, &ctx) {
                Ok(hand) => (Some(hand), None, String::new()),
                Err(ParseError::Skip(skip)) => {
                    (None, Some(skip.reason.as_str().to_owned()), skip.message)
                }
                Err(ParseError::Bug(message)) => (None, Some("parser-error".to_owned()), message),
            };
            out.push(Outcome {
                file: file.name.clone(),
                chunk,
                hand,
                reason,
                message,
            });
        }
    }
    out
}

/// `BLIND_SPOTS`: the warnings that mean a line was not understood.
fn blind_spots(hand: &PhfHand) -> Vec<String> {
    hand.meta
        .warnings
        .iter()
        .filter(|w| w.code == "unknown-line" || w.code == "unknown-summary-line")
        .map(|w| format!("{} {}: {}", hand.meta.hand_id, w.code, w.message))
        .collect()
}

fn error_codes(hand: &PhfHand) -> Vec<String> {
    validate_hand(hand)
        .expect("validateHand threw")
        .errors()
        .map(|p| p.code.clone())
        .collect()
}

/// `detectSite(text)[0]` over the ported parsers.
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

fn halves(hand: &PhfHand) -> Vec<(String, i64, Option<PotHalf>)> {
    hand.results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount, w.half))
        .collect()
}

fn re(pattern: &str, flags: &str) -> Regex {
    rail_core::js::regex::js_regex(pattern, flags)
}

/// `OTHER_SITES`.
const OTHER_SITES: [&str; 17] = [
    "888poker",
    "bossmedia",
    "chico",
    "coinpoker",
    "entraction",
    "full-tilt",
    "ggpoker",
    "merge",
    "microgaming",
    "ongame",
    "partypoker",
    "pokerbros",
    "pokerstars",
    "run-it-once",
    "unibet",
    "weplay",
    "winamax",
];

/* ---------------------------------------------------------------- ignition */

static IGNITION_BRAND: LazyLock<Regex> = LazyLock::new(|| {
    re(
        "^\u{FEFF}?(?:Ignition|Bovada|Bodog\\.com|Bodog\\.eu|Bodog UK|Bodog Canada|Bodog88|Bodog)\\s+Hand\\s+#",
        "",
    )
});
static IGNITION_HOLDEM: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"Hand #\S+:?\s+(?:Zone Poker ID#\S+\s+|TBL#\S+\s+)?HOLDEM(?:ZonePoker)?\b",
        "",
    )
});
/// The Omaha token; the TypeScript's `(?!\s+HiLo)` is the absence of
/// [`IGNITION_OMAHA_HI_LO`] (the same answer on every corpus header).
static IGNITION_OMAHA: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"Hand #\S+:?\s+(?:Zone Poker ID#\S+\s+|TBL#\S+\s+)?OMAHA(?:ZonePoker)?\b",
        "",
    )
});
static IGNITION_OMAHA_HI_LO: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"Hand #\S+:?\s+(?:Zone Poker ID#\S+\s+|TBL#\S+\s+)?OMAHA(?:ZonePoker)?\s+HiLo\b",
        "",
    )
});

static IGNITION_OUTCOMES: LazyLock<Vec<Outcome>> =
    LazyLock::new(|| run(&IgnitionParser, "ignition"));

fn ignition_holdem() -> Vec<&'static Outcome> {
    IGNITION_OUTCOMES
        .iter()
        .filter(|o| IGNITION_HOLDEM.is_match(&o.chunk))
        .collect()
}

fn ignition_omaha() -> Vec<&'static Outcome> {
    IGNITION_OUTCOMES
        .iter()
        .filter(|o| IGNITION_OMAHA.is_match(&o.chunk) && !IGNITION_OMAHA_HI_LO.is_match(&o.chunk))
        .collect()
}

fn ignition_omaha_hi_lo() -> Vec<&'static Outcome> {
    IGNITION_OUTCOMES
        .iter()
        .filter(|o| IGNITION_OMAHA_HI_LO.is_match(&o.chunk))
        .collect()
}

#[test]
fn ignition_splits_the_corpus_into_the_hands_the_brand_header_announces() {
    let mut headers = 0;
    for file in sample_files("ignition") {
        headers += file
            .text
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line))
            .filter(|line| IGNITION_BRAND.is_match(line))
            .count();
    }
    assert_eq!(IGNITION_OUTCOMES.len(), headers);
    assert!(headers >= 100);
    assert!(ignition_holdem().len() >= 85);
}

#[test]
fn ignition_every_file_is_detected_as_ignition() {
    for file in sample_files("ignition") {
        let (id, permille) = top(&file.text).expect("detected");
        assert_eq!(id, "ignition", "{}", file.relative_path);
        assert!(permille >= 900, "{}", file.relative_path);
    }
}

#[test]
fn ignition_converts_every_holdem_hand_the_corpus_is_not_itself_broken_in() {
    let holdem = ignition_holdem();
    let mut refused: Vec<&str> = holdem
        .iter()
        .filter(|o| o.hand.is_none())
        .map(|o| o.reason.as_deref().unwrap_or("?"))
        .collect();
    refused.sort_unstable();
    // Two chunks are two hands spliced together mid-line by the export.
    assert_eq!(refused, ["corrupt-hand", "corrupt-hand"]);
    assert_eq!(holdem.len() - refused.len(), 85);
}

#[test]
fn ignition_converts_every_four_card_omaha_high_hand_in_the_corpus() {
    let omaha = ignition_omaha();
    assert_eq!(omaha.len(), 5);
    for outcome in &omaha {
        assert_eq!(
            outcome.reason, None,
            "{}: {}",
            outcome.file, outcome.message
        );
        let hand = outcome.hand.as_ref().expect("hand");
        let id = &hand.meta.hand_id;
        assert_eq!(hand.game.variant, Variant::Omaha, "{id}");
        assert_eq!(hand.game.limit, LimitType::Pl, "{id}");
        assert!(!hand.game.hi_lo, "{id}");
        // The 2012 export prints no street markers.
        for warning in &hand.meta.warnings {
            assert_eq!(warning.code, "streets-inferred", "{id}");
        }
    }
}

#[test]
fn ignition_reads_a_multiway_omaha_all_in() {
    let hand = ignition_omaha()
        .into_iter()
        .find_map(|o| o.hand.as_ref().filter(|h| h.meta.hand_id == "2605762685"))
        .expect("2605762685");
    assert!(hand.meta.warnings.is_empty());
    let cards = |name: &str| {
        hand.players
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.hole_cards.clone())
    };
    assert_eq!(cards("Hero").expect("Hero"), ["Js", "Ad", "Jd", "9h"]);
    assert_eq!(cards("Big Blind").expect("BB"), ["7s", "7d", "9d", "8c"]);
    assert_eq!(cards("UTG").expect("UTG"), ["3d", "Jc", "3c", "6c"]);
    let mut winners: Vec<(String, i64)> = hand
        .results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount))
        .collect();
    winners.sort();
    assert_eq!(
        winners,
        [("Big Blind".to_owned(), 55022), ("Hero".to_owned(), 37678)]
    );
    assert_eq!(hand.results.total_pot, 93000);
    assert_eq!(hand.results.fees.rake, 300);
    // The big blind's raise is a preflop action.
    assert!(
        !hand
            .actions
            .iter()
            .any(
                |a| matches!(a.street, Street::Flop | Street::Turn | Street::River) && a.amount > 0
            )
    );
}

#[test]
fn ignition_converts_every_four_card_omaha_hi_lo_hand_with_the_halves_the_summary_states() {
    let hi_lo = ignition_omaha_hi_lo();
    assert_eq!(hi_lo.len(), 6);
    let mut by_id = BTreeMap::new();
    for outcome in &hi_lo {
        assert_eq!(
            outcome.reason, None,
            "{}: {}",
            outcome.file, outcome.message
        );
        let hand = outcome.hand.as_ref().expect("hand");
        let id = hand.meta.hand_id.clone();
        assert_eq!(
            (hand.game.variant, hand.game.hi_lo),
            (Variant::Omaha, true),
            "{id}"
        );
        for warning in &hand.meta.warnings {
            assert_eq!(warning.code, "streets-inferred", "{id}");
        }
        by_id.insert(id, halves(hand));
    }
    let entry = |player: &str, amount: i64, half: PotHalf| (player.to_owned(), amount, Some(half));
    // Heads-up split: `Seat+1: Big Blind HI 30` and `Seat+2: Dealer ... LOW 30`.
    assert_eq!(
        by_id["3050116136"],
        [
            entry("Hero", 30, PotHalf::Hi),
            entry("Dealer", 30, PotHalf::Lo)
        ]
    );
    // A tied high quartered against one low.
    assert_eq!(
        by_id["2902234353"],
        [
            entry("UTG+1", 321, PotHalf::Hi),
            entry("UTG+2", 640, PotHalf::Lo),
            entry("UTG+3", 320, PotHalf::Hi),
        ]
    );
    // A chopped side pot and main pot with no low: every share high.
    assert_eq!(
        by_id["2641146259"],
        [
            entry("Big Blind", 2190, PotHalf::Hi),
            entry("UTG+1", 2190, PotHalf::Hi),
            entry("Big Blind", 180, PotHalf::Hi),
            entry("UTG+1", 180, PotHalf::Hi),
        ]
    );
}

#[test]
fn ignition_refuses_every_other_non_holdem_hand_on_the_reason_its_header_earns() {
    let holdem = ignition_holdem();
    let omaha = ignition_omaha();
    let hi_lo = ignition_omaha_hi_lo();
    let others: Vec<&Outcome> = IGNITION_OUTCOMES
        .iter()
        .filter(|o| {
            ![&holdem, &omaha, &hi_lo]
                .iter()
                .any(|set| set.iter().any(|known| std::ptr::eq(*known, *o)))
        })
        .collect();
    assert!(!others.is_empty());
    let hi_lo_word = re(r"\bHiLo\b", "");
    let mut reasons = BTreeMap::new();
    for outcome in others {
        assert!(outcome.hand.is_none());
        let header = outcome.chunk.split('\n').next().unwrap_or("");
        let header = header.strip_suffix('\r').unwrap_or(header);
        let expected = if hi_lo_word.is_match(header) {
            "unsupported-hi-lo"
        } else {
            "unsupported-variant"
        };
        assert_eq!(outcome.reason.as_deref(), Some(expected), "{header}");
        *reasons.entry(expected).or_insert(0) += 1;
    }
    assert_eq!(
        reasons.keys().copied().collect::<Vec<_>>(),
        ["unsupported-hi-lo", "unsupported-variant"]
    );
}

#[test]
fn ignition_every_hand_holds_every_invariant() {
    let mut checked = 0;
    for outcome in ignition_holdem()
        .into_iter()
        .chain(ignition_omaha())
        .chain(ignition_omaha_hi_lo())
    {
        let Some(hand) = &outcome.hand else {
            continue;
        };
        let at = format!("{} #{}", outcome.file, hand.meta.hand_id);
        assert_eq!(blind_spots(hand), Vec::<String>::new(), "{at}");
        assert_eq!(error_codes(hand), Vec::<String>::new(), "{at}");
        assert_eq!(all_invariants(hand), Vec::<String>::new(), "{at}");
        checked += 1;
    }
    assert_eq!(checked, 96);
}

#[test]
fn ignition_stores_the_positional_pseudonym_as_the_player_name_and_tags_the_hero() {
    let hand = ignition_holdem()
        .into_iter()
        .find_map(|o| o.hand.as_ref().filter(|h| h.meta.hand_id == "3340409736"))
        .expect("3340409736");
    let mut names: Vec<&str> = hand.players.iter().map(|p| p.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["Dealer", "Hero", "Small Blind"]);
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.is_hero)
            .map(|p| p.name.as_str()),
        Some("Hero")
    );
    // The pseudonym says `Dealer`; the button seat has to agree with it.
    assert_eq!(hand.table.button_seat, Some(6));
}

#[test]
fn ignition_never_reads_a_showdown_best_five_list_as_hole_cards() {
    for (outcomes, dealt) in [(ignition_holdem(), 2), (ignition_omaha(), 4)] {
        for outcome in outcomes {
            let Some(hand) = &outcome.hand else {
                continue;
            };
            for player in &hand.players {
                assert!(
                    [0, dealt].contains(&player.hole_cards.len()),
                    "{}",
                    hand.meta.hand_id
                );
            }
        }
    }
}

#[test]
fn ignition_records_the_mvs_per_seat_hashes_as_provenance_rather_than_identity() {
    let hash = re(r"[0-9a-f]{32}", "");
    let mvs: Vec<&PhfHand> = ignition_holdem()
        .into_iter()
        .filter_map(|o| o.hand.as_ref())
        .filter(|h| {
            h.meta
                .warnings
                .iter()
                .any(|w| w.code == "mvs-player-hashes")
        })
        .collect();
    assert_eq!(mvs.len(), 3);
    for hand in mvs {
        assert!(hand.players.iter().all(|p| !hash.is_match(&p.name)));
    }
}

/* --------------------------------------------------------------------- WPN */

static WPN_OUTCOMES: LazyLock<Vec<Outcome>> = LazyLock::new(|| run(&AcrWpnParser, "acr-wpn"));

fn wpn_by_dialect() -> BTreeMap<&'static str, Vec<&'static Outcome>> {
    let mut by = BTreeMap::new();
    for outcome in WPN_OUTCOMES.iter() {
        let dialect = wpn_dialect(&outcome.chunk).unwrap_or(WpnDialect::Legacy);
        by.entry(dialect.as_str())
            .or_insert_with(Vec::new)
            .push(outcome);
    }
    by
}

static LEGACY_START: LazyLock<Regex> = LazyLock::new(|| re(r"^Game started at:", ""));

/// `isHoldem(chunk)`.
fn is_holdem(chunk: &str) -> bool {
    if LEGACY_START.is_match(chunk) {
        return matches_at_line_start(&re(r"^Game ID:.*\(Hold'?em\)", ""), chunk);
    }
    matches_at_line_start(
        &re(
            r"^(?:Game )?Hand #\d+ - (?:.*Tournament #\S+ - )?Hold'?em\(",
            "",
        ),
        chunk,
    )
}

/// `isOmahaHigh(chunk)`; the `m`-flag `\s*$` is the end of a line here (the
/// chunks are `\n`-separated).
fn is_omaha_high(chunk: &str) -> bool {
    if LEGACY_START.is_match(chunk) {
        return chunk
            .split('\n')
            .any(|line| re(r"^Game ID:.*\(Omaha\)\s*$", "").is_match(line));
    }
    matches_at_line_start(
        &re(
            r"^(?:Game )?Hand #\d+ - (?:.*Tournament #\S+ - )?Omaha\(",
            "",
        ),
        chunk,
    )
}

/// `isSixPlus(chunk)`.
fn is_six_plus(chunk: &str) -> bool {
    chunk
        .split('\n')
        .any(|line| re(r"^Game ID:.*\(Six Plus Hold'?em\)\s*$", "").is_match(line))
}

/// `headerLineOf(chunk)`.
fn header_line_of(chunk: &str) -> String {
    let game_id = re(r"^Game ID:", "");
    let modern = re(r"^(?:Game )?Hand #\d+ - ", "");
    chunk
        .split('\n')
        .map(|line| rail_core::js::trim(line.strip_suffix('\r').unwrap_or(line)))
        .find(|line| game_id.is_match(line) || modern.is_match(line))
        .unwrap_or("")
        .to_owned()
}

#[test]
fn wpn_every_file_is_detected_as_wpn() {
    for file in sample_files("acr-wpn") {
        let (id, permille) = top(&file.text).expect("detected");
        assert_eq!(id, "acrwpn", "{}", file.relative_path);
        assert!(permille >= 900, "{}", file.relative_path);
    }
}

#[test]
fn wpn_recovers_the_utf16le_files_rather_than_parsing_mojibake() {
    let utf16: Vec<CorpusFile> = sample_files("acr-wpn")
        .into_iter()
        .filter(|file| file.text.contains('\0'))
        .collect();
    // 14 of the 76 sample files really are UTF-16LE.
    assert_eq!(utf16.len(), 14);
    let start = re(r"^(?:Game started at:|(?:Game )?Hand #)", "");
    for file in &utf16 {
        let recovered = p5_recover_encoding(&file.text);
        assert!(!recovered.contains('\0'), "{}", file.name);
        assert!(start.is_match(&recovered), "{}", file.name);
    }
    // A name that survives the recovery intact, from a UTF-16LE 2016 export.
    let hand = WPN_OUTCOMES
        .iter()
        .find_map(|o| o.hand.as_ref().filter(|h| h.meta.hand_id == "698333926"))
        .expect("698333926");
    assert!(hand.players.iter().any(|p| p.name == "Sean LeBlanc"));
}

#[test]
fn wpn_covers_all_three_dialects() {
    assert_eq!(
        wpn_by_dialect().keys().copied().collect::<Vec<_>>(),
        ["legacy", "mined", "modern"]
    );
}

#[test]
fn wpn_each_dialect_converts_every_holdem_hand_the_source_is_not_itself_broken_in() {
    let hi_lo_header = re(r"hilow|h\/l|hi\\lo", "i");
    for (dialect, list) in wpn_by_dialect() {
        let holdem: Vec<&&Outcome> = list.iter().filter(|o| is_holdem(&o.chunk)).collect();
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for outcome in holdem.iter().filter(|o| o.hand.is_none()) {
            *counts
                .entry(outcome.reason.clone().unwrap_or_else(|| "?".to_owned()))
                .or_default() += 1;
        }
        let converted = holdem.iter().filter(|o| o.hand.is_some()).count();
        // Per dialect on purpose: one aggregate would hide an era that failed.
        let expected: BTreeMap<String, usize> = if dialect == "legacy" {
            [
                ("unnamed-actor".to_owned(), 3),
                ("cancelled-hand".to_owned(), 2),
                ("payout-mismatch".to_owned(), 1),
            ]
            .into_iter()
            .collect()
        } else {
            BTreeMap::new()
        };
        assert_eq!(counts, expected, "{dialect}");
        let expected_converted = match dialect {
            "legacy" => 122,
            "modern" => 6,
            _ => 1,
        };
        assert_eq!(converted, expected_converted, "{dialect}");

        // Everything else is Omaha or Six Plus, read, or a deliberate refusal.
        for outcome in list.iter().filter(|o| !is_holdem(&o.chunk)) {
            let header = header_line_of(&outcome.chunk);
            let at = format!("{}: {}", outcome.file, outcome.message);
            if is_omaha_high(&outcome.chunk) {
                let hand = outcome.hand.as_ref().unwrap_or_else(|| panic!("{at}"));
                assert_eq!(hand.game.variant, Variant::Omaha, "{at}");
                assert_eq!(hand.game.limit, LimitType::Pl, "{at}");
                assert!(!hand.game.hi_lo, "{at}");
                assert!(hand.meta.warnings.is_empty(), "{at}");
                continue;
            }
            if is_six_plus(&outcome.chunk) {
                let hand = outcome.hand.as_ref().unwrap_or_else(|| panic!("{at}"));
                assert_eq!(hand.game.variant, Variant::Shortdeck, "{at}");
                assert_eq!(hand.game.limit, LimitType::Nl, "{at}");
                assert_eq!(hand.game.label, "6+ Hold'em No Limit", "{at}");
                assert!(hand.meta.warnings.is_empty(), "{at}");
                continue;
            }
            assert!(outcome.hand.is_none(), "{at}");
            let expected = if hi_lo_header.is_match(&header) {
                "unsupported-hi-lo"
            } else {
                "unsupported-variant"
            };
            assert_eq!(outcome.reason.as_deref(), Some(expected), "{header}");
        }
    }
}

#[test]
fn wpn_every_hand_holds_every_invariant() {
    let mut checked = 0;
    for outcome in WPN_OUTCOMES.iter() {
        let Some(hand) = &outcome.hand else {
            continue;
        };
        let at = format!(
            "{:?} {} #{}",
            wpn_dialect(&outcome.chunk),
            outcome.file,
            hand.meta.hand_id
        );
        assert_eq!(blind_spots(hand), Vec::<String>::new(), "{at}");
        assert_eq!(error_codes(hand), Vec::<String>::new(), "{at}");
        assert_eq!(all_invariants(hand), Vec::<String>::new(), "{at}");
        checked += 1;
    }
    assert!(checked > 130, "{checked}");
}

fn wpn_hand(id: &str) -> &'static PhfHand {
    WPN_OUTCOMES
        .iter()
        .find_map(|o| o.hand.as_ref().filter(|h| h.meta.hand_id == id))
        .unwrap_or_else(|| panic!("{id}"))
}

#[test]
fn wpn_reads_a_legacy_raises_n_as_chips_added_not_as_the_street_total() {
    // ButtonSmasher posts 0.10, raises (0.40) and gets 0.25 back.
    let hand = wpn_hand("266886148");
    let raise = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Raise)
        .expect("raise");
    assert_eq!(raise.player, "ButtonSmasher");
    assert_eq!(raise.street_total, 50);
    assert_eq!(hand.results.total_pot, 50);
}

#[test]
fn wpn_books_an_unprinted_jackpot_drop_as_a_fee_instead_of_losing_the_chips() {
    // `Pot: 7.73. Rake 0.41` on a (JP) table, with 8.39 actually contributed.
    let hand = wpn_hand("261641541");
    assert_eq!(hand.results.total_pot, 839);
    assert_eq!(hand.results.fees.rake, 41);
    assert_eq!(hand.results.fees.jackpot, 25);
}

#[test]
fn wpn_flags_the_data_mined_dialects_numeric_ids_as_unusable_identities() {
    let by = wpn_by_dialect();
    let mined: Vec<&PhfHand> = by["mined"].iter().filter_map(|o| o.hand.as_ref()).collect();
    assert_eq!(mined.len(), 1);
    let hand = mined[0];
    assert!(
        hand.meta
            .warnings
            .iter()
            .any(|w| w.code == "numeric-player-ids")
    );
    assert!(
        hand.players
            .iter()
            .all(|p| !p.name.is_empty() && p.name.bytes().all(|b| b.is_ascii_digit()))
    );
}

/* --------------------------------------------------------------- detection */

#[test]
fn detection_checks_every_other_sites_corpus_not_just_the_ones_that_still_exist() {
    for site in OTHER_SITES {
        assert!(!sample_files(site).is_empty(), "{site}");
    }
}

#[test]
fn detection_neither_parser_claims_a_foreign_file() {
    for site in OTHER_SITES {
        for file in sample_files(site) {
            assert_eq!(
                IgnitionParser.detect(&file.text),
                0,
                "{}",
                file.relative_path
            );
            assert_eq!(AcrWpnParser.detect(&file.text), 0, "{}", file.relative_path);
        }
    }
}

#[test]
fn detection_claims_nothing_in_the_xml_and_phh_samples() {
    for path in [
        "fixtures/samples/ipoker/01-basic-hand-pl-omaha-eur.xml",
        "fixtures/samples/phh/01-dwan-ivey-2009-nlhe-cash.phh",
    ] {
        let bytes = std::fs::read(root().join(path)).expect("read");
        let text = String::from_utf8_lossy(&bytes);
        assert_eq!(IgnitionParser.detect(&text), 0, "{path}");
        assert_eq!(AcrWpnParser.detect(&text), 0, "{path}");
    }
}

#[test]
fn detection_every_pokerstars_file_still_ranks_pokerstars_first() {
    for file in sample_files("pokerstars") {
        assert_eq!(
            top(&file.text).map(|(id, _)| id),
            Some("pokerstars"),
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn detection_keeps_the_modern_wpn_header_off_pokerstars_and_vice_versa() {
    let wpn = [
        "Hand #151588328 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC",
        "Fort Lupton 9-max Seat #1 is the button",
        "Seat 1: Somebody ($1.00)",
    ]
    .join("\n");
    let stars = [
        "PokerStars Hand #151588328:  Hold'em No Limit ($0.01/$0.02 USD) - 2019/11/08 4:43:23 ET",
        "Table 'Fort Lupton' 9-max Seat #1 is the button",
        "Seat 1: Somebody ($1.00 in chips)",
    ]
    .join("\n");
    assert_eq!(top(&wpn).map(|(id, _)| id), Some("acrwpn"));
    assert_eq!(AcrWpnParser.detect(&stars), 0);
    assert_eq!(top(&stars).map(|(id, _)| id), Some("pokerstars"));
}

#[test]
fn detection_does_not_claim_a_bare_hand_line_without_the_utc_stamp() {
    assert_eq!(
        AcrWpnParser.detect("Hand #12345 - something else entirely"),
        0
    );
}

/* ------------------------------------------------- phfHiLo: Ignition files */

/// `sample(relative)` of `phfHiLo`: `TextDecoder("utf-8")`, which drops a BOM.
fn sample(relative: &str) -> String {
    let bytes = std::fs::read(root().join("fixtures/samples").join(relative))
        .unwrap_or_else(|e| panic!("read {relative}: {e}"));
    let text = String::from_utf8_lossy(&bytes).into_owned();
    text.strip_prefix('\u{FEFF}')
        .map(str::to_owned)
        .unwrap_or(text)
}

/// `every converted hi/lo fixture` for the four Ignition files (the
/// `analyzeAllIn` check is R2.2).
#[test]
fn phf_hi_lo_every_converted_ignition_fixture_validates_balances_and_round_trips() {
    for file in [
        "ignition/fpdb3-regression-corpus/cash__PLO8-9max-USD-0.02-0.05-201408.corrupted.lines.txt",
        "ignition/fpdb3-regression-corpus/tour__PLO8-9max-USD-10-MTT-201207.txt",
        "ignition/fpdb3-regression-corpus/tour__PLO8-USD-MTT - $1-0.10 - 201409.LOW.vs.LO.txt",
        "ignition/fpdb3-regression-corpus/tour__PLO8-USD-MTT - $10-$1 - 201207.allin.call.pf.txt",
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

/* ------------------------------------------------ shortDeck: the ACR file */

/// `FILES` / `HANDS` of `shortDeck.test.ts`: every sample whose name says
/// short deck, through `convertAny`.
static SHORT_DECK: LazyLock<Vec<(CorpusFile, ConversionResult)>> = LazyLock::new(|| {
    let six_plus = re(r"shortdeck|6\+Holdem", "i");
    read_tree(&root().join("fixtures/samples"), "fixtures/samples")
        .into_iter()
        .filter(|file| six_plus.is_match(&file.name))
        .map(|file| {
            let result = convert(&file.text, Some(&file.name));
            (file, result)
        })
        .collect()
});

fn short_deck_hands() -> Vec<&'static PhfHand> {
    SHORT_DECK
        .iter()
        .flat_map(|(_, result)| result.hands.iter().map(|h| &h.hand))
        .collect()
}

#[test]
fn short_deck_the_fixtures_are_the_three_files_the_issue_names_and_all_of_them_convert() {
    let mut paths: Vec<&str> = SHORT_DECK
        .iter()
        .map(|(file, _)| file.relative_path.as_str())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        [
            "fixtures/samples/acr-wpn/fpdb3-regression-corpus/cash__6+Holdem-6-max-USD-0.02-0.05-201902.HH00000000 G0.txt",
            "fixtures/samples/ggpoker/11-fpdb3-cash-nl-shortdeck-5max-usd-0-2-202103.txt",
            "fixtures/samples/ggpoker/12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt",
        ]
    );
    for (file, result) in SHORT_DECK.iter() {
        assert!(result.failures.is_empty(), "{}", file.name);
    }
    let mut by_site: BTreeMap<&str, usize> = BTreeMap::new();
    for hand in short_deck_hands() {
        *by_site.entry(hand.meta.site_id.as_str()).or_default() += 1;
    }
    assert_eq!(
        by_site.into_iter().collect::<Vec<_>>(),
        [("acrwpn", 1), ("ggpoker", 5)]
    );
}

#[test]
fn short_deck_the_acr_hand_is_a_clean_short_deck_hand() {
    let hands: Vec<&PhfHand> = short_deck_hands()
        .into_iter()
        .filter(|h| h.meta.site_id == "acrwpn")
        .collect();
    assert_eq!(hands.len(), 1);
    for hand in hands {
        assert_eq!(hand.game.variant, Variant::Shortdeck);
        assert_eq!(hand.game.limit, LimitType::Nl);
        assert!(hand.meta.warnings.is_empty());
        assert!(validate_hand(hand).expect("validateHand threw").ok());
        assert_eq!(all_invariants(hand), Vec::<String>::new());
        for player in &hand.players {
            assert!(player.hole_cards.len() <= 2);
            assert!(
                player
                    .hole_cards
                    .iter()
                    .all(|card| card_in_deck(card, Variant::Shortdeck))
            );
        }
    }
}

#[test]
fn short_deck_the_acr_hand_comes_back_from_standard_text_as_the_same_hand() {
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
    let hand = short_deck_hands()
        .into_iter()
        .find(|h| h.meta.site_id == "acrwpn")
        .expect("the ACR hand");
    let text = to_standard_text(hand);
    let back = parse_standard_hand(&text, &STANDARD)
        .expect("read")
        .expect("a hand");
    assert!(back.meta.warnings.is_empty());
    assert_eq!(semantics(&back), semantics(hand));
    let again = convert(&text, None);
    assert!(again.failures.is_empty());
    assert_eq!(semantics(&again.hands[0].hand), semantics(hand));
    assert_eq!(to_standard_text(&back), text);
}

#[test]
fn short_deck_acr_six_plus_is_an_ordinary_blinds_hand_written_as_stars_6_plus_holdem() {
    let hand = short_deck_hands()
        .into_iter()
        .find(|h| h.meta.hand_id == "1377529121")
        .expect("1377529121");
    assert_eq!(
        (
            hand.game.small_blind,
            hand.game.big_blind,
            hand.game.label.as_str()
        ),
        (2, 5, "6+ Hold'em No Limit")
    );
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.name == "ChazDazzle")
            .expect("ChazDazzle")
            .hole_cards,
        ["6s", "6c"]
    );
    let text = to_standard_text(hand);
    let first = text.split('\n').next().expect("a line");
    assert!(
        re(r": 6\+ Hold'em No Limit \(\$0\.02\/\$0\.05\) - ", "").is_match(first),
        "{first}"
    );
    assert_eq!(variant_from_label("Six Plus Hold'em"), Variant::Shortdeck);
}
