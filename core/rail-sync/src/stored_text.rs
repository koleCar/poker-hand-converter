//! A stored hand as its standard text instead of its PHF document
//! (`20271114090000_text_storage.sql`, docs/DATABASE.md "The phf /
//! standard_text contract"): the Rust twin of `web/src/lib/phf/storedText.ts`.
//!
//! The desktop sends a hand's standard text with its PHF only when the text
//! reads back as the same hand ([`verified_standard_text`]): rendered with
//! `to_standard_text`, parsed back by `rail-core`, the provenance a text
//! cannot carry restored from the columns the server will store
//! ([`restore_meta`]), and compared field by field but for
//! [`COSMETIC_PATHS`]. The server then keeps the text and drops the PHF. The
//! pull reads such a row back the same way ([`hand_of_stored_row`]).
//!
//! Every rule here is the TypeScript module's, and the corpus test
//! (`tests/test/storedText.test.ts` on the web side, the tests below here)
//! holds both to the same answers.

use rail_core::detect::ConvertOptions;
use rail_core::phf::PhfHand;
use rail_core::phf::serialize::to_standard_text;
use serde_json::{Map, Value};

/// Fields that may differ between a hand and its text's re-read without the
/// hand being any different (`COSMETIC_PATHS` in `storedText.ts`).
pub const COSMETIC_PATHS: [&str; 4] = [
    "$.meta.parsedAt",
    "$.meta.textStyle.dealtLinesForAllPlayers",
    "$.actions[].sourceLine",
    "$.actions[].rawLine",
];

/// The columns of a `hands` row a text-only hand is restored from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredColumns {
    pub hand_key: String,
    pub site: String,
    pub parser_version: Option<String>,
    pub source_filename: Option<String>,
    /// The room's original text (`meta.rawText`), kept on some web rows.
    pub source_text: Option<String>,
    /// The row's `created_at`: stands in for `meta.parsedAt`.
    pub created_at: Option<String>,
}

fn meta_str<'a>(meta: &'a Map<String, Value>, key: &str) -> &'a str {
    meta.get(key).and_then(Value::as_str).unwrap_or("")
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

/// The row the server stores for `phf` (what [`restore_meta`] reads), as
/// `hand_row_from_phf` and the insert trigger write it. `None` when `phf`
/// has no `meta` object.
pub fn stored_columns_of(phf: &Value) -> Option<StoredColumns> {
    let meta = phf.get("meta")?.as_object()?;
    let site = meta_str(meta, "siteId").trim().to_lowercase();
    let key = match meta_str(meta, "handKey") {
        "" => meta_str(meta, "handId"),
        key => key,
    };
    Some(StoredColumns {
        hand_key: format!("{site}:{key}"),
        site,
        parser_version: non_empty(meta_str(meta, "parserVersion")),
        source_filename: non_empty(meta_str(meta, "originalFilename").trim()),
        source_text: non_empty(meta_str(meta, "rawText")),
        created_at: None,
    })
}

/// A Postgres `timestamptz` as JSON writes it, in UTC
/// (`2026-11-13T10:00:00.123456+00:00`), as `Date.toISOString` would print
/// it (`2026-11-13T10:00:00.123Z`); anything else unchanged.
fn iso_of(value: &str) -> String {
    let utc = value
        .strip_suffix("+00:00")
        .or_else(|| value.strip_suffix('Z'));
    let Some(body) = utc else {
        return value.to_owned();
    };
    let (seconds, fraction) = body.split_once('.').unwrap_or((body, ""));
    let well_formed = seconds.len() == 19
        && seconds.as_bytes().get(10) == Some(&b'T')
        && fraction.bytes().all(|b| b.is_ascii_digit());
    if !well_formed {
        return value.to_owned();
    }
    let millis: String = fraction.chars().chain("000".chars()).take(3).collect();
    format!("{seconds}.{millis}Z")
}

/// The name a site's parser writes into `meta.siteName`.
fn site_name(site: &str) -> Option<&'static str> {
    rail_core::parsers::builtin()
        .get(site)
        .map(rail_core::detect::SiteParser::name)
}

