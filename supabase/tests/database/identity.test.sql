-- pgTAP: identity (F6, #28 / #29) -- `20261007090000_forum_identity.sql`.
--
-- Run with `supabase test db` against a local stack (`supabase db start` is
-- enough -- nothing here needs GoTrue). Everything happens inside one
-- transaction that is rolled back, so it leaves nothing behind.
--
-- Acting as a user is `set local role authenticated` plus a `request.jwt.claims`
-- carrying the `sub`, which is exactly what `auth.uid()` reads. `anon` is the
-- same without the claims. Neither is a superuser, so these assertions test the
-- grants and the definer functions for real -- unlike a PAT, which would pass
-- every one of them.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(68);

-- ------------------------------------------------------------------ setup --

-- A: an old, confirmed account.   B: another one.   C: brand new, confirmed.
-- D: unconfirmed.                 E: will be deleted.
insert into auth.users (id, email, email_confirmed_at, created_at)
values
  ('00000000-0000-0000-0000-00000000000a', 'player.aaa@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000000b', 'player.bbb@example.com', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000000c', 'player.ccc@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000000d', 'player.ddd@example.com', null, now() - interval '40 days'),
  ('00000000-0000-0000-0000-00000000000e', 'player.eee@example.com', now() - interval '40 days', now() - interval '40 days');

-- F: an anonymous sign-in, which the live project still allows.
insert into auth.users (id, is_anonymous, created_at)
values ('00000000-0000-0000-0000-00000000000f', true, now() - interval '40 days');

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
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

-- ----------------------------------------------------------- signup trigger --

select is(
  (select count(*)::int from public.profiles
    where id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b',
                 '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d',
                 '00000000-0000-0000-0000-00000000000e')),
  5, 'handle_new_user gives every new account a profile');

select is(
  (select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-00000000000f'),
  0, 'an anonymous sign-in gets no profile, so a loop cannot fill profiles_public');

select ok(
  (select bool_and(username ~ '^user_[0-9a-z]{8}$') from public.profiles
    where id::text like '00000000-0000-0000-0000-00000000000%'),
  'provisional names are user_ + 8 base-36 characters');

select ok(
  (select bool_and(position(replace(split_part(u.email, '@', 1), '.', '') in p.username) = 0)
     from public.profiles p join auth.users u on u.id = p.id
    where p.id::text like '00000000-0000-0000-0000-00000000000%'),
  'a provisional name is never derived from the email');

select is(
  (select created_at from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
  (select created_at from auth.users      where id = '00000000-0000-0000-0000-00000000000a'),
  'profiles.created_at is the account''s real signup time');

select ok(
  (select username_changed_at is null from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
  'a provisional name has not started the 30-day clock');

-- ------------------------------------------------------------ shape rules --

select is(public.username_shape_problem('ab'),        'Usernames are at least 3 characters.', 'too short');
select is(public.username_shape_problem(repeat('a', 25)), 'Usernames are at most 24 characters.', 'too long');
select is(public.username_shape_problem('a-b-c'),     'Usernames can use only letters, numbers and underscores.', 'hyphen refused');
select is(public.username_shape_problem('pаul'),      'Usernames can use only letters, numbers and underscores.', 'Cyrillic homoglyph refused');
select is(public.username_shape_problem('_paul'),     'Usernames start with a letter or a number.', 'leading underscore refused');
select is(public.username_shape_problem('User_abc12'), 'Names starting with "user_" are reserved for new accounts.', 'provisional prefix refused, any case');
select is(public.username_shape_problem('xxNigg3rxx'), 'That username is not allowed.', 'blocked term found through leetspeak folding');
select is(public.username_shape_problem('ra_c_coon'), null, '"exact" terms do not match inside innocent words (Scunthorpe)');
select is(public.username_shape_problem('Bigstack_99'), null, 'a normal name passes');

-- ------------------------------------------------------------ set_username --

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');

select is(public.set_username('Bigstack') ->> 'username', 'Bigstack', 'A takes Bigstack');

select pg_temp.act_as_owner();
select is(
  (select username from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
  'Bigstack', 'the row changed');
select is(
  (select count(*)::int from public.username_reservations
    where reserved_for = '00000000-0000-0000-0000-00000000000a' and reason = 'previous-name'
      and expires_at between now() + interval '364 days' and now() + interval '366 days'),
  1, 'the provisional name is reserved for A for a year');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(
  $$ select public.set_username('Someone_else') $$,
  '22023', null, 'a second change inside 30 days is refused');
select ok(
  (select public.set_username('BIGSTACK') ->> 'username') = 'BIGSTACK',
  'a capitalisation-only change is allowed inside the 30 days');

-- Move A's clock past the limit.
select pg_temp.act_as_owner();
update public.profiles set username_changed_at = now() - interval '31 days'
 where id = '00000000-0000-0000-0000-00000000000a';

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is(public.set_username('bigstack_pro') ->> 'username', 'bigstack_pro', 'after 30 days A renames');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok($$ select public.set_username('bigstack') $$, '22023', 'That username is not available.',
  'B cannot take A''s previous name');
select throws_ok($$ select public.set_username('BigStack') $$, '22023', 'That username is not available.',
  '... in any capitalisation');
select throws_ok($$ select public.set_username('Bigstack_Pro') $$, '22023', 'That username is taken.',
  'B cannot take A''s current name in another case');
select throws_ok($$ select public.set_username('admin') $$, '22023', 'That username is not available.',
  'staff names are reserved');
select throws_ok($$ select public.set_username('settings') $$, '22023', 'That username is not available.',
  'route segments are reserved');
select throws_ok($$ select public.set_username('a b') $$, '22023', null, 'shape is enforced server-side');
select is(public.set_username('river_rat') ->> 'username', 'river_rat', 'B takes a free name');

-- A takes the old name back, a year's reservation being theirs to consume.
select pg_temp.act_as_owner();
update public.profiles set username_changed_at = now() - interval '31 days'
 where id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is(public.set_username('Bigstack') ->> 'username', 'Bigstack', 'A reclaims their own previous name');
select pg_temp.act_as_owner();
select is(
  (select reserved_for from public.username_reservations where username_lower = 'bigstack'),
  null::uuid, 'reclaiming consumes the reservation');
select is(
  (select reserved_for from public.username_reservations where username_lower = 'bigstack_pro'),
  '00000000-0000-0000-0000-00000000000a'::uuid, '... and reserves the name A just left');

-- ---------------------------------------------------------- resolve_username --

select pg_temp.act_as_anon();
select is(public.resolve_username('bigstack_pro'), '{"username": "Bigstack", "redirect": true}'::jsonb,
  'an old name resolves to the current one, for anon');
select is(public.resolve_username('Bigstack'), '{"username": "Bigstack", "redirect": false}'::jsonb,
  'the current name resolves to itself');
select is(public.resolve_username('BIGSTACK'), '{"username": "Bigstack", "redirect": true}'::jsonb,
  'another capitalisation redirects to the canonical one');
select is(public.resolve_username('admin'), null, 'a staff reservation is indistinguishable from nothing');
select is(public.resolve_username('nobody_here'), null, 'an unknown name is null');
select is(public.resolve_username('../etc'), null, 'a malformed name is null');

-- ----------------------------------------------------------- the grant wall --

select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon cannot read profiles');
select throws_ok($$ select public.set_username('anything') $$, '42501', null, 'anon cannot call set_username');
select throws_ok($$ select public.posting_block_reason('00000000-0000-0000-0000-00000000000a') $$, '42501', null,
  'anon cannot call posting_block_reason');
select throws_ok($$ select public.vote_weight('00000000-0000-0000-0000-00000000000a') $$, '42501', null,
  'anon cannot call vote_weight');
select is(
  (select username from public.profiles_public where username_lower = 'bigstack'),
  'Bigstack', 'anon reads the public view');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok($$ select * from public.profiles $$, '42501', null,
  'an account cannot read profiles, not even its own row');
select throws_ok($$ update public.profiles set karma = 1000 $$, '42501', null,
  'an account cannot update profiles');
select throws_ok($$ select * from public.username_reservations $$, '42501', null,
  'reservations are sealed');
select throws_ok($$ select * from public.board_moderators $$, '42501', null,
  'board_moderators is sealed');
select throws_ok($$ select public.posting_block_reason('00000000-0000-0000-0000-00000000000a') $$, '42501', null,
  'an account cannot ask about somebody else''s gate');

select pg_temp.act_as_owner();
select is(
  (select array_agg(attname::text order by attnum) from pg_attribute
    where attrelid = 'public.profiles_public'::regclass and attnum > 0 and not attisdropped),
  array['id', 'username', 'username_lower', 'karma', 'joined_on'],
  'profiles_public exposes exactly these columns -- changing this list is a privacy decision');

-- ---------------------------------------------------------------- my_profile --

select pg_temp.act_as_owner();
update public.profiles set is_shadowbanned = true where id = '00000000-0000-0000-0000-00000000000b';

select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select is(public.my_profile() ->> 'username', 'river_rat', 'my_profile returns the caller''s row');
select ok(not (public.my_profile() ? 'isShadowbanned') and not (public.my_profile() ? 'is_shadowbanned'),
  'my_profile never tells an account it is shadowbanned');
select ok(not (public.my_profile() ? 'unsubscribeToken'), 'my_profile omits the unsubscribe token');
select is(public.my_profile() ->> 'postingBlockReason', null,
  'a shadowbanned account is not told it cannot post');

-- --------------------------------------------------------- posting gates --

select pg_temp.act_as_owner();
select is(public.posting_block_reason('00000000-0000-0000-0000-00000000000a'), null,
  'an old, confirmed account may post');
select matches(public.posting_block_reason('00000000-0000-0000-0000-00000000000c'),
  '^New accounts can post ten minutes after signing up\. Try again in 10 minutes\.$',
  'a brand-new account waits ten minutes');
select matches(public.posting_block_reason('00000000-0000-0000-0000-00000000000d'),
  '^Confirm your email address',
  'an unconfirmed account must confirm first');

update public.profiles set banned_until = now() + interval '3 days', ban_reason = 'spam'
 where id = '00000000-0000-0000-0000-00000000000a';
select matches(public.posting_block_reason('00000000-0000-0000-0000-00000000000a'),
  '^This account is suspended until .* UTC and cannot post until then\.$',
  'a suspended account is told until when');
update public.profiles set banned_until = 'infinity' where id = '00000000-0000-0000-0000-00000000000a';
select is(public.posting_block_reason('00000000-0000-0000-0000-00000000000a'),
  'This account has been suspended and cannot post.', 'a permanent ban says so');

-- ------------------------------------------------------------ vote_weight --

select is(public.vote_weight('00000000-0000-0000-0000-00000000000c'), 0::smallint, 'under 24h weighs nothing');
select is(public.vote_weight('00000000-0000-0000-0000-00000000000a'), 0::smallint, 'banned weighs nothing');
select is(public.vote_weight('00000000-0000-0000-0000-00000000000b'), 0::smallint, 'shadowbanned weighs nothing');
select is(public.vote_weight('00000000-0000-0000-0000-00000000000e'), 1::smallint,
  'an aged account with zero karma counts -- see the deadlock note on vote_weight');
update public.profiles set karma = -3 where id = '00000000-0000-0000-0000-00000000000e';
select is(public.vote_weight('00000000-0000-0000-0000-00000000000e'), 0::smallint, 'negative karma weighs nothing');

-- ------------------------------------------------------------------ roles --

update public.profiles set banned_until = null, role = 'moderator'
 where id = '00000000-0000-0000-0000-00000000000a';

select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select is(public.is_moderator(), false, 'a member is not a moderator');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is(public.is_moderator(), true, 'a moderator is');

select pg_temp.act_as_owner();
-- A real board: board_moderators.board_id has had its foreign key since the
-- forum core migration.
insert into public.boards (id, slug, name) values ('11111111-1111-1111-1111-111111111111', 'test-board', 'Test board');
insert into public.board_moderators (board_id, user_id)
values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000e');
update public.profiles set karma = 0 where id = '00000000-0000-0000-0000-00000000000e';

select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select is(public.is_board_moderator('11111111-1111-1111-1111-111111111111'), true,
  'a board moderator moderates their board');
select is(public.is_board_moderator('22222222-2222-2222-2222-222222222222'), false,
  '... and only their board');

-- ------------------------------------------------------- deleted accounts --

select pg_temp.act_as_owner();
update public.profiles set username_changed_at = now() - interval '31 days'
 where id = '00000000-0000-0000-0000-00000000000e';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000e');
select public.set_username('Leaving_soon');

select pg_temp.act_as_owner();
delete from auth.users where id = '00000000-0000-0000-0000-00000000000e';
select is(
  (select reason || ':' || coalesce(reserved_for::text, 'nobody')
     from public.username_reservations where username_lower = 'leaving_soon'),
  'deleted-account:nobody', 'a deleted account''s name is reserved for nobody');

update public.profiles set username_changed_at = now() - interval '31 days'
 where id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok($$ select public.set_username('leaving_soon') $$, '22023', 'That username is not available.',
  'nobody can take a deleted account''s name');

select * from finish();
rollback;
