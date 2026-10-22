-- pgTAP: Rail R4.2, bulk upload -- `20270609090000_hand_origin_upload.sql`
-- and `20270609091000_web_bulk_upload.sql`.
--
-- What has to hold:
--
--   * `register_web_hand_source` is security definer with an empty
--     search_path, for `authenticated` only; it returns the caller's one web
--     source, the same id every time, another account's another;
--   * `ingest_hands` takes the web source: its rows are `origin = 'upload'`,
--     PHF only; a repeat is all duplicates; another account cannot send from
--     it; the original text is still refused per row; the account's budget
--     is charged, the web's global one is not;
--   * the PHF-only shape holds for upload rows from any writer, and the
--     direct path still cannot write one;
--   * the `hand-uploads` bucket is private, 50 MiB, gzip only; an account can
--     insert, list, read and delete under its own uid only, never update;
--     another account and anon can do nothing there.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(37);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000042a001', 'upload.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000042b001', 'upload.b@example.com', now(), now());

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

-- A small hold'em hand as the converter sends it (rawText emptied).
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

-- Storage refuses a DELETE on its tables unless the Storage API sets this
-- (`storage.protect_delete`); the API does, as the user, under RLS - so do
-- the tests, and the policies decide.
select set_config('storage.allow_delete_query', 'true', true);

-- The web's global budget before the test, to show ingesting leaves it alone.
create temporary table global_budget as
  select coalesce((select hits from public.ingest_rate_limit where bucket = 'hands_insert'), 0) as hits;

-- ------------------------------------------------- register_web_hand_source --

select ok((select prosecdef and proconfig @> array['search_path=""']
           from pg_proc where oid = 'public.register_web_hand_source()'::regprocedure),
  'register_web_hand_source is security definer with an empty search_path');
select ok(has_function_privilege('authenticated', 'public.register_web_hand_source()', 'execute')
          and not has_function_privilege('anon', 'public.register_web_hand_source()', 'execute'),
  'authenticated may call it, anon may not');

select pg_temp.act_as_anon();
select throws_ok($$ select public.register_web_hand_source() $$, '42501', null, 'anon is refused');

select pg_temp.act_as('00000000-0000-0000-0000-00000042a001');
insert into ids values ('a', public.register_web_hand_source());
select is(public.register_web_hand_source(), (select id from ids where name = 'a'),
  'the same web source every time');
select is((select kind::text || ' / ' || coalesce(label, '-') from public.hand_sources where id = (select id from ids where name = 'a')),
  'web / Web uploads', 'a web source, labelled');

select pg_temp.act_as('00000000-0000-0000-0000-00000042b001');
insert into ids values ('b', public.register_web_hand_source());
select isnt((select id from ids where name = 'b'), (select id from ids where name = 'a'),
  'another account has its own');

-- ------------------------------------------------------------ ingest_hands --

select pg_temp.act_as('00000000-0000-0000-0000-00000042a001');
select is(public.ingest_hands((select id from ids where name = 'a'),
            jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'), pg_temp.row('2'))) - 'rows',
  '{"received": 3, "inserted": 2, "duplicates": 1, "rejected": 0}'::jsonb,
  'the web source ingests; a hand twice in one call is one row and one duplicate');
select is((select jsonb_build_object('origin', origin, 'std', standard_text, 'src', source_text, 'site', site)
             from public.hands where hand_key = 'weplay:1'),
  jsonb_build_object('origin', 'upload', 'std', null, 'src', null, 'site', 'weplay'),
  'an uploaded row is origin upload, PHF only, its columns derived');
select is(public.ingest_hands((select id from ids where name = 'a'),
            jsonb_build_array(pg_temp.row('1'), pg_temp.row('2'))) - 'rows',
  '{"received": 2, "inserted": 0, "duplicates": 2, "rejected": 0}'::jsonb,
  'sending the same file again inserts nothing');
select is(public.ingest_hands((select id from ids where name = 'a'),
            jsonb_build_array(jsonb_build_object('hand_key', 'weplay:3',
              'phf', jsonb_set(pg_temp.phf('3'), '{meta,rawText}', '"Weplay Hand #3"')))) -> 'rows' -> 0 ->> 'reason',
  'raw-text', 'the original text in the PHF is refused, per row');
select is((select hands_received || '/' || hands_inserted || '/' || hands_duplicate || '/' || hands_rejected
             from public.hand_sources where id = (select id from ids where name = 'a')),
  '6/2/3/1', 'the web source counts what it received');

reset role;
select is((select hits from public.ingest_rate_limit
            where bucket = 'desktop_ingest:00000000-0000-0000-0000-00000042a001'),
  6, 'every row is charged to the account''s budget');
select is(coalesce((select hits from public.ingest_rate_limit where bucket = 'hands_insert'), 0),
  (select hits from global_budget), 'the web''s global budget is not spent');

select pg_temp.act_as('00000000-0000-0000-0000-00000042b001');
select throws_ok(format($$ select public.ingest_hands(%L, jsonb_build_array(pg_temp.row('9'))) $$,
                        (select id from ids where name = 'a')),
  '23503', null, 'another account cannot send from it');
select is((select count(*)::int from public.hands where hand_key = 'weplay:1'), 0,
  'and cannot see its rows');
select is(public.ingest_hands((select id from ids where name = 'b'), jsonb_build_array(pg_temp.row('1'))) ->> 'inserted',
  '1', 'the same hand in another library is another row');

-- ----------------------------------------------------- the shape, any writer --

select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, site)
                   values ('00000000-0000-0000-0000-00000042b001', 'upload', 'weplay:40', pg_temp.phf('40'), 'weplay') $$,
  '42501', null, 'the direct path cannot write an upload row (insert policy)');

