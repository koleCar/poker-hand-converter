-- pgTAP: the user's own preflop charts (R5.3) -- `20270811090000_preflop_charts.sql`.
--
-- What has to hold:
--
--   * security: `preflop_chart_sets` is the owner's only - select, insert,
--     update and delete under RLS for `authenticated`, nothing for `anon`;
--     another account neither sees, changes, deletes nor plants a row; an
--     update cannot move a row to another account; the guard is definer and
--     executable by no client role;
--   * the checks and limits: situation keys of the set's table only
--     (`preflop_chart_key_ok`, `isPlausible` in `packages/ui/charts/model.ts`),
--     the actions a situation allows, base64 of 169 bytes, percents and each
--     class's sum at most 100, the raise size, the name and the stack range,
--     300 situations, 50 sets an account, 120 writes per 10 minutes;
--   * a deleted account leaves no chart set.
--
-- The played decisions a chart is compared with are `preflop_charts_compare`'s.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(33);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000c53a1', 'charts.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000c53b1', 'charts.b@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000c53c1', 'charts.c@example.com', now(), now());

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

-- 169 percents as stored: `p_value` at the named classes' indexes, 0 elsewhere.
create function pg_temp.b64(p_classes int[], p_value int) returns text language plpgsql as $$
declare
  v bytea := decode(repeat('00', 169), 'hex');
  c int;
begin
  foreach c in array p_classes loop
    v := set_byte(v, c, p_value);
  end loop;
  return replace(encode(v, 'base64'), E'\n', '');
end;
$$;
grant execute on function pg_temp.b64(int[], int) to authenticated;

-- Whether an insert as the current user fails with a message like the pattern.
create function pg_temp.refused(p_sql text, p_like text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlerrm like p_like;
end;
$$;
grant execute on function pg_temp.refused(text, text) to authenticated, anon;

-- Rows a statement changed, as the current user.
create function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function pg_temp.affected(text) to authenticated;

-- ---------------------------------------------------------- security --

select ok(
  (select c.relrowsecurity from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname = 'preflop_chart_sets'),
  'preflop_chart_sets exists with row level security');
select is(
  (select array_agg(privilege_type::text order by privilege_type) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'preflop_chart_sets' and grantee = 'authenticated'),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE'], 'select, insert, update and delete for authenticated');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'preflop_chart_sets' and grantee = 'anon'),
  0, '... nothing at all for anon');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'preflop_chart_sets' and roles = '{authenticated}'
     and coalesce(qual, '') || coalesce(with_check, '') like '%auth.uid()%'),
  4, '... four owner-only policies, one per command');
select ok(
  (select p.prosecdef from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'preflop_chart_sets_guard')
  and not has_function_privilege('authenticated', 'public.preflop_chart_sets_guard()', 'execute')
  and not has_function_privilege('anon', 'public.preflop_chart_sets_guard()', 'execute'),
  'the guard is security definer and executable by no client role');

-- ------------------------------------------------------------ the key rule --

select is(
  array[public.preflop_chart_key_ok('rfi:CO', 6), public.preflop_chart_key_ok('rfi:BB', 6),
        public.preflop_chart_key_ok('rfi:LJ', 6), public.preflop_chart_key_ok('rfi:LJ', 9),
        public.preflop_chart_key_ok('vs-open:BB:BTN', 6), public.preflop_chart_key_ok('vs-open:BTN:BB', 6),
        public.preflop_chart_key_ok('squeeze:SB:BTN', 6), public.preflop_chart_key_ok('vs-3bet:CO:BTN', 6),
        public.preflop_chart_key_ok('vs-iso:SB:BB', 2), public.preflop_chart_key_ok('vs-open:CO', 6)],
  array[true, false, false, true, true, false, false, true, true, false],
  'preflop_chart_key_ok: the situations a table can have (isPlausible)');

-- ------------------------------------------------------------ chart sets --

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53a1');

select lives_ok(
  $$insert into public.preflop_chart_sets (id, name, game_format, table_size, stack_min_bb, stack_max_bb, nodes)
    values ('00000000-0000-0000-0000-0000000c5c01', ' My 6-max ', 'cash', 6, 80, 120,
            jsonb_build_object(
              'rfi:CO', jsonb_build_object('raise', pg_temp.b64(array[0, 1, 13, 14], 100), 'raiseBb', 2.5),
              'vs-open:BB:BTN', jsonb_build_object('raise', pg_temp.b64(array[0], 100),
                                                   'call', pg_temp.b64(array[13, 163], 50)),
              'vs-limp:BB:SB', jsonb_build_object('raise', pg_temp.b64(array[0], 60))))$$,
  'the owner saves a chart set');
select is(
  (select name || ' ' || owner_id::text || ' ' || (created_at is not null)::text from public.preflop_chart_sets),
  'My 6-max 00000000-0000-0000-0000-0000000c53a1 true',
  '... it is theirs, the name trimmed');
select lives_ok(
  $$update public.preflop_chart_sets set name = 'Renamed', owner_id = '00000000-0000-0000-0000-0000000c53b1'
    where id = '00000000-0000-0000-0000-0000000c5c01'$$,
  'the owner renames it (and tries to hand it to another account)');
select is(
  (select name || ' ' || owner_id::text from public.preflop_chart_sets where id = '00000000-0000-0000-0000-0000000c5c01'),
  'Renamed 00000000-0000-0000-0000-0000000c53a1',
  '... renamed, still the owner''s');

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53b1');
select is((select count(*)::int from public.preflop_chart_sets), 0, 'another account sees none of it');
select is(
  pg_temp.affected($$update public.preflop_chart_sets set name = 'Mine now'$$),
  0, '... cannot change it');
