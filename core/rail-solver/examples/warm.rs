//! Wall time of a warm re-solve on a real spot (docs/NODELOCK.md §0): a
//! flop lock solved cold to the target, then a second lock on the same spot
//! going on from its solver, as the app does.
//!
//! ```text
//! cargo run --release -p rail-solver --example warm -- \
//!     target/rail-solver-fixtures/flop-m1-spot.json <library chunk .bin> \
//!     [--threads 9] [--storage f32|i16] [--target 1] [--second 0.5] [--cold-too]
//! ```
//!
//! The spot file is what `npm run solver:fixtures` writes from the chart set
//! (`flop-m1-spot.json`: the 6-max 100bb set, BTN vs BB, Ks5h3s); the chunk
//! is that spot's library chunk (its earlier nodes' baseline). The locks are
//! on BTN's node after BB checks: first "always the first bet size", then
//! "that bet at `--second` (default half), check the rest". `--cold-too` also
//! solves the second lock cold, for comparison.

#![allow(
    clippy::float_arithmetic,
    clippy::unwrap_used,
    clippy::print_stdout,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation
)]

use std::sync::atomic::AtomicBool;

use rail_solver::cards::base64_encode;
use rail_solver::cfr::{DcfrParams, Storage};
use rail_solver::lock::{LockEarlier, LockSet, LockSpot, NodeLockSpec};
use rail_solver::nodelock::{NodelockRequest, RequestOptions, run_nodelock_warm};

const COMBOS: usize = 1326;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|k| args.get(k + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fx: serde_json::Value =
        serde_json::from_slice(&std::fs::read(args.get(1).expect("spot file")).unwrap()).unwrap();
    let chunk = std::fs::read(args.get(2).expect("library chunk")).unwrap();
    let threads: usize = arg(&args, "--threads").map_or(9, |s| s.parse().unwrap());
    let storage = match arg(&args, "--storage").as_deref() {
        Some("i16") => Storage::I16,
        _ => Storage::F32,
    };
    let target: f64 = arg(&args, "--target").map_or(1.0, |s| s.parse().unwrap());
    let second: f64 = arg(&args, "--second").map_or(0.5, |s| s.parse().unwrap());
    let header: serde_json::Value = serde_json::from_str(fx["header"].as_str().unwrap()).unwrap();
    let o = &fx["options"];
    let d = &o["dcfr"];

    let library = rail_solver::chunk::decode(&chunk).unwrap();
    let node = library
        .nodes
        .iter()
        .find(|n| n.path == "X")
        .expect("BTN's node after a check");
    let bet = node
        .labels
        .iter()
        .position(|l| l.starts_with('B'))
        .expect("a bet");
    let lock = |share: f64| -> LockSet {
        let strategy = (0..node.labels.len())
            .map(|a| {
                let p = if a == bet {
                    share
                } else if a == 0 {
                    1.0 - share
                } else {
                    0.0
                };
                vec![p; COMBOS]
            })
            .collect();
        LockSet {
            version: 1,
            spot: LockSpot {
                set: header["charts"]["id"].as_str().unwrap().into(),
                line: header["line"].as_str().unwrap().into(),
                flop: header["flop"].as_str().unwrap().into(),
                turn: None,
                river: None,
            },
            nodes: vec![NodeLockSpec {
                street: "flop".into(),
                path: node.path.clone(),
                player: node.player as u8,
                actions: node.labels.clone(),
                strategy,
                locked: vec![1; COMBOS],
                custom: None,
            }],
            earlier: LockEarlier::Player,
            target_pct: target,
            ranges: None,
        }
    };
    let request = |lock_set: LockSet| NodelockRequest {
        spot: serde_json::from_value(fx["spot"].clone()).unwrap(),
        lock_set,
        baseline: Some(base64_encode(&chunk)),
        header: fx["header"].as_str().unwrap().into(),
        options: RequestOptions {
            max_iterations: o["maxIterations"].as_u64().unwrap() as u32,
            target_pct: target,
            check_from: o["checkFrom"].as_u64().map(|n| n as u32),
            check_every: o["checkEvery"].as_u64().unwrap() as u32,
            dcfr: DcfrParams {
                alpha: d["alpha"].as_f64().unwrap(),
                beta: d["beta"].as_f64().unwrap(),
                gamma: d["gamma"].as_f64().unwrap(),
            },
        },
        threads: Some(threads),
        storage: Some(storage),
        memory_budget: None,
    };

    let run = |name: &str, set: LockSet, warm: &mut Option<_>| {
        let out = run_nodelock_warm(&request(set), warm, &AtomicBool::new(false), |p| {
            if let Some(pct) = p.exploitability_pct.filter(|_| p.iteration % 10 == 0) {
                println!(
                    "  {name}: iteration {} at {:.1} s, {pct:.3} %",
                    p.iteration,
                    p.elapsed_ms / 1000.0
                );
            }
        })
        .unwrap();
        let s = &out.stats;
        println!(
            "{name}: warm {}, {} iterations, {:.3} % of the pot, {:.1} s, {} threads, {}, {:.0} MB, {}",
            s.warm,
            s.iterations,
            s.exploitability_pct,
            s.seconds,
            s.threads,
            s.storage,
            s.peak_mb,
            s.stopped_by
        );
    };

    println!(
        "lock on {} ({}): bet {} always, then {second} bet / check the rest",
        node.path, node.player, node.labels[bet]
    );
    let mut warm = None;
    run("first lock (cold)", lock(1.0), &mut warm);
    run("second lock (warm)", lock(second), &mut warm);
    if args.iter().any(|a| a == "--cold-too") {
        run("second lock (cold)", lock(second), &mut None);
    }
}
