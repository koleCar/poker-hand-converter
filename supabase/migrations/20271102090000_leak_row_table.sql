-- ===========================================================================
-- Rail: postflop leak rows carry their hand's table (`analysis_leak_rows.chart_set`)
-- ===========================================================================
--
-- A leak row's `chart_set` (`analysis_leak_chart_set`, R5.2) is the chart set
-- a preflop chart grade names (`facts.chart.set`) and `''` for everything
-- else, so a flop, turn or river leak did not say which table it was played
-- at. The study plan could not tell a heads-up river or flop leak from a
-- 6-max one: a heads-up big-blind leak was dealt on 6-max trainer lines, and
-- the flop mapping guessed the table (`docs/ANALYSIS-PLAN.md` §10, 2026-10-28
-- and 2026-10-31).
--
-- What changes:
--
--   * `analysis_hand_table_set(phf)`: the chart set a hand is read on, from
--     the hand alone, as `pickChartSet` (`web/src/lib/charts/registry.ts`)
--     picks it for the hero's last preflop decision: the table by the players
--     dealt in (2: heads-up, 3-6: 6-max, 7-9: 9-max), the depth nearest the
--     effective stack (the hero against the deepest opponent who did not fold
--     preflop: the players still in at the flop), within 20%. `''` for a hand
--     no set answers: not NLHE cash, a straddle or a bomb pot, ten or more
--     players, no hero or no big blind, or a depth outside every set's band. The
--     sets are `CHART_SETS` without the straddle set (a test keeps the two
--     lists equal). Immutable, reads nothing but its argument.
--   * A row trigger (`analysis_leak_rows_table_set`, before insert, only for
--     a postflop row with no set) fills `chart_set` from the hand's PHF. The
--     summary triggers (`analysis_leak_rows_on_insert`, `20270825090000`) sum
--     what the insert returns, and the rebuild sums the table, so the leak
--     sums (`analysis_leak_totals`, `analysis_leak_stake_totals`) and the
--     trigger / rebuild agreement are unchanged; neither function is
--     re-created. Preflop rows are untouched (`analysis_leak_chart_set` is
--     unchanged): a preflop chart grade keeps the set it names, and a preflop
--     decision off the charts keeps `''`.
--   * `analysis_leaks_scan` (the leak list under the hand-list filters,
--     `20270825090000`'s, the last definition) reads the same set for a
--     postflop decision, so it still answers what the summaries answer. It is
--     re-created as it was otherwise; the R6.2 entitlement gate is put back
--     with `entitlement_gates_apply()`.
--   * Backfill (`analysis_leak_rows_table_backfill()`, definer, executable by
--     no client): every stored postflop leak row with no set gets its hand's,
--     and the account's two leak sum tables are recounted from its rows (as
--     `analysis_leak_summaries_rebuild` counts them), one account at a time
--     under the account's sums lock. Idempotent: a second run finds nothing
--     to set.
--
-- Not changed: no grade, no `analysis/N` (the rows are the stored grades);
-- the leak finder's ids (a postflop leak is not tagged by its table, so a
-- heads-up and a 6-max river area with the same seat, role and side are one
-- area: its trainer deals on the set most of its decisions were met on);
-- grants on every table (select-own for `authenticated`, no client write),
-- RLS. `analysis_hand_table_set` is executable by `authenticated` (the
-- invoker scan calls it; it only computes on its argument), not by `anon`;
-- the trigger function by no client role.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A hand's table
-- ---------------------------------------------------------------------------

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
           ('nlhe-cash-6max-200bb', 6, 200, 5), ('nlhe-cash-9max-100bb', 9, 100, 6),
           ('nlhe-cash-9max-150bb', 9, 150, 7), ('nlhe-cash-9max-200bb', 9, 200, 8),
           ('nlhe-cash-hu-100bb', 2, 100, 9), ('nlhe-cash-hu-150bb', 2, 150, 10)
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
  'A postflop leak row''s chart_set (20271102090000).';

