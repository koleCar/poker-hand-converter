-- pgTAP: hand analysis, phase A2b -- `20270104090000_analysis_grades.sql`.
--
-- The reports read grades now. What has to hold:
--
--   * the security model is unchanged: no table grant moved, every replaced
--     report is still invoker with an empty search_path, and the new helper
--     is executable by the role the invoker reports run as (and not by anon);
--   * the grade filters, the new group and the new sort are whitelisted;
--   * the arithmetic: graded moves and hands, the Perfect...Blunder
--     distribution overall, by street and by group, EV loss in bb and in % of
--     the pot, the mean score;
--   * one user's grades never reach another's report.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(32);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a2aa1', 'gr.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a2bb1', 'gr.b@example.com', now(), now());

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

-- A: three hands (UTG, BB, BTN). B: one.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, big_blind, hero_profit, played_at) values
  ('00000000-0000-0000-0000-0000000a2001', '00000000-0000-0000-0000-0000000a2aa1', 'weplay:gr1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'UTG', 'cash', 'USD', 100, -250, now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000a2002', '00000000-0000-0000-0000-0000000a2aa1', 'weplay:gr2',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, -100, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000a2003', '00000000-0000-0000-0000-0000000a2aa1', 'weplay:gr3',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BTN', 'cash', 'USD', 100, 300, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000a2b01', '00000000-0000-0000-0000-0000000a2bb1', 'weplay:grb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'CO', 'cash', 'USD', 100, 0, now());

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('hand_analysis', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'still no client write grant on either table');
select ok(
  (select bool_and(not p.prosecdef) from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_scope', 'analysis_overview', 'analysis_breakdown', 'analysis_hands', 'analysis_grade_rank')),
  'the replaced reports and the new helper are security invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_scope', 'analysis_overview', 'analysis_breakdown', 'analysis_hands', 'analysis_grade_rank')),
  '... and pin an empty search_path');
select ok(has_function_privilege('authenticated', 'public.analysis_grade_rank(text)', 'execute'),
  'the grade helper is executable by authenticated (the invoker reports call it)');
select ok(not has_function_privilege('anon', 'public.analysis_grade_rank(text)', 'execute'),
  '... and not by anon');
select ok(has_function_privilege('authenticated', 'public.analysis_scope(jsonb)', 'execute'),
  'the replaced scope helper keeps its grant');
select is(public.analysis_grade_rank('mistake'), 4, 'grades rank perfect 1 ... blunder 5');
select is(public.analysis_grade_rank('awful'), null, '... and anything else ranks nothing');

-- ------------------------------------------------------------ the data --
--
--   gr1 UTG  preflop raise   blunder  0.21 bb  14% pot  score 0     (72o open)
--            flop bet        heuristic, no grade
--   gr2 BB   preflop call    good     0.10 bb   2% pot  score 98
--            preflop fold    mistake  0.30 bb   5% pot  score 50    (vs a 3-bet)
--   gr3 BTN  preflop raise   perfect  0    bb   0       score 100
-- Hand grades: blunder, mistake, perfect.

