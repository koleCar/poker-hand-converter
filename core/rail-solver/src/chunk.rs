//! The stored forms, byte for byte (`format.ts` `encodeSolution`,
//! `flopLibrary.ts` `encodeChunk`), and a decoder for a chunk's flop-level
//! strategies (the baseline that earlier-node freezing reads).

use crate::js::{json_number, json_string, math_round};
use crate::solve::{SOLVER_VERSION, SolveResult};

const SOLUTION_MAGIC: [u8; 4] = *b"RSLV";
const CHUNK_MAGIC: [u8; 4] = *b"RFLB";

fn pad4(x: usize) -> usize {
    (x + 3) & !3
}

fn header_json(result: &SolveResult) -> String {
    let mut s = String::with_capacity(256 + result.nodes.len() * 256);
    s.push_str("{\"version\":");
    json_string(&mut s, SOLVER_VERSION);
    s.push_str(",\"street\":");
    json_string(&mut s, result.street.name());
    s.push_str(",\"board\":[");
    for (k, c) in result.board.iter().enumerate() {
        if k > 0 {
            s.push(',');
        }
        json_string(&mut s, c);
    }
    s.push_str("],\"pot\":");
    json_number(&mut s, result.pot);
    s.push_str(",\"stack\":");
    json_number(&mut s, result.stack);
    s.push_str(",\"firstToAct\":");
    json_number(&mut s, f64::from(result.first_to_act));
    s.push_str(",\"iterations\":");
    json_number(&mut s, f64::from(result.iterations));
    s.push_str(",\"stoppedBy\":");
    json_string(&mut s, result.stopped_by.name());
    s.push_str(",\"exploitability\":");
    json_number(&mut s, result.exploitability);
    s.push_str(",\"exploitabilityPct\":");
    json_number(&mut s, result.exploitability_pct);
    s.push_str(",\"exploitabilityMbb\":");
    json_number(&mut s, result.exploitability_mbb);
    s.push_str(",\"value\":[");
    json_number(&mut s, result.value[0]);
    s.push(',');
    json_number(&mut s, result.value[1]);
    s.push_str("],\"memoryBytes\":");
    json_number(&mut s, result.memory_bytes as f64);
    s.push_str(",\"n\":[");
    json_number(&mut s, result.hands[0].len() as f64);
    s.push(',');
    json_number(&mut s, result.hands[1].len() as f64);
    s.push_str("],\"nodes\":[");
    for (k, node) in result.nodes.iter().enumerate() {
        if k > 0 {
            s.push(',');
        }
        s.push_str("{\"kind\":");
        json_string(&mut s, if node.chance { "chance" } else { "action" });
        s.push_str(",\"player\":");
        json_number(&mut s, f64::from(node.player));
        s.push_str(",\"street\":");
        json_string(&mut s, node.street.name());
        s.push_str(",\"path\":");
        json_string(&mut s, &node.path);
        s.push_str(",\"parent\":");
        json_number(&mut s, node.parent as f64);
        s.push_str(",\"parentEdge\":");
        json_number(&mut s, node.parent_edge as f64);
        s.push_str(",\"pot\":");
        json_number(&mut s, node.pot);
        s.push_str(",\"toCall\":");
        json_number(&mut s, node.to_call);
        s.push_str(",\"behind\":");
        json_number(&mut s, node.behind);
        s.push_str(",\"labels\":[");
        for (j, l) in node.labels.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            json_string(&mut s, l);
        }
        s.push_str("],\"actions\":[");
        for (j, a) in node.actions.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            s.push_str("{\"label\":");
            json_string(&mut s, &a.label);
            s.push_str(",\"kind\":");
            json_string(&mut s, a.kind.name());
            s.push_str(",\"amount\":");
            json_number(&mut s, a.amount);
            s.push_str(",\"to\":");
            json_number(&mut s, a.to);
            s.push_str(",\"sizePot\":");
            json_number(&mut s, a.size_pot);
            s.push('}');
        }
        s.push_str("],\"children\":[");
        for (j, c) in node.children.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            json_number(&mut s, *c as f64);
        }
        s.push_str("],\"frequency\":[");
        for (j, f) in node.frequency.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            json_number(&mut s, *f);
        }
        s.push_str("]}");
    }
    s.push_str("]}");
    s
}

/// `encodeSolution`.
#[must_use]
pub fn encode_solution(result: &SolveResult) -> Vec<u8> {
    let json = header_json(result);
    let json = json.as_bytes();
    let (n0, n1) = (result.hands[0].len(), result.hands[1].len());
    let mut size = pad4(12 + json.len());
    size += pad4(2 * (n0 + n1));
    size += 4 * 2 * (n0 + n1);
    for node in &result.nodes {
        size += pad4(2 * node.strategy.len()) + 4 * node.ev.len();
    }
    let mut out = vec![0_u8; size];
    out[0..4].copy_from_slice(&SOLUTION_MAGIC);
    out[4..6].copy_from_slice(&1_u16.to_le_bytes());
    out[6..8].copy_from_slice(&0_u16.to_le_bytes());
    out[8..12].copy_from_slice(&(json.len() as u32).to_le_bytes());
    out[12..12 + json.len()].copy_from_slice(json);
    let mut at = pad4(12 + json.len());
    for hands in &result.hands {
        for &combo in hands {
            out[at..at + 2].copy_from_slice(&combo.to_le_bytes());
            at += 2;
        }
    }
    at = pad4(at);
    for array in [
        &result.weights[0],
        &result.weights[1],
        &result.root_ev[0],
        &result.root_ev[1],
    ] {
        for &x in array {
            out[at..at + 4].copy_from_slice(&x.to_le_bytes());
            at += 4;
        }
    }
    for node in &result.nodes {
        for &x in &node.strategy {
            let q = math_round(f64::from(x).clamp(0.0, 1.0) * 65535.0) as u16;
            out[at..at + 2].copy_from_slice(&q.to_le_bytes());
            at += 2;
        }
        at = pad4(at);
        for &x in &node.ev {
            out[at..at + 4].copy_from_slice(&x.to_le_bytes());
            at += 4;
        }
    }
    out
}

