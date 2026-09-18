-- ============================================================================
-- PHF v1 baseline schema for the universal poker hand converter + replayer.
-- ============================================================================
--
-- This migration is a *full reset* of the application schema. The previous
-- tables held disposable sample data and were replaced rather than migrated:
--
--   * `uploads` / `converted_files` / `hands` / `hand_players` / `player_cards`
--     / `hand_actions` -- the original auth-scoped upload model. The app never
--     had a login, so those RLS policies (`auth.uid() = owner_id`) made the
--     tables permanently unreachable from the client.
--   * `stored_hands` -- the flat replayer table. Superseded by `hands`, which
--     stores the canonical PHF v1 JSON instead of only GG-format text.
--
-- Storage (`frontend-site` bucket) and everything in `auth.*` / `storage.*` is
-- deliberately left untouched: the legacy GitHub-workflow hosting path still
-- references that bucket.
--
-- THREAT MODEL (read this before changing any policy below)
-- --------------------------------------------------------
-- The app has no login and never will in this round. The deployed bundle is a
-- static public asset, so `VITE_SUPABASE_ANON_KEY` is public by construction:
-- anyone can read it out of the JS bundle and talk to PostgREST directly.
-- Therefore every policy here is written for an *untrusted, unauthenticated,
-- unidentifiable* caller. The rules we hold to:
--
--   1. Anon may READ hand data. It is not secret -- it is already renderable by
--      anyone who loads the site.
--   2. Anon may INSERT hands. That is the product. The worst case is junk rows.
--   3. Anon may NEVER update or delete anything. Data loss is the one outcome
--      we refuse to expose. Cleanup happens through the service role.
--   4. Anything that *must* mutate an existing row (occurrence counters, share
--      view counters) goes through a `security definer` RPC that can only
--      change the specific counter columns -- never arbitrary data.
--   5. Anon may not enumerate `shares`. Share slugs are capability URLs; being
--      able to `select *` from the table would defeat the point.
--   6. Junk volume is bounded by CHECK constraints (size caps, shape checks)
--      and a coarse global insert-rate limiter, so a bored stranger with a
--      `curl` loop cannot fill the disk in an afternoon.
--
-- SEARCH PATH / SECURITY on functions
-- -----------------------------------
-- Every function sets `search_path = ''` and schema-qualifies every reference.
-- With a public anon key an attacker cannot create objects in `public`, but
-- `search_path = ''` removes the whole class of shadowing bugs for free and is
-- what the Supabase linter wants. `pg_catalog` is always implicitly searched,
-- so built-ins still resolve.
--
-- `security invoker` is the default choice: RLS then still applies and the
-- function is just a convenience wrapper. `security definer` is used *only*
-- where the caller must be allowed to do something RLS forbids (bump a
-- counter, write to a table it cannot select). Each definer function is
-- annotated with exactly why.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Drop the old application objects (surgically -- no schemas, no roles)
-- ---------------------------------------------------------------------------

-- NOTE: this block drops the objects this migration itself creates, so the
-- whole file can be re-applied from scratch during development. That is
-- deliberate and safe *only* because the owner authorised a full reset and the
-- app has no irreplaceable data -- every stored hand can be re-derived by
-- re-uploading the source files. Do not copy this pattern into a later
-- migration.

drop function if exists public.stored_hands_facets() cascade;

drop view if exists public.upload_all_players cascade;
drop view if exists public.upload_known_cards_players cascade;
drop view if exists public.unparsed_gaps cascade;

drop table if exists public.shares cascade;
drop table if exists public.unparsed_hands cascade;
drop table if exists public.ingest_rate_limit cascade;

drop table if exists public.hand_actions cascade;
drop table if exists public.player_cards cascade;
drop table if exists public.hand_players cascade;
drop table if exists public.hands cascade;
drop table if exists public.converted_files cascade;
drop table if exists public.uploads cascade;
drop table if exists public.stored_hands cascade;

drop type if exists public.card_source cascade;
drop type if exists public.game_type cascade;

-- ---------------------------------------------------------------------------
-- 2. Enums
-- ---------------------------------------------------------------------------

-- Mirrors PhfGame.format (frontend/src/lib/phf/types.ts). Closed set, worth an
-- enum; adding a value later is a one-line `alter type ... add value`.
drop type if exists public.game_format cascade;
create type public.game_format as enum ('cash', 'tournament', 'sng', 'spin');

-- Mirrors ConversionFailure.stage from the converter pipeline contract.
drop type if exists public.conversion_stage cascade;
create type public.conversion_stage as enum (
  'split',      -- could not even cut the file into individual hands
  'detect',     -- could not identify which site produced the text
  'parse',      -- site known, text did not fit the grammar
  'validate',   -- parsed, but the result failed PHF invariants
  'serialize'   -- valid PHF, but rendering standard text blew up
);

-- Triage lane for the unparsed corpus. Drives "which converter next".
drop type if exists public.unparsed_status cascade;
create type public.unparsed_status as enum (
  'new',            -- untouched, fresh from the wild
  'triaged',        -- a human looked at it and understands the format
  'parser-written', -- a converter now exists; should stop reappearing
  'wontfix'         -- corrupt / not a hand history / not worth supporting
);

-- Streets are a closed set but we keep them as text + CHECK rather than an
-- enum: `street_reached` is compared against client strings constantly and a
-- text column avoids enum-cast friction in PostgREST filters.

