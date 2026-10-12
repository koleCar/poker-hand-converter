//! `assignPositions`, `validateHand` and `assignHiLoHalves` against every
//! golden hand (docs/RAIL-PLAN.md R0.5b, the exit check of R0.5).
//!
//! For each accepted corpus hand - its PHF body from `testdata/golden-full/`,
//! checked against the hash the committed golden pins:
//!
//! 1. **Positions.** Every `position` cleared, [`assign_positions`] must give
//!    back the golden's, seat for seat.
//! 2. **Validation.** [`validate_hand`] must find no error, and exactly the
//!    warnings the golden records (`validateHand(hand).warnings`: code,
//!    context and message, in order). Those are of two origins, and the
//!    report counts both: the validator's own checks, and the parser's
//!    `meta.warnings`, which `validateHand` re-reports last.
//! 3. **Hi/lo halves.** In a hi/lo hand every `half` (on the collects and on
//!    `results.winners`) cleared, [`assign_hi_lo_halves`] must give back the
//!    golden hand exactly; whatever it cannot settle must be among the
//!    hand's `meta.warnings`, which is where the parsers put it.
//! 4. **The SUMMARY oracle** of `tests/test/phfPositions.test.ts`: the
//!    `(small blind)` / `(big blind)` / `(button)` words a room prints in its
//!    summary agree with the positions (hands where a word labels two seats
//!    cannot arbitrate and are skipped).
//!
//! It also counts the refusals at stage `validate` by reason; their
//! pre-validation hands are replayed in `tests/check_vectors.rs`.
//!
//! Needs `testdata/golden-full/` (`cd tests && npm ci && npm run golden:emit`)
//! and fails without it, like `golden_roundtrip.rs`.

mod golden;

use std::collections::BTreeMap;
use std::fs;

use rail_core::canonical::value_to_canonical_json;
use rail_core::eval::{evaluate, short_deck_rule_for, short_deck_table};
use rail_core::phf::hilo::assign_hi_lo_halves;
use rail_core::phf::{ActionType, PhfHand, Position, Variant};
use rail_core::positions::assign_positions;
use rail_core::validate::{ContextValue, ValidationProblem, validate_hand};
use serde_json::{Map, Value};

const MAX_REPORTED: usize = 20;

fn problem_json(problem: &ValidationProblem) -> Value {
    let mut out = Map::new();
    out.insert("code".into(), Value::from(problem.code.as_str()));
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
    out.insert("message".into(), Value::from(problem.message.as_str()));
    Value::Object(out)
}

fn positions(hand: &PhfHand) -> Vec<(u32, Option<Position>)> {
    hand.players
        .iter()
        .map(|player| (player.seat, player.position))
        .collect()
}

/// `positionDisagreements` of `phfPositions.test.ts`.
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

#[derive(Default, Debug)]
struct Tally {
    hands: usize,
    positions_agree: usize,
    validation_agrees: usize,
    validator_warnings: usize,
    parser_warnings: usize,
    hi_lo_hands: usize,
    hi_lo_split: usize,
    hi_lo_agree: usize,
    summary_checked: usize,
    validate_refusals: BTreeMap<String, usize>,
}

