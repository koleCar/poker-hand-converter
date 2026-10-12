//! The TypeScript tests of the standard text, translated: all of
//! `phfSerializeStyle.test.ts`, the `gg-hh/` half of `phfRoundTrip.test.ts`,
//! and the standard-text cases of `phfCoreGaps`, `phfMoney` and `phfOmaha`
//! (the parts that need no other parser). Plus the hand-written stand-ins
//! for the TypeScript's lookahead patterns, against outcomes recorded from
//! Node, and the check that every pattern is still the TypeScript's.
//!
//! The WePlay half of `phfRoundTrip` and `byteCompat` need the WePlay parser;
//! the property they check - a converted hand's text comes back byte for byte
//! through this reader - is checked for every golden hand, WePlay's included,
//! by `tests/golden_serialize.rs`.

use std::path::{Path, PathBuf};

use super::read::{SOURCE_PATTERNS as READ_PATTERNS, limit_from_label};
use super::write::SOURCE_PATTERNS as WRITE_PATTERNS;
use super::*;
use crate::detect::PINNED_PARSED_AT;
use crate::js::regex::js_regex;
use crate::phf::money::{CHIPS, USD};
use crate::phf::{
    ActionType, ChipMovementAnchor, CurrencyKind, DecimalStyle, LimitType, PhfChipMovement,
    PhfHand, PhfStraddle, Variant, hole_card_count, house_into_pot, seat_out_of_pot, total_buy_in,
};
use crate::validate::validate_hand;

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: PINNED_PARSED_AT,
};

fn parse(text: &str) -> PhfHand {
    parse_standard_hand(text, &CTX)
        .expect("no throw")
        .expect("fixture did not parse")
}

/// Parse, re-serialize, and demand the bytes back.
fn round_trip(text: &str) -> String {
    to_standard_text(&parse(text))
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `.txt` files of a directory, sorted, read as UTF-8 (the tests'
/// `readFileSync(path, "utf8")`).
fn text_files(dir: &Path, matching: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".txt") && matching(name))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let bytes = std::fs::read(dir.join(&name)).expect("read fixture");
            (name, String::from_utf8_lossy(&bytes).into_owned())
        })
        .collect()
}

/* --------------------------------------------------- the TypeScript's own */

#[test]
fn every_pattern_is_the_typescripts() {
    let source = include_str!("../../../../../frontend/src/lib/phf/serialize.ts");
    for pattern in READ_PATTERNS.iter().chain(WRITE_PATTERNS) {
        assert!(
            source.contains(pattern),
            "serialize.ts no longer contains {pattern}"
        );
    }
    // Every compiled pattern compiles.
    for pattern in READ_PATTERNS.iter().chain(WRITE_PATTERNS) {
        if pattern.contains("(?=") || pattern.contains("(?!") {
            continue;
        }
        let _ = js_regex(&pattern.replace("${MONEY}", "x"), "");
    }
    for constant in [
        r#"export const STANDARD_TEXT_PARSER_VERSION = "1.0.0";"#,
        r#"const RUN_PREFIXES = ["FIRST", "SECOND", "THIRD", "FOURTH"];"#,
        r#"const RUN_WORDS = ["", "once", "two times", "three times", "four times"];"#,
        r#"const DEFAULT_FEE_COLUMNS = ["Rake", "Jackpot", "Bingo", "Fortune", "Tax"];"#,
        r#"return hands.map((hand) => toStandardText(hand, options)).join("\n\n");"#,
    ] {
        assert!(source.contains(constant), "{constant}");
    }
}

/// `limitFromLabel`'s `\bLimit\b(?!\s*Hold)`, against Node.
#[test]
fn reads_the_limit_like_the_lookahead_does() {
    let cases = [
        ("Hold'em Limit", LimitType::Fl),
        ("Limit Hold'em", LimitType::Nl),
        ("Limit  hold'em Limit", LimitType::Fl),
        ("No Limit Hold'em", LimitType::Nl),
        ("Fixed Limit Hold'em", LimitType::Fl),
        ("PLO", LimitType::Pl),
        ("PLO-5", LimitType::Pl),
        ("Pot Limit Omaha", LimitType::Pl),
        ("Limited", LimitType::Nl),
        ("LIMIT", LimitType::Fl),
        ("Razz Limit", LimitType::Fl),
        (
            "Hold'em Pot Limit Pre-Flop, No Limit Post-Flop",
            LimitType::Pl,
        ),
        ("limit hold", LimitType::Nl),
        ("Limit\nHold'em", LimitType::Nl),
    ];
    for (label, limit) in cases {
        assert_eq!(limit_from_label(label), limit, "{label:?}");
    }
}

