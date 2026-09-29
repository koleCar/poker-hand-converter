-- ============================================================================
-- Publishing a hand: published_hands, scrub_phf, publish_hand.
-- ============================================================================
--
-- F7 (#30, #31). The first thing on Rail that a stranger can read without a
-- link somebody handed them -- and so the first indexable content, months
-- before the forum exists.
--
-- ## Copy on publish, not a view
--
-- A `public_hands` view over `public.hands` loses on four counts:
--
--   1. It cannot fix `phf`. `hands.phf` carries `meta.rawText` -- the room's
--      verbatim text, every screen name in it -- and a view would need jsonb
--      surgery on every read of every row.
--   2. It ties a public URL's lifetime to a private row the owner may delete.
--   3. It cannot hold a per-publication anonymisation choice.
--   4. It cannot publish a hand that was never saved.
--
-- So publishing **copies**: `publish_hand()` reads the caller's own row, runs
-- the document through `scrub_phf()` *here, in SQL*, and inserts the result. A
-- client never sends the document it wants published -- a bug or a hostile
-- client could otherwise publish whatever it liked. The database is the
-- authority in this schema, and that includes what "anonymised" means.
--
-- ## What does not exist on the table, by construction
--
-- `source_text`, `hand_key`, `site_hand_id`, `table_name`, `player_names`,
-- `winners`, `tournament_id`, `played_at` and `source_filename` have no column
-- here. A to-the-second `played_at` next to the room and the exact stakes names
-- the table, and from the table, the players; `played_on` is a date. There is
-- no `player_names`, so "every published hand with villain X" is a query that
-- cannot be written (#31).
--
-- **A column that does not exist is only half the job**: every one of those
-- values also lives somewhere inside `phf`. `scrub_phf()` removes each of them
-- from the document too, and the CHECK constraints below reject a document that
-- still carries one -- so if the scrubber ever regresses, the insert fails
-- instead of publishing.
--
-- ## The room's terms (#31), encoded structurally
--
--   * Anonymised by default (`pseudonyms`). `as-imported` is a deliberate
--     choice the UI puts behind a warning.
--   * Raw room text is never published, in any mode.
--   * No bulk endpoint: one hand per call, 20 a day.
--   * No opponent-name search: the column does not exist.
--   * A per-room kill switch: `publish_blocked_sites`.
--   * A takedown path: the `hh-takedown` report reason arrives with the reports
--     table (#40), which is where a report can be stored at all.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. publish_mode
-- ---------------------------------------------------------------------------

do $enum$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'publish_mode'
  ) then
    create type public.publish_mode as enum ('pseudonyms', 'positions', 'as-imported');
  end if;
end;
$enum$;

comment on type public.publish_mode is
  'How names appear in a published hand. pseudonyms (default): Hero / Villain1..n. positions: Hero / the seat''s resolved position. as-imported: the screen names as the room printed them.';

-- ---------------------------------------------------------------------------
-- 2. phf_replace_names -- whole-token rename inside free text
-- ---------------------------------------------------------------------------
--
-- Action labels and showdown descriptions are prose. Parsers do not normally
-- put a name in them, but "normally" is not a guarantee a scrubber can lean
-- on, so every name is replaced wherever it appears as a whole token.
--
-- Whole-token, not substring: a player called `al` must not turn "calls" into
-- "cVillain2ls". A token boundary is anything that is not a letter, a digit or
-- an underscore -- the same characters a screen name is usually made of.
--
-- `p_map` is `{original: replacement}`. Longest names first, so `Bob` does not
-- eat the front of `Bobby`.

create or replace function public.phf_replace_names(p_text text, p_map jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := p_text;
  r record;
begin
  if p_text is null or p_map is null or p_map = '{}'::jsonb then
    return p_text;
  end if;
  for r in
    select key, value #>> '{}' as replacement
    from jsonb_each(p_map)
    where key <> '' and key <> value #>> '{}'
    order by char_length(key) desc, key
  loop
    v_text := regexp_replace(
      v_text,
      '(^|[^[:alnum:]_])' || regexp_replace(r.key, '([\\.^$|()\[\]{}*+?-])', '\\\1', 'g') || '(?=$|[^[:alnum:]_])',
      '\1' || replace(r.replacement, '\', '\\'),
      'g'
    );
  end loop;
  return v_text;
end;
$$;

revoke all on function public.phf_replace_names(text, jsonb) from public;
revoke execute on function public.phf_replace_names(text, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. scrub_phf
-- ---------------------------------------------------------------------------
--
-- Removed in **every** mode -- these are not names, they are provenance, and
-- each one is either the room's raw text or an identifier that points at the
-- table:
--
--   meta.rawText            the room's verbatim text                -> ''
--   meta.originalFilename   frequently a real name                  -> null
--   meta.warnings           messages quote source lines             -> []
--   meta.parsedAt           the uploader's session time             -> ''
--   meta.handId, handKey    the room's hand number (= site_hand_id) -> ''
--   meta.textStyle.headerPayload  the room's header line: tournament
--                           number, table, second-exact timestamp  -> removed
--   table.name              the table                               -> null
--   tournament.id           the tournament number (= tournament_id) -> ''
--   playedAt                to the second (= played_at)             -> null
--   actions[].rawLine       the room's line for the action          -> ''
--   actions[].sourceLine    a line number into that text            -> null
--   results.players[].raw   the room's summary line                 -> null
--   chipMovements[].raw     the room's line for a drop              -> null
--
-- Dropping the raw lines means a published hand can no longer be byte-round-
-- tripped back into the room's own text. **That is the point**: it is a hand
-- to discuss, not a hand history to re-import. `toStandardText()` generates a
-- canonical line wherever a raw one is missing.
--
-- Renamed per mode (`pseudonyms` / `positions`; `as-imported` keeps them):
-- `players[].name`, `actions[].player`, `actions[].label`,
-- `actions[].description`, `results.players[].player`,
-- `results.players[].handDescription`, `results.winners[].player`,
-- `game.straddles[].player`, `chipMovements[].fromPlayer`.
--
-- The hero is `Hero` in both anonymising modes. Villains are `Villain1..n` in
-- seat order, or their resolved position -- which is trustworthy even in rooms
-- whose own seat labels are not (`assignPositions` works from the button and
-- the blinds, not from what the room called anyone). A seat whose position is
-- unknown is `Seat<n>`.
--
-- `immutable`: same document and mode in, same document out.

create or replace function public.scrub_phf(p_phf jsonb, p_mode public.publish_mode default 'pseudonyms')
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_doc     jsonb := p_phf;
  v_map     jsonb := '{}'::jsonb;
  v_used    text[] := array[]::text[];
  v_villain integer := 0;
  v_name    text;
  r         record;
begin
  if p_phf is null or jsonb_typeof(p_phf) <> 'object' then
    return null;
  end if;

  -- The name map, in seat order.
  if p_mode <> 'as-imported' then
    for r in
      select p ->> 'name' as name,
             coalesce((p ->> 'isHero')::boolean, false) as is_hero,
             p ->> 'position' as position,
             p ->> 'seat' as seat
      from jsonb_array_elements(coalesce(p_phf -> 'players', '[]'::jsonb)) as p
      order by (p ->> 'seat')::integer nulls last
    loop
      if r.name is null or v_map ? r.name then
        continue;
      end if;
      if r.is_hero then
        v_name := 'Hero';
      elsif p_mode = 'positions' and r.position is not null then
        v_name := r.position;
      elsif p_mode = 'positions' then
        v_name := 'Seat' || coalesce(r.seat, '?');
      else
        v_villain := v_villain + 1;
        v_name := 'Villain' || v_villain;
      end if;
      -- Two heroes (never, but a parser bug is not a reason to merge two
      -- people into one) or two seats resolving to one position.
      if v_name = any (v_used) then
        v_name := v_name || '_' || coalesce(r.seat, '?');
      end if;
      v_used := v_used || v_name;
      v_map := v_map || jsonb_build_object(r.name, v_name);
    end loop;
  end if;

  -- meta
  v_doc := jsonb_set(v_doc, '{meta,rawText}', '""'::jsonb, true);
  v_doc := jsonb_set(v_doc, '{meta,originalFilename}', 'null'::jsonb, true);
  v_doc := jsonb_set(v_doc, '{meta,warnings}', '[]'::jsonb, true);
  v_doc := jsonb_set(v_doc, '{meta,parsedAt}', '""'::jsonb, true);
  v_doc := jsonb_set(v_doc, '{meta,handId}', '""'::jsonb, true);
  v_doc := jsonb_set(v_doc, '{meta,handKey}', '""'::jsonb, true);
  if jsonb_typeof(v_doc #> '{meta,textStyle}') = 'object' then
    v_doc := v_doc #- '{meta,textStyle,headerPayload}';
  end if;

  -- table, tournament, time
  if jsonb_typeof(v_doc -> 'table') = 'object' then
    v_doc := jsonb_set(v_doc, '{table,name}', 'null'::jsonb, true);
  end if;
  if jsonb_typeof(v_doc -> 'tournament') = 'object' then
    v_doc := jsonb_set(v_doc, '{tournament,id}', '""'::jsonb, true);
  end if;
  v_doc := jsonb_set(v_doc, '{playedAt}', 'null'::jsonb, true);

  -- players
  if jsonb_typeof(v_doc -> 'players') = 'array' then
    v_doc := jsonb_set(v_doc, '{players}', coalesce((
      select jsonb_agg(
        case when v_map ? (p ->> 'name')
             then jsonb_set(p, '{name}', v_map -> (p ->> 'name'))
             else p end
        order by o)
      from jsonb_array_elements(v_doc -> 'players') with ordinality as t(p, o)
    ), '[]'::jsonb));
  end if;

  -- actions
  if jsonb_typeof(v_doc -> 'actions') = 'array' then
    v_doc := jsonb_set(v_doc, '{actions}', coalesce((
      select jsonb_agg(
        (
          a
          || jsonb_build_object('rawLine', '', 'sourceLine', null)
          || case when v_map ? (a ->> 'player')
                  then jsonb_build_object('player', v_map -> (a ->> 'player'))
                  else '{}'::jsonb end
          || case when a ? 'label'
                  then jsonb_build_object('label', public.phf_replace_names(a ->> 'label', v_map))
                  else '{}'::jsonb end
          || case when jsonb_typeof(a -> 'description') = 'string'
                  then jsonb_build_object('description', public.phf_replace_names(a ->> 'description', v_map))
                  else '{}'::jsonb end
        )
        order by o)
      from jsonb_array_elements(v_doc -> 'actions') with ordinality as t(a, o)
    ), '[]'::jsonb));
  end if;

  -- results.players
  if jsonb_typeof(v_doc #> '{results,players}') = 'array' then
    v_doc := jsonb_set(v_doc, '{results,players}', coalesce((
      select jsonb_agg(
        (
          rp
          || jsonb_build_object('raw', null)
          || case when v_map ? (rp ->> 'player')
                  then jsonb_build_object('player', v_map -> (rp ->> 'player'))
                  else '{}'::jsonb end
          || case when jsonb_typeof(rp -> 'handDescription') = 'string'
                  then jsonb_build_object('handDescription', public.phf_replace_names(rp ->> 'handDescription', v_map))
                  else '{}'::jsonb end
        )
        order by o)
      from jsonb_array_elements(v_doc #> '{results,players}') with ordinality as t(rp, o)
    ), '[]'::jsonb));
  end if;

  -- results.winners
  if jsonb_typeof(v_doc #> '{results,winners}') = 'array' then
    v_doc := jsonb_set(v_doc, '{results,winners}', coalesce((
      select jsonb_agg(
        case when v_map ? (w ->> 'player')
             then jsonb_set(w, '{player}', v_map -> (w ->> 'player'))
             else w end
        order by o)
      from jsonb_array_elements(v_doc #> '{results,winners}') with ordinality as t(w, o)
    ), '[]'::jsonb));
  end if;

  -- game.straddles -- found by running every corpus hand through this
  -- function, not by reading the types: the kind of field a scrubber written
  -- from a list misses, and the reason `publish_hand` re-checks the output.
  if jsonb_typeof(v_doc #> '{game,straddles}') = 'array' then
    v_doc := jsonb_set(v_doc, '{game,straddles}', coalesce((
      select jsonb_agg(
        case when v_map ? (st ->> 'player')
             then jsonb_set(st, '{player}', v_map -> (st ->> 'player'))
             else st end
        order by o)
      from jsonb_array_elements(v_doc #> '{game,straddles}') with ordinality as t(st, o)
    ), '[]'::jsonb));
  end if;

  -- chipMovements
  if jsonb_typeof(v_doc -> 'chipMovements') = 'array' then
    v_doc := jsonb_set(v_doc, '{chipMovements}', coalesce((
      select jsonb_agg(
        (
          m
          || jsonb_build_object('raw', null)
          || case when v_map ? (m ->> 'fromPlayer')
                  then jsonb_build_object('fromPlayer', v_map -> (m ->> 'fromPlayer'))
                  else '{}'::jsonb end
        )
        order by o)
      from jsonb_array_elements(v_doc -> 'chipMovements') with ordinality as t(m, o)
    ), '[]'::jsonb));
  end if;

  return v_doc;
end;
$$;

revoke all on function public.scrub_phf(jsonb, public.publish_mode) from public;
revoke execute on function public.scrub_phf(jsonb, public.publish_mode) from anon, authenticated;

comment on function public.scrub_phf(jsonb, public.publish_mode) is
  'The document a published hand stores: provenance stripped in every mode, names replaced per mode. See the header of 20261012090000_forum_publishing.sql for the full list.';

-- The invariants the table's CHECK constraints hold a document to. One
-- function, so the constraint and the tests state the rule once.
create or replace function public.phf_is_scrubbed(p_phf jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(p_phf) = 'object'
    and coalesce(p_phf #>> '{meta,rawText}', '') = ''
    and coalesce(p_phf #>> '{meta,originalFilename}', '') = ''
    and coalesce(jsonb_array_length(case when jsonb_typeof(p_phf #> '{meta,warnings}') = 'array'
                                         then p_phf #> '{meta,warnings}' else '[]'::jsonb end), 0) = 0
    and coalesce(p_phf #>> '{meta,parsedAt}', '') = ''
    and coalesce(p_phf #>> '{meta,handId}', '') = ''
    and coalesce(p_phf #>> '{meta,handKey}', '') = ''
    and (p_phf #> '{meta,textStyle,headerPayload}') is null
    and coalesce(p_phf #>> '{table,name}', '') = ''
    and coalesce(p_phf #>> '{tournament,id}', '') = ''
    and coalesce(p_phf #>> '{playedAt}', '') = ''
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_phf -> 'actions') = 'array'
                                              then p_phf -> 'actions' else '[]'::jsonb end) a
      where coalesce(a ->> 'rawLine', '') <> ''
    )
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_phf #> '{results,players}') = 'array'
                                              then p_phf #> '{results,players}' else '[]'::jsonb end) rp
      where coalesce(rp ->> 'raw', '') <> ''
    )
    and not exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_phf -> 'chipMovements') = 'array'
                                              then p_phf -> 'chipMovements' else '[]'::jsonb end) m
      where coalesce(m ->> 'raw', '') <> ''
    );
$$;

revoke all on function public.phf_is_scrubbed(jsonb) from public;
revoke execute on function public.phf_is_scrubbed(jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. publish_blocked_sites -- the per-room kill switch
-- ---------------------------------------------------------------------------
--
-- If a room objects, `insert into public.publish_blocked_sites (site, reason)`
-- stops new publications from it in one statement. Existing ones are a
-- moderation decision (`status = 'removed'`), not something to do silently.

create table if not exists public.publish_blocked_sites (
  site       text primary key check (site = lower(site) and char_length(site) between 1 and 64),
  reason     text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

alter table public.publish_blocked_sites enable row level security;
revoke all on public.publish_blocked_sites from anon, authenticated;

comment on table public.publish_blocked_sites is
  'Rooms whose hands may not be published. A row here is checked by publish_hand(). Sealed; service role only.';

-- ---------------------------------------------------------------------------
-- 5. published_hands
-- ---------------------------------------------------------------------------

create table if not exists public.published_hands (
  id        uuid primary key default gen_random_uuid(),
  -- The address: `/p/<public_id>`. Ten characters from the share alphabet,
  -- generated server-side (`generate_share_slug`) so a caller cannot choose
  -- or enumerate one.
  public_id text not null
    constraint published_hands_public_id_ok check (public_id ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{10}$'),

  -- Public on purpose: authorship of a published hand is the point of
  -- publishing it. `on delete set null`, not cascade -- a deleted account
  -- anonymises its authorship rather than pulling hands out from under the
  -- threads that will discuss them (F8).
  author_id uuid references auth.users (id) on delete set null,

  mode  public.publish_mode not null,
  title text constraint published_hands_title_len
    check (title is null or char_length(btrim(title)) between 1 and 140),

  -- The scrubbed document. Nothing else on this row is the source of truth.
  phf jsonb not null
    constraint published_hands_phf_scrubbed check (public.phf_is_scrubbed(phf))
    constraint published_hands_phf_size check (pg_column_size(phf) <= 1048576),

  -- The search/listing layer, copied from the private row at publish time.
  -- Every column here is something the page shows anyway. The ones that
  -- identify a table or a player are not here -- see the file header.
  site                 text not null,
  variant              text,
  limit_type           text,
  game_format          public.game_format not null default 'cash',
  currency             text,
  currency_minor_units smallint,
  currency_symbol      text,
  small_blind          bigint,
  big_blind            bigint,
  ante                 bigint,
  stakes_label         text,
  max_seats            smallint,
  player_count         smallint,
  fast_fold            text,
  site_anonymization   public.site_anonymization not null default 'none',
  hero_position        text,
  hero_cards           text[] not null default '{}',
  hero_hand_class      text,
  board_cards          text[] not null default '{}',
  street_reached       text,
  went_to_showdown     boolean,
  total_pot            bigint,
  hero_profit          bigint,
  -- A date, never a timestamp. See the header.
  played_on            date,

  -- Moderation (F10) and the owner's own delete. Soft, so a URL that has been
  -- linked says "removed" instead of 404ing into a mystery.
  status     text not null default 'visible'
    constraint published_hands_status_ok check (status in ('visible', 'removed')),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists published_hands_public_id_uidx
  on public.published_hands (public_id);

-- A profile's list, newest first. Partial on the visibility predicate, so the
-- query has to repeat it verbatim to use it.
create index if not exists published_hands_author_idx
  on public.published_hands (author_id, created_at desc)
  where status = 'visible' and deleted_at is null;

-- The sitemap and a future "latest hands" feed.
create index if not exists published_hands_recent_idx
  on public.published_hands (created_at desc)
  where status = 'visible' and deleted_at is null;

comment on table public.published_hands is
  'A hand somebody chose to make public: a scrubbed copy, never a view over hands. See 20261012090000_forum_publishing.sql.';

-- Which private row a publication came from. Its own sealed table rather than
-- a column on published_hands, so `select *` on the public table can never
-- hand out the private row's id, and so "have I published this already?" has
-- somewhere to live.
create table if not exists public.published_hand_sources (
  published_id uuid primary key references public.published_hands (id) on delete cascade,
  author_id    uuid not null references auth.users (id) on delete cascade,
  hand_id      uuid references public.hands (id) on delete set null
);

create unique index if not exists published_hand_sources_author_hand_uidx
  on public.published_hand_sources (author_id, hand_id)
  where hand_id is not null;

alter table public.published_hands        enable row level security;
alter table public.published_hand_sources enable row level security;

revoke all on public.published_hands        from anon, authenticated;
revoke all on public.published_hand_sources from anon, authenticated;

-- Readable by everyone while visible: that is what published means. No
-- INSERT/UPDATE/DELETE grant -- publish_hand and unpublish_hand are the only
-- writes, and they are definer functions that cannot be aimed.
grant select on public.published_hands to anon, authenticated;

drop policy if exists published_hands_public_select on public.published_hands;
create policy published_hands_public_select on public.published_hands
  for select to anon, authenticated
  using (status = 'visible' and deleted_at is null);

-- ---------------------------------------------------------------------------
-- 6. publish_hand
-- ---------------------------------------------------------------------------
--
-- `security definer` -- the same shape and the same trap as `create_share`:
-- RLS on `hands` does not apply inside it, so the ownership check is written
-- out, and a hand that is not yours gets **the same error as one that does not
-- exist**, so the function is not an oracle for which hand ids exist.
--
-- Order of refusals:
--
--   1. signed out;
--   2. `posting_block_reason()` -- publishing puts something in front of
--      strangers, so it is posting;
--   3. no such hand / not yours (one sentence for both);
--   4. the room is on the kill switch;
--   5. 20 a day.
--
-- The limit comes last on purpose. A refusal raises, and a raise rolls the
-- counter back with it, so only a hand that actually gets published is
-- counted -- which is what "20 a day" should mean.
--
-- Publishing the same hand twice returns the first publication rather than
-- making a second: a double click must not put two copies in the world.
--
-- **The last line of defence** is the leak assertion before the insert. In an
-- anonymising mode, no original screen name may survive anywhere in the
-- scrubbed document as a whole token -- if one does, something upstream
-- (a new parser, a new PHF field) put a name where `scrub_phf` does not look,
-- and the right response is to refuse the publication and say so, not to
-- publish it. Skipped for `positional` rooms, whose "names" are rotating
-- position labels that the document legitimately still contains as positions.

create or replace function public.publish_hand(
  p_hand_id uuid,
  p_mode    public.publish_mode default 'pseudonyms',
  p_title   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_block     text;
  v_hand      public.hands%rowtype;
  v_existing  text;
  v_doc       jsonb;
  v_doc_text  text;
  v_title     text := nullif(btrim(coalesce(p_title, '')), '');
  v_public_id text;
  v_id        uuid;
  v_attempt   integer := 0;
  r           record;
begin
  if v_uid is null then
    raise exception 'You must be signed in to publish a hand.' using errcode = '42501';
  end if;

  v_block := public.posting_block_reason(v_uid);
  if v_block is not null then
    raise exception '%', v_block using errcode = '22023';
  end if;

  select * into v_hand from public.hands h where h.id = p_hand_id and h.owner_id = v_uid;
  if not found then
    raise exception 'That hand does not exist.' using errcode = '22023';
  end if;

  if exists (select 1 from public.publish_blocked_sites b where b.site = lower(v_hand.site)) then
    raise exception 'Hands from this poker room cannot be published.' using errcode = '22023';
  end if;

  if v_title is not null and char_length(v_title) > 140 then
    raise exception 'Titles are at most 140 characters.' using errcode = '22023';
  end if;

  -- Idempotent: the same hand, published again, is the same publication.
  select p.public_id into v_existing
  from public.published_hand_sources s
  join public.published_hands p on p.id = s.published_id
  where s.author_id = v_uid and s.hand_id = v_hand.id
    and p.deleted_at is null;
  if found then
    return jsonb_build_object('publicId', v_existing, 'alreadyPublished', true);
  end if;

  v_doc := public.scrub_phf(v_hand.phf, p_mode);
  if v_doc is null or not public.phf_is_scrubbed(v_doc) then
    raise exception 'This hand could not be prepared for publishing.' using errcode = '22023';
  end if;

  -- The leak assertion. See the function header.
  if p_mode <> 'as-imported' and v_hand.site_anonymization <> 'positional' then
    -- Every string value in the document, decoded -- not `v_doc::text`, where
    -- a name containing a quote or a backslash would be JSON-escaped and the
    -- search would sail past it.
    select string_agg(v #>> '{}', E'\n') into v_doc_text
    from jsonb_path_query(v_doc, 'strict $.** ? (@.type() == "string")') as v;
    v_doc_text := coalesce(v_doc_text, '');
    for r in
      select p ->> 'name' as name
      from jsonb_array_elements(coalesce(v_hand.phf -> 'players', '[]'::jsonb)) p
    loop
      if r.name is null or r.name in ('Hero') or r.name ~ '^(Villain|Seat)[0-9]+(_[0-9]+)?$' then
        continue;
      end if;
      if v_doc_text ~ ('(^|[^[:alnum:]_])'
                       || regexp_replace(r.name, '([\\.^$|()\[\]{}*+?-])', '\\\1', 'g')
                       || '($|[^[:alnum:]_])') then
        raise exception 'This hand could not be anonymised safely, so it was not published. Nothing was made public.'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  perform public.enforce_rate_limit('publish:' || v_uid::text, 1, 20, interval '1 day');

  loop
    v_attempt := v_attempt + 1;
    v_public_id := public.generate_share_slug(10);
    begin
      insert into public.published_hands (
        public_id, author_id, mode, title, phf,
        site, variant, limit_type, game_format, currency, currency_minor_units, currency_symbol,
        small_blind, big_blind, ante, stakes_label, max_seats, player_count, fast_fold,
        site_anonymization, hero_position, hero_cards, hero_hand_class, board_cards,
        street_reached, went_to_showdown, total_pot, hero_profit, played_on
      ) values (
        v_public_id, v_uid, p_mode, v_title, v_doc,
        v_hand.site, v_hand.variant, v_hand.limit_type, v_hand.game_format, v_hand.currency,
        v_hand.currency_minor_units, v_hand.currency_symbol,
        v_hand.small_blind, v_hand.big_blind, v_hand.ante, v_hand.stakes_label, v_hand.max_seats,
        v_hand.player_count, v_hand.fast_fold,
        v_hand.site_anonymization, v_hand.hero_position, v_hand.hero_cards, v_hand.hero_hand_class,
        v_hand.board_cards, v_hand.street_reached, v_hand.went_to_showdown, v_hand.total_pot,
        v_hand.hero_profit, (v_hand.played_at at time zone 'UTC')::date
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.published_hand_sources (published_id, author_id, hand_id)
  values (v_id, v_uid, v_hand.id);

  return jsonb_build_object('publicId', v_public_id, 'alreadyPublished', false);
end;
$$;

revoke all on function public.publish_hand(uuid, public.publish_mode, text) from public;
revoke execute on function public.publish_hand(uuid, public.publish_mode, text) from anon;
grant execute on function public.publish_hand(uuid, public.publish_mode, text) to authenticated;

comment on function public.publish_hand(uuid, public.publish_mode, text) is
  'Publish one of your own hands as a scrubbed copy. Same error for "not yours" as for "no such hand". 20 a day. Idempotent per hand.';

-- ---------------------------------------------------------------------------
-- 7. unpublish_hand -- the owner's own soft delete
-- ---------------------------------------------------------------------------
--
-- Writes one column on one row, the caller's own, selected by public id.
-- Soft: the page then says the hand was removed by its author, instead of a
-- 404 that looks like a broken link.

create or replace function public.unpublish_hand(p_public_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  update public.published_hands
     set deleted_at = now()
   where public_id = p_public_id
     and author_id = v_uid
     and deleted_at is null;
  return found;
end;
$$;

revoke all on function public.unpublish_hand(text) from public;
revoke execute on function public.unpublish_hand(text) from anon;
grant execute on function public.unpublish_hand(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Reading
-- ---------------------------------------------------------------------------
--
-- `read_published_hand` names its keys, like `read_share`, and is `security
-- invoker`: the visibility policy decides what is visible, and this function
-- never restates it. The author comes from `profiles_public`, which is the
-- public surface of an account by definition.
--
-- A removed or deleted hand returns `{status}` with no document, so the page
-- can say "removed" rather than "never existed" -- the difference matters to
-- anyone who followed a link -- while the content itself is gone. That one
-- fact comes from a definer helper, because the invoker read cannot see the
-- row at all.

create or replace function public.published_hand_status(p_public_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p.deleted_at is not null then 'deleted'
           when p.status <> 'visible'    then 'removed'
           else 'visible'
         end
  from public.published_hands p
  where p.public_id = p_public_id;
$$;

revoke all on function public.published_hand_status(text) from public;
grant execute on function public.published_hand_status(text) to anon, authenticated;

create or replace function public.read_published_hand(p_public_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v jsonb;
  v_status text;
begin
  if p_public_id !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{10}$' then
    return null;
  end if;

  select jsonb_build_object(
           'status', 'visible',
           'publicId', p.public_id,
           'title', p.title,
           'mode', p.mode,
           'phf', p.phf,
           'site', p.site,
           'stakesLabel', p.stakes_label,
           'gameFormat', p.game_format,
           'heroPosition', p.hero_position,
           'playedOn', p.played_on,
           'createdAt', p.created_at,
           'author', case when a.id is null then null
                          else jsonb_build_object('username', a.username) end
         )
    into v
  from public.published_hands p
  left join public.profiles_public a on a.id = p.author_id
  where p.public_id = p_public_id;

  if v is not null then
    return v;
  end if;

  v_status := public.published_hand_status(p_public_id);
  if v_status is null then
    return null;
  end if;
  return jsonb_build_object('status', v_status, 'publicId', p_public_id);
end;
$$;

revoke all on function public.read_published_hand(text) from public;
grant execute on function public.read_published_hand(text) to anon, authenticated;

-- A profile's published hands, newest first, keyset-paginated on created_at.
create or replace function public.published_hands_by_author(
  p_username text,
  p_limit    integer default 20,
  p_before   timestamptz default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."createdAt" desc), '[]'::jsonb)
  from (
    select p.public_id    as "publicId",
           p.title        as "title",
           p.site         as "site",
           p.stakes_label as "stakesLabel",
           p.hero_position as "heroPosition",
           p.hero_cards   as "heroCards",
           p.board_cards  as "boardCards",
           p.played_on    as "playedOn",
           p.created_at   as "createdAt"
    from public.published_hands p
    join public.profiles_public a on a.id = p.author_id
    where a.username_lower = lower(p_username)
      and p.status = 'visible' and p.deleted_at is null
      and (p_before is null or p.created_at < p_before)
    order by p.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) x;
$$;

revoke all on function public.published_hands_by_author(text, integer, timestamptz) from public;
grant execute on function public.published_hands_by_author(text, integer, timestamptz) to anon, authenticated;

-- Which of my stored hands are already published -- so the library can say
-- "published" instead of offering the button again. Caller only.
create or replace function public.my_published_hand_ids(p_hand_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(s.hand_id::text, p.public_id), '{}'::jsonb)
  from public.published_hand_sources s
  join public.published_hands p on p.id = s.published_id
  where s.author_id = (select auth.uid())
    and s.hand_id = any ((coalesce(p_hand_ids, '{}'::uuid[]))[1:500])
    and p.deleted_at is null;
$$;

revoke all on function public.my_published_hand_ids(uuid[]) from public;
revoke execute on function public.my_published_hand_ids(uuid[]) from anon;
grant execute on function public.my_published_hand_ids(uuid[]) to authenticated;

commit;
