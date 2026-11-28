-- pgTAP: fields (`20271127100000_pool_fields.sql`, docs/POOL.md P2).
--
-- What has to hold:
--
--   * the field: `hands_normalize` sets `hands.field_key` on insert by the
--     report segment's rules (room|format|variant|limit|size|stake), whatever
--     the client sent; the backfill fills a row without one and is nobody's
--     but postgres';
--   * security: `pool_hand_seats` has RLS on, owner-select only, no client
--     write grant, and is in account_data_inventory; the subtract trigger,
--     the lock, the rebuild and the backfill are nobody's;
--   * the one pass (`derive_save`) keeps each hand's seats with its field and
--     adds them to the rollups by field;
--   * `analytics_pool` reads fields: a GG NL50 6-max filter shows that
--     field's regs and fish only; stakes, sizes, formats, games, limits and
--     rooms each narrow it; the legacy `gameKind` still works;
--   * a delete changes the pool by that hand only: the rollups equal the sum
--     of the seats left, another account's pool is untouched, a rate left
--     without an opportunity goes; the hand stored and counted again gives
--     back exactly the sums from before;
--   * a wipe (summary triggers skipped) is squared by `hand_wipe_finish`:
--     rebuilt from the seats left, emptied with the last hand;
--   * a catalogue bump goes through the queue: the first hand saved at the
--     new version drops the old rollups, its seats row is replaced, and a
--     hand still at the old version deleted changes nothing at the new one.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(36);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000f00a1', 'fields.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000f00b1', 'fields.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to anon, authenticated;

create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function pg_temp.as_postgres() to anon, authenticated;

create function pg_temp.hid(p_n bigint) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000f0' || lpad(p_n::text, 3, '0'))::uuid;
$$;
grant execute on function pg_temp.hid(bigint) to anon, authenticated;

-- The hands: 1-3 GG NL50 6-max, 4-5 GG NL100 6-max, 6 a GG tournament,
-- 8 WePlay NL50 8-max (A's); 7 GG NL50 6-max (B's).
create temporary table spec (n int, owner uuid, site text, format text, currency text, bb bigint, seats smallint,
                             players jsonb) on commit drop;
insert into spec values
  (1, '00000000-0000-0000-0000-0000000f00a1', 'ggpoker', 'cash', 'USD', 50, 6,
   '[{"player":"RegRita","net_bb":2,"stats":{"vpip":[1,1]}},{"player":"FishFred","net_bb":-2,"stats":{"vpip":[1,1]}}]'),
  (2, '00000000-0000-0000-0000-0000000f00a1', 'ggpoker', 'cash', 'USD', 50, 6,
   '[{"player":"RegRita","net_bb":-1,"stats":{"vpip":[0,1]}},{"player":"FishFred","net_bb":3.5,"stats":{"vpip":[1,1],"cbet_flop":[0,1]}}]'),
  (3, '00000000-0000-0000-0000-0000000f00a1', 'ggpoker', 'cash', 'USD', 50, 6,
   '[{"player":"FishFred","net_bb":-1.25,"stats":{"vpip":[1,1]}}]'),
  (4, '00000000-0000-0000-0000-0000000f00a1', 'ggpoker', 'cash', 'USD', 100, 6,
   '[{"player":"RegRita","net_bb":5,"stats":{"vpip":[1,1]}},{"player":"RegRoy","net_bb":-5,"stats":{"vpip":[1,1]}}]'),
  (5, '00000000-0000-0000-0000-0000000f00a1', 'ggpoker', 'cash', 'USD', 100, 6,
   '[{"player":"FishFay","net_bb":10,"stats":{"vpip":[1,1]}},{"player":"RegRoy","net_bb":-10,"stats":{"vpip":[0,1]}}]'),
  (6, '00000000-0000-0000-0000-0000000f00a1', 'ggpoker', 'tournament', 'CHIPS', 400, 9,
   '[{"player":"RegRoy","net_bb":null,"stats":{"vpip":[1,1]}}]'),
  (7, '00000000-0000-0000-0000-0000000f00b1', 'ggpoker', 'cash', 'USD', 50, 6,
   '[{"player":"RegRita","net_bb":100,"stats":{"vpip":[1,1]}}]'),
  (8, '00000000-0000-0000-0000-0000000f00a1', 'weplay', 'cash', 'USD', 50, 8,
   '[{"player":"WePat","net_bb":1,"stats":{"vpip":[1,1]}}]');
