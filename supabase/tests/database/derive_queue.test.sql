-- pgTAP: the queue and one pass (`20271127090000_derive_queue.sql`, docs/POOL.md P1).
--
-- What has to hold:
--
--   * security: the four tables have RLS on, owner-select only, no client
--     write grant, and are in account_data_inventory; the worker functions
--     are definers with an empty search_path, executable by authenticated
--     and rail_derive, never anon; the helpers by nobody; rail_derive holds
--     no table privilege and no other definer function in public;
--   * the trigger: every hand stored with a hero is queued once (`new`), a
--     hand without one is not; the counter follows inserts and deletes and
--     `derive_pending` reads it per account;
--   * claim: a user claims only their own rows, a claimed row is not
--     claimed again (until it lapses), the derive role claims every
--     owner's, an analysed hand comes with its decisions; anyone else is
--     refused (anon, a subjectless JWT without the worker claim);
--   * save: the products land as the hand's owner (statistics, EV, facts,
--     checker rows, pool) and the hand leaves the queue; saving again adds
--     nothing; a user cannot save another's hand; the worker writes as the
--     owner and leaves the request's identity as it found it; a refused
--     hand is retried, then given up;
--   * fail: final or third time given up (derive_failures), otherwise back
--     on the queue;
--   * a deleted hand leaves the queue and the counter subtracts it; a hand
--     whose pool was counted empties the pool and marks the account, whose
--     next claim queues the rest again (derive_recounts);
--   * a new analysis queues the hand, the browser's checker rows take it
--     out; turning opponents' statistics on queues the library;
--   * `analytics_pool`'s pending is the counter; the backlog function is
--     nobody's but postgres'.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(58);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000d00a1', 'derive.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000d00b1', 'derive.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to anon, authenticated, rail_derive;

-- The worker: role rail_derive, a JWT naming it (no subject).
grant rail_derive to postgres with inherit false, set true;
-- (pgTAP's own functions, for the assertions made while acting as the role.)
grant usage on schema extensions to rail_derive;
create function pg_temp.as_worker() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"rail_derive"}', true);
  execute 'set local role rail_derive';
end;
$$;
grant execute on function pg_temp.as_worker() to anon, authenticated, rail_derive;

create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function pg_temp.as_postgres() to anon, authenticated, rail_derive;

-- Hand n: 1..4 are A's (4 has no hero), 5..6 are B's.
create function pg_temp.hid(p_n bigint) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000d0' || lpad(p_n::text, 3, '0'))::uuid;
$$;
grant execute on function pg_temp.hid(bigint) to anon, authenticated, rail_derive;

create function pg_temp.owner_of(p_n bigint) returns uuid language sql immutable as $$
  select case when p_n <= 4 then '00000000-0000-0000-0000-0000000d00a1' else '00000000-0000-0000-0000-0000000d00b1' end::uuid;
$$;
grant execute on function pg_temp.owner_of(bigint) to anon, authenticated, rail_derive;

-- ----------------------------------------------------------- security --

select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.derive_queue'::regclass, 'public.derive_pending_counts'::regclass,
                    'public.derive_failures'::regclass, 'public.derive_options'::regclass,
                    'public.derive_recounts'::regclass))
  and (select count(*) = 0 from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name in ('derive_queue', 'derive_pending_counts', 'derive_failures', 'derive_options', 'derive_recounts')
          and grantee in ('anon', 'authenticated', 'rail_derive') and privilege_type <> 'SELECT')
  and (select count(*) = 0 from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name in ('derive_queue', 'derive_pending_counts', 'derive_failures', 'derive_options', 'derive_recounts')
          and grantee = 'anon')
  and (select count(*) = 5 from public.account_data_inventory
        where name in ('public.derive_queue', 'public.derive_pending_counts', 'public.derive_failures',
                       'public.derive_options', 'public.derive_recounts')),
  'the tables: RLS on, select only for authenticated, nothing for anon, all five in the inventory');

