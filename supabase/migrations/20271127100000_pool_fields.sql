-- ============================================================================
-- Field pool program P2: fields (docs/POOL.md §4, §5 P2).
-- ============================================================================
--
-- A field is where a hand was played: room · format · game and limit ·
-- table size · stake (the stake carries the currency: `USD:50`, or `chips`
-- off the cash tables) - the report segment's own columns, the values the
-- screen's filter already names. One text, `hands.field_key`:
--
--   ggpoker|cash|holdem|nl|6max|USD:50
--
-- Until now the owner's pool was summed per room and format, and a deleted
-- hand emptied it (the sums could not take one hand's part out; P1 queued
-- the whole library again). Here:
--
--   * `hands.field_key` - set by `hands_normalize` on insert, from the same
--     columns and rules as the report segment (`field_key_of`). Existing rows
--     are filled by `hands_field_key_backfill` (granted to nobody; the owner
--     runs it at rollout, in batches, out of hours: docs/POOL.md P7). Until a
--     row has it, the pool computes it from the row's columns.
--   * `pool_hand_seats` - per hand counted into the pool: its field and each
--     named opponent's part (`[[player, net_bb, {rate: [made, opp]}], ...]`),
--     at the catalogue version it was counted at. Written by the one pass
--     (`derive_save` → `derive_write` → `analytics_pool_add`). It replaces
--     `pool_counted_hands` as the "already counted" mark.
--   * `pool_players` / `pool_player_stats` - keyed by `field_key` instead of
--     `game_format`, with a seat count so an emptied row goes. Results are
--     `numeric`: a hand added and taken out again leaves the sums exactly as
--     they were.
--   * **A delete subtracts.** A hand deleted takes its `pool_hand_seats` row
--     (cascade); `pool_hand_seats_subtract` takes that row's seats out of the
--     owner's rollups. Nothing is emptied or counted again: `derive_recounts`,
--     `derive_recount_step`, `pool_counted_hands_reset` and
--     `pool_counted_hands` are dropped. A wipe of every hand (which skips the
--     summary triggers) empties the rollups or rebuilds them from the seats
--     left (`hand_wipe_finish` → `pool_rollups_rebuild`).
--   * **A catalogue bump** (`ANALYTICS_MEMBERSHIP_VERSION`) still goes through
--     the queue (`derive_enqueue_backlog('analytics/N', ...)`, P7): the first
--     hand saved at the new version drops the rollups of every other version,
--     each hand re-counted replaces its seats row, and the reader reads the
--     version it is asked for.
--   * `analytics_pool` reads fields: the screen's rooms, formats, games,
--     limits, table sizes and stakes all apply (the desktop still sends only
--     the kind or format and the rooms; its own field split is P6).
--
-- The existing rollups cannot be split by field, so they are emptied here;
-- the first fill (P7, `derive_enqueue_backlog`) counts every hand again.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The field of a hand
-- ---------------------------------------------------------------------------

