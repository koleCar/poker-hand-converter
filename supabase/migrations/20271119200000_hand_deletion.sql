-- ===========================================================================
-- Hand deletion (owner's request, 2026-11-19): a user deletes one hand, a
-- selection, or every hand of their library, from the web and the app.
-- ===========================================================================
--
-- Until now nothing deleted a hand while its account stayed (the baseline's
-- `hands` has no DELETE policy, and only `erase_account_hands` removes
-- hands). Here:
--
--   delete_hands(p_ids uuid[])           -> {deleted}
--   delete_hands_by_key(p_keys text[])   -> {deleted, keys}
--       The caller's hands among these (at most 200 a call), with every
--       summary kept exact by the existing statement triggers. The rows
--       below a hand go first, in the order the triggers need: the analysis
--       (its triggers read their own rows, the hand may be gone), the EV and
--       the statistics rows (their library-count triggers join the hand, so
--       it must still be there - deleting the hand first cascades to them
--       after the hand is gone and marks the account `library_counts_stale`),
--       then the hand itself (`library_hand_counts`; hand facts, drill cards,
--       study tasks, share links and analysis shares cascade).
--
--   delete_all_hands(p_confirm text)     -> {deleted, remaining, done, before}
--       Every hand stored at or before `before` (the instant the first call
--       of this wipe started; later arrivals are kept). The client calls it
--       until `done`; each call works ~4 s (PostgREST's statement timeout is
--       8 s). Hand by hand through the triggers is ~1.4 s per 500 hands - 25
--       minutes for 500 000 - so a wipe skips the summary triggers like an
--       account deletion does (`rail.erasing_account`, ~0.05 s per 500) and
--       keeps the summaries exact another way:
--         * library counts: the account is marked `library_counts_stale` when
--           the wipe starts, so its readers (and the stored-hands count of the
--           plan) count the hands themselves until the wipe ends;
--         * the per-hand summary rows without a foreign key (hero_report_rows,
--           analysis_hand_rows, analysis_leak_rows, preflop_decision_rows) go
--           with each batch, by hand id;
--         * the aggregates (hero_rollups, player_stats, library counts, the
--           analysis totals, preflop totals) are emptied when the last hand
--           goes - or, when hands arrived during the wipe, rebuilt from what
--           is left (the four `*_rebuild` functions) by the cron job: the
--           analysis rebuild alone takes ~6 s for 5 000 hands, too long for
--           a client's call.
--       Until then the reports and the analysis still count the hands being
--       deleted (a minute or two for 500 000 hands). A wipe the page left is
--       finished by pg_cron (`finish_hand_wipes`, every minute).
--
--   hand_tombstones_since(p_after_at, p_after_seq, p_limit)
--       For the desktop app's pull: a row per deleted hand (its key and id),
--       and one row per wipe (hand_key null, all_before set: every hand stored
--       on the server at or before it is gone). Keyset by (deleted_at, seq),
--       rows older than a minute only, as `hands_since` does. Kept 180 days.
--
-- Not changed by a deletion: the plan's per-day upload counter (deleting a
-- hand frees library space, not today's uploads), `hand_sources` (ingest
-- counters of a folder: received / inserted, a log) and `hand_arrivals`.
--
-- Forum and links: a published hand (`published_hands`) is a scrubbed copy
-- that others replied to; it stays as it is (`published_hand_sources.hand_id`
-- is set null, as before). A share link of a stored hand reads that hand, so
-- it stops working with it (`shares` cascades), like on an account deletion.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tombstones and wipes
-- ---------------------------------------------------------------------------

