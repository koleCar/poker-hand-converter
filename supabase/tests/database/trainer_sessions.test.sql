-- pgTAP: the Trainer's sessions -- `20271116090000_trainer_sessions.sql`.
--
-- What has to hold:
--
--   * no client INSERT / UPDATE / DELETE on either table, RLS on, nothing
--     for `anon`;
--   * the writers are `security definer` with an empty search_path and the
--     entitlement gate, the reader `security invoker` with the gate; all
--     three executable by `authenticated`, not by `anon`, and listed in
--     `entitlement_gates` (analysis);
--   * a session is saved, renamed and archived by its owner, and another
--     account's session id is refused;
--   * answers go only into the caller's own session, checked by the table;
--   * the list counts each session's answers, and B sees none of A's;
--   * both tables are in the account's data inventory, deleted with it.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(21);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000005e5a1', 'sessions.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000005e5b1', 'sessions.b@example.com', now(), now());

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
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('trainer_sessions', 'trainer_session_answers')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0, 'no client INSERT, UPDATE or DELETE on the session tables');
select ok(
  (select bool_and(relrowsecurity) from pg_class
   where oid in ('public.trainer_sessions'::regclass, 'public.trainer_session_answers'::regclass)),
  'RLS is on for both');
select ok(
  not has_table_privilege('anon', 'public.trainer_sessions', 'select')
  and not has_table_privilege('anon', 'public.trainer_session_answers', 'select'),
  'anon cannot read them');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
   where p.oid in ('public.save_trainer_session(uuid,text,jsonb,boolean)'::regprocedure,
                   'public.record_trainer_session_answers(uuid,jsonb)'::regprocedure)),
  'the writers are security definer with an empty search_path');
select ok(
  (select not p.prosecdef from pg_proc p where p.oid = 'public.trainer_session_list(timestamp with time zone)'::regprocedure),
  'the list is security invoker');
select ok(
  position('public.require_entitlement(' in pg_get_functiondef('public.save_trainer_session(uuid,text,jsonb,boolean)'::regprocedure)) > 0
  and position('public.require_entitlement(' in pg_get_functiondef('public.record_trainer_session_answers(uuid,jsonb)'::regprocedure)) > 0
  and position('public.require_entitlement(' in pg_get_functiondef('public.trainer_session_list(timestamp with time zone)'::regprocedure)) > 0,
  'all three carry the entitlement gate');
select is(
  (select array_agg(function_sig || ':' || feature order by function_sig) from public.entitlement_gates
   where function_sig in ('public.save_trainer_session(uuid,text,jsonb,boolean)',
                          'public.record_trainer_session_answers(uuid,jsonb)',
                          'public.trainer_session_list(timestamp with time zone)')),
  array['public.record_trainer_session_answers(uuid,jsonb):analysis',
        'public.save_trainer_session(uuid,text,jsonb,boolean):analysis',
        'public.trainer_session_list(timestamp with time zone):analysis'],
  '... and are listed in entitlement_gates (analysis)');
select ok(
  has_function_privilege('authenticated', 'public.save_trainer_session(uuid,text,jsonb,boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.record_trainer_session_answers(uuid,jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.trainer_session_list(timestamp with time zone)', 'execute')
  and not has_function_privilege('anon', 'public.save_trainer_session(uuid,text,jsonb,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.record_trainer_session_answers(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.trainer_session_list(timestamp with time zone)', 'execute'),
  'executable by authenticated, not anon');
select is(
  (select array_agg(format('%s:%s:%s', name, export_file, on_delete) order by name) from public.account_data_inventory
   where name in ('public.trainer_sessions', 'public.trainer_session_answers')),
  array['public.trainer_session_answers:learning/trainer_session_answers.ndjson:cascade',
        'public.trainer_sessions:learning/trainer_sessions.ndjson:cascade'],
  'both tables are in the account''s data inventory, exported and deleted with the account');

-- ------------------------------------------------------------- a session --

select pg_temp.act_as('00000000-0000-0000-0000-00000005e5a1');

