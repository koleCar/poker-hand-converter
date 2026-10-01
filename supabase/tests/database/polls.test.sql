-- pgTAP: "What would you do?" polls (F14, #51) -- `20261130090000_forum_polls.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(32);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000009a1', 'poll.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000009b1', 'poll.b@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000009c1', 'poll.c@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000009d1', 'poll.mod@example.com', now() - interval '40 days', now() - interval '40 days');
update public.profiles set username = 'poll_author' where id = '00000000-0000-0000-0000-0000000009a1';
update public.profiles set username = 'poll_voter'  where id = '00000000-0000-0000-0000-0000000009b1';
update public.profiles set username = 'poll_reader' where id = '00000000-0000-0000-0000-0000000009c1';
update public.profiles set username = 'poll_mod', role = 'moderator' where id = '00000000-0000-0000-0000-0000000009d1';

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

-- A heads-up hand: Hero raises, BB calls, BB checks the flop, Hero bets (the
-- decision, index 4), BB raises, Hero calls, BB shows queens and wins.
create function pg_temp.hand_phf(p_id text) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'meta', jsonb_build_object('siteId', 'pokerstars', 'siteName', 'PokerStars', 'handId', p_id, 'handKey', p_id,
      'originalFilename', null, 'parserId', 'pokerstars', 'parserVersion', '1', 'warnings', '[]'::jsonb,
      'rawText', 'PokerStars Hand #' || p_id || ': SneakyPete shows [Qs Qd]', 'parsedAt', '2026-09-01T10:11:12Z',
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

insert into public.hands (id, owner_id, hand_key, phf, standard_text, source_text, site, played_at, hero_seat) values
  ('00000000-0000-0000-0000-00000000ab01', '00000000-0000-0000-0000-0000000009a1', 'pokerstars:p1', pg_temp.hand_phf('p1'), 'std', 'raw', 'pokerstars', now(), 1),
  ('00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-0000000009a1', 'pokerstars:p2', pg_temp.hand_phf('p2'), 'std', 'raw', 'pokerstars', now(), 1);

select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');
select set_config('test.h1', public.publish_hand('00000000-0000-0000-0000-00000000ab01') ->> 'publicId', true);
select set_config('test.h2', public.publish_hand('00000000-0000-0000-0000-00000000ab02') ->> 'publicId', true);

-- ------------------------------------------------------------- creating --

select throws_ok($$ select public.create_poll_post('nlhe', 'Bet or check?', '', current_setting('test.h1'), 5, array['call','raise','fold']) $$,
  '22023', null, 'a poll stops at the author''s own decision, not a villain''s');
select throws_ok($$ select public.create_poll_post('nlhe', 'Bet or check?', '', current_setting('test.h1'), 4, array['check','fold']) $$,
  '22023', null, 'the options must include what the hero did');
select throws_ok($$ select public.create_poll_post('nlhe', 'Bet or check?', '', current_setting('test.h1'), 4, array['bet']) $$,
  '22023', null, 'a poll needs at least two options');

select set_config('test.p', public.create_poll_post('nlhe', 'Bet or check the flop?', 'Villain is a reg.',
  current_setting('test.h1'), 4, array['check', 'bet']) ->> 'publicId', true);
select ok(current_setting('test.p') ~ '^[a-z0-9]{8}$', 'a poll post is created');

-- A hand that already has a thread cannot be turned into a poll.
select public.create_post('nlhe', 'Plain thread', '', current_setting('test.h2'));
select throws_ok($$ select public.create_poll_post('nlhe', 'Again', '', current_setting('test.h2'), 4, array['check','bet']) $$,
  '22023', null, 'a hand with a thread already is not sealed under a poll');

select pg_temp.act_as_owner();
select is((select status from public.published_hands where public_id = current_setting('test.h1')), 'poll',
  'the hand is sealed');

-- --------------------------------------------------- what a stranger sees --

select pg_temp.act_as_anon();
select is(public.read_published_hand(current_setting('test.h1')) -> 'phf', null,
  '/p/:id no longer serves the document');
select is((select count(*)::int from public.published_hands where public_id = current_setting('test.h1')), 0,
  'nor does a direct table read');
select is(public.read_published_hand(current_setting('test.h1')) ->> 'status', 'poll', '/p/:id says it is a poll');
select is(public.poll_post_of_hand(current_setting('test.h1')) ->> 'publicId', current_setting('test.p'), '... and where to answer it');
select is(public.get_post(current_setting('test.p')) -> 'handPhf', 'null'::jsonb, 'get_post carries no hand');
select is(public.get_post(current_setting('test.p')) -> 'hand', 'null'::jsonb, '... and the card no hero cards');
select is(public.get_post(current_setting('test.p')) -> 'poll' -> 'options', '["bet", "check"]'::jsonb,
  'the card says it is a poll, with its options');

select is((public.read_poll(current_setting('test.p')) ->> 'revealed')::boolean, false, 'the spot is not revealed');
select is(jsonb_array_length(public.read_poll(current_setting('test.p')) -> 'phf' -> 'actions'), 4,
  'the spot holds the actions before the decision');
select is(public.read_poll(current_setting('test.p')) -> 'phf' -> 'board' -> 'runouts' -> 0 -> 'flop',
  '["2c", "7d", "Kd"]'::jsonb, 'the flop, because the decision is on the flop');
select ok((public.read_poll(current_setting('test.p')) -> 'phf')::text !~ '(Qs|Qd|Qh|3s)',
  'no villain card, turn or river anywhere in the document');
select is(public.read_poll(current_setting('test.p')) -> 'phf' -> 'players' -> 0 -> 'holeCards', '["Ah", "Kh"]'::jsonb,
  'the hero''s cards are shown (the author did not hide them)');
select is(public.read_poll(current_setting('test.p')) -> 'phf' -> 'results' -> 'winners', '[]'::jsonb, 'no winners');
select throws_ok($$ select public.vote_poll(current_setting('test.p'), 'bet') $$, '42501', null, 'anon cannot vote');

-- ------------------------------------------------------------ discussion --

select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');
select public.create_comment(current_setting('test.p'), 'I bet and got raised by queens.');
select pg_temp.act_as('00000000-0000-0000-0000-0000000009b1');
select is(jsonb_array_length(public.get_post_comments(current_setting('test.p'))), 0,
  'the discussion is hidden from a reader who has not voted');
select is((select count(*)::int from public.comments c join public.posts p on p.id = c.post_id
           where p.public_id = current_setting('test.p')), 0, '... also from a direct table read');

-- ------------------------------------------------------------------ vote --

select throws_ok($$ select public.vote_poll(current_setting('test.p'), 'raise') $$, '22023', null, 'only the offered options');
select throws_ok($$ select public.vote_poll(current_setting('test.p'), 'check', 50) $$, '22023', null, 'a size goes with a bet');
select is((public.vote_poll(current_setting('test.p'), 'bet', 75) ->> 'revealed')::boolean, true, 'voting reveals');
select is(jsonb_array_length(public.read_poll(current_setting('test.p')) -> 'phf' -> 'actions'), 8, '... the whole hand');
select is(public.read_poll(current_setting('test.p')) -> 'results' -> 'bet', '{"votes": 1, "medianSizePct": 75}'::jsonb,
  '... and the distribution');
select is(jsonb_array_length(public.get_post_comments(current_setting('test.p'))), 1, '... and the discussion');
select throws_ok($$ select public.vote_poll(current_setting('test.p'), 'check') $$, '22023', null, 'one vote, final');
select throws_ok($$ select * from public.poll_votes $$, '42501', null, 'votes are sealed');

select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');
select throws_ok($$ select public.vote_poll(current_setting('test.p'), 'check') $$, '22023', null, 'the author does not vote');

select pg_temp.act_as('00000000-0000-0000-0000-0000000009d1');
select is((public.read_poll(current_setting('test.p')) ->> 'revealed')::boolean, true, 'a moderator sees the answer');

select * from finish();
rollback;
