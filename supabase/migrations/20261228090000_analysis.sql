-- ===========================================================================
-- Hand analysis, phase A1: storage, the write path, the reports
-- ===========================================================================
--
-- `docs/ANALYSIS-PLAN.md` is the plan; `frontend/src/lib/analysis` is the
-- engine (pure TypeScript, tested over the corpus). This is where its answer
-- lives and how the Analysis tab reads it.
--
-- ## Two tables, versioned like statistics
--
--   hand_analysis      one row per (hand, analysis_version): status, the
--                      not-analysed reason, the hand's grade and score (null
--                      until A2 brings a reference), flag counts, approximations.
--   decision_analysis  one row per hero decision of an analysed hand: street,
--                      action, grade columns kept narrow so a report can
--                      `group by street, grade`, plus `flags` and `facts` jsonb
--                      for the hand panel.
--
-- `analysis_version` (`analysis/N`) is part of both keys. A version bump makes
-- every row obsolete at once; the rebuild writes the new generation beside the
-- old and `prune_hand_analysis` clears the old one on the last slice -- the path
-- `hand_stats` proved in `20261221090000`. No report ever mixes versions: each
-- one takes the version it reads, and the client always sends it.
--
-- ## The security model, unchanged (`docs/DATABASE.md`, rules 4-6)
--
--   * **No client role holds INSERT, UPDATE or DELETE on either table.** Both
--     are `select` to `authenticated`, scoped to the owner by RLS, and nothing to
--     `anon`. This is stricter than `hand_stats`, which grants INSERT and DELETE
--     under RLS: analysis rows carry server-checked aggregates (`decisions`,
--     `analysed`, `flag_count`, `worst_flag`) that a direct insert could set to
--     anything, so the only write path is the function that computes them.
--   * **Writes go through `save_hand_analysis`, `security definer`, as the
--     caller.** Being definer, RLS does not protect it, so it checks ownership
--     itself: every row is joined to `public.hands` on `id` *and*
--     `owner_id = auth.uid()`, and a row naming somebody else's hand is
--     skipped exactly as a row naming no hand is -- one answer for both, so the
--     function is not an oracle for which hand ids exist.
--   * **Deletes go through `prune_hand_analysis`**, definer, which can only
--     remove the caller's rows at a version other than the one it keeps.
--   * **Reads are `security invoker`**: RLS scopes every row a report sums. The
--     helper they share (`analysis_scope`) is granted to `authenticated`, which
--     is the lesson of `20261109090000`: an invoker report that calls a helper
--     its caller cannot execute fails for every real user and works in every
--     superuser session it was tested in.
--   * Every function sets `search_path = ''` and schema-qualifies everything.
--
-- ## Where it runs
--
-- In the browser (§5, §8.3): the client pages through `hands_needing_analysis`,
-- runs `analyzeHand` in a Web Worker and writes through `save_hand_analysis`.
-- "Missing" is computed, not tracked, so an interrupted run resumes by being run
-- again, and two tabs running at once are harmless (`on conflict do nothing`).
-- ===========================================================================

begin;

-- `/analysis` is a new top-level route, so nobody may register it as a
-- username -- the rule `lib/routes.ts` states for every top-level segment.
insert into public.username_reservations (username_lower, reason)
values ('analysis', 'route')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 1. hand_analysis
-- ---------------------------------------------------------------------------

