-- ===========================================================================
-- Sessions, bankroll and opponent notes (F14, #54)
-- ===========================================================================
--
-- Three features over data that is already stored.
--
-- ## Sessions are computed, not stored
--
-- A session is a run of the caller's hands with no gap longer than
-- `p_gap_minutes` between consecutive ones, across every table at once -- a
-- multi-tabler's evening is one session, not six. `played_at` is already on
-- every hero row of `hand_stats`, so this is a window function, and there is
-- nothing to keep in sync when a hand is uploaded late or a gap is redefined.
--
-- The bankroll is the running sum of those sessions' results. It is money, so
-- the refusals are the usual two (`stats_summary`): chips with cash carry no
-- money at all, and a sample in two currencies carries big blinds only. Unlike
-- the HUD, bomb pots and straddles are **in**: a bankroll is what happened to
-- the money, not a model of how you play.
--
-- ## Notes stay private, and only attach to real identities
--
-- `player_notes` is the caller's own, readable by nobody else (see the ToS
-- posture: a shared note on a named player is a different product with a
-- different legal shape).
--
-- A note can only be written on a player the caller has actually sat with in a
-- room whose names are persistent screen names (`site_anonymization = 'none'`).
-- For a `positional` room (Ignition) the "name" is a seat label that is a
-- different human every hand, and a note on it would attach to whoever sits
-- there next; for `opaque-id` (GGPoker) it would attach to a session token. The
-- feature is disabled for both -- refused by the database, not just hidden.
-- ===========================================================================

begin;

-- -------------------------------------------------------------- sessions ---

create or replace function public.stats_sessions(
  p_filters     jsonb   default '{}'::jsonb,
  p_gap_minutes integer default 30
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_format   public.game_format;
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_gap      interval := make_interval(mins => least(greatest(coalesce(p_gap_minutes, 30), 5), 720));
  v_rows     jsonb;
  v_kinds    integer;
  v_currencies integer;
  v_currency_out text;
  v_minor    integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;

  select count(distinct (hs.game_format = 'cash')), count(distinct hs.currency),
         min(hs.currency), min(hs.currency_minor_units)
  into v_kinds, v_currencies, v_currency_out, v_minor
  from public.hand_stats hs
  where hs.owner_id = v_owner and hs.stats_version = v_version and hs.is_hero
    and hs.played_at is not null
    and (v_format is null or hs.game_format = v_format)
    and (v_currency is null or hs.currency = v_currency)
    and (v_big_blind is null or hs.big_blind = v_big_blind);

  with h as (
    select hs.played_at, hs.table_name, hs.has_cashout, hs.net, hs.net_bb_milli
    from public.hand_stats hs
    where hs.owner_id = v_owner and hs.stats_version = v_version and hs.is_hero
      and hs.played_at is not null
      and (v_format is null or hs.game_format = v_format)
      and (v_currency is null or hs.currency = v_currency)
      and (v_big_blind is null or hs.big_blind = v_big_blind)
  ),
  marked as (
    select h.*,
           case when lag(h.played_at) over w is null
                  or h.played_at - lag(h.played_at) over w > v_gap
                then 1 else 0 end as starts
    from h
    window w as (order by h.played_at)
  ),
  numbered as (
    select m.*, sum(m.starts) over (order by m.played_at rows unbounded preceding) as session
    from marked m
  ),
  sessions as (
    select n.session,
           min(n.played_at) as started_at,
           max(n.played_at) as ended_at,
           count(*) as hands,
           count(distinct n.table_name) as tables,
           -- An EV-cashout hand's pot is not its result; same rule as the graph.
           coalesce(sum(n.net_bb_milli) filter (where not n.has_cashout), 0) as net_bb_milli,
           coalesce(sum(n.net) filter (where not n.has_cashout), 0) as net
    from numbered n
    group by n.session
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'startedAt',  s.started_at,
           'endedAt',    s.ended_at,
           'hands',      s.hands,
           'tables',     s.tables,
           'netBbMilli', case when v_kinds > 1 then null else s.net_bb_milli end,
           'net',        case when v_kinds > 1 or v_currencies > 1 then null else s.net end
         ) order by s.session desc), '[]'::jsonb)
  into v_rows
  from (select * from sessions order by session desc limit 2000) s;

  return jsonb_build_object(
    'gapMinutes',         extract(epoch from v_gap)::integer / 60,
    'sessions',           v_rows,
    'mixedUnitKind',      coalesce(v_kinds, 0) > 1,
    'mixedCurrency',      coalesce(v_currencies, 0) > 1,
    'currency',           case when coalesce(v_kinds, 0) > 1 or coalesce(v_currencies, 0) > 1 then null else v_currency_out end,
    'currencyMinorUnits', case when coalesce(v_kinds, 0) > 1 or coalesce(v_currencies, 0) > 1 then null else v_minor end
  );
