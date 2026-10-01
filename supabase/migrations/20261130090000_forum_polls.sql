-- ===========================================================================
-- "What would you do?" -- vote before the reveal (F14, #51)
-- ===========================================================================
--
-- The author posts a hand stopped at one of their own decisions. A reader sees
-- the spot -- the action up to that point, the board so far, the author's cards
-- unless they chose to hide them -- votes, and only then sees the rest of the
-- hand, how everyone else voted, and the discussion.
--
-- The point is the order. Poker threads anchor on the first reply; here nobody
-- reads a reply before committing to an answer. That only holds if the gate is
-- the database's, not the page's: a client-side "hide until voted" is a CSS
-- rule between a reader and the answer. So:
--
--   * **The hand.** A poll's published hand moves to `status = 'poll'`, which
--     `published_hands_public_select` does not match. It drops out of every
--     public read at once -- `/p/:id`, the author's profile list, the
--     sitemap, `get_post`'s `handPhf`, `forum_post_json`'s card -- because all
--     of them read through that policy. The only way to the document is
--     `read_poll`, which returns the truncated spot (`poll_phf`) to anyone who
--     may see the post and the full hand only to someone who has voted, the
--     author, or a moderator of the post.
--   * **The discussion.** `comments_read` gains one clause: a poll's comments
--     are invisible to a caller who has not voted (author and moderators
--     excepted). That covers `get_post_comments`, a direct PostgREST read of
--     `comments`, and anything added later that reads through the policy.
--   * **The votes.** `post_polls` and `poll_votes` are sealed. Reads are two
--     definer functions that return counts, never voters.
--
-- What leaks by design: the post's title and body (the author writes them, and
-- is told the spot is hidden), the stakes and positions in the spot itself,
-- and the vote *count* -- which says how many people answered, not what.
-- ===========================================================================

begin;

-- ------------------------------------------------------------------ hand ---

alter table public.published_hands drop constraint if exists published_hands_status_ok;
alter table public.published_hands add constraint published_hands_status_ok
  check (status in ('visible', 'removed', 'poll'));

comment on column public.published_hands.status is
  'visible: public. removed: by a moderator. poll: sealed behind a poll, readable '
  'in full only through read_poll by a voter, the author, or a moderator.';

-- --------------------------------------------------------------- tables ---

create table if not exists public.post_polls (
  post_id           uuid primary key references public.posts (id) on delete cascade,
  published_hand_id uuid not null references public.published_hands (id) on delete cascade,
  -- `actions[].index` of the hero decision the poll asks about. The spot shows
  -- every action before it.
  stop_index        integer not null check (stop_index >= 0),
  options           text[] not null,
  hide_hero_cards   boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint post_polls_options_ok check (
    cardinality(options) between 2 and 4
    and options <@ array['fold', 'check', 'call', 'bet', 'raise', 'allin']::text[]
  )
);

create table if not exists public.poll_votes (
  post_id    uuid not null references public.post_polls (post_id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  choice     text not null,
  -- For a bet or raise: the size as a percentage of the pot, which is the unit
  -- a player thinks in and the one that compares across stakes.
  size_pct   integer check (size_pct is null or size_pct between 1 and 1000),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id),
  constraint poll_votes_choice_ok check (choice in ('fold', 'check', 'call', 'bet', 'raise', 'allin')),
  constraint poll_votes_size_only_when_sized check (size_pct is null or choice in ('bet', 'raise'))
);

alter table public.post_polls enable row level security;
alter table public.poll_votes enable row level security;
revoke all on public.post_polls from anon, authenticated;
revoke all on public.poll_votes from anon, authenticated;

-- ------------------------------------------------------------- poll_phf ---
--
-- The spot. Everything a reader may see before voting, and nothing else:
--
--   * actions strictly before the decision;
--   * runout 0 only, through the decision's street (a hand that was run twice
--     says so only after the reveal);
--   * hole cards: the hero's, unless the author hid them; never a villain's --
--     a villain's cards before showdown are exactly the answer;
--   * no results, no winners, no chip movements, no source text or warnings
--     (a warning can quote a later line).
--
-- Immutable and internal: it is a pure function of its arguments, and nothing
-- outside `read_poll` needs it.

