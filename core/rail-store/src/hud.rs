//! The HUD's layouts (docs/RAIL-PLAN.md R3.6, migration 13): where the user
//! dragged a seat's panel, and whether their client rotates the table.
//!
//! - **Seat positions** (`hud_seat_positions`): one row per (room, table
//!   size, visual seat) - `slot` is the place on the screen (an index into
//!   the room's seat layout), not a hand history's seat number - with the
//!   panel's centre in thousandths of the table's client area. The HUD
//!   process cannot write (its connection is read-only, R3.2): it tells the
//!   app (`seat_position_changed`), and the app calls
//!   [`WriterHandle::set_hud_seat_position`]. The HUD reads them all with
//!   [`Reader::hud_seat_positions`] at start and on `layout_changed`.
//! - **Preferred seat** (`hud_room_settings`): the user's answer per room;
//!   [`Reader::hud_room_settings`]. `None` leaves it to `sites.json`.
//!
//! Synced later (R3.9 / R4.x): `updated_at` is there for last writer wins.

use rusqlite::params;

use crate::error::{Error, Result};
use crate::read::Reader;
use crate::writer::WriterHandle;

/// A panel the user put somewhere (R3.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatPosition {
    /// The `sites.json` room (`acr`, not the store's `acrwpn`).
    pub site: String,
    /// The table size, 2 - 10.
    pub size: u32,
    /// The visual seat: an index into the room's layout for the size.
    pub slot: u32,
    /// The panel's centre, thousandths of the client width and height.
    pub x: u32,
    pub y: u32,
    pub updated_at: i64,
}

/// The user's per-room HUD settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomSettings {
    pub site: String,
    /// Whether the client rotates the table (the user's word); `None`: the
    /// room's `sites.json` `tables.preferredSeat`.
    pub preferred_seat: Option<bool>,
}

fn check_position(size: u32, slot: u32, x: u32, y: u32) -> Result<()> {
    if !(2..=10).contains(&size) || slot >= size || x > 1000 || y > 1000 {
        return Err(Error::OutOfRange("a HUD seat position"));
    }
    Ok(())
}

