//! Small hands for unit tests: a valid-looking two-seat cash hand to mutate.

use super::{
    ActionType, AnteModel, CurrencyKind, CurrencyUnit, GameFormat, LimitType, PhfAction, PhfBoard,
    PhfFees, PhfGame, PhfHand, PhfMarkerLabels, PhfMeta, PhfPlayer, PhfResults, PhfRunout,
    PhfSchema, PhfTable, PhfTextStyle, Street, Variant,
};

/// Two seated players, `alpha` in seat 1 and `bravo` in seat 2, Hold'em,
/// USD, no actions, one empty runout.
pub fn hand() -> PhfHand {
    let player = |seat: u32, name: &str| PhfPlayer {
        seat,
        name: name.to_owned(),
        starting_stack: 1000,
        is_hero: false,
        hole_cards: Vec::new(),
        bounty: None,
        sitting_out: false,
        position: None,
        dealt_announced: false,
        dealt_cards: Vec::new(),
    };
    PhfHand {
        schema: PhfSchema::V1,
        meta: PhfMeta {
            site_id: "test".to_owned(),
            site_name: "Test".to_owned(),
            hand_id: "1".to_owned(),
            hand_key: "test:1".to_owned(),
            original_filename: None,
            parser_id: "test".to_owned(),
            parser_version: "1.0.0".to_owned(),
            warnings: Vec::new(),
            raw_text: String::new(),
            parsed_at: "1970-01-01T00:00:00.000Z".to_owned(),
            text_style: PhfTextStyle::default(),
        },
        game: PhfGame {
            variant: Variant::Holdem,
            limit: LimitType::Nl,
            hi_lo: false,
            format: GameFormat::Cash,
            unit: CurrencyUnit {
                code: "USD".to_owned(),
                symbol: "$".to_owned(),
                minor_units: 100,
                kind: CurrencyKind::Cash,
            },
            small_blind: 5,
            big_blind: 10,
            ante_model: AnteModel::None,
            ante: 0,
            straddles: Vec::new(),
            bomb_pot: None,
            label: "Hold'em No Limit".to_owned(),
        },
        table: PhfTable {
            name: Some("T".to_owned()),
            max_seats: 6,
            button_seat: Some(1),
            fast_fold: None,
        },
        tournament: None,
        players: vec![player(1, "alpha"), player(2, "bravo")],
        actions: Vec::new(),
        chip_movements: None,
        board: PhfBoard {
            runouts: vec![runout(0, None, None, None)],
        },
        results: PhfResults {
            total_pot: 0,
            pots: Vec::new(),
            fees: PhfFees::ZERO,
            players: Vec::new(),
            winners: Vec::new(),
            hero_net: None,
            went_to_showdown: false,
            street_reached: Street::Preflop,
        },
        played_at: None,
    }
}

/// A preflop action.
pub fn action(index: u32, seat: u32, player: &str, kind: ActionType, amount: i64) -> PhfAction {
    PhfAction {
        index,
        street: Street::Preflop,
        runout_index: 0,
        seat: Some(seat),
        player: player.to_owned(),
        kind,
        amount,
        street_total: amount,
        all_in: false,
        cards: None,
        description: None,
        verb: None,
        pot_name: None,
        half: None,
        label: String::new(),
        source_line: None,
        raw_line: String::new(),
    }
}

/// A runout with the given streets.
pub fn runout(
    index: u32,
    flop: Option<&[&str]>,
    turn: Option<&str>,
    river: Option<&str>,
) -> PhfRunout {
    PhfRunout {
        index,
        flop: flop.map(|cards| cards.iter().map(|card| (*card).to_owned()).collect()),
        turn: turn.map(str::to_owned),
        river: river.map(str::to_owned),
        marker_labels: PhfMarkerLabels::default(),
        summary_cards: None,
    }
}
