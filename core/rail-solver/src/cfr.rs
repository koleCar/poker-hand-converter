//! Discounted CFR over a public tree, vectorised over private hands
//! (`cfr.ts`), with frozen nodes (docs/NODELOCK.md §2.1) and the parallel
//! turn subtrees of §2.2.
//!
//! **Parity.** The arithmetic is the TypeScript's, operation for operation:
//! `f64` scratch, `f32` storage (or 16-bit, scaled per node), the regret
//! matching cache that stores the strategy as `f32`, the same pruning, the
//! same summation orders. What can differ is `powf` against V8's `Math.pow`
//! in the last bit of the discount factors.
//!
//! **Parallel, deterministic.** A traversal for player p passes the
//! opponent's reach down. The reach that arrives at a *split* chance node -
//! one with no chance node above it: the turn deals of a flop game, the river
//! deals of a turn game - depends only on strategies above it, which the
//! traversal does not change before it gets there. So a traversal runs in
//! three steps:
//!
//!  1. **collect**: walk the part above the split nodes, computing the same
//!     reach the real walk will, and record each split node's reach and its
//!     edges as tasks (nothing is written);
//!  2. **solve**: run every task's subtree on the thread pool, each with its
//!     own scratch, writing the subtree's values into the task's own slot;
//!  3. **back up**: the real walk of the top part, which at a split node reads
//!     the slots instead of recursing, edge by edge in edge order.
//!
//! Subtrees are disjoint sets of nodes, so their storage never overlaps, and
//! step 3 adds them up in the sequential walk's order: the result is
//! bit-identical to the sequential walk whatever the thread count (a test).

use std::collections::HashMap;
use std::sync::Mutex;

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::game::Game;
use crate::tree::{ACTION, CHANCE, FOLD, SHOWDOWN};

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct DcfrParams {
    pub alpha: f64,
    pub beta: f64,
    pub gamma: f64,
}

pub const DEFAULT_DCFR: DcfrParams = DcfrParams {
    alpha: 1.5,
    beta: 0.0,
    gamma: 2.0,
};

/// Stratified public chance sampling (`ChanceSampling`).
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ChanceSampling {
    pub groups: u32,
    #[serde(default)]
    pub seed: Option<u32>,
    #[serde(default)]
    pub until: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    F32,
    I16,
}

#[derive(Debug, Clone, Copy)]
pub struct SolverConfig {
    pub storage: Storage,
    pub sampling: Option<ChanceSampling>,
    /// Worker threads for the split subtrees; 1 walks sequentially.
    pub threads: usize,
}

