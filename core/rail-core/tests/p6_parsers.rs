//! The Winamax and Chico suite, translated (docs/RAIL-PLAN.md R0.10a):
//! `p6Parsers.test.ts`, with `support/p6Corpus.ts` as the loader (files read
//! as `readFileSync(path, "utf8")` does - BOM, CRLF and U+FFFD for invalid
//! bytes kept; not through `decodeSource`, so the three Windows-1252 Winamax
//! files are refused `unsupported-encoding` here, as in the TypeScript suite,
//! while the goldens convert them).
//!
//! Left out, and why: `assertReplays` (`buildReplay`, the replayer, is not
//! ported) in "round-trips and replays" and in the Chico Omaha conversion
//! test - the round-trip half is kept. "No other parser claims a Winamax or
//! Chico sample" runs over the ported parsers (the unported ones cannot claim
//! anything in Rust; their halves come with R0.10b-d). `p5Parsers`,
//! `phfDetect`, `phfHiLo`, `phfOmaha` and `phfPositions` have no Winamax or
//! Chico part; `phfCoreGaps`' Chico remark is about the parser-free
//! `Level -` round trip (R0.6). One Rust test per TypeScript `it` (an
//! `it.each` is one loop), named after it.

mod psgg_support;

use std::sync::LazyLock;

use psgg_support::{CorpusFile, STANDARD, root};
use rail_core::convert::ConversionResult;
use rail_core::detect::{ConvertOptions, SiteParser};
use rail_core::parsers::builtin;
use rail_core::parsers::chico::ChicoParser;
use rail_core::parsers::winamax::WinamaxParser;
use rail_core::phf::serialize::{matches_at_line_start, parse_standard_hand, to_standard_text};
use rail_core::phf::{
    ActionType, CurrencyKind, GameFormat, LimitType, PhfHand, Variant, contributions_from_actions,
    total_fees,
};
use rail_core::validate::validate_hand;
use serde_json::{Value, json};

/* ----------------------------------------------------------------- corpus */

/// `sampleFiles(site)` of `p6Corpus.ts`: `.txt` files, empty ones dropped.
fn sample_files(site: &str) -> Vec<CorpusFile> {
    let mut files = psgg_support::sample_files(site);
    files.retain(|file| !rail_core::js::trim(&file.text).is_empty());
    files
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

/// `CHICO_CONFIRMED_SKINS`.
const CHICO_CONFIRMED_SKINS: [&str; 4] = [
    "BetOnline Poker",
    "PayNoRake",
    "ActionPoker.com",
    "Gear Poker",
];
/// `CHICO_INFERRED_SKINS`.
const CHICO_INFERRED_SKINS: [&str; 2] = ["SportsBetting.ag Poker", "Tiger Gaming"];

static GAME_HEADER: LazyLock<regex::Regex> = rail_core::js_regex_lazy!(r" Game #\d+:", "");
static WINAMAX_TEXT: LazyLock<regex::Regex> =
    rail_core::js_regex_lazy!(r"^\uFEFF?Winamax Poker - ", "");

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// `chicoSkinOf(text)`: decided from the header line, not the folder.
fn chico_skin_of(text: &str) -> Option<&'static str> {
    let header = split_lines(text)
        .into_iter()
        .find(|line| GAME_HEADER.is_match(line))?;
    CHICO_CONFIRMED_SKINS
        .iter()
        .chain(CHICO_INFERRED_SKINS.iter())
        .find(|skin| header.starts_with(&format!("{skin} Game #")))
        .copied()
}

/// `isWinamaxText(text)`.
fn is_winamax_text(text: &str) -> bool {
    matches_at_line_start(&WINAMAX_TEXT, text)
}

fn convert(text: &str, filename: Option<&str>) -> ConversionResult {
    convert_with(
        text,
        ConvertOptions {
            source_filename: filename.map(str::to_owned),
            ..ConvertOptions::default()
        },
    )
}

