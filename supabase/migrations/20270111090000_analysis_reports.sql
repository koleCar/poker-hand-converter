-- ===========================================================================
-- Hand analysis, phase A3: reports -- your frequencies against the reference
-- ===========================================================================
--
-- `docs/ANALYSIS-PLAN.md` §0.1 (*Reports*), §6.3 and §7 (A3). Since A2b every
-- hero preflop decision a chart covers is stored with the chart node it was
-- graded at (`facts.chart.set` / `facts.chart.line`), the hero's hand class
-- (`facts.handClass`) and the option it took (`options[chosen]`). That is
-- everything a "your frequency vs the reference" report needs from the
-- database: **counts**. The reference side -- the whole range's frequency at a
-- node, and the frequency for the hands the player actually held there -- is
-- chart arithmetic, done in the browser from the same chart set that graded
-- the rows (`lib/analysis/reports.ts`). Semantics in TypeScript, arithmetic
-- in SQL, the split `docs/STATS-SPEC.md` §1 argues for.
--
--   analysis_node_actions   per chart node x chosen action: decisions, how
--                           many were not Perfect, EV lost; per node x hand
--                           class x action: decisions (for the hand-adjusted
--                           reference); per postflop street x role x action:
--                           decisions (the player's own postflop frequencies,
--                           which get a reference with the flop library, A5);
--                           and the facets the filter bar offers (rooms,
--                           stakes, dates), over the whole graded library.
--   analysis_node_hands     one page of the decisions at a set of nodes --
--                           by default only the ones that were not Perfect --
--                           sorted by EV loss, each with its hand, for the
--                           report's "where you deviated" list.
--   analysis_chosen_action  helper: `options[chosen]` as a chart action name
--                           (`fold` / `check` / `call` / `raise` / `allin`).
--
-- No table, no column, no index: A1 shaped `decision_analysis` so that the
-- reports would need none. `analysis_version` scoping comes from
-- `analysis_scope`, which every report reads through: a report never mixes
-- versions, and the client always says which one it reads.
--
-- ## The security model, unchanged (`20261228090000_analysis.sql`)
--
--   * No grant on either table moves: `select` to `authenticated` under RLS,
--     nothing to `anon`, no client INSERT / UPDATE / DELETE.
--   * Both reports are reads: `security invoker`, so RLS scopes every row they
--     count, `search_path = ''`, everything schema-qualified.
--   * The helper they call is granted to `authenticated` (and not to `anon`),
--     because an invoker function runs its helpers as its caller -- the lesson
--     of `20261109090000`.
--   * Node keys, actions and sort keys are validated against fixed shapes and
--     whitelists; nothing from the client is ever a column name or SQL text.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. analysis_chosen_action
-- ---------------------------------------------------------------------------
--
-- A stored preflop option is `{action, sizeBb, freq, ev}` with `allIn: true`
-- on a chart's shove (the analysis vocabulary has no `allin` action; the
-- charts do). Reports compare against chart actions, so the shove is named as
-- the charts name it.

