-- pgTAP: the admin screens' functions (`20271119100000_admin.sql`) and the
-- feedback table (`20271119090000_feedback.sql`).
--
--   * every admin function refuses a member, a moderator and anon;
--   * an admin sees every account with its counts, searches and sorts them,
--     reads one account's page, lists and filters the reports and sets their
--     status;
--   * the feedback table is closed to clients; the bucket is private and its
--     objects are readable by an admin only.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(22);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000ad01', 'admin.ann@example.com', now(), now() - interval '10 days'),
  ('00000000-0000-0000-0000-00000000ad02', 'member.max@example.com', now(), now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000ad03', 'mod.mia@example.com', now(), now() - interval '1 day');
update public.profiles set username = 'adm_ann', role = 'admin' where id = '00000000-0000-0000-0000-00000000ad01';
update public.profiles set username = 'adm_max' where id = '00000000-0000-0000-0000-00000000ad02';
update public.profiles set username = 'adm_mia', role = 'moderator' where id = '00000000-0000-0000-0000-00000000ad03';

insert into public.feedback (id, kind, message, source, user_id, images) values
  ('00000000-0000-0000-0000-0000000fee01', 'bug', 'Max: replayer froze', 'web', '00000000-0000-0000-0000-00000000ad02',
   '{00000000-0000-0000-0000-00000000ad02/x/1.png}'),
  ('00000000-0000-0000-0000-0000000fee02', 'feature', 'A visitor wants CSV', 'app', null, '{}'),
  ('00000000-0000-0000-0000-0000000fee03', 'question', 'Max asks about plans', 'web', '00000000-0000-0000-0000-00000000ad02', '{}');

insert into storage.objects (bucket_id, name) values ('feedback', '00000000-0000-0000-0000-00000000ad02/x/1.png');

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
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

-- ---------------------------------------------------------------------------
-- Refused: a member, a moderator, anon
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000ad02');
select throws_ok($$select * from public.admin_users()$$, '42501', null, 'a member cannot list accounts');
select throws_ok($$select public.admin_user('00000000-0000-0000-0000-00000000ad02')$$, '42501', null, '... nor read one');
select throws_ok($$select * from public.admin_feedback()$$, '42501', null, '... nor list the reports');
select throws_ok($$select public.admin_feedback_counts()$$, '42501', null, '... nor count them');
select throws_ok($$select public.admin_feedback_set_status('00000000-0000-0000-0000-0000000fee01', 'done')$$, '42501', null,
  '... nor set a status');
select is((select count(*) from storage.objects where bucket_id = 'feedback'), 0::bigint, '... nor see a screenshot');
select throws_ok($$select count(*) from public.feedback$$, '42501', null, 'the feedback table is closed to clients');

select pg_temp.act_as('00000000-0000-0000-0000-00000000ad03');
select throws_ok($$select * from public.admin_users()$$, '42501', null, 'a moderator is no admin');

select pg_temp.act_as_anon();
select throws_ok($$select * from public.admin_users()$$, '42501', null, 'anon cannot call them at all');

-- ---------------------------------------------------------------------------
-- An admin
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000ad01');

select ok((select count(*) from public.admin_users(null, 'created', true, 200, 0)
           where email in ('admin.ann@example.com', 'member.max@example.com', 'mod.mia@example.com')) = 3,
  'an admin lists every account');
select is((select feedback from public.admin_users('member.max', 'created', true, 50, 0)), 2::bigint,
  '... searched by email, with its report count');
select is((select username from public.admin_users('adm_mia', 'created', true, 50, 0)), 'adm_mia', '... or by username');
select is((select total from public.admin_users('adm_', 'created', true, 1, 0)), 3::bigint,
  '... a page at a time, with the total');
select is((select array_agg(username order by 1) from public.admin_users('adm_', 'username', false, 2, 0)),
  array['adm_ann', 'adm_max'], '... sorted by username');

select is(public.admin_user('00000000-0000-0000-0000-00000000ad02') ->> 'email', 'member.max@example.com',
  'one account''s page');
select is(jsonb_array_length(public.admin_user('00000000-0000-0000-0000-00000000ad02') -> 'feedback'), 2,
  '... with its reports');
select is(public.admin_user('00000000-0000-0000-0000-0000000000ff'), null, '... null for no such account');

select is((select count(*) from public.admin_feedback(null, null, null, 200, 0) where id in ('00000000-0000-0000-0000-0000000fee01', '00000000-0000-0000-0000-0000000fee02', '00000000-0000-0000-0000-0000000fee03')), 3::bigint,
  'the reports, every one');
select is((select array_agg(message) from public.admin_feedback(null, 'feature', null, 200, 0) where id in ('00000000-0000-0000-0000-0000000fee01', '00000000-0000-0000-0000-0000000fee02', '00000000-0000-0000-0000-0000000fee03')),
  array['A visitor wants CSV'],
  '... filtered by kind');

select lives_ok($$select public.admin_feedback_set_status('00000000-0000-0000-0000-0000000fee01', 'done')$$,
  'an admin sets a status');
select is((select status from public.admin_feedback(null, null, '00000000-0000-0000-0000-00000000ad02', 50, 0)
           where id = '00000000-0000-0000-0000-0000000fee01'), 'done', '... and it sticks');

select is((select count(*) from storage.objects where bucket_id = 'feedback'
             and name = '00000000-0000-0000-0000-00000000ad02/x/1.png'), 1::bigint,
  'an admin reads the screenshots');

select * from finish();
rollback;
