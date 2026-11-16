//! Nodelock (docs/NODELOCK.md §1, §2.1): a `LockSet` applied to a built game
//! as frozen nodes.
//!
//! - Each `NodeLockSpec` freezes its node: the hands its `locked` flags mark
//!   play its `strategy`; the others adapt.
//! - `earlier`: `"player"` freezes the locked player's strategy at every
//!   ancestor decision node at the baseline (library) strategy, `"all"`
//!   both players', `"none"` nothing. A locked node is never also an
//!   earlier one. The semantics are `web/src/lib/solver/nodelock.ts`'s.

use std::collections::HashMap;

use crate::cfr::Solver;
use crate::chunk::DecodedSolve;
use crate::subgame::BuiltSubgame;
use crate::tree::{ACTION, FlatTree};

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
    /// The locked nodes, in `set.nodes` order.
    pub locked: Vec<usize>,
    /// The earlier nodes frozen at the baseline, ascending.
    pub earlier: Vec<usize>,
}

/// `splitLockPath`: the flop part, the turn card, the path in the turn game
/// (`inner`), and the river card dealt inside it.
#[must_use]
pub fn split_lock_path(path: &str) -> (&str, Option<&str>, Option<&str>, &str) {
    let valid = |card: &str| card.len() == 2 && crate::cards::card_index(card).is_some();
    if let Some(tilde) = path.find('~')
        && let Some(slash) = path[tilde..].find('/')
    {
        let card = &path[tilde + 1..tilde + slash];
        if valid(card) {
            let inner = &path[tilde + slash + 1..];
            let river = inner.find('|').and_then(|at| {
                let c = inner.get(at + 1..at + 3)?;
                (inner.get(at + 3..at + 4) == Some("|") && valid(c)).then_some(c)
            });
            return (&path[..tilde], Some(card), river, inner);
        }
    }
    (path, None, None, path)
}

/// `lockSymmetries`: the board's suit relabellings the lock set is
/// invariant under (dealt cards fixed, strategies and flags mapped onto
/// themselves).
#[must_use]
pub fn lock_symmetries(set: &LockSet, board: &[u8]) -> Vec<crate::iso::Perm> {
    use crate::iso::{board_symmetries, permute_card, permute_combo};
    board_symmetries(board)
        .into_iter()
        .filter(|perm| {
            set.nodes.iter().all(|node| {
                let (_, turn, river, _) = split_lock_path(&node.path);
                for card in [turn, river].into_iter().flatten() {
                    let c = crate::cards::card_index(card).unwrap_or(0);
                    if permute_card(c, perm) != c {
                        return false;
                    }
                }
                (0..crate::cards::NUM_COMBOS).all(|c| {
                    let d = permute_combo(c, perm);
                    let lc = node.locked.get(c).is_some_and(|&x| x != 0);
                    let ld = node.locked.get(d).is_some_and(|&x| x != 0);
                    if lc != ld {
                        return false;
                    }
                    !lc || node
                        .strategy
                        .iter()
                        .all(|row| (row[c] - row[d]).abs() <= 1e-9)
                })
            })
        })
        .collect()
}

/// The baseline strategy of an earlier node, `[action][hand]` over the game's hands.
pub type Baseline<'a> = &'a dyn Fn(usize) -> Option<Vec<f64>>;

/// A decoded chunk as a game's baseline (`chunkBaseline`): the node of the
/// same path, read onto the game's hands by combo; a combo the chunk does not
/// hold plays its first action.
pub fn chunk_baseline<'a>(
    chunk: &'a DecodedSolve,
    built: &'a BuiltSubgame,
) -> impl Fn(usize) -> Option<Vec<f64>> + 'a {
    let by_path: HashMap<&str, usize> = chunk
        .nodes
        .iter()
        .enumerate()
        .map(|(k, n)| (n.path.as_str(), k))
        .collect();
    let index: [HashMap<u16, usize>; 2] = [0, 1].map(|p| {
        chunk.hands[p]
            .iter()
            .enumerate()
            .map(|(i, &c)| (c, i))
            .collect()
    });
    move |node| {
        let path = built.info.get(&node)?.path.as_str();
        let solved = &chunk.nodes[*by_path.get(path)?];
        let p = solved.player;
        let count = solved.labels.len();
        let n = chunk.hands[p].len();
        let hands = &built.combos[p];
        let mut out = vec![0.0; count * hands.len()];
        for (i, combo) in hands.iter().enumerate() {
            let j = index[p].get(combo);
            for a in 0..count {
                out[a * hands.len() + i] = match j {
                    Some(&j) => solved.strategy[a * n + j],
                    None => f64::from(u8::from(a == 0)),
                };
            }
        }
        Some(out)
    }
}

/// What a lock set freezes in a game, before any freezing: each locked node
/// with its `[action][hand]` strategy and mask, and the earlier nodes.
#[derive(Debug, Clone, Default)]
pub struct LockPlan {
    pub locked: Vec<(usize, Vec<f64>, Vec<bool>)>,
    /// Ascending.
    pub earlier: Vec<usize>,
}

