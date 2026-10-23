-- ============================================================================
-- The leak finder's top three (docs/RAIL-PLAN.md R5.2): leak sums kept by
-- triggers, so the three most important leaks open in well under a second at
-- a million hands.
-- ============================================================================
--
-- The leak finder (A6, `20270201090000_analysis_leaks.sql`,
-- `20270303090000_analysis_leaks_sets.sql`) sums every graded decision per
-- finest spot on each call: `analysis_leaks` reads the account's
-- `decision_analysis` rows through `analysis_graded_decisions`, unpacking
-- each row's options (the best action) and facts (chart line, seat, set).
-- Measured for this step at 1 000 000 hands with two graded decisions each
-- (R2.9's harness, `RAIL_PERF_ANALYSIS=1`): several seconds per call, and the
-- top three asks for three samples (the period, the last 30 days of play and
-- the 30 before) and for example hands, whose reader
-- (`analysis_leak_hands`) scans the same rows again. This keeps the leak
-- finder's sums instead, the way R4.5c-1 keeps the reports' (no grading,
-- chart, constant or `analysis/N` changes - the rows are the stored grades,
-- summed):
--
--   1. `analysis_leak_rows` - one narrow row per graded decision (grade not
--      null): its spot key and chart set exactly as `analysis_graded_decisions`
--      and `analysis_leaks` compute them, the hand's UTC day and the three
--      scope filters the Analysis overview has (format, the hero's seat, the
--      pot type), the grade, score and EV loss, and where the replayer opens
--      (`action_index`). Read for example hands (by spot, costliest first:
--      `analysis_leak_rows_examples_idx`) and to take a decision back out of
--      the sums when it is deleted (its hand may already be gone).
--   2. `analysis_leak_days` - those rows summed per (owner, version, day,
--      format, seat, pot type, spot key, chart set): `analysis_leaks`' columns
--      (decisions, worse than Perfect, Inaccurate or worse, EV lost in bb and
--      in pot, score sums and squares).
--   3. `analysis_leak_day_hands` - graded hands per (owner, version, day,
--      format, seat, pot type): the "per 100 hands" denominator.
--
-- A hand without a time is kept under day `-infinity`: in "all time", in no
-- window.
--
-- ## How the sums stay right
--
-- Statement triggers on `decision_analysis`, in the writing statement's
-- transaction (R4.5c-1's reasoning: every writer passes through them with
-- nothing to call, and a row cannot exist without its sums):
--
--   * AFTER INSERT (`save_hand_analysis`, the only writer): the statement's
--     graded rows become leak rows (joined to `hands` for the day, format and
--     seat and to `hand_analysis` for the pot type), are added to the day
--     sums, and a hand that had no leak row before is counted once;
--   * AFTER DELETE (`prune_hand_analysis` and every cascade - a hand deleted,
--     an account deleted): the statement's rows are found among the leak
--     rows (which carry their own day and filters, so a deleted hand is not
--     needed), taken out of the sums, a hand whose last leak row goes is
--     uncounted, and a sum that reaches no decision is deleted.
--
-- Nothing updates `decision_analysis` (no grant, no function); an UPDATE as
-- `postgres` needs `analysis_leak_summaries_rebuild(owner)`, which recounts
-- an account from its rows (also this migration's backfill). The triggers
-- take a per-account advisory lock (to commit), so concurrent writers of one
-- account take turns and their upserts cannot deadlock.
--
-- Held to `analysis_leaks` by pgTAP (`leak_summaries.test.sql`): the same
-- rows, under every filter the reader takes, after inserts, a prune, a hand
-- deleted and a rebuild. A change to how the leak finder computes a spot key
-- or a set has to change `analysis_leak_row_of` with it; that test is what
-- notices.
--
-- ## The readers (invoker, owner-first)
--
--   analysis_top_leaks(filters, period)
--       { analysisVersion, period, last, current: {from, to}, prior: {from, to},
--         sample: {hands, graded, rows}, now: {...}, was: {...} }
--     `rows` are `analysis_leaks`' rows (key, set, street, scenario, line,
--     position, taken, best, decisions, hands, nonPerfect, mistakes,
--     evLossBb, evLossPot, scoreSum, scoreSq) for three samples: the period
--     (`all` - every graded hand - or `30d`, the last 30 days of play), the
--     last 30 days of play (`now`) and the 30 before (`was`). "Days of play"
--     count back from the day of the last graded hand in scope, not from
--     today (A6's "what changed" rule); `last`, `current` and `prior` are
--     those UTC days. Filters: `analysisVersion`, `gameFormat`, `position`
--     (the hero's), `potType` - the overview's; other keys are ignored. Per
--     spot, `hands` is the decisions' days summed (a hand with two decisions
--     in one spot counts twice); the leak finder does not read it.
--   analysis_leak_examples(filters, from, to, leaks, limit)
--       { leaks: [{ id, rows: [{ handId, ord, actionIndex, playedAt, site,
--         stakesLabel, position, heroCards, handClass, street, scenario, line,
--         taken, best, grade, evLossBb, evLossPot }] }] }
--     For each leak (`[{id, keys}]`, at most 10 of at most 200 spot keys),
--     its decisions graded worse than Perfect, costliest first (then the
--     newest), at most `limit` (1-30), inside the days `from`..`to`
--     (inclusive, either open) and the same filters.
--
-- Both read their tables with an explicit `owner_id = (select auth.uid())`
-- first (RLS as well), and neither is granted to `anon`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.analysis_leak_rows (
  hand_id          uuid        not null,
  analysis_version text        not null,
  ord              smallint    not null,
  owner_id         uuid        not null references auth.users (id) on delete cascade,
  action_index     integer     not null,
  played_at        timestamptz,
  day              date        not null,
  game_format      text        not null default '',
  hero_position    text        not null default '',
  pot_type         text        not null default '',
  spot_key         text        not null,
  chart_set        text        not null default '',
  grade            text        not null check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  score            numeric(6, 2),
  ev_loss_bb       numeric(12, 3) not null default 0,
  ev_loss_pot      numeric(10, 4) not null default 0,
  primary key (hand_id, analysis_version, ord)
);

comment on table public.analysis_leak_rows is
  'One row per graded decision, as the leak finder groups it (spot key, chart set) with the hand''s UTC '
  'day, format, seat and pot type: example hands and the delete side of the leak sums (R5.2). Kept by '
  'triggers on decision_analysis.';

-- Example hands over all time: a spot's decisions worse than Perfect,
-- costliest first (the reader stops after its limit).
create index if not exists analysis_leak_rows_examples_idx
  on public.analysis_leak_rows (owner_id, analysis_version, spot_key, ev_loss_bb desc, played_at desc)
  where grade <> 'perfect';
-- ... inside a window of days: the spot's days, then the few rows sorted.
-- Not partial, so it also serves an account's rows (the rebuild, the
-- account's cascade). Measured: a 30-day window walked the costliest-first
-- index past 133 000 rows of other days (0.8 s); this reads the window's.
create index if not exists analysis_leak_rows_days_idx
  on public.analysis_leak_rows (owner_id, analysis_version, spot_key, day);

create table if not exists public.analysis_leak_days (
  owner_id         uuid    not null references auth.users (id) on delete cascade,
  analysis_version text    not null,
  day              date    not null,
  game_format      text    not null,
  hero_position    text    not null,
  pot_type         text    not null,
  spot_key         text    not null,
  chart_set        text    not null,
  decisions        integer not null,
  non_perfect      integer not null,
  mistakes         integer not null,
  ev_loss_bb       numeric not null,
  ev_loss_pot      numeric not null,
  score_sum        numeric not null,
  score_sq         numeric not null,
  primary key (owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set)
);

comment on table public.analysis_leak_days is
  'analysis_leak_rows summed per (owner, version, UTC day, format, seat, pot type, spot key, chart set): '
  'the leak finder''s sums by day (R5.2). Kept by triggers on decision_analysis.';

create table if not exists public.analysis_leak_day_hands (
  owner_id         uuid    not null references auth.users (id) on delete cascade,
  analysis_version text    not null,
  day              date    not null,
  game_format      text    not null,
  hero_position    text    not null,
  pot_type         text    not null,
  hands            integer not null,
  primary key (owner_id, analysis_version, day, game_format, hero_position, pot_type)
);

comment on table public.analysis_leak_day_hands is
  'Hands with a graded decision per (owner, version, UTC day, format, seat, pot type): the leak '
  'finder''s per-100-hands denominator by day (R5.2). Kept by triggers on decision_analysis.';

alter table public.analysis_leak_rows enable row level security;
alter table public.analysis_leak_days enable row level security;
alter table public.analysis_leak_day_hands enable row level security;

revoke all on public.analysis_leak_rows from anon, authenticated;
revoke all on public.analysis_leak_days from anon, authenticated;
revoke all on public.analysis_leak_day_hands from anon, authenticated;
grant select on public.analysis_leak_rows to authenticated;
grant select on public.analysis_leak_days to authenticated;
grant select on public.analysis_leak_day_hands to authenticated;

drop policy if exists analysis_leak_rows_owner_select on public.analysis_leak_rows;
create policy analysis_leak_rows_owner_select on public.analysis_leak_rows
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists analysis_leak_days_owner_select on public.analysis_leak_days;
create policy analysis_leak_days_owner_select on public.analysis_leak_days
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists analysis_leak_day_hands_owner_select on public.analysis_leak_day_hands;
create policy analysis_leak_day_hands_owner_select on public.analysis_leak_day_hands
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. One decision as a leak row
-- ---------------------------------------------------------------------------
--
-- The spot key and the set exactly as `analysis_graded_decisions` and
-- `analysis_leaks` compute them (the line: a chart grade's `facts.chart.line`
-- when it has the shape of one; the seat: `facts.position`, else the hand's;
-- the best action: the highest-EV option; the set: a chart grade's
-- `facts.chart.set` when it has the shape of one).

create or replace function public.analysis_leak_spot_key(
  p_street text, p_scenario text, p_source text, p_facts jsonb, p_hero_position text, p_action text, p_options jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select public.analysis_spot_key(
    p_street,
    p_scenario,
    case when p_source = 'chart' and coalesce(p_facts -> 'chart' ->> 'line', '') ~ '^[fkcra]{0,24}$'
         then coalesce(p_facts -> 'chart' ->> 'line', '') else '' end,
    case when coalesce(p_facts ->> 'position', p_hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
         then coalesce(p_facts ->> 'position', p_hero_position, '') else '' end,
    p_action,
    coalesce(public.analysis_best_action(p_options), ''));
$$;

create or replace function public.analysis_leak_chart_set(p_source text, p_facts jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_source = 'chart' and coalesce(p_facts -> 'chart' ->> 'set', '') ~ '^[a-z0-9-]{1,40}$'
              then p_facts -> 'chart' ->> 'set' else '' end;
$$;

comment on function public.analysis_leak_spot_key(text, text, text, jsonb, text, text, jsonb) is
  'A graded decision''s finest leak spot, as analysis_graded_decisions computes it (R5.2).';
comment on function public.analysis_leak_chart_set(text, jsonb) is
  'A graded decision''s chart set, as analysis_leaks reads it; '''' off the charts (R5.2).';

revoke all on function public.analysis_leak_spot_key(text, text, text, jsonb, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.analysis_leak_chart_set(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The triggers
-- ---------------------------------------------------------------------------

-- Each trigger is one statement: its parts read the same snapshot, so "a hand
-- with no leak row before" and "a hand whose every leak row goes" are read
-- from the table as it was, and the sums that rise and the sums that reach
-- zero are disjoint rows.

create or replace function public.analysis_leak_rows_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  for v_owner in select distinct owner_id from inserted where grade is not null order by owner_id loop
    perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || v_owner::text, 0));
  end loop;

  with ins as (
    insert into public.analysis_leak_rows (
      hand_id, analysis_version, ord, owner_id, action_index, played_at, day, game_format, hero_position,
      pot_type, spot_key, chart_set, grade, score, ev_loss_bb, ev_loss_pot)
    select d.hand_id, d.analysis_version, d.ord, d.owner_id, d.action_index, h.played_at,
           coalesce((h.played_at at time zone 'UTC')::date, '-infinity'::date),
           coalesce(h.game_format::text, ''), coalesce(h.hero_position, ''), coalesce(a.pot_type, ''),
           public.analysis_leak_spot_key(d.street, d.scenario, d.source, d.facts, h.hero_position, d.action, d.options),
           public.analysis_leak_chart_set(d.source, d.facts),
           d.grade, d.score, coalesce(d.ev_loss_bb, 0), coalesce(d.ev_loss_pot, 0)
    from inserted d
    join public.hands h on h.id = d.hand_id and h.owner_id = d.owner_id
    join public.hand_analysis a on a.hand_id = d.hand_id and a.analysis_version = d.analysis_version
    where d.grade is not null
    on conflict (hand_id, analysis_version, ord) do nothing
    returning *
  ),
  sums as (
    insert into public.analysis_leak_days as t (
      owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set,
      decisions, non_perfect, mistakes, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set,
           count(*), count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from ins
    group by 1, 2, 3, 4, 5, 6, 7, 8
    order by 1, 2, 3, 4, 5, 6, 7, 8
    on conflict (owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set)
    do update set decisions   = t.decisions + excluded.decisions,
                  non_perfect = t.non_perfect + excluded.non_perfect,
                  mistakes    = t.mistakes + excluded.mistakes,
                  ev_loss_bb  = t.ev_loss_bb + excluded.ev_loss_bb,
                  ev_loss_pot = t.ev_loss_pot + excluded.ev_loss_pot,
                  score_sum   = t.score_sum + excluded.score_sum,
                  score_sq    = t.score_sq + excluded.score_sq
  )
  -- A hand is counted once, by the statement that gives it its first leak row
  -- (the table read here is the one before this statement).
  insert into public.analysis_leak_day_hands as t (
    owner_id, analysis_version, day, game_format, hero_position, pot_type, hands)
  select owner_id, analysis_version, day, game_format, hero_position, pot_type, count(*)
  from (
    select distinct i.owner_id, i.analysis_version, i.hand_id, i.day, i.game_format, i.hero_position, i.pot_type
    from ins i
    where not exists (select 1 from public.analysis_leak_rows x
                      where x.hand_id = i.hand_id and x.analysis_version = i.analysis_version)
  ) z
  group by 1, 2, 3, 4, 5, 6
  order by 1, 2, 3, 4, 5, 6
  on conflict (owner_id, analysis_version, day, game_format, hero_position, pot_type)
  do update set hands = t.hands + excluded.hands;

  return null;
end;
$$;

create or replace function public.analysis_leak_rows_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  for v_owner in select distinct owner_id from deleted where grade is not null order by owner_id loop
    perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || v_owner::text, 0));
  end loop;

  -- The leak rows carry their own day and filters: the hand may be gone already.
  with gone as (
    delete from public.analysis_leak_rows x
    using deleted d
    where x.hand_id = d.hand_id and x.analysis_version = d.analysis_version and x.ord = d.ord
    returning x.*
  ),
  s as (
    select owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set,
           count(*) as decisions, count(*) filter (where grade <> 'perfect') as non_perfect,
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
           sum(ev_loss_bb) as ev_loss_bb, sum(ev_loss_pot) as ev_loss_pot,
           coalesce(sum(score), 0) as score_sum, coalesce(sum(score * score), 0) as score_sq
    from gone
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  sums_less as (
    update public.analysis_leak_days t
       set decisions   = t.decisions - s.decisions,
           non_perfect = t.non_perfect - s.non_perfect,
           mistakes    = t.mistakes - s.mistakes,
           ev_loss_bb  = t.ev_loss_bb - s.ev_loss_bb,
           ev_loss_pot = t.ev_loss_pot - s.ev_loss_pot,
           score_sum   = t.score_sum - s.score_sum,
           score_sq    = t.score_sq - s.score_sq
      from s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.day = s.day
       and t.game_format = s.game_format and t.hero_position = s.hero_position and t.pot_type = s.pot_type
       and t.spot_key = s.spot_key and t.chart_set = s.chart_set
       and t.decisions > s.decisions
  ),
  sums_gone as (
    delete from public.analysis_leak_days t
     using s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.day = s.day
       and t.game_format = s.game_format and t.hero_position = s.hero_position and t.pot_type = s.pot_type
       and t.spot_key = s.spot_key and t.chart_set = s.chart_set
       and t.decisions <= s.decisions
  ),
  -- A hand is uncounted when every leak row it had (the table before this
  -- statement) goes in this statement.
  lost as (
    select owner_id, analysis_version, day, game_format, hero_position, pot_type, count(*) as hands
    from (
      select g.owner_id, g.analysis_version, g.hand_id, g.day, g.game_format, g.hero_position, g.pot_type
      from gone g
      group by 1, 2, 3, 4, 5, 6, 7
      having count(*) = (select count(*) from public.analysis_leak_rows x
                         where x.hand_id = g.hand_id and x.analysis_version = g.analysis_version)
    ) z
    group by 1, 2, 3, 4, 5, 6
  ),
  hands_less as (
    update public.analysis_leak_day_hands t
       set hands = t.hands - l.hands
      from lost l
     where t.owner_id = l.owner_id and t.analysis_version = l.analysis_version and t.day = l.day
       and t.game_format = l.game_format and t.hero_position = l.hero_position and t.pot_type = l.pot_type
       and t.hands > l.hands
  )
  -- (Every part of a WITH runs to completion whether or not it is read.)
  delete from public.analysis_leak_day_hands t
   using lost l
   where t.owner_id = l.owner_id and t.analysis_version = l.analysis_version and t.day = l.day
     and t.game_format = l.game_format and t.hero_position = l.hero_position and t.pot_type = l.pot_type
     and t.hands <= l.hands;

  return null;
end;
$$;

revoke all on function public.analysis_leak_rows_on_insert() from public, anon, authenticated;
revoke all on function public.analysis_leak_rows_on_delete() from public, anon, authenticated;

drop trigger if exists decision_analysis_leak_rows_insert on public.decision_analysis;
create trigger decision_analysis_leak_rows_insert
  after insert on public.decision_analysis
  referencing new table as inserted
  for each statement execute function public.analysis_leak_rows_on_insert();

drop trigger if exists decision_analysis_leak_rows_delete on public.decision_analysis;
create trigger decision_analysis_leak_rows_delete
  after delete on public.decision_analysis
  referencing old table as deleted
  for each statement execute function public.analysis_leak_rows_on_delete();

-- ---------------------------------------------------------------------------
-- 4. Rebuild (the repair, and the backfill below)
-- ---------------------------------------------------------------------------

create or replace function public.analysis_leak_summaries_rebuild(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_owner is null then
    raise exception 'analysis_leak_summaries_rebuild needs an owner.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || p_owner::text, 0));

  delete from public.analysis_leak_rows where owner_id = p_owner;
  delete from public.analysis_leak_days where owner_id = p_owner;
  delete from public.analysis_leak_day_hands where owner_id = p_owner;

  insert into public.analysis_leak_rows (
    hand_id, analysis_version, ord, owner_id, action_index, played_at, day, game_format, hero_position,
    pot_type, spot_key, chart_set, grade, score, ev_loss_bb, ev_loss_pot)
  select d.hand_id, d.analysis_version, d.ord, d.owner_id, d.action_index, h.played_at,
         coalesce((h.played_at at time zone 'UTC')::date, '-infinity'::date),
         coalesce(h.game_format::text, ''), coalesce(h.hero_position, ''), coalesce(a.pot_type, ''),
         public.analysis_leak_spot_key(d.street, d.scenario, d.source, d.facts, h.hero_position, d.action, d.options),
         public.analysis_leak_chart_set(d.source, d.facts),
         d.grade, d.score, coalesce(d.ev_loss_bb, 0), coalesce(d.ev_loss_pot, 0)
  from public.decision_analysis d
  join public.hand_analysis a on a.hand_id = d.hand_id and a.analysis_version = d.analysis_version
  join public.hands h on h.id = d.hand_id and h.owner_id = d.owner_id
  where d.owner_id = p_owner and a.owner_id = p_owner and d.grade is not null;
  get diagnostics v_rows = row_count;

  insert into public.analysis_leak_days (
    owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set,
    decisions, non_perfect, mistakes, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
  select owner_id, analysis_version, day, game_format, hero_position, pot_type, spot_key, chart_set,
         count(*), count(*) filter (where grade <> 'perfect'),
         count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
         sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
  from public.analysis_leak_rows
  where owner_id = p_owner
  group by 1, 2, 3, 4, 5, 6, 7, 8;

  insert into public.analysis_leak_day_hands (
    owner_id, analysis_version, day, game_format, hero_position, pot_type, hands)
  select owner_id, analysis_version, day, game_format, hero_position, pot_type, count(distinct hand_id)
  from public.analysis_leak_rows
  where owner_id = p_owner
  group by 1, 2, 3, 4, 5, 6;

  return jsonb_build_object('rows', v_rows);
end;
$$;

comment on function public.analysis_leak_summaries_rebuild(uuid) is
  'Recounts one account''s leak rows and sums from decision_analysis (R5.2): the repair after a write '
  'that bypassed the triggers, and the backfill. Definer; granted to nobody.';

revoke all on function public.analysis_leak_summaries_rebuild(uuid) from public, anon, authenticated;

-- The backfill: every account with an analysis.
do $$
declare
  v_owner uuid;
begin
  for v_owner in select distinct owner_id from public.hand_analysis order by owner_id loop
    perform public.analysis_leak_summaries_rebuild(v_owner);
  end loop;
end;
$$;

analyze public.analysis_leak_rows;
analyze public.analysis_leak_days;
analyze public.analysis_leak_day_hands;

-- ---------------------------------------------------------------------------
-- 5. analysis_top_leaks
-- ---------------------------------------------------------------------------

-- One sample's rows, as `analysis_leaks` returns them: days `p_from`..`p_to`
-- (inclusive; null: open). Invoker, owner-first.
create or replace function public.analysis_leak_sample(
  p_owner uuid, p_version text, p_format text, p_position text, p_pot text, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'hands', coalesce((
      select sum(hands)::bigint from public.analysis_leak_day_hands
      where owner_id = p_owner and analysis_version = p_version
        and (p_from is null or day >= p_from) and (p_to is null or day <= p_to)
        and (p_format is null or game_format = p_format)
        and (p_position is null or hero_position = p_position)
        and (p_pot is null or pot_type = p_pot)), 0),
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
            order by x.spot_key, nullif(x.chart_set, '') nulls first), '[]'::jsonb))
  from (
    select spot_key, chart_set,
           sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
           sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum, sum(score_sq) as score_sq
    from public.analysis_leak_days
    where owner_id = p_owner and analysis_version = p_version
      and (p_from is null or day >= p_from) and (p_to is null or day <= p_to)
      and (p_format is null or game_format = p_format)
      and (p_position is null or hero_position = p_position)
      and (p_pot is null or pot_type = p_pot)
    group by spot_key, chart_set
  ) x;
$$;

comment on function public.analysis_leak_sample(uuid, text, text, text, text, date, date) is
  'One sample of the leak sums, as analysis_leaks returns its rows (R5.2). Invoker: RLS scopes it to '
  'the caller whatever owner is passed.';

revoke all on function public.analysis_leak_sample(uuid, text, text, text, text, date, date) from public, anon;
grant execute on function public.analysis_leak_sample(uuid, text, text, text, text, date, date) to authenticated;

create or replace function public.analysis_top_leaks(p_filters jsonb default '{}'::jsonb, p_period text default '30d')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := public.analysis_version_of(p_filters);
  v_format   text := nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '');
  v_position text := nullif(upper(btrim(coalesce(p_filters ->> 'position', ''))), '');
  v_pot      text := nullif(btrim(coalesce(p_filters ->> 'potType', '')), '');
  v_period   text := coalesce(p_period, '30d');
  v_last     date;
  v_now      jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_period not in ('30d', 'all') then
    raise exception 'Unknown period: %', v_period using errcode = '22023';
  end if;

  select max(day) into v_last
  from public.analysis_leak_day_hands
  where owner_id = v_owner and analysis_version = v_version and day > '-infinity'::date
    and (v_format is null or game_format = v_format)
    and (v_position is null or hero_position = v_position)
    and (v_pot is null or pot_type = v_pot);

  v_now := case when v_last is null then null
                else public.analysis_leak_sample(v_owner, v_version, v_format, v_position, v_pot, v_last - 29, v_last) end;

  return jsonb_build_object(
    'analysisVersion', v_version,
    'period',  v_period,
    'last',    v_last,
    'current', case when v_last is null then null
                    else jsonb_build_object('from', v_last - 29, 'to', v_last) end,
    'prior',   case when v_last is null then null
                    else jsonb_build_object('from', v_last - 59, 'to', v_last - 30) end,
    'sample',  case when v_period = 'all'
                    then public.analysis_leak_sample(v_owner, v_version, v_format, v_position, v_pot, null, null)
                    else coalesce(v_now, jsonb_build_object('hands', 0, 'graded', 0, 'rows', '[]'::jsonb)) end,
    'now',     coalesce(v_now, jsonb_build_object('hands', 0, 'graded', 0, 'rows', '[]'::jsonb)),
    'was',     case when v_last is null then jsonb_build_object('hands', 0, 'graded', 0, 'rows', '[]'::jsonb)
                    else public.analysis_leak_sample(v_owner, v_version, v_format, v_position, v_pot,
                                                     v_last - 59, v_last - 30) end);
end;
$$;

comment on function public.analysis_top_leaks(jsonb, text) is
  'The leak finder''s rows for the top three (R5.2): the period (all time or the last 30 days of play), '
  'the last 30 days of play and the 30 before, from the leak sums. Filters: analysisVersion, gameFormat, '
  'position, potType. Invoker, owner-first.';

revoke all on function public.analysis_top_leaks(jsonb, text) from public, anon;
grant execute on function public.analysis_top_leaks(jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. analysis_leak_examples
-- ---------------------------------------------------------------------------

create or replace function public.analysis_leak_examples(
  p_filters jsonb   default '{}'::jsonb,
  p_from    date    default null,
  p_to      date    default null,
  p_leaks   jsonb   default '[]'::jsonb,
  p_limit   integer default 15
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := public.analysis_version_of(p_filters);
  v_format   text := nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '');
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

  with leaks as (
    select l.ordinality as n, l.value ->> 'id' as id,
           array(select jsonb_array_elements_text(l.value -> 'keys')) as keys
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
          and (v_format is null or z.game_format = v_format)
          and (v_position is null or z.hero_position = v_position)
          and (v_pot is null or z.pot_type = v_pot)
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
        on dd.hand_id = p.hand_id and dd.analysis_version = v_version and dd.ord = p.ord
      where p.n = lk.n and p.rn <= v_limit), '[]'::jsonb)) order by lk.n), '[]'::jsonb))
    into v_out
  from leaks lk;

  return v_out;
end;
$$;

comment on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) is
  'Example hands for up to 10 leaks (R5.2): each leak''s decisions worse than Perfect at its spot keys, '
  'costliest first, inside the days and filters given. Invoker, owner-first.';

revoke all on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) from public, anon;
grant execute on function public.analysis_leak_examples(jsonb, date, date, jsonb, integer) to authenticated;