select pg_temp.act_as('00000000-0000-0000-0000-0000000a2aa1');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a2001","analysis_version":"analysis/2","status":"full","hero_seat":1,
   "pot_type":"single-raised","grade":"blunder","score":0,"ev_loss_bb":0.21,"ev_loss_pot":0.07,
   "approximations":["heuristic","model"],"decisions":[
     {"ord":0,"action_index":3,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"blunder","score":0,"ev_loss_bb":0.21,"ev_loss_pot":0.14,"freq_diff":1,
      "options":[{"action":"fold","freq":1,"ev":0},{"action":"raise","sizeBb":2.5,"freq":0,"ev":-0.21}],"chosen":1,
      "flags":[],"approximations":["model"],"facing_bet":false,"pot_bb":1.5,"facts":{"street":"preflop"}},
     {"ord":6,"action_index":10,"street":"flop","action":"bet","status":"analysed","node":"n","scenario":"pfr-ip-first",
      "source":"heuristic","flags":[],"approximations":["heuristic"],"facing_bet":false,"pot_bb":5.5,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a2002","analysis_version":"analysis/2","status":"full","hero_seat":2,
   "pot_type":"3bet","grade":"mistake","score":74,"ev_loss_bb":0.4,"ev_loss_pot":0.02,
   "approximations":["model"],"decisions":[
     {"ord":5,"action_index":8,"street":"preflop","action":"call","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"good","score":98,"ev_loss_bb":0.1,"ev_loss_pot":0.02,"freq_diff":0.3,
      "options":[],"chosen":null,"flags":[],"approximations":["model"],"facing_bet":true,"pot_bb":5,"facts":{}},
     {"ord":9,"action_index":12,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-3bet",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.3,"ev_loss_pot":0.05,"freq_diff":0.8,
      "options":[],"chosen":null,"flags":[],"approximations":["model"],"facing_bet":true,"pot_bb":6,"facts":{}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a2003","analysis_version":"analysis/2","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,
   "approximations":["model"],"decisions":[
     {"ord":3,"action_index":6,"street":"preflop","action":"raise","status":"analysed","node":"n","scenario":"unopened",
      "source":"chart","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[],"chosen":null,"flags":[],"approximations":["model"],"facing_bet":false,"pot_bb":1.5,"facts":{}}]}
]$$::jsonb) ->> 'inserted', '3', 'A''s three graded hands are stored');

-- ---------------------------------------------------------- the overview --

select is(
  (select jsonb_build_object(
     'graded', o -> 'graded', 'gradedHands', o -> 'gradedHands', 'badHands', o -> 'badHands',
     'evLossBb', o -> 'evLossBb', 'evLossPot', o -> 'evLossPot', 'score', o -> 'score')
   from public.analysis_overview('{"analysisVersion":"analysis/2"}') o),
  '{"graded":4,"gradedHands":3,"badHands":2,"evLossBb":0.610,"evLossPot":0.2100,"score":62.00}'::jsonb,
  'overview: graded moves and hands, hands with a mistake or worse, EV loss in bb and % of pot, mean score');
select is(public.analysis_overview('{"analysisVersion":"analysis/2"}') -> 'grades',
  '[{"grade":"perfect","decisions":1},{"grade":"good","decisions":1},{"grade":"mistake","decisions":1},{"grade":"blunder","decisions":1}]'::jsonb,
  'overview: the grade distribution, best first');
select is(public.analysis_overview('{"analysisVersion":"analysis/2"}') -> 'gradesByStreet',
  '[{"street":"preflop","grade":"perfect","decisions":1},{"street":"preflop","grade":"good","decisions":1},
    {"street":"preflop","grade":"mistake","decisions":1},{"street":"preflop","grade":"blunder","decisions":1}]'::jsonb,
  'overview: the distribution by street (the heuristic flop bet is not graded)');

-- ------------------------------------------------------------- filters --

select is((public.analysis_overview('{"analysisVersion":"analysis/2","minGrade":"mistake"}') ->> 'hands')::int, 2,
  'minGrade "mistake" keeps the hands with a mistake or a blunder');
select is((public.analysis_overview('{"analysisVersion":"analysis/2","minGrade":"perfect"}') ->> 'hands')::int, 3,
  'minGrade "perfect" keeps every graded hand');
select is((public.analysis_overview('{"analysisVersion":"analysis/2","grade":"perfect"}') ->> 'hands')::int, 1,
  'grade keeps that worst grade exactly');
select throws_ok($$ select public.analysis_overview('{"analysisVersion":"analysis/2","minGrade":"awful"}') $$,
  '22023', null, 'an unknown grade is refused, not read as "no filter"');
select throws_ok($$ select public.analysis_hands('{"analysisVersion":"analysis/2","grade":"x; drop table hands"}') $$,
  '22023', null, '... in every report');

-- ------------------------------------------------------------ breakdown --

select is(
  (select r from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'street') -> 'rows') r
   where r ->> 'key' = 'preflop') - 'mdf' - 'facingBet' - 'defended' - 'flagged' - 'inaccurate' - 'analysed',
  '{"key":"preflop","hands":3,"decisions":4,"graded":4,"gradedHands":3,
    "grades":{"perfect":1,"good":1,"inaccurate":0,"mistake":1,"blunder":1},"evLossBb":0.610,"score":62.00}'::jsonb,
  'breakdown by street: graded moves, the five grade counts, EV loss and mean score');
