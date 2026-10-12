//! Bytes to text: the converter's `decodeSource`
//! (`frontend/src/components/converter/inputs.ts`), step for step.
//!
//! Decoding is part of the oracle - every golden records `decode.encoding` and
//! `decode.problem` - so this ports `decodeSource`'s order and guards, not a
//! library default:
//!
//! 1. **Pick an encoding** from the first bytes: a UTF-8, UTF-16LE or UTF-16BE
//!    byte-order mark; else UTF-16 without a BOM when NULs sit at every other
//!    index of the first KiB; else UTF-8.
//! 2. **Decode** the way `TextDecoder` does (which drops one leading BOM of its
//!    own): UTF-16 with U+FFFD for lone surrogates and an odd trailing byte;
//!    UTF-8 strictly, and on invalid bytes **Windows-1252** (the WHATWG
//!    mapping) - unless that reads as implausible (more than 2 % control
//!    characters or more than 5 % non-ASCII in the first 4096 UTF-16 code
//!    units), in which case UTF-8 with U+FFFD replacements.
//! 3. **Refuse binary**: more than 5 % U+FFFD or C0 controls (other than tab,
//!    LF, CR) in the first 4096 code units.
//! 4. **Normalize**: strip one more leading U+FEFF, turn CRLF and lone CR into
//!    LF; text that is then only (JavaScript) whitespace is `no-text`.
//!
//! The ratio thresholds are compared in integers (`bad * 20 > len` for
//! `bad / len > 0.05`); for every length the decoder can see the two agree
//! (checked exhaustively against Node when this was written).
//!
//! `tests/data/decode-vectors.json` (written by `decode-vectors.mjs`, which
//! runs the TypeScript) holds the edge cases the corpus lacks; the unit tests
//! replay it, and `tests/golden_decode.rs` checks all 556 corpus files.

use std::fmt;

/// Why a file cannot be converted at all (`SourceProblem` of `inputs.ts`,
/// the kinds `decodeSource` produces; the archive and upload kinds belong to
/// the UI that reads files, not to decoding).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceProblem {
    /// `empty`: zero bytes.
    Empty,
    /// `no-text`: nothing but whitespace once decoded.
    NoText,
    /// `binary`: too many replacement or control characters to be text.
    Binary,
}

impl SourceProblem {
    /// The TypeScript `kind`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::NoText => "no-text",
            Self::Binary => "binary",
        }
    }
}

impl fmt::Display for SourceProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The encoding a source was read with, as `decodeSource` labels it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Encoding {
    /// `UTF-8`
    Utf8,
    /// `UTF-8 (BOM)`
    Utf8Bom,
    /// `UTF-16 LE`
    Utf16Le,
    /// `UTF-16 LE (no BOM)`
    Utf16LeNoBom,
    /// `UTF-16 BE`
    Utf16Be,
    /// `UTF-16 BE (no BOM)`
    Utf16BeNoBom,
    /// `Windows-1252`
    Windows1252,
}

impl Encoding {
    /// The label the converter shows and the goldens record.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf8Bom => "UTF-8 (BOM)",
            Self::Utf16Le => "UTF-16 LE",
            Self::Utf16LeNoBom => "UTF-16 LE (no BOM)",
            Self::Utf16Be => "UTF-16 BE",
            Self::Utf16BeNoBom => "UTF-16 BE (no BOM)",
            Self::Windows1252 => "Windows-1252",
        }
    }
}

impl fmt::Display for Encoding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// What `decodeSource` returns: the text (empty when there is a problem), the
/// encoding it was read with, and the problem if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// Decoded, BOM-stripped, LF-normalized text; empty when `problem` is set.
    pub text: String,
    pub encoding: Encoding,
    pub problem: Option<SourceProblem>,
}

#[derive(Clone, Copy)]
enum Codec {
    Utf8,
    Utf16 { little_endian: bool },
}

/// `pickEncoding`: codec, bytes to skip, label.
fn pick_encoding(bytes: &[u8]) -> (Codec, usize, Encoding) {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return (Codec::Utf8, 3, Encoding::Utf8Bom);
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return (
            Codec::Utf16 {
                little_endian: true,
            },
            2,
            Encoding::Utf16Le,
        );
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return (
            Codec::Utf16 {
                little_endian: false,
            },
            2,
            Encoding::Utf16Be,
        );
    }
    let sample = &bytes[..bytes.len().min(1024)];
    let (mut even_nuls, mut odd_nuls) = (0_usize, 0_usize);
    for (i, byte) in sample.iter().enumerate() {
        if *byte == 0 {
            if i % 2 == 0 {
                even_nuls += 1;
            } else {
                odd_nuls += 1;
            }
        }
    }
    let half = (sample.len() / 2).max(1);
    // `n > half * 0.3` and `n < half * 0.05`, in integers.
    if odd_nuls * 10 > half * 3 && even_nuls * 20 < half {
        return (
            Codec::Utf16 {
                little_endian: true,
            },
            0,
            Encoding::Utf16LeNoBom,
        );
    }
    if even_nuls * 10 > half * 3 && odd_nuls * 20 < half {
        return (
            Codec::Utf16 {
                little_endian: false,
            },
            0,
            Encoding::Utf16BeNoBom,
        );
    }
    (Codec::Utf8, 0, Encoding::Utf8)
}

