-- ============================================================================
-- Identity: profiles, usernames, reservations, roles and posting gates.
-- ============================================================================
--
-- F6 (#28, #29). Until now an account was an `auth.users` row and nothing else:
-- no name anybody else could see, no role, no notion of "may this account
-- post". Everything the forum does later -- author lines, `/u/[name]`, vote
-- weighting, moderation -- hangs off what this file creates, so it is shipped
-- on its own, before anything depends on it.
--
-- The file name was fixed by #28 as `20261005090000_forum_identity.sql`, but that
-- version was taken by `hand_stats` before this landed. It runs after
-- `20261006090000_hand_stats_prune.sql` and depends on nothing after the
-- accounts migration (`20260922130000`).
--
-- ## The grant posture does not change
--
-- `docs/DATABASE.md` rule 5 -- no UPDATE or DELETE grant to a client role,
-- anywhere -- survives intact. A username change *is* an update, and it is
-- expressed the way the plan settled every forum mutation: a narrow
-- `security definer` function that takes the actor from `auth.uid()`, writes a
-- whitelisted set of columns, and can be aimed at nothing else. The
-- alternative, an UPDATE policy on `profiles`, would let a caller set every
-- column they hold a grant on -- `role`, `karma`, `banned_until` -- and would
-- have to be re-tightened every time a column is added. A definer function
-- fails closed when a column is added; a policy fails open.
--
-- ## What nobody but the owner may learn
--
-- `profiles` carries columns that are nobody's business, some of them not even
-- the owner's: `ban_reason`, `is_shadowbanned` (a shadowban the account can
-- read is not a shadowban), `digest`, `unsubscribe_token`. So the base table is
-- sealed -- RLS on, no policies, no grants -- and there are exactly two doors:
--
--   * `profiles_public`, a view whose column list is the public surface;
--   * `my_profile()`, which returns the caller's own row as a named projection
--     that leaves out the shadowban flag.
-- ============================================================================

begin;

-- ===========================================================================
-- #28 -- profiles, usernames and reservations
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. profile_role
-- ---------------------------------------------------------------------------
--
-- An enum rather than text: a role is compared in security checks, and a typo
-- in a text comparison (`'moderater'`) is a check that silently never passes.

do $enum$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'profile_role'
  ) then
    create type public.profile_role as enum ('member', 'moderator', 'admin');
  end if;
end;
$enum$;

-- ---------------------------------------------------------------------------
-- 2. profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,

  -- Deliberately narrow: ASCII letters, digits and underscore, 3-24 characters,
  -- not starting with an underscore. Every character class allowed here is a
  -- homoglyph impersonation surface (Cyrillic `а` against Latin `a`, a dotless
  -- `ı`, a zero-width joiner), and a username appears in a URL, where anything
  -- beyond this set is percent-encoded into something nobody can read aloud.
  username text not null
    constraint profiles_username_shape
      check (username ~ '^[A-Za-z0-9][A-Za-z0-9_]{2,23}$'),

  -- Uniqueness is case-insensitive, and it is an index on this column -- never
  -- a pre-flight `exists` check, which races: two requests both see the name
  -- free and both insert. The unique index is the only check that cannot.
  username_lower text generated always as (lower(username)) stored,

  -- Null until the first chosen name. The provisional `user_xxxxxxxx` handed
  -- out at signup does not count against the 30-day limit.
  username_changed_at timestamptz,

  role public.profile_role not null default 'member',

  -- Maintained by the forum's vote recomputation (F8). Starts at zero.
  karma integer not null default 0,

  -- A ban is "until" rather than a flag, so a suspension expires on its own
  -- without somebody remembering to lift it. A permanent ban is 'infinity'.
  banned_until timestamptz,
  ban_reason text
    constraint profiles_ban_reason_len
      check (ban_reason is null or char_length(ban_reason) <= 500),

  -- Never exposed to the account itself: see `my_profile()`.
  is_shadowbanned boolean not null default false,

  -- Email digests (F14). Off by default: nobody is mailed without asking.
  digest text not null default 'off'
    constraint profiles_digest_ok
      check (digest in ('off', 'daily', 'weekly')),

  -- One-click unsubscribe link for the digest. A capability URL like a share
  -- slug, which is why it lives on a table nobody can list.
  unsubscribe_token uuid not null default gen_random_uuid(),

  -- Copied from `auth.users.created_at` at signup rather than stamped `now()`,
  -- so the backfill below gives existing accounts their real age -- which the
  -- posting and vote gates read.
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_username_lower_uidx
  on public.profiles (username_lower);

