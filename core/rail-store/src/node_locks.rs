//! The user's nodelocks (docs/NODELOCK.md §3, migration 24; the tree of
//! §7.5, migration 25): a lock on a Solver-library spot, solved on this
//! computer and **kept here only**.
//!
//! - **Rows** ([`NodeLockRow`]): the spot, the first locked node, the lock
//!   itself (`lock_json`, the web's `LockSet`; this crate checks only that
//!   it is a JSON object), where the solve stands ([`NodeLockStatus`]) and
//!   how it ran, the list's headline numbers (`summary_json`) and the
//!   locked solve's chunk (`result`).
//! - **Writing** ([`WriterHandle::save_node_lock`]): an upsert by id that
//!   replaces the whole row, `result` included (a save without one clears
//!   it), and keeps the first save's `created_at` and the row's place in
//!   the tree; [`WriterHandle::rename_node_lock`],
//!   [`WriterHandle::delete_node_locks`] (with every lock built on them).
//! - **The tree** (§7.5): folders ([`NodeLockFolder`], nested), a lock's
//!   `parent_id` (the lock it is built on; its children sit under it) and
//!   `folder_id` (a root lock's folder), and `sort`, a fractional index
//!   within one list: a folder's subfolders and root locks together
//!   ([`NodeLockParent::Folder`]), or one lock's children
//!   ([`NodeLockParent::Lock`]). [`WriterHandle::save_node_lock_folder`],
//!   [`WriterHandle::move_node_locks`],
//!   [`WriterHandle::delete_node_lock_folders`],
//!   [`Reader::node_lock_folders`], [`Reader::node_lock_delete_preview`].
//! - **Reading**: [`Reader::node_locks`] (the history, newest change first,
//!   optionally one spot's, without the chunk) and [`Reader::node_lock`]
//!   (one row with its chunk).
//! - **At open** ([`cancel_solving`], called by [`crate::Store::open`]): a
//!   solve does not outlive the app, so a row still `solving` becomes
//!   `cancelled`.
//! - **Never synced**: nothing here marks a row dirty, and `rail-sync`
//!   reads none of it (its tests say so).

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::read::Reader;
use crate::writer::WriterHandle;

/// The street of the locked spot (`node_locks.street`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeLockStreet {
    Flop,
    Turn,
    River,
}

impl NodeLockStreet {
    /// The column's value.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Flop => "flop",
            Self::Turn => "turn",
            Self::River => "river",
        }
    }

    /// The column's value back; `None` for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "flop" => Some(Self::Flop),
            "turn" => Some(Self::Turn),
            "river" => Some(Self::River),
            _ => None,
        }
    }
}

/// Where a nodelock's solve stands (`node_locks.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeLockStatus {
    /// Edited, not solved.
    Draft,
    /// Solving now (only while the app runs: see [`cancel_solving`]).
    Solving,
    /// Solved; `result` holds the chunk.
    Solved,
    Failed,
    Cancelled,
}

impl NodeLockStatus {
    /// The column's value.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Solving => "solving",
            Self::Solved => "solved",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// The column's value back; `None` for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "draft" => Some(Self::Draft),
            "solving" => Some(Self::Solving),
            "solved" => Some(Self::Solved),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// A spot of the Solver library, as the history filters by it (the
/// `node_locks_spot` index).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeLockSpot {
    pub set_id: String,
    pub line: String,
    pub flop: String,
}

/// One nodelock, column for column.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeLockRow {
    /// A uuid v4 (the caller's; the store checks only its length).
    pub id: String,
    /// "Tight BTN · A♣T♣6♦ · BTN vs BB"; the user can rename it.
    pub name: String,
    /// ms; the first save's (a save's own value is ignored).
    pub created_at: i64,
    /// ms; the last save or rename.
    pub updated_at: i64,
    pub set_id: String,
    pub line: String,
    pub flop: String,
    pub turn: Option<String>,
    pub river: Option<String>,
    pub street: NodeLockStreet,
    /// The first locked node, for the list.
    pub node_path: String,
    /// The `LockSet` as JSON (an object; not read here).
    pub lock_json: String,
    pub lock_hash: String,
    /// The suggestion it started from, if any.
    pub preset: Option<String>,
    pub status: NodeLockStatus,
    pub engine: Option<String>,
    pub threads: Option<i64>,
    pub iterations: Option<i64>,
    pub exploitability_pct: Option<f64>,
    pub seconds: Option<f64>,
    pub peak_mb: Option<f64>,
    /// The list's headline numbers as JSON (not read here).
    pub summary_json: Option<String>,
    /// The locked solve's chunk; `None` in a listing (see `result_size`).
    pub result: Option<Vec<u8>>,
    /// The chunk's size in bytes, in a listing too; `None` without one.
    /// Read only: a save ignores it.
    pub result_size: Option<i64>,
    /// A root lock's folder; `None`: the top level (and always for a
    /// child). Set by the first save (an unknown folder: the top level),
    /// then only by [`WriterHandle::move_node_locks`].
    pub folder_id: Option<String>,
    /// The lock this one is built on (§7.4); `None`: on the library. Set by
    /// the first save (it must exist) and never changed.
    pub parent_id: Option<String>,
    /// Its place in its list (ascending). Read only: the first save puts
    /// the row at the top of its list, a move places it.
    pub sort: f64,
}

/// The longest id.
pub const MAX_ID: usize = 64;
/// The longest name, in characters.
pub const MAX_NAME_CHARS: usize = 200;
/// The longest spot field, node path, hash, preset or engine (bytes).
pub const MAX_FIELD: usize = 512;
/// The largest `lock_json` (bytes): a few nodes of [action][1 326] numbers.
pub const MAX_LOCK_BYTES: usize = 8 * 1024 * 1024;
/// The largest `summary_json` (bytes).
pub const MAX_SUMMARY_BYTES: usize = 256 * 1024;
/// The largest chunk (bytes; a locked solve's is ~100 KB).
pub const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;

fn check(ok: bool, what: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::OutOfRange(what))
    }
}

fn check_id(id: &str) -> Result<()> {
    check(!id.is_empty() && id.len() <= MAX_ID, "a nodelock's id")
}

fn check_name(name: &str) -> Result<()> {
    check(
        !name.trim().is_empty() && name.chars().count() <= MAX_NAME_CHARS,
        "a nodelock's name",
    )
}

fn check_field(value: &str, what: &'static str) -> Result<()> {
    check(value.len() <= MAX_FIELD, what)
}

fn check_row(row: &NodeLockRow) -> Result<()> {
    check_id(&row.id)?;
    check_name(&row.name)?;
    for (value, what) in [
        (row.folder_id.as_deref(), "a nodelock's folder"),
        (row.parent_id.as_deref(), "a nodelock's parent"),
    ] {
        if let Some(value) = value {
            check(!value.is_empty() && value.len() <= MAX_ID, what)?;
        }
    }
    for (value, what) in [
        (row.set_id.as_str(), "a nodelock's set"),
        (row.line.as_str(), "a nodelock's line"),
        (row.flop.as_str(), "a nodelock's flop"),
    ] {
        check(!value.is_empty(), what)?;
        check_field(value, what)?;
    }
    for (value, what) in [
        (row.turn.as_deref(), "a nodelock's turn"),
        (row.river.as_deref(), "a nodelock's river"),
        (row.preset.as_deref(), "a nodelock's preset"),
        (row.engine.as_deref(), "a nodelock's engine"),
        (Some(row.node_path.as_str()), "a nodelock's node"),
        (Some(row.lock_hash.as_str()), "a nodelock's hash"),
    ] {
        check_field(value.unwrap_or(""), what)?;
    }
    check(
        row.lock_json.len() <= MAX_LOCK_BYTES
            && matches!(
                serde_json::from_str::<Value>(&row.lock_json),
                Ok(Value::Object(_))
            ),
        "a nodelock's lock",
    )?;
    if let Some(summary) = &row.summary_json {
        check(
            summary.len() <= MAX_SUMMARY_BYTES && serde_json::from_str::<Value>(summary).is_ok(),
            "a nodelock's summary",
        )?;
    }
    check(
        row.result
            .as_ref()
            .is_none_or(|bytes| bytes.len() <= MAX_RESULT_BYTES),
        "a nodelock's result",
    )
}