impl WriterHandle {
    /// Remember where the user put a seat's panel (replacing what was
    /// there).
    pub fn set_hud_seat_position(
        &self,
        site: &str,
        size: u32,
        slot: u32,
        x: u32,
        y: u32,
    ) -> Result<()> {
        check_position(size, slot, x, y)?;
        let site = site.to_owned();
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO hud_seat_positions (site, size, slot, x, y, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (site, size, slot) DO UPDATE SET
                   x = excluded.x, y = excluded.y, updated_at = excluded.updated_at",
                params![site, size, slot, x, y, crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// Forget the user's positions of a room (one size, or every size):
    /// its panels go back to the layout's places. Returns how many went.
    pub fn clear_hud_seat_positions(&self, site: &str, size: Option<u32>) -> Result<u64> {
        let site = site.to_owned();
        self.write(move |tx| {
            let gone = tx.execute(
                "DELETE FROM hud_seat_positions WHERE site = ?1 AND (?2 IS NULL OR size = ?2)",
                params![site, size],
            )?;
            Ok(u64::try_from(gone).unwrap_or(0))
        })
    }

    /// Whether the user's client rotates the table on this room; `None`
    /// leaves it to `sites.json`.
    pub fn set_hud_preferred_seat(&self, site: &str, preferred: Option<bool>) -> Result<()> {
        let site = site.to_owned();
        self.write(move |tx| {
            match preferred {
                Some(on) => tx.execute(
                    "INSERT INTO hud_room_settings (site, preferred_seat, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT (site) DO UPDATE SET
                       preferred_seat = excluded.preferred_seat,
                       updated_at = excluded.updated_at",
                    params![site, i64::from(on), crate::time::now_ms()],
                )?,
                None => tx.execute("DELETE FROM hud_room_settings WHERE site = ?1", [site])?,
            };
            Ok(())
        })
    }
}

impl Reader {
    /// Every seat position the user set, by room, size and slot.
    pub fn hud_seat_positions(&self) -> Result<Vec<SeatPosition>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT site, size, slot, x, y, updated_at FROM hud_seat_positions
                 ORDER BY site, size, slot",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (site, size, slot, x, y, updated_at) = row?;
                let number = |v: i64| u32::try_from(v).map_err(|_| Error::OutOfRange("HUD seat"));
                out.push(SeatPosition {
                    site,
                    size: number(size)?,
                    slot: number(slot)?,
                    x: number(x)?,
                    y: number(y)?,
                    updated_at,
                });
            }
            Ok(out)
        })
    }

    /// The user's per-room HUD settings, by room.
    pub fn hud_room_settings(&self) -> Result<Vec<RoomSettings>> {
        self.with(|conn| {
            let mut stmt =
                conn.prepare("SELECT site, preferred_seat FROM hud_room_settings ORDER BY site")?;
            let rows = stmt.query_map([], |row| {
                Ok(RoomSettings {
                    site: row.get(0)?,
                    preferred_seat: row.get::<_, Option<i64>>(1)?.map(|v| v != 0),
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    fn store(name: &str) -> (Store, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("rail-store-hud-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        (store, dir)
    }

    /// Written by the app, read back (as the HUD's read-only connection
    /// would); a second drag of the same seat replaces the first; a reset
    /// forgets one size or all of a room.
    #[test]
    fn seat_positions_round_trip() {
        let (store, dir) = store("positions");
        let writer = store.writer().expect("writer");
        writer
            .set_hud_seat_position("acr", 6, 0, 500, 900)
            .expect("set");
        writer
            .set_hud_seat_position("acr", 6, 0, 480, 910)
            .expect("again");
        writer
            .set_hud_seat_position("acr", 9, 8, 0, 1000)
            .expect("set");
        writer
            .set_hud_seat_position("pokerstars", 2, 1, 1, 2)
            .expect("set");
        let read = Reader::open(store.path(), 1).expect("reader");
        let got: Vec<(String, u32, u32, u32, u32)> = read
            .hud_seat_positions()
            .expect("read")
            .into_iter()
            .map(|p| (p.site, p.size, p.slot, p.x, p.y))
            .collect();
        assert_eq!(
            got,
            [
                ("acr".to_owned(), 6, 0, 480, 910),
                ("acr".to_owned(), 9, 8, 0, 1000),
                ("pokerstars".to_owned(), 2, 1, 1, 2),
            ]
        );
        assert_eq!(
            writer
                .clear_hud_seat_positions("acr", Some(9))
                .expect("clear"),
            1
        );
        assert_eq!(
            writer.clear_hud_seat_positions("acr", None).expect("clear"),
            1
        );
        assert_eq!(read.hud_seat_positions().expect("read").len(), 1);
        drop((read, writer));
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Out of range is refused before the writer, and by the table's
    /// checks behind it.
    #[test]
    fn positions_stay_in_range() {
        let (store, dir) = store("range");
        let writer = store.writer().expect("writer");
        for (size, slot, x, y) in [(1, 0, 0, 0), (11, 0, 0, 0), (6, 6, 0, 0), (6, 0, 1001, 0)] {
            assert!(
                writer
                    .set_hud_seat_position("acr", size, slot, x, y)
                    .is_err(),
                "{size} {slot} {x} {y}"
            );
        }
        let refused = writer.write(|tx| {
            Ok(tx.execute(
                "INSERT INTO hud_seat_positions VALUES ('acr', 6, 7, 0, 0, 0)",
                [],
            )?)
        });
        assert!(refused.is_err(), "the slot check");
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preferred_seat_per_room() {
        let (store, dir) = store("preferred");
        let writer = store.writer().expect("writer");
        writer
            .set_hud_preferred_seat("pokerstars", Some(true))
            .expect("on");
        writer
            .set_hud_preferred_seat("acr", Some(false))
            .expect("off");
        writer
            .set_hud_preferred_seat("winamax", Some(true))
            .expect("on");
        writer
            .set_hud_preferred_seat("winamax", None)
            .expect("unset");
        let got = store.reader().hud_room_settings().expect("read");
        assert_eq!(
            got,
            [
                RoomSettings {
                    site: "acr".into(),
                    preferred_seat: Some(false)
                },
                RoomSettings {
                    site: "pokerstars".into(),
                    preferred_seat: Some(true)
                },
            ]
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
