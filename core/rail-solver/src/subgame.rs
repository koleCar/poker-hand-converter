//! Heads-up hold'em subgames (`subgame.ts`): the river, and the turn with the
//! river dealt. Shares the spot input and the hand helpers with `flop.rs`.

use std::collections::HashMap;

use rail_core::eval::{STANDARD, evaluate_masks};

use crate::betting::{
    BetMenu, BettingRules, Build, NodeInfo, Street, StreetParams, build_street, dealt_path,
};
use crate::cards::{
    CardInput, NUM_COMBOS, RangeInput, card_code, combo_hi, combo_lo, parse_cards, to_range,
};
use crate::game::{Game, HandSet, Mirror, ShowdownBoard};
use crate::iso::{
    Perm, card_orbit, permute_card, permute_combo, restrict_symmetries, spot_symmetries, symmetrize,
};
use crate::tree::{Edge, Rake};
use crate::{SolverInputError, input_error};

/// `SpotInput` + the turn and flop extras (`TurnSpot`, `FlopSpot`): one
/// struct for all three streets, as the TypeScript sends it.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotInput {
    pub board: Vec<CardInput>,
    pub ranges: [RangeInput; 2],
    pub pot: f64,
    pub stack: f64,
    #[serde(default)]
    pub first_to_act: Option<u8>,
    pub menus: [BetMenu; 2],
    #[serde(default)]
    pub raise_cap: Option<u32>,
    #[serde(default)]
    pub all_in_threshold: Option<f64>,
    #[serde(default)]
    pub min_bet: Option<f64>,
    #[serde(default)]
    pub rake: Option<Rake>,
    #[serde(default)]
    pub big_blind: Option<f64>,
    #[serde(default)]
    pub turn_menus: Option<[BetMenu; 2]>,
    #[serde(default)]
    pub river_menus: Option<[BetMenu; 2]>,
    #[serde(default)]
    pub turn_raise_cap: Option<u32>,
    #[serde(default)]
    pub river_raise_cap: Option<u32>,
    #[serde(default)]
    pub isomorphism: Option<bool>,
    /// Nodes offering their own actions (`nodeActions`): a nodelock's custom sizes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_actions: Option<std::collections::BTreeMap<String, Vec<String>>>,
    /// Flop games: keep the turn and river nodes' info (tests).
    #[serde(default)]
    pub deep_info: Option<bool>,
    /// With `isomorphism`: only these suit relabellings may be used (a
    /// nodelock keeps those it is invariant under, `lock_symmetries`).
    #[serde(default)]
    pub symmetry: Option<Vec<Perm>>,
}

/// A subgame ready for the engine (`BuiltSubgame`).
#[derive(Debug)]
pub struct BuiltSubgame {
    pub street: Street,
    pub game: Game,
    pub board: Vec<u8>,
    /// `combos[p][i]`: combo index of player p's hand i.
    pub combos: [Vec<u16>; 2],
    pub info: HashMap<usize, NodeInfo>,
    pub chance_path: HashMap<usize, String>,
    pub pot: f64,
    pub stack: f64,
    pub first_to_act: u8,
    /// Suit permutations the game was built under (identity only when none).
    pub group: Vec<Perm>,
    /// Flop games: turn classes dealt.
    pub turn_classes: usize,
}

/// `rulesOf`.
///
/// # Errors
/// A size that is not a positive finite fraction.
pub fn rules_of(
    spot: &SpotInput,
    menus: &[BetMenu; 2],
    raise_cap: Option<u32>,
) -> Result<BettingRules, SolverInputError> {
    for menu in menus {
        for &x in menu.bet.iter().chain(&menu.raise) {
            if !(x > 0.0) || !x.is_finite() {
                return input_error(format!(
                    "bet sizes are positive fractions of the pot, got {x}"
                ));
            }
        }
    }
    Ok(BettingRules {
        menus: menus.clone(),
        raise_cap: raise_cap.unwrap_or(2),
        all_in_threshold: spot.all_in_threshold.unwrap_or(0.0),
        min_bet: spot.min_bet.unwrap_or(0.0),
        node_actions: spot.node_actions.clone(),
    })
}

pub(crate) fn validate_pot(spot: &SpotInput) -> Result<(), SolverInputError> {
    if !(spot.pot > 0.0) || !(spot.stack >= 0.0) {
        return input_error("pot must be positive and stack non-negative");
    }
    if let Some(r) = &spot.rake
        && (!(r.percent >= 0.0 && r.percent < 1.0) || !(r.cap >= 0.0))
    {
        return input_error("rake percent is a fraction in [0, 1) and the cap non-negative");
    }
    Ok(())
}

fn validate(spot: &SpotInput, cards: usize) -> Result<Vec<u8>, SolverInputError> {
    let board = parse_cards(&spot.board)?;
    if board.len() != cards {
        return input_error(format!(
            "expected a {cards}-card board, got {}",
            board.len()
        ));
    }
    validate_pot(spot)?;
    Ok(board)
}

