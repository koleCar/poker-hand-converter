-- pgTAP: Rail R6.3, Stripe Billing's database side --
-- `20270915090000_billing_stripe.sql`.
--
-- What has to hold:
--
--   * nothing new is reachable by a client: the event log is sealed, every
--     new function is the service role's only (so `entitlements`' free list
--     is unchanged), every definer pins search_path;
--   * the customer link: first writer wins, ids checked, lookup both ways;
--   * the session budget: 20 an hour per account and kind;
--   * a webhook event (`billing_apply_subscription`): applied through R6.2's
--     `billing_set_plan`; the same id twice changes nothing (idempotent);
--     an event older than the account's newest is not applied (out of
--     order), the same second is; an unknown customer and an event without a
--     subscription are logged and change nothing; a dead subscription that
--     is not the account's live one is ignored, a live one replaces it;
--     every outcome is logged, none left `processing`;
--   * the effective plan follows (`my_entitlements` under enforcement);
--   * a deleted account leaves its log rows without an owner; the prune.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(44);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000063b001', 'bill.one@example.com', now(), now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000063b002', 'bill.two@example.com', now(), now() - interval '30 days');

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  execute 'set local role service_role';
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
-- The plan's fields of one account, as one string.
create function pg_temp.plan_of(p_uid uuid) returns text language sql as $$
  select concat_ws('/', p.plan, coalesce(p.plan_period, '-'), coalesce(p.plan_status, '-'),
                   coalesce(to_char(p.current_period_end at time zone 'UTC', 'YYYY-MM-DD'), '-'),
                   coalesce(p.billing_subscription_id, '-'))
    from public.profiles p where p.id = p_uid;
$$;
-- One event, as the webhook sends it (times as offsets from a fixed instant).
create function pg_temp.apply(p_id text, p_offset_s integer, p_customer text, p_sub text, p_plan text,
                              p_status text, p_end_days integer)
returns text language sql as $$
  select public.billing_apply_subscription(
    p_id, 'customer.subscription.updated',
    timestamptz '2027-01-01 12:00:00+00' + make_interval(secs => p_offset_s),
    p_customer, p_sub, p_plan, 'month', p_status,
    case when p_end_days is null then null else now() + make_interval(days => p_end_days) end);
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.as_service(), pg_temp.as_postgres(), pg_temp.plan_of(uuid),
  pg_temp.apply(text, integer, text, text, text, text, integer) to authenticated, service_role;

-- ---------------------------------------------------------- the schema --

select ok(not has_any_column_privilege('authenticated', 'public.billing_events', 'select, insert, update, references')
          and not has_any_column_privilege('anon', 'public.billing_events', 'select, insert, update, references')
          and not has_table_privilege('authenticated', 'public.billing_events', 'delete')
          and (select relrowsecurity from pg_class where oid = 'public.billing_events'::regclass),
  'billing_events is sealed (RLS on, no client privilege)');

select ok(exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'profiles' and column_name = 'billing_event_at')
          and not has_any_column_privilege('authenticated', 'public.profiles', 'select, insert, update, references'),
  'profiles carries billing_event_at and stays sealed');

select is((select array_agg(p.oid::regprocedure::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('billing_account', 'billing_set_customer', 'billing_owner_of_customer', 'billing_claim',
                                'billing_apply_subscription', 'billing_events_prune')
              and (has_function_privilege('authenticated', p.oid, 'execute')
                   or has_function_privilege('anon', p.oid, 'execute')
                   or not has_function_privilege('service_role', p.oid, 'execute'))),
  null, 'every new function: the service role only (nothing new is client-callable)');

select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('billing_account', 'billing_set_customer', 'billing_owner_of_customer', 'billing_claim',
                                'billing_apply_subscription', 'billing_events_prune')
              and p.prosecdef and p.proconfig @> array['search_path=""']),
  6, 'all six are definers with an empty search_path');

select is((select reason from public.username_reservations where username_lower = 'billing'), 'route',
  '/billing (where Stripe Checkout returns) is a reserved route');

