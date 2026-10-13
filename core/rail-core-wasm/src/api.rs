//! The facade's logic, in plain Rust: strings and bytes in, JSON text out.
//!
//! Everything [`crate`] exports to JavaScript is one of these functions behind
//! a `#[wasm_bindgen]` shim, so this module is what the native tests and
//! clippy see, and it is `unsafe`-free by `forbid`.
//!
//! **Why JSON text.** A PHF hand is ~9 KB of nested objects; building it as
//! JS objects through `serde-wasm-bindgen` crosses the boundary once per
//! field and turns `i64` amounts into `BigInt` or lossy numbers. One
//! `serde_json` string crosses once, `JSON.parse` is the fastest object
//! builder JavaScript has, and every amount the canonical form allows (safe
//! integers only) parses back exactly. With `digests` the result also
//! carries the sha-256 of each hand's canonical JSON as **Rust** writes it,
//! so a caller can prove byte identity with the native core and the goldens
//! without trusting its own canonicaliser.
//!
//! The JSON shapes are declared for TypeScript in `../js/index.ts`; field
//! names are camelCase, like PHF's.

#![forbid(unsafe_code)]

use std::fmt::Write as _;

use rail_core::FileConversion;
use rail_core::canonical::to_canonical_json;
use rail_core::convert::{ConversionResult, convert_file};
use rail_core::decode::decode_source;
use rail_core::detect::ConvertOptions;
use rail_core::phf::PhfHand;
use rail_core::phf::serialize::{to_standard_text, to_standard_text_file};
use rail_core::unrecognized::Unrecognized;
use rail_core::validate::{ContextValue, ValidationProblem};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The version tag of [`convert`]'s document. Bumped when its shape changes.
pub const CONVERT_FORMAT: &str = "rail-convert/1";

/// `convert`'s options, as JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    /// The ISO timestamp stamped on every hand's `meta.parsedAt`. Required:
    /// the core has no clock (the goldens use `1970-01-01T00:00:00.000Z`).
    pub parsed_at: String,
    /// Force a parser instead of detecting one.
    #[serde(default)]
    pub site_id: Option<String>,
    #[serde(default)]
    pub cash_only: bool,
    #[serde(default)]
    pub skip_bomb_pots: bool,
    /// Run the validator; default `true`, as the converter does.
    #[serde(default = "yes")]
    pub validate: bool,
    /// Write each hand's standard text and the file's; default `true`.
    #[serde(default = "yes")]
    pub standard_text: bool,
    /// Add the sha-256 of each hand's canonical JSON; default `false`.
    #[serde(default)]
    pub digests: bool,
}

const fn yes() -> bool {
    true
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

#[derive(Serialize)]
struct Decode {
    encoding: &'static str,
    problem: Option<&'static str>,
}

#[derive(Serialize)]
struct Candidate<'a> {
    parser: &'a str,
    permille: u32,
}

#[derive(Serialize)]
struct Detected<'a> {
    top: Option<&'a str>,
    candidates: Vec<Candidate<'a>>,
}

/// A validator problem's `context`, in the order the validator built it.
struct Context<'a>(&'a [(String, ContextValue)]);

impl Serialize for Context<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in self.0 {
            match value {
                ContextValue::Text(text) => map.serialize_entry(key, text)?,
                ContextValue::Integer(n) => map.serialize_entry(key, n)?,
            }
        }
        map.end()
    }
}

#[derive(Serialize)]
struct Warning<'a> {
    code: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<Context<'a>>,
    message: &'a str,
}

impl<'a> From<&'a ValidationProblem> for Warning<'a> {
    fn from(problem: &'a ValidationProblem) -> Self {
        Self {
            code: &problem.code,
            context: problem.context.as_deref().map(Context),
            message: &problem.message,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hand<'a> {
    index: u32,
    hand_id: &'a str,
    parser: &'a str,
    phf: &'a PhfHand,
    /// sha-256 of the canonical JSON; `null` unless `digests` was asked for.
    phf_sha256: Option<String>,
    standard_text: Option<String>,
    warnings: Vec<Warning<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Refusal<'a> {
    index: Option<u32>,
    stage: &'a str,
    reason: &'a str,
    message: &'a str,
    site: Option<&'a str>,
    permille: Option<u32>,
    parser_version: &'a str,
    fingerprint: &'a str,
    raw_text: &'a str,
    source_filename: Option<&'a str>,
}

/// `ConversionResult.stats`, `bySite` in first-seen order.
struct BySite<'a>(&'a [(String, u32)]);

