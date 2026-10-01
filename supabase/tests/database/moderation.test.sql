-- pgTAP: moderation and anti-abuse (F10, #40 / #41) -- `20261102090000_forum_moderation.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(58);

-- ------------------------------------------------------------------ setup --
-- M: site moderator.  X: admin.  K: board moderator of 'modtest'.
-- U: an ordinary member.  V: another member.  N: low-karma member for spam.

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000a0a1', 'mod.m@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a0a2', 'mod.x@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a0a3', 'mod.k@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a0a4', 'mod.u@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a0a5', 'mod.v@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000a0a6', 'mod.n@example.com', now() - interval '40 days', now() - interval '40 days');

update public.profiles set username = 'mod_m', role = 'moderator' where id = '00000000-0000-0000-0000-00000000a0a1';
update public.profiles set username = 'admin_x', role = 'admin' where id = '00000000-0000-0000-0000-00000000a0a2';
update public.profiles set username = 'boardmod_k' where id = '00000000-0000-0000-0000-00000000a0a3';
update public.profiles set username = 'member_u', karma = 100 where id = '00000000-0000-0000-0000-00000000a0a4';
update public.profiles set username = 'member_v', karma = 100 where id = '00000000-0000-0000-0000-00000000a0a5';
update public.profiles set username = 'newbie_n' where id = '00000000-0000-0000-0000-00000000a0a6';

insert into public.boards (slug, name) values ('modtest', 'Mod test'), ('othertest', 'Other test');
insert into public.board_moderators (board_id, user_id)
select id, '00000000-0000-0000-0000-00000000a0a3' from public.boards where slug = 'modtest';

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

-- ------------------------------------------------------------- spam gate --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a6');
select set_config('test.spam', public.create_post('modtest', 'Cheap chips everywhere',
  'https://a.example https://b.example https://c.example') ->> 'publicId', true);
select pg_temp.act_as_owner();
select is((select status from public.posts where public_id = current_setting('test.spam')), 'spam',
  'three links from a zero-karma account: created as spam, not rejected');
select is((select count(*)::int from public.moderation_actions where action = 'post.auto_spam'
             and target_id = (select id from public.posts where public_id = current_setting('test.spam'))), 1, '... and queued');
select pg_temp.act_as_anon();
select is((select count(*)::int from public.posts where public_id = current_setting('test.spam')), 0, 'anon cannot see it');
select is(public.post_status(current_setting('test.spam')), null, '... and cannot tell it exists');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a6');
select is((select count(*)::int from public.posts where public_id = current_setting('test.spam')), 1,
  'its author sees it as normal');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a4');
select set_config('test.p', public.create_post('modtest', 'A normal thread about river bluffs',
  'I bluffed the river with a missed flush draw and got called by second pair. Was it a good bluff?') ->> 'publicId', true);
select set_config('test.dup', public.create_post('modtest', 'Same thing again',
  'I bluffed the river with a missed flush draw and got called by second pair. Was it a good bluff?') ->> 'publicId', true);
select pg_temp.act_as_owner();
select is((select status from public.posts where public_id = current_setting('test.p')), 'visible', 'a normal post is visible');
select is((select status from public.posts where public_id = current_setting('test.dup')), 'spam',
  'posting the same body twice within a week is held as spam');

-- ------------------------------------------------------------ rate limits --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select public.create_post('othertest', 'Post number ' || i, 'body text number ' || i || ' of the rate limit test')
from generate_series(1, 5) i;
select throws_ok($$ select public.create_post('othertest', 'One too many', 'the sixth post in an hour') $$,
  '53400', null, 'a sixth post within the hour hits the per-account limit');

-- ---------------------------------------------------------------- reports --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select is(public.report_content('post', current_setting('test.p'), null, null, 'hh-takedown', 'My hand, please remove')
          ->> 'alreadyReported', 'false', 'a member reports a post (hh-takedown is a reason)');
select is(public.report_content('post', current_setting('test.p'), null, null, 'spam') ->> 'alreadyReported', 'true',
  'reporting it again is a no-op');
select throws_ok($$ select public.report_content('post', 'zzzzzzzz', null, null, 'spam') $$, '22023', null,
  'nothing there to report');
select pg_temp.act_as_anon();
select throws_ok($$ select public.report_content('post', current_setting('test.p'), null, null, 'spam') $$, '42501', null,
  'anon cannot report');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a4');
select throws_ok($$ select public.mod_queue() $$, '42501', null, 'a member cannot see the queue');
select throws_ok($$ select * from public.reports $$, '42501', null, 'reports are sealed');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select is(jsonb_array_length(public.mod_queue()), 1, 'the moderator sees the open report');
select is(public.mod_queue() -> 0 ->> 'reason', 'hh-takedown', '... with its reason');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a3');
select is(jsonb_array_length(public.mod_queue()), 1, 'the board moderator sees reports from their board');

-- ------------------------------------------------------- remove / restore --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select is(public.mod_set_post_status(current_setting('test.spam'), 'visible', 'false positive'), 'visible',
  'a moderator approves the spam-held post');
select is(public.mod_set_post_status(current_setting('test.p'), 'removed', 'takedown request'), 'removed',
  'and removes the reported one');
select is(public.mod_resolve_report((select (mod_queue() -> 0 ->> 'id')::bigint), 'actioned', 'removed within 48h'), true,
  'the report is resolved');
select pg_temp.act_as_anon();
select is((select count(*)::int from public.posts where public_id = current_setting('test.p')), 0,
  'a removed post is gone for anon -- in the database');
select is(public.post_status(current_setting('test.p')), 'removed', 'its page can say it was removed');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a4');
select is((select count(*)::int from public.posts where public_id = current_setting('test.p')), 1,
  'its author still sees it');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select is(public.mod_set_post_status(current_setting('test.p'), 'visible', 'restored'), 'visible', 'and it can be restored');

-- Board moderators are scoped to their board.
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a3');
select is(public.mod_set_post_flags(current_setting('test.p'), true, null) ->> 'isLocked', 'true',
  'a board moderator locks a thread on their board');
select throws_ok($$ select public.mod_set_post_status((select public_id from public.posts p join public.boards b on b.id = p.board_id where b.slug = 'othertest' limit 1), 'removed') $$,
  '22023', 'That post does not exist.', '... but cannot touch another board, and cannot tell it is there');
select throws_ok($$ select public.mod_ban('member_u', 3, 'x') $$, '42501', null, '... and cannot ban');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select throws_ok($$ select public.create_comment(current_setting('test.p'), 'on a locked thread') $$, '22023',
  'This thread is locked.', 'a locked thread refuses comments');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select public.mod_set_post_flags(current_setting('test.p'), false, true);

-- -------------------------------------------------------------- comments --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select public.create_comment(current_setting('test.p'), 'You are a donkey and everyone knows it');
select public.create_comment(current_setting('test.p'), 'A reply under it', 1);
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select is(public.mod_set_comment_status(current_setting('test.p'), 1, 'removed', 'harassment'), 'removed', 'a comment is removed');
select pg_temp.act_as_anon();
select is((select c.body from public.comments c join public.posts p on p.id = c.post_id
           where p.public_id = current_setting('test.p') and c.seq = 1), null,
  'its public row is a tombstone with no words ...');
select is((select count(*)::int from jsonb_array_elements(public.get_post_comments(current_setting('test.p')))), 2,
  '... and the reply under it stays in the thread');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select is(public.mod_set_comment_status(current_setting('test.p'), 1, 'visible', 'appeal'), 'visible', 'restored on appeal');
select pg_temp.act_as_owner();
select is((select c.body from public.comments c join public.posts p on p.id = c.post_id
           where p.public_id = current_setting('test.p') and c.seq = 1), 'You are a donkey and everyone knows it',
  'restoring brings the words back from the audit');

-- ------------------------------------------------------------- revisions --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a4');
select public.edit_post(current_setting('test.p'), 'A normal thread about river bluffs', 'Edited after the fact: villain had the nuts.');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select public.mod_edit_post_title(current_setting('test.p'), 'River bluff with a missed flush draw', 'clearer title');
select pg_temp.act_as_anon();
select is(jsonb_array_length(public.get_revisions(current_setting('test.p'))), 2,
  'both the author''s edit and the moderator''s title change left a public revision');
select ok(public.get_revisions(current_setting('test.p')) -> 1 ->> 'body' like 'I bluffed the river%',
  'the original story is on the record');

-- --------------------------------------------------------- bans and roles --

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select throws_ok($$ select public.mod_ban('member_v', 60, 'too long') $$, '42501', 'Moderators can ban for up to 30 days.',
  'a moderator cannot ban for more than 30 days');
select throws_ok($$ select public.mod_ban('member_v', null, 'forever') $$, '42501', null, '... or permanently');
select throws_ok($$ select public.mod_ban('admin_x', 3, 'coup') $$, '42501', null, '... or ban staff');
select throws_ok($$ select public.mod_ban('member_v', 3, '') $$, '22023', null, 'a ban needs a reason');
select ok((public.mod_ban('member_v', 7, 'repeated harassment') ->> 'bannedUntil') is not null, 'a 7-day ban');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select throws_ok($$ select public.create_comment(current_setting('test.p'), 'still here') $$, '22023', null,
  'a banned account cannot post');
select is((select count(*)::int from public.posts where public_id = current_setting('test.p')), 1,
  '... but can still read');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a2');
select ok((public.mod_ban('member_v', null, 'permanent') ->> 'bannedUntil') = 'infinity', 'an admin can ban permanently');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select throws_ok($$ select public.mod_unban('member_v') $$, '42501', null, 'a moderator cannot lift a permanent ban');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a2');
select is(public.mod_unban('member_v', 'appeal'), true, 'an admin can');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select throws_ok($$ select public.admin_set_role('member_u', 'moderator') $$, '42501', null, 'a moderator cannot grant roles');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a2');
select is(public.admin_set_role('member_u', 'moderator', 'trusted'), 'moderator', 'an admin can');
select is(public.admin_create_board('mttstrategy', 'MTT strategy'), 'mttstrategy', 'an admin creates a board');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a1');
select is(public.mod_user('newbie_n') ->> 'isShadowbanned', 'false', 'a moderator reads an account''s standing');
select is(public.mod_shadowban('newbie_n', true, 'spam'), true, 'and shadowbans it');
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select is((select count(*)::int from public.posts where public_id = current_setting('test.spam')), 0,
  'a shadowbanned account''s post disappears for others');
-- (member_u was made a moderator above; member_v is still a member.)
select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a5');
select throws_ok($$ select public.mod_user('newbie_n') $$, '42501', null, 'standing is moderator-only');

-- ------------------------------------------------------------ audit trail --

select pg_temp.act_as_owner();
select throws_ok($$ update public.moderation_actions set reason = 'rewritten' $$, '42501', 'moderation_actions is append-only',
  'nobody rewrites the audit, not even the owner');
select throws_ok($$ delete from public.moderation_actions $$, '42501', 'moderation_actions is append-only',
  'nobody deletes it');
select lives_ok($$ delete from auth.users where id = '00000000-0000-0000-0000-00000000a0a6' $$,
  'deleting an account still works: the audit keeps the row and loses the name');

select pg_temp.act_as('00000000-0000-0000-0000-00000000a0a2');
select is(public.admin_purge('post', current_setting('test.dup'), null, 'duplicate spam'), true, 'an admin hard-purges a post');
select pg_temp.act_as_owner();
select is((select count(*)::int from public.posts where public_id = current_setting('test.dup')), 0, 'it is gone');
select is((select count(*)::int from public.moderation_actions where action = 'post.purge'), 1, 'the record of it is not');

select * from finish();
rollback;
