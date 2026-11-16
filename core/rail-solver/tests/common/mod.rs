//! Shared by the parity tests and the benchmark: fixture loading and the
//! comparison against the TypeScript's answers.

#![allow(
    dead_code,
    clippy::float_arithmetic,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::unwrap_used
)]

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;

use rail_solver::betting::Street;
use rail_solver::cards::base64_decode;
use rail_solver::cfr::{DcfrParams, RunOptions, Solver, SolverConfig, Storage};
use rail_solver::chunk::{encode_chunk, encode_solution};
use rail_solver::game::{Game, HandSet, Mirror, ShowdownBoard};
use rail_solver::solve::Scope;
use rail_solver::spot::{SolveOptions, Solved, solve};
use rail_solver::subgame::SpotInput;
use rail_solver::tree::FlatTree;
use serde_json::Value;

pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

pub fn load(name: &str) -> Value {
    let path = fixture_dir().join(format!("{name}.json"));
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap()
}

pub fn big_fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/rail-solver-fixtures")
        .join(format!("{name}.json"));
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap()
}

pub fn bytes(v: &Value) -> Vec<u8> {
    base64_decode(v.as_str().unwrap()).unwrap()
}

pub fn f64s(v: &Value) -> Vec<f64> {
    bytes(v)
        .as_chunks::<8>()
        .0
        .iter()
        .map(|b| f64::from_le_bytes(*b))
        .collect()
}

pub fn f32s(v: &Value) -> Vec<f32> {
    bytes(v)
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

fn ints<T: TryFrom<i64>>(v: &Value) -> Vec<T>
where
    T::Error: fmt::Debug,
{
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| T::try_from(x.as_i64().unwrap()).unwrap())
        .collect()
}

pub fn fnv64(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// A serialised TypeScript `Game` (toys).
pub fn game_of(v: &Value) -> Game {
    let t = &v["tree"];
    let kind: Vec<u8> = ints(&t["type"]);
    let size = kind.len();
    let child_start: Vec<u32> = ints(&t["childStart"]);
    let child_count: Vec<u32> = ints(&t["childCount"]);
    let children: Vec<u32> = ints(&t["children"]);
    let mut labels: Vec<String> = Vec::new();
    let mut ids: HashMap<String, u32> = HashMap::new();
    let edge_label: Vec<u32> = t["edgeLabel"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let l = l.as_str().unwrap().to_owned();
            *ids.entry(l.clone()).or_insert_with(|| {
                labels.push(l);
                (labels.len() - 1) as u32
            })
        })
        .collect();
    let mut first = vec![0_u32; size];
    for node in 0..size {
        first[node] = if child_count[node] == 0 {
            node as u32
        } else {
            first[children[child_start[node] as usize] as usize]
        };
    }
    let tree = FlatTree {
        size,
        root: t["root"].as_u64().unwrap() as usize,
        kind,
        player: ints(&t["player"]),
        max_children: child_count.iter().copied().max().unwrap_or(1).max(1) as usize,
        child_start,
        child_count,
        children,
        edge_label,
        labels,
        edge_card: ints(&t["edgeCard"]),
        payoff: f64s(&t["payoff"]),
        board: ints(&t["board"]),
        chance_weight: f64s(&t["chanceWeight"]),
        max_depth: t["maxDepth"].as_u64().unwrap() as usize,
        first,
    };
    let hands = [0, 1].map(|p| {
        let h = &v["hands"][p];
        let c1: Vec<u8> = ints(&h["c1"]);
        HandSet {
            size: c1.len(),
            c1,
            c2: ints(&h["c2"]),
            weight: f64s(&h["weight"]),
        }
    });
    let boards = v["boards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| ShowdownBoard {
            order: [ints(&b["order"][0]), ints(&b["order"][1])],
            strength: [f64s(&b["strength"][0]), f64s(&b["strength"][1])],
        })
        .collect();
    let mut game = Game {
        edge_mirrors: vec![u32::MAX; tree.children.len()],
        tree,
        mirror_lists: Vec::new(),
        maps: Vec::new(),
        num_cards: v["numCards"].as_u64().unwrap() as usize,
        hands,
        boards,
        pot: v["pot"].as_f64().unwrap(),
        big_blind: v["bigBlind"].as_f64(),
    };
    if let Some(list) = v["mirrors"].as_array() {
        let mut per_card = Vec::new();
        for entry in list {
            per_card.push(entry.as_array().map(|ms| {
                ms.iter()
                    .map(|m| {
                        game.maps.push([ints(&m["map"][0]), ints(&m["map"][1])]);
                        Mirror {
                            card: m["card"].as_u64().unwrap() as u8,
                            map: (game.maps.len() - 1) as u32,
                        }
                    })
                    .collect()
            }));
        }
        game.set_card_mirrors(&per_card);
    }
    game
}

