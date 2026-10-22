-- Rail R4.2: bulk upload (docs/RAIL-PLAN.md R4.2, amendments A2 and A5),
-- part 2 of 2.
--
-- The web's converter saves a drop of any size while it converts it:
-- chunked calls, retried, resumable (frontend/src/components/converter/
-- bulkSaver.ts). This migration gives it the server side.
--
-- Hands: `ingest_hands` from the account's web source
-- -----------------------------------------------------
-- R1.8 created `hand_sources.kind = 'web'` (one per account) for this step.
-- `register_web_hand_source()` returns it, creating it on first use, and
-- `ingest_hands` now accepts it besides the app's folders. Why the bulk save
-- does not use `save_hands`:
--   * `save_hands` spends the web's *global* budget (`hands_insert`, 25 000
--     rows per 10 minutes for everyone together). A 1 000 000-hand upload
--     would take seven hours and lock every other user out meanwhile;
--     `ingest_hands` spends the account's own (150 000 / 10 min, 2 000 000 /
--     day - the same two buckets as the account's desktop sync: one budget
--     per account, whichever client sends).
--   * A `save_hands` row carries the original text twice (`source_text` and
--     the PHF's `meta.rawText`) plus the standard text, ~7.3 KB a hand. An
--     ingested row is the PHF alone (~2.9 KB), its columns derived here from
--     the PHF (A5, Q4). From the web the original text leaves the tab only
--     when the user opts in to keeping the files (A2; the bucket below).
--   * The same hand from the app and from the web is then the same row
--     (R4.4's parity).
-- Rows from the web source carry `origin = 'upload'` (previous migration):
-- the desktop row's shape (no standard text, no source text, an empty
-- `meta.rawText`), written from the browser. The CHECK constraints that held
-- that shape for `desktop` rows now hold it for both. The direct path is
-- unchanged: the insert policy still admits `origin = 'web'` only, so
-- neither shape can be written through PostgREST or `save_hands`; a single
-- hand saved from the paste box or the replayer is still a `save_hands` web
-- row. `hand_arrivals` reports an upload as `web` (its trigger says
-- `desktop` only for desktop rows), which is what the page should say.
--
-- Originals: the private bucket `hand-uploads` (A2's opt-in)
-- -----------------------------------------------------------
-- When the user ticks "Keep the original files", each file that decoded goes
-- to Storage gzip-compressed, at `<uid>/<upload id>/<path>.<hash>.gz`.
-- Private (no public URL); 50 MiB an object (the hosted project's own upload
-- limit on the current plan, and ~500 MB of hand history compressed); gzip
-- only. Policies on `storage.objects` let an authenticated user list, read,
-- insert and delete objects of this bucket **only under their own uid** -
-- the first path segment, compared with `auth.uid()`. No UPDATE: an original
-- is never rewritten (the client uploads with `upsert: false`; a resumed
-- upload's "already exists" is success). `anon` gets nothing.
-- Storage objects do not cascade from `auth.users`: whoever builds account
-- deletion removes `hand-uploads/<uid>/` with it.

-- ---------------------------------------------------------------------------
-- 1. hands: the PHF-only shape for desktop and upload rows
-- ---------------------------------------------------------------------------

alter table public.hands drop constraint hands_text_by_origin;
alter table public.hands
  add constraint hands_text_by_origin check (
    (origin = 'web' and standard_text is not null)
    or (origin in ('desktop', 'upload')
        and standard_text is null
        and source_text is null
        and coalesce(phf -> 'meta' ->> 'rawText', '') = '')
  );

alter table public.hands drop constraint hands_desktop_phf_size;
alter table public.hands
  add constraint hands_desktop_phf_size check (
    origin = 'web' or octet_length(phf::text) <= 262144
  );

comment on column public.hands.origin is
  'Which client wrote the row: web (save_hands), desktop (ingest_hands from an app folder, R1.8) or upload (ingest_hands from the account''s web source: the converter''s bulk save, R4.2). Desktop and upload rows have no standard_text or source_text and an empty meta.rawText (Q4, A2).';

-- ---------------------------------------------------------------------------
-- 2. register_web_hand_source
-- ---------------------------------------------------------------------------

create or replace function public.register_web_hand_source()
returns uuid
language plpgsql
-- security definer: `hand_sources` has no client INSERT grant. The owner is
-- auth.uid(); the row is the owner's one web source (unique index
-- `hand_sources_web_uidx`), so a repeat returns the same id.
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_id    uuid;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save hands.'
      using errcode = '42501';
  end if;

  select s.id into v_id
    from public.hand_sources s
   where s.owner_id = v_owner and s.kind = 'web';
  if v_id is not null then
    return v_id;
  end if;

  perform public.enforce_rate_limit('hand_source:' || v_owner::text, 1, 120, interval '10 minutes');

  insert into public.hand_sources as s (owner_id, kind, label)
  values (v_owner, 'web', 'Web uploads')
  on conflict (owner_id) where kind = 'web'
  do update set updated_at = s.updated_at
  returning s.id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_web_hand_source() from public, anon, authenticated;
grant execute on function public.register_web_hand_source() to authenticated;

comment on function public.register_web_hand_source() is
  'The caller''s web hand source (R4.2): the hand_sources row the converter''s bulk save sends ingest_hands from; created on first use (one per account), the same id after that.';

-- ---------------------------------------------------------------------------
-- 3. ingest_hands: folders and the web source
-- ---------------------------------------------------------------------------

create or replace function public.ingest_hands(p_source uuid, p_rows jsonb)
returns jsonb
language plpgsql
-- security definer: desktop and upload rows may only be written here (the
-- insert policy refuses them on the direct path), and the source counters
-- have no client UPDATE grant. Inside: the owner is auth.uid(), written explicitly
-- (and again by the normalizing trigger); the source must be the caller's;
-- every column but hand_key and phf is derived here from the PHF; the
-- per-account budget is spent before anything is written.
security definer
set search_path = ''
as $$
declare
  v_owner     uuid := (select auth.uid());
  v_received  integer;
  v_elem      jsonb;
  v_phf       jsonb;
  v_key       text;
  v_reason    text;
  v_field     text;
  v_row       public.hands;
  v_rows      public.hands[] := '{}';
  v_seen      text[] := '{}';
  v_keys      text[] := '{}';
  v_statuses  text[] := '{}';
  v_reasons   text[] := '{}';
  v_fields    text[] := '{}';
  v_inserted  text[];
  v_out       jsonb := '[]'::jsonb;
  v_n_ins     integer := 0;
  v_n_dup     integer := 0;
  v_n_rej     integer := 0;
  v_last_rej  text;
  v_status    text;
  v_kind      public.hand_source_kind;
  v_origin    public.hand_origin;
begin
  if v_owner is null then
    raise exception 'You must be signed in to sync hands.'
      using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'ingest_hands expects a JSON array of {hand_key, phf}'
      using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 500 then
    raise exception 'ingest_hands accepts at most 500 hands per call (got %)', v_received
      using errcode = '22023';
  end if;
  if octet_length(p_rows::text) > 8388608 then
    raise exception 'ingest_hands accepts at most 8 MiB per call'
      using errcode = '22023';
  end if;

  -- The same answer for "no such source" and "not yours". A folder's rows
  -- are the app's (`desktop`); the web source's are a bulk upload's
  -- (`upload`, R4.2) - the same PHF-only shape, written from the browser.
  select s.kind into v_kind
    from public.hand_sources s
   where s.id = p_source and s.owner_id = v_owner;
  if v_kind is null then
    raise exception 'No hand source with id %', p_source using errcode = '23503';
  end if;
  v_origin := case v_kind when 'web' then 'upload' else 'desktop' end;

  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0,
                              'rejected', 0, 'rows', '[]'::jsonb);
  end if;

  perform public.enforce_rate_limit('desktop_ingest:' || v_owner::text,
                                    v_received, 150000, interval '10 minutes');
  perform public.enforce_rate_limit('desktop_ingest_day:' || v_owner::text,
                                    v_received, 2000000, interval '1 day');

  for v_i in 0 .. v_received - 1 loop
    v_elem   := p_rows -> v_i;
    v_phf    := v_elem -> 'phf';
    v_key    := case when jsonb_typeof(v_elem -> 'hand_key') = 'string'
                     then v_elem ->> 'hand_key' end;
    v_reason := null;
    v_field  := null;

    if jsonb_typeof(v_elem) is distinct from 'object'
       or jsonb_typeof(v_phf) is distinct from 'object' then
      v_reason := 'shape';
    elsif v_phf ->> 'schema' is distinct from 'phf/1' then
      v_reason := 'schema';
    elsif octet_length(v_phf::text) > 262144 then
      v_reason := 'too-large';
    elsif coalesce(v_phf -> 'meta' ->> 'rawText', '') <> '' then
      -- Q4: the original text stays on the user's disk; from the web it
      -- goes to Storage, and only when the user opts in (A2, R4.2).
      v_reason := 'raw-text';
    else
      begin
        v_row := public.hand_row_from_phf(v_phf);
      exception when others then
        v_reason := 'shape';
      end;
      if v_reason is null then
        if v_key is null or v_key <> v_row.hand_key then
          v_reason := 'hand-key';
        else
          v_field := public.hand_row_problem(v_row);
          if v_field = 'hand_key' then
            v_reason := 'hand-key';
            v_field := null;
          elsif v_field is not null then
            v_reason := 'invalid';
          end if;
        end if;
      end if;
    end if;

    if v_reason is not null then
      v_status := 'rejected';
    elsif v_row.hand_key = any (v_seen) then
      v_status := 'duplicate';
    else
      v_status := 'pending';
      v_seen := v_seen || v_row.hand_key;
      v_rows := v_rows || v_row;
    end if;

    v_keys     := v_keys || v_key;
    v_statuses := v_statuses || v_status;
    v_reasons  := v_reasons || v_reason;
    v_fields   := v_fields || v_field;
  end loop;

  with ins as (
    insert into public.hands (
      owner_id, origin,
      hand_key, phf, standard_text, source_text, schema_version, parser_version,
      site, site_hand_id, variant, limit_type, game_format, tournament_id,
      currency, currency_minor_units, currency_symbol,
      small_blind, big_blind, ante, stakes_label,
      table_name, max_seats, played_at,
      hero_name, hero_seat, hero_position, hero_cards, hero_hand_class,
      board_cards, player_names, player_count,
      street_reached, went_to_showdown, total_pot, rake, hero_profit, winners,
      source_filename,
      site_anonymization, player_positions, showdown_positions, winner_positions
    )
    select
      v_owner, v_origin,
      d.hand_key, d.phf, null, null, d.schema_version, d.parser_version,
      d.site, d.site_hand_id, d.variant, d.limit_type, d.game_format, d.tournament_id,
      d.currency, d.currency_minor_units, d.currency_symbol,
      d.small_blind, d.big_blind, d.ante, d.stakes_label,
      d.table_name, d.max_seats, d.played_at,
      d.hero_name, d.hero_seat, d.hero_position, d.hero_cards, d.hero_hand_class,
      d.board_cards, d.player_names, d.player_count,
      d.street_reached, d.went_to_showdown, d.total_pot, d.rake, d.hero_profit, d.winners,
      d.source_filename,
      d.site_anonymization, d.player_positions, d.showdown_positions, d.winner_positions
    from unnest(v_rows) as d
    on conflict (owner_id, hand_key) do nothing
    returning hand_key
  )
  select coalesce(array_agg(hand_key), '{}') into v_inserted from ins;

  for v_i in 1 .. v_received loop
    v_status := v_statuses[v_i];
    if v_status = 'pending' then
      v_status := case when v_keys[v_i] = any (v_inserted) then 'inserted' else 'duplicate' end;
    end if;
    if v_status = 'inserted' then
      v_n_ins := v_n_ins + 1;
    elsif v_status = 'duplicate' then
      v_n_dup := v_n_dup + 1;
    else
      v_n_rej := v_n_rej + 1;
      v_last_rej := v_reasons[v_i];
    end if;
    v_out := v_out || jsonb_strip_nulls(jsonb_build_object(
      'handKey', v_keys[v_i],
      'status',  v_status,
      'reason',  v_reasons[v_i],
      'field',   v_fields[v_i]));
  end loop;

  update public.hand_sources s
     set hands_received  = s.hands_received + v_received,
         hands_inserted  = s.hands_inserted + v_n_ins,
         hands_duplicate = s.hands_duplicate + v_n_dup,
         hands_rejected  = s.hands_rejected + v_n_rej,
         last_rejection  = coalesce(v_last_rej, s.last_rejection),
         last_ingest_at  = now(),
         updated_at      = now()
   where s.id = p_source and s.owner_id = v_owner;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   v_n_ins,
    'duplicates', v_n_dup,
    'rejected',   v_n_rej,
    'rows',       v_out
  );
