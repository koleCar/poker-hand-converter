-- pgTAP: hand analysis, phase A8b -- `20270215090000_analysis_study_plan.sql`.
--
-- The study plan. What has to hold:
--
--   * the security model: no client INSERT / UPDATE / DELETE on either table,
--     RLS on, the two writers `security definer` and the reader and helpers
--     invoker, every one pinning an empty search_path, executable by
--     `authenticated` and not by `anon`;
--   * a plan is the caller's, for one ISO week named by its Monday (this
--     week, last week or next week), every task validated, a hand to review
--     one of the caller's own;
--   * progress: trainer answers and drill reviews inside the week count
--     towards their tasks, anything outside it does not, and a tick is a tick;
--   * the week rollover: a new week's plan is a new row, last week's keeps
--     its tasks and ticks, and rebuilding a week keeps the ticks of the tasks
--     it keeps;
--   * one user's plans and tasks never reach another's reads or writes, and
--     anon reads nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(54);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a8aa1', 'plan.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a8bb1', 'plan.b@example.com', now(), now());

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
  ('00000000-0000-0000-0000-0000000a8001', '00000000-0000-0000-0000-0000000a8aa1', 'weplay:pl1',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['Qh','Jh'], '2026-03-02T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000a8002', '00000000-0000-0000-0000-0000000a8aa1', 'weplay:pl2',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, -200,
   array['Kc','Qd'], '2026-03-03T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000a8b01', '00000000-0000-0000-0000-0000000a8bb1', 'weplay:plb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 3, 'BB', 'cash', 'USD', 100, 50, 100, 0,
   array['Ah','Ad'], '2026-03-04T10:00:00Z');

-- The weeks, as the tests name them (the UTC week the database is in).
create temp table weeks on commit drop as
  select public.study_week() as this_week,
         public.study_week() - 7 as last_week,
         public.study_week() + 7 as next_week;
grant select on weeks to authenticated;

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('study_plans', 'study_tasks')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client write grant on either table');
select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 2 from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname in ('study_plans', 'study_tasks')),
  'RLS is on for both');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 2 from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('save_study_plan', 'set_study_task')),
  'the two writers are security definer');
select ok(
  (select bool_and(not p.prosecdef) and count(*) = 3 from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('study_week', 'study_week_valid', 'study_plan')),
  'the reader and the helpers are security invoker');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') and count(*) = 5 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('save_study_plan', 'set_study_task', 'study_week', 'study_week_valid', 'study_plan')),
  'every one pins an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.save_study_plan(date, text, text, jsonb, jsonb, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.set_study_task(uuid, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.study_plan(date, timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.study_week()', 'execute')
  and has_function_privilege('authenticated', 'public.study_week_valid(date)', 'execute'),
  'authenticated may execute all of them (the helpers too: the writers and the reader call them)');
select ok(
  not has_function_privilege('anon', 'public.save_study_plan(date, text, text, jsonb, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.set_study_task(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.study_plan(date, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.study_week()', 'execute')
  and not has_function_privilege('anon', 'public.study_week_valid(date)', 'execute'),
  'anon may execute none of them');

-- --------------------------------------------------------------- weeks --

select is(
  (select format('%s/%s/%s/%s/%s',
     extract(isodow from w.this_week),
     public.study_week_valid(w.this_week), public.study_week_valid(w.last_week), public.study_week_valid(w.next_week),
     public.study_week_valid(w.this_week + 1))
   from weeks w),
  '1/t/t/t/f', 'a plan week is a Monday: this one, last one or next one');
select ok(
  (select not public.study_week_valid(w.this_week - 14) and not public.study_week_valid(w.this_week + 14) from weeks w),
  '... not two weeks back or ahead');

-- ------------------------------------------------------- A's drill data --
--
-- One graded Mistake (h1, preflop BB vs-open fold), made a drill and answered
-- once, now: a drill review inside this week.

