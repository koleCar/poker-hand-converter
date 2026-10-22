-- pgTAP: share links hide the players' names by default (R4.5) --
-- `20270623090000_share_names.sql`.
--
-- What has to hold:
--
--   * `shares.show_names` exists, not null, default false - a row written
--     without it (every share made before R4.5) is anonymised;
--   * `read_share` (anon, as a stranger with the link) returns, for a hidden
--     link: the hand through scrub_phf(pseudonyms), no standard text, no
--     title, and no screen name, table name, room hand number, tournament id
--     or exact time anywhere in the payload - for a stored hand and for an
--     embedded copy alike; the deprecated `resolve_share` the same;
--   * a name the scrubber does not know about fails closed (no hand at all);
--     a positional room's position-label "names" do not trip it;
--   * the owner opts in per link (`create_share p_show_names`,
--     `set_share_names`), and only the owner: another account and a slug
--     that does not exist get the same error; anon cannot call the switch;
--   * the internal scrubber wrapper is executable by nobody.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(40);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000045a1', 'names.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000045b1', 'names.b@example.com', now() - interval '40 days', now() - interval '40 days');

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
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.act_as_owner() to anon, authenticated;

-- A made-up hand whose names are easy to grep for: the hero, two opponents,
-- a straddler; the table, the room's hand number, a tournament id and a
-- to-the-second time, each of which names the table.
create function pg_temp.fixture_phf(p_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'meta', jsonb_build_object('siteId', 'pokerstars', 'siteName', 'PokerStars', 'handId', p_id, 'handKey', p_id,
      'originalFilename', 'HH Zlatko Private.txt', 'parserId', 'pokerstars', 'parserVersion', '1', 'warnings', '[]'::jsonb,
      'rawText', 'PokerStars Hand #' || p_id || ': SneakyPete raises', 'parsedAt', '2026-09-01T10:11:12Z',
      'textStyle', jsonb_build_object('decimals', 'fixed2', 'headerPayload', 'Table Zeta 7')),
    'game', jsonb_build_object('variant', 'holdem', 'limit', 'nl', 'label', 'Hold''em No Limit',
      'straddles', jsonb_build_array(jsonb_build_object('seat', 3, 'player', 'StraddleSam', 'amount', 4, 'order', 1))),
    'table', jsonb_build_object('name', 'Zeta 7', 'maxSeats', 6, 'buttonSeat', 1),
    'tournament', jsonb_build_object('id', '99887766', 'name', 'Sunday Warmup'),
    'playedAt', '2026-08-30T21:43:07Z',
    'players', jsonb_build_array(
      jsonb_build_object('seat', 1, 'name', 'HeroHannah', 'isHero', true, 'position', 'BTN'),
      jsonb_build_object('seat', 2, 'name', 'SneakyPete', 'isHero', false, 'position', 'SB'),
      jsonb_build_object('seat', 3, 'name', 'StraddleSam', 'isHero', false, 'position', 'BB')),
    'actions', jsonb_build_array(
      jsonb_build_object('index', 0, 'street', 'preflop', 'seat', 2, 'player', 'SneakyPete', 'type', 'raise',
                         'label', 'raises to $4', 'rawLine', 'SneakyPete: raises $2 to $4', 'sourceLine', 7),
      jsonb_build_object('index', 1, 'street', 'preflop', 'seat', 1, 'player', 'HeroHannah', 'type', 'call',
                         'label', 'calls $4 vs SneakyPete', 'rawLine', 'HeroHannah: calls $4', 'sourceLine', 8)),
    'chipMovements', '[]'::jsonb,
    'results', jsonb_build_object('totalPot', 9,
      'players', jsonb_build_array(jsonb_build_object('seat', 1, 'player', 'HeroHannah',
                                                      'raw', 'Seat 1: HeroHannah (button) won ($9)')),
      'winners', jsonb_build_array(jsonb_build_object('player', 'HeroHannah', 'seat', 1, 'amount', 9, 'runoutIndex', 0))));
$$;
grant execute on function pg_temp.fixture_phf(text) to anon, authenticated;

-- What must never reach a stranger from a hidden link.
create function pg_temp.leaks(p jsonb) returns boolean language sql as $$
  select coalesce(p::text ~ '(HeroHannah|SneakyPete|StraddleSam|Zeta 7|99887766|Zlatko|2026-08-30T21|"handId": "45)', false);
$$;
grant execute on function pg_temp.leaks(jsonb) to anon, authenticated;

