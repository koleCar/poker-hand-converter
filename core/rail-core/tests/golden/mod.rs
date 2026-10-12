//! The golden harness: runs the Rust pipeline over corpus files and diffs
//! the outcome against the TypeScript oracle (`testdata/golden/`,
//! docs/RAIL-PLAN.md R0.3, R0.5).
//!
//! A parser step checks its sites with one line:
//!
//! ```ignore
//! mod golden;
//! #[test]
//! fn pokerstars_family() {
//!     golden::check(golden::Selection::Parsers(&["pokerstars", "ggpoker"]));
//! }
//! ```
//!
//! For every committed golden whose `detected.top` is in the selection, the
//! harness reads the input (and fails if its bytes are not the ones the golden
//! was made from), runs [`rail_core::convert`] on it with the file name alone
//! (as the converter does) and builds the same document the emitter writes
//! (`tests/scripts/golden/emit.ts`): decode, detection ranking, chunk count,
//! hands (index, hand id, parser, sha-256 of the canonical PHF with
//! `parsedAt` pinned, warnings), refusals (index, stage, reason, message,
//! site, per-mille, parser version, fingerprint) and stats. The two documents
//! must be equal; a difference is reported by JSON path, and a PHF that
//! hashes differently is diffed line by line against its body in
//! `testdata/golden-full/` when that tree is present (`npm run golden:emit`).
//!
//! Two things are compared only once they can be:
//!
//! - **Standard text** (`standardText`, `standardTextFile`): the serializer
//!   is R0.6. Until [`SERIALIZER`] is set, those hashes are left out of both
//!   documents and counted as pending in the report - visibly, never silently.
//! - **Candidates of parsers not ported yet**: a golden's ranking can name
//!   parsers the Rust registry does not have; they are left out of the
//!   expected ranking and counted. Everything else in the ranking, the top
//!   included, must match.

#![allow(dead_code)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use rail_core::canonical::{to_canonical_json, value_to_canonical_json};
use rail_core::convert::{ConversionResult, FileConversion};
use rail_core::detect::{PINNED_PARSED_AT, SiteParser};
use rail_core::phf::PhfHand;
use rail_core::validate::ContextValue;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// The standard-text serializer, once ported (R0.6): one hand's text, and a
/// file's text (`toStandardText`, `toStandardTextFile`).
#[derive(Clone, Copy)]
pub struct Serializer {
    pub hand: fn(&PhfHand) -> String,
    pub file: fn(&[PhfHand]) -> String,
}

/// `None` until R0.6: standard-text hashes are pending, not compared.
pub const SERIALIZER: Option<Serializer> = None;

/// Which corpus files a check covers, by the golden's `detected.top`.
#[derive(Debug, Clone, Copy)]
pub enum Selection {
    /// Files no parser claims (`detected.top` is null): refused whole as
    /// `unknown-site` by the TypeScript.
    Unrecognised,
    /// Files whose top parser is one of these ids. Every id must be in the
    /// Rust registry.
    Parsers(&'static [&'static str]),
    /// Every corpus file.
    All,
}

/// What a check covered.
#[derive(Debug, Default)]
pub struct Report {
    pub files: usize,
    pub hands: usize,
    pub refusals: usize,
    /// `standardText` / `standardTextFile` hashes not compared (no serializer).
    pub pending_text_hashes: usize,
    /// Golden candidates left out because their parser is not ported.
    pub unported_candidates: usize,
}

/// Failures listed in full before the rest are only counted.
const MAX_REPORTED_FILES: usize = 20;
/// Differences listed per file.
const MAX_PATHS: usize = 12;

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// Every committed golden, as `(input path, document)`, in path order.
pub fn goldens() -> Vec<(String, Value)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                walk(base, &path, out);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let relative = path.strip_prefix(base).expect("below the golden root");
                let parts: Vec<_> = relative
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(parts.join("/"));
            }
        }
    }
    let dir = root().join("testdata/golden");
    let mut files = Vec::new();
    walk(&dir, &dir, &mut files);
    files.sort();
    assert!(!files.is_empty(), "no goldens under testdata/golden/");
    files
        .into_iter()
        .map(|file| {
            let text = fs::read_to_string(dir.join(&file))
                .unwrap_or_else(|e| panic!("read testdata/golden/{file}: {e}"));
            let doc: Value = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("parse testdata/golden/{file}: {e}"));
            let input = file
                .strip_suffix(".json")
                .expect("a .json golden")
                .to_owned();
            (input, doc)
        })
        .collect()
}

