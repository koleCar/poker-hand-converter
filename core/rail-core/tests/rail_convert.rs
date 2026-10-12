//! Smoke test of the `rail-convert` binary (README §8): a few corpus files
//! through the real executable - the summary, `--json` (every hand hashes to
//! its golden PHF) and `--text` (the file's standard text hashes to its
//! golden `standardTextFile`), and the exit codes.

mod golden;

use std::process::{Command, Output};

use rail_core::canonical::value_to_canonical_json;
use serde_json::Value;

const FILES: [&str; 3] = [
    "fixtures/samples/partypoker/14-multiple-hands-concatenated.txt",
    "fixtures/samples/888poker/13-invalid-hand-truncated-flop.txt",
    "fixtures/samples/pokerbros/02-cash-nlhe-pokerstars-dialect-same-hand.txt",
];

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rail-convert"))
        .current_dir(golden::root())
        .args(args)
        .output()
        .expect("run rail-convert")
}

fn golden_of(path: &str) -> Value {
    golden::goldens()
        .into_iter()
        .find(|(input, _)| input == path)
        .map(|(_, doc)| doc)
        .unwrap_or_else(|| panic!("no golden for {path}"))
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("UTF-8 output")
}

#[test]
fn summarises_each_file() {
    let output = run(&FILES);
    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert_eq!(
        text,
        "fixtures/samples/partypoker/14-multiple-hands-concatenated.txt\n  \
         encoding: UTF-8 (BOM)\n  detected: partypoker 900\n  hands: 5, refusals: 0\n\
         fixtures/samples/888poker/13-invalid-hand-truncated-flop.txt\n  \
         encoding: UTF-8 (BOM)\n  detected: 888poker 950\n  hands: 0, refusals: 1\n  \
         refused #0 [parse] truncated-hand: The hand has no `** Summary **` block, so nothing \
         says what was won.\n\
         fixtures/samples/pokerbros/02-cash-nlhe-pokerstars-dialect-same-hand.txt\n  \
         encoding: UTF-8\n  detected: pokerbros 950\n  hands: 1, refusals: 0\n"
    );
}

#[test]
fn json_is_the_canonical_phf_of_every_hand() {
    for path in FILES {
        let output = run(&["--json", path]);
        assert!(output.status.success(), "{output:?}");
        let hands: Value = serde_json::from_str(&stdout(&output)).expect("JSON array");
        let actual: Vec<String> = hands
            .as_array()
            .expect("array")
            .iter()
            .map(|hand| {
                let canonical = value_to_canonical_json(hand.clone()).expect("canonical");
                golden::sha256_hex(canonical.as_bytes())
            })
            .collect();
        let expected: Vec<String> = golden_of(path)["hands"]
            .as_array()
            .expect("hands")
            .iter()
            .map(|hand| hand["phf"].as_str().expect("phf").to_owned())
            .collect();
        assert_eq!(actual, expected, "{path}");
        // The summary moved to stderr.
        assert!(String::from_utf8_lossy(&output.stderr).starts_with(path));
    }
}

#[test]
fn text_is_the_standard_text_file_byte_for_byte() {
    for path in FILES {
        let output = run(&["--text", path]);
        assert!(output.status.success(), "{output:?}");
        let golden = golden_of(path);
        match golden["standardTextFile"].as_str() {
            Some(hash) => assert_eq!(golden::sha256_hex(&output.stdout), hash, "{path}"),
            None => assert!(output.stdout.is_empty(), "{path}"),
        }
    }
}

#[test]
fn fails_only_on_a_file_it_cannot_read() {
    let output = run(&["no/such/file.txt", FILES[1]]);
    assert_eq!(output.status.code(), Some(1));
    // The readable file is still converted.
    assert!(stdout(&output).contains("truncated-hand"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot read no/such/file.txt"));

    let output = run(&["fixtures/samples/bossmedia"]);
    assert_eq!(output.status.code(), Some(1), "a directory cannot be read");
    // Usage errors.
    assert_eq!(run(&[]).status.code(), Some(2));
    assert_eq!(run(&["--xml", FILES[0]]).status.code(), Some(2));
    assert_eq!(run(&["--json", "--text", FILES[0]]).status.code(), Some(2));
}

#[test]
fn reports_a_file_no_parser_claims() {
    let unknown = golden::goldens()
        .into_iter()
        .find(|(_, doc)| doc["detected"]["top"].is_null() && doc["decode"]["problem"].is_null())
        .map(|(path, _)| path)
        .expect("an unrecognised corpus file");
    let output = run(&[&unknown]);
    assert!(output.status.success(), "{output:?}");
    let text = stdout(&output);
    assert!(text.contains("  detected: none\n"), "{text}");
    assert!(text.contains("unknown-site"), "{text}");
}
