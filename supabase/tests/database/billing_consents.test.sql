-- pgTAP: Rail R6.3 addendum, the consent recorded before Stripe Checkout --
-- `20271013090000_billing_consents.sql`.
--
-- What has to hold:
--
--   * nothing new is reachable by a client: the table is sealed, both
--     functions are the service role's only (so `entitlements`' free list is
--     unchanged), every definer pins search_path;
--   * a consent is recorded whole - both kinds, versions and hashes, the
--     language, the period, the server's time - or not at all;
--   * evidence: nothing of a record can be rewritten; the session id is set
--     once, on the account's own record; the owner can only be cleared;
--   * the account's data (R6.5): in the inventory, exported to its owner
--     only; kept without the owner when the account is deleted.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(30);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000c0a01', 'consent.one@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-0000000c0a02', 'consent.two@example.com', now(), now() - interval '30 days');

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  execute 'set local role service_role';
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
-- One consent as billing-checkout records it.
create function pg_temp.record(p_owner uuid, p_kinds text[] default array['terms', 'immediate_performance'],
                               p_locale text default 'en', p_sha text default repeat('a', 64))
returns uuid language sql as $$
  select public.billing_record_consent(p_owner, p_kinds, 'draft-2026-10-26', repeat('b', 64), '2026-10-26',
                                       p_sha, p_locale, 'year');
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.as_service(), pg_temp.as_postgres(),
  pg_temp.record(uuid, text[], text, text) to authenticated, service_role;

-- ---------------------------------------------------------- the schema --

select ok(not has_any_column_privilege('authenticated', 'public.billing_consents', 'select, insert, update, references')
          and not has_any_column_privilege('anon', 'public.billing_consents', 'select, insert, update, references')
          and not has_table_privilege('authenticated', 'public.billing_consents', 'delete')
          and not has_table_privilege('anon', 'public.billing_consents', 'delete')
          and (select relrowsecurity from pg_class where oid = 'public.billing_consents'::regclass),
  'billing_consents is sealed (RLS on, no client privilege)');

select ok(not has_function_privilege('authenticated', 'public.billing_record_consent(uuid, text[], text, text, text, text, text, text)', 'execute')
          and not has_function_privilege('anon', 'public.billing_record_consent(uuid, text[], text, text, text, text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_consent_set_session(uuid, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.billing_consent_set_session(uuid, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.billing_consents_immutable()', 'execute'),
  'no client may execute the new functions (entitlements'' free list unchanged)');

select ok(has_function_privilege('service_role', 'public.billing_record_consent(uuid, text[], text, text, text, text, text, text)', 'execute')
          and has_function_privilege('service_role', 'public.billing_consent_set_session(uuid, uuid, text)', 'execute'),
  'the service role executes both');

select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('billing_record_consent', 'billing_consent_set_session', 'billing_consents_immutable')
              and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')),
  null, 'every new function pins an empty search_path');

select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'billing\_%consent%' or p.proname = 'billing_consents_immutable')
              and (has_function_privilege('authenticated', p.oid, 'execute')
                   or has_function_privilege('anon', p.oid, 'execute'))),
  0, 'nothing consent-related is client-callable');

-- -------------------------------------------------------- recording --

select pg_temp.as_service();
select ok(pg_temp.record('00000000-0000-0000-0000-0000000c0a01') is not null, 'the service role records a consent');
select is((select concat_ws('|', array_to_string(kinds, ','), terms_version, text_version, locale, period,
                            coalesce(checkout_session_id, '-'), (consented_at = now())::text)
             from public.billing_consents where owner_id = '00000000-0000-0000-0000-0000000c0a01'),
  'terms,immediate_performance|draft-2026-10-26|2026-10-26|en|year|-|true',
  '... whole: both kinds, the versions, the language, the period, the server''s time, no session yet');

select throws_ok($$ select pg_temp.record('00000000-0000-0000-0000-0000000c0a01', array['terms']) $$, '23514', null,
  'one kind alone is refused (both boxes, always)');
select throws_ok($$ select pg_temp.record('00000000-0000-0000-0000-0000000c0a01', array['immediate_performance', 'terms']) $$,
  '23514', null, '... in the canonical order only');
select throws_ok($$ select pg_temp.record('00000000-0000-0000-0000-0000000c0a01', p_locale => 'de') $$, '23514', null,
  'a language the page does not have is refused');
select throws_ok($$ select pg_temp.record('00000000-0000-0000-0000-0000000c0a01', p_sha => 'not-a-hash') $$, '23514', null,
  'a hash that is not SHA-256 hex is refused');
