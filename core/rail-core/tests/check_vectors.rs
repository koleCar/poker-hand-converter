//! Positions, validation and hi/lo halves on hands the corpus does not have
//! (docs/RAIL-PLAN.md R0.5b), from `tests/data/check-vectors.json` - written
//! by `check-vectors.mjs` next to it, which runs the TypeScript:
//!
//! - **The TypeScript unit tests, translated**: `phfValidate`, the
//!   `assignPositions` half of `phfPositions`, the validator tests of
//!   `phfCoreGaps`, `phfHiLo` and `shortDeck`. They start from the same hands
//!   the TypeScript tests build (`fixtures`: standard-format texts read out of
//!   the test files, and corpus hands as the TypeScript converted them) and
//!   make the same edits and assertions.
//! - **The validate-stage refusals** of the corpus, from the hand as it was
//!   just before validation: the Rust report must be the TypeScript's, and
//!   its first error the golden refusal's reason, with the golden's message.
//! - **Mutations**: seeded random edits of a sample of golden hands, each
//!   replayed here and held to what the TypeScript made of it - positions,
//!   every validation problem (code, message, severity, context), the hi/lo
//!   halves and warnings, or the exception thrown.
//!
//! Self-contained: needs no `testdata/golden-full/`.

mod golden;

use std::sync::LazyLock;

use rail_core::phf::hilo::assign_hi_lo_halves;
use rail_core::phf::{
    ActionType, PhfHand, PhfRunout, PotHalf, Variant, has_dead_button, house_into_pot,
    seat_out_of_pot,
};
use rail_core::positions::assign_positions;
use rail_core::validate::{ContextValue, ValidationReport, validate_hand};
use serde_json::{Map, Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let text = include_str!("data/check-vectors.json");
    serde_json::from_str(text).expect("check-vectors.json")
});

/// A fixture hand: a TypeScript test's name (`SIMPLE_HAND`), or a corpus
/// hand by `path#handId`.
fn fixture(name: &str) -> PhfHand {
    let body = VECTORS["fixtures"]
        .as_object()
        .and_then(|fixtures| {
            fixtures
                .iter()
                .find(|(key, _)| *key == name || key.ends_with(&format!("#{name}")))
        })
        .map(|(_, body)| body.clone())
        .unwrap_or_else(|| panic!("no fixture {name}"));
    serde_json::from_value(body).expect("a PHF hand")
}

/// The TypeScript fixture with its positions cleared and assigned again by
/// the Rust port, so a position test does not just read back the
/// TypeScript's answer.
fn positioned(name: &str) -> PhfHand {
    let mut hand = fixture(name);
    for player in &mut hand.players {
        player.position = None;
    }
    assign_positions(&mut hand);
    hand
}

fn report(hand: &PhfHand) -> ValidationReport {
    validate_hand(hand).expect("validateHand does not throw here")
}

fn codes(hand: &PhfHand) -> Vec<String> {
    report(hand).errors().map(|p| p.code.clone()).collect()
}

fn positions_of(hand: &PhfHand) -> Vec<(u32, Option<String>)> {
    let mut out: Vec<_> = hand
        .players
        .iter()
        .map(|player| {
            let tag = player
                .position
                .map(|position| match serde_json::to_value(position) {
                    Ok(Value::String(tag)) => tag,
                    other => panic!("not a position tag: {other:?}"),
                });
            (player.seat, tag)
        })
        .collect();
    out.sort_unstable();
    out
}

fn expect_positions(hand: &PhfHand, expected: &[(u32, Option<&str>)]) {
    let mut expected: Vec<(u32, Option<String>)> = expected
        .iter()
        .map(|(seat, position)| (*seat, position.map(str::to_owned)))
        .collect();
    expected.sort_unstable();
    assert_eq!(positions_of(hand), expected);
}

/* ------------------------------------------------------- phfValidate --- */

fn collect_index(hand: &PhfHand) -> usize {
    hand.actions
        .iter()
        .position(|a| a.kind == ActionType::Collect)
        .expect("a collect")
}

#[test]
fn validate_accepts_a_well_formed_hand() {
    let report = report(&fixture("SIMPLE_HAND"));
    assert!(report.ok());
    assert_eq!(report.errors().count(), 0);
}

#[test]
fn validate_flags_a_pot_that_does_not_match_what_the_players_put_in() {
    let mut hand = fixture("SIMPLE_HAND");
    hand.results.total_pot += 500;
    assert!(codes(&hand).contains(&"chip-mismatch".to_owned()));
}

