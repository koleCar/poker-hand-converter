//! The partypoker, 888poker and PokerBros halves of the TypeScript suite,
//! translated (docs/RAIL-PLAN.md R0.8): the 888poker and partypoker parts of
//! `p2Parsers.test.ts`, the PokerBros parts of `p3Parsers.test.ts`, and the
//! parts of `phfHiLo` and `phfOmaha` that read these rooms' fixtures.
//!
//! Left out, and why: the replayer checks (`buildReplay`, not ported - the
//! "replays without a negative stack" cases and the replayer half of "pays
//! the whole pot out"), the all-in EV check of `phfHiLo` (`analyzeAllIn`,
//! R2.2), and everything about iPoker (R0.9), Full Tilt and Run It Once
//! (R0.10) in those files. `legacyNetworks.test.ts` is Ongame, Entraction
//! and MicroGaming only (R0.9/R0.10); `phfDetect` and `phfPositions` have no
//! part about these rooms. One Rust test per TypeScript `it` (an `it.each` is
//! one loop), named after it.

mod psgg_support;

use std::path::Path;
use std::sync::LazyLock;

use psgg_support::{STANDARD, all_invariants, blind_spots, parse, root};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser};
use rail_core::parsers::builtin;
use rail_core::parsers::partypoker::PartyPokerParser;
use rail_core::parsers::pokerbros::PokerBrosParser;
use rail_core::parsers::pokerstars888::Poker888Parser;
use rail_core::phf::serialize::{parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, PhfHand, Position, PotHalf, Street, Variant, contributions_from_actions,
    house_into_pot, total_fees,
};
use rail_core::validate::validate_hand;
use serde_json::{Value, json};

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

/// `sample(relative)` of `phfHiLo`/`phfOmaha`: UTF-8 with the BOM dropped.
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

fn halves(hand: &PhfHand) -> Vec<(String, i64, Option<PotHalf>)> {
    hand.results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount, w.half))
        .collect()
}

/* ===================================================== p2Parsers.test.ts */

/// `P888_DIALECT`: `/^[^\n]*\bBlinds\b[^\n]*-\s+\*\*\*\s+\d{2}\s+\d{2}\s+\d{4}/m`.
static P888_DIALECT: LazyLock<regex::Regex> = rail_core::js_regex_lazy!(
    r"^[^\n]*\bBlinds\b[^\n]*-\s+\*\*\*\s+\d{2}\s+\d{2}\s+\d{4}",
    ""
);

/// `dialectOf(file)`: the text, never the folder, decides.
fn dialect_of(file: &SampleFile) -> &'static str {
    if rail_core::phf::serialize::matches_at_line_start(&P888_DIALECT, &file.text) {
        "888poker"
    } else {
        "partypoker"
    }
}

/// `siteFiles(site)` for 888poker and partypoker.
fn site_files(site: &str) -> Vec<SampleFile> {
    let mut files = sample_files("888poker");
    files.extend(sample_files("partypoker"));
    files.retain(|file| dialect_of(file) == site);
    files
}

/// `ALLOWED_REASONS`.
const ALLOWED_REASONS: [&str; 9] = [
    "unsupported-variant",
    "unsupported-hi-lo",
    "unsupported-locale",
    "truncated-hand",
    "no-winner",
    "inconsistent-pot",
    "unseated-actor",
    "board-size",
    "too-few-players",
];

/// `UNLOCKED_VARIANTS`.
const UNLOCKED_VARIANTS: [Variant; 4] = [
    Variant::Holdem,
    Variant::Omaha,
    Variant::Omaha5,
    Variant::Omaha6,
];