select is(
  pg_temp.affected($$delete from public.preflop_chart_sets$$),
  0, '... cannot delete it');
select ok(
  pg_temp.refused($$insert into public.preflop_chart_sets (owner_id, name, game_format, table_size, stack_min_bb, stack_max_bb)
                    values ('00000000-0000-0000-0000-0000000c53a1', 'Planted', 'cash', 6, 80, 120)$$,
                  '%row-level security%'),
  '... and cannot write a set into it');

select pg_temp.act_as_anon();
select ok(pg_temp.refused('select count(*) from public.preflop_chart_sets', '%permission denied%'),
          'anon cannot read chart sets');

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53a1');

create function pg_temp.try_nodes(p_nodes jsonb, p_table int default 6) returns text language plpgsql as $$
begin
  insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb, nodes)
  values ('Bad', 'cash', p_table, 80, 120, p_nodes);
  return 'saved';
exception when others then
  return sqlerrm;
end;
$$;
grant execute on function pg_temp.try_nodes(jsonb, int) to authenticated;

select matches(pg_temp.try_nodes('{"rfi:LJ":{}}'), 'not a situation of a 6-seat table: rfi:LJ',
               'refused: a situation of another table');
select matches(pg_temp.try_nodes(jsonb_build_object('vs-limp:BB:SB', jsonb_build_object('call', pg_temp.b64(array[0], 10)))),
               'checks rather than calls', 'refused: a call where the big blind checks');
select matches(pg_temp.try_nodes('{"rfi:CO":{"raise":"AAAA"}}'), 'not 169 percents in base64',
               'refused: not 169 bytes of base64');
select matches(pg_temp.try_nodes(jsonb_build_object('rfi:CO', jsonb_build_object(
                 'raise', pg_temp.b64(array[0], 70), 'call', pg_temp.b64(array[0], 40)))),
               'more than 100 %: rfi:CO', 'refused: a class over 100 %');
select matches(pg_temp.try_nodes(jsonb_build_object('rfi:CO', jsonb_build_object('raise', pg_temp.b64(array[5], 101)))),
               'more than 100 %', 'refused: a percent over 100');
select matches(pg_temp.try_nodes('{"rfi:CO":{"raiseBb":0}}'), 'raise size', 'refused: a raise size of 0');
select matches(pg_temp.try_nodes('{"rfi:CO":{"limp":"x"}}'), 'raise, call, allin and raiseBb only',
               'refused: an unknown action');
select matches(pg_temp.try_nodes((select jsonb_object_agg('k' || i, '{}'::jsonb) from generate_series(1, 301) i)),
               'at most 300 situations', 'refused: more than 300 situations');
select ok(
  pg_temp.refused($$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                    values ('', 'cash', 6, 80, 120)$$, '%check constraint%')
  and pg_temp.refused($$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                        values (repeat('x', 81), 'cash', 6, 80, 120)$$, '%check constraint%'),
  'refused: an empty name and one over 80 characters');
select ok(
  pg_temp.refused($$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                    values ('x', 'cash', 6, 120, 80)$$, '%stack_range%')
  and pg_temp.refused($$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                        values ('x', 'cash', 7, 80, 120)$$, '%check constraint%')
  and pg_temp.refused($$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                        values ('x', 'mtt', 6, 80, 120)$$, '%check constraint%'),
  'refused: a stack range backwards, a table of 7, an unknown format');
select is((select count(*)::int from public.preflop_chart_sets), 1, '... none of the refused sets was saved');

select lives_ok(
  $$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
    select 'Set ' || i, 'tournament', 9, 20, 40 from generate_series(2, 50) i$$,
  'an account holds 50 sets');
select ok(
  pg_temp.refused($$insert into public.preflop_chart_sets (name, game_format, table_size, stack_min_bb, stack_max_bb)
                    values ('Set 51', 'cash', 2, 80, 120)$$, 'At most 50 chart sets%'),
  '... and not a 51st');
select is(
  pg_temp.affected($$delete from public.preflop_chart_sets where name like 'Set %'$$),
  49, 'the owner deletes their sets');

select pg_temp.act_as('00000000-0000-0000-0000-0000000c53c1');
create function pg_temp.writes(p_n int) returns text language plpgsql as $$
begin
  insert into public.preflop_chart_sets (id, name, game_format, table_size, stack_min_bb, stack_max_bb)
  values ('00000000-0000-0000-0000-0000000c5cc1', 'C', 'cash', 6, 80, 120);
  for i in 2 .. p_n loop
    update public.preflop_chart_sets set name = 'C' || i where id = '00000000-0000-0000-0000-0000000c5cc1';
  end loop;
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;
grant execute on function pg_temp.writes(int) to authenticated;
select is(pg_temp.writes(120), 'ok', '120 writes in 10 minutes are fine');
select matches(
  (select case when pg_temp.refused($$update public.preflop_chart_sets set name = 'C121'$$, '%rate limit%') then 'limited' else 'not' end),
  'limited', '... the 121st is rate-limited');

-- ------------------------------------------------------------ accounts --

reset role;
select set_config('request.jwt.claims', '', true);
delete from auth.users where id = '00000000-0000-0000-0000-0000000c53c1';
select is((select count(*)::int from public.preflop_chart_sets where owner_id = '00000000-0000-0000-0000-0000000c53c1'), 0,
          'a deleted account leaves no chart set');
delete from auth.users where id = '00000000-0000-0000-0000-0000000c53a1';
select is((select count(*)::int from public.preflop_chart_sets where owner_id = '00000000-0000-0000-0000-0000000c53a1'), 0,
          '... the first account''s goes with it');

select * from finish();
rollback;