impl Serialize for BySite<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (site, count) in self.0 {
            map.serialize_entry(site, count)?;
        }
        map.end()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats<'a> {
    total: u32,
    converted: u32,
    failed: u32,
    by_site: BySite<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a> {
    fingerprint: &'a str,
    header_sample: &'a str,
    guessed_site: Option<&'a str>,
    confidence: u32,
    guess_basis: Option<&'static str>,
    shape: &'static str,
}

impl<'a> From<&'a Unrecognized> for Record<'a> {
    fn from(record: &'a Unrecognized) -> Self {
        Self {
            fingerprint: &record.fingerprint,
            header_sample: &record.header_sample,
            guessed_site: record.guessed_site.as_deref(),
            confidence: record.confidence,
            guess_basis: record.guess_basis.map(|basis| basis.as_str()),
            shape: record.shape.as_str(),
        }
    }
}

/// [`convert`]'s document.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Document<'a> {
    format: &'static str,
    decode: Decode,
    /// `null` when the bytes are not text (`decode.problem`).
    detected: Option<Detected<'a>>,
    chunks: u32,
    hands: Vec<Hand<'a>>,
    refusals: Vec<Refusal<'a>>,
    /// `null` when the bytes are not text or the pipeline threw.
    stats: Option<Stats<'a>>,
    standard_text_file: Option<String>,
    unrecognized: Option<Record<'a>>,
    /// What `convertAny` would have thrown (a validator meeting a card it
    /// cannot read); then there are no hands, refusals or stats.
    thrown: Option<&'a str>,
}

fn decode_of(file: &FileConversion) -> Decode {
    Decode {
        encoding: file.encoding.label(),
        problem: file.problem.map(|problem| problem.as_str()),
    }
}

fn detected_of(file: &FileConversion) -> Detected<'_> {
    Detected {
        top: file.detected.first().map(|c| c.parser.as_str()),
        candidates: file
            .detected
            .iter()
            .map(|c| Candidate {
                parser: &c.parser,
                permille: c.permille,
            })
            .collect(),
    }
}

fn hands_of<'a>(result: &'a ConversionResult, options: &Options) -> Result<Vec<Hand<'a>>, String> {
    result
        .hands
        .iter()
        .map(|converted| {
            let hand = &converted.hand;
            let phf_sha256 = if options.digests {
                let canonical = to_canonical_json(hand).map_err(|error| {
                    format!("hand {} has no canonical form: {error}", hand.meta.hand_id)
                })?;
                Some(sha256_hex(canonical.as_bytes()))
            } else {
                None
            };
            Ok(Hand {
                index: converted.index,
                hand_id: &hand.meta.hand_id,
                parser: &hand.meta.parser_id,
                phf: hand,
                phf_sha256,
                standard_text: options.standard_text.then(|| to_standard_text(hand)),
                warnings: converted
                    .report
                    .iter()
                    .flat_map(|report| report.warnings())
                    .map(Warning::from)
                    .collect(),
            })
        })
        .collect()
}

fn refusals_of(result: &ConversionResult) -> Vec<Refusal<'_>> {
    result
        .failures
        .iter()
        .map(|f| Refusal {
            index: f.index,
            stage: f.stage.as_str(),
            reason: f.reason.as_str(),
            message: &f.message,
            site: f.detected_site.as_deref(),
            permille: f.detection_permille,
            parser_version: &f.parser_version,
            fingerprint: &f.fingerprint,
            raw_text: &f.raw_text,
            source_filename: f.source_filename.as_deref(),
        })
        .collect()
}

/// One file through the pipeline: `bytes` as dropped, `filename` without a
/// directory, `options` as JSON ([`Options`]). The document is described by
/// `ConvertResult` in `../js/index.ts`; `Err` is a message for bad options or
/// a hand without a canonical form (only with `digests`).
pub fn convert(bytes: &[u8], filename: &str, options: &str) -> Result<String, String> {
    let options: Options =
        serde_json::from_str(options).map_err(|error| format!("convert options: {error}"))?;
    let core_options = ConvertOptions {
        source_filename: Some(filename.to_owned()),
        cash_only: options.cash_only,
        skip_bomb_pots: options.skip_bomb_pots,
        validate: options.validate,
        site_id: options.site_id.clone(),
        parsed_at: options.parsed_at.clone(),
    };
    let file = convert_file(bytes, &core_options);
    let mut document = Document {
        format: CONVERT_FORMAT,
        decode: decode_of(&file),
        detected: None,
        chunks: 0,
        hands: Vec::new(),
        refusals: Vec::new(),
        stats: None,
        standard_text_file: None,
        unrecognized: None,
        thrown: None,
    };
    if let Some(result) = &file.result {
        document.detected = Some(detected_of(&file));
        document.unrecognized = file.unrecognized.as_ref().map(Record::from);
        match result {
            Err(thrown) => document.thrown = Some(&thrown.message),
            Ok(result) => {
                document.chunks = result.chunks;
                document.hands = hands_of(result, &options)?;
                document.refusals = refusals_of(result);
                document.stats = Some(Stats {
                    total: result.stats.total,
                    converted: result.stats.converted,
                    failed: result.stats.failed,
                    by_site: BySite(&result.stats.by_site),
                });
                if options.standard_text && !result.hands.is_empty() {
                    let hands: Vec<PhfHand> = result.hands.iter().map(|h| h.hand.clone()).collect();
                    document.standard_text_file = Some(to_standard_text_file(&hands));
                }
            }
        }
    }
    serde_json::to_string(&document).map_err(|error| format!("convert: {error}"))
}

