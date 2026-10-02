-- pgTAP: hand analysis, phase A1 -- `20261228090000_analysis.sql`.
--
-- What has to be true for the security model to hold, tested as the roles a
-- real caller has rather than as the superuser that owns everything:
--
--   * no client role can insert, update or delete either table directly;
--   * the definer writer checks ownership itself, and a foreign hand id is
--     skipped exactly as an unknown one is;
--   * the aggregates on a hand row are computed by the server, not taken from
--     the client;
--   * versions are checked and kept apart; prune only reaches the caller's
--     rows at other versions;
--   * every report runs as a signed-in user (its helpers are executable) and
--     sees only that user's rows; anon reaches nothing;
--   * the overview's arithmetic.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(51);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a1aa1', 'an.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a1bb1', 'an.b@example.com', now(), now());

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

-- A: three hands. B: one.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, big_blind, hero_profit, played_at) values
  ('00000000-0000-0000-0000-0000000a1001', '00000000-0000-0000-0000-0000000a1aa1', 'weplay:an1',
   '{"schema":"phf/1","meta":{"rawText":"secret text","siteId":"weplay"},"actions":[{"index":0,"rawLine":"x","label":"y","type":"fold"}]}',
   'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 250, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000a1002', '00000000-0000-0000-0000-0000000a1aa1', 'weplay:an2',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, -400, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000a1003', '00000000-0000-0000-0000-0000000a1aa1', 'weplay:an3',
   '{"schema":"phf/1"}', 'std', 'weplay', null, null, 'tournament', 'CHIPS', 100, 0, now()),
  ('00000000-0000-0000-0000-0000000a1b01', '00000000-0000-0000-0000-0000000a1bb1', 'weplay:anb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'CO', 'cash', 'USD', 100, 0, now());

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('hand_analysis', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client role can insert, update, delete or truncate either table');
select ok(not has_table_privilege('anon', 'public.hand_analysis', 'select'), 'anon cannot read hand_analysis');
select ok(not has_table_privilege('anon', 'public.decision_analysis', 'select'), 'anon cannot read decision_analysis');
select ok(has_table_privilege('authenticated', 'public.hand_analysis', 'select'), 'authenticated may select (RLS scopes it)');
select ok(
  (select bool_and(p.prosecdef) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('save_hand_analysis', 'prune_hand_analysis')),
  'the two writers are security definer');
select ok(
  (select bool_and(not p.prosecdef) from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('hands_needing_analysis', 'analysis_coverage', 'analysis_scope', 'analysis_overview',
                       'analysis_breakdown', 'analysis_hands', 'analysis_hand')),
  'every read is security invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('save_hand_analysis', 'prune_hand_analysis', 'hands_needing_analysis', 'analysis_coverage',
                       'analysis_scope', 'analysis_version_of', 'analysis_overview', 'analysis_breakdown',
                       'analysis_hands', 'analysis_hand')),
  'every function pins an empty search_path');
select ok(has_function_privilege('authenticated', 'public.analysis_scope(jsonb)', 'execute'),
  'the shared report helper is executable by authenticated (the invoker reports call it)');
select ok(has_function_privilege('authenticated', 'public.analysis_version_of(jsonb)', 'execute'),
  '... and so is the version check');
select ok(not has_function_privilege('anon', 'public.save_hand_analysis(jsonb)', 'execute'),
  'anon cannot execute the writer');
select is((select reason from public.username_reservations where username_lower = 'analysis'), 'route',
  '/analysis is reserved as a route, not a username');

-- ---------------------------------------------------------- the writer --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a1aa1');

select throws_ok($$ insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason)
  values ('00000000-0000-0000-0000-0000000a1001', '00000000-0000-0000-0000-0000000a1aa1', 'analysis/1', 'not-analysed', 'x') $$,
  '42501', null, 'a direct insert is refused even for one''s own hand');

