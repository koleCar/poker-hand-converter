-- ===========================================================================
-- Hand analysis, phase A6: leaks and progress
-- ===========================================================================
--
-- `docs/ANALYSIS-PLAN.md` §0.1 (*Stats*), §2 (scores), §6.0 (*Leaks*, the
-- score trend), §6.3 and §7 (A6). Since A2b and A4 every graded decision is
-- stored with its grade, its EV loss in bb and in % of the pot, its score and
-- its options (each with a frequency and an EV). That is everything a leak
-- finder and a progress chart need from the database: **sums over graded
-- decisions**, split by spot and by time. What a spot *is* -- which rows make
-- one leak, when a thin spot merges into its parent, how two periods compare
-- -- is `frontend/src/lib/analysis/leaks.ts`, pure and tested. Semantics in
-- TypeScript, arithmetic in SQL, the split `docs/STATS-SPEC.md` §1 argues for.
--
--   analysis_best_action        helper: the action of the option with the
--                               highest EV (ties: higher frequency, then the
--                               first listed) -- "what the reference does".
--   analysis_spot_key           helper: the finest spot a decision belongs to,
--                               `street|scenario|line|position|taken|best`, as
--                               one string, so the list and its hands can never
--                               disagree about membership.
--   analysis_graded_decisions   helper: the graded decisions in the caller's
--                               filtered scope, with the hand's date, seat and
--                               pot type and the decision's spot. Every report
--                               below reads through it.
--   analysis_graded_facets      helper: the rooms, stakes and dates the filter
--                               bar offers (unfiltered but for the version).
--   analysis_leaks              per finest spot: decisions, how many were not
--                               Perfect, how many Inaccurate or worse, EV lost
--                               (bb and pot), score sum and sum of squares (the
--                               client derives means and standard errors);
--                               graded hands in scope; first and last date; the
--                               filter facets.
--   analysis_leak_hands         one page of the decisions at a set of finest
--                               spots, costliest first, each with its hand.
--   analysis_trend              the same sums per time bucket (ISO week, month,
--                               or session -- the statistics screen's 30-minute
--                               gap) and optionally per street, seat or pot
--                               type, with the bucket's graded hands.
--
-- No table, no column, no index: A1 shaped `decision_analysis` so that the
-- reports would need none. `analysis_version` scoping comes from
-- `analysis_scope`, which every report reads through: a report never mixes
-- versions, and the client always says which one it reads.
--
-- ## The security model, unchanged (`20261228090000_analysis.sql`)
--
--   * No grant on any table moves: `select` to `authenticated` under RLS,
--     nothing to `anon`, no client INSERT / UPDATE / DELETE.
--   * Every function here is a read: `security invoker`, so RLS scopes every
--     row it sums, `search_path = ''`, everything schema-qualified.
--   * The helpers the reports call are granted to `authenticated` (and not to
--     `anon`), because an invoker function runs its helpers as its caller --
--     the lesson of `20261109090000`.
--   * Spot keys, buckets, groups and sorts are validated against fixed shapes
--     and whitelists; nothing from the client is ever a column name or SQL text.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------

