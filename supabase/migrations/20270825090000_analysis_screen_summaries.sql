-- ============================================================================
-- The analysis screens under a second at a million hands.
-- ============================================================================
--
-- Follow-up to `20270818090000_big_account_readers.sql` (docs/RAIL-PLAN.md
-- §15, docs/DATABASE.md "Owner first", rule 7). That migration made every
-- analysis reader read the caller's own rows only; what it left slow is an
-- account's *own* million hands: the Analysis screens' readers computed over
-- every graded decision of the account on each call - joined to `hands`,
-- unpacking each decision's options and facts. Measured for this migration on
-- a GENERATED account of 1 000 000 hands (2.15M decisions, 1.98M graded; see
-- the plan's §15 row): `analysis_overview` 58 s, the others 6 s to over
-- two minutes.
--
-- No grading semantics change: no constant, chart, grade or `analysis/N` is
-- touched. The stored grades are summed, R4.5c-1's and R5.2's way - narrow
-- rows and sums kept by statement triggers in the writer's transaction - and
-- each reader answers from them exactly what its previous body answered
-- (pgTAP `analysis_screen_summaries` holds every one to a copy of its
-- previous body on random data, under every filter, after inserts, a prune,
-- a hand deleted, a re-analysis at a new version and a rebuild).
--
-- ## What is kept
--
--   * `analysis_hand_rows` - one narrow row per `hand_analysis` row: the
--     hand's groups (time, room, format, stake, seat - copied from `hands`),
--     the analysis' own columns, and what its decisions add up to (streets
--     present, flag codes, graded / chart / node decision counts, the graded
--     decisions' grade counts and sums). The hand list pages and counts it;
--     the session trend walks it.
--   * `analysis_month_hands` - analysed hands per (owner, version, UTC month);
--     version '' counts hands analysed at any version. Coverage and "analyse
--     my newest hands" read it.
--   * `analysis_leak_rows` (R5.2's, now every decision, graded or not, with
--     its hand's room and stake, street, status, source and - for a graded
--     preflop chart decision - its chart node and chosen action): the rows a
--     reader with a date range, a room or a stake aggregates, and every page
--     of example hands.
--   * `analysis_leak_totals` - graded decisions per (owner, version, format,
--     seat, pot type, spot key, chart set), all time. Replaces R5.2's
--     `analysis_leak_days`: per day it held about one row per decision once
--     spot keys are as varied as play (1.94M rows for 1.98M decisions here),
--     so its sums were no cheaper than the decisions.
--     `analysis_leak_stake_totals`: the same per (room, currency, big
--     blind), for the leak report under a room or stake chip.
--   * `analysis_trend_days` - graded decisions per (owner, version, UTC day,
--     group, key) for the trend's week and month buckets (group: all, street,
--     position, pot type). Replaces R5.2's `analysis_leak_day_hands`.
--   * `analysis_overview_hands`, `analysis_overview_decisions`,
--     `analysis_overview_flags`, `analysis_overview_keys` - the overview's
--     and the breakdown's counts per (owner, version, format, seat, pot type):
--     hands by status, reason, grade, flagged, approximations; decisions by
--     street, scenario, status, reason, grade, worst flag; flags by street,
--     code, severity; and the hands that have a decision (a graded one) on a
--     street, in a scenario, in a preflop scenario.
--   * `analysis_node_totals` - the preflop chart decisions per (set, line,
--     scenario, hand class, chosen action) and the analysed postflop ones per
--     (street, scenario, action), all time: `analysis_node_actions`.
--   * `analysis_graded_sites` - hands with a graded decision, a graded preflop
--     chart decision, a node decision, per (owner, version, room, stake): the
--     reports' room and stake chips.
--
-- ## How they stay right
--
-- Statement triggers: on `hand_analysis` (insert: a hand row, its counts;
-- delete: subtracted) and on `decision_analysis` (insert: leak rows and every
-- sum; delete - a prune, a hand or an account deleted - subtracted, using the
-- leak rows' own groups since the hand may be gone). "A hand counted once"
-- is decided against the leak rows as they were before the statement (one
-- statement per trigger, R5.2's rule). Every trigger takes R5.2's per-account
-- advisory lock. Nothing updates either table (no grant, no function); a fix
-- by hand as `postgres` needs `analysis_leak_summaries_rebuild(owner)`, which
-- now recounts all of these (also this migration's backfill).
--
-- Two invariants of the only writer (`save_hand_analysis`) are relied on, as
-- R5.2 relied on them: an analysis row's owner is its hand's owner, and a
-- hand's time, room, stake and seat do not change after it is stored.
--
-- ## The readers
--
-- Signatures, grants and answers unchanged; every reader stays invoker,
-- owner-first and planned per call. Each answers from the sums when its
-- filters are ones the sums hold, from the leak rows (or the hand rows) when
-- a date range or a room or stake narrows it, and otherwise - a filter the
-- web never sends to that reader (a grade, a status, a street or a flag on a
-- report) - from its previous body, kept as `<reader>_scan`.
--
--   analysis_overview, analysis_breakdown  - format, seat, pot type: sums
--   analysis_hands                         - every filter: hand rows
--   analysis_coverage                      - month counts (+ library_count)
--   hands_needing_analysis_recent          - month counts skip the months
--                                            with nothing missing
--   analysis_leaks, analysis_top_leaks,    - all time: totals; a range or a
--   analysis_leak_sample                     room / stake: leak rows
--   analysis_leak_hands, analysis_node_hands - leak rows, per key
--   analysis_trend                         - week / month: day sums (leak
--                                            rows when filtered); session:
--                                            hand rows
--   analysis_node_actions                  - all time: node totals; filtered:
--                                            leak rows
--   drill_due_by_spot, analysis_graded_facets - totals, sites
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. The filters every report takes, read once
-- ---------------------------------------------------------------------------
--
-- `analysis_scope`'s reading of each key, as values: `nullif(..., '')` for
-- absent, the same trims and case, the same casts (which raise as before),
-- and the grade checks first.

create type public.analysis_filter as (
  version    text,
  from_at    timestamptz,
  to_at      timestamptz,
  site       text,
  format     text,
  currency   text,
  big_blind  bigint,
  "position" text,
  pot_type   text,
  status     text,
  flagged    boolean,
  grade      text,
  min_grade  text,
  street     text,
  flag       text
);

create or replace function public.analysis_filter_of(p_filters jsonb)
returns public.analysis_filter
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.analysis_filter;
begin
  v.version := public.analysis_version_of(p_filters);
  v.grade := nullif(btrim(coalesce(p_filters ->> 'grade', '')), '');
  v.min_grade := nullif(btrim(coalesce(p_filters ->> 'minGrade', '')), '');
  if v.grade is not null and public.analysis_grade_rank(v.grade) is null then
    raise exception 'Unknown grade: %', v.grade using errcode = '22023';
  end if;
  if v.min_grade is not null and public.analysis_grade_rank(v.min_grade) is null then
    raise exception 'Unknown grade: %', v.min_grade using errcode = '22023';
  end if;
  v.from_at := (nullif(p_filters ->> 'from', ''))::timestamptz;
  v.to_at := (nullif(p_filters ->> 'to', ''))::timestamptz;
  v.site := lower(btrim(nullif(p_filters ->> 'site', '')));
  v.format := nullif(p_filters ->> 'gameFormat', '');
  v.currency := upper(btrim(nullif(p_filters ->> 'currency', '')));
  v.big_blind := (nullif(p_filters ->> 'bigBlind', ''))::bigint;
  v."position" := upper(btrim(nullif(p_filters ->> 'position', '')));
  v.pot_type := nullif(p_filters ->> 'potType', '');
  v.status := nullif(p_filters ->> 'status', '');
  v.flagged := coalesce((nullif(p_filters ->> 'flagged', ''))::boolean, false);
  v.street := nullif(p_filters ->> 'street', '');
  v.flag := nullif(p_filters ->> 'flag', '');
  return v;
end;
$$;

comment on function public.analysis_filter_of(jsonb) is
  'The report filters as analysis_scope reads them (absent, trims, case, casts, grade checks), once.';

revoke all on function public.analysis_filter_of(jsonb) from public, anon;
grant execute on function public.analysis_filter_of(jsonb) to authenticated;

-- A graded preflop chart decision's node, as analysis_node_actions and
-- analysis_node_hands read it: null unless preflop, chart, graded, chosen and
-- on a chart line.
create or replace function public.analysis_is_node(
  p_street text, p_source text, p_grade text, p_chosen smallint, p_facts jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_street = 'preflop' and p_source = 'chart' and p_grade is not null and p_chosen is not null
     and p_facts -> 'chart' ->> 'line' is not null;
$$;

revoke all on function public.analysis_is_node(text, text, text, smallint, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- R5.2's daily sums go (see the header); their rows are derived, so the new
-- tables are filled by the backfill below.
drop table if exists public.analysis_leak_day_hands;
drop table if exists public.analysis_leak_days;
drop table if exists public.analysis_leak_rows;

create table public.analysis_hand_rows (
  hand_id              uuid        not null,
  analysis_version     text        not null,
  owner_id             uuid        not null references auth.users (id) on delete cascade,
  -- The hand's (copied when the analysis row is stored).
  played_at            timestamptz,
  site                 text        not null,
  game_format          text        not null,
  currency             text        not null,
  currency_minor_units smallint    not null,
  small_blind          bigint,
  big_blind            bigint,
  hero_position        text,
  hero_profit          bigint,
  -- The analysis row's.
  pot_type             text,
  status               text        not null,
  reason               text,
  grade                text,
  score                numeric(6, 2),
  ev_loss_bb           numeric(12, 3),
  ev_loss_pot          numeric(10, 4),
  flag_count           smallint    not null,
  worst_flag           text,
  approximations       text[]      not null,
  -- Its decisions': a bit per street with one (1 preflop, 2 flop, 4 turn,
  -- 8 river), the flag codes they carry, how many are graded, graded preflop
  -- chart decisions, node decisions with a chosen action, and the graded
  -- decisions' counts and sums (`analysis_trend`'s measures).
  streets              smallint    not null default 0,
  flag_codes           text[]      not null default '{}',
  graded               integer     not null default 0,
  chart_graded         integer     not null default 0,
  node_decisions       integer     not null default 0,
  g_non_perfect        integer     not null default 0,
  g_mistakes           integer     not null default 0,
  g_mistake            integer     not null default 0,
  g_blunder            integer     not null default 0,
  g_ev_bb              numeric     not null default 0,
  g_ev_pot             numeric     not null default 0,
  g_score_sum          numeric     not null default 0,
  g_score_sq           numeric     not null default 0,
  primary key (hand_id, analysis_version)
);

comment on table public.analysis_hand_rows is
  'One narrow row per hand_analysis row: the hand''s groups, the analysis columns and what its decisions '
  'add up to. Kept by triggers on hand_analysis and decision_analysis; read by analysis_hands, the '
  'session trend and the graded facets.';

-- The hand list's default order ("recent") and the trend's sessions.
create index analysis_hand_rows_recent_idx
  on public.analysis_hand_rows (owner_id, analysis_version, played_at desc nulls last, hand_id);
-- "Costliest first" (the list's bad hands, Learn's examples).
create index analysis_hand_rows_ev_idx
  on public.analysis_hand_rows (owner_id, analysis_version, ev_loss_bb desc nulls last, played_at desc nulls last, hand_id);

create table public.analysis_month_hands (
  owner_id         uuid   not null references auth.users (id) on delete cascade,
  -- '': hands analysed at any version (each counted once).
  analysis_version text   not null,
  -- The UTC month of the hand's time (its first day); '-infinity' without one.
  month            date   not null,
  hands            bigint not null,
  primary key (owner_id, analysis_version, month)
);

comment on table public.analysis_month_hands is
  'Analysed hands per (owner, version, UTC month); version '''' counts hands analysed at any version. '
  'Kept by triggers on hand_analysis; read by analysis_coverage and hands_needing_analysis_recent.';

create table public.analysis_leak_rows (
  hand_id          uuid           not null,
  analysis_version text           not null,
  ord              smallint       not null,
  owner_id         uuid           not null references auth.users (id) on delete cascade,
  action_index     integer        not null,
  played_at        timestamptz,
  day              date           not null,
  site             text           not null,
  game_format      text           not null,
  currency         text           not null,
  currency_minor_units smallint   not null,
  small_blind      bigint,
  big_blind        bigint,
  -- '' where the hand has none.
  hero_position    text           not null,
  pot_type         text           not null,
  street           text           not null,
  status           text           not null,
  source           text           not null,
  spot_key         text           not null,
  chart_set        text           not null,
  -- Null: not graded.
  grade            text           check (grade in ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  score            numeric(6, 2),
  -- 0 where the decision has none (the leak finder's reading); the flags say
  -- which were none (the chart reports read them raw).
  ev_loss_bb       numeric(12, 3) not null,
  ev_loss_pot      numeric(10, 4) not null,
  ev_bb_null       boolean        not null,
  ev_pot_null      boolean        not null,
  -- A graded preflop chart decision with a choice on a chart line: its node
  -- (`facts.chart.set`, `.line`, `.scenario`, `facts.handClass`, as stored)
  -- and the action it chose; null otherwise.
  node_set         text,
  node_line        text,
  node_scenario    text,
  hand_class       text,
  chosen_action    text,
  primary key (hand_id, analysis_version, ord)
);

comment on table public.analysis_leak_rows is
  'One row per decision (graded or not) as the leak finder and the chart reports group it, with its '
  'hand''s day, room, stake, format, seat and pot type. Kept by triggers on decision_analysis (R5.2; '
  'every decision since 20270825090000).';

-- Example hands, costliest first (R5.2).
create index analysis_leak_rows_examples_idx
  on public.analysis_leak_rows (owner_id, analysis_version, spot_key, ev_loss_bb desc, played_at desc)
  where grade <> 'perfect';
-- A spot's rows by day (R5.2): example windows, the leak list's hands.
create index analysis_leak_rows_days_idx
  on public.analysis_leak_rows (owner_id, analysis_version, spot_key, day);
-- A date range's rows; the first and last of a scope.
create index analysis_leak_rows_time_idx
  on public.analysis_leak_rows (owner_id, analysis_version, played_at);
-- A chart node's decisions.
create index analysis_leak_rows_node_idx
  on public.analysis_leak_rows (owner_id, analysis_version, node_set, node_line)
  where node_line is not null;

create table public.analysis_leak_totals (
  owner_id         uuid    not null references auth.users (id) on delete cascade,
  analysis_version text    not null,
  game_format      text    not null,
  hero_position    text    not null,
  pot_type         text    not null,
  spot_key         text    not null,
  chart_set        text    not null,
  decisions        bigint  not null,
  -- Hands with a decision here (a hand is in one format, seat and pot type).
  hands            bigint  not null,
  non_perfect      bigint  not null,
  mistakes         bigint  not null,
  g_mistake        bigint  not null,
  g_blunder        bigint  not null,
  ev_loss_bb       numeric not null,
  ev_loss_pot      numeric not null,
  score_sum        numeric not null,
  score_sq         numeric not null,
  primary key (owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set)
);

comment on table public.analysis_leak_totals is
  'Graded decisions per (owner, version, format, seat, pot type, spot key, chart set), all time: the leak '
  'finder''s sums (replaces R5.2''s analysis_leak_days). Kept by triggers on decision_analysis.';

-- The same per (room, stake) instead: the leak report under a room or a
-- stake chip (with format, seat, pot type or a range too: the rows).
create table public.analysis_leak_stake_totals (
  owner_id         uuid    not null references auth.users (id) on delete cascade,
  analysis_version text    not null,
  site             text    not null,
  currency         text    not null,
  big_blind        bigint,
  spot_key         text    not null,
  chart_set        text    not null,
  decisions        bigint  not null,
  hands            bigint  not null,
  non_perfect      bigint  not null,
  mistakes         bigint  not null,
  g_mistake        bigint  not null,
  g_blunder        bigint  not null,
  ev_loss_bb       numeric not null,
  ev_loss_pot      numeric not null,
  score_sum        numeric not null,
  score_sq         numeric not null,
  constraint analysis_leak_stake_totals_key unique nulls not distinct (
    owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set)
);

comment on table public.analysis_leak_stake_totals is
  'Graded decisions per (owner, version, room, currency, big blind, spot key, chart set), all time: the leak '
  'finder''s sums under a room or stake. Kept by triggers on decision_analysis.';

create table public.analysis_trend_days (
  owner_id         uuid        not null references auth.users (id) on delete cascade,
  analysis_version text        not null,
  day              date        not null,
  -- 'all' (key ''), 'street', 'position', 'pot_type' (key '' where none).
  grp              text        not null,
  key              text        not null,
  hands            bigint      not null,
  decisions        bigint      not null,
  non_perfect      bigint      not null,
  mistakes         bigint      not null,
  g_mistake        bigint      not null,
  g_blunder        bigint      not null,
  ev_loss_bb       numeric     not null,
  ev_loss_pot      numeric     not null,
  score_sum        numeric     not null,
  score_sq         numeric     not null,
  first_at         timestamptz not null,
  last_at          timestamptz not null,
  primary key (owner_id, analysis_version, grp, day, key)
);

comment on table public.analysis_trend_days is
  'Graded decisions of dated hands per (owner, version, UTC day, group, key): analysis_trend''s week and '
  'month buckets (replaces R5.2''s analysis_leak_day_hands). Kept by triggers on decision_analysis.';

create table public.analysis_overview_hands (
  owner_id         uuid    not null references auth.users (id) on delete cascade,
  analysis_version text    not null,
  game_format      text    not null,
  hero_position    text    not null,
  pot_type         text    not null,
  status           text    not null,
  reason           text    not null,
  grade            text    not null,
  flagged          boolean not null,
  approximations   text[]  not null,
  hands            bigint  not null,
  primary key (owner_id, analysis_version, game_format, hero_position, pot_type, status, reason, grade,
               flagged, approximations)
);

create table public.analysis_overview_decisions (
  owner_id         uuid    not null references auth.users (id) on delete cascade,
  analysis_version text    not null,
  game_format      text    not null,
  hero_position    text    not null,
  pot_type         text    not null,
  street           text    not null,
  scenario         text    not null,
  status           text    not null,
  reason           text    not null,
  grade            text    not null,
  worst_flag       text    not null,
  decisions        bigint  not null,
  -- Facing a bet; of those, called or raised; their MDF (sum, count).
  facing           bigint  not null,
  defended         bigint  not null,
  mdf_sum          numeric not null,
  mdf_n            bigint  not null,
  score_sum        numeric not null,
  score_n          bigint  not null,
  ev_bb_sum        numeric not null,
  ev_bb_n          bigint  not null,
  ev_pot_sum       numeric not null,
  ev_pot_n         bigint  not null,
  primary key (owner_id, analysis_version, game_format, hero_position, pot_type, street, scenario, status,
               reason, grade, worst_flag)
);

create table public.analysis_overview_flags (
  owner_id         uuid   not null references auth.users (id) on delete cascade,
  analysis_version text   not null,
  game_format      text   not null,
  hero_position    text   not null,
  pot_type         text   not null,
  street           text   not null,
  code             text   not null,
  severity         text   not null,
  flags            bigint not null,
  primary key (owner_id, analysis_version, game_format, hero_position, pot_type, street, code, severity)
);

create table public.analysis_overview_keys (
  owner_id         uuid   not null references auth.users (id) on delete cascade,
  analysis_version text   not null,
  game_format      text   not null,
  hero_position    text   not null,
  pot_type         text   not null,
  -- 'all' (key ''), 'street', 'scenario', 'preflop' (a preflop decision's scenario).
  kind             text   not null,
  key              text   not null,
  -- Hands with a decision here; with a graded one.
  hands            bigint not null,
  graded_hands     bigint not null,
  primary key (owner_id, analysis_version, game_format, hero_position, pot_type, kind, key)
);

comment on table public.analysis_overview_hands is
  'Analysed hands per (owner, version, format, seat, pot type, status, reason, grade, flagged, '
  'approximations): analysis_overview. Kept by triggers on hand_analysis.';
comment on table public.analysis_overview_decisions is
  'Decisions per (owner, version, format, seat, pot type, street, scenario, status, reason, grade, worst '
  'flag): analysis_overview and analysis_breakdown. Kept by triggers on decision_analysis.';
comment on table public.analysis_overview_flags is
  'Flags per (owner, version, format, seat, pot type, street, code, severity): analysis_overview. Kept by '
  'triggers on decision_analysis.';
comment on table public.analysis_overview_keys is
  'Hands with a decision (a graded one) per (owner, version, format, seat, pot type) and street, scenario '
  'or preflop scenario: analysis_breakdown. Kept by triggers on decision_analysis.';

create table public.analysis_node_totals (
  owner_id         uuid   not null references auth.users (id) on delete cascade,
  analysis_version text   not null,
  street           text   not null,
  -- Preflop: the node (as stored) and the chosen action. Postflop (analysed
  -- decisions): node_set null, line '', hand_class null, the decision's
  -- scenario and action.
  node_set         text,
  line             text   not null,
  scenario         text,
  hand_class       text,
  action           text   not null,
  decisions        bigint not null,
  deviations       bigint not null,
  ev_loss_bb       numeric not null,
  constraint analysis_node_totals_key unique nulls not distinct (
    owner_id, analysis_version, street, node_set, line, scenario, hand_class, action)
);

comment on table public.analysis_node_totals is
  'Node decisions with a chosen action per (owner, version, set, line, scenario, hand class, action) and '
  'analysed postflop decisions per (street, scenario, action), all time: analysis_node_actions. Kept by '
  'triggers on decision_analysis.';

create table public.analysis_graded_sites (
  owner_id             uuid     not null references auth.users (id) on delete cascade,
  analysis_version     text     not null,
  site                 text     not null,
  currency             text     not null,
  currency_minor_units smallint not null,
  small_blind          bigint,
  big_blind            bigint,
  -- Hands with a graded decision; a graded preflop chart one; a node one with a chosen action.
  graded_hands         bigint   not null,
  chart_hands          bigint   not null,
  node_hands           bigint   not null,
  constraint analysis_graded_sites_key unique nulls not distinct (
    owner_id, analysis_version, site, currency, currency_minor_units, small_blind, big_blind)
);

comment on table public.analysis_graded_sites is
  'Hands with a graded decision (a graded preflop chart one, a node one) per (owner, version, room, '
  'stake): the reports'' room and stake chips. Kept by triggers on decision_analysis.';

do $$
declare
  t text;
begin
  foreach t in array array['analysis_hand_rows', 'analysis_month_hands', 'analysis_leak_rows', 'analysis_leak_totals',
                           'analysis_leak_stake_totals', 'analysis_trend_days', 'analysis_overview_hands',
                           'analysis_overview_decisions',
                           'analysis_overview_flags', 'analysis_overview_keys', 'analysis_node_totals',
                           'analysis_graded_sites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))',
                   t || '_owner_select', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Hand rows: kept by hand_analysis' statements
-- ---------------------------------------------------------------------------

create or replace function public.analysis_month_of(p_at timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select coalesce(date_trunc('month', p_at at time zone 'UTC')::date, '-infinity'::date);
$$;

revoke all on function public.analysis_month_of(timestamptz) from public, anon;
grant execute on function public.analysis_month_of(timestamptz) to authenticated;

create or replace function public.analysis_hand_rows_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || o.owner_id::text, 0))
  from (select distinct owner_id from inserted order by 1) o;

  with ins as (
    insert into public.analysis_hand_rows (
      hand_id, analysis_version, owner_id, played_at, site, game_format, currency, currency_minor_units,
      small_blind, big_blind, hero_position, hero_profit, pot_type, status, reason, grade, score, ev_loss_bb,
      ev_loss_pot, flag_count, worst_flag, approximations)
    select a.hand_id, a.analysis_version, a.owner_id, h.played_at, h.site, h.game_format::text, h.currency,
           h.currency_minor_units, h.small_blind, h.big_blind, h.hero_position, h.hero_profit, a.pot_type,
           a.status, a.reason, a.grade, a.score, a.ev_loss_bb, a.ev_loss_pot, a.flag_count, a.worst_flag,
           a.approximations
    from inserted a
    join public.hands h on h.id = a.hand_id and h.owner_id = a.owner_id
    on conflict (hand_id, analysis_version) do nothing
    returning hand_id, analysis_version, owner_id, played_at, game_format, hero_position, pot_type, status,
              reason, grade, flag_count, approximations
  ),
  cube as (
    insert into public.analysis_overview_hands as t (
      owner_id, analysis_version, game_format, hero_position, pot_type, status, reason, grade, flagged,
      approximations, hands)
    select owner_id, analysis_version, game_format, coalesce(hero_position, ''), coalesce(pot_type, ''), status,
           coalesce(reason, ''), coalesce(grade, ''), flag_count > 0, approximations, count(*)
    from ins
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    on conflict (owner_id, analysis_version, game_format, hero_position, pot_type, status, reason, grade, flagged,
                 approximations)
    do update set hands = t.hands + excluded.hands
  )
  -- Per version; and '' once per hand that had no analysis row at any
  -- version before this statement (the table read here is the one before).
  insert into public.analysis_month_hands as t (owner_id, analysis_version, month, hands)
  select owner_id, v, month, count(*)
  from (
    select owner_id, analysis_version as v, public.analysis_month_of(played_at) as month from ins
    union all
    select owner_id, '', public.analysis_month_of(played_at)
    from (select distinct on (hand_id) hand_id, owner_id, played_at from ins order by hand_id) i
    where not exists (select 1 from public.analysis_hand_rows x where x.hand_id = i.hand_id)
  ) z
  group by 1, 2, 3
  order by 1, 2, 3
  on conflict (owner_id, analysis_version, month) do update set hands = t.hands + excluded.hands;

  return null;
end;
$$;

create or replace function public.analysis_hand_rows_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || o.owner_id::text, 0))
  from (select distinct owner_id from deleted order by 1) o;

  with gone as (
    delete from public.analysis_hand_rows x
    using deleted d
    where x.hand_id = d.hand_id and x.analysis_version = d.analysis_version
    returning x.hand_id, x.analysis_version, x.owner_id, x.played_at, x.game_format, x.hero_position, x.pot_type,
              x.status, x.reason, x.grade, x.flag_count, x.approximations
  ),
  c as (
    select owner_id, analysis_version, game_format, coalesce(hero_position, '') as hero_position,
           coalesce(pot_type, '') as pot_type, status, coalesce(reason, '') as reason, coalesce(grade, '') as grade,
           flag_count > 0 as flagged, approximations, count(*) as hands
    from gone
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  ),
  cube_less as (
    update public.analysis_overview_hands t set hands = t.hands - c.hands
    from c
    where t.owner_id = c.owner_id and t.analysis_version = c.analysis_version and t.game_format = c.game_format
      and t.hero_position = c.hero_position and t.pot_type = c.pot_type and t.status = c.status
      and t.reason = c.reason and t.grade = c.grade and t.flagged = c.flagged
      and t.approximations = c.approximations and t.hands > c.hands
  ),
  cube_gone as (
    delete from public.analysis_overview_hands t
    using c
    where t.owner_id = c.owner_id and t.analysis_version = c.analysis_version and t.game_format = c.game_format
      and t.hero_position = c.hero_position and t.pot_type = c.pot_type and t.status = c.status
      and t.reason = c.reason and t.grade = c.grade and t.flagged = c.flagged
      and t.approximations = c.approximations and t.hands <= c.hands
  ),
  -- '' loses a hand whose every analysis row goes in this statement.
  m as (
    select owner_id, v, month, count(*) as hands
    from (
      select owner_id, analysis_version as v, public.analysis_month_of(played_at) as month from gone
      union all
      select g.owner_id, '', public.analysis_month_of(min(g.played_at))
      from gone g
      group by g.owner_id, g.hand_id
      having count(*) = (select count(*) from public.analysis_hand_rows x where x.hand_id = g.hand_id)
    ) z
    group by 1, 2, 3
  ),
  months_less as (
    update public.analysis_month_hands t set hands = t.hands - m.hands
    from m
    where t.owner_id = m.owner_id and t.analysis_version = m.v and t.month = m.month and t.hands > m.hands
  )
  delete from public.analysis_month_hands t
  using m
  where t.owner_id = m.owner_id and t.analysis_version = m.v and t.month = m.month and t.hands <= m.hands;

  return null;
end;
$$;

revoke all on function public.analysis_hand_rows_on_insert() from public, anon, authenticated;
revoke all on function public.analysis_hand_rows_on_delete() from public, anon, authenticated;

create trigger hand_analysis_rows_insert
  after insert on public.hand_analysis
  referencing new table as inserted
  for each statement execute function public.analysis_hand_rows_on_insert();

create trigger hand_analysis_rows_delete
  after delete on public.hand_analysis
  referencing old table as deleted
  for each statement execute function public.analysis_hand_rows_on_delete();

-- ---------------------------------------------------------------------------
-- 3. Decisions: leak rows and every sum, kept by decision_analysis' statements
-- ---------------------------------------------------------------------------
--
-- One statement each (R5.2's rule): every part reads the tables as they were
-- before it, so "the hand's first decision in this group" is decided against
-- `prior` - the statement's hands' leak rows before it (almost always none) -
-- and the sums that rise and the sums that reach zero are disjoint rows. A
-- hand's groups come from its hand row (insert) or from the leak rows
-- themselves (delete: the hand may be gone).

create or replace function public.analysis_street_bit(p_street text)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select (case p_street when 'preflop' then 1 when 'flop' then 2 when 'turn' then 4 when 'river' then 8 else 0 end)::smallint;
$$;

-- Whether a leak row is in the breakdown's (kind, key): any decision ('all'),
-- a street, a scenario, a preflop decision's scenario.
create or replace function public.analysis_key_matches(p_kind text, p_key text, p_street text, p_spot_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_kind
           when 'all' then true
           when 'street' then p_street = p_key
           when 'scenario' then split_part(p_spot_key, '|', 2) = p_key
           else p_street = 'preflop' and split_part(p_spot_key, '|', 2) = p_key
         end;
$$;

revoke all on function public.analysis_street_bit(text) from public, anon;
grant execute on function public.analysis_street_bit(text) to authenticated;
revoke all on function public.analysis_key_matches(text, text, text, text) from public, anon, authenticated;

create or replace function public.analysis_leak_rows_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || o.owner_id::text, 0))
  from (select distinct owner_id from inserted order by 1) o;

  with ins as (
    insert into public.analysis_leak_rows (
      hand_id, analysis_version, ord, owner_id, action_index, played_at, day, site, game_format, currency, currency_minor_units, small_blind,
      big_blind, hero_position, pot_type, street, status, source, spot_key, chart_set, grade, score, ev_loss_bb,
      ev_loss_pot, ev_bb_null, ev_pot_null, node_set, node_line, node_scenario, hand_class, chosen_action)
    select d.hand_id, d.analysis_version, d.ord, d.owner_id, d.action_index, r.played_at,
           coalesce((r.played_at at time zone 'UTC')::date, '-infinity'::date),
           r.site, r.game_format, r.currency, r.currency_minor_units, r.small_blind, r.big_blind, coalesce(r.hero_position, ''), coalesce(r.pot_type, ''),
           d.street, d.status, d.source,
           public.analysis_leak_spot_key(d.street, d.scenario, d.source, d.facts, r.hero_position, d.action, d.options),
           public.analysis_leak_chart_set(d.source, d.facts),
           d.grade, d.score, coalesce(d.ev_loss_bb, 0), coalesce(d.ev_loss_pot, 0),
           d.ev_loss_bb is null, d.ev_loss_pot is null,
           case when n.is_node then d.facts -> 'chart' ->> 'set' end,
           case when n.is_node then d.facts -> 'chart' ->> 'line' end,
           case when n.is_node then d.facts -> 'chart' ->> 'scenario' end,
           case when n.is_node then d.facts ->> 'handClass' end,
           case when n.is_node then public.analysis_chosen_action(d.options, d.chosen) end
    from inserted d
    join public.analysis_hand_rows r on r.hand_id = d.hand_id and r.analysis_version = d.analysis_version
    cross join lateral (select public.analysis_is_node(d.street, d.source, d.grade, d.chosen, d.facts) as is_node) n
    on conflict (hand_id, analysis_version, ord) do nothing
    returning *
  ),
  prior as materialized (
    select x.hand_id, x.analysis_version, x.street, x.spot_key, x.chart_set, x.grade, x.source, x.node_line,
           x.chosen_action
    from public.analysis_leak_rows x
    where (x.hand_id, x.analysis_version) in (select distinct hand_id, analysis_version from inserted)
  ),
  -- Each new row with what the leak rows do not carry, and whether it is
  -- its hand's first in a group.
  f as (
    select i.*, d.scenario, d.reason, d.worst_flag, d.facing_bet, d.action, d.mdf, d.flags,
           i.grade is not null and not exists (
             select 1 from prior p where p.hand_id = i.hand_id and p.analysis_version = i.analysis_version
               and p.grade is not null) as first_graded,
           i.grade is not null and not exists (
             select 1 from prior p where p.hand_id = i.hand_id and p.analysis_version = i.analysis_version
               and p.grade is not null and p.street = i.street) as first_graded_street,
           i.grade is not null and not exists (
             select 1 from prior p where p.hand_id = i.hand_id and p.analysis_version = i.analysis_version
               and p.grade is not null and p.spot_key = i.spot_key and p.chart_set = i.chart_set) as first_in_spot,
           (i.street = 'preflop' and i.source = 'chart' and i.grade is not null) and not exists (
             select 1 from prior p where p.hand_id = i.hand_id and p.analysis_version = i.analysis_version
               and p.street = 'preflop' and p.source = 'chart' and p.grade is not null) as first_chart,
           (i.node_line is not null and i.chosen_action is not null) and not exists (
             select 1 from prior p where p.hand_id = i.hand_id and p.analysis_version = i.analysis_version
               and p.node_line is not null and p.chosen_action is not null) as first_node
    from ins i
    join inserted d on d.hand_id = i.hand_id and d.analysis_version = i.analysis_version and d.ord = i.ord
  ),
  totals as (
    insert into public.analysis_leak_totals as t (
      owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, decisions, hands,
      non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, count(*),
           count(distinct hand_id) filter (where first_in_spot),
           count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from f
    where grade is not null
    group by 1, 2, 3, 4, 5, 6, 7
    order by 1, 2, 3, 4, 5, 6, 7
    on conflict (owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set)
    do update set decisions   = t.decisions + excluded.decisions,
                  hands       = t.hands + excluded.hands,
                  non_perfect = t.non_perfect + excluded.non_perfect,
                  mistakes    = t.mistakes + excluded.mistakes,
                  g_mistake   = t.g_mistake + excluded.g_mistake,
                  g_blunder   = t.g_blunder + excluded.g_blunder,
                  ev_loss_bb  = t.ev_loss_bb + excluded.ev_loss_bb,
                  ev_loss_pot = t.ev_loss_pot + excluded.ev_loss_pot,
                  score_sum   = t.score_sum + excluded.score_sum,
                  score_sq    = t.score_sq + excluded.score_sq
  ),
  stake_totals as (
    insert into public.analysis_leak_stake_totals as t (
      owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, decisions, hands,
      non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
    select owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, count(*),
           count(distinct hand_id) filter (where first_in_spot),
           count(*) filter (where grade <> 'perfect'),
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
           sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
    from f
    where grade is not null
    group by 1, 2, 3, 4, 5, 6, 7
    order by 1, 2, 3, 4, 5, 6, 7
    on conflict on constraint analysis_leak_stake_totals_key
    do update set decisions   = t.decisions + excluded.decisions,
                  hands       = t.hands + excluded.hands,
                  non_perfect = t.non_perfect + excluded.non_perfect,
                  mistakes    = t.mistakes + excluded.mistakes,
                  g_mistake   = t.g_mistake + excluded.g_mistake,
                  g_blunder   = t.g_blunder + excluded.g_blunder,
                  ev_loss_bb  = t.ev_loss_bb + excluded.ev_loss_bb,
                  ev_loss_pot = t.ev_loss_pot + excluded.ev_loss_pot,
                  score_sum   = t.score_sum + excluded.score_sum,
                  score_sq    = t.score_sq + excluded.score_sq
  ),
  trend as (
    insert into public.analysis_trend_days as t (
      owner_id, analysis_version, day, grp, key, hands, decisions, non_perfect, mistakes, g_mistake, g_blunder,
      ev_loss_bb, ev_loss_pot, score_sum, score_sq, first_at, last_at)
    select f.owner_id, f.analysis_version, f.day, k.grp, k.key,
           count(distinct f.hand_id) filter (where k.first), count(*),
           count(*) filter (where f.grade <> 'perfect'),
           count(*) filter (where f.grade in ('inaccurate', 'mistake', 'blunder')),
           count(*) filter (where f.grade = 'mistake'), count(*) filter (where f.grade = 'blunder'),
           sum(f.ev_loss_bb), sum(f.ev_loss_pot), coalesce(sum(f.score), 0), coalesce(sum(f.score * f.score), 0),
           min(f.played_at), max(f.played_at)
    from f
    cross join lateral (values ('all', '', f.first_graded), ('street', f.street, f.first_graded_street),
                               ('position', f.hero_position, f.first_graded),
                               ('pot_type', f.pot_type, f.first_graded)) k(grp, key, first)
    where f.grade is not null and f.played_at is not null
    group by 1, 2, 3, 4, 5
    order by 1, 2, 3, 4, 5
    on conflict (owner_id, analysis_version, grp, day, key)
    do update set hands       = t.hands + excluded.hands,
                  decisions   = t.decisions + excluded.decisions,
                  non_perfect = t.non_perfect + excluded.non_perfect,
                  mistakes    = t.mistakes + excluded.mistakes,
                  g_mistake   = t.g_mistake + excluded.g_mistake,
                  g_blunder   = t.g_blunder + excluded.g_blunder,
                  ev_loss_bb  = t.ev_loss_bb + excluded.ev_loss_bb,
                  ev_loss_pot = t.ev_loss_pot + excluded.ev_loss_pot,
                  score_sum   = t.score_sum + excluded.score_sum,
                  score_sq    = t.score_sq + excluded.score_sq,
                  first_at    = least(t.first_at, excluded.first_at),
                  last_at     = greatest(t.last_at, excluded.last_at)
  ),
  decs as (
    insert into public.analysis_overview_decisions as t (
      owner_id, analysis_version, game_format, hero_position, pot_type, street, scenario, status, reason, grade,
      worst_flag, decisions, facing, defended, mdf_sum, mdf_n, score_sum, score_n, ev_bb_sum, ev_bb_n, ev_pot_sum,
      ev_pot_n)
    select owner_id, analysis_version, game_format, hero_position, pot_type, street, scenario, status,
           coalesce(reason, ''), coalesce(grade, ''), coalesce(worst_flag, ''), count(*),
           count(*) filter (where facing_bet), count(*) filter (where facing_bet and action in ('call', 'raise')),
           coalesce(sum(mdf) filter (where facing_bet), 0), count(mdf) filter (where facing_bet),
           coalesce(sum(score), 0), count(score),
           sum(ev_loss_bb), count(*) filter (where not ev_bb_null),
           sum(ev_loss_pot), count(*) filter (where not ev_pot_null)
    from f
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    on conflict (owner_id, analysis_version, game_format, hero_position, pot_type, street, scenario, status, reason,
                 grade, worst_flag)
    do update set decisions  = t.decisions + excluded.decisions,
                  facing     = t.facing + excluded.facing,
                  defended   = t.defended + excluded.defended,
                  mdf_sum    = t.mdf_sum + excluded.mdf_sum,
                  mdf_n      = t.mdf_n + excluded.mdf_n,
                  score_sum  = t.score_sum + excluded.score_sum,
                  score_n    = t.score_n + excluded.score_n,
                  ev_bb_sum  = t.ev_bb_sum + excluded.ev_bb_sum,
                  ev_bb_n    = t.ev_bb_n + excluded.ev_bb_n,
                  ev_pot_sum = t.ev_pot_sum + excluded.ev_pot_sum,
                  ev_pot_n   = t.ev_pot_n + excluded.ev_pot_n
  ),
  flags as (
    insert into public.analysis_overview_flags as t (
      owner_id, analysis_version, game_format, hero_position, pot_type, street, code, severity, flags)
    select f.owner_id, f.analysis_version, f.game_format, f.hero_position, f.pot_type, f.street,
           fl ->> 'code', fl ->> 'severity', count(*)
    from f, jsonb_array_elements(f.flags) fl
    group by 1, 2, 3, 4, 5, 6, 7, 8
    order by 1, 2, 3, 4, 5, 6, 7, 8
    on conflict (owner_id, analysis_version, game_format, hero_position, pot_type, street, code, severity)
    do update set flags = t.flags + excluded.flags
  ),
  -- The breakdown's distinct hands: per hand and key, whether the hand is new
  -- there (any decision; a graded one).
  hk as (
    select f.owner_id, f.analysis_version, f.hand_id, f.game_format, f.hero_position, f.pot_type, k.kind, k.key,
           bool_or(f.grade is not null) as graded
    from f
    cross join lateral (values ('all', ''), ('street', f.street), ('scenario', f.scenario),
                               ('preflop', case when f.street = 'preflop' then f.scenario end)) k(kind, key)
    where k.key is not null
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  hk_new as (
    select hk.*,
           not exists (select 1 from prior p where p.hand_id = hk.hand_id and p.analysis_version = hk.analysis_version
                         and public.analysis_key_matches(hk.kind, hk.key, p.street, p.spot_key)) as new_any,
           hk.graded and not exists (
             select 1 from prior p where p.hand_id = hk.hand_id and p.analysis_version = hk.analysis_version
               and p.grade is not null and public.analysis_key_matches(hk.kind, hk.key, p.street, p.spot_key)) as new_graded
    from hk
  ),
  keys as (
    insert into public.analysis_overview_keys as t (
      owner_id, analysis_version, game_format, hero_position, pot_type, kind, key, hands, graded_hands)
    select owner_id, analysis_version, game_format, hero_position, pot_type, kind, key,
           count(*) filter (where new_any), count(*) filter (where new_graded)
    from hk_new
    where new_any or new_graded
    group by 1, 2, 3, 4, 5, 6, 7
    order by 1, 2, 3, 4, 5, 6, 7
    on conflict (owner_id, analysis_version, game_format, hero_position, pot_type, kind, key)
    do update set hands = t.hands + excluded.hands, graded_hands = t.graded_hands + excluded.graded_hands
  ),
  nodes as (
    insert into public.analysis_node_totals as t (
      owner_id, analysis_version, street, node_set, line, scenario, hand_class, action, decisions, deviations,
      ev_loss_bb)
    select owner_id, analysis_version, street, node_set, node_line, node_scenario, hand_class, chosen_action,
           count(*), count(*) filter (where grade <> 'perfect'), sum(ev_loss_bb)
    from f
    where node_line is not null and chosen_action is not null
    group by 1, 2, 3, 4, 5, 6, 7, 8
    union all
    select owner_id, analysis_version, street, null, '', scenario, null, action, count(*), 0, 0
    from f
    where street <> 'preflop' and status = 'analysed'
    group by 1, 2, 3, 6, 8
    order by 1, 2, 3, 4, 5, 6, 7, 8
    on conflict on constraint analysis_node_totals_key
    do update set decisions  = t.decisions + excluded.decisions,
                  deviations = t.deviations + excluded.deviations,
                  ev_loss_bb = t.ev_loss_bb + excluded.ev_loss_bb
  ),
  codes as (
    select f.hand_id, f.analysis_version, array_agg(distinct fl ->> 'code') as codes
    from f, jsonb_array_elements(f.flags) fl
    group by 1, 2
  ),
  per_hand as (
    select f.owner_id, f.hand_id, f.analysis_version,
           bit_or(public.analysis_street_bit(f.street))::smallint as streets,
           count(*) filter (where f.grade is not null) as graded,
           count(*) filter (where f.street = 'preflop' and f.source = 'chart' and f.grade is not null) as chart_graded,
           count(*) filter (where f.node_line is not null and f.chosen_action is not null) as node_decisions,
           count(*) filter (where f.grade is not null and f.grade <> 'perfect') as g_non_perfect,
           count(*) filter (where f.grade in ('inaccurate', 'mistake', 'blunder')) as g_mistakes,
           count(*) filter (where f.grade = 'mistake') as g_mistake,
           count(*) filter (where f.grade = 'blunder') as g_blunder,
           coalesce(sum(f.ev_loss_bb) filter (where f.grade is not null), 0) as g_ev_bb,
           coalesce(sum(f.ev_loss_pot) filter (where f.grade is not null), 0) as g_ev_pot,
           coalesce(sum(f.score) filter (where f.grade is not null), 0) as g_score_sum,
           coalesce(sum(f.score * f.score) filter (where f.grade is not null), 0) as g_score_sq,
           bool_or(f.first_graded) as first_graded, bool_or(f.first_chart) as first_chart,
           bool_or(f.first_node) as first_node
    from f
    group by f.owner_id, f.hand_id, f.analysis_version
  ),
  hand_rows as (
    update public.analysis_hand_rows t
       set streets        = t.streets | h.streets,
           flag_codes     = case when c.codes is null then t.flag_codes
                                 else array(select distinct x from unnest(t.flag_codes || c.codes) x order by x) end,
           graded         = t.graded + h.graded,
           chart_graded   = t.chart_graded + h.chart_graded,
           node_decisions = t.node_decisions + h.node_decisions,
           g_non_perfect  = t.g_non_perfect + h.g_non_perfect,
           g_mistakes     = t.g_mistakes + h.g_mistakes,
           g_mistake      = t.g_mistake + h.g_mistake,
           g_blunder      = t.g_blunder + h.g_blunder,
           g_ev_bb        = t.g_ev_bb + h.g_ev_bb,
           g_ev_pot       = t.g_ev_pot + h.g_ev_pot,
           g_score_sum    = t.g_score_sum + h.g_score_sum,
           g_score_sq     = t.g_score_sq + h.g_score_sq
      from per_hand h
      left join codes c on c.hand_id = h.hand_id and c.analysis_version = h.analysis_version
     where t.hand_id = h.hand_id and t.analysis_version = h.analysis_version
    returning t.owner_id, t.analysis_version, t.site, t.currency, t.currency_minor_units, t.small_blind,
              t.big_blind, h.first_graded, h.first_chart, h.first_node
  )
  insert into public.analysis_graded_sites as t (
    owner_id, analysis_version, site, currency, currency_minor_units, small_blind, big_blind, graded_hands,
    chart_hands, node_hands)
  select owner_id, analysis_version, site, currency, currency_minor_units, small_blind, big_blind,
         count(*) filter (where first_graded), count(*) filter (where first_chart), count(*) filter (where first_node)
  from hand_rows
  where first_graded or first_chart or first_node
  group by 1, 2, 3, 4, 5, 6, 7
  order by 1, 2, 3, 4, 5, 6, 7
  on conflict on constraint analysis_graded_sites_key
  do update set graded_hands = t.graded_hands + excluded.graded_hands,
                chart_hands  = t.chart_hands + excluded.chart_hands,
                node_hands   = t.node_hands + excluded.node_hands;

  return null;
end;
$$;

create or replace function public.analysis_leak_rows_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || o.owner_id::text, 0))
  from (select distinct owner_id from deleted order by 1) o;

  -- The leak rows carry their own groups: the hand may be gone already.
  with gone as (
    delete from public.analysis_leak_rows x
    using deleted d
    where x.hand_id = d.hand_id and x.analysis_version = d.analysis_version and x.ord = d.ord
    returning x.*
  ),
  -- The statement's hands' leak rows before it, and those it leaves.
  prior as materialized (
    select x.hand_id, x.analysis_version, x.ord, x.street, x.spot_key, x.chart_set, x.grade, x.source,
           x.node_line, x.chosen_action
    from public.analysis_leak_rows x
    where (x.hand_id, x.analysis_version) in (select distinct hand_id, analysis_version from deleted)
  ),
  remaining as materialized (
    select p.* from prior p
    where not exists (select 1 from deleted d
                      where d.hand_id = p.hand_id and d.analysis_version = p.analysis_version and d.ord = p.ord)
  ),
  -- Each row that goes, and whether it is its hand's last in a group.
  g as (
    select x.*, d.scenario, d.reason, d.worst_flag, d.facing_bet, d.action, d.mdf, d.flags,
           x.grade is not null and not exists (
             select 1 from remaining r where r.hand_id = x.hand_id and r.analysis_version = x.analysis_version
               and r.grade is not null) as last_graded,
           x.grade is not null and not exists (
             select 1 from remaining r where r.hand_id = x.hand_id and r.analysis_version = x.analysis_version
               and r.grade is not null and r.street = x.street) as last_graded_street,
           x.grade is not null and not exists (
             select 1 from remaining r where r.hand_id = x.hand_id and r.analysis_version = x.analysis_version
               and r.grade is not null and r.spot_key = x.spot_key and r.chart_set = x.chart_set) as last_in_spot,
           (x.street = 'preflop' and x.source = 'chart' and x.grade is not null) and not exists (
             select 1 from remaining r where r.hand_id = x.hand_id and r.analysis_version = x.analysis_version
               and r.street = 'preflop' and r.source = 'chart' and r.grade is not null) as last_chart,
           (x.node_line is not null and x.chosen_action is not null) and not exists (
             select 1 from remaining r where r.hand_id = x.hand_id and r.analysis_version = x.analysis_version
               and r.node_line is not null and r.chosen_action is not null) as last_node
    from gone x
    join deleted d on d.hand_id = x.hand_id and d.analysis_version = x.analysis_version and d.ord = x.ord
  ),
  -- Leak totals.
  ts as (
    select owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set,
           count(*) as decisions, count(distinct hand_id) filter (where last_in_spot) as hands,
           count(*) filter (where grade <> 'perfect') as non_perfect,
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
           count(*) filter (where grade = 'mistake') as g_mistake, count(*) filter (where grade = 'blunder') as g_blunder,
           sum(ev_loss_bb) as ev_loss_bb, sum(ev_loss_pot) as ev_loss_pot,
           coalesce(sum(score), 0) as score_sum, coalesce(sum(score * score), 0) as score_sq
    from g
    where grade is not null
    group by 1, 2, 3, 4, 5, 6, 7
  ),
  ts_less as (
    update public.analysis_leak_totals t
       set decisions = t.decisions - s.decisions, hands = t.hands - s.hands, non_perfect = t.non_perfect - s.non_perfect,
           mistakes = t.mistakes - s.mistakes, g_mistake = t.g_mistake - s.g_mistake, g_blunder = t.g_blunder - s.g_blunder,
           ev_loss_bb = t.ev_loss_bb - s.ev_loss_bb, ev_loss_pot = t.ev_loss_pot - s.ev_loss_pot,
           score_sum = t.score_sum - s.score_sum, score_sq = t.score_sq - s.score_sq
      from ts s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.spot_key = s.spot_key
       and t.chart_set = s.chart_set and t.decisions > s.decisions
  ),
  ts_gone as (
    delete from public.analysis_leak_totals t
     using ts s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.spot_key = s.spot_key
       and t.chart_set = s.chart_set and t.decisions <= s.decisions
  ),
  -- The same per room and stake.
  sts as (
    select owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set,
           count(*) as decisions, count(distinct hand_id) filter (where last_in_spot) as hands,
           count(*) filter (where grade <> 'perfect') as non_perfect,
           count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
           count(*) filter (where grade = 'mistake') as g_mistake, count(*) filter (where grade = 'blunder') as g_blunder,
           sum(ev_loss_bb) as ev_loss_bb, sum(ev_loss_pot) as ev_loss_pot,
           coalesce(sum(score), 0) as score_sum, coalesce(sum(score * score), 0) as score_sq
    from g
    where grade is not null
    group by 1, 2, 3, 4, 5, 6, 7
  ),
  sts_less as (
    update public.analysis_leak_stake_totals t
       set decisions = t.decisions - s.decisions, hands = t.hands - s.hands, non_perfect = t.non_perfect - s.non_perfect,
           mistakes = t.mistakes - s.mistakes, g_mistake = t.g_mistake - s.g_mistake, g_blunder = t.g_blunder - s.g_blunder,
           ev_loss_bb = t.ev_loss_bb - s.ev_loss_bb, ev_loss_pot = t.ev_loss_pot - s.ev_loss_pot,
           score_sum = t.score_sum - s.score_sum, score_sq = t.score_sq - s.score_sq
      from sts s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.site = s.site
       and t.currency = s.currency and t.big_blind is not distinct from s.big_blind and t.spot_key = s.spot_key
       and t.chart_set = s.chart_set and t.decisions > s.decisions
  ),
  sts_gone as (
    delete from public.analysis_leak_stake_totals t
     using sts s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.site = s.site
       and t.currency = s.currency and t.big_blind is not distinct from s.big_blind and t.spot_key = s.spot_key
       and t.chart_set = s.chart_set and t.decisions <= s.decisions
  ),
  -- Trend days; a day's first or last time that goes is looked up again
  -- among the rows it leaves.
  tr as (
    select g.owner_id, g.analysis_version, g.day, k.grp, k.key,
           count(distinct g.hand_id) filter (where k.last) as hands, count(*) as decisions,
           count(*) filter (where g.grade <> 'perfect') as non_perfect,
           count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
           count(*) filter (where g.grade = 'mistake') as g_mistake, count(*) filter (where g.grade = 'blunder') as g_blunder,
           sum(g.ev_loss_bb) as ev_loss_bb, sum(g.ev_loss_pot) as ev_loss_pot,
           coalesce(sum(g.score), 0) as score_sum, coalesce(sum(g.score * g.score), 0) as score_sq,
           min(g.played_at) as first_at, max(g.played_at) as last_at
    from g
    cross join lateral (values ('all', '', g.last_graded), ('street', g.street, g.last_graded_street),
                               ('position', g.hero_position, g.last_graded),
                               ('pot_type', g.pot_type, g.last_graded)) k(grp, key, last)
    where g.grade is not null and g.played_at is not null
    group by 1, 2, 3, 4, 5
  ),
  tr_less as (
    update public.analysis_trend_days t
       set hands = t.hands - s.hands, decisions = t.decisions - s.decisions, non_perfect = t.non_perfect - s.non_perfect,
           mistakes = t.mistakes - s.mistakes, g_mistake = t.g_mistake - s.g_mistake, g_blunder = t.g_blunder - s.g_blunder,
           ev_loss_bb = t.ev_loss_bb - s.ev_loss_bb, ev_loss_pot = t.ev_loss_pot - s.ev_loss_pot,
           score_sum = t.score_sum - s.score_sum, score_sq = t.score_sq - s.score_sq,
           first_at = case when s.first_at > t.first_at then t.first_at else (
             select min(x.played_at) from public.analysis_leak_rows x
             where x.owner_id = t.owner_id and x.analysis_version = t.analysis_version
               and x.played_at >= (t.day::timestamp at time zone 'UTC')
               and x.played_at < ((t.day + 1)::timestamp at time zone 'UTC')
               and x.grade is not null and public.analysis_trend_matches(t.grp, t.key, x.street, x.hero_position, x.pot_type)
               and not exists (select 1 from deleted d
                               where d.hand_id = x.hand_id and d.analysis_version = x.analysis_version and d.ord = x.ord))
             end,
           last_at = case when s.last_at < t.last_at then t.last_at else (
             select max(x.played_at) from public.analysis_leak_rows x
             where x.owner_id = t.owner_id and x.analysis_version = t.analysis_version
               and x.played_at >= (t.day::timestamp at time zone 'UTC')
               and x.played_at < ((t.day + 1)::timestamp at time zone 'UTC')
               and x.grade is not null and public.analysis_trend_matches(t.grp, t.key, x.street, x.hero_position, x.pot_type)
               and not exists (select 1 from deleted d
                               where d.hand_id = x.hand_id and d.analysis_version = x.analysis_version and d.ord = x.ord))
             end
      from tr s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.grp = s.grp and t.day = s.day
       and t.key = s.key and t.decisions > s.decisions
  ),
  tr_gone as (
    delete from public.analysis_trend_days t
     using tr s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.grp = s.grp and t.day = s.day
       and t.key = s.key and t.decisions <= s.decisions
  ),
  -- The overview's decisions and flags.
  ds as (
    select owner_id, analysis_version, game_format, hero_position, pot_type, street, scenario, status,
           coalesce(reason, '') as reason, coalesce(grade, '') as grade, coalesce(worst_flag, '') as worst_flag,
           count(*) as decisions, count(*) filter (where facing_bet) as facing,
           count(*) filter (where facing_bet and action in ('call', 'raise')) as defended,
           coalesce(sum(mdf) filter (where facing_bet), 0) as mdf_sum, count(mdf) filter (where facing_bet) as mdf_n,
           coalesce(sum(score), 0) as score_sum, count(score) as score_n,
           sum(ev_loss_bb) as ev_bb_sum, count(*) filter (where not ev_bb_null) as ev_bb_n,
           sum(ev_loss_pot) as ev_pot_sum, count(*) filter (where not ev_pot_null) as ev_pot_n
    from g
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
  ),
  ds_less as (
    update public.analysis_overview_decisions t
       set decisions = t.decisions - s.decisions, facing = t.facing - s.facing, defended = t.defended - s.defended,
           mdf_sum = t.mdf_sum - s.mdf_sum, mdf_n = t.mdf_n - s.mdf_n, score_sum = t.score_sum - s.score_sum,
           score_n = t.score_n - s.score_n, ev_bb_sum = t.ev_bb_sum - s.ev_bb_sum, ev_bb_n = t.ev_bb_n - s.ev_bb_n,
           ev_pot_sum = t.ev_pot_sum - s.ev_pot_sum, ev_pot_n = t.ev_pot_n - s.ev_pot_n
      from ds s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.street = s.street
       and t.scenario = s.scenario and t.status = s.status and t.reason = s.reason and t.grade = s.grade
       and t.worst_flag = s.worst_flag and t.decisions > s.decisions
  ),
  ds_gone as (
    delete from public.analysis_overview_decisions t
     using ds s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.street = s.street
       and t.scenario = s.scenario and t.status = s.status and t.reason = s.reason and t.grade = s.grade
       and t.worst_flag = s.worst_flag and t.decisions <= s.decisions
  ),
  fs as (
    select g.owner_id, g.analysis_version, g.game_format, g.hero_position, g.pot_type, g.street,
           fl ->> 'code' as code, fl ->> 'severity' as severity, count(*) as flags
    from g, jsonb_array_elements(g.flags) fl
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  fs_less as (
    update public.analysis_overview_flags t set flags = t.flags - s.flags
      from fs s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.street = s.street
       and t.code = s.code and t.severity = s.severity and t.flags > s.flags
  ),
  fs_gone as (
    delete from public.analysis_overview_flags t
     using fs s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.street = s.street
       and t.code = s.code and t.severity = s.severity and t.flags <= s.flags
  ),
  -- The breakdown's distinct hands.
  hk as (
    select g.owner_id, g.analysis_version, g.hand_id, g.game_format, g.hero_position, g.pot_type, k.kind, k.key,
           bool_or(g.grade is not null) as graded
    from g
    cross join lateral (values ('all', ''), ('street', g.street), ('scenario', g.scenario),
                               ('preflop', case when g.street = 'preflop' then g.scenario end)) k(kind, key)
    where k.key is not null
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  ks as (
    select owner_id, analysis_version, game_format, hero_position, pot_type, kind, key,
           count(*) filter (where l.lost_any) as hands, count(*) filter (where l.lost_graded) as graded_hands
    from hk
    cross join lateral (
      select not exists (select 1 from remaining r where r.hand_id = hk.hand_id and r.analysis_version = hk.analysis_version
                           and public.analysis_key_matches(hk.kind, hk.key, r.street, r.spot_key)) as lost_any,
             hk.graded and not exists (
               select 1 from remaining r where r.hand_id = hk.hand_id and r.analysis_version = hk.analysis_version
                 and r.grade is not null and public.analysis_key_matches(hk.kind, hk.key, r.street, r.spot_key)) as lost_graded
    ) l
    group by 1, 2, 3, 4, 5, 6, 7
  ),
  ks_less as (
    update public.analysis_overview_keys t
       set hands = t.hands - s.hands, graded_hands = t.graded_hands - s.graded_hands
      from ks s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.kind = s.kind and t.key = s.key
       and t.hands > s.hands
  ),
  ks_gone as (
    delete from public.analysis_overview_keys t
     using ks s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.game_format = s.game_format
       and t.hero_position = s.hero_position and t.pot_type = s.pot_type and t.kind = s.kind and t.key = s.key
       and t.hands <= s.hands
  ),
  -- Node totals.
  ns as (
    select owner_id, analysis_version, street, node_set, node_line as line, node_scenario as scenario, hand_class,
           chosen_action as action, count(*) as decisions, count(*) filter (where grade <> 'perfect') as deviations,
           sum(ev_loss_bb) as ev_loss_bb
    from g
    where node_line is not null and chosen_action is not null
    group by 1, 2, 3, 4, 5, 6, 7, 8
    union all
    select owner_id, analysis_version, street, null, '', scenario, null, action, count(*), 0, 0
    from g
    where street <> 'preflop' and status = 'analysed'
    group by 1, 2, 3, 6, 8
  ),
  ns_less as (
    update public.analysis_node_totals t
       set decisions = t.decisions - s.decisions, deviations = t.deviations - s.deviations,
           ev_loss_bb = t.ev_loss_bb - s.ev_loss_bb
      from ns s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.street = s.street
       and t.node_set is not distinct from s.node_set and t.line = s.line
       and t.scenario is not distinct from s.scenario and t.hand_class is not distinct from s.hand_class
       and t.action = s.action and t.decisions > s.decisions
  ),
  ns_gone as (
    delete from public.analysis_node_totals t
     using ns s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.street = s.street
       and t.node_set is not distinct from s.node_set and t.line = s.line
       and t.scenario is not distinct from s.scenario and t.hand_class is not distinct from s.hand_class
       and t.action = s.action and t.decisions <= s.decisions
  ),
  -- Per hand: the hand row's sums (when the analysis row stays: a prune
  -- removes the hand row next) and the room / stake counts.
  per_hand as (
    select g.owner_id, g.hand_id, g.analysis_version,
           -- the hand's room and stake, from its own leak rows
           g.site, g.currency, g.currency_minor_units, g.small_blind, g.big_blind,
           count(*) filter (where g.grade is not null) as graded,
           count(*) filter (where g.street = 'preflop' and g.source = 'chart' and g.grade is not null) as chart_graded,
           count(*) filter (where g.node_line is not null and g.chosen_action is not null) as node_decisions,
           count(*) filter (where g.grade is not null and g.grade <> 'perfect') as g_non_perfect,
           count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')) as g_mistakes,
           count(*) filter (where g.grade = 'mistake') as g_mistake,
           count(*) filter (where g.grade = 'blunder') as g_blunder,
           coalesce(sum(g.ev_loss_bb) filter (where g.grade is not null), 0) as g_ev_bb,
           coalesce(sum(g.ev_loss_pot) filter (where g.grade is not null), 0) as g_ev_pot,
           coalesce(sum(g.score) filter (where g.grade is not null), 0) as g_score_sum,
           coalesce(sum(g.score * g.score) filter (where g.grade is not null), 0) as g_score_sq,
           bool_or(g.last_graded) as last_graded, bool_or(g.last_chart) as last_chart, bool_or(g.last_node) as last_node
    from g
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  hand_rows as (
    update public.analysis_hand_rows t
       set graded         = t.graded - h.graded,
           chart_graded   = t.chart_graded - h.chart_graded,
           node_decisions = t.node_decisions - h.node_decisions,
           g_non_perfect  = t.g_non_perfect - h.g_non_perfect,
           g_mistakes     = t.g_mistakes - h.g_mistakes,
           g_mistake      = t.g_mistake - h.g_mistake,
           g_blunder      = t.g_blunder - h.g_blunder,
           g_ev_bb        = t.g_ev_bb - h.g_ev_bb,
           g_ev_pot       = t.g_ev_pot - h.g_ev_pot,
           g_score_sum    = t.g_score_sum - h.g_score_sum,
           g_score_sq     = t.g_score_sq - h.g_score_sq
      from per_hand h
     where t.hand_id = h.hand_id and t.analysis_version = h.analysis_version
       and exists (select 1 from public.hand_analysis a
                   where a.hand_id = h.hand_id and a.analysis_version = h.analysis_version)
  ),
  ss as (
    select h.owner_id, h.analysis_version, h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind,
           count(*) filter (where h.last_graded) as graded_hands, count(*) filter (where h.last_chart) as chart_hands,
           count(*) filter (where h.last_node) as node_hands
    from per_hand h
    where h.last_graded or h.last_chart or h.last_node
    group by 1, 2, 3, 4, 5, 6, 7
  ),
  ss_less as (
    update public.analysis_graded_sites t
       set graded_hands = t.graded_hands - s.graded_hands, chart_hands = t.chart_hands - s.chart_hands,
           node_hands = t.node_hands - s.node_hands
      from ss s
     where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.site = s.site
       and t.currency = s.currency and t.currency_minor_units = s.currency_minor_units
       and t.small_blind is not distinct from s.small_blind and t.big_blind is not distinct from s.big_blind
       and t.graded_hands > s.graded_hands
  )
  delete from public.analysis_graded_sites t
   using ss s
   where t.owner_id = s.owner_id and t.analysis_version = s.analysis_version and t.site = s.site
     and t.currency = s.currency and t.currency_minor_units = s.currency_minor_units
     and t.small_blind is not distinct from s.small_blind and t.big_blind is not distinct from s.big_blind
     and t.graded_hands <= s.graded_hands;

  -- Streets and flag codes of a hand that keeps its analysis row, again
  -- from what is left (only when decisions go without their hand).
  update public.analysis_hand_rows t
     set streets = coalesce(x.streets, 0), flag_codes = coalesce(x.codes, '{}')
    from (select distinct hand_id, analysis_version from deleted) h
    cross join lateral (
      select bit_or(public.analysis_street_bit(d.street))::smallint as streets,
             (select array_agg(distinct fl ->> 'code' order by fl ->> 'code')
              from public.decision_analysis d2, jsonb_array_elements(d2.flags) fl
              where d2.hand_id = h.hand_id and d2.analysis_version = h.analysis_version) as codes
      from public.decision_analysis d
      where d.hand_id = h.hand_id and d.analysis_version = h.analysis_version) x
   where t.hand_id = h.hand_id and t.analysis_version = h.analysis_version
     and exists (select 1 from public.hand_analysis a
                 where a.hand_id = h.hand_id and a.analysis_version = h.analysis_version);

  return null;
end;
$$;

-- Whether a leak row is in a trend group's key.
create or replace function public.analysis_trend_matches(p_grp text, p_key text, p_street text, p_position text, p_pot text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_grp
           when 'all' then true
           when 'street' then p_street = p_key
           when 'position' then p_position = p_key
           else p_pot = p_key
         end;
$$;

revoke all on function public.analysis_trend_matches(text, text, text, text, text) from public, anon, authenticated;
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
--
-- R5.2's `analysis_leak_summaries_rebuild(owner)` now recounts every table
-- above for one account from `hand_analysis`, `decision_analysis` and
-- `hands`, with the triggers' own expressions. pgTAP holds the triggers'
-- sums equal to it.

create or replace function public.analysis_leak_summaries_rebuild(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
-- A recount reads whole tables, often just written (no statistics yet): hash
-- joins, never a loop over a table scan.
set enable_nestloop = off
as $$
declare
  v_rows integer;
begin
  if p_owner is null then
    raise exception 'analysis_leak_summaries_rebuild needs an owner.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('analysis_leak_sums:' || p_owner::text, 0));

  delete from public.analysis_hand_rows where owner_id = p_owner;
  delete from public.analysis_month_hands where owner_id = p_owner;
  delete from public.analysis_leak_rows where owner_id = p_owner;
  delete from public.analysis_leak_totals where owner_id = p_owner;
  delete from public.analysis_leak_stake_totals where owner_id = p_owner;
  delete from public.analysis_trend_days where owner_id = p_owner;
  delete from public.analysis_overview_hands where owner_id = p_owner;
  delete from public.analysis_overview_decisions where owner_id = p_owner;
  delete from public.analysis_overview_flags where owner_id = p_owner;
  delete from public.analysis_overview_keys where owner_id = p_owner;
  delete from public.analysis_node_totals where owner_id = p_owner;
  delete from public.analysis_graded_sites where owner_id = p_owner;

  -- Hand rows, with what their decisions add up to.
  insert into public.analysis_hand_rows (
    hand_id, analysis_version, owner_id, played_at, site, game_format, currency, currency_minor_units,
    small_blind, big_blind, hero_position, hero_profit, pot_type, status, reason, grade, score, ev_loss_bb,
    ev_loss_pot, flag_count, worst_flag, approximations, streets, flag_codes, graded, chart_graded,
    node_decisions, g_non_perfect, g_mistakes, g_mistake, g_blunder, g_ev_bb, g_ev_pot, g_score_sum, g_score_sq)
  with d as materialized (
    select d.hand_id, d.analysis_version,
           bit_or(public.analysis_street_bit(d.street))::smallint as streets,
           count(*) filter (where d.grade is not null) as graded,
           count(*) filter (where d.street = 'preflop' and d.source = 'chart' and d.grade is not null) as chart_graded,
           count(*) filter (where public.analysis_is_node(d.street, d.source, d.grade, d.chosen, d.facts)
                              and public.analysis_chosen_action(d.options, d.chosen) is not null) as node_decisions,
           count(*) filter (where d.grade <> 'perfect') as g_non_perfect,
           count(*) filter (where d.grade in ('inaccurate', 'mistake', 'blunder')) as g_mistakes,
           count(*) filter (where d.grade = 'mistake') as g_mistake,
           count(*) filter (where d.grade = 'blunder') as g_blunder,
           coalesce(sum(coalesce(d.ev_loss_bb, 0)) filter (where d.grade is not null), 0) as g_ev_bb,
           coalesce(sum(coalesce(d.ev_loss_pot, 0)) filter (where d.grade is not null), 0) as g_ev_pot,
           coalesce(sum(d.score) filter (where d.grade is not null), 0) as g_score_sum,
           coalesce(sum(d.score * d.score) filter (where d.grade is not null), 0) as g_score_sq
    from public.decision_analysis d
    where d.owner_id = p_owner
    group by 1, 2
  ),
  c as materialized (
    select d.hand_id, d.analysis_version, array_agg(distinct fl ->> 'code' order by fl ->> 'code') as codes
    from public.decision_analysis d, jsonb_array_elements(d.flags) fl
    where d.owner_id = p_owner
    group by 1, 2
  )
  select a.hand_id, a.analysis_version, a.owner_id, h.played_at, h.site, h.game_format::text, h.currency,
         h.currency_minor_units, h.small_blind, h.big_blind, h.hero_position, h.hero_profit, a.pot_type, a.status,
         a.reason, a.grade, a.score, a.ev_loss_bb, a.ev_loss_pot, a.flag_count, a.worst_flag, a.approximations,
         coalesce(d.streets, 0), coalesce(c.codes, '{}'), coalesce(d.graded, 0), coalesce(d.chart_graded, 0),
         coalesce(d.node_decisions, 0), coalesce(d.g_non_perfect, 0), coalesce(d.g_mistakes, 0),
         coalesce(d.g_mistake, 0), coalesce(d.g_blunder, 0), coalesce(d.g_ev_bb, 0), coalesce(d.g_ev_pot, 0),
         coalesce(d.g_score_sum, 0), coalesce(d.g_score_sq, 0)
  from public.hand_analysis a
  join public.hands h on h.id = a.hand_id and h.owner_id = a.owner_id
  left join d on d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
  left join c on c.hand_id = a.hand_id and c.analysis_version = a.analysis_version
  where a.owner_id = p_owner;

  insert into public.analysis_month_hands (owner_id, analysis_version, month, hands)
  select p_owner, analysis_version, public.analysis_month_of(played_at), count(*)
  from public.analysis_hand_rows where owner_id = p_owner
  group by 2, 3
  union all
  select p_owner, '', month, count(*)
  from (select distinct on (hand_id) hand_id, public.analysis_month_of(played_at) as month
        from public.analysis_hand_rows where owner_id = p_owner order by hand_id) z
  group by 3;

  insert into public.analysis_overview_hands (
    owner_id, analysis_version, game_format, hero_position, pot_type, status, reason, grade, flagged,
    approximations, hands)
  select owner_id, analysis_version, game_format, coalesce(hero_position, ''), coalesce(pot_type, ''), status,
         coalesce(reason, ''), coalesce(grade, ''), flag_count > 0, approximations, count(*)
  from public.analysis_hand_rows where owner_id = p_owner
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

  -- Leak rows: every decision.
  insert into public.analysis_leak_rows (
    hand_id, analysis_version, ord, owner_id, action_index, played_at, day, site, game_format, currency, currency_minor_units, small_blind,
    big_blind, hero_position, pot_type, street, status, source, spot_key, chart_set, grade, score, ev_loss_bb,
    ev_loss_pot, ev_bb_null, ev_pot_null, node_set, node_line, node_scenario, hand_class, chosen_action)
  select d.hand_id, d.analysis_version, d.ord, d.owner_id, d.action_index, r.played_at,
         coalesce((r.played_at at time zone 'UTC')::date, '-infinity'::date),
         r.site, r.game_format, r.currency, r.currency_minor_units, r.small_blind, r.big_blind, coalesce(r.hero_position, ''), coalesce(r.pot_type, ''),
         d.street, d.status, d.source,
         public.analysis_leak_spot_key(d.street, d.scenario, d.source, d.facts, r.hero_position, d.action, d.options),
         public.analysis_leak_chart_set(d.source, d.facts),
         d.grade, d.score, coalesce(d.ev_loss_bb, 0), coalesce(d.ev_loss_pot, 0),
         d.ev_loss_bb is null, d.ev_loss_pot is null,
         case when n.is_node then d.facts -> 'chart' ->> 'set' end,
         case when n.is_node then d.facts -> 'chart' ->> 'line' end,
         case when n.is_node then d.facts -> 'chart' ->> 'scenario' end,
         case when n.is_node then d.facts ->> 'handClass' end,
         case when n.is_node then public.analysis_chosen_action(d.options, d.chosen) end
  from public.decision_analysis d
  join public.analysis_hand_rows r on r.hand_id = d.hand_id and r.analysis_version = d.analysis_version
  cross join lateral (select public.analysis_is_node(d.street, d.source, d.grade, d.chosen, d.facts) as is_node) n
  where d.owner_id = p_owner;
  get diagnostics v_rows = row_count;

  insert into public.analysis_leak_totals (
    owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, decisions, hands,
    non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
  select owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set, count(*),
         count(distinct hand_id), count(*) filter (where grade <> 'perfect'),
         count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
         count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
         sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
  from public.analysis_leak_rows
  where owner_id = p_owner and grade is not null
  group by 1, 2, 3, 4, 5, 6, 7;

  insert into public.analysis_leak_stake_totals (
    owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, decisions, hands,
    non_perfect, mistakes, g_mistake, g_blunder, ev_loss_bb, ev_loss_pot, score_sum, score_sq)
  select owner_id, analysis_version, site, currency, big_blind, spot_key, chart_set, count(*),
         count(distinct hand_id), count(*) filter (where grade <> 'perfect'),
         count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')),
         count(*) filter (where grade = 'mistake'), count(*) filter (where grade = 'blunder'),
         sum(ev_loss_bb), sum(ev_loss_pot), coalesce(sum(score), 0), coalesce(sum(score * score), 0)
  from public.analysis_leak_rows
  where owner_id = p_owner and grade is not null
  group by 1, 2, 3, 4, 5, 6, 7;

  insert into public.analysis_trend_days (
    owner_id, analysis_version, day, grp, key, hands, decisions, non_perfect, mistakes, g_mistake, g_blunder,
    ev_loss_bb, ev_loss_pot, score_sum, score_sq, first_at, last_at)
  select x.owner_id, x.analysis_version, x.day, k.grp, k.key, count(distinct x.hand_id), count(*),
         count(*) filter (where x.grade <> 'perfect'),
         count(*) filter (where x.grade in ('inaccurate', 'mistake', 'blunder')),
         count(*) filter (where x.grade = 'mistake'), count(*) filter (where x.grade = 'blunder'),
         sum(x.ev_loss_bb), sum(x.ev_loss_pot), coalesce(sum(x.score), 0), coalesce(sum(x.score * x.score), 0),
         min(x.played_at), max(x.played_at)
  from public.analysis_leak_rows x
  cross join lateral (values ('all', ''), ('street', x.street), ('position', x.hero_position),
                             ('pot_type', x.pot_type)) k(grp, key)
  where x.owner_id = p_owner and x.grade is not null and x.played_at is not null
  group by 1, 2, 3, 4, 5;

  insert into public.analysis_overview_decisions (
    owner_id, analysis_version, game_format, hero_position, pot_type, street, scenario, status, reason, grade,
    worst_flag, decisions, facing, defended, mdf_sum, mdf_n, score_sum, score_n, ev_bb_sum, ev_bb_n, ev_pot_sum,
    ev_pot_n)
  select x.owner_id, x.analysis_version, x.game_format, x.hero_position, x.pot_type, d.street, d.scenario, d.status,
         coalesce(d.reason, ''), coalesce(d.grade, ''), coalesce(d.worst_flag, ''), count(*),
         count(*) filter (where d.facing_bet), count(*) filter (where d.facing_bet and d.action in ('call', 'raise')),
         coalesce(sum(d.mdf) filter (where d.facing_bet), 0), count(d.mdf) filter (where d.facing_bet),
         coalesce(sum(d.score), 0), count(d.score),
         sum(x.ev_loss_bb), count(*) filter (where not x.ev_bb_null),
         sum(x.ev_loss_pot), count(*) filter (where not x.ev_pot_null)
  from public.analysis_leak_rows x
  join public.decision_analysis d on d.hand_id = x.hand_id and d.analysis_version = x.analysis_version and d.ord = x.ord
  where x.owner_id = p_owner
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11;

  insert into public.analysis_overview_flags (
    owner_id, analysis_version, game_format, hero_position, pot_type, street, code, severity, flags)
  select x.owner_id, x.analysis_version, x.game_format, x.hero_position, x.pot_type, x.street,
         fl ->> 'code', fl ->> 'severity', count(*)
  from public.analysis_leak_rows x
  join public.decision_analysis d on d.hand_id = x.hand_id and d.analysis_version = x.analysis_version and d.ord = x.ord
  cross join lateral jsonb_array_elements(d.flags) fl
  where x.owner_id = p_owner
  group by 1, 2, 3, 4, 5, 6, 7, 8;

  insert into public.analysis_overview_keys (
    owner_id, analysis_version, game_format, hero_position, pot_type, kind, key, hands, graded_hands)
  select x.owner_id, x.analysis_version, x.game_format, x.hero_position, x.pot_type, k.kind, k.key,
         count(distinct x.hand_id), count(distinct x.hand_id) filter (where x.grade is not null)
  from public.analysis_leak_rows x
  cross join lateral (values ('all', ''), ('street', x.street), ('scenario', split_part(x.spot_key, '|', 2)),
                             ('preflop', case when x.street = 'preflop' then split_part(x.spot_key, '|', 2) end)) k(kind, key)
  where x.owner_id = p_owner and k.key is not null
  group by 1, 2, 3, 4, 5, 6, 7;

  insert into public.analysis_node_totals (
    owner_id, analysis_version, street, node_set, line, scenario, hand_class, action, decisions, deviations,
    ev_loss_bb)
  select owner_id, analysis_version, street, node_set, node_line, node_scenario, hand_class, chosen_action,
         count(*), count(*) filter (where grade <> 'perfect'), sum(ev_loss_bb)
  from public.analysis_leak_rows
  where owner_id = p_owner and node_line is not null and chosen_action is not null
  group by 1, 2, 3, 4, 5, 6, 7, 8
  union all
  select owner_id, analysis_version, street, null, '', split_part(spot_key, '|', 2), null, split_part(spot_key, '|', 5),
         count(*), 0, 0
  from public.analysis_leak_rows
  where owner_id = p_owner and street <> 'preflop' and status = 'analysed'
  group by 1, 2, 3, 6, 8;

  insert into public.analysis_graded_sites (
    owner_id, analysis_version, site, currency, currency_minor_units, small_blind, big_blind, graded_hands,
    chart_hands, node_hands)
  select owner_id, analysis_version, site, currency, currency_minor_units, small_blind, big_blind,
         count(*) filter (where graded > 0), count(*) filter (where chart_graded > 0),
         count(*) filter (where node_decisions > 0)
  from public.analysis_hand_rows
  where owner_id = p_owner and graded > 0
  group by 1, 2, 3, 4, 5, 6, 7;

  return jsonb_build_object('rows', v_rows);
end;
$$;

comment on function public.analysis_leak_summaries_rebuild(uuid) is
  'Recounts one account''s analysis summaries (hand rows, month counts, leak rows and totals, trend days, '
  'the overview''s counts, node totals, room / stake counts) from hand_analysis, decision_analysis and '
  'hands: the repair after a write that bypassed the triggers, and the backfill. Definer; granted to nobody.';

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

analyze public.analysis_hand_rows;
analyze public.analysis_month_hands;
analyze public.analysis_leak_rows;
analyze public.analysis_leak_totals;
analyze public.analysis_leak_stake_totals;
analyze public.analysis_trend_days;
analyze public.analysis_overview_hands;
analyze public.analysis_overview_decisions;
analyze public.analysis_overview_flags;
analyze public.analysis_overview_keys;
analyze public.analysis_node_totals;
analyze public.analysis_graded_sites;

-- ---------------------------------------------------------------------------
-- 5. The previous bodies, for the filters the sums do not hold
-- ---------------------------------------------------------------------------
--
-- `20270818090000`'s definitions, verbatim but for the name (`<reader>_scan`).
-- A reader calls its scan when a filter is one its sums cannot answer - a
-- grade, a status, a street or a flag on a report, which the web never sends
-- there - so every input keeps its previous answer. Invoker, owner-first,
-- planned per call, as before.

CREATE OR REPLACE FUNCTION public.analysis_overview_scan(p_filters jsonb DEFAULT '{}'::jsonb)
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

  with s as materialized (select * from public.analysis_scope(p_filters)),
  d as materialized (
    select dd.*
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner
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
                       order by public.analysis_grade_rank(x.grade))
      from (select grade, count(*) as n from d where grade is not null group by grade) x), '[]'::jsonb),
    'gradesByStreet', coalesce((
      select jsonb_agg(jsonb_build_object('street', x.street, 'grade', x.grade, 'decisions', x.n)
                       order by array_position(array['preflop', 'flop', 'turn', 'river'], x.street),
                                public.analysis_grade_rank(x.grade))
      from (select street, grade, count(*) as n from d where grade is not null group by street, grade) x), '[]'::jsonb),
    'graded',      (select count(*) from d where grade is not null),
    'gradedHands', (select count(*) from s where grade is not null),
    'badHands',    (select count(*) from s where public.analysis_grade_rank(grade) >= 4),
    'score',       (select round(avg(score), 2) from d where score is not null),
    'evLossBb',    (select round(sum(ev_loss_bb), 3) from d where ev_loss_bb is not null),
    'evLossPot',   (select round(sum(ev_loss_pot), 4) from d where ev_loss_pot is not null),
    'approximations', coalesce((
      select jsonb_agg(jsonb_build_object('approximation', x.ap, 'hands', x.n) order by x.n desc, x.ap)
      from (select ap, count(*) as n from s, unnest(s.approximations) ap group by ap) x), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_breakdown_scan(p_filters jsonb DEFAULT '{}'::jsonb, p_group text DEFAULT 'street'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_rows  jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('street', 'position', 'pot_type', 'scenario', 'preflop_scenario') then
    raise exception 'Unknown analysis breakdown: %', coalesce(p_group, 'null') using errcode = '22023';
  end if;

  with s as (select * from public.analysis_scope(p_filters)),
  d as (
    select dd.*, h.hero_position, s.pot_type as hand_pot_type
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    join public.hands h on h.id = dd.hand_id and h.owner_id = v_owner
    where dd.owner_id = v_owner
      and (p_group <> 'preflop_scenario' or dd.street = 'preflop')
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
           'key',         x.key,
           'hands',       x.hands,
           'decisions',   x.n,
           'analysed',    x.analysed,
           'flagged',     x.flagged,
           'inaccurate',  x.inaccurate,
           'facingBet',   x.facing,
           'defended',    x.defended,
           'mdf',         x.mdf,
           'graded',      x.graded,
           'gradedHands', x.graded_hands,
           'grades', jsonb_build_object(
             'perfect',    x.g_perfect,
             'good',       x.g_good,
             'inaccurate', x.g_inaccurate,
             'mistake',    x.g_mistake,
             'blunder',    x.g_blunder),
           'evLossBb',    x.ev_loss,
           'score',       x.score)
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
           round(avg(mdf) filter (where facing_bet and status = 'analysed' and street <> 'preflop'), 3) as mdf,
           count(*) filter (where grade is not null) as graded,
           count(distinct hand_id) filter (where grade is not null) as graded_hands,
           count(*) filter (where grade = 'perfect') as g_perfect,
           count(*) filter (where grade = 'good') as g_good,
           count(*) filter (where grade = 'inaccurate') as g_inaccurate,
           count(*) filter (where grade = 'mistake') as g_mistake,
           count(*) filter (where grade = 'blunder') as g_blunder,
           round(sum(ev_loss_bb) filter (where grade is not null), 3) as ev_loss,
           round(avg(score) filter (where grade is not null), 2) as score
    from keyed
    group by key
  ) x;

  return jsonb_build_object('group', p_group, 'rows', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_node_actions_scan(p_filters jsonb DEFAULT '{}'::jsonb)
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

  with s as materialized (select * from public.analysis_scope(p_filters)),
  d as materialized (
    select dd.hand_id,
           dd.grade,
           dd.ev_loss_bb,
           dd.facts -> 'chart' ->> 'set'      as chart_set,
           dd.facts -> 'chart' ->> 'line'     as line,
           dd.facts -> 'chart' ->> 'scenario' as chart_scenario,
           dd.facts ->> 'handClass'           as hand_class,
           public.analysis_chosen_action(dd.options, dd.chosen) as chosen_action
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner
      and dd.street = 'preflop'
      and dd.source = 'chart'
      and dd.grade is not null
      and dd.chosen is not null
      and dd.facts -> 'chart' ->> 'line' is not null
  ),
  g as (
    select * from d where chosen_action is not null
  ),
  p as (
    select dd.street, dd.scenario, dd.action
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner and dd.street <> 'preflop' and dd.status = 'analysed'
  ),
  -- The facets: the caller's graded hands at this version, unfiltered.
  f as materialized (
    select h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.played_at
    from public.hand_analysis a
    join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
    where a.owner_id = v_owner
      and a.analysis_version = v_version
      and exists (
        select 1 from public.decision_analysis dd
        where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version and dd.owner_id = v_owner
          and dd.street = 'preflop' and dd.source = 'chart' and dd.grade is not null)
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',     (select count(distinct hand_id) from g),
    'decisions', (select count(*) from g),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',        x.chart_set,
               'line',       x.line,
               'scenario',   x.chart_scenario,
               'action',     x.chosen_action,
               'decisions',  x.n,
               'deviations', x.dev,
               'evLossBb',   x.ev)
             order by x.chart_set, x.line, x.chosen_action)
      from (
        select chart_set, line, chart_scenario, chosen_action,
               count(*) as n,
               count(*) filter (where grade <> 'perfect') as dev,
               round(coalesce(sum(ev_loss_bb), 0), 3) as ev
        from g
        group by chart_set, line, chart_scenario, chosen_action
      ) x), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',       x.chart_set,
               'line',      x.line,
               'handClass', x.hand_class,
               'action',    x.chosen_action,
               'decisions', x.n)
             order by x.chart_set, x.line, x.hand_class, x.chosen_action)
      from (
        select chart_set, line, hand_class, chosen_action, count(*) as n
        from g
        where hand_class is not null
        group by chart_set, line, hand_class, chosen_action
      ) x), '[]'::jsonb),
    'postflop', coalesce((
      select jsonb_agg(jsonb_build_object(
               'street',    x.street,
               'scenario',  x.scenario,
               'action',    x.action,
               'decisions', x.n)
             order by array_position(array['flop', 'turn', 'river'], x.street), x.scenario, x.action)
      from (select street, scenario, action, count(*) as n from p group by 1, 2, 3) x), '[]'::jsonb),
    'facets', jsonb_build_object(
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object('site', x.site, 'hands', x.n) order by x.n desc, x.site)
        from (select site, count(*) as n from f group by site) x), '[]'::jsonb),
      'stakes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n)
               order by x.n desc, x.currency, x.big_blind)
        from (
          select currency, currency_minor_units, small_blind, big_blind, count(*) as n
          from f
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'first', (select min(played_at) from f),
      'last',  (select max(played_at) from f))
  ) into v_out;

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_node_hands_scan(p_filters jsonb DEFAULT '{}'::jsonb, p_nodes text[] DEFAULT NULL::text[], p_action text DEFAULT NULL::text, p_deviations boolean DEFAULT true, p_sort text DEFAULT 'ev_loss'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
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
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_nodes is null or cardinality(p_nodes) = 0 or cardinality(p_nodes) > 200 then
    raise exception 'analysis_node_hands needs between 1 and 200 chart nodes.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_nodes) k where k is null or k !~ '^[a-z0-9][a-z0-9-]{0,63}:[fkcra]{0,24}$') then
    raise exception 'Not a chart node key.' using errcode = '22023';
  end if;
  if p_action is not null and p_action not in ('fold', 'check', 'call', 'raise', 'allin') then
    raise exception 'Unknown chart action: %', p_action using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  with s as materialized (select * from public.analysis_scope(p_filters)),
  m as materialized (
    select dd.hand_id, dd.ord, dd.action_index, dd.grade, dd.ev_loss_bb, dd.ev_loss_pot,
           dd.options, dd.chosen, dd.facts,
           public.analysis_chosen_action(dd.options, dd.chosen) as chosen_action
    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner
      and dd.street = 'preflop'
      and dd.source = 'chart'
      and dd.grade is not null
      and dd.chosen is not null
      and ((dd.facts -> 'chart' ->> 'set') || ':' || (dd.facts -> 'chart' ->> 'line')) = any (p_nodes)
      and (p_action is null or public.analysis_chosen_action(dd.options, dd.chosen) = p_action)
      and (not v_dev or dd.grade <> 'perfect')
  ),
  page as (
    select
      row_number() over (
        order by
          case when v_sort = 'ev_loss' then m.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then m.ev_loss_pot end desc nulls last,
          case when v_sort = 'oldest' then h.played_at end asc nulls last,
          h.played_at desc nulls last,
          m.hand_id,
          m.ord
      ) as rn,
      jsonb_build_object(
        'handId',      m.hand_id,
        'ord',         m.ord,
        'actionIndex', m.action_index,
        'playedAt',    h.played_at,
        'site',        h.site,
        'stakesLabel', h.stakes_label,
        'position',    h.hero_position,
        'heroCards',   to_jsonb(h.hero_cards),
        'handClass',   m.facts ->> 'handClass',
        'set',         m.facts -> 'chart' ->> 'set',
        'line',        m.facts -> 'chart' ->> 'line',
        'scenario',    m.facts -> 'chart' ->> 'scenario',
        'inRange',     m.facts -> 'chart' -> 'inRange',
        'action',      m.chosen_action,
        'grade',       m.grade,
        'evLossBb',    m.ev_loss_bb,
        'evLossPot',   m.ev_loss_pot,
        'options',     m.options,
        'chosen',      m.chosen
      ) as row_json
    from m
    join public.hands h on h.id = m.hand_id and h.owner_id = v_owner
    order by rn
    offset v_offset
    limit v_limit
  )
  select (select count(*) from m),
         coalesce((select jsonb_agg(row_json order by rn) from page), '[]'::jsonb)
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
                then dd.facts -> 'chart' ->> 'set' end as chart_set
    from public.analysis_graded_decisions(p_filters) d
    left join public.decision_analysis dd
      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version and dd.owner_id = v_owner
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
             order by x.spot_key, x.chart_set nulls first)
      from (
        select g.spot_key, g.chart_set, g.street, g.scenario, g.line, g."position" as pos, g.taken, g.best,
               count(*) as n,
               count(distinct g.hand_id) as hands,
               count(*) filter (where g.grade <> 'perfect') as non_perfect,
               count(*) filter (where public.analysis_grade_rank(g.grade) >= 3) as mistakes,
               round(sum(g.ev_loss_bb), 3) as ev_bb,
               round(sum(g.ev_loss_pot), 4) as ev_pot,
               round(coalesce(sum(g.score), 0), 2) as score_sum,
               round(coalesce(sum(g.score * g.score), 0), 2) as score_sq
        from g
        group by g.spot_key, g.chart_set, g.street, g.scenario, g.line, g."position", g.taken, g.best
      ) x), '[]'::jsonb),
    'facets', public.analysis_graded_facets(v_version)
  ) into v_out;

  return v_out;
end;
$function$;

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

  with m as materialized (
    select g.*
    from public.analysis_graded_decisions(p_filters) g
    where g.spot_key = any (p_keys)
      and (not v_dev or g.grade <> 'perfect')
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

CREATE OR REPLACE FUNCTION public.analysis_trend_scan(p_filters jsonb DEFAULT '{}'::jsonb, p_bucket text DEFAULT 'week'::text, p_group text DEFAULT 'all'::text, p_gap_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner   uuid := auth.uid();
  v_version text := public.analysis_version_of(p_filters);
  v_bucket  text := coalesce(p_bucket, 'week');
  v_group   text := coalesce(p_group, 'all');
  v_minutes integer := least(greatest(coalesce(p_gap_minutes, 30), 5), 720);
  v_gap     interval;
  v_rows    jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_bucket not in ('week', 'month', 'session') then
    raise exception 'Unknown trend bucket: %', v_bucket using errcode = '22023';
  end if;
  if v_group not in ('all', 'street', 'position', 'pot_type') then
    raise exception 'Unknown trend group: %', v_group using errcode = '22023';
  end if;
  v_gap := make_interval(mins => v_minutes);

  with g as materialized (
    select * from public.analysis_graded_decisions(p_filters) where played_at is not null
  ),
  -- Sessions, over every dated hand in scope. Only built when asked for.
  hs as (
    select s.hand_id, h.played_at
    from public.analysis_scope(p_filters) s
    join public.hands h on h.id = s.hand_id and h.owner_id = v_owner
    where v_bucket = 'session' and h.played_at is not null
  ),
  marked as (
    select hs.*,
           case when lag(hs.played_at) over w is null or hs.played_at - lag(hs.played_at) over w > v_gap
                then 1 else 0 end as starts
    from hs
    window w as (order by hs.played_at, hs.hand_id)
  ),
  numbered as (
    select m.hand_id, m.played_at,
           sum(m.starts) over (order by m.played_at, m.hand_id rows unbounded preceding) as session
    from marked m
  ),
  sessions as (
    select n.hand_id, n.session,
           min(n.played_at) over (partition by n.session) as started_at,
           max(n.played_at) over (partition by n.session) as ended_at
    from numbered n
  ),
  b as (
    select g.*,
           case v_bucket
             when 'week'  then date_trunc('week', g.played_at, 'UTC')
             when 'month' then date_trunc('month', g.played_at, 'UTC')
             else ss.started_at
           end as b_start,
           case v_bucket
             when 'week'  then date_trunc('week', g.played_at, 'UTC') + interval '7 days'
             when 'month' then (date_trunc('month', g.played_at, 'UTC') at time zone 'UTC' + interval '1 month') at time zone 'UTC'
             else ss.ended_at
           end as b_end,
           case v_group
             when 'street'   then g.street
             when 'position' then coalesce(g.hero_position, '')
             when 'pot_type' then coalesce(g.pot_type, '')
             else 'all'
           end as key
    from g
    left join sessions ss on ss.hand_id = g.hand_id
  ),
  totals as (
    select b_start, count(distinct hand_id) as bucket_hands
    from b
    group by b_start
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'start',       x.b_start,
           'end',         x.b_end,
           'first',       x.first_at,
           'last',        x.last_at,
           'key',         x.key,
           'bucketHands', t.bucket_hands,
           'hands',       x.hands,
           'graded',      x.n,
           'nonPerfect',  x.non_perfect,
           'mistakes',    x.mistakes,
           'grades', jsonb_build_object(
             'perfect',    x.g_perfect,
             'good',       x.g_good,
             'inaccurate', x.g_inaccurate,
             'mistake',    x.g_mistake,
             'blunder',    x.g_blunder),
           'evLossBb',    x.ev_bb,
           'evLossPot',   x.ev_pot,
           'scoreSum',    x.score_sum,
           'scoreSq',     x.score_sq)
         order by x.b_start, x.key), '[]'::jsonb)
    into v_rows
  from (
    select b.b_start, b.b_end, b.key,
           min(b.played_at) as first_at,
           max(b.played_at) as last_at,
           count(distinct b.hand_id) as hands,
           count(*) as n,
           count(*) filter (where b.grade <> 'perfect') as non_perfect,
           count(*) filter (where public.analysis_grade_rank(b.grade) >= 3) as mistakes,
           count(*) filter (where b.grade = 'perfect') as g_perfect,
           count(*) filter (where b.grade = 'good') as g_good,
           count(*) filter (where b.grade = 'inaccurate') as g_inaccurate,
           count(*) filter (where b.grade = 'mistake') as g_mistake,
           count(*) filter (where b.grade = 'blunder') as g_blunder,
           round(sum(b.ev_loss_bb), 3) as ev_bb,
           round(sum(b.ev_loss_pot), 4) as ev_pot,
           round(coalesce(sum(b.score), 0), 2) as score_sum,
           round(coalesce(sum(b.score * b.score), 0), 2) as score_sq
    from b
    group by b.b_start, b.b_end, b.key
  ) x
  join totals t on t.b_start = x.b_start;

  return jsonb_build_object(
    'analysisVersion', v_version,
    'bucket',          v_bucket,
    'group',           v_group,
    'gapMinutes',      v_minutes,
    'rows',            v_rows,
    'facets',          public.analysis_graded_facets(v_version)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.hands_needing_analysis_recent_scan(p_version text, p_before_played timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, played_at timestamp with time zone, phf jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner  uuid := auth.uid();
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
      where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)
  order by coalesce(hd.played_at, '-infinity'::timestamptz) desc, hd.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$function$;


revoke all on function public.analysis_overview_scan(jsonb) from public, anon;
revoke all on function public.analysis_breakdown_scan(jsonb, text) from public, anon;
revoke all on function public.analysis_node_actions_scan(jsonb) from public, anon;
revoke all on function public.analysis_node_hands_scan(jsonb, text[], text, boolean, text, integer, integer) from public, anon;
revoke all on function public.analysis_leaks_scan(jsonb) from public, anon;
revoke all on function public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer) from public, anon;
revoke all on function public.analysis_trend_scan(jsonb, text, text, integer) from public, anon;
revoke all on function public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.analysis_overview_scan(jsonb) to authenticated;
grant execute on function public.analysis_breakdown_scan(jsonb, text) to authenticated;
grant execute on function public.analysis_node_actions_scan(jsonb) to authenticated;
grant execute on function public.analysis_node_hands_scan(jsonb, text[], text, boolean, text, integer, integer) to authenticated;
grant execute on function public.analysis_leaks_scan(jsonb) to authenticated;
grant execute on function public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer) to authenticated;
grant execute on function public.analysis_trend_scan(jsonb, text, text, integer) to authenticated;
grant execute on function public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The readers
-- ---------------------------------------------------------------------------

-- Which filters a reader's sums or rows hold. "Rows": every filter but the
-- hand-list ones (status, flagged, grade, minimum grade, street, flag).
-- "Sums": the overview's own (format, seat, pot type) as well, no range,
-- room or stake.
create or replace function public.analysis_filter_rows_ok(q public.analysis_filter)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select q.status is null and not q.flagged and q.grade is null and q.min_grade is null and q.street is null
     and q.flag is null;
$$;

create or replace function public.analysis_filter_sums_ok(q public.analysis_filter)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.analysis_filter_rows_ok(q) and q.from_at is null and q.to_at is null and q.site is null
     and q.currency is null and q.big_blind is null;
$$;

revoke all on function public.analysis_filter_rows_ok(public.analysis_filter) from public, anon;
revoke all on function public.analysis_filter_sums_ok(public.analysis_filter) from public, anon;
grant execute on function public.analysis_filter_rows_ok(public.analysis_filter) to authenticated;
grant execute on function public.analysis_filter_sums_ok(public.analysis_filter) to authenticated;

-- ----------------------------------------------------------- overview --

create or replace function public.analysis_overview(p_filters jsonb default '{}'::jsonb)
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
  if not public.analysis_filter_sums_ok(q) then
    return public.analysis_overview_scan(p_filters);
  end if;

  with h as materialized (
    select * from public.analysis_overview_hands t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.format is null or t.game_format = q.format)
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  ),
  d as materialized (
    select * from public.analysis_overview_decisions t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.format is null or t.game_format = q.format)
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  ),
  fl as (
    select * from public.analysis_overview_flags t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (q.format is null or t.game_format = q.format)
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  )
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',           (select coalesce(sum(hands), 0)::bigint from h),
    'status', jsonb_build_object(
      'full',        (select coalesce(sum(hands), 0)::bigint from h where status = 'full'),
      'partial',     (select coalesce(sum(hands), 0)::bigint from h where status = 'partial'),
      'notAnalysed', (select coalesce(sum(hands), 0)::bigint from h where status = 'not-analysed')),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'hands', r.n) order by r.n desc, r.reason)
      from (select nullif(reason, '') as reason, sum(hands)::bigint as n from h where status = 'not-analysed'
            group by 1) r), '[]'::jsonb),
    'skipped', coalesce((
      select jsonb_agg(jsonb_build_object('reason', r.reason, 'decisions', r.n) order by r.n desc, r.reason)
      from (select nullif(reason, '') as reason, sum(decisions)::bigint as n from d where status = 'not-analysed'
            group by 1) r), '[]'::jsonb),
    'decisions',      (select coalesce(sum(decisions), 0)::bigint from d),
    'analysed',       (select coalesce(sum(decisions), 0)::bigint from d where status = 'analysed'),
    'flagged',        (select coalesce(sum(decisions), 0)::bigint from d where worst_flag <> ''),
    'flaggedHands',   (select coalesce(sum(hands), 0)::bigint from h where flagged),
    'flags', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'street', x.street, 'severity', x.severity, 'count', x.n)
                       order by x.n desc, x.code, x.street, x.severity)
      from (select code, street, severity, sum(flags)::bigint as n from fl group by 1, 2, 3) x), '[]'::jsonb),
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
               sum(decisions)::bigint as n,
               coalesce(sum(decisions) filter (where status = 'analysed'), 0)::bigint as analysed,
               coalesce(sum(decisions) filter (where worst_flag <> ''), 0)::bigint as flagged,
               coalesce(sum(facing) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as facing,
               coalesce(sum(defended) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as defended,
               round(sum(mdf_sum) filter (where status = 'analysed' and street <> 'preflop')
                     / nullif(sum(mdf_n) filter (where status = 'analysed' and street <> 'preflop'), 0), 3) as mdf
        from d group by street) x), '[]'::jsonb),
    'grades', coalesce((
      select jsonb_agg(jsonb_build_object('grade', x.grade, 'decisions', x.n)
                       order by public.analysis_grade_rank(x.grade))
      from (select grade, sum(decisions)::bigint as n from d where grade <> '' group by grade) x), '[]'::jsonb),
    'gradesByStreet', coalesce((
      select jsonb_agg(jsonb_build_object('street', x.street, 'grade', x.grade, 'decisions', x.n)
                       order by array_position(array['preflop', 'flop', 'turn', 'river'], x.street),
                                public.analysis_grade_rank(x.grade))
      from (select street, grade, sum(decisions)::bigint as n from d where grade <> '' group by street, grade) x), '[]'::jsonb),
    'graded',      (select coalesce(sum(decisions), 0)::bigint from d where grade <> ''),
    'gradedHands', (select coalesce(sum(hands), 0)::bigint from h where grade <> ''),
    'badHands',    (select coalesce(sum(hands), 0)::bigint from h where public.analysis_grade_rank(grade) >= 4),
    'score',       (select round(sum(score_sum) / nullif(sum(score_n), 0), 2) from d),
    'evLossBb',    (select case when sum(ev_bb_n) > 0 then round(sum(ev_bb_sum), 3) end from d),
    'evLossPot',   (select case when sum(ev_pot_n) > 0 then round(sum(ev_pot_sum), 4) end from d),
    'approximations', coalesce((
      select jsonb_agg(jsonb_build_object('approximation', x.ap, 'hands', x.n) order by x.n desc, x.ap)
      from (select ap, sum(h.hands)::bigint as n from h, unnest(h.approximations) ap group by ap) x), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ---------------------------------------------------------- breakdown --

create or replace function public.analysis_breakdown(p_filters jsonb default '{}'::jsonb, p_group text default 'street')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := auth.uid();
  v_version text;
  q         public.analysis_filter;
  v_kind    text;
  v_rows    jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_group is null or p_group not in ('street', 'position', 'pot_type', 'scenario', 'preflop_scenario') then
    raise exception 'Unknown analysis breakdown: %', coalesce(p_group, 'null') using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_sums_ok(q) then
    return public.analysis_breakdown_scan(p_filters, p_group);
  end if;
  v_version := q.version;
  v_kind := case p_group when 'street' then 'street' when 'scenario' then 'scenario'
                         when 'preflop_scenario' then 'preflop' else 'all' end;

  with d as (
    select case p_group
             when 'street'   then t.street
             when 'position' then nullif(t.hero_position, '')
             when 'pot_type' then nullif(t.pot_type, '')
             else t.scenario
           end as key,
           t.*
    from public.analysis_overview_decisions t
    where t.owner_id = v_owner and t.analysis_version = v_version
      and (p_group <> 'preflop_scenario' or t.street = 'preflop')
      and (q.format is null or t.game_format = q.format)
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
  ),
  k as (
    select case p_group
             when 'position' then nullif(t.hero_position, '')
             when 'pot_type' then nullif(t.pot_type, '')
             else t.key
           end as key,
           sum(t.hands)::bigint as hands, sum(t.graded_hands)::bigint as graded_hands
    from public.analysis_overview_keys t
    where t.owner_id = v_owner and t.analysis_version = v_version and t.kind = v_kind
      and (q.format is null or t.game_format = q.format)
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',         x.key,
           'hands',       coalesce(k.hands, 0),
           'decisions',   x.n,
           'analysed',    x.analysed,
           'flagged',     x.flagged,
           'inaccurate',  x.inaccurate,
           'facingBet',   x.facing,
           'defended',    x.defended,
           'mdf',         x.mdf,
           'graded',      x.graded,
           'gradedHands', coalesce(k.graded_hands, 0),
           'grades', jsonb_build_object(
             'perfect',    x.g_perfect,
             'good',       x.g_good,
             'inaccurate', x.g_inaccurate,
             'mistake',    x.g_mistake,
             'blunder',    x.g_blunder),
           'evLossBb',    x.ev_loss,
           'score',       x.score)
         order by case when p_group = 'street'
                       then array_position(array['preflop', 'flop', 'turn', 'river'], x.key)
                       else null end,
                  x.n desc, x.key), '[]'::jsonb)
    into v_rows
  from (
    select key,
           sum(decisions)::bigint as n,
           coalesce(sum(decisions) filter (where status = 'analysed'), 0)::bigint as analysed,
           coalesce(sum(decisions) filter (where worst_flag <> ''), 0)::bigint as flagged,
           coalesce(sum(decisions) filter (where worst_flag = 'inaccurate'), 0)::bigint as inaccurate,
           coalesce(sum(facing) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as facing,
           coalesce(sum(defended) filter (where status = 'analysed' and street <> 'preflop'), 0)::bigint as defended,
           round(sum(mdf_sum) filter (where status = 'analysed' and street <> 'preflop')
                 / nullif(sum(mdf_n) filter (where status = 'analysed' and street <> 'preflop'), 0), 3) as mdf,
           coalesce(sum(decisions) filter (where grade <> ''), 0)::bigint as graded,
           coalesce(sum(decisions) filter (where grade = 'perfect'), 0)::bigint as g_perfect,
           coalesce(sum(decisions) filter (where grade = 'good'), 0)::bigint as g_good,
           coalesce(sum(decisions) filter (where grade = 'inaccurate'), 0)::bigint as g_inaccurate,
           coalesce(sum(decisions) filter (where grade = 'mistake'), 0)::bigint as g_mistake,
           coalesce(sum(decisions) filter (where grade = 'blunder'), 0)::bigint as g_blunder,
           case when sum(ev_bb_n) filter (where grade <> '') > 0
                then round(sum(ev_bb_sum) filter (where grade <> ''), 3) end as ev_loss,
           round(sum(score_sum) filter (where grade <> '') / nullif(sum(score_n) filter (where grade <> ''), 0), 2) as score
    from d
    group by key
  ) x
  left join k on k.key is not distinct from x.key;

  return jsonb_build_object('group', p_group, 'rows', v_rows);
end;
$$;

-- -------------------------------------------------------------- hands --

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
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'recent');
  q        public.analysis_filter;
  v_street smallint;
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_sort not in ('recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  -- A street the hand has a decision on; one that is none matches nothing.
  v_street := case when q.street is null then null else public.analysis_street_bit(q.street) end;

  -- How many: the overview's hand counts hold every filter but a range, a
  -- room or stake, a street and a flag; the hand rows hold those.
  if q.from_at is null and q.to_at is null and q.site is null and q.currency is null and q.big_blind is null
     and q.street is null and q.flag is null then
    select coalesce(sum(t.hands), 0)::bigint into v_total
    from public.analysis_overview_hands t
    where t.owner_id = v_owner and t.analysis_version = q.version
      and (q.format is null or t.game_format = q.format)
      and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
      and (q.pot_type is null or t.pot_type = q.pot_type)
      and (q.status is null or t.status = q.status)
      and (not q.flagged or t.flagged)
      and (q.grade is null or t.grade = q.grade)
      and (q.min_grade is null or public.analysis_grade_rank(nullif(t.grade, '')) >= public.analysis_grade_rank(q.min_grade));
  else
    select count(*) into v_total
    from public.analysis_hand_rows r
    where r.owner_id = v_owner and r.analysis_version = q.version
      and (q.from_at is null or r.played_at >= q.from_at)
      and (q.to_at is null or r.played_at < q.to_at)
      and (q.site is null or r.site = q.site)
      and (q.format is null or r.game_format = q.format)
      and (q.currency is null or r.currency = q.currency)
      and (q.big_blind is null or r.big_blind = q.big_blind)
      and (q."position" is null or r.hero_position = q."position")
      and (q.pot_type is null or r.pot_type = q.pot_type)
      and (q.status is null or r.status = q.status)
      and (not q.flagged or r.flag_count > 0)
      and (q.grade is null or r.grade = q.grade)
      and (q.min_grade is null or public.analysis_grade_rank(r.grade) >= public.analysis_grade_rank(q.min_grade))
      and (v_street is null or (r.streets & v_street) <> 0)
      and (q.flag is null or q.flag = any (r.flag_codes));
  end if;

  with page as materialized (
    select r.hand_id, r.analysis_version, r.played_at, r.flag_count, r.worst_flag, r.ev_loss_bb, r.ev_loss_pot,
           r.score, r.big_blind, r.hero_profit
    from public.analysis_hand_rows r
    where r.owner_id = v_owner and r.analysis_version = q.version
      and (q.from_at is null or r.played_at >= q.from_at)
      and (q.to_at is null or r.played_at < q.to_at)
      and (q.site is null or r.site = q.site)
      and (q.format is null or r.game_format = q.format)
      and (q.currency is null or r.currency = q.currency)
      and (q.big_blind is null or r.big_blind = q.big_blind)
      and (q."position" is null or r.hero_position = q."position")
      and (q.pot_type is null or r.pot_type = q.pot_type)
      and (q.status is null or r.status = q.status)
      and (not q.flagged or r.flag_count > 0)
      and (q.grade is null or r.grade = q.grade)
      and (q.min_grade is null or public.analysis_grade_rank(r.grade) >= public.analysis_grade_rank(q.min_grade))
      and (v_street is null or (r.streets & v_street) <> 0)
      and (q.flag is null or q.flag = any (r.flag_codes))
    order by
      case when v_sort = 'oldest' then r.played_at end asc nulls last,
      case when v_sort = 'flags' then r.flag_count end desc,
      case when v_sort = 'flags' then r.worst_flag end asc nulls last,
      case when v_sort = 'ev_loss' then r.ev_loss_bb end desc nulls last,
      case when v_sort = 'ev_loss_pot' then r.ev_loss_pot end desc nulls last,
      case when v_sort = 'score' then r.score end asc nulls last,
      case when v_sort = 'result' and r.big_blind > 0 then r.hero_profit::numeric / r.big_blind end asc nulls last,
      r.played_at desc nulls last,
      r.hand_id
    offset v_offset
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
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
                   'evLossBb',    d.ev_loss_bb,
                   'worstFlag',   d.worst_flag) order by d.ord)
          from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb))
      order by
        case when v_sort = 'oldest' then p.played_at end asc nulls last,
        case when v_sort = 'flags' then p.flag_count end desc,
        case when v_sort = 'flags' then p.worst_flag end asc nulls last,
        case when v_sort = 'ev_loss' then p.ev_loss_bb end desc nulls last,
        case when v_sort = 'ev_loss_pot' then p.ev_loss_pot end desc nulls last,
        case when v_sort = 'score' then p.score end asc nulls last,
        case when v_sort = 'result' and p.big_blind > 0 then p.hero_profit::numeric / p.big_blind end asc nulls last,
        p.played_at desc nulls last,
        p.hand_id), '[]'::jsonb)
    into v_rows
  from page p
  join public.hand_analysis a on a.hand_id = p.hand_id and a.analysis_version = p.analysis_version and a.owner_id = v_owner
  join public.hands h on h.id = p.hand_id and h.owner_id = v_owner;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$$;

-- ----------------------------------------------------------- coverage --

create or replace function public.analysis_coverage(p_version text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := auth.uid();
  v_hands    bigint;
  v_at       bigint;
  v_any      bigint;
  v_obsolete bigint;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_coverage needs an analysis_version.' using errcode = '22023';
  end if;

  -- The caller's hands, as library_count() counts them.
  if exists (select 1 from public.library_counts_stale s where s.owner_id = v_owner) then
    select count(*) into v_hands from public.hands h where h.owner_id = v_owner;
  else
    select coalesce(sum(c.hands), 0)::bigint into v_hands from public.library_hand_counts c where c.owner_id = v_owner;
  end if;

  -- At this version; at any version (each hand once); rows at other versions.
  select coalesce(sum(m.hands) filter (where m.analysis_version = p_version), 0)::bigint,
         coalesce(sum(m.hands) filter (where m.analysis_version = ''), 0)::bigint,
         coalesce(sum(m.hands) filter (where m.analysis_version not in ('', p_version)), 0)::bigint
    into v_at, v_any, v_obsolete
  from public.analysis_month_hands m
  where m.owner_id = v_owner;

  return jsonb_build_object(
    'analysisVersion', p_version,
    'hands',           v_hands,
    'atVersion',       v_at,
    'stale',           v_any - v_at,
    'missing',         v_hands - v_any,
    'obsoleteRows',    v_obsolete);
end;
$$;

-- ------------------------------------------- hands_needing_analysis_recent --

-- The previous walk, but only through the months that still miss a hand:
-- the library's hands per UTC month against the analysed ones at this
-- version. Each month's hands are walked as before (the same order, cursor
-- and test), newest month first; a month whose hands are all analysed has
-- nothing to give.
create or replace function public.hands_needing_analysis_recent(
  p_version       text,
  p_before_played timestamptz default null,
  p_before_id     uuid default null,
  p_limit         integer default 100
)
returns table (id uuid, played_at timestamptz, phf jsonb)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_owner  uuid := auth.uid();
  v_before timestamptz := coalesce(p_before_played, '-infinity'::timestamptz);
  v_left   integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_from   date;
  v_month  date;
  v_n      integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis_recent needs an analysis_version.' using errcode = '22023';
  end if;
  -- Counts that cannot be trusted: the previous walk over every hand.
  if exists (select 1 from public.library_counts_stale s where s.owner_id = v_owner) then
    return query select * from public.hands_needing_analysis_recent_scan(p_version, p_before_played, p_before_id, p_limit);
    return;
  end if;

  -- The cursor's month: later months are behind it.
  v_from := case when p_before_id is null then null
                 when v_before = '-infinity'::timestamptz then '-infinity'::date
                 else public.analysis_month_of(v_before) end;

  for v_month in
    select c.month
    from (select l.month, sum(l.hands) as hands from public.library_hand_counts l
          where l.owner_id = v_owner group by l.month) c
    left join public.analysis_month_hands a
      on a.owner_id = v_owner and a.analysis_version = p_version and a.month = c.month
    where c.hands > coalesce(a.hands, 0)
      and (v_from is null or c.month <= v_from)
    order by c.month desc
  loop
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
      and (case when v_month = '-infinity'::date then hd.played_at is null
                else hd.played_at >= (v_month::timestamp at time zone 'UTC')
                     and hd.played_at < ((v_month + interval '1 month')::timestamp at time zone 'UTC') end)
      and (p_before_id is null
           or (coalesce(hd.played_at, '-infinity'::timestamptz), hd.id) < (v_before, p_before_id))
      and not exists (
        select 1 from public.hand_analysis a
        where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)
    order by coalesce(hd.played_at, '-infinity'::timestamptz) desc, hd.id desc
    limit v_left;
    get diagnostics v_n = row_count;
    v_left := v_left - v_n;
    exit when v_left <= 0;
  end loop;
end;
$$;

-- ------------------------------------------------------ graded facets --

-- The reports' room and stake chips (hands with a graded decision at the
-- version, unfiltered) and their first and last time.
create or replace function public.analysis_graded_facets(p_version text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
begin
  return (
    with f as materialized (
      select * from public.analysis_graded_sites s
      where s.owner_id = v_owner and s.analysis_version = p_version
    )
    select jsonb_build_object(
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object('site', x.site, 'hands', x.n) order by x.n desc, x.site)
        from (select site, sum(graded_hands)::bigint as n from f group by site) x), '[]'::jsonb),
      'stakes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n)
               order by x.n desc, x.currency, x.big_blind)
        from (
          select currency, currency_minor_units, small_blind, big_blind, sum(graded_hands)::bigint as n
          from f
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'first', (select min(r.played_at) from public.analysis_hand_rows r
                where r.owner_id = v_owner and r.analysis_version = p_version and r.graded > 0),
      'last',  (select max(r.played_at) from public.analysis_hand_rows r
                where r.owner_id = v_owner and r.analysis_version = p_version and r.graded > 0)));
end;
$$;

-- -------------------------------------------------------------- leaks --

-- The leak finder's rows. All time with the overview's filters (format,
-- seat, pot type): the totals. A range, a room or a stake: the leak rows in
-- scope, summed as the finder sums them.
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
    elsif q.from_at is null and q.to_at is null and q.format is null and q."position" is null and q.pot_type is null then
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
      select z.hand_id, z.spot_key, z.chart_set, z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where v_mode in ('rows', 'complement')
        and z.owner_id = v_owner and z.analysis_version = v_version and z.grade is not null
        and (q.site is null or z.site = q.site)
        and (q.format is null or z.game_format = q.format)
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
    s as (
      select t.spot_key, t.chart_set, t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_totals t
      where v_mode in ('totals', 'complement')
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.format is null or t.game_format = q.format)
        and (q."position" is null or (q."position" <> '' and t.hero_position = q."position"))
        and (q.pot_type is null or t.pot_type = q.pot_type)
      union all
      select t.spot_key, t.chart_set, t.decisions, t.hands, t.non_perfect, t.mistakes, t.ev_loss_bb, t.ev_loss_pot,
             t.score_sum, t.score_sq
      from public.analysis_leak_stake_totals t
      where v_mode = 'stakes'
        and t.owner_id = v_owner and t.analysis_version = v_version
        and (q.site is null or t.site = q.site)
        and (q.currency is null or t.currency = q.currency)
        and (q.big_blind is null or t.big_blind = q.big_blind)
      union all
      select g.spot_key, g.chart_set, count(*), count(distinct g.hand_id),
             count(*) filter (where g.grade <> 'perfect'),
             count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             sum(g.ev_loss_bb), sum(g.ev_loss_pot), coalesce(sum(g.score), 0), coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'rows'
      group by 1, 2
      union all
      select g.spot_key, g.chart_set, -count(*), -count(distinct g.hand_id),
             -count(*) filter (where g.grade <> 'perfect'),
             -count(*) filter (where g.grade in ('inaccurate', 'mistake', 'blunder')),
             -sum(g.ev_loss_bb), -sum(g.ev_loss_pot), -coalesce(sum(g.score), 0), -coalesce(sum(g.score * g.score), 0)
      from g
      where v_mode = 'complement'
      group by 1, 2
    ),
    x as materialized (
      select spot_key, chart_set, sum(decisions)::bigint as n, sum(hands)::bigint as hands,
             sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum, sum(score_sq) as score_sq
      from s
      group by spot_key, chart_set
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
                     and (q.format is null or k.game_format = q.format)
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
                   and (q.format is null or r.game_format = q.format)
                   and (q.currency is null or r.currency = q.currency)
                   and (q.big_blind is null or r.big_blind = q.big_blind)
                   and (q."position" is null or r.hero_position = q."position")
                   and (q.pot_type is null or r.pot_type = q.pot_type)),
      'last',   (select max(r.played_at) from public.analysis_hand_rows r
                 where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
                   and (q.from_at is null or r.played_at >= q.from_at)
                   and (q.to_at is null or r.played_at < q.to_at)
                   and (q.site is null or r.site = q.site)
                   and (q.format is null or r.game_format = q.format)
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
               order by x.spot_key, nullif(x.chart_set, '') nulls first)
        from x), '[]'::jsonb),
      'facets', public.analysis_graded_facets(v_version))
    into v_out;
  end;

  return v_out;
end;
$$;

-- ------------------------------------------------- R5.2's top three --

-- One sample of the leak sums, as analysis_leaks returns its rows: all time
-- from the totals, a window of days (inclusive; either open) from the leak
-- rows. R5.2's contract (the owner must be the caller; per row `hands` is
-- the decisions).
create or replace function public.analysis_leak_sample(
  p_owner uuid, p_version text, p_format text, p_position text, p_pot text, p_from date, p_to date)
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
            and (p_format is null or k.game_format = p_format)
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
                order by x.spot_key, nullif(x.chart_set, '') nulls first), '[]'::jsonb))
      from (
        select spot_key, chart_set,
               sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
               sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum,
               sum(score_sq) as score_sq
        from public.analysis_leak_totals
        where owner_id = v_owner and analysis_version = p_version
          and (p_format is null or game_format = p_format)
          and (p_position is null or hero_position = p_position)
          and (p_pot is null or pot_type = p_pot)
        group by spot_key, chart_set
      ) x);
  end if;

  return (
    with g as materialized (
      select z.hand_id, z.spot_key, z.chart_set, z.grade, z.score, z.ev_loss_bb, z.ev_loss_pot
      from public.analysis_leak_rows z
      where z.owner_id = v_owner and z.analysis_version = p_version and z.grade is not null
        and (p_from is null or z.day >= p_from) and (p_to is null or z.day <= p_to)
        -- the same days as times, so the window is read by the time index (a
        -- day from p_from on has a time; a day up to p_to may have none)
        and (p_from is null or z.played_at >= (p_from::timestamp at time zone 'UTC'))
        and (p_to is null or z.played_at < ((p_to + 1)::timestamp at time zone 'UTC')
             or (p_from is null and z.played_at is null))
        and (p_format is null or z.game_format = p_format)
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
              order by x.spot_key, nullif(x.chart_set, '') nulls first), '[]'::jsonb))
    from (
      select spot_key, chart_set, count(*) as n,
             count(*) filter (where grade <> 'perfect') as non_perfect,
             count(*) filter (where grade in ('inaccurate', 'mistake', 'blunder')) as mistakes,
             sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot,
             coalesce(sum(score), 0) as score_sum, coalesce(sum(score * score), 0) as score_sq
      from g
      group by spot_key, chart_set
    ) x);
end;
$$;

create or replace function public.analysis_top_leaks(p_filters jsonb default '{}'::jsonb, p_period text default '30d')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := auth.uid();
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

  -- The day of the last graded hand in scope (the hand rows' graded count).
  select (max(r.played_at) at time zone 'UTC')::date into v_last
  from public.analysis_hand_rows r
  where r.owner_id = v_owner and r.analysis_version = v_version and r.graded > 0
    and (v_format is null or r.game_format = v_format)
    and (v_position is null or r.hero_position = v_position)
    and (v_pot is null or r.pot_type = v_pot);

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

-- --------------------------------------------------------- leak hands --

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
      and (q.format is null or z.game_format = q.format)
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
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

-- --------------------------------------------------------- chart nodes --

create or replace function public.analysis_node_actions(p_filters jsonb default '{}'::jsonb)
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
  v_facets  jsonb;
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_node_actions_scan(p_filters);
  end if;

  -- The facets: the caller's hands with a graded preflop chart decision at
  -- this version, unfiltered.
  with s as materialized (
    select * from public.analysis_graded_sites t
    where t.owner_id = v_owner and t.analysis_version = v_version and t.chart_hands > 0
  )
  select jsonb_build_object(
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object('site', x.site, 'hands', x.n) order by x.n desc, x.site)
        from (select site, sum(chart_hands)::bigint as n from s group by site) x), '[]'::jsonb),
      'stakes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n)
               order by x.n desc, x.currency, x.big_blind)
        from (
          select currency, currency_minor_units, small_blind, big_blind, sum(chart_hands)::bigint as n
          from s
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'first', (select min(r.played_at) from public.analysis_hand_rows r
                where r.owner_id = v_owner and r.analysis_version = v_version and r.chart_graded > 0),
      'last',  (select max(r.played_at) from public.analysis_hand_rows r
                where r.owner_id = v_owner and r.analysis_version = v_version and r.chart_graded > 0))
    into v_facets;

  if q.from_at is null and q.to_at is null and q.site is null and q.format is null and q.currency is null
     and q.big_blind is null and q."position" is null and q.pot_type is null then
    -- Everything: the totals.
    with t as materialized (
      select * from public.analysis_node_totals t
      where t.owner_id = v_owner and t.analysis_version = v_version
    )
    select jsonb_build_object(
      'analysisVersion', v_version,
      'hands',     (select coalesce(sum(s.node_hands), 0)::bigint from public.analysis_graded_sites s
                    where s.owner_id = v_owner and s.analysis_version = v_version),
      'decisions', (select coalesce(sum(decisions), 0)::bigint from t where street = 'preflop'),
      'actions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'set',        x.node_set,
                 'line',       x.line,
                 'scenario',   x.scenario,
                 'action',     x.action,
                 'decisions',  x.n,
                 'deviations', x.dev,
                 'evLossBb',   x.ev)
               order by x.node_set, x.line, x.action, x.scenario)
        from (
          select node_set, line, scenario, action, sum(decisions)::bigint as n, sum(deviations)::bigint as dev,
                 round(coalesce(sum(ev_loss_bb), 0), 3) as ev
          from t
          where street = 'preflop'
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'classes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'set',       x.node_set,
                 'line',      x.line,
                 'handClass', x.hand_class,
                 'action',    x.action,
                 'decisions', x.n)
               order by x.node_set, x.line, x.hand_class, x.action)
        from (
          select node_set, line, hand_class, action, sum(decisions)::bigint as n
          from t
          where street = 'preflop' and hand_class is not null
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'postflop', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'street',    x.street,
                 'scenario',  x.scenario,
                 'action',    x.action,
                 'decisions', x.n)
               order by array_position(array['flop', 'turn', 'river'], x.street), x.scenario, x.action)
        from (select street, scenario, action, sum(decisions)::bigint as n from t where street <> 'preflop'
              group by 1, 2, 3) x), '[]'::jsonb),
      'facets', v_facets)
    into v_out;
    return v_out;
  end if;

  -- A range, a room, a stake, a seat, a format or a pot type: the leak rows in scope.
  with z as materialized (
    select z.hand_id, z.street, z.status, z.spot_key, z.grade, z.ev_loss_bb, z.node_set, z.node_line,
           z.node_scenario, z.hand_class, z.chosen_action
    from public.analysis_leak_rows z
    where z.owner_id = v_owner and z.analysis_version = v_version
      and ((z.node_line is not null and z.chosen_action is not null) or (z.street <> 'preflop' and z.status = 'analysed'))
      and (q.from_at is null or z.played_at >= q.from_at)
      and (q.to_at is null or z.played_at < q.to_at)
      and (q.site is null or z.site = q.site)
      and (q.format is null or z.game_format = q.format)
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
  ),
  g as (select * from z where node_line is not null and chosen_action is not null),
  p as (select street, split_part(spot_key, '|', 2) as scenario, split_part(spot_key, '|', 5) as action
        from z where street <> 'preflop')
  select jsonb_build_object(
    'analysisVersion', v_version,
    'hands',     (select count(distinct hand_id) from g),
    'decisions', (select count(*) from g),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',        x.node_set,
               'line',       x.node_line,
               'scenario',   x.node_scenario,
               'action',     x.chosen_action,
               'decisions',  x.n,
               'deviations', x.dev,
               'evLossBb',   x.ev)
             order by x.node_set, x.node_line, x.chosen_action, x.node_scenario)
      from (
        select node_set, node_line, node_scenario, chosen_action,
               count(*) as n,
               count(*) filter (where grade <> 'perfect') as dev,
               round(coalesce(sum(ev_loss_bb), 0), 3) as ev
        from g
        group by 1, 2, 3, 4
      ) x), '[]'::jsonb),
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set',       x.node_set,
               'line',      x.node_line,
               'handClass', x.hand_class,
               'action',    x.chosen_action,
               'decisions', x.n)
             order by x.node_set, x.node_line, x.hand_class, x.chosen_action)
      from (
        select node_set, node_line, hand_class, chosen_action, count(*) as n
        from g
        where hand_class is not null
        group by 1, 2, 3, 4
      ) x), '[]'::jsonb),
    'postflop', coalesce((
      select jsonb_agg(jsonb_build_object(
               'street',    x.street,
               'scenario',  x.scenario,
               'action',    x.action,
               'decisions', x.n)
             order by array_position(array['flop', 'turn', 'river'], x.street), x.scenario, x.action)
      from (select street, scenario, action, count(*) as n from p group by 1, 2, 3) x), '[]'::jsonb),
    'facets', v_facets)
  into v_out;

  return v_out;
end;
$$;

create or replace function public.analysis_node_hands(
  p_filters    jsonb   default '{}'::jsonb,
  p_nodes      text[]  default null,
  p_action     text    default null,
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
  q        public.analysis_filter;
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_nodes is null or cardinality(p_nodes) = 0 or cardinality(p_nodes) > 200 then
    raise exception 'analysis_node_hands needs between 1 and 200 chart nodes.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_nodes) k where k is null or k !~ '^[a-z0-9][a-z0-9-]{0,63}:[fkcra]{0,24}$') then
    raise exception 'Not a chart node key.' using errcode = '22023';
  end if;
  if p_action is not null and p_action not in ('fold', 'check', 'call', 'raise', 'allin') then
    raise exception 'Unknown chart action: %', p_action using errcode = '22023';
  end if;
  if v_sort not in ('ev_loss', 'ev_loss_pot', 'recent', 'oldest') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_node_hands_scan(p_filters, p_nodes, p_action, p_deviations, p_sort, p_limit, p_offset);
  end if;

  -- A key is "set:line" with no other colon: its set and line.
  with m as materialized (
    select z.hand_id, z.ord, z.played_at,
           case when z.ev_bb_null then null else z.ev_loss_bb end as ev_loss_bb,
           case when z.ev_pot_null then null else z.ev_loss_pot end as ev_loss_pot,
           z.chosen_action
    from (select distinct split_part(k, ':', 1) as s, split_part(k, ':', 2) as l from unnest(p_nodes) k) keys
    join public.analysis_leak_rows z
      on z.owner_id = v_owner and z.analysis_version = q.version and z.node_set = keys.s and z.node_line = keys.l
    where z.node_line is not null
      and (p_action is null or z.chosen_action = p_action)
      and (not v_dev or z.grade <> 'perfect')
      and (q.from_at is null or z.played_at >= q.from_at)
      and (q.to_at is null or z.played_at < q.to_at)
      and (q.site is null or z.site = q.site)
      and (q.format is null or z.game_format = q.format)
      and (q.currency is null or z.currency = q.currency)
      and (q.big_blind is null or z.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and z.hero_position = q."position"))
      and (q.pot_type is null or z.pot_type = q.pot_type)
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
                    'actionIndex', dd.action_index,
                    'playedAt',    h.played_at,
                    'site',        h.site,
                    'stakesLabel', h.stakes_label,
                    'position',    h.hero_position,
                    'heroCards',   to_jsonb(h.hero_cards),
                    'handClass',   dd.facts ->> 'handClass',
                    'set',         dd.facts -> 'chart' ->> 'set',
                    'line',        dd.facts -> 'chart' ->> 'line',
                    'scenario',    dd.facts -> 'chart' ->> 'scenario',
                    'inRange',     dd.facts -> 'chart' -> 'inRange',
                    'action',      p.chosen_action,
                    'grade',       dd.grade,
                    'evLossBb',    dd.ev_loss_bb,
                    'evLossPot',   dd.ev_loss_pot,
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

-- -------------------------------------------------------------- trend --

-- Weeks and months over everything (or whole UTC days of it): the day sums.
-- A room, a stake, a seat, a format, a pot type, or a range cut inside a
-- day: the hand rows (each hand's graded decisions summed; the street group
-- reads the leak rows). Sessions: the hand rows in scope in time order.
create or replace function public.analysis_trend(
  p_filters     jsonb   default '{}'::jsonb,
  p_bucket      text    default 'week',
  p_group       text    default 'all',
  p_gap_minutes integer default 30
)
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
  v_bucket  text := coalesce(p_bucket, 'week');
  v_group   text := coalesce(p_group, 'all');
  v_minutes integer := least(greatest(coalesce(p_gap_minutes, 30), 5), 720);
  v_gap     interval;
  q         public.analysis_filter;
  v_days    boolean;
  v_rows    jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_bucket not in ('week', 'month', 'session') then
    raise exception 'Unknown trend bucket: %', v_bucket using errcode = '22023';
  end if;
  if v_group not in ('all', 'street', 'position', 'pot_type') then
    raise exception 'Unknown trend group: %', v_group using errcode = '22023';
  end if;
  v_gap := make_interval(mins => v_minutes);
  q := public.analysis_filter_of(p_filters);
  if not public.analysis_filter_rows_ok(q) then
    return public.analysis_trend_scan(p_filters, p_bucket, p_group, p_gap_minutes);
  end if;

  v_days := v_bucket <> 'session'
    and q.site is null and q.format is null and q.currency is null and q.big_blind is null
    and q."position" is null and q.pot_type is null
    and (q.from_at is null or q.from_at = date_trunc('day', q.from_at, 'UTC'))
    and (q.to_at is null or q.to_at = date_trunc('day', q.to_at, 'UTC'));

  if v_days then
    with t as materialized (
      select t.*,
             case v_bucket when 'week' then date_trunc('week', t.day::timestamp) at time zone 'UTC'
                           else date_trunc('month', t.day::timestamp) at time zone 'UTC' end as b_start
      from public.analysis_trend_days t
      where t.owner_id = v_owner and t.analysis_version = v_version
        and t.grp in (v_group, 'all')
        and (q.from_at is null or t.day >= (q.from_at at time zone 'UTC')::date)
        and (q.to_at is null or t.day < (q.to_at at time zone 'UTC')::date)
    ),
    totals as (
      select b_start, sum(hands)::bigint as bucket_hands from t where grp = 'all' group by b_start
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'start',       x.b_start,
             'end',         case v_bucket when 'week' then x.b_start + interval '7 days'
                                 else (x.b_start at time zone 'UTC' + interval '1 month') at time zone 'UTC' end,
             'first',       x.first_at,
             'last',        x.last_at,
             'key',         x.key,
             'bucketHands', tt.bucket_hands,
             'hands',       x.hands,
             'graded',      x.n,
             'nonPerfect',  x.non_perfect,
             'mistakes',    x.mistakes,
             'grades', jsonb_build_object(
               'perfect',    x.n - x.non_perfect,
               'good',       x.non_perfect - x.mistakes,
               'inaccurate', x.mistakes - x.g_mistake - x.g_blunder,
               'mistake',    x.g_mistake,
               'blunder',    x.g_blunder),
             'evLossBb',    x.ev_bb,
             'evLossPot',   x.ev_pot,
             'scoreSum',    x.score_sum,
             'scoreSq',     x.score_sq)
           order by x.b_start, x.key), '[]'::jsonb)
      into v_rows
    from (
      select b_start, case when v_group = 'all' then 'all' else key end as key,
             min(first_at) as first_at, max(last_at) as last_at,
             sum(hands)::bigint as hands, sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect,
             sum(mistakes)::bigint as mistakes, sum(g_mistake)::bigint as g_mistake, sum(g_blunder)::bigint as g_blunder,
             round(sum(ev_loss_bb), 3) as ev_bb, round(sum(ev_loss_pot), 4) as ev_pot,
             round(sum(score_sum), 2) as score_sum, round(sum(score_sq), 2) as score_sq
      from t
      where grp = v_group
      group by 1, 2
    ) x
    join totals tt on tt.b_start = x.b_start;
  elsif v_bucket = 'session' then
    -- Sessions over every dated hand row in scope (graded or not), in time
    -- order: a hand starts one when the gap to the one before exceeds the
    -- gap asked. Hands at the same time share a session whatever their
    -- order (the running sum takes all of them at once). Then each session's
    -- graded hands are summed per key: from the hand rows (all, position,
    -- pot type) or from their graded leak rows (street).
    with n as materialized (
      select s.*, sum(s.starts) over (order by s.played_at) as session
      from (
        select r.hand_id, r.played_at, coalesce(r.hero_position, '') as hero_position,
               coalesce(r.pot_type, '') as pot_type, r.graded, r.g_non_perfect, r.g_mistakes, r.g_mistake,
               r.g_blunder, r.g_ev_bb, r.g_ev_pot, r.g_score_sum, r.g_score_sq,
               case when lag(r.played_at) over w is null or r.played_at - lag(r.played_at) over w > v_gap
                    then 1 else 0 end as starts
        from public.analysis_hand_rows r
        where r.owner_id = v_owner and r.analysis_version = v_version and r.played_at is not null
          and (q.from_at is null or r.played_at >= q.from_at)
          and (q.to_at is null or r.played_at < q.to_at)
          and (q.site is null or r.site = q.site)
          and (q.format is null or r.game_format = q.format)
          and (q.currency is null or r.currency = q.currency)
          and (q.big_blind is null or r.big_blind = q.big_blind)
          and (q."position" is null or r.hero_position = q."position")
          and (q.pot_type is null or r.pot_type = q.pot_type)
        window w as (order by r.played_at)
      ) s
    ),
    sess as (
      select session, min(played_at) as started_at, max(played_at) as ended_at,
             count(*) filter (where graded > 0) as bucket_hands
      from n
      group by session
    ),
    x as (
      select n.session,
             case v_group when 'position' then n.hero_position when 'pot_type' then n.pot_type else 'all' end as key,
             min(n.played_at) as first_at, max(n.played_at) as last_at, count(*) as hands,
             sum(n.graded)::bigint as n, sum(n.g_non_perfect)::bigint as non_perfect,
             sum(n.g_mistakes)::bigint as mistakes, sum(n.g_mistake)::bigint as g_mistake,
             sum(n.g_blunder)::bigint as g_blunder,
             round(sum(n.g_ev_bb), 3) as ev_bb, round(sum(n.g_ev_pot), 4) as ev_pot,
             round(sum(n.g_score_sum), 2) as score_sum, round(sum(n.g_score_sq), 2) as score_sq
      from n
      where n.graded > 0 and v_group <> 'street'
      group by 1, 2
      union all
      select n.session, z.street, min(n.played_at), max(n.played_at), count(distinct n.hand_id),
             count(*), count(*) filter (where z.grade <> 'perfect'),
             count(*) filter (where z.grade in ('inaccurate', 'mistake', 'blunder')),
             count(*) filter (where z.grade = 'mistake'), count(*) filter (where z.grade = 'blunder'),
             round(sum(z.ev_loss_bb), 3), round(sum(z.ev_loss_pot), 4),
             round(coalesce(sum(z.score), 0), 2), round(coalesce(sum(z.score * z.score), 0), 2)
      from n
      join public.analysis_leak_rows z
        on z.hand_id = n.hand_id and z.analysis_version = v_version and z.owner_id = v_owner and z.grade is not null
      where n.graded > 0 and v_group = 'street'
      group by 1, 2
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'start',       ss.started_at,
             'end',         ss.ended_at,
             'first',       x.first_at,
             'last',        x.last_at,
             'key',         x.key,
             'bucketHands', ss.bucket_hands,
             'hands',       x.hands,
             'graded',      x.n,
             'nonPerfect',  x.non_perfect,
             'mistakes',    x.mistakes,
             'grades', jsonb_build_object(
               'perfect',    x.n - x.non_perfect,
               'good',       x.non_perfect - x.mistakes,
               'inaccurate', x.mistakes - x.g_mistake - x.g_blunder,
               'mistake',    x.g_mistake,
               'blunder',    x.g_blunder),
             'evLossBb',    x.ev_bb,
             'evLossPot',   x.ev_pot,
             'scoreSum',    x.score_sum,
             'scoreSq',     x.score_sq)
           order by ss.started_at, x.key), '[]'::jsonb)
      into v_rows
    from x
    join sess ss on ss.session = x.session;
  else
    -- Weeks or months under a room, a stake, a seat, a format, a pot type or
    -- a range cut inside a day: the graded hand rows in scope.
    with b as materialized (
      select r.hand_id, r.played_at, coalesce(r.hero_position, '') as hero_position,
             coalesce(r.pot_type, '') as pot_type, r.graded, r.g_non_perfect, r.g_mistakes, r.g_mistake,
             r.g_blunder, r.g_ev_bb, r.g_ev_pot, r.g_score_sum, r.g_score_sq,
             case v_bucket when 'week' then date_trunc('week', r.played_at, 'UTC')
                           else date_trunc('month', r.played_at, 'UTC') end as b_start,
             case v_bucket when 'week' then date_trunc('week', r.played_at, 'UTC') + interval '7 days'
                           else (date_trunc('month', r.played_at, 'UTC') at time zone 'UTC' + interval '1 month') at time zone 'UTC'
             end as b_end
      from public.analysis_hand_rows r
      where r.owner_id = v_owner and r.analysis_version = v_version and r.played_at is not null and r.graded > 0
        and (q.from_at is null or r.played_at >= q.from_at)
        and (q.to_at is null or r.played_at < q.to_at)
        and (q.site is null or r.site = q.site)
        and (q.format is null or r.game_format = q.format)
        and (q.currency is null or r.currency = q.currency)
        and (q.big_blind is null or r.big_blind = q.big_blind)
        and (q."position" is null or r.hero_position = q."position")
        and (q.pot_type is null or r.pot_type = q.pot_type)
    ),
    totals as (
      select b_start, count(*) as bucket_hands from b group by b_start
    ),
    -- Per bucket and key: from the hands (all, position, pot type) or from
    -- their graded leak rows (street).
    x as (
      select b.b_start, b.b_end,
             case v_group when 'position' then b.hero_position when 'pot_type' then b.pot_type else 'all' end as key,
             min(b.played_at) as first_at, max(b.played_at) as last_at, count(*) as hands,
             sum(b.graded)::bigint as n, sum(b.g_non_perfect)::bigint as non_perfect,
             sum(b.g_mistakes)::bigint as mistakes, sum(b.g_mistake)::bigint as g_mistake,
             sum(b.g_blunder)::bigint as g_blunder,
             round(sum(b.g_ev_bb), 3) as ev_bb, round(sum(b.g_ev_pot), 4) as ev_pot,
             round(sum(b.g_score_sum), 2) as score_sum, round(sum(b.g_score_sq), 2) as score_sq
      from b
      where v_group <> 'street'
      group by 1, 2, 3
      union all
      select b.b_start, b.b_end, z.street, min(b.played_at), max(b.played_at), count(distinct b.hand_id),
             count(*), count(*) filter (where z.grade <> 'perfect'),
             count(*) filter (where z.grade in ('inaccurate', 'mistake', 'blunder')),
             count(*) filter (where z.grade = 'mistake'), count(*) filter (where z.grade = 'blunder'),
             round(sum(z.ev_loss_bb), 3), round(sum(z.ev_loss_pot), 4),
             round(coalesce(sum(z.score), 0), 2), round(coalesce(sum(z.score * z.score), 0), 2)
      from b
      join public.analysis_leak_rows z
        on z.hand_id = b.hand_id and z.analysis_version = v_version and z.owner_id = v_owner and z.grade is not null
      where v_group = 'street'
      group by 1, 2, 3
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'start',       x.b_start,
             'end',         x.b_end,
             'first',       x.first_at,
             'last',        x.last_at,
             'key',         x.key,
             'bucketHands', t.bucket_hands,
             'hands',       x.hands,
             'graded',      x.n,
             'nonPerfect',  x.non_perfect,
             'mistakes',    x.mistakes,
             'grades', jsonb_build_object(
               'perfect',    x.n - x.non_perfect,
               'good',       x.non_perfect - x.mistakes,
               'inaccurate', x.mistakes - x.g_mistake - x.g_blunder,
               'mistake',    x.g_mistake,
               'blunder',    x.g_blunder),
             'evLossBb',    x.ev_bb,
             'evLossPot',   x.ev_pot,
             'scoreSum',    x.score_sum,
             'scoreSq',     x.score_sq)
           order by x.b_start, x.key), '[]'::jsonb)
      into v_rows
    from x
    join totals t on t.b_start = x.b_start;
  end if;

  return jsonb_build_object(
    'analysisVersion', v_version,
    'bucket',          v_bucket,
    'group',           v_group,
    'gapMinutes',      v_minutes,
    'rows',            v_rows,
    'facets',          public.analysis_graded_facets(v_version)
  );
end;
$$;

-- ------------------------------------------------------- drill by spot --

create or replace function public.drill_due_by_spot(p_version text, p_until timestamptz default null)
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
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    group by di.spot_key
  ),
  -- Mistakes and blunders at this version not drilled yet: the totals' per
  -- spot, less those a drill item (by hand and action) already holds.
  fresh as (
    select spot_key, sum(items)::bigint as items
    from (
      select t.spot_key, sum(t.g_mistake + t.g_blunder) as items
      from public.analysis_leak_totals t
      where t.owner_id = v_owner and t.analysis_version = p_version
      group by t.spot_key
      union all
      select z.spot_key, -count(*)
      from public.drill_items x
      join public.analysis_leak_rows z
        on z.hand_id = x.hand_id and z.analysis_version = p_version and z.action_index = x.action_index
       and z.owner_id = v_owner
      where x.owner_id = v_owner and z.grade in ('mistake', 'blunder')
      group by z.spot_key
    ) u
    group by spot_key
    having sum(items) > 0
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
