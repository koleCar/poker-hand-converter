//! `tests/test/statsSpots.test.ts`, ported: one pinned hand per hard case,
//! with the counters spelled out (docs/STATS-SPEC.md §4, §6-§8).
//!
//! The seventeen hand-written hands of `tests/test/fixtures/stats/` are read
//! with `parse_standard_hand`, as the TypeScript reads them; the cases only a
//! real room writes (gross collects, run it twice, an EV cashout, a bomb pot)
//! come from the golden corpus - the hands `convertAny` made of those files.

mod support;

use std::fs;

use rail_core::phf::serialize::{StandardContext, parse_standard_hand};
use rail_core::phf::{ActionType, PhfHand, Position};
use rail_stats::{Counter, HandFacts, SeatCounters, SeatMoney, hand_facts};
use support::invariants::all_stats_invariants;
use support::{corpus, root};

use Counter as C;

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};

const FIXTURES: [&str; 17] = [
    "01-walk.txt",
    "02-straddle-open-is-not-a-three-bet.txt",
    "03-dead-post-is-not-vpip.txt",
    "04-steal-and-fold-to-steal.txt",
    "05-isolation-raise-is-not-rfi.txt",
    "06-squeeze.txt",
    "07-four-bet-war.txt",
    "08-blind-defence-is-not-a-cold-call.txt",
    "09-turn-cbet-needs-a-called-flop-cbet.txt",
    "10-raised-flop-cbet-ends-the-chain.txt",
    "11-donk-bet-removes-the-cbet-spot.txt",
    "12-limped-pot-has-no-cbet.txt",
    "13-all-in-preflop-is-not-a-cbet-spot.txt",
    "14-heads-up-has-no-steal.txt",
    "15-big-blind-ante.txt",
    "16-fold-to-cbet-legs.txt",
    "17-triple-barrel-and-rake.txt",
];

fn fixture_hand(name: &str) -> PhfHand {
    let path = root().join("tests/test/fixtures/stats").join(name);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse_standard_hand(&text, &CTX)
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .unwrap_or_else(|| panic!("{name} did not parse"))
}

fn fixture(name: &str) -> HandFacts {
    hand_facts(&fixture_hand(name))
}

fn seat(facts: &HandFacts, player: &str) -> SeatCounters {
    facts
        .seats
        .iter()
        .find(|entry| entry.player == player)
        .unwrap_or_else(|| panic!("no seat for {player}"))
        .counters
}

fn money(facts: &HandFacts, player: &str) -> SeatMoney {
    facts
        .seats
        .iter()
        .find(|entry| entry.player == player)
        .unwrap_or_else(|| panic!("no seat for {player}"))
        .money
}

fn non_zero(counters: &SeatCounters) -> Vec<(&'static str, u32)> {
    counters
        .iter()
        .filter(|(_, value)| *value != 0)
        .map(|(counter, value)| (counter.name(), value))
        .collect()
}

fn net_sum(facts: &HandFacts) -> i64 {
    facts.seats.iter().map(|entry| entry.money.net).sum()
}

/* ============================================================== preflop == */

#[test]
fn gives_the_walked_big_blind_no_vpip_opportunity_at_all() {
    let facts = fixture("01-walk.txt");
    assert!(facts.hand.is_walk);
    assert_eq!(non_zero(&seat(&facts, "Bb")), vec![("hands", 1)]);
    assert_eq!(seat(&facts, "Utg")[C::vpip_opp], 1);
    assert_eq!(seat(&facts, "Utg")[C::rfi_opp], 1);
    assert_eq!(money(&facts, "Sb").net, -50);
    assert_eq!(money(&facts, "Bb").net, 50);
}

#[test]
fn treats_a_straddle_as_a_blind_so_the_raise_over_it_is_an_open() {
    let facts = fixture("02-straddle-open-is-not-a-three-bet.txt");
    assert!(facts.hand.has_straddle);

    let co = seat(&facts, "Co");
    assert_eq!(co[C::rfi], 1);
    assert_eq!(co[C::pfr], 1);
    assert_eq!(co[C::three_bet], 0);
    assert_eq!(co[C::three_bet_opp], 0);

    let utg = seat(&facts, "Utg");
    assert_eq!(utg[C::vpip_opp], 1);
    assert_eq!(utg[C::vpip], 0);
    assert_eq!(money(&facts, "Utg").contributed, 200);

    for entry in &facts.seats {
        assert_eq!(entry.counters[C::steal_opp], 0);
        assert_eq!(entry.counters[C::fold_to_steal_opp], 0);
    }
}

