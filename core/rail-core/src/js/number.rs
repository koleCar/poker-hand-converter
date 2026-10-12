//! JavaScript numbers (IEEE-754 binary64), in integer arithmetic.
//!
//! The TypeScript reference does its money arithmetic on `number`:
//! `Math.round(Number("0.29") * 100)`, `(1050 / 100).toFixed(2)`. To give the
//! same answer for every input - including the ones where binary floating point
//! is visibly inexact - the port has to perform the same IEEE-754 operations
//! with the same rounding. The workspace denies float arithmetic (an amount
//! computed in floats is how money drifts), so this module does it the long
//! way: a [`JsNumber`] is a sign, an integer significand and a power-of-two
//! exponent, and every operation computes the exact result in `u128` and
//! rounds it once, to nearest, ties to even, exactly as the hardware would.
//!
//! Only what the ported code needs is here: `Number(string)`, `+`, `-`, `*`,
//! `/`, `Math.round`, `Number.prototype.toFixed`, `String(number)`, and exact
//! conversions to and from integers. `f64` appears only as an opaque bit
//! pattern (`from_bits`/`to_bits`), for the correctly rounded decimal parser
//! and the shortest-digits printer of the standard library - neither is
//! arithmetic on floats in our code.
//!
//! `tests/data/js-number-vectors.json` holds operations computed by Node (see
//! `js-number-vectors.mjs` next to it); the unit tests below replay all of
//! them.

use std::cmp::Ordering;

/// Largest exponent of a finite double whose significand is 53 bits:
/// `(2^53 - 1) * 2^971` is `f64::MAX`.
const MAX_EXP: i32 = 971;
/// Exponent of the subnormals: the smallest positive double is `1 * 2^-1074`.
const MIN_EXP: i32 = -1074;
/// The hidden bit of a normal significand.
const HIDDEN: u64 = 1 << 52;

/// A JavaScript `number`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsNumber {
    /// `NaN`.
    Nan,
    /// `Infinity` or `-Infinity`.
    Infinite { negative: bool },
    /// `(-1)^negative * significand * 2^exponent`, normalized: either
    /// `2^52 <= significand < 2^53` (a normal number), or
    /// `exponent == -1074` and `significand < 2^52` (a subnormal or zero).
    /// Zero is `significand == 0, exponent == -1074`; `-0` keeps its sign.
    Finite {
        negative: bool,
        significand: u64,
        exponent: i32,
    },
}

/// `+0`.
impl Default for JsNumber {
    fn default() -> Self {
        Self::ZERO
    }
}

impl JsNumber {
    /// `+0`.
    pub const ZERO: Self = Self::Finite {
        negative: false,
        significand: 0,
        exponent: MIN_EXP,
    };

    fn zero(negative: bool) -> Self {
        Self::Finite {
            negative,
            significand: 0,
            exponent: MIN_EXP,
        }
    }

    /// The value of an `f64` bit pattern.
    pub fn from_f64(value: f64) -> Self {
        let bits = value.to_bits();
        let negative = bits >> 63 == 1;
        let biased = (bits >> 52) & 0x7ff;
        let fraction = bits & (HIDDEN - 1);
        if biased == 0x7ff {
            return if fraction == 0 {
                Self::Infinite { negative }
            } else {
                Self::Nan
            };
        }
        if biased == 0 {
            return Self::Finite {
                negative,
                significand: fraction,
                exponent: MIN_EXP,
            };
        }
        // biased is 1..=2046, so the exponent is -1074..=971.
        let exponent = i32::try_from(biased).unwrap_or(0) - 1075;
        Self::Finite {
            negative,
            significand: fraction | HIDDEN,
            exponent,
        }
    }

    /// The `f64` with this value (bit for bit).
    pub fn to_f64(self) -> f64 {
        let bits = match self {
            Self::Nan => 0x7ff8_0000_0000_0000,
            Self::Infinite { negative } => (u64::from(negative) << 63) | (0x7ff << 52),
            Self::Finite {
                negative,
                significand,
                exponent,
            } => {
                let sign = u64::from(negative) << 63;
                if significand < HIDDEN {
                    sign | significand
                } else {
                    let biased = u64::try_from(exponent + 1075).unwrap_or(0);
                    sign | (biased << 52) | (significand & (HIDDEN - 1))
                }
            }
        };
        f64::from_bits(bits)
    }

    /// The double nearest to `value` (exact up to 2^53).
    pub fn from_i64(value: i64) -> Self {
        Self::from_integer(value < 0, u128::from(value.unsigned_abs()))
    }

