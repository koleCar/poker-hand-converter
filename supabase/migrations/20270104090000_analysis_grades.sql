-- ===========================================================================
-- Hand analysis, phase A2b: the reports learn about grades
-- ===========================================================================
--
-- `analysis/2` writes graded preflop decisions (`source = 'chart'`, a grade,
-- an EV loss in bb and in % of the pot, a score). The tables already had the
-- columns -- A1 shaped them so that this phase would need no table change --
-- so this migration only teaches the reports to read them:
--
--   analysis_scope      two new filters: `grade` (the hand's worst grade is
--                       exactly this) and `minGrade` (... at least this bad:
--                       `mistake` is "has a mistake or a blunder").
--   analysis_overview   graded hands and moves, EV loss in % of the pot, and
--                       the Perfect...Blunder distribution per street.
--   analysis_breakdown  per group: graded moves, the five grade counts, EV
--                       loss and mean score; a new group `preflop_scenario`
--                       (preflop decisions only, keyed by spot).
--   analysis_hands      a new sort `ev_loss_pot`; each decision carries its
--                       EV loss, so a list can say what a red letter cost.
--
-- ## The security model, unchanged (`20261228090000_analysis.sql`)
--
--   * No table grant changes: still `select` to `authenticated` under RLS,
--     nothing to `anon`, no client INSERT / UPDATE / DELETE.
--   * Every function here is a read: `security invoker`, so RLS scopes every
--     row it sums, `search_path = ''`, everything schema-qualified.
--   * `analysis_scope` and `analysis_version_of` stay executable by
--     `authenticated`, because the invoker reports call them as their caller
--     (the lesson of `20261109090000`). `create or replace` keeps a
--     function's grants, and they are restated below anyway.
--   * Group keys, sort keys and grade names are whitelisted literals; nothing
--     from the client is ever a column name.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. analysis_scope: grade filters
-- ---------------------------------------------------------------------------
--
-- `grade` and `minGrade` take one of the five grade names; anything else is
-- 22023 rather than an empty page, so a typo in a link is visible.

create or replace function public.analysis_grade_rank(p_grade text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select array_position(array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'], p_grade);
$$;

comment on function public.analysis_grade_rank(text) is
  'Severity of a grade name: perfect 1, good 2, inaccurate 3, mistake 4, blunder 5; null for anything else.';

revoke all on function public.analysis_grade_rank(text) from public, anon;
grant execute on function public.analysis_grade_rank(text) to authenticated;

create or replace function public.analysis_scope(p_filters jsonb default '{}'::jsonb)
returns setof public.hand_analysis
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_grade     text := nullif(btrim(coalesce(p_filters ->> 'grade', '')), '');
  v_min_grade text := nullif(btrim(coalesce(p_filters ->> 'minGrade', '')), '');
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
  join public.hands h on h.id = a.hand_id
  where a.owner_id = (select auth.uid())
    and a.analysis_version = public.analysis_version_of(p_filters)
    and (nullif(p_filters ->> 'from', '') is null or h.played_at >= (p_filters ->> 'from')::timestamptz)
    and (nullif(p_filters ->> 'to', '') is null or h.played_at < (p_filters ->> 'to')::timestamptz)
    and (nullif(p_filters ->> 'site', '') is null or h.site = lower(btrim(p_filters ->> 'site')))
    and (nullif(p_filters ->> 'gameFormat', '') is null or h.game_format::text = p_filters ->> 'gameFormat')
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
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
            and d.street = p_filters ->> 'street'))
    and (nullif(p_filters ->> 'flag', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
            and d.flags @> jsonb_build_array(jsonb_build_object('code', p_filters ->> 'flag'))));
end;
$$;

comment on function public.analysis_scope(jsonb) is
  'The caller''s hand_analysis rows at one version, filtered (incl. grade / minGrade). '
  'Shared by the analysis reports; invoker, so RLS applies.';

