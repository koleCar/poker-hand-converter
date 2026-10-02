-- pgTAP: hand analysis, phase A7 -- `20270208090000_analysis_training.sql`.
--
-- Drills and trainer results. What has to hold:
--
--   * the security model: no client INSERT / UPDATE / DELETE on any of the
--     three tables, RLS on, the three writers `security definer` and the
--     readers and helpers invoker, every one pinning an empty search_path,
--     executable by `authenticated` and not by `anon`;
--   * the scheduling arithmetic (`drill_next`) on the same table of cases as
--     `tests/test/training.test.ts` holds `lib/training/schedule.ts` to;
--   * drills are built only from the caller's own Mistakes and Blunders (and
--     Inaccurate when asked), once, with the leak finder's spot key, and
--     follow a re-analysis at a new version without losing their schedule;
--   * a review reschedules only the caller's own drill, checks the option
--     index against the stored options, and validates its input;
--   * one user's drills, reviews and trainer results never reach another's
--     reads, and anon reads nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(51);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a7aa1', 'tr.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a7bb1', 'tr.b@example.com', now(), now());

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

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-0000000a7001', '00000000-0000-0000-0000-0000000a7aa1', 'weplay:tr1',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['Qh','Jh'], '2026-03-02T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000a7002', '00000000-0000-0000-0000-0000000a7aa1', 'weplay:tr2',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, -200,
   array['Kc','Qd'], '2026-03-03T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000a7b01', '00000000-0000-0000-0000-0000000a7bb1', 'weplay:trb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, 0,
   array['Ah','Ad'], '2026-03-04T10:00:00Z');

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('drill_items', 'drill_reviews', 'trainer_results')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client write grant on any of the three tables');
select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 3 from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname in ('drill_items', 'drill_reviews', 'trainer_results')),
  'RLS is on for all three');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 3 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('sync_drill_items', 'review_drill', 'record_trainer_results')),
  'the three writers are security definer');
select ok(
  (select bool_and(not p.prosecdef) and count(*) = 7 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('drill_quality', 'drill_next', 'drill_keys_valid', 'drill_queue', 'drill_summary',
                       'drill_due_by_spot', 'trainer_summary')),
  'the readers and helpers are security invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('sync_drill_items', 'review_drill', 'record_trainer_results', 'drill_quality', 'drill_next',
                       'drill_keys_valid', 'drill_queue', 'drill_summary', 'drill_due_by_spot', 'trainer_summary')),
  'every one pins an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.sync_drill_items(text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.review_drill(uuid, integer, text, numeric)', 'execute')
  and has_function_privilege('authenticated', 'public.record_trainer_results(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_quality(text)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_next(integer, integer, numeric, integer, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_keys_valid(text[])', 'execute')
  and has_function_privilege('authenticated', 'public.drill_queue(text, text[], boolean, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_summary(text, timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_due_by_spot(text, timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.trainer_summary(integer)', 'execute'),
  'authenticated may execute all of them (the helpers too: invoker readers call them as their caller)');
select ok(
  not has_function_privilege('anon', 'public.sync_drill_items(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.review_drill(uuid, integer, text, numeric)', 'execute')
  and not has_function_privilege('anon', 'public.record_trainer_results(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.drill_quality(text)', 'execute')
  and not has_function_privilege('anon', 'public.drill_next(integer, integer, numeric, integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.drill_keys_valid(text[])', 'execute')
  and not has_function_privilege('anon', 'public.drill_queue(text, text[], boolean, integer)', 'execute')
  and not has_function_privilege('anon', 'public.drill_summary(text, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.drill_due_by_spot(text, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.trainer_summary(integer)', 'execute'),
  'anon may execute none of them');

-- ---------------------------------------------------------- scheduling --

select is(
  (select string_agg(format('%s/%s/%s', g, public.drill_quality(g), coalesce(public.drill_quality(g)::text, '-')), ','
                     order by ord)
   from unnest(array['perfect', 'good', 'inaccurate', 'mistake', 'blunder', 'great']) with ordinality as t(g, ord)),
  'perfect/5/5,good/4/4,inaccurate/3/3,mistake/1/1,blunder/0/0,great//-',
  'a grade''s quality: Perfect 5 ... Blunder 0, nothing for an unknown grade');

