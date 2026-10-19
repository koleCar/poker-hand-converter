//! Decision events (docs/STATS-SPEC.md §14.1) on a pinned hand: the facts
//! the acceptance test cannot reach through the coded counters - sizes,
//! position, the pot, stacks - spelled out.

mod support;

use std::fs;

use rail_core::phf::serialize::{StandardContext, parse_standard_hand};
use rail_core::phf::{ActionType, PhfHand, Position, Street};
use rail_stats::custom::CustomCounter;
use rail_stats::events::{Facing, SeatEvents, hand_events};
use support::root;

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};

fn fixture_hand(name: &str) -> PhfHand {
    let path = root().join("tests/test/fixtures/stats").join(name);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse_standard_hand(&text, &CTX)
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .unwrap_or_else(|| panic!("{name} did not parse"))
}

fn seat(events: &rail_stats::events::HandEvents, position: Position) -> &SeatEvents {
    events
        .seats
        .iter()
        .find(|seat| seat.position == Some(position))
        .unwrap_or_else(|| panic!("no {position:?}"))
}

/// `17-triple-barrel-and-rake.txt`: CO opens to $3 at $0.5/$1, the big blind
/// calls, CO bets $4, $10 and $20, called twice, folded to on the river.
#[test]
fn a_triple_barrel_in_events() {
    let events = hand_events(&fixture_hand("17-triple-barrel-and-rake.txt"));
    assert_eq!((events.dealt, events.preflop_raises), (6, 1));
    assert!(!events.bomb_pot && !events.walk && !events.straddle);

    let co = seat(&events, Position::Co);
    assert!(co.hero && co.preflop_aggressor && !co.posted_blind);
    assert_eq!(
        (co.stack_bb, co.effective_bb),
        (Some(100_000), Some(100_000))
    );
    assert!(co.saw_river && !co.showdown && co.won);
    let streets: Vec<(Street, ActionType)> =
        co.events.iter().map(|e| (e.street, e.action)).collect();
    assert_eq!(
        streets,
        [
            (Street::Preflop, ActionType::Raise),
            (Street::Flop, ActionType::Bet),
            (Street::Turn, ActionType::Bet),
            (Street::River, ActionType::Bet),
        ]
    );
    let open = &co.events[0];
    assert_eq!(open.facing, Facing::None);
    assert_eq!((open.raise_level, open.limpers, open.players), (0, 0, 6));
    // $1.50 in the pot; to $3 = 3 bb; the $2 over the call into $2.50.
    assert_eq!(open.pot_bb, Some(1500));
    assert_eq!(open.size_bb, Some(3000));
    assert_eq!(open.size_pot, Some(80_000));
    assert_eq!(open.in_position, None);
    // $4 into $6.50, $10 into $14.50, $20 into $34.50.
    let sizes: Vec<Option<i64>> = co.events[1..].iter().map(|e| e.size_pot).collect();
    assert_eq!(sizes, [Some(61_538), Some(68_965), Some(57_971)]);
    let barrels: Vec<u32> = co.events[1..].iter().map(|e| e.barrels).collect();
    assert_eq!(barrels, [0, 1, 2]);
    assert!(co.events[1..].iter().all(|e| e.initiative
        && e.in_position == Some(true)
        && e.facing == Facing::None
        && e.players == 2
        && !e.ahead_of_aggressor));

    let bb = seat(&events, Position::Bb);
    assert!(bb.big_blind && bb.posted_blind && !bb.won);
    let call = &bb.events[0];
    assert_eq!(
        (call.action, call.facing, call.raise_level),
        (ActionType::Call, Facing::Raise, 1)
    );
    // A cutoff open folded to is a steal attempt (STATS-SPEC §6.1).
    assert!(call.first_at_level && call.first_on_street && call.facing_steal);
    assert_eq!(call.facing_size_pot, Some(80_000));
    assert_eq!(call.size_bb, Some(3000));
    // Checks to the raiser on every street, then answers the cbet.
    let flop: Vec<_> = bb
        .events
        .iter()
        .filter(|e| e.street == Street::Flop)
        .collect();
    assert_eq!(flop.len(), 2);
    assert!(flop[0].ahead_of_aggressor && flop[0].in_position == Some(false));
    assert!(flop[1].facing_cbet && flop[1].checked_before && flop[1].facing == Facing::Bet);
    assert_eq!(flop[1].facing_size_pot, Some(61_538));
    let fold = bb.events.last().expect("the river fold");
    assert_eq!(
        (fold.street, fold.action),
        (Street::River, ActionType::Fold)
    );
    assert!(fold.facing_cbet);

    // The counters of a few custom statistics on the hand.
    let count = |text: &str, seat: &SeatEvents| {
        let counts = CustomCounter::parse(text)
            .expect("parses")
            .count(&events, seat);
        (counts.made, counts.opp)
    };
    assert_eq!(
        count(
            "each street != preflop and initiative => action = bet and size_pot >= 60",
            co
        ),
        (2, 3)
    );
    assert_eq!(
        count("first facing_cbet and street = river => action = fold", bb),
        (1, 1)
    );
    assert_eq!(
        count("any facing_size_pot >= 80 => action = call", bb),
        (1, 1)
    );
    assert_eq!(count("each checked_before => action = call", bb), (2, 3));
}

