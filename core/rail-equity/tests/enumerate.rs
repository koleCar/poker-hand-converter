//! `tests/test/equityEnumerate.test.ts`, translated: known answers, exact
//! counts, side pots and the seeded Monte Carlo.
//!
//! Where the TypeScript asserts `toBeCloseTo`, the port asserts the same
//! closeness on the exact rational (`units / denominator`); where it asserts
//! `toBe(7 / 44)`, the double is compared with the double JavaScript computes
//! for `7 / 44`, which is what makes these exact checks.

#![allow(
    clippy::unwrap_used,
    clippy::float_arithmetic,
    clippy::cast_precision_loss
)]

use rail_core::eval::ShortDeckRule;
use rail_core::js::JsNumber;
use rail_equity::{
    Computation, EquityGame, EquityMethod, EquityRequest, EquityResult, equity, plan,
};

fn h(cards: &str) -> Vec<String> {
    cards.split(' ').map(str::to_owned).collect()
}

fn hands(list: &[&str]) -> Vec<Vec<String>> {
    list.iter().map(|cards| h(cards)).collect()
}

fn ratio(a: i64, b: i64) -> JsNumber {
    JsNumber::from_i64(a) / JsNumber::from_i64(b)
}

/// The exact share as an `f64`, for the `toBeCloseTo` checks only.
fn share(result: &EquityResult, pot: usize, player: usize) -> f64 {
    result.units[pot][player] as f64 / result.denominator() as f64
}

fn close(actual: f64, expected: f64, digits: i32) {
    assert!(
        (actual - expected).abs() < 10_f64.powi(-digits) / 2.0,
        "{actual} is not {expected} to {digits} digits"
    );
}

fn holdem(list: &[&str], board: &str) -> EquityRequest {
    let mut request = EquityRequest::new(EquityGame::Holdem, hands(list));
    if !board.is_empty() {
        request.board = h(board);
    }
    request
}

#[test]
fn gives_aa_about_81_9_percent_against_kk_preflop_exactly() {
    let two = equity(&holdem(&["Ah Ad", "Kh Kd"], "")).unwrap();
    let one = equity(&holdem(&["Ah Ad", "Kh Ks"], "")).unwrap();
    let none = equity(&holdem(&["Ah Ad", "Ks Kc"], "")).unwrap();
    assert_eq!(two.method, Computation::Exhaustive);
    assert_eq!(two.boards, 1_712_304);
    let average = (share(&two, 0, 0) + 4.0 * share(&one, 0, 0) + share(&none, 0, 0)) / 6.0;
    close(average, 0.8195, 3);
    assert!(two.equity()[0].greater_than(none.equity()[0]));
    // Exactly 1 as rationals.
    assert_eq!(
        u128::from(two.units[0][0] + two.units[0][1]),
        two.denominator()
    );
}

#[test]
fn gives_aks_about_46_percent_against_qq() {
    let result = equity(&holdem(&["As Ks", "Qh Qd"], "")).unwrap();
    close(share(&result, 0, 0), 0.462, 3);
    close(share(&result, 0, 1), 0.538, 3);
}

#[test]
fn counts_a_flop_spot_exactly() {
    let result = equity(&holdem(&["As Ah", "Ks Kh"], "Ad Kd 2c")).unwrap();
    assert_eq!(result.boards, 990);
    assert_eq!(result.equity()[1], ratio(43, 990));
    assert_eq!(result.equity()[0], ratio(947, 990));
}

#[test]
fn counts_a_turn_spot_exactly() {
    let result = equity(&holdem(&["Ah Kh", "Qs Qd"], "Qh 7h 2c 3s")).unwrap();
    assert_eq!(result.boards, 44);
    assert_eq!(result.equity()[0], ratio(7, 44));
}

#[test]
fn splits_a_chopped_board_evenly() {
    let result = equity(&holdem(&["2c 3d", "2d 3c"], "Ah Kh Qh Jh Th")).unwrap();
    assert_eq!(result.boards, 1);
    assert_eq!(result.equity(), &[ratio(1, 2), ratio(1, 2)]);
}