create table if not exists public.hand_analysis (
  hand_id          uuid not null references public.hands (id) on delete cascade,
  owner_id         uuid not null references auth.users (id) on delete cascade,
  analysis_version text not null check (analysis_version ~ '^analysis/[0-9]+$'),
  status           text not null check (status in ('full', 'partial', 'not-analysed')),
  -- Why not analysed (`HAND_SKIP_REASONS` in lib/analysis/types.ts). The shape
  -- is checked rather than the list, so a new reason is a client change.
  reason           text check (reason is null or reason ~ '^[a-z][a-z0-9-]{0,39}$'),
  hero_seat        smallint check (hero_seat between 0 and 24),
  -- The grade half (§2). Null on every A1 row: there is no reference yet.
  grade            text check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  score            numeric(6, 2) check (score between 0 and 100),
  ev_loss_bb       numeric(12, 3) check (ev_loss_bb >= 0),
  ev_loss_pot      numeric(10, 4) check (ev_loss_pot >= 0),
  -- Computed by `save_hand_analysis` from the decisions it was sent, never
  -- taken from the client, so the list and the hand panel cannot disagree.
  decisions        smallint not null default 0 check (decisions between 0 and 200),
  analysed         smallint not null default 0,
  flag_count       smallint not null default 0 check (flag_count >= 0),
  worst_flag       text check (worst_flag in ('note', 'inaccurate')),
  approximations   text[] not null default '{}'
    check (cardinality(approximations) <= 16
           and array_to_string(approximations, ',') ~ '^([a-z][a-z0-9-]{0,39}(,[a-z][a-z0-9-]{0,39})*)?$'),
  -- Same reading as `hand_stats.pot_type`, for the breakdown.
  pot_type         text check (pot_type is null or pot_type in ('walk', 'bomb', 'limped', 'single-raised', '3bet', '4bet+')),
  created_at       timestamptz not null default now(),
  primary key (hand_id, analysis_version),
  constraint hand_analysis_analysed_le check (analysed between 0 and decisions),
  -- The status is a function of the counts; holding it here means a writer bug
  -- is a refused row, not a hand listed as "full" with nothing in it.
  constraint hand_analysis_status_counts check (
    case status
      when 'full'         then decisions > 0 and analysed = decisions and reason is null
      when 'partial'      then analysed > 0 and analysed < decisions and reason is null
      else                     analysed = 0 and reason is not null
    end)
);

comment on table public.hand_analysis is
  'One row per (hand, analysis_version): status, not-analysed reason, grade/score '
  '(null until a reference exists), flag counts. Derived from hands.phf by '
  'lib/analysis; written only by save_hand_analysis.';

create index if not exists hand_analysis_owner_version_idx
  on public.hand_analysis (owner_id, analysis_version);

-- ---------------------------------------------------------------------------
-- 2. decision_analysis
-- ---------------------------------------------------------------------------

create table if not exists public.decision_analysis (
  hand_id          uuid not null,
  owner_id         uuid not null references auth.users (id) on delete cascade,
  analysis_version text not null,
  -- `Decision.order` from the stats engine: the decision's index in the hand.
  ord              smallint not null check (ord between 0 and 999),
  -- `PhfAction.index`: what the replayer seeks to. Stable across serialization.
  action_index     integer not null check (action_index >= 0),
  street           text not null check (street in ('preflop', 'flop', 'turn', 'river')),
  action           text not null check (action in ('fold', 'check', 'call', 'bet', 'raise')),
  status           text not null check (status in ('analysed', 'not-analysed')),
  reason           text check (reason is null or reason ~ '^[a-z][a-z0-9-]{0,39}$'),
  node             text not null check (char_length(node) between 1 and 200),
  scenario         text not null check (scenario ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  source           text not null check (source in ('chart', 'solver', 'heuristic')),
  grade            text check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  score            numeric(6, 2) check (score between 0 and 100),
  ev_loss_bb       numeric(12, 3) check (ev_loss_bb >= 0),
  ev_loss_pot      numeric(10, 4) check (ev_loss_pot >= 0),
  freq_diff        numeric(5, 4) check (freq_diff between 0 and 1),
  options          jsonb not null default '[]'::jsonb
    check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 12),
  chosen           smallint check (chosen between 0 and 11),
  flags            jsonb not null default '[]'::jsonb
    check (jsonb_typeof(flags) = 'array' and jsonb_array_length(flags) <= 16),
  worst_flag       text check (worst_flag in ('note', 'inaccurate')),
  approximations   text[] not null default '{}'
    check (cardinality(approximations) <= 16
           and array_to_string(approximations, ',') ~ '^([a-z][a-z0-9-]{0,39}(,[a-z][a-z0-9-]{0,39})*)?$'),
  -- Pot geometry kept as columns, so the overview can set defence frequency
  -- against MDF per street without unpacking `facts`.
  facing_bet       boolean not null default false,
  pot_bb           numeric(12, 2) check (pot_bb >= 0),
  pot_odds         numeric(5, 3) check (pot_odds between 0 and 1),
  mdf              numeric(5, 3) check (mdf between 0 and 1),
  -- `SpotFacts` (texture, hand class, draws, blockers, equity), for the panel.
  facts            jsonb not null default '{}'::jsonb
    check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 16384),
  created_at       timestamptz not null default now(),
  primary key (hand_id, analysis_version, ord),
  foreign key (hand_id, analysis_version)
    references public.hand_analysis (hand_id, analysis_version) on delete cascade,
  constraint decision_analysis_skip_reason check ((status = 'analysed') = (reason is null)),
  -- Every element of `flags` names a code and a severity no louder than
  -- "inaccurate": §3.6's cap, held by the database as well as by the type.
  constraint decision_analysis_flag_shape check (
    not jsonb_path_exists(flags,
      '$[*] ? (!(@.code.type() == "string" && (@.severity == "note" || @.severity == "inaccurate")))'))
);