/// The input's bytes, checked against the golden's `input` record.
pub fn input_bytes(path: &str, golden: &Value) -> Vec<u8> {
    let full = path.split('/').fold(root(), |dir, part| dir.join(part));
    let bytes = fs::read(&full).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let expected_sha = golden["input"]["sha256"].as_str().unwrap_or_default();
    assert!(
        sha256_hex(&bytes) == expected_sha
            && golden["input"]["bytes"].as_u64() == u64::try_from(bytes.len()).ok(),
        "{path}: the input is not the file its golden was made from (did a checkout rewrite \
         line endings? the corpus is `-text` in .gitattributes), or the golden is stale"
    );
    bytes
}

fn selected(selection: Selection, golden: &Value) -> bool {
    let top = golden["detected"]["top"].as_str();
    match selection {
        Selection::All => true,
        Selection::Unrecognised => top.is_none(),
        Selection::Parsers(ids) => top.is_some_and(|top| ids.contains(&top)),
    }
}

fn context_value(value: &ContextValue) -> Value {
    match value {
        ContextValue::Text(text) => Value::from(text.as_str()),
        ContextValue::Integer(n) => Value::from(*n),
    }
}

/// The hand as the goldens hash it: `meta.parsedAt` pinned.
fn pinned(hand: &PhfHand) -> PhfHand {
    let mut hand = hand.clone();
    hand.meta.parsed_at = PINNED_PARSED_AT.to_owned();
    hand
}

/// The Rust outcome in the shape of a committed golden.
fn document(path: &str, bytes: &[u8], file: &FileConversion) -> Value {
    let input = json!({
        "bytes": bytes.len(),
        "path": path,
        "sha256": sha256_hex(bytes),
    });
    let decode = json!({
        "encoding": file.encoding.label(),
        "problem": file.problem.map(|p| p.as_str()),
    });
    let Some(result) = &file.result else {
        return json!({
            "chunks": 0,
            "decode": decode,
            "detected": null,
            "format": "rail-golden/1",
            "hands": [],
            "input": input,
            "refusals": [],
            "standardTextFile": null,
            "stats": null,
        });
    };
    // `convertAny` threw: the emitter would have failed, so no golden can
    // match this; say what was thrown.
    let result = match result {
        Ok(result) => result,
        Err(thrown) => return json!({ "input": input, "thrown": thrown.message }),
    };
    let candidates: Vec<Value> = file
        .detected
        .iter()
        .map(|c| json!({ "parser": c.parser, "permille": c.permille }))
        .collect();
    let hands: Vec<Value> = result
        .hands
        .iter()
        .map(|converted| {
            let hand = &converted.hand;
            let phf = to_canonical_json(&pinned(hand)).unwrap_or_else(|e| {
                panic!(
                    "{path}: hand {} has no canonical form: {e}",
                    hand.meta.hand_id
                )
            });
            let warnings: Vec<Value> = converted
                .report
                .iter()
                .flat_map(|report| report.warnings())
                .map(|w| {
                    let mut warning = Map::new();
                    warning.insert("code".into(), Value::from(w.code.as_str()));
                    if let Some(context) = &w.context {
                        let context: Map<String, Value> = context
                            .iter()
                            .map(|(key, value)| (key.clone(), context_value(value)))
                            .collect();
                        warning.insert("context".into(), Value::Object(context));
                    }
                    warning.insert("message".into(), Value::from(w.message.as_str()));
                    Value::Object(warning)
                })
                .collect();
            let standard_text = SERIALIZER.map(|s| sha256_hex((s.hand)(hand).as_bytes()));
            json!({
                "handId": hand.meta.hand_id,
                "index": converted.index,
                "parser": hand.meta.parser_id,
                "phf": sha256_hex(phf.as_bytes()),
                "standardText": standard_text,
                "warnings": warnings,
            })
        })
        .collect();
    let refusals: Vec<Value> = result
        .failures
        .iter()
        .map(|f| {
            json!({
                "fingerprint": f.fingerprint,
                "index": f.index,
                "message": f.message,
                "parserVersion": f.parser_version,
                "permille": f.detection_permille,
                "reason": f.reason.as_str(),
                "site": f.detected_site,
                "stage": f.stage.as_str(),
            })
        })
        .collect();
    let standard_text_file = match SERIALIZER {
        Some(s) if !result.hands.is_empty() => {
            let hands: Vec<PhfHand> = result.hands.iter().map(|h| h.hand.clone()).collect();
            Value::from(sha256_hex((s.file)(&hands).as_bytes()))
        }
        _ => Value::Null,
    };
    json!({
        "chunks": result.chunks,
        "decode": decode,
        "detected": {
            "candidates": candidates,
            "top": file.detected.first().map(|c| c.parser.as_str()),
        },
        "format": "rail-golden/1",
        "hands": hands,
        "input": input,
        "refusals": refusals,
        "standardTextFile": standard_text_file,
        "stats": stats(result),
    })
}