    /// The double nearest to `value`.
    pub fn from_u64(value: u64) -> Self {
        Self::from_integer(false, u128::from(value))
    }

    /// The double nearest to `±magnitude`.
    pub fn from_integer(negative: bool, magnitude: u128) -> Self {
        round_pack(negative, magnitude, 0, false)
    }

    pub fn is_nan(self) -> bool {
        matches!(self, Self::Nan)
    }

    /// `Number.isFinite`.
    pub fn is_finite(self) -> bool {
        matches!(self, Self::Finite { .. })
    }

    /// The sign bit (`true` for `-0`, `false` for `NaN`).
    pub fn is_sign_negative(self) -> bool {
        match self {
            Self::Nan => false,
            Self::Infinite { negative } | Self::Finite { negative, .. } => negative,
        }
    }

    /// `-x`.
    fn negate(self) -> Self {
        match self {
            Self::Nan => Self::Nan,
            Self::Infinite { negative } => Self::Infinite {
                negative: !negative,
            },
            Self::Finite {
                negative,
                significand,
                exponent,
            } => Self::Finite {
                negative: !negative,
                significand,
                exponent,
            },
        }
    }

    /// `Math.abs(x)`.
    pub fn abs(self) -> Self {
        if self.is_sign_negative() {
            self.negate()
        } else {
            self
        }
    }

    /// `a * b`.
    fn multiply(self, other: Self) -> Self {
        match (self, other) {
            (Self::Nan, _) | (_, Self::Nan) => Self::Nan,
            (Self::Infinite { negative: a }, Self::Infinite { negative: b }) => {
                Self::Infinite { negative: a != b }
            }
            (Self::Infinite { negative: a }, finite @ Self::Finite { .. })
            | (finite @ Self::Finite { .. }, Self::Infinite { negative: a }) => {
                if finite.is_zero() {
                    Self::Nan
                } else {
                    Self::Infinite {
                        negative: a != finite.is_sign_negative(),
                    }
                }
            }
            (
                Self::Finite {
                    negative: na,
                    significand: sa,
                    exponent: ea,
                },
                Self::Finite {
                    negative: nb,
                    significand: sb,
                    exponent: eb,
                },
            ) => {
                let negative = na != nb;
                if sa == 0 || sb == 0 {
                    return Self::zero(negative);
                }
                round_pack(negative, u128::from(sa) * u128::from(sb), ea + eb, false)
            }
        }
    }

    /// `a + b`.
    fn plus(self, other: Self) -> Self {
        match (self, other) {
            (Self::Nan, _) | (_, Self::Nan) => Self::Nan,
            (Self::Infinite { negative: a }, Self::Infinite { negative: b }) => {
                if a == b {
                    Self::Infinite { negative: a }
                } else {
                    Self::Nan
                }
            }
            (infinite @ Self::Infinite { .. }, Self::Finite { .. })
            | (Self::Finite { .. }, infinite @ Self::Infinite { .. }) => infinite,
            (
                Self::Finite {
                    negative: na,
                    significand: sa,
                    exponent: ea,
                },
                Self::Finite {
                    negative: nb,
                    significand: sb,
                    exponent: eb,
                },
            ) => {
                if sa == 0 && sb == 0 {
                    // -0 + -0 is -0; every other sum of zeros is +0.
                    return Self::zero(na && nb);
                }
                if sa == 0 {
                    return other;
                }
                if sb == 0 {
                    return self;
                }
                add_finite((na, sa, ea), (nb, sb, eb))
            }
        }
    }

    /// `a / b`.
    fn divide(self, other: Self) -> Self {
        match (self, other) {
            (Self::Nan, _) | (_, Self::Nan) | (Self::Infinite { .. }, Self::Infinite { .. }) => {
                Self::Nan
            }
            (Self::Infinite { negative }, divisor) => Self::Infinite {
                negative: negative != divisor.is_sign_negative(),
            },
            (dividend, Self::Infinite { negative }) => {
                Self::zero(negative != dividend.is_sign_negative())
            }
            (
                Self::Finite {
                    negative: na,
                    significand: sa,
                    exponent: ea,
                },
                Self::Finite {
                    negative: nb,
                    significand: sb,
                    exponent: eb,
                },
            ) => {
                let negative = na != nb;
                match (sa == 0, sb == 0) {
                    (true, true) => Self::Nan,
                    (false, true) => Self::Infinite { negative },
                    (true, false) => Self::zero(negative),
                    (false, false) => {
                        // Both significands to exactly 53 bits, then a quotient
                        // of at least 55 bits plus a sticky remainder.
                        let (sa, ea) = normalize53(sa, ea);
                        let (sb, eb) = normalize53(sb, eb);
                        let numerator = u128::from(sa) << 56;
                        let divisor = u128::from(sb);
                        let quotient = numerator / divisor;
                        let sticky = numerator % divisor != 0;
                        round_pack(negative, quotient, ea - eb - 56, sticky)
                    }
                }
            }
        }
    }

