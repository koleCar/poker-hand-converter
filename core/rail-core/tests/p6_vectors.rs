//! The Winamax and Chico parsers and their shared builder against the
//! TypeScript beyond the corpus (docs/RAIL-PLAN.md R0.10a): the vectors in
//! `tests/data/p6-vectors.json`, written by `p6-vectors.mjs` next to it,
//! which runs the TypeScript.
//!
//! 1. **Splits**: both parsers' `splitHands` of every corpus file and of
//!    hand-written edge cases (BOMs, bare `\r`, U+2028, lobby chatter, the
//!    inferred skins).
//! 2. **Detection** of hand-written probes (both rooms' headers at a
//!    JavaScript line start, `*** ANTE/BLINDS ***`, the confirmed and the
//!    inferred skins, foreign headers).
//! 3. **Cases**: seeded line edits of every corpus chunk of both rooms
//!    (deleted, swapped, duplicated and inserted lines from a catalogue of
//!    each dialect's shapes, changed amounts - comma decimals, grouped,
//!    thousandths, twenty digits -, other headers and table lines -
//!    currencies, variants, hi/lo, tournaments, rolled-over dates, play
//!    money, the inferred skins -, a swapped currency glyph or U+FFFD, cut
//!    hands, `\r` / `\r\n` / U+2028 line ends, a BOM), each through both
//!    parsers: detection and outcome.
//! 4. **Drafts**: seeded random `P6Draft`s through `p6_to_standard_text` and
//!    `build_p6_hand` - every reconciliation refusal, mucks, dead money,
//!    duplicated seats, boards without a flop.
//! 5. **Files**: the corpus files of both rooms re-encoded (UTF-16 LE with
//!    and without a BOM, UTF-16 BE, Windows-1252 as is and with `£`, CRLF,
//!    UTF-8 with U+FFFD for the currency glyphs) through `rail_core::convert`.
//!
//! `P6_VECTORS=<path>` reads another vector file (a soak run, written with
//! `P6_STRESS=<seed> P6_OUT=<path>`). Needs no `testdata/golden-full/`.

mod golden;

use std::collections::HashMap;
use std::sync::LazyLock;

use rail_core::canonical::{CanonicalJsonError, to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::js::JsNumber;
use rail_core::parsers::chico::ChicoParser;
use rail_core::parsers::shared::p6_handbuilder::{
    P6Action, P6Collect, P6Draft, P6Kind, P6PrintedUncalled, P6Seat, P6Street, P6Tournament,
    build_p6_hand, p6_to_standard_text,
};
use rail_core::parsers::winamax::WinamaxParser;
use rail_core::phf::{CurrencyUnit, DecimalStyle, PhfHand, PhfWarning};
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let path = std::env::var("P6_VECTORS").map_or_else(
        |_| golden::root().join("core/rail-core/tests/data/p6-vectors.json"),
        std::path::PathBuf::from,
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).expect("p6-vectors.json")
});

/// Whether this run reads the committed vectors (whose sizes are asserted).
fn committed() -> bool {
    std::env::var("P6_VECTORS").is_err()
}