fn convert_with(text: &str, options: ConvertOptions) -> ConversionResult {
    rail_core::convert_any(text, &options).expect("convertAny threw")
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

const MINE: [&str; 2] = ["winamax", "chico"];

/// `ALLOWED_REASONS`.
const ALLOWED_REASONS: [&str; 21] = [
    "unsupported-variant",
    "unsupported-tournament",
    "unsupported-encoding",
    "unsupported-locale",
    "board-mismatch",
    "truncated-hand",
    "rake-mismatch",
    "payout-mismatch",
    "uncalled-mismatch",
    "inconsistent-pot",
    "no-winner",
    "unseated-actor",
    "unnamed-seat",
    "duplicate-seat",
    "duplicate-player",
    "duplicate-card",
    "fractional-chips",
    "board-size",
    "too-few-players",
    "negative-stack",
    "unknown-site",
];

/// `ALLOWED_WARNINGS`.
const ALLOWED_WARNINGS: [&str; 6] = [
    "board-from-summary",
    "assumed-currency",
    "unreadable-shown-cards",
    "unverified-skin",
    "play-money-table",
    "unreadable-timestamp",
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

/// `assertSoundHand(hand, where)`.
fn assert_sound_hand(hand: &PhfHand, at: &str) {
    for warning in &hand.meta.warnings {
        assert!(
            ALLOWED_WARNINGS.contains(&warning.code.as_str()),
            "{at}: {} - {}",
            warning.code,
            warning.message
        );
    }
    let report = validate_hand(hand).expect("validateHand threw");
    let errors: Vec<_> = report.errors().map(|p| p.code.clone()).collect();
    assert!(errors.is_empty(), "{at}: {errors:?}");
    assert!(!hand.meta.raw_text.is_empty(), "{at}");
    assert!(
        [
            Variant::Holdem,
            Variant::Omaha,
            Variant::Omaha5,
            Variant::Omaha6
        ]
        .contains(&hand.game.variant),
        "{at}"
    );
    assert_ne!(hand.game.variant, Variant::Shortdeck, "{at}");
    assert_eq!(hand.meta.hand_key, hand.meta.hand_id, "{at}");

    let contributed: i64 = contributions_from_actions(hand)
        .iter()
        .map(|(_, amount)| amount)
        .sum();
    assert_eq!(contributed, hand.results.total_pot, "{at} chips in");
    let paid: i64 = hand.results.winners.iter().map(|w| w.amount).sum();
    assert_eq!(
        paid + total_fees(&hand.results.fees),
        hand.results.total_pot,
        "{at} chips out"
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
        let entry = if let Some(index) = stacks.iter().position(|(n, _)| *n == action.player) {
            &mut stacks[index]
        } else {
            stacks.push((action.player.clone(), 0));
            stacks.last_mut().expect("pushed")
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

/// `assertRoundTrips(hand)`.
fn assert_round_trips(hand: &PhfHand) {
    let text = to_standard_text(hand);
    let first = text.lines().next().unwrap_or("").to_owned();
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

/* ---------------------------------------------------------------- Winamax */

const WINAMAX_NEGATIVE: &str = "CashGame_ValidHandTests_InValidHand.txt";

#[test]
fn winamax_finds_the_corpus() {
    assert!(sample_files("winamax").len() > 20);
}

#[test]
fn winamax_every_file_is_winamax_text_and_is_attributed_to_winamax() {
    for file in sample_files("winamax") {
        if file.name == WINAMAX_NEGATIVE {
            assert!(!is_winamax_text(&file.text));
            assert!(ranked(&file.text).is_empty());
            continue;
        }
        assert!(is_winamax_text(&file.text), "{}", file.relative_path);
        let top = ranked(&file.text).first().copied();
        assert_eq!(top.map(|t| t.0), Some("winamax"), "{}", file.relative_path);
        assert!(top.is_some_and(|t| t.1 >= 900), "{}", file.relative_path);
    }
}

#[test]
fn winamax_every_file_converts_or_refuses_with_a_reason() {
    for file in sample_files("winamax") {
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
                failure.reason.as_str(),
                failure.message
            );
            assert!(failure.message.chars().count() > 10);
        }
        for hand in hands(&result) {
            assert_eq!(hand.meta.site_id, "winamax");
            assert!(
                hand.meta.hand_id.starts_with("WMX-"),
                "{}",
                hand.meta.hand_id
            );
            assert_eq!(hand.game.format, GameFormat::Cash);
            assert_sound_hand(hand, &format!("{} {}", file.name, hand.meta.hand_id));
        }
    }
}

#[test]
fn winamax_every_file_round_trips() {
    for file in sample_files("winamax") {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            assert_round_trips(hand);
        }
    }
}

#[test]
fn winamax_converts_every_hand_the_corpus_can_prove_and_states_why_it_refuses_the_rest() {
    let mut reasons: std::collections::BTreeMap<String, usize> = Default::default();
    let mut converted = 0;
    for file in sample_files("winamax") {
        let result = convert(&file.text, Some(&file.name));
        converted += result.hands.len();
        for failure in &result.failures {
            *reasons
                .entry(failure.reason.as_str().to_owned())
                .or_default() += 1;
        }
    }
    assert_eq!(converted, 31);
    assert_eq!(
        reasons,
        [
            ("unsupported-encoding".to_owned(), 3),
            ("board-mismatch".to_owned(), 1),
            ("unknown-site".to_owned(), 1),
        ]
        .into_iter()
        .collect()
    );
}

const WINAMAX_HEADER: &str = "Winamax Poker - CashGame - HandId: #1-2-3 - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC
Table: 'Milwaukee 02' 5-max (real money) Seat #2 is the button
Seat 1: alice (99.36€)
Seat 2: bob (64.76€)
*** ANTE/BLINDS ***
alice posts small blind 0.25€
bob posts big blind 0.50€
*** PRE-FLOP ***
alice folds
bob collected 0.75€ from pot
*** SUMMARY ***
Total pot 0.75€ | No rake";

fn winamax_forced(text: &str) -> ConversionResult {
    convert_with(
        text,
        ConvertOptions {
            site_id: Some("winamax".to_owned()),
            ..ConvertOptions::default()
        },
    )
}

/// `reasonFor(text)`.
fn reason_for(text: &str) -> Option<String> {
    winamax_forced(text)
        .failures
        .first()
        .map(|f| f.reason.as_str().to_owned())
}

#[test]
fn winamax_accepts_the_baseline_hand_the_other_cases_are_derived_from() {
    let result = winamax_forced(WINAMAX_HEADER);
    assert!(result.failures.is_empty(), "{:?}", result.failures);
    assert_eq!(result.hands[0].hand.game.unit.code, "EUR");
}

#[test]
fn winamax_refuses_a_comma_decimal_rather_than_reading_it_as_a_hundred_times_more() {
    assert_eq!(
        reason_for(&WINAMAX_HEADER.replacen("0.25€", "0,25€", 1)).as_deref(),
        Some("unsupported-locale")
    );
    assert_eq!(
        reason_for(&WINAMAX_HEADER.replacen("64.76€", "1 234,50€", 1)).as_deref(),
        Some("unsupported-locale")
    );
}

#[test]
fn winamax_refuses_a_file_decoded_with_the_wrong_codec() {
    assert_eq!(
        reason_for(&WINAMAX_HEADER.replace('€', "\u{FFFD}")).as_deref(),
        Some("unsupported-encoding")
    );
}

#[test]
fn winamax_refuses_a_currency_it_cannot_name() {
    assert_eq!(
        reason_for(&WINAMAX_HEADER.replace('€', " kr")).as_deref(),
        Some("unsupported-currency")
    );
}

#[test]
fn winamax_refuses_tournaments_which_no_verified_sample_exists_for() {
    let tournament = WINAMAX_HEADER.replacen(
        "Winamax Poker - CashGame - HandId:",
        "Winamax Poker - Tournament \"PPT Freeroll\" buyIn: Free level: 0 - HandId:",
        1,
    );
    assert_eq!(
        reason_for(&tournament).as_deref(),
        Some("unsupported-tournament")
    );
}

/* ------------------------------------------------------------------ Chico */

fn chico_files_for_skin(skin: &str) -> Vec<CorpusFile> {
    sample_files("chico")
        .into_iter()
        .filter(|file| chico_skin_of(&file.text) == Some(skin))
        .collect()
}

#[test]
fn chico_finds_the_corpus() {
    assert!(sample_files("chico").len() > 10);
}

#[test]
fn chico_every_files_bytes_name_a_skin_the_parser_knows() {
    for file in sample_files("chico") {
        assert!(
            chico_skin_of(&file.text).is_some(),
            "{}",
            file.relative_path
        );
    }
}

#[test]
fn chico_every_file_is_attributed_to_the_chico_parser() {
    for file in sample_files("chico") {
        let top = ranked(&file.text).first().copied();
        assert_eq!(top.map(|t| t.0), Some("chico"), "{}", file.relative_path);
        assert!(top.is_some_and(|t| t.1 >= 900), "{}", file.relative_path);
    }
}

#[test]
fn chico_every_file_converts_or_refuses_with_a_reason() {
    for file in sample_files("chico") {
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
                failure.reason.as_str(),
                failure.message
            );
            assert_eq!(failure.detected_site.as_deref(), Some("chico"));
            assert!(failure.message.chars().count() > 10);
        }
        for hand in hands(&result) {
            assert_eq!(hand.meta.site_id, "chico");
            assert!(
                hand.meta.hand_id.starts_with("CHC-"),
                "{}",
                hand.meta.hand_id
            );
            assert_sound_hand(hand, &format!("{} {}", file.name, hand.meta.hand_id));
        }
    }
}

#[test]
fn chico_every_file_round_trips() {
    for file in sample_files("chico") {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            assert_round_trips(hand);
        }
    }
}