-- The report segment's rules (20270707090000): the size class from the
-- table's seats (else the players dealt in), the stake as `<currency>:<big
-- blind>` at the cash tables and `chips` elsewhere.
create or replace function public.field_key_of(
  p_site         text,
  p_format       text,
  p_variant      text,
  p_limit        text,
  p_max_seats    integer,
  p_player_count integer,
  p_currency     text,
  p_big_blind    bigint
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select concat_ws('|',
    coalesce(p_site, ''),
    coalesce(p_format, ''),
    coalesce(p_variant, ''),
    coalesce(p_limit, ''),
    case
      when coalesce(case when coalesce(p_max_seats, 0) >= 2 then p_max_seats else p_player_count end, 0) <= 2 then 'hu'
      when case when coalesce(p_max_seats, 0) >= 2 then p_max_seats else p_player_count end <= 6 then '6max'
      else 'full'
    end,
    case when p_format = 'cash' then coalesce(p_currency, '') || ':' || coalesce(p_big_blind, 0)::text else 'chips' end);
$$;

comment on function public.field_key_of(text, text, text, text, integer, integer, text, bigint) is
  'P2 (docs/POOL.md): a hand''s field - room|format|variant|limit|size|stake (USD:50, chips) - by the report '
  'segment''s rules.';

alter table public.hands add column if not exists field_key text;

comment on column public.hands.field_key is
  'P2: the hand''s field (field_key_of: room|format|variant|limit|size|stake), set by hands_normalize. Null on a '
  'row stored before P2 until hands_field_key_backfill reaches it.';

-- The body of 20271114090000, plus the field.
create or replace function public.hands_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.owner_id := (select auth.uid());
  end if;

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

  -- Read off the canonical document, never off the client's column. A payload
  -- key cannot set it, which is what keeps a filter dimension honest without
  -- widening `save_hands`. `left(...)` rather than a raise: a room inventing a
  -- 200-character brand name should not fail somebody's upload.
  new.fast_fold := left(
    nullif(btrim(coalesce(new.phf -> 'table' ->> 'fastFold', '')), ''),
    64
  );

  -- The leak readers' chart set (20271114090000), off the document as well.
  new.table_set := case when new.phf is null then coalesce(new.table_set, '')
                        else public.analysis_hand_table_set(new.phf) end;

  if new.player_count is null then
    new.player_count := nullif(cardinality(new.player_names), 0);
    -- A positional-anonymity hand has no names to count, but it does have a
    -- roster of positions, which is the same number.
    if new.player_count is null then
      new.player_count := nullif(cardinality(new.player_positions), 0);
    end if;
  end if;

  -- (P2) The field, from the columns above; never the client's.
  new.field_key := public.field_key_of(new.site, new.game_format::text, new.variant, new.limit_type,
                                       new.max_seats, new.player_count, new.currency, new.big_blind);

  -- (20271114090000) Every column is derived; a row with a verified standard
  -- text is that text from here on. Only the writers that know the text was
  -- verified (`save_hands`, `ingest_hands`) say so, for their own insert
  -- (`rail.hands_text_verified`, transaction-local, reset after it): a
  -- direct insert, a fixture or a data copy with a display copy of the text
  -- keeps its PHF.
  if new.phf is not null and coalesce(new.standard_text, '') <> ''
     and coalesce(current_setting('rail.hands_text_verified', true), '') = 'on' then
    new.phf := null;
  end if;

  -- created_at is server-authoritative; a client cannot backdate a row.
  new.created_at := now();

  return new;
end;
$$;

-- The backfill's updates change no counted column: the library counts'
-- update trigger (a rebuild per owner touched) skips them.
drop trigger if exists hands_library_counts_after_update on public.hands;
create trigger hands_library_counts_after_update
  after update on public.hands
  referencing old table as old_rows new table as new_rows
  for each statement
  when (coalesce(current_setting('rail.field_backfill', true), '') = '')
  execute function public.library_counts_update();

-- Rows stored before P2: their field, a page at a time in id order after
-- p_after. Run by hand as postgres, out of hours, repeated from the returned
-- `after` until `done` (docs/POOL.md P7). Granted to nobody.
create or replace function public.hands_field_key_backfill(p_after uuid default null, p_limit integer default 20000)
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 20000), 1), 100000);
  v_last    uuid;
  v_seen    integer;
  v_updated integer;
begin
  perform set_config('rail.field_backfill', 'on', true);
  with page as (
    select h.id from public.hands h
    where p_after is null or h.id > p_after
    order by h.id
    limit v_limit
  ), done as (
    update public.hands h
       set field_key = public.field_key_of(h.site, h.game_format::text, h.variant, h.limit_type,
                                           h.max_seats, h.player_count, h.currency, h.big_blind)
      from page p
     where h.id = p.id
       and h.field_key is distinct from public.field_key_of(h.site, h.game_format::text, h.variant, h.limit_type,
                                                            h.max_seats, h.player_count, h.currency, h.big_blind)
    returning 1
  )
  select (select max(p.id::text)::uuid from page p), (select count(*) from page), (select count(*) from done)
    into v_last, v_seen, v_updated;
  perform set_config('rail.field_backfill', '', true);
  return jsonb_build_object('seen', v_seen, 'updated', v_updated, 'after', v_last, 'done', v_seen < v_limit);
end;
$$;

comment on function public.hands_field_key_backfill(uuid, integer) is
  'P2 / P7: sets hands.field_key on a page of rows (id order after p_after). Run by hand; granted to nobody.';

revoke all on function public.hands_field_key_backfill(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. What P1 left for a delete: gone
-- ---------------------------------------------------------------------------

drop function if exists public.derive_recount_step(uuid, integer);
drop table if exists public.derive_recounts;
drop table if exists public.pool_counted_hands cascade;
drop function if exists public.pool_counted_hands_reset();

delete from public.account_data_inventory
 where name in ('public.derive_recounts', 'public.pool_counted_hands');

-- ---------------------------------------------------------------------------
-- 3. The rollups, by field
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'pool_players' and column_name = 'game_format') then
    -- Summed per room and format: cannot be split by field. Counted again by
    -- the first fill (P7).
    truncate public.pool_player_stats, public.pool_players;
    alter table public.pool_players drop constraint if exists pool_players_pkey;
    alter table public.pool_players drop column game_format;
    alter table public.pool_players add column field_key text not null;
    alter table public.pool_players add column seats bigint not null default 0;
    alter table public.pool_players alter column net_bb type numeric using net_bb::numeric;
    alter table public.pool_players alter column net_bb_sq type numeric using net_bb_sq::numeric;
    alter table public.pool_players add primary key (owner_id, membership_version, site_id, player, field_key);
    alter table public.pool_player_stats drop constraint if exists pool_player_stats_pkey;
    alter table public.pool_player_stats drop column game_format;
    alter table public.pool_player_stats add column field_key text not null;
    alter table public.pool_player_stats add primary key (owner_id, membership_version, site_id, player, field_key, stat);
  end if;
end;
$$;

comment on table public.pool_players is
  'Analytics Step 10 / P2: each named opponent''s seats in the owner''s hands (bomb pots out; an EV cashout''s '
  'result not counted), per room and field: seats, hands with a result, sum of results and of their squares (bb).';
comment on column public.pool_players.seats is 'P2: seat rows summed here (with or without a result); 0: the row goes.';
comment on column public.pool_players.hands is 'Seat rows whose result counts (net_bb not null).';

comment on table public.pool_player_stats is
  'Analytics Step 10 / P2: each named opponent''s counts of the catalogue''s rates in the owner''s hands, per room '
  'and field (made, opportunities). Written by the one pass (analytics_pool_add), less a deleted hand''s seats.';

create table if not exists public.pool_hand_seats (
  hand_id            uuid  primary key references public.hands (id) on delete cascade,
  owner_id           uuid  not null references auth.users (id) on delete cascade,
  membership_version text  not null check (membership_version ~ '^analytics/[0-9]+$'),
  site_id            text  not null,
  field_key          text  not null,
  -- [[player, net_bb (null: the money does not count), {rate: [made, opp]}], ...]
  -- json, not jsonb: kept as text, a third of jsonb's size (~1 KB a hand in
  -- jsonb with named keys); read back as jsonb (`seats::jsonb`).
  seats              json  not null check (json_typeof(seats) = 'array')
);

comment on table public.pool_hand_seats is
  'P2 (docs/POOL.md): a hand counted into its owner''s pool - its field and each named opponent''s part, at a '
  'catalogue version. A deleted hand''s row (cascade) is subtracted from pool_players / pool_player_stats.';

create index if not exists pool_hand_seats_owner_idx on public.pool_hand_seats (owner_id, membership_version);

alter table public.pool_hand_seats enable row level security;
revoke all on public.pool_hand_seats from public, anon, authenticated;
grant select on public.pool_hand_seats to authenticated;
drop policy if exists pool_hand_seats_owner_select on public.pool_hand_seats;
create policy pool_hand_seats_owner_select on public.pool_hand_seats
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. A delete subtracts
-- ---------------------------------------------------------------------------

-- The owner's pool is written by one transaction at a time (a drain, a
-- delete, a rebuild): taken in owner order, so two never deadlock.
create or replace function public.pool_lock(p_owners uuid[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  for v_owner in select distinct o from unnest(p_owners) o where o is not null order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('pool:' || v_owner::text, 0));
  end loop;
end;
$$;

revoke all on function public.pool_lock(uuid[]) from public, anon, authenticated;

-- Hands' rows deleted (the hands went): their seats out of the rollups at the
-- version they were counted at. Not while an account or a library is wiped
-- (`rail.erasing_account`): the rollups go with the account, or are rebuilt
-- by `hand_wipe_finish`.
create or replace function public.pool_hand_seats_subtract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('rail.erasing_account', true), '') <> '' then
    return null;
  end if;
  perform public.pool_lock(array(select distinct g.owner_id from gone g));

  with seat as (
    select g.owner_id, g.membership_version, g.site_id, g.field_key, s ->> 0 as player,
           (s ->> 1)::numeric as net_bb
    from gone g
    cross join lateral jsonb_array_elements(g.seats::jsonb) s
  ), sums as (
    select owner_id, membership_version, site_id, player, field_key,
           count(*) as seats, count(net_bb) as hands,
           coalesce(sum(net_bb), 0) as net_bb, coalesce(sum(net_bb * net_bb), 0) as net_bb_sq
    from seat
    group by 1, 2, 3, 4, 5
  )
  update public.pool_players p
     set seats = p.seats - s.seats, hands = p.hands - s.hands,
         net_bb = p.net_bb - s.net_bb, net_bb_sq = p.net_bb_sq - s.net_bb_sq
    from sums s
   where p.owner_id = s.owner_id and p.membership_version = s.membership_version and p.site_id = s.site_id
     and p.player = s.player and p.field_key = s.field_key;

  delete from public.pool_players p
   using (select distinct g.owner_id, g.membership_version, g.site_id, g.field_key, s ->> 0 as player
          from gone g cross join lateral jsonb_array_elements(g.seats::jsonb) s) k
   where p.owner_id = k.owner_id and p.membership_version = k.membership_version and p.site_id = k.site_id
     and p.player = k.player and p.field_key = k.field_key and p.seats <= 0;

  with rate as (
    select g.owner_id, g.membership_version, g.site_id, g.field_key, s ->> 0 as player, st.k as stat,
           sum((st.v ->> 0)::bigint) as made, sum((st.v ->> 1)::bigint) as opp
    from gone g
    cross join lateral jsonb_array_elements(g.seats::jsonb) s
    cross join lateral jsonb_each(s -> 2) st(k, v)
    group by 1, 2, 3, 4, 5, 6
  )
  update public.pool_player_stats p
     set made = p.made - r.made, opp = p.opp - r.opp
    from rate r
   where p.owner_id = r.owner_id and p.membership_version = r.membership_version and p.site_id = r.site_id
     and p.player = r.player and p.field_key = r.field_key and p.stat = r.stat;

  delete from public.pool_player_stats p
   using (select distinct g.owner_id, g.membership_version, g.site_id, g.field_key, s ->> 0 as player, st.k as stat
          from gone g
          cross join lateral jsonb_array_elements(g.seats::jsonb) s
          cross join lateral jsonb_each(s -> 2) st(k, v)) k
   where p.owner_id = k.owner_id and p.membership_version = k.membership_version and p.site_id = k.site_id
     and p.player = k.player and p.field_key = k.field_key and p.stat = k.stat and p.opp <= 0;
  return null;
end;
$$;

comment on function public.pool_hand_seats_subtract() is
  'P2: deleted pool_hand_seats rows (their hands went) taken out of the owner''s pool_players / pool_player_stats.';

revoke all on function public.pool_hand_seats_subtract() from public, anon, authenticated;

drop trigger if exists pool_hand_seats_subtract on public.pool_hand_seats;
create trigger pool_hand_seats_subtract
  after delete on public.pool_hand_seats
  referencing old table as gone
  for each statement execute function public.pool_hand_seats_subtract();

-- An owner's rollups summed again from their seats rows (after a wipe that
-- kept some hands; a repair). Internal.
create or replace function public.pool_rollups_rebuild(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.pool_lock(array[p_owner]);
  delete from public.pool_player_stats where owner_id = p_owner;
  delete from public.pool_players where owner_id = p_owner;

  insert into public.pool_players (owner_id, membership_version, site_id, player, field_key, seats, hands, net_bb, net_bb_sq)
  select g.owner_id, g.membership_version, g.site_id, s ->> 0, g.field_key,
         count(*), count((s ->> 1)::numeric),
         coalesce(sum((s ->> 1)::numeric), 0), coalesce(sum((s ->> 1)::numeric ^ 2), 0)
  from public.pool_hand_seats g
  cross join lateral jsonb_array_elements(g.seats::jsonb) s
  where g.owner_id = p_owner
  group by g.owner_id, g.membership_version, g.site_id, s ->> 0, g.field_key;

  insert into public.pool_player_stats (owner_id, membership_version, site_id, player, field_key, stat, made, opp)
  select g.owner_id, g.membership_version, g.site_id, s ->> 0, g.field_key, st.k,
         sum((st.v ->> 0)::bigint), sum((st.v ->> 1)::bigint)
  from public.pool_hand_seats g
  cross join lateral jsonb_array_elements(g.seats::jsonb) s
  cross join lateral jsonb_each(s -> 2) st(k, v)
  where g.owner_id = p_owner
  group by g.owner_id, g.membership_version, g.site_id, s ->> 0, g.field_key, st.k
  having sum((st.v ->> 1)::bigint) > 0;
end;
$$;

comment on function public.pool_rollups_rebuild(uuid) is
  'P2: an owner''s pool_players / pool_player_stats summed again from pool_hand_seats. Internal.';

revoke all on function public.pool_rollups_rebuild(uuid) from public, anon, authenticated;

-- The body of 20271119200000, plus the pool: emptied with the last hand,
-- else summed again from the seats of the hands kept.
create or replace function public.hand_wipe_finish(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.hands h where h.owner_id = p_owner) then
    perform public.library_counts_rebuild(p_owner);
    perform public.report_summaries_rebuild(p_owner);
    perform public.analysis_leak_summaries_rebuild(p_owner);
    perform public.preflop_decision_rows_rebuild(p_owner);
    perform public.pool_rollups_rebuild(p_owner);
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || p_owner::text, 0));
  delete from public.library_hand_counts where owner_id = p_owner;
  delete from public.library_hero_counts where owner_id = p_owner;
  delete from public.library_counts_stale where owner_id = p_owner;
  delete from public.hero_rollups where owner_id = p_owner;
  delete from public.hero_report_rows where owner_id = p_owner;
  delete from public.player_stats where owner_id = p_owner;
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || p_owner::text, 0));
  delete from public.analysis_hand_rows where owner_id = p_owner;
  delete from public.analysis_month_hands where owner_id = p_owner;
  delete from public.analysis_leak_rows where owner_id = p_owner;
  delete from public.analysis_leak_totals where owner_id = p_owner;
  delete from public.analysis_leak_stake_totals where owner_id = p_owner;
  delete from public.analysis_trend_days where owner_id = p_owner;
  delete from public.analysis_overview_hands where owner_id = p_owner;
  delete from public.analysis_overview_decisions where owner_id = p_owner;
  delete from public.analysis_overview_flags where owner_id = p_owner;
  delete from public.analysis_overview_keys where owner_id = p_owner;
  delete from public.analysis_node_totals where owner_id = p_owner;
  delete from public.analysis_graded_sites where owner_id = p_owner;
  perform pg_advisory_xact_lock(hashtextextended('preflop_decisions:' || p_owner::text, 0));
  delete from public.preflop_decision_rows where owner_id = p_owner;
  delete from public.preflop_decision_totals where owner_id = p_owner;
  perform public.pool_lock(array[p_owner]);
  delete from public.pool_player_stats where owner_id = p_owner;
  delete from public.pool_players where owner_id = p_owner;
end;
$$;

revoke all on function public.hand_wipe_finish(uuid) from public;
revoke execute on function public.hand_wipe_finish(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The writer: seats kept, rollups added by field
-- ---------------------------------------------------------------------------
--
-- p_hands: at most 200 hands, each {hand_id, players: [{player, net_bb,
-- stats: {rate: [made, opp]}}]} (checked as before). Per hand of the owner's:
-- a hand counted at p_version already adds nothing; else its seats row is
-- written (replacing one of another version) and its players added to the
-- rollups of its field. Rows of another version are dropped first (the
-- catalogue changed: every hand is counted again, through the queue).

create or replace function public.analytics_pool_add(p_owner uuid, p_version text, p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := p_owner;
  v_received integer;
  v_new      uuid[];
  v_players  integer;
begin
  if v_owner is null then
    raise exception 'analytics_pool_add needs an owner.' using errcode = '22023';
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
  perform public.pool_lock(array[v_owner]);

  -- Counted at another version: the catalogue changed, everything is counted again.
  delete from public.pool_player_stats where owner_id = v_owner and membership_version <> p_version;
  delete from public.pool_players where owner_id = v_owner and membership_version <> p_version;

  -- The owner's hands, their seats kept (not counted at this version before):
  -- the first entry of a hand named twice, a player named twice in a hand
  -- once, each rate with an opportunity.
  with input as (
    select distinct on ((e ->> 'hand_id')::uuid) (e ->> 'hand_id')::uuid as hand_id, e -> 'players' as players
    from jsonb_array_elements(p_hands) with ordinality as t(e, n)
    order by (e ->> 'hand_id')::uuid, n
  ), mine as (
    select i.hand_id, i.players, h.site,
           coalesce(h.field_key, public.field_key_of(h.site, h.game_format::text, h.variant, h.limit_type,
                                                     h.max_seats, h.player_count, h.currency, h.big_blind)) as field_key
    from input i
    join public.hands h on h.id = i.hand_id and h.owner_id = v_owner
  ), seats as (
    select m.hand_id,
           coalesce((
             select jsonb_agg(jsonb_build_array(
                      x.player, x.net_bb,
                      coalesce((select jsonb_object_agg(st.k, st.v order by st.k)
                                from jsonb_each(x.stats) st(k, v)
                                where (st.v ->> 1)::integer > 0), '{}'::jsonb))
                    order by x.player)
             from (
               select distinct on (pl ->> 'player') pl ->> 'player' as player, pl -> 'net_bb' as net_bb,
                      pl -> 'stats' as stats
               from jsonb_array_elements(m.players) with ordinality as q(pl, n)
               order by pl ->> 'player', n
             ) x), '[]'::jsonb) as seats
    from mine m
  ), marked as (
    insert into public.pool_hand_seats as c (hand_id, owner_id, membership_version, site_id, field_key, seats)
    select m.hand_id, v_owner, p_version, m.site, m.field_key, s.seats::json
    from mine m
    join seats s on s.hand_id = m.hand_id
    on conflict (hand_id) do update
      set membership_version = excluded.membership_version, site_id = excluded.site_id,
          field_key = excluded.field_key, seats = excluded.seats
      where c.membership_version <> excluded.membership_version and c.owner_id = excluded.owner_id
    returning c.hand_id
  )
  select coalesce(array_agg(hand_id), '{}') into v_new from marked;

  with seat as (
    select g.site_id, g.field_key, s ->> 0 as player, (s ->> 1)::numeric as net_bb
    from public.pool_hand_seats g
    cross join lateral jsonb_array_elements(g.seats::jsonb) s
    where g.hand_id = any (v_new)
  ), added as (
    insert into public.pool_players as p (owner_id, membership_version, site_id, player, field_key, seats, hands, net_bb, net_bb_sq)
    select v_owner, p_version, s.site_id, s.player, s.field_key,
           count(*), count(s.net_bb), coalesce(sum(s.net_bb), 0), coalesce(sum(s.net_bb * s.net_bb), 0)
    from seat s
    group by s.site_id, s.player, s.field_key
    on conflict (owner_id, membership_version, site_id, player, field_key) do update
      set seats = p.seats + excluded.seats, hands = p.hands + excluded.hands,
          net_bb = p.net_bb + excluded.net_bb, net_bb_sq = p.net_bb_sq + excluded.net_bb_sq
    returning 1
  )
  select (select count(*) from seat) into v_players
  from (select count(*) from added) a;

  insert into public.pool_player_stats as p (owner_id, membership_version, site_id, player, field_key, stat, made, opp)
  select v_owner, p_version, g.site_id, s ->> 0, g.field_key, st.k,
         sum((st.v ->> 0)::bigint), sum((st.v ->> 1)::bigint)
  from public.pool_hand_seats g
  cross join lateral jsonb_array_elements(g.seats::jsonb) s
  cross join lateral jsonb_each(s -> 2) st(k, v)
  where g.hand_id = any (v_new)
  group by g.site_id, s ->> 0, g.field_key, st.k
  on conflict (owner_id, membership_version, site_id, player, field_key, stat) do update
    set made = p.made + excluded.made, opp = p.opp + excluded.opp;

  return jsonb_build_object('received', v_received, 'saved', cardinality(v_new), 'players', v_players);
end;
$$;

comment on function public.analytics_pool_add(uuid, text, jsonb) is
  'P1 / P2: keeps up to 200 of an owner''s hands'' opponents (pool_hand_seats, by field) and adds them to '
  'pool_players / pool_player_stats; a hand counted at that version already adds nothing. Granted to nobody.';

revoke all on function public.analytics_pool_add(uuid, text, jsonb) from public, anon, authenticated;

-- The browser's old work list (older clients during the rollout): the hands
-- without a seats row at the version.
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
      select 1 from public.pool_hand_seats c
      where c.hand_id = hd.id and c.membership_version = p_version)
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.analytics_pool_pending(text, uuid, integer) is
  'Analytics Step 10: a page of the caller''s hands not counted into the pool at a membership version (no '
  'pool_hand_seats row). Since P1 the server counts on arrival; kept for older clients.';

-- ---------------------------------------------------------------------------
-- 6. The reader, by field
-- ---------------------------------------------------------------------------
--
-- p_filters: `sites`, `formats` (else `gameFormat` / `gameKind`), `variants`,
-- `limits`, `sizes` (`hu`, `6max`, `full`), `stakes` (`USD:50`, `chips`) -
-- the screen's HandFilter groups, each "any" when empty - and
-- `membershipVersion`, `statsVersion`. The opponents are typed as before
-- (their `player_stats` over every segment of the room); their results and
-- rates are summed over the fields the filter names.

create or replace function public.analytics_pool(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner    uuid := auth.uid();
  v_filters  jsonb := coalesce(p_filters, '{}'::jsonb);
  v_mv       text;
  v_formats  text[];
  v_sites    text[];
  v_variants text[];
  v_limits   text[];
  v_sizes    text[];
  v_stakes   text[];
  v_stats    text := coalesce(nullif(btrim(coalesce(v_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_pending  bigint;
  v_out      jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read your pool.' using errcode = '42501';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'analytics_pool expects a JSON object of filters.' using errcode = '22023';
  end if;
  v_mv := public.analytics_membership_version_of(v_filters);
  v_formats := public.library_list(v_filters, 'formats');
  if cardinality(v_formats) = 0 then
    v_formats := public.filter_formats(v_filters);
  end if;
  v_sites    := public.library_list(v_filters, 'sites');
  v_variants := public.library_list(v_filters, 'variants');
  v_limits   := public.library_list(v_filters, 'limits');
  v_sizes    := public.library_list(v_filters, 'sizes');
  v_stakes   := public.library_list(v_filters, 'stakes');

  v_pending := public.derive_pending();

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
        and (cardinality(v_sites) = 0 or ps.site_id = any (v_sites))
      group by ps.site_id, ps.player
    ) t
  ), fields as (
    -- The owner's fields the filter names.
    select f.field_key
    from (select distinct p.field_key from public.pool_players p
          where p.owner_id = v_owner and p.membership_version = v_mv) f
    where (cardinality(v_sites) = 0 or split_part(f.field_key, '|', 1) = any (v_sites))
      and (v_formats is null or split_part(f.field_key, '|', 2) = any (v_formats))
      and (cardinality(v_variants) = 0 or split_part(f.field_key, '|', 3) = any (v_variants))
      and (cardinality(v_limits) = 0 or split_part(f.field_key, '|', 4) = any (v_limits))
      and (cardinality(v_sizes) = 0 or split_part(f.field_key, '|', 5) = any (v_sizes))
      and (cardinality(v_stakes) = 0 or split_part(f.field_key, '|', 6) = any (v_stakes))
  ), members as (
    select p.site_id, p.player, ty.kind,
           sum(p.hands) as hands, sum(p.net_bb) as net_bb, sum(p.net_bb_sq) as net_bb_sq
    from public.pool_players p
    join fields f on f.field_key = p.field_key
    join types ty on ty.site_id = p.site_id and ty.player = p.player and ty.kind is not null
    where p.owner_id = v_owner and p.membership_version = v_mv
    group by p.site_id, p.player, ty.kind
    having sum(p.hands) > 0
  ), by_type as (
    select m.kind, count(*) as players, sum(m.hands) as hands, sum(m.net_bb) as net_bb, sum(m.net_bb_sq) as net_bb_sq
    from members m
    group by m.kind
  ), rates as (
    select s.stat, m.kind, sum(s.made) as made, sum(s.opp) as opp
    from public.pool_player_stats s
    join fields f on f.field_key = s.field_key
    join members m on m.site_id = s.site_id and m.player = s.player
    where s.owner_id = v_owner and s.membership_version = v_mv
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
  'Analytics Step 10 / P2: the caller''s regs and fish (Rail''s types over player_stats) - players, hands, sum of '
  'results and of their squares - and their catalogue rates, over the fields the filter names (rooms, formats, '
  'games, limits, sizes, stakes); pending: the caller''s hands still being processed (derive_pending).';

revoke all on function public.analytics_pool(jsonb) from public, anon;
grant execute on function public.analytics_pool(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The claim, without the recount
-- ---------------------------------------------------------------------------

-- The body of 20271127090000 without `derive_recount_step` (a delete no
-- longer queues the library again).
create or replace function public.derive_claim(p_limit integer default 50, p_versions jsonb default '{}'::jsonb)
returns table (
  hand_id uuid, owner_id uuid, reason text, villains boolean,
  phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz,
  analysis_version text, decisions jsonb
)
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_owner uuid := public.derive_caller();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_av    text := nullif(btrim(coalesce(p_versions ->> 'analysis', '')), '');
  v_mv    text := nullif(btrim(coalesce(p_versions ->> 'membership', '')), '');
  v_ids   uuid[];
begin
  if p_versions is not null and jsonb_typeof(p_versions) <> 'object' then
    raise exception 'derive_claim expects a JSON object of versions.' using errcode = '22023';
  end if;
  if v_mv is not null and v_mv !~ '^analytics/[0-9]+$' then
    raise exception 'derive_claim: a membership version is analytics/N.' using errcode = '22023';
  end if;

  -- A hand that crashed its worker five times is given up on.
  with dead as (
    delete from public.derive_queue q
    where q.tries >= 5 and q.claimed_at < now() - interval '5 minutes'
      and (v_owner is null or q.owner_id = v_owner)
    returning q.hand_id, q.owner_id, q.reason, q.tries, q.last_error
  )
  insert into public.derive_failures as f (hand_id, owner_id, reason, error, tries, failed_at)
  select d.hand_id, d.owner_id, d.reason, coalesce(d.last_error, 'The worker stopped before it finished.'), d.tries, now()
  from dead d
  on conflict (hand_id) do update
    set reason = excluded.reason, error = excluded.error, tries = excluded.tries, failed_at = excluded.failed_at;

  -- Free rows, or rows a worker claimed and never answered for.
  if v_owner is null then
    select array_agg(x.hand_id) into v_ids from (
      select q.hand_id from public.derive_queue q
      where (q.claimed_at is null or q.claimed_at < now() - interval '5 minutes') and q.tries < 5
      order by q.priority, q.enqueued_at, q.hand_id
      limit v_limit
      for update skip locked
    ) x;
  else
    select array_agg(x.hand_id) into v_ids from (
      select q.hand_id from public.derive_queue q
      where q.owner_id = v_owner
        and (q.claimed_at is null or q.claimed_at < now() - interval '5 minutes') and q.tries < 5
      order by q.priority, q.enqueued_at, q.hand_id
      limit v_limit
      for update skip locked
    ) x;
  end if;
  if v_ids is null then
    return;
  end if;

  update public.derive_queue q set claimed_at = now(), tries = q.tries + 1 where q.hand_id = any (v_ids);

  return query
  select q.hand_id, q.owner_id, q.reason, coalesce(o.villains, false),
         h.phf, case when h.phf is null then h.standard_text end,
         h.hand_key, h.site, h.parser_version, h.source_filename, h.created_at,
         a.analysis_version,
         case when a.analysis_version is null then null else coalesce((
           select jsonb_agg(jsonb_build_object(
                    'ord', d.ord, 'action_index', d.action_index, 'status', d.status, 'options', d.options,
                    'ev_loss_bb', d.ev_loss_bb, 'facts', d.facts) order by d.ord)
           from public.decision_analysis d
           where d.hand_id = q.hand_id and d.analysis_version = a.analysis_version and d.owner_id = q.owner_id),
           '[]'::jsonb) end
  from public.derive_queue q
  join public.hands h on h.id = q.hand_id and h.owner_id = q.owner_id
  left join public.derive_options o on o.owner_id = q.owner_id
  left join lateral (
    select ha.analysis_version from public.hand_analysis ha
    where v_av is not null and v_mv is not null
      and ha.hand_id = q.hand_id and ha.analysis_version = v_av and ha.owner_id = q.owner_id
      and not exists (
        select 1 from public.analysis_checker_hands c
        where c.hand_id = ha.hand_id and c.analysis_version = ha.analysis_version and c.membership_version = v_mv)
  ) a on true
  where q.hand_id = any (v_ids)
  order by q.priority, q.enqueued_at, q.hand_id;
end;
$$;

comment on function public.derive_claim(integer, jsonb) is
  'P1: claims up to 100 queued hands (the caller''s, or every owner''s for rail_derive) for five minutes and returns '
  'what the one pass needs to work each out.';

revoke all on function public.derive_claim(integer, jsonb) from public, anon;
grant execute on function public.derive_claim(integer, jsonb) to authenticated, rail_derive;

-- ---------------------------------------------------------------------------
-- 8. The account's data
-- ---------------------------------------------------------------------------

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.pool_hand_seats', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of hands: each hand''s opponents as counted for the Pool tab (their names, rates and results).')
on conflict (name) do nothing;

commit;
