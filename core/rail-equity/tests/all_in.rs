//! `tests/test/equityAllInEv.test.ts`, translated (all-in EV on hand-written
//! hands, parsed by `parse_standard_hand` as the TypeScript parses them), and
//! the `analyzeAllIn` checks of `shortDeck.test.ts` and `phfHiLo.test.ts`
//! that R2.1 left for this step.

#![allow(
    clippy::unwrap_used,
    clippy::float_arithmetic,
    clippy::cast_precision_loss
)]

mod support;

use std::collections::BTreeMap;

use rail_core::js::JsNumber;
use rail_core::phf::serialize::{StandardContext, parse_standard_hand};
use rail_core::phf::{PhfHand, Street, Variant};
use rail_equity::{
    AllInEv, AllInEvOutcome, AllInSkipReason, Computation, EV_VERSION, EquityGame, EquityOptions,
    EquityRequest, all_in_ev, analyze_all_in, equity, ev_net_by_seat,
};
use rail_stats::{STATS_VERSION, hand_facts};
use serde_json::{Value, json};
use support::corpus;

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};
const FEES: &str = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";

fn parse(text: &str) -> PhfHand {
    let text = text.replace("${FEES}", FEES);
    parse_standard_hand(text.trim(), &CTX)
        .expect("parses")
        .expect("a hand")
}

fn defaults() -> EquityOptions {
    EquityOptions::default()
}

fn ev_of(hand: &PhfHand) -> AllInEv {
    all_in_ev(hand, &defaults()).expect("expected EV")
}

/// `net` per seat, from the stats engine.
fn net_by_seat(hand: &PhfHand) -> BTreeMap<u32, i64> {
    hand_facts(hand)
        .seats
        .iter()
        .map(|seat| (seat.seat, seat.money.net))
        .collect()
}

fn cards(list: &[&str]) -> Vec<Vec<String>> {
    list.iter()
        .map(|hand| hand.split(' ').map(str::to_owned).collect())
        .collect()
}

fn ratio(a: i64, b: i64) -> JsNumber {
    JsNumber::from_i64(a) / JsNumber::from_i64(b)
}

/* ------------------------------------------------------------ fixtures - */

const PREFLOP: &str = "
Poker Hand #EV1: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Sb [Ah Ad]
Btn: folds
Sb: raises $99 to $100 and is all-in
Bb: calls $99 and is all-in
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [Kc]
*** RIVER *** [2c 7d 9h Kc] [3s]
*** SHOWDOWN ***
Sb: shows [Ah Ad] (a pair of Aces)
Bb: shows [Kh Kd] (three of a kind, Kings)
Bb collected $200 from pot
*** SUMMARY ***
Total pot $200 ${FEES}
Board [2c 7d 9h Kc 3s]
Seat 1: Btn (button) folded before Flop (didn't bet)
Seat 2: Sb (small blind) showed [Ah Ad] and lost with a pair of Aces
Seat 3: Bb (big blind) showed [Kh Kd] and won ($200) with three of a kind, Kings
";

const TURN: &str = "
Poker Hand #EV2: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($50 in chips)
Seat 2: Sb ($50 in chips)
Seat 3: Bb ($50 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Kh]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Qh 7h 2c]
Bb: checks
Btn: bets $5
Bb: calls $5
*** TURN *** [Qh 7h 2c] [3s]
Bb: bets $42 and is all-in
Btn: calls $42 and is all-in
*** RIVER *** [Qh 7h 2c 3s] [4h]
*** SHOWDOWN ***
Bb: shows [Qs Qd] (three of a kind, Queens)
Btn: shows [Ah Kh] (a flush, Ace high)
Btn collected $97.5 from pot
*** SUMMARY ***
Total pot $100.5 | Rake $3 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Qh 7h 2c 3s 4h]
Seat 1: Btn (button) showed [Ah Kh] and won ($97.5) with a flush, Ace high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Qs Qd] and lost with three of a kind, Queens
";

