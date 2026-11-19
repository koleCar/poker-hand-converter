//! A nodelock solve as the desktop app asks for it (docs/NODELOCK.md §2.4,
//! §2.5, §5.6): the spot (built on the TypeScript side from the library
//! chunk), the `LockSet`, the baseline for earlier nodes, and the chunk
//! header to wrap the result in. Kept here, not in the app, so it is tested
//! with the engine.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::cards::base64_decode;
use crate::cfr::{DcfrParams, RunOptions, StoppedBy, Storage};
use crate::chunk::{decode, encode_chunk, wrap_chunk};
use crate::lock::{LockSet, apply_plan, chunk_baseline, lock_symmetries, plan_locks};
use crate::solve::Scope;
use crate::spot::{Prepared, SolveOptions, prepare};
use crate::subgame::SpotInput;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    pub max_iterations: u32,
    pub target_pct: f64,
    #[serde(default)]
    pub check_from: Option<u32>,
    pub check_every: u32,
    pub dcfr: DcfrParams,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodelockRequest {
    /// The game to solve: a flop spot (a flop lock) or a live turn spot (a
    /// turn or river lock), ranges as base64 `f64`.
    pub spot: SpotInput,
    pub lock_set: LockSet,
    /// Base64 of the library chunk: the baseline of a flop lock's earlier
    /// nodes. A turn or river lock's baseline is its unlocked live turn,
    /// solved here first when `earlier` asks for one.
    #[serde(default)]
    pub baseline: Option<String>,
    /// The result chunk's header, exactly as `JSON.stringify` wrote it.
    pub header: String,
    pub options: RequestOptions,
    /// Worker threads; default all cores but one.
    #[serde(default)]
    pub threads: Option<usize>,
    /// Storage; default float32 when it fits the memory budget, else 16-bit.
    #[serde(default)]
    pub storage: Option<Storage>,
    /// Bytes float32 storage may take before falling back to 16-bit.
    #[serde(default)]
    pub memory_budget: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodelockProgress {
    pub iteration: u32,
    pub exploitability_pct: Option<f64>,
    pub elapsed_ms: f64,
    pub eta_ms: Option<f64>,
    pub memory_mb: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodelockStats {
    pub iterations: u32,
    pub exploitability_pct: f64,
    pub seconds: f64,
    pub peak_mb: f64,
    pub threads: usize,
    pub engine: &'static str,
    pub storage: &'static str,
    pub stopped_by: &'static str,
    /// The solve went on from the last lock's solver on the same spot.
    pub warm: bool,
}

#[derive(Debug)]
pub struct NodelockOutcome {
    pub chunk: Vec<u8>,
    pub stats: NodelockStats,
}

/// A lock path as the app writes it, in the game being solved: on a turn or
/// river lock (`X-X~Kd/B2.5`) the live turn's own path (`B2.5`).
#[must_use]
pub fn game_path(path: &str) -> &str {
    match path.find('~') {
        Some(at) => path[at..]
            .find('/')
            .map_or("", |slash| &path[at + slash + 1..]),
        None => path,
    }
}

/// Predicts when the exploitability reaches the target from the last two
/// measurements, as a power law in the iteration count.
#[derive(Debug, Default)]
struct Eta {
    points: Vec<(f64, f64)>,
}

impl Eta {
    fn iterations_to(&self, target: f64) -> Option<f64> {
        let [.., (t1, p1), (t2, p2)] = self.points[..] else {
            return None;
        };
        if !(p1 > p2 && p2 > 0.0 && t2 > t1) {
            return None;
        }
        if p2 <= target {
            return Some(t2);
        }
        let k = (p1 / p2).ln() / (t2 / t1).ln();
        Some(t2 * (p2 / target).powf(1.0 / k))
    }
}

/// The warm start's iteration (`NODELOCK_WARM_ITERATION`).
pub const WARM_ITERATION: u32 = 10;

fn run_options(o: &RequestOptions) -> RunOptions {
    RunOptions {
        max_iterations: o.max_iterations,
        target_exploitability: o.target_pct,
        check_every: o.check_every,
        check_from: o.check_from,
    }
}

/// The live turn's own settings (`LIVE_TURN`), for a turn lock's baseline.
fn live_turn() -> RequestOptions {
    RequestOptions {
        max_iterations: 400,
        target_pct: 0.5,
        check_from: Some(30),
        check_every: 10,
        dcfr: DcfrParams {
            alpha: 1.5,
            beta: 0.0,
            gamma: 3.0,
        },
    }
}

/// The last solve's game and solver, kept in memory for a warm start of the
/// next lock on the same spot (§2.5, `NodelockWarm` in the TypeScript). It is
/// keyed by the spot (its symmetry included), the solver's settings and the
/// baseline; a request for anything else frees it first.
pub struct NodelockWarm {
    key: String,
    baseline: Option<String>,
    prepared: Prepared,
    /// A turn game's unlocked strategies at its decisions (its earlier
    /// nodes' baseline), once solved.
    turn_baseline: Option<Vec<Option<Vec<f64>>>>,
}

impl NodelockWarm {
    /// The solver's arrays, bytes.
    #[must_use]
    pub fn bytes(&self) -> usize {
        self.prepared.solver.native_bytes()
    }
}

impl std::fmt::Debug for NodelockWarm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodelockWarm")
            .field("prepared", &self.prepared)
            .field("turn_baseline", &self.turn_baseline.is_some())
            .finish_non_exhaustive()
    }
}

