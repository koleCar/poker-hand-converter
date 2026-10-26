-- pgTAP: the account's data - its inventory, export and deletion (Rail R6.5,
-- `20271006090000_account_export.sql`, `20271006100000_account_deletion.sql`).
--
-- What has to hold:
--
--   * the inventory is complete: every public table with an account column
--     (a foreign key to auth.users, or owner_id / user_id / author_id / ...)
--     and every private Storage bucket has a row deciding what the export
--     carries and what deletion does - **a new table fails here until it is
--     added**; every row names a real table and real columns;
--   * the export readers are owner-only (another account's rows never; anon
--     refused), complete (paging through each section returns every row the
--     account holds in that table), owner first (PL/pgSQL, planned per call);
--   * the deletion starts only for a fresh sign-in with the username typed,
--     resumes without either, and its service-role steps are no client's;
--   * erasing the content keeps others' threads (a replied-to post
--     anonymised, comments tombstoned, a published hand under a kept thread
--     re-scrubbed) and removes the rest, recounts what the votes counted,
--     scrubs the moderation log's copy of the words, and touches no other
--     account; the hands go in batches; and after the auth user is deleted
--     no inventory table holds a row of the account except the `retain` ones.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(84);

-- ---------------------------------------------------------------------------
-- Accounts: A (to be deleted), B and C (others), M (a moderator)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000065a1', 'data.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000065b1', 'data.b@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000065c1', 'data.c@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000065d1', 'data.mod@example.com', now() - interval '40 days', now() - interval '40 days');
update public.profiles set username = 'data_alice', username_changed_at = now() - interval '35 days'
 where id = '00000000-0000-0000-0000-0000000065a1';
update public.profiles set username = 'data_bob' where id = '00000000-0000-0000-0000-0000000065b1';
update public.profiles set username = 'data_carol' where id = '00000000-0000-0000-0000-0000000065c1';
update public.profiles set username = 'data_mod', role = 'moderator' where id = '00000000-0000-0000-0000-0000000065d1';

create function pg_temp.act_as(p_uid uuid, p_signed_in_ago interval default null) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', (jsonb_build_object('sub', p_uid, 'role', 'authenticated')
    || case when p_signed_in_ago is null then '{}'::jsonb
            else jsonb_build_object('amr', jsonb_build_array(jsonb_build_object(
                   'method', 'password', 'timestamp', extract(epoch from now() - p_signed_in_ago)::bigint))) end)::text, true);
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
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid, interval), pg_temp.act_as_anon(), pg_temp.as_postgres() to anon, authenticated;

create function pg_temp.hand_phf(p_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'meta', jsonb_build_object('siteId', 'pokerstars', 'siteName', 'PokerStars', 'handId', p_id, 'handKey', p_id,
      'originalFilename', null, 'parserId', 'pokerstars', 'parserVersion', '1', 'warnings', '[]'::jsonb,
      'rawText', 'PokerStars Hand #' || p_id, 'parsedAt', '2026-09-01T10:11:12Z',
      'textStyle', jsonb_build_object('decimals', 'fixed2')),
    'game', jsonb_build_object('variant', 'holdem', 'limit', 'nl'),
    'table', jsonb_build_object('name', 'Zeta', 'maxSeats', 6, 'buttonSeat', 1),
    'tournament', null,
    'playedAt', '2026-08-30T21:43:07Z',
    'players', jsonb_build_array(
      jsonb_build_object('seat', 1, 'name', 'HeroHannah', 'isHero', true,  'position', 'BTN',
                         'holeCards', jsonb_build_array('Ah', 'Kh'), 'dealtCards', jsonb_build_array('Ah', 'Kh')),
      jsonb_build_object('seat', 2, 'name', 'SneakyPete', 'isHero', false, 'position', 'BB',
                         'holeCards', '[]'::jsonb, 'dealtCards', '[]'::jsonb)),
    'actions', jsonb_build_array(
      jsonb_build_object('index', 0, 'street', 'preflop', 'seat', 2, 'player', 'SneakyPete', 'type', 'big-blind', 'amount', 2, 'allIn', false),
      jsonb_build_object('index', 1, 'street', 'preflop', 'seat', 1, 'player', 'HeroHannah', 'type', 'raise', 'amount', 6, 'allIn', false),
      jsonb_build_object('index', 2, 'street', 'preflop', 'seat', 2, 'player', 'SneakyPete', 'type', 'fold', 'amount', 0, 'allIn', false)),
    'board', jsonb_build_object('runouts', '[]'::jsonb),
    'chipMovements', '[]'::jsonb,
    'results', jsonb_build_object('totalPot', 8, 'pots', '[]'::jsonb,
      'fees', jsonb_build_object('rake', 0, 'jackpot', 0, 'bingo', 0, 'fortune', 0, 'tax', 0, 'other', 0),
      'players', '[]'::jsonb,
      'winners', jsonb_build_array(jsonb_build_object('player', 'HeroHannah', 'seat', 1, 'amount', 8, 'runoutIndex', 0)),
      'heroNet', 2, 'wentToShowdown', false, 'streetReached', 'preflop'));
