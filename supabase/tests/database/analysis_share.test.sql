-- pgTAP: sharing a hand's analysis (A7.1) -- `20270222090000_analysis_share.sql`.
--
-- What has to hold:
--
--   * the security model: no client INSERT / UPDATE / DELETE on
--     `analysis_shares`, RLS on and select-own; the writer, the owner's state
--     and the public read are security definer with an empty search_path;
--     the internals are executable by nobody, the switch and the state not
--     by anon;
--   * only the owner can turn the flag on or off, by any surface they made,
--     and "not yours" reads like "no such hand";
--   * the public read returns nothing for an unshared hand, a hand that is
--     not public, another user's private hand, anon on a private hand, a
--     removed or unpublished publication, another version; and the analysis,
--     projected, for a shared hand on a public surface;
--   * a poll's reference stays hidden until the reader has voted (author and
--     moderators excepted), by the database.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(53);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000a7a1', 'share.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a7b1', 'share.b@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a7c1', 'share.c@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a7d1', 'share.mod@example.com', now() - interval '40 days', now() - interval '40 days');
update public.profiles set username = 'share_author' where id = '00000000-0000-0000-0000-00000000a7a1';
update public.profiles set username = 'share_voter'  where id = '00000000-0000-0000-0000-00000000a7b1';
update public.profiles set username = 'share_reader' where id = '00000000-0000-0000-0000-00000000a7c1';
update public.profiles set username = 'share_mod', role = 'moderator' where id = '00000000-0000-0000-0000-00000000a7d1';

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

-- The polls test's hand: Hero raises (index 1), BB calls, checks the flop,
-- Hero bets (index 4), BB raises, Hero calls, BB shows queens.
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
                         'holeCards', jsonb_build_array('Qs', 'Qd'), 'dealtCards', '[]'::jsonb)),
    'actions', jsonb_build_array(
      jsonb_build_object('index', 0, 'street', 'preflop', 'seat', 2, 'player', 'SneakyPete', 'type', 'big-blind', 'amount', 2, 'allIn', false),
      jsonb_build_object('index', 1, 'street', 'preflop', 'seat', 1, 'player', 'HeroHannah', 'type', 'raise', 'amount', 6, 'allIn', false),
      jsonb_build_object('index', 2, 'street', 'preflop', 'seat', 2, 'player', 'SneakyPete', 'type', 'call', 'amount', 4, 'allIn', false),
      jsonb_build_object('index', 3, 'street', 'flop', 'seat', 2, 'player', 'SneakyPete', 'type', 'check', 'amount', 0, 'allIn', false),
      jsonb_build_object('index', 4, 'street', 'flop', 'seat', 1, 'player', 'HeroHannah', 'type', 'bet', 'amount', 8, 'allIn', false),
      jsonb_build_object('index', 5, 'street', 'flop', 'seat', 2, 'player', 'SneakyPete', 'type', 'raise', 'amount', 30, 'allIn', false),
      jsonb_build_object('index', 6, 'street', 'flop', 'seat', 1, 'player', 'HeroHannah', 'type', 'call', 'amount', 22, 'allIn', false),
      jsonb_build_object('index', 7, 'street', 'river', 'seat', 2, 'player', 'SneakyPete', 'type', 'show', 'amount', 0, 'allIn', false,
                         'cards', jsonb_build_array('Qs', 'Qd'))),
    'board', jsonb_build_object('runouts', jsonb_build_array(jsonb_build_object(
      'index', 0, 'flop', jsonb_build_array('2c', '7d', 'Kd'), 'turn', 'Qh', 'river', '3s',
      'markerLabels', '{}'::jsonb, 'summaryCards', jsonb_build_array('2c', '7d', 'Kd', 'Qh', '3s')))),
    'chipMovements', '[]'::jsonb,
    'results', jsonb_build_object('totalPot', 72, 'pots', '[]'::jsonb,
      'fees', jsonb_build_object('rake', 0, 'jackpot', 0, 'bingo', 0, 'fortune', 0, 'tax', 0, 'other', 0),
      'players', '[]'::jsonb,
      'winners', jsonb_build_array(jsonb_build_object('player', 'SneakyPete', 'seat', 2, 'amount', 72, 'runoutIndex', 0)),
      'heroNet', -36, 'wentToShowdown', true, 'streetReached', 'river'));
$$;
grant execute on function pg_temp.hand_phf(text) to anon, authenticated;

