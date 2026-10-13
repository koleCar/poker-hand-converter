//! The formula language of a display definition: a small expression grammar
//! over counter names, parsed here and evaluated by `rail_stats::display`
//! (and, identically, by `frontend/src/lib/stats/display.ts`).
//!
//! ```text
//! expr    := term (("+" | "-") term)*
//! term    := unary (("*" | "/") unary)*
//! unary   := "-" unary | atom
//! atom    := number | name | call | "(" expr ")"
//! call    := ("pct" | "sum") "(" expr ("," expr)* ")"
//! number  := [0-9]+ ("." [0-9]+)?
//! name    := [a-z_][a-z0-9_]*
//! ```
//!
//! Binary operators are left-associative, `*` and `/` bind tighter than `+`
//! and `-`. `pct(made, opportunities)` is `made * 100 / opportunities` with no
//! value unless `opportunities > 0` (`rates.ts`'s `pct`); `sum(a, b, c)` is
//! `(a + b) + c`. Nothing else: no comparisons, no conditionals, no other
//! functions, no way to reach anything but the numbers the caller binds to
//! the names. Bounded: at most [`MAX_LENGTH`] characters and [`MAX_DEPTH`]
//! levels of nesting.

use std::fmt;

/// The longest formula accepted, in bytes (the schema's `maxLength`).
pub const MAX_LENGTH: usize = 1000;
/// The deepest nesting accepted (parentheses, calls, unary minus).
pub const MAX_DEPTH: usize = 32;

/// A binary operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
}

impl Op {
    fn symbol(self) -> char {
        match self {
            Self::Add => '+',
            Self::Sub => '-',
            Self::Mul => '*',
            Self::Div => '/',
        }
    }
}

/// A parsed formula.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    /// A decimal literal, as written (`100`, `0.5`); the evaluator reads it
    /// as JavaScript's `Number(text)` does.
    Number(String),
    /// A counter, money column or other input the caller binds.
    Name(String),
    /// Unary minus.
    Neg(Box<Expr>),
    /// `left op right`.
    Binary {
        op: Op,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// `pct(made, opportunities)`.
    Pct(Box<Expr>, Box<Expr>),
    /// `sum(a, ...)`, at least one term.
    Sum(Vec<Expr>),
}

impl Expr {
    /// Every name the formula reads, in order of appearance (repeats kept).
    pub fn names(&self) -> Vec<&str> {
        let mut out = Vec::new();
        self.collect_names(&mut out);
        out
    }

    fn collect_names<'a>(&'a self, out: &mut Vec<&'a str>) {
        match self {
            Self::Number(_) => {}
            Self::Name(name) => out.push(name),
            Self::Neg(inner) => inner.collect_names(out),
            Self::Binary { left, right, .. } | Self::Pct(left, right) => {
                left.collect_names(out);
                right.collect_names(out);
            }
            Self::Sum(terms) => {
                for term in terms {
                    term.collect_names(out);
                }
            }
        }
    }
}

/// Fully parenthesised, so the printed form shows how it was parsed.
impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(text) | Self::Name(text) => f.write_str(text),
            Self::Neg(inner) => write!(f, "(-{inner})"),
            Self::Binary { op, left, right } => write!(f, "({left} {} {right})", op.symbol()),
            Self::Pct(made, opp) => write!(f, "pct({made}, {opp})"),
            Self::Sum(terms) => {
                f.write_str("sum(")?;
                for (i, term) in terms.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{term}")?;
                }
                f.write_str(")")
            }
        }
    }
}

/// Why a formula did not parse: what, and the byte offset where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub offset: usize,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at offset {}", self.message, self.offset)
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Number(String),
    Name(String),
    Open,
    Close,
    Comma,
    Op(Op),
    End,
}

fn describe(token: &Token) -> String {
    match token {
        Token::Number(text) => format!("number {text}"),
        Token::Name(name) => format!("name {name}"),
        Token::Open => "\"(\"".to_owned(),
        Token::Close => "\")\"".to_owned(),
        Token::Comma => "\",\"".to_owned(),
        Token::Op(op) => format!("\"{}\"", op.symbol()),
        Token::End => "the end".to_owned(),
    }
}

