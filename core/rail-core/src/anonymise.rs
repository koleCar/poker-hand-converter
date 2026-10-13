//! The anonymiser: a shareable sample of a file no parser reads
//! (docs/RAIL-PLAN.md R0.11).
//!
//! A file in the unsupported-format registry is, by definition, in a format
//! we cannot parse - so we cannot know where its player names are. This
//! module guesses, and guesses wide: every token that *could* be a name by
//! one of the rules below is collected from the whole text, and then every
//! occurrence of every collected token is replaced by a placeholder
//! (`Player1`, `Player2`, ... in order of first appearance; the same name
//! always gets the same placeholder). Amounts, cards, line structure and
//! everything else stay byte for byte, because that is what someone writing
//! a parser needs.
//!
//! **Where a name is looked for**
//!
//! - **Keyed values** - XML attributes, JSON members, `key = value` lines:
//!   `key="value"`, `"key": "value"`, `key: 'value'`, and quoted strings in a
//!   `key = [ ... ]` array, when the key looks like it holds a person
//!   ([`is_name_key`]: `name`, `nick`, `alias`, `player`, `user`, `login`,
//!   `screen`, `hero`, `winner`, `account`, `member`, `handle`, `owner`,
//!   `dealer`, ... and not `table`, `tournament`, `game`, `site`, ...).
//!   XML elements so named count too: `<nickname>Hero</nickname>`.
//! - **Seat lines**: `Seat 3: <name> ($1.00 in chips)`, any bracket and
//!   currency.
//! - **Action lines**: `<name>: posts|folds|calls|...`, `<name> folds`,
//!   `<name>     Call (0.25)` (column layouts), `Dealt to <name> [`,
//!   `... returned to <name>`, `<name> said, "`, `<name> has the button`,
//!   `Dealer: <name>`, `Small Blind: <name> (`, `Winner: <name>`, `<name>     (EUR 50 in seat 3)`.
//!
//! A value is not taken when it is empty, a placeholder word (`N/A`, `none`,
//! `true`, `Y`, ...), or one or two digits under a key that is a reference
//! rather than a name (`player="5"` is a seat number in the Merge format;
//! `player="1081005"` is taken, since some rooms use numeric ids as names).
//! XML-escaped and unescaped spellings of a name are both replaced.
//!
//! **Replacement** is token-bounded where the name's edge is a word
//! character: `Al` is replaced in `Al folds` but not inside `All-in`. A name
//! that is an ordinary word (`call`, `Button`) is replaced everywhere it
//! stands alone - the sample loses a little structure rather than keep a
//! name. The placeholder prefix is chosen so that it does not occur in the
//! input at all, so a placeholder can never be mistaken for, or coincide
//! with, a real name (`Player2` in the input gets `Anon1`, not `Player1`).
//!
//! **Limits** (docs/unsupported-formats.md says the same): a name that
//! appears *only* in free text no rule reads (a chat line in a layout we
//! have never seen, a name split across lines, a name encoded - base64,
//! percent-encoding, UTF-16 inside an attribute other than a name-keyed
//! one) survives. Microgaming's `unicodealias` (base64 of the name) is
//! replaced because its key contains `alias`. File names are not part of
//! the text; [`Anonymised::apply`] puts the same mapping over one.
//!
//! The guarantee is tested, not argued: `tests/anonymise.rs` runs this over
//! every corpus file and asserts that no player name the pipeline reads
//! from the file survives in the output.

use std::collections::HashSet;
use std::fmt;
use std::sync::LazyLock;

use regex::Regex;

/// Recorded with every sample (`unparsed_hands.anonymiser_version`): which
/// rules produced it. Bump it whenever a rule changes.
pub const ANONYMISER_VERSION: &str = "rail-anon/1";

/// The largest sample [`shareable_sample`] returns, in UTF-8 bytes. Half the
/// 128 KiB the database accepts for any `raw_text`; the database refuses a
/// desktop sample longer than this.
pub const SAMPLE_MAX_BYTES: usize = 65_536;

