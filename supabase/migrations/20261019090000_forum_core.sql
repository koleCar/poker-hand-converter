-- ============================================================================
-- The forum: boards, posts, threaded comments, votes, ranking, search.
-- ============================================================================
--
-- F8 (#32, #33, #34, #37).
--
-- ## Rule 5, rewritten rather than deleted
--
-- `docs/DATABASE.md` rule 5 said nobody may update or delete anything. It was
-- written for an app with no identity and no mutable content; a forum needs
-- edits, deletes and changed votes. The two wrong answers are "keep the rule"
-- (no forum) and "add UPDATE policies" (throw the property away).
--
-- **The grant posture stays exactly as it is: no UPDATE or DELETE grant to
-- `anon` or `authenticated`, on any table, ever.** Every mutation is a narrow
-- `security definer` function that
--
--   * takes the actor from `auth.uid()`, never from an argument;
--   * checks ownership explicitly (definer bypasses RLS, so nothing else will);
--   * writes a whitelisted set of columns -- a caller cannot name a column;
--   * writes a `moderation_actions` row in the same transaction for every edit
--     and delete, self-edits included;
--   * passes through `enforce_rate_limit`.
--
-- Why this beats an UPDATE policy: a policy lets the caller set every column
-- they hold a grant on -- `score`, `hot_rank`, `is_locked`, `author_id` -- and
-- its `with check` has to be amended every time a column is added. **A definer
-- function fails closed when a column is added; a policy fails open.**
--
-- ## Deletes are soft, and account deletion anonymises
--
-- A deleted comment with replies becomes a tombstone so the thread's shape
-- survives. A deleted account sets `author_id` to null rather than cascading,
-- or an active thread would vanish from under the people who replied in it.
--
-- ## Reads go through RLS
--
-- The feed, a post, its comments and search are `security invoker`, so the
-- visibility policies do the removed / deleted / shadowban filtering once, and
-- no read path re-implements a rule a policy already states. That is also why
-- search is not a materialized view: a matview is owner-run and would leak
-- removed content unless every predicate were copied into its refresh.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

-- A title as a URL slug. Not identifying and not unique: `/f/nlhe/<id>/<slug>`
-- is keyed on the id, and a stale slug 301s to the current one, so editing a
-- title keeps every old link alive.
create or replace function public.forum_slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(left(btrim(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'), '-'), 80), ''), 'post');
$$;

-- Reddit "hot": log of the net score plus linear time. Not exponential decay,
-- for two reasons: the first ten votes move a post as much as the next ninety
-- (on a small forum that is the difference between visible and buried), and
-- **the relative order of two posts never changes as they age** -- so the value
-- can live in a generated column and nothing ever has to rewrite rows on a
-- schedule, which matters when there is no UPDATE grant to rewrite them with.
--
-- **The trap:** `extract(epoch from <timestamptz>)` is only STABLE (it depends
-- on the session time zone), which would make this function non-immutable and
-- the generated column illegal. Converting `at time zone 'UTC'` first yields a
-- `timestamp`, whose epoch is IMMUTABLE. If somebody "simplifies" the cast away,
-- this is the first thing that fails at apply time.
create or replace function public.forum_hot_rank(p_score integer, p_created_at timestamptz)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select sign(p_score)::double precision * log(greatest(abs(p_score), 1)::numeric)::double precision
         + (extract(epoch from (p_created_at at time zone 'UTC')) - 1735689600)::double precision / 45000;
$$;

-- Wilson score lower bound (95%) on up / (up + down): "best" for comments,
-- where a 5/0 comment should beat a 50/40 one.
create or replace function public.forum_best_rank(p_up integer, p_down integer)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p_up, 0) + coalesce(p_down, 0) = 0 then 0
    else (
      (p_up::double precision / (p_up + p_down)) + 1.9208 / (p_up + p_down)
      - 1.96 * sqrt((p_up::double precision * p_down) / (p_up + p_down) + 0.9604) / (p_up + p_down)
    ) / (1 + 3.8416 / (p_up + p_down))
  end;
$$;

-- Many votes, evenly split.
create or replace function public.forum_controversy(p_up integer, p_down integer)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p_up, 0) <= 0 or coalesce(p_down, 0) <= 0 then 0
    else power((p_up + p_down)::double precision,
               least(p_up, p_down)::double precision / greatest(p_up, p_down))
  end;
$$;

-- Six base-36 characters per level of a comment path, from the per-post
-- sequence. Fixed width is what makes `order by path` depth-first and
-- `path like <ancestor> || '%'` the whole subtree on a plain btree.
create or replace function public.forum_path_segment(p_seq integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n   bigint := p_seq;
  v_out text := '';
begin
  if p_seq is null or p_seq < 1 or p_seq > 2176782335 then
    raise exception 'comment sequence out of range';
  end if;
  while v_n > 0 loop
    v_out := substr('0123456789abcdefghijklmnopqrstuvwxyz', (v_n % 36)::integer + 1, 1) || v_out;
    v_n := v_n / 36;
  end loop;
  return lpad(v_out, 6, '0');
end;
$$;

-- Shadowbanned authors are invisible to everyone but themselves. A definer
-- helper because `profiles` is sealed; one primary-key lookup per call.
create or replace function public.forum_author_hidden(p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_author is not null
     and p_author is distinct from (select auth.uid())
     and coalesce((select pr.is_shadowbanned from public.profiles pr where pr.id = p_author), false);
$$;

revoke all on function public.forum_author_hidden(uuid) from public;
grant execute on function public.forum_author_hidden(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. boards
-- ---------------------------------------------------------------------------

create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null constraint boards_slug_ok check (slug ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name        text not null constraint boards_name_len check (char_length(name) between 2 and 60),
  description text constraint boards_description_len check (description is null or char_length(description) <= 500),
  sort_order  smallint not null default 100,
  is_locked   boolean not null default false,
  created_at  timestamptz not null default now()
);

create unique index if not exists boards_slug_uidx on public.boards (slug);

insert into public.boards (slug, name, description, sort_order) values
  ('nlhe', 'No-Limit Hold''em', 'Cash-game hands and strategy for no-limit Hold''em.', 10),
  ('mtt', 'Tournaments', 'MTT, sit-and-go and spin hands: ICM, bubbles, final tables.', 20),
  ('plo', 'Omaha', 'PLO, PLO5, PLO6 and hi/lo.', 30),
  ('general', 'General', 'Everything else about poker: study, bankroll, the game itself.', 90)
on conflict (slug) do nothing;

-- board_moderators was created ahead of this table by the identity migration;
-- its foreign key arrives now.
do $fk$
begin
  if not exists (select 1 from pg_constraint where conname = 'board_moderators_board_fk') then
    alter table public.board_moderators
      add constraint board_moderators_board_fk foreign key (board_id) references public.boards (id) on delete cascade;
  end if;
end;
$fk$;

alter table public.boards enable row level security;
revoke all on public.boards from anon, authenticated;
grant select on public.boards to anon, authenticated;
drop policy if exists boards_public_select on public.boards;
create policy boards_public_select on public.boards for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. posts
-- ---------------------------------------------------------------------------

create table if not exists public.posts (
  id        uuid primary key default gen_random_uuid(),
  -- `/f/<board>/<public_id>/<slug>`. From the share alphabet, server-side.
  public_id text not null constraint posts_public_id_ok check (public_id ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  board_id  uuid not null references public.boards (id),
  author_id uuid references auth.users (id) on delete set null,
  kind      text not null constraint posts_kind_ok check (kind in ('hand', 'text')),
  -- A hand post discusses a *published* hand -- the scrubbed copy. Never a row
  -- of `hands`: those are private.
  published_hand_id uuid references public.published_hands (id) on delete set null,
  title text not null constraint posts_title_len check (char_length(btrim(title)) between 3 and 300),
  -- Plain text. Rendered escaped, paragraphs by blank line; there is no HTML
  -- path from a post body to a page.
  body  text not null default '' constraint posts_body_len check (char_length(body) <= 40000),
  slug  text generated always as (public.forum_slugify(title)) stored,

  status      text not null default 'visible' constraint posts_status_ok check (status in ('visible', 'removed')),
  deleted_at  timestamptz,
  edited_at   timestamptz,
  is_locked   boolean not null default false,
  is_pinned   boolean not null default false,

  -- Counters, recomputed from the vote rows on every vote (never a delta), so
  -- they cannot drift. `score` is the WEIGHTED sum and is deliberately not tied
  -- to upvotes - downvotes by a CHECK: that divergence is the anti-brigading
  -- mechanism (see vote_weight()).
  upvotes          integer not null default 0 check (upvotes >= 0),
  downvotes        integer not null default 0 check (downvotes >= 0),
  score            integer not null default 0,
  comment_count    integer not null default 0 check (comment_count >= 0),
  -- Comment sequence allocator. Taken under the post's row lock.
  last_comment_seq integer not null default 0 check (last_comment_seq >= 0),

  created_at timestamptz not null default now(),

  -- Generated, so a client cannot forge a rank and it cannot drift from its
  -- inputs, and nothing needs an UPDATE grant to maintain it.
  hot_rank   double precision generated always as (public.forum_hot_rank(score, created_at)) stored,
  controversy double precision generated always as (public.forum_controversy(upvotes, downvotes)) stored,

  -- Search. A `regconfig` column rather than text: `to_tsvector(regconfig, text)`
  -- is IMMUTABLE and can back a generated column, `text::regconfig` is only
  -- STABLE and cannot -- which is what makes Croatian a data change later.
  lang       regconfig not null default 'english',
  search_tsv tsvector generated always as (
    setweight(to_tsvector(lang, coalesce(title, '')), 'A') || setweight(to_tsvector(lang, coalesce(body, '')), 'B')
  ) stored,

  -- A text post never points at a hand. A hand post does at creation, and may
  -- lose it later if the author unpublishes the hand -- the thread survives.
  constraint posts_hand_kind check (kind = 'hand' or published_hand_id is null)
);

create unique index if not exists posts_public_id_uidx on public.posts (public_id);

-- Every feed index is partial on the visibility predicate, so feed queries
-- must repeat `status = 'visible' and deleted_at is null` verbatim.
create index if not exists posts_board_hot_idx on public.posts (board_id, hot_rank desc, id)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_board_new_idx on public.posts (board_id, created_at desc, id)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_board_top_idx on public.posts (board_id, score desc, id)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_hot_idx on public.posts (hot_rank desc, id)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_new_idx on public.posts (created_at desc, id)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_top_idx on public.posts (score desc, id)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_author_idx on public.posts (author_id, created_at desc)
  where status = 'visible' and deleted_at is null;
create index if not exists posts_search_idx on public.posts using gin (search_tsv);
create index if not exists posts_published_hand_idx on public.posts (published_hand_id) where published_hand_id is not null;

-- ---------------------------------------------------------------------------
-- 3. comments
-- ---------------------------------------------------------------------------
--
-- Adjacency list (`parent_id`) plus a fixed-width materialized path. Not
-- `ltree`: it lives in `extensions`, and with `search_path = ''` on every
-- function its operators would have to be spelled `OPERATOR(extensions.<@)`
-- in every body and policy -- the footgun `extensions.gin_trgm_ops` already
-- demonstrated once. Not a closure table (O(depth) rows and a second write per
-- insert, to buy joins the prefix index already serves). Not nested sets
-- (every insert rewrites half the table, which under "no UPDATE grant" and
-- under concurrency is disqualifying).

create table if not exists public.comments (
  id        uuid primary key default gen_random_uuid(),
  post_id   uuid not null references public.posts (id) on delete cascade,
  parent_id uuid references public.comments (id) on delete cascade,
  -- Per-post, from posts.last_comment_seq. What permalinks use (`#c-<seq>`);
  -- the uuid never appears in a URL.
  seq       integer not null check (seq >= 1),
  path      text not null constraint comments_path_ok check (path ~ '^([0-9a-z]{6}){1,10}$'),
  depth     smallint generated always as ((char_length(path) / 6)::smallint) stored,
  author_id uuid references auth.users (id) on delete set null,
  -- Null once deleted or removed: a tombstone keeps its place in the tree and
  -- loses its words. The original goes into moderation_actions.
  body      text constraint comments_body_len check (body is null or char_length(body) between 1 and 10000),

  -- #34: a moment in the replayer. The action is `PhfAction.index`, the same
  -- stable key `?t=a<n>` uses (see components/replayer/position.ts for why it
  -- is never a frame index). The street is kept alongside for display and
  -- grouping; the seat is who the comment is about, when that is one player.
  anchor_street       text constraint comments_anchor_street_ok
    check (anchor_street is null or anchor_street in ('preflop', 'flop', 'turn', 'river', 'showdown')),
  anchor_action_index integer constraint comments_anchor_action_ok
    check (anchor_action_index is null or anchor_action_index between 0 and 10000),
  anchor_seat         smallint constraint comments_anchor_seat_ok
    check (anchor_seat is null or anchor_seat between 1 and 24),

  status     text not null default 'visible' constraint comments_status_ok check (status in ('visible', 'removed')),
  deleted_at timestamptz,
  edited_at  timestamptz,
  upvotes    integer not null default 0 check (upvotes >= 0),
  downvotes  integer not null default 0 check (downvotes >= 0),
  score      integer not null default 0,
  created_at timestamptz not null default now(),
  best_rank  double precision generated always as (public.forum_best_rank(upvotes, downvotes)) stored,

  lang       regconfig not null default 'english',
  search_tsv tsvector generated always as (to_tsvector(lang, coalesce(body, ''))) stored,

  constraint comments_seq_uidx unique (post_id, seq),
  constraint comments_path_uidx unique (post_id, path)
);

create index if not exists comments_tree_idx on public.comments (post_id, path text_pattern_ops);
create index if not exists comments_author_idx on public.comments (author_id, created_at desc)
  where status = 'visible' and deleted_at is null;
create index if not exists comments_search_idx on public.comments using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- 4. votes
-- ---------------------------------------------------------------------------
--
-- `weight` is captured at vote time from `vote_weight()`. The arrow always
-- works and the displayed up/down counts always move; only `score` -- which is
-- what ranks -- weighs the vote.

create table if not exists public.post_votes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  value      smallint not null check (value in (-1, 1)),
  weight     smallint not null check (weight between 0 and 1),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.comment_votes (
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  value      smallint not null check (value in (-1, 1)),
  weight     smallint not null check (weight between 0 and 1),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index if not exists post_votes_user_idx on public.post_votes (user_id);
create index if not exists comment_votes_user_idx on public.comment_votes (user_id);

-- ---------------------------------------------------------------------------
-- 5. moderation_actions -- the audit trail
-- ---------------------------------------------------------------------------
--
-- One row per edit, delete or moderator action, written in the same
-- transaction as the change. The previous title / body goes in `details`,
-- which is how a deleted comment's words survive for a moderator while the
-- public row becomes a tombstone. Sealed; the mod queue (F10) reads it.

create table if not exists public.moderation_actions (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users (id) on delete set null,
  action      text not null check (char_length(action) between 3 and 64),
  target_type text not null check (target_type in ('post', 'comment', 'profile', 'published_hand')),
  target_id   uuid not null,
  subject_id  uuid,
  reason      text check (reason is null or char_length(reason) <= 1000),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists moderation_actions_target_idx on public.moderation_actions (target_type, target_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. RLS, grants, visibility
-- ---------------------------------------------------------------------------

alter table public.posts              enable row level security;
alter table public.comments           enable row level security;
alter table public.post_votes         enable row level security;
alter table public.comment_votes      enable row level security;
alter table public.moderation_actions enable row level security;

revoke all on public.posts, public.comments, public.post_votes, public.comment_votes, public.moderation_actions
  from anon, authenticated;

grant select on public.posts, public.comments to anon, authenticated;

-- A post is visible while it is not removed or deleted, and its author is not
-- shadowbanned -- except to that author, who sees their own as normal.
drop policy if exists posts_visible_select on public.posts;
create policy posts_visible_select on public.posts for select to anon, authenticated
  using (status = 'visible' and deleted_at is null and not public.forum_author_hidden(author_id));

-- Comments stay visible as tombstones (their body is null), so a deleted
-- parent keeps its replies attached. A shadowbanned author's comments are
-- hidden from everyone else, and a comment on a post you cannot see is not
-- visible either.
drop policy if exists comments_visible_select on public.comments;
create policy comments_visible_select on public.comments for select to anon, authenticated
  using (
    not public.forum_author_hidden(author_id)
    and exists (select 1 from public.posts p where p.id = comments.post_id)
  );

-- post_votes, comment_votes, moderation_actions: sealed. Your own votes come
-- back through my_post_votes() / my_comment_votes().

-- ---------------------------------------------------------------------------
-- 7. Recounts
-- ---------------------------------------------------------------------------

create or replace function public.forum_recount_post(p_post_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.posts p
     set upvotes   = v.up,
         downvotes = v.down,
         score     = v.score
    from (
      select count(*) filter (where value = 1)::integer  as up,
             count(*) filter (where value = -1)::integer as down,
             coalesce(sum(value * weight), 0)::integer   as score
      from public.post_votes where post_id = p_post_id
    ) v
   where p.id = p_post_id;
$$;

create or replace function public.forum_recount_comment(p_comment_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.comments c
     set upvotes   = v.up,
         downvotes = v.down,
         score     = v.score
    from (
      select count(*) filter (where value = 1)::integer  as up,
             count(*) filter (where value = -1)::integer as down,
             coalesce(sum(value * weight), 0)::integer   as score
      from public.comment_votes where comment_id = p_comment_id
    ) v
   where c.id = p_comment_id;
$$;

-- Karma: the author's weighted score across what is still up, minus the
-- implicit self-upvote on each item (your own vote on your own post is not the
-- community's opinion of you).
create or replace function public.forum_recount_karma(p_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles pr
     set karma = coalesce((
           select sum(p.score) - count(*) filter (where exists (
                    select 1 from public.post_votes v where v.post_id = p.id and v.user_id = p_user and v.value = 1 and v.weight = 1))
           from public.posts p
           where p.author_id = p_user and p.status = 'visible' and p.deleted_at is null), 0)
       + coalesce((
           select sum(c.score) - count(*) filter (where exists (
                    select 1 from public.comment_votes v where v.comment_id = c.id and v.user_id = p_user and v.value = 1 and v.weight = 1))
           from public.comments c
           where c.author_id = p_user and c.status = 'visible' and c.deleted_at is null), 0)
   where pr.id = p_user;
$$;

revoke all on function public.forum_recount_post(uuid), public.forum_recount_comment(uuid), public.forum_recount_karma(uuid)
  from public;
revoke execute on function public.forum_recount_post(uuid), public.forum_recount_comment(uuid), public.forum_recount_karma(uuid)
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Posts: create, edit, delete, vote
-- ---------------------------------------------------------------------------

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

  perform public.enforce_rate_limit('post:' || v_uid::text, 1, 10, interval '1 hour');

  loop
    v_attempt := v_attempt + 1;
    v_public_id := public.generate_share_slug(8);
    begin
      insert into public.posts (public_id, board_id, author_id, kind, published_hand_id, title, body)
      values (v_public_id, v_board.id, v_uid, case when v_hand_id is null then 'text' else 'hand' end,
              v_hand_id, v_title, v_body)
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

  return jsonb_build_object('publicId', v_public_id, 'board', v_board.slug, 'slug', public.forum_slugify(v_title));
end;
$$;

create or replace function public.edit_post(p_public_id text, p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_post  public.posts%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  select * into v_post from public.posts where public_id = p_public_id for update;
  if not found or v_post.author_id is distinct from v_uid or v_post.deleted_at is not null then
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  if v_post.status <> 'visible' then
    raise exception 'A removed post cannot be edited.' using errcode = '22023';
  end if;
  if char_length(v_title) < 3 or char_length(v_title) > 300 then
    raise exception 'Titles are 3 to 300 characters.' using errcode = '22023';
  end if;
  if char_length(v_body) > 40000 then
    raise exception 'Posts are at most 40,000 characters.' using errcode = '22023';
  end if;
  if v_post.kind = 'text' and v_body = '' then
    raise exception 'A text post needs some text.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('edit:' || v_uid::text, 1, 60, interval '1 hour');

  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, details)
  values (v_uid, 'post.edit', 'post', v_post.id, v_post.author_id,
          jsonb_build_object('title', v_post.title, 'body', v_post.body));

  update public.posts set title = v_title, body = v_body, edited_at = now() where id = v_post.id;

  return jsonb_build_object('publicId', v_post.public_id, 'slug', public.forum_slugify(v_title));
end;
$$;

create or replace function public.delete_post(p_public_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_post public.posts%rowtype;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  select * into v_post from public.posts where public_id = p_public_id for update;
  if not found or v_post.author_id is distinct from v_uid or v_post.deleted_at is not null then
    return false;
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, details)
  values (v_uid, 'post.delete', 'post', v_post.id, v_post.author_id,
          jsonb_build_object('title', v_post.title, 'body', v_post.body));
  update public.posts set deleted_at = now() where id = v_post.id;
  perform public.forum_recount_karma(v_uid);
  return true;
end;
$$;

-- p_value: 1, -1, or 0 to take the vote back.
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

  perform public.enforce_rate_limit('vote:' || v_uid::text, 1, 600, interval '1 hour');

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

-- ---------------------------------------------------------------------------
-- 9. Comments: create, edit, delete, vote
-- ---------------------------------------------------------------------------

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

  return jsonb_build_object('seq', v_seq);
end;
$$;

create or replace function public.edit_comment(p_post_public_id text, p_seq integer, p_body text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_comment public.comments%rowtype;
  v_body    text := btrim(coalesce(p_body, ''));
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 10000 then
    raise exception 'Comments are 1 to 10,000 characters.' using errcode = '22023';
  end if;
  select c.* into v_comment
  from public.comments c join public.posts p on p.id = c.post_id
  where p.public_id = p_post_public_id and c.seq = p_seq
  for update of c;
  if not found or v_comment.author_id is distinct from v_uid or v_comment.deleted_at is not null
     or v_comment.status <> 'visible' then
    raise exception 'That comment does not exist.' using errcode = '22023';
  end if;
  perform public.enforce_rate_limit('edit:' || v_uid::text, 1, 60, interval '1 hour');
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, details)
  values (v_uid, 'comment.edit', 'comment', v_comment.id, v_comment.author_id, jsonb_build_object('body', v_comment.body));
  update public.comments set body = v_body, edited_at = now() where id = v_comment.id;
  return true;
end;
$$;

-- Tombstone: the row keeps its place (so replies stay attached), and loses its
-- body and author. Both are kept in moderation_actions.
create or replace function public.delete_comment(p_post_public_id text, p_seq integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_comment public.comments%rowtype;
begin
  if v_uid is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  select c.* into v_comment
  from public.comments c join public.posts p on p.id = c.post_id
  where p.public_id = p_post_public_id and c.seq = p_seq
  for update of c;
  if not found or v_comment.author_id is distinct from v_uid or v_comment.deleted_at is not null then
    return false;
  end if;
  insert into public.moderation_actions (actor_id, action, target_type, target_id, subject_id, details)
  values (v_uid, 'comment.delete', 'comment', v_comment.id, v_comment.author_id, jsonb_build_object('body', v_comment.body));
  update public.comments set body = null, author_id = null, deleted_at = now() where id = v_comment.id;
  update public.posts set comment_count = greatest(comment_count - 1, 0) where id = v_comment.post_id;
  perform public.forum_recount_karma(v_uid);
  return true;
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

  perform public.enforce_rate_limit('vote:' || v_uid::text, 1, 600, interval '1 hour');

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

-- ---------------------------------------------------------------------------
-- 10. Reading
-- ---------------------------------------------------------------------------

-- One post card or page row. Invoker: the posts policy decides visibility.
create or replace function public.forum_post_json(p public.posts)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'publicId', p.public_id,
    'board', (select jsonb_build_object('slug', b.slug, 'name', b.name) from public.boards b where b.id = p.board_id),
    'kind', p.kind,
    'title', p.title,
    'slug', p.slug,
    'body', p.body,
    'author', (select jsonb_build_object('username', a.username) from public.profiles_public a where a.id = p.author_id),
    'upvotes', p.upvotes,
    'downvotes', p.downvotes,
    'score', p.score,
    'commentCount', p.comment_count,
    'isLocked', p.is_locked,
    'isPinned', p.is_pinned,
    'createdAt', p.created_at,
    'editedAt', p.edited_at,
    'hand', (select jsonb_build_object(
                'publicId', h.public_id, 'site', h.site, 'stakesLabel', h.stakes_label,
                'heroPosition', h.hero_position, 'heroCards', h.hero_cards, 'boardCards', h.board_cards,
                'gameFormat', h.game_format, 'variant', h.variant)
             from public.published_hands h where h.id = p.published_hand_id)
  );
$$;

-- The feed. Keyset pagination: `p_after` is the opaque cursor the previous page
-- returned. Offset paging on a hot-ordered feed drifts (a post moves between
-- pages while you read) and degrades with depth.
--
-- One statement per sort rather than a `case` in the `order by`: each one
-- repeats the visibility predicate verbatim and orders by exactly the columns
-- of its partial index, which is the only shape the planner will serve from
-- that index. A `case` expression would sort the whole visible table.
--
-- Cursor: `<key>~<uuid>`, where the key is the hot rank, the score, or the
-- creation time as an ISO timestamp -- never a float epoch, which would round
-- microseconds and skip or repeat a post at a page boundary.
create or replace function public.forum_feed(
  p_board text default null,
  p_sort  text default 'hot',
  p_after text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_board  uuid;
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_sort   text := case when p_sort in ('hot', 'new', 'top') then p_sort else 'hot' end;
  v_key    text;
  v_id     uuid;
  v_page   public.posts[];
  v_rows   jsonb;
  v_next   text;
  v_last   public.posts;
  i        integer;
begin
  if p_board is not null then
    select id into v_board from public.boards where slug = lower(p_board);
    if not found then
      return null;
    end if;
  end if;

  if p_after is not null and position('~' in p_after) > 0 then
    v_key := split_part(p_after, '~', 1);
    begin
      v_id := split_part(p_after, '~', 2)::uuid;
    exception when others then
      v_key := null;
      v_id := null;
    end;
  end if;

  begin
    if v_sort = 'hot' then
      select array_agg(p order by p.hot_rank desc, p.id desc) into v_page from (
        select p.* from public.posts p
        where p.status = 'visible' and p.deleted_at is null
          and (v_board is null or p.board_id = v_board)
          and (v_id is null or (p.hot_rank, p.id) < (v_key::double precision, v_id))
        order by p.hot_rank desc, p.id desc
        limit v_limit + 1
      ) p;
    elsif v_sort = 'new' then
      select array_agg(p order by p.created_at desc, p.id desc) into v_page from (
        select p.* from public.posts p
        where p.status = 'visible' and p.deleted_at is null
          and (v_board is null or p.board_id = v_board)
          and (v_id is null or (p.created_at, p.id) < (v_key::timestamptz, v_id))
        order by p.created_at desc, p.id desc
        limit v_limit + 1
      ) p;
    else
      select array_agg(p order by p.score desc, p.id desc) into v_page from (
        select p.* from public.posts p
        where p.status = 'visible' and p.deleted_at is null
          and (v_board is null or p.board_id = v_board)
          and (v_id is null or (p.score, p.id) < (v_key::integer, v_id))
        order by p.score desc, p.id desc
        limit v_limit + 1
      ) p;
    end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
                 or numeric_value_out_of_range then
    -- A mangled cursor is the first page, not an error page.
    return public.forum_feed(p_board, v_sort, null, v_limit);
  end;

  v_page := coalesce(v_page, array[]::public.posts[]);

  v_rows := '[]'::jsonb;
  for i in 1 .. least(cardinality(v_page), v_limit) loop
    v_rows := v_rows || jsonb_build_array(public.forum_post_json(v_page[i]));
  end loop;

  if cardinality(v_page) > v_limit then
    v_last := v_page[v_limit];
    v_next := case v_sort
                when 'hot' then v_last.hot_rank::text
                when 'new' then to_char(v_last.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                else v_last.score::text
              end || '~' || v_last.id::text;
  end if;

  return jsonb_build_object('posts', v_rows, 'next', v_next, 'sort', v_sort);
end;
$$;

-- One post, with the published hand's scrubbed document for a hand post.
create or replace function public.get_post(p_public_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select public.forum_post_json(p)
         || jsonb_build_object('handPhf', (select h.phf from public.published_hands h where h.id = p.published_hand_id))
  from public.posts p
  where p.public_id = p_public_id;
$$;

-- "Removed" versus "never existed", for a post the invoker read cannot see.
create or replace function public.post_status(p_public_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p.deleted_at is not null then 'deleted'
              when p.status <> 'visible' then 'removed'
              else 'visible' end
  from public.posts p where p.public_id = p_public_id;
$$;

-- The thread. Invoker, so the comment policy does the tombstone and shadowban
-- work. Honest about the cost: best-first at every level in one index scan is
-- not possible. Order *within* a subtree is `path`; order *between* top-level
-- comments is the chosen sort -- which is what Reddit does.
create or replace function public.get_post_comments(p_public_id text, p_sort text default 'best')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with post as (select id from public.posts where public_id = p_public_id),
  c as (
    select c.*, left(c.path, 6) as root_path
    from public.comments c where c.post_id = (select id from post)
  ),
  roots as (
    select path as root_path,
           case when p_sort = 'new' then extract(epoch from created_at)
                when p_sort = 'top' then score::double precision
                else best_rank end as root_key
    from c where depth = 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', c.seq,
           'parentSeq', (select pc.seq from public.comments pc where pc.id = c.parent_id),
           'depth', c.depth,
           'body', case when c.deleted_at is null and c.status = 'visible' then c.body end,
           'deleted', c.deleted_at is not null,
           'removed', c.status <> 'visible',
           'author', case when c.deleted_at is null and c.status = 'visible'
                          then (select jsonb_build_object('username', a.username) from public.profiles_public a where a.id = c.author_id) end,
           'upvotes', c.upvotes,
           'downvotes', c.downvotes,
           'score', c.score,
           'createdAt', c.created_at,
           'editedAt', c.edited_at,
           'anchor', case when c.anchor_action_index is null and c.anchor_street is null then null
                          else jsonb_build_object('actionIndex', c.anchor_action_index, 'street', c.anchor_street, 'seat', c.anchor_seat) end
         ) order by coalesce(r.root_key, 0) desc, c.root_path, c.path), '[]'::jsonb)
  from c left join roots r on r.root_path = c.root_path;
$$;

create or replace function public.my_post_votes(p_public_ids text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(p.public_id, v.value), '{}'::jsonb)
  from public.post_votes v join public.posts p on p.id = v.post_id
  where v.user_id = (select auth.uid())
    and p.public_id = any ((coalesce(p_public_ids, '{}'::text[]))[1:200]);
$$;

create or replace function public.my_comment_votes(p_post_public_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c.seq::text, v.value), '{}'::jsonb)
  from public.comment_votes v
  join public.comments c on c.id = v.comment_id
  join public.posts p on p.id = c.post_id
  where v.user_id = (select auth.uid()) and p.public_id = p_post_public_id;
$$;

-- ---------------------------------------------------------------------------
-- 11. Search (#37)
-- ---------------------------------------------------------------------------
--
-- `websearch_to_tsquery` understands what a person types: quoted phrases, OR,
-- -term. Posts and comments are queried separately, each on its own GIN index,
-- then merged: two index scans with their own limits beat one scan over a
-- union the planner has to materialise.
--
-- Ranking: `ts_rank_cd` blended with `ln(score)` and a 30-day exponential
-- recency decay. Invoker, so search cannot become a side channel around
-- moderation.

create or replace function public.search_forum(p_query text, p_limit integer default 20)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select websearch_to_tsquery('english', left(coalesce(p_query, ''), 200)) as tsq,
           least(greatest(coalesce(p_limit, 20), 1), 50) as lim
  ),
  post_hits as (
    select 'post' as type, p.public_id, null::integer as seq, p.title, p.slug,
           ts_headline('english', coalesce(nullif(p.body, ''), p.title), q.tsq,
                       'MaxFragments=1,MaxWords=30,MinWords=10,StartSel=<<,StopSel=>>') as snippet,
           (select b.slug from public.boards b where b.id = p.board_id) as board,
           ts_rank_cd(p.search_tsv, q.tsq)
             * (1 + ln(greatest(p.score, 1)))
             * exp(-extract(epoch from (now() - p.created_at)) / (30 * 86400)) as rank,
           p.created_at
    from public.posts p, q
    where p.search_tsv @@ q.tsq and p.status = 'visible' and p.deleted_at is null
    order by rank desc
    limit (select lim from q)
  ),
  comment_hits as (
    select 'comment' as type, p.public_id, c.seq, p.title, p.slug,
           ts_headline('english', c.body, q.tsq, 'MaxFragments=1,MaxWords=30,MinWords=10,StartSel=<<,StopSel=>>') as snippet,
           (select b.slug from public.boards b where b.id = p.board_id) as board,
           ts_rank_cd(c.search_tsv, q.tsq)
             * (1 + ln(greatest(c.score, 1)))
             * exp(-extract(epoch from (now() - c.created_at)) / (30 * 86400)) as rank,
           c.created_at
    from public.comments c join public.posts p on p.id = c.post_id, q
    where c.search_tsv @@ q.tsq and c.status = 'visible' and c.deleted_at is null and c.body is not null
    order by rank desc
    limit (select lim from q)
  ),
  merged as (
    select * from post_hits union all select * from comment_hits
    order by rank desc
    limit (select lim from q)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'type', type, 'publicId', public_id, 'seq', seq, 'title', title, 'slug', slug,
           'board', board, 'snippet', snippet, 'createdAt', created_at) order by rank desc), '[]'::jsonb)
  from merged;
$$;

-- ---------------------------------------------------------------------------
-- 12. Grants on the functions
-- ---------------------------------------------------------------------------

revoke all on function
  public.create_post(text, text, text, text),
  public.edit_post(text, text, text),
  public.delete_post(text),
  public.vote_post(text, integer),
  public.create_comment(text, text, integer, integer, text, integer),
  public.edit_comment(text, integer, text),
  public.delete_comment(text, integer),
  public.vote_comment(text, integer, integer),
  public.my_post_votes(text[]),
  public.my_comment_votes(text)
from public;

revoke execute on function
  public.create_post(text, text, text, text),
  public.edit_post(text, text, text),
  public.delete_post(text),
  public.vote_post(text, integer),
  public.create_comment(text, text, integer, integer, text, integer),
  public.edit_comment(text, integer, text),
  public.delete_comment(text, integer),
  public.vote_comment(text, integer, integer),
  public.my_post_votes(text[]),
  public.my_comment_votes(text)
from anon;

grant execute on function
  public.create_post(text, text, text, text),
  public.edit_post(text, text, text),
  public.delete_post(text),
  public.vote_post(text, integer),
  public.create_comment(text, text, integer, integer, text, integer),
  public.edit_comment(text, integer, text),
  public.delete_comment(text, integer),
  public.vote_comment(text, integer, integer),
  public.my_post_votes(text[]),
  public.my_comment_votes(text)
to authenticated;

revoke all on function public.forum_feed(text, text, text, integer), public.get_post(text), public.post_status(text),
  public.get_post_comments(text, text), public.search_forum(text, integer), public.forum_post_json(public.posts)
from public;
grant execute on function public.forum_feed(text, text, text, integer), public.get_post(text), public.post_status(text),
  public.get_post_comments(text, text), public.search_forum(text, integer), public.forum_post_json(public.posts)
to anon, authenticated;

commit;