    /// `Math.round(x)`: the nearest integer, halves rounded towards +∞.
    pub fn round(self) -> Self {
        let Self::Finite {
            negative,
            significand,
            exponent,
        } = self
        else {
            return self;
        };
        if exponent >= 0 || significand == 0 {
            return self;
        }
        let shift = exponent.unsigned_abs();
        if shift > 64 {
            // |x| < 2^53 * 2^-65 < 0.5: rounds to a zero of the same sign.
            return Self::zero(negative);
        }
        let value = u128::from(significand);
        let integer = value >> shift;
        let fraction = value & ((1_u128 << shift) - 1);
        let half = 1_u128 << (shift - 1);
        // floor(x + 0.5): for x >= 0 a half goes up; for x < 0 (|x| = i + f)
        // the magnitude goes up only when f is strictly more than a half.
        let up = if negative {
            fraction > half
        } else {
            fraction >= half
        };
        let magnitude = integer + u128::from(up);
        if magnitude == 0 {
            return Self::zero(negative);
        }
        round_pack(negative, magnitude, 0, false)
    }

    fn is_zero(self) -> bool {
        matches!(self, Self::Finite { significand: 0, .. })
    }

    /// The exact value when it is an integer whose magnitude fits a `u128`.
    fn integer_magnitude(self) -> Option<(bool, u128)> {
        let Self::Finite {
            negative,
            significand,
            exponent,
        } = self
        else {
            return None;
        };
        if significand == 0 {
            return Some((negative, 0));
        }
        if exponent >= 0 {
            let shift = exponent.unsigned_abs();
            // A 53-bit significand shifted by up to 75 still fits.
            (shift <= 75).then(|| (negative, u128::from(significand) << shift))
        } else {
            let shift = exponent.unsigned_abs();
            if shift >= 64 {
                return None;
            }
            let value = u128::from(significand);
            (value & ((1_u128 << shift) - 1) == 0).then(|| (negative, value >> shift))
        }
    }

    /// `Number.isInteger(x)`.
    pub fn is_integer(self) -> bool {
        match self {
            Self::Finite { exponent, .. } if exponent >= 0 => true,
            Self::Finite { .. } => self.integer_magnitude().is_some(),
            _ => false,
        }
    }

    /// The value as an `i64` when it is an integer in range (`-0` is `0`).
    pub fn to_i64(self) -> Option<i64> {
        let (negative, magnitude) = self.integer_magnitude()?;
        if negative {
            let magnitude = i128::try_from(magnitude).ok()?;
            i64::try_from(-magnitude).ok()
        } else {
            i64::try_from(magnitude).ok()
        }
    }

    /// The value as an `i64` when it is a safe integer (`Number.isSafeInteger`).
    pub fn to_safe_integer(self) -> Option<i64> {
        self.to_i64()
            .filter(|n| n.unsigned_abs() <= crate::canonical::MAX_SAFE_INTEGER.unsigned_abs())
    }

    /// `Number(text)`: JavaScript's StringToNumber.
    ///
    /// Surrounding JS whitespace is ignored; the empty string is `0`;
    /// `Infinity` with an optional sign; `0x`/`0o`/`0b` integers (unsigned);
    /// decimal literals with an optional sign, fraction and exponent, where
    /// `5.` and `.5` are allowed but `.` is not. Anything else is `NaN` - no
    /// `parseFloat`-style prefix reading, no `_` separators.
    pub fn parse(text: &str) -> Self {
        let text = super::trim(text);
        if text.is_empty() {
            return Self::ZERO;
        }
        match text {
            "Infinity" | "+Infinity" => return Self::Infinite { negative: false },
            "-Infinity" => return Self::Infinite { negative: true },
            _ => {}
        }
        let bytes = text.as_bytes();
        if bytes.len() > 2 && bytes[0] == b'0' {
            let radix = match bytes[1] {
                b'x' | b'X' => Some(16),
                b'o' | b'O' => Some(8),
                b'b' | b'B' => Some(2),
                _ => None,
            };
            if let Some(radix) = radix {
                return parse_radix(&text[2..], radix);
            }
        }
        if !is_decimal_literal(bytes) {
            return Self::Nan;
        }
        // Rust's parser is correctly rounded and accepts the same decimal
        // grammar once it has been validated above (it would also accept
        // `inf` and `nan`, which JavaScript does not).
        text.parse::<f64>().map_or(Self::Nan, Self::from_f64)
    }