/// `semantics(hand)`: the projection two semantically equal hands share.
fn semantics(hand: &PhfHand) -> Value {
    let value = serde_json::to_value(hand).expect("json");
    let actions: Vec<Value> = value["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|action| {
            json!({
                "street": action["street"],
                "player": action["player"],
                "type": action["type"],
                "amount": action["amount"],
                "streetTotal": action["streetTotal"],
                "allIn": action["allIn"],
                "cards": action.get("cards").cloned().unwrap_or(Value::Null),
                "potName": action.get("potName").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    json!({
        "handId": value["meta"]["handId"],
        "playedAt": value["playedAt"],
        "game": value["game"],
        "table": value["table"],
        "players": value["players"],
        "board": value["board"],
        "results": value["results"],
        "textStyle": value["meta"]["textStyle"],
        "actions": actions,
    })
}

const P2_SITES: [&str; 2] = ["888poker", "partypoker"];

#[test]
fn p2_finds_the_corpus() {
    for site in P2_SITES {
        assert!(site_files(site).len() > 10, "{site}");
    }
}

#[test]
fn p2_every_file_is_attributed_to_its_own_parser() {
    for site in P2_SITES {
        for file in site_files(site) {
            let top = ranked(&file.text).first().copied();
            assert_eq!(top.map(|t| t.0), Some(site), "{}", file.relative_path);
            assert!(top.is_some_and(|t| t.1 >= 900), "{}", file.relative_path);
        }
    }
}

#[test]
fn p2_every_file_converts_or_refuses_with_a_reason() {
    for site in P2_SITES {
        for file in site_files(site) {
            let result = convert(&file.text, Some(&file.name));
            assert!(result.stats.total > 0, "{}", file.relative_path);
            assert_eq!(
                result.stats.total,
                result.stats.converted + result.stats.failed
            );
            for failure in &result.failures {
                assert!(
                    ALLOWED_REASONS.contains(&failure.reason.as_str()),
                    "{}: {}",
                    failure.reason,
                    failure.message
                );
                assert_eq!(failure.detected_site.as_deref(), Some(site));
                assert!(failure.message.chars().count() > 10);
            }
            for hand in hands(&result) {
                let at = format!("{} {}", file.name, hand.meta.hand_id);
                // An empty warning list proves full line coverage.
                assert!(
                    hand.meta.warnings.is_empty(),
                    "{at}: {:?}",
                    hand.meta.warnings
                );
                assert!(error_codes(hand).is_empty(), "{at}");
                assert_eq!(hand.meta.site_id, site);
                assert!(!hand.meta.raw_text.is_empty());
                assert!(UNLOCKED_VARIANTS.contains(&hand.game.variant), "{at}");
                assert_ne!(hand.game.variant, Variant::Shortdeck, "{at}");
            }
        }
    }
}

#[test]
fn p2_every_file_conserves_chips_in_every_hand() {
    for site in P2_SITES {
        for file in site_files(site) {
            for hand in hands(&convert(&file.text, Some(&file.name))) {
                let at = format!("{} {}", file.name, hand.meta.hand_id);
                let contributed: i64 = contributions_from_actions(hand)
                    .iter()
                    .map(|(_, amount)| amount)
                    .sum();
                assert_eq!(contributed, hand.results.total_pot, "{at} in");
                let paid: i64 = hand.results.winners.iter().map(|w| w.amount).sum();
                assert_eq!(
                    paid + total_fees(&hand.results.fees),
                    hand.results.total_pot,
                    "{at} out"
                );
                assert!(hand.results.fees.rake >= 0, "{at} rake");

                let mut stacks: Vec<(String, i64)> = hand
                    .players
                    .iter()
                    .map(|p| (p.name.clone(), p.starting_stack))
                    .collect();
                for action in &hand.actions {
                    if action.kind == ActionType::Collect || action.amount == 0 {
                        continue;
                    }
                    let entry = match stacks.iter_mut().find(|(name, _)| *name == action.player) {
                        Some(entry) => entry,
                        None => {
                            stacks.push((action.player.clone(), 0));
                            stacks.last_mut().expect("pushed")
                        }
                    };
                    entry.1 -= action.amount;
                    assert!(
                        entry.1 >= 0,
                        "{at} {} after {:?}",
                        action.player,
                        action.raw_line
                    );
                }
            }
        }
    }
}

#[test]
fn p2_every_file_round_trips_through_standard_text() {
    for site in P2_SITES {
        for file in site_files(site) {
            for hand in hands(&convert(&file.text, Some(&file.name))) {
                let text = to_standard_text(hand);
                let first = text.lines().next().unwrap_or("");
                let reparsed = parse_standard_hand(&text, &STANDARD)
                    .expect("reader threw")
                    .unwrap_or_else(|| panic!("{first}"));
                assert!(reparsed.meta.warnings.is_empty(), "{first}");
                assert_eq!(to_standard_text(&reparsed), text);
                assert_eq!(
                    semantics(&reparsed),
                    semantics(hand),
                    "{}",
                    hand.meta.hand_id
                );
            }
        }
    }
}

#[test]
fn hand_keys_prefix_every_site_so_ids_from_the_same_lineage_cannot_collide() {
    for (site, prefix) in [("888poker", "888-"), ("partypoker", "PTY-")] {
        for file in site_files(site).iter().take(6) {
            for hand in hands(&convert(&file.text, Some(&file.name))) {
                assert_eq!(hand.meta.hand_key, hand.meta.hand_id);
                assert!(
                    hand.meta.hand_id.starts_with(prefix),
                    "{}",
                    hand.meta.hand_id
                );
            }
        }
    }
}

#[test]
fn no_888poker_partypoker_parser_claims_another_rooms_sample() {
    // `ipoker` is the third room of the TypeScript list (R0.9).
    let mut claims = Vec::new();
    for dir in other_sample_sites(&["888poker", "partypoker", "ipoker"]) {
        for file in sample_files(&dir) {
            for (id, _) in ranked(&file.text) {
                if P2_SITES.contains(&id) {
                    claims.push(format!("{id} claims {}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn p2_does_not_claim_pokerstars_or_ggpoker_text() {
    let pokerstars = [
        "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
        "Table 'Aaltje II' 6-max Seat #2 is the button",
        "Seat 1: villain ($10 in chips)",
    ]
    .join("\n");
    let gg = [
        "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
        "Table 'NLHPurple70' 6-max Seat #1 is the button",
    ]
    .join("\n");
    for text in [pokerstars, gg] {
        for (id, _) in ranked(&text) {
            assert!(!P2_SITES.contains(&id), "{id}");
        }
    }
}

#[test]
fn refuses_to_claim_888_text_as_partypoker_and_the_other_way_round() {
    let p888 = [
        "#Game No : 349736402",
        "***** 888poker Hand History for Game 349736402 *****",
        "$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
        "Table Abbotsford 6 Max (Real Money)",
    ]
    .join("\n");
    let party = [
        "***** Hand History for Game 13550420797 *****",
        "$0.05/$0.10 USD NL Texas Hold'em - Monday, January 06, 05:54:36 EST 2014",
        "Table Almeria (Real Money)",
    ]
    .join("\n");
    let ids = |text: &str| -> Vec<&str> { ranked(text).into_iter().map(|c| c.0).collect() };
    assert_eq!(ids(&p888), ["888poker"]);
    assert_eq!(ids(&party), ["partypoker"]);
}

#[test]
fn goes_by_the_text_when_a_sample_is_filed_under_the_wrong_room() {
    for dir in P2_SITES {
        for file in sample_files(dir) {
            assert_eq!(
                ranked(&file.text).first().map(|c| c.0),
                Some(dialect_of(&file)),
                "{}",
                file.relative_path
            );
        }
    }
}

/* ===================================================== p3Parsers.test.ts */

/// `signature` of the PokerBros entry of `SITES`.
static PB_SIGNATURE: LazyLock<regex::Regex> = rail_core::js_regex_lazy!(
    r"^PokerBros Hand #\d+:|^\*{3,}\s*Hand History for Game\s+\d+\s*\*{3,}\s*\(PokerBros\)",
    ""
);
/// `reasons` of the PokerBros entry.
const PB_REASONS: [&str; 7] = [
    "unsupported-variant",
    "no-seat-block",
    "too-few-players",
    "inconsistent-pot",
    "normalized-unparseable",
    "unsupported-currency",
    "unseated-actor",
];
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
const MY_DIRS: [&str; 3] = ["full-tilt", "run-it-once", "pokerbros"];

/// `siteFiles(site)` for PokerBros: every sample whose text has the signature.
fn pokerbros_files() -> Vec<SampleFile> {
    let mut dirs: Vec<String> = MY_DIRS.iter().map(|d| (*d).to_owned()).collect();
    dirs.extend(other_sample_sites(&MY_DIRS));
    dirs.iter()
        .flat_map(|dir| sample_files(dir))
        .filter(|file| rail_core::phf::serialize::matches_at_line_start(&PB_SIGNATURE, &file.text))
        .collect()
}

/// `handsOf("pokerbros", prefix, pokerbrosParser)`.
fn pokerbros_hands(prefix: &str) -> Vec<PhfHand> {
    let file = sample_files("pokerbros")
        .into_iter()
        .find(|entry| entry.name.starts_with(prefix))
        .unwrap_or_else(|| panic!("fixture {prefix} is missing from fixtures/samples/pokerbros/"));
    PokerBrosParser
        .split_hands(&file.text)
        .expect("split")
        .iter()
        .map(|chunk| parse(&PokerBrosParser, chunk).expect("parsed"))
        .collect()
}

fn pokerbros_file(prefix: &str) -> SampleFile {
    sample_files("pokerbros")
        .into_iter()
        .find(|entry| entry.name.starts_with(prefix))
        .expect("fixture")
}

#[test]
fn pokerbros_finds_its_corpus() {
    let files = pokerbros_files();
    assert!(!files.is_empty());
    let misplaced: Vec<&str> = files
        .iter()
        .filter(|file| !file.relative_path.contains("/pokerbros/"))
        .map(|file| file.relative_path.as_str())
        .collect();
    assert!(misplaced.is_empty(), "{misplaced:?}");
}

#[test]
fn pokerbros_every_file_is_attributed_to_its_own_parser() {
    for file in pokerbros_files() {
        let ranking = ranked(&file.text);
        assert!(ranking.first().is_some_and(|c| c.1 >= 900));
        let ids: Vec<&str> = ranking.iter().map(|c| c.0).collect();
        assert_eq!(ids, ["pokerbros"], "{}", file.relative_path);
    }
}

#[test]
fn pokerbros_converts_or_refuses_with_a_machine_readable_reason() {
    for file in pokerbros_files() {
        let result = convert(&file.text, Some(&file.name));
        assert!(result.stats.total > 0);
        for failure in &result.failures {
            assert!(
                PB_REASONS.contains(&failure.reason.as_str()),
                "{}",
                failure.message
            );
            assert_eq!(failure.detected_site.as_deref(), Some("pokerbros"));
            assert!(failure.message.chars().count() > 10);
            assert!(!failure.raw_text.is_empty());
        }
        for hand in hands(&result) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            assert_eq!(hand.meta.site_id, "pokerbros", "{at}");
            assert_eq!(hand.meta.parser_id, "pokerbros", "{at}");
            assert_eq!(hand.meta.parser_version, PokerBrosParser.version(), "{at}");
            assert_eq!(
                hand.meta.hand_key,
                format!("PB{}", hand.meta.hand_id),
                "{at}"
            );
            assert!(!hand.meta.raw_text.is_empty(), "{at}");
            assert_eq!(hand.game.variant, Variant::Holdem, "{at}");
            assert!(error_codes(hand).is_empty(), "{at}");
        }
    }
}

#[test]
fn pokerbros_leaves_no_source_line_unread() {
    for file in pokerbros_files() {
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

#[test]
fn pokerbros_holds_every_invariant_in_every_hand() {
    for file in pokerbros_files() {
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
#[test]
fn pokerbros_pays_the_whole_pot_out_and_never_goes_below_zero() {
    for file in pokerbros_files() {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            let at = format!("{} {}", file.name, hand.meta.hand_id);
            let paid: i64 = hand.results.winners.iter().map(|w| w.amount).sum();
            assert_eq!(
                paid + total_fees(&hand.results.fees),
                hand.results.total_pot,
                "{at} out"
            );
            let contributed: i64 = contributions_from_actions(hand)
                .iter()
                .map(|(_, amount)| amount)
                .sum();
            assert_eq!(
                contributed + house_into_pot(hand),
                hand.results.total_pot,
                "{at} in"
            );
            assert!(hand.results.fees.rake >= 0, "{at} rake");
        }
    }
}

#[test]
fn reads_the_same_hand_identically_from_both_converter_dialects() {
    let party = pokerbros_hands("01-").remove(0);
    let stars = pokerbros_hands("02-").remove(0);
    assert_eq!(party.results.total_pot, stars.results.total_pot);
    assert_eq!(party.results.fees.rake, stars.results.fees.rake);
    assert_eq!(party.game.small_blind, stars.game.small_blind);
    assert_eq!(party.game.big_blind, stars.game.big_blind);
    assert_eq!(party.board.runouts[0].flop, stars.board.runouts[0].flop);
    assert_eq!(party.board.runouts[0].turn, stars.board.runouts[0].turn);
    assert_eq!(party.board.runouts[0].river, stars.board.runouts[0].river);
    let contributions = |hand: &PhfHand| {
        let mut players: Vec<(u32, i64, i64)> = hand
            .results
            .players
            .iter()
            .map(|p| (p.seat, p.contributed, p.won))
            .collect();
        players.sort_by_key(|p| p.0);
        players
    };
    assert_eq!(contributions(&party), contributions(&stars));
}

#[test]
fn derives_the_pot_and_the_rake_the_party_dialect_never_states() {
    let party = pokerbros_hands("01-").remove(0);
    assert_eq!(party.results.total_pot, 24580);
    assert_eq!(party.results.fees.rake, 425);
}

#[test]
fn reads_a_party_dialect_raise_as_a_raise_to_and_a_call_as_an_increment() {
    let party = pokerbros_hands("01-").remove(0);
    let preflop: Vec<_> = party
        .actions
        .iter()
        .filter(|a| a.street == Street::Preflop)
        .collect();
    let raise = preflop
        .iter()
        .find(|a| a.kind == ActionType::Raise)
        .expect("raise");
    assert_eq!(raise.street_total, 250);
    assert_eq!(raise.amount, 250);
    let call = preflop
        .iter()
        .find(|a| a.kind == ActionType::Call)
        .expect("call");
    assert_eq!(call.amount, 200);
    assert_eq!(call.street_total, 250);
}

#[test]
fn flags_the_converters_hole_card_attribution_rather_than_correcting_it() {
    let party = pokerbros_hands("01-").remove(0);
    assert!(
        party
            .meta
            .warnings
            .iter()
            .any(|w| w.code == "hero-attribution")
    );
}

#[test]
fn reads_a_button_the_converter_put_on_an_empty_seat() {
    let stars = pokerbros_hands("02-").remove(0);
    assert_eq!(stars.table.button_seat, Some(1));
    let warning = stars
        .meta
        .warnings
        .iter()
        .find(|w| w.code == "button-seat-empty")
        .expect("warning");
    assert!(warning.message.contains("seat 2"));
    assert!(warning.message.contains("seat 1"));

    let file = pokerbros_file("02-");
    let result = convert(&file.text, Some(&file.name));
    let position = |seat: u32| {
        result.hands[0]
            .hand
            .players
            .iter()
            .find(|p| p.seat == seat)
            .and_then(|p| p.position)
    };
    assert_eq!(position(3), Some(Position::Sb));
    assert_eq!(position(4), Some(Position::Bb));
    assert_eq!(position(1), Some(Position::Btn));

    let party = pokerbros_hands("01-").remove(0);
    assert_eq!(party.table.button_seat, stars.table.button_seat);
}

#[test]
fn does_not_let_the_partygaming_rooms_claim_its_party_dialect() {
    let file = pokerbros_file("01-");
    let ids: Vec<&str> = ranked(&file.text).into_iter().map(|c| c.0).collect();
    assert_eq!(ids, ["pokerbros"]);
}

#[test]
fn re_serializes_both_dialects_into_readable_standard_text() {
    for prefix in ["01-", "02-"] {
        let hand = pokerbros_hands(prefix).remove(0);
        let text = to_standard_text(&hand);
        assert!(text.contains("*** SUMMARY ***"), "{prefix}");
        assert!(text.contains("Total pot $245.80"), "{prefix}");
    }
}

#[test]
fn no_pokerbros_parser_claims_another_rooms_sample() {
    let mut claims = Vec::new();
    for dir in other_sample_sites(&MY_DIRS) {
        for file in sample_files(&dir) {
            let score = PokerBrosParser.detect(&file.text);
            if score > 0 {
                claims.push(format!(
                    "pokerbros claims {} at {score}",
                    file.relative_path
                ));
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn no_other_parser_claims_a_pokerbros_sample() {
    // Full Tilt and Run It Once (R0.10) are not ported; nothing ported may
    // claim the PokerBros samples.
    let mut claims = Vec::new();
    for file in sample_files("pokerbros") {
        for (id, _) in ranked(&file.text) {
            if id != "pokerbros" {
                claims.push(format!("{id} claims {}", file.relative_path));
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn never_throws_whatever_it_is_handed() {
    for text in [
        "",
        " ",
        "hello",
        "Poker Hand #1:",
        "PokerStars Hand #1:",
        "*****",
    ] {
        let _ = PokerBrosParser.detect(text);
        PokerBrosParser.split_hands(text).expect("split");
    }
}

#[test]
fn claims_branding_without_a_header_only_weakly() {
    assert_eq!(PokerBrosParser.detect("a PokerBros club game"), 300);
}

/* ====================================================== phfHiLo / Omaha */

/// `hand(relative)` of `phfHiLo`: converted with no refusal, one hand.
fn hi_lo_hand(relative: &str) -> PhfHand {
    let mut result = convert(&sample(relative), Some(relative));
    assert!(result.failures.is_empty(), "{relative}");
    assert_eq!(result.hands.len(), 1, "{relative}");
    result.hands.remove(0).hand
}

#[test]
fn awards_the_whole_pot_high_when_no_low_qualifies_888() {
    // 888 says nothing either way; the cards still do.
    assert_eq!(
        halves(&hi_lo_hand("888poker/10-omaha-hilo-hi-only-summary.txt")),
        [("selkoe".to_owned(), 808, Some(PotHalf::Hi))]
    );
}

#[test]
fn reads_a_scoop_printed_on_two_lines_as_both_halves() {
    assert_eq!(
        halves(&hi_lo_hand(
            "888poker/05-omaha-hilo-summary-hi-lo-split.txt"
        )),
        [
            ("hank1967".to_owned(), 95, Some(PotHalf::Hi)),
            ("hank1967".to_owned(), 95, Some(PotHalf::Lo)),
        ]
    );
}

/// `every converted hi/lo fixture` for this step's three files; the
/// `analyzeAllIn` check is R2.2.
#[test]
fn every_converted_hi_lo_fixture_validates_balances_and_round_trips_with_its_halves() {
    for file in [
        "888poker/05-omaha-hilo-summary-hi-lo-split.txt",
        "888poker/10-omaha-hilo-hi-only-summary.txt",
        "partypoker/08-omaha-hilo-split-pot.txt",
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

/// `phfOmaha.test.ts`: "reads the real partypoker split-pot fixture as two
/// halves of one pot".
#[test]
fn reads_the_real_partypoker_split_pot_fixture_as_two_halves_of_one_pot() {
    let result = convert(
        &sample("partypoker/08-omaha-hilo-split-pot.txt"),
        Some("08-omaha-hilo-split-pot.txt"),
    );
    assert!(result.failures.is_empty());
    let hand = &result.hands[0].hand;
    assert_eq!((hand.game.variant, hand.game.hi_lo), (Variant::Omaha, true));
    assert!(hand.meta.warnings.is_empty());
    assert_eq!(
        halves(hand),
        [
            ("robertp10".to_owned(), 2875, Some(PotHalf::Hi)),
            ("fistfock123".to_owned(), 2875, Some(PotHalf::Lo)),
        ]
    );
}

/* ------------------------------------------------------- Rust-only units */

/// The three parsers' refusals keep the TypeScript's wording; one of each
/// shape the corpus does not reach.
#[test]
fn refusals_keep_the_typescript_wording() {
    let skip = |parser: &dyn SiteParser, text: &str| match parse(parser, text) {
        Err(ParseError::Skip(skip)) => (skip.reason.as_str().to_owned(), skip.message),
        other => panic!("expected a refusal, got {other:?}"),
    };
    assert_eq!(
        skip(
            &Poker888Parser,
            "***** 888poker Hand History for Game 1 *****\n25 $/50 $ Blinds No Limit Holdem - *** 06 01 2014 22:40:28"
        ),
        (
            "unsupported-locale".to_owned(),
            "The stakes \"25 $/50 $\" are not in the English-locale 888 format.".to_owned()
        )
    );
    assert_eq!(skip(&PartyPokerParser, "hello").0, "no-header");
    assert_eq!(
        skip(
            &PartyPokerParser,
            "***** Hand History for Game 1 *****\n$0.05/$0.10 USD FL Seven Card Stud Hi-Lo - Sunday, January 05, 19:24:07 EST 2014"
        )
        .0,
        "unsupported-hi-lo"
    );
    assert_eq!(
        skip(
            &PokerBrosParser,
            "PokerBros Hand #1: Omaha Pot Limit ($0.5/$1 USD) - 2021/03/19 19:51:54 UTC"
        ),
        (
            "unsupported-variant".to_owned(),
            "Omaha Pot Limit is not supported yet; the hand is kept for a future parser."
                .to_owned()
        )
    );
}