/// The first 4096 UTF-16 code units of `text` (`text.slice(0, 4096)`).
fn sample_units(text: &str) -> impl Iterator<Item = u16> + '_ {
    text.encode_utf16().take(4096)
}

/// `bad / len > limit_numerator / limit_denominator` over the 4096-unit sample.
fn ratio_above(
    text: &str,
    is_bad: impl Fn(u16) -> bool,
    numerator: usize,
    denominator: usize,
) -> bool {
    let (mut bad, mut len) = (0_usize, 0_usize);
    for unit in sample_units(text) {
        len += 1;
        if is_bad(unit) {
            bad += 1;
        }
    }
    len > 0 && bad * denominator > len * numerator
}

/// `binaryRatio(text) > numerator / denominator`: U+FFFD and C0 controls other
/// than tab, LF and CR.
fn binary_ratio_above(text: &str, numerator: usize, denominator: usize) -> bool {
    let is_bad = |unit: u16| unit == 0xfffd || (unit < 0x20 && !matches!(unit, 0x09 | 0x0a | 0x0d));
    ratio_above(text, is_bad, numerator, denominator)
}

/// `nonAsciiRatio(text) > 0.05`.
fn non_ascii_ratio_above_5_percent(text: &str) -> bool {
    ratio_above(text, |unit| unit > 0x7f, 1, 20)
}

/// The WHATWG `windows-1252` decoder: Latin-1 except 0x80-0x9F.
pub fn decode_windows_1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}',
        '\u{017D}', '\u{008F}', '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
        '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
    ];
    bytes
        .iter()
        .map(|byte| match byte {
            0x80..=0x9f => HIGH[usize::from(byte - 0x80)],
            _ => char::from(*byte),
        })
        .collect()
}

/// `decodeLegacySingleByte`: Windows-1252, or `None` when the result is not
/// plausibly a hand history.
fn decode_legacy_single_byte(body: &[u8]) -> Option<String> {
    let legacy = decode_windows_1252(body);
    if binary_ratio_above(&legacy, 2, 100) || non_ascii_ratio_above_5_percent(&legacy) {
        None
    } else {
        Some(legacy)
    }
}

/// `TextDecoder` drops one leading U+FEFF (its `ignoreBOM` is false).
fn strip_one_bom(mut text: String) -> String {
    if text.starts_with('\u{FEFF}') {
        text.drain(..'\u{FEFF}'.len_utf8());
    }
    text
}

/// `new TextDecoder("utf-16le" | "utf-16be").decode(body)`, WHATWG semantics:
/// a lone surrogate is U+FFFD, and so is an odd trailing byte - once, even
/// when a lead surrogate is also pending.
pub fn decode_utf16(body: &[u8], little_endian: bool) -> String {
    let mut out = String::with_capacity(body.len() / 2);
    let mut pending_lead: Option<u16> = None;
    let (pairs, _) = body.as_chunks::<2>();
    for pair in pairs {
        let unit = if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        };
        if let Some(lead) = pending_lead.take() {
            if (0xdc00..=0xdfff).contains(&unit) {
                let code =
                    0x10000 + ((u32::from(lead) - 0xd800) << 10) + (u32::from(unit) - 0xdc00);
                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                continue;
            }
            out.push('\u{FFFD}');
        }
        match unit {
            0xd800..=0xdbff => pending_lead = Some(unit),
            0xdc00..=0xdfff => out.push('\u{FFFD}'),
            _ => out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{FFFD}')),
        }
    }
    if pending_lead.is_some() || body.len() % 2 == 1 {
        out.push('\u{FFFD}');
    }
    strip_one_bom(out)
}

