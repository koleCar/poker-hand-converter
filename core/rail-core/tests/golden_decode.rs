//! `decode_source` on every corpus file agrees with the TypeScript
//! `decodeSource` the goldens recorded (docs/RAIL-PLAN.md R0.5).
//!
//! The goldens record the encoding label and the problem per file. The text
//! itself is checked through what the TypeScript kept of it: every accepted
//! hand's `meta.rawText` (in `testdata/golden-full/`) must be text the Rust
//! decoder produced for that file, character for character - except iPoker's,
//! which the parser assembles (the session header followed by one `<game>`),
//! so it is not a slice of the file: since R0.9 those are checked against
//! the Rust split of the Rust-decoded text instead (the chunk the hand came
//! from, trimmed), which pins both the decoder and the assembly.

mod golden;

use std::fs;

use rail_core::decode::decode_source;
use rail_core::detect::SiteParser;
use rail_core::parsers::ipoker::IPokerParser;
use serde_json::Value;

#[test]
fn every_corpus_file_decodes_as_the_typescript_decoded_it() {
    let goldens = golden::goldens();
    let full_dir = golden::root().join("testdata/golden-full");
    assert!(
        full_dir.is_dir(),
        "testdata/golden-full/ is missing (gitignored); generate it with\n\n    \
         cd tests && npm ci && npm run golden:emit\n"
    );

    let mut failures = Vec::new();
    let (mut files, mut agreed, mut hands, mut assembled) = (0_usize, 0_usize, 0_usize, 0_usize);
    for (path, golden) in &goldens {
        files += 1;
        let bytes = golden::input_bytes(path, golden);
        let decoded = decode_source(&bytes);
        let expected = (
            golden["decode"]["encoding"].as_str().unwrap_or_default(),
            golden["decode"]["problem"].as_str(),
        );
        let actual = (
            decoded.encoding.label(),
            decoded.problem.map(|p| p.as_str()),
        );
        if expected == actual {
            agreed += 1;
        } else {
            failures.push(format!("{path}: expected {expected:?}, got {actual:?}"));
            continue;
        }

        let full_path = path
            .split('/')
            .fold(full_dir.clone(), |dir, part| dir.join(part));
        let full_path = full_path.with_file_name(format!(
            "{}.json",
            full_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
        ));
        let text = fs::read_to_string(&full_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", full_path.display()));
        let full: Value = serde_json::from_str(&text).expect("golden-full parses");
        for (i, hand) in full["hands"].as_array().into_iter().flatten().enumerate() {
            let raw = hand["phf"]["meta"]["rawText"].as_str().unwrap_or_default();
            if hand["parser"] == "ipoker" {
                assembled += 1;
                let chunks = IPokerParser.split_hands(&decoded.text).expect("split");
                let chunk = hand["index"]
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                    .and_then(|index| chunks.get(index));
                if chunk.map(|chunk| rail_core::js::trim(chunk)) != Some(raw) {
                    failures.push(format!(
                        "{path}: hands[{i}].meta.rawText is not the assembled chunk {}",
                        hand["index"]
                    ));
                }
                continue;
            }
            hands += 1;
            if !decoded.text.contains(raw) {
                failures.push(format!(
                    "{path}: hands[{i}].meta.rawText is not in the decoded text \
                     (first 80 chars: {:?})",
                    raw.chars().take(80).collect::<String>()
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} problems:\n{}",
        failures.len(),
        failures.join("\n")
    );
    println!(
        "{agreed}/{files} files decode as recorded; {hands} hands' raw text found verbatim, \
         {assembled} iPoker hands' assembled raw text equal to the Rust split's chunk"
    );
    assert_eq!(
        files, 556,
        "the corpus changed size; update this count with the goldens"
    );
    assert_eq!(assembled, 26, "the iPoker hands of the corpus changed");
}
