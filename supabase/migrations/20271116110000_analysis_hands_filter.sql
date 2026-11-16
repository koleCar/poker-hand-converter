-- ============================================================================
-- The Analysis tabs over the Hands list's whole filter (2026-11-16, the
-- owner: "one filter everywhere, app and web").
-- ============================================================================
--
-- The web's Analysis tabs (Reports, Leaks, Progress) filtered by one room,
-- one stake, one seat and a date range. They now take the Hands list's
-- filter row, sent as `p_filters.hands` (the list's own keys, read by
-- `library_where`), beside the kind of game and the analysis version.
--
-- * `analysis_hand_ids` - the reader's hands of `p_filters.hands` (null
--   when it sets no group).
-- * `analysis_filter` gains `hands`, set by `analysis_filter_of`.
-- * The readers' summary paths (whole-library totals, the trend's days)
--   are taken only without a hand list (`analysis_filter_sums_ok` and each
--   reader's own guard); their per-hand paths (`analysis_leak_rows`,
--   `analysis_hand_rows`) and the scans (`analysis_scope`) keep only the
--   listed hands. Without `hands` every plan and answer is as before.

alter type public.analysis_filter add attribute hands uuid[];

create or replace function public.analysis_hand_ids(p_filters jsonb)
returns uuid[]
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $fn$
declare
  v_owner  uuid  := (select auth.uid());
  v_filter jsonb := case when jsonb_typeof(p_filters -> 'hands') = 'object' then p_filters -> 'hands' else '{}'::jsonb end;
  v_where  text  := public.library_where(v_filter);
  v_ids    uuid[];
begin
  if v_owner is null or v_where = '' then
    return null;
  end if;
  execute format($q$
    select coalesce(array_agg(h.id), '{}'::uuid[])
    from public.hands h
    left join public.hand_stats hs
      on hs.hand_id = h.id and hs.owner_id = $4 and hs.is_hero
     and hs.stats_version = coalesce(nullif(btrim(coalesce($1 ->> 'statsVersion', '')), ''), 'stats/1')
    left join public.hand_stats_ev e
      on e.hand_id = h.id and e.owner_id = $4 and e.seat = hs.seat
     and e.ev_version = coalesce(nullif(btrim(coalesce($1 ->> 'evVersion', '')), ''), 'ev/1')
    where h.owner_id = $4%s
  $q$, v_where)
  into v_ids
  using v_filter, null::jsonb, null::integer, v_owner;
  return v_ids;
end;
$fn$;

comment on function public.analysis_hand_ids(jsonb) is
  'The reader''s hands of the Hands list''s filter an analysis reader is given as `hands` (library_where); null when it sets no group.';

revoke all on function public.analysis_hand_ids(jsonb) from public, anon;
grant execute on function public.analysis_hand_ids(jsonb) to authenticated;

-- analysis_filter_of: as in 20271104090000_game_kind_filter.sql, with the hand list.
create or replace function public.analysis_filter_of(p_filters jsonb)
returns public.analysis_filter
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.analysis_filter;
begin
  v.version := public.analysis_version_of(p_filters);
  v.grade := nullif(btrim(coalesce(p_filters ->> 'grade', '')), '');
  v.min_grade := nullif(btrim(coalesce(p_filters ->> 'minGrade', '')), '');
  if v.grade is not null and public.analysis_grade_rank(v.grade) is null then
    raise exception 'Unknown grade: %', v.grade using errcode = '22023';
  end if;
  if v.min_grade is not null and public.analysis_grade_rank(v.min_grade) is null then
    raise exception 'Unknown grade: %', v.min_grade using errcode = '22023';
  end if;
  v.from_at := (nullif(p_filters ->> 'from', ''))::timestamptz;
  v.to_at := (nullif(p_filters ->> 'to', ''))::timestamptz;
  v.site := lower(btrim(nullif(p_filters ->> 'site', '')));
  v.format := nullif(p_filters ->> 'gameFormat', '');
  v.formats := public.filter_formats(p_filters);
  v.currency := upper(btrim(nullif(p_filters ->> 'currency', '')));
  v.big_blind := (nullif(p_filters ->> 'bigBlind', ''))::bigint;
  v."position" := upper(btrim(nullif(p_filters ->> 'position', '')));
  v.pot_type := nullif(p_filters ->> 'potType', '');
  v.status := nullif(p_filters ->> 'status', '');
  v.flagged := coalesce((nullif(p_filters ->> 'flagged', ''))::boolean, false);
  v.street := nullif(p_filters ->> 'street', '');
  v.flag := nullif(p_filters ->> 'flag', '');
  -- The Hands list's filter (2026-11-16): its hands, or null.
  v.hands := public.analysis_hand_ids(p_filters);
  return v;
end;
$$;

-- analysis_filter_sums_ok: as in 20270825090000_analysis_screen_summaries.sql, with the hand list.
create or replace function public.analysis_filter_sums_ok(q public.analysis_filter)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.analysis_filter_rows_ok(q) and q.from_at is null and q.to_at is null and q.site is null
     and q.currency is null and q.big_blind is null
     and q.hands is null;
$$;