select pg_temp.act_as('00000000-0000-0000-0000-00000063b001');
select throws_ok($$ select public.billing_apply_subscription('evt_x', 't', now(), 'cus_x', 'sub_x', 'pro', 'month', 'active', null) $$,
  '42501', null, 'a client cannot apply an event');
select throws_ok($$ select public.billing_set_customer(auth.uid(), 'cus_mine') $$, '42501', null,
  '... nor link a customer');
select throws_ok($$ select * from public.billing_account(auth.uid()) $$, '42501', null, '... nor read its billing row');
select throws_ok($$ select count(*) from public.billing_events $$, '42501', null, '... nor read the event log');

-- ------------------------------------------------------- the customer --

select pg_temp.as_service();

select is((select row(customer_id, subscription_id, plan, plan_status, early_user)::text
             from public.billing_account('00000000-0000-0000-0000-00000063b001')),
  '(,,free,,t)', 'billing_account: no customer yet, Free, an early user (made before any cutoff)');
select is((select count(*)::int from public.billing_account('00000000-0000-0000-0000-0000000fffff')), 0,
  '... and no row for an account without a profile');

select is(public.billing_set_customer('00000000-0000-0000-0000-00000063b001', 'cus_one'), 'cus_one',
  'billing_set_customer links the customer');
select is(public.billing_set_customer('00000000-0000-0000-0000-00000063b001', 'cus_other'), 'cus_one',
  '... first writer wins: a second customer is not linked, the first comes back');
select throws_ok($$ select public.billing_set_customer('00000000-0000-0000-0000-00000063b002', 'not a customer') $$,
  '22023', null, '... a malformed id is refused');
select throws_ok($$ select public.billing_set_customer('00000000-0000-0000-0000-0000000fffff', 'cus_nobody') $$,
  'P0002', null, '... and an account without a profile');
select throws_ok($$ select public.billing_set_customer('00000000-0000-0000-0000-00000063b002', 'cus_one') $$,
  '23505', null, '... one customer belongs to one account');
select is(public.billing_set_customer('00000000-0000-0000-0000-00000063b002', 'cus_two'), 'cus_two',
  'the second account gets its own');
select is(public.billing_owner_of_customer('cus_one')::text || '/' || coalesce(public.billing_owner_of_customer('cus_nobody')::text, 'null'),
  '00000000-0000-0000-0000-00000063b001/null', 'billing_owner_of_customer: the account, or null');

-- ---------------------------------------------------------- the budget --

select lives_ok($$ select public.billing_claim('00000000-0000-0000-0000-00000063b001', 'checkout')
                     from generate_series(1, 20) $$, 'twenty checkout sessions an hour ...');
select throws_ok($$ select public.billing_claim('00000000-0000-0000-0000-00000063b001', 'checkout') $$, '53400', null,
  '... the twenty-first is refused');
select lives_ok($$ select public.billing_claim('00000000-0000-0000-0000-00000063b001', 'portal');
                   select public.billing_claim('00000000-0000-0000-0000-00000063b002', 'checkout') $$,
  'the portal and another account have their own budgets');
select throws_ok($$ select public.billing_claim('00000000-0000-0000-0000-00000063b001', 'anything') $$, '22023', null,
  'an unknown budget is refused');

-- ------------------------------------------------------------ events --

select is(pg_temp.apply('evt_a1', 0, 'cus_one', 'sub_one', 'pro', 'active', 30), 'applied', 'an event is applied ...');
select is(pg_temp.plan_of('00000000-0000-0000-0000-00000063b001'),
  'pro/month/active/' || to_char((now() + interval '30 days') at time zone 'UTC', 'YYYY-MM-DD') || '/sub_one',
  '... through billing_set_plan: plan, period, status, period end, subscription');
select is((select billing_event_at from public.profiles where id = '00000000-0000-0000-0000-00000063b001'),
  timestamptz '2027-01-01 12:00:00+00', '... and the event''s time is kept');

select is(pg_temp.apply('evt_a1', 100, 'cus_one', 'sub_one', 'pro', 'canceled', -1), 'duplicate',
  'the same event id again: duplicate ...');
select is(split_part(pg_temp.plan_of('00000000-0000-0000-0000-00000063b001'), '/', 3), 'active', '... nothing changes');

