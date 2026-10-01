-- pgTAP: stats_breakdown (F13 / M3, #48) -- `20261116090000_stats_breakdown.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000007a1', 'bd.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000007b1', 'bd.b@example.com', now(), now());

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
create function pg_temp.act_as_owner() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.act_as_owner() to anon, authenticated;

-- One hand per (owner, n); a hero row per hand with the dimensions under test.
create function pg_temp.hand(p_owner uuid, p_n int, p_pos text, p_class text, p_net bigint,
                             p_format text default 'cash', p_currency text default 'USD',
                             p_stack int default 1000) returns void language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at)
  values (v_id, p_owner, 'pokerstars:bd' || p_owner || p_n, '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now());
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands,
                                 game_format, currency, currency_minor_units, small_blind, big_blind,
                                 player_count, position, hand_class, starting_stack_bb_tenths,
                                 vpip_opp, vpip, pfr_opp, pfr, won, contributed, net, net_bb_milli)
  values (v_id, p_owner, 'stats/1', 1, 'pokerstars:bd' || p_owner || p_n, 'pokerstars', true, 1,
          p_format::public.game_format, p_currency, case when p_format = 'cash' then 100 else 1 end, 50, 100,
          6, p_pos, p_class, p_stack,
          1, 1, 1, case when p_net > 0 then 1 else 0 end,
          100 + p_net, 100, p_net, p_net * 10);
end;
$$;

select pg_temp.hand('00000000-0000-0000-0000-0000000007a1', 1, 'BTN', 'AKs',  300);
select pg_temp.hand('00000000-0000-0000-0000-0000000007a1', 2, 'BTN', 'AKs', -100);
select pg_temp.hand('00000000-0000-0000-0000-0000000007a1', 3, 'BB',  '72o', -100, p_stack => 3000);
select pg_temp.hand('00000000-0000-0000-0000-0000000007b1', 1, 'BTN', 'AKs', 5000);

select pg_temp.act_as('00000000-0000-0000-0000-0000000007a1');

select is(jsonb_array_length(public.stats_breakdown('{}', 'position') -> 'rows'), 2, 'two positions');
select is(public.stats_breakdown('{}', 'position') -> 'rows' -> 0 ->> 'key', 'BTN', 'largest group first');
select is((public.stats_breakdown('{}', 'position') -> 'rows' -> 0 ->> 'hands')::int, 2,
  'BTN has A''s two hands -- B''s is not counted');
select is((public.stats_breakdown('{}', 'position') -> 'rows' -> 0 ->> 'net')::int, 200, 'money sums per group');
select is((public.stats_breakdown('{}', 'position') -> 'rows' -> 0 ->> 'pfr')::int, 1, 'counters sum per group');
select is((select string_agg(r ->> 'key', ',' order by r ->> 'key')
           from jsonb_array_elements(public.stats_breakdown('{}', 'hand_class') -> 'rows') r),
  '72o,AKs', 'hand classes for the matrix');
select is((select string_agg(r ->> 'key', ',' order by r ->> 'key')
           from jsonb_array_elements(public.stats_breakdown('{}', 'stack_bb') -> 'rows') r),
  '100-150,250+', 'stack-depth bands');
select is((public.stats_breakdown('{"positions":["BB"]}', 'hand_class') -> 'rows' -> 0 ->> 'key'), '72o',
  'filters apply before grouping (the matrix by position)');

select throws_ok($$ select public.stats_breakdown('{}', 'owner_id') $$, '22023', null,
  'a column that is not on the whitelist is refused');
select throws_ok($$ select public.stats_breakdown('{}', 'position; drop table public.hands') $$, '22023', null,
  'so is anything shaped like SQL');

-- Chips next to cash: no money at all.
select pg_temp.act_as_owner();
select pg_temp.hand('00000000-0000-0000-0000-0000000007b1', 2, 'SB', 'QQ', 2000, 'tournament', 'CHIPS');
select pg_temp.act_as('00000000-0000-0000-0000-0000000007b1');
select ok(not (public.stats_breakdown('{}', 'position') -> 'rows' -> 0 ? 'net_bb_milli'),
  'a sample mixing chips and cash carries no money, not even bb');
select is((public.stats_breakdown('{"gameFormat":"cash"}', 'position') -> 'rows' -> 0 ->> 'net_bb_milli')::int, 50000,
  '... and filtering to one format brings it back');

select pg_temp.act_as_anon();
select throws_ok($$ select public.stats_breakdown('{}', 'position') $$, '42501', null, 'anon cannot call it');

select pg_temp.act_as('00000000-0000-0000-0000-0000000007a1');
select is(public.stats_breakdown('{"statsVersion":"stats/2"}', 'position') -> 'rows', '[]'::jsonb,
  'another version is another sample');

select * from finish();
rollback;
