//! Money: currency units, reading and printing amounts, buy-ins.
//!
//! The functions of the "money" section of `frontend/src/lib/phf/types.ts`,
//! with the same names in snake case. The TypeScript does its arithmetic on
//! JavaScript doubles (`Math.round(Number("0.29") * 100)`); this port performs
//! the identical IEEE-754 operations through [`JsNumber`], so an amount rounds
//! here exactly as it rounded there, including the inputs where binary
//! floating point is visibly inexact.
//!
//! Not ported: `toDisplayNumber` and `toBigBlinds`. Both return fractional
//! display values (`$4.75`, `9.5bb`) and are used only by the replayer and the
//! share preview; the core has no floats to give them (the workspace denies
//! float arithmetic), and a Rust UI that needs them will format from the
//! integer amount and the unit.

use std::sync::LazyLock;

use regex::Regex;

use super::{Amount, CurrencyKind, CurrencyUnit, DecimalStyle, PhfTournament};
use crate::js::{self, JsNumber};

/// A currency unit known at compile time; [`KnownUnit::unit`] gives the
/// [`CurrencyUnit`] a hand stores. The constants below are `types.ts`'s
/// `USD`, `EUR`, ... `PLAY_CHIPS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KnownUnit {
    pub code: &'static str,
    pub symbol: &'static str,
    pub minor_units: u32,
    pub kind: CurrencyKind,
}

impl KnownUnit {
    const fn cash(code: &'static str, symbol: &'static str, minor_units: u32) -> Self {
        Self {
            code,
            symbol,
            minor_units,
            kind: CurrencyKind::Cash,
        }
    }

    /// The unit as stored on a hand.
    pub fn unit(&self) -> CurrencyUnit {
        CurrencyUnit {
            code: self.code.to_owned(),
            symbol: self.symbol.to_owned(),
            minor_units: self.minor_units,
            kind: self.kind,
        }
    }
}

impl PartialEq<KnownUnit> for CurrencyUnit {
    fn eq(&self, other: &KnownUnit) -> bool {
        self.code == other.code
            && self.symbol == other.symbol
            && self.minor_units == other.minor_units
            && self.kind == other.kind
    }
}

impl From<KnownUnit> for CurrencyUnit {
    fn from(known: KnownUnit) -> Self {
        known.unit()
    }
}

/// `cashUnit(code, symbol)`: a two-decimal cash unit.
pub fn cash_unit(code: &str, symbol: &str) -> CurrencyUnit {
    cash_unit_with_minor_units(code, symbol, 100)
}

/// `cashUnit(code, symbol, minorUnits)`.
pub fn cash_unit_with_minor_units(code: &str, symbol: &str, minor_units: u32) -> CurrencyUnit {
    CurrencyUnit {
        code: code.to_owned(),
        symbol: symbol.to_owned(),
        minor_units,
        kind: CurrencyKind::Cash,
    }
}

pub const USD: KnownUnit = KnownUnit::cash("USD", "$", 100);
pub const EUR: KnownUnit = KnownUnit::cash("EUR", "€", 100);
pub const GBP: KnownUnit = KnownUnit::cash("GBP", "£", 100);
pub const CAD: KnownUnit = KnownUnit::cash("CAD", "$", 100);
pub const AUD: KnownUnit = KnownUnit::cash("AUD", "$", 100);
pub const NZD: KnownUnit = KnownUnit::cash("NZD", "$", 100);
pub const CHF: KnownUnit = KnownUnit::cash("CHF", "CHF", 100);
pub const SEK: KnownUnit = KnownUnit::cash("SEK", "kr", 100);
pub const NOK: KnownUnit = KnownUnit::cash("NOK", "kr", 100);
pub const DKK: KnownUnit = KnownUnit::cash("DKK", "kr", 100);
pub const PLN: KnownUnit = KnownUnit::cash("PLN", "zł", 100);
pub const RUB: KnownUnit = KnownUnit::cash("RUB", "₽", 100);
pub const BRL: KnownUnit = KnownUnit::cash("BRL", "R$", 100);
pub const MXN: KnownUnit = KnownUnit::cash("MXN", "$", 100);
pub const INR: KnownUnit = KnownUnit::cash("INR", "₹", 100);
pub const CNY: KnownUnit = KnownUnit::cash("CNY", "¥", 100);
/// The yen has no subunit in practice, so one minor unit is one yen.
pub const JPY: KnownUnit = KnownUnit::cash("JPY", "¥", 1);
/// Tether, settled in hundredths by the rooms that use it (see `types.ts`).
pub const USDT: KnownUnit = KnownUnit::cash("USDT", "\u{20ae}", 100);
/// Tournament chips. Indivisible, and never convertible to money inside a hand.
pub const CHIPS: KnownUnit = KnownUnit {
    code: "CHIPS",
    symbol: "",
    minor_units: 1,
    kind: CurrencyKind::Chips,
};
/// Chips that come in hundredths (Chico's `2642.50`); see [`chips_unit_for`].
pub const FRACTIONAL_CHIPS: KnownUnit = KnownUnit {
    code: "CHIPS",
    symbol: "",
    minor_units: 100,
    kind: CurrencyKind::Chips,
};
/// Play-money chips. Same arithmetic as [`CHIPS`], kept distinct so filters
/// can exclude them.
pub const PLAY_CHIPS: KnownUnit = KnownUnit {
    code: "TCHIP",
    symbol: "",
    minor_units: 1,
    kind: CurrencyKind::Chips,
};

