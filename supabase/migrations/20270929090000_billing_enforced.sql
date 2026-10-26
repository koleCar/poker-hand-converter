-- ===========================================================================
-- Rail R6.4: is paid-plan enforcement on? - the one public fact
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.4. Once the owner turns enforcement on
-- (`billing_settings.enforcement_enabled`, R6.2), the desktop app without an
-- account is Free: the HUD, the analysis and the full reports need signing
-- in with a Pro account (owner, 2026-10-26). A signed-in app learns it from
-- `my_entitlements().enforced`; an app that has never signed in has no
-- account to ask with. `billing_enforced()` answers it with the anon key:
-- **the switch and nothing else** - no account, no plan, no limit, no user
-- data - so it is safe for anyone to call. The app asks when online and
-- keeps the answer; never told (offline since install, or a server without
-- this function), it assumes **off**, today's behaviour (R6.4 *As built*).
--
-- Zero behaviour change: the switch is still off, and nothing reads this
-- function but the desktop app.

begin;

create or replace function public.billing_enforced()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.enforcement_enabled from public.billing_settings s where s.id), false);
$$;

comment on function public.billing_enforced() is
  'R6.4: whether paid plans are enforced (billing_settings.enforcement_enabled), for an app with no account. Returns the switch only.';

revoke all on function public.billing_enforced() from public;
grant execute on function public.billing_enforced() to anon, authenticated, service_role;

commit;
