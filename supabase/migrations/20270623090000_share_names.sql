-- ============================================================================
-- Share links hide the players' names unless the owner says otherwise (R4.5).
-- ============================================================================
--
-- `20261003090000_share_projection.sql` left the names in on purpose: "a
-- replayer with the names blanked out is not the feature anyone asked to
-- share". Rail's plan (R4.5) reverses that default. A share link travels -
-- into group chats, forums, screenshots - and every opponent in the hand is a
-- person who never agreed to be shown there under their screen name. The
-- published-hand path (`publish_hand`, F7) already anonymises by default
-- (`pseudonyms`); a share link was the one public door that did not.
--
-- ## What changes
--
--   * `shares.show_names boolean not null default false`. **Every existing
--     share becomes anonymised.** No earlier column or setting expressed a
--     choice about names (`spoilers` is about the result, and its own comment
--     says it redacts nothing), so there is no explicit opt-in to honour; the
--     owner can turn names back on per link (`set_share_names`).
--   * `read_share` (and through it the deprecated `resolve_share`, and so
--     `/h/:slug`, `/embed/h/:slug` and the page's metadata) returns, while
--     `show_names` is false:
--       - `phf` through `scrub_phf(.., 'pseudonyms')` - the forum's one
--         definition of an anonymised hand: Hero, Villain1..n in seat order;
--         the room's raw lines, table name, tournament id, the room's hand
--         number and the exact time removed (each of those names the table,
--         and the table names the players);
--       - `standardText` null - the stored text is the room's dialect with
--         every name in it, and a text cannot be scrubbed without the
--         document; the page renders the scrubbed `phf`;
--       - `title` null - free text the sharing client wrote; today's client
--         writes no name into it, but a stranger's page does not need it and
--         an old or hostile client could have;
--       - the publish path's last line of defence: if any original screen
--         name still appears as a whole token in any string of the scrubbed
--         document, `phf` is null too (the page says the hand cannot be
--         shown) - fail closed, never publish a name the scrubber missed.
--     With `show_names` true the payload is exactly as before
--     (`phf_redact_private`, the stored text).
--   * `create_share` takes `p_show_names` (default false), so a sharer can
--     choose at creation; `share_names_state` / `set_share_names` are the
--     owner's switch afterwards. Owner only, and "not yours" reads like "no
--     such link".
--
-- Additive: new file, nothing earlier edited; `create_share` and `read_share`
-- recreated in full so the body that decides what a stranger sees is read in
-- one place.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table public.shares
  add column if not exists show_names boolean not null default false;

comment on column public.shares.show_names is
  'Whether this link shows the players'' screen names. Default false (R4.5): read_share returns the hand through scrub_phf(pseudonyms) - Hero, Villain1..n, no table, hand number or exact time - and no standard text. Set by the owner only (create_share p_show_names, set_share_names).';

-- ---------------------------------------------------------------------------
-- 2. share_anonymised_phf -- the scrubbed document, or null if a name survives
-- ---------------------------------------------------------------------------
--
-- `scrub_phf` plus the leak assertion `publish_hand` runs before an insert,
-- stated once here for the share path. Positional rooms
-- (`phf_site_anonymization`) are not checked, as `publish_hand` does not
-- check them; elsewhere a name equal to the player's own position label is
-- skipped, as is anything already in the scrubber's vocabulary.
--
-- Over the whole corpus (`tests/scripts/scrub-corpus`, 8 367 hands, R4.5)
-- this returns a document for every hand.

create or replace function public.share_anonymised_phf(p_phf jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_doc      jsonb;
  v_doc_text text;
  r          record;
begin
  if p_phf is null or jsonb_typeof(p_phf) <> 'object' then
    return null;
  end if;

  v_doc := public.scrub_phf(p_phf, 'pseudonyms');
  if v_doc is null or not public.phf_is_scrubbed(v_doc) then
    return null;
  end if;

  -- A positional room's "names" (Ignition's `Dealer`, `Small Blind`,
  -- `UTG+2`) are per-hand seat labels, not people, and the document keeps
  -- them as positions and in its prose; `publish_hand` skips these rooms for
  -- the same reason. Same classifier as the stored row's column.
  if public.phf_site_anonymization(p_phf) = 'positional' then
    return v_doc;
  end if;

  -- Every string value in the document, decoded (not `v_doc::text`, where a
  -- quote or a backslash in a name would be JSON-escaped and slip past).
  select string_agg(v #>> '{}', E'\n') into v_doc_text
  from jsonb_path_query(v_doc, 'strict $.** ? (@.type() == "string")') as v;
  v_doc_text := coalesce(v_doc_text, '');

  for r in
    select p ->> 'name' as name, p ->> 'position' as position
    from jsonb_array_elements(case when jsonb_typeof(p_phf -> 'players') = 'array'
                                   then p_phf -> 'players' else '[]'::jsonb end) p
  loop
    if r.name is null or r.name = '' or r.name = 'Hero'
       or r.name ~ '^(Villain|Seat)[0-9]+(_[0-9]+)?$'
       or r.name = r.position then
      continue;
    end if;
    if v_doc_text ~ ('(^|[^[:alnum:]_])'
                     || regexp_replace(r.name, '([\\.^$|()\[\]{}*+?-])', '\\\1', 'g')
                     || '($|[^[:alnum:]_])') then
      return null;
    end if;
  end loop;

  return v_doc;
end;
$$;

revoke all on function public.share_anonymised_phf(jsonb) from public;
revoke execute on function public.share_anonymised_phf(jsonb) from anon, authenticated;

comment on function public.share_anonymised_phf(jsonb) is
  'A share''s hand without names: scrub_phf(pseudonyms), or null when any original screen name still appears as a whole token in the result (fail closed). Internal to read_share.';

-- ---------------------------------------------------------------------------
-- 3. create_share -- p_show_names, default false
-- ---------------------------------------------------------------------------
--
-- Recreated from `20261004120000_share_spoilers.sql` with `p_show_names`
-- appended. The five-argument function is dropped for the reason that file
-- gives (two overloads make PostgREST guess); a client built before this
-- migration still binds, and its links are anonymised.

drop function if exists public.create_share(uuid, jsonb, text, text, boolean);

create or replace function public.create_share(
  p_hand_id       uuid    default null,
  p_phf           jsonb   default null,
  p_standard_text text    default null,
  p_title         text    default null,
  p_spoilers      boolean default false,
  p_show_names    boolean default false
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
      insert into public.shares (slug, hand_id, phf, standard_text, title, owner_id, spoilers, show_names)
      values (
        v_slug,
        p_hand_id,
        v_phf,
        v_text,
        nullif(btrim(coalesce(p_title, '')), ''),
        v_owner,
        coalesce(p_spoilers, false),
        -- An explicit null is "no choice made", which is hidden.
        coalesce(p_show_names, false)
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_slug := null;
    end;
  end loop;

  if v_id is null then
    raise exception 'Could not allocate a unique share slug' using errcode = '53400';
  end if;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'showNames', coalesce(p_show_names, false));
end;
$$;

revoke all on function public.create_share(uuid, jsonb, text, text, boolean, boolean) from public;
revoke execute on function public.create_share(uuid, jsonb, text, text, boolean, boolean) from anon;
grant  execute on function public.create_share(uuid, jsonb, text, text, boolean, boolean) to authenticated;

comment on function public.create_share(uuid, jsonb, text, text, boolean, boolean) is
  'Creates a share link owned by the caller. Requires a session, and refuses hand ids the caller does not own. p_spoilers (default false) governs whether the unfurl may reveal the result (#23); p_show_names (default false) whether the link shows screen names (R4.5). The slug resolves for anyone.';

-- ---------------------------------------------------------------------------
-- 4. read_share -- anonymised unless the owner opted in
-- ---------------------------------------------------------------------------
--
-- Body of `20261004120000_share_spoilers.sql` §3 with the names rule. Still
-- `stable`, still explicitly projected, still granted to anon: the slug is
-- the capability, the projection the control.

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

  if v_share.hand_id is not null then
    select h.phf, h.standard_text
      into v_phf, v_text
      from public.hands h
     where h.id = v_share.hand_id;
  end if;

  v_phf := coalesce(v_phf, v_share.phf);

  if v_share.show_names then
    -- The owner chose to show names: the payload as before R4.5.
    v_phf  := public.phf_redact_private(v_phf);
    v_text := coalesce(v_text, v_share.standard_text);
  else
    -- The default. No stored text (the room's dialect, every name in it),
    -- the document through the forum's scrubber, nothing if a name survives.
    v_phf  := public.share_anonymised_phf(v_phf);
    v_text := null;
  end if;

  return jsonb_build_object(
    'slug',         v_share.slug,
    'title',        case when v_share.show_names then v_share.title end,
    'spoilers',     v_share.spoilers,
    'showNames',    v_share.show_names,
    'views',        v_share.views,
    'createdAt',    v_share.created_at,
    'handId',       v_share.hand_id,
    'phf',          v_phf,
    'standardText', v_text
  );
end;
$$;

revoke all on function public.read_share(text) from public;
grant execute on function public.read_share(text) to anon, authenticated;

comment on function public.read_share(text) is
  'Resolves a share slug to exactly what a share page renders: slug, title, spoilers, showNames, views, createdAt, handId, phf, standardText. Unless the owner opted in (shares.show_names), phf is scrub_phf(pseudonyms) - or null if a name survives - and title and standardText are null (R4.5). No side effects. Null for unknown and malformed slugs alike.';

-- ---------------------------------------------------------------------------
-- 5. The owner's switch
-- ---------------------------------------------------------------------------
--
-- Keyed by slug, answered only for the link's owner. Anyone else - another
-- account, a slug that does not exist, a malformed one - gets null from the
-- state and the same error from the setter, so neither is an oracle for whose
-- link a slug is.

create or replace function public.share_names_state(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_show boolean;
begin
  if v_uid is null or p_slug is null or p_slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$' then
    return null;
  end if;
  select s.show_names into v_show from public.shares s where s.slug = p_slug and s.owner_id = v_uid;
  if not found then
    return null;
  end if;
  return jsonb_build_object('slug', p_slug, 'showNames', v_show);
end;
$$;

create or replace function public.set_share_names(p_slug text, p_show boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_show boolean;
begin
  if v_uid is null then
    raise exception 'You must be signed in to change a share link.' using errcode = '42501';
  end if;
  if p_show is null then
    raise exception 'Say whether the link shows names.' using errcode = '22023';
  end if;
  update public.shares s
     set show_names = p_show
   where p_slug ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$'
     and s.slug = p_slug
     and s.owner_id = v_uid
  returning s.show_names into v_show;
  if not found then
    raise exception 'That share link does not exist.' using errcode = '22023';
  end if;
  return jsonb_build_object('slug', p_slug, 'showNames', v_show);
end;
$$;

revoke all on function public.share_names_state(text) from public;
revoke all on function public.set_share_names(text, boolean) from public;
revoke execute on function public.share_names_state(text) from anon;
revoke execute on function public.set_share_names(text, boolean) from anon;
grant execute on function public.share_names_state(text) to authenticated;
grant execute on function public.set_share_names(text, boolean) to authenticated;

comment on function public.share_names_state(text) is
  'The caller''s own share link''s names setting ({slug, showNames}); null for a link that is not the caller''s, unknown or malformed.';
comment on function public.set_share_names(text, boolean) is
  'The owner''s switch: whether this share link shows screen names (R4.5). Raises the same error for a link that is not the caller''s and one that does not exist.';

commit;
