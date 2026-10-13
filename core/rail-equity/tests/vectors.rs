//! The seeded vectors (`tests/data/ev-vectors.json`, written by
//! `ev-vectors.mjs` next to it, which documents them) through the port:
//!
//! - **hands**: mutated golden hands through [`analyze_all_in`] with each
//!   case's options, and the stored row ([`ev_row_for`]) when the options
//!   are the defaults - the TypeScript's documents exactly, every equity bit
//!   for bit;
//! - **equity**: random [`equity`] and [`plan`] requests, results or error
//!   messages - the Monte Carlo ones included, so the sampler draws the
//!   TypeScript's boards;
//! - **ranges**: [`parse_range`], [`range_share`], [`equity_vs_range`],
//!   [`equity_vs_ranges`] and [`strongest_of_range`], doubles as `String(x)`.
//!
//! `EV_VECTORS=<path>` replays another vector file (a soak run).

#![allow(clippy::unwrap_used)]

mod support;

use rail_core::canonical::to_canonical_json;
use rail_core::eval::ShortDeckRule;
use rail_core::js::JsNumber;
use rail_core::phf::PhfHand;
use rail_equity::{
    ClassWeights, EquityGame, EquityMethod, EquityOptions, EquityRequest, MultiwayEquityRequest,
    Range, RangeEquityRequest, RangeError, WeightedCombo, analyze_all_in, equity, equity_vs_range,
    equity_vs_ranges, ev_row_for, parse_range, plan, range_share, strongest_of_range,
};
use serde_json::{Value, json};
use support::{corpus, sha256_hex};

const MAX_REPORTED: usize = 20;

fn vectors() -> &'static Value {
    static VECTORS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    VECTORS.get_or_init(|| {
        let path = std::env::var("EV_VECTORS").unwrap_or_else(|_| {
            format!("{}/tests/data/ev-vectors.json", env!("CARGO_MANIFEST_DIR"))
        });
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).expect("vectors parse")
    })
}

fn report(section: &str, total: usize, failures: &[String]) {
    assert!(total > 0, "no {section} cases");
    if !failures.is_empty() {
        panic!(
            "{} of {total} {section} cases differ:\n{}",
            failures.len(),
            failures
                .iter()
                .take(MAX_REPORTED)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .map(|v| v.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn usize_of(value: &Value) -> usize {
    usize::try_from(value.as_u64().expect("an index")).expect("small")
}

fn js(number: JsNumber) -> Value {
    Value::from(number.to_js_string())
}

/* ------------------------------------------------------------- options - */

fn options_of(value: &Value) -> EquityOptions {
    EquityOptions {
        method: match value["method"].as_str() {
            Some("exhaustive") => EquityMethod::Exhaustive,
            Some("monte-carlo") => EquityMethod::MonteCarlo,
            _ => EquityMethod::Auto,
        },
        exhaustive_limit: value["exhaustiveLimit"].as_u64(),
        trials: value["trials"].as_u64(),
        seed: value["seed"]
            .as_u64()
            .map(|seed| u32::try_from(seed).expect("a 32-bit seed")),
    }
}

/* --------------------------------------------------------------- hands - */

/// The array or object `path` leads to, `[]` created where missing (`at`).
fn at<'v>(doc: &'v mut Value, path: &[Value]) -> &'v mut Value {
    let mut node = doc;
    for key in path {
        let slot = match key {
            Value::String(name) => {
                let object = node.as_object_mut().expect("an object");
                object.entry(name.clone()).or_insert(Value::Null)
            }
            index => &mut node[usize_of(index)],
        };
        if slot.is_null() {
            *slot = Value::Array(Vec::new());
        }
        node = slot;
    }
    node
}

fn list<'v>(doc: &'v mut Value, path: &Value) -> &'v mut Vec<Value> {
    at(doc, path.as_array().expect("path"))
        .as_array_mut()
        .expect("an array")
}

/// `apply` of `ev-vectors.mjs`.
fn apply(doc: &mut Value, op: &Value) {
    let path = &op["path"];
    match op["op"].as_str().expect("op") {
        "set" => {
            let steps = path.as_array().expect("path");
            let (last, parent) = steps.split_last().expect("a path");
            let parent = at(doc, parent);
            let value = op["value"].clone();
            match last {
                Value::String(name) => {
                    parent
                        .as_object_mut()
                        .expect("an object")
                        .insert(name.clone(), value);
                }
                index => {
                    let items = parent.as_array_mut().expect("an array");
                    let i = usize_of(index);
                    if i == items.len() {
                        items.push(value);
                    } else {
                        items[i] = value;
                    }
                }
            }
        }
        "drop" => {
            list(doc, path).remove(usize_of(&op["i"]));
        }
        "swap" => list(doc, path).swap(usize_of(&op["i"]), usize_of(&op["j"])),
        "copy" => {
            let items = list(doc, path);
            let copy = items[usize_of(&op["i"])].clone();
            items.insert(usize_of(&op["j"]), copy);
        }
        "push" => list(doc, path).push(op["value"].clone()),
        "truncate" => list(doc, path).truncate(usize_of(&op["n"])),
        other => panic!("unknown op {other}"),
    }
}

