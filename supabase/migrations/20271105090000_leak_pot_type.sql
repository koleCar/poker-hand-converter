-- ===========================================================================
-- Rail: a postflop leak area per pot type (single-raised, 3-bet, 4-bet+)
-- ===========================================================================
--
-- Since 20271103090000 a flop, turn or river leak area carries its table
-- (`~hu`, `~9max`), but not its pot: `analysis_leak_rows` keeps the hand's
-- `pot_type`, yet `analysis_leaks` returned one row per spot key and set, so a
-- single-raised and a 3-bet flop area with the same seat, role, side and
-- table were one area - its trainer dealt both kinds of line and its drills,
-- hands and examples mixed them (`docs/ANALYSIS-PLAN.md` §10, 2026-11-02,
-- "Open"). From this change the leak finder tags a postflop spot in a 3-bet
-- pot `~3bp` and one in a 4-bet-or-more pot `~4bp`
-- (`web/src/lib/analysis/leaks.ts`; the flop library's own pot names,
-- `FlopLine.pot`); single-raised, limped (its own `limped-` scenario
-- already) and unknown pots stay untagged, so their ids do not change.
--
-- What changes:
--
--   * `analysis_leak_pot_of(pot_type)`: the pot tag of a hand's pot type -
--     `3bp` (`3bet`), `4bp` (`4bet+`), `other` for everything else.
--     Immutable, reads nothing but its argument; executable by
--     `authenticated` (the invoker readers call it), not by `anon`.
--   * The leak list (`analysis_leaks`, `analysis_leaks_scan`) and the top
--     leaks' samples (`analysis_leak_sample`) return a postflop row per spot,
--     set and pot: a row in a 3-bet or 4-bet+ pot says `pot` (`3bp`, `4bp`);
--     every other row is as before (no `pot` key), so an answer over
--     single-raised play only is byte for byte what it was. The leak sums
--     already keep the pot type (`analysis_leak_totals.pot_type`); the room
--     and stake sums (`analysis_leak_stake_totals`) do not, so under a room or
--     stake chip the 3-bet and 4-bet+ postflop rows in scope are read from the
--     leak rows (a partial index holds just them) and moved out of the
--     untagged row - no new key column, no backfill, no trigger change.
--   * The hands behind a leak (`analysis_leak_hands` and its scan) take an
--     optional `leakPot` filter key (`3bp`, `4bp`, `other`; absent: every
--     pot, as before); the top leaks' examples (`analysis_leak_examples`) an
--     optional `pot` per leak, as `table` since 20271104120000. Anything else
--     is refused.
--   * Drills: `drill_due_by_spot_pots` (new; `drill_due_by_spot_tables`'
--     rows, each also saying `pots`, its items and due per table and pot) and
--     `drill_queue_on_area` (new; `drill_queue_on_table` on one table and one
--     pot). New functions, as in 20271104120000: `drill_queue`,
--     `drill_due_by_spot` and the two per-table readers stay byte for byte.
--     Both gated (listed in `entitlement_gates`), empty search_path,
--     `authenticated` only.
--
-- Every re-created function is its last definition (20271104090000,
-- 20271102090000, 20271103090000, 20271104120000) with the pot added;
-- signatures, grants and comments otherwise unchanged; the R6.2 entitlement
-- gate is put back with `entitlement_gates_apply()`.
--
-- Not changed: no table column, no grade, no `analysis/N`; nothing is
-- written. Client writes: none.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. A pot type's tag; the rows that carry one
-- ---------------------------------------------------------------------------

