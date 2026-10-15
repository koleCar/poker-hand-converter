//! Embedded, versioned, forward-only migrations.
//!
//! The schema version is SQLite's `PRAGMA user_version` (0 in a new file).
//! [`MIGRATIONS`] is compiled into the binary; migration *n* (1-based) takes
//! the schema from version *n - 1* to *n*. Each one runs in its own
//! transaction together with the `user_version` bump, so a crash during a
//! migration leaves the previous version intact and the next start runs it
//! again. A database whose version is above [`LATEST`] was written by a newer
//! build and is refused untouched ([`Error::NewerSchema`]).
//!
//! Rules: a migration that has shipped is never edited; a change is a new
//! file appended here. Reserved for a later step (docs/RAIL-PLAN.md §3.4,
//! `SCHEMA.md`): the HUD editor's presets (R3.9), as the next free number
//! when it lands (`seat_stats` and the rollups: 6; the Hands screen's
//! tables: 7; the reports' list columns: 8; the Players screen's `players`:
//! 9; an unused index dropped for the import: 10; custom statistics: 11;
//! the targeted recompute's staging tables: 12; the HUD's seat positions
//! and preferred seat: 13; the observed part of the opponents' rollups, for
//! rooms that allow statistics from the user's own hands only: 14). A
//! migration may also fill in Rust what its SQL cannot ([`after_sql`]: 14
//! sums the seat rows' blobs), in the same transaction.

use rusqlite::Connection;

use crate::error::{Error, Result};

/// One migration: its file name (for logs) and its SQL.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration, in order. Index 0 is version 1.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        name: "0001_initial.sql",
        sql: include_str!("../migrations/0001_initial.sql"),
    },
    Migration {
        name: "0002_source_poll_only.sql",
        sql: include_str!("../migrations/0002_source_poll_only.sql"),
    },
    Migration {
        name: "0003_source_site.sql",
        sql: include_str!("../migrations/0003_source_site.sql"),
    },
    Migration {
        name: "0004_folder_rollups.sql",
        sql: include_str!("../migrations/0004_folder_rollups.sql"),
    },
    Migration {
        name: "0005_sync.sql",
        sql: include_str!("../migrations/0005_sync.sql"),
    },
    Migration {
        name: "0006_stats.sql",
        sql: include_str!("../migrations/0006_stats.sql"),
    },
    Migration {
        name: "0007_hands_screen.sql",
        sql: include_str!("../migrations/0007_hands_screen.sql"),
    },
    Migration {
        name: "0008_reports.sql",
        sql: include_str!("../migrations/0008_reports.sql"),
    },
    Migration {
        name: "0009_players.sql",
        sql: include_str!("../migrations/0009_players.sql"),
    },
    Migration {
        name: "0010_import_indexes.sql",
        sql: include_str!("../migrations/0010_import_indexes.sql"),
    },
    Migration {
        name: "0011_custom_stats.sql",
        sql: include_str!("../migrations/0011_custom_stats.sql"),
    },
    Migration {
        name: "0012_recompute.sql",
        sql: include_str!("../migrations/0012_recompute.sql"),
    },
    Migration {
        name: "0013_hud_layouts.sql",
        sql: include_str!("../migrations/0013_hud_layouts.sql"),
    },
    Migration {
        name: "0014_observed_rollups.sql",
        sql: include_str!("../migrations/0014_observed_rollups.sql"),
    },
];

/// What a migration fills in Rust after its SQL, in its transaction (SQL
/// cannot read the seat rows' counter blob).
fn after_sql(version: u32, conn: &Connection) -> Result<()> {
    match version {
        14 => crate::stats::fill_observed(conn),
        _ => Ok(()),
    }
}

/// The schema version this build writes.
pub const LATEST: u32 = {
    assert!(MIGRATIONS.len() < u32::MAX as usize);
    #[allow(clippy::cast_possible_truncation)]
    let latest = MIGRATIONS.len() as u32;
    latest
};

/// The database's schema version (`PRAGMA user_version`).
pub fn version(conn: &Connection) -> Result<u32> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    u32::try_from(version).map_err(|_| Error::OutOfRange("user_version"))
}

/// Bring the schema to [`LATEST`]. Returns the versions applied (empty when
/// it was current).
pub fn migrate(conn: &mut Connection) -> Result<Vec<u32>> {
    migrate_to(conn, LATEST)
}

/// Bring the schema to `target` (at most [`LATEST`]); the tests use it to
/// build every earlier version.
pub fn migrate_to(conn: &mut Connection, target: u32) -> Result<Vec<u32>> {
    let found = version(conn)?;
    if found > LATEST {
        return Err(Error::NewerSchema {
            found,
            known: LATEST,
        });
    }
    let target = target.min(LATEST);
    let mut applied = Vec::new();
    for next in found.saturating_add(1)..=target {
        let index = usize::try_from(next - 1).map_err(|_| Error::OutOfRange("migration"))?;
        let migration = MIGRATIONS[index];
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        after_sql(next, &tx)?;
        // `user_version` lives in the database header, which the
        // transaction covers: the bump commits with the migration or not
        // at all.
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
        applied.push(next);
    }
    Ok(applied)
}
