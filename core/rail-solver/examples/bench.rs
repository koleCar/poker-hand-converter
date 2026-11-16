//! Wall time to a target exploitability on a real spot (docs/NODELOCK.md §0).
//!
//! ```text
//! cargo run --release -p rail-solver --example bench -- \
//!     target/rail-solver-fixtures/flop-m1-spot.json --threads 1,6,9 [--storage i16|f32]
//!     [--target 1] [--check-from 20] [--check-every 10] [--max 300]
//! ```
//!
//! The spot file is what `npm run solver:fixtures` writes from the chart set
//! (`flop-m1-spot.json`: the 6-max 100bb set, BTN vs BB, Ks5h3s).

#![allow(
    clippy::float_arithmetic,
    clippy::cast_precision_loss,
    clippy::unwrap_used,
    clippy::print_stdout
)]

use std::time::Instant;

use rail_solver::cfr::{DcfrParams, RunEvent, RunOptions, Solver, SolverConfig, Storage};
use rail_solver::spot::build;
use rail_solver::subgame::SpotInput;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|k| args.get(k + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("spot file");
    let fx: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let spot: SpotInput = serde_json::from_value(fx["spot"].clone()).unwrap();
    let threads: Vec<usize> = arg(&args, "--threads")
        .unwrap_or_else(|| "1".into())
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    let storage = if arg(&args, "--storage").as_deref() == Some("f32") {
        Storage::F32
    } else {
        Storage::I16
    };
    let target: f64 = arg(&args, "--target").map_or(1.0, |s| s.parse().unwrap());
    let check_from: u32 = arg(&args, "--check-from").map_or(20, |s| s.parse().unwrap());
    let check_every: u32 = arg(&args, "--check-every").map_or(10, |s| s.parse().unwrap());
    let max: u32 = arg(&args, "--max").map_or(300, |s| s.parse().unwrap());
    let d = &fx["options"]["dcfr"];
    let dcfr = DcfrParams {
        alpha: d["alpha"].as_f64().unwrap_or(1.5),
        beta: d["beta"].as_f64().unwrap_or(0.0),
        gamma: d["gamma"].as_f64().unwrap_or(3.0),
    };

    for &t in &threads {
        let started = Instant::now();
        let mut built = build(&spot).unwrap();
        let built_s = started.elapsed().as_secs_f64();
        let tree_nodes = built.game.tree.size;
        let boards = built.game.boards.len();
        let hands = [built.game.hands[0].size, built.game.hands[1].size];
        let mut solver = Solver::new(
            std::mem::take(&mut built.game),
            dcfr,
            SolverConfig {
                storage,
                sampling: None,
                threads: t,
            },
        );
        let ready_s = started.elapsed().as_secs_f64();
        let options = RunOptions {
            max_iterations: max,
            target_exploitability: target,
            check_every,
            check_from: Some(check_from),
        };
        let mut last_iter = Instant::now();
        let mut iter_s: Vec<f64> = Vec::new();
        let run = solver.run(&options, |event| {
            match event {
                RunEvent::Iteration(_) => {
                    iter_s.push(last_iter.elapsed().as_secs_f64());
                }
                RunEvent::Progress(i, e) => {
                    println!(
                        "  [{t} threads] iteration {i}: {:.3} % pot at {:.1}s",
                        e.percent_pot,
                        started.elapsed().as_secs_f64()
                    );
                }
            }
            last_iter = Instant::now();
            true
        });
        let total = started.elapsed().as_secs_f64();
        let mut sorted = iter_s.clone();
        sorted.sort_by(f64::total_cmp);
        let median = sorted.get(sorted.len() / 2).copied().unwrap_or(f64::NAN);
        println!(
            "threads {t}: {:?} after {} iterations at {:.3} % pot, {:.1}s wall (build {:.1}s, solver {:.1}s), median iteration {:.3}s, {} nodes, {} boards, hands {:?}, ~{} MB",
            run.stopped_by,
            run.iterations,
            run.exploitability.percent_pot,
            total,
            built_s,
            ready_s - built_s,
            median,
            tree_nodes,
            boards,
            hands,
            solver.native_bytes() / 1_000_000
        );
    }
}
