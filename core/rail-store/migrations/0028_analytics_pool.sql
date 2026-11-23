-- rail-store schema, version 28 (docs/ANALYTICS.md Step 10): the Pool tab's
-- results per opponent, the twin of the web's `pool_players`
-- (`supabase/migrations/20271122100000_analytics_pool.sql`).
--
-- - `pool_player_results`: per (site, player, scope, segment) - the keys of
--   `player_rollups` - the opponent's seat rows in hands the hero played
--   (bomb pots and money-less hands out): `hands`, the sum of their result
--   (`net_bb_milli`) and of its square (`net_bb_sq_milli`: each hand's
--   result in big blinds squared, in thousandths, rounded - an integer sum,
--   exact and the same on every machine), so the Pool tab shows the regs'
--   win rate with a measured standard error. `hero_hands` counts the
--   hero's own seat rows under the same key, so a name the hero played under
--   is never part of the pool.
-- - `kv` `pool.counted_to`: the `hand_stats.id` the background pass
--   (`rail_store::pool::pool_step`) has summed up to. Reset with the custom
--   statistics' counts (`custom::reset_custom_counts`).
--
-- The opponents' rates come from the Analytics catalogue's rates installed
-- as custom statistics (`an_<id>`) and counted into `custom_player_rollups`
-- by the custom pass; this table holds only what that pass cannot count.
-- Empty: the background pass fills it.

CREATE TABLE pool_player_results (
  site            TEXT    NOT NULL,
  player          TEXT    NOT NULL,
  scope           TEXT    NOT NULL,
  segment_id      INTEGER NOT NULL,
  hands           INTEGER NOT NULL,
  net_bb_milli    INTEGER NOT NULL,
  net_bb_sq_milli INTEGER NOT NULL,
  hero_hands      INTEGER NOT NULL,
  PRIMARY KEY (site, player, scope, segment_id)
) STRICT, WITHOUT ROWID;
