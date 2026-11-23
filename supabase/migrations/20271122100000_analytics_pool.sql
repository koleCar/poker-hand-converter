-- ============================================================================
-- Analytics Step 10: the Pool tab (docs/ANALYTICS.md §5 Step 10).
-- ============================================================================
--
-- How the caller's opponents play the Analytics catalogue's rates
-- (`config/stats/analytics.json`), by Rail's player types, against the
-- caller's own targets; and the regs' win rate with a measured standard
-- error.
--
-- ## Why new tables, written from the browser
--
--   * The rates are predicates over the hand's decision events (raise
--     levels, steals, the cbet chain, a checked-through street): SQL cannot
--     derive them from `hand_stats` or `hand_facts`. The browser counts them
--     (`web/src/lib/db/poolCounts.ts`: `ANALYTICS.counts(handEvents(hand),
--     seat)` on every named opponent's seat, the counter the desktop's custom
--     pass counts into `custom_player_rollups`) and writes them through
--     `analytics_pool_save`, a page at a time while the Pool tab is open
--     (`analytics_pool_pending` is its work list), as Step 2's checker rows.
--   * Summed per opponent as they are written, like `player_stats` (the
--     villain rows' sums): what the tab reads is a few rows per opponent, not
--     a row per seat. The opponent's type is not stored: it comes from
--     `player_stats` when the tab reads (the Hands filter's "vs type" rule),
--     so it follows the opponent's numbers as hands arrive.
--   * Each seat's result and its square in big blinds are summed too: the
--     regs' bb/100 gets a standard error from their measured spread, not an
--     assumed one (`lib/stats/reliability.ts` refuses that).
--
-- ## Tables
--
--   * `pool_counted_hands` - one row per hand the browser counted, at a
--     membership version (`ANALYTICS_MEMBERSHIP_VERSION`), with opponents or
--     not. A hand deleted takes its row with it (cascade); a statement
--     trigger then empties the owner's pool and its marks, so the next visit
--     counts every hand again (the sums cannot take one hand's part out).
--   * `pool_players` - per (owner, version, room, player, format): hands,
--     Σ result and Σ result² (bb), of the hands whose money counts.
--   * `pool_player_stats` - per (owner, version, room, player, format, rate):
--     made and opportunities.
--
-- ## Functions (every one Pro, `require_entitlement('analysis')`)
--
--   analytics_pool_save(p_version, p_hands jsonb)     definer writer
--   analytics_pool_pending(p_version, p_after, p_limit)
--                                                    the browser's work list
--   analytics_pool(p_filters jsonb)                  the tab's sums
--
-- The filters: `gameFormat` / `gameKind` (`filter_formats`), `sites`, and
-- `membershipVersion` (default analytics/1), `statsVersion` (the
-- `player_stats` version the types are read from, default stats/1).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.pool_counted_hands (
  hand_id            uuid        primary key references public.hands (id) on delete cascade,
  owner_id           uuid        not null references auth.users (id) on delete cascade,
  membership_version text        not null check (membership_version ~ '^analytics/[0-9]+$'),
  saved_at           timestamptz not null default now()
);

comment on table public.pool_counted_hands is
  'Analytics Step 10: a hand whose opponents the browser counted into pool_players / pool_player_stats at '
  'membership_version. Written by analytics_pool_save; a hand without a row at the current version is pending.';

create index if not exists pool_counted_hands_owner_idx on public.pool_counted_hands (owner_id, membership_version);

create table if not exists public.pool_players (
  owner_id           uuid             not null references auth.users (id) on delete cascade,
  membership_version text             not null check (membership_version ~ '^analytics/[0-9]+$'),
  site_id            text             not null,
  player             text             not null check (player <> '' and length(player) <= 100),
  game_format        text             not null,
  hands              bigint           not null default 0,
  net_bb             double precision not null default 0,
  net_bb_sq          double precision not null default 0,
  primary key (owner_id, membership_version, site_id, player, game_format)
);

comment on table public.pool_players is
  'Analytics Step 10: each named opponent''s seats in the caller''s hands (bomb pots out; an EV cashout''s result '
  'not counted), per room and format: hands, sum of results and of their squares (big blinds).';

create table if not exists public.pool_player_stats (
  owner_id           uuid   not null references auth.users (id) on delete cascade,
  membership_version text   not null check (membership_version ~ '^analytics/[0-9]+$'),
  site_id            text   not null,
  player             text   not null check (player <> '' and length(player) <= 100),
  game_format        text   not null,
  -- A catalogue rate.
  stat               text   not null check (stat ~ '^[a-z][a-z0-9_]{0,47}$'),
  made               bigint not null default 0,
  opp                bigint not null default 0,
  primary key (owner_id, membership_version, site_id, player, game_format, stat)
);

comment on table public.pool_player_stats is
  'Analytics Step 10: each named opponent''s counts of the catalogue''s rates in the caller''s hands, per room and '
  'format (made, opportunities). Counted in the browser (poolCounts.ts), written by analytics_pool_save.';

do $$
declare
  t text;
begin
  foreach t in array array['pool_counted_hands', 'pool_players', 'pool_player_stats'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))',
                   t || '_owner_select', t);
  end loop;
end;
$$;

-- A hand deleted (its mark goes by cascade): the owner's pool is emptied and
-- counted again from every hand on the next visit. The sums cannot take one
-- hand's part out, and a stale pool would outlive the hands it came from.
create or replace function public.pool_counted_hands_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The reset's own delete of the marks fires this again: once is enough.
  if coalesce(current_setting('rail.pool_reset', true), '') = 'on' then
    return null;
  end if;
  perform set_config('rail.pool_reset', 'on', true);
  delete from public.pool_player_stats s where s.owner_id in (select distinct g.owner_id from gone g);
  delete from public.pool_players p where p.owner_id in (select distinct g.owner_id from gone g);
  delete from public.pool_counted_hands c where c.owner_id in (select distinct g.owner_id from gone g);
  perform set_config('rail.pool_reset', '', true);
  return null;
end;
$$;

comment on function public.pool_counted_hands_reset() is
  'Analytics Step 10: a counted hand''s mark deleted (the hand went) empties its owner''s pool and marks.';

revoke all on function public.pool_counted_hands_reset() from public, anon, authenticated;

drop trigger if exists pool_counted_hands_reset on public.pool_counted_hands;
create trigger pool_counted_hands_reset
  after delete on public.pool_counted_hands
  referencing old table as gone
  for each statement execute function public.pool_counted_hands_reset();

-- ---------------------------------------------------------------------------
-- 2. The writer
-- ---------------------------------------------------------------------------
--
-- p_hands: at most 200 hands, each
--   { hand_id, players: [{ player, net_bb, stats: { <rate>: [made, opp] } }] }
-- (net_bb null: the hand's money does not count - an EV cashout - so the
-- player's rates count and their result does not, as on the desktop)
-- (at most 12 players a hand; a hand the browser could not read, or without
-- named opponents, comes with none). Per hand of the caller's: marked at
-- p_version, and its players' counts added - only when it was not marked at
-- that version already, so a page sent twice adds nothing. Rows of another
-- version are dropped first (the catalogue changed: everything is counted
-- again).

create or replace function public.analytics_pool_save(p_version text, p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_new      uuid[];
  v_players  integer;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to save your pool.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analytics/[0-9]+$' then
    raise exception 'analytics_pool_save needs a membership version.' using errcode = '22023';
  end if;
  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'analytics_pool_save expects a JSON array of hands.' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_hands);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'saved', 0, 'players', 0);
  end if;
  if v_received > 200 then
    raise exception 'analytics_pool_save accepts at most 200 hands per call (got %).', v_received
      using errcode = '53400';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'hand_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or jsonb_typeof(e -> 'players') is distinct from 'array'
       or jsonb_array_length(e -> 'players') > 12)
  then
    raise exception 'analytics_pool_save: a hand needs hand_id and players (at most 12).' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e, jsonb_array_elements(e -> 'players') pl
    where jsonb_typeof(pl) <> 'object'
       or jsonb_typeof(pl -> 'player') is distinct from 'string'
       or length(pl ->> 'player') not between 1 and 100
       or jsonb_typeof(pl -> 'net_bb') not in ('number', 'null')
       or abs(coalesce((pl ->> 'net_bb')::numeric, 0)) > 1000000
       or jsonb_typeof(pl -> 'stats') is distinct from 'object')
  then
    raise exception 'analytics_pool_save: a player needs player (1-100 characters), net_bb and stats.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e, jsonb_array_elements(e -> 'players') pl,
                  jsonb_each(pl -> 'stats') st(k, v)
    where st.k !~ '^[a-z][a-z0-9_]{0,47}$'
       or jsonb_typeof(st.v) is distinct from 'array' or jsonb_array_length(st.v) <> 2
       or jsonb_typeof(st.v -> 0) is distinct from 'number' or jsonb_typeof(st.v -> 1) is distinct from 'number'
       or (st.v ->> 0)::numeric not between 0 and 100 or (st.v ->> 1)::numeric not between 0 and 100
       or (st.v ->> 0)::numeric > (st.v ->> 1)::numeric
       or (st.v ->> 0)::numeric <> trunc((st.v ->> 0)::numeric)
       or (st.v ->> 1)::numeric <> trunc((st.v ->> 1)::numeric))
  then
    raise exception 'analytics_pool_save: a rate''s counts are [made, opportunities], whole numbers 0-100, made <= opportunities.'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('analytics_pool:' || v_owner::text, v_received, 200000, interval '10 minutes');

  -- Counted at another version: the catalogue changed, everything is counted again.
  delete from public.pool_player_stats where owner_id = v_owner and membership_version <> p_version;
  delete from public.pool_players where owner_id = v_owner and membership_version <> p_version;

  -- The caller's hands, marked now (not at this version before).
  with input as (
    select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id
    from jsonb_array_elements(p_hands) with ordinality as t(e, n)
    order by (e ->> 'hand_id')::uuid, n
  ), marked as (
    insert into public.pool_counted_hands as c (hand_id, owner_id, membership_version, saved_at)
    select i.hand_id, v_owner, p_version, now()
    from input i
    join public.hands h on h.id = i.hand_id and h.owner_id = v_owner
    on conflict (hand_id) do update
      set membership_version = excluded.membership_version, saved_at = excluded.saved_at
      where c.membership_version <> excluded.membership_version and c.owner_id = excluded.owner_id
    returning c.hand_id
  )
  select coalesce(array_agg(hand_id), '{}') into v_new from marked;

  with seats as (
    -- Their players: the first entry of a hand named twice, one row per name a hand.
    select distinct on (x.hand_id, pl ->> 'player')
           h.site as site_id, pl ->> 'player' as player, h.game_format::text as game_format,
           (pl ->> 'net_bb')::double precision as net_bb, pl -> 'stats' as stats
    from (
      select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id, e -> 'players' as players
      from jsonb_array_elements(p_hands) with ordinality as t(e, n)
      order by (e ->> 'hand_id')::uuid, n
    ) x
    join public.hands h on h.id = x.hand_id and h.owner_id = v_owner
    cross join lateral jsonb_array_elements(x.players) pl
    where x.hand_id = any (v_new)
    order by x.hand_id, pl ->> 'player'
  ), added as (
    insert into public.pool_players as p (owner_id, membership_version, site_id, player, game_format, hands, net_bb, net_bb_sq)
    select v_owner, p_version, s.site_id, s.player, s.game_format,
           count(s.net_bb), coalesce(sum(s.net_bb), 0), coalesce(sum(s.net_bb * s.net_bb), 0)
    from seats s
    group by s.site_id, s.player, s.game_format
    on conflict (owner_id, membership_version, site_id, player, game_format) do update
      set hands = p.hands + excluded.hands, net_bb = p.net_bb + excluded.net_bb, net_bb_sq = p.net_bb_sq + excluded.net_bb_sq
    returning 1
  )
  select (select count(*) from seats) into v_players;

  with seats as (
    -- Their players: the first entry of a hand named twice, one row per name a hand.
    select distinct on (x.hand_id, pl ->> 'player')
           h.site as site_id, pl ->> 'player' as player, h.game_format::text as game_format,
           (pl ->> 'net_bb')::double precision as net_bb, pl -> 'stats' as stats
    from (
      select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id, e -> 'players' as players
      from jsonb_array_elements(p_hands) with ordinality as t(e, n)
      order by (e ->> 'hand_id')::uuid, n
    ) x
    join public.hands h on h.id = x.hand_id and h.owner_id = v_owner
    cross join lateral jsonb_array_elements(x.players) pl
    where x.hand_id = any (v_new)
    order by x.hand_id, pl ->> 'player'
  )
  insert into public.pool_player_stats as p (owner_id, membership_version, site_id, player, game_format, stat, made, opp)
  select v_owner, p_version, s.site_id, s.player, s.game_format, st.k,
         sum((st.v ->> 0)::bigint), sum((st.v ->> 1)::bigint)
  from seats s
  cross join lateral jsonb_each(s.stats) st(k, v)
  where (st.v ->> 1)::bigint > 0
  group by s.site_id, s.player, s.game_format, st.k
  on conflict (owner_id, membership_version, site_id, player, game_format, stat) do update
    set made = p.made + excluded.made, opp = p.opp + excluded.opp;

  return jsonb_build_object('received', v_received, 'saved', cardinality(v_new), 'players', v_players);
