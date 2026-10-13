//! Money per seat: `frontend/src/lib/stats/money.ts`.
//!
//! The identity the engine is pinned to (docs/STATS-SPEC.md §7):
//! `Σ net === houseIntoPot(hand) - totalFees(hand.results.fees)`.
//!
//! Sums and differences of amounts are `i64`, exact like the TypeScript's
//! doubles for every amount a PHF can hold (safe integers). The three places
//! the TypeScript divides - [`to_bb_milli`], [`bb_tenths`] and
//! [`largest_remainder`] - are done in [`JsNumber`], the IEEE-754 double
//! emulated in integers, so they round exactly as the browser does.

use std::collections::BTreeMap;

use rail_core::js::JsNumber;
use rail_core::js::sort::sort_by;
use rail_core::phf::{ActionType, Amount, PhfHand, seat_out_of_pot};

use crate::context::StatsContext;
use crate::counters::SeatMoney;

/// The integer a `JsNumber` holds. Every value this module converts is an
/// integer (a `Math.round` or `Math.floor` result, or a sum of them) within
/// the range of any amount a row can carry; `-0` is `0`.
fn integer(value: JsNumber) -> i64 {
    value.to_i64().unwrap_or(0)
}

/// `roundHalfAwayFromZero`: `x < 0 ? -Math.round(-x) : Math.round(x)`.
fn round_half_away_from_zero(value: JsNumber) -> JsNumber {
    if value.less_than(JsNumber::ZERO) {
        -((-value).round())
    } else {
        value.round()
    }
}

/// `toBbMilli`: `amount` in thousandths of a big blind, or 0 when the blind
/// is 0. A result of `-0` (a loss under half a thousandth of a blind) is 0
/// here; the oracle writes it as 0 too (`tests/scripts/golden/stats.ts`).
pub fn to_bb_milli(amount: Amount, big_blind: Amount) -> i64 {
    if big_blind == 0 {
        return 0;
    }
    let value =
        (JsNumber::from_i64(amount) * JsNumber::from_i64(1000)) / JsNumber::from_i64(big_blind);
    integer(round_half_away_from_zero(value))
}

/// `bbTenths` in `derive.ts`: big blinds to one decimal, as tenths.
pub fn bb_tenths(amount: Amount, big_blind: Amount) -> i64 {
    if big_blind == 0 {
        return 0;
    }
    let value =
        (JsNumber::from_i64(amount) * JsNumber::from_i64(10)) / JsNumber::from_i64(big_blind);
    integer(round_half_away_from_zero(value))
}

/// JavaScript truthiness of a number: not `0`, `-0` or `NaN`.
fn truthy(value: JsNumber) -> bool {
    !value.is_nan() && value.compare(JsNumber::ZERO) != Some(std::cmp::Ordering::Equal)
}

/// `largestRemainder`: `total` split across `weights` in proportion, summing
/// to `total` exactly.
///
/// Floors every share, then hands the leftover units to the largest
/// fractional parts, ties to the lower index - computed in doubles, as the
/// TypeScript does, so two fractions a double cannot tell apart tie here too.
pub fn largest_remainder(total: Amount, weights: &[Amount]) -> Vec<Amount> {
    let zero = JsNumber::ZERO;
    let total_js = JsNumber::from_i64(total);
    let clamped: Vec<JsNumber> = weights
        .iter()
        .map(|&weight| zero.max_of(JsNumber::from_i64(weight)))
        .collect();
    let sum = clamped.iter().fold(zero, |acc, &weight| acc + weight);
    if total == 0 || !sum.greater_than(zero) {
        return vec![0; weights.len()];
    }
    let exact: Vec<JsNumber> = clamped
        .iter()
        .map(|&weight| (weight * total_js) / sum)
        .collect();
    let mut shares: Vec<JsNumber> = exact.iter().map(|value| value.floor()).collect();
    let mut left = total_js - shares.iter().fold(zero, |acc, &share| acc + share);
    let mut order: Vec<(usize, JsNumber)> = exact
        .iter()
        .enumerate()
        .map(|(index, &value)| (index, value - value.floor()))
        .collect();
    // `(a, b) => b.fraction - a.fraction || a.index - b.index`
    sort_by(&mut order, |a, b| {
        let by_fraction = b.1 - a.1;
        if truthy(by_fraction) {
            by_fraction
        } else {
            JsNumber::from_u64(u64::try_from(a.0).unwrap_or(u64::MAX))
                - JsNumber::from_u64(u64::try_from(b.0).unwrap_or(u64::MAX))
        }
    });
    let one = JsNumber::from_i64(1);
    for &(index, _) in &order {
        if !left.greater_than(zero) {
            break;
        }
        shares[index] = shares[index] + one;
        left = left - one;
    }
    shares.into_iter().map(integer).collect()
}

