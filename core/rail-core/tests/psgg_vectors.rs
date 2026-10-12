//! The PokerStars and GGPoker parsers, and the PokerStars-clone dispatcher,
//! against the TypeScript beyond the corpus (docs/RAIL-PLAN.md R0.7a): the
//! vectors in `tests/data/psgg-vectors.json`, written by `psgg-vectors.mjs`
//! next to it, which runs the TypeScript.
//!
//! 1. **Splits**: both parsers' `splitHands` of every corpus file and of
//!    hand-written edge cases (bare `\r`, BOMs, U+2028, `GG\nPoker Hand #`).
//! 2. **Detection** of hand-written probes (JavaScript's `.{0,40}` counting
//!    UTF-16 units, line starts, foreign branding).
//! 3. **Cases**: every PokerStars and GG corpus chunk, and seeded line edits of
//!    them (deleted, swapped, duplicated and inserted lines, changed amounts,
//!    other headers - currencies, tournaments, variants, spin-offs, levels -,
//!    a cut SUMMARY, `\r` / U+2028 line ends, a BOM), each through both
//!    parsers: the detection score and the `parseHand` outcome - refusal
//!    reason and message, or the canonical hash of the hand.
//! 4. **Dialect**: Run It Once and PokerBros chunks and edits through
//!    `parseStarsFamilyBody` into a fixed draft, built.
//!
//! Needs no `testdata/golden-full/`.

mod golden;

use std::sync::LazyLock;

use rail_core::canonical::{to_canonical_json, value_to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::parsers::ggpoker::GgPokerParser;
use rail_core::parsers::pokerstars::PokerStarsParser;
use rail_core::parsers::shared::p3_stars_dialect::{DialectResult, parse_stars_family_body};
use rail_core::parsers::shared::ps_gg_hand::{DraftGame, DraftInit, StarsHandDraft, to_lines};
use rail_core::phf::money::{EUR, USD};
use rail_core::phf::{GameFormat, LimitType, PhfTextStyle, Variant};
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let text = include_str!("data/psgg-vectors.json");
    serde_json::from_str(text).expect("psgg-vectors.json")
});