#[derive(Serialize)]
struct Detection<'a> {
    decode: Decode,
    detected: Option<Detected<'a>>,
}

/// Decoding and the detection ranking of a whole file, without parsing it:
/// `{ decode, detected }`, `detected` `null` when the bytes are not text.
pub fn detect(bytes: &[u8]) -> String {
    let decoded = decode_source(bytes);
    let registry = rail_core::parsers::builtin();
    let candidates = if decoded.problem.is_none() {
        registry.detect_site(&decoded.text)
    } else {
        Vec::new()
    };
    let detection = Detection {
        decode: Decode {
            encoding: decoded.encoding.label(),
            problem: decoded.problem.map(|problem| problem.as_str()),
        },
        detected: decoded.problem.is_none().then(|| Detected {
            top: candidates.first().map(|c| c.parser.id()),
            candidates: candidates
                .iter()
                .map(|c| Candidate {
                    parser: c.parser.id(),
                    permille: c.permille,
                })
                .collect(),
        }),
    };
    serde_json::to_string(&detection).unwrap_or_default()
}

/// The standard text of PHF JSON: one hand (`toStandardText`) or an array of
/// hands (`toStandardTextFile`, what the converter's "Download" writes).
/// `Err` when the JSON is not PHF - the model is strict both ways.
pub fn serialize(phf: &str) -> Result<String, String> {
    if phf.trim_start().starts_with('[') {
        let hands: Vec<PhfHand> =
            serde_json::from_str(phf).map_err(|error| format!("serialize: {error}"))?;
        Ok(to_standard_text_file(&hands))
    } else {
        let hand: PhfHand =
            serde_json::from_str(phf).map_err(|error| format!("serialize: {error}"))?;
        Ok(to_standard_text(&hand))
    }
}

#[derive(Serialize)]
struct Sample<'a> {
    decode: Decode,
    text: &'a str,
    truncated: bool,
    names: usize,
}

