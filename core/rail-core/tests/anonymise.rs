//! The anonymiser's guarantee over the whole corpus (docs/RAIL-PLAN.md
//! R0.11): **no player name present in the input survives**.
//!
//! For every committed golden's input, the names are the ones the pipeline
//! reads from the file (every player of every converted hand - the same
//! hands the goldens pin), and for the files no parser claims, the ones a
//! format-specific reading of those formats finds (`PLAYER NAME=` and
//! `PLAYER=` for Boss Media, `nickname=` for Merge, seat and post lines for
//! the two text fragments) - a reading independent of the anonymiser's own
//! rules. A name counts as present when it occurs in the decoded text as a
//! token: not glued to a letter, digit or `_` on a side where the name
//! itself starts or ends with one. Every present name must be absent, in
//! that sense, from the anonymised text, from the shareable sample, and from
//! the registry record's header sample; and a name of three characters or
//! more must not be even a substring of the anonymised text.

mod golden;

use std::collections::BTreeSet;
use std::sync::LazyLock;

use rail_core::anonymise::{anonymise, shareable_sample};
use rail_core::decode::decode_source;
use regex::Regex;

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// `name` occurs in `text` as a token (see the module docs).
fn present(text: &str, name: &str) -> bool {
    let bounded_start = is_word(name.chars().next());
    let bounded_end = is_word(name.chars().last());
    text.match_indices(name).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + name.len()..].chars().next();
        !(bounded_start && is_word(before)) && !(bounded_end && is_word(after))
    })
}

static UNRECOGNISED_NAMES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r#"<PLAYER NAME="([^"]+)""#,
        r#"\bPLAYER="([^"]+)""#,
        r#"\bnickname="([^"]+)""#,
        r"(?m)^Seat \d+: (.+?) \(",
        r"(?m)^(\S+) (?:antes|posts)\b",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("pattern"))
    .collect()
});

/// The players of a file no parser claims, read the way its format writes
/// them.
fn unrecognised_names(text: &str) -> BTreeSet<String> {
    UNRECOGNISED_NAMES
        .iter()
        .flat_map(|rule| rule.captures_iter(text))
        .filter_map(|captures| captures.get(1).map(|m| m.as_str().to_owned()))
        .collect()
}

#[derive(Default)]
struct Tally {
    files: usize,
    unrecognised_files: usize,
    /// (file, name) pairs whose name occurs in the input.
    checked: usize,
    distinct: BTreeSet<String>,
    /// Pipeline names that do not occur in the input as read: a parser that
    /// builds the name (Ignition's `[ME]` seat becomes `Hero`, 49 of them).
    not_in_input: usize,
}