insert into public.hands (id, owner_id, hand_key, phf, standard_text, source_text, site, played_at, hero_seat) values
  ('00000000-0000-0000-0000-000000004501', '00000000-0000-0000-0000-0000000045a1', 'pokerstars:4501',
   pg_temp.fixture_phf('4501'), 'PokerStars Hand #4501: Table ''Zeta 7'' Seat 1: HeroHannah, Seat 2: SneakyPete',
   'raw', 'pokerstars', '2026-08-30T21:43:07Z', 1),
  -- A name where the scrubber does not look (`game.label`): must fail closed.
  ('00000000-0000-0000-0000-000000004502', '00000000-0000-0000-0000-0000000045a1', 'pokerstars:4502',
   jsonb_set(pg_temp.fixture_phf('4502'), '{game,label}', '"Hold''em vs SneakyPete"'),
   'std', 'raw', 'pokerstars', now(), 1),
  -- A positional room: the names are the seats' own position labels.
  ('00000000-0000-0000-0000-000000004503', '00000000-0000-0000-0000-0000000045a1', 'pokerstars:4503',
   jsonb_set(jsonb_set(jsonb_set(pg_temp.fixture_phf('4503'),
     '{players}', jsonb_build_array(
       jsonb_build_object('seat', 1, 'name', 'BTN', 'isHero', false, 'position', 'BTN'),
       jsonb_build_object('seat', 2, 'name', 'SB', 'isHero', true, 'position', 'SB'))),
     '{actions}', jsonb_build_array(jsonb_build_object('index', 0, 'street', 'preflop', 'seat', 1, 'player', 'BTN',
       'type', 'raise', 'label', 'raises to $4'))),
     '{results,winners}', '[]'::jsonb),
   'std', 'raw', 'pokerstars', now(), 2),
  -- Ignition: role labels for names, which survive in text the scrubber
  -- does not touch (here `game.label`) - seat labels, not people.
  ('00000000-0000-0000-0000-000000004504', '00000000-0000-0000-0000-0000000045a1', 'ignition:4504',
   jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(pg_temp.fixture_phf('4504'), '{meta,siteId}', '"ignition"'),
     '{game,label}', '"Hold''em No Limit - Dealer deals"'),
     '{players}', jsonb_build_array(
       jsonb_build_object('seat', 1, 'name', 'Dealer', 'isHero', false, 'position', 'BTN'),
       jsonb_build_object('seat', 2, 'name', 'Small Blind', 'isHero', false, 'position', 'SB'),
       jsonb_build_object('seat', 3, 'name', 'Big Blind', 'isHero', true, 'position', 'BB'))),
     '{actions}', jsonb_build_array(jsonb_build_object('index', 0, 'street', 'preflop', 'seat', 2,
       'player', 'Small Blind', 'type', 'small-blind', 'label', 'Small Blind : Small Blind $1'))),
     '{results,winners}', '[]'::jsonb),
   'std', 'raw', 'ignition', now(), 3);

-- A share made before R4.5: written without the column.
insert into public.shares (slug, hand_id, owner_id, title, spoilers)
values ('prevshare45', '00000000-0000-0000-0000-000000004501', '00000000-0000-0000-0000-0000000045a1',
        'Old title naming SneakyPete', true);

-- ------------------------------------------------------------- the column --

select col_not_null('public', 'shares', 'show_names', 'show_names is not null');
select col_default_is('public', 'shares', 'show_names', 'false', 'show_names defaults to false');
select is((select show_names from public.shares where slug = 'prevshare45'), false,
  'a share written without the column (every pre-R4.5 link) hides names');

-- ------------------------------------------------- a hidden link, as anon --

select pg_temp.act_as_anon();