$$;

-- ---------------------------------------------------------------------------
-- 1. The inventory is complete
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(c.oid::regclass::text order by 1) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and (exists (select 1 from pg_constraint f where f.conrelid = c.oid and f.contype = 'f'
                     and f.confrelid = 'auth.users'::regclass)
           or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                        and a.attname in ('owner_id', 'user_id', 'author_id', 'submitted_by', 'reserved_for',
                                          'reporter_id', 'actor_id', 'edited_by', 'granted_by')))
      and not exists (select 1 from public.account_data_inventory i where i.name = 'public.' || c.relname)),
  null,
  'every public table with an account column is in account_data_inventory (a new one decides export and deletion)');

select is(
  (select array_agg(b.id order by b.id) from storage.buckets b
    where not b.public and not exists (select 1 from public.account_data_inventory i where i.name = 'storage.' || b.id)),
  null,
  'every private Storage bucket is in the inventory');

select is(
  (select array_agg(i.name order by i.name) from public.account_data_inventory i
    where i.kind = 'table'
      and (to_regclass(i.name) is null
           or exists (select 1 from unnest(i.owner_columns) col
                       where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass(i.name)
                                           and a.attname = col and not a.attisdropped)))),
  null,
  'every inventory table exists, with the owner columns it names');

select is(
  (select array_agg(c.oid::regclass::text || '.' || a.attname order by 1)
     from pg_constraint f
     join pg_class c on c.oid = f.conrelid and c.relnamespace = 'public'::regnamespace
     join pg_attribute a on a.attrelid = f.conrelid and a.attnum = any (f.conkey)
     join public.account_data_inventory i on i.name = 'public.' || c.relname
    where f.contype = 'f' and f.confrelid = 'auth.users'::regclass and not (a.attname = any (i.owner_columns))),
  null,
  'every column referencing auth.users is named among its table''s owner columns');

select is(
  (select array_agg(i.name order by i.name) from public.account_data_inventory i
    where i.kind = 'table' and i.on_delete = 'cascade'
      and exists (select 1 from pg_constraint f join pg_attribute a on a.attrelid = f.conrelid and a.attnum = any (f.conkey)
                   where f.conrelid = to_regclass(i.name) and f.contype = 'f' and f.confrelid = 'auth.users'::regclass
                     and a.attname = i.owner_columns[1] and f.confdeltype <> 'c')),
  null,
  'a table marked "cascade" does cascade from auth.users on its owner column');

select is(
  (select array_agg(i.name || '.' || k order by 1) from public.account_data_inventory i, unnest(i.export_key) k
    where i.kind = 'table'
      and not exists (select 1 from pg_attribute a where a.attrelid = to_regclass(i.name) and a.attname = k and a.attnotnull)),
  null,
  'every export key column exists and is not null (a null would fall out of the keyset pages)');

select is(
  (select array_agg(i.export_section order by 1) from public.account_data_inventory i
    where i.export_reader = 'hands'
      and i.export_section not in ('hands', 'hand_stats', 'hand_stats_ev', 'hand_analysis', 'decision_analysis')),
  null,
  'every section the hands reader carries is one export_my_hands returns');

select ok(
  not has_table_privilege('authenticated', 'public.account_data_inventory', 'select')
  and not has_table_privilege('anon', 'public.account_data_inventory', 'select')
  and not has_table_privilege('authenticated', 'public.account_deletions', 'select')
  and not has_table_privilege('anon', 'public.account_deletions', 'select'),
  'the inventory and the deletions table are sealed');

-- ---------------------------------------------------------------------------
-- 2. Data for every account
-- ---------------------------------------------------------------------------