const SIDE_POT: &str = "
Poker Hand #EV3: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($20 in chips)
Seat 2: Sb ($50 in chips)
Seat 3: Bb ($100 in chips)
Seat 4: Utg ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Ad]
Utg: raises $2 to $3
Btn: raises $17 to $20 and is all-in
Sb: raises $30 to $50 and is all-in
Bb: calls $49
Utg: folds
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [4s]
*** RIVER *** [2c 7d 9h 4s] [3c]
*** SHOWDOWN ***
Btn: shows [Ah Ad] (a pair of Aces)
Sb: shows [Kh Kd] (a pair of Kings)
Bb: shows [Qs Qc] (a pair of Queens)
Sb collected $60 from side pot
Btn collected $63 from main pot
*** SUMMARY ***
Total pot $123 Main pot $63. Side pot $60. ${FEES}
Board [2c 7d 9h 4s 3c]
Seat 1: Btn (button) showed [Ah Ad] and won ($63) with a pair of Aces
Seat 2: Sb (small blind) showed [Kh Kd] and won ($60) with a pair of Kings
Seat 3: Bb (big blind) showed [Qs Qc] and lost with a pair of Queens
Seat 4: Utg folded before Flop
";

const MUCKED: &str = "
Poker Hand #EV4: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Sb [Ah Ad]
Btn: folds
Sb: raises $99 to $100 and is all-in
Bb: calls $99 and is all-in
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [Qc]
*** RIVER *** [2c 7d 9h Qc] [3s]
*** SHOWDOWN ***
Sb: shows [Ah Ad] (a pair of Aces)
Bb: mucks hand
Sb collected $200 from pot
*** SUMMARY ***
Total pot $200 ${FEES}
Board [2c 7d 9h Qc 3s]
Seat 1: Btn (button) folded before Flop (didn't bet)
Seat 2: Sb (small blind) showed [Ah Ad] and won ($200) with a pair of Aces
Seat 3: Bb (big blind) mucked
";

const RIVER: &str = "
Poker Hand #EV5: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($10 in chips)
Seat 2: Sb ($10 in chips)
Seat 3: Bb ($10 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Kh]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Qh 7h 2c]
Bb: checks
Btn: checks
*** TURN *** [Qh 7h 2c] [3s]
Bb: checks
Btn: checks
*** RIVER *** [Qh 7h 2c 3s] [4h]
Bb: bets $7 and is all-in
Btn: calls $7 and is all-in
*** SHOWDOWN ***
Bb: shows [Qs Qd] (three of a kind, Queens)
Btn: shows [Ah Kh] (a flush, Ace high)
Btn collected $20.5 from pot
*** SUMMARY ***
Total pot $20.5 ${FEES}
Board [Qh 7h 2c 3s 4h]
Seat 1: Btn (button) showed [Ah Kh] and won ($20.5) with a flush, Ace high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Qs Qd] and lost with three of a kind, Queens
";

const NO_ALL_IN: &str = "
Poker Hand #EV6: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Qd]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [2c 7d 9h]
Bb: checks
Btn: bets $4
Bb: folds
Uncalled bet ($4) returned to Btn
Btn collected $6.5 from pot
*** SUMMARY ***
Total pot $6.5 ${FEES}
Board [2c 7d 9h]
Seat 1: Btn (button) collected ($6.5)
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) folded on the Flop
";

