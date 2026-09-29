-- ============================================================================
-- The forum's social layer: saves, thread subscriptions, notifications,
-- mentions, live comment counts, and the jobs that keep the counters honest.
-- ============================================================================
--
-- F9 (#38, #39).
--
-- The grant posture is F8's: no UPDATE or DELETE grant to a client role
-- anywhere. Every write here is a definer RPC; every read is either a
-- select-own policy or an invoker function over one.
-- ============================================================================

begin;

-- New top-level routes (`/notifications`, `/saved`) are names nobody may
-- register -- the rule `lib/routes.ts` states for every top-level segment.
insert into public.username_reservations (username_lower, reason)
values ('notifications', 'route'), ('saved', 'route')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 1. saved_posts -- private bookmarks
-- ---------------------------------------------------------------------------

create table if not exists public.saved_posts (
  user_id    uuid not null references auth.users (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists saved_posts_user_idx on public.saved_posts (user_id, created_at desc);

alter table public.saved_posts enable row level security;
revoke all on public.saved_posts from anon, authenticated;
grant select on public.saved_posts to authenticated;
drop policy if exists saved_posts_own_select on public.saved_posts;
create policy saved_posts_own_select on public.saved_posts for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. thread_subscriptions -- watching or muted
-- ---------------------------------------------------------------------------
--
-- `watching` hears about new comments; `muted` hears about nothing from the
-- thread, not even a direct reply or a mention -- muting a thread that has
-- turned into an argument has to actually stop it. No row means "only what is
-- addressed to me": replies to you and mentions of you.
--
-- Writing a post or a comment subscribes you, unless you already muted it.

create table if not exists public.thread_subscriptions (
  user_id    uuid not null references auth.users (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  level      text not null check (level in ('watching', 'muted')),
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists thread_subscriptions_post_idx on public.thread_subscriptions (post_id, level);

alter table public.thread_subscriptions enable row level security;
revoke all on public.thread_subscriptions from anon, authenticated;
grant select on public.thread_subscriptions to authenticated;
drop policy if exists thread_subscriptions_own_select on public.thread_subscriptions;
create policy thread_subscriptions_own_select on public.thread_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. notifications
-- ---------------------------------------------------------------------------
--
-- Select-own, so Supabase Realtime's Postgres Changes can deliver a user's own
-- inserts to them and nobody else (#39). A row names ids only; the list RPC
-- joins through the visibility policies, so a notification about a post that
-- has since been removed simply stops appearing.

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('comment_reply', 'post_reply', 'mention', 'thread')),
  actor_id   uuid references auth.users (id) on delete set null,
  post_id    uuid not null references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;
create unique index if not exists notifications_once_per_comment_uidx
  on public.notifications (user_id, comment_id) where comment_id is not null;

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
drop policy if exists notifications_own_select on public.notifications;
create policy notifications_own_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

-- Realtime: the unread badge listens for its own inserts. RLS applies to the
-- change feed, so the select-own policy above is what keeps it private.
do $pub$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
     ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$pub$;

-- ---------------------------------------------------------------------------
-- 4. Auto-watch on posting
-- ---------------------------------------------------------------------------

create or replace function public.posts_author_watch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.author_id is not null then
    insert into public.thread_subscriptions (user_id, post_id, level)
    values (new.author_id, new.id, 'watching')
    on conflict (user_id, post_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.posts_author_watch() from public;
revoke execute on function public.posts_author_watch() from anon, authenticated;

drop trigger if exists posts_author_watch on public.posts;
create trigger posts_author_watch after insert on public.posts
  for each row execute function public.posts_author_watch();

-- ---------------------------------------------------------------------------
-- 5. fan_out_comment_notifications
-- ---------------------------------------------------------------------------
--
-- Who hears about a new comment, in priority order, one row per person:
--
--   1. the author of the comment it replies to        (`comment_reply`)
--   2. the post's author, for a top-level comment      (`post_reply`)
--   3. up to FIVE `@username` mentions                 (`mention`)
--      -- uncapped, a mention is a spam broadcast primitive;
--   4. people watching the thread, up to FIFTY, most recently subscribed first
--                                                      (`thread`)
--      -- a thread with 5000 watchers must not insert 5000 rows inside the
--      request. Everyone past the cap is the digest's (#53) to pick up.
--
-- Never notified: the commenter themselves, anyone who muted the thread, and
-- -- for everything -- anyone at all when the commenter is shadowbanned. Their
-- comment is invisible to everyone else, and a notification pointing at it
-- would be both a dead link and a tell.
--
-- It also subscribes the commenter to the thread, unless they muted it.

create or replace function public.fan_out_comment_notifications(p_comment_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comment public.comments%rowtype;
  v_post    public.posts%rowtype;
  v_parent_author uuid;
  v_count   integer := 0;
  v_mention text;
  v_mentions integer := 0;
  v_target  uuid;
  r         record;
begin
  select * into v_comment from public.comments where id = p_comment_id;
  if not found or v_comment.author_id is null then
    return 0;
  end if;
  select * into v_post from public.posts where id = v_comment.post_id;

  if coalesce((select is_shadowbanned from public.profiles where id = v_comment.author_id), false) then
    return 0;
  end if;

  insert into public.thread_subscriptions (user_id, post_id, level)
  values (v_comment.author_id, v_post.id, 'watching')
  on conflict (user_id, post_id) do nothing;

  -- The recipients, collected with their reason, then inserted once each in
  -- priority order. A temp table because the four sources are four queries.
  create temporary table if not exists pg_temp.fanout (user_id uuid primary key, kind text, rank smallint) on commit drop;
  truncate pg_temp.fanout;

  if v_comment.parent_id is not null then
    select author_id into v_parent_author from public.comments where id = v_comment.parent_id;
    if v_parent_author is not null then
      insert into pg_temp.fanout values (v_parent_author, 'comment_reply', 1) on conflict do nothing;
    end if;
  elsif v_post.author_id is not null then
    insert into pg_temp.fanout values (v_post.author_id, 'post_reply', 2) on conflict do nothing;
  end if;

  for v_mention in
    select distinct lower(m[2])
    from regexp_matches(coalesce(v_comment.body, ''), '(^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9_]{2,23})', 'g') as m
  loop
    exit when v_mentions >= 5;
    select id into v_target from public.profiles where username_lower = v_mention;
    if found then
      v_mentions := v_mentions + 1;
      insert into pg_temp.fanout values (v_target, 'mention', 3) on conflict do nothing;
    end if;
  end loop;

  insert into pg_temp.fanout
  select s.user_id, 'thread', 4
  from public.thread_subscriptions s
  where s.post_id = v_post.id and s.level = 'watching'
  order by s.created_at desc
  limit 50
  on conflict do nothing;

  -- Suppressions: yourself; anyone who muted the thread; a banned account
  -- (which cannot act on it anyway).
  delete from pg_temp.fanout f
  where f.user_id = v_comment.author_id
     or exists (select 1 from public.thread_subscriptions s
                where s.user_id = f.user_id and s.post_id = v_post.id and s.level = 'muted')
     or exists (select 1 from public.profiles p
                where p.id = f.user_id and p.banned_until is not null and p.banned_until > now());

  for r in select * from pg_temp.fanout order by rank loop
    insert into public.notifications (user_id, kind, actor_id, post_id, comment_id)
    values (r.user_id, r.kind, v_comment.author_id, v_post.id, v_comment.id)
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.fan_out_comment_notifications(uuid) from public;
revoke execute on function public.fan_out_comment_notifications(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. create_comment, now with the fan-out
-- ---------------------------------------------------------------------------
--
-- Identical to `20261019090000_forum_core.sql` except for the one
-- `perform public.fan_out_comment_notifications(v_id)` near the end.

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

  perform public.enforce_rate_limit('comment:' || v_uid::text, 1, 60, interval '1 hour');

  v_seq := v_post.last_comment_seq + 1;
  v_path := coalesce(v_parent.path, '') || public.forum_path_segment(v_seq);

  insert into public.comments (post_id, parent_id, seq, path, author_id, body,
                               anchor_street, anchor_action_index, anchor_seat)
  values (v_post.id, v_parent.id, v_seq, v_path, v_uid, v_body,
          p_anchor_street, p_anchor_action, p_anchor_seat)
  returning id into v_id;

  update public.posts
     set last_comment_seq = v_seq, comment_count = comment_count + 1
   where id = v_post.id;

  insert into public.comment_votes (comment_id, user_id, value, weight)
  values (v_id, v_uid, 1, public.vote_weight(v_uid));
  perform public.forum_recount_comment(v_id);

  -- F9: who hears about it. In the RPC rather than a trigger, because the
  -- decisions -- self-suppression, mutes, the mention cap, the fan-out cap --
  -- are product rules, and a trigger is the wrong place to hide product rules.
  perform public.fan_out_comment_notifications(v_id);

  return jsonb_build_object('seq', v_seq);
end;
$$;


-- ---------------------------------------------------------------------------
-- 7. Live comment count (#39) -- Broadcast, not Postgres Changes
-- ---------------------------------------------------------------------------
--
-- Postgres Changes on a hot table evaluates RLS once per subscriber per row,
-- which is the known scaling cliff. A Broadcast from a trigger keeps RLS off
-- the fan-out path entirely, and is safe to make public because the payload is
-- a count and a sequence number -- nothing a reader of the page does not
-- already see once they reload.
--
-- Not sent for a shadowbanned author: "1 new comment" that never appears is a
-- tell.

create or replace function public.comments_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts%rowtype;
begin
  if coalesce((select is_shadowbanned from public.profiles where id = new.author_id), false) then
    return new;
  end if;
  select * into v_post from public.posts where id = new.post_id;
  begin
    perform realtime.send(
      jsonb_build_object('seq', new.seq, 'commentCount', v_post.comment_count),
      'comment',
      'post:' || v_post.public_id,
      false
    );
  exception when others then
    -- A realtime outage must never fail somebody's comment.
    null;
  end;
  return new;
end;
$$;

revoke all on function public.comments_broadcast() from public;
revoke execute on function public.comments_broadcast() from anon, authenticated;

drop trigger if exists comments_broadcast on public.comments;
create trigger comments_broadcast after insert on public.comments
  for each row execute function public.comments_broadcast();

-- ---------------------------------------------------------------------------
-- 8. RPCs
-- ---------------------------------------------------------------------------

create or replace function public.save_post(p_public_id text, p_saved boolean default true)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_post uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to save posts.' using errcode = '42501';
  end if;
  select id into v_post from public.posts
  where public_id = p_public_id and status = 'visible' and deleted_at is null
    and not public.forum_author_hidden(author_id);
  if not found then
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  if p_saved then
    perform public.enforce_rate_limit('save:' || v_uid::text, 1, 300, interval '1 hour');
    insert into public.saved_posts (user_id, post_id) values (v_uid, v_post) on conflict do nothing;
  else
    delete from public.saved_posts where user_id = v_uid and post_id = v_post;
  end if;
  return p_saved;
end;
$$;

-- p_level: 'watching', 'muted', or null to go back to "only what is addressed to me".
create or replace function public.set_thread_subscription(p_public_id text, p_level text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_post uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to follow threads.' using errcode = '42501';
  end if;
  if p_level is not null and p_level not in ('watching', 'muted') then
    raise exception 'Unknown subscription level.' using errcode = '22023';
  end if;
  select id into v_post from public.posts
  where public_id = p_public_id and status = 'visible' and deleted_at is null
    and not public.forum_author_hidden(author_id);
  if not found then
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  if p_level is null then
    delete from public.thread_subscriptions where user_id = v_uid and post_id = v_post;
  else
    insert into public.thread_subscriptions (user_id, post_id, level) values (v_uid, v_post, p_level)
    on conflict (user_id, post_id) do update set level = excluded.level;
  end if;
  return p_level;
end;
$$;

-- Where the caller stands on one post: saved? subscription level?
create or replace function public.my_post_state(p_public_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'saved', exists (select 1 from public.saved_posts s where s.post_id = p.id),
    'subscription', (select t.level from public.thread_subscriptions t where t.post_id = p.id)
  )
  from public.posts p
  where p.public_id = p_public_id;
$$;

create or replace function public.my_saved_posts(p_limit integer default 25, p_before timestamptz default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.forum_post_json(p) || jsonb_build_object('savedAt', s.created_at)
                            order by s.created_at desc), '[]'::jsonb)
  from (
    select * from public.saved_posts
    where (p_before is null or created_at < p_before)
    order by created_at desc
    limit least(greatest(coalesce(p_limit, 25), 1), 50)
  ) s
  join public.posts p on p.id = s.post_id;
$$;

create or replace function public.my_notifications(p_limit integer default 30, p_before bigint default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'unread', (select count(*) from public.notifications where read_at is null),
    'items', coalesce(jsonb_agg(jsonb_build_object(
        'id', n.id,
        'kind', n.kind,
        'createdAt', n.created_at,
        'read', n.read_at is not null,
        'actor', (select jsonb_build_object('username', a.username) from public.profiles_public a where a.id = n.actor_id),
        'post', jsonb_build_object('publicId', p.public_id, 'slug', p.slug, 'title', p.title,
                                   'board', (select b.slug from public.boards b where b.id = p.board_id)),
        'seq', c.seq,
        'excerpt', left(c.body, 160)
      ) order by n.id desc), '[]'::jsonb)
  )
  from (
    select * from public.notifications
    where (p_before is null or id < p_before)
    order by id desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) n
  join public.posts p on p.id = n.post_id
  left join public.comments c on c.id = n.comment_id;
$$;

create or replace function public.unread_notification_count()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer from public.notifications where read_at is null;
$$;

-- p_ids null marks everything read.
create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where user_id = v_uid and read_at is null
     and (p_ids is null or id = any (p_ids[1:500]));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.save_post(text, boolean), public.set_thread_subscription(text, text),
  public.my_post_state(text), public.my_saved_posts(integer, timestamptz),
  public.my_notifications(integer, bigint), public.unread_notification_count(),
  public.mark_notifications_read(bigint[])
from public;
revoke execute on function public.save_post(text, boolean), public.set_thread_subscription(text, text),
  public.my_post_state(text), public.my_saved_posts(integer, timestamptz),
  public.my_notifications(integer, bigint), public.unread_notification_count(),
  public.mark_notifications_read(bigint[])
from anon;
grant execute on function public.save_post(text, boolean), public.set_thread_subscription(text, text),
  public.my_post_state(text), public.my_saved_posts(integer, timestamptz),
  public.my_notifications(integer, bigint), public.unread_notification_count(),
  public.mark_notifications_read(bigint[])
to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Reconciliation and sweeping -- service role, nightly
-- ---------------------------------------------------------------------------
--
-- Every counter is recounted on every write, so these should find nothing.
-- They exist so that a lost transaction is a temporarily wrong number, never a
-- permanently wrong one. Idempotent.

create or replace function public.recount_forum_counters()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_posts integer;
  v_comments integer;
begin
  with v as (
    select p.id,
           count(pv.*) filter (where pv.value = 1)::integer  as up,
           count(pv.*) filter (where pv.value = -1)::integer as down,
           coalesce(sum(pv.value * pv.weight), 0)::integer   as score,
           (select count(*) from public.comments c
             where c.post_id = p.id and c.deleted_at is null and c.status = 'visible')::integer as comments
    from public.posts p left join public.post_votes pv on pv.post_id = p.id
    group by p.id
  )
  update public.posts p
     set upvotes = v.up, downvotes = v.down, score = v.score, comment_count = v.comments
    from v
   where p.id = v.id
     and (p.upvotes, p.downvotes, p.score, p.comment_count) is distinct from (v.up, v.down, v.score, v.comments);
  get diagnostics v_posts = row_count;

  with v as (
    select c.id,
           count(cv.*) filter (where cv.value = 1)::integer  as up,
           count(cv.*) filter (where cv.value = -1)::integer as down,
           coalesce(sum(cv.value * cv.weight), 0)::integer   as score
    from public.comments c left join public.comment_votes cv on cv.comment_id = c.id
    group by c.id
  )
  update public.comments c
     set upvotes = v.up, downvotes = v.down, score = v.score
    from v
   where c.id = v.id
     and (c.upvotes, c.downvotes, c.score) is distinct from (v.up, v.down, v.score);
  get diagnostics v_comments = row_count;

  return jsonb_build_object('postsFixed', v_posts, 'commentsFixed', v_comments);
end;
$$;

create or replace function public.recount_forum_karma()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select distinct author_id as id from public.posts where author_id is not null
    union
    select distinct author_id from public.comments where author_id is not null
  loop
    perform public.forum_recount_karma(r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Rate-limit windows are at most a day. Per-actor buckets ('comment:<uid>')
-- mean one row per account per bucket kind, forever, unless something sweeps.
create or replace function public.sweep_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.ingest_rate_limit where window_start < now() - interval '2 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.recount_forum_counters(), public.recount_forum_karma(), public.sweep_rate_limits() from public;
revoke execute on function public.recount_forum_counters(), public.recount_forum_karma(), public.sweep_rate_limits()
  from anon, authenticated;

-- pg_cron, where it can be had. Guarded: a stack without the extension (or
-- without the right to create it) still gets every function above, and the
-- jobs can be scheduled by hand later.
do $cron$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); schedule recount_forum_counters, recount_forum_karma and sweep_rate_limits by hand', sqlerrm;
    return;
  end;
  perform cron.unschedule(jobid) from cron.job where jobname in ('forum-recount', 'rate-limit-sweep');
  perform cron.schedule('forum-recount', '17 3 * * *',
    'select public.recount_forum_counters(); select public.recount_forum_karma();');
  perform cron.schedule('rate-limit-sweep', '7 * * * *', 'select public.sweep_rate_limits();');
end;
$cron$;

commit;
