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
use crate::spot::{SolveOptions, prepare};
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

/// Runs a nodelock solve (`solveNodelock`, the TypeScript reference, step
/// for step). `cancel` stops it between iterations.
///
/// # Errors
/// Bad input, a lock that does not fit the tree, or a cancel (`"cancelled"`).
pub fn run_nodelock(
    request: &NodelockRequest,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&NodelockProgress),
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
    let mut prepared = prepare(&spot, &options)?;
    let plan = plan_locks(
        &prepared.built,
        &prepared.solver.game().tree,
        &request.lock_set,
    )?;

    let mut eta = Eta::default();
    let mut peak_mb = 0.0_f64;
    let target = o.target_pct;
    let max = f64::from(o.max_iterations);
    let mut report = |p: &crate::spot::Progress, eta: &mut Eta| {
        peak_mb = peak_mb.max(p.memory_mb);
        if p.measured {
            eta.points
                .push((f64::from(p.iteration), p.exploitability_pct));
        }
        let per_iteration = p.elapsed_ms / f64::from(p.iteration.max(1));
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

    let applied = if flop {
        let bytes = request
            .baseline
            .as_deref()
            .and_then(base64_decode)
            .ok_or("a flop lock needs the library chunk")?;
        let chunk = decode(&bytes)?;
        let built = &prepared.built;
        // `checkBaseline`: the chunk was solved on this game.
        // (Pot and stack within float noise: the header's JSON need not parse back to the same bits.)
        let near = |a: f64, b: f64| (a - b).abs() <= 1e-9 * a.abs().max(1.0);
        if chunk.hands != built.combos
            || !near(chunk.pot, built.pot)
            || !near(chunk.stack, built.stack)
        {
            return Err("the library chunk was solved on other ranges than the spot's".into());
        }
        let lookup = chunk_baseline(&chunk, built);
        apply_plan(built, &mut prepared.solver, plan, Some(&lookup))?
    } else {
        let mut baseline: Option<Vec<Option<Vec<f64>>>> = None;
        if !plan.earlier.is_empty() {
            // The baseline: the unlocked turn, solved as the live turn solves it.
            let run = prepared.run(&run_options(&live_turn()), |p| {
                let mut ignore = Eta::default();
                report(p, &mut ignore)
            });
            if run.stopped_by == StoppedBy::Cancelled {
                return Err("cancelled".into());
            }
            let tree = &prepared.solver.game().tree;
            baseline = Some(
                (0..tree.size)
                    .map(|node| {
                        (tree.kind[node] == crate::tree::ACTION).then(|| {
                            prepared
                                .solver
                                .average_strategy(node)
                                .iter()
                                .map(|&x| f64::from(x))
                                .collect()
                        })
                    })
                    .collect(),
            );
        }
        let warm = baseline.is_some();
        let lookup = |node: usize| baseline.as_ref().and_then(|b| b[node].clone());
        let applied = apply_plan(&prepared.built, &mut prepared.solver, plan, Some(&lookup))?;
        if warm {
            prepared.solver.restart_average(WARM_ITERATION);
        }
        applied
    };
    let run = prepared.run(&options.run, |p| report(p, &mut eta));
    if run.stopped_by == StoppedBy::Cancelled {
        return Err("cancelled".into());
    }
    let solved = prepared.finish(run, applied, options.scope);
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