/// The decimal-style, grouping and blank-deal-line probes, against Node.
#[test]
fn style_probes_read_what_the_lookaheads_read() {
    let text = |amounts: &str| format!("Poker Hand #1: x\nSeat 1: a (1 in chips)\nnote {amounts}");
    let decimals = |amounts: &str| {
        parse_standard_hand(&text(amounts), &CTX)
            .expect("no throw")
            .expect("a hand")
            .meta
            .text_style
            .decimals
    };
    for (amounts, style) in [
        ("$0.50", DecimalStyle::Fixed2),
        ("$0.5", DecimalStyle::Minimal),
        ("$0.500", DecimalStyle::Fixed2),
        ("$0.25", DecimalStyle::Fixed2),
        ("$1.05", DecimalStyle::Fixed2),
        ("1.5 2.50", DecimalStyle::Fixed2),
        ("x", DecimalStyle::Fixed2),
        ("0.123", DecimalStyle::Fixed2),
        ("1.0", DecimalStyle::Minimal),
        ("1.00", DecimalStyle::Fixed2),
    ] {
        assert_eq!(decimals(amounts), style, "{amounts}");
    }

    // Grouping is read below the header; the blank deal line's trailing
    // space from the first `Dealt to` line without cards.
    let hand_with = |body: &str| {
        let mut hand = parse(&format!(
            "Poker Hand #G1: Hold'em No Limit (1/2) - 2026/02/17 05:06:07\nSeat 1: a (1 in chips)\nSeat 2: b (2000 in chips)\n{body}"
        ));
        hand.players[1].dealt_announced = true;
        hand.meta.text_style.hole_cards_section = true;
        hand
    };
    let stack_line = |hand: &PhfHand| {
        to_standard_text(hand)
            .lines()
            .find(|line| line.starts_with("Seat 2"))
            .map(str::to_owned)
    };
    for (body, grouped) in [
        ("x 1,000", true),
        ("x 1,0000", false),
        ("x 1,000,000", true),
        ("x 12,34", false),
        ("x 1,000.5", true),
    ] {
        let expected = if grouped {
            "Seat 2: b (2,000 in chips)"
        } else {
            "Seat 2: b (2000 in chips)"
        };
        assert_eq!(
            stack_line(&hand_with(body)).as_deref(),
            Some(expected),
            "{body}"
        );
    }
    let dealt = |body: &str| {
        to_standard_text(&hand_with(body))
            .lines()
            .find(|line| line.starts_with("Dealt to b"))
            .map(str::to_owned)
    };
    for (body, line) in [
        ("Dealt to a \nDealt to b", "Dealt to b "),
        ("Dealt to a [Ah]\nDealt to b", "Dealt to b"),
        ("Dealt to a [x\nDealt to b", "Dealt to b"),
        ("x\rDealt to a\t\nend", "Dealt to b "),
        ("", "Dealt to b "),
    ] {
        assert_eq!(dealt(body).as_deref(), Some(line), "{body:?}");
    }
}

/* -------------------------------------------- phfSerializeStyle.test.ts */

const GROUPED: &str = "Poker Hand #TM1: Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600) - 2021/04/04 20:43:56
Table '137' 8-max Seat #2 is the button
Seat 1: alpha (21,929 in chips)
Seat 2: bravo (46,372 in chips)
alpha: posts the ante 75
bravo: posts the ante 75
bravo: posts small blind 300
alpha: posts big blind 600
*** HOLE CARDS ***
Dealt to alpha
Dealt to bravo [Kc Jc]
bravo: raises 600 to 1,200
alpha: folds
Uncalled bet (600) returned to bravo
*** SHOWDOWN ***
bravo: doesn't show hand
bravo collected 1,350 from pot
*** SUMMARY ***
Total pot 1,350
Seat 1: alpha (big blind) folded before Flop
Seat 2: bravo (button) (small blind) collected (1,350)";

/// `text.replace(/,(\d{3})/g, "$1")`.
fn ungrouped(text: &str) -> String {
    js_regex(r",(\d{3})", "g")
        .replace_all(text, "${1}")
        .into_owned()
}

#[test]
fn round_trips_grouped_amounts_everywhere_they_appear() {
    assert_eq!(round_trip(GROUPED), GROUPED);
}

