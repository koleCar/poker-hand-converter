-- ============================================================================
-- Field pool program P1: the queue and one pass (docs/POOL.md §5 P1).
-- ============================================================================
--
-- Until now the web worked a hand out only when a page asked: the Stats tab's
-- automatic `/api/stats/rebuild`, `factsCatchUp`, the checker's
-- `backfillAnalyticsRows` and the Pool tab's `backfillPool` each walked "what
-- is still missing" (`hands_needing_*`, anti-joins over `hands`) while the
-- page was open. On a 90k-hand account the walk itself hit the statement
-- timeout. Here a hand is worked out once, when it arrives:
--
--   hands insert ──trigger──▶ derive_queue ──▶ derive_claim ─▶ one parse on
--   the server (web/src/lib/derive/onePass.ts) ─▶ derive_save (statistics,
--   facts, EV, checker rows, pool) or derive_fail
--
-- ## Tables
--
--   * `derive_queue` - one row per hand still to be worked out (the hand's
--     products are written by one pass, whatever brought it here): `reason`
--     says why it came (`new`, `analysis`, `pool`, `villains`, a version
--     such as `stats/3` for a bump), `priority` orders the drain (0 a hand
--     the user is waiting for, 1 a re-count, 2 a backfill), `claimed_at` /
--     `tries` let a worker that died be replaced.
--   * `derive_pending_counts` - the counter: per owner, how many rows the
--     queue holds. Kept by statement triggers on the queue, so "N hands still
--     being processed" is one row read, never a count.
--   * `derive_failures` - hands the pass gave up on (unreadable, or refused
--     by the database three times). Not pending any more; re-enqueue them
--     after a fix (docs/POOL.md P7).
--   * `derive_options` - per account, whether opponents' statistics are
--     derived (the villain rows of `hand_stats`). Was a browser setting
--     (`localStorage`); the server needs to know it when the hand arrives.
--
-- ## Who fills the queue
--
--   * every insert into `hands` with a hero (desktop `ingest_hands`, web
--     `save_hands`, the web upload) - `hands_derive_enqueue`;
--   * a new analysis (`hand_analysis` insert): the checker rows. The browser
--     writes them right after (`analytics_rows_save`), which takes the row out
--     again (`analysis_checker_hands_dequeue`); the queue is the safety net
--     when it did not;
--   * a deleted hand empties the owner's pool (`pool_counted_hands_reset`,
--     until P2 makes a delete subtract): the account is marked
--     (`derive_recounts`) and `derive_claim` queues its hands again, 5 000 a
--     call, so the delete itself stays as cheap as it was;
--   * turning opponents' statistics on (`derive_villains_set`);
--   * a version bump: `derive_enqueue_backlog`, by hand, in batches, out of
--     hours (P7). Granted to nobody.
--
-- ## Who drains it
--
--   * `/api/derive`, as the signed-in user (anon key + cookie): their own
--     rows. The upload calls it right after the hands are stored.
--   * `/api/derive/cron`, as the role `rail_derive` (a JWT with that role
--     from an env var; the route is inert without it): every owner's rows,
--     most urgent and oldest first. The role may execute `derive_claim`,
--     `derive_save` and `derive_fail` and nothing else; it reads and writes
--     no table itself. The service role is never used. Where `authenticator`
--     cannot be granted the role (Supabase reserves it), the JWT names role
--     `authenticated`, no subject and `rail_worker: derive` instead
--     (`derive_caller`; docs/POOL.md P7).
--
-- `derive_save` writes through the existing writers (`save_hand_stats`,
-- `save_hand_ev`, `save_hand_facts`, `analytics_rows_save`) as the hand's
-- owner: for the worker it sets the request's claims to that owner for the
-- call, so the owner's budgets, plan and ownership checks apply exactly as
-- when the browser wrote. Those writers resolved `hand_key` under RLS only;
-- they now also filter `owner_id = auth.uid()` (owner checked twice), which
-- is what makes them safe to call from a definer. The pool is written by
-- `analytics_pool_add(owner, ...)`, the body of `analytics_pool_save`.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.derive_queue (
  hand_id     uuid        primary key references public.hands (id) on delete cascade,
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  reason      text        not null check (reason ~ '^[a-z][a-z0-9_./-]{0,47}$'),
  priority    smallint    not null default 0 check (priority between 0 and 9),
  enqueued_at timestamptz not null default now(),
  claimed_at  timestamptz,
  tries       smallint    not null default 0 check (tries >= 0),
  last_error  text        check (length(last_error) <= 500)
);

comment on table public.derive_queue is
  'P1 (docs/POOL.md): a hand still to be worked out by the one pass (statistics, facts, EV, checker rows, pool). '
  'Filled by triggers, drained by derive_claim / derive_save / derive_fail.';

create index if not exists derive_queue_next_idx on public.derive_queue (priority, enqueued_at, hand_id);
create index if not exists derive_queue_owner_idx on public.derive_queue (owner_id, priority, enqueued_at, hand_id);

create table if not exists public.derive_pending_counts (
  owner_id uuid   primary key references auth.users (id) on delete cascade,
  pending  bigint not null default 0 check (pending >= 0)
);

comment on table public.derive_pending_counts is
  'P1: per owner, the rows derive_queue holds ("N hands still being processed"). Kept by the queue''s triggers.';

create table if not exists public.derive_failures (
  hand_id   uuid        primary key references public.hands (id) on delete cascade,
  owner_id  uuid        not null references auth.users (id) on delete cascade,
  reason    text        not null,
  error     text        check (length(error) <= 500),
  tries     smallint    not null default 0,
  failed_at timestamptz not null default now()
);

comment on table public.derive_failures is
  'P1: hands the one pass gave up on (unreadable, or refused by the database three times). Re-enqueue after a fix.';

create index if not exists derive_failures_owner_idx on public.derive_failures (owner_id);

create table if not exists public.derive_recounts (
  owner_id  uuid        primary key references auth.users (id) on delete cascade,
  reason    text        not null check (reason ~ '^[a-z][a-z0-9_./-]{0,47}$'),
  -- The last hand queued (id order); null: from the first.
  after     uuid,
  queued_at timestamptz not null default now()
);

comment on table public.derive_recounts is
  'P1: an account whose every hand is to be queued again (its pool was emptied by a delete), a page at a time by '
  'derive_claim - so the delete itself stays cheap. P2 replaces it with a delete that subtracts.';

