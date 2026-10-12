//! JavaScript semantics the TypeScript reference depends on.
//!
//! The port is held to the TypeScript pipeline byte for byte (R0.3 goldens),
//! and a surprising amount of that pipeline's behaviour is not in its own code
//! but in the JavaScript built-ins it calls. Wherever Rust's standard library
//! answers the same question differently, the JavaScript answer lives here and
//! every port uses it rather than the Rust default:
//!
//! - [`is_whitespace`], [`trim`], [`collapse_whitespace`]: JavaScript's `\s`
//!   and `String.prototype.trim`. Not Rust's `char::is_whitespace` - JS
//!   includes U+FEFF and excludes U+0085.
//! - [`regex`](mod@regex): JavaScript regular expressions (non-Unicode mode,
//!   which is what every pattern in the tree uses) translated to the `regex`
//!   crate's syntax, with ASCII `\d`/`\w`/`\b`, JS `\s`, JS `.` and ASCII-only
//!   case folding.
//! - [`number`]: IEEE-754 doubles - `Number()`, `*`, `+`, `/`, `Math.round`,
//!   `toFixed`, `String(n)` - emulated in integer arithmetic, because the
//!   workspace denies float arithmetic and an amount must round exactly as the
//!   TypeScript rounded it.
//! - [`sort`]: `Array.prototype.sort(comparefn)` as V8 does it (TimSort),
//!   for comparators a `NaN` makes inconsistent.
//! - [`utf16_len`] and friends: JavaScript strings are UTF-16, so `length`,
//!   `slice` and `charCodeAt` count code units, not `char`s or bytes.

pub mod number;
pub mod regex;
pub mod sort;

pub use self::number::JsNumber;

/// An exception the TypeScript reference throws (`throw new Error(message)`)
/// where the port returns an error instead: the evaluator's `not a card: …`,
/// and through it `validateHand` and `assignHiLoHalves`. Carries the
/// `Error`'s `message`, which is what the pipeline records when it catches
/// one (`parser-error`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct JsError {
    pub message: String,
}

impl JsError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for JsError {}

/// A JavaScript string with a lone surrogate - a UTF-16 code unit from
/// U+D800 to U+DFFF not paired with its other half - which no Rust `String`
/// can hold. Where the TypeScript would go on with such a string (a numeric
/// character reference `&#xD800;`, a Base64 UTF-16 name that decodes to
/// one), the port stops and says so instead of carrying a different string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LoneSurrogate;

impl std::fmt::Display for LoneSurrogate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "the text holds a lone UTF-16 surrogate, which the TypeScript keeps in a \
             JavaScript string and Rust cannot represent",
        )
    }
}

impl std::error::Error for LoneSurrogate {}

/// UTF-16 code units as JavaScript joins them (`String.fromCharCode(...)`):
/// `Err` when a surrogate is left unpaired.
///
/// # Errors
///
/// [`LoneSurrogate`].
pub fn from_utf16(units: &[u16]) -> Result<String, LoneSurrogate> {
    String::from_utf16(units).map_err(|_| LoneSurrogate)
}

/// JavaScript's `\s` (and the set `String.prototype.trim` strips): the
/// ECMAScript WhiteSpace and LineTerminator productions.
///
/// Differs from [`char::is_whitespace`] in exactly two places: U+FEFF (the
/// byte-order mark) is whitespace here and not there, and U+0085 (NEL) is
/// whitespace there and not here.
pub const fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `String.prototype.trimStart`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_whitespace)
}

/// `text.replace(/\s+/g, " ")`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_whitespace(c) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `text.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `String.prototype.toUpperCase`: the locale-independent full Unicode
/// mapping (`ß` → `SS`), which is what [`str::to_uppercase`] implements.
pub fn to_upper_case(text: &str) -> String {
    text.to_uppercase()
}

/// `String.prototype.toLowerCase`, likewise [`str::to_lowercase`] (which
/// handles the final sigma the way JavaScript does).
pub fn to_lower_case(text: &str) -> String {
    text.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_is_javascripts_not_rusts() {
        // The two characters on which they disagree (testdata/golden/README.md,
        // "Fingerprints").
        assert!(is_whitespace('\u{FEFF}') && !'\u{FEFF}'.is_whitespace());
        assert!(!is_whitespace('\u{85}') && '\u{85}'.is_whitespace());
        // Everything else in the BMP agrees.
        for code in 0_u32..=0xFFFF {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            if c != '\u{FEFF}' && c != '\u{85}' {
                assert_eq!(is_whitespace(c), c.is_whitespace(), "U+{code:04X}");
            }
        }
    }

    #[test]
    fn trims_and_collapses_like_javascript() {
        assert_eq!(trim("\u{FEFF} a b \u{3000}"), "a b");
        assert_eq!(trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(
            collapse_whitespace("a \r\n\t b\u{FEFF}c\u{85}d"),
            "a b c\u{85}d"
        );
        assert_eq!(collapse_whitespace("  "), " ");
        assert_eq!(trim_start("  a "), "a ");
        assert_eq!(trim_end("  a "), "  a");
    }

    #[test]
    fn length_counts_utf16_code_units() {
        assert_eq!(utf16_len("a€"), 2);
        assert_eq!(utf16_len("a😀"), 3);
    }

    #[test]
    fn case_mapping_is_the_full_unicode_mapping() {
        assert_eq!(to_upper_case("eur"), "EUR");
        assert_eq!(to_upper_case("ß"), "SS");
        assert_eq!(to_upper_case("ﬁ"), "FI");
        assert_eq!(to_lower_case("ΟΔΟΣ"), "οδος");
    }
}