comment on table public.decision_analysis is
  'One row per hero decision of an analysed hand: street, action, grade columns '
  '(null until a reference exists), heuristic flags and spot facts.';

create index if not exists decision_analysis_owner_version_idx
  on public.decision_analysis (owner_id, analysis_version);

-- ---------------------------------------------------------------------------
-- 3. RLS: select-own, nothing else, for anyone
-- ---------------------------------------------------------------------------

alter table public.hand_analysis enable row level security;
alter table public.decision_analysis enable row level security;

revoke all on public.hand_analysis from anon, authenticated;
revoke all on public.decision_analysis from anon, authenticated;
grant select on public.hand_analysis to authenticated;
grant select on public.decision_analysis to authenticated;

drop policy if exists hand_analysis_owner_select on public.hand_analysis;
create policy hand_analysis_owner_select on public.hand_analysis
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists decision_analysis_owner_select on public.decision_analysis;
create policy decision_analysis_owner_select on public.decision_analysis
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. The read side of the rebuild
-- ---------------------------------------------------------------------------
--
-- One page of the caller's hands with no row at `p_version`, with the document
-- to analyse. Every hand is offered, hero or not: a hand without a hero gets a
-- `not-analysed / no-hero` row, so the coverage line can say why rather than
-- counting it as missing forever.
--
-- The document is trimmed on the way out. The analysis reads the game, the
-- seats, the action stream and the board; it never reads the source text or the
-- per-line echoes the replayer's log shows, which are most of the bytes. A
-- backfill of a 5,000-hand library downloads ~35 MB instead of ~50 MB.