create table if not exists public.derive_options (
  owner_id   uuid        primary key references auth.users (id) on delete cascade,
  villains   boolean     not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.derive_options is
  'P1: how the server derives the account''s hands - villains: the opponents'' rows of hand_stats are written.';

do $$
declare
  t text;
begin
  foreach t in array array['derive_queue', 'derive_pending_counts', 'derive_failures', 'derive_options',
                           'derive_recounts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))',
                   t || '_owner_select', t);
  end loop;
end;
$$;

-- Opponents' statistics were on in a browser of every account that has them.
insert into public.derive_options (owner_id, villains)
select distinct ps.owner_id, true
from public.player_stats ps
where ps.player <> ''
on conflict (owner_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The counter
-- ---------------------------------------------------------------------------

create or replace function public.derive_queue_count_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.derive_pending_counts as c (owner_id, pending)
  select a.owner_id, count(*) from added a group by a.owner_id order by a.owner_id
  on conflict (owner_id) do update set pending = c.pending + excluded.pending;
  return null;
end;
$$;

create or replace function public.derive_queue_count_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Locked in owner order: two drains of overlapping owners never deadlock.
  perform 1 from public.derive_pending_counts c
  where c.owner_id in (select g.owner_id from gone g)
  order by c.owner_id
  for update;
  -- An update, never an insert: an account being deleted has no counter left.
  update public.derive_pending_counts c
     set pending = greatest(0, c.pending - g.n)
    from (select g.owner_id, count(*) as n from gone g group by g.owner_id) g
   where c.owner_id = g.owner_id;
  return null;
end;
$$;

create or replace function public.derive_queue_count_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.derive_pending_counts set pending = 0 where pending <> 0;
  return null;
end;
$$;

revoke all on function public.derive_queue_count_insert() from public, anon, authenticated;
revoke all on function public.derive_queue_count_delete() from public, anon, authenticated;
revoke all on function public.derive_queue_count_truncate() from public, anon, authenticated;

drop trigger if exists derive_queue_count_insert on public.derive_queue;
create trigger derive_queue_count_insert
  after insert on public.derive_queue
  referencing new table as added
  for each statement execute function public.derive_queue_count_insert();

drop trigger if exists derive_queue_count_delete on public.derive_queue;
create trigger derive_queue_count_delete
  after delete on public.derive_queue
  referencing old table as gone
  for each statement execute function public.derive_queue_count_delete();

drop trigger if exists derive_queue_count_truncate on public.derive_queue;
create trigger derive_queue_count_truncate
  after truncate on public.derive_queue
  for each statement execute function public.derive_queue_count_truncate();

-- The caller's hands still being processed: one row read.
create or replace function public.derive_pending()
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce((select c.pending from public.derive_pending_counts c where c.owner_id = (select auth.uid())), 0);
$$;

comment on function public.derive_pending() is
  'P1: how many of the caller''s hands are still being processed (derive_pending_counts).';

revoke all on function public.derive_pending() from public, anon;
grant execute on function public.derive_pending() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Filling the queue
-- ---------------------------------------------------------------------------

-- Every stored hand with a hero, whoever stored it. A hand without one (an
-- observed table) has no statistics, facts, EV or pool to work out.
create or replace function public.hands_derive_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.derive_queue (hand_id, owner_id, reason, priority)
  select i.id, i.owner_id, 'new', 0
  from inserted i
  where i.hero_seat is not null
  order by i.id
  on conflict (hand_id) do nothing;
  return null;
end;
$$;

revoke all on function public.hands_derive_enqueue() from public, anon, authenticated;

drop trigger if exists hands_derive_enqueue on public.hands;
create trigger hands_derive_enqueue
  after insert on public.hands
  referencing new table as inserted
  for each statement execute function public.hands_derive_enqueue();

-- A new analysis: its checker rows (Analytics Step 2). Taken out again when
-- the browser writes them itself (below).
create or replace function public.hand_analysis_derive_enqueue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.derive_queue (hand_id, owner_id, reason, priority)
  select distinct on (i.hand_id) i.hand_id, i.owner_id, 'analysis', 1
  from inserted i
  order by i.hand_id
  on conflict (hand_id) do nothing;
  return null;
end;
$$;

revoke all on function public.hand_analysis_derive_enqueue() from public, anon, authenticated;

drop trigger if exists hand_analysis_derive_enqueue on public.hand_analysis;
create trigger hand_analysis_derive_enqueue
  after insert on public.hand_analysis
  referencing new table as inserted
  for each statement execute function public.hand_analysis_derive_enqueue();

create or replace function public.analysis_checker_hands_dequeue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.derive_queue q
  using (select distinct a.hand_id from added a) a
  where q.hand_id = a.hand_id and q.reason = 'analysis';
  return null;
end;
$$;

revoke all on function public.analysis_checker_hands_dequeue() from public, anon, authenticated;

drop trigger if exists analysis_checker_hands_dequeue on public.analysis_checker_hands;
create trigger analysis_checker_hands_dequeue
  after insert on public.analysis_checker_hands
  referencing new table as added
  for each statement execute function public.analysis_checker_hands_dequeue();

-- A deleted hand empties its owner's pool (20271122100000): every hand left
-- is queued to be counted again, by the server now instead of the Pool tab.
-- (P2 replaces this with a delete that subtracts the hand's own seats.)
create or replace function public.pool_counted_hands_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The reset's own delete of the marks fires this again: once is enough.
  if coalesce(current_setting('rail.pool_reset', true), '') = 'on' then
    return null;
  end if;
  perform set_config('rail.pool_reset', 'on', true);
  delete from public.pool_player_stats s where s.owner_id in (select distinct g.owner_id from gone g);
  delete from public.pool_players p where p.owner_id in (select distinct g.owner_id from gone g);
  delete from public.pool_counted_hands c where c.owner_id in (select distinct g.owner_id from gone g);
  -- Every hand left is to be counted again: marked here, queued a page at a
  -- time by derive_claim (re-queuing a 90k-hand library in the delete took
  -- ~6 s of an 8 s budget). Not while an account or a library is being
  -- wiped: its hands are going.
  if coalesce(current_setting('rail.erasing_account', true), '') = '' then
    insert into public.derive_recounts as r (owner_id, reason, after, queued_at)
    select distinct g.owner_id, 'pool', null::uuid, now()
    from gone g
    join auth.users u on u.id = g.owner_id
    on conflict (owner_id) do update set after = null, queued_at = excluded.queued_at;
  end if;
  perform set_config('rail.pool_reset', '', true);
  return null;
end;
$$;

comment on function public.pool_counted_hands_reset() is
  'Analytics Step 10 / P1: a counted hand''s mark deleted (the hand went) empties its owner''s pool and marks, and '
  'marks the account to have every hand left queued again (derive_recounts).';

revoke all on function public.pool_counted_hands_reset() from public, anon, authenticated;

-- Opponents' statistics on or off for the caller's account. On queues every
-- hand with a hero (their villain rows); off only records it (the browser
-- removes the rows with `prune_villain_stats`, as before).
create or replace function public.derive_villains_set(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid := (select auth.uid());
  v_queued bigint := 0;
begin
  if v_owner is null then
    raise exception 'You must be signed in to change this.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'derive_villains_set needs true or false.' using errcode = '22023';
  end if;
  perform public.enforce_rate_limit('derive_villains:' || v_owner::text, 1, 20, interval '10 minutes');

  insert into public.derive_options as o (owner_id, villains, updated_at)
  values (v_owner, p_on, now())
  on conflict (owner_id) do update set villains = excluded.villains, updated_at = excluded.updated_at;

  if p_on then
    with added as (
      insert into public.derive_queue (hand_id, owner_id, reason, priority)
      select h.id, h.owner_id, 'villains', 0
      from public.hands h
      where h.owner_id = v_owner and h.hero_seat is not null
      order by h.id
      on conflict (hand_id) do nothing
      returning 1
    )
    select count(*) into v_queued from added;
  end if;
  return jsonb_build_object('villains', p_on, 'queued', v_queued);
end;
$$;

comment on function public.derive_villains_set(boolean) is
  'P1: turns the caller''s opponents'' statistics on (queues every hand with a hero for its villain rows) or off.';

revoke all on function public.derive_villains_set(boolean) from public, anon;
grant execute on function public.derive_villains_set(boolean) to authenticated;

-- The caller's setting (false when never set).
create or replace function public.derive_villains()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select o.villains from public.derive_options o where o.owner_id = (select auth.uid())), false);
$$;

revoke all on function public.derive_villains() from public, anon;
grant execute on function public.derive_villains() to authenticated;

-- A version bump or a first rollout (docs/POOL.md P7): queues every hand with
-- a hero after p_after in id order, at most p_limit, for every owner (or one).
-- Run by hand as postgres, in batches, out of hours. Granted to nobody.
create or replace function public.derive_enqueue_backlog(
  p_reason   text,
  p_after    uuid    default null,
  p_limit    integer default 50000,
  p_owner    uuid    default null,
  p_priority smallint default 2
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_last   uuid;
  v_seen   integer;
  v_queued integer;
begin
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_./-]{0,47}$' then
    raise exception 'derive_enqueue_backlog needs a reason.' using errcode = '22023';
  end if;
  with page as (
    select h.id, h.owner_id
    from public.hands h
    where (p_after is null or h.id > p_after)
      and (p_owner is null or h.owner_id = p_owner)
      and h.hero_seat is not null
    order by h.id
    limit least(greatest(coalesce(p_limit, 50000), 1), 200000)
  ), added as (
    insert into public.derive_queue (hand_id, owner_id, reason, priority)
    select p.id, p.owner_id, p_reason, coalesce(p_priority, 2) from page p
    on conflict (hand_id) do nothing
    returning 1
  )
  select (select max(p.id::text)::uuid from page p), (select count(*) from page), (select count(*) from added)
    into v_last, v_seen, v_queued;
  return jsonb_build_object('seen', v_seen, 'queued', v_queued, 'after', v_last, 'done', v_seen < p_limit);
end;
$$;

comment on function public.derive_enqueue_backlog(text, uuid, integer, uuid, smallint) is
  'P1 / P7: queues a page of hands (id order after p_after) for the one pass - a version bump or the first rollout. '
  'Run by hand; granted to nobody.';

revoke all on function public.derive_enqueue_backlog(text, uuid, integer, uuid, smallint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The writers, owner checked twice
-- ---------------------------------------------------------------------------
--
-- `save_hand_stats`, `save_hand_ev` and `save_hand_facts` resolved a row's
-- hand by `hand_key` under RLS alone. `derive_save` runs them from a
-- definer (RLS does not apply to it), so the join names the owner too. The
-- bodies are otherwise those of 20261221090000, 20261207090000 and
-- 20271123090000.

create or replace function public.save_hand_stats(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
  v_resolved integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_stats expects a JSON array of stats rows'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0, 'skipped', 0);
  end if;
  if v_received > 1000 then
    raise exception 'save_hand_stats accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_populate_recordset(null::public.hand_stats, p_rows)
  ),
  deduped as (
    select distinct on (hand_key, stats_version, seat) *
    from input
    where hand_key is not null and btrim(hand_key) <> ''
    order by hand_key, stats_version, seat
  ),
  resolved as (
    -- RLS on `public.hands` is the ownership check, and the owner again for a
    -- definer caller (`derive_save`). `(owner_id, hand_key)` is unique, so
    -- this is at most one row per input.
    select d.*, h.id as resolved_hand_id
    from deduped d
    join public.hands h on h.hand_key = d.hand_key and h.owner_id = v_owner
  ),
  ins as (
    insert into public.hand_stats (
      hand_id, owner_id, stats_version, seat, hand_key, site_id, site_hand_id,
      played_at, variant, limit_type, game_format, site_anonymization,
      currency, currency_minor_units, small_blind, big_blind, player_count,
      max_seats, table_name, tournament_id, fast_fold, has_straddle,
      is_bomb_pot, is_big_blind_ante, is_run_it_twice, has_cashout, is_walk,
      street_reached, pot_type, total_pot, house_into_pot, fees, player, is_hero,
      position, hole_cards, hand_class, starting_stack,
      starting_stack_bb_tenths, hands, vpip_opp, vpip, pfr_opp, pfr, rfi_opp,
      rfi, iso_opp, iso, limp_opp, limp, cold_call_opp, cold_call,
      three_bet_opp, three_bet, four_bet_opp, four_bet, five_bet_opp,
      five_bet, squeeze_opp, squeeze, steal_opp, steal, fold_to_steal_opp,
      fold_to_steal, call_steal, three_bet_vs_steal, fold_to_three_bet_opp,
      fold_to_three_bet, call_three_bet, raise_vs_three_bet,
      fold_to_four_bet_opp, fold_to_four_bet, call_four_bet,
      raise_vs_four_bet, flop_seen, turn_seen, river_seen, cbet_flop_opp,
      cbet_flop, cbet_turn_opp, cbet_turn, cbet_river_opp, cbet_river,
      fold_to_cbet_flop_opp, fold_to_cbet_flop, call_cbet_flop,
      raise_cbet_flop, fold_to_cbet_turn_opp, fold_to_cbet_turn,
      call_cbet_turn, raise_cbet_turn, fold_to_cbet_river_opp,
      fold_to_cbet_river, call_cbet_river, raise_cbet_river, donk_flop_opp,
      donk_flop, donk_turn_opp, donk_turn, donk_river_opp, donk_river,
      check_raise_flop_opp, check_raise_flop, check_raise_turn_opp,
      check_raise_turn, check_raise_river_opp, check_raise_river, bet_flop,
      raise_flop, call_flop, check_flop, fold_flop, bet_turn, raise_turn,
      call_turn, check_turn, fold_turn, bet_river, raise_river, call_river,
      check_river, fold_river, wwsf_opp, wwsf, wtsd_opp, wtsd, wsd_opp, wsd,
      cashed_out, won, contributed, net, net_bb_milli, rake_paid, out_of_pot,
      cashout_risk
    )
    select
      r.resolved_hand_id, v_owner, r.stats_version, r.seat, r.hand_key,
      r.site_id, r.site_hand_id, r.played_at, r.variant, r.limit_type,
      r.game_format, r.site_anonymization, r.currency, r.currency_minor_units,
      r.small_blind, r.big_blind, r.player_count, r.max_seats, r.table_name,
      r.tournament_id, r.fast_fold, r.has_straddle, r.is_bomb_pot,
      r.is_big_blind_ante, r.is_run_it_twice, r.has_cashout, r.is_walk,
      r.street_reached, r.pot_type, r.total_pot, r.house_into_pot, r.fees, r.player,
      r.is_hero, r.position, r.hole_cards, r.hand_class, r.starting_stack,
      r.starting_stack_bb_tenths, r.hands, r.vpip_opp, r.vpip, r.pfr_opp,
      r.pfr, r.rfi_opp, r.rfi, r.iso_opp, r.iso, r.limp_opp, r.limp,
      r.cold_call_opp, r.cold_call, r.three_bet_opp, r.three_bet,
      r.four_bet_opp, r.four_bet, r.five_bet_opp, r.five_bet, r.squeeze_opp,
      r.squeeze, r.steal_opp, r.steal, r.fold_to_steal_opp, r.fold_to_steal,
      r.call_steal, r.three_bet_vs_steal, r.fold_to_three_bet_opp,
      r.fold_to_three_bet, r.call_three_bet, r.raise_vs_three_bet,
      r.fold_to_four_bet_opp, r.fold_to_four_bet, r.call_four_bet,
      r.raise_vs_four_bet, r.flop_seen, r.turn_seen, r.river_seen,
      r.cbet_flop_opp, r.cbet_flop, r.cbet_turn_opp, r.cbet_turn,
      r.cbet_river_opp, r.cbet_river, r.fold_to_cbet_flop_opp,
      r.fold_to_cbet_flop, r.call_cbet_flop, r.raise_cbet_flop,
      r.fold_to_cbet_turn_opp, r.fold_to_cbet_turn, r.call_cbet_turn,
      r.raise_cbet_turn, r.fold_to_cbet_river_opp, r.fold_to_cbet_river,
      r.call_cbet_river, r.raise_cbet_river, r.donk_flop_opp, r.donk_flop,
      r.donk_turn_opp, r.donk_turn, r.donk_river_opp, r.donk_river,
      r.check_raise_flop_opp, r.check_raise_flop, r.check_raise_turn_opp,
      r.check_raise_turn, r.check_raise_river_opp, r.check_raise_river,
      r.bet_flop, r.raise_flop, r.call_flop, r.check_flop, r.fold_flop,
      r.bet_turn, r.raise_turn, r.call_turn, r.check_turn, r.fold_turn,
      r.bet_river, r.raise_river, r.call_river, r.check_river, r.fold_river,
      r.wwsf_opp, r.wwsf, r.wtsd_opp, r.wtsd, r.wsd_opp, r.wsd, r.cashed_out,
      r.won, r.contributed, r.net, r.net_bb_milli, r.rake_paid, r.out_of_pot,
      r.cashout_risk
    from resolved r
    -- Villain rows for a positionally anonymised room are refused here as well
    -- as by `hand_stats_positional_anonymity`, so a client that sends them gets
    -- them dropped rather than the whole batch rejected. The constraint is what
    -- makes it impossible; this is what makes it survivable.
    where r.is_hero or r.site_anonymization <> 'positional'
    on conflict (hand_id, stats_version, seat) do nothing
    returning 1
  )
  select (select count(*) from resolved)::integer,
         (select count(*) from ins)::integer
    into v_resolved, v_inserted;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   coalesce(v_inserted, 0),
    -- Rows whose hand was found but that were already stored.
    'duplicates', coalesce(v_resolved, 0) - coalesce(v_inserted, 0),
    -- Rows naming a hand this caller does not have. Not an error: a client that
    -- derives statistics for a batch it then fails to save should report a
    -- number, not throw.
    'skipped',    v_received - coalesce(v_resolved, 0)
  );
end;
$$;

create or replace function public.save_hand_ev(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_ev expects a JSON array' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 1000 then
    raise exception 'save_hand_ev accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_to_recordset(p_rows) as x(
      hand_key text, seat smallint, ev_version text, applicable boolean,
      ev_net bigint, ev_net_bb_milli bigint)
  ),
  ins as (
    insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
    select h.id, v_owner, i.seat, i.ev_version, i.hand_key, i.applicable, i.ev_net, i.ev_net_bb_milli
    from input i
    -- RLS on `hands` is the ownership check, as in `save_hand_stats`; the
    -- owner again for a definer caller.
    join public.hands h on h.hand_key = i.hand_key and h.owner_id = v_owner
    on conflict (hand_id, ev_version, seat) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object('received', v_received, 'inserted', v_inserted);
end;
$$;

create or replace function public.save_hand_facts(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_facts expects a JSON array' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 1000 then
    raise exception 'save_hand_facts accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_to_recordset(p_rows) as x(
      hand_key text, facts_version text, open_tenths integer, flop_bet_pct integer, turn_bet_pct integer,
      river_bet_pct integer, flop_made smallint, turn_made smallint, river_made smallint, flop_kicker smallint,
      turn_kicker smallint, river_kicker smallint, flop_draws smallint, turn_draws smallint, players_flop smallint,
      hero_ip boolean, vs_seats text, vs_positions text, vs_players text[], buy_in_cents bigint, bounty boolean,
      tour_level integer, hero_bluff smallint, vs_bluff smallint, eff_stack_tenths integer)
  ),
  ins as (
    -- RLS on `hands` is the ownership check; the owner again for a definer caller.
    insert into public.hand_facts (
      hand_id, owner_id, facts_version, hand_key, open_tenths, flop_bet_pct, turn_bet_pct, river_bet_pct,
      flop_made, turn_made, river_made, flop_kicker, turn_kicker, river_kicker, flop_draws, turn_draws,
      players_flop, hero_ip, vs_seats, vs_positions, vs_players, buy_in_cents, bounty, tour_level,
      hero_bluff, vs_bluff, eff_stack_tenths)
    select h.id, v_owner, i.facts_version, i.hand_key, i.open_tenths, i.flop_bet_pct, i.turn_bet_pct,
           i.river_bet_pct, i.flop_made, i.turn_made, i.river_made, i.flop_kicker, i.turn_kicker, i.river_kicker,
           coalesce(i.flop_draws, 0), coalesce(i.turn_draws, 0), coalesce(i.players_flop, 0), i.hero_ip,
           coalesce(i.vs_seats, ''), coalesce(i.vs_positions, ''), coalesce(i.vs_players, '{}'),
           i.buy_in_cents, coalesce(i.bounty, false), i.tour_level, coalesce(i.hero_bluff, 0),
           coalesce(i.vs_bluff, 0), i.eff_stack_tenths
    from input i
    join public.hands h on h.hand_key = i.hand_key and h.owner_id = v_owner
    on conflict (hand_id, facts_version) do nothing
    returning hand_id, facts_version
  ),
  -- The hands just saved at a version: their rows at any older one go (the
  -- newest version saved for a hand in this call decides).
  saved as (
    select hand_id, max(substr(facts_version, 7)::integer) as version from ins group by hand_id
  ),
  pruned as (
    delete from public.hand_facts f
    using saved s
    where f.hand_id = s.hand_id and f.owner_id = v_owner
      and substr(f.facts_version, 7)::integer < s.version
    returning 1
  )
  select (select count(*) from ins) into v_inserted
  from (select count(*) from pruned) p;
  return jsonb_build_object('received', v_received, 'inserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The pool's writer, for an owner
-- ---------------------------------------------------------------------------
--
-- The body of `analytics_pool_save` (20271122100000) with the owner as an
-- argument: `derive_save` counts every account's opponents (the reader stays
-- Pro), `analytics_pool_save` keeps its gate and calls it for the caller.

create or replace function public.analytics_pool_add(p_owner uuid, p_version text, p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := p_owner;
  v_received integer;
  v_new      uuid[];
  v_players  integer;
begin
  if v_owner is null then
    raise exception 'analytics_pool_add needs an owner.' using errcode = '22023';
  end if;
  if p_version is null or p_version !~ '^analytics/[0-9]+$' then
    raise exception 'analytics_pool_save needs a membership version.' using errcode = '22023';
  end if;
  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'analytics_pool_save expects a JSON array of hands.' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_hands);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'saved', 0, 'players', 0);
  end if;
  if v_received > 200 then
    raise exception 'analytics_pool_save accepts at most 200 hands per call (got %).', v_received
      using errcode = '53400';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'hand_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or jsonb_typeof(e -> 'players') is distinct from 'array'
       or jsonb_array_length(e -> 'players') > 12)
  then
    raise exception 'analytics_pool_save: a hand needs hand_id and players (at most 12).' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e, jsonb_array_elements(e -> 'players') pl
    where jsonb_typeof(pl) <> 'object'
       or jsonb_typeof(pl -> 'player') is distinct from 'string'
       or length(pl ->> 'player') not between 1 and 100
       or jsonb_typeof(pl -> 'net_bb') not in ('number', 'null')
       or abs(coalesce((pl ->> 'net_bb')::numeric, 0)) > 1000000
       or jsonb_typeof(pl -> 'stats') is distinct from 'object')
  then
    raise exception 'analytics_pool_save: a player needs player (1-100 characters), net_bb and stats.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e, jsonb_array_elements(e -> 'players') pl,
                  jsonb_each(pl -> 'stats') st(k, v)
    where st.k !~ '^[a-z][a-z0-9_]{0,47}$'
       or jsonb_typeof(st.v) is distinct from 'array' or jsonb_array_length(st.v) <> 2
       or jsonb_typeof(st.v -> 0) is distinct from 'number' or jsonb_typeof(st.v -> 1) is distinct from 'number'
       or (st.v ->> 0)::numeric not between 0 and 100 or (st.v ->> 1)::numeric not between 0 and 100
       or (st.v ->> 0)::numeric > (st.v ->> 1)::numeric
       or (st.v ->> 0)::numeric <> trunc((st.v ->> 0)::numeric)
       or (st.v ->> 1)::numeric <> trunc((st.v ->> 1)::numeric))
  then
    raise exception 'analytics_pool_save: a rate''s counts are [made, opportunities], whole numbers 0-100, made <= opportunities.'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('analytics_pool:' || v_owner::text, v_received, 200000, interval '10 minutes');

  -- Counted at another version: the catalogue changed, everything is counted again.
  delete from public.pool_player_stats where owner_id = v_owner and membership_version <> p_version;
  delete from public.pool_players where owner_id = v_owner and membership_version <> p_version;

  -- The owner's hands, marked now (not at this version before).
  with input as (
    select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id
    from jsonb_array_elements(p_hands) with ordinality as t(e, n)
    order by (e ->> 'hand_id')::uuid, n
  ), marked as (
    insert into public.pool_counted_hands as c (hand_id, owner_id, membership_version, saved_at)
    select i.hand_id, v_owner, p_version, now()
    from input i
    join public.hands h on h.id = i.hand_id and h.owner_id = v_owner
    on conflict (hand_id) do update
      set membership_version = excluded.membership_version, saved_at = excluded.saved_at
      where c.membership_version <> excluded.membership_version and c.owner_id = excluded.owner_id
    returning c.hand_id
  )
  select coalesce(array_agg(hand_id), '{}') into v_new from marked;

  with seats as (
    -- Their players: the first entry of a hand named twice, one row per name a hand.
    select distinct on (x.hand_id, pl ->> 'player')
           h.site as site_id, pl ->> 'player' as player, h.game_format::text as game_format,
           (pl ->> 'net_bb')::double precision as net_bb, pl -> 'stats' as stats
    from (
      select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id, e -> 'players' as players
      from jsonb_array_elements(p_hands) with ordinality as t(e, n)
      order by (e ->> 'hand_id')::uuid, n
    ) x
    join public.hands h on h.id = x.hand_id and h.owner_id = v_owner
    cross join lateral jsonb_array_elements(x.players) pl
    where x.hand_id = any (v_new)
    order by x.hand_id, pl ->> 'player'
  ), added as (
    insert into public.pool_players as p (owner_id, membership_version, site_id, player, game_format, hands, net_bb, net_bb_sq)
    select v_owner, p_version, s.site_id, s.player, s.game_format,
           count(s.net_bb), coalesce(sum(s.net_bb), 0), coalesce(sum(s.net_bb * s.net_bb), 0)
    from seats s
    group by s.site_id, s.player, s.game_format
    on conflict (owner_id, membership_version, site_id, player, game_format) do update
      set hands = p.hands + excluded.hands, net_bb = p.net_bb + excluded.net_bb, net_bb_sq = p.net_bb_sq + excluded.net_bb_sq
    returning 1
  )
  select (select count(*) from seats) into v_players;

  with seats as (
    select distinct on (x.hand_id, pl ->> 'player')
           h.site as site_id, pl ->> 'player' as player, h.game_format::text as game_format,
           (pl ->> 'net_bb')::double precision as net_bb, pl -> 'stats' as stats
    from (
      select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id, e -> 'players' as players
      from jsonb_array_elements(p_hands) with ordinality as t(e, n)
      order by (e ->> 'hand_id')::uuid, n
    ) x
    join public.hands h on h.id = x.hand_id and h.owner_id = v_owner
    cross join lateral jsonb_array_elements(x.players) pl
    where x.hand_id = any (v_new)
    order by x.hand_id, pl ->> 'player'
  )
  insert into public.pool_player_stats as p (owner_id, membership_version, site_id, player, game_format, stat, made, opp)
  select v_owner, p_version, s.site_id, s.player, s.game_format, st.k,
         sum((st.v ->> 0)::bigint), sum((st.v ->> 1)::bigint)
  from seats s
  cross join lateral jsonb_each(s.stats) st(k, v)
  where (st.v ->> 1)::bigint > 0
  group by s.site_id, s.player, s.game_format, st.k
  on conflict (owner_id, membership_version, site_id, player, game_format, stat) do update
    set made = p.made + excluded.made, opp = p.opp + excluded.opp;

  return jsonb_build_object('received', v_received, 'saved', cardinality(v_new), 'players', v_players);
