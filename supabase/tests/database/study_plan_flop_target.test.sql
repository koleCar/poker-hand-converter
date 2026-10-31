-- pgTAP: the study plan's flop trainer task -- `20271031090000_study_plan_flop_target.sql`.
--
-- What has to hold:
--
--   * `study_tasks.match_mode` takes `flop` beside `preflop` and `river`, and
--     still refuses anything else;
--   * the security model is unchanged: no client INSERT / UPDATE / DELETE on
--     the plan's tables, RLS on, `save_study_plan` `security definer` with an
--     empty search_path and its entitlement gate, executable by
--     `authenticated` and not by `anon`;
--   * a flop trainer task (`flop/<set>/<pot>/<side>/<role>/<seat>/<facing>[/<line>]`)
--     is accepted, a malformed one refused, and the old references still pass;
--   * the task counts the caller's flop answers this week by line and seat
--     (`<line id>:<seat>`), not a river answer on the same line, not another
--     seat, not another account's.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(16);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000f9aa1', 'plan.flop.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000f9bb1', 'plan.flop.b@example.com', now(), now());

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

create temp table weeks on commit drop as select public.study_week() as this_week;
grant select on weeks to authenticated;

-- ---------------------------------------------------------------- schema --

select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
   where c.conrelid = 'public.study_tasks'::regclass and c.conname = 'study_tasks_match_mode_check'),
  'CHECK ((match_mode = ANY (ARRAY[''preflop''::text, ''flop''::text, ''river''::text])))',
  'the match mode check takes flop beside preflop and river');
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
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.save_study_plan(date, text, text, jsonb, jsonb, jsonb)'::regprocedure),
  'save_study_plan is still security definer with an empty search_path');
select ok(
  position('public.require_entitlement(' in
           pg_get_functiondef('public.save_study_plan(date, text, text, jsonb, jsonb, jsonb)'::regprocedure)) > 0,
  '... and has its entitlement gate back');
select ok(
  has_function_privilege('authenticated', 'public.save_study_plan(date, text, text, jsonb, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.save_study_plan(date, text, text, jsonb, jsonb, jsonb)', 'execute'),
  'executable by authenticated, not anon');

-- ------------------------------------------------------------- the plan --

select pg_temp.act_as('00000000-0000-0000-0000-0000000f9aa1');

create temp table plan_tasks on commit drop as
  select $$[
    {"kind":"train","ref":"flop/nlhe-cash-6max-100bb/any/oop/caller/BB/bet","target":15,"focus":0,
     "match_mode":"flop","match_family":"srp","match_position":"BB",
     "match_spots":["btn-bb:BB","co-bb:BB","hj-bb:BB","utg-bb:BB"]},
    {"kind":"train","ref":"flop/nlhe-cash-hu-100bb/limped/oop/any/BB/any/sb-limp","target":15,"focus":0,
     "match_mode":"flop","match_family":"limped","match_position":"BB","match_spots":["sb-limp:BB"]},
    {"kind":"train","ref":"preflop/vs-open/BB","target":20,"focus":0,
     "match_mode":"preflop","match_family":"vs-open","match_position":"BB"},
    {"kind":"train","ref":"river/any/oop/caller","target":10,"focus":0,
     "match_mode":"river","match_spots":["btn-bb:BB"]}
  ]$$::jsonb as tasks,
  $$[{"id":"flop~caller-oop-vs-bet~vs-bet~BB~-","evLossBb":3}]$$::jsonb as focus;
grant select on plan_tasks to authenticated;

select is(
  (select public.save_study_plan(w.this_week, 'leaks', 'analysis/37', p.focus, '{}', p.tasks) - 'id' - 'weekStart'
   from weeks w, plan_tasks p),
  '{"created":true,"tasks":4,"kept":0,"removed":0}'::jsonb,
  'a plan with two flop trainer tasks beside a preflop and a river one is written');
select is(
  (select string_agg(format('%s:%s', t ->> 'matchMode', t ->> 'ref'), ',' order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t),
  'flop:flop/nlhe-cash-6max-100bb/any/oop/caller/BB/bet,flop:flop/nlhe-cash-hu-100bb/limped/oop/any/BB/any/sb-limp,'
  'preflop:preflop/vs-open/BB,river:river/any/oop/caller',
  '... and read back with their trainers');

-- Answers: two flop answers on the BB's single-raised lines, one on the
-- button's side of one, one river answer on the same line and seat, one
-- heads-up limped pot from the big blind.
select is(public.record_trainer_results($$[
  {"mode":"flop","family":"srp","spot":"btn-bb","position":"BB","grade":"good","ev_loss_bb":0.1,"ev_loss_pot":0.01,"score":90},
  {"mode":"flop","family":"srp","spot":"co-bb","position":"BB","grade":"mistake","ev_loss_bb":1,"ev_loss_pot":0.1,"score":50},
  {"mode":"flop","family":"srp","spot":"btn-bb","position":"BTN","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100},
  {"mode":"river","family":"srp","spot":"btn-bb","position":"BB","grade":"good","ev_loss_bb":0.1,"ev_loss_pot":0.01,"score":90},
  {"mode":"flop","family":"limped","spot":"sb-limp","position":"BB","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100}
]$$::jsonb), '{"inserted":5}'::jsonb, 'five trainer answers');
select is(
  (select string_agg(format('%s/%s', t ->> 'counted', t ->> 'target'), ',' order by (t ->> 'ord')::int)
   from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t),
  '2/15,1/15,0/20,1/10',
  'a flop task counts flop answers on its lines from its seat; the river task only the river answer');

-- B's flop answers never count towards A's plan.
select pg_temp.act_as('00000000-0000-0000-0000-0000000f9bb1');
select is(public.record_trainer_results($$[
  {"mode":"flop","family":"srp","spot":"btn-bb","position":"BB","grade":"good","ev_loss_bb":0.1,"ev_loss_pot":0.01,"score":90}
]$$::jsonb), '{"inserted":1}'::jsonb, 'B answers a flop on the same line and seat');
select pg_temp.act_as('00000000-0000-0000-0000-0000000f9aa1');
select is(
  (select t ->> 'counted' from weeks w, jsonb_array_elements(public.study_plan(w.this_week) -> 'tasks') t
   where t ->> 'ord' = '0'),
  '2', '... and A''s flop task still counts two');

-- ------------------------------------------------------------ refusals --

select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/37', '[]', '{}',
    '[{"kind":"train","ref":"flop/nlhe-cash-6max-100bb/any/oop","target":15,"focus":null,"match_mode":"flop"}]')$$,
  '22023', null, 'a flop reference without its parts is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/37', '[]', '{}',
    '[{"kind":"train","ref":"flop/nlhe-cash-6max-100bb/any/oop/caller/BB/bet","target":15,"focus":null,"match_mode":"turn"}]')$$,
  '22023', null, 'a trainer the plan does not count is refused');
select throws_ok(
  $$select public.save_study_plan((select this_week from weeks), 'leaks', 'analysis/37', '[]', '{}',
    '[{"kind":"train","ref":"flop/nlhe-cash-6max-100bb/any/oop/caller/BB/bet","target":15,"focus":null,
       "match_mode":"flop","match_spots":["btn bb:BB"]}]')$$,
  '22023', null, 'a malformed flop spot is refused');

select pg_temp.act_as_anon();
select throws_ok(
  $$select public.save_study_plan('2026-01-05'::date, 'leaks', 'analysis/37', '[]', '{}', '[]')$$,
  '42501', null, 'anon cannot write a plan');

select * from finish();
rollback;
