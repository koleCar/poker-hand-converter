-- pgTAP: Learn, phase L1 -- `20270317090000_learn_progress.sql`.
--
-- Lesson progress, lesson review cards and the study plan's `lesson` task.
-- What has to hold:
--
--   * the security model: no client INSERT / UPDATE / DELETE on either table,
--     RLS on, the three writers `security definer`, every function pinning an
--     empty search_path, executable by `authenticated` (with the scheduling
--     helpers the review calls) and not by `anon`;
--   * results: an exercise keeps its latest score, its `passed` flag and the
--     lesson's `passed` status are sticky, a batch is validated whole, and an
--     account holds at most 200 lessons;
--   * cards: one per item, a card missed again is due now, a review
--     reschedules it by SM-2 exactly as a drill would be, and a card is named
--     by id and owner;
--   * the study plan takes a `lesson` task and counts it done when the lesson
--     is passed;
--   * one user's rows never reach another's reads or writes; anon reads and
--     writes nothing; `learn` is a reserved username.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(50);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000001ea01', 'learn.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000001eb01', 'learn.b@example.com', now(), now());

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

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('lesson_progress', 'lesson_cards')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client write grant on either table');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('lesson_progress', 'lesson_cards') and grantee = 'anon'),
  0, 'anon holds no grant at all on either table');
select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname in ('lesson_progress', 'lesson_cards')),
  'RLS is on for both');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 3 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('record_lesson_results', 'add_lesson_cards', 'review_lesson_card')),
  'the three writers are security definer');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') and count(*) = 5 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('record_lesson_results', 'add_lesson_cards', 'review_lesson_card', 'save_study_plan', 'study_plan')),
  'every one, and the replaced study plan functions, pins an empty search_path');
select ok(
  (select not p.prosecdef from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'study_plan'),
  'the study plan reader is still invoker');
select ok(
  has_function_privilege('authenticated', 'public.record_lesson_results(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.add_lesson_cards(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.review_lesson_card(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_quality(text)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_next(integer, integer, numeric, integer, integer)', 'execute'),
  'authenticated may execute the writers and the scheduling helpers the review calls');
select ok(
  not has_function_privilege('anon', 'public.record_lesson_results(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.add_lesson_cards(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.review_lesson_card(uuid, text)', 'execute'),
  'anon may execute none of the writers');
select is(
  (select reason from public.username_reservations where username_lower = 'learn'),
  'route', '/learn is a reserved username');

-- ------------------------------------------------------------- results --

select pg_temp.act_as('00000000-0000-0000-0000-00000001ea01');

select is(
  public.record_lesson_results($$[
    {"lesson":"pot-odds","exercise":"price-drill","correct":8,"total":10,"passed":true}
  ]$$::jsonb),
  '{"recorded":1,"passed":0}'::jsonb, 'A records an exercise passed');
select is(
  (select format('%s:%s/%s:%s:%s', status, exercises -> 'price-drill' ->> 'correct', exercises -> 'price-drill' ->> 'total',
                 exercises -> 'price-drill' ->> 'passed', exercises -> 'price-drill' ->> 'attempts')
   from public.lesson_progress where lesson_id = 'pot-odds'),
  'started:8/10:true:1', 'the lesson is started, the exercise kept with its score');
select is(
  public.record_lesson_results($$[
    {"lesson":"pot-odds","exercise":"price-drill","correct":5,"total":10,"passed":false}
  ]$$::jsonb) ->> 'recorded', '1', 'A tries the exercise again and does worse');
select is(
  (select format('%s/%s:%s:%s', exercises -> 'price-drill' ->> 'correct', exercises -> 'price-drill' ->> 'total',
                 exercises -> 'price-drill' ->> 'passed', exercises -> 'price-drill' ->> 'attempts')
   from public.lesson_progress where lesson_id = 'pot-odds'),
  '5/10:true:2', 'the latest score is kept, the passed flag sticks, the attempts count');
select is(
  public.record_lesson_results($$[
    {"lesson":"pot-odds","exercise":"your-hands","correct":2,"total":3,"passed":true,"lesson_passed":true}
  ]$$::jsonb),
  '{"recorded":1,"passed":1}'::jsonb, 'A passes the lesson');
select ok(
  (select status = 'passed' and passed_at is not null and exercises ? 'price-drill' and exercises ? 'your-hands'
   from public.lesson_progress where lesson_id = 'pot-odds'),
  'the lesson is passed, with both exercises');
