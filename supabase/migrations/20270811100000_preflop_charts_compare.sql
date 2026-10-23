-- ===========================================================================
-- Rail R5.3: the played preflop decisions a user's chart is compared with
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R5.3; the comparison is `packages/ui/charts/compare.ts`
-- (pure TypeScript; the database files and counts, it does not compare). The
-- charts themselves are `20270811090000_preflop_charts.sql`'s.
--
-- ## `preflop_decision_rows` / `preflop_decision_totals`: what was played
--
-- To compare a chart with a million hands in about a second, the played
-- preflop decisions are kept narrow, R5.2's way: one row per preflop decision
-- the analysis graded on the shipped charts' tree (`decision_analysis`,
-- `street = 'preflop' and source = 'chart'`, `facts.chart.{set,line}`): its
-- situation key (`preflop_chart_node_key`, the rule of
-- `packages/ui/charts/nodeKey.ts`; '' when the vocabulary does not name the
-- line), the table size of the set it was read on, the effective stack in
-- 10 bb steps, the hand class (0-168), the action in the chart's words
-- (`fold`, `check`, `call`, `raise`, `allin`), the time, the format, and the
-- EV loss against Rail's charts. `preflop_decision_totals` sums them per
-- (owner, version, format, table, depth step, key, class, action) for "all
-- time"; a window of days reads the rows. Both are kept by two statement
-- triggers on `decision_analysis` (insert adds; delete - a prune, a hand or
-- an account deleted - subtracts using the rows' own values, the hand may be
-- gone), each one statement under a per-account advisory lock;
-- `preflop_decision_rows_rebuild(owner)` recounts one account (the repair,
-- and the backfill at the end). Nothing here changes `decision_analysis`, a
-- grade, a chart or `analysis/N`.
--
-- ## The readers (invoker, owner-first)
--
-- As `20270804090000_owner_first_readers.sql` has every reader do: the owner
-- bound once (`v_owner`), `owner_id = v_owner` on every table read, and a
-- plan per call (`plan_cache_mode = force_custom_plan`).
--
--   preflop_chart_played(version, period, format, table, min_bb, max_bb)
--       the played cells - [key, class, action, decisions, EV loss] - for
--       the chart's game over the period (30d / 90d / 365d counted back from
--       the last decision's day, or all)
--   preflop_chart_examples(..., key, class, action, limit)
--       the hands behind one cell, newest first (at most 50)
--   preflop_chart_session(filter, from, to)
--       one session's decisions under the shared filter (R5.1's session:
--       `hero_report_rows`, the filter's groups as `session_review` reads
--       them), for the session review's second deviation source
--   preflop_chart_review_hands(filter, hand_ids)
--       the review's row for up to 50 hands (`session_review`'s `hands`)
--
-- Every function pins `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Helpers: a shipped line as a situation key, a hand class
-- ---------------------------------------------------------------------------

-- The table size of a shipped set by id; null for the straddle set and anything else.
create or replace function public.preflop_chart_set_table(p_set text)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_set ~ '^nlhe-cash-6max-[0-9]{1,3}bb$' then 6::smallint
    when p_set ~ '^nlhe-cash-9max-[0-9]{1,3}bb$' then 9::smallint
    when p_set ~ '^nlhe-cash-hu-[0-9]{1,3}bb$' then 2::smallint
  end;
$$;

-- A shipped line as a situation key (`nodeKeyOfLine` in nodeKey.ts); null when
-- the vocabulary does not name it or the set is not one of the plain tables.
create or replace function public.preflop_chart_node_key(p_set text, p_line text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_table   smallint := public.preflop_chart_set_table(p_set);
  v_seats   text[];
  v_n       integer;
  v_folded  boolean[];
  v_allin   boolean[];
  v_limpers integer[] := '{}';
  v_raisers integer[] := '{}';
  v_callers integer := 0;
  v_facing  boolean := false;
  v_seat    integer := 0;  -- 1-based; 0 = before the first seat
  v_code    text;
  v_tries   integer;
  v_found   boolean;
  v_actor   integer;
  v_hero    text;
  v_raises  integer;
  v_raiser  integer;
begin
  if v_table is null or p_line is null or p_line !~ '^[fkcra]{0,24}$' then
    return null;
  end if;
  v_seats := public.preflop_chart_seats(v_table);
  v_n := cardinality(v_seats);
  v_folded := array_fill(false, array[v_n]);
  v_allin := array_fill(false, array[v_n]);
  for i in 1 .. length(p_line) + 1 loop
    -- The next seat still in and not all in.
    v_found := false;
    v_tries := 0;
    while v_tries < v_n loop
      v_seat := v_seat % v_n + 1;
      v_tries := v_tries + 1;
      if not v_folded[v_seat] and not v_allin[v_seat] then
        v_found := true;
        exit;
      end if;
    end loop;
    if not v_found then
      return null;
    end if;
    exit when i = length(p_line) + 1;
    v_code := substr(p_line, i, 1);
    if v_code = 'f' then
      v_folded[v_seat] := true;
    elsif v_code = 'c' then
      if cardinality(v_raisers) = 0 then
        v_limpers := v_limpers || v_seat;
      else
        v_callers := v_callers + 1;
      end if;
      if v_facing then
        v_allin[v_seat] := true;
      end if;
    elsif v_code in ('r', 'a') then
      v_raisers := v_raisers || v_seat;
      if v_code = 'a' then
        v_allin[v_seat] := true;
        v_facing := true;
      end if;
    end if;
  end loop;
  v_actor := v_seat;
  v_hero := v_seats[v_actor];
  v_raises := cardinality(v_raisers);
  if v_raises = 0 then
    if cardinality(v_limpers) = 0 then
      return case when v_hero = 'BB' then null else 'rfi:' || v_hero end;
    end if;
    if v_actor = any (v_limpers) then
      return null;
    end if;
    return 'vs-limp:' || v_hero || ':' || v_seats[v_limpers[1]];
  end if;
  v_raiser := v_raisers[v_raises];
  if v_raiser = v_actor then
    return null;
  end if;
  if v_raises = 1 then
    if cardinality(v_limpers) > 0 then
      return case when v_actor = any (v_limpers) then 'vs-iso:' || v_hero || ':' || v_seats[v_raiser] end;
    end if;
    return case when v_callers > 0 then 'squeeze:' else 'vs-open:' end || v_hero || ':' || v_seats[v_raiser];
  end if;
  if cardinality(v_limpers) > 0 or v_callers > 0 then
    return null;
  end if;
  if exists (select 1 from unnest(v_raisers) r where r <> v_actor and r <> v_raiser)
     or not (v_actor = any (v_raisers)) then
    return null;
  end if;
  return case v_raises when 2 then 'vs-3bet:' when 3 then 'vs-4bet:' else 'vs-allin:' end
         || v_hero || ':' || v_seats[v_raiser];
end;
$$;

-- A hand class (`AKs`, `AKo`, `77`; either rank first) as its index 0-168
-- (row x 13 + column of the grid, ace first; suited above the diagonal).
create or replace function public.preflop_class_index(p_class text)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_class ~ '^([AKQJT2-9])\1$' then ((strpos('AKQJT98765432', substr(p_class, 1, 1)) - 1) * 14)::smallint
    when p_class ~ '^[AKQJT2-9]{2}[so]$' and substr(p_class, 1, 1) <> substr(p_class, 2, 1) then
      (with r as (select strpos('AKQJT98765432', substr(p_class, 1, 1)) - 1 as a,
                         strpos('AKQJT98765432', substr(p_class, 2, 1)) - 1 as b)
       select case when substr(p_class, 3, 1) = 's' then least(a, b) * 13 + greatest(a, b)
                   else greatest(a, b) * 13 + least(a, b) end::smallint
       from r)
  end;
$$;

-- The compared fields of one decision: none unless it is a preflop decision
-- the analysis read on a plain shipped set with a hand class.
create or replace function public.preflop_decision_fields(p_street text, p_source text, p_action text, p_facts jsonb)
returns table (node_key text, table_size smallint, hand_class smallint, played_action text, depth_band smallint)
language sql
immutable
set search_path = ''
as $$
  select coalesce(public.preflop_chart_node_key(p_facts -> 'chart' ->> 'set', p_facts -> 'chart' ->> 'line'), ''),
         public.preflop_chart_set_table(p_facts -> 'chart' ->> 'set'),
         public.preflop_class_index(p_facts ->> 'handClass'),
         case when p_action in ('raise', 'bet') and p_facts -> 'allIn' = 'true'::jsonb then 'allin'
              when p_action = 'bet' then 'raise'
              else p_action end,
         case when jsonb_typeof(p_facts -> 'effStackBb') = 'number'
              then least(990, greatest(0, floor((p_facts ->> 'effStackBb')::numeric / 10) * 10))::smallint
              else -1::smallint end
  where p_street = 'preflop' and p_source = 'chart'
    and public.preflop_chart_set_table(p_facts -> 'chart' ->> 'set') is not null
    and coalesce(p_facts -> 'chart' ->> 'line', '') ~ '^[fkcra]{0,24}$'
    and public.preflop_class_index(p_facts ->> 'handClass') is not null
    and p_action in ('fold', 'check', 'call', 'raise', 'bet');
$$;

comment on function public.preflop_chart_node_key(text, text) is
  'R5.3: a shipped chart line as the user charts'' situation key (packages/ui/charts/nodeKey.ts); null when unnamed.';
comment on function public.preflop_class_index(text) is
  'R5.3: a hand class name as its index 0-168 in the shipped charts'' order.';

-- Pure helpers: callable by the signed-in (the key and class rules are public knowledge).
revoke all on function public.preflop_chart_set_table(text) from public, anon;
revoke all on function public.preflop_chart_node_key(text, text) from public, anon;
revoke all on function public.preflop_class_index(text) from public, anon;
revoke all on function public.preflop_decision_fields(text, text, text, jsonb) from public, anon;
grant execute on function public.preflop_chart_set_table(text) to authenticated;
grant execute on function public.preflop_chart_node_key(text, text) to authenticated;
grant execute on function public.preflop_class_index(text) to authenticated;
grant execute on function public.preflop_decision_fields(text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. The played decisions, narrow
-- ---------------------------------------------------------------------------

create table if not exists public.preflop_decision_rows (
  hand_id          uuid        not null,
  analysis_version text        not null,
  ord              smallint    not null,
  owner_id         uuid        not null references auth.users (id) on delete cascade,
  action_index     integer     not null,
  played_at        timestamptz,
  game_format      text        not null,
  table_size       smallint    not null,
  -- Effective stack in 10 bb steps (the lower end), -1 unknown.
  depth_band       smallint    not null,
  -- The situation (packages/ui/charts/model.ts); '' when the vocabulary does not name the line.
  node_key         text        not null,
  hand_class       smallint    not null check (hand_class between 0 and 168),
  action           text        not null check (action in ('fold', 'check', 'call', 'raise', 'allin')),
  scenario         text        not null,
  hero_position    text        not null,
  ev_loss_bb       numeric(12, 3) not null,
  grade            text,
  primary key (hand_id, analysis_version, ord)
);

comment on table public.preflop_decision_rows is
  'R5.3: one row per preflop decision graded on the shipped charts'' tree, as the user charts compare it '
  '(situation key, table, depth step, class, action). Kept by triggers on decision_analysis.';

-- A window of days (and the last decision's time).
create index if not exists preflop_decision_rows_time_idx
  on public.preflop_decision_rows (owner_id, analysis_version, played_at);
-- The hands behind one cell, newest first.
create index if not exists preflop_decision_rows_cell_idx
  on public.preflop_decision_rows (owner_id, analysis_version, node_key, hand_class, action, played_at desc);

create table if not exists public.preflop_decision_totals (
  owner_id         uuid     not null references auth.users (id) on delete cascade,
  analysis_version text     not null,
  game_format      text     not null,
  table_size       smallint not null,
  depth_band       smallint not null,
  node_key         text     not null,
  hand_class       smallint not null,
  action           text     not null,
  decisions        integer  not null,
  ev_loss_bb       numeric(16, 3) not null,
  primary key (owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action)
);

comment on table public.preflop_decision_totals is
  'R5.3: preflop_decision_rows summed per (owner, version, format, table, depth step, key, class, action): '
  'the all-time comparison. Kept by triggers on decision_analysis.';

alter table public.preflop_decision_rows enable row level security;
alter table public.preflop_decision_totals enable row level security;
revoke all on public.preflop_decision_rows from anon, authenticated;
revoke all on public.preflop_decision_totals from anon, authenticated;
grant select on public.preflop_decision_rows to authenticated;
grant select on public.preflop_decision_totals to authenticated;

drop policy if exists preflop_decision_rows_owner_select on public.preflop_decision_rows;
create policy preflop_decision_rows_owner_select on public.preflop_decision_rows
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists preflop_decision_totals_owner_select on public.preflop_decision_totals;
create policy preflop_decision_totals_owner_select on public.preflop_decision_totals
  for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.preflop_decision_rows_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if not exists (select 1 from inserted where street = 'preflop' and source = 'chart') then
    return null;
  end if;
  for v_owner in select distinct owner_id from inserted where street = 'preflop' and source = 'chart' order by owner_id loop
    perform pg_advisory_xact_lock(hashtextextended('preflop_decisions:' || v_owner::text, 0));
  end loop;

  with ins as (
    insert into public.preflop_decision_rows (
      hand_id, analysis_version, ord, owner_id, action_index, played_at, game_format, table_size, depth_band,
      node_key, hand_class, action, scenario, hero_position, ev_loss_bb, grade)
    select d.hand_id, d.analysis_version, d.ord, d.owner_id, d.action_index, h.played_at,
           coalesce(h.game_format::text, ''), f.table_size, f.depth_band, f.node_key, f.hand_class,
           f.played_action, d.scenario,
           case when coalesce(d.facts ->> 'position', h.hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
                then coalesce(d.facts ->> 'position', h.hero_position, '') else '' end,
           coalesce(d.ev_loss_bb, 0), d.grade
    from inserted d
    cross join lateral public.preflop_decision_fields(d.street, d.source, d.action, d.facts) f
    join public.hands h on h.id = d.hand_id and h.owner_id = d.owner_id
    where d.street = 'preflop' and d.source = 'chart'
    on conflict (hand_id, analysis_version, ord) do nothing
    returning *
  )
  insert into public.preflop_decision_totals as t (
    owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action, decisions, ev_loss_bb)
  select owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action,
         count(*), sum(ev_loss_bb)
  from ins
  group by 1, 2, 3, 4, 5, 6, 7, 8
  order by 1, 2, 3, 4, 5, 6, 7, 8
  on conflict (owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action)
  do update set decisions = t.decisions + excluded.decisions,
                ev_loss_bb = t.ev_loss_bb + excluded.ev_loss_bb;

  return null;
end;
$$;

create or replace function public.preflop_decision_rows_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if not exists (select 1 from deleted where street = 'preflop' and source = 'chart') then
    return null;
  end if;
  for v_owner in select distinct owner_id from deleted where street = 'preflop' and source = 'chart' order by owner_id loop
    perform pg_advisory_xact_lock(hashtextextended('preflop_decisions:' || v_owner::text, 0));
  end loop;

  -- The rows carry their own filters: the hand may be gone already.
  with gone as (
    delete from public.preflop_decision_rows x
    using deleted d
    where x.hand_id = d.hand_id and x.analysis_version = d.analysis_version and x.ord = d.ord
    returning x.*
  ),
  s as (
    select owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action,
           count(*) as decisions, sum(ev_loss_bb) as ev_loss_bb
    from gone
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  less as (
    update public.preflop_decision_totals t
       set decisions = t.decisions - s.decisions,
           ev_loss_bb = t.ev_loss_bb - s.ev_loss_bb
      from s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.table_size = s.table_size and t.depth_band = s.depth_band and t.node_key = s.node_key
       and t.hand_class = s.hand_class and t.action = s.action
       and t.decisions > s.decisions
  )
  delete from public.preflop_decision_totals t
   using s
   where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
     and t.table_size = s.table_size and t.depth_band = s.depth_band and t.node_key = s.node_key
     and t.hand_class = s.hand_class and t.action = s.action
     and t.decisions <= s.decisions;

  return null;
end;
$$;

revoke all on function public.preflop_decision_rows_on_insert() from public, anon, authenticated;
revoke all on function public.preflop_decision_rows_on_delete() from public, anon, authenticated;

drop trigger if exists decision_analysis_preflop_rows_insert on public.decision_analysis;
create trigger decision_analysis_preflop_rows_insert
  after insert on public.decision_analysis
  referencing new table as inserted
  for each statement execute function public.preflop_decision_rows_on_insert();

drop trigger if exists decision_analysis_preflop_rows_delete on public.decision_analysis;
create trigger decision_analysis_preflop_rows_delete
  after delete on public.decision_analysis
  referencing old table as deleted
  for each statement execute function public.preflop_decision_rows_on_delete();

create or replace function public.preflop_decision_rows_rebuild(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_owner is null then
    raise exception 'preflop_decision_rows_rebuild needs an owner.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('preflop_decisions:' || p_owner::text, 0));

  delete from public.preflop_decision_rows where owner_id = p_owner;
  delete from public.preflop_decision_totals where owner_id = p_owner;

  insert into public.preflop_decision_rows (
    hand_id, analysis_version, ord, owner_id, action_index, played_at, game_format, table_size, depth_band,
    node_key, hand_class, action, scenario, hero_position, ev_loss_bb, grade)
  select d.hand_id, d.analysis_version, d.ord, d.owner_id, d.action_index, h.played_at,
         coalesce(h.game_format::text, ''), f.table_size, f.depth_band, f.node_key, f.hand_class,
         f.played_action, d.scenario,
         case when coalesce(d.facts ->> 'position', h.hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
              then coalesce(d.facts ->> 'position', h.hero_position, '') else '' end,
         coalesce(d.ev_loss_bb, 0), d.grade
  from public.decision_analysis d
  cross join lateral public.preflop_decision_fields(d.street, d.source, d.action, d.facts) f
  join public.hands h on h.id = d.hand_id and h.owner_id = d.owner_id
  where d.owner_id = p_owner and d.street = 'preflop' and d.source = 'chart';
  get diagnostics v_rows = row_count;

  insert into public.preflop_decision_totals (
    owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action, decisions, ev_loss_bb)
  select owner_id, analysis_version, game_format, table_size, depth_band, node_key, hand_class, action,
         count(*), sum(ev_loss_bb)
  from public.preflop_decision_rows
  where owner_id = p_owner
  group by 1, 2, 3, 4, 5, 6, 7, 8;

  return jsonb_build_object('rows', v_rows);
end;
$$;

comment on function public.preflop_decision_rows_rebuild(uuid) is
  'R5.3: recounts one account''s preflop_decision_rows and totals from decision_analysis (the repair, the backfill). '
  'Definer, granted to nobody.';

revoke all on function public.preflop_decision_rows_rebuild(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The readers
-- ---------------------------------------------------------------------------

-- The window of a period: from the start of the UTC day (n - 1) days before
-- the last decision's day; null for all time.
create or replace function public.preflop_chart_window(p_owner uuid, p_version text, p_period text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when p_period = 'all' then null else
    (select (date_trunc('day', max(r.played_at) at time zone 'UTC')
             - make_interval(days => (case p_period when '30d' then 30 when '90d' then 90 else 365 end) - 1))
            at time zone 'UTC'
     from public.preflop_decision_rows r
     where r.owner_id = p_owner and r.analysis_version = p_version)
  end;
$$;

revoke all on function public.preflop_chart_window(uuid, text, text) from public, anon;
grant execute on function public.preflop_chart_window(uuid, text, text) to authenticated;

create or replace function public.preflop_chart_played(
  p_version    text,
  p_period     text,
  p_format     text,
  p_table_size integer,
  p_min_bb     numeric,
  p_max_bb     numeric
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_formats text[];
  v_from    timestamptz;
  v_span    jsonb;
  v_cells   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to compare charts.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'Unknown analysis version: %', p_version using errcode = '22023';
  end if;
  if p_period is null or p_period not in ('30d', '90d', '365d', 'all') then
    raise exception 'Unknown period: %', p_period using errcode = '22023';
  end if;
  if p_format is null or p_format not in ('cash', 'tournament') then
    raise exception 'Unknown format: %', p_format using errcode = '22023';
  end if;
  if p_table_size is null or p_table_size not in (2, 6, 9) then
    raise exception 'Unknown table size: %', p_table_size using errcode = '22023';
  end if;
  if p_min_bb is null or p_max_bb is null or p_min_bb < 0 or p_max_bb > 1000 or p_min_bb > p_max_bb then
    raise exception 'Bad stack range.' using errcode = '22023';
  end if;
  v_formats := case p_format when 'cash' then array['cash'] else array['tournament', 'sng', 'spin'] end;

  if p_period = 'all' then
    select jsonb_build_object('from', (min(r.played_at) at time zone 'UTC')::date, 'to', (max(r.played_at) at time zone 'UTC')::date)
      into v_span
    from public.preflop_decision_rows r
    where r.owner_id = v_owner and r.analysis_version = p_version;

    select coalesce(jsonb_agg(jsonb_build_array(c.node_key, c.hand_class, c.action, c.n, c.ev)), '[]'::jsonb)
      into v_cells
    from (
      select t.node_key, t.hand_class, t.action, sum(t.decisions)::bigint as n, sum(t.ev_loss_bb) as ev
      from public.preflop_decision_totals t
      where t.owner_id = v_owner and t.analysis_version = p_version
        and t.game_format = any (v_formats) and t.table_size = p_table_size
        and (t.depth_band = -1 or (t.depth_band + 10 > p_min_bb and t.depth_band <= p_max_bb))
      group by 1, 2, 3
    ) c;
  else
    v_from := public.preflop_chart_window(v_owner, p_version, p_period);
    select jsonb_build_object('from', (v_from at time zone 'UTC')::date, 'to', (max(r.played_at) at time zone 'UTC')::date)
      into v_span
    from public.preflop_decision_rows r
    where r.owner_id = v_owner and r.analysis_version = p_version;

    select coalesce(jsonb_agg(jsonb_build_array(c.node_key, c.hand_class, c.action, c.n, c.ev)), '[]'::jsonb)
      into v_cells
    from (
      select r.node_key, r.hand_class, r.action, count(*) as n, sum(r.ev_loss_bb) as ev
      from public.preflop_decision_rows r
      where r.owner_id = v_owner and r.analysis_version = p_version
        and v_from is not null and r.played_at >= v_from
        and r.game_format = any (v_formats) and r.table_size = p_table_size
        and (r.depth_band = -1 or (r.depth_band + 10 > p_min_bb and r.depth_band <= p_max_bb))
      group by 1, 2, 3
    ) c;
  end if;

  return jsonb_build_object(
    'analysisVersion', p_version,
    'period', p_period,
    'from', case when v_span ->> 'to' is null then null else v_span -> 'from' end,
    'to', v_span -> 'to',
    'cells', v_cells);
end;
$$;

comment on function public.preflop_chart_played(text, text, text, integer, numeric, numeric) is
  'R5.3: the caller''s preflop decisions on the shipped tree per (situation key, class, action) - count and EV loss '
  'against Rail''s charts - for a chart''s game over a period. Invoker, owner-first.';

revoke all on function public.preflop_chart_played(text, text, text, integer, numeric, numeric) from public, anon;
grant execute on function public.preflop_chart_played(text, text, text, integer, numeric, numeric) to authenticated;

create or replace function public.preflop_chart_examples(
  p_version    text,
  p_period     text,
  p_format     text,
  p_table_size integer,
  p_min_bb     numeric,
  p_max_bb     numeric,
  p_key        text,
  p_class      integer,
  p_action     text,
  p_limit      integer default 10
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_formats text[];
  v_from    timestamptz;
  v_limit   integer := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  if v_owner is null then
    raise exception 'You must be signed in to compare charts.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$'
     or p_period is null or p_period not in ('30d', '90d', '365d', 'all')
     or p_format is null or p_format not in ('cash', 'tournament')
     or p_table_size is null or p_table_size not in (2, 6, 9)
     or p_min_bb is null or p_max_bb is null or p_min_bb > p_max_bb
     or p_key is null or char_length(p_key) > 40
     or p_class is null or p_class not between 0 and 168
     or p_action is null or p_action not in ('fold', 'check', 'call', 'raise', 'allin') then
    raise exception 'Bad example request.' using errcode = '22023';
  end if;
  v_formats := case p_format when 'cash' then array['cash'] else array['tournament', 'sng', 'spin'] end;
  v_from := public.preflop_chart_window(v_owner, p_version, p_period);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'handId', x.hand_id, 'actionIndex', x.action_index, 'playedAt', x.played_at,
             'heroCards', to_jsonb(h.hero_cards), 'stakesLabel', h.stakes_label, 'site', h.site,
             'evLossBb', x.ev_loss_bb)
           order by x.played_at desc nulls last, x.hand_id)
    from (
      select r.hand_id, r.action_index, r.played_at, r.ev_loss_bb
      from public.preflop_decision_rows r
      where r.owner_id = v_owner and r.analysis_version = p_version
        and r.node_key = p_key and r.hand_class = p_class and r.action = p_action
        and (v_from is null or r.played_at >= v_from)
        and r.game_format = any (v_formats) and r.table_size = p_table_size
        and (r.depth_band = -1 or (r.depth_band + 10 > p_min_bb and r.depth_band <= p_max_bb))
      order by r.played_at desc nulls last, r.hand_id
      limit v_limit
    ) x
    join public.hands h on h.id = x.hand_id and h.owner_id = v_owner), '[]'::jsonb);
end;
$$;

comment on function public.preflop_chart_examples(text, text, text, integer, numeric, numeric, text, integer, text, integer) is
  'R5.3: the hands behind one compared cell (situation, class, action), newest first, at most 50. Invoker, owner-first.';

revoke all on function public.preflop_chart_examples(text, text, text, integer, numeric, numeric, text, integer, text, integer) from public, anon;
grant execute on function public.preflop_chart_examples(text, text, text, integer, numeric, numeric, text, integer, text, integer) to authenticated;

-- One session's stored preflop decisions under the shared filter (R5.1's
-- groups, read as `session_review` reads them; dates never: the session is
-- the window).
create or replace function public.preflop_chart_session(
  p_filter jsonb,
  p_from   timestamptz,
  p_to     timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner     uuid  := (select auth.uid());
  v_filter    jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_av        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_bomb      boolean;
  v_straddle  boolean;
begin
  if v_owner is null then
    raise exception 'You must be signed in to review a session.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > interval '7 days' then
    raise exception 'A session is at most 7 days long.' using errcode = '22023';
  end if;
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_av        := coalesce(nullif(btrim(coalesce(v_filter ->> 'analysisVersion', '')), ''), 'analysis/1');
  if v_av !~ '^analysis/[0-9]+$' then
    raise exception 'Unknown analysis version: %', v_av using errcode = '22023';
  end if;
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'handId', p.hand_id, 'ord', p.ord, 'actionIndex', p.action_index, 'playedAt', p.played_at,
             'key', p.node_key, 'cls', p.hand_class, 'action', p.action, 'scenario', p.scenario,
             'position', nullif(p.hero_position, ''), 'gameFormat', p.game_format, 'tableSize', p.table_size,
             'depthBand', nullif(p.depth_band, -1), 'evLossBb', p.ev_loss_bb)
           order by p.played_at, p.hand_id, p.ord)
    from (
      select p.*
      from public.hero_report_rows r
      join public.preflop_decision_rows p
        on p.hand_id = r.hand_id and p.owner_id = v_owner and p.analysis_version = v_av
      where r.owner_id = v_owner and r.stats_version = v_version
        and r.played_at >= p_from and r.played_at <= p_to
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
      order by p.played_at, p.hand_id, p.ord
      limit 5000
    ) p), '[]'::jsonb);
end;
$$;

comment on function public.preflop_chart_session(jsonb, timestamptz, timestamptz) is
  'R5.3: one session''s preflop decisions on the shipped tree under the shared filter, for the session review''s '
  'own-chart deviations. Invoker, owner-first; at most 7 days and 5,000 decisions.';

revoke all on function public.preflop_chart_session(jsonb, timestamptz, timestamptz) from public, anon;
grant execute on function public.preflop_chart_session(jsonb, timestamptz, timestamptz) to authenticated;

-- The session review's row for up to 50 hands (`session_review`'s `hands`).
create or replace function public.preflop_chart_review_hands(p_filter jsonb, p_hand_ids uuid[])
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid  := (select auth.uid());
  v_filter  jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version text;
  v_ev      text;
  v_av      text;
begin
  if v_owner is null then
    raise exception 'You must be signed in to review a session.' using errcode = '42501';
  end if;
  if p_hand_ids is null or cardinality(p_hand_ids) > 50 then
    raise exception 'At most 50 hands.' using errcode = '22023';
  end if;
  v_version := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev      := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_av      := coalesce(nullif(btrim(coalesce(v_filter ->> 'analysisVersion', '')), ''), 'analysis/1');

  return coalesce((
    select jsonb_object_agg(h.id, jsonb_build_object(
             'playedAt',       h.played_at,
             'site',           h.site,
             'stakesLabel',    h.stakes_label,
             'gameFormat',     h.game_format,
             'currency',       h.currency,
             'currencySymbol', coalesce(h.currency_symbol, ''),
             'minorUnits',     h.currency_minor_units,
             'bigBlind',       h.big_blind,
             'tableName',      h.table_name,
             'position',       h.hero_position,
             'heroCards',      to_jsonb(h.hero_cards),
             'handClass',      h.hero_hand_class,
             'board',          to_jsonb(h.board_cards),
             'potType',        nullif(r.pot_type, ''),
             'potBb',          case when h.big_blind > 0 and h.total_pot is not null
                                    then round(h.total_pot::numeric / h.big_blind, 2) end,
             'net',            r.net,
             'netBbMilli',     r.net_bb_milli,
             'evNetBbMilli',   case when e.applicable then e.ev_net_bb_milli end,
             'grade',          a.grade,
             'evLossBb',       a.ev_loss_bb))
    from public.hands h
    left join public.hero_report_rows r
      on r.hand_id = h.id and r.owner_id = v_owner and r.stats_version = v_version
    left join public.hand_analysis a on a.hand_id = h.id and a.owner_id = v_owner and a.analysis_version = v_av
    left join public.hand_stats_ev e
      on e.hand_id = h.id and e.owner_id = v_owner and e.ev_version = v_ev and e.seat = r.seat
    where h.owner_id = v_owner and h.id = any (p_hand_ids)), '{}'::jsonb);
end;
$$;

comment on function public.preflop_chart_review_hands(jsonb, uuid[]) is
  'R5.3: the session review''s row for up to 50 of the caller''s hands. Invoker, owner-first.';

revoke all on function public.preflop_chart_review_hands(jsonb, uuid[]) from public, anon;
grant execute on function public.preflop_chart_review_hands(jsonb, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The backfill: every account's analysed decisions once
-- ---------------------------------------------------------------------------

select public.preflop_decision_rows_rebuild(o.owner_id)
from (select distinct owner_id from public.decision_analysis where street = 'preflop' and source = 'chart') o;

commit;