create or replace function public.hands_needing_analysis(
  p_version text,
  p_after   uuid    default null,
  p_limit   integer default 100
)
returns table (id uuid, phf jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis needs an analysis_version.' using errcode = '22023';
  end if;

  return query
  select hd.id,
         jsonb_set(
           hd.phf #- '{meta,rawText}',
           '{actions}',
           coalesce((select jsonb_agg(a - 'rawLine' - 'label' order by ord)
                     from jsonb_array_elements(hd.phf -> 'actions') with ordinality as x(a, ord)),
                    '[]'::jsonb))
  from public.hands hd
  where hd.owner_id = v_owner
    and (p_after is null or hd.id > p_after)
    and not exists (
      select 1 from public.hand_analysis a
      where a.hand_id = hd.id and a.analysis_version = p_version)
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.hands_needing_analysis(text, uuid, integer) is
  'A keyset page of the caller''s hands with no hand_analysis row at the given '
  'version, with a trimmed phf. Read side of the in-browser analysis; RLS-scoped.';

revoke all on function public.hands_needing_analysis(text, uuid, integer) from public, anon;
grant execute on function public.hands_needing_analysis(text, uuid, integer) to authenticated;

-- How much of the library the analysis is about:
--   hands        every hand the caller has
--   atVersion    ... with a row at `p_version`
--   stale        ... with rows only at other versions (a version bump)
--   missing      ... with no row at all
--   obsoleteRows hand rows at other versions, i.e. what prune frees

create or replace function public.analysis_coverage(p_version text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_coverage needs an analysis_version.' using errcode = '22023';
  end if;

  with h as (
    select
      exists (select 1 from public.hand_analysis a
              where a.hand_id = hd.id and a.analysis_version = p_version) as is_current,
      exists (select 1 from public.hand_analysis a
              where a.hand_id = hd.id and a.analysis_version <> p_version) as has_old
    from public.hands hd
    where hd.owner_id = v_owner
  )
  select jsonb_build_object(
    'analysisVersion', p_version,
    'hands',           count(*),
    'atVersion',       count(*) filter (where is_current),
    'stale',           count(*) filter (where not is_current and has_old),
    'missing',         count(*) filter (where not is_current and not has_old),
    'obsoleteRows', (
      select count(*) from public.hand_analysis a
      where a.owner_id = v_owner and a.analysis_version <> p_version)
  )
  into v_out
  from h;

  return v_out;
end;
$$;

revoke all on function public.analysis_coverage(text) from public, anon;
grant execute on function public.analysis_coverage(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. save_hand_analysis -- the only write path
-- ---------------------------------------------------------------------------
--
-- `p_rows` is an array of hands, each carrying its decisions:
--
--   { hand_id, analysis_version, status, reason, hero_seat, grade, score,
--     ev_loss_bb, ev_loss_pot, approximations, pot_type,
--     decisions: [{ ord, action_index, street, action, status, reason, node,
--                   scenario, source, grade, score, ev_loss_bb, ev_loss_pot,
--                   freq_diff, options, chosen, flags, approximations,
--                   facing_bet, pot_bb, pot_odds, mdf, facts }] }
--
-- `decisions`, `analysed`, `flag_count` and both `worst_flag`s are computed
-- here from what was sent, and anything else the client put in their place is
-- ignored. `on conflict do nothing`: a re-analysis under the same version is
-- by definition identical, and a new version is a new key. Decisions are only
-- written for hands whose row this call inserted, so a replayed request cannot
-- graft decisions onto an analysis that already exists.

create or replace function public.save_hand_analysis(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner     uuid := (select auth.uid());
  v_received  integer;
  v_owned     integer;
  v_inserted  integer;
  v_decisions integer;
  v_keys      text[];
begin
  if v_owner is null then
    raise exception 'You must be signed in to save an analysis.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_analysis expects a JSON array of hands.' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0, 'skipped', 0, 'decisions', 0);
  end if;
  if v_received > 200 then
    raise exception 'save_hand_analysis accepts at most 200 hands per call (got %).', v_received
      using errcode = '53400';
  end if;

  -- Per account, not global: one library's backfill must not lock every other
  -- account out of theirs. Charged per hand and per decision.
  perform public.enforce_rate_limit(
    'analysis_insert:' || v_owner::text,
    v_received + coalesce((
      select sum(case when jsonb_typeof(e -> 'decisions') = 'array'
                      then jsonb_array_length(e -> 'decisions') else 0 end)::integer
      from jsonb_array_elements(p_rows) e), 0),
    60000,
    interval '10 minutes');

  with input as (
    select x.*, e.value -> 'decisions' as decision_list
    from jsonb_array_elements(p_rows) e,
         jsonb_to_record(e.value) as x(
           hand_id uuid, analysis_version text, status text, reason text,
           hero_seat smallint, grade text, score numeric, ev_loss_bb numeric,
           ev_loss_pot numeric, approximations text[], pot_type text)
  ),
  owned as (
    -- The ownership check. Definer functions are not protected by RLS, so the
    -- join names the owner explicitly; a foreign or unknown hand id drops out
    -- here and is counted as skipped, indistinguishably.
    select i.*
    from input i
    join public.hands h on h.id = i.hand_id and h.owner_id = v_owner
  ),
  ins as (
    insert into public.hand_analysis (
      hand_id, owner_id, analysis_version, status, reason, hero_seat, grade,
      score, ev_loss_bb, ev_loss_pot, decisions, analysed, flag_count,
      worst_flag, approximations, pot_type)
    select
      o.hand_id, v_owner, o.analysis_version, o.status, o.reason, o.hero_seat,
      o.grade, o.score, o.ev_loss_bb, o.ev_loss_pot,
      coalesce(d.n, 0), coalesce(d.analysed, 0), coalesce(d.flags, 0), d.worst,
      coalesce(o.approximations, '{}'), o.pot_type
    from owned o
    left join lateral (
      select count(*)::smallint as n,
             count(*) filter (where dl ->> 'status' = 'analysed')::smallint as analysed,
             coalesce(sum(case when jsonb_typeof(dl -> 'flags') = 'array'
                               then jsonb_array_length(dl -> 'flags') else 0 end), 0)::smallint as flags,
             case
               when bool_or(dl -> 'flags' @> '[{"severity":"inaccurate"}]') then 'inaccurate'
               when bool_or(jsonb_typeof(dl -> 'flags') = 'array' and jsonb_array_length(dl -> 'flags') > 0) then 'note'
             end as worst
      from jsonb_array_elements(case when jsonb_typeof(o.decision_list) = 'array'
                                     then o.decision_list else '[]'::jsonb end) dl
    ) d on true
    on conflict (hand_id, analysis_version) do nothing
    returning hand_id::text || '|' || analysis_version
  )
  select (select count(*) from owned)::integer, array_agg(k)
    into v_owned, v_keys
  from (select * from ins) as r(k);

  v_inserted := coalesce(cardinality(v_keys), 0);

  insert into public.decision_analysis (
    hand_id, owner_id, analysis_version, ord, action_index, street, action,
    status, reason, node, scenario, source, grade, score, ev_loss_bb,
    ev_loss_pot, freq_diff, options, chosen, flags, worst_flag, approximations,
    facing_bet, pot_bb, pot_odds, mdf, facts)
  select
    (e.value ->> 'hand_id')::uuid, v_owner, e.value ->> 'analysis_version',
    x.ord, x.action_index, x.street, x.action, x.status, x.reason, x.node,
    x.scenario, x.source, x.grade, x.score, x.ev_loss_bb, x.ev_loss_pot,
    x.freq_diff, coalesce(x.options, '[]'::jsonb), x.chosen,
    coalesce(x.flags, '[]'::jsonb),
    case
      when coalesce(x.flags, '[]'::jsonb) @> '[{"severity":"inaccurate"}]' then 'inaccurate'
      when jsonb_array_length(coalesce(x.flags, '[]'::jsonb)) > 0 then 'note'
    end,
    coalesce(x.approximations, '{}'), coalesce(x.facing_bet, false), x.pot_bb,
    x.pot_odds, x.mdf, coalesce(x.facts, '{}'::jsonb)
  from jsonb_array_elements(p_rows) e
  cross join lateral jsonb_to_recordset(
    case when jsonb_typeof(e.value -> 'decisions') = 'array'
         then e.value -> 'decisions' else '[]'::jsonb end) as x(
      ord smallint, action_index integer, street text, action text, status text,
      reason text, node text, scenario text, source text, grade text,
      score numeric, ev_loss_bb numeric, ev_loss_pot numeric, freq_diff numeric,
      options jsonb, chosen smallint, flags jsonb, approximations text[],
      facing_bet boolean, pot_bb numeric, pot_odds numeric, mdf numeric, facts jsonb)
  where ((e.value ->> 'hand_id') || '|' || (e.value ->> 'analysis_version')) = any (coalesce(v_keys, '{}'))
  on conflict (hand_id, analysis_version, ord) do nothing;

  get diagnostics v_decisions = row_count;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   v_inserted,
    -- Hands found but already analysed at that version.
    'duplicates', v_owned - v_inserted,
    -- Hands this caller does not have. Not an error, and not distinguished
    -- from "no such hand".
    'skipped',    v_received - v_owned,
    'decisions',  v_decisions
  );
end;
$$;

comment on function public.save_hand_analysis(jsonb) is
  'Stores the caller''s analysis of their own hands (definer; ownership checked '
  'explicitly against hands.owner_id). Aggregates are computed here.';

revoke all on function public.save_hand_analysis(jsonb) from public, anon;
grant execute on function public.save_hand_analysis(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. prune_hand_analysis -- the only delete path
-- ---------------------------------------------------------------------------
--
-- Removes the caller's hand rows at every version except `p_keep_version`
-- (their decisions go with them, by the cascade). Like `prune_hand_stats`:
-- definer because no client role can delete, scoped to `auth.uid()` by hand,
-- and bounded per call so a large library is pruned in slices.

create or replace function public.prune_hand_analysis(
  p_keep_version text,
  p_limit        integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_deleted integer;
  v_cap     integer := least(greatest(coalesce(p_limit, 5000), 1), 20000);
begin
  if v_owner is null then
    raise exception 'You must be signed in to prune the analysis.' using errcode = '42501';
  end if;
  if p_keep_version is null or p_keep_version !~ '^analysis/[0-9]+$' then
    raise exception 'prune_hand_analysis needs the analysis_version to keep.' using errcode = '22023';
  end if;

  with doomed as (
    select hand_id, analysis_version
    from public.hand_analysis
    where owner_id = v_owner and analysis_version <> p_keep_version
    limit v_cap
  )
  delete from public.hand_analysis a
  using doomed d
  where a.hand_id = d.hand_id and a.analysis_version = d.analysis_version
    and a.owner_id = v_owner;

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted, 'more', v_deleted >= v_cap);
end;
$$;

revoke all on function public.prune_hand_analysis(text, integer) from public, anon;
grant execute on function public.prune_hand_analysis(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Reports
-- ---------------------------------------------------------------------------
--
-- The filters every report takes, all optional, all bound as values (nothing
-- is interpolated into SQL):
--
--   analysisVersion   the version to read; defaults to analysis/1, but the
--                     client always sends it (`withVersion` in lib/db)
--   from, to          played_at range
--   site              hands.site
--   gameFormat        cash / tournament / sng / spin
--   currency, bigBlind  one stake
--   position          the hero's position
--   potType           walk / limped / single-raised / 3bet / 4bet+ / bomb
--   status            full / partial / not-analysed
--   street            has a hero decision on that street
--   flag              has a decision carrying that flag code
--   flagged           true: has any flag
--
-- `analysis_scope` is that predicate as a set-returning helper. It is invoker
-- like the reports, so RLS still scopes it, and it is granted to
-- `authenticated` because the reports run as their caller.

create or replace function public.analysis_version_of(p_filters jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_version text := coalesce(nullif(btrim(coalesce(p_filters ->> 'analysisVersion', '')), ''), 'analysis/1');
begin
  if v_version !~ '^analysis/[0-9]+$' then
    raise exception 'Not an analysis version: %', v_version using errcode = '22023';
  end if;
  return v_version;
end;
$$;

revoke all on function public.analysis_version_of(jsonb) from public, anon;
grant execute on function public.analysis_version_of(jsonb) to authenticated;

create or replace function public.analysis_scope(p_filters jsonb default '{}'::jsonb)
returns setof public.hand_analysis
language sql
stable
security invoker
set search_path = ''
as $$
  select a.*
  from public.hand_analysis a
  join public.hands h on h.id = a.hand_id
  where a.owner_id = (select auth.uid())
    and a.analysis_version = public.analysis_version_of(p_filters)
    and (nullif(p_filters ->> 'from', '') is null or h.played_at >= (p_filters ->> 'from')::timestamptz)
    and (nullif(p_filters ->> 'to', '') is null or h.played_at < (p_filters ->> 'to')::timestamptz)
    and (nullif(p_filters ->> 'site', '') is null or h.site = lower(btrim(p_filters ->> 'site')))
    and (nullif(p_filters ->> 'gameFormat', '') is null or h.game_format::text = p_filters ->> 'gameFormat')
    and (nullif(p_filters ->> 'currency', '') is null or h.currency = upper(btrim(p_filters ->> 'currency')))
    and (nullif(p_filters ->> 'bigBlind', '') is null or h.big_blind = (p_filters ->> 'bigBlind')::bigint)
    and (nullif(p_filters ->> 'position', '') is null or h.hero_position = upper(btrim(p_filters ->> 'position')))
    and (nullif(p_filters ->> 'potType', '') is null or a.pot_type = p_filters ->> 'potType')
    and (nullif(p_filters ->> 'status', '') is null or a.status = p_filters ->> 'status')
    and (coalesce((nullif(p_filters ->> 'flagged', ''))::boolean, false) = false or a.flag_count > 0)
    and (nullif(p_filters ->> 'street', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
            and d.street = p_filters ->> 'street'))
    and (nullif(p_filters ->> 'flag', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
            and d.flags @> jsonb_build_array(jsonb_build_object('code', p_filters ->> 'flag'))));
$$;

comment on function public.analysis_scope(jsonb) is
  'The caller''s hand_analysis rows at one version, filtered. Shared by the '
  'analysis reports; invoker, so RLS applies.';

revoke all on function public.analysis_scope(jsonb) from public, anon;
grant execute on function public.analysis_scope(jsonb) to authenticated;

-- ------------------------------------------------------ analysis_overview ---
--
-- The tab's headline numbers. Everything is a count or a mean over rows that
-- are already there; `grades`, `score` and `evLossBb` are empty or null until a
-- phase writes graded decisions, and the screen says so rather than showing
-- zeros that read as "you played perfectly".
--
-- Defence against MDF (`facingBet`, `defended`, `mdf`) counts postflop
-- decisions only. Preflop, folding most hands to an open is correct and the
-- price says nothing about it -- the reference there is a chart (A2), not
-- the pot odds -- so a preflop "defended 19% against an MDF of 53%" would read
-- as a leak that is not one.

create or replace function public.analysis_overview(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_version text := public.analysis_version_of(p_filters);
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;

  with s as materialized (select * from public.analysis_scope(p_filters)),
  d as (
    select dd.*
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
  ),
  f as (
    select d.street, fl ->> 'code' as code, fl ->> 'severity' as severity
    from d, jsonb_array_elements(d.flags) fl
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',           (select count(*) from s),
    'status', jsonb_build_object(
      'full',        (select count(*) from s where status = 'full'),
      'partial',     (select count(*) from s where status = 'partial'),
      'notAnalysed', (select count(*) from s where status = 'not-analysed')),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'hands', r.n) order by r.n desc, r.reason)
      from (select reason, count(*) as n from s where status = 'not-analysed' group by reason) r), '[]'::jsonb),
    'skipped', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'decisions', r.n) order by r.n desc, r.reason)
      from (select reason, count(*) as n from d where status = 'not-analysed' group by reason) r), '[]'::jsonb),
    'decisions',      (select count(*) from d),
    'analysed',       (select count(*) from d where status = 'analysed'),
    'flagged',        (select count(*) from d where worst_flag is not null),
    'flaggedHands',   (select count(*) from s where flag_count > 0),
    'flags', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'street', x.street, 'severity', x.severity, 'count', x.n)
                       order by x.n desc, x.code, x.street)
      from (select code, street, severity, count(*) as n from f group by 1, 2, 3) x), '[]'::jsonb),
    'streets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'street',    x.street,
               'decisions', x.n,
               'analysed',  x.analysed,
               'flagged',   x.flagged,
               'facingBet', x.facing,
               'defended',  x.defended,
               'mdf',       x.mdf)
             order by array_position(array['preflop', 'flop', 'turn', 'river'], x.street))
      from (
        select street,
               count(*) as n,
               count(*) filter (where status = 'analysed') as analysed,
               count(*) filter (where worst_flag is not null) as flagged,
               count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop') as facing,
               count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop' and action in ('call', 'raise')) as defended,
               round(avg(mdf) filter (where facing_bet and status = 'analysed' and street <> 'preflop'), 3) as mdf
        from d group by street) x), '[]'::jsonb),
    'grades', coalesce((
      select jsonb_agg(jsonb_build_object('grade', x.grade, 'decisions', x.n)
                       order by array_position(array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'], x.grade))
      from (select grade, count(*) as n from d where grade is not null group by grade) x), '[]'::jsonb),
    'score',      (select round(avg(score), 2) from d where score is not null),
    'evLossBb',   (select round(sum(ev_loss_bb), 3) from d where ev_loss_bb is not null),
    'approximations', coalesce((
      select jsonb_agg(jsonb_build_object('approximation', x.ap, 'hands', x.n) order by x.n desc, x.ap)
      from (select ap, count(*) as n from s, unnest(s.approximations) ap group by ap) x), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.analysis_overview(jsonb) from public, anon;
grant execute on function public.analysis_overview(jsonb) to authenticated;

-- ----------------------------------------------------- analysis_breakdown ---
--
-- Decisions split by one dimension: `street`, `position` (the hero's),
-- `pot_type` or `scenario`. The group key picks a literal out of a fixed
-- `case`; anything else is 22023, never a column name from the client.

create or replace function public.analysis_breakdown(
  p_filters jsonb default '{}'::jsonb,
  p_group   text  default 'street'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_rows  jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('street', 'position', 'pot_type', 'scenario') then
    raise exception 'Unknown analysis breakdown: %', coalesce(p_group, 'null') using errcode = '22023';
  end if;

  with s as (select * from public.analysis_scope(p_filters)),
  d as (
    select dd.*, h.hero_position, s.pot_type as hand_pot_type
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    join public.hands h on h.id = dd.hand_id
  ),
  keyed as (
    select case p_group
             when 'street'   then d.street
             when 'position' then d.hero_position
             when 'pot_type' then d.hand_pot_type
             else d.scenario
           end as key,
           d.*
    from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',        x.key,
           'hands',      x.hands,
           'decisions',  x.n,
           'analysed',   x.analysed,
           'flagged',    x.flagged,
           'inaccurate', x.inaccurate,
           'facingBet',  x.facing,
           'defended',   x.defended,
           'mdf',        x.mdf)
         order by case when p_group = 'street'
                       then array_position(array['preflop', 'flop', 'turn', 'river'], x.key)
                       else null end,
                  x.n desc, x.key), '[]'::jsonb)
    into v_rows
  from (
    select key,
           count(distinct hand_id) as hands,
           count(*) as n,
           count(*) filter (where status = 'analysed') as analysed,
           count(*) filter (where worst_flag is not null) as flagged,
           count(*) filter (where worst_flag = 'inaccurate') as inaccurate,
           count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop') as facing,
           count(*) filter (where facing_bet and status = 'analysed' and street <> 'preflop' and action in ('call', 'raise')) as defended,
           round(avg(mdf) filter (where facing_bet and status = 'analysed' and street <> 'preflop'), 3) as mdf
    from keyed
    group by key
  ) x;

  return jsonb_build_object('group', p_group, 'rows', v_rows);
end;
$$;

revoke all on function public.analysis_breakdown(jsonb, text) from public, anon;
grant execute on function public.analysis_breakdown(jsonb, text) to authenticated;

-- --------------------------------------------------------- analysis_hands ---
--
-- One page of analysed hands, with what the list draws: the hand's own columns
-- and one entry per hero decision (street, action, grade, loudest flag) for the
-- coloured action letters. Sort keys are whitelisted.

create or replace function public.analysis_hands(
  p_filters jsonb   default '{}'::jsonb,
  p_sort    text    default 'recent',
  p_limit   integer default 25,
  p_offset  integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner  uuid := (select auth.uid());
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'recent');
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_sort not in ('recent', 'oldest', 'flags', 'ev_loss', 'score', 'result') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  select count(*) into v_total from public.analysis_scope(p_filters);

  select coalesce(jsonb_agg(row_json order by rn), '[]'::jsonb)
    into v_rows
  from (
    select
      row_number() over (
        order by
          case when v_sort = 'oldest' then h.played_at end asc nulls last,
          case when v_sort = 'flags' then a.flag_count end desc,
          case when v_sort = 'flags' then a.worst_flag end asc nulls last,
          case when v_sort = 'ev_loss' then a.ev_loss_bb end desc nulls last,
          case when v_sort = 'score' then a.score end asc nulls last,
          case when v_sort = 'result' and h.big_blind > 0
               then h.hero_profit::numeric / h.big_blind end asc nulls last,
          h.played_at desc nulls last,
          a.hand_id
      ) as rn,
      jsonb_build_object(
        'handId',             a.hand_id,
        'playedAt',           h.played_at,
        'site',               h.site,
        'stakesLabel',        h.stakes_label,
        'gameFormat',         h.game_format,
        'currency',           h.currency,
        'currencyMinorUnits', h.currency_minor_units,
        'bigBlind',           h.big_blind,
        'position',           h.hero_position,
        'heroCards',          to_jsonb(h.hero_cards),
        'handClass',          h.hero_hand_class,
        'potType',            a.pot_type,
        'status',             a.status,
        'reason',             a.reason,
        'grade',              a.grade,
        'score',              a.score,
        'evLossBb',           a.ev_loss_bb,
        'evLossPot',          a.ev_loss_pot,
        'flagCount',          a.flag_count,
        'worstFlag',          a.worst_flag,
        'netBb', case when h.big_blind > 0 and h.hero_profit is not null
                      then round(h.hero_profit::numeric / h.big_blind, 2) end,
        'decisions', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'ord',         d.ord,
                   'actionIndex', d.action_index,
                   'street',      d.street,
                   'action',      d.action,
                   'status',      d.status,
                   'grade',       d.grade,
                   'worstFlag',   d.worst_flag) order by d.ord)
          from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version), '[]'::jsonb)
      ) as row_json
    from public.analysis_scope(p_filters) a
    join public.hands h on h.id = a.hand_id
    order by rn
    offset v_offset
    limit v_limit
  ) page;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$$;

