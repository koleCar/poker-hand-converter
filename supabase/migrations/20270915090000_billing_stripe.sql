-- ===========================================================================
-- Rail R6.3: Stripe Billing - what the Edge Functions need in the database
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.3, on top of R6.2's `20270908090000_entitlements.sql`
-- (which put the plan on `profiles` and made `billing_set_plan()` the one
-- writer). Three Edge Functions talk to Stripe (`supabase/functions/
-- billing-*`); the owner's setup is `docs/BILLING.md`. Everything here is for
-- the **service role only** - the functions call it with the runtime's own
-- `SUPABASE_SERVICE_ROLE_KEY`; no client executes, reads or writes any of it,
-- so nothing new is client-callable and `entitlements`' free list is
-- unchanged.
--
--   * `profiles.billing_event_at`: the `created` instant of the newest Stripe
--     event applied to the account. An event older than it is not applied
--     (Stripe does not deliver in order).
--   * `billing_events`: every Stripe event id the webhook has handled, with
--     its outcome - the idempotency log (Stripe delivers at least once).
--     No payload, no amount, no customer detail; the owner column is set
--     null when an account is deleted.
--   * `billing_account(owner)`: the customer, subscription, status, period end
--     and early-user state the checkout and the portal need.
--   * `billing_set_customer(owner, customer)`: links the Stripe customer the
--     checkout created (first writer wins; returns the stored one).
--   * `billing_owner_of_customer(customer)`: the account behind a customer.
--   * `billing_claim(owner, kind)`: the per-account budget of checkout and
--     portal sessions (`enforce_rate_limit`, 20 an hour each).
--   * `billing_apply_subscription(...)`: one webhook event, applied whole in
--     one transaction: duplicate -> nothing; unknown customer -> logged;
--     older than the account's last event -> logged, not applied; a dead
--     subscription that is not the account's current one -> logged; else
--     `billing_set_plan(...)` and the log row.
--   * `billing_events_prune(keep)`: deletes log rows older than `keep`
--     (Stripe retries an event for three days; default keep 90 days).
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The newest event applied to an account
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists billing_event_at timestamptz;

comment on column public.profiles.billing_event_at is
  'R6.3: Stripe''s created instant of the newest billing event applied to this account. Older events are logged, not applied (out-of-order delivery).';

-- `profiles` stays sealed (no client privilege on any column).
revoke all on public.profiles from anon, authenticated;

-- The web's new top-level route (`/billing/success`, `/billing/cancel`, where
-- Stripe Checkout returns) is a name nobody may register - the rule
-- `lib/routes.ts` states for every top-level segment.
insert into public.username_reservations (username_lower, reason)
values ('billing', 'route')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The event log (idempotency)
-- ---------------------------------------------------------------------------

create table if not exists public.billing_events (
  -- Stripe's event id (`evt_...`).
  id text primary key
    constraint billing_events_id_ok check (id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type text not null
    constraint billing_events_type_len check (char_length(type) between 1 and 100),
  -- The event's own `created` (Stripe's clock).
  event_created timestamptz not null,
  owner_id uuid references public.profiles (id) on delete set null,
  outcome text not null
    constraint billing_events_outcome_ok
      check (outcome in ('processing', 'applied', 'stale', 'unknown_customer', 'not_current', 'ignored')),
  received_at timestamptz not null default now()
);

create index if not exists billing_events_owner_idx on public.billing_events (owner_id) where owner_id is not null;
create index if not exists billing_events_received_idx on public.billing_events (received_at);

alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;

comment on table public.billing_events is
  'R6.3: Stripe webhook events handled (id, type, created, account, outcome) - the idempotency log. No payload. Service role only.';

-- ---------------------------------------------------------------------------
-- 3. What the checkout and the portal read
-- ---------------------------------------------------------------------------

