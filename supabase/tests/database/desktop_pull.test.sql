-- pgTAP: Rail R1.9, the desktop pull -- `20270505090000_desktop_pull.sql`.
--
-- What has to hold:
--
--   * `hands_since` is security invoker with an empty search_path,
--     executable by `authenticated` only, and returns ids, times, keys and
--     origins - no PHF, no text;
--   * it reads the caller's own rows only (desktop and web), never another
--     account's, and needs a signed-in caller and a whole cursor;
--   * pages are a keyset by (created_at, id): following the cursor visits
--     every row exactly once, in order, ties on created_at included;
--   * a row younger than a minute is not returned yet, so a transaction
--     that commits late can never fall behind a cursor; once settled it
--     comes after the cursor;
--   * the page size is clamped to 1..1000; the keyset has its index.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(17);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000f1a01', 'pull.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000f1b01', 'pull.b@example.com', now(), now());

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
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.phf(text), pg_temp.row(text)
  to anon, authenticated;

-- Pages as the app reads them, collected here.
create temporary table seen (n serial, page int, id uuid, created_at timestamptz, hand_key text, origin text);
grant select, insert on seen to authenticated;
grant usage on sequence seen_n_seq to authenticated;

-- ---------------------------------------------------------- the function --

select ok((select not prosecdef and proconfig @> array['search_path=""']
           from pg_proc where oid = 'public.hands_since(timestamptz, uuid, integer)'::regprocedure),
  'hands_since is security invoker with an empty search_path');
select ok(has_function_privilege('authenticated', 'public.hands_since(timestamptz, uuid, integer)', 'execute')
          and not has_function_privilege('anon', 'public.hands_since(timestamptz, uuid, integer)', 'execute'),
  'authenticated may call it, anon may not');
select is(pg_get_function_result('public.hands_since(timestamptz, uuid, integer)'::regprocedure),
  'TABLE(id uuid, created_at timestamp with time zone, hand_key text, origin hand_origin)',
  'it returns ids, times, keys and origins only');
select has_index('public', 'hands', 'hands_owner_created_idx', array['owner_id', 'created_at', 'id'],
  'the keyset has its index');

-- --------------------------------------------------------------- refusals --

select pg_temp.act_as_anon();
select throws_ok($$ select * from public.hands_since() $$, '42501', null, 'anon is refused by the grant');

reset role;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$ select * from public.hands_since() $$, '42501',
  'You must be signed in to sync hands.', 'no auth.uid() is refused');

select pg_temp.act_as('00000000-0000-0000-0000-0000000f1a01');
select throws_ok($$ select * from public.hands_since(now(), null) $$, '22023', null,
  'half a cursor is refused');

-- ------------------------------------------------------------------ rows --

-- A: four desktop hands and two web hands; B: one web hand.
select lives_ok($$
  select public.ingest_hands(
    public.register_hand_source('00000000-0000-0000-0000-0000000f1d01', 'f1'),
    jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'), pg_temp.row('3'), pg_temp.row('4')))
$$, 'A uploads four hands from the desktop');
select lives_ok($$
  select public.save_hands(jsonb_build_array(
    jsonb_build_object('hand_key', 'weplay:5', 'phf', pg_temp.phf('5'),
                       'site', 'weplay', 'standard_text', 'Poker Hand #5'),
    jsonb_build_object('hand_key', 'weplay:6', 'phf', pg_temp.phf('6'),
                       'site', 'weplay', 'standard_text', 'Poker Hand #6')))
$$, '... and two on the web');
select pg_temp.act_as('00000000-0000-0000-0000-0000000f1b01');
select lives_ok($$
  select public.save_hands(jsonb_build_array(
    jsonb_build_object('hand_key', 'weplay:9', 'phf', pg_temp.phf('9'),
                       'site', 'weplay', 'standard_text', 'Poker Hand #9')))
$$, 'B saves one on the web');

-- Inside this test every row has the transaction's now(): give them settled
-- times, with a tie (1 and 2), and leave hand 6 fresh.
reset role;
update public.hands set created_at = case hand_key
    when 'weplay:1' then now() - interval '10 minutes'
    when 'weplay:2' then now() - interval '10 minutes'
    when 'weplay:3' then now() - interval '9 minutes'
    when 'weplay:4' then now() - interval '8 minutes'
    when 'weplay:5' then now() - interval '7 minutes'
    when 'weplay:9' then now() - interval '6 minutes'
    else created_at end
  where owner_id in ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-0000000f1b01');

-- ---------------------------------------------------------------- paging --

select pg_temp.act_as('00000000-0000-0000-0000-0000000f1a01');
insert into seen (page, id, created_at, hand_key, origin)
  select 1, s.id, s.created_at, s.hand_key, s.origin::text from public.hands_since(null, null, 2) s;
insert into seen (page, id, created_at, hand_key, origin)
  select 2, s.id, s.created_at, s.hand_key, s.origin::text
  from public.hands_since((select created_at from seen where n = 2), (select id from seen where n = 2), 2) s;
insert into seen (page, id, created_at, hand_key, origin)
  select 3, s.id, s.created_at, s.hand_key, s.origin::text
  from public.hands_since((select created_at from seen where n = 4), (select id from seen where n = 4), 2) s;
select is((select count(*)::int from public.hands_since((select created_at from seen where n = 5),
                                                         (select id from seen where n = 5), 2)),
  0, 'the last page is followed by an empty one');

select is((select array_agg(hand_key order by n) from seen),
  (select array_agg(hand_key order by created_at, id) from public.hands
    where owner_id = '00000000-0000-0000-0000-0000000f1a01' and hand_key <> 'weplay:6'),
  'following the cursor visits A''s settled rows once each, in (created_at, id) order');
select is((select array_agg(distinct origin order by origin) from seen), array['desktop', 'web'],
  'desktop and web rows alike');
select is((select count(*)::int from seen where hand_key in ('weplay:9', 'weplay:6')), 0,
  'not B''s row, and not the row younger than a minute');

-- Hand 6 settles (its transaction long committed): it comes after the
-- cursor, not behind it.
reset role;
update public.hands set created_at = now() - interval '61 seconds' where hand_key = 'weplay:6';
select pg_temp.act_as('00000000-0000-0000-0000-0000000f1a01');
select is((select array_agg(hand_key) from public.hands_since((select created_at from seen where n = 5),
                                                               (select id from seen where n = 5), 2)),
  array['weplay:6'], 'a row that settles later is found after the cursor');

select is((select count(*)::int from public.hands_since(null, null, 0)), 1,
  'a page has at least one row');

select pg_temp.act_as('00000000-0000-0000-0000-0000000f1b01');
select is((select array_agg(hand_key) from public.hands_since(null, null, 5000)), array['weplay:9'],
  'B reads only its own row');

select * from finish();
rollback;
