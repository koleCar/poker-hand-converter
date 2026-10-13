-- pgTAP: Rail R1.10, live arrival on the web -- `20270512090000_hand_arrivals.sql`.
--
-- What has to hold:
--
--   * `hand_arrivals` is readable by its owner only (RLS select-own; Realtime
--     applies the same policy to INSERT and UPDATE changes), reads as empty
--     to anon, and is writable by nobody but the trigger;
--   * it is in the `supabase_realtime` publication, `hands` is not (no hand
--     content ever reaches a socket), and its primary key is a random id,
--     not the owner (DELETE changes carry the key to every subscriber);
--   * one insert statement on `hands` is one bump of the owner's row, with
--     the count and origin of that statement: an `ingest_hands` call, a
--     `save_hands` call; a statement that added nothing (all duplicates)
--     does not signal;
--   * one account's hands never touch another account's row;
--   * a failing signal never fails a save.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(29);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000010aa01', 'arrive.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000010bb01', 'arrive.b@example.com', now(), now());

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

-- A small hold'em hand in the shape the desktop sends (rawText empty).
create function pg_temp.phf(p_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'meta', jsonb_build_object(
      'siteId', 'weplay', 'siteName', 'WePlay', 'handId', p_id, 'handKey', p_id,
      'originalFilename', 'HH20261001.txt', 'parserId', 'weplay', 'parserVersion', '1.0.0',
      'warnings', '[]'::jsonb, 'rawText', '', 'parsedAt', '1970-01-01T00:00:00.000Z',
      'textStyle', jsonb_build_object('decimals', 'minimal')),
    'game', jsonb_build_object(
      'variant', 'holdem', 'limit', 'nl', 'format', 'cash', 'ante', 0,
      'unit', jsonb_build_object('code', 'USD', 'symbol', '$', 'minorUnits', 100, 'kind', 'cash'),
      'smallBlind', 50, 'bigBlind', 100),
    'table', jsonb_build_object('name', 'Table 1', 'maxSeats', 6),
    'tournament', null,
    'players', jsonb_build_array(
      jsonb_build_object('seat', 1, 'name', 'HeroName', 'isHero', true, 'position', 'BTN', 'holeCards', jsonb_build_array('Ah', 'Kh')),
      jsonb_build_object('seat', 2, 'name', 'Villain1', 'isHero', false, 'position', 'SB'),
      jsonb_build_object('seat', 3, 'name', 'Villain2', 'isHero', false, 'position', 'BB')),
    'actions', '[]'::jsonb,
    'board', jsonb_build_object('runouts', jsonb_build_array(
      jsonb_build_object('flop', jsonb_build_array('2c', '3d', '4s'), 'turn', '5h', 'river', null))),
    'results', jsonb_build_object(
      'streetReached', 'turn', 'wentToShowdown', false, 'totalPot', 300, 'heroNet', 200,
      'fees', jsonb_build_object('rake', 5, 'jackpot', 1, 'bingo', 0, 'fortune', 0, 'tax', 0, 'other', 0),
      'winners', jsonb_build_array(jsonb_build_object('player', 'HeroName', 'seat', 1)),
      'players', '[]'::jsonb),
    'playedAt', '2026-10-01T12:00:00.000Z');
