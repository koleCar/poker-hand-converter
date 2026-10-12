//! JavaScript regular expressions on the `regex` crate.
//!
//! The parsers are mostly regular expressions, and the `regex` crate reads the
//! same source text differently from JavaScript in ways that change matches:
//!
//! | JavaScript (no `u` flag)                  | `regex` default               |
//! | ----------------------------------------- | ----------------------------- |
//! | `\d` = `[0-9]`, `\w` = `[A-Za-z0-9_]`      | Unicode digits / word chars   |
//! | `\b` between ASCII word and non-word      | Unicode word boundary         |
//! | `\s` includes U+FEFF, excludes U+0085      | Unicode `White_Space`         |
//! | `.` excludes `\n`, `\r`, U+2028, U+2029    | excludes `\n` only            |
//! | `/i` folds ASCII letters only to ASCII     | Unicode simple case folding (`ſ` ~ `s`, `K` ~ `k`) |
//! | `{` that is not a quantifier is a literal  | syntax error                  |
//!
//! [`translate`] rewrites a JavaScript pattern into an equivalent `regex`
//! pattern, so a port can keep the TypeScript source text verbatim:
//!
//! ```
//! # use rail_core::js::regex::js_regex;
//! let re = js_regex(r"\bhi[\s/._-]?lo(?:w)?\b", "i");
//! assert!(re.is_match("Omaha Hi/Lo"));
//! assert!(!re.is_match("Omaha HiLoXyz"));
//! ```
//!
//! What it refuses rather than approximates, so a port has to rewrite the
//! pattern by hand (and test it): lookahead and lookbehind, backreferences,
//! the `u`/`v`/`y` flags, and - under `/i` - letters outside ASCII, whose
//! JavaScript folding (`toUpperCase`-based) differs from Unicode folding.
//!
//! Differences that remain and are the caller's to mind:
//!
//! - JavaScript matches UTF-16 code units, Rust matches `char`s: `.` matches
//!   half of an astral character in JavaScript and all of it here, and match
//!   offsets are UTF-16 indices there and byte offsets here.
//! - With the `m` flag JavaScript's `^`/`$` also break at `\r`, U+2028 and
//!   U+2029; here only at `\n`. Decoded input is LF-only (`decode_source`), so
//!   this only matters for text that did not come through it.
//! - `g`, `lastIndex` and `replace` templates are API, not syntax: `g` is
//!   accepted and ignored, and a replacement written `$1` in JavaScript must be
//!   written `${1}` for `regex` (which would read `$1a` as a group named `1a`).

use std::fmt::{self, Write as _};

use regex::Regex;

/// The JavaScript `\s` class, as `regex` syntax.
pub const WHITESPACE_CLASS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
/// Members of [`WHITESPACE_CLASS`] for use inside another class.
const WHITESPACE_MEMBERS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
const DIGIT_MEMBERS: &str = "0-9";
const WORD_MEMBERS: &str = "0-9A-Za-z_";
/// JavaScript's `.` without the `s` flag.
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

/// Why a JavaScript pattern has no faithful translation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateError {
    pub pattern: String,
    pub reason: String,
}

impl fmt::Display for TranslateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "/{}/: {}", self.pattern, self.reason)
    }
}

impl std::error::Error for TranslateError {}

/// Compiles a JavaScript pattern with JavaScript semantics.
///
/// # Panics
///
/// When the pattern cannot be translated or compiled. Patterns are source
/// constants, so this is a programming error that the port's own tests hit
/// the first time they run; use [`translate`] to handle it instead.
pub fn js_regex(pattern: &str, flags: &str) -> Regex {
    let translated = translate(pattern, flags).unwrap_or_else(|error| panic!("{error}"));
    Regex::new(&translated)
        .unwrap_or_else(|error| panic!("/{pattern}/{flags} -> {translated}: {error}"))
}

/// One-liner for a lazily compiled JavaScript pattern:
/// `static RE: LazyLock<Regex> = js_regex_lazy!(r"\d+", "i");`
#[macro_export]
macro_rules! js_regex_lazy {
    ($pattern:expr, $flags:expr) => {
        ::std::sync::LazyLock::new(|| $crate::js::regex::js_regex($pattern, $flags))
    };
}

