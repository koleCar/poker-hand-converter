-- ===========================================================================
-- Rail R6.2: plans and entitlements, checked in the database
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.2, after the owner's R6.1 decisions (2026-10-23):
-- **Free** (converter, replayer, sharing, a library of at most 10 000 stored
-- hands, basic statistics) and one **Pro** plan, monthly or yearly (unlimited
-- library, desktop HUD and sync, full reports, analysis - session review,
-- leaks, own charts, ICM - and Learn). Accounts made before the launch are
-- **early users** and keep a lifetime discount while they stay subscribed
-- (the discount itself is R6.3's checkout). Prices and limits are refinable,
-- so they are **data**: `plan_limits` and `billing_settings`, not constants.
--
-- ## Nobody can pay yet: enforcement is OFF
--
-- Stripe (R6.3) is not live. `billing_settings.enforcement_enabled` is false,
-- and while it is false **every account's effective plan is Pro**: no gate
-- refuses anything, no cap is checked, and every gated function behaves
-- exactly as before this migration (each guard returns after reading one
-- row). Turning it on is the owner's launch decision:
--
--     update public.billing_settings set enforcement_enabled = true;
--
-- ## What this adds
--
--   * `profiles`: `plan` ('free' | 'pro'), `plan_period` ('month' | 'year'),
--     `plan_status` ('active' | 'trialing' | 'past_due' | 'canceled'),
--     `current_period_end`, `plan_updated_at`, `early_user`,
--     `early_user_since`, and the payment provider's ids for R6.3
--     (`billing_customer_id`, `billing_subscription_id`). `profiles` is
--     sealed (no client grant of any kind, `20261007090000`), so clients can
--     neither read nor write any of it; `profiles_public`'s column list is
--     unchanged. The one writer is `billing_set_plan()`, executable by the
--     service role only (R6.3's webhook).
--   * `billing_settings` (one row) and `plan_limits` (one row per plan):
--     the switch, the free hand cap, the early-user cutoff and discount, the
--     grace periods, each plan's features. Sealed; changed by the owner in
--     SQL.
--   * `entitlement_gates`: which client-callable function needs which
--     feature. Every listed function gets one line,
--     `perform public.require_entitlement('<feature>');`, as the first
--     statement of its body (section 6 writes it in; pgTAP `entitlements`
--     checks it is still there - **a migration that re-creates a gated
--     function keeps the line**).
--   * One source of truth: `has_entitlement(owner, feature)` (internal),
--     `has_my_entitlement(feature)` and `require_entitlement(feature)` (the
--     caller), and `my_entitlements()` (everything the web and the app show
--     and cache: effective plan, features, limits, usage, early-user state,
--     enforcement, expiry and grace).
--   * Data-level checks that no client path can go around: the hand cap and
--     desktop-origin rows on `hands` (a statement trigger after the library's
--     counts), own chart sets and tournament settings (a row trigger), the
--     HUD layouts' select policy.
--
-- ## The Free / Pro line
--
--   Free, never gated: the converter and replayer (client side), the
--   library's readers and writers (`save_hands`, `ingest_hands` from the
--   web source, `library_*`, `search_hands`, `get_hand`) under the cap,
--   sharing and publishing, the forum, notes, and **basic statistics**:
--   `report_open` (the summary, every statistic, the HUD tiles and the
--   breakdowns by position, stake, room, table size and format),
--   `report_graph` (the win-rate graph), `report_facets` (the chips), the
--   statistics' own writers and coverage (`save_hand_stats`, `save_hand_ev`,
--   `hands_needing_stats`, `stats_coverage`, `stats_ev_missing`, prunes,
--   `refresh_report_summaries`), and reading a shared analysis.
--
--   Pro:
--     reports_full  `report_situations` (pot type, stack depth, the starting
--                   hand grid, players dealt in, street), `report_sessions`,
--                   `stats_opponents`, the Players screen's readers
--     analysis      every analysis reader and save, session review, own
--                   charts (readers, and writes to `preflop_chart_sets`),
--                   ICM (writes to `tournament_settings`), drills, the
--                   trainer, the study plan, `villain_counters`
--     learn         the course's server writes (`record_lesson_results`,
--                   `add_lesson_cards`, `review_lesson_card`)
--     desktop_sync  `register_hand_source`, `hands_since`, `put_hud_layouts`,
--                   reading `hud_layouts`, and any `hands` row of origin
--                   `desktop` (`ingest_hands` from a folder source)
--     hud           the HUD itself is local; R6.4's app reads it from
--                   `my_entitlements()`
--     library_unlimited / hand_cap
--                   the cap on stored hands (Free: 10 000), checked on
--                   every insert into `hands`, whatever the path
--
-- A refusal is SQLSTATE `PT402` (PostgREST answers HTTP 402), a fixed
-- English sentence (`lib/i18n/serverErrors.ts` has its Croatian), the feature
-- as the HINT, and for the cap a JSON DETAIL with the numbers.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Settings: the switch, the cap, the early users, the grace periods
-- ---------------------------------------------------------------------------