-- A's hands: 1 published, 2 in a plain thread, 3 a poll, 4 private, 5 a share
-- link. B's hand 9 is private.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, source_text, site, played_at, hero_seat) values
  ('00000000-0000-0000-0000-00000000a701', '00000000-0000-0000-0000-00000000a7a1', 'pokerstars:s1', pg_temp.hand_phf('s1'), 'std', 'raw', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000000a702', '00000000-0000-0000-0000-00000000a7a1', 'pokerstars:s2', pg_temp.hand_phf('s2'), 'std', 'raw', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000000a703', '00000000-0000-0000-0000-00000000a7a1', 'pokerstars:s3', pg_temp.hand_phf('s3'), 'std', 'raw', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000000a704', '00000000-0000-0000-0000-00000000a7a1', 'pokerstars:s4', pg_temp.hand_phf('s4'), 'std', 'raw', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000000a705', '00000000-0000-0000-0000-00000000a7a1', 'pokerstars:s5', pg_temp.hand_phf('s5'), 'std', 'raw', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000000a709', '00000000-0000-0000-0000-00000000a7b1', 'pokerstars:s9', pg_temp.hand_phf('s9'), 'std', 'raw', 'pokerstars', now(), 1);

-- One analysis row per hand at analysis/3: a perfect preflop raise and a
-- flop bet graded a Mistake. The facts and options carry keys nobody listed
-- (`secret`, `junk`), which must not reach a stranger.
create function pg_temp.analysis_of(p_hand text) returns jsonb language sql as $$
  select jsonb_build_object(
    'hand_id', p_hand, 'analysis_version', 'analysis/3', 'status', 'full', 'hero_seat', 1,
    'pot_type', 'single-raised', 'grade', 'mistake', 'score', 60, 'ev_loss_bb', 0.6, 'ev_loss_pot', 0.05,
    'approximations', '["narrowing-heuristic"]'::jsonb,
    'decisions', jsonb_build_array(
      jsonb_build_object('ord', 0, 'action_index', 1, 'street', 'preflop', 'action', 'raise', 'status', 'analysed',
        'node', 'n', 'scenario', 'unopened', 'source', 'chart', 'grade', 'perfect', 'score', 100,
        'ev_loss_bb', 0, 'ev_loss_pot', 0, 'freq_diff', 0,
        'options', '[{"action":"fold","sizeBb":0,"freq":0,"ev":0},{"action":"raise","sizeBb":2.5,"freq":1,"ev":1.2,"junk":"x"}]'::jsonb,
        'chosen', 1, 'flags', '[]'::jsonb, 'approximations', '[]'::jsonb, 'facing_bet', false, 'pot_bb', 1.5,
        'facts', '{"street":"preflop","position":"BTN","handClass":"AKs","holeCards":["Ah","Kh"],"secret":"Qs Qd"}'::jsonb),
      jsonb_build_object('ord', 2, 'action_index', 4, 'street', 'flop', 'action', 'bet', 'status', 'analysed',
        'node', 'n', 'scenario', 'pfr-ip-first', 'source', 'solver', 'grade', 'mistake', 'score', 40,
        'ev_loss_bb', 0.6, 'ev_loss_pot', 0.05, 'freq_diff', 0.7,
        'options', '[{"action":"check","freq":0.8,"ev":3.1},{"action":"bet","size":4,"sizePot":0.33,"freq":0.1,"ev":2.5},{"action":"bet","size":9,"sizePot":0.75,"freq":0.1,"ev":2.4}]'::jsonb,
        'chosen', 2, 'flags', '[]'::jsonb, 'approximations', '["narrowing-heuristic"]'::jsonb, 'facing_bet', false, 'pot_bb', 12,
        'facts', '{"street":"flop","position":"BTN","board":["2c","7d","Kd"],"potBb":12}'::jsonb)));
$$;
grant execute on function pg_temp.analysis_of(text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select public.save_hand_analysis(jsonb_build_array(
  pg_temp.analysis_of('00000000-0000-0000-0000-00000000a701'),
  pg_temp.analysis_of('00000000-0000-0000-0000-00000000a702'),
  pg_temp.analysis_of('00000000-0000-0000-0000-00000000a703'),
  pg_temp.analysis_of('00000000-0000-0000-0000-00000000a704'),
  pg_temp.analysis_of('00000000-0000-0000-0000-00000000a705')));
select set_config('test.p1', public.publish_hand('00000000-0000-0000-0000-00000000a701') ->> 'publicId', true);
select set_config('test.p2', public.publish_hand('00000000-0000-0000-0000-00000000a702') ->> 'publicId', true);
select set_config('test.p3', public.publish_hand('00000000-0000-0000-0000-00000000a703') ->> 'publicId', true);
select set_config('test.thread', public.create_post('nlhe', 'Flop bet with AK?', '', current_setting('test.p2')) ->> 'publicId', true);
select set_config('test.poll', public.create_poll_post('nlhe', 'Bet or check the flop?', '',
  current_setting('test.p3'), 4, array['check', 'bet']) ->> 'publicId', true);
select set_config('test.slug', public.create_share('00000000-0000-0000-0000-00000000a705') ->> 'slug', true);

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7b1');
select public.save_hand_analysis(jsonb_build_array(pg_temp.analysis_of('00000000-0000-0000-0000-00000000a709')));

select pg_temp.act_as_owner();

-- ---------------------------------------------------------------- grants --

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'analysis_shares'
     and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, 'no client write grant on analysis_shares');
select ok(not has_table_privilege('anon', 'public.analysis_shares', 'select'), 'anon cannot read the flags at all');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.analysis_shares'::regclass), 'RLS is on');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 4 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('set_analysis_share', 'analysis_share_state', 'read_shared_analysis', 'analysis_share_target')),
  'the switch, the state, the read and the resolver are security definer');
