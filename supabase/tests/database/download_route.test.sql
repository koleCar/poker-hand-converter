-- pgTAP: `/download` (the desktop app page, `20271103100000_download_route.sql`)
-- is a reserved username, like every top-level route.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(2);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000066d1', 'download.route@example.com', now() - interval '40 days', now() - interval '40 days');

select is((select username_lower || ':' || reason || ':' || coalesce(reserved_for::text, 'nobody')
             from public.username_reservations where username_lower = 'download'),
  'download:route:nobody', '/download is reserved for nobody');

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000066d1', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$ select public.set_username('Download') $$, '22023', 'That username is not available.', 'nobody can take "download", in any case');

select * from finish();
rollback;