reset role;
select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, standard_text, site)
                   values ('00000000-0000-0000-0000-00000042a001', 'upload', 'weplay:41', pg_temp.phf('41'), 'text', 'weplay') $$,
  '23514', null, 'no writer stores an upload row with standard text');
select throws_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, site, source_text)
                   values ('00000000-0000-0000-0000-00000042a001', 'upload', 'weplay:42', pg_temp.phf('42'), 'weplay', 'raw') $$,
  '23514', null, '... or with source text');
select lives_ok($$ insert into public.hands (owner_id, origin, hand_key, phf, site)
                   values ('00000000-0000-0000-0000-00000042a001', 'desktop', 'weplay:43', pg_temp.phf('43'), 'weplay') $$,
  'a desktop row is unchanged');

-- ---------------------------------------------------------------- Storage --

select is((select public from storage.buckets where id = 'hand-uploads'), false,
  'the hand-uploads bucket exists and is private');
select is((select file_size_limit from storage.buckets where id = 'hand-uploads'), 52428800::bigint,
  'an original is at most 50 MiB');
select is((select allowed_mime_types from storage.buckets where id = 'hand-uploads'), array['application/gzip'],
  'gzip only');
select is((select count(*)::int from pg_policies
            where schemaname = 'storage' and tablename = 'objects' and cmd = 'UPDATE'
              and (coalesce(qual, '') || coalesce(with_check, '')) like '%hand-uploads%'),
  0, 'no UPDATE policy: an original is never rewritten');

select pg_temp.act_as('00000000-0000-0000-0000-00000042a001');
select lives_ok($$ insert into storage.objects (bucket_id, name)
                   values ('hand-uploads', '00000000-0000-0000-0000-00000042a001/up1/HH1.txt.0badc0de.gz') $$,
  'an account stores an original under its own uid');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('hand-uploads', '00000000-0000-0000-0000-00000042b001/up1/evil.gz') $$,
  '42501', null, '... and not under another account''s');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('hand-uploads', 'up1/00000000-0000-0000-0000-00000042a001/x.gz') $$,
  '42501', null, '... nor anywhere but its own top folder');
select is((select count(*)::int from storage.objects where bucket_id = 'hand-uploads'), 1,
  'it lists its own original');
with u as (update storage.objects set name = name || '.x'
            where bucket_id = 'hand-uploads' returning 1)
select is((select count(*)::int from u), 0,
  'it cannot rename (update) it');

select pg_temp.act_as('00000000-0000-0000-0000-00000042b001');
select lives_ok($$ insert into storage.objects (bucket_id, name)
                   values ('hand-uploads', '00000000-0000-0000-0000-00000042b001/up9/HH9.txt.0badc0de.gz') $$,
  'the other account stores its own');
select is((select count(*)::int from storage.objects
            where bucket_id = 'hand-uploads' and name like '00000000-0000-0000-0000-00000042a001/%'), 0,
  'another account cannot list or read it');
with d as (delete from storage.objects
            where bucket_id = 'hand-uploads' and name like '00000000-0000-0000-0000-00000042a001/%' returning 1)
select is((select count(*)::int from d), 0,
  'another account cannot delete it');

select pg_temp.act_as_anon();
select is((select count(*)::int from storage.objects where bucket_id = 'hand-uploads'), 0,
  'anon sees nothing in the bucket');
select throws_ok($$ insert into storage.objects (bucket_id, name)
                    values ('hand-uploads', '00000000-0000-0000-0000-00000042a001/up1/anon.gz') $$,
  '42501', null, 'anon cannot write to the bucket');

select pg_temp.act_as('00000000-0000-0000-0000-00000042a001');
with d as (delete from storage.objects
            where bucket_id = 'hand-uploads' and name like '00000000-0000-0000-0000-00000042a001/%' returning 1)
select is((select count(*)::int from d), 1,
  'an account deletes its own original');

reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'hand-uploads'), 1,
  'the other account''s original is untouched');
select is((select count(*)::int from storage.objects
            where bucket_id = 'hand-uploads' and name like '00000000-0000-0000-0000-00000042a001/%'), 0,
  'and the deleted one is gone');

select * from finish();
rollback;
