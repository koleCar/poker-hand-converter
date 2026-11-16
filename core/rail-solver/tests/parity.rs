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