-- analysis_scope: as in 20271104090000_game_kind_filter.sql, with the hand list.
CREATE OR REPLACE FUNCTION public.analysis_scope(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS SETOF public.hand_analysis
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_ids       uuid[] := public.analysis_hand_ids(p_filters);
  v_owner     uuid := auth.uid();
  v_grade     text := nullif(btrim(coalesce(p_filters ->> 'grade', '')), '');
  v_min_grade text := nullif(btrim(coalesce(p_filters ->> 'minGrade', '')), '');
  v_formats   text[] := public.filter_formats(p_filters);
begin
  if v_grade is not null and public.analysis_grade_rank(v_grade) is null then
    raise exception 'Unknown grade: %', v_grade using errcode = '22023';
  end if;
  if v_min_grade is not null and public.analysis_grade_rank(v_min_grade) is null then
    raise exception 'Unknown grade: %', v_min_grade using errcode = '22023';
  end if;

  return query
  select a.*
  from public.hand_analysis a
  join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
  where a.owner_id = v_owner
    and (v_ids is null or a.hand_id = any (v_ids))
    and a.analysis_version = public.analysis_version_of(p_filters)
    and (nullif(p_filters ->> 'from', '') is null or h.played_at >= (p_filters ->> 'from')::timestamptz)
    and (nullif(p_filters ->> 'to', '') is null or h.played_at < (p_filters ->> 'to')::timestamptz)
    and (nullif(p_filters ->> 'site', '') is null or h.site = lower(btrim(p_filters ->> 'site')))
    and (v_formats is null or h.game_format::text = any (v_formats))
    and (nullif(p_filters ->> 'currency', '') is null or h.currency = upper(btrim(p_filters ->> 'currency')))
    and (nullif(p_filters ->> 'bigBlind', '') is null or h.big_blind = (p_filters ->> 'bigBlind')::bigint)
    and (nullif(p_filters ->> 'position', '') is null or h.hero_position = upper(btrim(p_filters ->> 'position')))
    and (nullif(p_filters ->> 'potType', '') is null or a.pot_type = p_filters ->> 'potType')
    and (nullif(p_filters ->> 'status', '') is null or a.status = p_filters ->> 'status')
    and (coalesce((nullif(p_filters ->> 'flagged', ''))::boolean, false) = false or a.flag_count > 0)
    and (v_grade is null or a.grade = v_grade)
    and (v_min_grade is null
         or public.analysis_grade_rank(a.grade) >= public.analysis_grade_rank(v_min_grade))
    and (nullif(p_filters ->> 'street', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner
            and d.street = p_filters ->> 'street'))
    and (nullif(p_filters ->> 'flag', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner
            and d.flags @> jsonb_build_array(jsonb_build_object('code', p_filters ->> 'flag'))));
end;
$function$;

-- analysis_node_actions: as in 20271104090000_game_kind_filter.sql, with the hand list.
create or replace function public.analysis_node_actions(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  q         public.analysis_filter;
  v_facets  jsonb;
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_node_actions_scan(p_filters);
  end if;

  -- The facets: the caller's hands with a graded preflop chart decision at
  -- this version, unfiltered.
  with s as materialized (
    select * from public.analysis_graded_sites t
    where t.owner_id = v_owner and t.analysis_version = v_version and t.chart_hands > 0
  )
  select jsonb_build_object(
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object('site', x.site, 'hands', x.n) order by x.n desc, x.site)
        from (select site, sum(chart_hands)::bigint as n from s group by site) x), '[]'::jsonb),
      'stakes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n)
               order by x.n desc, x.currency, x.big_blind)
        from (
          select currency, currency_minor_units, small_blind, big_blind, sum(chart_hands)::bigint as n
          from s
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'first', (select min(r.played_at) from public.analysis_hand_rows r
                where r.owner_id = v_owner and r.analysis_version = v_version and r.chart_graded > 0),
      'last',  (select max(r.played_at) from public.analysis_hand_rows r
                where r.owner_id = v_owner and r.analysis_version = v_version and r.chart_graded > 0))
    into v_facets;

  if q.from_at is null and q.to_at is null and q.site is null and q.formats is null and q.currency is null
     and q.big_blind is null and q."position" is null and q.pot_type is null and q.hands is null then
    -- Everything: the totals.
    with t as materialized (
      select * from public.analysis_node_totals t
      where t.owner_id = v_owner and t.analysis_version = v_version
    )
    select jsonb_build_object(
      'analysisVersion', v_version,
      'hands',     (select coalesce(sum(s.node_hands), 0)::bigint from public.analysis_graded_sites s
                    where s.owner_id = v_owner and s.analysis_version = v_version),
      'decisions', (select coalesce(sum(decisions), 0)::bigint from t where street = 'preflop'),
      'actions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'set',        x.node_set,
                 'line',       x.line,
                 'scenario',   x.scenario,
                 'action',     x.action,
                 'decisions',  x.n,
                 'deviations', x.dev,
                 'evLossBb',   x.ev)
               order by x.node_set, x.line, x.action, x.scenario)
        from (
          select node_set, line, scenario, action, sum(decisions)::bigint as n, sum(deviations)::bigint as dev,
                 round(coalesce(sum(ev_loss_bb), 0), 3) as ev
          from t
          where street = 'preflop'
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'classes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'set',       x.node_set,
                 'line',      x.line,
                 'handClass', x.hand_class,
                 'action',    x.action,
                 'decisions', x.n)
               order by x.node_set, x.line, x.hand_class, x.action)
        from (
          select node_set, line, hand_class, action, sum(decisions)::bigint as n
          from t
          where street = 'preflop' and hand_class is not null
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'postflop', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'street',    x.street,
                 'scenario',  x.scenario,
                 'action',    x.action,
                 'decisions', x.n)
               order by array_position(array['flop', 'turn', 'river'], x.street), x.scenario, x.action)
        from (select street, scenario, action, sum(decisions)::bigint as n from t where street <> 'preflop'
              group by 1, 2, 3) x), '[]'::jsonb),
      'facets', v_facets)
    into v_out;
    return v_out;
  end if;

  -- A range, a room, a stake, a seat, a format or a pot type: the leak rows in scope.
  with z as materialized (
    select z.hand_id, z.street, z.status, z.spot_key, z.grade, z.ev_loss_bb, z.node_set, z.node_line,
           z.node_scenario, z.hand_class, z.chosen_action
    from public.analysis_leak_rows z
    where z.owner_id = v_owner and z.analysis_version = v_version
      and ((z.node_line is not null and z.chosen_action is not null) or (z.street <> 'preflop' and z.status = 'analysed'))
      and (q.from_at is null or z.played_at >= q.from_at)
      and (q.to_at is null or z.played_at < q.to_at)
      and (q.site is null or z.site = q.site)
      and (q.formats is null or z.game_format = any (q.formats))
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
      and (q.hands is null or z.hand_id = any (q.hands))
  ),
  g as (select * from z where node_line is not null and chosen_action is not null),
  p as (select street, split_part(spot_key, '|', 2) as scenario, split_part(spot_key, '|', 5) as action
        from z where street <> 'preflop')
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',     (select count(distinct hand_id) from g),
    'decisions', (select count(*) from g),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',        x.node_set,
               'line',       x.node_line,
               'scenario',   x.node_scenario,
               'action',     x.chosen_action,
               'decisions',  x.n,
               'deviations', x.dev,
               'evLossBb',   x.ev)
             order by x.node_set, x.node_line, x.chosen_action, x.node_scenario)
      from (
        select node_set, node_line, node_scenario, chosen_action,
               count(*) as n,
               count(*) filter (where grade <> 'perfect') as dev,
               round(coalesce(sum(ev_loss_bb), 0), 3) as ev
        from g
        group by 1, 2, 3, 4
      ) x), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',       x.node_set,
               'line',      x.node_line,
               'handClass', x.hand_class,
               'action',    x.chosen_action,
               'decisions', x.n)
             order by x.node_set, x.node_line, x.hand_class, x.chosen_action)
      from (
        select node_set, node_line, hand_class, chosen_action, count(*) as n
        from g
        where hand_class is not null
        group by 1, 2, 3, 4
      ) x), '[]'::jsonb),
    'postflop', coalesce((
      select jsonb_agg(jsonb_build_object(
               'street',    x.street,
               'scenario',  x.scenario,
               'action',    x.action,
               'decisions', x.n)
             order by array_position(array['flop', 'turn', 'river'], x.street), x.scenario, x.action)
      from (select street, scenario, action, count(*) as n from p group by 1, 2, 3) x), '[]'::jsonb),
    'facets', v_facets)
  into v_out;

  return v_out;
