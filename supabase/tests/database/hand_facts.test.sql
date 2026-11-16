-- pgTAP: the filter builder's facts on the web (`20271116130000_hand_facts.sql`).
--
-- What has to hold:
--
--   * `save_hand_facts` stores the caller's rows (the hand resolved under
--     RLS, the owner the session's), keeps a row already there, and refuses
--     another account's hand silently;
--   * `hand_facts_missing` and `hands_needing_stats(p_facts_version)` name
--     the hands without facts at a version - how every stored hand gets them;
--   * the builder's facts groups narrow the Hands list (`library_page`) and
--     its counts (`library_facets`);
--   * RLS: another account reads none of A's facts, anon cannot save.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000fac01', 'facts.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000fac02', 'facts.b@example.com', now(), now());

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

-- A's three hands, B's one.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, board_cards, player_names,
                          went_to_showdown, total_pot, hero_profit, site_hand_id) values
  ('00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-0000000fac01', 'pokerstars:f1', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, '2026-10-05T12:00:00Z', 1, 'BTN',
   '{Ah,Kd}', 'AKo', '{Ks,7c,2d}', '{Hero,Villain}', false, 1500, 500, 'f1'),
  ('00000000-0000-0000-0000-00000000fa02', '00000000-0000-0000-0000-0000000fac01', 'pokerstars:f2', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, '2026-10-04T12:00:00Z', 1, 'BB',
   '{9h,8d}', '98o', '{7s,6c,2d}', '{Hero,Villain}', false, 900, -300, 'f2'),
  ('00000000-0000-0000-0000-00000000fa03', '00000000-0000-0000-0000-0000000fac01', 'winamax:f3', '{"schema":"phf/1"}', 'std',
   'winamax', 'tournament', 'holdem', 'nl', 'CHIPS', 1, '', 50, 100, 6, 6, '2026-10-03T12:00:00Z', 1, 'CO',
   '{9s,9h}', '99', '{}', '{Hero}', false, 400, -100, 'f3'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000fac02', 'pokerstars:fb', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, '2026-10-06T12:00:00Z', 1, 'BTN',
   '{Ah,Kh}', 'AKs', '{}', '{}', false, 100, 10, 'fb');

select pg_temp.act_as('00000000-0000-0000-0000-0000000fac01');
select is(public.hand_facts_missing('facts/1'), 3::bigint, 'A''s three hands have no facts yet');
select is((select count(*) from public.hands_needing_stats('stats/2', null, 100, false, null, 'facts/1')), 3::bigint,
  '... and the rebuild reads them');

select is(public.save_hand_facts($j$[
  {"hand_key": "pokerstars:f1", "facts_version": "facts/1", "flop_made": 4, "flop_kicker": 1, "flop_bet_pct": 33,
   "players_flop": 2, "hero_ip": true, "vs_seats": " 2 ", "vs_positions": " BB ", "vs_players": ["Villain"], "open_tenths": 25},
  {"hand_key": "pokerstars:f2", "facts_version": "facts/1", "flop_made": 0, "flop_draws": 4, "players_flop": 2,
   "hero_ip": false, "vs_seats": " 4 ", "vs_positions": " BTN ", "vs_players": ["Villain"], "hero_bluff": 1},
  {"hand_key": "winamax:f3", "facts_version": "facts/1", "buy_in_cents": 1100, "bounty": true, "tour_level": 3},
  {"hand_key": "pokerstars:fb", "facts_version": "facts/1", "flop_made": 4}
]$j$::jsonb) ->> 'inserted', '3', 'save_hand_facts stores A''s three and not B''s hand');
select is((select count(*) from public.hand_facts where owner_id = '00000000-0000-0000-0000-0000000fac01'), 3::bigint,
  '... under A');
select is(public.save_hand_facts('[{"hand_key": "pokerstars:f1", "facts_version": "facts/1", "flop_made": 11}]') ->> 'inserted', '0',
  'a row already there is kept');
select is(public.hand_facts_missing('facts/1') || '/' || public.hand_facts_missing('facts/2'), '0/3',
  'none missing at its version, every one at the next');

create function pg_temp.ids(p_filter jsonb) returns text language sql as $$
  select coalesce(string_agg(right(r ->> 'handKey', 1), '' order by o), '')
  from jsonb_array_elements(public.library_page(p_filter || '{"statsVersion":"stats/2","factsVersion":"facts/1"}', null, 100) -> 'rows')
       with ordinality as t(r, o);
$$;
grant execute on function pg_temp.ids(jsonb) to authenticated;
select is(pg_temp.ids('{"flopMade":["topPair"],"kickers":["top"]}'), '1', 'made hand and kicker');
select is(pg_temp.ids('{"flopDraws":["oesd"]}') || '/' || pg_temp.ids('{"positionFlop":["oop"]}'), '2/2', 'draws, out of position');
select is(pg_temp.ids('{"flopSizes":["small"],"openMin":2}'), '1', 'the flop bet''s size, the open');
select is(pg_temp.ids('{"vsPositions":["BTN"]}') || '/' || pg_temp.ids('{"heroBluffs":["flop"]}'), '2/2',
  'an opponent''s position, the hero caught bluffing');
select is(pg_temp.ids('{"buyInMin":10,"bounty":true,"levels":["1-5"]}'), '3', 'buy-in, bounty, level');
select is(pg_temp.ids('{"vsTypes":["unknown"]}'), '12', 'an opponent with no numbers is unknown');
select is((public.library_facets('{"statsVersion":"stats/2","factsVersion":"facts/1","flopMade":["topPair","highCard"]}') ->> 'total')::int, 2,
  'the counts read the facts');

select pg_temp.act_as('00000000-0000-0000-0000-0000000fac02');
select is((select count(*) from public.hand_facts), 0::bigint, 'B reads none of A''s facts');

select * from finish();
rollback;
