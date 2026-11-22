-- pgTAP: Analytics rollout safety (`20271123090000_analytics_rollout_safety.sql`,
-- docs/ANALYTICS.md Step 12) - a production account whose data the new
-- build has not caught up on yet.
--
-- What has to hold:
--
--   * a user whose hands have only `facts/1` rows (stored before Step 11's
--     `facts/2`) keeps every builder-fact filter: the Hands list, its counts,
--     the reports and the Analytics checker's hands read each hand's newest
--     row when it has none at the client's version;
--   * the Effective stack chip (a `facts/2` fact) matches none of those hands
--     until their facts are derived again, and then exactly the ones that
--     were; `hand_facts_missing` / `hands_needing_stats` name the rest as
--     the rebuild's work;
--   * `save_hand_facts` drops a saved hand's older rows, never a newer one
--     (a browser on the previous build saves facts/1 beside facts/2 and reads
--     its own); one account cannot delete another's rows;
--   * the Analytics readers answer an account with nothing backfilled (no
--     checker rows, no pool counted) without an error: nothing summed,
--     `pending` the work left.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(20);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000f0a01', 'rollout.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000f0a02', 'rollout.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- A's three hands; B's one.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, board_cards, player_names,
                          went_to_showdown, total_pot, hero_profit, site_hand_id) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-0000000f0a01', 'pokerstars:r1', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-05T12:00:00Z', 6, 'CO',
   '{Ah,Qd}', 'AQo', '{Ad,7c,2s}', '{Hero,Villain}', false, 650, 350, 'r1'),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-0000000f0a01', 'pokerstars:r2', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-04T12:00:00Z', 3, 'BB',
   '{9h,8h}', '98s', '{2c,7d,9s}', '{Hero,Villain}', true, 650, 350, 'r2'),
  ('00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-0000000f0a01', 'pokerstars:r3', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-03T12:00:00Z', 4, 'UTG',
   '{Kc,Kd}', 'KK', '{}', '{Hero}', false, 250, 150, 'r3'),
  ('00000000-0000-0000-0000-0000000f1004', '00000000-0000-0000-0000-0000000f0a02', 'pokerstars:r4', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-02T12:00:00Z', 1, 'BTN',
   '{7c,2d}', '72o', '{}', '{Hero}', false, 150, -50, 'r4');