select ok(
  (select bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
     from pg_proc p
    where p.oid in ('public.derive_claim(integer, jsonb)'::regprocedure, 'public.derive_save(jsonb)'::regprocedure,
                    'public.derive_fail(jsonb)'::regprocedure, 'public.derive_write(uuid, jsonb)'::regprocedure,
                    'public.derive_villains_set(boolean)'::regprocedure,
                    'public.derive_enqueue_backlog(text, uuid, integer, uuid, smallint)'::regprocedure,
                    'public.analytics_pool_add(uuid, text, jsonb)'::regprocedure)),
  'the writers are definers with an empty search_path');

select ok(
  has_function_privilege('authenticated', 'public.derive_claim(integer, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.derive_save(jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.derive_fail(jsonb)', 'execute')
  and has_function_privilege('rail_derive', 'public.derive_claim(integer, jsonb)', 'execute')
  and has_function_privilege('rail_derive', 'public.derive_save(jsonb)', 'execute')
  and has_function_privilege('rail_derive', 'public.derive_fail(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.derive_claim(integer, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.derive_save(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.derive_fail(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.derive_pending()', 'execute')
  and has_function_privilege('authenticated', 'public.derive_pending()', 'execute'),
  'the worker''s three: authenticated and rail_derive, not anon');

select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
     from unnest(array['anon', 'authenticated', 'rail_derive']) r,
          unnest(array['public.derive_write(uuid, jsonb)', 'public.derive_act_as(uuid, text, text)',
                       'public.derive_caller()', 'public.analytics_pool_add(uuid, text, jsonb)',
                       'public.derive_enqueue_backlog(text, uuid, integer, uuid, smallint)',
                       'public.hands_derive_enqueue()', 'public.derive_queue_count_insert()',
                       'public.derive_queue_count_delete()', 'public.derive_recount_step(uuid, integer)']) f),
  'the helpers and triggers: nobody''s');

select is(
  (select array_agg(c.relname::text order by c.relname::text) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p')
      and (has_table_privilege('rail_derive', c.oid, 'select') or has_table_privilege('rail_derive', c.oid, 'insert')
           or has_table_privilege('rail_derive', c.oid, 'update') or has_table_privilege('rail_derive', c.oid, 'delete'))),
  null, 'rail_derive holds no privilege on any table in public');

select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('rail_derive', p.oid, 'execute')),
  array['derive_claim(integer,jsonb)', 'derive_fail(jsonb)', 'derive_save(jsonb)'],
  'the only definer functions rail_derive may execute are the worker''s three');

-- ------------------------------------------------------------ the queue --

-- Whatever a local stack had queued is not this test's (rolled back at the end).
delete from public.derive_queue;
delete from public.derive_recounts;

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at)
select pg_temp.hid(n), pg_temp.owner_of(n), 'pokerstars:derive' || n,
       jsonb_build_object('schema', 'phf/1', 'players', '[]'::jsonb, 'actions', '[]'::jsonb),
       'std', 'pokerstars', case when n = 4 then null else 1 end, 'BTN', 'cash', 'USD', 100, 50, 100, 0,
       array['As', 'Kd'], '2026-11-01T12:00:00Z'::timestamptz + n * interval '1 hour'
from generate_series(1, 6) n;

select is(
  (select array_agg(q.hand_id order by q.hand_id) from public.derive_queue q where q.reason = 'new' and q.priority = 0),
  array[pg_temp.hid(1), pg_temp.hid(2), pg_temp.hid(3), pg_temp.hid(5), pg_temp.hid(6)],
  'every stored hand with a hero is queued once; the one without a hero is not');
