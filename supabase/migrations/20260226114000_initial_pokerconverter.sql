create extension if not exists pgcrypto;

create type public.card_source as enum ('dealt', 'shown');
create type public.game_type as enum ('cash', 'tournament');

create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  upload_batch_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_site text not null default 'weplay',
  filename text not null,
  uploaded_at timestamptz not null default now(),
  raw_text_path text,
  warnings jsonb not null default '[]'::jsonb
);

create index uploads_batch_idx on public.uploads (upload_batch_id);
create index uploads_owner_idx on public.uploads (owner_id);

create table public.converted_files (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.uploads(id) on delete cascade,
  output_filename text not null,
  gg_text text not null,
  hand_count integer not null default 0,
  warning_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index converted_files_upload_idx on public.converted_files (upload_id);

create table public.hands (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.uploads(id) on delete cascade,
  source_hand_id text not null,
  game_type public.game_type not null,
  table_name text,
  played_at timestamptz,
  raw_hand_text text not null,
  gg_hand_text text not null
);

create index hands_upload_idx on public.hands (upload_id);
create index hands_source_hand_idx on public.hands (source_hand_id);

create table public.hand_players (
  id uuid primary key default gen_random_uuid(),
  hand_id uuid not null references public.hands(id) on delete cascade,
  player_name text not null,
  seat_no integer,
  stack_text text
);

create index hand_players_hand_idx on public.hand_players (hand_id);
create index hand_players_player_idx on public.hand_players (player_name);

create table public.player_cards (
  id uuid primary key default gen_random_uuid(),
  hand_id uuid not null references public.hands(id) on delete cascade,
  player_name text not null,
  card_1 text,
  card_2 text,
  source public.card_source not null,
  is_known boolean not null default true
);

create index player_cards_hand_idx on public.player_cards (hand_id);
create index player_cards_known_idx on public.player_cards (is_known, player_name);

create table public.hand_actions (
  id uuid primary key default gen_random_uuid(),
  hand_id uuid not null references public.hands(id) on delete cascade,
  street text,
  action_line text not null
);

create index hand_actions_hand_idx on public.hand_actions (hand_id);

create view public.upload_all_players as
select distinct
  u.upload_batch_id,
  hp.player_name
from public.hand_players hp
join public.hands h on h.id = hp.hand_id
join public.uploads u on u.id = h.upload_id;

create view public.upload_known_cards_players as
select distinct
  u.upload_batch_id,
  pc.player_name
from public.player_cards pc
join public.hands h on h.id = pc.hand_id
join public.uploads u on u.id = h.upload_id
where pc.is_known = true;

alter table public.uploads enable row level security;
alter table public.converted_files enable row level security;
alter table public.hands enable row level security;
alter table public.hand_players enable row level security;
alter table public.player_cards enable row level security;
alter table public.hand_actions enable row level security;

create policy uploads_owner_all on public.uploads
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy converted_files_owner_all on public.converted_files
for all
using (
  exists (
    select 1 from public.uploads u
    where u.id = converted_files.upload_id and u.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.uploads u
    where u.id = converted_files.upload_id and u.owner_id = auth.uid()
  )
);

create policy hands_owner_all on public.hands
for all
using (
  exists (
    select 1 from public.uploads u
    where u.id = hands.upload_id and u.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.uploads u
    where u.id = hands.upload_id and u.owner_id = auth.uid()
  )
);

create policy hand_players_owner_all on public.hand_players
for all
using (
  exists (
    select 1
    from public.hands h
    join public.uploads u on u.id = h.upload_id
    where h.id = hand_players.hand_id and u.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.hands h
    join public.uploads u on u.id = h.upload_id
    where h.id = hand_players.hand_id and u.owner_id = auth.uid()
  )
);

create policy player_cards_owner_all on public.player_cards
for all
using (
  exists (
    select 1
    from public.hands h
    join public.uploads u on u.id = h.upload_id
    where h.id = player_cards.hand_id and u.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.hands h
    join public.uploads u on u.id = h.upload_id
    where h.id = player_cards.hand_id and u.owner_id = auth.uid()
  )
);

create policy hand_actions_owner_all on public.hand_actions
for all
using (
  exists (
    select 1
    from public.hands h
    join public.uploads u on u.id = h.upload_id
    where h.id = hand_actions.hand_id and u.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.hands h
    join public.uploads u on u.id = h.upload_id
    where h.id = hand_actions.hand_id and u.owner_id = auth.uid()
  )
);
