-- pgTAP: the Pool tab (`20271122100000_analytics_pool.sql`, docs/ANALYTICS.md Step 10).
--
-- What has to hold:
--
--   * security: the writer is a definer, the work list and the reader invoker;
--     every one has an empty search_path, carries the R6.2 gate and is listed
--     in entitlement_gates; authenticated only; the three tables have no
--     client write grant and RLS on, and are in account_data_inventory;
--   * the writer adds a hand's opponents once (a page sent twice adds
--     nothing), only for the caller's own hands; a player with no result (an
--     EV cashout) counts their rates and not their hand;
--   * the reader types the opponents by Rail's rule over player_stats (fish
--     VPIP >= 40, reg VPIP 15-30 and PFR >= 0.6 VPIP, 30+ hands; an untyped
--     one is out), sums hands, results and their squares, and the rates by
--     type; the filters (kind / format, rooms) narrow it; pending is the
--     derive counter (P1);
--   * a deleted hand empties the owner's pool (counted again from every hand);
--     another version replaces the old one;
--   * one account never reads or writes another's; bad input is refused.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(27);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000b00a1', 'pool.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000b00b1', 'pool.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to anon, authenticated;

-- Hand n (1..3) is A's, 4 is B's.
create function pg_temp.hid(p_n bigint) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000b0' || lpad(p_n::text, 3, '0'))::uuid;
$$;
grant execute on function pg_temp.hid(bigint) to authenticated;

-- ----------------------------------------------------------- security --

select ok(
  (select p.prosecdef from pg_proc p where p.oid = 'public.analytics_pool_save(text, jsonb)'::regprocedure)
  and (select bool_and(not p.prosecdef) from pg_proc p
       where p.oid in ('public.analytics_pool_pending(text, uuid, integer)'::regprocedure,
                       'public.analytics_pool(jsonb)'::regprocedure)),
  'the writer is a definer; the work list and the reader are invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and bool_and(position('public.require_entitlement(''analysis'')' in pg_get_functiondef(p.oid)) > 0)
          and count(*) = 3
   from pg_proc p
   where p.oid in ('public.analytics_pool_save(text, jsonb)'::regprocedure,
                   'public.analytics_pool_pending(text, uuid, integer)'::regprocedure,
                   'public.analytics_pool(jsonb)'::regprocedure)),
  '... every one has an empty search_path and the R6.2 gate');
select is(
  (select count(*)::int from public.entitlement_gates
   where feature = 'analysis'
     and function_sig in ('public.analytics_pool_save(text,jsonb)', 'public.analytics_pool_pending(text,uuid,integer)',
                          'public.analytics_pool(jsonb)')),
  3, '... and is listed in entitlement_gates (analysis)');
select ok(
  has_function_privilege('authenticated', 'public.analytics_pool_save(text, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.analytics_pool(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analytics_pool_save(text, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analytics_pool_pending(text, uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.analytics_pool(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.pool_counted_hands_reset()', 'execute'),
  '... executable by authenticated, not by anon; the trigger function by nobody');
select ok(
  (select count(*) = 0 from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('pool_counted_hands', 'pool_players', 'pool_player_stats')
     and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT')
  and (select bool_and(c.relrowsecurity) from pg_class c
       where c.oid in ('public.pool_counted_hands'::regclass, 'public.pool_players'::regclass,
                       'public.pool_player_stats'::regclass))
  and (select count(*) = 3 from public.account_data_inventory
       where name in ('public.pool_counted_hands', 'public.pool_players', 'public.pool_player_stats')
         and export = 'derived'),
  'the tables: no client write grant, RLS on, all three in the account inventory');

-- ------------------------------------------------------------ the data --

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at)
select pg_temp.hid(n),
       case when n < 4 then '00000000-0000-0000-0000-0000000b00a1' else '00000000-0000-0000-0000-0000000b00b1' end::uuid,
       'pokerstars:pool' || n,
       jsonb_build_object('schema', 'phf/1',
                          'game', jsonb_build_object('variant', 'holdem', 'limit', 'nl', 'format', 'cash',
                                                     'bigBlind', 100, 'smallBlind', 50),
                          'players', '[]'::jsonb, 'actions', '[]'::jsonb),
       'std', 'pokerstars', 1, 'BTN', 'cash', 'USD', 100, 50, 100, 0,
       array['As', 'Kd'], '2026-11-01T12:00:00Z'::timestamptz + n * interval '1 hour'
from generate_series(1, 4) n;

-- A's opponents by their numbers over every hand (the vs-type rule's source).
insert into public.player_stats (owner_id, stats_version, site_id, player, site_anonymization, game_format, variant,
                                 limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr)
values
  ('00000000-0000-0000-0000-0000000b00a1', 'stats/2', 'pokerstars', 'RegRita', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 100, 100, 100, 22, 100, 18),
  ('00000000-0000-0000-0000-0000000b00a1', 'stats/2', 'pokerstars', 'FishFred', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 100, 100, 100, 55, 100, 5),
  ('00000000-0000-0000-0000-0000000b00a1', 'stats/2', 'pokerstars', 'NewNick', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 100, 10, 10, 2, 10, 2);

