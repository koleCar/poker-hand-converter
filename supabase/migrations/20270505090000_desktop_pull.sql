-- Rail R1.9: the desktop sync worker's pull (docs/RAIL-PLAN.md R1.9).
--
-- The desktop app keeps the account's library in its local store, so the
-- app and the web show the same hands. It uploads its own hands with
-- `ingest_hands` (R1.8) and pulls the rest: hands uploaded on the web, and
-- hands synced from the account's other computers. Which rows a device sent
-- is not recorded per hand (`hand_sources` holds counters only, R1.8), so the
-- pull reads every row of the account by keyset - **ids and keys first** (a
-- row is ~150 bytes here) - and fetches the PHF (`GET /rest/v1/hands?id=in.
-- (...)`, under RLS, unchanged) only for the keys the store does not have.
-- The hands a device uploaded itself cost it ~150 bytes each to recognise.
--
-- The cursor
-- ----------
-- `(created_at, id)`, ascending. `created_at` is set by `hands_normalize` to
-- `now()`: the inserting transaction's **start**, so a row can commit after a
-- row of a transaction that started later. A reader whose cursor moved past
-- that later row would never see the earlier one. `hands_since` therefore
-- returns only rows at least a minute old: every client write reaches
-- `hands` through PostgREST as `authenticated` (`save_hands`,
-- `ingest_hands`), whose `statement_timeout` (8 s on Supabase) ends any
-- transaction long before a minute, so a row older than a minute that is not
-- visible yet cannot exist. The cost: a hand saved on the web reaches the
-- app a minute or two later (the app pulls every few minutes anyway; R1.10's
-- Realtime is the web's live path, not this).
--
-- Security
-- --------
-- Invoker, `search_path` pinned, the caller's own rows (explicit `owner_id =
-- auth.uid()` and RLS), EXECUTE for `authenticated` only. Reads ids, times,
-- keys and origins - nothing a select under RLS could not read already. No
-- write path, no new grant on a table.

-- The keyset's index (the owner first: RLS and the function both filter on
-- it). On the production table (a few thousand rows today) a plain build
-- takes a moment; the write lock it holds is that long.
create index if not exists hands_owner_created_idx
  on public.hands (owner_id, created_at, id);

create or replace function public.hands_since(
  p_after_created timestamptz default null,
  p_after_id      uuid        default null,
  p_limit         integer     default 1000
)
returns table (id uuid, created_at timestamptz, hand_key text, origin public.hand_origin)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is null then
    raise exception 'You must be signed in to sync hands.' using errcode = '42501';
  end if;
  if (p_after_created is null) <> (p_after_id is null) then
    raise exception 'hands_since needs both halves of the cursor, or neither'
      using errcode = '22023';
  end if;

  return query
  select h.id, h.created_at, h.hand_key, h.origin
  from public.hands h
  where h.owner_id = v_owner
    and h.created_at < now() - interval '1 minute'
    and (p_after_created is null or (h.created_at, h.id) > (p_after_created, p_after_id))
  order by h.created_at, h.id
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
end;
$$;

comment on function public.hands_since(timestamptz, uuid, integer) is
  'The desktop pull (R1.9): a keyset page of the caller''s hands by (created_at, id), '
  'oldest first, ids / keys / origins only, rows at least a minute old (a later-committing '
  'row can never fall behind the cursor). At most 1000 a page; RLS-scoped.';

revoke all on function public.hands_since(timestamptz, uuid, integer) from public, anon;
grant execute on function public.hands_since(timestamptz, uuid, integer) to authenticated;