#[test]
fn no_player_name_survives_anywhere_in_the_corpus() {
    let mut tally = Tally::default();
    let mut leaks: Vec<String> = Vec::new();
    for (path, golden) in golden::goldens() {
        let bytes = golden::input_bytes(&path, &golden);
        let decoded = decode_source(&bytes);
        if decoded.problem.is_some() {
            continue;
        }
        let text = decoded.text;
        let filename = path.rsplit('/').next().unwrap_or(&path);
        let conversion = rail_core::convert(&bytes, filename);
        tally.files += 1;

        let mut names: BTreeSet<String> = match &conversion.result {
            Some(Ok(result)) => result
                .hands
                .iter()
                .flat_map(|converted| converted.hand.players.iter())
                .map(|player| player.name.clone())
                .collect(),
            _ => BTreeSet::new(),
        };
        let record = conversion.unrecognized.as_ref();
        if record.is_some() {
            tally.unrecognised_files += 1;
            let found = unrecognised_names(&text);
            assert!(!found.is_empty(), "{path}: no player found to check");
            names.extend(found);
        }

        let out = anonymise(&text);
        let sample = shareable_sample(&text);
        for name in &names {
            if !present(&text, name) {
                tally.not_in_input += 1;
                continue;
            }
            tally.checked += 1;
            tally.distinct.insert(name.clone());
            let mut places = Vec::new();
            if present(&out.text, name) {
                places.push("text");
            }
            if present(&sample.text, name) {
                places.push("sample");
            }
            if record.is_some_and(|record| present(&record.header_sample, name)) {
                places.push("header sample");
            }
            // Stronger, and true of the whole corpus today: a name of three
            // characters or more is not even a substring of the output. (A
            // shorter one may legitimately be: `Al` inside `All-in`.)
            if name.chars().count() >= 3 && out.text.contains(name.as_str()) {
                places.push("text, as a substring");
            }
            if !places.is_empty() {
                leaks.push(format!("{path}: {name:?} survives in the {places:?}"));
            }
        }
    }
    eprintln!(
        "{} files ({} unrecognised), {} (file, name) pairs checked, {} distinct names, \
         {} pipeline names not in the input as read",
        tally.files,
        tally.unrecognised_files,
        tally.checked,
        tally.distinct.len(),
        tally.not_in_input
    );
    assert!(
        leaks.is_empty(),
        "{} names survive:\n{}",
        leaks.len(),
        leaks
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(tally.files, 556, "the corpus changed");
    assert_eq!(tally.unrecognised_files, 24);
    // Floors, so that a change to the harness that checks nothing fails.
    assert!(tally.checked > 2_000, "{}", tally.checked);
    assert!(tally.distinct.len() > 1_000, "{}", tally.distinct.len());
}

/// The registry record of each unrecognised corpus file: the refusal's
/// fingerprint, a header sample, and a guess for the two formats we know.
#[test]
fn unrecognised_files_carry_a_registry_record() {
    let mut guessed: Vec<(String, Option<String>, u32)> = Vec::new();
    for (path, golden) in golden::goldens() {
        let bytes = golden::input_bytes(&path, &golden);
        let filename = path.rsplit('/').next().unwrap_or(&path);
        let conversion = rail_core::convert(&bytes, filename);
        let refusal = match &conversion.result {
            Some(Ok(result)) => result.failures.first(),
            _ => None,
        };
        let Some(record) = &conversion.unrecognized else {
            assert!(
                !golden["detected"]["top"].is_null() || conversion.result.is_none(),
                "{path}: no parser claims it, and there is no record"
            );
            continue;
        };
        assert!(
            golden["detected"]["top"].is_null(),
            "{path}: claimed, yet a record"
        );
        let refusal = refusal.expect("the unknown-site refusal");
        assert_eq!(refusal.reason.as_str(), "unknown-site", "{path}");
        assert_eq!(record.fingerprint, refusal.fingerprint, "{path}");
        assert_eq!(
            Some(record.fingerprint.as_str()),
            golden["refusals"][0]["fingerprint"].as_str(),
            "{path}"
        );
        assert!(!record.header_sample.is_empty(), "{path}");
        assert!(record.header_sample.lines().count() <= 12, "{path}");
        guessed.push((path, record.guessed_site.clone(), record.confidence));
    }
    assert_eq!(guessed.len(), 24);
    let site_of = |dir: &str| {
        guessed
            .iter()
            .filter(|(path, _, _)| path.contains(dir))
            .map(|(_, site, confidence)| (site.as_deref(), *confidence))
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(
        site_of("/bossmedia/"),
        BTreeSet::from([(Some("bossmedia"), 1000)])
    );
    assert_eq!(site_of("/merge/"), BTreeSet::from([(Some("merge"), 1000)]));
    assert_eq!(site_of("/winamax/"), BTreeSet::from([(None, 0)]));
    assert_eq!(site_of("/full-tilt/"), BTreeSet::from([(None, 0)]));
}

/// The record is a function of the text: the same file re-saved with CRLF
/// line ends is the same record.
#[test]
fn a_record_is_deterministic() {
    let path = "fixtures/samples/merge/01-basic-hand-nlhe.txt";
    let bytes = std::fs::read(golden::root().join(path)).expect("read");
    let crlf = String::from_utf8(bytes.clone())
        .expect("UTF-8")
        .replace('\n', "\r\n")
        .into_bytes();
    let a = rail_core::convert(&bytes, "a.txt").unrecognized;
    let b = rail_core::convert(&crlf, "b.txt").unrecognized;
    assert!(a.is_some());
    assert_eq!(a, b);
    let record = a.expect("record");
    assert_eq!(
        record.header_sample.lines().next(),
        Some("<description type=\"Omaha\" stakes=\"Pot Limit ($5/$10)\"/>")
    );
    assert!(!record.header_sample.contains("nemi711"));
}