select is(
  (select array_agg(id::text order by id) from public.hands_needing_analysis('analysis/1')),
  array['00000000-0000-0000-0000-0000000a1001', '00000000-0000-0000-0000-0000000a1002', '00000000-0000-0000-0000-0000000a1003'],
  'every one of A''s hands needs analysing, hero or not');
select is(
  (select phf from public.hands_needing_analysis('analysis/1') where id = '00000000-0000-0000-0000-0000000a1001'),
  '{"schema":"phf/1","meta":{"siteId":"weplay"},"actions":[{"index":0,"type":"fold"}]}'::jsonb,
  'the document comes without the source text and the per-line echoes');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a1001","analysis_version":"analysis/1","status":"partial",
   "hero_seat":1,"pot_type":"single-raised","approximations":["heuristic","placeholder-range"],
   "flag_count":99,"worst_flag":"note","decisions":[
     {"ord":2,"action_index":4,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"vs-open",
      "source":"heuristic","flags":[],"facing_bet":true,"pot_bb":4,"pot_odds":0.33,"mdf":0.4,"facts":{"street":"preflop"}},
     {"ord":5,"action_index":9,"street":"flop","action":"fold","status":"analysed","node":"n","scenario":"pfr-ip-vs-bet",
      "source":"heuristic","flags":[{"code":"fold-nuts","severity":"inaccurate","params":{}}],
      "facing_bet":true,"pot_bb":6.5,"pot_odds":0.25,"mdf":0.6,"facts":{}},
     {"ord":8,"action_index":12,"street":"turn","action":"call","status":"not-analysed","reason":"multiway","node":"n",
      "scenario":"caller-oop-vs-bet","source":"heuristic","facing_bet":true,"pot_bb":12,"pot_odds":0.3,"mdf":0.5,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a1002","analysis_version":"analysis/1","status":"full","hero_seat":2,
   "pot_type":"limped","approximations":["heuristic"],"decisions":[
     {"ord":1,"action_index":3,"street":"preflop","action":"check","status":"analysed","node":"n","scenario":"bb-option",
      "source":"heuristic","flags":[],"facing_bet":false,"pot_bb":2,"facts":{}},
     {"ord":3,"action_index":6,"street":"flop","action":"call","status":"analysed","node":"n","scenario":"limped-oop-vs-bet",
      "source":"heuristic","flags":[{"code":"call-without-odds","severity":"note","params":{"needed":30,"equity":10}}],
      "facing_bet":true,"pot_bb":3,"pot_odds":0.3,"mdf":0.4,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a1003","analysis_version":"analysis/1","status":"not-analysed",
   "reason":"no-hero","decisions":[]},
  {"hand_id":"00000000-0000-0000-0000-0000000a1b01","analysis_version":"analysis/1","status":"not-analysed",
   "reason":"no-hero","decisions":[]},
  {"hand_id":"00000000-0000-0000-0000-0000000a1fff","analysis_version":"analysis/1","status":"not-analysed",
   "reason":"no-hero","decisions":[]}
]$$::jsonb),
  '{"received":5,"inserted":3,"duplicates":0,"skipped":2,"decisions":5}'::jsonb,
  'the writer stores A''s three hands, and skips B''s and an unknown id with one answer');

select is(
  (select row(decisions, analysed, flag_count, worst_flag)::text from public.hand_analysis
   where hand_id = '00000000-0000-0000-0000-0000000a1001'),
  '(3,2,1,inaccurate)', 'the counts are the server''s, not the 99 the client sent');
select is(
  (select owner_id::text from public.hand_analysis where hand_id = '00000000-0000-0000-0000-0000000a1001'),
  '00000000-0000-0000-0000-0000000a1aa1', 'the owner is the caller');
select is(
  (select worst_flag from public.decision_analysis where hand_id = '00000000-0000-0000-0000-0000000a1002' and ord = 3),
  'note', 'a decision''s loudest flag is computed too');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a1002","analysis_version":"analysis/1","status":"full","decisions":[
     {"ord":9,"action_index":20,"street":"river","action":"bet","status":"analysed","node":"n","scenario":"x",
      "source":"heuristic","facts":{}}]}]$$::jsonb) ->> 'duplicates', '1',
  'saving the same hand at the same version again is a duplicate');