/// A text with its player names replaced.
///
/// `Debug` shows the counts only: the mapping holds the real names.
#[derive(Clone, PartialEq, Eq)]
pub struct Anonymised {
    /// The anonymised text.
    pub text: String,
    /// `true` when [`shareable_sample`] cut the text at [`SAMPLE_MAX_BYTES`].
    pub truncated: bool,
    /// Every spelling replaced and its placeholder, longest first.
    mapping: Vec<(String, String)>,
}

impl fmt::Debug for Anonymised {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Anonymised")
            .field("bytes", &self.text.len())
            .field("names", &self.names())
            .field("truncated", &self.truncated)
            .finish_non_exhaustive()
    }
}

impl Anonymised {
    /// How many distinct names were replaced.
    pub fn names(&self) -> usize {
        self.mapping
            .iter()
            .map(|(_, placeholder)| placeholder)
            .collect::<HashSet<_>>()
            .len()
    }

    /// The same replacement over another string - a file name, say. Names
    /// the text did not contain are not known here and are not replaced.
    pub fn apply(&self, other: &str) -> String {
        replace_all(other, &self.mapping)
    }
}

/// Replaces every player name the rules find in `text`.
pub fn anonymise(text: &str) -> Anonymised {
    let names = collect_names(text);
    let prefix = placeholder_prefix(text);
    let mapping = assign_placeholders(text, &names, &prefix);
    Anonymised {
        text: replace_all(text, &mapping),
        truncated: false,
        mapping,
    }
}

/// [`anonymise`], then cut to at most [`SAMPLE_MAX_BYTES`] at a line end
/// (inside a line only when the first line alone is longer). Names are
/// collected from the whole text before the cut. What the desktop app sends
/// to `unparsed_hands` with the user's consent.
pub fn shareable_sample(text: &str) -> Anonymised {
    let mut anonymised = anonymise(text);
    if anonymised.text.len() > SAMPLE_MAX_BYTES {
        let head = &anonymised.text[..floor_char_boundary(&anonymised.text, SAMPLE_MAX_BYTES)];
        let cut = head.rfind('\n').map_or(head.len(), |newline| newline + 1);
        anonymised.text.truncate(cut);
        anonymised.truncated = true;
    }
    anonymised
}

/// The largest char boundary at or below `index`.
pub(crate) fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    (0..=index)
        .rev()
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(0)
}

/* ------------------------------------------------------------- collection - */

/// Whether a key (attribute, JSON member, element) names a person.
pub fn is_name_key(key: &str) -> bool {
    const PERSON: [&str; 16] = [
        "name", "nick", "alias", "player", "user", "login", "screen", "hero", "winner", "loser",
        "account", "member", "handle", "owner", "dealer", "seatname",
    ];
    const NOT_A_PERSON: [&str; 16] = [
        "table", "tourn", "game", "site", "room", "club", "league", "session", "event", "file",
        "type", "kind", "currency", "limit", "stake", "count",
    ];
    let key = key.rsplit(':').next().unwrap_or(key).to_lowercase();
    PERSON.iter().any(|word| key.contains(word))
        && !NOT_A_PERSON.iter().any(|word| key.contains(word))
}

/// Keys whose value names a person outright, as opposed to `player` or
/// `dealer`, which formats also use for a seat number.
fn is_strict_name_key(key: &str) -> bool {
    let key = key.to_lowercase();
    ["name", "nick", "alias", "login", "screen", "handle"]
        .iter()
        .any(|word| key.contains(word))
}

/// Values that are placeholders, flags or empty, never a name worth hiding.
fn is_placeholder_value(value: &str) -> bool {
    const WORDS: [&str; 15] = [
        "n/a",
        "na",
        "none",
        "null",
        "nil",
        "undefined",
        "true",
        "false",
        "yes",
        "no",
        "y",
        "n",
        "-",
        "?",
        "",
    ];
    WORDS.contains(&value.trim().to_lowercase().as_str())
}

fn is_short_number(value: &str) -> bool {
    !value.is_empty() && value.len() <= 2 && value.bytes().all(|b| b.is_ascii_digit())
}

