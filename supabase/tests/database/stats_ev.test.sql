-- pgTAP: all-in EV storage and the graph's fourth line (F13 / M5, #50) --
-- `20261207090000_stats_ev.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000eea1', 'ev.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000eeb1', 'ev.b@example.com', now(), now());

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

-- A: three cash hands with hero rows. Hand 1 is an all-in the hero lost
-- (-100 bb) at 80% equity; hands 2 and 3 have no all-in (+10 bb each).
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at) values
  ('00000000-0000-0000-0000-0000000ee001', '00000000-0000-0000-0000-00000000eea1', 'pokerstars:ev1', '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000ee002', '00000000-0000-0000-0000-00000000eea1', 'pokerstars:ev2', '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000ee003', '00000000-0000-0000-0000-00000000eea1', 'pokerstars:ev3', '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000ee0b1', '00000000-0000-0000-0000-00000000eeb1', 'pokerstars:evb1', '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now());

insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands,
                               game_format, currency, currency_minor_units, big_blind, played_at,
                               won, contributed, net, net_bb_milli) values
  ('00000000-0000-0000-0000-0000000ee001', '00000000-0000-0000-0000-00000000eea1', 'stats/1', 1, 'pokerstars:ev1', 'pokerstars', true, 1, 'cash', 'USD', 100, 100, now() - interval '3 hours', 0, 10000, -10000, -100000),
  ('00000000-0000-0000-0000-0000000ee002', '00000000-0000-0000-0000-00000000eea1', 'stats/1', 1, 'pokerstars:ev2', 'pokerstars', true, 1, 'cash', 'USD', 100, 100, now() - interval '2 hours', 2000, 1000, 1000, 10000),
  ('00000000-0000-0000-0000-0000000ee003', '00000000-0000-0000-0000-00000000eea1', 'stats/1', 1, 'pokerstars:ev3', 'pokerstars', true, 1, 'cash', 'USD', 100, 100, now() - interval '1 hour', 2000, 1000, 1000, 10000),
  ('00000000-0000-0000-0000-0000000ee0b1', '00000000-0000-0000-0000-00000000eeb1', 'stats/1', 1, 'pokerstars:evb1', 'pokerstars', true, 1, 'cash', 'USD', 100, 100, now(), 0, 100, -100, -1000);

select pg_temp.act_as('00000000-0000-0000-0000-00000000eea1');

select is(public.stats_ev_missing('stats/1', 'ev/1'), 3::bigint, 'three of A''s hands are not evaluated yet');
select is((select count(*)::int from public.hands_needing_stats('stats/1', null, 100, false, 'ev/1')), 3,
  'the backfill offers them although their statistics are current');
select is((select count(*)::int from public.hands_needing_stats('stats/1', null, 100, false)), 0,
  '... and does not without an EV version (the old call)');
select is((public.stats_graph('{"gameFormat":"cash"}', 3) -> 'allInEv' ->> 'evaluatedHands')::int, 0,
  'before evaluation the graph says nothing is evaluated');
select is((public.stats_graph('{"gameFormat":"cash"}', 3) -> 'buckets' -> 2 ->> 'cum_ev_bb_milli')::bigint, -80000::bigint,
  '... and the EV line equals the result');

-- The rebuild writes one row per hand: the all-in at equity (+60 bb: 80% of a
-- 200 bb pot minus 100 contributed), the others at their result.
select is(public.save_hand_ev('[
  {"hand_key":"pokerstars:ev1","seat":1,"ev_version":"ev/1","applicable":true,"ev_net":6000,"ev_net_bb_milli":60000},
  {"hand_key":"pokerstars:ev2","seat":1,"ev_version":"ev/1","applicable":false,"ev_net":1000,"ev_net_bb_milli":10000},
  {"hand_key":"pokerstars:ev3","seat":1,"ev_version":"ev/1","applicable":false,"ev_net":1000,"ev_net_bb_milli":10000},
  {"hand_key":"pokerstars:evb1","seat":1,"ev_version":"ev/1","applicable":false,"ev_net":0,"ev_net_bb_milli":0}
]'::jsonb) ->> 'inserted', '3', 'rows resolve under RLS: B''s hand key is silently skipped');

select is(public.stats_ev_missing('stats/1', 'ev/1'), 0::bigint, 'nothing left to evaluate');
select is((public.stats_graph('{"gameFormat":"cash"}', 3) -> 'buckets' -> 2 ->> 'cum_ev_bb_milli')::bigint, 80000::bigint,
  'the EV line pays the all-in at equity: +60 +10 +10 bb');
select is((public.stats_graph('{"gameFormat":"cash"}', 3) -> 'buckets' -> 2 ->> 'cum_net_bb_milli')::bigint, -80000::bigint,
  '... while the total line is unchanged');
select is(public.stats_graph('{"gameFormat":"cash"}', 3) -> 'allInEv',
  '{"evVersion": "ev/1", "allInHands": 1, "evaluatedHands": 3}'::jsonb, 'and it says how much of the sample is real');
select is((public.save_hand_ev('[{"hand_key":"pokerstars:ev1","seat":1,"ev_version":"ev/1","applicable":true,"ev_net":1,"ev_net_bb_milli":1}]'::jsonb) ->> 'inserted')::int,
  0, 'a second write of the same row is a no-op, never an update');

select throws_ok($$ update public.hand_stats_ev set ev_net = 0 $$, '42501', null, 'no UPDATE');
select pg_temp.act_as('00000000-0000-0000-0000-00000000eeb1');
select is((select count(*)::int from public.hand_stats_ev), 0, 'B cannot see A''s EV rows');
select pg_temp.act_as_anon();
select throws_ok($$ select * from public.hand_stats_ev $$, '42501', null, 'anon cannot read them');

select * from finish();
rollback;