const OVERBET: &str = "
Poker Hand #EV7: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($60 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Sb [As Ks]
Btn: folds
Sb: raises $99 to $100 and is all-in
Bb: calls $59 and is all-in
Uncalled bet ($40) returned to Sb
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [4s]
*** RIVER *** [2c 7d 9h 4s] [3c]
*** SHOWDOWN ***
Sb: shows [As Ks] (high card Ace)
Bb: shows [Qh Qd] (a pair of Queens)
Bb collected $120 from pot
*** SUMMARY ***
Total pot $120 ${FEES}
Board [2c 7d 9h 4s 3c]
Seat 1: Btn (button) folded before Flop (didn't bet)
Seat 2: Sb (small blind) showed [As Ks] and lost with high card Ace
Seat 3: Bb (big blind) showed [Qh Qd] and won ($120) with a pair of Queens
";

const DRAWING_DEAD: &str = "
Poker Hand #EV8: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($50 in chips)
Seat 2: Sb ($50 in chips)
Seat 3: Bb ($50 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Ad]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [As Ac 7s]
Bb: checks
Btn: checks
*** TURN *** [As Ac 7s] [2c]
Bb: bets $47 and is all-in
Btn: calls $47 and is all-in
*** RIVER *** [As Ac 7s 2c] [9d]
*** SHOWDOWN ***
Bb: shows [Kh Kd] (two pair, Aces and Kings)
Btn: shows [Ah Ad] (four of a kind, Aces)
Btn collected $97.5 from pot
*** SUMMARY ***
Total pot $100.5 | Rake $3 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [As Ac 7s 2c 9d]
Seat 1: Btn (button) showed [Ah Ad] and won ($97.5) with four of a kind, Aces
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Kh Kd] and lost with two pair, Aces and Kings
";

const OMAHA: &str = "
Poker Hand #EV9: Omaha Pot Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($20 in chips)
Seat 2: Sb ($20 in chips)
Seat 3: Bb ($20 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [As Ks Qh Jh]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Th 9h 2c]
Bb: bets $6
Btn: raises $11 to $17 and is all-in
Bb: calls $11 and is all-in
*** TURN *** [Th 9h 2c] [3d]
*** RIVER *** [Th 9h 2c 3d] [4s]
*** SHOWDOWN ***
Bb: shows [Ad Ac 7c 8d] (a pair of Aces)
Btn: shows [As Ks Qh Jh] (a straight, King high)
Btn collected $40.5 from pot
*** SUMMARY ***
Total pot $40.5 ${FEES}
Board [Th 9h 2c 3d 4s]
Seat 1: Btn (button) showed [As Ks Qh Jh] and won ($40.5) with a straight, King high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Ad Ac 7c 8d] and lost with a pair of Aces
";

/* ------------------------------------------------- when it applies - */

#[test]
fn splits_a_heads_up_preflop_all_in_by_equity() {
    let hand = parse(PREFLOP);
    let ev = ev_of(&hand);
    assert_eq!(ev.ev_version, "ev/1");
    assert_eq!(EV_VERSION, "ev/1");
    assert_ne!(EV_VERSION, STATS_VERSION);
    assert_eq!(ev.street, Street::Preflop);
    assert!(ev.board.is_empty());
    assert_eq!(ev.method, Computation::Exhaustive);
    assert_eq!(ev.pots.len(), 1);
    assert_eq!(ev.pots[0].amount, 20000);
    assert_eq!(ev.pots[0].eligible_seats, vec![2, 3]);

    // AhAd vs KhKd is 82.637% / 17.363%: 16527.32 and 3472.68 of 20000.
    let reference = equity(&EquityRequest::new(
        EquityGame::Holdem,
        cards(&["Ah Ad", "Kh Kd"]),
    ))
    .unwrap();
    let aces = reference.units[0][0] as f64 / reference.denominator() as f64;
    assert!((aces * 20000.0 - 16527.32).abs() < 0.005);
    assert_eq!(ev.pots[0].shares, vec![16527, 3473]);

    assert_eq!(
        ev_net_by_seat(&hand, &defaults()),
        Some(BTreeMap::from([(1, 0), (2, 6527), (3, -6527)]))
    );
    let net = net_by_seat(&hand);
    assert_eq!(net[&2], -10000);
    assert_eq!(net[&3], 10000);
}