/// The first words of lines that are structure, not a player.
fn is_structural(candidate: &str) -> bool {
    const WORDS: [&str; 22] = [
        "seat",
        "table",
        "game",
        "hand",
        "board",
        "total",
        "uncalled",
        "dealt",
        "dealing",
        "main",
        "side",
        "pot",
        "rake",
        "the",
        "flop",
        "turn",
        "river",
        "preflop",
        "showdown",
        "summary",
        "level",
        "tournament",
    ];
    let first = candidate
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .next()
        .unwrap_or("")
        .to_lowercase();
    WORDS.contains(&first.as_str())
}

/// Candidates from the line rules: sane length, one line, no column gap.
/// (`[` is allowed: `/\ntiHer[]` is a PokerStars name.)
fn plausible_line_name(candidate: &str) -> bool {
    let len = candidate.chars().count();
    (1..=48).contains(&len)
        && !candidate.contains("  ")
        && !candidate.contains('\t')
        && !candidate.contains(": ")
        && !candidate.starts_with('*')
        && !is_short_number(candidate)
        && !is_placeholder_value(candidate)
}

macro_rules! lazy_regex {
    ($pattern:expr) => {
        LazyLock::new(|| Regex::new($pattern).expect("a valid anonymiser pattern"))
    };
}

/// `key="value"`, `key='value'`, `"key": "value"`.
static KEYED_VALUE: LazyLock<Regex> = lazy_regex!(
    r#"(?:^|[\s<{,;?&"'(])([A-Za-z_][\w.:-]*)["']?\s*[=:]\s*(?:"([^"\n]{1,128})"|'([^'\n]{1,128})')"#
);
/// `key = [ "a", "b" ]`, `"key": ["a", "b"]`: an array of strings only (an
/// array of objects is read member by member by [`KEYED_VALUE`]).
static KEYED_ARRAY: LazyLock<Regex> =
    lazy_regex!(r#"(?:^|[\s{,;"'])([A-Za-z_][\w.-]*)["']?\s*[=:]\s*\[([^\[\]{}]{0,8192})\]"#);
static QUOTED: LazyLock<Regex> = lazy_regex!(r#""([^"\n]{1,128})"|'([^'\n]{1,128})'"#);
/// `<tag ...>value</tag>`; the tags are compared in code (no back-references).
static ELEMENT_TEXT: LazyLock<Regex> =
    lazy_regex!(r"<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>([^<>\n]{1,128})</([A-Za-z_][\w:.-]*)\s*>");

/// The line rules: each captures `n`, a name.
static LINE_RULES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    const VERBS_LOWER: &str = r"posts|folds|checks|calls|bets|raises|re-raises|shows|mucks|collected|collects|wins|won|antes|straddles|discards|draws|stands pat|completes|is all-in|is sitting out|is away|is disconnected|is connected|is timed out|sits out|sits in|has timed out|has returned|has the button|has left|said|says|leaves|left the table|joins|joined|doesn't show|does not show|cashed|finished|receives|adds|re-buys|rebuys|was removed|ties";
    let patterns = [
        // Seat 3: name ($1.00 in chips) / Seat 4: name ( $10.98 ) / Seat 7: name (40.18€)
        r"(?m)^[ \t]*Seat[ \t]*#?[ \t]*\d{1,3}[ \t]*[:\-][ \t]*(?P<n>[^\n]+?)[ \t]*[(\[][ \t]*[^\s\d()\[\]]{0,4}[ \t]*\d".to_owned(),
        // name: posts small blind  /  name : Folds
        format!(r"(?m)^[ \t]*(?P<n>[^\n:]{{1,48}}?)[ \t]?:[ \t]+(?i:post|{VERBS_LOWER}|fold|check|call|bet|raise|show|muck|collect|win|ante|straddle|all-in|allin|card dealt|returned|timed out|sitting out|enter|leave|stand)\b"),
        // name folds  /  name posts small blind
        format!(r"(?m)^[ \t]*(?P<n>[^\s:][^\n:]{{0,46}}?)[ \t]+(?:{VERBS_LOWER})\b"),
        // name        Call  (0.25)   (column layouts)
        r"(?m)^[ \t]*(?P<n>\S(?:[^\n]{0,46}?\S)?)[ \t]{2,}(?:Call|Calls|Check|Checks|Bet|Bets|Raise|Raises|Fold|Folds|All-In|All-in|Allin|Show|Shows|Muck|Mucks|Post|Posts|Ante|Antes|Wins|Collect|Collects)\b".to_owned(),
        // name        (EUR 50.25 in seat 3)
        r"(?m)^[ \t]*(?P<n>\S(?:[^\n]{0,46}?\S)?)[ \t]{2,}\(".to_owned(),
        // Dealer: name / Small Blind: name (0.25) / Winner: name
        r"(?im)^[ \t]*(?:dealer|button|small blind|big blind|straddle|winner|winners|nickname|username|screen ?name|alias)[ \t]*:[ \t]+(?P<n>\S(?:[^\n]{0,46}?\S)?)(?:[ \t]{2,}|[ \t]*\(|[ \t]*$)".to_owned(),
        // Dealt to name [Ac Kd]  /  Dealt in name
        r"(?m)\bDealt (?:to|in) (?P<n>[^\n\[(]+?)[ \t]*(?:[\[(]|$)".to_owned(),
        // Uncalled bet ($1) returned to name
        r"(?m)\breturned to (?P<n>[^\n]+?)[ \t]*$".to_owned(),
        // name said, "..."
        r#"(?m)^[ \t]*(?P<n>[^\n]{1,48}?) said,? ""#.to_owned(),
    ];
    patterns
        .iter()
        .map(|pattern| Regex::new(pattern).expect("a valid anonymiser line rule"))
        .collect()
});

