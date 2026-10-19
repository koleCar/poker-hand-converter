-- pgTAP: the HUD's designs and layouts, synced -- `20270602090000_hud_layouts.sql`.
--
-- What has to hold:
--
--   * the security model: no client INSERT / UPDATE / DELETE on the table,
--     RLS on, the writer `security definer` with an empty search_path,
--     executable by `authenticated` and not by `anon`;
--   * last writer wins by `updatedAt`: a newer row replaces, an older or equal
--     one is refused and said so; a tombstone (null body) is a row like any
--     other and can be replaced by a newer row;
--   * a batch is validated whole (kinds, keys per kind, bodies, times), at
--     most 500 rows a call and 5,000 an account;
--   * one user's rows never reach another's reads or writes, even with the
--     same key; anon reads and writes nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(35);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000003a0d01', 'hud.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000003b0d01', 'hud.b@example.com', now(), now());

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

-- A time in ms a little in the past (now - 1 h) plus `p_ms`.
create function pg_temp.at(p_ms bigint) returns bigint language sql as $$
  select ((extract(epoch from now()) - 3600) * 1000)::bigint + p_ms
$$;
grant execute on function pg_temp.at(bigint) to anon, authenticated;

-- -------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'hud_layouts'
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client write grant on the table');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'hud_layouts' and grantee = 'anon'),
  0, 'anon holds no grant at all on it');
select ok(
  (select c.relrowsecurity from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname = 'hud_layouts'),
  'RLS is on');
select ok(
  (select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'put_hud_layouts'),
  'the writer is security definer and pins an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.put_hud_layouts(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.put_hud_layouts(jsonb)', 'execute'),
  'authenticated may execute the writer, anon may not');

-- ------------------------------------------------------- writes, as A --

select pg_temp.act_as('00000000-0000-0000-0000-0000003a0d01');

select is(
  public.put_hud_layouts(jsonb_build_array(
    jsonb_build_object('kind', 'layout', 'key', 'd-0123abcd', 'body', '{"version":1,"name":"Mine"}'::jsonb, 'updatedAt', pg_temp.at(1000)),
    jsonb_build_object('kind', 'assignment', 'key', 'pokerstars|0|cash', 'body', '{"layout":"d-0123abcd"}'::jsonb, 'updatedAt', pg_temp.at(1000)),
    jsonb_build_object('kind', 'assignment', 'key', '*|6|*', 'body', '{"layout":"mtt"}'::jsonb, 'updatedAt', pg_temp.at(1000)),
    jsonb_build_object('kind', 'seat_position', 'key', 'acr|6|2', 'body', '{"x":300,"y":400}'::jsonb, 'updatedAt', pg_temp.at(1000)),
    jsonb_build_object('kind', 'room_setting', 'key', 'winamax', 'body', null, 'updatedAt', pg_temp.at(1000))
  )),
  '[{"key": "d-0123abcd", "kind": "layout", "applied": true},
    {"key": "pokerstars|0|cash", "kind": "assignment", "applied": true},
    {"key": "*|6|*", "kind": "assignment", "applied": true},
    {"key": "acr|6|2", "kind": "seat_position", "applied": true},
    {"key": "winamax", "kind": "room_setting", "applied": true}]'::jsonb,
  'new rows are taken');
select is((select count(*)::int from public.hud_layouts), 5, 'A reads its five rows');
select ok((select body is null from public.hud_layouts where kind = 'room_setting' and key = 'winamax'),
  'a null body is stored as a tombstone');

select is(
  public.put_hud_layouts(jsonb_build_array(
    jsonb_build_object('kind', 'layout', 'key', 'd-0123abcd', 'body', '{"version":1,"name":"Older"}'::jsonb, 'updatedAt', pg_temp.at(999)),
    jsonb_build_object('kind', 'seat_position', 'key', 'acr|6|2', 'body', '{"x":1,"y":1}'::jsonb, 'updatedAt', pg_temp.at(1000))
  )),
  '[{"key": "d-0123abcd", "kind": "layout", "applied": false},
    {"key": "acr|6|2", "kind": "seat_position", "applied": false}]'::jsonb,
  'an older row and an equal one are refused');
select is((select body ->> 'name' from public.hud_layouts where key = 'd-0123abcd'), 'Mine',
  '... and change nothing');

select is(
  public.put_hud_layouts(jsonb_build_array(
    jsonb_build_object('kind', 'layout', 'key', 'd-0123abcd', 'body', null, 'updatedAt', pg_temp.at(2000)),
    jsonb_build_object('kind', 'seat_position', 'key', 'acr|6|2', 'updatedAt', pg_temp.at(2000))
  )),
  '[{"key": "d-0123abcd", "kind": "layout", "applied": true},
    {"key": "acr|6|2", "kind": "seat_position", "applied": true}]'::jsonb,
  'a newer delete and a newer reset (no body) are taken');