#[test]
fn validate_flags_winnings_that_match_neither_the_pot_nor_the_pot_minus_fees() {
    let mut hand = fixture("SIMPLE_HAND");
    let i = collect_index(&hand);
    hand.actions[i].amount += 111;
    assert!(codes(&hand).contains(&"payout-mismatch".to_owned()));
}

#[test]
fn validate_accepts_both_rake_conventions() {
    // GG deducts the rake from the reported pot; WePlay reports it alongside a
    // pot the winner collects in full.
    let deducted = fixture("SIMPLE_HAND");
    assert!(report(&deducted).ok());

    let mut separate = fixture("SIMPLE_HAND");
    let i = collect_index(&separate);
    separate.actions[i].amount = separate.results.total_pot;
    assert!(!codes(&separate).contains(&"payout-mismatch".to_owned()));
}

#[test]
fn validate_flags_a_stack_going_negative() {
    let mut hand = fixture("SIMPLE_HAND");
    for player in &mut hand.players {
        if player.name == "fb779d10" {
            player.starting_stack = 10;
        }
    }
    assert!(codes(&hand).contains(&"negative-stack".to_owned()));
}

#[test]
fn validate_flags_an_actor_who_is_not_seated() {
    let mut hand = fixture("SIMPLE_HAND");
    hand.actions[0].player = "ghost".to_owned();
    assert!(codes(&hand).contains(&"unseated-actor".to_owned()));
}

#[test]
fn validate_flags_a_duplicated_card() {
    let mut hand = fixture("SIMPLE_HAND");
    for player in &mut hand.players {
        if player.is_hero {
            player.hole_cards = vec!["Tc".to_owned(), "8c".to_owned()];
        }
    }
    assert!(codes(&hand).contains(&"duplicate-card".to_owned()));
}

#[test]
fn validate_does_not_mistake_a_shared_run_it_twice_flop_for_duplicates() {
    let mut hand = fixture("SIMPLE_HAND");
    hand.board.runouts.push(PhfRunout {
        index: 1,
        flop: None,
        turn: Some("2h".to_owned()),
        river: Some("3h".to_owned()),
        marker_labels: Default::default(),
        summary_cards: None,
    });
    assert!(!codes(&hand).contains(&"duplicate-card".to_owned()));
}

#[test]
fn validate_flags_an_illegal_board_size() {
    let mut hand = fixture("SIMPLE_HAND");
    hand.board.runouts[0].flop = Some(vec!["Tc".to_owned(), "4h".to_owned()]);
    assert!(codes(&hand).contains(&"board-size".to_owned()));
}

#[test]
fn validate_flags_a_river_with_no_turn() {
    let mut hand = fixture("SIMPLE_HAND");
    hand.board.runouts[0].river = Some("2c".to_owned());
    assert!(codes(&hand).contains(&"river-without-turn".to_owned()));
}

#[test]
fn validate_flags_an_uncalled_return_larger_than_the_commitment() {
    let mut hand = fixture("SIMPLE_HAND");
    let i = hand
        .actions
        .iter()
        .position(|a| a.kind == ActionType::Uncalled)
        .expect("an uncalled return");
    hand.actions[i].amount = -9999;
    assert!(codes(&hand).contains(&"uncalled-exceeds-commitment".to_owned()));
}

#[test]
fn validate_separates_warnings_from_errors() {
    let mut hand = fixture("SIMPLE_HAND");
    hand.table.button_seat = None;
    let report = report(&hand);
    assert!(report.ok());
    assert!(report.warnings().any(|p| p.code == "missing-button"));
}

