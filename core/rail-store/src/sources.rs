//! Watched folders (`sources`): the writes the watcher (R1.3) and Settings
//! → Folders (R1.5) make. Reads are [`crate::Reader::sources`].
//!
//! On [`WriterHandle`] so a thread that holds only a handle (the watcher's
//! coordinator) can make them; each is one transaction on the writer.

use std::collections::HashSet;

use rusqlite::{OptionalExtension, Transaction, params};

use crate::error::{Error, Result};
use crate::time;
use crate::writer::WriterHandle;

/// One file of a folder whose path changes: where its row is, and where
/// the same file is in the new folder ([`WriterHandle::set_source_path`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMove {
    /// `files.path` now.
    pub from: String,
    /// The same file under the new folder.
    pub to: String,
}

/// What [`WriterHandle::set_source_path`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PathChange {
    /// The folder exists (nothing was done otherwise).
    pub found: bool,
    /// File rows given their new path, offsets kept.
    pub moved: u32,
    /// Files of the new folder that had a row of their own already (read
    /// before, from another folder or none): that row joins this folder
    /// with its own offset, and the old one is detached.
    pub adopted: u32,
    /// File rows of the folder not found in the new one: detached
    /// (`source_id` NULL) as a removed folder's are; their hands stay.
    pub detached: u32,
}

/// What [`WriterHandle::set_source_site_override`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OverrideChange {
    /// The folder exists (nothing was done otherwise).
    pub found: bool,
    /// Files set back to offset 0 (and their quarantine rows dropped), to
    /// be read again with the parser now in force.
    pub reset: u32,
}

impl WriterHandle {
    /// Add a watched folder, or return the id it already has (an existing
    /// row is left as it is).
    pub fn add_source(
        &self,
        path: &str,
        recursive: bool,
        site_override: Option<&str>,
        poll_only: bool,
    ) -> Result<i64> {
        let path = path.to_owned();
        let site_override = site_override.map(str::to_owned);
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO sources (path, site_override, recursive, poll_only, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (path) DO NOTHING",
                params![path, site_override, recursive, poll_only, time::now_ms()],
            )?;
            Ok(
                tx.query_row("SELECT id FROM sources WHERE path = ?1", [&path], |row| {
                    row.get(0)
                })?,
            )
        })
    }

    /// Remove a watched folder. Its files and hands stay (`files.source_id`
    /// becomes NULL). Returns whether it existed.
    pub fn remove_source(&self, id: i64) -> Result<bool> {
        self.write(move |tx| Ok(tx.execute("DELETE FROM sources WHERE id = ?1", [id])? == 1))
    }

    /// Enable or disable a folder; a disabled folder keeps its hands.
    /// Returns whether it exists.
    pub fn set_source_enabled(&self, id: i64, enabled: bool) -> Result<bool> {
        self.write(move |tx| {
            Ok(tx.execute(
                "UPDATE sources SET enabled = ?2 WHERE id = ?1",
                params![id, enabled],
            )? == 1)
        })
    }

    /// Read a folder by polling only (no change notifications), or not.
    pub fn set_source_poll_only(&self, id: i64, poll_only: bool) -> Result<bool> {
        self.write(move |tx| {
            Ok(tx.execute(
                "UPDATE sources SET poll_only = ?2 WHERE id = ?1",
                params![id, poll_only],
            )? == 1)
        })
    }

    /// The room whose default folder this is (a `config/sites.json` id, as
    /// discovery found it - R1.4), or `None`. Names the room and narrows the
    /// files read to its `files.glob`; not a parser override. Returns
    /// whether the folder exists.
    pub fn set_source_site(&self, id: i64, site: Option<&str>) -> Result<bool> {
        let site = site.map(str::to_owned);
        self.write(move |tx| {
            Ok(tx.execute(
                "UPDATE sources SET site = ?2 WHERE id = ?1",
                params![id, site],
            )? == 1)
        })
    }

    /// Watch the folder's subfolders too, or only its top level. Files
    /// already read from subfolders keep their rows and hands. Returns
    /// whether the folder exists.
    pub fn set_source_recursive(&self, id: i64, recursive: bool) -> Result<bool> {
        self.write(move |tx| {
            Ok(tx.execute(
                "UPDATE sources SET recursive = ?2 WHERE id = ?1",
                params![id, recursive],
            )? == 1)
        })
    }

    /// Force a parser for every file of the folder (`sources.site_override`,
    /// a `rail_core` parser id), or `None` for detection per file - the
    /// user's choice when detection fails (R1.5). The caller checks the id.
    ///
    /// When the choice changes, the folder's files that the parser now in
    /// force would read differently are set back to offset 0 in the same
    /// transaction, so the watcher reads them again: with an override,
    /// every file another parser (or none) read; without one, every file
    /// nothing claimed (`files.site` NULL) or the old override read. Their
    /// quarantine rows go too (the re-read records its own refusals); hands
    /// stay and dedupe.
    pub fn set_source_site_override(
        &self,
        id: i64,
        site_override: Option<&str>,
    ) -> Result<OverrideChange> {
        let site_override = site_override.map(str::to_owned);
        self.write(move |tx| {
            let current: Option<Option<String>> = tx
                .query_row(
                    "SELECT site_override FROM sources WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(current) = current else {
                return Ok(OverrideChange::default());
            };
            if current == site_override {
                return Ok(OverrideChange {
                    found: true,
                    reset: 0,
                });
            }
            tx.execute(
                "UPDATE sources SET site_override = ?2 WHERE id = ?1",
                params![id, site_override],
            )?;
            let stale = "SELECT id FROM files WHERE source_id = ?1
                          AND (CASE WHEN ?2 IS NULL THEN site IS NULL OR site IS ?3
                                    ELSE site IS NOT ?2 END)";
            tx.execute(
                &format!("DELETE FROM quarantine WHERE file_id IN ({stale})"),
                params![id, site_override, current],
            )?;
            let reset = tx.execute(
                &format!(
                    "UPDATE files SET read_offset = 0, size = 0, mtime = NULL, encoding = NULL,
                                      site = NULL, last_error = NULL
                     WHERE id IN ({stale})"
                ),
                params![id, site_override, current],
            )?;
            Ok(OverrideChange {
                found: true,
                reset: u32::try_from(reset).unwrap_or(u32::MAX),
            })
        })
    }

    /// Give a folder a new path (Settings → Folders, "Change folder"; R1.5),
    /// keeping its id and settings, in one transaction.
    ///
    /// `moves` are the folder's files that the caller found again under the
    /// new path (the watcher checks the disk: the same relative path, at
    /// least as long as what was read): their rows take the new path and
    /// **keep their offsets**, so a moved folder continues where it stopped
    /// instead of being read again. Every other file row of the folder is
    /// detached, as when a folder is removed (its hands stay). A new path
    /// with none of the old files therefore amounts to remove + add with the
    /// same settings, and one with all of them to a move.
    ///
    /// The folder's state goes back to `idle` until the watcher has looked.
    /// [`Error::PathTaken`] when another folder has `path` already.
    pub fn set_source_path(&self, id: i64, path: &str, moves: Vec<FileMove>) -> Result<PathChange> {
        let path = path.to_owned();
        self.write(move |tx| move_source(tx, id, &path, &moves))
    }

    /// The watcher's state of a folder (`watching`, `polling`,
    /// `unavailable`, `disabled`, ...) and why it cannot be watched, if it
    /// cannot. Unchanged values are not rewritten.
    pub fn set_source_status(&self, id: i64, status: &str, last_error: Option<&str>) -> Result<()> {
        let status = status.to_owned();
        let last_error = last_error.map(str::to_owned);
        self.write(move |tx| {
            tx.execute(
                "UPDATE sources SET status = ?2, last_error = ?3
                 WHERE id = ?1 AND (status IS NOT ?2 OR last_error IS NOT ?3)",
                params![id, status, last_error],
            )?;
            Ok(())
        })
    }
}