-- The reference's choice at a graded decision: the option worth the most
-- (EV loss is measured from it, §1), ties broken by the reference's own
-- frequency and then by the order the options were stored in.
create or replace function public.analysis_best_action(p_options jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when p_options is null or jsonb_typeof(p_options) <> 'array' then null
           else (
             select o ->> 'action'
             from jsonb_array_elements(p_options) with ordinality as t(o, i)
             where jsonb_typeof(o) = 'object'
               and o ->> 'action' in ('fold', 'check', 'call', 'bet', 'raise')
             order by case when jsonb_typeof(o -> 'ev') = 'number' then (o ->> 'ev')::numeric end desc nulls last,
                      case when jsonb_typeof(o -> 'freq') = 'number' then (o ->> 'freq')::numeric end desc nulls last,
                      t.i
             limit 1)
         end;
$$;

comment on function public.analysis_best_action(jsonb) is
  'The action of a graded decision''s highest-EV option (ties: higher frequency, then first listed); '
  'null when there are no options.';

revoke all on function public.analysis_best_action(jsonb) from public, anon;
grant execute on function public.analysis_best_action(jsonb) to authenticated;

-- One string per finest spot. `|` cannot occur in any part: streets,
-- scenarios and actions are lower-case words, a chart line is `[fkcra]*`, a
-- seat is `[A-Z0-9+]*` (checked by `analysis_leak_hands` on the way in).
create or replace function public.analysis_spot_key(
  p_street   text,
  p_scenario text,
  p_line     text,
  p_position text,
  p_taken    text,
  p_best     text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_street, '') || '|' || coalesce(p_scenario, '') || '|' || coalesce(p_line, '') || '|'
      || coalesce(p_position, '') || '|' || coalesce(p_taken, '') || '|' || coalesce(p_best, '');
$$;

comment on function public.analysis_spot_key(text, text, text, text, text, text) is
  'The finest leak spot a decision belongs to: street|scenario|chart line|seat|action taken|best action.';

revoke all on function public.analysis_spot_key(text, text, text, text, text, text) from public, anon;
grant execute on function public.analysis_spot_key(text, text, text, text, text, text) to authenticated;

-- The graded decisions in scope, one row each, with what the leak finder and
-- the trend group by. `position` is the decision's seat (`facts.position`),
-- falling back to the hand's; `line` is the chart line for chart grades and
-- empty otherwise; `taken` is the action the hero took.
create or replace function public.analysis_graded_decisions(p_filters jsonb default '{}'::jsonb)
returns table (
  hand_id       uuid,
  ord           smallint,
  action_index  integer,
  played_at     timestamptz,
  hero_position text,
  pot_type      text,
  street        text,
  scenario      text,
  line          text,
  "position"    text,
  taken         text,
  best          text,
  spot_key      text,
  source        text,
  grade         text,
  score         numeric,
  ev_loss_bb    numeric,
  ev_loss_pot   numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select x.hand_id, x.ord, x.action_index, x.played_at, x.hero_position, x.pot_type,
         x.street, x.scenario, x.line, x.pos, x.taken, x.best,
         public.analysis_spot_key(x.street, x.scenario, x.line, x.pos, x.taken, x.best),
         x.source, x.grade, x.score, x.ev_loss_bb, x.ev_loss_pot
  from (
    select dd.hand_id,
           dd.ord,
           dd.action_index,
           h.played_at,
           h.hero_position,
           s.pot_type,
           dd.street,
           dd.scenario,
           case when dd.source = 'chart' and coalesce(dd.facts -> 'chart' ->> 'line', '') ~ '^[fkcra]{0,24}$'
                then coalesce(dd.facts -> 'chart' ->> 'line', '') else '' end as line,
           case when coalesce(dd.facts ->> 'position', h.hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
                then coalesce(dd.facts ->> 'position', h.hero_position, '') else '' end as pos,
           dd.action as taken,
           coalesce(public.analysis_best_action(dd.options), '') as best,
           dd.source,
           dd.grade,
           dd.score,
           coalesce(dd.ev_loss_bb, 0) as ev_loss_bb,
           coalesce(dd.ev_loss_pot, 0) as ev_loss_pot
    from public.analysis_scope(p_filters) s
    join public.decision_analysis dd on dd.hand_id = s.hand_id and dd.analysis_version = s.analysis_version
    join public.hands h on h.id = s.hand_id
    where dd.grade is not null
  ) x;
$$;

comment on function public.analysis_graded_decisions(jsonb) is
  'The caller''s graded decisions in the filtered analysis scope, with date, seat, pot type and '
  'finest leak spot. Shared by the A6 reports; invoker, so RLS applies.';

revoke all on function public.analysis_graded_decisions(jsonb) from public, anon;
grant execute on function public.analysis_graded_decisions(jsonb) to authenticated;

-- What the filter bar can offer: the rooms, stakes and dates of the caller's
-- hands with a graded decision at one version, whatever else is filtered.
create or replace function public.analysis_graded_facets(p_version text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with f as materialized (
    select h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.played_at
    from public.hand_analysis a
    join public.hands h on h.id = a.hand_id
    where a.owner_id = (select auth.uid())
      and a.analysis_version = p_version
      and exists (
        select 1 from public.decision_analysis dd
        where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version and dd.grade is not null)
  )
  select jsonb_build_object(
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
    'last',  (select max(played_at) from f));
$$;

comment on function public.analysis_graded_facets(text) is
  'Filter facets for the A6 reports: rooms, stakes, first and last date of the caller''s hands with a '
  'graded decision at one version. Invoker.';

revoke all on function public.analysis_graded_facets(text) from public, anon;
grant execute on function public.analysis_graded_facets(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. analysis_leaks
-- ---------------------------------------------------------------------------
--
-- Takes the filters every analysis report takes (`analysis_scope`). Returns
--
--   { analysisVersion, hands, graded, first, last,
--     rows: [{ key, street, scenario, line, position, taken, best, decisions,
--              hands, nonPerfect, mistakes, evLossBb, evLossPot, scoreSum,
--              scoreSq }],
--     facets: { sites: [{ site, hands }],
--               stakes: [{ currency, currencyMinorUnits, smallBlind, bigBlind, hands }],
--               first, last } }
--
-- `hands` is the graded hands in scope (the denominator of "per 100 hands");
-- `rows` cover **every** graded decision, Perfect ones included, because a
-- spot's frequency is how often the player was there, not how often they
-- erred. `mistakes` are Inaccurate or worse. `facets` ignore every filter but
-- the version, as in `analysis_node_actions`.

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

  with g as materialized (select * from public.analysis_graded_decisions(p_filters))
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',  (select count(distinct hand_id) from g),
    'graded', (select count(*) from g),
    'first',  (select min(played_at) from g),
    'last',   (select max(played_at) from g),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key',        x.spot_key,
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
             order by x.spot_key)
      from (
        select g.spot_key, g.street, g.scenario, g.line, g."position" as pos, g.taken, g.best,
               count(*) as n,
               count(distinct g.hand_id) as hands,
               count(*) filter (where g.grade <> 'perfect') as non_perfect,
               count(*) filter (where public.analysis_grade_rank(g.grade) >= 3) as mistakes,
               round(sum(g.ev_loss_bb), 3) as ev_bb,
               round(sum(g.ev_loss_pot), 4) as ev_pot,
               round(coalesce(sum(g.score), 0), 2) as score_sum,
               round(coalesce(sum(g.score * g.score), 0), 2) as score_sq
        from g
        group by g.spot_key, g.street, g.scenario, g.line, g."position", g.taken, g.best
      ) x), '[]'::jsonb),
    'facets', public.analysis_graded_facets(v_version)
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.analysis_leaks(jsonb) is
  'Sums for the leak finder: per finest spot (street, scenario, chart line, seat, action taken, best '
  'action) the graded decisions, mistakes, EV lost and score sums; graded hands; the filter facets. '
  'Invoker; RLS scopes every row.';

revoke all on function public.analysis_leaks(jsonb) from public, anon;
grant execute on function public.analysis_leaks(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. analysis_leak_hands
-- ---------------------------------------------------------------------------
--
-- The decisions behind a leak: graded decisions whose finest spot is one of
-- `p_keys` (as `analysis_leaks` returned them), by default only those graded
-- worse than Perfect (`p_deviations`), one page at a time.
--
-- Sorts: `ev_loss` (bb, the default), `ev_loss_pot`, `recent`, `oldest`.
-- Returns { total, limit, offset, sort, rows: [{ handId, ord, actionIndex,
-- playedAt, site, stakesLabel, position, heroCards, handClass, street,
-- scenario, line, taken, best, source, grade, evLossBb, evLossPot, options,
-- chosen }] }.

create or replace function public.analysis_leak_hands(
  p_filters    jsonb   default '{}'::jsonb,
  p_keys       text[]  default null,
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
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 500 then
    raise exception 'analysis_leak_hands needs between 1 and 500 spot keys.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_keys) k
    where k is null
       or k !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$'
  ) then
    raise exception 'Not a spot key.' using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  with m as materialized (
    select g.*
    from public.analysis_graded_decisions(p_filters) g
    where g.spot_key = any (p_keys)
      and (not v_dev or g.grade <> 'perfect')
  ),
  page as (
    select
      row_number() over (
        order by
          case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
          case when v_sort = 'oldest' then m.played_at end asc nulls last,
          m.played_at desc nulls last,
          m.hand_id,
          m.ord
      ) as rn,
      m.hand_id,
      m.ord,
      jsonb_build_object(
        'handId',      m.hand_id,
        'ord',         m.ord,
        'actionIndex', m.action_index,
        'playedAt',    m.played_at,
        'site',        h.site,
        'stakesLabel', h.stakes_label,
        'position',    m."position",
        'heroCards',   to_jsonb(h.hero_cards),
        'street',      m.street,
        'scenario',    m.scenario,
        'line',        m.line,
        'taken',       m.taken,
        'best',        m.best,
        'source',      m.source,
        'grade',       m.grade,
        'evLossBb',    m.ev_loss_bb,
        'evLossPot',   m.ev_loss_pot
      ) as base
    from m
    join public.hands h on h.id = m.hand_id
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((
           select jsonb_agg(p.base || jsonb_build_object(
                    'handClass', dd.facts ->> 'handClass',
                    'options',   dd.options,
                    'chosen',    dd.chosen) order by p.rn)
           from page p
           join public.decision_analysis dd
             on dd.hand_id = p.hand_id and dd.ord = p.ord
            and dd.analysis_version = public.analysis_version_of(p_filters)), '[]'::jsonb)
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

comment on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) is
  'One page of the caller''s graded decisions at the given leak spots (by default only those worse '
  'than Perfect), with their hands, costliest first. Invoker.';

revoke all on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) from public, anon;
grant execute on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. analysis_trend
-- ---------------------------------------------------------------------------
--
-- The graded decisions in scope, summed per time bucket and, optionally, per
-- group:
--
--   p_bucket       `week` (ISO, Monday 00:00 UTC), `month` (UTC), or
--                  `session`: hands at most `p_gap_minutes` apart (default
--                  30, clamped to 5..720) are one session, across tables --
--                  the rule `stats_sessions` uses, applied to every analysed
--                  hand in scope (graded or not), so a session is the stretch
--                  the player actually sat, not only its graded part.
--   p_group        `all` (one row per bucket), `street`, `position` (the
--                  hand's seat), or `pot_type`.
--
-- Returns { analysisVersion, bucket, group, gapMinutes, rows: [{ start, end,
-- first, last, key, bucketHands, hands, graded, nonPerfect, mistakes,
-- grades: {perfect..blunder}, evLossBb, evLossPot, scoreSum, scoreSq }],
-- facets }, oldest bucket first. `bucketHands` is every graded hand in the bucket
-- (whatever the group), for "per 100 hands" by street. Hands without a date
-- are left out: they belong to no bucket.

create or replace function public.analysis_trend(
  p_filters     jsonb   default '{}'::jsonb,
  p_bucket      text    default 'week',
  p_group       text    default 'all',
  p_gap_minutes integer default 30
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_version text := public.analysis_version_of(p_filters);
  v_bucket  text := coalesce(p_bucket, 'week');
  v_group   text := coalesce(p_group, 'all');
  v_minutes integer := least(greatest(coalesce(p_gap_minutes, 30), 5), 720);
  v_gap     interval;
  v_rows    jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_bucket not in ('week', 'month', 'session') then
    raise exception 'Unknown trend bucket: %', v_bucket using errcode = '22023';
  end if;
  if v_group not in ('all', 'street', 'position', 'pot_type') then
    raise exception 'Unknown trend group: %', v_group using errcode = '22023';
  end if;
  v_gap := make_interval(mins => v_minutes);

  with g as materialized (
    select * from public.analysis_graded_decisions(p_filters) where played_at is not null
  ),
  -- Sessions, over every dated hand in scope. Only built when asked for.
  hs as (
    select s.hand_id, h.played_at
    from public.analysis_scope(p_filters) s
    join public.hands h on h.id = s.hand_id
    where v_bucket = 'session' and h.played_at is not null
  ),
  marked as (
    select hs.*,
           case when lag(hs.played_at) over w is null or hs.played_at - lag(hs.played_at) over w > v_gap
                then 1 else 0 end as starts
    from hs
    window w as (order by hs.played_at, hs.hand_id)
  ),
  numbered as (
    select m.hand_id, m.played_at,
           sum(m.starts) over (order by m.played_at, m.hand_id rows unbounded preceding) as session
    from marked m
  ),
  sessions as (
    select n.hand_id, n.session,
           min(n.played_at) over (partition by n.session) as started_at,
           max(n.played_at) over (partition by n.session) as ended_at
    from numbered n
  ),
  b as (
    select g.*,
           case v_bucket
             when 'week'  then date_trunc('week', g.played_at, 'UTC')
             when 'month' then date_trunc('month', g.played_at, 'UTC')
             else ss.started_at
           end as b_start,
           case v_bucket
             when 'week'  then date_trunc('week', g.played_at, 'UTC') + interval '7 days'
             when 'month' then (date_trunc('month', g.played_at, 'UTC') at time zone 'UTC' + interval '1 month') at time zone 'UTC'
             else ss.ended_at
           end as b_end,
           case v_group
             when 'street'   then g.street
             when 'position' then coalesce(g.hero_position, '')
             when 'pot_type' then coalesce(g.pot_type, '')
             else 'all'
           end as key
    from g
    left join sessions ss on ss.hand_id = g.hand_id
  ),
  totals as (
    select b_start, count(distinct hand_id) as bucket_hands
    from b
    group by b_start
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'start',       x.b_start,
           'end',         x.b_end,
           'first',       x.first_at,
           'last',        x.last_at,
           'key',         x.key,
           'bucketHands', t.bucket_hands,
           'hands',       x.hands,
           'graded',      x.n,
           'nonPerfect',  x.non_perfect,
           'mistakes',    x.mistakes,
           'grades', jsonb_build_object(
             'perfect',    x.g_perfect,
             'good',       x.g_good,
             'inaccurate', x.g_inaccurate,
             'mistake',    x.g_mistake,
             'blunder',    x.g_blunder),
           'evLossBb',    x.ev_bb,
           'evLossPot',   x.ev_pot,
           'scoreSum',    x.score_sum,
           'scoreSq',     x.score_sq)
         order by x.b_start, x.key), '[]'::jsonb)
    into v_rows
  from (
    select b.b_start, b.b_end, b.key,
           min(b.played_at) as first_at,
           max(b.played_at) as last_at,
           count(distinct b.hand_id) as hands,
           count(*) as n,
           count(*) filter (where b.grade <> 'perfect') as non_perfect,
           count(*) filter (where public.analysis_grade_rank(b.grade) >= 3) as mistakes,
           count(*) filter (where b.grade = 'perfect') as g_perfect,
           count(*) filter (where b.grade = 'good') as g_good,
           count(*) filter (where b.grade = 'inaccurate') as g_inaccurate,
           count(*) filter (where b.grade = 'mistake') as g_mistake,
           count(*) filter (where b.grade = 'blunder') as g_blunder,
           round(sum(b.ev_loss_bb), 3) as ev_bb,
           round(sum(b.ev_loss_pot), 4) as ev_pot,
           round(coalesce(sum(b.score), 0), 2) as score_sum,
           round(coalesce(sum(b.score * b.score), 0), 2) as score_sq
    from b
    group by b.b_start, b.b_end, b.key
  ) x
  join totals t on t.b_start = x.b_start;

  return jsonb_build_object(
    'analysisVersion', v_version,
    'bucket',          v_bucket,
    'group',           v_group,
    'gapMinutes',      v_minutes,
    'rows',            v_rows,
    'facets',          public.analysis_graded_facets(v_version)
  );
end;
$$;

comment on function public.analysis_trend(jsonb, text, text, integer) is
  'Graded decisions summed per week, month or session (and optionally per street, seat or pot type): '
  'graded hands and moves, mistakes, grade counts, EV lost, score sums. Invoker; RLS scopes every row.';

revoke all on function public.analysis_trend(jsonb, text, text, integer) from public, anon;
grant execute on function public.analysis_trend(jsonb, text, text, integer) to authenticated;

commit;
