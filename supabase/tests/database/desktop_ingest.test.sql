-- pgTAP: Rail R1.8, desktop ingest -- `20270428090000_desktop_ingest.sql`.
--
-- What has to hold:
--
--   * `ingest_hands` and `register_hand_source` are security definer with an
--     empty search_path, executable by `authenticated` only; the mapping's
--     helpers by no client;
--   * `hand_sources` is readable by its owner only and writable by no client;
--   * a source is the caller's own: another account can neither use it nor
--     see it, and registering is idempotent;
--   * replays are no-ops (duplicates, nothing rewritten), counted per source;
--   * another account's rows can be neither read nor collided with: the same
--     hand key in two libraries is two rows;
--   * every bad row is rejected on its own with a reason, in input order,
--     while the good rows of the same batch are stored;
--   * a desktop row has no standard or source text and an empty
--     `meta.rawText`, from any writer; a web row keeps its standard text; the
--     direct path cannot write a desktop row;
--   * the per-account budget holds (10 minutes and day), desktop rows do not
--     spend the web's global budget, and a refused call writes nothing;
--   * the stats rebuild sees desktop rows and `save_hand_stats` attaches to
--     them.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(51);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000e2a01', 'ingest.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000e2b01', 'ingest.b@example.com', now(), now());

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

-- A small hold'em hand in the shape the desktop sends (Q4: rawText empty).
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
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.phf(text), pg_temp.row(text)
  to anon, authenticated;

create temporary table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;

-- ---------------------------------------------------------- the functions --

select ok((select bool_and(prosecdef and proconfig @> array['search_path=""'])
           from pg_proc where oid in ('public.ingest_hands(uuid, jsonb)'::regprocedure,
                                      'public.register_hand_source(uuid, text, text, text, text)'::regprocedure)),
  'ingest_hands and register_hand_source are security definer with an empty search_path');
select ok(has_function_privilege('authenticated', 'public.ingest_hands(uuid, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.register_hand_source(uuid, text, text, text, text)', 'execute'),
  'authenticated may call both');
select ok(not has_function_privilege('anon', 'public.ingest_hands(uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.register_hand_source(uuid, text, text, text, text)', 'execute'),
  'anon may call neither');
select ok(not has_function_privilege('authenticated', 'public.hand_row_from_phf(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.hand_row_problem(public.hands)', 'execute')
          and not has_function_privilege('anon', 'public.hand_row_from_phf(jsonb)', 'execute'),
  'the mapping is internal');

-- ------------------------------------------------------------ hand_sources --

select ok((select relrowsecurity from pg_class where oid = 'public.hand_sources'::regclass),
  'hand_sources has RLS on');
select ok(has_table_privilege('authenticated', 'public.hand_sources', 'select')
          and not has_table_privilege('authenticated', 'public.hand_sources', 'insert')
          and not has_table_privilege('authenticated', 'public.hand_sources', 'update')
          and not has_table_privilege('authenticated', 'public.hand_sources', 'delete'),
  'authenticated may only read hand_sources');
select ok(not has_table_privilege('anon', 'public.hand_sources', 'select'),
  'anon may not read hand_sources');
select ok(not has_table_privilege('authenticated', 'public.hands', 'update')
          and not has_table_privilege('authenticated', 'public.hands', 'delete'),
  'still no UPDATE or DELETE on hands');

-- --------------------------------------------------------------- refusals --

select pg_temp.act_as_anon();
select throws_ok($$ select public.ingest_hands(null, '[]') $$, '42501', null, 'anon is refused by the grant');

reset role;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$ select public.ingest_hands(null, '[]') $$, '42501',
  'You must be signed in to sync hands.', 'no auth.uid() is refused by the function');
select throws_ok($$ select public.register_hand_source('00000000-0000-0000-0000-0000000e2d01', 'f1') $$, '42501',
  'You must be signed in to sync hands.', 'so is registering a source');

-- ------------------------------------------------------------ the sources --

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2a01');
insert into ids values ('a', public.register_hand_source(
  '00000000-0000-0000-0000-0000000e2d01', 'f1', 'Laptop', 'WePlay - hands', 'weplay'));
select is(public.register_hand_source('00000000-0000-0000-0000-0000000e2d01', 'f1', 'Laptop 2', 'WePlay', 'weplay'),
  (select id from ids where name = 'a'), 'registering the same folder again returns the same source');
