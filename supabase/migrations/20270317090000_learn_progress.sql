-- ===========================================================================
-- Learn, phase L1: lesson progress and lesson review cards
-- ===========================================================================
--
-- `docs/LEARN-PLAN.md`. The course itself (tracks, modules, lessons, their
-- exercises) ships with the app (`frontend/src/lib/learn/course.ts`); the
-- exercises are generated and graded in the browser by Rail's own engine. What
-- the database keeps is what has to outlive a page, for a signed-in learner
-- (a signed-out one keeps the same two things in their browser only):
--
--   lesson_progress    one row per (owner, lesson): started or passed, and per
--                      exercise the latest score, whether it was ever passed
--                      and how many attempts. A lesson is passed when its
--                      exercises are (automatic progress, no "mark as seen").
--   lesson_cards       one row per (owner, quiz item) the learner missed: the
--                      item's small spec (its kind and seed, from which the
--                      browser regenerates it) and its spaced-repetition
--                      state -- the same SM-2 the mistake drills use
--                      (`drill_next`, `drill_quality` of
--                      `20270208090000_analysis_training.sql`). A quiz item
--                      has no hand, so it cannot be a `drill_items` row.
--
--   record_lesson_results  records exercise results (and a lesson passed).
--   add_lesson_cards       makes review cards of missed quiz items.
--   review_lesson_card     records one review and reschedules the card.
--
-- The study plan (A8b) gains a task kind, `lesson`: "the lesson for this
-- leak". `save_study_plan` accepts it (its reference is a lesson id) and
-- `study_plan` counts it done when the lesson is passed.
--
-- `/learn` is a new top-level route, so it is reserved as a username here, as
-- `lib/routes.ts` asks of every top-level segment.
--
-- ## The security model (`20261228090000_analysis.sql`, unchanged)
--
--   * **No client role holds INSERT, UPDATE or DELETE on either table.**
--     `select` to `authenticated`, scoped to the owner by RLS; nothing to
--     `anon`.
--   * **Writes go through `security definer` functions, as the caller**, each
--     with an explicit `auth.uid()` ownership check (definer functions are not
--     protected by RLS): rows are written with the caller's id only, and a
--     review names a card by id *and* owner, so another account's card and no
--     card at all get the same answer.
--   * Every write is rate-limited per account (`enforce_rate_limit`).
--   * Inputs are validated: lesson and exercise ids, item keys and kinds
--     against fixed shapes; scores against their ranges; an item spec is a
--     small JSON object; an account holds at most 200 lessons' rows and 2,000
--     cards.
--   * **The results come from the client.** The exercises are graded in the
--     browser by the analysis engine; the database checks the shape and the
--     bounds, not the poker, and does not know the catalogue. A learner who
--     sends a false result only marks their own lessons -- no other account
--     reads them.
--   * Reads are plain selects under RLS (and `study_plan`, invoker); every
--     helper a reader or writer calls is executable by `authenticated`. Every
--     function pins `search_path = ''` and schema-qualifies everything.
-- ===========================================================================

begin;