select is(
  (select array_agg(c.owner_id::text || ':' || c.pending order by c.owner_id) from public.derive_pending_counts c
    where c.owner_id in ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d00b1')),
  array['00000000-0000-0000-0000-0000000d00a1:3', '00000000-0000-0000-0000-0000000d00b1:2'],
  'the counter holds each account''s rows');

select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is(public.derive_pending(), 3::bigint, 'A reads three hands still being processed');
select is((select count(*)::int from public.derive_queue), 3, 'A sees only A''s queue rows (RLS)');
select throws_ok($$ insert into public.derive_queue (hand_id, owner_id, reason) values (pg_temp.hid(4), auth.uid(), 'new') $$,
  '42501', null, 'A cannot write the queue');
select throws_ok($$ update public.derive_pending_counts set pending = 0 $$, '42501', null, 'nor the counter');

-- ---------------------------------------------------------------- claim --

select is(
  (select array_agg(c.hand_id order by c.hand_id) from public.derive_claim(2, '{}') c),
  array[pg_temp.hid(1), pg_temp.hid(2)], 'A claims A''s oldest two');
select is(
  (select array_agg(c.hand_id order by c.hand_id) from public.derive_claim(10, '{}') c),
  array[pg_temp.hid(3)], 'a claimed row is not claimed again');
select is((select count(*)::int from public.derive_claim(10, '{}')), 0, '... and then nothing is left for A');
select pg_temp.as_postgres();
select ok(
  (select bool_and(q.claimed_at is not null and q.tries = 1) from public.derive_queue q
    where q.owner_id = '00000000-0000-0000-0000-0000000d00a1'),
  'a claim stamps the rows and counts the try');

-- A lapsed claim goes back to the queue.
update public.derive_queue set claimed_at = now() - interval '6 minutes' where hand_id = pg_temp.hid(3);
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is((select array_agg(c.hand_id) from public.derive_claim(10, '{}') c), array[pg_temp.hid(3)],
  'a claim nobody answered for in five minutes is claimed again');

select pg_temp.act_as('00000000-0000-0000-0000-0000000d00b1');
select is((select array_agg(c.hand_id order by c.hand_id) from public.derive_claim(10, '{}') c),
  array[pg_temp.hid(5), pg_temp.hid(6)], 'B claims B''s own');

select pg_temp.as_postgres();
set local role anon;
select throws_ok($$ select * from public.derive_claim(10, '{}') $$, '42501', null, 'anon cannot claim');
select pg_temp.as_postgres();
set local request.jwt.claims = '{"role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select * from public.derive_claim(10, '{}') $$, '42501', null,
  'a subjectless JWT without the worker claim is refused');
select pg_temp.as_postgres();

-- The worker: every owner's lapsed or free rows.
update public.derive_queue set claimed_at = null;
select pg_temp.as_worker();
select is((select count(*)::int from public.derive_claim(100, '{}')), 5, 'the derive role claims every owner''s rows');
select throws_ok($$ select count(*) from public.hands $$, '42501', null, '... and reads no table itself');
select pg_temp.as_postgres();
update public.derive_queue set claimed_at = null;
set local request.jwt.claims = '{"role":"authenticated","rail_worker":"derive"}';
set local role authenticated;
select is((select count(*)::int from public.derive_claim(100, '{}')), 5,
  'the fallback worker JWT (authenticated, no subject, rail_worker = derive) claims them too');
select pg_temp.as_postgres();
update public.derive_queue set claimed_at = null, tries = 0;

-- An analysed hand comes with its decisions; a new analysis queued it (reason analysis).
delete from public.derive_queue where hand_id = pg_temp.hid(2);
insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason, decisions, analysed, flag_count, pot_type)
values (pg_temp.hid(2), '00000000-0000-0000-0000-0000000d00a1', 'analysis/47', 'not-analysed', 'no-decisions', 0, 0, 0, 'walk');
select is((select q.reason || '/' || q.priority from public.derive_queue q where q.hand_id = pg_temp.hid(2)), 'analysis/1',
  'a new analysis queues the hand for its checker rows');
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is(
  (select c.analysis_version || ' ' || c.decisions::text from public.derive_claim(10, '{"analysis":"analysis/47","membership":"analytics/1"}') c
    where c.hand_id = pg_temp.hid(2)),
  'analysis/47 []', 'the claim returns the analysed hand''s version and decisions');