select ok(
  (select bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') and count(*) = 7 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('set_analysis_share', 'analysis_share_state', 'read_shared_analysis', 'analysis_share_target',
                       'analysis_public_facts', 'analysis_public_options', 'analysis_public_flags')),
  'every one pins an empty search_path');
select ok(
  has_function_privilege('anon', 'public.read_shared_analysis(text, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.read_shared_analysis(text, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.set_analysis_share(text, text, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.analysis_share_state(text, text)', 'execute'),
  'anyone may read; a signed-in owner may switch and see the state');
select ok(
  not has_function_privilege('anon', 'public.set_analysis_share(text, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_share_state(text, text)', 'execute'),
  'anon may not switch or see the state');
select ok(
  not has_function_privilege('anon', 'public.analysis_share_target(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_share_target(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_public_facts(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_public_options(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_public_flags(jsonb)', 'execute'),
  'the internals are executable by nobody');

-- ------------------------------------------------------------ off by default --

select pg_temp.act_as_anon();
select is(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3'), null,
  'a published hand shows no analysis until its owner shares it');
select is(public.read_shared_analysis('post', current_setting('test.thread'), 'analysis/3'), null,
  '... nor does its thread');
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/3'), null,
  '... nor a share link');
select throws_ok($$ select public.set_analysis_share('published', current_setting('test.p1'), true) $$,
  '42501', null, 'anon cannot switch');

-- ---------------------------------------------------- only the owner switches --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7b1');
select throws_ok($$ select public.set_analysis_share('hand', '00000000-0000-0000-0000-00000000a701', true) $$,
  '22023', 'That hand does not exist.', 'another user cannot share my hand by its id');
select throws_ok($$ select public.set_analysis_share('published', current_setting('test.p1'), true) $$,
  '22023', 'That hand does not exist.', '... nor by its published page');
select throws_ok($$ select public.set_analysis_share('post', current_setting('test.poll'), true) $$,
  '22023', 'That hand does not exist.', '... nor by its poll');
select throws_ok($$ select public.set_analysis_share('share', current_setting('test.slug'), true) $$,
  '22023', 'That hand does not exist.', '... nor by its share link');
select throws_ok($$ select public.set_analysis_share('hand', '00000000-0000-0000-0000-00000000dead', true) $$,
  '22023', 'That hand does not exist.', 'an unknown hand reads exactly the same');
select is(public.analysis_share_state('hand', '00000000-0000-0000-0000-00000000a701'), null,
  'another user cannot see whether my hand is shared');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select is(public.analysis_share_state('published', current_setting('test.p1')),
  '{"handId": "00000000-0000-0000-0000-00000000a701", "shared": false, "versions": ["analysis/3"]}'::jsonb,
  'the owner sees the flag off, and which versions are stored');
select is((public.set_analysis_share('hand', '00000000-0000-0000-0000-00000000a701', true) ->> 'shared')::boolean, true,
  'the owner shares by the hand''s id');
select is((public.set_analysis_share('post', current_setting('test.thread'), true) ->> 'shared')::boolean, true,
  '... by their thread');
select is((public.set_analysis_share('post', current_setting('test.poll'), true) ->> 'shared')::boolean, true,
  '... by their poll');
select is((public.set_analysis_share('hand', '00000000-0000-0000-0000-00000000a704', true) ->> 'shared')::boolean, true,
  '... and may share a hand that is not public anywhere (it stays unreadable)');