#[test]
fn mutated_golden_hands_give_the_typescript_analysis_and_row() {
    let cases = vectors()["hands"].as_array().expect("hands");
    let corpus = corpus();
    let mut failures = Vec::new();
    for (n, case) in cases.iter().enumerate() {
        let file = case["file"].as_str().expect("file");
        let index = usize_of(&case["hand"]);
        let Some((_, hands)) = corpus.files.iter().find(|(name, _)| name == file) else {
            panic!("case {n}: no golden {file}; regenerate the vectors");
        };
        let base = &hands[index].hand;
        let base_text = to_canonical_json(base).expect("canonical PHF");
        assert_eq!(
            case["phf"].as_str(),
            Some(&sha256_hex(&base_text)[..16]),
            "case {n}: {file} hands[{index}] is not the hand the vectors were drawn from; \
             regenerate them (node core/rail-equity/tests/data/ev-vectors.mjs)"
        );
        let mut doc = serde_json::to_value(base).expect("PHF to JSON");
        for op in case["ops"].as_array().expect("ops") {
            apply(&mut doc, op);
        }
        let hand: PhfHand = match serde_json::from_value(doc) {
            Ok(hand) => hand,
            Err(e) => {
                failures.push(format!(
                    "case {n}: the mutated PHF does not deserialize: {e}"
                ));
                continue;
            }
        };
        let options = if case["options"].is_null() {
            EquityOptions::default()
        } else {
            options_of(&case["options"])
        };
        let analysis = analyze_all_in(&hand, &options).to_json();
        if analysis != case["analysis"] {
            failures.push(format!(
                "case {n} ({file} hands[{index}], ops {}): analysis\n  ours   {analysis}\n  theirs {}",
                case["ops"], case["analysis"]
            ));
        }
        if let Some(expected) = case.get("row") {
            let row = ev_row_for(&hand).map_or(Value::Null, |row| row.to_json());
            if &row != expected {
                failures.push(format!(
                    "case {n} ({file} hands[{index}]): row\n  ours   {row}\n  theirs {expected}"
                ));
            }
        }
    }
    report("hand", cases.len(), &failures);
}

/* -------------------------------------------------------------- equity - */

fn game_of(name: &str) -> EquityGame {
    match name {
        "holdem" => EquityGame::Holdem,
        "shortdeck" => EquityGame::Shortdeck,
        "omaha" => EquityGame::Omaha,
        "omaha5" => EquityGame::Omaha5,
        "omaha6" => EquityGame::Omaha6,
        other => panic!("game {other}"),
    }
}

fn request_of(value: &Value) -> EquityRequest {
    EquityRequest {
        game: game_of(value["game"].as_str().expect("game")),
        short_deck_rule: value["shortDeckRule"].as_str().map(|rule| match rule {
            "straight-over-trips" => ShortDeckRule::StraightOverTrips,
            _ => ShortDeckRule::TripsOverStraight,
        }),
        hands: value["hands"]
            .as_array()
            .expect("hands")
            .iter()
            .map(strings)
            .collect(),
        board: strings(&value["board"]),
        dead: strings(&value["dead"]),
        pots: value["pots"].as_array().map(|pots| {
            pots.iter()
                .map(|pot| {
                    pot.as_array()
                        .expect("a pot")
                        .iter()
                        .map(|i| i.as_i64().expect("an index"))
                        .collect()
                })
                .collect()
        }),
        options: options_of(value),
    }
}

#[test]
fn random_equity_requests_give_the_typescript_answers() {
    let cases = vectors()["equity"].as_array().expect("equity");
    let mut failures = Vec::new();
    for (n, case) in cases.iter().enumerate() {
        let request = request_of(&case["request"]);
        let ours = match (plan(&request), equity(&request)) {
            (Ok(planned), Ok(result)) => json!({
                "plan": {
                    "method": planned.method.as_str(),
                    "boards": planned.boards,
                    "evaluations": planned.evaluations,
                },
                "result": {
                    "pots": result.pots.iter().map(|row| row.iter().map(|&x| js(x)).collect::<Vec<_>>()).collect::<Vec<_>>(),
                    "method": result.method.as_str(),
                    "boards": result.boards,
                },
            }),
            (Err(error), _) | (_, Err(error)) => json!({ "error": error.0 }),
        };
        let mut theirs = case.clone();
        theirs.as_object_mut().expect("case").remove("request");
        if ours != theirs {
            failures.push(format!(
                "case {n} ({}):\n  ours   {ours}\n  theirs {theirs}",
                case["request"]
            ));
        }
    }
    report("equity", cases.len(), &failures);
}

/* -------------------------------------------------------------- ranges - */

