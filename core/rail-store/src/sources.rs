//! Watched folders (`sources`): the writes the watcher (R1.3) and Settings
//! → Folders (R1.5) make. Reads are [`crate::Reader::sources`].
//!
//! On [`WriterHandle`] so a thread that holds only a handle (the watcher's
//! coordinator) can make them; each is one transaction on the writer.

use rusqlite::params;

use crate::error::Result;
use crate::time;
use crate::writer::WriterHandle;

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