insert into public.username_reservations (username_lower, reason)
values ('learn', 'route')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.lesson_progress (
  owner_id    uuid not null references auth.users (id) on delete cascade,
  -- A `LessonId` of the catalogue (`lib/learn/course.ts`); the shape only.
  lesson_id   text not null check (lesson_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  status      text not null default 'started' check (status in ('started', 'passed')),
  -- { "<exercise id>": { "correct": n, "total": n, "passed": bool, "attempts": n, "at": iso } }
  exercises   jsonb not null default '{}'::jsonb
              check (jsonb_typeof(exercises) = 'object' and octet_length(exercises::text) <= 16384),
  started_at  timestamptz not null default now(),
  passed_at   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (owner_id, lesson_id),
  constraint lesson_progress_passed_at check ((status = 'passed') = (passed_at is not null))
);

comment on table public.lesson_progress is
  'Per (owner, lesson): started or passed, and each exercise''s latest score, ever-passed flag and '
  'attempts. Written only by record_lesson_results.';

create table if not exists public.lesson_cards (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  lesson_id         text not null check (lesson_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  exercise_id       text not null check (exercise_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  kind              text not null check (kind in ('chart-quiz', 'solver-spot', 'calc', 'classify')),
  -- `<lesson>:<exercise>:<seed>`-style: one card per quiz item.
  item_key          text not null check (item_key ~ '^[a-z0-9][a-z0-9:._-]{2,159}$'),
  -- What the browser regenerates the item from (kind, seed, options).
  item              jsonb not null check (jsonb_typeof(item) = 'object' and octet_length(item::text) <= 2048),
  -- SM-2 state, as `drill_items` keeps it.
  reps              smallint not null default 0 check (reps between 0 and 10000),
  lapses            smallint not null default 0 check (lapses between 0 and 10000),
  ease              numeric(4, 2) not null default 2.50 check (ease between 1.30 and 3.00),
  interval_days     smallint not null default 0 check (interval_days between 0 and 365),
  due_at            timestamptz not null default now(),
  reviews           integer not null default 0 check (reviews >= 0),
  last_grade        text check (last_grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  last_reviewed_at  timestamptz,
  created_at        timestamptz not null default now(),
  constraint lesson_cards_one_per_item unique (owner_id, item_key)
);

comment on table public.lesson_cards is
  'One review card per (owner, missed quiz item): the item''s spec and its SM-2 state. Written only by '
  'add_lesson_cards and review_lesson_card.';

create index if not exists lesson_cards_owner_due_idx on public.lesson_cards (owner_id, due_at);

-- ---------------------------------------------------------------------------
-- 2. RLS: select-own, nothing else, for anyone
-- ---------------------------------------------------------------------------

alter table public.lesson_progress enable row level security;
alter table public.lesson_cards enable row level security;

revoke all on public.lesson_progress from anon, authenticated;
revoke all on public.lesson_cards from anon, authenticated;
grant select on public.lesson_progress to authenticated;
grant select on public.lesson_cards to authenticated;

drop policy if exists lesson_progress_owner_select on public.lesson_progress;
create policy lesson_progress_owner_select on public.lesson_progress
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists lesson_cards_owner_select on public.lesson_cards;
create policy lesson_cards_owner_select on public.lesson_cards
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. record_lesson_results -- exercise results, and lessons passed
-- ---------------------------------------------------------------------------
--
-- `p_rows`: [{ lesson, exercise, correct, total, passed, lesson_passed }], at
-- most 100. `exercise` null records only that the lesson was started (or
-- passed, with `lesson_passed`). An exercise keeps its latest score; its
-- `passed` flag and the lesson's `passed` status are sticky. The batch is
-- validated whole before anything is written.

create or replace function public.record_lesson_results(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_count   integer;
  v_row     record;
  v_lessons integer;
  v_new     integer;
  v_passed  integer := 0;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep lesson progress.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_lesson_results expects a JSON array.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count = 0 then
    return jsonb_build_object('recorded', 0, 'passed', 0);
  end if;
  if v_count > 100 then
    raise exception 'At most 100 results at a time (got %).', v_count using errcode = '53400';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Each result is an object.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('lesson_results:' || v_owner::text, 1, 300, interval '10 minutes');

  for v_row in
    select x.*
    from jsonb_to_recordset(p_rows) as x(
      lesson text, exercise text, correct integer, total integer, passed boolean, lesson_passed boolean)
  loop
    if v_row.lesson is null or v_row.lesson !~ '^[a-z0-9][a-z0-9-]{1,63}$' then
      raise exception 'Malformed lesson id: %', v_row.lesson using errcode = '22023';
    end if;
    if v_row.exercise is not null then
      if v_row.exercise !~ '^[a-z0-9][a-z0-9-]{0,39}$' then
        raise exception 'Malformed exercise id: %', v_row.exercise using errcode = '22023';
      end if;
      if v_row.correct is null or v_row.total is null or v_row.passed is null
         or v_row.total < 0 or v_row.total > 1000 or v_row.correct < 0 or v_row.correct > v_row.total then
        raise exception 'An exercise result is 0 <= correct <= total <= 1000, and passed or not.' using errcode = '22023';
      end if;
    elsif v_row.correct is not null or v_row.total is not null or v_row.passed is not null then
      raise exception 'Only an exercise result carries a score.' using errcode = '22023';
    end if;
  end loop;

  -- At most 200 lessons per account: the catalogue has 62, and the database
  -- does not know which ids are real.
  select count(*) into v_lessons from public.lesson_progress where owner_id = v_owner;
  select count(distinct x.lesson) into v_new
  from jsonb_to_recordset(p_rows) as x(lesson text)
  where not exists (select 1 from public.lesson_progress lp where lp.owner_id = v_owner and lp.lesson_id = x.lesson);
  if v_lessons + v_new > 200 then
    raise exception 'Too many lessons.' using errcode = '53400';
  end if;

  for v_row in
    select x.*
    from jsonb_to_recordset(p_rows) as x(
      lesson text, exercise text, correct integer, total integer, passed boolean, lesson_passed boolean)
  loop
    insert into public.lesson_progress as lp (owner_id, lesson_id, status, exercises, passed_at)
    values (
      v_owner,
      v_row.lesson,
      case when coalesce(v_row.lesson_passed, false) then 'passed' else 'started' end,
      case when v_row.exercise is null then '{}'::jsonb
           else jsonb_build_object(v_row.exercise, jsonb_build_object(
             'correct', v_row.correct, 'total', v_row.total, 'passed', v_row.passed, 'attempts', 1, 'at', now()))
      end,
      case when coalesce(v_row.lesson_passed, false) then now() end)
    on conflict (owner_id, lesson_id) do update
      set exercises = case
            when v_row.exercise is null then lp.exercises
            else lp.exercises || jsonb_build_object(v_row.exercise, jsonb_build_object(
              'correct',  v_row.correct,
              'total',    v_row.total,
              'passed',   coalesce((lp.exercises -> v_row.exercise ->> 'passed')::boolean, false) or v_row.passed,
              'attempts', coalesce((lp.exercises -> v_row.exercise ->> 'attempts')::integer, 0) + 1,
              'at',       now()))
          end,
          status     = case when lp.status = 'passed' or coalesce(v_row.lesson_passed, false) then 'passed' else 'started' end,
          passed_at  = case when lp.status = 'passed' then lp.passed_at
                            when coalesce(v_row.lesson_passed, false) then now() end,
          updated_at = now()
      where lp.owner_id = v_owner;
    if coalesce(v_row.lesson_passed, false) then
      v_passed := v_passed + 1;
    end if;
  end loop;

  return jsonb_build_object('recorded', v_count, 'passed', v_passed);
end;
$$;

comment on function public.record_lesson_results(jsonb) is
  'Records the caller''s lesson exercise results (latest score, sticky passed flag, attempts) and lessons '
  'passed (sticky). Definer: rows are the caller''s own; validated whole; at most 200 lessons; rate-limited.';

revoke all on function public.record_lesson_results(jsonb) from public, anon;
grant execute on function public.record_lesson_results(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. add_lesson_cards -- review cards of missed quiz items
-- ---------------------------------------------------------------------------
--
-- `p_cards`: [{ lesson, exercise, kind, key, item }], at most 20. A card that
-- exists already (missed again) is due now, its schedule otherwise kept.

create or replace function public.add_lesson_cards(p_cards jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_count    integer;
  v_card     record;
  v_total    integer;
  v_new      integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to keep review cards.' using errcode = '42501';
  end if;
  if p_cards is null or jsonb_typeof(p_cards) <> 'array' then
    raise exception 'add_lesson_cards expects a JSON array.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_cards);
  if v_count = 0 then
    return jsonb_build_object('inserted', 0, 'total', (select count(*) from public.lesson_cards where owner_id = v_owner));
  end if;
  if v_count > 20 then
    raise exception 'At most 20 cards at a time (got %).', v_count using errcode = '53400';
  end if;
  if exists (select 1 from jsonb_array_elements(p_cards) e
             where jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'item') is distinct from 'object') then
    raise exception 'Each card is an object with an item object.' using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('lesson_cards:' || v_owner::text, 1, 120, interval '10 minutes');

  for v_card in
    select x.*
    from jsonb_to_recordset(p_cards) as x(lesson text, exercise text, kind text, key text, item jsonb)
  loop
    if v_card.lesson is null or v_card.lesson !~ '^[a-z0-9][a-z0-9-]{1,63}$' then
      raise exception 'Malformed lesson id: %', v_card.lesson using errcode = '22023';
    end if;
    if v_card.exercise is null or v_card.exercise !~ '^[a-z0-9][a-z0-9-]{0,39}$' then
      raise exception 'Malformed exercise id: %', v_card.exercise using errcode = '22023';
    end if;
    if v_card.kind is null or v_card.kind not in ('chart-quiz', 'solver-spot', 'calc', 'classify') then
      raise exception 'Unknown card kind: %', v_card.kind using errcode = '22023';
    end if;
    if v_card.key is null or v_card.key !~ '^[a-z0-9][a-z0-9:._-]{2,159}$' then
      raise exception 'Malformed card key: %', v_card.key using errcode = '22023';
    end if;
    if octet_length(v_card.item::text) > 2048 then
      raise exception 'A card''s item is a small object.' using errcode = '22023';
    end if;
  end loop;

  select count(*) into v_total from public.lesson_cards where owner_id = v_owner;
  select count(distinct x.key) into v_new
  from jsonb_to_recordset(p_cards) as x(key text)
  where not exists (select 1 from public.lesson_cards c where c.owner_id = v_owner and c.item_key = x.key);
  if v_total + v_new > 2000 then
    raise exception 'Too many review cards.' using errcode = '53400';
  end if;

  with incoming as (
    select distinct on (x.key) x.*
    from jsonb_to_recordset(p_cards) as x(lesson text, exercise text, kind text, key text, item jsonb)
    order by x.key
  ),
  upserted as (
    insert into public.lesson_cards as c (owner_id, lesson_id, exercise_id, kind, item_key, item)
    select v_owner, i.lesson, i.exercise, i.kind, i.key, i.item
    from incoming i
    on conflict (owner_id, item_key) do update
      set due_at = least(c.due_at, now())
      where c.owner_id = v_owner
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_inserted from upserted;

  return jsonb_build_object(
    'inserted', coalesce(v_inserted, 0),
    'total', (select count(*) from public.lesson_cards where owner_id = v_owner));
end;
$$;

comment on function public.add_lesson_cards(jsonb) is
  'Makes review cards of the caller''s missed quiz items (a card missed again is due now). Definer: rows '
  'are the caller''s own; validated whole; at most 2,000 cards; rate-limited.';

revoke all on function public.add_lesson_cards(jsonb) from public, anon;
grant execute on function public.add_lesson_cards(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. review_lesson_card -- one review, one reschedule
-- ---------------------------------------------------------------------------
--
-- The grade the browser gave the answer (a quiz answer right is `perfect`,
-- wrong `mistake`; a trainer spot keeps the analysis' grade) is SM-2's
-- quality through `drill_quality`; the schedule is `drill_next`.

create or replace function public.review_lesson_card(p_card uuid, p_grade text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_card    public.lesson_cards%rowtype;
  v_quality integer;
  v_next    record;
  v_due     timestamptz;
begin
  if v_owner is null then
    raise exception 'You must be signed in to review cards.' using errcode = '42501';
  end if;
  v_quality := public.drill_quality(p_grade);
  if v_quality is null then
    raise exception 'Unknown grade: %', p_grade using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('lesson_review:' || v_owner::text, 1, 600, interval '10 minutes');

  -- The ownership check: by id *and* owner, one answer for "not yours" and "not there".
  select * into v_card from public.lesson_cards where id = p_card and owner_id = v_owner for update;
  if not found then
    raise exception 'No such card.' using errcode = 'P0002';
  end if;

  select * into v_next from public.drill_next(v_card.reps, v_card.lapses, v_card.ease, v_card.interval_days, v_quality);
  v_due := case when v_next.relearn then now() + interval '10 minutes'
                else now() + make_interval(days => v_next.interval_days) end;

  update public.lesson_cards
     set reps = v_next.reps,
         lapses = v_next.lapses,
         ease = v_next.ease,
         interval_days = v_next.interval_days,
         due_at = v_due,
         reviews = reviews + 1,
         last_grade = p_grade,
         last_reviewed_at = now()
   where id = p_card and owner_id = v_owner;

  return jsonb_build_object(
    'id', p_card,
    'reps', v_next.reps,
    'lapses', v_next.lapses,
    'ease', v_next.ease,
    'intervalDays', v_next.interval_days,
    'dueAt', v_due,
    'relearn', v_next.relearn);
end;
$$;

comment on function public.review_lesson_card(uuid, text) is
  'Records one review of the caller''s lesson card and reschedules it (SM-2: drill_quality, drill_next). '
  'Definer: the card is named by id and owner ("No such card." either way); rate-limited.';

revoke all on function public.review_lesson_card(uuid, text) from public, anon;
grant execute on function public.review_lesson_card(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The study plan's `lesson` task
-- ---------------------------------------------------------------------------

alter table public.study_tasks drop constraint if exists study_tasks_kind_check;
alter table public.study_tasks
  add constraint study_tasks_kind_check check (kind in ('read', 'train', 'drill', 'review', 'lesson'));

-- `20270215090000_analysis_study_plan.sql`'s writer, with one more task kind:
-- `lesson`, whose reference is a lesson id. Everything else is unchanged.
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
    if v_task.kind is null or v_task.kind not in ('read', 'train', 'drill', 'review', 'lesson') then
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
               when 'lesson' then v_task.ref !~ '^[a-z0-9][a-z0-9-]{1,63}$'
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
  'validated (a lesson task names a lesson id), a review hand must be the caller''s; rate-limited.';

revoke all on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) to authenticated;

-- `20270215090000_analysis_study_plan.sql`'s reader, with one more count: a
-- lesson task is done when the caller has passed the lesson (at any time --
-- a lesson passed is passed).
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
             when 'lesson' then (
               select count(*)
               from public.lesson_progress lp
               where lp.owner_id = v_owner and lp.lesson_id = t.ref and lp.status = 'passed')
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
  'inside the week, lessons passed, or ticked by hand); null when the week has none. Invoker.';

revoke all on function public.study_plan(date, timestamptz) from public, anon;
grant execute on function public.study_plan(date, timestamptz) to authenticated;

commit;