select is(
  public.save_trainer_session('aaaaaaaa-0000-4000-8000-000000000001', '  BB defence vs BTN open ',
                              '{"mode":"preflop","family":"vs-open","seat":"BB","vs":"BTN"}'::jsonb, false),
  '{"id":"aaaaaaaa-0000-4000-8000-000000000001"}'::jsonb, 'A saves a session');
select is(
  (select format('%s|%s|%s', owner_id, name, settings ->> 'seat') from public.trainer_sessions),
  '00000000-0000-0000-0000-00000005e5a1|BB defence vs BTN open|BB', '... as A''s own, the name trimmed');
select throws_ok(
  $$select public.save_trainer_session('aaaaaaaa-0000-4000-8000-000000000002', 'x', '{"mode":1}'::jsonb, false)$$,
  '22023', null, 'settings must be strings');

select is(public.record_trainer_session_answers('aaaaaaaa-0000-4000-8000-000000000001', $$[
  {"street":"preflop","cards":"Kd9c","spot_key":"preflop|6max-100bb|r|BB|9cKd","position":"BB","hand_class":"K9o",
   "move":"Call","best":"Call","grade":"perfect","ev_loss_bb":0,"score":100,
   "spot_ref":{"request":{"kind":"preflop","options":{"family":"vs-open"}},"seed":42}},
  {"street":"preflop","cards":"Jh4h","spot_key":"preflop|6max-100bb|r|BB|4hJh","position":"BB","hand_class":"J4s",
   "move":"3-bet 11","best":"Call","grade":"mistake","ev_loss_bb":0.34,"score":40,"spot_ref":null}
]$$::jsonb), '{"inserted":2}'::jsonb, 'A records two answers in it');
select throws_ok(
  $$select public.record_trainer_session_answers('aaaaaaaa-0000-4000-8000-000000000001',
    '[{"street":"preflop","cards":"K9","spot_key":"k","move":"Call","grade":"good","ev_loss_bb":0,"score":90}]')$$,
  '23514', null, 'an answer the table''s checks refuse fails the call');
select throws_ok(
  $$insert into public.trainer_session_answers (session_id, owner_id, street, cards, spot_key, move, grade, ev_loss_bb, score)
    values ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-00000005e5a1', 'preflop', 'Kd9c', 'k', 'Call', 'good', 0, 90)$$,
  '42501', null, 'a client cannot insert an answer directly');

select is(
  (select format('%s:%s:%s:%s:%s', s ->> 'name', s ->> 'hands', s ->> 'score_sum', s -> 'counts' ->> 'mistake', s ->> 'archived')
   from jsonb_array_elements(public.trainer_session_list()) s),
  'BB defence vs BTN open:2:140.00:1:false', 'the list counts the session''s answers');

select public.save_trainer_session('aaaaaaaa-0000-4000-8000-000000000001', 'Renamed', null, true);
select is(
  (select format('%s:%s:%s', name, archived::text, settings ->> 'vs') from public.trainer_sessions),
  'Renamed:true:BTN', 'A renames and archives it; the settings stay');

-- ------------------------------------------------------------- another account --

select pg_temp.act_as('00000000-0000-0000-0000-00000005e5b1');
select is((select count(*)::int from public.trainer_sessions) + (select count(*)::int from public.trainer_session_answers), 0,
  'B sees none of A''s sessions or answers');
select throws_ok(
  $$select public.save_trainer_session('aaaaaaaa-0000-4000-8000-000000000001', 'Taken', '{}'::jsonb, false)$$,
  '42501', null, 'B cannot take over A''s session id');
select throws_ok(
  $$select public.record_trainer_session_answers('aaaaaaaa-0000-4000-8000-000000000001',
    '[{"street":"preflop","cards":"Kd9c","spot_key":"k","move":"Call","grade":"good","ev_loss_bb":0,"score":90}]')$$,
  '42501', null, 'B cannot record answers in A''s session');

select pg_temp.act_as_anon();
select throws_ok(
  $$select public.save_trainer_session('aaaaaaaa-0000-4000-8000-000000000009', 'Anon', '{}'::jsonb, false)$$,
  '42501', null, 'anon cannot save a session');

select * from finish();
rollback;