grant select on spec to authenticated;

create function pg_temp.store(p_n int) returns void language sql as $$
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position, game_format,
                            variant, limit_type, currency, currency_minor_units, small_blind, big_blind, max_seats,
                            hero_profit, hero_cards, played_at, field_key)
  select pg_temp.hid(s.n), s.owner, s.site || ':fields' || s.n,
         jsonb_build_object('schema', 'phf/1', 'players', '[]'::jsonb, 'actions', '[]'::jsonb),
         'std', s.site, 1, 'BTN', s.format::public.game_format, 'holdem', 'NL', s.currency, 100, s.bb / 2, s.bb,
         s.seats, 0, array['As', 'Kd'], '2026-11-01T12:00:00Z'::timestamptz + s.n * interval '1 hour',
         'what|the|client|sent'
  from spec s where s.n = p_n;
$$;

-- The one pass's product of a hand: its pool part only (the rest is P1's).
create function pg_temp.product(p_n int, p_version text default 'analytics/1') returns jsonb language sql stable as $$
  select jsonb_build_object('hand_id', pg_temp.hid(s.n), 'pool',
                            jsonb_build_object('version', p_version, 'players', s.players))
  from spec s where s.n = p_n;
$$;
grant execute on function pg_temp.product(int, text) to authenticated;

-- The rollups as the seats left say they should be (pool_rollups_rebuild's sums).
create function pg_temp.drift(p_owner uuid) returns bigint language sql stable as $$
  with want_p as (
    select g.membership_version, g.site_id, s ->> 0 as player, g.field_key, count(*) as seats,
           count((s ->> 1)::numeric) as hands, coalesce(sum((s ->> 1)::numeric), 0) as net_bb,
           coalesce(sum((s ->> 1)::numeric ^ 2), 0) as net_bb_sq
    from public.pool_hand_seats g cross join lateral jsonb_array_elements(g.seats::jsonb) s
    where g.owner_id = p_owner
      and g.membership_version in (select distinct membership_version from public.pool_players where owner_id = p_owner)
    group by 1, 2, 3, 4
  ), have_p as (
    select membership_version, site_id, player, field_key, seats, hands, net_bb, net_bb_sq
    from public.pool_players where owner_id = p_owner
  ), want_s as (
    select g.membership_version, g.site_id, s ->> 0 as player, g.field_key, st.k as stat,
           sum((st.v ->> 0)::bigint) as made, sum((st.v ->> 1)::bigint) as opp
    from public.pool_hand_seats g cross join lateral jsonb_array_elements(g.seats::jsonb) s
    cross join lateral jsonb_each(s -> 2) st(k, v)
    where g.owner_id = p_owner
      and g.membership_version in (select distinct membership_version from public.pool_players where owner_id = p_owner)
    group by 1, 2, 3, 4, 5
  ), have_s as (
    select membership_version, site_id, player, field_key, stat, made, opp
    from public.pool_player_stats where owner_id = p_owner
  )
  select (select count(*) from ((select * from want_p except select * from have_p)
                                union all (select * from have_p except select * from want_p)) x)
       + (select count(*) from ((select * from want_s except select * from have_s)
                                union all (select * from have_s except select * from want_s)) y);
$$;

-- ------------------------------------------------------------ the field --

select pg_temp.store(n) from generate_series(1, 8) n;

select is(
  (select array_agg(h.field_key order by h.id) from public.hands h where h.id in (pg_temp.hid(1), pg_temp.hid(4), pg_temp.hid(6), pg_temp.hid(8))),
  array['ggpoker|cash|holdem|nl|6max|USD:50', 'ggpoker|cash|holdem|nl|6max|USD:100',
        'ggpoker|tournament|holdem|nl|full|chips', 'weplay|cash|holdem|nl|full|USD:50'],
  'hands_normalize sets the field from the row (room|format|game|limit|size|stake), not the client''s value');
select is(
  public.field_key_of('pokerstars', 'cash', 'holdem', 'nl', null, 2, 'EUR', 2),
  'pokerstars|cash|holdem|nl|hu|EUR:2', 'no seat count: the size from the players dealt in (the report''s rule)');

update public.hands set field_key = null where id = pg_temp.hid(8);
select is(public.hands_field_key_backfill(null, 100000) ->> 'updated', '1', 'the backfill fills the row without one ...');
select is((select field_key from public.hands where id = pg_temp.hid(8)), 'weplay|cash|holdem|nl|full|USD:50',
  '... with the same field');
select is(public.hands_field_key_backfill(null, 100000) ->> 'updated', '0', '... and run again changes nothing');

-- ----------------------------------------------------------- security --

select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.pool_hand_seats'::regclass)
  and (select count(*) = 0 from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'pool_hand_seats'
          and grantee in ('anon', 'authenticated', 'rail_derive') and privilege_type <> 'SELECT')
  and (select count(*) = 0 from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'pool_hand_seats' and grantee = 'anon')
  and exists (select 1 from public.account_data_inventory where name = 'public.pool_hand_seats' and export = 'derived')
  and not exists (select 1 from public.account_data_inventory
                   where name in ('public.pool_counted_hands', 'public.derive_recounts'))
  and to_regclass('public.pool_counted_hands') is null,
  'pool_hand_seats: RLS on, select only for authenticated, in the inventory; pool_counted_hands is gone');