const MAX_REPORTED: usize = 20;
const IDS: [&str; 2] = ["winamax", "chico"];

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/p6-vectors.mjs`)";

const U32_ERROR: &str = "is beyond what a PHF hand can hold (u32)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "winamax" => &WinamaxParser,
        "chico" => &ChicoParser,
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

fn outcome(id: &str, text: &str) -> Value {
    let options = ConvertOptions::default();
    shaped(parser(id).parse_hand(text, &ctx(&options)))
}

/// Where the TypeScript's hand has a number beyond 2^53 (its canonical JSON
/// throws): Rust's hand is unrepresentable at the same path, or - for a seat,
/// table size or button beyond `u32` - the reader's `parser-error` (R0.6:
/// those are `u32` in a PHF hand; not reproducible).
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

/// A seat, table size or button the TypeScript's hand holds and a PHF seat
/// (`u32`) cannot - between 2^32 and 2^53 (`Seat 99999999999:`), or the
/// `seat: -1` of a blind posted by an unseated name: Rust's reader stops
/// with its `parser-error`, where the TypeScript's hand is fine or fails
/// its canonical JSON on another number beyond 2^53. Not reproducible,
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
    let mut reasons: HashMap<String, usize> = HashMap::new();
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
            if let Some(reason) = actual["skip"][0].as_str() {
                *reasons.entry(format!("{id}:{reason}")).or_default() += 1;
            }
            if unrepresentable_alike(expected, &actual) || beyond_u32(expected, &actual) {
                unrepresentable += 1;
            } else if actual != *expected {
                problems.push(format!("{label}: {id} expected {expected}, got {actual}"));
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
            cases.len() > 2900
                && hands.get("winamax") > Some(&400)
                && hands.get("chico") > Some(&400),
            "{} cases, {hands:?} hands",
            cases.len()
        );
        // Every refusal reason either parser has, reached.
        for reason in [
            "winamax:unsupported-encoding",
            "winamax:no-header",
            "winamax:unsupported-tournament",
            "winamax:unsupported-variant",
            "winamax:unsupported-hi-lo",
            "winamax:unsupported-currency",
            "winamax:unsupported-locale",
            "winamax:unnamed-seat",
            "winamax:duplicate-player",
            "winamax:duplicate-seat",
            "winamax:unseated-actor",
            "winamax:no-players",
            "winamax:truncated-hand",
            "winamax:board-mismatch",
            "winamax:too-few-players",
            "winamax:no-winner",
            "winamax:inconsistent-pot",
            "chico:no-header",
            "chico:unsupported-hi-lo",
            "chico:unsupported-variant",
            "chico:unsupported-locale",
            "chico:fractional-chips",
            "chico:unnamed-seat",
            "chico:duplicate-player",
            "chico:duplicate-seat",
            "chico:unseated-actor",
            "chico:no-players",
            "chico:truncated-hand",
            "chico:board-mismatch",
            "chico:board-size",
            "chico:duplicate-card",
            "chico:too-few-players",
            "chico:no-winner",
            "chico:uncalled-mismatch",
            "chico:inconsistent-pot",
            "chico:rake-mismatch",
        ] {
            assert!(
                reasons.contains_key(reason),
                "{reason} not reached: {reasons:?}"
            );
        }
    }
    // Twenty-digit amounts and seats: kept few, and counted.
    assert!(
        unrepresentable * 50 < cases.len(),
        "{unrepresentable} unrepresentable"
    );
}

/* ------------------------------------------------------------------ drafts */

/// `String(n)` back to the double.
fn num(value: &Value) -> JsNumber {
    JsNumber::parse(
        value
            .as_str()
            .unwrap_or_else(|| panic!("number string {value}")),
    )
}

fn opt_num(value: &Value) -> Option<JsNumber> {
    (!value.is_null()).then(|| num(value))
}

fn opt_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("strings")
        .iter()
        .map(|v| v.as_str().expect("string").to_owned())
        .collect()
}

fn street(value: &Value) -> P6Street {
    match value.as_str().expect("street") {
        "preflop" => P6Street::Preflop,
        "flop" => P6Street::Flop,
        "turn" => P6Street::Turn,
        "river" => P6Street::River,
        other => panic!("street {other}"),
    }
}

fn kind(value: &Value) -> P6Kind {
    match value.as_str().expect("kind") {
        "ante" => P6Kind::Ante,
        "small-blind" => P6Kind::SmallBlind,
        "big-blind" => P6Kind::BigBlind,
        "post" => P6Kind::Post,
        "fold" => P6Kind::Fold,
        "check" => P6Kind::Check,
        "call" => P6Kind::Call,
        "bet" => P6Kind::Bet,
        "raise" => P6Kind::Raise,
        "show" => P6Kind::Show,
        "muck" => P6Kind::Muck,
        other => panic!("kind {other}"),
    }
}

fn text_of(value: &Value) -> String {
    value.as_str().expect("text").to_owned()
}

/// The generator's JSON draft as a [`P6Draft`].
fn draft_of(value: &Value) -> P6Draft {
    let seats = value["seats"]
        .as_array()
        .expect("seats")
        .iter()
        .map(|seat| P6Seat {
            seat: num(&seat["seat"]),
            name: text_of(&seat["name"]),
            starting_stack: num(&seat["startingStack"]),
            dealt_in: seat["dealtIn"].as_bool().expect("dealtIn"),
            is_hero: seat["isHero"].as_bool().expect("isHero"),
            dealt_cards: strings(&seat["dealtCards"]),
        })
        .collect();
    let actions = value["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|action| P6Action {
            street: street(&action["street"]),
            player: text_of(&action["player"]),
            kind: kind(&action["kind"]),
            amount: action.get("amount").map(num),
            to_total: action["toTotal"].as_bool().unwrap_or(false),
            dead: action.get("dead").map(num),
            all_in: action["allIn"].as_bool().unwrap_or(false),
            cards: action.get("cards").map(strings),
            description: opt_string(&action["description"]),
            line: action
                .get("line")
                .map(|line| text_of(line).parse().expect("line")),
        })
        .collect();
    let collected = value["collected"]
        .as_array()
        .expect("collected")
        .iter()
        .map(|entry| P6Collect {
            player: text_of(&entry["player"]),
            amount: num(&entry["amount"]),
            pot_name: opt_string(&entry["potName"]),
        })
        .collect();
    let printed_uncalled = value["printedUncalled"]
        .as_array()
        .expect("printedUncalled")
        .iter()
        .map(|entry| P6PrintedUncalled {
            player: text_of(&entry["player"]),
            amount: num(&entry["amount"]),
        })
        .collect();
    let tournament = &value["tournament"];
    P6Draft {
        site_id: text_of(&value["siteId"]),
        site_name: text_of(&value["siteName"]),
        parser_id: text_of(&value["parserId"]),
        parser_version: text_of(&value["parserVersion"]),
        hand_prefix: text_of(&value["handPrefix"]),
        hand_id: text_of(&value["handId"]),
        game_label: text_of(&value["gameLabel"]),
        unit: serde_json::from_value::<CurrencyUnit>(value["unit"].clone()).expect("unit"),
        decimals: match value["decimals"].as_str() {
            Some("fixed2") => DecimalStyle::Fixed2,
            _ => DecimalStyle::Minimal,
        },
        header_small_blind: num(&value["headerSmallBlind"]),
        header_big_blind: num(&value["headerBigBlind"]),
        table_name: opt_string(&value["tableName"]),
        max_seats: num(&value["maxSeats"]),
        button_seat: opt_num(&value["buttonSeat"]),
        tournament: (!tournament.is_null()).then(|| P6Tournament {
            id: text_of(&tournament["id"]),
            level_small_blind: num(&tournament["levelSmallBlind"]),
            level_big_blind: num(&tournament["levelBigBlind"]),
        }),
        played_at: opt_string(&value["playedAt"]),
        seats,
        actions,
        flop: (!value["flop"].is_null()).then(|| strings(&value["flop"])),
        turn: opt_string(&value["turn"]),
        river: opt_string(&value["river"]),
        collected,
        collected_includes_uncalled: value["collectedIncludesUncalled"]
            .as_bool()
            .expect("collectedIncludesUncalled"),
        printed_uncalled,
        reported_gross: opt_num(&value["reportedGross"]),
        reported_payout: opt_num(&value["reportedPayout"]),
        reported_rake: opt_num(&value["reportedRake"]),
        raw_text: text_of(&value["rawText"]),
        warnings: serde_json::from_value::<Vec<PhfWarning>>(value["warnings"].clone())
            .expect("warnings"),
    }
}

#[test]
fn drafts_build_as_the_typescript_builds_them() {
    let drafts = VECTORS["drafts"].as_array().expect("drafts");
    let options = ConvertOptions::default();
    let mut problems = Vec::new();
    let mut tally: HashMap<String, usize> = HashMap::new();
    let mut unrepresentable = 0;
    for (index, entry) in drafts.iter().enumerate() {
        let draft = draft_of(&entry["draft"]);
        let text = match p6_to_standard_text(&draft) {
            Ok(text) => json!({ "text": short(&text) }),
            Err(skip) => json!({ "skip": [skip.reason.as_str(), skip.message] }),
        };
        if text != entry["text"] {
            problems.push(format!(
                "draft {index}: text expected {}, got {text}",
                entry["text"]
            ));
        }
        let built = shaped(build_p6_hand(&draft, &ctx(&options)));
        let key = built["skip"][0]
            .as_str()
            .map_or_else(|| "hand".to_owned(), str::to_owned);
        *tally.entry(key).or_default() += 1;
        let expected = &entry["built"];
        if unrepresentable_alike(expected, &built) || beyond_u32(expected, &built) {
            unrepresentable += 1;
        } else if built != *expected {
            problems.push(format!(
                "draft {index}: built expected {}, got {built}",
                entry["built"]
            ));
        }
    }
    let shown: Vec<_> = problems.iter().take(MAX_REPORTED).cloned().collect();
    assert!(
        problems.is_empty(),
        "{} of {} drafts differ{STALE}:\n{}",
        problems.len(),
        drafts.len(),
        shown.join("\n")
    );
    if committed() {
        assert!(drafts.len() >= 600, "{}", drafts.len());
        for reason in [
            "hand",
            "too-few-players",
            "no-winner",
            "inconsistent-pot",
            "uncalled-mismatch",
            "payout-mismatch",
            "rake-mismatch",
        ] {
            assert!(tally.get(reason) > Some(&10), "{reason}: {tally:?}");
        }
    }
    assert!(
        unrepresentable * 10 < drafts.len(),
        "{unrepresentable} unrepresentable"
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
        "cp1252-pound" => cp1252(&text.replace(['€', '$'], "£")),
        "utf8-crlf" => text.replace('\n', "\r\n").into_bytes(),
        "utf8-fffd" => text.replace(['€', '$'], "\u{FFFD}").into_bytes(),
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
    let mut encoding_refusals = 0;
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
        encoding_refusals += result
            .failures
            .iter()
            .filter(|f| f.reason.as_str() == "unsupported-encoding")
            .count();
        if Value::from(failures.clone()) != entry["failures"] {
            problems.push(format!("{label}: failures {failures:?}"));
        }
    }
    assert!(
        entries.len() > 280 && hands > 400 && encoding_refusals > 30,
        "{} files, {hands} hands, {encoding_refusals} encoding refusals",
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
