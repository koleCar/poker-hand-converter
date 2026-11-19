-- The Pro waitlist (owner, 2026-11-19): until Stripe is connected nobody can
-- subscribe, so every "Upgrade to Pro" opens a small "Pro is coming" dialog
-- that takes an email address for one message when Pro opens.
--
-- `pro_waitlist` holds one row per address (case-insensitive), with the
-- account that added it when one was signed in. Nobody reads or writes the
-- table through the API: `join_pro_waitlist` adds an address (anon and
-- signed in alike, idempotent), `my_pro_waitlist` tells a signed-in account
-- whether it is on the list, `admin_pro_waitlist` lists it for the admins.
--
-- Abuse: there is no server-side Turnstile check in this codebase (captcha
-- is Supabase Auth's own) and Postgres does not see the caller's address,
-- so the guard is the shared fixed-window limiter (`enforce_rate_limit`):
-- 10 an hour per account, and a global circuit breaker of 300 an hour for
-- visitors. A visitor is never told whether an address was already listed.
--
-- Account deletion: the account's rows, and any row carrying the account's
-- email, are deleted just before the auth user is (trigger on auth.users);
-- `user_id` is set null as a backstop. The rows are in the data download
-- (`pro_waitlist.ndjson`, sealed reader).

begin;

create extension if not exists citext with schema extensions;

create table public.pro_waitlist (
  id         bigint generated always as identity primary key,
  email      extensions.citext not null unique
               check (char_length(email::text) between 3 and 254
                      and email::text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  user_id    uuid references auth.users (id) on delete set null,
  locale     text not null default 'en' check (locale in ('en', 'hr')),
  source     text not null check (source in ('pricing', 'settings', 'app')),
  created_at timestamptz not null default now()
);

comment on table public.pro_waitlist is
  'Addresses that asked to be emailed once when Rail Pro opens (the "Pro is coming" dialog). Written only by '
  'join_pro_waitlist; kept until Pro opens or the person asks to be removed.';

create index pro_waitlist_user_idx on public.pro_waitlist (user_id) where user_id is not null;
create index pro_waitlist_created_idx on public.pro_waitlist (created_at desc);

alter table public.pro_waitlist enable row level security;
revoke all on public.pro_waitlist from anon, authenticated;

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.pro_waitlist', 'table', '{user_id}', 'file', 'pro_waitlist.ndjson', 'sealed', 'pro_waitlist', '{id}', '{}', 'erase',
   'The address the account asked to be emailed at when Pro opens, with where and when it was added. Deleted '
   'with the account, together with any row carrying the account''s email.')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Join (anyone)
-- ---------------------------------------------------------------------------

create or replace function public.join_pro_waitlist(p_email text, p_source text, p_locale text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_source   text := coalesce(p_source, '');
  v_locale   text := case when lower(coalesce(p_locale, '')) like 'hr%' then 'hr' else 'en' end;
  v_own      text;
  v_inserted boolean;
  v_owner    uuid;
begin
  if v_uid is not null then
    perform public.enforce_rate_limit('pro_waitlist:' || v_uid::text, 1, 10, interval '1 hour');
  else
    perform public.enforce_rate_limit('pro_waitlist:anon', 1, 300, interval '1 hour');
  end if;

  if char_length(v_email) not between 3 and 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023', hint = 'invalid_email';
  end if;
  if v_source not in ('pricing', 'settings', 'app') then
    raise exception 'invalid_source' using errcode = '22023', hint = 'invalid_source';
  end if;

  if v_uid is not null then
    select lower(u.email) into v_own from auth.users u where u.id = v_uid;
  end if;

  -- A new row is the caller's. A listed address is linked to an account
  -- only when it is that account's own (so deleting the account removes it),
  -- never to whoever typed it next.
  insert into public.pro_waitlist as w (email, user_id, locale, source)
  values (v_email::extensions.citext, v_uid, v_locale, v_source)
  on conflict (email) do update
    set user_id = coalesce(w.user_id, case when v_own = v_email then v_uid end)
  returning (xmax = 0), w.user_id into v_inserted, v_owner;

  -- "Already on the list" only for the caller's own address or row: a
  -- visitor (or anyone typing someone else's address) learns nothing.
  return jsonb_build_object(
    'ok', true,
    'already', not v_inserted and v_uid is not null
               and (coalesce(v_owner = v_uid, false) or coalesce(v_own = v_email, false)));
end;
$$;

revoke all on function public.join_pro_waitlist(text, text, text) from public;
grant execute on function public.join_pro_waitlist(text, text, text) to anon, authenticated;

comment on function public.join_pro_waitlist(text, text, text) is
  'Adds an address to the Pro waitlist (idempotent). anon and authenticated; 22023 invalid_email / '
  'invalid_source, 53400 over the rate limit. Returns {ok, already}; already only for the caller''s own address.';

-- ---------------------------------------------------------------------------
-- Am I on it (signed in)
-- ---------------------------------------------------------------------------

create or replace function public.my_pro_waitlist()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_row   public.pro_waitlist;
begin
  if v_uid is null then
    return jsonb_build_object('joined', false, 'email', null);
  end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  select * into v_row from public.pro_waitlist w
   where w.user_id = v_uid or (v_email is not null and w.email = v_email::extensions.citext)
   order by (w.user_id = v_uid) desc nulls last, w.created_at
   limit 1;
  return jsonb_build_object('joined', v_row.id is not null, 'email', v_row.email::text);
end;
$$;

revoke all on function public.my_pro_waitlist() from public;
revoke execute on function public.my_pro_waitlist() from anon;
grant execute on function public.my_pro_waitlist() to authenticated;

-- ---------------------------------------------------------------------------
-- Admin: the list
-- ---------------------------------------------------------------------------

create or replace function public.admin_pro_waitlist(p_limit integer default 50, p_offset integer default 0)
returns table (
  id         bigint,
  email      text,
  user_id    uuid,
  username   text,
  locale     text,
  source     text,
  created_at timestamptz,
  total      bigint
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
  select w.id, w.email::text, w.user_id, p.username, w.locale, w.source, w.created_at, count(*) over () as total
    from public.pro_waitlist w
    left join public.profiles p on p.id = w.user_id
   order by w.created_at desc, w.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.admin_pro_waitlist(integer, integer) from public;
revoke execute on function public.admin_pro_waitlist(integer, integer) from anon;
grant execute on function public.admin_pro_waitlist(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Account deletion
-- ---------------------------------------------------------------------------

create or replace function public.pro_waitlist_forget_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pro_waitlist w
   where w.user_id = old.id
      or (old.email is not null and w.email = old.email::extensions.citext);
  return old;
end;
$$;

revoke all on function public.pro_waitlist_forget_account() from public;
revoke execute on function public.pro_waitlist_forget_account() from anon, authenticated;

drop trigger if exists pro_waitlist_forget_account on auth.users;
create trigger pro_waitlist_forget_account
  before delete on auth.users
  for each row execute function public.pro_waitlist_forget_account();

commit;
