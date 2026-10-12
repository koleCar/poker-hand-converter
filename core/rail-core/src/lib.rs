#![forbid(unsafe_code)]
//! Rail core: the only code that reads a hand-history file.
//!
//! Decoding, detection, the per-room parsers, positions, validation and the
//! standard-text serializer, ported from `frontend/src/lib/{phf,parsers}`
//! (docs/RAIL-PLAN.md R0.4–R0.10). The TypeScript implementation is the
//! reference: for every corpus file the Rust output must equal its golden
//! output (R0.3) before anything here replaces it.
//!
//! - [`phf`]: the hand model (R0.4).
//! - [`canonical`]: the canonical JSON the goldens are written in, and that
//!   PHF hashes are taken over.

pub mod canonical;
pub mod phf;

pub use phf::PHF_SCHEMA;

#[cfg(test)]
mod tests {
    use super::PHF_SCHEMA;

    /// Must equal `PHF_SCHEMA` in `frontend/src/lib/phf/types.ts` and the
    /// `hands.schema_version` the database stores.
    #[test]
    fn schema_matches_typescript() {
        let types_ts = include_str!("../../../frontend/src/lib/phf/types.ts");
        assert!(
            types_ts.contains(&format!("\"{PHF_SCHEMA}\"")),
            "frontend/src/lib/phf/types.ts no longer declares {PHF_SCHEMA:?}"
        );
    }

    /// The constant and the serde tag of `PhfSchema::V1` are one value.
    #[test]
    fn schema_tag_matches_constant() {
        let tag = serde_json::to_value(crate::phf::PhfSchema::V1).ok();
        assert_eq!(tag, Some(serde_json::Value::from(PHF_SCHEMA)));
    }
}