#[test]
fn reads_grouped_digits_as_the_number_not_as_something_smaller() {
    let hand = parse(GROUPED);
    assert!(validate_hand(&hand).expect("no throw").ok());
    let alpha = hand.players.iter().find(|p| p.name == "alpha");
    assert_eq!(alpha.map(|p| p.starting_stack), Some(21929));
    assert_eq!(hand.results.total_pot, 1350);
    let raise = hand.actions.iter().find(|a| a.kind == ActionType::Raise);
    assert_eq!(raise.map(|a| a.street_total), Some(1200));
}

#[test]
fn leaves_ungrouped_sources_ungrouped() {
    let plain = ungrouped(GROUPED);
    assert_eq!(round_trip(&plain), plain);
    // Digit grouping specifically; the comma after the tournament id stays.
    assert!(!js_regex(r"\d,\d{3}", "").is_match(&round_trip(&plain)));
}

#[test]
fn grouping_can_be_pinned_explicitly_overriding_the_source() {
    let mut hand = parse(GROUPED);
    hand.meta.text_style.group_thousands = Some(false);
    assert!(to_standard_text(&hand).contains("Seat 1: alpha (21929 in chips)"));
}

#[test]
fn round_trips_ggs_inline_name_glued_level_and_incidental_spacing() {
    assert!(round_trip(GROUPED).contains(
        "Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)"
    ));
    let hand = parse(GROUPED);
    let tour = hand.tournament.as_ref().expect("a tournament");
    assert_eq!(tour.id, "25313426");
    assert_eq!(tour.level_label.as_deref(), Some("14"));
    assert_eq!(tour.level_small_blind, 300);
    assert_eq!(tour.level_big_blind, 600);
    assert_eq!(hand.game.label, "Hold'em No Limit");
    assert_eq!(hand.game.unit.kind, CurrencyKind::Chips);
}

#[test]
fn splits_the_name_from_the_game_label_by_the_label_not_by_the_buy_in() {
    let hand = parse(&GROUPED.replace("H-04: $1,050 GGMasters High Rollers", "Daily Special $250"));
    assert_eq!(
        hand.tournament.and_then(|t| t.name).as_deref(),
        Some("Daily Special $250")
    );
    assert_eq!(hand.game.label, "Hold'em No Limit");
}

#[test]
fn still_round_trips_the_parenthesised_name_dialect() {
    let weplay = GROUPED.replace(
        "Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)",
        "Tournament (Chocolate Box Deepstack)#11275291, $15+$1.50 Hold'em No Limit - Level XI (300/600)",
    );
    assert_eq!(round_trip(&weplay), weplay);
    let tour = parse(&weplay).tournament.expect("a tournament");
    assert_eq!(tour.name.as_deref(), Some("Chocolate Box Deepstack"));
    assert_eq!(tour.buy_in, 1500);
    assert_eq!(tour.fee, 150);
}

#[test]
fn never_invents_a_zero_fee_the_room_did_not_print() {
    let single = GROUPED.replace(
        "H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)",
        "Daily Special $55 Hold'em No Limit - Level2 (300/600)",
    );
    assert_eq!(round_trip(&single), single);
    assert!(!round_trip(&single).contains("+$0"));
}

#[test]
fn echoes_a_bare_pot_with_no_columns_at_all() {
    assert!(round_trip(GROUPED).contains("\nTotal pot 1,350\n"));
}

#[test]
fn echoes_a_partial_column_set() {
    let partial = GROUPED.replace("Total pot 1,350", "Total pot 1,350 | Rake 0 | Jackpot 0");
    assert!(round_trip(&partial).contains("Total pot 1,350 | Rake 0 | Jackpot 0\n"));
}

#[test]
fn keeps_the_full_gg_cash_set() {
    let full = GROUPED.replace(
        "Total pot 1,350",
        "Total pot 1,350 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0",
    );
    assert_eq!(round_trip(&full), full);
}

#[test]
fn echoes_a_source_that_writes_no_trailing_space_on_the_empty_deal_line() {
    assert!(round_trip(GROUPED).contains("\nDealt to alpha\n"));
}

#[test]
fn echoes_a_source_that_writes_one() {
    let spaced = GROUPED.replace("Dealt to alpha\n", "Dealt to alpha \n");
    assert!(round_trip(&spaced).contains("\nDealt to alpha \n"));
}

const BARE_STRADDLE: &str = "Poker Hand #RC1: Hold'em No Limit ($0.01/$0.02) - 2021/03/01 10:00:00
Table 'RushAndCash1' 6-max Seat #1 is the button
Seat 1: alpha ($2 in chips)
Seat 2: bravo ($2 in chips)
Seat 3: Hero ($2 in chips)
bravo: posts small blind $0.01
Hero: posts big blind $0.02
alpha: straddle $0.04
*** HOLE CARDS ***
Dealt to alpha
Dealt to bravo
Dealt to Hero [Ac Kh]
bravo: folds
Hero: folds
Uncalled bet ($0.02) returned to alpha
*** SHOWDOWN ***
alpha: doesn't show hand
alpha collected $0.05 from pot
*** SUMMARY ***
Total pot $0.05 | Rake $0
Seat 1: alpha (button) collected ($0.05)
Seat 2: bravo (small blind) folded before Flop
Seat 3: Hero (big blind) folded before Flop";