insert into public.hands (id, owner_id, hand_key, phf, standard_text, source_text, site, played_at, hero_seat) values
  ('00000000-0000-0000-0000-00000065ab01', '00000000-0000-0000-0000-0000000065a1', 'pokerstars:a1', pg_temp.hand_phf('a1'), 'std a1', 'raw a1', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000065ab02', '00000000-0000-0000-0000-0000000065a1', 'pokerstars:a2', pg_temp.hand_phf('a2'), 'std a2', 'raw a2', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000065ab03', '00000000-0000-0000-0000-0000000065a1', 'pokerstars:a3', pg_temp.hand_phf('a3'), 'std a3', 'raw a3', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000065ab04', '00000000-0000-0000-0000-0000000065a1', 'pokerstars:a4', pg_temp.hand_phf('a4'), 'std a4', 'raw a4', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000065ab05', '00000000-0000-0000-0000-0000000065a1', 'pokerstars:a5', pg_temp.hand_phf('a5'), 'std a5', 'raw a5', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000065bb01', '00000000-0000-0000-0000-0000000065b1', 'pokerstars:b1', pg_temp.hand_phf('b1'), 'std b1', 'raw b1', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000065bb02', '00000000-0000-0000-0000-0000000065b1', 'pokerstars:b2', pg_temp.hand_phf('b2'), 'std b2', 'raw b2', 'pokerstars', now(), 1);

insert into public.player_notes (owner_id, site, player, note, tags) values
  ('00000000-0000-0000-0000-0000000065a1', 'pokerstars', 'SneakyPete', 'calls too much', '{fish}'),
  ('00000000-0000-0000-0000-0000000065a1', 'pokerstars', 'Zed', 'nit', '{}'),
  ('00000000-0000-0000-0000-0000000065b1', 'pokerstars', 'HeroHannah', 'aggressive', '{}');
insert into public.tournament_settings (owner_id, site, tournament_id, settings) values
  ('00000000-0000-0000-0000-0000000065a1', 'pokerstars', 't1', '{"payouts": [50, 30, 20]}'),
  ('00000000-0000-0000-0000-0000000065b1', 'pokerstars', 't9', '{"payouts": [100]}');
insert into public.lesson_progress (owner_id, lesson_id, status, exercises, started_at) values
  ('00000000-0000-0000-0000-0000000065a1', 'preflop-basics', 'started', '{}', now());
insert into public.hud_layouts (owner_id, kind, key, body, updated_at) values
  ('00000000-0000-0000-0000-0000000065a1', 'layout', 'mine', '{"panels": []}', 1),
  ('00000000-0000-0000-0000-0000000065b1', 'layout', 'theirs', '{"panels": []}', 1);
insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version, submitted_by, origin) values
  (repeat('a', 64), 'PokerStars Hand #x: HeroHannah ...', 'parse', 'bad', 'could not parse', '1', '00000000-0000-0000-0000-0000000065a1', 'web'),
  (repeat('b', 64), 'PokerStars Hand #y: SomeoneElse ...', 'parse', 'bad', 'could not parse', '1', '00000000-0000-0000-0000-0000000065b1', 'web');
insert into public.unparsed_hands (fingerprint, raw_text, stage, reason, message, parser_version, submitted_by, origin,
                                   consented_at, anonymiser_version, os, client_version) values
  (repeat('c', 64), 'Anonymised sample', 'parse', 'bad', 'could not parse', '1', '00000000-0000-0000-0000-0000000065a1', 'desktop',
   now(), 'anon/1', 'macos', '0.1.0');
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('hand-uploads', '00000000-0000-0000-0000-0000000065a1/up1/HH1.txt.0badc0de.gz', '00000000-0000-0000-0000-0000000065a1', '{"size": 120}'),
  ('hand-uploads', '00000000-0000-0000-0000-0000000065b1/up1/HH1.txt.0badc0de.gz', '00000000-0000-0000-0000-0000000065b1', '{"size": 99}');