select is((select count(*)::int from public.decision_analysis where hand_id = '00000000-0000-0000-0000-0000000a1002'), 2,
  '... and grafts no decision onto the stored analysis');

select throws_ok($$ select public.save_hand_analysis('[{"hand_id":"00000000-0000-0000-0000-0000000a1001","analysis_version":"analysis/one","status":"full","decisions":[]}]') $$,
  '23514', null, 'a malformed version is refused');
select throws_ok($$ select public.save_hand_analysis('[{"hand_id":"00000000-0000-0000-0000-0000000a1001","analysis_version":"analysis/2","status":"full","decisions":[]}]') $$,
  '23514', null, 'a "full" hand with no decisions is refused: the status must agree with the counts');
select throws_ok($$ select public.save_hand_analysis('[{"hand_id":"00000000-0000-0000-0000-0000000a1001","analysis_version":"analysis/2","status":"full","decisions":[
    {"ord":1,"action_index":1,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"x","source":"heuristic",
     "flags":[{"code":"free-fold","severity":"blunder"}],"facts":{}}]}]') $$,
  '23514', null, 'a flag louder than "inaccurate" is refused (§3.6)');
select throws_ok($$ select public.save_hand_analysis('{"not":"an array"}') $$, '22023', null, 'the payload must be an array');
select throws_ok($$ select public.save_hand_analysis((select jsonb_agg('{}'::jsonb) from generate_series(1, 201))) $$,
  '53400', null, 'at most 200 hands per call');

-- ------------------------------------------------------------- the reads --

select is(public.analysis_coverage('analysis/1'),
  '{"analysisVersion":"analysis/1","hands":3,"atVersion":3,"stale":0,"missing":0,"obsoleteRows":0}'::jsonb,
  'coverage: every hand analysed at analysis/1');
select is((public.analysis_coverage('analysis/2') ->> 'stale')::int, 3, 'at a newer version every hand is stale');
select ok(not exists (select 1 from public.hands_needing_analysis('analysis/1')), 'nothing left to analyse');
select throws_ok($$ select public.analysis_coverage('stats/2') $$, '22023', null, 'coverage checks the version shape');
select throws_ok($$ select public.analysis_overview('{"analysisVersion":"nope"}') $$, '22023', null,
  'so does every report');

-- (A2b's `20270104090000_analysis_grades.sql` added the grade keys; they have
-- their own suite, `analysis_grades.test.sql`.)
select is(public.analysis_overview('{"analysisVersion":"analysis/1"}') - 'flags' - 'streets' - 'reasons' - 'skipped' - 'approximations'
          - 'gradesByStreet' - 'graded' - 'gradedHands' - 'badHands' - 'evLossPot',
  '{"analysisVersion":"analysis/1","hands":3,"status":{"full":1,"partial":1,"notAnalysed":1},
    "decisions":5,"analysed":4,"flagged":2,"flaggedHands":2,"grades":[],"score":null,"evLossBb":null}'::jsonb,
  'overview: hands by status, decisions, flags; no grades yet');
select is(public.analysis_overview('{"analysisVersion":"analysis/1"}') -> 'streets',
  '[{"street":"preflop","decisions":2,"analysed":2,"flagged":0,"facingBet":0,"defended":0,"mdf":null},
    {"street":"flop","decisions":2,"analysed":2,"flagged":2,"facingBet":2,"defended":1,"mdf":0.500},
    {"street":"turn","decisions":1,"analysed":0,"flagged":0,"facingBet":0,"defended":0,"mdf":null}]'::jsonb,
  'overview by street: defence against MDF counts analysed postflop decisions only (a preflop raise facing an open is not in it)');
