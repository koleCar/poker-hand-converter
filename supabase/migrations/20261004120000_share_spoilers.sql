-- ============================================================================
-- Shares: stop the link preview from giving the hand away.
-- ============================================================================
--
-- Fixes #23. `frontend/api/share-meta.ts` renders the Open Graph tags every
-- link-unfurl crawler reads, and its description ended:
--
--     6-handed · board Ah Kd 7c · Villain wins $312 · shown down
--
-- Slack, Discord, Twitter and iMessage all print that under the link. For a
-- product whose core interaction is "what would you do here?", the unfurl was
-- answering the question before anybody opened the post. The replayer's own
-- chrome had already been stripped of outcome data one field at a time
-- (`fef6ff7`) and F3 turned that into a rule -- `spoilersRevealed()` in
-- `tableMath.ts`, which gates anything derived from `hand.results` on the
-- replay's frame position. A link unfurl has no frame position; it is
-- permanently at the deal. So it needs the gate stated as data.
--
-- ## Why a column and not a computed default
--
-- It is a property of the *link*, not of the hand and not of the renderer. The
-- same hand can legitimately be shared twice: once into a strategy thread where
-- the result is the spoiler, and once into a group chat as "look at this
-- cooler", where the result is the point. Whoever pressed Share is the only
-- party who knows which, so the answer is stored next to the slug they were
-- given.
--
-- ## Why the default is false
--
-- Because the failure modes are not symmetrical. A spoiler-free unfurl on a
-- link that wanted one costs a reader one extra click; a spoiler on a link that
-- did not costs the post its entire purpose, irreversibly, for everyone who saw
-- the preview. `not null default false` also means the 15-or-so rows that
-- predate this migration -- and any client that has not learned the parameter
-- yet -- are silently correct rather than silently leaking.
--
-- ## Additive only
--
-- New file, no edits to `20261003090000_share_projection.sql` or to anything
-- before it. `read_share` and `create_share` are recreated here in full, which
-- is what `create or replace` requires and is also the review gate the
-- projection migration argued for: widening a share payload should mean editing
-- a function body that somebody has to read.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
--
-- `not null default false` rather than a nullable tri-state. There is no third
-- answer worth representing: "unset" and "no" are the same instruction to the
-- renderer, and a nullable column would push that coalesce into every consumer,
-- which is three places to get it wrong instead of zero.

alter table public.shares
  add column if not exists spoilers boolean not null default false;

comment on column public.shares.spoilers is
  'Whether this link''s Open Graph copy may reveal the result -- the winner, the amount, the total pot. Default false: an unfurl is permanently at frame zero, and #23 is what happens when it is not treated that way. Governs share-meta.ts only; the share page itself gates the same data on replay position via spoilersRevealed().';

-- ---------------------------------------------------------------------------
-- 2. create_share -- one more parameter, same posture
-- ---------------------------------------------------------------------------
--
-- Recreated from `20260922130000_user_accounts_and_ownership.sql` §7 with
-- `p_spoilers` appended and defaulted. The body is otherwise unchanged: still
-- `security definer`, still refusing a `p_hand_id` the caller does not own,
-- still rate limited.
--
-- Adding a defaulted parameter does **not** replace the four-argument function
-- -- Postgres keys functions by their argument list, so `create or replace`
-- would leave two overloads standing and PostgREST would then have to guess
-- which one a call with four named arguments meant. It resolves such calls by
-- the JSON keys present, so a second overload is a live ambiguity rather than a
-- harmless leftover. The old signature is therefore dropped, and because
-- `p_spoilers` has a default, a client built before this migration keeps
-- working untouched: four keys still bind, and the fifth takes `false`.
--
-- Dropping is safe in the other direction too: nothing in the database
-- references `create_share` (no views, no triggers, no other function body), so
-- there is nothing for a `cascade` to take with it -- and this is deliberately
-- not a `cascade`, so if that ever stops being true the migration fails loudly
-- instead of quietly deleting a dependent.

drop function if exists public.create_share(uuid, jsonb, text, text);

create or replace function public.create_share(
  p_hand_id       uuid    default null,
  p_phf           jsonb   default null,
  p_standard_text text    default null,
  p_title         text    default null,
  p_spoilers      boolean default false
)
returns jsonb
language plpgsql
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
      insert into public.shares (slug, hand_id, phf, standard_text, title, owner_id, spoilers)
      values (
        v_slug,
        p_hand_id,
        v_phf,
        v_text,
        nullif(btrim(coalesce(p_title, '')), ''),
        v_owner,
        -- `coalesce`, not the raw argument: an explicit `"p_spoilers": null`
        -- from a client would otherwise hit the not-null constraint and fail a
        -- share that should simply have been spoiler-free.
        coalesce(p_spoilers, false)
      )
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

revoke all on function public.create_share(uuid, jsonb, text, text, boolean) from public;