create or replace function public.analysis_leak_pot_of(p_pot_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case coalesce(p_pot_type, '')
           when '3bet' then '3bp'
           when '4bet+' then '4bp'
           else 'other'
         end;
$$;

comment on function public.analysis_leak_pot_of(text) is
  'The leak finder''s pot tag of a hand''s pot type: 3bp (3bet), 4bp (4bet+), or other (single-raised, limped, '
  'walk, bomb, none). A postflop leak area''s pot (20271105090000).';

revoke all on function public.analysis_leak_pot_of(text) from public, anon;
grant execute on function public.analysis_leak_pot_of(text) to authenticated;

-- The postflop rows in a 3-bet or 4-bet+ pot: what the leak list moves out of
-- the room and stake sums' untagged rows (a minority of the rows).
create index if not exists analysis_leak_rows_pot_idx
  on public.analysis_leak_rows (owner_id, analysis_version, site)
  where street <> 'preflop' and pot_type in ('3bet', '4bet+');

-- ---------------------------------------------------------------------------
-- 2. The leak list, per pot
-- ---------------------------------------------------------------------------

-- `20271104090000_game_kind_filter.sql`'s definition, with the pot.
create or replace function public.analysis_leaks(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  q         public.analysis_filter;
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_leaks_scan(p_filters);
  end if;

  declare
    -- totals: all time under format, seat, pot type; stakes: all time under
    -- a room and / or a stake; complement: a range under format, seat, pot
    -- type that holds most of the history (the totals less the rows outside
    -- it); rows: the leak rows in scope.
    v_mode   text;
    v_inside numeric;
    v_all    numeric;
  begin
    if public.analysis_filter_sums_ok(q) then
      v_mode := 'totals';
    elsif q.from_at is null and q.to_at is null and q.formats is null and q."position" is null and q.pot_type is null then
      v_mode := 'stakes';
    elsif q.site is null and q.currency is null and q.big_blind is null then
      select sum(m.hands) filter (where (q.from_at is null or m.month >= public.analysis_month_of(q.from_at))
                                    and (q.to_at is null or m.month <= public.analysis_month_of(q.to_at))
                                    and m.month > '-infinity'::date),
             sum(m.hands)
        into v_inside, v_all
      from public.analysis_month_hands m
      where m.owner_id = v_owner and m.analysis_version = v_version;
      v_mode := case when coalesce(v_inside, 0) * 2 > coalesce(v_all, 0) then 'complement' else 'rows' end;
    else
      v_mode := 'rows';
    end if;

    with g as materialized (
      -- rows: the graded leak rows in scope; complement: those outside the range
      select z.hand_id, z.spot_key, z.chart_set,
             case when z.street <> 'preflop' then nullif(public.analysis_leak_pot_of(z.pot_type), 'other') end as pot,
             z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where v_mode in ('rows', 'complement')
        and z.owner_id = v_owner and z.analysis_version = v_version and z.grade is not null
        and (q.site is null or z.site = q.site)
        and (q.formats is null or z.game_format = any (q.formats))
        and (q.currency is null or z.currency = q.currency)
        and (q.big_blind is null or z.big_blind = q.big_blind)
        and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
        and (q.pot_type is null or z.pot_type = q.pot_type)
        and case when v_mode = 'rows'
                 then (q.from_at is null or z.played_at >= q.from_at) and (q.to_at is null or z.played_at < q.to_at)
                 else (q.from_at is not null and (z.played_at < q.from_at or z.played_at is null))
                   or (q.to_at is not null and (z.played_at >= q.to_at or z.played_at is null))
            end
    ),
    -- stakes: the room and stake sums keep no pot type, so the postflop rows
    -- in a 3-bet or 4-bet+ pot in scope are read from the rows (20271105090000)
    p as materialized (
      select z.hand_id, z.spot_key, z.chart_set, public.analysis_leak_pot_of(z.pot_type) as pot,
             z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where v_mode = 'stakes'
        and z.owner_id = v_owner and z.analysis_version = v_version and z.grade is not null
        and z.street <> 'preflop' and z.pot_type in ('3bet', '4bet+')
        and (q.site is null or z.site = q.site)
        and (q.currency is null or z.currency = q.currency)
        and (q.big_blind is null or z.big_blind = q.big_blind)
    ),
    s as (
      select t.spot_key, t.chart_set,
             case when split_part(t.spot_key, '|', 1) <> 'preflop'
                  then nullif(public.analysis_leak_pot_of(t.pot_type), 'other') end as pot,
             t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_totals t
      where v_mode in ('totals', 'complement')
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.formats is null or t.game_format = any (q.formats))
        and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
        and (q.pot_type is null or t.pot_type = q.pot_type)
      union all
      select t.spot_key, t.chart_set, null::text, t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_stake_totals t
      where v_mode = 'stakes'
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.site is null or t.site = q.site)
        and (q.currency is null or t.currency = q.currency)
        and (q.big_blind is null or t.big_blind = q.big_blind)
      union all
      -- stakes: each 3-bet or 4-bet+ postflop part on its own row, out of the untagged one
      -- (a hand has one pot type, so its distinct hands move whole)
      select p.spot_key, p.chart_set, x.pot, x.sign * count(*), x.sign * count(distinct p.hand_id),
             x.sign * count(*) filter (where p.grade <> 'perfect'),
             x.sign * count(*) filter (where p.grade in ('inaccurate', 'mistake', 'blunder')),
             x.sign * sum(p.ev_loss_bb), x.sign * sum(p.ev_loss_pot),
             x.sign * coalesce(sum(p.score), 0), x.sign * coalesce(sum(p.score * p.score), 0)
      from p
      cross join lateral (values (p.pot, 1), (null::text, -1)) x(pot, sign)
      group by p.spot_key, p.chart_set, p.pot, x.pot, x.sign
      union all
      select g.spot_key, g.chart_set, g.pot, count(*), count(distinct g.hand_id),
             count(*) filter (where g.grade <> 'perfect'),
             count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             sum(g.ev_loss_bb), sum(g.ev_loss_pot), coalesce(sum(g.score), 0), coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'rows'
      group by 1, 2, 3
      union all
      select g.spot_key, g.chart_set, g.pot, -count(*), -count(distinct g.hand_id),
             -count(*) filter (where g.grade <> 'perfect'),
             -count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             -sum(g.ev_loss_bb), -sum(g.ev_loss_pot), -coalesce(sum(g.score), 0), -coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'complement'
      group by 1, 2, 3
    ),
    x as materialized (
      select spot_key, chart_set, pot, sum(decisions)::bigint as n, sum(hands)::bigint as hands,
             sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum, sum(score_sq) as score_sq
      from s
      group by spot_key, chart_set, pot
      having sum(decisions) > 0
    )
    select jsonb_build_object(
      'analysisVersion', v_version,
      'hands', case v_mode
                 when 'rows' then (select count(distinct hand_id) from g)
                 when 'stakes' then (
                   select coalesce(sum(t.graded_hands), 0)::bigint from public.analysis_graded_sites t
                   where t.owner_id = v_owner and t.analysis_version = v_version
                     and (q.site is null or t.site = q.site)
                     and (q.currency is null or t.currency = q.currency)
                     and (q.big_blind is null or t.big_blind = q.big_blind))
                 else (
                   select coalesce(sum(k.graded_hands), 0)::bigint from public.analysis_overview_keys k
                   where k.owner_id = v_owner and k.analysis_version = v_version and k.kind = 'all'
                     and (q.formats is null or k.game_format = any (q.formats))
                     and (q."position" is null or (q."position" <> '' and k.hero_position = q."position"))
                     and (q.pot_type is null or k.pot_type = q.pot_type))
                   - case when v_mode = 'complement' then (select count(distinct hand_id) from g) else 0 end
               end,
      'graded', (select coalesce(sum(x.n), 0)::bigint from x),
      -- The first and last graded hand in scope, by the hand rows' time index.
      'first',  (select min(r.played_at) from public.analysis_hand_rows r
                 where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
                   and (q.from_at is null or r.played_at >= q.from_at)
                   and (q.to_at is null or r.played_at < q.to_at)
                   and (q.site is null or r.site = q.site)
                   and (q.formats is null or r.game_format = any (q.formats))
                   and (q.currency is null or r.currency = q.currency)
                   and (q.big_blind is null or r.big_blind = q.big_blind)
                   and (q."position" is null or r.hero_position = q."position")
                   and (q.pot_type is null or r.pot_type = q.pot_type)),
      'last',   (select max(r.played_at) from public.analysis_hand_rows r
                 where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
                   and (q.from_at is null or r.played_at >= q.from_at)
                   and (q.to_at is null or r.played_at < q.to_at)
                   and (q.site is null or r.site = q.site)
                   and (q.formats is null or r.game_format = any (q.formats))
                   and (q.currency is null or r.currency = q.currency)
                   and (q.big_blind is null or r.big_blind = q.big_blind)
                   and (q."position" is null or r.hero_position = q."position")
                   and (q.pot_type is null or r.pot_type = q.pot_type)),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'key',        x.spot_key,
                 'set',        nullif(x.chart_set, ''),
                 'street',     split_part(x.spot_key, '|', 1),
                 'scenario',   split_part(x.spot_key, '|', 2),
                 'line',       split_part(x.spot_key, '|', 3),
                 'position',   split_part(x.spot_key, '|', 4),
                 'taken',      split_part(x.spot_key, '|', 5),
                 'best',       split_part(x.spot_key, '|', 6),
                 'decisions',  x.n,
                 'hands',      x.hands,
                 'nonPerfect', x.non_perfect,
                 'mistakes',   x.mistakes,
                 'evLossBb',   round(x.ev_bb, 3),
                 'evLossPot',  round(x.ev_pot, 4),
                 'scoreSum',   round(x.score_sum, 2),
                 'scoreSq',    round(x.score_sq, 2))
                 || case when x.pot is not null then jsonb_build_object('pot', x.pot) else '{}'::jsonb end
               order by x.spot_key, nullif(x.chart_set, '') nulls first, x.pot nulls first)
        from x), '[]'::jsonb),
      'facets', public.analysis_graded_facets(v_version))
    into v_out;
  end;

  return v_out;