end;
$$;

-- analysis_node_hands: as in 20271104090000_game_kind_filter.sql, with the hand list.
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
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  q        public.analysis_filter;
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
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_node_hands_scan(p_filters, p_nodes, p_action, p_deviations, p_sort, p_limit, p_offset);
  end if;

  -- A key is "set:line" with no other colon: its set and line.
  with m as materialized (
    select z.hand_id, z.ord, z.played_at,
           case when z.ev_bb_null then null else z.ev_loss_bb end as ev_loss_bb,
           case when z.ev_pot_null then null else z.ev_loss_pot end as ev_loss_pot,
           z.chosen_action
    from (select distinct split_part(k, ':', 1) as s, split_part(k, ':', 2) as l from unnest(p_nodes) k) keys
    join public.analysis_leak_rows z
      on z.owner_id = v_owner and z.analysis_version = q.version and z.node_set = keys.s and z.node_line = keys.l
    where z.node_line is not null
      and (p_action is null or z.chosen_action = p_action)
      and (not v_dev or z.grade <> 'perfect')
      and (q.from_at is null or z.played_at >= q.from_at)
      and (q.to_at is null or z.played_at < q.to_at)
      and (q.site is null or z.site = q.site)
      and (q.formats is null or z.game_format = any (q.formats))
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
      and (q.hands is null or z.hand_id = any (q.hands))
  ),
  page as (
    select m.*,
           row_number() over (
             order by
               case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
               case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
               case when v_sort = 'oldest' then m.played_at end asc nulls last,
               m.played_at desc nulls last,
               m.hand_id,
               m.ord) as rn
    from m
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'handId',      p.hand_id,
                    'ord',         p.ord,
                    'actionIndex', dd.action_index,
                    'playedAt',    h.played_at,
                    'site',        h.site,
                    'stakesLabel', h.stakes_label,
                    'position',    h.hero_position,
                    'heroCards',   to_jsonb(h.hero_cards),
                    'handClass',   dd.facts ->> 'handClass',
                    'set',         dd.facts -> 'chart' ->> 'set',
                    'line',        dd.facts -> 'chart' ->> 'line',
                    'scenario',    dd.facts -> 'chart' ->> 'scenario',
                    'inRange',     dd.facts -> 'chart' -> 'inRange',
                    'action',      p.chosen_action,
                    'grade',       dd.grade,
                    'evLossBb',    dd.ev_loss_bb,
                    'evLossPot',   dd.ev_loss_pot,
                    'options',     dd.options,
                    'chosen',      dd.chosen) order by p.rn)
           from page p
           join public.hands h on h.id = p.hand_id and h.owner_id = v_owner
           join public.decision_analysis dd
             on dd.hand_id = p.hand_id and dd.ord = p.ord and dd.analysis_version = q.version and dd.owner_id = v_owner),
           '[]'::jsonb)
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