fn dcfr_of(v: &Value) -> DcfrParams {
    DcfrParams {
        alpha: v["alpha"].as_f64().unwrap(),
        beta: v["beta"].as_f64().unwrap(),
        gamma: v["gamma"].as_f64().unwrap(),
    }
}

fn storage_of(v: &Value) -> Storage {
    if v.as_str() == Some("i16") {
        Storage::I16
    } else {
        Storage::F32
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub max_strategy_diff: f64,
    pub max_ev_diff: f64,
    pub expl_pct_diff: f64,
    pub strategies_bit_identical: bool,
    pub bytes_identical: Option<bool>,
    pub threads_identical: bool,
    pub nodes: usize,
    pub seconds: f64,
    pub notes: Vec<String>,
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} nodes, max |Δ strategy| {:.3e}, max |Δ EV| {:.3e}, |Δ exploitability| {:.3e} % pot, strategies bit-identical {}, bytes identical {:?}, thread counts identical {}, {:.2}s{}",
            self.nodes,
            self.max_strategy_diff,
            self.max_ev_diff,
            self.expl_pct_diff,
            self.strategies_bit_identical,
            self.bytes_identical,
            self.threads_identical,
            self.seconds,
            if self.notes.is_empty() {
                String::new()
            } else {
                format!(" ({})", self.notes.join("; "))
            }
        )
    }
}

impl Report {
    pub fn assert_ok(&self) {
        assert!(
            self.max_strategy_diff <= 1e-4,
            "strategy differs by {}",
            self.max_strategy_diff
        );
        assert!(
            self.expl_pct_diff <= 1e-3,
            "exploitability differs by {} % pot",
            self.expl_pct_diff
        );
        assert!(self.threads_identical, "the thread counts disagree");
        if self.strategies_bit_identical && self.bytes_identical.is_some() {
            assert_eq!(
                self.bytes_identical,
                Some(true),
                "a bit-identical solve must encode to identical bytes"
            );
        }
    }
}

pub fn check_game(name: &str) -> Report {
    let fx = load(name);
    let game = game_of(&fx["game"]);
    let o = &fx["options"];
    let mut solver = Solver::new(
        game,
        dcfr_of(&o["dcfr"]),
        SolverConfig {
            storage: storage_of(&o["storage"]),
            sampling: None,
            threads: 1,
        },
    );
    solver.iterate(o["iterations"].as_u64().unwrap() as u32);
    let mut report = Report {
        strategies_bit_identical: true,
        threads_identical: true,
        ..Report::default()
    };
    for (node, want) in fx["expect"]["strategies"].as_object().unwrap() {
        let want = f32s(want);
        let got = solver.average_strategy(node.parse().unwrap());
        report.nodes += 1;
        for (a, b) in got.iter().zip(&want) {
            report.max_strategy_diff = report.max_strategy_diff.max(f64::from((a - b).abs()));
            report.strategies_bit_identical &= a.to_bits() == b.to_bits();
        }
    }
    let e = solver.exploitability();
    let want = f64s(&fx["expect"]["exploitability"]);
    report.expl_pct_diff = (e.percent_pot - want[6]).abs();
    report
}

pub fn options_of(o: &Value, threads: usize) -> SolveOptions {
    SolveOptions {
        run: RunOptions {
            max_iterations: o["maxIterations"].as_u64().unwrap() as u32,
            target_exploitability: o["targetExploitability"].as_f64().unwrap(),
            check_every: o["checkEvery"].as_u64().unwrap() as u32,
            check_from: o["checkFrom"].as_u64().map(|x| x as u32),
        },
        dcfr: dcfr_of(&o["dcfr"]),
        storage: storage_of(&o["storage"]),
        threads,
        scope: match o["scope"].as_str() {
            Some("flop") => Scope::Flop,
            Some("turn") => Scope::Turn,
            _ => Scope::All,
        },
    }
}