select is(
  (select format('%s', status) from public.lesson_progress
   where lesson_id = 'pot-odds' and public.record_lesson_results($$[
     {"lesson":"pot-odds","exercise":"price-drill","correct":1,"total":10,"passed":false}
   ]$$::jsonb) is not null),
  'passed', 'a later failed attempt leaves the lesson passed');
select is(
  public.record_lesson_results($$[{"lesson":"how-rail-teaches"}]$$::jsonb) ->> 'recorded', '1',
  'a lesson can be recorded as started with no exercise');
select is(
  (select format('%s:%s', status, exercises) from public.lesson_progress where lesson_id = 'how-rail-teaches'),
  'started:{}', '... and is started with no exercises');

select throws_ok($$select public.record_lesson_results('[{"lesson":"Pot Odds"}]')$$,
  '22023', null, 'a malformed lesson id is refused');
select throws_ok($$select public.record_lesson_results('[{"lesson":"pot-odds","exercise":"x","correct":4,"total":3,"passed":true}]')$$,
  '22023', null, 'more right than asked is refused');
select throws_ok($$select public.record_lesson_results('[{"lesson":"pot-odds","correct":1,"total":3}]')$$,
  '22023', null, 'a score without an exercise is refused');
select throws_ok($$select public.record_lesson_results('{"lesson":"pot-odds"}')$$,
  '22023', null, 'the results are an array');
select throws_ok(
  $$select public.record_lesson_results((select jsonb_agg(jsonb_build_object('lesson', 'pot-odds')) from generate_series(1, 101)))$$,
  '53400', null, 'at most 100 results at a time');
select throws_ok(
  $$select public.record_lesson_results('[{"lesson":"board-texture"},{"lesson":"BAD"}]')$$,
  '22023', null, 'a batch with one bad row is refused ...');
select is(
  (select count(*)::int from public.lesson_progress where lesson_id = 'board-texture'), 0,
  '... whole: its good row is not written');

-- The 200-lesson cap (two rows so far).
select is(
  public.record_lesson_results((select jsonb_agg(jsonb_build_object('lesson', 'x-lesson-' || n)) from generate_series(1, 100) n))
    ->> 'recorded', '100', 'a hundred more lessons');
select is(
  public.record_lesson_results((select jsonb_agg(jsonb_build_object('lesson', 'y-lesson-' || n)) from generate_series(1, 98) n))
    ->> 'recorded', '98', '... and 98 more: 200 in all');
select throws_ok(
  $$select public.record_lesson_results('[{"lesson":"one-too-many"}]')$$,
  '53400', null, 'the 201st lesson is refused');
select is(
  public.record_lesson_results($$[{"lesson":"pot-odds","exercise":"price-drill","correct":9,"total":10,"passed":true}]$$::jsonb)
    ->> 'recorded', '1', 'a lesson already there can still be updated at the cap');

-- ---------------------------------------------------------------- cards --

select is(
  public.add_lesson_cards($$[
    {"lesson":"pot-odds","exercise":"price-drill","kind":"calc","key":"pot-odds:price-drill:12345","item":{"k":"calc","calc":"pot-odds","seed":12345}},
    {"lesson":"facing-an-open","exercise":"call-3bet-fold","kind":"chart-quiz","key":"facing-an-open:call-3bet-fold:777",
     "item":{"k":"chart","seed":777,"family":"vs-open","bias":"borderline"}}
  ]$$::jsonb) ->> 'inserted', '2', 'A misses two quiz items: two cards');

reset role;
update public.lesson_cards set due_at = now() + interval '3 days' where item_key = 'pot-odds:price-drill:12345';
select pg_temp.act_as('00000000-0000-0000-0000-00000001ea01');

select is(
  public.add_lesson_cards($$[
    {"lesson":"pot-odds","exercise":"price-drill","kind":"calc","key":"pot-odds:price-drill:12345","item":{"k":"calc","calc":"pot-odds","seed":12345}}
  ]$$::jsonb),
  '{"inserted":0,"total":2}'::jsonb, 'missing the same item again adds no card ...');
select ok(
  (select due_at <= now() from public.lesson_cards where item_key = 'pot-odds:price-drill:12345'),
  '... it makes the card due now');
select throws_ok(
  $$select public.add_lesson_cards('[{"lesson":"pot-odds","exercise":"e","kind":"range-paint","key":"pot-odds:e:1","item":{}}]')$$,
  '22023', null, 'a card of a kind that is not a quiz is refused');
select throws_ok(
  $$select public.add_lesson_cards('[{"lesson":"pot-odds","exercise":"e","kind":"calc","key":"Bad Key","item":{}}]')$$,
  '22023', null, 'a malformed key is refused');
