-- ===========================================================================
-- Rail T3: table tiling and the RNG settings follow the user to another computer
-- ===========================================================================
--
-- `docs/research/TABLE-TILING.md` §4.5 and §5 (T3). The desktop app keeps the
-- user's table tiling settings (layouts, the one in force, per-room switches)
-- and RNG settings (range, colour bands, when it rolls) in its local store
-- (`core/rail-store/SCHEMA.md`, migration 21) and syncs them like the HUD's
-- designs: as rows of `hud_layouts` (`20270602090000_hud_layouts.sql`), last
-- writer wins by `updated_at`. Two new kinds:
--
--   kind     key        body (null: cleared)
--   tiling   default    the tiling settings (`rail_hud_ipc::settings::TilingSettings`)
--   rng      default    the RNG settings (`rail_hud_ipc::settings::RngSettings`)
--
-- The key is a short slug (`default` today), the shape a room's key has.
--
-- What changes: the `kind` check on the table, and `put_hud_layouts`'s list of
-- kinds. Everything else of the function is as it was - definer, empty
-- search_path, the caller's rows only, validation whole, 500 rows a call and
-- 5,000 an account, the rate limit - and its R6.2 entitlement gate
-- (`desktop_sync`) is put back by `entitlement_gates_apply()` below, as every
-- migration that replaces a gated function does. Tiling and the RNG are free
-- in the app; only their sync is, like all of the HUD's sync, part of
-- `desktop_sync`.
--
-- The content comes from the client, as for every kind: the database checks
-- the shape and the bounds (a JSON object of at most 32 KiB, or null), not the
-- settings; the app validates what it pulls before the HUD sees it.
-- ===========================================================================

begin;

alter table public.hud_layouts drop constraint if exists hud_layouts_kind_check;
alter table public.hud_layouts add constraint hud_layouts_kind_check
  check (kind in ('layout', 'assignment', 'seat_position', 'room_setting', 'tiling', 'rng'));

comment on table public.hud_layouts is
  'The desktop HUD''s designs, assignments, dragged panel positions and per-room settings (R3.9), '
  'and the table tiling and RNG settings (T3), per (owner, kind, key); body null is a tombstone; '
  'last writer wins by updated_at (client ms). Written only by put_hud_layouts.';

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
    if v_row.kind is null
       or v_row.kind not in ('layout', 'assignment', 'seat_position', 'room_setting', 'tiling', 'rng') then
      raise exception 'Unknown kind: %', v_row.kind using errcode = '22023';
    end if;
    -- (A CASE inside an IF condition would end the condition at its first
    -- THEN: plpgsql reads up to that word.) `room_setting`, `tiling` and
    -- `rng` keys are slugs.
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
  'The desktop sync (R3.9, T3): upserts the caller''s HUD layout, tiling and RNG rows, each only when '
  'newer (updated_at, client ms) than the stored one; returns which it took. Definer: rows are the '
  'caller''s own; validated whole; at most 500 a call and 5,000 an account; rate-limited.';

revoke all on function public.put_hud_layouts(jsonb) from public, anon;
grant execute on function public.put_hud_layouts(jsonb) to authenticated;

-- R6.2: the replaced body has no gate; put it back (idempotent).
select public.entitlement_gates_apply();

commit;