create table if not exists public.billing_settings (
  -- One row: the primary key can only be true.
  id boolean primary key default true check (id),

  -- Off until the owner launches paid plans: every account is Pro.
  enforcement_enabled boolean not null default false,

  -- Accounts created before this instant are early users. Null: not
  -- launched yet, so every account created now is one.
  early_user_cutoff timestamptz,

  -- The early users' lifetime discount (R6.3 applies it at checkout).
  early_user_discount_percent smallint not null default 30
    check (early_user_discount_percent between 0 and 100),

  -- A payment that failed (`past_due`), or a period that ended without the
  -- renewal arriving, keeps Pro this many days past `current_period_end`.
  payment_grace_days smallint not null default 7
    check (payment_grace_days between 0 and 60),

  -- How long the desktop app may trust its last answer offline (R6.4).
  offline_grace_days smallint not null default 14
    check (offline_grace_days between 0 and 90),

  updated_at timestamptz not null default now()
);

insert into public.billing_settings (id) values (true) on conflict (id) do nothing;

comment on table public.billing_settings is
  'R6.2: one row. enforcement_enabled = false (the default until launch) makes every account Pro. Sealed; the owner changes it in SQL.';

create table if not exists public.plan_limits (
  plan text primary key check (plan in ('free', 'pro')),
  -- Stored hands the plan holds; null = unlimited.
  hand_cap integer check (hand_cap is null or hand_cap >= 0),
  -- The plan's features, from the fixed set the database checks.
  features text[] not null default '{}'
    check (features <@ array['desktop_sync', 'hud', 'reports_full', 'analysis', 'learn']::text[]),
  updated_at timestamptz not null default now()
);

insert into public.plan_limits (plan, hand_cap, features) values
  ('free', 10000, '{}'),
  ('pro',  null,  array['desktop_sync', 'hud', 'reports_full', 'analysis', 'learn'])
on conflict (plan) do nothing;

comment on table public.plan_limits is
  'R6.2: each plan''s hand cap (null = unlimited) and features. Data, refinable without a code change. Sealed.';

alter table public.billing_settings enable row level security;
alter table public.plan_limits      enable row level security;
revoke all on public.billing_settings from anon, authenticated;
revoke all on public.plan_limits      from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The plan on the profile
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists plan text not null default 'free'
    constraint profiles_plan_ok check (plan in ('free', 'pro')),
  add column if not exists plan_period text
    constraint profiles_plan_period_ok check (plan_period is null or plan_period in ('month', 'year')),
  add column if not exists plan_status text
    constraint profiles_plan_status_ok
      check (plan_status is null or plan_status in ('active', 'trialing', 'past_due', 'canceled')),
  add column if not exists current_period_end timestamptz,
  add column if not exists plan_updated_at timestamptz,
  add column if not exists early_user boolean not null default false,
  add column if not exists early_user_since timestamptz,
  add column if not exists billing_customer_id text
    constraint profiles_billing_customer_len check (billing_customer_id is null or char_length(billing_customer_id) <= 255),
  add column if not exists billing_subscription_id text
    constraint profiles_billing_subscription_len check (billing_subscription_id is null or char_length(billing_subscription_id) <= 255);

