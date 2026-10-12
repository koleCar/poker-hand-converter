//! The WePlay and CoinPoker parsers against the TypeScript beyond the corpus
//! (docs/RAIL-PLAN.md R0.7b): the vectors in `tests/data/wpcp-vectors.json`,
//! written by `wpcp-vectors.mjs` next to it, which runs the TypeScript.
//!
//! 1. **Splits**: both parsers' `splitHands` of every corpus file and of
//!    hand-written edge cases (bare `\r`, BOMs, U+2028/U+2029).
//! 2. **Detection** of hand-written probes.
//! 3. **Cases**: seeded line edits of WePlay and CoinPoker corpus chunks
//!    (deleted, swapped, duplicated and inserted lines from a catalogue of
//!    each room's shapes, changed amounts - thousandths, twenty digits -,
//!    other headers - currencies, tournaments, Omaha, All-in or Fold,
//!    unparseable -, a cut SUMMARY, `\r` / `\r\n` / U+2028 line ends, a BOM),
//!    each through its parser with the default and the strict options
//!    (`cashOnly`, `skipBombPots`); WePlay's also through
//!    `normalizeWeplayChunk` alone.
//!
//! The `legacy` half of the file is `byteCompat.test.ts`'s reference and is
//! read by `tests/wpcp_parsers.rs`.
//!
//! Needs no `testdata/golden-full/`.

mod golden;

use std::collections::HashMap;
use std::sync::LazyLock;

use rail_core::canonical::{CanonicalJsonError, to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::parsers::coinpoker::CoinPokerParser;
use rail_core::parsers::weplay::{WePlayParser, normalize_weplay_chunk};
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let text = include_str!("data/wpcp-vectors.json");
    serde_json::from_str(text).expect("wpcp-vectors.json")
});

