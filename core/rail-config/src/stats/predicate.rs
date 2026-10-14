//! The predicate language of a custom statistic (docs/RAIL-PLAN.md R2.10,
//! amendment A11; docs/STATS-SPEC.md §14): a counter defined as an
//! opportunity filter and an action filter over a seat's decision events.
//!
//! ```text
//! counter    := mode condition ("=>" condition)?
//! mode       := "first" | "any" | "each"
//! condition  := conj ("or" conj)*
//! conj       := neg ("and" neg)*
//! neg        := "not" neg | "(" condition ")" | test
//! test       := field
//!             | field ("=" | "!=" | "<" | "<=" | ">" | ">=") value
//!             | field "in" "(" value ("," value)* ")"
//! value      := number | word
//! number     := [0-9]+ ("." [0-9]{1,3})?
//! word       := [a-z_][a-z0-9_]*
//! ```
//!
//! `and` binds tighter than `or`; `not` tighter than both. The left side of
//! `=>` is the **opportunity**, the right side the **action** (without it,
//! every opportunity is also made). The mode says how a seat's events in one
//! hand count: `first` - the first event that is an opportunity counts once,
//! made if that event passes the action; `any` - once per hand if any event
//! is an opportunity, made if any opportunity passes the action; `each` -
//! every event, as the raw action counts do.
//!
//! The fields, their kinds and their words come from the caller
//! ([`FieldDef`]; `rail_stats::custom::FIELDS`), so this crate stays free of
//! the core, as the formula language's names do. A bare field must be a
//! yes/no field; a yes/no field compares to `true` or `false`; a choice
//! field compares with `=`, `!=` or `in` to its own words; a number field
//! with every comparison, to numbers with at most three decimals (kept as
//! thousandths, so `2.5` is exact). Nothing else is reachable: no
//! arithmetic, no functions, no other names. Bounded like a formula: at most
//! [`MAX_LENGTH`] bytes and [`MAX_DEPTH`] levels of nesting.
//!
//! Every error carries the byte offset and length of what it is about, for
//! an editor to underline.

use std::fmt;

/// The longest predicate accepted, in bytes.
pub const MAX_LENGTH: usize = 1000;
/// The deepest nesting accepted (parentheses and `not`).
pub const MAX_DEPTH: usize = 32;
/// The most values one `in (...)` lists.
pub const MAX_IN_VALUES: usize = 32;

/// Words the grammar keeps for itself: no field may be called so.
pub const KEYWORDS: [&str; 9] = [
    "first", "any", "each", "and", "or", "not", "in", "true", "false",
];

/// What a field holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind<'a> {
    /// Yes or no.
    Bool,
    /// A number, compared in thousandths.
    Number,
    /// One of these words.
    Choice(&'a [&'a str]),
}

/// One field the language can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldDef<'a> {
    pub name: &'a str,
    pub kind: FieldKind<'a>,
}

/// How a seat's events in one hand count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    /// The first opportunity, once.
    First,
    /// Any opportunity, once; made if any opportunity is made.
    Any,
    /// Every opportunity.
    Each,
}

impl Mode {
    /// The keyword.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Any => "any",
            Self::Each => "each",
        }
    }
}

/// A comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Cmp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

impl Cmp {
    /// The operator as written.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Ne => "!=",
            Self::Lt => "<",
            Self::Le => "<=",
            Self::Gt => ">",
            Self::Ge => ">=",
        }
    }

    /// `a cmp b`.
    pub fn holds<T: Ord>(self, a: &T, b: &T) -> bool {
        match self {
            Self::Eq => a == b,
            Self::Ne => a != b,
            Self::Lt => a < b,
            Self::Le => a <= b,
            Self::Gt => a > b,
            Self::Ge => a >= b,
        }
    }
}

/// A value on the right of a comparison, resolved against its field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Literal {
    Bool(bool),
    /// Thousandths.
    Number(i64),
    /// Index into the field's words.
    Choice(usize),
}

