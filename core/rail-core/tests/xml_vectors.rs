//! The iPoker and MicroGaming parsers, their XML reader and the text-room
//! helpers against the TypeScript beyond the corpus (docs/RAIL-PLAN.md
//! R0.9): the vectors in `tests/data/xml-vectors.json`, written by
//! `xml-vectors.mjs` next to it, which runs the TypeScript.
//!
//! 1. **Reader**: `scanXml` of hand-written documents (tree, `null` or the
//!    message thrown) and `decodeEntities` of hand-written values -
//!    `Object.prototype` entity names, references beyond U+10FFFF, surrogate
//!    pairs and lone surrogates, CDATA, comments, declarations, quotes.
//! 2. **Text-room helpers**: `decodeBase64Utf16` (`atob`'s forgiving decode)
//!    and `strictAmount` probes.
//! 3. **Splits** of every corpus file and of edge texts; **detection**
//!    probes.
//! 4. **Cases**: seeded edits of every corpus chunk of both rooms (attribute
//!    values from per-attribute catalogues, attributes and elements deleted,
//!    duplicated, moved or inserted, element text, entity and character
//!    references, CDATA, comments, case and quote changes, truncation, CRLF,
//!    one line, U+2028, a BOM), each through both parsers: detection and
//!    outcome.
//! 5. **Files**: the corpus files of both rooms re-encoded (UTF-16 LE with
//!    and without a BOM, UTF-16 BE, Windows-1252, CRLF) through
//!    `rail_core::convert`.
//!
//! Where the TypeScript holds a lone surrogate (`&#xD800;`, a Base64 name
//! decoding to half a pair) Rust may answer `parser-error` instead
//! (`p2_xml::unrepresentable_outcome`); such cases are marked `lone` by the
//! generator and counted. Needs no `testdata/golden-full/`.

mod golden;

use std::collections::HashMap;
use std::sync::LazyLock;

use rail_core::canonical::{CanonicalJsonError, to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::js::{JsNumber, LoneSurrogate};
use rail_core::parsers::ipoker::IPokerParser;
use rail_core::parsers::microgaming::MicroGamingParser;
use rail_core::parsers::shared::p2_xml::{DecodeError, XmlElement, decode_entities, scan_xml};
use rail_core::parsers::shared::p4_textroom::{decode_base64_utf16_lossy, strict_amount};
use rail_core::phf::money::{EUR, USD};
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let text = include_str!("data/xml-vectors.json");
    serde_json::from_str(text).expect("xml-vectors.json")
});

