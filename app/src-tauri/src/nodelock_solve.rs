//! Nodelock solves on this computer with the native engine
//! (`core/rail-solver`, docs/NODELOCK.md §2.5).
//!
//! - `nodelock_engine_info`: what a solve will use (threads, cores,
//!   performance and efficiency cores where the OS says, memory by street),
//!   for the line under the Solve button.
//! - `nodelock_solve_start(req)`: starts a solve on its own thread and
//!   answers its job id at once. `req` is `rail_solver::nodelock::NodelockRequest`:
//!   the spot (built by the window from the library chunk), the `LockSet`,
//!   the library chunk as the baseline, the result chunk's header.
//! - Progress arrives as `nodelock://progress` events (`{ id, iteration,
//!   exploitabilityPct, elapsedMs, etaMs, memoryMb }`), the end as one
//!   `nodelock://done` (`{ id, ok, error, stats }`).
//! - `nodelock_solve_result(id)`: the chunk's bytes as a raw response (once;
//!   the job is then forgotten). `nodelock_solve_cancel(id)`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use rail_solver::nodelock::{
    NodelockProgress, NodelockRequest, NodelockStats, default_threads, run_nodelock,
};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Runtime};

pub const PROGRESS_EVENT: &str = "nodelock://progress";
pub const DONE_EVENT: &str = "nodelock://done";

/// Share of the computer's memory float32 storage may take before a solve
/// falls back to 16-bit: two fifths.
fn share(bytes: u64) -> u64 {
    bytes / 5 * 2
}

#[derive(Debug, Default)]
struct Job {
    cancel: Arc<AtomicBool>,
    chunk: Option<Vec<u8>>,
}

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryByStreet {
    pub flop: u64,
    pub turn: u64,
    pub river: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// Threads a solve uses unless told otherwise: all cores but one.
    pub threads: usize,
    pub cores: usize,
    /// Performance and efficiency cores (Apple silicon); null elsewhere.
    pub cores_performance: Option<usize>,
    pub cores_efficiency: Option<usize>,
    /// This computer's memory, MB; null when the OS does not say.
    pub total_memory_mb: Option<u64>,
    /// About this much at the peak of a solve, MB, by the street locked.
    pub memory_mb: MemoryByStreet,
}

#[cfg(target_os = "macos")]
fn sysctl(name: &str) -> Option<u64> {
    let out = std::process::Command::new("/usr/sbin/sysctl")
        .arg("-n")
        .arg(name)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(target_os = "macos"))]
fn sysctl(_: &str) -> Option<u64> {
    None
}

fn total_memory() -> Option<u64> {
    sysctl("hw.memsize")
}

fn memory_budget() -> Option<usize> {
    total_memory().and_then(|bytes| usize::try_from(share(bytes)).ok())
}

/// What a nodelock solve on this computer will use.
#[tauri::command]
pub fn nodelock_engine_info() -> EngineInfo {
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let total = total_memory();
    // Measured on the flop-m1 BTN vs BB Ks5h3s spot (docs/NODELOCK.md §0):
    // ~3.1 GB in float32, ~1.1 GB in 16-bit; a live turn ~0.15 GB.
    let flop_f32: u64 = 3_100;
    let flop = match total {
        Some(bytes) if flop_f32 * 1_000_000 > share(bytes) => 1_100,
        _ => flop_f32,
    };
    EngineInfo {
        threads: default_threads(),
        cores,
        cores_performance: sysctl("hw.perflevel0.physicalcpu")
            .and_then(|n| usize::try_from(n).ok()),
        cores_efficiency: sysctl("hw.perflevel1.physicalcpu").and_then(|n| usize::try_from(n).ok()),
        total_memory_mb: total.map(|b| b / 1_000_000),
        memory_mb: MemoryByStreet {
            flop,
            turn: 150,
            river: 20,
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    id: &'a str,
    #[serde(flatten)]
    progress: NodelockProgress,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    id: String,
    ok: bool,
    error: Option<String>,
    stats: Option<NodelockStats>,
}

/// Starts a nodelock solve; answers its job id.
#[tauri::command]
pub fn nodelock_solve_start<R: Runtime>(
    app: AppHandle<R>,
    mut req: NodelockRequest,
) -> Result<String, String> {
    if req.memory_budget.is_none() {
        req.memory_budget = memory_budget();
    }
    let id = format!("native-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let cancel = Arc::new(AtomicBool::new(false));
    jobs()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            id.clone(),
            Job {
                cancel: Arc::clone(&cancel),
                chunk: None,
            },
        );
    let job = id.clone();
    std::thread::Builder::new()
        .name("nodelock-solve".into())
        .spawn(move || {
            let mut last = Instant::now()
                .checked_sub(Duration::from_secs(1))
                .unwrap_or_else(Instant::now);
            let outcome = run_nodelock(&req, &cancel, |progress| {
                // Turn iterations take milliseconds: at most ten events a second.
                if last.elapsed() >= Duration::from_millis(100)
                    || progress.exploitability_pct.is_some()
                {
                    last = Instant::now();
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        ProgressEvent {
                            id: &job,
                            progress: *progress,
                        },
                    );
                }
            });
            let done = match outcome {
                Ok(outcome) => {
                    if let Some(entry) = jobs()
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get_mut(&job)
                    {
                        entry.chunk = Some(outcome.chunk);
                    }
                    DoneEvent {
                        id: job.clone(),
                        ok: true,
                        error: None,
                        stats: Some(outcome.stats),
                    }
                }
                Err(error) => {
                    jobs()
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&job);
                    DoneEvent {
                        id: job.clone(),
                        ok: false,
                        error: Some(error),
                        stats: None,
                    }
                }
            };
            if let Err(error) = app.emit(DONE_EVENT, done) {
                log::warn!("nodelock: could not send the end of {job}: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(id)
}

/// Asks a running solve to stop; false when there is no such job.
#[tauri::command]
pub fn nodelock_solve_cancel(id: String) -> bool {
    jobs()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&id)
        .is_some_and(|job| {
            job.cancel.store(true, Ordering::Relaxed);
            true
        })
}

/// A finished solve's chunk, once; no bytes when there is none.
#[tauri::command]
pub fn nodelock_solve_result(id: String) -> Response {
    let mut jobs = jobs().lock().unwrap_or_else(PoisonError::into_inner);
    match jobs.get(&id) {
        Some(job) if job.chunk.is_some() => {
            Response::new(jobs.remove(&id).and_then(|j| j.chunk).unwrap_or_default())
        }
        _ => Response::new(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_info_names_the_cores() {
        let info = nodelock_engine_info();
        assert!(info.cores >= 1 && info.threads >= 1 && info.threads <= info.cores);
        if let (Some(p), Some(e)) = (info.cores_performance, info.cores_efficiency) {
            assert_eq!(p + e, info.cores);
        }
        assert!(!nodelock_solve_cancel("nothing".into()));
    }
}
