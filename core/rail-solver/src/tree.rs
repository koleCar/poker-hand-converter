//! The public game tree, flattened (`tree.ts`). Node fields live in parallel
//! arrays indexed by node id; a node's children are a contiguous slice of
//! `children`. Payoffs are stored per terminal, net of rake.
//!
//! Node ids are assigned in creation order, children before their parent,
//! exactly as the TypeScript builder does: a subtree is therefore a
//! contiguous range of ids ending at its root, which is what lets the
//! parallel walk hand each turn subtree its own slice of the storage.

use std::collections::HashMap;

pub const ACTION: u8 = 0;
pub const FOLD: u8 = 1;
pub const SHOWDOWN: u8 = 2;
pub const CHANCE: u8 = 3;

/// Rake as a fraction of the final pot, capped.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Rake {
    pub percent: f64,
    pub cap: f64,
}

/// Rake taken from a final pot (`rakeOf`).
#[must_use]
pub fn rake_of(pot: f64, rake: Option<&Rake>) -> f64 {
    match rake {
        Some(r) if r.percent > 0.0 => (pot * r.percent).min(r.cap),
        _ => 0.0,
    }
}

#[derive(Debug, Clone, Default)]
pub struct FlatTree {
    pub size: usize,
    pub root: usize,
    pub kind: Vec<u8>,
    /// Actor for `ACTION`, folder for `FOLD`, 0 otherwise.
    pub player: Vec<u8>,
    pub child_start: Vec<u32>,
    pub child_count: Vec<u32>,
    pub children: Vec<u32>,
    /// Label id of each edge (`labels`), parallel to `children`.
    pub edge_label: Vec<u32>,
    /// Distinct edge labels.
    pub labels: Vec<String>,
    /// Card dealt on each chance edge; -1 elsewhere.
    pub edge_card: Vec<i8>,
    /// Six numbers per node: showdown `[win0, lose0, tie0, win1, lose1, tie1]`, fold `amount0` at 0 and `amount1` at 3.
    pub payoff: Vec<f64>,
    /// Showdown board id; -1 elsewhere.
    pub board: Vec<i32>,
    pub chance_weight: Vec<f64>,
    pub max_depth: usize,
    pub max_children: usize,
    /// Lowest node id of each node's subtree (the subtree is `first[node] ..= node`).
    pub first: Vec<u32>,
}

impl FlatTree {
    #[must_use]
    pub fn edges(&self, node: usize) -> std::ops::Range<usize> {
        let s = self.child_start[node] as usize;
        s..s + self.child_count[node] as usize
    }

    #[must_use]
    pub fn label(&self, edge: usize) -> &str {
        &self.labels[self.edge_label[edge] as usize]
    }
}

/// One edge handed to `TreeBuilder::action` / `chance`.
#[derive(Debug, Clone)]
pub struct Edge {
    pub label: String,
    pub child: usize,
    pub card: Option<u8>,
}

/// Builds a `FlatTree` bottom-up (`TreeBuilder`).
#[derive(Debug, Default)]
pub struct TreeBuilder {
    kind: Vec<u8>,
    player: Vec<u8>,
    starts: Vec<u32>,
    counts: Vec<u32>,
    kids: Vec<u32>,
    labels: Vec<u32>,
    label_ids: HashMap<String, u32>,
    label_names: Vec<String>,
    cards: Vec<i8>,
    payoffs: Vec<f64>,
    boards: Vec<i32>,
    weights: Vec<f64>,
}

impl TreeBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn size(&self) -> usize {
        self.kind.len()
    }

    fn label_id(&mut self, label: &str) -> u32 {
        if let Some(id) = self.label_ids.get(label) {
            return *id;
        }
        let id = self.label_names.len() as u32;
        self.label_names.push(label.to_owned());
        self.label_ids.insert(label.to_owned(), id);
        id
    }

    fn add(&mut self, kind: u8, player: u8, edges: &[Edge], board: i32, weight: f64) -> usize {
        let id = self.kind.len();
        self.kind.push(kind);
        self.player.push(player);
        self.starts.push(self.kids.len() as u32);
        self.counts.push(edges.len() as u32);
        for edge in edges {
            self.kids.push(edge.child as u32);
            let l = self.label_id(&edge.label);
            self.labels.push(l);
            self.cards.push(edge.card.map_or(-1, |c| c as i8));
        }
        self.boards.push(board);
        self.weights.push(weight);
        self.payoffs.extend_from_slice(&[0.0; 6]);
        id
    }

    /// A decision node for `player`.
    ///
    /// # Panics
    /// With no edges.
    pub fn action(&mut self, player: u8, edges: &[Edge]) -> usize {
        assert!(
            !edges.is_empty(),
            "an action node needs at least one action"
        );
        self.add(ACTION, player, edges, -1, 0.0)
    }

    /// A chance node; `weight` is each outcome's probability given both hands.
    pub fn chance(&mut self, weight: f64, edges: &[Edge]) -> usize {
        self.add(CHANCE, 0, edges, -1, weight)
    }

    /// `folder` gives up; the other player takes `pot + c0 + c1`, less rake.
    pub fn fold(&mut self, folder: u8, pot: f64, c0: f64, c1: f64, rake: Option<&Rake>) -> usize {
        let id = self.add(FOLD, folder, &[], -1, 0.0);
        let total = pot + c0 + c1;
        let net = total - rake_of(total, rake);
        let base = id * 6;
        self.payoffs[base] = if folder == 0 { 0.0 - c0 } else { net - c0 };
        self.payoffs[base + 3] = if folder == 1 { 0.0 - c1 } else { net - c1 };
        id
    }

    /// Hands are compared on `board`; ties split the pot.
    pub fn showdown(
        &mut self,
        board: usize,
        pot: f64,
        c0: f64,
        c1: f64,
        rake: Option<&Rake>,
    ) -> usize {
        let id = self.add(SHOWDOWN, 0, &[], board as i32, 0.0);
        let total = pot + c0 + c1;
        let net = total - rake_of(total, rake);
        let base = id * 6;
        self.payoffs[base] = net - c0;
        self.payoffs[base + 1] = 0.0 - c0;
        self.payoffs[base + 2] = net / 2.0 - c0;
        self.payoffs[base + 3] = net - c1;
        self.payoffs[base + 4] = 0.0 - c1;
        self.payoffs[base + 5] = net / 2.0 - c1;
        id
    }

    #[must_use]
    pub fn finish(self, root: usize) -> FlatTree {
        let size = self.kind.len();
        let max_children = self.counts.iter().copied().max().unwrap_or(1).max(1) as usize;
        let mut max_depth = 0;
        let mut stack = vec![(root, 0_usize)];
        while let Some((node, depth)) = stack.pop() {
            max_depth = max_depth.max(depth);
            let s = self.starts[node] as usize;
            for e in s..s + self.counts[node] as usize {
                stack.push((self.kids[e] as usize, depth + 1));
            }
        }
        // Children are built before their parent, so a node's subtree starts
        // at its first child's subtree start.
        let mut first = vec![0_u32; size];
        for node in 0..size {
            let s = self.starts[node] as usize;
            first[node] = if self.counts[node] == 0 {
                node as u32
            } else {
                first[self.kids[s] as usize]
            };
        }
        FlatTree {
            size,
            root,
            kind: self.kind,
            player: self.player,
            child_start: self.starts,
            child_count: self.counts,
            children: self.kids,
            edge_label: self.labels,
            labels: self.label_names,
            edge_card: self.cards,
            payoff: self.payoffs,
            board: self.boards,
            chance_weight: self.weights,
            max_depth,
            max_children,
            first,
        }
    }
}
