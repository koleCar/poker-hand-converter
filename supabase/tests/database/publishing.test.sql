-- pgTAP: publishing (F7, #30 / #31) -- `20261012090000_forum_publishing.sql`.
--
-- The whole-corpus check (every one of ~8300 real hands, scrubbed in all three
-- modes, then serialized and replayed with no name, table, hand id, tournament
-- id, time of day or filename surviving) is too slow for CI and lives with the
-- PR that introduced this. What is here is the contract: the doors, the
-- refusals, and the invariants the table holds a document to.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(49);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at)
values
  ('00000000-0000-0000-0000-0000000000a1', 'pub.aaa@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000b1', 'pub.bbb@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000c1', 'pub.ccc@example.com', now(), now());

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
create function pg_temp.act_as_owner() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.act_as_owner()
  to anon, authenticated;

-- A hand that carries every field scrub_phf has to touch, with names chosen to
-- be easy to grep for.
create function pg_temp.fixture_phf(p_hand_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'meta', jsonb_build_object(
      'siteId', 'pokerstars', 'siteName', 'PokerStars', 'handId', p_hand_id, 'handKey', p_hand_id,
      'originalFilename', 'HH20260101 Zlatko Private.txt', 'parserId', 'pokerstars', 'parserVersion', '1',
      'warnings', jsonb_build_array(jsonb_build_object('code', 'x', 'message', 'line: SneakyPete: shows')),
      'rawText', 'PokerStars Hand #' || p_hand_id || ': SneakyPete raises',
      'parsedAt', '2026-09-01T10:11:12Z',
      'textStyle', jsonb_build_object('decimals', 'fixed2', 'headerPayload', 'Tournament #99887766, Table Zeta 7')),
    'game', jsonb_build_object('variant', 'holdem', 'straddles',
      jsonb_build_array(jsonb_build_object('seat', 3, 'player', 'StraddleSam', 'amount', 4, 'order', 1))),
    'table', jsonb_build_object('name', 'Zeta 7', 'maxSeats', 6, 'buttonSeat', 1),
    'tournament', jsonb_build_object('id', '99887766', 'name', 'Sunday Warmup'),
    'playedAt', '2026-08-30T21:43:07Z',
    'players', jsonb_build_array(
      jsonb_build_object('seat', 1, 'name', 'HeroHannah', 'isHero', true,  'position', 'BTN'),
      jsonb_build_object('seat', 2, 'name', 'SneakyPete', 'isHero', false, 'position', 'SB'),
      jsonb_build_object('seat', 3, 'name', 'StraddleSam', 'isHero', false, 'position', 'BB'),
      jsonb_build_object('seat', 4, 'name', 'al', 'isHero', false, 'position', null)),
    'actions', jsonb_build_array(
      jsonb_build_object('index', 0, 'player', 'SneakyPete', 'type', 'raise', 'label', 'raises to $4',
                         'rawLine', 'SneakyPete: raises $2 to $4', 'sourceLine', 7),
      jsonb_build_object('index', 1, 'player', 'al', 'type', 'call', 'label', 'calls $4 vs SneakyPete',
                         'rawLine', 'al: calls $4', 'sourceLine', 8),
      jsonb_build_object('index', 2, 'player', 'HeroHannah', 'type', 'show', 'label', 'shows',
                         'description', 'a pair of Aces', 'rawLine', 'HeroHannah: shows [Ah Ad]', 'sourceLine', 9)),
    'chipMovements', jsonb_build_array(jsonb_build_object('kind', 'splash-the-pot', 'fromPlayer', 'StraddleSam',
                                                          'raw', 'StraddleSam splashes $1')),
    'results', jsonb_build_object(
      'players', jsonb_build_array(
        jsonb_build_object('seat', 1, 'player', 'HeroHannah', 'raw', 'Seat 1: HeroHannah (button) won ($9)',
                           'handDescription', 'a pair of Aces'),
        jsonb_build_object('seat', 2, 'player', 'SneakyPete', 'raw', 'Seat 2: SneakyPete folded')),
      'winners', jsonb_build_array(jsonb_build_object('player', 'HeroHannah', 'seat', 1, 'amount', 9, 'runoutIndex', 0)))
  );
$$;

insert into public.hands (id, owner_id, hand_key, phf, standard_text, source_text, site, stakes_label,
                          table_name, played_at, total_pot, hero_profit, site_hand_id, tournament_id, source_filename)
