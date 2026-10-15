-- pgTAP: opponents' counters by key for the analysis (analysis/20) --
-- `20270526090000_villain_counters.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(20);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000009a1', 'vc.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000009b1', 'vc.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon() to anon, authenticated;

-- A hand with a hero row and villain rows (`p_villains`: name => [vpip_opp, vpip, pfr]).
create function pg_temp.hand(p_owner uuid, p_id uuid, p_anon text, p_format text, p_bomb boolean, p_villains jsonb)
returns void language plpgsql as $$
declare v_seat int := 2; v record;
begin
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at, site_anonymization)
  values (p_id, p_owner, 'weplay:' || p_id, '{"schema":"phf/1"}', 'std', 'weplay', 1, now(),
          p_anon::public.site_anonymization);
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, hands,
                                 site_anonymization, game_format, is_bomb_pot)
  values (p_id, p_owner, 'stats/2', 1, 'weplay:' || p_id, 'weplay', true, 'Me', 1, p_anon::public.site_anonymization,
          p_format::public.game_format, p_bomb);
  for v in select key, value from jsonb_each(coalesce(p_villains, '{}')) loop
    insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, hands,
                                   site_anonymization, game_format, is_bomb_pot, vpip_opp, vpip, pfr_opp, pfr)
    values (p_id, p_owner, 'stats/2', v_seat, 'weplay:' || p_id, 'weplay', false, v.key, 1,
            p_anon::public.site_anonymization, p_format::public.game_format, p_bomb,
            (v.value ->> 0)::int, (v.value ->> 1)::int, (v.value ->> 0)::int, (v.value ->> 2)::int);
    v_seat := v_seat + 1;
  end loop;
end;
$$;

-- A: Fish_1 in three cash hands, one tournament hand and one bomb pot; Reg in
-- one cash hand; a hash in an opaque-id room.
select pg_temp.hand('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-00000000f001', 'none', 'cash', false, '{"Fish_1":[1,1,0],"Reg":[1,1,1]}');
select pg_temp.hand('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-00000000f002', 'none', 'cash', false, '{"Fish_1":[1,1,0]}');
select pg_temp.hand('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-00000000f003', 'none', 'cash', false, '{"Fish_1":[1,0,0]}');
select pg_temp.hand('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-00000000f004', 'none', 'tournament', false, '{"Fish_1":[1,1,1]}');
select pg_temp.hand('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-00000000f005', 'none', 'cash', true, '{"Fish_1":[0,0,0]}');
select pg_temp.hand('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-00000000f006', 'opaque-id', 'cash', false, '{"a1b2c3d4":[1,1,0]}');
-- B: a villain of the same name, and one A never met.
select pg_temp.hand('00000000-0000-0000-0000-0000000009b1', '00000000-0000-0000-0000-00000000f0b1', 'none', 'cash', false, '{"Fish_1":[1,1,1],"OnlyB":[1,1,1]}');

select is((select p.prosecdef from pg_proc p where p.oid = 'public.villain_counters(jsonb, jsonb)'::regprocedure), false,
  'an invoker function: hand_stats'' RLS applies, nothing is bypassed');

select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');

-- ------------------------------------------------------------- counters --

select is(
  (select count(*)::int from public.villain_counters(
     '[{"site":"weplay","player":"Fish_1"},{"site":"weplay","player":"Reg"},{"site":"weplay","player":"Nobody"}]',
     '{"statsVersion":"stats/2"}')),
  2, 'one row per named opponent the caller has rows for; an unknown name returns nothing');

select results_eq(
  $$ select hands, vpip_opp, vpip, pfr from public.villain_counters(
       '[{"site":"weplay","player":"Fish_1"}]', '{"statsVersion":"stats/2","gameFormat":"cash"}') $$,
  $$ values (3::bigint, 3::bigint, 2::bigint, 0::bigint) $$,
  'Fish_1 in cash: three hands of A''s, no bomb pot, no tournament, nothing of B''s');

select is(
  (select hands::int from public.villain_counters('[{"site":"weplay","player":"Fish_1"}]', '{"statsVersion":"stats/2"}')),
  4, 'without gameFormat the tournament hand counts too (the bomb pot never does)');

select results_eq(
  $$ select v.hands, v.vpip_opp, v.vpip, v.pfr
     from public.villain_counters('[{"site":"weplay","player":"Fish_1"},{"site":"weplay","player":"Reg"}]',
                                  '{"statsVersion":"stats/2","gameFormat":"cash"}') v
     order by v.player $$,
  $$ select (r ->> 'hands')::bigint, (r ->> 'vpip_opp')::bigint, (r ->> 'vpip')::bigint, (r ->> 'pfr')::bigint
     from jsonb_array_elements(public.stats_opponents('{"statsVersion":"stats/2","gameFormat":"cash"}') -> 'rows') r
     order by r ->> 'player' $$,
  'the same counters stats_opponents reports for the same opponents');

select is(
  (select count(*)::int from public.villain_counters('[{"site":"weplay","player":"Fish_1"},{"site":"weplay","player":"Reg"}]',
                                                     '{"statsVersion":"stats/2","gameFormat":"cash","minHands":2}')),
  1, 'minHands drops thin samples');

select is(
  (select count(*)::int from public.villain_counters('[{"site":"weplay","player":"a1b2c3d4"}]', '{"statsVersion":"stats/2"}')),
  0, 'an opaque-id hash is never summed');

select is(
  (select count(*)::int from public.villain_counters('[{"site":"other","player":"Fish_1"}]', '{"statsVersion":"stats/2"}')),
  0, 'the room is part of the key');

select is(
  (select count(*)::int from public.villain_counters('[{"site":"weplay","player":"Fish_1"}]', '{}')),
  0, 'the stats version defaults as stats_opponents'' does (stats/1): the client always names it');

select is(
  (select hands::int from public.villain_counters(
     '[{"site":"weplay","player":"Fish_1"},{"site":"weplay","player":"Fish_1"}]', '{"statsVersion":"stats/2","gameFormat":"cash"}')),
  3, 'a key named twice is answered once, not double counted');

select is((select count(*)::int from public.villain_counters('[]', '{"statsVersion":"stats/2"}')), 0, 'no keys, no rows');

select is(
  (select count(*)::int from public.villain_counters(
     (select jsonb_agg(jsonb_build_object('site', 'weplay', 'player', 'P' || g)) from generate_series(1, 500) g),
     '{"statsVersion":"stats/2"}')),
  0, '500 keys are accepted');

-- ------------------------------------------------------------ validation --

select throws_ok(
  $$ select * from public.villain_counters(
       (select jsonb_agg(jsonb_build_object('site', 'weplay', 'player', 'P' || g)) from generate_series(1, 501) g)) $$,
  '22023', null, 'more than 500 keys are refused');
select throws_ok($$ select * from public.villain_counters('{"site":"weplay","player":"Fish_1"}') $$,
  '22023', null, 'an object instead of an array is refused');
select throws_ok($$ select * from public.villain_counters(null) $$, '22023', null, 'null is refused');
select throws_ok($$ select * from public.villain_counters('[{"site":"weplay"}]') $$,
  '22023', null, 'a key without a player is refused');
select throws_ok($$ select * from public.villain_counters('[{"site":"weplay","player":7}]') $$,
  '22023', null, 'a player that is not a string is refused');
select throws_ok($$ select * from public.villain_counters('["weplay:Fish_1"]') $$,
  '22023', null, 'a bare string is refused');

-- ------------------------------------------------------------ isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000009b1');
select results_eq(
  $$ select v.player, v.hands from public.villain_counters(
       '[{"site":"weplay","player":"Fish_1"},{"site":"weplay","player":"Reg"},{"site":"weplay","player":"OnlyB"}]',
       '{"statsVersion":"stats/2"}') v order by v.player $$,
  $$ values ('Fish_1'::text, 1::bigint), ('OnlyB'::text, 1::bigint) $$,
  'a second user sees only their own rows: their Fish_1, and nothing of A''s Reg');

select pg_temp.act_as_anon();
select throws_ok($$ select * from public.villain_counters('[{"site":"weplay","player":"Fish_1"}]') $$,
  '42501', null, 'anon cannot execute it');

select * from finish();
rollback;