select pg_temp.as_postgres();
update public.derive_queue set claimed_at = null, tries = 0;

-- ----------------------------------------------------------------- save --

-- A whole statistics row, the way the pass sends one.
create temporary table tpl (like public.hand_stats including defaults);
insert into tpl (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, player)
values (pg_temp.hid(1), '00000000-0000-0000-0000-0000000d00a1', 'stats/2', 1, 'x', 'pokerstars', true, 1, 'Hero');
grant select on tpl to authenticated, rail_derive;

create function pg_temp.product(p_n bigint) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'hand_id', pg_temp.hid(p_n),
    'stats', jsonb_build_array((select to_jsonb(t) - 'hand_id' - 'owner_id' - 'created_at' from tpl t)
                                 || jsonb_build_object('hand_key', 'pokerstars:derive' || p_n)),
    'ev', jsonb_build_array(jsonb_build_object('hand_key', 'pokerstars:derive' || p_n, 'seat', 1, 'ev_version', 'ev/1',
                                               'applicable', false, 'ev_net', 0, 'ev_net_bb_milli', 0)),
    'facts', jsonb_build_object('hand_key', 'pokerstars:derive' || p_n, 'facts_version', 'facts/2', 'players_flop', 2),
    'checker', null,
    'pool', jsonb_build_object('version', 'analytics/1', 'players', jsonb_build_array(
      jsonb_build_object('player', 'Villain' || p_n, 'net_bb', 1.5, 'stats', jsonb_build_object('vpip', jsonb_build_array(1, 1))))));
$$;
grant execute on function pg_temp.product(bigint) to authenticated, rail_derive;

select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is(public.derive_save(jsonb_build_array(pg_temp.product(1), pg_temp.product(5))),
  '{"saved": 1, "failed": 0}'::jsonb, 'A saves A''s hand; B''s in the same call is not A''s to save');
select pg_temp.as_postgres();
select ok(
  (select count(*) = 1 from public.hand_stats s where s.hand_id = pg_temp.hid(1) and s.owner_id = '00000000-0000-0000-0000-0000000d00a1')
  and (select count(*) = 1 from public.hand_stats_ev e where e.hand_id = pg_temp.hid(1))
  and (select count(*) = 1 from public.hand_facts f where f.hand_id = pg_temp.hid(1))
  and (select count(*) = 1 from public.pool_counted_hands c where c.hand_id = pg_temp.hid(1))
  and (select p.hands = 1 and p.net_bb = 1.5 from public.pool_players p
        where p.owner_id = '00000000-0000-0000-0000-0000000d00a1' and p.player = 'Villain1'),
  'every product of the hand is stored, as A''s');
select ok(
  not exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(1))
  and exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(5))
  and not exists (select 1 from public.hand_stats where hand_id = pg_temp.hid(5)),
  'A''s hand left the queue; B''s stayed, untouched');
select is((select pending from public.derive_pending_counts where owner_id = '00000000-0000-0000-0000-0000000d00a1'),
  2::bigint, 'the counter subtracts the saved hand');

-- Saved again (a retried request; the hand queued again): nothing doubles.
insert into public.derive_queue (hand_id, owner_id, reason) values (pg_temp.hid(1), '00000000-0000-0000-0000-0000000d00a1', 'retry');
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is((public.derive_save(jsonb_build_array(pg_temp.product(1))) ->> 'saved')::int, 1, 'saving the hand again ...');
select is(public.derive_save(jsonb_build_array(pg_temp.product(1))), '{"saved": 0, "failed": 0}'::jsonb,
  '... and once more, off the queue: nothing to save');