/// The combos of a range that do not touch the board (`handsOf`).
#[derive(Debug)]
pub struct Hands {
    pub combos: Vec<u16>,
    pub cards: Vec<(i32, i32)>,
    pub weights: Vec<f64>,
}

/// # Errors
/// A range that is empty once the board's cards are removed.
pub fn hands_of(range: &[f64], board: &[u8]) -> Result<Hands, SolverInputError> {
    let mut out = Hands {
        combos: Vec::new(),
        cards: Vec::new(),
        weights: Vec::new(),
    };
    for (c, &w) in range.iter().enumerate().take(NUM_COMBOS) {
        let hi = combo_hi(c);
        let lo = combo_lo(c);
        if w > 0.0 && !board.contains(&hi) && !board.contains(&lo) {
            out.combos.push(c as u16);
            out.cards.push((i32::from(hi), i32::from(lo)));
            out.weights.push(w);
        }
    }
    if out.combos.is_empty() {
        return input_error("a range is empty once the board's cards are removed");
    }
    Ok(out)
}

/// Evaluator values of every hand on a five-card board; NaN where a hand holds a board card.
#[must_use]
pub fn strengths(cards: &[(i32, i32)], board: &[u8]) -> Vec<f64> {
    let mut masks = [0_u32; 4];
    for &card in board {
        masks[usize::from(card & 3)] |= 1 << (card >> 2);
    }
    cards
        .iter()
        .map(|&(a, b)| {
            let (a, b) = (a as u8, b as u8);
            if board.contains(&a) || board.contains(&b) {
                return f64::NAN;
            }
            let mut m = masks;
            m[usize::from(a & 3)] |= 1 << (a >> 2);
            m[usize::from(b & 3)] |= 1 << (b >> 2);
            f64::from(evaluate_masks(&STANDARD, m[0], m[1], m[2], m[3]))
        })
        .collect()
}

pub(crate) struct State {
    pub build: Build,
    pub chance_path: HashMap<usize, String>,
}

impl AsMut<Build> for State {
    fn as_mut(&mut self) -> &mut Build {
        &mut self.build
    }
}

