//! The standard-text serializer and reader against the TypeScript
//! (docs/RAIL-PLAN.md R0.6), over every golden hand and over the vectors in
//! `tests/data/serialize-vectors.json` (written by `serialize-vectors.mjs`
//! next to it, which runs the TypeScript):
//!
//! 1. **Text.** For every accepted corpus hand - its PHF body from
//!    `testdata/golden-full/`, checked against the committed hash -
//!    `sha256(to_standard_text(hand))` is the golden's `standardText`, and per
//!    file `sha256(to_standard_text_file(hands))` is its `standardTextFile`.
//! 2. **Round trip.** For every golden hand, `parse_standard_hand` of that
//!    text is the hand the TypeScript reads back (canonical JSON, by hash),
//!    and `semantics(parse(text)) == semantics(hand)` - the projection of
//!    `tests/test/phfRoundTrip.test.ts` - holds on exactly the hands where it
//!    holds in TypeScript; likewise `to_standard_text(parse(text)) == text`,
//!    the byte check of `phfRoundTrip` and `byteCompat`. The regenerated
//!    summary (`regenerateSummary`) is held to the TypeScript's as well.
//! 3. **Mutations** of a sample of golden hands that reach the style and
//!    header paths the corpus does not (pinned style fields, odd dates,
//!    levels, buy-ins, runouts, fee columns, ...): the text and its re-read.
//! 4. **Texts**: the unit tests' standard-format fixtures and the reader's
//!    edge cases, read and written back; and what the splitter cuts.
//!
//! Needs `testdata/golden-full/` (`cd tests && npm ci && npm run golden:emit`)
//! and fails without it.

mod golden;

use std::fs;
use std::sync::LazyLock;

use rail_core::canonical::{to_canonical_json, value_to_canonical_json};
use rail_core::detect::PINNED_PARSED_AT;
use rail_core::phf::PhfHand;
use rail_core::phf::serialize::{
    SerializeOptions, StandardContext, parse_standard_hand, split_standard_hands, to_standard_text,
    to_standard_text_file, to_standard_text_with,
};
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let text = include_str!("data/serialize-vectors.json");
    serde_json::from_str(text).expect("serialize-vectors.json")
});

const MAX_REPORTED: usize = 20;

/// What to do when a TypeScript change moved the goldens or the reader on
/// purpose: the vectors are the TypeScript's answers and go stale with it.
const STALE: &str = " (if the TypeScript or the goldens changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/serialize-vectors.mjs`)";

/// `{ siteId: "standard", siteName: "standard", originalFilename: null }`,
/// the context of the TypeScript round-trip tests, with the clock pinned.
const CTX: StandardContext<'static> = StandardContext {
    site_id: "standard",
    site_name: "standard",
    original_filename: None,
    parser_id: None,
    parser_version: None,
    parsed_at: PINNED_PARSED_AT,
};

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn phf_short(hand: &PhfHand) -> String {
    short(&to_canonical_json(hand).expect("canonical"))
}

/// Every golden file with hands: `(path, committed golden, PHF bodies)`.
fn corpus() -> Vec<(String, Value, Vec<PhfHand>)> {
    let full_dir = golden::root().join("testdata/golden-full");
    assert!(
        full_dir.is_dir(),
        "testdata/golden-full/ is missing. It holds the PHF bodies this test needs and is \
         gitignored; generate it with\n\n    cd tests && npm ci && npm run golden:emit\n"
    );
    golden::goldens()
        .into_iter()
        .map(|(path, committed)| {
            let count = committed["hands"].as_array().map_or(0, Vec::len);
            if count == 0 {
                return (path, committed, Vec::new());
            }
            let file = full_dir.join(format!("{path}.json"));
            let text = fs::read_to_string(&file).unwrap_or_else(|e| {
                panic!("read {}: {e} (run `npm run golden:emit`)", file.display())
            });
            let full: Value = serde_json::from_str(&text).expect("golden-full JSON");
            let hands = (0..count)
                .map(|i| {
                    let body = full["hands"][i]["phf"].clone();
                    let canonical = value_to_canonical_json(body.clone()).expect("canonical");
                    assert_eq!(
                        Some(golden::sha256_hex(canonical.as_bytes()).as_str()),
                        committed["hands"][i]["phf"].as_str(),
                        "{path} hands[{i}]: testdata/golden-full/ is stale; regenerate it with \
                         `npm run golden:emit`"
                    );
                    serde_json::from_value(body).expect("a PHF hand")
                })
                .collect();
            (path, committed, hands)
        })
        .collect()
}

