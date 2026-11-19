//! Heads-up flop games (`flop.ts`): flop betting, a dealt turn, turn betting,
//! a dealt river, river betting, with suit isomorphism on both deals (the
//! river under each turn card's stabiliser, as per-edge mirrors).

use std::collections::HashMap;

use crate::betting::{Build, Street, StreetParams, build_street, dealt_path};
use crate::cards::{card_code, parse_cards, to_range};
use crate::game::{Game, HandSet, Mirror, ShowdownBoard};
use crate::iso::{permute_card, restrict_symmetries, spot_symmetries, symmetrize};
use crate::subgame::{
    BuiltSubgame, HandMaps, SpotInput, classes_of, hands_of, rules_of, strengths, validate_pot,
};
use crate::tree::Edge;
use crate::{SolverInputError, input_error};

pub type FlopSpot = SpotInput;

struct FlopState {
    build: Build,
    chance_path: HashMap<usize, String>,
    pending: Vec<(usize, Vec<Option<Vec<Mirror>>>)>,
    board_ids: HashMap<usize, usize>,
    boards: Vec<ShowdownBoard>,
}

impl AsMut<Build> for FlopState {
    fn as_mut(&mut self) -> &mut Build {
        &mut self.build
    }
}

/// Builds the flop game for a spot (`buildFlopGame`).
///
/// # Errors
/// Bad input.
pub fn build_flop_game(spot: &FlopSpot) -> Result<BuiltSubgame, SolverInputError> {
    let board = parse_cards(&spot.board)?;
    if board.len() != 3 {
        return input_error(format!("expected a 3-card board, got {}", board.len()));
    }
    validate_pot(spot)?;
    let flop_rules = rules_of(spot, &spot.menus, spot.raise_cap)?;
    let turn_menus = spot.turn_menus.as_ref().unwrap_or(&spot.menus);
    let turn_cap = spot.turn_raise_cap.or(spot.raise_cap);
    let turn_rules = rules_of(spot, turn_menus, turn_cap)?;
    let river_rules = rules_of(
        spot,
        spot.river_menus.as_ref().unwrap_or(turn_menus),
        spot.river_raise_cap.or(turn_cap),
    )?;

    let mut r0 = to_range(&spot.ranges[0])?;
    let mut r1 = to_range(&spot.ranges[1])?;
    let group = if spot.isomorphism.unwrap_or(false) {
        restrict_symmetries(
            spot_symmetries(&board, &[&r0, &r1]),
            spot.symmetry.as_deref(),
        )
    } else {
        vec![[0, 1, 2, 3]]
    };
    if group.len() > 1 {
        r0 = symmetrize(&r0, &group);
        r1 = symmetrize(&r1, &group);
    }
    let h0 = hands_of(&r0, &board)?;
    let h1 = hands_of(&r1, &board)?;

    let mut maps = HandMaps::new([&h0.combos, &h1.combos]);
    let turns = classes_of(&board, &group, &mut maps);
    let mut rivers_of: HashMap<u8, Vec<(u8, Vec<Mirror>)>> = HashMap::new();
    for (turn, _) in &turns {
        let stabiliser: Vec<_> = group
            .iter()
            .filter(|p| permute_card(*turn, p) == *turn)
            .copied()
            .collect();
        let mut dead = board.clone();
        dead.push(*turn);
        rivers_of.insert(*turn, classes_of(&dead, &stabiliser, &mut maps));
    }

    let deep = spot.deep_info.unwrap_or(false);
    let first = spot.first_to_act.unwrap_or(0);
    let turn_weight = 1.0 / (52.0 - 3.0 - 4.0);
    let river_weight = 1.0 / (52.0 - 4.0 - 4.0);
    let pot = spot.pot;
    let rake = spot.rake;
    let flop_params = StreetParams {
        street: Street::Flop,
        pot: spot.pot,
        stack: spot.stack,
        rake: spot.rake.as_ref(),
        first,
        rules: &flop_rules,
        record_info: true,
    };
    let turn_params = StreetParams {
        street: Street::Turn,
        rules: &turn_rules,
        record_info: deep,
        ..flop_params
    };
    let river_params = StreetParams {
        street: Street::River,
        rules: &river_rules,
        record_info: deep,
        ..flop_params
    };

    let board_of = |st: &mut FlopState, turn: u8, river: u8| -> usize {
        let key = usize::from(turn) * 64 + usize::from(river);
        if let Some(&id) = st.board_ids.get(&key) {
            return id;
        }
        let id = st.boards.len();
        let mut five = board.clone();
        five.push(turn);
        five.push(river);
        st.boards.push(ShowdownBoard::new(
            &strengths(&h0.cards, &five),
            &strengths(&h1.cards, &five),
        ));
        st.board_ids.insert(key, id);
        id
    };

    let river_deal =
        |st: &mut FlopState, turn: u8, c0: f64, c1: f64, all_in: bool, path: &str| -> usize {
            let classes = &rivers_of[&turn];
            let mut edges = Vec::with_capacity(classes.len());
            for (card, _) in classes {
                let card = *card;
                let child = if all_in {
                    let b = board_of(st, turn, card);
                    st.build.builder.showdown(b, pot, c0, c1, rake.as_ref())
                } else {
                    build_street(
                        st,
                        &river_params,
                        [c0, c1],
                        &dealt_path(path, card),
                        &mut |s2: &mut FlopState, a0, a1, _, _| {
                            let b = board_of(s2, turn, card);
                            s2.build.builder.showdown(b, pot, a0, a1, rake.as_ref())
                        },
                    )
                };
                edges.push(Edge {
                    label: card_code(card),
                    child,
                    card: Some(card),
                });
            }
            let id = st.build.builder.chance(river_weight, &edges);
            st.chance_path.insert(id, path.to_owned());
            st.pending.push((
                id,
                classes
                    .iter()
                    .map(|(_, m)| if m.is_empty() { None } else { Some(m.clone()) })
                    .collect(),
            ));
            id
        };

    let turn_deal = |st: &mut FlopState, c0: f64, c1: f64, all_in: bool, path: &str| -> usize {
        let mut edges = Vec::with_capacity(turns.len());
        for (card, _) in &turns {
            let card = *card;
            let child = if all_in {
                river_deal(st, card, c0, c1, true, &dealt_path(path, card))
            } else {
                build_street(
                    st,
                    &turn_params,
                    [c0, c1],
                    &dealt_path(path, card),
                    &mut |s2: &mut FlopState, a0, a1, all_in2, path2| {
                        river_deal(s2, card, a0, a1, all_in2, path2)
                    },
                )
            };
            edges.push(Edge {
                label: card_code(card),
                child,
                card: Some(card),
            });
        }
        let id = st.build.builder.chance(turn_weight, &edges);
        st.chance_path.insert(id, path.to_owned());
        st.pending.push((
            id,
            turns
                .iter()
                .map(|(_, m)| if m.is_empty() { None } else { Some(m.clone()) })
                .collect(),
        ));
        id
    };

    let mut state = FlopState {
        build: Build::default(),
        chance_path: HashMap::new(),
        pending: Vec::new(),
        board_ids: HashMap::new(),
        boards: Vec::new(),
    };
    let root = build_street(
        &mut state,
        &flop_params,
        [0.0, 0.0],
        "",
        &mut |st: &mut FlopState, c0, c1, all_in, path| turn_deal(st, c0, c1, all_in, path),
    );
    if let Some(e) = state.build.error.take() {
        return Err(e);
    }
    let FlopState {
        build,
        chance_path,
        pending,
        boards,
        ..
    } = state;
    let tree = build.builder.finish(root);

    let mut game = Game {
        edge_mirrors: vec![u32::MAX; tree.children.len()],
        tree,
        mirror_lists: Vec::new(),
        maps: Vec::new(),
        num_cards: 52,
        hands: [
            HandSet::new(0, 52, &h0.cards, &h0.weights),
            HandSet::new(1, 52, &h1.cards, &h1.weights),
        ],
        boards,
        pot: spot.pot,
        big_blind: spot.big_blind,
    };
    if group.len() > 1 {
        // Mirror lists are shared by every deal of the same classes.
        let mut list_ids: HashMap<Vec<(u8, u32)>, u32> = HashMap::new();
        for (node, mirrors) in pending {
            let start = game.tree.child_start[node] as usize;
            for (e, m) in mirrors.into_iter().enumerate() {
                if let Some(m) = m {
                    let key: Vec<(u8, u32)> = m.iter().map(|x| (x.card, x.map)).collect();
                    let id = *list_ids.entry(key).or_insert_with(|| {
                        game.mirror_lists.push(m.clone());
                        (game.mirror_lists.len() - 1) as u32
                    });
                    game.edge_mirrors[start + e] = id;
                }
            }
        }
    }
    game.maps = maps.maps;
    Ok(BuiltSubgame {
        street: Street::Flop,
        game,
        board,
        combos: [h0.combos, h1.combos],
        info: build.info,
        chance_path,
        pot: spot.pot,
        stack: spot.stack,
        first_to_act: first,
        turn_classes: turns.len(),
        group,
    })
}
