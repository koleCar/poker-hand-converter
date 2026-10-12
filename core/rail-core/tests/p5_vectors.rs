//! The ACR / WPN and Ignition parsers and their shared builder against the
//! TypeScript beyond the corpus (docs/RAIL-PLAN.md R0.10b): the vectors in
//! `tests/data/p5-vectors.json`, written by `p5-vectors.mjs` next to it,
//! which runs the TypeScript.
//!
//! 1. **Splits**: both parsers' `splitHands` of every corpus file and of
//!    hand-written edge cases (BOMs, bare `\r`, U+2028, UTF-16LE text read
//!    as UTF-8, every brand string).
//! 2. **Detection** of hand-written probes (both WPN grammars at a
//!    JavaScript line start, the modern header's `UTC` stamp before every
//!    kind of line end, the running pot line, the brands, the header-less
//!    Ignition excerpt, misread UTF-16LE).
//! 3. **Cases**: seeded line edits of every corpus chunk of both rooms
//!    (deleted, swapped, duplicated and inserted lines from a catalogue of
//!    each grammar's shapes - legacy, modern, Ignition -, changed amounts,
//!    other headers, `Game ID:` and table lines - variants, hi/lo, short
//!    deck, stud, tournaments, rolled-over dates, brands, Zone Poker, `[MVS]`
//!    -, renamed seats, cut hands, `\r` / `\r\n` / U+2028 line ends, a BOM,
//!    the whole text misread from UTF-16LE), each through both parsers:
//!    `wpnDialect`, detection and outcome, and the outcome with `cashOnly`
//!    where it differs.
//! 4. **Drafts**: seeded random `P5Draft`s through
//!    `p5_draft_to_standard_text` and `p5_build_hand` - every check of the
//!    builder, straddles, all-ins, stated returns, mucks with cards, dead
//!    money on every kind, boards without a flop.
//! 5. **Files**: the corpus files of both rooms re-encoded (UTF-16 LE with
//!    and without a BOM, UTF-16 BE, Windows-1252, CRLF, UTF-8 with a BOM)
//!    through `rail_core::convert`.
//!
//! `P5_VECTORS=<path>` reads another vector file (a soak run, written with
//! `P5_STRESS=<seed> P5_OUT=<path>`). Needs no `testdata/golden-full/`.

mod golden;

use std::collections::HashMap;
use std::sync::LazyLock;

use rail_core::canonical::{CanonicalJsonError, to_canonical_json};
use rail_core::decode::decode_source;
use rail_core::detect::{ConvertOptions, ParseError, SiteParser, SiteParserContext};
use rail_core::js::JsNumber;
use rail_core::parsers::acrwpn::{AcrWpnParser, wpn_dialect};
use rail_core::parsers::ignition::IgnitionParser;
use rail_core::parsers::shared::p5_handdraft::{
    P5Action, P5Collect, P5Draft, P5Kind, P5Seat, P5Street, P5Tournament, p5_build_hand,
    p5_draft_to_standard_text,
};
use rail_core::phf::{CurrencyUnit, DecimalStyle, PhfHand, PhfWarning};
use serde_json::{Value, json};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let path = std::env::var("P5_VECTORS").map_or_else(
        |_| golden::root().join("core/rail-core/tests/data/p5-vectors.json"),
        std::path::PathBuf::from,
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).expect("p5-vectors.json")
});

/// Whether this run reads the committed vectors (whose sizes are asserted).
fn committed() -> bool {
    std::env::var("P5_VECTORS").is_err()
}

const MAX_REPORTED: usize = 20;
const IDS: [&str; 2] = ["acrwpn", "ignition"];

const STALE: &str = " (if the TypeScript or the corpus changed on purpose, regenerate the \
                     vectors: `node core/rail-core/tests/data/p5-vectors.mjs`)";

const U32_ERROR: &str = "is beyond what a PHF hand can hold (u32)";

fn short(text: &str) -> String {
    golden::sha256_hex(text.as_bytes())[..16].to_owned()
}

