//! Parity with the TypeScript solver (docs/NODELOCK.md §2.5): the fixtures in
//! `tests/fixtures` are the TypeScript's answers (`npm run solver:fixtures`
//! in `tests/`). Strategies must match within 1e-4, exploitability within
//! 1e-3 % of the pot; the encoded bytes must be identical whenever the solve
//! is bit-identical (and are reported either way).

#![allow(
    clippy::float_arithmetic,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::unwrap_used
)]

mod common;

use common::*;

#[test]
fn powf_matches_v8_math_pow() {
    let fx = load("pow");
    let pows = f64s(&fx["pows"]);
    let mut differ = 0;
    for t in 1..=400_u32 {
        let k = (t as usize - 1) * 3;
        let t = f64::from(t);
        for (got, want) in [
            ((t - 1.0).powf(1.5), pows[k]),
            (t.powf(2.0), pows[k + 1]),
            (t.powf(3.0), pows[k + 2]),
        ] {
            if got.to_bits() != want.to_bits() {
                differ += 1;
            }
        }
    }
    eprintln!("powf vs Math.pow: {differ} of 1200 differ in the last bit");
    assert!(differ <= 60, "{differ} pow results differ");
}

#[test]
fn toy_games_match() {
    for name in ["kuhn", "kuhn-i16", "leduc", "leduc-i16", "clairvoyance"] {
        let report = check_game(name);
        eprintln!("{name}: {report}");
        report.assert_ok();
    }
}

#[test]
fn river_matches_f32() {
    let report = check_spot("river", &[1]);
    eprintln!("river: {report}");
    report.assert_ok();
}

#[test]
fn river_matches_i16() {
    let report = check_spot("river-i16", &[1]);
    eprintln!("river-i16: {report}");
    report.assert_ok();
}

#[test]
fn turn_with_isomorphism_matches() {
    let report = check_spot("turn-iso", &[1, 4]);
    eprintln!("turn-iso: {report}");
    report.assert_ok();
}

#[test]
fn reduced_flop_matches_i16() {
    let report = check_spot("flop-small", &[1, 3]);
    eprintln!("flop-small: {report}");
    report.assert_ok();
}

#[test]
fn reduced_flop_matches_f32() {
    let report = check_spot("flop-small-f32", &[1, 3]);
    eprintln!("flop-small-f32: {report}");
    report.assert_ok();
}

/// The real flop-m1 spot: only when its fixture was generated
/// (`RAIL_SOLVER_BIG=1 npm run solver:fixtures`), in release.
#[test]
#[ignore = "needs target/rail-solver-fixtures (RAIL_SOLVER_BIG=1 npm run solver:fixtures)"]
fn real_flop_m1_matches() {
    let threads = std::env::var("RAIL_SOLVER_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9);
    let report = check_spot_at(&big_fixture("flop-m1-btn-bb-Ks5h3s"), &[threads]);
    eprintln!("flop-m1: {report}");
    report.assert_ok();
}

/// Nodelock solves against the TypeScript reference (`solveNodelock`): a
/// flop lock and a turn lock, "player" earlier nodes, a lock that is not
/// suit-symmetric. Same chunk bytes, at 1 and 3 threads.
#[test]
fn nodelock_matches_the_reference() {
    use std::sync::atomic::AtomicBool;

    use rail_solver::nodelock::{NodelockRequest, run_nodelock};

    let fx = load("nodelock");
    for threads in [1, 3] {
        // Flop.
        let mut request: NodelockRequest =
            serde_json::from_value(fx["flop"]["request"].clone()).unwrap();
        request.threads = Some(threads);
        let out = run_nodelock(&request, &AtomicBool::new(false), |_| {}).unwrap();
        let want = bytes(&fx["flop"]["expect"]["chunk"]);
        let got = rail_solver::chunk::decode(&out.chunk).unwrap();
        let expected = rail_solver::chunk::decode(&want).unwrap();
        let diff = got
            .nodes
            .iter()
            .zip(&expected.nodes)
            .flat_map(|(a, b)| {
                a.strategy
                    .iter()
                    .zip(&b.strategy)
                    .map(|(x, y)| (x - y).abs())
            })
            .fold(0.0, f64::max);
        let pct = f64s(&fx["flop"]["expect"]["exploitabilityPct"])[0];
        eprintln!(
            "nodelock flop ({threads} threads): max |Δ strategy| {diff:.3e}, exploitability {} vs {pct}, bytes identical {}",
            out.stats.exploitability_pct,
            out.chunk == want
        );
        assert!(diff <= 1e-4);
        assert!((out.stats.exploitability_pct - pct).abs() <= 1e-3);
        assert_eq!(out.chunk, want, "the flop lock's chunk");

        // Turn.
        let mut request: NodelockRequest =
            serde_json::from_value(fx["turn"]["request"].clone()).unwrap();
        request.threads = Some(threads);
        let out = run_nodelock(&request, &AtomicBool::new(false), |_| {}).unwrap();
        let e = &fx["turn"]["expect"];
        let got = rail_solver::chunk::decode(&out.chunk).unwrap();
        let root = f32s(&e["rootStrategy"]);
        let diff = got.nodes[0]
            .strategy
            .iter()
            .zip(&root)
            .map(|(a, b)| (a - f64::from(*b)).abs())
            .fold(0.0, f64::max);
        let pct = f64s(&e["exploitabilityPct"])[0];
        eprintln!(
            "nodelock turn ({threads} threads): root |Δ| {diff:.3e}, iterations {} vs {}, exploitability {} vs {pct}, bytes identical {}",
            out.stats.iterations,
            e["iterations"],
            out.stats.exploitability_pct,
            Some(fnv64(&out.chunk).as_str()) == e["chunkFnv"].as_str()
        );
        assert!(diff <= 1e-4);
        assert!((out.stats.exploitability_pct - pct).abs() <= 1e-3);
        assert_eq!(
            Some(fnv64(&out.chunk).as_str()),
            e["chunkFnv"].as_str(),
            "the turn lock's chunk"
        );
    }
}