/// A re-read hand with its provenance put back from the row: the room (its
/// name and parser too when the text read as another room), the hand key,
/// the parser version, the file name, the original text and the time.
pub fn restore_meta(parsed: &mut Value, row: &StoredColumns) {
    let Some(meta) = parsed.get_mut("meta").and_then(Value::as_object_mut) else {
        return;
    };
    if meta_str(meta, "siteId") != row.site {
        if let Some(name) = site_name(&row.site) {
            meta.insert("siteName".into(), Value::from(name));
        }
        meta.insert("parserId".into(), Value::from(row.site.as_str()));
    }
    meta.insert("siteId".into(), Value::from(row.site.as_str()));
    if let Some(key) = row
        .hand_key
        .strip_prefix(row.site.as_str())
        .and_then(|rest| rest.strip_prefix(':'))
    {
        let current = match meta_str(meta, "handKey") {
            "" => meta_str(meta, "handId"),
            current => current,
        };
        if current != key {
            meta.insert("handKey".into(), Value::from(key));
        }
    }
    meta.insert(
        "parserVersion".into(),
        Value::from(row.parser_version.clone().unwrap_or_default()),
    );
    meta.insert(
        "originalFilename".into(),
        row.source_filename.clone().map_or(Value::Null, Value::from),
    );
    meta.insert(
        "rawText".into(),
        Value::from(row.source_text.clone().unwrap_or_default()),
    );
    if let Some(created) = &row.created_at {
        meta.insert("parsedAt".into(), Value::from(iso_of(created)));
    }
}

fn cosmetic(path: &str) -> bool {
    let mut general = String::with_capacity(path.len());
    let mut skipping = false;
    for c in path.chars() {
        match c {
            '[' => {
                general.push('[');
                skipping = true;
            }
            ']' => {
                general.push(']');
                skipping = false;
            }
            _ if skipping => {}
            _ => general.push(c),
        }
    }
    COSMETIC_PATHS.contains(&general.as_str())
}

fn numbers_equal(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    a == b || matches!((a.as_f64(), b.as_f64()), (Some(x), Some(y)) if x == y)
}

fn diffs_into(a: &Value, b: &Value, path: &str, out: &mut Vec<String>) {
    if cosmetic(path) {
        return;
    }
    match (a, b) {
        (Value::Number(x), Value::Number(y)) if numbers_equal(x, y) => {}
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                out.push(format!("{path}.length"));
                return;
            }
            for (i, (left, right)) in x.iter().zip(y).enumerate() {
                diffs_into(left, right, &format!("{path}[{i}]"), out);
            }
        }
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let here = format!("{path}.{key}");
                match (x.get(key), y.get(key)) {
                    (Some(left), Some(right)) => diffs_into(left, right, &here, out),
                    // Absent on one side (`undefined` against a value, or
                    // against `null`, in the TypeScript).
                    _ if !cosmetic(&here) => out.push(here),
                    _ => {}
                }
            }
        }
        _ if a == b => {}
        _ => out.push(path.to_owned()),
    }
}

/// JSON paths where `a` and `b` differ, `$`-rooted, cosmetic paths left out.
pub fn phf_diffs(a: &Value, b: &Value) -> Vec<String> {
    let mut out = Vec::new();
    diffs_into(a, b, "$", &mut out);
    out
}

/// The readers' parse: one text, exactly one hand (validated), as JSON.
pub fn parse_text(text: &str) -> Option<Value> {
    let result = rail_core::convert_any(text, &ConvertOptions::default()).ok()?;
    match result.hands.as_slice() {
        [only] => serde_json::to_value(&only.hand).ok(),
        _ => None,
    }
}

/// Whether `text` reads back as `phf` (restored from `columns`, or from the
/// columns the server will store for `phf`): the differing paths, empty
/// when it does.
pub fn check_standard_text(
    phf: &Value,
    text: &str,
    columns: Option<&StoredColumns>,
) -> Vec<String> {
    if text.trim().is_empty() {
        return vec!["empty text".into()];
    }
    let Some(mut parsed) = parse_text(text) else {
        return vec!["the text did not parse to a hand".into()];
    };
    let derived;
    let columns = match columns {
        Some(columns) => columns,
        None => match stored_columns_of(phf) {
            Some(found) => {
                derived = found;
                &derived
            }
            None => return vec!["no meta".into()],
        },
    };
    restore_meta(&mut parsed, columns);
    phf_diffs(phf, &parsed)
}

/// `phf`'s standard text when it reads back as `phf`; what the desktop sends
/// as `standard_text`. `None` keeps the PHF on the server.
pub fn verified_standard_text(phf: &Value) -> Option<String> {
    let hand: PhfHand = serde_json::from_value(phf.clone()).ok()?;
    let text = to_standard_text(&hand);
    check_standard_text(phf, &text, None)
        .is_empty()
        .then_some(text)
}

