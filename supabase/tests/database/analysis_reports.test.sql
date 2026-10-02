-- pgTAP: hand analysis, phase A3 -- `20270111090000_analysis_reports.sql`.
--
-- The reports count graded chart decisions per node and action. What has to
-- hold:
--
--   * the security model is unchanged: no table grant moved, both reports and
--     their helper are invoker with an empty search_path, executable by
--     `authenticated` (the reports run their helper as the caller) and not by
--     `anon`;
--   * the arithmetic: per node x action (decisions, deviations, EV lost), per
--     node x class x action, postflop per role, the facets;
--   * the shove is named `allin`, as the charts name it;
--   * every filter `analysis_scope` takes applies, the facets ignore them, and
--     a report reads exactly one `analysis_version`;
--   * node keys, actions and sorts are validated;
--   * one user's decisions never reach another's report, and anon reads nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(42);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a3aa1', 'rp.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a3bb1', 'rp.b@example.com', now(), now());

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

-- A: three hands at two rooms and two stakes. B: one.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-0000000a3001', '00000000-0000-0000-0000-0000000a3aa1', 'weplay:rp1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'UTG', 'cash', 'USD', 100, 50, 100, 150,
   array['As','Kd'], now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000a3002', '00000000-0000-0000-0000-0000000a3aa1', 'weplay:rp2',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['7h','2c'], now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000a3003', '00000000-0000-0000-0000-0000000a3aa1', 'pokerstars:rp3',
   '{"schema":"phf/1"}', 'std', 'pokerstars', 3, 'BTN', 'cash', 'USD', 100, 100, 200, 0,
   array['Kc','9d'], now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000a3b01', '00000000-0000-0000-0000-0000000a3bb1', 'weplay:rpb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'UTG', 'cash', 'USD', 100, 50, 100, 0,
   array['Ah','Ad'], now());

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('hand_analysis', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'still no client write grant on either table');
select ok(
  (select bool_and(not p.prosecdef) from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_node_actions', 'analysis_node_hands', 'analysis_chosen_action')),
  'both reports and their helper are security invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_node_actions', 'analysis_node_hands', 'analysis_chosen_action')),
  '... and pin an empty search_path');
select ok(has_function_privilege('authenticated', 'public.analysis_chosen_action(jsonb, integer)', 'execute'),
  'the helper is executable by authenticated (the invoker reports call it as their caller)');
select ok(has_function_privilege('authenticated', 'public.analysis_node_actions(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.analysis_node_hands(jsonb, text[], text, boolean, text, integer, integer)', 'execute'),
  '... and so are both reports');
select ok(not has_function_privilege('anon', 'public.analysis_chosen_action(jsonb, integer)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_node_actions(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.analysis_node_hands(jsonb, text[], text, boolean, text, integer, integer)', 'execute'),
  'none of them by anon');

-- ------------------------------------------------------------- helper --

select is(public.analysis_chosen_action('[{"action":"fold"},{"action":"raise","allIn":true}]', 1), 'allin',
  'a stored shove reads as the charts'' allin');
select is(public.analysis_chosen_action('[{"action":"fold"},{"action":"raise","sizeBb":2.5}]', 1), 'raise',
  '... a sized raise as raise');
select is(public.analysis_chosen_action('[{"action":"fold"}]', 3), null, 'an index past the options is no action');
select is(public.analysis_chosen_action('[]', null), null, '... and so is no choice');

-- ------------------------------------------------------------ the data --
--
--   rp1 UTG  ""        AKo  raise    perfect  0.00   (+ a flop c-bet, IP)
--   rp2 BB   "fffrf"   72o  call     blunder  0.50
--            "fffrfrr" 72o  shove    mistake  0.20
--   rp3 BTN  "fff"     K9o  fold     inaccurate 0.10 (+ a heuristic preflop decision: not counted)
--   rp1 again at analysis/3: "ff" raise perfect -- a different version.