#[test]
fn reads_ggs_bare_straddle_which_has_no_posts() {
    let hand = parse(BARE_STRADDLE);
    assert!(validate_hand(&hand).expect("no throw").ok());
    assert_eq!(
        hand.game.straddles,
        [PhfStraddle {
            seat: 1,
            player: "alpha".to_owned(),
            amount: 4,
            order: 1,
        }]
    );
    let straddle = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Straddle)
        .expect("a straddle");
    assert_eq!(straddle.amount, 4);
    assert_eq!(straddle.verb.as_deref(), Some("straddle"));
    assert_eq!(round_trip(BARE_STRADDLE), BARE_STRADDLE);
}

#[test]
fn still_reads_posts_straddle_and_a_plain_posts() {
    let posts = BARE_STRADDLE.replace("alpha: straddle $0.04", "alpha: posts straddle $0.04");
    let hand = parse(&posts);
    let straddle = hand.actions.iter().find(|a| a.kind == ActionType::Straddle);
    assert_eq!(
        straddle.and_then(|a| a.verb.as_deref()),
        Some("posts straddle")
    );
    assert_eq!(round_trip(&posts), posts);

    let dead = BARE_STRADDLE.replace("alpha: straddle $0.04", "alpha: posts $0.04");
    let hand = parse(&dead);
    let straddle = hand.actions.iter().find(|a| a.kind == ActionType::Straddle);
    assert!(straddle.is_some_and(|a| a.verb.is_none()));
    assert_eq!(round_trip(&dead), dead);
}

#[test]
fn does_not_let_a_bare_amount_masquerade_as_a_post() {
    let junk = BARE_STRADDLE.replace("alpha: straddle $0.04", "alpha: 0.04");
    let hand = parse(&junk);
    assert!(
        !hand
            .actions
            .iter()
            .any(|a| matches!(a.kind, ActionType::Straddle | ActionType::Post))
    );
    assert!(hand.meta.warnings.iter().any(|w| w.code == "unknown-line"));
}

#[test]
fn echoes_the_spaced_showdown_spelling_some_builds_emit() {
    let spaced = GROUPED.replace("*** SHOWDOWN ***", "*** SHOW DOWN ***");
    assert!(round_trip(&spaced).contains("*** SHOW DOWN ***"));
    assert!(round_trip(GROUPED).contains("*** SHOWDOWN ***"));
}

const RESORTED_BOARD: &str = "Poker Hand #TM2: Hold'em No Limit ($0.25/$0.5) - 2020/08/13 16:29:44
Table 'T' 6-max Seat #1 is the button
Seat 1: alpha ($100 in chips)
Seat 2: bravo ($100 in chips)
bravo: posts small blind $0.25
alpha: posts big blind $0.5
*** HOLE CARDS ***
Dealt to alpha [Ac Kh]
bravo: calls $0.25
alpha: checks
*** FLOP *** [Ad 7d 9d]
bravo: checks
alpha: checks
*** TURN *** [7d 9d Ad] [2s]
bravo: checks
alpha: checks
*** RIVER *** [7d 9d Ad 2s] [4h]
bravo: checks
alpha: checks
*** SHOWDOWN ***
alpha: shows [Ac Kh] (a pair of Aces)
bravo: mucks hand
alpha collected $1 from pot
*** SUMMARY ***
Total pot $1 | Rake $0
Board [7d 9d Ad 2s 4h]
Seat 1: alpha (big blind) showed [Ac Kh] and won ($1) with a pair of Aces
Seat 2: bravo (small blind) mucked";

fn cards(codes: &[&str]) -> Vec<String> {
    codes.iter().map(|c| (*c).to_owned()).collect()
}

#[test]
fn keeps_the_deal_order_on_the_flop_and_the_restated_order_after_it() {
    let hand = parse(RESORTED_BOARD);
    assert_eq!(hand.board.runouts[0].flop, Some(cards(&["Ad", "7d", "9d"])));
    assert_eq!(
        hand.board.runouts[0].summary_cards,
        Some(cards(&["7d", "9d", "Ad", "2s", "4h"]))
    );
    assert_eq!(round_trip(RESORTED_BOARD), RESORTED_BOARD);
}

