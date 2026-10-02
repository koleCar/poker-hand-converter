-- ===========================================================================
-- Hand analysis, phase A8b: the study plan
-- ===========================================================================
--
-- `docs/ANALYSIS-PLAN.md` §7 (A8b). The plan itself is built in the browser
-- (`frontend/src/lib/training/plan.ts`): it takes the leak finder's spots
-- (`analysis_leaks`), picks the week's focus areas and writes a checklist --
-- concepts to read, trainer spots to play, drills to clear, hands to review.
-- What the database keeps is what has to outlive a page:
--
--   study_plans   one row per (owner, ISO week): the week's focus areas as the
--                 browser built them (a snapshot: the numbers they had when
--                 the plan was made, which the "last week" retrospective
--                 compares against) and a small baseline (hands, moves).
--   study_tasks   the week's checklist: one row per task, with what counts
--                 towards it -- a trainer filter (mode, family, seat, spots),
--                 a leak's spot keys for drills, a hand to review -- and a
--                 manual `done_at`.
--
--   save_study_plan     writes (or rebuilds) the caller's plan for a week: the
--                       plan row upserted, tasks matched by (kind, ref) keep
--                       their `done_at`, tasks no longer in the plan go.
--   set_study_task      ticks or unticks one of the caller's tasks.
--   study_plan          a week's plan with every task's progress: trainer
--                       answers and drill reviews inside the week are
--                       counted here, so playing the trainer ticks the box.
--   study_week          helper: the current ISO week's Monday (UTC).
--   study_week_valid    helper: a week a plan may be written for.
--
-- ## Weeks
--
-- A week is an ISO week, named by its Monday (`week_start`, a date). The
-- browser names the reader's own Monday; the database accepts the current
-- UTC week and the one on either side of it, so a reader east or west of UTC
-- whose Monday is not yet (or no longer) UTC's still gets theirs, and the
-- last week can still be finished on Monday morning. A new week has no plan
-- until the browser builds one (the "rollover": last week's plan stays as it
-- was, for the retrospective). Progress is counted inside
-- `[from, from + 7 days)`, `from` being the reader's local Monday midnight
-- (within a day of `week_start`), the trainer's and the drills' own
-- timestamps.
--
-- ## The security model (`20261228090000_analysis.sql`, unchanged)
--
--   * **No client role holds INSERT, UPDATE or DELETE on either table.**
--     `select` to `authenticated`, scoped to the owner by RLS; nothing to
--     `anon`.
--   * **Writes go through `security definer` functions, as the caller**, each
--     with an explicit `auth.uid()` ownership check (definer functions are not
--     protected by RLS): a plan is upserted on (caller, week) only; a hand to
--     review must be one of the caller's hands; a task is ticked by id *and*
--     owner, so another account's task and no task at all get the same answer.
--   * Every write is rate-limited per account (`enforce_rate_limit`).
--   * Inputs are validated: the week, the plan kind, the version, sizes of the
--     snapshot, each task's kind, reference, target and filters against fixed
--     shapes, spot keys with `drill_keys_valid`.
--   * **The focus snapshot is the browser's.** It is shape- and size-checked,
--     not re-derived: it is only ever shown back to its owner, so a false one
--     misleads nobody else.
--   * Reads are `security invoker`; their helpers are executable by
--     `authenticated` (the lesson of `20261109090000`). Every function pins
--     `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.study_plans (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  -- The ISO week's Monday.
  week_start       date not null check (extract(isodow from week_start) = 1),
  -- `leaks`: built from the leak finder; `fundamentals`: too little graded
  -- play for leaks, so the basics.
  kind             text not null check (kind in ('leaks', 'fundamentals')),
  analysis_version text not null check (analysis_version ~ '^analysis/[0-9]+$'),
  -- At most three focus areas, as `lib/training/plan.ts` built them.
  focus            jsonb not null default '[]'::jsonb
                   check (jsonb_typeof(focus) = 'array'
                          and jsonb_array_length(focus) <= 3
                          and octet_length(focus::text) <= 65536),
  baseline         jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(baseline) = 'object' and octet_length(baseline::text) <= 4096),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint study_plans_one_per_week unique (owner_id, week_start)
);

comment on table public.study_plans is
  'One study plan per (owner, ISO week): the week''s focus areas as the browser built them from the '
  'leak finder, and a baseline. Written only by save_study_plan.';

create table if not exists public.study_tasks (
  id             uuid primary key default gen_random_uuid(),
  plan_id        uuid not null references public.study_plans (id) on delete cascade,
  owner_id       uuid not null references auth.users (id) on delete cascade,
  ord            smallint not null check (ord between 0 and 99),
  -- Index of the focus area it serves; null for a plan-wide task.
  focus          smallint check (focus between 0 and 2),
  kind           text not null check (kind in ('read', 'train', 'drill', 'review')),
  -- What the task is about: a concept id, a trainer filter, a focus area, a hand.
  ref            text not null check (char_length(ref) between 1 and 120),
  target         smallint not null default 1 check (target between 1 and 200),
  -- review: the hand (one of the owner's).
  hand_id        uuid references public.hands (id) on delete cascade,
  -- train: which trainer answers count (`trainer_results`).
  match_mode     text check (match_mode in ('preflop', 'river')),
  match_family   text check (match_family ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  match_position text check (match_position ~ '^[A-Z0-9+]{1,8}$'),
  -- river: `<line id>:<seat>` pairs (`trainer_results.spot`, `.position`).
  match_spots    text[] check (match_spots is null or cardinality(match_spots) between 1 and 40),
  -- drill: the focus area's finest spot keys; null for every drill.
  spot_keys      text[] check (spot_keys is null or cardinality(spot_keys) between 1 and 500),
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  constraint study_tasks_one_per_ref unique (plan_id, kind, ref),
  constraint study_tasks_review_hand check ((kind = 'review') = (hand_id is not null)),
  constraint study_tasks_train_match check ((kind = 'train') = (match_mode is not null))
);

comment on table public.study_tasks is
  'A study plan''s checklist: concepts to read, trainer spots, drills to clear, hands to review, with '
  'what counts towards each and a manual done_at. Written only by save_study_plan and set_study_task.';

create index if not exists study_tasks_plan_idx on public.study_tasks (plan_id, ord);
create index if not exists study_tasks_owner_idx on public.study_tasks (owner_id);
create index if not exists study_tasks_hand_idx on public.study_tasks (hand_id) where hand_id is not null;

-- ---------------------------------------------------------------------------
-- 2. RLS: select-own, nothing else, for anyone
-- ---------------------------------------------------------------------------

alter table public.study_plans enable row level security;
alter table public.study_tasks enable row level security;

revoke all on public.study_plans from anon, authenticated;
revoke all on public.study_tasks from anon, authenticated;
grant select on public.study_plans to authenticated;
grant select on public.study_tasks to authenticated;

drop policy if exists study_plans_owner_select on public.study_plans;
create policy study_plans_owner_select on public.study_plans
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists study_tasks_owner_select on public.study_tasks;
create policy study_tasks_owner_select on public.study_tasks
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Week helpers
-- ---------------------------------------------------------------------------

-- The current ISO week's Monday, in UTC.
create or replace function public.study_week()
returns date
language sql
stable
set search_path = ''
as $$
  select (date_trunc('week', now() at time zone 'utc'))::date;
$$;

comment on function public.study_week() is 'The current ISO week''s Monday (UTC).';

revoke all on function public.study_week() from public, anon;
grant execute on function public.study_week() to authenticated;

-- A week a plan may be written for: a Monday, the current UTC week or the one
-- on either side (the reader's own Monday east or west of UTC).
create or replace function public.study_week_valid(p_week_start date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_week_start is not null
     and extract(isodow from p_week_start) = 1
     and p_week_start between public.study_week() - 7 and public.study_week() + 7;
$$;

comment on function public.study_week_valid(date) is
  'True for a Monday in the current UTC week or the one before or after it.';

revoke all on function public.study_week_valid(date) from public, anon;
grant execute on function public.study_week_valid(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. save_study_plan -- the week's plan, written or rebuilt
-- ---------------------------------------------------------------------------
--
-- `p_tasks`: [{ kind, ref, target, focus, hand_id, match_mode, match_family,
-- match_position, match_spots, spot_keys }], at most 40, in checklist order.
-- Rebuilding a week keeps the `done_at` of every task whose (kind, ref) is
-- still there and removes the rest; nothing else of other weeks is touched.

create or replace function public.save_study_plan(
  p_week_start       date,
  p_kind             text,
  p_analysis_version text,
  p_focus            jsonb,
  p_baseline         jsonb,
  p_tasks            jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_plan    uuid;
  v_created boolean;
  v_focus   integer;
  v_count   integer;
  v_task    record;
  v_seen    text[] := '{}';
  v_bad     boolean;
  v_kept    integer;
  v_removed integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep a study plan.' using errcode = '42501';
  end if;
  if not public.study_week_valid(p_week_start) then
    raise exception 'A plan is for this week, last week or next week, named by its Monday (got %).', p_week_start
      using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('leaks', 'fundamentals') then
    raise exception 'Unknown plan kind: %', p_kind using errcode = '22023';
  end if;
  if p_analysis_version is null or p_analysis_version !~ '^analysis/[0-9]+$' then
    raise exception 'save_study_plan needs an analysis_version.' using errcode = '22023';
  end if;
  if p_focus is null or jsonb_typeof(p_focus) <> 'array' or jsonb_array_length(p_focus) > 3
     or octet_length(p_focus::text) > 65536 then
    raise exception 'The focus is an array of at most three areas.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_focus) f where jsonb_typeof(f) <> 'object') then
    raise exception 'Each focus area is an object.' using errcode = '22023';
  end if;
  if p_baseline is not null and (jsonb_typeof(p_baseline) <> 'object' or octet_length(p_baseline::text) > 4096) then
    raise exception 'The baseline is a small object.' using errcode = '22023';
  end if;
  if p_tasks is null or jsonb_typeof(p_tasks) <> 'array' then
    raise exception 'save_study_plan expects the tasks as a JSON array.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_tasks);
  if v_count > 40 then
    raise exception 'A plan has at most 40 tasks (got %).', v_count using errcode = '53400';
  end if;
  v_focus := jsonb_array_length(p_focus);

  perform public.enforce_rate_limit('study_plan:' || v_owner::text, 1, 60, interval '10 minutes');

  -- Validate every task before writing anything: a malformed plan is refused
  -- whole, never half-written.
  if exists (select 1 from jsonb_array_elements(p_tasks) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Each task is an object.' using errcode = '22023';
  end if;
  for v_task in
    select x.*
    from jsonb_to_recordset(p_tasks) as x(
      kind text, ref text, target integer, focus integer, hand_id uuid,
      match_mode text, match_family text, match_position text, match_spots text[], spot_keys text[])
  loop
    if v_task.kind is null or v_task.kind not in ('read', 'train', 'drill', 'review') then
      raise exception 'Unknown task kind: %', v_task.kind using errcode = '22023';
    end if;
    if v_task.target is null or v_task.target < 1 or v_task.target > 200 then
      raise exception 'A task''s target is 1..200 (got %).', v_task.target using errcode = '22023';
    end if;
    if v_task.focus is not null and (v_task.focus < 0 or v_task.focus >= v_focus) then
      raise exception 'Task names focus area % of %.', v_task.focus, v_focus using errcode = '22023';
    end if;
    v_bad := v_task.ref is null or case v_task.kind
               when 'read' then v_task.ref !~ '^[a-z0-9][a-z0-9-]{0,39}$'
               when 'train' then v_task.ref !~ '^(preflop|river)(/[A-Za-z0-9+-]{1,20}){0,5}$'
               when 'drill' then v_task.ref !~ '^[A-Za-z0-9*~+-]{1,120}$'
               else v_task.ref is distinct from v_task.hand_id::text
             end;
    if coalesce(v_bad, true) then
      raise exception 'Malformed % task reference: %', v_task.kind, v_task.ref using errcode = '22023';
    end if;
    if (v_task.kind = 'review') <> (v_task.hand_id is not null) then
      raise exception 'Only a review task names a hand.' using errcode = '22023';
    end if;
    if v_task.kind = 'review' and not exists (
         select 1 from public.hands h where h.id = v_task.hand_id and h.owner_id = v_owner) then
      -- The ownership check: the same answer for another account's hand and none.
      raise exception 'No such hand.' using errcode = 'P0002';
    end if;
    if v_task.kind = 'train' then
      if v_task.match_mode is null or v_task.match_mode not in ('preflop', 'river') then
        raise exception 'A trainer task names its trainer.' using errcode = '22023';
      end if;
      if (v_task.match_family is not null and v_task.match_family !~ '^[a-z0-9][a-z0-9-]{0,39}$')
         or (v_task.match_position is not null and v_task.match_position !~ '^[A-Z0-9+]{1,8}$')
         or (v_task.match_spots is not null and (
               cardinality(v_task.match_spots) not between 1 and 40
               or exists (select 1 from unnest(v_task.match_spots) s
                          where s is null or s !~ '^[a-z0-9][a-z0-9-]{0,39}:[A-Z0-9+]{1,8}$'))) then
        raise exception 'Malformed trainer filter.' using errcode = '22023';
      end if;
    elsif v_task.match_mode is not null or v_task.match_family is not null
          or v_task.match_position is not null or v_task.match_spots is not null then
      raise exception 'Only a trainer task has a trainer filter.' using errcode = '22023';
    end if;
    if v_task.spot_keys is not null then
      if v_task.kind <> 'drill' then
        raise exception 'Only a drill task names spot keys.' using errcode = '22023';
      end if;
      if cardinality(v_task.spot_keys) < 1 or not public.drill_keys_valid(v_task.spot_keys) then
        raise exception 'Malformed spot key.' using errcode = '22023';
      end if;
    end if;
    if (v_task.kind || ':' || v_task.ref) = any (v_seen) then
      raise exception 'The task % appears twice.', v_task.kind || ':' || v_task.ref using errcode = '22023';
    end if;
    v_seen := v_seen || (v_task.kind || ':' || v_task.ref);
  end loop;

  insert into public.study_plans as sp (owner_id, week_start, kind, analysis_version, focus, baseline)
  values (v_owner, p_week_start, p_kind, p_analysis_version, p_focus, coalesce(p_baseline, '{}'::jsonb))
  on conflict (owner_id, week_start) do update
    set kind             = excluded.kind,
        analysis_version = excluded.analysis_version,
        focus            = excluded.focus,
        baseline         = excluded.baseline,
        updated_at       = now()
  returning sp.id, (xmax = 0) into v_plan, v_created;

  -- Tasks no longer in the plan go; the rest keep their done_at.
  with gone as (
    delete from public.study_tasks t
    where t.plan_id = v_plan
      and t.owner_id = v_owner
      and not ((t.kind || ':' || t.ref) = any (v_seen))
    returning 1
  )
  select count(*) into v_removed from gone;

  with incoming as (
    select x.*, (e.n - 1)::integer as ord
    from jsonb_array_elements(p_tasks) with ordinality as e(value, n),
         jsonb_to_record(e.value) as x(
           kind text, ref text, target integer, focus integer, hand_id uuid,
           match_mode text, match_family text, match_position text, match_spots text[], spot_keys text[])
  ),
  upserted as (
    insert into public.study_tasks as st (plan_id, owner_id, ord, focus, kind, ref, target, hand_id,
                                          match_mode, match_family, match_position, match_spots, spot_keys)
    select v_plan, v_owner, i.ord, i.focus, i.kind, i.ref, i.target, i.hand_id,
           i.match_mode, i.match_family, i.match_position, i.match_spots, i.spot_keys
    from incoming i
    on conflict (plan_id, kind, ref) do update
      set ord            = excluded.ord,
          focus          = excluded.focus,
          target         = excluded.target,
          hand_id        = excluded.hand_id,
          match_mode     = excluded.match_mode,
          match_family   = excluded.match_family,
          match_position = excluded.match_position,
          match_spots    = excluded.match_spots,
          spot_keys      = excluded.spot_keys
    returning (xmax <> 0) as kept
  )
  select count(*) filter (where kept) into v_kept from upserted;

  return jsonb_build_object(
    'id', v_plan,
    'weekStart', p_week_start,
    'created', v_created,
    'tasks', v_count,
    'kept', coalesce(v_kept, 0),
    'removed', coalesce(v_removed, 0));
end;
$$;

comment on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) is
  'Writes or rebuilds the caller''s study plan for a week (this, last or next): the plan upserted on '
  '(caller, week), tasks matched by (kind, ref) keep done_at, the rest are replaced. Definer; every task '
  'validated, a review hand must be the caller''s; rate-limited.';

revoke all on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. set_study_task -- tick or untick one task
-- ---------------------------------------------------------------------------

create or replace function public.set_study_task(p_task uuid, p_done boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_week  date;
  v_done  timestamptz;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep a study plan.' using errcode = '42501';
  end if;
  if p_done is null then
    raise exception 'set_study_task needs done or not done.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('study_task:' || v_owner::text, 1, 600, interval '10 minutes');

  -- The ownership check: by id *and* owner, one answer for "not yours" and
  -- "not there".
  select p.week_start into v_week
  from public.study_tasks t
  join public.study_plans p on p.id = t.plan_id and p.owner_id = v_owner
  where t.id = p_task and t.owner_id = v_owner;
  if not found then
    raise exception 'No such task.' using errcode = 'P0002';
  end if;
  -- Last week can still be finished; older weeks are history.
  if v_week < public.study_week() - 7 then
    raise exception 'That plan''s week is over.' using errcode = '22023';
  end if;

  update public.study_tasks
     set done_at = case when p_done then coalesce(done_at, now()) else null end
   where id = p_task and owner_id = v_owner
  returning done_at into v_done;

  return jsonb_build_object('id', p_task, 'doneAt', v_done);
end;
$$;

comment on function public.set_study_task(uuid, boolean) is
  'Ticks or unticks one of the caller''s study tasks (this week''s or last week''s). Definer: the task is '
  'named by id and owner ("No such task." either way); rate-limited.';

revoke all on function public.set_study_task(uuid, boolean) from public, anon;
grant execute on function public.set_study_task(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. study_plan -- a week's plan and its progress (invoker, RLS-scoped)
-- ---------------------------------------------------------------------------
--
-- `p_from` is the reader's local Monday midnight (default: `week_start` in
-- UTC), within a day of `week_start`. A trainer task counts the trainer
-- answers inside the week that match its filter; a drill task the distinct
-- drills of its spot keys answered inside the week; a read or review task is
-- done when ticked. Any task can also be ticked by hand. Null when the week
-- has no plan.

create or replace function public.study_plan(p_week_start date, p_from timestamptz default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_from  timestamptz;
  v_to    timestamptz;
  v_plan  public.study_plans%rowtype;
  v_tasks jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read a study plan.' using errcode = '42501';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'A week is named by its Monday (got %).', p_week_start using errcode = '22023';
  end if;
  v_from := coalesce(p_from, p_week_start::timestamp at time zone 'utc');
  if v_from < (p_week_start::timestamp at time zone 'utc') - interval '1 day'
     or v_from > (p_week_start::timestamp at time zone 'utc') + interval '1 day' then
    raise exception 'study_plan: "from" must be within a day of the week''s Monday.' using errcode = '22023';
  end if;
  v_to := v_from + interval '7 days';

  select * into v_plan
  from public.study_plans p
  where p.owner_id = v_owner and p.week_start = p_week_start;
  if not found then
    return null;
  end if;

  with counted as (
    select t.*,
           case t.kind
             when 'train' then (
               select count(*)
               from public.trainer_results r
               where r.owner_id = v_owner
                 and r.created_at >= v_from and r.created_at < v_to
                 and r.mode = t.match_mode
                 and (t.match_family is null or r.family = t.match_family)
                 and (t.match_position is null or r.position = t.match_position)
                 and (t.match_spots is null or (r.spot || ':' || coalesce(r.position, '')) = any (t.match_spots)))
             when 'drill' then (
               select count(distinct r.item_id)
               from public.drill_reviews r
               join public.drill_items i on i.id = r.item_id and i.owner_id = v_owner
               where r.owner_id = v_owner
                 and r.reviewed_at >= v_from and r.reviewed_at < v_to
                 and (t.spot_keys is null or i.spot_key = any (t.spot_keys)))
             else 0
           end as counted
    from public.study_tasks t
    where t.plan_id = v_plan.id and t.owner_id = v_owner
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',            c.id,
           'ord',           c.ord,
           'focus',         c.focus,
           'kind',          c.kind,
           'ref',           c.ref,
           'target',        c.target,
           'handId',        c.hand_id,
           'matchMode',     c.match_mode,
           'matchFamily',   c.match_family,
           'matchPosition', c.match_position,
           'matchSpots',    to_jsonb(c.match_spots),
           'spotKeys',      to_jsonb(c.spot_keys),
           'counted',       c.counted,
           'progress',      case when c.done_at is not null then c.target else least(c.target, c.counted) end,
           'doneAt',        c.done_at,
           'done',          c.done_at is not null or c.counted >= c.target) order by c.ord, c.id), '[]'::jsonb)
  into v_tasks
  from counted c;

  return jsonb_build_object(
    'id',              v_plan.id,
    'weekStart',       v_plan.week_start,
    'from',            v_from,
    'to',              v_to,
    'kind',            v_plan.kind,
    'analysisVersion', v_plan.analysis_version,
    'focus',           v_plan.focus,
    'baseline',        v_plan.baseline,
    'createdAt',       v_plan.created_at,
    'updatedAt',       v_plan.updated_at,
    'tasks',           v_tasks);
end;
$$;

comment on function public.study_plan(date, timestamptz) is
  'The caller''s study plan for a week with each task''s progress (trainer answers and drill reviews '
  'inside the week, or ticked by hand); null when the week has none. Invoker.';

revoke all on function public.study_plan(date, timestamptz) from public, anon;
grant execute on function public.study_plan(date, timestamptz) to authenticated;

commit;
