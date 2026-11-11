//! The HUD's layouts: where the user dragged a seat's panel and whether
//! their client rotates the table (docs/RAIL-PLAN.md R3.6, migration 13),
//! the HUD editor's designs and where each is used (R3.9, migration 15),
//! and the sync marks of all four tables.
//!
//! - **Seat positions** (`hud_seat_positions`): one row per (room, table
//!   size, visual seat) - `slot` is the place on the screen (an index into
//!   the room's seat layout), not a hand history's seat number - with the
//!   panel's centre in thousandths of the table's client area. The HUD
//!   process cannot write (its connection is read-only, R3.2): it tells the
//!   app (`seat_position_changed`), and the app calls
//!   [`WriterHandle::set_hud_seat_position`]. The HUD reads them all with
//!   [`Reader::hud_seat_positions`] at start and on `layout_changed`. A
//!   reset keeps the row, `cleared` (R3.9: so the reset syncs too).
//! - **Preferred seat** (`hud_room_settings`): the user's answer per room;
//!   [`Reader::hud_room_settings`]. `None` leaves it to `sites.json` (kept
//!   as a row with `NULL`, for sync).
//! - **Designs** (`hud_layouts`, R3.9): a user's panel design as JSON, by
//!   id ([`WriterHandle::save_hud_layout`], [`Reader::hud_layouts`]); this
//!   crate does not read the JSON - `rail_hud::design` does. A delete keeps
//!   a tombstone and clears the design's assignments in the same
//!   transaction.
//! - **Assignments** (`hud_layout_assignments`, R3.9): which design a table
//!   gets per (room or `*`, table size or 0, format or `*`);
//!   [`Reader::hud_layout_assignments`].
//! - **Settings** (`hud_settings`, T3, migration 22): the user's table
//!   tiling and RNG settings, one JSON object per kind
//!   ([`HudSettingKind`]) and key ([`WriterHandle::save_hud_setting`],
//!   [`Reader::hud_setting`]); this crate does not read the JSON -
//!   `rail_hud_ipc::settings` does. The app sends them to the HUD over the
//!   IPC; the HUD's connection never reads them.
//! - **Sync** (R3.9): every write here marks its row `dirty`;
//!   [`Reader::hud_sync_dirty`] lists them as [`HudSyncRow`]s for the sync
//!   worker, [`WriterHandle::hud_sync_pushed`] clears the mark of rows
//!   that did not change since, and [`WriterHandle::hud_sync_apply`] takes
//!   the account's rows from the server - **last writer wins by
//!   `updated_at`**, a tie keeps the local row.

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

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

/// (R3.9) A user's design as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLayout {
    pub id: String,
    /// The design's JSON (`rail_hud::design::HudDesign`).
    pub design: String,
    pub updated_at: i64,
}

/// (R3.9) Which design a table gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutAssignment {
    /// A `sites.json` room, or [`ANY_SITE`].
    pub site: String,
    /// 2 - 10, or 0 for every size.
    pub size: u32,
    /// `cash`, `mtt`, `spin`, or [`ANY_FORMAT`].
    pub format: String,
    /// The design: a user's id, or a shipped preset's.
    pub layout_id: String,
    pub updated_at: i64,
}

/// An assignment for every room.
pub const ANY_SITE: &str = "*";
/// An assignment for every format.
pub const ANY_FORMAT: &str = "*";
/// The formats an assignment names.
pub const FORMATS: [&str; 4] = [ANY_FORMAT, "cash", "mtt", "spin"];
/// The longest id, room or design JSON a row takes.
pub const MAX_ID: usize = 64;
/// The largest design a row takes (bytes of JSON).
pub const MAX_DESIGN_BYTES: usize = 32 * 1024;

/// (T3) A settings object's kind in `hud_settings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HudSettingKind {
    /// The table tiling settings (`rail_hud_ipc::settings::TilingSettings`).
    Tiling,
    /// The RNG settings (`rail_hud_ipc::settings::RngSettings`).
    Rng,
}

impl HudSettingKind {
    pub const ALL: [Self; 2] = [Self::Tiling, Self::Rng];

    /// The name in the store and on the wire.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tiling => "tiling",
            Self::Rng => "rng",
        }
    }

    /// Its kind of synced row.
    pub const fn sync_kind(self) -> HudSyncKind {
        match self {
            Self::Tiling => HudSyncKind::Tiling,
            Self::Rng => HudSyncKind::Rng,
        }
    }
}

/// (R3.9) Which table a synced row is of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HudSyncKind {
    /// `hud_layouts`: key = the design's id.
    Layout,
    /// `hud_layout_assignments`: key = `site|size|format`.
    Assignment,
    /// `hud_seat_positions`: key = `site|size|slot`.
    SeatPosition,
    /// `hud_room_settings`: key = the site.
    RoomSetting,
    /// (T3) `hud_settings` kind `tiling`: key = the settings' key.
    Tiling,
    /// (T3) `hud_settings` kind `rng`: key = the settings' key.
    Rng,
}

impl HudSyncKind {
    pub const ALL: [Self; 6] = [
        Self::Layout,
        Self::Assignment,
        Self::SeatPosition,
        Self::RoomSetting,
        Self::Tiling,
        Self::Rng,
    ];