select throws_ok($$ select pg_temp.record('00000000-0000-0000-0000-00000000dead') $$, 'P0002', null,
  'an account without a profile is refused');

-- ----------------------------------------------------- the session id --

create temporary table ids (name text primary key, id uuid);
grant all on ids to service_role;
insert into ids values ('one', pg_temp.record('00000000-0000-0000-0000-0000000c0a01', p_locale => 'hr')),
                       ('two', pg_temp.record('00000000-0000-0000-0000-0000000c0a02'));

select is(public.billing_consent_set_session((select id from ids where name = 'one'),
                                             '00000000-0000-0000-0000-0000000c0a02', 'cs_test_other'),
  false, 'the session id is not written onto another account''s record');
select is(public.billing_consent_set_session((select id from ids where name = 'one'),
                                             '00000000-0000-0000-0000-0000000c0a01', 'cs_test_one'),
  true, 'the session id is written onto the account''s own record');
select is(public.billing_consent_set_session((select id from ids where name = 'one'),
                                             '00000000-0000-0000-0000-0000000c0a01', 'cs_test_again'),
  false, '... once');
select is((select checkout_session_id from public.billing_consents where id = (select id from ids where name = 'one')),
  'cs_test_one', '... and the first stays');
select throws_ok($$ select public.billing_consent_set_session((select id from ids where name = 'two'),
                                                             '00000000-0000-0000-0000-0000000c0a02', 'pi_123') $$,
  '22023', null, 'only a Checkout Session id');
select throws_ok($$ select public.billing_consent_set_session((select id from ids where name = 'two'),
                                                             '00000000-0000-0000-0000-0000000c0a02', 'cs_test_one') $$,
  '23505', null, 'one session, one consent');

-- ------------------------------------------------------------ evidence --

select throws_ok($$ update public.billing_consents set text_version = '2027-01-01'
                     where id = (select id from ids where name = 'one') $$, '42501', null,
  'the wording''s version cannot be rewritten');
select throws_ok($$ update public.billing_consents set consented_at = now() - interval '1 day'
                     where id = (select id from ids where name = 'one') $$, '42501', null,
  '... nor the time');
select throws_ok($$ update public.billing_consents set checkout_session_id = 'cs_test_swap'
                     where id = (select id from ids where name = 'one') $$, '42501', null,
  '... nor a session id once set');
select throws_ok($$ update public.billing_consents set owner_id = '00000000-0000-0000-0000-0000000c0a02'
                     where id = (select id from ids where name = 'one') $$, '42501', null,
  '... nor the account it belongs to');

-- ------------------------------------------------------------ a client --

select pg_temp.act_as('00000000-0000-0000-0000-0000000c0a01');
select throws_ok($$ select count(*) from public.billing_consents $$, '42501', null,
  'a signed-in client cannot read the table');
select throws_ok($$ select pg_temp.record('00000000-0000-0000-0000-0000000c0a01') $$, '42501', null,
  '... nor record a consent');
select throws_ok($$ insert into public.billing_consents (owner_id, kinds, terms_version, terms_sha256, text_version,
                                                         text_sha256, locale, period)
                    values ('00000000-0000-0000-0000-0000000c0a01', array['terms', 'immediate_performance'], 'x',
                            repeat('a', 64), 'x', repeat('a', 64), 'en', 'year') $$, '42501', null,
  '... nor insert one');

-- ---------------------------------------------------- the account's data --

select is((select count(*)::int from jsonb_array_elements(public.export_my_sealed('billing_consents') -> 'rows')),
  2, 'the export carries the account''s own consents (and not the other account''s)');
select is((select string_agg(r ->> 'locale' || ':' || coalesce(r ->> 'checkout_session_id', '-'), ',' order by r ->> 'locale')
             from jsonb_array_elements(public.export_my_sealed('billing_consents') -> 'rows') r),
  'en:-,hr:cs_test_one', '... with what was recorded');

select pg_temp.as_postgres();
select is((select concat_ws('|', export, export_file, export_reader, on_delete)
             from public.account_data_inventory where name = 'public.billing_consents'),
  'file|billing/consents.ndjson|sealed|anonymise', 'in the inventory: exported, kept without the account');

delete from auth.users where id = '00000000-0000-0000-0000-0000000c0a01';
select is((select count(*)::int from public.billing_consents
            where id in (select id from ids) and owner_id is null),
  1, 'a deleted account''s consents stay, without their owner');
select is((select checkout_session_id from public.billing_consents where id = (select id from ids where name = 'one')),
  'cs_test_one', '... still tied to the session');

select * from finish();
rollback;