#[test]
fn does_not_reorder_when_the_room_is_self_consistent() {
    let tidy = js_regex(r"\[7d 9d Ad", "g")
        .replace_all(RESORTED_BOARD, "[Ad 7d 9d")
        .into_owned();
    assert_eq!(round_trip(&tidy), tidy);
}

/* ------------------------------------------- phfRoundTrip.test.ts, gg-hh */

/// `ggFiles()`: every reference GG-format file in `gg-hh/`.
fn gg_files() -> Vec<(String, String)> {
    text_files(&root().join("gg-hh"), |_| true)
}

#[test]
fn finds_the_reference_corpus() {
    assert!(gg_files().len() > 5);
}

#[test]
fn every_gg_hh_file_parses_every_hand_with_no_unknown_lines() {
    for (name, text) in gg_files() {
        let chunks = split_standard_hands(&text);
        assert!(!chunks.is_empty(), "{name}");
        for chunk in chunks {
            let hand = parse_standard_hand(&chunk, &CTX).expect("no throw");
            let header = chunk.split('\n').next().unwrap_or_default();
            let hand = hand.unwrap_or_else(|| panic!("{name}: {header}"));
            assert_eq!(hand.meta.warnings, [], "{name}: {header}");
        }
    }
}

#[test]
fn every_gg_hh_file_re_serializes_byte_for_byte() {
    for (name, text) in gg_files() {
        for chunk in split_standard_hands(&text) {
            assert_eq!(round_trip(&chunk), chunk, "{name}");
        }
    }
}

/// `semantics()` of `phfRoundTrip.test.ts` (also in `golden_serialize.rs`).
fn semantics(hand: &PhfHand) -> serde_json::Value {
    let actions: Vec<serde_json::Value> = hand
        .actions
        .iter()
        .map(|a| {
            serde_json::json!({
                "street": a.street, "runoutIndex": a.runout_index, "player": a.player,
                "type": a.kind, "amount": a.amount, "streetTotal": a.street_total,
                "allIn": a.all_in, "cards": a.cards, "description": a.description,
                "potName": a.pot_name,
            })
        })
        .collect();
    serde_json::json!({
        "schema": hand.schema, "handId": hand.meta.hand_id, "playedAt": hand.played_at,
        "game": hand.game, "table": hand.table, "tournament": hand.tournament,
        "players": hand.players, "board": hand.board, "results": hand.results,
        "textStyle": hand.meta.text_style, "actions": actions,
    })
}

#[test]
fn every_gg_hh_file_survives_parse_serialize_parse_unchanged() {
    for (name, text) in gg_files() {
        for chunk in split_standard_hands(&text) {
            let first = parse(&chunk);
            let second = parse(&to_standard_text(&first));
            assert_eq!(semantics(&second), semantics(&first), "{name}");
        }
    }
}

/* ---------------------------------------------------- phfCoreGaps.test.ts */

const STP: &str = "Poker Hand #STP1: Hold'em No Limit ($0.05/$0.10) - 2019/06/01 10:00:00
Table 'RIO' 6-max Seat #1 is the button
Seat 1: alpha ($10 in chips)
Seat 2: bravo ($10 in chips)
bravo: posts small blind $0.05
alpha: posts big blind $0.10
*** HOLE CARDS ***
STP added: $0.50
Dealt to alpha [Ac Kh]
bravo: folds
Uncalled bet ($0.05) returned to alpha
*** SHOWDOWN ***
alpha: doesn't show hand
alpha collected $0.60 from pot
*** SUMMARY ***
Total pot $0.60 | Rake $0
Seat 1: alpha (big blind) collected ($0.60)
Seat 2: bravo (small blind) folded before Flop";

#[test]
fn balances_a_pot_that_is_bigger_than_what_the_players_put_in() {
    let hand = parse(STP);
    assert!(validate_hand(&hand).expect("no throw").ok());
    assert_eq!(house_into_pot(&hand), 50);
    assert_eq!(
        hand.chip_movements,
        Some(vec![PhfChipMovement {
            kind: "splash-the-pot".to_owned(),
            from_seat: None,
            from_player: None,
            to_pot: true,
            amount: 50,
            raw: Some("STP added: $0.50".to_owned()),
            anchor: ChipMovementAnchor::AfterHoleCards,
        }])
    );
}

#[test]
fn house_chips_corrupt_nobodys_net() {
    let hand = parse(STP);
    let alpha = hand
        .results
        .players
        .iter()
        .find(|p| p.player == "alpha")
        .expect("alpha");
    assert_eq!(alpha.contributed, 5);
    assert_eq!(alpha.net, 55);
}

