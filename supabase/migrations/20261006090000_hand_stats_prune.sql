-- ===========================================================================
-- hand_stats: replace the DELETE policy with a narrow definer function
-- ===========================================================================
--
-- `20261005090000_hand_stats.sql` shipped `hand_stats_owner_delete`, a plain
-- owner-scoped DELETE policy, plus a DELETE grant to `authenticated`. That is
-- the one thing the schema's threat model refuses, and the reasoning is worth
-- restating because the policy looks harmless: it is scoped to the caller's own
-- rows, so what is the harm?
--
-- Two things.
--
-- First, the scope is wrong for the job. The only legitimate delete on this
-- table is "remove rows superseded by a `stats_version` bump". An owner-scoped
-- policy also permits `delete from hand_stats` with no predicate at all, which
-- silently throws away the statistics for every hand the account owns. The rows
-- are reconstructible from `hands.phf`, so it is recoverable — but only by a
-- full rebuild that pulls every stored document back over the wire.
--
-- Second, and the reason this is worth a migration of its own: it **establishes
-- the verb**. Every other table in this schema answers a DELETE from PostgREST
-- with "no policy", and that uniformity is itself the guarantee — there is no
-- table where a client-side bug, a compromised anon key or a malformed filter
-- can remove a row. One exception turns a structural property into a per-table
-- question, and the next table to want a delete has a precedent to point at.
--
-- So: the policy and the grant go, and the single legitimate delete becomes a
-- function that can express nothing else.
--
-- `prune_hand_stats` is `security definer`, which is what lets it delete
-- against a table that grants DELETE to nobody. It is safe to hold that
-- privilege because it cannot be aimed:
--
--   * the actor comes from `auth.uid()`, never from an argument;
--   * the only caller-supplied values are the version to keep and a row cap,
--     both of which are bounds rather than targets;
--   * it names one table, and it deletes only rows that are simultaneously the
--     caller's own and *not* at the version they asked to keep — so it cannot
--     touch the data the caller is currently reading, whatever they pass;
--   * the cap is clamped server-side, so a runaway client loop is bounded.
--
-- This mirrors `resolve_share`/`record_share_view`, which hold the schema's only
-- other write privilege on the same terms: definer, one table, nothing
-- aimable.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------- remove ---

drop policy if exists hand_stats_owner_delete on public.hand_stats;
revoke delete on public.hand_stats from authenticated;

-- --------------------------------------------------------------- replace ---

create or replace function public.prune_hand_stats(
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
    raise exception 'You must be signed in to prune statistics.'
      using errcode = '42501';
  end if;

  if p_keep_version is null or btrim(p_keep_version) = '' then
    raise exception 'prune_hand_stats needs the stats_version to keep.'
      using errcode = '22023';
  end if;

  -- `<> p_keep_version` rather than a list of versions to remove: the caller
  -- states what is current and the function derives the rest. A caller cannot
  -- name rows to delete, only rows to spare, so the worst a malformed call can
  -- do is spare the wrong generation -- which costs storage, not data.
  with doomed as (
    select id
    from public.hand_stats
    where owner_id = v_owner
      and stats_version <> p_keep_version
    limit v_cap
  )
  delete from public.hand_stats s
  using doomed d
  where s.id = d.id;

  get diagnostics v_deleted = row_count;

  -- `more` lets a client loop until it drains without guessing at the cap.
  return jsonb_build_object(
    'deleted', v_deleted,
    'more',    v_deleted >= v_cap
  );
end;
$$;

comment on function public.prune_hand_stats(text, integer) is
  'Removes the caller''s own hand_stats rows that are not at the given '
  'stats_version. The schema''s only client-reachable delete, and the only one '
  'it can express -- see 20261006090000_hand_stats_prune.sql.';

revoke all on function public.prune_hand_stats(text, integer) from public;
revoke all on function public.prune_hand_stats(text, integer) from anon;
grant execute on function public.prune_hand_stats(text, integer) to authenticated;

commit;
