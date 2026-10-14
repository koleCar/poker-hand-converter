-- rail-store schema, version 10 (docs/RAIL-PLAN.md, "Import writer, second
-- pass"): one index fewer for the import to keep up.
--
-- `hands_played_at_idx` (version 1) has no reader: the Hands list reads
-- `hand_list` in its own `(played_at, hand_key)` order, a date range reads
-- `hand_stats` (`hand_stats_played_idx`), and the queries on `hands` go by
-- `hand_key`, `file_id` or `imported_at`. Every imported hand still wrote an
-- entry into it, at a random place (a backfill's hands are not in time
-- order): ~7 % of the writer's time per hand, measured. `IF EXISTS`: the
-- tests that take a store back to an older version do not create it again.

DROP INDEX IF EXISTS hands_played_at_idx;
