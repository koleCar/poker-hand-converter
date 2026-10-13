//! The column lists against the TypeScript they port: a counter added to
//! `types.ts`, a column added to `mapping.ts` or a `STATS_VERSION` bump
//! fails here, by name, before the golden diff says it less clearly.

use rail_stats::{COUNTER_KEYS, DIMENSION_COLUMNS, MONEY_KEYS, STATS_VERSION};

const TYPES_TS: &str = include_str!("../../../frontend/src/lib/stats/types.ts");
const MAPPING_TS: &str = include_str!("../../../frontend/src/lib/stats/mapping.ts");

/// The keys of an object literal `export const <name>... = { key: 0, ... };`.
fn object_keys(source: &str, name: &str) -> Vec<String> {
    let start = source
        .find(&format!("export const {name}"))
        .unwrap_or_else(|| panic!("{name} not found"));
    let body = &source[start..];
    let open = body.find('{').expect("object start");
    let close = body.find("};").expect("object end");
    body[open + 1..close]
        .lines()
        .filter_map(|line| line.trim().strip_suffix(": 0,"))
        .map(str::to_owned)
        .collect()
}

/// The strings of an array literal `export const <name> = [ "a", ... ]`.
fn array_strings(source: &str, name: &str) -> Vec<String> {
    let start = source
        .find(&format!("export const {name}"))
        .unwrap_or_else(|| panic!("{name} not found"));
    let body = &source[start..];
    let open = body.find('[').expect("array start");
    let close = body.find(']').expect("array end");
    body[open + 1..close]
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix('"')
                .and_then(|rest| rest.strip_suffix("\","))
        })
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_counters_are_the_typescripts() {
    assert_eq!(
        object_keys(TYPES_TS, "ZERO_COUNTERS"),
        COUNTER_KEYS.to_vec()
    );
}

#[test]
fn the_money_columns_are_the_typescripts() {
    assert_eq!(object_keys(TYPES_TS, "ZERO_MONEY"), MONEY_KEYS.to_vec());
}

#[test]
fn the_dimension_columns_are_the_typescripts() {
    assert_eq!(
        array_strings(MAPPING_TS, "DIMENSION_COLUMNS"),
        DIMENSION_COLUMNS.to_vec()
    );
}

#[test]
fn the_version_is_the_typescripts() {
    assert!(
        TYPES_TS.contains(&format!("export const STATS_VERSION = \"{STATS_VERSION}\"")),
        "frontend/src/lib/stats/types.ts no longer declares {STATS_VERSION:?}"
    );
}