select pg_temp.act_as('00000000-0000-0000-0000-0000000a8aa1');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a8001","analysis_version":"analysis/3","status":"full","hero_seat":3,
   "pot_type":"single-raised","grade":"mistake","score":50,"ev_loss_bb":0.8,"ev_loss_pot":0.05,"approximations":[],"decisions":[
     {"ord":0,"action_index":7,"street":"preflop","action":"fold","status":"analysed","node":"n","scenario":"vs-open",
      "source":"chart","grade":"mistake","score":50,"ev_loss_bb":0.8,"ev_loss_pot":0.05,"freq_diff":1,
      "options":[{"action":"fold","sizeBb":1,"freq":0,"ev":-1},{"action":"call","sizeBb":2.5,"freq":1,"ev":-0.2}],"chosen":0,
      "flags":[],"approximations":[],"facing_bet":true,"pot_bb":4,
      "facts":{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf","scenario":"vs-open","inRange":1}}}]}
]$$::jsonb) ->> 'inserted', '1', 'A''s analysis is stored');
select is(public.sync_drill_items('analysis/3') ->> 'total', '1', 'A has one drill');
select is(
  (select r ->> 'reps' from public.review_drill((select id from public.drill_items), 1, 'perfect', 0) r),
  '1', 'A answers it once');

-- ------------------------------------------------------- this week's plan --

create temp table plan_tasks on commit drop as
  select $$[
    {"kind":"read","ref":"blind-defence","target":1,"focus":0},
    {"kind":"train","ref":"preflop/vs-open/BB","target":2,"focus":0,
     "match_mode":"preflop","match_family":"vs-open","match_position":"BB"},
    {"kind":"train","ref":"river/caller/oop","target":5,"focus":1,
     "match_mode":"river","match_spots":["btn-bb:BB","co-bb:BB"]},
    {"kind":"drill","ref":"preflop~vs-open~vs-raise~BB~BTN","target":1,"focus":0,
     "spot_keys":["preflop|vs-open|fffrf|BB|fold|call"]},
    {"kind":"review","ref":"00000000-0000-0000-0000-0000000a8001","target":1,"focus":0,
     "hand_id":"00000000-0000-0000-0000-0000000a8001"}
  ]$$::jsonb as tasks,
  $$[{"id":"preflop~vs-open~vs-raise~BB~BTN","evLossBb":0.8},{"id":"river~caller-oop-first~first~*~-","evLossBb":4}]$$::jsonb as focus;
grant select on plan_tasks to authenticated;

select is(
  (select public.save_study_plan(w.this_week, 'leaks', 'analysis/3', p.focus, '{"hands":2}', p.tasks) - 'id' - 'weekStart'
   from weeks w, plan_tasks p),
  '{"created":true,"tasks":5,"kept":0,"removed":0}'::jsonb,
  'A writes this week''s plan: five tasks');
