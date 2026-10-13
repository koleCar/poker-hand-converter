//! The Ongame, Entraction and Unibet parsers against the TypeScript beyond the
//! corpus (docs/RAIL-PLAN.md R0.10d): the vectors in
//! `tests/data/p4-vectors.json`, written by `p4-vectors.mjs` next to it,
//! which runs the TypeScript.
//!
//! 0. **Text-room helpers**: `expandMonth`, `namesByLength`, `leadingName`,
//!    `refuseLossyText` and `currencySymbolOf` probes (UTF-16 lengths, case,
//!    prefixes, U+FFFD).
//! 1. **Splits**: the three parsers' `splitHands` of every corpus file and of
//!    hand-written edge cases (BOMs, bare `\r`, U+2028/9, a Unibet header
//!    whose date V8 rejects - the split throws -, UTF-16LE text read as
//!    UTF-8).
//! 2. **Detection** of hand-written probes (the banners and headers at every
//!    JavaScript line start, Entraction's whole-text header, Unibet's XML
//!    guard and its summary export).
//! 3. **Cases**: seeded line edits of every corpus chunk of the three rooms
//!    (deleted, swapped, duplicated and inserted lines from a catalogue of
//!    each grammar's shapes, Ongame `Table:` lines and Entraction / Unibet
//!    headers - variants, limits, hi/lo, currencies and codes, chips,
//!    comma decimals, tournaments with `$` patterns in their ids and buy-ins,
//!    dates V8 rolls over or rejects -, changed amounts, renamed seats, a
//!    currency glyph turned into U+FFFD, cut hands, `\r` / `\r\n` / U+2028 line
//!    ends, a BOM, the whole text misread from UTF-16LE), each through all
//!    three parsers: detection and outcome, and the outcome with `cashOnly`
//!    where it differs.
//! 4. **Files**: the corpus files of the three rooms re-encoded (UTF-16 LE
//!    with and without a BOM, UTF-16 BE, Windows-1252, CRLF, UTF-8 with a
//!    BOM) through `rail_core::convert`.
//!
//! `P4_VECTORS=<path>` reads another vector file (a soak run, written with
//! `P4_STRESS=<seed> P4_OUT=<path>`). Needs no `testdata/golden-full/`.

mod golden;

use std::collections::HashMap;
use std::sync::LazyLock;

use rail_core::canonical::{CanonicalJsonError, to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::parsers::entraction::EntractionParser;
use rail_core::parsers::ongame::OngameParser;
use rail_core::parsers::shared::p4_textroom::{
    currency_symbol_of, expand_month, leading_name, names_by_length, refuse_lossy_text,
};
use rail_core::parsers::unibet::UnibetParser;
use rail_core::phf::PhfHand;
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let path = std::env::var("P4_VECTORS").map_or_else(
        |_| golden::root().join("core/rail-core/tests/data/p4-vectors.json"),
        std::path::PathBuf::from,
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).expect("p4-vectors.json")
});

/// Whether this run reads the committed vectors (whose sizes are asserted).
fn committed() -> bool {
    std::env::var("P4_VECTORS").is_err()
}

