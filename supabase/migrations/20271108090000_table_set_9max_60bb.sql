-- ===========================================================================
-- Rail: the 9-max 60bb chart set in a hand's table (`analysis_hand_table_set`)
-- ===========================================================================
--
-- `charts/10` adds a chart set, `nlhe-cash-9max-60bb` (docs/CHARTS.md §6.11):
-- 7-9 handed hands at 48-72bb effective are read on it. `CHART_SETS`
-- (`web/src/lib/charts/registry.ts`) lists it between the 6-max sets and the
-- 9-max 100bb set, and `analysis_hand_table_set` must hold the same list in
-- the same order (`tests/test/studyPlanTable.test.ts`), or a flop, turn or
-- river leak row of such a hand keeps `''` while the app (`HAND_TABLE_SETS`,
-- `app/src/analysis/rows.ts`) and the desktop store (`rail_store::table_set`)
-- give it the new set.
--
-- What changes:
--
--   * `analysis_hand_table_set(phf)`: re-created as `20271102090000` wrote it,
--     with the 9-max 60bb set sixth in the set list and the 9-max
--     and heads-up sets after it renumbered. No band overlaps the new one
--     (48-72bb against 9-max 100bb's 80-120bb), so no hand another set
--     answered changes set. Still immutable, empty search_path, executable by
--     `authenticated` (the invoker scan calls it), not by `anon`.
--   * `analysis_leak_rows_table_backfill()` (`20271102090000`'s, unchanged)
--     is run again: a stored postflop leak row of a 9-max 48-72bb hand had no
--     set (`''`) and takes the new one; the account's two leak sum tables are
--     recounted. Rows that already name a set are untouched; idempotent.
--
-- Not changed: no table, grant, RLS policy or other function; no grade (the
-- new set grades from `analysis/40`, written by the clients' rebuild).
-- ===========================================================================

begin;

create or replace function public.analysis_hand_table_set(p_phf jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  with g as (
    select case when jsonb_typeof(p_phf -> 'game' -> 'bigBlind') = 'number'
                then (p_phf -> 'game' ->> 'bigBlind')::numeric end as bb,
           coalesce(p_phf -> 'game' ->> 'variant' = 'holdem' and p_phf -> 'game' ->> 'limit' = 'nl'
                    and p_phf -> 'game' ->> 'format' = 'cash', false) as cash,
           case when jsonb_typeof(p_phf -> 'players') = 'array' then p_phf -> 'players' else '[]'::jsonb end as players,
           case when jsonb_typeof(p_phf -> 'actions') = 'array' then p_phf -> 'actions' else '[]'::jsonb end as actions
  ),
  acts as (
    select a from g, jsonb_array_elements(g.actions) a where jsonb_typeof(a) = 'object'
  ),
  -- The players dealt in: the ones with a position.
  pl as (
    select p ->> 'seat' as seat,
           coalesce(p -> 'isHero' = 'true'::jsonb, false) as hero,
           case when jsonb_typeof(p -> 'startingStack') = 'number' then (p ->> 'startingStack')::numeric end as stack
    from g, jsonb_array_elements(g.players) p
    where jsonb_typeof(p) = 'object' and jsonb_typeof(p -> 'position') = 'string'
  ),
  folded as (
    select distinct a ->> 'seat' as seat from acts
    where a ->> 'street' = 'preflop' and a ->> 'type' = 'fold' and a ->> 'seat' is not null
  ),
  -- Stacks in big blinds; a stack the hand does not state reads 100bb, as the lookup's does.
  h as (
    select count(*) as k,
           count(*) filter (where pl.hero) as heroes,
           max(coalesce(pl.stack / g.bb, 100)) filter (where pl.hero) as hero_bb,
           max(coalesce(pl.stack / g.bb, 100))
             filter (where not pl.hero and not exists (select 1 from folded f where f.seat = pl.seat)) as villain_bb
    from g, pl
    where g.bb > 0
  ),
  spot as (
    select case when h.k = 2 then 2 when h.k between 3 and 6 then 6 when h.k between 7 and 9 then 9 end as seats,
           least(h.hero_bb, coalesce(h.villain_bb, h.hero_bb)) as eff
    from g, h
    where g.cash and h.heroes = 1
      and not exists (select 1 from acts where a ->> 'type' in ('straddle', 'bomb-ante'))
  ),
  -- `CHART_SETS` (registry.ts) without the straddle set, in its order: ties go to the first.
  sets (id, seats, depth, n) as (
    values ('nlhe-cash-6max-40bb', 6, 40, 1), ('nlhe-cash-6max-60bb', 6, 60, 2),
           ('nlhe-cash-6max-100bb', 6, 100, 3), ('nlhe-cash-6max-150bb', 6, 150, 4),
           ('nlhe-cash-6max-200bb', 6, 200, 5), ('nlhe-cash-9max-60bb', 9, 60, 6),
           ('nlhe-cash-9max-100bb', 9, 100, 7), ('nlhe-cash-9max-150bb', 9, 150, 8),
           ('nlhe-cash-9max-200bb', 9, 200, 9), ('nlhe-cash-hu-100bb', 2, 100, 10),
           ('nlhe-cash-hu-150bb', 2, 150, 11)
  )
  select coalesce((
    select s.id
    from spot, sets s
    where s.seats = spot.seats and abs(spot.eff - s.depth) / s.depth <= 0.2 + 1e-9
    order by abs(spot.eff - s.depth) / s.depth, s.n
    limit 1), '');
$$;

comment on function public.analysis_hand_table_set(jsonb) is
  'The chart set a hand is read on, from its PHF alone, as pickChartSet picks it (table by players dealt in, '
  'depth nearest the effective stack of the players still in at the flop, within 20%); '''' when no set answers. '
  'A postflop leak row''s chart_set (20271102090000; the 9-max 60bb set since 20271108090000).';

revoke all on function public.analysis_hand_table_set(jsonb) from public, anon;
grant execute on function public.analysis_hand_table_set(jsonb) to authenticated;

-- The postflop rows of 9-max 48-72bb hands, stored with no set, take the new one.
select public.analysis_leak_rows_table_backfill();

commit;