/// `CURRENCY_UNITS`: every named unit by code, in `types.ts`'s order.
pub const CURRENCY_UNITS: [(&str, KnownUnit); 20] = [
    ("USD", USD),
    ("EUR", EUR),
    ("GBP", GBP),
    ("CAD", CAD),
    ("AUD", AUD),
    ("NZD", NZD),
    ("CHF", CHF),
    ("SEK", SEK),
    ("NOK", NOK),
    ("DKK", DKK),
    ("PLN", PLN),
    ("RUB", RUB),
    ("BRL", BRL),
    ("MXN", MXN),
    ("INR", INR),
    ("CNY", CNY),
    ("JPY", JPY),
    ("USDT", USDT),
    ("CHIPS", CHIPS),
    ("TCHIP", PLAY_CHIPS),
];

static FRACTIONAL_CHIP_AMOUNT: LazyLock<Regex> =
    crate::js_regex_lazy!(r"(?:^|[\s(])\d[\d,]*\.\d", "");

/// `chipsUnitFor`: [`FRACTIONAL_CHIPS`] when any bare amount in the source
/// carries a decimal point, [`CHIPS`] otherwise.
pub fn chips_unit_for(source_text: &str) -> KnownUnit {
    if FRACTIONAL_CHIP_AMOUNT.is_match(source_text) {
        FRACTIONAL_CHIPS
    } else {
        CHIPS
    }
}

/// `unitForCode(code, symbol?)`: the unit for a three-letter code. An unknown
/// code is a two-decimal cash unit carrying that code, never chips; an
/// explicit symbol always wins.
pub fn unit_for_code(code: &str, symbol: Option<&str>) -> CurrencyUnit {
    let upper = js::to_upper_case(code);
    let Some((_, known)) = CURRENCY_UNITS.iter().find(|(key, _)| *key == upper) else {
        let symbol = symbol.map_or_else(|| upper.clone(), str::to_owned);
        return cash_unit(&upper, &symbol);
    };
    match symbol {
        Some(symbol) if symbol != known.symbol => CurrencyUnit {
            symbol: symbol.to_owned(),
            ..known.unit()
        },
        _ => known.unit(),
    }
}

/// `unitForSymbol`: `$` is USD, an empty or unknown symbol is chips.
pub fn unit_for_symbol(symbol: &str) -> KnownUnit {
    match symbol {
        "€" => EUR,
        "£" => GBP,
        "$" => USD,
        "₽" => RUB,
        "zł" => PLN,
        "₹" => INR,
        "R$" => BRL,
        "kr" => SEK,
        "¥" => CNY,
        "\u{20ae}" => USDT,
        _ => CHIPS,
    }
}

fn minor_units(unit: &CurrencyUnit) -> JsNumber {
    JsNumber::from_u64(u64::from(unit.minor_units))
}

/// The JavaScript result of an amount computation as an [`Amount`]: exact for
/// every integer an `i64` holds; `±Infinity` (an overflowing product) and
/// integers beyond `i64` saturate. No PHF can hold either - canonical JSON
/// refuses anything beyond ±(2^53 - 1) - so the TypeScript pipeline cannot
/// produce a golden for such an input in the first place.
fn saturating_amount(value: JsNumber) -> Amount {
    if let Some(amount) = value.to_i64() {
        return amount;
    }
    match value {
        JsNumber::Nan => 0,
        _ if value.is_sign_negative() => Amount::MIN,
        _ => Amount::MAX,
    }
}