select is((select device_name || ' / ' || label from public.hand_sources where id = (select id from ids where name = 'a')),
  'Laptop 2 / WePlay', '... and renames it');
select throws_ok($$ select public.register_hand_source('00000000-0000-0000-0000-0000000e2d01', 'f2', null, '/Users/someone/hands') $$,
  '22023', null, 'a label with a path is refused');
select throws_ok($$ select public.register_hand_source(null, 'f2') $$, '22023', null, 'a source needs a device id');

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2b01');
insert into ids values ('b', public.register_hand_source('00000000-0000-0000-0000-0000000e2d01', 'f1'));
select isnt((select id from ids where name = 'b'), (select id from ids where name = 'a'),
  'the same device and folder id is another source for another account');
select is((select count(*)::int from public.hand_sources), 1, 'an account sees only its own sources');

-- ----------------------------------------------------------------- ingest --

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2a01');
select is(public.ingest_hands((select id from ids where name = 'a'),
            jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'), pg_temp.row('3'))) - 'rows',
  '{"received": 3, "inserted": 3, "duplicates": 0, "rejected": 0}'::jsonb, 'three new hands are inserted');

select is((select jsonb_build_object('origin', origin, 'std', standard_text, 'src', source_text,
                                     'site', site, 'stakes', stakes_label, 'hero', hero_name,
                                     'position', hero_position, 'class', hero_hand_class,
                                     'board', board_cards, 'rake', rake, 'profit', hero_profit,
                                     'players', player_count, 'owner', owner_id)
           from public.hands where hand_key = 'weplay:1'),
  jsonb_build_object('origin', 'desktop', 'std', null, 'src', null, 'site', 'weplay', 'stakes', '$0.5/$1',
                     'hero', 'HeroName', 'position', 'BTN', 'class', 'AKs',
                     'board', jsonb_build_array('2c', '3d', '4s', '5h'), 'rake', 6, 'profit', 200,
                     'players', 3, 'owner', '00000000-0000-0000-0000-0000000e2a01'),
  'the row is derived from the PHF and owned by the caller');

select is(public.ingest_hands((select id from ids where name = 'a'),
            jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'), pg_temp.row('3'))),
  '{"received": 3, "inserted": 0, "duplicates": 3, "rejected": 0, "rows": [
     {"handKey": "weplay:1", "status": "duplicate"},
     {"handKey": "weplay:2", "status": "duplicate"},
     {"handKey": "weplay:3", "status": "duplicate"}]}'::jsonb,
  'a replay is three duplicates');
select is((select count(*)::int from public.hands), 3, '... and stores nothing');
select is((select jsonb_build_object('received', hands_received, 'inserted', hands_inserted,
                                     'duplicate', hands_duplicate, 'rejected', hands_rejected)
           from public.hand_sources where id = (select id from ids where name = 'a')),
  '{"received": 6, "inserted": 3, "duplicate": 3, "rejected": 0}'::jsonb, 'the source counts both calls');
select is(public.ingest_hands((select id from ids where name = 'a'),
            jsonb_build_array(pg_temp.row('4'), pg_temp.row('4'))) -> 'rows',
  '[{"handKey": "weplay:4", "status": "inserted"}, {"handKey": "weplay:4", "status": "duplicate"}]'::jsonb,
  'a key twice in one batch: the first is inserted, the second a duplicate');
select is(public.ingest_hands((select id from ids where name = 'a'), '[]') - 'rows',
  '{"received": 0, "inserted": 0, "duplicates": 0, "rejected": 0}'::jsonb, 'an empty batch is fine');

-- ------------------------------------------------------ another account --

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2b01');
select is((select count(*)::int from public.hands), 0, 'B reads none of A''s hands');
select throws_ok(format($$ select public.ingest_hands(%L, '[]') $$, (select id from ids where name = 'a')),
  '23503', null, 'B cannot ingest into A''s source');
select throws_ok($$ select public.ingest_hands('00000000-0000-0000-0000-00000000dead', '[]') $$,
  '23503', null, '... with the same answer as for a source that does not exist');
