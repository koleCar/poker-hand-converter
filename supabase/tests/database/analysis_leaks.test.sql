-- pgTAP: hand analysis, phase A6 -- `20270201090000_analysis_leaks.sql`.
--
-- The leak finder and the trend sum graded decisions per finest spot and per
-- time bucket. What has to hold:
--
--   * the security model is unchanged: no table grant moved, the three reports
--     and their three helpers are invoker with an empty search_path,
--     executable by `authenticated` (the reports run their helpers as the
--     caller) and not by `anon`;
--   * the helpers: the best action is the highest-EV option, the spot key is
--     the six parts in order;
--   * the arithmetic: per spot (decisions, hands, worse than Perfect,
--     Inaccurate or worse, EV lost, score sums), graded hands, dates, facets;
--     per week, month and session, and per street within a bucket;
--   * every filter `analysis_scope` takes applies, the facets ignore them, and
--     a report reads exactly one `analysis_version`;
--   * spot keys, sorts, buckets and groups are validated;
--   * one user's decisions never reach another's report, and anon reads nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(53);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a6aa1', 'lk.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a6bb1', 'lk.b@example.com', now(), now());

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

-- A: four hands. h1 and h2 twenty minutes apart on Monday 2 March (one
-- session, one ISO week), h3 the next Tuesday, h4 in April. Two rooms.
-- B: one hand, at A's spot.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-0000000a6001', '00000000-0000-0000-0000-0000000a6aa1', 'weplay:lk1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'UTG', 'cash', 'USD', 100, 50, 100, 150,
   array['As','Kd'], '2026-03-02T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000a6002', '00000000-0000-0000-0000-0000000a6aa1', 'weplay:lk2',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['Qh','Jh'], '2026-03-02T10:20:00Z'),
  ('00000000-0000-0000-0000-0000000a6003', '00000000-0000-0000-0000-0000000a6aa1', 'pokerstars:lk3',
   '{"schema":"phf/1"}', 'std', 'pokerstars', 2, 'BB', 'cash', 'USD', 100, 100, 200, -200,
   array['Kc','Qd'], '2026-03-10T09:00:00Z'),
  ('00000000-0000-0000-0000-0000000a6004', '00000000-0000-0000-0000-0000000a6aa1', 'weplay:lk4',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BTN', 'cash', 'USD', 100, 50, 100, 0,
   array['9s','8s'], '2026-04-01T12:00:00Z'),
  ('00000000-0000-0000-0000-0000000a6b01', '00000000-0000-0000-0000-0000000a6bb1', 'weplay:lkb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0,
   array['Ah','Ad'], '2026-03-03T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000a6b02', '00000000-0000-0000-0000-0000000a6bb1', 'weplay:lkb2',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0,
   array['Kh','Jh'], '2026-03-04T10:00:00Z');

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('hand_analysis', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'still no client write grant on either table');
select ok(
  (select bool_and(not p.prosecdef) and count(*) = 7 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_best_action', 'analysis_spot_key', 'analysis_graded_decisions',
                       'analysis_graded_facets', 'analysis_leaks', 'analysis_leak_hands', 'analysis_trend')),
  'the three reports and their four helpers are security invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_best_action', 'analysis_spot_key', 'analysis_graded_decisions',
                       'analysis_graded_facets', 'analysis_leaks', 'analysis_leak_hands', 'analysis_trend')),
  '... and pin an empty search_path');
select ok(has_function_privilege('authenticated', 'public.analysis_best_action(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.analysis_spot_key(text, text, text, text, text, text)', 'execute')
      and has_function_privilege('authenticated', 'public.analysis_graded_decisions(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.analysis_graded_facets(text)', 'execute'),
  'the helpers are executable by authenticated (the invoker reports call them as their caller)');
select ok(has_function_privilege('authenticated', 'public.analysis_leaks(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)', 'execute')
      and has_function_privilege('authenticated', 'public.analysis_trend(jsonb, text, text, integer)', 'execute'),
  '... and so are the reports');
select ok(not has_function_privilege('anon', 'public.analysis_best_action(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_spot_key(text, text, text, text, text, text)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_graded_decisions(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_graded_facets(text)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_leaks(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_trend(jsonb, text, text, integer)', 'execute'),
  'none of them by anon');

-- ------------------------------------------------------------- helpers --