select pg_temp.act_as('00000000-0000-0000-0000-0000000a3aa1');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a3001","analysis_version":"analysis/2","status":"full","hero_seat":1,
   "pot_type":"single-raised","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"approximations":[],"decisions":[
     {"ord":0,"action_index":2,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[{"action":"fold","sizeBb":0,"freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":0.4}],"chosen":1,
      "flags":[],"approximations":["model"],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"AKo","chart":{"set":"nlhe-cash-6max-100bb","line":"","scenario":"rfi","inRange":1}}},
     {"ord":4,"action_index":9,"street":"flop","action":"bet","status":"analysed","node":"n","scenario":"pfr-ip-first",
      "source":"heuristic","flags":[],"approximations":["heuristic"],"facing_bet":false,"pot_bb":5.5,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a3002","analysis_version":"analysis/2","status":"full","hero_seat":2,
   "pot_type":"4bet+","grade":"blunder","score":20,"ev_loss_bb":0.7,"ev_loss_pot":0.1,"approximations":[],"decisions":[
     {"ord":0,"action_index":5,"street":"preflop","action":"call","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"blunder","score":0,"ev_loss_bb":0.5,"ev_loss_pot":0.1,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":1,"ev":-1},{"action":"call","sizeBb":2.5,"freq":0,"ev":-1.5},
                 {"action":"raise","sizeBb":11,"freq":0,"ev":-2}],"chosen":1,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"72o","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":0}}},
     {"ord":1,"action_index":8,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"vs-4bet",
      "source":"chart","grade":"mistake","score":40,"ev_loss_bb":0.2,"ev_loss_pot":0.04,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":2.5,"freq":1,"ev":-2.5},{"action":"call","sizeBb":24,"freq":0,"ev":-3},
                 {"action":"raise","sizeBb":100,"allIn":true,"freq":0,"ev":-2.7}],"chosen":2,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":30,
      "facts":{"handClass":"72o","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrfrr","scenario":"vs-4bet","inRange":0}}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a3003","analysis_version":"analysis/2","status":"partial","hero_seat":3,
   "pot_type":"walk","grade":"inaccurate","score":60,"ev_loss_bb":0.1,"ev_loss_pot":0.06,"approximations":[],"decisions":[
     {"ord":0,"action_index":3,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"inaccurate","score":60,"ev_loss_bb":0.1,"ev_loss_pot":0.06,"freq_diff":0.6,
      "options":[{"action":"fold","sizeBb":0,"freq":0.4,"ev":0},{"action":"raise","sizeBb":2.5,"freq":0.6,"ev":0.1}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"K9o","chart":{"set":"nlhe-cash-6max-100bb","line":"fff","scenario":"rfi","inRange":1}}},
     {"ord":2,"action_index":6,"street":"preflop","action":"call","status":"not-analysed","reason":"chart-limp","node":"n",
      "scenario":"vs-limp","source":"heuristic","flags":[],"approximations":["heuristic"],"facing_bet":true,"pot_bb":3,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a3001","analysis_version":"analysis/3","status":"full","hero_seat":1,
   "pot_type":"single-raised","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"approximations":[],"decisions":[
     {"ord":0,"action_index":2,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[{"action":"fold","freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":0.4}],"chosen":1,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"AKo","chart":{"set":"nlhe-cash-6max-100bb","line":"ff","scenario":"rfi","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '4', 'A''s analysis is stored at two versions');

-- --------------------------------------------------------- node actions --

select is(
  (select jsonb_build_object('hands', r -> 'hands', 'decisions', r -> 'decisions')
   from public.analysis_node_actions('{"analysisVersion":"analysis/2"}') r),
  '{"hands":3,"decisions":4}'::jsonb,
  'counts graded chart decisions only (the heuristic preflop decision and the flop bet are not)');
select is(
  (select string_agg(format('%s:%s:%s:%s:%s', a ->> 'line', a ->> 'action', a ->> 'decisions', a ->> 'deviations', a ->> 'evLossBb'),
                     ',' order by a ->> 'line', a ->> 'action')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'actions') a),
  ':raise:1:0:0.000,fff:fold:1:1:0.100,fffrf:call:1:1:0.500,fffrfrr:allin:1:1:0.200',
  'per node and action: decisions, deviations (worse than Perfect) and EV lost; the shove is allin');
select is(
  (select string_agg(a ->> 'scenario', ',' order by a ->> 'line')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'actions') a),
  'rfi,rfi,vs-open,vs-4bet', '... each with the chart scenario it was graded at');
select ok(
  (select bool_and(a ->> 'set' = 'nlhe-cash-6max-100bb')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'actions') a),
  '... and the chart set');
select is(
  (select string_agg(format('%s:%s:%s:%s', c ->> 'line', c ->> 'handClass', c ->> 'action', c ->> 'decisions'),
                     ',' order by c ->> 'line', c ->> 'handClass')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'classes') c),
  ':AKo:raise:1,fff:K9o:fold:1,fffrf:72o:call:1,fffrfrr:72o:allin:1',
  'per node, hand class and action: the counts the hand-adjusted reference needs');
