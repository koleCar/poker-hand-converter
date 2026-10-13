//! The piecewise decoder against the core's whole-file decoder on every
//! corpus file: the same encoding decision and, read from offset 0 to the
//! end of the file, the same text; read in two pieces split at each hand's
//! first byte, the same text again.

mod common;

use std::fs;

use common::*;
use rail_core::decode::decode_source;
use rail_watch::codec::{self, Decision};

#[test]
fn every_corpus_file_decodes_as_the_core_decodes_it() {
    let mut failures = Vec::new();
    let mut files = 0;
    let mut splits = 0;
    for golden in all_goldens() {
        let bytes = fs::read(repo_root().join(&golden.path)).expect("corpus file");
        let whole = decode_source(&bytes);
        files += 1;
        let codec = match codec::decide(&bytes) {
            Decision::Text(codec) => codec,
            Decision::Problem(problem) => {
                if whole.problem != Some(problem) {
                    failures.push(format!("{}: {problem} vs {:?}", golden.path, whole.problem));
                }
                continue;
            }
        };
        if codec.encoding().label() != golden.encoding {
            failures.push(format!(
                "{}: {} decided, the golden says {}",
                golden.path,
                codec.encoding().label(),
                golden.encoding
            ));
            continue;
        }
        let piece = codec::decode_piece(codec, &bytes, true, true).expect("decodes");
        if piece.text != whole.text || piece.consumed != bytes.len() {
            failures.push(format!("{}: the text differs", golden.path));
            continue;
        }
        // Two pieces, split where a hand starts (where the reader stores
        // offsets): the second from that byte on. Up to 8 per file.
        let starts = hand_starts(&bytes);
        let step = (starts.len() / 8).max(1);
        for &start in starts.iter().step_by(step) {
            splits += 1;
            let first = codec::decode_piece(codec, &bytes[..start], true, false).expect("first");
            let second = codec::decode_piece(codec, &bytes[start..], false, true).expect("second");
            if first.consumed != start || first.text.clone() + &second.text != whole.text {
                failures.push(format!("{}: split at byte {start} differs", golden.path));
                break;
            }
        }
    }
    println!("{files} files, {splits} splits at a hand's first byte");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(files, 556);
}