-- analysis_leaks: as in 20271105090000_leak_pot_type.sql, with the hand list.
create or replace function public.analysis_leaks(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  q         public.analysis_filter;
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_leaks_scan(p_filters);
  end if;

  declare
    -- totals: all time under format, seat, pot type; stakes: all time under
    -- a room and / or a stake; complement: a range under format, seat, pot
    -- type that holds most of the history (the totals less the rows outside
    -- it); rows: the leak rows in scope.
    v_mode   text;
    v_inside numeric;
    v_all    numeric;
  begin
    if q.hands is not null then
      -- the Hands list's hands: their rows, never the sums
      v_mode := 'rows';
    elsif public.analysis_filter_sums_ok(q) then
      v_mode := 'totals';
    elsif q.from_at is null and q.to_at is null and q.formats is null and q."position" is null and q.pot_type is null and q.hands is null then
      v_mode := 'stakes';
    elsif q.site is null and q.currency is null and q.big_blind is null then
      select sum(m.hands) filter (where (q.from_at is null or m.month >= public.analysis_month_of(q.from_at))
                                    and (q.to_at is null or m.month <= public.analysis_month_of(q.to_at))
                                    and m.month > '-infinity'::date),
             sum(m.hands)
        into v_inside, v_all
      from public.analysis_month_hands m
      where m.owner_id = v_owner and m.analysis_version = v_version;
      v_mode := case when coalesce(v_inside, 0) * 2 > coalesce(v_all, 0) then 'complement' else 'rows' end;
    else
      v_mode := 'rows';
    end if;

    with g as materialized (
      -- rows: the graded leak rows in scope; complement: those outside the range
      select z.hand_id, z.spot_key, z.chart_set,
             case when z.street <> 'preflop' then nullif(public.analysis_leak_pot_of(z.pot_type), 'other') end as pot,
             z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where v_mode in ('rows', 'complement')
        and z.owner_id = v_owner and z.analysis_version = v_version and z.grade is not null
        and (q.site is null or z.site = q.site)
        and (q.formats is null or z.game_format = any (q.formats))
        and (q.currency is null or z.currency = q.currency)
        and (q.big_blind is null or z.big_blind = q.big_blind)
        and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
        and (q.pot_type is null or z.pot_type = q.pot_type)
        and (q.hands is null or z.hand_id = any (q.hands))
        and case when v_mode = 'rows'
                 then (q.from_at is null or z.played_at >= q.from_at) and (q.to_at is null or z.played_at < q.to_at)
                 else (q.from_at is not null and (z.played_at < q.from_at or z.played_at is null))
                   or (q.to_at is not null and (z.played_at >= q.to_at or z.played_at is null))
            end
    ),
    -- stakes: the room and stake sums keep no pot type, so the postflop rows
    -- in a 3-bet or 4-bet+ pot in scope are read from the rows (20271105090000)
    p as materialized (
      select z.hand_id, z.spot_key, z.chart_set, public.analysis_leak_pot_of(z.pot_type) as pot,
             z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where v_mode = 'stakes'
        and z.owner_id = v_owner and z.analysis_version = v_version and z.grade is not null
        and z.street <> 'preflop' and z.pot_type in ('3bet', '4bet+')
        and (q.site is null or z.site = q.site)
        and (q.currency is null or z.currency = q.currency)
        and (q.big_blind is null or z.big_blind = q.big_blind)
    ),
    s as (
      select t.spot_key, t.chart_set,
             case when split_part(t.spot_key, '|', 1) <> 'preflop'
                  then nullif(public.analysis_leak_pot_of(t.pot_type), 'other') end as pot,
             t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_totals t
      where v_mode in ('totals', 'complement')
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.formats is null or t.game_format = any (q.formats))
        and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
        and (q.pot_type is null or t.pot_type = q.pot_type)
      union all
      select t.spot_key, t.chart_set, null::text, t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_stake_totals t
      where v_mode = 'stakes'
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.site is null or t.site = q.site)
        and (q.currency is null or t.currency = q.currency)
        and (q.big_blind is null or t.big_blind = q.big_blind)
      union all
      -- stakes: each 3-bet or 4-bet+ postflop part on its own row, out of the untagged one
      -- (a hand has one pot type, so its distinct hands move whole)
      select p.spot_key, p.chart_set, x.pot, x.sign * count(*), x.sign * count(distinct p.hand_id),
             x.sign * count(*) filter (where p.grade <> 'perfect'),
             x.sign * count(*) filter (where p.grade in ('inaccurate', 'mistake', 'blunder')),
             x.sign * sum(p.ev_loss_bb), x.sign * sum(p.ev_loss_pot),
             x.sign * coalesce(sum(p.score), 0), x.sign * coalesce(sum(p.score * p.score), 0)
      from p
      cross join lateral (values (p.pot, 1), (null::text, -1)) x(pot, sign)
      group by p.spot_key, p.chart_set, p.pot, x.pot, x.sign
      union all
      select g.spot_key, g.chart_set, g.pot, count(*), count(distinct g.hand_id),
             count(*) filter (where g.grade <> 'perfect'),
             count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             sum(g.ev_loss_bb), sum(g.ev_loss_pot), coalesce(sum(g.score), 0), coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'rows'
      group by 1, 2, 3
      union all
      select g.spot_key, g.chart_set, g.pot, -count(*), -count(distinct g.hand_id),
             -count(*) filter (where g.grade <> 'perfect'),
             -count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             -sum(g.ev_loss_bb), -sum(g.ev_loss_pot), -coalesce(sum(g.score), 0), -coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'complement'
      group by 1, 2, 3
    ),
    x as materialized (
      select spot_key, chart_set, pot, sum(decisions)::bigint as n, sum(hands)::bigint as hands,
             sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum, sum(score_sq) as score_sq
      from s
      group by spot_key, chart_set, pot
      having sum(decisions) > 0
    )
    select jsonb_build_object(
      'analysisVersion', v_version,
      'hands', case v_mode
                 when 'rows' then (select count(distinct hand_id) from g)
                 when 'stakes' then (
                   select coalesce(sum(t.graded_hands), 0)::bigint from public.analysis_graded_sites t
                   where t.owner_id = v_owner and t.analysis_version = v_version
                     and (q.site is null or t.site = q.site)
                     and (q.currency is null or t.currency = q.currency)
                     and (q.big_blind is null or t.big_blind = q.big_blind))
                 else (
                   select coalesce(sum(k.graded_hands), 0)::bigint from public.analysis_overview_keys k
                   where k.owner_id = v_owner and k.analysis_version = v_version and k.kind = 'all'
                     and (q.formats is null or k.game_format = any (q.formats))
                     and (q."position" is null or (q."position" <> '' and k.hero_position = q."position"))
                     and (q.pot_type is null or k.pot_type = q.pot_type))
                   - case when v_mode = 'complement' then (select count(distinct hand_id) from g) else 0 end
               end,
      'graded', (select coalesce(sum(x.n), 0)::bigint from x),
      -- The first and last graded hand in scope, by the hand rows' time index.
      'first',  (select min(r.played_at) from public.analysis_hand_rows r
                 where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
                   and (q.from_at is null or r.played_at >= q.from_at)
                   and (q.to_at is null or r.played_at < q.to_at)
                   and (q.site is null or r.site = q.site)
                   and (q.formats is null or r.game_format = any (q.formats))
                   and (q.currency is null or r.currency = q.currency)
                   and (q.big_blind is null or r.big_blind = q.big_blind)
                   and (q."position" is null or r.hero_position = q."position")
                   and (q.pot_type is null or r.pot_type = q.pot_type)
                   and (q.hands is null or r.hand_id = any (q.hands))),
      'last',   (select max(r.played_at) from public.analysis_hand_rows r
                 where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
                   and (q.from_at is null or r.played_at >= q.from_at)
                   and (q.to_at is null or r.played_at < q.to_at)
                   and (q.site is null or r.site = q.site)
                   and (q.formats is null or r.game_format = any (q.formats))
                   and (q.currency is null or r.currency = q.currency)
                   and (q.big_blind is null or r.big_blind = q.big_blind)
                   and (q."position" is null or r.hero_position = q."position")
                   and (q.pot_type is null or r.pot_type = q.pot_type)
                   and (q.hands is null or r.hand_id = any (q.hands))),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'key',        x.spot_key,
                 'set',        nullif(x.chart_set, ''),
                 'street',     split_part(x.spot_key, '|', 1),
                 'scenario',   split_part(x.spot_key, '|', 2),
                 'line',       split_part(x.spot_key, '|', 3),
                 'position',   split_part(x.spot_key, '|', 4),
                 'taken',      split_part(x.spot_key, '|', 5),
                 'best',       split_part(x.spot_key, '|', 6),
                 'decisions',  x.n,
                 'hands',      x.hands,
                 'nonPerfect', x.non_perfect,
                 'mistakes',   x.mistakes,
                 'evLossBb',   round(x.ev_bb, 3),
                 'evLossPot',  round(x.ev_pot, 4),
                 'scoreSum',   round(x.score_sum, 2),
                 'scoreSq',    round(x.score_sq, 2))
                 || case when x.pot is not null then jsonb_build_object('pot', x.pot) else '{}'::jsonb end
               order by x.spot_key, nullif(x.chart_set, '') nulls first, x.pot nulls first)
        from x), '[]'::jsonb),
      'facets', public.analysis_graded_facets(v_version))
    into v_out;
  end;

  return v_out;
