-- ============================================================================
-- User accounts: every stored hand belongs to exactly one person.
-- ============================================================================
--
-- This migration replaces the "no login, everything public" threat model of
-- `20260916190000_phf_baseline.sql` with an owner-scoped one. Read that file's
-- header first; the rules below are the diff against it, not a restatement.
--
-- ## The new rules
--
--   1. A hand has an `owner_id`. You can read and write your own hands and
--      nobody else's. There is no "public hand" any more.
--   2. Anon (logged out, or a guest) can neither read nor write `hands`. It can
--      still *resolve a share*, because that is the one deliberate exception.
--   3. A share slug stays a capability URL that works for anyone, logged in or
--      not. `resolve_share` is `security definer`, so it reaches past the new
--      owner policy on purpose -- that is the whole feature: "anyone with the
--      link can replay this hand".
--   4. Creating anything -- a hand, a share, a corpus sample -- requires a real
--      session. A guest converts entirely in the browser and stores nothing.
--
-- ## Why this is not just "add a column"
--
-- Three things had to change beyond the column itself, and each one is a silent
-- correctness bug if it is skipped:
--
--   * **The dedupe key.** `hand_key` was globally unique. With owners that is
--     wrong in the worst way: the second person to upload a hand somebody else
--     already uploaded would be told "duplicate" and then not be able to see
--     the hand, because it belongs to the first person. The unique index is now
--     `(owner_id, hand_key)`, so dedupe is per-library, which is what it always
--     meant.
--   * **Forged owners.** `save_hands` takes client JSON and feeds it through
--     `jsonb_populate_recordset(null::public.hands, ...)`, so a caller can put
--     anything in the payload -- including somebody else's `owner_id`. Three
--     independent guards now stop that: the insert list writes `auth.uid()`
--     explicitly, the normalizing trigger overwrites `owner_id` whenever there
--     is a session, and the RLS `with check` rejects the row anyway.
--   * **The failure corpus.** `unparsed_hands` holds raw, verbatim hand history
--     text that users uploaded. Under the old model anyone could `select *` it.
--     That is user data, so it is now readable only by whoever submitted it,
--     while the row itself stays globally deduped -- the occurrence counter is
--     the entire point of the table and a per-user corpus would destroy it.
--
-- ## Data
--
-- The 914 pre-existing hands and 15 shares have no owner and no way to acquire
-- one: they were uploaded with no identity attached, so guessing who they
-- belong to is not possible. The owner authorised deleting them rather than
-- leaving unreachable rows behind, which is also what lets `owner_id` be
-- `not null` instead of a nullable column every query has to remember.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Clear the ownerless rows
-- ---------------------------------------------------------------------------
--
-- !! DO NOT RE-RUN THIS FILE AS IT STANDS. !!
--
-- These two statements were correct exactly once, against 914 hands and 15
-- shares that predate accounts. Today they would delete real user libraries.
-- Everything below them is idempotent (`add column if not exists`,
-- `create or replace`), so if you ever need to re-apply the rest, delete these
-- two lines first.
--
-- Shares go first: those referencing a hand would cascade anyway, but the ones
-- carrying an embedded PHF payload have no `hand_id` and would survive.

delete from public.shares;
delete from public.hands;

-- ---------------------------------------------------------------------------
-- 2. hands.owner_id
-- ---------------------------------------------------------------------------
-- `on delete cascade`: deleting an account takes its library with it, which is
-- the behaviour a "delete my account" request has to have anyway.

alter table public.hands
  add column if not exists owner_id uuid not null
    references auth.users(id) on delete cascade;

comment on column public.hands.owner_id is
  'The account this hand belongs to. Set server-side from auth.uid(); a client cannot choose it.';

-- Dedupe is per library, not global. See the header.
drop index if exists public.hands_hand_key_uidx;
create unique index hands_owner_hand_key_uidx on public.hands (owner_id, hand_key);

-- Every list query the app makes is now "my hands, newest first", so the
-- owner column belongs at the front of the default sort index.
create index hands_owner_played_idx on public.hands (owner_id, played_at desc nulls last);

-- ---------------------------------------------------------------------------
-- 3. Normalizing trigger: stamp the owner
-- ---------------------------------------------------------------------------
-- Recreated wholesale (rather than patched) so the function body stays a single
-- readable unit. The only change against the baseline is the owner_id block.
--
-- When there is a session, `auth.uid()` *overwrites* whatever the client sent.
-- When there is none, the value is left alone so a service-role import or a
-- backfill can set it explicitly -- those callers are already trusted, and RLS
-- does not apply to them either way.