end;
$$;

revoke all on function public.analysis_leaks(jsonb) from public, anon;
grant execute on function public.analysis_leaks(jsonb) to authenticated;

-- `20271102090000_leak_row_table.sql`'s definition, with the pot.
CREATE OR REPLACE FUNCTION public.analysis_leaks_scan(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;

  with g as materialized (
    select d.*,
           case when d.source = 'chart'
                 and coalesce(dd.facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
                then dd.facts -> 'chart' ->> 'set'
                -- A postflop decision: its hand's table (20271102090000), as the leak rows keep it.
                when d.street <> 'preflop'
                then nullif(public.analysis_hand_table_set(hh.phf), '') end as chart_set,
           -- A postflop decision in a 3-bet or 4-bet+ pot: its tag (20271105090000).
           case when d.street <> 'preflop' then nullif(public.analysis_leak_pot_of(d.pot_type), 'other') end as pot
    from public.analysis_graded_decisions(p_filters) d
    left join public.decision_analysis dd
      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version and dd.owner_id = v_owner
    left join public.hands hh
      on d.street <> 'preflop' and hh.id = d.hand_id and hh.owner_id = v_owner
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',  (select count(distinct hand_id) from g),
    'graded', (select count(*) from g),
    'first',  (select min(played_at) from g),
    'last',   (select max(played_at) from g),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key',        x.spot_key,
               'set',        x.chart_set,
               'street',     x.street,
               'scenario',   x.scenario,
               'line',       x.line,
               'position',   x.pos,
               'taken',      x.taken,
               'best',       x.best,
               'decisions',  x.n,
               'hands',      x.hands,
               'nonPerfect', x.non_perfect,
               'mistakes',   x.mistakes,
               'evLossBb',   x.ev_bb,
               'evLossPot',  x.ev_pot,
               'scoreSum',   x.score_sum,
               'scoreSq',    x.score_sq)
               || case when x.pot is not null then jsonb_build_object('pot', x.pot) else '{}'::jsonb end
             order by x.spot_key, x.chart_set nulls first, x.pot nulls first)
      from (
        select g.spot_key, g.chart_set, g.pot, g.street, g.scenario, g.line, g."position" as pos, g.taken, g.best,
               count(*) as n,
               count(distinct g.hand_id) as hands,
               count(*) filter (where g.grade <> 'perfect') as non_perfect,
               count(*) filter (where public.analysis_grade_rank(g.grade) >= 3) as mistakes,
               round(sum(g.ev_loss_bb), 3) as ev_bb,
               round(sum(g.ev_loss_pot), 4) as ev_pot,
               round(coalesce(sum(g.score), 0), 2) as score_sum,
               round(coalesce(sum(g.score * g.score), 0), 2) as score_sq
        from g
        group by g.spot_key, g.chart_set, g.pot, g.street, g.scenario, g.line, g."position", g.taken, g.best
      ) x), '[]'::jsonb),
    'facets', public.analysis_graded_facets(v_version)
  ) into v_out;

  return v_out;