/// Builds the river game for a spot (`buildRiverGame`).
///
/// # Errors
/// Bad input.
pub fn build_river_game(spot: &SpotInput) -> Result<BuiltSubgame, SolverInputError> {
    let board = validate(spot, 5)?;
    let rules = rules_of(spot, &spot.menus, spot.raise_cap)?;
    let h0 = hands_of(&to_range(&spot.ranges[0])?, &board)?;
    let h1 = hands_of(&to_range(&spot.ranges[1])?, &board)?;
    let first = spot.first_to_act.unwrap_or(0);
    let mut state = State {
        build: Build::default(),
        chance_path: HashMap::new(),
    };
    let params = StreetParams {
        street: Street::River,
        pot: spot.pot,
        stack: spot.stack,
        rake: spot.rake.as_ref(),
        first,
        rules: &rules,
        record_info: true,
    };
    let pot = spot.pot;
    let rake = spot.rake;
    let root = build_street(
        &mut state,
        &params,
        [0.0, 0.0],
        "",
        &mut |st: &mut State, c0, c1, _, _| {
            st.build.builder.showdown(0, pot, c0, c1, rake.as_ref())
        },
    );
    let boards = vec![ShowdownBoard::new(
        &strengths(&h0.cards, &board),
        &strengths(&h1.cards, &board),
    )];
    if let Some(e) = state.build.error.take() {
        return Err(e);
    }
    let tree = state.build.builder.finish(root);
    let game = Game {
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
    Ok(BuiltSubgame {
        street: Street::River,
        game,
        board,
        combos: [h0.combos, h1.combos],
        info: state.build.info,
        chance_path: HashMap::new(),
        pot: spot.pot,
        stack: spot.stack,
        first_to_act: first,
        group: vec![[0, 1, 2, 3]],
        turn_classes: 0,
    })
}

/// Hand relabelling per permutation, cached (`mapOf` in `flop.ts`).
pub(crate) struct HandMaps {
    lookup: [Vec<i32>; 2],
    combos: [Vec<u16>; 2],
    by_perm: Vec<(Perm, u32)>,
    pub maps: Vec<[Vec<u32>; 2]>,
}

impl HandMaps {
    pub fn new(combos: [&[u16]; 2]) -> Self {
        let lookup = combos.map(|cs| {
            let mut at = vec![-1_i32; NUM_COMBOS];
            for (i, &c) in cs.iter().enumerate() {
                at[usize::from(c)] = i as i32;
            }
            at
        });
        Self {
            lookup,
            combos: [combos[0].to_vec(), combos[1].to_vec()],
            by_perm: Vec::new(),
            maps: Vec::new(),
        }
    }

    /// # Panics
    /// When a range is not symmetric under `perm` (the caller symmetrised it).
    pub fn of(&mut self, perm: &Perm) -> u32 {
        if let Some((_, k)) = self.by_perm.iter().find(|(p, _)| p == perm) {
            return *k;
        }
        let map = [0, 1].map(|p: usize| {
            self.combos[p]
                .iter()
                .map(|&combo| {
                    let index = self.lookup[p][permute_combo(usize::from(combo), perm)];
                    assert!(
                        index >= 0,
                        "isomorphism: a range is not symmetric after symmetrising"
                    );
                    index as u32
                })
                .collect::<Vec<u32>>()
        });
        let k = self.maps.len() as u32;
        self.maps.push(map);
        self.by_perm.push((*perm, k));
        k
    }
}

/// One card per orbit of `sub` among the cards not dead: the lowest deals,
/// the rest mirror it (`classesOf`).
pub(crate) fn classes_of(dead: &[u8], sub: &[Perm], maps: &mut HandMaps) -> Vec<(u8, Vec<Mirror>)> {
    let mut out = Vec::new();
    let mut seen = [false; 52];
    for card in 0..52_u8 {
        if dead.contains(&card) || seen[usize::from(card)] {
            continue;
        }
        let orbit = card_orbit(card, sub);
        for &m in &orbit {
            seen[usize::from(m)] = true;
        }
        let mut mirrors = Vec::new();
        for &other in &orbit {
            if other == card {
                continue;
            }
            let perm = sub
                .iter()
                .find(|p| permute_card(other, p) == card)
                .copied()
                .unwrap_or([0, 1, 2, 3]);
            mirrors.push(Mirror {
                card: other,
                map: maps.of(&perm),
            });
        }
        out.push((card, mirrors));
    }
    out
}

/// Builds the turn game (`buildTurnGame`): turn betting, a dealt river, river betting.
///
/// # Errors
/// Bad input.
pub fn build_turn_game(spot: &SpotInput) -> Result<BuiltSubgame, SolverInputError> {
    let board = validate(spot, 4)?;
    let turn_rules = rules_of(spot, &spot.menus, spot.raise_cap)?;
    let river_rules = rules_of(
        spot,
        spot.river_menus.as_ref().unwrap_or(&spot.menus),
        spot.river_raise_cap.or(spot.raise_cap),
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
    let first = spot.first_to_act.unwrap_or(0);

    let mut maps = HandMaps::new([&h0.combos, &h1.combos]);
    let classes = classes_of(&board, &group, &mut maps);
    let rivers: Vec<u8> = classes.iter().map(|(c, _)| *c).collect();
    let weight = 1.0 / (52.0 - 4.0 - 4.0);

    let mut state = State {
        build: Build::default(),
        chance_path: HashMap::new(),
    };
    let turn_params = StreetParams {
        street: Street::Turn,
        pot: spot.pot,
        stack: spot.stack,
        rake: spot.rake.as_ref(),
        first,
        rules: &turn_rules,
        record_info: true,
    };
    let river_params = StreetParams {
        street: Street::River,
        rules: &river_rules,
        ..turn_params
    };
    let pot = spot.pot;
    let rake = spot.rake;
    let root = build_street(
        &mut state,
        &turn_params,
        [0.0, 0.0],
        "",
        &mut |st: &mut State, c0, c1, all_in, path| {
            let mut edges = Vec::with_capacity(rivers.len());
            for (k, &card) in rivers.iter().enumerate() {
                let child = if all_in {
                    st.build.builder.showdown(k, pot, c0, c1, rake.as_ref())
                } else {
                    build_street(
                        st,
                        &river_params,
                        [c0, c1],
                        &dealt_path(path, card),
                        &mut |s2: &mut State, a0, a1, _, _| {
                            s2.build.builder.showdown(k, pot, a0, a1, rake.as_ref())
                        },
                    )
                };
                edges.push(Edge {
                    label: card_code(card),
                    child,
                    card: Some(card),
                });
            }
            let id = st.build.builder.chance(weight, &edges);
            st.chance_path.insert(id, path.to_owned());
            id
        },
    );

    let boards: Vec<ShowdownBoard> = rivers
        .iter()
        .map(|&card| {
            let mut five = board.clone();
            five.push(card);
            ShowdownBoard::new(&strengths(&h0.cards, &five), &strengths(&h1.cards, &five))
        })
        .collect();
    if let Some(e) = state.build.error.take() {
        return Err(e);
    }
    let tree = state.build.builder.finish(root);
    let mut game = Game {
        edge_mirrors: Vec::new(),
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
    let mut per_card: Vec<Option<Vec<Mirror>>> = vec![None; 52];
    if group.len() > 1 {
        for (card, mirrors) in &classes {
            if !mirrors.is_empty() {
                per_card[usize::from(*card)] = Some(mirrors.clone());
            }
        }
    }
    game.set_card_mirrors(&per_card);
    game.maps = maps.maps;
    Ok(BuiltSubgame {
        street: Street::Turn,
        game,
        board,
        combos: [h0.combos, h1.combos],
        info: state.build.info,
        chance_path: state.chance_path,
        pot: spot.pot,
        stack: spot.stack,
        first_to_act: first,
        group,
        turn_classes: 0,
    })
}