#[test]
fn takes_a_turn_all_in_from_the_turn_and_splits_the_pot_after_rake() {
    let hand = parse(TURN);
    let ev = ev_of(&hand);
    assert_eq!(ev.street, Street::Turn);
    assert_eq!(ev.board, vec!["Qh", "7h", "2c", "3s"]);
    assert_eq!(ev.boards, 44);
    assert_eq!(ev.pots[0].gross, 10050);
    assert_eq!(ev.pots[0].amount, 9750);
    assert_eq!(ev.pots[0].equity, vec![ratio(7, 44), ratio(37, 44)]);
    assert_eq!(ev.pots[0].shares, vec![1551, 8199]);

    let ev_net = ev_net_by_seat(&hand, &defaults()).unwrap();
    assert_eq!(ev_net[&1], 1551 - 5000);
    assert_eq!(ev_net[&3], 8199 - 5000);
    assert_eq!(ev_net[&2], -50);
    assert_eq!(ev_net.values().sum::<i64>(), -300);
    assert_eq!(net_by_seat(&hand).values().sum::<i64>(), -300);
}

#[test]
fn builds_a_side_pot_and_keeps_the_folded_raiser_out_of_everyones_eligibility() {
    let hand = parse(SIDE_POT);
    let ev = ev_of(&hand);
    assert_eq!(ev.street, Street::Preflop);
    assert_eq!(
        ev.pots.iter().map(|pot| pot.amount).collect::<Vec<_>>(),
        vec![6300, 6000]
    );
    assert_eq!(
        ev.pots
            .iter()
            .map(|pot| pot.eligible_seats.clone())
            .collect::<Vec<_>>(),
        vec![vec![1, 2, 3], vec![2, 3]]
    );

    let hands = cards(&["Ah Ad", "Kh Kd", "Qs Qc"]);
    let mut request = EquityRequest::new(EquityGame::Holdem, hands.clone());
    request.pots = Some(vec![vec![0, 1, 2], vec![1, 2]]);
    let reference = equity(&request).unwrap();
    assert_eq!(ev.pots[0].equity, reference.pots[0]);
    assert_eq!(
        ev.pots[1].equity,
        vec![reference.pots[1][1], reference.pots[1][2]]
    );
    let mut side = EquityRequest::new(EquityGame::Holdem, hands[1..].to_vec());
    side.dead = hands[0].clone();
    let side_kings = equity(&side).unwrap().equity()[0];
    assert_eq!(ev.pots[1].equity[0], side_kings);

    let by_seat: BTreeMap<u32, _> = ev.seats.iter().map(|seat| (seat.seat, seat)).collect();
    assert_eq!(by_seat[&1].contributed, 2000);
    assert_eq!(by_seat[&2].contributed, 5000);
    assert_eq!(by_seat[&3].contributed, 5000);
    let utg = by_seat[&4];
    assert!(!utg.live);
    assert_eq!((utg.contributed, utg.ev_won, utg.ev_net), (300, 0, -300));
    assert_eq!(by_seat[&1].ev_won, ev.pots[0].shares[0]);
    assert!(by_seat[&1].ev_won <= 6300);

    assert_eq!(ev.seats.iter().map(|seat| seat.ev_net).sum::<i64>(), 0);
    assert_eq!(
        ev.pots
            .iter()
            .flat_map(|pot| pot.shares.iter())
            .sum::<i64>(),
        12300
    );
}

#[test]
fn charges_only_the_called_part_of_an_overbet() {
    let hand = parse(OVERBET);
    let ev = ev_of(&hand);
    assert_eq!(ev.pots.len(), 1);
    assert_eq!(ev.pots[0].amount, 12000);
    let sb = ev.seats.iter().find(|seat| seat.seat == 2).unwrap();
    assert_eq!(sb.contributed, 6000);
    assert_eq!(ev.seats.iter().map(|seat| seat.ev_net).sum::<i64>(), 0);
}