create or replace function public.analysis_chosen_action(p_options jsonb, p_chosen integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when p_options is null or p_chosen is null or jsonb_typeof(p_options) <> 'array'
             or p_chosen < 0 or p_chosen >= jsonb_array_length(p_options) then null
           when coalesce(p_options -> p_chosen ->> 'allIn', 'false') = 'true' then 'allin'
           else p_options -> p_chosen ->> 'action'
         end;
$$;

comment on function public.analysis_chosen_action(jsonb, integer) is
  'The option a graded decision took, as a chart action name (fold/check/call/raise/allin); '
  'null when the decision has no options or no choice.';

revoke all on function public.analysis_chosen_action(jsonb, integer) from public, anon;
grant execute on function public.analysis_chosen_action(jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. analysis_node_actions
-- ---------------------------------------------------------------------------
--
-- Takes the same filters as every analysis report (`analysis_scope`: version,
-- dates, room, stake, position, ...). Returns
--
--   { analysisVersion, hands, decisions,
--     actions:  [{ set, line, scenario, action, decisions, deviations, evLossBb }],
--     classes:  [{ set, line, handClass, action, decisions }],
--     postflop: [{ street, scenario, action, decisions }],
--     facets:   { sites: [{ site, hands }],
--                 stakes: [{ currency, currencyMinorUnits, smallBlind, bigBlind, hands }],
--                 first, last } }
--
-- `actions` and `classes` count **graded chart decisions** only: preflop,
-- `source = 'chart'`, a grade and a choice. `deviations` are the ones graded
-- worse than Perfect -- a move the reference plays within its 5% band is not
-- a deviation even when it is the less frequent half of a mix (§2).
-- `postflop` counts analysed (heads-up) postflop decisions by the role
-- scenario the engine stored (`pfr-ip-first`, `caller-oop-vs-bet`, ...).
-- `facets` ignore every filter but the version: they are what the filter bar
-- can offer, not what it has picked.

create or replace function public.analysis_node_actions(p_filters jsonb default '{}'::jsonb)
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

  with s as materialized (select * from public.analysis_scope(p_filters)),
  d as materialized (
    select dd.hand_id,
           dd.grade,
           dd.ev_loss_bb,
           dd.facts -> 'chart' ->> 'set'      as chart_set,
           dd.facts -> 'chart' ->> 'line'     as line,
           dd.facts -> 'chart' ->> 'scenario' as chart_scenario,
           dd.facts ->> 'handClass'           as hand_class,
           public.analysis_chosen_action(dd.options, dd.chosen) as chosen_action
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.street = 'preflop'
      and dd.source = 'chart'
      and dd.grade is not null
      and dd.chosen is not null
      and dd.facts -> 'chart' ->> 'line' is not null
  ),
  g as (
    select * from d where chosen_action is not null
  ),
  p as (
    select dd.street, dd.scenario, dd.action
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.street <> 'preflop' and dd.status = 'analysed'
  ),
  -- The facets: the caller's graded hands at this version, unfiltered.
  f as materialized (
    select h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.played_at
    from public.hand_analysis a
    join public.hands h on h.id = a.hand_id
    where a.owner_id = v_owner
      and a.analysis_version = v_version
      and exists (
        select 1 from public.decision_analysis dd
        where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version
          and dd.street = 'preflop' and dd.source = 'chart' and dd.grade is not null)
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',     (select count(distinct hand_id) from g),
    'decisions', (select count(*) from g),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',        x.chart_set,
               'line',       x.line,
               'scenario',   x.chart_scenario,
               'action',     x.chosen_action,
               'decisions',  x.n,
               'deviations', x.dev,
               'evLossBb',   x.ev)
             order by x.chart_set, x.line, x.chosen_action)
      from (
        select chart_set, line, chart_scenario, chosen_action,
               count(*) as n,
               count(*) filter (where grade <> 'perfect') as dev,
               round(coalesce(sum(ev_loss_bb), 0), 3) as ev
        from g
        group by chart_set, line, chart_scenario, chosen_action
      ) x), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',       x.chart_set,
               'line',      x.line,
               'handClass', x.hand_class,
               'action',    x.chosen_action,
               'decisions', x.n)
             order by x.chart_set, x.line, x.hand_class, x.chosen_action)
      from (
        select chart_set, line, hand_class, chosen_action, count(*) as n
        from g
        where hand_class is not null
        group by chart_set, line, hand_class, chosen_action
      ) x), '[]'::jsonb),
    'postflop', coalesce((
      select jsonb_agg(jsonb_build_object(
               'street',    x.street,
               'scenario',  x.scenario,
               'action',    x.action,
               'decisions', x.n)
             order by array_position(array['flop', 'turn', 'river'], x.street), x.scenario, x.action)
      from (select street, scenario, action, count(*) as n from p group by 1, 2, 3) x), '[]'::jsonb),
    'facets', jsonb_build_object(
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object('site', x.site, 'hands', x.n) order by x.n desc, x.site)
        from (select site, count(*) as n from f group by site) x), '[]'::jsonb),
      'stakes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n)
               order by x.n desc, x.currency, x.big_blind)
        from (
          select currency, currency_minor_units, small_blind, big_blind, count(*) as n
          from f
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'first', (select min(played_at) from f),
      'last',  (select max(played_at) from f))
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.analysis_node_actions(jsonb) is
  'Counts for the analysis reports: graded preflop decisions per chart node x chosen action '
  'and per node x hand class x action, postflop decisions per street x role x action, and the '
  'filter facets. Invoker; RLS scopes every row.';

