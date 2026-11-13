-- pgTAP: a hand stored as its standard text -- `20271114090000_text_storage.sql`.
--
-- What has to hold:
--
--   * a writer that vouches for a text (`ingest_hands` with `standard_text`,
--     `save_hands` with `text_verified`) stores the text and no PHF, every
--     column still derived from the PHF it sent (`table_set`, `fast_fold`
--     included); without one the row keeps its PHF; a direct insert with a
--     display copy of the text keeps its PHF too; a row is never neither;
--   * `table_set` is filled at insert, and the leak readers' trigger reads it;
--   * the whole-hand readers return the text and the restore columns for a
--     text-only row, the PHF for the others;
--   * `publish_hand` and `create_share` take the client's parse of a
--     text-only row only when it is that hand: a matching document is
--     published / shared (the share keeps a redacted snapshot that
--     `read_share` serves), a tampered one is refused, and a row with a PHF
--     ignores `p_phf`;
--   * `hands_store_text` (service role only) snapshots the shares, fills the
--     set, stores the text and drops the PHF, and skips a row already done;
--   * `move_gg_cash_hands` moves a text-only row.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(45);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000007e501', 'text.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000007e502', 'text.b@example.com', now() - interval '40 days', now() - interval '40 days');

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

-- A six-handed 100bb NLHE cash hand (so it has a chart set), fast-fold.
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
    'table', jsonb_build_object('name', 'Table 1', 'maxSeats', 6, 'fastFold', 'Rush'),
    'tournament', null,
    'players', jsonb_build_array(
      jsonb_build_object('seat', 1, 'name', 'HeroName', 'isHero', true, 'position', 'BTN', 'startingStack', 10000,
                         'holeCards', jsonb_build_array('Ah', 'Kh')),
      jsonb_build_object('seat', 2, 'name', 'Villain1', 'isHero', false, 'position', 'SB', 'startingStack', 10000),
      jsonb_build_object('seat', 3, 'name', 'Villain2', 'isHero', false, 'position', 'BB', 'startingStack', 10000),
      jsonb_build_object('seat', 4, 'name', 'Villain3', 'isHero', false, 'position', 'UTG', 'startingStack', 10000),
      jsonb_build_object('seat', 5, 'name', 'Villain4', 'isHero', false, 'position', 'HJ', 'startingStack', 10000),
      jsonb_build_object('seat', 6, 'name', 'Villain5', 'isHero', false, 'position', 'CO', 'startingStack', 10000)),
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
-- A standard text stands in for the real one: the server never parses it.
create function pg_temp.row(p_id text, p_text boolean) returns jsonb language sql as $$
  select jsonb_build_object('hand_key', 'weplay:' || p_id, 'phf', pg_temp.phf(p_id))
         || case when p_text then jsonb_build_object('standard_text', 'Poker Hand #' || p_id || ': text') else '{}'::jsonb end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.phf(text), pg_temp.row(text, boolean)
  to anon, authenticated;

create temporary table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated, service_role;

-- ---------------------------------------------------------------- shape --

select col_is_null('public', 'hands', 'phf', 'hands.phf is nullable');
select has_column('public', 'hands', 'table_set', 'hands.table_set exists');
select ok(not has_function_privilege('authenticated', 'public.hands_store_text(jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.hands_store_text(jsonb)', 'execute')
          and has_function_privilege('service_role', 'public.hands_store_text(jsonb)', 'execute'),
  'hands_store_text is the service role''s alone');
select ok(not has_function_privilege('authenticated', 'public.hand_phf_matches(public.hands, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.hand_phf_matches(public.hands, jsonb)', 'execute'),
  'hand_phf_matches is internal');
select ok(has_function_privilege('authenticated', 'public.publish_hand(uuid, public.publish_mode, text, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.publish_hand(uuid, public.publish_mode, text, jsonb)', 'execute'),
  'publish_hand(.., p_phf) is authenticated''s');
select is((select count(*)::int from pg_proc where proname = 'publish_hand' and pronamespace = 'public'::regnamespace),
  1, 'one publish_hand: the three-argument form is gone');
select ok(not has_function_privilege('anon', 'public.hands_needing_stats(text, uuid, integer, boolean, text)', 'execute')
          and not has_function_privilege('anon', 'public.hands_needing_analysis(text, uuid, integer)', 'execute')
          and not has_function_privilege('anon', 'public.hands_needing_analysis_recent(text, timestamptz, uuid, integer)', 'execute')
          and has_function_privilege('authenticated', 'public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer)', 'execute'),
  'the readers stay authenticated-only');