select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
     from unnest(array['anon', 'authenticated', 'rail_derive']) r,
          unnest(array['public.pool_hand_seats_subtract()', 'public.pool_lock(uuid[])',
                       'public.pool_rollups_rebuild(uuid)', 'public.hands_field_key_backfill(uuid, integer)',
                       'public.analytics_pool_add(uuid, text, jsonb)']) f),
  'the trigger, the lock, the rebuild and the backfill are nobody''s');

-- ------------------------------------------------------- the one pass --

-- A's opponents by their numbers over every hand (the type rule's source).
-- (A function: hand_wipe_finish rebuilds player_stats from hand_stats, which
-- these synthetic hands do not have.)
create function pg_temp.types() returns void language sql as $$
insert into public.player_stats (owner_id, stats_version, site_id, player, site_anonymization, game_format, variant,
                                 limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr)
values
  ('00000000-0000-0000-0000-0000000f00a1', 'stats/2', 'ggpoker', 'RegRita', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 50, 100, 100, 22, 100, 18),
  ('00000000-0000-0000-0000-0000000f00a1', 'stats/2', 'ggpoker', 'RegRoy', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 100, 100, 100, 25, 100, 20),
  ('00000000-0000-0000-0000-0000000f00a1', 'stats/2', 'ggpoker', 'FishFred', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 50, 100, 100, 55, 100, 5),
  ('00000000-0000-0000-0000-0000000f00a1', 'stats/2', 'ggpoker', 'FishFay', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 100, 100, 100, 60, 100, 8),
  ('00000000-0000-0000-0000-0000000f00a1', 'stats/2', 'weplay', 'WePat', 'none', 'cash', 'holdem', 'nl', 'full', 'USD', 50, 100, 100, 20, 100, 16),
  ('00000000-0000-0000-0000-0000000f00b1', 'stats/2', 'ggpoker', 'RegRita', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 50, 100, 100, 22, 100, 18)
on conflict do nothing;
$$;
select pg_temp.types();

select pg_temp.act_as('00000000-0000-0000-0000-0000000f00a1');
select is(public.derive_save((select jsonb_agg(pg_temp.product(n)) from generate_series(1, 8) n)),
  '{"saved": 7, "failed": 0}'::jsonb, 'the one pass saves A''s seven hands (B''s is not A''s)');
select is(
  (select array_agg(c.field_key || ' ' || json_array_length(c.seats) order by c.hand_id) from public.pool_hand_seats c),
  array['ggpoker|cash|holdem|nl|6max|USD:50 2', 'ggpoker|cash|holdem|nl|6max|USD:50 2', 'ggpoker|cash|holdem|nl|6max|USD:50 1',
        'ggpoker|cash|holdem|nl|6max|USD:100 2', 'ggpoker|cash|holdem|nl|6max|USD:100 2',
        'ggpoker|tournament|holdem|nl|full|chips 1', 'weplay|cash|holdem|nl|full|USD:50 1'],
  'each hand''s seats are kept with its field (A reads only A''s)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000f00b1');
select is(public.derive_save(jsonb_build_array(pg_temp.product(7))), '{"saved": 1, "failed": 0}'::jsonb, 'B saves B''s');
select is((select count(*)::int from public.pool_hand_seats), 1, '... and B reads only B''s seats');
select pg_temp.as_postgres();
select is((select seats::text || ' ' || hands || ' ' || net_bb || ' ' || net_bb_sq from public.pool_players
            where owner_id = '00000000-0000-0000-0000-0000000f00a1' and player = 'FishFred'),
  '3 3 0.25 17.8125', 'the rollups sum each player''s seats by field (FishFred in NL50: 3 seats, +0.25 bb)');
