-- ===========================================================================
-- Sharing a hand's analysis (A7.1, docs/ANALYSIS-PLAN.md §6.1, §6.4, §8.4)
-- ===========================================================================
--
-- §8.4: analysis is private to the owner, and showing it on a shared hand is
-- a per-hand opt-in, off by default. This file is that opt-in and the one
-- door through which anybody but the owner reads an analysis.
--
-- ## The flag
--
-- `analysis_shares` holds one row per (hand, owner) the owner has ever
-- toggled; `shared` says whether it is on. A row, not a column on `hands`:
-- `hands` has an owner UPDATE policy for the library's own writes, and a flag
-- that decides what strangers read must not be one more column a generic
-- update can set. Here there is no client INSERT, UPDATE or DELETE grant at
-- all: the only write is `set_analysis_share`, security definer, which names
-- the hand by id *and* owner. Turning it off writes `shared = false` rather
-- than deleting the row (no client role deletes anything, rule 5).
--
-- The flag is per hand, not per surface. One switch covers every place the
-- hand is already public: its published page, the forum thread or poll that
-- shows it, and share links the owner made. The owner's toggle says so in
-- those words.
--
-- ## The read
--
-- `read_shared_analysis(surface, id, version)` is security definer and
-- granted to anon. It resolves a *public surface*, not a hand id:
--
--   published  `/p/<public_id>`: the publication is visible (the
--              `published_hands_public_select` predicate, restated);
--   post       a forum post: visible to the caller (the `posts_read`
--              predicate, as `read_poll` restates it), its hand not deleted
--              or removed; for a poll, only once the caller may see the
--              answer (`poll_hides_answer` false: voted, author or
--              moderator) -- vote-before-reveal for the reference answer is
--              the database's, like the rest of the poll;
--   share      `/h/<slug>`: a capability URL; knowing the slug is the
--              authorisation, exactly as for `read_share`.
--
-- It then follows the surface to the private hand (`published_hand_sources`
-- or `shares.hand_id`), and answers only when that hand's owner -- the same
-- account that published or shared it -- has the flag on, at the version the
-- caller asks for. Anything else is null: unshared, unknown, malformed,
-- not public, sealed and unanswered all look the same.
--
-- ## What leaves
--
-- Named keys only, as `read_share` does: no `handId`, no owner, no
-- timestamps. Options are projected to the seven keys `OptionAnalysis` has,
-- flags to code / severity / params, and `facts` to the keys `SpotFacts`
-- has: the hand's own row is written by the owner's browser, and a key
-- nobody listed does not reach a stranger. (A new `SpotFacts` key needs a
-- line in `analysis_public_facts`; `turn` and `flop` are listed already for
-- A5's postflop solves.)
--
-- Facts are hero-centric by construction (lib/analysis): the hero's cards,
-- the board up to the decision, positions, pot geometry, and equities
-- against *ranges* named by line and seat (`open:BTN`). No villain's hole
-- cards and no screen names are ever inputs to them, so there is nothing for
-- a published copy's pseudonyms to mask. The one spot where the public view
-- hides more than the analysis would show is a poll before the reveal (no
-- villain cards, no later streets, perhaps not the hero's cards) -- and
-- there the function returns nothing at all.
-- ===========================================================================

begin;

-- ----------------------------------------------------------------- table ---

create table if not exists public.analysis_shares (
  hand_id    uuid primary key references public.hands (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  shared     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.analysis_shares is
  'Per-hand opt-in (§8.4): the owner lets the hand''s analysis show wherever the hand itself is public. '
  'Written only by set_analysis_share; read publicly only through read_shared_analysis.';

create index if not exists analysis_shares_owner_idx on public.analysis_shares (owner_id) where shared;

alter table public.analysis_shares enable row level security;
revoke all on public.analysis_shares from anon, authenticated;
grant select on public.analysis_shares to authenticated;

drop policy if exists analysis_shares_owner_select on public.analysis_shares;
create policy analysis_shares_owner_select on public.analysis_shares
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- ------------------------------------------------------ surface -> hand ---
--
-- Which private hand a surface shows, with no visibility check: an internal
-- of the three functions below, never granted. `hand` takes the hand's own
-- uuid (the owner's analysis page); the others take what a public URL holds.
-- Returns the hand and the account that put it on that surface.

create or replace function public.analysis_share_target(p_surface text, p_id text)
returns table (hand_id uuid, owner_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_id is null then
    return;
  end if;
  if p_surface = 'hand' then
    if p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return;
    end if;
    return query select h.id, h.owner_id from public.hands h where h.id = p_id::uuid;
  elsif p_surface = 'published' then
    if p_id !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{10}$' then
      return;
    end if;
    return query
      select s.hand_id, s.author_id
      from public.published_hands p
      join public.published_hand_sources s on s.published_id = p.id
      where p.public_id = p_id and s.hand_id is not null;
  elsif p_surface = 'post' then
    if p_id !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8}$' then
      return;
    end if;
    return query
      select s.hand_id, s.author_id
      from public.posts po
      join public.published_hand_sources s on s.published_id = po.published_hand_id
      where po.public_id = p_id and s.hand_id is not null;
  elsif p_surface = 'share' then
    if p_id !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$' then
      return;
    end if;
    return query
      select sh.hand_id, sh.owner_id
      from public.shares sh
      where sh.slug = p_id and sh.hand_id is not null and sh.owner_id is not null;
  end if;
end;
$$;

revoke all on function public.analysis_share_target(text, text) from public, anon, authenticated;

-- ------------------------------------------------------ the owner's view ---
--
-- The owner's switch, as their toggle draws it: the hand's id, whether it is
-- shared, and which analysis versions are stored for it (so the toggle can
-- say "nothing to show yet"). Null for anybody who does not own the hand --
-- one answer for "not yours" and "no such hand".

create or replace function public.analysis_share_state(p_surface text, p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_hand uuid;
begin
  if v_uid is null then
    return null;
  end if;
  -- Ownership, explicitly: the hand must be the caller's *and* the surface
  -- must be one the caller made (a share or publication of theirs).
  select t.hand_id into v_hand
  from public.analysis_share_target(p_surface, p_id) t
  join public.hands h on h.id = t.hand_id and h.owner_id = v_uid
  where t.owner_id = v_uid
  limit 1;
  if v_hand is null then
    return null;
  end if;

  return jsonb_build_object(
    'handId',   v_hand,
    'shared',   coalesce((select s.shared from public.analysis_shares s
                          where s.hand_id = v_hand and s.owner_id = v_uid), false),
    'versions', coalesce((select jsonb_agg(a.analysis_version order by a.analysis_version)
                          from public.hand_analysis a
                          where a.hand_id = v_hand and a.owner_id = v_uid), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.analysis_share_state(text, text) from public, anon;
grant execute on function public.analysis_share_state(text, text) to authenticated;

-- ------------------------------------------------------------ the switch ---
--
-- Turns the flag on or off for one of the caller's own hands, named by any
-- surface the caller owns (`hand` on the analysis page, `published` in the
-- publish dialog, `post` on the caller's own poll, `share` on a link). Same
-- error for "not yours" and "no such hand", so it is not an oracle. 120
-- switches per 10 minutes per account.

create or replace function public.set_analysis_share(p_surface text, p_id text, p_shared boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_hand uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to share an analysis.' using errcode = '42501';
  end if;
  if p_shared is null then
    raise exception 'Say whether to share the analysis (true or false).' using errcode = '22023';
  end if;

  select t.hand_id into v_hand
  from public.analysis_share_target(p_surface, p_id) t
  join public.hands h on h.id = t.hand_id and h.owner_id = v_uid
  where t.owner_id = v_uid
  limit 1;
  if v_hand is null then
    raise exception 'That hand does not exist.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('analysis_share:' || v_uid::text, 1, 120, interval '10 minutes');

  insert into public.analysis_shares (hand_id, owner_id, shared)
  values (v_hand, v_uid, p_shared)
  on conflict (hand_id) do update
    set shared = excluded.shared, updated_at = now()
    where public.analysis_shares.owner_id = v_uid;

  return public.analysis_share_state('hand', v_hand::text);
end;
$$;

revoke all on function public.set_analysis_share(text, text, boolean) from public, anon;
grant execute on function public.set_analysis_share(text, text, boolean) to authenticated;

-- ------------------------------------------------------- projections ---
--
-- What of a stored decision a stranger may read. Internal, never granted.

create or replace function public.analysis_public_facts(p_facts jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p_facts) = 'object' then p_facts else '{}'::jsonb end) f
  where f.key = any (array[
    'street', 'position', 'inPosition', 'players', 'scenario', 'preflopScenario', 'role', 'facing',
    'potBb', 'toCallBb', 'heroStackBb', 'effStackBb', 'spr', 'potOdds', 'mdf', 'facingPot', 'betPot',
    'behindBb', 'allIn', 'holeCards', 'handClass', 'board', 'texture', 'made', 'draws', 'blockers',
    'equity', 'chart', 'river', 'turn', 'flop'
  ]);
$$;

revoke all on function public.analysis_public_facts(jsonb) from public, anon, authenticated;

create or replace function public.analysis_public_options(p_options jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'action',  o.value -> 'action',
             'size',    o.value -> 'size',
             'sizeBb',  o.value -> 'sizeBb',
             'allIn',   o.value -> 'allIn',
             'sizePot', o.value -> 'sizePot',
             'freq',    o.value -> 'freq',
             'ev',      o.value -> 'ev'))
           order by o.ordinality), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_options) = 'array' then p_options else '[]'::jsonb end)
       with ordinality o(value, ordinality);
$$;

revoke all on function public.analysis_public_options(jsonb) from public, anon, authenticated;

create or replace function public.analysis_public_flags(p_flags jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'code',     f.value -> 'code',
             'severity', f.value -> 'severity',
             'params',   case when jsonb_typeof(f.value -> 'params') = 'object' then f.value -> 'params' else '{}'::jsonb end)
           order by f.ordinality), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_flags) = 'array' then p_flags else '[]'::jsonb end)
       with ordinality f(value, ordinality);
$$;

revoke all on function public.analysis_public_flags(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------- the read ---

create or replace function public.read_shared_analysis(p_surface text, p_id text, p_version text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_post   public.posts%rowtype;
  v_ph     public.published_hands%rowtype;
  v_hand   uuid;
  v_owner  uuid;
  v_out    jsonb;
begin
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    return null;
  end if;

  -- 1. The surface must be public to this caller, by the rule its own page
  --    uses. Restated here because a definer body does not run under RLS.
  if p_surface = 'published' then
    if p_id is null or p_id !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{10}$' then
      return null;
    end if;
    select * into v_ph from public.published_hands
    where public_id = p_id and status = 'visible' and deleted_at is null;
    if not found then
      return null;
    end if;
  elsif p_surface = 'post' then
    if p_id is null or p_id !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{8}$' then
      return null;
    end if;
    select * into v_post from public.posts where public_id = p_id;
    if not found or v_post.published_hand_id is null then
      return null;
    end if;
    if not (
         (v_post.status = 'visible' and v_post.deleted_at is null and not public.forum_author_hidden(v_post.author_id))
      or (v_uid is not null and v_post.author_id = v_uid)
      or public.is_moderator()
      or public.is_board_moderator(v_post.board_id)
    ) then
      return null;
    end if;
    select * into v_ph from public.published_hands where id = v_post.published_hand_id;
    if not found or v_ph.deleted_at is not null or v_ph.status = 'removed' then
      return null;
    end if;
    -- A poll: the reference is the answer, so it waits for the reveal, like
    -- the hand and the comments do. A sealed hand outside a poll is not
    -- public at all.
    if exists (select 1 from public.post_polls pp where pp.post_id = v_post.id) then
      if public.poll_hides_answer(v_post.id) then
        return null;
      end if;
    elsif v_ph.status <> 'visible' then
      return null;
    end if;
  elsif p_surface = 'share' then
    -- A share slug is a capability URL (DATABASE.md rule 7): knowing it is
    -- the authorisation, as it is for `read_share`.
    null;
  else
    return null;
  end if;

  -- 2. The private hand behind the surface, put there by its owner.
  select t.hand_id, t.owner_id into v_hand, v_owner
  from public.analysis_share_target(p_surface, p_id) t
  join public.hands h on h.id = t.hand_id and h.owner_id = t.owner_id
  limit 1;
  if v_hand is null then
    return null;
  end if;

  -- 3. The owner's opt-in.
  if not exists (
    select 1 from public.analysis_shares s
    where s.hand_id = v_hand and s.owner_id = v_owner and s.shared
  ) then
    return null;
  end if;

  -- 4. Named keys only.
  select jsonb_build_object(
    'analysisVersion', a.analysis_version,
    'status',          a.status,
    'reason',          a.reason,
    'heroSeat',        a.hero_seat,
    'grade',           a.grade,
    'score',           a.score,
    'evLossBb',        a.ev_loss_bb,
    'evLossPot',       a.ev_loss_pot,
    'flagCount',       a.flag_count,
    'worstFlag',       a.worst_flag,
    'approximations',  to_jsonb(a.approximations),
    'potType',         a.pot_type,
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ord',            d.ord,
               'actionIndex',    d.action_index,
               'street',         d.street,
               'action',         d.action,
               'status',         d.status,
               'reason',         d.reason,
               'node',           d.node,
               'scenario',       d.scenario,
               'source',         d.source,
               'grade',          d.grade,
               'score',          d.score,
               'evLossBb',       d.ev_loss_bb,
               'evLossPot',      d.ev_loss_pot,
               'freqDiff',       d.freq_diff,
               'options',        public.analysis_public_options(d.options),
               'chosen',         d.chosen,
               'flags',          public.analysis_public_flags(d.flags),
               'worstFlag',      d.worst_flag,
               'approximations', to_jsonb(d.approximations),
               'facts',          public.analysis_public_facts(d.facts)) order by d.ord)
      from public.decision_analysis d
      where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)
  )
  into v_out
  from public.hand_analysis a
  where a.hand_id = v_hand
    and a.analysis_version = p_version
    and a.owner_id = v_owner;

  return v_out;
end;
$$;

revoke all on function public.read_shared_analysis(text, text, text) from public;
grant execute on function public.read_shared_analysis(text, text, text) to anon, authenticated;

comment on function public.read_shared_analysis(text, text, text) is
  'The analysis of the hand behind a public surface (published / post / share), at one version, when its owner '
  'has shared it (analysis_shares). Polls: only after the reveal. Named keys, no ids. Null otherwise.';

commit;
