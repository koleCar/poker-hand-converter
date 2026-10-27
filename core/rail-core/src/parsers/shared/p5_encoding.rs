//! Encoding recovery for a UTF-16LE file that was read as UTF-8
//! (`web/src/lib/parsers/shared/p5-encoding.ts`).
//!
//! Read as UTF-8, a UTF-16LE file of ASCII text is every character followed by
//! U+0000, and its `FF FE` byte-order mark is two U+FFFD. Dropping those
//! restores the text exactly. (The converter's own decoder recognises UTF-16
//! first, so on that path this is a no-op; it matters for text that arrives
//! another way.)

/// `looksLikeMisdecodedUtf16`: a NUL in more than a quarter of the first 512
/// UTF-16 code units, and more than 8 of them.
pub fn looks_like_misdecoded_utf16(text: &str) -> bool {
    let sample = text.encode_utf16().take(512);
    let (mut len, mut nuls) = (0_usize, 0_usize);
    for unit in sample {
        len += 1;
        if unit == 0 {
            nuls += 1;
        }
    }
    len > 8 && nuls * 4 > len
}

/// `p5RecoverEncoding`: `text` with a mis-decoded UTF-16LE body and any
/// byte-order mark removed; text that is already fine comes back unchanged.
pub fn p5_recover_encoding(text: &str) -> String {
    let mut out = text.to_owned();
    if looks_like_misdecoded_utf16(&out) {
        // The BOM survives as two replacement characters; drop them with the NULs.
        if let Some(rest) = out.strip_prefix("\u{FFFD}\u{FFFD}") {
            out = rest.to_owned();
        }
        out.retain(|c| c != '\0');
    }
    match out.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_owned(),
        None => out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::utf16_len;

    fn misread(text: &str, bom: bool) -> String {
        let mut bytes = if bom { vec![0xff, 0xfe] } else { vec![] };
        for unit in text.encode_utf16() {
            bytes.extend(unit.to_le_bytes());
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[test]
    fn recovers_utf16le_read_as_utf8() {
        let text = "PokerStars Hand #1: Hold'em";
        assert!(looks_like_misdecoded_utf16(&misread(text, true)));
        assert_eq!(p5_recover_encoding(&misread(text, true)), text);
        assert_eq!(p5_recover_encoding(&misread(text, false)), text);
    }

    #[test]
    fn leaves_good_text_alone_except_a_bom() {
        assert_eq!(p5_recover_encoding("Hand #1"), "Hand #1");
        assert_eq!(p5_recover_encoding("\u{FEFF}Hand #1"), "Hand #1");
        assert_eq!(p5_recover_encoding("\u{FEFF}\u{FEFF}x"), "\u{FEFF}x");
        // A stray NUL is a corrupt byte, not an encoding.
        assert!(!looks_like_misdecoded_utf16("Hand #1\0 and more text here"));
        // Eight units or fewer never count.
        assert!(!looks_like_misdecoded_utf16("a\0b\0c\0d\0"));
        assert_eq!(utf16_len("a\0b\0c\0d\0e"), 9);
        assert!(looks_like_misdecoded_utf16("a\0b\0c\0d\0e"));
    }

    #[test]
    fn only_strips_replacement_characters_at_the_start() {
        let text = "\u{FFFD}\u{FFFD}a\0b\0c\0d\0e\0\u{FFFD}";
        assert_eq!(p5_recover_encoding(text), "abcde\u{FFFD}");
        let no_nuls = "\u{FFFD}\u{FFFD}abcdefghij";
        assert_eq!(p5_recover_encoding(no_nuls), no_nuls);
    }
}