select is(pg_temp.drift('00000000-0000-0000-0000-0000000f00a1'), 0::bigint, 'A''s rollups are the sum of A''s seats');

-- ------------------------------------------------------------- reading --

select pg_temp.act_as('00000000-0000-0000-0000-0000000f00a1');
create function pg_temp.pool(p_filter jsonb) returns jsonb language sql stable as $$
  select public.analytics_pool('{"statsVersion":"stats/2"}'::jsonb || p_filter);
$$;
grant execute on function pg_temp.pool(jsonb) to authenticated;

select is(pg_temp.pool('{"sites":["ggpoker"],"formats":["cash"],"sizes":["6max"],"stakes":["USD:50"]}') - 'version' - 'pending',
  '{"reg": {"hands": 2, "netBb": 1, "players": 1, "netBbSq": 5},
    "fish": {"hands": 3, "netBb": 0.25, "players": 1, "netBbSq": 17.8125},
    "stats": [{"opp": 1, "made": 0, "stat": "cbet_flop", "type": "fish"},
              {"opp": 2, "made": 1, "stat": "vpip", "type": "reg"},
              {"opp": 3, "made": 3, "stat": "vpip", "type": "fish"}]}'::jsonb,
  'GG NL50 6-max: that field''s regs and fish, their results and rates, and nothing else');
select is(pg_temp.pool('{"stakes":["USD:100"]}') -> 'reg' ->> 'players', '2',
  'another stake: its own regs (RegRita and RegRoy in NL100)');
select is(pg_temp.pool('{"stakes":["USD:100"]}') -> 'fish' ->> 'hands', '1', '... and its fish');
select is(pg_temp.pool('{}') -> 'reg' ->> 'hands', '6', 'no filter: every field summed (RegRita 3, RegRoy 2, WePat 1)');
select is(pg_temp.pool('{"sizes":["full"]}') -> 'reg' ->> 'players', '1', 'a size: the full-ring field only (WePat)');
select is(pg_temp.pool('{"formats":["tournament"]}') -> 'reg' ->> 'players', '0',
  'a format: the tournament (RegRoy''s only seat there has no result: not a member)');
select is(pg_temp.pool('{"gameKind":"cash","sites":["weplay"]}') -> 'reg' ->> 'players', '1',
  'the legacy kind and a room still narrow it (the desktop''s filters)');
select is(pg_temp.pool('{"variants":["omaha"]}') -> 'reg' ->> 'players', '0', 'a game nobody played: nobody');
select is(pg_temp.pool('{"limits":["nl"],"stakes":["USD:50"]}') -> 'reg' ->> 'hands', '3',
  'a limit and a stake over two rooms: GG NL50 and WePlay NL50');

-- -------------------------------------------------------------- delete --

select pg_temp.as_postgres();
create temporary table snap_p on commit drop as
  select * from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00a1';
create temporary table snap_s on commit drop as
  select * from public.pool_player_stats where owner_id = '00000000-0000-0000-0000-0000000f00a1';
create temporary table snap_b on commit drop as
  select * from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00b1';

select pg_temp.act_as('00000000-0000-0000-0000-0000000f00a1');
select is(public.delete_hands(array[pg_temp.hid(2)]), '{"deleted": 1}'::jsonb, 'A deletes one hand');
select is(pg_temp.pool('{"sites":["ggpoker"],"formats":["cash"],"sizes":["6max"],"stakes":["USD:50"]}') - 'version' - 'pending',
  '{"reg": {"hands": 1, "netBb": 2, "players": 1, "netBbSq": 4},
    "fish": {"hands": 2, "netBb": -3.25, "players": 1, "netBbSq": 5.5625},
    "stats": [{"opp": 1, "made": 1, "stat": "vpip", "type": "reg"},
              {"opp": 2, "made": 2, "stat": "vpip", "type": "fish"}]}'::jsonb,
  'the field changes by that hand only (its rate without an opportunity left is gone)');