end;
$$;

comment on function public.analytics_pool_add(uuid, text, jsonb) is
  'P1: analytics_pool_save''s body for an owner (derive_save''s pool writer). Granted to nobody.';

revoke all on function public.analytics_pool_add(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.analytics_pool_save(p_version text, p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to save your pool.' using errcode = '42501';
  end if;
  return public.analytics_pool_add(v_owner, p_version, p_hands);
end;
$$;

comment on function public.analytics_pool_save(text, jsonb) is
  'Analytics Step 10: marks up to 200 of the caller''s hands counted at a membership version and adds their '
  'opponents'' counts (hands, results, catalogue rates) to pool_players / pool_player_stats; a hand already marked '
  'at that version adds nothing. Since P1 the server counts on arrival (derive_save); kept for older clients.';

revoke all on function public.analytics_pool_save(text, jsonb) from public, anon;
grant execute on function public.analytics_pool_save(text, jsonb) to authenticated;

-- The Pool tab's reader: `pending` is the derive counter now, not an
-- anti-join over the caller's hands. Otherwise the body of 20271122100000.
create or replace function public.analytics_pool(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner   uuid := auth.uid();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_mv      text;
  v_formats text[];
  v_sites   text[];
  v_stats   text := coalesce(nullif(btrim(coalesce(v_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_pending bigint;
  v_out     jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read your pool.' using errcode = '42501';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'analytics_pool expects a JSON object of filters.' using errcode = '22023';
  end if;
  v_mv := public.analytics_membership_version_of(v_filters);
  v_formats := public.filter_formats(v_filters);
  if jsonb_typeof(v_filters -> 'sites') = 'array' and jsonb_array_length(v_filters -> 'sites') > 0 then
    v_sites := array(select jsonb_array_elements_text(v_filters -> 'sites'));
  end if;

  v_pending := public.derive_pending();

  with types as (
    select t.site_id, t.player,
           case when t.n >= 30 and t.vpip >= 40 then 'fish'
                when t.n >= 30 and t.vpip between 15 and 30 and t.pfr >= t.vpip * 0.6 then 'reg'
           end as kind
    from (
      select ps.site_id, ps.player,
             coalesce(sum(ps.hands), 0) as n,
             coalesce(sum(ps.vpip), 0) * 100.0 / greatest(coalesce(sum(ps.vpip_opp), 0), 1) as vpip,
             coalesce(sum(ps.pfr), 0) * 100.0 / greatest(coalesce(sum(ps.pfr_opp), 0), 1) as pfr
      from public.player_stats ps
      where ps.owner_id = v_owner and ps.stats_version = v_stats and ps.player <> ''
      group by ps.site_id, ps.player
    ) t
  ), members as (
    select p.site_id, p.player, ty.kind,
           sum(p.hands) as hands, sum(p.net_bb) as net_bb, sum(p.net_bb_sq) as net_bb_sq
    from public.pool_players p
    join types ty on ty.site_id = p.site_id and ty.player = p.player and ty.kind is not null
    where p.owner_id = v_owner and p.membership_version = v_mv
      and (v_formats is null or p.game_format = any (v_formats))
      and (v_sites is null or p.site_id = any (v_sites))
    group by p.site_id, p.player, ty.kind
    having sum(p.hands) > 0
  ), by_type as (
    select m.kind, count(*) as players, sum(m.hands) as hands, sum(m.net_bb) as net_bb, sum(m.net_bb_sq) as net_bb_sq
    from members m
    group by m.kind
  ), rates as (
    select s.stat, m.kind, sum(s.made) as made, sum(s.opp) as opp
    from public.pool_player_stats s
    join members m on m.site_id = s.site_id and m.player = s.player
    where s.owner_id = v_owner and s.membership_version = v_mv
      and (v_formats is null or s.game_format = any (v_formats))
      and (v_sites is null or s.site_id = any (v_sites))
    group by s.stat, m.kind
    having sum(s.opp) > 0
  )
  select jsonb_build_object(
    'version', v_mv,
    'pending', v_pending,
    'reg', coalesce((select jsonb_build_object('players', b.players, 'hands', b.hands, 'netBb', b.net_bb, 'netBbSq', b.net_bb_sq)
                     from by_type b where b.kind = 'reg'),
                    jsonb_build_object('players', 0, 'hands', 0, 'netBb', 0, 'netBbSq', 0)),
    'fish', coalesce((select jsonb_build_object('players', b.players, 'hands', b.hands, 'netBb', b.net_bb, 'netBbSq', b.net_bb_sq)
                      from by_type b where b.kind = 'fish'),
                     jsonb_build_object('players', 0, 'hands', 0, 'netBb', 0, 'netBbSq', 0)),
    'stats', coalesce((select jsonb_agg(jsonb_build_object('stat', r.stat, 'type', r.kind, 'made', r.made, 'opp', r.opp)
                                        order by r.stat collate "C", r.kind desc)
                       from rates r), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;

comment on function public.analytics_pool(jsonb) is
  'Analytics Step 10: the caller''s regs and fish (Rail''s types over player_stats) - players, hands, sum of results '
  'and of their squares - and their catalogue rates, over the rooms and formats named; pending: the caller''s hands '
  'still being processed (derive_pending, P1).';

revoke all on function public.analytics_pool(jsonb) from public, anon;
grant execute on function public.analytics_pool(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The worker's three functions
-- ---------------------------------------------------------------------------

-- Who is draining: the signed-in user (their own rows) or the derive role
-- (every owner's). Anyone else is refused.
create or replace function public.derive_caller()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is not null then
    return v_owner;
  end if;
  -- The worker's JWT: role rail_derive (PostgREST switched to the dedicated
  -- role), or - where the platform does not let `authenticator` switch to a
  -- custom role - role authenticated with no subject and `rail_worker` =
  -- 'derive'. Only a holder of the project's signing key can mint either.
  if coalesce((select auth.role()), '') = 'rail_derive'
     or (coalesce((select auth.role()), '') = 'authenticated'
         and coalesce((select auth.jwt()) ->> 'rail_worker', '') = 'derive') then
    return null;
  end if;
  raise exception 'You must be signed in to process hands.' using errcode = '42501';
end;
$$;

revoke all on function public.derive_caller() from public, anon, authenticated;

-- Queues the next page of an account's hands marked for a recount
-- (`derive_recounts`), at most p_limit, and moves its cursor; the mark goes
-- when the last page is queued. p_owner: that account's, else the oldest
-- mark's. Internal: derive_claim calls it.
create or replace function public.derive_recount_step(p_owner uuid, p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_mark  public.derive_recounts;
  v_last  uuid;
  v_seen  integer;
begin
  select * into v_mark from public.derive_recounts r
  where p_owner is null or r.owner_id = p_owner
  order by r.queued_at, r.owner_id
  limit 1
  for update skip locked;
  if not found then
    return 0;
  end if;
  with page as (
    select h.id from public.hands h
    where h.owner_id = v_mark.owner_id and h.hero_seat is not null
      and (v_mark.after is null or h.id > v_mark.after)
    order by h.id
    limit greatest(coalesce(p_limit, 5000), 1)
  ), added as (
    insert into public.derive_queue (hand_id, owner_id, reason, priority)
    select p.id, v_mark.owner_id, v_mark.reason, 1 from page p
    on conflict (hand_id) do nothing
    returning 1
  )
  select (select max(p.id::text)::uuid from page p), (select count(*) from page) into v_last, v_seen
  from (select count(*) from added) a;
  if v_seen < greatest(coalesce(p_limit, 5000), 1) then
    delete from public.derive_recounts r where r.owner_id = v_mark.owner_id;
  else
    update public.derive_recounts r set after = v_last where r.owner_id = v_mark.owner_id;
  end if;
  return v_seen;
end;
$$;

revoke all on function public.derive_recount_step(uuid, integer) from public, anon, authenticated;

-- A page of the queue, claimed for a few minutes: the hands (their stored
-- document or text, as hands_needing_stats returned them), whether the
-- owner's opponents' statistics are on, and - for a hand analysed at
-- p_versions.analysis without checker rows at p_versions.membership - its
-- decisions (as analytics_rows_pending returned them).
create or replace function public.derive_claim(p_limit integer default 50, p_versions jsonb default '{}'::jsonb)
returns table (
  hand_id uuid, owner_id uuid, reason text, villains boolean,
  phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz,
  analysis_version text, decisions jsonb
)
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_owner uuid := public.derive_caller();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_av    text := nullif(btrim(coalesce(p_versions ->> 'analysis', '')), '');
  v_mv    text := nullif(btrim(coalesce(p_versions ->> 'membership', '')), '');
  v_ids   uuid[];
begin
  if p_versions is not null and jsonb_typeof(p_versions) <> 'object' then
    raise exception 'derive_claim expects a JSON object of versions.' using errcode = '22023';
  end if;
  if v_mv is not null and v_mv !~ '^analytics/[0-9]+$' then
    raise exception 'derive_claim: a membership version is analytics/N.' using errcode = '22023';
  end if;

  -- An account marked for a recount: its next page of hands joins the queue.
  perform public.derive_recount_step(v_owner, 5000);

  -- A hand that crashed its worker five times is given up on.
  with dead as (
    delete from public.derive_queue q
    where q.tries >= 5 and q.claimed_at < now() - interval '5 minutes'
      and (v_owner is null or q.owner_id = v_owner)
    returning q.hand_id, q.owner_id, q.reason, q.tries, q.last_error
  )
  insert into public.derive_failures as f (hand_id, owner_id, reason, error, tries, failed_at)
  select d.hand_id, d.owner_id, d.reason, coalesce(d.last_error, 'The worker stopped before it finished.'), d.tries, now()
  from dead d
  on conflict (hand_id) do update
    set reason = excluded.reason, error = excluded.error, tries = excluded.tries, failed_at = excluded.failed_at;

  -- Free rows, or rows a worker claimed and never answered for.
  if v_owner is null then
    select array_agg(x.hand_id) into v_ids from (
      select q.hand_id from public.derive_queue q
      where (q.claimed_at is null or q.claimed_at < now() - interval '5 minutes') and q.tries < 5
      order by q.priority, q.enqueued_at, q.hand_id
      limit v_limit
      for update skip locked
    ) x;
  else
    select array_agg(x.hand_id) into v_ids from (
      select q.hand_id from public.derive_queue q
      where q.owner_id = v_owner
        and (q.claimed_at is null or q.claimed_at < now() - interval '5 minutes') and q.tries < 5
      order by q.priority, q.enqueued_at, q.hand_id
      limit v_limit
      for update skip locked
    ) x;
  end if;
  if v_ids is null then
    return;
  end if;

  update public.derive_queue q set claimed_at = now(), tries = q.tries + 1 where q.hand_id = any (v_ids);

  return query
  select q.hand_id, q.owner_id, q.reason, coalesce(o.villains, false),
         h.phf, case when h.phf is null then h.standard_text end,
         h.hand_key, h.site, h.parser_version, h.source_filename, h.created_at,
         a.analysis_version,
         case when a.analysis_version is null then null else coalesce((
           select jsonb_agg(jsonb_build_object(
                    'ord', d.ord, 'action_index', d.action_index, 'status', d.status, 'options', d.options,
                    'ev_loss_bb', d.ev_loss_bb, 'facts', d.facts) order by d.ord)
           from public.decision_analysis d
           where d.hand_id = q.hand_id and d.analysis_version = a.analysis_version and d.owner_id = q.owner_id),
           '[]'::jsonb) end
  from public.derive_queue q
  join public.hands h on h.id = q.hand_id and h.owner_id = q.owner_id
  left join public.derive_options o on o.owner_id = q.owner_id
  left join lateral (
    select ha.analysis_version from public.hand_analysis ha
    where v_av is not null and v_mv is not null
      and ha.hand_id = q.hand_id and ha.analysis_version = v_av and ha.owner_id = q.owner_id
      and not exists (
        select 1 from public.analysis_checker_hands c
        where c.hand_id = ha.hand_id and c.analysis_version = ha.analysis_version and c.membership_version = v_mv)
  ) a on true
  where q.hand_id = any (v_ids)
  order by q.priority, q.enqueued_at, q.hand_id;
end;
$$;

comment on function public.derive_claim(integer, jsonb) is
  'P1: claims up to 100 queued hands (the caller''s, or every owner''s for rail_derive) for five minutes and returns '
  'what the one pass needs to work each out.';

-- One owner's products of a few hands, through the existing writers, as that
-- owner. p_hands: [{hand_id, stats: [...], ev: [...], facts: {...} | null,
-- checker: {analysis_version, membership_version, rows} | null,
-- pool: {version, players} | null}], already checked to be the owner's.
create or replace function public.derive_write(p_owner uuid, p_hands jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows  jsonb;
  v_chunk jsonb := '[]'::jsonb;
  v_hand  jsonb;
  v_n     integer := 0;
  v_pv    text;
begin
  -- Statistics, then EV and facts (a hand whose statistics are refused
  -- refuses the call: derive_save retries hand by hand). A row names its own
  -- hand only.
  for v_hand in
    select jsonb_build_object('rows', coalesce(jsonb_agg(r), '[]'::jsonb))
    from jsonb_array_elements(p_hands) e
    join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
    cross join lateral jsonb_array_elements(case when jsonb_typeof(e -> 'stats') = 'array' then e -> 'stats' else '[]'::jsonb end) r
    where r ->> 'hand_key' = h.hand_key
    group by h.id
  loop
    v_rows := v_hand -> 'rows';
    if v_n > 0 and v_n + jsonb_array_length(v_rows) > 1000 then
      perform public.save_hand_stats(v_chunk);
      v_chunk := '[]'::jsonb;
      v_n := 0;
    end if;
    v_chunk := v_chunk || v_rows;
    v_n := v_n + jsonb_array_length(v_rows);
  end loop;
  if v_n > 0 then
    perform public.save_hand_stats(v_chunk);
  end if;

  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows
  from jsonb_array_elements(p_hands) e
  join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
  cross join lateral jsonb_array_elements(case when jsonb_typeof(e -> 'ev') = 'array' then e -> 'ev' else '[]'::jsonb end) r
  where r ->> 'hand_key' = h.hand_key;
  if jsonb_array_length(v_rows) > 0 then
    perform public.save_hand_ev(v_rows);
  end if;

  select coalesce(jsonb_agg(e -> 'facts'), '[]'::jsonb) into v_rows
  from jsonb_array_elements(p_hands) e
  join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
  where jsonb_typeof(e -> 'facts') = 'object' and e -> 'facts' ->> 'hand_key' = h.hand_key;
  if jsonb_array_length(v_rows) > 0 then
    perform public.save_hand_facts(v_rows);
  end if;

  -- Checker rows: an analysed hand's (analysis is Pro; an owner without it
  -- any more keeps the analysis and gets no new rows).
  if public.has_entitlement(p_owner, 'analysis') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'hand_id', h.id,
             'analysis_version', e -> 'checker' ->> 'analysis_version',
             'membership_version', e -> 'checker' ->> 'membership_version',
             'rows', coalesce(e -> 'checker' -> 'rows', '[]'::jsonb))), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_hands) e
    join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
    where jsonb_typeof(e -> 'checker') = 'object';
    if jsonb_array_length(v_rows) > 0 then
      perform public.analytics_rows_save(v_rows);
    end if;
  end if;

  -- The pool, per catalogue version sent (one, in practice).
  for v_pv in
    select distinct e -> 'pool' ->> 'version' from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e -> 'pool') = 'object'
  loop
    select coalesce(jsonb_agg(jsonb_build_object('hand_id', h.id, 'players', coalesce(e -> 'pool' -> 'players', '[]'::jsonb))),
                    '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_hands) e
    join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
    where jsonb_typeof(e -> 'pool') = 'object' and e -> 'pool' ->> 'version' is not distinct from v_pv;
    if jsonb_array_length(v_rows) > 0 then
      perform public.analytics_pool_add(p_owner, v_pv, v_rows);
    end if;
  end loop;
end;
$$;

revoke all on function public.derive_write(uuid, jsonb) from public, anon, authenticated;

-- Sets the request's identity to p_owner for the writers' auth.uid() (both
-- forms PostgREST has used), and returns what was there.
create or replace function public.derive_act_as(p_owner uuid, p_claims text default null, p_sub text default null)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text[] := array[current_setting('request.jwt.claims', true), current_setting('request.jwt.claim.sub', true)];
begin
  if p_owner is null then
    perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_owner, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', p_owner::text, true);
  end if;
  return v_before;
end;
$$;

revoke all on function public.derive_act_as(uuid, text, text) from public, anon, authenticated;

-- The pass's answers for claimed hands: written as their owners, then taken
-- off the queue. A call the database refuses for its data (class 22 or 23)
-- is retried hand by hand; a hand still refused is counted a failure (the
-- third one gives it up). Returns {saved, failed}.
create or replace function public.derive_save(p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller  uuid := public.derive_caller();
  v_before  text[];
  v_owner   uuid;
  v_mine    jsonb;
  v_hand    jsonb;
  v_saved   uuid[] := '{}';
  v_failed  uuid[] := '{}';
  v_ids     uuid[];
  v_error   text;
begin
  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'derive_save expects a JSON array of hands.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_hands) > 100 then
    raise exception 'derive_save accepts at most 100 hands per call (got %).', jsonb_array_length(p_hands)
      using errcode = '53400';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e) <> 'object' or coalesce(e ->> 'hand_id', '') !~ '^[0-9a-fA-F-]{36}$')
  then
    raise exception 'derive_save: every hand needs a hand_id.' using errcode = '22023';
  end if;

  v_before := array[current_setting('request.jwt.claims', true), current_setting('request.jwt.claim.sub', true)];

  -- The queued hands among them (the caller's own for a user), by owner.
  for v_owner, v_mine in
    select q.owner_id, jsonb_agg(e order by q.hand_id)
    from jsonb_array_elements(p_hands) e
    join public.derive_queue q on q.hand_id = (e ->> 'hand_id')::uuid
    where v_caller is null or q.owner_id = v_caller
    group by q.owner_id
    order by q.owner_id
  loop
    perform public.derive_act_as(v_owner);
    select array_agg((x ->> 'hand_id')::uuid) into v_ids from jsonb_array_elements(v_mine) x;
    begin
      perform public.derive_write(v_owner, v_mine);
      v_saved := v_saved || v_ids;
    exception when data_exception or integrity_constraint_violation then
      for v_hand in select x from jsonb_array_elements(v_mine) x loop
        begin
          perform public.derive_write(v_owner, jsonb_build_array(v_hand));
          v_saved := v_saved || (v_hand ->> 'hand_id')::uuid;
        exception when data_exception or integrity_constraint_violation then
          get stacked diagnostics v_error = message_text;
          v_failed := v_failed || (v_hand ->> 'hand_id')::uuid;
          update public.derive_queue q
             set claimed_at = null, last_error = left(v_error, 500)
           where q.hand_id = (v_hand ->> 'hand_id')::uuid;
        end;
      end loop;
    end;
  end loop;
  perform public.derive_act_as(null, v_before[1], v_before[2]);

  delete from public.derive_queue q where q.hand_id = any (v_saved);

  -- Refused three times: given up.
  with dead as (
    delete from public.derive_queue q
    where q.hand_id = any (v_failed) and q.tries >= 3
    returning q.hand_id, q.owner_id, q.reason, q.tries, q.last_error
  )
  insert into public.derive_failures as f (hand_id, owner_id, reason, error, tries, failed_at)
  select d.hand_id, d.owner_id, d.reason, d.last_error, d.tries, now() from dead d
  on conflict (hand_id) do update
    set reason = excluded.reason, error = excluded.error, tries = excluded.tries, failed_at = excluded.failed_at;

  -- Worked out at last: no longer a failure.
  delete from public.derive_failures f where f.hand_id = any (v_saved);

  return jsonb_build_object('saved', cardinality(v_saved), 'failed', cardinality(v_failed));
end;
$$;

comment on function public.derive_save(jsonb) is
  'P1: writes the one pass''s products of up to 100 claimed hands (statistics, EV, facts, checker rows, pool) as '
  'their owners through the existing writers, and takes them off the queue.';

-- Hands the pass could not work out: [{hand_id, error, final}]. A final one
-- (the hand cannot be read) or one on its third try is given up; any other
-- goes back to the queue.
create or replace function public.derive_fail(p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := public.derive_caller();
  v_gone   integer;
  v_back   integer;
begin
  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'derive_fail expects a JSON array of hands.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_hands) > 100 then
    raise exception 'derive_fail accepts at most 100 hands per call (got %).', jsonb_array_length(p_hands)
      using errcode = '53400';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e) <> 'object' or coalesce(e ->> 'hand_id', '') !~ '^[0-9a-fA-F-]{36}$')
  then
    raise exception 'derive_fail: every hand needs a hand_id.' using errcode = '22023';
  end if;

  with input as (
    select distinct on ((e ->> 'hand_id')::uuid)
           (e ->> 'hand_id')::uuid as hand_id,
           left(coalesce(e ->> 'error', 'The hand could not be worked out.'), 500) as error,
           coalesce((e ->> 'final')::boolean, false) as final
    from jsonb_array_elements(p_hands) e
    order by (e ->> 'hand_id')::uuid
  ), dead as (
    delete from public.derive_queue q
    using input i
    where q.hand_id = i.hand_id and (v_caller is null or q.owner_id = v_caller)
      and (i.final or q.tries >= 3)
    returning q.hand_id, q.owner_id, q.reason, q.tries, i.error
  ), kept as (
    insert into public.derive_failures as f (hand_id, owner_id, reason, error, tries, failed_at)
    select d.hand_id, d.owner_id, d.reason, d.error, d.tries, now() from dead d
    on conflict (hand_id) do update
      set reason = excluded.reason, error = excluded.error, tries = excluded.tries, failed_at = excluded.failed_at
    returning 1
  )
  select count(*) into v_gone from kept;

  with input as (
    select distinct on ((e ->> 'hand_id')::uuid)
           (e ->> 'hand_id')::uuid as hand_id,
           left(coalesce(e ->> 'error', 'The hand could not be worked out.'), 500) as error,
           coalesce((e ->> 'final')::boolean, false) as final
    from jsonb_array_elements(p_hands) e
    order by (e ->> 'hand_id')::uuid
  ), back as (
    update public.derive_queue q
       set claimed_at = null, last_error = i.error
      from input i
     where q.hand_id = i.hand_id and (v_caller is null or q.owner_id = v_caller) and not i.final
     returning 1
  )
  select count(*) into v_back from back;

  return jsonb_build_object('failed', v_gone, 'retry', v_back);
end;
$$;

comment on function public.derive_fail(jsonb) is
  'P1: hands the one pass could not work out: given up (derive_failures) when final or on the third try, else '
  'back on the queue.';

-- ---------------------------------------------------------------------------
-- 7. The derive role and the grants
-- ---------------------------------------------------------------------------
--
-- `rail_derive` is what the cron route's JWT names (claim role). PostgREST's
-- `authenticator` switches to it; it holds no table privilege and may execute
-- the three worker functions only (definer functions; every other definer
-- function in `public` is revoked from PUBLIC). Its key is minted by the
-- owner at rollout (docs/POOL.md P7).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rail_derive') then
    create role rail_derive nologin noinherit;
  end if;
end;
$$;

-- PostgREST can switch to the role only when `authenticator` is a member.
-- Supabase reserves `authenticator` (supautils): only a superuser may grant
-- it, so here the grant is tried and, refused, left to the rollout (P7); the
-- worker's JWT then uses the fallback in `derive_caller`.
do $$
begin
  execute 'grant rail_derive to authenticator';
exception when others then
  raise notice 'rail_derive was not granted to authenticator (%): see docs/POOL.md P7.', sqlerrm;
end;
$$;

grant usage on schema public to rail_derive;

revoke all on function public.derive_claim(integer, jsonb) from public, anon;
revoke all on function public.derive_save(jsonb) from public, anon;
revoke all on function public.derive_fail(jsonb) from public, anon;
grant execute on function public.derive_claim(integer, jsonb) to authenticated, rail_derive;
grant execute on function public.derive_save(jsonb) to authenticated, rail_derive;
grant execute on function public.derive_fail(jsonb) to authenticated, rail_derive;

-- ---------------------------------------------------------------------------
-- 8. The account's data
-- ---------------------------------------------------------------------------

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.derive_queue', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'Hands still to be worked out (statistics, facts, EV, checker rows, pool).'),
  ('public.derive_pending_counts', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'How many of the account''s hands are still being worked out.'),
  ('public.derive_failures', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'Hands the server could not work out, with the reason.'),
  ('public.derive_options', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'Whether the account''s opponents'' statistics are derived.'),
  ('public.derive_recounts', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'An account whose hands are being queued again after a delete emptied its pool.')
on conflict (name) do nothing;

commit;