create unique index if not exists profiles_unsubscribe_token_uidx
  on public.profiles (unsubscribe_token);

comment on table public.profiles is
  'One row per account. Sealed: no client grants. Public reads go through profiles_public; the owner reads through my_profile(); the only write is set_username().';

-- ---------------------------------------------------------------------------
-- 3. username_reservations
-- ---------------------------------------------------------------------------
--
-- A name that nobody may take, or that only one account may take back.
--
-- The case that matters is name recycling. Without this table, renaming
-- `bigstack` to `bigstack_pro` frees `bigstack`, and the next person to claim it
-- inherits every link, quote and reputation that pointed at the original --
-- impersonation by waiting. So `set_username()` reserves the old name *for the
-- same account* for a year: nobody else can take it, the owner can take it
-- back, and `/u/bigstack` 301s to the new name for exactly that year.
--
-- `reserved_for` null means reserved for nobody: route segments, staff-sounding
-- names, and the names of deleted accounts.

create table if not exists public.username_reservations (
  username_lower text primary key
    constraint username_reservations_lower
      check (username_lower = lower(username_lower) and char_length(username_lower) between 1 and 24),
  reserved_for uuid references auth.users (id) on delete set null,
  reason text not null
    constraint username_reservations_reason_ok
      check (reason in ('route', 'staff', 'previous-name', 'deleted-account')),
  -- Null means forever.
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists username_reservations_reserved_for_idx
  on public.username_reservations (reserved_for)
  where reserved_for is not null;

comment on table public.username_reservations is
  'Names nobody else may take. reserved_for = the one account that may reclaim it (a previous name), or null for nobody. Sealed.';

-- Every top-level route segment. Most of them are shorter than three characters
-- and so could never be a username anyway; they are listed regardless, because
-- the point is that this table is the one place that answers "is this path
-- segment spoken for", and a route added later should be added here in the same
-- change.
insert into public.username_reservations (username_lower, reason)
values
  ('f', 'route'), ('u', 'route'), ('h', 'route'), ('p', 'route'),
  ('tag', 'route'), ('tags', 'route'), ('search', 'route'), ('submit', 'route'),
  ('settings', 'route'), ('convert', 'route'), ('library', 'route'),
  ('stats', 'route'), ('mod', 'route'), ('api', 'route'), ('auth', 'route'),
  ('login', 'route'), ('logout', 'route'), ('signin', 'route'), ('signup', 'route'),
  ('upload', 'route'), ('replay', 'route'), ('hands', 'route'), ('feed', 'route'),
  ('new', 'route'), ('top', 'route'), ('hot', 'route')
on conflict (username_lower) do nothing;

-- Names that read as speaking for the site.
insert into public.username_reservations (username_lower, reason)
values
  ('admin', 'staff'), ('admins', 'staff'), ('administrator', 'staff'),
  ('moderator', 'staff'), ('moderators', 'staff'), ('mods', 'staff'),
  ('staff', 'staff'), ('support', 'staff'), ('help', 'staff'),
  ('helpdesk', 'staff'), ('official', 'staff'), ('team', 'staff'),
  ('rail', 'staff'), ('railpoker', 'staff'), ('rail_poker', 'staff'),
  ('rail_team', 'staff'), ('rail_staff', 'staff'), ('rail_support', 'staff'),
  ('rail_official', 'staff'), ('rail_admin', 'staff'), ('rail_mod', 'staff'),
  ('system', 'staff'), ('root', 'staff'), ('security', 'staff'),
  ('abuse', 'staff'), ('postmaster', 'staff'), ('webmaster', 'staff'),
  ('hostmaster', 'staff'), ('noreply', 'staff'), ('no_reply', 'staff'),
  ('null', 'staff'), ('undefined', 'staff'), ('anonymous', 'staff'),
  ('deleted', 'staff'), ('removed', 'staff'), ('unknown', 'staff'),
  ('everyone', 'staff'), ('here', 'staff'), ('owner', 'staff'),
  ('hero', 'staff'), ('villain', 'staff')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 4. username_blocked_terms
-- ---------------------------------------------------------------------------
--
-- Slurs, kept apart from reservations because exact matching is useless
-- against them: nobody registers the bare word, they register it with a suffix.
-- So a term can match `contains`, after folding the obvious evasions
-- (underscores dropped, `0 1 3 4 5 7` read as `o i e a s t`).
--
-- Substring matching is also how you ban `raccoon` and `spicy`, so every short
-- term that is also an innocent fragment is `exact` instead -- compared against
-- the whole folded name. That is the Scunthorpe trade, made term by term.
--
-- This is a seed, not a finished list. It is data: extending it is an insert by
-- the service role, not a migration.

create table if not exists public.username_blocked_terms (
  term text primary key
    constraint username_blocked_terms_term_ok check (term ~ '^[a-z]{3,24}$'),
  match text not null
    constraint username_blocked_terms_match_ok check (match in ('contains', 'exact'))
);

comment on table public.username_blocked_terms is
  'Terms a username may not contain (or be). Compared against username_fold(). Seeded here; extended as data by the service role. Sealed.';

insert into public.username_blocked_terms (term, match)
values
  ('nigger', 'contains'), ('nigga', 'contains'), ('faggot', 'contains'),
  ('retard', 'contains'), ('wetback', 'contains'), ('tranny', 'contains'),
  ('kike', 'exact'), ('spic', 'exact'), ('chink', 'exact'), ('coon', 'exact'),
  ('fag', 'exact'), ('gook', 'exact'), ('dyke', 'exact')
on conflict (term) do nothing;

-- ---------------------------------------------------------------------------
-- 5. RLS and grants on the three tables
-- ---------------------------------------------------------------------------
--
-- Supabase's default privileges grant everything on a new table to `anon` and
-- `authenticated`, so every one of these starts over-permissioned and has to be
-- revoked by name. RLS on with no policies, so even a grant added by mistake
-- later reaches nothing.

alter table public.profiles              enable row level security;
alter table public.username_reservations enable row level security;
alter table public.username_blocked_terms enable row level security;

revoke all on public.profiles               from anon, authenticated;
revoke all on public.username_reservations  from anon, authenticated;
revoke all on public.username_blocked_terms from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Name helpers
-- ---------------------------------------------------------------------------

-- The folded form blocked terms are compared against. `immutable`, so it could
-- back an index if the term list ever grows large enough to want one.
create or replace function public.username_fold(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(translate(lower(coalesce(p_name, '')), '013457', 'oieast'), '_', '');
$$;

revoke all on function public.username_fold(text) from public;
revoke execute on function public.username_fold(text) from anon, authenticated;

-- Why a name may not be taken, as the sentence to show -- or null when it may.
--
-- Checks shape, blocked terms and the provisional prefix, which are properties
-- of the name alone. It deliberately does NOT check reservations or whether the
-- name is taken: those depend on who is asking, and belong to `set_username()`.
create or replace function public.username_shape_problem(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_fold text := public.username_fold(p_name);
begin
  if p_name is null or char_length(p_name) < 3 then
    return 'Usernames are at least 3 characters.';
  end if;
  if char_length(p_name) > 24 then
    return 'Usernames are at most 24 characters.';
  end if;
  if p_name !~ '^[A-Za-z0-9_]+$' then
    return 'Usernames can use only letters, numbers and underscores.';
  end if;
  if p_name !~ '^[A-Za-z0-9]' then
    return 'Usernames start with a letter or a number.';
  end if;
  -- The provisional names are issued by `handle_new_user()` and nothing else.
  -- A chosen `user_abc12345` would look exactly like a fresh account's, which
  -- is an impersonation of "nobody in particular" -- and would collide with
  -- the issuer eventually.
  if lower(p_name) ~ '^user_' then
    return 'Names starting with "user_" are reserved for new accounts.';
  end if;
  if exists (
    select 1 from public.username_blocked_terms t
    where (t.match = 'contains' and position(t.term in v_fold) > 0)
       or (t.match = 'exact' and t.term = v_fold)
  ) then
    return 'That username is not allowed.';
  end if;
  return null;
end;
$$;

revoke all on function public.username_shape_problem(text) from public;
revoke execute on function public.username_shape_problem(text) from anon, authenticated;

-- `user_` plus eight base-36 characters from a CSPRNG. Random rather than
-- derived from anything, and specifically never from the email: `paul.smith@x`
-- becoming `paulsmith` publishes the address to everyone who reads a thread.
create or replace function public.provisional_username()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'user_' || string_agg(
    substr('0123456789abcdefghijklmnopqrstuvwxyz', 1 + (get_byte(b.bytes, g.i) % 36), 1), '')
  from (select extensions.gen_random_bytes(8) as bytes) b,
       generate_series(0, 7) as g(i);
$$;

revoke all on function public.provisional_username() from public;
revoke execute on function public.provisional_username() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. handle_new_user -- a profile for every account, at signup
-- ---------------------------------------------------------------------------
--
-- `security definer`: it runs as whichever role GoTrue inserts `auth.users`
-- with, which holds no privilege on `public.profiles`. It takes no input but
-- the new row's id and creation time, so there is nothing to aim.
--
-- **Anonymous users get no profile.** The live project still has anonymous
-- sign-ins switched on (the app does not use them -- a guest is plainly signed
-- out), and each `signInAnonymously()` call with the public anon key is a new
-- `auth.users` row. A profile per row would let anyone fill `profiles_public`
-- with `user_xxxxxxxx` names from a loop. An anonymous session has no identity
-- to name, so it gets none; every gate and `my_profile()` already treat "no
-- profile" as "cannot post".
--
-- **A failure here fails the signup**, because the trigger runs inside the
-- insert. So it never raises on a name collision (it retries with a fresh
-- name), and it is `on conflict do nothing` on the id, so a replayed insert or
-- a re-run backfill cannot turn into an error on somebody's signup form.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt integer := 0;
begin
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;

  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.profiles (id, username, created_at)
      values (new.id, public.provisional_username(), coalesce(new.created_at, now()))
      on conflict (id) do nothing;
      return new;
    exception when unique_violation then
      -- 36^8 names, so a collision is a lottery win. The loop is there so that
      -- the lottery win costs a retry instead of a failed signup.
      if v_attempt >= 8 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: every account created before this migration gets its profile, with
-- its real signup time. Idempotent through the same `on conflict`.
do $backfill$
declare
  r record;
  v_attempt integer;
begin
  for r in
    select u.id, u.created_at
    from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id)
      and not coalesce(u.is_anonymous, false)
  loop
    v_attempt := 0;
    loop
      v_attempt := v_attempt + 1;
      begin
        insert into public.profiles (id, username, created_at)
        values (r.id, public.provisional_username(), coalesce(r.created_at, now()))
        on conflict (id) do nothing;
        exit;
      exception when unique_violation then
        if v_attempt >= 8 then
          raise;
        end if;
      end;
    end loop;
  end loop;
end;
$backfill$;

-- ---------------------------------------------------------------------------
-- 8. A deleted account's name is not up for grabs
-- ---------------------------------------------------------------------------
--
-- Deleting an account cascades its profile away. Without this, the moment the
-- row goes, its name is free -- and whoever takes it next is, to everyone who
-- remembers the old account, that person. So the name is reserved for nobody,
-- for a year: long enough for the old links to stop mattering.
--
-- The account's own previous-name reservations survive too: `reserved_for` is
-- `on delete set null`, which turns "only they may reclaim it" into "nobody
-- may", and leaves the expiry as it was.

create or replace function public.profiles_reserve_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A provisional name was never anybody's identity. Reserving every one of
  -- them would fill the table with names nobody will ever ask for.
  if old.username_changed_at is not null then
    insert into public.username_reservations (username_lower, reserved_for, reason, expires_at)
    values (old.username_lower, null, 'deleted-account', now() + interval '1 year')
    on conflict (username_lower) do update
      set reserved_for = null,
          reason       = 'deleted-account',
          expires_at   = greatest(public.username_reservations.expires_at, excluded.expires_at);
  end if;
  return old;
end;
$$;

revoke all on function public.profiles_reserve_on_delete() from public;
revoke execute on function public.profiles_reserve_on_delete() from anon, authenticated;

drop trigger if exists profiles_reserve_on_delete on public.profiles;
create trigger profiles_reserve_on_delete
  before delete on public.profiles
  for each row execute function public.profiles_reserve_on_delete();

-- ---------------------------------------------------------------------------
-- 9. set_username
-- ---------------------------------------------------------------------------
--
-- The only write to `profiles` a client can cause.
--
-- `security definer`, because `profiles` grants UPDATE to nobody. Safe to hold
-- that privilege because it cannot be aimed:
--
--   * the actor is `auth.uid()`, never an argument;
--   * it writes two columns (`username`, `username_changed_at`) on one row, the
--     caller's own;
--   * it writes one reservation, for the caller's *old* name, reserved for the
--     caller.
--
-- Rules, in the order they are checked:
--
--   1. The shape (`username_shape_problem`).
--   2. Same name, different case (`paul` -> `Paul`): allowed any time, reserves
--      nothing and does not start the clock -- the address does not change.
--   3. Once per 30 days. The provisional name does not count.
--   4. A reservation for somebody else -- or for nobody -- refuses. A
--      reservation for the caller is consumed: that is taking a name back.
--   5. Taken (the unique index, not a pre-flight read).
--
-- Every refusal is `22023` with a sentence the UI shows as it is.

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
  v_next    timestamptz;
begin
  if v_uid is null then
    raise exception 'You must be signed in to choose a username.' using errcode = '42501';
  end if;

  -- No `enforce_rate_limit` here, on purpose. Every refusal below is a raise,
  -- and a raise rolls back the whole call -- the counter increment with it --
  -- so a limiter would count only successes, which the 30-day rule already
  -- bounds. And there is nothing to protect from a probing loop: whether a
  -- name is taken is already public through `profiles_public`.

  select * into v_me from public.profiles where id = v_uid for update;
  if not found then
    -- Only possible for an account created while the trigger was missing.
    raise exception 'Your account is still being set up. Try again in a moment.' using errcode = '22023';
  end if;

  v_problem := public.username_shape_problem(v_name);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;

  -- (2) Same address, different capitalisation.
  if v_lower = v_me.username_lower then
    if v_name <> v_me.username then
      update public.profiles set username = v_name where id = v_uid;
    end if;
    return jsonb_build_object(
      'username', v_name,
      'changedAt', v_me.username_changed_at,
      'nextChangeAt', case when v_me.username_changed_at is null then null
                           else v_me.username_changed_at + interval '30 days' end
    );
  end if;

  -- (3) Once per 30 days, counted from the last *chosen* name.
  if v_me.username_changed_at is not null
     and v_me.username_changed_at > now() - interval '30 days' then
    v_next := v_me.username_changed_at + interval '30 days';
    raise exception 'You can change your username once every 30 days. The next change is possible on %.',
      to_char(v_next at time zone 'UTC', 'FMDD FMMonth YYYY')
      using errcode = '22023';
  end if;

  -- (4) Reservations.
  select * into v_res
  from public.username_reservations
  where username_lower = v_lower
    and (expires_at is null or expires_at > now())
  for update;

  if found then
    if v_res.reserved_for is distinct from v_uid then
      -- The same sentence for "reserved for nobody" and "somebody's previous
      -- name": which one it is tells a stranger that the name belonged to
      -- somebody who has since moved on, and who.
      raise exception 'That username is not available.' using errcode = '22023';
    end if;
    -- Taking your own old name back.
    delete from public.username_reservations where username_lower = v_lower;
  end if;

  -- (5) Taken. The unique index decides, so two simultaneous claims cannot
  -- both win.
  begin
    update public.profiles
       set username = v_name,
           username_changed_at = now()
     where id = v_uid;
  exception when unique_violation then
    raise exception 'That username is taken.' using errcode = '22023';
  end;

  -- The old name is kept for this account for a year: nobody else can take it,
  -- and `/u/<old>` keeps resolving to the new name. A provisional name is
  -- included -- it is the address anything posted so far was filed under.
  insert into public.username_reservations (username_lower, reserved_for, reason, expires_at)
  values (v_me.username_lower, v_uid, 'previous-name', now() + interval '1 year')
  on conflict (username_lower) do update
    set reserved_for = excluded.reserved_for,
        reason       = excluded.reason,
        expires_at   = excluded.expires_at;

  return jsonb_build_object(
    'username', v_name,
    'changedAt', now(),
    'nextChangeAt', now() + interval '30 days'
  );
end;
$$;

revoke all on function public.set_username(text) from public;
revoke execute on function public.set_username(text) from anon;
grant execute on function public.set_username(text) to authenticated;

comment on function public.set_username(text) is
  'Change the caller''s username. Once per 30 days; the old name is reserved for the caller for a year. Refusals are 22023 with a sentence to show.';

-- ---------------------------------------------------------------------------
-- 10. profiles_public -- the public surface
-- ---------------------------------------------------------------------------
--
-- **The column list of this view is the security boundary.** It is deliberately
-- NOT `security_invoker`: it runs with its owner's privileges, which is what
-- lets `anon` read a sealed table through it -- and it also means RLS on
-- `profiles` does not apply to it. Nothing filters rows; the only thing that
-- keeps `ban_reason`, `is_shadowbanned`, `digest` and `unsubscribe_token` away
-- from the world is that they are not named below.
--
-- **Adding a column to this view is a privacy decision**, not a refactor. Ask
-- what it tells a stranger, and what it tells a stranger when joined against
-- everything else that is public.
--
-- What is here and why:
--
--   * `id` -- forum rows will carry `author_id`, and joining them to a name
--     needs it. Authorship is public by design on a forum, so the id correlates
--     nothing that the name does not already.
--   * `username`, `username_lower` -- the name, and the key `/u/[name]` looks up
--     by. The lower form is derivable from the name, so it adds nothing.
--   * `karma` -- public on every forum; it is the point of it.
--   * `joined_on` -- a **date**, not `created_at`. A signup to the second is a
--     correlator (against a mailing-list signup, a Discord join, a first post)
--     that a date is not.
--
-- The Supabase advisor flags any non-invoker view as `security_definer_view`.
-- For this one that is the intent; the warning is expected.

create or replace view public.profiles_public
with (security_invoker = false)
as
select
  p.id,
  p.username,
  p.username_lower,
  p.karma,
  (p.created_at at time zone 'UTC')::date as joined_on
from public.profiles p;

revoke all on public.profiles_public from anon, authenticated;
grant select on public.profiles_public to anon, authenticated;

comment on view public.profiles_public is
  'The public projection of profiles. Owner-run: the column list is the security boundary, and adding a column is a privacy decision.';

-- ---------------------------------------------------------------------------
-- 11. resolve_username -- `/u/[old]` -> `/u/[new]`
-- ---------------------------------------------------------------------------
--
-- `security definer` because it reads `username_reservations`, which is sealed.
-- It answers exactly one question -- "what is this name called now" -- and
-- returns a name, never an id, a reason or an expiry:
--
--   * a current name        -> `{username, redirect: false}` (or `true` when
--                              only the capitalisation differs, so the URL
--                              settles on one spelling)
--   * a previous name, held -> `{username: <current>, redirect: true}`
--   * anything else         -> null. A route word, a staff name, a deleted
--                              account's name and a name nobody ever had are
--                              indistinguishable.

create or replace function public.resolve_username(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lower   text := lower(btrim(coalesce(p_username, '')));
  v_current text;
begin
  if v_lower !~ '^[a-z0-9][a-z0-9_]{2,23}$' then
    return null;
  end if;

  select p.username into v_current
  from public.profiles p
  where p.username_lower = v_lower;

  if found then
    return jsonb_build_object('username', v_current, 'redirect', v_current <> btrim(p_username));
  end if;

  select p.username into v_current
  from public.username_reservations r
  join public.profiles p on p.id = r.reserved_for
  where r.username_lower = v_lower
    and r.reason = 'previous-name'
    and (r.expires_at is null or r.expires_at > now());

  if found then
    return jsonb_build_object('username', v_current, 'redirect', true);
  end if;

  return null;
end;
$$;

revoke all on function public.resolve_username(text) from public;
grant execute on function public.resolve_username(text) to anon, authenticated;

-- ===========================================================================
-- #29 -- posting gates, roles and moderators
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 12. board_moderators
-- ---------------------------------------------------------------------------
--
-- Created here, ahead of the boards it moderates, because `is_board_moderator()`
-- has to exist before the first policy that calls it. `board_id` has no foreign
-- key yet: `public.boards` arrives with the forum core (#32), and that
-- migration adds the constraint. Until then the table is empty and sealed, and
-- nothing can put a row in it but the service role.

create table if not exists public.board_moderators (
  board_id   uuid not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create index if not exists board_moderators_user_idx
  on public.board_moderators (user_id);

alter table public.board_moderators enable row level security;
revoke all on public.board_moderators from anon, authenticated;

comment on table public.board_moderators is
  'Per-board moderators. board_id gets its foreign key to public.boards in the forum core migration (#32). Sealed.';

-- ---------------------------------------------------------------------------
-- 13. is_moderator / is_board_moderator
-- ---------------------------------------------------------------------------
--
-- Roles are a column, read on every call -- **not a JWT claim**. A custom
-- access-token hook would save the lookup, but a claim is frozen until the
-- token refreshes, which is up to an hour: an emergency de-modding would not
-- take effect for an hour, which is exactly when it matters.
--
-- **Why `security definer`, when it looks like an over-privilege bug:** a
-- policy on `profiles` that calls an *invoker* function reading `profiles`
-- re-enters that same policy to evaluate the read, which calls the function
-- again, and so on -- Postgres reports it as infinite recursion. A definer
-- function reads the table as its owner, which bypasses RLS, and that is
-- precisely why it terminates. It is safe because it can only ever answer
-- about the caller: there is no argument naming whose role to check.
--
-- Policies should call these as `(select public.is_moderator())`, so the
-- planner hoists them into one InitPlan per statement rather than one call per
-- row -- the same trick `hands_owner_select` uses for `auth.uid()`.
--
-- A banned moderator is not a moderator.

create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('moderator', 'admin')
      and (p.banned_until is null or p.banned_until <= now())
  );
$$;

revoke all on function public.is_moderator() from public;
grant execute on function public.is_moderator() to anon, authenticated;

comment on function public.is_moderator() is
  'True when the caller is a site-wide moderator or admin and not banned. SECURITY DEFINER on purpose: an invoker function read from a policy on profiles would recurse forever. Takes no argument, so it can only answer about the caller.';

create or replace function public.is_board_moderator(p_board_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_moderator()
      or exists (
        select 1
        from public.board_moderators m
        join public.profiles p on p.id = m.user_id
        where m.board_id = p_board_id
          and m.user_id = (select auth.uid())
          and (p.banned_until is null or p.banned_until <= now())
      );
$$;

revoke all on function public.is_board_moderator(uuid) from public;
grant execute on function public.is_board_moderator(uuid) to anon, authenticated;

comment on function public.is_board_moderator(uuid) is
  'True when the caller moderates this board, or is a site-wide moderator. SECURITY DEFINER for the same reason as is_moderator(). Answers only about the caller.';

-- ---------------------------------------------------------------------------
-- 14. posting_block_reason
-- ---------------------------------------------------------------------------
--
-- One function that returns null when an account may post, or the sentence to
-- show it when it may not. Every create RPC the forum adds asks this and raises
-- its answer; the UI pre-flights the *same* answer through `my_profile()`. One
-- set of rules, in one place, so the form and the server cannot disagree about
-- whether a button should be there.
--
-- Checks:
--
--   * **Banned.** With the date when it is a suspension.
--   * **Email unconfirmed.** Confirmation gates the *first post*, not signup:
--     a throwaway address can still sign up and use the converter and the
--     library, but it cannot put anything in front of other people until it
--     has proved it receives mail. Gating signup instead would put the email
--     round trip between a new visitor and the tool they came for.
--   * **Under ten minutes old.** Cheap friction against a script that signs up
--     and posts in one breath.
--
-- A shadowban is deliberately **not** a reason. A shadowbanned account posts
-- as normal; its posts are simply not shown to anyone else. Telling it would
-- defeat it.
--
-- `security definer` because it reads `auth.users.email_confirmed_at`, which
-- no client role can see. **Not granted to clients** -- it takes a uid, and a
-- client that could pass any uid would have an oracle for "is this account
-- banned / unconfirmed". The client-facing door is `my_profile()`, which passes
-- `auth.uid()`.

create or replace function public.posting_block_reason(p_uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile   public.profiles%rowtype;
  v_confirmed timestamptz;
  v_created   timestamptz;
  v_minutes   integer;
begin
  if p_uid is null then
    return 'Sign in to post.';
  end if;

  select * into v_profile from public.profiles where id = p_uid;
  if not found then
    return 'Your account is still being set up. Try again in a moment.';
  end if;

  if v_profile.banned_until is not null and v_profile.banned_until > now() then
    if v_profile.banned_until = 'infinity'::timestamptz then
      return 'This account has been suspended and cannot post.';
    end if;
    return format(
      'This account is suspended until %s and cannot post until then.',
      to_char(v_profile.banned_until at time zone 'UTC', 'FMDD FMMonth YYYY, HH24:MI "UTC"')
    );
  end if;

  select u.email_confirmed_at, u.created_at
    into v_confirmed, v_created
  from auth.users u
  where u.id = p_uid;

  if v_confirmed is null then
    return 'Confirm your email address before posting. The link is in the email we sent when you signed up.';
  end if;

  v_created := coalesce(v_created, v_profile.created_at);
  if v_created > now() - interval '10 minutes' then
    v_minutes := greatest(1, ceil(extract(epoch from (v_created + interval '10 minutes' - now())) / 60)::integer);
    return format(
      'New accounts can post ten minutes after signing up. Try again in %s %s.',
      v_minutes, case when v_minutes = 1 then 'minute' else 'minutes' end
    );
  end if;

  return null;
end;
$$;

revoke all on function public.posting_block_reason(uuid) from public;
revoke execute on function public.posting_block_reason(uuid) from anon, authenticated;

comment on function public.posting_block_reason(uuid) is
  'NULL when the account may post, else the sentence to show. Asked by every create RPC; pre-flighted by the UI through my_profile(). Not granted to clients: it takes a uid.';

-- ---------------------------------------------------------------------------
-- 15. vote_weight
-- ---------------------------------------------------------------------------
--
-- What a vote from this account adds to `score`: 0 or 1.
--
-- **The arrow works and the displayed count moves; `score` does not.** A brigade
-- of fresh accounts changes nothing that ranks, and nobody is told their vote
-- "did not register" -- which is both more honest than Reddit's fuzzed counts
-- and does not need the API to lie about a number.
--
-- Zero for: an account under 24 hours old, banned, shadowbanned, or with
-- **negative** karma.
--
-- #29 said "zero karma". That is a deadlock and has been changed on purpose:
-- every account starts at zero, karma comes from weighted votes, so if zero
-- karma weighed nothing no vote would ever weigh anything and no account would
-- ever leave zero. Negative karma is the signal that survives -- an account the
-- community has already voted down. The intent behind "zero" (an aged sleeper
-- account that has never done anything) is better served by "has contributed",
-- which needs posts and comments to exist; the forum core (#32) should add it
-- here when they do.
--
-- Not granted to clients, for the same reason as `posting_block_reason`: it
-- takes a uid, and its answer reveals a shadowban.

create or replace function public.vote_weight(p_uid uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when p.created_at > now() - interval '24 hours'                  then 0
      when p.banned_until is not null and p.banned_until > now()       then 0
      when p.is_shadowbanned                                           then 0
      when p.karma < 0                                                 then 0
      else 1
    end
    from public.profiles p
    where p.id = p_uid
  ), 0)::smallint;
$$;

revoke all on function public.vote_weight(uuid) from public;
revoke execute on function public.vote_weight(uuid) from anon, authenticated;

comment on function public.vote_weight(uuid) is
  '0 or 1: what a vote from this account adds to score. 0 under 24h, banned, shadowbanned, or negative karma. Not granted to clients.';

-- ---------------------------------------------------------------------------
-- 16. my_profile -- the owner's door
-- ---------------------------------------------------------------------------
--
-- The caller's own row, as a named projection. Names its keys one at a time,
-- like `read_share`, so a column added to `profiles` later is not exposed by
-- accident. Leaves out `is_shadowbanned` (see above) and `unsubscribe_token`
-- (only ever needed inside an email).
--
-- `security definer` because `profiles` has no client grants at all -- not even
-- SELECT on the owner's own row, since a self-select policy would hand the
-- owner their shadowban flag.

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
    'nextUsernameChangeAt', case when v_p.username_changed_at is null then null
                                 else v_p.username_changed_at + interval '30 days' end,
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
  'The caller''s own profile as a named projection, plus postingBlockReason. Omits is_shadowbanned and unsubscribe_token.';

commit;