#[test]
fn round_trips_the_drop_line_at_the_anchor_the_room_printed_it() {
    assert_eq!(round_trip(STP), STP);
    // GG prints it before the blinds instead, and that has to survive too.
    let gg = STP
        .replace(
            "*** HOLE CARDS ***\nSTP added: $0.50\n",
            "*** HOLE CARDS ***\n",
        )
        .replace(
            "Seat 2: bravo ($10 in chips)\n",
            "Seat 2: bravo ($10 in chips)\nCash Drop to Pot : total $0.5\n",
        );
    let hand = parse(&gg);
    let drop = &hand.chip_movements.as_ref().expect("a drop")[0];
    assert_eq!(drop.kind, "cash-drop");
    assert_eq!(drop.anchor, ChipMovementAnchor::BeforePostings);
    assert_eq!(drop.amount, 50);
    assert_eq!(to_standard_text(&hand), gg);
}

#[test]
fn takes_a_jackpot_drop_off_the_stack_and_leaves_the_pot_alone() {
    let mut hand = parse(STP);
    hand.chip_movements = Some(vec![PhfChipMovement {
        kind: "bad-beat-drop".to_owned(),
        from_seat: Some(2),
        from_player: Some("bravo".to_owned()),
        to_pot: false,
        amount: 2,
        raw: None,
        anchor: ChipMovementAnchor::BeforePostings,
    }]);
    assert_eq!(hand.results.total_pot, 60);
    assert_eq!(house_into_pot(&hand), 0);
    assert_eq!(seat_out_of_pot(&hand, 2), 2);
}

const NO_LEVEL: &str = "Poker Hand #UNI1: Tournament (Banzai Bounty)#85614762, €0.93+€0.07 Hold'em No Limit - (25/50) - 2026/06/05 21:59:56
Table 'T' 6-max Seat #1 is the button
Seat 1: alpha (1000 in chips)
Seat 2: bravo (1000 in chips)
bravo: posts small blind 25
alpha: posts big blind 50
*** HOLE CARDS ***
Dealt to alpha [Ac Kh]
bravo: folds
Uncalled bet (25) returned to alpha
*** SHOWDOWN ***
alpha: doesn't show hand
alpha collected 50 from pot
*** SUMMARY ***
Total pot 50 | Rake 0
Seat 1: alpha (big blind) collected (50)
Seat 2: bravo (small blind) folded before Flop";

#[test]
fn a_tournament_with_no_level_round_trips_without_inventing_level_i() {
    let hand = parse(NO_LEVEL);
    let tour = hand.tournament.as_ref().expect("a tournament");
    assert_eq!(tour.level_label, None);
    assert_eq!(tour.level_number, None);
    assert_eq!(tour.level_small_blind, 25);
    assert_eq!(to_standard_text(&hand), NO_LEVEL);
    assert!(!to_standard_text(&hand).contains("Level"));
}

#[test]
fn matches_the_game_label_from_the_end_not_the_first_keyword() {
    let wsop = NO_LEVEL.replace(
        "Tournament (Banzai Bounty)#85614762, €0.93+€0.07 Hold'em No Limit - (25/50)",
        "Tournament #25313426, WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10 (25/50)",
    );
    let hand = parse(&wsop);
    assert_eq!(hand.game.label, "Hold'em No Limit");
    assert_eq!(
        hand.tournament.as_ref().and_then(|t| t.name.as_deref()),
        Some("WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD")
    );
    assert_eq!(to_standard_text(&hand), wsop);
}

#[test]
fn still_reads_labels_that_do_not_end_in_a_limit_phrase() {
    let split = NO_LEVEL.replace(
        "€0.93+€0.07 Hold'em No Limit",
        "€0.93+€0.07 Hold'em Pot Limit Pre-Flop, No Limit Post-Flop",
    );
    assert_eq!(
        parse(&split).game.label,
        "Hold'em Pot Limit Pre-Flop, No Limit Post-Flop"
    );
}

/* -------------------------------------------------------- phfMoney.test.ts */

const PKO: &str = "Poker Hand #PKO1: Tournament (Bounty Builder)#123456, $4.50+$4.50+$1 Hold'em No Limit - Level V (100/200) - 2026/02/10 17:01:27
Table '123456 3' 6-max Seat #2 is the button
Seat 1: Hero (5000 in chips)
Seat 2: Villain (5000 in chips)
Hero: posts small blind 100
Villain: posts big blind 200
*** HOLE CARDS ***
Dealt to Hero [As Kd]
Hero: raises 400 to 600
Villain: folds
Uncalled bet (400) returned to Hero
*** SHOWDOWN ***
Hero collected 400 from pot
*** SUMMARY ***
Total pot 400 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0
Seat 1: Hero (button) (small blind) collected (400)
Seat 2: Villain (big blind) folded before Flop";