/// `contributedBySeat`: every seat's actions summed, except collects and
/// cashout payments (and zero amounts, and seatless actions).
pub fn contributed_by_seat(hand: &PhfHand) -> BTreeMap<u32, Amount> {
    let mut out = BTreeMap::new();
    for action in &hand.actions {
        let Some(seat) = action.seat else {
            continue;
        };
        if action.amount == 0 {
            continue;
        }
        if matches!(action.kind, ActionType::Collect | ActionType::CashoutPay) {
            continue;
        }
        *out.entry(seat).or_insert(0) += action.amount;
    }
    out
}

/// `collectedBySeat`: the collects per seat, across every pot and runout.
pub fn collected_by_seat(hand: &PhfHand) -> BTreeMap<u32, Amount> {
    let mut out = BTreeMap::new();
    for action in &hand.actions {
        if action.kind != ActionType::Collect {
            continue;
        }
        let Some(seat) = action.seat else {
            continue;
        };
        *out.entry(seat).or_insert(0) += action.amount;
    }
    out
}

/// `collectsAreGross`: the collects reconcile with the gross pot rather than
/// the pot less fees (WePlay and friends, §7.1).
fn collects_are_gross(context: &StatsContext<'_>, collected: Amount) -> bool {
    let pot = context.hand.results.total_pot;
    if context.fees <= 0 || pot <= 0 {
        return false;
    }
    let gross_gap = (collected - pot).abs();
    let net_gap = (collected - (pot - context.fees)).abs();
    gross_gap < net_gap
}

/// `moneyBySeat`: money for every dealt-in seat, as `(seat, money)` in
/// `dealtInSeats` order. When two players share a seat number the seat
/// appears twice and, as with the TypeScript's `Map`, the later entry is the
/// one a lookup finds ([`money_for`]).
pub fn money_by_seat(context: &StatsContext<'_>) -> Vec<(u32, SeatMoney)> {
    let hand = context.hand;
    let contributed = contributed_by_seat(hand);
    let collected = collected_by_seat(hand);

    let seats = &context.dealt_in_seats;
    let awards: Vec<Amount> = seats
        .iter()
        .map(|seat| collected.get(seat).copied().unwrap_or(0))
        .collect();
    let total_awarded: Amount = awards.iter().sum();
    let fee_shares = largest_remainder(context.fees, &awards);
    let gross = collects_are_gross(context, total_awarded);

    let mut cashout_risk: BTreeMap<u32, Amount> = BTreeMap::new();
    for result in &hand.results.players {
        if let Some(risk) = result.cashout_risk {
            cashout_risk.insert(result.seat, risk);
        }
    }

    seats
        .iter()
        .zip(fee_shares)
        .map(|(&seat, rake_paid)| {
            let won =
                collected.get(&seat).copied().unwrap_or(0) - if gross { rake_paid } else { 0 };
            let contributed = contributed.get(&seat).copied().unwrap_or(0);
            let net = won - contributed;
            let money = SeatMoney {
                won,
                contributed,
                net,
                net_bb_milli: to_bb_milli(net, context.big_blind),
                rake_paid,
                out_of_pot: seat_out_of_pot(hand, seat),
                cashout_risk: cashout_risk.get(&seat).copied().unwrap_or(0),
            };
            (seat, money)
        })
        .collect()
}

/// `money.get(seat)`: the last entry for the seat.
pub fn money_for(money: &[(u32, SeatMoney)], seat: u32) -> Option<SeatMoney> {
    money
        .iter()
        .rev()
        .find(|(candidate, _)| *candidate == seat)
        .map(|(_, money)| *money)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_half_away_from_zero() {
        assert_eq!(to_bb_milli(1, 2000), 1);
        assert_eq!(to_bb_milli(-1, 2000), -1);
        assert_eq!(to_bb_milli(-1, 3000), 0);
        assert_eq!(to_bb_milli(0, 0), 0);
        assert_eq!(to_bb_milli(150, 100), 1500);
        assert_eq!(bb_tenths(25, 10), 25);
        assert_eq!(bb_tenths(5, 100), 1);
        assert_eq!(bb_tenths(-5, 100), -1);
    }

    #[test]
    fn largest_remainder_sums_exactly() {
        assert_eq!(largest_remainder(10, &[1, 1, 1]), vec![4, 3, 3]);
        assert_eq!(largest_remainder(236, &[3214, 0]), vec![236, 0]);
        assert_eq!(largest_remainder(0, &[1, 2]), vec![0, 0]);
        assert_eq!(largest_remainder(5, &[0, 0]), vec![0, 0]);
        assert_eq!(largest_remainder(7, &[-3, 2, 2]), vec![0, 4, 3]);
        assert_eq!(largest_remainder(-1, &[1, 1]), vec![0, -1]);
    }
}
