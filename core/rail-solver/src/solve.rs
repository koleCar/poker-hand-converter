//! A finished solver's result (`solve.ts`: `extract`, `SolveResult`,
//! `SolvedNode`): per decision node the average strategy, the EV per action
//! per hand and the range frequencies, in the TypeScript's pre-order.

use crate::betting::{ActionInfo, Street};
use crate::cards::card_code;
use crate::cfr::{RunResult, Solver, StoppedBy};
use crate::subgame::BuiltSubgame;
use crate::tree::{ACTION, CHANCE};

pub const SOLVER_VERSION: &str = "solver/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    Turn,
    Flop,
}

impl Scope {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Turn => "turn",
            Self::Flop => "flop",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolvedNode {
    /// `"action"` or `"chance"`.
    pub chance: bool,
    pub player: i32,
    pub street: Street,
    pub path: String,
    pub parent: i64,
    pub parent_edge: i64,
    pub pot: f64,
    pub to_call: f64,
    pub behind: f64,
    pub labels: Vec<String>,
    pub actions: Vec<ActionInfo>,
    pub children: Vec<i64>,
    pub strategy: Vec<f32>,
    pub ev: Vec<f32>,
    pub frequency: Vec<f64>,
    /// The tree node this entry describes (not in the TypeScript's result).
    pub tree_node: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolveResult {
    pub street: Street,
    pub board: Vec<String>,
    pub pot: f64,
    pub stack: f64,
    pub first_to_act: u8,
    pub hands: [Vec<u16>; 2],
    pub weights: [Vec<f32>; 2],
    pub iterations: u32,
    pub stopped_by: StoppedBy,
    pub exploitability: f64,
    pub exploitability_pct: f64,
    pub exploitability_mbb: f64,
    pub value: [f64; 2],
    pub root_ev: [Vec<f32>; 2],
    pub nodes: Vec<SolvedNode>,
    pub memory_bytes: usize,
    pub scope: Scope,
}

/// `extract`: evaluates the average profile and describes the nodes in scope.
pub fn extract(
    built: &BuiltSubgame,
    solver: &mut Solver,
    run: &RunResult,
    scope: Scope,
) -> SolveResult {
    let info = &built.info;
    let (value, root_ev) = match scope {
        Scope::All => solver.evaluate(|_| true),
        Scope::Turn => {
            solver.evaluate(|node| info.get(&node).map(|i| i.street) != Some(Street::River))
        }
        Scope::Flop => {
            solver.evaluate(|node| info.get(&node).map(|i| i.street) == Some(Street::Flop))
        }
    };
    let game = solver.game();
    let tree = &game.tree;
    let n = [game.hands[0].size, game.hands[1].size];
    let mut nodes: Vec<SolvedNode> = Vec::new();
    let turn_only = scope != Scope::All;

    // Explicit stack instead of recursion: (node, parent, parent_edge, reach, child slot to fill).
    struct Frame {
        node: usize,
        parent: i64,
        parent_edge: i64,
        reach: [Vec<f64>; 2],
    }
    // Pre-order with children in edge order: a recursive helper, as in the TypeScript.
    fn visit(
        frame: Frame,
        built: &BuiltSubgame,
        solver: &Solver,
        scope: Scope,
        turn_only: bool,
        n: [usize; 2],
        nodes: &mut Vec<SolvedNode>,
    ) -> i64 {
        let game = solver.game();
        let tree = &game.tree;
        let Frame {
            node,
            parent,
            parent_edge,
            reach,
        } = frame;
        let kind = tree.kind[node];
        if kind != ACTION && kind != CHANCE {
            return -1;
        }
        let index = nodes.len();
        let edges = tree.edges(node);
        let labels: Vec<String> = edges.clone().map(|e| tree.label(e).to_owned()).collect();
        if kind == CHANCE {
            let path = built.chance_path.get(&node).cloned().unwrap_or_default();
            let street = if built.street == Street::Flop && !path.contains('|') {
                Street::Turn
            } else {
                Street::River
            };
            let stop = turn_only
                && (scope == Scope::Flop || built.street != Street::Flop || path.contains('|'));
            nodes.push(SolvedNode {
                chance: true,
                player: -1,
                street,
                path,
                parent,
                parent_edge,
                pot: 0.0,
                to_call: 0.0,
                behind: 0.0,
                labels,
                actions: Vec::new(),
                children: Vec::new(),
                strategy: Vec::new(),
                ev: Vec::new(),
                frequency: Vec::new(),
                tree_node: node,
            });
            if stop {
                nodes[index].children = vec![-1; edges.len()];
                return index as i64;
            }
            for (k, e) in edges.enumerate() {
                let card = tree.edge_card[e];
                let masked = [0, 1].map(|p| {
                    let hands = &game.hands[p];
                    let mut out = reach[p].clone();
                    for i in 0..hands.size {
                        if i32::from(hands.c1[i]) == i32::from(card)
                            || i32::from(hands.c2[i]) == i32::from(card)
                        {
                            out[i] = 0.0;
                        }
                    }
                    out
                });
                let child = visit(
                    Frame {
                        node: tree.children[e] as usize,
                        parent: index as i64,
                        parent_edge: k as i64,
                        reach: masked,
                    },
                    built,
                    solver,
                    scope,
                    turn_only,
                    n,
                    nodes,
                );
                nodes[index].children.push(child);
            }
            return index as i64;
        }

        let player = usize::from(tree.player[node]);
        let size = n[player];
        let count = edges.len();
        let strategy = solver.average_strategy(node);
        let ev = solver.ev_at(node).map(<[f32]>::to_vec).unwrap_or_default();
        let info = built.info.get(&node);
        let own = &reach[player];
        let mut total = 0.0;
        for &x in &own[..size] {
            total += x;
        }
        let mut frequency = Vec::with_capacity(count);
        for a in 0..count {
            let mut f = 0.0;
            for i in 0..size {
                f += own[i] * f64::from(strategy[a * size + i]);
            }
            frequency.push(if total > 0.0 { f / total } else { 0.0 });
        }
        nodes.push(SolvedNode {
            chance: false,
            player: player as i32,
            street: info.map_or(built.street, |i| i.street),
            path: info.map(|i| i.path.clone()).unwrap_or_default(),
            parent,
            parent_edge,
            pot: info.map_or(0.0, |i| i.pot),
            to_call: info.map_or(0.0, |i| i.to_call),
            behind: info.map_or(0.0, |i| i.behind),
            labels,
            actions: info.map(|i| i.actions.clone()).unwrap_or_default(),
            children: Vec::new(),
            strategy: strategy.clone(),
            ev,
            frequency,
            tree_node: node,
        });
        for a in 0..count {
            let mut next = reach.clone();
            let narrowed: Vec<f64> = (0..size)
                .map(|i| own[i] * f64::from(strategy[a * size + i]))
                .collect();
            next[player] = narrowed;
            let child = visit(
                Frame {
                    node: tree.children[edges.start + a] as usize,
                    parent: index as i64,
                    parent_edge: a as i64,
                    reach: next,
                },
                built,
                solver,
                scope,
                turn_only,
                n,
                nodes,
            );
            nodes[index].children.push(child);
        }
        index as i64
    }

    let root = Frame {
        node: tree.root,
        parent: -1,
        parent_edge: -1,
        reach: [game.hands[0].weight.clone(), game.hands[1].weight.clone()],
    };
    let weights = [
        game.hands[0].weight.iter().map(|&x| x as f32).collect(),
        game.hands[1].weight.iter().map(|&x| x as f32).collect(),
    ];
    visit(root, built, solver, scope, turn_only, n, &mut nodes);

    SolveResult {
        street: built.street,
        board: built.board.iter().map(|&c| card_code(c)).collect(),
        pot: built.pot,
        stack: built.stack,
        first_to_act: built.first_to_act,
        hands: built.combos.clone(),
        weights,
        iterations: run.iterations,
        stopped_by: run.stopped_by,
        exploitability: run.exploitability.exploitability,
        exploitability_pct: run.exploitability.percent_pot,
        exploitability_mbb: run.exploitability.mbb,
        value,
        root_ev: [
            root_ev[0].iter().map(|&x| x as f32).collect(),
            root_ev[1].iter().map(|&x| x as f32).collect(),
        ],
        nodes,
        memory_bytes: solver.ts_bytes(),
        scope,
    }
}