create or replace function public.hands_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.owner_id := (select auth.uid());
  end if;

  new.hero_cards   := coalesce(public.normalize_cards(new.hero_cards), '{}'::text[]);
  new.board_cards  := coalesce(public.normalize_cards(new.board_cards), '{}'::text[]);
  new.player_names := coalesce(new.player_names, '{}'::text[]);
  new.winners      := coalesce(new.winners, '{}'::text[]);

  new.player_positions   := public.normalize_positions(new.player_positions);
  new.showdown_positions := public.normalize_positions(new.showdown_positions);
  new.winner_positions   := public.normalize_positions(new.winner_positions);

  new.hand_key        := btrim(new.hand_key);
  new.site            := lower(btrim(new.site));
  new.variant         := nullif(lower(btrim(coalesce(new.variant, ''))), '');
  new.limit_type      := nullif(lower(btrim(coalesce(new.limit_type, ''))), '');
  new.tournament_id   := nullif(btrim(coalesce(new.tournament_id, '')), '');
  new.currency        := upper(btrim(new.currency));
  new.hero_name       := nullif(btrim(coalesce(new.hero_name, '')), '');
  new.hero_position   := nullif(upper(btrim(coalesce(new.hero_position, ''))), '');
  new.hero_hand_class := nullif(btrim(coalesce(new.hero_hand_class, '')), '');
  new.table_name      := nullif(btrim(coalesce(new.table_name, '')), '');
  new.stakes_label    := nullif(btrim(coalesce(new.stakes_label, '')), '');
  new.street_reached  := nullif(lower(btrim(coalesce(new.street_reached, ''))), '');
  new.source_filename := nullif(btrim(coalesce(new.source_filename, '')), '');

  if new.player_count is null then
    new.player_count := nullif(cardinality(new.player_names), 0);
    -- A positional-anonymity hand has no names to count, but it does have a
    -- roster of positions, which is the same number.
    if new.player_count is null then
      new.player_count := nullif(cardinality(new.player_positions), 0);
    end if;
  end if;

  -- created_at is server-authoritative; a client cannot backdate a row.
  new.created_at := now();

  return new;
end;
$$;

revoke execute on function public.hands_normalize() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS on hands: owner-scoped
-- ---------------------------------------------------------------------------

drop policy if exists hands_public_select on public.hands;
drop policy if exists hands_public_insert on public.hands;

-- `anon` loses the table entirely. A logged-out visitor reaching a stored hand
-- happens through `resolve_share` and nowhere else.
revoke all on public.hands from anon;
revoke all on public.hands from authenticated;
grant select, insert on public.hands to authenticated;

-- `(select auth.uid())` rather than a bare `auth.uid()`: Postgres hoists the
-- scalar subquery into an InitPlan and evaluates it once per statement instead
-- of once per row. On a 25-row page it does not matter; on the sequential scan
-- behind a GIN-less filter it does.
create policy hands_owner_select on public.hands
for select to authenticated
using (owner_id = (select auth.uid()));

create policy hands_owner_insert on public.hands
for insert to authenticated
with check (owner_id = (select auth.uid()));

-- Still no UPDATE and no DELETE policy. Ownership makes "let people delete
-- their own hands" defensible, but it is a separate feature with its own UI and
-- its own confirmation flow, and adding the policy now would expose the verb
-- before anything guards it.

-- ---------------------------------------------------------------------------
-- 5. save_hands: stamp the owner, refuse anonymous callers
-- ---------------------------------------------------------------------------
-- Still `security invoker`, so RLS and the rate-limit trigger both still apply.
-- The explicit `auth.uid()` check exists purely for the error message: without
-- it a logged-out caller gets `42501 new row violates row-level security`,
-- which is not something a UI can show a person.

