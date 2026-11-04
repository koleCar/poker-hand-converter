-- ===========================================================================
-- Rail: one game kind at a time - cash, or every tournament format
-- ===========================================================================
--
-- The owner's rule (2026-11-04): cash and tournament hands are never combined
-- in a view; every screen shows one kind, chosen with a Cash | Tournaments
-- toggle. The readers took one `gameFormat` (empty: every format), so
-- "Tournaments" - tournament, Sit & Go and Spin together - could not be
-- asked for, and a screen with no format control read every format.
--
-- What changes:
--
--   * `game_kind_formats(kind)`: `cash` -> {cash}; `tournament` -> every
--     chip format (the enum's values but cash); null -> null; anything else
--     raises 22023. `filter_formats(filters)`: the formats a filter names -
--     `gameFormat` (one), else `gameKind`'s, else null for every format; a
--     `gameFormat` outside the `gameKind` named is no format at all.
--   * `analysis_filter` gains `formats`, set by `analysis_filter_of`, and the
--     analysis readers (`analysis_overview`, `_breakdown`, `_hands`,
--     `_leaks`, `_leak_hands`, `_node_actions`, `_node_hands`, `_trend`) test
--     it where they tested `format`. `analysis_scope` (the scan readers'
--     rows), `analysis_top_leaks`, `analysis_leak_examples` and
--     `analysis_leak_sample` (now `text[]` formats) likewise. Their bodies
--     are otherwise the last definitions (20270825090000, 20270818090000,
--     20271103090000), copied.
--   * `drill_queue`, `drill_summary`, `drill_due_by_spot` take an optional
--     last `p_kind` (the hand's kind for a drill item; the leak totals' and
--     rows' format for the undrilled mistakes).
--   * `stats_opponents` reads `gameKind` as well as `gameFormat`.
--   * The entitlement gates follow the four new signatures.
--
-- Not changed: no table, no row, no grade, no `analysis/N`. A call without
-- `gameKind` (or `p_kind`) returns what it returned.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A kind's formats; the formats a filter names
-- ---------------------------------------------------------------------------

create or replace function public.game_kind_formats(p_kind text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kind text := nullif(btrim(coalesce(p_kind, '')), '');
begin
  if v_kind is null then
    return null;
  elsif v_kind = 'cash' then
    return array['cash'];
  elsif v_kind = 'tournament' then
    -- Every chip format: tournament, Sit & Go, Spin (and any added later).
    return array(select f::text from unnest(enum_range(null::public.game_format)) f where f <> 'cash');
  end if;
  raise exception 'Unknown game kind: %', v_kind using errcode = '22023';
end;
$$;

comment on function public.game_kind_formats(text) is
  'The formats of a game kind: cash -> {cash}; tournament -> every chip format. Null for none; any other kind raises.';

revoke all on function public.game_kind_formats(text) from public, anon;
grant execute on function public.game_kind_formats(text) to authenticated;

create or replace function public.filter_formats(p_filters jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_format text := nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '');
  v_kinds  text[] := public.game_kind_formats(p_filters ->> 'gameKind');
begin
  if v_format is null then
    return v_kinds;
  end if;
  -- A format outside the kind named: nothing (never the other kind's hands).
  if v_kinds is not null and not (v_format = any (v_kinds)) then
    return '{}'::text[];
  end if;
  return array[v_format];
end;
$$;

comment on function public.filter_formats(jsonb) is
  'The game formats a reader''s filters name: `gameFormat` (one), else `gameKind`''s (cash, tournament), '
  'else null for every format.';

revoke all on function public.filter_formats(jsonb) from public, anon;
grant execute on function public.filter_formats(jsonb) to authenticated;

-- The filters as the analysis readers read them, with the formats.
alter type public.analysis_filter add attribute formats text[];

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
  return v;
end;
$$;

CREATE OR REPLACE FUNCTION public.analysis_scope(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS SETOF public.hand_analysis
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
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

-- ---------------------------------------------------------------------------
-- 2. The analysis readers: `q.formats` where they read `q.format`
-- ---------------------------------------------------------------------------

create or replace function public.analysis_overview(p_filters jsonb default '{}'::jsonb)
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
  if not public.analysis_filter_sums_ok(q) then
    return public.analysis_overview_scan(p_filters);
  end if;

  with h as materialized (
    select * from public.analysis_overview_hands t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  ),
  d as materialized (
    select * from public.analysis_overview_decisions t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  ),
  fl as (
    select * from public.analysis_overview_flags t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',           (select coalesce(sum(hands), 0)::bigint from h),
    'status', jsonb_build_object(
      'full',        (select coalesce(sum(hands), 0)::bigint from h where status = 'full'),
      'partial',     (select coalesce(sum(hands), 0)::bigint from h where status = 'partial'),
      'notAnalysed', (select coalesce(sum(hands), 0)::bigint from h where status = 'not-analysed')),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'hands', r.n) order by r.n desc, r.reason)
      from (select nullif(reason, '') as reason, sum(hands)::bigint as n from h where status = 'not-analysed'
            group by 1) r), '[]'::jsonb),
    'skipped', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'decisions', r.n) order by r.n desc, r.reason)
      from (select nullif(reason, '') as reason, sum(decisions)::bigint as n from d where status = 'not-analysed'
            group by 1) r), '[]'::jsonb),
    'decisions',      (select coalesce(sum(decisions), 0)::bigint from d),
    'analysed',       (select coalesce(sum(decisions), 0)::bigint from d where status = 'analysed'),
    'flagged',        (select coalesce(sum(decisions), 0)::bigint from d where worst_flag <> ''),
    'flaggedHands',   (select coalesce(sum(hands), 0)::bigint from h where flagged),
    'flags', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'street', x.street, 'severity', x.severity, 'count', x.n)
                       order by x.n desc, x.code, x.street, x.severity)
      from (select code, street, severity, sum(flags)::bigint as n from fl group by 1, 2, 3) x), '[]'::jsonb),
    'streets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'street',    x.street,
               'decisions', x.n,
               'analysed',  x.analysed,
               'flagged',   x.flagged,
               'facingBet', x.facing,
               'defended',  x.defended,
               'mdf',       x.mdf)
             order by array_position(array['preflop', 'flop', 'turn', 'river'], x.street))
      from (
        select street,
               sum(decisions)::bigint as n,
               coalesce(sum(decisions) filter (where status = 'analysed'), 0)::bigint as analysed,
               coalesce(sum(decisions) filter (where worst_flag <> ''), 0)::bigint as flagged,
               coalesce(sum(facing) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as facing,
               coalesce(sum(defended) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as defended,
               round(sum(mdf_sum) filter (where status = 'analysed' and street <> 'preflop')
                     / nullif(sum(mdf_n) filter (where status = 'analysed' and street <> 'preflop'), 0), 3) as mdf
        from d group by street) x), '[]'::jsonb),
    'grades', coalesce((
      select jsonb_agg(jsonb_build_object('grade', x.grade, 'decisions', x.n)
                       order by public.analysis_grade_rank(x.grade))
      from (select grade, sum(decisions)::bigint as n from d where grade <> '' group by grade) x), '[]'::jsonb),
    'gradesByStreet', coalesce((
      select jsonb_agg(jsonb_build_object('street', x.street, 'grade', x.grade, 'decisions', x.n)
                       order by array_position(array['preflop', 'flop', 'turn', 'river'], x.street),
                                public.analysis_grade_rank(x.grade))
      from (select street, grade, sum(decisions)::bigint as n from d where grade <> '' group by street, grade) x), '[]'::jsonb),
    'graded',      (select coalesce(sum(decisions), 0)::bigint from d where grade <> ''),
    'gradedHands', (select coalesce(sum(hands), 0)::bigint from h where grade <> ''),
    'badHands',    (select coalesce(sum(hands), 0)::bigint from h where public.analysis_grade_rank(grade) >= 4),
    'score',       (select round(sum(score_sum) / nullif(sum(score_n), 0), 2) from d),
    'evLossBb',    (select case when sum(ev_bb_n) > 0 then round(sum(ev_bb_sum), 3) end from d),
    'evLossPot',   (select case when sum(ev_pot_n) > 0 then round(sum(ev_pot_sum), 4) end from d),
    'approximations', coalesce((
      select jsonb_agg(jsonb_build_object('approximation', x.ap, 'hands', x.n) order by x.n desc, x.ap)
      from (select ap, sum(h.hands)::bigint as n from h, unnest(h.approximations) ap group by ap) x), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

create or replace function public.analysis_breakdown(p_filters jsonb default '{}'::jsonb, p_group text default 'street')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_version text;
  q         public.analysis_filter;
  v_kind    text;
  v_rows    jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('street', 'position', 'pot_type', 'scenario', 'preflop_scenario') then
    raise exception 'Unknown analysis breakdown: %', coalesce(p_group, 'null') using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_sums_ok(q) then
    return public.analysis_breakdown_scan(p_filters, p_group);
  end if;
  v_version := q.version;
  v_kind := case p_group when 'street' then 'street' when 'scenario' then 'scenario'
                         when 'preflop_scenario' then 'preflop' else 'all' end;

  with d as (
    select case p_group
             when 'street'   then t.street
             when 'position' then nullif(t.hero_position, '')
             when 'pot_type' then nullif(t.pot_type, '')
             else t.scenario
           end as key,
           t.*
    from public.analysis_overview_decisions t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (p_group <> 'preflop_scenario' or t.street = 'preflop')
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  ),
  k as (
    select case p_group
             when 'position' then nullif(t.hero_position, '')
             when 'pot_type' then nullif(t.pot_type, '')
             else t.key
           end as key,
           sum(t.hands)::bigint as hands, sum(t.graded_hands)::bigint as graded_hands
    from public.analysis_overview_keys t
    where t.owner_id = v_owner and t.analysis_version = v_version and t.kind = v_kind
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',         x.key,
           'hands',       coalesce(k.hands, 0),
           'decisions',   x.n,
           'analysed',    x.analysed,
           'flagged',     x.flagged,
           'inaccurate',  x.inaccurate,
           'facingBet',   x.facing,
           'defended',    x.defended,
           'mdf',         x.mdf,
           'graded',      x.graded,
           'gradedHands', coalesce(k.graded_hands, 0),
           'grades', jsonb_build_object(
             'perfect',    x.g_perfect,
             'good',       x.g_good,
             'inaccurate', x.g_inaccurate,
             'mistake',    x.g_mistake,
             'blunder',    x.g_blunder),
           'evLossBb',    x.ev_loss,
           'score',       x.score)
         order by case when p_group = 'street'
                       then array_position(array['preflop', 'flop', 'turn', 'river'], x.key)
                       else null end,
                  x.n desc, x.key), '[]'::jsonb)
    into v_rows
  from (
    select key,
           sum(decisions)::bigint as n,
           coalesce(sum(decisions) filter (where status = 'analysed'), 0)::bigint as analysed,
           coalesce(sum(decisions) filter (where worst_flag <> ''), 0)::bigint as flagged,
           coalesce(sum(decisions) filter (where worst_flag = 'inaccurate'), 0)::bigint as inaccurate,
           coalesce(sum(facing) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as facing,
           coalesce(sum(defended) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as defended,
           round(sum(mdf_sum) filter (where status = 'analysed' and street <> 'preflop')
                 / nullif(sum(mdf_n) filter (where status = 'analysed' and street <> 'preflop'), 0), 3) as mdf,
           coalesce(sum(decisions) filter (where grade <> ''), 0)::bigint as graded,
           coalesce(sum(decisions) filter (where grade = 'perfect'), 0)::bigint as g_perfect,
           coalesce(sum(decisions) filter (where grade = 'good'), 0)::bigint as g_good,
           coalesce(sum(decisions) filter (where grade = 'inaccurate'), 0)::bigint as g_inaccurate,
           coalesce(sum(decisions) filter (where grade = 'mistake'), 0)::bigint as g_mistake,
           coalesce(sum(decisions) filter (where grade = 'blunder'), 0)::bigint as g_blunder,
           case when sum(ev_bb_n) filter (where grade <> '') > 0
                then round(sum(ev_bb_sum) filter (where grade <> ''), 3) end as ev_loss,
           round(sum(score_sum) filter (where grade <> '') / nullif(sum(score_n) filter (where grade <> ''), 0), 2) as score
    from d
    group by key
  ) x
  left join k on k.key is not distinct from x.key;

  return jsonb_build_object('group', p_group, 'rows', v_rows);
end;
$$;

create or replace function public.analysis_hands(
  p_filters jsonb   default '{}'::jsonb,
  p_sort    text    default 'recent',
  p_limit   integer default 25,
  p_offset  integer default 0
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
  v_sort   text := coalesce(p_sort, 'recent');
  q        public.analysis_filter;
  v_street smallint;
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_sort not in ('recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  -- A street the hand has a decision on; one that is none matches nothing.
  v_street := case when q.street is null then null else public.analysis_street_bit(q.street) end;

  -- How many: the overview's hand counts hold every filter but a range, a
  -- room or stake, a street and a flag; the hand rows hold those.
  if q.from_at is null and q.to_at is null and q.site is null and q.currency is null and q.big_blind is null
     and q.street is null and q.flag is null then
    select coalesce(sum(t.hands), 0)::bigint into v_total
    from public.analysis_overview_hands t
    where t.owner_id = v_owner and t.analysis_version = q.version
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
      and (q.status is null or t.status = q.status)
      and (not q.flagged or t.flagged)
      and (q.grade is null or t.grade = q.grade)
      and (q.min_grade is null or public.analysis_grade_rank(nullif(t.grade, '')) >= public.analysis_grade_rank(q.min_grade));
  else
    select count(*) into v_total
    from public.analysis_hand_rows r
    where r.owner_id = v_owner and r.analysis_version = q.version
      and (q.from_at is null or r.played_at >= q.from_at)
      and (q.to_at is null or r.played_at < q.to_at)
      and (q.site is null or r.site = q.site)
      and (q.formats is null or r.game_format = any (q.formats))
      and (q.currency is null or r.currency = q.currency)
      and (q.big_blind is null or r.big_blind = q.big_blind)
      and (q."position" is null or r.hero_position = q."position")
      and (q.pot_type is null or r.pot_type = q.pot_type)
      and (q.status is null or r.status = q.status)
      and (not q.flagged or r.flag_count > 0)
      and (q.grade is null or r.grade = q.grade)
      and (q.min_grade is null or public.analysis_grade_rank(r.grade) >= public.analysis_grade_rank(q.min_grade))
      and (v_street is null or (r.streets & v_street) <> 0)
      and (q.flag is null or q.flag = any (r.flag_codes));
  end if;

  with page as materialized (
    select r.hand_id, r.analysis_version, r.played_at, r.flag_count, r.worst_flag, r.ev_loss_bb, r.ev_loss_pot,
           r.score, r.big_blind, r.hero_profit
    from public.analysis_hand_rows r
    where r.owner_id = v_owner and r.analysis_version = q.version
      and (q.from_at is null or r.played_at >= q.from_at)
      and (q.to_at is null or r.played_at < q.to_at)
      and (q.site is null or r.site = q.site)
      and (q.formats is null or r.game_format = any (q.formats))
      and (q.currency is null or r.currency = q.currency)
      and (q.big_blind is null or r.big_blind = q.big_blind)
      and (q."position" is null or r.hero_position = q."position")
      and (q.pot_type is null or r.pot_type = q.pot_type)
      and (q.status is null or r.status = q.status)
      and (not q.flagged or r.flag_count > 0)
      and (q.grade is null or r.grade = q.grade)
      and (q.min_grade is null or public.analysis_grade_rank(r.grade) >= public.analysis_grade_rank(q.min_grade))
      and (v_street is null or (r.streets & v_street) <> 0)
      and (q.flag is null or q.flag = any (r.flag_codes))
    order by
      case when v_sort = 'oldest' then r.played_at end asc nulls last,
      case when v_sort = 'flags' then r.flag_count end desc,
      case when v_sort = 'flags' then r.worst_flag end asc nulls last,
      case when v_sort = 'ev_loss' then r.ev_loss_bb end desc nulls last,
      case when v_sort = 'ev_loss_pot' then r.ev_loss_pot end desc nulls last,
      case when v_sort = 'score' then r.score end asc nulls last,
      case when v_sort = 'result' and r.big_blind > 0 then r.hero_profit::numeric / r.big_blind end asc nulls last,
      r.played_at desc nulls last,
      r.hand_id
    offset v_offset
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
        'handId',             a.hand_id,
        'playedAt',           h.played_at,
        'site',               h.site,
        'stakesLabel',        h.stakes_label,
        'gameFormat',         h.game_format,
        'currency',           h.currency,
        'currencyMinorUnits', h.currency_minor_units,
        'bigBlind',           h.big_blind,
        'position',           h.hero_position,
        'heroCards',          to_jsonb(h.hero_cards),
        'handClass',          h.hero_hand_class,
        'potType',            a.pot_type,
        'status',             a.status,
        'reason',             a.reason,
        'grade',              a.grade,
        'score',              a.score,
        'evLossBb',           a.ev_loss_bb,
        'evLossPot',          a.ev_loss_pot,
        'flagCount',          a.flag_count,
        'worstFlag',          a.worst_flag,
        'netBb', case when h.big_blind > 0 and h.hero_profit is not null
                      then round(h.hero_profit::numeric / h.big_blind, 2) end,
        'decisions', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'ord',         d.ord,
                   'actionIndex', d.action_index,
                   'street',      d.street,
                   'action',      d.action,
                   'status',      d.status,
                   'grade',       d.grade,
                   'evLossBb',    d.ev_loss_bb,
                   'worstFlag',   d.worst_flag) order by d.ord)
          from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb))
      order by
        case when v_sort = 'oldest' then p.played_at end asc nulls last,
        case when v_sort = 'flags' then p.flag_count end desc,
        case when v_sort = 'flags' then p.worst_flag end asc nulls last,
        case when v_sort = 'ev_loss' then p.ev_loss_bb end desc nulls last,
        case when v_sort = 'ev_loss_pot' then p.ev_loss_pot end desc nulls last,
        case when v_sort = 'score' then p.score end asc nulls last,
        case when v_sort = 'result' and p.big_blind > 0 then p.hero_profit::numeric / p.big_blind end asc nulls last,
        p.played_at desc nulls last,
        p.hand_id), '[]'::jsonb)
    into v_rows
  from page p
  join public.hand_analysis a on a.hand_id = p.hand_id and a.analysis_version = p.analysis_version and a.owner_id = v_owner
  join public.hands h on h.id = p.hand_id and h.owner_id = v_owner;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$$;

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
    if public.analysis_filter_sums_ok(q) then
      v_mode := 'totals';
    elsif q.from_at is null and q.to_at is null and q.formats is null and q."position" is null and q.pot_type is null then
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
      select z.hand_id, z.spot_key, z.chart_set, z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where v_mode in ('rows', 'complement')
        and z.owner_id = v_owner and z.analysis_version = v_version and z.grade is not null
        and (q.site is null or z.site = q.site)
        and (q.formats is null or z.game_format = any (q.formats))
        and (q.currency is null or z.currency = q.currency)
        and (q.big_blind is null or z.big_blind = q.big_blind)
        and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
        and (q.pot_type is null or z.pot_type = q.pot_type)
        and case when v_mode = 'rows'
                 then (q.from_at is null or z.played_at >= q.from_at) and (q.to_at is null or z.played_at < q.to_at)
                 else (q.from_at is not null and (z.played_at < q.from_at or z.played_at is null))
                   or (q.to_at is not null and (z.played_at >= q.to_at or z.played_at is null))
            end
    ),
    s as (
      select t.spot_key, t.chart_set, t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_totals t
      where v_mode in ('totals', 'complement')
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.formats is null or t.game_format = any (q.formats))
        and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
        and (q.pot_type is null or t.pot_type = q.pot_type)
      union all
      select t.spot_key, t.chart_set, t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_stake_totals t
      where v_mode = 'stakes'
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.site is null or t.site = q.site)
        and (q.currency is null or t.currency = q.currency)
        and (q.big_blind is null or t.big_blind = q.big_blind)
      union all
      select g.spot_key, g.chart_set, count(*), count(distinct g.hand_id),
             count(*) filter (where g.grade <> 'perfect'),
             count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             sum(g.ev_loss_bb), sum(g.ev_loss_pot), coalesce(sum(g.score), 0), coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'rows'
      group by 1, 2
      union all
      select g.spot_key, g.chart_set, -count(*), -count(distinct g.hand_id),
             -count(*) filter (where g.grade <> 'perfect'),
             -count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             -sum(g.ev_loss_bb), -sum(g.ev_loss_pot), -coalesce(sum(g.score), 0), -coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'complement'
      group by 1, 2
    ),
    x as materialized (
      select spot_key, chart_set, sum(decisions)::bigint as n, sum(hands)::bigint as hands,
             sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum, sum(score_sq) as score_sq
      from s
      group by spot_key, chart_set
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
                   and (q.pot_type is null or r.pot_type = q.pot_type)),
      'last',   (select max(r.played_at) from public.analysis_hand_rows r
                 where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
                   and (q.from_at is null or r.played_at >= q.from_at)
                   and (q.to_at is null or r.played_at < q.to_at)
                   and (q.site is null or r.site = q.site)
                   and (q.formats is null or r.game_format = any (q.formats))
                   and (q.currency is null or r.currency = q.currency)
                   and (q.big_blind is null or r.big_blind = q.big_blind)
                   and (q."position" is null or r.hero_position = q."position")
                   and (q.pot_type is null or r.pot_type = q.pot_type)),
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
               order by x.spot_key, nullif(x.chart_set, '') nulls first)
        from x), '[]'::jsonb),
      'facets', public.analysis_graded_facets(v_version))
    into v_out;
  end;

  return v_out;
