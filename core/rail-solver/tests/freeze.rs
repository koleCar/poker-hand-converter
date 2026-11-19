//! Frozen nodes and lock sets (docs/NODELOCK.md §1, §2.1).

#![allow(
    clippy::float_arithmetic,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::unwrap_used
)]

mod common;

use common::*;
use rail_solver::cards::NUM_COMBOS;
use rail_solver::cfr::{DEFAULT_DCFR, Solver, SolverConfig};
use rail_solver::chunk::{decode, encode_chunk, encode_solution};
use rail_solver::lock::{LockEarlier, LockSet, LockSpot, NodeLockSpec};
use rail_solver::spot::solve;

/// The clairvoyance game with the caller frozen to always call: the bettor's
/// air stops bluffing, its nuts keep betting, and the frozen node's average
/// is exactly the fixed strategy.
#[test]
fn a_frozen_caller_is_exploited() {
    let fx = load("clairvoyance");
    let game = game_of(&fx["game"]);
    let mut solver = Solver::new(game, DEFAULT_DCFR, SolverConfig::default());
    // Node ids: 0 check showdown, 1 fold, 2 call showdown, 3 facing (player 1), 4 root (player 0).
    solver.freeze(3, &[0.0, 1.0], None);
    solver.iterate(400);
    assert_eq!(solver.average_strategy(3), vec![0.0, 1.0]);
    let root = solver.average_strategy(4);
    // [check: nuts, air][bet: nuts, air]
    assert!(root[3] < 0.01, "air still bluffs {}", root[3]);
    assert!(root[2] > 0.99, "nuts stop betting {}", root[2]);
    // The bettor's value is its best response to the frozen caller.
    let (br, _) = solver.best_response(0, -1.0);
    let v = solver.value(0);
    assert!((br - v).abs() < 1e-3, "best response {br} vs value {v}");
}

/// Only the masked hands are frozen; the others keep adapting.
#[test]
fn unmasked_hands_adapt() {
    let fx = load("clairvoyance");
    let game = game_of(&fx["game"]);
    let mut solver = Solver::new(game, DEFAULT_DCFR, SolverConfig::default());
    // Freeze the nuts (hand 0) to check; air (hand 1) adapts.
    solver.freeze(4, &[1.0, 0.0, 0.0, 0.0], Some(&[true, false]));
    solver.iterate(400);
    let root = solver.average_strategy(4);
    assert_eq!(
        (root[0], root[2]),
        (1.0, 0.0),
        "the nuts are frozen to check"
    );
    // A bettor that never value-bets is all air when it bets: the caller
    // calls, so air stops betting too.
    assert!(root[3] < 0.01, "air should stop betting {}", root[3]);
}

fn uniform_lock(path: &str, player: u8, actions: &[&str], action: usize) -> NodeLockSpec {
    let mut strategy = vec![vec![0.0; NUM_COMBOS]; actions.len()];
    strategy[action] = vec![1.0; NUM_COMBOS];
    NodeLockSpec {
        street: "river".into(),
        path: path.into(),
        player,
        actions: actions.iter().map(|s| (*s).to_owned()).collect(),
        strategy,
        locked: vec![1; NUM_COMBOS],
        custom: None,
    }
}

fn lock_set(nodes: Vec<NodeLockSpec>, earlier: LockEarlier) -> LockSet {
    LockSet {
        version: 1,
        spot: LockSpot {
            set: "s".into(),
            line: "l".into(),
            flop: "Ks5h3s".into(),
            turn: Some("7d".into()),
            river: Some("2c".into()),
        },
        nodes,
        earlier,
        target_pct: 1.0,
        ranges: None,
    }
}

/// A lock on the river root: every hand checks, and the result says so.
#[test]
fn a_lock_set_freezes_its_node() {
    let fx = load("river");
    let spot = spot_of(&fx);
    let options = options_of(&fx["options"], 1);
    let base = solve(&spot, &options, None, None, |_| true).unwrap();
    let root = &base.result.nodes[0];
    let labels: Vec<&str> = root.labels.iter().map(String::as_str).collect();
    let set = lock_set(vec![uniform_lock("", 0, &labels, 0)], LockEarlier::None);
    let solved = solve(&spot, &options, Some(&set), None, |_| true).unwrap();
    let locked = &solved.result.nodes[0];
    let n = solved.result.hands[0].len();
    assert!(
        locked.strategy[..n].iter().all(|&x| x == 1.0),
        "every hand checks"
    );
    assert_eq!(solved.applied.locked.len(), 1);
    // A tree mismatch is caught.
    let bad = lock_set(
        vec![uniform_lock("", 0, &["X", "B5"], 0)],
        LockEarlier::None,
    );
    assert!(solve(&spot, &options, Some(&bad), None, |_| true).is_err());
}