select ok((select body is null and updated_at = pg_temp.at(2000) from public.hud_layouts where key = 'd-0123abcd'),
  'the design is a tombstone now');
select is(
  public.put_hud_layouts(jsonb_build_array(
    jsonb_build_object('kind', 'layout', 'key', 'd-0123abcd', 'body', '{"version":1,"name":"Back"}'::jsonb, 'updatedAt', pg_temp.at(3000))
  )) -> 0 ->> 'applied',
  'true', 'a newer row replaces a tombstone');

-- --------------------------------------------------------- validation --

select throws_ok($$select public.put_hud_layouts('{"kind":"layout"}')$$, '22023', null, 'not an array');
select throws_ok($$select public.put_hud_layouts('[1]')$$, '22023', null, 'not an object');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'chart', 'key', 'x', 'updatedAt', pg_temp.at(0))))$$, '22023', null, 'an unknown kind');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'layout', 'key', 'D 1', 'updatedAt', pg_temp.at(0))))$$, '22023', null, 'a malformed design id');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'assignment', 'key', 'acr|1|cash', 'updatedAt', pg_temp.at(0))))$$, '22023', null, 'an assignment size out of range');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'assignment', 'key', 'acr|6|sng', 'updatedAt', pg_temp.at(0))))$$, '22023', null, 'an unknown format');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'seat_position', 'key', 'acr|6|12', 'updatedAt', pg_temp.at(0))))$$, '22023', null, 'a slot out of range');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'layout', 'key', 'd-1', 'body', '[1,2]'::jsonb, 'updatedAt', pg_temp.at(0))))$$, '22023', null, 'a body that is not an object');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'layout', 'key', 'd-1', 'body', jsonb_build_object('pad', repeat('x', 40000)), 'updatedAt', pg_temp.at(0))))$$,
  '22023', null, 'a body over 32 KiB');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'layout', 'key', 'd-1', 'updatedAt', 1000)))$$, '22023', null, 'a time before 2020');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'layout', 'key', 'd-1', 'updatedAt', pg_temp.at(3 * 86400 * 1000))))$$, '22023', null, 'a time days ahead');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(
  jsonb_build_object('kind', 'layout', 'key', 'd-ok', 'updatedAt', pg_temp.at(0)),
  jsonb_build_object('kind', 'layout', 'key', 'D!', 'updatedAt', pg_temp.at(0))))$$,
  '22023', null, 'one bad row refuses the batch');
select is((select count(*)::int from public.hud_layouts where key = 'd-ok'), 0, '... nothing of it written');
select throws_ok(
  $$select public.put_hud_layouts((select jsonb_agg(jsonb_build_object(
      'kind', 'layout', 'key', 'd-' || g, 'updatedAt', pg_temp.at(0))) from generate_series(1, 501) g))$$,
  '53400', null, 'at most 500 rows a call');

-- ------------------------------------------------------------- B, anon --

select pg_temp.act_as('00000000-0000-0000-0000-0000003b0d01');
select is((select count(*)::int from public.hud_layouts), 0, 'B reads none of A''s rows');
select is(
  public.put_hud_layouts(jsonb_build_array(
    jsonb_build_object('kind', 'seat_position', 'key', 'acr|6|2', 'body', '{"x":9,"y":9}'::jsonb, 'updatedAt', pg_temp.at(1))
  )) -> 0 ->> 'applied',
  'true', 'B''s row with A''s key is B''s own (an older time than A''s)');
select is((select count(*)::int from public.hud_layouts), 1, 'B reads only its own');
select pg_temp.act_as('00000000-0000-0000-0000-0000003a0d01');
select ok((select body is null from public.hud_layouts where kind = 'seat_position' and key = 'acr|6|2'),
  'A''s row is untouched');

-- 5,000 rows an account.
reset role;
insert into public.hud_layouts (owner_id, kind, key, body, updated_at)
select '00000000-0000-0000-0000-0000003b0d01', 'layout', 'd-fill-' || g, null, 1600000000000
from generate_series(1, 4999) g;
select pg_temp.act_as('00000000-0000-0000-0000-0000003b0d01');
select throws_ok($$select public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
  'kind', 'layout', 'key', 'd-one-more', 'updatedAt', pg_temp.at(0))))$$, '53400', null, 'at most 5,000 rows an account');
select is(
  public.put_hud_layouts(jsonb_build_array(jsonb_build_object(
    'kind', 'layout', 'key', 'd-fill-1', 'body', '{"version":1}'::jsonb, 'updatedAt', pg_temp.at(0)))) -> 0 ->> 'applied',
  'true', '... but an existing row may still change');

select pg_temp.act_as_anon();
select throws_ok($$select count(*) from public.hud_layouts$$, '42501', null, 'anon cannot read the table');
select throws_ok($$select public.put_hud_layouts('[]')$$, '42501', null, '... nor write it');

select * from finish();
rollback;
