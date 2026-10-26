-- pgTAP: Rail R6.4, the public enforcement flag --
-- `20270929090000_billing_enforced.sql`.
--
-- What has to hold:
--
--   * `billing_enforced()` is callable by anyone (anon too: an app that was
--     never signed in asks it), is a definer with an empty search_path,
--     takes nothing and returns a boolean - the switch, nothing else;
--   * it follows `billing_settings.enforcement_enabled`: false by default
--     (today), true once the owner turns enforcement on, false again;
--   * it opens nothing: the settings stay sealed, `my_entitlements()` stays
--     for signed-in callers only.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(10);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000064e001', 'enf.user@example.com', now(), now() - interval '30 days');

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
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

select ok(has_function_privilege('anon', 'public.billing_enforced()', 'execute')
          and has_function_privilege('authenticated', 'public.billing_enforced()', 'execute'),
  'anyone may ask whether enforcement is on');

select is((select p.prorettype::regtype::text || '/' || p.pronargs || '/' || p.prosecdef::text || '/'
                  || coalesce(array_to_string(p.proconfig, ','), '')
             from pg_proc p
            where p.oid = 'public.billing_enforced()'::regprocedure),
  'boolean/0/true/search_path=""',
  'a boolean from no argument: a definer with an empty search_path');

select pg_temp.act_as_anon();
select is(public.billing_enforced(), false, 'off by default (today): anon is told off');
select throws_ok($$ select public.my_entitlements() $$, '42501',
  null, '... and still cannot read anyone''s entitlements');
select throws_ok($$ select * from public.billing_settings $$, '42501',
  null, '... nor the settings');

select pg_temp.as_postgres();
update public.billing_settings set enforcement_enabled = true;

select pg_temp.act_as_anon();
select is(public.billing_enforced(), true, 'on: anon is told on');
select pg_temp.act_as('00000000-0000-0000-0000-00000064e001');
select is(public.billing_enforced(), true, '... and a signed-in caller too');
select is((public.my_entitlements() ->> 'enforced')::boolean, public.billing_enforced(),
  'the same answer as my_entitlements().enforced');

select pg_temp.as_postgres();
update public.billing_settings set enforcement_enabled = false;
select pg_temp.act_as_anon();
select is(public.billing_enforced(), false, 'off again: off');

select pg_temp.as_postgres();
delete from public.billing_settings;
select pg_temp.act_as_anon();
select is(public.billing_enforced(), false, 'no settings row at all: off');

select pg_temp.as_postgres();
select * from finish();
rollback;