/// The `regex` pattern that matches what JavaScript's `/pattern/flags` matches.
pub fn translate(pattern: &str, flags: &str) -> Result<String, TranslateError> {
    let fail = |reason: String| TranslateError {
        pattern: pattern.to_owned(),
        reason,
    };
    let mut ignore_case = false;
    let mut multiline = false;
    let mut dot_all = false;
    for flag in flags.chars() {
        match flag {
            'i' => ignore_case = true,
            'm' => multiline = true,
            's' => dot_all = true,
            'g' => {}
            other => return Err(fail(format!("flag `{other}` is not supported"))),
        }
    }
    let translator = Translator {
        chars: pattern.chars().collect(),
        pos: 0,
        ignore_case,
        multiline,
        dot_all,
    };
    translator.run().map_err(fail)
}

struct Translator {
    chars: Vec<char>,
    pos: usize,
    ignore_case: bool,
    multiline: bool,
    dot_all: bool,
}

/// One member of a character class.
enum ClassItem {
    Char(char),
    /// Pre-rendered members (`0-9`, the whitespace list).
    Set(&'static str),
    /// Pre-rendered negated set, nested as `[^...]`.
    NotSet(&'static str),
}

impl Translator {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += 1;
        Some(c)
    }

    fn run(mut self) -> Result<String, String> {
        let mut out = String::new();
        while let Some(c) = self.next() {
            match c {
                '\\' => self.escape(&mut out)?,
                '[' => self.class(&mut out)?,
                '.' => out.push_str(if self.dot_all { "(?s:.)" } else { DOT }),
                '^' => out.push_str(if self.multiline { "(?m:^)" } else { "^" }),
                '$' => out.push_str(if self.multiline { "(?m:$)" } else { "$" }),
                '(' => self.group(&mut out)?,
                ')' | '|' | '*' | '+' | '?' => out.push(c),
                '{' => {
                    if let Some(len) = self.quantifier_len() {
                        out.push('{');
                        for _ in 0..len {
                            if let Some(q) = self.next() {
                                out.push(q);
                            }
                        }
                    } else {
                        out.push_str(r"\{");
                    }
                }
                '}' => out.push_str(r"\}"),
                other => self.literal(&mut out, other)?,
            }
        }
        Ok(out)
    }

    /// Length of `\d+(,\d*)?}` at the cursor (just after a `{`), if any.
    fn quantifier_len(&self) -> Option<usize> {
        let mut i = 0;
        let digit = |c: Option<char>| c.is_some_and(|c| c.is_ascii_digit());
        if !digit(self.peek_at(i)) {
            return None;
        }
        while digit(self.peek_at(i)) {
            i += 1;
        }
        if self.peek_at(i) == Some(',') {
            i += 1;
            while digit(self.peek_at(i)) {
                i += 1;
            }
        }
        (self.peek_at(i) == Some('}')).then_some(i + 1)
    }

    fn group(&mut self, out: &mut String) -> Result<(), String> {
        if self.peek() != Some('?') {
            out.push('(');
            return Ok(());
        }
        match (self.peek_at(1), self.peek_at(2)) {
            (Some(':'), _) => {
                self.pos += 2;
                out.push_str("(?:");
                Ok(())
            }
            (Some('=' | '!'), _) | (Some('<'), Some('=' | '!')) => {
                Err("lookaround has no `regex` equivalent; rewrite the pattern by hand".to_owned())
            }
            (Some('<'), _) => {
                self.pos += 2;
                out.push_str("(?<");
                Ok(())
            }
            _ => Err("unsupported group syntax".to_owned()),
        }
    }

    fn literal(&self, out: &mut String, c: char) -> Result<(), String> {
        if self.ignore_case && c.is_ascii_alphabetic() {
            let _ = write!(
                out,
                "[{}{}]",
                c.to_ascii_lowercase(),
                c.to_ascii_uppercase()
            );
            return Ok(());
        }
        if self.ignore_case && is_cased(c) {
            return Err(format!(
                "`{c}` under /i: JavaScript folds non-ASCII letters with toUpperCase, \
                 not Unicode folding; rewrite the pattern by hand"
            ));
        }
        out.push_str(&regex::escape(c.encode_utf8(&mut [0; 4])));
        Ok(())
    }

    /// An escape outside a class; the backslash is consumed.
    fn escape(&mut self, out: &mut String) -> Result<(), String> {
        let Some(c) = self.next() else {
            return Err("pattern ends in a backslash".to_owned());
        };
        match c {
            'd' => out.push_str("[0-9]"),
            'D' => out.push_str("[^0-9]"),
            'w' => out.push_str("[0-9A-Za-z_]"),
            'W' => out.push_str("[^0-9A-Za-z_]"),
            's' => out.push_str(WHITESPACE_CLASS),
            'S' => {
                let _ = write!(out, "[^{WHITESPACE_MEMBERS}]");
            }
            'b' => out.push_str(r"(?-u:\b)"),
            'B' => out.push_str(r"(?-u:\B)"),
            '1'..='9' => return Err("backreferences are not supported".to_owned()),
            'k' => return Err("named backreferences are not supported".to_owned()),
            _ => {
                let ch = self.escaped_char(c)?;
                self.literal(out, ch)?;
            }
        }
        Ok(())
    }

    /// The character a character escape stands for (after the backslash and
    /// `c`), shared by both contexts. Annex B: an incomplete `\x`/`\u`/`\c` is
    /// the letter itself, and any other escaped character is itself.
    fn escaped_char(&mut self, c: char) -> Result<char, String> {
        Ok(match c {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'f' => '\u{0C}',
            'v' => '\u{0B}',
            '0' if !self.peek().is_some_and(|d| d.is_ascii_digit()) => '\0',
            '0' => return Err("legacy octal escapes are not supported".to_owned()),
            'x' => self.hex_escape(2).unwrap_or('x'),
            'u' => match self.hex_escape(4) {
                Some(ch) => ch,
                None if self.peek_at(0) == Some('{') => {
                    return Err("`\\u{...}` needs the u flag".to_owned());
                }
                None => {
                    if (0xD800..=0xDFFF).contains(&self.hex_value(4).unwrap_or(0)) {
                        return Err("surrogate escapes are not supported".to_owned());
                    }
                    'u'
                }
            },
            'c' => match self.peek() {
                Some(letter) if letter.is_ascii_alphabetic() => {
                    self.pos += 1;
                    char::from(u8::try_from(u32::from(letter) % 32).unwrap_or(0))
                }
                _ => return Err("`\\c` without a control letter".to_owned()),
            },
            other => other,
        })
    }

    fn hex_value(&self, len: usize) -> Option<u32> {
        let mut value = 0;
        for i in 0..len {
            value = value * 16 + self.peek_at(i)?.to_digit(16)?;
        }
        Some(value)
    }

    fn hex_escape(&mut self, len: usize) -> Option<char> {
        let value = self.hex_value(len)?;
        let ch = char::from_u32(value)?;
        self.pos += len;
        Some(ch)
    }

    /// A class; the `[` is consumed.
    fn class(&mut self, out: &mut String) -> Result<(), String> {
        let negated = self.peek() == Some('^');
        if negated {
            self.pos += 1;
        }
        if self.peek() == Some(']') {
            self.pos += 1;
            // `[]` matches nothing, `[^]` matches anything.
            out.push_str(if negated {
                "(?s:.)"
            } else {
                r"[^\x00-\x{10FFFF}]"
            });
            return Ok(());
        }
        let mut items: Vec<(ClassItem, Option<char>)> = Vec::new();
        loop {
            let Some(c) = self.next() else {
                return Err("unterminated character class".to_owned());
            };
            if c == ']' {
                break;
            }
            let item = if c == '\\' {
                self.class_escape()?
            } else {
                ClassItem::Char(c)
            };
            // A range needs a single character on both sides; otherwise (Annex
            // B) the hyphen is a literal.
            if let ClassItem::Char(low) = item
                && self.peek() == Some('-')
                && self.peek_at(1).is_some_and(|next| next != ']')
            {
                let save = self.pos;
                self.pos += 1;
                let high_item = match self.next() {
                    Some('\\') => self.class_escape()?,
                    Some(ch) => ClassItem::Char(ch),
                    None => return Err("unterminated character class".to_owned()),
                };
                if let ClassItem::Char(high) = high_item {
                    if high < low {
                        return Err(format!("range out of order: {low}-{high}"));
                    }
                    items.push((ClassItem::Char(low), Some(high)));
                    continue;
                }
                self.pos = save;
            }
            items.push((item, None));
        }

        out.push('[');
        if negated {
            out.push('^');
        }
        for (item, high) in &items {
            match (item, high) {
                (ClassItem::Char(low), Some(high)) => {
                    push_range(out, *low, *high);
                    if self.ignore_case {
                        self.fold_range(out, *low, *high)?;
                    }
                }
                (ClassItem::Char(ch), None) => {
                    push_range(out, *ch, *ch);
                    if self.ignore_case {
                        self.fold_range(out, *ch, *ch)?;
                    }
                }
                (ClassItem::Set(members), _) => out.push_str(members),
                (ClassItem::NotSet(members), _) => {
                    let _ = write!(out, "[^{members}]");
                }
            }
        }
        out.push(']');
        Ok(())
    }

    /// An escape inside a class; the backslash is consumed.
    fn class_escape(&mut self) -> Result<ClassItem, String> {
        let Some(c) = self.next() else {
            return Err("pattern ends in a backslash".to_owned());
        };
        Ok(match c {
            'd' => ClassItem::Set(DIGIT_MEMBERS),
            'D' => ClassItem::NotSet(DIGIT_MEMBERS),
            'w' => ClassItem::Set(WORD_MEMBERS),
            'W' => ClassItem::NotSet(WORD_MEMBERS),
            's' => ClassItem::Set(WHITESPACE_MEMBERS),
            'S' => ClassItem::NotSet(WHITESPACE_MEMBERS),
            // Inside a class `\b` is a backspace.
            'b' => ClassItem::Char('\u{08}'),
            '-' => ClassItem::Char('-'),
            '1'..='9' => return Err("octal escapes in classes are not supported".to_owned()),
            other => ClassItem::Char(self.escaped_char(other)?),
        })
    }

    /// Adds the other ASCII case of every letter in `low..=high`; refuses a
    /// range that holds non-ASCII letters (see the module docs).
    fn fold_range(&self, out: &mut String, low: char, high: char) -> Result<(), String> {
        for code in u32::from(low)..=u32::from(high) {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            if c.is_ascii_alphabetic() {
                let other = if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                };
                push_range(out, other, other);
            } else if is_cased(c) {
                return Err(format!(
                    "class member `{c}` under /i: JavaScript folds non-ASCII letters with \
                     toUpperCase, not Unicode folding; rewrite the pattern by hand"
                ));
            }
        }
        Ok(())
    }
}