select is(public.analysis_best_action('[{"action":"fold","freq":0,"ev":0},{"action":"call","freq":0.2,"ev":1.5},{"action":"raise","freq":0.8,"ev":1.2}]'),
  'call', 'the best action is the highest-EV option, whatever the frequencies');
select is(public.analysis_best_action('[{"action":"check","freq":0.3,"ev":2},{"action":"bet","freq":0.7,"ev":2}]'),
  'bet', '... ties go to the more frequent');
select is(public.analysis_best_action('[]'), null, 'no options, no best action');
select is(public.analysis_spot_key('preflop', 'vs-open', 'fffrf', 'BB', 'fold', 'call'),
  'preflop|vs-open|fffrf|BB|fold|call', 'the spot key is the six parts in order');

-- ------------------------------------------------------------ the data --
--
--   h1 UTG ""      raise  perfect   0.0   (+ a heuristic flop bet: not graded, not counted)
--   h2 BB  "fffrf" fold   mistake   0.8   best call
--      BB  river   check  good      0.3   best bet
--   h3 BB  "fffrf" fold   blunder   2.0   best call
--   h4 BTN "fff"   raise  perfect   0.0
--   h1 again at analysis/9: "" fold, mistake -- a different version.

select pg_temp.act_as('00000000-0000-0000-0000-0000000a6aa1');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a6001","analysis_version":"analysis/3","status":"full","hero_seat":1,
   "pot_type":"single-raised","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"approximations":[],"decisions":[
     {"ord":0,"action_index":2,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[{"action":"fold","sizeBb":0,"freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":0.4}],"chosen":1,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"AKo","position":"UTG","chart":{"set":"nlhe-cash-6max-100bb","line":"","scenario":"rfi","inRange":1}}},
     {"ord":4,"action_index":9,"street":"flop","action":"bet","status":"analysed","node":"n","scenario":"pfr-ip-first",
      "source":"heuristic","flags":[],"approximations":["heuristic"],"facing_bet":false,"pot_bb":5.5,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a6002","analysis_version":"analysis/3","status":"full","hero_seat":2,
   "pot_type":"single-raised","grade":"mistake","score":65,"ev_loss_bb":1.1,"ev_loss_pot":0.2,"approximations":[],"decisions":[
     {"ord":0,"action_index":5,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.8,"ev_loss_pot":0.05,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.2}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}},
     {"ord":5,"action_index":20,"street":"river","action":"check","status":"analysed","node":"n","scenario":"caller-oop-first",
      "source":"solver","grade":"good","score":80,"ev_loss_bb":0.3,"ev_loss_pot":0.03,"freq_diff":0.4,
      "options":[{"action":"check","freq":0.3,"ev":1},{"action":"bet","size":3,"freq":0.7,"ev":1.3}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":10,"facts":{"position":"BB"}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a6003","analysis_version":"analysis/3","status":"full","hero_seat":2,
   "pot_type":"single-raised","grade":"blunder","score":0,"ev_loss_bb":2,"ev_loss_pot":0.5,"approximations":[],"decisions":[
     {"ord":0,"action_index":5,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"blunder","score":0,"ev_loss_bb":2,"ev_loss_pot":0.5,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":1}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"KQo","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a6004","analysis_version":"analysis/3","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"approximations":[],"decisions":[
     {"ord":0,"action_index":3,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[{"action":"fold","sizeBb":0,"freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":0.3}],"chosen":1,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"98s","position":"BTN","chart":{"set":"nlhe-cash-6max-100bb","line":"fff","scenario":"rfi","inRange":1}}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a6001","analysis_version":"analysis/9","status":"full","hero_seat":1,
   "pot_type":"single-raised","grade":"mistake","score":40,"ev_loss_bb":0.4,"ev_loss_pot":0.27,"approximations":[],"decisions":[
     {"ord":0,"action_index":2,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"mistake","score":40,"ev_loss_bb":0.4,"ev_loss_pot":0.27,"freq_diff":1,
      "options":[{"action":"fold","freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":0.4}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"AKo","position":"UTG","chart":{"set":"nlhe-cash-6max-100bb","line":"","scenario":"rfi","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '5', 'A''s analysis is stored at two versions');

-- --------------------------------------------------------------- leaks --

select is(
  (select jsonb_build_object('hands', r -> 'hands', 'graded', r -> 'graded', 'first', r -> 'first', 'last', r -> 'last')
   from public.analysis_leaks('{"analysisVersion":"analysis/3"}') r),
  '{"hands":4,"graded":5,"first":"2026-03-02T10:00:00+00:00","last":"2026-04-01T12:00:00+00:00"}'::jsonb,
  'graded hands and moves, first and last date (the ungraded flop bet is not one)');
select is(
  (select string_agg(r ->> 'key', ',' order by r ->> 'key')
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/3"}') -> 'rows') r),
  'preflop|unopened||UTG|raise|raise,preflop|unopened|fff|BTN|raise|raise,preflop|vs-open|fffrf|BB|fold|call,river|caller-oop-first||BB|check|bet',
  'one row per finest spot, Perfect ones included (a spot''s frequency counts every move made there)');
select is(
  (select r - 'key' from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/3"}') -> 'rows') r
   where r ->> 'key' = 'preflop|vs-open|fffrf|BB|fold|call'),
  '{"set":"nlhe-cash-6max-100bb","street":"preflop","scenario":"vs-open","line":"fffrf","position":"BB","taken":"fold","best":"call",
    "decisions":2,"hands":2,"nonPerfect":2,"mistakes":2,"evLossBb":2.800,"evLossPot":0.5500,
    "scoreSum":50.00,"scoreSq":2500.00}'::jsonb,
  'per spot: decisions, hands, worse than Perfect, Inaccurate or worse, EV lost in bb and pot, score sums');
select is(
  (select format('%s:%s:%s', r ->> 'nonPerfect', r ->> 'mistakes', r ->> 'evLossBb')
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/3"}') -> 'rows') r
   where r ->> 'street' = 'river'),
  '1:0:0.300', 'a Good move is worse than Perfect but not a mistake; postflop the line is empty and the seat is the decision''s');
select ok(
  (select bool_and(r -> 'set' = 'null'::jsonb)
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/3"}') -> 'rows') r
   where r ->> 'street' = 'river'),
  'A2d: a decision not graded from the charts has no chart set');
select is(
  (select string_agg(format('%s:%s', s ->> 'site', s ->> 'hands'), ',' order by s ->> 'site')
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/3"}') -> 'facets' -> 'sites') s),
  'pokerstars:1,weplay:3', 'facets: the rooms of the graded hands');

-- ------------------------------------------------------------- filters --

select is((public.analysis_leaks('{"analysisVersion":"analysis/3","site":"pokerstars"}') ->> 'graded')::int, 1,
  'site filters to one room');
select is((public.analysis_leaks('{"analysisVersion":"analysis/3","position":"BB"}') ->> 'hands')::int, 2,
  'position filters to the hero''s seat');
select is((public.analysis_leaks('{"analysisVersion":"analysis/3","from":"2026-03-05T00:00:00Z"}') ->> 'hands')::int, 2,
  'from keeps hands played since');
select is((public.analysis_leaks('{"analysisVersion":"analysis/3","to":"2026-03-05T00:00:00Z"}') ->> 'graded')::int, 3,
  'to keeps hands played before');
select is(jsonb_array_length(public.analysis_leaks('{"analysisVersion":"analysis/3","site":"pokerstars"}') -> 'facets' -> 'sites'), 2,
  'the facets ignore the filters: they are what can be picked');
select is(
  (select string_agg(r ->> 'key', ',') from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/9"}') -> 'rows') r),
  'preflop|unopened||UTG|fold|raise', 'a report reads exactly one analysis version');
select is((public.analysis_leaks('{"analysisVersion":"analysis/8"}') ->> 'graded')::int, 0,
  '... and a version with no rows is empty, not another version''s');

-- ---------------------------------------------------------- leak hands --

select is(
  (select string_agg(format('%s/%s:%s', right(r ->> 'handId', 4), r ->> 'ord', r ->> 'evLossBb'), ',' order by ord)
   from jsonb_array_elements(public.analysis_leak_hands('{"analysisVersion":"analysis/3"}',
     array['preflop|vs-open|fffrf|BB|fold|call', 'river|caller-oop-first||BB|check|bet']) -> 'rows') with ordinality as x(r, ord)),
  '6003/0:2.000,6002/0:0.800,6002/5:0.300', 'the decisions at those spots, most EV lost first');
select is(
  (select r ->> 'handId' from jsonb_array_elements(public.analysis_leak_hands('{"analysisVersion":"analysis/3"}',
     array['preflop|vs-open|fffrf|BB|fold|call'], true, 'oldest') -> 'rows') r limit 1),
  '00000000-0000-0000-0000-0000000a6002', 'sort oldest puts the first hand first');
select is(
  (select format('%s:%s:%s:%s:%s', r ->> 'taken', r ->> 'best', r ->> 'handClass', r -> 'heroCards' ->> 0, r ->> 'chosen')
   from jsonb_array_elements(public.analysis_leak_hands('{"analysisVersion":"analysis/3"}',
     array['preflop|vs-open|fffrf|BB|fold|call'], true, 'recent', 1) -> 'rows') r),
  'fold:call:KQo:Kc:0', 'each with what was done, the best move, the hand''s class and cards, and the choice');
select is(
  (public.analysis_leak_hands('{"analysisVersion":"analysis/3"}', array['preflop|unopened||UTG|raise|raise']) ->> 'total')::int, 0,
  'only deviations by default: a Perfect move is not in a leak''s list');
select is(
  (public.analysis_leak_hands('{"analysisVersion":"analysis/3"}', array['preflop|unopened||UTG|raise|raise'], false) ->> 'total')::int, 1,
  '... unless asked for');
select is(
  (public.analysis_leak_hands('{"analysisVersion":"analysis/3","site":"weplay"}', array['preflop|vs-open|fffrf|BB|fold|call']) ->> 'total')::int, 1,
  'the list takes the report filters');
select is(
  (select jsonb_build_object('total', p -> 'total', 'rows', jsonb_array_length(p -> 'rows'))
   from public.analysis_leak_hands('{"analysisVersion":"analysis/3"}',
     array['preflop|vs-open|fffrf|BB|fold|call'], true, 'ev_loss', 1, 1) p),
  '{"total":2,"rows":1}'::jsonb, 'pages: the total counts every match, the page holds the limit');
select throws_ok($$ select public.analysis_leak_hands('{}', array['preflop|vs-open|x; drop table hands|BB|fold|call']) $$,
  '22023', null, 'a key that is not a spot is refused');
select throws_ok($$ select public.analysis_leak_hands('{}', array[]::text[]) $$,
  '22023', null, '... and so is no spot at all');
select throws_ok($$ select public.analysis_leak_hands('{}', array['preflop|vs-open|fffrf|BB|fold|call'], true, 'score') $$,
  '22023', null, 'the sort is whitelisted');

-- --------------------------------------------------------------- trend --

select is(
  (select string_agg(format('%s:%s:%s:%s:%s', left(r ->> 'start', 10), r ->> 'hands', r ->> 'graded', r ->> 'nonPerfect', r ->> 'evLossBb'),
                     ',' order by ord)
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'week') -> 'rows') with ordinality as x(r, ord)),
  '2026-03-02:2:3:2:1.100,2026-03-09:1:1:1:2.000,2026-03-30:1:1:0:0.000',
  'by ISO week (Monday, UTC): graded hands and moves, worse than Perfect, EV lost; oldest first');
select is(
  (select format('%s:%s:%s', r ->> 'scoreSum', r ->> 'scoreSq', r -> 'grades')
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'week') -> 'rows') r
   where r ->> 'start' like '2026-03-02%'),
  '230.00:18900.00:{"good": 1, "blunder": 0, "mistake": 1, "perfect": 1, "inaccurate": 0}',
  '... with the score sums and the grade counts');
select is(
  (select string_agg(format('%s..%s:%s', left(r ->> 'start', 10), left(r ->> 'end', 10), r ->> 'graded'), ',' order by ord)
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'month') -> 'rows') with ordinality as x(r, ord)),
  '2026-03-01..2026-04-01:4,2026-04-01..2026-05-01:1', 'by calendar month');
select is(
  (select string_agg(format('%s:%s', r ->> 'hands', r ->> 'graded'), ',' order by ord)
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'session') -> 'rows') with ordinality as x(r, ord)),
  '2:3,1:1,1:1', 'by session: hands twenty minutes apart are one session at the default 30-minute gap');
select is(
  jsonb_array_length(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'session', 'all', 10) -> 'rows'), 4,
  '... and two at a 10-minute gap');
select is(
  (select string_agg(format('%s:%s:%s:%s', r ->> 'key', r ->> 'bucketHands', r ->> 'hands', r ->> 'graded'), ',' order by r ->> 'key')
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'week', 'street') -> 'rows') r
   where r ->> 'start' like '2026-03-02%'),
  'preflop:2:2:2,river:2:1:1', 'per street within a bucket, with the bucket''s graded hands for "per 100 hands"');