fn range_of(value: &Value) -> Range {
    if let Some(classes) = value["classes"].as_array() {
        return Range::Classes(classes_of(classes));
    }
    Range::Combos(
        value["combos"]
            .as_array()
            .expect("combos")
            .iter()
            .map(|combo| {
                let cards = combo[0].as_array().expect("cards");
                let card = |i: usize| u8::try_from(cards[i].as_u64().expect("card")).expect("card");
                WeightedCombo {
                    cards: [card(0), card(1)],
                    weight: JsNumber::parse(combo[1].as_str().expect("weight")),
                }
            })
            .collect(),
    )
}

fn classes_of(list: &[Value]) -> ClassWeights {
    list.iter()
        .map(|entry| {
            (
                entry[0].as_str().expect("name").to_owned(),
                JsNumber::parse(entry[1].as_str().expect("weight")),
            )
        })
        .collect()
}

fn classes_json(classes: &ClassWeights) -> Value {
    Value::Array(
        classes
            .iter()
            .map(|(name, weight)| json!([name, weight.to_js_string()]))
            .collect(),
    )
}

fn input_error(message: &str) -> Value {
    json!({ "error": "input", "message": message })
}

fn range_result(
    equity: JsNumber,
    win: JsNumber,
    tie: JsNumber,
    combos: Value,
    method: &str,
    samples: u64,
) -> Value {
    json!({
        "result": {
            "equity": js(equity),
            "win": js(win),
            "tie": js(tie),
            "combos": combos,
            "method": method,
            "samples": samples,
        }
    })
}

/// What the port answers for one range case, in the vector's shape (only
/// the keys the TypeScript side computed; the inputs are added back below).
fn answer(case: &Value) -> Value {
    let kind = case["kind"].as_str().expect("kind");
    match kind {
        "parse" => match parse_range(case["text"].as_str().expect("text")) {
            Ok(classes) => json!({ "classes": classes_json(&classes) }),
            Err(RangeError::Input(error)) => input_error(&error.0),
            Err(RangeError::Type) => json!({ "error": "type" }),
        },
        "share" => {
            let classes = classes_of(case["classes"].as_array().expect("classes"));
            match range_share(&classes) {
                Ok(share) => json!({ "share": js(share) }),
                Err(error) => input_error(&error.0),
            }
        }
        "strongest" => {
            let share = JsNumber::parse(case["share"].as_str().expect("share"));
            match strongest_of_range(
                &range_of(&case["range"]),
                &strings(&case["board"]),
                share,
                &strings(&case["dead"]),
            ) {
                Ok(combos) => json!({
                    "combos": combos
                        .iter()
                        .map(|c| json!([[c.cards[0], c.cards[1]], c.weight.to_js_string()]))
                        .collect::<Vec<_>>(),
                }),
                Err(error) => input_error(&error.0),
            }
        }
        "vsRange" => {
            let request = RangeEquityRequest {
                hero: strings(&case["hero"]),
                range: range_of(&case["range"]),
                board: strings(&case["board"]),
                dead: strings(&case["dead"]),
                options: options_of(&case["options"]),
            };
            match equity_vs_range(&request) {
                Ok(r) => range_result(
                    r.equity,
                    r.win,
                    r.tie,
                    Value::from(r.combos),
                    r.method.as_str(),
                    r.samples,
                ),
                Err(error) => input_error(&error.0),
            }
        }
        "vsRanges" => {
            let request = MultiwayEquityRequest {
                hero: strings(&case["hero"]),
                ranges: case["ranges"]
                    .as_array()
                    .expect("ranges")
                    .iter()
                    .map(range_of)
                    .collect(),
                board: strings(&case["board"]),
                dead: strings(&case["dead"]),
                options: options_of(&case["options"]),
            };
            match equity_vs_ranges(&request) {
                Ok(r) => range_result(
                    r.equity,
                    r.win,
                    r.tie,
                    json!(r.combos),
                    r.method.as_str(),
                    r.samples,
                ),
                Err(error) => input_error(&error.0),
            }
        }
        other => panic!("kind {other}"),
    }
}

/// The inputs of a range case: everything the generator wrote before the
/// answer.
const INPUTS: [&str; 10] = [
    "kind", "text", "hero", "range", "ranges", "board", "dead", "options", "share", "classes",
];

#[test]
fn range_requests_give_the_typescript_answers() {
    let cases = vectors()["ranges"].as_array().expect("ranges");
    let mut failures = Vec::new();
    for (n, case) in cases.iter().enumerate() {
        let ours = answer(case);
        let mut theirs = case.clone();
        let object = theirs.as_object_mut().expect("case");
        for key in INPUTS {
            // `share` and `classes` are answers for some kinds and inputs
            // for others: keep them where the port answers them.
            if ours.get(key).is_none() {
                object.remove(key);
            }
        }
        if ours != theirs {
            failures.push(format!("case {n}:\n  ours   {ours}\n  theirs {case}"));
        }
    }
    report("range", cases.len(), &failures);
}
