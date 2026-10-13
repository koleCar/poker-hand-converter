//! Decoding a file in pieces, the way `rail_core::decode::decode_source`
//! decodes it whole.
//!
//! The core decodes a whole file: it sniffs a BOM or a NUL pattern, tries
//! strict UTF-8, falls back to Windows-1252 (behind a plausibility guard) or
//! to lossy UTF-8, strips leading BOMs and turns CR / CRLF into LF. The
//! incremental reader reads a file from a stored byte offset, so it needs
//! the same text one piece at a time, plus the way back from a position in
//! that text to a byte offset in the file (to store where the last complete
//! hand ends). Hence a [`Codec`], fixed for a file once it has been read:
//!
//! - **The decision is the core's.** A read from offset 0 asks
//!   [`decode_source`] which encoding the bytes so far are ([`decide`]); a
//!   trailing UTF-8 sequence the writer has not finished is left out of that
//!   question, so a cut `é` does not make a UTF-8 file look like
//!   Windows-1252. Once something of the file is stored, its codec is
//!   remembered (in memory, and as `files.encoding` for the next start).
//! - **A BOM only at offset 0**: the BOM bytes and up to two `U+FEFF` after
//!   them are dropped (as `decode_source` does: one by its decoder, one by
//!   its own strip) only when a piece starts at 0. Elsewhere `U+FEFF` is
//!   text.
//! - **Whole code units only**: a UTF-16 piece ends on an even byte count
//!   and never after a lone lead surrogate; a UTF-8 piece never ends inside a
//!   sequence. What is cut off is not consumed - the next read starts there.
//! - **Line ends**: CR and CRLF become LF, as in the core. A CRLF cut
//!   between two reads gives an extra empty line at the start of the second
//!   piece, which is whitespace between hands (the reader never stores an
//!   offset between the CR and the LF of a hand's own lines: it stores the
//!   start of a hand, or the end of everything read).
//! - **Invalid UTF-8** in a file read as strict UTF-8 is not decoded here
//!   ([`Invalid`]): the reader decides again from the whole file (it may be
//!   Windows-1252 after an ASCII start, or lossy UTF-8).

use std::ops::ControlFlow;

use rail_core::decode::{Encoding, decode_source, decode_windows_1252};

/// How a file's bytes become text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Codec {
    /// UTF-8; `lossy` when the file has invalid sequences and the core read
    /// it with replacement characters (not plausible as Windows-1252).
    Utf8 { bom: bool, lossy: bool },
    /// One byte, one character (WHATWG `windows-1252`).
    Windows1252,
    /// UTF-16, read in code units of two bytes.
    Utf16 { little_endian: bool, bom: bool },
}

impl Codec {
    /// The codec for the core's encoding label. `lossy` applies to UTF-8.
    pub const fn from_encoding(encoding: Encoding, lossy: bool) -> Self {
        match encoding {
            Encoding::Utf8 => Self::Utf8 { bom: false, lossy },
            Encoding::Utf8Bom => Self::Utf8 { bom: true, lossy },
            Encoding::Utf16Le => Self::Utf16 {
                little_endian: true,
                bom: true,
            },
            Encoding::Utf16LeNoBom => Self::Utf16 {
                little_endian: true,
                bom: false,
            },
            Encoding::Utf16Be => Self::Utf16 {
                little_endian: false,
                bom: true,
            },
            Encoding::Utf16BeNoBom => Self::Utf16 {
                little_endian: false,
                bom: false,
            },
            Encoding::Windows1252 => Self::Windows1252,
        }
    }

    /// The codec stored as `files.encoding` (the core's label). UTF-8 comes
    /// back strict: a lossy file meets invalid bytes again and is decided
    /// anew.
    pub fn from_label(label: &str) -> Option<Self> {
        [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16LeNoBom,
            Encoding::Utf16Be,
            Encoding::Utf16BeNoBom,
            Encoding::Windows1252,
        ]
        .into_iter()
        .find(|encoding| encoding.label() == label)
        .map(|encoding| Self::from_encoding(encoding, false))
    }

    /// The core's encoding (and so its label).
    pub const fn encoding(self) -> Encoding {
        match self {
            Self::Utf8 { bom: false, .. } => Encoding::Utf8,
            Self::Utf8 { bom: true, .. } => Encoding::Utf8Bom,
            Self::Windows1252 => Encoding::Windows1252,
            Self::Utf16 {
                little_endian: true,
                bom: true,
            } => Encoding::Utf16Le,
            Self::Utf16 {
                little_endian: true,
                bom: false,
            } => Encoding::Utf16LeNoBom,
            Self::Utf16 {
                little_endian: false,
                bom: true,
            } => Encoding::Utf16Be,
            Self::Utf16 {
                little_endian: false,
                bom: false,
            } => Encoding::Utf16BeNoBom,
        }
    }

