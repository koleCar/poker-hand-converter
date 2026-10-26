-- ===========================================================================
-- Rail R5.5b: tournament decisions graded by ICM (analysis/35)
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R5.5, `docs/ANALYSIS-PLAN.md` §3.7. The grading is the
-- client's (`frontend/src/lib/analysis/pushFoldGrade.ts`): a tournament's
-- preflop push or fold, or call or fold facing a push, at 20bb or less,
-- graded against the push/fold game's equilibrium in prize equity
-- (`source = 'icm'`, `facts.icm`). The database stores, checks and files:
--
-- 1. `decision_analysis.source` may be `icm`.
--
-- 2. `tournament_settings`: what the user said about one tournament - the
--    kind (sng / spin / mtt), the payouts in percent, the field size, the
--    starting stack, players-left points - keyed by the hand's `site` and
--    `tournament_id` (`tournamentKey` in `tournament.ts`). **Owner-only,
--    written directly** under RLS (R5.3's way); a `before` trigger (definer)
--    holds the shape `settingsProblem` holds in TypeScript
--    (`tournament_settings_problem`), at most 2 000 tournaments an account
--    and 120 writes per 10 minutes (`enforce_rate_limit`,
--    `tournament_settings:`). An `after` trigger (definer) deletes the
--    stored analysis of the owner's hands of that tournament on every write,
--    so they are analysed again with the new settings: the analysis is what
--    re-grades, the database never does. The delete cascades to the
--    decisions and their statement triggers (the leak sums, the own charts'
--    rows) as a prune does.
--
-- 3. The user's own charts (R5.3) read tournament push/fold decisions too:
--    `preflop_decision_fields` files a `source = 'icm'` decision by its
--    `facts.icm.chart` (`icm-pushfold-hu` / `-6max` / `-9max`, a line in the
--    shipped charts' vocabulary: earliest seats folded on a short table), and
--    the triggers and the rebuild that file preflop decisions take `icm` as
--    they take `chart`. No such decision is stored before this migration, so
--    nothing is backfilled.
--
-- 4. A shared hand shows its push/fold facts (`analysis_public_facts` keeps
--    `icm`, without the tournament key).
--
-- Every function pins `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The source
-- ---------------------------------------------------------------------------

alter table public.decision_analysis drop constraint if exists decision_analysis_source_check;
alter table public.decision_analysis
  add constraint decision_analysis_source_check check (source in ('chart', 'solver', 'heuristic', 'approx', 'icm'));

-- ---------------------------------------------------------------------------
-- 2. tournament_settings
-- ---------------------------------------------------------------------------

create table if not exists public.tournament_settings (
  owner_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  site          text        not null check (char_length(site) between 1 and 64 and site = lower(site)),
  tournament_id text        not null check (char_length(tournament_id) between 1 and 64 and tournament_id = btrim(tournament_id)),
  settings      jsonb       not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 65536),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_id, site, tournament_id)
);

comment on table public.tournament_settings is
  'R5.5: what a user said about one of their tournaments (kind, payouts in percent, field, starting stack, '
  'players-left points) - the ICM grading reads it. Private to the owner; shape and limits checked by '
  'tournament_settings_guard; a write re-queues the tournament''s hands for analysis.';

alter table public.tournament_settings enable row level security;

revoke all on public.tournament_settings from anon, authenticated;
grant select, insert, update, delete on public.tournament_settings to authenticated;

drop policy if exists tournament_settings_owner_select on public.tournament_settings;
create policy tournament_settings_owner_select on public.tournament_settings
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists tournament_settings_owner_insert on public.tournament_settings;
create policy tournament_settings_owner_insert on public.tournament_settings
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists tournament_settings_owner_update on public.tournament_settings;
create policy tournament_settings_owner_update on public.tournament_settings
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists tournament_settings_owner_delete on public.tournament_settings;
create policy tournament_settings_owner_delete on public.tournament_settings
  for delete to authenticated using (owner_id = (select auth.uid()));

-- What is wrong with settings, or null: `settingsProblem` in tournament.ts, the same codes.
create or replace function public.tournament_settings_problem(p_settings jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kind     jsonb := p_settings -> 'kind';
  v_payouts  jsonb := p_settings -> 'payouts';
  v_entrants jsonb := p_settings -> 'entrants';
  v_stack    jsonb := p_settings -> 'startingStack';
  v_left     jsonb := p_settings -> 'playersLeft';
  v_max      numeric;
  v_sum      numeric := 0;
  v_prev     numeric := null;
  v_x        jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    return 'settings';
  end if;
  if exists (select 1 from jsonb_object_keys(p_settings) k
             where k not in ('kind', 'payouts', 'entrants', 'startingStack', 'playersLeft')) then
    return 'settings';
  end if;
  if v_kind is not null and jsonb_typeof(v_kind) <> 'null'
     and (jsonb_typeof(v_kind) <> 'string' or (v_kind #>> '{}') not in ('sng', 'spin', 'mtt')) then
    return 'kind';
  end if;
  if v_payouts is not null and jsonb_typeof(v_payouts) <> 'null' then
    if jsonb_typeof(v_payouts) <> 'array' or jsonb_array_length(v_payouts) = 0 or jsonb_array_length(v_payouts) > 2000 then
      return 'payouts';
    end if;
    for v_x in select value from jsonb_array_elements(v_payouts) loop
      if jsonb_typeof(v_x) <> 'number' or (v_x #>> '{}')::numeric <= 0 or (v_x #>> '{}')::numeric > 100 then
        return 'payouts';
      end if;
      if v_prev is not null and (v_x #>> '{}')::numeric > v_prev then
        return 'payouts-order';
      end if;
      v_prev := (v_x #>> '{}')::numeric;
      v_sum := v_sum + v_prev;
    end loop;
    if v_sum > 100.000001 then
      return 'payouts-sum';
    end if;
  end if;
  if v_entrants is not null and jsonb_typeof(v_entrants) <> 'null'
     and (jsonb_typeof(v_entrants) <> 'number' or (v_entrants #>> '{}')::numeric <> trunc((v_entrants #>> '{}')::numeric)
          or (v_entrants #>> '{}')::numeric < 2 or (v_entrants #>> '{}')::numeric > 1000000) then
    return 'entrants';
  end if;
  if v_stack is not null and jsonb_typeof(v_stack) <> 'null'
     and (jsonb_typeof(v_stack) <> 'number' or (v_stack #>> '{}')::numeric <> trunc((v_stack #>> '{}')::numeric)
          or (v_stack #>> '{}')::numeric < 1 or (v_stack #>> '{}')::numeric > 1000000000) then
    return 'starting-stack';
  end if;
  if v_left is not null and jsonb_typeof(v_left) <> 'null' then
    if jsonb_typeof(v_left) <> 'array' or jsonb_array_length(v_left) > 200 then
      return 'players-left';
    end if;
    v_max := case when v_entrants is not null and jsonb_typeof(v_entrants) = 'number'
                  then (v_entrants #>> '{}')::numeric else 1000000 end;
    for v_x in select value from jsonb_array_elements(v_left) loop
      if jsonb_typeof(v_x) <> 'object' or jsonb_typeof(v_x -> 'at') <> 'string'
         or (v_x ->> 'at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$'
         or jsonb_typeof(v_x -> 'left') <> 'number'
         or (v_x ->> 'left')::numeric <> trunc((v_x ->> 'left')::numeric)
         or (v_x ->> 'left')::numeric < 2 or (v_x ->> 'left')::numeric > v_max then
        return 'players-left';
      end if;
    end loop;
  end if;
  if v_payouts is not null and jsonb_typeof(v_payouts) = 'array'
     and v_entrants is not null and jsonb_typeof(v_entrants) = 'number'
     and jsonb_array_length(v_payouts) > (v_entrants #>> '{}')::numeric then
    return 'payouts-places';
  end if;
  return null;
end;
$$;

revoke all on function public.tournament_settings_problem(jsonb) from public, anon;
grant execute on function public.tournament_settings_problem(jsonb) to authenticated;

create or replace function public.tournament_settings_guard()
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
    new.owner_id := old.owner_id;
    new.site := old.site;
    new.tournament_id := old.tournament_id;
    new.created_at := old.created_at;
  else
    new.owner_id := coalesce(new.owner_id, v_uid);
    new.created_at := now();
  end if;
  if new.owner_id is null then
    raise exception 'You must be signed in to save tournament settings.' using errcode = '42501';
  end if;
  v_problem := public.tournament_settings_problem(new.settings);
  if v_problem is not null then
    raise exception 'Tournament settings not saved: %', v_problem using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('tournament_settings:' || new.owner_id::text, 0));
    select count(*) into v_count from public.tournament_settings where owner_id = new.owner_id;
    if v_count >= 2000 then
      raise exception 'At most 2000 tournaments with settings per account.' using errcode = '53400';
    end if;
  end if;
  if v_uid is not null then
    perform public.enforce_rate_limit('tournament_settings:' || new.owner_id::text, 1, 120, interval '10 minutes');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.tournament_settings_guard() from public, anon, authenticated;

drop trigger if exists tournament_settings_guard on public.tournament_settings;
create trigger tournament_settings_guard
  before insert or update on public.tournament_settings
  for each row execute function public.tournament_settings_guard();

-- Every write sends the tournament's hands back to the analysis queue: their
-- stored rows go (all versions), and `hands_needing_analysis` finds them.
create or replace function public.tournament_settings_requeue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.tournament_settings := case when tg_op = 'DELETE' then old else new end;
begin
  delete from public.hand_analysis a
   using public.hands h
   where a.hand_id = h.id
     and h.owner_id = v_row.owner_id
     and a.owner_id = v_row.owner_id
     and h.site = v_row.site
     and h.tournament_id = v_row.tournament_id;
  return null;
end;
$$;

revoke all on function public.tournament_settings_requeue() from public, anon, authenticated;

drop trigger if exists tournament_settings_requeue on public.tournament_settings;
create trigger tournament_settings_requeue
  after insert or update or delete on public.tournament_settings
  for each row execute function public.tournament_settings_requeue();

-- ---------------------------------------------------------------------------
-- 3. The user's own charts read push/fold decisions
-- ---------------------------------------------------------------------------

-- The table size of a shipped set, or of the push/fold game's chart tables, by id; null for anything else.
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
    when p_set = 'icm-pushfold-6max' then 6::smallint
    when p_set = 'icm-pushfold-9max' then 9::smallint
    when p_set = 'icm-pushfold-hu' then 2::smallint
  end;
$$;

-- The compared fields of one decision: none unless it is a preflop decision
-- the analysis read on a plain shipped set (`facts.chart`) or on the
-- push/fold game (`source = 'icm'`, `facts.icm.chart`), with a hand class.
create or replace function public.preflop_decision_fields(p_street text, p_source text, p_action text, p_facts jsonb)
returns table (node_key text, table_size smallint, hand_class smallint, played_action text, depth_band smallint)
language sql
immutable
set search_path = ''
as $$
  select coalesce(public.preflop_chart_node_key(c.chart ->> 'set', c.chart ->> 'line'), ''),
         public.preflop_chart_set_table(c.chart ->> 'set'),
         public.preflop_class_index(p_facts ->> 'handClass'),
         case when p_action in ('raise', 'bet') and p_facts -> 'allIn' = 'true'::jsonb then 'allin'
              when p_action = 'bet' then 'raise'
              else p_action end,
         case when jsonb_typeof(p_facts -> 'effStackBb') = 'number'
              then least(990, greatest(0, floor((p_facts ->> 'effStackBb')::numeric / 10) * 10))::smallint
              else -1::smallint end
  from (select case when p_source = 'icm' then p_facts -> 'icm' -> 'chart' else p_facts -> 'chart' end as chart) c
  where p_street = 'preflop' and p_source in ('chart', 'icm')
    and public.preflop_chart_set_table(c.chart ->> 'set') is not null
    and coalesce(c.chart ->> 'line', '') ~ '^[fkcra]{0,24}$'
    and public.preflop_class_index(p_facts ->> 'handClass') is not null
    and p_action in ('fold', 'check', 'call', 'raise', 'bet');
$$;

create or replace function public.preflop_decision_rows_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if not exists (select 1 from inserted where street = 'preflop' and source in ('chart', 'icm')) then
    return null;
  end if;
  for v_owner in select distinct owner_id from inserted where street = 'preflop' and source in ('chart', 'icm') order by owner_id loop
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
    where d.street = 'preflop' and d.source in ('chart', 'icm')
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
  if not exists (select 1 from deleted where street = 'preflop' and source in ('chart', 'icm')) then
    return null;
  end if;
  for v_owner in select distinct owner_id from deleted where street = 'preflop' and source in ('chart', 'icm') order by owner_id loop
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
  where d.owner_id = p_owner and d.street = 'preflop' and d.source in ('chart', 'icm');
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

revoke all on function public.preflop_decision_rows_on_insert() from public, anon, authenticated;
revoke all on function public.preflop_decision_rows_on_delete() from public, anon, authenticated;
revoke all on function public.preflop_decision_rows_rebuild(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. A shared hand's facts keep the push/fold game's
-- ---------------------------------------------------------------------------

create or replace function public.analysis_public_facts(p_facts jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(f.key, case when f.key = 'icm' and jsonb_typeof(f.value) = 'object'
                                                then f.value - 'key' else f.value end), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p_facts) = 'object' then p_facts else '{}'::jsonb end) f
  where f.key = any (array[
    'street', 'position', 'inPosition', 'players', 'scenario', 'preflopScenario', 'role', 'facing',
    'potBb', 'toCallBb', 'heroStackBb', 'effStackBb', 'spr', 'potOdds', 'mdf', 'facingPot', 'betPot',
    'behindBb', 'allIn', 'holeCards', 'handClass', 'board', 'texture', 'made', 'draws', 'blockers',
    'equity', 'chart', 'river', 'turn', 'flop', 'multiway', 'icm'
  ]);
$$;

revoke all on function public.analysis_public_facts(jsonb) from public, anon, authenticated;

commit;
