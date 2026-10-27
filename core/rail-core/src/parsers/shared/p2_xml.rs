//! The XML reader of iPoker and MicroGaming
//! (`web/src/lib/parsers/shared/p2-xml.ts`).
//!
//! The TypeScript has two paths: the browser's `DOMParser` when the host has
//! one, and otherwise a hand-written scanner for the subset these rooms emit
//! (elements, attributes, text, comments, the declaration). Node has no
//! `DOMParser`, so the scanner is what the test suite and the golden emitter
//! run - it is the reference, and this module is the scanner, step for step.
//! Its leniency is behaviour and is kept: a closing tag closes whatever is
//! open, whatever its name; `<!...>` (a DOCTYPE, CDATA) is skipped up to the
//! first `>`; a comment or declaration that never ends swallows the rest;
//! text after the root and any later top-level element is read and dropped;
//! only `&amp; &lt; &gt; &quot; &apos;` and numeric references are decoded,
//! anything else stays as written. A document it cannot read is `None`
//! (`parseXml`'s `null`, the parsers' `malformed-xml`), and so is one whose
//! numeric reference is beyond U+10FFFF: `String.fromCodePoint` throws there
//! and `parseXml` catches it.
//!
//! Two pieces of JavaScript leak through, reproduced as such:
//!
//! - `ENTITIES[body] ?? whole` looks the name up on an object literal, so the
//!   letters-only members of `Object.prototype` are entities too:
//!   `&toString;` decodes to `function toString() { [native code] }` (the
//!   function's source text) and `&constructor;` to `function Object() {
//!   [native code] }`.
//! - `attrs[name] = value` on an object literal ignores an attribute named
//!   `__proto__` (the setter wants an object); later duplicates win.
//!
//! **Lone surrogates**: a numeric reference to a surrogate (`&#xD800;`) puts
//! a lone UTF-16 code unit into a JavaScript string; a Rust `String` cannot
//! hold one. (A surrogate pair written as two references decodes to its
//! character, as in JavaScript.) The scanner puts U+FFFD in its place - one
//! UTF-16 unit too, no whitespace, no word character, no case - and
//! [`Document::lone_surrogates`] says the returned tree has one. Every
//! comparison a parser makes then comes out as in JavaScript, except against
//! a real U+FFFD; [`unrepresentable_outcome`] turns an outcome that shows
//! the stand-in (or might have met a real U+FFFD) into a `parser-error`. The
//! browser's `DOMParser` refuses such a document outright: XML forbids the
//! reference.

use std::sync::LazyLock;

use regex::Regex;

use crate::detect::ParseError;
use crate::js::{self, JsNumber, LoneSurrogate};
use crate::phf::PhfHand;

/// `XmlElement`. `attrs` keeps every attribute in document order; read them
/// with [`XmlElement::attr`], which is `attrs[name]` (the last one wins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlElement {
    pub tag: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<XmlElement>,
    /// Direct text content, entities resolved, edges trimmed.
    pub text: String,
}

impl XmlElement {
    /// `element.attrs[name]`: `None` is `undefined`.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// What `decodeEntities` did not return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// It threw (`String.fromCodePoint`'s `RangeError`), with the message.
    Thrown(String),
    /// It returned a string with a lone surrogate; this is that string with
    /// U+FFFD in place of each one.
    LoneSurrogate(String),
}

/// `ENTITIES`, and the letters-only names `Object.prototype` adds to it.
fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "constructor" => "function Object() { [native code] }",
        "hasOwnProperty" => "function hasOwnProperty() { [native code] }",
        "isPrototypeOf" => "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" => "function propertyIsEnumerable() { [native code] }",
        "toString" => "function toString() { [native code] }",
        "valueOf" => "function valueOf() { [native code] }",
        "toLocaleString" => "function toLocaleString() { [native code] }",
        _ => return None,
    })
}

static ENTITY_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);", "g");