/// The shareable sample of a file (R0.11, `rail_core::anonymise`): player
/// names replaced, amounts and layout kept, cut at 64 KiB.
/// `{ decode, text, truncated, names }`; `text` is empty when the bytes are
/// not text.
pub fn anonymise(bytes: &[u8]) -> String {
    let decoded = decode_source(bytes);
    let sample = rail_core::anonymise::shareable_sample(&decoded.text);
    serde_json::to_string(&Sample {
        decode: Decode {
            encoding: decoded.encoding.label(),
            problem: decoded.problem.map(|problem| problem.as_str()),
        },
        text: &sample.text,
        truncated: sample.truncated,
        names: sample.names(),
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rail_core::detect::PINNED_PARSED_AT;
    use serde_json::Value;

    const POKERSTARS: &str = "../../fixtures/samples/pokerstars/";

    fn options(extra: &str) -> String {
        format!("{{\"parsedAt\":\"{PINNED_PARSED_AT}\"{extra}}}")
    }

    fn corpus_file(dir: &str) -> (Vec<u8>, String) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .expect("the PokerStars samples")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
            .collect();
        entries.sort();
        let path = entries.first().expect("a PokerStars sample").clone();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        (std::fs::read(&path).expect("readable"), name)
    }

    #[test]
    fn convert_matches_the_native_pipeline() {
        let (bytes, name) = corpus_file(POKERSTARS);
        let json = convert(&bytes, &name, &options(",\"digests\":true")).expect("converts");
        let doc: Value = serde_json::from_str(&json).expect("JSON");
        let native = rail_core::convert(&bytes, &name);
        let Some(Ok(result)) = &native.result else {
            panic!("the sample converts natively");
        };
        assert_eq!(doc["format"], CONVERT_FORMAT);
        assert!(!result.hands.is_empty());
        let hands = doc["hands"].as_array().expect("hands");
        assert_eq!(hands.len(), result.hands.len());
        for (hand, native) in hands.iter().zip(&result.hands) {
            // The embedded PHF is the native hand, and its digest is over the
            // native canonical bytes.
            let back: PhfHand = serde_json::from_value(hand["phf"].clone()).expect("PHF");
            assert_eq!(back, native.hand);
            let canonical = to_canonical_json(&native.hand).expect("canonical");
            assert_eq!(hand["phfSha256"], sha256_hex(canonical.as_bytes()));
            assert_eq!(hand["standardText"], to_standard_text(&native.hand));
        }
        assert_eq!(doc["detected"]["top"], "pokerstars");
        assert_eq!(doc["unrecognized"], Value::Null);
        assert_eq!(doc["thrown"], Value::Null);
    }

    #[test]
    fn parsed_at_comes_from_the_caller() {
        let (bytes, name) = corpus_file(POKERSTARS);
        let at = "2026-10-13T05:00:00.000Z";
        let json = convert(&bytes, &name, &format!("{{\"parsedAt\":\"{at}\"}}")).expect("ok");
        let doc: Value = serde_json::from_str(&json).expect("JSON");
        assert_eq!(doc["hands"][0]["phf"]["meta"]["parsedAt"], at);
        assert_eq!(doc["hands"][0]["phfSha256"], Value::Null);
        // Without it there is no default to fall back on.
        let missing = convert(&bytes, &name, "{}").expect_err("parsedAt is required");
        assert!(missing.contains("parsedAt"), "{missing}");
        let unknown = convert(&bytes, &name, &options(",\"bogus\":1")).expect_err("strict");
        assert!(unknown.contains("bogus"), "{unknown}");
    }

    #[test]
    fn an_unclaimed_file_carries_its_registry_record() {
        let json = convert(b"hello world\n", "notes.txt", &options("")).expect("ok");
        let doc: Value = serde_json::from_str(&json).expect("JSON");
        assert_eq!(doc["detected"]["top"], Value::Null);
        assert_eq!(doc["refusals"][0]["reason"], "unknown-site");
        assert_eq!(doc["refusals"][0]["sourceFilename"], "notes.txt");
        assert_eq!(
            doc["unrecognized"]["fingerprint"],
            doc["refusals"][0]["fingerprint"]
        );
        assert_eq!(doc["unrecognized"]["shape"], "text");
        assert_eq!(doc["stats"]["total"], 1);
        assert_eq!(doc["standardTextFile"], Value::Null);
    }

    #[test]
    fn bytes_that_are_not_text_are_not_converted() {
        let json = convert(b"", "empty.txt", &options("")).expect("ok");
        let doc: Value = serde_json::from_str(&json).expect("JSON");
        assert_eq!(doc["decode"]["problem"], "empty");
        assert_eq!(doc["detected"], Value::Null);
        assert_eq!(doc["stats"], Value::Null);
        let detection: Value = serde_json::from_str(&detect(b"")).expect("JSON");
        assert_eq!(detection["detected"], Value::Null);
    }

    #[test]
    fn detect_serialize_and_anonymise() {
        let (bytes, name) = corpus_file(POKERSTARS);
        let detection: Value = serde_json::from_str(&detect(&bytes)).expect("JSON");
        assert_eq!(detection["detected"]["top"], "pokerstars");
        assert_eq!(detection["decode"]["problem"], Value::Null);

        let native = rail_core::convert(&bytes, &name);
        let Some(Ok(result)) = &native.result else {
            panic!("the sample converts natively");
        };
        let hands: Vec<PhfHand> = result.hands.iter().map(|h| h.hand.clone()).collect();
        let one = serde_json::to_string(&hands[0]).expect("JSON");
        assert_eq!(serialize(&one), Ok(to_standard_text(&hands[0])));
        let all = serde_json::to_string(&hands).expect("JSON");
        assert_eq!(serialize(&all), Ok(to_standard_text_file(&hands)));
        assert!(serialize("{\"schema\":\"phf/1\"}").is_err());

        let sample: Value = serde_json::from_str(&anonymise(&bytes)).expect("JSON");
        assert!(sample["names"].as_u64().is_some_and(|n| n > 0));
        let text = sample["text"].as_str().expect("text");
        for player in &hands[0].players {
            assert!(!text.contains(&player.name), "{} survives", player.name);
        }
    }
}
