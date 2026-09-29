-- ============================================================================
-- Moderation (#40) and anti-abuse (#41).
-- ============================================================================
--
-- F10. The forum has been public since F8; this is the part that makes that
-- survivable.
--
-- The shape of every power below is the F8 one: a `security definer` function
-- that takes the actor from `auth.uid()`, checks the actor's standing
-- explicitly, writes a whitelisted set of columns, and writes a
-- `moderation_actions` row in the same transaction. Nothing here adds an
-- UPDATE or DELETE grant.
--
-- **Mutation is allowed, and it is never invisible**: `moderation_actions` is
-- append-only (a trigger refuses UPDATE and DELETE even for the service role),
-- and edits keep a public revision.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Spam status and fingerprints
-- ---------------------------------------------------------------------------

alter table public.posts drop constraint if exists posts_status_ok;
alter table public.posts add constraint posts_status_ok check (status in ('visible', 'removed', 'spam'));
alter table public.comments drop constraint if exists comments_status_ok;
alter table public.comments add constraint comments_status_ok check (status in ('visible', 'removed', 'spam'));

-- sha-256 of the whitespace-normalised, lower-cased body.
--
-- Declared IMMUTABLE although `convert_to` is only STABLE: its result depends
-- on the database encoding, which is fixed when the database is created (UTF8
-- here) and cannot change afterwards, so for this database the function is a
-- pure function of its argument -- which is what a generated column needs.
create or replace function public.forum_fingerprint(p_body text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(btrim(p_body), '') = '' then null
    else encode(sha256(convert_to(lower(regexp_replace(btrim(p_body), '\s+', ' ', 'g')), 'UTF8')), 'hex') end;
$$;

alter table public.posts add column if not exists body_fingerprint text
  generated always as (public.forum_fingerprint(body)) stored;
alter table public.comments add column if not exists body_fingerprint text
  generated always as (public.forum_fingerprint(body)) stored;

create index if not exists posts_author_fingerprint_idx on public.posts (author_id, body_fingerprint, created_at desc)
  where body_fingerprint is not null;
create index if not exists comments_author_fingerprint_idx on public.comments (author_id, body_fingerprint, created_at desc)
  where body_fingerprint is not null;
create index if not exists posts_spam_idx on public.posts (created_at desc) where status = 'spam';
create index if not exists comments_spam_idx on public.comments (created_at desc) where status = 'spam';

-- 'visible' or 'spam', for a new post or comment.
--
-- Spam is **created, not rejected**: a false positive costs a moderator one
-- click, and a rejection would teach a spammer exactly where the threshold is.
-- The author sees their content as normal (the visibility policy shows it to
-- them); everyone else does not see it until a moderator lets it through.
--
--   * more than two links from an account under 50 karma;
--   * the same body the author already posted in the last seven days;
--   * a near-copy (trigram similarity > 0.9) of one of their last ten.
create or replace function public.forum_spam_verdict(p_uid uuid, p_kind text, p_body text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_karma integer := coalesce((select karma from public.profiles where id = p_uid), 0);
  v_links integer := (select count(*) from regexp_matches(coalesce(p_body, ''), 'https?://', 'g'));
  v_fp    text := public.forum_fingerprint(p_body);
begin
  if v_links > 2 and v_karma < 50 then
    return 'spam';
  end if;
  if v_fp is null or char_length(p_body) < 40 then
    return 'visible';
  end if;
  if p_kind = 'post' then
    if exists (select 1 from public.posts
               where author_id = p_uid and body_fingerprint = v_fp and created_at > now() - interval '7 days') then
      return 'spam';
    end if;
    if exists (select 1 from (select body from public.posts where author_id = p_uid
                              order by created_at desc limit 10) recent
               where extensions.similarity(recent.body, p_body) > 0.9) then
      return 'spam';
    end if;
  else
    if exists (select 1 from public.comments
               where author_id = p_uid and body_fingerprint = v_fp and created_at > now() - interval '7 days') then
      return 'spam';
    end if;
    if exists (select 1 from (select body from public.comments where author_id = p_uid and body is not null
                              order by created_at desc limit 10) recent
               where extensions.similarity(recent.body, p_body) > 0.9) then
      return 'spam';
    end if;
  end if;
  return 'visible';
end;
$$;

revoke all on function public.forum_fingerprint(text), public.forum_spam_verdict(uuid, text, text) from public;
revoke execute on function public.forum_spam_verdict(uuid, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Who may moderate what
-- ---------------------------------------------------------------------------

-- Site moderators everywhere; a board's own moderators on that board.
create or replace function public.can_moderate_board(p_board_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_moderator() or public.is_board_moderator(p_board_id);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.role = 'admin'
                   and (p.banned_until is null or p.banned_until <= now()));
$$;

-- For the UI: whether to show the moderator tools on this post. Answers only
-- about the caller; the tools themselves re-check on every call.
create or replace function public.can_moderate_post(p_public_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select public.can_moderate_board(p.board_id) from public.posts p where p.public_id = p_public_id), false);
$$;

revoke all on function public.can_moderate_board(uuid), public.is_admin(), public.can_moderate_post(text) from public;
grant execute on function public.can_moderate_board(uuid), public.is_admin(), public.can_moderate_post(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The one visibility rule, stated once
-- ---------------------------------------------------------------------------
--
-- A removed, deleted, spam or shadow-hidden post is visible to its author and
-- to the people who moderate its board, and to nobody else -- **in the
-- database**. There is no query the app could write that returns it to a
-- stranger, and no forgotten `.eq('status', 'visible')` that could leak it.
--
-- The author seeing their own removed content is deliberate: for a shadowban
-- and for spam that is the whole mechanism (their posts look fine from their
-- own account), and for a removal it is simply fair.

drop policy if exists posts_visible_select on public.posts;
drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select to anon, authenticated
  using (
        (status = 'visible' and deleted_at is null and not public.forum_author_hidden(author_id))
     or author_id = (select auth.uid())
     -- `(select …)` so the site-moderator check is one InitPlan per statement,
     -- not a function call per row; the board check has to be per row.
     or (select public.is_moderator())
     or public.is_board_moderator(board_id)
  );

-- Comments keep their tombstones visible (a removed or deleted comment has no
-- body, see mod_set_comment_status), so replies stay attached. What is hidden
-- is spam and a shadowbanned author's words -- from everyone but that author
-- and the board's moderators.
drop policy if exists comments_visible_select on public.comments;
drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to anon, authenticated
  using (
    exists (select 1 from public.posts p where p.id = comments.post_id)
    and (
          (status <> 'spam' and not public.forum_author_hidden(author_id))
       or author_id = (select auth.uid())
       or (select public.is_moderator())
       or public.is_board_moderator((select p.board_id from public.posts p where p.id = comments.post_id))
    )
  );

-- "Removed" versus "never existed", for a post the caller cannot see. A post
-- that is spam or shadow-hidden is "not-found" to anyone who cannot see it:
-- that it exists at all is the tell.
create or replace function public.post_status(p_public_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p.deleted_at is not null then 'deleted'
              when p.status = 'removed' then 'removed'
              when p.status = 'spam' then null
              when public.forum_author_hidden(p.author_id) then null
              else 'visible' end
  from public.posts p where p.public_id = p_public_id;
$$;

-- Boards are audited targets too now.
alter table public.moderation_actions drop constraint if exists moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in ('post', 'comment', 'profile', 'published_hand', 'board'));

-- ---------------------------------------------------------------------------
-- 3. moderation_actions is append-only
-- ---------------------------------------------------------------------------
--
-- The one UPDATE allowed is the foreign-key action that nulls `actor_id` when
-- an account is deleted -- the row stays, the name goes.

create or replace function public.moderation_actions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.actor_id is null
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
    return new;
  end if;
  raise exception 'moderation_actions is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists moderation_actions_append_only on public.moderation_actions;
create trigger moderation_actions_append_only before update or delete on public.moderation_actions
  for each row execute function public.moderation_actions_append_only();

-- ---------------------------------------------------------------------------
-- 4. content_revisions -- public edit history
-- ---------------------------------------------------------------------------
--
-- On a poker forum "he rewrote the story of the hand after the results came
-- in" is a real thing, and a verifiable diff is worth more than an "edited"
-- badge. Written by a trigger on every change of title or body, so no edit
-- path -- the author's or a moderator's -- can skip it. Removals and
-- deletions (body -> null) are not edits and do not publish the old words.

create table if not exists public.content_revisions (
  id          bigint generated always as identity primary key,
  target_type text not null check (target_type in ('post', 'comment')),
  post_id     uuid not null references public.posts (id) on delete cascade,
  comment_id  uuid references public.comments (id) on delete cascade,
  title       text,
  body        text,
  edited_by   uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists content_revisions_target_idx on public.content_revisions (post_id, comment_id, created_at desc);

alter table public.content_revisions enable row level security;
revoke all on public.content_revisions from anon, authenticated;
grant select on public.content_revisions to anon, authenticated;
drop policy if exists content_revisions_read on public.content_revisions;
-- Readable exactly while the thing it is a revision of is readable and alive.
create policy content_revisions_read on public.content_revisions for select to anon, authenticated
  using (
    case when comment_id is null
      then exists (select 1 from public.posts p where p.id = content_revisions.post_id
                    and p.status = 'visible' and p.deleted_at is null)
      else exists (select 1 from public.comments c where c.id = content_revisions.comment_id
                    and c.status = 'visible' and c.deleted_at is null and c.body is not null)
    end
  );

create or replace function public.posts_keep_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.title is distinct from old.title or new.body is distinct from old.body) then
    insert into public.content_revisions (target_type, post_id, title, body, edited_by)
    values ('post', old.id, old.title, old.body, (select auth.uid()));
  end if;
  return new;
end;
$$;

create or replace function public.comments_keep_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.body is not null and old.body is not null and new.body is distinct from old.body then
    insert into public.content_revisions (target_type, post_id, comment_id, body, edited_by)
    values ('comment', old.post_id, old.id, old.body, (select auth.uid()));
  end if;
  return new;
end;
$$;

revoke all on function public.posts_keep_revision(), public.comments_keep_revision() from public;
revoke execute on function public.posts_keep_revision(), public.comments_keep_revision() from anon, authenticated;

drop trigger if exists posts_keep_revision on public.posts;
create trigger posts_keep_revision before update of title, body on public.posts
  for each row execute function public.posts_keep_revision();
drop trigger if exists comments_keep_revision on public.comments;
create trigger comments_keep_revision before update of body on public.comments
  for each row execute function public.comments_keep_revision();

create or replace function public.get_revisions(p_post_public_id text, p_seq integer default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'body', r.body, 'createdAt', r.created_at)
                            order by r.created_at desc, r.id desc), '[]'::jsonb)
  from public.content_revisions r
  join public.posts p on p.id = r.post_id
  left join public.comments c on c.id = r.comment_id
  where p.public_id = p_post_public_id
    and ((p_seq is null and r.comment_id is null) or c.seq = p_seq);
$$;

revoke all on function public.get_revisions(text, integer) from public;
grant execute on function public.get_revisions(text, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. reports
-- ---------------------------------------------------------------------------
--
-- `hh-takedown` (#31): a poker room -- or a player -- asking for a hand to come
-- down gets a path that is not a lawyer, with a documented 48-hour response
-- (see /takedown).

create table if not exists public.reports (
  id           bigint generated always as identity primary key,
  reporter_id  uuid references auth.users (id) on delete set null,
  subject_type text not null check (subject_type in ('post', 'comment', 'published_hand', 'profile')),
  subject_id   uuid not null,
  reason       text not null check (reason in ('spam', 'harassment', 'cheating', 'off-topic', 'hh-takedown', 'other')),
  details      text check (details is null or char_length(details) <= 1000),
  status       text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  resolved_by  uuid references auth.users (id) on delete set null,
  resolved_at  timestamptz,
  resolution   text check (resolution is null or char_length(resolution) <= 1000),
  created_at   timestamptz not null default now()
);

-- A second report of the same thing by the same person is a no-op, not a row.
create unique index if not exists reports_once_uidx on public.reports (reporter_id, subject_type, subject_id);
create index if not exists reports_open_idx on public.reports (created_at) where status = 'open';

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

create or replace function public.report_content(
  p_subject_type text,
  p_public_id    text default null,
  p_seq          integer default null,
  p_username     text default null,
  p_reason       text default 'other',
  p_details      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_id   uuid;
  v_new  bigint;
begin
  if v_uid is null then
    raise exception 'Sign in to report something.' using errcode = '42501';
  end if;
  if p_reason not in ('spam', 'harassment', 'cheating', 'off-topic', 'hh-takedown', 'other') then
    raise exception 'Unknown report reason.' using errcode = '22023';
  end if;

  if p_subject_type = 'post' then
    select id into v_id from public.posts
    where public_id = p_public_id and status = 'visible' and deleted_at is null;
  elsif p_subject_type = 'comment' then
    select c.id into v_id from public.comments c join public.posts p on p.id = c.post_id
    where p.public_id = p_public_id and c.seq = p_seq and c.body is not null;
  elsif p_subject_type = 'published_hand' then
    select id into v_id from public.published_hands
    where public_id = p_public_id and status = 'visible' and deleted_at is null;
  elsif p_subject_type = 'profile' then
    select id into v_id from public.profiles where username_lower = lower(p_username);
  end if;
  if v_id is null then
    raise exception 'There is nothing there to report.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('report:' || v_uid::text, 1, 20, interval '1 day');
  perform public.enforce_rate_limit('report:*', 1, 2000, interval '1 day');

  insert into public.reports (reporter_id, subject_type, subject_id, reason, details)
  values (v_uid, p_subject_type, v_id, p_reason, nullif(left(btrim(coalesce(p_details, '')), 1000), ''))
  on conflict (reporter_id, subject_type, subject_id) do nothing
  returning id into v_new;

  return jsonb_build_object('reported', true, 'alreadyReported', v_new is null);
end;
$$;

revoke all on function public.report_content(text, text, integer, text, text, text) from public;
revoke execute on function public.report_content(text, text, integer, text, text, text) from anon;
grant execute on function public.report_content(text, text, integer, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Moderator powers
-- ---------------------------------------------------------------------------
--
-- Moderator: remove / restore, lock, pin, edit a title (audited, revision
-- kept), ban for up to 30 days, shadowban. Board moderators: the content
-- powers, on their board only. Admin: roles, boards, bans over 30 days,
-- permanent bans, hard purge.
--
-- Bans keep read access -- a ban is `posting_block_reason`, nothing else --
-- which is kinder, signals less, and gives less reason to evade.

create or replace function public.mod_post_for_update(p_public_id text)
returns public.posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  select * into v_post from public.posts where public_id = p_public_id for update;
  if not found or not public.can_moderate_board(v_post.board_id) then
    -- The same answer for "no such post" and "not yours to moderate".
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  return v_post;
end;
$$;

-- p_status: 'visible' (restore / approve), 'removed'.
create or replace function public.mod_set_post_status(p_public_id text, p_status text, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
begin
  if p_status not in ('visible', 'removed') then
    raise exception 'A post is visible or removed.' using errcode = '22023';
  end if;
  v_post := public.mod_post_for_update(p_public_id);
  if v_post.status = p_status then
    return p_status;
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
  values ((select auth.uid()), 'post.' || case when p_status = 'visible' then
            case when v_post.status = 'spam' then 'approve' else 'restore' end else 'remove' end,
          'post', v_post.id, v_post.author_id, p_reason, jsonb_build_object('from', v_post.status));
  update public.posts set status = p_status where id = v_post.id;
  if v_post.author_id is not null then
    perform public.forum_recount_karma(v_post.author_id);
  end if;
  return p_status;
end;
$$;

-- A removed comment becomes a tombstone like a deleted one: its body leaves
-- the public row (into the audit, where a restore finds it). Spam keeps its
-- body, because spam is hidden by the policy and a moderator has to read it.
create or replace function public.mod_set_comment_status(p_post_public_id text, p_seq integer, p_status text, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post    public.posts;
  v_comment public.comments%rowtype;
  v_body    text;
begin
  if p_status not in ('visible', 'removed') then
    raise exception 'A comment is visible or removed.' using errcode = '22023';
  end if;
  v_post := public.mod_post_for_update(p_post_public_id);
  select * into v_comment from public.comments where post_id = v_post.id and seq = p_seq for update;
  if not found or v_comment.deleted_at is not null then
    raise exception 'That comment does not exist.' using errcode = '22023';
  end if;
  if v_comment.status = p_status then
    return p_status;
  end if;

  if p_status = 'removed' then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
    values ((select auth.uid()), 'comment.remove', 'comment', v_comment.id, v_comment.author_id, p_reason,
            jsonb_build_object('from', v_comment.status, 'body', v_comment.body));
    update public.comments set status = 'removed', body = null where id = v_comment.id;
    if v_comment.status = 'visible' then
      update public.posts set comment_count = greatest(comment_count - 1, 0) where id = v_post.id;
    end if;
  else
    v_body := coalesce(v_comment.body, (
      select details ->> 'body' from public.moderation_actions
      where target_type = 'comment' and target_id = v_comment.id and action = 'comment.remove'
      order by id desc limit 1));
    insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
    values ((select auth.uid()), case when v_comment.status = 'spam' then 'comment.approve' else 'comment.restore' end,
            'comment', v_comment.id, v_comment.author_id, p_reason, jsonb_build_object('from', v_comment.status));
    update public.comments set status = 'visible', body = v_body where id = v_comment.id;
    update public.posts set comment_count = comment_count + 1 where id = v_post.id;
    if v_comment.status = 'spam' then
      perform public.fan_out_comment_notifications(v_comment.id);
    end if;
  end if;
  if v_comment.author_id is not null then
    perform public.forum_recount_karma(v_comment.author_id);
  end if;
  return p_status;
end;
$$;

create or replace function public.mod_set_post_flags(p_public_id text, p_locked boolean default null, p_pinned boolean default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
begin
  v_post := public.mod_post_for_update(p_public_id);
  if p_locked is not null and p_locked <> v_post.is_locked then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason)
    values ((select auth.uid()), case when p_locked then 'post.lock' else 'post.unlock' end, 'post', v_post.id, v_post.author_id, p_reason);
    update public.posts set is_locked = p_locked where id = v_post.id;
  end if;
  if p_pinned is not null and p_pinned <> v_post.is_pinned then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason)
    values ((select auth.uid()), case when p_pinned then 'post.pin' else 'post.unpin' end, 'post', v_post.id, v_post.author_id, p_reason);
    update public.posts set is_pinned = p_pinned where id = v_post.id;
  end if;
  return (select jsonb_build_object('isLocked', is_locked, 'isPinned', is_pinned) from public.posts where id = v_post.id);
end;
$$;

create or replace function public.mod_edit_post_title(p_public_id text, p_title text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post  public.posts;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if char_length(v_title) < 3 or char_length(v_title) > 300 then
    raise exception 'Titles are 3 to 300 characters.' using errcode = '22023';
  end if;
  v_post := public.mod_post_for_update(p_public_id);
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
  values ((select auth.uid()), 'post.edit_title', 'post', v_post.id, v_post.author_id, p_reason,
          jsonb_build_object('title', v_post.title));
  update public.posts set title = v_title, edited_at = now() where id = v_post.id;
  return jsonb_build_object('slug', public.forum_slugify(v_title));
end;
$$;

-- p_days null means permanent, which only an admin may do; a moderator is
-- capped at thirty. Nobody bans themselves, and only an admin bans staff.
create or replace function public.mod_ban(p_username text, p_days integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_target public.profiles%rowtype;
  v_until  timestamptz;
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can ban.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A ban needs a reason.' using errcode = '22023';
  end if;
  select * into v_target from public.profiles where username_lower = lower(btrim(coalesce(p_username, ''))) for update;
  if not found then
    raise exception 'No one goes by that name.' using errcode = '22023';
  end if;
  if v_target.id = v_uid then
    raise exception 'You cannot ban yourself.' using errcode = '22023';
  end if;
  if v_target.role <> 'member' and not public.is_admin() then
    raise exception 'Only an admin can ban a moderator.' using errcode = '42501';
  end if;
  if p_days is null or p_days > 30 then
    if not public.is_admin() then
      raise exception 'Moderators can ban for up to 30 days.' using errcode = '42501';
    end if;
  end if;
  if p_days is not null and p_days < 1 then
    raise exception 'A ban is at least one day.' using errcode = '22023';
  end if;
  v_until := case when p_days is null then 'infinity'::timestamptz else now() + make_interval(days => p_days) end;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
  values (v_uid, 'profile.ban', 'profile', v_target.id, v_target.id, p_reason,
          jsonb_build_object('until', v_until, 'previous', v_target.banned_until));
  update public.profiles set banned_until = v_until, ban_reason = left(p_reason, 500) where id = v_target.id;
  return jsonb_build_object('bannedUntil', v_until);
end;
$$;

create or replace function public.mod_unban(p_username text, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can lift a ban.' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where username_lower = lower(btrim(coalesce(p_username, ''))) for update;
  if not found then
    raise exception 'No one goes by that name.' using errcode = '22023';
  end if;
  if v_target.banned_until = 'infinity'::timestamptz and not public.is_admin() then
    raise exception 'Only an admin can lift a permanent ban.' using errcode = '42501';
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
  values ((select auth.uid()), 'profile.unban', 'profile', v_target.id, v_target.id, p_reason,
          jsonb_build_object('previous', v_target.banned_until));
  update public.profiles set banned_until = null, ban_reason = null where id = v_target.id;
  return true;
end;
$$;

create or replace function public.mod_shadowban(p_username text, p_on boolean, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can shadowban.' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where username_lower = lower(btrim(coalesce(p_username, ''))) for update;
  if not found then
    raise exception 'No one goes by that name.' using errcode = '22023';
  end if;
  if v_target.role <> 'member' and not public.is_admin() then
    raise exception 'Only an admin can shadowban a moderator.' using errcode = '42501';
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason)
  values ((select auth.uid()), case when p_on then 'profile.shadowban' else 'profile.unshadowban' end,
          'profile', v_target.id, v_target.id, p_reason);
  update public.profiles set is_shadowbanned = p_on where id = v_target.id;
  return p_on;
end;
$$;

-- What a moderator needs to decide about an account. Moderator-only: this is
-- the one place is_shadowbanned and ban_reason leave the profiles table.
create or replace function public.mod_user(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.profiles%rowtype;
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can see this.' using errcode = '42501';
  end if;
  select * into v from public.profiles where username_lower = lower(btrim(coalesce(p_username, '')));
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'username', v.username, 'role', v.role, 'karma', v.karma,
    'joinedOn', (v.created_at at time zone 'UTC')::date,
    'bannedUntil', v.banned_until, 'banReason', v.ban_reason, 'isShadowbanned', v.is_shadowbanned,
    'posts', (select count(*) from public.posts where author_id = v.id),
    'comments', (select count(*) from public.comments where author_id = v.id),
    'reportsAgainst', (select count(*) from public.reports r where r.subject_id = v.id
                        or r.subject_id in (select id from public.posts where author_id = v.id)
                        or r.subject_id in (select id from public.comments where author_id = v.id)),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('action', a.action, 'reason', a.reason, 'createdAt', a.created_at)
                                          order by a.id desc), '[]'::jsonb)
                from (select * from public.moderation_actions where subject_id = v.id order by id desc limit 20) a)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The queue
-- ---------------------------------------------------------------------------

create or replace function public.mod_queue(p_status text default 'open', p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() and not exists (select 1 from public.board_moderators where user_id = (select auth.uid())) then
    raise exception 'Only moderators can see the queue.' using errcode = '42501';
  end if;
  return (
    with r as (
      select * from public.reports
      where status = coalesce(p_status, 'open')
      order by created_at
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ),
    shaped as (
      select r.*,
             case r.subject_type
               when 'post' then (select jsonb_build_object('publicId', p.public_id, 'slug', p.slug, 'title', p.title,
                                   'board', b.slug, 'boardId', p.board_id, 'status', p.status, 'excerpt', left(p.body, 200),
                                   'author', (select username from public.profiles where id = p.author_id))
                                 from public.posts p join public.boards b on b.id = p.board_id where p.id = r.subject_id)
               when 'comment' then (select jsonb_build_object('publicId', p.public_id, 'slug', p.slug, 'title', p.title,
                                   'board', b.slug, 'boardId', p.board_id, 'seq', c.seq, 'status', c.status,
                                   'excerpt', left(c.body, 200),
                                   'author', (select username from public.profiles where id = c.author_id))
                                 from public.comments c join public.posts p on p.id = c.post_id
                                 join public.boards b on b.id = p.board_id where c.id = r.subject_id)
               when 'published_hand' then (select jsonb_build_object('publicId', h.public_id, 'title', h.title, 'status', h.status,
                                   'author', (select username from public.profiles where id = h.author_id))
                                 from public.published_hands h where h.id = r.subject_id)
               else (select jsonb_build_object('username', username) from public.profiles where id = r.subject_id)
             end as subject
      from r
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', s.id, 'subjectType', s.subject_type, 'reason', s.reason, 'details', s.details,
             'status', s.status, 'createdAt', s.created_at, 'subject', s.subject,
             'reporter', (select username from public.profiles where id = s.reporter_id)
           ) order by s.created_at), '[]'::jsonb)
    from shaped s
    -- A board moderator sees their boards' reports; a site moderator all.
    where public.is_moderator()
       or (s.subject ? 'boardId' and public.is_board_moderator((s.subject ->> 'boardId')::uuid))
  );
end;
$$;

create or replace function public.mod_spam_queue(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can see the spam queue.' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(x order by x ->> 'createdAt' desc), '[]'::jsonb) from (
      select jsonb_build_object('type', 'post', 'publicId', p.public_id, 'slug', p.slug, 'board', b.slug,
                                'title', p.title, 'excerpt', left(p.body, 300), 'createdAt', p.created_at,
                                'author', (select username from public.profiles where id = p.author_id)) x
      from public.posts p join public.boards b on b.id = p.board_id where p.status = 'spam'
      union all
      select jsonb_build_object('type', 'comment', 'publicId', p.public_id, 'slug', p.slug, 'board', b.slug,
                                'seq', c.seq, 'title', p.title, 'excerpt', left(c.body, 300), 'createdAt', c.created_at,
                                'author', (select username from public.profiles where id = c.author_id))
      from public.comments c join public.posts p on p.id = c.post_id join public.boards b on b.id = p.board_id
      where c.status = 'spam'
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) q
  );
end;
$$;

create or replace function public.mod_resolve_report(p_id bigint, p_status text, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.reports%rowtype;
  v_board  uuid;
begin
  if p_status not in ('actioned', 'dismissed') then
    raise exception 'A report is actioned or dismissed.' using errcode = '22023';
  end if;
  select * into v_report from public.reports where id = p_id for update;
  if not found then
    raise exception 'That report does not exist.' using errcode = '22023';
  end if;
  v_board := case v_report.subject_type
    when 'post' then (select board_id from public.posts where id = v_report.subject_id)
    when 'comment' then (select p.board_id from public.comments c join public.posts p on p.id = c.post_id where c.id = v_report.subject_id)
  end;
  if not (public.is_moderator() or (v_board is not null and public.is_board_moderator(v_board))) then
    raise exception 'That report does not exist.' using errcode = '22023';
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, reason, details)
  values ((select auth.uid()), 'report.' || p_status,
          case when v_report.subject_type = 'published_hand' then 'published_hand' else v_report.subject_type end,
          v_report.subject_id, p_note, jsonb_build_object('reportId', v_report.id, 'reason', v_report.reason));
  update public.reports
     set status = p_status, resolved_by = (select auth.uid()), resolved_at = now(), resolution = left(p_note, 1000)
   where id = p_id;
  return true;
end;
$$;

-- A published hand taken down (hh-takedown, or anything else).
create or replace function public.mod_set_published_hand_status(p_public_id text, p_status text, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hand public.published_hands%rowtype;
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can do that.' using errcode = '42501';
  end if;
  if p_status not in ('visible', 'removed') then
    raise exception 'A published hand is visible or removed.' using errcode = '22023';
  end if;
  select * into v_hand from public.published_hands where public_id = p_public_id for update;
  if not found then
    raise exception 'That hand does not exist.' using errcode = '22023';
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason)
  values ((select auth.uid()), 'published_hand.' || case when p_status = 'visible' then 'restore' else 'remove' end,
          'published_hand', v_hand.id, v_hand.author_id, p_reason);
  update public.published_hands set status = p_status where id = v_hand.id;
  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Admin powers
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_role(p_username text, p_role public.profile_role, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change roles.' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where username_lower = lower(btrim(coalesce(p_username, ''))) for update;
  if not found then
    raise exception 'No one goes by that name.' using errcode = '22023';
  end if;
  if v_target.id = (select auth.uid()) and p_role <> 'admin' then
    raise exception 'An admin cannot demote themselves; ask another admin.' using errcode = '22023';
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason, details)
  values ((select auth.uid()), 'profile.role', 'profile', v_target.id, v_target.id, p_reason,
          jsonb_build_object('from', v_target.role, 'to', p_role));
  update public.profiles set role = p_role where id = v_target.id;
  return p_role::text;
end;
$$;

create or replace function public.admin_create_board(p_slug text, p_name text, p_description text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can create boards.' using errcode = '42501';
  end if;
  insert into public.boards (slug, name, description)
  values (lower(btrim(p_slug)), btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_id;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'board.create', 'board', v_id, jsonb_build_object('slug', p_slug, 'name', p_name));
  return lower(btrim(p_slug));
exception when unique_violation then
  raise exception 'A board with that address already exists.' using errcode = '22023';
end;
$$;

create or replace function public.admin_set_board_moderator(p_board text, p_username text, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_board uuid;
  v_user  uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can appoint board moderators.' using errcode = '42501';
  end if;
  select id into v_board from public.boards where slug = lower(p_board);
  select id into v_user from public.profiles where username_lower = lower(btrim(coalesce(p_username, '')));
  if v_board is null or v_user is null then
    raise exception 'Unknown board or user.' using errcode = '22023';
  end if;
  if p_on then
    insert into public.board_moderators (board_id, user_id, granted_by) values (v_board, v_user, (select auth.uid()))
    on conflict do nothing;
  else
    delete from public.board_moderators where board_id = v_board and user_id = v_user;
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, details)
  values ((select auth.uid()), case when p_on then 'board.mod_grant' else 'board.mod_revoke' end,
          'profile', v_user, v_user, jsonb_build_object('board', p_board));
  return p_on;
end;
$$;

-- Hard delete. For the content that must not exist at all (illegal material,
-- doxxing): a removal only hides. The audit row survives the content.
create or replace function public.admin_purge(p_type text, p_public_id text, p_seq integer default null, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can purge.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A purge needs a reason.' using errcode = '22023';
  end if;
  if p_type = 'post' then
    select id into v_id from public.posts where public_id = p_public_id;
    if v_id is null then return false; end if;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, reason)
    values ((select auth.uid()), 'post.purge', 'post', v_id, p_reason);
    delete from public.posts where id = v_id;
  elsif p_type = 'comment' then
    select c.id into v_id from public.comments c join public.posts p on p.id = c.post_id
    where p.public_id = p_public_id and c.seq = p_seq;
    if v_id is null then return false; end if;
    insert into public.moderation_actions (actor_id, action, target_type, target_id, reason)
    values ((select auth.uid()), 'comment.purge', 'comment', v_id, p_reason);
    delete from public.comments where id = v_id;
  else
    raise exception 'Purge a post or a comment.' using errcode = '22023';
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Vote overlap (#41) -- a signal, never an action
-- ---------------------------------------------------------------------------
--
-- Pairs of accounts that keep voting the same way on the same posts. It never
-- acts on its own: two friends who read the same board look exactly like this.

create or replace view public.mod_vote_overlap as
select a.user_id as user_a, b.user_id as user_b,
       count(*) as shared_votes,
       count(*) filter (where a.value = b.value) as same_direction
from public.post_votes a
join public.post_votes b on b.post_id = a.post_id and b.user_id > a.user_id
group by a.user_id, b.user_id
having count(*) >= 5;

revoke all on public.mod_vote_overlap from anon, authenticated;

create or replace function public.mod_vote_overlap_for(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if not public.is_moderator() then
    raise exception 'Only moderators can see this.' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where username_lower = lower(btrim(coalesce(p_username, '')));
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'with', (select username from public.profiles where id = case when o.user_a = v_user then o.user_b else o.user_a end),
             'sharedVotes', o.shared_votes, 'sameDirection', o.same_direction) order by o.shared_votes desc), '[]'::jsonb)
    from public.mod_vote_overlap o
    where o.user_a = v_user or o.user_b = v_user
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------

revoke all on function
  public.mod_post_for_update(text),
  public.mod_set_post_status(text, text, text),
  public.mod_set_comment_status(text, integer, text, text),
  public.mod_set_post_flags(text, boolean, boolean, text),
  public.mod_edit_post_title(text, text, text),
  public.mod_ban(text, integer, text),
  public.mod_unban(text, text),
  public.mod_shadowban(text, boolean, text),
  public.mod_user(text),
  public.mod_queue(text, integer),
  public.mod_spam_queue(integer),
  public.mod_resolve_report(bigint, text, text),
  public.mod_set_published_hand_status(text, text, text),
  public.admin_set_role(text, public.profile_role, text),
  public.admin_create_board(text, text, text),
  public.admin_set_board_moderator(text, text, boolean),
  public.admin_purge(text, text, integer, text),
  public.mod_vote_overlap_for(text)
from public;

revoke execute on function public.mod_post_for_update(text) from anon, authenticated;

revoke execute on function
  public.mod_set_post_status(text, text, text),
  public.mod_set_comment_status(text, integer, text, text),
  public.mod_set_post_flags(text, boolean, boolean, text),
  public.mod_edit_post_title(text, text, text),
  public.mod_ban(text, integer, text),
  public.mod_unban(text, text),
  public.mod_shadowban(text, boolean, text),
  public.mod_user(text),
  public.mod_queue(text, integer),
  public.mod_spam_queue(integer),
  public.mod_resolve_report(bigint, text, text),
  public.mod_set_published_hand_status(text, text, text),
  public.admin_set_role(text, public.profile_role, text),
  public.admin_create_board(text, text, text),
  public.admin_set_board_moderator(text, text, boolean),
  public.admin_purge(text, text, integer, text),
  public.mod_vote_overlap_for(text)
from anon;

grant execute on function
  public.mod_set_post_status(text, text, text),
  public.mod_set_comment_status(text, integer, text, text),
  public.mod_set_post_flags(text, boolean, boolean, text),
  public.mod_edit_post_title(text, text, text),
  public.mod_ban(text, integer, text),
  public.mod_unban(text, text),
  public.mod_shadowban(text, boolean, text),
  public.mod_user(text),
  public.mod_queue(text, integer),
  public.mod_spam_queue(integer),
  public.mod_resolve_report(bigint, text, text),
  public.mod_set_published_hand_status(text, text, text),
  public.admin_set_role(text, public.profile_role, text),
  public.admin_create_board(text, text, text),
  public.admin_set_board_moderator(text, text, boolean),
  public.admin_purge(text, text, integer, text),
  public.mod_vote_overlap_for(text)
to authenticated;

insert into public.username_reservations (username_lower, reason)
values ('takedown', 'route'), ('legal', 'route')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 11. The write RPCs, with per-actor + global limits and the spam gate (#41)
-- ---------------------------------------------------------------------------
--
-- Each is its latest definition (F7 / F8 / F9) with only its rate-limit lines
-- replaced by the #41 table -- and, for posts and comments, the spam verdict.
--
-- | Action  | Per account   | Global        |
-- | Post    | 5 / hour      | 500 / hour    |
-- | Comment | 30 / 10 min   | 5000 / 10 min |
-- | Vote    | 200 / hour    | 50000 / hour  | + 400 / hour on one subject
-- | Publish | 20 / day      | 500 / day     |
-- | Report  | 20 / day      | 2000 / day    |

create or replace function public.create_post(
  p_board          text,
  p_title          text,
  p_body           text default '',
  p_published_hand text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_block     text;
  v_board     public.boards%rowtype;
  v_title     text := btrim(coalesce(p_title, ''));
  v_body      text := btrim(coalesce(p_body, ''));
  v_hand_id   uuid;
  v_public_id text;
  v_post      uuid;
  v_attempt   integer := 0;
  v_status    text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to post.' using errcode = '42501';
  end if;
  v_block := public.posting_block_reason(v_uid);
  if v_block is not null then
    raise exception '%', v_block using errcode = '22023';
  end if;

  select * into v_board from public.boards where slug = lower(btrim(coalesce(p_board, '')));
  if not found then
    raise exception 'That board does not exist.' using errcode = '22023';
  end if;
  if v_board.is_locked then
    raise exception 'This board is closed to new posts.' using errcode = '22023';
  end if;
  if char_length(v_title) < 3 or char_length(v_title) > 300 then
    raise exception 'Titles are 3 to 300 characters.' using errcode = '22023';
  end if;
  if char_length(v_body) > 40000 then
    raise exception 'Posts are at most 40,000 characters.' using errcode = '22023';
  end if;

  -- A hand post discusses one of the caller's own published hands. Somebody
  -- else's published hand is public, but starting a thread "as" its author is
  -- not something a stranger gets to do.
  if p_published_hand is not null then
    select h.id into v_hand_id
    from public.published_hands h
    where h.public_id = p_published_hand and h.author_id = v_uid
      and h.status = 'visible' and h.deleted_at is null;
    if not found then
      raise exception 'That published hand does not exist.' using errcode = '22023';
    end if;
  elsif v_body = '' then
    raise exception 'Say something, or attach a hand.' using errcode = '22023';
  end if;

  -- #41: per-actor and global, so one scripted account cannot spend
  -- everybody's budget and the limiter never reads as an outage.
  perform public.enforce_rate_limit('post:' || v_uid::text, 1, 5, interval '1 hour');
  perform public.enforce_rate_limit('post:*', 1, 500, interval '1 hour');

  v_status := public.forum_spam_verdict(v_uid, 'post', v_body);

  loop
    v_attempt := v_attempt + 1;
    v_public_id := public.generate_share_slug(8);
    begin
      insert into public.posts (public_id, board_id, author_id, kind, published_hand_id, title, body, status)
      values (v_public_id, v_board.id, v_uid, case when v_hand_id is null then 'text' else 'hand' end,
              v_hand_id, v_title, v_body, v_status)
      returning id into v_post;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then raise; end if;
    end;
  end loop;

  -- The author's implicit upvote, weighed like any other.
  insert into public.post_votes (post_id, user_id, value, weight)
  values (v_post, v_uid, 1, public.vote_weight(v_uid));
  perform public.forum_recount_post(v_post);

  if v_status = 'spam' then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason)
    values (null, 'post.auto_spam', 'post', v_post, v_uid, 'spam gate: links or duplicate');
  end if;

  return jsonb_build_object('publicId', v_public_id, 'board', v_board.slug, 'slug', public.forum_slugify(v_title));
end;
$$;

create or replace function public.create_comment(
  p_post_public_id text,
  p_body           text,
  p_parent_seq     integer default null,
  p_anchor_action  integer default null,
  p_anchor_street  text default null,
  p_anchor_seat    integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_block  text;
  v_post   public.posts%rowtype;
  v_parent public.comments%rowtype;
  v_body   text := btrim(coalesce(p_body, ''));
  v_seq    integer;
  v_path   text;
  v_id     uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to comment.' using errcode = '42501';
  end if;
  v_block := public.posting_block_reason(v_uid);
  if v_block is not null then
    raise exception '%', v_block using errcode = '22023';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 10000 then
    raise exception 'Comments are 1 to 10,000 characters.' using errcode = '22023';
  end if;

  -- One row lock on the post serialises the sequence allocation -- the same
  -- lock that makes comment_count exact, taken once for both.
  select * into v_post from public.posts
  where public_id = p_post_public_id and status = 'visible' and deleted_at is null
    and not public.forum_author_hidden(author_id)
  for update;
  if not found then
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  if v_post.is_locked then
    raise exception 'This thread is locked.' using errcode = '22023';
  end if;

  if p_parent_seq is not null then
    select * into v_parent from public.comments where post_id = v_post.id and seq = p_parent_seq;
    if not found then
      raise exception 'The comment you are replying to does not exist.' using errcode = '22023';
    end if;
    if v_parent.depth >= 10 then
      raise exception 'This thread is as deep as it goes. Reply further up.' using errcode = '22023';
    end if;
  end if;

  if p_anchor_street is not null and p_anchor_street not in ('preflop', 'flop', 'turn', 'river', 'showdown') then
    raise exception 'Unknown street.' using errcode = '22023';
  end if;
  if v_post.kind <> 'hand' and (p_anchor_action is not null or p_anchor_street is not null or p_anchor_seat is not null) then
    raise exception 'Only a hand post has moments to comment on.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('comment:' || v_uid::text, 1, 30, interval '10 minutes');
  perform public.enforce_rate_limit('comment:*', 1, 5000, interval '10 minutes');

  v_status := public.forum_spam_verdict(v_uid, 'comment', v_body);

  v_seq := v_post.last_comment_seq + 1;
  v_path := coalesce(v_parent.path, '') || public.forum_path_segment(v_seq);

  insert into public.comments (post_id, parent_id, seq, path, author_id, body,
                               anchor_street, anchor_action_index, anchor_seat, status)
  values (v_post.id, v_parent.id, v_seq, v_path, v_uid, v_body,
          p_anchor_street, p_anchor_action, p_anchor_seat, v_status)
  returning id into v_id;

  -- A comment held as spam takes its sequence number (the path needs it) but
  -- is not counted until a moderator lets it through.
  update public.posts
     set last_comment_seq = v_seq,
         comment_count = comment_count + case when v_status = 'visible' then 1 else 0 end
   where id = v_post.id;

  insert into public.comment_votes (comment_id, user_id, value, weight)
  values (v_id, v_uid, 1, public.vote_weight(v_uid));
  perform public.forum_recount_comment(v_id);

  -- F9: who hears about it. In the RPC rather than a trigger, because the
  -- decisions -- self-suppression, mutes, the mention cap, the fan-out cap --
  -- are product rules, and a trigger is the wrong place to hide product rules.
  if v_status = 'spam' then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, reason)
    values (null, 'comment.auto_spam', 'comment', v_id, v_uid, 'spam gate: links or duplicate');
  else
    perform public.fan_out_comment_notifications(v_id);
  end if;

  return jsonb_build_object('seq', v_seq);
end;
$$;

create or replace function public.vote_post(p_public_id text, p_value integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_post public.posts%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to vote.' using errcode = '42501';
  end if;
  if p_value is null or p_value not in (-1, 0, 1) then
    raise exception 'A vote is 1, -1 or 0.' using errcode = '22023';
  end if;
  -- Read through the visibility rule: you cannot vote on what you cannot see.
  select * into v_post from public.posts
  where public_id = p_public_id and status = 'visible' and deleted_at is null
    and not public.forum_author_hidden(author_id)
  for update;
  if not found then
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  if v_post.is_locked then
    raise exception 'This thread is locked.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('vote:' || v_uid::text, 1, 200, interval '1 hour');
  perform public.enforce_rate_limit('vote:*', 1, 50000, interval '1 hour');
  -- The bucket that actually catches a brigade: keyed on the SUBJECT, because
  -- a brigade is many accounts voting once each, which no per-account limit
  -- can see.
  perform public.enforce_rate_limit('vote-subject:' || v_post.id::text, 1, 400, interval '1 hour');

  if p_value = 0 then
    delete from public.post_votes where post_id = v_post.id and user_id = v_uid;
  else
    insert into public.post_votes (post_id, user_id, value, weight)
    values (v_post.id, v_uid, p_value, public.vote_weight(v_uid))
    on conflict (post_id, user_id) do update set value = excluded.value, weight = excluded.weight;
  end if;

  perform public.forum_recount_post(v_post.id);
  if v_post.author_id is not null then
    perform public.forum_recount_karma(v_post.author_id);
  end if;

  return (select jsonb_build_object('upvotes', upvotes, 'downvotes', downvotes, 'score', score, 'myVote', p_value)
          from public.posts where id = v_post.id);
end;
$$;

create or replace function public.vote_comment(p_post_public_id text, p_seq integer, p_value integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_comment public.comments%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to vote.' using errcode = '42501';
  end if;
  if p_value is null or p_value not in (-1, 0, 1) then
    raise exception 'A vote is 1, -1 or 0.' using errcode = '22023';
  end if;
  select c.* into v_comment
  from public.comments c join public.posts p on p.id = c.post_id
  where p.public_id = p_post_public_id and c.seq = p_seq
    and p.status = 'visible' and p.deleted_at is null and not p.is_locked
    and c.status = 'visible' and c.deleted_at is null
    and not public.forum_author_hidden(c.author_id) and not public.forum_author_hidden(p.author_id)
  for update of c;
  if not found then
    raise exception 'That comment does not exist.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('vote:' || v_uid::text, 1, 200, interval '1 hour');
  perform public.enforce_rate_limit('vote:*', 1, 50000, interval '1 hour');
  perform public.enforce_rate_limit('vote-subject:' || v_comment.id::text, 1, 400, interval '1 hour');

  if p_value = 0 then
    delete from public.comment_votes where comment_id = v_comment.id and user_id = v_uid;
  else
    insert into public.comment_votes (comment_id, user_id, value, weight)
    values (v_comment.id, v_uid, p_value, public.vote_weight(v_uid))
    on conflict (comment_id, user_id) do update set value = excluded.value, weight = excluded.weight;
  end if;
  perform public.forum_recount_comment(v_comment.id);
  if v_comment.author_id is not null then
    perform public.forum_recount_karma(v_comment.author_id);
  end if;

  return (select jsonb_build_object('upvotes', upvotes, 'downvotes', downvotes, 'score', score, 'myVote', p_value)
          from public.comments where id = v_comment.id);
end;
$$;

create or replace function public.publish_hand(
  p_hand_id uuid,
  p_mode    public.publish_mode default 'pseudonyms',
  p_title   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_block     text;
  v_hand      public.hands%rowtype;
  v_existing  text;
  v_doc       jsonb;
  v_doc_text  text;
  v_title     text := nullif(btrim(coalesce(p_title, '')), '');
  v_public_id text;
  v_id        uuid;
  v_attempt   integer := 0;
  r           record;
begin
  if v_uid is null then
    raise exception 'You must be signed in to publish a hand.' using errcode = '42501';
  end if;

  v_block := public.posting_block_reason(v_uid);
  if v_block is not null then
    raise exception '%', v_block using errcode = '22023';
  end if;

  select * into v_hand from public.hands h where h.id = p_hand_id and h.owner_id = v_uid;
  if not found then
    raise exception 'That hand does not exist.' using errcode = '22023';
  end if;

  if exists (select 1 from public.publish_blocked_sites b where b.site = lower(v_hand.site)) then
    raise exception 'Hands from this poker room cannot be published.' using errcode = '22023';
  end if;

  if v_title is not null and char_length(v_title) > 140 then
    raise exception 'Titles are at most 140 characters.' using errcode = '22023';
  end if;

  -- Idempotent: the same hand, published again, is the same publication.
  select p.public_id into v_existing
  from public.published_hand_sources s
  join public.published_hands p on p.id = s.published_id
  where s.author_id = v_uid and s.hand_id = v_hand.id
    and p.deleted_at is null;
  if found then
    return jsonb_build_object('publicId', v_existing, 'alreadyPublished', true);
  end if;

  v_doc := public.scrub_phf(v_hand.phf, p_mode);
  if v_doc is null or not public.phf_is_scrubbed(v_doc) then
    raise exception 'This hand could not be prepared for publishing.' using errcode = '22023';
  end if;

  -- The leak assertion. See the function header.
  if p_mode <> 'as-imported' and v_hand.site_anonymization <> 'positional' then
    -- Every string value in the document, decoded -- not `v_doc::text`, where
    -- a name containing a quote or a backslash would be JSON-escaped and the
    -- search would sail past it.
    select string_agg(v #>> '{}', E'\n') into v_doc_text
    from jsonb_path_query(v_doc, 'strict $.** ? (@.type() == "string")') as v;
    v_doc_text := coalesce(v_doc_text, '');
    for r in
      select p ->> 'name' as name
      from jsonb_array_elements(coalesce(v_hand.phf -> 'players', '[]'::jsonb)) p
    loop
      if r.name is null or r.name in ('Hero') or r.name ~ '^(Villain|Seat)[0-9]+(_[0-9]+)?$' then
        continue;
      end if;
      if v_doc_text ~ ('(^|[^[:alnum:]_])'
                       || regexp_replace(r.name, '([\\.^$|()\[\]{}*+?-])', '\\\1', 'g')
                       || '($|[^[:alnum:]_])') then
        raise exception 'This hand could not be anonymised safely, so it was not published. Nothing was made public.'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  perform public.enforce_rate_limit('publish:' || v_uid::text, 1, 20, interval '1 day');
  perform public.enforce_rate_limit('publish:*', 1, 500, interval '1 day');

  loop
    v_attempt := v_attempt + 1;
    v_public_id := public.generate_share_slug(10);
    begin
      insert into public.published_hands (
        public_id, author_id, mode, title, phf,
        site, variant, limit_type, game_format, currency, currency_minor_units, currency_symbol,
        small_blind, big_blind, ante, stakes_label, max_seats, player_count, fast_fold,
        site_anonymization, hero_position, hero_cards, hero_hand_class, board_cards,
        street_reached, went_to_showdown, total_pot, hero_profit, played_on
      ) values (
        v_public_id, v_uid, p_mode, v_title, v_doc,
        v_hand.site, v_hand.variant, v_hand.limit_type, v_hand.game_format, v_hand.currency,
        v_hand.currency_minor_units, v_hand.currency_symbol,
        v_hand.small_blind, v_hand.big_blind, v_hand.ante, v_hand.stakes_label, v_hand.max_seats,
        v_hand.player_count, v_hand.fast_fold,
        v_hand.site_anonymization, v_hand.hero_position, v_hand.hero_cards, v_hand.hero_hand_class,
        v_hand.board_cards, v_hand.street_reached, v_hand.went_to_showdown, v_hand.total_pot,
        v_hand.hero_profit, (v_hand.played_at at time zone 'UTC')::date
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.published_hand_sources (published_id, author_id, hand_id)
  values (v_id, v_uid, v_hand.id);

  return jsonb_build_object('publicId', v_public_id, 'alreadyPublished', false);
end;
$$;

commit;