#[test]
fn counts_a_dead_post_as_money_in_the_pot_but_never_as_vpip() {
    let facts = fixture("03-dead-post-is-not-vpip.txt");
    let hj = seat(&facts, "Hj");
    assert_eq!(hj[C::vpip_opp], 1);
    assert_eq!(hj[C::vpip], 0);
    assert_eq!(money(&facts, "Hj").contributed, 100);
    assert_eq!(money(&facts, "Hj").net, -100);
}

#[test]
fn records_a_steal_and_both_blinds_folding_to_it() {
    let facts = fixture("04-steal-and-fold-to-steal.txt");
    let co = seat(&facts, "Co");
    assert_eq!(co[C::steal_opp], 1);
    assert_eq!(co[C::steal], 1);
    assert_eq!(co[C::rfi], 1);

    for blind in ["Sb", "Bb"] {
        let c = seat(&facts, blind);
        assert_eq!(c[C::fold_to_steal_opp], 1);
        assert_eq!(c[C::fold_to_steal], 1);
        assert_eq!(c[C::call_steal] + c[C::three_bet_vs_steal], 0);
    }
    assert_eq!(seat(&facts, "Btn")[C::fold_to_steal_opp], 0);
    assert_eq!(seat(&facts, "Btn")[C::cold_call_opp], 1);
}

#[test]
fn separates_an_isolation_raise_from_a_raise_first_in() {
    let facts = fixture("05-isolation-raise-is-not-rfi.txt");
    let co = seat(&facts, "Co");
    assert_eq!(co[C::iso_opp], 1);
    assert_eq!(co[C::iso], 1);
    assert_eq!(co[C::rfi_opp], 0);
    assert_eq!(co[C::rfi], 0);
    assert_eq!(co[C::pfr], 1);

    let utg = seat(&facts, "Utg");
    assert_eq!(utg[C::rfi_opp], 1);
    assert_eq!(utg[C::rfi], 0);
    assert_eq!(utg[C::limp_opp], 1);
    assert_eq!(utg[C::limp], 1);
}

#[test]
fn needs_a_cold_caller_for_a_raise_to_be_a_squeeze() {
    let facts = fixture("06-squeeze.txt");
    let btn = seat(&facts, "Btn");
    assert_eq!(btn[C::three_bet], 1);
    assert_eq!(btn[C::squeeze_opp], 1);
    assert_eq!(btn[C::squeeze], 1);

    let hj = seat(&facts, "Hj");
    assert_eq!(hj[C::cold_call_opp], 1);
    assert_eq!(hj[C::cold_call], 1);

    let utg = seat(&facts, "Utg");
    assert_eq!(utg[C::fold_to_three_bet_opp], 1);
    assert_eq!(utg[C::fold_to_three_bet], 1);
    assert_eq!(utg[C::call_three_bet] + utg[C::raise_vs_three_bet], 0);
}

#[test]
fn walks_the_raise_levels_through_a_four_bet_war() {
    let facts = fixture("07-four-bet-war.txt");
    let utg = seat(&facts, "Utg");
    assert_eq!(utg[C::rfi], 1);
    assert_eq!(utg[C::four_bet_opp], 1);
    assert_eq!(utg[C::four_bet], 1);
    assert_eq!(utg[C::fold_to_three_bet_opp], 1);
    assert_eq!(utg[C::raise_vs_three_bet], 1);

    let co = seat(&facts, "Co");
    assert_eq!(co[C::three_bet_opp], 1);
    assert_eq!(co[C::three_bet], 1);
    assert_eq!(co[C::five_bet_opp], 1);
    assert_eq!(co[C::five_bet], 0);
    assert_eq!(co[C::fold_to_four_bet_opp], 1);
    assert_eq!(co[C::fold_to_four_bet], 1);

    assert_eq!(utg[C::pfr], 1);
    assert_eq!(utg[C::vpip], 1);
}

#[test]
fn does_not_call_a_blinds_defence_a_cold_call() {
    let facts = fixture("08-blind-defence-is-not-a-cold-call.txt");
    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::vpip], 1);
    assert_eq!(bb[C::cold_call_opp], 0);
    assert_eq!(bb[C::call_steal], 1);
    assert_eq!(seat(&facts, "Btn")[C::cold_call], 1);
}