create or replace function public.save_hands(p_hands jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save hands.'
      using errcode = '42501';
  end if;

  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'save_hands expects a JSON array of hand rows'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_hands);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0);
  end if;
  if v_received > 500 then
    raise exception 'save_hands accepts at most 500 hands per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_populate_recordset(null::public.hands, p_hands)
  ),
  deduped as (
    select distinct on (hand_key) *
    from input
    where hand_key is not null and btrim(hand_key) <> ''
    order by hand_key
  ),
  ins as (
    insert into public.hands (
      owner_id,
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
      -- Not `d.owner_id`: whatever the client put in the payload is ignored.
      v_owner,
      d.hand_key, d.phf, d.standard_text, d.source_text,
      coalesce(d.schema_version, 'phf/1'), d.parser_version,
      d.site, d.site_hand_id, d.variant, d.limit_type,
      coalesce(d.game_format, 'cash'::public.game_format),
      d.tournament_id,
      coalesce(d.currency, 'USD'),
      coalesce(d.currency_minor_units, 100::smallint),
      d.currency_symbol,
      d.small_blind, d.big_blind, d.ante, d.stakes_label,
      d.table_name, d.max_seats, d.played_at,
      d.hero_name, d.hero_seat, d.hero_position,
      coalesce(d.hero_cards, '{}'::text[]), d.hero_hand_class,
      coalesce(d.board_cards, '{}'::text[]),
      coalesce(d.player_names, '{}'::text[]), d.player_count,
      d.street_reached, coalesce(d.went_to_showdown, false),
      d.total_pot, d.rake, d.hero_profit, coalesce(d.winners, '{}'::text[]),
      d.source_filename,
      coalesce(d.site_anonymization, 'none'::public.site_anonymization),
      coalesce(d.player_positions, '{}'::text[]),
      coalesce(d.showdown_positions, '{}'::text[]),
      coalesce(d.winner_positions, '{}'::text[])
    from deduped d
    -- Per-library dedupe. Uploading a hand another account already has is a
    -- new row, not a duplicate: it is your copy of your hand.
    on conflict (owner_id, hand_key) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from ins;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   v_inserted,
    'duplicates', v_received - v_inserted
  );
end;
$$;

comment on function public.save_hands(jsonb) is
  'Batch-insert hands into the caller''s own library, deduping on (owner_id, hand_key). Requires a session. Returns {received, inserted, duplicates}.';

-- ---------------------------------------------------------------------------
-- 6. unparsed_hands: raw uploads stop being world-readable
-- ---------------------------------------------------------------------------
--
-- The corpus stays globally deduped -- `occurrences` is the "which parser do we
-- write next" signal and splitting the table per user would throw it away. What
-- changes is who can read a row: only the account that first submitted it.
--
-- Keeping the SELECT *grant* while narrowing the *policy* is deliberate. RLS
-- filters rows; a missing grant raises 42501. `hands_facets()` and
-- `unparsed_summary()` are `security invoker` and read this table, so revoking
-- the grant would turn a logged-out facets call into an error instead of an
-- empty result. `submitted_by = auth.uid()` is already false-for-null-uid, so
-- anon sees nothing either way.

alter table public.unparsed_hands
  add column if not exists submitted_by uuid
    references auth.users(id) on delete set null;

comment on column public.unparsed_hands.submitted_by is
  'The account that first submitted this sample. The row stays globally deduped; this only decides who can read the raw text back.';

create index if not exists unparsed_submitted_by_idx
  on public.unparsed_hands (submitted_by) where submitted_by is not null;

drop policy if exists unparsed_public_select on public.unparsed_hands;

create policy unparsed_own_select on public.unparsed_hands
for select to authenticated
using (submitted_by = (select auth.uid()));

-- Pre-existing samples carry no submitter, so nothing outside the service role
-- can read them. That is the intended outcome: they were collected under the
-- old model and there is nobody to attribute them to.

create or replace function public.record_conversion_failures(p_failures jsonb)
returns jsonb
language plpgsql
-- Still `security definer`: the write path has to stay the only way a caller
-- can touch this table, so that `status`, `notes` and `occurrences` cannot be
-- forged. It now also refuses anonymous callers -- a guest stores nothing.
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_new      integer;
  v_touched  integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to contribute conversion samples.'
      using errcode = '42501';
  end if;

  if p_failures is null or jsonb_typeof(p_failures) <> 'array' then
    raise exception 'record_conversion_failures expects a JSON array'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_failures);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'created', 0, 'updated', 0, 'skipped', 0);
  end if;
  if v_received > 200 then
    raise exception 'record_conversion_failures accepts at most 200 records per call (got %)', v_received
      using errcode = '53400';
  end if;

  perform public.enforce_rate_limit('unparsed_insert', v_received, 5000, interval '10 minutes');

  with input as (
    select
      lower(btrim(coalesce(f ->> 'fingerprint', '')))                      as fingerprint,
      f ->> 'rawText'                                                      as raw_text,
      left(nullif(btrim(coalesce(f ->> 'detectedSite', '')), ''), 64)      as detected_site,
      case
        when nullif(btrim(coalesce(f ->> 'detectionConfidence', '')), '') is null then null
        else least(greatest(btrim(f ->> 'detectionConfidence')::real, 0::real), 1::real)
      end                                                                  as detection_confidence,
      case lower(btrim(coalesce(f ->> 'stage', '')))
        when 'split'     then 'split'
        when 'detect'    then 'detect'
        when 'validate'  then 'validate'
        when 'serialize' then 'serialize'
        else 'parse'
      end::public.conversion_stage                                         as stage,
      left(coalesce(nullif(btrim(coalesce(f ->> 'reason', '')), ''), 'unknown'), 120)         as reason,
      left(coalesce(nullif(btrim(coalesce(f ->> 'message', '')), ''), 'unspecified'), 2000)   as message,
      left(coalesce(nullif(btrim(coalesce(f ->> 'parserVersion', '')), ''), 'unknown'), 64)   as parser_version,
      left(nullif(btrim(coalesce(f ->> 'sourceFilename', '')), ''), 255)   as source_filename
    from jsonb_array_elements(p_failures) as f
  ),
  deduped as (
    select distinct on (fingerprint) *
    from input
    where fingerprint ~ '^[0-9a-f]{64}$'
      and raw_text is not null
      and char_length(raw_text) between 1 and 131072
    order by fingerprint
  ),
  upserted as (
    insert into public.unparsed_hands as u (
      fingerprint, raw_text, detected_site, detection_confidence,
      stage, reason, message, parser_version, source_filename, submitted_by
    )
    select
      d.fingerprint, d.raw_text, d.detected_site, d.detection_confidence,
      d.stage, d.reason, d.message, d.parser_version, d.source_filename, v_owner
    from deduped d
    on conflict (fingerprint) do update
      set occurrences   = u.occurrences + 1,
          last_seen_at  = now(),
          stage          = excluded.stage,
          reason         = excluded.reason,
          message        = excluded.message,
          parser_version = excluded.parser_version,
          detected_site  = coalesce(excluded.detected_site, u.detected_site),
          detection_confidence = coalesce(excluded.detection_confidence, u.detection_confidence),
          source_filename = coalesce(u.source_filename, excluded.source_filename),
          -- First submitter keeps the row. Re-attributing it to whoever
          -- uploaded it most recently would silently move read access between
          -- accounts, and `occurrences` already records that it was seen again.
          submitted_by    = coalesce(u.submitted_by, excluded.submitted_by)
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert)::integer, count(*)::integer
  into v_new, v_touched
  from upserted;

  return jsonb_build_object(
    'received', v_received,
    'created',  coalesce(v_new, 0),
    'updated',  coalesce(v_touched, 0) - coalesce(v_new, 0),
    'skipped',  v_received - coalesce(v_touched, 0)
  );
