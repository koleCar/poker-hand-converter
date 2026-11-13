-- Drop the hand indexes no reader uses (2026-11-13, database over the free
-- plan's 0.5 GB).
--
-- `pg_stat_user_indexes` on production (stats never reset) showed 0 scans for
-- all of these but `hands_site_played_idx` (10). They are the baseline's
-- global `(filter column, played_at desc)` indexes. Every reader runs under
-- RLS and filters on the owner first, so it goes through an owner-led index
-- (`hands_owner_played_idx` and its siblings) and applies the filter column as
-- a filter. This is the same reason `20270804090000` dropped the global
-- played_at/pot/profit indexes: see "Owner first" in docs/DATABASE.md.
--
-- The two `hand_stats` indexes were superseded:
-- * `hand_stats_hero_idx` by `hero_report_rows` (`20270707090000`) and
--   `hand_stats_owner_hero_cover_idx`;
-- * `hand_stats_owner_hand_key_idx` by `save_hand_stats`, which resolves
--   `hand_key` through `hands_owner_hand_key_uidx`.
--
-- Kept: the owner-led sort indexes, `hands_owner_table_idx`, and the GIN
-- indexes behind the board, hero-card, player and position searches in
-- `search_hands`. About 43 MB in all.

drop index if exists public.hands_site_played_idx;
drop index if exists public.hands_hero_played_idx;
drop index if exists public.hands_hero_position_played_idx;
drop index if exists public.hands_stakes_played_idx;
drop index if exists public.hands_class_played_idx;
drop index if exists public.hands_format_played_idx;
drop index if exists public.hands_showdown_idx;
drop index if exists public.hands_fast_fold_idx;
drop index if exists public.hands_tournament_idx;

drop index if exists public.hand_stats_hero_idx;
drop index if exists public.hand_stats_owner_hand_key_idx;