/// The nodes a lock set freezes in `built` (`lockedNodes`, `earlierNodes`).
/// Paths are read in this game (`split_lock_path(..).3`: the turn game's
/// path for a turn or river lock).
///
/// # Errors
/// A node not in the game, a player or actions that do not match, a lock of
/// the wrong shape.
pub fn plan_locks(
    built: &BuiltSubgame,
    tree: &FlatTree,
    set: &LockSet,
) -> Result<LockPlan, String> {
    let by_path: HashMap<&str, usize> = built
        .info
        .iter()
        .filter(|(node, _)| tree.kind[**node] == ACTION)
        .map(|(node, info)| (info.path.as_str(), *node))
        .collect();
    let mut plan = LockPlan::default();
    for spec in &set.nodes {
        let path = split_lock_path(&spec.path).3;
        let node = *by_path
            .get(path)
            .ok_or_else(|| format!("no decision at {} in this game", spec.path))?;
        let player = usize::from(tree.player[node]);
        if player != usize::from(spec.player) {
            return Err(format!(
                "{}: player {player} acts here, not {}",
                spec.path, spec.player
            ));
        }
        let labels: Vec<&str> = tree.edges(node).map(|e| tree.label(e)).collect();
        if spec
            .actions
            .iter()
            .map(String::as_str)
            .ne(labels.iter().copied())
        {
            return Err(format!(
                "{}: the tree has {}, the lock {}",
                spec.path,
                labels.join(" "),
                spec.actions.join(" ")
            ));
        }
        let count = labels.len();
        if spec.strategy.len() != count
            || spec.locked.len() != crate::cards::NUM_COMBOS
            || spec
                .strategy
                .iter()
                .any(|row| row.len() != crate::cards::NUM_COMBOS)
        {
            return Err(format!(
                "{}: a lock is {count} rows of 1326 combos and 1326 flags",
                spec.path
            ));
        }
        let hands = &built.combos[player];
        let size = hands.len();
        let mut strategy = vec![0.0; count * size];
        for (i, &combo) in hands.iter().enumerate() {
            for a in 0..count {
                strategy[a * size + i] = spec.strategy[a][usize::from(combo)];
            }
        }
        let mask = hands
            .iter()
            .map(|&c| spec.locked[usize::from(c)] != 0)
            .collect();
        plan.locked.push((node, strategy, mask));
    }
    if set.earlier != LockEarlier::None {
        let mut parent = vec![u32::MAX; tree.size];
        for node in 0..tree.size {
            for e in tree.edges(node) {
                parent[tree.children[e] as usize] = node as u32;
            }
        }
        let locked: Vec<usize> = plan.locked.iter().map(|(n, _, _)| *n).collect();
        let mut earlier = std::collections::BTreeSet::new();
        for (k, &node) in locked.iter().enumerate() {
            let player = set.nodes[k].player;
            let mut at = parent[node];
            while at != u32::MAX {
                let anc = at as usize;
                at = parent[anc];
                if tree.kind[anc] != ACTION || locked.contains(&anc) {
                    continue;
                }
                if set.earlier == LockEarlier::All || tree.player[anc] == player {
                    earlier.insert(anc);
                }
            }
        }
        plan.earlier = earlier.into_iter().collect();
    }
    Ok(plan)
}

/// Freezes a lock set (`applyNodelock`): each locked node's locked hands at
/// their strategy, then the earlier nodes (never a locked node) at `baseline`.
///
/// # Errors
/// As `plan_locks`, and an earlier node without a baseline.
pub fn apply_locks(
    built: &BuiltSubgame,
    solver: &mut Solver,
    set: &LockSet,
    baseline: Option<Baseline<'_>>,
) -> Result<Applied, String> {
    let plan = plan_locks(built, &solver.game().tree, set)?;
    apply_plan(built, solver, plan, baseline)
}

/// Freezes a planned lock set.
///
/// # Errors
/// An earlier node without a baseline.
pub fn apply_plan(
    built: &BuiltSubgame,
    solver: &mut Solver,
    plan: LockPlan,
    baseline: Option<Baseline<'_>>,
) -> Result<Applied, String> {
    let mut earlier = Vec::with_capacity(plan.earlier.len());
    for &node in &plan.earlier {
        let path = built.info.get(&node).map_or("", |i| i.path.as_str());
        let strategy = baseline
            .and_then(|b| b(node))
            .ok_or_else(|| format!("no baseline strategy for the earlier node {path:?}"))?;
        earlier.push((node, strategy));
    }
    let mut applied = Applied::default();
    for (node, strategy, mask) in plan.locked {
        solver.freeze(node, &strategy, Some(&mask));
        applied.locked.push(node);
    }
    for (node, strategy) in earlier {
        solver.freeze(node, &strategy, None);
        applied.earlier.push(node);
    }
    Ok(applied)
}
