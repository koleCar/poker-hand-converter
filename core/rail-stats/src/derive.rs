//! `PhfHand` to [`HandFacts`]: `web/src/lib/stats/derive.ts`.

use std::borrow::Cow;

use rail_core::cards::parse_card;
use rail_core::js;
use rail_core::phf::{
    Amount, GameFormat, LimitType, PhfHand, Position, Street, Variant, card_in_deck,
    hole_card_count,
};
use rail_core::positions::assign_positions;

use crate::context::{StatsContext, build_context};
use crate::counters::{Counter, SeatCounters, SeatMoney};
use crate::money::{bb_tenths, money_by_seat, money_for};
use crate::postflop::{cbet_chain, postflop_counters};
use crate::preflop::preflop_counters;
use crate::showdown::showdown_counters;

/// `STATS_VERSION`: the schema tag stamped on every row. Must equal the
/// TypeScript's (`tests/columns.rs` checks).
pub const STATS_VERSION: &str = "stats/2";

/// `PotType`: what the pot became preflop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PotType {
    Walk,
    Bomb,
    Limped,
    SingleRaised,
    ThreeBet,
    FourBetPlus,
}

impl PotType {
    /// The column value: `"walk"`, `"bomb"`, `"limped"`, `"single-raised"`,
    /// `"3bet"`, `"4bet+"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Walk => "walk",
            Self::Bomb => "bomb",
            Self::Limped => "limped",
            Self::SingleRaised => "single-raised",
            Self::ThreeBet => "3bet",
            Self::FourBetPlus => "4bet+",
        }
    }
}

/// `HandDimensions`: the hand-level facts every row carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandDimensions {
    pub stats_version: &'static str,
    pub hand_key: String,
    pub site_id: String,
    pub hand_id: String,
    pub played_at: Option<String>,
    pub variant: Variant,
    pub limit: LimitType,
    pub format: GameFormat,
    pub currency: String,
    pub currency_minor_units: u32,
    pub small_blind: Amount,
    pub big_blind: Amount,
    /// Seats dealt in (rows of the hand).
    pub player_count: usize,
    pub max_seats: u32,
    pub table_name: Option<String>,
    pub tournament_id: Option<String>,
    pub fast_fold: Option<String>,
    pub has_straddle: bool,
    pub is_bomb_pot: bool,
    pub is_big_blind_ante: bool,
    pub is_run_it_twice: bool,
    pub has_cashout: bool,
    pub is_walk: bool,
    pub street_reached: Street,
    pub pot_type: PotType,
    pub house_into_pot: Amount,
    pub fees: Amount,
    pub total_pot: Amount,
}

/// `SeatFacts`: what one seat was and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatFacts {
    pub seat: u32,
    pub player: String,
    pub is_hero: bool,
    pub position: Option<Position>,
    pub hole_cards: Vec<String>,
    /// `"AKs"` / `"77"`, or `None` for anything but two cards of the deck.
    pub hand_class: Option<String>,
    pub starting_stack: Amount,
    /// Starting stack in big blinds times ten, rounded half away from zero.
    pub starting_stack_bb_tenths: i64,
    pub counters: SeatCounters,
    pub money: SeatMoney,
}

/// `HandFacts`: one hand's dimensions and a [`SeatFacts`] per dealt-in seat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandFacts {
    pub hand: HandDimensions,
    pub seats: Vec<SeatFacts>,
}

/// `handClass` of `lib/cards.ts`: `"AA"`, `"AKs"`, `"AKo"`, or `None` unless
/// exactly two readable cards.
pub fn hand_class(cards: &[String]) -> Option<String> {
    let [a, b] = cards else {
        return None;
    };
    let a = parse_card(a)?;
    let b = parse_card(b)?;
    let (high, low) = if a.rank >= b.rank { (a, b) } else { (b, a) };
    let mut out = String::with_capacity(3);
    out.push(high.rank_char());
    out.push(low.rank_char());
    if high.rank != low.rank {
        out.push(if high.suit == low.suit { 's' } else { 'o' });
    }
    Some(out)
}

/// `classOf`: the class only when the seat holds exactly what the variant
/// deals and every card is in its deck (docs/STATS-SPEC.md §5.2).
fn class_of(hand: &PhfHand, cards: &[String]) -> Option<String> {
    let dealt = hole_card_count(hand.game.variant)?;
    if usize::try_from(dealt).ok() != Some(cards.len()) {
        return None;
    }
    if !cards
        .iter()
        .all(|card| card_in_deck(card, hand.game.variant))
    {
        return None;
    }
    hand_class(cards)
}

/// `potTypeOf`.
pub fn pot_type_of(context: &StatsContext<'_>) -> PotType {
    if context.is_bomb_pot {
        return PotType::Bomb;
    }
    if context.is_walk {
        return PotType::Walk;
    }
    let raises = context
        .street(Street::Preflop)
        .filter(|decision| decision.kind == rail_core::phf::ActionType::Raise)
        .count();
    match raises {
        0 => PotType::Limped,
        1 => PotType::SingleRaised,
        2 => PotType::ThreeBet,
        _ => PotType::FourBetPlus,
    }
}