-- The provider's ids are looked up by R6.3's webhook.
create unique index if not exists profiles_billing_customer_uidx
  on public.profiles (billing_customer_id) where billing_customer_id is not null;

comment on column public.profiles.plan is
  'R6.2: the plan paid for (free | pro). The effective plan is has_entitlement / my_entitlements: Pro for everyone while billing_settings.enforcement_enabled is false.';

-- Sealed as before: no column of profiles is granted to a client.
revoke all on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Early users
-- ---------------------------------------------------------------------------
--
-- Every account that exists now, and every account created until the owner
-- sets `early_user_cutoff`, is an early user. A before-insert trigger rather
-- than an edit of `handle_new_user()`: the signup trigger stays as it is.

create or replace function public.profiles_mark_early_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := (select s.early_user_cutoff from public.billing_settings s where s.id);
begin
  if v_cutoff is null or new.created_at < v_cutoff then
    new.early_user := true;
    new.early_user_since := coalesce(new.early_user_since, new.created_at);
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_mark_early_user() from public;
revoke execute on function public.profiles_mark_early_user() from anon, authenticated;

drop trigger if exists profiles_mark_early_user on public.profiles;
create trigger profiles_mark_early_user
  before insert on public.profiles
  for each row execute function public.profiles_mark_early_user();

-- Marks every account created before the cutoff (all of them while it is
-- null). Idempotent; never unmarks. The migration runs it once; the owner
-- may run it again after moving the cutoff later.
create or replace function public.billing_mark_early_users()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := (select s.early_user_cutoff from public.billing_settings s where s.id);
  v_n integer;
begin
  update public.profiles p
     set early_user = true,
         early_user_since = coalesce(p.early_user_since, p.created_at)
   where not p.early_user
     and (v_cutoff is null or p.created_at < v_cutoff);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.billing_mark_early_users() from public;
revoke execute on function public.billing_mark_early_users() from anon, authenticated;

select public.billing_mark_early_users();

-- ---------------------------------------------------------------------------
-- 4. The effective plan
-- ---------------------------------------------------------------------------
--
-- The rules, in one place (`billing_plan_state`):
--
--   enforcement off                              pro   (not_enforced)
--   no profile (anonymous, or not set up yet)    free
--   plan = pro, status null (granted by hand)    pro until current_period_end
--                                                (null = no end)  (granted)
--   plan = pro, active / trialing                pro until current_period_end
--                                                + payment_grace_days: a
--                                                renewal that is late to
--                                                arrive does not cut anyone
--                                                off  (subscription / grace)
--   plan = pro, past_due                         pro until current_period_end
--                                                + payment_grace_days (grace)
--   plan = pro, canceled                         pro until current_period_end
--                                                (paid to the end of the
--                                                period, no grace)
--   anything else                                free
--
-- Returns the plan, why, and until when it holds without new information
-- (null: no end known), which `my_entitlements()` hands the app (R6.4).