    /// Bytes of the byte-order mark at offset 0.
    const fn bom_len(self) -> usize {
        match self {
            Self::Utf8 { bom: true, .. } => 3,
            Self::Utf16 { bom: true, .. } => 2,
            _ => 0,
        }
    }

    /// The bytes the core skips at offset 0 of `bytes`: its BOM sniff runs
    /// before the encoding is settled, so a file that starts with a UTF-8
    /// BOM and turns out to be Windows-1252 loses those three bytes too.
    fn skipped_at_start(self, bytes: &[u8]) -> usize {
        match self {
            Self::Utf8 { .. } | Self::Windows1252 if bytes.starts_with(&[0xef, 0xbb, 0xbf]) => 3,
            _ => self.bom_len(),
        }
    }
}

/// What a read from offset 0 found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Text in this codec.
    Text(Codec),
    /// Not text: `decode_source`'s problem (`empty`, `no-text`, `binary`).
    Problem(rail_core::decode::SourceProblem),
}

/// The length of `bytes` without a trailing UTF-8 sequence that is
/// incomplete but could still be completed (a writer cut inside it).
pub fn without_incomplete_utf8_tail(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=len.min(3) {
        let tail = &bytes[len - back..];
        if let Err(error) = std::str::from_utf8(tail)
            && error.valid_up_to() == 0
            && error.error_len().is_none()
        {
            return len - back;
        }
        // Look further back only over continuation bytes.
        if tail[0] & 0xc0 != 0x80 {
            break;
        }
    }
    len
}

/// The length of `bytes` (from offset 0) without what a writer may not have
/// finished in `codec`: half a UTF-16 unit or a lone lead surrogate, or a
/// cut UTF-8 sequence. Windows-1252 has no such tail.
pub fn complete_len(codec: Codec, bytes: &[u8]) -> usize {
    match codec {
        Codec::Utf16 { little_endian, .. } => {
            let even = bytes.len() - bytes.len() % 2;
            let last = bytes.get(even.saturating_sub(2)..even).map(|unit| {
                if little_endian {
                    u16::from_le_bytes([unit[0], unit[1]])
                } else {
                    u16::from_be_bytes([unit[0], unit[1]])
                }
            });
            if last.is_some_and(|unit| (0xd800..=0xdbff).contains(&unit)) {
                even - 2
            } else {
                even
            }
        }
        Codec::Utf8 { .. } => without_incomplete_utf8_tail(bytes),
        Codec::Windows1252 => bytes.len(),
    }
}

/// The core's encoding decision for a file whose first `bytes` have been
/// written (a read from offset 0), and whether the text is lossy UTF-8.
pub fn decide(bytes: &[u8]) -> Decision {
    let sniffed = decode_source(bytes);
    // Decided again without what the writer may not have finished: half a
    // UTF-16 unit or pair (which the core would count as a replacement
    // character, and a short file as binary), or a cut UTF-8 sequence.
    let complete = match Codec::from_encoding(sniffed.encoding, false) {
        utf16 @ Codec::Utf16 { .. } => complete_len(utf16, bytes),
        _ => without_incomplete_utf8_tail(bytes),
    };
    let decoded = if complete == bytes.len() {
        sniffed
    } else {
        decode_source(&bytes[..complete])
    };
    if let Some(problem) = decoded.problem {
        return Decision::Problem(problem);
    }
    let codec = Codec::from_encoding(decoded.encoding, false);
    let codec = match codec {
        Codec::Utf8 { bom, .. } => {
            let body = &bytes[codec.bom_len().min(bytes.len())..];
            let body = &body[..without_incomplete_utf8_tail(body)];
            Codec::Utf8 {
                bom,
                lossy: std::str::from_utf8(body).is_err(),
            }
        }
        other => other,
    };
    Decision::Text(codec)
}

/// Strict UTF-8 met a byte sequence that is not UTF-8 (at this many bytes
/// into the piece).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid {
    pub at: usize,
}

/// A decoded piece of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    /// The text, line ends normalised, leading BOMs dropped at offset 0.
    pub text: String,
    /// Bytes of the piece the text covers; the rest (an unfinished code
    /// unit or sequence) is left for the next read.
    pub consumed: usize,
}

