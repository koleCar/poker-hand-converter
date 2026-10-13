-- Rail R1.8: Supabase for desktop ingest (docs/RAIL-PLAN.md R1.8, amendments
-- A4 and A5; owner decision Q4 of 2026-10-13).
--
-- What the desktop app sends, and what it does not
-- -------------------------------------------------
-- Q4: a hand synced from the desktop is **PHF only** - no `standard_text`
-- (it is derived from the PHF whenever the web needs it) and no
-- `source_text` (the original files stay on the user's disk, and the PHF's
-- own copy of them, `meta.rawText`, is sent empty). A row is about 3.6 KB a
-- hand instead of ~7.3 KB (measured on the corpus). Per-seat statistics go through the existing
-- `save_hand_stats`; until the Rust stats engine exists (R2.1) the web's
-- `/api/stats/rebuild` derives them from the PHF, as it does for web rows.
--
-- So `hands` gains `origin` (`web` / `desktop`), `standard_text` becomes
-- nullable **for desktop rows only**, and a CHECK holds the rule for every
-- writer: a web row has its standard text; a desktop row has no standard
-- text, no source text and an empty `meta.rawText`, and a PHF of at most
-- 256 KiB.
--
-- The search columns are derived here, not sent
-- ---------------------------------------------
-- `ingest_hands` takes `{hand_key, phf}` and derives every denormalised
-- search column itself, with `hand_row_from_phf()`: the SQL twin of the web's
-- `handInsertFromPhf` (frontend/src/lib/db/mapping.ts, with
-- `detectAnonymization` and `handClass`). Why not let the client send them,
-- as `save_hands` does:
--   * the server can then guarantee them - a desktop row's columns are a
--     function of its PHF, whichever client sent it, which is the rule
--     `hands.fast_fold` already follows (20261005090000);
--   * the desktop needs no third copy of the mapping in Rust (TypeScript,
--     SQL and Rust would drift; two are held together by a test);
--   * a later column is one migration plus a backfill from `phf`, with no
--     app release.
-- The two mappings are held together by a parity test over the whole corpus
-- (7 496 distinct hands of the 8 422, `npm run desktop-ingest:parity` in tests/, against a local
-- stack) and, in CI, by `supabase/tests/database/desktop_ingest_parity.test.sql`,
-- generated from the same script: every hand there is saved through
-- `save_hands` with the TypeScript row and through `ingest_hands` with only
-- its PHF, and every search column must come out equal.
--
-- Security
-- --------
-- `ingest_hands` and `register_hand_source` are `security definer`: the
-- owner is `auth.uid()`, written explicitly; the source is checked to be the
-- caller's; every row is validated before the single insert; the budget is
-- spent first. The direct-insert path (`save_hands`, invoker, and PostgREST
-- itself) can only write `origin = 'web'` rows now: the insert policy says
-- so. No client gets UPDATE or DELETE on anything here.
--
-- Rate limits
-- -----------
-- The web's `hands_insert` bucket is **global** (25 000 rows / 10 min for
-- everyone together). A desktop backfill of 500 000 hands would hold it for
-- three hours and lock every web user out, so desktop rows no longer count
-- against it; they spend two **per-account** buckets instead, charged by
-- `ingest_hands` for every row received (duplicates and rejections too, so
-- a replay loop is bounded as well):
--   desktop_ingest:<uid>      150 000 rows / 10 minutes
--   desktop_ingest_day:<uid> 2 000 000 rows / day
-- 150 000 per 10 minutes is 250 hands a second: a 500 000-hand backfill
-- needs at least 34 minutes, a million 67; one client sending batches of
-- 500 measured ~400 hands a second locally, so this is what binds. The daily cap
-- bounds what one account can store in a day (~7 GB at ~3.6 KB a hand). No
-- global desktop bucket: every call from every account would queue on one
-- counter row, and one account's backfill would stop everyone else's.

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

create type public.hand_origin as enum ('web', 'desktop');