#[test]
fn gives_nobody_a_steal_opportunity_heads_up() {
    let facts = fixture("14-heads-up-has-no-steal.txt");
    let positions: Vec<Option<Position>> = facts.seats.iter().map(|entry| entry.position).collect();
    assert_eq!(positions, vec![Some(Position::Sb), Some(Position::Bb)]);
    for entry in &facts.seats {
        assert_eq!(entry.counters[C::steal_opp], 0);
        assert_eq!(entry.counters[C::fold_to_steal_opp], 0);
    }
    assert_eq!(seat(&facts, "Sb")[C::rfi], 1);
    assert_eq!(seat(&facts, "Bb")[C::three_bet_opp], 1);
}

/* ============================================================= postflop == */

#[test]
fn requires_the_flop_cbet_to_have_been_called_before_a_turn_cbet() {
    let facts = fixture("09-turn-cbet-needs-a-called-flop-cbet.txt");
    let co = seat(&facts, "Co");
    assert_eq!(co[C::cbet_flop_opp], 1);
    assert_eq!(co[C::cbet_flop], 1);
    assert_eq!(co[C::cbet_turn_opp], 1);
    assert_eq!(co[C::cbet_turn], 1);
    assert_eq!(co[C::cbet_river_opp], 0);

    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::fold_to_cbet_flop_opp], 1);
    assert_eq!(bb[C::call_cbet_flop], 1);
    assert_eq!(bb[C::fold_to_cbet_turn_opp], 1);
    assert_eq!(bb[C::fold_to_cbet_turn], 1);
}

#[test]
fn ends_the_cbet_chain_when_the_flop_cbet_is_raised_rather_than_called() {
    let facts = fixture("10-raised-flop-cbet-ends-the-chain.txt");
    let co = seat(&facts, "Co");
    assert_eq!(co[C::cbet_flop], 1);
    assert_eq!(co[C::cbet_turn_opp], 0);
    assert_eq!(co[C::cbet_turn], 0);
    assert_eq!(co[C::bet_turn], 1);

    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::raise_cbet_flop], 1);
    assert_eq!(bb[C::check_raise_flop_opp], 1);
    assert_eq!(bb[C::check_raise_flop], 1);
}

#[test]
fn takes_the_cbet_spot_away_from_a_raiser_who_was_donked_into() {
    let facts = fixture("11-donk-bet-removes-the-cbet-spot.txt");
    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::donk_flop_opp], 1);
    assert_eq!(bb[C::donk_flop], 1);

    let co = seat(&facts, "Co");
    assert_eq!(co[C::flop_seen], 1);
    assert_eq!(co[C::cbet_flop_opp], 0);
}

#[test]
fn gives_nobody_a_cbet_opportunity_in_a_limped_pot() {
    let facts = fixture("12-limped-pot-has-no-cbet.txt");
    for entry in &facts.seats {
        assert_eq!(entry.counters[C::cbet_flop_opp], 0);
        assert_eq!(entry.counters[C::donk_flop_opp], 0);
    }
    assert_eq!(seat(&facts, "Utg")[C::bet_flop], 1);
    assert_eq!(seat(&facts, "Bb")[C::check_raise_flop_opp], 1);
    assert_eq!(seat(&facts, "Bb")[C::check_raise_flop], 0);
}

#[test]
fn sees_the_flop_without_having_a_cbet_opportunity_when_all_in_preflop() {
    let facts = fixture("13-all-in-preflop-is-not-a-cbet-spot.txt");
    let co = seat(&facts, "Co");
    assert_eq!(co[C::pfr], 1);
    assert_eq!(co[C::flop_seen], 1);
    assert_eq!(co[C::turn_seen], 1);
    assert_eq!(co[C::river_seen], 1);
    assert_eq!(co[C::cbet_flop_opp], 0);
    assert_eq!(co[C::wtsd], 1);
    assert_eq!(co[C::wsd], 0);

    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::wtsd], 1);
    assert_eq!(bb[C::wsd], 1);
    assert_eq!(bb[C::wwsf], 1);
}

