-- Hand analysis, analysis/20 follow-up: an opponent's statistics never leave
-- through a share.
--
-- Since `analysis/20` a decision whose preflop range was moved by an
-- opponent's own statistics stores them (`facts.villain`: position, line,
-- hands, the raw and shrunk VPIP - PFR rate, the counters), read from the
-- owner's private library. They are the owner's, not the hand's, and must
-- not reach a stranger through `read_shared_analysis`.
--
-- The facts projection already keeps them out: `analysis_public_facts`
-- (A7.1, A9) passes a list of known keys and `villain` is not on it - checked
-- on the local stack before this migration. This makes the rule explicit in
-- the reader itself, `- 'villain'` after the projection, so a later line
-- added to that list cannot let it through; the pgTAP test
-- (`analysis_share_villain.test.sql`) pins it. The turn's and river's own
-- `villain` (`facts.turn.villain`, `facts.river.villain`: the range's shape,
-- read from the hand) is a different thing and stays.
--
-- Same function, same signature, same rules (surface, opt-in, poll reveal,
-- stale-version fallback, named keys) as `20270224090000`; only the facts
-- line of step 5 changes. Security definer, `search_path` empty, grants as
-- before. Nothing stored is dropped: the owner's own read (`analysis_hand`)
-- is unchanged.

begin;

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
  v_version text;
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

  -- 4. The row at the requested version, else the newest older one: after a
  --    version bump the owner has not re-run the analysis yet, and an older
  --    analysis, marked as such, beats a blank (A5a). Never a newer one: a
  --    client that asks for an older version cannot read what it has not met.
  select a.analysis_version into v_version
  from public.hand_analysis a
  where a.hand_id = v_hand
    and a.owner_id = v_owner
    and split_part(a.analysis_version, '/', 2)::numeric <= split_part(p_version, '/', 2)::numeric
  order by split_part(a.analysis_version, '/', 2)::numeric desc
  limit 1;
  if v_version is null then
    return null;
  end if;

  -- 5. Named keys only.
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
               -- An opponent's statistics are the owner's (analysis/20).
               'facts',          public.analysis_public_facts(d.facts) - 'villain') order by d.ord)
      from public.decision_analysis d
      where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)
  )
  || case when v_version <> p_version then jsonb_build_object('staleVersion', true) else '{}'::jsonb end
  into v_out
  from public.hand_analysis a
  where a.hand_id = v_hand
    and a.analysis_version = v_version
    and a.owner_id = v_owner;

  return v_out;
end;
$$;

revoke all on function public.read_shared_analysis(text, text, text) from public;
grant execute on function public.read_shared_analysis(text, text, text) to anon, authenticated;

comment on function public.read_shared_analysis(text, text, text) is
  'The analysis of the hand behind a public surface (published / post / share), at one version - or, '
  'when the hand has none there, the newest older one flagged staleVersion - when its owner has shared it '
  '(analysis_shares). Polls: only after the reveal. Named keys, no ids, never an opponent''s statistics '
  '(facts.villain). Null otherwise.';

commit;