end;
$function$;

revoke all on function public.analysis_leaks_scan(jsonb) from public, anon;
grant execute on function public.analysis_leaks_scan(jsonb) to authenticated;

-- `20271104090000_game_kind_filter.sql`'s definition, with the pot.
create or replace function public.analysis_leak_sample(
  p_owner uuid, p_version text, p_formats text[], p_position text, p_pot text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := case when p_owner = auth.uid() then p_owner end;
begin
  if p_from is null and p_to is null then
    return (
      select jsonb_build_object(
        'hands', coalesce((
          select sum(k.graded_hands)::bigint from public.analysis_overview_keys k
          where k.owner_id = v_owner and k.analysis_version = p_version and k.kind = 'all'
            and (p_formats is null or k.game_format = any (p_formats))
            and (p_position is null or k.hero_position = p_position)
            and (p_pot is null or k.pot_type = p_pot)), 0),
        'graded', coalesce(sum(x.n), 0),
        'rows', coalesce(jsonb_agg(jsonb_build_object(
                  'key',        x.spot_key,
                  'set',        nullif(x.chart_set, ''),
                  'street',     split_part(x.spot_key, '|', 1),
                  'scenario',   split_part(x.spot_key, '|', 2),
                  'line',       split_part(x.spot_key, '|', 3),
                  'position',   split_part(x.spot_key, '|', 4),
                  'taken',      split_part(x.spot_key, '|', 5),
                  'best',       split_part(x.spot_key, '|', 6),
                  'decisions',  x.n,
                  'hands',      x.n,
                  'nonPerfect', x.non_perfect,
                  'mistakes',   x.mistakes,
                  'evLossBb',   round(x.ev_bb, 3),
                  'evLossPot',  round(x.ev_pot, 4),
                  'scoreSum',   round(x.score_sum, 2),
                  'scoreSq',    round(x.score_sq, 2))
                  || case when x.pot is not null then jsonb_build_object('pot', x.pot) else '{}'::jsonb end
                order by x.spot_key, nullif(x.chart_set, '') nulls first, x.pot nulls first), '[]'::jsonb))
      from (
        select spot_key, chart_set,
               case when split_part(spot_key, '|', 1) <> 'preflop'
                    then nullif(public.analysis_leak_pot_of(pot_type), 'other') end as pot,
               sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
               sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum,
               sum(score_sq) as score_sq
        from public.analysis_leak_totals
        where owner_id = v_owner and analysis_version = p_version
          and (p_formats is null or game_format = any (p_formats))
          and (p_position is null or hero_position = p_position)
          and (p_pot is null or pot_type = p_pot)
        group by 1, 2, 3
      ) x);
  end if;

  return (
    with g as materialized (
      select z.hand_id, z.spot_key, z.chart_set,
             case when z.street <> 'preflop' then nullif(public.analysis_leak_pot_of(z.pot_type), 'other') end as pot,
             z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where z.owner_id = v_owner and z.analysis_version = p_version and z.grade is not null
        and (p_from is null or z.day >= p_from) and (p_to is null or z.day <= p_to)
        -- the same days as times, so the window is read by the time index (a
        -- day from p_from on has a time; a day up to p_to may have none)
        and (p_from is null or z.played_at >= (p_from::timestamp at time zone 'UTC'))
        and (p_to is null or z.played_at < ((p_to + 1)::timestamp at time zone 'UTC')
             or (p_from is null and z.played_at is null))
        and (p_formats is null or z.game_format = any (p_formats))
        and (p_position is null or z.hero_position = p_position)
        and (p_pot is null or z.pot_type = p_pot)
    )
    select jsonb_build_object(
      'hands', (select count(distinct hand_id) from g),
      'graded', coalesce(sum(x.n), 0),
      'rows', coalesce(jsonb_agg(jsonb_build_object(
                'key',        x.spot_key,
                'set',        nullif(x.chart_set, ''),
                'street',     split_part(x.spot_key, '|', 1),
                'scenario',   split_part(x.spot_key, '|', 2),
                'line',       split_part(x.spot_key, '|', 3),
                'position',   split_part(x.spot_key, '|', 4),
                'taken',      split_part(x.spot_key, '|', 5),
                'best',       split_part(x.spot_key, '|', 6),
                'decisions',  x.n,
                'hands',      x.n,
                'nonPerfect', x.non_perfect,
                'mistakes',   x.mistakes,
                'evLossBb',   round(x.ev_bb, 3),
                'evLossPot',  round(x.ev_pot, 4),
                'scoreSum',   round(x.score_sum, 2),
                'scoreSq',    round(x.score_sq, 2))
                || case when x.pot is not null then jsonb_build_object('pot', x.pot) else '{}'::jsonb end
              order by x.spot_key, nullif(x.chart_set, '') nulls first, x.pot nulls first), '[]'::jsonb))
    from (
      select spot_key, chart_set, pot, count(*) as n,
             count(*) filter (where grade <> 'perfect') as non_perfect,
             count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot,
             coalesce(sum(score), 0) as score_sum, coalesce(sum(score * score), 0) as score_sq
      from g
      group by spot_key, chart_set, pot
    ) x);
end;
$$;

revoke all on function public.analysis_leak_sample(uuid, text, text[], text, text, date, date) from public, anon;
grant execute on function public.analysis_leak_sample(uuid, text, text[], text, text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The hands behind a leak, on its pot
-- ---------------------------------------------------------------------------

-- `20271103090000_leak_hands_table.sql`'s definition, with `leakPot`.
CREATE OR REPLACE FUNCTION public.analysis_leak_hands_scan(p_filters jsonb DEFAULT '{}'::jsonb, p_keys text[] DEFAULT NULL::text[], p_deviations boolean DEFAULT true, p_sort text DEFAULT 'ev_loss'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  v_table  text := nullif(btrim(coalesce(p_filters ->> 'leakTable', '')), '');
  v_pot    text := nullif(btrim(coalesce(p_filters ->> 'leakPot', '')), '');
  v_version text := public.analysis_version_of(p_filters);
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 500 then
    raise exception 'analysis_leak_hands needs between 1 and 500 spot keys.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_keys) k
    where k is null
       or k !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$'
  ) then
    raise exception 'Not a spot key.' using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;
  if v_table is not null and v_table not in ('hu', '9max', 'other') then
    raise exception 'Unknown leak table: %', v_table using errcode = '22023';
  end if;
  if v_pot is not null and v_pot not in ('3bp', '4bp', 'other') then
    raise exception 'Unknown leak pot: %', v_pot using errcode = '22023';
  end if;

  with m as materialized (
    select g.*
    from public.analysis_graded_decisions(p_filters) g
    -- The decision's set as the leak rows keep it (20271102090000), read only under a table filter.
    left join public.decision_analysis dt
      on v_table is not null and g.source = 'chart'
     and dt.hand_id = g.hand_id and dt.ord = g.ord and dt.analysis_version = v_version and dt.owner_id = v_owner
    left join public.hands ht
      on v_table is not null and g.street <> 'preflop' and ht.id = g.hand_id and ht.owner_id = v_owner
    where g.spot_key = any (p_keys)
      and (not v_dev or g.grade <> 'perfect')
      and (v_table is null
           or public.analysis_leak_table_of(
                case when g.source = 'chart'
                      and coalesce(dt.facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
                     then dt.facts -> 'chart' ->> 'set'
                     when g.street <> 'preflop'
                     then public.analysis_hand_table_set(ht.phf) end) = v_table)
      -- The hand's pot type, as the leak rows keep it (20271105090000).
      and (v_pot is null or public.analysis_leak_pot_of(g.pot_type) = v_pot)
  ),
  page as (
    select
      row_number() over (
        order by
          case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
          case when v_sort = 'oldest' then m.played_at end asc nulls last,
          m.played_at desc nulls last,
          m.hand_id,
          m.ord
      ) as rn,
      m.hand_id,
      m.ord,
      jsonb_build_object(
        'handId',      m.hand_id,
        'ord',         m.ord,
        'actionIndex', m.action_index,
        'playedAt',    m.played_at,
        'site',        h.site,
        'stakesLabel', h.stakes_label,
        'position',    m."position",
        'heroCards',   to_jsonb(h.hero_cards),
        'street',      m.street,
        'scenario',    m.scenario,
        'line',        m.line,
        'taken',       m.taken,
        'best',        m.best,
        'source',      m.source,
        'grade',       m.grade,
        'evLossBb',    m.ev_loss_bb,
        'evLossPot',   m.ev_loss_pot
      ) as base
    from m
    join public.hands h on h.id = m.hand_id and h.owner_id = v_owner
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((
           select jsonb_agg(p.base || jsonb_build_object(
                    'handClass', dd.facts ->> 'handClass',
                    'options',   dd.options,
                    'chosen',    dd.chosen) order by p.rn)
           from page p
           join public.decision_analysis dd
             on dd.hand_id = p.hand_id and dd.ord = p.ord
            and dd.analysis_version = public.analysis_version_of(p_filters) and dd.owner_id = v_owner), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$function$;

revoke all on function public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer) from public, anon;
grant execute on function public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer) to authenticated;

-- `20271104090000_game_kind_filter.sql`'s definition, with `leakPot`.
create or replace function public.analysis_leak_hands(
  p_filters    jsonb   default '{}'::jsonb,
  p_keys       text[]  default null,
  p_deviations boolean default true,
  p_sort       text    default 'ev_loss',
  p_limit      integer default 25,
  p_offset     integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'ev_loss');
  v_dev    boolean := coalesce(p_deviations, true);
  v_table  text := nullif(btrim(coalesce(p_filters ->> 'leakTable', '')), '');
  v_pot    text := nullif(btrim(coalesce(p_filters ->> 'leakPot', '')), '');
  q        public.analysis_filter;
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_keys is null or cardinality(p_keys) = 0 or cardinality(p_keys) > 500 then
    raise exception 'analysis_leak_hands needs between 1 and 500 spot keys.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_keys) k
    where k is null
       or k !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$'
  ) then
    raise exception 'Not a spot key.' using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;
  if v_table is not null and v_table not in ('hu', '9max', 'other') then
    raise exception 'Unknown leak table: %', v_table using errcode = '22023';
  end if;
  if v_pot is not null and v_pot not in ('3bp', '4bp', 'other') then
    raise exception 'Unknown leak pot: %', v_pot using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_leak_hands_scan(p_filters, p_keys, p_deviations, p_sort, p_limit, p_offset);
  end if;

  -- The keys' graded leak rows in scope (each key's rows by its index).
  with m as materialized (
    select z.hand_id, z.ord, z.action_index, z.played_at, z.spot_key, z.source, z.grade, z.ev_loss_bb, z.ev_loss_pot
    from (select distinct k from unnest(p_keys) k) keys
    join public.analysis_leak_rows z
      on z.owner_id = v_owner and z.analysis_version = q.version and z.spot_key = keys.k
    where z.grade is not null
      and (not v_dev or z.grade <> 'perfect')
      and (q.from_at is null or z.played_at >= q.from_at)
      and (q.to_at is null or z.played_at < q.to_at)
      and (q.site is null or z.site = q.site)
      and (q.formats is null or z.game_format = any (q.formats))
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
      and (v_table is null or public.analysis_leak_table_of(z.chart_set) = v_table)
      and (v_pot is null or public.analysis_leak_pot_of(z.pot_type) = v_pot)
  ),
  page as (
    select m.*,
           row_number() over (
             order by
               case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
               case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
               case when v_sort = 'oldest' then m.played_at end asc nulls last,
               m.played_at desc nulls last,
               m.hand_id,
               m.ord) as rn
    from m
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'handId',      p.hand_id,
                    'ord',         p.ord,
                    'actionIndex', p.action_index,
                    'playedAt',    p.played_at,
                    'site',        h.site,
                    'stakesLabel', h.stakes_label,
                    'position',    split_part(p.spot_key, '|', 4),
                    'heroCards',   to_jsonb(h.hero_cards),
                    'street',      split_part(p.spot_key, '|', 1),
                    'scenario',    split_part(p.spot_key, '|', 2),
                    'line',        split_part(p.spot_key, '|', 3),
                    'taken',       split_part(p.spot_key, '|', 5),
                    'best',        split_part(p.spot_key, '|', 6),
                    'source',      p.source,
                    'grade',       p.grade,
                    'evLossBb',    p.ev_loss_bb,
                    'evLossPot',   p.ev_loss_pot,
                    'handClass',   dd.facts ->> 'handClass',
                    'options',     dd.options,
                    'chosen',      dd.chosen) order by p.rn)
           from page p
           join public.hands h on h.id = p.hand_id and h.owner_id = v_owner
           join public.decision_analysis dd
             on dd.hand_id = p.hand_id and dd.ord = p.ord and dd.analysis_version = q.version and dd.owner_id = v_owner),
           '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$$;