-- The table `tests/test/training.test.ts` holds schedule.ts to.
select is(
  (select string_agg(format('%s,%s,%s,%s,%s>%s,%s,%s,%s,%s', r, l, e, i, q, n.reps, n.lapses, n.ease, n.interval_days, case when n.relearn then 'relearn' else 'pass' end),
                     ' ' order by ord)
   from (values (1, 0, 0, 2.50, 0, 5), (2, 1, 0, 2.60, 1, 5), (3, 2, 0, 2.70, 6, 5), (4, 3, 0, 2.80, 17, 4),
                (5, 4, 0, 2.80, 48, 3), (6, 5, 0, 2.66, 128, 1), (7, 0, 1, 2.12, 0, 0), (8, 0, 2, 1.32, 0, 0),
                (9, 6, 0, 3.00, 200, 5), (10, 3, 0, 1.45, 10, 4), (11, 2, 0, 2.50, 6, 3)) v(ord, r, l, e, i, q),
        lateral public.drill_next(v.r, v.l, v.e, v.i, v.q) n),
  '0,0,2.50,0,5>1,0,2.60,1,pass 1,0,2.60,1,5>2,0,2.70,6,pass 2,0,2.70,6,5>3,0,2.80,17,pass '
  '3,0,2.80,17,4>4,0,2.80,48,pass 4,0,2.80,48,3>5,0,2.66,128,pass 5,0,2.66,128,1>0,1,2.12,0,relearn '
  '0,1,2.12,0,0>0,2,1.32,0,relearn 0,2,1.32,0,0>0,3,1.30,0,relearn 6,0,3.00,200,5>7,0,3.00,365,pass '
  '3,0,1.45,10,4>4,0,1.45,15,pass 2,0,2.50,6,3>3,0,2.36,14,pass',
  'SM-2: 1 day, 6 days, then interval x ease (half up, at most a year); ease clamped to 1.30..3.00; a fail relearns');