values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'pokerstars:1001',
   pg_temp.fixture_phf('1001'), 'std', 'raw room text SneakyPete', 'pokerstars', '$1/$2',
   'Zeta 7', '2026-08-30T21:43:07Z', 900, 500, '1001', '99887766', 'HH Zlatko.txt'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', 'weplay:1002',
   pg_temp.fixture_phf('1002') || jsonb_build_object('comment', 'SneakyPete said gg'), 'std', 'raw', 'weplay', '$1/$2',
   null, now(), 0, 0, null, null, null),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000b1', 'pokerstars:2001',
   pg_temp.fixture_phf('2001'), 'std', 'raw', 'pokerstars', '$1/$2', null, now(), 0, 0, null, null, null),
  ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000000c1', 'pokerstars:3001',
   pg_temp.fixture_phf('3001'), 'std', 'raw', 'pokerstars', '$1/$2', null, now(), 0, 0, null, null, null);

-- ------------------------------------------------------------- scrub_phf --

select ok(public.phf_is_scrubbed(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms')), 'pseudonyms output passes the invariant');
select ok(public.phf_is_scrubbed(public.scrub_phf(pg_temp.fixture_phf('1'), 'positions')), 'positions output passes the invariant');
select ok(public.phf_is_scrubbed(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported')), 'as-imported output passes the invariant');
select ok(not public.phf_is_scrubbed(pg_temp.fixture_phf('1')), 'the raw document does not');

select is(
  (select jsonb_agg(p ->> 'name' order by (p ->> 'seat')::int)
     from jsonb_array_elements(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms') -> 'players') p),
  '["Hero", "Villain1", "Villain2", "Villain3"]'::jsonb, 'pseudonyms: Hero, then Villain1..n in seat order');
select is(
  (select jsonb_agg(p ->> 'name' order by (p ->> 'seat')::int)
     from jsonb_array_elements(public.scrub_phf(pg_temp.fixture_phf('1'), 'positions') -> 'players') p),
  '["Hero", "SB", "BB", "Seat4"]'::jsonb, 'positions: resolved position, Seat<n> when unknown');
select is(
  (select jsonb_agg(p ->> 'name' order by (p ->> 'seat')::int)
     from jsonb_array_elements(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') -> 'players') p),
  '["HeroHannah", "SneakyPete", "StraddleSam", "al"]'::jsonb, 'as-imported keeps the names');

select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms') #>> '{game,straddles,0,player}', 'Villain2',
  'straddles are renamed');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms') #>> '{chipMovements,0,fromPlayer}', 'Villain2',
  'chip movements are renamed');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms') #>> '{results,winners,0,player}', 'Hero',
  'winners are renamed');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms') #>> '{actions,1,label}', 'calls $4 vs Villain1',
  'a name inside a label is replaced as a whole token');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms') #>> '{actions,0,label}', 'raises to $4',
  '... and a short name ("al") does not eat the inside of other words');

select ok(
  (select bool_and(coalesce(a ->> 'rawLine', '') = '' and a -> 'sourceLine' = 'null'::jsonb)
     from jsonb_array_elements(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') -> 'actions') a),
  'raw action lines are gone even as-imported');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') #> '{table,name}', 'null'::jsonb, 'table name gone as-imported');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') #>> '{tournament,id}', '', 'tournament id gone as-imported');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') -> 'playedAt', 'null'::jsonb, 'exact time gone as-imported');
select is(public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') #>> '{meta,handId}', '', 'room hand id gone as-imported');
select ok(not (public.scrub_phf(pg_temp.fixture_phf('1'), 'as-imported') #> '{meta,textStyle}' ? 'headerPayload'),
  'the room''s header line is gone as-imported');

select ok(
  public.scrub_phf(pg_temp.fixture_phf('1'), 'pseudonyms')::text !~ '(SneakyPete|StraddleSam|HeroHannah|Zeta 7|99887766|Zlatko|21:43)',
  'nothing identifying survives anywhere in a pseudonymised document');

-- ------------------------------------------------------------ publish_hand --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((public.publish_hand('00000000-0000-0000-0000-00000000aa01') ->> 'publicId') ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{10}$',
  'A publishes their own hand');
select is((public.publish_hand('00000000-0000-0000-0000-00000000aa01') ->> 'alreadyPublished')::boolean, true,
  'publishing the same hand again returns the same publication');

select pg_temp.act_as_owner();
select set_config('test.pid', (select public_id from public.published_hands
                                where author_id = '00000000-0000-0000-0000-0000000000a1'), true);
select is((select count(*)::int from public.published_hands where author_id = '00000000-0000-0000-0000-0000000000a1'), 1,
  '... and there is one copy, not two');
select is((select mode::text from public.published_hands where author_id = '00000000-0000-0000-0000-0000000000a1'), 'pseudonyms',
  'the default mode is pseudonyms');
select is((select played_on from public.published_hands where author_id = '00000000-0000-0000-0000-0000000000a1'), '2026-08-30'::date,
  'played_on is the date only');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'published_hands'
      and column_name in ('source_text', 'hand_key', 'site_hand_id', 'table_name', 'player_names',
                          'winners', 'tournament_id', 'played_at', 'source_filename', 'standard_text')),
  0, 'none of the identifying columns exists on published_hands');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.publish_hand('00000000-0000-0000-0000-00000000aa01') $$, '22023', 'That hand does not exist.',
  'B cannot publish A''s hand ...');
select throws_ok($$ select public.publish_hand('00000000-0000-0000-0000-00000000ffff') $$, '22023', 'That hand does not exist.',
  '... and gets exactly the error a nonexistent hand gets');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.publish_hand('00000000-0000-0000-0000-00000000aa02') $$, '22023',
  'This hand could not be anonymised safely, so it was not published. Nothing was made public.',
  'a name in a field the scrubber does not know about stops the publication');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select throws_ok($$ select public.publish_hand('00000000-0000-0000-0000-00000000cc01') $$, '22023', null,
  'a ten-minute-old account cannot publish (posting gate)');

select pg_temp.act_as_owner();
insert into public.publish_blocked_sites (site, reason) values ('pokerstars', 'test');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.publish_hand('00000000-0000-0000-0000-00000000bb01') $$, '22023',
  'Hands from this poker room cannot be published.', 'the per-room kill switch holds');
select pg_temp.act_as_owner();
delete from public.publish_blocked_sites where site = 'pokerstars';

select pg_temp.act_as_anon();
select throws_ok($$ select public.publish_hand('00000000-0000-0000-0000-00000000aa01') $$, '42501', null,
  'anon cannot publish');

-- ------------------------------------------------------- the grant wall --

select pg_temp.act_as_owner();
select throws_ok(
  $$ insert into public.published_hands (public_id, mode, phf, site)
     values ('2222222222', 'as-imported', '{"meta": {"rawText": "SneakyPete raises"}}', 'x') $$,
  '23514', null, 'even the owner role cannot store an unscrubbed document: the CHECK is the last line');

select pg_temp.act_as_anon();
select is((select count(*)::int from public.published_hands where public_id = current_setting('test.pid')), 1, 'anon reads visible publications');
select throws_ok($$ insert into public.published_hands (public_id, mode, phf, site) values ('3333333333', 'pseudonyms', '{}', 'x') $$,
  '42501', null, 'anon cannot insert');
select throws_ok($$ update public.published_hands set title = 'x' $$, '42501', null, 'anon cannot update');
select throws_ok($$ select * from public.published_hand_sources $$, '42501', null, 'which private row it came from is sealed');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ delete from public.published_hands $$, '42501', null, 'an account cannot delete publications');
select throws_ok($$ select * from public.publish_blocked_sites $$, '42501', null, 'the kill switch table is sealed');