#[test]
fn splits_the_response_to_a_cbet_into_fold_call_and_raise() {
    let facts = fixture("16-fold-to-cbet-legs.txt");
    let btn = seat(&facts, "Btn");
    assert_eq!(btn[C::fold_to_cbet_flop_opp], 1);
    assert_eq!(btn[C::raise_cbet_flop], 1);
    assert_eq!(btn[C::fold_to_cbet_flop] + btn[C::call_cbet_flop], 0);

    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::fold_flop], 1);
    assert_eq!(bb[C::fold_to_cbet_flop_opp], 0);
}

#[test]
fn carries_the_cbet_chain_all_the_way_to_the_river() {
    let facts = fixture("17-triple-barrel-and-rake.txt");
    let co = seat(&facts, "Co");
    assert_eq!(
        [co[C::cbet_flop], co[C::cbet_turn], co[C::cbet_river]],
        [1, 1, 1]
    );
    assert_eq!(
        [
            co[C::cbet_flop_opp],
            co[C::cbet_turn_opp],
            co[C::cbet_river_opp]
        ],
        [1, 1, 1]
    );

    let bb = seat(&facts, "Bb");
    assert_eq!(bb[C::call_cbet_flop], 1);
    assert_eq!(bb[C::call_cbet_turn], 1);
    assert_eq!(bb[C::fold_to_cbet_river], 1);
    assert_eq!(bb[C::bet_flop] + bb[C::bet_turn] + bb[C::bet_river], 0);
    assert_eq!(bb[C::call_flop] + bb[C::call_turn] + bb[C::call_river], 2);
}

/* ================================================================ money == */

#[test]
fn attributes_the_fees_to_the_seat_that_took_the_pot() {
    let facts = fixture("17-triple-barrel-and-rake.txt");
    assert_eq!(facts.hand.fees, 236);
    assert_eq!(money(&facts, "Co").rake_paid, 236);
    assert_eq!(money(&facts, "Bb").rake_paid, 0);
    assert_eq!(money(&facts, "Co").won, 3214);
    assert_eq!(money(&facts, "Co").net, 1514);
    assert_eq!(net_sum(&facts), -236);
}

#[test]
fn keeps_a_big_blind_ante_in_the_posters_contribution_and_says_so() {
    let facts = fixture("15-big-blind-ante.txt");
    assert!(facts.hand.is_big_blind_ante);
    assert_eq!(money(&facts, "Bb").contributed, 700);
    assert_eq!(money(&facts, "Bb").net, -700);
    assert_eq!(net_sum(&facts), 0);
}

#[test]
fn normalizes_a_room_that_states_its_collects_gross_of_the_rake() {
    let hands = corpus().file(
        "weplay-hh/kole1992/HH20260205 Lisbon #1 (#11485806) - $1-$2 - Money 3 No Limit Hold_em.txt",
    );
    let raked = hands
        .iter()
        .find(|golden| golden.hand.results.fees.rake > 0)
        .expect("a raked hand");
    let facts = hand_facts(&raked.hand);
    let winner = facts
        .seats
        .iter()
        .find(|entry| entry.money.won > 0)
        .expect("a winner");
    let collected: i64 = raked
        .hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Collect && action.seat == Some(winner.seat))
        .map(|action| action.amount)
        .sum();
    assert_eq!(winner.money.won, collected - winner.money.rake_paid);
    assert_eq!(net_sum(&facts), -facts.hand.fees);
}

#[test]
fn sums_a_run_it_twice_result_across_both_runouts_with_no_special_case() {
    let hands = corpus().file("gg-hh/GG20260217-0406 - NLHPurple6 - 0.25 - 0.5 - 6max.txt");
    let twice = hands
        .iter()
        .find(|golden| golden.hand.board.runouts.len() > 1)
        .expect("a run-it-twice hand");
    let facts = hand_facts(&twice.hand);
    assert!(facts.hand.is_run_it_twice);
    let collects: Vec<i64> = twice
        .hand
        .actions
        .iter()
        .filter(|action| action.kind == ActionType::Collect)
        .map(|action| action.amount)
        .collect();
    assert!(collects.len() > 1);
    let total: i64 = facts.seats.iter().map(|entry| entry.money.won).sum();
    assert_eq!(total, collects.iter().sum::<i64>());
    assert_eq!(all_stats_invariants(&twice.hand), Vec::<String>::new());
}