-- `folder`: a folder watched by the desktop app on one device. `web`: hands
-- uploaded through the web (R4.2 registers those; nothing does yet).
create type public.hand_source_kind as enum ('folder', 'web');

-- ---------------------------------------------------------------------------
-- 2. hands: origin, and standard_text for web rows only
-- ---------------------------------------------------------------------------

-- A constant default: metadata only, no table rewrite. Every existing row is
-- a web row.
alter table public.hands
  add column origin public.hand_origin not null default 'web';

comment on column public.hands.origin is
  'Which client wrote the row: web (save_hands) or desktop (ingest_hands, R1.8). A desktop row has no standard_text or source_text and an empty meta.rawText (Q4).';

alter table public.hands
  alter column standard_text drop not null;

comment on column public.hands.standard_text is
  'GG-style standard text rendered from phf, stored for web rows so Holdem Manager export never re-serializes. Null on desktop rows (Q4): readers derive it from phf with toStandardText.';

alter table public.hands
  add constraint hands_text_by_origin check (
    (origin = 'web' and standard_text is not null)
    or (origin = 'desktop'
        and standard_text is null
        and source_text is null
        and coalesce(phf -> 'meta' ->> 'rawText', '') = '')
  );

alter table public.hands
  add constraint hands_desktop_phf_size check (
    origin <> 'desktop' or octet_length(phf::text) <= 262144
  );

-- The direct path writes web rows only. `ingest_hands` (definer, runs as the
-- table owner, so RLS does not apply to it) is the one way a desktop row is
-- written; a client cannot insert one through PostgREST or `save_hands`.
drop policy if exists hands_owner_insert on public.hands;
create policy hands_owner_insert on public.hands
for insert to authenticated
with check (owner_id = (select auth.uid()) and origin = 'web');

-- The statement trigger: the 1 000-rows-per-statement cap stays for every
-- row; the global `hands_insert` budget is charged for web rows only.
-- Desktop rows are charged per account by `ingest_hands` (header).
create or replace function public.hands_rate_limit()
returns trigger
language plpgsql
-- security definer: unchanged reason - `enforce_rate_limit` is not
-- executable by clients. Reads nothing but the transition table and passes
-- fixed arguments.
security definer
set search_path = ''
as $$
declare
  v_rows integer;
  v_web  integer;