#[test]
fn takes_dead_cards_out_of_the_deck() {
    let live = equity(&holdem(&["Ah Kh", "Qs Qd"], "Qh 7h 2c 3s")).unwrap();
    let mut request = holdem(&["Ah Kh", "Qs Qd"], "Qh 7h 2c 3s");
    request.dead = h("4h 5h");
    let dead = equity(&request).unwrap();
    assert_eq!(dead.boards, 42);
    assert_eq!(dead.equity()[0], ratio(5, 42));
    assert!(dead.equity()[0].less_than(live.equity()[0]));
}

#[test]
fn enumerates_multiway_preflop_exhaustively_too() {
    let request = holdem(&["As Ks", "Qh Qd", "7c 8c"], "");
    assert_eq!(plan(&request).unwrap().method, Computation::Exhaustive);
    let result = equity(&request).unwrap();
    assert_eq!(result.boards, 1_370_754);
    let units: u64 = result.units[0].iter().sum();
    assert_eq!(u128::from(units), result.denominator());
}

#[test]
fn keeps_the_heads_up_preflop_enumeration_fast() {
    // A smoke alarm, as in the TypeScript (2 s there; this suite runs
    // unoptimised, so the margin is wider).
    let started = std::time::Instant::now();
    equity(&holdem(&["Ac Kd", "7h 7s"], "")).unwrap();
    assert!(started.elapsed().as_secs() < 20);
}

#[test]
fn scores_each_pot_against_its_own_eligible_players_only() {
    let list = ["Ah Ad", "Kh Kd", "Qs Qc"];
    let mut request = holdem(&list, "2c 7d 9h");
    request.pots = Some(vec![vec![0, 1, 2], vec![1, 2]]);
    let result = equity(&request).unwrap();
    let three_way = equity(&holdem(&list, "2c 7d 9h")).unwrap();
    let mut heads_up = holdem(&list[1..], "2c 7d 9h");
    heads_up.dead = h(list[0]);
    let heads_up = equity(&heads_up).unwrap();

    assert_eq!(result.pots[0], three_way.equity());
    assert_eq!(result.pots[1][0], JsNumber::ZERO);
    assert_eq!(result.pots[1][1], heads_up.equity()[0]);
    assert_eq!(result.pots[1][2], heads_up.equity()[1]);
}

#[test]
fn enumerates_the_36_card_deck() {
    let result = equity(&EquityRequest::new(
        EquityGame::Shortdeck,
        hands(&["Ah Ad", "Kh Kd"]),
    ))
    .unwrap();
    assert_eq!(result.boards, 201_376);
    assert!(share(&result, 0, 0) > 0.7);
    assert!(share(&result, 0, 0) < 0.8);
}

#[test]
fn refuses_a_card_the_short_deck_does_not_hold() {
    let error = equity(&EquityRequest::new(
        EquityGame::Shortdeck,
        hands(&["Ah Ad", "Kh 5d"]),
    ))
    .unwrap_err();
    assert_eq!(error.message(), "5d is not in the 36-card deck");
}

#[test]
fn counts_a_plo_turn_spot_exactly() {
    let mut request = EquityRequest::new(EquityGame::Omaha, hands(&["Ah Kh 4c 5d", "Ks Kd 8s 8d"]));
    request.board = h("Kc 7h 2h 9c");
    let result = equity(&request).unwrap();
    assert_eq!(result.boards, 40);
    assert_eq!(result.equity()[0], ratio(8, 40));
}