    /// `Number.prototype.toFixed(digits)` for `digits <= 17`.
    ///
    /// The integer `n` nearest to `x * 10^digits` (the larger one on a tie),
    /// written with `digits` decimals; `|x| >= 1e21` prints as `String(x)`.
    ///
    /// # Panics
    ///
    /// When `digits > 17` (JavaScript allows up to 100; nothing in the port
    /// asks for more than 2, and 17 keeps the arithmetic inside `u128`).
    pub fn to_fixed(self, digits: u32) -> String {
        assert!(digits <= 17, "toFixed({digits}) is not supported");
        let Self::Finite {
            negative,
            significand,
            exponent,
        } = self
        else {
            return self.to_js_string();
        };
        if self
            .abs()
            .compare(Self::from_integer(false, 10_u128.pow(21)))
            != Some(Ordering::Less)
        {
            return self.to_js_string();
        }
        let scaled = u128::from(significand) * 10_u128.pow(digits);
        let n = if exponent >= 0 {
            scaled << exponent.unsigned_abs()
        } else {
            let shift = exponent.unsigned_abs();
            if shift >= 121 {
                // scaled < 2^120, so x * 10^digits < 0.5.
                0
            } else {
                let integer = scaled >> shift;
                let rest = scaled & ((1_u128 << shift) - 1);
                integer + u128::from(rest >= 1_u128 << (shift - 1))
            }
        };
        let mut text = n.to_string();
        if digits > 0 {
            let digits = usize::try_from(digits).unwrap_or(0);
            if text.len() <= digits {
                text = format!("{}{text}", "0".repeat(digits + 1 - text.len()));
            }
            text.insert(text.len() - digits, '.');
        }
        // `(-0).toFixed(2)` is "0.00", `(-0.001).toFixed(2)` is "-0.00": the
        // sign is that of x, and -0 is not below zero.
        if negative && significand != 0 {
            text.insert(0, '-');
        }
        text
    }

    /// `String(x)`: JavaScript's Number::toString, shortest round-trip digits.
    pub fn to_js_string(self) -> String {
        let Self::Finite {
            negative,
            significand,
            ..
        } = self
        else {
            return match self {
                Self::Infinite { negative: true } => "-Infinity".to_owned(),
                Self::Infinite { negative: false } => "Infinity".to_owned(),
                _ => "NaN".to_owned(),
            };
        };
        if significand == 0 {
            return "0".to_owned();
        }
        // Number::toString wants the fewest digits k that round-trip and, of
        // the k-digit decimals that do, the one closest to x - the even one on
        // a tie. Rust's `{:e}` gives the fewest digits but not always the
        // closest of them (272624529362896.625 prints as ...63, JavaScript
        // says ...62); `{:.N e}` rounds the exact value half-to-even, which is
        // the closest, and is kept whenever it round-trips.
        let x = self.abs().to_f64();
        let shortest = format!("{x:e}");
        let k = shortest
            .split_once('e')
            .map_or(0, |(m, _)| m.chars().filter(char::is_ascii_digit).count());
        let closest = format!("{x:.prec$e}", prec = k.saturating_sub(1));
        let scientific = if closest
            .parse::<f64>()
            .is_ok_and(|v| v.to_bits() == x.to_bits())
        {
            closest
        } else {
            shortest
        };
        let (mantissa, exp) = scientific.split_once('e').unwrap_or((&scientific, "0"));
        let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
        let digits = digits.trim_end_matches('0');
        let digits = if digits.is_empty() { "0" } else { digits };
        let k = i64::try_from(digits.len()).unwrap_or(0);
        let n = exp.parse::<i64>().unwrap_or(0) + 1;
        let body = if k <= n && n <= 21 {
            format!(
                "{digits}{}",
                "0".repeat(usize::try_from(n - k).unwrap_or(0))
            )
        } else if 0 < n && n <= 21 {
            let (int, frac) = digits.split_at(usize::try_from(n).unwrap_or(0));
            format!("{int}.{frac}")
        } else if -6 < n && n <= 0 {
            format!("0.{}{digits}", "0".repeat(usize::try_from(-n).unwrap_or(0)))
        } else {
            let e = n - 1;
            let sign = if e < 0 { '-' } else { '+' };
            let (first, rest) = digits.split_at(1);
            if rest.is_empty() {
                format!("{first}e{sign}{}", e.unsigned_abs())
            } else {
                format!("{first}.{rest}e{sign}{}", e.unsigned_abs())
            }
        };
        if negative { format!("-{body}") } else { body }
    }