-- A: a web source, shares, published hands, two posts, a comment, votes,
-- a report; B and C reply; M removes a post of A's.
select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1');
select public.register_web_hand_source();
select public.create_share('00000000-0000-0000-0000-00000065ab01');
select public.create_share('00000000-0000-0000-0000-00000065ab02');
select set_config('test.h_kept', public.publish_hand('00000000-0000-0000-0000-00000065ab01', 'as-imported', 'My AK') ->> 'publicId', true);
select set_config('test.h_gone', public.publish_hand('00000000-0000-0000-0000-00000065ab02') ->> 'publicId', true);
select set_config('test.p_kept', public.create_post('nlhe', 'Alice asks about AK', 'Body by Alice', current_setting('test.h_kept')) ->> 'publicId', true);
select set_config('test.p_gone', public.create_post('general', 'Alice alone', 'Nobody answers this', null) ->> 'publicId', true);
select set_config('test.p_removed', public.create_post('general', 'Alice spam', 'Removed by a moderator', null) ->> 'publicId', true);
select public.edit_post(current_setting('test.p_kept'), 'Alice asks about AK (edited)', 'Body by Alice, edited');

select pg_temp.act_as('00000000-0000-0000-0000-0000000065b1');
select set_config('test.p_bob', public.create_post('general', 'Bob''s thread', 'Bob writes', null) ->> 'publicId', true);
select public.create_comment(current_setting('test.p_kept'), 'Bob answers Alice');
select public.vote_post(current_setting('test.p_kept'), 1);

select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1');
select public.create_comment(current_setting('test.p_bob'), 'Alice comments on Bob');
select public.edit_comment(current_setting('test.p_bob'), 1, 'Alice comments on Bob (edited)');
select public.create_comment(current_setting('test.p_kept'), 'Alice replies to Bob', 1);
select public.vote_post(current_setting('test.p_bob'), 1);
select public.vote_comment(current_setting('test.p_kept'), 1, 1);
select public.save_post(current_setting('test.p_bob'), true);
select public.report_content('post', current_setting('test.p_bob'), null, null, 'spam', 'Alice thinks this is spam');

select pg_temp.act_as('00000000-0000-0000-0000-0000000065c1');
select public.create_comment(current_setting('test.p_bob'), 'Carol replies to Alice', 1);

select pg_temp.act_as('00000000-0000-0000-0000-0000000065d1');
select public.mod_set_post_status(current_setting('test.p_removed'), 'removed', 'spam');
select public.mod_set_post_status(current_setting('test.p_bob'), 'removed', 'checking');
select public.mod_set_post_status(current_setting('test.p_bob'), 'visible', 'fine');

-- ---------------------------------------------------------------------------
-- 3. The export: owner only, complete, anon refused
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();

-- What each account holds per section, counted as postgres.
create temporary table expected (section text, reader text, owner_col text, owner_id uuid, n bigint);
do $$
declare
  r public.account_data_inventory;
  u uuid;
  v_n bigint;
begin
  for r in select * from public.account_data_inventory where export_reader in ('rows', 'sealed') loop
    foreach u in array array['00000000-0000-0000-0000-0000000065a1', '00000000-0000-0000-0000-0000000065b1']::uuid[] loop
      execute format('select count(*) from %s where %I = $1', r.name, r.owner_columns[1]) into v_n using u;
      insert into expected values (r.export_section, r.export_reader, r.owner_columns[1], u, v_n);
    end loop;
  end loop;
end;
$$;
grant select on expected to authenticated;

-- Pages through a section two rows at a time; returns the rows' count and
-- how many of them are not the caller's.
create function pg_temp.export_all(p_section text, p_reader text, p_owner_col text) returns int[] language plpgsql as $$
declare
  v_after jsonb := null;
  v_page  jsonb;
  v_rows  integer := 0;
  v_alien integer := 0;
  v_guard integer := 0;
begin
  loop
    v_page := case p_reader when 'rows' then public.export_my_rows(p_section, v_after, 2)
                            else public.export_my_sealed(p_section, v_after, 2) end;
    v_rows := v_rows + jsonb_array_length(v_page -> 'rows');
    v_alien := v_alien + (select count(*) from jsonb_array_elements(v_page -> 'rows') e
                           where (e ->> p_owner_col) is distinct from auth.uid()::text);
    v_after := v_page -> 'next';
    exit when v_after is null or jsonb_typeof(v_after) = 'null';
    v_guard := v_guard + 1;
    exit when v_guard > 100;
  end loop;
  return array[v_rows, v_alien];