select pg_temp.as_postgres();
select ok(
  (select count(*) = 1 from public.hand_stats where hand_id = pg_temp.hid(1))
  and (select count(*) = 1 from public.hand_stats_ev where hand_id = pg_temp.hid(1))
  and (select count(*) = 1 from public.hand_facts where hand_id = pg_temp.hid(1))
  and (select p.hands = 1 from public.pool_players p
        where p.owner_id = '00000000-0000-0000-0000-0000000d00a1' and p.player = 'Villain1'),
  'a hand saved twice is stored once and counted in the pool once');

-- The worker writes as the owner and leaves the identity as it was.
select pg_temp.as_worker();
select is(public.derive_save(jsonb_build_array(pg_temp.product(5))), '{"saved": 1, "failed": 0}'::jsonb,
  'the worker saves B''s hand');
select is(current_setting('request.jwt.claims', true), '{"role":"rail_derive"}', '... and the request''s claims are restored');
select pg_temp.as_postgres();
select ok(
  (select s.owner_id = '00000000-0000-0000-0000-0000000d00b1' from public.hand_stats s where s.hand_id = pg_temp.hid(5))
  and (select p.owner_id = '00000000-0000-0000-0000-0000000d00b1' from public.pool_players p where p.player = 'Villain5'),
  '... as B: B''s rows, B''s pool');

-- A refused hand: retried, then given up on its third try.
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is(
  public.derive_save(jsonb_build_array(
    jsonb_set(pg_temp.product(3), '{stats,0,vpip}', '5'::jsonb), pg_temp.product(2))),
  '{"saved": 1, "failed": 1}'::jsonb, 'a hand the database refuses costs that hand only');
select pg_temp.as_postgres();
select ok(
  (select q.claimed_at is null and q.last_error is not null from public.derive_queue q where q.hand_id = pg_temp.hid(3))
  and not exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(2)),
  '... it goes back to the queue with the reason; the other is saved');
update public.derive_queue set tries = 3 where hand_id = pg_temp.hid(3);
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is((public.derive_save(jsonb_build_array(jsonb_set(pg_temp.product(3), '{stats,0,vpip}', '5'::jsonb))) ->> 'failed')::int,
  1, 'refused on its third try ...');
select pg_temp.as_postgres();
select ok(
  not exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(3))
  and exists (select 1 from public.derive_failures where hand_id = pg_temp.hid(3) and tries = 3),
  '... it is given up (derive_failures) and no longer pending');

-- ----------------------------------------------------------------- fail --

insert into public.derive_queue (hand_id, owner_id, reason) values
  (pg_temp.hid(3), '00000000-0000-0000-0000-0000000d00a1', 'retry');
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is(public.derive_fail(jsonb_build_array(jsonb_build_object('hand_id', pg_temp.hid(3), 'error', 'boom'))),
  '{"failed": 0, "retry": 1}'::jsonb, 'a failure that may pass goes back on the queue');
select is(public.derive_fail(jsonb_build_array(jsonb_build_object('hand_id', pg_temp.hid(3), 'error', 'unreadable', 'final', true))),
  '{"failed": 1, "retry": 0}'::jsonb, 'a final one is given up');
select is(public.derive_fail(jsonb_build_array(jsonb_build_object('hand_id', pg_temp.hid(6), 'final', true))),
  '{"failed": 0, "retry": 0}'::jsonb, 'A cannot fail B''s hand');
select is((select error from public.derive_failures where hand_id = pg_temp.hid(3)), 'unreadable',
  'A reads A''s failures');
select pg_temp.as_postgres();
select ok(exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(6)), '... B''s hand is still queued');

-- ------------------------------------------------------------ deletion --

-- A counted hand deleted: the counter subtracts it, the pool empties and the
-- rest is queued to be counted again.
delete from public.derive_queue where owner_id = '00000000-0000-0000-0000-0000000d00a1';
select is((select pending from public.derive_pending_counts where owner_id = '00000000-0000-0000-0000-0000000d00a1'),
  0::bigint, 'A has nothing pending');
