-- ===========================================================================
-- Free tier + Pro (owner, 2026-11-19): daily limits, solver flops, half year
-- ===========================================================================
--
-- The owner's new line between Free and Pro (`~/Projects/poker-hand-converter-wt/
-- free-tier/CONTRACT.md`, docs/BILLING.md section 4), on top of R6.2's
-- `20270908090000_entitlements.sql`:
--
--   * **Desktop sync is free.** `plan_limits.features` of Free is
--     `{desktop_sync}`; the three sync functions stay in `entitlement_gates`
--     (their guard passes for every plan). Table tiling and the RNG were never
--     gated on the server and are not now.
--   * **500 hands saved a day on Free** (web save and desktop ingest together,
--     the UTC day): `plan_limits.daily_hand_cap` (Free 500, Pro null), checked
--     by `hands_enforce_plan()` beside the library cap, on every insert path.
--     The day's count is `hand_daily_counts`, one row per account, bumped once
--     per insert statement - never a count over `hands`. Hands that already
--     exist (`on conflict do nothing`) never reach the transition table, so
--     they cost nothing. Over the cap: `PT402`, hint `daily_cap`, detail
--     `{cap, savedToday, attempted, resetsAt}`.
--   * **3 distinct solver flops a UTC day on Free**: `plan_limits.
--     daily_flop_cap` (Free 3, Pro null), the claims in `solver_flop_claims`
--     (owner, day, canonical flop), and two signed-in functions,
--     `solver_open_flop(flop)` and `solver_flops_today()`. Re-opening one of
--     today's flops is free; turns, rivers and spots on it are the client's.
--   * Two new features: `solver_unlimited` and `nodelock` (Pro).
--   * `my_entitlements()`: `features.solver_unlimited`, `features.nodelock`,
--     `limits.dailyHandCap`, `limits.dailyFlopCap`, `usage.handsToday`,
--     `usage.flopsToday`, `usage.dayResetsAt`; `earlyUser` is gone (the
--     early-user discount is removed, `20271119120000`).
--   * A six-month period: `plan_period` and `billing_consents.period` accept
--     `half_year` (Stripe price: month x 6).
--
-- ## Enforcement is still OFF: nothing changes
--
-- While `billing_settings.enforcement_enabled` is false every account's
-- effective plan is Pro: `hands_enforce_plan()` returns after reading one row
-- (it neither checks nor counts), `solver_open_flop()` allows every flop and
-- records nothing, and `my_entitlements()` reports no daily caps
-- (`dailyHandCap`/`dailyFlopCap` null). `handsToday` counts from the moment
-- enforcement is on.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The plans: daily caps and the two new features
-- ---------------------------------------------------------------------------

alter table public.plan_limits
  add column if not exists daily_hand_cap integer
    constraint plan_limits_daily_hand_cap_ok check (daily_hand_cap is null or daily_hand_cap >= 0),
  add column if not exists daily_flop_cap integer
    constraint plan_limits_daily_flop_cap_ok check (daily_flop_cap is null or daily_flop_cap >= 0);

comment on column public.plan_limits.daily_hand_cap is
  'Hands the plan saves per UTC day (web save and desktop ingest together); null = unlimited.';
comment on column public.plan_limits.daily_flop_cap is
  'Distinct solver flops the plan opens per UTC day (solver_open_flop); null = unlimited.';

alter table public.plan_limits drop constraint if exists plan_limits_features_check;
alter table public.plan_limits drop constraint if exists plan_limits_features_ok;
alter table public.plan_limits add constraint plan_limits_features_ok
  check (features <@ array['desktop_sync', 'hud', 'reports_full', 'analysis', 'learn',
                           'solver_unlimited', 'nodelock']::text[]);

alter table public.entitlement_gates drop constraint if exists entitlement_gates_feature_check;
alter table public.entitlement_gates drop constraint if exists entitlement_gates_feature_ok;
alter table public.entitlement_gates add constraint entitlement_gates_feature_ok
  check (feature in ('desktop_sync', 'hud', 'reports_full', 'analysis', 'learn', 'solver_unlimited', 'nodelock'));

update public.plan_limits
   set features = array['desktop_sync'], daily_hand_cap = 500, daily_flop_cap = 3, updated_at = now()
 where plan = 'free';
update public.plan_limits
   set features = array['desktop_sync', 'hud', 'reports_full', 'analysis', 'learn', 'solver_unlimited', 'nodelock'],
       daily_hand_cap = null, daily_flop_cap = null, updated_at = now()
 where plan = 'pro';

-- ---------------------------------------------------------------------------
-- 2. A six-month period
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_plan_period_ok;
alter table public.profiles add constraint profiles_plan_period_ok
  check (plan_period is null or plan_period in ('month', 'half_year', 'year'));

alter table public.billing_consents drop constraint if exists billing_consents_period_ok;
alter table public.billing_consents add constraint billing_consents_period_ok
  check (period in ('month', 'half_year', 'year'));

-- `profiles` stays sealed.
revoke all on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Helpers: the effective plan's limits, the UTC day
-- ---------------------------------------------------------------------------

-- The limits of the account's effective plan (Pro's - all null - while
-- enforcement is off). Takes an owner: internal.
create or replace function public.billing_plan_limits(p_owner uuid)
returns public.plan_limits
language sql
stable
security definer
set search_path = ''
as $$
  select l.* from public.plan_limits l
   where l.plan = (select st.plan from public.billing_plan_state(p_owner) st);
$$;

revoke all on function public.billing_plan_limits(uuid) from public;
revoke execute on function public.billing_plan_limits(uuid) from anon, authenticated;

-- The current UTC day, and when it ends ('2026-11-20T00:00:00Z').
create or replace function public.billing_utc_day()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'UTC')::date;
$$;

create or replace function public.billing_day_resets_at()
returns text
language sql
stable
set search_path = ''
as $$
  select to_char((now() at time zone 'UTC')::date + 1, 'YYYY-MM-DD') || 'T00:00:00Z';
$$;

revoke all on function public.billing_utc_day() from public;
revoke execute on function public.billing_utc_day() from anon, authenticated;
revoke all on function public.billing_day_resets_at() from public;
revoke execute on function public.billing_day_resets_at() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Hands saved today
-- ---------------------------------------------------------------------------
--
-- One row per account: the UTC day it counts and how many hands were saved
-- on it. A save on a new day starts the count again (the row is reused, so
-- nothing needs pruning). Kept by `hands_enforce_plan()` while enforcement is
-- on; read by `my_entitlements()`.

create table if not exists public.hand_daily_counts (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  day      date not null,
  hands    integer not null default 0 check (hands >= 0)
);

comment on table public.hand_daily_counts is
  'Free tier: hands saved on the account''s current UTC day (web save and desktop ingest), one row per account, '
  'bumped once per insert statement while billing enforcement is on. The daily hand cap reads it.';

alter table public.hand_daily_counts enable row level security;
revoke all on public.hand_daily_counts from anon, authenticated;
grant select on public.hand_daily_counts to authenticated;

drop policy if exists hand_daily_counts_own_select on public.hand_daily_counts;
create policy hand_daily_counts_own_select on public.hand_daily_counts
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- The plan's checks on `hands` (R6.2's 7a), now with the day's cap. Same
-- trigger (`hands_plan_after_insert`, after the library's counts): the
-- statement is refused whole, its counter bump with it.
create or replace function public.hands_enforce_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_lim   public.plan_limits;
  v_after bigint;
  v_day   date;
  v_today integer;
begin
  if not coalesce((select s.enforcement_enabled from public.billing_settings s where s.id), false) then
    return null;
  end if;
  v_day := public.billing_utc_day();
  for r in
    select i.owner_id, count(*)::integer as n, bool_or(i.origin = 'desktop') as desktop
    from inserted i
    where i.owner_id is not null
    group by i.owner_id
    order by i.owner_id
  loop
    if r.desktop and not public.has_entitlement(r.owner_id, 'desktop_sync') then
      raise exception 'Syncing hands from the desktop app is a Pro feature. Upgrade to Pro to sync.'
        using errcode = 'PT402', hint = 'desktop_sync';
    end if;
    v_lim := public.billing_plan_limits(r.owner_id);

    -- The library.
    if v_lim.hand_cap is not null then
      v_after := public.billing_stored_hands(r.owner_id);
      if v_after > v_lim.hand_cap then
        raise exception 'Your library is full on the Free plan. Upgrade to Pro to keep saving hands.'
          using errcode = 'PT402', hint = 'hand_cap',
                detail = jsonb_build_object('cap', v_lim.hand_cap, 'stored', v_after - r.n, 'attempted', r.n)::text;
      end if;
    end if;

    -- The day: counted for every plan (my_entitlements shows it), capped for
    -- a plan with a daily cap.
    insert into public.hand_daily_counts as c (owner_id, day, hands)
    values (r.owner_id, v_day, r.n)
    on conflict (owner_id) do update
       set hands = case when c.day = excluded.day then c.hands + excluded.hands else excluded.hands end,
           day   = excluded.day
    returning c.hands into v_today;
    if v_lim.daily_hand_cap is not null and v_today > v_lim.daily_hand_cap then
      raise exception 'You have saved today''s hands on the Free plan. The rest saves after the daily reset, or now with Pro.'
        using errcode = 'PT402', hint = 'daily_cap',
              detail = jsonb_build_object('cap', v_lim.daily_hand_cap, 'savedToday', v_today - r.n,
                                          'attempted', r.n, 'resetsAt', public.billing_day_resets_at())::text;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.hands_enforce_plan() from public;
revoke execute on function public.hands_enforce_plan() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Solver flops
-- ---------------------------------------------------------------------------
--
-- The canonical flop key: three cards `<rank><suit>` (ranks AKQJT98765432,
-- suits shdc), sorted by rank descending, then suit s h d c: `Ks7d2c`.
-- Whatever order and case it is given (`2c Ks 7d`, `ks7D2C`, `Ks,7d,2c`);
-- null when it is not three distinct cards.

create or replace function public.solver_flop_key(p_flop text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ranks constant text := 'AKQJT98765432';
  v_suits constant text := 'shdc';
  v       text;
  v_cards text[] := '{}';
  r       text;
  s       text;
begin
  if p_flop is null or char_length(p_flop) > 32 then
    return null;
  end if;
  v := regexp_replace(p_flop, '[[:space:],]+', '', 'g');
  if char_length(v) <> 6 then
    return null;
  end if;
  for i in 0..2 loop
    r := upper(substr(v, i * 2 + 1, 1));
    s := lower(substr(v, i * 2 + 2, 1));
    if position(r in v_ranks) = 0 or position(s in v_suits) = 0 then
      return null;
    end if;
    if (r || s) = any (v_cards) then
      return null;
    end if;
    v_cards := v_cards || (r || s);
  end loop;
  return (select string_agg(c, '' order by position(left(c, 1) in v_ranks), position(right(c, 1) in v_suits))
            from unnest(v_cards) c);
end;
$$;

revoke all on function public.solver_flop_key(text) from public;
revoke execute on function public.solver_flop_key(text) from anon, authenticated;

create table if not exists public.solver_flop_claims (
  owner_id   uuid not null references auth.users (id) on delete cascade,
  -- The UTC day the flop was opened on.
  day        date not null,
  flop       text not null
    constraint solver_flop_claims_flop_ok check (flop ~ '^([AKQJT2-9][shdc]){3}$'),
  -- clock_timestamp: the order they were opened in, also within one transaction.
  claimed_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, day, flop)
);

comment on table public.solver_flop_claims is
  'Free tier: the distinct solver flops an account on a plan with a daily flop cap opened, per UTC day '
  '(solver_open_flop). Earlier days are pruned on the next open.';

alter table public.solver_flop_claims enable row level security;
revoke all on public.solver_flop_claims from anon, authenticated;
grant select on public.solver_flop_claims to authenticated;

drop policy if exists solver_flop_claims_own_select on public.solver_flop_claims;
create policy solver_flop_claims_own_select on public.solver_flop_claims
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- Today's flops of an account, in the order they were opened.
create or replace function public.solver_flops_of(p_owner uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.flop order by c.claimed_at, c.flop), '{}')
    from public.solver_flop_claims c
   where c.owner_id = p_owner and c.day = public.billing_utc_day();
$$;

revoke all on function public.solver_flops_of(uuid) from public;
revoke execute on function public.solver_flops_of(uuid) from anon, authenticated;

-- Opens a flop: `{allowed, flop, flops, cap, resetsAt}`.
--   * Pro, or enforcement off: allowed, nothing recorded (cap null);
--   * a capped plan: allowed when the flop is one of today's, else recorded
--     when fewer than `cap` are, else `allowed = false`.
-- Signed in only. One open at a time per account (an advisory lock), so two
-- tabs cannot both take the last slot.
create or replace function public.solver_open_flop(p_flop text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_flop    text;
  v_cap     integer;
  v_day     date;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  v_flop := public.solver_flop_key(p_flop);
  if v_flop is null then
    raise exception 'Not a flop.' using errcode = '22023';
  end if;
  v_cap := (public.billing_plan_limits(v_uid)).daily_flop_cap;
  if v_cap is null then
    v_allowed := true;
  else
    v_day := public.billing_utc_day();
    perform pg_advisory_xact_lock(hashtextextended('solver_open_flop:' || v_uid::text, 0));
    delete from public.solver_flop_claims c where c.owner_id = v_uid and c.day < v_day;
    if exists (select 1 from public.solver_flop_claims c
                where c.owner_id = v_uid and c.day = v_day and c.flop = v_flop) then
      v_allowed := true;
    elsif (select count(*) from public.solver_flop_claims c where c.owner_id = v_uid and c.day = v_day) < v_cap then
      insert into public.solver_flop_claims (owner_id, day, flop) values (v_uid, v_day, v_flop);
      v_allowed := true;
    else
      v_allowed := false;
    end if;
  end if;
  return jsonb_build_object(
    'allowed', v_allowed,
    'flop', v_flop,
    'flops', to_jsonb(public.solver_flops_of(v_uid)),
    'cap', v_cap,
    'resetsAt', public.billing_day_resets_at());
end;
$$;

revoke all on function public.solver_open_flop(text) from public;
revoke execute on function public.solver_open_flop(text) from anon;
grant execute on function public.solver_open_flop(text) to authenticated;

-- Today's flops and the cap, claiming nothing: `{flops, cap, resetsAt}`.
create or replace function public.solver_flops_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'flops', to_jsonb(public.solver_flops_of(v_uid)),
    'cap', (public.billing_plan_limits(v_uid)).daily_flop_cap,
    'resetsAt', public.billing_day_resets_at());
end;
$$;

revoke all on function public.solver_flops_today() from public;
revoke execute on function public.solver_flops_today() from anon;
grant execute on function public.solver_flops_today() to authenticated;

comment on function public.solver_open_flop(text) is
  'Free tier: opens a solver flop (canonicalised). Pro / enforcement off: allowed, nothing recorded. A capped plan: '
  'today''s flops stay open, a new one is recorded while fewer than the cap. {allowed, flop, flops, cap, resetsAt}.';
comment on function public.solver_flops_today() is
  'Free tier: today''s opened solver flops, the cap (null = unlimited) and the next reset. Claims nothing.';

-- ---------------------------------------------------------------------------
-- 6. my_entitlements()
-- ---------------------------------------------------------------------------
--
--   {
--     "plan", "reason", "enforced",
--     "features": {"library_unlimited", "hand_cap", "desktop_sync", "hud",
--                  "reports_full", "analysis", "learn", "solver_unlimited",
--                  "nodelock"},
--     "usage": {"handsStored", "handsToday", "flopsToday": text[],
--               "dayResetsAt": "YYYY-MM-DDT00:00:00Z"},
--     "limits": {"freeHandCap" (what Free holds, also while off),
--                "dailyHandCap", "dailyFlopCap" (the effective plan's;
--                null = unlimited, so null while enforcement is off)},
--     "subscription": {"plan", "period", "status", "currentPeriodEnd"},
--     "validUntil", "graceUntil", "offlineGraceDays", "checkedAt"
--   }
create or replace function public.my_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  s       public.billing_settings;
  st      record;
  p       record;
  v_lim   public.plan_limits;
  v_feat  text[];
  v_free  integer;
  v_today integer;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  select * into s from public.billing_settings b where b.id;
  select * into st from public.billing_plan_state(v_uid);
  select pr.plan, pr.plan_period, pr.plan_status, pr.current_period_end
    into p
    from public.profiles pr where pr.id = v_uid;
  select * into v_lim from public.plan_limits l where l.plan = st.plan;
  v_feat := coalesce(v_lim.features, '{}');
  v_free := (select l.hand_cap from public.plan_limits l where l.plan = 'free');
  v_today := coalesce((select c.hands from public.hand_daily_counts c
                        where c.owner_id = v_uid and c.day = public.billing_utc_day()), 0);

  return jsonb_build_object(
    'plan', st.plan,
    'reason', st.reason,
    'enforced', st.enforced,
    'features', jsonb_build_object(
      'library_unlimited', v_lim.hand_cap is null,
      'hand_cap', v_lim.hand_cap,
      'desktop_sync', 'desktop_sync' = any (v_feat),
      'hud', 'hud' = any (v_feat),
      'reports_full', 'reports_full' = any (v_feat),
      'analysis', 'analysis' = any (v_feat),
      'learn', 'learn' = any (v_feat),
      'solver_unlimited', 'solver_unlimited' = any (v_feat),
      'nodelock', 'nodelock' = any (v_feat)),
    'usage', jsonb_build_object(
      'handsStored', public.billing_stored_hands(v_uid),
      'handsToday', v_today,
      'flopsToday', to_jsonb(public.solver_flops_of(v_uid)),
      'dayResetsAt', public.billing_day_resets_at()),
    'limits', jsonb_build_object(
      'freeHandCap', v_free,
      'dailyHandCap', v_lim.daily_hand_cap,
      'dailyFlopCap', v_lim.daily_flop_cap),
    'subscription', jsonb_build_object(
      'plan', coalesce(p.plan, 'free'),
      'period', p.plan_period,
      'status', p.plan_status,
      'currentPeriodEnd', p.current_period_end),
    'validUntil', st.valid_until,
    'graceUntil', case when st.reason = 'grace' then st.valid_until end,
    'offlineGraceDays', coalesce(s.offline_grace_days, 0),
    'checkedAt', now());
end;
$$;

revoke all on function public.my_entitlements() from public;
revoke execute on function public.my_entitlements() from anon;
grant execute on function public.my_entitlements() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The account's data (R6.5's inventory)
-- ---------------------------------------------------------------------------

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.hand_daily_counts', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'How many hands the account saved on its current UTC day, for the Free plan''s daily cap. One number and a '
   'date; deleted with the account.'),
  ('public.solver_flop_claims', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'The solver flops (three cards) the account opened today, for the Free plan''s daily flop cap; earlier days '
   'are pruned. Deleted with the account.')
on conflict (name) do nothing;

commit;
