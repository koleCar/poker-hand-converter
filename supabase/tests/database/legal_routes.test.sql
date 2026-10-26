-- pgTAP: `/terms` and `/privacy` (Rail R6.5, `20271006110000_legal_routes.sql`)
-- are reserved usernames, like every top-level route.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(3);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000066a1', 'legal.routes@example.com', now() - interval '40 days', now() - interval '40 days');

select is((select string_agg(username_lower || ':' || reason || ':' || coalesce(reserved_for::text, 'nobody'), ',' order by username_lower)
             from public.username_reservations where username_lower in ('terms', 'privacy')),
  'privacy:route:nobody,terms:route:nobody', '/terms and /privacy are reserved for nobody');

select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000066a1', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$ select public.set_username('terms') $$, '22023', 'That username is not available.', 'nobody can take "terms"');
select throws_ok($$ select public.set_username('Privacy') $$, '22023', 'That username is not available.', '... or "privacy", in any case');

select * from finish();
rollback;