/// `encodeChunk`: `header_json` is the `FlopChunkHeader` exactly as
/// `JSON.stringify` wrote it (the caller builds it, so its key order is the
/// TypeScript's by construction).
///
/// # Errors
/// A result that is not a flop-level flop solve.
pub fn encode_chunk(header_json: &str, result: &SolveResult) -> Result<Vec<u8>, String> {
    if result.street != crate::betting::Street::Flop || result.scope != crate::solve::Scope::Flop {
        return Err("a flop library chunk holds a flop-level flop solve (nodes: \"flop\")".into());
    }
    Ok(wrap_chunk(header_json, result))
}

/// The chunk layout around any solve, a turn's included (a turn or river
/// nodelock's result: the library header of the flop it came from, then the
/// live turn's solution). `encodeChunk` itself takes only flop solves.
#[must_use]
pub fn wrap_chunk(header_json: &str, result: &SolveResult) -> Vec<u8> {
    let json = header_json.as_bytes();
    let solve = encode_solution(result);
    let start = pad4(12 + json.len());
    let mut out = vec![0_u8; start + solve.len()];
    out[0..4].copy_from_slice(&CHUNK_MAGIC);
    out[4..6].copy_from_slice(&1_u16.to_le_bytes());
    out[6..8].copy_from_slice(&0_u16.to_le_bytes());
    out[8..12].copy_from_slice(&(json.len() as u32).to_le_bytes());
    out[12..12 + json.len()].copy_from_slice(json);
    out[start..].copy_from_slice(&solve);
    out
}

/// A decoded node's strategy, as `decodeSolution` reads it (renormalised).
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedNode {
    pub path: String,
    pub player: usize,
    pub labels: Vec<String>,
    /// `[action][hand]` over `hands[player]`.
    pub strategy: Vec<f64>,
}

/// The flop-level strategies of a chunk (or of a bare solution blob).
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSolve {
    pub hands: [Vec<u16>; 2],
    pub nodes: Vec<DecodedNode>,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        *b.get(at + 3)?,
    ]))
}

/// Decodes a chunk (`RFLB`) or a solution blob (`RSLV`).
///
/// # Errors
/// Bytes that are neither.
pub fn decode(bytes: &[u8]) -> Result<DecodedSolve, String> {
    let bytes = if bytes.get(0..4) == Some(&CHUNK_MAGIC[..]) {
        let len = u32_at(bytes, 8).ok_or("short chunk")? as usize;
        &bytes[pad4(12 + len).min(bytes.len())..]
    } else {
        bytes
    };
    if bytes.get(0..4) != Some(&SOLUTION_MAGIC[..]) {
        return Err("not a solver blob".into());
    }
    let len = u32_at(bytes, 8).ok_or("short blob")? as usize;
    let header: serde_json::Value =
        serde_json::from_slice(bytes.get(12..12 + len).ok_or("short header")?)
            .map_err(|e| e.to_string())?;
    let n = header["n"].as_array().ok_or("no n")?;
    let n0 = n
        .first()
        .and_then(serde_json::Value::as_u64)
        .ok_or("bad n")? as usize;
    let n1 = n
        .get(1)
        .and_then(serde_json::Value::as_u64)
        .ok_or("bad n")? as usize;
    let mut at = pad4(12 + len);
    let mut hands = [Vec::with_capacity(n0), Vec::with_capacity(n1)];
    for (p, count) in [n0, n1].into_iter().enumerate() {
        for _ in 0..count {
            hands[p].push(u16_at(bytes, at).ok_or("short hands")?);
            at += 2;
        }
    }
    at = pad4(at);
    at += 4 * 2 * (n0 + n1);
    let mut nodes = Vec::new();
    for node in header["nodes"].as_array().ok_or("no nodes")? {
        if node["kind"].as_str() != Some("action") {
            continue;
        }
        let player = node["player"].as_u64().ok_or("bad player")? as usize;
        let labels: Vec<String> = node["labels"]
            .as_array()
            .ok_or("bad labels")?
            .iter()
            .filter_map(|l| l.as_str().map(str::to_owned))
            .collect();
        let size = if player == 0 { n0 } else { n1 };
        let count = labels.len();
        let mut strategy = vec![0.0; count * size];
        // Float32 like the TypeScript's `Float32Array`, renormalised per hand.
        for x in &mut strategy {
            *x =
                f64::from((f64::from(u16_at(bytes, at).ok_or("short strategy")?) / 65535.0) as f32);
            at += 2;
        }
        at = pad4(at);
        for i in 0..size {
            let mut sum = 0.0;
            for a in 0..count {
                sum += strategy[a * size + i];
            }
            for a in 0..count {
                let v = if sum > 0.0 {
                    strategy[a * size + i] / sum
                } else {
                    1.0 / count as f64
                };
                strategy[a * size + i] = f64::from(v as f32);
            }
        }
        at += 4 * count * size;
        nodes.push(DecodedNode {
            path: node["path"].as_str().unwrap_or("").to_owned(),
            player,
            labels,
            strategy,
        });
    }
    Ok(DecodedSolve { hands, nodes })
}
