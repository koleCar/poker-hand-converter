-- pgTAP: `/pricing` (Free against Pro, `20271119170000_pricing_route.sql`)
-- is a reserved username, like every top-level route.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(2);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000066e1', 'pricing.route@example.com', now() - interval '40 days', now() - interval '40 days');

select is((select username_lower || ':' || reason || ':' || coalesce(reserved_for::text, 'nobody')
             from public.username_reservations where username_lower = 'pricing'),
  'pricing:route:nobody', '/pricing is reserved for nobody');

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000066e1', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$ select public.set_username('Pricing') $$, '22023', 'That username is not available.', 'nobody can take "pricing", in any case');

select * from finish();
rollback;