#[test]
fn flags_an_ev_cashout_rather_than_trusting_won_minus_contributed() {
    let hands = corpus().file("gg-hh/GG20260217-0518 - NLHPurple11 - 0.25 - 0.5 - 6max.txt");
    let cashed = hands
        .iter()
        .find(|golden| {
            golden
                .hand
                .actions
                .iter()
                .any(|action| action.kind == ActionType::CashoutPay)
        })
        .expect("an EV cashout");
    let facts = hand_facts(&cashed.hand);
    assert!(facts.hand.has_cashout);
    let seller = facts
        .seats
        .iter()
        .find(|entry| entry.counters[C::cashed_out] == 1)
        .expect("the seller");
    assert!(seller.money.cashout_risk > 0);
    assert_ne!(
        seller.money.net,
        seller.money.net - seller.money.cashout_risk
    );
}

/* ============================================================= bomb pot == */

#[test]
fn a_bomb_pot_has_no_preflop_betting_round() {
    let hands = corpus().file("fixtures/samples/weplay/03-cash-bomb-pot-ante-only.txt");
    let bomb = hands
        .iter()
        .find(|golden| hand_facts(&golden.hand).hand.is_bomb_pot)
        .expect("a bomb pot");
    let facts = hand_facts(&bomb.hand);
    assert!(facts.hand.is_bomb_pot);
    for entry in &facts.seats {
        let c = &entry.counters;
        for counter in [
            C::vpip_opp,
            C::vpip,
            C::pfr_opp,
            C::rfi_opp,
            C::limp_opp,
            C::steal_opp,
            C::three_bet_opp,
        ] {
            assert_eq!(c[counter], 0, "{}", counter.name());
        }
        assert_eq!(c[C::flop_seen], 1);
    }
    assert!(
        facts
            .seats
            .iter()
            .all(|entry| entry.counters[C::cbet_flop_opp] == 0)
    );
}

/* ================================================== every fixture holds == */

#[test]
fn every_hand_written_fixture_holds_the_invariants() {
    for name in FIXTURES {
        assert_eq!(
            all_stats_invariants(&fixture_hand(name)),
            Vec::<String>::new(),
            "{name}"
        );
    }
    // And nothing else sits in the directory unpinned.
    let mut on_disk: Vec<String> = fs::read_dir(root().join("tests/test/fixtures/stats"))
        .expect("fixtures/stats")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    on_disk.sort();
    assert_eq!(on_disk, FIXTURES.map(str::to_owned).to_vec());
}

/* ============================================ short deck (shortDeck.test.ts) == */

fn corpus_hand(input: &str, hand_id: &str) -> PhfHand {
    corpus()
        .file(input)
        .iter()
        .find(|golden| golden.hand_id == hand_id)
        .unwrap_or_else(|| panic!("{hand_id} is not in {input}"))
        .hand
        .clone()
}

#[test]
fn gives_short_deck_hole_cards_the_hold_em_class_and_an_impossible_card_none() {
    let mut hand = corpus_hand(
        "fixtures/samples/ggpoker/11-fpdb3-cash-nl-shortdeck-5max-usd-0-2-202103.txt",
        "SD27208848",
    );
    let facts = hand_facts(&hand);
    let hero = facts
        .seats
        .iter()
        .find(|entry| entry.is_hero)
        .expect("hero");
    assert_eq!(hero.hole_cards, vec!["Tc".to_owned(), "Ac".to_owned()]);
    assert_eq!(hero.hand_class.as_deref(), Some("ATs"));

    for player in &mut hand.players {
        if player.name == "Hero" {
            player.hole_cards = vec!["Tc".to_owned(), "5c".to_owned()];
        }
    }
    let facts = hand_facts(&hand);
    let hero = facts
        .seats
        .iter()
        .find(|entry| entry.is_hero)
        .expect("hero");
    assert_eq!(hero.hand_class, None);
}