/// `parseAmount`: `"1,234.50"` / `"0.5"` / `"2260"` into minor units; junk is
/// 0. Strips every character but ASCII digits, `.` and `-`, reads the rest
/// with `Number()`, multiplies by the unit's minor units and `Math.round`s, as
/// doubles. (`undefined`/`null` in TypeScript are the empty string here.)
pub fn parse_amount(raw: &str, unit: &CurrencyUnit) -> Amount {
    saturating_amount(parse_amount_js(raw, unit))
}

/// `parseAmount` as the JavaScript number it returns, for a parser that goes
/// on computing with it in doubles (the PartyGaming draft builder,
/// `parsers::shared::p2_handbuilder`): `Math.round(Number(cleaned) *
/// minorUnits)`, which beyond 2^53 or past `i64` is not what
/// [`parse_amount`] saturates to.
pub fn parse_amount_js(raw: &str, unit: &CurrencyUnit) -> JsNumber {
    if raw.is_empty() {
        return JsNumber::ZERO;
    }
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        return JsNumber::ZERO;
    }
    let value = JsNumber::parse(&cleaned);
    if !value.is_finite() {
        return JsNumber::ZERO;
    }
    (value * minor_units(unit)).round()
}

/// Why a printed amount could not be held exactly (`AmountProblem`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AmountProblem {
    /// `not-a-number`: nothing numeric in the token at all.
    NotANumber,
    /// `too-precise`: more decimal places than the unit has minor units for.
    TooPrecise,
    /// `ambiguous-separators`: the token mixes `.` and `,` more than once each.
    AmbiguousSeparators,
    /// Rust only, `not-a-safe-integer`: TypeScript's `parseAmountStrict`
    /// returns `ok: true` with a number that is not a safe integer here. It
    /// happens when the decimal dot occurs twice around a grouping comma -
    /// `1.234,5.6` reads as `Number("1.2345") * 100 + 60` = 183.45 - or when
    /// the amount is beyond 2^53. No PHF can carry such a value (the
    /// golden emitter's canonical JSON throws on it), so there is no
    /// TypeScript behaviour to reproduce; the port refuses it instead.
    NotASafeInteger,
}

impl AmountProblem {
    /// The TypeScript code (`AmountProblem` string literal).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotANumber => "not-a-number",
            Self::TooPrecise => "too-precise",
            Self::AmbiguousSeparators => "ambiguous-separators",
            Self::NotASafeInteger => "not-a-safe-integer",
        }
    }
}

/// A refused `parseAmountStrict`: `{ ok: false, problem, text }`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AmountError {
    pub problem: AmountProblem,
    /// The trimmed input.
    pub text: String,
}

/// `parseAmountStrict`: reads a printed amount, refusing anything it cannot
/// hold exactly (`1 234,50 €` is 123450 cents, not 12345000). `Ok` is
/// TypeScript's `{ ok: true, amount }`.
pub fn parse_amount_strict(raw: &str, unit: &CurrencyUnit) -> Result<Amount, AmountError> {
    let value = parse_amount_strict_js(raw, unit)?;
    value.to_safe_integer().ok_or_else(|| AmountError {
        problem: AmountProblem::NotASafeInteger,
        text: js::trim(raw).to_owned(),
    })
}