revoke all on function public.analysis_hands(jsonb, text, integer, integer) from public, anon;
grant execute on function public.analysis_hands(jsonb, text, integer, integer) to authenticated;

-- ---------------------------------------------------------- analysis_hand ---
--
-- One hand's analysis with every decision in full, for the hand panel. Null for
-- a hand the caller does not have *or* has not analysed at that version: RLS
-- makes the first indistinguishable from the second, which is the right answer
-- to a guessed id.

create or replace function public.analysis_hand(
  p_hand_id uuid,
  p_version text default 'analysis/1'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_hand needs an analysis_version.' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'handId',          a.hand_id,
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
               'options',        d.options,
               'chosen',         d.chosen,
               'flags',          d.flags,
               'worstFlag',      d.worst_flag,
               'approximations', to_jsonb(d.approximations),
               'facts',          d.facts) order by d.ord)
      from public.decision_analysis d
      where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version), '[]'::jsonb)
  )
  into v_out
  from public.hand_analysis a
  where a.hand_id = p_hand_id
    and a.analysis_version = p_version
    and a.owner_id = v_owner;

  return v_out;
end;
$$;

revoke all on function public.analysis_hand(uuid, text) from public, anon;
grant execute on function public.analysis_hand(uuid, text) to authenticated;

commit;