-- ---------------------------------------------------------------------------
-- 3. Helper functions used by CHECK constraints (must be IMMUTABLE)
-- ---------------------------------------------------------------------------

-- Structural card validation: rank in 2-9TJQKA, suit in cdhs. Case-insensitive
-- on input because the normalizing trigger canonicalises before this runs, but
-- being lenient here means a direct service-role insert is not booby-trapped.
create or replace function public.is_card_array(p_cards text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_cards is null
      or not exists (
           select 1
           from unnest(p_cards) as c
           where c !~ '^[2-9TtJjQqKkAa][cdhsCDHS]$'
         );
$$;

comment on function public.is_card_array(text[]) is
  'True when every element is a two-character card code (rank + suit).';

-- Canonical card casing: "AH" / "ah" / "Ah" all become "Ah". Keeps the GIN
-- indexes on hero_cards / board_cards useful for equality containment.
create or replace function public.normalize_cards(p_cards text[])
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_cards is null then null
    else coalesce(
      (select array_agg(upper(left(c, 1)) || lower(right(c, 1)) order by ord)
       from unnest(p_cards) with ordinality as t(c, ord)
       where c is not null and c <> ''),
      '{}'::text[]
    )
  end;
$$;

comment on function public.normalize_cards(text[]) is
  'Canonicalises card codes to "Rs" form (uppercase rank, lowercase suit).';

-- ---------------------------------------------------------------------------
-- 4. Rate limiting (coarse, global, best-effort)
-- ---------------------------------------------------------------------------
--
-- Without a login there is no per-user identity to key a limiter on, and the
-- client IP is not visible to Postgres through PostgREST. So this is a *global*
-- circuit breaker per logical bucket, not fair-share throttling: it exists to
-- turn "a stranger scripts inserts overnight" into "a stranger gets errors
-- after a while". Limits are set an order of magnitude above what a real
-- 5000-hand upload needs, so legitimate use never trips them.
--
-- RLS is enabled with NO policies and all grants revoked: the table is
-- invisible and untouchable from the anon key. Only the `security definer`
-- enforcement function below can read or write it.

create table if not exists public.ingest_rate_limit (
  bucket       text primary key,
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);

alter table public.ingest_rate_limit enable row level security;
revoke all on public.ingest_rate_limit from anon, authenticated;

comment on table public.ingest_rate_limit is
  'Fixed-window counters for the global anon write limiter. No RLS policies: unreachable except through security-definer functions.';

create or replace function public.enforce_rate_limit(
  p_bucket text,
  p_cost   integer,
  p_limit  integer,
  p_window interval
)
returns void
language plpgsql
-- security definer: the caller (anon) has zero privileges on
-- public.ingest_rate_limit by design, but still needs its writes counted.
-- The function takes no caller-controlled table/column names and writes only
-- to the counter table, so there is no injection surface.
security definer
set search_path = ''
as $$
declare
  v_hits integer;
begin
  if p_cost <= 0 then
    return;
  end if;

  insert into public.ingest_rate_limit as r (bucket, window_start, hits)
  values (p_bucket, now(), p_cost)
  on conflict (bucket) do update
    set window_start = case
          when r.window_start < now() - p_window then now()
          else r.window_start
        end,
        hits = case
          when r.window_start < now() - p_window then p_cost
          else r.hits + p_cost
        end
  returning r.hits into v_hits;

  if v_hits > p_limit then
    raise exception
      'Write rate limit exceeded for bucket "%" (% per %). Try again later.',
      p_bucket, p_limit, p_window
      using errcode = '53400';
  end if;
end;
$$;

revoke all on function public.enforce_rate_limit(text, integer, integer, interval) from public;

comment on function public.enforce_rate_limit(text, integer, integer, interval) is
  'Fixed-window global write limiter. Raises SQLSTATE 53400 when the bucket is over budget.';

-- ---------------------------------------------------------------------------
-- 5. hands -- one row per successfully converted hand
-- ---------------------------------------------------------------------------
--
-- Three representations are stored on purpose:
--   phf           canonical PHF v1 JSON. Source of truth for the replayer.
--   standard_text GG-style rendering, derived from phf. Stored so Holdem
--                 Manager export never has to re-run the serializer.
--   source_text   the original site text. Kept so we can re-convert a hand
--                 when a parser bug is fixed, without asking for the file back.
--
-- Everything after those three is a denormalized search layer: derivable from
-- phf, but indexable only if it lives in its own column. Money is integer
-- minor units (cents / chips), matching PHF.

create table public.hands (
  id uuid primary key default extensions.gen_random_uuid(),

  -- Dedupe key. Re-uploading the same file must never create duplicates.
  -- Convention: "<PhfMeta.siteId>:<PhfMeta.handKey>". PHF's own handKey is only
  -- unique within a site (it is usually the site's hand id), so the site prefix
  -- is what makes it globally safe. Built client-side, which also lets a big
  -- upload dedupe inside the batch before anything hits the network.
  hand_key text not null,

  -- Canonical payload -------------------------------------------------------
  phf            jsonb not null,
  standard_text  text  not null,
  source_text    text,

  schema_version text not null default 'phf/1',
  parser_version text,

  -- Provenance / game identity ----------------------------------------------
  site          text not null,        -- PhfMeta.siteId, lowercased
  site_hand_id  text,                 -- PhfMeta.handId, verbatim
  variant       text,                 -- PhfGame.variant: holdem, omaha, omaha5, ...
  limit_type    text,                 -- PhfGame.limit: nl | pl | fl
  game_format   public.game_format not null default 'cash',
  tournament_id text,                 -- PhfTournament.id, null on cash hands

  currency text not null default 'USD',   -- CurrencyUnit.code
  -- CurrencyUnit.minorUnits. Without it a client holding only the denormalized
  -- columns cannot turn `total_pot = 12500` back into "$125.00" vs "12500
  -- chips". The list view never ships `phf`, so this has to live out here.
  currency_minor_units smallint not null default 100,
  currency_symbol      text,              -- CurrencyUnit.symbol, '' for chips

  small_blind  bigint,               -- minor units
  big_blind    bigint,               -- minor units
  ante         bigint,               -- minor units
  stakes_label text,                 -- pre-rendered "$0.50/$1" for facets/UI

  table_name text,
  max_seats  smallint,
  played_at  timestamptz,

  -- Hero ---------------------------------------------------------------------
  hero_name       text,
  hero_seat       smallint,
  hero_position   text,              -- 'BTN', 'CO', 'SB', 'UTG+1', ...
  hero_cards      text[] not null default '{}',
  hero_hand_class text,              -- 'AKs' / 'AKo' / 'TT'

  -- Table state --------------------------------------------------------------
  board_cards  text[] not null default '{}',
  player_names text[] not null default '{}',
  player_count smallint,

  -- Outcome ------------------------------------------------------------------
  street_reached   text,             -- preflop | flop | turn | river | showdown
  went_to_showdown boolean not null default false,
  total_pot        bigint,
  rake             bigint,
  hero_profit      bigint,           -- signed, minor units
  winners          text[] not null default '{}',

  source_filename text,
  created_at      timestamptz not null default now(),

  -- Shape / size guards. The anon key can insert, so the table defends itself.
  constraint hands_hand_key_len    check (char_length(hand_key) between 1 and 200),
  constraint hands_site_len        check (char_length(site) between 1 and 64),
  constraint hands_variant_len     check (variant is null or char_length(variant) <= 64),
  constraint hands_limit_type_ok   check (limit_type is null or limit_type in ('nl', 'pl', 'fl')),
  constraint hands_tourney_len     check (tournament_id is null or char_length(tournament_id) <= 64),
  constraint hands_currency_len    check (char_length(currency) between 1 and 16),
  constraint hands_minor_units_ok  check (currency_minor_units in (1, 10, 100, 1000)),
  constraint hands_symbol_len      check (currency_symbol is null or char_length(currency_symbol) <= 8),
  constraint hands_phf_object      check (jsonb_typeof(phf) = 'object'),
  constraint hands_phf_schema      check (phf ->> 'schema' is null or phf ->> 'schema' like 'phf/%'),
  constraint hands_phf_size        check (octet_length(phf::text) <= 1048576),      -- 1 MiB
  constraint hands_standard_size   check (char_length(standard_text) <= 200000),
  constraint hands_source_size     check (source_text is null or char_length(source_text) <= 200000),
  constraint hands_hero_cards_ok   check (public.is_card_array(hero_cards) and cardinality(hero_cards) <= 6),
  constraint hands_board_cards_ok  check (public.is_card_array(board_cards) and cardinality(board_cards) <= 10),
  constraint hands_players_ok      check (cardinality(player_names) <= 24),
  constraint hands_winners_ok      check (cardinality(winners) <= 24),
  constraint hands_player_count_ok check (player_count is null or player_count between 1 and 24),
  constraint hands_max_seats_ok    check (max_seats is null or max_seats between 2 and 24),
  constraint hands_street_ok       check (street_reached is null or street_reached in
                                          ('preflop', 'flop', 'turn', 'river', 'showdown')),
  constraint hands_hand_class_ok   check (hero_hand_class is null or hero_hand_class ~ '^[2-9TJQKA]{2}[so]?$'),
  constraint hands_blinds_ok       check ((small_blind is null or small_blind >= 0)
                                      and (big_blind   is null or big_blind   >= 0)
                                      and (ante        is null or ante        >= 0)),
  constraint hands_pot_ok          check (total_pot is null or total_pot >= 0),
  constraint hands_rake_ok         check (rake is null or rake >= 0)
);

create unique index hands_hand_key_uidx on public.hands (hand_key);

comment on table public.hands is
  'One successfully converted poker hand. phf is canonical; every other column is a denormalized projection of it for search.';
comment on column public.hands.hand_key is
  'Dedupe key, "<PhfMeta.siteId>:<PhfMeta.handKey>". Unique.';
comment on column public.hands.phf is
  'Canonical PHF v1 document. Money values inside are integer minor units.';
comment on column public.hands.standard_text is
  'GG-style standard text rendered from phf, stored so Holdem Manager export never re-serializes.';
comment on column public.hands.source_text is
  'Original site text, kept so hands can be re-converted after a parser fix.';
comment on column public.hands.hero_profit is
  'Signed net result for hero in minor units (winnings minus total invested).';

-- Normalizing trigger: canonical card casing, trimmed identifiers, empty
-- strings folded to NULL so facet lists do not sprout blank entries.
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
  end if;

  -- created_at is server-authoritative; a client cannot backdate a row.
  new.created_at := now();

  return new;
end;
$$;

create trigger hands_normalize_before_insert
before insert on public.hands
for each row execute function public.hands_normalize();

-- Statement-level limiter. Statement level (not row level) so a 500-row batch
-- costs one counter update, and so we can reject an absurd single request.
create or replace function public.hands_rate_limit()
returns trigger
language plpgsql
-- security definer: the anon role is deliberately not granted EXECUTE on
-- enforce_rate_limit (that would let a caller burn another bucket's budget),
-- so the trigger has to cross the privilege boundary itself. It reads nothing
-- but the transition table and passes fixed, non-caller-controlled arguments.
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  select count(*) into v_rows from inserted;

  if v_rows > 1000 then
    raise exception 'Batch too large: % rows in one statement (max 1000).', v_rows
      using errcode = '53400';
  end if;

  -- 25 000 hands / 10 min. A 5000-hand upload is 5 000 -- comfortably inside.
  perform public.enforce_rate_limit('hands_insert', v_rows, 25000, interval '10 minutes');
  return null;
end;
$$;

create trigger hands_rate_limit_after_insert
after insert on public.hands
referencing new table as inserted
for each statement execute function public.hands_rate_limit();

-- Indexes -------------------------------------------------------------------
-- Each one is here because a specific UI query needs it; the browse UI is the
-- only real reader, and its query shape is "one or two filters + a sort".

-- "board contains these cards" / "hero holds these cards" / "player X was at
-- the table" -- all containment (@>) predicates, which need GIN.
create index hands_board_gin      on public.hands using gin (board_cards);
create index hands_hero_cards_gin on public.hands using gin (hero_cards);
create index hands_players_gin    on public.hands using gin (player_names);

-- Default list order and the "recently imported" order.
create index hands_played_at_idx  on public.hands (played_at desc nulls last);
create index hands_created_at_idx on public.hands (created_at desc);

-- Composite: every one of these is "filter by a low-cardinality column, then
-- sort by played_at". A plain single-column index would force a sort of the
-- whole matching set; the composite serves filter + order in one scan.
create index hands_site_played_idx    on public.hands (site, played_at desc nulls last);
create index hands_hero_played_idx    on public.hands (hero_name, played_at desc nulls last)
  where hero_name is not null;
create index hands_class_played_idx   on public.hands (hero_hand_class, played_at desc nulls last)
  where hero_hand_class is not null;
create index hands_stakes_played_idx  on public.hands (big_blind, played_at desc nulls last)
  where big_blind is not null;
create index hands_format_played_idx  on public.hands (game_format, played_at desc nulls last);
-- "every hand from tournament X", the natural drill-down from a tournament hand.
create index hands_tournament_idx     on public.hands (tournament_id, played_at desc nulls last)
  where tournament_id is not null;

-- Sort-only indexes for the "biggest pot" / "best or worst result" orderings.
create index hands_total_pot_idx   on public.hands (total_pot desc nulls last);
create index hands_hero_profit_idx on public.hands (hero_profit desc nulls last)
  where hero_profit is not null;

-- Showdown filter is a boolean with a strong skew, so a partial index on the
-- selective side is far smaller than indexing the column.
create index hands_showdown_idx on public.hands (played_at desc nulls last)
  where went_to_showdown;

-- Table name is filtered with a substring ILIKE, which only a trigram index
-- can accelerate.
create index hands_table_trgm on public.hands using gin (table_name extensions.gin_trgm_ops)
  where table_name is not null;

-- RLS -----------------------------------------------------------------------
alter table public.hands enable row level security;

revoke all on public.hands from anon, authenticated;
grant select, insert on public.hands to anon, authenticated;

-- SELECT: open. Converted hands are the public product surface; anyone who can
-- load the site can already see them. Nothing here is user-private -- there is
-- no user.
create policy hands_public_select on public.hands
for select to anon, authenticated
using (true);

-- INSERT: open, but bounded. The CHECK constraints above and the statement
-- trigger are the real gate; RLS just says "yes, anon may add rows". The worst
-- outcome is junk hands, which the service role can delete.
create policy hands_public_insert on public.hands
for insert to anon, authenticated
with check (true);

-- No UPDATE policy and no DELETE policy, deliberately. With `enable row level
-- security` and no permissive policy for those commands, every anon update and
-- delete is refused regardless of grants. Stored hands are therefore
-- append-only from the internet's point of view.

-- ---------------------------------------------------------------------------
-- 6. unparsed_hands -- the failure corpus
-- ---------------------------------------------------------------------------
--
-- This is a product feature, not an error log. Every hand history we could not
-- convert is kept verbatim so a converter can be written for it later. The
-- table is the backlog for "which site do we support next", which is why it
-- carries a triage `status` and an aggregate view.

create table public.unparsed_hands (
  id uuid primary key default extensions.gen_random_uuid(),

  -- sha-256 hex of the whitespace-normalized raw text. Dedupe key: the same
  -- unsupported hand seen a hundred times is one row with occurrences = 100.
  fingerprint text not null,

  raw_text text not null,

  detected_site         text,
  detection_confidence  real,
  stage                 public.conversion_stage not null,
  reason                text not null,   -- machine code, e.g. 'unknown-site'
  message               text not null,   -- human readable
  parser_version        text not null,
  source_filename       text,

  status public.unparsed_status not null default 'new',
  notes  text,                            -- triage scratchpad (service role)

  occurrences   integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),

  constraint unparsed_fingerprint_hex check (fingerprint ~ '^[0-9a-f]{64}$'),
  -- Hard size cap: this table accepts arbitrary text from an anonymous caller.
  -- 128 KiB is several times the largest real hand history we have seen.
  constraint unparsed_raw_size        check (char_length(raw_text) between 1 and 131072),
  constraint unparsed_site_len        check (detected_site is null or char_length(detected_site) <= 64),
  constraint unparsed_reason_len      check (char_length(reason) between 1 and 120),
  constraint unparsed_message_len     check (char_length(message) between 1 and 2000),
  constraint unparsed_parser_ver_len  check (char_length(parser_version) between 1 and 64),
  constraint unparsed_filename_len    check (source_filename is null or char_length(source_filename) <= 255),
  constraint unparsed_notes_len       check (notes is null or char_length(notes) <= 4000),
  constraint unparsed_confidence_ok   check (detection_confidence is null
                                             or (detection_confidence >= 0 and detection_confidence <= 1)),
  constraint unparsed_occurrences_ok  check (occurrences >= 1)
);

create unique index unparsed_fingerprint_uidx on public.unparsed_hands (fingerprint);

-- Triage queue: "show me everything still untouched, newest first".
create index unparsed_status_seen_idx on public.unparsed_hands (status, last_seen_at desc);
-- Gap analysis: "group by site and reason" (also serves site-only lookups).
create index unparsed_site_reason_idx on public.unparsed_hands (detected_site, reason);
-- "What hurts most" ordering for the triage UI.
create index unparsed_occurrences_idx on public.unparsed_hands (occurrences desc);
create index unparsed_stage_idx       on public.unparsed_hands (stage);

comment on table public.unparsed_hands is
  'Corpus of hand histories we could not convert, kept as reference material for writing new parsers. Deduped by fingerprint with an occurrence counter.';
comment on column public.unparsed_hands.status is
  'Triage lane: new -> triaged -> parser-written, or wontfix. Drives the "build which converter next" decision.';
comment on column public.unparsed_hands.occurrences is
  'How many times this exact text has been submitted. Maintained atomically by record_conversion_failures().';

alter table public.unparsed_hands enable row level security;

revoke all on public.unparsed_hands from anon, authenticated;
-- SELECT only. Writes go exclusively through record_conversion_failures(),
-- which is `security definer`: a direct INSERT would let a caller invent an
-- occurrence count or set status = 'wontfix' on someone else's row.
grant select on public.unparsed_hands to anon, authenticated;

-- SELECT: open. The corpus is reference material we want visible in the UI
-- ("here is what we cannot convert yet"). It contains only text the public
-- already uploaded to a public endpoint.
create policy unparsed_public_select on public.unparsed_hands
for select to anon, authenticated
using (true);

-- No INSERT / UPDATE / DELETE policy: even with a grant, direct writes are
-- refused. The definer RPC is the only door.

-- Aggregate view: where is the biggest conversion gap right now?
create or replace view public.unparsed_gaps
with (security_invoker = true) as
select
  coalesce(u.detected_site, '(unknown)') as detected_site,
  u.stage,
  u.reason,
  u.status,
  count(*)::bigint          as distinct_hands,
  sum(u.occurrences)::bigint as total_occurrences,
  min(u.first_seen_at)      as first_seen_at,
  max(u.last_seen_at)       as last_seen_at
from public.unparsed_hands u
group by 1, 2, 3, 4;

comment on view public.unparsed_gaps is
  'Failure corpus rolled up by site / stage / reason / status. Order by total_occurrences to find the highest-value parser to write next. security_invoker so the base table RLS still applies.';

revoke all on public.unparsed_gaps from anon, authenticated;
grant select on public.unparsed_gaps to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. shares -- short public links to a single hand
-- ---------------------------------------------------------------------------
--
-- A share is a capability URL: knowing the slug is the authorization. The table
-- is therefore completely sealed off from the anon role (RLS on, zero policies,
-- all grants revoked). Creation and resolution happen through definer RPCs, so
-- a caller can only ever touch the one row whose slug it already knows -- no
-- enumeration, no bulk dump.

create table public.shares (
  id   uuid primary key default extensions.gen_random_uuid(),
  slug text not null,

  -- Exactly one of these two is the payload source:
  --   hand_id  -- the hand is in `hands`; share stays in sync with it.
  --   phf      -- the hand was never saved (offline / opt-out); embed a copy.
  hand_id uuid references public.hands(id) on delete cascade,
  phf     jsonb,
  standard_text text,

  title text,

  views          integer not null default 0,
  created_at     timestamptz not null default now(),
  last_viewed_at timestamptz,

  constraint shares_slug_shape   check (slug ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$'),
  constraint shares_has_payload  check (hand_id is not null or phf is not null),
  constraint shares_phf_object   check (phf is null or jsonb_typeof(phf) = 'object'),
  constraint shares_phf_size     check (phf is null or octet_length(phf::text) <= 1048576),
  constraint shares_text_size    check (standard_text is null or char_length(standard_text) <= 200000),
  constraint shares_title_len    check (title is null or char_length(title) <= 200),
  constraint shares_views_ok     check (views >= 0)
);

create unique index shares_slug_uidx on public.shares (slug);
create index shares_hand_idx       on public.shares (hand_id) where hand_id is not null;
create index shares_created_at_idx on public.shares (created_at desc);

comment on table public.shares is
  'Short-slug public links to one hand. Sealed from anon: RLS on with no policies, access only via create_share() / resolve_share().';
comment on column public.shares.slug is
  'URL-safe slug from a 31-character ambiguity-free alphabet, generated server-side with a CSPRNG.';

alter table public.shares enable row level security;
revoke all on public.shares from anon, authenticated;
-- No policies at all. Intentional: see the table comment.

-- ---------------------------------------------------------------------------
-- 8. RPCs
-- ---------------------------------------------------------------------------

-- 8.1 save_hands ------------------------------------------------------------
-- Insert a batch of converted hands in one round trip, deduping on hand_key.
-- Returns exact counts so the client does not need a pre-flight "which of
-- these already exist" probe (the old handStore.ts burned one request per 200
-- hands on exactly that).
create or replace function public.save_hands(p_hands jsonb)
returns jsonb
language plpgsql
-- security invoker: inserts must remain subject to the hands RLS policy and
-- the rate-limit trigger. This function is convenience + atomic counting only,
-- it grants nothing the caller does not already have.
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
      currency, currency_minor_units, currency_symbol,
      small_blind, big_blind, ante, stakes_label,
      table_name, max_seats, played_at,
      hero_name, hero_seat, hero_position, hero_cards, hero_hand_class,
      board_cards, player_names, player_count,
      street_reached, went_to_showdown, total_pot, rake, hero_profit, winners,
      source_filename
    )
    select
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

-- 8.2 search_hands ----------------------------------------------------------
-- The browse UI filter set, plus the total row count, in one round trip.
-- Expressed server-side because (a) the client would otherwise need a separate
-- HEAD request for the count, and (b) the sort whitelist keeps the query on an
-- index instead of whatever PostgREST params the UI happens to build.
--
-- The heavy columns (phf, standard_text, source_text) are deliberately NOT in
-- the list projection: a page of 50 hands should be kilobytes, not megabytes.
create or replace function public.search_hands(
  p_filters jsonb default '{}'::jsonb,
  p_limit   integer default 25,
  p_offset  integer default 0
)
returns jsonb
language plpgsql
stable
-- security invoker: reads only, RLS on hands already allows public select.
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

  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;

  -- Whitelisted sort keys only; nothing from p_filters is ever interpolated.
  -- Unprefixed column names so the same string works both inside the scan
  -- (alias h) and in the outer jsonb_agg ORDER BY (subquery x).
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
  $w$;

  execute 'select count(*) from public.hands h ' || v_where
    into v_total
    using v_site, v_board, v_hero_cards, v_hero_class, v_player, v_hero_name,
          v_table, v_variant, v_format, v_big_blind, v_street, v_showdown,
          v_hero_won, v_min_pot, v_from, v_to, v_limit_type, v_tourney;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(x) order by %1$s), '[]'::jsonb)
    from (
      select
        h.id, h.hand_key, h.site, h.site_hand_id, h.variant, h.limit_type,
        h.game_format, h.tournament_id,
        h.currency, h.currency_minor_units, h.currency_symbol,
        h.small_blind, h.big_blind, h.ante, h.stakes_label,
        h.table_name, h.max_seats, h.played_at,
        h.hero_name, h.hero_seat, h.hero_position, h.hero_cards, h.hero_hand_class,
        h.board_cards, h.player_names, h.player_count,
        h.street_reached, h.went_to_showdown, h.total_pot, h.rake, h.hero_profit,
        h.winners, h.schema_version, h.parser_version, h.source_filename, h.created_at
      from public.hands h
      %2$s
      order by %1$s
      offset $19::integer limit $20::integer
    ) x
  $q$, v_order, v_where)
    into v_rows
    using v_site, v_board, v_hero_cards, v_hero_class, v_player, v_hero_name,
          v_table, v_variant, v_format, v_big_blind, v_street, v_showdown,
          v_hero_won, v_min_pot, v_from, v_to, v_limit_type, v_tourney,
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
  'Filtered, sorted, paginated hand list plus total count in one call. Heavy columns (phf / standard_text / source_text) are excluded from the projection.';