/// What is asked of one field.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Test {
    /// A bare yes/no field: it is yes.
    IsTrue,
    Cmp(Cmp, Literal),
    In(Vec<Literal>),
}

/// A parsed condition. `field` indexes the caller's field list.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Cond {
    Test { field: usize, test: Test },
    Not(Box<Cond>),
    And(Vec<Cond>),
    Or(Vec<Cond>),
}

impl Cond {
    /// Every field read, in order of appearance (repeats kept).
    pub fn fields(&self) -> Vec<usize> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect(&self, out: &mut Vec<usize>) {
        match self {
            Self::Test { field, .. } => out.push(*field),
            Self::Not(inner) => inner.collect(out),
            Self::And(parts) | Self::Or(parts) => {
                for part in parts {
                    part.collect(out);
                }
            }
        }
    }
}

/// A parsed counter definition.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Predicate {
    pub mode: Mode,
    pub opportunity: Cond,
    /// `None`: every opportunity is made.
    pub action: Option<Cond>,
}

/// Why a predicate did not parse: what, and the bytes it is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredicateError {
    pub offset: usize,
    /// Bytes from `offset` (0 at the end of the text).
    pub length: usize,
    pub message: String,
}

impl fmt::Display for PredicateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at offset {}", self.message, self.offset)
    }
}

impl std::error::Error for PredicateError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Word(String),
    Number(String),
    Cmp(Cmp),
    Arrow,
    Open,
    Close,
    Comma,
    End,
}

fn describe(token: &Token) -> String {
    match token {
        Token::Word(word) => format!("\"{word}\""),
        Token::Number(text) => format!("number {text}"),
        Token::Cmp(cmp) => format!("\"{}\"", cmp.as_str()),
        Token::Arrow => "\"=>\"".to_owned(),
        Token::Open => "\"(\"".to_owned(),
        Token::Close => "\")\"".to_owned(),
        Token::Comma => "\",\"".to_owned(),
        Token::End => "the end".to_owned(),
    }
}

/// (offset, length, token).
type Spanned = (usize, usize, Token);

fn error(offset: usize, length: usize, message: String) -> PredicateError {
    PredicateError {
        offset,
        length,
        message,
    }
}

fn tokenize(text: &str) -> Result<Vec<Spanned>, PredicateError> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        let byte = bytes[i];
        let token = match byte {
            b' ' | b'\t' | b'\n' | b'\r' => {
                i += 1;
                continue;
            }
            b'(' => Token::Open,
            b')' => Token::Close,
            b',' => Token::Comma,
            b'=' if bytes.get(i + 1) == Some(&b'>') => {
                i += 2;
                out.push((start, 2, Token::Arrow));
                continue;
            }
            b'=' => Token::Cmp(Cmp::Eq),
            b'!' if bytes.get(i + 1) == Some(&b'=') => {
                i += 2;
                out.push((start, 2, Token::Cmp(Cmp::Ne)));
                continue;
            }
            b'<' | b'>' => {
                let or_equal = bytes.get(i + 1) == Some(&b'=');
                let cmp = match (byte, or_equal) {
                    (b'<', false) => Cmp::Lt,
                    (b'<', true) => Cmp::Le,
                    (_, false) => Cmp::Gt,
                    (_, true) => Cmp::Ge,
                };
                let length = if or_equal { 2 } else { 1 };
                i += length;
                out.push((start, length, Token::Cmp(cmp)));
                continue;
            }
            b'0'..=b'9' => {
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'.' {
                    i += 1;
                    let fraction = i;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                    if i == fraction {
                        return Err(error(
                            start,
                            i - start,
                            "a number needs digits after its point".to_owned(),
                        ));
                    }
                }
                if i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
                    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_')
                    {
                        i += 1;
                    }
                    return Err(error(
                        start,
                        i - start,
                        "a name cannot start with a digit".to_owned(),
                    ));
                }
                out.push((start, i - start, Token::Number(text[start..i].to_owned())));
                continue;
            }
            b'a'..=b'z' | b'_' => {
                while i < bytes.len()
                    && (bytes[i].is_ascii_lowercase()
                        || bytes[i].is_ascii_digit()
                        || bytes[i] == b'_')
                {
                    i += 1;
                }
                out.push((start, i - start, Token::Word(text[start..i].to_owned())));
                continue;
            }
            _ => {
                let shown = text[start..].chars().next().unwrap_or('?');
                let length = shown.len_utf8();
                let hint = if shown.is_ascii_uppercase() {
                    " (names are lower case)"
                } else {
                    ""
                };
                return Err(error(
                    start,
                    length,
                    format!("unexpected character {shown:?}{hint}"),
                ));
            }
        };
        out.push((start, 1, token));
        i += 1;
    }
    out.push((text.len(), 0, Token::End));
    Ok(out)
}