/// What makes two requests the same game and solver: the spot as solved
/// (symmetry included) and the solver's settings. The run's own settings
/// (iterations, target) are not part of it.
fn warm_key(spot: &SpotInput, options: &SolveOptions) -> Result<String, String> {
    serde_json::to_string(&(
        spot,
        options.dcfr,
        options.storage,
        options.threads,
        options.memory_budget,
    ))
    .map_err(|e| e.to_string())
}

/// Runs a nodelock solve (`solveNodelock`, the TypeScript reference, step
/// for step), always cold. `cancel` stops it between iterations.
///
/// # Errors
/// Bad input, a lock that does not fit the tree, or a cancel (`"cancelled"`).
pub fn run_nodelock(
    request: &NodelockRequest,
    cancel: &AtomicBool,
    on_progress: impl FnMut(&NodelockProgress),
) -> Result<NodelockOutcome, String> {
    run_nodelock_warm(request, &mut None, cancel, on_progress)
}

/// Runs a nodelock solve, going on from `warm` when it holds the same spot
/// (`solveNodelock` with `warm`, as the worker engine keeps it): the old
/// locks are unfrozen, the new ones frozen, the average restarted at
/// [`WARM_ITERATION`] and the regrets kept. Anything else in `warm` is freed
/// before the new game is built. Afterwards `warm` holds this solve's game
/// and solver, a cancelled or failed one's included (its regrets are as
/// good a start as any).
///
/// # Errors
/// Bad input, a lock that does not fit the tree, or a cancel (`"cancelled"`).
pub fn run_nodelock_warm(
    request: &NodelockRequest,
    warm: &mut Option<NodelockWarm>,
    cancel: &AtomicBool,
    on_progress: impl FnMut(&NodelockProgress),
) -> Result<NodelockOutcome, String> {
    let flop = request.spot.board.len() == 3;
    let threads = request.threads.unwrap_or_else(default_threads).max(1);
    let o = &request.options;
    let mut spot = request.spot.clone();
    if spot.isomorphism.unwrap_or(false) && spot.symmetry.is_none() {
        let board = crate::cards::parse_cards(&spot.board).map_err(|e| e.0)?;
        spot.symmetry = Some(lock_symmetries(&request.lock_set, &board));
    }
    let options = SolveOptions {
        run: run_options(o),
        dcfr: o.dcfr,
        // The reference's: 16-bit for a flop lock (as the library), float32 for a turn.
        storage: request
            .storage
            .unwrap_or(if flop { Storage::I16 } else { Storage::F32 }),
        threads,
        scope: if flop { Scope::Flop } else { Scope::All },
        memory_budget: if request.storage.is_some() {
            None
        } else {
            request.memory_budget
        },
    };
    let key = warm_key(&spot, &options)?;
    // Another spot's solver is freed before this one is built.
    let kept = warm
        .take()
        .filter(|w| w.key == key && w.baseline == request.baseline);
    let is_warm = kept.is_some();
    let mut state = match kept {
        Some(mut state) => {
            state.prepared.restart_clock();
            state
        }
        None => NodelockWarm {
            key,
            baseline: request.baseline.clone(),
            prepared: prepare(&spot, &options)?,
            turn_baseline: None,
        },
    };
    let outcome = solve_on(
        request,
        &spot,
        &options,
        &mut state,
        is_warm,
        cancel,
        on_progress,
    );
    *warm = Some(state);
    outcome
}