comment on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) is
  'One page of the caller''s graded decisions at the given leak spots (by default only those worse '
  'than Perfect), with their hands, costliest first; filters.leakTable (hu, 9max, other) keeps one '
  'table (20271103090000), filters.leakPot (3bp, 4bp, other) one pot (20271105090000). Invoker.';

revoke all on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) from public, anon;
grant execute on function public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A top leak's examples on its pot
-- ---------------------------------------------------------------------------

-- `20271104120000_drills_by_table.sql`'s definition, with a leak's optional `pot`.
CREATE OR REPLACE FUNCTION public.analysis_leak_examples(p_filters jsonb DEFAULT '{}'::jsonb, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_leaks jsonb DEFAULT '[]'::jsonb, p_limit integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner    uuid := auth.uid();
  v_version  text := public.analysis_version_of(p_filters);
  v_formats   text[] := public.filter_formats(p_filters);
  v_position text := nullif(upper(btrim(coalesce(p_filters ->> 'position', ''))), '');
  v_pot      text := nullif(btrim(coalesce(p_filters ->> 'potType', '')), '');
  v_limit    integer := least(greatest(coalesce(p_limit, 15), 1), 30);
  v_out      jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_leaks is null or jsonb_typeof(p_leaks) <> 'array' or jsonb_array_length(p_leaks) > 10 then
    raise exception 'analysis_leak_examples takes at most 10 leaks.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_leaks) l
    where jsonb_typeof(l) <> 'object'
       or jsonb_typeof(l -> 'id') <> 'string' or char_length(l ->> 'id') > 200
       or jsonb_typeof(l -> 'keys') <> 'array'
       or jsonb_array_length(l -> 'keys') not between 1 and 200
       or exists (
         select 1 from jsonb_array_elements(l -> 'keys') k
         where jsonb_typeof(k) <> 'string'
            or (k #>> '{}') !~ '^(preflop|flop|turn|river)\|[a-z0-9][a-z0-9-]{0,39}\|[fkcra]{0,24}\|[A-Z0-9+]{0,8}\|(fold|check|call|bet|raise)\|(fold|check|call|bet|raise)?$')
  ) then
    raise exception 'Not a list of leaks with spot keys.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_leaks) l
    where coalesce(jsonb_typeof(l -> 'table'), 'null') <> 'null'
      and (jsonb_typeof(l -> 'table') <> 'string' or (l ->> 'table') not in ('hu', '9max', 'other'))
  ) then
    raise exception 'Unknown leak table.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_leaks) l
    where coalesce(jsonb_typeof(l -> 'pot'), 'null') <> 'null'
      and (jsonb_typeof(l -> 'pot') <> 'string' or (l ->> 'pot') not in ('3bp', '4bp', 'other'))
  ) then
    raise exception 'Unknown leak pot.' using errcode = '22023';
  end if;

  with leaks as (
    select l.ordinality as n, l.value ->> 'id' as id,
           array(select jsonb_array_elements_text(l.value -> 'keys')) as keys,
           l.value ->> 'table' as tbl,
           l.value ->> 'pot' as pot
    from jsonb_array_elements(p_leaks) with ordinality l
  ),
  picked as (
    select lk.n, lk.id, r.*,
           row_number() over (partition by lk.n order by r.ev_loss_bb desc, r.played_at desc nulls last, r.hand_id, r.ord) as rn
    from leaks lk
    cross join lateral (
      select x.*
      from unnest(lk.keys) k(spot_key)
      cross join lateral (
        select z.hand_id, z.ord, z.action_index, z.played_at, z.spot_key, z.grade, z.ev_loss_bb, z.ev_loss_pot
        from public.analysis_leak_rows z
        where z.owner_id = v_owner and z.analysis_version = v_version and z.spot_key = k.spot_key
          and z.grade <> 'perfect'
          and (p_from is null or z.day >= p_from) and (p_to is null or z.day <= p_to)
          and (v_formats is null or z.game_format = any (v_formats))
          and (v_position is null or z.hero_position = v_position)
          and (v_pot is null or z.pot_type = v_pot)
          and (lk.tbl is null or public.analysis_leak_table_of(z.chart_set) = lk.tbl)
          and (lk.pot is null or public.analysis_leak_pot_of(z.pot_type) = lk.pot)
        order by z.ev_loss_bb desc, z.played_at desc
        limit v_limit
      ) x
    ) r
  )
  select jsonb_build_object('leaks', coalesce(jsonb_agg(jsonb_build_object('id', lk.id, 'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handId',      p.hand_id,
               'ord',         p.ord,
               'actionIndex', p.action_index,
               'playedAt',    p.played_at,
               'site',        h.site,
               'stakesLabel', h.stakes_label,
               'position',    split_part(p.spot_key, '|', 4),
               'heroCards',   to_jsonb(h.hero_cards),
               'handClass',   dd.facts ->> 'handClass',
               'street',      split_part(p.spot_key, '|', 1),
               'scenario',    split_part(p.spot_key, '|', 2),
               'line',        split_part(p.spot_key, '|', 3),
               'taken',       split_part(p.spot_key, '|', 5),
               'best',        split_part(p.spot_key, '|', 6),
               'grade',       p.grade,
               'evLossBb',    p.ev_loss_bb,
               'evLossPot',   p.ev_loss_pot)
             order by p.rn)
      from picked p
      join public.hands h on h.id = p.hand_id and h.owner_id = v_owner
      left join public.decision_analysis dd
        on dd.hand_id = p.hand_id and dd.analysis_version = v_version and dd.ord = p.ord and dd.owner_id = v_owner
      where p.n = lk.n and p.rn <= v_limit), '[]'::jsonb)) order by lk.n), '[]'::jsonb))
    into v_out
  from leaks lk;

  return v_out;