/// Every character of `bytes` with the number of bytes it took, in order,
/// until `f` breaks. Returns the bytes consumed (a trailing incomplete unit
/// is not, unless `at_eof`: then it is the core's replacement character),
/// or where strict UTF-8 failed.
fn for_each_char(
    codec: Codec,
    bytes: &[u8],
    at_eof: bool,
    mut f: impl FnMut(char, usize) -> ControlFlow<()>,
) -> Result<usize, Invalid> {
    let mut consumed = 0;
    let mut step = |ch: char, len: usize, consumed: &mut usize| -> ControlFlow<()> {
        let flow = f(ch, len);
        if flow.is_continue() {
            *consumed += len;
        }
        flow
    };
    match codec {
        Codec::Utf8 { lossy: false, .. } => {
            let valid = match std::str::from_utf8(bytes) {
                Ok(text) => text,
                Err(error) => {
                    if error.error_len().is_some() {
                        return Err(Invalid {
                            at: error.valid_up_to(),
                        });
                    }
                    // Incomplete at the end: decode up to it, leave the rest.
                    std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(|_| Invalid {
                        at: error.valid_up_to(),
                    })?
                }
            };
            for ch in valid.chars() {
                if step(ch, ch.len_utf8(), &mut consumed).is_break() {
                    break;
                }
            }
        }
        Codec::Utf8 { lossy: true, .. } => {
            let mut chunks = bytes.utf8_chunks().peekable();
            'chunks: while let Some(chunk) = chunks.next() {
                for ch in chunk.valid().chars() {
                    if step(ch, ch.len_utf8(), &mut consumed).is_break() {
                        break 'chunks;
                    }
                }
                let invalid = chunk.invalid();
                if invalid.is_empty() {
                    continue;
                }
                let at_end = chunks.peek().is_none();
                if at_end && !at_eof && without_incomplete_utf8_tail(invalid) == 0 {
                    break; // the writer has not finished this sequence
                }
                // `String::from_utf8_lossy`: one U+FFFD per maximal invalid
                // subpart, which is what `utf8_chunks` yields.
                if step('\u{FFFD}', invalid.len(), &mut consumed).is_break() {
                    break;
                }
            }
        }
        Codec::Windows1252 => {
            for ch in decode_windows_1252(bytes).chars() {
                if step(ch, 1, &mut consumed).is_break() {
                    break;
                }
            }
        }
        Codec::Utf16 { little_endian, .. } => {
            // `decode_utf16` of the core, unit by unit, except at the end: a
            // lone lead surrogate or an odd byte there is unfinished, not an
            // error.
            let (pairs, _) = bytes.as_chunks::<2>();
            let unit = |pair: &[u8; 2]| {
                if little_endian {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            };
            let mut i = 0;
            let mut stopped = false;
            while i < pairs.len() {
                let current = unit(&pairs[i]);
                let (ch, len) = match current {
                    0xd800..=0xdbff => match pairs.get(i + 1).map(unit) {
                        None => break, // unfinished pair
                        Some(trail @ 0xdc00..=0xdfff) => {
                            let code = 0x10000
                                + ((u32::from(current) - 0xd800) << 10)
                                + (u32::from(trail) - 0xdc00);
                            (char::from_u32(code).unwrap_or('\u{FFFD}'), 4)
                        }
                        Some(_) => ('\u{FFFD}', 2),
                    },
                    0xdc00..=0xdfff => ('\u{FFFD}', 2),
                    other => (char::from_u32(u32::from(other)).unwrap_or('\u{FFFD}'), 2),
                };
                if step(ch, len, &mut consumed).is_break() {
                    stopped = true;
                    break;
                }
                i += len / 2;
            }
            // At the end of the file the core makes one replacement
            // character of an unfinished pair and an odd byte together.
            let rest = bytes.len() - consumed;
            if at_eof && !stopped && rest > 0 {
                let _ = step('\u{FFFD}', rest, &mut consumed);
            }
        }
    }
    Ok(consumed)
}

/// Line-end normalisation and the leading-BOM rule on top of
/// [`for_each_char`]: calls `f(output, bytes)` per character, where
/// `output` is `None` for a character that leaves no text (a dropped BOM,
/// the LF of a CRLF).
fn for_each_output(
    codec: Codec,
    bytes: &[u8],
    at_start: bool,
    at_eof: bool,
    mut f: impl FnMut(Option<char>, usize) -> ControlFlow<()>,
) -> Result<usize, Invalid> {
    let mut skip = 0;
    if at_start {
        skip = codec.skipped_at_start(bytes);
        if bytes.len() < skip {
            return Ok(0); // the BOM is not all there yet
        }
        if skip > 0 && f(None, skip).is_break() {
            return Ok(0);
        }
    }
    let mut boms_left = if at_start { 2 } else { 0 };
    let mut after_cr = false;
    let consumed = for_each_char(codec, &bytes[skip..], at_eof, |ch, len| {
        if boms_left > 0 {
            if ch == '\u{FEFF}' {
                boms_left -= 1;
                return f(None, len);
            }
            boms_left = 0;
        }
        if ch == '\n' && after_cr {
            after_cr = false;
            return f(None, len);
        }
        after_cr = ch == '\r';
        f(Some(if after_cr { '\n' } else { ch }), len)
    })
    .map_err(|invalid| Invalid {
        at: invalid.at + skip,
    })?;
    Ok(consumed + skip)
}