-- Supabase ships `alter default privileges ... grant all on functions to anon,
-- authenticated, service_role`, so both client roles receive an explicit
-- EXECUTE grant at creation time that a PUBLIC revoke does not touch. Revoke
-- `anon` by name, exactly as `20260922130000` had to for the old signature:
-- creating a share stores a hand, so it needs an account like any other write.
revoke execute on function public.create_share(uuid, jsonb, text, text, boolean) from anon;
grant  execute on function public.create_share(uuid, jsonb, text, text, boolean) to authenticated;

comment on function public.create_share(uuid, jsonb, text, text, boolean) is
  'Creates a share link owned by the caller. Requires a session, and refuses hand ids the caller does not own. p_spoilers defaults false and governs whether the link''s unfurl may reveal the result (#23). The resulting slug resolves for anyone.';

-- ---------------------------------------------------------------------------
-- 3. read_share -- one more key in the projection
-- ---------------------------------------------------------------------------
--
-- Body identical to `20261003090000_share_projection.sql` §2 plus `'spoilers'`.
-- The projection stays explicit and hand-listed for the reason that file gives
-- at length: this function is `security definer` and granted to `anon`, so RLS
-- will not save anything inside the body and the column list is the only
-- control there is. `select to_jsonb(v_share)` would have made this a one-line
-- change and would also have re-published `owner_id` and the embedded `phf`
-- with its `meta.rawText` -- which is precisely the bug that migration exists
-- to have fixed.
--
-- Still `stable` and side-effect free: `record_share_view` is the only thing
-- that writes, which is what lets a crawler read this without registering as a
-- human view.

create or replace function public.read_share(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_share public.shares%rowtype;
  v_phf   jsonb;
  v_text  text;
begin
  if p_slug is null or p_slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$' then
    return null;
  end if;

  select * into v_share from public.shares s where s.slug = p_slug;

  if not found then
    return null;
  end if;

  -- Two named columns, never `to_jsonb(h)`. `hands` also holds `source_text`,
  -- `owner_id`, `hand_key`, `site_hand_id` and `source_filename`, none of which
  -- a share page has any use for -- and a whole-row read is how they got out.
  if v_share.hand_id is not null then
    select h.phf, h.standard_text
      into v_phf, v_text
      from public.hands h
     where h.id = v_share.hand_id;
  end if;

  -- Exactly one source is populated: the stored hand, or the copy embedded at
  -- share time for a hand that was never saved. The embedded copy is client
  -- JSON and carries the same `meta.rawText`, so it gets redacted too -- the
  -- redaction happens after the coalesce, not per branch, so neither path can
  -- be added to later without it.
  v_phf  := public.phf_redact_private(coalesce(v_phf, v_share.phf));
  v_text := coalesce(v_text, v_share.standard_text);

  return jsonb_build_object(
    'slug',         v_share.slug,
    'title',        v_share.title,
    -- Whether the caller may print the result. Note what this is *not*: it does
    -- not redact anything. `phf` and `standardText` below still carry the
    -- winners, because they are the hand and a share page exists to replay it.
    -- The flag governs the *copy about* the hand -- the unfurl, the `<title>` --
    -- which is read in places where there is no replay to gate against.
    'spoilers',     v_share.spoilers,
    -- The count *before* this read. `read_share` does not move it, and lying
    -- about that would mean a reload showing the same number twice.
    'views',        v_share.views,
    'createdAt',    v_share.created_at,
    -- The hand's uuid, so a signed-in owner can open their own copy. It is not
    -- a capability: `get_hand` is owner-scoped by RLS, so anyone else gets null.
    'handId',       v_share.hand_id,
    'phf',          v_phf,
    'standardText', v_text
  );
end;
$$;

revoke all on function public.read_share(text) from public;

comment on function public.read_share(text) is
  'Resolves a share slug to exactly what a share page renders: slug, title, spoilers, views, createdAt, handId, redacted phf, standardText. Explicitly projected -- never the hands row. No side effects. Null for unknown and malformed slugs alike.';

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
--
-- `read_share` keeps the posture `20261003090000` gave it: granted to `anon`
-- and `authenticated`, because "anyone with the link can replay this hand" is
-- the feature. `create or replace` preserves existing grants, so this is a
-- restatement rather than a change -- stated anyway so this file is a complete
-- account of who may call what after it runs.
--
-- `resolve_share` is untouched. It is a thin wrapper over `read_share` plus
-- `record_share_view`, so it gains `spoilers` in its payload for free and stays
-- on its 2026-11-27 removal date.

grant execute on function public.read_share(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Verification (run against the ANON key, not a PAT)
-- ---------------------------------------------------------------------------
--
--   curl -s "$SUPABASE_URL/rest/v1/rpc/read_share" \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     -H "authorization: Bearer $SUPABASE_ANON_KEY" \
--     -H 'content-type: application/json' \
--     -d '{"p_slug":"<a real slug>"}' \
--   | jq '[ (.spoilers == false), (has("hand") | not) ] | all'
--
-- Must print `true` for every pre-existing slug: the column defaulted false, so
-- no link minted before today starts revealing anything. Then fetch the unfurl
-- itself and check the copy rather than the column --
--
--   curl -s -A 'Twitterbot/1.0' "$SITE_URL/h/<slug>" \
--   | grep 'og:description'
--
-- -- which must contain no player name and no amount.