end;
$function$;

revoke all on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) from public, anon;
grant execute on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Drills due per spot, table and pot
-- ---------------------------------------------------------------------------

-- `drill_due_by_spot_tables` (`20271104120000_drills_by_table.sql`) with the
-- per-table, per-pot breakdown; `key`, `items`, `due` and `tables` are
-- computed exactly as there. `drill_due_by_spot_tables` itself is unchanged.
create or replace function public.drill_due_by_spot_pots(p_version text, p_until timestamptz default null, p_kind text default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_until timestamptz := coalesce(p_until, now() + interval '1 day');
  v_out   jsonb;
  v_formats text[] := public.game_kind_formats(p_kind);
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_due_by_spot_pots needs an analysis_version.' using errcode = '22023';
  end if;

  with drilled_tp as (
    select di.spot_key, public.analysis_leak_table_of(z.chart_set) as tbl, public.analysis_leak_pot_of(z.pot_type) as pot,
           count(*) as items, count(*) filter (where di.due_at <= v_until) as due
    from public.drill_items di
    left join public.analysis_leak_rows z
      on z.hand_id = di.hand_id and z.analysis_version = di.analysis_version and z.ord = di.ord
     and z.owner_id = v_owner
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (v_formats is null or exists (
        select 1 from public.hands h
        where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    group by 1, 2, 3
  ),
  drilled_t as (
    select spot_key, tbl, sum(items)::bigint as items, sum(due)::bigint as due
    from drilled_tp
    group by spot_key, tbl
  ),
  drilled as (
    select spot_key, sum(items)::bigint as items, sum(due)::bigint as due
    from drilled_t
    group by spot_key
  ),
  -- Mistakes and blunders at this version not drilled yet: the totals' per
  -- spot, table and pot, less those a drill item (by hand and action) already holds.
  fresh_u as (
    select t.spot_key, public.analysis_leak_table_of(t.chart_set) as tbl, public.analysis_leak_pot_of(t.pot_type) as pot,
           sum(t.g_mistake + t.g_blunder) as items
    from public.analysis_leak_totals t
    where t.owner_id = v_owner and t.analysis_version = p_version
      and (v_formats is null or t.game_format = any (v_formats))
    group by 1, 2, 3
    union all
    select z.spot_key, public.analysis_leak_table_of(z.chart_set), public.analysis_leak_pot_of(z.pot_type), -count(*)
    from public.drill_items x
    join public.analysis_leak_rows z
      on z.hand_id = x.hand_id and z.analysis_version = p_version and z.action_index = x.action_index
     and z.owner_id = v_owner
    where x.owner_id = v_owner and z.grade in ('mistake', 'blunder')
      and (v_formats is null or z.game_format = any (v_formats))
    group by 1, 2, 3
  ),
  -- The key's count as before: summed over its tables, then kept when positive.
  fresh as (
    select spot_key, sum(items)::bigint as items
    from fresh_u
    group by spot_key
    having sum(items) > 0
  ),
  fresh_t as (
    select u.spot_key, u.tbl, sum(u.items)::bigint as items
    from fresh_u u
    where u.spot_key in (select f.spot_key from fresh f)
    group by u.spot_key, u.tbl
    having sum(u.items) > 0
  ),
  fresh_tp as (
    select u.spot_key, u.tbl, u.pot, sum(u.items)::bigint as items
    from fresh_u u
    where (u.spot_key, u.tbl) in (select f.spot_key, f.tbl from fresh_t f)
    group by u.spot_key, u.tbl, u.pot
    having sum(u.items) > 0
  ),
  per_table as (
    select coalesce(d.spot_key, f.spot_key) as spot_key,
           jsonb_object_agg(coalesce(d.tbl, f.tbl), jsonb_build_object(
             'items', coalesce(d.items, 0) + coalesce(f.items, 0),
             'due',   coalesce(d.due, 0) + coalesce(f.items, 0))) as tables
    from drilled_t d
    full join fresh_t f on f.spot_key = d.spot_key and f.tbl = d.tbl
    group by coalesce(d.spot_key, f.spot_key)
  ),
  per_cell as (
    select coalesce(d.spot_key, f.spot_key) as spot_key, coalesce(d.tbl, f.tbl) as tbl,
           jsonb_object_agg(coalesce(d.pot, f.pot), jsonb_build_object(
             'items', coalesce(d.items, 0) + coalesce(f.items, 0),
             'due',   coalesce(d.due, 0) + coalesce(f.items, 0))) as pots
    from drilled_tp d
    full join fresh_tp f on f.spot_key = d.spot_key and f.tbl = d.tbl and f.pot = d.pot
    group by 1, 2
  ),
  per_pot as (
    select spot_key, jsonb_object_agg(tbl, pots) as pots
    from per_cell
    group by spot_key
  ),
  keys as (
    select spot_key from drilled union select spot_key from fresh
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',    k.spot_key,
           'items',  coalesce(d.items, 0) + coalesce(f.items, 0),
           'due',    coalesce(d.due, 0) + coalesce(f.items, 0),
           'tables', coalesce(pt.tables, '{}'::jsonb),
           'pots',   coalesce(pp.pots, '{}'::jsonb)) order by k.spot_key), '[]'::jsonb)
  into v_out
  from keys k
  left join drilled d on d.spot_key = k.spot_key
  left join fresh f on f.spot_key = k.spot_key
  left join per_table pt on pt.spot_key = k.spot_key
  left join per_pot pp on pp.spot_key = k.spot_key;

  return v_out;
end;
$$;

comment on function public.drill_due_by_spot_pots(text, timestamptz, text) is
  'drill_due_by_spot_tables with each key''s counts also per table and pot (pots: {table: {3bp|4bp|other: '
  '{items, due}}}; the drill''s or Mistake''s leak row''s set and pot type). 20271105090000. Invoker.';

revoke all on function public.drill_due_by_spot_pots(text, timestamptz, text) from public, anon;
grant execute on function public.drill_due_by_spot_pots(text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The drill queue on one table and pot
-- ---------------------------------------------------------------------------

-- `drill_queue_on_table` (`20271104120000_drills_by_table.sql`) with the pot
-- filter; `drill_queue_on_table` itself is unchanged.
create or replace function public.drill_queue_on_area(
  p_version  text,
  p_table    text,
  p_pot      text,
  p_keys     text[]  default null,
  p_due_only boolean default true,
  p_limit    integer default 20,
  p_kind     text    default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  v_table text := nullif(btrim(coalesce(p_table, '')), '');
  v_pot   text := nullif(btrim(coalesce(p_pot, '')), '');
  v_out   jsonb;
  v_formats text[] := public.game_kind_formats(p_kind);
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_queue_on_area needs an analysis_version.' using errcode = '22023';
  end if;
  if v_table is null or v_table not in ('hu', '9max', 'other') then
    raise exception 'Unknown leak table: %', coalesce(p_table, 'null') using errcode = '22023';
  end if;
  if v_pot is null or v_pot not in ('3bp', '4bp', 'other') then
    raise exception 'Unknown leak pot: %', coalesce(p_pot, 'null') using errcode = '22023';
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
           'table',        q.tbl,
           'pot',          q.pot,
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
    select di.*, public.analysis_leak_table_of(z.chart_set) as tbl, public.analysis_leak_pot_of(z.pot_type) as pot
    from public.drill_items di
    left join public.analysis_leak_rows z
      on z.hand_id = di.hand_id and z.analysis_version = di.analysis_version and z.ord = di.ord
     and z.owner_id = v_owner
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and (p_keys is null or di.spot_key = any (p_keys))
      and (not coalesce(p_due_only, true) or di.due_at <= now())
      and public.analysis_leak_table_of(z.chart_set) = v_table
      and public.analysis_leak_pot_of(z.pot_type) = v_pot
      and (v_formats is null or exists (
        select 1 from public.hands h
        where h.id = di.hand_id and h.owner_id = v_owner and h.game_format::text = any (v_formats)))
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    order by di.due_at, di.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) q;

  return v_out;
end;
$$;

comment on function public.drill_queue_on_area(text, text, text, text[], boolean, integer, text) is
  'drill_queue on one table (hu, 9max, other) and one pot (3bp, 4bp, other: the item''s leak row''s pot type, '
  'analysis_leak_pot_of): a postflop leak area''s drills, due first. 20271105090000. Invoker.';

revoke all on function public.drill_queue_on_area(text, text, text, text[], boolean, integer, text) from public, anon;
grant execute on function public.drill_queue_on_area(text, text, text, text[], boolean, integer, text) to authenticated;

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.drill_due_by_spot_pots(text,timestamp with time zone,text)', 'analysis', 'drills'),
  ('public.drill_queue_on_area(text,text,text,text[],boolean,integer,text)', 'analysis', 'drills')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

commit;

-- The R6.2 entitlement gate, on the re-created readers and the two new ones.
select public.entitlement_gates_apply();
