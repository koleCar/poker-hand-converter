-- ===========================================================================
-- Rail: drills and top-leak examples read on a leak area's table
-- ===========================================================================
--
-- Since 20271103090000 a postflop leak area carries its table (`~hu`,
-- `~9max`; 6-max untagged) and its hands are read on it
-- (`analysis_leak_hands`' `filters.leakTable`, `analysis_leak_table_of`).
-- A spot key names no table, though, and three readers still went by spot
-- key only, so a heads-up area counted and dealt the 6-max blinds' items on
-- the same key (`docs/ANALYSIS-PLAN.md` §10, 2026-11-02, "Open"). A drill
-- item and an example keep their hand, so each can be read on a table: the
-- table of a decision is its leak row's (`analysis_leak_rows.chart_set`,
-- the hand's table for a postflop decision since 20271102090000, the chart
-- grade's set preflop), tagged by `analysis_leak_table_of` (`hu`, `9max`,
-- `other`); a drill item with no leak row (none expected: the rows are kept
-- with every graded decision) is `other`.
--
-- What changes:
--
--   * `drill_due_by_spot_tables(version, until)`: new, `drill_due_by_spot`
--     (`20270825090000`'s, the last definition, unchanged and kept) with each
--     row also saying `tables`, its items and due per table
--     (`{"hu": {"items": n, "due": n}, ...}`, only the tables it has). A
--     row's own `key`, `items` and `due` are `drill_due_by_spot`'s (every
--     table, computed the same way).
--   * `drill_queue_on_table(version, table, keys, due_only, limit)`: new,
--     `drill_queue` (`20270818090000`'s, unchanged and kept) restricted to
--     the drill items on one table (`hu`, `9max` or `other`; anything else
--     refused); each item also says its `table`.
--     New functions rather than a changed answer or a sixth argument: the
--     old readers' answers stay byte for byte what the regression tests
--     compare (`owner_first_analysis`, `analysis_screen_summaries`), and an
--     added defaulted argument would change the signature every grant, gate
--     and test names. Both are invoker, empty search_path, `authenticated`
--     only, gated (listed in `entitlement_gates`, drills; the gate written
--     in by `entitlement_gates_apply()`).
--   * `analysis_leak_examples` (`20270818090000`'s, the last definition): a
--     leak in `p_leaks` may say `table` (`hu`, `9max`, `other`; absent or
--     null: every table, as before); its examples are then that table's
--     only. Any other value is refused. Signature, grants and comment
--     otherwise unchanged; the gate is put back.
--
-- After `20271104090000_game_kind_filter.sql` (one game kind at a time), so
-- both new readers take its optional last `p_kind` as `drill_due_by_spot` and
-- `drill_queue` do there, and `analysis_leak_examples` is that migration's
-- definition (`filter_formats`) plus the table. (Written as 20271104090000;
-- renamed when both met on staging, two migrations cannot share a version.)
--
-- Not changed: no table, no grade, no `analysis/N`; nothing is written; a
-- call without a table returns what it returned. Client writes: none.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Drills due per spot and per table
-- ---------------------------------------------------------------------------

-- `drill_due_by_spot` (`20270825090000_analysis_screen_summaries.sql`'s
-- definition) with the per-table breakdown; the key's own counts are
-- computed as there. `drill_due_by_spot` itself is unchanged.
create or replace function public.drill_due_by_spot_tables(p_version text, p_until timestamptz default null, p_kind text default null)
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
    raise exception 'drill_due_by_spot_tables needs an analysis_version.' using errcode = '22023';
  end if;

  with drilled_t as (
    select di.spot_key, public.analysis_leak_table_of(z.chart_set) as tbl,
           count(*) as items, count(*) filter (where di.due_at <= v_until) as due
    from public.drill_items di
    left join public.analysis_leak_rows z
      on z.hand_id = di.hand_id and z.analysis_version = di.analysis_version and z.ord = di.ord
     and z.owner_id = v_owner
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (v_formats is null or exists (
        select 1 from public.hands h
        where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    group by di.spot_key, public.analysis_leak_table_of(z.chart_set)
  ),
  drilled as (
    select spot_key, sum(items)::bigint as items, sum(due)::bigint as due
    from drilled_t
    group by spot_key
  ),
  -- Mistakes and blunders at this version not drilled yet: the totals' per
  -- spot and table, less those a drill item (by hand and action) already holds.
  fresh_u as (
    select t.spot_key, public.analysis_leak_table_of(t.chart_set) as tbl, sum(t.g_mistake + t.g_blunder) as items
    from public.analysis_leak_totals t
    where t.owner_id = v_owner and t.analysis_version = p_version
      and (v_formats is null or t.game_format = any (v_formats))
    group by t.spot_key, public.analysis_leak_table_of(t.chart_set)
    union all
    select z.spot_key, public.analysis_leak_table_of(z.chart_set), -count(*)
    from public.drill_items x
    join public.analysis_leak_rows z
      on z.hand_id = x.hand_id and z.analysis_version = p_version and z.action_index = x.action_index
     and z.owner_id = v_owner
    where x.owner_id = v_owner and z.grade in ('mistake', 'blunder')
      and (v_formats is null or z.game_format = any (v_formats))
    group by z.spot_key, public.analysis_leak_table_of(z.chart_set)
  ),
  -- The key's count as before: summed over its tables, then kept when positive.
  fresh as (
    select spot_key, sum(items)::bigint as items
    from fresh_u
    group by spot_key
    having sum(items) > 0
  ),
  fresh_t as (
    select u.spot_key, u.tbl, sum(u.items)::bigint as items
    from fresh_u u
    where u.spot_key in (select f.spot_key from fresh f)
    group by u.spot_key, u.tbl
    having sum(u.items) > 0
  ),
  per_table as (
    select coalesce(d.spot_key, f.spot_key) as spot_key,
           jsonb_object_agg(coalesce(d.tbl, f.tbl), jsonb_build_object(
             'items', coalesce(d.items, 0) + coalesce(f.items, 0),
             'due',   coalesce(d.due, 0) + coalesce(f.items, 0))) as tables
    from drilled_t d
    full join fresh_t f on f.spot_key = d.spot_key and f.tbl = d.tbl
    group by coalesce(d.spot_key, f.spot_key)
  ),
  keys as (
    select spot_key from drilled union select spot_key from fresh
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',    k.spot_key,
           'items',  coalesce(d.items, 0) + coalesce(f.items, 0),
           'due',    coalesce(d.due, 0) + coalesce(f.items, 0),
           'tables', coalesce(pt.tables, '{}'::jsonb)) order by k.spot_key), '[]'::jsonb)
  into v_out
  from keys k
  left join drilled d on d.spot_key = k.spot_key
  left join fresh f on f.spot_key = k.spot_key
  left join per_table pt on pt.spot_key = k.spot_key;

  return v_out;
end;
$$;

comment on function public.drill_due_by_spot_tables(text, timestamptz, text) is
  'drill_due_by_spot with each key''s counts also per table (tables: hu, 9max, other; the drill''s or '
  'Mistake''s leak row''s set, analysis_leak_table_of). 20271104120000. Invoker.';

revoke all on function public.drill_due_by_spot_tables(text, timestamptz, text) from public, anon;
grant execute on function public.drill_due_by_spot_tables(text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The drill queue on one table
-- ---------------------------------------------------------------------------

-- `drill_queue` (`20270818090000_big_account_readers.sql`'s definition) with
-- the table filter; `drill_queue` itself is unchanged.
create or replace function public.drill_queue_on_table(
  p_version  text,
  p_table    text,
  p_keys     text[]  default null,
  p_due_only boolean default true,
  p_limit    integer default 20,
  p_kind     text    default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_table text := nullif(btrim(coalesce(p_table, '')), '');
  v_out   jsonb;
  v_formats text[] := public.game_kind_formats(p_kind);
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_queue_on_table needs an analysis_version.' using errcode = '22023';
  end if;
  if v_table is null or v_table not in ('hu', '9max', 'other') then
    raise exception 'Unknown leak table: %', coalesce(p_table, 'null') using errcode = '22023';
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
           'table',        q.tbl,
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
    select di.*, public.analysis_leak_table_of(z.chart_set) as tbl
    from public.drill_items di
    left join public.analysis_leak_rows z
      on z.hand_id = di.hand_id and z.analysis_version = di.analysis_version and z.ord = di.ord
     and z.owner_id = v_owner
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (p_keys is null or di.spot_key = any (p_keys))
      and (not coalesce(p_due_only, true) or di.due_at <= now())
      and public.analysis_leak_table_of(z.chart_set) = v_table
      and (v_formats is null or exists (
        select 1 from public.hands h
        where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    order by di.due_at, di.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) q;

  return v_out;
end;
$$;

comment on function public.drill_queue_on_table(text, text, text[], boolean, integer, text) is
  'drill_queue on one table (hu, 9max, other: the item''s leak row''s set, analysis_leak_table_of): the '
  'caller''s drills at the version, due first. 20271104120000. Invoker.';

revoke all on function public.drill_queue_on_table(text, text, text[], boolean, integer, text) from public, anon;
grant execute on function public.drill_queue_on_table(text, text, text[], boolean, integer, text) to authenticated;

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.drill_due_by_spot_tables(text,timestamp with time zone,text)', 'analysis', 'drills'),
  ('public.drill_queue_on_table(text,text,text[],boolean,integer,text)', 'analysis', 'drills')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

-- ---------------------------------------------------------------------------
-- 3. A top leak's examples on its table
-- ---------------------------------------------------------------------------

-- `20270818090000_big_account_readers.sql`'s definition, with a leak's
-- optional `table`; everything else unchanged.
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
  if exists (
    select 1 from jsonb_array_elements(p_leaks) l
    where coalesce(jsonb_typeof(l -> 'table'), 'null') <> 'null'
      and (jsonb_typeof(l -> 'table') <> 'string' or (l ->> 'table') not in ('hu', '9max', 'other'))
  ) then
    raise exception 'Unknown leak table.' using errcode = '22023';
  end if;

  with leaks as (
    select l.ordinality as n, l.value ->> 'id' as id,
           array(select jsonb_array_elements_text(l.value -> 'keys')) as keys,
           l.value ->> 'table' as tbl
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
          and (lk.tbl is null or public.analysis_leak_table_of(z.chart_set) = lk.tbl)
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

revoke all on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) from public, anon;
grant execute on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) to authenticated;

commit;

-- The R6.2 entitlement gate, on the re-created reader and the two new ones.
select public.entitlement_gates_apply();
