//! Seeded mutations of golden hands through both engines
//! (`tests/data/stats-vectors.json`, written by `stats-vectors.mjs` next to
//! it, which documents the ops).
//!
//! Each case names a corpus hand of `testdata/golden-full/`, applies a list of
//! edits to its PHF JSON exactly as the generator did, and requires the
//! canonical JSON of [`rows_for`] to hash to what the TypeScript's rows
//! hashed to. The corpus pins the hands parsers make; this pins the shapes
//! they do not - dropped and retyped actions, nulled positions, odd blinds,
//! fees that do not reconcile, cut or doubled boards.
//!
//! `STATS_VECTORS=<path>` replays another vector file (a soak run).

mod support;

use rail_core::canonical::to_canonical_json;
use rail_core::phf::PhfHand;
use rail_stats::rows_for;
use serde_json::{Map, Value, json};
use support::{corpus, rows_canonical, sha256_hex};

const MAX_REPORTED: usize = 20;

fn sha16(text: &str) -> String {
    sha256_hex(text)[..16].to_owned()
}

fn index(op: &Value, key: &str) -> usize {
    op[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or_else(|| panic!("op {op} has no index {key}"))
}

fn array<'v>(value: &'v mut Value, key: &str) -> &'v mut Vec<Value> {
    value[key]
        .as_array_mut()
        .unwrap_or_else(|| panic!("no array {key}"))
}

fn object(value: &mut Value) -> &mut Map<String, Value> {
    value.as_object_mut().expect("an object")
}

/// `apply` of `stats-vectors.mjs`.
fn apply(hand: &mut Value, op: &Value) {
    let value = op["value"].clone();
    match op["op"].as_str().expect("op name") {
        "drop" => {
            array(hand, "actions").remove(index(op, "i"));
        }
        "swap" => array(hand, "actions").swap(index(op, "i"), index(op, "j")),
        "type" => hand["actions"][index(op, "i")]["type"] = value,
        "seat" => hand["actions"][index(op, "i")]["seat"] = value,
        "street" => hand["actions"][index(op, "i")]["street"] = value,
        "amount" => hand["actions"][index(op, "i")]["amount"] = value,
        "verb" => {
            let action = object(&mut hand["actions"][index(op, "i")]);
            if value.is_null() {
                action.remove("verb");
            } else {
                action.insert("verb".to_owned(), value);
            }
        }
        "dup" => {
            let actions = array(hand, "actions");
            let copy = actions[index(op, "i")].clone();
            actions.insert(index(op, "j"), copy);
        }
        "positions" => {
            for player in array(hand, "players") {
                player["position"] = Value::Null;
            }
        }
        "position" => hand["players"][index(op, "p")]["position"] = value,
        "playerSeat" => hand["players"][index(op, "p")]["seat"] = value,
        "dropPlayer" => {
            array(hand, "players").remove(index(op, "p"));
        }
        "holeCards" => hand["players"][index(op, "p")]["holeCards"] = value,
        "stack" => hand["players"][index(op, "p")]["startingStack"] = value,
        "bigBlind" => hand["game"]["bigBlind"] = value,
        "variant" => hand["game"]["variant"] = value,
        "fee" => {
            let key = op["key"].as_str().expect("fee key");
            hand["results"]["fees"][key] = value;
        }
        "totalPot" => hand["results"]["totalPot"] = value,
        "runouts" => array(&mut hand["board"], "runouts").truncate(index(op, "n")),
        "cut" => {
            let field = op["field"].as_str().expect("field");
            hand["board"]["runouts"][index(op, "k")][field] = Value::Null;
        }
        "addRunout" => {
            let runouts = array(&mut hand["board"], "runouts");
            let mut copy = runouts.first().cloned().unwrap_or_else(|| {
                json!({
                    "index": 0,
                    "flop": ["2c", "3d", "4h"],
                    "turn": "5s",
                    "river": "6c",
                    "markerLabels": {},
                    "summaryCards": null,
                })
            });
            copy["index"] = Value::from(runouts.len());
            runouts.push(copy);
        }
        "chip" => {
            let movement = json!({
                "kind": "bad-beat-drop",
                "fromSeat": op["seat"].clone(),
                "fromPlayer": null,
                "toPot": op["toPot"].clone(),
                "amount": op["amount"].clone(),
                "raw": null,
                "anchor": "after-hole-cards",
            });
            let root = object(hand);
            match root.get_mut("chipMovements").and_then(Value::as_array_mut) {
                Some(movements) => movements.push(movement),
                None => {
                    root.insert("chipMovements".to_owned(), Value::Array(vec![movement]));
                }
            }
        }
        "handKey" => hand["meta"]["handKey"] = value,
        "siteId" => hand["meta"]["siteId"] = value,
        "cashoutRisk" => hand["results"]["players"][index(op, "k")]["cashoutRisk"] = value,
        other => panic!("unknown op {other}"),
    }
}

#[test]
fn mutated_golden_hands_derive_the_typescript_rows() {
    let path = std::env::var("STATS_VECTORS").unwrap_or_else(|_| {
        format!(
            "{}/tests/data/stats-vectors.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let vectors: Value = serde_json::from_str(&text).expect("vectors parse");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "no cases in {path}");

    let corpus = corpus();
    let mut failures: Vec<String> = Vec::new();
    for (n, case) in cases.iter().enumerate() {
        let file = case["file"].as_str().expect("file");
        let hand_index = index(case, "hand");
        let Some((_, hands)) = corpus.files.iter().find(|(name, _)| name == file) else {
            panic!("case {n}: no golden {file}; regenerate the vectors");
        };
        let base = &hands
            .get(hand_index)
            .unwrap_or_else(|| panic!("case {n}: {file} has no hand {hand_index}"))
            .hand;
        let base_text = to_canonical_json(base).expect("canonical PHF");
        assert_eq!(
            case["phf"].as_str(),
            Some(sha16(&base_text).as_str()),
            "case {n}: {file} hands[{hand_index}] is not the hand the vectors were drawn from; \
             regenerate them (node core/rail-stats/tests/data/stats-vectors.mjs)"
        );

        let mut value = serde_json::to_value(base).expect("PHF to JSON");
        for op in case["ops"].as_array().expect("ops") {
            apply(&mut value, op);
        }
        let hand: PhfHand = match serde_json::from_value(value) {
            Ok(hand) => hand,
            Err(e) => {
                failures.push(format!(
                    "case {n}: the mutated PHF does not deserialize: {e}"
                ));
                continue;
            }
        };
        let rows = rows_for(&hand);
        let hash = sha16(&rows_canonical(&rows));
        if case["rows"].as_str() != Some(hash.as_str()) {
            failures.push(format!(
                "case {n} ({file} hands[{hand_index}], ops {}): rows {hash}, the TypeScript's {}",
                case["ops"], case["rows"]
            ));
        }
    }

    if !failures.is_empty() {
        panic!(
            "{} of {} vector cases differ:\n{}",
            failures.len(),
            cases.len(),
            failures
                .iter()
                .take(MAX_REPORTED)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    println!("{} vector cases derive the TypeScript rows", cases.len());
}