fn parser(id: &str) -> &'static dyn SiteParser {
    match id {
        "acrwpn" => &AcrWpnParser,
        "ignition" => &IgnitionParser,
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

/// UTF-16LE bytes (after a BOM when asked) read as UTF-8, as Node's
/// `Buffer.toString("utf8")` reads them (WHATWG: one U+FFFD per maximal
/// invalid subpart, which is also `from_utf8_lossy`'s rule).
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
/// `seat: -1` of an unseated straddler or poster: Rust's reader stops with
/// its `parser-error`, where the TypeScript's hand is fine or fails its
/// canonical JSON on another number beyond 2^53. Not reproducible, counted.
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

        let dialect = wpn_dialect(&input).map(|d| d.as_str());
        if case["dialect"].as_str() != dialect {
            problems.push(format!("{label}: dialect {dialect:?}"));
        }
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
            if unrepresentable_alike(expected, &actual) || beyond_u32(expected, &actual) {
                unrepresentable += 1;
            } else if actual != *expected {
                problems.push(format!("{label}: {id} expected {expected}, got {actual}"));
            }

            let expected_cash = case["cashOnly"].get(id).unwrap_or(expected);
            let actual_cash = outcome(id, &input, &cash_only);
            if let Some(reason) = actual_cash["skip"][0].as_str() {
                *reasons.entry(format!("{id}:{reason}")).or_default() += 1;
            }
            if !(unrepresentable_alike(expected_cash, &actual_cash)
                || beyond_u32(expected_cash, &actual_cash))
                && actual_cash != *expected_cash
            {
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
            cases.len() > 3500
                && hands.get("acrwpn") > Some(&900)
                && hands.get("ignition") > Some(&800),
            "{} cases, {hands:?} hands",
            cases.len()
        );
        // Every refusal reason either parser has, reached.
        for reason in [
            "acrwpn:no-header",
            "acrwpn:unsupported-hi-lo",
            "acrwpn:unsupported-variant",
            "acrwpn:tournament-in-cash-mode",
            "acrwpn:run-it-twice",
            "acrwpn:truncated-hand",
            "acrwpn:duplicate-player",
            "acrwpn:no-players",
            "acrwpn:unnamed-actor",
            "acrwpn:cancelled-hand",
            "acrwpn:unseated-actor",
            "acrwpn:payout-mismatch",
            "acrwpn:too-few-players",
            "acrwpn:no-winner",
            "acrwpn:inconsistent-pot",
            "acrwpn:contribution-mismatch",
            "ignition:no-header",
            "ignition:unsupported-hi-lo",
            "ignition:unsupported-variant",
            "ignition:tournament-in-cash-mode",
            "ignition:corrupt-hand",
            "ignition:no-players",
            "ignition:board-mismatch",
            "ignition:board-size",
            "ignition:missing-street-markers",
            "ignition:too-few-players",
            "ignition:chip-mismatch",
            "ignition:no-winner",
            "ignition:inconsistent-pot",
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

fn street(value: &Value) -> P5Street {
    match value.as_str().expect("street") {
        "preflop" => P5Street::Preflop,
        "flop" => P5Street::Flop,
        "turn" => P5Street::Turn,
        "river" => P5Street::River,
        other => panic!("street {other}"),
    }
}

fn kind(value: &Value) -> P5Kind {
    match value.as_str().expect("kind") {
        "ante" => P5Kind::Ante,
        "small-blind" => P5Kind::SmallBlind,
        "big-blind" => P5Kind::BigBlind,
        "post" => P5Kind::Post,
        "straddle" => P5Kind::Straddle,
        "fold" => P5Kind::Fold,
        "check" => P5Kind::Check,
        "call" => P5Kind::Call,
        "bet" => P5Kind::Bet,
        "raise" => P5Kind::Raise,
        "allin" => P5Kind::Allin,
        "uncalled" => P5Kind::Uncalled,
        "show" => P5Kind::Show,
        "muck" => P5Kind::Muck,
        other => panic!("kind {other}"),
    }
}

fn text_of(value: &Value) -> String {
    value.as_str().expect("text").to_owned()
}

/// The generator's JSON draft as a [`P5Draft`].
fn draft_of(value: &Value) -> P5Draft {
    let seats = value["seats"]
        .as_array()
        .expect("seats")
        .iter()
        .map(|seat| P5Seat {
            seat: num(&seat["seat"]),
            name: text_of(&seat["name"]),
            starting_stack: num(&seat["startingStack"]),
            is_hero: seat["isHero"].as_bool().expect("isHero"),
            dealt_in: seat["dealtIn"].as_bool().expect("dealtIn"),
            dealt_cards: strings(&seat["dealtCards"]),
        })
        .collect();
    let actions = value["actions"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|action| P5Action {
            street: street(&action["street"]),
            player: text_of(&action["player"]),
            kind: kind(&action["kind"]),
            amount: action.get("amount").map(num),
            to_total: action["toTotal"].as_bool().unwrap_or(false),
            dead: action.get("dead").map(num),
            all_in: action["allIn"].as_bool().unwrap_or(false),
            cards: action.get("cards").map(strings),
            description: opt_string(&action["description"]),
        })
        .collect();
    let collected = value["collected"]
        .as_array()
        .expect("collected")
        .iter()
        .map(|entry| P5Collect {
            player: text_of(&entry["player"]),
            amount: num(&entry["amount"]),
            pot_name: opt_string(&entry["potName"]),
        })
        .collect();
    let pairs = |value: &Value| -> Vec<(String, Value)> {
        value
            .as_array()
            .expect("pairs")
            .iter()
            .map(|pair| (text_of(&pair[0]), pair[1].clone()))
            .collect()
    };
    let tournament = &value["tournament"];
    P5Draft {
        site_id: text_of(&value["siteId"]),
        site_name: text_of(&value["siteName"]),
        parser_id: text_of(&value["parserId"]),
        parser_version: text_of(&value["parserVersion"]),
        hand_id: text_of(&value["handId"]),
        game_label: text_of(&value["gameLabel"]),
        unit: serde_json::from_value::<CurrencyUnit>(value["unit"].clone()).expect("unit"),
        decimals: match value["decimals"].as_str() {
            Some("fixed2") => DecimalStyle::Fixed2,
            _ => DecimalStyle::Minimal,
        },
        small_blind: num(&value["smallBlind"]),
        big_blind: num(&value["bigBlind"]),
        table_name: opt_string(&value["tableName"]),
        max_seats: num(&value["maxSeats"]),
        button_seat: opt_num(&value["buttonSeat"]),
        played_at: opt_string(&value["playedAt"]),
        tournament: (!tournament.is_null()).then(|| P5Tournament {
            id: text_of(&tournament["id"]),
            name: opt_string(&tournament["name"]),
            buy_in_token: text_of(&tournament["buyInToken"]),
            level_label: text_of(&tournament["levelLabel"]),
        }),
        seats,
        actions,
        flop: (!value["flop"].is_null()).then(|| strings(&value["flop"])),
        turn: opt_string(&value["turn"]),
        river: opt_string(&value["river"]),
        collected,
        stated_pot: opt_num(&value["statedPot"]),
        stated_rake: opt_num(&value["statedRake"]),
        stated_contributions: (!value["statedContributions"].is_null()).then(|| {
            pairs(&value["statedContributions"])
                .into_iter()
                .map(|(name, amount)| (name, num(&amount)))
                .collect()
        }),
        hole_cards: pairs(&value["holeCards"])
            .into_iter()
            .map(|(name, cards)| (name, strings(&cards)))
            .collect(),
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
        let text = match p5_draft_to_standard_text(&draft) {
            Ok(text) => json!({ "text": short(&text) }),
            Err(skip) => json!({ "skip": [skip.reason.as_str(), skip.message] }),
        };
        if text != entry["text"] {
            problems.push(format!(
                "draft {index}: text expected {}, got {text}",
                entry["text"]
            ));
        }
        let hand_key = entry["handKey"].as_str().expect("handKey");
        let built = shaped(p5_build_hand(&draft, &ctx(&options), hand_key));
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
        assert!(drafts.len() >= 700, "{}", drafts.len());
        for reason in [
            "hand",
            "too-few-players",
            "no-winner",
            "inconsistent-pot",
            "chip-mismatch",
            "contribution-mismatch",
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
        "utf8-crlf" => text.replace('\n', "\r\n").into_bytes(),
        "utf8-bom" => [vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat(),
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
        entries.len() > 750 && hands > 1300,
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
