-- pgTAP: the Pro waitlist (`20271119210000_pro_waitlist.sql`).
--
--   * the table is closed to clients; anon and members join through the RPC;
--   * the address is checked and stored lower case, once (re-joining is fine);
--   * "already on the list" only for the caller's own address or row, never
--     for a visitor;
--   * the rate limit: 10 an hour per account;
--   * admins list it, nobody else does;
--   * the account's rows (and any row with its email) go with the account,
--     and are in its data download.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(26);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000a701', 'wl.admin@example.com', now(), now() - interval '10 days'),
  ('00000000-0000-0000-0000-00000000a702', 'wl.member@example.com', now(), now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000a703', 'wl.other@example.com', now(), now() - interval '1 day');
update public.profiles set username = 'wl_admin', role = 'admin' where id = '00000000-0000-0000-0000-00000000a701';
update public.profiles set username = 'wl_member' where id = '00000000-0000-0000-0000-00000000a702';

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
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.as_postgres() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Closed table
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('anon', 'public.pro_waitlist', 'select')
  and not has_table_privilege('anon', 'public.pro_waitlist', 'insert')
  and not has_table_privilege('authenticated', 'public.pro_waitlist', 'select')
  and not has_table_privilege('authenticated', 'public.pro_waitlist', 'insert')
  and not has_table_privilege('authenticated', 'public.pro_waitlist', 'delete'),
  'the table is closed to clients');
select ok(
  has_function_privilege('anon', 'public.join_pro_waitlist(text, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.join_pro_waitlist(text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.my_pro_waitlist()', 'execute')
  and not has_function_privilege('anon', 'public.admin_pro_waitlist(integer, integer)', 'execute'),
  'anon and members may join; only members ask about themselves; anon never lists');

-- ---------------------------------------------------------------------------
-- A visitor joins
-- ---------------------------------------------------------------------------

select pg_temp.act_as_anon();
select is(public.join_pro_waitlist('  Visitor@Example.COM ', 'pricing', 'hr-HR'), '{"ok": true, "already": false}'::jsonb,
  'a visitor joins');
select is(public.join_pro_waitlist('visitor@example.com', 'pricing', 'en'), '{"ok": true, "already": false}'::jsonb,
  'again: fine, and a visitor is never told it was already there');
select throws_ok($$ select public.join_pro_waitlist('not-an-email', 'pricing', 'en') $$, '22023', 'invalid_email',
  'an address is checked');
select throws_ok($$ select public.join_pro_waitlist('a b@example.com', 'pricing', 'en') $$, '22023', 'invalid_email',
  'no spaces');
select throws_ok($$ select public.join_pro_waitlist(null, 'pricing', 'en') $$, '22023', 'invalid_email',
  'no address');
select throws_ok($$ select public.join_pro_waitlist('ok@example.com', 'elsewhere', 'en') $$, '22023', 'invalid_source',
  'the source is one of pricing, settings, app');
select throws_ok($$ select * from public.pro_waitlist $$, '42501', null, 'a visitor cannot read the table');

select pg_temp.as_postgres();
select is((select email::text || ':' || locale || ':' || source || ':' || coalesce(user_id::text, 'none')
             from public.pro_waitlist where email = 'VISITOR@example.com'),
  'visitor@example.com:hr:pricing:none', 'stored once, lower case, Croatian, no account');
select is((select count(*)::int from public.pro_waitlist), 1, 'one row');

-- ---------------------------------------------------------------------------
-- A member joins
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000a702');
select is(public.my_pro_waitlist(), '{"joined": false, "email": null}'::jsonb, 'not on the list yet');
select is(public.join_pro_waitlist('wl.member@example.com', 'settings', 'en') ->> 'already', 'false', 'a member joins');
select is(public.my_pro_waitlist(), '{"joined": true, "email": "wl.member@example.com"}'::jsonb, '... and is on it');
select is(public.join_pro_waitlist('WL.Member@example.com', 'pricing', 'en') ->> 'already', 'true',
  'their own address again: already on the list');
select is(public.join_pro_waitlist('visitor@example.com', 'pricing', 'en') ->> 'already', 'false',
  'someone else''s listed address: not told');
select throws_ok($$ select * from public.pro_waitlist $$, '42501', null, 'a member cannot read the table');

-- Rate limit: 10 an hour per account (three used above).
select lives_ok($$ select public.join_pro_waitlist('m' || g || '@example.com', 'app', 'en') from generate_series(1, 7) g $$,
  'ten joins an hour are fine');
select throws_ok($$ select public.join_pro_waitlist('m8@example.com', 'app', 'en') $$, '53400', null,
  'the eleventh is refused');

-- ---------------------------------------------------------------------------
-- Admin list
-- ---------------------------------------------------------------------------

select throws_ok($$ select * from public.admin_pro_waitlist() $$, '42501', 'admin only', 'a member cannot list it');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a701');
select is((select count(*)::int from public.admin_pro_waitlist()), 9, 'an admin lists every row');
select is((select total::int from public.admin_pro_waitlist(2, 0) limit 1), 9, '... with the total on a page');
select is((select username from public.admin_pro_waitlist() where email = 'wl.member@example.com'), 'wl_member',
  '... and the account''s username');

-- ---------------------------------------------------------------------------
-- Data download and account deletion
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000a702');
select is(jsonb_array_length(public.export_my_sealed('pro_waitlist') -> 'rows'), 8,
  'the rows the member added are in their data download (not the visitor''s they typed again)');

select pg_temp.as_postgres();
-- A visitor row carrying the other account's address, and one the member
-- added for that address: both go with that account.
insert into public.pro_waitlist (email, source) values ('wl.other@example.com', 'app');
delete from auth.users where id = '00000000-0000-0000-0000-00000000a703';
select is((select count(*)::int from public.pro_waitlist where email = 'wl.other@example.com'), 0,
  'a deleted account''s address leaves the list, even on a row added as a visitor');
delete from auth.users where id = '00000000-0000-0000-0000-00000000a702';
select is((select array_agg(email::text order by email) from public.pro_waitlist),
  array['visitor@example.com'], 'every row the deleted member added is gone; the visitor''s stays');

select * from finish();
rollback;