/// "player": the locked player's earlier decisions stay at the baseline.
#[test]
fn earlier_nodes_freeze_at_the_baseline() {
    let fx = load("river");
    let spot = spot_of(&fx);
    let options = options_of(&fx["options"], 1);
    let base = solve(&spot, &options, None, None, |_| true).unwrap();
    let baseline = decode(&encode_solution(&base.result)).unwrap();
    // Player 0's node after check-bet: its ancestor of player 0 is the root.
    let target = base
        .result
        .nodes
        .iter()
        .find(|n| !n.chance && n.player == 0 && n.path.starts_with("X-B"))
        .unwrap();
    let labels: Vec<&str> = target.labels.iter().map(String::as_str).collect();
    let fold = labels.iter().position(|l| *l == "F").unwrap();
    let set = lock_set(
        vec![uniform_lock(&target.path, 0, &labels, fold)],
        LockEarlier::Player,
    );
    assert!(
        solve(&spot, &options, Some(&set), None, |_| true).is_err(),
        "earlier nodes need the baseline"
    );
    let solved = solve(&spot, &options, Some(&set), Some(&baseline), |_| true).unwrap();
    assert_eq!(solved.applied.earlier.len(), 1, "the root");
    let want = &baseline.nodes[0].strategy;
    let got = &solved.result.nodes[0].strategy;
    let diff = got
        .iter()
        .zip(want)
        .map(|(a, b)| (f64::from(*a) - b).abs())
        .fold(0.0, f64::max);
    assert!(diff < 1e-6, "the root moved by {diff}");
    // Player 1's nodes adapt: the bet after the check is not the baseline any more.
    let bettor = |r: &rail_solver::SolveResult| {
        r.nodes
            .iter()
            .find(|n| n.path == "X")
            .unwrap()
            .frequency
            .clone()
    };
    assert_ne!(bettor(&solved.result), bettor(&base.result));
}

/// A locked flop solve is still the same at any thread count, and its chunk encodes.
#[test]
fn locked_flop_is_thread_count_independent() {
    let fx = load("flop-small");
    let spot = spot_of(&fx);
    let base = solve(&spot, &options_of(&fx["options"], 1), None, None, |_| true).unwrap();
    let root = &base.result.nodes[0];
    let labels: Vec<&str> = root.labels.iter().map(String::as_str).collect();
    let mut spec = uniform_lock("", 0, &labels, 1);
    spec.street = "flop".into();
    // Half the combos locked to the small bet.
    spec.locked = (0..NUM_COMBOS).map(|c| u8::from(c % 2 == 0)).collect();
    let set = lock_set(vec![spec], LockEarlier::None);
    let header = fx["header"].as_str().unwrap();
    let mut chunks = Vec::new();
    for threads in [1, 4] {
        let solved = solve(
            &spot,
            &options_of(&fx["options"], threads),
            Some(&set),
            None,
            |_| true,
        )
        .unwrap();
        chunks.push(encode_chunk(header, &solved.result).unwrap());
    }
    assert_eq!(chunks[0], chunks[1]);
    let decoded = decode(&chunks[0]).unwrap();
    let n = decoded.hands[0].len();
    for (i, &combo) in decoded.hands[0].iter().enumerate() {
        if combo % 2 == 0 {
            assert!(
                (decoded.nodes[0].strategy[n + i] - 1.0).abs() < 1e-6,
                "locked combo {combo} bets"
            );
        }
    }
}

