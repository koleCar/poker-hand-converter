//! Hand helpers: the action, board, chip-movement, fee and lookup functions of
//! `frontend/src/lib/phf/types.ts`, with the same names in snake case.
//!
//! Where the TypeScript leans on JavaScript truthiness the port spells it out:
//! a runout's `turn: ""` counts as no turn (`turn ? [turn] : []`), while a
//! runout's `flop: []` counts as a flop (an empty array is truthy).

use super::{
    ActionType, Amount, BUTTON_BLIND_VERB, PhfAction, PhfBoard, PhfFees, PhfHand, PhfPlayer, Street,
};
use crate::phf::game::map_set;

/// `isPostingAction`: posting actions happen before the deal and are animated
/// as one block.
pub fn is_posting_action(kind: ActionType) -> bool {
    matches!(
        kind,
        ActionType::Ante
            | ActionType::SmallBlind
            | ActionType::BigBlind
            | ActionType::Straddle
            | ActionType::Post
            | ActionType::MissedBlind
            | ActionType::BombAnte
    )
}

/// `isButtonBlind`: a `big-blind` posting whose verb is GG's
/// [`BUTTON_BLIND_VERB`] - the one blind of an ante-only short-deck table.
pub fn is_button_blind(action: &PhfAction) -> bool {
    action.kind == ActionType::BigBlind && action.verb.as_deref() == Some(BUTTON_BLIND_VERB)
}

/// JavaScript truthiness of an optional string.
fn present(card: Option<&String>) -> Option<&String> {
    card.filter(|card| !card.is_empty())
}

/// `resolveRunout(board, index)`: runout `index` resolved against runout 0,
/// up to five card codes. An index past the end resolves runout 0.
pub fn resolve_runout(board: &PhfBoard, index: usize) -> Vec<String> {
    let base = board.runouts.first();
    let Some(run) = board.runouts.get(index).or(base) else {
        return Vec::new();
    };
    let flop = run
        .flop
        .as_ref()
        .or_else(|| base.and_then(|b| b.flop.as_ref()));
    let turn = run
        .turn
        .as_ref()
        .or_else(|| base.and_then(|b| b.turn.as_ref()));
    let river = run
        .river
        .as_ref()
        .or_else(|| base.and_then(|b| b.river.as_ref()));
    let mut cards: Vec<String> = flop.cloned().unwrap_or_default();
    cards.extend(present(turn).cloned());
    cards.extend(present(river).cloned());
    cards
}

/// `runoutThroughStreet(board, index, street)`: the cards of runout `index`
/// visible at the end of `street`.
pub fn runout_through_street(board: &PhfBoard, index: usize, street: Street) -> Vec<String> {
    let mut cards = resolve_runout(board, index);
    let visible = match street {
        Street::Preflop => 0,
        Street::Flop => 3,
        Street::Turn => 4,
        Street::River | Street::Showdown => 5,
    };
    cards.truncate(visible);
    cards
}

/// `houseIntoPot`: chips the house added to the pot, which nobody contributed.
pub fn house_into_pot(hand: &PhfHand) -> Amount {
    hand.chip_movements
        .iter()
        .flatten()
        .filter(|movement| movement.to_pot && movement.from_seat.is_none())
        .map(|movement| movement.amount)
        .sum()
}

/// `seatOutOfPot`: chips a seat paid out of its stack without them entering
/// the pot.
pub fn seat_out_of_pot(hand: &PhfHand, seat: u32) -> Amount {
    hand.chip_movements
        .iter()
        .flatten()
        .filter(|movement| !movement.to_pot && movement.from_seat == Some(seat))
        .map(|movement| movement.amount)
        .sum()
}

/// `totalFees`.
pub fn total_fees(fees: &PhfFees) -> Amount {
    fees.rake + fees.jackpot + fees.bingo + fees.fortune + fees.tax + fees.other
}