select is(
  (select string_agg(format('%s:%s:%s/%s:%s', t ->> 'kind', t ->> 'ref', t ->> 'progress', t ->> 'target', t ->> 'done'), ','
                     order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t),
  'read:blind-defence:0/1:false,train:preflop/vs-open/BB:0/2:false,train:river/caller/oop:0/5:false,'
  'drill:preflop~vs-open~vs-raise~BB~BTN:1/1:true,review:00000000-0000-0000-0000-0000000a8001:0/1:false',
  'read back in order; the drill answered this week already counts');
select is(
  (select format('%s:%s:%s', p ->> 'kind', jsonb_array_length(p -> 'focus'), p -> 'baseline' ->> 'hands')
   from weeks w, public.study_plan(w.this_week) p),
  'leaks:2:2', '... with its kind, focus snapshot and baseline');

-- Trainer answers: two match the preflop task, one is another family, one
-- matches the river task (line and seat), one is the right line from the other seat.
select is(public.record_trainer_results($$[
  {"mode":"preflop","family":"vs-open","spot":"fffrf","position":"BB","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100},
  {"mode":"preflop","family":"vs-open","spot":"ffrff","position":"BB","grade":"mistake","ev_loss_bb":1,"ev_loss_pot":0.1,"score":50},
  {"mode":"preflop","family":"rfi","spot":"fff","position":"BTN","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100},
  {"mode":"river","family":"srp","spot":"btn-bb","position":"BB","grade":"good","ev_loss_bb":0.1,"ev_loss_pot":0.01,"score":90},
  {"mode":"river","family":"srp","spot":"btn-bb","position":"BTN","grade":"good","ev_loss_bb":0.1,"ev_loss_pot":0.01,"score":90}
]$$::jsonb), '{"inserted":5}'::jsonb, 'five trainer answers');
select is(
  (select string_agg(format('%s:%s/%s:%s', t ->> 'ref', t ->> 'counted', t ->> 'target', t ->> 'done'), ','
                     order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t where t ->> 'kind' = 'train'),
  'preflop/vs-open/BB:2/2:true,river/caller/oop:1/5:false',
  'trainer answers count when mode, family, seat (and river line and seat) match');

-- Ticks.
create temp table a_tasks on commit drop as
  select (t ->> 'id')::uuid as id, t ->> 'kind' as kind, t ->> 'ref' as ref
  from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t;
grant select on a_tasks to authenticated;

select ok(
  (select public.set_study_task(id, true) ->> 'doneAt' is not null from a_tasks where kind = 'read'),
  'A ticks the concept as read');
select ok(
  (select public.set_study_task(id, true) ->> 'doneAt' is not null from a_tasks where ref = 'river/caller/oop'),
  '... and the river task by hand');
select is(
  (select string_agg(format('%s:%s/%s:%s', t ->> 'kind', t ->> 'progress', t ->> 'target', t ->> 'done'), ','
                     order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t),
  'read:1/1:true,train:2/2:true,train:5/5:true,drill:1/1:true,review:0/1:false',
  'a tick completes a task whatever it counts');
select ok(
  (select public.set_study_task(id, false) ->> 'doneAt' is null from a_tasks where ref = 'river/caller/oop'),
  'a tick can be taken back');
select throws_ok($$select public.set_study_task('00000000-0000-0000-0000-00000000dead', true)$$,
  'P0002', 'No such task.', 'a task that does not exist: "No such task."');

-- ------------------------------------------------------------ validation --

select throws_ok(
  $$select public.save_study_plan((select this_week + 2 from weeks), 'leaks', 'analysis/3', '[]', '{}', '[]')$$,
  '22023', null, 'a week that is not a Monday is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week - 14 from weeks), 'leaks', 'analysis/3', '[]', '{}', '[]')$$,
  '22023', null, 'a week two weeks back is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'nonsense', 'analysis/3', '[]', '{}', '[]')$$,
  '22023', null, 'an unknown plan kind is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[{},{},{},{}]', '{}', '[]')$$,
  '22023', null, 'more than three focus areas are refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"read","ref":"Not A Concept!","target":1}]')$$,
  '22023', null, 'a malformed concept reference is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"read","ref":"pot-odds","target":1},{"kind":"read","ref":"pot-odds","target":1}]')$$,
  '22023', null, 'the same task twice is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"read","ref":"pot-odds","target":1,"focus":0}]')$$,
  '22023', null, 'a task naming a focus area the plan does not have is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"train","ref":"preflop/rfi","target":500,"match_mode":"preflop"}]')$$,
  '22023', null, 'a target out of range is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"drill","ref":"all","target":1,"spot_keys":["not a key"]}]')$$,
  '22023', null, 'a malformed spot key is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"read","ref":"pot-odds","target":1,"match_mode":"preflop"}]')$$,
  '22023', null, 'a trainer filter on a task that is not a trainer task is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      (select jsonb_agg(jsonb_build_object('kind', 'read', 'ref', 'c' || n, 'target', 1)) from generate_series(1, 41) n))$$,
  '53400', null, 'at most 40 tasks');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/3', '[]', '{}',
      '[{"kind":"review","ref":"00000000-0000-0000-0000-0000000a8b01","target":1,"hand_id":"00000000-0000-0000-0000-0000000a8b01"}]')$$,
  'P0002', 'No such hand.', 'a hand to review must be one of the caller''s own');
select is(
  (select jsonb_array_length(public.study_plan(w.this_week) -> 'tasks') from weeks w), 5,
  'a refused plan wrote nothing: this week still has its five tasks');

-- ----------------------------------------------------------- the rollover --

select is(
  (select public.save_study_plan(w.last_week, 'leaks', 'analysis/3', p.focus, '{}', $$[
     {"kind":"read","ref":"blind-defence","target":1,"focus":0},
     {"kind":"train","ref":"preflop/vs-open/BB","target":2,"focus":0,
      "match_mode":"preflop","match_family":"vs-open","match_position":"BB"},
     {"kind":"review","ref":"00000000-0000-0000-0000-0000000a8002","target":1,"focus":0,
      "hand_id":"00000000-0000-0000-0000-0000000a8002"}]$$) ->> 'created'
   from weeks w, plan_tasks p),
  'true', 'last week''s plan is its own row');
select is(
  (select string_agg(format('%s:%s/%s:%s', t ->> 'kind', t ->> 'progress', t ->> 'target', t ->> 'done'), ','
                     order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.last_week) -> 'tasks') t),
  'read:0/1:false,train:0/2:false,review:0/1:false',
  'this week''s answers and ticks do not count towards last week');
select is((select count(*)::int from public.study_plans), 2, 'A has two plans, one per week');