-- 8.3 get_hand --------------------------------------------------------------
-- Full payload for the replayer, including PHF and the rendered standard text.
create or replace function public.get_hand(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select to_jsonb(h) from public.hands h where h.id = p_id;
$$;

comment on function public.get_hand(uuid) is
  'Full hand row (including phf and standard_text) by id.';

-- 8.4 hands_facets ----------------------------------------------------------
-- Distinct filter values for the browse UI, one round trip. Replaces
-- stored_hands_facets().
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
    'playedAtRange', (
      select jsonb_build_object('min', min(played_at), 'max', max(played_at)) from public.hands
    ),
    'unparsedTotal', (select count(*) from public.unparsed_hands)
  );
$$;

comment on function public.hands_facets() is
  'Every distinct filter value the browse UI offers, in one round trip.';

-- 8.5 record_conversion_failures -------------------------------------------
-- Upsert a batch of ConversionFailure records, incrementing the occurrence
-- counter atomically for fingerprints we have already seen.
create or replace function public.record_conversion_failures(p_failures jsonb)
returns jsonb
language plpgsql
-- security definer: the anon role has SELECT but no INSERT/UPDATE on
-- unparsed_hands, precisely so a caller cannot forge an occurrence count or
-- flip `status`. This function is the only write path, and it whitelists the
-- columns it touches: status and notes are never written here, and nothing is
-- ever deleted. Inputs are bound as parameters, never concatenated.
security definer
set search_path = ''
as $$
declare
  v_received integer;
  v_new      integer;
  v_touched  integer;