/// The hand a stored row holds: its PHF, or - on a text-only row - its text
/// parsed and restored. `None` when it has neither, or the text no longer
/// parses.
pub fn hand_of_stored_row(
    phf: Option<Value>,
    standard_text: Option<&str>,
    row: &StoredColumns,
) -> Option<Value> {
    if let Some(phf) = phf.filter(|value| !value.is_null()) {
        return Some(phf);
    }
    let mut parsed = parse_text(standard_text?)?;
    restore_meta(&mut parsed, row);
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use super::*;

    const TS: &str = include_str!("../../../web/src/lib/phf/storedText.ts");

    /// `SITE_NAMES` in the TypeScript, read off its source.
    fn ts_site_names() -> BTreeMap<String, String> {
        let block = TS
            .split("export const SITE_NAMES")
            .nth(1)
            .and_then(|rest| rest.split("};").next())
            .expect("SITE_NAMES");
        block
            .lines()
            .filter_map(|line| {
                let (key, value) = line.trim().trim_end_matches(',').split_once(": ")?;
                let value = value.strip_prefix('"')?.strip_suffix('"')?;
                Some((key.trim_matches('"').to_owned(), value.to_owned()))
            })
            .collect()
    }

    #[test]
    fn site_names_match_the_registry() {
        let names = ts_site_names();
        let registry: BTreeMap<String, String> = rail_core::parsers::builtin()
            .parsers()
            .map(|parser| (parser.id().to_owned(), parser.name().to_owned()))
            .collect();
        assert_eq!(names, registry);
    }

    #[test]
    fn cosmetic_paths_match_the_typescript() {
        for path in COSMETIC_PATHS {
            assert!(
                TS.contains(&format!("\"{path}\"")),
                "{path} is not in storedText.ts"
            );
        }
        assert!(cosmetic("$.actions[12].sourceLine"));
        assert!(!cosmetic("$.actions[12].amount"));
    }

    #[test]
    fn timestamps_read_as_iso() {
        assert_eq!(
            iso_of("2026-11-13T10:00:00.123456+00:00"),
            "2026-11-13T10:00:00.123Z"
        );
        assert_eq!(
            iso_of("2026-11-13T10:00:00+00:00"),
            "2026-11-13T10:00:00.000Z"
        );
        assert_eq!(iso_of("2026-11-13T10:00:00.1Z"), "2026-11-13T10:00:00.100Z");
        assert_eq!(
            iso_of("2026-11-13T12:00:00+02:00"),
            "2026-11-13T12:00:00+02:00"
        );
    }

    fn corpus(folder: &str) -> Vec<Value> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/samples")
            .join(folder);
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .expect("corpus")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect();
        files.sort();
        let mut hands = Vec::new();
        for file in files {
            let bytes = std::fs::read(&file).expect("read");
            let Some(Ok(result)) = rail_core::convert(&bytes, "corpus.txt").result else {
                continue;
            };
            for converted in result.hands {
                let mut phf = serde_json::to_value(&converted.hand).expect("json");
                phf["meta"]["rawText"] = Value::from("");
                hands.push(phf);
            }
        }
        hands
    }

    /// WePlay (most production hands) and GG read back from their text; the
    /// re-read, restored from the row, is the hand.
    #[test]
    fn weplay_and_gg_round_trip() {
        for folder in ["weplay", "ggpoker"] {
            let hands = corpus(folder);
            assert!(!hands.is_empty(), "{folder}: no hands");
            let verified = hands
                .iter()
                .filter(|phf| verified_standard_text(phf).is_some())
                .count();
            // Two of the GG folder's hands re-read with a different warning
            // (one is a `standard` hand): kept as PHF.
            assert!(
                verified + 2 >= hands.len(),
                "{folder}: {verified} of {}",
                hands.len()
            );
            for phf in &hands {
                let Some(text) = verified_standard_text(phf) else {
                    continue;
                };
                let mut row = stored_columns_of(phf).expect("columns");
                row.created_at = Some("2026-11-13T10:00:00.5+00:00".into());
                let read = hand_of_stored_row(None, Some(&text), &row).expect("read back");
                assert!(phf_diffs(phf, &read).is_empty());
                assert_eq!(read["meta"]["siteId"], phf["meta"]["siteId"]);
                assert_eq!(read["meta"]["parserId"], phf["meta"]["parserId"]);
                assert_eq!(read["meta"]["parsedAt"], "2026-11-13T10:00:00.500Z");
                // The actions are the same actions, index for index: stored
                // analyses key on them.
                assert_eq!(
                    read["actions"].as_array().map(Vec::len),
                    phf["actions"].as_array().map(Vec::len)
                );
            }
        }
    }

    /// A hand whose text loses something keeps its PHF.
    #[test]
    fn lossy_rooms_keep_their_phf() {
        let hands = corpus("coinpoker");
        assert!(!hands.is_empty());
        assert!(
            hands
                .iter()
                .all(|phf| verified_standard_text(phf).is_none())
        );
    }

    #[test]
    fn a_row_with_phf_is_its_phf() {
        let phf = serde_json::json!({"meta": {"siteId": "x"}});
        let row = StoredColumns::default();
        assert_eq!(
            hand_of_stored_row(Some(phf.clone()), Some("nonsense"), &row),
            Some(phf)
        );
        assert_eq!(hand_of_stored_row(None, Some("nonsense"), &row), None);
        assert_eq!(hand_of_stored_row(Some(Value::Null), None, &row), None);
    }
}