const MAX_REPORTED: usize = 20;
const IDS: [&str; 2] = ["ipoker", "microgaming"];

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/xml-vectors.mjs`)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "ipoker" => &IPokerParser,
        "microgaming" => &MicroGamingParser,
        other => panic!("no parser {other}"),
    }
}

fn path_of(path: &str) -> std::path::PathBuf {
    path.split('/')
        .fold(golden::root(), |dir, part| dir.join(part))
}

fn decoded(path: &str) -> String {
    let bytes = std::fs::read(path_of(path)).unwrap_or_else(|e| panic!("read {path}: {e}"));
    decode_source(&bytes).text
}

fn text_of(value: &Value) -> &str {
    value.as_str().expect("text")
}

/// The tree as the generator writes it: attributes as `[name, value]`
/// pairs, the last of a name winning, sorted by UTF-16 code units.
fn tree_json(element: &XmlElement) -> Value {
    let mut attrs: Vec<(&str, &str)> = Vec::new();
    for (name, value) in &element.attrs {
        if let Some(entry) = attrs.iter_mut().find(|(n, _)| n == name) {
            entry.1 = value;
        } else {
            attrs.push((name, value));
        }
    }
    attrs.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    json!({
        "tag": element.tag,
        "attrs": attrs.iter().map(|(n, v)| json!([n, v])).collect::<Vec<_>>(),
        "children": element.children.iter().map(tree_json).collect::<Vec<_>>(),
        "text": element.text,
    })
}

#[test]
fn the_reader_scans_and_decodes_as_the_typescript_does() {
    let mut problems = Vec::new();
    let scans = VECTORS["scan"].as_array().expect("scan");
    for case in scans {
        let text = text_of(&case["text"]);
        let actual = match scan_xml(text) {
            Ok(document) => json!({
                "text": text,
                "tree": document.root.as_ref().map_or(Value::Null, tree_json),
                "lone": document.lone_surrogates,
            }),
            Err(message) => json!({ "text": text, "thrown": message }),
        };
        if actual != *case {
            problems.push(format!("scan: expected {case}, got {actual}"));
        }
    }
    let decodes = VECTORS["decode"].as_array().expect("decode");
    for case in decodes {
        let text = text_of(&case["text"]);
        let actual = match decode_entities(text) {
            Ok(out) => json!({ "text": text, "out": out }),
            Err(DecodeError::LoneSurrogate(out)) => json!({ "text": text, "lone": out }),
            Err(DecodeError::Thrown(message)) => json!({ "text": text, "thrown": message }),
        };
        if actual != *case {
            problems.push(format!("decode: expected {case}, got {actual}"));
        }
    }
    assert!(scans.len() > 50 && decodes.len() > 40);
    assert!(
        problems.is_empty(),
        "{} differ{STALE}:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn the_text_room_helpers_answer_as_the_typescript_does() {
    let mut problems = Vec::new();
    for case in VECTORS["base64"].as_array().expect("base64") {
        let text = text_of(&case["text"]);
        let (out, lone) = decode_base64_utf16_lossy(text);
        let actual = if lone {
            json!({ "text": text, "lone": out })
        } else {
            json!({ "text": text, "out": out })
        };
        if actual != *case {
            problems.push(format!("base64: expected {case}, got {actual}"));
        }
    }
    for case in VECTORS["strict"].as_array().expect("strict") {
        let text = text_of(&case["text"]);
        let name = text_of(&case["unit"]);
        let unit = if name == "EUR" {
            EUR.unit()
        } else {
            USD.unit()
        };
        let actual = match strict_amount(text, &unit, "a probe") {
            Ok(amount) => json!({ "unit": name, "text": text, "amount": amount.to_js_string() }),
            Err(skip) => {
                json!({ "unit": name, "text": text, "refused": [skip.reason.as_str(), skip.message] })
            }
        };
        if actual != *case {
            problems.push(format!("strict: expected {case}, got {actual}"));
        }
    }
    assert!(
        problems.is_empty(),
        "{} differ{STALE}:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

fn split_hash(id: &str, text: &str) -> String {
    let chunks = parser(id).split_hands(text).expect("split");
    short(&serde_json::to_string(&chunks).expect("json"))
}

#[test]
fn splits_match_the_typescript() {
    let splits = VECTORS["splits"].as_array().expect("splits");
    let mut problems = Vec::new();
    for case in splits {
        let text = match (case.get("file"), case.get("text")) {
            (Some(file), _) => decoded(text_of(file)),
            (_, Some(text)) => text_of(text).to_owned(),
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
        let text = text_of(&case["text"]);
        for id in IDS {
            assert_eq!(
                Some(u64::from(parser(id).detect(text))),
                case[id].as_u64(),
                "{id} on {text:?}{STALE}"
            );
        }
    }
}

/// A case's edits, applied as the generator applies them: splices by
/// UTF-16 index, or a whole-text line-ending change.
fn apply(chunk: &str, edits: &[Value]) -> String {
    let mut units: Vec<u16> = chunk.encode_utf16().collect();
    let replace = |units: &[u16], from: &str, to: &str| -> Vec<u16> {
        String::from_utf16(units)
            .expect("well formed")
            .replace(from, to)
            .encode_utf16()
            .collect()
    };
    for edit in edits {
        match edit {
            Value::String(name) => {
                units = match name.as_str() {
                    "crlf" => replace(&units, "\n", "\r\n"),
                    "oneline" => replace(&units, "\n", ""),
                    "ls" => replace(&units, "\n", "\u{2028}"),
                    "bom" => std::iter::once(0xFEFF).chain(units).collect(),
                    other => panic!("unknown edit {other}"),
                };
            }
            Value::Array(splice) => {
                let index = |v: &Value| usize::try_from(v.as_u64().expect("index")).expect("usize");
                let at = index(&splice[0]).min(units.len());
                let end = (at + index(&splice[1])).min(units.len());
                let insert: Vec<u16> = text_of(&splice[2]).encode_utf16().collect();
                units.splice(at..end, insert);
            }
            other => panic!("unknown edit {other}"),
        }
    }
    String::from_utf16(&units).expect("edits keep the text well formed")
}

/// `parseHand`'s outcome in the vectors' shape; a hand no PHF can hold is
/// `{ unrepresentable: path }`.
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

/// Where the TypeScript's hand has a number beyond 2^53 (its canonical JSON
/// throws): Rust's hand is unrepresentable at the same path, or - for a
/// seat number beyond `u32` - Rust refuses it as a `parser-error`.
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
        || ([".seat", ".buttonSeat", ".maxSeats", ".fromSeat"]
            .iter()
            .any(|field| path.ends_with(field))
            && actual["error"]
                .as_str()
                .is_some_and(|m| m.contains("is beyond what a PHF hand can hold (u32)")))
}

/// A seat, table size or button between 2^32 and 2^53 (`seat="99999999999"`):
/// the TypeScript's hand holds it and its JSON is fine, a PHF seat is `u32`
/// here (R0.6's rule) - Rust's `parser-error`. Not reproducible, counted.
fn beyond_u32(expected: &Value, actual: &Value) -> bool {
    expected.get("hand").is_some()
        && actual["error"]
            .as_str()
            .is_some_and(|m| m.contains("is beyond what a PHF hand can hold (u32)"))
}

#[test]
fn cases_match_the_typescript() {
    let cases = VECTORS["cases"].as_array().expect("cases");
    let lone_message = LoneSurrogate.to_string();
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut chunks: HashMap<String, Vec<String>> = HashMap::new();
    let mut problems = Vec::new();
    let mut hands: HashMap<&str, usize> = HashMap::new();
    let (mut unrepresentable, mut lone) = (0, 0);
    for case in cases {
        let file = text_of(&case["file"]);
        let split = text_of(&case["split"]);
        let index = usize::try_from(case["chunk"].as_u64().expect("chunk")).expect("usize");
        let text = texts
            .entry(file.to_owned())
            .or_insert_with(|| decoded(file))
            .clone();
        let chunk = chunks
            .entry(file.to_owned())
            .or_insert_with(|| parser(split).split_hands(&text).expect("split"))[index]
            .clone();
        let input = apply(&chunk, case["edits"].as_array().expect("edits"));
        let label = format!("{file}#{index} {}", case["edits"]);

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
            if case["lone"] == true && actual["error"].as_str() == Some(lone_message.as_str()) {
                lone += 1;
            } else if unrepresentable_alike(expected, &actual) || beyond_u32(expected, &actual) {
                unrepresentable += 1;
            } else if actual != *expected {
                problems.push(format!("{label}: {id} expected {expected}, got {actual}"));
            }
        }
    }
    assert!(
        cases.len() > 3000
            && hands.get("ipoker") > Some(&800)
            && hands.get("microgaming") > Some(&600),
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
    // Lone surrogates and twenty-digit amounts: kept few, and counted.
    println!(
        "{} cases x 2 parsers equal, {hands:?} hands; {unrepresentable} outcomes \
         unrepresentable alike, {lone} lone-surrogate outcomes answered `parser-error`",
        cases.len()
    );
    assert!(
        (unrepresentable + lone) * 50 < cases.len(),
        "{unrepresentable} unrepresentable, {lone} lone surrogates"
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
        "cp1252-pound" => cp1252(&text.replace('€', "£").replace("EUR", "GBP")),
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
        let file = text_of(&entry["file"]);
        let transform = text_of(&entry["transform"]);
        let text = decoded(file);
        let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
        let bytes = encode(text, transform);
        let name = file.rsplit('/').next().expect("name");
        let converted = rail_core::convert(&bytes, name);
        let label = format!("{file} {transform}");
        if converted.encoding.label() != text_of(&entry["encoding"]) {
            problems.push(format!("{label}: encoding {}", converted.encoding.label()));
        }
        if entry["problem"].as_str() != converted.problem.map(|p| p.as_str()) {
            problems.push(format!("{label}: decode problem {:?}", converted.problem));
            continue;
        }
        if converted.problem.is_some() {
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
        entries.len() > 150 && hands > 200,
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

/// `JsNumber` is what a strict amount comes back as (the fractional
/// `1.234,5.6` included); the probes above print it with `String(n)`.
#[test]
fn strict_amounts_are_javascript_numbers() {
    let amount = strict_amount("1.234,5.6", &USD.unit(), "x").expect("ok in TypeScript");
    assert_eq!(amount.to_js_string(), "183.45");
    assert!(!amount.is_integer());
    assert_eq!(
        strict_amount("-0", &USD.unit(), "x").map(JsNumber::is_sign_negative),
        Ok(true)
    );
}