fn stats(result: &ConversionResult) -> Value {
    let by_site: Map<String, Value> = result
        .stats
        .by_site
        .iter()
        .map(|(site, count)| (site.clone(), Value::from(*count)))
        .collect();
    json!({
        "bySite": by_site,
        "converted": result.stats.converted,
        "failed": result.stats.failed,
        "total": result.stats.total,
    })
}

/// Makes the pending comparisons explicit: drops the standard-text hashes
/// from both documents when there is no serializer, and the candidates of
/// unported parsers from the expected one.
fn align(expected: &mut Value, actual: &mut Value, report: &mut Report) {
    if SERIALIZER.is_none() {
        for doc in [&mut *expected, &mut *actual] {
            if let Some(hands) = doc["hands"].as_array_mut() {
                for hand in hands {
                    if let Some(hand) = hand.as_object_mut()
                        && hand.remove("standardText").is_some_and(|v| !v.is_null())
                    {
                        report.pending_text_hashes += 1;
                    }
                }
            }
            if let Some(doc) = doc.as_object_mut()
                && doc.remove("standardTextFile").is_some_and(|v| !v.is_null())
            {
                report.pending_text_hashes += 1;
            }
        }
    }
    let registry = rail_core::parsers::builtin();
    if let Some(candidates) = expected["detected"]["candidates"].as_array_mut() {
        let before = candidates.len();
        candidates.retain(|c| {
            c["parser"]
                .as_str()
                .is_some_and(|id| registry.get(id).is_some())
        });
        report.unported_candidates += before - candidates.len();
    }
}

/// Differences between two JSON values, as `path: expected → actual`.
fn differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    if out.len() >= MAX_PATHS || expected == actual {
        return;
    }
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            let mut keys: Vec<&String> = e.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let (e, a) = (
                    e.get(key).unwrap_or(&Value::Null),
                    a.get(key).unwrap_or(&Value::Null),
                );
                differences(&format!("{path}.{key}"), e, a, out);
            }
        }
        (Value::Array(e), Value::Array(a)) if e.len() == a.len() => {
            for (i, (e, a)) in e.iter().zip(a).enumerate() {
                differences(&format!("{path}[{i}]"), e, a, out);
            }
        }
        (Value::Array(e), Value::Array(a)) => {
            out.push(format!(
                "{path}: {} entries expected, {} found",
                e.len(),
                a.len()
            ));
            for (i, (e, a)) in e.iter().zip(a).enumerate() {
                differences(&format!("{path}[{i}]"), e, a, out);
            }
        }
        _ => out.push(format!("{path}: expected {expected}, got {actual}")),
    }
}