    /// `a === b` between numbers: `NaN` equals nothing, `-0 === 0`. (The
    /// derived `PartialEq` is structural and tells `-0` from `0`.)
    pub fn strict_equals(self, other: Self) -> bool {
        self.compare(other) == Some(Ordering::Equal)
    }

    /// `a < b` (false when either is `NaN`).
    pub fn less_than(self, other: Self) -> bool {
        self.compare(other) == Some(Ordering::Less)
    }

    /// `a > b` (false when either is `NaN`).
    pub fn greater_than(self, other: Self) -> bool {
        self.compare(other) == Some(Ordering::Greater)
    }

    /// `Math.max(a, b)`: `NaN` if either is, and `+0` over `-0`.
    pub fn max_of(self, other: Self) -> Self {
        if self.is_nan() || other.is_nan() {
            Self::Nan
        } else if self.greater_than(other) {
            self
        } else if other.greater_than(self) || self.is_sign_negative() {
            other
        } else {
            self
        }
    }

    /// `Math.min(a, b)`: `NaN` if either is, and `-0` over `+0`.
    pub fn min_of(self, other: Self) -> Self {
        if self.is_nan() || other.is_nan() {
            Self::Nan
        } else if self.less_than(other) {
            self
        } else if other.less_than(self) || other.is_sign_negative() {
            other
        } else {
            self
        }
    }

    /// `x % modulus === 0`: true exactly when `x` is finite and an integer
    /// multiple of `modulus` (`%` on doubles is exact, so this is too).
    /// `false` for a `modulus` of 0 (`x % 0` is `NaN`).
    pub fn is_multiple_of(self, modulus: u64) -> bool {
        let Self::Finite {
            significand,
            exponent,
            ..
        } = self
        else {
            return false;
        };
        if modulus == 0 {
            return false;
        }
        if significand == 0 {
            return true;
        }
        let modulus = u128::from(modulus);
        if exponent >= 0 {
            // significand * 2^exponent, reduced modulo `modulus` step by step.
            let mut rest = u128::from(significand) % modulus;
            for _ in 0..exponent {
                rest = (rest * 2) % modulus;
            }
            return rest == 0;
        }
        let shift = exponent.unsigned_abs();
        if shift >= 64 || significand & ((1_u64 << shift) - 1) != 0 {
            // Not an integer, so no multiple of an integer.
            return false;
        }
        u128::from(significand >> shift) % modulus == 0
    }

    /// `Math.floor(x)`.
    ///
    /// From [`round`](Self::round), which is `floor(x + 0.5)`: for a
    /// non-integer `x` it is `floor(x)` or one more, and one more exactly
    /// when it lands above `x`; the `- 1` is then exact, because a double
    /// with a fraction is below 2^52 in magnitude.
    pub fn floor(self) -> Self {
        let rounded = self.round();
        if rounded.greater_than(self) {
            rounded - Self::from_i64(1)
        } else {
            rounded
        }
    }

    /// Numeric comparison (`None` when either side is `NaN`; `-0 == 0`).
    pub fn compare(self, other: Self) -> Option<Ordering> {
        match (self, other) {
            (Self::Nan, _) | (_, Self::Nan) => None,
            (Self::Infinite { negative: a }, Self::Infinite { negative: b }) => Some(b.cmp(&a)),
            (Self::Infinite { negative }, _) => Some(if negative {
                Ordering::Less
            } else {
                Ordering::Greater
            }),
            (_, Self::Infinite { negative }) => Some(if negative {
                Ordering::Greater
            } else {
                Ordering::Less
            }),
            _ => {
                // Both finite: the sign of the exact difference.
                let difference = self - other;
                Some(if difference.is_zero() {
                    Ordering::Equal
                } else if difference.is_sign_negative() {
                    Ordering::Less
                } else {
                    Ordering::Greater
                })
            }
        }
    }
}

/// `-x`.
impl std::ops::Neg for JsNumber {
    type Output = Self;
    fn neg(self) -> Self {
        self.negate()
    }
}

/// `a + b`, rounded once.
impl std::ops::Add for JsNumber {
    type Output = Self;
    fn add(self, other: Self) -> Self {
        self.plus(other)
    }
}

/// `a - b`, rounded once.
impl std::ops::Sub for JsNumber {
    type Output = Self;
    fn sub(self, other: Self) -> Self {
        self.plus(other.negate())
    }
}

/// `a * b`, rounded once.
impl std::ops::Mul for JsNumber {
    type Output = Self;
    fn mul(self, other: Self) -> Self {
        self.multiply(other)
    }
}