-- ------------------------------------------------------------- reading --

select pg_temp.act_as_anon();
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     public.read_published_hand(current_setting('test.pid'))) k),
  array['author', 'createdAt', 'gameFormat', 'heroPosition', 'mode', 'phf', 'playedOn', 'publicId', 'site', 'stakesLabel', 'status', 'title'],
  'read_published_hand names exactly these keys');
select matches(
  public.read_published_hand(current_setting('test.pid')) #>> '{author,username}',
  '^user_', 'the author is their public username');
select is(public.read_published_hand('nonexistnt'), null, 'an unknown id is null');
select is(public.read_published_hand('../../etc'), null, 'a malformed id is null');
select is(jsonb_array_length(public.published_hands_by_author(
    (select username from public.profiles_public where id = '00000000-0000-0000-0000-0000000000a1'))), 1,
  'a profile lists its publications');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(public.unpublish_hand(current_setting('test.pid')), false,
  'B cannot unpublish A''s hand');
select is(public.my_published_hand_ids(array['00000000-0000-0000-0000-00000000aa01'::uuid]), '{}'::jsonb,
  'B cannot learn which of A''s hands are published');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.my_published_hand_ids(array['00000000-0000-0000-0000-00000000aa01'::uuid]) ? '00000000-0000-0000-0000-00000000aa01',
  true, 'A can');
select is(public.unpublish_hand(current_setting('test.pid')), true, 'A unpublishes their own');

select pg_temp.act_as_anon();
select is(public.read_published_hand(current_setting('test.pid')),
  jsonb_build_object('status', 'deleted', 'publicId', current_setting('test.pid')),
  'a deleted publication returns its status and nothing else -- no document, no author');

select is((select count(*)::int from public.published_hands where public_id = current_setting('test.pid')), 0,
  '... and the row itself is no longer readable');

select * from finish();
rollback;