/// One solve on `state`'s game (warm when `is_warm`).
fn solve_on(
    request: &NodelockRequest,
    spot: &SpotInput,
    options: &SolveOptions,
    state: &mut NodelockWarm,
    is_warm: bool,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&NodelockProgress),
) -> Result<NodelockOutcome, String> {
    let flop = options.scope == Scope::Flop;
    let o = &request.options;
    let plan = plan_locks(
        &state.prepared.built,
        &state.prepared.solver.game().tree,
        &request.lock_set,
    )?;

    let mut eta = Eta::default();
    let mut peak_mb = 0.0_f64;
    let target = o.target_pct;
    let max = f64::from(o.max_iterations);
    let mut report = |p: &crate::spot::Progress, eta: &mut Eta, first: u32| {
        peak_mb = peak_mb.max(p.memory_mb);
        if p.measured {
            eta.points
                .push((f64::from(p.iteration), p.exploitability_pct));
        }
        let per_iteration = p.elapsed_ms / f64::from(p.iteration.saturating_sub(first).max(1));
        let eta_ms = eta
            .iterations_to(target)
            .map(|t| (t.min(max) - f64::from(p.iteration)).max(0.0) * per_iteration);
        on_progress(&NodelockProgress {
            iteration: p.iteration,
            exploitability_pct: if p.exploitability_pct.is_nan() {
                None
            } else {
                Some(p.exploitability_pct)
            },
            elapsed_ms: p.elapsed_ms,
            eta_ms,
            memory_mb: p.memory_mb,
        });
        !cancel.load(Ordering::Relaxed)
    };

    let mut warm = is_warm;
    let applied = if flop {
        let bytes = request
            .baseline
            .as_deref()
            .and_then(base64_decode)
            .ok_or("a flop lock needs the library chunk")?;
        let chunk = decode(&bytes)?;
        let prepared = &mut state.prepared;
        let built = &prepared.built;
        // `checkBaseline`: the chunk was solved on this game.
        // (Pot and stack within float noise: the header's JSON need not parse back to the same bits.)
        let near = |a: f64, b: f64| (a - b).abs() <= 1e-9 * a.abs().max(1.0);
        // A range lock (§9.2) changes the hands on purpose: then only the pot and the stack.
        if (chunk.hands != built.combos && !request.lock_set.has_ranges())
            || !near(chunk.pot, built.pot)
            || !near(chunk.stack, built.stack)
        {
            return Err("the library chunk was solved on other ranges than the spot's".into());
        }
        if warm {
            prepared.solver.unfreeze_all();
            prepared.solver.restart_average(WARM_ITERATION);
        }
        let lookup = chunk_baseline(&chunk, built);
        apply_plan(built, &mut prepared.solver, plan, Some(&lookup))?
    } else {
        let earlier = !plan.earlier.is_empty();
        // Earlier nodes freeze at the unlocked turn's strategies: a warm
        // solver that never solved it starts cold.
        warm = is_warm && (state.turn_baseline.is_some() || !earlier);
        if is_warm && !warm {
            state.turn_baseline = None;
            state.prepared = prepare(spot, options)?;
        }
        if warm {
            state.prepared.solver.unfreeze_all();
        }
        if earlier && state.turn_baseline.is_none() {
            // The baseline: the unlocked turn, solved as the live turn solves it.
            let run = state.prepared.run(&run_options(&live_turn()), |p| {
                let mut ignore = Eta::default();
                report(p, &mut ignore, 0)
            });
            if run.stopped_by == StoppedBy::Cancelled {
                return Err("cancelled".into());
            }
            let solver = &state.prepared.solver;
            let tree = &solver.game().tree;
            state.turn_baseline = Some(
                (0..tree.size)
                    .map(|node| {
                        (tree.kind[node] == crate::tree::ACTION).then(|| {
                            solver
                                .average_strategy(node)
                                .iter()
                                .map(|&x| f64::from(x))
                                .collect()
                        })
                    })
                    .collect(),
            );
        }
        let baseline = state.turn_baseline.as_ref();
        let lookup = |node: usize| baseline.and_then(|b| b[node].clone());
        let prepared = &mut state.prepared;
        let applied = apply_plan(&prepared.built, &mut prepared.solver, plan, Some(&lookup))?;
        if earlier || warm {
            prepared.solver.restart_average(WARM_ITERATION);
        }
        applied
    };
    // The pace counts from the iteration the run starts at (a warm one at WARM_ITERATION).
    let first = state.prepared.solver.iterations;
    let run = state
        .prepared
        .run(&options.run, |p| report(p, &mut eta, first));
    if run.stopped_by == StoppedBy::Cancelled {
        return Err("cancelled".into());
    }
    let solved = state.prepared.finish_kept(run, applied, options.scope);
    let chunk = if flop {
        encode_chunk(&request.header, &solved.result)?
    } else {
        wrap_chunk(&request.header, &solved.result)
    };
    Ok(NodelockOutcome {
        chunk,
        stats: NodelockStats {
            iterations: solved.run.iterations,
            exploitability_pct: solved.result.exploitability_pct,
            seconds: solved.seconds,
            peak_mb: peak_mb.max(solved.native_bytes as f64 / 1e6),
            threads: solved.threads,
            engine: "native",
            storage: match solved.storage {
                Storage::F32 => "f32",
                Storage::I16 => "i16",
            },
            stopped_by: solved.run.stopped_by.name(),
            warm,
        },
    })
}

/// All cores but one.
#[must_use]
pub fn default_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_paths_read_in_the_live_turn() {
        assert_eq!(game_path("X-B1.82"), "X-B1.82");
        assert_eq!(game_path(""), "");
        assert_eq!(game_path("X-X~Kd/B2.5"), "B2.5");
        assert_eq!(game_path("X-X~Kd/"), "");
        assert_eq!(game_path("X-B2-C~7h/X-B3-C|2c|X"), "X-B3-C|2c|X");
    }

    #[test]
    fn eta_follows_a_power_law() {
        let eta = Eta {
            points: vec![(40.0, 4.0), (80.0, 2.0)],
        };
        let t = eta.iterations_to(1.0).unwrap_or(0.0);
        assert!((t - 160.0).abs() < 1e-9, "{t}");
    }
}