/// Every `solving` row becomes `cancelled` (its `updated_at` kept): the
/// solve was cut off when the app last exited. Returns how many. Run by
/// [`crate::Store::open`] on the write connection, before the writer
/// starts.
///
/// It writes only when a row is `solving`. Almost every open finds none, and
/// an open that changes nothing must not take the write lock: two stores
/// opened on one file at once (the report tests) were refused on Windows
/// with "attempt to write a readonly database".
pub fn cancel_solving(conn: &Connection) -> Result<u64> {
    let solving: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM node_locks WHERE status = 'solving')",
        [],
        |row| row.get(0),
    )?;
    if !solving {
        return Ok(0);
    }
    let changed = conn.execute(
        "UPDATE node_locks SET status = 'cancelled' WHERE status = 'solving'",
        [],
    )?;
    Ok(u64::try_from(changed).unwrap_or(u64::MAX))
}

impl WriterHandle {
    /// Insert or replace the nodelock `row.id`. The whole row is replaced,
    /// `result` included; `created_at` is `now_ms` for a new row and the
    /// first save's otherwise, `updated_at` is `now_ms`. Returns
    /// (`created_at`, `updated_at`).
    ///
    /// Its place in the tree is the first save's: a new row goes to the
    /// top of its list, under `parent_id` (which must exist: a branch
    /// deleted while its solve ran is not brought back) or, for a root, in
    /// `folder_id` (an unknown folder: the top level; a child has none). A
    /// later save keeps `folder_id`, `parent_id` and `sort` as stored.
    pub fn save_node_lock(&self, row: NodeLockRow, now_ms: i64) -> Result<(i64, i64)> {
        check_row(&row)?;
        self.write(move |tx| {
            let known = lock_place(tx, &row.id)?.is_some();
            let (folder_id, sort) = if known {
                // Kept as stored (the upsert does not touch them).
                (None, 0.0)
            } else if let Some(parent) = &row.parent_id {
                check(lock_place(tx, parent)?.is_some(), "a nodelock's parent")?;
                (None, top_of(tx, &NodeLockParent::Lock(parent.clone()))?)
            } else {
                let folder = match &row.folder_id {
                    Some(folder) if folder_exists(tx, folder)? => Some(folder.clone()),
                    _ => None,
                };
                let sort = top_of(tx, &NodeLockParent::Folder(folder.clone()))?;
                (folder, sort)
            };
            tx.execute(
                "INSERT INTO node_locks (
                   id, name, created_at, updated_at, set_id, line, flop, turn, river, street,
                   node_path, lock_json, lock_hash, preset, status, engine, threads, iterations,
                   exploitability_pct, seconds, peak_mb, summary_json, result,
                   folder_id, parent_id, sort)
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                         ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
                 ON CONFLICT (id) DO UPDATE SET
                   name = excluded.name, updated_at = excluded.updated_at,
                   set_id = excluded.set_id, line = excluded.line, flop = excluded.flop,
                   turn = excluded.turn, river = excluded.river, street = excluded.street,
                   node_path = excluded.node_path, lock_json = excluded.lock_json,
                   lock_hash = excluded.lock_hash, preset = excluded.preset,
                   status = excluded.status, engine = excluded.engine,
                   threads = excluded.threads, iterations = excluded.iterations,
                   exploitability_pct = excluded.exploitability_pct,
                   seconds = excluded.seconds, peak_mb = excluded.peak_mb,
                   summary_json = excluded.summary_json, result = excluded.result",
                params![
                    row.id,
                    row.name.trim(),
                    now_ms,
                    row.set_id,
                    row.line,
                    row.flop,
                    row.turn,
                    row.river,
                    row.street.as_str(),
                    row.node_path,
                    row.lock_json,
                    row.lock_hash,
                    row.preset,
                    row.status.as_str(),
                    row.engine,
                    row.threads,
                    row.iterations,
                    row.exploitability_pct,
                    row.seconds,
                    row.peak_mb,
                    row.summary_json,
                    row.result,
                    folder_id,
                    row.parent_id,
                    sort,
                ],
            )?;
            Ok(tx.query_row(
                "SELECT created_at, updated_at FROM node_locks WHERE id = ?1",
                [&row.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
    }

    /// Rename a nodelock (its `updated_at` becomes `now_ms`). Returns
    /// whether it was there.
    pub fn rename_node_lock(&self, id: &str, name: &str, now_ms: i64) -> Result<bool> {
        check_id(id)?;
        check_name(name)?;
        let (id, name) = (id.to_owned(), name.trim().to_owned());
        self.write(move |tx| {
            Ok(tx.execute(
                "UPDATE node_locks SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, name, now_ms],
            )? == 1)
        })
    }

    /// Delete the nodelocks `ids` and every lock built on them (their
    /// branches, down `parent_id`; unknown ids are skipped), in one
    /// transaction. A lock still `solving` just goes (the window cancels
    /// its solve first). Returns how many rows went.
    pub fn delete_node_locks(&self, ids: Vec<String>) -> Result<u64> {
        self.write(move |tx| {
            let doomed = lock_branches(tx, ids)?;
            delete_locks(tx, &doomed)
        })
    }
}

/// The columns every read selects (indexes 0 - 24); a read adds
/// `length(result)` (25) and, for one row, `result` (26).
const COLUMNS: &str = "id, name, created_at, updated_at, set_id, line, flop, turn, river, street,
    node_path, lock_json, lock_hash, preset, status, engine, threads, iterations,
    exploitability_pct, seconds, peak_mb, summary_json, folder_id, parent_id, sort";

fn node_lock_row(row: &Row<'_>, with_result: bool) -> Result<NodeLockRow> {
    let street: String = row.get(9)?;
    let status: String = row.get(14)?;
    Ok(NodeLockRow {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        set_id: row.get(4)?,
        line: row.get(5)?,
        flop: row.get(6)?,
        turn: row.get(7)?,
        river: row.get(8)?,
        street: NodeLockStreet::parse(&street).ok_or(Error::OutOfRange("a nodelock's street"))?,
        node_path: row.get(10)?,
        lock_json: row.get(11)?,
        lock_hash: row.get(12)?,
        preset: row.get(13)?,
        status: NodeLockStatus::parse(&status).ok_or(Error::OutOfRange("a nodelock's status"))?,
        engine: row.get(15)?,
        threads: row.get(16)?,
        iterations: row.get(17)?,
        exploitability_pct: row.get(18)?,
        seconds: row.get(19)?,
        peak_mb: row.get(20)?,
        summary_json: row.get(21)?,
        result: if with_result { row.get(26)? } else { None },
        result_size: row.get(25)?,
        folder_id: row.get(22)?,
        parent_id: row.get(23)?,
        sort: row.get(24)?,
    })
}

impl Reader {
    /// The nodelock history, newest change first (then newest created),
    /// without the chunks; `spot` keeps one spot's.
    pub fn node_locks(&self, spot: Option<&NodeLockSpot>) -> Result<Vec<NodeLockRow>> {
        self.with(|conn| {
            let order = "ORDER BY updated_at DESC, created_at DESC, id";
            let mut out = Vec::new();
            match spot {
                Some(spot) => {
                    let mut stmt = conn.prepare_cached(&format!(
                        "SELECT {COLUMNS}, length(result) FROM node_locks
                         WHERE set_id = ?1 AND line = ?2 AND flop = ?3 {order}"
                    ))?;
                    let mut rows = stmt.query(params![spot.set_id, spot.line, spot.flop])?;
                    while let Some(row) = rows.next()? {
                        out.push(node_lock_row(row, false)?);
                    }
                }
                None => {
                    let mut stmt = conn.prepare_cached(&format!(
                        "SELECT {COLUMNS}, length(result) FROM node_locks {order}"
                    ))?;
                    let mut rows = stmt.query([])?;
                    while let Some(row) = rows.next()? {
                        out.push(node_lock_row(row, false)?);
                    }
                }
            }
            Ok(out)
        })
    }

    /// One nodelock with its chunk; `None` when there is none of that id.
    pub fn node_lock(&self, id: &str) -> Result<Option<NodeLockRow>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {COLUMNS}, length(result), result FROM node_locks WHERE id = ?1"
            ))?;
            let mut rows = stmt.query([id])?;
            match rows.next()? {
                Some(row) => Ok(Some(node_lock_row(row, true)?)),
                None => Ok(None),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// The tree (docs/NODELOCK.md §7.5, migration 25)
// ---------------------------------------------------------------------------

/// One folder of My nodelocks (`node_lock_folders`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeLockFolder {
    /// A uuid v4 (the caller's; the store checks only its length).
    pub id: String,
    /// 1 - 200 characters, trimmed.
    pub name: String,
    /// The folder it sits in; `None`: the top level.
    pub parent_id: Option<String>,
    /// Its place among its folder's subfolders and root locks (ascending).
    pub sort: f64,
    /// ms.
    pub created_at: i64,
    /// ms; the last save or move.
    pub updated_at: i64,
}

/// What [`WriterHandle::save_node_lock_folder`] takes.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeLockFolderInput {
    /// New or existing (an upsert by id).
    pub id: String,
    pub name: String,
    /// The folder it goes in; `None`: the top level. It must exist, and
    /// must not be the folder itself or one inside it.
    pub parent_id: Option<String>,
    /// Its place; `None`: the top of its list for a new folder or one that
    /// changes folder, else where it was.
    pub sort: Option<f64>,
}

/// A tree item's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeLockItemKind {
    Lock,
    Folder,
}

/// A tree item: a lock or a folder.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeLockItem {
    pub kind: NodeLockItemKind,
    pub id: String,
}