static CORPUS: LazyLock<Vec<(String, Value, Vec<PhfHand>)>> = LazyLock::new(corpus);

/// `semantics()` of `tests/test/phfRoundTrip.test.ts`: what two
/// semantically equal hands agree on (not `parsedAt`, not `rawText`, not an
/// action's line, label or index).
fn semantics(hand: &PhfHand) -> Value {
    let actions: Vec<Value> = hand
        .actions
        .iter()
        .map(|a| {
            json!({
                "street": a.street,
                "runoutIndex": a.runout_index,
                "player": a.player,
                "type": a.kind,
                "amount": a.amount,
                "streetTotal": a.street_total,
                "allIn": a.all_in,
                "cards": a.cards,
                "description": a.description,
                "potName": a.pot_name,
            })
        })
        .collect();
    json!({
        "schema": hand.schema,
        "handId": hand.meta.hand_id,
        "playedAt": hand.played_at,
        "game": hand.game,
        "table": hand.table,
        "tournament": hand.tournament,
        "players": hand.players,
        "board": hand.board,
        "results": hand.results,
        "textStyle": hand.meta.text_style,
        "actions": actions,
    })
}

fn indices(value: &Value) -> Vec<usize> {
    value
        .as_array()
        .expect("an index list")
        .iter()
        .map(|i| usize::try_from(i.as_u64().expect("an index")).expect("usize"))
        .collect()
}

fn report(failures: &[String], what: &str) {
    assert!(
        failures.is_empty(),
        "{} {what}:\n{}{}",
        failures.len(),
        failures
            .iter()
            .take(MAX_REPORTED)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n"),
        if failures.len() > MAX_REPORTED {
            format!("\n... and {} more", failures.len() - MAX_REPORTED)
        } else {
            String::new()
        }
    );
}

/// The first line where two texts part, for a readable failure.
fn first_difference(expected: &str, actual: &str) -> String {
    expected
        .lines()
        .zip(actual.lines())
        .enumerate()
        .find(|(_, (e, a))| e != a)
        .map_or_else(
            || {
                format!(
                    "{} lines expected, {} written",
                    expected.lines().count(),
                    actual.lines().count()
                )
            },
            |(n, (e, a))| format!("line {}: expected {e:?}, wrote {a:?}", n + 1),
        )
}

#[test]
fn every_golden_hand_and_file_writes_the_golden_standard_text() {
    let mut hands = 0;
    let mut agree = 0;
    let mut files = 0;
    let mut files_agree = 0;
    let mut failures = Vec::new();
    for (path, committed, bodies) in CORPUS.iter() {
        files += 1;
        for (i, hand) in bodies.iter().enumerate() {
            hands += 1;
            let text = to_standard_text(hand);
            if Some(golden::sha256_hex(text.as_bytes()).as_str())
                == committed["hands"][i]["standardText"].as_str()
            {
                agree += 1;
            } else {
                failures.push(format!(
                    "{path} hands[{i}] ({}): standardText differs",
                    hand.meta.hand_id
                ));
            }
        }
        // `null` for a file without hands, as the emitter writes it.
        let file_hash = if bodies.is_empty() {
            Value::Null
        } else {
            Value::from(golden::sha256_hex(to_standard_text_file(bodies).as_bytes()))
        };
        if file_hash == committed["standardTextFile"] {
            files_agree += 1;
        } else {
            failures.push(format!("{path}: standardTextFile differs"));
        }
    }
    println!(
        "standard text: {agree} / {hands} hands, {files_agree} / {files} files agree with the goldens"
    );
    report(&failures, "standard texts differ from the goldens");
    assert_eq!(hands, 8422, "the corpus changed size");
    assert_eq!(files, 556, "the corpus changed size");
}