create or replace function public.billing_account(p_owner uuid)
returns table (
  customer_id text,
  subscription_id text,
  plan text,
  plan_status text,
  current_period_end timestamptz,
  early_user boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.billing_customer_id, p.billing_subscription_id, p.plan, p.plan_status, p.current_period_end,
         p.early_user
    from public.profiles p
   where p.id = p_owner;
$$;

-- ---------------------------------------------------------------------------
-- 4. The customer link
-- ---------------------------------------------------------------------------

-- First writer wins: two checkouts started at once both create a customer
-- (Stripe's idempotency key usually makes it the same one); the account
-- keeps the first and the caller uses what this returns.
create or replace function public.billing_set_customer(p_owner uuid, p_customer_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stored text;
begin
  if p_customer_id is null or p_customer_id !~ '^cus_[A-Za-z0-9]{1,250}$' then
    raise exception 'Not a Stripe customer id.' using errcode = '22023';
  end if;
  update public.profiles
     set billing_customer_id = p_customer_id
   where id = p_owner and billing_customer_id is null;
  select p.billing_customer_id into v_stored from public.profiles p where p.id = p_owner;
  if not found then
    raise exception 'No profile for that account.' using errcode = 'P0002';
  end if;
  return v_stored;
end;
$$;

create or replace function public.billing_owner_of_customer(p_customer_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from public.profiles p where p.billing_customer_id = p_customer_id;
$$;

-- ---------------------------------------------------------------------------
-- 5. The session budget
-- ---------------------------------------------------------------------------

-- 20 checkout sessions and 20 portal sessions an hour per account: a person
-- who opens the payment page, goes back and tries again stays far inside it;
-- a script cannot have Stripe mint sessions (and customers) in bulk.
create or replace function public.billing_claim(p_owner uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner is null or p_kind is null or p_kind not in ('checkout', 'portal') then
    raise exception 'Unknown billing budget.' using errcode = '22023';
  end if;
  perform public.enforce_rate_limit('billing_' || p_kind || ':' || p_owner::text, 1, 20, interval '1 hour');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. One webhook event, applied whole
-- ---------------------------------------------------------------------------
--
-- The webhook maps Stripe's subscription (re-read from Stripe, never taken
-- from the request) to the plan's fields and calls this once per event.
-- Outcomes:
--
--   duplicate          the event id is in the log: nothing changes
--   ignored            no subscription in the event (a one-off invoice)
--   unknown_customer   no account has that customer (deleted, or not ours)
--   stale              created before the account's newest applied event
--   not_current        a subscription that is not the account's current
--                      one, and not live, while the current one is live
--   applied            `billing_set_plan(...)` ran
--
-- Every outcome but `duplicate` writes the log row, in the same transaction
-- as the change, so a failure leaves neither and Stripe's retry runs it again.
create or replace function public.billing_apply_subscription(
  p_event_id text,
  p_event_type text,
  p_event_created timestamptz,
  p_customer_id text,
  p_subscription_id text,
  p_plan text,
  p_period text,
  p_status text,
  p_current_period_end timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_current text;
  v_status text;
  v_last timestamptz;
  v_outcome text;
  v_live constant text[] := array['active', 'trialing', 'past_due'];
begin
  if p_event_id is null or p_event_type is null or p_event_created is null then
    raise exception 'An event needs its id, type and created time.' using errcode = '22023';
  end if;

  -- Claim the id first: a second delivery of the same event waits here for
  -- the first to commit, then finds it.
  insert into public.billing_events (id, type, event_created, outcome)
  values (p_event_id, p_event_type, p_event_created, 'processing')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  if p_subscription_id is null or p_customer_id is null then
    v_outcome := 'ignored';
  else
    select p.id, p.billing_subscription_id, p.plan_status, p.billing_event_at
      into v_owner, v_current, v_status, v_last
      from public.profiles p
     where p.billing_customer_id = p_customer_id
       for update;

    if v_owner is null then
      v_outcome := 'unknown_customer';
    elsif v_last is not null and p_event_created < v_last then
      v_outcome := 'stale';
    elsif v_current is not null and v_current <> p_subscription_id
          and v_status = any (v_live)
          and not (p_plan = 'pro' and p_status = any (v_live)) then
      v_outcome := 'not_current';
    else
      perform public.billing_set_plan(v_owner, p_plan, p_period, p_status, p_current_period_end,
                                      null, p_subscription_id);
      update public.profiles
         set billing_event_at = greatest(coalesce(billing_event_at, p_event_created), p_event_created)
       where id = v_owner;
      v_outcome := 'applied';
    end if;
  end if;

  update public.billing_events
     set outcome = v_outcome, owner_id = v_owner
   where id = p_event_id;
  return v_outcome;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Pruning the log
-- ---------------------------------------------------------------------------

create or replace function public.billing_events_prune(p_keep interval default interval '90 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_keep is null or p_keep < interval '7 days' then
    raise exception 'Keep at least seven days (Stripe retries an event for three).' using errcode = '22023';
  end if;
  delete from public.billing_events where received_at < now() - p_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Grants: the service role only
-- ---------------------------------------------------------------------------

revoke all on function public.billing_account(uuid) from public, anon, authenticated;
revoke all on function public.billing_set_customer(uuid, text) from public, anon, authenticated;
revoke all on function public.billing_owner_of_customer(text) from public, anon, authenticated;
revoke all on function public.billing_claim(uuid, text) from public, anon, authenticated;
revoke all on function public.billing_apply_subscription(text, text, timestamptz, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.billing_events_prune(interval) from public, anon, authenticated;

grant execute on function public.billing_account(uuid) to service_role;
grant execute on function public.billing_set_customer(uuid, text) to service_role;
grant execute on function public.billing_owner_of_customer(text) to service_role;
grant execute on function public.billing_claim(uuid, text) to service_role;
grant execute on function public.billing_apply_subscription(text, text, timestamptz, text, text, text, text, text, timestamptz)
  to service_role;
grant execute on function public.billing_events_prune(interval) to service_role;
grant select, insert, update, delete on public.billing_events to service_role;

comment on function public.billing_apply_subscription(text, text, timestamptz, text, text, text, text, text, timestamptz) is
  'R6.3: applies one Stripe webhook event (idempotent by event id, out-of-order safe by created time). Service role only (billing-webhook).';
comment on function public.billing_account(uuid) is
  'R6.3: the account''s Stripe customer, subscription and status, and the early-user mark. Service role only (billing-checkout, billing-portal, billing-cancel).';

commit;
