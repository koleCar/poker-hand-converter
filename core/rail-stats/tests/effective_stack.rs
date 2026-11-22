//! The effective stack at the hero's first preflop action
//! (docs/ANALYTICS.md Step 11): pinned hands with the value worked out by
//! hand (`data/effective-stack/expected.json`, read by the web's twin too:
//! `tests/test/effectiveStack.test.ts`), and its Effective stack bucket.
//! The whole corpus is held equal to the web's in `analytics_corpus.rs`
//! (the events' hash carries `effectiveFirstActionBb`).

mod support;

use std::fs;

use rail_core::phf::PhfHand;
use rail_core::phf::serialize::{StandardContext, parse_standard_hand};
use rail_stats::events::{effective_first_action_bb, hand_events};
use rail_stats::stack_buckets::{Scheme, bucket_of};
use serde_json::Value;
use support::root;

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};

fn hand(path: &str) -> PhfHand {
    let text = fs::read_to_string(root().join(path)).unwrap_or_else(|e| panic!("{path}: {e}"));
    parse_standard_hand(&text, &CTX)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .unwrap_or_else(|| panic!("{path} did not parse"))
}

#[test]
fn the_pinned_hands_give_the_worked_values() {
    let expected: Value = serde_json::from_str(
        &fs::read_to_string(
            root().join("core/rail-stats/tests/data/effective-stack/expected.json"),
        )
        .expect("expected.json"),
    )
    .expect("json");
    let cases = expected["cases"].as_array().expect("cases");
    assert!(cases.len() >= 5);
    for case in cases {
        let file = case["file"].as_str().expect("file");
        let hero = u32::try_from(case["hero"].as_u64().expect("hero")).expect("seat");
        let want = case["thousandths"].as_i64();
        let hand = hand(file);
        let got = effective_first_action_bb(&hand, hero);
        assert_eq!(got, want, "{file}: {}", case["why"]);
        // The events carry the same number for the seat.
        let events = hand_events(&hand);
        let seat = events
            .seats
            .iter()
            .find(|seat| seat.seat == hero)
            .expect("hero seat");
        assert!(seat.hero, "{file}: seat {hero} is the hero");
        assert_eq!(seat.effective_first_action_bb, want, "{file}: events");
        let tenths = got.expect("a value") / 100;
        assert_eq!(
            bucket_of(Scheme::Filter, tenths),
            case["bucket"].as_str(),
            "{file}: bucket"
        );
    }
}

#[test]
fn every_seat_measures_against_the_live_stacks_at_its_turn() {
    let events = hand_events(&hand(
        "core/rail-stats/tests/data/effective-stack/01-folded-deep-stack-left-out.txt",
    ));
    let by_seat: Vec<(u32, Option<i64>)> = events
        .seats
        .iter()
        .map(|seat| (seat.seat, seat.effective_first_action_bb))
        .collect();
    // UTG ($400) acts first: CO's $250 is the largest other stack. Every
    // later seat has $100 or less and CO's $250 is still live, so each is
    // its own stack; CO, after UTG folded, has BTN's and SB's $100.
    assert_eq!(
        by_seat,
        [
            (1, Some(100_000)),
            (2, Some(100_000)),
            (3, Some(60_000)),
            (4, Some(250_000)),
            (5, Some(100_000)),
            (6, Some(100_000)),
        ]
    );
}