-- ------------------------------------------------------------ the data --
--
--   A, h1  preflop BB vs-open fold   mistake  0.8   best call    (fffrf)
--          river   BB check          blunder  4.0   best bet
--          river   BB call           perfect  0     (never a drill)
--   A, h2  preflop BB vs-open fold   inaccurate 0.2 best call
--   B, b1  preflop BB vs-open fold   mistake  0.5   best call

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7aa1');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a7001","analysis_version":"analysis/3","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"blunder","score":20,"ev_loss_bb":4.8,"ev_loss_pot":0.4,"approximations":[],"decisions":[
     {"ord":0,"action_index":7,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.8,"ev_loss_pot":0.05,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.2}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}},
     {"ord":3,"action_index":20,"street":"river","action":"check","status":"analysed","node":"n","scenario":"caller-oop-first",
      "source":"solver","grade":"blunder","score":0,"ev_loss_bb":4,"ev_loss_pot":0.4,"freq_diff":0.9,
      "options":[{"action":"check","freq":0.05,"ev":1},{"action":"bet","size":3,"freq":0.95,"ev":5}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":false,"pot_bb":10,"facts":{"position":"BB"}},
     {"ord":5,"action_index":23,"street":"river","action":"call","status":"analysed","node":"n","scenario":"caller-oop-vs-raise",
      "source":"solver","grade":"perfect","score":100,"ev_loss_bb":0,"ev_loss_pot":0,"freq_diff":0,
      "options":[{"action":"fold","freq":0,"ev":0},{"action":"call","freq":1,"ev":3}],"chosen":1,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":30,"facts":{"position":"BB"}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a7002","analysis_version":"analysis/3","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"inaccurate","score":80,"ev_loss_bb":0.2,"ev_loss_pot":0.05,"approximations":[],"decisions":[
     {"ord":0,"action_index":7,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"inaccurate","score":80,"ev_loss_bb":0.02,"ev_loss_pot":0.005,"freq_diff":0.98,
      "options":[{"action":"fold","sizeBb":1,"freq":0.02,"ev":-1},{"action":"call","sizeBb":2.5,"freq":0.98,"ev":-0.98}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"KQo","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]},
  {"hand_id":"00000000-0000-0000-0000-0000000a7b01","analysis_version":"analysis/3","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"mistake","score":50,"ev_loss_bb":0.5,"ev_loss_pot":0.1,"approximations":[],"decisions":[
     {"ord":0,"action_index":7,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.5,"ev_loss_pot":0.1,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.5}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"AA","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '2', 'A''s analysis is stored; B''s hand in A''s call is skipped (not A''s)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7bb1');
select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a7b01","analysis_version":"analysis/3","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"mistake","score":50,"ev_loss_bb":0.5,"ev_loss_pot":0.1,"approximations":[],"decisions":[
     {"ord":0,"action_index":7,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.5,"ev_loss_pot":0.1,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.5}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"AA","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '1', 'B''s analysis is stored');

-- ---------------------------------------------------------------- sync --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7aa1');

select is((public.drill_summary('analysis/3') -> 'candidates')::int, 2,
  'before a sync: two Mistakes or worse are candidates');
select is(public.sync_drill_items('analysis/3'), '{"inserted":2,"updated":0,"total":2}'::jsonb,
  'a sync builds a drill from each Mistake and Blunder, not from the Perfect or the Inaccurate move');
select is(
  (select string_agg(format('%s:%s:%s:%s', street, action_index, source_grade, spot_key), ',' order by street, action_index)
   from public.drill_items),
  'preflop:7:mistake:preflop|vs-open|fffrf|BB|fold|call,river:20:blunder:river|caller-oop-first||BB|check|bet',
  'each drill names its decision and the leak finder''s spot key');
select is(public.sync_drill_items('analysis/3'), '{"inserted":0,"updated":0,"total":2}'::jsonb,
  'a second sync adds nothing');
select is(public.sync_drill_items('analysis/3', 'inaccurate'), '{"inserted":1,"updated":0,"total":3}'::jsonb,
  '... and Inaccurate moves join when asked for');
select throws_ok($$select public.sync_drill_items('analysis/3', 'good')$$, '22023', null,
  'a drill of a Good move is refused');
select throws_ok($$select public.sync_drill_items('nope')$$, '22023', null, 'the version is validated');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7bb1');
select is(public.sync_drill_items('analysis/3') ->> 'total', '1', 'B''s sync builds B''s drill only');
select is((select count(*)::int from public.drill_items), 1, 'B sees one drill: its own');

-- -------------------------------------------------------------- review --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7aa1');

select is(
  (select r - 'id' - 'dueAt'
   from public.review_drill((select id from public.drill_items where street = 'preflop' and hand_id = '00000000-0000-0000-0000-0000000a7001'),
                            1, 'perfect', 0) r),
  '{"reps":1,"lapses":0,"ease":2.60,"intervalDays":1,"relearn":false}'::jsonb,
  'a Perfect answer: one repetition, back in a day, ease up');
select ok(
  (select due_at between now() + interval '23 hours' and now() + interval '25 hours' and last_grade = 'perfect' and reviews = 1
   from public.drill_items where street = 'preflop' and hand_id = '00000000-0000-0000-0000-0000000a7001'),
  '... due tomorrow, with its last grade and review count');
select is(
  (select r - 'id' - 'dueAt'
   from public.review_drill((select id from public.drill_items where street = 'river'), 0, 'blunder', 4) r),
  '{"reps":0,"lapses":1,"ease":1.70,"intervalDays":0,"relearn":true}'::jsonb,
  'a Blunder: relearned, a lapse, ease down');
select ok(
  (select due_at between now() + interval '9 minutes' and now() + interval '11 minutes'
   from public.drill_items where street = 'river'),
  '... back in ten minutes');
select is((select count(*)::int from public.drill_reviews), 2, 'each answer is in the review log');
select throws_ok(
  $$select public.review_drill((select id from public.drill_items where street = 'river'), 5, 'perfect', 0)$$,
  '22023', null, 'an option index beyond the stored options is refused');
select throws_ok(
  $$select public.review_drill((select id from public.drill_items where street = 'river'), 0, 'great', 0)$$,
  '22023', null, 'an unknown grade is refused');
select throws_ok(
  $$select public.review_drill((select id from public.drill_items where street = 'river'), 0, 'perfect', -1)$$,
  '22023', null, 'a negative EV loss is refused');
select throws_ok(
  $$update public.drill_items set due_at = now() - interval '1 year'$$,
  '42501', null, 'the owner cannot write a drill directly');
select throws_ok(
  $$insert into public.trainer_results (owner_id, mode, family, grade, ev_loss_bb, ev_loss_pot, score)
    values ('00000000-0000-0000-0000-0000000a7aa1', 'preflop', 'rfi', 'perfect', 0, 0, 100)$$,
  '42501', null, '... nor a trainer result');

-- B cannot touch A's drill: the same answer as a drill that does not exist.
create temp table a_drill on commit drop as
  select id from public.drill_items where street = 'river';
grant select on a_drill to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000a7bb1');
select throws_ok($$select public.review_drill((select id from a_drill), 0, 'perfect', 0)$$,
  'P0002', 'No such drill.', 'another account''s drill: "No such drill."');
select throws_ok($$select public.review_drill('00000000-0000-0000-0000-00000000dead', 0, 'perfect', 0)$$,
  'P0002', 'No such drill.', '... exactly as for a drill that does not exist');
select is((select count(*)::int from public.drill_reviews), 0, 'B sees none of A''s reviews');

-- ------------------------------------------------------- queue, summary --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7aa1');

select is(
  (select string_agg(format('%s:%s', q ->> 'street', q ->> 'due'), ',')
   from jsonb_array_elements(public.drill_queue('analysis/3')) q),
  'preflop:true', 'the due queue: the drill never reviewed (the others are scheduled ahead)');
select is(jsonb_array_length(public.drill_queue('analysis/3', null, false)), 3,
  'the whole queue, due or not');
select is(
  (select string_agg(q ->> 'spotKey', ',')
   from jsonb_array_elements(public.drill_queue('analysis/3', array['river|caller-oop-first||BB|check|bet'], false)) q),
  'river|caller-oop-first||BB|check|bet', 'a leak''s drills, by spot key');
select throws_ok($$select public.drill_queue('analysis/3', array['not a key'])$$, '22023', null,
  'spot keys are validated');
select is(jsonb_array_length(public.drill_queue('analysis/4', null, false)), 0,
  'a version with no analysed decision offers no drill');
select is(
  public.drill_summary('analysis/3', now() + interval '12 hours') - 'analysisVersion',
  '{"items":3,"due":1,"dueToday":2,"learning":1,"mature":0,"reviewed":2,"candidates":0}'::jsonb,
  'the summary: items, due now, due by the end of the day, learning, mature, reviews, candidates');
select is(
  (select string_agg(format('%s=%s/%s', r ->> 'key', r ->> 'items', r ->> 'due'), ',')
   from jsonb_array_elements(public.drill_due_by_spot('analysis/3', now() + interval '12 hours')) r),
  'preflop|vs-open|fffrf|BB|fold|call=2/1,river|caller-oop-first||BB|check|bet=1/1',
  'per leak spot: drills and due by the end of the day');

-- ----------------------------------------------------- a new version --

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a7001","analysis_version":"analysis/9","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"mistake","score":50,"ev_loss_bb":0.8,"ev_loss_pot":0.05,"approximations":[],"decisions":[
     {"ord":0,"action_index":7,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.8,"ev_loss_pot":0.05,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.2}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '1', 'h1 re-analysed at a new version');
select is(public.sync_drill_items('analysis/9'), '{"inserted":0,"updated":1,"total":3}'::jsonb,
  'a sync at the new version re-points the drill instead of adding one');
select is(
  (select format('%s:%s:%s', analysis_version, reps, reviews) from public.drill_items
   where hand_id = '00000000-0000-0000-0000-0000000a7001' and street = 'preflop'),
  'analysis/9:1:1', '... and the drill keeps its schedule');

-- ------------------------------------------------------ trainer results --

select is(public.record_trainer_results($$[
  {"mode":"preflop","family":"vs-open","spot":"fffrf","position":"BB","hand_class":"QJs","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100},
  {"mode":"river","family":"srp","spot":"btn-bb","position":"BB","grade":"mistake","ev_loss_bb":1.25,"ev_loss_pot":0.05,"score":50}
]$$::jsonb), '{"inserted":2}'::jsonb, 'trainer answers are recorded');
select throws_ok($$select public.record_trainer_results('[{"mode":"preflop","family":"rfi","grade":"great","ev_loss_bb":0,"ev_loss_pot":0,"score":100}]')$$,
  '23514', null, 'a row the checks refuse fails the whole call');
select throws_ok($$select public.record_trainer_results((select jsonb_agg('{"mode":"preflop","family":"rfi","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100}'::jsonb) from generate_series(1, 51)))$$,
  '53400', null, 'at most 50 rows per call');
select is(
  (select string_agg(format('%s:%s:%s:%s', m ->> 'mode', m ->> 'answers', m ->> 'perfect', m ->> 'mistake'), ',')
   from jsonb_array_elements(public.trainer_summary(30) -> 'modes') m),
  'preflop:1:1:0,river:1:0:1', 'the summary per mode');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a7bb1');
select is((select count(*)::int from public.trainer_results), 0, 'B sees none of A''s trainer results');
select is(jsonb_array_length(public.trainer_summary(30) -> 'modes'), 0, '... and its summary is empty');

-- ---------------------------------------------------------------- anon --

select pg_temp.act_as_anon();
select throws_ok($$select count(*) from public.drill_items$$, '42501', null, 'anon cannot read drills');
select throws_ok($$select public.drill_summary('analysis/3')$$, '42501', null, '... nor call the readers');

select * from finish();
rollback;