select is((select count(*)::int from public.analysis_shares), 4, 'the owner reads their own flags');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7b1');
select is((select count(*)::int from public.analysis_shares), 0, '... and nobody else does');
select is((public.set_analysis_share('hand', '00000000-0000-0000-0000-00000000a709', true) ->> 'shared')::boolean, true,
  'B shares B''s own private hand');

-- --------------------------------------------------------- the public read --

select pg_temp.act_as_anon();
select isnt(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3'), null,
  'shared and published: anon reads the analysis');
select is(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3') ->> 'grade', 'mistake',
  '... with the hand''s grade');
select is(jsonb_array_length(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3') -> 'decisions'), 2,
  '... and its decisions');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3')) k),
  array['analysisVersion', 'approximations', 'decisions', 'evLossBb', 'evLossPot', 'flagCount', 'grade', 'heroSeat',
        'potType', 'reason', 'score', 'status', 'worstFlag'],
  'named keys only: no hand id, no owner');
select ok(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3')::text !~ '(00000000-0000|secret|junk|Qs Qd)',
  'no id, and no facts or option key nobody listed');
select is(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3') -> 'decisions' -> 1 -> 'options' -> 1,
  '{"action": "bet", "size": 4, "sizePot": 0.33, "freq": 0.1, "ev": 2.5}'::jsonb, 'options keep their seven keys');
select is(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/2'), null,
  'another version: nothing');
select is(public.read_shared_analysis('published', current_setting('test.p1'), 'latest'), null, 'a malformed version: nothing');
select is(public.read_shared_analysis('post', current_setting('test.thread'), 'analysis/3') -> 'decisions' -> 1 ->> 'grade', 'mistake',
  'shared and in a visible thread: anon reads it');
select is(public.read_shared_analysis('hand', '00000000-0000-0000-0000-00000000a704', 'analysis/3'), null,
  'anon on a shared but private hand: nothing (a hand id is not a public surface)');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select is(public.read_shared_analysis('hand', '00000000-0000-0000-0000-00000000a709', 'analysis/3'), null,
  'another user''s shared private hand: nothing');
select is(public.read_shared_analysis('published', '2222222222', 'analysis/3'), null, 'an unknown page: nothing');

-- A share link is a capability URL: shared, it shows; switched off, it does not.
select pg_temp.act_as_anon();
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/3'), null,
  'a share link of an unshared hand: nothing');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select is((public.set_analysis_share('share', current_setting('test.slug'), true) ->> 'shared')::boolean, true,
  'the owner shares from the share dialog');
select pg_temp.act_as_anon();
select is(public.read_shared_analysis('share', current_setting('test.slug'), 'analysis/3') ->> 'status', 'full',
  '... and the link shows it');

-- -------------------------------------------------------------------- poll --

select is(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3'), null,
  'a poll: anon gets no reference before the reveal');
select is(public.read_shared_analysis('published', current_setting('test.p3'), 'analysis/3'), null,
  '... nor through the sealed hand''s page');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a7c1');
select is(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3'), null,
  '... nor a signed-in reader who has not voted');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a7b1');
select is(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3'), null, 'B, before voting: nothing');
select public.vote_poll(current_setting('test.poll'), 'bet', 75);
select is(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3') -> 'decisions' -> 1 ->> 'actionIndex', '4',
  'B, after voting: the reference for the polled decision');
select is(public.read_shared_analysis('published', current_setting('test.p3'), 'analysis/3'), null,
  '... still never through the sealed page');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select isnt(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3'), null, 'the author sees it');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a7d1');
select isnt(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3'), null, 'a moderator sees it');

-- ------------------------------------------------------------- switching off --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select is((public.set_analysis_share('published', current_setting('test.p3'), false) ->> 'shared')::boolean, false,
  'the owner switches the poll''s hand off');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a7b1');
select is(public.read_shared_analysis('post', current_setting('test.poll'), 'analysis/3'), null,
  '... and the voter no longer gets it');

-- ---------------------------------------------- unpublished and removed hands --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a7a1');
select public.unpublish_hand(current_setting('test.p1'));
select pg_temp.act_as_anon();
select is(public.read_shared_analysis('published', current_setting('test.p1'), 'analysis/3'), null,
  'an unpublished hand: nothing, shared or not');

select pg_temp.act_as_owner();
update public.published_hands set status = 'removed' where public_id = current_setting('test.p2');
select pg_temp.act_as_anon();
select is(public.read_shared_analysis('post', current_setting('test.thread'), 'analysis/3'), null,
  'a hand a moderator removed: nothing, even from its thread');

select * from finish();
rollback;
