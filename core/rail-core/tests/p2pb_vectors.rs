//! The partypoker, 888poker and PokerBros parsers against the TypeScript
//! beyond the corpus (docs/RAIL-PLAN.md R0.8): the vectors in
//! `tests/data/p2pb-vectors.json`, written by `p2pb-vectors.mjs` next to it,
//! which runs the TypeScript.
//!
//! 1. **Splits**: the three parsers' `splitHands` of every corpus file and of
//!    hand-written edge cases (`#Game No` lines, BOMs, bare `\r`, U+2028,
//!    both PokerBros dialects).
//! 2. **Detection** of hand-written probes (brands, skins, the 888 and
//!    partypoker stakes lines on each other's banner, the PokerBros banner
//!    at a JavaScript line start).
//! 3. **Cases**: seeded line edits of every corpus chunk of the three rooms
//!    (deleted, swapped, duplicated and inserted lines from a catalogue of
//!    each dialect's shapes, changed amounts - thousandths, grouped,
//!    twenty digits -, other banners and stakes lines - currencies, zones,
//!    hi/lo, stud, five-card Omaha, the European 888 locale, rolled-over
//!    dates -, cut hands, `\r` / `\r\n` / U+2028 line ends, a BOM), each
//!    through all three parsers: detection and outcome.
//! 4. **Files**: the corpus files of the three rooms re-encoded (UTF-16 LE
//!    with and without a BOM, UTF-16 BE, Windows-1252 with `€` and `£`
//!    amounts, CRLF) through `rail_core::convert`: encoding, ranking, every
//!    hand and every refusal.
//!
//! Needs no `testdata/golden-full/`.

mod golden;

use std::collections::HashMap;
use std::sync::LazyLock;

use rail_core::canonical::{CanonicalJsonError, to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::parsers::partypoker::PartyPokerParser;
use rail_core::parsers::pokerbros::PokerBrosParser;
use rail_core::parsers::pokerstars888::Poker888Parser;
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let text = include_str!("data/p2pb-vectors.json");
    serde_json::from_str(text).expect("p2pb-vectors.json")
});

