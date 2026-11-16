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
//! - **Warm start.** The process keeps the last solve's game and solver
//!   (`NodelockWarm`, a cancelled solve's too). The next lock on the same
//!   spot goes on from it (`stats.warm`); a lock on another spot frees it
//!   first, and so does `nodelock_release` (the engine's `release()`).
//! - One solve at a time: a second start while one runs is refused.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use rail_solver::nodelock::{
    NodelockProgress, NodelockRequest, NodelockStats, NodelockWarm, default_threads,
    run_nodelock_warm,
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

/// A solve is running.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Clears `RUNNING` when dropped: at the end of a solve, or if it panics.
struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

/// The last solve's game and solver, for a warm start. A solve takes it out
/// while it runs and puts its own back, unless `nodelock_release` was called
/// meanwhile (`generation` moved).
#[derive(Debug, Default)]
struct WarmSlot {
    warm: Option<NodelockWarm>,
    generation: u64,
}

fn warm_slot() -> &'static Mutex<WarmSlot> {
    static WARM: OnceLock<Mutex<WarmSlot>> = OnceLock::new();
    WARM.get_or_init(|| Mutex::new(WarmSlot::default()))
}

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
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Err("a nodelock solve is already running".into());
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
    let spawned = std::thread::Builder::new()
        .name("nodelock-solve".into())
        .spawn(move || {
            let running = Running;
            let mut last = Instant::now()
                .checked_sub(Duration::from_secs(1))
                .unwrap_or_else(Instant::now);
            let (mut warm, generation) = {
                let mut slot = warm_slot().lock().unwrap_or_else(PoisonError::into_inner);
                (slot.warm.take(), slot.generation)
            };
            let outcome = run_nodelock_warm(&req, &mut warm, &cancel, |progress| {
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
            {
                let mut slot = warm_slot().lock().unwrap_or_else(PoisonError::into_inner);
                if slot.generation == generation {
                    slot.warm = warm;
                }
            }
            // Before the end is sent, so the window may start the next solve at once.
            drop(running);
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
        });
    if let Err(error) = spawned {
        RUNNING.store(false, Ordering::Release);
        jobs()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
        return Err(error.to_string());
    }
    Ok(id)
}

/// Frees the solver kept for a warm start (the engine's `release()`); a
/// solve running now keeps its own but does not store it.
#[tauri::command]
pub fn nodelock_release() {
    let mut slot = warm_slot().lock().unwrap_or_else(PoisonError::into_inner);
    slot.warm = None;
    slot.generation += 1;
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

    /// The command path end to end, through Tauri's IPC on the mock runtime:
    /// the request exactly as `native.ts` sends it (a fixture written by
    /// `npm run solver:fixtures` in `tests/`: the reduced Ks5h3s flop, a
    /// half-locked node with "player" earlier nodes, the library chunk as
    /// base64), progress and done events, the chunk as a raw response, a
    /// warm second lock, `nodelock_release`, a refused second start and a
    /// cancel.
    mod commands {
        use std::sync::mpsc::{Receiver, channel};
        use std::time::Duration;

        use serde_json::{Value, json};
        use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
        use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response};
        use tauri::webview::InvokeRequest;
        use tauri::{Listener, WebviewWindow, WebviewWindowBuilder};

        use super::super::{DONE_EVENT, PROGRESS_EVENT};

        const WAIT: Duration = Duration::from_secs(120);

        fn fixture() -> Value {
            serde_json::from_str(include_str!("../tests/fixtures/nodelock-request.json"))
                .expect("the request fixture")
        }

        fn invoke(
            webview: &WebviewWindow<MockRuntime>,
            cmd: &str,
            args: Value,
        ) -> Result<InvokeResponseBody, Value> {
            let url = if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            };
            get_ipc_response(
                webview,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: url.parse().expect("a url"),
                    body: InvokeBody::Json(args),
                    headers: tauri::http::HeaderMap::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
        }

        fn json_of(body: InvokeResponseBody) -> Value {
            body.deserialize::<Value>().expect("a JSON answer")
        }

        fn start(webview: &WebviewWindow<MockRuntime>, request: &Value) -> String {
            let id = invoke(webview, "nodelock_solve_start", json!({ "req": request }))
                .expect("started");
            json_of(id).as_str().expect("a job id").to_owned()
        }

        /// The job's events up to and including its end: (progress, done).
        fn events_of(events: &Receiver<(bool, Value)>, id: &str) -> (Vec<Value>, Value) {
            let mut progress = Vec::new();
            loop {
                let (done, event) = events.recv_timeout(WAIT).expect("an event");
                if event["id"] != id {
                    continue;
                }
                if done {
                    return (progress, event);
                }
                progress.push(event);
            }
        }

        /// The chunk's header (`RFLB`, version, its JSON's length, the JSON).
        fn header_of(chunk: &[u8]) -> Value {
            assert_eq!(chunk.get(0..4), Some(&b"RFLB"[..]), "a chunk");
            let len = chunk
                .get(8..12)
                .and_then(|b| <[u8; 4]>::try_from(b).ok())
                .map(u32::from_le_bytes)
                .and_then(|n| usize::try_from(n).ok())
                .expect("a header length");
            serde_json::from_slice(chunk.get(12..12 + len).expect("the header"))
                .expect("the header's JSON")
        }

        fn result(webview: &WebviewWindow<MockRuntime>, id: &str) -> Vec<u8> {
            match invoke(webview, "nodelock_solve_result", json!({ "id": id })) {
                Ok(InvokeResponseBody::Raw(bytes)) => bytes,
                other => panic!("the result is raw bytes: {other:?}"),
            }
        }

        #[test]
        fn a_solve_through_the_commands() {
            let app = tauri::test::mock_builder()
                .invoke_handler(tauri::generate_handler![
                    super::super::nodelock_engine_info,
                    super::super::nodelock_solve_start,
                    super::super::nodelock_solve_cancel,
                    super::super::nodelock_solve_result,
                    super::super::nodelock_release,
                ])
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("a mock app");
            let webview = WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
                .build()
                .expect("a window");
            let (tx, events) = channel::<(bool, Value)>();
            for (name, done) in [(PROGRESS_EVENT, false), (DONE_EVENT, true)] {
                let tx = tx.clone();
                app.listen_any(name, move |event| {
                    let payload = serde_json::from_str(event.payload()).expect("an event's JSON");
                    let _ = tx.send((done, payload));
                });
            }
            let fx = fixture();

            // What a solve will use.
            let info = json_of(invoke(&webview, "nodelock_engine_info", json!({})).expect("info"));
            assert!(info["threads"].as_u64().is_some_and(|n| n >= 1), "{info}");
            assert!(info["memoryMb"]["flop"].as_u64().is_some(), "{info}");

            // A cold solve: progress, the end, the chunk once.
            invoke(&webview, "nodelock_release", json!({})).expect("released");
            let id = start(&webview, &fx["request"]);
            let (progress, done) = events_of(&events, &id);
            assert_eq!(done["ok"], true, "{done}");
            let stats = &done["stats"];
            assert_eq!(stats["engine"], "native");
            assert_eq!(stats["warm"], false);
            assert_eq!(
                stats["iterations"],
                fx["request"]["options"]["maxIterations"]
            );
            assert!(!progress.is_empty());
            assert!(progress.iter().all(|p| p["iteration"].as_u64().is_some()
                && p["elapsedMs"].is_number()
                && p["memoryMb"].is_number()));
            let chunk = result(&webview, &id);
            assert_eq!(header_of(&chunk)["lockHash"], fx["lockHash"]);
            let decoded = rail_solver::chunk::decode(&chunk).expect("the chunk decodes");
            assert!(!decoded.nodes.is_empty());
            assert!(
                result(&webview, &id).is_empty(),
                "the chunk is answered once"
            );

            // The next lock on the spot goes on warm.
            let id = start(&webview, &fx["next"]);
            let (_, done) = events_of(&events, &id);
            assert_eq!(
                (&done["ok"], &done["stats"]["warm"]),
                (&json!(true), &json!(true))
            );
            assert_eq!(
                header_of(&result(&webview, &id))["lockHash"],
                fx["nextLockHash"]
            );

            // A long solve: a second start is refused while it runs; a cancel ends it with no chunk.
            let mut long = fx["request"].clone();
            long["options"]["maxIterations"] = json!(1000);
            long["options"]["targetPct"] = json!(0);
            let id = start(&webview, &long);
            let refused = invoke(&webview, "nodelock_solve_start", json!({ "req": long }));
            assert!(refused.is_err(), "a second solve at once");
            loop {
                let (done, event) = events.recv_timeout(WAIT).expect("an event");
                assert!(
                    !done || event["id"] != id,
                    "ended before the cancel: {event}"
                );
                if event["id"] == id {
                    break;
                }
            }
            let cancelled = json_of(
                invoke(&webview, "nodelock_solve_cancel", json!({ "id": id })).expect("cancel"),
            );
            assert_eq!(cancelled, true);
            let (_, done) = events_of(&events, &id);
            assert_eq!(
                (&done["ok"], &done["error"]),
                (&json!(false), &json!("cancelled"))
            );
            assert!(result(&webview, &id).is_empty());

            // The cancelled solve was kept for a warm start; a release frees it.
            invoke(&webview, "nodelock_release", json!({})).expect("released");
            let id = start(&webview, &fx["next"]);
            let (_, done) = events_of(&events, &id);
            assert_eq!(
                (&done["ok"], &done["stats"]["warm"]),
                (&json!(true), &json!(false))
            );
            assert_eq!(
                header_of(&result(&webview, &id))["lockHash"],
                fx["nextLockHash"]
            );
            invoke(&webview, "nodelock_release", json!({})).expect("released");
        }
    }
}