end;
$$;

comment on function public.stats_sessions(jsonb, integer) is
  'The caller''s hands grouped into sessions by time gap (across tables), newest '
  'first, with results; the bankroll is their running sum.';

revoke all on function public.stats_sessions(jsonb, integer) from public, anon;
grant execute on function public.stats_sessions(jsonb, integer) to authenticated;

-- ----------------------------------------------------------------- notes ---

create table if not exists public.player_notes (
  owner_id   uuid not null references auth.users (id) on delete cascade,
  site       text not null check (char_length(site) between 1 and 40),
  player     text not null check (char_length(player) between 1 and 80),
  note       text not null default '' check (char_length(note) <= 2000),
  tags       text[] not null default '{}' check (
    cardinality(tags) <= 8
    and array_to_string(tags, '') !~ '[[:cntrl:]]'
  ),
  updated_at timestamptz not null default now(),
  primary key (owner_id, site, player)
);

alter table public.player_notes enable row level security;
revoke all on public.player_notes from anon, authenticated;
grant select on public.player_notes to authenticated;

create policy player_notes_own on public.player_notes
  for select to authenticated using (owner_id = (select auth.uid()));

-- The one writer. Definer, because the table grants no INSERT or UPDATE: a note
-- is edited in place, and the no-UPDATE rule is kept by funnelling that edit
-- through a function that can only touch the caller's own row. Clearing a note
-- (empty text, no tags) removes the row -- the caller's own, keyed by the
-- caller, and recoverable by writing it again.
create or replace function public.set_player_note(
  p_site   text,
  p_player text,
  p_note   text,
  p_tags   text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_note text := btrim(coalesce(p_note, ''));
  v_tags text[];
begin
  if v_uid is null then
    raise exception 'Sign in to keep notes.' using errcode = '42501';
  end if;
  if char_length(v_note) > 2000 then
    raise exception 'Notes are at most 2,000 characters.' using errcode = '22023';
  end if;
  v_tags := (select coalesce(array_agg(distinct lower(btrim(t))) filter (where btrim(t) <> ''), '{}'::text[])
             from unnest(coalesce(p_tags, '{}'::text[])) t);
  if cardinality(v_tags) > 8 or exists (select 1 from unnest(v_tags) t where char_length(t) > 24) then
    raise exception 'Up to eight tags of 24 characters.' using errcode = '22023';
  end if;

  -- The identity rule from the header: a player you have sat with, in a room
  -- whose names are names. `hands.player_names` is empty for positional
  -- rooms by constraint, so they can never pass.
  if not exists (
    select 1 from public.hands h
    where h.owner_id = v_uid and h.site = p_site
      and h.site_anonymization = 'none'
      and p_player = any (h.player_names)
  ) then
    raise exception 'Notes are for players you have played with, in rooms that show real screen names.'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('note:' || v_uid::text, 1, 300, interval '1 hour');

  if v_note = '' and cardinality(v_tags) = 0 then
    delete from public.player_notes where owner_id = v_uid and site = p_site and player = p_player;
    return null;
  end if;

  insert into public.player_notes (owner_id, site, player, note, tags, updated_at)
  values (v_uid, p_site, p_player, v_note, v_tags, now())
  on conflict (owner_id, site, player)
  do update set note = excluded.note, tags = excluded.tags, updated_at = now();

  return jsonb_build_object('site', p_site, 'player', p_player, 'note', v_note, 'tags', to_jsonb(v_tags));
end;
$$;

revoke all on function public.set_player_note(text, text, text, text[]) from public, anon;
grant execute on function public.set_player_note(text, text, text, text[]) to authenticated;

create or replace function public.my_player_notes(p_site text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'site', n.site, 'player', n.player, 'note', n.note,
           'tags', to_jsonb(n.tags), 'updatedAt', n.updated_at
         ) order by n.updated_at desc), '[]'::jsonb)
  from public.player_notes n
  where n.owner_id = (select auth.uid())
    and (p_site is null or n.site = p_site);
$$;

revoke all on function public.my_player_notes(text) from public, anon;
grant execute on function public.my_player_notes(text) to authenticated;

commit;
