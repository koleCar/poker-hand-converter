-- rail-store schema, version 24 (2026-11-16, docs/NODELOCK.md §3): the
-- user's nodelocks, solved on this computer and kept here only.
--
-- - One row per nodelock: the spot (`set_id`, `line`, `flop`, and `turn`,
--   `river` for a later street), the first locked node for the list, the
--   lock itself (`lock_json`, the web's `LockSet`; this crate does not read
--   it) and its `lock_hash`, where the solve stands (`status`) and how it
--   ran, the list's headline numbers (`summary_json`) and the locked
--   solve's chunk (`result`, ~100 KB).
-- - **Never synced**: `rail-sync` reads and sends none of it, and nothing
--   marks it dirty.
-- - A row still `solving` when the store opens was cut off by the app's
--   exit: `Store::open` makes it `cancelled` (`node_locks::cancel_solving`).
--
-- Empty; nothing to rebuild.

CREATE TABLE node_locks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  set_id TEXT NOT NULL, line TEXT NOT NULL, flop TEXT NOT NULL, turn TEXT, river TEXT,
  street TEXT NOT NULL CHECK (street IN ('flop','turn','river')),
  node_path TEXT NOT NULL,
  lock_json TEXT NOT NULL,
  lock_hash TEXT NOT NULL,
  preset TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','solving','solved','failed','cancelled')),
  engine TEXT, threads INTEGER, iterations INTEGER, exploitability_pct REAL, seconds REAL, peak_mb REAL,
  summary_json TEXT,
  result BLOB
);
CREATE INDEX node_locks_updated ON node_locks(updated_at DESC);
CREATE INDEX node_locks_spot ON node_locks(set_id, line, flop);