end;
$$;

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
      and (v_table is null or public.analysis_leak_table_of(z.chart_set) = v_table)
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
     and q.big_blind is null and q."position" is null and q.pot_type is null then
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
    and q."position" is null and q.pot_type is null
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

create or replace function public.analysis_top_leaks(p_filters jsonb default '{}'::jsonb, p_period text default '30d')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := auth.uid();
  v_version  text := public.analysis_version_of(p_filters);
  v_formats   text[] := public.filter_formats(p_filters);
  v_position text := nullif(upper(btrim(coalesce(p_filters ->> 'position', ''))), '');
  v_pot      text := nullif(btrim(coalesce(p_filters ->> 'potType', '')), '');
  v_period   text := coalesce(p_period, '30d');
  v_last     date;
  v_now      jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_period not in ('30d', 'all') then
    raise exception 'Unknown period: %', v_period using errcode = '22023';
  end if;

  -- The day of the last graded hand in scope (the hand rows' graded count).
  select (max(r.played_at) at time zone 'UTC')::date into v_last
  from public.analysis_hand_rows r
  where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
    and (v_formats is null or r.game_format = any (v_formats))
    and (v_position is null or r.hero_position = v_position)
    and (v_pot is null or r.pot_type = v_pot);

  v_now := case when v_last is null then null
                else public.analysis_leak_sample(v_owner, v_version, v_formats, v_position, v_pot, v_last - 29, v_last) end;

  return jsonb_build_object(
    'analysisVersion', v_version,
    'period',  v_period,
    'last',    v_last,
    'current', case when v_last is null then null
                    else jsonb_build_object('from', v_last - 29, 'to', v_last) end,
    'prior',   case when v_last is null then null
                    else jsonb_build_object('from', v_last - 59, 'to', v_last - 30) end,
    'sample',  case when v_period = 'all'
                    then public.analysis_leak_sample(v_owner, v_version, v_formats, v_position, v_pot, null, null)
                    else coalesce(v_now, jsonb_build_object('hands', 0, 'graded', 0, 'rows', '[]'::jsonb)) end,
    'now',     coalesce(v_now, jsonb_build_object('hands', 0, 'graded', 0, 'rows', '[]'::jsonb)),
    'was',     case when v_last is null then jsonb_build_object('hands', 0, 'graded', 0, 'rows', '[]'::jsonb)
                    else public.analysis_leak_sample(v_owner, v_version, v_formats, v_position, v_pot,
                                                     v_last - 59, v_last - 30) end);
end;
$$;

CREATE OR REPLACE FUNCTION public.analysis_leak_examples(p_filters jsonb DEFAULT '{}'::jsonb, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_leaks jsonb DEFAULT '[]'::jsonb, p_limit integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner    uuid := auth.uid();
  v_version  text := public.analysis_version_of(p_filters);
  v_formats   text[] := public.filter_formats(p_filters);
  v_position text := nullif(upper(btrim(coalesce(p_filters ->> 'position', ''))), '');
  v_pot      text := nullif(btrim(coalesce(p_filters ->> 'potType', '')), '');
  v_limit    integer := least(greatest(coalesce(p_limit, 15), 1), 30);
  v_out      jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_leaks is null or jsonb_typeof(p_leaks) <> 'array' or jsonb_array_length(p_leaks) > 10 then
    raise exception 'analysis_leak_examples takes at most 10 leaks.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_leaks) l
    where jsonb_typeof(l) <> 'object'
       or jsonb_typeof(l -> 'id') <> 'string' or char_length(l ->> 'id') > 200
       or jsonb_typeof(l -> 'keys') <> 'array'
       or jsonb_array_length(l -> 'keys') not between 1 and 200
       or exists (
         select 1 from jsonb_array_elements(l -> 'keys') k
         where jsonb_typeof(k) <> 'string'
            or (k #>> '{}') !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$')
  ) then
    raise exception 'Not a list of leaks with spot keys.' using errcode = '22023';
  end if;

  with leaks as (
    select l.ordinality as n, l.value ->> 'id' as id,
           array(select jsonb_array_elements_text(l.value -> 'keys')) as keys
    from jsonb_array_elements(p_leaks) with ordinality l
  ),
  picked as (
    select lk.n, lk.id, r.*,
           row_number() over (partition by lk.n order by r.ev_loss_bb desc, r.played_at desc nulls last, r.hand_id, r.ord) as rn
    from leaks lk
    cross join lateral (
      select x.*
      from unnest(lk.keys) k(spot_key)
      cross join lateral (
        select z.hand_id, z.ord, z.action_index, z.played_at, z.spot_key, z.grade, z.ev_loss_bb, z.ev_loss_pot
        from public.analysis_leak_rows z
        where z.owner_id = v_owner and z.analysis_version = v_version and z.spot_key = k.spot_key
          and z.grade <> 'perfect'
          and (p_from is null or z.day >= p_from) and (p_to is null or z.day <= p_to)
          and (v_formats is null or z.game_format = any (v_formats))
          and (v_position is null or z.hero_position = v_position)
          and (v_pot is null or z.pot_type = v_pot)
        order by z.ev_loss_bb desc, z.played_at desc
        limit v_limit
      ) x
    ) r
  )
  select jsonb_build_object('leaks', coalesce(jsonb_agg(jsonb_build_object('id', lk.id, 'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handId',      p.hand_id,
               'ord',         p.ord,
               'actionIndex', p.action_index,
               'playedAt',    p.played_at,
               'site',        h.site,
               'stakesLabel', h.stakes_label,
               'position',    split_part(p.spot_key, '|', 4),
               'heroCards',   to_jsonb(h.hero_cards),
               'handClass',   dd.facts ->> 'handClass',
               'street',      split_part(p.spot_key, '|', 1),
               'scenario',    split_part(p.spot_key, '|', 2),
               'line',        split_part(p.spot_key, '|', 3),
               'taken',       split_part(p.spot_key, '|', 5),
               'best',        split_part(p.spot_key, '|', 6),
               'grade',       p.grade,
               'evLossBb',    p.ev_loss_bb,
               'evLossPot',   p.ev_loss_pot)
             order by p.rn)
      from picked p
      join public.hands h on h.id = p.hand_id and h.owner_id = v_owner
      left join public.decision_analysis dd
        on dd.hand_id = p.hand_id and dd.analysis_version = v_version and dd.ord = p.ord and dd.owner_id = v_owner
      where p.n = lk.n and p.rn <= v_limit), '[]'::jsonb)) order by lk.n), '[]'::jsonb))
    into v_out
  from leaks lk;

  return v_out;