/// `parseAmountStrict` as the JavaScript number its `{ ok: true, amount }`
/// carries, for a parser that goes on computing in doubles (the draft
/// builder's rooms, `parsers::shared::p4_textroom::strict_amount`): the
/// fractional `1.234,5.6` (183.45) and amounts beyond 2^53 included, `-0`
/// for `-0`. Never [`AmountProblem::NotASafeInteger`].
pub fn parse_amount_strict_js(raw: &str, unit: &CurrencyUnit) -> Result<JsNumber, AmountError> {
    let text = js::trim(raw);
    let refuse = |problem| {
        Err(AmountError {
            problem,
            text: text.to_owned(),
        })
    };
    // Strip currency symbols and whitespace, nothing else.
    let bare: String = text
        .chars()
        .filter(|c| {
            !matches!(c, '$' | '\u{20ac}' | '\u{a3}' | '\u{20ae}') && !js::is_whitespace(*c)
        })
        .collect();
    let digits = bare.strip_prefix('-').unwrap_or(&bare);
    let negative = digits.len() != bare.len();
    if digits.is_empty()
        || !digits
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
        || !digits.chars().any(|c| c.is_ascii_digit())
    {
        return refuse(AmountProblem::NotANumber);
    }

    let dots = digits.matches('.').count();
    let commas = digits.matches(',').count();
    let mut whole = digits.to_owned();
    let mut fraction = String::new();

    if dots > 0 && commas > 0 {
        if dots > 1 && commas > 1 {
            return refuse(AmountProblem::AmbiguousSeparators);
        }
        // The *last* separator is the decimal mark, the other one grouping.
        let decimal_mark = if digits.rfind('.') > digits.rfind(',') {
            '.'
        } else {
            ','
        };
        let group_mark = if decimal_mark == '.' { ',' } else { '.' };
        let ungrouped: String = digits.chars().filter(|c| *c != group_mark).collect();
        let cut = ungrouped.rfind(decimal_mark).unwrap_or(ungrouped.len());
        whole = ungrouped[..cut].to_owned();
        fraction = ungrouped[cut + 1..].to_owned();
    } else if dots > 1 || commas > 1 {
        // Repeated separators can only be grouping: `1.234.567`.
        let mark = if dots > 1 { '.' } else { ',' };
        whole = digits.chars().filter(|c| *c != mark).collect();
    } else if dots == 1 || commas == 1 {
        let mark = if dots == 1 { '.' } else { ',' };
        let (left, right) = digits.split_once(mark).unwrap_or((digits, ""));
        // Three trailing digits behind a 1-3 digit leading group that is not
        // `0` is grouping (`1,050`); otherwise a decimal mark.
        let leading_group = (1..=3).contains(&left.len())
            && left.chars().all(|c| c.is_ascii_digit())
            && !left.starts_with('0');
        if right.len() == 3 && leading_group {
            whole = format!("{left}{right}");
        } else {
            whole = left.to_owned();
            fraction = right.to_owned();
        }
    }

    if !fraction.is_empty() {
        let places = unit.minor_units.to_string().len() - 1;
        if fraction.len() > places {
            return refuse(AmountProblem::TooPrecise);
        }
        while fraction.len() < places {
            fraction.push('0');
        }
    }

    let or_zero = |s: &str| JsNumber::parse(if s.is_empty() { "0" } else { s });
    let value = or_zero(&whole) * minor_units(unit) + or_zero(&fraction);
    if !value.is_finite() {
        return refuse(AmountProblem::NotANumber);
    }
    Ok(if negative { -value } else { value })
}

