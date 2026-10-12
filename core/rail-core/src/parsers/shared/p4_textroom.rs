//! Helpers of the plain-text rooms of the fourth batch
//! (`frontend/src/lib/parsers/shared/p4-textroom.ts`): MicroGaming (R0.9)
//! uses `decodeBase64Utf16` and `strictAmount`; Ongame, Entraction and
//! Unibet (R0.10) use the rest - `leadingName` / `namesByLength` (names no
//! regex can safely find the end of), `currencySymbolOf`, `expandMonth`,
//! `refuseLossyText`.
//!
//! Amounts are JavaScript numbers ([`JsNumber`]): every caller hands them to
//! the draft builder (`p2_handbuilder`), which computes in doubles, and
//! `parseAmountStrict`'s `ok` answer can be fractional or beyond 2^53 there.

use std::sync::LazyLock;

use regex::Regex;

use crate::detect::{ParseSkip, SkipReason};
use crate::js::{self, JsNumber, LoneSurrogate};
use crate::phf::CurrencyUnit;
use crate::phf::money::parse_amount_strict_js;

static SIGNED: LazyLock<Regex> = crate::js_regex_lazy!(r"^[+-]", "");
static SYMBOL: LazyLock<Regex> = crate::js_regex_lazy!(r"^([^\s\d.,+-]+)", "");

/// `strictAmount(token, unit, where)`: a printed amount read exactly at the
/// point it arrives from the source - a leading sign and a currency glyph
/// (`kr`, `zł` too) come off first, then `parseAmountStrict`.
///
/// # Errors
///
/// `ambiguous-amount` (with the problem and `where` in the message) for
/// anything `parseAmountStrict` refuses.
pub fn strict_amount(token: &str, unit: &CurrencyUnit, place: &str) -> Result<JsNumber, ParseSkip> {
    let signed = js::trim(token);
    let sign = if signed.starts_with('-') { "-" } else { "" };
    let unsigned = if SIGNED.is_match(signed) {
        &signed[1..]
    } else {
        signed
    };
    let symbol = currency_symbol_of(unsigned);
    let bare = format!("{sign}{}", &unsigned[symbol.len()..]);
    parse_amount_strict_js(&bare, unit).map_err(|error| {
        ParseSkip::new(
            SkipReason::AmbiguousAmount,
            format!(
                "Could not read \"{token}\" as an exact amount ({}) in {place}. Guessing which \
                 separator is the decimal mark can be wrong by a factor of a hundred, and the \
                 resulting hand would still balance.",
                error.problem.as_str()
            ),
        )
    })
}

/// A name from [`leading_name`] and what follows it, trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeadingName<'a> {
    pub name: &'a str,
    pub rest: &'a str,
}

/// `leadingName(line, namesByLength)`: the first of `names_by_length`
/// (longest first) the line starts with, followed by a space or the end of
/// the line.
pub fn leading_name<'a>(line: &'a str, names_by_length: &'a [String]) -> Option<LeadingName<'a>> {
    for name in names_by_length {
        let Some(rest) = line.strip_prefix(name.as_str()) else {
            continue;
        };
        // `line.charAt(name.length)`: "" at the end, else the next code unit.
        if matches!(rest.chars().next(), None | Some(' ')) {
            return Some(LeadingName {
                name,
                rest: js::trim(rest),
            });
        }
    }
    None
}

/// `namesByLength(names)`: longest first (UTF-16 length), ties in their
/// original order (`sort` is stable and the comparator consistent).
pub fn names_by_length(names: &[String]) -> Vec<String> {
    let mut sorted = names.to_vec();
    sorted.sort_by_key(|name| std::cmp::Reverse(js::utf16_len(name)));
    sorted
}

/// `currencySymbolOf(token)`: the glyph in front of an amount (`kr`, `zł`,
/// `R$` whole), or `""`.
pub fn currency_symbol_of(token: &str) -> &str {
    SYMBOL
        .captures(token)
        .and_then(|captures| captures.get(1))
        .map_or("", |m| m.as_str())
}

