//! `tests/test/equityRange.test.ts`, translated: the range notation, card
//! removal, the agreement with `equity()` for a range of one combo, and
//! determinism. (Its "parses every placeholder range the analysis falls back
//! to" case reads `lib/analysis`, which is not ported; the vectors replay
//! `parseRange` on far more strings.)

#![allow(clippy::unwrap_used)]

use std::collections::BTreeSet;

use rail_core::eval::card_index;
use rail_core::js::JsNumber;
use rail_equity::{
    ClassWeights, Computation, EquityGame, EquityMethod, EquityOptions, EquityRequest, Range,
    RangeEquityRequest, RangeError, WeightedCombo, all_classes, class_combos, equity,
    equity_vs_range, parse_range, range_combos, range_share, strongest_of_range,
};

fn sorted(range: &ClassWeights) -> Vec<String> {
    let mut names: Vec<String> = range.iter().map(|(name, _)| name.to_owned()).collect();
    names.sort();
    names
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|&name| name.to_owned()).collect()
}

fn parsed(text: &str) -> ClassWeights {
    parse_range(text).unwrap()
}

fn codes(list: &[&str]) -> Vec<String> {
    names(list)
}

fn card(code: &str) -> u8 {
    card_index(code).unwrap()
}

fn num(text: &str) -> JsNumber {
    JsNumber::parse(text)
}

fn request(hero: &[&str], range: Range, board: &[&str]) -> RangeEquityRequest {
    RangeEquityRequest {
        hero: codes(hero),
        range,
        board: codes(board),
        dead: Vec::new(),
        options: EquityOptions::default(),
    }
}

/// `|a - b| < 10^-digits / 2` on doubles, through their decimal form.
fn close(a: JsNumber, b: JsNumber, digits: u32) {
    let difference = (a - b).abs();
    let bound = JsNumber::from_i64(5) / JsNumber::parse(&format!("1e{}", digits + 1));
    assert!(
        difference.less_than(bound),
        "{} is not {} to {digits} digits",
        a.to_js_string(),
        b.to_js_string()
    );
}

#[test]
fn has_169_classes_and_1326_combos() {
    assert_eq!(all_classes().len(), 169);
    let combos: usize = all_classes()
        .iter()
        .map(|name| class_combos(name).unwrap().len())
        .sum();
    assert_eq!(combos, 1326);
    assert_eq!(range_share(&parsed("*")).unwrap(), JsNumber::from_i64(1));
}

#[test]
fn reads_pairs_plus_kicker_plus_and_spans() {
    assert_eq!(sorted(&parsed("QQ+")), names(&["AA", "KK", "QQ"]));
    assert_eq!(
        sorted(&parsed("ATs+")),
        names(&["AJs", "AKs", "AQs", "ATs"])
    );
    assert_eq!(sorted(&parsed("77-55")), names(&["55", "66", "77"]));
    assert_eq!(
        sorted(&parsed("T9s-76s")),
        names(&["76s", "87s", "98s", "T9s"])
    );
    assert_eq!(sorted(&parsed("KQ")), names(&["KQo", "KQs"]));
}

#[test]
fn reads_pair_spans_in_either_order() {
    assert_eq!(
        sorted(&parsed("22-JJ")),
        names(&["22", "33", "44", "55", "66", "77", "88", "99", "JJ", "TT"])
    );
    assert_eq!(sorted(&parsed("JJ-22")), sorted(&parsed("22-JJ")));
    assert_eq!(sorted(&parsed("99-QQ")), names(&["99", "JJ", "QQ", "TT"]));
    assert_eq!(parsed("22-99").len(), 8);
}

#[test]
fn reads_kicker_spans_suited_and_offsuit_in_either_order() {
    assert_eq!(
        sorted(&parsed("A5s-A2s")),
        names(&["A2s", "A3s", "A4s", "A5s"])
    );
    assert_eq!(sorted(&parsed("A5s-A4s")), names(&["A4s", "A5s"]));
    assert_eq!(sorted(&parsed("A2s-A5s")), sorted(&parsed("A5s-A2s")));
    assert_eq!(sorted(&parsed("KTo-K8o")), names(&["K8o", "K9o", "KTo"]));
    assert_eq!(
        sorted(&parsed("AQs-A9s")),
        names(&["A9s", "AJs", "AQs", "ATs"])
    );
    assert_eq!(parsed("A2o-ATo").len(), 9);
}

#[test]
fn reads_gap_spans_in_either_order_and_weights_on_spans() {
    assert_eq!(sorted(&parsed("65s-T9s")), sorted(&parsed("T9s-65s")));
    let weighted = parsed("99-QQ:0.5, A5s-A4s:0.25");
    assert_eq!(weighted.get("TT"), Some(num("0.5")));
    assert_eq!(weighted.get("A4s"), Some(num("0.25")));
    assert_eq!(weighted.len(), 6);
}

fn refused(text: &str) -> bool {
    matches!(parse_range(text), Err(RangeError::Input(_)))
}

#[test]
fn refuses_spans_that_are_not_one_shape() {
    assert!(refused("A5s-K2s"));
    assert!(refused("A5s-A2o"));
    assert!(refused("22-A2s"));
    assert!(refused("22-AA:0"));
}

#[test]
fn keeps_the_larger_weight_when_a_class_is_named_twice() {
    let range = parsed("AKs, AK:0.5");
    assert_eq!(range.get("AKs"), Some(JsNumber::from_i64(1)));
    assert_eq!(range.get("AKo"), Some(num("0.5")));
}

