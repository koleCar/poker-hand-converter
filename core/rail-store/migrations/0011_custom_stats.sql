-- rail-store schema, version 11 (docs/RAIL-PLAN.md R2.10): the user's own
-- statistics and their counters.
--
-- - `custom_stats`: one row per statistic the user made in the editor - its
--   R2.4 definition (`definition`, JSON: id, labels, formula, format,
--   sample, bands) and, for one with a counter of its own, the predicate
--   over decision events (`rail_stats::custom`, docs/STATS-SPEC.md §14).
--   `stat_key` is the definition's id (formulas name its counters
--   `<stat_key>` and `<stat_key>_opp`); `id` never changes and is never
--   reused (AUTOINCREMENT), so a rename keeps the counts and a page computed
--   for a deleted statistic cannot land on a new one. `rev` changes with
--   the predicate: what was counted under another `rev` is gone.
--   `counted_to` is the `hand_stats.id` the background pass has counted the
--   predicate up to (it counts every hand in `hand_stats` id order; an
--   import only wakes it).
-- - `custom_hero_rows`: the hero's counts per hand (where the opportunity
--   count is not 0): a report's partial days, as the seat rows are for the
--   coded counters.
-- - `custom_hero_rollups`: the hero's counts per (segment, position, UTC
--   day, kind), as `hero_rollups`.
-- - `custom_player_rollups`: every kept seat's counts per (site, player,
--   scope, segment), bomb pots left out, as `player_rollups` - what the HUD
--   (R3.9) reads.
--
-- No foreign keys: the counts are cleared explicitly (a statistic deleted
-- or its predicate changed; every statistic when the coded statistics
-- rebuild, which gives the hands new `hand_stats` ids, or when
-- `rail_stats::custom::EVENTS_VERSION` changes - `kv`
-- `custom.events_version`).

CREATE TABLE custom_stats (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  stat_key    TEXT    NOT NULL UNIQUE,
  rev         INTEGER NOT NULL,
  definition  TEXT    NOT NULL,
  predicate   TEXT,
  ord         INTEGER NOT NULL,
  counted_to  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE custom_hero_rows (
  stat_id INTEGER NOT NULL,
  hand_id INTEGER NOT NULL,
  made    INTEGER NOT NULL,
  opp     INTEGER NOT NULL,
  PRIMARY KEY (stat_id, hand_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE custom_hero_rollups (
  stat_id    INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  position   TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  kind       INTEGER NOT NULL,
  made       INTEGER NOT NULL,
  opp        INTEGER NOT NULL,
  PRIMARY KEY (stat_id, segment_id, position, day, kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE custom_player_rollups (
  stat_id    INTEGER NOT NULL,
  site       TEXT    NOT NULL,
  player     TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  segment_id INTEGER NOT NULL,
  made       INTEGER NOT NULL,
  opp        INTEGER NOT NULL,
  PRIMARY KEY (stat_id, site, player, scope, segment_id)
) STRICT, WITHOUT ROWID;