begin
  select count(*), count(*) filter (where origin = 'web')
    into v_rows, v_web
    from inserted;

  if v_rows > 1000 then
    raise exception 'Batch too large: % rows in one statement (max 1000).', v_rows
      using errcode = '53400';
  end if;

  -- 25 000 web hands / 10 min, globally. A 5000-hand upload is 5 000.
  perform public.enforce_rate_limit('hands_insert', v_web, 25000, interval '10 minutes');
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. hand_sources
-- ---------------------------------------------------------------------------
--
-- One row per place hands come from: a folder the desktop app watches on one
-- device, or (later) the account's web uploads. Status counters only - the
-- rows in `hands` do not point here (16 bytes a hand for a link nobody reads
-- yet; `hands.origin` is what the pull in R1.9 needs).
--
-- What it does **not** hold: the folder's path. A path names the user's home
-- directory and account folders; the app sends a label (the room and the
-- folder's last component) and its own id for the folder, and a label with a
-- path separator is refused.

create table public.hand_sources (
  id              uuid primary key default extensions.gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  kind            public.hand_source_kind not null,
  -- A random id per installation of the app, and the app's own id for the
  -- folder (`sources.id` in its local store). Together with the owner they
  -- make registering a folder idempotent.
  device_id       uuid,
  local_id        text,
  device_name     text,
  label           text,
  site            text,
  hands_received  bigint not null default 0,
  hands_inserted  bigint not null default 0,
  hands_duplicate bigint not null default 0,
  hands_rejected  bigint not null default 0,
  -- The reason code of the most recent rejected hand, for the UI.
  last_rejection  text,
  last_ingest_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint hand_sources_folder_ids check (
    kind <> 'folder' or (device_id is not null and local_id is not null)),
  constraint hand_sources_web_ids check (
    kind <> 'web' or (device_id is null and local_id is null)),
  constraint hand_sources_local_id_len check (
    local_id is null or char_length(local_id) between 1 and 64),
  constraint hand_sources_device_name_len check (
    device_name is null or char_length(device_name) between 1 and 64),
  constraint hand_sources_label_ok check (
    label is null or (char_length(label) between 1 and 120 and label !~ '[/\\]')),
  constraint hand_sources_site_len check (
    site is null or char_length(site) between 1 and 64),
  constraint hand_sources_last_rejection_len check (
    last_rejection is null or char_length(last_rejection) <= 64),
  constraint hand_sources_counters_ok check (
    hands_received >= 0 and hands_inserted >= 0
    and hands_duplicate >= 0 and hands_rejected >= 0)
);

create unique index hand_sources_folder_uidx
  on public.hand_sources (owner_id, device_id, local_id)
  where kind = 'folder';

create unique index hand_sources_web_uidx
  on public.hand_sources (owner_id)
  where kind = 'web';

comment on table public.hand_sources is
  'Where a user''s hands come from (R1.8): a folder watched by the desktop app on one device, or web uploads. Status counters; no paths. Readable by its owner; written only by register_hand_source and ingest_hands.';

alter table public.hand_sources enable row level security;
revoke all on public.hand_sources from anon, authenticated;
grant select on public.hand_sources to authenticated;

create policy hand_sources_owner_select on public.hand_sources
for select to authenticated
using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. The mapping: PHF -> hands row (handInsertFromPhf in SQL)
-- ---------------------------------------------------------------------------

-- JavaScript's String.prototype.trim() whitespace, for `btrim(text, chars)`:
-- the ASCII set, no-break space, the Unicode spaces, line and paragraph
-- separators and the byte-order mark.
create or replace function public.phf_js_whitespace()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select chr(32) || chr(9) || chr(10) || chr(11) || chr(12) || chr(13)
      || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)
      || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)
      || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
      || chr(12288) || chr(65279);
$$;

