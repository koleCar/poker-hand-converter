-- pgTAP: Rail R4.3, live progress across tabs -- `20270616090000_live_activity.sql`.
--
-- Realtime authorises a private channel by running, as the socket's role
-- with `request.jwt.claims` and `realtime.topic` set, a SELECT (receive)
-- and an INSERT (send) on `realtime.messages`, then rolling back. This file
-- runs the same statements the same way. What has to hold:
--
--   * on `activity:<uid>`, the owner may receive presence and broadcast and
--     may send presence - and nothing else: no broadcast sent, by anyone;
--   * another account may neither receive nor send on it, nor may `anon`;
--   * no other topic is opened by these policies, and a missing topic opens
--     nothing;
--   * these are the only policies on `realtime.messages`, for
--     `authenticated` only.
--
-- That Realtime really applies them (a join refused, a public channel of
-- the same name kept apart) is checked end to end by `npm run
-- realtime:activity` against a local stack.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(27);

-- `realtime.messages` is partitioned by day and Realtime creates the
-- partitions; a fresh database normally has today's. If not, a default
-- partition for this transaction only.
do $$
begin
  insert into realtime.messages (topic, extension, payload, event) values ('pgtap:probe', 'broadcast', '{}', 'probe');
exception when others then
  create table realtime.messages_pgtap partition of realtime.messages default;
end;
$$;

-- Whoever acts, on which topic: what Realtime sets before its check.
create function pg_temp.act_as(p_uid uuid, p_topic text) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', coalesce(p_topic, ''), true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.act_as_anon(p_topic text) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('realtime.topic', coalesce(p_topic, ''), true);
  execute 'set local role anon';
end;
$$;

-- The rows Realtime's read check looks for: one per topic and extension,
-- written as the server (here: the test's superuser).
insert into realtime.messages (topic, extension, payload, event, private) values
  ('activity:00000000-0000-0000-0000-00000043aa01', 'presence', '{}', 'probe', true),
  ('activity:00000000-0000-0000-0000-00000043aa01', 'broadcast', '{}', 'probe', true),
  ('activity:00000000-0000-0000-0000-00000043bb01', 'presence', '{}', 'probe', true),
  ('activity:00000000-0000-0000-0000-00000043bb01', 'broadcast', '{}', 'probe', true),
  ('room:lobby', 'presence', '{}', 'probe', true),
  ('room:lobby', 'broadcast', '{}', 'probe', true);

create function pg_temp.visible(p_topic text) returns bigint language sql as $$
  select count(*) from realtime.messages where topic = p_topic and event = 'probe';
$$;
grant execute on function pg_temp.visible(text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- The policies
-- ---------------------------------------------------------------------------

select policies_are(
  'realtime', 'messages',
  array['live_activity_own_receive', 'live_activity_own_send'],
  'realtime.messages has exactly the two activity policies'
);
select policy_roles_are('realtime', 'messages', 'live_activity_own_receive', array['authenticated'], 'receive: authenticated only');
select policy_roles_are('realtime', 'messages', 'live_activity_own_send', array['authenticated'], 'send: authenticated only');
select policy_cmd_is('realtime', 'messages', 'live_activity_own_receive', 'select', 'receive is a SELECT policy');
select policy_cmd_is('realtime', 'messages', 'live_activity_own_send', 'insert', 'send is an INSERT policy');
select is(
  (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass),
  true,
  'RLS is on for realtime.messages'
);

-- ---------------------------------------------------------------------------
-- The owner, on its own topic
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000043aa01', 'activity:00000000-0000-0000-0000-00000043aa01');

select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043aa01'),
  2::bigint,
  'the owner may receive on its own topic (presence and broadcast: the join needs both)'
);
select lives_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043aa01', 'presence', '{"id":"u1"}', 'track', true)$$,
  'the owner may send presence on its own topic'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043aa01', 'broadcast', '{}', 'probe', true)$$,
  '42501', null,
  'the owner may not broadcast, even on its own topic'
);
select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043bb01'),
  0::bigint,
  'while on its own topic, another topic''s rows are not visible either'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043bb01', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'nor may a row of another topic be written under its own'
);

-- ---------------------------------------------------------------------------
-- The owner, on someone else's topic
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000043aa01', 'activity:00000000-0000-0000-0000-00000043bb01');

select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043bb01'),
  0::bigint,
  'A may not receive on B''s topic'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043bb01', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'A may not send presence on B''s topic'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043bb01', 'broadcast', '{}', 'probe', true)$$,
  '42501', null,
  'A may not broadcast on B''s topic'
);

-- B, on A's topic.
select pg_temp.act_as('00000000-0000-0000-0000-00000043bb01', 'activity:00000000-0000-0000-0000-00000043aa01');

select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043aa01'),
  0::bigint,
  'B may not receive on A''s topic'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043aa01', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'B may not send presence on A''s topic'
);

-- B, on its own: the rule is per account, not for one account.
select pg_temp.act_as('00000000-0000-0000-0000-00000043bb01', 'activity:00000000-0000-0000-0000-00000043bb01');
select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043bb01'),
  2::bigint,
  'B may receive on its own topic'
);
select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043aa01'),
  0::bigint,
  'and still sees nothing of A''s'
);

-- ---------------------------------------------------------------------------
-- Other topics, no topic, a prefix that is not the uid
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000043aa01', 'room:lobby');
select is(pg_temp.visible('room:lobby'), 0::bigint, 'another topic is not opened by these policies');
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('room:lobby', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'nor may anything be sent on it'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000043aa01', null);
select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043aa01'),
  0::bigint,
  'with no topic set, nothing is visible'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043aa01', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'and nothing may be sent'
);

select pg_temp.act_as('00000000-0000-0000-0000-00000043aa01', 'activity:00000000-0000-0000-0000-00000043aa01x');
select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043aa01x'),
  0::bigint,
  'a topic that only starts with the uid is not the owner''s'
);

-- ---------------------------------------------------------------------------
-- anon
-- ---------------------------------------------------------------------------

select pg_temp.act_as_anon('activity:00000000-0000-0000-0000-00000043aa01');
select is(
  pg_temp.visible('activity:00000000-0000-0000-0000-00000043aa01'),
  0::bigint,
  'anon may not receive on an account''s topic'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:00000000-0000-0000-0000-00000043aa01', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'anon may not send presence on it'
);
select pg_temp.act_as_anon('activity:');
select is(pg_temp.visible('activity:'), 0::bigint, 'anon''s own (null) uid opens no topic');
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('activity:', 'presence', '{}', 'track', true)$$,
  '42501', null,
  'nor lets it send'
);

reset role;

select * from finish();
rollback;