end;
$$;

comment on function public.analytics_pool_save(text, jsonb) is
  'Analytics Step 10: marks up to 200 of the caller''s hands counted at a membership version and adds their '
  'opponents'' counts (hands, results, catalogue rates) to pool_players / pool_player_stats; a hand already marked '
  'at that version adds nothing.';

revoke all on function public.analytics_pool_save(text, jsonb) from public, anon;
grant execute on function public.analytics_pool_save(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The browser's work list
-- ---------------------------------------------------------------------------

create or replace function public.analytics_pool_pending(
  p_version text,
  p_after   uuid    default null,
  p_limit   integer default 100
)
returns table (
  id uuid, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_owner uuid := auth.uid();
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to count your pool.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analytics/[0-9]+$' then
    raise exception 'analytics_pool_pending needs a membership version.' using errcode = '22023';
  end if;

  return query
  select hd.id, public.analysis_trimmed_phf(hd.phf),
         case when hd.phf is null then hd.standard_text end,
         hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at
  from public.hands hd
  where hd.owner_id = v_owner
    and (p_after is null or hd.id > p_after)
    and not exists (
      select 1 from public.pool_counted_hands c
      where c.hand_id = hd.id and c.membership_version = p_version)
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.analytics_pool_pending(text, uuid, integer) is
  'Analytics Step 10: a page of the caller''s hands not counted into the pool at a membership version, as '
  'hands_needing_analysis returns them (the browser counts their opponents).';

revoke all on function public.analytics_pool_pending(text, uuid, integer) from public, anon;
grant execute on function public.analytics_pool_pending(text, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The reader
-- ---------------------------------------------------------------------------
--
-- {version, pending, reg: {players, hands, netBb, netBbSq}, fish: {...},
--  stats: [{stat, type, made, opp}]} - the opponents typed by Rail's rule over
-- their `player_stats` (every segment of the room: 30+ hands; fish VPIP >= 40;
-- reg VPIP 15-30 and PFR >= 0.6 VPIP), summed over the rooms and formats the
-- filters name. `pending`: the caller's hands not counted at the version.

create or replace function public.analytics_pool(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner   uuid := auth.uid();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_mv      text;
  v_formats text[];
  v_sites   text[];
  v_stats   text := coalesce(nullif(btrim(coalesce(v_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_pending bigint;
  v_out     jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read your pool.' using errcode = '42501';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'analytics_pool expects a JSON object of filters.' using errcode = '22023';
  end if;
  v_mv := public.analytics_membership_version_of(v_filters);
  v_formats := public.filter_formats(v_filters);
  if jsonb_typeof(v_filters -> 'sites') = 'array' and jsonb_array_length(v_filters -> 'sites') > 0 then
    v_sites := array(select jsonb_array_elements_text(v_filters -> 'sites'));
  end if;

  select count(*) into v_pending
  from public.hands h
  where h.owner_id = v_owner
    and not exists (select 1 from public.pool_counted_hands c where c.hand_id = h.id and c.membership_version = v_mv);

  with types as (
    select t.site_id, t.player,
           case when t.n >= 30 and t.vpip >= 40 then 'fish'
                when t.n >= 30 and t.vpip between 15 and 30 and t.pfr >= t.vpip * 0.6 then 'reg'
           end as kind
    from (
      select ps.site_id, ps.player,
             coalesce(sum(ps.hands), 0) as n,
             coalesce(sum(ps.vpip), 0) * 100.0 / greatest(coalesce(sum(ps.vpip_opp), 0), 1) as vpip,
             coalesce(sum(ps.pfr), 0) * 100.0 / greatest(coalesce(sum(ps.pfr_opp), 0), 1) as pfr
      from public.player_stats ps
      where ps.owner_id = v_owner and ps.stats_version = v_stats and ps.player <> ''
      group by ps.site_id, ps.player
    ) t
  ), members as (
    select p.site_id, p.player, ty.kind,
           sum(p.hands) as hands, sum(p.net_bb) as net_bb, sum(p.net_bb_sq) as net_bb_sq
    from public.pool_players p
    join types ty on ty.site_id = p.site_id and ty.player = p.player and ty.kind is not null
    where p.owner_id = v_owner and p.membership_version = v_mv
      and (v_formats is null or p.game_format = any (v_formats))
      and (v_sites is null or p.site_id = any (v_sites))
    group by p.site_id, p.player, ty.kind
    having sum(p.hands) > 0
  ), by_type as (
    select m.kind, count(*) as players, sum(m.hands) as hands, sum(m.net_bb) as net_bb, sum(m.net_bb_sq) as net_bb_sq
    from members m
    group by m.kind
  ), rates as (
    select s.stat, m.kind, sum(s.made) as made, sum(s.opp) as opp
    from public.pool_player_stats s
    join members m on m.site_id = s.site_id and m.player = s.player
    where s.owner_id = v_owner and s.membership_version = v_mv
      and (v_formats is null or s.game_format = any (v_formats))
      and (v_sites is null or s.site_id = any (v_sites))
    group by s.stat, m.kind
    having sum(s.opp) > 0
  )
  select jsonb_build_object(
    'version', v_mv,
    'pending', v_pending,
    'reg', coalesce((select jsonb_build_object('players', b.players, 'hands', b.hands, 'netBb', b.net_bb, 'netBbSq', b.net_bb_sq)
                     from by_type b where b.kind = 'reg'),
                    jsonb_build_object('players', 0, 'hands', 0, 'netBb', 0, 'netBbSq', 0)),
    'fish', coalesce((select jsonb_build_object('players', b.players, 'hands', b.hands, 'netBb', b.net_bb, 'netBbSq', b.net_bb_sq)
                      from by_type b where b.kind = 'fish'),
                     jsonb_build_object('players', 0, 'hands', 0, 'netBb', 0, 'netBbSq', 0)),
    'stats', coalesce((select jsonb_agg(jsonb_build_object('stat', r.stat, 'type', r.kind, 'made', r.made, 'opp', r.opp)
                                        order by r.stat collate "C", r.kind desc)
                       from rates r), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;

comment on function public.analytics_pool(jsonb) is
  'Analytics Step 10: the caller''s regs and fish (Rail''s types over player_stats) - players, hands, sum of results '
  'and of their squares - and their catalogue rates, over the rooms and formats named; hands still to count.';

revoke all on function public.analytics_pool(jsonb) from public, anon;
grant execute on function public.analytics_pool(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Pro, and the account's data
-- ---------------------------------------------------------------------------

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.analytics_pool_save(text,jsonb)', 'analysis', 'Analytics: the pool''s writer'),
  ('public.analytics_pool_pending(text,uuid,integer)', 'analysis', 'Analytics: the pool''s work list'),
  ('public.analytics_pool(jsonb)', 'analysis', 'Analytics: the Pool tab''s sums')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

select public.entitlement_gates_apply();

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.pool_counted_hands', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of hands: which hands the Pool tab counted.'),
  ('public.pool_players', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of hands: the opponents'' hands and results for the Pool tab.'),
  ('public.pool_player_stats', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of hands: the opponents'' catalogue rates for the Pool tab.')
on conflict (name) do nothing;