end;
$$;

revoke all on function public.record_conversion_failures(jsonb) from public;
grant execute on function public.record_conversion_failures(jsonb) to authenticated;

comment on function public.record_conversion_failures(jsonb) is
  'Upsert ConversionFailure records by fingerprint, incrementing occurrences atomically. Requires a session; records the first submitter.';

-- ---------------------------------------------------------------------------
-- 7. shares: owned, but resolvable by anyone
-- ---------------------------------------------------------------------------
--
-- The table stays sealed (RLS on, no policies, no grants). `owner_id` is not
-- there to gate reads -- `resolve_share` is definer and deliberately ignores
-- ownership, because "anyone with the link can replay this hand" is the point.
-- It is there so a share has an accountable creator and so a deleted account
-- takes its links with it.

alter table public.shares
  add column if not exists owner_id uuid not null
    references auth.users(id) on delete cascade;

comment on column public.shares.owner_id is
  'Who created the link. Not a read gate -- resolve_share works for anyone -- but it ties a link to an account and cascades on account deletion.';

create index if not exists shares_owner_idx on public.shares (owner_id, created_at desc);

create or replace function public.create_share(
  p_hand_id       uuid  default null,
  p_phf           jsonb default null,
  p_standard_text text  default null,
  p_title         text  default null
)
returns jsonb
language plpgsql
-- Still `security definer`: `shares` has no grants, so creation must run
-- elevated. Being elevated is exactly why the ownership check below has to be
-- explicit -- RLS on `hands` is bypassed in here, so without it any signed-in
-- caller could mint a public link to a stranger's hand by guessing a uuid.
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_slug  text;
  v_id    uuid;
  v_phf   jsonb := p_phf;
  v_text  text  := p_standard_text;
