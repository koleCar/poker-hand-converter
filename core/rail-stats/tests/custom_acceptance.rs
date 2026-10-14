//! The acceptance test of R2.10 (docs/RAIL-PLAN.md; amendment A11): the
//! standard counters re-expressed in the predicate language
//! (`rail_stats::custom`) and compared with the coded counters on every
//! dealt-in seat of every corpus hand. docs/STATS-SPEC.md §14.4 lists the
//! definitions and the differences; this test is what keeps that list true.
//!
//! Every pair below must agree on every row - opportunities and made alike -
//! except the showdown family, which the language reaches only through a
//! seat's decisions: a seat with no decision at all in the hand (all in by
//! its blind, or a bomb pot played all in) has no event for `any` to find.
//! Those rows are the only differences allowed, and each is checked to be
//! one.

mod support;

use std::collections::BTreeMap;
use std::fmt::Write as _;

use rail_stats::custom::{Counts, CustomCounter};
use rail_stats::events::hand_events;
use rail_stats::{Counter, rows_for};
use support::corpus;

/// The preflop guard every preflop counter has in code: no bomb pot, and
/// not the big blind of a walk (STATS-SPEC §4.2, §8).
const PF: &str = "street = preflop and not bomb_pot and not (walk and big_blind)";

/// What a counter is compared with.
enum Coded {
    /// `(made, opportunities)` counters.
    Pair(&'static str, &'static str),
    /// A leg of a leg set or a raw count: only `made` is compared (the
    /// opportunity of a raw count is every decision of the street, which no
    /// counter holds).
    Made(&'static str),
    /// Only the opportunities (`flop_seen`).
    Opp(&'static str),
}

/// Whether a difference is allowed: the showdown family, for seats without
/// a decision.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Allow {
    Exact,
    SeatsWithoutDecisions,
}

struct Case {
    name: String,
    predicate: String,
    coded: Coded,
    allow: Allow,
}

fn case(name: &str, predicate: String, coded: Coded) -> Case {
    Case {
        name: name.to_owned(),
        predicate,
        coded,
        allow: Allow::Exact,
    }
}

/// The standard set in the language.
fn cases() -> Vec<Case> {
    use Coded::{Made, Opp, Pair};
    let mut out = vec![
        case(
            "vpip",
            format!("any {PF} => action in (call, bet, raise)"),
            Pair("vpip", "vpip_opp"),
        ),
        case(
            "pfr",
            format!("any {PF} => action = raise"),
            Pair("pfr", "pfr_opp"),
        ),
        case(
            "rfi",
            format!("first {PF} and first_on_street and facing = none => action = raise"),
            Pair("rfi", "rfi_opp"),
        ),
        case(
            "iso",
            format!("first {PF} and first_on_street and facing = limp => action = raise"),
            Pair("iso", "iso_opp"),
        ),
        case(
            "limp",
            format!(
                "first {PF} and first_on_street and raise_level = 0 and action != check \
                 => action = call"
            ),
            Pair("limp", "limp_opp"),
        ),
        case(
            "cold_call",
            format!(
                "first {PF} and first_on_street and raise_level >= 1 and not posted_blind \
                 => action = call"
            ),
            Pair("cold_call", "cold_call_opp"),
        ),
        case(
            "three_bet",
            format!("first {PF} and raise_level = 1 => action = raise"),
            Pair("three_bet", "three_bet_opp"),
        ),
        case(
            "four_bet",
            format!("first {PF} and raise_level = 2 => action = raise"),
            Pair("four_bet", "four_bet_opp"),
        ),
        case(
            "five_bet",
            format!("first {PF} and raise_level = 3 => action = raise"),
            Pair("five_bet", "five_bet_opp"),
        ),
        case(
            "squeeze",
            format!(
                "first {PF} and raise_level = 1 and first_at_level and callers >= 1 \
                 => action = raise"
            ),
            Pair("squeeze", "squeeze_opp"),
        ),
        case(
            "steal",
            format!(
                "first {PF} and first_on_street and facing = none and position in (co, btn, sb) \
                 and not straddle and not button_blind and dealt >= 3 => action = raise"
            ),
            Pair("steal", "steal_opp"),
        ),
    ];
    let legs: [(&str, &str, [&'static str; 4]); 3] = [
        (
            "fold_to_steal",
            "facing_steal and posted_blind and first_on_street",
            [
                "fold_to_steal_opp",
                "fold_to_steal",
                "call_steal",
                "three_bet_vs_steal",
            ],
        ),
        (
            "fold_to_three_bet",
            "raise_level = 2 and own_raise = 1",
            [
                "fold_to_three_bet_opp",
                "fold_to_three_bet",
                "call_three_bet",
                "raise_vs_three_bet",
            ],
        ),
        (
            "fold_to_four_bet",
            "raise_level = 3 and own_raise = 2",
            [
                "fold_to_four_bet_opp",
                "fold_to_four_bet",
                "call_four_bet",
                "raise_vs_four_bet",
            ],
        ),
    ];
    for (name, spot, [opp, fold, call, raise]) in legs {
        let opportunity = format!("first {PF} and {spot}");
        out.push(case(
            name,
            format!("{opportunity} => action = fold"),
            Pair(fold, opp),
        ));
        out.push(case(
            &format!("{name}.call"),
            format!("{opportunity} => action = call"),
            Made(call),
        ));
        out.push(case(
            &format!("{name}.raise"),
            format!("{opportunity} => action in (raise, bet)"),
            Made(raise),
        ));
    }
    let streets: [(&str, u32, [&'static str; 15]); 3] = [
        (
            "flop",
            0,
            [
                "cbet_flop",
                "cbet_flop_opp",
                "fold_to_cbet_flop",
                "fold_to_cbet_flop_opp",
                "call_cbet_flop",
                "raise_cbet_flop",
                "donk_flop",
                "donk_flop_opp",
                "check_raise_flop",
                "check_raise_flop_opp",
                "bet_flop",
                "raise_flop",
                "call_flop",
                "check_flop",
                "fold_flop",
            ],
        ),
        (
            "turn",
            1,
            [
                "cbet_turn",
                "cbet_turn_opp",
                "fold_to_cbet_turn",
                "fold_to_cbet_turn_opp",
                "call_cbet_turn",
                "raise_cbet_turn",
                "donk_turn",
                "donk_turn_opp",
                "check_raise_turn",
                "check_raise_turn_opp",
                "bet_turn",
                "raise_turn",
                "call_turn",
                "check_turn",
                "fold_turn",
            ],
        ),
        (
            "river",
            2,
            [
                "cbet_river",
                "cbet_river_opp",
                "fold_to_cbet_river",
                "fold_to_cbet_river_opp",
                "call_cbet_river",
                "raise_cbet_river",
                "donk_river",
                "donk_river_opp",
                "check_raise_river",
                "check_raise_river_opp",
                "bet_river",
                "raise_river",
                "call_river",
                "check_river",
                "fold_river",
            ],
        ),
    ];
    for (street, barrels, keys) in streets {
        let [
            cbet,
            cbet_opp,
            fold_cbet,
            fold_cbet_opp,
            call_cbet,
            raise_cbet,
            donk,
            donk_opp,
            check_raise,
            check_raise_opp,
            bet,
            raise,
            call,
            check,
            fold,
        ] = keys;
        out.push(case(
            cbet,
            format!(
                "first street = {street} and first_on_street and preflop_aggressor \
                 and barrels = {barrels} and facing = none and not bomb_pot => action = bet"
            ),
            Pair(cbet, cbet_opp),
        ));
        let facing_cbet = format!("first street = {street} and facing_cbet");
        out.push(case(
            fold_cbet,
            format!("{facing_cbet} => action = fold"),
            Pair(fold_cbet, fold_cbet_opp),
        ));
        out.push(case(
            call_cbet,
            format!("{facing_cbet} => action = call"),
            Made(call_cbet),
        ));
        out.push(case(
            raise_cbet,
            format!("{facing_cbet} => action in (raise, bet)"),
            Made(raise_cbet),
        ));
        out.push(case(
            donk,
            format!(
                "first street = {street} and first_on_street and facing = none \
                 and ahead_of_aggressor => action = bet"
            ),
            Pair(donk, donk_opp),
        ));
        out.push(case(
            check_raise,
            format!(
                "first street = {street} and checked_before and facing != none => action = raise"
            ),
            Pair(check_raise, check_raise_opp),
        ));
        for (key, action) in [
            (bet, "bet"),
            (raise, "raise"),
            (call, "call"),
            (check, "check"),
            (fold, "fold"),
        ] {
            out.push(case(
                key,
                format!("each street = {street} => action = {action}"),
                Made(key),
            ));
        }
    }
    for (name, predicate, coded) in [
        ("flop_seen", "any saw_flop", Opp("flop_seen")),
        ("wtsd", "any saw_flop => showdown", Pair("wtsd", "wtsd_opp")),
        ("wwsf", "any saw_flop => won", Pair("wwsf", "wwsf_opp")),
        (
            "wsd",
            "any saw_flop and showdown => won",
            Pair("wsd", "wsd_opp"),
        ),
    ] {
        let mut showdown = case(name, predicate.to_owned(), coded);
        showdown.allow = Allow::SeatsWithoutDecisions;
        out.push(showdown);
    }
    out
}

#[derive(Default)]
struct Tally {
    rows: usize,
    opportunities: u64,
    made: u64,
    differences: usize,
    /// Of `differences`: a seat with no decision in the hand.
    without_decisions: usize,
    examples: Vec<String>,
}

fn counter(name: &str) -> Counter {
    Counter::from_name(name).unwrap_or_else(|| panic!("no counter {name}"))
}

#[test]
fn the_standard_set_in_the_language_matches_the_coded_counters() {
    let cases = cases();
    let counters: Vec<CustomCounter> = cases
        .iter()
        .map(|case| {
            CustomCounter::parse(&case.predicate)
                .unwrap_or_else(|e| panic!("{}: {e}\n{}", case.name, case.predicate))
        })
        .collect();
    let mut tallies: Vec<Tally> = cases.iter().map(|_| Tally::default()).collect();
    let mut hands = 0_usize;
    let mut rows_total = 0_usize;

    for golden in corpus().hands() {
        hands += 1;
        let rows = rows_for(&golden.hand);
        let events = hand_events(&golden.hand);
        assert_eq!(
            rows.iter().map(|row| row.seat.seat).collect::<Vec<_>>(),
            events
                .seats
                .iter()
                .map(|seat| seat.seat)
                .collect::<Vec<_>>(),
            "{} {}: events and rows are for the same seats",
            golden.file,
            golden.hand_id
        );
        rows_total += rows.len();
        for ((case, compiled), tally) in cases.iter().zip(&counters).zip(&mut tallies) {
            for (row, seat) in rows.iter().zip(&events.seats) {
                let Counts { made, opp } = compiled.count(&events, seat);
                let c = &row.seat.counters;
                let (want_made, want_opp, compare_made, compare_opp) = match case.coded {
                    Coded::Pair(m, o) => (c[counter(m)], c[counter(o)], true, true),
                    Coded::Made(m) => (c[counter(m)], 0, true, false),
                    Coded::Opp(o) => (0, c[counter(o)], false, true),
                };
                tally.rows += 1;
                tally.opportunities += u64::from(want_opp);
                tally.made += u64::from(want_made);
                let differs =
                    (compare_made && made != want_made) || (compare_opp && opp != want_opp);
                if differs {
                    tally.differences += 1;
                    if seat.events.is_empty() {
                        tally.without_decisions += 1;
                    }
                    if tally.examples.len() < 12 {
                        tally.examples.push(format!(
                            "{} {} seat {}: language ({made}, {opp}), coded ({want_made}, {want_opp})",
                            golden.file, golden.hand_id, row.seat.seat
                        ));
                    }
                }
            }
        }
    }

    let mut report = String::new();
    let _ = writeln!(
        report,
        "{hands} hands, {rows_total} rows (every dealt-in seat)\n\
         {:<26} {:>9} {:>9} {:>7} {:>9}",
        "counter", "opps", "made", "diff", "no-dec."
    );
    let mut failures = Vec::new();
    for (case, tally) in cases.iter().zip(&tallies) {
        let _ = writeln!(
            report,
            "{:<26} {:>9} {:>9} {:>7} {:>9}",
            case.name, tally.opportunities, tally.made, tally.differences, tally.without_decisions
        );
        assert_eq!(tally.rows, rows_total);
        for example in &tally.examples {
            let _ = writeln!(report, "    {example}");
        }
        let allowed = match case.allow {
            Allow::Exact => 0,
            Allow::SeatsWithoutDecisions => tally.without_decisions,
        };
        if tally.differences != allowed {
            failures.push(format!(
                "{}: {} rows differ ({} allowed)\n  {}",
                case.name,
                tally.differences,
                allowed,
                tally.examples.join("\n  ")
            ));
        }
    }
    println!("{report}");
    assert!(hands > 8000, "the whole corpus: {hands} hands");
    assert!(failures.is_empty(), "{report}\n{}", failures.join("\n"));

    // Every opportunity count above is the coded counters', so the summary
    // is the same table STATS-SPEC §14.4 prints.
    let mut by_name: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    for (case, tally) in cases.iter().zip(&tallies) {
        by_name.insert(&case.name, (tally.opportunities, tally.made));
    }
    assert!(by_name["vpip"].0 > 0 && by_name["cbet_flop"].0 > 0);
}

/// What the events and the language cost per hand next to the coded
/// counters (docs/RAIL-PLAN.md R2.10 *As built*): run optimised,
/// `cargo test --release -p rail-stats --test custom_acceptance -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, not a check"]
fn cost_per_hand() {
    use std::time::{Duration, Instant};
    let hands: Vec<_> = corpus().hands().map(|golden| &golden.hand).collect();
    let n = u32::try_from(hands.len()).expect("hands");
    let counters: Vec<CustomCounter> = cases()
        .iter()
        .map(|case| CustomCounter::parse(&case.predicate).expect("parses"))
        .collect();
    let best = |f: &dyn Fn()| -> Duration {
        (0..5)
            .map(|_| {
                let started = Instant::now();
                f();
                started.elapsed()
            })
            .min()
            .unwrap_or_default()
            / n
    };
    let rows = best(&|| {
        for hand in &hands {
            std::hint::black_box(rows_for(hand));
        }
    });
    let events = best(&|| {
        for hand in &hands {
            std::hint::black_box(hand_events(hand));
        }
    });
    let built: Vec<_> = hands.iter().map(|hand| hand_events(hand)).collect();
    let count = best(&|| {
        for events in &built {
            for counter in &counters {
                std::hint::black_box(counter.count_hand(events));
            }
        }
    });
    println!(
        "per hand: coded counters (rows_for) {rows:?}; decision events {events:?}; \
         {} counters on every seat {count:?}",
        counters.len()
    );
}