end;
$$;

-- analysis_leak_hands: as in 20271105090000_leak_pot_type.sql, with the hand list.
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
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  v_table  text := nullif(btrim(coalesce(p_filters ->> 'leakTable', '')), '');
  v_pot    text := nullif(btrim(coalesce(p_filters ->> 'leakPot', '')), '');
  q        public.analysis_filter;
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
  if v_table is not null and v_table not in ('hu', '9max', 'other') then
    raise exception 'Unknown leak table: %', v_table using errcode = '22023';
  end if;
  if v_pot is not null and v_pot not in ('3bp', '4bp', 'other') then
    raise exception 'Unknown leak pot: %', v_pot using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_leak_hands_scan(p_filters, p_keys, p_deviations, p_sort, p_limit, p_offset);
  end if;

  -- The keys' graded leak rows in scope (each key's rows by its index).
  with m as materialized (
    select z.hand_id, z.ord, z.action_index, z.played_at, z.spot_key, z.source, z.grade, z.ev_loss_bb, z.ev_loss_pot
    from (select distinct k from unnest(p_keys) k) keys
    join public.analysis_leak_rows z
      on z.owner_id = v_owner and z.analysis_version = q.version and z.spot_key = keys.k
    where z.grade is not null
      and (not v_dev or z.grade <> 'perfect')
      and (q.from_at is null or z.played_at >= q.from_at)
      and (q.to_at is null or z.played_at < q.to_at)
      and (q.site is null or z.site = q.site)
      and (q.formats is null or z.game_format = any (q.formats))
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
      and (q.hands is null or z.hand_id = any (q.hands))
      and (v_table is null or public.analysis_leak_table_of(z.chart_set) = v_table)
      and (v_pot is null or public.analysis_leak_pot_of(z.pot_type) = v_pot)
  ),
  page as (
    select m.*,
           row_number() over (
             order by
               case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
               case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
               case when v_sort = 'oldest' then m.played_at end asc nulls last,
               m.played_at desc nulls last,
               m.hand_id,
               m.ord) as rn
    from m
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'handId',      p.hand_id,
                    'ord',         p.ord,
                    'actionIndex', p.action_index,
                    'playedAt',    p.played_at,
                    'site',        h.site,
                    'stakesLabel', h.stakes_label,
                    'position',    split_part(p.spot_key, '|', 4),
                    'heroCards',   to_jsonb(h.hero_cards),
                    'street',      split_part(p.spot_key, '|', 1),
                    'scenario',    split_part(p.spot_key, '|', 2),
                    'line',        split_part(p.spot_key, '|', 3),
                    'taken',       split_part(p.spot_key, '|', 5),
                    'best',        split_part(p.spot_key, '|', 6),
                    'source',      p.source,
                    'grade',       p.grade,
                    'evLossBb',    p.ev_loss_bb,
                    'evLossPot',   p.ev_loss_pot,
                    'handClass',   dd.facts ->> 'handClass',
                    'options',     dd.options,
                    'chosen',      dd.chosen) order by p.rn)
           from page p
           join public.hands h on h.id = p.hand_id and h.owner_id = v_owner
           join public.decision_analysis dd
             on dd.hand_id = p.hand_id and dd.ord = p.ord and dd.analysis_version = q.version and dd.owner_id = v_owner),
           '[]'::jsonb)
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