select is(public.analysis_overview('{"analysisVersion":"analysis/1"}') -> 'reasons',
  '[{"reason":"no-hero","hands":1}]'::jsonb, 'overview: why hands were not analysed');
select is(public.analysis_overview('{"analysisVersion":"analysis/1"}') -> 'skipped',
  '[{"reason":"multiway","decisions":1}]'::jsonb, 'overview: why decisions were skipped');
select is(public.analysis_overview('{"analysisVersion":"analysis/1"}') -> 'flags',
  '[{"code":"call-without-odds","street":"flop","severity":"note","count":1},
    {"code":"fold-nuts","street":"flop","severity":"inaccurate","count":1}]'::jsonb,
  'overview: flags by code and street');
select is((public.analysis_overview('{"analysisVersion":"analysis/1","gameFormat":"cash","position":"btn"}') ->> 'hands')::int, 1,
  'filters narrow the overview (format, position)');
select is((public.analysis_overview('{"analysisVersion":"analysis/1","flag":"fold-nuts"}') ->> 'hands')::int, 1,
  '... and so does a flag code');

select is((select string_agg(r ->> 'key' || ':' || (r ->> 'decisions'), ',')
           from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/1"}', 'street') -> 'rows') r),
  'preflop:2,flop:2,turn:1', 'breakdown by street, in street order');
select is((select string_agg(r ->> 'key' || ':' || (r ->> 'hands'), ',' order by r ->> 'key')
           from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/1"}', 'position') -> 'rows') r),
  'BB:1,BTN:1', 'breakdown by the hero''s position counts hands');
select throws_ok($$ select public.analysis_breakdown('{}', 'owner_id') $$, '22023', null,
  'the breakdown dimension is whitelisted');

select is((select array_agg(r ->> 'handId') from jsonb_array_elements(public.analysis_hands('{"analysisVersion":"analysis/1"}', 'flags') -> 'rows') r),
  array['00000000-0000-0000-0000-0000000a1001', '00000000-0000-0000-0000-0000000a1002', '00000000-0000-0000-0000-0000000a1003'],
  'the hands list sorts by flags, the louder hand first');
select is(public.analysis_hands('{"analysisVersion":"analysis/1"}', 'result', 1, 0) -> 'rows' -> 0 ->> 'netBb', '-4.00',
  '... by result, worst first, with the result in big blinds');
select is(jsonb_array_length(public.analysis_hands('{"analysisVersion":"analysis/1"}', 'recent', 1, 0) -> 'rows' -> 0 -> 'decisions'), 0,
  '... each row carries its decisions for the action letters (none for a hand without a hero)');
select throws_ok($$ select public.analysis_hands('{}', 'hand_id; drop table hands') $$, '22023', null,
  'the sort key is whitelisted');
select is(public.analysis_hand('00000000-0000-0000-0000-0000000a1001') -> 'decisions' -> 1 -> 'flags' -> 0 ->> 'code', 'fold-nuts',
  'analysis_hand returns the decisions in full');

-- ------------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a1bb1');
select is(public.analysis_hand('00000000-0000-0000-0000-0000000a1001'), null,
  'B cannot read A''s analysis by id');
select is((public.analysis_overview('{"analysisVersion":"analysis/1"}') ->> 'hands')::int, 0,
  'B''s overview is empty: A''s rows are invisible, and B''s own was never stored');
select is((public.prune_hand_analysis('analysis/2') ->> 'deleted')::int, 0, 'B''s prune cannot reach A''s rows');

select pg_temp.act_as_anon();
select throws_ok($$ select public.analysis_overview('{}') $$, '42501', null, 'anon cannot read the overview');

-- --------------------------------------------------------------- prune --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a1aa1');
select is((public.prune_hand_analysis('analysis/2') ->> 'deleted')::int, 3,
  'pruning to a new version removes A''s analysis/1 rows');
select is((select count(*)::int from public.decision_analysis), 0, '... and their decisions with them');

select * from finish();
rollback;
