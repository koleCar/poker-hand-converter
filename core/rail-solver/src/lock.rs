//! Nodelock (docs/NODELOCK.md §1, §2.1): a `LockSet` applied to a built game
//! as frozen nodes.
//!
//! - Each `NodeLockSpec` freezes its node: the hands its `locked` flags mark
//!   play its `strategy`; the others adapt.
//! - `earlier`: `"player"` freezes the locked player's strategy at every
//!   ancestor decision node at the baseline (library) strategy, `"all"`
//!   both players', `"none"` nothing. A node that is both an ancestor and
//!   locked itself takes its own locked hands and the baseline for the rest.

use std::collections::HashMap;

use crate::cfr::Solver;
use crate::chunk::DecodedSolve;
use crate::subgame::BuiltSubgame;
use crate::tree::ACTION;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LockEarlier {
    None,
    Player,
    All,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct NodeLockSpec {
    pub street: String,
    pub path: String,
    pub player: u8,
    pub actions: Vec<String>,
    /// `[action][combo]` over the 1,326 combos.
    pub strategy: Vec<Vec<f64>>,
    /// 1,326 flags: 1 = the combo's strategy is fixed.
    pub locked: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct LockSpot {
    pub set: String,
    pub line: String,
    pub flop: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub river: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockSet {
    pub version: u32,
    pub spot: LockSpot,
    pub nodes: Vec<NodeLockSpec>,
    pub earlier: LockEarlier,
    pub target_pct: f64,
}

/// What `apply_locks` froze.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    /// Tree nodes frozen by a spec.
    pub locked: Vec<usize>,
    /// Ancestor nodes frozen at the baseline.
    pub earlier: Vec<usize>,
}

/// Freezes the lock set's nodes in `solver` (built from `built`).
///
/// # Errors
/// A path that is not a decision node of the game, a player or action list
/// that does not match the tree, a strategy of the wrong shape, or
/// `earlier` other than none without a baseline.
pub fn apply_locks(
    built: &BuiltSubgame,
    solver: &mut Solver,
    set: &LockSet,
    baseline: Option<&DecodedSolve>,
) -> Result<Applied, String> {
    let tree = &solver.game().tree;
    let by_path: HashMap<&str, usize> = built
        .info
        .iter()
        .filter(|(node, _)| tree.kind[**node] == ACTION)
        .map(|(node, info)| (info.path.as_str(), *node))
        .collect();
    // Parents, for the ancestors.
    let mut parent = vec![u32::MAX; tree.size];
    for node in 0..tree.size {
        for e in tree.edges(node) {
            parent[tree.children[e] as usize] = node as u32;
        }
    }
    let combos = &built.combos;

    // node -> (strategy [action][hand], mask)
    let mut frozen: HashMap<usize, (Vec<f64>, Vec<bool>)> = HashMap::new();
    let mut applied = Applied::default();

    if set.earlier != LockEarlier::None {
        let base = baseline.ok_or("locking earlier nodes needs the baseline solve")?;
        let base_by_path: HashMap<&str, usize> = base
            .nodes
            .iter()
            .enumerate()
            .map(|(k, n)| (n.path.as_str(), k))
            .collect();
        let base_index: [HashMap<u16, usize>; 2] = [0, 1].map(|p| {
            base.hands[p]
                .iter()
                .enumerate()
                .map(|(i, &c)| (c, i))
                .collect()
        });
        for spec in &set.nodes {
            let Some(&node) = by_path.get(spec.path.as_str()) else {
                continue;
            };
            let mut at = parent[node];
            while at != u32::MAX {
                let anc = at as usize;
                at = parent[anc];
                if tree.kind[anc] != ACTION {
                    continue;
                }
                let player = usize::from(tree.player[anc]);
                if set.earlier == LockEarlier::Player && player != usize::from(spec.player) {
                    continue;
                }
                if frozen.contains_key(&anc) {
                    continue;
                }
                let path = built
                    .info
                    .get(&anc)
                    .map(|i| i.path.as_str())
                    .unwrap_or_default();
                let Some(&k) = base_by_path.get(path) else {
                    return Err(format!("the baseline has no node at {path:?}"));
                };
                let b = &base.nodes[k];
                let count = tree.child_count[anc] as usize;
                let labels: Vec<&str> = tree.edges(anc).map(|e| tree.label(e)).collect();
                if b.labels
                    .iter()
                    .map(String::as_str)
                    .ne(labels.iter().copied())
                {
                    return Err(format!(
                        "the baseline's actions at {path:?} do not match the tree"
                    ));
                }
                let size = combos[player].len();
                let bsize = base.hands[player].len();
                let mut strategy = vec![0.0; count * size];
                let mut mask = vec![false; size];
                for (i, combo) in combos[player].iter().enumerate() {
                    if let Some(&j) = base_index[player].get(combo) {
                        mask[i] = true;
                        for a in 0..count {
                            strategy[a * size + i] = b.strategy[a * bsize + j];
                        }
                    }
                }
                frozen.insert(anc, (strategy, mask));
                applied.earlier.push(anc);
            }
        }
    }

    for spec in &set.nodes {
        let node = *by_path
            .get(spec.path.as_str())
            .ok_or_else(|| format!("no decision node at {:?}", spec.path))?;
        let player = usize::from(tree.player[node]);
        if player != usize::from(spec.player) {
            return Err(format!(
                "the node at {:?} is player {player}'s, the lock says {}",
                spec.path, spec.player
            ));
        }
        let count = tree.child_count[node] as usize;
        let labels: Vec<&str> = tree.edges(node).map(|e| tree.label(e)).collect();
        if spec
            .actions
            .iter()
            .map(String::as_str)
            .ne(labels.iter().copied())
        {
            return Err(format!(
                "the lock's actions at {:?} are {:?}, the tree's {:?}",
                spec.path, spec.actions, labels
            ));
        }
        if spec.strategy.len() != count
            || spec
                .strategy
                .iter()
                .any(|row| row.len() != crate::cards::NUM_COMBOS)
        {
            return Err(format!(
                "the lock's strategy at {:?} is not [action][1326]",
                spec.path
            ));
        }
        if spec.locked.len() != crate::cards::NUM_COMBOS {
            return Err(format!("the lock's flags at {:?} are not 1326", spec.path));
        }
        let size = combos[player].len();
        let entry = frozen
            .entry(node)
            .or_insert_with(|| (vec![0.0; count * size], vec![false; size]));
        for (i, &combo) in combos[player].iter().enumerate() {
            let c = usize::from(combo);
            if spec.locked[c] != 0 {
                entry.1[i] = true;
                for a in 0..count {
                    entry.0[a * size + i] = spec.strategy[a][c];
                }
            }
        }
        applied.locked.push(node);
    }

    let mut nodes: Vec<usize> = frozen.keys().copied().collect();
    nodes.sort_unstable();
    for node in nodes {
        let (strategy, mask) = &frozen[&node];
        solver.freeze(node, strategy, mask);
    }
    Ok(applied)
}