#[test]
fn equals_net_exactly_when_one_side_is_drawing_dead() {
    let hand = parse(DRAWING_DEAD);
    let ev = ev_of(&hand);
    assert_eq!(
        ev.pots[0].equity,
        vec![JsNumber::from_i64(1), JsNumber::ZERO]
    );
    assert_eq!(ev_net_by_seat(&hand, &defaults()), Some(net_by_seat(&hand)));
}

#[test]
fn is_unchanged_by_running_it_twice() {
    let once = parse(PREFLOP);
    let mut value = serde_json::to_value(&once).unwrap();
    value["board"]["runouts"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "index": 1,
            "flop": ["3c", "8d", "Th"],
            "turn": "4c",
            "river": "5s",
            "markerLabels": {},
            "summaryCards": null,
        }));
    let actions = value["actions"].as_array_mut().unwrap();
    let position = actions
        .iter()
        .position(|action| action["type"] == "collect")
        .expect("a collect");
    actions[position]["amount"] = Value::from(10000);
    let mut copy = actions[position].clone();
    copy["index"] = Value::from(copy["index"].as_u64().unwrap() + 1);
    copy["seat"] = Value::from(2);
    copy["player"] = Value::from("Sb");
    copy["runoutIndex"] = Value::from(1);
    actions.push(copy);
    let twice: PhfHand = serde_json::from_value(value).unwrap();

    assert_ne!(net_by_seat(&twice), net_by_seat(&once));
    assert_eq!(
        ev_net_by_seat(&twice, &defaults()),
        ev_net_by_seat(&once, &defaults())
    );
}

#[test]
fn evaluates_omaha_with_omaha_rules() {
    let hand = parse(OMAHA);
    assert_eq!(hand.game.variant, Variant::Omaha);
    let ev = ev_of(&hand);
    assert_eq!(ev.street, Street::Flop);
    assert_eq!(ev.boards, 820);
    let mut request = EquityRequest::new(EquityGame::Omaha, cards(&["As Ks Qh Jh", "Ad Ac 7c 8d"]));
    request.board = vec!["Th".into(), "9h".into(), "2c".into()];
    let reference = equity(&request).unwrap();
    assert_eq!(ev.pots[0].equity, reference.equity());
    assert_eq!(ev.seats.iter().map(|seat| seat.ev_net).sum::<i64>(), 0);
}

/* ------------------------------------------- when it does not apply - */

fn reason(hand: &PhfHand) -> Option<AllInSkipReason> {
    analyze_all_in(hand, &defaults()).reason()
}

#[test]
fn returns_none_with_a_reason_when_a_live_players_cards_are_unknown() {
    let hand = parse(MUCKED);
    assert!(all_in_ev(&hand, &defaults()).is_none());
    assert!(ev_net_by_seat(&hand, &defaults()).is_none());
    assert_eq!(reason(&hand), Some(AllInSkipReason::UnknownHoleCards));
}

#[test]
fn returns_none_when_nobody_was_all_in() {
    assert_eq!(reason(&parse(NO_ALL_IN)), Some(AllInSkipReason::NoAllIn));
}

#[test]
fn returns_none_for_a_river_all_in() {
    assert_eq!(reason(&parse(RIVER)), Some(AllInSkipReason::NoStreetToCome));
}

#[test]
fn returns_none_for_hi_lo_and_for_games_without_a_community_board() {
    let mut hi_lo = parse(PREFLOP);
    hi_lo.game.hi_lo = true;
    assert_eq!(reason(&hi_lo), Some(AllInSkipReason::HiLo));

    let mut stud = parse(PREFLOP);
    stud.game.variant = Variant::Stud;
    assert_eq!(reason(&stud), Some(AllInSkipReason::UnsupportedVariant));
    assert_eq!(
        analyze_all_in(&stud, &defaults()),
        AllInEvOutcome::Skipped {
            reason: AllInSkipReason::UnsupportedVariant,
            detail: "variant stud".to_owned()
        }
    );
}