pub fn spot_of(fx: &Value) -> SpotInput {
    serde_json::from_value(fx["spot"].clone()).unwrap()
}

pub fn encoded(fx: &Value, solved: &Solved) -> Vec<u8> {
    if solved.result.street == Street::Flop && solved.result.scope == Scope::Flop {
        encode_chunk(fx["header"].as_str().unwrap(), &solved.result).unwrap()
    } else {
        encode_solution(&solved.result)
    }
}

pub fn check_spot(name: &str, threads: &[usize]) -> Report {
    check_spot_at(&load(name), threads)
}

pub fn check_spot_at(fx: &Value, threads: &[usize]) -> Report {
    let spot = spot_of(fx);
    let mut report = Report {
        strategies_bit_identical: true,
        threads_identical: true,
        ..Report::default()
    };
    let mut first: Option<Vec<u8>> = None;
    for (k, &t) in threads.iter().enumerate() {
        let options = options_of(&fx["options"], t);
        let solved = solve(&spot, &options, None, None, |_| true).unwrap();
        let bytes = encoded(fx, &solved);
        if k == 0 {
            report.seconds = solved.seconds;
            compare(fx, &solved, &bytes, &mut report);
            first = Some(bytes);
        } else {
            report
                .notes
                .push(format!("{t} threads {:.2}s", solved.seconds));
            report.threads_identical &= first.as_deref() == Some(&bytes[..]);
        }
    }
    report
}

fn compare(fx: &Value, solved: &Solved, bytes: &[u8], report: &mut Report) {
    let expect = &fx["expect"];
    let result = &solved.result;
    let by_path: HashMap<&str, usize> = result
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| !n.chance)
        .map(|(k, n)| (n.path.as_str(), k))
        .collect();
    let want_hands: [Vec<u16>; 2] = [ints(&expect["hands"][0]), ints(&expect["hands"][1])];
    if want_hands != result.hands {
        report.notes.push("hands differ".into());
        report.max_strategy_diff = f64::INFINITY;
        return;
    }
    for node in expect["nodes"].as_array().unwrap() {
        let path = node["path"].as_str().unwrap();
        let Some(&k) = by_path.get(path) else {
            report.notes.push(format!("no node {path:?}"));
            report.max_strategy_diff = f64::INFINITY;
            continue;
        };
        let got = &result.nodes[k];
        report.nodes += 1;
        let labels: Vec<&str> = node["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap())
            .collect();
        if labels != got.labels.iter().map(String::as_str).collect::<Vec<_>>() {
            report.notes.push(format!(
                "labels differ at {path:?}: {labels:?} vs {:?}",
                got.labels
            ));
            report.max_strategy_diff = f64::INFINITY;
            continue;
        }
        for (a, b) in got.strategy.iter().zip(f32s(&node["strategy"])) {
            report.max_strategy_diff = report.max_strategy_diff.max(f64::from((a - b).abs()));
            report.strategies_bit_identical &= a.to_bits() == b.to_bits();
        }
        for (a, b) in got.ev.iter().zip(f32s(&node["ev"])) {
            report.max_ev_diff = report.max_ev_diff.max(f64::from((a - b).abs()));
        }
    }
    let want = f64s(&expect["exploitability"]);
    report.expl_pct_diff = (result.exploitability_pct - want[1]).abs();
    if result.exploitability_pct.to_bits() != want[1].to_bits() {
        report.strategies_bit_identical = false;
    }
    if let Some(b) = expect.get("bytes") {
        report.bytes_identical = Some(super_bytes(b) == bytes);
    } else {
        report.bytes_identical = Some(expect["bytesFnv"].as_str() == Some(&fnv64(bytes)));
    }
    if expect["iterations"].as_u64() != Some(u64::from(result.iterations)) {
        report.notes.push(format!(
            "iterations {} vs {}",
            result.iterations, expect["iterations"]
        ));
    }
}

fn super_bytes(v: &Value) -> Vec<u8> {
    bytes(v)
}