/// `a / b`, rounded once.
impl std::ops::Div for JsNumber {
    type Output = Self;
    fn div(self, other: Self) -> Self {
        self.divide(other)
    }
}

/// `significand * 2^exponent` with the significand shifted to exactly 53 bits
/// (the exponent may then go below -1074; only used internally).
fn normalize53(significand: u64, exponent: i32) -> (u64, i32) {
    let shift = significand.leading_zeros() - 11;
    (
        significand << shift,
        exponent - i32::try_from(shift).unwrap_or(0),
    )
}

/// Sum of two non-zero finite values, rounded once.
fn add_finite(a: (bool, u64, i32), b: (bool, u64, i32)) -> JsNumber {
    // Order by exponent; the larger exponent's significand is shifted left
    // onto the smaller exponent's scale.
    let (big, small) = if a.2 >= b.2 { (a, b) } else { (b, a) };
    let gap = (big.2 - small.2).unsigned_abs();
    if gap <= 72 {
        let scaled_big = i128::from(big.1) << gap;
        let small_value = i128::from(small.1);
        let signed = |negative: bool, value: i128| if negative { -value } else { value };
        let sum = signed(big.0, scaled_big) + signed(small.0, small_value);
        if sum == 0 {
            // x + (-x) is +0 when rounding to nearest.
            return JsNumber::ZERO;
        }
        return round_pack(sum < 0, sum.unsigned_abs(), small.2, false);
    }
    // The smaller operand is below 2^-19 of the larger's last bit: it can only
    // matter as the sticky bit that breaks a tie, and there is no tie to break
    // at three guard bits. (The larger is normal here: a subnormal has the
    // smallest exponent, so the gap would be zero.)
    let guarded = u128::from(big.1) << 3;
    if big.0 == small.0 {
        round_pack(big.0, guarded, big.2 - 3, true)
    } else {
        round_pack(big.0, guarded - 1, big.2 - 3, true)
    }
}

/// Rounds `±(magnitude + ε) * 2^exponent` to a double, to nearest, ties to
/// even. `sticky` says that the exact value has non-zero bits below
/// `magnitude`'s last one (0 < ε < 1); callers then supply at least 55
/// significant bits so the guard and round positions are in `magnitude`.
fn round_pack(negative: bool, magnitude: u128, exponent: i32, sticky: bool) -> JsNumber {
    if magnitude == 0 {
        return JsNumber::zero(negative);
    }
    let bits = i32::try_from(128 - magnitude.leading_zeros()).unwrap_or(0);
    // Keep 53 bits, or fewer when the result is subnormal.
    let shift = (bits - 53).max(MIN_EXP - exponent);
    let (mut significand, mut exponent) = if shift <= 0 {
        (magnitude << shift.unsigned_abs(), exponent + shift)
    } else {
        let right = shift.unsigned_abs();
        let (kept, rest) = if right >= 128 {
            (0, magnitude)
        } else {
            (magnitude >> right, magnitude & ((1_u128 << right) - 1))
        };
        // `rest` against half of the last kept bit, 2^(right - 1).
        let against_half = if right > 128 {
            Ordering::Less
        } else {
            rest.cmp(&(1_u128 << (right - 1)))
        };
        let up = match against_half {
            Ordering::Greater => true,
            Ordering::Equal => sticky || kept & 1 == 1,
            Ordering::Less => false,
        };
        (kept + u128::from(up), exponent + shift)
    };
    if significand == 1 << 53 {
        significand >>= 1;
        exponent += 1;
    }
    if exponent > MAX_EXP {
        return JsNumber::Infinite { negative };
    }
    JsNumber::Finite {
        negative,
        significand: u64::try_from(significand).unwrap_or(0),
        exponent,
    }
}

/// `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`
fn is_decimal_literal(bytes: &[u8]) -> bool {
    let mut i = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        i = 1;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - start;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == bytes.len()
}

