//! `rail-convert`: hand-history files through the Rust core, from the command
//! line (README §8).
//!
//! ```text
//! rail-convert [--json | --text] <file>...
//! ```
//!
//! Each file is decoded, detected, split, parsed, positioned and validated
//! exactly as the converter does it (`rail_core::convert`), with the
//! parsers ported so far. Without a flag, a summary per file goes to stdout:
//! the encoding, the detected parsers with their per-mille scores, the number
//! of hands and every refusal (chunk, stage, reason, message). With `--json`
//! stdout is each file's hands as the canonical PHF JSON array (the goldens'
//! form, `meta.parsedAt` pinned to 1970-01-01: the core has no clock), with
//! `--text` each file's standard text (`toStandardTextFile`, byte for byte);
//! the summaries then go to stderr.
//!
//! The exit code is 1 when a file cannot be read, 2 for a usage error, and 0
//! otherwise - a refused hand or an unrecognised file is a result, not an
//! error.
//!
//! Plain `std` and `serde_json` (already a dependency of the core): the
//! binary adds no dependency, and it still compiles for
//! `wasm32-unknown-unknown`, where nothing runs it.

use std::io::Write as _;
use std::process::ExitCode;

use rail_core::FileConversion;
use rail_core::canonical::to_canonical_json;
use rail_core::phf::PhfHand;
use rail_core::phf::serialize::to_standard_text_file;

const USAGE: &str = "usage: rail-convert [--json | --text] <file>...";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Output {
    Summary,
    Json,
    Text,
}

fn summary(path: &str, conversion: &FileConversion) -> String {
    let mut out = format!("{path}\n  encoding: {}\n", conversion.encoding.label());
    if let Some(problem) = conversion.problem {
        out.push_str(&format!("  not converted: {problem}\n"));
        return out;
    }
    let detected = if conversion.detected.is_empty() {
        "none".to_owned()
    } else {
        conversion
            .detected
            .iter()
            .map(|c| format!("{} {}", c.parser, c.permille))
            .collect::<Vec<_>>()
            .join(", ")
    };
    out.push_str(&format!("  detected: {detected}\n"));
    match &conversion.result {
        None => {}
        Some(Err(thrown)) => out.push_str(&format!("  conversion threw: {thrown}\n")),
        Some(Ok(result)) => {
            out.push_str(&format!(
                "  hands: {}, refusals: {}\n",
                result.hands.len(),
                result.failures.len()
            ));
            for failure in &result.failures {
                let chunk = failure
                    .index
                    .map_or_else(|| "file".to_owned(), |index| format!("#{index}"));
                out.push_str(&format!(
                    "  refused {chunk} [{}] {}: {}\n",
                    failure.stage.as_str(),
                    failure.reason.as_str(),
                    failure.message
                ));
            }
        }
    }
    out
}

fn hands_of(conversion: &FileConversion) -> Vec<PhfHand> {
    match &conversion.result {
        Some(Ok(result)) => result.hands.iter().map(|h| h.hand.clone()).collect(),
        _ => Vec::new(),
    }
}

fn main() -> ExitCode {
    let mut output = Output::Summary;
    let mut paths: Vec<String> = Vec::new();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--json" if output == Output::Summary => output = Output::Json,
            "--text" if output == Output::Summary => output = Output::Text,
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            flag if flag.starts_with("--") => {
                eprintln!("rail-convert: unknown or repeated option {flag}\n{USAGE}");
                return ExitCode::from(2);
            }
            _ => paths.push(arg),
        }
    }
    if paths.is_empty() {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }

    let mut failed = false;
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    for path in &paths {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("rail-convert: cannot read {path}: {error}");
                failed = true;
                continue;
            }
        };
        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
        let conversion = rail_core::convert(&bytes, &name);
        let written = match output {
            Output::Summary => stdout.write_all(summary(path, &conversion).as_bytes()),
            Output::Json => {
                eprint!("{}", summary(path, &conversion));
                match to_canonical_json(&hands_of(&conversion)) {
                    Ok(json) => stdout.write_all(json.as_bytes()),
                    Err(error) => {
                        eprintln!("rail-convert: {path}: {error}");
                        Ok(())
                    }
                }
            }
            Output::Text => {
                eprint!("{}", summary(path, &conversion));
                stdout.write_all(to_standard_text_file(&hands_of(&conversion)).as_bytes())
            }
        };
        if let Err(error) = written {
            eprintln!("rail-convert: cannot write: {error}");
            return ExitCode::FAILURE;
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