create table if not exists public.hand_tombstones (
  owner_id    uuid not null references auth.users (id) on delete cascade,
  seq         bigint generated always as identity,
  deleted_at  timestamptz not null default now(),
  -- One deleted hand: its key (the app's dedupe key) and server id.
  hand_key    text,
  hand_id     uuid,
  -- A wipe: every hand stored at or before this instant.
  all_before  timestamptz,
  primary key (owner_id, seq),
  constraint hand_tombstones_kind check ((hand_key is null) = (all_before is not null))
);

create index if not exists hand_tombstones_cursor_idx
  on public.hand_tombstones (owner_id, deleted_at, seq);
create index if not exists hand_tombstones_age_idx
  on public.hand_tombstones (deleted_at);

comment on table public.hand_tombstones is
  'Hands the account deleted (key and id), and wipes (all_before), for the desktop app''s pull (hand_tombstones_since). Kept 180 days.';

alter table public.hand_tombstones enable row level security;
revoke all on public.hand_tombstones from anon, authenticated;

create table if not exists public.hand_wipes (
  owner_id    uuid primary key references auth.users (id) on delete cascade,
  before      timestamptz not null,
  started_at  timestamptz not null default now(),
  -- Set when the last hand went while others (stored after `before`) stay:
  -- the cron job rebuilds the summaries from them.
  rebuild     boolean not null default false
);

comment on table public.hand_wipes is
  'A "delete all hands" in progress: every hand stored at or before `before` goes (delete_all_hands, finish_hand_wipes).';

alter table public.hand_wipes enable row level security;
revoke all on public.hand_wipes from anon, authenticated;

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.hand_tombstones', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'The keys and ids of hands the account deleted, and when it deleted all of them, so its desktop app deletes them too. Kept 180 days.'),
  ('public.hand_wipes', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'A "delete all hands" in progress: its start. Gone when it ends.')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Deleting chosen hands
-- ---------------------------------------------------------------------------

-- The owner's hands among p_ids, deleted with their summaries exact. Internal.
create or replace function public.hand_delete_owned(p_owner uuid, p_ids uuid[])
returns table (id uuid, hand_key text)
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(s.id), '{}') into v_ids
  from (
    select h.id from public.hands h
     where h.owner_id = p_owner and h.id = any(p_ids)
     order by h.id
     for update
  ) s;
  if cardinality(v_ids) = 0 then
    return;
  end if;

  -- The analysis first: its triggers keep the analysis summaries from their
  -- own rows (decision_analysis cascades from hand_analysis).
  delete from public.hand_analysis a where a.hand_id = any(v_ids);
  -- EV rows before the statistics rows (the EV trigger joins the hero row),
  -- both before the hand (their library-count triggers join it).
  delete from public.hand_stats_ev e where e.hand_id = any(v_ids);
  delete from public.hand_stats s where s.hand_id = any(v_ids);

  insert into public.hand_tombstones (owner_id, hand_key, hand_id)
  select h.owner_id, h.hand_key, h.id from public.hands h where h.id = any(v_ids);

  return query
  delete from public.hands h where h.id = any(v_ids) and h.owner_id = p_owner
  returning h.id, h.hand_key;
end;
$$;

revoke all on function public.hand_delete_owned(uuid, uuid[]) from public;
revoke execute on function public.hand_delete_owned(uuid, uuid[]) from anon, authenticated;

create or replace function public.delete_hands(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete hands.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'At most 200 hands at a time.' using errcode = '22023';
  end if;
  select count(*)::integer into v_n from public.hand_delete_owned(v_uid, coalesce(p_ids, '{}'));
  return jsonb_build_object('deleted', v_n);
end;
$$;

revoke all on function public.delete_hands(uuid[]) from public;
revoke execute on function public.delete_hands(uuid[]) from anon;
grant execute on function public.delete_hands(uuid[]) to authenticated;

create or replace function public.delete_hands_by_key(p_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_ids  uuid[];
  v_keys text[];
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete hands.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_keys), 0) > 200 then
    raise exception 'At most 200 hands at a time.' using errcode = '22023';
  end if;
  select coalesce(array_agg(h.id), '{}') into v_ids
  from public.hands h
  where h.owner_id = v_uid and h.hand_key = any(coalesce(p_keys, '{}'));
  select coalesce(array_agg(d.hand_key order by d.hand_key), '{}') into v_keys
  from public.hand_delete_owned(v_uid, v_ids) d;
  return jsonb_build_object('deleted', cardinality(v_keys), 'keys', to_jsonb(v_keys));
end;
$$;