#[test]
fn returns_none_when_two_boards_were_dealt_before_a_flop_all_in() {
    let mut value = serde_json::to_value(parse(OMAHA)).unwrap();
    value["board"]["runouts"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "index": 1,
            "flop": ["Ts", "8s", "5d"],
            "turn": "6d",
            "river": "Kd",
            "markerLabels": {},
            "summaryCards": null,
        }));
    let hand: PhfHand = serde_json::from_value(value).unwrap();
    assert_eq!(reason(&hand), Some(AllInSkipReason::DoubleBoard));
}

/* ------------------------------------------------ shortDeck.test.ts - */

const SHORT_DECK_TURN_ALL_IN: &str = "
Poker Hand #SD900001: ShortDeck No Limit ($1) - 2026/01/01 12:00:00
Table 'SdEv' 6-max Seat #3 is the button
Seat 1: Aces ($100 in chips)
Seat 2: Draw ($100 in chips)
Seat 3: Btn ($100 in chips)
Aces: posts the ante $1
Draw: posts the ante $1
Btn: posts the ante $1
Btn: posts button blind $1
*** HOLE CARDS ***
Dealt to Aces
Dealt to Draw
Dealt to Btn
Aces: calls $1
Draw: calls $1
Btn: checks
*** FLOP *** [Ah Kh 7c]
Aces: checks
Draw: checks
Btn: checks
*** TURN *** [Ah Kh 7c] [7d]
Aces: bets $98 and is all-in
Draw: calls $98 and is all-in
Btn: folds
*** RIVER *** [Ah Kh 7c 7d] [Th]
*** SHOWDOWN ***
Aces: shows [As Ac] (Full House, Aces full of Sevens)
Draw: shows [Qh 9h] (Ace High Flush)
Draw collected $202 from pot
*** SUMMARY ***
Total pot $202 | Rake $0
Board [Ah Kh 7c 7d Th]
Seat 1: Aces showed [As Ac] and lost with Full House, Aces full of Sevens
Seat 2: Draw showed [Qh 9h] and won ($202) with Ace High Flush
Seat 3: Btn (button) folded on the Turn
";

#[test]
fn short_deck_deals_the_runout_from_36_cards_and_ranks_a_flush_over_a_full_house() {
    // Through `convertAny`, as the TypeScript test reads it.
    let result = rail_core::convert_any(
        SHORT_DECK_TURN_ALL_IN.trim(),
        &rail_core::detect::ConvertOptions::default(),
    )
    .expect("converts");
    assert!(result.failures.is_empty());
    let hand = &result.hands[0].hand;
    assert_eq!(hand.game.variant, Variant::Shortdeck);

    let ev = ev_of(hand);
    assert_eq!(ev.street, Street::Turn);
    assert_eq!(ev.method, Computation::Exhaustive);
    assert_eq!(ev.boards, 28);
    assert_eq!(ev.pots.len(), 1);
    assert_eq!(ev.pots[0].eligible_seats, vec![1, 2]);
    assert_eq!(ev.pots[0].equity, vec![ratio(23, 28), ratio(5, 28)]);

    // The same cards dealt as Hold'em: 44 rivers, the full house never loses.
    let mut holdem = hand.clone();
    holdem.game.variant = Variant::Holdem;
    let as_holdem = ev_of(&holdem);
    assert_eq!(as_holdem.boards, 44);
    assert_eq!(
        as_holdem.pots[0].equity,
        vec![JsNumber::from_i64(1), JsNumber::ZERO]
    );
}

#[test]
fn flips_the_favourite_of_ggs_own_preflop_all_in_in_fixture_12() {
    let hand = corpus().hand(
        "fixtures/samples/ggpoker/12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt",
        "1171217378123557259",
    );
    let as_gg = ev_of(hand);
    let mut elsewhere = hand.clone();
    elsewhere.meta.site_id = "acrwpn".to_owned();
    let elsewhere = ev_of(&elsewhere);

    let king_queen = |ev: &AllInEv| {
        let pot = &ev.pots[0];
        let i = pot.eligible_seats.iter().position(|&s| s == 1).unwrap();
        pot.equity[i]
    };
    let half = ratio(1, 2);
    assert_eq!(as_gg.method, Computation::Exhaustive);
    assert!(king_queen(&as_gg).greater_than(half));
    assert!(king_queen(&elsewhere).less_than(half));
    let ev_net = |ev: &AllInEv| ev.seats.iter().find(|s| s.seat == 1).unwrap().ev_net;
    assert!(ev_net(&as_gg) > 0);
    assert!(ev_net(&elsewhere) < 0);
}