select is(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'postflop',
  '[{"street":"flop","scenario":"pfr-ip-first","action":"bet","decisions":1}]'::jsonb,
  'postflop decisions by street, role and action');
select is(
  (select string_agg(format('%s:%s', s ->> 'site', s ->> 'hands'), ',' order by s ->> 'site')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'facets' -> 'sites') s),
  'pokerstars:1,weplay:2', 'facets: the rooms of the graded hands');
select is(
  (select string_agg(format('%s:%s:%s', s ->> 'currency', s ->> 'bigBlind', s ->> 'hands'), ',' order by (s ->> 'bigBlind')::int)
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'facets' -> 'stakes') s),
  'USD:100:2,USD:200:1', '... and their stakes');

-- ------------------------------------------------------------- filters --

select is((public.analysis_node_actions('{"analysisVersion":"analysis/2","position":"BB"}') ->> 'decisions')::int, 2,
  'position filters to the hero''s seat');
select is((public.analysis_node_actions('{"analysisVersion":"analysis/2","site":"pokerstars"}') ->> 'decisions')::int, 1,
  'site filters to one room');
select is((public.analysis_node_actions('{"analysisVersion":"analysis/2","currency":"USD","bigBlind":200}') ->> 'decisions')::int, 1,
  'currency and big blind filter to one stake');
select is(
  (public.analysis_node_actions(jsonb_build_object('analysisVersion', 'analysis/2',
     'from', (now() - interval '50 hours')::text)) ->> 'decisions')::int, 3,
  'from keeps hands played since');
select is(
  (public.analysis_node_actions(jsonb_build_object('analysisVersion', 'analysis/2',
     'to', (now() - interval '50 hours')::text)) ->> 'decisions')::int, 1,
  'to keeps hands played before');
select is(jsonb_array_length(public.analysis_node_actions('{"analysisVersion":"analysis/2","position":"BB"}') -> 'facets' -> 'sites'), 2,
  'the facets ignore the filters: they are what can be picked');