/// "the real corpus validates" / "rejects every WePlay hand it cannot vouch
/// for, with a reason": every refusal of a WePlay export carries a code, a
/// message and a fingerprint (the hands it keeps validate, which
/// `golden_checks.rs` shows for every corpus hand).
#[test]
fn every_weplay_refusal_has_a_reason() {
    let mut failures = 0;
    for (path, golden) in golden::goldens() {
        if !path.starts_with("weplay-hh/") {
            continue;
        }
        for refusal in golden["refusals"].as_array().into_iter().flatten() {
            failures += 1;
            let reason = refusal["reason"].as_str().unwrap_or_default();
            assert!(
                !reason.is_empty()
                    && reason
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
                "{path}: {reason:?}"
            );
            assert!(!refusal["message"].as_str().unwrap_or_default().is_empty());
            let fingerprint = refusal["fingerprint"].as_str().unwrap_or_default();
            assert!(fingerprint.len() == 64 && fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }
    assert!(failures > 0);
}

/* ----------------------------------------------------- phfPositions --- */

#[test]
fn positions_resolve_heads_up_the_button_posts_the_small_blind() {
    let hand = positioned("HEADS_UP");
    assert!(report(&hand).ok());
    expect_positions(&hand, &[(4, Some("SB")), (2, Some("BB"))]);
    // Code that needs the button must read table.buttonSeat, not position.
    assert_eq!(hand.table.button_seat, Some(4));
}

#[test]
fn positions_resolve_a_dead_button_from_the_posted_blinds_and_name_no_button() {
    let hand = positioned("DEAD_BUTTON");
    assert!(has_dead_button(&hand, None));
    expect_positions(&hand, &[(4, Some("SB")), (5, Some("BB")), (1, Some("CO"))]);
    assert!(
        positions_of(&hand)
            .iter()
            .all(|(_, p)| p.as_deref() != Some("BTN"))
    );
    assert_eq!(hand.table.button_seat, Some(3));
}

#[test]
fn positions_do_not_call_a_live_button_dead() {
    let hand = positioned("SEATED_NOT_DEALT_IN");
    assert!(!has_dead_button(&hand, None));
    expect_positions(
        &hand,
        &[
            (1, Some("SB")),
            (2, Some("BB")),
            (4, Some("BTN")),
            (3, None),
        ],
    );
}

#[test]
fn positions_ignore_a_seated_player_who_was_never_dealt_in() {
    // Counting seat 3 would turn a three-handed hand into a four-handed one.
    let hand = positioned("SEATED_NOT_DEALT_IN");
    expect_positions(
        &hand,
        &[
            (1, Some("SB")),
            (2, Some("BB")),
            (4, Some("BTN")),
            (3, None),
        ],
    );
}

#[test]
fn positions_fall_back_to_geometry_when_no_blinds_were_posted_at_all() {
    let hand = positioned("BOMB_POT");
    assert!(hand.game.bomb_pot.is_some());
    expect_positions(&hand, &[(1, Some("SB")), (2, Some("BB")), (3, Some("BTN"))]);
}

#[test]
fn positions_fall_back_to_geometry_heads_up_too() {
    let hand = positioned("BOMB_POT_HEADS_UP");
    assert_eq!(hand.players.len(), 2);
    expect_positions(&hand, &[(2, Some("SB")), (1, Some("BB"))]);
}

#[test]
fn positions_are_idempotent() {
    let mut hand = positioned("HEADS_UP");
    let before = positions_of(&hand);
    assign_positions(&mut hand);
    assign_positions(&mut hand);
    assert_eq!(positions_of(&hand), before);
}

/* ------------------------------------------------------- phfCoreGaps --- */

fn bad_beat_drop(from_seat: u32, from_player: &str) -> rail_core::phf::PhfChipMovement {
    serde_json::from_value(json!({
        "kind": "bad-beat-drop",
        "fromSeat": from_seat,
        "fromPlayer": from_player,
        "toPot": false,
        "amount": 2,
        "raw": null,
        "anchor": "before-postings",
    }))
    .expect("a chip movement")
}

#[test]
fn house_chips_balance_a_pot_bigger_than_what_the_players_put_in() {
    // Players contribute $0.10; the house adds $0.50; the winner takes $0.60.
    let hand = fixture("STP");
    assert!(report(&hand).ok());
    assert_eq!(house_into_pot(&hand), 50);
}

#[test]
fn a_jackpot_drop_leaves_the_stack_and_not_the_pot() {
    let mut hand = fixture("STP");
    hand.chip_movements = Some(vec![bad_beat_drop(2, "bravo")]);
    assert_eq!(hand.results.total_pot, 60);
    assert_eq!(house_into_pot(&hand), 0);
    assert_eq!(seat_out_of_pot(&hand, 2), 2);
}

#[test]
fn a_drop_charged_to_an_empty_seat_is_refused() {
    let mut hand = fixture("STP");
    hand.chip_movements = Some(vec![bad_beat_drop(9, "ghost")]);
    assert!(codes(&hand).contains(&"unseated-chip-movement".to_owned()));
}

/* ----------------------------------------------------------- phfHiLo --- */

/// `halves(subject)` of the TypeScript test, after the port has worked the
/// halves out again from scratch.
fn halves(name: &str) -> Vec<(String, i64, Option<PotHalf>)> {
    let mut hand = fixture(name);
    for action in &mut hand.actions {
        action.half = None;
    }
    for winner in &mut hand.results.winners {
        winner.half = None;
    }
    let warnings = assign_hi_lo_halves(&mut hand).expect("readable cards");
    assert_eq!(warnings, []);
    hand.results
        .winners
        .iter()
        .map(|w| (w.player.clone(), w.amount, w.half))
        .collect()
}

fn owned(list: &[(&str, i64, Option<PotHalf>)]) -> Vec<(String, i64, Option<PotHalf>)> {
    list.iter()
        .map(|(player, amount, half)| ((*player).to_owned(), *amount, *half))
        .collect()
}

use PotHalf::{Hi, Lo};

#[test]
fn hi_lo_pays_a_two_way_split_high_and_low() {
    // Full Tilt: `ReydelMundo wins the high pot ($61.55)` / `pupsaa wins the low pot`.
    assert_eq!(
        halves("33730957082"),
        owned(&[("ReydelMundo", 6155, Some(Hi)), ("pupsaa", 6155, Some(Lo))])
    );
}

#[test]
fn hi_lo_quarters_a_tied_low() {
    // Both hold 7-6-5-3-A; Mindster also has the flush.
    assert_eq!(
        halves("109680525613"),
        owned(&[
            ("Mindster", 955, Some(Hi)),
            ("Aphily8", 478, Some(Lo)),
            ("Mindster", 477, Some(Lo)),
        ])
    );
}

#[test]
fn hi_lo_awards_the_whole_pot_high_when_no_low_qualifies() {
    assert_eq!(
        halves("109707013172"),
        owned(&[("HELVER4728", 1706, Some(Hi))])
    );
    // 888 says nothing either way; the cards still do.
    assert_eq!(halves("888-441698247"), owned(&[("selkoe", 808, Some(Hi))]));
}

#[test]
fn hi_lo_splits_a_side_pot_and_the_main_pot_independently() {
    assert_eq!(
        halves("109713978619"),
        owned(&[
            ("Bluf_To_Much", 210_000, Some(Hi)),
            ("LewisFriend", 210_000, Some(Lo)),
            ("Crazy Elior", 263_750, Some(Hi)),
            ("LewisFriend", 263_750, Some(Lo)),
        ])
    );
}

#[test]
fn hi_lo_reads_a_scoop_printed_on_two_lines_as_both_halves() {
    assert_eq!(
        halves("888-441695827"),
        owned(&[("hank1967", 95, Some(Hi)), ("hank1967", 95, Some(Lo))])
    );
}

#[test]
fn hi_lo_leaves_a_pot_nobody_contested_unsplit() {
    assert_eq!(halves("109716666902"), owned(&[("wo_ooly :D", 250, None)]));
}

#[test]
fn hi_lo_does_not_trust_microgaming_s_lowhandwin_flag() {
    assert_eq!(
        halves("MG-5049160112"),
        owned(&[("theweman", 173, Some(Lo)), ("hoop", 173, Some(Hi))])
    );
}

#[test]
fn hi_lo_refuses_a_payout_the_shown_cards_contradict() {
    // Entraction 07 pays the whole pot to a pair of queens while the other
    // shown hand holds 8-7-4-2-A.
    let hand = fixture("ENT-2646515969");
    assert_eq!(codes(&hand), ["hi-lo-payout-contradiction"]);
}

#[test]
fn hi_lo_rejects_a_half_on_a_hand_that_is_not_hi_lo() {
    let mut hand = fixture("109680525613");
    hand.game.hi_lo = false;
    assert!(codes(&hand).contains(&"stray-pot-half".to_owned()));
}

#[test]
fn hi_lo_flags_halves_that_cannot_both_be_half_of_the_same_pot() {
    // Aphily8's low quarter booked as high: $14.32 high against $4.77 low.
    let mut hand = fixture("109680525613");
    let i = hand
        .actions
        .iter()
        .position(|a| a.player == "Aphily8" && a.kind == ActionType::Collect)
        .expect("Aphily8's collect");
    hand.actions[i].half = Some(Hi);
    let report = report(&hand);
    assert!(report.ok());
    assert!(
        report
            .warnings()
            .any(|p| p.code == "hi-lo-halves-unbalanced")
    );
}

#[test]
fn hi_lo_works_the_halves_out_again_and_the_same_way_when_asked_twice() {
    let mut hand = fixture("109713978619");
    let before = hand.clone();
    assert_eq!(assign_hi_lo_halves(&mut hand), Ok(Vec::new()));
    assert_eq!(hand, before);
    assert_eq!(assign_hi_lo_halves(&mut hand), Ok(Vec::new()));
    assert_eq!(hand, before);
}

/* --------------------------------------------------------- shortDeck --- */

#[test]
fn the_validator_holds_a_short_deck_hand_to_the_36_card_deck() {
    let mut hand = fixture("SD27208848");
    for player in &mut hand.players {
        if player.name == "Hero" {
            player.hole_cards = vec!["Tc".to_owned(), "5c".to_owned()];
        }
    }
    assert_eq!(codes(&hand), ["card-not-in-deck"]);
    // The same cards are fine in Hold'em.
    hand.game.variant = Variant::Holdem;
    assert_eq!(codes(&hand), Vec::<String>::new());
}

#[test]
fn gg_s_button_blind_is_the_one_blind_and_names_no_sb_or_bb() {
    // `Seat #2 is the button`; 27925b27 posts the button blind.
    let hand = positioned("SD27208838");
    expect_positions(
        &hand,
        &[
            (1, Some("CO")),
            (2, Some("BTN")),
            (3, Some("UTG")),
            (5, Some("HJ")),
        ],
    );
    // Three-handed behind a button blind: UTG, CO, BTN.
    let hand = positioned("1171217378123557259");
    expect_positions(
        &hand,
        &[(1, Some("UTG")), (4, Some("CO")), (5, Some("BTN"))],
    );
}

#[test]
fn every_short_deck_fixture_is_a_clean_short_deck_hand() {
    for id in [
        "SD27208848",
        "SD27208838",
        "SD27208832",
        "SD27208824",
        "1171217378123557259",
    ] {
        let hand = fixture(id);
        assert_eq!(hand.game.variant, Variant::Shortdeck);
        assert!(report(&hand).ok(), "{id}");
    }
}

/* ------------------------------------------ refusals and mutations --- */

fn problems_json(report: &ValidationReport) -> Value {
    report
        .problems
        .iter()
        .map(|problem| {
            let mut out = Map::new();
            out.insert("code".into(), Value::from(problem.code.as_str()));
            out.insert("message".into(), Value::from(problem.message.as_str()));
            out.insert("severity".into(), Value::from(problem.severity.as_str()));
            if let Some(context) = &problem.context {
                let context: Map<String, Value> = context
                    .iter()
                    .map(|(key, value)| {
                        let value = match value {
                            ContextValue::Text(text) => Value::from(text.as_str()),
                            ContextValue::Integer(n) => Value::from(*n),
                        };
                        (key.clone(), value)
                    })
                    .collect();
                out.insert("context".into(), Value::Object(context));
            }
            Value::Object(out)
        })
        .collect()
}

#[test]
fn the_validate_stage_refusals_are_the_typescript_s() {
    let goldens = golden::goldens();
    let refusals = VECTORS["refusals"].as_array().expect("refusals");
    let in_goldens: usize = goldens
        .iter()
        .flat_map(|(_, g)| g["refusals"].as_array().into_iter().flatten())
        .filter(|r| r["stage"] == "validate")
        .count();
    assert_eq!(
        refusals.len(),
        in_goldens,
        "check-vectors.json is stale: regenerate it with check-vectors.mjs"
    );
    for refusal in refusals {
        let path = refusal["path"].as_str().expect("path");
        let hand: PhfHand = serde_json::from_value(refusal["hand"].clone()).expect("PHF");
        let report = validate_hand(&hand).expect("no throw");
        assert_eq!(problems_json(&report), refusal["problems"], "{path}");
        // The refusal the pipeline makes of it is the golden's.
        let (_, golden) = goldens
            .iter()
            .find(|(p, _)| p == path)
            .expect("the golden of the refused file");
        let expected = golden["refusals"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["index"] == refusal["index"] && r["stage"] == "validate")
            .expect("the golden refusal");
        let first = report.errors().next().expect("an error");
        let message: Vec<&str> = report.errors().map(|p| p.message.as_str()).collect();
        assert_eq!(first.code, expected["reason"].as_str().unwrap_or_default());
        assert_eq!(
            message.join("; "),
            expected["message"].as_str().unwrap_or_default()
        );
    }
}

/// Applies one recorded JSON-pointer edit.
fn apply(hand: &mut Value, op: &Value) {
    let op = op.as_array().expect("an op");
    let kind = op[0].as_str().expect("op kind");
    let pointer = op[1].as_str().expect("pointer");
    let (parent_path, key) = pointer.rsplit_once('/').expect("a pointer");
    let parent = hand
        .pointer_mut(parent_path)
        .unwrap_or_else(|| panic!("no {parent_path}"));
    match (kind, parent) {
        ("set", Value::Array(items)) => {
            let i: usize = key.parse().expect("index");
            items[i] = op[2].clone();
        }
        ("set", Value::Object(map)) => {
            map.insert(key.to_owned(), op[2].clone());
        }
        ("insert", Value::Array(items)) => {
            let i: usize = key.parse().expect("index");
            items.insert(i, op[2].clone());
        }
        ("remove", Value::Array(items)) => {
            let i: usize = key.parse().expect("index");
            items.remove(i);
        }
        ("remove", Value::Object(map)) => {
            map.remove(key);
        }
        (kind, parent) => panic!("cannot {kind} {pointer} in {parent}"),
    }
}

#[test]
fn every_mutation_gets_the_typescript_s_positions_report_and_halves() {
    let bases = VECTORS["bases"].as_array().expect("bases");
    let cases = VECTORS["cases"].as_array().expect("cases");
    let mut failures = Vec::new();
    let (mut thrown, mut errors, mut hi_lo) = (0, 0, 0);
    for (n, case) in cases.iter().enumerate() {
        let base = usize::try_from(case["base"].as_u64().expect("base")).expect("index");
        let mut body = bases[base].clone();
        for op in case["ops"].as_array().expect("ops") {
            apply(&mut body, op);
        }
        let hand: PhfHand = serde_json::from_value(body)
            .unwrap_or_else(|e| panic!("case {n}: not a PHF hand: {e}"));

        let mut positioned = hand.clone();
        assign_positions(&mut positioned);
        let positions: Vec<Value> = positioned
            .players
            .iter()
            .map(|p| serde_json::to_value(p.position).expect("position"))
            .collect();
        if Value::from(positions.clone()) != case["positions"] {
            failures.push(format!(
                "case {n}: positions {positions:?}, TypeScript {}",
                case["positions"]
            ));
        }

        match validate_hand(&positioned) {
            Ok(report) => {
                if !report.ok() {
                    errors += 1;
                }
                let actual = problems_json(&report);
                if case.get("thrown").is_some() || actual != case["problems"] {
                    failures.push(format!(
                        "case {n}: problems {actual}\n    TypeScript {}",
                        case.get("problems").unwrap_or(&case["thrown"])
                    ));
                }
            }
            Err(error) => {
                thrown += 1;
                if case["thrown"] != error.message.as_str() {
                    failures.push(format!(
                        "case {n}: throws {error}, TypeScript {}",
                        case.get("thrown").unwrap_or(&case["problems"])
                    ));
                }
            }
        }

        if hand.game.hi_lo {
            hi_lo += 1;
            let mut halved = hand.clone();
            let expected = &case["hiLo"];
            match assign_hi_lo_halves(&mut halved) {
                Ok(warnings) => {
                    let actual = json!({
                        "warnings": warnings,
                        "halves": halved.actions.iter().map(|a| a.half).collect::<Vec<_>>(),
                        "winners": halved.results.winners,
                    });
                    if actual != *expected {
                        failures.push(format!(
                            "case {n}: hi/lo {actual}\n    TypeScript {expected}"
                        ));
                    }
                }
                Err(error) => {
                    if expected["thrown"] != error.message.as_str() {
                        failures.push(format!(
                            "case {n}: hi/lo throws {error}, TypeScript {expected}"
                        ));
                    }
                }
            }
        } else if case.get("hiLo").is_some() {
            failures.push(format!(
                "case {n}: the TypeScript ran hi/lo, the hand is not hi/lo"
            ));
        }
    }
    println!(
        "{} cases ({errors} with errors, {thrown} throwing, {hi_lo} hi/lo)",
        cases.len()
    );
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures
            .iter()
            .take(15)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(cases.len() > 1000 && errors > 500 && thrown > 0 && hi_lo > 100);
}