create or replace function public.poll_phf(p_phf jsonb, p_stop integer, p_hide_hero boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_street text;
  v_run    jsonb := p_phf -> 'board' -> 'runouts' -> 0;
begin
  select a ->> 'street' into v_street
  from jsonb_array_elements(p_phf -> 'actions') a
  where (a ->> 'index')::integer = p_stop;
  if v_street is null then
    raise exception 'poll_phf: no action %', p_stop using errcode = '22023';
  end if;

  return p_phf || jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(a order by (a ->> 'index')::integer)
      from jsonb_array_elements(p_phf -> 'actions') a
      where (a ->> 'index')::integer < p_stop
    ), '[]'::jsonb),
    'players', coalesce((
      select jsonb_agg(pl || jsonb_build_object(
        'holeCards',  case when (pl ->> 'isHero')::boolean and not p_hide_hero then pl -> 'holeCards'  else '[]'::jsonb end,
        'dealtCards', case when (pl ->> 'isHero')::boolean and not p_hide_hero then pl -> 'dealtCards' else '[]'::jsonb end
      ) order by (pl ->> 'seat')::integer)
      from jsonb_array_elements(p_phf -> 'players') pl
    ), '[]'::jsonb),
    'board', jsonb_build_object('runouts', jsonb_build_array(jsonb_build_object(
      'index', 0,
      'flop',  case when v_street in ('flop', 'turn', 'river') then coalesce(v_run -> 'flop', 'null'::jsonb) else 'null'::jsonb end,
      'turn',  case when v_street in ('turn', 'river')         then coalesce(v_run -> 'turn', 'null'::jsonb) else 'null'::jsonb end,
      'river', case when v_street = 'river'                    then coalesce(v_run -> 'river', 'null'::jsonb) else 'null'::jsonb end,
      'markerLabels', '{}'::jsonb,
      'summaryCards', 'null'::jsonb
    ))),
    'chipMovements', '[]'::jsonb,
    'results', jsonb_build_object(
      'totalPot', 0,
      'pots', '[]'::jsonb,
      'fees', jsonb_build_object('rake', 0, 'jackpot', 0, 'bingo', 0, 'fortune', 0, 'tax', 0, 'other', 0),
      'players', '[]'::jsonb,
      'winners', '[]'::jsonb,
      'heroNet', null,
      'wentToShowdown', false,
      'streetReached', v_street
    ),
    'meta', (p_phf -> 'meta') || jsonb_build_object('rawText', '', 'warnings', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.poll_phf(jsonb, integer, boolean) from public, anon, authenticated;

-- -------------------------------------------------------- the reveal gate ---
--
-- True when `p_post` has a poll and the caller has not earned the answer yet.
-- Definer, because it reads the sealed `poll_votes`; it returns one boolean
-- about the caller and nothing about anybody else.

create or replace function public.poll_hides_answer(p_post uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.post_polls pp where pp.post_id = p_post)
     and not exists (
           select 1 from public.poll_votes v
           where v.post_id = p_post and v.user_id = (select auth.uid()))
     and not exists (
           select 1 from public.posts p
           where p.id = p_post
             and (p.author_id = (select auth.uid())
                  or public.is_moderator()
                  or public.is_board_moderator(p.board_id)));
$$;

revoke all on function public.poll_hides_answer(uuid) from public;
grant execute on function public.poll_hides_answer(uuid) to anon, authenticated;

-- The discussion, gated. Same policy as 20261102090000 plus the last clause.
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
    and not public.poll_hides_answer(post_id)
  );

-- ------------------------------------------------------ what a card shows ---

create or replace function public.poll_public(p_post uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'options',       to_jsonb(pp.options),
    'hideHeroCards', pp.hide_hero_cards,
    'votes',         (select count(*) from public.poll_votes v where v.post_id = pp.post_id)
  )
  from public.post_polls pp
  where pp.post_id = p_post;
$$;

revoke all on function public.poll_public(uuid) from public;
grant execute on function public.poll_public(uuid) to anon, authenticated;

-- Same as 20261019090000 with `poll` added. The `hand` subquery already reads
-- null for a sealed hand (it goes through the published_hands policy), which
-- is what keeps the feed card from naming the hero's cards.
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
             from public.published_hands h where h.id = p.published_hand_id),
    'poll', public.poll_public(p.id)
  );
$$;

-- --------------------------------------------------------- create a poll ---
--
-- A post plus a poll, in one transaction: `create_post` does every check a
-- post gets (gates, board, lengths, rate limits, spam), then this seals the
-- hand and records the question.
--
-- The hand must be the caller's, visible, and not already the subject of any
-- post: sealing a hand that another thread is showing would blank that thread.
-- The decision must be a hero action of a kind a poll can ask about, and the
-- options must include what the hero actually did -- otherwise the reveal
-- answers a question nobody was offered.

