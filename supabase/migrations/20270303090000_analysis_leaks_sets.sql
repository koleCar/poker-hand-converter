-- Leaks across chart sets (phase A2d, docs/ANALYSIS-PLAN.md §10).
--
-- Since A2c a preflop decision is graded on one of several chart sets (6- or
-- 9-max, 40-200bb; `facts.chart.set`). `analysis_leaks` summed per finest
-- spot - street, scenario, chart line, seat, taken, best - and a 6-max UTG
-- open and a 9-max UTG open share every one of those: the same spot key, two
-- different seats. This replaces `analysis_leaks` (same signature, same
-- grants; the body of 20270201090000_analysis_leaks.sql otherwise unchanged)
-- so that each row is one finest spot **on one chart set**, with the set's
-- id as `set` (null for decisions not graded from the charts). A spot key can
-- now head two rows, one per set; the leak finder (`lib/analysis/leaks.ts`)
-- names seats on the set's own table and links the trainer to the set the
-- player met the spot on most.
--
-- Nothing else changes: no table, no grant, no new function. Invoker, so RLS
-- scopes every row as before.

create or replace function public.analysis_leaks(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
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
                then dd.facts -> 'chart' ->> 'set' end as chart_set
    from public.analysis_graded_decisions(p_filters) d
    left join public.decision_analysis dd
      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version
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
$$;

comment on function public.analysis_leaks(jsonb) is
  'Sums for the leak finder: per finest spot (street, scenario, chart line, seat, action taken, best '
  'action) and chart set the graded decisions, mistakes, EV lost and score sums; graded hands; the '
  'filter facets. Invoker; RLS scopes every row.';

revoke all on function public.analysis_leaks(jsonb) from public, anon;
grant execute on function public.analysis_leaks(jsonb) to authenticated;
