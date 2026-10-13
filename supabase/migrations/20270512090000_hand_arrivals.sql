-- Rail R1.10: live arrival on the web (docs/RAIL-PLAN.md R1.10).
--
-- The web's `/library` and `/stats` refresh on their own when hands land in
-- the account - from the desktop app (`ingest_hands`, up to 500 a call) or
-- from another browser tab (`save_hands`). This migration is the signal
-- they listen to.
--
-- Why a signal table, not `hands` in the publication
-- ---------------------------------------------------
-- The obvious design is Postgres Changes on `hands` itself, filtered to
-- `owner_id`. It is the wrong one here:
--   * **Payload.** Realtime decodes every published row with wal2json and
--     sends the whole record: the PHF (~2.9 KB, up to 256 KiB) and, for web
--     rows, the standard and source text. A 500-hand batch would push ~2 MB
--     to every open tab of the account, to say "refresh". A column list on
--     the publication (`add table hands (id, owner_id)`) does not help:
--     Realtime reads the slot through wal2json with `add-tables`, which
--     ignores column lists.
--   * **Cost.** Every insert into `hands` - a 500 000-hand desktop backfill,
--     a 5 000-hand web upload - would be decoded, JSON-encoded and checked
--     against RLS once per subscriber per row (the scaling cliff the forum
--     already avoids, 20261026090000 section 7).
--   * **Blast radius.** With `hands` out of the publication, no setting,
--     filter or Realtime bug can ever put a hand's content on a socket.
--
-- So: `hand_arrivals`, **one row per account**, bumped once per insert
-- *statement* by a statement-level trigger on `hands` - one `ingest_hands`
-- call or one `save_hands` call is one change, whatever its size. The row
-- carries a counter, how many hands the statement added, their origin and
-- the time; ~150 bytes on the wire. The web listens to its own row with
-- Postgres Changes (INSERT for the first arrival, UPDATE after that),
-- exactly as the unread badge listens to `notifications`.
--
-- Privacy (the threat model of docs/DATABASE.md "Notifications and
-- realtime")
-- ------------------------------------------------------------------------
-- Realtime applies RLS to INSERT and UPDATE changes: it re-reads each
-- change as the subscriber (their JWT) and drops what the subscriber's
-- SELECT policy does not allow. The only policy here is select-own, so a
-- subscription to another account's id - or one with no filter at all -
-- receives nothing but the subscriber's own row; `anon` has no policy and
-- receives nothing (see the grant below for why it has SELECT). Checked
-- against a local stack in R1.10 (docs/RAIL-PLAN.md, R1.10 *As built*).
-- DELETE changes are the exception: Realtime cannot check RLS on a row that
-- is gone and sends the old record's primary key to every subscriber of the
-- table that listens for deletes. That is why the primary key is a random
-- uuid and not `owner_id`: the only delete is an account's removal
-- (cascade), and what it reveals is a meaningless id.
-- No client can write the table; the trigger is the only writer.
-- What a subscriber can learn is its own row: when its own library grew, by
-- how much, from where. Nothing about a hand, nothing about anyone else.
--
-- The trigger must never cost a save: it is one upsert of one row per
-- account per statement, and a failure is swallowed (a missed signal is
-- covered by the page's re-read on focus and on reconnect).

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table public.hand_arrivals (
  -- Random, deliberately not the owner: DELETE changes carry the primary key
  -- to every subscriber (header).
  id          uuid primary key default extensions.gen_random_uuid(),
  owner_id    uuid not null unique references auth.users (id) on delete cascade,
  -- Bumped once per insert statement that added hands for this account.
  seq         bigint not null default 1,
  -- How many hands that statement added, and from where.
  hands       integer not null,
  origin      public.hand_origin not null,
  arrived_at  timestamptz not null default now(),

  constraint hand_arrivals_seq_ok check (seq >= 1),
  constraint hand_arrivals_hands_ok check (hands >= 1)
);

comment on table public.hand_arrivals is
  'Rail R1.10: one row per account, bumped once per insert statement on hands. The web listens to its own row through Realtime (Postgres Changes, select-own RLS) and refreshes /library and /stats. Carries no hand content.';

alter table public.hand_arrivals enable row level security;
revoke all on public.hand_arrivals from public, anon, authenticated;
grant select on public.hand_arrivals to authenticated;
-- `anon` gets SELECT too, and no policy - so it reads zero rows. That is for
-- Realtime: a subscriber whose role cannot select the table's columns is not
-- run through RLS at all but sent a content-free "Error 401: Unauthorized"
-- notice for **every** change of the table, which tells an anonymous socket
-- when any account stores hands. With the grant, Realtime evaluates RLS for
-- anon like for anyone else, and anon has no policy: nothing is sent.
-- (Measured on a local stack in R1.10; `notifications` still has the old
-- behaviour, noted in docs/DATABASE.md.)
grant select on public.hand_arrivals to anon;

drop policy if exists hand_arrivals_own_select on public.hand_arrivals;
create policy hand_arrivals_own_select on public.hand_arrivals
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. The trigger
-- ---------------------------------------------------------------------------

create or replace function public.hands_signal_arrival()
returns trigger
language plpgsql
-- security definer: `hand_arrivals` has no client write grant, and the
-- direct-insert path (`save_hands`) runs as the caller. Reads nothing but
-- the transition table; writes one row per account in it.
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.hand_arrivals as a (owner_id, hands, origin)
    select i.owner_id,
           count(*)::integer,
           -- One statement writes one origin in practice; desktop wins a mix.
           case when bool_or(i.origin = 'desktop') then 'desktop' else 'web' end::public.hand_origin
      from inserted i
     where i.owner_id is not null
     group by i.owner_id
    on conflict (owner_id) do update
       set seq        = a.seq + 1,
           hands      = excluded.hands,
           origin     = excluded.origin,
           arrived_at = now();
  exception when others then
    -- A live signal must never fail somebody's save.
    null;
  end;
  return null;
end;
$$;

revoke all on function public.hands_signal_arrival() from public;
revoke execute on function public.hands_signal_arrival() from anon, authenticated;

-- After `hands_rate_limit_after_insert` (statement triggers fire in name
-- order), so a statement the budget refuses never signals. A statement that
-- added nothing (all duplicates) has an empty transition table and signals
-- nothing.
drop trigger if exists hands_signal_arrival on public.hands;
create trigger hands_signal_arrival
  after insert on public.hands
  referencing new table as inserted
  for each statement execute function public.hands_signal_arrival();

-- ---------------------------------------------------------------------------
-- 3. Realtime
-- ---------------------------------------------------------------------------
--
-- Same guard as `notifications` (20261026090000): a database without the
-- publication (plain Postgres, CI's pgTAP run before Realtime exists) still
-- migrates. `hands` stays out of the publication (header).

do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hand_arrivals'
     ) then
    alter publication supabase_realtime add table public.hand_arrivals;
  end if;
end;
$pub$;