-- analysis_trend: as in 20271104090000_game_kind_filter.sql, with the hand list.
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
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  v_bucket  text := coalesce(p_bucket, 'week');
  v_group   text := coalesce(p_group, 'all');
  v_minutes integer := least(greatest(coalesce(p_gap_minutes, 30), 5), 720);
  v_gap     interval;
  q         public.analysis_filter;
  v_days    boolean;
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
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_trend_scan(p_filters, p_bucket, p_group, p_gap_minutes);
  end if;

  v_days := v_bucket <> 'session'
    and q.site is null and q.formats is null and q.currency is null and q.big_blind is null
    and q."position" is null and q.pot_type is null and q.hands is null
    and (q.from_at is null or q.from_at = date_trunc('day', q.from_at, 'UTC'))
    and (q.to_at is null or q.to_at = date_trunc('day', q.to_at, 'UTC'));

  if v_days then
    with t as materialized (
      select t.*,
             case v_bucket when 'week' then date_trunc('week', t.day::timestamp) at time zone 'UTC'
                           else date_trunc('month', t.day::timestamp) at time zone 'UTC' end as b_start
      from public.analysis_trend_days t
      where t.owner_id = v_owner and t.analysis_version = v_version
        and t.grp in (v_group, 'all')
        and (q.from_at is null or t.day >= (q.from_at at time zone 'UTC')::date)
        and (q.to_at is null or t.day < (q.to_at at time zone 'UTC')::date)
    ),
    totals as (
      select b_start, sum(hands)::bigint as bucket_hands from t where grp = 'all' group by b_start
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'start',       x.b_start,
             'end',         case v_bucket when 'week' then x.b_start + interval '7 days'
                                 else (x.b_start at time zone 'UTC' + interval '1 month') at time zone 'UTC' end,
             'first',       x.first_at,
             'last',        x.last_at,
             'key',         x.key,
             'bucketHands', tt.bucket_hands,
             'hands',       x.hands,
             'graded',      x.n,
             'nonPerfect',  x.non_perfect,
             'mistakes',    x.mistakes,
             'grades', jsonb_build_object(
               'perfect',    x.n - x.non_perfect,
               'good',       x.non_perfect - x.mistakes,
               'inaccurate', x.mistakes - x.g_mistake - x.g_blunder,
               'mistake',    x.g_mistake,
               'blunder',    x.g_blunder),
             'evLossBb',    x.ev_bb,
             'evLossPot',   x.ev_pot,
             'scoreSum',    x.score_sum,
             'scoreSq',     x.score_sq)
           order by x.b_start, x.key), '[]'::jsonb)
      into v_rows
    from (
      select b_start, case when v_group = 'all' then 'all' else key end as key,
             min(first_at) as first_at, max(last_at) as last_at,
             sum(hands)::bigint as hands, sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect,
             sum(mistakes)::bigint as mistakes, sum(g_mistake)::bigint as g_mistake, sum(g_blunder)::bigint as g_blunder,
             round(sum(ev_loss_bb), 3) as ev_bb, round(sum(ev_loss_pot), 4) as ev_pot,
             round(sum(score_sum), 2) as score_sum, round(sum(score_sq), 2) as score_sq
      from t
      where grp = v_group
      group by 1, 2
    ) x
    join totals tt on tt.b_start = x.b_start;
  elsif v_bucket = 'session' then
    -- Sessions over every dated hand row in scope (graded or not), in time
    -- order: a hand starts one when the gap to the one before exceeds the
    -- gap asked. Hands at the same time share a session whatever their
    -- order (the running sum takes all of them at once). Then each session's
    -- graded hands are summed per key: from the hand rows (all, position,
    -- pot type) or from their graded leak rows (street).
    with n as materialized (
      select s.*, sum(s.starts) over (order by s.played_at) as session
      from (
        select r.hand_id, r.played_at, coalesce(r.hero_position, '') as hero_position,
               coalesce(r.pot_type, '') as pot_type, r.graded, r.g_non_perfect, r.g_mistakes, r.g_mistake,
               r.g_blunder, r.g_ev_bb, r.g_ev_pot, r.g_score_sum, r.g_score_sq,
               case when lag(r.played_at) over w is null or r.played_at - lag(r.played_at) over w > v_gap
                    then 1 else 0 end as starts
        from public.analysis_hand_rows r
        where r.owner_id = v_owner and r.analysis_version = v_version and r.played_at is not null
          and (q.from_at is null or r.played_at >= q.from_at)
          and (q.to_at is null or r.played_at < q.to_at)
          and (q.site is null or r.site = q.site)
          and (q.formats is null or r.game_format = any (q.formats))
          and (q.currency is null or r.currency = q.currency)
          and (q.big_blind is null or r.big_blind = q.big_blind)
          and (q."position" is null or r.hero_position = q."position")
          and (q.pot_type is null or r.pot_type = q.pot_type)
          and (q.hands is null or r.hand_id = any (q.hands))
        window w as (order by r.played_at)
      ) s
    ),
    sess as (
      select session, min(played_at) as started_at, max(played_at) as ended_at,
             count(*) filter (where graded > 0) as bucket_hands
      from n
      group by session
    ),
    x as (
      select n.session,
             case v_group when 'position' then n.hero_position when 'pot_type' then n.pot_type else 'all' end as key,
             min(n.played_at) as first_at, max(n.played_at) as last_at, count(*) as hands,
             sum(n.graded)::bigint as n, sum(n.g_non_perfect)::bigint as non_perfect,
             sum(n.g_mistakes)::bigint as mistakes, sum(n.g_mistake)::bigint as g_mistake,
             sum(n.g_blunder)::bigint as g_blunder,
             round(sum(n.g_ev_bb), 3) as ev_bb, round(sum(n.g_ev_pot), 4) as ev_pot,
             round(sum(n.g_score_sum), 2) as score_sum, round(sum(n.g_score_sq), 2) as score_sq
      from n
      where n.graded > 0 and v_group <> 'street'
      group by 1, 2
      union all
      select n.session, z.street, min(n.played_at), max(n.played_at), count(distinct n.hand_id),
             count(*), count(*) filter (where z.grade <> 'perfect'),
             count(*) filter (where z.grade in ('inaccurate', 'mistake', 'blunder')),
             count(*) filter (where z.grade = 'mistake'), count(*) filter (where z.grade = 'blunder'),
             round(sum(z.ev_loss_bb), 3), round(sum(z.ev_loss_pot), 4),
             round(coalesce(sum(z.score), 0), 2), round(coalesce(sum(z.score * z.score), 0), 2)
      from n
      join public.analysis_leak_rows z
        on z.hand_id = n.hand_id and z.analysis_version = v_version and z.owner_id = v_owner and z.grade is not null
      where n.graded > 0 and v_group = 'street'
      group by 1, 2
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'start',       ss.started_at,
             'end',         ss.ended_at,
             'first',       x.first_at,
             'last',        x.last_at,
             'key',         x.key,
             'bucketHands', ss.bucket_hands,
             'hands',       x.hands,
             'graded',      x.n,
             'nonPerfect',  x.non_perfect,
             'mistakes',    x.mistakes,
             'grades', jsonb_build_object(
               'perfect',    x.n - x.non_perfect,
               'good',       x.non_perfect - x.mistakes,
               'inaccurate', x.mistakes - x.g_mistake - x.g_blunder,
               'mistake',    x.g_mistake,
               'blunder',    x.g_blunder),
             'evLossBb',    x.ev_bb,
             'evLossPot',   x.ev_pot,
             'scoreSum',    x.score_sum,
             'scoreSq',     x.score_sq)
           order by ss.started_at, x.key), '[]'::jsonb)
      into v_rows
    from x
    join sess ss on ss.session = x.session;
  else
    -- Weeks or months under a room, a stake, a seat, a format, a pot type or
    -- a range cut inside a day: the graded hand rows in scope.
    with b as materialized (
      select r.hand_id, r.played_at, coalesce(r.hero_position, '') as hero_position,
             coalesce(r.pot_type, '') as pot_type, r.graded, r.g_non_perfect, r.g_mistakes, r.g_mistake,
             r.g_blunder, r.g_ev_bb, r.g_ev_pot, r.g_score_sum, r.g_score_sq,
             case v_bucket when 'week' then date_trunc('week', r.played_at, 'UTC')
                           else date_trunc('month', r.played_at, 'UTC') end as b_start,
             case v_bucket when 'week' then date_trunc('week', r.played_at, 'UTC') + interval '7 days'
                           else (date_trunc('month', r.played_at, 'UTC') at time zone 'UTC' + interval '1 month') at time zone 'UTC'
             end as b_end
      from public.analysis_hand_rows r
      where r.owner_id = v_owner and r.analysis_version = v_version and r.played_at is not null and r.graded > 0
        and (q.from_at is null or r.played_at >= q.from_at)
        and (q.to_at is null or r.played_at < q.to_at)
        and (q.site is null or r.site = q.site)
        and (q.formats is null or r.game_format = any (q.formats))
        and (q.currency is null or r.currency = q.currency)
        and (q.big_blind is null or r.big_blind = q.big_blind)
        and (q."position" is null or r.hero_position = q."position")
        and (q.pot_type is null or r.pot_type = q.pot_type)
        and (q.hands is null or r.hand_id = any (q.hands))
    ),
    totals as (
      select b_start, count(*) as bucket_hands from b group by b_start
    ),
    -- Per bucket and key: from the hands (all, position, pot type) or from
    -- their graded leak rows (street).
    x as (
      select b.b_start, b.b_end,
             case v_group when 'position' then b.hero_position when 'pot_type' then b.pot_type else 'all' end as key,
             min(b.played_at) as first_at, max(b.played_at) as last_at, count(*) as hands,
             sum(b.graded)::bigint as n, sum(b.g_non_perfect)::bigint as non_perfect,
             sum(b.g_mistakes)::bigint as mistakes, sum(b.g_mistake)::bigint as g_mistake,
             sum(b.g_blunder)::bigint as g_blunder,
             round(sum(b.g_ev_bb), 3) as ev_bb, round(sum(b.g_ev_pot), 4) as ev_pot,
             round(sum(b.g_score_sum), 2) as score_sum, round(sum(b.g_score_sq), 2) as score_sq
      from b
      where v_group <> 'street'
      group by 1, 2, 3
      union all
      select b.b_start, b.b_end, z.street, min(b.played_at), max(b.played_at), count(distinct b.hand_id),
             count(*), count(*) filter (where z.grade <> 'perfect'),
             count(*) filter (where z.grade in ('inaccurate', 'mistake', 'blunder')),
             count(*) filter (where z.grade = 'mistake'), count(*) filter (where z.grade = 'blunder'),
             round(sum(z.ev_loss_bb), 3), round(sum(z.ev_loss_pot), 4),
             round(coalesce(sum(z.score), 0), 2), round(coalesce(sum(z.score * z.score), 0), 2)
      from b
      join public.analysis_leak_rows z
        on z.hand_id = b.hand_id and z.analysis_version = v_version and z.owner_id = v_owner and z.grade is not null
      where v_group = 'street'
      group by 1, 2, 3
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
               'perfect',    x.n - x.non_perfect,
               'good',       x.non_perfect - x.mistakes,
               'inaccurate', x.mistakes - x.g_mistake - x.g_blunder,
               'mistake',    x.g_mistake,
               'blunder',    x.g_blunder),
             'evLossBb',    x.ev_bb,
             'evLossPot',   x.ev_pot,
             'scoreSum',    x.score_sum,
             'scoreSq',     x.score_sq)
           order by x.b_start, x.key), '[]'::jsonb)
      into v_rows
    from x
    join totals t on t.b_start = x.b_start;
  end if;

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

-- The R6.2 entitlement gate, back in every re-created gated function.
select public.entitlement_gates_apply();
