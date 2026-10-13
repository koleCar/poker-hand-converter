-- rail-store schema, version 1 (docs/RAIL-PLAN.md §3.4, R1.2).
--
-- Every table and column is described in ../SCHEMA.md. Conventions:
-- STRICT tables; times are INTEGER milliseconds since the Unix epoch (UTC);
-- byte sizes and offsets are INTEGER bytes; booleans are 0 / 1.
--
-- Forward-only: a released migration is never edited. A change is a new
-- file, appended to MIGRATIONS in src/migrate.rs.

-- Small settings and cursors: sync cursors, the consent answer, and the
-- like. The schema version is not here: it is `PRAGMA user_version`.
CREATE TABLE kv (
  key        TEXT    NOT NULL PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Watched folders (R1.3 / R1.5 fill this; R1.2 only creates it).
CREATE TABLE sources (
  id            INTEGER NOT NULL PRIMARY KEY,
  path          TEXT    NOT NULL UNIQUE,
  site_override TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  recursive     INTEGER NOT NULL DEFAULT 1 CHECK (recursive IN (0, 1)),
  status        TEXT    NOT NULL DEFAULT 'idle',
  last_error    TEXT,
  added_at      INTEGER NOT NULL
) STRICT;

-- One row per hand-history file ever read, with how far it has been read.
-- `read_offset` advances only in the transaction that stores the hands
-- read up to it.
CREATE TABLE files (
  id             INTEGER NOT NULL PRIMARY KEY,
  path           TEXT    NOT NULL UNIQUE,
  source_id      INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  size           INTEGER NOT NULL CHECK (size >= 0),
  mtime          INTEGER,
  read_offset    INTEGER NOT NULL DEFAULT 0 CHECK (read_offset >= 0),
  encoding       TEXT,
  site           TEXT,
  last_error     TEXT,
  first_seen     INTEGER NOT NULL,
  last_import_at INTEGER
) STRICT;

CREATE INDEX files_source_idx ON files (source_id);

-- Converted hands. `phf` is the canonical PHF JSON, zstd-compressed; the
-- other columns are projections of it for lists, the HUD and sync.
CREATE TABLE hands (
  hand_key       TEXT    NOT NULL PRIMARY KEY,
  site           TEXT    NOT NULL,
  site_hand_id   TEXT    NOT NULL,
  played_at      TEXT,
  game_format    TEXT    NOT NULL,
  variant        TEXT    NOT NULL,
  limit_type     TEXT    NOT NULL,
  currency       TEXT    NOT NULL,
  small_blind    INTEGER NOT NULL,
  big_blind      INTEGER NOT NULL,
  ante           INTEGER NOT NULL,
  table_name     TEXT,
  max_seats      INTEGER NOT NULL,
  hero_seat      INTEGER,
  hero_name      TEXT,
  schema_version TEXT    NOT NULL,
  parser_id      TEXT    NOT NULL,
  parser_version TEXT    NOT NULL,
  phf            BLOB    NOT NULL,
  phf_size       INTEGER NOT NULL,
  file_id        INTEGER REFERENCES files (id) ON DELETE SET NULL,
  imported_at    INTEGER NOT NULL,
  synced_at      INTEGER
) STRICT;

CREATE INDEX hands_file_idx ON hands (file_id);
CREATE INDEX hands_imported_at_idx ON hands (imported_at);
CREATE INDEX hands_played_at_idx ON hands (played_at);

-- Chunks the core refused: what, where and why, with the raw text, so a
-- parser fix can re-run them. One row per (file, fingerprint).
CREATE TABLE quarantine (
  id                 INTEGER NOT NULL PRIMARY KEY,
  file_id            INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  read_offset        INTEGER NOT NULL,
  chunk_index        INTEGER,
  fingerprint        TEXT    NOT NULL,
  stage              TEXT    NOT NULL,
  reason             TEXT    NOT NULL,
  message            TEXT    NOT NULL,
  detected_site      TEXT,
  detection_permille INTEGER,
  parser_version     TEXT    NOT NULL,
  raw_text           TEXT    NOT NULL,
  first_seen         INTEGER NOT NULL,
  last_seen          INTEGER NOT NULL,
  UNIQUE (file_id, fingerprint)
) STRICT;

CREATE INDEX quarantine_reason_idx ON quarantine (reason);

-- The unsupported-format registry (R0.11): files no parser claims, one row
-- per fingerprint, with the consent and upload state.
CREATE TABLE unsupported (
  fingerprint        TEXT    NOT NULL PRIMARY KEY,
  header_sample      TEXT    NOT NULL,
  guessed_site       TEXT,
  confidence         INTEGER NOT NULL,
  guess_basis        TEXT,
  shape              TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,
  encoding           TEXT    NOT NULL,
  count              INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  first_seen         INTEGER NOT NULL,
  last_seen          INTEGER NOT NULL,
  consented_at       INTEGER,
  sent_at            INTEGER,
  anonymiser_version TEXT,
  CHECK (sent_at IS NULL OR (consented_at IS NOT NULL AND anonymiser_version IS NOT NULL))
) STRICT;

-- Hands not yet synced to Supabase (R1.9). A hand enters in the
-- transaction that stores it and leaves when the server has it.
CREATE TABLE outbox (
  hand_key        TEXT    NOT NULL PRIMARY KEY REFERENCES hands (hand_key) ON DELETE CASCADE,
  enqueued_at     INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL
) STRICT;

CREATE INDEX outbox_due_idx ON outbox (next_attempt_at, enqueued_at);