    /// The name on the wire (Supabase's `hud_layouts.kind`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Layout => "layout",
            Self::Assignment => "assignment",
            Self::SeatPosition => "seat_position",
            Self::RoomSetting => "room_setting",
            Self::Tiling => "tiling",
            Self::Rng => "rng",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// (T3) The settings kind it is, if it is one.
    pub const fn setting(self) -> Option<HudSettingKind> {
        match self {
            Self::Tiling => Some(HudSettingKind::Tiling),
            Self::Rng => Some(HudSettingKind::Rng),
            _ => None,
        }
    }
}

/// (R3.9) One row of a HUD table as the sync worker sends and receives it.
/// `body` `None` is a deleted or cleared row (a tombstone):
/// - a design: the design's JSON object;
/// - an assignment: `{"layout": "<id>"}`;
/// - a seat position: `{"x": 0-1000, "y": 0-1000}`;
/// - a room setting: `{"preferredSeat": true | false}`;
/// - (T3) tiling or RNG settings: the settings object.
#[derive(Debug, Clone, PartialEq)]
pub struct HudSyncRow {
    pub kind: HudSyncKind,
    pub key: String,
    pub body: Option<Value>,
    pub updated_at: i64,
}

/// What [`WriterHandle::hud_sync_apply`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HudSyncApplied {
    /// Rows written here (the server's was newer, or new).
    pub applied: u64,
    /// Rows kept (this computer's is as new or newer).
    pub kept: u64,
    /// Rows refused: a key or body this build cannot read.
    pub refused: u64,
}

fn check_position(size: u32, slot: u32, x: u32, y: u32) -> Result<()> {
    if !(2..=10).contains(&size) || slot >= size || x > 1000 || y > 1000 {
        return Err(Error::OutOfRange("a HUD seat position"));
    }
    Ok(())
}

fn check_id(id: &str, what: &'static str) -> Result<()> {
    if id.is_empty() || id.len() > MAX_ID {
        return Err(Error::OutOfRange(what));
    }
    Ok(())
}

fn check_assignment(site: &str, size: u32, format: &str) -> Result<()> {
    check_id(site, "a HUD assignment's room")?;
    if !(size == 0 || (2..=10).contains(&size)) || !FORMATS.contains(&format) {
        return Err(Error::OutOfRange("a HUD assignment"));
    }
    Ok(())
}

/// (T3) A settings body: a JSON object of at most [`MAX_DESIGN_BYTES`].
fn check_setting_body(body: &str) -> Result<()> {
    if body.len() > MAX_DESIGN_BYTES
        || !matches!(serde_json::from_str::<Value>(body), Ok(Value::Object(_)))
    {
        return Err(Error::OutOfRange("a HUD setting"));
    }
    Ok(())
}

