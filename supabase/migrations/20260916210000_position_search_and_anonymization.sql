-- ============================================================================
-- Position search + site anonymization.
-- ============================================================================
--
-- Incremental migration on top of 20260916190000_phf_baseline.sql. Additive:
-- it adds columns, constraints, indexes and new versions of three functions.
-- It does NOT drop anything, and it must not be made re-runnable-destructive
-- the way the baseline is.
--
-- (Note for whoever re-runs the baseline during development: the baseline
-- recreates `hands` and `hands_normalize()` from scratch, so this file has to
-- be applied again afterwards.)
--
-- ## Why
--
-- Twenty site parsers exist now, and two of them produce hands where the player
-- names are **not identities**:
--
--   * **Ignition / Bodog / Bovada** prints every seat as its position relative
--     to the button -- `Dealer`, `Small Blind`, `UTG+2` -- with the hero tagged
--     `[ME]`. The button rotates every hand, so `player_names = 'UTG+1'` is a
--     different human in every row. A filter on it does not fail, it silently
--     returns nonsense, which is strictly worse.
--   * **ACR/WPN's data-mined dialect** replaces every screen name with a
--     numeric id of unconfirmed stability and marks no hero. The parser flags
--     these hands with a `numeric-player-ids` warning.
--   * **GGPoker** hashes every villain to eight hex characters per session.
--
-- The fix has three parts:
--
--   1. `site_anonymization` says, per hand, what the names in this row are
--      worth. The filter UI branches on a column instead of a hard-coded site
--      list, so a future anonymizing site is a value, not a code change.
--   2. For `positional` hands, `player_names` and `winners` are written empty
--      and a CHECK constraint makes it impossible to write pseudonyms into them.
--      A row that cannot answer "who played" now says so instead of answering
--      wrongly. `hero_name` is kept: it is the one real identity, so hero
--      filtering and "my hands" keep working.
--   3. Position moves into the denormalized search layer. For Ignition,
--      position *is* the identity; for every other site it is the filter a
--      serious player actually wants ("the villain in the cutoff"). It was
--      previously reachable only by digging into `phf`, which is unindexable.
--
-- `opaque-id` hands deliberately KEEP their names. A numeric id or a session
-- hash is unreadable and may not be stable across sessions, but unlike a
-- positional pseudonym it does not map to a *different human* on every row, and
-- within one session it groups correctly. Discarding it would be irreversible
-- information loss; labelling it lets the UI render it honestly ("player
-- #1234567, identity not stable across sessions") and disable cross-session
-- claims. Only `positional` is destructive enough to justify blanking.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enum
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'site_anonymization'
  ) then
    create type public.site_anonymization as enum (
      'none',        -- names are real, persistent screen names
      'positional',  -- names are position labels that remap every hand (Ignition)
      'opaque-id'    -- names are per-session tokens: hashes or numeric ids
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Helper functions for the new columns
-- ---------------------------------------------------------------------------

-- The closed position vocabulary from PHF (`Position` in phf/types.ts).
-- `MP` is the catch-all for the middle seats of a 10+ handed table.
create or replace function public.is_position_array(p_positions text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_positions is null
      or not exists (
           select 1
           from unnest(p_positions) as c
           where c not in ('BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO')
         );
$$;

comment on function public.is_position_array(text[]) is
  'True when every element is a PHF Position label.';

-- Uppercases, trims, drops blanks and dedupes. Positions are stored as a *set*:
-- two seats can never share a position, and a canonical sorted form makes array
-- equality and containment behave predictably.
create or replace function public.normalize_positions(p_positions text[])
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_positions is null then '{}'::text[]
    else coalesce(
      (select array_agg(distinct upper(btrim(c)))
       from unnest(p_positions) as c
       where btrim(coalesce(c, '')) <> ''),
      '{}'::text[]
    )
  end;
$$;

comment on function public.normalize_positions(text[]) is
  'Canonicalises a position array to an uppercase, deduped, sorted set.';

-- ---------------------------------------------------------------------------
-- 3. New columns
-- ---------------------------------------------------------------------------

alter table public.hands
  add column if not exists site_anonymization public.site_anonymization not null default 'none',
  -- Roster of positions dealt in. For a `positional` hand this is the only
  -- per-seat roster left once `player_names` is blanked.
  add column if not exists player_positions text[] not null default '{}',
  -- Positions that reached showdown. This is the "which villain" filter:
  -- typically 0-2 entries, so it is selective enough to index.
  add column if not exists showdown_positions text[] not null default '{}',
  -- Positions that collected a pot. Not a nicety: for a `positional` hand
  -- `winners` is blank, so this is the only record of who won.
  add column if not exists winner_positions text[] not null default '{}';

comment on column public.hands.site_anonymization is
  'What the player names in this row are worth: none = real screen names, positional = per-hand position pseudonyms (do not use as identities), opaque-id = per-session tokens.';
comment on column public.hands.player_positions is
  'Set of positions dealt into this hand. Positions with an unknown button are omitted.';
comment on column public.hands.showdown_positions is
  'Positions that reached showdown. The cross-site "which villain" filter.';
comment on column public.hands.winner_positions is
  'Positions that collected a pot. The only winner record for positional-anonymity hands.';

-- ---------------------------------------------------------------------------
-- 4. Backfill from the PHF payload
-- ---------------------------------------------------------------------------
--
-- Every new column is derivable from `phf`, which is the whole point of keeping
-- the canonical document: a denormalization added later is a backfill, not a
-- re-upload. Existing rows are all `site_anonymization = 'none'` (the default),
-- which is correct -- no anonymizing site had a parser when they were stored.

update public.hands h
set
  player_positions = coalesce((
    select array_agg(distinct p ->> 'position')
    from jsonb_array_elements(h.phf -> 'players') as p
    where p ->> 'position' is not null
  ), '{}'::text[]),

  showdown_positions = coalesce((
    select array_agg(distinct pl.pos)
    from (
      select p ->> 'seat' as seat, p ->> 'position' as pos
      from jsonb_array_elements(h.phf -> 'players') as p
    ) pl
    where pl.pos is not null
      and exists (
        select 1
        from jsonb_array_elements(h.phf -> 'results' -> 'players') as r
        where r ->> 'seat' = pl.seat
          and (r ->> 'wentToShowdown')::boolean
      )
  ), '{}'::text[]),

  winner_positions = coalesce((
    select array_agg(distinct pl.pos)
    from (
      select p ->> 'seat' as seat, p ->> 'position' as pos
      from jsonb_array_elements(h.phf -> 'players') as p
    ) pl
    where pl.pos is not null
      and exists (
        select 1
        from jsonb_array_elements(h.phf -> 'results' -> 'winners') as w
        where w ->> 'seat' = pl.seat
      )
  ), '{}'::text[])
where jsonb_typeof(h.phf -> 'players') = 'array';

-- ---------------------------------------------------------------------------
-- 5. Constraints
-- ---------------------------------------------------------------------------

alter table public.hands
  drop constraint if exists hands_player_positions_ok,
  drop constraint if exists hands_showdown_positions_ok,
  drop constraint if exists hands_winner_positions_ok,
  drop constraint if exists hands_hero_position_ok,
  drop constraint if exists hands_positional_anonymity;

alter table public.hands
  add constraint hands_player_positions_ok
    check (public.is_position_array(player_positions) and cardinality(player_positions) <= 24),
  add constraint hands_showdown_positions_ok
    check (public.is_position_array(showdown_positions) and cardinality(showdown_positions) <= 24),
  add constraint hands_winner_positions_ok
    check (public.is_position_array(winner_positions) and cardinality(winner_positions) <= 24),
  -- `hero_position` was previously free text. Every stored value already
  -- conforms; pinning it to the vocabulary makes the position filters total.
  add constraint hands_hero_position_ok
    check (hero_position is null or public.is_position_array(array[hero_position])),
  -- The invariant that makes rule 2 above enforceable rather than aspirational.
  -- A client that tags a hand `positional` cannot also smuggle the pseudonyms
  -- into the identity columns, whether by bug or on purpose. `hero_name` is
  -- deliberately not covered: it is the one real identity on such a hand.
  add constraint hands_positional_anonymity
    check (
      site_anonymization <> 'positional'
      or (cardinality(player_names) = 0 and cardinality(winners) = 0)
    );

-- ---------------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------------

-- Selective: a showdown involves 0-2 seats and a pot is usually won by one.
-- These are the containment filters that make "the villain in the CO showed
-- down" and "the button won" answerable across every site.
create index if not exists hands_showdown_positions_gin
  on public.hands using gin (showdown_positions);
create index if not exists hands_winner_positions_gin
  on public.hands using gin (winner_positions);

-- "Hero was on the button", the single most common position filter, combined
-- with the default sort.
create index if not exists hands_hero_position_played_idx
  on public.hands (hero_position, played_at desc nulls last)
  where hero_position is not null;

-- Deliberately NOT indexed:
--   * `player_positions` -- on a 6-max table it is the same six values on every
--     row, so a containment filter on it matches nearly everything and an index
--     would never be chosen. It is stored for display and roster completeness,
--     not for filtering.
--   * `site_anonymization` -- three values, overwhelmingly 'none'. The UI reads
--     it per row to decide what to render; nobody pages through it.

-- ---------------------------------------------------------------------------
-- 7. Normalizing trigger
-- ---------------------------------------------------------------------------
-- Replaces the baseline version; adds position canonicalisation and enforces
-- the positional-anonymity invariant by construction rather than by rejection
-- for the *hero position* casing that clients get wrong.

create or replace function public.hands_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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
-- 8. save_hands -- accept the new columns
-- ---------------------------------------------------------------------------

create or replace function public.save_hands(p_hands jsonb)
returns jsonb
language plpgsql
-- security invoker: inserts must remain subject to the hands RLS policy and
-- the rate-limit trigger. This function is convenience + atomic counting only.
security invoker
set search_path = ''
as $$
declare
  v_received integer;
  v_inserted integer;
begin
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
      hand_key, phf, standard_text, source_text, schema_version, parser_version,
      site, site_hand_id, variant, limit_type, game_format, tournament_id,
      site_anonymization,
      currency, currency_minor_units, currency_symbol,
      small_blind, big_blind, ante, stakes_label,
      table_name, max_seats, played_at,
      hero_name, hero_seat, hero_position, hero_cards, hero_hand_class,
      board_cards, player_names, player_positions, player_count,
      street_reached, went_to_showdown, total_pot, rake, hero_profit,
      winners, winner_positions, showdown_positions,
      source_filename
    )
    select
      d.hand_key, d.phf, d.standard_text, d.source_text,
      coalesce(d.schema_version, 'phf/1'), d.parser_version,
      d.site, d.site_hand_id, d.variant, d.limit_type,
      coalesce(d.game_format, 'cash'::public.game_format),
      d.tournament_id,
      coalesce(d.site_anonymization, 'none'::public.site_anonymization),
      coalesce(d.currency, 'USD'),
      coalesce(d.currency_minor_units, 100::smallint),
      d.currency_symbol,
      d.small_blind, d.big_blind, d.ante, d.stakes_label,
      d.table_name, d.max_seats, d.played_at,
      d.hero_name, d.hero_seat, d.hero_position,
      coalesce(d.hero_cards, '{}'::text[]), d.hero_hand_class,
      coalesce(d.board_cards, '{}'::text[]),
      coalesce(d.player_names, '{}'::text[]),
      coalesce(d.player_positions, '{}'::text[]),
      d.player_count,
      d.street_reached, coalesce(d.went_to_showdown, false),
      d.total_pot, d.rake, d.hero_profit,
      coalesce(d.winners, '{}'::text[]),
      coalesce(d.winner_positions, '{}'::text[]),
      coalesce(d.showdown_positions, '{}'::text[]),
      d.source_filename
    from deduped d
    on conflict (hand_key) do nothing
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
  'Batch-insert converted hands, deduping on hand_key. Returns {received, inserted, duplicates}.';

-- ---------------------------------------------------------------------------
-- 9. search_hands -- position and anonymization filters
-- ---------------------------------------------------------------------------

create or replace function public.search_hands(
  p_filters jsonb default '{}'::jsonb,
  p_limit   integer default 25,
  p_offset  integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_site        text    := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_board       text[];
  v_hero_cards  text[];
  v_hero_class  text[];
  v_player      text    := nullif(btrim(coalesce(p_filters ->> 'player', '')), '');
  v_hero_name   text    := nullif(btrim(coalesce(p_filters ->> 'heroName', '')), '');
  v_table       text    := nullif(btrim(coalesce(p_filters ->> 'tableName', '')), '');
  v_variant     text    := nullif(btrim(coalesce(p_filters ->> 'variant', '')), '');
  v_limit_type  text    := nullif(lower(btrim(coalesce(p_filters ->> 'limitType', ''))), '');
  v_tourney     text    := nullif(btrim(coalesce(p_filters ->> 'tournamentId', '')), '');
  v_format      public.game_format;
  v_anon        public.site_anonymization;
  v_hero_pos    text[];
  v_sd_pos      text[];
  v_win_pos     text[];
  v_big_blind   bigint  := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_street      text    := nullif(btrim(coalesce(p_filters ->> 'street', '')), '');
  v_showdown    boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'showdownOnly', '')), '')::boolean, false);
  v_hero_won    boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'heroWonOnly', '')), '')::boolean, false);
  v_min_pot     bigint  := nullif(btrim(coalesce(p_filters ->> 'minPot', '')), '')::bigint;
  v_from        timestamptz := nullif(btrim(coalesce(p_filters ->> 'from', '')), '')::timestamptz;
  v_to          timestamptz := nullif(btrim(coalesce(p_filters ->> 'to', '')), '')::timestamptz;
  v_order       text;
  v_where       text;
  v_total       bigint;
  v_rows        jsonb;
  v_limit       integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset      integer := greatest(coalesce(p_offset, 0), 0);