/// `"2.5"` in thousandths; `None` past 10^12 or with more than three
/// decimals.
fn thousandths(text: &str) -> Result<i64, String> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if fraction.len() > 3 {
        return Err("a number has at most three digits after its point".to_owned());
    }
    let whole = whole.trim_start_matches('0');
    if whole.len() > 12 {
        return Err("a number up to 999999999999".to_owned());
    }
    let whole: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| "not a number".to_owned())?
    };
    let mut frac: i64 = 0;
    for (i, digit) in fraction.bytes().enumerate() {
        let place = match i {
            0 => 100,
            1 => 10,
            _ => 1,
        };
        frac += i64::from(digit - b'0') * place;
    }
    Ok(whole * 1000 + frac)
}

struct Parser<'v, 'a> {
    tokens: Vec<Spanned>,
    at: usize,
    depth: usize,
    fields: &'v [FieldDef<'a>],
}

impl Parser<'_, '_> {
    fn peek(&self) -> &Token {
        self.tokens
            .get(self.at)
            .map_or(&Token::End, |(_, _, token)| token)
    }

    fn span(&self) -> (usize, usize) {
        self.tokens
            .get(self.at)
            .map_or((0, 0), |(offset, length, _)| (*offset, *length))
    }

    fn next(&mut self) -> Spanned {
        let token = self
            .tokens
            .get(self.at)
            .cloned()
            .unwrap_or((0, 0, Token::End));
        if self.at < self.tokens.len() {
            self.at += 1;
        }
        token
    }

    fn here(&self, message: String) -> PredicateError {
        let (offset, length) = self.span();
        error(offset, length, message)
    }

    fn is_word(&self, word: &str) -> bool {
        matches!(self.peek(), Token::Word(w) if w == word)
    }

