//! The few JavaScript semantics the port must reproduce bit for bit:
//! `Math.round`, `Number.prototype.toString` and `JSON.stringify` of numbers
//! and strings. Bet labels (`B6.5`) and the chunk's JSON header are built
//! from them, and both must come out byte-identical to the TypeScript's.

use std::fmt::Write as _;

/// `Math.round`: the nearest integer, halves toward +∞ (`-2.5` → `-2`).
#[must_use]
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    // `x - f` is exact: both are within one unit of each other.
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    // Math.round(-0.4) is -0; the sign never reaches a label or the JSON
    // (both print -0 as "0"), but keep it anyway.
    if r == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        r
    }
}

/// `String(x)` for a finite or non-finite number (ECMAScript Number::toString).
#[must_use]
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    let mut out = String::new();
    let v = if x < 0.0 {
        out.push('-');
        -x
    } else {
        x
    };
    // Rust's `{:e}` prints the shortest digits that round-trip, as JS does.
    let e = format!("{v:e}");
    let (mantissa, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        let _ = write!(out, "{}", (n - 1).abs());
    }
    out
}

/// A number as `JSON.stringify` writes it: non-finite numbers become `null`.
pub fn json_number(out: &mut String, x: f64) {
    if x.is_finite() {
        out.push_str(&number_to_string(x));
    } else {
        out.push_str("null");
    }
}

/// A string as `JSON.stringify` writes it.
pub fn json_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        let cases: [(f64, &str); 16] = [
            (0.0, "0"),
            (-0.0, "0"),
            (3.0, "3"),
            (6.5, "6.5"),
            (0.1, "0.1"),
            (1.0 / 3.0, "0.3333333333333333"),
            (0.000_015, "0.000015"),
            (1.5e-7, "1.5e-7"),
            (1e-7, "1e-7"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123_456.789, "123456.789"),
            (-2.25, "-2.25"),
            (2.5e-5, "0.000025"),
            (1.234_567_890_123_456_7e25, "1.2345678901234566e+25"),
            (100.0, "100"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(x), want, "{x:e}");
        }
    }

    #[test]
    fn round_is_half_up() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(-2.6), -3.0);
        assert_eq!(math_round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(math_round(650.0), 650.0);
    }
}