begin
  v_board := coalesce(
    public.normalize_cards(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'board', '[]'::jsonb)))
    ), '{}'::text[]);
  v_hero_cards := coalesce(
    public.normalize_cards(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'heroCards', '[]'::jsonb)))
    ), '{}'::text[]);
  v_hero_class := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'heroHandClasses', '[]'::jsonb))),
    '{}'::text[]);

  v_hero_pos := public.normalize_positions(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'heroPositions', '[]'::jsonb))));
  v_sd_pos := public.normalize_positions(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'showdownPositions', '[]'::jsonb))));
  v_win_pos := public.normalize_positions(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'winnerPositions', '[]'::jsonb))));

  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;
  if nullif(btrim(coalesce(p_filters ->> 'anonymization', '')), '') is not null then
    v_anon := (p_filters ->> 'anonymization')::public.site_anonymization;
  end if;

  -- Whitelisted sort keys only; nothing from p_filters is ever interpolated.
  v_order := case coalesce(p_filters ->> 'sort', 'played_desc')
    when 'played_asc'   then 'played_at asc nulls last, id asc'
    when 'pot_desc'     then 'total_pot desc nulls last, id desc'
    when 'profit_desc'  then 'hero_profit desc nulls last, id desc'
    when 'profit_asc'   then 'hero_profit asc nulls last, id asc'
    when 'created_desc' then 'created_at desc, id desc'
    else 'played_at desc nulls last, id desc'
  end;

  -- Every parameter is explicitly cast: EXECUTE ... USING cannot infer a type
  -- from `$n IS NULL` alone, and an untyped `||` would be ambiguous.
  --
  -- `heroPositions` / `showdownPositions` / `winnerPositions` use `&&`
  -- (overlap), not `@>` (containment): asking for "hero was on the button or
  -- the cutoff" is a union, and a hand can only ever have one hero position, so
  -- containment of a two-element array would match nothing.
  v_where := $w$
    where ($1::text is null or h.site = $1::text)
      and (cardinality($2::text[]) = 0 or h.board_cards @> $2::text[])
      and (cardinality($3::text[]) = 0 or h.hero_cards  @> $3::text[])
      and (cardinality($4::text[]) = 0 or h.hero_hand_class = any($4::text[]))
      and ($5::text is null or h.player_names @> array[$5::text])
      and ($6::text is null or h.hero_name = $6::text)
      and ($7::text is null or h.table_name ilike '%' || $7::text || '%')
      and ($8::text is null or h.variant = $8::text)
      and ($9::public.game_format is null or h.game_format = $9::public.game_format)
      and ($10::bigint is null or h.big_blind = $10::bigint)
      and ($11::text is null or h.street_reached = $11::text)
      and ($12::boolean is false or h.went_to_showdown)
      and ($13::boolean is false or h.hero_profit > 0)
      and ($14::bigint is null or h.total_pot >= $14::bigint)
      and ($15::timestamptz is null or h.played_at >= $15::timestamptz)
      and ($16::timestamptz is null or h.played_at <= $16::timestamptz)
      and ($17::text is null or h.limit_type = $17::text)
      and ($18::text is null or h.tournament_id = $18::text)
      and (cardinality($19::text[]) = 0 or h.hero_position = any($19::text[]))
      and (cardinality($20::text[]) = 0 or h.showdown_positions && $20::text[])
      and (cardinality($21::text[]) = 0 or h.winner_positions  && $21::text[])
      and ($22::public.site_anonymization is null
           or h.site_anonymization = $22::public.site_anonymization)
  $w$;

  execute 'select count(*) from public.hands h ' || v_where
    into v_total
    using v_site, v_board, v_hero_cards, v_hero_class, v_player, v_hero_name,
          v_table, v_variant, v_format, v_big_blind, v_street, v_showdown,
          v_hero_won, v_min_pot, v_from, v_to, v_limit_type, v_tourney,
          v_hero_pos, v_sd_pos, v_win_pos, v_anon;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(x) order by %1$s), '[]'::jsonb)
    from (
      select
        h.id, h.hand_key, h.site, h.site_hand_id, h.variant, h.limit_type,
        h.game_format, h.tournament_id, h.site_anonymization,
        h.currency, h.currency_minor_units, h.currency_symbol,
        h.small_blind, h.big_blind, h.ante, h.stakes_label,
        h.table_name, h.max_seats, h.played_at,
        h.hero_name, h.hero_seat, h.hero_position, h.hero_cards, h.hero_hand_class,
        h.board_cards, h.player_names, h.player_positions, h.player_count,
        h.street_reached, h.went_to_showdown, h.total_pot, h.rake, h.hero_profit,
        h.winners, h.winner_positions, h.showdown_positions,
        h.schema_version, h.parser_version, h.source_filename, h.created_at
      from public.hands h
      %2$s
      order by %1$s
      offset $23::integer limit $24::integer
    ) x
  $q$, v_order, v_where)
    into v_rows
    using v_site, v_board, v_hero_cards, v_hero_class, v_player, v_hero_name,
          v_table, v_variant, v_format, v_big_blind, v_street, v_showdown,
          v_hero_won, v_min_pot, v_from, v_to, v_limit_type, v_tourney,
          v_hero_pos, v_sd_pos, v_win_pos, v_anon,
          v_offset, v_limit;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'rows',   v_rows
  );