select is(
  (select r -> 'graded' from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'street') -> 'rows') r
   where r ->> 'key' = 'flop'),
  '0'::jsonb, '... and a street with no graded move says 0, not a guess');
select is(
  (select string_agg(r ->> 'key' || ':' || (r ->> 'decisions'), ',' order by r ->> 'key')
   from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'preflop_scenario') -> 'rows') r),
  'unopened:2,vs-3bet:1,vs-open:1', 'breakdown by preflop scenario counts preflop decisions only');
select is(
  (select r -> 'grades' from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'preflop_scenario') -> 'rows') r
   where r ->> 'key' = 'unopened'),
  '{"perfect":1,"good":0,"inaccurate":0,"mistake":0,"blunder":1}'::jsonb, '... with its grades');
select is(
  (select string_agg(r ->> 'key' || ':' || (r ->> 'evLossBb'), ',' order by r ->> 'key')
   from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'position') -> 'rows') r),
  'BB:0.400,BTN:0.000,UTG:0.210', 'breakdown by position sums EV loss per seat');
select is(
  (select string_agg(r ->> 'key' || ':' || (r ->> 'graded'), ',' order by r ->> 'key')
   from jsonb_array_elements(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'pot_type') -> 'rows') r),
  '3bet:2,single-raised:2', 'breakdown by pot type counts graded moves');
select throws_ok($$ select public.analysis_breakdown('{}', 'grade') $$, '22023', null,
  'the breakdown dimension is still whitelisted');

-- ---------------------------------------------------------------- list --

select is((select array_agg(r ->> 'handId') from jsonb_array_elements(public.analysis_hands('{"analysisVersion":"analysis/2"}', 'ev_loss') -> 'rows') r),
  array['00000000-0000-0000-0000-0000000a2002', '00000000-0000-0000-0000-0000000a2001', '00000000-0000-0000-0000-0000000a2003'],
  'the list sorts by EV loss in bb, most first');
select is((select array_agg(r ->> 'handId') from jsonb_array_elements(public.analysis_hands('{"analysisVersion":"analysis/2"}', 'ev_loss_pot') -> 'rows') r),
  array['00000000-0000-0000-0000-0000000a2001', '00000000-0000-0000-0000-0000000a2002', '00000000-0000-0000-0000-0000000a2003'],
  '... and by EV loss in % of the pot');
select is(public.analysis_hands('{"analysisVersion":"analysis/2"}', 'ev_loss', 1, 0) -> 'rows' -> 0 -> 'decisions' -> 1 ->> 'evLossBb',
  '0.300', 'each decision carries its EV loss');
select is((public.analysis_hands('{"analysisVersion":"analysis/2","minGrade":"mistake"}') ->> 'total')::int, 2,
  'the list filters to hands with a mistake or a blunder');
select throws_ok($$ select public.analysis_hands('{}', 'ev_loss_pot; drop table hands') $$, '22023', null,
  'the sort key is still whitelisted');

-- ------------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a2bb1');
select is((public.analysis_overview('{"analysisVersion":"analysis/2"}') ->> 'graded')::int, 0,
  'B sees none of A''s graded moves');
select is(jsonb_array_length(public.analysis_breakdown('{"analysisVersion":"analysis/2"}', 'preflop_scenario') -> 'rows'), 0,
  '... in any breakdown');

select pg_temp.act_as_anon();
select throws_ok($$ select public.analysis_breakdown('{}', 'preflop_scenario') $$, '42501', null,
  'anon reads nothing');

select * from finish();
rollback;