/// A string being built from code points the way JavaScript concatenates
/// UTF-16: a high surrogate followed directly by a low one is one character.
#[derive(Default)]
struct Utf16Builder {
    out: String,
    pending_high: Option<u32>,
    lone: bool,
}

impl Utf16Builder {
    fn flush_pending(&mut self) {
        if self.pending_high.take().is_some() {
            self.lone = true;
            self.out.push('\u{FFFD}');
        }
    }

    fn push_str(&mut self, text: &str) {
        if !text.is_empty() {
            self.flush_pending();
            self.out.push_str(text);
        }
    }

    /// `String.fromCodePoint(code)` appended, for `code <= 0x10FFFF`.
    fn push_code_point(&mut self, code: u32) {
        match code {
            0xD800..=0xDBFF => {
                self.flush_pending();
                self.pending_high = Some(code);
            }
            0xDC00..=0xDFFF => match self.pending_high.take() {
                Some(high) => {
                    let combined = 0x10000 + ((high - 0xD800) << 10) + (code - 0xDC00);
                    self.out
                        .push(char::from_u32(combined).unwrap_or('\u{FFFD}'));
                }
                None => {
                    self.lone = true;
                    self.out.push('\u{FFFD}');
                }
            },
            _ => {
                self.flush_pending();
                self.out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
            }
        }
    }

    fn finish(mut self) -> Result<String, DecodeError> {
        self.flush_pending();
        if self.lone {
            Err(DecodeError::LoneSurrogate(self.out))
        } else {
            Ok(self.out)
        }
    }
}

/// The code point of a numeric reference's body (`#x41`, `#65`), as
/// `Number.parseInt` reads it: `None` for `NaN` and `Infinity` (the
/// reference is then left as written), `Err` for a finite value
/// `String.fromCodePoint` throws on.
fn numeric_reference(body: &str) -> Option<Result<u32, String>> {
    let value = if let Some(hex) = body.strip_prefix("#x") {
        // `Number.parseInt(hex, 16)`: the body is all hex digits (the
        // pattern), read exactly.
        JsNumber::parse(&format!("0x{hex}"))
    } else {
        // `Number.parseInt(rest, 10)`: the leading decimal digits; none is
        // `NaN`.
        let rest = body.strip_prefix('#').unwrap_or(body);
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        JsNumber::parse(&digits)
    };
    if !value.is_finite() {
        return None;
    }
    Some(
        value
            .to_i64()
            .and_then(|code| u32::try_from(code).ok())
            .filter(|code| *code <= 0x10_FFFF)
            .ok_or_else(|| format!("Invalid code point {}", value.to_js_string())),
    )
}

/// `decodeEntities(value)`: the five XML entities (and the letters-only
/// `Object.prototype` members) plus numeric character references.
///
/// # Errors
///
/// [`DecodeError::Thrown`] where the TypeScript throws (a reference beyond
/// U+10FFFF), [`DecodeError::LoneSurrogate`] where it returns a string Rust
/// cannot hold.
pub fn decode_entities(value: &str) -> Result<String, DecodeError> {
    let mut builder = Utf16Builder::default();
    let mut last = 0;
    for captures in ENTITY_REGEX.captures_iter(value) {
        let whole = captures.get(0).map_or("", |m| m.as_str());
        let start = captures.get(0).map_or(0, |m| m.start());
        builder.push_str(&value[last..start]);
        last = start + whole.len();
        let body = &captures[1];
        if body.starts_with('#') {
            match numeric_reference(body) {
                None => builder.push_str(whole),
                Some(Ok(code)) => builder.push_code_point(code),
                Some(Err(message)) => return Err(DecodeError::Thrown(message)),
            }
        } else {
            builder.push_str(entity(body).unwrap_or(whole));
        }
    }
    builder.push_str(&value[last..]);
    builder.finish()
}

/* ------------------------------------------------------------- the scanner */