begin
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

  -- 5 000 failure records / 10 min: generous for a bad bulk upload, still a
  -- ceiling on someone using the endpoint as free blob storage.
  perform public.enforce_rate_limit('unparsed_insert', v_received, 5000, interval '10 minutes');

  -- Everything below is truncated rather than rejected: recording a failure
  -- must never itself fail, or we silently lose the reference material that is
  -- the whole point of this table.
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
      stage, reason, message, parser_version, source_filename
    )
    select
      d.fingerprint, d.raw_text, d.detected_site, d.detection_confidence,
      d.stage, d.reason, d.message, d.parser_version, d.source_filename
    from deduped d
    on conflict (fingerprint) do update
      set occurrences   = u.occurrences + 1,
          last_seen_at  = now(),
          -- Refresh diagnostics: a newer parser version may classify the same
          -- text differently, and that is the interesting signal. `status` and
          -- `notes` are never touched here -- triage state belongs to humans.
          stage          = excluded.stage,
          reason         = excluded.reason,
          message        = excluded.message,
          parser_version = excluded.parser_version,
          detected_site  = coalesce(excluded.detected_site, u.detected_site),
          detection_confidence = coalesce(excluded.detection_confidence, u.detection_confidence),
          source_filename = coalesce(u.source_filename, excluded.source_filename)
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert)::integer, count(*)::integer
  into v_new, v_touched
  from upserted;

  -- `skipped` covers records the filters above threw away: a malformed
  -- fingerprint, empty text, or text past the 128 KiB cap. They are counted
  -- rather than raised so a bulk upload never dies on one bad record, but the
  -- client can still surface "n failures could not be recorded".
  return jsonb_build_object(
    'received', v_received,
    'created',  coalesce(v_new, 0),
    'updated',  coalesce(v_touched, 0) - coalesce(v_new, 0),
    'skipped',  v_received - coalesce(v_touched, 0)
  );