select is(
  (select string_agg(format('%s:%s', a ->> 'line', a ->> 'action'), ',')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/3"}') -> 'actions') a),
  'ff:raise', 'a report reads exactly one analysis version');
select is((public.analysis_node_actions('{"analysisVersion":"analysis/9"}') ->> 'decisions')::int, 0,
  '... and a version with no rows is empty, not another version''s');

-- ---------------------------------------------------------- node hands --

select is(
  (select string_agg(format('%s/%s', right(r ->> 'handId', 4), r ->> 'ord'), ',' order by ord)
   from jsonb_array_elements(public.analysis_node_hands('{"analysisVersion":"analysis/2"}',
     array['nlhe-cash-6max-100bb:', 'nlhe-cash-6max-100bb:fff', 'nlhe-cash-6max-100bb:fffrf', 'nlhe-cash-6max-100bb:fffrfrr'])
     -> 'rows') with ordinality as x(r, ord)),
  '3002/0,3002/1,3003/0', 'the deviations at those nodes, most EV lost first (the Perfect open is not one)');
select is(
  (public.analysis_node_hands('{"analysisVersion":"analysis/2"}',
     array['nlhe-cash-6max-100bb:', 'nlhe-cash-6max-100bb:fff', 'nlhe-cash-6max-100bb:fffrf', 'nlhe-cash-6max-100bb:fffrfrr'],
     null, false) ->> 'total')::int, 4,
  'every decision at the nodes when deviations only is off');
select is(
  (select r ->> 'action' || ':' || (r ->> 'handClass') || ':' || (r -> 'heroCards' ->> 0)
   from jsonb_array_elements(public.analysis_node_hands('{"analysisVersion":"analysis/2"}',
     array['nlhe-cash-6max-100bb:fffrfrr'], 'allin') -> 'rows') r),
  'allin:72o:7h', 'an action filter, with the hand''s class and cards');
select is(
  (select r ->> 'handId' from jsonb_array_elements(public.analysis_node_hands('{"analysisVersion":"analysis/2"}',
     array['nlhe-cash-6max-100bb:fff', 'nlhe-cash-6max-100bb:fffrf'], null, true, 'recent') -> 'rows') r limit 1),
  '00000000-0000-0000-0000-0000000a3003', 'sort recent puts the latest hand first');
select is(
  (public.analysis_node_hands('{"analysisVersion":"analysis/2","position":"BTN"}',
     array['nlhe-cash-6max-100bb:fff', 'nlhe-cash-6max-100bb:fffrf']) ->> 'total')::int, 1,
  'the list takes the report filters');
select is(
  (select jsonb_build_object('total', p -> 'total', 'rows', jsonb_array_length(p -> 'rows'))
   from public.analysis_node_hands('{"analysisVersion":"analysis/2"}',
     array['nlhe-cash-6max-100bb:fffrf', 'nlhe-cash-6max-100bb:fffrfrr'], null, true, 'ev_loss', 1, 1) p),
  '{"total":2,"rows":1}'::jsonb, 'pages: the total counts every match, the page holds the limit');
select throws_ok($$ select public.analysis_node_hands('{}', array['nlhe-cash-6max-100bb:fffx; drop table hands']) $$,
  '22023', null, 'a node key that is not a set and a line is refused');
select throws_ok($$ select public.analysis_node_hands('{}', array[]::text[]) $$,
  '22023', null, '... and so is no node at all');
select throws_ok($$ select public.analysis_node_hands('{}', array['nlhe-cash-6max-100bb:'], 'bet') $$,
  '22023', null, 'the action is a chart action');
select throws_ok($$ select public.analysis_node_hands('{}', array['nlhe-cash-6max-100bb:'], null, true, 'grade') $$,
  '22023', null, 'the sort is whitelisted');

-- ------------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a3bb1');
select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a3b01","analysis_version":"analysis/2","status":"full","hero_seat":1,
   "pot_type":"single-raised","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"approximations":[],"decisions":[
     {"ord":0,"action_index":2,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[{"action":"fold","freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":1.2}],"chosen":1,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":1.5,
      "facts":{"handClass":"AA","chart":{"set":"nlhe-cash-6max-100bb","line":"","scenario":"rfi","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '1', 'B stores one graded hand');
select is(
  (select string_agg(format('%s:%s:%s', a ->> 'line', a ->> 'action', a ->> 'decisions'), ',')
   from jsonb_array_elements(public.analysis_node_actions('{"analysisVersion":"analysis/2"}') -> 'actions') a),
  ':raise:1', 'B''s report counts B''s decision and none of A''s');
select is(
  (public.analysis_node_hands('{"analysisVersion":"analysis/2"}',
     array['nlhe-cash-6max-100bb:', 'nlhe-cash-6max-100bb:fffrf'], null, false) ->> 'total')::int, 1,
  '... and B''s list holds B''s hand only, even at A''s nodes');

select pg_temp.act_as_anon();
select throws_ok($$ select public.analysis_node_actions('{}') $$, '42501', null, 'anon reads no report');
select throws_ok($$ select public.analysis_node_hands('{}', array['nlhe-cash-6max-100bb:']) $$, '42501', null,
  '... and no list');

select * from finish();
rollback;