select is(pg_temp.pool('{"stakes":["USD:100"]}') -> 'reg' ->> 'hands', '3', '... the other fields do not change');
select pg_temp.as_postgres();
select is(pg_temp.drift('00000000-0000-0000-0000-0000000f00a1'), 0::bigint, '... the rollups are the sum of the seats left');
select ok(
  not exists (select 1 from public.pool_player_stats where owner_id = '00000000-0000-0000-0000-0000000f00a1' and stat = 'cbet_flop')
  and not exists (select * from snap_b except select * from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00b1')
  and not exists (select 1 from public.derive_queue where owner_id = '00000000-0000-0000-0000-0000000f00a1'),
  '... an emptied rate row goes, B''s pool is untouched and nothing is queued');

-- Stored and counted again: exactly the sums from before.
select pg_temp.store(2);
select pg_temp.act_as('00000000-0000-0000-0000-0000000f00a1');
select is(public.derive_save(jsonb_build_array(pg_temp.product(2))) ->> 'saved', '1', 'the hand stored and counted again ...');
select pg_temp.as_postgres();
select ok(
  not exists ((select * from snap_p except select * from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00a1')
              union all
              (select * from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00a1' except select * from snap_p))
  and not exists ((select * from snap_s except select * from public.pool_player_stats where owner_id = '00000000-0000-0000-0000-0000000f00a1')
                  union all
                  (select * from public.pool_player_stats where owner_id = '00000000-0000-0000-0000-0000000f00a1' except select * from snap_s)),
  '... gives back exactly the rollups from before the delete');

-- ---------------------------------------------------------------- wipe --

-- A wipe skips the summary triggers (rail.erasing_account): the seats go
-- with their hands, the rollups are squared when the wipe finishes.
do $$ begin perform set_config('rail.erasing_account', '00000000-0000-0000-0000-0000000f00a1', true); end $$;
delete from public.hands where id = pg_temp.hid(5);
do $$ begin perform set_config('rail.erasing_account', '', true); end $$;
select ok(pg_temp.drift('00000000-0000-0000-0000-0000000f00a1') > 0, 'a wiped hand is not subtracted on the way ...');
select public.hand_wipe_finish('00000000-0000-0000-0000-0000000f00a1');
select is(pg_temp.drift('00000000-0000-0000-0000-0000000f00a1'), 0::bigint,
  '... hand_wipe_finish sums the rollups again from the seats of the hands kept');
select pg_temp.types();

-- ---------------------------------------------------------------- bump --

insert into public.derive_queue (hand_id, owner_id, reason, priority)
values (pg_temp.hid(1), '00000000-0000-0000-0000-0000000f00a1', 'analytics/2', 2);
select pg_temp.act_as('00000000-0000-0000-0000-0000000f00a1');
select is(public.derive_save(jsonb_build_array(pg_temp.product(1, 'analytics/2'))) ->> 'saved', '1',
  'a bump through the queue: the hand counted at analytics/2 ...');
select pg_temp.as_postgres();
select ok(
  not exists (select 1 from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00a1' and membership_version = 'analytics/1')
  and (select membership_version = 'analytics/2' from public.pool_hand_seats where hand_id = pg_temp.hid(1))
  and exists (select 1 from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00b1' and membership_version = 'analytics/1'),
  '... drops A''s analytics/1 rollups (not B''s) and replaces its seats row');
delete from public.hands where id = pg_temp.hid(3);
select pg_temp.act_as('00000000-0000-0000-0000-0000000f00a1');
select is(pg_temp.pool('{"membershipVersion":"analytics/2","stakes":["USD:50"],"sizes":["6max"]}') -> 'reg',
  '{"hands": 1, "netBb": 2, "players": 1, "netBbSq": 4}'::jsonb,
  'a hand still at analytics/1 deleted changes nothing at analytics/2, which holds the re-counted hand');
select pg_temp.as_postgres();
select is(pg_temp.drift('00000000-0000-0000-0000-0000000f00a1'), 0::bigint, '... and the rollups still add up');

-- The last hand gone in a wipe: the rollups are emptied.
do $$ begin perform set_config('rail.erasing_account', '00000000-0000-0000-0000-0000000f00a1', true); end $$;
delete from public.hands where owner_id = '00000000-0000-0000-0000-0000000f00a1';
do $$ begin perform set_config('rail.erasing_account', '', true); end $$;
select public.hand_wipe_finish('00000000-0000-0000-0000-0000000f00a1');
select ok(
  not exists (select 1 from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00a1')
  and not exists (select 1 from public.pool_player_stats where owner_id = '00000000-0000-0000-0000-0000000f00a1')
  and exists (select 1 from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000f00b1'),
  'a wipe of every hand empties the owner''s rollups (and nobody else''s)');

select * from finish();
rollback;