/// Every spelling of every name the rules find, deduplicated.
fn collect_names(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |raw: &str| {
        let trimmed = raw.trim();
        if trimmed.is_empty() || is_placeholder_value(trimmed) {
            return;
        }
        for spelling in [
            trimmed.to_owned(),
            xml_unescape(trimmed),
            xml_escape(trimmed),
        ] {
            if !spelling.is_empty() && seen.insert(spelling.clone()) {
                names.push(spelling);
            }
        }
    };

    let keyed_value = |key: &str, value: &str| -> bool {
        is_name_key(key) && !(is_short_number(value.trim()) && !is_strict_name_key(key))
    };

    for captures in KEYED_VALUE.captures_iter(text) {
        let key = captures.get(1).map_or("", |m| m.as_str());
        let Some(value) = captures.get(2).or_else(|| captures.get(3)) else {
            continue;
        };
        if keyed_value(key, value.as_str()) {
            add(value.as_str());
        }
    }
    for captures in KEYED_ARRAY.captures_iter(text) {
        let key = captures.get(1).map_or("", |m| m.as_str());
        if !is_name_key(key) {
            continue;
        }
        let body = captures.get(2).map_or("", |m| m.as_str());
        for quoted in QUOTED.captures_iter(body) {
            if let Some(value) = quoted.get(1).or_else(|| quoted.get(2))
                && keyed_value(key, value.as_str())
            {
                add(value.as_str());
            }
        }
    }
    for captures in ELEMENT_TEXT.captures_iter(text) {
        let open = captures.get(1).map_or("", |m| m.as_str());
        let close = captures.get(3).map_or("", |m| m.as_str());
        let value = captures.get(2).map_or("", |m| m.as_str());
        if open == close && keyed_value(open, value) {
            add(value);
        }
    }
    for rule in LINE_RULES.iter() {
        for captures in rule.captures_iter(text) {
            let Some(name) = captures.name("n") else {
                continue;
            };
            // A tag after the name (`UTG+2 [ME]`) is not part of it.
            let name = name.as_str();
            let name = name.split(" [").next().unwrap_or(name).trim();
            if plausible_line_name(name) && !is_structural(name) {
                add(name);
            }
        }
    }
    names
}