end;
$$;

revoke all on function public.record_conversion_failures(jsonb) from public;

comment on function public.record_conversion_failures(jsonb) is
  'Upsert ConversionFailure records by fingerprint, incrementing occurrences atomically. Returns {received, created, updated}.';

-- 8.6 unparsed_summary ------------------------------------------------------
-- Convenience RPC over unparsed_gaps for the triage UI (one round trip, sorted
-- by impact). The view is also directly selectable if a client wants raw rows.
create or replace function public.unparsed_summary(p_limit integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'total',       (select count(*) from public.unparsed_hands),
    'occurrences', (select coalesce(sum(occurrences), 0) from public.unparsed_hands),
    'byStatus', (
      select coalesce(jsonb_object_agg(status::text, n), '{}'::jsonb)
      from (select status, count(*) as n from public.unparsed_hands group by status) s
    ),
    'gaps', (
      select coalesce(jsonb_agg(to_jsonb(g) order by g.total_occurrences desc), '[]'::jsonb)
      from (
        select * from public.unparsed_gaps
        order by total_occurrences desc
        limit least(greatest(coalesce(p_limit, 50), 1), 500)
      ) g
    )
  );
$$;

comment on function public.unparsed_summary(integer) is
  'Failure corpus rolled up by site/stage/reason, ordered by impact. The answer to "which converter do we build next".';