fn move_source(
    tx: &Transaction<'_>,
    id: i64,
    path: &str,
    moves: &[FileMove],
) -> Result<PathChange> {
    let exists = tx
        .query_row("SELECT 1 FROM sources WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some();
    if !exists {
        return Ok(PathChange::default());
    }
    let taken: Option<i64> = tx
        .query_row(
            "SELECT id FROM sources WHERE path = ?1 AND id <> ?2",
            params![path, id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(other) = taken {
        return Err(Error::PathTaken {
            path: path.to_owned(),
            id: other,
        });
    }
    tx.execute(
        "UPDATE sources SET path = ?2, status = 'idle', last_error = NULL WHERE id = ?1",
        params![id, path],
    )?;

    let mut change = PathChange {
        found: true,
        ..PathChange::default()
    };
    let mut kept: HashSet<i64> = HashSet::new();
    for file in moves {
        let row: Option<i64> = tx
            .query_row(
                "SELECT id FROM files WHERE path = ?1 AND source_id = ?2",
                params![file.from, id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(row) = row else {
            continue; // not this folder's file
        };
        if file.from == file.to {
            kept.insert(row);
            continue;
        }
        let there: Option<i64> = tx
            .query_row("SELECT id FROM files WHERE path = ?1", [&file.to], |row| {
                row.get(0)
            })
            .optional()?;
        match there {
            None => {
                tx.execute(
                    "UPDATE files SET path = ?2 WHERE id = ?1",
                    params![row, file.to],
                )?;
                kept.insert(row);
                change.moved += 1;
            }
            Some(other) => {
                tx.execute(
                    "UPDATE files SET source_id = ?2 WHERE id = ?1",
                    params![other, id],
                )?;
                kept.insert(other);
                change.adopted += 1;
            }
        }
    }
    let rows: Vec<i64> = tx
        .prepare("SELECT id FROM files WHERE source_id = ?1")?
        .query_map([id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for row in rows.into_iter().filter(|row| !kept.contains(row)) {
        tx.execute("UPDATE files SET source_id = NULL WHERE id = ?1", [row])?;
        change.detached += 1;
    }
    Ok(change)
}