/// The app's request end to end: a flop lock with "player", the library
/// chunk as the baseline, a chunk back that decodes.
#[test]
fn a_nodelock_request_solves() {
    use std::sync::atomic::AtomicBool;

    use rail_solver::nodelock::{NodelockRequest, RequestOptions, run_nodelock};

    let fx = load("flop-small");
    let spot = spot_of(&fx);
    let chunk = fx["expect"]["bytes"].as_str().unwrap().to_owned();
    let library = decode(&bytes(&fx["expect"]["bytes"])).unwrap();
    // Player 1 facing the small bet: its ancestor of player 1 is none, so
    // lock player 0's node after check-bet instead; its ancestor is the root.
    let node = library
        .nodes
        .iter()
        .find(|n| n.player == 0 && n.path.starts_with("X-B"))
        .unwrap();
    let labels: Vec<&str> = node.labels.iter().map(String::as_str).collect();
    let mut spec = uniform_lock(&node.path, 0, &labels, 0);
    spec.street = "flop".into();
    let request = NodelockRequest {
        spot,
        lock_set: lock_set(vec![spec], LockEarlier::Player),
        baseline: Some(chunk),
        header: fx["header"].as_str().unwrap().to_owned(),
        options: RequestOptions {
            max_iterations: 8,
            target_pct: 0.0,
            check_from: Some(8),
            check_every: 8,
            dcfr: rail_solver::cfr::DcfrParams {
                alpha: 1.5,
                beta: 0.0,
                gamma: 3.0,
            },
        },
        threads: Some(3),
        storage: None,
        memory_budget: None,
    };
    let mut calls = 0;
    let out = run_nodelock(&request, &AtomicBool::new(false), |p| {
        calls += 1;
        assert!(p.memory_mb > 0.0);
    })
    .unwrap();
    assert_eq!(calls, 9, "8 iterations and one measurement");
    assert_eq!(out.stats.iterations, 8);
    assert_eq!(out.stats.engine, "native");
    let decoded = decode(&out.chunk).unwrap();
    // The root kept the library's strategy.
    let diff = decoded.nodes[0]
        .strategy
        .iter()
        .zip(&library.nodes[0].strategy)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max);
    assert!(diff < 1e-4, "root moved by {diff}");
    // A cancel is an error.
    let cancelled = run_nodelock(&request, &AtomicBool::new(true), |_| {});
    assert_eq!(cancelled.err().as_deref(), Some("cancelled"));
}

/// A range lock (docs/NODELOCK.md §9.2): the spot's ranges are not the
/// library chunk's, on purpose. With `ranges` in the set the solve runs from
/// them, the added hands free at the earlier nodes; without, it is refused.
#[test]
fn a_range_locked_request_solves() {
    use std::sync::atomic::AtomicBool;

    use rail_solver::cards::{RangeInput, to_range};
    use rail_solver::lock::RangeLock;
    use rail_solver::nodelock::{NodelockRequest, RequestOptions, run_nodelock};

    let fx = load("flop-small");
    let mut spot = spot_of(&fx);
    let chunk = fx["expect"]["bytes"].as_str().unwrap().to_owned();
    let library = decode(&bytes(&fx["expect"]["bytes"])).unwrap();
    // Player 1 gets every combo the board leaves at a quarter, on top of its range.
    let board = rail_solver::cards::parse_cards(&spot.board).unwrap();
    let mut wide = to_range(&spot.ranges[1]).unwrap();
    for (combo, w) in wide.iter_mut().enumerate() {
        let (hi, lo) = (
            rail_solver::cards::combo_hi(combo),
            rail_solver::cards::combo_lo(combo),
        );
        if *w == 0.0 && !board.contains(&hi) && !board.contains(&lo) {
            *w = 0.25;
        }
    }
    spot.ranges[1] = RangeInput::Weights(wide.clone());
    let node = library
        .nodes
        .iter()
        .find(|n| n.player == 0 && n.path.starts_with("X-B"))
        .unwrap();
    let labels: Vec<&str> = node.labels.iter().map(String::as_str).collect();
    let mut spec = uniform_lock(&node.path, 0, &labels, 0);
    spec.street = "flop".into();
    let mut lock_set = lock_set(vec![spec], LockEarlier::All);
    lock_set.spot.turn = None;
    lock_set.spot.river = None;
    let request = |lock_set: LockSet| NodelockRequest {
        spot: spot.clone(),
        lock_set,
        baseline: Some(chunk.clone()),
        header: fx["header"].as_str().unwrap().to_owned(),
        options: RequestOptions {
            max_iterations: 4,
            target_pct: 0.0,
            check_from: Some(4),
            check_every: 4,
            dcfr: rail_solver::cfr::DcfrParams {
                alpha: 1.5,
                beta: 0.0,
                gamma: 3.0,
            },
        },
        threads: Some(2),
        storage: None,
        memory_budget: None,
    };
    let refused = run_nodelock(&request(lock_set.clone()), &AtomicBool::new(false), |_| {});
    assert!(refused.err().unwrap().contains("other ranges"));

    lock_set.version = 2;
    lock_set.ranges = Some(vec![RangeLock {
        player: 1,
        weights: wide,
    }]);
    let out = run_nodelock(&request(lock_set), &AtomicBool::new(false), |_| {}).unwrap();
    let decoded = decode(&out.chunk).unwrap();
    assert!(decoded.hands[1].len() > library.hands[1].len());
    assert_eq!(decoded.hands[0], library.hands[0]);
}