#[test]
fn keeps_the_bounty_portion_instead_of_folding_it_into_the_buy_in() {
    let hand = parse(PKO);
    assert!(validate_hand(&hand).expect("no throw").ok());
    let tour = hand.tournament.as_ref().expect("a tournament");
    assert_eq!(tour.id, "123456");
    assert_eq!(tour.name.as_deref(), Some("Bounty Builder"));
    assert_eq!((tour.buy_in, tour.bounty, tour.fee), (450, Some(450), 100));
    assert_eq!(total_buy_in(tour), 1000);
    // The buy-in is real money even though the stacks are chips.
    assert_eq!(tour.buy_in_unit, USD);
    assert_eq!(hand.game.unit, CHIPS);
}

#[test]
fn round_trips_the_three_part_buy_in_through_standard_text() {
    let hand = parse(PKO);
    assert_eq!(to_standard_text(&hand), PKO);
    assert!(to_standard_text(&hand).contains("$4.50+$4.50+$1 Hold'em No Limit"));
}

#[test]
fn still_prints_a_two_part_buy_in_when_there_is_no_bounty() {
    let plain = PKO.replace("$4.50+$4.50+$1", "$15+$1.50");
    let hand = parse(&plain);
    assert_eq!(hand.tournament.as_ref().and_then(|t| t.bounty), Some(0));
    assert_eq!(to_standard_text(&hand), plain);
}

/* -------------------------------------------------------- phfOmaha.test.ts */

const BASE_HAND: &str =
    "Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
Table 'NLHPurple70' 6-max Seat #1 is the button
Seat 1: 8c668f2d ($81.22 in chips)
Seat 2: da2a0a00 ($11.75 in chips)
Seat 3: 41ff0a42 ($50.99 in chips)
Seat 4: Hero ($82.8 in chips)
Seat 5: a28e4f77 ($34.98 in chips)
Seat 6: fb779d10 ($11.68 in chips)
da2a0a00: posts small blind $0.25
41ff0a42: posts big blind $0.5
*** HOLE CARDS ***
Dealt to Hero [5s 8c]
Hero: folds
a28e4f77: folds
fb779d10: raises $0.5 to $1
8c668f2d: folds
da2a0a00: calls $0.75
41ff0a42: calls $0.5
*** FLOP *** [Tc 4h Ad]
da2a0a00: checks
41ff0a42: checks
fb779d10: bets $1.5
da2a0a00: folds
41ff0a42: folds
Uncalled bet ($1.5) returned to fb779d10
*** SHOWDOWN ***
fb779d10 collected $2.85 from pot
*** SUMMARY ***
Total pot $3 | Rake $0.15 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Tc 4h Ad]
Seat 6: fb779d10 won ($2.85)";

/// `omahaText(label, heroCards)`: one real Hold'em hand relabelled.
fn omaha_text(label: &str, hero_cards: &[&str]) -> String {
    BASE_HAND.replace("Hold'em No Limit", label).replace(
        "Dealt to Hero [5s 8c]",
        &format!("Dealt to Hero [{}]", hero_cards.join(" ")),
    )
}

#[test]
fn sets_the_hi_lo_flag_on_a_hand_read_back_out_of_standard_text() {
    let hand = parse(&omaha_text(
        "Omaha Hi/Lo Pot Limit",
        &["5s", "8c", "2h", "3d"],
    ));
    assert!(hand.game.hi_lo);
    assert_eq!(hand.game.variant, Variant::Omaha);
    // The flag survives a text round trip: both sides read the label.
    assert!(parse(&to_standard_text(&hand)).game.hi_lo);
}

/// `ggFixtures(match)`: `fixtures/samples/ggpoker/` files whose name matches.
fn gg_fixtures(pattern: &str) -> Vec<(String, String)> {
    let re = js_regex(pattern, "i");
    text_files(&root().join("fixtures/samples/ggpoker"), |name| {
        re.is_match(name)
    })
}

