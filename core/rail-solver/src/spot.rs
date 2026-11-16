//! Solving a spot end to end (`solveFlop`, `solveBuilt`): build the game for
//! the board's street, apply any locks, run DCFR with progress and cancel,
//! extract the result.

use std::time::Instant;

use crate::betting::Street;
use crate::cfr::{
    DEFAULT_DCFR, DcfrParams, RunEvent, RunOptions, RunResult, Solver, SolverConfig, Storage,
};
use crate::chunk::DecodedSolve;
use crate::flop::build_flop_game;
use crate::lock::{Applied, LockSet, apply_plan, chunk_baseline, plan_locks};
use crate::solve::{Scope, SolveResult, extract};
use crate::subgame::{BuiltSubgame, SpotInput, build_river_game, build_turn_game};

/// Builds the game for a spot: 3 board cards a flop game, 4 a turn, 5 a river.
///
/// # Errors
/// Bad input.
pub fn build(spot: &SpotInput) -> Result<BuiltSubgame, crate::SolverInputError> {
    match spot.board.len() {
        3 => build_flop_game(spot),
        4 => build_turn_game(spot),
        _ => build_river_game(spot),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SolveOptions {
    pub run: RunOptions,
    pub dcfr: DcfrParams,
    pub storage: Storage,
    pub threads: usize,
    pub scope: Scope,
    /// When set: float32 storage if it fits in this many bytes, else 16-bit
    /// (`storage` is then ignored).
    pub memory_budget: Option<usize>,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            run: RunOptions::default(),
            dcfr: DEFAULT_DCFR,
            storage: Storage::F32,
            threads: 1,
            scope: Scope::All,
            memory_budget: None,
        }
    }
}

/// Progress after every iteration (`FlopProgress` plus memory).
#[derive(Debug, Clone, Copy)]
pub struct Progress {
    pub iteration: u32,
    pub elapsed_ms: f64,
    /// Last measured exploitability, % of the pot; NaN before the first.
    pub exploitability_pct: f64,
    /// Whether this call follows a measurement.
    pub measured: bool,
    /// The solver's memory, MB.
    pub memory_mb: f64,
}

#[derive(Debug)]
pub struct Solved {
    pub result: SolveResult,
    pub run: RunResult,
    pub applied: Applied,
    pub nodes: usize,
    pub action_nodes: usize,
    pub boards: usize,
    pub turn_classes: usize,
    pub native_bytes: usize,
    pub storage: Storage,
    pub threads: usize,
    pub seconds: f64,
}

/// A built game and its solver, between the steps of a solve.
pub struct Prepared {
    pub built: BuiltSubgame,
    pub solver: Solver,
    pub storage: Storage,
    nodes: usize,
    action_nodes: usize,
    boards: usize,
    turn_classes: usize,
    started: Instant,
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared")
            .field("nodes", &self.nodes)
            .field("storage", &self.storage)
            .finish()
    }
}

/// Builds the game and its solver.
///
/// # Errors
/// Bad input.
pub fn prepare(spot: &SpotInput, options: &SolveOptions) -> Result<Prepared, String> {
    let started = Instant::now();
    let mut built = build(spot).map_err(|e| e.0)?;
    let tree = &built.game.tree;
    let action_nodes = tree
        .kind
        .iter()
        .filter(|&&k| k == crate::tree::ACTION)
        .count();
    let nodes = tree.size;
    let boards = built.game.boards.len();
    let turn_classes = if built.street == Street::Flop {
        built.turn_classes
    } else {
        0
    };
    let storage = match options.memory_budget {
        Some(budget) if Solver::storage_bytes(&built.game, Storage::F32) <= budget => Storage::F32,
        Some(_) => Storage::I16,
        None => options.storage,
    };
    let solver = Solver::new(
        std::mem::take(&mut built.game),
        options.dcfr,
        SolverConfig {
            storage,
            sampling: None,
            threads: options.threads,
        },
    );
    Ok(Prepared {
        built,
        solver,
        storage,
        nodes,
        action_nodes,
        boards,
        turn_classes,
        started,
    })
}

impl Prepared {
    /// Runs DCFR, calling `on` after every iteration and measurement
    /// (returning false cancels).
    pub fn run(&mut self, run: &RunOptions, mut on: impl FnMut(&Progress) -> bool) -> RunResult {
        let started = self.started;
        let mut last = f64::NAN;
        let memory_mb = self.solver.native_bytes() as f64 / 1e6;
        self.solver.run(run, |event| {
            let (iteration, measured) = match event {
                RunEvent::Iteration(t) => (t, false),
                RunEvent::Progress(t, e) => {
                    last = e.percent_pot;
                    (t, true)
                }
            };
            on(&Progress {
                iteration,
                elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                exploitability_pct: last,
                measured,
                memory_mb,
            })
        })
    }

    /// Starts the clock of a new solve on this game (a warm start: the
    /// elapsed time and `seconds` count from here).
    pub fn restart_clock(&mut self) {
        self.started = Instant::now();
    }

    /// Extracts the result.
    pub fn finish(mut self, run: RunResult, applied: Applied, scope: Scope) -> Solved {
        self.finish_kept(run, applied, scope)
    }

    /// Extracts the result and keeps the game and its solver (for a warm
    /// start of the next lock on it).
    pub fn finish_kept(&mut self, run: RunResult, applied: Applied, scope: Scope) -> Solved {
        let result = extract(&self.built, &mut self.solver, &run, scope);
        Solved {
            result,
            run,
            applied,
            nodes: self.nodes,
            action_nodes: self.action_nodes,
            boards: self.boards,
            turn_classes: self.turn_classes,
            native_bytes: self.solver.native_bytes(),
            storage: self.storage,
            threads: self.solver.threads(),
            seconds: self.started.elapsed().as_secs_f64(),
        }
    }
}

/// Solves `spot` with `locks` frozen (earlier nodes at `baseline`, a decoded
/// chunk of the same game), calling `on` after every iteration and
/// measurement (returning false cancels).
///
/// # Errors
/// Bad input or a lock that does not fit the tree.
pub fn solve(
    spot: &SpotInput,
    options: &SolveOptions,
    locks: Option<&LockSet>,
    baseline: Option<&DecodedSolve>,
    on: impl FnMut(&Progress) -> bool,
) -> Result<Solved, String> {
    let mut prepared = prepare(spot, options)?;
    let applied = match locks {
        Some(set) => {
            let lookup = baseline.map(|b| chunk_baseline(b, &prepared.built));
            let base: Option<&dyn Fn(usize) -> Option<Vec<f64>>> = lookup.as_ref().map(|f| f as _);
            let plan = plan_locks(&prepared.built, &prepared.solver.game().tree, set)?;
            apply_plan(&prepared.built, &mut prepared.solver, plan, base)?
        }
        None => Applied::default(),
    };
    let run = prepared.run(&options.run, on);
    Ok(prepared.finish(run, applied, options.scope))
}

/// A solve's decision nodes as a baseline for earlier-node freezing (what a
/// decoded chunk gives, without encoding it).
#[must_use]
pub fn baseline_of(result: &SolveResult) -> DecodedSolve {
    DecodedSolve {
        pot: result.pot,
        stack: result.stack,
        hands: result.hands.clone(),
        nodes: result
            .nodes
            .iter()
            .filter(|n| !n.chance)
            .map(|n| crate::chunk::DecodedNode {
                path: n.path.clone(),
                player: n.player as usize,
                labels: n.labels.clone(),
                strategy: n.strategy.iter().map(|&x| f64::from(x)).collect(),
            })
            .collect(),
    }
}