impl Default for SolverConfig {
    fn default() -> Self {
        Self {
            storage: Storage::F32,
            sampling: None,
            threads: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Exploitability {
    pub best_response: [f64; 2],
    pub value: [f64; 2],
    pub nash_conv: f64,
    pub exploitability: f64,
    pub percent_pot: f64,
    pub mbb: f64,
}

impl Exploitability {
    #[must_use]
    pub fn unmeasured() -> Self {
        Self {
            best_response: [f64::NAN; 2],
            value: [f64::NAN; 2],
            nash_conv: f64::NAN,
            exploitability: f64::NAN,
            percent_pot: f64::NAN,
            mbb: f64::NAN,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RunOptions {
    pub max_iterations: u32,
    pub target_exploitability: f64,
    pub check_every: u32,
    pub check_from: Option<u32>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            max_iterations: 1000,
            target_exploitability: 0.3,
            check_every: 10,
            check_from: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoppedBy {
    Target,
    MaxIterations,
    Cancelled,
}

impl StoppedBy {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Target => "target",
            Self::MaxIterations => "max-iterations",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RunResult {
    pub iterations: u32,
    pub exploitability: Exploitability,
    pub stopped_by: StoppedBy,
}

/// What `run` reports to its caller.
#[derive(Debug, Clone, Copy)]
pub enum RunEvent<'a> {
    /// After every iteration; returning false cancels at once.
    Iteration(u32),
    /// After each measurement; returning false stops the run.
    Progress(u32, &'a Exploitability),
}

/// One node of a recorded best response, `[action][hand]`.
#[derive(Debug, Clone, PartialEq)]
pub struct BestResponseRow {
    pub strategy: Vec<f32>,
    pub ev: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Cfr,
    Best,
    Eval,
}

const NONE: u32 = u32::MAX;

/// A frozen node: the fixed strategy `[action][hand]` and which hands it binds.
#[derive(Debug, Clone)]
struct Frozen {
    strategy: Vec<f64>,
    mask: Vec<bool>,
}

#[derive(Debug, Clone)]
struct Sorted {
    c1: [Vec<u8>; 2],
    c2: [Vec<u8>; 2],
    same: [Vec<i32>; 2],
    /// `below[p][t]`: how many of the opponent's hands are strictly weaker
    /// than p's `t`-th; `upto[p][t]`: how many are not stronger. The sweeps
    /// stop there instead of comparing strengths.
    below: [Vec<u32>; 2],
    upto: [Vec<u32>; 2],
}

/// A split chance node's slot: where its edges' values and its reach go.
#[derive(Debug, Clone, Copy)]
struct Slot {
    node: u32,
    results: usize,
    reach: usize,
}

/// Everything the walk reads and never writes.
#[derive(Debug)]
struct Shared {
    game: Game,
    n: [usize; 2],
    offset: Vec<usize>,
    same: [Vec<i32>; 2],
    sorted: Vec<Sorted>,
    frozen_of: Vec<u32>,
    frozen: Vec<Frozen>,
    groups: usize,
    edge_group: Vec<u8>,
    sampled_chance: Vec<u8>,
    split_slot: Vec<u32>,
    slots: Vec<Slot>,
    /// Per edge below a split node: its subtree's node count (task order).
    task_weight: Vec<u32>,
    max_hands: usize,
    compact: bool,
}

#[derive(Debug, Default)]
struct Store {
    regrets: Vec<f32>,
    current: Vec<f32>,
    current_stamp: Vec<i32>,
    sums: Vec<f32>,
    regrets16: Vec<i16>,
    sums16: Vec<u16>,
    regret_scale: Vec<f32>,
    sum_scale: Vec<f32>,
    ev: Vec<f32>,
    ev_offset: Vec<i64>,
    results: Vec<f64>,
    valid: Vec<u8>,
    slot_reach: Vec<f64>,
}

/// Raw views of `Store` for the walk. Tasks touch disjoint subtrees, hence
/// disjoint blocks; the top walk runs alone.
#[derive(Debug, Clone, Copy)]
struct Raw {
    regrets: *mut f32,
    current: *mut f32,
    current_stamp: *mut i32,
    sums: *mut f32,
    regrets16: *mut i16,
    sums16: *mut u16,
    regret_scale: *mut f32,
    sum_scale: *mut f32,
    ev: *mut f32,
    ev_offset: *const i64,
    ev_len: usize,
    results: *mut f64,
    valid: *mut u8,
    slot_reach: *mut f64,
}

// SAFETY: a `Raw` is only used while the `Store` it points into is borrowed
// mutably by the solver, and the walk writes through it only at the nodes of
// the subtree it owns (see the module header).
unsafe impl Send for Raw {}
unsafe impl Sync for Raw {}

impl Store {
    fn raw(&mut self) -> Raw {
        Raw {
            regrets: self.regrets.as_mut_ptr(),
            current: self.current.as_mut_ptr(),
            current_stamp: self.current_stamp.as_mut_ptr(),
            sums: self.sums.as_mut_ptr(),
            regrets16: self.regrets16.as_mut_ptr(),
            sums16: self.sums16.as_mut_ptr(),
            regret_scale: self.regret_scale.as_mut_ptr(),
            sum_scale: self.sum_scale.as_mut_ptr(),
            ev: self.ev.as_mut_ptr(),
            ev_offset: self.ev_offset.as_ptr(),
            ev_len: self.ev_offset.len(),
            results: self.results.as_mut_ptr(),
            valid: self.valid.as_mut_ptr(),
            slot_reach: self.slot_reach.as_mut_ptr(),
        }
    }
}

/// A block of a raw array as a slice.
///
/// # Safety
/// `off .. off + len` lies inside the array, and nothing else accesses it
/// while the slice lives.
#[allow(clippy::mut_from_ref)]
unsafe fn block<'x, T>(ptr: *mut T, off: usize, len: usize) -> &'x mut [T] {
    // SAFETY: the caller's contract.
    unsafe { std::slice::from_raw_parts_mut(ptr.add(off), len) }
}

#[derive(Debug, Clone)]
struct Level {
    cfv: Vec<f64>,
    reach: Vec<f64>,
    strat: Vec<f64>,
}

#[derive(Debug, Clone)]
struct Tmp {
    card_sum: Vec<f64>,
    card_sum2: Vec<f64>,
    win: Vec<f64>,
    norm: Vec<f64>,
    sum: Vec<f64>,
}

#[derive(Debug, Clone)]
struct Scratch {
    levels: Vec<Level>,
    tmp: Tmp,
}

impl Scratch {
    fn new(depth: usize, slab: usize, max_hands: usize, num_cards: usize) -> Self {
        let level = Level {
            cfv: vec![0.0; slab],
            reach: vec![0.0; slab],
            strat: vec![0.0; slab],
        };
        Self {
            levels: vec![level; depth + 1],
            tmp: Tmp {
                card_sum: vec![0.0; num_cards + 2],
                card_sum2: vec![0.0; num_cards + 2],
                win: vec![0.0; max_hands],
                norm: vec![0.0; max_hands],
                sum: vec![0.0; max_hands],
            },
        }
    }
}

/// One traversal's parameters.
#[derive(Debug, Clone, Copy)]
struct Pass {
    trav: usize,
    mode: Mode,
    stamp: i32,
    d_pos: f64,
    d_neg: f64,
    w_strat: f64,
    sample: bool,
    group: u8,
    groups_f: f64,
    record_ev: bool,
    keep: f64,
}

pub struct Solver {
    sh: Shared,
    st: Store,
    pub params: DcfrParams,
    pub iterations: u32,
    normalizer: f64,
    constant_sum: f64,
    scratch: Scratch,
    workers: Vec<Mutex<Scratch>>,
    pool: Option<rayon::ThreadPool>,
    tasks: Vec<(u32, u32)>,
    root_out: Vec<f64>,
    // Sampling.
    rng: u32,
    sample_until: f64,
    cycle: Vec<u32>,
    group: u8,
    sampling: bool,
    evaluated: bool,
    slab: usize,
}

impl std::fmt::Debug for Solver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Solver")
            .field("iterations", &self.iterations)
            .field("threads", &self.threads())
            .finish()
    }
}

impl Solver {
    /// # Panics
    /// When the thread pool cannot be built.
    #[must_use]
    pub fn new(game: Game, params: DcfrParams, config: SolverConfig) -> Self {
        let tree = &game.tree;
        let n = [game.hands[0].size, game.hands[1].size];
        let mut offset = vec![usize::MAX; tree.size];
        let mut total = 0_usize;
        let mut max_actions = 1_usize;
        for node in 0..tree.size {
            if tree.kind[node] == ACTION {
                offset[node] = total;
                let count = tree.child_count[node] as usize;
                total += count * n[usize::from(tree.player[node])];
                max_actions = max_actions.max(count);
            }
        }
        let compact = config.storage == Storage::I16;
        let f32_len = if compact { 0 } else { total };
        let i16_len = if compact { total } else { 0 };
        let max_hands = n[0].max(n[1]).max(1);
        let slab = max_actions * max_hands;

        let same = [same_index(&game, 0), same_index(&game, 1)];
        let sorted = game
            .boards
            .iter()
            .map(|board| {
                let side = |p: usize| {
                    let order = &board.order[p];
                    let hands = &game.hands[p];
                    (
                        order
                            .iter()
                            .map(|&i| hands.c1[i as usize])
                            .collect::<Vec<u8>>(),
                        order
                            .iter()
                            .map(|&i| hands.c2[i as usize])
                            .collect::<Vec<u8>>(),
                        order
                            .iter()
                            .map(|&i| same[p][i as usize])
                            .collect::<Vec<i32>>(),
                    )
                };
                let (a1, a2, a3) = side(0);
                let (b1, b2, b3) = side(1);
                let bounds = |p: usize| {
                    let mine = &board.strength[p];
                    let theirs = &board.strength[1 - p];
                    let below = mine
                        .iter()
                        .map(|&s| theirs.partition_point(|&x| x < s) as u32)
                        .collect();
                    let upto = mine
                        .iter()
                        .map(|&s| theirs.partition_point(|&x| x <= s) as u32)
                        .collect();
                    (below, upto)
                };
                let (l0, u0) = bounds(0);
                let (l1, u1) = bounds(1);
                Sorted {
                    c1: [a1, b1],
                    c2: [a2, b2],
                    same: [a3, b3],
                    below: [l0, l1],
                    upto: [u0, u1],
                }
            })
            .collect();

        // Sampling strata.
        let groups = config
            .sampling
            .map_or(1, |s| s.groups.clamp(1, 16) as usize);
        let mut edge_group = vec![0_u8; tree.children.len()];
        let mut sampled_chance = vec![0_u8; tree.size];
        if groups > 1 {
            for node in 0..tree.size {
                if tree.kind[node] != CHANCE {
                    continue;
                }
                let range = tree.edges(node);
                let start = range.start;
                let mut deeper = false;
                for e in range {
                    let child = tree.children[e] as usize;
                    if tree.kind[child] == ACTION || tree.kind[child] == CHANCE {
                        deeper = true;
                    }
                    let card = tree.edge_card[e];
                    edge_group[e] = if card >= 0 {
                        (((card >> 2) + (card & 3)) as usize % groups) as u8
                    } else {
                        ((e - start) % groups) as u8
                    };
                }
                sampled_chance[node] = u8::from(deeper);
            }
        }

        // Split chance nodes: no chance node above them.
        let mut split_slot = vec![NONE; tree.size];
        let mut slots = Vec::new();
        let mut results_len = 0;
        let mut reach_len = 0;
        if tree.size > 0 {
            let mut stack = vec![tree.root];
            while let Some(node) = stack.pop() {
                if tree.kind[node] == CHANCE {
                    split_slot[node] = slots.len() as u32;
                    let count = tree.child_count[node] as usize;
                    slots.push(Slot {
                        node: node as u32,
                        results: results_len,
                        reach: reach_len,
                    });
                    results_len += count * max_hands;
                    reach_len += max_hands;
                    continue;
                }
                for e in tree.edges(node) {
                    stack.push(tree.children[e] as usize);
                }
            }
        }
        let num_cards = game.num_cards;
        let depth = tree.max_depth;
        let threads = config.threads.max(1);
        let use_split = threads > 1 && !slots.is_empty();
        let edge_count = tree.children.len();

        let sh = Shared {
            n,
            offset,
            same,
            sorted,
            frozen_of: vec![NONE; tree.size],
            frozen: Vec::new(),
            groups,
            edge_group,
            sampled_chance,
            task_weight: if use_split {
                (0..edge_count)
                    .map(|e| {
                        let child = tree.children[e] as usize;
                        child as u32 - tree.first[child] + 1
                    })
                    .collect()
            } else {
                Vec::new()
            },
            split_slot: if use_split {
                split_slot
            } else {
                vec![NONE; tree.size]
            },
            slots: if use_split { slots } else { Vec::new() },
            max_hands,
            compact,
            game,
        };
        let size = sh.game.tree.size;
        let st = Store {
            regrets: vec![0.0; f32_len],
            current: vec![0.0; f32_len],
            current_stamp: vec![-2; if compact { 0 } else { size }],
            sums: vec![0.0; f32_len],
            regrets16: vec![0; i16_len],
            sums16: vec![0; i16_len],
            regret_scale: vec![0.0; if compact { size } else { 0 }],
            sum_scale: vec![0.0; if compact { size } else { 0 }],
            ev: Vec::new(),
            ev_offset: Vec::new(),
            results: vec![0.0; if use_split { results_len } else { 0 }],
            valid: vec![0; if use_split { edge_count } else { 0 }],
            slot_reach: vec![0.0; if use_split { reach_len } else { 0 }],
        };
        let pool = if threads > 1 {
            Some(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()
                    .expect("thread pool"),
            )
        } else {
            None
        };
        let workers = if use_split {
            (0..threads)
                .map(|_| Mutex::new(Scratch::new(depth, slab, max_hands, num_cards)))
                .collect()
        } else {
            Vec::new()
        };
        let mut solver = Self {
            scratch: Scratch::new(depth, slab, max_hands, num_cards),
            workers,
            pool,
            tasks: Vec::new(),
            root_out: vec![0.0; max_hands],
            params,
            iterations: 0,
            normalizer: 0.0,
            constant_sum: f64::NAN,
            rng: config.sampling.and_then(|s| s.seed).unwrap_or(0x5a17),
            sample_until: config
                .sampling
                .and_then(|s| s.until)
                .map_or(f64::INFINITY, f64::from),
            cycle: Vec::new(),
            group: 0,
            sampling: false,
            evaluated: false,
            slab,
            sh,
            st,
        };
        // Probability mass of all deals.
        let mut out = std::mem::take(&mut solver.root_out);
        compat(
            &solver.sh,
            0,
            &solver.sh.game.hands[1].weight,
            &mut solver.scratch.tmp.card_sum,
            &mut out,
            1.0,
        );
        let w0 = &solver.sh.game.hands[0].weight;
        let mut norm = 0.0;
        for i in 0..solver.sh.n[0] {
            norm += w0[i] * out[i];
        }
        solver.root_out = out;
        solver.normalizer = norm;
        solver.constant_sum = constant_sum(&solver.sh.game);
        solver
    }

    #[must_use]
    pub fn game(&self) -> &Game {
        &self.sh.game
    }

    #[must_use]
    pub fn threads(&self) -> usize {
        self.pool
            .as_ref()
            .map_or(1, rayon::ThreadPool::current_num_threads)
    }

    #[must_use]
    pub fn hands(&self, p: usize) -> usize {
        self.sh.n[p]
    }

    #[must_use]
    pub fn normalizer(&self) -> f64 {
        self.normalizer
    }

    #[must_use]
    pub fn compact(&self) -> bool {
        self.sh.compact
    }

    #[must_use]
    pub fn sampling_groups(&self) -> usize {
        self.sh.groups
    }

    /// Bytes the TypeScript solver would report (`Solver.bytes`): the
    /// chunk's header carries it, so a byte-identical chunk needs it.
    #[must_use]
    pub fn ts_bytes(&self) -> usize {
        let size = self.sh.game.tree.size;
        let scratch = (self.sh.game.tree.max_depth + 1) * self.slab * 8 * 3;
        let st = &self.st;
        st.regrets.len() * 4
            + st.sums.len() * 4
            + st.regrets16.len() * 2
            + st.sums16.len() * 2
            + st.regret_scale.len() * 4
            + st.sum_scale.len() * 4
            + st.current.len() * 4
            + st.current_stamp.len() * 4
            + st.ev.len() * 4
            + if self.evaluated { size * 4 } else { 0 }
            + size * 4
            + scratch
    }

    /// Bytes this solver holds: storage, the tree and game, scratch.
    #[must_use]
    pub fn native_bytes(&self) -> usize {
        let st = &self.st;
        let tree = &self.sh.game.tree;
        let storage = st.regrets.len() * 4
            + st.current.len() * 4
            + st.current_stamp.len() * 4
            + st.sums.len() * 4
            + st.regrets16.len() * 2
            + st.sums16.len() * 2
            + st.regret_scale.len() * 4
            + st.sum_scale.len() * 4
            + st.ev.len() * 4
            + st.ev_offset.len() * 8
            + st.results.len() * 8
            + st.valid.len()
            + st.slot_reach.len() * 8;
        let tree_bytes = tree.size * (1 + 1 + 4 + 4 + 48 + 4 + 8 + 4 + 8 + 4 + 4 + 4)
            + tree.children.len() * (4 + 4 + 1 + 4);
        let boards: usize = self
            .sh
            .game
            .boards
            .iter()
            .map(|b| (b.order[0].len() + b.order[1].len()) * (4 + 8 + 1 + 1 + 4))
            .sum();
        let scratch = (1 + self.workers.len()) * (tree.max_depth + 1) * self.slab * 8 * 3;
        storage + tree_bytes + boards + scratch
    }

    /* --------------------------------------------------------- freezing - */

    /// Freezes `strategy` (`[action][hand]`) at `node` for the hands `mask`
    /// marks (`Solver.freeze`, §2.1): a frozen hand plays it, its regrets
    /// are never updated, and its average strategy is it.
    ///
    /// # Panics
    /// When `node` is not an action node or the arrays do not fit it.
    pub fn freeze(&mut self, node: usize, strategy: &[f64], mask: &[bool]) {
        let tree = &self.sh.game.tree;
        assert_eq!(tree.kind[node], ACTION, "node {node} is not an action node");
        let count = tree.child_count[node] as usize;
        let size = self.sh.n[usize::from(tree.player[node])];
        assert_eq!(
            strategy.len(),
            count * size,
            "a frozen strategy is [action][hand]"
        );
        assert_eq!(mask.len(), size, "a frozen mask is one flag per hand");
        let frozen = Frozen {
            strategy: strategy.to_vec(),
            mask: mask.to_vec(),
        };
        let at = self.sh.frozen_of[node];
        if at == NONE {
            self.sh.frozen_of[node] = self.sh.frozen.len() as u32;
            self.sh.frozen.push(frozen);
        } else {
            self.sh.frozen[at as usize] = frozen;
        }
        if !self.st.current_stamp.is_empty() {
            // A cached strategy predates the freeze.
            self.st.current_stamp[node] = -2;
        }
    }

    /// Removes every freeze.
    pub fn unfreeze_all(&mut self) {
        self.sh.frozen.clear();
        self.sh.frozen_of.fill(NONE);
        self.st.current_stamp.fill(-2);
    }

    /// Whether any hand at `node` is frozen.
    #[must_use]
    pub fn is_frozen(&self, node: usize) -> bool {
        self.sh.frozen_of[node] != NONE
    }

    /* -------------------------------------------------------- iterating - */

    /// Runs `count` DCFR iterations (each updates both players once).
    pub fn iterate(&mut self, count: u32) {
        let DcfrParams { alpha, beta, gamma } = self.params;
        for _ in 0..count {
            self.iterations += 1;
            let t = f64::from(self.iterations);
            let pa = (t - 1.0).powf(alpha);
            let pb = (t - 1.0).powf(beta);
            let d_pos = pa / (pa + 1.0);
            let d_neg = pb / (pb + 1.0);
            let w_strat = t.powf(gamma);
            self.sampling = self.sh.groups > 1 && t <= self.sample_until;
            if self.sampling {
                if self.cycle.is_empty() {
                    self.cycle = shuffled(self.sh.groups as u32, &mut self.rng);
                }
                self.group = self.cycle.pop().unwrap_or(0) as u8;
            }
            for p in 0..2 {
                let pass = Pass {
                    trav: p,
                    mode: Mode::Cfr,
                    stamp: 2 * self.iterations as i32 + p as i32,
                    d_pos,
                    d_neg,
                    w_strat,
                    sample: self.sampling,
                    group: self.group,
                    groups_f: self.sh.groups as f64,
                    record_ev: false,
                    keep: -1.0,
                };
                self.traverse(pass, None);
            }
        }
    }

    /// Iterates until the target, the cap, or a cancel (`run`).
    pub fn run(
        &mut self,
        options: &RunOptions,
        mut on: impl FnMut(RunEvent<'_>) -> bool,
    ) -> RunResult {
        let max = options.max_iterations;
        let target = options.target_exploitability;
        let every = options.check_every.max(1);
        let from = options.check_from.unwrap_or(every).max(1);
        let mut measured: Option<Exploitability> = None;
        while self.iterations < max {
            let next = if self.iterations < from {
                from
            } else {
                self.iterations + every
            };
            let step = (next - self.iterations).min(max - self.iterations);
            for _ in 0..step {
                self.iterate(1);
                if !on(RunEvent::Iteration(self.iterations)) {
                    return RunResult {
                        iterations: self.iterations,
                        exploitability: measured.unwrap_or_else(Exploitability::unmeasured),
                        stopped_by: StoppedBy::Cancelled,
                    };
                }
            }
            let e = self.exploitability();
            measured = Some(e);
            let keep_going = on(RunEvent::Progress(self.iterations, &e));
            if e.percent_pot <= target {
                return RunResult {
                    iterations: self.iterations,
                    exploitability: e,
                    stopped_by: StoppedBy::Target,
                };
            }
            if !keep_going {
                return RunResult {
                    iterations: self.iterations,
                    exploitability: e,
                    stopped_by: StoppedBy::Cancelled,
                };
            }
        }
        let e = measured.unwrap_or_else(|| self.exploitability());
        RunResult {
            iterations: self.iterations,
            exploitability: e,
            stopped_by: if e.percent_pot <= target {
                StoppedBy::Target
            } else {
                StoppedBy::MaxIterations
            },
        }
    }

    /// Best response and profile values for the current average strategy.
    pub fn exploitability(&mut self) -> Exploitability {
        let br = [
            self.root_value(0, Mode::Best, None),
            self.root_value(1, Mode::Best, None),
        ];
        let value = if self.constant_sum.is_nan() {
            [
                self.root_value(0, Mode::Eval, None),
                self.root_value(1, Mode::Eval, None),
            ]
        } else {
            let v0 = self.root_value(0, Mode::Eval, None);
            [v0, self.constant_sum - v0]
        };
        let nash_conv = br[0] - value[0] + (br[1] - value[1]);
        let exploitability = nash_conv / 2.0;
        Exploitability {
            best_response: br,
            value,
            nash_conv,
            exploitability,
            percent_pot: (100.0 * exploitability) / self.sh.game.pot,
            mbb: (1000.0 * exploitability) / self.sh.game.big_blind.unwrap_or(1.0),
        }
    }

    /// Player `p`'s value under the average profile.
    pub fn value(&mut self, p: usize) -> f64 {
        self.root_value(p, Mode::Eval, None)
    }

    /// Player `p`'s best response (`bestResponse`): its value and, per node of
    /// `p`, the response with each action's EV. `keep >= 0` keeps a hand's
    /// average where it is within `keep` chips of the best.
    pub fn best_response(&mut self, p: usize, keep: f64) -> (f64, HashMap<usize, BestResponseRow>) {
        let record = Mutex::new(HashMap::new());
        let value = self.root_value_keep(p, Mode::Best, Some(&record), keep);
        (value, record.into_inner().unwrap_or_default())
    }

    /// Values of the average profile, recording per-action EVs at the nodes
    /// `record` accepts (`evaluate`); returns each player's value and root EV per hand.
    pub fn evaluate(&mut self, record: impl Fn(usize) -> bool) -> ([f64; 2], [Vec<f64>; 2]) {
        let tree = &self.sh.game.tree;
        let mut ev_offset = vec![-1_i64; tree.size];
        let mut total = 0_usize;
        for node in 0..tree.size {
            if tree.kind[node] == ACTION && record(node) {
                ev_offset[node] = total as i64;
                total +=
                    tree.child_count[node] as usize * self.sh.n[usize::from(tree.player[node])];
            }
        }
        self.st.ev_offset = ev_offset;
        self.st.ev = vec![0.0; total];
        self.evaluated = true;
        let mut value = [0.0; 2];
        let mut root_ev = [vec![0.0; self.sh.n[0]], vec![0.0; self.sh.n[1]]];
        for p in 0..2 {
            value[p] = self.root_value_full(p, Mode::Eval, None, -1.0, true);
            let n = self.sh.n[p];
            let cfv: Vec<f64> = self.root_out[..n].to_vec();
            let mut norm = std::mem::take(&mut self.scratch.tmp.norm);
            compat(
                &self.sh,
                p,
                &self.sh.game.hands[1 - p].weight,
                &mut self.scratch.tmp.card_sum,
                &mut norm,
                1.0,
            );
            for i in 0..n {
                root_ev[p][i] = if norm[i] > 0.0 { cfv[i] / norm[i] } else { 0.0 };
            }
            self.scratch.tmp.norm = norm;
        }
        (value, root_ev)
    }

    /// EVs from the last `evaluate` at `node`, `[action][hand]`, if recorded.
    #[must_use]
    pub fn ev_at(&self, node: usize) -> Option<&[f32]> {
        let off = *self.st.ev_offset.get(node)?;
        if off < 0 {
            return None;
        }
        let tree = &self.sh.game.tree;
        let len = tree.child_count[node] as usize * self.sh.n[usize::from(tree.player[node])];
        Some(&self.st.ev[off as usize..off as usize + len])
    }

    /// Average strategy at an action node, `[action][hand]`.
    ///
    /// # Panics
    /// When `node` is not an action node.
    #[must_use]
    pub fn average_strategy(&self, node: usize) -> Vec<f32> {
        let tree = &self.sh.game.tree;
        assert_eq!(tree.kind[node], ACTION, "node {node} is not an action node");
        let count = tree.child_count[node] as usize;
        let size = self.sh.n[usize::from(tree.player[node])];
        let off = self.sh.offset[node];
        let mut strat = vec![0.0; count * size];
        let mut sum = vec![0.0; size];
        if self.sh.compact {
            average16(
                &self.st.sums16[off..off + count * size],
                count,
                size,
                &mut strat,
                &mut sum,
            );
        } else {
            average(
                &self.st.sums[off..off + count * size],
                count,
                size,
                &mut strat,
                &mut sum,
            );
        }
        apply_frozen(&self.sh, node, count, size, &mut strat);
        strat.iter().map(|&x| x as f32).collect()
    }

    /// Replaces the average strategy at a node (`setAverageStrategy`).
    pub fn set_average_strategy(&mut self, node: usize, strategy: &[f64]) {
        let tree = &self.sh.game.tree;
        let off = self.sh.offset[node];
        let len = tree.child_count[node] as usize * self.sh.n[usize::from(tree.player[node])];
        if self.sh.compact {
            self.st.sum_scale[node] =
                encode_u16(&strategy[..len], &mut self.st.sums16[off..off + len]) as f32;
        } else {
            for k in 0..len {
                self.st.sums[off + k] = strategy[k] as f32;
            }
        }
    }

    /// Copies of the regrets and sums, for a warm start elsewhere (f32 only).
    #[must_use]
    pub fn snapshot_average(&self) -> Option<Vec<f32>> {
        if self.sh.compact {
            None
        } else {
            Some(self.st.sums.clone())
        }
    }

    fn root_value(
        &mut self,
        p: usize,
        mode: Mode,
        best: Option<&Mutex<HashMap<usize, BestResponseRow>>>,
    ) -> f64 {
        self.root_value_full(p, mode, best, -1.0, false)
    }

    fn root_value_keep(
        &mut self,
        p: usize,
        mode: Mode,
        best: Option<&Mutex<HashMap<usize, BestResponseRow>>>,
        keep: f64,
    ) -> f64 {
        self.root_value_full(p, mode, best, keep, false)
    }

    fn root_value_full(
        &mut self,
        p: usize,
        mode: Mode,
        best: Option<&Mutex<HashMap<usize, BestResponseRow>>>,
        keep: f64,
        record_ev: bool,
    ) -> f64 {
        let pass = Pass {
            trav: p,
            mode,
            stamp: 0,
            d_pos: 0.0,
            d_neg: 0.0,
            w_strat: 1.0,
            sample: false,
            group: 0,
            groups_f: 1.0,
            record_ev,
            keep,
        };
        self.traverse(pass, best);
        let w = &self.sh.game.hands[p].weight;
        let mut sum = 0.0;
        for i in 0..self.sh.n[p] {
            sum += w[i] * self.root_out[i];
        }
        sum / self.normalizer
    }

    /// One traversal from the root into `root_out`.
    fn traverse(&mut self, pass: Pass, best: Option<&Mutex<HashMap<usize, BestResponseRow>>>) {
        let raw = self.st.raw();
        let sh = &self.sh;
        let tree = &sh.game.tree;
        if tree.size == 0 {
            return;
        }
        let reach = &sh.game.hands[1 - pass.trav].weight;
        let n = sh.n[pass.trav];
        let root_out = &mut self.root_out[..n];
        let scratch = &mut self.scratch;
        let split = !sh.slots.is_empty();
        let walker = Walker {
            sh,
            raw,
            ps: pass,
            consume: split,
            best,
        };
        if !split {
            walker.walk(
                tree.root,
                &mut scratch.levels,
                &mut scratch.tmp,
                reach,
                root_out,
            );
            return;
        }
        // 1. Collect the split nodes' reach and the tasks.
        let tasks = &mut self.tasks;
        tasks.clear();
        walker.collect(
            tree.root,
            &mut scratch.levels,
            &mut scratch.tmp,
            reach,
            tasks,
        );
        // 2. Solve the subtrees: largest first, each worker taking the next
        // task (so a slow core never ends up holding a big subtree last).
        let weight = &sh.task_weight;
        let starts = &tree.child_start;
        tasks.sort_unstable_by_key(|&(slot, edge)| {
            let e = starts[sh.slots[slot as usize].node as usize] as usize + edge as usize;
            (std::cmp::Reverse(weight[e]), slot, edge)
        });
        let tasks = &*tasks;
        let next = AtomicUsize::new(0);
        let work = |worker: &Mutex<Scratch>| {
            let mut guard = match worker.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(slot, edge)) = tasks.get(k) else {
                    break;
                };
                walker.task(slot as usize, edge as usize, &mut guard);
            }
        };
        match &self.pool {
            Some(pool) => pool.scope(|scope| {
                for worker in &self.workers {
                    scope.spawn(|_| work(worker));
                }
            }),
            None => work(&self.workers[0]),
        }
        // 3. Back up.
        walker.walk(
            tree.root,
            &mut scratch.levels,
            &mut scratch.tmp,
            reach,
            root_out,
        );
    }
}

/* ---------------------------------------------------------------- walk - */

struct Walker<'a> {
    sh: &'a Shared,
    raw: Raw,
    ps: Pass,
    /// Split nodes read their slots (step 3) instead of recursing.
    consume: bool,
    best: Option<&'a Mutex<HashMap<usize, BestResponseRow>>>,
}

impl Walker<'_> {
    fn walk(
        &self,
        node: usize,
        levels: &mut [Level],
        tmp: &mut Tmp,
        reach: &[f64],
        out: &mut [f64],
    ) {
        let tree = &self.sh.game.tree;
        match tree.kind[node] {
            FOLD => {
                let pay = tree.payoff[node * 6 + self.ps.trav * 3];
                compat(self.sh, self.ps.trav, reach, &mut tmp.card_sum, out, pay);
            }
            SHOWDOWN => self.showdown(node, tmp, reach, out),
            CHANCE => self.chance(node, levels, tmp, reach, out),
            _ => {
                if self.sh.compact {
                    self.action_compact(node, levels, tmp, reach, out);
                } else {
                    self.action(node, levels, tmp, reach, out);
                }
            }
        }
    }

    /// The opponent's current strategy at `node` into `strat` (CFR: regret
    /// matched; otherwise the average), frozen hands overridden.
    fn opponent_strategy(
        &self,
        node: usize,
        count: usize,
        m: usize,
        strat: &mut [f64],
        sum: &mut [f64],
    ) {
        let off = self.sh.offset[node];
        let len = count * m;
        // SAFETY: the node's block, owned by this walk.
        unsafe {
            match (self.ps.mode == Mode::Cfr, self.sh.compact) {
                (true, false) => {
                    regret_match(block(self.raw.regrets, off, len), count, m, strat, sum)
                }
                (true, true) => {
                    regret_match16(block(self.raw.regrets16, off, len), count, m, strat, sum)
                }
                (false, false) => average(block(self.raw.sums, off, len), count, m, strat, sum),
                (false, true) => average16(block(self.raw.sums16, off, len), count, m, strat, sum),
            }
        }
        apply_frozen(self.sh, node, count, m, strat);
    }

    /// Step 1: the reach at every split node, and the tasks below them.
    fn collect(
        &self,
        node: usize,
        levels: &mut [Level],
        tmp: &mut Tmp,
        reach: &[f64],
        tasks: &mut Vec<(u32, u32)>,
    ) {
        let sh = self.sh;
        let tree = &sh.game.tree;
        match tree.kind[node] {
            FOLD | SHOWDOWN => {}
            CHANCE => {
                let slot = sh.split_slot[node];
                debug_assert!(slot != NONE, "a chance node above the split");
                let s = sh.slots[slot as usize];
                let m = sh.n[1 - self.ps.trav];
                // SAFETY: this slot's reach, written only here.
                unsafe { block(self.raw.slot_reach, s.reach, m) }.copy_from_slice(&reach[..m]);
                let sample =
                    self.ps.mode == Mode::Cfr && self.ps.sample && sh.sampled_chance[node] == 1;
                for e in tree.edges(node) {
                    if sample && sh.edge_group[e] != self.ps.group {
                        continue;
                    }
                    tasks.push((slot, (e - tree.child_start[node] as usize) as u32));
                }
            }
            _ => {
                let p = self.ps.trav;
                let count = tree.child_count[node] as usize;
                let start = tree.child_start[node] as usize;
                let Some((lvl, deeper)) = levels.split_first_mut() else {
                    return;
                };
                if usize::from(tree.player[node]) == p {
                    for a in 0..count {
                        self.collect(tree.children[start + a] as usize, deeper, tmp, reach, tasks);
                    }
                    return;
                }
                let m = sh.n[1 - p];
                self.opponent_strategy(node, count, m, &mut lvl.strat, &mut tmp.sum);
                for a in 0..count {
                    let base = a * m;
                    let mut any = false;
                    for j in 0..m {
                        let v = reach[j] * lvl.strat[base + j];
                        lvl.reach[base + j] = v;
                        any |= v != 0.0;
                    }
                    if !any {
                        continue;
                    }
                    self.collect(
                        tree.children[start + a] as usize,
                        deeper,
                        tmp,
                        &lvl.reach[base..base + m],
                        tasks,
                    );
                }
            }
        }
    }

    /// Step 2: one split node's edge, on a worker.
    fn task(&self, slot: usize, edge: usize, scratch: &mut Scratch) {
        let sh = self.sh;
        let tree = &sh.game.tree;
        let s = sh.slots[slot];
        let node = s.node as usize;
        let e = tree.child_start[node] as usize + edge;
        let p = self.ps.trav;
        let (n, m) = (sh.n[p], sh.n[1 - p]);
        let theirs = &sh.game.hands[1 - p];
        let card = tree.edge_card[e];
        // SAFETY: the slot's reach is only read in step 2.
        let reach = unsafe { block(self.raw.slot_reach, s.reach, m) };
        let Some((lvl, deeper)) = scratch.levels.split_first_mut() else {
            return;
        };
        let mut any = false;
        for j in 0..m {
            let v = if i32::from(theirs.c1[j]) == i32::from(card)
                || i32::from(theirs.c2[j]) == i32::from(card)
            {
                0.0
            } else {
                reach[j]
            };
            lvl.reach[j] = v;
            any |= v != 0.0;
        }
        // SAFETY: this task's own flag and result block.
        unsafe {
            *self.raw.valid.add(e) = u8::from(any);
        }
        if !any {
            return;
        }
        let out = unsafe { block(self.raw.results, s.results + edge * sh.max_hands, n) };
        self.walk(
            tree.children[e] as usize,
            deeper,
            &mut scratch.tmp,
            &lvl.reach[..m],
            out,
        );
    }

    #[inline(never)]
    fn action(
        &self,
        node: usize,
        levels: &mut [Level],
        tmp: &mut Tmp,
        reach: &[f64],
        out: &mut [f64],
    ) {
        let sh = self.sh;
        let tree = &sh.game.tree;
        let ps = &self.ps;
        let p = ps.trav;
        let n = sh.n[p];
        let m = sh.n[1 - p];
        let start = tree.child_start[node] as usize;
        let count = tree.child_count[node] as usize;
        let off = sh.offset[node];
        let Some((lvl, deeper)) = levels.split_first_mut() else {
            return;
        };
        let out = &mut out[..n];

        if usize::from(tree.player[node]) == p {
            for a in 0..count {
                self.walk(
                    tree.children[start + a] as usize,
                    deeper,
                    tmp,
                    reach,
                    &mut lvl.cfv[a * n..a * n + n],
                );
            }
            let cfv = &lvl.cfv[..count * n];
            if ps.mode == Mode::Best {
                if self.best.is_some() {
                    self.record_best(node, count, n, cfv, &mut lvl.strat, tmp, reach);
                }
                for i in 0..n {
                    let mut best = cfv[i];
                    for a in 1..count {
                        let v = cfv[a * n + i];
                        if v > best {
                            best = v;
                        }
                    }
                    out[i] = best;
                }
                return;
            }
            let strat = &mut lvl.strat[..count * n];
            if ps.mode == Mode::Cfr {
                // SAFETY: the node's own entries.
                let stamp = unsafe { *self.raw.current_stamp.add(node) };
                if stamp == ps.stamp - 1 {
                    let current = unsafe { block(self.raw.current, off, count * n) };
                    for k in 0..count * n {
                        strat[k] = f64::from(current[k]);
                    }
                } else {
                    regret_match(
                        unsafe { block(self.raw.regrets, off, count * n) },
                        count,
                        n,
                        strat,
                        &mut tmp.sum,
                    );
                    apply_frozen(sh, node, count, n, strat);
                }
            } else {
                average(
                    unsafe { block(self.raw.sums, off, count * n) },
                    count,
                    n,
                    strat,
                    &mut tmp.sum,
                );
                apply_frozen(sh, node, count, n, strat);
            }
            combine(strat, cfv, count, n, out);
            if ps.mode == Mode::Cfr {
                let regrets = unsafe { block(self.raw.regrets, off, count * n) };
                let (d_pos, d_neg) = (ps.d_pos, ps.d_neg);
                let frozen = frozen_mask(sh, node);
                for a in 0..count {
                    let base = a * n;
                    let row = &mut regrets[base..base + n];
                    let c = &cfv[base..base + n];
                    match frozen {
                        None => {
                            for i in 0..n {
                                let r = f64::from(row[i]);
                                row[i] = ((if r > 0.0 { r * d_pos } else { r * d_neg }) + c[i]
                                    - out[i]) as f32;
                            }
                        }
                        Some(mask) => {
                            for i in 0..n {
                                if mask[i] {
                                    continue;
                                }
                                let r = f64::from(row[i]);
                                row[i] = ((if r > 0.0 { r * d_pos } else { r * d_neg }) + c[i]
                                    - out[i]) as f32;
                            }
                        }
                    }
                }
            } else {
                self.record_ev(node, count, n, cfv, tmp, reach);
            }
            return;
        }

        // Opponent's node.
        let strat = &mut lvl.strat[..count * m];
        if ps.mode == Mode::Cfr {
            regret_match(
                unsafe { block(self.raw.regrets, off, count * m) },
                count,
                m,
                strat,
                &mut tmp.sum,
            );
            apply_frozen(sh, node, count, m, strat);
            let current = unsafe { block(self.raw.current, off, count * m) };
            for k in 0..count * m {
                current[k] = strat[k] as f32;
            }
            unsafe {
                *self.raw.current_stamp.add(node) = ps.stamp;
            }
            let sums = unsafe { block(self.raw.sums, off, count * m) };
            let w = ps.w_strat;
            for a in 0..count {
                let base = a * m;
                let row = &mut sums[base..base + m];
                let s = &strat[base..base + m];
                for j in 0..m {
                    row[j] = (f64::from(row[j]) + w * reach[j] * s[j]) as f32;
                }
            }
        } else {
            average(
                unsafe { block(self.raw.sums, off, count * m) },
                count,
                m,
                strat,
                &mut tmp.sum,
            );
            apply_frozen(sh, node, count, m, strat);
        }
        self.opponent_children(node, start, count, n, m, lvl, deeper, tmp, reach, out);
    }

    /// The children of an opponent node: split the reach, recurse, sum.
    fn opponent_children(
        &self,
        node: usize,
        start: usize,
        count: usize,
        n: usize,
        m: usize,
        lvl: &mut Level,
        deeper: &mut [Level],
        tmp: &mut Tmp,
        reach: &[f64],
        out: &mut [f64],
    ) {
        let _ = node;
        let tree = &self.sh.game.tree;
        out.fill(0.0);
        for a in 0..count {
            let base = a * m;
            let mut any = false;
            {
                let s = &lvl.strat[base..base + m];
                let r = &mut lvl.reach[base..base + m];
                for j in 0..m {
                    let v = reach[j] * s[j];
                    r[j] = v;
                    any |= v != 0.0;
                }
            }
            if !any {
                continue;
            }
            let c_base = a * n;
            self.walk(
                tree.children[start + a] as usize,
                deeper,
                tmp,
                &lvl.reach[base..base + m],
                &mut lvl.cfv[c_base..c_base + n],
            );
            let c = &lvl.cfv[c_base..c_base + n];
            for i in 0..n {
                out[i] += c[i];
            }
        }
    }

    #[inline(never)]
    fn action_compact(
        &self,
        node: usize,
        levels: &mut [Level],
        tmp: &mut Tmp,
        reach: &[f64],
        out: &mut [f64],
    ) {
        let sh = self.sh;
        let tree = &sh.game.tree;
        let ps = &self.ps;
        let p = ps.trav;
        let n = sh.n[p];
        let m = sh.n[1 - p];
        let start = tree.child_start[node] as usize;
        let count = tree.child_count[node] as usize;
        let off = sh.offset[node];
        let Some((lvl, deeper)) = levels.split_first_mut() else {
            return;
        };
        let out = &mut out[..n];

        if usize::from(tree.player[node]) == p {
            for a in 0..count {
                self.walk(
                    tree.children[start + a] as usize,
                    deeper,
                    tmp,
                    reach,
                    &mut lvl.cfv[a * n..a * n + n],
                );
            }
            let cfv = &lvl.cfv[..count * n];
            if ps.mode == Mode::Best {
                if self.best.is_some() {
                    self.record_best(node, count, n, cfv, &mut lvl.strat, tmp, reach);
                }
                for i in 0..n {
                    let mut best = cfv[i];
                    for a in 1..count {
                        let v = cfv[a * n + i];
                        if v > best {
                            best = v;
                        }
                    }
                    out[i] = best;
                }
                return;
            }
            let strat = &mut lvl.strat[..count * n];
            if ps.mode == Mode::Cfr {
                regret_match16(
                    unsafe { block(self.raw.regrets16, off, count * n) },
                    count,
                    n,
                    strat,
                    &mut tmp.sum,
                );
            } else {
                average16(
                    unsafe { block(self.raw.sums16, off, count * n) },
                    count,
                    n,
                    strat,
                    &mut tmp.sum,
                );
            }
            apply_frozen(sh, node, count, n, strat);
            combine(strat, cfv, count, n, out);
            if ps.mode == Mode::Cfr {
                // SAFETY: the node's own entries.
                let regrets = unsafe { block(self.raw.regrets16, off, count * n) };
                let scale = f64::from(unsafe { *self.raw.regret_scale.add(node) });
                let (d_pos, d_neg) = (ps.d_pos, ps.d_neg);
                let next = &mut lvl.reach[..count * n];
                let frozen = frozen_mask(sh, node);
                for a in 0..count {
                    let base = a * n;
                    for i in 0..n {
                        let r = f64::from(regrets[base + i]) * scale;
                        next[base + i] = if frozen.is_some_and(|mask| mask[i]) {
                            r
                        } else {
                            (if r > 0.0 { r * d_pos } else { r * d_neg }) + cfv[base + i] - out[i]
                        };
                    }
                }
                let new_scale = encode_i16(next, regrets);
                unsafe {
                    *self.raw.regret_scale.add(node) = new_scale as f32;
                }
            } else {
                self.record_ev(node, count, n, cfv, tmp, reach);
            }
            return;
        }

        // Opponent's node.
        let strat = &mut lvl.strat[..count * m];
        if ps.mode == Mode::Cfr {
            regret_match16(
                unsafe { block(self.raw.regrets16, off, count * m) },
                count,
                m,
                strat,
                &mut tmp.sum,
            );
            apply_frozen(sh, node, count, m, strat);
            let sums = unsafe { block(self.raw.sums16, off, count * m) };
            let scale = f64::from(unsafe { *self.raw.sum_scale.add(node) });
            let w = ps.w_strat;
            let buf = &mut lvl.reach[..count * m];
            for a in 0..count {
                let base = a * m;
                for j in 0..m {
                    buf[base + j] =
                        f64::from(sums[base + j]) * scale + w * reach[j] * strat[base + j];
                }
            }
            let new_scale = encode_u16(buf, sums);
            unsafe {
                *self.raw.sum_scale.add(node) = new_scale as f32;
            }
        } else {
            average16(
                unsafe { block(self.raw.sums16, off, count * m) },
                count,
                m,
                strat,
                &mut tmp.sum,
            );
            apply_frozen(sh, node, count, m, strat);
        }
        self.opponent_children(node, start, count, n, m, lvl, deeper, tmp, reach, out);
    }

    /// EVs at the traverser's node during `evaluate`.
    fn record_ev(
        &self,
        node: usize,
        count: usize,
        n: usize,
        cfv: &[f64],
        tmp: &mut Tmp,
        reach: &[f64],
    ) {
        if !self.ps.record_ev || node >= self.raw.ev_len {
            return;
        }
        // SAFETY: read-only offsets.
        let ev_off = unsafe { *self.raw.ev_offset.add(node) };
        if ev_off < 0 {
            return;
        }
        compat(
            self.sh,
            self.ps.trav,
            reach,
            &mut tmp.card_sum,
            &mut tmp.norm,
            1.0,
        );
        let norm = &tmp.norm;
        // SAFETY: the node's own EV block.
        let ev = unsafe { block(self.raw.ev, ev_off as usize, count * n) };
        for a in 0..count {
            let base = a * n;
            for i in 0..n {
                ev[base + i] = (if norm[i] > 0.0 {
                    cfv[base + i] / norm[i]
                } else {
                    0.0
                }) as f32;
            }
        }
    }

    fn record_best(
        &self,
        node: usize,
        count: usize,
        n: usize,
        cfv: &[f64],
        strat: &mut [f64],
        tmp: &mut Tmp,
        reach: &[f64],
    ) {
        let sh = self.sh;
        compat(
            sh,
            self.ps.trav,
            reach,
            &mut tmp.card_sum,
            &mut tmp.norm,
            1.0,
        );
        let off = sh.offset[node];
        let strat = &mut strat[..count * n];
        // SAFETY: read of the node's own block.
        unsafe {
            if sh.compact {
                average16(
                    block(self.raw.sums16, off, count * n),
                    count,
                    n,
                    strat,
                    &mut tmp.sum,
                );
            } else {
                average(
                    block(self.raw.sums, off, count * n),
                    count,
                    n,
                    strat,
                    &mut tmp.sum,
                );
            }
        }
        apply_frozen(sh, node, count, n, strat);
        let norm = &tmp.norm;
        let keep = self.ps.keep;
        let mut row_strategy = vec![0.0_f32; count * n];
        let mut row_ev = vec![0.0_f32; count * n];
        for i in 0..n {
            let mut best = cfv[i];
            let mut best_a = 0;
            let mut mix = strat[i] * cfv[i];
            for a in 1..count {
                let v = cfv[a * n + i];
                mix += strat[a * n + i] * v;
                if v > best {
                    best = v;
                    best_a = a;
                }
            }
            let kept = keep >= 0.0 && mix >= best - keep * norm[i];
            for a in 0..count {
                row_strategy[a * n + i] = if kept {
                    strat[a * n + i] as f32
                } else if a == best_a {
                    1.0
                } else {
                    0.0
                };
                row_ev[a * n + i] = (if norm[i] > 0.0 {
                    cfv[a * n + i] / norm[i]
                } else {
                    0.0
                }) as f32;
            }
        }
        if let Some(record) = self.best
            && let Ok(mut map) = record.lock()
        {
            map.insert(
                node,
                BestResponseRow {
                    strategy: row_strategy,
                    ev: row_ev,
                },
            );
        }
    }

    #[inline(never)]
    fn chance(
        &self,
        node: usize,
        levels: &mut [Level],
        tmp: &mut Tmp,
        reach: &[f64],
        out: &mut [f64],
    ) {
        let sh = self.sh;
        let tree = &sh.game.tree;
        let ps = &self.ps;
        let p = ps.trav;
        let n = sh.n[p];
        let m = sh.n[1 - p];
        let mine = &sh.game.hands[p];
        let theirs = &sh.game.hands[1 - p];
        let sample = ps.mode == Mode::Cfr && ps.sample && sh.sampled_chance[node] == 1;
        let w = tree.chance_weight[node] * (if sample { ps.groups_f } else { 1.0 });
        let out = &mut out[..n];
        out.fill(0.0);
        let slot = if self.consume {
            sh.split_slot[node]
        } else {
            NONE
        };
        let Some((lvl, deeper)) = levels.split_first_mut() else {
            return;
        };
        let start = tree.child_start[node] as usize;
        for e in tree.edges(node) {
            if sample && sh.edge_group[e] != ps.group {
                continue;
            }
            let card = tree.edge_card[e] as i32;
            let cfv: &[f64] = if slot == NONE {
                let mut any = false;
                for j in 0..m {
                    let v = if i32::from(theirs.c1[j]) == card || i32::from(theirs.c2[j]) == card {
                        0.0
                    } else {
                        reach[j]
                    };
                    lvl.reach[j] = v;
                    any |= v != 0.0;
                }
                if !any {
                    continue;
                }
                self.walk(
                    tree.children[e] as usize,
                    deeper,
                    tmp,
                    &lvl.reach[..m],
                    &mut lvl.cfv[..n],
                );
                &lvl.cfv[..n]
            } else {
                // SAFETY: written by this edge's task in step 2.
                if unsafe { *self.raw.valid.add(e) } == 0 {
                    continue;
                }
                let s = sh.slots[slot as usize];
                unsafe { block(self.raw.results, s.results + (e - start) * sh.max_hands, n) }
            };
            for i in 0..n {
                if i32::from(mine.c1[i]) != card && i32::from(mine.c2[i]) != card {
                    out[i] += w * cfv[i];
                }
            }
            if let Some(twins) = sh.game.mirrors_of(e) {
                for twin in twins {
                    let other = i32::from(twin.card);
                    let map = &sh.game.maps[twin.map as usize][p];
                    for i in 0..n {
                        if i32::from(mine.c1[i]) != other && i32::from(mine.c2[i]) != other {
                            out[i] += w * cfv[map[i] as usize];
                        }
                    }
                }
            }
        }
    }

    #[inline(never)]
    fn showdown(&self, node: usize, tmp: &mut Tmp, reach: &[f64], out: &mut [f64]) {
        let sh = self.sh;
        let tree = &sh.game.tree;
        let p = self.ps.trav;
        let o = 1 - p;
        let n = sh.n[p];
        let board_id = tree.board[node] as usize;
        let board = &sh.game.boards[board_id];
        let sorted = &sh.sorted[board_id];
        let pc1 = &sorted.c1[p][..];
        let pc2 = &sorted.c2[p][..];
        let psame = &sorted.same[p][..];
        let oc1 = &sorted.c1[o][..];
        let oc2 = &sorted.c2[o][..];
        let ord_p = &board.order[p][..];
        let ord_o = &board.order[o][..];
        let below = &sorted.below[p][..];
        let upto = &sorted.upto[p][..];
        let nv = ord_p.len();
        let mv = ord_o.len();
        let base = node * 6 + p * 3;
        let win = tree.payoff[base];
        let lose = tree.payoff[base + 1];
        let tie = tree.payoff[base + 2];
        let out = &mut out[..n];
        if nv < n {
            out.fill(0.0);
        }
        let wins = &mut tmp.win[..nv];
        let cs = &mut tmp.card_sum[..];
        let acc = &mut tmp.card_sum2[..];
        cs.fill(0.0);
        acc.fill(0.0);
        assert!(
            pc1.len() == nv
                && pc2.len() == nv
                && psame.len() == nv
                && below.len() == nv
                && upto.len() == nv,
            "showdown tables"
        );
        assert!(oc1.len() == mv && oc2.len() == mv, "showdown tables");
        // SAFETY: every index below is a hand position (< nv or < mv, checked
        // above), a card (< num_cards + 2 = the card sums' length), or a hand
        // index of the board's order (< the reach and out lengths, which are
        // the players' hand counts).
        unsafe {
            // Ascending: compatible opponent reach strictly weaker than each
            // hand; run on to the end for the totals.
            let mut cum = 0.0;
            let mut k = 0;
            for t in 0..nv {
                let stop = *below.get_unchecked(t) as usize;
                while k < stop {
                    let v = *reach.get_unchecked(*ord_o.get_unchecked(k) as usize);
                    if v != 0.0 {
                        cum += v;
                        *cs.get_unchecked_mut(usize::from(*oc1.get_unchecked(k))) += v;
                        *cs.get_unchecked_mut(usize::from(*oc2.get_unchecked(k))) += v;
                    }
                    k += 1;
                }
                *wins.get_unchecked_mut(t) = cum
                    - *cs.get_unchecked(usize::from(*pc1.get_unchecked(t)))
                    - *cs.get_unchecked(usize::from(*pc2.get_unchecked(t)));
            }
            while k < mv {
                let v = *reach.get_unchecked(*ord_o.get_unchecked(k) as usize);
                if v != 0.0 {
                    cum += v;
                    *cs.get_unchecked_mut(usize::from(*oc1.get_unchecked(k))) += v;
                    *cs.get_unchecked_mut(usize::from(*oc2.get_unchecked(k))) += v;
                }
                k += 1;
            }
            let total = cum;
            // Descending: strictly stronger; then combine.
            cum = 0.0;
            let mut k = mv;
            let win_minus_lose = win - lose;
            let tie_minus_lose = tie - lose;
            for t in (0..nv).rev() {
                let stop = *upto.get_unchecked(t) as usize;
                while k > stop {
                    k -= 1;
                    let v = *reach.get_unchecked(*ord_o.get_unchecked(k) as usize);
                    if v != 0.0 {
                        cum += v;
                        *acc.get_unchecked_mut(usize::from(*oc1.get_unchecked(k))) += v;
                        *acc.get_unchecked_mut(usize::from(*oc2.get_unchecked(k))) += v;
                    }
                }
                let a = usize::from(*pc1.get_unchecked(t));
                let b = usize::from(*pc2.get_unchecked(t));
                let losses = cum - *acc.get_unchecked(a) - *acc.get_unchecked(b);
                let sm = *psame.get_unchecked(t);
                let all = total - *cs.get_unchecked(a) - *cs.get_unchecked(b)
                    + if sm >= 0 {
                        *reach.get_unchecked(sm as usize)
                    } else {
                        0.0
                    };
                let w = *wins.get_unchecked(t);
                *out.get_unchecked_mut(*ord_p.get_unchecked(t) as usize) =
                    lose * all + win_minus_lose * w + tie_minus_lose * (all - w - losses);
            }
        }
    }
}

/// `out[i] = Σ_a strat[a][i] * cfv[a][i]`, in the TypeScript's order.
fn combine(strat: &[f64], cfv: &[f64], count: usize, n: usize, out: &mut [f64]) {
    for i in 0..n {
        out[i] = strat[i] * cfv[i];
    }
    for a in 1..count {
        let base = a * n;
        let s = &strat[base..base + n];
        let c = &cfv[base..base + n];
        for i in 0..n {
            out[i] += s[i] * c[i];
        }
    }
}

fn frozen_mask(sh: &Shared, node: usize) -> Option<&[bool]> {
    let at = sh.frozen_of[node];
    if at == NONE {
        None
    } else {
        Some(&sh.frozen[at as usize].mask)
    }
}

fn apply_frozen(sh: &Shared, node: usize, count: usize, size: usize, strat: &mut [f64]) {
    let at = sh.frozen_of[node];
    if at == NONE {
        return;
    }
    let f = &sh.frozen[at as usize];
    for a in 0..count {
        let base = a * size;
        for i in 0..size {
            if f.mask[i] {
                strat[base + i] = f.strategy[base + i];
            }
        }
    }
}

/// `out[i] = scale * (opponent reach compatible with the traverser's hand i)`.
fn compat(sh: &Shared, trav: usize, reach: &[f64], cs: &mut [f64], out: &mut [f64], scale: f64) {
    let mine = &sh.game.hands[trav];
    let theirs = &sh.game.hands[1 - trav];
    let n = sh.n[trav];
    let m = sh.n[1 - trav];
    let same = &sh.same[trav];
    cs.fill(0.0);
    let mut total = 0.0;
    for j in 0..m {
        let v = reach[j];
        if v != 0.0 {
            total += v;
            cs[usize::from(theirs.c1[j])] += v;
            cs[usize::from(theirs.c2[j])] += v;
        }
    }
    for i in 0..n {
        let s = same[i];
        let back = if s >= 0 { reach[s as usize] } else { 0.0 };
        out[i] = scale * (total - cs[usize::from(mine.c1[i])] - cs[usize::from(mine.c2[i])] + back);
    }
}

fn regret_match(regrets: &[f32], count: usize, size: usize, strat: &mut [f64], sum: &mut [f64]) {
    let sum = &mut sum[..size];
    sum.fill(0.0);
    for a in 0..count {
        let row = &regrets[a * size..a * size + size];
        for i in 0..size {
            let r = f64::from(row[i]);
            if r > 0.0 {
                sum[i] += r;
            }
        }
    }
    let uniform = 1.0 / count as f64;
    for a in 0..count {
        let base = a * size;
        let row = &regrets[base..base + size];
        let out = &mut strat[base..base + size];
        for i in 0..size {
            let r = f64::from(row[i]);
            let s = sum[i];
            out[i] = if s > 0.0 {
                if r > 0.0 { r / s } else { 0.0 }
            } else {
                uniform
            };
        }
    }
}

fn regret_match16(regrets: &[i16], count: usize, size: usize, strat: &mut [f64], sum: &mut [f64]) {
    let sum = &mut sum[..size];
    sum.fill(0.0);
    for a in 0..count {
        let row = &regrets[a * size..a * size + size];
        for i in 0..size {
            let r = row[i];
            if r > 0 {
                sum[i] += f64::from(r);
            }
        }
    }
    let uniform = 1.0 / count as f64;
    for a in 0..count {
        let base = a * size;
        let row = &regrets[base..base + size];
        let out = &mut strat[base..base + size];
        for i in 0..size {
            let r = row[i];
            let s = sum[i];
            out[i] = if s > 0.0 {
                if r > 0 { f64::from(r) / s } else { 0.0 }
            } else {
                uniform
            };
        }
    }
}

fn average(sums: &[f32], count: usize, size: usize, strat: &mut [f64], sum: &mut [f64]) {
    let sum = &mut sum[..size];
    sum.fill(0.0);
    for a in 0..count {
        let row = &sums[a * size..a * size + size];
        for i in 0..size {
            sum[i] += f64::from(row[i]);
        }
    }
    let uniform = 1.0 / count as f64;
    for a in 0..count {
        let base = a * size;
        let row = &sums[base..base + size];
        let out = &mut strat[base..base + size];
        for i in 0..size {
            let s = sum[i];
            out[i] = if s > 0.0 {
                f64::from(row[i]) / s
            } else {
                uniform
            };
        }
    }
}

fn average16(sums: &[u16], count: usize, size: usize, strat: &mut [f64], sum: &mut [f64]) {
    let sum = &mut sum[..size];
    sum.fill(0.0);
    for a in 0..count {
        let row = &sums[a * size..a * size + size];
        for i in 0..size {
            sum[i] += f64::from(row[i]);
        }
    }
    let uniform = 1.0 / count as f64;
    for a in 0..count {
        let base = a * size;
        let row = &sums[base..base + size];
        let out = &mut strat[base..base + size];
        for i in 0..size {
            let s = sum[i];
            out[i] = if s > 0.0 {
                f64::from(row[i]) / s
            } else {
                uniform
            };
        }
    }
}

/// `Math.round` for the encoders: the nearest integer, halves up. Exact
/// (`x - floor(x)` is), branch-free so the loops vectorise; the sign of a
/// zero, the one thing it drops, does not survive the integer cast anyway.
#[inline]
fn round_half_up(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `encodeI16`: int16 at the block's own scale; returns the scale.
fn encode_i16(values: &[f64], out: &mut [i16]) -> f64 {
    let mut max = 0.0_f64;
    for &v in values {
        let a = if v < 0.0 { -v } else { v };
        if a > max {
            max = a;
        }
    }
    if !(max > 0.0) || !max.is_finite() {
        out.fill(0);
        return 0.0;
    }
    let inv = 32767.0 / max;
    for (o, &v) in out.iter_mut().zip(values) {
        *o = round_half_up(v * inv) as i16;
    }
    max / 32767.0
}

/// `encodeU16`: uint16 for non-negative values; returns the scale.
fn encode_u16(values: &[f64], out: &mut [u16]) -> f64 {
    let mut max = 0.0_f64;
    for &v in values {
        if v > max {
            max = v;
        }
    }
    if !(max > 0.0) || !max.is_finite() {
        out.fill(0);
        return 0.0;
    }
    let inv = 65535.0 / max;
    for (o, &v) in out.iter_mut().zip(values) {
        *o = if v > 0.0 {
            round_half_up(v * inv) as u16
        } else {
            0
        };
    }
    max / 65535.0
}

/// mulberry32, as the TypeScript seeds the sampling order.
fn mulberry32(state: &mut u32) -> f64 {
    *state = state.wrapping_add(0x6d2b_79f5);
    let mut t = *state;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    f64::from(t ^ (t >> 14)) / 4_294_967_296.0
}

fn shuffled(count: u32, rng: &mut u32) -> Vec<u32> {
    let mut out: Vec<u32> = (0..count).collect();
    for k in (1..count as usize).rev() {
        let j = (mulberry32(rng) * (k as f64 + 1.0)).floor() as usize;
        out.swap(k, j);
    }
    out
}

fn same_index(game: &Game, p: usize) -> Vec<i32> {
    let mine = &game.hands[p];
    let theirs = &game.hands[1 - p];
    let key = |a: u8, b: u8| {
        if a < b {
            usize::from(a) * 64 + usize::from(b)
        } else {
            usize::from(b) * 64 + usize::from(a)
        }
    };
    let mut lookup = HashMap::new();
    for j in 0..theirs.size {
        lookup.insert(key(theirs.c1[j], theirs.c2[j]), j as i32);
    }
    (0..mine.size)
        .map(|i| *lookup.get(&key(mine.c1[i], mine.c2[i])).unwrap_or(&-1))
        .collect()
}

fn constant_sum(game: &Game) -> f64 {
    let tree = &game.tree;
    let mut value = f64::NAN;
    let mut same = |x: f64| {
        if value.is_nan() {
            value = x;
            return true;
        }
        (x - value).abs() <= 1e-9 * 1f64.max(value.abs())
    };
    for node in 0..tree.size {
        let b = node * 6;
        let pay = &tree.payoff;
        if tree.kind[node] == FOLD {
            if !same(pay[b] + pay[b + 3]) {
                return f64::NAN;
            }
        } else if tree.kind[node] == SHOWDOWN
            && (!same(pay[b] + pay[b + 4])
                || !same(pay[b + 1] + pay[b + 3])
                || !same(pay[b + 2] + pay[b + 5]))
        {
            return f64::NAN;
        }
    }
    value
}
