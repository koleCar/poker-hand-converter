-- ===========================================================================
-- Rail: a postflop leak area per table; its hands read on its table
-- ===========================================================================
--
-- Since 20271102090000 a flop, turn or river leak row carries its hand's
-- table (`analysis_leak_rows.chart_set`), and from this change the leak
-- finder tags a postflop spot by it as it tags a preflop chart spot
-- (`web/src/lib/analysis/leaks.ts`: a heads-up spot's id ends in `~hu`, a
-- full-ring one's in `~9max`; `docs/ANALYSIS-PLAN.md` §10, 2026-11-02). A
-- heads-up, a 6-max and a 9-max river area with the same seat, role and side
-- are now three areas. A spot key names no table, though, so the hands
-- behind a heads-up area, read by its spot keys, were every table's.
--
-- What changes:
--
--   * `analysis_leak_table_of(set)`: the leak finder's table tag of a chart
--     set id - `hu` (`-hu-`), `9max` (`-9max-`), `other` for 6-max, the
--     straddle set and no set (`tableOfSet`). Immutable, reads nothing but
--     its argument; executable by `authenticated` (the invoker readers call
--     it), not by `anon`.
--   * `analysis_leak_hands` and `analysis_leak_hands_scan`
--     (`20270825090000`'s, the last definitions) take an optional
--     `leakTable` filter key (`hu`, `9max` or `other`; absent: every table,
--     as before): only the decisions whose set has that tag. The fast path
--     reads the row's `chart_set`; the scan the set the leak scan reads
--     (`facts.chart.set` for a chart grade, the hand's table for a postflop
--     decision). Any other value is refused. Signatures, grants and
--     comments otherwise unchanged; the R6.2 entitlement gate is put back
--     with `entitlement_gates_apply()`.
--
-- Not changed: no table, no grade, no `analysis/N`; nothing is written; a
-- call without `leakTable` returns what it returned. Drills stay by spot
-- key (`drill_due_by_spot`).
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A set's table tag
-- ---------------------------------------------------------------------------

create or replace function public.analysis_leak_table_of(p_set text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when coalesce(p_set, '') ~ '-hu-' then 'hu'
           when coalesce(p_set, '') ~ '-9max-' then '9max'
           else 'other'
         end;
$$;

comment on function public.analysis_leak_table_of(text) is
  'The leak finder''s table tag of a chart set id: hu, 9max, or other (6-max, straddle, none). 20271103090000.';

revoke all on function public.analysis_leak_table_of(text) from public, anon;
grant execute on function public.analysis_leak_table_of(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The hands behind a leak, on its table
-- ---------------------------------------------------------------------------

-- `20270825090000_analysis_screen_summaries.sql`'s definition, with the
-- `leakTable` filter; everything else unchanged.
CREATE OR REPLACE FUNCTION public.analysis_leak_hands_scan(p_filters jsonb DEFAULT '{}'::jsonb, p_keys text[] DEFAULT NULL::text[], p_deviations boolean DEFAULT true, p_sort text DEFAULT 'ev_loss'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  v_table  text := nullif(btrim(coalesce(p_filters ->> 'leakTable', '')), '');
  v_version text := public.analysis_version_of(p_filters);
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

  with m as materialized (
    select g.*
    from public.analysis_graded_decisions(p_filters) g
    -- The decision's set as the leak rows keep it (20271102090000), read only under a table filter.
    left join public.decision_analysis dt
      on v_table is not null and g.source = 'chart'
     and dt.hand_id = g.hand_id and dt.ord = g.ord and dt.analysis_version = v_version and dt.owner_id = v_owner
    left join public.hands ht
      on v_table is not null and g.street <> 'preflop' and ht.id = g.hand_id and ht.owner_id = v_owner
    where g.spot_key = any (p_keys)
      and (not v_dev or g.grade <> 'perfect')
      and (v_table is null
           or public.analysis_leak_table_of(
                case when g.source = 'chart'
                      and coalesce(dt.facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
                     then dt.facts -> 'chart' ->> 'set'
                     when g.street <> 'preflop'
                     then public.analysis_hand_table_set(ht.phf) end) = v_table)
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
    join public.hands h on h.id = m.hand_id and h.owner_id = v_owner
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
            and dd.analysis_version = public.analysis_version_of(p_filters) and dd.owner_id = v_owner), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$function$;

revoke all on function public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer) from public, anon;
grant execute on function public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer) to authenticated;

-- `20270825090000_analysis_screen_summaries.sql`'s definition, with the
-- `leakTable` filter; everything else unchanged.
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
      and (q.format is null or z.game_format = q.format)
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

comment on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) is
  'One page of the caller''s graded decisions at the given leak spots (by default only those worse '
  'than Perfect), with their hands, costliest first; filters.leakTable (hu, 9max, other) keeps one '
  'table (20271103090000). Invoker.';

revoke all on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) from public, anon;
grant execute on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) to authenticated;

commit;

-- The R6.2 entitlement gate, back on the two re-created readers.
select public.entitlement_gates_apply();
