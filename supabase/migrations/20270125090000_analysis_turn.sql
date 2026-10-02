-- Hand analysis, phase A5a: turn grading (`docs/ANALYSIS-PLAN.md` §7, §10).
--
-- Turn grades need no table change: a solver-graded turn decision is a
-- `decision_analysis` row like a river one (`source = 'solver'`, `street =
-- 'turn'`, grade, EV loss, options, facts), written by the same
-- `save_hand_analysis`. What does change is how long a backfill takes: a turn
-- solve costs a second or two, so `analysis/4` over a large library takes
-- minutes, and the reader should be able to start with the hands they played
-- last. This adds the read side of that: the caller's hands still to analyse
-- at a version, newest first.
--
-- Security model unchanged: an invoker function under RLS, `search_path`
-- pinned, the caller's own hands only, EXECUTE for `authenticated` alone.
-- No write path, no grant on a table.

-- A keyset page of the caller's hands with no `hand_analysis` row at
-- `p_version`, newest first (`played_at` desc, nulls last, then `id` desc).
-- The cursor is the last row of the previous page: `p_before_played` and
-- `p_before_id` (a null `played_at` sorts as -infinity, and is passed back as
-- null). The phf is trimmed exactly as `hands_needing_analysis` trims it.
create or replace function public.hands_needing_analysis_recent(
  p_version       text,
  p_before_played timestamptz default null,
  p_before_id     uuid        default null,
  p_limit         integer     default 100
)
returns table (id uuid, played_at timestamptz, phf jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner  uuid := (select auth.uid());
  v_before timestamptz := coalesce(p_before_played, '-infinity'::timestamptz);
begin
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis_recent needs an analysis_version.' using errcode = '22023';
  end if;

  return query
  select hd.id,
         hd.played_at,
         jsonb_set(
           hd.phf #- '{meta,rawText}',
           '{actions}',
           coalesce((select jsonb_agg(a - 'rawLine' - 'label' order by ord)
                     from jsonb_array_elements(hd.phf -> 'actions') with ordinality as x(a, ord)),
                    '[]'::jsonb))
  from public.hands hd
  where hd.owner_id = v_owner
    and (p_before_id is null
         or (coalesce(hd.played_at, '-infinity'::timestamptz), hd.id) < (v_before, p_before_id))
    and not exists (
      select 1 from public.hand_analysis a
      where a.hand_id = hd.id and a.analysis_version = p_version)
  order by coalesce(hd.played_at, '-infinity'::timestamptz) desc, hd.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.hands_needing_analysis_recent(text, timestamptz, uuid, integer) is
  'A keyset page of the caller''s hands with no hand_analysis row at the given '
  'version, newest first, with a trimmed phf. The "most recent hands first" read '
  'side of the in-browser analysis (A5a); RLS-scoped.';

revoke all on function public.hands_needing_analysis_recent(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.hands_needing_analysis_recent(text, timestamptz, uuid, integer) to authenticated;