revoke all on function public.delete_hands_by_key(text[]) from public;
revoke execute on function public.delete_hands_by_key(text[]) from anon;
grant execute on function public.delete_hands_by_key(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Deleting every hand
-- ---------------------------------------------------------------------------

-- The aggregates of an account whose wipe ended: emptied when it has no hand
-- left, else rebuilt from the hands it kept. Internal.
create or replace function public.hand_wipe_finish(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.hands h where h.owner_id = p_owner) then
    perform public.library_counts_rebuild(p_owner);
    perform public.report_summaries_rebuild(p_owner);
    perform public.analysis_leak_summaries_rebuild(p_owner);
    perform public.preflop_decision_rows_rebuild(p_owner);
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || p_owner::text, 0));
  delete from public.library_hand_counts where owner_id = p_owner;
  delete from public.library_hero_counts where owner_id = p_owner;
  delete from public.library_counts_stale where owner_id = p_owner;
  delete from public.hero_rollups where owner_id = p_owner;
  delete from public.hero_report_rows where owner_id = p_owner;
  delete from public.player_stats where owner_id = p_owner;
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || p_owner::text, 0));
  delete from public.analysis_hand_rows where owner_id = p_owner;
  delete from public.analysis_month_hands where owner_id = p_owner;
  delete from public.analysis_leak_rows where owner_id = p_owner;
  delete from public.analysis_leak_totals where owner_id = p_owner;
  delete from public.analysis_leak_stake_totals where owner_id = p_owner;
  delete from public.analysis_trend_days where owner_id = p_owner;
  delete from public.analysis_overview_hands where owner_id = p_owner;
  delete from public.analysis_overview_decisions where owner_id = p_owner;
  delete from public.analysis_overview_flags where owner_id = p_owner;
  delete from public.analysis_overview_keys where owner_id = p_owner;
  delete from public.analysis_node_totals where owner_id = p_owner;
  delete from public.analysis_graded_sites where owner_id = p_owner;
  perform pg_advisory_xact_lock(hashtextextended('preflop_decisions:' || p_owner::text, 0));
  delete from public.preflop_decision_rows where owner_id = p_owner;
  delete from public.preflop_decision_totals where owner_id = p_owner;
end;
$$;

revoke all on function public.hand_wipe_finish(uuid) from public;
revoke execute on function public.hand_wipe_finish(uuid) from anon, authenticated;

-- One step of an account's wipe, working until p_until. Internal: called by
-- `delete_all_hands` and `finish_hand_wipes`.
create or replace function public.hand_wipe_continue(p_owner uuid, p_until timestamptz, p_rebuild boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_wipe  public.hand_wipes;
  v_ids   uuid[];
  v_total integer := 0;
  v_left  bigint;
begin
  -- One step per account at a time (a second tab, the cron job).
  perform pg_advisory_xact_lock(hashtextextended('hand_wipe:' || p_owner::text, 0));
  select * into v_wipe from public.hand_wipes w where w.owner_id = p_owner;
  if not found then
    return jsonb_build_object('deleted', 0, 'remaining', 0, 'done', true, 'before', null);
  end if;

  if not v_wipe.rebuild then
    -- The summary triggers skip these deletes (20271006100000, section 6).
    perform set_config('rail.erasing_account', p_owner::text, true);
    loop
      with batch as (
        select h.id from public.hands h
         where h.owner_id = p_owner and h.created_at <= v_wipe.before
         order by h.created_at, h.id
         limit 500
         for update skip locked
      ), gone as (
        delete from public.hands d using batch where d.id = batch.id and d.owner_id = p_owner
        returning d.id
      )
      select coalesce(array_agg(gone.id), '{}') into v_ids from gone;
      exit when cardinality(v_ids) = 0;
      v_total := v_total + cardinality(v_ids);
      -- The per-hand summary rows without a foreign key to their hand.
      delete from public.hero_report_rows r where r.hand_id = any(v_ids);
      delete from public.analysis_hand_rows r where r.hand_id = any(v_ids);
      delete from public.analysis_leak_rows r where r.hand_id = any(v_ids);
      delete from public.preflop_decision_rows r where r.hand_id = any(v_ids);
      exit when clock_timestamp() >= p_until;
    end loop;
    perform set_config('rail.erasing_account', '', true);
  end if;

  select count(*) into v_left
  from public.hands h
  where h.owner_id = p_owner and h.created_at <= v_wipe.before;

  if v_left = 0 then
    if not exists (select 1 from public.hands h where h.owner_id = p_owner) then
      -- Nothing left: the aggregates are emptied (cheap), in this call when
      -- it has the time, else in the next.
      if clock_timestamp() < p_until then
        perform public.hand_wipe_finish(p_owner);
        delete from public.hand_wipes w where w.owner_id = p_owner;
        return jsonb_build_object('deleted', v_total, 'remaining', 0, 'done', true, 'before', v_wipe.before);
      end if;
    elsif p_rebuild then
      perform public.hand_wipe_finish(p_owner);
      delete from public.hand_wipes w where w.owner_id = p_owner;
      return jsonb_build_object('deleted', v_total, 'remaining', 0, 'done', true, 'before', v_wipe.before);
    else
      -- Hands arrived during the wipe: the aggregates are rebuilt from them
      -- by the cron job (a rebuild can outlast a client's statement timeout).
      -- The client's part is done; the library counts stay stale (read from
      -- the hands) until then.
      update public.hand_wipes w set rebuild = true where w.owner_id = p_owner;
      return jsonb_build_object('deleted', v_total, 'remaining', 0, 'done', true, 'before', v_wipe.before);
    end if;
  end if;
  return jsonb_build_object('deleted', v_total, 'remaining', v_left, 'done', false, 'before', v_wipe.before);
end;
$$;

revoke all on function public.hand_wipe_continue(uuid, timestamptz, boolean) from public;
revoke execute on function public.hand_wipe_continue(uuid, timestamptz, boolean) from anon, authenticated;

create or replace function public.delete_all_hands(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_until timestamptz := clock_timestamp() + interval '4 seconds';
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete hands.' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'DELETE' then
    raise exception 'Confirm with DELETE to delete every hand.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hand_wipe:' || v_uid::text, 0));
  -- A wipe whose hands are gone and whose summaries wait for the cron
  -- job's rebuild starts again: the hands stored since go too.
  delete from public.hand_wipes w where w.owner_id = v_uid and w.rebuild;
  if not exists (select 1 from public.hand_wipes w where w.owner_id = v_uid) then
    insert into public.hand_wipes (owner_id, before) values (v_uid, now());
    insert into public.hand_tombstones (owner_id, all_before) values (v_uid, now());
    -- The library's readers count the hands themselves until the wipe ends.
    insert into public.library_counts_stale (owner_id) values (v_uid) on conflict (owner_id) do nothing;
  end if;
  return public.hand_wipe_continue(v_uid, v_until, false);