static NAME_REGEX: LazyLock<Regex> = crate::js_regex_lazy!(r"^[^\s/]+", "");
static ATTRIBUTE_REGEX: LazyLock<Regex> =
    crate::js_regex_lazy!(r#"([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')"#, "g");

/// What `scanXml` returns: the root element (`None` is `null`), and whether
/// U+FFFD stands for a lone surrogate somewhere in its tree.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Document {
    pub root: Option<XmlElement>,
    pub lone_surrogates: bool,
}

impl Document {
    const fn none() -> Self {
        Self {
            root: None,
            lone_surrogates: false,
        }
    }
}

struct Node {
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<usize>,
    text: String,
    lone_surrogate: bool,
}

/// `readAttributes(source)`.
fn read_attributes(source: &str) -> Result<(Vec<(String, String)>, bool), String> {
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut lone = false;
    for captures in ATTRIBUTE_REGEX.captures_iter(source) {
        let raw = captures
            .get(3)
            .or_else(|| captures.get(4))
            .map_or("", |m| m.as_str());
        let value = match decode_entities(raw) {
            Ok(value) => value,
            Err(DecodeError::LoneSurrogate(value)) => {
                lone = true;
                value
            }
            Err(DecodeError::Thrown(message)) => return Err(message),
        };
        let name = &captures[1];
        // `attrs.__proto__ = "..."` sets nothing.
        if name == "__proto__" {
            continue;
        }
        attrs.push((name.to_owned(), value));
    }
    Ok((attrs, lone))
}

/// `findTagEnd(text, open)`: the `>` that closes the tag opened at `open`,
/// quotes respected.
fn find_tag_end(text: &str, open: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, &byte) in text.as_bytes().iter().enumerate().skip(open + 1) {
        if let Some(q) = quote {
            if byte == q {
                quote = None;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' => quote = Some(byte),
            b'>' => return Some(i),
            _ => {}
        }
    }
    None
}

fn build(nodes: &mut Vec<Option<Node>>, index: usize) -> XmlElement {
    let node = nodes[index].take().unwrap_or(Node {
        tag: String::new(),
        attrs: Vec::new(),
        children: Vec::new(),
        text: String::new(),
        lone_surrogate: false,
    });
    XmlElement {
        tag: node.tag,
        attrs: node.attrs,
        children: node
            .children
            .iter()
            .map(|&child| build(nodes, child))
            .collect(),
        text: node.text,
    }
}

fn tree_has_lone_surrogate(nodes: &[Option<Node>], index: usize) -> bool {
    nodes[index].as_ref().is_some_and(|node| {
        node.lone_surrogate
            || node
                .children
                .iter()
                .any(|&child| tree_has_lone_surrogate(nodes, child))
    })
}