/// Decode a piece of a file that starts at a character boundary (`at_start`:
/// at offset 0). `at_eof`: the writer is done (the give-up time has passed),
/// so an unfinished UTF-16 unit or (lossy) UTF-8 sequence at the end is
/// what the core makes of it, a replacement character, rather than left for
/// the next read.
pub fn decode_piece(
    codec: Codec,
    bytes: &[u8],
    at_start: bool,
    at_eof: bool,
) -> Result<Piece, Invalid> {
    let mut text = String::with_capacity(bytes.len());
    let consumed = for_each_output(codec, bytes, at_start, at_eof, |ch, _| {
        if let Some(ch) = ch {
            text.push(ch);
        }
        ControlFlow::Continue(())
    })?;
    Ok(Piece { text, consumed })
}

/// The byte offset, within `bytes`, of the character at `position` (a byte
/// index into [`decode_piece`]'s text of the same bytes). The LF of a CRLF
/// before it and a dropped BOM count as before it.
pub fn byte_offset_of(
    codec: Codec,
    bytes: &[u8],
    at_start: bool,
    position: usize,
) -> Result<usize, Invalid> {
    let mut out = 0;
    let mut raw = 0;
    for_each_output(codec, bytes, at_start, false, |ch, len| match ch {
        Some(_) if out >= position => ControlFlow::Break(()),
        Some(ch) => {
            out += ch.len_utf8();
            raw += len;
            ControlFlow::Continue(())
        }
        None => {
            raw += len;
            ControlFlow::Continue(())
        }
    })?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(text: &str, bom: bool) -> Vec<u8> {
        let mut out = if bom { vec![0xff, 0xfe] } else { Vec::new() };
        for unit in text.encode_utf16() {
            out.extend(unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn decides_like_the_core_but_ignores_an_unfinished_sequence() {
        // "é" cut after its first byte: strict UTF-8 fails on the whole, so
        // the core alone would say Windows-1252.
        let text = format!(
            "{}caf\u{e9}",
            "PokerStars Hand #1: Hold'em No Limit ".repeat(4)
        );
        let cut = text.as_bytes();
        let cut = &cut[..cut.len() - 1];
        assert_eq!(decode_source(cut).encoding, Encoding::Windows1252);
        assert_eq!(
            decide(cut),
            Decision::Text(Codec::Utf8 {
                bom: false,
                lossy: false
            })
        );
        assert_eq!(
            decide(b"\xef\xbb\xbfHand"),
            Decision::Text(Codec::Utf8 {
                bom: true,
                lossy: false
            })
        );
        assert_eq!(
            decide(&utf16le("Hand #1\r\n", true)[..5]),
            Decision::Text(Codec::Utf16 {
                little_endian: true,
                bom: true
            })
        );
        let winamax = [
            b"Winamax Poker - CashGame - HandId: #1 - Holdem no limit (0.01\x80/0.02\x80)"
                .as_slice(),
            b"\r\nTable: 'Lyon' 6-max (real money) Seat #1 is the button\r\n",
        ]
        .concat();
        assert_eq!(decide(&winamax), Decision::Text(Codec::Windows1252));
        assert!(matches!(decide(b""), Decision::Problem(_)));
    }

    #[test]
    fn pieces_join_to_the_whole_text() {
        let text = "\u{FEFF}Hand #1 \u{e9}\u{1F600}\r\nSeat 1\rx\n\u{FEFF}y\r\n";
        let cases: Vec<(Codec, Vec<u8>)> = vec![
            (
                Codec::Utf8 {
                    bom: true,
                    lossy: false,
                },
                [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat(),
            ),
            (
                Codec::Utf16 {
                    little_endian: true,
                    bom: true,
                },
                utf16le(text, true),
            ),
        ];
        for (codec, bytes) in cases {
            let whole = decode_source(&bytes).text;
            assert_eq!(
                decode_piece(codec, &bytes, true, false)
                    .expect("whole")
                    .text,
                whole
            );
            // Every cut that is not between a CR and its LF: the first piece
            // stops at a whole unit, the second starts where it stopped.
            for cut in 0..=bytes.len() {
                let first = decode_piece(codec, &bytes[..cut], true, false).expect("first");
                // The reader stores an offset only after some text.
                if first.text.is_empty() {
                    continue;
                }
                if first.text.ends_with('\n') && bytes.get(first.consumed) == Some(&b'\n') {
                    continue;
                }
                if matches!(codec, Codec::Utf16 { .. })
                    && first.text.ends_with('\n')
                    && bytes.get(first.consumed..first.consumed + 2) == Some(&[b'\n', 0])
                {
                    continue;
                }
                let second =
                    decode_piece(codec, &bytes[first.consumed..], first.consumed == 0, false)
                        .expect("second");
                assert_eq!(first.text + &second.text, whole, "{codec:?} cut at {cut}");
            }
        }
    }

    #[test]
    fn utf16_never_ends_inside_a_unit_or_a_pair() {
        let codec = Codec::Utf16 {
            little_endian: true,
            bom: false,
        };
        let bytes = utf16le("a\u{1F600}", false);
        let piece = decode_piece(codec, &bytes[..5], false, false).expect("piece");
        assert_eq!((piece.text.as_str(), piece.consumed), ("a", 2));
        let piece = decode_piece(codec, &bytes[..3], false, false).expect("piece");
        assert_eq!((piece.text.as_str(), piece.consumed), ("a", 2));
        let piece = decode_piece(codec, &bytes, false, false).expect("piece");
        assert_eq!((piece.text.as_str(), piece.consumed), ("a\u{1F600}", 6));
    }

    #[test]
    fn at_the_end_of_the_file_an_unfinished_unit_is_the_cores_replacement() {
        let codec = Codec::Utf16 {
            little_endian: true,
            bom: true,
        };
        // A lone lead surrogate and an odd byte: one U+FFFD, as the core.
        let text = "Seat 1: ab\n".repeat(10);
        let mut bytes = utf16le(&text, true);
        let whole = bytes.len();
        bytes.extend([0x3d, 0xd8, 0x41]);
        let expected = format!("{text}\u{FFFD}");
        assert_eq!(decode_source(&bytes).text, expected);
        let piece = decode_piece(codec, &bytes, true, true).expect("eof");
        assert_eq!(
            (piece.text.as_str(), piece.consumed),
            (expected.as_str(), bytes.len())
        );
        let piece = decode_piece(codec, &bytes, true, false).expect("not eof");
        assert_eq!(
            (piece.text.as_str(), piece.consumed),
            (text.as_str(), whole)
        );
    }

    #[test]
    fn a_bom_is_dropped_only_at_offset_0() {
        let codec = Codec::Utf8 {
            bom: false,
            lossy: false,
        };
        let bytes = "\u{FEFF}x".as_bytes();
        assert_eq!(
            decode_piece(codec, bytes, true, false).expect("start").text,
            "x"
        );
        assert_eq!(
            decode_piece(codec, bytes, false, false)
                .expect("middle")
                .text,
            "\u{FEFF}x"
        );
    }

    #[test]
    fn strict_utf8_reports_invalid_bytes_and_lossy_replaces_them() {
        let strict = Codec::Utf8 {
            bom: false,
            lossy: false,
        };
        assert_eq!(
            decode_piece(strict, b"ab\xffcd", false, false),
            Err(Invalid { at: 2 })
        );
        let lossy = Codec::Utf8 {
            bom: false,
            lossy: true,
        };
        let piece = decode_piece(lossy, b"ab\xffcd\xe2\x82", false, false).expect("lossy");
        assert_eq!((piece.text.as_str(), piece.consumed), ("ab\u{FFFD}cd", 5));
        assert_eq!(
            piece.text,
            String::from_utf8_lossy(b"ab\xffcd").into_owned()
        );
    }

    #[test]
    fn offsets_map_back_through_crlf_and_boms() {
        let codec = Codec::Utf16 {
            little_endian: true,
            bom: true,
        };
        let bytes = utf16le("A\r\nB\r\nC", true);
        let piece = decode_piece(codec, &bytes, true, false).expect("piece");
        assert_eq!(piece.text, "A\nB\nC");
        let at = |position| byte_offset_of(codec, &bytes, true, position).expect("offset");
        // BOM 2, "A" 2, CRLF 4: "B" starts at byte 8.
        assert_eq!(at(0), 2);
        assert_eq!(at(2), 8);
        assert_eq!(at(4), 14);
        assert_eq!(at(5), bytes.len());
    }
}