#[test]
fn refuses_what_it_cannot_read_rather_than_skipping_it() {
    assert!(refused("AX"));
    assert!(refused("AKs:2"));
    assert!(refused("KAs"));
    assert!(refused("T9s-75s"));
    // Where the TypeScript reads past the end of a token it throws a
    // TypeError, not an EquityInputError.
    assert_eq!(parse_range("A"), Err(RangeError::Type));
    assert_eq!(parse_range("+"), Err(RangeError::Type));
}

#[test]
fn removes_every_combo_that_touches_a_dead_card() {
    let dead = |cards: &[&str]| -> BTreeSet<u8> { cards.iter().map(|&c| card(c)).collect() };
    assert_eq!(
        range_combos(&parsed("AKs"), &dead(&["As"])).unwrap().len(),
        3
    );
    assert_eq!(
        range_combos(&parsed("AA"), &dead(&["As", "Ah"]))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        range_combos(&parsed("72o"), &BTreeSet::new())
            .unwrap()
            .len(),
        12
    );
}

#[test]
fn agrees_exactly_with_equity_for_a_range_of_one_combo() {
    let board = ["Qh", "7h", "2c", "3s"];
    let single = Range::Combos(vec![WeightedCombo {
        cards: [card("Qs"), card("Qd")],
        weight: JsNumber::from_i64(1),
    }]);
    let ours = equity_vs_range(&request(&["Ah", "Kh"], single, &board)).unwrap();
    let mut theirs = EquityRequest::new(
        EquityGame::Holdem,
        vec![codes(&["Ah", "Kh"]), codes(&["Qs", "Qd"])],
    );
    theirs.board = codes(&board);
    let theirs = equity(&theirs).unwrap();
    assert_eq!(ours.method, Computation::Exhaustive);
    close(ours.equity, theirs.equity()[0], 12);
}

#[test]
fn weights_each_combo_by_its_weight_not_by_its_class() {
    let board = ["2c", "7d", "9h", "Kc", "3s"];
    let range = Range::Combos(vec![
        WeightedCombo {
            cards: [card("4h"), card("5h")],
            weight: JsNumber::from_i64(1),
        },
        WeightedCombo {
            cards: [card("Ks"), card("Kd")],
            weight: num("0.25"),
        },
    ]);
    let result = equity_vs_range(&request(&["Ah", "Ad"], range, &board)).unwrap();
    close(result.equity, JsNumber::from_i64(1) / num("1.25"), 12);
    close(result.win, num("0.8"), 12);
    assert_eq!(result.tie, JsNumber::ZERO);
}

#[test]
fn is_exhaustive_on_the_turn_and_sampled_on_the_flop_deterministically() {
    let range = || Range::Classes(parsed("22+, A2s+, KTs+, ATo+, KJo+"));
    assert_eq!(
        equity_vs_range(&request(&["Jh", "Th"], range(), &["9h", "8c", "2d", "Ks"]))
            .unwrap()
            .method,
        Computation::Exhaustive
    );
    let mut seeded = request(&["Jh", "Th"], range(), &["9h", "8c", "2d"]);
    seeded.options.seed = Some(7);
    let a = equity_vs_range(&seeded).unwrap();
    let b = equity_vs_range(&seeded).unwrap();
    assert_eq!(a.method, Computation::MonteCarlo);
    assert_eq!(a, b);
    let mut exhaustive = request(&["Jh", "Th"], range(), &["9h", "8c", "2d"]);
    exhaustive.options.method = EquityMethod::Exhaustive;
    let exact = equity_vs_range(&exhaustive).unwrap();
    assert!((a.equity - exact.equity).abs().less_than(num("0.02")));
}

#[test]
fn applies_card_removal_from_the_heros_hand_and_the_board() {
    let result = equity_vs_range(&request(
        &["As", "Ks"],
        Range::Classes(parsed("AA")),
        &["Ad", "7c", "2h", "9s", "Jd"],
    ))
    .unwrap();
    assert_eq!(result.combos, 1);
    assert_eq!(result.equity, JsNumber::ZERO);
}

#[test]
fn says_so_when_card_removal_empties_the_range() {
    let result = equity_vs_range(&request(
        &["As", "Ah"],
        Range::Classes(parsed("AA")),
        &["Ad", "7c", "2h"],
    ))
    .unwrap();
    assert_eq!(result.combos, 0);
}

#[test]
fn refuses_an_impossible_request() {
    assert!(equity_vs_range(&request(&["As", "As"], Range::Classes(parsed("KK")), &[])).is_err());
    assert!(
        equity_vs_range(&request(
            &["As", "Kd"],
            Range::Classes(parsed("KK")),
            &["2c", "3c"]
        ))
        .is_err()
    );
}

#[test]
fn strongest_of_range_keeps_the_best_hands_ties_at_the_cut_included() {
    let board = codes(&["Kd", "7c", "2s", "9h", "3d"]);
    let range = Range::Classes(parsed("KK, 77, AK, KQ, QJ, T8"));
    let top = strongest_of_range(&range, &board, num("0.05"), &[]).unwrap();
    assert!(top.len() >= 3);
    for combo in &top {
        let ranks = (combo.cards[0] >> 2, combo.cards[1] >> 2);
        assert!(ranks == (11, 11) || ranks == (5, 5), "{ranks:?}");
    }
    let board_refs: Vec<&str> = board.iter().map(String::as_str).collect();
    let whole = equity_vs_range(&request(&["Ah", "Kc"], range.clone(), &board_refs)).unwrap();
    let strongest = Range::Combos(strongest_of_range(&range, &board, num("0.25"), &[]).unwrap());
    let strong = equity_vs_range(&request(&["Ah", "Kc"], strongest, &board_refs)).unwrap();
    assert!(!strong.equity.greater_than(whole.equity));
}
