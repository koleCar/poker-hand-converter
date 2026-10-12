//! The three shapes a PHF field can take on the wire, made exact.
//!
//! PHF distinguishes, and the golden hashes pin, three kinds of field
//! (`testdata/golden/README.md`, "Absent vs null"):
//!
//! | TypeScript      | JSON                          | Rust                                                        |
//! | --------------- | ----------------------------- | ----------------------------------------------------------- |
//! | `x: T \| null`  | always present, maybe `null`  | `Option<T>` + `deserialize_with = "nullable"`               |
//! | `x?: T`         | absent or a value, never null | `Option<T>` + `default`, `skip_serializing_if`, `deserialize_with = "present"` |
//! | `x?: T \| null` | absent, `null` or a value     | `Option<Option<T>>` + `default`, `skip_serializing_if`, `deserialize_with = "double_option"` |
//!
//! serde's defaults blur all three: a derived `Deserialize` quietly reads a
//! missing `Option` field as `None` (so a required `null` could be dropped
//! and come back as `null` without anyone noticing), reads `null` as `None`
//! for an optional field (which then disappears on the way out), and cannot
//! tell an absent `Option<Option<T>>` from a `null` one. The helpers here make
//! each case strict, so a document that does not have the shape `types.ts`
//! declares is refused on the way in instead of being normalised.

use serde::{Deserialize, Deserializer};

/// `x: T | null`: the key must be present; `null` is `None`.
///
/// Naming a `deserialize_with` function is what makes serde stop treating a
/// missing `Option` field as `None`, so a document without the key fails with
/// "missing field".
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// `x?: T`: absent is `None` (via `#[serde(default)]`); a present key must hold
/// a `T`, so an explicit `null` is an error rather than an absence.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// `x?: T | null`: absent is `None` (via `#[serde(default)]`), `null` is
/// `Some(None)`, a value is `Some(Some(value))`.
///
/// Serialization needs no helper: `skip_serializing_if = "Option::is_none"`
/// drops `None`, and serde writes `Some(None)` as `null`.
pub(crate) fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
