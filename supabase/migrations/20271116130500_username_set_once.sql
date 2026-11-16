-- The username is chosen once (owner, 2026-11-16).
--
-- The public name is what other people see instead of the email address, so
-- it is an identity, not a nickname: an account picks it once, after signup,
-- and keeps it. Until then the account has the provisional `user_xxxxxxxx`
-- name `handle_new_user()` gave it (`username_changed_at is null`).
--
-- `set_username()` keeps its checks (shape, reservations, taken) and drops the
-- "once per 30 days" rule for "once": a chosen name refuses every change,
-- capitalisation included. Support can let an account choose again by
-- clearing `profiles.username_changed_at`; the old name is then reserved for
-- the account for a year, as before.
--
-- `my_profile()` keeps `nextUsernameChangeAt` for older clients; it is now
-- always null.

begin;

create or replace function public.set_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_name    text := btrim(coalesce(p_username, ''));
  v_lower   text := lower(btrim(coalesce(p_username, '')));
  v_problem text;
  v_me      public.profiles%rowtype;
  v_res     public.username_reservations%rowtype;
begin
  if v_uid is null then
    raise exception 'You must be signed in to choose a username.' using errcode = '42501';
  end if;

  select * into v_me from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'Your account is still being set up. Try again in a moment.' using errcode = '22023';
  end if;

  -- (1) Chosen once.
  if v_me.username_changed_at is not null then
    raise exception 'Your username is already set. It cannot be changed.' using errcode = '22023';
  end if;

  -- (2) The shape.
  v_problem := public.username_shape_problem(v_name);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;

  -- (3) Reservations: somebody else's (or nobody's) refuses; the caller's own
  -- is consumed (an account support reopened taking its old name back).
  select * into v_res
  from public.username_reservations
  where username_lower = v_lower
    and (expires_at is null or expires_at > now())
  for update;

  if found then
    if v_res.reserved_for is distinct from v_uid then
      raise exception 'That username is not available.' using errcode = '22023';
    end if;
    delete from public.username_reservations where username_lower = v_lower;
  end if;

  -- (4) Taken. The unique index decides.
  begin
    update public.profiles
       set username = v_name,
           username_changed_at = now()
     where id = v_uid;
  exception when unique_violation then
    raise exception 'That username is taken.' using errcode = '22023';
  end;

  -- The name the account had until now (the provisional one, or the one
  -- support reopened) stays this account's for a year: `/u/<old>` keeps
  -- resolving to the new name.
  if v_me.username_lower <> v_lower then
    insert into public.username_reservations (username_lower, reserved_for, reason, expires_at)
    values (v_me.username_lower, v_uid, 'previous-name', now() + interval '1 year')
    on conflict (username_lower) do update
      set reserved_for = excluded.reserved_for,
          reason       = excluded.reason,
          expires_at   = excluded.expires_at;
  end if;

  return jsonb_build_object(
    'username', v_name,
    'changedAt', now(),
    'nextChangeAt', null
  );
end;
$$;

revoke all on function public.set_username(text) from public;
revoke execute on function public.set_username(text) from anon;
grant execute on function public.set_username(text) to authenticated;

comment on function public.set_username(text) is
  'Choose the caller''s username, once. A chosen name cannot be changed (support can reopen it by clearing username_changed_at). Refusals are 22023 with a sentence to show.';

create or replace function public.my_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_p   public.profiles%rowtype;
begin
  if v_uid is null then
    return null;
  end if;

  select * into v_p from public.profiles where id = v_uid;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_p.id,
    'username', v_p.username,
    'provisional', v_p.username_changed_at is null,
    'usernameChangedAt', v_p.username_changed_at,
    'nextUsernameChangeAt', null,
    'role', v_p.role,
    'karma', v_p.karma,
    'joinedOn', (v_p.created_at at time zone 'UTC')::date,
    'digest', v_p.digest,
    'bannedUntil', case when v_p.banned_until > now() then v_p.banned_until end,
    'banReason', case when v_p.banned_until > now() then v_p.ban_reason end,
    'postingBlockReason', public.posting_block_reason(v_uid)
  );
end;
$$;

revoke all on function public.my_profile() from public;
revoke execute on function public.my_profile() from anon;
grant execute on function public.my_profile() to authenticated;

comment on function public.my_profile() is
  'The caller''s own profile as a named projection, plus postingBlockReason. Omits is_shadowbanned and unsubscribe_token. provisional = the username is not chosen yet.';

commit;