-- 8.7 slug generation -------------------------------------------------------
-- 31-character alphabet: digits 2-9 and lowercase letters minus i, l, o, 0, 1
-- so a slug can be read aloud or retyped without ambiguity.
-- 10 chars -> 31^10 ~= 8.2e14 combinations; collisions are handled by retry
-- anyway, so the unique index is the real guarantee.
create or replace function public.generate_share_slug(p_length integer default 10)
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(
    substr('23456789abcdefghjkmnpqrstuvwxyz',
           1 + (get_byte(b.bytes, g.i) % 31), 1), '')
  from (select extensions.gen_random_bytes(greatest(coalesce(p_length, 10), 8)) as bytes) b,
       generate_series(0, greatest(coalesce(p_length, 10), 8) - 1) as g(i);
$$;

revoke all on function public.generate_share_slug(integer) from public;

comment on function public.generate_share_slug(integer) is
  'CSPRNG slug over an ambiguity-free 31-character alphabet. Server-side only.';

-- 8.8 create_share ----------------------------------------------------------
create or replace function public.create_share(
  p_hand_id       uuid  default null,
  p_phf           jsonb default null,
  p_standard_text text  default null,
  p_title         text  default null
)
returns jsonb
language plpgsql
-- security definer: `shares` is sealed (RLS on, no policies, no grants) so the
-- anon key cannot enumerate share slugs. Creation must therefore run elevated.
-- It only ever INSERTs one row, generates the slug itself (a caller cannot
-- choose or guess a slug into existence), and returns just that row.
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_id   uuid;
  v_phf  jsonb := p_phf;
  v_text text   := p_standard_text;
