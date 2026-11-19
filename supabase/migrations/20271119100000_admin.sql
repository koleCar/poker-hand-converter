-- The admin screens (web /admin): every account, one account's page, and the
-- feedback reports (20271119090000_feedback.sql).
--
-- Admins are `profiles.role = 'admin'` (`public.is_admin()`, forum
-- moderation). Every function here checks it first and refuses anyone else
-- with 42501; nothing is granted to anon. Read-only except the report's
-- triage status. The screenshots are read through signed URLs: admins may
-- select objects in the private `feedback` bucket, nobody else.

begin;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create or replace function public.admin_users(
  p_search text default null,
  p_sort   text default 'created',
  p_desc   boolean default true,
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id               uuid,
  email            text,
  username         text,
  role             text,
  plan             text,
  plan_status      text,
  created_at       timestamptz,
  last_sign_in_at  timestamptz,
  email_confirmed  boolean,
  banned           boolean,
  hands            bigint,
  last_hand_at     timestamptz,
  posts            bigint,
  feedback         bigint,
  total            bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  with base as (
    select u.id, u.email::text as email, p.username, p.role::text as role, p.plan, p.plan_status,
           u.created_at, u.last_sign_in_at, u.email_confirmed_at is not null as email_confirmed,
           coalesce(p.banned_until > now(), false) as banned
    from auth.users u
    left join public.profiles p on p.id = u.id
    where v_search is null
       or u.email ilike '%' || v_search || '%'
       or p.username ilike '%' || v_search || '%'
       or u.id::text = v_search
  ),
  hand_counts as (
    select h.owner_id, count(*) as n
    from public.hands h
    where h.owner_id in (select b.id from base b)
    group by h.owner_id
  ),
  arrivals as (
    select a.owner_id, max(a.arrived_at) as at
    from public.hand_arrivals a
    where a.owner_id in (select b.id from base b)
    group by a.owner_id
  ),
  writing as (
    select w.author_id, count(*) as n
    from (
      select po.author_id from public.posts po where po.author_id in (select b.id from base b)
      union all
      select c.author_id from public.comments c where c.author_id in (select b.id from base b)
    ) w
    group by w.author_id
  ),
  reports as (
    select f.user_id, count(*) as n
    from public.feedback f
    where f.user_id in (select b.id from base b)
    group by f.user_id
  ),
  listed as (
    select b.*, coalesce(hc.n, 0) as hands, ar.at as last_hand_at,
           coalesce(wr.n, 0) as posts, coalesce(rp.n, 0) as feedback
    from base b
    left join hand_counts hc on hc.owner_id = b.id
    left join arrivals ar on ar.owner_id = b.id
    left join writing wr on wr.author_id = b.id
    left join reports rp on rp.user_id = b.id
  )
  select r.id, r.email, r.username, r.role, r.plan, r.plan_status, r.created_at, r.last_sign_in_at,
         r.email_confirmed, r.banned, r.hands, r.last_hand_at, r.posts, r.feedback,
         count(*) over () as total
  from listed r
  order by
    case when p_desc then
      case p_sort
        when 'hands'      then r.hands::numeric
        when 'posts'      then r.posts::numeric
        when 'feedback'   then r.feedback::numeric
        when 'signed_in'  then extract(epoch from r.last_sign_in_at)::numeric
        when 'last_hand'  then extract(epoch from r.last_hand_at)::numeric
        when 'created'    then extract(epoch from r.created_at)::numeric
      end
    end desc nulls last,
    case when not p_desc then
      case p_sort
        when 'hands'      then r.hands::numeric
        when 'posts'      then r.posts::numeric
        when 'feedback'   then r.feedback::numeric
        when 'signed_in'  then extract(epoch from r.last_sign_in_at)::numeric
        when 'last_hand'  then extract(epoch from r.last_hand_at)::numeric
        when 'created'    then extract(epoch from r.created_at)::numeric
      end
    end asc nulls last,
    case when p_desc and p_sort = 'email' then r.email end desc,
    case when not p_desc and p_sort = 'email' then r.email end asc,
    case when p_desc and p_sort = 'username' then lower(r.username) end desc,
    case when not p_desc and p_sort = 'username' then lower(r.username) end asc,
    r.created_at desc, r.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.admin_users(text, text, boolean, integer, integer) is
  'Admin: every account with its hands, last arrival, forum posts and comments, and feedback; searched by email, '
  'username or id, sorted by one column, a page at a time (total on every row).';

-- One account, everything the admin page shows, as one JSON object.
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
      'earlyUser', p.early_user,
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

comment on function public.admin_user(uuid) is
  'Admin: one account - auth fields, profile and plan, hands (by site and origin), folders and devices, the last '
  'arrivals, forum and sharing counts, and its feedback. Null when there is no such account.';

-- ---------------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------------

create or replace function public.admin_feedback(
  p_status text default null,
  p_kind   text default null,
  p_user   uuid default null,
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id          uuid,
  created_at  timestamptz,
  kind        text,
  status      text,
  message     text,
  email       text,
  user_id     uuid,
  username    text,
  user_email  text,
  source      text,
  page        text,
  app_version text,
  platform    text,
  locale      text,
  images      text[],
  total       bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select f.id, f.created_at, f.kind, f.status, f.message, f.email, f.user_id, p.username, u.email::text,
         f.source, f.page, f.app_version, f.platform, f.locale, f.images,
         count(*) over () as total
  from public.feedback f
  left join public.profiles p on p.id = f.user_id
  left join auth.users u on u.id = f.user_id
  where (p_status is null or f.status = p_status)
    and (p_kind is null or f.kind = p_kind)
    and (p_user is null or f.user_id = p_user)
  order by f.created_at desc, f.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.admin_feedback(text, text, uuid, integer, integer) is
  'Admin: feedback reports, newest first, filtered by status, kind or account; total on every row.';

-- How many reports per status: the screen's filter counts.
create or replace function public.admin_feedback_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'all', count(*),
      'new', count(*) filter (where f.status = 'new'),
      'read', count(*) filter (where f.status = 'read'),
      'done', count(*) filter (where f.status = 'done'),
      'spam', count(*) filter (where f.status = 'spam')
    )
    from public.feedback f
  );
end;
$$;

create or replace function public.admin_feedback_set_status(p_id uuid, p_status text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'read', 'done', 'spam') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  update public.feedback set status = p_status where id = p_id;
  if not found then
    raise exception 'no such report' using errcode = 'P0002';
  end if;
end;
$$;

-- Grants: signed-in callers only; each function refuses non-admins itself.
revoke all on function public.admin_users(text, text, boolean, integer, integer) from public, anon;
revoke all on function public.admin_user(uuid) from public, anon;
revoke all on function public.admin_feedback(text, text, uuid, integer, integer) from public, anon;
revoke all on function public.admin_feedback_counts() from public, anon;
revoke all on function public.admin_feedback_set_status(uuid, text) from public, anon;
grant execute on function public.admin_users(text, text, boolean, integer, integer) to authenticated;
grant execute on function public.admin_user(uuid) to authenticated;
grant execute on function public.admin_feedback(text, text, uuid, integer, integer) to authenticated;
grant execute on function public.admin_feedback_counts() to authenticated;
grant execute on function public.admin_feedback_set_status(uuid, text) to authenticated;

-- The screenshots: admins read them through signed URLs.
drop policy if exists feedback_admin_read on storage.objects;
create policy feedback_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'feedback' and public.is_admin());

commit;