revoke all on function public.analysis_node_actions(jsonb) from public, anon;
grant execute on function public.analysis_node_actions(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. analysis_node_hands
-- ---------------------------------------------------------------------------
--
-- The decisions behind a report row: graded chart decisions at any of
-- `p_nodes` (each `<set>:<line>`, the UTG open's line being empty), optionally
-- only those that took `p_action`, by default only those graded worse than
-- Perfect (`p_deviations`), one page at a time.
--
-- Sorts: `ev_loss` (bb, the default), `ev_loss_pot`, `recent`, `oldest`.
-- Returns { total, limit, offset, sort, rows: [{ handId, ord, actionIndex,
-- playedAt, site, stakesLabel, position, heroCards, handClass, set, line,
-- scenario, action, grade, evLossBb, evLossPot, inRange, options, chosen }] }.

create or replace function public.analysis_node_hands(
  p_filters    jsonb   default '{}'::jsonb,
  p_nodes      text[]  default null,
  p_action     text    default null,
  p_deviations boolean default true,
  p_sort       text    default 'ev_loss',
  p_limit      integer default 25,
  p_offset     integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner  uuid := (select auth.uid());
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_nodes is null or cardinality(p_nodes) = 0 or cardinality(p_nodes) > 200 then
    raise exception 'analysis_node_hands needs between 1 and 200 chart nodes.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_nodes) k where k is null or k !~ '^[a-z0-9][a-z0-9-]{0,63}:[fkcra]{0,24}$') then
    raise exception 'Not a chart node key.' using errcode = '22023';
  end if;
  if p_action is not null and p_action not in ('fold', 'check', 'call', 'raise', 'allin') then
    raise exception 'Unknown chart action: %', p_action using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  with s as materialized (select * from public.analysis_scope(p_filters)),
  m as materialized (
    select dd.hand_id, dd.ord, dd.action_index, dd.grade, dd.ev_loss_bb, dd.ev_loss_pot,
           dd.options, dd.chosen, dd.facts,
           public.analysis_chosen_action(dd.options, dd.chosen) as chosen_action
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.street = 'preflop'
      and dd.source = 'chart'
      and dd.grade is not null
      and dd.chosen is not null
      and ((dd.facts -> 'chart' ->> 'set') || ':' || (dd.facts -> 'chart' ->> 'line')) = any (p_nodes)
      and (p_action is null or public.analysis_chosen_action(dd.options, dd.chosen) = p_action)
      and (not v_dev or dd.grade <> 'perfect')
  ),
  page as (
    select
      row_number() over (
        order by
          case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
          case when v_sort = 'oldest' then h.played_at end asc nulls last,
          h.played_at desc nulls last,
          m.hand_id,
          m.ord
      ) as rn,
      jsonb_build_object(
        'handId',      m.hand_id,
        'ord',         m.ord,
        'actionIndex', m.action_index,
        'playedAt',    h.played_at,
        'site',        h.site,
        'stakesLabel', h.stakes_label,
        'position',    h.hero_position,
        'heroCards',   to_jsonb(h.hero_cards),
        'handClass',   m.facts ->> 'handClass',
        'set',         m.facts -> 'chart' ->> 'set',
        'line',        m.facts -> 'chart' ->> 'line',
        'scenario',    m.facts -> 'chart' ->> 'scenario',
        'inRange',     m.facts -> 'chart' -> 'inRange',
        'action',      m.chosen_action,
        'grade',       m.grade,
        'evLossBb',    m.ev_loss_bb,
        'evLossPot',   m.ev_loss_pot,
        'options',     m.options,
        'chosen',      m.chosen
      ) as row_json
    from m
    join public.hands h on h.id = m.hand_id
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((select jsonb_agg(row_json order by rn) from page), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$$;

comment on function public.analysis_node_hands(jsonb, text[], text, boolean, text, integer, integer) is
  'One page of the caller''s graded preflop decisions at the given chart nodes (by default '
  'only those worse than Perfect), with their hands; for the report''s deviation lists. Invoker.';

revoke all on function public.analysis_node_hands(jsonb, text[], text, boolean, text, integer, integer) from public, anon;
grant execute on function public.analysis_node_hands(jsonb, text[], text, boolean, text, integer, integer) to authenticated;

commit;