select throws_ok(
  $$select public.add_lesson_cards('[{"lesson":"pot-odds","exercise":"e","kind":"calc","key":"pot-odds:e:1","item":[1]}]')$$,
  '22023', null, 'an item that is not an object is refused');
select throws_ok(
  $$select public.add_lesson_cards((select jsonb_agg(jsonb_build_object('lesson','pot-odds','exercise','e','kind','calc',
      'key','pot-odds:e:' || n,'item','{}'::jsonb)) from generate_series(1, 21) n))$$,
  '53400', null, 'at most 20 cards at a time');

create temp table a_card on commit drop as
  select id from public.lesson_cards where item_key = 'pot-odds:price-drill:12345';
grant select on a_card to authenticated;

select is(
  (select format('%s/%s/%s/%s', r ->> 'reps', r ->> 'lapses', r ->> 'intervalDays', r ->> 'relearn')
   from a_card, public.review_lesson_card(a_card.id, 'perfect') r),
  '1/0/1/false', 'a right answer: one repetition, back in a day (SM-2, as drill_next)');
select ok(
  (select due_at between now() + interval '23 hours' and now() + interval '25 hours' and reviews = 1 and last_grade = 'perfect'
   from public.lesson_cards where item_key = 'pot-odds:price-drill:12345'),
  '... stored with its due date and review count');
select is(
  (select format('%s/%s/%s/%s', r ->> 'reps', r ->> 'lapses', r ->> 'intervalDays', r ->> 'relearn')
   from a_card, public.review_lesson_card(a_card.id, 'mistake') r),
  '0/1/0/true', 'a wrong answer: a lapse, relearned');
select ok(
  (select due_at <= now() + interval '10 minutes' from public.lesson_cards where item_key = 'pot-odds:price-drill:12345'),
  '... due again within ten minutes');
select throws_ok($$select public.review_lesson_card((select id from a_card), 'great')$$,
  '22023', null, 'an unknown grade is refused');

-- ------------------------------------------------------------ isolation --

select pg_temp.act_as('00000000-0000-0000-0000-00000001eb01');
select throws_ok($$select public.review_lesson_card((select id from a_card), 'perfect')$$,
  'P0002', 'No such card.', 'A''s card, reviewed by B: "No such card."');
select is(
  (select count(*)::int from public.lesson_progress) + (select count(*)::int from public.lesson_cards), 0,
  'B reads none of A''s progress or cards');

-- ------------------------------------------------------- the study plan --

select pg_temp.act_as('00000000-0000-0000-0000-00000001ea01');
select is(
  public.save_study_plan(public.study_week(), 'fundamentals', 'analysis/7', '[]', '{}', $$[
    {"kind":"lesson","ref":"pot-odds","target":1},
    {"kind":"lesson","ref":"board-texture","target":1},
    {"kind":"read","ref":"position","target":1}
  ]$$::jsonb) ->> 'tasks', '3', 'A''s plan takes lesson tasks');
select is(
  (select string_agg(format('%s:%s:%s/%s:%s', t ->> 'kind', t ->> 'ref', t ->> 'progress', t ->> 'target', t ->> 'done'), ','
                     order by (t ->> 'ord')::int)
   from jsonb_array_elements(public.study_plan(public.study_week()) -> 'tasks') t),
  'lesson:pot-odds:1/1:true,lesson:board-texture:0/1:false,read:position:0/1:false',
  'a lesson task is done when the lesson is passed, not before');
select throws_ok(
  $$select public.save_study_plan(public.study_week(), 'fundamentals', 'analysis/7', '[]', '{}',
      '[{"kind":"lesson","ref":"Not A Lesson","target":1}]')$$,
  '22023', null, 'a malformed lesson reference is refused');

select pg_temp.act_as('00000000-0000-0000-0000-00000001eb01');
select is(
  public.save_study_plan(public.study_week(), 'fundamentals', 'analysis/7', '[]', '{}',
    '[{"kind":"lesson","ref":"pot-odds","target":1}]') ->> 'tasks', '1', 'B writes a plan with the same lesson task');
select is(
  (select string_agg(format('%s:%s', t ->> 'ref', t ->> 'done'), ',')
   from jsonb_array_elements(public.study_plan(public.study_week()) -> 'tasks') t),
  'pot-odds:false', 'B''s lesson task is not done by A''s pass');

-- ---------------------------------------------------------------- anon --

select pg_temp.act_as_anon();
select throws_ok($$select count(*) from public.lesson_progress$$, '42501', null, 'anon cannot read progress');
select throws_ok($$select public.record_lesson_results('[{"lesson":"pot-odds"}]')$$, '42501', null, '... nor write it');

select * from finish();
rollback;