begin
  if p_hand_id is null and p_phf is null then
    raise exception 'create_share needs either a hand id or an embedded PHF payload'
      using errcode = '22023';
  end if;

  -- 300 shares / hour globally. Share creation is a human action; nobody
  -- legitimately makes five a minute for an hour.
  perform public.enforce_rate_limit('share_create', 1, 300, interval '1 hour');

  if p_hand_id is not null then
    if not exists (select 1 from public.hands h where h.id = p_hand_id) then
      raise exception 'No stored hand with id %', p_hand_id using errcode = '23503';
    end if;
    -- Referenced hands stay in sync with `hands`; do not duplicate the payload.
    v_phf  := null;
    v_text := null;
  end if;

  for i in 1..8 loop
    v_slug := public.generate_share_slug(10);
    begin
      insert into public.shares (slug, hand_id, phf, standard_text, title)
      values (v_slug, p_hand_id, v_phf, v_text, nullif(btrim(coalesce(p_title, '')), ''))
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

comment on function public.create_share(uuid, jsonb, text, text) is
  'Creates a share link with a server-generated slug. Pass a hand id for stored hands, or an embedded PHF payload for hands that were never saved.';

-- 8.9 resolve_share ---------------------------------------------------------
create or replace function public.resolve_share(p_slug text)
returns jsonb
language plpgsql
-- security definer: two reasons. (1) `shares` has no anon grants, so nothing
-- else can read it -- and that is what stops slug enumeration: the only way in
-- is to already know a slug. (2) Bumping `views` is an UPDATE, which anon must
-- never have on any table. The function is keyed strictly by slug equality and
-- returns exactly one row, so it cannot be turned into a table dump.
security definer
set search_path = ''
as $$
declare
  v_share public.shares%rowtype;
  v_hand  jsonb;
