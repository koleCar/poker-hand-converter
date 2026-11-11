-- rail-store schema, version 22 (2026-11-11; docs/research/TABLE-TILING.md
-- §4.5, T3): the user's table tiling and RNG settings, synced like the
-- HUD's designs.
--
-- - `hud_settings`: one settings object per (`kind`, `key`) - `tiling` (the
--   layouts, the one in force, the per-room switches) and `rng` (the range,
--   the colour bands, when it rolls), each under the key `default` today.
--   `body` is the object as JSON (`rail_hud_ipc::settings`); this crate does
--   not read it. `NULL` is a cleared row (a tombstone), as for the designs.
-- - `dirty`: written here since the last sync. The sync worker sends the
--   rows to Supabase's `hud_layouts` under the same kinds and takes the
--   account's back: **last writer wins by `updated_at`** (the writing
--   computer's clock, ms), a tie keeps what is here.
--
-- The HUD's connection never reads it: the app sends the settings over the
-- IPC (`tiling_changed`, `rng_changed`). Empty; nothing to rebuild.

CREATE TABLE hud_settings (
  kind       TEXT    NOT NULL CHECK (kind IN ('tiling', 'rng')),
  key        TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  body       TEXT    CHECK (body IS NULL OR length(body) <= 32768),
  updated_at INTEGER NOT NULL,
  dirty      INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
  PRIMARY KEY (kind, key)
) STRICT, WITHOUT ROWID;