-- ---------------------------------------------------------------- ingest --

select pg_temp.act_as('00000000-0000-0000-0000-00000007e501');
insert into ids values ('src', public.register_hand_source('00000000-0000-0000-0000-00000007e5d1', 'f1'));
select is(public.ingest_hands((select id from ids where name = 'src'),
            jsonb_build_array(pg_temp.row('1', true), pg_temp.row('2', false))) - 'rows',
  '{"received": 2, "inserted": 2, "duplicates": 0, "rejected": 0}'::jsonb, 'a row with a text and one without are stored');

reset role;
select is((select jsonb_build_object('phf', phf, 'std', standard_text, 'set', table_set, 'fast', fast_fold,
                                     'profit', hero_profit, 'players', player_count, 'class', hero_hand_class)
           from public.hands where hand_key = 'weplay:1'),
  jsonb_build_object('phf', null, 'std', 'Poker Hand #1: text', 'set', 'nlhe-cash-6max-100bb', 'fast', 'Rush',
                     'profit', 200, 'players', 6, 'class', 'AKs'),
  'with a text: no PHF, the text, and every column derived from the PHF it sent');
select is((select jsonb_build_object('phf', phf is not null, 'std', standard_text, 'set', table_set)
           from public.hands where hand_key = 'weplay:2'),
  jsonb_build_object('phf', true, 'std', null, 'set', 'nlhe-cash-6max-100bb'),
  'without one: the PHF stays, and table_set is filled');
select is(current_setting('rail.hands_text_verified', true), '', 'the writer''s flag does not outlive its insert');

select pg_temp.act_as('00000000-0000-0000-0000-00000007e501');
select is((public.ingest_hands((select id from ids where name = 'src'),
            jsonb_build_array(pg_temp.row('3', false) || '{"standard_text": 7}'::jsonb)) -> 'rows' -> 0 ->> 'reason'),
  'shape', 'a standard_text that is not a string is refused');
select is((public.ingest_hands((select id from ids where name = 'src'),
            jsonb_build_array(pg_temp.row('4', false) || jsonb_build_object('standard_text', repeat('x', 200001)))) -> 'rows' -> 0 ->> 'reason'),
  'too-large', 'so is one over 200 000 characters');
select is((public.ingest_hands((select id from ids where name = 'src'),
            jsonb_build_array(pg_temp.row('5', false) || '{"standard_text": ""}'::jsonb)) -> 'rows' -> 0 ->> 'status'),
  'inserted', 'an empty text is no text ...');
reset role;
select ok((select phf is not null and standard_text is null from public.hands where hand_key = 'weplay:5'),
  '... and the row keeps its PHF');

-- ------------------------------------------------------------ save_hands --

select pg_temp.act_as('00000000-0000-0000-0000-00000007e502');
select is((public.save_hands(jsonb_build_array(
            jsonb_build_object('hand_key', 'weplay:11', 'phf', pg_temp.phf('11'), 'site', 'weplay',
                               'standard_text', 'Poker Hand #11', 'text_verified', true, 'player_count', 6),
            jsonb_build_object('hand_key', 'weplay:12', 'phf', pg_temp.phf('12'), 'site', 'weplay',
                               'standard_text', 'Poker Hand #12', 'player_count', 6))) ->> 'inserted')::int,
  2, 'save_hands stores both rows');
reset role;
select is((select jsonb_object_agg(hand_key, jsonb_build_object('phf', phf is not null, 'std', standard_text, 'set', table_set))
           from public.hands where hand_key in ('weplay:11', 'weplay:12')),
  jsonb_build_object(
    'weplay:11', jsonb_build_object('phf', false, 'std', 'Poker Hand #11', 'set', 'nlhe-cash-6max-100bb'),
    'weplay:12', jsonb_build_object('phf', true, 'std', null, 'set', 'nlhe-cash-6max-100bb')),
  'a verified text replaces the PHF; an unverified display copy is not stored and the PHF stays');

-- A direct insert (a fixture, a copy) with a display copy keeps its PHF.
insert into public.hands (owner_id, hand_key, phf, standard_text, site)
values ('00000000-0000-0000-0000-00000007e502', 'weplay:13', pg_temp.phf('13'), 'std', 'weplay');
select ok((select phf is not null and standard_text = 'std' and table_set = 'nlhe-cash-6max-100bb'
           from public.hands where hand_key = 'weplay:13'),
  'a writer that does not vouch for the text keeps the PHF (and the set is filled)');