#[test]
fn positions_validation_and_halves_agree_with_every_golden_hand() {
    let full_dir = golden::root().join("testdata/golden-full");
    assert!(
        full_dir.is_dir(),
        "testdata/golden-full/ is missing. It holds the PHF bodies this test needs and is \
         gitignored; generate it with\n\n    cd tests && npm ci && npm run golden:emit\n"
    );

    let mut tally = Tally::default();
    let mut failures: Vec<String> = Vec::new();
    let mut fail = |message: String| failures.push(message);

    for (path, committed) in golden::goldens() {
        for refusal in committed["refusals"].as_array().into_iter().flatten() {
            if refusal["stage"] == "validate" {
                let reason = refusal["reason"].as_str().unwrap_or_default().to_owned();
                *tally.validate_refusals.entry(reason).or_default() += 1;
            }
        }
        let Some(expected_hands) = committed["hands"].as_array() else {
            continue;
        };
        if expected_hands.is_empty() {
            continue;
        }
        let file = full_dir.join(format!("{path}.json"));
        let text = fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("read {}: {e} (run `npm run golden:emit`)", file.display()));
        let full: Value = serde_json::from_str(&text).expect("golden-full JSON");

        for (i, expected) in expected_hands.iter().enumerate() {
            let at = format!("{path} hands[{i}]");
            let body = full["hands"][i]["phf"].clone();
            let canonical = value_to_canonical_json(body.clone()).expect("canonical");
            assert_eq!(
                Some(golden::sha256_hex(canonical.as_bytes()).as_str()),
                expected["phf"].as_str(),
                "{at}: testdata/golden-full/ is stale; regenerate it with `npm run golden:emit`"
            );
            let golden_hand: PhfHand = serde_json::from_value(body).expect("a PHF hand");
            tally.hands += 1;

            // 1. Positions.
            let mut hand = golden_hand.clone();
            for player in &mut hand.players {
                player.position = None;
            }
            assign_positions(&mut hand);
            if positions(&hand) == positions(&golden_hand) {
                tally.positions_agree += 1;
            } else {
                fail(format!(
                    "{at}: positions {:?}, golden {:?}",
                    positions(&hand),
                    positions(&golden_hand)
                ));
            }

            // 2. Validation.
            match validate_hand(&golden_hand) {
                Err(thrown) => fail(format!("{at}: validateHand throws {thrown}")),
                Ok(report) => {
                    let errors: Vec<_> = report.errors().map(|p| p.code.clone()).collect();
                    let warnings: Vec<Value> = report.warnings().map(problem_json).collect();
                    let golden_warnings =
                        expected["warnings"].as_array().cloned().unwrap_or_default();
                    if errors.is_empty() && warnings == golden_warnings {
                        tally.validation_agrees += 1;
                        let parser = golden_hand.meta.warnings.len();
                        tally.parser_warnings += parser;
                        tally.validator_warnings += warnings.len() - parser;
                    } else {
                        fail(format!(
                            "{at}: errors {errors:?}; warnings {}\n    golden {}",
                            Value::from(warnings),
                            Value::from(golden_warnings)
                        ));
                    }
                }
            }

            // 3. Hi/lo halves.
            if golden_hand.game.hi_lo {
                tally.hi_lo_hands += 1;
                if golden_hand.actions.iter().any(|a| a.half.is_some()) {
                    tally.hi_lo_split += 1;
                }
                let mut hand = golden_hand.clone();
                for action in &mut hand.actions {
                    action.half = None;
                }
                for winner in &mut hand.results.winners {
                    winner.half = None;
                }
                match assign_hi_lo_halves(&mut hand) {
                    Err(thrown) => fail(format!("{at}: assignHiLoHalves throws {thrown}")),
                    Ok(warnings) => {
                        let unexplained: Vec<_> = warnings
                            .iter()
                            .filter(|w| !golden_hand.meta.warnings.contains(w))
                            .collect();
                        if hand == golden_hand && unexplained.is_empty() {
                            tally.hi_lo_agree += 1;
                        } else {
                            fail(format!(
                                "{at}: halves {:?} / winners {:?}, golden {:?} / {:?}; \
                                 unexplained warnings {unexplained:?}",
                                hand.actions.iter().map(|a| a.half).collect::<Vec<_>>(),
                                hand.results
                                    .winners
                                    .iter()
                                    .map(|w| w.half)
                                    .collect::<Vec<_>>(),
                                golden_hand
                                    .actions
                                    .iter()
                                    .map(|a| a.half)
                                    .collect::<Vec<_>>(),
                                golden_hand
                                    .results
                                    .winners
                                    .iter()
                                    .map(|w| w.half)
                                    .collect::<Vec<_>>(),
                            ));
                        }
                    }
                }
            }

            // 4. The SUMMARY oracle, on the hands the TypeScript runs it on:
            //    the GG reference exports and WePlay.
            if path.starts_with("gg-hh/") || path.starts_with("weplay-hh/") {
                tally.summary_checked += 1;
                for disagreement in position_disagreements(&golden_hand) {
                    fail(format!("{at}: {disagreement}"));
                }
            }
        }
    }

    println!("{tally:#?}");
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(MAX_REPORTED).cloned().collect();
        panic!(
            "{} disagreements over {} golden hands:\n{}{}",
            failures.len(),
            tally.hands,
            shown.join("\n"),
            if failures.len() > MAX_REPORTED {
                format!("\n... and {} more", failures.len() - MAX_REPORTED)
            } else {
                String::new()
            }
        );
    }
    assert!(tally.hands > 0, "the goldens hold no hands");
    assert_eq!(tally.positions_agree, tally.hands);
    assert_eq!(tally.validation_agrees, tally.hands);
    assert_eq!(tally.hi_lo_agree, tally.hi_lo_hands);
    // The corpus must keep exercising what this test is for.
    assert!(tally.hi_lo_split > 0 && tally.summary_checked > 1000);
}