-- A JSON array of strings as text[]; anything else (absent, null, an object)
-- as an empty array, which is what `?? []` gives in the TypeScript.
create or replace function public.phf_text_array(p_value jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'array'
      then array(select e from jsonb_array_elements_text(p_value) with ordinality as t(e, i) order by i)
    else '{}'::text[]
  end;
$$;

-- `formatAmount(amount, unit, style)` without thousands grouping
-- (frontend/src/lib/phf/types.ts): symbol plus digits; round amounts print
-- no decimals in either style; `fixed2` keeps two, `minimal` strips
-- trailing zeros.
create or replace function public.phf_format_amount(
  p_amount   bigint,
  p_symbol   text,
  p_minor    integer,
  p_decimals text
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_abs    bigint := abs(p_amount);
  v_digits text;
begin
  if p_amount is null then
    return null;
  end if;
  if p_minor = 1 then
    v_digits := v_abs::text;
  elsif v_abs % p_minor = 0 then
    v_digits := (v_abs / p_minor)::text;
  else
    v_digits := round(v_abs::numeric / p_minor, 2)::text;
    if p_decimals is distinct from 'fixed2' then
      v_digits := regexp_replace(regexp_replace(v_digits, '0+$', ''), '\.$', '');
    end if;
  end if;
  return case when p_amount < 0 then '-' else '' end || coalesce(p_symbol, '') || v_digits;
end;
$$;

-- `handClass(cards)` (frontend/src/lib/cards.ts): `AKs` / `AKo` / `TT` for
-- exactly two parseable cards, otherwise null.
create or replace function public.phf_hand_class(p_cards text[])
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  c_ranks constant text := '23456789TJQKA';
  v_a  text;
  v_b  text;
  v_ra text;
  v_rb text;
  v_sa text;
  v_sb text;
begin
  if p_cards is null or cardinality(p_cards) <> 2 then
    return null;
  end if;
  v_a := btrim(coalesce(p_cards[1], ''), public.phf_js_whitespace());
  v_b := btrim(coalesce(p_cards[2], ''), public.phf_js_whitespace());
  if char_length(v_a) <> 2 or char_length(v_b) <> 2 then
    return null;
  end if;
  v_ra := upper(left(v_a, 1));
  v_rb := upper(left(v_b, 1));
  v_sa := lower(right(v_a, 1));
  v_sb := lower(right(v_b, 1));
  if strpos(c_ranks, v_ra) = 0 or strpos(c_ranks, v_rb) = 0
     or v_sa not in ('s', 'h', 'd', 'c') or v_sb not in ('s', 'h', 'd', 'c') then
    return null;
  end if;
  if v_ra = v_rb then
    return v_ra || v_rb;
  end if;
  if strpos(c_ranks, v_ra) > strpos(c_ranks, v_rb) then
    return v_ra || v_rb || case when v_sa = v_sb then 's' else 'o' end;
  end if;
  return v_rb || v_ra || case when v_sa = v_sb then 's' else 'o' end;
end;
$$;

-- `detectAnonymization(hand)` (frontend/src/lib/db/anonymization.ts):
-- site registry, then the parser warning, then the structural fallback
-- (every villain name - at least two - a position label, or every one an
-- opaque token).
create or replace function public.phf_site_anonymization(p_phf jsonb)
returns public.site_anonymization
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_site  text := lower(btrim(coalesce(p_phf -> 'meta' ->> 'siteId', ''), public.phf_js_whitespace()));
  v_names text[];
  v_villains integer;
begin
  if v_site = 'ignition' then
    return 'positional';
  end if;
  if v_site = 'ggpoker' then
    return 'opaque-id';
  end if;
  if jsonb_typeof(p_phf -> 'meta' -> 'warnings') = 'array' and exists (
       select 1 from jsonb_array_elements(p_phf -> 'meta' -> 'warnings') as w
       where w ->> 'code' = 'numeric-player-ids') then
    return 'opaque-id';
  end if;

  select count(*),
         coalesce(array_agg(n) filter (where n <> ''), '{}'::text[])
    into v_villains, v_names
    from (
      select btrim(coalesce(p ->> 'name', ''), public.phf_js_whitespace()) as n
      from jsonb_array_elements(p_phf -> 'players') as p
      where p -> 'isHero' is distinct from 'true'::jsonb
    ) as villains;

  if v_villains < 2 or cardinality(v_names) < 2 then
    return 'none';
  end if;
  if not exists (
       select 1 from unnest(v_names) as n
       where n !~* '^(dealer|small blind|big blind|utg(\+[0-9]+)?)$') then
    return 'positional';
  end if;
  if not exists (
       select 1 from unnest(v_names) as n
       where n !~* '^([0-9a-f]{6,}|[0-9]{5,})$') then
    return 'opaque-id';
  end if;
  return 'none';
end;
$$;

-- The whole row. Raises (any error) when the document does not have the
-- shape the mapping reads; `ingest_hands` turns that into a rejected row.
-- `stable`, not `immutable`: `played_at` is a text-to-timestamptz cast.
create or replace function public.hand_row_from_phf(p_phf jsonb)
returns public.hands
language plpgsql
stable
set search_path = ''
as $$
declare
  r          public.hands;
  v_ws       constant text := public.phf_js_whitespace();
  v_meta     jsonb := p_phf -> 'meta';
  v_game     jsonb := p_phf -> 'game';
  v_unit     jsonb := p_phf -> 'game' -> 'unit';
  v_table    jsonb := p_phf -> 'table';
  v_results  jsonb := p_phf -> 'results';
  v_players  jsonb := p_phf -> 'players';
  v_base     jsonb;
  v_fees     jsonb;
  v_hero     jsonb;
  v_sb       bigint;
  v_bb       bigint;
  v_minor    integer;
  v_decimals text;
  v_turn     text;
  v_river    text;
begin
  if jsonb_typeof(p_phf) is distinct from 'object'
     or jsonb_typeof(v_meta) is distinct from 'object'
     or jsonb_typeof(v_game) is distinct from 'object'
     or jsonb_typeof(v_unit) is distinct from 'object'
     or jsonb_typeof(v_table) is distinct from 'object'
     or jsonb_typeof(v_results) is distinct from 'object'
     or jsonb_typeof(v_players) is distinct from 'array'
     or jsonb_typeof(p_phf -> 'board' -> 'runouts') is distinct from 'array'
     or jsonb_typeof(v_meta -> 'siteId') is distinct from 'string' then
    raise exception 'not a PHF hand' using errcode = '22023';
  end if;

  r.origin         := 'desktop';
  r.phf            := p_phf;
  r.standard_text  := null;
  r.source_text    := null;
  r.schema_version := p_phf ->> 'schema';

  -- handKeyOf: site trimmed and lower-cased, `handKey || handId`.
  r.hand_key := lower(btrim(v_meta ->> 'siteId', v_ws)) || ':'
             || coalesce(nullif(v_meta ->> 'handKey', ''), v_meta ->> 'handId', '');
  r.parser_version  := nullif(v_meta ->> 'parserVersion', '');
  r.site            := v_meta ->> 'siteId';
  r.site_hand_id    := nullif(v_meta ->> 'handId', '');
  r.source_filename := v_meta ->> 'originalFilename';

  r.variant       := v_game ->> 'variant';
  r.limit_type    := v_game ->> 'limit';
  r.game_format   := (v_game ->> 'format')::public.game_format;
  r.tournament_id := p_phf -> 'tournament' ->> 'id';

  r.currency             := v_unit ->> 'code';
  v_minor                := (v_unit ->> 'minorUnits')::integer;
  r.currency_minor_units := v_minor::smallint;
  r.currency_symbol      := v_unit ->> 'symbol';

  v_sb          := (v_game ->> 'smallBlind')::bigint;
  v_bb          := (v_game ->> 'bigBlind')::bigint;
  r.small_blind := v_sb;
  r.big_blind   := v_bb;
  r.ante        := nullif((v_game ->> 'ante')::bigint, 0);

  -- stakesLabelOf
  if coalesce(v_sb, 0) = 0 and coalesce(v_bb, 0) = 0 then
    r.stakes_label := null;
  else
    v_decimals := v_meta -> 'textStyle' ->> 'decimals';
    if v_game ->> 'variant' = 'shortdeck' and coalesce(v_sb, 0) = 0 then
      r.stakes_label := public.phf_format_amount(v_bb, r.currency_symbol, v_minor, v_decimals);
    else
      r.stakes_label := public.phf_format_amount(coalesce(v_sb, 0), r.currency_symbol, v_minor, v_decimals)
                     || '/'
                     || public.phf_format_amount(coalesce(v_bb, 0), r.currency_symbol, v_minor, v_decimals);
    end if;
  end if;

  r.table_name := v_table ->> 'name';
  r.max_seats  := nullif((v_table ->> 'maxSeats')::integer, 0)::smallint;
  r.played_at  := (p_phf ->> 'playedAt')::timestamptz;

  -- heroOf: the first player with isHero.
  select p into v_hero
    from jsonb_array_elements(v_players) with ordinality as t(p, i)
   where p -> 'isHero' = 'true'::jsonb
   order by i
   limit 1;

  r.hero_name       := v_hero ->> 'name';
  r.hero_seat       := (v_hero ->> 'seat')::smallint;
  r.hero_position   := v_hero ->> 'position';
  r.hero_cards      := public.phf_text_array(v_hero -> 'holeCards');
  r.hero_hand_class := case when v_hero is null then null else public.phf_hand_class(r.hero_cards) end;

  -- primaryBoard = resolveRunout(board, 0): runout 0's flop, turn, river.
  v_base := p_phf -> 'board' -> 'runouts' -> 0;
  if jsonb_typeof(v_base) = 'object' then
    v_turn  := nullif(v_base ->> 'turn', '');
    v_river := nullif(v_base ->> 'river', '');
    r.board_cards := public.phf_text_array(v_base -> 'flop')
                  || case when v_turn is null then '{}'::text[] else array[v_turn] end
                  || case when v_river is null then '{}'::text[] else array[v_river] end;
  else
    r.board_cards := '{}'::text[];
  end if;

  r.site_anonymization := public.phf_site_anonymization(p_phf);

  -- A positional hand's names point at a different human every hand: none
  -- in the identity columns (`hands_positional_anonymity`).
  if r.site_anonymization = 'positional' then
    r.player_names := '{}'::text[];
    r.winners      := '{}'::text[];
  else
    r.player_names := array(
      select p ->> 'name'
        from jsonb_array_elements(v_players) with ordinality as t(p, i)
       order by i);
    -- Deduped, first occurrence first (a JavaScript Set).
    r.winners := array(
      select w.player
        from (select x ->> 'player' as player, min(i) as first_at
                from jsonb_array_elements(
                       case when jsonb_typeof(v_results -> 'winners') = 'array'
                            then v_results -> 'winners' else '[]'::jsonb end
                     ) with ordinality as t(x, i)
               group by x ->> 'player') as w
       order by w.first_at);
  end if;
  r.player_count := jsonb_array_length(v_players);

  -- Positions: the roster, the showdown seats, the winning seats - each a
  -- set (the trigger sorts and dedupes them).
  r.player_positions := array(
    select distinct p ->> 'position'
      from jsonb_array_elements(v_players) as p
     where coalesce(p ->> 'position', '') <> '');
  r.showdown_positions := array(
    select distinct p ->> 'position'
      from jsonb_array_elements(
             case when jsonb_typeof(v_results -> 'players') = 'array'
                  then v_results -> 'players' else '[]'::jsonb end) as rp
      join jsonb_array_elements(v_players) as p on p -> 'seat' = rp -> 'seat'
     where rp -> 'wentToShowdown' = 'true'::jsonb
       and coalesce(p ->> 'position', '') <> '');
  r.winner_positions := array(
    select distinct p ->> 'position'
      from jsonb_array_elements(
             case when jsonb_typeof(v_results -> 'winners') = 'array'
                  then v_results -> 'winners' else '[]'::jsonb end) as w
      join jsonb_array_elements(v_players) as p on p -> 'seat' = w -> 'seat'
     where jsonb_typeof(w -> 'seat') = 'number'
       and coalesce(p ->> 'position', '') <> '');

  r.street_reached   := v_results ->> 'streetReached';
  r.went_to_showdown := coalesce((v_results ->> 'wentToShowdown')::boolean, false);
  r.total_pot        := (v_results ->> 'totalPot')::bigint;
  r.hero_profit      := (v_results ->> 'heroNet')::bigint;
  -- totalFees: every fee taken out of the pot.
  v_fees := v_results -> 'fees';
  r.rake := (v_fees ->> 'rake')::bigint + (v_fees ->> 'jackpot')::bigint
          + (v_fees ->> 'bingo')::bigint + (v_fees ->> 'fortune')::bigint
          + (v_fees ->> 'tax')::bigint + (v_fees ->> 'other')::bigint;

  return r;
end;
$$;

-- Why a derived row would not satisfy the `hands` constraints: the name of
-- the first column at fault, or null when the row is valid. Mirrors the
-- CHECKs on the values the normalizing trigger will store, so one bad hand
-- is rejected on its own instead of failing the whole batch's insert.
create or replace function public.hand_row_problem(r public.hands)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ws constant text := public.phf_js_whitespace();
begin
  if r.hand_key is null or char_length(r.hand_key) not between 1 and 200
     or r.hand_key !~ '^[a-z0-9][a-z0-9._-]{0,63}:[^[:space:]:][^[:space:]]{0,135}$' then
    return 'hand_key';
  end if;
  if char_length(coalesce(lower(btrim(r.site)), '')) not between 1 and 64 then
    return 'site';
  end if;
  if r.schema_version is distinct from 'phf/1' then
    return 'schema_version';
  end if;
  if r.variant is not null and char_length(r.variant) > 64 then
    return 'variant';
  end if;
  if r.limit_type is not null and lower(btrim(r.limit_type)) not in ('nl', 'pl', 'fl') then
    return 'limit_type';
  end if;
  if r.tournament_id is not null and char_length(btrim(r.tournament_id)) > 64 then
    return 'tournament_id';
  end if;
  if char_length(coalesce(btrim(r.currency), '')) not between 1 and 16 then
    return 'currency';
  end if;
  if r.currency_minor_units is null or r.currency_minor_units not in (1, 10, 100, 1000) then
    return 'currency_minor_units';
  end if;
  if r.currency_symbol is not null and char_length(r.currency_symbol) > 8 then
    return 'currency_symbol';
  end if;
  if coalesce(r.small_blind, 0) < 0 or coalesce(r.big_blind, 0) < 0 or coalesce(r.ante, 0) < 0 then
    return 'blinds';
  end if;
  if r.max_seats is not null and r.max_seats not between 2 and 24 then
    return 'max_seats';
  end if;
  if not public.is_card_array(r.hero_cards) or cardinality(r.hero_cards) > 6 then
    return 'hero_cards';
  end if;
  if not public.is_card_array(r.board_cards) or cardinality(r.board_cards) > 10 then
    return 'board_cards';
  end if;
  if cardinality(r.player_names) > 24 or array_position(r.player_names, null) is not null then
    return 'player_names';
  end if;
  if cardinality(r.winners) > 24 or array_position(r.winners, null) is not null then
    return 'winners';
  end if;
  if r.player_count is null or r.player_count not between 1 and 24 then
    return 'player_count';
  end if;
  if r.hero_position is not null
     and not public.is_position_array(array[upper(btrim(r.hero_position))]) then
    return 'hero_position';
  end if;
  if not public.is_position_array(public.normalize_positions(r.player_positions))
     or cardinality(public.normalize_positions(r.player_positions)) > 24 then
    return 'player_positions';
  end if;
  if not public.is_position_array(public.normalize_positions(r.showdown_positions)) then
    return 'showdown_positions';
  end if;
  if not public.is_position_array(public.normalize_positions(r.winner_positions)) then
    return 'winner_positions';
  end if;
  if r.street_reached is not null
     and lower(btrim(r.street_reached)) not in ('preflop', 'flop', 'turn', 'river', 'showdown') then
    return 'street_reached';
  end if;
  if r.hero_hand_class is not null and r.hero_hand_class !~ '^[2-9TJQKA]{2}[so]?$' then
    return 'hero_hand_class';
  end if;
  if coalesce(r.total_pot, 0) < 0 then
    return 'total_pot';
  end if;
  if coalesce(r.rake, 0) < 0 then
    return 'rake';
  end if;
  return null;
end;
$$;

-- Internals of `ingest_hands`; no client calls them.
revoke all on function public.phf_js_whitespace() from public, anon, authenticated;
revoke all on function public.phf_text_array(jsonb) from public, anon, authenticated;
revoke all on function public.phf_format_amount(bigint, text, integer, text) from public, anon, authenticated;
revoke all on function public.phf_hand_class(text[]) from public, anon, authenticated;
revoke all on function public.phf_site_anonymization(jsonb) from public, anon, authenticated;
revoke all on function public.hand_row_from_phf(jsonb) from public, anon, authenticated;
revoke all on function public.hand_row_problem(public.hands) from public, anon, authenticated;

comment on function public.hand_row_from_phf(jsonb) is
  'The hands row for a desktop PHF document: every search column derived the way handInsertFromPhf (frontend/src/lib/db/mapping.ts) derives it. Internal to ingest_hands; parity with the TypeScript is tested over the corpus (R1.8).';

-- ---------------------------------------------------------------------------
-- 5. register_hand_source
-- ---------------------------------------------------------------------------

create or replace function public.register_hand_source(
  p_device_id   uuid,
  p_local_id    text,
  p_device_name text default null,
  p_label       text default null,
  p_site        text default null
)
returns uuid
language plpgsql
-- security definer: `hand_sources` has no client INSERT or UPDATE grant.
-- The owner is auth.uid(); the row it updates is selected by the owner too,
-- and only the descriptive columns change.
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_id    uuid;
  v_local text := btrim(coalesce(p_local_id, ''));
  v_name  text := nullif(left(btrim(coalesce(p_device_name, '')), 64), '');
  v_label text := nullif(left(btrim(coalesce(p_label, '')), 120), '');
  v_site  text := nullif(left(lower(btrim(coalesce(p_site, ''))), 64), '');
begin
  if v_owner is null then
    raise exception 'You must be signed in to sync hands.'
      using errcode = '42501';
  end if;
  if p_device_id is null or char_length(v_local) not between 1 and 64 then
    raise exception 'register_hand_source needs a device id and a local id (1-64 characters)'
      using errcode = '22023';
  end if;
  if v_label ~ '[/\\]' then
    raise exception 'A hand source label may not contain a path'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('hand_source:' || v_owner::text, 1, 120, interval '10 minutes');

  select s.id into v_id
    from public.hand_sources s
   where s.owner_id = v_owner and s.kind = 'folder'
     and s.device_id = p_device_id and s.local_id = v_local;

  if v_id is null then
    if (select count(*) from public.hand_sources s where s.owner_id = v_owner) >= 200 then
      raise exception 'Too many hand sources on this account (200)'
        using errcode = '53400';
    end if;
    insert into public.hand_sources as s (owner_id, kind, device_id, local_id, device_name, label, site)
    values (v_owner, 'folder', p_device_id, v_local, v_name, v_label, v_site)
    on conflict (owner_id, device_id, local_id) where kind = 'folder'
    do update set device_name = excluded.device_name,
                  label       = excluded.label,
                  site        = excluded.site,
                  updated_at  = now()
    returning s.id into v_id;
  else
    update public.hand_sources s
       set device_name = v_name, label = v_label, site = v_site, updated_at = now()
     where s.id = v_id and s.owner_id = v_owner;
  end if;

  return v_id;
end;
$$;

revoke all on function public.register_hand_source(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_hand_source(uuid, text, text, text, text) to authenticated;

comment on function public.register_hand_source(uuid, text, text, text, text) is
  'Registers (or renames) a folder the desktop app watches, keyed by (owner, device id, local id); returns its hand_sources id for ingest_hands. Labels must not contain a path. 120 calls / 10 min, 200 sources per account (R1.8).';

-- ---------------------------------------------------------------------------
-- 6. ingest_hands
-- ---------------------------------------------------------------------------

create or replace function public.ingest_hands(p_source uuid, p_rows jsonb)
returns jsonb
language plpgsql
-- security definer: desktop rows may only be written here (the insert
-- policy refuses them on the direct path), and the source counters have no
-- client UPDATE grant. Inside: the owner is auth.uid(), written explicitly
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

  -- The same answer for "no such source" and "not yours".
  if not exists (
    select 1 from public.hand_sources s
     where s.id = p_source and s.owner_id = v_owner and s.kind = 'folder'
  ) then
    raise exception 'No hand source with id %', p_source using errcode = '23503';
  end if;

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
      -- Q4: the original text stays on the user's disk.
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
      v_owner, 'desktop',
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
  'Desktop sync (R1.8): inserts up to 500 hands ({hand_key, phf}, at most 8 MiB) into the caller''s library from one of their hand sources, deriving every search column from the PHF; on conflict (owner_id, hand_key) do nothing. Returns {received, inserted, duplicates, rejected, rows[i]: {handKey, status, reason?, field?}} in input order. Budget per account: 150 000 rows / 10 min and 2 000 000 / day (53400).';