create function pg_temp.hand(p_n bigint, p_players jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('hand_id', pg_temp.hid(p_n), 'players', p_players);
$$;
grant execute on function pg_temp.hand(bigint, jsonb) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000b00a1');

select is((select count(*)::int from public.analytics_pool_pending('analytics/1')), 3, 'A has three hands to count');

select is(
  public.analytics_pool_save('analytics/1', jsonb_build_array(
    pg_temp.hand(1, '[{"player":"RegRita","net_bb":2.5,"stats":{"river_fold_vs_bet":[1,1],"vpip":[1,1]}},
                      {"player":"FishFred","net_bb":-4,"stats":{"river_fold_vs_bet":[0,1]}},
                      {"player":"NewNick","net_bb":1.5,"stats":{"river_fold_vs_bet":[1,1]}}]'),
    pg_temp.hand(2, '[{"player":"RegRita","net_bb":-1.5,"stats":{"river_fold_vs_bet":[0,1],"vpip":[0,1]}},
                      {"player":"FishFred","net_bb":null,"stats":{"vpip":[1,1]}}]'),
    pg_temp.hand(4, '[{"player":"RegRita","net_bb":100,"stats":{"vpip":[1,1]}}]'))),
  '{"saved": 2, "players": 5, "received": 3}'::jsonb,
  'two of A''s hands saved with five seats; B''s hand is not A''s to mark');
select is(
  public.analytics_pool_save('analytics/1', jsonb_build_array(
    pg_temp.hand(1, '[{"player":"RegRita","net_bb":2.5,"stats":{"river_fold_vs_bet":[1,1]}}]'))) ->> 'saved',
  '0', 'a hand sent again adds nothing');

select is(public.analytics_pool('{"statsVersion":"stats/2"}') -> 'reg',
          '{"hands": 2, "netBb": 1.0, "players": 1, "netBbSq": 8.5}'::jsonb,
          'the regs: one player, two hands, Σ result 1 bb, Σ result² 8.5');
select is(public.analytics_pool('{"statsVersion":"stats/2"}') -> 'fish',
          '{"hands": 1, "netBb": -4.0, "players": 1, "netBbSq": 16.0}'::jsonb,
          'the fish: the cashout hand''s result left out, its rates kept');
select is(public.analytics_pool('{"statsVersion":"stats/2"}') -> 'stats',
          '[{"opp": 2, "made": 1, "stat": "river_fold_vs_bet", "type": "reg"},
            {"opp": 1, "made": 0, "stat": "river_fold_vs_bet", "type": "fish"},
            {"opp": 2, "made": 1, "stat": "vpip", "type": "reg"},
            {"opp": 1, "made": 1, "stat": "vpip", "type": "fish"}]'::jsonb,
          'the rates by type (an untyped opponent is out)');
-- Since P1 (20271127090000) pending is the derive counter: A's three hands are
-- still queued (analytics_pool_save does not take them off).
select is((public.analytics_pool('{"statsVersion":"stats/2"}') ->> 'pending')::int, 3,
  'pending: A''s hands still being processed (derive_pending)');
select is((select array_agg(id) from public.analytics_pool_pending('analytics/1')), array[pg_temp.hid(3)],
          '... the third, on the work list');
select is((public.analytics_pool('{"statsVersion":"stats/2","gameKind":"tournament"}') -> 'reg' ->> 'players')::int, 0,
          'another kind: nobody');
select is((public.analytics_pool('{"statsVersion":"stats/2","sites":["winamax"]}') -> 'fish' ->> 'players')::int, 0,
          'another room: nobody');
select is((public.analytics_pool('{"statsVersion":"stats/2","sites":["pokerstars"],"gameFormat":"cash"}') -> 'reg' ->> 'hands')::int, 2,
          'its own room and format: the same');
select is((public.analytics_pool('{"statsVersion":"stats/1"}') -> 'reg' ->> 'players')::int, 0,
          'the types come from player_stats at the version named');

-- Another account.
select pg_temp.act_as('00000000-0000-0000-0000-0000000b00b1');
select is((public.analytics_pool('{"statsVersion":"stats/2"}') -> 'reg' ->> 'players')::int, 0, 'B reads none of A''s pool');
select is((select count(*)::int from public.pool_players), 0, '... nor A''s rows');
select is((select count(*)::int from public.analytics_pool_pending('analytics/1')), 1, 'B''s own hand is B''s to count');

-- Refusals.
select pg_temp.act_as('00000000-0000-0000-0000-0000000b00a1');
select throws_ok($$ select public.analytics_pool_save('analytics/1', '[{"hand_id":"x","players":[]}]') $$, '22023', null,
                 'a malformed hand is refused');
select throws_ok($$ select public.analytics_pool_save('analytics/1', jsonb_build_array(pg_temp.hand(3,
                   '[{"player":"RegRita","net_bb":1,"stats":{"vpip":[2,1]}}]'))) $$, '22023', null,
                 'more made than opportunities is refused');
select throws_ok($$ select public.analytics_pool_save('analytics/1', jsonb_build_array(pg_temp.hand(3,
                   '[{"player":"RegRita","net_bb":1,"stats":{"Bad Id":[0,1]}}]'))) $$, '22023', null,
                 'a stat id that is not one is refused');

-- Another version replaces the old one.
select is(public.analytics_pool_save('analytics/2', jsonb_build_array(
            pg_temp.hand(3, '[{"player":"RegRita","net_bb":3,"stats":{"vpip":[1,1]}}]'))) ->> 'saved', '1',
          'a hand saved at analytics/2 ...');
select is((select count(*)::int from public.pool_players where membership_version = 'analytics/1'), 0,
          '... drops the rows of analytics/1');

-- A deleted hand empties the owner's pool.
reset role;
delete from public.hands where id = pg_temp.hid(2);
select is((select count(*)::int from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000b00a1')
          + (select count(*)::int from public.pool_counted_hands where owner_id = '00000000-0000-0000-0000-0000000b00a1'),
          0, 'a deleted hand empties the owner''s pool and marks');
select is((select count(*)::int from public.pool_counted_hands where owner_id = '00000000-0000-0000-0000-0000000b00b1'), 0,
          '... and nobody else''s (B had none)');

select * from finish();
rollback;