/// `scanXml(source)`: the document's root element, or no root when it is
/// not well formed (an unterminated tag, a nameless one, a closing tag with
/// nothing open, an element left open).
///
/// # Errors
///
/// The message of what the TypeScript throws: `String.fromCodePoint`'s
/// `RangeError` for a numeric reference beyond U+10FFFF.
pub fn scan_xml(source: &str) -> Result<Document, String> {
    let text = source.strip_prefix('\u{FEFF}').unwrap_or(source);
    let mut nodes: Vec<Option<Node>> = Vec::new();
    // Open elements: (node, text segments).
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut root: Option<usize> = None;
    let mut i = 0;

    while i < text.len() {
        let Some(open) = text[i..].find('<').map(|at| at + i) else {
            break;
        };
        if let Some((_, segments)) = stack.last_mut() {
            segments.push_str(&text[i..open]);
        }

        let rest = &text[open..];
        if rest.starts_with("<!--") {
            i = text[open + 4..]
                .find("-->")
                .map_or(text.len(), |end| open + 4 + end + 3);
            continue;
        }
        if rest.starts_with("<?") {
            i = text[open + 2..]
                .find("?>")
                .map_or(text.len(), |end| open + 2 + end + 2);
            continue;
        }
        if rest.starts_with("<!") {
            i = text[open + 2..]
                .find('>')
                .map_or(text.len(), |end| open + 2 + end + 1);
            continue;
        }

        let Some(close) = find_tag_end(text, open) else {
            return Ok(Document::none());
        };
        let body = &text[open + 1..close];
        i = close + 1;

        if body.starts_with('/') {
            let Some((index, segments)) = stack.pop() else {
                return Ok(Document::none());
            };
            let decoded = match decode_entities(&segments) {
                Ok(decoded) => decoded,
                Err(DecodeError::LoneSurrogate(decoded)) => {
                    if let Some(node) = nodes[index].as_mut() {
                        node.lone_surrogate = true;
                    }
                    decoded
                }
                Err(DecodeError::Thrown(message)) => return Err(message),
            };
            if let Some(node) = nodes[index].as_mut() {
                node.text = js::trim(&decoded).to_owned();
            }
            if stack.is_empty() && root.is_none() {
                root = Some(index);
            }
            continue;
        }

        let self_closing = body.ends_with('/');
        let inner = if self_closing {
            &body[..body.len() - 1]
        } else {
            body
        };
        let Some(name) = NAME_REGEX.find(inner).map(|m| m.as_str()) else {
            return Ok(Document::none());
        };
        let (attrs, lone) = read_attributes(&inner[name.len()..])?;
        let index = nodes.len();
        nodes.push(Some(Node {
            tag: name.to_owned(),
            attrs,
            children: Vec::new(),
            text: String::new(),
            lone_surrogate: lone,
        }));
        if let Some(parent) = stack.last().and_then(|(parent, _)| nodes[*parent].as_mut()) {
            parent.children.push(index);
        }
        if self_closing {
            if stack.is_empty() && root.is_none() {
                root = Some(index);
            }
            continue;
        }
        stack.push((index, String::new()));
    }

    if !stack.is_empty() {
        return Ok(Document::none());
    }
    let Some(root) = root else {
        return Ok(Document::none());
    };
    let lone_surrogates = tree_has_lone_surrogate(&nodes, root);
    Ok(Document {
        root: Some(build(&mut nodes, root)),
        lone_surrogates,
    })
}

/// `parseXml(source)`: the root element, or no root (`null`) when the
/// document is not well formed - including where the scanner throws, which
/// `parseXml` catches. Never panics.
pub fn parse_xml(source: &str) -> Document {
    scan_xml(source).unwrap_or_else(|_| Document::none())
}

/// A parser's outcome, unless U+FFFD stood in for a lone surrogate
/// (`lone_surrogates`) and could have made it differ from the TypeScript's:
/// the hand or the refusal shows a U+FFFD (the TypeScript's has the lone
/// surrogate there), or the source has a real U+FFFD a comparison could
/// have confused with the stand-in. That is a `parser-error` naming
/// [`LoneSurrogate`] - not reproducible. Without a stand-in, the outcome
/// as is.
pub fn unrepresentable_outcome(
    lone_surrogates: bool,
    source: &str,
    outcome: Result<PhfHand, ParseError>,
) -> Result<PhfHand, ParseError> {
    if !lone_surrogates {
        return outcome;
    }
    let shows = match &outcome {
        Ok(hand) => serde_json::to_string(hand).map_or(true, |json| json.contains('\u{FFFD}')),
        Err(ParseError::Skip(skip)) => skip.message.contains('\u{FFFD}'),
        Err(ParseError::Bug(message)) => message.contains('\u{FFFD}'),
    };
    if shows || source.contains('\u{FFFD}') {
        return Err(ParseError::Bug(LoneSurrogate.to_string()));
    }
    outcome
}

/* ------------------------------------------------------------------ lookups */

/// `child(element, tag)`: the first child named `tag`.
pub fn child<'a>(element: Option<&'a XmlElement>, tag: &str) -> Option<&'a XmlElement> {
    element?.children.iter().find(|entry| entry.tag == tag)
}