/// The table sizes the SUMMARY oracle covers (`phfPositions.test.ts`:
/// "covers every table size, heads-up included"): heads-up is the case the
/// resolver used to get backwards, so the check is worthless without it.
#[test]
fn the_summary_oracle_covers_every_table_size() {
    let full_dir = golden::root().join("testdata/golden-full");
    let mut sizes: BTreeMap<usize, usize> = BTreeMap::new();
    for (path, committed) in golden::goldens() {
        if !(path.starts_with("gg-hh/") || path.starts_with("weplay-hh/")) {
            continue;
        }
        if committed["hands"].as_array().is_none_or(Vec::is_empty) {
            continue;
        }
        let text = fs::read_to_string(full_dir.join(format!("{path}.json"))).expect("golden-full");
        let full: Value = serde_json::from_str(&text).expect("JSON");
        for hand in full["hands"].as_array().into_iter().flatten() {
            let players = hand["phf"]["players"].as_array().map_or(0, Vec::len);
            *sizes.entry(players).or_default() += 1;
        }
    }
    assert!(sizes.get(&2).copied().unwrap_or(0) > 50, "{sizes:?}");
    assert!(sizes.get(&3).copied().unwrap_or(0) > 50, "{sizes:?}");
    assert_eq!(
        sizes.keys().copied().collect::<Vec<_>>(),
        [2, 3, 4, 5, 6, 7, 8, 9]
    );
}

/// `shortDeck.test.ts`, "agrees with who the fixture says won the first
/// board": GG's fixture-12 hand, scored by the table GG's rule picks, pays
/// the hand that won. And every short-deck hand in the corpus holds only
/// cards of the 36-card deck and validates.
#[test]
fn gg_s_short_deck_payout_is_reproduced_by_gg_s_table() {
    let full_dir = golden::root().join("testdata/golden-full");
    let path =
        "fixtures/samples/ggpoker/12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt";
    let text = fs::read_to_string(full_dir.join(format!("{path}.json"))).expect("golden-full");
    let full: Value = serde_json::from_str(&text).expect("JSON");
    let hand: PhfHand = full["hands"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|h| h["handId"] == "1171217378123557259")
        .map(|h| serde_json::from_value(h["phf"].clone()).expect("PHF"))
        .expect("the fixture-12 hand");
    let table = short_deck_table(short_deck_rule_for(&hand.meta.site_id));
    assert_eq!(table.name.as_str(), "short-deck-straight-over-trips");
    let board = hand.board.runouts[0]
        .summary_cards
        .clone()
        .expect("summary cards");
    assert_eq!(board, ["Tc", "8h", "Ah", "6h", "Jd"]);
    let hole = |name: &str| {
        hand.players
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.hole_cards.clone())
            .expect("player")
    };
    let winner = hand
        .actions
        .iter()
        .find(|a| a.kind == ActionType::Collect && a.runout_index == 0)
        .map(|a| a.player.as_str());
    assert_eq!(winner, Some("951600"));
    let value = |name: &str| {
        let cards: Vec<String> = hole(name)
            .into_iter()
            .chain(board.iter().cloned())
            .collect();
        evaluate(&cards, table).expect("cards")
    };
    assert!(value("951600") > value("1802531"));

    let mut short_deck = 0;
    for (path, committed) in golden::goldens() {
        if committed["hands"].as_array().is_none_or(Vec::is_empty) {
            continue;
        }
        let text = fs::read_to_string(full_dir.join(format!("{path}.json"))).expect("golden-full");
        let full: Value = serde_json::from_str(&text).expect("JSON");
        for body in full["hands"].as_array().into_iter().flatten() {
            if body["phf"]["game"]["variant"] != "shortdeck" {
                continue;
            }
            let hand: PhfHand = serde_json::from_value(body["phf"].clone()).expect("PHF");
            assert_eq!(hand.game.variant, Variant::Shortdeck);
            short_deck += 1;
            assert!(validate_hand(&hand).expect("no throw").ok(), "{path}");
            for player in &hand.players {
                assert!(player.hole_cards.len() <= 2);
                assert!(
                    player
                        .hole_cards
                        .iter()
                        .all(|card| rail_core::phf::card_in_deck(card, Variant::Shortdeck))
                );
            }
        }
    }
    assert_eq!(short_deck, 6, "the corpus has six short-deck hands");
}