-- A's facts as the previous build saved them: facts/1, no effective stack.
-- r1 and r2 made top pair on the flop (index 4 of the builder's list).
select pg_temp.act_as('00000000-0000-0000-0000-0000000f0a01');
select is(public.save_hand_facts($j$[
  {"hand_key": "pokerstars:r1", "facts_version": "facts/1", "flop_made": 4, "players_flop": 2},
  {"hand_key": "pokerstars:r2", "facts_version": "facts/1", "flop_made": 4, "players_flop": 2},
  {"hand_key": "pokerstars:r3", "facts_version": "facts/1"}
]$j$::jsonb) ->> 'inserted', '3', 'A''s hands have facts/1 rows only');

create function pg_temp.ids(p_filter jsonb) returns text language sql as $$
  select coalesce(string_agg(right(r ->> 'handKey', 1), '' order by r ->> 'handKey'), '')
  from jsonb_array_elements(public.library_page(p_filter || '{"statsVersion":"stats/2","factsVersion":"facts/2"}', null, 100) -> 'rows') r;
$$;
create function pg_temp.keys(p_ids uuid[]) returns text language sql as $$
  select coalesce(string_agg(right(h.hand_key, 1), '' order by h.hand_key), '')
  from public.hands h where h.id = any (p_ids);
$$;
grant execute on function pg_temp.ids(jsonb), pg_temp.keys(uuid[]) to authenticated;

-- ------------------------------------------- facts/1 only, client facts/2 --

select is(pg_temp.ids('{"flopMade":["topPair"]}'), '12',
  'a facts/2 client''s builder filter reads the hands'' facts/1 rows (not nothing)');
select is(pg_temp.ids('{"playersFlop":["2"]}'), '12', '... every builder fact, not one');
select is((public.library_facets('{"statsVersion":"stats/2","factsVersion":"facts/2","flopMade":["topPair"]}') ->> 'total')::int, 2,
  '... the list''s counts too');
select is(pg_temp.keys(public.report_hand_ids('{"statsVersion":"stats/2","factsVersion":"facts/2","flopMade":["topPair"]}')),
  '12', '... the reports (graph, figures, the Pool tab''s win rates)');
select is(pg_temp.keys(public.analysis_hand_ids('{"hands":{"statsVersion":"stats/2","factsVersion":"facts/2","flopMade":["topPair"]}}')),
  '12', '... and the Analytics checker''s hands');
select is(pg_temp.ids('{"effStacks":["0-40","40-80","80-120","120+"]}'), '',
  'the Effective stack chip matches no hand whose facts are not derived at facts/2 yet');
select is(public.hand_facts_missing('facts/2'), 3::bigint, 'the three are the rebuild''s work (hand_facts_missing)');
select is((select count(*)::int from public.hands_needing_stats('stats/2', null, 200, false, null, 'facts/2')), 3,
  '... and its page (hands_needing_stats)');

-- ----------------------------------------------------- the rebuild, r1 --

select is(public.save_hand_facts($j$[
  {"hand_key": "pokerstars:r1", "facts_version": "facts/2", "flop_made": 4, "players_flop": 2, "eff_stack_tenths": 1000}
]$j$::jsonb) ->> 'inserted', '1', 'the rebuild saves r1 at facts/2');
select is((select string_agg(facts_version, ',' order by facts_version) from public.hand_facts
            where hand_id = '00000000-0000-0000-0000-0000000f1001'),
  'facts/2', '... and drops its facts/1 row (no second copy of every hand)');
select is(pg_temp.ids('{"effStacks":["80-120"]}'), '1', 'the chip matches r1 now, and only r1');
select is(pg_temp.ids('{"flopMade":["topPair"]}'), '12', 'the other filters read r1''s facts/2 and r2''s facts/1 alike');
select is(public.hand_facts_missing('facts/2'), 2::bigint, 'two hands left for the rebuild');

-- ------------------------------------------- the previous build, still open --

select is(public.save_hand_facts($j$[
  {"hand_key": "pokerstars:r1", "facts_version": "facts/1", "flop_made": 9}
]$j$::jsonb) ->> 'inserted', '1', 'a browser on the previous build saves r1 at facts/1');
select is((select string_agg(facts_version, ',' order by facts_version) from public.hand_facts
            where hand_id = '00000000-0000-0000-0000-0000000f1001'),
  'facts/1,facts/2', '... beside facts/2, which stays');
select is(
  (select coalesce(string_agg(right(r ->> 'handKey', 1), '' order by r ->> 'handKey'), '')
     from jsonb_array_elements(public.library_page('{"statsVersion":"stats/2","factsVersion":"facts/1","flopMade":["straight"]}', null, 100) -> 'rows') r)
  || '/' || pg_temp.ids('{"flopMade":["straight"]}'),
  '1/', 'each build reads its own version''s row where the hand has one');

-- ------------------------------------------------------------ B --

select pg_temp.act_as('00000000-0000-0000-0000-0000000f0a02');
create function pg_temp.delete_facts() returns int language plpgsql as $$
declare n int;
begin
  delete from public.hand_facts;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function pg_temp.delete_facts() to authenticated;
select is(pg_temp.delete_facts(), 0, 'B deletes none of A''s facts rows');

-- -------------------------------- the Analytics readers, nothing backfilled --

select is(
  (select jsonb_build_object('hands', c -> 'hands', 'pending', c -> 'pending', 'groups', c -> 'groups')
     from public.analytics_checker('{"analysisVersion":"analysis/50"}') c),
  '{"hands": 0, "pending": 0, "groups": []}'::jsonb,
  'the checker answers an account without checker rows: nothing summed, no error');
select is(
  (select jsonb_build_object('pending', p -> 'pending', 'reg', p -> 'reg' -> 'hands', 'fish', p -> 'fish' -> 'hands')
     from public.analytics_pool('{}') p),
  '{"pending": 1, "reg": 0, "fish": 0}'::jsonb,
  'the pool answers an account counted for nothing: its hands pending, no types yet');

select * from finish();
rollback;
