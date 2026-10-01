-- pgTAP: sessions, bankroll and opponent notes (F14, #54) --
-- `20261214090000_sessions_notes.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000aaa1', 'sn.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000bbb1', 'sn.b@example.com', now(), now());

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

-- A hand and its hero row, `p_min` minutes after a fixed start.
create function pg_temp.hand(p_owner uuid, p_n int, p_min int, p_table text, p_net bigint,
                             p_site text default 'weplay', p_anon text default 'none',
                             p_players text[] default array['Hero', 'RegularRon']) returns void language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at, site_anonymization, player_names)
  values (v_id, p_owner, p_site || ':sn' || p_owner || p_n, '{"schema":"phf/1"}', 'std', p_site, 1,
          '2026-03-01T18:00:00Z'::timestamptz + make_interval(mins => p_min), p_anon::public.site_anonymization,
          case when p_anon = 'positional' then '{}'::text[] else p_players end);
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands,
                                 game_format, currency, currency_minor_units, big_blind, table_name, played_at,
                                 won, contributed, net, net_bb_milli, site_anonymization)
  values (v_id, p_owner, 'stats/1', 1, p_site || ':sn' || p_owner || p_n, p_site, true, 1, 'cash', 'USD', 100, 100, p_table,
          '2026-03-01T18:00:00Z'::timestamptz + make_interval(mins => p_min),
          1000 + p_net, 1000, p_net, p_net * 10, p_anon::public.site_anonymization);
end;
$$;

-- A: session one, two tables, 18:00-18:20; a 2-hour break; session two at 20:30.
select pg_temp.hand('00000000-0000-0000-0000-00000000aaa1', 1,   0, 'Alpha',  500);
select pg_temp.hand('00000000-0000-0000-0000-00000000aaa1', 2,   5, 'Beta',  -200);
select pg_temp.hand('00000000-0000-0000-0000-00000000aaa1', 3,  20, 'Alpha',  100);
select pg_temp.hand('00000000-0000-0000-0000-00000000aaa1', 4, 150, 'Gamma', -900);
select pg_temp.hand('00000000-0000-0000-0000-00000000aaa1', 5, 900, 'Bodog', 0, 'ignition', 'positional');
select pg_temp.hand('00000000-0000-0000-0000-00000000bbb1', 1,   0, 'Alpha', 5000);

select pg_temp.act_as('00000000-0000-0000-0000-00000000aaa1');

select is(jsonb_array_length(public.stats_sessions('{"gameFormat":"cash"}') -> 'sessions'), 3,
  'two hours apart is two sessions (and the ignition hand a third)');
select is(public.stats_sessions('{"gameFormat":"cash"}') -> 'sessions' -> 2 ->> 'hands', '3', 'the first session holds three hands');
select is(public.stats_sessions('{"gameFormat":"cash"}') -> 'sessions' -> 2 ->> 'tables', '2', '... across two tables');
select is(public.stats_sessions('{"gameFormat":"cash"}') -> 'sessions' -> 2 ->> 'net', '400', '... and nets +$4');
select is(public.stats_sessions('{"gameFormat":"cash"}') -> 'sessions' -> 1 ->> 'net', '-900', 'the second session is its own');
select is(jsonb_array_length(public.stats_sessions('{"gameFormat":"cash"}', 180) -> 'sessions'), 2,
  'a wider gap merges the first two');

-- ----------------------------------------------------------------- notes --

select is(public.set_player_note('weplay', 'RegularRon', 'Overfolds to 3-bets', array['Nit', ' nit ', 'reg']) -> 'tags',
  '["nit", "reg"]'::jsonb, 'a note on a player you sat with; tags folded and deduplicated');
select is(public.my_player_notes() -> 0 ->> 'note', 'Overfolds to 3-bets', 'and it reads back');
select throws_ok($$ select public.set_player_note('weplay', 'NeverMet', 'x') $$, '22023', null,
  'no note on a player you have never sat with');
select throws_ok($$ select public.set_player_note('ignition', 'UTG+1', 'x') $$, '22023', null,
  'no note in a positional room: the name is a seat');
select is(public.set_player_note('weplay', 'RegularRon', '', '{}'), null, 'clearing a note removes it');
select is(jsonb_array_length(public.my_player_notes()), 0, '... gone');

select public.set_player_note('weplay', 'RegularRon', 'Again');
select pg_temp.act_as('00000000-0000-0000-0000-00000000bbb1');
select is(jsonb_array_length(public.my_player_notes()), 0, 'notes are private');

select pg_temp.act_as_anon();
select throws_ok($$ select public.stats_sessions() $$, '42501', null, 'anon has no sessions');

select * from finish();
rollback;
