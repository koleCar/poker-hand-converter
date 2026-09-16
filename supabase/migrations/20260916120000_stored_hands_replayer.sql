-- Replayer-oriented hand store.
--
-- The original `hands` table is upload-scoped and gated behind auth.users RLS.
-- The app has no login, so the replayer needs its own flat, search-optimised
-- table that the anon key can read and write.

create table if not exists public.stored_hands (
  id uuid primary key default gen_random_uuid(),

  -- Stable dedupe key: normalized hand id (e.g. "HD2735984596").
  hand_key text not null unique,
  source_hand_id text,
  source text not null default 'weplay',

  game_type public.game_type not null default 'cash',
  game_label text,
  table_name text,
  max_seats integer,
  played_at timestamptz,

  currency text not null default '$',
  small_blind numeric(14, 2),
  big_blind numeric(14, 2),

  hero_name text,
  hero_cards text[] not null default '{}',
  -- Canonical starting-hand class: "AKs", "AKo", "TT".
  hero_hand_class text,

  board_cards text[] not null default '{}',
  player_names text[] not null default '{}',
  player_count integer,

  street_reached text,
  went_to_showdown boolean not null default false,

  total_pot numeric(14, 2),
  rake numeric(14, 2),
  hero_profit numeric(14, 2),
  winners text[] not null default '{}',

  -- Canonical GG-format text; the replayer re-parses this.
  hand_text text not null,
  -- Original pre-conversion text when the hand came from WePlay.
  source_text text,
  -- Structured parse cached at save time.
  parsed jsonb,

  source_filename text,
  created_at timestamptz not null default now()
);

create index if not exists stored_hands_board_idx on public.stored_hands using gin (board_cards);
create index if not exists stored_hands_hero_cards_idx on public.stored_hands using gin (hero_cards);
create index if not exists stored_hands_players_idx on public.stored_hands using gin (player_names);
create index if not exists stored_hands_played_at_idx on public.stored_hands (played_at desc nulls last);
create index if not exists stored_hands_created_at_idx on public.stored_hands (created_at desc);
create index if not exists stored_hands_hand_class_idx on public.stored_hands (hero_hand_class);
create index if not exists stored_hands_table_idx on public.stored_hands (table_name);

alter table public.stored_hands enable row level security;

-- No auth in the app: the anon key is the only client, and the deployed bundle
-- is public, so anyone can read it. Read and insert are therefore open, while
-- update and delete are deliberately NOT granted — the worst a stranger can do
-- is add junk rows, never destroy stored hands. Cleanup happens via the
-- service role (Supabase dashboard / SQL editor).
drop policy if exists stored_hands_anon_select on public.stored_hands;
create policy stored_hands_anon_select on public.stored_hands
for select to anon, authenticated
using (true);

drop policy if exists stored_hands_anon_insert on public.stored_hands;
create policy stored_hands_anon_insert on public.stored_hands
for insert to anon, authenticated
with check (true);

-- Distinct filter values for the browser UI, in one round trip.
create or replace function public.stored_hands_facets()
returns jsonb
language sql
stable
security invoker
as $$
  select jsonb_build_object(
    'total', (select count(*) from public.stored_hands),
    'heroes', (
      select coalesce(jsonb_agg(distinct hero_name order by hero_name), '[]'::jsonb)
      from public.stored_hands
      where hero_name is not null
    ),
    'tables', (
      select coalesce(jsonb_agg(distinct table_name order by table_name), '[]'::jsonb)
      from public.stored_hands
      where table_name is not null
    ),
    'stakes', (
      select coalesce(jsonb_agg(distinct big_blind order by big_blind), '[]'::jsonb)
      from public.stored_hands
      where big_blind is not null
    )
  );
$$;

grant execute on function public.stored_hands_facets() to anon, authenticated;