#[test]
fn chico_reads_tournament_stacks_as_chips_and_cash_tables_as_money() {
    let digits = rail_core::js_regex_lazy!(r"^\d+$", "");
    for file in sample_files("chico") {
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            if hand.game.format == GameFormat::Tournament {
                let at = &hand.meta.hand_id;
                assert_eq!(hand.game.unit.kind, CurrencyKind::Chips, "{at}");
                let tournament = hand.tournament.as_ref().expect("tournament");
                assert!(digits.is_match(&tournament.id), "{at}");
                // No buy-in and no level number are invented.
                assert_eq!(tournament.buy_in, 0);
                assert_eq!(tournament.level_number, None);
                assert!(tournament.level_big_blind > 0);
            } else {
                assert_eq!(hand.game.format, GameFormat::Cash, "{}", hand.meta.hand_id);
            }
        }
    }
}

#[test]
fn chico_every_confirmed_skin_converts_the_hands_its_fixtures_can_prove() {
    let expected = [
        ("BetOnline Poker", 13, 44, 20),
        ("PayNoRake", 1, 1, 0),
        ("ActionPoker.com", 1, 1, 0),
        ("Gear Poker", 1, 2, 0),
    ];
    for (skin, files_expected, converted_expected, refused_expected) in expected {
        let files = chico_files_for_skin(skin);
        assert_eq!(files.len(), files_expected, "{skin} files");
        let (mut converted, mut refused) = (0, 0);
        for file in &files {
            let result = convert(&file.text, Some(&file.name));
            converted += result.hands.len();
            refused += result.failures.len();
            for hand in hands(&result) {
                assert_sound_hand(hand, &format!("{skin} {} {}", file.name, hand.meta.hand_id));
            }
        }
        assert_eq!(converted, converted_expected, "{skin} converted");
        assert_eq!(refused, refused_expected, "{skin} refused");
    }
}

