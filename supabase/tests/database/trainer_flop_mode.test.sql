-- pgTAP: the trainer's flop mode -- `20271028090000_trainer_flop_mode.sql`.
--
-- What has to hold:
--
--   * `trainer_results.mode` takes `flop` beside the three it took, and
--     still refuses anything else;
--   * the security model is unchanged: no client INSERT / UPDATE / DELETE on
--     the table, RLS on, the writer `security definer` with an empty
--     search_path and its entitlement gate, executable by `authenticated`
--     and not by `anon`;
--   * a flop answer is recorded as the caller's own, counted in the
--     caller's summary as its own mode, and never reaches another account.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000f1aa1', 'flop.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000f1bb1', 'flop.b@example.com', now(), now());

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

-- ---------------------------------------------------------------- schema --

select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
   where c.conrelid = 'public.trainer_results'::regclass and c.conname = 'trainer_results_mode_check'),
  'CHECK ((mode = ANY (ARRAY[''preflop''::text, ''flop''::text, ''river''::text, ''drill''::text])))',
  'the mode check takes flop beside preflop, river and drill');

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'trainer_results'
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0, 'no client INSERT, UPDATE or DELETE on trainer_results');
select ok((select relrowsecurity from pg_class where oid = 'public.trainer_results'::regclass), 'RLS is on');
select ok(
  not has_table_privilege('anon', 'public.trainer_results', 'select'),
  'anon cannot read trainer_results');

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.record_trainer_results(jsonb)'::regprocedure),
  'record_trainer_results is still security definer with an empty search_path');
select ok(
  position('public.require_entitlement(' in pg_get_functiondef('public.record_trainer_results(jsonb)'::regprocedure)) > 0,
  '... and keeps its entitlement gate');
select ok(
  has_function_privilege('authenticated', 'public.record_trainer_results(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.record_trainer_results(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.trainer_summary(integer)', 'execute')
  and not has_function_privilege('anon', 'public.trainer_summary(integer)', 'execute'),
  'the writer and the summary are executable by authenticated, not anon');

-- ------------------------------------------------------------- a flop answer --

select pg_temp.act_as('00000000-0000-0000-0000-0000000f1aa1');

select is(public.record_trainer_results($$[
  {"mode":"flop","family":"srp","spot":"btn-bb","position":"BB","hand_class":"KQo","grade":"good","ev_loss_bb":0.12,"ev_loss_pot":0.02,"score":88},
  {"mode":"preflop","family":"rfi","spot":"","position":"BTN","hand_class":"A5s","grade":"perfect","ev_loss_bb":0,"ev_loss_pot":0,"score":100}
]$$::jsonb), '{"inserted":2}'::jsonb, 'a flop answer is recorded beside a preflop one');
select is(
  (select format('%s:%s:%s:%s', owner_id, family, spot, position) from public.trainer_results where mode = 'flop'),
  '00000000-0000-0000-0000-0000000f1aa1:srp:btn-bb:BB', '... as the caller''s own row');
select throws_ok(
  $$select public.record_trainer_results('[{"mode":"turn","family":"srp","grade":"good","ev_loss_bb":0,"ev_loss_pot":0,"score":90}]')$$,
  '23514', null, 'a mode the check does not take still fails the call');
select throws_ok(
  $$insert into public.trainer_results (owner_id, mode, family, grade, ev_loss_bb, ev_loss_pot, score)
    values ('00000000-0000-0000-0000-0000000f1aa1', 'flop', 'srp', 'perfect', 0, 0, 100)$$,
  '42501', null, 'a client cannot insert a flop row directly');
select is(
  (select string_agg(format('%s:%s:%s', m ->> 'mode', m ->> 'answers', m ->> 'good'), ',')
   from jsonb_array_elements(public.trainer_summary(30) -> 'modes') m),
  'flop:1:1,preflop:1:0', 'the summary counts flop as its own mode');

select pg_temp.act_as('00000000-0000-0000-0000-0000000f1bb1');
select is((select count(*)::int from public.trainer_results), 0, 'B sees none of A''s flop answers');

select pg_temp.act_as_anon();
select throws_ok(
  $$select public.record_trainer_results('[{"mode":"flop","family":"srp","grade":"good","ev_loss_bb":0,"ev_loss_pot":0,"score":90}]')$$,
  '42501', null, 'anon cannot record a flop answer');

select * from finish();
rollback;