    fn enter(&mut self) -> Result<(), PredicateError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.here(format!("nested deeper than {MAX_DEPTH} levels")));
        }
        Ok(())
    }

    fn condition(&mut self) -> Result<Cond, PredicateError> {
        let mut parts = vec![self.conj()?];
        while self.is_word("or") {
            self.next();
            parts.push(self.conj()?);
        }
        Ok(if parts.len() == 1 {
            parts.remove(0)
        } else {
            Cond::Or(parts)
        })
    }

    fn conj(&mut self) -> Result<Cond, PredicateError> {
        let mut parts = vec![self.neg()?];
        while self.is_word("and") {
            self.next();
            parts.push(self.neg()?);
        }
        Ok(if parts.len() == 1 {
            parts.remove(0)
        } else {
            Cond::And(parts)
        })
    }

    fn neg(&mut self) -> Result<Cond, PredicateError> {
        if self.is_word("not") {
            self.next();
            self.enter()?;
            let inner = self.neg()?;
            self.depth -= 1;
            return Ok(Cond::Not(Box::new(inner)));
        }
        if *self.peek() == Token::Open {
            self.next();
            self.enter()?;
            let inner = self.condition()?;
            if *self.peek() != Token::Close {
                return Err(self.here(format!(
                    "expected \"and\", \"or\" or \")\", found {}",
                    describe(self.peek())
                )));
            }
            self.next();
            self.depth -= 1;
            return Ok(inner);
        }
        self.test()
    }

    fn test(&mut self) -> Result<Cond, PredicateError> {
        let (offset, length, token) = self.next();
        let name = match token {
            Token::Word(word) if !KEYWORDS.contains(&word.as_str()) => word,
            other => {
                return Err(error(
                    offset,
                    length,
                    format!(
                        "expected a field, \"not\" or \"(\", found {}",
                        describe(&other)
                    ),
                ));
            }
        };
        let Some(field) = self.fields.iter().position(|def| def.name == name) else {
            let hint = suggestion(&name, self.fields)
                .map(|near| format!("; did you mean {near}?"))
                .unwrap_or_default();
            return Err(error(
                offset,
                length,
                format!("unknown field \"{name}\"{hint}"),
            ));
        };
        let def = self.fields[field];
        match self.peek().clone() {
            Token::Cmp(cmp) => {
                let (cmp_offset, cmp_length) = self.span();
                self.next();
                if !matches!(cmp, Cmp::Eq | Cmp::Ne) && def.kind != FieldKind::Number {
                    return Err(error(
                        cmp_offset,
                        cmp_length,
                        format!(
                            "{} compares numbers; {name} is {}",
                            cmp.as_str(),
                            kind_words(def.kind)
                        ),
                    ));
                }
                let value = self.literal(&def)?;
                Ok(Cond::Test {
                    field,
                    test: Test::Cmp(cmp, value),
                })
            }
            Token::Word(word) if word == "in" => {
                let (in_offset, in_length) = self.span();
                self.next();
                if def.kind == FieldKind::Bool {
                    return Err(error(
                        in_offset,
                        in_length,
                        format!("{name} is yes or no: use {name} or not {name}"),
                    ));
                }
                if *self.peek() != Token::Open {
                    return Err(self.here(format!(
                        "expected \"(\" after in, found {}",
                        describe(self.peek())
                    )));
                }
                self.next();
                let mut values = vec![self.literal(&def)?];
                while *self.peek() == Token::Comma {
                    self.next();
                    if values.len() == MAX_IN_VALUES {
                        return Err(self.here(format!("at most {MAX_IN_VALUES} values in a list")));
                    }
                    values.push(self.literal(&def)?);
                }
                if *self.peek() != Token::Close {
                    return Err(self.here(format!(
                        "expected \",\" or \")\", found {}",
                        describe(self.peek())
                    )));
                }
                self.next();
                Ok(Cond::Test {
                    field,
                    test: Test::In(values),
                })
            }
            _ => {
                if def.kind != FieldKind::Bool {
                    return Err(error(
                        offset,
                        length,
                        format!(
                            "{name} is {}: compare it (for example {})",
                            kind_words(def.kind),
                            example(&def)
                        ),
                    ));
                }
                Ok(Cond::Test {
                    field,
                    test: Test::IsTrue,
                })
            }
        }
    }

    fn literal(&mut self, def: &FieldDef<'_>) -> Result<Literal, PredicateError> {
        let (offset, length, token) = self.next();
        let wrong = |what: String| error(offset, length, what);
        match (def.kind, token) {
            (FieldKind::Bool, Token::Word(word)) if word == "true" || word == "false" => {
                Ok(Literal::Bool(word == "true"))
            }
            (FieldKind::Bool, other) => Err(wrong(format!(
                "{} is true or false, not {}",
                def.name,
                describe(&other)
            ))),
            (FieldKind::Number, Token::Number(text)) => {
                thousandths(&text).map(Literal::Number).map_err(wrong)
            }
            (FieldKind::Number, other) => Err(wrong(format!(
                "{} is a number, not {}",
                def.name,
                describe(&other)
            ))),
            (FieldKind::Choice(words), Token::Word(word)) => {
                match words.iter().position(|candidate| *candidate == word) {
                    Some(index) => Ok(Literal::Choice(index)),
                    None => Err(wrong(format!(
                        "{} is one of {}; not \"{word}\"",
                        def.name,
                        words.join(", ")
                    ))),
                }
            }
            (FieldKind::Choice(words), other) => Err(wrong(format!(
                "{} is one of {}; not {}",
                def.name,
                words.join(", "),
                describe(&other)
            ))),
        }
    }
}