create or replace function public.billing_plan_state(p_owner uuid)
returns table (plan text, reason text, valid_until timestamptz, enforced boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.billing_settings;
  p record;
  v_grace interval;
begin
  select * into s from public.billing_settings b where b.id;
  if not found or not s.enforcement_enabled then
    return query select 'pro'::text, 'not_enforced'::text, null::timestamptz, false;
    return;
  end if;

  select pr.plan, pr.plan_status, pr.current_period_end into p
    from public.profiles pr where pr.id = p_owner;
  if not found or p.plan is distinct from 'pro' then
    return query select 'free'::text, 'free'::text, null::timestamptz, true;
    return;
  end if;

  v_grace := make_interval(days => s.payment_grace_days);

  if p.plan_status is null then
    if p.current_period_end is null or now() < p.current_period_end then
      return query select 'pro'::text, 'granted'::text, p.current_period_end, true;
      return;
    end if;
  elsif p.plan_status in ('active', 'trialing') then
    if p.current_period_end is null then
      return query select 'pro'::text, 'subscription'::text, null::timestamptz, true;
      return;
    elsif now() < p.current_period_end then
      return query select 'pro'::text, 'subscription'::text, p.current_period_end + v_grace, true;
      return;
    elsif now() < p.current_period_end + v_grace then
      return query select 'pro'::text, 'grace'::text, p.current_period_end + v_grace, true;
      return;
    end if;
  elsif p.plan_status = 'past_due' then
    if now() < coalesce(p.current_period_end, now()) + v_grace then
      return query select 'pro'::text, 'grace'::text, coalesce(p.current_period_end, now()) + v_grace, true;
      return;
    end if;
  elsif p.plan_status = 'canceled' then
    if p.current_period_end is not null and now() < p.current_period_end then
      return query select 'pro'::text, 'canceled_until_period_end'::text, p.current_period_end, true;
      return;
    end if;
  end if;

  return query select 'free'::text, 'expired'::text, null::timestamptz, true;
end;
$$;

revoke all on function public.billing_plan_state(uuid) from public;
revoke execute on function public.billing_plan_state(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Entitlement checks
-- ---------------------------------------------------------------------------

-- Any account's: takes an owner, so it would be an oracle on other accounts'
-- plans - granted to nobody; triggers and the functions below call it.
create or replace function public.has_entitlement(p_owner uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan text;
begin
  if not coalesce((select s.enforcement_enabled from public.billing_settings s where s.id), false) then
    return true;
  end if;
  if p_owner is null then
    return false;
  end if;
  select st.plan into v_plan from public.billing_plan_state(p_owner) st;
  if p_feature = 'library_unlimited' then
    return exists (select 1 from public.plan_limits l where l.plan = v_plan and l.hand_cap is null);
  end if;
  return exists (select 1 from public.plan_limits l where l.plan = v_plan and p_feature = any (l.features));
end;
$$;

revoke all on function public.has_entitlement(uuid, text) from public;
revoke execute on function public.has_entitlement(uuid, text) from anon, authenticated;

-- The caller's: for RLS policies (`(select public.has_my_entitlement('x'))`).
create or replace function public.has_my_entitlement(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_entitlement((select auth.uid()), p_feature);
$$;

revoke all on function public.has_my_entitlement(text) from public;
revoke execute on function public.has_my_entitlement(text) from anon;
grant execute on function public.has_my_entitlement(text) to authenticated, service_role;

-- The guard every gated function opens with. Definer because it reads the
-- sealed tables; it only ever looks at the caller (`auth.uid()`).
--
--   * enforcement off: returns, after reading one row;
--   * no user: a service-role or plain SQL caller (no client role in the
--     JWT) passes - the gate is about accounts; `anon` is refused;
--   * otherwise the caller's effective plan must have the feature, or
--     PT402 (HTTP 402) with the feature as the HINT.
create or replace function public.require_entitlement(p_feature text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  if not coalesce((select s.enforcement_enabled from public.billing_settings s where s.id), false) then
    return;
  end if;
  v_uid := (select auth.uid());
  if v_uid is null then
    if coalesce((select auth.role()), '') in ('anon', 'authenticated') then
      raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    return;
  end if;
  if not public.has_entitlement(v_uid, p_feature) then
    raise exception 'This is a Pro feature. Upgrade to Pro to use it.'
      using errcode = 'PT402', hint = p_feature;
  end if;
end;
$$;

revoke all on function public.require_entitlement(text) from public;
grant execute on function public.require_entitlement(text) to anon, authenticated, service_role;

-- Stored hands, cheaply: the library's counts (`20270818090000`), or a real
-- count for an account whose counts are being rebuilt.
create or replace function public.billing_stored_hands(p_owner uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.library_counts_stale s where s.owner_id = p_owner) then
    return (select count(*) from public.hands h where h.owner_id = p_owner);
  end if;
  return (select coalesce(sum(c.hands), 0)::bigint from public.library_hand_counts c where c.owner_id = p_owner);
end;
$$;

revoke all on function public.billing_stored_hands(uuid) from public;
revoke execute on function public.billing_stored_hands(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The gated functions
-- ---------------------------------------------------------------------------

create table if not exists public.entitlement_gates (
  -- `regprocedure` text, e.g. `public.report_situations(jsonb)`.
  function_sig text primary key,
  feature text not null
    check (feature in ('desktop_sync', 'hud', 'reports_full', 'analysis', 'learn')),
  note text
);

alter table public.entitlement_gates enable row level security;
revoke all on public.entitlement_gates from anon, authenticated;

comment on table public.entitlement_gates is
  'R6.2: the client-callable functions that open with perform public.require_entitlement(feature). pgTAP entitlements checks each still does.';

insert into public.entitlement_gates (function_sig, feature, note) values
  -- desktop sync
  ('public.register_hand_source(uuid,text,text,text,text)', 'desktop_sync', 'a watched folder of the app'),
  ('public.hands_since(timestamp with time zone,uuid,integer)', 'desktop_sync', 'the app''s pull'),
  ('public.put_hud_layouts(jsonb)', 'desktop_sync', 'HUD layouts follow the account'),
  -- full reports (basic statistics stay free: report_open, report_graph, report_facets)
  ('public.report_situations(jsonb)', 'reports_full', 'breakdowns by situation'),
  ('public.report_sessions(jsonb,integer)', 'reports_full', 'sessions'),
  ('public.stats_opponents(jsonb,text,integer)', 'reports_full', 'opponents panel'),
  ('public.players_list(jsonb)', 'reports_full', 'Players screen'),
  ('public.player_profile(text,text,text,text)', 'reports_full', 'Players screen'),
  ('public.player_sites(text)', 'reports_full', 'Players screen'),
  -- analysis
  ('public.analysis_breakdown(jsonb,text)', 'analysis', null),
  ('public.analysis_breakdown_scan(jsonb,text)', 'analysis', null),
  ('public.analysis_coverage(text)', 'analysis', null),
  ('public.analysis_graded_decisions(jsonb)', 'analysis', null),
  ('public.analysis_graded_facets(text)', 'analysis', null),
  ('public.analysis_hand(uuid,text)', 'analysis', null),
  ('public.analysis_hands(jsonb,text,integer,integer)', 'analysis', null),
  ('public.analysis_leak_examples(jsonb,date,date,jsonb,integer)', 'analysis', null),
  ('public.analysis_leak_hands(jsonb,text[],boolean,text,integer,integer)', 'analysis', null),
  ('public.analysis_leak_hands_scan(jsonb,text[],boolean,text,integer,integer)', 'analysis', null),
  ('public.analysis_leak_sample(uuid,text,text,text,text,date,date)', 'analysis', null),
  ('public.analysis_leaks(jsonb)', 'analysis', null),
  ('public.analysis_leaks_scan(jsonb)', 'analysis', null),
  ('public.analysis_node_actions(jsonb)', 'analysis', null),
  ('public.analysis_node_actions_scan(jsonb)', 'analysis', null),
  ('public.analysis_node_hands(jsonb,text[],text,boolean,text,integer,integer)', 'analysis', null),
  ('public.analysis_node_hands_scan(jsonb,text[],text,boolean,text,integer,integer)', 'analysis', null),
  ('public.analysis_overview(jsonb)', 'analysis', null),
  ('public.analysis_overview_scan(jsonb)', 'analysis', null),
  ('public.analysis_scope(jsonb)', 'analysis', 'the scan readers'' rows'),
  ('public.analysis_top_leaks(jsonb,text)', 'analysis', null),
  ('public.analysis_trend(jsonb,text,text,integer)', 'analysis', null),
  ('public.analysis_trend_scan(jsonb,text,text,integer)', 'analysis', null),
  ('public.hands_needing_analysis(text,uuid,integer)', 'analysis', null),
  ('public.hands_needing_analysis_recent(text,timestamp with time zone,uuid,integer)', 'analysis', null),
  ('public.hands_needing_analysis_recent_scan(text,timestamp with time zone,uuid,integer)', 'analysis', null),
  ('public.save_hand_analysis(jsonb)', 'analysis', null),
  ('public.villain_counters(jsonb,jsonb)', 'analysis', 'read by the analysis run'),
  ('public.session_review(jsonb,timestamp with time zone,integer,integer)', 'analysis', 'session review'),
  ('public.preflop_chart_examples(text,text,text,integer,numeric,numeric,text,integer,text,integer)', 'analysis', 'own charts'),
  ('public.preflop_chart_played(text,text,text,integer,numeric,numeric)', 'analysis', 'own charts'),
  ('public.preflop_chart_review_hands(jsonb,uuid[])', 'analysis', 'own charts'),
  ('public.preflop_chart_session(jsonb,timestamp with time zone,timestamp with time zone)', 'analysis', 'own charts'),
  ('public.drill_due_by_spot(text,timestamp with time zone)', 'analysis', 'drills'),
  ('public.drill_queue(text,text[],boolean,integer)', 'analysis', 'drills'),
  ('public.drill_summary(text,timestamp with time zone)', 'analysis', 'drills'),
  ('public.sync_drill_items(text,text)', 'analysis', 'drills'),
  ('public.review_drill(uuid,integer,text,numeric)', 'analysis', 'drills'),
  ('public.record_trainer_results(jsonb)', 'analysis', 'trainer'),
  ('public.trainer_summary(integer)', 'analysis', 'trainer'),
  ('public.study_plan(date,timestamp with time zone)', 'analysis', 'study plan'),
  ('public.save_study_plan(date,text,text,jsonb,jsonb,jsonb)', 'analysis', 'study plan'),
  ('public.set_study_task(uuid,boolean)', 'analysis', 'study plan'),
  -- learn
  ('public.record_lesson_results(jsonb)', 'learn', null),
  ('public.add_lesson_cards(jsonb)', 'learn', null),
  ('public.review_lesson_card(uuid,text)', 'learn', null)
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

-- Writes the guard into each listed function: re-creates it from its own
-- definition with one line after the body's first `begin` (the top level of
-- a plpgsql body - a declaration cannot be a line holding only `begin`).
-- Grants, owner, volatility, security and settings are kept (`create or
-- replace` from `pg_get_functiondef`). Idempotent: a function that already
-- calls the guard is left alone.
create or replace function public.entitlement_gates_apply()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  g      record;
  v_def  text;
  v_at   integer;
  v_head text;
  v_body text;
  v_new  text;
  v_n    integer := 0;
begin
  for g in select e.function_sig, e.feature from public.entitlement_gates e order by 1 loop
    v_def := pg_get_functiondef(g.function_sig::regprocedure);
    if position('public.require_entitlement(' in v_def) > 0 then
      continue;
    end if;
    if v_def !~* E'\n\\s*LANGUAGE plpgsql\\s*\n' then
      raise exception 'entitlement_gates: % is not plpgsql', g.function_sig;
    end if;
    v_at := position(E'\nAS $' in v_def);
    if v_at = 0 then
      raise exception 'entitlement_gates: % has no body', g.function_sig;
    end if;
    v_head := substr(v_def, 1, v_at);
    v_body := substr(v_def, v_at + 1);
    v_new := regexp_replace(v_body, E'(\n[ \t]*begin[ \t]*\n)',
                            E'\\1  perform public.require_entitlement(''' || g.feature || E''');  -- R6.2 entitlement gate\n',
                            'i');
    if v_new = v_body then
      raise exception 'entitlement_gates: % has no top-level begin', g.function_sig;
    end if;
    execute v_head || v_new;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.entitlement_gates_apply() from public;
revoke execute on function public.entitlement_gates_apply() from anon, authenticated;

select public.entitlement_gates_apply();

-- ---------------------------------------------------------------------------
-- 7. Data-level checks
-- ---------------------------------------------------------------------------

-- 7a. `hands`: the cap and the desktop's rows, for every path in (`save_hands`,
-- `ingest_hands`, a direct insert). A statement trigger named to fire after
-- `hands_library_counts_after_insert` (triggers of one event fire in name
-- order), so the counts already hold this statement's rows: the statement is
-- refused whole when the result is over the cap. Duplicates never reach the
-- transition table (`on conflict do nothing`), so they cost nothing.
create or replace function public.hands_enforce_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_plan  text;
  v_cap   integer;
  v_after bigint;
begin
  if not coalesce((select s.enforcement_enabled from public.billing_settings s where s.id), false) then
    return null;
  end if;
  for r in
    select i.owner_id, count(*) as n, bool_or(i.origin = 'desktop') as desktop
    from inserted i
    group by i.owner_id
    order by i.owner_id
  loop
    if r.desktop and not public.has_entitlement(r.owner_id, 'desktop_sync') then
      raise exception 'Syncing hands from the desktop app is a Pro feature. Upgrade to Pro to sync.'
        using errcode = 'PT402', hint = 'desktop_sync';
    end if;
    select st.plan into v_plan from public.billing_plan_state(r.owner_id) st;
    v_cap := (select l.hand_cap from public.plan_limits l where l.plan = v_plan);
    if v_cap is not null then
      v_after := public.billing_stored_hands(r.owner_id);
      if v_after > v_cap then
        raise exception 'Your library is full on the Free plan. Upgrade to Pro to keep saving hands.'
          using errcode = 'PT402', hint = 'hand_cap',
                detail = jsonb_build_object('cap', v_cap, 'stored', v_after - r.n, 'attempted', r.n)::text;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.hands_enforce_plan() from public;
revoke execute on function public.hands_enforce_plan() from anon, authenticated;

drop trigger if exists hands_plan_after_insert on public.hands;
create trigger hands_plan_after_insert
  after insert on public.hands
  referencing new table as inserted
  for each statement execute function public.hands_enforce_plan();

-- 7b. Tables a client writes directly under RLS: own chart sets
-- (`20270811090000`) and tournament settings (`20270901090000`, R5.5's ICM
-- grading). A row trigger, the feature its argument; named to fire before
-- each table's own guard (before-triggers fire in name order). Deleting
-- one's own row stays allowed.
create or replace function public.entitlement_row_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_entitlement(new.owner_id, tg_argv[0]) then
    raise exception 'This is a Pro feature. Upgrade to Pro to use it.'
      using errcode = 'PT402', hint = tg_argv[0];
  end if;
  return new;
end;
$$;

revoke all on function public.entitlement_row_guard() from public;
revoke execute on function public.entitlement_row_guard() from anon, authenticated;

drop trigger if exists preflop_chart_sets_entitlement on public.preflop_chart_sets;
create trigger preflop_chart_sets_entitlement
  before insert or update on public.preflop_chart_sets
  for each row execute function public.entitlement_row_guard('analysis');

drop trigger if exists tournament_settings_entitlement on public.tournament_settings;
create trigger tournament_settings_entitlement
  before insert or update on public.tournament_settings
  for each row execute function public.entitlement_row_guard('analysis');

-- 7c. The HUD's layouts are read with a plain select (`20270602090000`):
-- a Free account under enforcement reads none.
drop policy if exists hud_layouts_owner_select on public.hud_layouts;
create policy hud_layouts_owner_select on public.hud_layouts
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.has_my_entitlement('desktop_sync')));

-- ---------------------------------------------------------------------------
-- 8. my_entitlements(): what the web and the app read
-- ---------------------------------------------------------------------------
--
--   {
--     "plan": "free" | "pro",            effective now
--     "reason": "not_enforced" | "subscription" | "grace" | "granted"
--             | "canceled_until_period_end" | "free" | "expired",
--     "enforced": bool,
--     "features": {"library_unlimited", "hand_cap" (number | null),
--                  "desktop_sync", "hud", "reports_full", "analysis", "learn"},
--     "usage": {"handsStored"},
--     "limits": {"freeHandCap"},          what Free holds, also while off
--     "subscription": {"plan", "period", "status", "currentPeriodEnd"},
--     "earlyUser": {"is", "since", "discountPercent"},
--     "validUntil": time | null,          the plan holds at least until then
--     "graceUntil": time | null,          set while Pro is kept by grace
--     "offlineGraceDays": number,         the app's offline trust (R6.4)
--     "checkedAt": time
--   }
--
-- Never the provider's ids, the settings row as such, or anything of
-- another account.
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
  v_feat  text[];
  v_cap   integer;
  v_free  integer;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  select * into s from public.billing_settings b where b.id;
  select * into st from public.billing_plan_state(v_uid);
  select pr.plan, pr.plan_period, pr.plan_status, pr.current_period_end, pr.early_user, pr.early_user_since
    into p
    from public.profiles pr where pr.id = v_uid;
  select l.features, l.hand_cap into v_feat, v_cap from public.plan_limits l where l.plan = st.plan;
  v_free := (select l.hand_cap from public.plan_limits l where l.plan = 'free');

  return jsonb_build_object(
    'plan', st.plan,
    'reason', st.reason,
    'enforced', st.enforced,
    'features', jsonb_build_object(
      'library_unlimited', v_cap is null,
      'hand_cap', v_cap,
      'desktop_sync', 'desktop_sync' = any (coalesce(v_feat, '{}')),
      'hud', 'hud' = any (coalesce(v_feat, '{}')),
      'reports_full', 'reports_full' = any (coalesce(v_feat, '{}')),
      'analysis', 'analysis' = any (coalesce(v_feat, '{}')),
      'learn', 'learn' = any (coalesce(v_feat, '{}'))),
    'usage', jsonb_build_object('handsStored', public.billing_stored_hands(v_uid)),
    'limits', jsonb_build_object('freeHandCap', v_free),
    'subscription', jsonb_build_object(
      'plan', coalesce(p.plan, 'free'),
      'period', p.plan_period,
      'status', p.plan_status,
      'currentPeriodEnd', p.current_period_end),
    'earlyUser', jsonb_build_object(
      'is', coalesce(p.early_user, false),
      'since', p.early_user_since,
      'discountPercent', coalesce(s.early_user_discount_percent, 0)),
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
-- 9. The one writer of the plan: R6.3's webhook (service role)
-- ---------------------------------------------------------------------------
create or replace function public.billing_set_plan(
  p_user uuid,
  p_plan text,
  p_period text default null,
  p_status text default null,
  p_current_period_end timestamptz default null,
  p_customer_id text default null,
  p_subscription_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set plan = p_plan,
         plan_period = p_period,
         plan_status = p_status,
         current_period_end = p_current_period_end,
         billing_customer_id = coalesce(p_customer_id, billing_customer_id),
         billing_subscription_id = coalesce(p_subscription_id, billing_subscription_id),
         plan_updated_at = now()
   where id = p_user;
  if not found then
    raise exception 'No profile for that account.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.billing_set_plan(uuid, text, text, text, timestamptz, text, text) from public;
revoke execute on function public.billing_set_plan(uuid, text, text, text, timestamptz, text, text) from anon, authenticated;
grant execute on function public.billing_set_plan(uuid, text, text, text, timestamptz, text, text) to service_role;

commit;