revoke all on function public.analysis_hand_table_set(jsonb) from public, anon;
grant execute on function public.analysis_hand_table_set(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Postflop leak rows take it
-- ---------------------------------------------------------------------------

create or replace function public.analysis_leak_rows_table_set()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.chart_set := coalesce((
    select public.analysis_hand_table_set(h.phf)
    from public.hands h
    where h.id = new.hand_id and h.owner_id = new.owner_id), '');
  return new;
end;
$$;

comment on function public.analysis_leak_rows_table_set() is
  'Before insert on analysis_leak_rows, for a postflop row with no set: its hand''s table '
  '(analysis_hand_table_set). Definer; executable by no client.';

revoke all on function public.analysis_leak_rows_table_set() from public, anon, authenticated;

drop trigger if exists analysis_leak_rows_table_set on public.analysis_leak_rows;
create trigger analysis_leak_rows_table_set
  before insert on public.analysis_leak_rows
  for each row
  when (new.street <> 'preflop' and new.chart_set = '')
  execute function public.analysis_leak_rows_table_set();

comment on column public.analysis_leak_rows.chart_set is
  'Preflop: the chart set a chart grade names (analysis_leak_chart_set), '''' off the charts. Flop, turn, river '
  '(20271102090000): the hand''s table (analysis_hand_table_set), '''' when no set answers.';

-- ---------------------------------------------------------------------------
-- 3. The scan reads the same set
-- ---------------------------------------------------------------------------

-- `20270825090000_analysis_screen_summaries.sql`'s definition, with the
-- postflop set; everything else unchanged.
CREATE OR REPLACE FUNCTION public.analysis_leaks_scan(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;

  with g as materialized (
    select d.*,
           case when d.source = 'chart'
                 and coalesce(dd.facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
                then dd.facts -> 'chart' ->> 'set'
                -- A postflop decision: its hand's table (20271102090000), as the leak rows keep it.
                when d.street <> 'preflop'
                then nullif(public.analysis_hand_table_set(hh.phf), '') end as chart_set
    from public.analysis_graded_decisions(p_filters) d
    left join public.decision_analysis dd
      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version and dd.owner_id = v_owner
    left join public.hands hh
      on d.street <> 'preflop' and hh.id = d.hand_id and hh.owner_id = v_owner
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',  (select count(distinct hand_id) from g),
    'graded', (select count(*) from g),
    'first',  (select min(played_at) from g),
    'last',   (select max(played_at) from g),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key',        x.spot_key,
               'set',        x.chart_set,
               'street',     x.street,
               'scenario',   x.scenario,
               'line',       x.line,
               'position',   x.pos,
               'taken',      x.taken,
               'best',       x.best,
               'decisions',  x.n,
               'hands',      x.hands,
               'nonPerfect', x.non_perfect,
               'mistakes',   x.mistakes,
               'evLossBb',   x.ev_bb,
               'evLossPot',  x.ev_pot,
               'scoreSum',   x.score_sum,
               'scoreSq',    x.score_sq)
             order by x.spot_key, x.chart_set nulls first)
      from (
        select g.spot_key, g.chart_set, g.street, g.scenario, g.line, g."position" as pos, g.taken, g.best,
               count(*) as n,
               count(distinct g.hand_id) as hands,
               count(*) filter (where g.grade <> 'perfect') as non_perfect,
               count(*) filter (where public.analysis_grade_rank(g.grade) >= 3) as mistakes,
               round(sum(g.ev_loss_bb), 3) as ev_bb,
               round(sum(g.ev_loss_pot), 4) as ev_pot,
               round(coalesce(sum(g.score), 0), 2) as score_sum,
               round(coalesce(sum(g.score * g.score), 0), 2) as score_sq
        from g
        group by g.spot_key, g.chart_set, g.street, g.scenario, g.line, g."position", g.taken, g.best
      ) x), '[]'::jsonb),
    'facets', public.analysis_graded_facets(v_version)
  ) into v_out;

  return v_out;
end;
$function$;

revoke all on function public.analysis_leaks_scan(jsonb) from public, anon;
grant execute on function public.analysis_leaks_scan(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------
--
-- Per account, under its sums lock: the postflop rows with no set take their
-- hand's, then the two leak sum tables are recounted from the rows, as
-- `analysis_leak_summaries_rebuild` counts them (the other summaries do not
-- read the set). A function (definer, executable by no client) so the test
-- can run it again; it returns the rows it set.

create or replace function public.analysis_leak_rows_table_backfill()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_n     integer;
  v_all   integer := 0;
begin
  for v_owner in
    select distinct x.owner_id from public.analysis_leak_rows x
    where x.street <> 'preflop' and x.chart_set = ''
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || v_owner::text, 0));

    update public.analysis_leak_rows x
       set chart_set = s.set
      from (select h.id, public.analysis_hand_table_set(h.phf) as set
            from public.hands h
            where h.owner_id = v_owner
              and exists (select 1 from public.analysis_leak_rows y
                          where y.hand_id = h.id and y.street <> 'preflop' and y.chart_set = '')) s
     where x.owner_id = v_owner and x.hand_id = s.id and x.street <> 'preflop' and x.chart_set = '' and s.set <> '';
    get diagnostics v_n = row_count;
    v_all := v_all + v_n;
    continue when v_n = 0;

    delete from public.analysis_leak_totals where owner_id = v_owner;
    insert into public.analysis_leak_totals (
      owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, decisions, hands,
      non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, count(*),
           count(distinct hand_id), count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from public.analysis_leak_rows
    where owner_id = v_owner and grade is not null
    group by 1, 2, 3, 4, 5, 6, 7;

    delete from public.analysis_leak_stake_totals where owner_id = v_owner;
    insert into public.analysis_leak_stake_totals (
      owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, decisions, hands,
      non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, count(*),
           count(distinct hand_id), count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from public.analysis_leak_rows
    where owner_id = v_owner and grade is not null
    group by 1, 2, 3, 4, 5, 6, 7;
  end loop;
  return v_all;
end;
$$;

comment on function public.analysis_leak_rows_table_backfill() is
  'Gives every stored postflop leak row with no set its hand''s table and recounts the account''s leak sums '
  '(20271102090000). Idempotent. Definer; executable by no client.';

revoke all on function public.analysis_leak_rows_table_backfill() from public, anon, authenticated;

select public.analysis_leak_rows_table_backfill();

commit;

-- The R6.2 entitlement gate, back on the re-created scan.
select public.entitlement_gates_apply();
