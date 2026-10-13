-- pgTAP: Rail R1.7, the desktop sign-in budget -- `20270421090000_desktop_sign_in.sql`.
--
-- What has to hold:
--
--   * `claim_desktop_sign_in()` is security definer with an empty search_path,
--     executable by `authenticated` and by neither `anon` nor `public`;
--   * an anonymous caller is refused with 42501 even if it reached the body;
--   * ten claims an hour per account, the eleventh raises 53400;
--   * the bucket is the caller's own: one account's spent budget does not
--     touch another's, and the counter rows are keyed by auth.uid();
--   * the counter table stays unreadable to clients.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000d0a01', 'desktop.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000d0b01', 'desktop.b@example.com', now(), now());

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

-- ------------------------------------------------------------ the function --

select is(
  (select prosecdef from pg_proc where oid = 'public.claim_desktop_sign_in()'::regprocedure),
  true, 'claim_desktop_sign_in is security definer');
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.claim_desktop_sign_in()'::regprocedure),
  'claim_desktop_sign_in has an empty search_path');
select ok(has_function_privilege('authenticated', 'public.claim_desktop_sign_in()', 'execute'),
  'authenticated may call it');
select ok(not has_function_privilege('anon', 'public.claim_desktop_sign_in()', 'execute'),
  'anon may not call it');
select ok(not has_function_privilege('public', 'public.claim_desktop_sign_in()', 'execute'),
  'public may not call it');

-- --------------------------------------------------------------- refusals --

select pg_temp.act_as_anon();
select throws_ok($$ select public.claim_desktop_sign_in() $$, '42501', null,
  'anon is refused by the grant');

-- The body's own check: a role with execute but no auth.uid().
reset role;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$ select public.claim_desktop_sign_in() $$, '42501',
  'You must be signed in to sign in to the desktop app.',
  'no auth.uid() is refused by the function');

-- ----------------------------------------------------------------- budget --

select pg_temp.act_as('00000000-0000-0000-0000-0000000d0a01');
select lives_ok($$ select public.claim_desktop_sign_in() $$, 'the first claim passes');
select lives_ok($$ select public.claim_desktop_sign_in() from generate_series(2, 10) $$,
  'ten claims in the hour pass');
select throws_ok($$ select public.claim_desktop_sign_in() $$, '53400', null,
  'the eleventh is over budget');

select pg_temp.act_as('00000000-0000-0000-0000-0000000d0b01');
select lives_ok($$ select public.claim_desktop_sign_in() $$,
  'another account has its own budget');

select throws_ok($$ select * from public.ingest_rate_limit $$, '42501', null,
  'the counters stay unreadable to clients');

reset role;
select is(
  (select hits from public.ingest_rate_limit
   where bucket = 'desktop_sign_in:00000000-0000-0000-0000-0000000d0a01'),
  10, 'the bucket is keyed by the caller''s uid (a refused call is rolled back, not counted)');
select is(
  (select hits from public.ingest_rate_limit
   where bucket = 'desktop_sign_in:00000000-0000-0000-0000-0000000d0b01'),
  1, 'the other account''s bucket holds its one claim');

select * from finish();
rollback;
