-- Heads-up only for the web's Overview, Trends and Reports (analysis/45-46,
-- owner 2026-11-19: bomb pots and multiway pots have their own pages).
--
-- Every analysis reader below takes `potKind: 'hu'` in its filters: bomb pots
-- (`pot_type = 'bomb'`) are left out. Where a summary keeps the pot type it is
-- filtered there; where it does not (the trend's day sums, the node totals)
-- the reader takes its row path, which keeps it; the scan paths read
-- `analysis_scope`, which leaves bomb pots out too. Multiway decisions need no
-- filter: since analysis/46 a hand three or more saw the flop of has no
-- postflop grade, so they only count as decisions not analysed (`multiway`).
--
-- The bodies are the latest ones (20271104090000_game_kind_filter.sql,
-- 20271116110000_analysis_hands_filter.sql) with only those lines added.

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
    -- analysis/46+: `potKind: 'hu'` leaves bomb pots out (they have their own page).
    and (coalesce(p_filters ->> 'potKind', '') <> 'hu' or a.pot_type is distinct from 'bomb')
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


create or replace function public.analysis_overview(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_hu      boolean := coalesce(p_filters ->> 'potKind', '') = 'hu';
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
      and (not v_hu or t.pot_type is distinct from 'bomb')
  ),
  d as materialized (
    select * from public.analysis_overview_decisions t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
      and (not v_hu or t.pot_type is distinct from 'bomb')
  ),
  fl as (
    select * from public.analysis_overview_flags t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.formats is null or t.game_format = any (q.formats))
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
      and (not v_hu or t.pot_type is distinct from 'bomb')
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
  v_hu      boolean := coalesce(p_filters ->> 'potKind', '') = 'hu';
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
      and (not v_hu or t.pot_type is distinct from 'bomb')
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
      and (not v_hu or t.pot_type is distinct from 'bomb')
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
  v_hu      boolean := coalesce(p_filters ->> 'potKind', '') = 'hu';
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
      and (not v_hu or t.pot_type is distinct from 'bomb')
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
      and (not v_hu or r.pot_type is distinct from 'bomb')
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
      and (not v_hu or r.pot_type is distinct from 'bomb')
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
  v_hu      boolean := coalesce(p_filters ->> 'potKind', '') = 'hu';
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
    and q."position" is null and q.pot_type is null and q.hands is null and not v_hu
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
      and (not v_hu or r.pot_type is distinct from 'bomb')
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
      and (not v_hu or r.pot_type is distinct from 'bomb')
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


create or replace function public.analysis_node_actions(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_hu      boolean := coalesce(p_filters ->> 'potKind', '') = 'hu';
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
     and q.big_blind is null and q."position" is null and q.pot_type is null and q.hands is null and not v_hu then
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
      and (not v_hu or z.pot_type is distinct from 'bomb')
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
  v_hu      boolean := coalesce(p_filters ->> 'potKind', '') = 'hu';
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
      and (not v_hu or z.pot_type is distinct from 'bomb')
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

