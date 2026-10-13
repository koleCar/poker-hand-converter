-- rail-store schema, version 5 (docs/RAIL-PLAN.md R1.9): the sync worker.
--
-- - `outbox.played_at`: the hand's `played_at`, copied when it is queued, so
--   the worker can send the hands just played first (newest played first
--   among the hands queued in the last minutes) without reading `hands`'
--   pages, which hold the compressed PHF. `outbox_recent_idx` covers that
--   query.
-- - `hands.pulled_at`: the hand came from the server (the pull, R1.9), not
--   from a file on this computer. Pulled hands are never queued for upload.
-- - `sync_rejected`: hands the server refused with a reason (or that cannot
--   be sent at all). They leave the outbox - sending them again cannot help
--   - and wait here, counted per reason in the UI, until the user asks to try
--   again (after an update).

ALTER TABLE outbox ADD COLUMN played_at TEXT;

UPDATE outbox SET played_at = (SELECT h.played_at FROM hands h WHERE h.hand_key = outbox.hand_key);

CREATE INDEX outbox_recent_idx ON outbox (enqueued_at, next_attempt_at, played_at, hand_key);

-- Hands waiting for a retry: few, counted for the status line.
CREATE INDEX outbox_retry_idx ON outbox (next_attempt_at) WHERE attempts > 0;

ALTER TABLE hands ADD COLUMN pulled_at INTEGER;

-- Pulled hands, counted (the hands an account change would not upload).
CREATE INDEX hands_pulled_idx ON hands (pulled_at) WHERE pulled_at IS NOT NULL;

CREATE TABLE sync_rejected (
  hand_key    TEXT    NOT NULL PRIMARY KEY REFERENCES hands (hand_key) ON DELETE CASCADE,
  -- The server's reason code (`shape`, `invalid`, ...) or a local one
  -- (`unreadable`, `too-large`).
  reason      TEXT    NOT NULL,
  -- For `invalid`: the column whose rule the derived row broke.
  field       TEXT,
  rejected_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sync_rejected_reason_idx ON sync_rejected (reason);
