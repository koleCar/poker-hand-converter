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
use crate::lock::{Applied, LockSet, apply_locks};
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
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            run: RunOptions::default(),
            dcfr: DEFAULT_DCFR,
            storage: Storage::F32,
            threads: 1,
            scope: Scope::All,
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
    pub threads: usize,
    pub seconds: f64,
}

/// Solves `spot` with `locks` frozen, calling `on` after every iteration and
/// measurement (returning false cancels).
///
/// # Errors
/// Bad input or a lock that does not fit the tree.
pub fn solve(
    spot: &SpotInput,
    options: &SolveOptions,
    locks: Option<&LockSet>,
    baseline: Option<&DecodedSolve>,
    mut on: impl FnMut(&Progress) -> bool,
) -> Result<Solved, String> {
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
    let mut solver = Solver::new(
        std::mem::take(&mut built.game),
        options.dcfr,
        SolverConfig {
            storage: options.storage,
            sampling: None,
            threads: options.threads,
        },
    );
    let applied = match locks {
        Some(set) => apply_locks(&built, &mut solver, set, baseline)?,
        None => Applied::default(),
    };
    let mut last = f64::NAN;
    let run = solver.run(&options.run, |event| {
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
        })
    });
    let result = extract(&built, &mut solver, &run, options.scope);
    Ok(Solved {
        result,
        run,
        applied,
        nodes,
        action_nodes,
        boards,
        turn_classes,
        native_bytes: solver.native_bytes(),
        threads: solver.threads(),
        seconds: started.elapsed().as_secs_f64(),
    })
}
