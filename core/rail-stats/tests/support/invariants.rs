//! `tests/test/support/statsInvariants.ts`, ported: properties every correct
//! derivation has, each a pure function from a hand to a list of problems.
//! No known-good reference is needed (docs/STATS-SPEC.md §9).

use rail_core::phf::serialize::{StandardContext, parse_standard_hand, to_standard_text};
use rail_core::phf::{ActionType, PhfHand, house_into_pot, total_fees};
use rail_stats::{
    COUNTER_KEYS, Counter, HandFacts, LEG_SETS, OPPORTUNITY_PAIRS, STREET_CHAINS, hand_facts,
    rows_for, stats_columns,
};

/// One minor unit of slack, as the PHF validator and the TypeScript allow.
const TOLERANCE: i64 = 1;

/// `PREFLOP_KEYS`: the counters the round trip compares alongside money, and
/// that cap at 1.
const PREFLOP_KEYS: [Counter; 35] = {
    use Counter as C;
    [
        C::hands,
        C::vpip_opp,
        C::vpip,
        C::pfr_opp,
        C::pfr,
        C::rfi_opp,
        C::rfi,
        C::iso_opp,
        C::iso,
        C::limp_opp,
        C::limp,
        C::cold_call_opp,
        C::cold_call,
        C::three_bet_opp,
        C::three_bet,
        C::four_bet_opp,
        C::four_bet,
        C::five_bet_opp,
        C::five_bet,
        C::squeeze_opp,
        C::squeeze,
        C::steal_opp,
        C::steal,
        C::fold_to_steal_opp,
        C::fold_to_steal,
        C::call_steal,
        C::three_bet_vs_steal,
        C::fold_to_three_bet_opp,
        C::fold_to_three_bet,
        C::call_three_bet,
        C::raise_vs_three_bet,
        C::fold_to_four_bet_opp,
        C::fold_to_four_bet,
        C::call_four_bet,
        C::raise_vs_four_bet,
    ]
};

fn has_cashout_pay(hand: &PhfHand) -> bool {
    hand.actions
        .iter()
        .any(|action| action.kind == ActionType::CashoutPay)
}

/// `moneyConservation`: `Σ net === houseIntoPot - totalFees`, within one unit.
pub fn money_conservation(hand: &PhfHand) -> Vec<String> {
    if has_cashout_pay(hand) {
        return Vec::new();
    }
    let facts = hand_facts(hand);
    let net: i64 = facts.seats.iter().map(|seat| seat.money.net).sum();
    let expected = house_into_pot(hand) - total_fees(&hand.results.fees);
    if (net - expected).abs() > TOLERANCE {
        vec![format!(
            "{}: seats net {net}, house dropped {} less fees {} = {expected}",
            hand.meta.hand_id,
            house_into_pot(hand),
            total_fees(&hand.results.fees)
        )]
    } else {
        Vec::new()
    }
}

/// `potReconciles`: `Σ contributed === totalPot - houseIntoPot`, within one unit.
pub fn pot_reconciles(hand: &PhfHand) -> Vec<String> {
    if has_cashout_pay(hand) {
        return Vec::new();
    }
    let facts = hand_facts(hand);
    let contributed: i64 = facts.seats.iter().map(|seat| seat.money.contributed).sum();
    let expected = hand.results.total_pot - house_into_pot(hand);
    if (contributed - expected).abs() > TOLERANCE {
        vec![format!(
            "{}: seats put in {contributed}, pot less house money is {expected}",
            hand.meta.hand_id
        )]
    } else {
        Vec::new()
    }
}

/// `rakeSharesSum`: the fee shares add up to the fees exactly.
pub fn rake_shares_sum(hand: &PhfHand) -> Vec<String> {
    let facts = hand_facts(hand);
    let shares: i64 = facts.seats.iter().map(|seat| seat.money.rake_paid).sum();
    let fees = total_fees(&hand.results.fees);
    let awarded: i64 = facts.seats.iter().map(|seat| seat.money.won).sum();
    if awarded <= 0 {
        return if shares == 0 {
            Vec::new()
        } else {
            vec![format!(
                "{}: fees split over an unawarded pot",
                hand.meta.hand_id
            )]
        };
    }
    if shares == fees {
        Vec::new()
    } else {
        vec![format!(
            "{}: fee shares sum to {shares}, fees are {fees}",
            hand.meta.hand_id
        )]
    }
}

