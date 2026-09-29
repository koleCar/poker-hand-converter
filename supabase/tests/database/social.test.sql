-- pgTAP: saves, subscriptions, notifications, mentions (F9, #38 / #39) --
-- `20261026090000_forum_social.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(35);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000005a1', 'soc.a@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000005b1', 'soc.b@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000005c1', 'soc.c@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000005d1', 'soc.d@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000005e1', 'soc.e@example.com', now() - interval '40 days', now() - interval '40 days');

update public.profiles set username = 'alice_s' where id = '00000000-0000-0000-0000-0000000005a1';
update public.profiles set username = 'bob_s'   where id = '00000000-0000-0000-0000-0000000005b1';
update public.profiles set username = 'carol_s' where id = '00000000-0000-0000-0000-0000000005c1';
update public.profiles set username = 'dave_s'  where id = '00000000-0000-0000-0000-0000000005d1';
update public.profiles set username = 'eve_s'   where id = '00000000-0000-0000-0000-0000000005e1';

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

create function pg_temp.notes(p_uid uuid) returns text language sql as $$
  select coalesce(string_agg(kind, ',' order by id), '') from public.notifications where user_id = p_uid;
$$;
grant execute on function pg_temp.notes(uuid) to anon, authenticated;

-- A posts; the author is subscribed automatically.
select pg_temp.act_as('00000000-0000-0000-0000-0000000005a1');
select set_config('test.p', public.create_post('nlhe', 'Social test thread', 'hello') ->> 'publicId', true);
select pg_temp.act_as_owner();
select is((select level from public.thread_subscriptions where user_id = '00000000-0000-0000-0000-0000000005a1'),
  'watching', 'writing a post watches the thread');

-- ------------------------------------------------------------ fan-out --

-- B comments at top level: A (post author) is told.
select pg_temp.act_as('00000000-0000-0000-0000-0000000005b1');
select public.create_comment(current_setting('test.p'), 'First!');
select pg_temp.act_as_owner();
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005a1'), 'post_reply', 'a top-level comment notifies the post author once');
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005b1'), '', 'the commenter is not notified of their own comment');
select is((select level from public.thread_subscriptions where user_id = '00000000-0000-0000-0000-0000000005b1'),
  'watching', 'commenting watches the thread');

-- C replies to B and mentions D and E: B gets a reply, D and E mentions, A the thread.
select pg_temp.act_as('00000000-0000-0000-0000-0000000005c1');
select public.create_comment(current_setting('test.p'), 'Agree with @bob_s, what do @Dave_S and @eve_s think? @nobody_here', 1);
select pg_temp.act_as_owner();
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005b1'), 'comment_reply',
  'a reply notifies the parent''s author -- once, although they were also mentioned');
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005d1'), 'mention', 'a mention notifies, case-insensitively');
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005e1'), 'mention', '... every mentioned user');
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005a1'), 'post_reply,thread', 'a watcher hears about the new comment');

-- Mentions are capped at five.
select pg_temp.act_as_owner();
insert into auth.users (id, email, email_confirmed_at, created_at)
select ('00000000-0000-0000-0000-00000000070' || i)::uuid, 'm' || i || '@example.com', now() - interval '40 days', now() - interval '40 days'
from generate_series(1, 7) i;
update public.profiles set username = 'mention_' || right(id::text, 1)
 where id::text like '00000000-0000-0000-0000-00000000070%';
select pg_temp.act_as('00000000-0000-0000-0000-0000000005c1');
select public.create_comment(current_setting('test.p'),
  '@mention_1 @mention_2 @mention_3 @mention_4 @mention_5 @mention_6 @mention_7');
select pg_temp.act_as_owner();
select is((select count(*)::int from public.notifications n join public.comments c on c.id = n.comment_id
           where n.kind = 'mention' and c.seq = 3), 5, 'at most five mentions notify per comment');

-- A mutes the thread: silence, even for a direct reply.
select pg_temp.act_as('00000000-0000-0000-0000-0000000005a1');
select is(public.set_thread_subscription(current_setting('test.p'), 'muted'), 'muted', 'A mutes the thread');
select pg_temp.act_as('00000000-0000-0000-0000-0000000005b1');
select public.create_comment(current_setting('test.p'), 'Top level again');
select pg_temp.act_as_owner();
-- (A's three: B's first comment, C's reply, C's top-level mention comment.)
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005a1'), 'post_reply,thread,post_reply',
  'nothing new for A after muting');
select is((select level from public.thread_subscriptions
           where user_id = '00000000-0000-0000-0000-0000000005a1'), 'muted',
  'commenting elsewhere does not unmute anyone');

-- A shadowbanned commenter reaches nobody.
update public.profiles set is_shadowbanned = true where id = '00000000-0000-0000-0000-0000000005e1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000005e1');
select public.create_comment(current_setting('test.p'), 'Buy chips @bob_s', 1);
select pg_temp.act_as_owner();
select is(pg_temp.notes('00000000-0000-0000-0000-0000000005b1'), 'comment_reply,thread',
  'a shadowbanned comment notifies nobody, not even the person it replies to');

-- ---------------------------------------------------------- reading them --

select pg_temp.act_as('00000000-0000-0000-0000-0000000005d1');
select is((select count(*)::int from public.notifications), 1, 'D reads only their own notifications');
select is(public.unread_notification_count(), 1, 'one unread');
select is(public.my_notifications() -> 'items' -> 0 -> 'actor' ->> 'username', 'carol_s', 'the list names the actor');
select is(public.my_notifications() -> 'items' -> 0 -> 'post' ->> 'board', 'nlhe', 'and where to go');
select is(public.mark_notifications_read(), 1, 'mark all read');
select is(public.unread_notification_count(), 0, 'none unread');
select throws_ok($$ update public.notifications set read_at = null $$, '42501', null, 'no UPDATE on notifications');
select throws_ok($$ insert into public.notifications (user_id, kind, post_id) select '00000000-0000-0000-0000-0000000005a1', 'thread', id from public.posts limit 1 $$,
  '42501', null, 'nobody can forge a notification');

-- ------------------------------------------------------------------ saves --

select is(public.save_post(current_setting('test.p')), true, 'D saves the post');
select is(public.my_post_state(current_setting('test.p')) ->> 'saved', 'true', 'and it says so');
select is(jsonb_array_length(public.my_saved_posts()), 1, 'my saved posts lists it');
select pg_temp.act_as('00000000-0000-0000-0000-0000000005b1');
select is(jsonb_array_length(public.my_saved_posts()), 0, 'B cannot see D''s saves');
select is((select count(*)::int from public.saved_posts), 0, '... not even by selecting the table');
select pg_temp.act_as('00000000-0000-0000-0000-0000000005d1');
select is(public.save_post(current_setting('test.p'), false), false, 'D unsaves');
select is(jsonb_array_length(public.my_saved_posts()), 0, 'and it is gone');

select pg_temp.act_as_anon();
select throws_ok($$ select public.save_post(current_setting('test.p')) $$, '42501', null, 'anon cannot save');
select throws_ok($$ select * from public.notifications $$, '42501', null, 'anon cannot read notifications');

-- ------------------------------------------------------------ reconcile --

select pg_temp.act_as_owner();
update public.posts set upvotes = 999, score = 999, comment_count = 0 where public_id = current_setting('test.p');
select is((public.recount_forum_counters() ->> 'postsFixed')::int >= 1, true, 'the nightly recount finds the drift');
select is((select upvotes || '/' || comment_count from public.posts where public_id = current_setting('test.p')),
  '1/5', '... and restores the truth (one vote; five live comments)');
select is((public.recount_forum_counters() ->> 'postsFixed')::int, 0, 'a second run finds nothing: idempotent');
select pg_temp.act_as('00000000-0000-0000-0000-0000000005b1');
select throws_ok($$ select public.recount_forum_counters() $$, '42501', null, 'the recount is service-role only');

select pg_temp.act_as_owner();
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications'),
  'notifications are in the realtime publication');

select * from finish();
rollback;