const MAX_REPORTED: usize = 20;
const IDS: [&str; 3] = ["partypoker", "888poker", "pokerbros"];

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/p2pb-vectors.mjs`)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "partypoker" => &PartyPokerParser,
        "888poker" => &Poker888Parser,
        "pokerbros" => &PokerBrosParser,
        other => panic!("no parser {other}"),
    }
}

fn path_of(path: &str) -> std::path::PathBuf {
    path.split('/')
        .fold(golden::root(), |dir, part| dir.join(part))
}

/// The decoded text of a corpus file (what the app hands the parsers).
fn decoded(path: &str) -> String {
    let bytes = std::fs::read(path_of(path)).unwrap_or_else(|e| panic!("read {path}: {e}"));
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
/// amount beyond 2^53) is `{ unrepresentable: path }`.
fn outcome(id: &str, text: &str) -> Value {
    let options = ConvertOptions::default();
    let ctx = SiteParserContext {
        source_filename: None,
        options: &options,
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
        for id in IDS {
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
        for id in IDS {
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
    let mut hands: HashMap<&str, usize> = HashMap::new();
    let mut unrepresentable = 0;
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

        for id in IDS {
            let detect = u64::from(parser(id).detect(&input));
            if Some(detect) != case["detect"][id].as_u64() {
                problems.push(format!("{label}: {id} detect {detect}"));
            }
            let expected = &case["outcomes"][id];
            let actual = outcome(id, &input);
            if actual.get("hand").is_some() {
                *hands.entry(id).or_default() += 1;
            }
            if unrepresentable_alike(expected, &actual) {
                unrepresentable += 1;
            } else if actual != *expected {
                problems.push(format!("{label}: {id} expected {expected}, got {actual}"));
            }
        }
    }
    assert!(
        cases.len() > 3000
            && hands.get("partypoker") > Some(&600)
            && hands.get("888poker") > Some(&400)
            && hands.get("pokerbros") > Some(&500),
        "{} cases, {hands:?} hands",
        cases.len()
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

/// `TRANSFORMS` of the generator.
fn encode(text: &str, transform: &str) -> Vec<u8> {
    let utf16 = |text: &str, big_endian: bool| -> Vec<u8> {
        text.encode_utf16()
            .flat_map(|unit| {
                if big_endian {
                    unit.to_be_bytes()
                } else {
                    unit.to_le_bytes()
                }
            })
            .collect()
    };
    match transform {
        "utf16le-bom" => [vec![0xff, 0xfe], utf16(text, false)].concat(),
        "utf16le" => utf16(text, false),
        "utf16be-bom" => [vec![0xfe, 0xff], utf16(text, true)].concat(),
        "cp1252-euro" => cp1252(&text.replace('$', "€").replace("USD", "EUR")),
        "cp1252-pound" => cp1252(&text.replace('$', "£").replace("USD", "GBP")),
        "utf8-crlf" => text.replace('\n', "\r\n").into_bytes(),
        other => panic!("unknown transform {other}"),
    }
}

/// Windows-1252 bytes (`?` for what it cannot hold).
fn cp1252(text: &str) -> Vec<u8> {
    const HIGH: &str = "€\u{81}‚ƒ„…†‡ˆ‰Š‹Œ\u{8d}Ž\u{8f}\u{90}‘’“”•–—˜™š›œ\u{9d}žŸ";
    text.chars()
        .map(|c| {
            if let Some(i) = HIGH.chars().position(|h| h == c) {
                0x80 + u8::try_from(i).expect("32 entries")
            } else {
                u8::try_from(u32::from(c))
                    .ok()
                    .filter(|b| *b < 0x80 || *b >= 0xa0)
                    .unwrap_or(b'?')
            }
        })
        .collect()
}

#[test]
fn re_encoded_files_convert_as_the_typescript_does() {
    let entries = VECTORS["files"].as_array().expect("files");
    let mut problems = Vec::new();
    let mut hands = 0;
    for entry in entries {
        let file = entry["file"].as_str().expect("file");
        let transform = entry["transform"].as_str().expect("transform");
        let text = decoded(file);
        let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
        let bytes = encode(text, transform);
        let name = file.rsplit('/').next().expect("name");
        let converted = rail_core::convert(&bytes, name);
        let label = format!("{file} {transform}");
        if converted.encoding.label() != entry["encoding"].as_str().expect("encoding") {
            problems.push(format!("{label}: encoding {}", converted.encoding.label()));
        }
        if !entry["problem"].is_null() || converted.problem.is_some() {
            problems.push(format!("{label}: unexpected decode problem"));
            continue;
        }
        let detected: Vec<Value> = converted
            .detected
            .iter()
            .map(|c| json!([c.parser, c.permille]))
            .collect();
        if Value::from(detected.clone()) != entry["detected"] {
            problems.push(format!("{label}: detected {detected:?}"));
        }
        let result = converted
            .result
            .expect("decoded")
            .expect("convertAny threw");
        let actual_hands: Vec<Value> = result
            .hands
            .iter()
            .map(|h| {
                Value::from(short(
                    &to_canonical_json(&h.hand).expect("representable hand"),
                ))
            })
            .collect();
        hands += actual_hands.len();
        if Value::from(actual_hands) != entry["hands"] {
            problems.push(format!("{label}: hands differ"));
        }
        let failures: Vec<Value> = result
            .failures
            .iter()
            .map(|f| json!([f.reason.as_str(), f.message]))
            .collect();
        if Value::from(failures.clone()) != entry["failures"] {
            problems.push(format!("{label}: failures {failures:?}"));
        }
    }
    assert!(
        entries.len() > 180 && hands > 150,
        "{} files, {hands} hands",
        entries.len()
    );
    assert!(
        problems.is_empty(),
        "{} of {} differ{STALE}:\n{}",
        problems.len(),
        entries.len(),
        problems.join("\n")
    );
}
