-- ============================================================================
-- Share resolution: project the columns a share page needs, and nothing else.
-- ============================================================================
--
-- Fixes the disclosure in `20260916190000_phf_baseline.sql` (§8.9). That file's
-- `resolve_share` did this:
--
--     select to_jsonb(h) into v_hand from public.hands h where h.id = ...;
--     ...
--     'hand', v_hand,
--
-- `to_jsonb(h)` is the *whole row*. `resolve_share` is `security definer` and
-- granted to `anon`, so every stranger holding a slug was handed:
--
--   * `source_text`  -- the verbatim site text, with every opponent's screen
--                       name, the table name, and the hero's own hole cards on
--                       lines the replayer never shows;
--   * `owner_id`     -- the sharer's `auth.users` uuid, a stable cross-share
--                       correlator for an account that never consented to being
--                       identifiable to a link recipient;
--   * `hand_key`,
--     `site_hand_id` -- the site's own identifiers, which are the join key into
--                       any other dataset that has the same hand;
--   * `source_filename` -- often a real name or a local path.
--
-- A share slug is a capability URL handed to strangers *on purpose*. That makes
-- the payload the security boundary: there is no authentication step left to
-- tighten, so the only control is what the function chooses to return. The same
-- leak was in `phf` too, because the client stores the entire `PhfHand` and its
-- `meta.rawText` is the same raw text as `source_text`.
--
-- ## The shape of the fix
--
-- `select to_jsonb(row)` is the anti-pattern. It makes the payload a function of
-- the *table definition*, so a column added years later for an unrelated reason
-- silently becomes public. Every function below names its output keys one by
-- one: adding a column to `public.hands` now changes nothing here, and widening
-- the share payload requires editing this file, which is the review gate we
-- actually want. The forum publish path (F7) has the same problem and should
-- copy this shape rather than invent a second one.
--
-- ## Why the read and the counter are split
--
-- The baseline combined them so a share page cost one round trip. That forced
-- `resolve_share` to be `volatile` (it does an UPDATE), which in turn means:
--
--   * it cannot be marked `stable`, so PostgREST will not serve it over GET and
--     no layer above it can cache it;
--   * a read-only consumer cannot exist. `frontend/api/share-meta.ts` renders
--     Open Graph tags for link-unfurl crawlers, and a crawler prefetch counted
--     as a human view -- Slack alone unfurls a link for every member who sees
--     it, so the counter measured "times pasted", not "times read";
--   * a cheap read path had a write's blast radius.
--
-- So: `read_share` is `stable` and returns the payload, `record_share_view` is
-- `volatile` and does nothing else. Clients that want the counter call both.
--
-- ## What is deliberately still exposed
--
-- `standardText` and the redacted `phf` still carry the opponents' screen names
-- and everybody's shown hole cards. That is not an oversight -- it is the hand,
-- and a replayer with the names blanked out is not the feature anyone asked to
-- share. What goes is the material that has nothing to do with replaying: the
-- raw file, the account id, the site's identifiers, the filename.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. phf_redact_private -- the one definition of "safe to hand to a stranger"
-- ---------------------------------------------------------------------------
--
-- `PhfHand.meta` is parser bookkeeping, not hand data. Four of its keys must
-- never cross an account boundary:
--
--   rawText           the hand's slice of the uploaded file, verbatim. This is
--                     `hands.source_text` by another name; stripping the column
--                     and leaving this would fix nothing.
--   originalFilename  the uploader's local filename. Frequently a real name.
--   warnings          parser diagnostics. They quote source lines, so they are
--                     a partial `rawText` with extra steps, and they describe
--                     our converter's internals to someone probing it.
--   parsedAt          when the owner uploaded the hand. Says nothing about the
--                     hand and everything about the owner's session times.
--
-- Everything else in `meta` (`siteId`, `siteName`, `handId`, `parserId`,
-- `parserVersion`, `textStyle`) the replayer genuinely reads. `handId` is the
-- site's id and is also printed in the standard text the share already carries,
-- so removing it here would be theatre.
--
-- Deny-list rather than allow-list, deliberately: `meta` is versioned by the
-- PHF schema and a new *rendering* key added upstream must keep working without
-- a migration. The trade is that a new *sensitive* key needs a line here -- so
-- the rule for `lib/phf/types.ts` is that anything user-identifying goes in
-- `meta` only if it is added to this list in the same change.
--
-- `immutable`: pure jsonb-to-jsonb, no catalog or table access, so it can be
-- folded into an index expression later if the forum path ever needs one.

