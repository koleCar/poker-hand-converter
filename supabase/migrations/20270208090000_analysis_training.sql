-- ===========================================================================
-- Hand analysis, phase A7: training
-- ===========================================================================
--
-- `docs/ANALYSIS-PLAN.md` §0.1 (*Practice*, the trainer's move classes), §2
-- (grades and scores) and §7 (A7). The trainer itself is in the browser
-- (`frontend/src/lib/training`): it deals spots from the charts and the river
-- solver and grades answers with the analysis. What the database keeps is
-- what has to outlive a page:
--
--   drill_items      one row per (owner, hand, decision) the player is
--                    drilling: one of their own graded decisions, Mistake or
--                    worse, with its spaced-repetition state (SM-2: reps,
--                    lapses, ease, interval, due date).
--   drill_reviews    every answer to a drill: what was chosen, its grade and
--                    EV loss, and the schedule it led to. The history behind
--                    a drill's state.
--   trainer_results  every graded answer in the preflop and river trainers:
--                    the spot (family, chart line or river line), the grade,
--                    EV lost, the move score. Session stats live in the page;
--                    these are the long view.
--
--   drill_quality        helper: a grade as SM-2's quality (Perfect 5 ...
--                        Blunder 0).
--   drill_next           helper: the scheduling arithmetic, one review.
--                        `lib/training/schedule.ts` is the same function in
--                        TypeScript and the two are tested on one table.
--   sync_drill_items     builds drills from the caller's graded decisions
--                        (Mistake or worse by default; Inaccurate optionally).
--   review_drill         records one answer and reschedules the drill.
--   record_trainer_results  records trainer answers.
--   drill_queue          the drills to play now (or a leak's drills).
--   drill_summary        how many drills there are, due now, due today, and
--                        decisions not drilled yet.
--   drill_due_by_spot    the same per finest leak spot, for the Leaks rows.
--   trainer_summary      answers, grade counts, EV lost and mean score per
--                        trainer mode, over a window and in total.
--
-- ## Drills follow the analysis version
--
-- A drill names its decision by `(hand_id, action_index)`, which a re-analysis
-- does not change, and remembers the `analysis_version` and `ord` of the row it
-- was built from. When a new version is synced the drill is re-pointed at the
-- new row and keeps its schedule; the queue reads only drills whose row exists
-- at the version it is asked for, so a decision a new version no longer calls
-- a mistake simply stops coming up (its row still exists, but its grade is
-- whatever the new version says -- the drill is graded against the new
-- options). Deleting a hand deletes its drills (`on delete cascade`).
--
-- ## The security model (`20261228090000_analysis.sql`, unchanged)
--
--   * **No client role holds INSERT, UPDATE or DELETE on any of the three
--     tables.** `select` to `authenticated`, scoped to the owner by RLS;
--     nothing to `anon`.
--   * **Writes go through `security definer` functions, as the caller**, each
--     with an explicit `auth.uid()` ownership check (definer functions are not
--     protected by RLS): a drill is built only from a decision whose hand the
--     caller owns, and a review names a drill by id *and* owner, so another
--     account's drill and no drill at all get the same answer.
--   * Every write is rate-limited per account (`enforce_rate_limit`), as
--     `save_hand_analysis` is.
--   * Inputs are validated: grades against the five names, option indices
--     against the stored options, EV losses and scores against their ranges,
--     spot names against fixed shapes.
--   * **The grade of an answer comes from the client.** The trainer grades in
--     the browser with the analysis engine; the database checks the shape and
--     the bounds, not the poker. A player who sends a false grade only
--     reschedules their own drills and skews their own trainer stats -- no
--     other account reads either.
--   * Reads are `security invoker`; their helpers are executable by
--     `authenticated` (the lesson of `20261109090000`). Every function pins
--     `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.drill_items (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  hand_id           uuid not null references public.hands (id) on delete cascade,
  -- `PhfAction.index` of the decision: stable across re-analysis.
  action_index      integer not null check (action_index >= 0),
  -- The graded row it was built from (re-pointed by a sync at a newer version).
  analysis_version  text not null check (analysis_version ~ '^analysis/[0-9]+$'),
  ord               smallint not null check (ord between 0 and 999),
  street            text not null check (street in ('preflop', 'flop', 'turn', 'river')),
  -- `analysis_spot_key` of the decision: what a leak's "Drill this" selects by.
  spot_key          text not null check (char_length(spot_key) between 5 and 200),
  source_grade      text not null check (source_grade in ('inaccurate', 'mistake', 'blunder')),
  source_ev_loss_bb numeric(12, 3) not null default 0 check (source_ev_loss_bb >= 0),
  -- SM-2 state (`lib/training/schedule.ts`).
  reps              smallint not null default 0 check (reps between 0 and 10000),
  lapses            smallint not null default 0 check (lapses between 0 and 10000),
  ease              numeric(4, 2) not null default 2.50 check (ease between 1.30 and 3.00),
  interval_days     smallint not null default 0 check (interval_days between 0 and 365),
  due_at            timestamptz not null default now(),
  reviews           integer not null default 0 check (reviews >= 0),
  last_grade        text check (last_grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  last_reviewed_at  timestamptz,
  created_at        timestamptz not null default now(),
  constraint drill_items_one_per_decision unique (owner_id, hand_id, action_index)
);

comment on table public.drill_items is
  'One drill per (owner, hand, decision): a graded Mistake or worse of the owner''s, with its '
  'spaced-repetition state. Written only by sync_drill_items and review_drill.';

create index if not exists drill_items_owner_due_idx on public.drill_items (owner_id, due_at);
create index if not exists drill_items_owner_spot_idx on public.drill_items (owner_id, spot_key);
create index if not exists drill_items_hand_idx on public.drill_items (hand_id);

create table if not exists public.drill_reviews (
  id            bigint generated always as identity primary key,
  item_id       uuid not null references public.drill_items (id) on delete cascade,
  owner_id      uuid not null references auth.users (id) on delete cascade,
  reviewed_at   timestamptz not null default now(),
  chosen        smallint not null check (chosen between 0 and 11),
  grade         text not null check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  ev_loss_bb    numeric(12, 3) not null check (ev_loss_bb between 0 and 1000),
  quality       smallint not null check (quality between 0 and 5),
  -- The schedule this answer led to.
  ease          numeric(4, 2) not null check (ease between 1.30 and 3.00),
  interval_days smallint not null check (interval_days between 0 and 365),
  due_at        timestamptz not null
);

comment on table public.drill_reviews is
  'Every answer to a drill and the schedule it led to. Written only by review_drill.';

create index if not exists drill_reviews_owner_idx on public.drill_reviews (owner_id, reviewed_at);
create index if not exists drill_reviews_item_idx on public.drill_reviews (item_id);

create table if not exists public.trainer_results (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  mode        text not null check (mode in ('preflop', 'river', 'drill')),
  -- Preflop: the scenario family (`rfi`, `vs-open`, ...); river: the pot type.
  family      text not null check (family ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  -- Preflop: the chart line; river: the preflop line id; drill: the spot key.
  spot        text not null default '' check (char_length(spot) <= 200),
  position    text check (position ~ '^[A-Z0-9+]{1,8}$'),
  hand_class  text check (hand_class ~ '^[2-9TJQKA]{2}[so]?$'),
  grade       text not null check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  ev_loss_bb  numeric(12, 3) not null check (ev_loss_bb between 0 and 1000),
  ev_loss_pot numeric(10, 4) not null check (ev_loss_pot between 0 and 100),
  score       numeric(6, 2) not null check (score between 0 and 100),
  created_at  timestamptz not null default now()
);

comment on table public.trainer_results is
  'Every graded trainer answer (preflop, river, drill). Written only by record_trainer_results.';

create index if not exists trainer_results_owner_idx on public.trainer_results (owner_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. RLS: select-own, nothing else, for anyone
-- ---------------------------------------------------------------------------

alter table public.drill_items enable row level security;
alter table public.drill_reviews enable row level security;
alter table public.trainer_results enable row level security;

revoke all on public.drill_items from anon, authenticated;
revoke all on public.drill_reviews from anon, authenticated;
revoke all on public.trainer_results from anon, authenticated;
grant select on public.drill_items to authenticated;
grant select on public.drill_reviews to authenticated;
grant select on public.trainer_results to authenticated;

drop policy if exists drill_items_owner_select on public.drill_items;
create policy drill_items_owner_select on public.drill_items
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists drill_reviews_owner_select on public.drill_reviews;
create policy drill_reviews_owner_select on public.drill_reviews
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists trainer_results_owner_select on public.trainer_results;
create policy trainer_results_owner_select on public.trainer_results
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Scheduling helpers
-- ---------------------------------------------------------------------------

-- SM-2's quality of an answer: Perfect 5, Good 4, Inaccurate 3 (passes),
-- Mistake 1, Blunder 0 (fail). Null for anything else.
create or replace function public.drill_quality(p_grade text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_grade
           when 'perfect' then 5
           when 'good' then 4
           when 'inaccurate' then 3
           when 'mistake' then 1
           when 'blunder' then 0
         end;
$$;

comment on function public.drill_quality(text) is
  'SM-2 quality of an answer''s grade: perfect 5, good 4, inaccurate 3, mistake 1, blunder 0.';

revoke all on function public.drill_quality(text) from public, anon;
grant execute on function public.drill_quality(text) to authenticated;

-- One review (lib/training/schedule.ts, the same cases tested on both sides):
--
--   ease'     = clamp(ease + 0.1 - (5 - q)(0.08 + (5 - q) 0.02), 1.30, 3.00)
--   q < 3     reps 0, lapses + 1, interval 0, back in 10 minutes (`relearn`)
--   q >= 3    reps + 1; interval 1, then 6, then round(interval x ease'),
--             half up, at most 365 days
create or replace function public.drill_next(
  p_reps     integer,
  p_lapses   integer,
  p_ease     numeric,
  p_interval integer,
  p_quality  integer
)
returns table (reps integer, lapses integer, ease numeric, interval_days integer, relearn boolean)
language sql
immutable
set search_path = ''
as $$
  with q as (
    select greatest(0, least(5, coalesce(p_quality, 0))) as q
  ),
  e as (
    select q.q,
           round(least(3.00, greatest(1.30,
             round(coalesce(p_ease, 2.50), 2) + (10 - (5 - q.q) * (8 + 2 * (5 - q.q)))::numeric / 100)), 2) as ease
    from q
  )
  select
    case when e.q < 3 then 0 else coalesce(p_reps, 0) + 1 end,
    case when e.q < 3 then coalesce(p_lapses, 0) + 1 else coalesce(p_lapses, 0) end,
    e.ease,
    case
      when e.q < 3 then 0
      when coalesce(p_reps, 0) + 1 = 1 then 1
      when coalesce(p_reps, 0) + 1 = 2 then 6
      else least(365, greatest(1,
             floor((greatest(1, coalesce(p_interval, 0)) * (e.ease * 100) + 50) / 100)::integer))
    end,
    e.q < 3
  from e;
$$;

comment on function public.drill_next(integer, integer, numeric, integer, integer) is
  'SM-2 for drills, one review: the next reps, lapses, ease, interval (days) and whether the drill '
  'is relearned in 10 minutes. Mirrors lib/training/schedule.ts.';

revoke all on function public.drill_next(integer, integer, numeric, integer, integer) from public, anon;
grant execute on function public.drill_next(integer, integer, numeric, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. sync_drill_items -- drills from the caller's graded decisions
-- ---------------------------------------------------------------------------
--
-- Every graded decision of the caller's at `p_version` graded `p_min_grade` or
-- worse (Mistake by default; Inaccurate on request; Blunder only) becomes a
-- drill, once. A drill already there for the same decision at another version
-- is re-pointed and keeps its schedule. Idempotent: running it twice adds
-- nothing. Only decisions with stored options and a chosen option can be
-- drilled (a heuristic note has nothing to grade an answer against).

create or replace function public.sync_drill_items(
  p_version   text,
  p_min_grade text default 'mistake'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_min      integer;
  v_inserted integer;
  v_updated  integer;
  v_total    integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'sync_drill_items needs an analysis_version.' using errcode = '22023';
  end if;
  v_min := public.analysis_grade_rank(coalesce(p_min_grade, 'mistake'));
  if v_min is null or v_min < public.analysis_grade_rank('inaccurate') then
    raise exception 'Drills start at Inaccurate, Mistake or Blunder (got %).', p_min_grade using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('drill_sync:' || v_owner::text, 1, 120, interval '10 minutes');

  with source as (
    -- The ownership check: definer functions are not protected by RLS, so the
    -- decision's hand must be the caller's, named explicitly.
    select d.hand_id, d.action_index, d.analysis_version, d.ord, d.street, d.grade,
           coalesce(d.ev_loss_bb, 0) as ev_loss_bb,
           public.analysis_spot_key(
             d.street,
             d.scenario,
             case when d.source = 'chart' and coalesce(d.facts -> 'chart' ->> 'line', '') ~ '^[fkcra]{0,24}$'
                  then coalesce(d.facts -> 'chart' ->> 'line', '') else '' end,
             case when coalesce(d.facts ->> 'position', h.hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
                  then coalesce(d.facts ->> 'position', h.hero_position, '') else '' end,
             d.action,
             coalesce(public.analysis_best_action(d.options), '')) as spot_key
    from public.decision_analysis d
    join public.hands h on h.id = d.hand_id and h.owner_id = v_owner
    where d.owner_id = v_owner
      and d.analysis_version = p_version
      and d.grade is not null
      and public.analysis_grade_rank(d.grade) >= v_min
      and d.chosen is not null
      and jsonb_array_length(d.options) > 0
  ),
  upserted as (
    insert into public.drill_items as di (
      owner_id, hand_id, action_index, analysis_version, ord, street, spot_key,
      source_grade, source_ev_loss_bb)
    select v_owner, s.hand_id, s.action_index, s.analysis_version, s.ord, s.street, s.spot_key,
           s.grade, s.ev_loss_bb
    from source s
    on conflict (owner_id, hand_id, action_index) do update
      set analysis_version  = excluded.analysis_version,
          ord               = excluded.ord,
          street            = excluded.street,
          spot_key          = excluded.spot_key,
          source_grade      = excluded.source_grade,
          source_ev_loss_bb = excluded.source_ev_loss_bb
      where di.analysis_version is distinct from excluded.analysis_version
         or di.spot_key is distinct from excluded.spot_key
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_inserted, v_updated
  from upserted;

  select count(*) into v_total from public.drill_items where owner_id = v_owner;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'total', v_total);
end;
$$;

comment on function public.sync_drill_items(text, text) is
  'Builds drills from the caller''s graded decisions at a version (Mistake or worse by default), '
  'once each; re-points drills from other versions. Definer with an explicit ownership check; rate-limited.';

revoke all on function public.sync_drill_items(text, text) from public, anon;
grant execute on function public.sync_drill_items(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. review_drill -- one answer, one reschedule
-- ---------------------------------------------------------------------------
--
-- `p_chosen` is the option the player picked among the drill's stored options
-- (checked against them), `p_grade` and `p_ev_loss_bb` the grade the browser
-- gave it (`gradeDrill`). The schedule is computed here, by `drill_next`.

create or replace function public.review_drill(
  p_item       uuid,
  p_chosen     integer,
  p_grade      text,
  p_ev_loss_bb numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_item    public.drill_items%rowtype;
  v_options integer;
  v_quality integer;
  v_next    record;
  v_due     timestamptz;
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  v_quality := public.drill_quality(p_grade);
  if v_quality is null then
    raise exception 'Unknown grade: %', p_grade using errcode = '22023';
  end if;
  if p_chosen is null or p_chosen < 0 or p_chosen > 11 then
    raise exception 'No such option: %', p_chosen using errcode = '22023';
  end if;
  if p_ev_loss_bb is null or p_ev_loss_bb < 0 or p_ev_loss_bb > 1000 then
    raise exception 'EV loss out of range: %', p_ev_loss_bb using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('drill_review:' || v_owner::text, 1, 600, interval '10 minutes');

  -- The ownership check: by id *and* owner, one answer for "not yours" and
  -- "not there".
  select * into v_item
  from public.drill_items
  where id = p_item and owner_id = v_owner
  for update;
  if not found then
    raise exception 'No such drill.' using errcode = 'P0002';
  end if;

  select jsonb_array_length(d.options) into v_options
  from public.decision_analysis d
  where d.hand_id = v_item.hand_id
    and d.analysis_version = v_item.analysis_version
    and d.ord = v_item.ord
    and d.owner_id = v_owner;
  if v_options is null then
    raise exception 'The drill''s decision is no longer analysed.' using errcode = 'P0002';
  end if;
  if p_chosen >= v_options then
    raise exception 'No such option: % (the drill has %)', p_chosen, v_options using errcode = '22023';
  end if;

  select * into v_next
  from public.drill_next(v_item.reps, v_item.lapses, v_item.ease, v_item.interval_days, v_quality);
  v_due := case when v_next.relearn then now() + interval '10 minutes'
                else now() + make_interval(days => v_next.interval_days) end;

  update public.drill_items
     set reps             = v_next.reps,
         lapses           = v_next.lapses,
         ease             = v_next.ease,
         interval_days    = v_next.interval_days,
         due_at           = v_due,
         reviews          = reviews + 1,
         last_grade       = p_grade,
         last_reviewed_at = now()
   where id = v_item.id;

  insert into public.drill_reviews (item_id, owner_id, chosen, grade, ev_loss_bb, quality, ease, interval_days, due_at)
  values (v_item.id, v_owner, p_chosen, p_grade, round(p_ev_loss_bb, 3), v_quality, v_next.ease, v_next.interval_days, v_due);

  return jsonb_build_object(
    'id',           v_item.id,
    'reps',         v_next.reps,
    'lapses',       v_next.lapses,
    'ease',         v_next.ease,
    'intervalDays', v_next.interval_days,
    'dueAt',        v_due,
    'relearn',      v_next.relearn);
end;
$$;

comment on function public.review_drill(uuid, integer, text, numeric) is
  'Records one answer to one of the caller''s drills and reschedules it (drill_next). Definer: the '
  'drill is named by id and owner; the option index is checked against the stored options; rate-limited.';

revoke all on function public.review_drill(uuid, integer, text, numeric) from public, anon;
grant execute on function public.review_drill(uuid, integer, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. record_trainer_results
-- ---------------------------------------------------------------------------
--
-- `p_rows`: [{ mode, family, spot, position, hand_class, grade, ev_loss_bb,
-- ev_loss_pot, score }], at most 50 per call. A row the table's checks refuse
-- fails the call (23514), so a malformed batch is visible, never half-written.

create or replace function public.record_trainer_results(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep trainer results.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_trainer_results expects a JSON array.' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object('inserted', 0);
  end if;
  if v_received > 50 then
    raise exception 'record_trainer_results accepts at most 50 rows per call (got %).', v_received
      using errcode = '53400';
  end if;

  perform public.enforce_rate_limit('trainer_results:' || v_owner::text, v_received, 1200, interval '10 minutes');

  with ins as (
    insert into public.trainer_results (owner_id, mode, family, spot, position, hand_class, grade,
                                        ev_loss_bb, ev_loss_pot, score)
    select v_owner, x.mode, x.family, coalesce(x.spot, ''), nullif(x.position, ''), nullif(x.hand_class, ''),
           x.grade, round(x.ev_loss_bb, 3), round(x.ev_loss_pot, 4), round(x.score, 2)
    from jsonb_to_recordset(p_rows) as x(
      mode text, family text, spot text, position text, hand_class text, grade text,
      ev_loss_bb numeric, ev_loss_pot numeric, score numeric)
    returning 1
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object('inserted', v_inserted);
end;
$$;

comment on function public.record_trainer_results(jsonb) is
  'Records graded trainer answers for the caller (at most 50 per call). Definer; the rows are the '
  'caller''s by construction; rate-limited; the table''s checks validate every column.';

revoke all on function public.record_trainer_results(jsonb) from public, anon;
grant execute on function public.record_trainer_results(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Reads (invoker, RLS-scoped)
-- ---------------------------------------------------------------------------

-- Spot keys from a client are validated, as `analysis_leak_hands` does.
create or replace function public.drill_keys_valid(p_keys text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_keys is null
      or (cardinality(p_keys) <= 500
          and not exists (
            select 1 from unnest(p_keys) k
            where k is null
               or k !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$'));
$$;

revoke all on function public.drill_keys_valid(text[]) from public, anon;
grant execute on function public.drill_keys_valid(text[]) to authenticated;

-- The drills to play: due ones first (oldest due first), then -- unless
-- `p_due_only` -- the rest by due date. `p_keys` narrows to a leak's spots.
-- Only drills whose decision is analysed at `p_version` are offered.
create or replace function public.drill_queue(
  p_version  text,
  p_keys     text[]  default null,
  p_due_only boolean default true,
  p_limit    integer default 20
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
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_queue needs an analysis_version.' using errcode = '22023';
  end if;
  if not public.drill_keys_valid(p_keys) then
    raise exception 'Malformed spot key.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',           q.id,
           'handId',       q.hand_id,
           'actionIndex',  q.action_index,
           'ord',          q.ord,
           'street',       q.street,
           'spotKey',      q.spot_key,
           'sourceGrade',  q.source_grade,
           'sourceEvLossBb', q.source_ev_loss_bb,
           'reps',         q.reps,
           'lapses',       q.lapses,
           'ease',         q.ease,
           'intervalDays', q.interval_days,
           'dueAt',        q.due_at,
           'reviews',      q.reviews,
           'lastGrade',    q.last_grade,
           'due',          q.due_at <= now()) order by q.due_at, q.id), '[]'::jsonb)
  into v_out
  from (
    select di.*
    from public.drill_items di
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (p_keys is null or di.spot_key = any (p_keys))
      and (not coalesce(p_due_only, true) or di.due_at <= now())
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord)
    order by di.due_at, di.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) q;

  return v_out;
end;
$$;

comment on function public.drill_queue(text, text[], boolean, integer) is
  'The caller''s drills to play at a version: due first, optionally only due, optionally only some spots. Invoker.';

revoke all on function public.drill_queue(text, text[], boolean, integer) from public, anon;
grant execute on function public.drill_queue(text, text[], boolean, integer) to authenticated;

-- Counts for the overview. `p_until` is the end of the reader's day ("due
-- today"); `candidates` are decisions graded Mistake or worse at the version
-- that have no drill yet -- what the next sync would add.
create or replace function public.drill_summary(p_version text, p_until timestamptz default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_until timestamptz := coalesce(p_until, now() + interval '1 day');
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_summary needs an analysis_version.' using errcode = '22023';
  end if;
  if v_until < now() - interval '1 day' or v_until > now() + interval '2 days' then
    raise exception 'drill_summary: "until" must be within a day of now.' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'analysisVersion', p_version,
    'items',     count(*),
    'due',       count(*) filter (where di.due_at <= now()),
    'dueToday',  count(*) filter (where di.due_at <= v_until),
    'learning',  count(*) filter (where di.reps = 0 and di.reviews > 0),
    'mature',    count(*) filter (where di.interval_days >= 21),
    'reviewed',  coalesce(sum(di.reviews), 0),
    'candidates', (
      select count(*)
      from public.decision_analysis d
      where d.owner_id = v_owner
        and d.analysis_version = p_version
        and public.analysis_grade_rank(d.grade) >= public.analysis_grade_rank('mistake')
        and d.chosen is not null
        and jsonb_array_length(d.options) > 0
        and not exists (
          select 1 from public.drill_items x
          where x.owner_id = v_owner and x.hand_id = d.hand_id and x.action_index = d.action_index)))
  into v_out
  from public.drill_items di
  where di.owner_id = v_owner
    and di.analysis_version = p_version
    and exists (
      select 1 from public.decision_analysis d
      where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord);

  return v_out;
end;
$$;

comment on function public.drill_summary(text, timestamptz) is
  'Drill counts at a version: items, due now, due by p_until, learning, mature, reviews, and graded '
  'Mistakes not drilled yet. Invoker.';

revoke all on function public.drill_summary(text, timestamptz) from public, anon;
grant execute on function public.drill_summary(text, timestamptz) to authenticated;

-- Per finest leak spot: drills, and how many are due by `p_until` (a decision
-- not drilled yet counts as due -- the sync makes it so).
create or replace function public.drill_due_by_spot(p_version text, p_until timestamptz default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_until timestamptz := coalesce(p_until, now() + interval '1 day');
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_due_by_spot needs an analysis_version.' using errcode = '22023';
  end if;

  with drilled as (
    select di.spot_key, count(*) as items, count(*) filter (where di.due_at <= v_until) as due
    from public.drill_items di
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord)
    group by di.spot_key
  ),
  fresh as (
    select g.spot_key, count(*) as items
    from public.analysis_graded_decisions(jsonb_build_object('analysisVersion', p_version)) g
    where public.analysis_grade_rank(g.grade) >= public.analysis_grade_rank('mistake')
      and not exists (
        select 1 from public.drill_items x
        where x.owner_id = v_owner and x.hand_id = g.hand_id and x.action_index = g.action_index)
    group by g.spot_key
  ),
  keys as (
    select spot_key from drilled union select spot_key from fresh
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',   k.spot_key,
           'items', coalesce(d.items, 0) + coalesce(f.items, 0),
           'due',   coalesce(d.due, 0) + coalesce(f.items, 0)) order by k.spot_key), '[]'::jsonb)
  into v_out
  from keys k
  left join drilled d on d.spot_key = k.spot_key
  left join fresh f on f.spot_key = k.spot_key;

  return v_out;
end;
$$;

comment on function public.drill_due_by_spot(text, timestamptz) is
  'Per finest leak spot (analysis_spot_key): drills and drills due by p_until, counting graded '
  'Mistakes not drilled yet as due. Invoker.';

revoke all on function public.drill_due_by_spot(text, timestamptz) from public, anon;
grant execute on function public.drill_due_by_spot(text, timestamptz) to authenticated;

-- The trainer's long view: per mode, over the last `p_days` days and in total.
create or replace function public.trainer_summary(p_days integer default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_since timestamptz;
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read trainer results.' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception 'trainer_summary: days must be 1..3650.' using errcode = '22023';
  end if;
  v_since := now() - make_interval(days => p_days);

  with r as (
    select t.*, t.created_at >= v_since as recent
    from public.trainer_results t
    where t.owner_id = v_owner
  ),
  per_mode as (
    select r.mode,
           jsonb_build_object(
             'mode', r.mode,
             'answers', count(*),
             'recent', count(*) filter (where r.recent),
             'perfect', count(*) filter (where r.recent and r.grade = 'perfect'),
             'good', count(*) filter (where r.recent and r.grade = 'good'),
             'inaccurate', count(*) filter (where r.recent and r.grade = 'inaccurate'),
             'mistake', count(*) filter (where r.recent and r.grade = 'mistake'),
             'blunder', count(*) filter (where r.recent and r.grade = 'blunder'),
             'evLossBb', coalesce(sum(r.ev_loss_bb) filter (where r.recent), 0),
             'scoreSum', coalesce(sum(r.score) filter (where r.recent), 0),
             'last', max(r.created_at)) as summary
    from r
    group by r.mode
  )
  select jsonb_build_object(
    'days', p_days,
    'modes', coalesce((select jsonb_agg(pm.summary order by pm.mode) from per_mode pm), '[]'::jsonb))
  into v_out;

  return v_out;
end;
$$;

comment on function public.trainer_summary(integer) is
  'The caller''s trainer answers per mode: all-time count, and over the last p_days the grade '
  'counts, EV lost and score sum. Invoker.';

revoke all on function public.trainer_summary(integer) from public, anon;
grant execute on function public.trainer_summary(integer) to authenticated;

commit;
