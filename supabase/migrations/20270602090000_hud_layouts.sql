-- ===========================================================================
-- Rail R3.9: the HUD's designs and layouts follow the user to another computer
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R3.9. The desktop app keeps the HUD's designs, where each
-- is used and where the user dragged the panels in its local store
-- (`core/rail-store/SCHEMA.md`, migrations 13 and 15). Its sync worker (R1.9's)
-- sends the rows written there since the last sync and takes the account's rows
-- back; **the last writer wins by `updated_at`** - the writing computer's clock,
-- in milliseconds - so every row carries it and the server keeps the newest.
-- One table for the four kinds of row:
--
--   kind           key                   body (null: deleted / cleared)
--   layout         the design's id       the design (`rail_hud::design::HudDesign`)
--   assignment     site|size|format      {"layout": "<design id>"}
--   seat_position  site|size|slot        {"x": 0-1000, "y": 0-1000}
--   room_setting   site                  {"preferredSeat": true | false}
--
-- A deleted design, a cleared assignment or a reset panel is a row whose body
-- is null (a tombstone): a delete must reach the other computers too, and
-- would be lost as a missing row.
--
--   put_hud_layouts(p_rows)   upserts the caller's rows, each only when its
--                             `updated_at` is newer than the stored one;
--                             says which it took.
--   reads                     plain `select` under RLS (`GET /rest/v1/
--                             hud_layouts?select=kind,key,body,updated_at`).
--
-- ## The security model (as `20270317090000_learn_progress.sql`)
--
--   * **No client role holds INSERT, UPDATE or DELETE on the table.**
--     `select` to `authenticated`, scoped to the owner by RLS; nothing to
--     `anon`.
--   * **Writes go through one `security definer` function, as the caller**,
--     with an explicit `auth.uid()` check (definer functions are not protected
--     by RLS): rows are written with the caller's id only, and the conflict
--     target includes the owner, so another account's row with the same key is
--     never touched.
--   * Rate-limited per account (`enforce_rate_limit`, `hud_layouts:`).
--   * Inputs are validated whole before anything is written: the kind against
--     the four, the key against its kind's shape, the body a JSON object of at
--     most 32 KiB (a design is ~2 KiB) or null, `updated_at` a time between
--     2020 and a day from now (a computer whose clock runs far ahead could
--     otherwise pin a row forever); at most 500 rows a call and 5,000 rows an
--     account.
--   * **The content comes from the client.** The database checks the shape
--     and the bounds, not the design: the app validates a design it pulls
--     (`rail_hud::design::check`) and the HUD enforces every room's
--     restrictions on whatever it draws. A user who sends a false row only
--     changes their own HUD - no other account reads it.
--   * The function pins `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table if not exists public.hud_layouts (
  owner_id    uuid   not null references auth.users (id) on delete cascade,
  kind        text   not null check (kind in ('layout', 'assignment', 'seat_position', 'room_setting')),
  key         text   not null check (length(key) between 1 and 160),
  -- null: deleted, cleared or reset (a tombstone)
  body        jsonb  check (body is null or (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 32768)),
  -- the writing computer's clock, ms since the epoch: last writer wins
  updated_at  bigint not null check (updated_at > 0),
  -- when the server took the row (for support; not used by the sync)
  synced_at   timestamptz not null default now(),
  primary key (owner_id, kind, key)
);

comment on table public.hud_layouts is
  'The desktop HUD''s designs, assignments, dragged panel positions and per-room settings (R3.9), '
  'per (owner, kind, key); body null is a tombstone; last writer wins by updated_at (client ms). '
  'Written only by put_hud_layouts.';

-- ---------------------------------------------------------------------------
-- 2. RLS: select-own, nothing else, for anyone
-- ---------------------------------------------------------------------------

alter table public.hud_layouts enable row level security;

revoke all on public.hud_layouts from anon, authenticated;
grant select on public.hud_layouts to authenticated;

drop policy if exists hud_layouts_owner_select on public.hud_layouts;
create policy hud_layouts_owner_select on public.hud_layouts
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. put_hud_layouts -- the caller's rows, newest wins
-- ---------------------------------------------------------------------------
--
-- `p_rows`: [{ kind, key, body, updatedAt }], at most 500. Returns
-- [{ kind, key, applied }]: `applied` false when the server's row is as new
-- or newer (the client then takes the server's at its next pull).

create or replace function public.put_hud_layouts(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_count    integer;
  v_row      record;
  v_rows     integer;
  v_new      integer;
  v_max_at   bigint := ((extract(epoch from now()) + 86400) * 1000)::bigint;
  v_applied  boolean;
  v_key_ok   boolean;
  v_out      jsonb := '[]'::jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to sync HUD layouts.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'put_hud_layouts expects a JSON array.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count = 0 then
    return v_out;
  end if;
  if v_count > 500 then
    raise exception 'At most 500 rows at a time (got %).', v_count using errcode = '53400';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Each row is an object.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('hud_layouts:' || v_owner::text, 1, 600, interval '10 minutes');

  for v_row in
    select x.kind, x.key, e -> 'body' as body, x."updatedAt" as updated_at
    from jsonb_array_elements(p_rows) e,
         jsonb_to_record(e) as x(kind text, key text, "updatedAt" bigint)
  loop
    if v_row.kind is null or v_row.kind not in ('layout', 'assignment', 'seat_position', 'room_setting') then
      raise exception 'Unknown kind: %', v_row.kind using errcode = '22023';
    end if;
    -- (A CASE inside an IF condition would end the condition at its first
    -- THEN: plpgsql reads up to that word.)
    v_key_ok := v_row.key is not null and case v_row.kind
      when 'layout'        then v_row.key ~ '^[a-z0-9][a-z0-9-]{0,63}$'
      when 'assignment'    then v_row.key ~ '^([a-z0-9][a-z0-9-]{0,63}|\*)\|(0|[2-9]|10)\|(\*|cash|mtt|spin)$'
      when 'seat_position' then v_row.key ~ '^[a-z0-9][a-z0-9-]{0,63}\|([2-9]|10)\|[0-9]$'
      else                      v_row.key ~ '^[a-z0-9][a-z0-9-]{0,63}$'
    end;
    if not v_key_ok then
      raise exception 'Malformed % key: %', v_row.kind, v_row.key using errcode = '22023';
    end if;
    if v_row.body is not null and jsonb_typeof(v_row.body) = 'null' then
      v_row.body := null;
    end if;
    if v_row.body is not null
       and (jsonb_typeof(v_row.body) <> 'object' or octet_length(v_row.body::text) > 32768) then
      raise exception 'A body is a JSON object of at most 32 KiB, or null.' using errcode = '22023';
    end if;
    if v_row.updated_at is null or v_row.updated_at < 1577836800000 or v_row.updated_at > v_max_at then
      raise exception 'updatedAt is a time in ms between 2020 and a day from now.' using errcode = '22023';
    end if;
  end loop;

  -- At most 5,000 rows per account (a heavy user: tens of designs, three
  -- rooms x nine sizes x ten seats of positions).
  select count(*) into v_rows from public.hud_layouts where owner_id = v_owner;
  select count(*) into v_new
  from jsonb_to_recordset(p_rows) as x(kind text, key text)
  where not exists (
    select 1 from public.hud_layouts h
    where h.owner_id = v_owner and h.kind = x.kind and h.key = x.key);
  if v_rows + v_new > 5000 then
    raise exception 'Too many HUD layout rows.' using errcode = '53400';
  end if;

  for v_row in
    select x.kind, x.key, nullif(e -> 'body', 'null'::jsonb) as body, x."updatedAt" as updated_at
    from jsonb_array_elements(p_rows) e,
         jsonb_to_record(e) as x(kind text, key text, "updatedAt" bigint)
  loop
    insert into public.hud_layouts as h (owner_id, kind, key, body, updated_at)
    values (v_owner, v_row.kind, v_row.key, v_row.body, v_row.updated_at)
    on conflict (owner_id, kind, key) do update
      set body = excluded.body, updated_at = excluded.updated_at, synced_at = now()
      where h.owner_id = v_owner and h.updated_at < excluded.updated_at
    returning true into v_applied;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', v_row.kind, 'key', v_row.key, 'applied', coalesce(v_applied, false)));
    v_applied := null;
  end loop;

  return v_out;
end;
$$;

comment on function public.put_hud_layouts(jsonb) is
  'The desktop sync (R3.9): upserts the caller''s HUD layout rows, each only when newer (updated_at, '
  'client ms) than the stored one; returns which it took. Definer: rows are the caller''s own; validated '
  'whole; at most 500 a call and 5,000 an account; rate-limited.';

revoke all on function public.put_hud_layouts(jsonb) from public, anon;
grant execute on function public.put_hud_layouts(jsonb) to authenticated;

commit;
