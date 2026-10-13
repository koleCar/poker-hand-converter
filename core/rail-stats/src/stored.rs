//! Which rows of a hand a store keeps, and under which identity they are
//! summed (docs/RAIL-PLAN.md R2.3). The engine derives a row per dealt-in
//! seat ([`crate::rows_for`]); this is the writer's side of
//! `frontend/src/lib/db/statsRows.ts` (`handStatsRows`), for the desktop's
//! local store and anything that sums its rows (rollups, the HUD).
//!
//! - **Hero rows always.** Villain rows when the writer asks for them (the
//!   desktop always does; the web only behind a flag), **never** for a
//!   positionally anonymised room: an Ignition `UTG+1` is another human
//!   every hand, and a per-player row keyed on it would average strangers.
//! - **One row per seat.** Two players on one seat number make two
//!   identical rows (docs/STATS-SPEC.md §12, both the last player's); the
//!   web's `save_hand_stats` keeps the first (`on conflict do nothing` on
//!   `(hand, stats_version, seat)`), and so does this.
//! - **Identity for summing** ([`rollup_scope`]): a screen name (`none`) is
//!   one person across hands - scope `""`. An opaque token (`opaque-id`:
//!   GGPoker's hashes, ACR/WPN's mined numeric ids) is one person within
//!   one session only (docs/DATABASE.md "Why opaque-id rooms keep their
//!   names"): summing it across sessions would merge whoever wears the
//!   token later with whoever wore it before - a person nobody played. Such
//!   a villain's rows are summed per **session**, which a hand names by its
//!   table and its UTC day ([`session_scope`]). A session that runs past
//!   midnight UTC, or a tournament player moved to another table, splits in
//!   two: it under-merges, never over-merges. The hero is always one person
//!   (the parser marks the seat), scope `""`.

use rail_core::phf::PhfHand;

use crate::anonymization::{SiteAnonymization, detect_anonymization};
use crate::mapping::StatsRow;
use crate::rows_for;
use crate::segment::Segment;

/// The rows a store keeps for one hand, with what it needs to sum them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRows {
    /// How much the hand's names are worth ([`detect_anonymization`]).
    pub anonymization: SiteAnonymization,
    /// The hand's segment.
    pub segment: Segment,
    /// In the engine's order, one per seat.
    pub rows: Vec<StatsRow>,
}

/// `handStatsRows(hand, { includeVillains })`, one row per seat.
pub fn stored_rows(hand: &PhfHand, include_villains: bool) -> StoredRows {
    let anonymization = detect_anonymization(hand);
    let villains = include_villains && anonymization != SiteAnonymization::Positional;
    let mut rows: Vec<StatsRow> = Vec::new();
    for row in rows_for(hand) {
        if !(row.seat.is_hero || villains) {
            continue;
        }
        if rows.iter().any(|kept| kept.seat.seat == row.seat.seat) {
            continue;
        }
        rows.push(row);
    }
    StoredRows {
        anonymization,
        segment: Segment::of(hand),
        rows,
    }
}

/// The session an opaque token belongs to: the hand's table and its UTC
/// day (`<table>@<YYYY-MM-DD>`; either part empty when the hand lacks it).
pub fn session_scope(table_name: Option<&str>, played_at: Option<&str>) -> String {
    let day = played_at.and_then(|at| at.get(..10)).unwrap_or("");
    format!("{}@{day}", table_name.unwrap_or(""))
}

/// The scope a row is summed under with its player name: `""` (the name is
/// the person) or, for a villain of an `opaque-id` hand, its session.
pub fn rollup_scope(anonymization: SiteAnonymization, row: &StatsRow) -> String {
    if anonymization == SiteAnonymization::OpaqueId && !row.seat.is_hero {
        session_scope(
            row.hand.table_name.as_deref(),
            row.hand.played_at.as_deref(),
        )
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::session_scope;

    #[test]
    fn a_session_is_a_table_and_a_utc_day() {
        assert_eq!(
            session_scope(Some("Rush 12"), Some("2026-02-17T05:56:01.000Z")),
            "Rush 12@2026-02-17"
        );
        assert_eq!(
            session_scope(None, Some("2026-02-17T05:56:01.000Z")),
            "@2026-02-17"
        );
        assert_eq!(session_scope(Some("T"), None), "T@");
    }
}