#[test]
fn chico_has_no_fixture_at_all_for_the_two_inferred_skins() {
    for skin in CHICO_INFERRED_SKINS {
        assert!(chico_files_for_skin(skin).is_empty(), "{skin}");
    }
}

#[test]
fn chico_flags_a_hand_from_an_inferred_skin_instead_of_pretending_it_is_verified() {
    let betonline = chico_files_for_skin("BetOnline Poker")
        .into_iter()
        .find(|file| file.name.contains("zero.ante"))
        .expect("zero.ante");
    let tiger = betonline
        .text
        .replace("BetOnline Poker Game #", "Tiger Gaming Game #");
    let top = ranked(&tiger).first().copied().expect("candidate");
    assert_eq!(top.0, "chico");
    assert!(top.1 < 900);
    let result = convert(&tiger, Some("tiger.txt"));
    assert_eq!(result.hands.len(), 1);
    assert!(
        result.hands[0]
            .hand
            .meta
            .warnings
            .iter()
            .any(|w| w.code == "unverified-skin")
    );
}

#[test]
fn chico_does_not_name_the_unverified_skins_in_the_display_name() {
    for skin in ["SportsBetting", "Tiger"] {
        assert!(!ChicoParser.name().contains(skin));
    }
    for skin in ["BetOnline", "PayNoRake", "ActionPoker", "Gear Poker"] {
        assert!(ChicoParser.name().contains(skin));
    }
}

#[test]
fn chico_reads_the_title_case_skins_verbs_periods_and_capitalised_chips() {
    let action_poker = &chico_files_for_skin("ActionPoker.com")[0];
    let result = convert(&action_poker.text, Some(&action_poker.name));
    let hand = &result.hands[0].hand;
    assert!(hand.actions.iter().any(|a| a.kind == ActionType::Fold));
    assert_eq!(hand.game.small_blind, 100);
    assert_eq!(hand.game.big_blind, 200);
    assert_eq!(
        hand.players
            .iter()
            .find(|p| p.seat == 0)
            .map(|p| p.starting_stack),
        Some(7950)
    );
}