end;
$$;
grant execute on function pg_temp.export_all(text, text, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1');
select is(
  (select array_agg(e.section || ': ' || e.n || ' held, ' || x.got[1] || ' exported, ' || x.got[2] || ' not its own' order by e.section)
     from expected e
     cross join lateral (select pg_temp.export_all(e.section, e.reader, e.owner_col) as got) x
    where e.owner_id = auth.uid() and (x.got[1] <> e.n or x.got[2] <> 0)),
  null,
  'A: every section exports every row A holds there, and nothing else (two-row pages)');
select ok((select bool_and(n > 0) from expected
            where owner_id = '00000000-0000-0000-0000-0000000065a1'
              and section in ('hand_sources', 'shares', 'player_notes', 'tournament_settings', 'hud_layouts',
                              'unparsed_hands', 'published_hands', 'published_hand_sources', 'posts', 'comments',
                              'content_revisions', 'post_votes', 'comment_votes', 'saved_posts',
                              'thread_subscriptions', 'notifications', 'reports', 'lesson_progress')),
  '... over data in each of the main sections');

select pg_temp.act_as('00000000-0000-0000-0000-0000000065b1');
select is(
  (select array_agg(e.section order by e.section)
     from expected e
     cross join lateral (select pg_temp.export_all(e.section, e.reader, e.owner_col) as got) x
    where e.owner_id = auth.uid() and (x.got[1] <> e.n or x.got[2] <> 0)),
  null,
  'B: the same, B''s rows only');

select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1');
select is(jsonb_array_length(public.export_my_hands(null, 10, true) -> 'hands'), 5, 'A: export_my_hands returns A''s five hands');
select is((select count(*)::int from jsonb_array_elements(public.export_my_hands(null, 10, true) -> 'hands') h
            where h ->> 'id' like '%65bb%'), 0, '... none of B''s');
select is((public.export_my_hands(null, 10, true) -> 'hands' -> 0 ->> 'standardText'), 'std a1',
  '... each with its stored texts and PHF');
select ok((select (public.export_my_hands(null, 10, true) ?& array['hand_stats', 'hand_stats_ev', 'hand_analysis', 'decision_analysis'])),
  '... and, asked for, its statistics and analysis rows');
select ok(not (public.export_my_hands(null, 10, false) ? 'hand_stats'), '... and not when not asked for');
select is(
  (with p1 as (select public.export_my_hands(null, 2, false) as p),
        p2 as (select public.export_my_hands((select p -> 'next' from p1), 2, false) as p),
        p3 as (select public.export_my_hands((select p -> 'next' from p2), 2, false) as p)
   select jsonb_array_length((select p -> 'hands' from p1)) || '/' || jsonb_array_length((select p -> 'hands' from p2))
          || '/' || jsonb_array_length((select p -> 'hands' from p3)) || '/' || coalesce((select p ->> 'next' from p3), 'end')),
  '2/2/1/end',
  'the hands page by the cursor: 2 + 2 + 1, then no next');
select is(
  (select count(distinct h ->> 'id')::int from (
     select jsonb_array_elements(public.export_my_hands(null, 2, false) -> 'hands') h
     union all
     select jsonb_array_elements(public.export_my_hands(public.export_my_hands(null, 2, false) -> 'next', 2, false) -> 'hands')) x),
  4, '... with no hand twice');
select throws_ok($$ select public.export_my_hands('{"created_at": "nope"}', 2) $$, '22023', null,
  'a broken hands cursor is refused');
select throws_ok($$ select public.export_my_rows('player_notes', '{"site": "pokerstars"}', 2) $$, '22023', null,
  'a cursor without every key column is refused');
select throws_ok($$ select public.export_my_rows('posts') $$, '22023', null,
  'a sealed section is not read through the invoker reader');
select throws_ok($$ select public.export_my_sealed('profiles') $$, '22023', null,
  'a name that is no export section is refused');

select is(jsonb_array_length(public.export_my_rows('hand_uploads') -> 'rows'), 1, 'A: the kept original files, A''s only');
select is(public.export_my_rows('hand_uploads') -> 'rows' -> 0 ->> 'size', '120', '... with their size');

select is(public.export_my_profile() -> 'account' ->> 'email', 'data.a@example.com', 'profile.json: the account''s email');
select is(public.export_my_profile() -> 'profile' ->> 'username', 'data_alice', '... the username');
select ok(not (public.export_my_profile() -> 'profile' ? 'isShadowbanned')
          and position('unsubscribe' in public.export_my_profile()::text) = 0,
  '... never the shadowban flag or the unsubscribe token');
select is(public.export_my_profile() -> 'plan' ->> 'plan', 'free', '... the plan fields');

select is(public.export_my_manifest() -> 'counts' ->> 'hands', '5', 'the manifest counts A''s hands');
select is(public.export_my_manifest() -> 'counts' ->> 'posts', '3', '... and A''s posts (a removed one too)');
select is(public.export_my_manifest() ->> 'format', 'rail-account-export/1', '... with the format version');

select pg_temp.act_as_anon();
select throws_ok($$ select public.export_my_hands() $$, '42501', null, 'anon: export_my_hands refused');
select throws_ok($$ select public.export_my_rows('player_notes') $$, '42501', null, 'anon: export_my_rows refused');
select throws_ok($$ select public.export_my_sealed('posts') $$, '42501', null, 'anon: export_my_sealed refused');
select throws_ok($$ select public.export_my_profile() $$, '42501', null, 'anon: export_my_profile refused');
select throws_ok($$ select public.export_my_manifest() $$, '42501', null, 'anon: export_my_manifest refused');

select pg_temp.as_postgres();
select is(
  (select array_agg(p.proname::text order by 1) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('export_my_hands', 'export_my_rows', 'export_my_sealed', 'export_my_profile',
                        'export_my_manifest', 'account_export_page')
      and (not coalesce('plan_cache_mode=force_custom_plan' = any (p.proconfig), false)
           or p.prolang <> (select oid from pg_language where lanname = 'plpgsql'))),
  null,
  'the readers are owner first: PL/pgSQL, planned per call');
select is(
  (select array_agg(p.proname::text order by 1) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and p.proname in ('export_my_hands', 'export_my_rows', 'account_export_page')),
  null,
  'the readers of tables RLS already opens are invoker');

-- ---------------------------------------------------------------------------
-- 4. Starting a deletion: as the user, fresh, with the username
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')
                   and has_function_privilege('service_role', f, 'execute'))
     from unnest(array['public.account_deletion_state(uuid)', 'public.account_deletion_mark(uuid, text, text)',
                       'public.account_storage_objects(uuid, integer)', 'public.erase_account_content(uuid)',
                       'public.erase_account_hands(uuid, integer)']::regprocedure[]) f),
  'the deletion''s steps are the service role''s, no client''s');