create or replace function public.create_poll_post(
  p_board          text,
  p_title          text,
  p_body           text,
  p_published_hand text,
  p_stop_index     integer,
  p_options        text[],
  p_hide_hero      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_hand    public.published_hands%rowtype;
  v_action  jsonb;
  v_hero    integer;
  v_options text[];
  v_did     text;
  v_post    jsonb;
  v_post_id uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to post.' using errcode = '42501';
  end if;

  select * into v_hand from public.published_hands
  where public_id = p_published_hand and author_id = v_uid
    and status = 'visible' and deleted_at is null
  for update;
  if not found then
    raise exception 'That published hand does not exist.' using errcode = '22023';
  end if;
  if exists (select 1 from public.posts where published_hand_id = v_hand.id) then
    raise exception 'That hand already has a thread; a poll needs a hand nobody has discussed yet.' using errcode = '22023';
  end if;

  v_options := (select array_agg(distinct o) from unnest(coalesce(p_options, '{}'::text[])) o);
  if v_options is null or cardinality(v_options) < 2 or cardinality(v_options) > 4
     or not v_options <@ array['fold', 'check', 'call', 'bet', 'raise', 'allin']::text[] then
    raise exception 'A poll offers two to four of: fold, check, call, bet, raise, all-in.' using errcode = '22023';
  end if;

  select a into v_action from jsonb_array_elements(v_hand.phf -> 'actions') a
  where (a ->> 'index')::integer = p_stop_index;
  select (pl ->> 'seat')::integer into v_hero from jsonb_array_elements(v_hand.phf -> 'players') pl
  where (pl ->> 'isHero')::boolean limit 1;
  if v_action is null or v_hero is null or (v_action ->> 'seat')::integer is distinct from v_hero
     or v_action ->> 'type' not in ('fold', 'check', 'call', 'bet', 'raise') then
    raise exception 'A poll stops at one of your own decisions.' using errcode = '22023';
  end if;
  v_did := case when (v_action ->> 'allIn')::boolean and 'allin' = any (v_options) then 'allin'
                else v_action ->> 'type' end;
  if not v_did = any (v_options) then
    raise exception 'The options have to include what you actually did (%).', v_did using errcode = '22023';
  end if;

  v_post := public.create_post(p_board, p_title, p_body, p_published_hand);
  select id into v_post_id from public.posts where public_id = v_post ->> 'publicId';

  update public.published_hands set status = 'poll' where id = v_hand.id;
  insert into public.post_polls (post_id, published_hand_id, stop_index, options, hide_hero_cards)
  values (v_post_id, v_hand.id, p_stop_index, v_options, coalesce(p_hide_hero, false));

  return v_post;
end;
$$;

revoke all on function public.create_poll_post(text, text, text, text, integer, text[], boolean) from public, anon;
grant execute on function public.create_poll_post(text, text, text, text, integer, text[], boolean) to authenticated;

-- -------------------------------------------------------------- read it ---
--
-- The poll as the caller may see it. Null when the caller cannot see the post
-- at all -- the posts policy, restated here because a definer function does not
-- run under it.

create or replace function public.read_poll(p_post text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_post     public.posts%rowtype;
  v_poll     public.post_polls%rowtype;
  v_hand     public.published_hands%rowtype;
  v_mine     public.poll_votes%rowtype;
  v_revealed boolean;
  v_results  jsonb;
begin
  select * into v_post from public.posts where public_id = p_post;
  if not found then
    return null;
  end if;
  if not (
       (v_post.status = 'visible' and v_post.deleted_at is null and not public.forum_author_hidden(v_post.author_id))
    or v_post.author_id = v_uid
    or public.is_moderator()
    or public.is_board_moderator(v_post.board_id)
  ) then
    return null;
  end if;

  select * into v_poll from public.post_polls where post_id = v_post.id;
  if not found then
    return null;
  end if;
  select * into v_hand from public.published_hands where id = v_poll.published_hand_id;
  if v_uid is not null then
    select * into v_mine from public.poll_votes where post_id = v_post.id and user_id = v_uid;
  end if;

  v_revealed := not public.poll_hides_answer(v_post.id);

  if v_revealed then
    select coalesce(jsonb_object_agg(x.choice, jsonb_build_object('votes', x.n, 'medianSizePct', x.median)), '{}'::jsonb)
    into v_results
    from (
      select v.choice, count(*) as n,
             percentile_disc(0.5) within group (order by v.size_pct) as median
      from public.poll_votes v where v.post_id = v_post.id
      group by v.choice
    ) x;
  end if;

  return jsonb_build_object(
    'options',       to_jsonb(v_poll.options),
    'hideHeroCards', v_poll.hide_hero_cards,
    'stopIndex',     v_poll.stop_index,
    'votes',         (select count(*) from public.poll_votes v where v.post_id = v_post.id),
    'myVote',        case when v_mine.post_id is null then null
                          else jsonb_build_object('choice', v_mine.choice, 'sizePct', v_mine.size_pct) end,
    'isAuthor',      v_uid is not null and v_post.author_id = v_uid,
    'revealed',      v_revealed,
    'results',       v_results,
    -- A hand its author has since unpublished, or a moderator removed, is gone
    -- for everybody; the poll's numbers stay.
    'phf',           case
                       when v_hand.id is null or v_hand.deleted_at is not null or v_hand.status = 'removed' then null
                       when v_revealed then v_hand.phf
                       else public.poll_phf(v_hand.phf, v_poll.stop_index, v_poll.hide_hero_cards)
                     end
  );
end;
$$;

revoke all on function public.read_poll(text) from public;
grant execute on function public.read_poll(text) to anon, authenticated;

-- -------------------------------------------------------------- vote ---
--
-- One vote per person per poll, final: changing an answer after the reveal
-- would make the distribution a record of who read the comments. The author
-- does not vote on their own hand. Banned accounts cannot vote; shadowbanned
-- ones can, and are counted -- a shadowban hides words, and a vote has none.

create or replace function public.vote_poll(p_post text, p_choice text, p_size_pct integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_block text;
  v_post  public.posts%rowtype;
  v_poll  public.post_polls%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to vote.' using errcode = '42501';
  end if;
  v_block := public.posting_block_reason(v_uid);
  if v_block is not null then
    raise exception '%', v_block using errcode = '22023';
  end if;

  select * into v_post from public.posts
  where public_id = p_post and status = 'visible' and deleted_at is null;
  if not found then
    raise exception 'That post does not exist.' using errcode = '22023';
  end if;
  select * into v_poll from public.post_polls where post_id = v_post.id;
  if not found then
    raise exception 'That post has no poll.' using errcode = '22023';
  end if;
  if v_post.is_locked then
    raise exception 'This thread is locked.' using errcode = '22023';
  end if;
  if v_post.author_id = v_uid then
    raise exception 'You already know what you did.' using errcode = '22023';
  end if;
  if not p_choice = any (v_poll.options) then
    raise exception 'That is not one of the options.' using errcode = '22023';
  end if;
  if p_size_pct is not null and (p_choice not in ('bet', 'raise') or p_size_pct not between 1 and 1000) then
    raise exception 'A size goes with a bet or a raise, as 1 to 1000 percent of the pot.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('vote:' || v_uid::text, 1, 200, interval '1 hour');
  perform public.enforce_rate_limit('vote:*', 1, 50000, interval '1 hour');

  begin
    insert into public.poll_votes (post_id, user_id, choice, size_pct)
    values (v_post.id, v_uid, p_choice, p_size_pct);
  exception when unique_violation then
    raise exception 'You have already answered this one.' using errcode = '22023';
  end;

  return public.read_poll(p_post);
end;
$$;

revoke all on function public.vote_poll(text, text, integer) from public, anon;
grant execute on function public.vote_poll(text, text, integer) to authenticated;

-- ------------------------------------------------- /p/:id for a sealed hand ---
--
-- `/p/:id` for a sealed hand should say "this is a poll, answer it" and link
-- there, not "removed". The status says which; the second function says where,
-- and nothing else -- no document, no cards.

create or replace function public.published_hand_status(p_public_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p.deleted_at is not null then 'deleted'
           when p.status = 'poll'        then 'poll'
           when p.status <> 'visible'    then 'removed'
           else 'visible'
         end
  from public.published_hands p
  where p.public_id = p_public_id;
$$;

create or replace function public.poll_post_of_hand(p_public_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('board', b.slug, 'publicId', p.public_id, 'slug', p.slug)
  from public.published_hands h
  join public.post_polls pp on pp.published_hand_id = h.id
  join public.posts p on p.id = pp.post_id
  join public.boards b on b.id = p.board_id
  where h.public_id = p_public_id and h.status = 'poll'
    and p.status = 'visible' and p.deleted_at is null
    and not public.forum_author_hidden(p.author_id);
$$;

revoke all on function public.poll_post_of_hand(text) from public;
grant execute on function public.poll_post_of_hand(text) to anon, authenticated;

commit;