#[test]
fn reads_the_variant_and_the_limit_off_the_label() {
    let files = gg_fixtures("plo|omaha|shortdeck");
    assert!(files.len() > 10);
    let mut seen: Vec<String> = Vec::new();
    for (_, text) in &files {
        for chunk in split_standard_hands(text) {
            let hand = parse(&chunk);
            let key = format!(
                "{} -> {}/{}",
                hand.game.label,
                hand.game.variant.as_str(),
                match hand.game.limit {
                    LimitType::Nl => "nl",
                    LimitType::Pl => "pl",
                    LimitType::Fl => "fl",
                }
            );
            if !seen.contains(&key) {
                seen.push(key);
            }
        }
    }
    seen.sort();
    assert_eq!(
        seen,
        [
            "Omaha (NL postflop) -> omaha/nl",
            "Omaha No Limit -> omaha/nl",
            "Omaha Pot Limit -> omaha/pl",
            "PLO -> omaha/pl",
            "PLO-5 -> omaha5/pl",
            "ShortDeck No Limit -> shortdeck/nl",
        ]
    );
}

#[test]
fn deals_the_right_number_of_cards_to_every_seat_that_showed_them() {
    for (name, text) in gg_fixtures("plo|omaha|shortdeck") {
        for chunk in split_standard_hands(&text) {
            let hand = parse(&chunk);
            let expected = hole_card_count(hand.game.variant).expect("a deal size");
            for player in &hand.players {
                assert!(
                    usize::try_from(expected).is_ok_and(|n| player.hole_cards.len() <= n),
                    "{name} {}",
                    player.name
                );
            }
        }
    }
}

#[test]
fn re_serializes_a_five_card_hand_byte_for_byte() {
    for (name, text) in gg_fixtures("plo5|plo-6max|shortdeck") {
        for chunk in split_standard_hands(&text) {
            let out = round_trip(&chunk);
            for line in out.split('\n') {
                if line.starts_with("Dealt to ") && line.contains('[') {
                    assert!(chunk.contains(line), "{name}: {line}");
                }
            }
        }
    }
    let plo5 = gg_fixtures("plo5");
    let (name, text) = plo5.first().expect("a PLO-5 fixture");
    for chunk in split_standard_hands(text) {
        assert_eq!(round_trip(&chunk), chunk, "{name}");
    }
}

#[test]
fn survives_parse_serialize_parse_with_the_same_hand_in_it() {
    for (name, text) in gg_fixtures("plo5|plo-6max") {
        for chunk in split_standard_hands(&text) {
            let first = parse(&chunk);
            let second = parse(&to_standard_text(&first));
            assert_eq!(second.game, first.game, "{name}");
            let hole = |hand: &PhfHand| -> Vec<Vec<String>> {
                hand.players.iter().map(|p| p.hole_cards.clone()).collect()
            };
            assert_eq!(hole(&second), hole(&first), "{name}");
            assert_eq!(second.board, first.board, "{name}");
        }
    }
}

#[test]
fn writes_a_six_card_hand_the_reader_gets_back_unchanged() {
    let six = ["Ah", "Kd", "Qc", "Js", "Th", "9d"];
    let hand = parse(&omaha_text("PLO-6", &six));
    let text = to_standard_text(&hand);
    assert!(text.contains(&format!("Dealt to Hero [{}]", six.join(" "))));
    let hero = parse(&text).players.into_iter().find(|p| p.is_hero);
    assert_eq!(hero.map(|p| p.hole_cards), Some(cards(&six)));
}

/* ------------------------------------------------------------ the parser */

#[test]
fn the_standard_parser_reads_its_own_file_through_the_pipeline() {
    let options = crate::detect::ConvertOptions {
        source_filename: Some("mine.txt".to_owned()),
        ..crate::detect::ConvertOptions::default()
    };
    let file = format!("{STP}\n\n{PKO}\n\nnot a hand\n\n{BARE_STRADDLE}");
    let result = crate::convert_any(&file, &options).expect("no throw");
    assert_eq!(result.stats.total, 3);
    assert_eq!(result.stats.converted, 3);
    assert_eq!(
        result
            .hands
            .iter()
            .map(|h| (
                h.hand.meta.parser_id.as_str(),
                h.hand.meta.site_name.as_str()
            ))
            .collect::<Vec<_>>(),
        [("standard", "Rail standard"); 3]
    );
    assert_eq!(
        result.hands[0].hand.meta.original_filename.as_deref(),
        Some("mine.txt")
    );
    let texts: Vec<PhfHand> = result.hands.iter().map(|h| h.hand.clone()).collect();
    assert_eq!(
        to_standard_text_file(&texts),
        format!("{STP}\n\n{PKO}\n\n{BARE_STRADDLE}")
    );
    // A file of standard text, read whole.
    let all = parse_standard_text(&file, &StandardContext::default()).expect("no throw");
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].meta.site_name, "Rail standard");
}