#[test]
fn enumerates_a_plo_flop_and_samples_plo_preflop_with_a_fixed_seed() {
    let mut flop = EquityRequest::new(EquityGame::Omaha, hands(&["As Ks Qh Jh", "Ad Ac 7c 8d"]));
    flop.board = h("Th 9h 2c");
    let flop = equity(&flop).unwrap();
    assert_eq!(flop.method, Computation::Exhaustive);
    assert_eq!(flop.boards, 820);

    let request = EquityRequest::new(EquityGame::Omaha, hands(&["As Ks Qh Jh", "Ad Ac 7c 8d"]));
    let sampled = equity(&request).unwrap();
    assert_eq!(sampled.method, Computation::MonteCarlo);
    assert_eq!(equity(&request).unwrap(), sampled);
    let mut other_seed = request.clone();
    other_seed.options.seed = Some(99);
    assert_ne!(equity(&other_seed).unwrap().pots, sampled.pots);

    // The exhaustive answer (1,086,008 boards, 130M evaluations) is the
    // TypeScript's ~1.5 s check; unoptimised here it would take minutes, so
    // the count is checked through `plan` and the closeness in the
    // `OMAHA_EXHAUSTIVE=1` run below.
    let mut exhaustive = request.clone();
    exhaustive.options.method = EquityMethod::Exhaustive;
    assert_eq!(plan(&exhaustive).unwrap().boards, 1_086_008);
    if std::env::var_os("OMAHA_EXHAUSTIVE").is_some() {
        let exact = equity(&exhaustive).unwrap();
        assert_eq!(exact.boards, 1_086_008);
        assert!((share(&sampled, 0, 0) - share(&exact, 0, 0)).abs() < 0.015);
    }
}

#[test]
fn samples_holdem_to_within_tolerance_of_the_exact_answer() {
    let request = holdem(&["As Ks", "Qh Qd", "7c 8c"], "");
    let exact = equity(&request).unwrap();
    let mut sampled = request.clone();
    sampled.options.method = EquityMethod::MonteCarlo;
    sampled.options.trials = Some(50_000);
    let sampled = equity(&sampled).unwrap();
    for i in 0..3 {
        assert!((share(&sampled, 0, i) - share(&exact, 0, i)).abs() < 0.01);
    }
}

#[test]
fn evaluates_plo5() {
    let mut request = EquityRequest::new(
        EquityGame::Omaha5,
        hands(&["As Ks Qh Jh 3c", "Ad Ac 7c 8d 4s"]),
    );
    request.board = h("Th 9h 2c");
    let result = equity(&request).unwrap();
    assert_eq!(result.boards, 741);
    assert_eq!(
        u128::from(result.units[0][0] + result.units[0][1]),
        result.denominator()
    );
}

#[test]
fn refuses_duplicate_cards_wrong_hole_card_counts_and_half_dealt_boards() {
    let message = |request: EquityRequest| equity(&request).unwrap_err().0;
    assert_eq!(message(holdem(&["Ah Ad", "Ah Kd"], "")), "Ah appears twice");
    assert_eq!(
        message(EquityRequest::new(
            EquityGame::Omaha,
            hands(&["Ah Ad", "Kh Kd"])
        )),
        "player 0 has 2 hole cards, omaha deals 4"
    );
    assert_eq!(
        message(holdem(&["Ah Ad", "Kh Kd"], "2c 3c")),
        "a board of 2 cards is not a street"
    );
    assert_eq!(message(holdem(&["Ah Ad", "Kh Xx"], "")), "not a card: Xx");
}

/* ------------------------------------------- shortDeck.test.ts, equity - */

#[test]
fn short_deck_rule_decides_trips_against_a_straight() {
    // `shortDeck.test.ts` "changes a turn equity by exactly the jacks":
    // the request of that test, both rules.
    let mut request = EquityRequest::new(EquityGame::Shortdeck, hands(&["Ks Qs", "Td Ts"]));
    request.board = h("Tc 8h Ah 6h");
    let mut gg = request.clone();
    gg.short_deck_rule = Some(ShortDeckRule::StraightOverTrips);
    let gg = equity(&gg).unwrap();
    assert_eq!(gg.boards, 28);
    assert_eq!(gg.units[0][0], 4 * 27_720);
    assert_eq!(
        equity(&request).unwrap().equity(),
        &[JsNumber::ZERO, JsNumber::from_i64(1)]
    );
}