#[test]
fn every_golden_hand_reads_back_as_the_typescript_reads_it() {
    let corpus_vectors = VECTORS["corpus"].as_object().expect("corpus vectors");
    let mut hands = 0;
    let mut reparsed_agree = 0;
    let mut semantic_equal = 0;
    let mut byte_stable = 0;
    let mut regenerated_agree = 0;
    let mut failures = Vec::new();
    for (path, _, bodies) in CORPUS.iter() {
        if bodies.is_empty() {
            continue;
        }
        let expected = corpus_vectors
            .get(path)
            .unwrap_or_else(|| panic!("{path}: no vectors{STALE}"));
        let not_semantic = indices(&expected["semantic"]);
        let not_bytes = indices(&expected["bytes"]);
        for (i, hand) in bodies.iter().enumerate() {
            hands += 1;
            let at = format!("{path} hands[{i}] ({})", hand.meta.hand_id);
            let text = to_standard_text(hand);
            let back = match parse_standard_hand(&text, &CTX) {
                Ok(back) => back,
                Err(thrown) => {
                    failures.push(format!("{at}: the reader threw {thrown}"));
                    continue;
                }
            };
            let back_hash = back.as_ref().map(phf_short);
            if back_hash.as_deref() == expected["reparsed"][i].as_str() {
                reparsed_agree += 1;
            } else {
                failures.push(format!(
                    "{at}: the re-read hand differs from the TypeScript's"
                ));
            }
            let equal = back
                .as_ref()
                .is_some_and(|back| semantics(back) == semantics(hand));
            semantic_equal += usize::from(equal);
            if equal == not_semantic.contains(&i) {
                failures.push(format!(
                    "{at}: semantically {} after a round trip, the TypeScript's is {}",
                    if equal { "equal" } else { "different" },
                    if equal { "not" } else { "equal" }
                ));
            }
            let again = back.as_ref().map(to_standard_text);
            let stable = again.as_deref() == Some(text.as_str());
            byte_stable += usize::from(stable);
            if stable == not_bytes.contains(&i) {
                failures.push(format!(
                    "{at}: the text is {}byte-stable through the reader, unlike the TypeScript's \
                     ({})",
                    if stable { "" } else { "not " },
                    again.map_or_else(
                        || "no hand".to_owned(),
                        |again| first_difference(&text, &again)
                    )
                ));
            }
            let regenerated = to_standard_text_with(
                hand,
                SerializeOptions {
                    regenerate_summary: true,
                },
            );
            if Some(short(&regenerated).as_str()) == expected["regenerated"][i].as_str() {
                regenerated_agree += 1;
            } else {
                failures.push(format!("{at}: the regenerated summary differs"));
            }
        }
    }
    println!(
        "round trip: {hands} hands; re-read as the TypeScript does {reparsed_agree}; semantically \
         equal {semantic_equal}; byte-stable {byte_stable}; regenerated summaries {regenerated_agree}"
    );
    report(&failures, &format!("round-trip differences{STALE}"));
    assert_eq!(
        Some(hands),
        VECTORS["hands"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
    );
}

/// Applies one `{ path, value }` edit (a JSON pointer; the value replaces or,
/// past the end of an array, appends).
fn apply(hand: &mut Value, edit: &Value) {
    let pointer = edit["path"].as_str().expect("a pointer");
    let (parent, key) = pointer.rsplit_once('/').expect("a pointer");
    let value = edit.get("value").cloned().expect("an edit with a value");
    match hand.pointer_mut(parent) {
        Some(Value::Object(map)) => {
            map.insert(key.to_owned(), value);
        }
        Some(Value::Array(items)) => {
            let index: usize = key.parse().expect("an index");
            if index == items.len() {
                items.push(value);
            } else {
                items[index] = value;
            }
        }
        other => panic!("cannot edit {pointer} in {other:?}"),
    }
}

#[test]
fn mutated_golden_hands_write_and_read_back_as_in_typescript() {
    let bodies: Vec<&PhfHand> = CORPUS.iter().flat_map(|(_, _, hands)| hands).collect();
    let bases: Vec<&PhfHand> = VECTORS["baseHands"]
        .as_array()
        .expect("baseHands")
        .iter()
        .map(|base| {
            let id = base["handId"].as_str().expect("handId");
            let phf = base["phf"].as_str().expect("phf");
            *bodies
                .iter()
                .find(|hand| {
                    hand.meta.hand_id == id
                        && golden::sha256_hex(
                            to_canonical_json(*hand).expect("canonical").as_bytes(),
                        ) == phf
                })
                .unwrap_or_else(|| panic!("base hand {id} is not in the goldens{STALE}"))
        })
        .collect();
    let cases = VECTORS["cases"].as_array().expect("cases");
    let mut failures = Vec::new();
    for (n, case) in cases.iter().enumerate() {
        let base = bases[usize::try_from(case["base"].as_u64().expect("base")).expect("usize")];
        let mut value = serde_json::to_value(base).expect("a hand as JSON");
        for edit in case["edits"].as_array().expect("edits") {
            apply(&mut value, edit);
        }
        let hand: PhfHand = serde_json::from_value(value).expect("a mutated hand");
        let at = format!("case {n} ({}, {})", base.meta.hand_id, case["edits"]);
        let text = to_standard_text(&hand);
        if Some(short(&text).as_str()) != case["text"].as_str() {
            failures.push(format!("{at}: the text differs:\n{text}"));
            continue;
        }
        match parse_standard_hand(&text, &CTX) {
            Ok(back) => {
                if back.as_ref().map(phf_short).as_deref() != case["reparsed"].as_str() {
                    failures.push(format!("{at}: the re-read hand differs"));
                }
            }
            Err(thrown) => failures.push(format!("{at}: the reader threw {thrown}")),
        }
    }
    println!("{} mutation cases agree", cases.len() - failures.len());
    report(&failures, &format!("mutation cases differ{STALE}"));
}

#[test]
fn texts_read_and_split_as_in_typescript() {
    let mut failures = Vec::new();
    for case in VECTORS["texts"].as_array().expect("texts") {
        let text = case["text"].as_str().expect("text");
        let at = text.lines().next().unwrap_or_default();
        match parse_standard_hand(text, &CTX) {
            Ok(None) if case["phf"].is_null() && case.get("thrown").is_none() => {}
            Ok(Some(hand)) => {
                if Some(phf_short(&hand).as_str()) != case["phf"].as_str() {
                    failures.push(format!(
                        "{at:?}: the hand differs:\n{}",
                        to_canonical_json(&hand).expect("canonical")
                    ));
                } else if Some(short(&to_standard_text(&hand)).as_str())
                    != case["standardText"].as_str()
                {
                    failures.push(format!(
                        "{at:?}: the text written back differs:\n{}",
                        to_standard_text(&hand)
                    ));
                }
            }
            Ok(None) => failures.push(format!("{at:?}: no hand, expected {}", case["phf"])),
            // A seat-like number a `u32` cannot hold (a straddler's `-1`, a
            // huge `\d+`): an error here, by design.
            Err(_) if case["unrepresentable"] == true => {}
            Err(thrown) => {
                if case["thrown"].as_str() != Some(thrown.message.as_str()) {
                    failures.push(format!("{at:?}: threw {thrown}, expected {case}"));
                }
            }
        }
    }
    for case in VECTORS["splits"].as_array().expect("splits") {
        let text = case["text"].as_str().expect("text");
        let chunks: Vec<Value> = split_standard_hands(text)
            .into_iter()
            .map(Value::from)
            .collect();
        if Value::Array(chunks.clone()) != case["chunks"] {
            failures.push(format!(
                "split {text:?}: {chunks:?}, expected {}",
                case["chunks"]
            ));
        }
    }
    report(&failures, &format!("texts differ{STALE}"));
}