const MAX_REPORTED: usize = 20;
const IDS: [&str; 3] = ["ongame", "entraction", "unibet"];

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/p4-vectors.mjs`)";

const U32_ERROR: &str = "is beyond what a PHF hand can hold (u32)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "ongame" => &OngameParser,
        "entraction" => &EntractionParser,
        "unibet" => &UnibetParser,
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

/// `splitHands` as the generator hashes it: the chunks, or `{ error }`.
fn split_hash(id: &str, text: &str) -> String {
    match parser(id).split_hands(text) {
        Ok(chunks) => short(&serde_json::to_string(&chunks).expect("json")),
        Err(error) => short(&serde_json::to_string(&json!({ "error": error.0 })).expect("json")),
    }
}

/// UTF-16LE bytes (after a BOM when asked) read as UTF-8, as Node's
/// `Buffer.toString("utf8")` reads them.
fn misread(text: &str, bom: bool) -> String {
    let mut bytes = if bom { vec![0xff, 0xfe] } else { Vec::new() };
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The edit script of a case, applied as the generator applies it.
fn apply(chunk: &str, ops: &[Value]) -> String {
    let mut lines: Vec<String> = chunk.split('\n').map(str::to_owned).collect();
    let mut sep = "\n".to_owned();
    let mut prefix = String::new();
    let mut misread_bom: Option<bool> = None;
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
            "misread" => misread_bom = Some(op[1].as_bool().expect("bom")),
            other => panic!("unknown op {other}"),
        }
    }
    let joined = format!("{prefix}{}", lines.join(&sep));
    match misread_bom {
        Some(bom) => misread(&joined, bom),
        None => joined,
    }
}

fn ctx(options: &ConvertOptions) -> SiteParserContext<'_> {
    SiteParserContext {
        source_filename: None,
        options,
    }
}

/// A built hand or a refusal in the vectors' shape. A hand no PHF can hold
/// (an amount beyond 2^53) is `{ unrepresentable: path }`.
fn shaped(result: Result<PhfHand, ParseError>) -> Value {
    match result {
        Ok(hand) => match to_canonical_json(&hand) {
            Ok(canonical) => json!({ "hand": short(&canonical) }),
            Err(CanonicalJsonError::Number { path, .. }) => json!({ "unrepresentable": path }),
            Err(error) => panic!("{error}"),
        },
        Err(ParseError::Skip(skip)) => json!({ "skip": [skip.reason.as_str(), skip.message] }),
        Err(ParseError::Bug(message)) => json!({ "error": message }),
    }
}

fn outcome(id: &str, text: &str, options: &ConvertOptions) -> Value {
    shaped(parser(id).parse_hand(text, &ctx(options)))
}

/// Where the TypeScript's hand has a number beyond 2^53 (its canonical JSON
/// throws): Rust's hand is unrepresentable at the same path, or - for a
/// seat, table size or button beyond `u32` - the standard-text reader's
/// `parser-error` (R0.6: those are `u32` in a PHF hand; not reproducible).
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
        || ([".seat", ".buttonSeat", ".maxSeats"]
            .iter()
            .any(|field| path.ends_with(field))
            && actual["error"]
                .as_str()
                .is_some_and(|m| m.contains(U32_ERROR)))
}

/// A seat, table size or button the TypeScript's hand holds and a PHF
/// (`u32`) cannot - between 2^32 and 2^53 (`Seat 99999999999:`): the
/// standard text the draft builder writes is read back by Rust's reader,
/// which stops with its `parser-error` where the TypeScript returns the hand
/// (or fails its canonical JSON on another number). Not reproducible,
/// counted.
fn beyond_u32(expected: &Value, actual: &Value) -> bool {
    let typescript_holds_it = expected.get("hand").is_some()
        || expected["error"]
            .as_str()
            .is_some_and(|m| m.ends_with(" is not a safe integer (floats are not allowed)"));
    typescript_holds_it
        && actual["error"]
            .as_str()
            .is_some_and(|m| m.contains(U32_ERROR))
}

#[test]
fn textroom_helpers_match_the_typescript() {
    let textroom = &VECTORS["textroom"];
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .expect("list")
            .iter()
            .map(|s| s.as_str().expect("string").to_owned())
            .collect()
    };
    let mut probes = 0;
    for probe in textroom["expandMonth"].as_array().expect("expandMonth") {
        let input = probe[0].as_str().expect("month");
        assert_eq!(
            Some(expand_month(input).as_str()),
            probe[1].as_str(),
            "{input:?}{STALE}"
        );
        probes += 1;
    }
    let lists: Vec<Vec<String>> = textroom["namesByLength"]
        .as_array()
        .expect("namesByLength")
        .iter()
        .map(|probe| {
            let names = strings(&probe[0]);
            assert_eq!(names_by_length(&names), strings(&probe[1]), "{names:?}");
            probes += 1;
            names
        })
        .collect();
    for probe in textroom["leadingName"].as_array().expect("leadingName") {
        let line = probe[0].as_str().expect("line");
        let list = usize::try_from(probe[1].as_u64().expect("list")).expect("usize");
        let names = names_by_length(&lists[list]);
        let actual = leading_name(line, &names).map_or(
            Value::Null,
            |hit| json!({ "name": hit.name, "rest": hit.rest }),
        );
        assert_eq!(actual, probe[2], "{line:?}{STALE}");
        probes += 1;
    }
    for probe in textroom["refuseLossyText"]
        .as_array()
        .expect("refuseLossyText")
    {
        let text = probe[0].as_str().expect("text");
        let actual = refuse_lossy_text(text, "Ongame").map_or_else(
            |skip| json!({ "skip": [skip.reason.as_str(), skip.message] }),
            |()| Value::Null,
        );
        assert_eq!(actual, probe[1], "{text:?}");
        probes += 1;
    }
    for probe in textroom["currencySymbolOf"]
        .as_array()
        .expect("currencySymbolOf")
    {
        let token = probe[0].as_str().expect("token");
        assert_eq!(
            Some(currency_symbol_of(token)),
            probe[1].as_str(),
            "{token:?}"
        );
        probes += 1;
    }
    assert!(probes > 75, "{probes}");
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
#[allow(clippy::too_many_lines)]
fn cases_match_the_typescript() {
    let cases = VECTORS["cases"].as_array().expect("cases");
    let defaults = ConvertOptions::default();
    let cash_only = ConvertOptions {
        cash_only: true,
        ..ConvertOptions::default()
    };
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut chunks: HashMap<String, Vec<String>> = HashMap::new();
    let mut problems = Vec::new();
    let mut hands: HashMap<&str, usize> = HashMap::new();
    let mut reasons: HashMap<String, usize> = HashMap::new();
    let mut unrepresentable = 0;
    let mut seats_beyond_u32 = 0;
    let alike = |expected: &Value, actual: &Value| {
        actual == expected
            || unrepresentable_alike(expected, actual)
            || beyond_u32(expected, actual)
    };
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
            let actual = outcome(id, &input, &defaults);
            if actual.get("hand").is_some() {
                *hands.entry(id).or_default() += 1;
            }
            if let Some(reason) = actual["skip"][0].as_str() {
                *reasons.entry(format!("{id}:{reason}")).or_default() += 1;
            }
            if actual != *expected {
                if unrepresentable_alike(expected, &actual) && actual.get("error").is_none() {
                    unrepresentable += 1;
                } else if alike(expected, &actual) {
                    seats_beyond_u32 += 1;
                }
            }
            if !alike(expected, &actual) {
                problems.push(format!("{label}: {id} expected {expected}, got {actual}"));
            }

            let expected_cash = case["cashOnly"].get(id).unwrap_or(expected);
            let actual_cash = outcome(id, &input, &cash_only);
            if let Some(reason) = actual_cash["skip"][0].as_str() {
                *reasons.entry(format!("{id}:{reason}")).or_default() += 1;
            }
            if !alike(expected_cash, &actual_cash) {
                problems.push(format!(
                    "{label}: {id} cashOnly expected {expected_cash}, got {actual_cash}"
                ));
            }
        }
    }
    let shown: Vec<_> = problems.iter().take(MAX_REPORTED).cloned().collect();
    assert!(
        problems.is_empty(),
        "{} of {} cases differ{STALE}:\n{}",
        problems.len(),
        cases.len(),
        shown.join("\n")
    );
    if committed() {
        assert!(
            cases.len() > 4500
                && hands.get("ongame") > Some(&900)
                && hands.get("entraction") > Some(&900)
                && hands.get("unibet") > Some(&600),
            "{} cases, {hands:?} hands",
            cases.len()
        );
        // Every refusal reason the three parsers throw, reached.
        for reason in [
            "ongame:no-header",
            "ongame:unsupported-hi-lo",
            "ongame:unsupported-variant",
            "ongame:play-money",
            "ongame:no-players",
            "ongame:no-winner",
            "ongame:board-size",
            "ongame:ambiguous-amount",
            "ongame:too-few-players",
            "ongame:inconsistent-pot",
            "entraction:lossy-encoding",
            "entraction:no-header",
            "entraction:unsupported-hi-lo",
            "entraction:unsupported-variant",
            "entraction:no-players",
            "entraction:no-winner",
            "entraction:board-size",
            "entraction:ambiguous-amount",
            "entraction:too-few-players",
            "entraction:inconsistent-pot",
            "unibet:lossy-encoding",
            "unibet:tournament-summary",
            "unibet:no-header",
            "unibet:unsupported-hi-lo",
            "unibet:unsupported-variant",
            "unibet:tournament-in-cash-mode",
            "unibet:no-players",
            "unibet:no-currency",
            "unibet:ambiguous-amount",
            "unibet:cashout",
            "unibet:no-winner",
            "unibet:board-size",
            "unibet:too-few-players",
            "unibet:inconsistent-pot",
        ] {
            assert!(
                reasons.contains_key(reason),
                "{reason} not reached: {reasons:?}"
            );
        }
    }
    println!(
        "{} cases, {hands:?} hands; {unrepresentable} hands with a number beyond 2^53 in \
         both, {seats_beyond_u32} with a seat, size or button beyond u32 (not reproducible)",
        cases.len()
    );
    // Twenty-digit amounts and seats: kept few, and counted.
    assert!(
        (unrepresentable + seats_beyond_u32) * 50 < cases.len(),
        "{unrepresentable} unrepresentable, {seats_beyond_u32} beyond u32"
    );
}

/* -------------------------------------------------------------------- files */

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
        "cp1252" => cp1252(text),
        "utf8-crlf" => text.replace('\n', "\r\n").into_bytes(),
        "utf8-bom" => [vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat(),
        other => panic!("unknown transform {other}"),
    }
}

/// Windows-1252 bytes (`?` for what it cannot hold).
fn cp1252(text: &str) -> Vec<u8> {
    const HIGH: &str = "\u{20ac}\u{81}\u{201a}\u{192}\u{201e}\u{2026}\u{2020}\u{2021}\u{2c6}\u{2030}\u{160}\u{2039}\u{152}\u{8d}\u{17d}\u{8f}\u{90}\u{2018}\u{2019}\u{201c}\u{201d}\u{2022}\u{2013}\u{2014}\u{2dc}\u{2122}\u{161}\u{203a}\u{153}\u{9d}\u{17e}\u{178}";
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
        entries.len() >= 180 && hands > 250,
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