select is((public.ingest_hands((select id from ids where name = 'b'),
            jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'))) ->> 'inserted')::int,
  2, 'the same hand keys in B''s library are B''s own rows');
reset role;
select is((select count(*)::int from public.hands where hand_key = 'weplay:1'), 2,
  'one hand key, two libraries, two rows');
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000e2a01'), 4,
  'A''s library is untouched');

-- ------------------------------------------------------------- rejections --

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2a01');
select is(public.ingest_hands((select id from ids where name = 'a'), jsonb_build_array(
    pg_temp.row('10'),
    jsonb_build_object('hand_key', 'weplay:11', 'phf', jsonb_set(pg_temp.phf('11'), '{meta,rawText}', '"Weplay Hand #11"')),
    jsonb_build_object('hand_key', 'weplay:12', 'phf', jsonb_set(pg_temp.phf('12'), '{schema}', '"phf/2"')),
    jsonb_build_object('hand_key', 'weplay:other', 'phf', pg_temp.phf('13')),
    '"not an object"'::jsonb,
    jsonb_build_object('hand_key', 'weplay:15', 'phf', jsonb_set(pg_temp.phf('15'), '{players,0,holeCards}', '["Xx","Kh"]')),
    jsonb_build_object('hand_key', 'weplay:16', 'phf', jsonb_set(pg_temp.phf('16'), '{game,smallBlind}', '"fifty"')),
    jsonb_build_object('hand_key', 'weplay:17', 'phf', jsonb_set(pg_temp.phf('17'), '{actions}',
      (select jsonb_agg(repeat('x', 1000)) from generate_series(1, 300)))),
    jsonb_build_object('hand_key', 'weplay:18', 'phf', jsonb_set(pg_temp.phf('18'), '{players,0,position}', '"MIDDLE"')),
    jsonb_build_object('hand_key', 'weplay:', 'phf', jsonb_set(jsonb_set(pg_temp.phf(''), '{meta,handId}', '""'), '{meta,handKey}', '""')),
    pg_temp.row('20')
  )),
  '{"received": 11, "inserted": 2, "duplicates": 0, "rejected": 9, "rows": [
     {"handKey": "weplay:10", "status": "inserted"},
     {"handKey": "weplay:11", "status": "rejected", "reason": "raw-text"},
     {"handKey": "weplay:12", "status": "rejected", "reason": "schema"},
     {"handKey": "weplay:other", "status": "rejected", "reason": "hand-key"},
     {"status": "rejected", "reason": "shape"},
     {"handKey": "weplay:15", "status": "rejected", "reason": "invalid", "field": "hero_cards"},
     {"handKey": "weplay:16", "status": "rejected", "reason": "shape"},
     {"handKey": "weplay:17", "status": "rejected", "reason": "too-large"},
     {"handKey": "weplay:18", "status": "rejected", "reason": "invalid", "field": "hero_position"},
     {"handKey": "weplay:", "status": "rejected", "reason": "hand-key"},
     {"handKey": "weplay:20", "status": "inserted"}]}'::jsonb,
  'each bad row is rejected with its reason; the good rows of the batch are stored');
select is((select last_rejection from public.hand_sources where id = (select id from ids where name = 'a')),
  'hand-key', 'the source keeps the last rejection');
select throws_ok(format($$ select public.ingest_hands(%L, (select jsonb_agg(pg_temp.row(g::text)) from generate_series(1, 501) g)) $$,
    (select id from ids where name = 'a')),
  '22023', null, 'more than 500 hands in one call is refused');
select throws_ok(format($$ select public.ingest_hands(%L, '{}') $$, (select id from ids where name = 'a')),
  '22023', null, 'so is a payload that is not an array');

-- ----------------------------------------------- the text rule, any writer --

select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, site)
                   values ('00000000-0000-0000-0000-0000000e2a01', 'desktop', 'weplay:30', pg_temp.phf('30'), 'weplay') $$,
  '42501', null, 'the direct path cannot write a desktop row (insert policy)');
select throws_ok($$ select public.save_hands(jsonb_build_array(jsonb_build_object(
                     'hand_key', 'weplay:31', 'phf', pg_temp.phf('31'), 'site', 'weplay'))) $$,
  '23514', null, 'a web row without standard text is refused');
select is((public.save_hands(jsonb_build_array(jsonb_build_object(
             'hand_key', 'weplay:32', 'phf', pg_temp.phf('32'), 'site', 'weplay',
             'standard_text', 'Poker Hand #32', 'origin', 'desktop'))) ->> 'inserted')::int,
  1, 'save_hands ignores an origin in the payload ...');