const MAX_REPORTED: usize = 20;

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/psgg-vectors.mjs`)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "pokerstars" => &PokerStarsParser,
        "ggpoker" => &GgPokerParser,
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

/// `JSON.stringify(parser.splitHands(text))`.
fn split_hash(id: &str, text: &str) -> String {
    let chunks = parser(id).split_hands(text).expect("split");
    short(&serde_json::to_string(&chunks).expect("json"))
}

/// The edit script of a case, applied as `psgg-vectors.mjs` applies it.
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

/// `parseHand`'s outcome in the vectors' shape.
fn outcome(id: &str, text: &str) -> Value {
    let options = ConvertOptions::default();
    let ctx = SiteParserContext {
        source_filename: None,
        options: &options,
    };
    match parser(id).parse_hand(text, &ctx) {
        Ok(hand) => json!({ "hand": short(&to_canonical_json(&hand).expect("canonical")) }),
        Err(ParseError::Skip(skip)) => json!({ "skip": [skip.reason.as_str(), skip.message] }),
        Err(ParseError::Bug(message)) => json!({ "error": message }),
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
        for id in ["pokerstars", "ggpoker"] {
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
        for id in ["pokerstars", "ggpoker"] {
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
    let mut texts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut chunks: std::collections::HashMap<(String, String), Vec<String>> =
        std::collections::HashMap::new();
    let mut problems = Vec::new();
    let mut hands = 0;
    for case in cases {
        let file = case["file"].as_str().expect("file");
        let split = case["split"].as_str().expect("split");
        let index = usize::try_from(case["chunk"].as_u64().expect("chunk")).expect("usize");
        let text = texts
            .entry(file.to_owned())
            .or_insert_with(|| decoded(file))
            .clone();
        let chunk = chunks
            .entry((file.to_owned(), split.to_owned()))
            .or_insert_with(|| parser(split).split_hands(&text).expect("split"))[index]
            .clone();
        let input = apply(&chunk, case["ops"].as_array().expect("ops"));
        let detect = json!([
            PokerStarsParser.detect(&input),
            GgPokerParser.detect(&input)
        ]);
        if detect != case["detect"] {
            problems.push(format!("{file}#{index} {}: detect {detect}", case["ops"]));
        }
        for id in ["pokerstars", "ggpoker"] {
            let actual = outcome(id, &input);
            if actual.get("hand").is_some() {
                hands += 1;
            }
            if actual != case[id] {
                problems.push(format!(
                    "{file}#{index} {}: {id} expected {}, got {actual}",
                    case["ops"], case[id]
                ));
            }
        }
    }
    assert!(
        cases.len() > 3000 && hands > 2500,
        "{} cases, {hands} hands",
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
}

/// The `DialectResult` as the TypeScript object serialises.
fn body_json(body: &DialectResult) -> Value {
    json!({
        "seats": body.seats,
        "buttonSeat": body.button_seat,
        "tableName": body.table_name,
        "maxSeats": body.max_seats,
        "sawSummary": body.saw_summary,
        "smallBlindSeat": body.small_blind_seat,
        "chipMovements": serde_json::to_value(&body.chip_movements).expect("json"),
    })
}

/// `dialectOutcome` of `psgg-vectors.mjs`.
fn dialect_outcome(text: &str) -> Value {
    let lines = to_lines(text);
    let unit = if text.contains('€') { EUR } else { USD }.unit();
    let mut draft = StarsHandDraft::new(DraftInit {
        site_id: "dialect".to_owned(),
        site_name: "Dialect".to_owned(),
        parser_id: "dialect".to_owned(),
        parser_version: "0.0.0".to_owned(),
        hand_id: "1".to_owned(),
        hand_key: "D1".to_owned(),
        raw_text: text.to_owned(),
        original_filename: None,
        game: DraftGame {
            variant: Variant::Holdem,
            limit: LimitType::Nl,
            format: GameFormat::Cash,
            label: "Hold'em No Limit".to_owned(),
            unit: unit.clone(),
            small_blind: 5,
            big_blind: 10,
        },
        tournament: None,
        played_at: None,
        text_style: PhfTextStyle::default(),
        repair_missing_uncalled: false,
        parsed_at: rail_core::detect::PINNED_PARSED_AT.to_owned(),
    });
    let body = match parse_stars_family_body(&lines, &mut draft, &unit) {
        Ok(body) => body,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    match draft.build() {
        Ok(mut hand) => {
            if !body.chip_movements.is_empty() {
                hand.chip_movements = Some(body.chip_movements.clone());
            }
            let value = json!({
                "body": body_json(&body),
                "hand": serde_json::to_value(&hand).expect("json"),
            });
            json!({ "hash": short(&value_to_canonical_json(value).expect("canonical")) })
        }
        Err(error) => json!({ "error": format!("{error:?}") }),
    }
}

#[test]
fn the_stars_clone_dialect_matches_the_typescript() {
    let cases = VECTORS["dialect"].as_array().expect("dialect");
    let mut problems = Vec::new();
    for case in cases {
        let file = case["file"].as_str().expect("file");
        let index = usize::try_from(case["chunk"].as_u64().expect("chunk")).expect("usize");
        let text = decoded(file);
        let chunks = clone_room_chunks(&text);
        let input = apply(&chunks[index], case["ops"].as_array().expect("ops"));
        let actual = dialect_outcome(&input);
        let expected = match (case.get("hash"), case.get("error")) {
            (Some(hash), _) => json!({ "hash": hash }),
            (_, Some(error)) => json!({ "error": error }),
            _ => panic!("dialect case without outcome"),
        };
        if actual != expected {
            problems.push(format!(
                "{file}#{index} {}: expected {expected}, got {actual}",
                case["ops"]
            ));
        }
    }
    assert!(cases.len() > 150, "{}", cases.len());
    assert!(
        problems.is_empty(),
        "{} of {} differ{STALE}:\n{}",
        problems.len(),
        cases.len(),
        problems.join("\n")
    );
}

/// The generator's `split(/(?=^(?:Run It Once Poker|PokerBros) Hand #)/m)`,
/// trimmed and filtered (a test fixture, not a parser: those are R0.8/R0.10).
fn clone_room_chunks(text: &str) -> Vec<String> {
    let header =
        |s: &str| s.starts_with("Run It Once Poker Hand #") || s.starts_with("PokerBros Hand #");
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 && header(line) {
            chunks.push(std::mem::take(&mut current));
        } else if i > 0 {
            current.push('\n');
        }
        current.push_str(line);
    }
    chunks.push(current);
    chunks
        .into_iter()
        .map(|chunk| rail_core::js::trim(&chunk).to_owned())
        .filter(|chunk| header(chunk))
        .collect()
}