select throws_ok($$ insert into public.hands (owner_id, hand_key, phf, standard_text, site)
                   values ('00000000-0000-0000-0000-00000007e502', 'weplay:14', null, null, 'weplay') $$,
  '23514', null, 'a row with neither a PHF nor a text is refused');

-- ------------------------------------------------------- the leak readers --

insert into ids select 'h1', id from public.hands where hand_key = 'weplay:1';
insert into ids select 'h2', id from public.hands where hand_key = 'weplay:2';
select is((select public.analysis_hand_table_set(null)), '', 'no document, no set');

-- ------------------------------------------------------ whole-hand readers --

select pg_temp.act_as('00000000-0000-0000-0000-00000007e501');
select is((select jsonb_build_object('phf', phf, 'std', standard_text, 'key', hand_key, 'site', site,
                                     'version', parser_version, 'file', source_filename, 'created', created_at is not null)
           from public.hands_needing_stats('stats/text-test') where id = (select id from ids where name = 'h1')),
  jsonb_build_object('phf', null, 'std', 'Poker Hand #1: text', 'key', 'weplay:1', 'site', 'weplay',
                     'version', '1.0.0', 'file', 'HH20261001.txt', 'created', true),
  'hands_needing_stats: a text-only row comes with its text and the restore columns');
select is((select jsonb_build_object('phf', phf ->> 'schema', 'std', standard_text)
           from public.hands_needing_stats('stats/text-test') where id = (select id from ids where name = 'h2')),
  jsonb_build_object('phf', 'phf/1', 'std', null),
  '... a row with a PHF with its PHF');
select is((select jsonb_build_object('phf', phf is null, 'std', standard_text, 'site', site)
           from public.hands_needing_analysis('analysis/1') where id = (select id from ids where name = 'h1')),
  jsonb_build_object('phf', true, 'std', 'Poker Hand #1: text', 'site', 'weplay'),
  'hands_needing_analysis: the same');
select is((select count(*)::int from public.hands_needing_analysis_recent('analysis/1')
           where standard_text is not null and phf is null),
  1, 'hands_needing_analysis_recent too');
select is((select count(*)::int from public.hands_needing_analysis_recent_scan('analysis/1')
           where standard_text is not null and phf is null),
  1, '... and its full scan');
select is((select phf -> 'meta' ? 'rawText' from public.hands_needing_analysis('analysis/1')
           where id = (select id from ids where name = 'h2')),
  false, 'a PHF row''s document is still trimmed');

-- ------------------------------------------------------------- publishing --

select throws_ok(format($$ select public.publish_hand(%L, 'pseudonyms', null) $$, (select id from ids where name = 'h1')),
  '22023', 'This hand is stored as text: send its parsed document to publish it.',
  'a text-only row cannot be published without its document');
select throws_ok(format($$ select public.publish_hand(%L, 'pseudonyms', null, %L) $$,
                        (select id from ids where name = 'h1'),
                        jsonb_set(pg_temp.phf('1'), '{results,heroNet}', '9999')),
  '22023', 'The hand sent is not the stored hand, so it was not published.',
  'a document with another result is refused');
select throws_ok(format($$ select public.publish_hand(%L, 'pseudonyms', null, %L) $$,
                        (select id from ids where name = 'h1'), pg_temp.phf('2')),
  '22023', 'The hand sent is not the stored hand, so it was not published.',
  'so is another hand');
select throws_ok(format($$ select public.publish_hand(%L, 'pseudonyms', null, %L) $$,
                        (select id from ids where name = 'h1'),
                        jsonb_set(pg_temp.phf('1'), '{players,1,name}', '"Somebody"')),
  '22023', 'The hand sent is not the stored hand, so it was not published.',
  'so is one with another player');
select is((public.publish_hand((select id from ids where name = 'h1'), 'pseudonyms', null,
                               jsonb_set(pg_temp.phf('1'), '{meta,parsedAt}', '"2026-11-13T10:00:00.000Z"'))
           ->> 'alreadyPublished')::boolean,
  false, 'the matching document is published');
reset role;
select ok((select public.phf_is_scrubbed(p.phf) and p.hero_profit = 200
           from public.published_hands p
           join public.published_hand_sources s on s.published_id = p.id
           where s.hand_id = (select id from ids where name = 'h1')),
  '... scrubbed, as any publication');