select is(pg_temp.apply('evt_a0', -10, 'cus_one', 'sub_one', 'pro', 'canceled', -1), 'stale',
  'an older event delivered late: stale ...');
select is(split_part(pg_temp.plan_of('00000000-0000-0000-0000-00000063b001'), '/', 3), 'active', '... not applied');

select is(pg_temp.apply('evt_a2', 0, 'cus_one', 'sub_one', 'pro', 'trialing', 30), 'applied',
  'an event of the same second is applied (Stripe''s clock has one-second steps)');
select is(pg_temp.apply('evt_a3', 60, 'cus_one', 'sub_one', 'pro', 'past_due', -2), 'applied', 'a newer one is applied');

select is(pg_temp.apply('evt_u1', 70, 'cus_unknown', 'sub_x', 'pro', 'active', 30), 'unknown_customer',
  'an unknown customer: logged, nothing changes');
select is(pg_temp.apply('evt_n1', 70, 'cus_one', null, 'pro', 'active', 30), 'ignored',
  'no subscription: ignored');

-- A second subscription: a dead one does not replace the live one; a live one does.
select is(pg_temp.apply('evt_s1', 80, 'cus_one', 'sub_old', 'pro', 'canceled', -5), 'not_current',
  'a dead subscription that is not the live one: not_current, ignored');
select is(pg_temp.apply('evt_s2', 90, 'cus_one', 'sub_new', 'pro', 'active', 365), 'applied',
  'a live one replaces it ...');
select is(split_part(pg_temp.plan_of('00000000-0000-0000-0000-00000063b001'), '/', 5), 'sub_new', '... as the current one');

select is((select string_agg(id || ':' || outcome || ':' || coalesce(left(owner_id::text, 8), 'none'), ' ' order by id)
             from public.billing_events
            where id = any (array['evt_a0', 'evt_a1', 'evt_a2', 'evt_a3', 'evt_n1', 'evt_s1', 'evt_s2', 'evt_u1'])),
  'evt_a0:stale:00000000 evt_a1:applied:00000000 evt_a2:applied:00000000 evt_a3:applied:00000000 '
  || 'evt_n1:ignored:none evt_s1:not_current:00000000 evt_s2:applied:00000000 evt_u1:unknown_customer:none',
  'every event is logged once with its outcome; none is left processing');

-- ------------------------------------------- what the account now sees --

select pg_temp.as_postgres();
update public.billing_settings set enforcement_enabled = true;
select pg_temp.as_service();
select is(pg_temp.apply('evt_d1', 100, 'cus_one', 'sub_new', 'pro', 'canceled', -1), 'applied', 'the subscription ends ...');
select pg_temp.act_as('00000000-0000-0000-0000-00000063b001');
select is(public.my_entitlements() ->> 'plan', 'free', '... and under enforcement the account is Free');
select pg_temp.as_service();
select is(pg_temp.apply('evt_d2', 110, 'cus_one', 'sub_new2', 'pro', 'active', 30), 'applied', 'a new subscription after it is applied ...');
select pg_temp.act_as('00000000-0000-0000-0000-00000063b001');
select is(public.my_entitlements() ->> 'reason', 'subscription', '... and makes the account Pro again');
select pg_temp.as_postgres();
update public.billing_settings set enforcement_enabled = false;

-- --------------------------------------------- deletion and the prune --

delete from auth.users where id = '00000000-0000-0000-0000-00000063b001';
select is((select count(*)::int from public.billing_events where owner_id is not null
             and owner_id = '00000000-0000-0000-0000-00000063b001'), 0,
  'a deleted account leaves its log rows without an owner');

select pg_temp.as_service();
select throws_ok($$ select public.billing_events_prune(interval '1 day') $$, '22023', null,
  'the prune keeps at least seven days');
select pg_temp.as_postgres();
-- (Only this test's rows are old: anything else in the table is newer.)
update public.billing_events set received_at = now() - interval '100 days' where id in ('evt_a0', 'evt_a1');
select pg_temp.as_service();
select is(public.billing_events_prune(), 2, 'the prune deletes rows older than 90 days');

select * from finish();
rollback;