begin
  if v_owner is null then
    raise exception 'You must be signed in to create a share link.'
      using errcode = '42501';
  end if;

  if p_hand_id is null and p_phf is null then
    raise exception 'create_share needs either a hand id or an embedded PHF payload'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('share_create', 1, 300, interval '1 hour');

  if p_hand_id is not null then
    -- Deliberately the same error for "no such hand" and "not your hand": the
    -- two must be indistinguishable, or this becomes an oracle for whether a
    -- given uuid exists in somebody else's library.
    if not exists (
      select 1 from public.hands h
      where h.id = p_hand_id and h.owner_id = v_owner
    ) then
      raise exception 'No stored hand with id %', p_hand_id using errcode = '23503';
    end if;
    v_phf  := null;
    v_text := null;
  end if;

  for i in 1..8 loop
    v_slug := public.generate_share_slug(10);
    begin
      insert into public.shares (slug, hand_id, phf, standard_text, title, owner_id)
      values (v_slug, p_hand_id, v_phf, v_text, nullif(btrim(coalesce(p_title, '')), ''), v_owner)
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_slug := null;  -- astronomically unlikely; retry
    end;
  end loop;

  if v_id is null then
    raise exception 'Could not allocate a unique share slug' using errcode = '53400';
  end if;

  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;

revoke all on function public.create_share(uuid, jsonb, text, text) from public;
grant execute on function public.create_share(uuid, jsonb, text, text) to authenticated;

comment on function public.create_share(uuid, jsonb, text, text) is
  'Creates a share link owned by the caller. Requires a session, and refuses hand ids the caller does not own. The resulting slug resolves for anyone.';

-- `resolve_share` is intentionally left exactly as the baseline defined it:
-- `security definer`, granted to anon and authenticated, keyed strictly by slug
-- equality. It reads past the new owner policy on `hands`, which is the whole
-- reason a share link works for a stranger.

-- ---------------------------------------------------------------------------
-- 8. hands_facets: scoped by RLS, but say so
-- ---------------------------------------------------------------------------
-- The body is unchanged from the position migration except for the comment:
-- every subquery here reads `public.hands`, the function is `security invoker`,
-- and the new policy therefore turns each one into "…of mine". Recreated only
-- so the stored comment does not keep claiming the numbers are global.

comment on function public.hands_facets() is
  'Every distinct filter value the browse UI offers, for the caller''s own hands. security invoker, so the owner policy scopes every count.';

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
--
-- `anon` loses every function that touches `hands`, reads included. Leaving the
-- reads granted would have been the friendlier-looking choice -- RLS returns no
-- rows for a role with no policy, so a logged-out browse would just look empty.
-- It does not work here, because the grant on the *table* is gone too: an
-- invoker function reading `public.hands` as `anon` raises `42501 permission
-- denied` before RLS is ever consulted. So the options were "grant anon SELECT
-- on the table and rely on RLS alone" or "revoke the functions as well". The
-- second keeps a single, checkable rule -- anon cannot reach `hands` by any
-- path -- and the client is expected to know whether it has a session anyway.
--
-- The one deliberate exception stays `resolve_share`, which is `security
-- definer` and therefore never consults the anon role's privileges at all.

revoke execute on function public.save_hands(jsonb)                     from anon;
revoke execute on function public.record_conversion_failures(jsonb)     from anon;
revoke execute on function public.create_share(uuid, jsonb, text, text) from anon;
revoke execute on function public.search_hands(jsonb, integer, integer) from anon;
revoke execute on function public.get_hand(uuid)                        from anon;
revoke execute on function public.hands_facets()                        from anon;

grant execute on function public.save_hands(jsonb)                       to authenticated;
grant execute on function public.search_hands(jsonb, integer, integer)   to authenticated;
grant execute on function public.get_hand(uuid)                          to authenticated;
grant execute on function public.hands_facets()                          to authenticated;

-- Unchanged, listed so this file is a complete statement of who may call what:
--   unparsed_summary   anon + authenticated -- reads only `unparsed_hands`,
--                      where anon keeps its SELECT grant and the new policy
--                      yields no rows, so it answers zeros instead of erroring.
--   resolve_share      anon + authenticated (definer, by design)
--   enforce_rate_limit / generate_share_slug   service_role only