#[test]
fn chico_normalizes_the_networks_10_rank_so_the_card_is_not_silently_dropped() {
    let file = chico_files_for_skin("BetOnline Poker")
        .into_iter()
        .find(|entry| entry.name.contains("post.dead"))
        .expect("post.dead");
    let result = convert(&file.text, Some(&file.name));
    assert_eq!(
        result.hands[0].hand.board.runouts[0].turn.as_deref(),
        Some("Td")
    );
}

fn plo() -> CorpusFile {
    sample_files("chico")
        .into_iter()
        .find(|file| file.name.contains("PLO"))
        .expect("PLO file")
}

#[test]
fn chico_takes_the_variant_from_the_cards_not_from_the_header_label() {
    let plo = plo();
    assert!(plo.text.contains("Hold'em Pot Limit"));
    let result = convert(&plo.text, Some(&plo.name));
    assert!(!result.hands.is_empty());
    for hand in hands(&result) {
        assert_eq!(hand.game.variant, Variant::Omaha, "{}", hand.meta.hand_id);
        assert_eq!(hand.game.limit, LimitType::Pl, "{}", hand.meta.hand_id);
        assert!(!hand.game.hi_lo, "{}", hand.meta.hand_id);
    }
    for file in sample_files("chico") {
        if file.relative_path == plo.relative_path {
            continue;
        }
        for hand in hands(&convert(&file.text, Some(&file.name))) {
            assert_eq!(
                hand.game.variant,
                Variant::Holdem,
                "{} {}",
                file.name,
                hand.meta.hand_id
            );
        }
    }
}

#[test]
fn chico_refuses_the_two_confirmed_site_side_data_defects() {
    for (fragment, reason) in [
        ("two.players.one.seat", "duplicate-seat"),
        ("dead.stack", "unnamed-seat"),
    ] {
        let file = sample_files("chico")
            .into_iter()
            .find(|entry| entry.name.contains(fragment))
            .expect("fixture");
        let result = convert(&file.text, Some(&file.name));
        assert!(result.hands.is_empty(), "{fragment}");
        assert_eq!(result.failures[0].reason.as_str(), reason, "{fragment}");
    }
}

/* -------------------------------------------------------------- Chico PLO */

#[test]
fn chico_omaha_converts_every_hand_whose_accounting_the_source_states_and_nothing_else() {
    let plo = plo();
    let result = convert(&plo.text, Some(&plo.name));
    assert_eq!(result.stats.total, 17);
    let ids: Vec<&str> = hands(&result)
        .iter()
        .map(|h| h.meta.hand_id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "CHC-1073060614",
            "CHC-1073061094",
            "CHC-1073062051",
            "CHC-1073064926"
        ]
    );
    let reasons: Vec<&str> = result.failures.iter().map(|f| f.reason.as_str()).collect();
    assert_eq!(reasons, vec!["rake-mismatch"; 13]);
    for hand in hands(&result) {
        assert_sound_hand(hand, &hand.meta.hand_id);
        assert_round_trips(hand);
        for player in &hand.players {
            assert!(
                [0, 4].contains(&player.hole_cards.len()),
                "{} {}",
                hand.meta.hand_id,
                player.name
            );
        }
    }
}

#[test]
fn chico_omaha_states_the_board_from_summary_note_and_nothing_else() {
    let plo = plo();
    let result = convert(&plo.text, Some(&plo.name));
    let mut codes: Vec<&str> = hands(&result)
        .iter()
        .flat_map(|h| h.meta.warnings.iter().map(|w| w.code.as_str()))
        .collect();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes, ["board-from-summary"]);
    let quiet = hands(&result)
        .into_iter()
        .find(|h| h.meta.hand_id == "CHC-1073061094")
        .expect("hand");
    assert!(quiet.meta.warnings.is_empty());
}

#[test]
fn chico_omaha_reads_four_card_holdings_and_the_winner_from_the_summary() {
    let plo = plo();
    let result = convert(&plo.text, Some(&plo.name));
    let hand = hands(&result)
        .into_iter()
        .find(|h| h.meta.hand_id == "CHC-1073062051")
        .expect("hand");
    let cards = |name: &str| -> Vec<String> {
        hand.players
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.hole_cards.clone())
            .unwrap_or_default()
    };
    assert_eq!(cards("Hero"), ["3d", "7h", "6h", "6c"]);
    assert_eq!(cards("Player6"), ["As", "4d", "6d", "Ad"]);
    assert_eq!(cards("Player7"), ["Jc", "Qh", "9d", "Jh"]);
    assert_eq!(hand.results.winners.len(), 1);
    assert_eq!(hand.results.winners[0].player, "Player6");
    assert_eq!(hand.results.winners[0].amount, 400);
    assert_eq!(hand.results.total_pot, 420);
    assert_eq!(hand.results.fees.rake, 20);
}