begin
  if p_slug is null or p_slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$' then
    return null;
  end if;

  update public.shares s
     set views = s.views + 1,
         last_viewed_at = now()
   where s.slug = p_slug
  returning s.* into v_share;

  if v_share.id is null then
    return null;
  end if;

  if v_share.hand_id is not null then
    select to_jsonb(h) into v_hand from public.hands h where h.id = v_share.hand_id;
  end if;

  return jsonb_build_object(
    'slug',         v_share.slug,
    'title',        v_share.title,
    'views',        v_share.views,
    'createdAt',    v_share.created_at,
    'handId',       v_share.hand_id,
    -- One of these is always populated: the stored hand's payload, or the
    -- copy embedded at share time.
    'hand',         v_hand,
    'phf',          coalesce(v_hand -> 'phf', v_share.phf),
    'standardText', coalesce(v_hand ->> 'standard_text', v_share.standard_text)
  );
end;
$$;

revoke all on function public.resolve_share(text) from public;

comment on function public.resolve_share(text) is
  'Resolves a share slug in one round trip and increments its view counter. Returns null for unknown slugs.';

-- ---------------------------------------------------------------------------
-- 9. Grants on the RPCs
-- ---------------------------------------------------------------------------
-- `create function` grants EXECUTE to PUBLIC by default, which is too loose for
-- the definer functions. Every one above was revoked from public; grant them
-- back explicitly to the two roles the app actually uses.

grant execute on function public.save_hands(jsonb)                       to anon, authenticated;
grant execute on function public.search_hands(jsonb, integer, integer)   to anon, authenticated;
grant execute on function public.get_hand(uuid)                          to anon, authenticated;
grant execute on function public.hands_facets()                          to anon, authenticated;
grant execute on function public.record_conversion_failures(jsonb)       to anon, authenticated;
grant execute on function public.unparsed_summary(integer)               to anon, authenticated;
grant execute on function public.create_share(uuid, jsonb, text, text)   to anon, authenticated;
grant execute on function public.resolve_share(text)                     to anon, authenticated;
grant execute on function public.is_card_array(text[])                   to anon, authenticated;
grant execute on function public.normalize_cards(text[])                 to anon, authenticated;

-- Never exposed to the client: these are internals of the definer functions.
-- enforce_rate_limit would let anyone burn the shared insert budget on purpose
-- (a trivial denial of service), and generate_share_slug has no client use.
--
-- `revoke ... from public` is not enough here: Supabase ships
-- `alter default privileges in schema public grant all on functions to anon,
-- authenticated, service_role`, so both roles get an explicit EXECUTE grant at
-- creation time that survives a PUBLIC revoke. Revoke them by name.
revoke execute on function public.enforce_rate_limit(text, integer, integer, interval) from anon, authenticated;
revoke execute on function public.generate_share_slug(integer)                          from anon, authenticated;
grant  execute on function public.enforce_rate_limit(text, integer, integer, interval) to service_role;
grant  execute on function public.generate_share_slug(integer)                          to service_role;

-- Trigger functions cannot be invoked directly (Postgres refuses a non-trigger
-- call), but there is no reason for them to carry a client-facing grant.
revoke execute on function public.hands_rate_limit() from public, anon, authenticated;
revoke execute on function public.hands_normalize()  from public, anon, authenticated;