/// `counterStructure`: `made <= opp`, leg sets sum exactly, chains are
/// monotone, preflop counters cap at 1, a bomb pot has no preflop
/// opportunity. (Non-negative integers are the type's guarantee here.)
pub fn counter_structure(hand: &PhfHand) -> Vec<String> {
    let facts = hand_facts(hand);
    let mut problems = Vec::new();
    for seat in &facts.seats {
        let label = format!("{} seat {}", hand.meta.hand_id, seat.seat);
        let c = &seat.counters;
        for (opp, made) in OPPORTUNITY_PAIRS {
            if c[made] > c[opp] {
                problems.push(format!(
                    "{label}: {} {} > {} {}",
                    made.name(),
                    c[made],
                    opp.name(),
                    c[opp]
                ));
            }
        }
        for (opp, legs) in LEG_SETS {
            let sum: u32 = legs.iter().map(|&leg| c[leg]).sum();
            if sum != c[opp] {
                problems.push(format!(
                    "{label}: {} = {sum}, but {} = {}",
                    legs.map(Counter::name).join(" + "),
                    opp.name(),
                    c[opp]
                ));
            }
        }
        for chain in STREET_CHAINS {
            for pair in chain.windows(2) {
                if c[pair[1]] > c[pair[0]] {
                    problems.push(format!(
                        "{label}: {} {} > {} {}",
                        pair[1].name(),
                        c[pair[1]],
                        pair[0].name(),
                        c[pair[0]]
                    ));
                }
            }
        }
        for key in PREFLOP_KEYS {
            if c[key] > 1 {
                problems.push(format!(
                    "{label}: {} is {}, but preflop counters cap at 1",
                    key.name(),
                    c[key]
                ));
            }
        }
        if facts.hand.is_bomb_pot && c[Counter::vpip_opp] != 0 {
            problems.push(format!("{label}: bomb pot with a preflop opportunity"));
        }
    }
    problems
}

/// `outOfPotLossIsExplained`: `out_of_pot` only with a chip movement that
/// bypassed the pot.
pub fn out_of_pot_loss_is_explained(hand: &PhfHand) -> Vec<String> {
    let facts = hand_facts(hand);
    if !facts.seats.iter().any(|seat| seat.money.out_of_pot != 0) {
        return Vec::new();
    }
    let explained = hand
        .chip_movements
        .iter()
        .flatten()
        .any(|movement| !movement.to_pot && movement.from_seat.is_some());
    if explained {
        Vec::new()
    } else {
        vec![format!(
            "{}: a seat paid out of pot with no chip movement to explain it",
            hand.meta.hand_id
        )]
    }
}

/// `comparable`: money (less `out_of_pot`) and the preflop counters per seat,
/// sorted by seat.
fn comparable(facts: &HandFacts) -> Vec<(u32, String, Vec<i64>, Vec<u32>)> {
    let mut out: Vec<_> = facts
        .seats
        .iter()
        .map(|seat| {
            let money = seat
                .money
                .columns()
                .iter()
                .filter(|(key, _)| *key != "out_of_pot")
                .map(|(_, value)| *value)
                .collect();
            let preflop = PREFLOP_KEYS.iter().map(|&key| seat.counters[key]).collect();
            (seat.seat, seat.player.clone(), money, preflop)
        })
        .collect();
    out.sort_by_key(|entry| entry.0);
    out
}

const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: "1970-01-01T00:00:00.000Z",
};

/// `roundTripFacts`: money and the preflop counters survive standard text.
pub fn round_trip_facts(hand: &PhfHand) -> Vec<String> {
    let back = match parse_standard_hand(&to_standard_text(hand), &CTX) {
        Ok(Some(back)) => back,
        Ok(None) => {
            return vec![format!(
                "{}: serialized text does not parse back",
                hand.meta.hand_id
            )];
        }
        Err(error) => return vec![format!("{}: {error}", hand.meta.hand_id)],
    };
    let before = comparable(&hand_facts(hand));
    let after = comparable(&hand_facts(&back));
    if before == after {
        Vec::new()
    } else {
        vec![format!(
            "{}: facts changed on round trip\n  before {before:?}\n  after  {after:?}",
            hand.meta.hand_id
        )]
    }
}

/// `deterministic`: two derivations are identical, and the hand is not
/// touched (the TypeScript's `assignPositions` guard).
pub fn deterministic(hand: &PhfHand) -> Vec<String> {
    let copy = hand.clone();
    let first = hand_facts(hand);
    let second = hand_facts(hand);
    if first != second || copy != *hand {
        vec![format!("{}: two derivations differ", hand.meta.hand_id)]
    } else {
        Vec::new()
    }
}

/// `rowSchema`: every row has exactly the checked-in columns.
pub fn row_schema(hand: &PhfHand) -> Vec<String> {
    let mut expected = stats_columns();
    expected.sort_unstable();
    for row in rows_for(hand) {
        let value = row.to_json();
        let keys: Vec<&str> = value
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        if sorted != expected {
            return vec![format!("{}: row columns drifted", hand.meta.hand_id)];
        }
    }
    assert_eq!(COUNTER_KEYS.len(), Counter::ALL.len());
    Vec::new()
}

/// `allStatsInvariants`.
pub fn all_stats_invariants(hand: &PhfHand) -> Vec<String> {
    [
        money_conservation(hand),
        pot_reconciles(hand),
        rake_shares_sum(hand),
        counter_structure(hand),
        out_of_pot_loss_is_explained(hand),
        deterministic(hand),
        row_schema(hand),
        round_trip_facts(hand),
    ]
    .concat()
}