/// `groupDigits`: `,` every three digits in the integer part (`21929` →
/// `21,929`), i.e. `whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")` - a comma at
/// every non-boundary position followed by a run of digits whose length is a
/// positive multiple of three.
fn group_digits(text: &str) -> String {
    let mut parts = text.split('.');
    let whole: Vec<char> = parts.next().unwrap_or_default().chars().collect();
    let fraction = parts.next();
    let is_word = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_');
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for i in 0..=whole.len() {
        let before = i.checked_sub(1).and_then(|j| whole.get(j));
        let after = whole.get(i);
        let not_boundary = is_word(before) == is_word(after);
        let run = whole[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if not_boundary && run > 0 && run % 3 == 0 {
            grouped.push(',');
        }
        if let Some(c) = after {
            grouped.push(*c);
        }
    }
    match fraction {
        Some(fraction) => format!("{grouped}.{fraction}"),
        None => grouped,
    }
}

/// `formatAmountDigits`, for a value already held as a JavaScript number.
fn format_digits(
    amount: JsNumber,
    unit: &CurrencyUnit,
    style: DecimalStyle,
    group_thousands: bool,
) -> String {
    let negative = amount.compare(JsNumber::ZERO) == Some(std::cmp::Ordering::Less);
    let abs = amount.abs();
    let mut text = if unit.minor_units == 1 {
        abs.to_js_string()
    } else {
        let whole = abs / minor_units(unit);
        // `abs % minorUnits === 0`: exact for every double (and NaN, never
        // 0, for a zero divisor or a non-finite amount).
        let divisible = abs.is_multiple_of(u64::from(unit.minor_units));
        if divisible {
            // Both styles drop the decimals on round amounts: "$3", never "$3.00".
            whole.to_js_string()
        } else if style == DecimalStyle::Fixed2 {
            whole.to_fixed(2)
        } else {
            // Minimal: strip trailing zeros, so 50 cents prints as "0.5".
            let fixed = whole.to_fixed(2);
            let trimmed = fixed.trim_end_matches('0');
            trimmed.strip_suffix('.').unwrap_or(trimmed).to_owned()
        }
    };
    if group_thousands {
        text = group_digits(&text);
    }
    if negative { format!("-{text}") } else { text }
}

/// `formatAmountDigits`: digits only, no symbol - `"0.5"` (minimal) or
/// `"0.50"` (fixed2); `"2260"` for chips.
pub fn format_amount_digits(
    amount: Amount,
    unit: &CurrencyUnit,
    style: DecimalStyle,
    group_thousands: bool,
) -> String {
    format_digits(JsNumber::from_i64(amount), unit, style, group_thousands)
}

/// `formatAmount`: symbol plus digits, e.g. `"$0.50"`, `"-$3"`, `"2260"`.
pub fn format_amount(
    amount: Amount,
    unit: &CurrencyUnit,
    style: DecimalStyle,
    group_thousands: bool,
) -> String {
    let digits = format_digits(
        JsNumber::from_i64(amount).abs(),
        unit,
        style,
        group_thousands,
    );
    if amount < 0 {
        format!("-{}{digits}", unit.symbol)
    } else {
        format!("{}{digits}", unit.symbol)
    }
}

/// `formatAmount` for an amount held as a JavaScript number: `NaN`,
/// `Infinity` and integers beyond 2^53 print as JavaScript prints them.
pub fn format_amount_js(
    amount: JsNumber,
    unit: &CurrencyUnit,
    style: DecimalStyle,
    group_thousands: bool,
) -> String {
    let digits = format_digits(amount.abs(), unit, style, group_thousands);
    if amount.less_than(JsNumber::ZERO) {
        format!("-{}{digits}", unit.symbol)
    } else {
        format!("{}{digits}", unit.symbol)
    }
}

/// `formatAmountDigits` for an amount held as a JavaScript number (Unibet
/// prints its draft's header blinds with it).
pub fn format_amount_digits_js(
    amount: JsNumber,
    unit: &CurrencyUnit,
    style: DecimalStyle,
    group_thousands: bool,
) -> String {
    format_digits(amount, unit, style, group_thousands)
}

/// `totalBuyIn`: what actually left the player's account.
pub fn total_buy_in(tournament: &PhfTournament) -> Amount {
    tournament.buy_in + tournament.bounty.unwrap_or(0) + tournament.fee
}

/// The components of a printed buy-in (`parseBuyInToken`'s result).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct BuyIn {
    pub buy_in: Amount,
    pub bounty: Amount,
    pub fee: Amount,
}

static FREEROLL: LazyLock<Regex> = crate::js_regex_lazy!("freeroll", "i");