fn tokenize(text: &str) -> Result<Vec<(usize, Token)>, ParseError> {
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
            b'+' => Token::Op(Op::Add),
            b'-' => Token::Op(Op::Sub),
            b'*' => Token::Op(Op::Mul),
            b'/' => Token::Op(Op::Div),
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
                        return Err(ParseError {
                            offset: start,
                            message: "a number needs digits after its point".to_owned(),
                        });
                    }
                }
                if i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
                    return Err(ParseError {
                        offset: start,
                        message: "a name cannot start with a digit".to_owned(),
                    });
                }
                out.push((start, Token::Number(text[start..i].to_owned())));
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
                out.push((start, Token::Name(text[start..i].to_owned())));
                continue;
            }
            _ => {
                let shown = text[start..].chars().next().unwrap_or('?');
                return Err(ParseError {
                    offset: start,
                    message: format!("unexpected character {shown:?}"),
                });
            }
        };
        out.push((start, token));
        i += 1;
    }
    out.push((text.len(), Token::End));
    Ok(out)
}

struct Parser {
    tokens: Vec<(usize, Token)>,
    at: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        self.tokens
            .get(self.at)
            .map_or(&Token::End, |(_, token)| token)
    }

    fn offset(&self) -> usize {
        self.tokens.get(self.at).map_or(0, |(offset, _)| *offset)
    }

    fn next(&mut self) -> Token {
        let token = self.peek().clone();
        if self.at < self.tokens.len() {
            self.at += 1;
        }
        token
    }

    fn error(&self, message: String) -> ParseError {
        ParseError {
            offset: self.offset(),
            message,
        }
    }

    fn expect(&mut self, wanted: &Token, what: &str) -> Result<(), ParseError> {
        if self.peek() == wanted {
            self.next();
            Ok(())
        } else {
            Err(self.error(format!("expected {what}, found {}", describe(self.peek()))))
        }
    }

    fn enter(&mut self) -> Result<(), ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error(format!("nested deeper than {MAX_DEPTH} levels")));
        }
        Ok(())
    }

    fn expr(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.term()?;
        while let Token::Op(op @ (Op::Add | Op::Sub)) = *self.peek() {
            self.next();
            let right = self.term()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn term(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.unary()?;
        while let Token::Op(op @ (Op::Mul | Op::Div)) = *self.peek() {
            self.next();
            let right = self.unary()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, ParseError> {
        if *self.peek() == Token::Op(Op::Sub) {
            self.next();
            self.enter()?;
            let inner = self.unary()?;
            self.depth -= 1;
            return Ok(Expr::Neg(Box::new(inner)));
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<Expr, ParseError> {
        let offset = self.offset();
        match self.next() {
            Token::Number(text) => Ok(Expr::Number(text)),
            Token::Name(name) => {
                if *self.peek() != Token::Open {
                    return Ok(Expr::Name(name));
                }
                self.next();
                self.enter()?;
                let mut args = vec![self.expr()?];
                while *self.peek() == Token::Comma {
                    self.next();
                    args.push(self.expr()?);
                }
                self.expect(&Token::Close, "\",\" or \")\"")?;
                self.depth -= 1;
                call(&name, args).map_err(|message| ParseError { offset, message })
            }
            Token::Open => {
                self.enter()?;
                let inner = self.expr()?;
                self.expect(&Token::Close, "\")\"")?;
                self.depth -= 1;
                Ok(inner)
            }
            other => Err(ParseError {
                offset,
                message: format!(
                    "expected a number, a name or \"(\", found {}",
                    describe(&other)
                ),
            }),
        }
    }
}

fn call(name: &str, mut args: Vec<Expr>) -> Result<Expr, String> {
    match name {
        "pct" => {
            if args.len() != 2 {
                return Err(format!(
                    "pct takes 2 arguments (made, opportunities), not {}",
                    args.len()
                ));
            }
            let opp = args.pop().unwrap_or(Expr::Number(String::new()));
            let made = args.pop().unwrap_or(Expr::Number(String::new()));
            Ok(Expr::Pct(Box::new(made), Box::new(opp)))
        }
        "sum" => Ok(Expr::Sum(args)),
        other => Err(format!("unknown function {other:?} (pct and sum exist)")),
    }
}

/// Parse a formula. Names are not checked here (see
/// [`crate::stats::load_stats`]); the grammar, the functions and their
/// arguments, the length and the depth are.
pub fn parse(text: &str) -> Result<Expr, ParseError> {
    if text.len() > MAX_LENGTH {
        return Err(ParseError {
            offset: MAX_LENGTH,
            message: format!("longer than {MAX_LENGTH} bytes"),
        });
    }
    let mut parser = Parser {
        tokens: tokenize(text)?,
        at: 0,
        depth: 0,
    };
    if *parser.peek() == Token::End {
        return Err(parser.error("empty formula".to_owned()));
    }
    let expr = parser.expr()?;
    if *parser.peek() != Token::End {
        return Err(parser.error(format!(
            "expected an operator or the end, found {}",
            describe(parser.peek())
        )));
    }
    Ok(expr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(text: &str) -> String {
        parse(text).map_or_else(|e| format!("error: {e}"), |expr| expr.to_string())
    }

    #[test]
    fn precedence_and_associativity() {
        assert_eq!(shown("a + b * c"), "(a + (b * c))");
        assert_eq!(shown("a - b - c"), "((a - b) - c)");
        assert_eq!(shown("a / 1000 / b * 100"), "(((a / 1000) / b) * 100)");
        assert_eq!(shown("-a * b"), "((-a) * b)");
        assert_eq!(shown("--a"), "(-(-a))");
        assert_eq!(shown("(a + b) * c"), "((a + b) * c)");
        assert_eq!(shown("pct(sum(a, b), c)"), "pct(sum(a, b), c)");
        assert_eq!(shown(" 0.5\t*\nx_1 "), "(0.5 * x_1)");
    }

    #[test]
    fn refuses_what_is_not_the_grammar() {
        for (text, message) in [
            ("", "empty formula at offset 0"),
            (
                "a +",
                "expected a number, a name or \"(\", found the end at offset 3",
            ),
            (
                "a b",
                "expected an operator or the end, found name b at offset 2",
            ),
            ("(a", "expected \")\", found the end at offset 2"),
            (
                "a)",
                "expected an operator or the end, found \")\" at offset 1",
            ),
            ("1.", "a number needs digits after its point at offset 0"),
            (".5", "unexpected character '.' at offset 0"),
            ("2x", "a name cannot start with a digit at offset 0"),
            ("A", "unexpected character 'A' at offset 0"),
            ("a % b", "unexpected character '%' at offset 2"),
            ("a ^ b", "unexpected character '^' at offset 2"),
            (
                "pct(a)",
                "pct takes 2 arguments (made, opportunities), not 1 at offset 0",
            ),
            (
                "pct(a, b, c)",
                "pct takes 2 arguments (made, opportunities), not 3 at offset 0",
            ),
            (
                "sum()",
                "expected a number, a name or \"(\", found \")\" at offset 4",
            ),
            (
                "max(a, b)",
                "unknown function \"max\" (pct and sum exist) at offset 0",
            ),
            (
                "a, b",
                "expected an operator or the end, found \",\" at offset 1",
            ),
            ("1e3", "a name cannot start with a digit at offset 0"),
            ("a == b", "unexpected character '=' at offset 2"),
            ("vpip;drop", "unexpected character ';' at offset 4"),
        ] {
            assert_eq!(shown(text), format!("error: {message}"), "{text:?}");
        }
    }

    #[test]
    fn bounded() {
        let deep = format!(
            "{}a{}",
            "(".repeat(MAX_DEPTH + 1),
            ")".repeat(MAX_DEPTH + 1)
        );
        assert!(shown(&deep).contains("nested deeper"));
        let ok = format!("{}a{}", "(".repeat(MAX_DEPTH), ")".repeat(MAX_DEPTH));
        assert_eq!(shown(&ok), "a");
        let long = vec!["a"; 600].join("+");
        assert!(shown(&long).contains("longer than"));
        let minus = format!("{}a", "-".repeat(MAX_DEPTH + 1));
        assert!(shown(&minus).contains("nested deeper"));
    }

    #[test]
    fn names_in_order() {
        let expr = parse("pct(sum(a, b), a + c * 2)").expect("parses");
        assert_eq!(expr.names(), ["a", "b", "a", "c"]);
    }
}
