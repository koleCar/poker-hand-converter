-- rail-store schema, version 8 (docs/RAIL-PLAN.md R2.7b): the Today and
-- Reports screens.
--
-- The win-rate graph and the sessions walk the hero's hands in time order,
-- which is `hand_list`'s order (R2.7a): one narrow range scan instead of
-- `hand_stats` + `seat_stats` (measured at 500k hands: 0.05 s for the list
-- against 3-7 s through `hand_stats_played_idx`). What they need that the
-- list did not hold:
--
-- - `kind`: the hand's `hero_rollups` kind (bomb pot 1 | straddled 2 |
--   EV cashout 4), so a report applies `aggregate`'s exclusions (bomb pots
--   out of the statistics, an EV cashout's money out);
-- - `hero_wtsd`: the hero's `wtsd` counter (0 or 1), the web graph's split
--   into showdown and non-showdown winnings (`results.wentToShowdown`, the
--   list's `showdown`, is the hand's, not the hero's);
-- - `currency`, `minor_units`: the unit's code and minor units
--   (`hand_stats.currency`, `currency_minor_units` on the web), for the
--   web's money refusals (chips with cash: no money; two currencies: big
--   blinds only) and to print a sum.
--
-- The values come from the statistics rows, which SQL cannot read (the
-- hero's counters are a blob), so the statistics version is forgotten as
-- version 7 did: the next open rebuilds the statistics in the background
-- and the pass writes every list row again with the new columns.

ALTER TABLE hand_list ADD COLUMN kind INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hand_list ADD COLUMN hero_wtsd INTEGER NOT NULL DEFAULT 0 CHECK (hero_wtsd IN (0, 1));
ALTER TABLE hand_list ADD COLUMN currency TEXT NOT NULL DEFAULT '';
ALTER TABLE hand_list ADD COLUMN minor_units INTEGER NOT NULL DEFAULT 0;

DELETE FROM kv WHERE key = 'stats.version';