/// The hand the TypeScript derives from: itself, or - when every position is
/// null and there is a player - a copy with `assignPositions` applied.
///
/// The TypeScript's `buildContext` applies it to the caller's hand in place;
/// the rows are the same either way, and the port leaves the caller's hand
/// alone.
pub fn positioned(hand: &PhfHand) -> Cow<'_, PhfHand> {
    if !hand.players.is_empty() && hand.players.iter().all(|player| player.position.is_none()) {
        let mut owned = hand.clone();
        assign_positions(&mut owned);
        Cow::Owned(owned)
    } else {
        Cow::Borrowed(hand)
    }
}

/// `handFacts`: every counter for every dealt-in seat of one hand.
pub fn hand_facts(hand: &PhfHand) -> HandFacts {
    let hand = positioned(hand);
    facts_of(&hand)
}

fn facts_of(hand: &PhfHand) -> HandFacts {
    let context = build_context(hand);
    let money = money_by_seat(&context);
    let chain = cbet_chain(&context);

    let seats: Vec<SeatFacts> = context
        .dealt_in_seats
        .iter()
        .map(|&seat| {
            let player = context.players.get(&seat).copied();
            let mut counters = SeatCounters::default();
            counters[Counter::hands] = 1;

            let seat_money = money_for(&money, seat).unwrap_or_default();

            preflop_counters(&context, seat, &mut counters);
            postflop_counters(&context, seat, &mut counters, &chain);
            showdown_counters(&context, seat, &mut counters, &seat_money);
            if seat_money.cashout_risk != 0 {
                counters[Counter::cashed_out] = 1;
            }

            let hole_cards: Vec<String> = player
                .map(|player| player.hole_cards.clone())
                .unwrap_or_default();
            let starting_stack = player.map_or(0, |player| player.starting_stack);
            SeatFacts {
                seat,
                player: player.map(|player| player.name.clone()).unwrap_or_default(),
                is_hero: player.is_some_and(|player| player.is_hero),
                position: context.position.get(&seat).copied().flatten(),
                hand_class: class_of(hand, &hole_cards),
                hole_cards,
                starting_stack,
                starting_stack_bb_tenths: bb_tenths(starting_stack, context.big_blind),
                counters,
                money: seat_money,
            }
        })
        .collect();

    let meta = &hand.meta;
    let hand_key = format!(
        "{}:{}",
        js::to_lower_case(js::trim(&meta.site_id)),
        if meta.hand_key.is_empty() {
            &meta.hand_id
        } else {
            &meta.hand_key
        }
    );
    let dimensions = HandDimensions {
        stats_version: STATS_VERSION,
        hand_key,
        site_id: meta.site_id.clone(),
        hand_id: meta.hand_id.clone(),
        played_at: hand.played_at.clone(),
        variant: hand.game.variant,
        limit: hand.game.limit,
        format: hand.game.format,
        currency: hand.game.unit.code.clone(),
        currency_minor_units: hand.game.unit.minor_units,
        small_blind: hand.game.small_blind,
        big_blind: hand.game.big_blind,
        player_count: context.dealt_in_seats.len(),
        max_seats: hand.table.max_seats,
        table_name: hand.table.name.clone(),
        tournament_id: hand
            .tournament
            .as_ref()
            .map(|tournament| tournament.id.clone()),
        fast_fold: hand.table.fast_fold.clone().flatten(),
        has_straddle: context.has_straddle,
        is_bomb_pot: context.is_bomb_pot,
        is_big_blind_ante: context.is_big_blind_ante,
        is_run_it_twice: context.is_run_it_twice,
        has_cashout: context.has_cashout,
        is_walk: context.is_walk,
        street_reached: context.street_reached,
        pot_type: pot_type_of(&context),
        house_into_pot: context.house_into_pot,
        fees: context.fees,
        total_pot: hand.results.total_pot,
    };

    HandFacts {
        hand: dimensions,
        seats,
    }
}

#[cfg(test)]
mod tests {
    use super::hand_class;

    fn class(cards: &[&str]) -> Option<String> {
        hand_class(&cards.iter().map(|&c| c.to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn hand_classes_are_the_hold_em_notation() {
        assert_eq!(class(&["Ah", "Kh"]).as_deref(), Some("AKs"));
        assert_eq!(class(&["Kd", "Ah"]).as_deref(), Some("AKo"));
        assert_eq!(class(&["7c", "7d"]).as_deref(), Some("77"));
        assert_eq!(class(&["ah", "tH"]).as_deref(), Some("ATs"));
        assert_eq!(class(&["Ah"]), None);
        assert_eq!(class(&["Ah", "Xx"]), None);
        assert_eq!(class(&["Ah", "Kh", "Qh"]), None);
    }
}