select is(
  (select string_agg(format('%s:%s', r ->> 'key', r ->> 'graded'), ',' order by r ->> 'key')
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'month', 'position') -> 'rows') r
   where r ->> 'start' like '2026-03-01%'),
  'BB:3,UTG:1', 'per seat (the hand''s)');
select is(
  (select sum((r ->> 'graded')::int)::int
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3","site":"weplay"}', 'month') -> 'rows') r),
  4, 'the trend takes the report filters');
select is(
  (select format('%s:%s', jsonb_array_length(p -> 'facets' -> 'sites'), p -> 'facets' ->> 'last')
   from public.analysis_trend('{"analysisVersion":"analysis/3","site":"weplay"}', 'week') p),
  '2:2026-04-01T12:00:00+00:00', '... and carries the same unfiltered facets as the leaks');
select throws_ok($$ select public.analysis_trend('{}', 'day') $$, '22023', null, 'the bucket is whitelisted');
select throws_ok($$ select public.analysis_trend('{}', 'week', 'grade') $$, '22023', null, '... and so is the group');

-- ------------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a6bb1');
select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a6b01","analysis_version":"analysis/3","status":"full","hero_seat":2,
   "pot_type":"single-raised","grade":"blunder","score":0,"ev_loss_bb":5,"ev_loss_pot":1,"approximations":[],"decisions":[
     {"ord":0,"action_index":5,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"blunder","score":0,"ev_loss_bb":5,"ev_loss_pot":1,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":4}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"AA","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '1', 'B stores one graded hand, at A''s spot');
select is(
  (select format('%s:%s:%s', p ->> 'hands', p ->> 'graded', p -> 'rows' -> 0 ->> 'evLossBb')
   from public.analysis_leaks('{"analysisVersion":"analysis/3"}') p),
  '1:1:5.000', 'B''s leaks hold B''s decision and none of A''s');
select is(
  (select string_agg(right(r ->> 'handId', 4), ',')
   from jsonb_array_elements(public.analysis_leak_hands('{"analysisVersion":"analysis/3"}',
     array['preflop|vs-open|fffrf|BB|fold|call'], false) -> 'rows') r),
  '6b01', '... B''s list at A''s spot holds B''s hand only');
select is(
  (select sum((r ->> 'graded')::int)::int
   from jsonb_array_elements(public.analysis_trend('{"analysisVersion":"analysis/3"}', 'session') -> 'rows') r),
  1, '... and so does B''s trend');

-- A2d: the same finest spot on two chart sets is two rows, one per set.
select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a6b02","analysis_version":"analysis/3","status":"full","hero_seat":2,
   "pot_type":"single-raised","grade":"mistake","score":40,"ev_loss_bb":1,"ev_loss_pot":0.25,"approximations":[],"decisions":[
     {"ord":0,"action_index":5,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":40,"ev_loss_bb":1,"ev_loss_pot":0.25,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":0}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"KJs","position":"BB","chart":{"set":"nlhe-cash-6max-150bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '1', 'B stores the same spot graded on the 150bb set');
select is(
  (select string_agg(format('%s:%s:%s', r ->> 'key', r ->> 'set', r ->> 'decisions'), ',' order by r ->> 'set')
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/3"}') -> 'rows') r),
  'preflop|vs-open|fffrf|BB|fold|call:nlhe-cash-6max-100bb:1,preflop|vs-open|fffrf|BB|fold|call:nlhe-cash-6max-150bb:1',
  '... and its leak rows split by chart set under the same spot key');

select pg_temp.act_as_anon();
select throws_ok($$ select public.analysis_leaks('{}') $$, '42501', null, 'anon reads no leaks');
select throws_ok($$ select public.analysis_trend('{}') $$, '42501', null, '... and no trend');

select * from finish();
rollback;
