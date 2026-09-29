-- pgTAP: the forum (F8, #32 / #33 / #34 / #37) -- `20261019090000_forum_core.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(63);

-- ------------------------------------------------------------------ setup --

-- A, B: aged and confirmed.  Y: an hour old (may post, votes weigh 0).
-- S: will be shadowbanned.
insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'forum.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000f2', 'forum.b@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000f3', 'forum.y@example.com', now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000f4', 'forum.s@example.com', now() - interval '40 days', now() - interval '40 days');

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

-- ---------------------------------------------------------- ranking maths --

select ok(public.forum_hot_rank(10, '2026-01-02') > public.forum_hot_rank(10, '2026-01-01'), 'newer is hotter at equal score');
select ok(public.forum_hot_rank(100, '2026-01-01') > public.forum_hot_rank(10, '2026-01-01'), 'more votes is hotter at equal age');
select is(
  public.forum_hot_rank(50, '2026-01-01') > public.forum_hot_rank(5, '2026-01-02'),
  public.forum_hot_rank(50, '2026-03-01') > public.forum_hot_rank(5, '2026-03-02'),
  'the relative order of two posts does not change as they age');
select ok(public.forum_best_rank(5, 0) > public.forum_best_rank(50, 40), 'best: 5/0 beats 50/40');
select is(public.forum_controversy(10, 0), 0::double precision, 'a unanimous post is not controversial');
select ok(public.forum_controversy(50, 50) > public.forum_controversy(90, 10), 'an even split is more controversial');
select is(public.forum_path_segment(1), '000001', 'path segments are fixed width');
select is(public.forum_path_segment(36), '000010', '... in base 36');
select is(public.forum_slugify('AK on a paired board vs. a turn JAM!!'), 'ak-on-a-paired-board-vs-a-turn-jam', 'slugs');
select ok(exists (select 1 from pg_constraint where conname = 'board_moderators_board_fk'),
  'board_moderators finally has its foreign key');

-- ------------------------------------------------------------------ posts --

select pg_temp.act_as_anon();
select throws_ok($$ select public.create_post('nlhe', 'Anon post', 'hello') $$, '42501', null, 'anon cannot post');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select throws_ok($$ select public.create_post('nope', 'A title', 'x') $$, '22023', 'That board does not exist.', 'unknown board');
select throws_ok($$ select public.create_post('nlhe', 'A title', '') $$, '22023', 'Say something, or attach a hand.',
  'a text post needs text');
select throws_ok($$ select public.create_post('nlhe', 'x', 'body') $$, '22023', 'Titles are 3 to 300 characters.', 'title length');
select throws_ok($$ select public.create_post('nlhe', 'Hand post', '', 'zzzzzzzzzz') $$, '22023',
  'That published hand does not exist.', 'a hand post needs one of your own published hands');

select ok((public.create_post('nlhe', 'Is this a fold on the river?', 'Villain jams, I have top pair.') ->> 'publicId')
          ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8}$', 'A posts');
select pg_temp.act_as_owner();
select set_config('test.p1', (select public_id from public.posts where author_id = '00000000-0000-0000-0000-0000000000f1'), true);
select is((select upvotes || '/' || score from public.posts where public_id = current_setting('test.p1')), '1/1',
  'the author''s implicit upvote counts, weighted 1 for an aged account');
select is((select slug from public.posts where public_id = current_setting('test.p1')), 'is-this-a-fold-on-the-river',
  'the slug is generated from the title');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select lives_ok($$ select public.create_post('general', 'A new account posts', 'hi') $$, 'an hour-old account may post');
select pg_temp.act_as_owner();
select is((select upvotes || '/' || score from public.posts where author_id = '00000000-0000-0000-0000-0000000000f3'), '1/0',
  '... but its vote moves the count, not the score');

-- ------------------------------------------------------------------ votes --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select is((public.vote_post(current_setting('test.p1'), 1) ->> 'score')::int, 2, 'B upvotes: score 2');
select is((public.vote_post(current_setting('test.p1'), -1) ->> 'score')::int, 0, 'B changes to a downvote: recount, not a delta');
select is((public.vote_post(current_setting('test.p1'), 0) ->> 'score')::int, 1, 'B takes it back');
select throws_ok($$ select public.vote_post(current_setting('test.p1'), 5) $$, '22023', null, 'a vote is 1, -1 or 0');
select is(public.my_post_votes(array[current_setting('test.p1')]), '{}'::jsonb, 'B''s vote is gone from my_post_votes');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f3');
select is((public.vote_post(current_setting('test.p1'), 1) ->> 'upvotes')::int, 2, 'a fresh account''s arrow works ...');
select is((public.vote_post(current_setting('test.p1'), 1) ->> 'score')::int, 1, '... and the score does not move');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.vote_post(current_setting('test.p1'), 1);
select pg_temp.act_as_owner();
select is((select karma from public.profiles where id = '00000000-0000-0000-0000-0000000000f1'), 1,
  'karma counts B''s vote and not A''s own');

-- ------------------------------------------------------------ edit/delete --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select throws_ok($$ select public.edit_post(current_setting('test.p1'), 'Hijacked', 'mine now') $$, '22023',
  'That post does not exist.', 'B cannot edit A''s post, and is told it does not exist');
select is(public.delete_post(current_setting('test.p1')), false, 'B cannot delete it either');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select is(public.edit_post(current_setting('test.p1'), 'Is this a fold on the river? (edited)', 'Top pair, good kicker.') ->> 'slug',
  'is-this-a-fold-on-the-river-edited', 'A edits; the slug follows');
select pg_temp.act_as_owner();
select is((select details ->> 'title' from public.moderation_actions where action = 'post.edit'),
  'Is this a fold on the river?', 'the edit is audited with the previous title');

-- --------------------------------------------------------------- comments --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select is((public.create_comment(current_setting('test.p1'), 'Snap call.') ->> 'seq')::int, 1, 'B comments: seq 1');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select is((public.create_comment(current_setting('test.p1'), 'Why?', 1) ->> 'seq')::int, 2, 'A replies: seq 2');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select is((public.create_comment(current_setting('test.p1'), 'Blockers.', 2) ->> 'seq')::int, 3, 'B replies to the reply: seq 3');
select throws_ok($$ select public.create_comment(current_setting('test.p1'), 'x', 99) $$, '22023',
  'The comment you are replying to does not exist.', 'replying to nothing');
select throws_ok($$ select public.create_comment(current_setting('test.p1'), 'At the turn', null, 7, 'turn') $$, '22023',
  'Only a hand post has moments to comment on.', 'a text post has no replayer to anchor to');

select pg_temp.act_as_owner();
select is((select array_agg(path order by seq) from public.comments c join public.posts p on p.id = c.post_id
           where p.public_id = current_setting('test.p1')),
  array['000001', '000001000002', '000001000002000003'], 'paths are fixed width and nest');
select is((select comment_count from public.posts where public_id = current_setting('test.p1')), 3, 'comment_count is exact');

-- Depth is capped at ten.
do $deep$
declare i integer; parent integer := 3;
begin
  for i in 1..7 loop
    perform pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
    parent := (public.create_comment(current_setting('test.p1'), 'deeper', parent) ->> 'seq')::int;
  end loop;
  perform pg_temp.act_as_owner();
  perform set_config('test.deepest', parent::text, true);
end;
$deep$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select throws_ok($$ select public.create_comment(current_setting('test.p1'), 'too deep', current_setting('test.deepest')::int) $$,
  '22023', 'This thread is as deep as it goes. Reply further up.', 'depth is capped at 10');

-- A deleted parent becomes a tombstone and keeps its replies attached.
select is(public.delete_comment(current_setting('test.p1'), 1), true, 'B deletes their comment');
select pg_temp.act_as_anon();
select is(
  (select c ->> 'body' from jsonb_array_elements(public.get_post_comments(current_setting('test.p1'))) c where (c ->> 'seq')::int = 1),
  null, 'the tombstone has no body ...');
select is(
  (select (c ->> 'deleted')::boolean and c -> 'author' = 'null'::jsonb
     from jsonb_array_elements(public.get_post_comments(current_setting('test.p1'))) c where (c ->> 'seq')::int = 1),
  true, '... and no author ...');
select is(
  (select c ->> 'body' from jsonb_array_elements(public.get_post_comments(current_setting('test.p1'))) c where (c ->> 'seq')::int = 2),
  'Why?', '... and its reply is still there');
select pg_temp.act_as_owner();
select is((select details ->> 'body' from public.moderation_actions where action = 'comment.delete'), 'Snap call.',
  'the deleted words are kept for moderators');

-- ------------------------------------------------------------- shadowbans --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
select public.create_post('general', 'Buy cheap chips here', 'spam spam');
select pg_temp.act_as_owner();
update public.profiles set is_shadowbanned = true where id = '00000000-0000-0000-0000-0000000000f4';

select pg_temp.act_as_anon();
select is((select count(*)::int from public.posts where title = 'Buy cheap chips here'), 0, 'a shadowbanned post is invisible to anon');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select is((select count(*)::int from public.posts where title = 'Buy cheap chips here'), 0, '... and to other accounts');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f4');
select is((select count(*)::int from public.posts where title = 'Buy cheap chips here'), 1, '... but not to its author');

-- ------------------------------------------------------------------- feed --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select public.create_post('nlhe', 'Second nlhe post', 'b');
select public.create_post('nlhe', 'Third nlhe post', 'c');
select pg_temp.act_as_anon();
select is(jsonb_array_length(public.forum_feed('nlhe', 'new', null, 2) -> 'posts'), 2, 'the first page has two');
select isnt(public.forum_feed('nlhe', 'new', null, 2) ->> 'next', null, '... and a cursor');
select is(
  jsonb_array_length(public.forum_feed('nlhe', 'new', public.forum_feed('nlhe', 'new', null, 2) ->> 'next', 2) -> 'posts'), 1,
  'the second page has the rest');
select is(
  (select count(distinct p ->> 'publicId')::int from (
     select jsonb_array_elements(public.forum_feed('nlhe', 'new', null, 2) -> 'posts') p
     union all
     select jsonb_array_elements(public.forum_feed('nlhe', 'new', public.forum_feed('nlhe', 'new', null, 2) ->> 'next', 2) -> 'posts')) x),
  3, 'no post appears on both pages');
select is(jsonb_array_length(public.forum_feed('nlhe', 'hot', 'garbage~cursor', 2) -> 'posts'), 2,
  'a mangled cursor is the first page, not an error');
select is(public.forum_feed('no-such-board'), null, 'an unknown board is null');

-- --------------------------------------------------------------- deletion --

select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select is(public.delete_post(current_setting('test.p1')), true, 'A deletes their post');
select pg_temp.act_as_anon();
select is(public.get_post(current_setting('test.p1')), null, 'it is gone from the invoker read');
select is(public.post_status(current_setting('test.p1')), 'deleted', 'and the page can say it was deleted');

-- ----------------------------------------------------------------- search --

select is(
  (select count(*)::int from jsonb_array_elements(public.search_forum('"third nlhe"')) r where r ->> 'type' = 'post'),
  1, 'search finds a post by phrase');
select is(
  (select count(*)::int from jsonb_array_elements(public.search_forum('fold river')) r),
  0, 'search does not find a deleted post or its comments');

-- ------------------------------------------------------------- grant wall --

select throws_ok($$ insert into public.posts (public_id, board_id, kind, title) select '22222222', id, 'text', 'x' from public.boards limit 1 $$,
  '42501', null, 'anon cannot insert posts');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select throws_ok($$ update public.posts set score = 9999 $$, '42501', null, 'nobody can update a score');
select throws_ok($$ select * from public.post_votes $$, '42501', null, 'votes are sealed');
select throws_ok($$ select * from public.moderation_actions $$, '42501', null, 'the audit log is sealed');

select * from finish();
rollback;