/// `parseBuyInToken`: `$10`, `$9+$1` (prize pool + fee) or `$4.50+$4.50+$1`
/// (prize pool + bounty + fee); four or more parts sum into the buy-in except
/// the last, which is the fee.
pub fn parse_buy_in_token(token: &str, unit: &CurrencyUnit) -> BuyIn {
    if FREEROLL.is_match(token) {
        return BuyIn::default();
    }
    let parts: Vec<&str> = token
        .split('+')
        .map(js::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let amount = |part: &str| parse_amount(part, unit);
    match parts.as_slice() {
        [] => BuyIn::default(),
        [only] => BuyIn {
            buy_in: amount(only),
            ..BuyIn::default()
        },
        [buy_in, fee] => BuyIn {
            buy_in: amount(buy_in),
            bounty: 0,
            fee: amount(fee),
        },
        [buy_in, bounty, fee] => BuyIn {
            buy_in: amount(buy_in),
            bounty: amount(bounty),
            fee: amount(fee),
        },
        [rest @ .., fee] => BuyIn {
            // `reduce((sum, part) => sum + parseAmount(part), 0)`, exact for
            // the safe integers amounts are.
            buy_in: rest
                .iter()
                .fold(0, |sum: Amount, part| sum.saturating_add(amount(part))),
            bounty: 0,
            fee: amount(fee),
        },
    }
}

/// [`parse_buy_in_token`] as the JavaScript numbers it returns
/// (`[buyIn, bounty, fee]`), for a caller that prints them again (Unibet's
/// tournament header): `parseAmount` is a double, and four or more parts sum
/// in doubles from 0.
pub fn parse_buy_in_token_js(token: &str, unit: &CurrencyUnit) -> [JsNumber; 3] {
    let zero = JsNumber::ZERO;
    if FREEROLL.is_match(token) {
        return [zero; 3];
    }
    let parts: Vec<&str> = token
        .split('+')
        .map(js::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let amount = |part: &str| parse_amount_js(part, unit);
    match parts.as_slice() {
        [] => [zero; 3],
        [only] => [amount(only), zero, zero],
        [buy_in, fee] => [amount(buy_in), zero, amount(fee)],
        [buy_in, bounty, fee] => [amount(buy_in), amount(bounty), amount(fee)],
        [rest @ .., fee] => [
            rest.iter().fold(zero, |sum, part| sum + amount(part)),
            zero,
            amount(fee),
        ],
    }
}

#[cfg(test)]
mod tests {
    //! `tests/test/phfMoney.test.ts` and the amount half of
    //! `tests/test/phfCoreGaps.test.ts`, plus the JavaScript-number edge cases.

    use super::*;

    fn usd() -> CurrencyUnit {
        USD.unit()
    }

    fn ok(amount: Amount) -> Result<Amount, AmountError> {
        Ok(amount)
    }

    fn problem(problem: AmountProblem, text: &str) -> Result<Amount, AmountError> {
        Err(AmountError {
            problem,
            text: text.to_owned(),
        })
    }

    // phfMoney: currency units
    #[test]
    fn resolves_the_common_three_letter_codes() {
        assert_eq!(unit_for_code("USD", None), USD);
        assert_eq!(unit_for_code("eur", None), EUR);
        assert_eq!(unit_for_code("CAD", None).code, "CAD");
        assert_eq!(unit_for_code("BRL", None).symbol, "R$");
    }

    #[test]
    fn treats_an_unknown_code_as_cash_not_as_chips() {
        let unit = unit_for_code("XYZ", None);
        assert_eq!(unit.kind, CurrencyKind::Cash);
        assert_eq!(unit.minor_units, 100);
        assert_eq!(unit.code, "XYZ");
        assert_eq!(unit.symbol, "XYZ");
        assert_eq!(unit_for_code("huf", Some("Ft")), cash_unit("HUF", "Ft"));
    }

    #[test]
    fn an_explicit_symbol_always_wins() {
        // CoinPoker asks for `unitForCode("USDT", "$")`.
        let unit = unit_for_code("USDT", Some("$"));
        assert_eq!((unit.code.as_str(), unit.symbol.as_str()), ("USDT", "$"));
        assert_eq!(unit_for_code("USDT", Some("\u{20ae}")), USDT);
    }

    #[test]
    fn knows_the_yen_has_no_subunit() {
        assert_eq!(JPY.minor_units, 1);
        assert_eq!(parse_amount("1500", &JPY.unit()), 1500);
        assert_eq!(
            format_amount(1500, &JPY.unit(), DecimalStyle::Minimal, false),
            "¥1500"
        );
    }

    #[test]
    fn maps_symbols_and_leaves_an_unknown_one_as_chips() {
        assert_eq!(unit_for_symbol("€"), EUR);
        assert_eq!(unit_for_symbol("$"), USD);
        assert_eq!(unit_for_symbol(""), CHIPS);
        assert_eq!(unit_for_symbol("???"), CHIPS);
        assert_eq!(unit_for_symbol("\u{20ae}"), USDT);
    }

    #[test]
    fn builds_a_unit_for_a_currency_it_has_never_heard_of() {
        let unit = cash_unit("HUF", "Ft");
        assert_eq!(parse_amount("12.34", &unit), 1234);
        assert_eq!(
            format_amount(1234, &unit, DecimalStyle::Fixed2, false),
            "Ft12.34"
        );
    }

    // phfMoney: parseBuyInToken
    #[test]
    fn splits_a_knockout_buy_in_into_prize_pool_bounty_and_fee() {
        assert_eq!(
            parse_buy_in_token("$4.50+$4.50+$1", &usd()),
            BuyIn {
                buy_in: 450,
                bounty: 450,
                fee: 100
            }
        );
    }

    #[test]
    fn reads_a_plain_buy_in_and_fee() {
        assert_eq!(
            parse_buy_in_token("$15+$1.50", &usd()),
            BuyIn {
                buy_in: 1500,
                bounty: 0,
                fee: 150
            }
        );
        assert_eq!(
            parse_buy_in_token("$100+$9", &usd()),
            BuyIn {
                buy_in: 10000,
                bounty: 0,
                fee: 900
            }
        );
    }

    #[test]
    fn reads_a_single_figure_and_a_freeroll() {
        assert_eq!(
            parse_buy_in_token("$10", &usd()),
            BuyIn {
                buy_in: 1000,
                bounty: 0,
                fee: 0
            }
        );
        assert_eq!(parse_buy_in_token("Freeroll", &usd()), BuyIn::default());
        assert_eq!(parse_buy_in_token("FREEROLL $0", &usd()), BuyIn::default());
        assert_eq!(parse_buy_in_token(" + ", &usd()), BuyIn::default());
    }

    #[test]
    fn adds_up_an_unfamiliar_four_part_token() {
        assert_eq!(
            parse_buy_in_token("$1+$2+$3+$1", &usd()),
            BuyIn {
                buy_in: 600,
                bounty: 0,
                fee: 100
            }
        );
    }

    #[test]
    fn totals_what_actually_left_the_account() {
        let mut tournament = PhfTournament {
            id: "1".to_owned(),
            name: None,
            buy_in: 450,
            bounty: Some(450),
            fee: 100,
            buy_in_unit: usd(),
            level_label: None,
            level_number: None,
            level_small_blind: 0,
            level_big_blind: 0,
            level_ante: 0,
            bounties: Vec::new(),
            prize_pool: None,
        };
        assert_eq!(total_buy_in(&tournament), 1000);
        tournament.bounty = None;
        assert_eq!(total_buy_in(&tournament), 550);
    }

    // phfCoreGaps: parseAmountStrict
    #[test]
    fn reads_the_european_shape_the_permissive_reader_gets_100x_wrong() {
        assert_eq!(parse_amount_strict("1 234,50 €", &EUR.unit()), ok(123450));
        assert_eq!(parse_amount("1 234,50 €", &EUR.unit()), 12345000);
    }

    #[test]
    fn reads_grouped_thousands_as_thousands_in_either_locale() {
        assert_eq!(parse_amount_strict("$1,050", &usd()), ok(105000));
        assert_eq!(parse_amount_strict("1.050", &usd()), ok(105000));
        assert_eq!(parse_amount_strict("1.234.567", &usd()), ok(123456700));
        assert_eq!(parse_amount_strict("1,234.50", &usd()), ok(123450));
        assert_eq!(parse_amount_strict("1.234,50", &EUR.unit()), ok(123450));
    }

    #[test]
    fn keeps_a_leading_zero_decimal_a_decimal_not_a_group() {
        assert_eq!(
            parse_amount_strict("0.025", &usd()),
            problem(AmountProblem::TooPrecise, "0.025")
        );
        assert_eq!(parse_amount_strict("0.50", &usd()), ok(50));
        assert_eq!(parse_amount_strict("0.5", &usd()), ok(50));
    }

    #[test]
    fn refuses_precision_the_unit_cannot_hold_rather_than_rounding_it() {
        assert!(parse_amount_strict("2642.50", &CHIPS.unit()).is_err());
        assert_eq!(
            parse_amount_strict("2642.50", &FRACTIONAL_CHIPS.unit()),
            ok(264250)
        );
        assert_eq!(parse_amount_strict("2260", &CHIPS.unit()), ok(2260));
    }

    #[test]
    fn refuses_junk_and_signs_negatives() {
        assert!(parse_amount_strict("abc", &usd()).is_err());
        assert_eq!(
            parse_amount_strict("", &usd()),
            problem(AmountProblem::NotANumber, "")
        );
        assert_eq!(parse_amount_strict("-0.50", &usd()), ok(-50));
        assert_eq!(
            parse_amount_strict(" $1.2.3,4,5 ", &usd()),
            problem(AmountProblem::AmbiguousSeparators, "$1.2.3,4,5")
        );
        assert_eq!(
            parse_amount_strict("--1", &usd()),
            problem(AmountProblem::NotANumber, "--1")
        );
    }

    #[test]
    fn follows_javascript_where_the_typescript_is_odd() {
        // A decimal comma twice behind a grouping dot leaves a comma in the
        // whole part, and `Number("1,23")` is NaN.
        assert_eq!(
            parse_amount_strict("1,2.3,4", &usd()),
            problem(AmountProblem::NotANumber, "1,2.3,4")
        );
        // A decimal dot twice: `Number("1.23") * 100 + 40` is
        // 123.00000000000001 + 40, a tie that rounds to exactly 163 ...
        assert_eq!(parse_amount_strict("1.2,3.4", &usd()), ok(163));
        // ... but `Number("1.2345") * 100 + 60` is 183.45, which TypeScript
        // returns as `{ ok: true, amount: 183.45 }`.
        assert_eq!(
            parse_amount_strict("1.234,5.6", &usd()),
            problem(AmountProblem::NotASafeInteger, "1.234,5.6")
        );
        // `-0` is zero.
        assert_eq!(parse_amount_strict("-0", &usd()), ok(0));
        // A unit of fifty minor units has one decimal place.
        assert_eq!(
            parse_amount_strict("2.5", &cash_unit_with_minor_units("X", "", 50)),
            ok(105)
        );
    }

    #[test]
    fn parse_amount_rounds_the_double_product() {
        // Number("0.29") * 100 is 28.999999999999996; Math.round makes it 29.
        assert_eq!(parse_amount("$0.29", &usd()), 29);
        // 1.005 * 100 is 100.49999999999999, which rounds down.
        assert_eq!(parse_amount("1.005", &usd()), 100);
        assert_eq!(parse_amount("-0.005", &usd()), 0);
        assert_eq!(parse_amount("-0.015", &usd()), -1);
        assert_eq!(parse_amount("1.2.3", &usd()), 0);
        assert_eq!(parse_amount("abc", &usd()), 0);
        assert_eq!(parse_amount("1-2", &usd()), 0);
        assert_eq!(parse_amount(".5", &usd()), 50);
        assert_eq!(parse_amount("1e5", &usd()), 1500, "the `e` is stripped: 15");
        assert_eq!(parse_amount(&"9".repeat(400), &usd()), 0);
        assert_eq!(parse_amount(&"9".repeat(300), &usd()), Amount::MAX);
    }

    #[test]
    fn chips_unit_follows_the_source() {
        assert_eq!(
            chips_unit_for("Seat 1: a (2642.50 in chips)"),
            FRACTIONAL_CHIPS
        );
        assert_eq!(chips_unit_for("Seat 1: a (21929 in chips)"), CHIPS);
        assert_eq!(chips_unit_for("1.5 at the start"), FRACTIONAL_CHIPS);
        assert_eq!(chips_unit_for("x1.5"), CHIPS);
        assert_eq!(chips_unit_for("\u{FEFF}1.5"), FRACTIONAL_CHIPS);
        assert_eq!(chips_unit_for("\u{85}1.5"), CHIPS);
    }

    #[test]
    fn formats_amounts_like_the_typescript() {
        let usd = usd();
        let f = |amount, style, group| format_amount(amount, &usd, style, group);
        assert_eq!(f(50, DecimalStyle::Minimal, false), "$0.5");
        assert_eq!(f(50, DecimalStyle::Fixed2, false), "$0.50");
        assert_eq!(f(300, DecimalStyle::Fixed2, false), "$3");
        assert_eq!(f(-1234, DecimalStyle::Minimal, false), "-$12.34");
        assert_eq!(f(2192900, DecimalStyle::Minimal, true), "$21,929");
        assert_eq!(f(123456789, DecimalStyle::Fixed2, true), "$1,234,567.89");
        assert_eq!(f(0, DecimalStyle::Minimal, false), "$0");
        let chips = CHIPS.unit();
        assert_eq!(
            format_amount(21929, &chips, DecimalStyle::Minimal, true),
            "21,929"
        );
        assert_eq!(
            format_amount_digits(-2260, &chips, DecimalStyle::Minimal, false),
            "-2260"
        );
        // Three-decimal units go through toFixed(2) on the double quotient.
        let milli = cash_unit_with_minor_units("M", "", 1000);
        assert_eq!(
            format_amount(1005, &milli, DecimalStyle::Fixed2, false),
            "1.00"
        );
        assert_eq!(
            format_amount(1001, &milli, DecimalStyle::Minimal, false),
            "1"
        );
        assert_eq!(
            format_amount(1500, &milli, DecimalStyle::Minimal, false),
            "1.5"
        );
        // Beyond 2^53 JavaScript holds the nearest double and prints it.
        assert_eq!(
            format_amount(
                1_152_921_504_606_846_976,
                &chips,
                DecimalStyle::Minimal,
                false
            ),
            "1152921504606847000"
        );
        assert_eq!(
            format_amount(Amount::MIN, &chips, DecimalStyle::Minimal, false),
            "-9223372036854776000"
        );
    }

    #[test]
    fn groups_digits_like_the_lookahead_regex() {
        assert_eq!(group_digits("1"), "1");
        assert_eq!(group_digits("123"), "123");
        assert_eq!(group_digits("1234"), "1,234");
        assert_eq!(group_digits("1234567.891"), "1,234,567.891");
        assert_eq!(group_digits("Infinity"), "Infinity");
    }
}