end;
$$;

revoke all on function public.delete_all_hands(text) from public;
revoke execute on function public.delete_all_hands(text) from anon;
grant execute on function public.delete_all_hands(text) to authenticated;

-- pg_cron's job: the wipes a page or the app left, ~50 s of steps, a commit
-- after each; and tombstones older than 180 days. A procedure (neither
-- definer nor with a `set` clause: either forbids a commit inside).
create or replace procedure public.finish_hand_wipes(p_seconds integer default 50)
language plpgsql
as $$
declare
  v_until timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_seconds, 50), 1), 300));
  v_owner uuid;
  v_step  jsonb;
begin
  delete from public.hand_tombstones where deleted_at < now() - interval '180 days';
  commit;
  for v_owner in
    select w.owner_id from public.hand_wipes w
     where w.started_at < now() - interval '1 minute'
     order by w.started_at
  loop
    loop
      exit when clock_timestamp() > v_until;
      v_step := public.hand_wipe_continue(v_owner, least(v_until, clock_timestamp() + interval '5 seconds'), true);
      commit;
      exit when (v_step ->> 'done')::boolean;
    end loop;
    exit when clock_timestamp() > v_until;
  end loop;
end;
$$;

revoke all on procedure public.finish_hand_wipes(integer) from public;
revoke execute on procedure public.finish_hand_wipes(integer) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The app's pull
-- ---------------------------------------------------------------------------

create or replace function public.hand_tombstones_since(
  p_after_at  timestamptz default null,
  p_after_seq bigint default null,
  p_limit     integer default 1000)
returns table (seq bigint, deleted_at timestamptz, hand_key text, hand_id uuid, all_before timestamptz)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is null then
    raise exception 'You must be signed in to sync hands.' using errcode = '42501';
  end if;
  if (p_after_at is null) <> (p_after_seq is null) then
    raise exception 'hand_tombstones_since needs both halves of the cursor, or neither'
      using errcode = '22023';
  end if;
  return query
  select t.seq, t.deleted_at, t.hand_key, t.hand_id, t.all_before
  from public.hand_tombstones t
  where t.owner_id = v_owner
    and t.deleted_at < now() - interval '1 minute'
    and (p_after_at is null or (t.deleted_at, t.seq) > (p_after_at, p_after_seq))
  order by t.deleted_at, t.seq
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
end;
$$;

revoke all on function public.hand_tombstones_since(timestamptz, bigint, integer) from public;
revoke execute on function public.hand_tombstones_since(timestamptz, bigint, integer) from anon;
grant execute on function public.hand_tombstones_since(timestamptz, bigint, integer) to authenticated;

do $cron$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); schedule finish_hand_wipes by hand', sqlerrm;
    return;
  end;
  perform cron.unschedule(jobid) from cron.job where jobname = 'hand-wipes-finish';
  perform cron.schedule('hand-wipes-finish', '* * * * *', 'call public.finish_hand_wipes(50);');
end;
$cron$;

commit;