select ok(not has_function_privilege('anon', 'public.begin_account_deletion(text)', 'execute')
          and has_function_privilege('authenticated', 'public.begin_account_deletion(text)', 'execute'),
  'begin_account_deletion: signed in only');

select is(
  (select array_agg(c.relname || '.' || t.tgname order by 1)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
      and c.relname in ('hands', 'hand_stats', 'hand_stats_ev', 'hand_analysis', 'decision_analysis')
      and (t.tgtype & 8) <> 0 and (t.tgtype & 1) = 0
      and position('rail.erasing_account' in pg_get_triggerdef(t.oid)) = 0),
  null,
  'every summary trigger on deletes of the hand tables skips an account being erased (a re-created one keeps its WHEN)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1');
select throws_ok($$ select public.begin_account_deletion('data_alice') $$, '28000', null,
  'a session without a sign-in time cannot start a deletion');
select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1', interval '2 hours');
select throws_ok($$ select public.begin_account_deletion('data_alice') $$, '28000', null,
  'a sign-in two hours ago cannot either');
select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1', interval '1 minute');
select throws_ok($$ select public.begin_account_deletion('data_bob') $$, '22023', null,
  'another username does not confirm');
select is(public.my_account_deletion(), null, 'no deletion in progress yet');
select is(public.begin_account_deletion('  Data_Alice ') ->> 'attempts', '1',
  'a fresh sign-in and the username (any case) start it');
select pg_temp.act_as('00000000-0000-0000-0000-0000000065a1', interval '3 hours');
select is(public.begin_account_deletion(null) ->> 'attempts', '2',
  'a deletion in progress resumes without either');
select ok(public.my_account_deletion() ? 'steps', 'my_account_deletion shows it');

-- ---------------------------------------------------------------------------
-- 5. The steps (as the service role)
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();
set local role service_role;

select is((select count(*)::int from public.account_storage_objects('00000000-0000-0000-0000-0000000065a1')), 1,
  'the stored objects under A''s folder, A''s only');

select set_config('test.bob_score_before', (select score::text from public.posts where public_id = current_setting('test.p_bob')), true);
select set_config('test.counts', public.erase_account_content('00000000-0000-0000-0000-0000000065a1')::text, true);
reset role;