/// Where [`WriterHandle::move_node_locks`] puts its items: into
/// `folder_id` (`None`: the top level), just before `before`, else just
/// after `after`, else at the top. The anchor must be in that folder.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeLockPlace {
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub before: Option<NodeLockItem>,
    #[serde(default)]
    pub after: Option<NodeLockItem>,
}

/// What a folder delete took (`locks`: every lock row, branches included).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeLockDeleted {
    pub folders: u64,
    pub locks: u64,
}

/// What a delete would take: `folders` (subfolders included), `locks`
/// (each deleted lock whose parent stays, or is on the library) and
/// `descendants` (the deleted locks built on another deleted lock).
/// `locks + descendants` is every lock row that would go.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeLockDeletePreview {
    pub folders: u64,
    pub locks: u64,
    pub descendants: u64,
}

/// One sibling list: a folder's subfolders and root locks together
/// (`Folder(None)`: the top level), or one lock's children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeLockParent {
    Folder(Option<String>),
    Lock(String),
}

/// When two neighbours' `sort` get closer than this, their list is
/// renumbered.
pub const MIN_SORT_GAP: f64 = 1e-6;

/// A lock's (`folder_id`, `parent_id`); `None`: no such lock.
fn lock_place(conn: &Connection, id: &str) -> Result<Option<(Option<String>, Option<String>)>> {
    Ok(conn
        .prepare_cached("SELECT folder_id, parent_id FROM node_locks WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?)
}

/// A folder's `parent_id`; `None`: no such folder.
fn folder_parent(conn: &Connection, id: &str) -> Result<Option<Option<String>>> {
    Ok(conn
        .prepare_cached("SELECT parent_id FROM node_lock_folders WHERE id = ?1")?
        .query_row([id], |r| r.get(0))
        .optional()?)
}

fn folder_exists(conn: &Connection, id: &str) -> Result<bool> {
    Ok(folder_parent(conn, id)?.is_some())
}

/// Whether folder `inner` is `outer` or inside it (walking up from
/// `inner`; a cycle stops the walk).
fn folder_within(conn: &Connection, inner: &str, outer: &str) -> Result<bool> {
    let mut seen = HashSet::new();
    let mut at = Some(inner.to_owned());
    while let Some(id) = at {
        if id == outer {
            return Ok(true);
        }
        if !seen.insert(id.clone()) {
            return Ok(false);
        }
        at = folder_parent(conn, &id)?.flatten();
    }
    Ok(false)
}

/// A list's items in order (`sort`, then folders first, then id).
fn list_of(conn: &Connection, parent: &NodeLockParent) -> Result<Vec<(NodeLockItem, f64)>> {
    let mut out = Vec::new();
    let item = |kind: NodeLockItemKind, r: &Row<'_>| -> rusqlite::Result<(NodeLockItem, f64)> {
        Ok((
            NodeLockItem {
                kind,
                id: r.get(0)?,
            },
            r.get(1)?,
        ))
    };
    match parent {
        NodeLockParent::Folder(folder) => {
            let mut stmt = conn
                .prepare_cached("SELECT id, sort FROM node_lock_folders WHERE parent_id IS ?1")?;
            for row in stmt.query_map([folder], |r| item(NodeLockItemKind::Folder, r))? {
                out.push(row?);
            }
            let mut stmt = conn.prepare_cached(
                "SELECT id, sort FROM node_locks WHERE parent_id IS NULL AND folder_id IS ?1",
            )?;
            for row in stmt.query_map([folder], |r| item(NodeLockItemKind::Lock, r))? {
                out.push(row?);
            }
        }
        NodeLockParent::Lock(lock) => {
            let mut stmt =
                conn.prepare_cached("SELECT id, sort FROM node_locks WHERE parent_id = ?1")?;
            for row in stmt.query_map([lock], |r| item(NodeLockItemKind::Lock, r))? {
                out.push(row?);
            }
        }
    }
    out.sort_by(|(a, x), (b, y)| {
        x.total_cmp(y)
            .then_with(|| {
                (a.kind == NodeLockItemKind::Lock).cmp(&(b.kind == NodeLockItemKind::Lock))
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// The `sort` that puts a new item at the top of `parent`'s list.
#[allow(clippy::float_arithmetic)] // `sort` is a fractional index (§7.5)
fn top_of(conn: &Connection, parent: &NodeLockParent) -> Result<f64> {
    Ok(list_of(conn, parent)?
        .first()
        .map_or(0.0, |(_, sort)| sort - 1.0))
}

fn set_sort(
    conn: &Connection,
    item: &NodeLockItem,
    folder: Option<&str>,
    sort: f64,
    now_ms: i64,
) -> Result<()> {
    match item.kind {
        NodeLockItemKind::Lock => conn
            .prepare_cached("UPDATE node_locks SET folder_id = ?2, sort = ?3 WHERE id = ?1")?
            .execute(params![item.id, folder, sort])?,
        NodeLockItemKind::Folder => conn
            .prepare_cached(
                "UPDATE node_lock_folders SET parent_id = ?2, sort = ?3, updated_at = ?4
                 WHERE id = ?1",
            )?
            .execute(params![item.id, folder, sort, now_ms])?,
    };
    Ok(())
}

/// `count` sorts strictly between `lower` and `upper` (either open), each
/// at least [`MIN_SORT_GAP`] from the next; `None`: no room (renumber).
#[allow(clippy::float_arithmetic)] // `sort` is a fractional index (§7.5)
fn sorts_between(lower: Option<f64>, upper: Option<f64>, count: usize) -> Option<Vec<f64>> {
    let n = f64::from(u32::try_from(count).ok()?);
    let step = |i: usize| f64::from(u32::try_from(i).unwrap_or(u32::MAX));
    let sorts: Vec<f64> = match (lower, upper) {
        (None, None) => (0..count).map(step).collect(),
        (None, Some(upper)) => (0..count).map(|i| upper - n + step(i)).collect(),
        (Some(lower), None) => (0..count).map(|i| lower + 1.0 + step(i)).collect(),
        (Some(lower), Some(upper)) => {
            let gap = (upper - lower) / (n + 1.0);
            (0..count).map(|i| lower + gap * (step(i) + 1.0)).collect()
        }
    };
    // Every neighbour (the bounds included) at least the gap apart: this
    // also catches a float that cannot split the gap (the migrated
    // `-updated_at` sorts are ~1e12, where a double steps by ~2e-4).
    let mut chain = Vec::with_capacity(count + 2);
    chain.extend(lower);
    chain.extend(sorts.iter().copied());
    chain.extend(upper);
    chain
        .windows(2)
        .all(|w| w[1] - w[0] >= MIN_SORT_GAP && w[1] > w[0])
        .then_some(sorts)
}

/// Locks, each with its `parent_id`.
type Locks = Vec<(String, Option<String>)>;

/// `roots` (the existing ones) and every lock built on them, each with its
/// `parent_id`, parents before children.
fn lock_branches(conn: &Connection, roots: impl IntoIterator<Item = String>) -> Result<Locks> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in roots {
        if seen.contains(&id) {
            continue;
        }
        if let Some((_, parent)) = lock_place(conn, &id)? {
            seen.insert(id.clone());
            out.push((id, parent));
        }
    }
    let mut stmt = conn.prepare_cached("SELECT id FROM node_locks WHERE parent_id = ?1")?;
    let mut next = 0;
    while next < out.len() {
        let parent = out[next].0.clone();
        next += 1;
        let children = stmt
            .query_map([&parent], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for child in children {
            if seen.insert(child.clone()) {
                out.push((child, Some(parent.clone())));
            }
        }
    }
    Ok(out)
}

/// `roots` (the existing ones) and every folder inside them.
fn folder_trees(conn: &Connection, roots: impl IntoIterator<Item = String>) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in roots {
        if !seen.contains(&id) && folder_exists(conn, &id)? {
            seen.insert(id.clone());
            out.push(id);
        }
    }
    let mut stmt = conn.prepare_cached("SELECT id FROM node_lock_folders WHERE parent_id = ?1")?;
    let mut next = 0;
    while next < out.len() {
        let parent = out[next].clone();
        next += 1;
        let children = stmt
            .query_map([&parent], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for child in children {
            if seen.insert(child.clone()) {
                out.push(child);
            }
        }
    }
    Ok(out)
}

/// What deleting the locks `locks` and the folders `folders` takes: the
/// folders (subfolders included), and the locks (the named ones, every
/// lock in those folders, and all their branches).
fn doomed(
    conn: &Connection,
    locks: Vec<String>,
    folders: Vec<String>,
) -> Result<(Vec<String>, Locks)> {
    let folders = folder_trees(conn, folders)?;
    let mut roots = locks;
    let mut stmt = conn.prepare_cached("SELECT id FROM node_locks WHERE folder_id = ?1")?;
    for folder in &folders {
        for id in stmt.query_map([folder], |r| r.get::<_, String>(0))? {
            roots.push(id?);
        }
    }
    let locks = lock_branches(conn, roots)?;
    Ok((folders, locks))
}

fn delete_locks(conn: &Connection, locks: &[(String, Option<String>)]) -> Result<u64> {
    let mut stmt = conn.prepare_cached("DELETE FROM node_locks WHERE id = ?1")?;
    let mut gone = 0u64;
    for (id, _) in locks {
        gone += u64::try_from(stmt.execute([id])?).unwrap_or(0);
    }
    Ok(gone)
}

fn count(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

fn folder_row(r: &Row<'_>) -> rusqlite::Result<NodeLockFolder> {
    Ok(NodeLockFolder {
        id: r.get(0)?,
        name: r.get(1)?,
        parent_id: r.get(2)?,
        sort: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

const FOLDER_COLUMNS: &str = "id, name, parent_id, sort, created_at, updated_at";

impl WriterHandle {
    /// Insert or update the folder `folder.id` (name, place). A new one
    /// gets `created_at` = `now_ms`; `updated_at` is `now_ms`. Refused
    /// (`OutOfRange`): a bad id, name or sort, a parent that does not
    /// exist, is the folder itself or inside it. Returns the stored row.
    pub fn save_node_lock_folder(
        &self,
        folder: NodeLockFolderInput,
        now_ms: i64,
    ) -> Result<NodeLockFolder> {
        check_id(&folder.id)?;
        check(
            !folder.name.trim().is_empty() && folder.name.chars().count() <= MAX_NAME_CHARS,
            "a nodelock folder's name",
        )?;
        check(
            folder.sort.is_none_or(f64::is_finite),
            "a nodelock folder's sort",
        )?;
        self.write(move |tx| {
            if let Some(parent) = &folder.parent_id {
                check(folder_exists(tx, parent)?, "a nodelock folder's parent")?;
                check(
                    !folder_within(tx, parent, &folder.id)?,
                    "a nodelock folder's parent",
                )?;
            }
            let stored: Option<(Option<String>, f64)> = tx
                .query_row(
                    "SELECT parent_id, sort FROM node_lock_folders WHERE id = ?1",
                    [&folder.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let sort = match (folder.sort, stored) {
                (Some(sort), _) => sort,
                (None, Some((parent, sort))) if parent == folder.parent_id => sort,
                (None, _) => top_of(tx, &NodeLockParent::Folder(folder.parent_id.clone()))?,
            };
            tx.execute(
                "INSERT INTO node_lock_folders (id, name, parent_id, sort, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT (id) DO UPDATE SET
                   name = excluded.name, parent_id = excluded.parent_id,
                   sort = excluded.sort, updated_at = excluded.updated_at",
                params![
                    folder.id,
                    folder.name.trim(),
                    folder.parent_id,
                    sort,
                    now_ms
                ],
            )?;
            Ok(tx.query_row(
                &format!("SELECT {FOLDER_COLUMNS} FROM node_lock_folders WHERE id = ?1"),
                [&folder.id],
                folder_row,
            )?)
        })
    }

    /// Move `items` (root locks and folders, in this order, together) to
    /// `to`; a lock's children go with it. A list whose gaps get below
    /// [`MIN_SORT_GAP`] is renumbered (0, 1, 2, …). Moved folders get
    /// `updated_at` = `now_ms`; locks keep theirs.
    ///
    /// Returns false and changes nothing when an item is unknown or a
    /// child lock (it stays under its parent), a folder would go into
    /// itself or a folder inside it, the target folder is unknown, or the
    /// anchor is not in it (or is moved too). All in one transaction.
    pub fn move_node_locks(
        &self,
        items: Vec<NodeLockItem>,
        to: NodeLockPlace,
        now_ms: i64,
    ) -> Result<bool> {
        self.write(move |tx| {
            let mut seen = HashSet::new();
            let items: Vec<NodeLockItem> = items
                .into_iter()
                .filter(|i| seen.insert(i.clone()))
                .collect();
            if items.is_empty() {
                return Ok(false);
            }
            let folder = to.folder_id.as_deref();
            if let Some(folder) = folder
                && !folder_exists(tx, folder)?
            {
                return Ok(false);
            }
            for item in &items {
                let ok = match item.kind {
                    NodeLockItemKind::Lock => {
                        matches!(lock_place(tx, &item.id)?, Some((_, None)))
                    }
                    NodeLockItemKind::Folder => {
                        folder_exists(tx, &item.id)?
                            && match folder {
                                Some(folder) => !folder_within(tx, folder, &item.id)?,
                                None => true,
                            }
                    }
                };
                if !ok {
                    return Ok(false);
                }
            }
            let parent = NodeLockParent::Folder(to.folder_id.clone());
            let list: Vec<(NodeLockItem, f64)> = list_of(tx, &parent)?
                .into_iter()
                .filter(|(item, _)| !seen.contains(item))
                .collect();
            let at = match (&to.before, &to.after) {
                (Some(anchor), _) => list.iter().position(|(i, _)| i == anchor),
                (None, Some(anchor)) => list.iter().position(|(i, _)| i == anchor).map(|p| p + 1),
                (None, None) => Some(0),
            };
            let Some(at) = at else {
                return Ok(false);
            };
            let lower = at.checked_sub(1).map(|p| list[p].1);
            let upper = list.get(at).map(|(_, sort)| *sort);
            match sorts_between(lower, upper, items.len()) {
                Some(sorts) => {
                    for (item, sort) in items.iter().zip(sorts) {
                        set_sort(tx, item, folder, sort, now_ms)?;
                    }
                }
                None => {
                    let mut order: Vec<NodeLockItem> =
                        list.into_iter().map(|(item, _)| item).collect();
                    order.splice(at..at, items.iter().cloned());
                    for (n, item) in order.iter().enumerate() {
                        let sort = f64::from(u32::try_from(n).unwrap_or(u32::MAX));
                        if seen.contains(item) {
                            set_sort(tx, item, folder, sort, now_ms)?;
                        } else {
                            // Renumbered in place: not moved, not touched.
                            match item.kind {
                                NodeLockItemKind::Lock => tx
                                    .prepare_cached(
                                        "UPDATE node_locks SET sort = ?2 WHERE id = ?1",
                                    )?
                                    .execute(params![item.id, sort])?,
                                NodeLockItemKind::Folder => tx
                                    .prepare_cached(
                                        "UPDATE node_lock_folders SET sort = ?2 WHERE id = ?1",
                                    )?
                                    .execute(params![item.id, sort])?,
                            };
                        }
                    }
                }
            }
            Ok(true)
        })
    }

    /// Delete the folders `ids` with every folder inside them, and every
    /// lock in those (with its branch), in one transaction (unknown ids
    /// are skipped). Returns how many folders and lock rows went.
    pub fn delete_node_lock_folders(&self, ids: Vec<String>) -> Result<NodeLockDeleted> {
        self.write(move |tx| {
            let (folders, locks) = doomed(tx, Vec::new(), ids)?;
            let locks = delete_locks(tx, &locks)?;
            // Children first: the table's own cascade then finds nothing
            // left to do.
            let mut stmt = tx.prepare_cached("DELETE FROM node_lock_folders WHERE id = ?1")?;
            let mut gone = 0u64;
            for id in folders.iter().rev() {
                gone += u64::try_from(stmt.execute([id])?).unwrap_or(0);
            }
            Ok(NodeLockDeleted {
                folders: gone,
                locks,
            })
        })
    }
}

impl Reader {
    /// Every folder, by parent then `sort`.
    pub fn node_lock_folders(&self) -> Result<Vec<NodeLockFolder>> {
        self.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {FOLDER_COLUMNS} FROM node_lock_folders ORDER BY parent_id, sort, id"
            ))?;
            Ok(stmt
                .query_map([], folder_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// What deleting the locks `locks` (with their branches) and the
    /// folders `folders` (with everything in them) would take; unknown ids
    /// are skipped. Read in one transaction.
    pub fn node_lock_delete_preview(
        &self,
        locks: Vec<String>,
        folders: Vec<String>,
    ) -> Result<NodeLockDeletePreview> {
        self.with(|conn| {
            let (folders, locks) = doomed(conn, locks, folders)?;
            let ids: HashSet<&str> = locks.iter().map(|(id, _)| id.as_str()).collect();
            let descendants = locks
                .iter()
                .filter(|(_, parent)| parent.as_deref().is_some_and(|p| ids.contains(p)))
                .count();
            Ok(NodeLockDeletePreview {
                folders: count(folders.len()),
                locks: count(locks.len() - descendants),
                descendants: count(descendants),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use crate::migrate;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rail-store-node-locks-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    fn lock(id: &str, flop: &str, status: NodeLockStatus) -> NodeLockRow {
        NodeLockRow {
            id: id.to_owned(),
            name: format!("Tight BTN · {flop} · BTN vs BB"),
            created_at: 0,
            updated_at: 0,
            set_id: "nlhe-cash-6max-100bb".to_owned(),
            line: "BTN-open/BB-call".to_owned(),
            flop: flop.to_owned(),
            turn: None,
            river: None,
            street: NodeLockStreet::Flop,
            node_path: "r:0".to_owned(),
            lock_json: format!(
                r#"{{"version":1,"spot":{{"set":"nlhe-cash-6max-100bb","line":"BTN-open/BB-call","flop":"{flop}"}},"nodes":[],"earlier":"player","targetPct":1}}"#
            ),
            lock_hash: "ab".repeat(32),
            preset: Some("tight".to_owned()),
            status,
            engine: None,
            threads: None,
            iterations: None,
            exploitability_pct: None,
            seconds: None,
            peak_mb: None,
            summary_json: None,
            result: None,
            result_size: None,
            folder_id: None,
            parent_id: None,
            sort: 0.0,
        }
    }

    /// Saved as `solving`, then `solved` with its chunk: the listing has
    /// every column but the chunk (and its size), newest change first, and
    /// filters by spot; `node_lock` has the chunk; an upsert keeps the
    /// first save's `created_at` and replaces the rest.
    #[test]
    fn save_list_get_round_trip() {
        let dir = scratch("round-trip");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        let reader = store.reader();
        assert!(reader.node_locks(None).expect("empty").is_empty());

        let first = lock("a", "AcTc6d", NodeLockStatus::Solving);
        assert_eq!(
            writer.save_node_lock(first.clone(), 100).expect("save"),
            (100, 100)
        );
        writer
            .save_node_lock(lock("b", "Kh7d2s", NodeLockStatus::Draft), 200)
            .expect("save");
        let mut solved = first.clone();
        solved.status = NodeLockStatus::Solved;
        solved.engine = Some("workers".to_owned());
        solved.threads = Some(9);
        solved.iterations = Some(100);
        solved.exploitability_pct = Some(0.98);
        solved.seconds = Some(271.5);
        solved.peak_mb = Some(1210.0);
        solved.summary_json = Some(r#"{"evGain":0.42}"#.to_owned());
        solved.result = Some(vec![1, 2, 3, 0, 255]);
        solved.created_at = 999; // ignored
        assert_eq!(
            writer.save_node_lock(solved.clone(), 300).expect("solved"),
            (100, 300)
        );

        let list = reader.node_locks(None).expect("list");
        assert_eq!(
            list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"],
            "newest change first"
        );
        let listed = &list[0];
        assert_eq!(listed.result, None, "no chunk in a listing");
        assert_eq!(listed.result_size, Some(5));
        assert_eq!(list[1].result_size, None);
        let expected = NodeLockRow {
            created_at: 100,
            updated_at: 300,
            result: None,
            result_size: Some(5),
            ..solved.clone()
        };
        assert_eq!(*listed, expected);

        let got = reader.node_lock("a").expect("get").expect("there");
        assert_eq!(got.result.as_deref(), Some(&[1u8, 2, 3, 0, 255][..]));
        assert_eq!(
            got,
            NodeLockRow {
                result: solved.result.clone(),
                ..expected
            }
        );
        assert_eq!(reader.node_lock("nope").expect("get"), None);

        let spot = NodeLockSpot {
            set_id: "nlhe-cash-6max-100bb".to_owned(),
            line: "BTN-open/BB-call".to_owned(),
            flop: "Kh7d2s".to_owned(),
        };
        let one = reader.node_locks(Some(&spot)).expect("spot");
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].id, "b");
        let other = NodeLockSpot {
            line: "CO-open/BB-call".to_owned(),
            ..spot
        };
        assert!(reader.node_locks(Some(&other)).expect("none").is_empty());

        // A save without a chunk clears it (the whole row is replaced).
        let mut edited = solved;
        edited.status = NodeLockStatus::Draft;
        edited.result = None;
        writer.save_node_lock(edited, 400).expect("edit");
        let got = reader.node_lock("a").expect("get").expect("there");
        assert_eq!((got.result, got.result_size), (None, None));
        assert_eq!(got.status, NodeLockStatus::Draft);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rename bumps `updated_at`; delete takes many ids at once and skips
    /// unknown ones.
    #[test]
    fn rename_and_delete() {
        let dir = scratch("rename-delete");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        for (n, id) in ["a", "b", "c"].iter().enumerate() {
            let at = 100 * i64::try_from(n).expect("small");
            writer
                .save_node_lock(lock(id, "AcTc6d", NodeLockStatus::Draft), at)
                .expect("save");
        }
        assert!(
            writer
                .rename_node_lock("a", "  Nit on the flop  ", 1_000)
                .expect("rename")
        );
        assert!(!writer.rename_node_lock("zz", "x", 1_000).expect("absent"));
        assert!(matches!(
            writer.rename_node_lock("a", "   ", 1_000),
            Err(Error::OutOfRange(_))
        ));
        let list = store.reader().node_locks(None).expect("list");
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].name, "Nit on the flop");
        assert_eq!((list[0].created_at, list[0].updated_at), (0, 1_000));

        assert_eq!(
            writer
                .delete_node_locks(vec!["a".into(), "c".into(), "zz".into()])
                .expect("delete"),
            2
        );
        assert_eq!(writer.delete_node_locks(Vec::new()).expect("none"), 0);
        let left: Vec<String> = store
            .reader()
            .node_locks(None)
            .expect("list")
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(left, ["b"]);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What the table or the writer refuses.
    #[test]
    fn bad_rows_are_refused() {
        let dir = scratch("refused");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        let good = lock("a", "AcTc6d", NodeLockStatus::Draft);
        let cases = [
            NodeLockRow {
                id: String::new(),
                ..good.clone()
            },
            NodeLockRow {
                id: "x".repeat(MAX_ID + 1),
                ..good.clone()
            },
            NodeLockRow {
                name: " ".into(),
                ..good.clone()
            },
            NodeLockRow {
                flop: String::new(),
                ..good.clone()
            },
            NodeLockRow {
                lock_json: "[1,2]".into(),
                ..good.clone()
            },
            NodeLockRow {
                lock_json: "{not json".into(),
                ..good.clone()
            },
            NodeLockRow {
                summary_json: Some("{".into()),
                ..good.clone()
            },
        ];
        for row in cases {
            assert!(
                matches!(
                    writer.save_node_lock(row.clone(), 1),
                    Err(Error::OutOfRange(_))
                ),
                "{row:?}"
            );
        }
        // The table's own checks, behind the writer.
        let bad_street = writer.write(|tx| {
            Ok(tx.execute(
                "INSERT INTO node_locks (id, name, created_at, updated_at, set_id, line, flop,
                   street, node_path, lock_json, lock_hash, status)
                 VALUES ('z', 'z', 1, 1, 's', 'l', 'f', 'preflop', '', '{}', '', 'draft')",
                [],
            )?)
        });
        assert!(bad_street.is_err());
        assert!(store.reader().node_locks(None).expect("list").is_empty());
        writer.save_node_lock(good, 1).expect("the good one");
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A solve cut off by the app's exit: `solving` is `cancelled` when the
    /// store opens again, its `updated_at` kept; other rows are untouched.
    #[test]
    fn solving_is_cancelled_at_open() {
        let dir = scratch("cancel");
        let path = dir.join(crate::FILE_NAME);
        let store = Store::open(&path).expect("store");
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock(lock("run", "AcTc6d", NodeLockStatus::Solving), 10)
            .expect("solving");
        writer
            .save_node_lock(lock("done", "AcTc6d", NodeLockStatus::Solved), 20)
            .expect("solved");
        drop(writer);
        store.close();

        let store = Store::open(&path).expect("reopen");
        let reader = store.reader();
        let run = reader.node_lock("run").expect("get").expect("there");
        assert_eq!(run.status, NodeLockStatus::Cancelled);
        assert_eq!(run.updated_at, 10);
        let done = reader.node_lock("done").expect("get").expect("there");
        assert_eq!(done.status, NodeLockStatus::Solved);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store from before version 24 (with a row of its own) opens with
    /// the table, empty, and keeps what it had.
    #[test]
    fn an_older_store_gains_the_table() {
        let dir = scratch("older");
        let path = dir.join(crate::FILE_NAME);
        {
            let mut conn = Connection::open(&path).expect("open");
            migrate::migrate_to(&mut conn, 23).expect("version 23");
            conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('probe', 'kept', 1)",
                [],
            )
            .expect("probe");
            let has: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name = 'node_locks'",
                    [],
                    |r| r.get(0),
                )
                .expect("schema");
            assert_eq!(has, 0);
        }
        let store = Store::open(&path).expect("migrated");
        assert_eq!(
            store.status().expect("status").schema_version,
            migrate::LATEST
        );
        assert!(store.reader().node_locks(None).expect("list").is_empty());
        assert_eq!(
            store.reader().kv("probe").expect("kv").as_deref(),
            Some("kept")
        );
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock(lock("a", "AcTc6d", NodeLockStatus::Draft), 5)
            .expect("save");
        assert_eq!(store.reader().node_locks(None).expect("list").len(), 1);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn folder(id: &str, parent: Option<&str>) -> NodeLockFolderInput {
        NodeLockFolderInput {
            id: id.to_owned(),
            name: format!("Folder {id}"),
            parent_id: parent.map(str::to_owned),
            sort: None,
        }
    }

    fn child(id: &str, parent: &str) -> NodeLockRow {
        NodeLockRow {
            parent_id: Some(parent.to_owned()),
            ..lock(id, "AcTc6d", NodeLockStatus::Draft)
        }
    }

    fn item(kind: NodeLockItemKind, id: &str) -> NodeLockItem {
        NodeLockItem {
            kind,
            id: id.to_owned(),
        }
    }

    fn lk(id: &str) -> NodeLockItem {
        item(NodeLockItemKind::Lock, id)
    }

    fn fd(id: &str) -> NodeLockItem {
        item(NodeLockItemKind::Folder, id)
    }

    fn into(folder: Option<&str>) -> NodeLockPlace {
        NodeLockPlace {
            folder_id: folder.map(str::to_owned),
            ..NodeLockPlace::default()
        }
    }

    /// A list as the tree shows it: folders as `F:id`, locks as their id,
    /// ascending `sort`.
    fn order(store: &Store, parent: &NodeLockParent) -> Vec<String> {
        store
            .reader()
            .with(|conn| list_of(conn, parent))
            .expect("list")
            .into_iter()
            .map(|(item, _)| match item.kind {
                NodeLockItemKind::Folder => format!("F:{}", item.id),
                NodeLockItemKind::Lock => item.id,
            })
            .collect()
    }

    fn top(folder: Option<&str>) -> NodeLockParent {
        NodeLockParent::Folder(folder.map(str::to_owned))
    }

    fn sorts(store: &Store, parent: &NodeLockParent) -> Vec<f64> {
        store
            .reader()
            .with(|conn| list_of(conn, parent))
            .expect("list")
            .into_iter()
            .map(|(_, sort)| sort)
            .collect()
    }

    fn ids(store: &Store) -> Vec<String> {
        let mut ids: Vec<String> = store
            .reader()
            .node_locks(None)
            .expect("list")
            .into_iter()
            .map(|r| r.id)
            .collect();
        ids.sort();
        ids
    }

    /// A version-24 store with rows gains the tree: the folders table
    /// (empty), the columns (no folder, no parent, `sort` = -`updated_at`,
    /// so the newest change is on top) and the indexes; the rows keep
    /// everything else.
    #[test]
    fn a_v24_store_with_rows_gains_the_tree() {
        let dir = scratch("v24");
        let path = dir.join(crate::FILE_NAME);
        {
            let mut conn = Connection::open(&path).expect("open");
            migrate::migrate_to(&mut conn, 24).expect("version 24");
            for (id, updated) in [("old", 100), ("new", 300), ("mid", 200)] {
                conn.execute(
                    "INSERT INTO node_locks (id, name, created_at, updated_at, set_id, line, flop,
                       street, node_path, lock_json, lock_hash, status, result)
                     VALUES (?1, 'n', 1, ?2, 's', 'l', 'AcTc6d', 'flop', 'r:0', '{}', 'h',
                             'solved', x'0102')",
                    params![id, updated],
                )
                .expect("v24 row");
            }
        }
        let store = Store::open(&path).expect("migrated");
        assert_eq!(
            store.status().expect("status").schema_version,
            migrate::LATEST
        );
        assert_eq!(order(&store, &top(None)), ["new", "mid", "old"]);
        let row = store
            .reader()
            .node_lock("mid")
            .expect("get")
            .expect("there");
        assert_eq!(
            (row.folder_id, row.parent_id, row.sort),
            (None, None, -200.0)
        );
        assert_eq!(row.result.as_deref(), Some(&[1u8, 2][..]));
        assert_eq!(row.status, NodeLockStatus::Solved);
        assert!(
            store
                .reader()
                .node_lock_folders()
                .expect("folders")
                .is_empty()
        );
        let indexes: Vec<String> = store
            .reader()
            .with(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT name FROM sqlite_schema WHERE type = 'index'
                       AND name IN ('node_locks_parent', 'node_locks_folder',
                                    'node_lock_folders_parent')
                     ORDER BY name",
                )?;
                Ok(stmt
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .expect("indexes");
        assert_eq!(
            indexes,
            [
                "node_lock_folders_parent",
                "node_locks_folder",
                "node_locks_parent"
            ]
        );
        // A new root goes on top of the migrated ones.
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock(lock("fresh", "AcTc6d", NodeLockStatus::Draft), 400)
            .expect("save");
        assert_eq!(order(&store, &top(None)), ["fresh", "new", "mid", "old"]);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The first save places a row: on top of its list, a child under its
    /// parent (never in a folder), a root in its folder (an unknown one:
    /// the top level); an unknown parent is refused. Later saves keep the
    /// place whatever they carry.
    #[test]
    fn saves_place_rows_once() {
        let dir = scratch("place");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock(lock("a", "AcTc6d", NodeLockStatus::Draft), 1)
            .expect("a");
        writer
            .save_node_lock(lock("b", "AcTc6d", NodeLockStatus::Draft), 2)
            .expect("b");
        let f = writer
            .save_node_lock_folder(folder("f", None), 3)
            .expect("f");
        assert_eq!((f.sort, f.created_at, f.updated_at), (-2.0, 3, 3));
        assert_eq!(order(&store, &top(None)), ["F:f", "b", "a"]);

        let in_f = NodeLockRow {
            folder_id: Some("f".to_owned()),
            ..lock("c", "AcTc6d", NodeLockStatus::Draft)
        };
        writer.save_node_lock(in_f, 4).expect("c");
        let lost = NodeLockRow {
            folder_id: Some("nope".to_owned()),
            ..lock("e", "AcTc6d", NodeLockStatus::Draft)
        };
        writer.save_node_lock(lost, 5).expect("e");
        assert_eq!(order(&store, &top(Some("f"))), ["c"]);
        assert_eq!(order(&store, &top(None)), ["e", "F:f", "b", "a"]);

        writer.save_node_lock(child("a1", "a"), 6).expect("a1");
        let foldered = NodeLockRow {
            folder_id: Some("f".to_owned()),
            ..child("a2", "a")
        };
        writer.save_node_lock(foldered, 7).expect("a2");
        assert_eq!(
            order(&store, &NodeLockParent::Lock("a".to_owned())),
            ["a2", "a1"]
        );
        let a2 = store.reader().node_lock("a2").expect("get").expect("there");
        assert_eq!(
            (a2.folder_id.as_deref(), a2.parent_id.as_deref()),
            (None, Some("a"))
        );
        assert!(matches!(
            writer.save_node_lock(child("orphan", "gone"), 8),
            Err(Error::OutOfRange(_))
        ));
        assert!(store.reader().node_lock("orphan").expect("get").is_none());
        assert!(matches!(
            writer.save_node_lock(
                NodeLockRow {
                    folder_id: Some(String::new()),
                    ..lock("x", "AcTc6d", NodeLockStatus::Draft)
                },
                8
            ),
            Err(Error::OutOfRange(_))
        ));

        // Re-saves (the solve's end, an edit) keep the place.
        let before = store.reader().node_lock("c").expect("get").expect("there");
        writer
            .save_node_lock(
                NodeLockRow {
                    status: NodeLockStatus::Solved,
                    folder_id: None,
                    parent_id: Some("b".to_owned()),
                    sort: 99.0,
                    ..lock("c", "AcTc6d", NodeLockStatus::Draft)
                },
                9,
            )
            .expect("re-save");
        let after = store.reader().node_lock("c").expect("get").expect("there");
        assert_eq!(after.status, NodeLockStatus::Solved);
        assert_eq!(
            (after.folder_id, after.parent_id, after.sort),
            (before.folder_id, before.parent_id, before.sort)
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Folders: renamed in place, moved (to the top of the new list),
    /// placed by an explicit sort; never into themselves or a folder
    /// inside them, never into an unknown one.
    #[test]
    fn folder_saves() {
        let dir = scratch("folders");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock_folder(folder("a", None), 1)
            .expect("a");
        writer
            .save_node_lock_folder(folder("b", Some("a")), 2)
            .expect("b");
        writer
            .save_node_lock_folder(folder("c", Some("b")), 3)
            .expect("c");
        writer
            .save_node_lock_folder(folder("d", None), 4)
            .expect("d");

        let renamed = writer
            .save_node_lock_folder(
                NodeLockFolderInput {
                    name: "  Passive BB  ".to_owned(),
                    ..folder("b", Some("a"))
                },
                10,
            )
            .expect("rename");
        assert_eq!(renamed.name, "Passive BB");
        assert_eq!(
            (renamed.sort, renamed.created_at, renamed.updated_at),
            (0.0, 2, 10)
        );

        for bad in [
            folder("a", Some("a")),
            folder("a", Some("c")),
            folder("a", Some("nope")),
            NodeLockFolderInput {
                name: "  ".to_owned(),
                ..folder("z", None)
            },
            NodeLockFolderInput {
                sort: Some(f64::NAN),
                ..folder("z", None)
            },
            folder("", None),
        ] {
            assert!(
                matches!(
                    writer.save_node_lock_folder(bad.clone(), 11),
                    Err(Error::OutOfRange(_))
                ),
                "{bad:?}"
            );
        }

        let moved = writer
            .save_node_lock_folder(folder("c", None), 12)
            .expect("c up");
        assert_eq!(order(&store, &top(None)), ["F:c", "F:d", "F:a"]);
        assert_eq!(moved.updated_at, 12);
        writer
            .save_node_lock_folder(
                NodeLockFolderInput {
                    sort: Some(100.0),
                    ..folder("c", None)
                },
                13,
            )
            .expect("c down");
        assert_eq!(order(&store, &top(None)), ["F:d", "F:a", "F:c"]);
        let all = store.reader().node_lock_folders().expect("folders");
        assert_eq!(all.len(), 4);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Moves: to the top, before or after an anchor, into a folder (with
    /// the lock's children), several at once in their order; and the
    /// renumbering when the gap runs out, also between the migrated
    /// `-updated_at` sorts where a double cannot split a millisecond many
    /// times.
    #[test]
    fn move_reorder_and_renumber() {
        let dir = scratch("move");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        for id in ["a", "b", "c", "d"] {
            writer
                .save_node_lock(lock(id, "AcTc6d", NodeLockStatus::Draft), 1)
                .expect("save");
        }
        writer.save_node_lock(child("a1", "a"), 1).expect("a1");
        writer
            .save_node_lock_folder(folder("f", None), 1)
            .expect("f");
        assert_eq!(order(&store, &top(None)), ["F:f", "d", "c", "b", "a"]);

        let mv = |items: Vec<NodeLockItem>, to: NodeLockPlace| {
            writer.move_node_locks(items, to, 50).expect("move")
        };
        assert!(mv(vec![lk("a")], into(None)));
        assert_eq!(order(&store, &top(None)), ["a", "F:f", "d", "c", "b"]);
        assert!(mv(
            vec![lk("b"), fd("f")],
            NodeLockPlace {
                before: Some(lk("d")),
                ..into(None)
            }
        ));
        assert_eq!(order(&store, &top(None)), ["a", "b", "F:f", "d", "c"]);
        assert!(mv(
            vec![lk("a")],
            NodeLockPlace {
                after: Some(lk("c")),
                ..into(None)
            }
        ));
        assert_eq!(order(&store, &top(None)), ["b", "F:f", "d", "c", "a"]);
        assert_eq!(
            store.reader().node_lock_folders().expect("f")[0].updated_at,
            50
        );

        // Into the folder: the lock's child goes with it.
        assert!(mv(vec![lk("a"), lk("c")], into(Some("f"))));
        assert_eq!(order(&store, &top(Some("f"))), ["a", "c"]);
        assert_eq!(order(&store, &top(None)), ["b", "F:f", "d"]);
        let a1 = store.reader().node_lock("a1").expect("get").expect("there");
        assert_eq!((a1.parent_id.as_deref(), a1.folder_id), (Some("a"), None));

        // Halving the gap after b, moving d and F:f in turn: renumbered
        // when it gets below the minimum, the order always as asked.
        let squeeze = |label: &str| {
            let mut renumbered = None;
            for n in 0..40 {
                let (moving, other) = if n % 2 == 0 {
                    (fd("f"), "F:f")
                } else {
                    (lk("d"), "d")
                };
                assert!(mv(
                    vec![moving],
                    NodeLockPlace {
                        after: Some(lk("b")),
                        ..into(None)
                    }
                ));
                let now = order(&store, &top(None));
                assert_eq!(now[..2], ["b".to_owned(), other.to_owned()], "{label} {n}");
                let s = sorts(&store, &top(None));
                assert!(
                    s.windows(2).all(|w| w[1] - w[0] >= MIN_SORT_GAP),
                    "{label} {n}: {s:?}"
                );
                if s == [0.0, 1.0, 2.0] {
                    renumbered = Some(n);
                    break;
                }
            }
            renumbered
        };
        let n = squeeze("small").expect("renumbered");
        assert!((15..30).contains(&n), "{n}");

        // Rows a millisecond apart at ~1.8e12 (as migrated): a double runs
        // out of room after a few halvings, well before the minimum gap.
        let at = -1_800_000_000_000.0;
        writer
            .write(move |tx| {
                tx.execute(
                    "UPDATE node_locks SET sort = CASE id WHEN 'b' THEN ?1 ELSE ?1 + 1 END
                     WHERE id IN ('b', 'd')",
                    [at],
                )?;
                tx.execute("UPDATE node_lock_folders SET sort = ?1 + 2", [at])?;
                Ok(())
            })
            .expect("migrated sorts");
        assert_eq!(order(&store, &top(None)), ["b", "d", "F:f"]);
        let n = squeeze("migrated").expect("renumbered");
        assert!(n < 15, "{n}");
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What a move refuses (false, nothing changed): a child lock, a folder
    /// into itself or a folder inside it, an unknown item or target, an
    /// anchor elsewhere or moved too, nothing to move.
    #[test]
    fn move_refusals() {
        let dir = scratch("refusals");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock(lock("a", "AcTc6d", NodeLockStatus::Draft), 1)
            .expect("a");
        writer
            .save_node_lock(lock("b", "AcTc6d", NodeLockStatus::Draft), 1)
            .expect("b");
        writer.save_node_lock(child("a1", "a"), 1).expect("a1");
        writer
            .save_node_lock_folder(folder("f", None), 1)
            .expect("f");
        writer
            .save_node_lock_folder(folder("g", Some("f")), 1)
            .expect("g");
        writer
            .save_node_lock_folder(folder("h", Some("g")), 1)
            .expect("h");
        let snapshot = |store: &Store| {
            (
                store.reader().node_locks(None).expect("locks"),
                store.reader().node_lock_folders().expect("folders"),
            )
        };
        let before = snapshot(&store);
        let cases: Vec<(Vec<NodeLockItem>, NodeLockPlace)> = vec![
            (vec![lk("a1")], into(None)),
            (vec![lk("b"), lk("a1")], into(Some("f"))),
            (vec![fd("f")], into(Some("f"))),
            (vec![fd("f")], into(Some("h"))),
            (vec![fd("g"), lk("b")], into(Some("h"))),
            (vec![lk("nope")], into(None)),
            (vec![fd("nope")], into(None)),
            (vec![lk("b")], into(Some("nope"))),
            (
                vec![lk("b")],
                NodeLockPlace {
                    before: Some(fd("g")),
                    ..into(None)
                },
            ),
            (
                vec![lk("b"), lk("a")],
                NodeLockPlace {
                    before: Some(lk("a")),
                    ..into(None)
                },
            ),
            (
                vec![lk("b")],
                NodeLockPlace {
                    after: Some(lk("a1")),
                    ..into(None)
                },
            ),
            (Vec::new(), into(None)),
        ];
        for (items, to) in cases {
            assert!(
                !writer
                    .move_node_locks(items.clone(), to.clone(), 9)
                    .expect("move"),
                "{items:?} -> {to:?}"
            );
            assert_eq!(snapshot(&store), before, "{items:?} -> {to:?}");
        }
        // A folder can go up, out of its parent.
        assert!(
            writer
                .move_node_locks(vec![fd("h")], into(None), 9)
                .expect("up")
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleting a lock takes its whole branch (a solving one too); its
    /// parent and siblings stay.
    #[test]
    fn delete_with_descendants() {
        let dir = scratch("branches");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock(lock("a", "AcTc6d", NodeLockStatus::Solved), 1)
            .expect("a");
        writer.save_node_lock(child("b", "a"), 1).expect("b");
        writer
            .save_node_lock(
                NodeLockRow {
                    status: NodeLockStatus::Solving,
                    ..child("c", "b")
                },
                1,
            )
            .expect("c");
        writer.save_node_lock(child("d", "c"), 1).expect("d");
        writer.save_node_lock(child("e", "a"), 1).expect("e");
        writer
            .save_node_lock(lock("z", "AcTc6d", NodeLockStatus::Solved), 1)
            .expect("z");

        let preview = store
            .reader()
            .node_lock_delete_preview(vec!["b".into(), "d".into()], Vec::new())
            .expect("preview");
        assert_eq!(
            preview,
            NodeLockDeletePreview {
                folders: 0,
                locks: 1,
                descendants: 2
            }
        );
        assert_eq!(
            writer
                .delete_node_locks(vec!["b".into(), "d".into(), "nope".into()])
                .expect("delete"),
            3
        );
        assert_eq!(ids(&store), ["a", "e", "z"]);
        assert_eq!(writer.delete_node_locks(vec!["a".into()]).expect("a"), 2);
        assert_eq!(ids(&store), ["z"]);
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleting a folder takes its subfolders, every lock in them and their
    /// branches; the preview counts the same, without changing anything.
    #[test]
    fn folder_delete_cascade_and_preview() {
        let dir = scratch("folder-delete");
        let store = Store::open(dir.join(crate::FILE_NAME)).expect("store");
        let writer = store.writer().expect("writer");
        writer
            .save_node_lock_folder(folder("f1", None), 1)
            .expect("f1");
        writer
            .save_node_lock_folder(folder("f2", Some("f1")), 1)
            .expect("f2");
        writer
            .save_node_lock_folder(folder("f3", None), 1)
            .expect("f3");
        let in_folder = |id: &str, folder: &str| NodeLockRow {
            folder_id: Some(folder.to_owned()),
            ..lock(id, "AcTc6d", NodeLockStatus::Solved)
        };
        writer.save_node_lock(in_folder("x", "f1"), 1).expect("x");
        writer.save_node_lock(child("y", "x"), 1).expect("y");
        writer.save_node_lock(child("y1", "y"), 1).expect("y1");
        writer.save_node_lock(in_folder("z", "f2"), 1).expect("z");
        writer.save_node_lock(in_folder("k", "f3"), 1).expect("k");
        writer
            .save_node_lock(lock("w", "AcTc6d", NodeLockStatus::Solved), 1)
            .expect("w");

        let reader = store.reader();
        assert_eq!(
            reader
                .node_lock_delete_preview(vec!["w".into()], vec!["f1".into()])
                .expect("preview"),
            NodeLockDeletePreview {
                folders: 2,
                locks: 3,
                descendants: 2
            }
        );
        assert_eq!(
            reader
                .node_lock_delete_preview(vec!["y".into(), "x".into()], vec!["nope".into()])
                .expect("preview"),
            NodeLockDeletePreview {
                folders: 0,
                locks: 1,
                descendants: 2
            }
        );
        assert_eq!(
            reader
                .node_lock_delete_preview(Vec::new(), Vec::new())
                .expect("none"),
            NodeLockDeletePreview::default()
        );
        assert_eq!(ids(&store).len(), 6, "a preview deletes nothing");

        assert_eq!(
            writer
                .delete_node_lock_folders(vec!["f1".into(), "f2".into(), "nope".into()])
                .expect("delete"),
            NodeLockDeleted {
                folders: 2,
                locks: 4
            }
        );
        assert_eq!(ids(&store), ["k", "w"]);
        let left: Vec<String> = reader
            .node_lock_folders()
            .expect("folders")
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(left, ["f3"]);
        assert_eq!(
            writer.delete_node_lock_folders(Vec::new()).expect("none"),
            NodeLockDeleted::default()
        );
        drop(writer);
        store.close();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