fn xml_unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn xml_escape(text: &str) -> String {
    if !text.contains(['&', '<', '>', '"', '\'']) {
        return text.to_owned();
    }
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/* ------------------------------------------------------------ replacement - */

/// A placeholder prefix that does not occur in `text`, in any case.
fn placeholder_prefix(text: &str) -> String {
    let lower = text.to_lowercase();
    for prefix in ["Player", "Anon", "Villain", "Nick"] {
        if !lower.contains(&prefix.to_lowercase()) {
            return prefix.to_owned();
        }
    }
    let mut prefix = "AnonX".to_owned();
    while lower.contains(&prefix.to_lowercase()) {
        prefix.push('X');
    }
    prefix
}

/// The matcher for a set of names: longest first, word-bounded at each edge
/// that is a word character. `None` for no names, or when the alternation
/// is too large to compile (then [`replace_all`] falls back to unbounded
/// substring replacement, which replaces at least as much).
fn matcher(names: &[&str]) -> Option<Regex> {
    if names.is_empty() {
        return None;
    }
    let is_word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let alternatives: Vec<String> = names
        .iter()
        .map(|name| {
            let start = if is_word(name.chars().next()) {
                r"\b"
            } else {
                ""
            };
            let end = if is_word(name.chars().last()) {
                r"\b"
            } else {
                ""
            };
            format!("{start}{}{end}", regex::escape(name))
        })
        .collect();
    regex::RegexBuilder::new(&alternatives.join("|"))
        .size_limit(1 << 26)
        .build()
        .ok()
}

/// Names sorted longest first (ties by text), so that `Incognito 1` wins
/// over `Incognito` where both start at one place.
fn longest_first(names: &[String]) -> Vec<&str> {
    let mut sorted: Vec<&str> = names.iter().map(String::as_str).collect();
    sorted.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    sorted.dedup();
    sorted
}

/// Numbers the names in order of first appearance in `text`. The spellings
/// of one name (escaped, unescaped) share its placeholder. A name the
/// bounded matcher never finds still gets one, after the others.
fn assign_placeholders(text: &str, names: &[String], prefix: &str) -> Vec<(String, String)> {
    let canonical = |name: &str| xml_unescape(name);
    let mut numbers: Vec<(String, usize)> = Vec::new();
    let number_of = |name: &str, numbers: &mut Vec<(String, usize)>| {
        let key = canonical(name);
        if !numbers.iter().any(|(known, _)| *known == key) {
            let next = numbers.len() + 1;
            numbers.push((key, next));
        }
    };
    let sorted = longest_first(names);
    if let Some(regex) = matcher(&sorted) {
        for found in regex.find_iter(text) {
            number_of(found.as_str(), &mut numbers);
        }
    }
    for name in &sorted {
        number_of(name, &mut numbers);
    }
    sorted
        .iter()
        .map(|name| {
            let key = canonical(name);
            let number = numbers
                .iter()
                .find(|(known, _)| *known == key)
                .map_or(0, |(_, number)| *number);
            ((*name).to_owned(), format!("{prefix}{number}"))
        })
        .collect()
}

fn replace_all(text: &str, mapping: &[(String, String)]) -> String {
    let names: Vec<&str> = mapping.iter().map(|(name, _)| name.as_str()).collect();
    let placeholder = |found: &str| {
        mapping
            .iter()
            .find(|(name, _)| name == found)
            .map_or_else(|| found.to_owned(), |(_, placeholder)| placeholder.clone())
    };
    match matcher(&names) {
        Some(regex) => regex
            .replace_all(text, |captures: &regex::Captures<'_>| {
                placeholder(&captures[0])
            })
            .into_owned(),
        None => mapping
            .iter()
            .fold(text.to_owned(), |out, (name, placeholder)| {
                out.replace(name.as_str(), placeholder)
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names_of(text: &str) -> Vec<String> {
        let mut names = collect_names(text);
        names.sort();
        names
    }

    #[test]
    fn seat_and_action_lines() {
        let text = "Game #1: Hold'em\nSeat 1: Hero ($1.00 in chips)\nSeat 2: Bob Smith ($2 in chips)\n\
                    Hero: posts small blind $0.01\nBob Smith: raises $0.04 to $0.06\nHero folds\n\
                    Uncalled bet ($0.04) returned to Bob Smith\nBob Smith collected $0.03 from pot\n";
        assert_eq!(names_of(text), ["Bob Smith", "Hero"]);
        let out = anonymise(text);
        assert_eq!(
            out.text,
            "Game #1: Hold'em\nSeat 1: Player1 ($1.00 in chips)\nSeat 2: Player2 ($2 in chips)\n\
             Player1: posts small blind $0.01\nPlayer2: raises $0.04 to $0.06\nPlayer1 folds\n\
             Uncalled bet ($0.04) returned to Player2\nPlayer2 collected $0.03 from pot\n"
        );
        assert_eq!(out.names(), 2);
    }

    #[test]
    fn keyed_values_xml_and_json() {
        let xml = r#"<game><player seat="1" name="Al &amp; Co" chips="5"/><action player="Al &amp; Co" seat="1"/><event player="5" amount="2"/><nickname>Zed</nickname><bets>N/A</bets></game>"#;
        let out = anonymise(xml);
        assert_eq!(
            out.text,
            // `player` is in the input, so the placeholders are `Anon<n>`.
            r#"<game><player seat="1" name="Anon1" chips="5"/><action player="Anon1" seat="1"/><event player="5" amount="2"/><nickname>Anon2</nickname><bets>N/A</bets></game>"#
        );
        let json = r#"{"tableName":"Oslo","players":[{"nickname":"neo","stack":100},{"playerName":"trinity"}],"winners":["neo"]}"#;
        assert_eq!(
            anonymise(json).text,
            r#"{"tableName":"Oslo","players":[{"nickname":"Anon1","stack":100},{"playerName":"Anon2"}],"winners":["Anon1"]}"#
        );
    }

    #[test]
    fn numeric_names_and_seat_references() {
        // A two-digit value under `player` is a seat; a long one is an id.
        let text = r#"<event player="12" value="3"/><event player="1081005" value="3"/>"#;
        assert_eq!(names_of(text), ["1081005"]);
        // Under a name key even a short number is a name.
        assert_eq!(names_of(r#"<seat nickname="7"/>"#), ["7"]);
    }

    #[test]
    fn bounded_replacement() {
        let text = "Seat 1: Al ($5)\nAl: raises $1 to $2 and is all-in\nAll-in for Al.\n";
        assert_eq!(
            anonymise(text).text,
            "Seat 1: Player1 ($5)\nPlayer1: raises $1 to $2 and is all-in\nAll-in for Player1.\n"
        );
    }

    #[test]
    fn the_prefix_never_occurs_in_the_input() {
        let text = "Seat 1: Player2 ($5)\nSeat 2: anonymous ($5)\nPlayer2 folds\n";
        let out = anonymise(text);
        assert_eq!(
            out.text,
            "Seat 1: Villain1 ($5)\nSeat 2: Villain2 ($5)\nVillain1 folds\n"
        );
    }

    #[test]
    fn column_layouts() {
        let text = "Players(max 6):\nPinokio1                    (EUR 50.25 in seat 3)\n\
                    pauli 1                     (EUR 49.75 in seat 4)\n\nDealer:                     pauli 1\n\
                    Small Blind:                Pinokio1    (0.25)\n\nPinokio1                    Call        (0.25)\n";
        assert_eq!(names_of(text), ["Pinokio1", "pauli 1"]);
    }

    #[test]
    fn structure_is_not_taken_for_names() {
        let text = "Table: 'Durban 02' 9-max Seat #7 is the button\nBoard: [Td Kc 5h]\n\
                    Total pot 19.82 | Rake 0.98\nSeat 7: morfrim (button) won 19.82\n\
                    The button is in seat #3\nMain pot $5 Side pot $2\n*** SHOW DOWN ***\n";
        assert_eq!(names_of(text), Vec::<String>::new());
    }

    #[test]
    fn a_sample_is_cut_at_a_line_end() {
        let line = format!("Seat 1: Somebody ({})\n", "9".repeat(100));
        let text = line.repeat(1000);
        let out = shareable_sample(&text);
        assert!(out.truncated);
        assert!(out.text.len() <= SAMPLE_MAX_BYTES);
        assert!(out.text.ends_with(")\n"));
        assert!(!out.text.contains("Somebody"));
        let short = shareable_sample("Seat 1: x ($1)\n");
        assert!(!short.truncated);
    }

    #[test]
    fn apply_maps_a_file_name() {
        let out = anonymise("Seat 1: kole1992 ($5)\n");
        assert_eq!(out.apply("HH kole1992 table.txt"), "HH Player1 table.txt");
        assert!(!format!("{out:?}").contains("kole1992"));
    }
}