select pg_temp.act_as('00000000-0000-0000-0000-00000007e501');
select is((public.publish_hand((select id from ids where name = 'h2'), 'pseudonyms', null,
                               jsonb_set(pg_temp.phf('2'), '{results,heroNet}', '9999'))
           ->> 'alreadyPublished')::boolean,
  false, 'a row with a PHF publishes its own and ignores p_phf');
reset role;
select is((select (p.phf -> 'results' ->> 'heroNet')::int
           from public.published_hands p
           join public.published_hand_sources s on s.published_id = p.id
           where s.hand_id = (select id from ids where name = 'h2')),
  200, '... (the stored result, not the one sent)');

-- ---------------------------------------------------------------- sharing --

select pg_temp.act_as('00000000-0000-0000-0000-00000007e501');
select throws_ok(format($$ select public.create_share(%L) $$, (select id from ids where name = 'h1')),
  '22023', 'This hand is stored as text: send its parsed document to share it.',
  'a text-only row cannot be shared without its document');
select throws_ok(format($$ select public.create_share(%L, %L) $$, (select id from ids where name = 'h1'),
                        jsonb_set(pg_temp.phf('1'), '{board,runouts,0,turn}', '"9h"')),
  '22023', null, 'nor with an edited one');
insert into ids
select 'share1', (public.create_share((select id from ids where name = 'h1'),
                                      jsonb_set(pg_temp.phf('1'), '{meta,rawText}', '"room text"'),
                                      null, 'T', false, true) ->> 'id')::uuid;
reset role;
select is((select jsonb_build_object('hand', hand_id = (select id from ids where name = 'h1'),
                                     'raw', phf -> 'meta' ? 'rawText', 'heroNet', phf -> 'results' -> 'heroNet')
           from public.shares where id = (select id from ids where name = 'share1')),
  jsonb_build_object('hand', true, 'raw', false, 'heroNet', 200),
  'the share keeps a redacted snapshot of the matching document');
select is((select public.read_share(slug) -> 'phf' -> 'results' ->> 'heroNet'
           from public.shares where id = (select id from ids where name = 'share1')),
  '200', 'read_share serves it');
select pg_temp.act_as('00000000-0000-0000-0000-00000007e501');
insert into ids
select 'share2', (public.create_share((select id from ids where name = 'h2'), pg_temp.phf('1')) ->> 'id')::uuid;
reset role;
select ok((select phf is null from public.shares where id = (select id from ids where name = 'share2')),
  'a share of a row with a PHF follows the row (no snapshot)');

-- ------------------------------------------------------- hands_store_text --

set local role service_role;
select is(public.hands_store_text(jsonb_build_array(
            jsonb_build_object('id', (select id from ids where name = 'h2'), 'standard_text', 'Poker Hand #2: text'),
            jsonb_build_object('id', (select id from ids where name = 'h1'), 'standard_text', 'again'))),
  '{"received": 2, "stored": 1, "skipped": 1, "sharesSnapshotted": 1}'::jsonb,
  'hands_store_text stores the row with a PHF and skips the one already done');
reset role;
select is((select jsonb_build_object('phf', phf, 'std', standard_text, 'set', table_set)
           from public.hands where id = (select id from ids where name = 'h2')),
  jsonb_build_object('phf', null, 'std', 'Poker Hand #2: text', 'set', 'nlhe-cash-6max-100bb'),
  '... text in, PHF out, set kept');
select is((select public.read_share(slug) -> 'phf' -> 'results' ->> 'heroNet'
           from public.shares where id = (select id from ids where name = 'share2')),
  '200', 'its share link was snapshotted first and still reads');
select is((select standard_text from public.hands where id = (select id from ids where name = 'h1')),
  'Poker Hand #1: text', 'the skipped row is untouched');

-- ------------------------------------------------------ move_gg_cash_hands --

select set_config('request.jwt.claims', '', true);
insert into public.hands (owner_id, hand_key, phf, standard_text, site, site_hand_id, player_names)
values ('00000000-0000-0000-0000-00000007e502', 'standard:HD123', null, 'Poker Hand #HD123: text',
        'standard', 'HD123', '{a,b}');
select is(public.move_gg_cash_hands('00000000-0000-0000-0000-00000007e502'), 1, 'a text-only GG cash row is moved');
select is((select jsonb_build_object('key', hand_key, 'site', site, 'phf', phf, 'std', standard_text)
           from public.hands where site_hand_id = 'HD123'),
  jsonb_build_object('key', 'ggpoker:HD123', 'site', 'ggpoker', 'phf', null, 'std', 'Poker Hand #HD123: text'),
  '... with its text, and no PHF made up');

select * from finish();
rollback;
