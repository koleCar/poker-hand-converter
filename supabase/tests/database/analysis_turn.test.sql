-- pgTAP: hand analysis, phase A5a -- `20270125090000_analysis_turn.sql`.
--
--   * the newest-first page is an invoker function with a pinned search_path,
--     executable by `authenticated` only;
--   * it returns the caller's hands without a row at the version, newest
--     first (a hand with no date last), trimmed like `hands_needing_analysis`;
--   * its keyset cursor pages through without repeats or gaps;
--   * it refuses anon and a malformed version, and never shows another
--     user's hands.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(14);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a5aa1', 'tu.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a5bb1', 'tu.b@example.com', now(), now());

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

-- A: four hands, one undated, one already analysed at analysis/4. B: one.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, big_blind, hero_profit, played_at) values
  ('00000000-0000-0000-0000-0000000a5001', '00000000-0000-0000-0000-0000000a5aa1', 'weplay:tu1',
   '{"schema":"phf/1","meta":{"rawText":"secret text","siteId":"weplay"},"actions":[{"index":0,"rawLine":"x","label":"y","type":"fold"}]}',
   'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 0, now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000a5002', '00000000-0000-0000-0000-0000000a5aa1', 'weplay:tu2',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 0, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000a5003', '00000000-0000-0000-0000-0000000a5aa1', 'weplay:tu3',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 0, null),
  ('00000000-0000-0000-0000-0000000a5004', '00000000-0000-0000-0000-0000000a5aa1', 'weplay:tu4',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 0, now()),
  ('00000000-0000-0000-0000-0000000a5b01', '00000000-0000-0000-0000-0000000a5bb1', 'weplay:tub1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'CO', 'cash', 'USD', 100, 0, now());

insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason, decisions, analysed, flag_count, pot_type)
values ('00000000-0000-0000-0000-0000000a5004', '00000000-0000-0000-0000-0000000a5aa1', 'analysis/4', 'not-analysed',
        'no-decisions', 0, 0, 0, 'walk');

-- ------------------------------------------------------------- shape --

select ok(
  (select not p.prosecdef from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'hands_needing_analysis_recent'),
  'the newest-first page is security invoker');
select ok(
  (select coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%' from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'hands_needing_analysis_recent'),
  'its search_path is pinned');
select ok(
  has_function_privilege('authenticated', 'public.hands_needing_analysis_recent(text, timestamptz, uuid, integer)', 'execute'),
  'authenticated may execute it');
select ok(
  not has_function_privilege('anon', 'public.hands_needing_analysis_recent(text, timestamptz, uuid, integer)', 'execute'),
  'anon may not');

-- --------------------------------------------------------------- reads --

select pg_temp.act_as('00000000-0000-0000-0000-0000000a5aa1');

select is(
  (select array_agg(id::text) from public.hands_needing_analysis_recent('analysis/4')),
  array['00000000-0000-0000-0000-0000000a5002', '00000000-0000-0000-0000-0000000a5001',
        '00000000-0000-0000-0000-0000000a5003'],
  'newest first, the undated hand last, the analysed one left out, only the caller''s');
select is(
  (select phf from public.hands_needing_analysis_recent('analysis/4') where id = '00000000-0000-0000-0000-0000000a5001'),
  '{"schema":"phf/1","meta":{"siteId":"weplay"},"actions":[{"index":0,"type":"fold"}]}'::jsonb,
  'the phf is trimmed: no raw text, no raw lines or labels');
select is(
  (select array_agg(id::text) from public.hands_needing_analysis_recent('analysis/3')),
  array['00000000-0000-0000-0000-0000000a5004', '00000000-0000-0000-0000-0000000a5002',
        '00000000-0000-0000-0000-0000000a5001', '00000000-0000-0000-0000-0000000a5003'],
  'versions are kept apart: at analysis/3 every hand still needs a row');

-- Keyset paging: two at a time, then one, then none.
select is(
  (select array_agg(id::text) from public.hands_needing_analysis_recent('analysis/3', null, null, 2)),
  array['00000000-0000-0000-0000-0000000a5004', '00000000-0000-0000-0000-0000000a5002'],
  'first page');
select is(
  (select array_agg(id::text) from public.hands_needing_analysis_recent(
     'analysis/3',
     (select played_at from public.hands where id = '00000000-0000-0000-0000-0000000a5002'),
     '00000000-0000-0000-0000-0000000a5002', 2)),
  array['00000000-0000-0000-0000-0000000a5001', '00000000-0000-0000-0000-0000000a5003'],
  'second page picks up after the cursor, the undated hand included');
select is(
  (select count(*)::int from public.hands_needing_analysis_recent(
     'analysis/3', null, '00000000-0000-0000-0000-0000000a5003', 2)),
  0, 'after the undated hand (a null cursor date) there is nothing');

select throws_ok(
  $$select * from public.hands_needing_analysis_recent('v4')$$,
  '22023', null, 'a malformed version is refused');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a5bb1');
select is(
  (select array_agg(id::text) from public.hands_needing_analysis_recent('analysis/4')),
  array['00000000-0000-0000-0000-0000000a5b01'],
  'another user sees only their own hand');

select pg_temp.act_as_anon();
select throws_ok(
  $$select * from public.hands_needing_analysis_recent('analysis/4')$$,
  '42501', null, 'anon cannot call it');

reset role;
select ok(
  (select count(*) = 0 from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('hand_analysis', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  'still no client write grant on the analysis tables');

select * from finish();
rollback;