fn number(value: i64, what: &'static str) -> Result<u32> {
    u32::try_from(value).map_err(|_| Error::OutOfRange(what))
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
                "INSERT INTO hud_seat_positions (site, size, slot, x, y, updated_at, cleared, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 1)
                 ON CONFLICT (site, size, slot) DO UPDATE SET
                   x = excluded.x, y = excluded.y, updated_at = excluded.updated_at,
                   cleared = 0, dirty = 1",
                params![site, size, slot, x, y, crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// Forget the user's positions of a room (one size, or every size):
    /// its panels go back to the layout's places. Returns how many went.
    /// The rows stay as cleared tombstones, so the reset syncs (R3.9).
    pub fn clear_hud_seat_positions(&self, site: &str, size: Option<u32>) -> Result<u64> {
        let site = site.to_owned();
        self.write(move |tx| {
            let gone = tx.execute(
                "UPDATE hud_seat_positions SET cleared = 1, dirty = 1, updated_at = ?3
                 WHERE site = ?1 AND (?2 IS NULL OR size = ?2) AND cleared = 0",
                params![site, size, crate::time::now_ms()],
            )?;
            Ok(u64::try_from(gone).unwrap_or(0))
        })
    }

    /// Whether the user's client rotates the table on this room; `None`
    /// leaves it to `sites.json`.
    pub fn set_hud_preferred_seat(&self, site: &str, preferred: Option<bool>) -> Result<()> {
        let site = site.to_owned();
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO hud_room_settings (site, preferred_seat, updated_at, dirty)
                 VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT (site) DO UPDATE SET
                   preferred_seat = excluded.preferred_seat,
                   updated_at = excluded.updated_at, dirty = 1",
                params![site, preferred.map(i64::from), crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// (R3.9) Save a user's design (new, or replacing the one of that id).
    /// `design` is its JSON; this crate does not interpret it.
    pub fn save_hud_layout(&self, id: &str, design: &str) -> Result<()> {
        check_id(id, "a HUD design's id")?;
        if design.len() > MAX_DESIGN_BYTES {
            return Err(Error::OutOfRange("a HUD design"));
        }
        let (id, design) = (id.to_owned(), design.to_owned());
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO hud_layouts (id, design, updated_at, dirty) VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT (id) DO UPDATE SET
                   design = excluded.design, updated_at = excluded.updated_at, dirty = 1",
                params![id, design, crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// (R3.9) Delete a user's design and clear every assignment of it, in
    /// one transaction. Returns whether it was there.
    pub fn delete_hud_layout(&self, id: &str) -> Result<bool> {
        let id = id.to_owned();
        self.write(move |tx| {
            let now = crate::time::now_ms();
            let gone = tx.execute(
                "UPDATE hud_layouts SET design = NULL, updated_at = ?2, dirty = 1
                 WHERE id = ?1 AND design IS NOT NULL",
                params![id, now],
            )?;
            tx.execute(
                "UPDATE hud_layout_assignments SET layout_id = NULL, updated_at = ?2, dirty = 1
                 WHERE layout_id = ?1",
                params![id, now],
            )?;
            Ok(gone > 0)
        })
    }

    /// (R3.9) Use the design `layout` for tables of `site` (or
    /// [`ANY_SITE`]), `size` (0: every size) and `format` (or
    /// [`ANY_FORMAT`]); `None` clears that assignment. Whether the design
    /// may be shown there is the caller's question (`rail_hud::design`).
    pub fn set_hud_layout_assignment(
        &self,
        site: &str,
        size: u32,
        format: &str,
        layout: Option<&str>,
    ) -> Result<()> {
        check_assignment(site, size, format)?;
        if let Some(layout) = layout {
            check_id(layout, "a HUD design's id")?;
        }
        let (site, format) = (site.to_owned(), format.to_owned());
        let layout = layout.map(str::to_owned);
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO hud_layout_assignments (site, size, format, layout_id, updated_at, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)
                 ON CONFLICT (site, size, format) DO UPDATE SET
                   layout_id = excluded.layout_id, updated_at = excluded.updated_at, dirty = 1",
                params![site, size, format, layout, crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// (T3) Save the user's settings of `kind` under `key` (replacing
    /// them). `body` is a JSON object of at most [`MAX_DESIGN_BYTES`]; this
    /// crate does not interpret it (the caller validates it,
    /// `rail_hud_ipc::settings`).
    pub fn save_hud_setting(&self, kind: HudSettingKind, key: &str, body: &str) -> Result<()> {
        check_id(key, "a HUD setting's key")?;
        check_setting_body(body)?;
        let (key, body) = (key.to_owned(), body.to_owned());
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO hud_settings (kind, key, body, updated_at, dirty)
                 VALUES (?1, ?2, ?3, ?4, 1)
                 ON CONFLICT (kind, key) DO UPDATE SET
                   body = excluded.body, updated_at = excluded.updated_at, dirty = 1",
                params![kind.as_str(), key, body, crate::time::now_ms()],
            )?;
            Ok(())
        })
    }

    /// (R3.9, sync) The rows sent: their dirty mark goes, unless the row
    /// changed since it was read (another `updated_at`).
    pub fn hud_sync_pushed(&self, rows: Vec<(HudSyncKind, String, i64)>) -> Result<()> {
        self.write(move |tx| {
            for (kind, key, updated_at) in rows {
                mark_clean(tx, kind, &key, updated_at)?;
            }
            Ok(())
        })
    }

    /// (R3.9, sync) The account's rows from the server: each replaces this
    /// computer's when it is newer (`updated_at`) or there is none - last
    /// writer wins; a tie keeps the local row. Applied rows are not dirty.
    /// A row this build cannot read (a key or body out of range) is
    /// refused and counted, never half applied.
    pub fn hud_sync_apply(&self, rows: Vec<HudSyncRow>) -> Result<HudSyncApplied> {
        self.write(move |tx| {
            let mut out = HudSyncApplied::default();
            for row in rows {
                let Some(local) = local_updated_at(tx, row.kind, &row.key)? else {
                    if apply(tx, &row)? {
                        out.applied += 1;
                    } else {
                        out.refused += 1;
                    }
                    continue;
                };
                if row.updated_at <= local {
                    out.kept += 1;
                } else if apply(tx, &row)? {
                    out.applied += 1;
                } else {
                    out.refused += 1;
                }
            }
            Ok(out)
        })
    }
}

/// `site|size|slot` or `site|size|format`.
fn split_key(key: &str) -> Option<(&str, u32, &str)> {
    let mut parts = key.splitn(3, '|');
    let site = parts.next()?;
    let size = parts.next()?.parse().ok()?;
    let last = parts.next()?;
    (!site.is_empty() && site.len() <= MAX_ID).then_some((site, size, last))
}

fn local_updated_at(tx: &Transaction<'_>, kind: HudSyncKind, key: &str) -> Result<Option<i64>> {
    let found = match kind {
        HudSyncKind::Layout => tx
            .query_row(
                "SELECT updated_at FROM hud_layouts WHERE id = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?,
        HudSyncKind::RoomSetting => tx
            .query_row(
                "SELECT updated_at FROM hud_room_settings WHERE site = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?,
        HudSyncKind::Assignment => match split_key(key) {
            Some((site, size, format)) => tx
                .query_row(
                    "SELECT updated_at FROM hud_layout_assignments
                     WHERE site = ?1 AND size = ?2 AND format = ?3",
                    params![site, size, format],
                    |row| row.get(0),
                )
                .optional()?,
            None => None,
        },
        HudSyncKind::SeatPosition => match split_key(key) {
            Some((site, size, slot)) => tx
                .query_row(
                    "SELECT updated_at FROM hud_seat_positions
                     WHERE site = ?1 AND size = ?2 AND slot = ?3",
                    params![site, size, slot],
                    |row| row.get(0),
                )
                .optional()?,
            None => None,
        },
        HudSyncKind::Tiling | HudSyncKind::Rng => tx
            .query_row(
                "SELECT updated_at FROM hud_settings WHERE kind = ?1 AND key = ?2",
                params![kind.as_str(), key],
                |row| row.get(0),
            )
            .optional()?,
    };
    Ok(found)
}

/// Write one server row here, not dirty; `false` when this build cannot
/// read it.
fn apply(tx: &Transaction<'_>, row: &HudSyncRow) -> Result<bool> {
    let at = row.updated_at;
    let body = row.body.as_ref();
    match row.kind {
        HudSyncKind::Layout => {
            if check_id(&row.key, "id").is_err() {
                return Ok(false);
            }
            let design = match body {
                Some(value @ Value::Object(_)) => {
                    let text = value.to_string();
                    if text.len() > MAX_DESIGN_BYTES {
                        return Ok(false);
                    }
                    Some(text)
                }
                Some(_) => return Ok(false),
                None => None,
            };
            tx.execute(
                "INSERT INTO hud_layouts (id, design, updated_at, dirty) VALUES (?1, ?2, ?3, 0)
                 ON CONFLICT (id) DO UPDATE SET
                   design = excluded.design, updated_at = excluded.updated_at, dirty = 0",
                params![row.key, design, at],
            )?;
        }
        HudSyncKind::Assignment => {
            let Some((site, size, format)) = split_key(&row.key) else {
                return Ok(false);
            };
            if check_assignment(site, size, format).is_err() {
                return Ok(false);
            }
            let layout = match body {
                None => None,
                Some(body) => match body.get("layout").and_then(Value::as_str) {
                    Some(id) if check_id(id, "id").is_ok() => Some(id.to_owned()),
                    _ => return Ok(false),
                },
            };
            tx.execute(
                "INSERT INTO hud_layout_assignments (site, size, format, layout_id, updated_at, dirty)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)
                 ON CONFLICT (site, size, format) DO UPDATE SET
                   layout_id = excluded.layout_id, updated_at = excluded.updated_at, dirty = 0",
                params![site, size, format, layout, at],
            )?;
        }
        HudSyncKind::SeatPosition => {
            let Some((site, size, slot)) = split_key(&row.key) else {
                return Ok(false);
            };
            let Ok(slot) = slot.parse::<u32>() else {
                return Ok(false);
            };
            let (x, y, cleared) = match body {
                None => (0, 0, true),
                Some(body) => {
                    let coordinate = |name: &str| {
                        body.get(name)
                            .and_then(Value::as_u64)
                            .and_then(|v| u32::try_from(v).ok())
                    };
                    match (coordinate("x"), coordinate("y")) {
                        (Some(x), Some(y)) => (x, y, false),
                        _ => return Ok(false),
                    }
                }
            };
            if check_position(size, slot, x, y).is_err() {
                return Ok(false);
            }
            if cleared {
                // A tombstone: keep the last place, marked cleared (or a
                // row at the corner when this computer never had one).
                tx.execute(
                    "INSERT INTO hud_seat_positions
                       (site, size, slot, x, y, updated_at, cleared, dirty)
                     VALUES (?1, ?2, ?3, 0, 0, ?4, 1, 0)
                     ON CONFLICT (site, size, slot) DO UPDATE SET
                       updated_at = excluded.updated_at, cleared = 1, dirty = 0",
                    params![site, size, slot, at],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO hud_seat_positions
                       (site, size, slot, x, y, updated_at, cleared, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)
                     ON CONFLICT (site, size, slot) DO UPDATE SET
                       x = excluded.x, y = excluded.y, updated_at = excluded.updated_at,
                       cleared = 0, dirty = 0",
                    params![site, size, slot, x, y, at],
                )?;
            }
        }
        HudSyncKind::RoomSetting => {
            if check_id(&row.key, "site").is_err() {
                return Ok(false);
            }
            let preferred = match body {
                None => None,
                Some(body) => match body.get("preferredSeat") {
                    Some(Value::Bool(on)) => Some(*on),
                    Some(Value::Null) | None => None,
                    Some(_) => return Ok(false),
                },
            };
            tx.execute(
                "INSERT INTO hud_room_settings (site, preferred_seat, updated_at, dirty)
                 VALUES (?1, ?2, ?3, 0)
                 ON CONFLICT (site) DO UPDATE SET
                   preferred_seat = excluded.preferred_seat,
                   updated_at = excluded.updated_at, dirty = 0",
                params![row.key, preferred.map(i64::from), at],
            )?;
        }
        HudSyncKind::Tiling | HudSyncKind::Rng => {
            if check_id(&row.key, "key").is_err() {
                return Ok(false);
            }
            let text = match body {
                Some(value @ Value::Object(_)) => {
                    let text = value.to_string();
                    if text.len() > MAX_DESIGN_BYTES {
                        return Ok(false);
                    }
                    Some(text)
                }
                Some(_) => return Ok(false),
                None => None,
            };
            tx.execute(
                "INSERT INTO hud_settings (kind, key, body, updated_at, dirty)
                 VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT (kind, key) DO UPDATE SET
                   body = excluded.body, updated_at = excluded.updated_at, dirty = 0",
                params![row.kind.as_str(), row.key, text, at],
            )?;
        }
    }
    Ok(true)
}

fn mark_clean(tx: &Transaction<'_>, kind: HudSyncKind, key: &str, at: i64) -> Result<()> {
    match kind {
        HudSyncKind::Layout => {
            tx.execute(
                "UPDATE hud_layouts SET dirty = 0 WHERE id = ?1 AND updated_at = ?2",
                params![key, at],
            )?;
        }
        HudSyncKind::RoomSetting => {
            tx.execute(
                "UPDATE hud_room_settings SET dirty = 0 WHERE site = ?1 AND updated_at = ?2",
                params![key, at],
            )?;
        }
        HudSyncKind::Assignment => {
            if let Some((site, size, format)) = split_key(key) {
                tx.execute(
                    "UPDATE hud_layout_assignments SET dirty = 0
                     WHERE site = ?1 AND size = ?2 AND format = ?3 AND updated_at = ?4",
                    params![site, size, format, at],
                )?;
            }
        }
        HudSyncKind::SeatPosition => {
            if let Some((site, size, slot)) = split_key(key) {
                tx.execute(
                    "UPDATE hud_seat_positions SET dirty = 0
                     WHERE site = ?1 AND size = ?2 AND slot = ?3 AND updated_at = ?4",
                    params![site, size, slot, at],
                )?;
            }
        }
        HudSyncKind::Tiling | HudSyncKind::Rng => {
            tx.execute(
                "UPDATE hud_settings SET dirty = 0
                 WHERE kind = ?1 AND key = ?2 AND updated_at = ?3",
                params![kind.as_str(), key, at],
            )?;
        }
    }
    Ok(())
}

impl Reader {
    /// Every seat position the user set (not reset), by room, size and
    /// slot.
    pub fn hud_seat_positions(&self) -> Result<Vec<SeatPosition>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT site, size, slot, x, y, updated_at FROM hud_seat_positions
                 WHERE cleared = 0 ORDER BY site, size, slot",
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
                out.push(SeatPosition {
                    site,
                    size: number(size, "HUD seat")?,
                    slot: number(slot, "HUD seat")?,
                    x: number(x, "HUD seat")?,
                    y: number(y, "HUD seat")?,
                    updated_at,
                });
            }
            Ok(out)
        })
    }

    /// The user's per-room HUD settings, by room (rooms left to
    /// `sites.json` are not listed).
    pub fn hud_room_settings(&self) -> Result<Vec<RoomSettings>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT site, preferred_seat FROM hud_room_settings
                 WHERE preferred_seat IS NOT NULL ORDER BY site",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(RoomSettings {
                    site: row.get(0)?,
                    preferred_seat: row.get::<_, Option<i64>>(1)?.map(|v| v != 0),
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// (R3.9) The user's designs (not deleted), by id.
    pub fn hud_layouts(&self) -> Result<Vec<StoredLayout>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, design, updated_at FROM hud_layouts
                 WHERE design IS NOT NULL ORDER BY id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(StoredLayout {
                    id: row.get(0)?,
                    design: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
    }

    /// (R3.9) Every assignment in force (not cleared), by room, size and
    /// format.
    pub fn hud_layout_assignments(&self) -> Result<Vec<LayoutAssignment>> {
        self.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT site, size, format, layout_id, updated_at FROM hud_layout_assignments
                 WHERE layout_id IS NOT NULL ORDER BY site, size, format",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (site, size, format, layout_id, updated_at) = row?;
                out.push(LayoutAssignment {
                    site,
                    size: number(size, "HUD assignment")?,
                    format,
                    layout_id,
                    updated_at,
                });
            }
            Ok(out)
        })
    }

    /// (T3) The user's settings of `kind` under `key` as stored (JSON),
    /// with when they were written; `None` when there are none (or they
    /// were cleared).
    pub fn hud_setting(&self, kind: HudSettingKind, key: &str) -> Result<Option<(String, i64)>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT body, updated_at FROM hud_settings
                     WHERE kind = ?1 AND key = ?2 AND body IS NOT NULL",
                    params![kind.as_str(), key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })
    }

    /// (R3.9, sync) Every row written here since the last sync, tombstones
    /// included, as the server takes them.
    pub fn hud_sync_dirty(&self) -> Result<Vec<HudSyncRow>> {
        self.with(|conn| {
            let mut out = Vec::new();
            let mut stmt =
                conn.prepare("SELECT id, design, updated_at FROM hud_layouts WHERE dirty = 1")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (id, design, updated_at) = row?;
                // A design this build cannot parse is still the user's: it
                // travels as a string the other side refuses rather than as
                // nothing (which would delete it there).
                let body =
                    design.map(|text| serde_json::from_str(&text).unwrap_or(Value::String(text)));
                out.push(HudSyncRow {
                    kind: HudSyncKind::Layout,
                    key: id,
                    body,
                    updated_at,
                });
            }
            let mut stmt = conn.prepare(
                "SELECT site, size, format, layout_id, updated_at
                 FROM hud_layout_assignments WHERE dirty = 1",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            for row in rows {
                let (site, size, format, layout, updated_at) = row?;
                out.push(HudSyncRow {
                    kind: HudSyncKind::Assignment,
                    key: format!("{site}|{size}|{format}"),
                    body: layout.map(|id| json!({ "layout": id })),
                    updated_at,
                });
            }
            let mut stmt = conn.prepare(
                "SELECT site, size, slot, x, y, cleared, updated_at
                 FROM hud_seat_positions WHERE dirty = 1",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;
            for row in rows {
                let (site, size, slot, x, y, cleared, updated_at) = row?;
                out.push(HudSyncRow {
                    kind: HudSyncKind::SeatPosition,
                    key: format!("{site}|{size}|{slot}"),
                    body: (cleared == 0).then(|| json!({ "x": x, "y": y })),
                    updated_at,
                });
            }
            let mut stmt = conn.prepare(
                "SELECT site, preferred_seat, updated_at FROM hud_room_settings WHERE dirty = 1",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (site, preferred, updated_at) = row?;
                out.push(HudSyncRow {
                    kind: HudSyncKind::RoomSetting,
                    key: site,
                    body: preferred.map(|on| json!({ "preferredSeat": on != 0 })),
                    updated_at,
                });
            }
            // (T3) The tiling and RNG settings.
            let mut stmt = conn
                .prepare("SELECT kind, key, body, updated_at FROM hud_settings WHERE dirty = 1")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (kind, key, body, updated_at) = row?;
                let Some(kind) = HudSyncKind::parse(&kind) else {
                    continue;
                };
                // As for a design: unreadable JSON travels as a string the
                // other side refuses, never as nothing (a delete there).
                let body =
                    body.map(|text| serde_json::from_str(&text).unwrap_or(Value::String(text)));
                out.push(HudSyncRow {
                    kind,
                    key,
                    body,
                    updated_at,
                });
            }
            Ok(out)
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
        // Dragged again after a reset: back in force.
        writer
            .set_hud_seat_position("acr", 6, 0, 10, 20)
            .expect("set");
        assert_eq!(read.hud_seat_positions().expect("read").len(), 2);
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
                "INSERT INTO hud_seat_positions (site, size, slot, x, y, updated_at)
                 VALUES ('acr', 6, 7, 0, 0, 0)",
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

    /// (R3.9) Designs and assignments: saved, replaced, listed; a delete
    /// clears the design's assignments in the same transaction; the
    /// table's checks refuse what the writer would.
    #[test]
    fn designs_and_assignments() {
        let (store, dir) = store("designs");
        let writer = store.writer().expect("writer");
        writer
            .save_hud_layout("d-1", r#"{"name":"Mine"}"#)
            .expect("save");
        writer
            .save_hud_layout("d-1", r#"{"name":"Mine, again"}"#)
            .expect("replace");
        writer
            .save_hud_layout("d-2", r#"{"name":"Other"}"#)
            .expect("save");
        writer
            .set_hud_layout_assignment("pokerstars", 0, "cash", Some("d-1"))
            .expect("assign");
        writer
            .set_hud_layout_assignment("*", 6, "*", Some("d-1"))
            .expect("assign");
        writer
            .set_hud_layout_assignment("acr", 9, "mtt", Some("mtt"))
            .expect("a preset");
        let reader = store.reader();
        let designs = reader.hud_layouts().expect("read");
        assert_eq!(
            designs
                .iter()
                .map(|d| (d.id.as_str(), d.design.as_str()))
                .collect::<Vec<_>>(),
            [
                ("d-1", r#"{"name":"Mine, again"}"#),
                ("d-2", r#"{"name":"Other"}"#)
            ]
        );
        assert_eq!(reader.hud_layout_assignments().expect("read").len(), 3);
        assert!(writer.delete_hud_layout("d-1").expect("delete"));
        assert!(!writer.delete_hud_layout("d-1").expect("again"));
        assert_eq!(reader.hud_layouts().expect("read").len(), 1);
        let left = reader.hud_layout_assignments().expect("read");
        assert_eq!(
            left.iter()
                .map(|a| (
                    a.site.as_str(),
                    a.size,
                    a.format.as_str(),
                    a.layout_id.as_str()
                ))
                .collect::<Vec<_>>(),
            [("acr", 9, "mtt", "mtt")]
        );
        writer
            .set_hud_layout_assignment("acr", 9, "mtt", None)
            .expect("clear");
        assert!(reader.hud_layout_assignments().expect("read").is_empty());
        for (site, size, format) in [("acr", 1, "cash"), ("acr", 11, "cash"), ("acr", 6, "sng")] {
            assert!(
                writer
                    .set_hud_layout_assignment(site, size, format, Some("cash"))
                    .is_err(),
                "{site} {size} {format}"
            );
        }
        let refused = writer.write(|tx| {
            Ok(tx.execute(
                "INSERT INTO hud_layout_assignments (site, size, format, layout_id, updated_at)
                 VALUES ('acr', 6, 'sng', 'cash', 0)",
                [],
            )?)
        });
        assert!(refused.is_err(), "the format check");
        assert!(writer.save_hud_layout("", "{}").is_err());
        assert!(
            writer
                .save_hud_layout("d-big", &"x".repeat(MAX_DESIGN_BYTES + 1))
                .is_err()
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn row(kind: HudSyncKind, key: &str, body: Option<Value>, updated_at: i64) -> HudSyncRow {
        HudSyncRow {
            kind,
            key: key.to_owned(),
            body,
            updated_at,
        }
    }

    /// (R3.9) Sync marks: every write is dirty, tombstones included; a
    /// push clears what did not change since; the server's rows apply by
    /// last writer wins (a tie keeps the local row) and are not dirty;
    /// rows this build cannot read are refused whole.
    #[test]
    fn sync_rows_last_writer_wins() {
        let (store, dir) = store("sync");
        let writer = store.writer().expect("writer");
        let reader = store.reader();
        writer
            .save_hud_layout("d-1", r#"{"name":"Mine"}"#)
            .expect("save");
        writer
            .set_hud_layout_assignment("pokerstars", 0, "cash", Some("d-1"))
            .expect("assign");
        writer
            .set_hud_seat_position("acr", 6, 2, 100, 200)
            .expect("drag");
        writer
            .set_hud_seat_position("acr", 6, 3, 100, 200)
            .expect("drag");
        writer.clear_hud_seat_positions("acr", Some(6)).ok();
        writer
            .set_hud_seat_position("acr", 6, 2, 300, 400)
            .expect("drag again");
        writer
            .set_hud_preferred_seat("winamax", None)
            .expect("unset");
        let mut dirty = reader.hud_sync_dirty().expect("dirty");
        dirty.sort_by(|a, b| (a.kind, &a.key).cmp(&(b.kind, &b.key)));
        let summary: Vec<(HudSyncKind, &str, Option<String>)> = dirty
            .iter()
            .map(|r| {
                (
                    r.kind,
                    r.key.as_str(),
                    r.body.as_ref().map(Value::to_string),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    HudSyncKind::Layout,
                    "d-1",
                    Some(r#"{"name":"Mine"}"#.to_owned())
                ),
                (
                    HudSyncKind::Assignment,
                    "pokerstars|0|cash",
                    Some(r#"{"layout":"d-1"}"#.to_owned())
                ),
                (
                    HudSyncKind::SeatPosition,
                    "acr|6|2",
                    Some(r#"{"x":300,"y":400}"#.to_owned())
                ),
                (HudSyncKind::SeatPosition, "acr|6|3", None),
                (HudSyncKind::RoomSetting, "winamax", None),
            ]
        );
        // Pushed; one of them changed in between and stays dirty.
        let pushed: Vec<_> = dirty
            .iter()
            .map(|r| (r.kind, r.key.clone(), r.updated_at))
            .collect();
        std::thread::sleep(std::time::Duration::from_millis(3));
        writer
            .save_hud_layout("d-1", r#"{"name":"Mine, edited"}"#)
            .expect("edit");
        writer.hud_sync_pushed(pushed).expect("pushed");
        let left = reader.hud_sync_dirty().expect("dirty");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].key, "d-1");
        let local = left[0].updated_at;

        let applied = writer
            .hud_sync_apply(vec![
                // Older than the edit here: kept.
                row(
                    HudSyncKind::Layout,
                    "d-1",
                    Some(json!({"name": "Theirs"})),
                    local - 1,
                ),
                // A tie: kept.
                row(HudSyncKind::Layout, "d-1", None, local),
                // Newer: the other computer's reset of slot 2.
                row(HudSyncKind::SeatPosition, "acr|6|2", None, local + 10),
                // New here.
                row(
                    HudSyncKind::SeatPosition,
                    "pokerstars|9|8",
                    Some(json!({"x": 1000, "y": 0})),
                    5,
                ),
                row(
                    HudSyncKind::Assignment,
                    "*|0|mtt",
                    Some(json!({"layout": "d-2"})),
                    5,
                ),
                row(HudSyncKind::Layout, "d-2", Some(json!({"name": "Two"})), 5),
                row(
                    HudSyncKind::RoomSetting,
                    "acr",
                    Some(json!({"preferredSeat": true})),
                    5,
                ),
                // Refused: out of range, bad keys, a body of the wrong shape.
                row(
                    HudSyncKind::SeatPosition,
                    "acr|6|6",
                    Some(json!({"x": 1, "y": 1})),
                    5,
                ),
                row(
                    HudSyncKind::SeatPosition,
                    "acr|6|1",
                    Some(json!({"x": 1001, "y": 1})),
                    5,
                ),
                row(
                    HudSyncKind::Assignment,
                    "acr|6|sng",
                    Some(json!({"layout": "x"})),
                    5,
                ),
                row(HudSyncKind::Assignment, "acr|six|cash", None, 5),
                row(HudSyncKind::Layout, "d-3", Some(json!("not a design")), 5),
                row(
                    HudSyncKind::RoomSetting,
                    "acr2",
                    Some(json!({"preferredSeat": 3})),
                    5,
                ),
            ])
            .expect("apply");
        assert_eq!(
            applied,
            HudSyncApplied {
                applied: 5,
                kept: 2,
                refused: 6
            }
        );
        let designs = reader.hud_layouts().expect("designs");
        assert_eq!(
            designs
                .iter()
                .map(|d| d.design.as_str())
                .collect::<Vec<_>>(),
            [r#"{"name":"Mine, edited"}"#, r#"{"name":"Two"}"#]
        );
        let positions: Vec<(String, u32, u32)> = reader
            .hud_seat_positions()
            .expect("positions")
            .into_iter()
            .map(|p| (p.site, p.size, p.slot))
            .collect();
        assert_eq!(positions, [("pokerstars".to_owned(), 9, 8)]);
        assert_eq!(
            reader.hud_room_settings().expect("settings"),
            [RoomSettings {
                site: "acr".into(),
                preferred_seat: Some(true)
            }]
        );
        assert_eq!(reader.hud_layout_assignments().expect("assigned").len(), 2);
        // Only the local edit is still to send.
        let left = reader.hud_sync_dirty().expect("dirty");
        assert_eq!(
            left.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            ["d-1"]
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (T3) The tiling and RNG settings: saved and read back by kind and
    /// key, replaced by a second save, refused when not a JSON object or
    /// too large; synced as kinds `tiling` and `rng` - dirty until pushed,
    /// the server's newer row applied (a tie or an older one kept), a
    /// tombstone clears them, a body of the wrong shape is refused.
    #[test]
    fn settings_round_trip_and_sync() {
        let (store, dir) = store("settings");
        let writer = store.writer().expect("writer");
        let reader = store.reader();
        assert_eq!(
            reader
                .hud_setting(HudSettingKind::Tiling, "default")
                .expect("read"),
            None
        );
        writer
            .save_hud_setting(HudSettingKind::Tiling, "default", r#"{"enabled":true}"#)
            .expect("save");
        writer
            .save_hud_setting(HudSettingKind::Rng, "default", r#"{"min":0,"max":99}"#)
            .expect("save");
        std::thread::sleep(std::time::Duration::from_millis(3));
        writer
            .save_hud_setting(HudSettingKind::Tiling, "default", r#"{"enabled":false}"#)
            .expect("replace");
        let (tiling, at) = reader
            .hud_setting(HudSettingKind::Tiling, "default")
            .expect("read")
            .expect("saved");
        assert_eq!(tiling, r#"{"enabled":false}"#);
        assert!(at > 0);
        assert_eq!(
            reader
                .hud_setting(HudSettingKind::Rng, "default")
                .expect("read")
                .map(|(body, _)| body),
            Some(r#"{"min":0,"max":99}"#.to_owned())
        );
        for bad in ["[1]", "1", "not json", ""] {
            assert!(
                writer
                    .save_hud_setting(HudSettingKind::Rng, "default", bad)
                    .is_err(),
                "{bad:?}"
            );
        }
        let large = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_DESIGN_BYTES));
        assert!(
            writer
                .save_hud_setting(HudSettingKind::Rng, "default", &large)
                .is_err()
        );
        assert!(
            writer
                .save_hud_setting(HudSettingKind::Rng, "", "{}")
                .is_err()
        );

        // Both are dirty, as their kinds, with their objects.
        let mut dirty = reader.hud_sync_dirty().expect("dirty");
        dirty.sort_by(|a, b| (a.kind, &a.key).cmp(&(b.kind, &b.key)));
        assert_eq!(
            dirty
                .iter()
                .map(|r| (r.kind.as_str(), r.key.as_str(), r.body.clone()))
                .collect::<Vec<_>>(),
            [
                ("tiling", "default", Some(json!({"enabled": false}))),
                ("rng", "default", Some(json!({"min": 0, "max": 99}))),
            ]
        );
        assert_eq!(HudSyncKind::parse("tiling"), Some(HudSyncKind::Tiling));
        assert_eq!(
            HudSyncKind::Rng.setting().map(HudSettingKind::sync_kind),
            Some(HudSyncKind::Rng)
        );
        writer
            .hud_sync_pushed(
                dirty
                    .iter()
                    .map(|r| (r.kind, r.key.clone(), r.updated_at))
                    .collect(),
            )
            .expect("pushed");
        assert!(reader.hud_sync_dirty().expect("dirty").is_empty());

        // The account's rows: tiling older (kept), RNG newer (applied), a
        // new key (applied); refused: not an object, a bad key.
        let applied = writer
            .hud_sync_apply(vec![
                row(
                    HudSyncKind::Tiling,
                    "default",
                    Some(json!({"enabled": true})),
                    at - 1,
                ),
                row(
                    HudSyncKind::Rng,
                    "default",
                    Some(json!({"enabled": true})),
                    at + 10,
                ),
                row(HudSyncKind::Tiling, "other", Some(json!({})), 5),
                row(HudSyncKind::Rng, "x", Some(json!([1, 2])), at + 10),
                row(HudSyncKind::Rng, "", Some(json!({})), at + 10),
            ])
            .expect("apply");
        assert_eq!(
            applied,
            HudSyncApplied {
                applied: 2,
                kept: 1,
                refused: 2
            }
        );
        assert_eq!(
            reader
                .hud_setting(HudSettingKind::Tiling, "default")
                .expect("read")
                .map(|(body, _)| body),
            Some(r#"{"enabled":false}"#.to_owned()),
            "the newer local row kept"
        );
        assert_eq!(
            reader
                .hud_setting(HudSettingKind::Rng, "default")
                .expect("read"),
            Some((r#"{"enabled":true}"#.to_owned(), at + 10)),
            "the newer server row applied"
        );
        assert!(
            reader.hud_sync_dirty().expect("dirty").is_empty(),
            "applied rows are clean"
        );
        // A newer tombstone clears them.
        writer
            .hud_sync_apply(vec![row(HudSyncKind::Rng, "default", None, at + 20)])
            .expect("apply");
        assert_eq!(
            reader
                .hud_setting(HudSettingKind::Rng, "default")
                .expect("read"),
            None
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
