-- Version 26: hands the user deleted (2026-11-19, the owner: delete one
-- hand, a selection, or every hand, here and on the web).
--
-- - `deleted_hands`: one row per deleted hand, by `hand_key` - the key the
--   importer dedupes by - so a watched folder read again, a manual import or
--   a pull never brings a deleted hand back. `server` = 1 while the
--   account's copy still has to be deleted (`delete_hands_by_key`; the sync
--   worker sends it and sets 0); 0 when nothing is owed (the server deleted
--   it, or told us it did).
-- - A deleted hand's derived rows go with it, and every rollup is kept
--   exact in the same transaction (`rail_store::delete`; SCHEMA.md "Deleted
--   hands").

CREATE TABLE IF NOT EXISTS deleted_hands (
  hand_key   TEXT    NOT NULL PRIMARY KEY,
  deleted_at INTEGER NOT NULL,
  server     INTEGER NOT NULL DEFAULT 0 CHECK (server IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS deleted_hands_owed_idx ON deleted_hands (deleted_at, hand_key) WHERE server = 1;