/// `heroOf`: the first player marked as hero.
pub fn hero_of(hand: &PhfHand) -> Option<&PhfPlayer> {
    hand.players.iter().find(|player| player.is_hero)
}

/// `playerBySeat`.
pub fn player_by_seat(hand: &PhfHand, seat: u32) -> Option<&PhfPlayer> {
    hand.players.iter().find(|player| player.seat == seat)
}

/// `playerByName`.
pub fn player_by_name<'a>(hand: &'a PhfHand, name: &str) -> Option<&'a PhfPlayer> {
    hand.players.iter().find(|player| player.name == name)
}

/// `primaryBoard`: the runout the replayer shows by default.
pub fn primary_board(hand: &PhfHand) -> Vec<String> {
    resolve_runout(&hand.board, 0)
}

/// `secondBoard`: the second runout, or empty when the hand was run once.
pub fn second_board(hand: &PhfHand) -> Vec<String> {
    if hand.board.runouts.len() > 1 {
        resolve_runout(&hand.board, 1)
    } else {
        Vec::new()
    }
}

/// `allCards`: every card dealt in the hand; a later runout counts only the
/// streets it re-dealt.
pub fn all_cards(hand: &PhfHand) -> Vec<String> {
    let mut cards: Vec<String> = Vec::new();
    for player in &hand.players {
        cards.extend(player.hole_cards.iter().cloned());
    }
    for (i, run) in hand.board.runouts.iter().enumerate() {
        let resolved = resolve_runout(&hand.board, i);
        if i == 0 {
            cards.extend(resolved);
            continue;
        }
        if run.flop.is_some() {
            cards.extend(resolved.into_iter().take(3));
        }
        cards.extend(present(run.turn.as_ref()).cloned());
        cards.extend(present(run.river.as_ref()).cloned());
    }
    cards
}