/// `decodeSource(buffer)`.
pub fn decode_source(bytes: &[u8]) -> Decoded {
    if bytes.is_empty() {
        return Decoded {
            text: String::new(),
            encoding: Encoding::Utf8,
            problem: Some(SourceProblem::Empty),
        };
    }

    let (codec, offset, mut encoding) = pick_encoding(bytes);
    let body = &bytes[offset..];
    let text = match codec {
        Codec::Utf16 { little_endian } => decode_utf16(body, little_endian),
        // Strict first: invalid bytes are the whole signal the Windows-1252
        // fallback needs.
        Codec::Utf8 => match std::str::from_utf8(body) {
            Ok(text) => strip_one_bom(text.to_owned()),
            Err(_) => {
                if let Some(legacy) = decode_legacy_single_byte(body) {
                    encoding = Encoding::Windows1252;
                    legacy
                } else {
                    // `from_utf8_lossy` substitutes maximal subparts, which is
                    // what the WHATWG decoder does.
                    strip_one_bom(String::from_utf8_lossy(body).into_owned())
                }
            }
        },
    };

    if binary_ratio_above(&text, 5, 100) {
        return Decoded {
            text: String::new(),
            encoding,
            problem: Some(SourceProblem::Binary),
        };
    }

    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    let normalized = normalize_line_ends(text);
    if crate::js::trim(&normalized).is_empty() {
        return Decoded {
            text: String::new(),
            encoding,
            problem: Some(SourceProblem::NoText),
        };
    }
    Decoded {
        text: normalized,
        encoding,
        problem: None,
    }
}

/// `text.replace(/\r\n?/g, "\n")`.
pub fn normalize_line_ends(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect()
    }

    /// Every case `decode-vectors.mjs` recorded from the TypeScript.
    #[test]
    fn agrees_with_decode_source_on_the_recorded_vectors() {
        let text = include_str!("../tests/data/decode-vectors.json");
        let vectors: serde_json::Value = serde_json::from_str(text).expect("vectors parse");
        let cases = vectors["cases"].as_array().expect("cases");
        assert!(cases.len() > 100);
        let mut failures = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap_or_default();
            let decoded = decode_source(&from_hex(case["bytes"].as_str().unwrap_or_default()));
            let expected = (
                case["encoding"].as_str().unwrap_or_default(),
                case["problem"].as_str(),
                case["text"].as_str().unwrap_or_default(),
            );
            let actual = (
                decoded.encoding.label(),
                decoded.problem.map(SourceProblem::as_str),
                decoded.text.as_str(),
            );
            if actual != expected {
                failures.push(format!("{name}: expected {expected:?}, got {actual:?}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn reads_the_shapes_the_rooms_ship() {
        let d = decode_source(b"\xef\xbb\xbfHand #1\r\nSeat 1\rx");
        assert_eq!(
            (d.encoding, d.text.as_str()),
            (Encoding::Utf8Bom, "Hand #1\nSeat 1\nx")
        );
        let d = decode_source(b"\xff\xfeH\0i\0");
        assert_eq!((d.encoding, d.text.as_str()), (Encoding::Utf16Le, "Hi"));
        let d = decode_source(
            b"Winamax Poker - CashGame - HandId: #1 - Holdem no limit (0.01\x80/0.02\x80)",
        );
        assert_eq!(d.encoding, Encoding::Windows1252);
        assert!(d.text.ends_with("(0.01€/0.02€)"));
        // Too much non-ASCII for a hand history: UTF-8 with replacements,
        // which then reads as binary.
        assert_eq!(
            decode_source(b"Winamax \x80 5").problem,
            Some(SourceProblem::Binary)
        );
        assert_eq!(decode_source(b"").problem, Some(SourceProblem::Empty));
        assert_eq!(decode_source(b" \n\t").problem, Some(SourceProblem::NoText));
        assert_eq!(
            decode_source(&[1; 100]).problem,
            Some(SourceProblem::Binary)
        );
        // U+0085 is not whitespace to JavaScript, so it is text.
        assert_eq!(decode_source("\u{85}".as_bytes()).problem, None);
    }

    #[test]
    fn utf16_replacement_follows_whatwg() {
        assert_eq!(decode_utf16(&[0x61, 0, 0x3d, 0xd8], true), "a\u{FFFD}");
        assert_eq!(
            decode_utf16(&[0x61, 0, 0x3d, 0xd8, 0x41], true),
            "a\u{FFFD}"
        );
        assert_eq!(decode_utf16(&[0x00, 0xde, 0x62, 0], true), "\u{FFFD}b");
        assert_eq!(
            decode_utf16(&[0x3d, 0xd8, 0x3d, 0xd8, 0x00, 0xde], true),
            "\u{FFFD}😀"
        );
        assert_eq!(decode_utf16(&[0xff, 0xfe, 0x68, 0], true), "h");
    }

    #[test]
    fn windows_1252_maps_the_c1_range() {
        assert_eq!(
            decode_windows_1252(&[0x80, 0x81, 0x9f, 0xa0, 0xe9]),
            "€\u{81}Ÿ\u{a0}é"
        );
    }
}
