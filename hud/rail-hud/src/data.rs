//! The read path: the app's store, opened **read-only** from this process.
//! In WAL mode a reader never blocks the writer (the app's import) and the
//! writer never blocks a reader, so the HUD keeps drawing whatever the app
//! is doing. The connection is `SQLITE_OPEN_READ_ONLY` with `query_only`
//! (`rail_store::Reader`): the HUD cannot write, and never creates the
//! store - a missing one is looked for again every second.
//!
//! A table's numbers are `Reader::hud_totals` (R2.3: one key range of
//! `player_rollups` per player; sub-millisecond at 500k hands, R2.9's gate).
//! `PRAGMA data_version` tells the HUD when the app committed something it
//! has not re-read, so the overlays stay current even when no
//! `hand_imported` arrives (the app busy, a message dropped).

#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rail_store::{Reader, RoomSettings, SeatPosition, Totals};

/// The user's HUD layouts as the store has them (R3.6): the panels they
/// placed, their per-room preferred-seat answers.
pub type UserLayouts = (Vec<SeatPosition>, Vec<RoomSettings>);

/// How often a store that is missing or failed is tried again.
const RETRY: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub struct StoreView {
    path: Option<PathBuf>,
    reader: Option<Reader>,
    last_try: Option<Instant>,
    version: Option<i64>,
}

impl StoreView {
    /// `None`: no store (a test of the window side only).
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            reader: None,
            last_try: None,
            version: None,
        }
    }

    pub fn is_open(&self) -> bool {
        self.reader.is_some()
    }

    /// Open the store if it is not open (at most once a second). Returns
    /// whether it is open.
    pub fn ensure_open(&mut self) -> bool {
        if self.reader.is_some() {
            return true;
        }
        let Some(path) = &self.path else {
            return false;
        };
        if self.last_try.is_some_and(|at| at.elapsed() < RETRY) {
            return false;
        }
        self.last_try = Some(Instant::now());
        if !path.is_file() {
            return false;
        }
        match Reader::open(path, 1) {
            Ok(reader) => {
                eprintln!("rail-hud: store open (read-only): {}", path.display());
                self.reader = Some(reader);
                self.version = None;
                true
            }
            Err(error) => {
                eprintln!("rail-hud: the store did not open: {error}");
                false
            }
        }
    }

    /// The totals of `players` (name, scope) on `site`, all its segments.
    pub fn totals(&mut self, site: &str, players: &[(&str, &str)]) -> Result<Vec<Totals>, String> {
        if !self.ensure_open() {
            return Err("the store is not open".to_owned());
        }
        let reader = self.reader.as_ref().ok_or("the store is not open")?;
        reader.hud_totals(site, players, None).map_err(|error| {
            // Opened again on the next call: the file may have been
            // replaced (a restore) or the connection broken.
            self.reader = None;
            error.to_string()
        })
    }

    /// A stored hand's table size (`None`: no store, no such hand).
    pub fn hand_seats(&mut self, hand_key: &str) -> Option<u32> {
        if !self.ensure_open() {
            return None;
        }
        self.reader.as_ref()?.hand_seats(hand_key).ok().flatten()
    }

    /// The user's HUD layouts (R3.6): the panels they placed and their
    /// per-room preferred-seat answers, as the app wrote them. `None`: no
    /// store yet.
    pub fn user_layouts(&mut self) -> Option<Result<UserLayouts, String>> {
        if !self.ensure_open() {
            return None;
        }
        let reader = self.reader.as_ref()?;
        Some(
            reader
                .hud_seat_positions()
                .and_then(|positions| Ok((positions, reader.hud_room_settings()?)))
                .map_err(|error| error.to_string()),
        )
    }

    /// Whether the app has committed since the last call (the first call
    /// on an open store says yes).
    pub fn changed(&mut self) -> bool {
        let Some(reader) = &self.reader else {
            return false;
        };
        match reader.data_version() {
            Ok(version) => self.version.replace(version) != Some(version),
            Err(_) => {
                self.reader = None;
                false
            }
        }
    }

    /// The reader, for tests.
    pub fn reader(&self) -> Option<&Reader> {
        self.reader.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_and_never_created() {
        let dir = std::env::temp_dir().join(format!("rail-hud-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join(rail_store::FILE_NAME);

        let mut view = StoreView::new(Some(path.clone()));
        assert!(!view.ensure_open());
        assert!(!path.exists(), "the HUD never creates the store");
        assert!(view.totals("pokerstars", &[("a", "")]).is_err());

        let store = rail_store::Store::open(&path).expect("the app's store");
        let mut view = StoreView::new(Some(path.clone()));
        assert!(view.ensure_open());
        let totals = view
            .totals("pokerstars", &[("a", ""), ("b", "")])
            .expect("totals");
        assert_eq!(totals.len(), 2);
        assert!(totals.iter().all(|t| t.hands() == 0));
        assert_eq!(view.hand_seats("pokerstars:1"), None);
        assert_eq!(view.user_layouts(), Some(Ok((Vec::new(), Vec::new()))));
        assert!(view.changed(), "first look");
        assert!(!view.changed());

        // Writes are refused on the HUD's connection.
        let refused = view
            .reader()
            .expect("reader")
            .with(|conn| Ok(conn.execute("CREATE TABLE hud_was_here (x INTEGER)", [])?));
        assert!(refused.is_err());
        let refused = view
            .reader()
            .expect("reader")
            .with(|conn| Ok(conn.execute("DELETE FROM kv", [])?));
        assert!(refused.is_err());

        // The app's commit is seen.
        store.set_kv("test.hud", "1").expect("the app writes");
        assert!(view.changed());
        drop(view);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