select is((select title || '|' || body || '|' || coalesce(author_id::text, 'no author') from public.posts
            where public_id = current_setting('test.p_kept')),
  '[deleted]||no author', 'a post Bob answered stays, without its words or its author');
select is((select count(*)::int from public.content_revisions r join public.posts p on p.id = r.post_id
            where p.public_id = current_setting('test.p_kept') and r.comment_id is null), 0,
  '... and without its earlier versions');
select is((select count(*)::int from public.posts where public_id in (current_setting('test.p_gone'), current_setting('test.p_removed'))), 0,
  'A''s posts nobody answered are deleted (a removed one too)');
select is((select count(*)::int from public.comments c join public.posts p on p.id = c.post_id
            where p.public_id = current_setting('test.p_kept') and c.body = 'Bob answers Alice'), 1,
  'Bob''s comment under the kept post is untouched');
select is((select coalesce(c.body, 'none') || '|' || coalesce(c.author_id::text, 'no author') || '|' || (c.deleted_at is not null)::text
             from public.comments c join public.posts p on p.id = c.post_id
            where p.public_id = current_setting('test.p_bob') and c.seq = 1),
  'none|no author|true', 'A''s comment on Bob''s thread is a tombstone');
select is((select c.body from public.comments c join public.posts p on p.id = c.post_id
            where p.public_id = current_setting('test.p_bob') and c.seq = 2),
  'Carol replies to Alice', '... and Carol''s reply to it stays attached');
select is((select count(*)::int from public.content_revisions r join public.comments c on c.id = r.comment_id
            where c.author_id is null and r.body like 'Alice%'), 0, 'the comment''s earlier versions are gone');
select is((select comment_count from public.posts where public_id = current_setting('test.p_bob')), 1,
  'Bob''s thread counts one comment less');
select ok((select score::text from public.posts where public_id = current_setting('test.p_bob'))
            is distinct from current_setting('test.bob_score_before')
          and (select count(*) from public.post_votes v join auth.users u on u.id = v.user_id
                where u.email = 'data.a@example.com') = 0,
  'A''s vote is gone and Bob''s post is recounted at once');
select is((select count(*)::int from public.moderation_actions
            where subject_id = '00000000-0000-0000-0000-0000000065a1' and target_type in ('post', 'comment', 'published_hand')
              and details <> '{"erased": "account-deleted"}'::jsonb), 0,
  'the moderation log keeps the actions on A''s content without its words');
select ok((select count(*) from public.moderation_actions where subject_id = '00000000-0000-0000-0000-0000000065a1') > 0,
  '... the actions themselves stay');
select throws_ok($$ update public.moderation_actions set details = '{"erased": "account-deleted"}'
                     where subject_id = '00000000-0000-0000-0000-0000000065b1' $$, '42501', null,
  'outside an erasure the log stays append-only');
select is((select coalesce(author_id::text, 'no author') || '|' || coalesce(title, 'no title') || '|' || mode::text
                  || '|' || (position('HeroHannah' in phf::text) = 0)::text
             from public.published_hands where public_id = current_setting('test.h_kept')),
  'no author|no title|pseudonyms|true',
  'the hand under the kept thread stays: no author, no title, re-scrubbed with pseudonyms');
select is((select count(*)::int from public.published_hands where public_id = current_setting('test.h_gone')), 0,
  'A''s other published hand is deleted');
select is((select count(*)::int from public.notifications where actor_id = '00000000-0000-0000-0000-0000000065a1'), 0,
  'notifications A''s comments caused are deleted');
select is((select count(*)::int from public.reports where reporter_id is null and details is null and reason = 'spam'), 1,
  'A''s report stays for the moderators, unlinked and without its words');
select is((select string_agg(origin::text || ':' || coalesce(submitted_by::text, 'none'), ',' order by origin)
             from public.unparsed_hands where fingerprint in (repeat('a', 64), repeat('c', 64))),
  'desktop:00000000-0000-0000-0000-0000000065a1',
  'A''s verbatim web failure sample is deleted; the anonymised desktop one stays (unlinked by the cascade)');
select is((select count(*)::int from public.ingest_rate_limit where bucket like '%00000000-0000-0000-0000-0000000065a1%'), 0,
  'A''s rate-limit windows are gone');
