#![forbid(unsafe_code)]
//! Rail core: the only code that reads a hand-history file.
//!
//! Decoding, detection, the per-room parsers, positions, validation and the
//! standard-text serializer, ported from `frontend/src/lib/{phf,parsers}`
//! (docs/RAIL-PLAN.md R0.4–R0.10). The TypeScript implementation is the
//! reference: for every corpus file the Rust output must equal its golden
//! output (R0.3) before anything here replaces it.

/// The hand format every parser produces. Rail Hand Format is PHF; the
/// identifier stays `phf/1` because every stored `hands` row carries it
/// (docs/RAIL_GUIDELINE.md §2, amendment A1).
pub const PHF_SCHEMA: &str = "phf/1";

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
}