/// `contributionsFromActions`: what each player put in, net of uncalled
/// returns, from the action stream - as `(player, amount)` pairs in the order
/// the TypeScript `Map` iterates them (first appearance).
pub fn contributions_from_actions(hand: &PhfHand) -> Vec<(String, Amount)> {
    let mut out: Vec<(String, Amount)> = Vec::new();
    for action in &hand.actions {
        if matches!(action.kind, ActionType::Collect | ActionType::CashoutPay) || action.amount == 0
        {
            continue;
        }
        let total = out
            .iter()
            .find(|(player, _)| *player == action.player)
            .map_or(0, |(_, amount)| *amount);
        map_set(&mut out, action.player.clone(), total + action.amount);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phf::test_support::{action, hand, runout};
    use crate::phf::{ChipMovementAnchor, PhfChipMovement};

    #[test]
    fn posting_actions_are_the_pre_deal_block() {
        assert!(is_posting_action(ActionType::Ante));
        assert!(is_posting_action(ActionType::BombAnte));
        assert!(is_posting_action(ActionType::MissedBlind));
        assert!(!is_posting_action(ActionType::Call));
        assert!(!is_posting_action(ActionType::Collect));
    }

    #[test]
    fn a_button_blind_is_a_big_blind_with_gg_s_verb() {
        let mut blind = action(0, 1, "Hero", ActionType::BigBlind, 2);
        assert!(!is_button_blind(&blind));
        blind.verb = Some(BUTTON_BLIND_VERB.to_owned());
        assert!(is_button_blind(&blind));
        blind.kind = ActionType::SmallBlind;
        assert!(!is_button_blind(&blind));
    }

    #[test]
    fn resolves_runouts_against_the_first() {
        let mut board = PhfBoard {
            runouts: vec![
                runout(0, Some(&["Ah", "Kd", "2c"]), Some("7s"), Some("9h")),
                runout(1, None, None, Some("Qc")),
            ],
        };
        assert_eq!(resolve_runout(&board, 0), ["Ah", "Kd", "2c", "7s", "9h"]);
        assert_eq!(resolve_runout(&board, 1), ["Ah", "Kd", "2c", "7s", "Qc"]);
        assert_eq!(resolve_runout(&board, 5), resolve_runout(&board, 0));
        assert_eq!(
            runout_through_street(&board, 1, Street::Turn),
            ["Ah", "Kd", "2c", "7s"]
        );
        assert!(runout_through_street(&board, 1, Street::Preflop).is_empty());
        // `turn: ""` is falsy in JavaScript; it is no turn.
        board.runouts[1].turn = Some(String::new());
        assert_eq!(resolve_runout(&board, 1), ["Ah", "Kd", "2c", "Qc"]);
        assert!(resolve_runout(&PhfBoard { runouts: vec![] }, 0).is_empty());
    }

    #[test]
    fn counts_every_dealt_card_once() {
        let mut h = hand();
        h.players[0].hole_cards = vec!["As".into(), "Ks".into()];
        h.board.runouts = vec![
            runout(0, Some(&["Ah", "Kd", "2c"]), Some("7s"), Some("9h")),
            runout(1, None, None, Some("Qc")),
            runout(2, Some(&[]), Some(""), Some("Jc")),
        ];
        // Runout 2's `flop: []` is truthy, so its resolved cards are counted -
        // and they are only the river, `""` being no turn - and then its river
        // again: the TypeScript reports `Jc` twice, and so does the port.
        assert_eq!(
            all_cards(&h),
            ["As", "Ks", "Ah", "Kd", "2c", "7s", "9h", "Qc", "Jc", "Jc"]
        );
        assert_eq!(primary_board(&h).len(), 5);
        assert_eq!(second_board(&h), ["Ah", "Kd", "2c", "7s", "Qc"]);
    }

    #[test]
    fn sums_chips_that_move_outside_the_bet_path() {
        let mut h = hand();
        let movement = |from_seat: Option<u32>, to_pot, amount| PhfChipMovement {
            kind: "x".into(),
            from_seat,
            from_player: None,
            to_pot,
            amount,
            raw: None,
            anchor: ChipMovementAnchor::BeforePostings,
        };
        assert_eq!(house_into_pot(&h), 0);
        h.chip_movements = Some(vec![
            movement(None, true, 50),
            movement(Some(2), false, 2),
            movement(Some(2), true, 7),
            movement(None, true, 5),
        ]);
        assert_eq!(house_into_pot(&h), 55);
        assert_eq!(seat_out_of_pot(&h, 2), 2);
        assert_eq!(seat_out_of_pot(&h, 1), 0);
    }

    #[test]
    fn totals_fees_and_finds_players() {
        let fees = PhfFees {
            rake: 1,
            jackpot: 2,
            bingo: 3,
            fortune: 4,
            tax: 5,
            other: 6,
        };
        assert_eq!(total_fees(&fees), 21);
        assert_eq!(total_fees(&PhfFees::ZERO), 0);
        let mut h = hand();
        assert!(hero_of(&h).is_none());
        h.players[1].is_hero = true;
        assert_eq!(hero_of(&h).map(|p| p.seat), Some(2));
        assert_eq!(
            player_by_seat(&h, 1).map(|p| p.name.as_str()),
            Some("alpha")
        );
        assert_eq!(player_by_name(&h, "bravo").map(|p| p.seat), Some(2));
        assert!(player_by_name(&h, "nobody").is_none());
    }

    #[test]
    fn contributions_follow_the_stream_in_first_appearance_order() {
        let mut h = hand();
        h.actions = vec![
            action(0, 2, "bravo", ActionType::SmallBlind, 5),
            action(1, 1, "alpha", ActionType::BigBlind, 10),
            action(2, 2, "bravo", ActionType::Fold, 0),
            action(3, 1, "alpha", ActionType::Uncalled, -5),
            action(4, 1, "alpha", ActionType::Collect, 10),
        ];
        assert_eq!(
            contributions_from_actions(&h),
            vec![("bravo".to_owned(), 5), ("alpha".to_owned(), 5)]
        );
    }
}