const MAX_REPORTED: usize = 20;

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/wpcp-vectors.mjs`)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "weplay" => &WePlayParser,
        "coinpoker" => &CoinPokerParser,
        other => panic!("no parser {other}"),
    }
}

/// The decoded text of a corpus file (what the app hands the parsers).
fn decoded(path: &str) -> String {
    let full = path
        .split('/')
        .fold(golden::root(), |dir, part| dir.join(part));
    let bytes = std::fs::read(&full).unwrap_or_else(|e| panic!("read {path}: {e}"));
    decode_source(&bytes).text
}

fn split_hash(id: &str, text: &str) -> String {
    let chunks = parser(id).split_hands(text).expect("split");
    short(&serde_json::to_string(&chunks).expect("json"))
}

/// The edit script of a case, applied as the generator applies it.
fn apply(chunk: &str, ops: &[Value]) -> String {
    let mut lines: Vec<String> = chunk.split('\n').map(str::to_owned).collect();
    let mut sep = "\n".to_owned();
    let mut prefix = String::new();
    let index = |v: &Value| usize::try_from(v.as_u64().expect("index")).expect("usize");
    let text = |v: &Value| v.as_str().expect("text").to_owned();
    for op in ops {
        let op = op.as_array().expect("op");
        match op[0].as_str().expect("kind") {
            "delete" => {
                let at = index(&op[1]);
                if at < lines.len() {
                    lines.remove(at);
                }
            }
            "insert" => {
                let at = index(&op[1]).min(lines.len());
                lines.insert(at, text(&op[2]));
            }
            "replace" => {
                let at = index(&op[1]);
                while lines.len() <= at {
                    lines.push(String::new());
                }
                lines[at] = text(&op[2]);
            }
            "swap" => {
                let at = index(&op[1]);
                if at + 1 < lines.len() {
                    lines.swap(at, at + 1);
                }
            }
            "truncate" => lines.truncate(index(&op[1])),
            "join" => sep = text(&op[1]),
            "prefix" => prefix = text(&op[1]),
            other => panic!("unknown op {other}"),
        }
    }
    format!("{prefix}{}", lines.join(&sep))
}

/// `parseHand`'s outcome in the vectors' shape. A hand no PHF can hold (an
/// amount beyond 2^53) is `{ unrepresentable: path }`: the TypeScript builds
/// it and its canonical JSON throws, which the generator records as an error.
fn outcome(id: &str, text: &str, options: &ConvertOptions) -> Value {
    let ctx = SiteParserContext {
        source_filename: None,
        options,
    };
    match parser(id).parse_hand(text, &ctx) {
        Ok(hand) => match to_canonical_json(&hand) {
            Ok(canonical) => json!({ "hand": short(&canonical) }),
            Err(CanonicalJsonError::Number { path, .. }) => json!({ "unrepresentable": path }),
            Err(error) => panic!("{error}"),
        },
        Err(ParseError::Skip(skip)) => json!({ "skip": [skip.reason.as_str(), skip.message] }),
        Err(ParseError::Bug(message)) => json!({ "error": message }),
    }
}

/// Whether `actual` is what Rust does where the TypeScript's hand has a number
/// beyond 2^53 (`expected` is then the canonical-JSON error): the same hand,
/// unrepresentable at the same path - or, for a seat, table size, button or
/// level beyond `u32`, the reader's `parser-error` (R0.6: those are `u32` in a
/// PHF hand; not reproducible).
fn unrepresentable_alike(expected: &Value, actual: &Value) -> bool {
    let Some(error) = expected["error"].as_str() else {
        return false;
    };
    let Some((path, rest)) = error.split_once(": ") else {
        return false;
    };
    if !rest.ends_with(" is not a safe integer (floats are not allowed)") {
        return false;
    }
    actual["unrepresentable"].as_str() == Some(path)
        || ([".seat", ".buttonSeat", ".maxSeats", ".levelNumber"]
            .iter()
            .any(|field| path.ends_with(field))
            && actual["error"]
                .as_str()
                .is_some_and(|m| m.contains("is beyond what a PHF hand can hold (u32)")))
}

fn strict(id: &str) -> ConvertOptions {
    ConvertOptions {
        cash_only: true,
        skip_bomb_pots: id == "weplay",
        ..ConvertOptions::default()
    }
}

#[test]
fn splits_match_the_typescript() {
    let splits = VECTORS["splits"].as_array().expect("splits");
    let mut problems = Vec::new();
    for case in splits {
        let text = match (case.get("file"), case.get("text")) {
            (Some(file), _) => decoded(file.as_str().expect("file")),
            (_, Some(text)) => text.as_str().expect("text").to_owned(),
            _ => panic!("split case without input"),
        };
        for id in ["weplay", "coinpoker"] {
            if case[id].as_str() != Some(split_hash(id, &text).as_str()) {
                problems.push(format!("{id} split of {case}"));
            }
        }
    }
    assert!(splits.len() > 550);
    assert!(
        problems.is_empty(),
        "{} of {} differ{STALE}:\n{}",
        problems.len(),
        splits.len(),
        problems.join("\n")
    );
}

#[test]
fn detection_matches_the_typescript() {
    for case in VECTORS["detect"].as_array().expect("detect") {
        let text = case["text"].as_str().expect("text");
        for id in ["weplay", "coinpoker"] {
            assert_eq!(
                Some(u64::from(parser(id).detect(text))),
                case[id].as_u64(),
                "{id} on {text:?}{STALE}"
            );
        }
    }
}

#[test]
fn cases_match_the_typescript() {
    let cases = VECTORS["cases"].as_array().expect("cases");
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut chunks: HashMap<String, Vec<String>> = HashMap::new();
    let mut problems = Vec::new();
    let mut hands = 0;
    let mut unrepresentable = 0;
    let mut by_site: HashMap<&str, usize> = HashMap::new();
    let defaults = ConvertOptions::default();
    for case in cases {
        let file = case["file"].as_str().expect("file");
        let split = case["split"].as_str().expect("split");
        let index = usize::try_from(case["chunk"].as_u64().expect("chunk")).expect("usize");
        let text = texts
            .entry(file.to_owned())
            .or_insert_with(|| decoded(file))
            .clone();
        let chunk = chunks
            .entry(file.to_owned())
            .or_insert_with(|| parser(split).split_hands(&text).expect("split"))[index]
            .clone();
        let input = apply(&chunk, case["ops"].as_array().expect("ops"));
        let label = format!("{file}#{index} {}", case["ops"]);
        *by_site
            .entry(if split == "weplay" {
                "weplay"
            } else {
                "coinpoker"
            })
            .or_default() += 1;

        let detect = u64::from(parser(split).detect(&input));
        if Some(detect) != case["detect"].as_u64() {
            problems.push(format!("{label}: detect {detect}"));
        }
        for (key, options) in [("outcome", &defaults), ("strict", &strict(split))] {
            let actual = outcome(split, &input, options);
            if actual.get("hand").is_some() {
                hands += 1;
            }
            if unrepresentable_alike(&case[key], &actual) {
                unrepresentable += 1;
            } else if actual != case[key] {
                problems.push(format!(
                    "{label}: {key} expected {}, got {actual}",
                    case[key]
                ));
            }
        }
        if split == "weplay" {
            let actual = match normalize_weplay_chunk(&input) {
                Ok(normalized) => {
                    json!({ "text": short(&normalized.text), "id": normalized.hand_id })
                }
                Err(skip) => json!({ "skip": [skip.reason.as_str(), skip.message] }),
            };
            if actual != case["normalized"] {
                problems.push(format!(
                    "{label}: normalized expected {}, got {actual}",
                    case["normalized"]
                ));
            }
        }
    }
    assert!(
        by_site["weplay"] > 2000 && by_site["coinpoker"] > 800 && hands > 2500,
        "{by_site:?}, {hands} hands"
    );
    let shown: Vec<_> = problems.iter().take(MAX_REPORTED).cloned().collect();
    assert!(
        problems.is_empty(),
        "{} of {} cases differ{STALE}:\n{}",
        problems.len(),
        cases.len(),
        shown.join("\n")
    );
    // Twenty-digit amounts and seats: kept few, and counted.
    assert!(
        unrepresentable * 100 < cases.len(),
        "{unrepresentable} unrepresentable"
    );
}