revoke all on function public.analysis_scope(jsonb) from public, anon;
grant execute on function public.analysis_scope(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. analysis_overview: graded moves and the grade distribution
-- ---------------------------------------------------------------------------
--
-- New keys:
--   gradedHands      hands with at least one graded decision (the
--                    denominator of "EV loss per 100 hands")
--   graded           graded decisions ("moves")
--   evLossPot        sum of the graded decisions' EV loss in % of the pot,
--                    for "% of the pot per mistake" style numbers
--   badHands         hands whose worst grade is a Mistake or a Blunder
--   gradesByStreet   [{street, grade, decisions}]
-- Everything A1 returned is returned unchanged.

create or replace function public.analysis_overview(p_filters jsonb default '{}'::jsonb)
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
    select dd.*
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
  ),
  f as (
    select d.street, fl ->> 'code' as code, fl ->> 'severity' as severity
    from d, jsonb_array_elements(d.flags) fl
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',           (select count(*) from s),
    'status', jsonb_build_object(
      'full',        (select count(*) from s where status = 'full'),
      'partial',     (select count(*) from s where status = 'partial'),
      'notAnalysed', (select count(*) from s where status = 'not-analysed')),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'hands', r.n) order by r.n desc, r.reason)
      from (select reason, count(*) as n from s where status = 'not-analysed' group by reason) r), '[]'::jsonb),
    'skipped', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'decisions', r.n) order by r.n desc, r.reason)
      from (select reason, count(*) as n from d where status = 'not-analysed' group by reason) r), '[]'::jsonb),
    'decisions',      (select count(*) from d),
    'analysed',       (select count(*) from d where status = 'analysed'),
    'flagged',        (select count(*) from d where worst_flag is not null),
    'flaggedHands',   (select count(*) from s where flag_count > 0),
    'flags', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'street', x.street, 'severity', x.severity, 'count', x.n)
                       order by x.n desc, x.code, x.street)
      from (select code, street, severity, count(*) as n from f group by 1, 2, 3) x), '[]'::jsonb),
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
               count(*) as n,
               count(*) filter (where status = 'analysed') as analysed,
               count(*) filter (where worst_flag is not null) as flagged,
               count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop') as facing,
               count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop' and action in ('call', 'raise')) as defended,
               round(avg(mdf) filter (where facing_bet and status = 'analysed' and street <> 'preflop'), 3) as mdf
        from d group by street) x), '[]'::jsonb),
    'grades', coalesce((
      select jsonb_agg(jsonb_build_object('grade', x.grade, 'decisions', x.n)
                       order by public.analysis_grade_rank(x.grade))
      from (select grade, count(*) as n from d where grade is not null group by grade) x), '[]'::jsonb),
    'gradesByStreet', coalesce((
      select jsonb_agg(jsonb_build_object('street', x.street, 'grade', x.grade, 'decisions', x.n)
                       order by array_position(array['preflop', 'flop', 'turn', 'river'], x.street),
                                public.analysis_grade_rank(x.grade))
      from (select street, grade, count(*) as n from d where grade is not null group by street, grade) x), '[]'::jsonb),
    'graded',      (select count(*) from d where grade is not null),
    'gradedHands', (select count(*) from s where grade is not null),
    'badHands',    (select count(*) from s where public.analysis_grade_rank(grade) >= 4),
    'score',       (select round(avg(score), 2) from d where score is not null),
    'evLossBb',    (select round(sum(ev_loss_bb), 3) from d where ev_loss_bb is not null),
    'evLossPot',   (select round(sum(ev_loss_pot), 4) from d where ev_loss_pot is not null),
    'approximations', coalesce((
      select jsonb_agg(jsonb_build_object('approximation', x.ap, 'hands', x.n) order by x.n desc, x.ap)
      from (select ap, count(*) as n from s, unnest(s.approximations) ap group by ap) x), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.analysis_overview(jsonb) from public, anon;
grant execute on function public.analysis_overview(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. analysis_breakdown: grades per group, and the preflop scenario
-- ---------------------------------------------------------------------------
--
-- Groups: `street`, `position` (the hero's), `pot_type`, `scenario` (every
-- decision's spot), and `preflop_scenario` -- the same spot key over preflop
-- decisions only, which is what "by preflop scenario" means (§6.0).

create or replace function public.analysis_breakdown(
  p_filters jsonb default '{}'::jsonb,
  p_group   text  default 'street'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_rows  jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('street', 'position', 'pot_type', 'scenario', 'preflop_scenario') then
    raise exception 'Unknown analysis breakdown: %', coalesce(p_group, 'null') using errcode = '22023';
  end if;

  with s as (select * from public.analysis_scope(p_filters)),
  d as (
    select dd.*, h.hero_position, s.pot_type as hand_pot_type
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    join public.hands h on h.id = dd.hand_id
    where p_group <> 'preflop_scenario' or dd.street = 'preflop'
  ),
  keyed as (
    select case p_group
             when 'street'   then d.street
             when 'position' then d.hero_position
             when 'pot_type' then d.hand_pot_type
             else d.scenario
           end as key,
           d.*
    from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',         x.key,
           'hands',       x.hands,
           'decisions',   x.n,
           'analysed',    x.analysed,
           'flagged',     x.flagged,
           'inaccurate',  x.inaccurate,
           'facingBet',   x.facing,
           'defended',    x.defended,
           'mdf',         x.mdf,
           'graded',      x.graded,
           'gradedHands', x.graded_hands,
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
           count(distinct hand_id) as hands,
           count(*) as n,
           count(*) filter (where status = 'analysed') as analysed,
           count(*) filter (where worst_flag is not null) as flagged,
           count(*) filter (where worst_flag = 'inaccurate') as inaccurate,
           count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop') as facing,
           count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop' and action in ('call', 'raise')) as defended,
           round(avg(mdf) filter (where facing_bet and status = 'analysed' and street <> 'preflop'), 3) as mdf,
           count(*) filter (where grade is not null) as graded,
           count(distinct hand_id) filter (where grade is not null) as graded_hands,
           count(*) filter (where grade = 'perfect') as g_perfect,
           count(*) filter (where grade = 'good') as g_good,
           count(*) filter (where grade = 'inaccurate') as g_inaccurate,
           count(*) filter (where grade = 'mistake') as g_mistake,
           count(*) filter (where grade = 'blunder') as g_blunder,
           round(sum(ev_loss_bb) filter (where grade is not null), 3) as ev_loss,
           round(avg(score) filter (where grade is not null), 2) as score
    from keyed
    group by key
  ) x;

  return jsonb_build_object('group', p_group, 'rows', v_rows);
end;
$$;

revoke all on function public.analysis_breakdown(jsonb, text) from public, anon;
grant execute on function public.analysis_breakdown(jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. analysis_hands: sort by EV loss in % of the pot; EV loss per decision
-- ---------------------------------------------------------------------------

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
as $$
declare
  v_owner  uuid := (select auth.uid());
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'recent');
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_sort not in ('recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  select count(*) into v_total from public.analysis_scope(p_filters);

  select coalesce(jsonb_agg(row_json order by rn), '[]'::jsonb)
    into v_rows
  from (
    select
      row_number() over (
        order by
          case when v_sort = 'oldest' then h.played_at end asc nulls last,
          case when v_sort = 'flags' then a.flag_count end desc,
          case when v_sort = 'flags' then a.worst_flag end asc nulls last,
          case when v_sort = 'ev_loss' then a.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then a.ev_loss_pot end desc nulls last,
          case when v_sort = 'score' then a.score end asc nulls last,
          case when v_sort = 'result' and h.big_blind > 0
               then h.hero_profit::numeric / h.big_blind end asc nulls last,
          h.played_at desc nulls last,
          a.hand_id
      ) as rn,
      jsonb_build_object(
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
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version), '[]'::jsonb)
      ) as row_json
    from public.analysis_scope(p_filters) a
    join public.hands h on h.id = a.hand_id
    order by rn
    offset v_offset
    limit v_limit
  ) page;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$$;

revoke all on function public.analysis_hands(jsonb, text, integer, integer) from public, anon;
grant execute on function public.analysis_hands(jsonb, text, integer, integer) to authenticated;

commit;