/// `atob(value)` (forgiving-base64 decode): the bytes, or `None` where it
/// throws.
fn atob(value: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = Vec::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\t' | '\n' | '\u{C}' | '\r' | ' ' => {}
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' | '=' => {
                data.push(u8::try_from(u32::from(c)).ok()?);
            }
            _ => return None,
        }
    }
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len() - 2);
        } else if data.ends_with(b"=") {
            data.truncate(data.len() - 1);
        }
    }
    if data.len() % 4 == 1 || data.contains(&b'=') {
        return None;
    }
    let sextet = |byte: u8| -> u32 {
        u32::from(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            _ => 63,
        })
    };
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in &data {
        buffer = (buffer << 6) | sextet(byte);
        bits += 6;
        if bits == 24 {
            out.extend_from_slice(&buffer.to_be_bytes()[1..]);
            buffer = 0;
            bits = 0;
        }
    }
    // 12 or 18 bits left: one or two bytes, the low bits discarded.
    if bits == 12 {
        out.push(u8::try_from(buffer >> 4).ok()?);
    } else if bits == 18 {
        out.extend_from_slice(&(buffer >> 2).to_be_bytes()[2..]);
    }
    Some(out)
}

/// `decodeBase64Utf16(value)`: Base64 of a UTF-16LE string (MicroGaming's
/// `unicodealias="RAB1AGMAawBHAGgAbwB1AGwA"` is `DuckGhoul`,
/// `currencysymbol="rCA="` is `€`); `""` for anything that does not decode
/// (`atob` throws, or an odd number of bytes).
///
/// # Errors
///
/// [`LoneSurrogate`]: the code units leave a surrogate unpaired, so the
/// TypeScript returns a string Rust cannot hold.
pub fn decode_base64_utf16(value: &str) -> Result<String, LoneSurrogate> {
    let (text, lone) = decode_base64_utf16_lossy(value);
    if lone { Err(LoneSurrogate) } else { Ok(text) }
}

/// [`decode_base64_utf16`] with U+FFFD for each unpaired surrogate (the same
/// single UTF-16 unit, neither whitespace nor a word character), and whether
/// there was one - for a caller that can tell afterwards whether the
/// stand-in reached its output (`p2_xml::unrepresentable_outcome`).
pub fn decode_base64_utf16_lossy(value: &str) -> (String, bool) {
    if value.is_empty() {
        return (String::new(), false);
    }
    let Some(binary) = atob(value) else {
        return (String::new(), false);
    };
    if binary.len() % 2 != 0 {
        return (String::new(), false);
    }
    let units: Vec<u16> = binary
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    match js::from_utf16(&units) {
        Ok(text) => (text, false),
        Err(LoneSurrogate) => (String::from_utf16_lossy(&units), true),
    }
}

/// `MONTH_NAMES`.
const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// `expandMonth(abbreviation)`: `Jan` -> `January`, by the first three
/// letters, case-insensitively; an unknown one comes back unchanged (and
/// `""` is `January`: every name starts with the empty prefix).
pub fn expand_month(abbreviation: &str) -> String {
    // `abbreviation.slice(0, 3)`: three UTF-16 code units. A character
    // split in half leaves a lone surrogate, which no month name starts
    // with.
    let mut units = 0;
    let mut prefix = String::new();
    for c in abbreviation.chars() {
        if units + c.len_utf16() > 3 {
            if units < 3 {
                return abbreviation.to_owned();
            }
            break;
        }
        units += c.len_utf16();
        prefix.push(c);
    }
    let prefix = js::to_lower_case(&prefix);
    MONTH_NAMES
        .iter()
        .find(|name| js::to_lower_case(name).starts_with(&prefix))
        .map_or_else(|| abbreviation.to_owned(), |name| (*name).to_owned())
}