create or replace function public.phf_redact_private(p_phf jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    -- No document, or a `meta` that is not an object: nothing to strip, and
    -- `jsonb_set` would happily *create* a `meta` key on the way past.
    when p_phf is null then null
    when jsonb_typeof(p_phf -> 'meta') is distinct from 'object' then p_phf
    else jsonb_set(
      p_phf,
      '{meta}',
      (p_phf -> 'meta') - 'rawText' - 'originalFilename' - 'warnings' - 'parsedAt'
    )
  end;
$$;

revoke all on function public.phf_redact_private(jsonb) from public;

-- `revoke ... from public` is not enough on its own: Supabase ships
-- `alter default privileges in schema public grant all on functions to anon,
-- authenticated, service_role`, so both client roles receive an explicit
-- EXECUTE grant at creation time that survives a PUBLIC revoke. Revoke by name.
-- This is an internal of the functions below; no client has a use for it.
revoke execute on function public.phf_redact_private(jsonb) from anon, authenticated;

comment on function public.phf_redact_private(jsonb) is
  'Strips meta.rawText / originalFilename / warnings / parsedAt from a PHF document. The single definition of what may leave an account boundary; use it on every path that publishes a hand.';

-- ---------------------------------------------------------------------------
-- 2. read_share -- explicit projection, no side effects
-- ---------------------------------------------------------------------------
--
-- `security definer` for the same two reasons the baseline gave, minus one:
-- `public.shares` has no grants and no policies, and `public.hands` is scoped
-- to its owner by RLS, so an invoker function would see nothing at all. Reading
-- past the owner policy *is* the feature -- "anyone with the link can replay
-- this hand". The counter is no longer a reason, because there is no longer a
-- write in here.
--
-- Being definer is exactly why the projection has to be explicit: RLS is not
-- going to save us inside this body, so the column list is the only control.
--
-- The function is keyed strictly by slug equality and returns exactly one row,
-- so it cannot be turned into a table dump. A malformed slug and an unknown one
-- both return `null`, with the shape check first so a probe cannot even
-- distinguish them by timing a table lookup.
--
-- `stable`: no writes, and within a statement the same slug gives the same
-- answer. That is what lets PostgREST serve it over GET and a CDN cache it.

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
  'Resolves a share slug to exactly what a share page renders: slug, title, views, createdAt, handId, redacted phf, standardText. Explicitly projected -- never the hands row. No side effects. Null for unknown and malformed slugs alike.';

-- ---------------------------------------------------------------------------
-- 3. record_share_view -- the counter, and only the counter
-- ---------------------------------------------------------------------------
--
-- `security definer` because `anon` has no UPDATE on any table and must never
-- get one. This function can touch two columns on one row selected by slug
-- equality, which is about as small as a write privilege gets.
--
-- Rate limited per slug. The bucket is a counter, and a counter that anyone can
-- increment by holding a URL is a vanity metric a bored person can ruin with a
-- `for` loop -- and each increment is a row write, so it is also a cheap way to
-- generate WAL. 600/hour on a single link is far past any real traffic pattern
-- (a link that genuinely gets ten views a second is not our problem yet) and
-- costs an attacker nothing to discover, so it is not an oracle either.
--
-- Interpolating `p_slug` into the bucket name is safe *because* the shape check
-- runs first: the regex admits only 8-16 characters from a fixed 31-symbol
-- alphabet, so the key is bounded and contains nothing special. Do not move
-- that check below this line. One `ingest_rate_limit` row accrues per viewed
-- slug; the table is tiny and service-role-readable, so pruning windows older
-- than a day is a cron job, not a schema change.
--
-- Over-budget is swallowed, not raised. The counter is decoration on a page
-- whose job is to show a hand: a missed increment is invisible, while a raised
-- `53400` would surface as a red error in a share page's console -- or, for a
-- client that chains the two calls, break the page outright. Errors that are
-- not the caller's fault and that the caller cannot act on should not travel.
--
-- Returns whether the view was actually counted, so `resolve_share` below can
-- report an honest number and so a verification script can tell "counted" from
-- "throttled" without reading the table.

create or replace function public.record_share_view(p_slug text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_slug is null or p_slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$' then
    return false;
  end if;

  begin
    perform public.enforce_rate_limit('share_view:' || p_slug, 1, 600, interval '1 hour');
  exception when sqlstate '53400' then
    return false;
  end;

  update public.shares s
     set views          = s.views + 1,
         last_viewed_at = now()
   where s.slug = p_slug;

  -- `found` is false for an unknown slug, which is the same answer a caller
  -- gets from `read_share`. Nothing here reveals whether the slug exists that
  -- `read_share` has not already told them.
  return found;
end;
$$;

revoke all on function public.record_share_view(text) from public;

comment on function public.record_share_view(text) is
  'Increments views / last_viewed_at for one slug and nothing else. Rate limited to 600/hour per slug; returns false instead of raising when throttled, unknown or malformed.';

-- ---------------------------------------------------------------------------
-- 4. resolve_share -- DEPRECATED, remove on or after 2026-11-27
-- ---------------------------------------------------------------------------
--
-- Kept only so browser tabs and CDN-cached bundles built before this migration
-- keep working; a share link is pasted into chat apps that re-fetch it for
-- months, so a hard cutover would break real pages. It is now a thin wrapper
-- over the two functions above and holds no logic of its own.
--
-- **It no longer returns the `hand` key.** That is the entire point of this
-- migration and is not a compatibility surface worth preserving: the key
-- existed only as a whole-row dump. Old clients read `payload.hand` into an
-- optional field and render `null` for it without complaint (see
-- `frontend/src/lib/db/shares.ts` before this change), so they degrade to
-- exactly what they should have been getting all along.
--
-- REMOVAL: on or after **2026-11-27** (60 days from 2026-09-28), drop this
-- function and revoke nothing else -- `read_share` and `record_share_view` are
-- the supported pair. Before dropping, confirm `frontend/api/share-meta.ts` and
-- `frontend/src/lib/db/shares.ts` no longer name it (they already do not), and
-- check the Supabase logs for any `rpc/resolve_share` in the preceding week.
--
-- Still `volatile` and still `security definer`: it writes, via the wrapper.

create or replace function public.resolve_share(p_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  v_payload := public.read_share(p_slug);

  if v_payload is null then
    return null;
  end if;

  -- The old contract was "the number including your view". `read_share` returns
  -- the count before it, so add the one we just recorded -- and only if it was
  -- actually recorded, which is what the boolean is for.
  if public.record_share_view(p_slug) then
    v_payload := jsonb_set(
      v_payload,
      '{views}',
      to_jsonb(coalesce((v_payload ->> 'views')::integer, 0) + 1)
    );
  end if;

  return v_payload;
end;
$$;

revoke all on function public.resolve_share(text) from public;

comment on function public.resolve_share(text) is
  'DEPRECATED, remove on or after 2026-11-27. Thin wrapper over read_share + record_share_view, kept for clients built before the projection fix. No longer returns the whole hands row. New code calls the two functions directly.';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
--
-- Same posture as the baseline: everything is revoked from PUBLIC above, then
-- granted back by name to the two roles the app uses.
--
-- Both are granted to `anon` on purpose, and they are still the *only* thing
-- `anon` may call that reaches `public.hands`. That is the one deliberate hole
-- in the owner model described in `20260922130000_user_accounts_and_ownership.sql`
-- -- and after this migration the hole is the size of a share page's render,
-- rather than the size of a table row.
--
-- `authenticated` gets them too: a signed-in user opening someone else's link
-- is the same operation, and routing it through an owner-scoped path instead
-- would make a share behave differently depending on whether you happen to be
-- logged in.

grant execute on function public.read_share(text)        to anon, authenticated;
grant execute on function public.record_share_view(text) to anon, authenticated;
grant execute on function public.resolve_share(text)     to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Verification (run against the ANON key, not a PAT)
-- ---------------------------------------------------------------------------
--
-- A PAT or service_role key proves nothing here: both bypass RLS and hold every
-- grant, so a leak test that passes under one is meaningless. Use the project's
-- anon key, the same credential a stranger with the link has.
--
--   curl -s "$SUPABASE_URL/rest/v1/rpc/read_share" \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     -H "authorization: Bearer $SUPABASE_ANON_KEY" \
--     -H 'content-type: application/json' \
--     -d '{"p_slug":"<a real slug>"}' \
--   | jq '
--       [ (has("hand")             | not)
--       , (has("source_text")      | not)
--       , (has("owner_id")         | not)
--       , (.phf.meta | has("rawText")          | not)
--       , (.phf.meta | has("originalFilename") | not)
--       , (.phf.meta | has("warnings")         | not)
--       , (.phf.meta | has("parsedAt")         | not)
--       ] | all'
--
-- Must print `true`. Then the same call against `rpc/resolve_share`, which must
-- also print `true` -- the deprecated wrapper is not a bypass.