fn kind_words(kind: FieldKind<'_>) -> &'static str {
    match kind {
        FieldKind::Bool => "yes or no",
        FieldKind::Number => "a number",
        FieldKind::Choice(_) => "a choice",
    }
}

fn example(def: &FieldDef<'_>) -> String {
    match def.kind {
        FieldKind::Bool => def.name.to_owned(),
        FieldKind::Number => format!("{} >= 1", def.name),
        FieldKind::Choice(words) => format!("{} = {}", def.name, words.first().unwrap_or(&"x")),
    }
}

/// The closest field name, when one is a typo away (edit distance <= 2).
fn suggestion<'a>(name: &str, fields: &[FieldDef<'a>]) -> Option<&'a str> {
    fields
        .iter()
        .map(|def| (distance(name, def.name), def.name))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, field)| field)
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = if ca == *cb {
                previous
            } else {
                1 + previous.min(current).min(row[j])
            };
            previous = current;
        }
    }
    row[b.len()]
}

/// Parse and check a counter definition against `fields`.
pub fn parse(text: &str, fields: &[FieldDef<'_>]) -> Result<Predicate, PredicateError> {
    if text.len() > MAX_LENGTH {
        return Err(error(
            MAX_LENGTH,
            0,
            format!("longer than {MAX_LENGTH} bytes"),
        ));
    }
    let mut parser = Parser {
        tokens: tokenize(text)?,
        at: 0,
        depth: 0,
        fields,
    };
    let mode = match parser.peek() {
        Token::Word(word) if word == "first" => Mode::First,
        Token::Word(word) if word == "any" => Mode::Any,
        Token::Word(word) if word == "each" => Mode::Each,
        Token::End => return Err(parser.here("empty: start with first, any or each".to_owned())),
        other => {
            return Err(parser.here(format!(
                "start with first, any or each, not {}",
                describe(other)
            )));
        }
    };
    parser.next();
    if *parser.peek() == Token::End {
        return Err(parser.here("expected the opportunity after the mode".to_owned()));
    }
    let opportunity = parser.condition()?;
    let action = if *parser.peek() == Token::Arrow {
        parser.next();
        if *parser.peek() == Token::End {
            return Err(parser.here("expected the action after \"=>\"".to_owned()));
        }
        Some(parser.condition()?)
    } else {
        None
    };
    if *parser.peek() != Token::End {
        return Err(parser.here(format!(
            "expected \"and\", \"or\", \"=>\" or the end, found {}",
            describe(parser.peek())
        )));
    }
    Ok(Predicate {
        mode,
        opportunity,
        action,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREETS: [&str; 4] = ["preflop", "flop", "turn", "river"];
    const FIELDS: [FieldDef<'static>; 4] = [
        FieldDef {
            name: "street",
            kind: FieldKind::Choice(&STREETS),
        },
        FieldDef {
            name: "all_in",
            kind: FieldKind::Bool,
        },
        FieldDef {
            name: "size_pot",
            kind: FieldKind::Number,
        },
        FieldDef {
            name: "raise_level",
            kind: FieldKind::Number,
        },
    ];

    fn err(text: &str) -> (usize, usize, String) {
        let e = parse(text, &FIELDS).expect_err(text);
        (e.offset, e.length, e.message)
    }

    #[test]
    fn parses_modes_precedence_and_values() {
        let p = parse(
            "first street = flop and not all_in or raise_level >= 1.5 => size_pot in (33, 50.25)",
            &FIELDS,
        )
        .expect("parses");
        assert_eq!(p.mode, Mode::First);
        assert_eq!(
            p.opportunity,
            Cond::Or(vec![
                Cond::And(vec![
                    Cond::Test {
                        field: 0,
                        test: Test::Cmp(Cmp::Eq, Literal::Choice(1))
                    },
                    Cond::Not(Box::new(Cond::Test {
                        field: 1,
                        test: Test::IsTrue
                    })),
                ]),
                Cond::Test {
                    field: 3,
                    test: Test::Cmp(Cmp::Ge, Literal::Number(1500))
                },
            ])
        );
        assert_eq!(
            p.action,
            Some(Cond::Test {
                field: 2,
                test: Test::In(vec![Literal::Number(33_000), Literal::Number(50_250)])
            })
        );
        let p = parse("each (street = river)", &FIELDS).expect("parses");
        assert_eq!((p.mode, p.action), (Mode::Each, None));
        assert_eq!(p.opportunity.fields(), [0]);
        assert!(parse("any all_in = false => all_in != true", &FIELDS).is_ok());
        assert_eq!(thousandths("007.1"), Ok(7100));
    }

    #[test]
    fn errors_carry_offsets_and_lengths() {
        assert_eq!(err("").2, "empty: start with first, any or each");
        assert_eq!(
            err("last street = flop"),
            (
                0,
                4,
                "start with first, any or each, not \"last\"".to_owned()
            )
        );
        assert_eq!(
            err("first stret = flop"),
            (
                6,
                5,
                "unknown field \"stret\"; did you mean street?".to_owned()
            )
        );
        assert_eq!(
            err("first street = flp"),
            (
                15,
                3,
                "street is one of preflop, flop, turn, river; not \"flp\"".to_owned()
            )
        );
        assert_eq!(
            err("first street > flop"),
            (13, 1, "> compares numbers; street is a choice".to_owned())
        );
        assert_eq!(
            err("first size_pot"),
            (
                6,
                8,
                "size_pot is a number: compare it (for example size_pot >= 1)".to_owned()
            )
        );
        assert_eq!(
            err("first all_in in (true)"),
            (
                13,
                2,
                "all_in is yes or no: use all_in or not all_in".to_owned()
            )
        );
        assert_eq!(
            err("first size_pot > 1.2345"),
            (
                17,
                6,
                "a number has at most three digits after its point".to_owned()
            )
        );
        assert_eq!(
            err("first (all_in"),
            (
                13,
                0,
                "expected \"and\", \"or\" or \")\", found the end".to_owned()
            )
        );
        assert_eq!(
            err("first all_in =>"),
            (15, 0, "expected the action after \"=>\"".to_owned())
        );
        assert_eq!(
            err("first all_in all_in"),
            (
                13,
                6,
                "expected \"and\", \"or\", \"=>\" or the end, found \"all_in\"".to_owned()
            )
        );
        assert_eq!(
            err("first Street = flop").2,
            "unexpected character 'S' (names are lower case)"
        );
        assert_eq!(err("first 3x").2, "a name cannot start with a digit");
        assert_eq!(
            err("first and"),
            (
                6,
                3,
                "expected a field, \"not\" or \"(\", found \"and\"".to_owned()
            )
        );
        let deep = format!("first {}all_in{}", "(".repeat(40), ")".repeat(40));
        assert_eq!(err(&deep).2, "nested deeper than 32 levels");
        let long = format!("first {}", "not ".repeat(300));
        assert_eq!(err(&long).2, "longer than 1000 bytes");
        let many = format!("first raise_level in ({})", vec!["1"; 33].join(", "));
        assert_eq!(err(&many).2, "at most 32 values in a list");
    }
}