end;
$function$;

-- The leak sums' sample takes the formats (was one format).
drop function public.analysis_leak_sample(uuid, text, text, text, text, date, date);

create or replace function public.analysis_leak_sample(
  p_owner uuid, p_version text, p_formats text[], p_position text, p_pot text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := case when p_owner = auth.uid() then p_owner end;
begin
  if p_from is null and p_to is null then
    return (
      select jsonb_build_object(
        'hands', coalesce((
          select sum(k.graded_hands)::bigint from public.analysis_overview_keys k
          where k.owner_id = v_owner and k.analysis_version = p_version and k.kind = 'all'
            and (p_formats is null or k.game_format = any (p_formats))
            and (p_position is null or k.hero_position = p_position)
            and (p_pot is null or k.pot_type = p_pot)), 0),
        'graded', coalesce(sum(x.n), 0),
        'rows', coalesce(jsonb_agg(jsonb_build_object(
                  'key',        x.spot_key,
                  'set',        nullif(x.chart_set, ''),
                  'street',     split_part(x.spot_key, '|', 1),
                  'scenario',   split_part(x.spot_key, '|', 2),
                  'line',       split_part(x.spot_key, '|', 3),
                  'position',   split_part(x.spot_key, '|', 4),
                  'taken',      split_part(x.spot_key, '|', 5),
                  'best',       split_part(x.spot_key, '|', 6),
                  'decisions',  x.n,
                  'hands',      x.n,
                  'nonPerfect', x.non_perfect,
                  'mistakes',   x.mistakes,
                  'evLossBb',   round(x.ev_bb, 3),
                  'evLossPot',  round(x.ev_pot, 4),
                  'scoreSum',   round(x.score_sum, 2),
                  'scoreSq',    round(x.score_sq, 2))
                order by x.spot_key, nullif(x.chart_set, '') nulls first), '[]'::jsonb))
      from (
        select spot_key, chart_set,
               sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
               sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum,
               sum(score_sq) as score_sq
        from public.analysis_leak_totals
        where owner_id = v_owner and analysis_version = p_version
          and (p_formats is null or game_format = any (p_formats))
          and (p_position is null or hero_position = p_position)
          and (p_pot is null or pot_type = p_pot)
        group by spot_key, chart_set
      ) x);
  end if;

  return (
    with g as materialized (
      select z.hand_id, z.spot_key, z.chart_set, z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where z.owner_id = v_owner and z.analysis_version = p_version and z.grade is not null
        and (p_from is null or z.day >= p_from) and (p_to is null or z.day <= p_to)
        -- the same days as times, so the window is read by the time index (a
        -- day from p_from on has a time; a day up to p_to may have none)
        and (p_from is null or z.played_at >= (p_from::timestamp at time zone 'UTC'))
        and (p_to is null or z.played_at < ((p_to + 1)::timestamp at time zone 'UTC')
             or (p_from is null and z.played_at is null))
        and (p_formats is null or z.game_format = any (p_formats))
        and (p_position is null or z.hero_position = p_position)
        and (p_pot is null or z.pot_type = p_pot)
    )
    select jsonb_build_object(
      'hands', (select count(distinct hand_id) from g),
      'graded', coalesce(sum(x.n), 0),
      'rows', coalesce(jsonb_agg(jsonb_build_object(
                'key',        x.spot_key,
                'set',        nullif(x.chart_set, ''),
                'street',     split_part(x.spot_key, '|', 1),
                'scenario',   split_part(x.spot_key, '|', 2),
                'line',       split_part(x.spot_key, '|', 3),
                'position',   split_part(x.spot_key, '|', 4),
                'taken',      split_part(x.spot_key, '|', 5),
                'best',       split_part(x.spot_key, '|', 6),
                'decisions',  x.n,
                'hands',      x.n,
                'nonPerfect', x.non_perfect,
                'mistakes',   x.mistakes,
                'evLossBb',   round(x.ev_bb, 3),
                'evLossPot',  round(x.ev_pot, 4),
                'scoreSum',   round(x.score_sum, 2),
                'scoreSq',    round(x.score_sq, 2))
              order by x.spot_key, nullif(x.chart_set, '') nulls first), '[]'::jsonb))
    from (
      select spot_key, chart_set, count(*) as n,
             count(*) filter (where grade <> 'perfect') as non_perfect,
             count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot,
             coalesce(sum(score), 0) as score_sum, coalesce(sum(score * score), 0) as score_sq
      from g
      group by spot_key, chart_set
    ) x);
end;
$$;

comment on function public.analysis_leak_sample(uuid, text, text[], text, text, date, date) is
  'One sample of the leak sums, as analysis_leaks returns its rows (R5.2), for some formats (null: all). '
  'Invoker: RLS scopes it to the caller whatever owner is passed.';

revoke all on function public.analysis_leak_sample(uuid, text, text[], text, text, date, date) from public, anon;
grant execute on function public.analysis_leak_sample(uuid, text, text[], text, text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Drills: an optional kind
-- ---------------------------------------------------------------------------

drop function public.drill_queue(text, text[], boolean, integer);
drop function public.drill_summary(text, timestamptz);
drop function public.drill_due_by_spot(text, timestamptz);

CREATE OR REPLACE FUNCTION public.drill_queue(p_version text, p_keys text[] DEFAULT NULL::text[], p_due_only boolean DEFAULT true, p_limit integer DEFAULT 20, p_kind text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_out   jsonb;
  v_formats text[] := public.game_kind_formats(p_kind);
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_queue needs an analysis_version.' using errcode = '22023';
  end if;
  if not public.drill_keys_valid(p_keys) then
    raise exception 'Malformed spot key.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',           q.id,
           'handId',       q.hand_id,
           'actionIndex',  q.action_index,
           'ord',          q.ord,
           'street',       q.street,
           'spotKey',      q.spot_key,
           'sourceGrade',  q.source_grade,
           'sourceEvLossBb', q.source_ev_loss_bb,
           'reps',         q.reps,
           'lapses',       q.lapses,
           'ease',         q.ease,
           'intervalDays', q.interval_days,
           'dueAt',        q.due_at,
           'reviews',      q.reviews,
           'lastGrade',    q.last_grade,
           'due',          q.due_at <= now()) order by q.due_at, q.id), '[]'::jsonb)
  into v_out
  from (
    select di.*
    from public.drill_items di
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (p_keys is null or di.spot_key = any (p_keys))
      and (v_formats is null or exists (
        select 1 from public.hands h
        where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
      and (not coalesce(p_due_only, true) or di.due_at <= now())
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    order by di.due_at, di.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) q;

  return v_out;
end;
$function$;

comment on function public.drill_queue(text, text[], boolean, integer, text) is
  'The caller''s drills to play at a version: due first, optionally only due, optionally only some spots, '
  'optionally one game kind (cash, tournament). Invoker.';

revoke all on function public.drill_queue(text, text[], boolean, integer, text) from public, anon;
grant execute on function public.drill_queue(text, text[], boolean, integer, text) to authenticated;

CREATE OR REPLACE FUNCTION public.drill_summary(p_version text, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_kind text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_until timestamptz := coalesce(p_until, now() + interval '1 day');
  v_out   jsonb;
  v_formats text[] := public.game_kind_formats(p_kind);
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_summary needs an analysis_version.' using errcode = '22023';
  end if;
  if v_until < now() - interval '1 day' or v_until > now() + interval '2 days' then
    raise exception 'drill_summary: "until" must be within a day of now.' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'analysisVersion', p_version,
    'items',     count(*),
    'due',       count(*) filter (where di.due_at <= now()),
    'dueToday',  count(*) filter (where di.due_at <= v_until),
    'learning',  count(*) filter (where di.reps = 0 and di.reviews > 0),
    'mature',    count(*) filter (where di.interval_days >= 21),
    'reviewed',  coalesce(sum(di.reviews), 0),
    'candidates', (
      select count(*)
      from public.decision_analysis d
      where d.owner_id = v_owner
        and d.analysis_version = p_version
        and public.analysis_grade_rank(d.grade) >= public.analysis_grade_rank('mistake')
        and d.chosen is not null
        and jsonb_array_length(d.options) > 0
        and (v_formats is null or exists (
          select 1 from public.hands h
          where h.id = d.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
        and not exists (
          select 1 from public.drill_items x
          where x.owner_id = v_owner and x.hand_id = d.hand_id and x.action_index = d.action_index)))
  into v_out
  from public.drill_items di
  where di.owner_id = v_owner
    and di.analysis_version = p_version
    and (v_formats is null or exists (
      select 1 from public.hands h
      where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
    and exists (
      select 1 from public.decision_analysis d
      where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
        and d.owner_id = v_owner);

  return v_out;
end;
$function$;

comment on function public.drill_summary(text, timestamptz, text) is
  'Drill counts at a version, optionally of one game kind: items, due now, due by p_until, learning, mature, '
  'reviews, and graded Mistakes not drilled yet. Invoker.';

revoke all on function public.drill_summary(text, timestamptz, text) from public, anon;
grant execute on function public.drill_summary(text, timestamptz, text) to authenticated;

create or replace function public.drill_due_by_spot(p_version text, p_until timestamptz default null, p_kind text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_until timestamptz := coalesce(p_until, now() + interval '1 day');
  v_out   jsonb;
  v_formats text[] := public.game_kind_formats(p_kind);
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_due_by_spot needs an analysis_version.' using errcode = '22023';
  end if;

  with drilled as (
    select di.spot_key, count(*) as items, count(*) filter (where di.due_at <= v_until) as due
    from public.drill_items di
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (v_formats is null or exists (
        select 1 from public.hands h
        where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    group by di.spot_key
  ),
  -- Mistakes and blunders at this version not drilled yet: the totals' per
  -- spot, less those a drill item (by hand and action) already holds.
  fresh as (
    select spot_key, sum(items)::bigint as items
    from (
      select t.spot_key, sum(t.g_mistake + t.g_blunder) as items
      from public.analysis_leak_totals t
      where t.owner_id = v_owner and t.analysis_version = p_version
        and (v_formats is null or t.game_format = any (v_formats))
      group by t.spot_key
      union all
      select z.spot_key, -count(*)
      from public.drill_items x
      join public.analysis_leak_rows z
        on z.hand_id = x.hand_id and z.analysis_version = p_version and z.action_index = x.action_index
       and z.owner_id = v_owner
      where x.owner_id = v_owner and z.grade in ('mistake', 'blunder')
        and (v_formats is null or z.game_format = any (v_formats))
      group by z.spot_key
    ) u
    group by spot_key
    having sum(items) > 0
  ),
  keys as (
    select spot_key from drilled union select spot_key from fresh
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',   k.spot_key,
           'items', coalesce(d.items, 0) + coalesce(f.items, 0),
           'due',   coalesce(d.due, 0) + coalesce(f.items, 0)) order by k.spot_key), '[]'::jsonb)
  into v_out
  from keys k
  left join drilled d on d.spot_key = k.spot_key
  left join fresh f on f.spot_key = k.spot_key;

  return v_out;
end;
$$;

comment on function public.drill_due_by_spot(text, timestamptz, text) is
  'Per finest leak spot (analysis_spot_key), optionally of one game kind: drills and drills due by p_until, '
  'counting graded Mistakes not drilled yet as due. Invoker.';

revoke all on function public.drill_due_by_spot(text, timestamptz, text) from public, anon;
grant execute on function public.drill_due_by_spot(text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The opponents panel: a kind as well as a format
-- ---------------------------------------------------------------------------

create or replace function public.stats_opponents(p_filters jsonb default '{}'::jsonb, p_search text default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_site     text := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_formats  public.game_format[];
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_min      integer := greatest(coalesce(nullif(btrim(coalesce(p_filters ->> 'minHands', '')), '')::integer, 1), 1);
  v_cap      integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_pattern  text;
  v_rows     jsonb;
  v_kinds    integer;
  v_hidden   bigint;
  v_total    bigint;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  -- One format (`gameFormat`) or a kind's (`gameKind`); an unknown format raises as before.
  v_formats := public.filter_formats(p_filters)::public.game_format[];
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_pattern := replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- R4.5c: from `player_stats` (the opponents' rows summed as they are
  -- written) instead of every villain row; the same answer.
  select
    (case when bool_or(p.game_format = 'cash') then 1 else 0 end) + (case when bool_or(p.game_format <> 'cash') then 1 else 0 end),
    coalesce(sum(p.hands) filter (where p.site_anonymization = 'opaque-id'), 0),
    coalesce(sum(p.hands), 0)
  into v_kinds, v_hidden, v_total
  from public.player_stats p
  where p.owner_id = v_owner
    and p.stats_version = v_version
    and (v_site is null or p.site_id = v_site)
    and (v_formats is null or p.game_format = any (v_formats))
    and (v_currency is null or p.currency = v_currency)
    and (v_big_blind is null or p.big_blind = v_big_blind);

  with agg as (
    select
      p.site_id                       as site,
      p.player                        as player,
      sum(p.hands)::bigint            as hands,
      sum(p.vpip_opp)::bigint as vpip_opp, sum(p.vpip)::bigint as vpip,
      sum(p.pfr_opp)::bigint as pfr_opp, sum(p.pfr)::bigint as pfr,
      sum(p.three_bet_opp)::bigint as three_bet_opp, sum(p.three_bet)::bigint as three_bet,
      sum(p.fold_to_three_bet_opp)::bigint as fold_to_three_bet_opp, sum(p.fold_to_three_bet)::bigint as fold_to_three_bet,
      sum(p.cbet_flop_opp)::bigint as cbet_flop_opp, sum(p.cbet_flop)::bigint as cbet_flop,
      sum(p.fold_to_cbet_flop_opp)::bigint as fold_to_cbet_flop_opp, sum(p.fold_to_cbet_flop)::bigint as fold_to_cbet_flop,
      sum(p.wtsd_opp)::bigint as wtsd_opp, sum(p.wtsd)::bigint as wtsd,
      sum(p.wsd_opp)::bigint as wsd_opp, sum(p.wsd)::bigint as wsd,
      sum(p.bets)::bigint as bets, sum(p.raises)::bigint as raises,
      sum(p.calls)::bigint as calls, sum(p.folds)::bigint as folds,
      max(p.last_played_at)           as last_seen,
      bool_and(p.seen_exact)          as seen_exact,
      sum(p.hero_net_bb_milli)::bigint as hero_net_bb_milli,
      sum(p.hero_money_hands)::bigint  as hero_money_hands
    from public.player_stats p
    where p.owner_id = v_owner
      and p.stats_version = v_version
      and p.site_anonymization = 'none'
      and (v_site is null or p.site_id = v_site)
      and (v_formats is null or p.game_format = any (v_formats))
      and (v_currency is null or p.currency = v_currency)
      and (v_big_blind is null or p.big_blind = v_big_blind)
      and (v_pattern is null or lower(p.player) like v_pattern)
    group by p.site_id, p.player
    having sum(p.hands) >= v_min
  ),
  top as (
    select * from agg order by hands desc, player limit v_cap
  )
  select coalesce(jsonb_agg(to_jsonb(a) - 'seen_exact' order by a.hands desc, a.player), '[]'::jsonb)
  into v_rows
  from (
    select t.site, t.player, t.hands,
           t.vpip_opp, t.vpip, t.pfr_opp, t.pfr,
           t.three_bet_opp, t.three_bet, t.fold_to_three_bet_opp, t.fold_to_three_bet,
           t.cbet_flop_opp, t.cbet_flop, t.fold_to_cbet_flop_opp, t.fold_to_cbet_flop,
           t.wtsd_opp, t.wtsd, t.wsd_opp, t.wsd,
           t.bets, t.raises, t.calls, t.folds,
           -- A delete touched one of the rows: the newest hand read again.
           case when t.seen_exact then t.last_seen else (
             select max(s.played_at) from public.hand_stats s
             where s.owner_id = v_owner and s.stats_version = v_version and not s.is_hero
               and s.player = t.player and s.site_id = t.site and not s.is_bomb_pot
               and s.site_anonymization = 'none'
               and (v_formats is null or s.game_format = any (v_formats))
               and (v_currency is null or s.currency = v_currency)
               and (v_big_blind is null or coalesce(s.big_blind, 0) = v_big_blind)) end as last_seen,
           t.hero_net_bb_milli, t.hero_money_hands
    from top t
  ) a;

  if coalesce(v_kinds, 0) > 1 then
    v_rows := (select coalesce(jsonb_agg(r - 'hero_net_bb_milli' - 'hero_money_hands'), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r);
  end if;

  return jsonb_build_object(
    'statsVersion',  v_version,
    'rows',          v_rows,
    'mixedUnitKind', coalesce(v_kinds, 0) > 1,
    'opaqueRows',    coalesce(v_hidden, 0),
    'villainRows',   coalesce(v_total, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The entitlement gates follow the new signatures
-- ---------------------------------------------------------------------------

update public.entitlement_gates set function_sig = 'public.analysis_leak_sample(uuid,text,text[],text,text,date,date)'
 where function_sig = 'public.analysis_leak_sample(uuid,text,text,text,text,date,date)';
update public.entitlement_gates set function_sig = 'public.drill_queue(text,text[],boolean,integer,text)'
 where function_sig = 'public.drill_queue(text,text[],boolean,integer)';
update public.entitlement_gates set function_sig = 'public.drill_summary(text,timestamp with time zone,text)'
 where function_sig = 'public.drill_summary(text,timestamp with time zone)';
update public.entitlement_gates set function_sig = 'public.drill_due_by_spot(text,timestamp with time zone,text)'
 where function_sig = 'public.drill_due_by_spot(text,timestamp with time zone)';

commit;

-- The R6.2 entitlement gate, back on the re-created readers.
select public.entitlement_gates_apply();