delete from public.hands where id = pg_temp.hid(1);
select ok(
  not exists (select 1 from public.pool_players where owner_id = '00000000-0000-0000-0000-0000000d00a1')
  and (select r.reason = 'pool' and r.after is null from public.derive_recounts r
        where r.owner_id = '00000000-0000-0000-0000-0000000d00a1')
  and not exists (select 1 from public.derive_queue where owner_id = '00000000-0000-0000-0000-0000000d00a1'),
  'a counted hand deleted empties the pool and marks the account for a recount (the delete queues nothing itself)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is((select array_agg(c.hand_id::text || ' ' || c.reason order by c.hand_id) from public.derive_claim(10, '{}') c),
  array[pg_temp.hid(2)::text || ' pool', pg_temp.hid(3)::text || ' pool'],
  'the next claim queues A''s other hands with a hero and claims them (P2 will subtract instead)');
select pg_temp.as_postgres();
select ok(
  (select pending = 2 from public.derive_pending_counts where owner_id = '00000000-0000-0000-0000-0000000d00a1')
  and not exists (select 1 from public.derive_recounts where owner_id = '00000000-0000-0000-0000-0000000d00a1'),
  '... counted, and the mark is gone once the last page is queued');
delete from public.hands where id = pg_temp.hid(6);
select is((select pending from public.derive_pending_counts where owner_id = '00000000-0000-0000-0000-0000000d00b1'),
  0::bigint, 'a queued hand deleted takes its row and the counter subtracts it');

-- The browser's checker rows take a hand out of the queue (reason analysis only).
update public.derive_queue set reason = 'analysis' where hand_id = pg_temp.hid(2);
insert into public.analysis_checker_hands (hand_id, analysis_version, owner_id, membership_version, site, game_format,
                                           currency, hero_position, pot_type)
values (pg_temp.hid(2), 'analysis/47', '00000000-0000-0000-0000-0000000d00a1', 'analytics/1', 'pokerstars', 'cash', 'USD', 'BTN', 'walk');
select ok(not exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(2))
          and exists (select 1 from public.derive_queue where hand_id = pg_temp.hid(3)),
  'the browser''s checker rows take the analysed hand out of the queue');

-- -------------------------------------------------- opponents, pool, backlog --

delete from public.derive_queue where owner_id = '00000000-0000-0000-0000-0000000d00a1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000d00a1');
select is(public.derive_villains(), false, 'opponents'' statistics are off by default');
select is(public.derive_villains_set(true), '{"queued": 2, "villains": true}'::jsonb,
  'turning them on queues A''s hands with a hero');
select is(public.derive_villains(), true, '... and is remembered for the account');
select is((select bool_and(c.villains) from public.derive_claim(10, '{}') c), true, '... and the claim says so');
select is((public.analytics_pool('{}') ->> 'pending')::int, 2, 'the Pool''s pending is the counter');
select throws_ok($$ select public.derive_enqueue_backlog('stats/3') $$, '42501', null,
  'the backlog function is not the user''s');

select pg_temp.as_postgres();
delete from public.derive_queue where owner_id = '00000000-0000-0000-0000-0000000d00a1';
select is(public.derive_enqueue_backlog('stats/3', null, 1, '00000000-0000-0000-0000-0000000d00a1') - 'after',
  '{"seen": 1, "queued": 1, "done": false}'::jsonb, 'the backlog queues a page ...');
select is(
  (public.derive_enqueue_backlog('stats/3', (public.derive_enqueue_backlog('stats/3', null, 1, '00000000-0000-0000-0000-0000000d00a1') ->> 'after')::uuid,
                                 10, '00000000-0000-0000-0000-0000000d00a1') - 'after'),
  '{"seen": 1, "queued": 1, "done": true}'::jsonb, '... and the next after it, until done');

select * from finish();
rollback;