/// `refuseLossyText(text, room)`: `lossy-encoding` when the text holds a
/// U+FFFD (a single-byte export decoded as UTF-8).
///
/// # Errors
///
/// The refusal.
pub fn refuse_lossy_text(text: &str, room: &str) -> Result<(), ParseSkip> {
    if !text.contains('\u{FFFD}') {
        return Ok(());
    }
    Err(ParseSkip::new(
        SkipReason::LossyEncoding,
        format!(
            "This {room} file was written in a single-byte encoding (Windows-1252) but decoded \
             as UTF-8, so currency symbols and accented characters in player names have been \
             replaced by U+FFFD and cannot be recovered. Re-save the file as UTF-8 and upload \
             it again."
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phf::money::{EUR, USD};

    const SOURCE: &str =
        include_str!("../../../../../frontend/src/lib/parsers/shared/p4-textroom.ts");

    #[test]
    fn patterns_and_messages_are_the_typescript_source() {
        let source = SOURCE.replace("\r\n", "\n");
        for literal in [
            r"/^[+-]/",
            r"/^([^\s\d.,+-]+)/",
            "`Could not read \"${token}\" as an exact amount (${parsed.problem}) in ${where}. ` +",
            "\"Guessing which separator is the decimal mark can be wrong by a factor of \" +",
            "\"a hundred, and the resulting hand would still balance.\",",
            "`This ${room} file was written in a single-byte encoding (Windows-1252) but ` +",
            "\"decoded as UTF-8, so currency symbols and accented characters in player \" +",
            "\"names have been replaced by U+FFFD and cannot be recovered. Re-save the \" +",
            "\"file as UTF-8 and upload it again.\",",
            "b.length - a.length",
            "abbreviation.slice(0, 3).toLowerCase()",
        ] {
            assert!(source.contains(literal), "{literal}");
        }
    }

    #[test]
    fn strict_amounts() {
        let usd = USD.unit();
        let read = |token: &str| strict_amount(token, &usd, "a test").map(JsNumber::to_js_string);
        assert_eq!(read("$1.50"), Ok("150".to_owned()));
        assert_eq!(read("+$113.91"), Ok("11391".to_owned()));
        assert_eq!(read("-$0.00"), Ok("0".to_owned()));
        assert_eq!(read("€-0.05"), Ok("-5".to_owned()));
        assert_eq!(read("kr 1,050"), Ok("105000".to_owned()));
        // `parseAmountStrict`'s fractional `ok` answer, kept as the number.
        assert_eq!(read("1.234,5.6"), Ok("183.45".to_owned()));
        let refused =
            strict_amount("2 950,005", &EUR.unit(), "a <Seat> balance").expect_err("too precise");
        assert_eq!(refused.reason, SkipReason::AmbiguousAmount);
        assert_eq!(
            refused.message,
            "Could not read \"2 950,005\" as an exact amount (too-precise) in a <Seat> balance. \
             Guessing which separator is the decimal mark can be wrong by a factor of a \
             hundred, and the resulting hand would still balance."
        );
        assert_eq!(
            strict_amount("", &usd, "x").map_err(|e| e.message.contains("(not-a-number)")),
            Err(true)
        );
    }

    #[test]
    fn base64_utf16() {
        assert_eq!(
            decode_base64_utf16("RAB1AGMAawBHAGgAbwB1AGwA"),
            Ok("DuckGhoul".to_owned())
        );
        assert_eq!(decode_base64_utf16("rCA="), Ok("€".to_owned()));
        assert_eq!(decode_base64_utf16("rCA"), Ok("€".to_owned()));
        assert_eq!(decode_base64_utf16(" r C A = "), Ok("€".to_owned()));
        assert_eq!(decode_base64_utf16(""), Ok(String::new()));
        // `atob` throws; an odd byte count.
        assert_eq!(decode_base64_utf16("r"), Ok(String::new()));
        assert_eq!(decode_base64_utf16("rC=A"), Ok(String::new()));
        assert_eq!(decode_base64_utf16("€"), Ok(String::new()));
        assert_eq!(decode_base64_utf16("QQ=="), Ok(String::new()));
        assert_eq!(decode_base64_utf16("AAA="), Ok("\0".to_owned()));
        // A surrogate pair, and half of one.
        assert_eq!(decode_base64_utf16("Pdgw3g=="), Ok("\u{1F630}".to_owned()));
        assert_eq!(decode_base64_utf16("Pdg="), Err(LoneSurrogate));
    }

    #[test]
    fn names_and_months() {
        let names = names_by_length(&["Bob".to_owned(), "Bobby".to_owned(), "Al".to_owned()]);
        assert_eq!(names, ["Bobby", "Bob", "Al"]);
        assert_eq!(
            leading_name("Bobby folds", &names),
            Some(LeadingName {
                name: "Bobby",
                rest: "folds"
            })
        );
        assert_eq!(leading_name("Bobbyx folds", &names), None);
        assert_eq!(leading_name("Bob", &names).map(|n| n.rest), Some(""));
        assert_eq!(expand_month("Jan"), "January");
        assert_eq!(expand_month("SEPT"), "September");
        assert_eq!(expand_month("Xyz"), "Xyz");
        assert_eq!(expand_month(""), "January");
        assert_eq!(expand_month("Ma"), "March");
        assert_eq!(expand_month("J\u{1F600}"), "J\u{1F600}");
        assert_eq!(currency_symbol_of("kr 1,050"), "kr");
        assert_eq!(currency_symbol_of("1"), "");
        assert!(refuse_lossy_text("a\u{FFFD}", "Ongame").is_err());
        assert!(refuse_lossy_text("a", "Ongame").is_ok());
    }
}
