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
//! file appended here. Reserved for later phases (docs/RAIL-PLAN.md §3.4,
//! `SCHEMA.md`): `players` (Phase 2, R2.7c) and `hud_layouts` (Phase 3), each
//! as the next free number when it lands (`seat_stats` and the rollups: 6;
//! the Hands screen's tables: 7).

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
];

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
        // `user_version` lives in the database header, which the
        // transaction covers: the bump commits with the migration or not
        // at all.
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
        applied.push(next);
    }
    Ok(applied)
}