/// Whether a character has a case mapping at all.
fn is_cased(c: char) -> bool {
    !c.is_ascii()
        && (c.to_uppercase().ne(std::iter::once(c)) || c.to_lowercase().ne(std::iter::once(c)))
}

/// `low-high` (or one character) as class members, every character escaped
/// numerically so no class metacharacter can be misread.
fn push_range(out: &mut String, low: char, high: char) {
    let _ = write!(out, r"\x{{{:X}}}", u32::from(low));
    if high != low {
        let _ = write!(out, r"-\x{{{:X}}}", u32::from(high));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pattern: &str, flags: &str, text: &str) -> bool {
        js_regex(pattern, flags).is_match(text)
    }

    #[test]
    fn digits_words_and_boundaries_are_ascii() {
        assert!(m(r"^\d+$", "", "123"));
        assert!(
            !m(r"^\d+$", "", "١٢٣"),
            "Arabic-Indic digits are not \\d in JS"
        );
        assert!(!m(r"^\w$", "", "é"));
        assert!(m(r"\bab\b", "", "é ab"));
        assert!(
            m(r"\bab", "", "éab"),
            "é is not a word character, so there is a boundary"
        );
        assert!(!m(r"\Bab", "", "éab"));
        assert!(m(r"x\B", "", "xy"));
    }

    #[test]
    fn whitespace_is_javascripts() {
        assert!(m(r"^\s$", "", "\u{FEFF}"));
        assert!(!m(r"^\s$", "", "\u{85}"));
        assert!(m(r"^\S$", "", "\u{85}"));
        assert!(m(r"^[\s]$", "", "\u{3000}"));
        assert!(m(r"^[^\S]$", "", " "));
    }

    #[test]
    fn the_whitespace_class_is_exactly_is_whitespace() {
        let (s, not_s) = (js_regex(r"^\s$", ""), js_regex(r"^[^\S]$", ""));
        for code in 0_u32..=0x10FFFF {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            let text = c.encode_utf8(&mut [0; 4]).to_owned();
            assert_eq!(
                s.is_match(&text),
                crate::js::is_whitespace(c),
                "U+{code:04X}"
            );
            assert_eq!(
                not_s.is_match(&text),
                crate::js::is_whitespace(c),
                "U+{code:04X}"
            );
        }
    }

    #[test]
    fn case_folding_is_ascii_only() {
        assert!(m("^short deck$", "i", "SHORT DECK"));
        assert!(!m("^s$", "i", "ſ"), "JS /s/i does not match the long s");
        assert!(
            !m("^k$", "i", "\u{212A}"),
            "JS /k/i does not match the Kelvin sign"
        );
        assert!(m("^[a-c]+$", "i", "AbC"));
        assert!(!m("^[a-c]+$", "", "AbC"));
        assert!(translate("é", "i").is_err());
        assert!(translate("[à-ÿ]", "i").is_err());
        assert!(translate("é", "").is_ok());
    }

    #[test]
    fn dot_and_anchors_follow_javascript() {
        assert!(!m("^a.b$", "", "a\rb"));
        assert!(!m("^a.b$", "", "a\u{2028}b"));
        assert!(m("^a.b$", "s", "a\nb"));
        assert!(m("^b", "m", "a\nb"));
        assert!(!m("^b", "", "a\nb"));
        assert!(
            !m("a$", "", "a\n"),
            "JS $ without m is the end of input only"
        );
    }

    #[test]
    fn braces_that_are_not_quantifiers_are_literals() {
        assert!(m(r"^a{2}$", "", "aa"));
        assert!(m(r"^a{2,}$", "", "aaa"));
        assert!(m(r"^a{,2}$", "", "a{,2}"));
        assert!(m(r"^\{x}$", "", "{x}"));
        assert!(m(r"^{$", "", "{"));
    }

    #[test]
    fn classes_ranges_and_escapes() {
        assert!(m(r"^[\d.,-]+$", "", "1,234.5-"));
        assert!(m(r"^[$\u20ac\u00a3\u20ae]$", "", "€"));
        assert!(m(r"^[\s/._-]$", "", "_"));
        assert!(m(r"^[a\-z]$", "", "-"));
        assert!(!m(r"^[a\-z]$", "", "b"));
        assert!(m(r"^[\w-]$", "", "-"));
        assert!(
            !m(r"^[]]$", "", "]"),
            "`[]` matches nothing, then `]` is a literal"
        );
        assert!(m(r"^[^]$", "", "\n"));
        assert!(!m(r"^[]$", "", "a"));
        assert!(m(r"^\x41\u0042\cJ$", "", "AB\n"));
        assert!(
            m(r"^\xZ$", "", "xZ"),
            "Annex B: an incomplete \\x is the letter"
        );
        assert!(m(r"^[\b]$", "", "\u{08}"));
        assert!(m(r"^\/\.\$$", "", "/.$"));
    }

    #[test]
    fn refuses_what_it_cannot_translate() {
        assert!(translate(r"a(?=b)", "").is_err());
        assert!(translate(r"(?<!a)b", "").is_err());
        assert!(translate(r"(a)\1", "").is_err());
        assert!(translate(r"a", "u").is_err());
        assert!(translate(r"a", "y").is_err());
        assert!(translate(r"(?<name>a)", "").is_ok());
    }

    #[test]
    fn groups_and_alternation_pass_through() {
        let re = js_regex(r"^(?:PL|NL|FL)?O-?8$", "i");
        assert!(re.is_match("plo8") && re.is_match("O-8") && !re.is_match("PLO9"));
        let caps = js_regex(r"(\d)\s*-\s*card", "i")
            .captures("5 - Card")
            .and_then(|c| c.get(1))
            .map(|g| g.as_str());
        assert_eq!(caps, Some("5"));
    }
}