-- Rebuilding this week: two tasks kept (with their ticks), three gone, one new.
select is(
  (select public.save_study_plan(w.this_week, 'leaks', 'analysis/3', p.focus, '{}', $$[
     {"kind":"read","ref":"blind-defence","target":1,"focus":0},
     {"kind":"train","ref":"preflop/vs-open/BB","target":3,"focus":0,
      "match_mode":"preflop","match_family":"vs-open","match_position":"BB"},
     {"kind":"read","ref":"pot-odds","target":1,"focus":1}]$$) - 'id' - 'weekStart'
   from weeks w, plan_tasks p),
  '{"created":false,"tasks":3,"kept":2,"removed":3}'::jsonb,
  'rebuilding the week updates the plan in place');
select is(
  (select string_agg(format('%s:%s:%s/%s:%s', t ->> 'kind', t ->> 'ref', t ->> 'progress', t ->> 'target', t ->> 'done'), ','
                     order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t),
  'read:blind-defence:1/1:true,train:preflop/vs-open/BB:2/3:false,read:pot-odds:0/1:false',
  '... the kept read keeps its tick, the kept trainer task its new target');
select is(
  (select jsonb_array_length(public.study_plan(w.last_week) -> 'tasks') from weeks w), 3,
  '... and last week''s plan is untouched');
select ok(
  (select public.save_study_plan(w.next_week, 'fundamentals', 'analysis/3', '[]', '{}',
     '[{"kind":"read","ref":"position","target":1}]') ->> 'created' = 'true' from weeks w),
  'next week''s plan can be written ahead (a reader east of UTC)');
select is(
  (select public.study_plan(w.this_week - 14) from weeks w), null,
  'a week with no plan reads as null');

-- An old week is history: its tasks cannot be ticked any more.
reset role;
insert into public.study_plans (id, owner_id, week_start, kind, analysis_version)
  select '00000000-0000-0000-0000-0000000a8f01', '00000000-0000-0000-0000-0000000a8aa1', this_week - 21, 'leaks', 'analysis/3'
  from weeks;
insert into public.study_tasks (id, plan_id, owner_id, ord, kind, ref, target)
  values ('00000000-0000-0000-0000-0000000a8f02', '00000000-0000-0000-0000-0000000a8f01',
          '00000000-0000-0000-0000-0000000a8aa1', 0, 'read', 'spr', 1);
select pg_temp.act_as('00000000-0000-0000-0000-0000000a8aa1');
select throws_ok($$select public.set_study_task('00000000-0000-0000-0000-0000000a8f02', true)$$,
  '22023', null, 'a task of a week long over cannot be ticked');

-- ------------------------------------------------------- direct writes --

select throws_ok(
  $$insert into public.study_plans (owner_id, week_start, kind, analysis_version)
    values ('00000000-0000-0000-0000-0000000a8aa1', (select next_week + 7 from weeks), 'leaks', 'analysis/3')$$,
  '42501', null, 'the owner cannot insert a plan directly');
select throws_ok($$update public.study_tasks set done_at = now()$$,
  '42501', null, '... nor tick a task directly');
select throws_ok($$delete from public.study_plans$$,
  '42501', null, '... nor delete a plan');

-- ------------------------------------------------------------ isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a8bb1');
select is((select count(*)::int from public.study_plans) + (select count(*)::int from public.study_tasks), 0,
  'B sees none of A''s plans or tasks');
select is((select public.study_plan(w.this_week) from weeks w), null, '... and has no plan this week');
select throws_ok($$select public.set_study_task((select id from a_tasks where kind = 'review' limit 1), true)$$,
  'P0002', 'No such task.', 'A''s task, ticked by B: "No such task.", as for one that does not exist');
select ok(
  (select public.save_study_plan(w.this_week, 'fundamentals', 'analysis/3', '[]', '{}',
     '[{"kind":"read","ref":"position","target":1}]') ->> 'created' = 'true' from weeks w),
  'B writes B''s own plan for the same week');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a8aa1');
select is(
  (select string_agg(t ->> 'ref', ',' order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t),
  'blind-defence,preflop/vs-open/BB,pot-odds', 'A''s plan for the week is still A''s');

-- ---------------------------------------------------------------- anon --

select pg_temp.act_as_anon();
select throws_ok($$select count(*) from public.study_plans$$, '42501', null, 'anon cannot read plans');
select throws_ok($$select public.study_plan(public.study_week())$$, '42501', null, '... nor call the reader');

select * from finish();
rollback;