#[test]
fn an_ante_only_table_is_neither_a_bomb_pot_nor_a_walk_and_has_no_steal() {
    let hand = corpus_hand(
        "fixtures/samples/ggpoker/12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt",
        "1171217378123557259",
    );
    let facts = hand_facts(&hand);
    assert_eq!(facts.hand.variant, rail_core::phf::Variant::Shortdeck);
    assert!(!facts.hand.is_bomb_pot);
    assert!(!facts.hand.is_walk);
    assert!(!facts.hand.has_straddle);
    assert_eq!(facts.hand.pot_type.as_str(), "single-raised");
    assert_eq!(facts.hand.small_blind, 0);
    assert_eq!(facts.hand.big_blind, 10000);
    let by_seat = |seat: u32| {
        facts
            .seats
            .iter()
            .find(|entry| entry.seat == seat)
            .expect("seat")
    };
    assert_eq!(by_seat(1).position, Some(Position::Utg));
    let one = by_seat(1).counters;
    assert_eq!((one[C::vpip], one[C::limp], one[C::pfr]), (1, 1, 0));
    let five = by_seat(5).counters;
    assert_eq!((five[C::vpip], five[C::pfr], five[C::iso]), (1, 1, 1));
    assert_eq!(five[C::cold_call_opp], 0);
}

#[test]
fn a_button_blind_gives_nobody_a_steal_or_a_steal_to_defend() {
    let text = "Poker Hand #SD900002: ShortDeck No Limit ($1) - 2026/01/01 12:00:00
Table 'SdSteal' 6-max Seat #4 is the button
Seat 1: Utg ($100 in chips)
Seat 2: Hj ($100 in chips)
Seat 3: Co ($100 in chips)
Seat 4: Btn ($100 in chips)
Utg: posts the ante $1
Hj: posts the ante $1
Co: posts the ante $1
Btn: posts the ante $1
Btn: posts button blind $1
*** HOLE CARDS ***
Dealt to Utg
Dealt to Hj
Dealt to Co
Dealt to Btn
Utg: folds
Hj: folds
Co: raises $2 to $3
Btn: folds
Uncalled bet ($2) returned to Co
*** SHOWDOWN ***
Co collected $6 from pot
*** SUMMARY ***
Total pot $6 | Rake $0
Seat 1: Utg folded before Flop
Seat 2: Hj folded before Flop
Seat 3: Co collected ($6)
Seat 4: Btn (button) folded before Flop";
    // `convertAny(text)` with no options, as the TypeScript test calls it
    // (`validate` defaults to true there too).
    let result = rail_core::convert_any(text, &rail_core::detect::ConvertOptions::default())
        .expect("converts");
    let hand = &result.hands[0].hand;
    let facts = hand_facts(hand);
    let positions: Vec<Option<Position>> = facts.seats.iter().map(|entry| entry.position).collect();
    assert_eq!(
        positions,
        vec![
            Some(Position::Utg),
            Some(Position::Hj),
            Some(Position::Co),
            Some(Position::Btn)
        ]
    );
    for entry in &facts.seats {
        assert_eq!(entry.counters[C::steal_opp], 0, "{}", entry.player);
        assert_eq!(entry.counters[C::fold_to_steal_opp], 0, "{}", entry.player);
    }
    assert_eq!(
        (
            facts.seats[2].counters[C::rfi],
            facts.seats[2].counters[C::pfr]
        ),
        (1, 1)
    );
    assert_eq!(all_stats_invariants(hand), Vec::<String>::new());
}

/* ============================================ pot type (statsPotType.test.ts) == */

#[test]
fn every_hand_gets_one_pot_type_that_agrees_with_its_counters() {
    let mut seen = std::collections::BTreeSet::new();
    let mut problems = Vec::new();
    for golden in corpus().hands() {
        if !(golden.file.starts_with("weplay-hh/") || golden.file.starts_with("gg-hh/")) {
            continue;
        }
        let facts = hand_facts(&golden.hand);
        let kind = facts.hand.pot_type.as_str();
        seen.insert(kind);
        let any = |counter: Counter| facts.seats.iter().any(|seat| seat.counters[counter] > 0);
        let id = &golden.hand_id;
        if facts.hand.is_walk != (kind == "walk") {
            problems.push(format!("{id}: walk mismatch"));
        }
        if facts.hand.is_bomb_pot != (kind == "bomb") {
            problems.push(format!("{id}: bomb mismatch"));
        }
        if any(C::three_bet) && kind != "3bet" && kind != "4bet+" {
            problems.push(format!("{id}: 3-bet but {kind}"));
        }
        if any(C::four_bet) && kind != "4bet+" {
            problems.push(format!("{id}: 4-bet but {kind}"));
        }
    }
    assert_eq!(problems, Vec::<String>::new());
    for kind in ["walk", "limped", "single-raised", "3bet", "4bet+", "bomb"] {
        assert!(seen.contains(kind), "{kind}");
    }
}
