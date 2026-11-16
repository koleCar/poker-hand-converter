//! The user's nodelocks (docs/NODELOCK.md §3, migration 24): a lock on a
//! Solver-library spot, solved on this computer and **kept here only**.
//!
//! - **Rows** ([`NodeLockRow`]): the spot, the first locked node, the lock
//!   itself (`lock_json`, the web's `LockSet`; this crate checks only that
//!   it is a JSON object), where the solve stands ([`NodeLockStatus`]) and
//!   how it ran, the list's headline numbers (`summary_json`) and the
//!   locked solve's chunk (`result`).
//! - **Writing** ([`WriterHandle::save_node_lock`]): an upsert by id that
//!   replaces the whole row, `result` included (a save without one clears
//!   it), and keeps the first save's `created_at`;
//!   [`WriterHandle::rename_node_lock`], [`WriterHandle::delete_node_locks`].
//! - **Reading**: [`Reader::node_locks`] (the history, newest change first,
//!   optionally one spot's, without the chunk) and [`Reader::node_lock`]
//!   (one row with its chunk).
//! - **At open** ([`cancel_solving`], called by [`crate::Store::open`]): a
//!   solve does not outlive the app, so a row still `solving` becomes
//!   `cancelled`.
//! - **Never synced**: nothing here marks a row dirty, and `rail-sync`
//!   reads none of it (its tests say so).

use rusqlite::{Connection, Row, params};
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
    pub fn save_node_lock(&self, row: NodeLockRow, now_ms: i64) -> Result<(i64, i64)> {
        check_row(&row)?;
        self.write(move |tx| {
            tx.execute(
                "INSERT INTO node_locks (
                   id, name, created_at, updated_at, set_id, line, flop, turn, river, street,
                   node_path, lock_json, lock_hash, preset, status, engine, threads, iterations,
                   exploitability_pct, seconds, peak_mb, summary_json, result)
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                         ?16, ?17, ?18, ?19, ?20, ?21, ?22)
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

    /// Delete the nodelocks `ids` (unknown ids are skipped), in one
    /// transaction. Returns how many went.
    pub fn delete_node_locks(&self, ids: Vec<String>) -> Result<u64> {
        self.write(move |tx| {
            let mut stmt = tx.prepare_cached("DELETE FROM node_locks WHERE id = ?1")?;
            let mut gone = 0u64;
            for id in &ids {
                gone += u64::try_from(stmt.execute([id])?).unwrap_or(0);
            }
            Ok(gone)
        })
    }
}

/// The columns every read selects (indexes 0 - 21); a read adds
/// `length(result)` (22) and, for one row, `result` (23).
const COLUMNS: &str = "id, name, created_at, updated_at, set_id, line, flop, turn, river, street,
    node_path, lock_json, lock_hash, preset, status, engine, threads, iterations,
    exploitability_pct, seconds, peak_mb, summary_json";

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
        result: if with_result { row.get(23)? } else { None },
        result_size: row.get(22)?,
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
}