/// A limped pot and a straddle (`02`, `05`, `12`): what `facing`, `limpers`
/// and `posted_blind` say.
#[test]
fn limps_isolation_and_a_straddle() {
    let iso = hand_events(&fixture_hand("05-isolation-raise-is-not-rfi.txt"));
    let raiser = iso
        .seats
        .iter()
        .flat_map(|seat| seat.events.iter())
        .find(|e| e.action == ActionType::Raise)
        .expect("an isolation raise");
    assert_eq!((raiser.facing, raiser.raise_level), (Facing::Limp, 0));
    assert!(raiser.limpers >= 1);

    let straddled = hand_events(&fixture_hand("02-straddle-open-is-not-a-three-bet.txt"));
    assert!(straddled.straddle);
    let open = straddled
        .seats
        .iter()
        .flat_map(|seat| seat.events.iter())
        .find(|e| e.action == ActionType::Raise)
        .expect("an open");
    assert_eq!(
        (open.facing, open.raise_level),
        (Facing::None, 0),
        "a straddle is a blind"
    );
}

/// (R3.9) The card fields: `13-all-in-preflop-is-not-a-cbet-spot.txt` -
/// the hero (CO) holds Ah Qd, the big blind shows Jh Js, nobody else's
/// cards are known. A predicate naming one is card-split.
#[test]
fn card_fields_from_known_hole_cards() {
    let events = hand_events(&fixture_hand("13-all-in-preflop-is-not-a-cbet-spot.txt"));
    let co = seat(&events, Position::Co);
    assert!(co.cards_known);
    assert_eq!((co.pocket_pair, co.suited), (Some(false), Some(false)));
    let bb = seat(&events, Position::Bb);
    assert!(bb.cards_known);
    assert_eq!((bb.pocket_pair, bb.suited), (Some(true), Some(false)));
    let unknown: Vec<&SeatEvents> = events
        .seats
        .iter()
        .filter(|seat| !matches!(seat.position, Some(Position::Co | Position::Bb)))
        .collect();
    assert!(!unknown.is_empty());
    for seat in unknown {
        assert!(!seat.cards_known);
        assert_eq!((seat.pocket_pair, seat.suited), (None, None));
    }

    let pairs = CustomCounter::parse("first street = preflop and pocket_pair => action = raise")
        .expect("parses");
    assert!(pairs.reads_cards());
    let counts = pairs.count_hand(&events);
    assert_eq!(
        counts.iter().map(|c| c.opp).sum::<u32>(),
        1,
        "the big blind only"
    );
    let plain = CustomCounter::parse("first street = preflop => action = raise").expect("parses");
    assert!(!plain.reads_cards());
}