/* -------------------------------------------------- phfHiLo.test.ts - */

/// `CONVERTED` of `phfHiLo.test.ts`: every Omaha hi/lo fixture a parser
/// converts. "The equity engine still declines" each of their hands.
const HI_LO_FIXTURES: [&str; 14] = [
    "888poker/05-omaha-hilo-summary-hi-lo-split.txt",
    "888poker/10-omaha-hilo-hi-only-summary.txt",
    "entraction/06-fixed-limit-omaha-hilo.txt",
    "entraction/08-euro-table.txt",
    "entraction/12-omaha-hilo-showdown-split-pot.txt",
    "full-tilt/03-cash-plo-hilo-showdown-hi-lo-split.txt",
    "full-tilt/08-cash-flo8-fixed-limit-omaha-hilo.txt",
    "full-tilt/14-cash-plo-hilo-chatline-uncalled-bet.txt",
    "ignition/fpdb3-regression-corpus/cash__PLO8-9max-USD-0.02-0.05-201408.corrupted.lines.txt",
    "ignition/fpdb3-regression-corpus/tour__PLO8-9max-USD-10-MTT-201207.txt",
    "ignition/fpdb3-regression-corpus/tour__PLO8-USD-MTT - $1-0.10 - 201409.LOW.vs.LO.txt",
    "ignition/fpdb3-regression-corpus/tour__PLO8-USD-MTT - $10-$1 - 201207.allin.call.pf.txt",
    "microgaming/04-pot-limit-omaha-hilo.txt",
    "microgaming/09-omaha-hilo-showdown-split-pot.txt",
];

#[test]
fn the_equity_engine_declines_every_converted_hi_lo_hand() {
    let corpus = corpus();
    let mut hands = 0;
    for file in HI_LO_FIXTURES {
        for golden in corpus.file(&format!("fixtures/samples/{file}")) {
            let hand = &golden.hand;
            assert!(hand.game.hi_lo, "{file} {}", golden.hand_id);
            assert_eq!(reason(hand), Some(AllInSkipReason::HiLo), "{file}");
            hands += 1;
        }
    }
    assert!(hands >= HI_LO_FIXTURES.len());
}

/* ---------------------------------------------------- the stored row - */

#[test]
fn the_ev_row_falls_back_to_net_and_reads_the_hero_seat() {
    // `handEvRow`: applicable with the hero's evNet, or `net` otherwise.
    let hand = parse(PREFLOP);
    let row = rail_equity::ev_row_for(&hand).expect("a hero");
    assert_eq!(row.seat, 2);
    assert!(row.applicable);
    assert_eq!(row.ev_net, 6527);
    assert_eq!(row.ev_net_bb_milli, 65_270);
    assert_eq!(row.ev_version, EV_VERSION);

    let mucked = parse(MUCKED);
    let row = rail_equity::ev_row_for(&mucked).expect("a hero");
    assert!(!row.applicable);
    assert_eq!(row.ev_net, 10000);
    assert_eq!(row.ev_net_bb_milli, 100_000);

    // A hand where nobody acts as hero has no row.
    let mut value = serde_json::to_value(parse(NO_ALL_IN)).unwrap();
    for player in value["players"].as_array_mut().unwrap() {
        player["isHero"] = Value::Bool(false);
    }
    let heroless: PhfHand = serde_json::from_value(value).unwrap();
    assert_eq!(rail_equity::ev_row_for(&heroless), None);
}