end;
$$;

revoke all on function public.ingest_hands(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_hands(uuid, jsonb) to authenticated;

comment on function public.ingest_hands(uuid, jsonb) is
  'Desktop sync (R1.8) and the web''s bulk upload (R4.2, from the account''s web source; rows origin = upload): inserts up to 500 hands ({hand_key, phf}, at most 8 MiB) into the caller''s library from one of their hand sources, deriving every search column from the PHF; on conflict (owner_id, hand_key) do nothing. Returns {received, inserted, duplicates, rejected, rows[i]: {handKey, status, reason?, field?}} in input order. Budget per account: 150 000 rows / 10 min and 2 000 000 / day (53400).';

-- ---------------------------------------------------------------------------
-- 4. Storage: the private bucket for kept originals
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hand-uploads', 'hand-uploads', false, 52428800, array['application/gzip'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists hand_uploads_owner_select on storage.objects;
create policy hand_uploads_owner_select on storage.objects
for select to authenticated
using (bucket_id = 'hand-uploads'
       and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists hand_uploads_owner_insert on storage.objects;
create policy hand_uploads_owner_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'hand-uploads'
            and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists hand_uploads_owner_delete on storage.objects;
create policy hand_uploads_owner_delete on storage.objects
for delete to authenticated
using (bucket_id = 'hand-uploads'
       and (storage.foldername(name))[1] = (select auth.uid())::text);