/// A `0x`/`0o`/`0b` literal's digits, correctly rounded.
fn parse_radix(digits: &str, radix: u32) -> JsNumber {
    if digits.is_empty() {
        return JsNumber::Nan;
    }
    let bits_per_digit = radix.trailing_zeros();
    let mut value: u128 = 0;
    let mut dropped_bits: i32 = 0;
    let mut sticky = false;
    for c in digits.chars() {
        let Some(digit) = c.to_digit(radix) else {
            return JsNumber::Nan;
        };
        if value >> 120 == 0 {
            value = (value << bits_per_digit) | u128::from(digit);
        } else {
            // Enough significant bits for rounding; the rest only set sticky.
            dropped_bits += i32::try_from(bits_per_digit).unwrap_or(0);
            sticky |= digit != 0;
        }
    }
    round_pack(false, value, dropped_bits, sticky)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(text: &str) -> JsNumber {
        JsNumber::parse(text)
    }

    #[test]
    fn floor_max_and_comparisons_are_javascript_s() {
        let s = |x: JsNumber| x.to_js_string();
        // Math.floor
        for (input, floor) in [
            ("0.7", "0"),
            ("-0.3", "-1"),
            ("-0.5", "-1"),
            ("2.5", "2"),
            ("-2.5", "-3"),
            ("5", "5"),
            ("-7", "-7"),
            ("4503599627370495.5", "4503599627370495"),
            ("-4503599627370495.5", "-4503599627370496"),
            ("9007199254740993", "9007199254740992"),
        ] {
            assert_eq!(s(n(input).floor()), floor, "Math.floor({input})");
        }
        assert!(n("-0").floor().is_sign_negative());
        assert!(n("NaN").floor().is_nan());
        assert_eq!(
            s((JsNumber::from_i64(-7) / JsNumber::from_i64(10)).floor()),
            "-1"
        );
        // Math.max
        assert_eq!(s(n("1").max_of(n("-3"))), "1");
        assert_eq!(s(n("-3").max_of(n("2"))), "2");
        assert!(!n("-0").max_of(n("0")).is_sign_negative());
        assert!(!n("0").max_of(n("-0")).is_sign_negative());
        assert!(n("-0").max_of(n("-0")).is_sign_negative());
        assert!(n("NaN").max_of(n("1")).is_nan());
        // === , < , >
        assert!(n("-0").strict_equals(n("0")));
        assert!(!n("NaN").strict_equals(n("NaN")));
        assert!(n("1").less_than(n("2")) && !n("NaN").less_than(n("2")));
        assert!(n("2").greater_than(n("1")) && !n("2").greater_than(n("NaN")));
        // String(-0) is "0".
        assert_eq!(s(-JsNumber::ZERO), "0");
    }

    #[test]
    fn round_trips_f64_bit_patterns() {
        for value in [
            0.0,
            -0.0,
            1.0,
            0.1,
            5e-324,
            2.2250738585072014e-308,
            f64::MAX,
            -3.5,
        ] {
            assert_eq!(
                JsNumber::from_f64(value).to_f64().to_bits(),
                value.to_bits()
            );
        }
        assert!(JsNumber::from_f64(f64::NAN).is_nan());
    }

    #[test]
    fn parses_like_number() {
        assert_eq!(n("").to_i64(), Some(0));
        assert_eq!(n("  12 ").to_i64(), Some(12));
        assert_eq!(n("\u{FEFF}7\u{3000}").to_i64(), Some(7));
        assert_eq!(n("5.").to_js_string(), "5");
        assert_eq!(n(".5").to_js_string(), "0.5");
        assert_eq!(n("-.5").to_js_string(), "-0.5");
        assert_eq!(n("0x1F").to_i64(), Some(31));
        assert_eq!(n("0b101").to_i64(), Some(5));
        assert_eq!(n("0o17").to_i64(), Some(15));
        assert!(n("-0x1F").is_nan());
        assert!(n(".").is_nan());
        assert!(n("-").is_nan());
        assert!(n("1,5").is_nan());
        assert!(n("1_0").is_nan());
        assert!(n("inf").is_nan());
        assert!(n("NaN").is_nan());
        assert!(n("1e").is_nan());
        assert_eq!(n("1e3").to_i64(), Some(1000));
        assert_eq!(n("Infinity"), JsNumber::Infinite { negative: false });
        assert_eq!(n("1e400"), JsNumber::Infinite { negative: false });
        assert!(n("-0").is_sign_negative());
    }

    #[test]
    fn multiplies_like_ieee() {
        // The classic: 0.29 * 100 is 28.999999999999996 in binary64.
        assert_eq!((n("0.29") * n("100")).to_js_string(), "28.999999999999996");
        assert_eq!((n("0.29") * n("100")).round().to_i64(), Some(29));
        assert_eq!((n("1.005") * n("100")).to_js_string(), "100.49999999999999");
        assert_eq!((n("1.005") * n("100")).round().to_i64(), Some(100));
        assert_eq!((n("1.23") * n("100")).to_js_string(), "123");
        assert_eq!((n("1.1") * n("100")).to_js_string(), "110.00000000000001");
    }

    #[test]
    fn rounds_halves_towards_positive_infinity() {
        assert_eq!(n("0.5").round().to_i64(), Some(1));
        assert_eq!(n("2.5").round().to_i64(), Some(3));
        assert_eq!(n("-0.5").round().to_js_string(), "0");
        assert!(n("-0.5").round().is_sign_negative());
        assert_eq!(n("-1.5").round().to_i64(), Some(-1));
        assert_eq!(n("-1.5000001").round().to_i64(), Some(-2));
        assert_eq!(n("0.49999999999999994").round().to_i64(), Some(0));
    }

    #[test]
    fn formats_like_to_fixed_and_string() {
        assert_eq!(n("1.005").to_fixed(2), "1.00");
        assert_eq!(n("10.5").to_fixed(2), "10.50");
        assert_eq!(n("-0.001").to_fixed(2), "-0.00");
        assert_eq!(n("-0").to_fixed(2), "0.00");
        assert_eq!(n("0.125").to_fixed(2), "0.13");
        assert_eq!(n("1e21").to_fixed(2), "1e+21");
        assert_eq!(n("123").to_fixed(0), "123");
        assert_eq!(
            n("1152921504606846976").to_js_string(),
            "1152921504606847000"
        );
        assert_eq!(n("1e21").to_js_string(), "1e+21");
        assert_eq!(n("0.000001").to_js_string(), "0.000001");
        assert_eq!(n("0.0000001").to_js_string(), "1e-7");
        assert_eq!(n("-1.5e-10").to_js_string(), "-1.5e-10");
        assert_eq!(n("123e20").to_js_string(), "1.23e+22");
        assert_eq!(n("123e18").to_js_string(), "123000000000000000000");
        // Two 17-digit decimals round-trip; JavaScript takes the even one.
        assert_eq!(
            n("272624529362896.625").to_js_string(),
            "272624529362896.62"
        );
    }

    #[test]
    fn divides_and_adds_like_ieee() {
        assert_eq!((n("1050") / n("100")).to_js_string(), "10.5");
        assert_eq!((n("1") / n("3")).to_js_string(), "0.3333333333333333");
        assert_eq!((n("0.1") + n("0.2")).to_js_string(), "0.30000000000000004");
        assert_eq!((n("1") - n("1")), JsNumber::ZERO);
        assert_eq!(
            (n("1e300") * n("1e300")),
            JsNumber::Infinite { negative: false }
        );
        assert!((n("0") / n("0")).is_nan());
        assert_eq!(
            (n("5e-324") / n("2")).to_js_string(),
            "0",
            "a tie at the smallest subnormal rounds to even (zero)"
        );
    }

    #[test]
    fn converts_integers_exactly_where_javascript_can() {
        assert_eq!(JsNumber::from_i64(-42).to_i64(), Some(-42));
        assert_eq!(JsNumber::from_i64(i64::MIN).to_i64(), Some(i64::MIN));
        assert_eq!(
            JsNumber::from_u64(9_007_199_254_740_993).to_js_string(),
            "9007199254740992"
        );
        assert_eq!(n("9007199254740992").to_safe_integer(), None);
        assert_eq!(
            n("9007199254740991").to_safe_integer(),
            Some(9_007_199_254_740_991)
        );
        assert_eq!(n("1.5").to_i64(), None);
        assert!(n("1e300").is_integer());
        assert_eq!(n("1e300").to_i64(), None);
    }

    /// Every operation Node computed in `tests/data/js-number-vectors.json`.
    #[test]
    fn agrees_with_node_on_the_recorded_vectors() {
        let text = include_str!("../../tests/data/js-number-vectors.json");
        let vectors: serde_json::Value = serde_json::from_str(text).expect("vectors parse");
        let cases = vectors["cases"].as_array().expect("cases");
        assert!(cases.len() > 1000, "too few vectors");
        let mut failures = Vec::new();
        for case in cases {
            let op = case["op"].as_str().unwrap_or_default();
            let a = n(case["a"].as_str().unwrap_or_default());
            let b = case.get("b").and_then(serde_json::Value::as_str).map(n);
            let expected = case["out"].as_str().unwrap_or_default();
            let actual = match (op, b) {
                ("parse", _) => a.to_js_string(),
                ("mul", Some(b)) => (a * b).to_js_string(),
                ("add", Some(b)) => (a + b).to_js_string(),
                ("sub", Some(b)) => (a - b).to_js_string(),
                ("div", Some(b)) => (a / b).to_js_string(),
                ("round", _) => a.round().to_js_string(),
                ("toFixed2", _) => a.to_fixed(2),
                ("toFixed0", _) => a.to_fixed(0),
                _ => panic!("unknown vector {case}"),
            };
            if actual != expected {
                failures.push(format!("{case}: got {actual}"));
            }
        }
        assert!(
            failures.is_empty(),
            "{} mismatches:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
}