select is((public.read_share('prevshare45') ->> 'showNames')::boolean, false, 'read_share says the link hides names');
select is(
  (select jsonb_agg(p ->> 'name' order by (p ->> 'seat')::int)
     from jsonb_array_elements(public.read_share('prevshare45') #> '{phf,players}') p),
  '["Hero", "Villain1", "Villain2"]'::jsonb, 'the players are Hero, Villain1..n in seat order');
select is(public.read_share('prevshare45') #>> '{phf,actions,1,label}', 'calls $4 vs Villain1',
  'a name inside an action label is replaced');
select is(public.read_share('prevshare45') #>> '{phf,game,straddles,0,player}', 'Villain2', 'the straddler is renamed');
select is(public.read_share('prevshare45') #>> '{phf,results,winners,0,player}', 'Hero', 'the winner is renamed');
select is(public.read_share('prevshare45') -> 'standardText', 'null'::jsonb, 'no standard text (the room''s, with names)');
select is(public.read_share('prevshare45') -> 'title', 'null'::jsonb, 'no title (free text from the sharing client)');
select is(public.read_share('prevshare45') #> '{phf,table,name}', 'null'::jsonb, 'no table name');
select is(public.read_share('prevshare45') #> '{phf,playedAt}', 'null'::jsonb, 'no exact time');
select is(public.read_share('prevshare45') #>> '{phf,meta,handId}', '', 'no room hand number');
select ok(not pg_temp.leaks(public.read_share('prevshare45')),
  'no name, table, tournament id, filename, time or hand number anywhere in the payload');
select is((public.read_share('prevshare45') ->> 'spoilers')::boolean, true, 'the spoilers flag is untouched');
select is(public.read_share('prevshare45') ->> 'handId', '00000000-0000-0000-0000-000000004501',
  'the stored hand''s id is still there for its owner');
select ok(not pg_temp.leaks(public.resolve_share('prevshare45')), 'the deprecated resolve_share is anonymised too');

-- ------------------------------------------------- created by the owner --

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select set_config('test.stored', public.create_share('00000000-0000-0000-0000-000000004501', null, null, 'A title') ->> 'slug', true);
select set_config('test.embedded', public.create_share(null, pg_temp.fixture_phf('4599'), 'Seat 1: HeroHannah', null) ->> 'slug', true);
select set_config('test.named', public.create_share('00000000-0000-0000-0000-000000004501', null, null, 'Named', false, true) ->> 'slug', true);
select set_config('test.unknownfield', public.create_share('00000000-0000-0000-0000-000000004502') ->> 'slug', true);
select set_config('test.positional', public.create_share('00000000-0000-0000-0000-000000004503') ->> 'slug', true);
select set_config('test.ignition', public.create_share('00000000-0000-0000-0000-000000004504') ->> 'slug', true);

select is(public.share_names_state(current_setting('test.stored')) ->> 'showNames', 'false',
  'a new link hides names unless asked');
select is(public.share_names_state(current_setting('test.named')) ->> 'showNames', 'true',
  'create_share p_show_names = true makes a link that shows them');

select pg_temp.act_as_anon();
select ok(not pg_temp.leaks(public.read_share(current_setting('test.stored'))), 'a new stored-hand link leaks nothing');
select ok(not pg_temp.leaks(public.read_share(current_setting('test.embedded'))), 'an embedded (never saved) hand leaks nothing');
select is(public.read_share(current_setting('test.embedded')) -> 'standardText', 'null'::jsonb,
  '... and its embedded text is not returned');
select is(public.read_share(current_setting('test.named')) ->> 'standardText',
  'PokerStars Hand #4501: Table ''Zeta 7'' Seat 1: HeroHannah, Seat 2: SneakyPete',
  'an opted-in link returns the stored text with names');
select is(public.read_share(current_setting('test.named')) #>> '{phf,players,1,name}', 'SneakyPete',
  '... and the document with names');
select is(public.read_share(current_setting('test.named')) #>> '{phf,meta,rawText}', null,
  '... still without the raw text (phf_redact_private)');
select is(public.read_share(current_setting('test.unknownfield')) -> 'phf', 'null'::jsonb,
  'a name the scrubber does not know about fails closed: no hand');
select is(
  (select jsonb_agg(p ->> 'name' order by (p ->> 'seat')::int)
     from jsonb_array_elements(public.read_share(current_setting('test.positional')) #> '{phf,players}') p),
  '["Villain1", "Hero"]'::jsonb, 'a name equal to the seat''s own position label does not trip the check');
select is(
  (select jsonb_agg(p ->> 'name' order by (p ->> 'seat')::int)
     from jsonb_array_elements(public.read_share(current_setting('test.ignition')) #> '{phf,players}') p),
  '["Villain1", "Villain2", "Hero"]'::jsonb, 'nor does a positional room''s role label left in its prose (Ignition)');

-- ------------------------------------------------------- the owner's switch --

select pg_temp.act_as('00000000-0000-0000-0000-0000000045b1');
select is(public.share_names_state('prevshare45'), null, 'another account gets no state for A''s link');
select throws_ok($$ select public.set_share_names('prevshare45', true) $$, '22023', 'That share link does not exist.',
  'another account cannot turn names on ...');
select throws_ok($$ select public.set_share_names('nxsuchshare', true) $$, '22023', 'That share link does not exist.',
  '... and gets exactly the error an unknown slug gets');

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is(public.set_share_names('prevshare45', true) ->> 'showNames', 'true', 'the owner turns names on');

select pg_temp.act_as_anon();
select is(public.read_share('prevshare45') #>> '{phf,players,1,name}', 'SneakyPete', 'a stranger now sees the names');
select is(public.read_share('prevshare45') ->> 'title', 'Old title naming SneakyPete', '... and the title');
select throws_ok($$ select public.set_share_names('prevshare45', false) $$, '42501', null, 'anon cannot use the switch');
select throws_ok($$ select public.share_names_state('prevshare45') $$, '42501', null, 'anon cannot read the switch');

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is(public.set_share_names('prevshare45', false) ->> 'showNames', 'false', 'the owner turns names off again');
select pg_temp.act_as_anon();
select ok(not pg_temp.leaks(public.read_share('prevshare45')), '... and the link leaks nothing again');

-- ---------------------------------------------------------- the grant wall --

select pg_temp.act_as_owner();
select ok(not has_function_privilege('anon', 'public.share_anonymised_phf(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.share_anonymised_phf(jsonb)', 'execute'),
  'the scrubber wrapper is executable by neither client role');
select ok(not has_function_privilege('anon', 'public.create_share(uuid, jsonb, text, text, boolean, boolean)', 'execute'),
  'anon cannot create a share');

select * from finish();
rollback;