$$;
create function pg_temp.row(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('hand_key', 'weplay:' || p_id, 'phf', pg_temp.phf(p_id));
$$;
create function pg_temp.web(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('hand_key', 'weplay:' || p_id, 'phf', pg_temp.phf(p_id),
                            'site', 'weplay', 'standard_text', 'Poker Hand #' || p_id);
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.phf(text),
  pg_temp.row(text), pg_temp.web(text) to anon, authenticated;

-- ----------------------------------------------------------- the table --

select ok((select relrowsecurity from pg_class where oid = 'public.hand_arrivals'::regclass),
  'hand_arrivals has RLS on');
select is((select array_agg(policyname::text || ':' || cmd || ':' || qual order by policyname)
             from pg_policies where schemaname = 'public' and tablename = 'hand_arrivals'),
  array['hand_arrivals_own_select:SELECT:(owner_id = ( SELECT auth.uid() AS uid))'],
  'its one policy is select-own');
select ok(has_table_privilege('authenticated', 'public.hand_arrivals', 'select')
          and not has_table_privilege('authenticated', 'public.hand_arrivals', 'insert')
          and not has_table_privilege('authenticated', 'public.hand_arrivals', 'update')
          and not has_table_privilege('authenticated', 'public.hand_arrivals', 'delete'),
  'authenticated may read it and write nothing');
select ok(not has_table_privilege('anon', 'public.hand_arrivals', 'insert')
          and not has_table_privilege('anon', 'public.hand_arrivals', 'update')
          and not has_table_privilege('anon', 'public.hand_arrivals', 'delete'),
  'anon may write nothing (it has SELECT so Realtime runs RLS for it, and no policy)');
select is((select array_agg(a.attname::text) from pg_index i
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
            where i.indrelid = 'public.hand_arrivals'::regclass and i.indisprimary),
  array['id'], 'the primary key is the random id, not the owner (DELETE changes carry it)');

-- -------------------------------------------------------------- realtime --

select ok(exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hand_arrivals'),
  'hand_arrivals is in the realtime publication');
select ok(not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hands'),
  'hands is not: no hand content is ever decoded for a socket');
select is((select attnames::text[] from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hand_arrivals'),
  array['id', 'owner_id', 'seq', 'hands', 'origin', 'arrived_at'],
  'what a change carries: ids, a counter, a count, an origin, a time');

-- ------------------------------------------------------------ the trigger --

select ok((select prosecdef and proconfig @> array['search_path=""']
             from pg_proc where oid = 'public.hands_signal_arrival()'::regprocedure),
  'the trigger function is security definer with an empty search_path');
select ok(not has_function_privilege('authenticated', 'public.hands_signal_arrival()', 'execute')
          and not has_function_privilege('anon', 'public.hands_signal_arrival()', 'execute'),
  'no client may call it');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.hands'::regclass
                   and tgname = 'hands_signal_arrival' and tgtype & 1 = 0 and not tgisinternal),
  'it fires once per statement on hands');

-- --------------------------------------------------------------- signals --

select pg_temp.act_as('00000000-0000-0000-0000-00000010aa01');
select is((select count(*)::int from public.hand_arrivals), 0, 'nothing has arrived yet');

select lives_ok($$
  select public.ingest_hands(
    public.register_hand_source('00000000-0000-0000-0000-00000010ad01', 'f1'),
    jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'), pg_temp.row('3')))
$$, 'A uploads three hands from the desktop');
select is((select seq || '/' || hands || '/' || origin from public.hand_arrivals), '1/3/desktop',
  'one ingest_hands call is one signal: seq 1, three hands, desktop');

select lives_ok($$
  select public.ingest_hands(
    public.register_hand_source('00000000-0000-0000-0000-00000010ad01', 'f1'),
    jsonb_build_array(pg_temp.row('1'), pg_temp.row('2')))
$$, 'A sends two of them again');
select is((select seq::int from public.hand_arrivals), 1,
  'all duplicates: no signal');

select lives_ok($$ select public.save_hands(jsonb_build_array(pg_temp.web('4'), pg_temp.web('5'))) $$,
  'A saves two hands on the web');
select is((select seq || '/' || hands || '/' || origin from public.hand_arrivals), '2/2/web',
  'one save_hands call is one signal: seq 2, two hands, web');

select pg_temp.act_as('00000000-0000-0000-0000-00000010bb01');
select lives_ok($$
  select public.ingest_hands(
    public.register_hand_source('00000000-0000-0000-0000-00000010bd01', 'f1'),
    jsonb_build_array(pg_temp.row('1'), pg_temp.row('9')))
$$, 'B uploads two hands, one with a key A also has');
select is((select owner_id || '/' || seq || '/' || hands from public.hand_arrivals),
  '00000000-0000-0000-0000-00000010bb01/1/2', 'B reads only its own row, which counts its own hands');

select pg_temp.act_as('00000000-0000-0000-0000-00000010aa01');
select is((select seq || '/' || hands || '/' || origin from public.hand_arrivals), '2/2/web',
  'A reads only its own row, untouched by B');
select is((select count(*)::int from public.hand_arrivals
            where owner_id = '00000000-0000-0000-0000-00000010bb01'),
  0, 'asking for B''s row by owner finds nothing (what Realtime runs for a forged filter)');

-- -------------------------------------------------------------- refusals --

select throws_ok($$ insert into public.hand_arrivals (owner_id, hands, origin)
                    values ('00000000-0000-0000-0000-00000010aa01', 1, 'web') $$,
  '42501', null, 'a client cannot write a signal');
select throws_ok($$ update public.hand_arrivals set seq = seq + 1 $$,
  '42501', null, '... or bump one');
select throws_ok($$ delete from public.hand_arrivals $$,
  '42501', null, '... or delete one');

select pg_temp.act_as_anon();
select is((select count(*)::int from public.hand_arrivals), 0,
  'anon reads no signal: RLS has no policy for it (what Realtime runs for an anonymous socket)');

-- ------------------------------------------------- never costs a save --

reset role;
alter table public.hand_arrivals add constraint test_refuse_everything check (false) not valid;
select pg_temp.act_as('00000000-0000-0000-0000-00000010aa01');
select lives_ok($$ select public.save_hands(jsonb_build_array(pg_temp.web('6'))) $$,
  'with the signal failing, the save still succeeds');
select is((select count(*)::int from public.hands where hand_key = 'weplay:6'), 1,
  '... and the hand is stored');
select is((select seq::int from public.hand_arrivals), 2,
  '... and the failed signal left the row as it was');

select * from finish();
rollback;