#[test]
fn chico_omaha_refuses_a_four_card_table_that_names_itself_hi_lo() {
    let plo = plo();
    // `plo.text.split(/\n{2,}(?=BetOnline Poker Game #)/)[0]`.
    let split = rail_core::js_regex_lazy!(r"\n{2,}BetOnline Poker Game #", "");
    let text = plo.text.replace("\r\n", "\n");
    let hand = split
        .find(&text)
        .map_or(text.as_str(), |m| &text[..m.start()]);
    let hi_lo = hand.replacen("Table 'Weeds (Hi)'", "Table 'Weeds (Hi/Lo)'", 1);
    let result = convert(&hi_lo, Some("hilo.txt"));
    assert_eq!(result.stats.total, 1);
    assert!(result.hands.is_empty());
    assert_eq!(
        result.failures.first().map(|f| f.reason.as_str()),
        Some("unsupported-hi-lo")
    );
}

#[test]
fn chico_omaha_refuses_a_deal_it_has_no_sample_of_rather_than_guessing_the_game() {
    let hand = sample_files("chico")
        .into_iter()
        .find(|file| file.name.contains("post.dead"))
        .expect("post.dead")
        .text;
    // `hand.match(/^Dealt to (\S+) \[([^\]]*)\]/m)`.
    let dealt = rail_core::js_regex_lazy!(r"^Dealt to (\S+) \[([^\]]*)\]", "");
    let found = hand
        .split('\n')
        .find_map(|line| dealt.captures(line))
        .expect("deal line");
    let five = hand.replacen(
        &found[0],
        &format!("Dealt to {} [2c 3c 4c 5c 6c]", &found[1]),
        1,
    );
    let result = convert(&five, Some("five.txt"));
    assert!(result.hands.is_empty());
    assert_eq!(
        result.failures.first().map(|f| f.reason.as_str()),
        Some("unsupported-variant")
    );
}

/* -------------------------------------------------------------- detection */

#[test]
fn neither_parser_claims_another_sites_sample() {
    let mut claims = Vec::new();
    for dir in other_sample_sites(&MINE) {
        for file in sample_files(&dir) {
            for (id, _) in ranked(&file.text) {
                if MINE.contains(&id) {
                    claims.push(format!("{id} claims {}", file.relative_path));
                }
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn both_score_zero_not_merely_below_threshold_on_every_other_sites_samples() {
    for dir in other_sample_sites(&MINE) {
        for file in sample_files(&dir) {
            assert_eq!(
                WinamaxParser.detect(&file.text),
                0,
                "winamax vs {}",
                file.relative_path
            );
            assert_eq!(
                ChicoParser.detect(&file.text),
                0,
                "chico vs {}",
                file.relative_path
            );
        }
    }
}

#[test]
fn no_other_ported_parser_claims_a_winamax_or_chico_sample() {
    let mut claims = Vec::new();
    for file in sample_files("winamax")
        .into_iter()
        .chain(sample_files("chico"))
    {
        if file.name == WINAMAX_NEGATIVE {
            continue;
        }
        let mine = if is_winamax_text(&file.text) {
            "winamax"
        } else {
            "chico"
        };
        for (id, permille) in ranked(&file.text) {
            if id != mine {
                claims.push(format!("{id} ({permille}) claims {}", file.relative_path));
            }
        }
    }
    assert!(claims.is_empty(), "{claims:?}");
}

#[test]
fn neither_claims_pokerstars_gg_or_wpn_shaped_text() {
    let foreign = [
        [
            "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
            "Table 'Aaltje II' 6-max Seat #2 is the button",
        ]
        .join("\n"),
        [
            "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
            "Table 'NLHPurple70' 6-max Seat #1 is the button",
        ]
        .join("\n"),
        [
            "Game Hand #1234567 - Hold'em No Limit ($0.01/$0.02)",
            "Table 'Bilbao' 6-max Seat #1",
        ]
        .join("\n"),
    ];
    for text in foreign {
        assert_eq!(WinamaxParser.detect(&text), 0);
        assert_eq!(ChicoParser.detect(&text), 0);
    }
}
