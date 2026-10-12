//! PHF ⇄ standard text: `frontend/src/lib/phf/serialize.ts` (R0.6).
//!
//! "Standard text" is the GG-style plain text the app has always produced.
//! PHF is the source of truth, but the text stays first-class because Holdem
//! Manager and PokerTracker import it, and they are byte sensitive: a
//! trailing space or `$0.5` against `$0.50` is the difference between a clean
//! import and a silent drop (docs/WEB.md, "The pipeline"). So the writer is
//! held to the TypeScript byte for byte - every golden hand's
//! `sha256(toStandardText(hand))` is in `testdata/golden/` - oddities
//! included.
//!
//! - [`to_standard_text`] / [`to_standard_text_with`] and
//!   [`to_standard_text_file`]: the writer (`toStandardText`,
//!   `toStandardTextFile`), with the presentation rules of `resolveTextStyle`
//!   (pinned [`PhfTextStyle`](super::PhfTextStyle) fields win, the rest is
//!   read off `meta.rawText` when the source is in this dialect).
//! - [`parse_standard_hand`], [`split_standard_hands`],
//!   [`parse_standard_text`]: the reader, which the `standard` parser
//!   ([`crate::parsers::standard`]) wraps. It is the writer's inverse over
//!   the GG reference files: `toStandardText(parse(chunk)) == chunk`.
//! - [`format_played_at`]: the header timestamp, through the slice of
//!   JavaScript's `Date` the TypeScript relies on (V8's ISO reading, with
//!   its day rollover and `24:00`; `serialize/date.rs`).
//!
//! **Patterns.** Every regular expression is the TypeScript source text,
//! compiled with JavaScript semantics by [`crate::js::regex`]; a test asserts
//! each one still appears verbatim in `serialize.ts`. The few that use
//! lookahead (which the `regex` crate does not have) are written out as code
//! next to their source text: the hand splitter, the decimal-style and
//! digit-grouping probes, `limitFromLabel`'s `\bLimit\b(?!\s*Hold)` and the
//! blank-deal-line probe. Multiline (`m`) patterns over `meta.rawText` scan
//! JavaScript lines - a line starts after `\n`, `\r`, U+2028 or U+2029 - not
//! `regex`'s `\n`-only lines.

mod date;
mod read;
mod write;

#[cfg(test)]
mod tests;

use std::sync::LazyLock;

use regex::Regex;

pub use self::date::format_played_at;
pub(crate) use self::date::parse_played_at;
pub use self::read::{
    STANDARD_TEXT_PARSER_VERSION, StandardContext, parse_standard_hand, parse_standard_text,
    split_standard_hands,
};
pub use self::write::{
    SerializeOptions, to_standard_text, to_standard_text_file, to_standard_text_file_with,
    to_standard_text_with,
};

/// `HEADER_REGEX`: the first line of a hand, with its id and the payload.
static HEADER: LazyLock<Regex> = crate::js_regex_lazy!(
    r"^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#([A-Za-z0-9_-]+):\s*(.*)$",
    "i"
);

/// `RUN_PREFIXES`: the word in front of a street marker for runout N.
const RUN_PREFIXES: [&str; 4] = ["FIRST", "SECOND", "THIRD", "FOURTH"];

/// `BOARD_LABEL_LINE` (`/^(?:FIRST|SECOND|THIRD)[ \t]*$/im`) for one line.
static BOARD_LABEL_LINE: LazyLock<Regex> =
    crate::js_regex_lazy!(r"^(?:FIRST|SECOND|THIRD)[ \t]*$", "i");

/// `text.replace(/^﻿/, "")`.
fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// `text.split(/\r?\n/)[0]`.
fn first_line(text: &str) -> &str {
    match text.split_once('\n') {
        Some((line, _)) => line.strip_suffix('\r').unwrap_or(line),
        None => text,
    }
}

/// A JavaScript line terminator: what `^` and `$` stop at under the `m` flag.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Byte offsets where `^` matches under JavaScript's `m` flag: 0 and after
/// every line terminator.
pub(crate) fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(
        text.char_indices()
            .filter(|(_, c)| is_line_terminator(*c))
            .map(|(i, c)| i + c.len_utf8()),
    )
}

/// The lines of `text` as JavaScript's `m`-flag `^…$` sees them.
fn js_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_line_terminator)
}

/// `/^(?:BOARD_LABEL_LINE)/im.test(text)`.
fn has_board_label_line(text: &str) -> bool {
    js_lines(text).any(|line| BOARD_LABEL_LINE.is_match(line))
}

/// `pattern.test(text)` for a pattern that starts with `^` under the `m`
/// flag: `anchored` (compiled without `m`) matched at the start of every
/// JavaScript line, returning the first match.
fn find_at_line_start<'t>(anchored: &Regex, text: &'t str) -> Option<&'t str> {
    line_starts(text).find_map(|start| anchored.find(&text[start..]).map(|m| m.as_str()))
}

/// `/^…/m.test(text)` for a pattern given without the `m` flag: whether
/// `anchored` matches at the start of some JavaScript line of `text`.
pub fn matches_at_line_start(anchored: &Regex, text: &str) -> bool {
    line_starts(text).any(|start| anchored.is_match(&text[start..]))
}

/// `Number(digits)` for a `\d+` capture, as a seat, size or level number;
/// `None` when it is beyond `u32` (a PHF cannot hold it).
fn number_u32(digits: &str) -> Option<u32> {
    crate::js::JsNumber::parse(digits)
        .to_i64()
        .and_then(|n| u32::try_from(n).ok())
}