/// For a hand whose PHF hash differs: the first line where the Rust PHF and
/// the golden-full body part, if the full tree is there.
fn phf_detail(path: &str, index: usize, result: &ConversionResult) -> Option<String> {
    let full = root()
        .join("testdata/golden-full")
        .join(format!("{path}.json"));
    let doc: Value = serde_json::from_str(&fs::read_to_string(full).ok()?).ok()?;
    let body = doc["hands"].get(index)?.get("phf")?.clone();
    let expected = value_to_canonical_json(body).ok()?;
    let actual = to_canonical_json(&pinned(&result.hands.get(index)?.hand)).ok()?;
    let line = expected
        .lines()
        .zip(actual.lines())
        .enumerate()
        .find(|(_, (e, a))| e != a)
        .map_or_else(
            || "lengths differ".to_owned(),
            |(n, (e, a))| format!("line {}: expected {e:?}, got {a:?}", n + 1),
        );
    Some(format!("hands[{index}].phf: {line}"))
}

/// Runs one corpus file through the Rust pipeline and compares it with
/// `golden`: `Ok` when equal, else the differences (JSON paths, and PHF line
/// diffs where `testdata/golden-full/` has the body).
pub fn compare_file(path: &str, golden: Value, report: &mut Report) -> Result<(), Vec<String>> {
    let bytes = input_bytes(path, &golden);
    let name = path.rsplit('/').next().unwrap_or(path);
    let file = rail_core::convert(&bytes, name);
    let mut actual = document(path, &bytes, &file);
    let mut expected = golden;
    align(&mut expected, &mut actual, report);
    report.files += 1;
    report.hands += expected["hands"].as_array().map_or(0, Vec::len);
    report.refusals += expected["refusals"].as_array().map_or(0, Vec::len);
    if expected == actual {
        return Ok(());
    }
    let mut paths = Vec::new();
    differences("$", &expected, &actual, &mut paths);
    if let Some(Ok(result)) = &file.result {
        let hands = expected["hands"].as_array().map_or(0, Vec::len);
        for i in 0..hands {
            if expected["hands"][i]["phf"] != actual["hands"][i]["phf"]
                && let Some(detail) = phf_detail(path, i, result)
            {
                paths.push(detail);
            }
        }
    }
    Err(paths)
}

/// Runs the selection and panics with a report of every file that differs.
pub fn check(selection: Selection) -> Report {
    let registry = rail_core::parsers::builtin();
    if let Selection::Parsers(ids) = selection {
        for id in ids {
            assert!(
                registry.get(id).is_some(),
                "parser {id:?} is not in the Rust registry"
            );
        }
    }
    let mut report = Report::default();
    let mut failures: Vec<String> = Vec::new();
    for (path, golden) in goldens() {
        if !selected(selection, &golden) {
            continue;
        }
        if let Err(paths) = compare_file(&path, golden, &mut report) {
            failures.push(format!("{path}:\n    {}", paths.join("\n    ")));
        }
    }
    assert!(report.files > 0, "{selection:?} selects no corpus file");
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(MAX_REPORTED_FILES).cloned().collect();
        panic!(
            "{} of {} files differ from their goldens ({selection:?}):\n{}{}",
            failures.len(),
            report.files,
            shown.join("\n"),
            if failures.len() > MAX_REPORTED_FILES {
                format!("\n... and {} more", failures.len() - MAX_REPORTED_FILES)
            } else {
                String::new()
            }
        );
    }
    println!(
        "{selection:?}: {} files, {} hands, {} refusals match their goldens; {} standard-text \
         hashes pending (R0.6), {} candidates of unported parsers left out",
        report.files,
        report.hands,
        report.refusals,
        report.pending_text_hashes,
        report.unported_candidates
    );
    report
}

/// Ids of the parsers the Rust registry has.
pub fn ported_parsers() -> Vec<&'static str> {
    rail_core::parsers::builtin()
        .parsers()
        .map(SiteParser::id)
        .collect()
}
