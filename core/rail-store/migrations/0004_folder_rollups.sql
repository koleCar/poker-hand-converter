-- rail-store schema, version 4 (docs/RAIL-PLAN.md R1.6).
--
-- Counters kept as hands arrive, so a folder's counts cost the same at a
-- million hands as at a hundred: R1.5's folder list counted hands with a
-- join per folder on every call (40 ms at 90 000 hands, growing with them),
-- and the tray and the folder cards ask every second during a backfill.
--
-- - `files.hands` / `files.quarantined`: the hands a file delivered first
--   (`hands.file_id`) and its quarantine rows. The writer adds a batch's new
--   hands in the batch's transaction; quarantine rows are counted by
--   triggers (they are inserted by imports and deleted by a reset).
-- - `source_totals`: per folder, the sums of its files' counters and their
--   number, kept by triggers on `files` - so a file that moves to another
--   folder, is detached or adopted (R1.5) takes its counts with it.
-- - `source_days`: hands a folder stored per local day ("hands today"),
--   added by the writer with the batch.

ALTER TABLE files ADD COLUMN hands INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;

UPDATE files SET
  hands       = (SELECT count(*) FROM hands h WHERE h.file_id = files.id),
  quarantined = (SELECT count(*) FROM quarantine q WHERE q.file_id = files.id);

-- The newest import of a folder's files is one index seek.
DROP INDEX files_source_idx;
CREATE INDEX files_source_idx ON files (source_id, last_import_at);

CREATE TABLE source_totals (
  source_id   INTEGER NOT NULL PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
  files       INTEGER NOT NULL DEFAULT 0,
  hands       INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO source_totals (source_id, files, hands, quarantined)
SELECT s.id,
       (SELECT count(*) FROM files f WHERE f.source_id = s.id),
       (SELECT coalesce(sum(f.hands), 0) FROM files f WHERE f.source_id = s.id),
       (SELECT coalesce(sum(f.quarantined), 0) FROM files f WHERE f.source_id = s.id)
FROM sources s;

CREATE TABLE source_days (
  source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  -- The local date of the import, `YYYY-MM-DD` (SQLite's `localtime`).
  day       TEXT    NOT NULL,
  hands     INTEGER NOT NULL,
  PRIMARY KEY (source_id, day)
) STRICT, WITHOUT ROWID;

INSERT INTO source_days (source_id, day, hands)
SELECT f.source_id, date(h.imported_at / 1000, 'unixepoch', 'localtime'), count(*)
FROM hands h JOIN files f ON f.id = h.file_id
WHERE f.source_id IS NOT NULL
GROUP BY 1, 2;

CREATE TRIGGER sources_totals_row AFTER INSERT ON sources BEGIN
  INSERT INTO source_totals (source_id) VALUES (new.id);
END;

CREATE TRIGGER files_totals_insert AFTER INSERT ON files
WHEN new.source_id IS NOT NULL BEGIN
  UPDATE source_totals
     SET files = files + 1, hands = hands + new.hands,
         quarantined = quarantined + new.quarantined
   WHERE source_id = new.source_id;
END;

CREATE TRIGGER files_totals_delete AFTER DELETE ON files
WHEN old.source_id IS NOT NULL BEGIN
  UPDATE source_totals
     SET files = files - 1, hands = hands - old.hands,
         quarantined = quarantined - old.quarantined
   WHERE source_id = old.source_id;
END;

CREATE TRIGGER files_totals_update AFTER UPDATE OF source_id, hands, quarantined ON files
WHEN old.source_id IS NOT new.source_id OR old.hands <> new.hands
  OR old.quarantined <> new.quarantined BEGIN
  UPDATE source_totals
     SET files = files - 1, hands = hands - old.hands,
         quarantined = quarantined - old.quarantined
   WHERE source_id = old.source_id;
  UPDATE source_totals
     SET files = files + 1, hands = hands + new.hands,
         quarantined = quarantined + new.quarantined
   WHERE source_id = new.source_id;
END;

CREATE TRIGGER quarantine_count_insert AFTER INSERT ON quarantine BEGIN
  UPDATE files SET quarantined = quarantined + 1 WHERE id = new.file_id;
END;

CREATE TRIGGER quarantine_count_delete AFTER DELETE ON quarantine BEGIN
  UPDATE files SET quarantined = quarantined - 1 WHERE id = old.file_id;
END;
