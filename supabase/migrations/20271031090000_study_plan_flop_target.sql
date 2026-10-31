-- ===========================================================================
-- Rail: the study plan's flop trainer task (`study_tasks.match_mode = 'flop'`)
-- ===========================================================================
--
-- The study plan gains a flop trainer target (`docs/ANALYSIS-PLAN.md` §10,
-- 2026-10-31): a flop focus area on a line Rail's flop library solves sends
-- the learner to the Train tab's flop mode, and its task counts the caller's
-- kept flop answers (`trainer_results` rows with mode `flop`, kept since
-- `20271028090000_trainer_flop_mode.sql`): family the pot type, spot the
-- library line id with the hero's seat (`<line id>:<seat>`, the river's
-- shape), within the plan's week.
--
-- What changes:
--
--   * `study_tasks.match_mode` takes `flop` beside `preflop` and `river`.
--     Additive: the new check is a superset of the old one, so every stored
--     row passes it and nothing is deleted.
--   * `save_study_plan` (`20270317090000_learn_progress.sql`'s, the last
--     definition) accepts a `flop` trainer filter and a flop task reference
--     (`flop/<set>/<pot>/<side>/<role>/<seat>/<facing>[/<line>]`: six or seven
--     parts of at most 20 characters, the set id being 20). Everything else
--     is unchanged: security definer, empty search_path, `auth.uid()` as the
--     owner, every task validated before anything is written, a review hand
--     must be the caller's, `enforce_rate_limit`, grants (authenticated only).
--   * The R6.2 entitlement gate is put back on the re-created writer with
--     `entitlement_gates_apply()` (idempotent; it gates every listed function
--     that lacks the guard, which after this file is only this one).
--
-- Not changed: `study_plan` (the reader, `20270818090000_big_account_readers.sql`)
-- counts a trainer task by `r.mode = t.match_mode` and the family, position
-- and spots filters whatever the mode, so flop tasks count without a change;
-- RLS (select-own) and the account export are untouched; no client INSERT /
-- UPDATE / DELETE grant is added.
-- ===========================================================================

begin;

alter table public.study_tasks drop constraint if exists study_tasks_match_mode_check;
alter table public.study_tasks
  add constraint study_tasks_match_mode_check check (match_mode in ('preflop', 'flop', 'river'));

-- `20270317090000_learn_progress.sql`'s writer, with the flop trainer task:
-- a `flop` filter and a `flop/...` reference. Everything else is unchanged.
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
                             and v_task.ref !~ '^flop(/[A-Za-z0-9+-]{1,20}){6,7}$'
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
      if v_task.match_mode is null or v_task.match_mode not in ('preflop', 'flop', 'river') then
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
  'validated (a lesson task names a lesson id; a trainer task counts preflop, flop or river answers), a review '
  'hand must be the caller''s; rate-limited.';

revoke all on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_study_plan(date, text, text, jsonb, jsonb, jsonb) to authenticated;

-- The R6.2 entitlement gate, back on the re-created writer.
select public.entitlement_gates_apply();

commit;
