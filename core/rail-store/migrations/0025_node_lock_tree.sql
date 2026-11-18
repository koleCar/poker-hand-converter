-- rail-store schema, version 25 (2026-11-18, docs/NODELOCK.md §7.5): the
-- My nodelocks tree.
--
-- - `node_lock_folders`: the user's folders, nested to any depth
--   (`parent_id`; NULL = top level). A new store has none.
-- - `node_locks.parent_id`: the lock this one is built on (§7.4); NULL =
--   solved on the library (a root lock). No foreign key, so a version-24
--   store opens unchanged; the writer walks it to delete a branch.
-- - `node_locks.folder_id`: the folder of a root lock (a child lock has
--   none: it sits under its parent); NULL = top level.
-- - `sort` on both: a fractional index within one list (a folder's root
--   locks and subfolders together, or one lock's children), ascending.
--   Existing rows get -`updated_at`: newest first, as the history showed
--   them.
-- - Still **never synced**.

CREATE TABLE node_lock_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES node_lock_folders(id) ON DELETE CASCADE,
  sort REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX node_lock_folders_parent ON node_lock_folders(parent_id);

ALTER TABLE node_locks ADD COLUMN folder_id TEXT;
ALTER TABLE node_locks ADD COLUMN parent_id TEXT;
ALTER TABLE node_locks ADD COLUMN sort REAL NOT NULL DEFAULT 0;
UPDATE node_locks SET sort = -updated_at;
CREATE INDEX node_locks_parent ON node_locks(parent_id);
CREATE INDEX node_locks_folder ON node_locks(folder_id);
