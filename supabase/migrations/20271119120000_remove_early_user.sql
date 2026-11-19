-- ===========================================================================
-- Free tier + Pro (owner, 2026-11-19): the early-user discount is removed
-- ===========================================================================
--
-- There are no early users (owner's decision, `free-tier/CONTRACT.md`). R6.2
-- marked every account made before a launch cutoff as one and R6.3's checkout
-- gave them a coupon. All of it goes:
--
--   * the signup trigger `profiles_mark_early_user` and its function, and
--     `billing_mark_early_users()`;
--   * `profiles.early_user`, `profiles.early_user_since`;
--   * `billing_settings.early_user_cutoff`, `early_user_discount_percent`;
--   * `billing_account()` loses its `early_user` column (billing-checkout no
--     longer applies a coupon; `STRIPE_EARLY_USER_COUPON` is not read);
--   * the data download (`export_my_profile`, `plan.earlyUser*`) and the admin
--     page (`admin_user`, `profile.earlyUser`) stop showing it.
--
-- `my_entitlements().earlyUser` went in `20271119110000`. Nothing a user can
-- do or pay changes: no coupon was ever configured (Stripe is not live).
-- ===========================================================================

begin;

drop trigger if exists profiles_mark_early_user on public.profiles;
drop function if exists public.profiles_mark_early_user();
drop function if exists public.billing_mark_early_users();

-- What the checkout and the portal read (R6.3), without the early-user mark.
-- The returned columns change, so the function is dropped and made again.
drop function if exists public.billing_account(uuid);
create function public.billing_account(p_owner uuid)
returns table (
  customer_id text,
  subscription_id text,
  plan text,
  plan_status text,
  current_period_end timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.billing_customer_id, p.billing_subscription_id, p.plan, p.plan_status, p.current_period_end
    from public.profiles p
   where p.id = p_owner;
$$;

revoke all on function public.billing_account(uuid) from public, anon, authenticated;
grant execute on function public.billing_account(uuid) to service_role;
comment on function public.billing_account(uuid) is
  'R6.3: the account''s Stripe customer, subscription and status. Service role only (billing-checkout, billing-portal, billing-cancel).';

-- profile.json of the data download (R6.5), without the early-user fields.
create or replace function public.export_my_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_p     public.profiles%rowtype;
  v_u     record;
begin
  if v_owner is null then
    raise exception 'You must be signed in to export your data.' using errcode = '42501';
  end if;
  perform public.enforce_rate_limit('account_export_page:' || v_owner::text, 1, 5000, interval '1 hour');

  select u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at into v_u
  from auth.users u where u.id = v_owner;
  select * into v_p from public.profiles where id = v_owner;

  return jsonb_build_object(
    'account', jsonb_build_object(
      'id', v_owner,
      'email', v_u.email,
      'createdAt', v_u.created_at,
      'lastSignInAt', v_u.last_sign_in_at,
      'emailConfirmedAt', v_u.email_confirmed_at),
    'profile', case when v_p.id is null then null else jsonb_build_object(
      'username', v_p.username,
      'usernameChangedAt', v_p.username_changed_at,
      'role', v_p.role,
      'karma', v_p.karma,
      'digest', v_p.digest,
      'bannedUntil', v_p.banned_until,
      'banReason', v_p.ban_reason,
      'createdAt', v_p.created_at) end,
    'plan', case when v_p.id is null then null else jsonb_build_object(
      'plan', v_p.plan,
      'period', v_p.plan_period,
      'status', v_p.plan_status,
      'currentPeriodEnd', v_p.current_period_end,
      'updatedAt', v_p.plan_updated_at,
      'paymentProviderCustomerId', v_p.billing_customer_id,
      'paymentProviderSubscriptionId', v_p.billing_subscription_id) end,
    'boardsModerated', coalesce((select jsonb_agg(jsonb_build_object('board', b.slug, 'since', m.granted_at) order by b.slug)
                                   from public.board_moderators m join public.boards b on b.id = m.board_id
                                  where m.user_id = v_owner), '[]'::jsonb),
    'reservedUsernames', coalesce((select jsonb_agg(jsonb_build_object('username', r.username_lower, 'reason', r.reason,
                                                                        'expiresAt', r.expires_at) order by r.username_lower)
                                     from public.username_reservations r where r.reserved_for = v_owner), '[]'::jsonb));
end;
$$;

-- The admin page's account (`20271119100000`), without the early-user mark.
create or replace function public.admin_user(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'createdAt', u.created_at,
    'lastSignInAt', u.last_sign_in_at,
    'emailConfirmedAt', u.email_confirmed_at,
    'providers', coalesce(u.raw_app_meta_data -> 'providers', '[]'::jsonb),
    'profile', case when p.id is null then null else jsonb_build_object(
      'username', p.username,
      'role', p.role,
      'karma', p.karma,
      'plan', p.plan,
      'planStatus', p.plan_status,
      'planPeriod', p.plan_period,
      'currentPeriodEnd', p.current_period_end,
      'billingCustomer', p.billing_customer_id is not null,
      'bannedUntil', p.banned_until,
      'banReason', p.ban_reason,
      'shadowbanned', p.is_shadowbanned,
      'digest', p.digest
    ) end,
    'hands', (
      select jsonb_build_object(
        'total', count(*),
        'firstPlayedAt', min(h.played_at),
        'lastPlayedAt', max(h.played_at),
        'bySite', coalesce((
          select jsonb_agg(jsonb_build_object('site', s.site, 'hands', s.n) order by s.n desc)
          from (select h2.site, count(*) as n from public.hands h2 where h2.owner_id = u.id group by h2.site) s
        ), '[]'::jsonb),
        'byOrigin', coalesce((
          select jsonb_object_agg(o.origin, o.n)
          from (select h3.origin, count(*) as n from public.hands h3 where h3.owner_id = u.id group by h3.origin) o
        ), '{}'::jsonb)
      )
      from public.hands h where h.owner_id = u.id
    ),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', s.kind, 'label', s.label, 'device', s.device_name, 'site', s.site,
        'received', s.hands_received, 'inserted', s.hands_inserted, 'rejected', s.hands_rejected,
        'lastIngestAt', s.last_ingest_at, 'createdAt', s.created_at
      ) order by s.last_ingest_at desc nulls last)
      from public.hand_sources s where s.owner_id = u.id
    ), '[]'::jsonb),
    'arrivals', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.arrived_at, 'hands', a.hands, 'origin', a.origin) order by a.arrived_at desc)
      from (select * from public.hand_arrivals a0 where a0.owner_id = u.id order by a0.arrived_at desc limit 10) a
    ), '[]'::jsonb),
    'content', jsonb_build_object(
      'posts', (select count(*) from public.posts po where po.author_id = u.id),
      'comments', (select count(*) from public.comments c where c.author_id = u.id),
      'publishedHands', (select count(*) from public.published_hands ph where ph.author_id = u.id),
      'shares', (select count(*) from public.shares sh where sh.owner_id = u.id),
      'trainerAnswers', (select count(*) from public.trainer_results tr where tr.owner_id = u.id)
    ),
    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'createdAt', f.created_at, 'kind', f.kind, 'status', f.status, 'source', f.source,
        'message', left(f.message, 200), 'images', cardinality(f.images)
      ) order by f.created_at desc)
      from public.feedback f where f.user_id = u.id
    ), '[]'::jsonb)
  )
  into v
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = p_id;
  return v;
end;
$$;

alter table public.profiles
  drop column if exists early_user,
  drop column if exists early_user_since;

alter table public.billing_settings
  drop column if exists early_user_cutoff,
  drop column if exists early_user_discount_percent;

comment on table public.billing_settings is
  'R6.2: one row. enforcement_enabled = false (the default until launch) makes every account Pro. Sealed; the owner changes it in SQL.';

-- `profiles` stays sealed.
revoke all on public.profiles from anon, authenticated;

commit;