select ok((select content_done_at is not null from public.account_deletions where user_id = '00000000-0000-0000-0000-0000000065a1'),
  'the content step is marked done');
select is((select count(*)::int from public.posts p join auth.users u on u.id = p.author_id where u.email = 'data.b@example.com'), 1,
  'Bob''s own post is untouched');
select is(public.erase_account_content('00000000-0000-0000-0000-0000000065a1') ->> 'postsDeleted', '0',
  'erasing again changes nothing (idempotent)');

set local role service_role;
select is(public.erase_account_hands('00000000-0000-0000-0000-0000000065a1', 2) || '/'
          || public.erase_account_hands('00000000-0000-0000-0000-0000000065a1', 2),
  '2/2', 'the hands go in batches');
reset role;
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000065b1'), 2,
  'B''s hands are untouched');
select ok(exists (select 1 from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000065a1'),
  'the library counts of an account in deletion are marked for a rebuild (its summaries are not kept up)');

-- What pg_cron does every minute (`finish_account_deletions`, one step and a
-- commit at a time): nothing before the function's steps are done...
select is(public.account_deletion_continue('00000000-0000-0000-0000-0000000065a1'), 'waiting',
  'the server does not go on before billing and storage are done');

-- The stored object (the function deletes it through the Storage API, which
-- is what this setting stands for), its steps marked.
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'hand-uploads' and name like '00000000-0000-0000-0000-0000000065a1/%';
set local role service_role;
select public.account_deletion_mark('00000000-0000-0000-0000-0000000065a1', 'billing');
select public.account_deletion_mark('00000000-0000-0000-0000-0000000065a1', 'storage');
reset role;

-- ...then the last hands, then the auth user (every remaining row cascades).
select is(public.account_deletion_continue('00000000-0000-0000-0000-0000000065a1') || '/'
          || public.account_deletion_continue('00000000-0000-0000-0000-0000000065a1'),
  'hands/completed', 'the server finishes a deletion the page left: the last hands, then the account');
select is((select count(*)::int from auth.users where id = '00000000-0000-0000-0000-0000000065a1'), 0, '... the auth user is gone');
select ok((select hands_done_at is not null and completed_at is not null from public.account_deletions
            where user_id = '00000000-0000-0000-0000-0000000065a1'), '... and the request is complete');
select ok(
  not has_function_privilege('authenticated', 'public.account_deletion_continue(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.finish_account_deletions(integer)', 'execute')
  and not has_function_privilege('anon', 'public.finish_account_deletions(integer)', 'execute'),
  'the server''s finisher is pg_cron''s only');

-- ---------------------------------------------------------------------------
-- 6. Nothing of A is left but what is retained on purpose
-- ---------------------------------------------------------------------------

create temporary table leftover (name text, n bigint);
do $$
declare
  r public.account_data_inventory;
  v_n bigint;
begin
  for r in select * from public.account_data_inventory where kind = 'table' and on_delete <> 'retain' and cardinality(owner_columns) > 0 loop
    execute format('select count(*) from %s where %s', r.name,
                   (select string_agg(format('%I = $1', c), ' or ') from unnest(r.owner_columns) c
                     where c not in ('subject_id')))
      into v_n using '00000000-0000-0000-0000-0000000065a1'::uuid;
    if v_n > 0 then
      insert into leftover values (r.name, v_n);
    end if;
  end loop;
end;
$$;
select is((select array_agg(name || ': ' || n order by name) from leftover), null,
  'after the auth user is deleted no inventory table holds a row of A (except the retained ones)');
select is((select count(*)::int from storage.objects where name like '00000000-0000-0000-0000-0000000065a1/%'), 0,
  'and no stored object');
select is((select reserved_for from public.username_reservations where username_lower = 'data_alice'), null,
  'retained: A''s username, reserved for nobody for a year');
select is((select count(*)::int from public.account_deletions where user_id = '00000000-0000-0000-0000-0000000065a1'), 1,
  'retained: the deletion''s record (id and times only)');
select is((select count(*)::int from public.posts where public_id in (current_setting('test.p_kept'), current_setting('test.p_bob'))), 2,
  'the kept thread and Bob''s thread are still there');

update public.account_deletions set completed_at = now() - interval '31 days' where user_id = '00000000-0000-0000-0000-0000000065a1';
select is(public.purge_account_deletions(), 1, 'the record is purged 30 days after completion');

select * from finish();
rollback;
