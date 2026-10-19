-- rail-store schema, version 15 (docs/RAIL-PLAN.md R3.9): the HUD editor's
-- designs and where each is used, and sync for every HUD table.
--
-- - `hud_layouts`: a user's panel design (`id` the design's: `d-` and 32
--   hex digits for a user's; the shipped presets - `cash`, `mtt`, `spin`,
--   `mtt-stack` - live in `config/hud/presets.json`, never here). `design`
--   is the design as JSON (`rail_hud::design::HudDesign`: cells, columns,
--   per-statistic overrides, popup sections); `NULL` is a deleted design,
--   kept as a tombstone so a delete reaches the user's other computers.
-- - `hud_layout_assignments`: which design a table gets, per room
--   (`sites.json` id, or `*` for every room), table size (2 - 10, or 0 for
--   every size) and game format (`cash`, `mtt` - tournaments and
--   sit-and-gos -, `spin`, or `*`). The HUD takes the most specific row
--   (`rail_hud::design::Assignments::resolve`); none: the format's preset.
--   `layout_id` `NULL` is a cleared assignment (a tombstone).
-- - `hud_seat_positions` (13) gains `cleared`: a reset keeps the row as a
--   tombstone (the HUD reads `cleared = 0` only), so a reset reaches the
--   other computers too. `hud_room_settings` (13) keeps a row with
--   `preferred_seat` `NULL` for "as sites.json says" for the same reason.
-- - `dirty` on all four: written here since the last sync (the app's
--   writes set it, a pull clears it). The sync worker (R1.9's) sends the
--   dirty rows to Supabase's `hud_layouts` table and takes the account's
--   rows back: **last writer wins by `updated_at`** (ms since the epoch,
--   the writing computer's clock), a tie keeps what is here.
--
-- The HUD's connection reads these and never writes (R3.2). Rows of an older
-- store (13's positions and settings) start dirty: they were never synced.

CREATE TABLE hud_layouts (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  design     TEXT,
  updated_at INTEGER NOT NULL,
  dirty      INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE TABLE hud_layout_assignments (
  site       TEXT    NOT NULL CHECK (length(site) BETWEEN 1 AND 64),
  size       INTEGER NOT NULL CHECK (size = 0 OR size BETWEEN 2 AND 10),
  format     TEXT    NOT NULL CHECK (format IN ('*', 'cash', 'mtt', 'spin')),
  layout_id  TEXT    CHECK (layout_id IS NULL OR length(layout_id) BETWEEN 1 AND 64),
  updated_at INTEGER NOT NULL,
  dirty      INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
  PRIMARY KEY (site, size, format)
) STRICT, WITHOUT ROWID;

ALTER TABLE hud_seat_positions
  ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1));
ALTER TABLE hud_seat_positions
  ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1));
ALTER TABLE hud_room_settings
  ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1));