end;
$$;

comment on function public.search_hands(jsonb, integer, integer) is
  'Filtered, sorted, paginated hand list plus total count in one call. Position filters use overlap (&&), so they read as "any of these". Heavy columns (phf / standard_text / source_text) are excluded.';

-- ---------------------------------------------------------------------------
-- 10. hands_facets -- position and anonymization facets
-- ---------------------------------------------------------------------------

create or replace function public.hands_facets()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'total', (select count(*) from public.hands),
    'sites', (
      select coalesce(jsonb_agg(jsonb_build_object('value', site, 'count', n) order by n desc, site), '[]'::jsonb)
      from (select site, count(*) as n from public.hands group by site) s
    ),
    'heroes', (
      select coalesce(jsonb_agg(jsonb_build_object('value', hero_name, 'count', n) order by n desc, hero_name), '[]'::jsonb)
      from (select hero_name, count(*) as n from public.hands where hero_name is not null group by hero_name) s
    ),
    'tables', (
      select coalesce(jsonb_agg(distinct table_name order by table_name), '[]'::jsonb)
      from public.hands where table_name is not null
    ),
    'stakes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'bigBlind', big_blind, 'label', label, 'currency', currency, 'count', n
             ) order by big_blind), '[]'::jsonb) -- stakes, cheapest first
      from (
        select big_blind, max(stakes_label) as label, max(currency) as currency, count(*) as n
        from public.hands where big_blind is not null group by big_blind
      ) s
    ),
    'variants', (
      select coalesce(jsonb_agg(distinct variant order by variant), '[]'::jsonb)
      from public.hands where variant is not null
    ),
    'limitTypes', (
      select coalesce(jsonb_agg(distinct limit_type order by limit_type), '[]'::jsonb)
      from public.hands where limit_type is not null
    ),
    'gameFormats', (
      select coalesce(jsonb_agg(distinct game_format::text order by game_format::text), '[]'::jsonb)
      from public.hands
    ),
    'heroHandClasses', (
      select coalesce(jsonb_agg(distinct hero_hand_class order by hero_hand_class), '[]'::jsonb)
      from public.hands where hero_hand_class is not null
    ),
    'streets', (
      select coalesce(jsonb_agg(distinct street_reached order by street_reached), '[]'::jsonb)
      from public.hands where street_reached is not null
    ),
    -- Hero positions carry counts: an uneven distribution is itself a useful
    -- signal ("why do I have three times as many BB hands?").
    'heroPositions', (
      select coalesce(jsonb_agg(jsonb_build_object('value', hero_position, 'count', n) order by n desc, hero_position), '[]'::jsonb)
      from (select hero_position, count(*) as n from public.hands where hero_position is not null group by hero_position) s
    ),
    -- Which villain positions are actually reachable in the stored corpus.
    'showdownPositions', (
      select coalesce(jsonb_agg(distinct p order by p), '[]'::jsonb)
      from public.hands, unnest(showdown_positions) as p
    ),
    -- Lets the UI decide whether to offer the player-name filter at all.
    'anonymizations', (
      select coalesce(jsonb_agg(jsonb_build_object('value', site_anonymization::text, 'count', n)
                                order by n desc, site_anonymization::text), '[]'::jsonb)
      from (select site_anonymization, count(*) as n from public.hands group by site_anonymization) s
    ),
    'playedAtRange', (
      select jsonb_build_object('min', min(played_at), 'max', max(played_at)) from public.hands
    ),
    'unparsedTotal', (select count(*) from public.unparsed_hands)
  );
$$;

comment on function public.hands_facets() is
  'Every distinct filter value the browse UI offers, in one round trip.';

grant execute on function public.is_position_array(text[])    to anon, authenticated;
grant execute on function public.normalize_positions(text[])  to anon, authenticated;
