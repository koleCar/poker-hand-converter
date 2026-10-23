-- ===========================================================================
-- Rail R5.3: the user's own preflop charts
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R5.3; the model is `packages/ui/charts/model.ts` (pure
-- TypeScript; the database stores and checks, it does not compare). The
-- played decisions a chart is compared with, and their readers, are the next
-- migration's (`20270811100000_preflop_charts_compare.sql`).
--
-- ## `preflop_chart_sets`: the user's charts, private to the account
--
-- One row per chart set: a name, the game it is for (cash or tournament, a
-- table size of 2 / 6 / 9 - the shipped sets' tables - and a range of stack
-- depths), `format_version` (1; a later format migrates rows by it) and
-- `nodes`, a JSON object keyed by situation (`rfi:CO`, `vs-open:BB:BTN`, the
-- shipped charts' vocabulary, `docs/CHARTS.md` §11) whose values hold, per
-- action (`raise`, `call`, `allin`), base64 of 169 bytes: whole percents per
-- hand class in the shipped class order (the rest of 100 % folds - or checks,
-- for the big blind facing limpers). The user's own data: what they import
-- or paint (copying a shipped Rail chart into one is allowed: it is Rail's
-- own solver output); Rail ships no one else's charts.
--
-- **Owner-only, written directly** (PostgREST `insert` / `update` /
-- `delete`) under RLS: every policy is `owner_id = (select auth.uid())`;
-- nothing for `anon`. A `before` trigger (definer, so it can count and rate
-- limit) checks what RLS cannot: the nodes' shape - keys a situation of the
-- set's table can have, only the actions it allows, base64 of exactly 169
-- bytes, each percent and each class's sum at most 100 - and the limits:
-- 50 sets an account, 300 situations and 400 KiB of nodes a set, a name of
-- 1-80 characters, 1-1000 bb, and 120 writes per 10 minutes per account
-- (`enforce_rate_limit`, `preflop_charts:`). An update cannot move a row to
-- another account or change its id or creation time.
--
-- Every function pins `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Helpers: a table's seats, which situations it can have
-- ---------------------------------------------------------------------------

-- The seats of a table size in preflop order (heads-up: the small blind first).
create or replace function public.preflop_chart_seats(p_table_size integer)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_table_size
    when 2 then array['SB', 'BB']
    when 6 then array['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']
    when 9 then array['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']
  end;
$$;

-- Whether a situation key can happen at a table (`isPlausible` in model.ts).
create or replace function public.preflop_chart_key_ok(p_key text, p_table_size integer)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_m     text[];
  v_seats text[] := public.preflop_chart_seats(p_table_size);
  v_h     integer;
  v_v     integer;
begin
  if v_seats is null or p_key is null then
    return false;
  end if;
  v_m := regexp_match(p_key,
    '^(rfi|vs-limp|vs-open|squeeze|vs-iso|vs-3bet|vs-4bet|vs-allin):(UTG|UTG\+1|UTG\+2|LJ|HJ|CO|BTN|SB|BB)(?::(UTG|UTG\+1|UTG\+2|LJ|HJ|CO|BTN|SB|BB))?$');
  if v_m is null then
    return false;
  end if;
  v_h := array_position(v_seats, v_m[2]);
  if v_h is null then
    return false;
  end if;
  if v_m[1] = 'rfi' then
    return v_m[3] is null and v_m[2] <> 'BB';
  end if;
  if v_m[3] is null then
    return false;
  end if;
  v_v := array_position(v_seats, v_m[3]);
  if v_v is null or v_v = v_h then
    return false;
  end if;
  return case
    when v_m[1] in ('vs-limp', 'vs-open', 'vs-4bet') then v_v < v_h and v_m[3] <> 'BB'
    when v_m[1] = 'squeeze' then v_v < v_h - 1 and v_m[3] <> 'BB'
    else v_h < v_v and v_m[2] <> 'BB'
  end;
end;
$$;

-- Pure helpers: callable by the signed-in (the key rules are public knowledge).
revoke all on function public.preflop_chart_seats(integer) from public, anon;
revoke all on function public.preflop_chart_key_ok(text, integer) from public, anon;
grant execute on function public.preflop_chart_seats(integer) to authenticated;
grant execute on function public.preflop_chart_key_ok(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. preflop_chart_sets
-- ---------------------------------------------------------------------------

create table if not exists public.preflop_chart_sets (
  id             uuid        primary key default gen_random_uuid(),
  owner_id       uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  name           text        not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  game_format    text        not null check (game_format in ('cash', 'tournament')),
  table_size     smallint    not null check (table_size in (2, 6, 9)),
  stack_min_bb   numeric(6, 1) not null check (stack_min_bb between 1 and 1000),
  stack_max_bb   numeric(6, 1) not null check (stack_max_bb between 1 and 1000),
  format_version smallint    not null default 1 check (format_version = 1),
  nodes          jsonb       not null default '{}'::jsonb
    check (jsonb_typeof(nodes) = 'object' and octet_length(nodes::text) <= 409600),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint preflop_chart_sets_stack_range check (stack_min_bb <= stack_max_bb)
);

comment on table public.preflop_chart_sets is
  'R5.3: a user''s own preflop chart set (name, game, per situation key the percent per class of raise / call / '
  'all-in as base64 of 169 bytes). Private to the owner; shape and limits checked by preflop_chart_sets_guard.';

create index if not exists preflop_chart_sets_owner_idx on public.preflop_chart_sets (owner_id, updated_at desc);

alter table public.preflop_chart_sets enable row level security;

revoke all on public.preflop_chart_sets from anon, authenticated;
grant select, insert, update, delete on public.preflop_chart_sets to authenticated;

drop policy if exists preflop_chart_sets_owner_select on public.preflop_chart_sets;
create policy preflop_chart_sets_owner_select on public.preflop_chart_sets
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists preflop_chart_sets_owner_insert on public.preflop_chart_sets;
create policy preflop_chart_sets_owner_insert on public.preflop_chart_sets
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists preflop_chart_sets_owner_update on public.preflop_chart_sets;
create policy preflop_chart_sets_owner_update on public.preflop_chart_sets
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists preflop_chart_sets_owner_delete on public.preflop_chart_sets;
create policy preflop_chart_sets_owner_delete on public.preflop_chart_sets
  for delete to authenticated using (owner_id = (select auth.uid()));

-- What is wrong with a set's nodes, or null (`validateChartSet` in model.ts).
create or replace function public.preflop_chart_nodes_problem(p_nodes jsonb, p_table_size integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bad text;
begin
  if p_nodes is null or jsonb_typeof(p_nodes) <> 'object' then
    return 'nodes is a JSON object';
  end if;
  if (select count(*) from jsonb_object_keys(p_nodes)) > 300 then
    return 'at most 300 situations';
  end if;
  select n.key into v_bad from jsonb_each(p_nodes) n
  where not public.preflop_chart_key_ok(n.key, p_table_size) limit 1;
  if v_bad is not null then
    return format('not a situation of a %s-seat table: %s', p_table_size, v_bad);
  end if;
  select n.key into v_bad from jsonb_each(p_nodes) n
  where jsonb_typeof(n.value) <> 'object'
     or exists (select 1 from jsonb_object_keys(n.value) k where k not in ('raise', 'call', 'allin', 'raiseBb'))
  limit 1;
  if v_bad is not null then
    return format('a situation holds raise, call, allin and raiseBb only: %s', v_bad);
  end if;
  select n.key into v_bad from jsonb_each(p_nodes) n
  where n.key ~ '^vs-limp:BB:' and n.value ? 'call' limit 1;
  if v_bad is not null then
    return format('the big blind facing limpers checks rather than calls: %s', v_bad);
  end if;
  select n.key || ' ' || e.key into v_bad
  from jsonb_each(p_nodes) n, jsonb_each(n.value) e
  where e.key in ('raise', 'call', 'allin')
    and (jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[A-Za-z0-9+/]{226}==$')
  limit 1;
  if v_bad is not null then
    return format('not 169 percents in base64: %s', v_bad);
  end if;
  select n.key into v_bad from jsonb_each(p_nodes) n
  where n.value ? 'raiseBb'
    and (jsonb_typeof(n.value -> 'raiseBb') <> 'number' or (n.value ->> 'raiseBb')::numeric <= 0
         or (n.value ->> 'raiseBb')::numeric > 1000)
  limit 1;
  if v_bad is not null then
    return format('a raise size is a number of big blinds, 0-1000: %s', v_bad);
  end if;
  with a as (
    select n.key, decode(e.value #>> '{}', 'base64') as b
    from jsonb_each(p_nodes) n, jsonb_each(n.value) e
    where e.key in ('raise', 'call', 'allin')
  )
  select a.key into v_bad
  from a, generate_series(0, 168) i
  group by a.key, i
  having max(get_byte(a.b, i)) > 100 or sum(get_byte(a.b, i)) > 100
  limit 1;
  if v_bad is not null then
    return format('a class''s actions add up to more than 100 %%: %s', v_bad);
  end if;
  return null;
end;
$$;

revoke all on function public.preflop_chart_nodes_problem(jsonb, integer) from public, anon;
grant execute on function public.preflop_chart_nodes_problem(jsonb, integer) to authenticated;

create or replace function public.preflop_chart_sets_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_problem text;
  v_count   integer;
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
  else
    new.owner_id := coalesce(new.owner_id, v_uid);
    new.created_at := now();
  end if;
  if new.owner_id is null then
    raise exception 'You must be signed in to save a chart.' using errcode = '42501';
  end if;
  new.name := btrim(coalesce(new.name, ''));
  v_problem := public.preflop_chart_nodes_problem(new.nodes, new.table_size);
  if v_problem is not null then
    raise exception 'Chart not saved: %', v_problem using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('preflop_chart_sets:' || new.owner_id::text, 0));
    select count(*) into v_count from public.preflop_chart_sets where owner_id = new.owner_id;
    if v_count >= 50 then
      raise exception 'At most 50 chart sets per account.' using errcode = '53400';
    end if;
  end if;
  if v_uid is not null then
    perform public.enforce_rate_limit('preflop_charts:' || new.owner_id::text, 1, 120, interval '10 minutes');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.preflop_chart_sets_guard() from public, anon, authenticated;

drop trigger if exists preflop_chart_sets_guard on public.preflop_chart_sets;
create trigger preflop_chart_sets_guard
  before insert or update on public.preflop_chart_sets
  for each row execute function public.preflop_chart_sets_guard();

commit;