select is((select origin::text from public.hands where hand_key = 'weplay:32'), 'web', '... and writes a web row');

reset role;
select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, standard_text, site)
                   values ('00000000-0000-0000-0000-0000000e2a01', 'desktop', 'weplay:33', pg_temp.phf('33'), 'text', 'weplay') $$,
  '23514', null, 'no writer stores a desktop row with standard text');
select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, site)
                   values ('00000000-0000-0000-0000-0000000e2a01', 'desktop', 'weplay:34',
                           jsonb_set(pg_temp.phf('34'), '{meta,rawText}', '"Weplay Hand #34"'), 'weplay') $$,
  '23514', null, '... or with the original text in its PHF');
select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, site, source_text)
                   values ('00000000-0000-0000-0000-0000000e2a01', 'desktop', 'weplay:35', pg_temp.phf('35'), 'weplay', 'raw') $$,
  '23514', null, '... or with source text');

-- ----------------------------------------------------------------- budget --

select is((select hits from public.ingest_rate_limit where bucket = 'desktop_ingest:00000000-0000-0000-0000-0000000e2a01'),
  19, 'every received row is charged to the account''s bucket');
select is((select hits from public.ingest_rate_limit where bucket = 'hands_insert'), 1,
  'desktop rows do not spend the web''s global budget (one web row did)');

update public.ingest_rate_limit set hits = 149999
 where bucket = 'desktop_ingest:00000000-0000-0000-0000-0000000e2a01';
select pg_temp.act_as('00000000-0000-0000-0000-0000000e2a01');
select throws_ok(format($$ select public.ingest_hands(%L, jsonb_build_array(pg_temp.row('40'), pg_temp.row('41'))) $$,
    (select id from ids where name = 'a')),
  '53400', null, 'over 150 000 rows in ten minutes is refused');
select is((select count(*)::int from public.hands where hand_key in ('weplay:40', 'weplay:41')), 0,
  '... and writes nothing');
select is((public.ingest_hands((select id from ids where name = 'a'), jsonb_build_array(pg_temp.row('40'))) ->> 'inserted')::int,
  1, 'the last row of the budget still goes in');

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2b01');
select lives_ok(format($$ select public.ingest_hands(%L, jsonb_build_array(pg_temp.row('42'))) $$, (select id from ids where name = 'b')),
  'another account has its own budget');

reset role;
update public.ingest_rate_limit set hits = 1999999
 where bucket = 'desktop_ingest_day:00000000-0000-0000-0000-0000000e2b01';
select pg_temp.act_as('00000000-0000-0000-0000-0000000e2b01');
select throws_ok(format($$ select public.ingest_hands(%L, jsonb_build_array(pg_temp.row('43'), pg_temp.row('44'))) $$,
    (select id from ids where name = 'b')),
  '53400', null, 'over 2 000 000 rows in a day is refused');

-- ------------------------------------------------------------------ stats --

select pg_temp.act_as('00000000-0000-0000-0000-0000000e2a01');
select ok(exists (select 1 from public.hands_needing_stats('stats/2') n
                  join public.hands h on h.id = n.id where h.origin = 'desktop'),
  'the stats rebuild sees desktop rows');
-- A whole row, the way the rebuild sends them: one written directly for
-- weplay:2, sent again through the writer for weplay:1.
reset role;
insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands)
select id, owner_id, 'stats/2', 1, hand_key, 'weplay', true, 1 from public.hands
 where hand_key = 'weplay:2' and owner_id = '00000000-0000-0000-0000-0000000e2a01';
select pg_temp.act_as('00000000-0000-0000-0000-0000000e2a01');
select is((public.save_hand_stats(jsonb_build_array(
             (select to_jsonb(s) - 'hand_id' - 'owner_id' - 'created_at' from public.hand_stats s where s.hand_key = 'weplay:2')
               || '{"hand_key": "weplay:1"}'::jsonb)) ->> 'inserted')::int,
  1, 'save_hand_stats attaches to a desktop row');
select is((select h.origin::text from public.hand_stats s join public.hands h on h.id = s.hand_id
           where s.hand_key = 'weplay:1'), 'desktop', '... A''s own');

select * from finish();
rollback;