/// `children(element, tag)`: every child named `tag`.
pub fn children<'a>(element: Option<&'a XmlElement>, tag: &str) -> Vec<&'a XmlElement> {
    element.map_or_else(Vec::new, |element| {
        element
            .children
            .iter()
            .filter(|entry| entry.tag == tag)
            .collect()
    })
}

/// `childText(element, tag)`: the trimmed text of the first `tag` child, or
/// `""` when there is none.
pub fn child_text<'a>(element: Option<&'a XmlElement>, tag: &str) -> &'a str {
    child(element, tag).map_or("", |entry| entry.text.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../../../web/src/lib/parsers/shared/p2-xml.ts");

    fn scan(source: &str) -> XmlElement {
        scan_xml(source)
            .expect("no throw")
            .root
            .expect("well formed")
    }

    fn root_of(source: &str) -> Result<Option<XmlElement>, String> {
        scan_xml(source).map(|document| document.root)
    }

    #[test]
    fn patterns_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g",
            r"/^[^\s/]+/",
            r#"/([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g"#,
            r"/^\uFEFF/",
            r#"text.startsWith("<!--", open)"#,
            r#"text.startsWith("<?", open)"#,
            r#"text.startsWith("<!", open)"#,
            r#"amp: "&","#,
            r#"lt: "<","#,
            r#"gt: ">","#,
            r#"quot: '"',"#,
            r#"apos: "'","#,
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    /// `scanXml` reads attributes, text and self-closing elements.
    #[test]
    fn reads_attributes_text_and_self_closing_elements() {
        let root = scan(
            "<session sessioncode=\"0\"><general><mode>real</mode></general>\
             <game gamecode=\"1\"><action no=\"1\" player=\"a\" type=\"3\" sum=\"$1\" /></game></session>",
        );
        assert_eq!(root.tag, "session");
        assert_eq!(root.attr("sessioncode"), Some("0"));
        assert_eq!(
            child_text(children(Some(&root), "general").first().copied(), "mode"),
            "real"
        );
        let game = children(Some(&root), "game")[0];
        let action = children(Some(game), "action")[0];
        let attrs: Vec<(&str, &str)> = action
            .attrs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(
            attrs,
            [("no", "1"), ("player", "a"), ("type", "3"), ("sum", "$1")]
        );
    }

    /// Single quotes, a declaration, a comment, a `>` in an attribute, no
    /// whitespace.
    #[test]
    fn survives_the_shapes_ipoker_actually_emits() {
        let root = scan(
            "<?xml version=\"1.0\"?><!-- note --><session sessioncode='0'>\
             <general><nickname>a &gt; b</nickname></general></session>",
        );
        assert_eq!(root.attr("sessioncode"), Some("0"));
        assert_eq!(
            child_text(
                children(Some(&root), "general").first().copied(),
                "nickname"
            ),
            "a > b"
        );
        let quoted = scan("<a b=\"x>y\" c='<'/>");
        assert_eq!(quoted.attr("b"), Some("x>y"));
        assert_eq!(quoted.attr("c"), Some("<"));
    }

    #[test]
    fn returns_none_for_a_document_that_does_not_close() {
        assert_eq!(root_of("<session><game></session>"), Ok(None));
        assert_eq!(root_of("<session"), Ok(None));
    }

    #[test]
    fn decodes_the_five_entities_and_numeric_references() {
        assert_eq!(
            decode_entities("&amp;&lt;&gt;&quot;&apos;"),
            Ok("&<>\"'".to_owned())
        );
        assert_eq!(decode_entities("&#65;&#x42;"), Ok("AB".to_owned()));
        // An entity we do not know is left alone rather than silently dropped.
        assert_eq!(decode_entities("&nbsp;"), Ok("&nbsp;".to_owned()));
    }

    /// Recorded from Node (`decodeEntities` of `p2-xml.ts`).
    #[test]
    fn decodes_as_javascript_does() {
        for (input, expected) in [
            ("&toString;", "function toString() { [native code] }"),
            ("&constructor;", "function Object() { [native code] }"),
            ("&__proto__;", "&__proto__;"),
            ("&#X41;", "&#X41;"),
            ("&#x;", "&#x;"),
            ("&#a1;", "&#a1;"),
            ("&#1f;", "\u{1}"),
            ("&#00065;", "A"),
            ("&#xD83D;&#xDE00;", "\u{1F600}"),
            ("&#x1F600;", "\u{1F600}"),
            ("&#0;", "\0"),
            ("&amp;amp;", "&amp;"),
            ("&&amp;;", "&&;"),
            (
                &format!("&#x{};", "f".repeat(300)),
                &format!("&#x{};", "f".repeat(300)),
            ),
        ] {
            assert_eq!(decode_entities(input), Ok(expected.to_owned()), "{input}");
        }
        assert_eq!(
            decode_entities("&#x110000;"),
            Err(DecodeError::Thrown("Invalid code point 1114112".to_owned()))
        );
        assert_eq!(
            decode_entities("&#99999999999999999999999;"),
            Err(DecodeError::Thrown("Invalid code point 1e+23".to_owned()))
        );
        assert_eq!(
            decode_entities("a&#xD800;b"),
            Err(DecodeError::LoneSurrogate("a\u{FFFD}b".to_owned()))
        );
        assert_eq!(
            decode_entities("&#xDE00;&#xD83D;"),
            Err(DecodeError::LoneSurrogate("\u{FFFD}\u{FFFD}".to_owned()))
        );
    }

    #[test]
    fn keeps_the_scanners_leniency() {
        // A closing tag closes whatever is open.
        let root = scan("<a><b>x</c></d>");
        assert_eq!(root.tag, "a");
        assert_eq!(root.children[0].text, "x");
        // Text after the root and a second root are dropped.
        let root = scan("<a>1</a>tail<b>2</b>");
        assert_eq!((root.tag.as_str(), root.text.as_str()), ("a", "1"));
        // A self-closing element first is the root.
        assert_eq!(scan("<a/><b></b>").tag, "a");
        // CDATA is skipped to its first `>`.
        assert_eq!(scan("<a><![CDATA[x>y]]></a>").text, "y]]>");
        // `__proto__` is no attribute; later duplicates win.
        let root = scan("<a __proto__=\"1\" b=\"1\" b=\"2\"/>");
        assert_eq!(root.attr("__proto__"), None);
        assert_eq!(root.attr("b"), Some("2"));
        // A throw anywhere is `null` for `parseXml`, even in a dropped element.
        assert_eq!(parse_xml("<a></a><b>&#x110000;</b>").root, None);
        assert_eq!(
            root_of("<a></a><b>&#x110000;</b>"),
            Err("Invalid code point 1114112".to_owned())
        );
        // A lone surrogate only counts inside the returned tree.
        let lone = parse_xml("<a><b x=\"&#xD800;\"/></a>");
        assert!(lone.lone_surrogates);
        assert_eq!(
            lone.root.map(|root| root.children[0].attrs.clone()),
            Some(vec![("x".to_owned(), "\u{FFFD}".to_owned())])
        );
        let dropped = parse_xml("<a></a><b>&#xD800;</b>");
        assert!(dropped.root.is_some() && !dropped.lone_surrogates);
        // No root at all.
        assert_eq!(root_of(""), Ok(None));
        assert_eq!(root_of("text"), Ok(None));
        assert_eq!(root_of("<!-- x"), Ok(None));
        assert_eq!(root_of("< a>"), Ok(None));
        assert_eq!(root_of("</a>"), Ok(None));
    }

    /// `parseXml` never throws on junk.
    #[test]
    fn never_panics_on_junk() {
        for junk in ["", "not xml at all", "<", "</a>", "<a><b></a></b>"] {
            assert!(!parse_xml(junk).lone_surrogates);
        }
        // The last one is read leniently: `</a>` closes `b`, `</b>` closes `a`.
        assert_eq!(
            parse_xml("<a><b></a></b>").root.map(|root| root.tag),
            Some("a".to_owned())
        );
    }
}
