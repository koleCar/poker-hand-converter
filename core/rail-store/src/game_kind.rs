//! One kind of game at a time: cash, or every tournament format together
//! (the owner's rule, 2026-11-04 - cash and tournament hands are never
//! combined in a view; the web's `gameKind`, `20271104090000_game_kind_filter.sql`).
//!
//! A reader that takes a kind binds its formats as one JSON array (`None`:
//! every format), so a format and a kind are the same parameter: a query
//! tests `x IN (SELECT value FROM json_each(?N))`.

use crate::error::{Error, Result};
use crate::read::Reader;

/// The cash kind (`"cash"`).
pub const CASH: &str = "cash";
/// The tournament kind (`"tournament"`): tournaments, Sit & Go and Spins.
pub const TOURNAMENT: &str = "tournament";

/// A kind's formats; `None` for an unknown kind.
pub fn formats(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        CASH => Some(&["cash"]),
        TOURNAMENT => Some(&["tournament", "sng", "spin"]),
        _ => None,
    }
}

/// The formats a reader is asked for, as the JSON array its query binds:
/// `format` (one), else `kind`'s, else `None` (every format). A format
/// outside the kind named is none at all (`[]`), never the other kind's.
pub fn formats_json(format: Option<&str>, kind: Option<&str>) -> Result<Option<String>> {
    let kind = kind.map(str::trim).filter(|k| !k.is_empty());
    let format = format.map(str::trim).filter(|f| !f.is_empty());
    let of_kind = match kind {
        Some(kind) => Some(formats(kind).ok_or(Error::OutOfRange("game kind"))?),
        None => None,
    };
    let chosen: Option<Vec<&str>> = match (format, of_kind) {
        (Some(format), Some(of_kind)) if !of_kind.contains(&format) => Some(Vec::new()),
        (Some(format), _) => Some(vec![format]),
        (None, Some(of_kind)) => Some(of_kind.to_vec()),
        (None, None) => None,
    };
    chosen
        .map(|list| serde_json::to_string(&list).map_err(|error| Error::Corrupt(error.to_string())))
        .transpose()
}

/// The test that keeps a `hand_list` row (by its `segment_id` column, as
/// `column`) to the formats bound at `?{param}` (`None`: every row).
pub fn segment_test(column: &str, param: u8) -> String {
    format!(
        "(?{param} IS NULL OR {column} IN (SELECT s.id FROM segments s
           WHERE s.game_format IN (SELECT value FROM json_each(?{param}))))"
    )
}

impl Reader {
    /// The `segments.id`s of one kind's hands (for a [`crate::HeroFilter`]).
    pub fn kind_segments(&self, kind: &str) -> Result<Vec<i64>> {
        let formats = formats_json(None, Some(kind))?;
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT id FROM segments WHERE game_format IN (SELECT value FROM json_each(?1)) ORDER BY id",
            )?;
            let rows = stmt.query_map([formats], |row| row.get::<_, i64>(0))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_is_its_formats() {
        assert_eq!(formats(CASH), Some(&["cash"][..]));
        assert_eq!(
            formats(TOURNAMENT),
            Some(&["tournament", "sng", "spin"][..])
        );
        assert_eq!(formats("chips"), None);
    }

    #[test]
    fn a_filter_names_a_format_or_a_kind() {
        assert_eq!(formats_json(None, None).expect("formats"), None);
        assert_eq!(
            formats_json(Some("sng"), None).expect("formats").as_deref(),
            Some(r#"["sng"]"#)
        );
        assert_eq!(
            formats_json(None, Some("cash"))
                .expect("formats")
                .as_deref(),
            Some(r#"["cash"]"#)
        );
        assert_eq!(
            formats_json(None, Some("tournament"))
                .expect("formats")
                .as_deref(),
            Some(r#"["tournament","sng","spin"]"#)
        );
        assert_eq!(
            formats_json(Some("spin"), Some("tournament"))
                .expect("formats")
                .as_deref(),
            Some(r#"["spin"]"#)
        );
        assert_eq!(
            formats_json(Some("cash"), Some("tournament"))
                .expect("formats")
                .as_deref(),
            Some("[]")
        );
        assert_eq!(formats_json(Some(" "), Some("")).expect("formats"), None);
        assert!(formats_json(None, Some("both")).is_err());
    }
}
