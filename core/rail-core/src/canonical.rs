//! Canonical JSON: the byte form the golden oracle is written in.
//!
//! The definition lives in `testdata/golden/README.md` ("Canonical JSON") and
//! the TypeScript writer in `tests/scripts/golden/canonical.ts`. In short:
//! keys sorted by their UTF-8 bytes, two-space indentation, `": "` after a
//! key, `[]` / `{}` for empty containers, serde_json's string escaping,
//! integers only (within ±(2^53 - 1)), absent fields omitted and `null`
//! written, and exactly one `\n` at the end.
//!
//! That is `serde_json::to_string_pretty` of a [`serde_json::Value`] whose
//! objects are sorted, plus the newline. The objects are sorted explicitly
//! ([`Value::sort_all_objects`]) rather than by relying on serde_json's
//! `preserve_order` feature being off: features unify across a build, and a
//! dependency that turned it on would otherwise change these bytes silently.
//!
//! The PHF hash in the committed goldens is the sha-256 of
//! `to_canonical_json(&hand)` for each hand, serialized on its own.

use std::fmt;

use serde::Serialize;
use serde_json::Value;

/// The largest integer JavaScript holds exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Why a value has no canonical form.
#[derive(Debug)]
pub enum CanonicalJsonError {
    /// The value did not serialize to JSON at all (e.g. a map with non-string keys).
    Serialize(serde_json::Error),
    /// A number that is not an integer, or one outside ±(2^53 - 1). PHF has
    /// no floats (PHF-SPEC §1), and the TypeScript side could not hold the
    /// integer exactly. `path` is a JSONPath-like location (`$.actions[3].amount`).
    Number { path: String, value: String },
}

impl fmt::Display for CanonicalJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialize(error) => write!(f, "cannot serialize to JSON: {error}"),
            Self::Number { path, value } => write!(
                f,
                "{path}: {value} is not a safe integer (canonical JSON has integers only)"
            ),
        }
    }
}

impl std::error::Error for CanonicalJsonError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Serialize(error) => Some(error),
            Self::Number { .. } => None,
        }
    }
}

/// The canonical text of `value`, LF-terminated.
pub fn to_canonical_json<T: Serialize + ?Sized>(value: &T) -> Result<String, CanonicalJsonError> {
    let value = serde_json::to_value(value).map_err(CanonicalJsonError::Serialize)?;
    value_to_canonical_json(value)
}

/// The canonical text of an already-built [`Value`], LF-terminated.
pub fn value_to_canonical_json(mut value: Value) -> Result<String, CanonicalJsonError> {
    check_numbers(&value, &mut String::from("$"))?;
    value.sort_all_objects();
    let mut text = serde_json::to_string_pretty(&value).map_err(CanonicalJsonError::Serialize)?;
    text.push('\n');
    Ok(text)
}

fn check_numbers(value: &Value, path: &mut String) -> Result<(), CanonicalJsonError> {
    match value {
        Value::Number(number) => {
            let safe = if let Some(n) = number.as_i64() {
                (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n)
            } else if let Some(n) = number.as_u64() {
                u64::try_from(MAX_SAFE_INTEGER).is_ok_and(|max| n <= max)
            } else {
                false
            };
            if safe {
                Ok(())
            } else {
                Err(CanonicalJsonError::Number {
                    path: path.clone(),
                    value: number.to_string(),
                })
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                let len = path.len();
                path.push_str(&format!("[{i}]"));
                check_numbers(item, path)?;
                path.truncate(len);
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, item) in map {
                let len = path.len();
                path.push('.');
                path.push_str(key);
                check_numbers(item, path)?;
                path.truncate(len);
            }
            Ok(())
        }
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CanonicalJsonError, to_canonical_json, value_to_canonical_json};

    #[test]
    fn layout_matches_the_golden_definition() {
        let value = json!({
            "b": [1, -2, {"z": null, "a": true}],
            "a": {},
            "c": [],
            "s": "tab\there \"q\" \\ \u{1} \u{7f} / é 𝄞 \u{2028}",
        });
        let expected = concat!(
            "{\n",
            "  \"a\": {},\n",
            "  \"b\": [\n",
            "    1,\n",
            "    -2,\n",
            "    {\n",
            "      \"a\": true,\n",
            "      \"z\": null\n",
            "    }\n",
            "  ],\n",
            "  \"c\": [],\n",
            "  \"s\": \"tab\\there \\\"q\\\" \\\\ \\u0001 \u{7f} / é 𝄞 \u{2028}\"\n",
            "}\n",
        );
        assert_eq!(to_canonical_json(&value).ok().as_deref(), Some(expected));
    }

    /// UTF-8 byte order, not UTF-16 code-unit order: U+FF61 sorts before
    /// U+1F600 in UTF-8 (EF.. < F0..) but after it in UTF-16 (FF61 > D83D).
    #[test]
    fn keys_sort_by_utf8_bytes() {
        let value = json!({ "\u{1F600}": 1, "\u{FF61}": 2, "Z": 3, "a": 4 });
        let text = to_canonical_json(&value).unwrap_or_default();
        let order: Vec<usize> = ["\"Z\"", "\"a\"", "\"\u{FF61}\"", "\"\u{1F600}\""]
            .iter()
            .filter_map(|key| text.find(key))
            .collect();
        assert_eq!(order.len(), 4, "{text}");
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{text}");
    }

    #[test]
    fn floats_and_unsafe_integers_are_refused() {
        for bad in [
            json!({ "x": [0, { "y": 0.5 }] }),
            json!({ "x": 9_007_199_254_740_992_i64 }),
            json!({ "x": -9_007_199_254_740_992_i64 }),
            json!({ "x": u64::MAX }),
        ] {
            match value_to_canonical_json(bad) {
                Err(CanonicalJsonError::Number { path, .. }) => {
                    assert!(path.starts_with("$.x"), "{path}");
                }
                other => panic!("expected a number error, got {other:?}"),
            }
        }
        assert!(value_to_canonical_json(json!(9_007_199_254_740_991_i64)).is_ok());
        assert!(value_to_canonical_json(json!(-9_007_199_254_740_991_i64)).is_ok());
    }
}
