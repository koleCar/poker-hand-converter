-- ============================================================================
-- The web's report summaries (docs/RAIL-PLAN.md R4.5c-1).
-- ============================================================================
--
-- R2.9 measured the web's reports over one account's 1 000 000 hands on a
-- local stack: `stats_summary`, `stats_graph`, each `stats_breakdown` and
-- `stats_sessions` 5-10 s, `stats_opponents` 22-44 s (measured again for this
-- step: 3.3-6.5 s, 4.3-4.8 s, 3.6-6.3 s, 4.0-6.3 s, 21-41 s; and
-- `stats_coverage`, which opens the screen, 10-11 s). Every one of them reads
-- the account's `hand_stats` heap (the hero's rows with the villains'
-- interleaved) because nothing summarises it. The shared Reports screen
-- (R4.5c-2) asks for a summary, a graph, five breakdowns and the filter's
-- counts on every filter change, and the shared Players screen (R4.5c-3) for
-- a list of opponents, so R2.9's recommendation is built first:
--
--   1. `hero_rollups` - the hero's rows summed per (owner, statistics
--      version, UTC day, segment, position, kind), every counter and money
--      column and the result of the hands that reached showdown: the desktop
--      store's `hero_rollups` (core/rail-store/SCHEMA.md). The segment is the
--      store's: room, format, variant, limit, table size class (`hu` / `6max`
--      / `full`), currency, minor units, blinds and the stake they make
--      (`USD:200`, `chips`). `kind` keeps apart what the reports' options
--      decide on (bomb pot 1, straddled 2, EV cashout 4), so every option is
--      a sum over rows, as on the desktop. A report sums whole days from it
--      and reads the partial days at a range's two ends from the hero's rows
--      (`hand_stats_hero_idx`), so any range of instants is exact.
--   2. `hero_report_rows` - one narrow row per hero row (the segment's
--      derived values, the result, the situation, the breakdown columns'
--      counters) with `hero_report_rows_time_idx` covering what the graph and
--      the sessions read in time order: for what a day's sum cannot answer -
--      the sessions (gaps between hands), the breakdowns by situation (pot
--      type, stack, starting hand, players, street) and the days the graph
--      cuts inside. (A covering index on `hand_stats` itself does not fit: an
--      index takes 32 columns, the situations alone need 36.)
--   3. `player_stats` - the opponents' rows (opt-in villain rows) summed per
--      (owner, version, room, player, segment), the counters
--      `stats_opponents` shows, and the hero's result in the same hands.
--      Opaque-id rooms are summed under the name '' (a session token is not
--      a person: counted, never listed); bomb pots are left out, as
--      `stats_opponents` and the desktop's `player_rollups` leave them.
--
-- And `hand_stats_ev_owner_idx` for an account's EV rows (the all-in EV
-- adjustment, the count of hands still waiting for theirs).
--
-- ## How the summaries stay right
--
-- Statement triggers on `hand_stats`, in the writing statement's own
-- transaction: AFTER INSERT adds the statement's rows (`inserted`) to the
-- three tables, AFTER DELETE subtracts them (`deleted`) and removes a
-- summary row that reaches no hands. Every write path goes through them with
-- nothing to call:
--
--   * `save_hand_stats` - the rebuild route (`/api/stats/rebuild`), the
--     browser's own save after an upload, the desktop's hands derived by the
--     same route (`ingest_hands` writes no statistics rows);
--   * deletes - a hand's rows with the hand (`hand_stats.hand_id` cascades;
--     an account's with the account), `prune_hand_stats` (older versions,
--     run at the end of every rebuild), `prune_villain_stats` (opponent
--     statistics switched off);
--   * a statistics version bump: the new version's rows are new keys; the
--     old version's summaries go with its rows when they are pruned;
--   * the per-account insert budget (#235): it raises in the same
--     statement's AFTER trigger, so the statement and the summaries' change
--     roll back together.
--
-- Nothing updates `hand_stats` (there is no grant and no function that
-- does); an UPDATE as `postgres` counts its owners again, and a TRUNCATE
-- empties the three.
--
-- Why triggers and not a refresh the rebuild route calls: a refresh would
-- have to be called by every writer (the route, the browser's save, the
-- prunes, the cascades, a future one) and would leave a window in which the
-- numbers and the rows disagree; the triggers make it impossible to write a
-- row without its sums, and cost the writer one aggregate of rows it already
-- has (measured: +10-12 ms on a 1 000-row `save_hand_stats` call of ~60 ms).
-- `refresh_report_summaries()` (the caller's own, rate limited) and
-- `report_summaries_rebuild(owner)` recount from the rows: the repair, and
-- this migration's backfill.
--
-- Pairs of rows: an opponent's summary carries the hero's result in the
-- hands they shared, which depends on two rows of one hand. A statement adds
-- (or removes) every (opponent row, hero row) pair of its hands of which at
-- least one row is its own, against the rows already there; a per-account
-- advisory lock taken by the triggers (to commit) makes concurrent writers of
-- one account take turns, so a pair written by two of them is counted by the
-- later one only. The lock also orders the upserts.
--
-- First and last hand: a delete cannot take back a minimum, so a row a
-- delete touched marks its two times stale (`seen_exact`) and the reader
-- takes them from the rows again.
--
-- ## Security
--
-- RLS on the three tables (select: the owner; nothing else for anyone); the
-- trigger functions and the rebuild are security definer with
-- `search_path = ''` and granted to nobody; the readers are security invoker
-- (RLS scopes every read; the explicit `owner_id = auth.uid()` picks the
-- owner's index ranges) and are not granted to `anon`.
--
-- ## The readers (the shared screens' filter, `HandFilter`)
--
--   report_open(filter)        the summary (every counter and money sum, the
--                              all-in EV sum) and the rollups' breakdowns by
--                              position, stake, table size, room and format
--   report_graph(filter, n)    the win-rate graph in about n points, cut by
--                              hands at day ends (below)
--   report_situations(filter)  the breakdowns by pot type, stack, starting
--                              hand, players dealt in and street reached
--   report_sessions(filter, g) `stats_sessions` over the shared filter
--   report_facets(filter)      the filter's chips with their counts
--
-- `filter`: `statsVersion`, `evVersion`, `sites`, `formats`, `variants`,
-- `limits`, `sizes`, `stakes` (`USD:200`, `chips`), `positions` (the hero's),
-- `from` (inclusive) and `to` (exclusive) instants - a bound leaves out hands
-- without a time - and the options `includeBombPots` (false),
-- `includeStraddled` (true), `includeCashouts` (false; EV-cashout hands are
-- out of the money only). Other keys are ignored. Money is refused as the
-- `stats_*` functions refuse it: chips with cash keep no result at all, two
-- currencies keep big blinds only. `stats_opponents`, `stats_coverage` and
-- `stats_ev_missing` keep their signatures and their answers and read the
-- summaries.
--
-- The graph's points: `stats_graph` cuts the hands in time order into n equal
-- buckets (`ntile`), which needs every hand in order. Here, with T = hands /
-- n, a day of at most T hands goes whole to the point its first hand falls in
-- (floor(start / T)) and only a day of more hands is read hand by hand and cut
-- inside (floor(index / T)): every point is still exact (a cumulative sum to
-- a day's end or to a hand), the points are about T hands apart, and a large
-- sample is a scan of its days. A point's first and last time are its first
-- and last hand's.
--
-- Planning: Postgres starts no parallel workers for a query inside a
-- function (measured: "Workers Launched: 0"), so every reader is written for
-- one process - the rollups summed per branch before they are added (so the
-- planner can use the extended statistics below and hash), predicates the
-- planner can estimate (`kind = any (...)`, the formats as the enum, the stake
-- a column), lookups by key for the few all-in hands, `work_mem` raised for
-- the readers so a few thousand groups hash in memory, and each call planned
-- for its own filter (`plan_cache_mode = force_custom_plan`, R4.5b's lesson).
-- ============================================================================


begin;

-- ---------------------------------------------------------------------------
-- 1. The summaries
-- ---------------------------------------------------------------------------

create table public.hero_rollups (
  owner_id             uuid not null references auth.users (id) on delete cascade,
  stats_version        text not null,
  -- The UTC day of `played_at`; '-infinity' for a hand without a time.
  day                  date not null,
  site_id              text not null,
  game_format          public.game_format not null,
  -- '' where the row has none.
  variant              text not null,
  limit_type           text not null,
  -- 'hu', '6max', 'full' (`library_size`).
  size                 text not null,
  currency             text not null,
  currency_minor_units smallint not null,
  -- 0 where the row has none.
  small_blind          bigint not null,
  big_blind            bigint not null,
  -- 'USD:200' (cash: currency and big blind), 'chips' (the tournament formats).
  stake                text not null,
  "position"           text not null,
  -- bomb pot 1 | straddled 2 | EV cashout 4.
  kind                 smallint not null,
  hands bigint not null default 0,
  vpip_opp bigint not null default 0,
  vpip bigint not null default 0,
  pfr_opp bigint not null default 0,
  pfr bigint not null default 0,
  rfi_opp bigint not null default 0,
  rfi bigint not null default 0,
  iso_opp bigint not null default 0,
  iso bigint not null default 0,
  limp_opp bigint not null default 0,
  limp bigint not null default 0,
  cold_call_opp bigint not null default 0,
  cold_call bigint not null default 0,
  three_bet_opp bigint not null default 0,
  three_bet bigint not null default 0,
  four_bet_opp bigint not null default 0,
  four_bet bigint not null default 0,
  five_bet_opp bigint not null default 0,
  five_bet bigint not null default 0,
  squeeze_opp bigint not null default 0,
  squeeze bigint not null default 0,
  steal_opp bigint not null default 0,
  steal bigint not null default 0,
  fold_to_steal_opp bigint not null default 0,
  fold_to_steal bigint not null default 0,
  call_steal bigint not null default 0,
  three_bet_vs_steal bigint not null default 0,
  fold_to_three_bet_opp bigint not null default 0,
  fold_to_three_bet bigint not null default 0,
  call_three_bet bigint not null default 0,
  raise_vs_three_bet bigint not null default 0,
  fold_to_four_bet_opp bigint not null default 0,
  fold_to_four_bet bigint not null default 0,
  call_four_bet bigint not null default 0,
  raise_vs_four_bet bigint not null default 0,
  flop_seen bigint not null default 0,
  turn_seen bigint not null default 0,
  river_seen bigint not null default 0,
  cbet_flop_opp bigint not null default 0,
  cbet_flop bigint not null default 0,
  cbet_turn_opp bigint not null default 0,
  cbet_turn bigint not null default 0,
  cbet_river_opp bigint not null default 0,
  cbet_river bigint not null default 0,
  fold_to_cbet_flop_opp bigint not null default 0,
  fold_to_cbet_flop bigint not null default 0,
  call_cbet_flop bigint not null default 0,
  raise_cbet_flop bigint not null default 0,
  fold_to_cbet_turn_opp bigint not null default 0,
  fold_to_cbet_turn bigint not null default 0,
  call_cbet_turn bigint not null default 0,
  raise_cbet_turn bigint not null default 0,
  fold_to_cbet_river_opp bigint not null default 0,
  fold_to_cbet_river bigint not null default 0,
  call_cbet_river bigint not null default 0,
  raise_cbet_river bigint not null default 0,
  donk_flop_opp bigint not null default 0,
  donk_flop bigint not null default 0,
  donk_turn_opp bigint not null default 0,
  donk_turn bigint not null default 0,
  donk_river_opp bigint not null default 0,
  donk_river bigint not null default 0,
  check_raise_flop_opp bigint not null default 0,
  check_raise_flop bigint not null default 0,
  check_raise_turn_opp bigint not null default 0,
  check_raise_turn bigint not null default 0,
  check_raise_river_opp bigint not null default 0,
  check_raise_river bigint not null default 0,
  bet_flop bigint not null default 0,
  raise_flop bigint not null default 0,
  call_flop bigint not null default 0,
  check_flop bigint not null default 0,
  fold_flop bigint not null default 0,
  bet_turn bigint not null default 0,
  raise_turn bigint not null default 0,
  call_turn bigint not null default 0,
  check_turn bigint not null default 0,
  fold_turn bigint not null default 0,
  bet_river bigint not null default 0,
  raise_river bigint not null default 0,
  call_river bigint not null default 0,
  check_river bigint not null default 0,
  fold_river bigint not null default 0,
  wwsf_opp bigint not null default 0,
  wwsf bigint not null default 0,
  wtsd_opp bigint not null default 0,
  wtsd bigint not null default 0,
  wsd_opp bigint not null default 0,
  wsd bigint not null default 0,
  cashed_out bigint not null default 0,
  won bigint not null default 0,
  contributed bigint not null default 0,
  net bigint not null default 0,
  net_bb_milli bigint not null default 0,
  rake_paid bigint not null default 0,
  out_of_pot bigint not null default 0,
  cashout_risk bigint not null default 0,
  sd_net_bb_milli bigint not null default 0,
  sd_net bigint not null default 0,
  constraint hero_rollups_key unique (owner_id, stats_version, day, site_id, game_format, variant, limit_type, size, currency, currency_minor_units, small_blind, big_blind, stake, "position", kind)
);

comment on table public.hero_rollups is
  'The hero''s hand_stats rows summed per (owner, version, UTC day, segment, position, kind); maintained by triggers on hand_stats (R4.5c). Read by report_open / report_facets.';

-- The readers' groupings (report_open, report_facets): the same point.
create statistics public.hero_rollups_groups (ndistinct)
  on "position", size, site_id, game_format, currency, stake, kind from public.hero_rollups;
create statistics public.hero_rollups_facets (ndistinct)
  on site_id, game_format, variant, limit_type, size, currency, stake, "position" from public.hero_rollups;

alter table public.hero_rollups enable row level security;
create policy hero_rollups_owner_select on public.hero_rollups
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.hero_rollups from public, anon, authenticated;
grant select on public.hero_rollups to authenticated;

-- One narrow row per hero row: what the graph, the sessions and the
-- breakdowns by situation read, with the segment's derived values (size,
-- stake, kind, stack band) and the breakdown columns' counters. A covering
-- index in time order carries what the graph and the sessions read (an
-- index takes 32 columns, so not the counters); the breakdowns by situation
-- read the narrow table straight through.
create table public.hero_report_rows (
  hand_id              uuid not null,
  stats_version        text not null,
  seat                 smallint not null,
  owner_id             uuid not null references auth.users (id) on delete cascade,
  played_at            timestamptz,
  hand_key             text not null,
  site_id              text not null,
  game_format          public.game_format not null,
  variant              text not null,
  limit_type           text not null,
  size                 text not null,
  currency             text not null,
  currency_minor_units smallint not null,
  big_blind            bigint not null,
  stake                text not null,
  "position"           text not null,
  kind                 smallint not null,
  net                  bigint not null,
  net_bb_milli         bigint not null,
  table_name           text,
  pot_type             text not null,
  -- The hero's starting stack in the bands a cash player thinks in
  -- (`stats_breakdown`'s `stack_bb`); '' without one.
  stack                text not null,
  hand_class           text not null,
  players              smallint,
  street               text not null,
  vpip_opp             smallint not null,
  vpip                 smallint not null,
  pfr_opp              smallint not null,
  pfr                  smallint not null,
  rfi_opp              smallint not null,
  rfi                  smallint not null,
  three_bet_opp        smallint not null,
  three_bet            smallint not null,
  fold_to_three_bet_opp smallint not null,
  fold_to_three_bet    smallint not null,
  steal_opp            smallint not null,
  steal                smallint not null,
  cbet_flop_opp        smallint not null,
  cbet_flop            smallint not null,
  wtsd_opp             smallint not null,
  wtsd                 smallint not null,
  wsd_opp              smallint not null,
  wsd                  smallint not null,
  wwsf_opp             smallint not null,
  wwsf                 smallint not null,
  primary key (hand_id, stats_version, seat)
);

comment on table public.hero_report_rows is
  'One narrow row per hero hand_stats row for the graph, the sessions and the breakdowns by situation (R4.5c); maintained by triggers on hand_stats.';

create index hero_report_rows_time_idx on public.hero_report_rows
  (owner_id, stats_version, played_at, hand_key)
  include (
    hand_id, seat, site_id, game_format, variant, limit_type, size, currency, currency_minor_units,
    big_blind, stake, "position", kind, net, net_bb_milli, table_name, pot_type, stack, hand_class, players,
    street, wtsd);

-- Index-only scans need the visibility map, which only a vacuum sets; an
-- insert-only table waits for 20 % of its rows to be new before autovacuum
-- comes - a long wait on a table every account shares. Vacuum after ~20 000
-- new rows (cheap here: it visits the new pages).
alter table public.hero_report_rows set (
  autovacuum_vacuum_insert_threshold = 20000,
  autovacuum_vacuum_insert_scale_factor = 0.01
);

-- What the breakdowns by situation group by: with these the planner knows a
-- million rows make a few thousand groups (and hashes them).
create statistics public.hero_report_rows_situation (ndistinct)
  on pot_type, stack, hand_class, players, street, game_format, currency, kind from public.hero_report_rows;

alter table public.hero_report_rows enable row level security;
create policy hero_report_rows_owner_select on public.hero_report_rows
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.hero_report_rows from public, anon, authenticated;
grant select on public.hero_report_rows to authenticated;

create table public.player_stats (
  owner_id           uuid not null references auth.users (id) on delete cascade,
  stats_version      text not null,
  site_id            text not null,
  -- The name as printed; '' for every opaque-id row (a session token is not a person).
  player             text not null,
  site_anonymization public.site_anonymization not null,
  game_format        public.game_format not null,
  variant            text not null,
  limit_type         text not null,
  size               text not null,
  currency           text not null,
  big_blind          bigint not null,
  hands bigint not null default 0,
  vpip_opp bigint not null default 0,
  vpip bigint not null default 0,
  pfr_opp bigint not null default 0,
  pfr bigint not null default 0,
  three_bet_opp bigint not null default 0,
  three_bet bigint not null default 0,
  fold_to_three_bet_opp bigint not null default 0,
  fold_to_three_bet bigint not null default 0,
  cbet_flop_opp bigint not null default 0,
  cbet_flop bigint not null default 0,
  fold_to_cbet_flop_opp bigint not null default 0,
  fold_to_cbet_flop bigint not null default 0,
  wtsd_opp bigint not null default 0,
  wtsd bigint not null default 0,
  wsd_opp bigint not null default 0,
  wsd bigint not null default 0,
  bets bigint not null default 0,
  raises bigint not null default 0,
  calls bigint not null default 0,
  folds bigint not null default 0,
  -- The caller's own seat in the same hands: hands with both, of them the
  -- hands whose money counts (no EV cashout), and the hero's result in those.
  hero_hands bigint not null default 0,
  hero_money_hands bigint not null default 0,
  hero_net_bb_milli bigint not null default 0,
  first_played_at    timestamptz,
  last_played_at     timestamptz,
  -- False once a delete touched the row: the two times above may be stale and
  -- are read from the rows again (min / max cannot be taken back).
  seen_exact         boolean not null default true,
  constraint player_stats_key unique (owner_id, stats_version, site_id, player, site_anonymization, game_format, variant, limit_type, size, currency, big_blind)
);

comment on table public.player_stats is
  'Opponents'' hand_stats rows (villain rows, opt-in) summed per (owner, version, site, player, segment), with the hero''s result in the same hands; maintained by triggers on hand_stats (R4.5c). Read by stats_opponents.';

alter table public.player_stats enable row level security;
create policy player_stats_owner_select on public.player_stats
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.player_stats from public, anon, authenticated;
grant select on public.player_stats to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Kept by the rows' own statements
-- ---------------------------------------------------------------------------

create or replace function public.report_summaries_rebuild(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hero   integer;
  v_rows   integer;
  v_player integer;
begin
  -- One owner at a time, under a lock on the owner's summaries so a
  -- concurrent statistics write waits rather than adding to rows being
  -- replaced.
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || p_owner::text, 0));
  delete from public.hero_rollups where owner_id = p_owner;
  delete from public.hero_report_rows where owner_id = p_owner;
  delete from public.player_stats where owner_id = p_owner;

  insert into public.hero_rollups as r (
    owner_id, stats_version, day, site_id, game_format, variant, limit_type,
    size, currency, currency_minor_units, small_blind, big_blind, stake, "position",
    kind,
    hands, vpip_opp, vpip, pfr_opp, pfr, rfi_opp,
    rfi, iso_opp, iso, limp_opp, limp, cold_call_opp,
    cold_call, three_bet_opp, three_bet, four_bet_opp, four_bet, five_bet_opp,
    five_bet, squeeze_opp, squeeze, steal_opp, steal, fold_to_steal_opp,
    fold_to_steal, call_steal, three_bet_vs_steal, fold_to_three_bet_opp, fold_to_three_bet, call_three_bet,
    raise_vs_three_bet, fold_to_four_bet_opp, fold_to_four_bet, call_four_bet, raise_vs_four_bet, flop_seen,
    turn_seen, river_seen, cbet_flop_opp, cbet_flop, cbet_turn_opp, cbet_turn,
    cbet_river_opp, cbet_river, fold_to_cbet_flop_opp, fold_to_cbet_flop, call_cbet_flop, raise_cbet_flop,
    fold_to_cbet_turn_opp, fold_to_cbet_turn, call_cbet_turn, raise_cbet_turn, fold_to_cbet_river_opp, fold_to_cbet_river,
    call_cbet_river, raise_cbet_river, donk_flop_opp, donk_flop, donk_turn_opp, donk_turn,
    donk_river_opp, donk_river, check_raise_flop_opp, check_raise_flop, check_raise_turn_opp, check_raise_turn,
    check_raise_river_opp, check_raise_river, bet_flop, raise_flop, call_flop, check_flop,
    fold_flop, bet_turn, raise_turn, call_turn, check_turn, fold_turn,
    bet_river, raise_river, call_river, check_river, fold_river, wwsf_opp,
    wwsf, wtsd_opp, wtsd, wsd_opp, wsd, cashed_out,
    won, contributed, net, net_bb_milli, rake_paid, out_of_pot,
    cashout_risk, sd_net_bb_milli, sd_net
  )
  select
    x.owner_id as owner_id,
    x.stats_version as stats_version,
    coalesce((x.played_at at time zone 'UTC')::date, '-infinity'::date) as day,
    x.site_id as site_id,
    x.game_format as game_format,
    coalesce(x.variant, '') as variant,
    coalesce(x.limit_type, '') as limit_type,
    case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end as size,
    x.currency as currency,
    x.currency_minor_units as currency_minor_units,
    coalesce(x.small_blind, 0) as small_blind,
    coalesce(x.big_blind, 0) as big_blind,
    case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end as stake,
    coalesce(x."position", '') as "position",
    ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint as kind,
    sum(x.hands)::bigint, sum(x.vpip_opp)::bigint, sum(x.vpip)::bigint, sum(x.pfr_opp)::bigint,
    sum(x.pfr)::bigint, sum(x.rfi_opp)::bigint, sum(x.rfi)::bigint, sum(x.iso_opp)::bigint,
    sum(x.iso)::bigint, sum(x.limp_opp)::bigint, sum(x.limp)::bigint, sum(x.cold_call_opp)::bigint,
    sum(x.cold_call)::bigint, sum(x.three_bet_opp)::bigint, sum(x.three_bet)::bigint, sum(x.four_bet_opp)::bigint,
    sum(x.four_bet)::bigint, sum(x.five_bet_opp)::bigint, sum(x.five_bet)::bigint, sum(x.squeeze_opp)::bigint,
    sum(x.squeeze)::bigint, sum(x.steal_opp)::bigint, sum(x.steal)::bigint, sum(x.fold_to_steal_opp)::bigint,
    sum(x.fold_to_steal)::bigint, sum(x.call_steal)::bigint, sum(x.three_bet_vs_steal)::bigint, sum(x.fold_to_three_bet_opp)::bigint,
    sum(x.fold_to_three_bet)::bigint, sum(x.call_three_bet)::bigint, sum(x.raise_vs_three_bet)::bigint, sum(x.fold_to_four_bet_opp)::bigint,
    sum(x.fold_to_four_bet)::bigint, sum(x.call_four_bet)::bigint, sum(x.raise_vs_four_bet)::bigint, sum(x.flop_seen)::bigint,
    sum(x.turn_seen)::bigint, sum(x.river_seen)::bigint, sum(x.cbet_flop_opp)::bigint, sum(x.cbet_flop)::bigint,
    sum(x.cbet_turn_opp)::bigint, sum(x.cbet_turn)::bigint, sum(x.cbet_river_opp)::bigint, sum(x.cbet_river)::bigint,
    sum(x.fold_to_cbet_flop_opp)::bigint, sum(x.fold_to_cbet_flop)::bigint, sum(x.call_cbet_flop)::bigint, sum(x.raise_cbet_flop)::bigint,
    sum(x.fold_to_cbet_turn_opp)::bigint, sum(x.fold_to_cbet_turn)::bigint, sum(x.call_cbet_turn)::bigint, sum(x.raise_cbet_turn)::bigint,
    sum(x.fold_to_cbet_river_opp)::bigint, sum(x.fold_to_cbet_river)::bigint, sum(x.call_cbet_river)::bigint, sum(x.raise_cbet_river)::bigint,
    sum(x.donk_flop_opp)::bigint, sum(x.donk_flop)::bigint, sum(x.donk_turn_opp)::bigint, sum(x.donk_turn)::bigint,
    sum(x.donk_river_opp)::bigint, sum(x.donk_river)::bigint, sum(x.check_raise_flop_opp)::bigint, sum(x.check_raise_flop)::bigint,
    sum(x.check_raise_turn_opp)::bigint, sum(x.check_raise_turn)::bigint, sum(x.check_raise_river_opp)::bigint, sum(x.check_raise_river)::bigint,
    sum(x.bet_flop)::bigint, sum(x.raise_flop)::bigint, sum(x.call_flop)::bigint, sum(x.check_flop)::bigint,
    sum(x.fold_flop)::bigint, sum(x.bet_turn)::bigint, sum(x.raise_turn)::bigint, sum(x.call_turn)::bigint,
    sum(x.check_turn)::bigint, sum(x.fold_turn)::bigint, sum(x.bet_river)::bigint, sum(x.raise_river)::bigint,
    sum(x.call_river)::bigint, sum(x.check_river)::bigint, sum(x.fold_river)::bigint, sum(x.wwsf_opp)::bigint,
    sum(x.wwsf)::bigint, sum(x.wtsd_opp)::bigint, sum(x.wtsd)::bigint, sum(x.wsd_opp)::bigint,
    sum(x.wsd)::bigint, sum(x.cashed_out)::bigint, sum(x.won)::bigint, sum(x.contributed)::bigint,
    sum(x.net)::bigint, sum(x.net_bb_milli)::bigint, sum(x.rake_paid)::bigint, sum(x.out_of_pot)::bigint,
    sum(x.cashout_risk)::bigint, sum((case when x.wtsd > 0 then x.net_bb_milli else 0 end))::bigint, sum((case when x.wtsd > 0 then x.net else 0 end))::bigint
  from (select * from public.hand_stats where owner_id = p_owner) x
  where x.is_hero
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15;
  get diagnostics v_hero = row_count;

  insert into public.hero_report_rows (
    hand_id, stats_version, seat, owner_id, played_at, hand_key, site_id, game_format, variant,
    limit_type, size, currency, currency_minor_units, big_blind, stake, "position", kind, net, net_bb_milli,
    table_name, pot_type, stack, hand_class, players, street,
    vpip_opp, vpip, pfr_opp, pfr, rfi_opp, rfi, three_bet_opp, three_bet, fold_to_three_bet_opp, fold_to_three_bet, steal_opp, steal, cbet_flop_opp, cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, wwsf_opp, wwsf
  )
  select
    x.hand_id, x.stats_version, x.seat, x.owner_id, x.played_at, x.hand_key, x.site_id, x.game_format,
    coalesce(x.variant, ''), coalesce(x.limit_type, ''), case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end,
    x.currency, x.currency_minor_units, coalesce(x.big_blind, 0), case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end, coalesce(x."position", ''), ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint,
    x.net, x.net_bb_milli, x.table_name, coalesce(x.pot_type, ''), case
          when x.starting_stack_bb_tenths is null then ''
          when x.starting_stack_bb_tenths <  200 then '0-20'
          when x.starting_stack_bb_tenths <  400 then '20-40'
          when x.starting_stack_bb_tenths <  700 then '40-70'
          when x.starting_stack_bb_tenths < 1000 then '70-100'
          when x.starting_stack_bb_tenths < 1500 then '100-150'
          when x.starting_stack_bb_tenths < 2500 then '150-250'
          else '250+' end,
    coalesce(x.hand_class, ''), x.player_count, coalesce(x.street_reached, ''),
    x.vpip_opp, x.vpip, x.pfr_opp, x.pfr, x.rfi_opp, x.rfi, x.three_bet_opp, x.three_bet, x.fold_to_three_bet_opp, x.fold_to_three_bet, x.steal_opp, x.steal, x.cbet_flop_opp, x.cbet_flop, x.wtsd_opp, x.wtsd, x.wsd_opp, x.wsd, x.wwsf_opp, x.wwsf
  from (select * from public.hand_stats where owner_id = p_owner) x
  where x.is_hero
  on conflict (hand_id, stats_version, seat) do nothing;
  get diagnostics v_rows = row_count;

  with v as (
    select
      s.hand_id,
      s.stats_version as v_version,
      s.played_at,
      s.owner_id as owner_id,
      s.stats_version as stats_version,
      s.site_id as site_id,
      case when s.site_anonymization = 'opaque-id' then '' else s.player end as player,
      s.site_anonymization as site_anonymization,
      s.game_format as game_format,
      coalesce(s.variant, '') as variant,
      coalesce(s.limit_type, '') as limit_type,
      case
      when coalesce(case when coalesce(s.max_seats, 0) >= 2 then s.max_seats else s.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(s.max_seats, 0) >= 2 then s.max_seats else s.player_count end <= 6 then '6max'
      else 'full'
    end as size,
      s.currency as currency,
      coalesce(s.big_blind, 0) as big_blind,
      s.hands::bigint as hands,
      s.vpip_opp::bigint as vpip_opp,
      s.vpip::bigint as vpip,
      s.pfr_opp::bigint as pfr_opp,
      s.pfr::bigint as pfr,
      s.three_bet_opp::bigint as three_bet_opp,
      s.three_bet::bigint as three_bet,
      s.fold_to_three_bet_opp::bigint as fold_to_three_bet_opp,
      s.fold_to_three_bet::bigint as fold_to_three_bet,
      s.cbet_flop_opp::bigint as cbet_flop_opp,
      s.cbet_flop::bigint as cbet_flop,
      s.fold_to_cbet_flop_opp::bigint as fold_to_cbet_flop_opp,
      s.fold_to_cbet_flop::bigint as fold_to_cbet_flop,
      s.wtsd_opp::bigint as wtsd_opp,
      s.wtsd::bigint as wtsd,
      s.wsd_opp::bigint as wsd_opp,
      s.wsd::bigint as wsd,
      (s.bet_flop + s.bet_turn + s.bet_river)::bigint as bets,
      (s.raise_flop + s.raise_turn + s.raise_river)::bigint as raises,
      (s.call_flop + s.call_turn + s.call_river)::bigint as calls,
      (s.fold_flop + s.fold_turn + s.fold_river)::bigint as folds,
      true as fresh
    from public.hand_stats s
    where s.owner_id = p_owner and not s.is_hero and not s.is_bomb_pot and s.player <> ''
  ),
  h as (
    select s.hand_id, s.stats_version, s.has_cashout, s.net_bb_milli, true as fresh
    from public.hand_stats s
    where s.owner_id = p_owner and s.is_hero
  ),
  c as (
    select
      v.owner_id, v.stats_version, v.site_id, v.player, v.site_anonymization, v.game_format,
      v.variant, v.limit_type, v.size, v.currency, v.big_blind,
      v.hands, v.vpip_opp, v.vpip, v.pfr_opp, v.pfr, v.three_bet_opp,
      v.three_bet, v.fold_to_three_bet_opp, v.fold_to_three_bet, v.cbet_flop_opp, v.cbet_flop, v.fold_to_cbet_flop_opp,
      v.fold_to_cbet_flop, v.wtsd_opp, v.wtsd, v.wsd_opp, v.wsd, v.bets,
      v.raises, v.calls, v.folds,
      0::bigint as hero_hands, 0::bigint as hero_money_hands, 0::bigint as hero_net_bb_milli,
      v.played_at
    from v
    where v.fresh
    union all
    select
      v.owner_id, v.stats_version, v.site_id, v.player, v.site_anonymization, v.game_format,
      v.variant, v.limit_type, v.size, v.currency, v.big_blind,
      0::bigint as hands, 0::bigint as vpip_opp, 0::bigint as vpip, 0::bigint as pfr_opp, 0::bigint as pfr, 0::bigint as three_bet_opp,
      0::bigint as three_bet, 0::bigint as fold_to_three_bet_opp, 0::bigint as fold_to_three_bet, 0::bigint as cbet_flop_opp, 0::bigint as cbet_flop, 0::bigint as fold_to_cbet_flop_opp,
      0::bigint as fold_to_cbet_flop, 0::bigint as wtsd_opp, 0::bigint as wtsd, 0::bigint as wsd_opp, 0::bigint as wsd, 0::bigint as bets,
      0::bigint as raises, 0::bigint as calls, 0::bigint as folds,
      1::bigint,
      case when h.has_cashout then 0 else 1 end::bigint,
      case when h.has_cashout then 0 else h.net_bb_milli end::bigint,
      null::timestamptz
    from v
    join h on h.hand_id = v.hand_id and h.stats_version = v.v_version
    where true
  )
  insert into public.player_stats (
    owner_id, stats_version, site_id, player, site_anonymization, game_format,
    variant, limit_type, size, currency, big_blind,
    hands, vpip_opp, vpip, pfr_opp, pfr, three_bet_opp,
    three_bet, fold_to_three_bet_opp, fold_to_three_bet, cbet_flop_opp, cbet_flop, fold_to_cbet_flop_opp,
    fold_to_cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, bets,
    raises, calls, folds, hero_hands, hero_money_hands, hero_net_bb_milli,
    first_played_at, last_played_at
  )
  select
    c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format,
    c.variant, c.limit_type, c.size, c.currency, c.big_blind,
    sum(c.hands)::bigint, sum(c.vpip_opp)::bigint, sum(c.vpip)::bigint, sum(c.pfr_opp)::bigint,
    sum(c.pfr)::bigint, sum(c.three_bet_opp)::bigint, sum(c.three_bet)::bigint, sum(c.fold_to_three_bet_opp)::bigint,
    sum(c.fold_to_three_bet)::bigint, sum(c.cbet_flop_opp)::bigint, sum(c.cbet_flop)::bigint, sum(c.fold_to_cbet_flop_opp)::bigint,
    sum(c.fold_to_cbet_flop)::bigint, sum(c.wtsd_opp)::bigint, sum(c.wtsd)::bigint, sum(c.wsd_opp)::bigint,
    sum(c.wsd)::bigint, sum(c.bets)::bigint, sum(c.raises)::bigint, sum(c.calls)::bigint,
    sum(c.folds)::bigint, sum(c.hero_hands)::bigint, sum(c.hero_money_hands)::bigint, sum(c.hero_net_bb_milli)::bigint,
    min(c.played_at), max(c.played_at)
  from c
  group by c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format, c.variant, c.limit_type, c.size, c.currency, c.big_blind
  having sum(c.hands) > 0;
  get diagnostics v_player = row_count;

  return jsonb_build_object('heroRollups', v_hero, 'reportRows', v_rows, 'playerRows', v_player);
end;
$$;

revoke all on function public.report_summaries_rebuild(uuid) from public, anon, authenticated;

-- The caller's own summaries counted again from their rows. Never needed in
-- normal use (the triggers keep them); the repair if they are ever doubted.
create or replace function public.refresh_report_summaries()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is null then
    raise exception 'You must be signed in to refresh statistics.' using errcode = '42501';
  end if;
  perform public.enforce_rate_limit('report_summaries_refresh:' || v_owner::text, 1, 10, interval '1 hour');
  return public.report_summaries_rebuild(v_owner);
end;
$$;

revoke all on function public.refresh_report_summaries() from public, anon;
grant execute on function public.refresh_report_summaries() to authenticated;

create or replace function public.hand_stats_summaries_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One writer per account at a time from here to its commit: concurrent
  -- statements of one account add to the same rows, and a pair of rows of
  -- one hand written by two of them is counted by the later one only.
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from inserted order by 1) o;

  insert into public.hero_rollups as r (
    owner_id, stats_version, day, site_id, game_format, variant, limit_type,
    size, currency, currency_minor_units, small_blind, big_blind, stake, "position",
    kind,
    hands, vpip_opp, vpip, pfr_opp, pfr, rfi_opp,
    rfi, iso_opp, iso, limp_opp, limp, cold_call_opp,
    cold_call, three_bet_opp, three_bet, four_bet_opp, four_bet, five_bet_opp,
    five_bet, squeeze_opp, squeeze, steal_opp, steal, fold_to_steal_opp,
    fold_to_steal, call_steal, three_bet_vs_steal, fold_to_three_bet_opp, fold_to_three_bet, call_three_bet,
    raise_vs_three_bet, fold_to_four_bet_opp, fold_to_four_bet, call_four_bet, raise_vs_four_bet, flop_seen,
    turn_seen, river_seen, cbet_flop_opp, cbet_flop, cbet_turn_opp, cbet_turn,
    cbet_river_opp, cbet_river, fold_to_cbet_flop_opp, fold_to_cbet_flop, call_cbet_flop, raise_cbet_flop,
    fold_to_cbet_turn_opp, fold_to_cbet_turn, call_cbet_turn, raise_cbet_turn, fold_to_cbet_river_opp, fold_to_cbet_river,
    call_cbet_river, raise_cbet_river, donk_flop_opp, donk_flop, donk_turn_opp, donk_turn,
    donk_river_opp, donk_river, check_raise_flop_opp, check_raise_flop, check_raise_turn_opp, check_raise_turn,
    check_raise_river_opp, check_raise_river, bet_flop, raise_flop, call_flop, check_flop,
    fold_flop, bet_turn, raise_turn, call_turn, check_turn, fold_turn,
    bet_river, raise_river, call_river, check_river, fold_river, wwsf_opp,
    wwsf, wtsd_opp, wtsd, wsd_opp, wsd, cashed_out,
    won, contributed, net, net_bb_milli, rake_paid, out_of_pot,
    cashout_risk, sd_net_bb_milli, sd_net
  )
  select
    x.owner_id as owner_id,
    x.stats_version as stats_version,
    coalesce((x.played_at at time zone 'UTC')::date, '-infinity'::date) as day,
    x.site_id as site_id,
    x.game_format as game_format,
    coalesce(x.variant, '') as variant,
    coalesce(x.limit_type, '') as limit_type,
    case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end as size,
    x.currency as currency,
    x.currency_minor_units as currency_minor_units,
    coalesce(x.small_blind, 0) as small_blind,
    coalesce(x.big_blind, 0) as big_blind,
    case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end as stake,
    coalesce(x."position", '') as "position",
    ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint as kind,
    sum(x.hands)::bigint, sum(x.vpip_opp)::bigint, sum(x.vpip)::bigint, sum(x.pfr_opp)::bigint,
    sum(x.pfr)::bigint, sum(x.rfi_opp)::bigint, sum(x.rfi)::bigint, sum(x.iso_opp)::bigint,
    sum(x.iso)::bigint, sum(x.limp_opp)::bigint, sum(x.limp)::bigint, sum(x.cold_call_opp)::bigint,
    sum(x.cold_call)::bigint, sum(x.three_bet_opp)::bigint, sum(x.three_bet)::bigint, sum(x.four_bet_opp)::bigint,
    sum(x.four_bet)::bigint, sum(x.five_bet_opp)::bigint, sum(x.five_bet)::bigint, sum(x.squeeze_opp)::bigint,
    sum(x.squeeze)::bigint, sum(x.steal_opp)::bigint, sum(x.steal)::bigint, sum(x.fold_to_steal_opp)::bigint,
    sum(x.fold_to_steal)::bigint, sum(x.call_steal)::bigint, sum(x.three_bet_vs_steal)::bigint, sum(x.fold_to_three_bet_opp)::bigint,
    sum(x.fold_to_three_bet)::bigint, sum(x.call_three_bet)::bigint, sum(x.raise_vs_three_bet)::bigint, sum(x.fold_to_four_bet_opp)::bigint,
    sum(x.fold_to_four_bet)::bigint, sum(x.call_four_bet)::bigint, sum(x.raise_vs_four_bet)::bigint, sum(x.flop_seen)::bigint,
    sum(x.turn_seen)::bigint, sum(x.river_seen)::bigint, sum(x.cbet_flop_opp)::bigint, sum(x.cbet_flop)::bigint,
    sum(x.cbet_turn_opp)::bigint, sum(x.cbet_turn)::bigint, sum(x.cbet_river_opp)::bigint, sum(x.cbet_river)::bigint,
    sum(x.fold_to_cbet_flop_opp)::bigint, sum(x.fold_to_cbet_flop)::bigint, sum(x.call_cbet_flop)::bigint, sum(x.raise_cbet_flop)::bigint,
    sum(x.fold_to_cbet_turn_opp)::bigint, sum(x.fold_to_cbet_turn)::bigint, sum(x.call_cbet_turn)::bigint, sum(x.raise_cbet_turn)::bigint,
    sum(x.fold_to_cbet_river_opp)::bigint, sum(x.fold_to_cbet_river)::bigint, sum(x.call_cbet_river)::bigint, sum(x.raise_cbet_river)::bigint,
    sum(x.donk_flop_opp)::bigint, sum(x.donk_flop)::bigint, sum(x.donk_turn_opp)::bigint, sum(x.donk_turn)::bigint,
    sum(x.donk_river_opp)::bigint, sum(x.donk_river)::bigint, sum(x.check_raise_flop_opp)::bigint, sum(x.check_raise_flop)::bigint,
    sum(x.check_raise_turn_opp)::bigint, sum(x.check_raise_turn)::bigint, sum(x.check_raise_river_opp)::bigint, sum(x.check_raise_river)::bigint,
    sum(x.bet_flop)::bigint, sum(x.raise_flop)::bigint, sum(x.call_flop)::bigint, sum(x.check_flop)::bigint,
    sum(x.fold_flop)::bigint, sum(x.bet_turn)::bigint, sum(x.raise_turn)::bigint, sum(x.call_turn)::bigint,
    sum(x.check_turn)::bigint, sum(x.fold_turn)::bigint, sum(x.bet_river)::bigint, sum(x.raise_river)::bigint,
    sum(x.call_river)::bigint, sum(x.check_river)::bigint, sum(x.fold_river)::bigint, sum(x.wwsf_opp)::bigint,
    sum(x.wwsf)::bigint, sum(x.wtsd_opp)::bigint, sum(x.wtsd)::bigint, sum(x.wsd_opp)::bigint,
    sum(x.wsd)::bigint, sum(x.cashed_out)::bigint, sum(x.won)::bigint, sum(x.contributed)::bigint,
    sum(x.net)::bigint, sum(x.net_bb_milli)::bigint, sum(x.rake_paid)::bigint, sum(x.out_of_pot)::bigint,
    sum(x.cashout_risk)::bigint, sum((case when x.wtsd > 0 then x.net_bb_milli else 0 end))::bigint, sum((case when x.wtsd > 0 then x.net else 0 end))::bigint
  from inserted x
  where x.is_hero
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  on conflict on constraint hero_rollups_key do update set
    hands = r.hands + excluded.hands, vpip_opp = r.vpip_opp + excluded.vpip_opp,
    vpip = r.vpip + excluded.vpip, pfr_opp = r.pfr_opp + excluded.pfr_opp,
    pfr = r.pfr + excluded.pfr, rfi_opp = r.rfi_opp + excluded.rfi_opp,
    rfi = r.rfi + excluded.rfi, iso_opp = r.iso_opp + excluded.iso_opp,
    iso = r.iso + excluded.iso, limp_opp = r.limp_opp + excluded.limp_opp,
    limp = r.limp + excluded.limp, cold_call_opp = r.cold_call_opp + excluded.cold_call_opp,
    cold_call = r.cold_call + excluded.cold_call, three_bet_opp = r.three_bet_opp + excluded.three_bet_opp,
    three_bet = r.three_bet + excluded.three_bet, four_bet_opp = r.four_bet_opp + excluded.four_bet_opp,
    four_bet = r.four_bet + excluded.four_bet, five_bet_opp = r.five_bet_opp + excluded.five_bet_opp,
    five_bet = r.five_bet + excluded.five_bet, squeeze_opp = r.squeeze_opp + excluded.squeeze_opp,
    squeeze = r.squeeze + excluded.squeeze, steal_opp = r.steal_opp + excluded.steal_opp,
    steal = r.steal + excluded.steal, fold_to_steal_opp = r.fold_to_steal_opp + excluded.fold_to_steal_opp,
    fold_to_steal = r.fold_to_steal + excluded.fold_to_steal, call_steal = r.call_steal + excluded.call_steal,
    three_bet_vs_steal = r.three_bet_vs_steal + excluded.three_bet_vs_steal, fold_to_three_bet_opp = r.fold_to_three_bet_opp + excluded.fold_to_three_bet_opp,
    fold_to_three_bet = r.fold_to_three_bet + excluded.fold_to_three_bet, call_three_bet = r.call_three_bet + excluded.call_three_bet,
    raise_vs_three_bet = r.raise_vs_three_bet + excluded.raise_vs_three_bet, fold_to_four_bet_opp = r.fold_to_four_bet_opp + excluded.fold_to_four_bet_opp,
    fold_to_four_bet = r.fold_to_four_bet + excluded.fold_to_four_bet, call_four_bet = r.call_four_bet + excluded.call_four_bet,
    raise_vs_four_bet = r.raise_vs_four_bet + excluded.raise_vs_four_bet, flop_seen = r.flop_seen + excluded.flop_seen,
    turn_seen = r.turn_seen + excluded.turn_seen, river_seen = r.river_seen + excluded.river_seen,
    cbet_flop_opp = r.cbet_flop_opp + excluded.cbet_flop_opp, cbet_flop = r.cbet_flop + excluded.cbet_flop,
    cbet_turn_opp = r.cbet_turn_opp + excluded.cbet_turn_opp, cbet_turn = r.cbet_turn + excluded.cbet_turn,
    cbet_river_opp = r.cbet_river_opp + excluded.cbet_river_opp, cbet_river = r.cbet_river + excluded.cbet_river,
    fold_to_cbet_flop_opp = r.fold_to_cbet_flop_opp + excluded.fold_to_cbet_flop_opp, fold_to_cbet_flop = r.fold_to_cbet_flop + excluded.fold_to_cbet_flop,
    call_cbet_flop = r.call_cbet_flop + excluded.call_cbet_flop, raise_cbet_flop = r.raise_cbet_flop + excluded.raise_cbet_flop,
    fold_to_cbet_turn_opp = r.fold_to_cbet_turn_opp + excluded.fold_to_cbet_turn_opp, fold_to_cbet_turn = r.fold_to_cbet_turn + excluded.fold_to_cbet_turn,
    call_cbet_turn = r.call_cbet_turn + excluded.call_cbet_turn, raise_cbet_turn = r.raise_cbet_turn + excluded.raise_cbet_turn,
    fold_to_cbet_river_opp = r.fold_to_cbet_river_opp + excluded.fold_to_cbet_river_opp, fold_to_cbet_river = r.fold_to_cbet_river + excluded.fold_to_cbet_river,
    call_cbet_river = r.call_cbet_river + excluded.call_cbet_river, raise_cbet_river = r.raise_cbet_river + excluded.raise_cbet_river,
    donk_flop_opp = r.donk_flop_opp + excluded.donk_flop_opp, donk_flop = r.donk_flop + excluded.donk_flop,
    donk_turn_opp = r.donk_turn_opp + excluded.donk_turn_opp, donk_turn = r.donk_turn + excluded.donk_turn,
    donk_river_opp = r.donk_river_opp + excluded.donk_river_opp, donk_river = r.donk_river + excluded.donk_river,
    check_raise_flop_opp = r.check_raise_flop_opp + excluded.check_raise_flop_opp, check_raise_flop = r.check_raise_flop + excluded.check_raise_flop,
    check_raise_turn_opp = r.check_raise_turn_opp + excluded.check_raise_turn_opp, check_raise_turn = r.check_raise_turn + excluded.check_raise_turn,
    check_raise_river_opp = r.check_raise_river_opp + excluded.check_raise_river_opp, check_raise_river = r.check_raise_river + excluded.check_raise_river,
    bet_flop = r.bet_flop + excluded.bet_flop, raise_flop = r.raise_flop + excluded.raise_flop,
    call_flop = r.call_flop + excluded.call_flop, check_flop = r.check_flop + excluded.check_flop,
    fold_flop = r.fold_flop + excluded.fold_flop, bet_turn = r.bet_turn + excluded.bet_turn,
    raise_turn = r.raise_turn + excluded.raise_turn, call_turn = r.call_turn + excluded.call_turn,
    check_turn = r.check_turn + excluded.check_turn, fold_turn = r.fold_turn + excluded.fold_turn,
    bet_river = r.bet_river + excluded.bet_river, raise_river = r.raise_river + excluded.raise_river,
    call_river = r.call_river + excluded.call_river, check_river = r.check_river + excluded.check_river,
    fold_river = r.fold_river + excluded.fold_river, wwsf_opp = r.wwsf_opp + excluded.wwsf_opp,
    wwsf = r.wwsf + excluded.wwsf, wtsd_opp = r.wtsd_opp + excluded.wtsd_opp,
    wtsd = r.wtsd + excluded.wtsd, wsd_opp = r.wsd_opp + excluded.wsd_opp,
    wsd = r.wsd + excluded.wsd, cashed_out = r.cashed_out + excluded.cashed_out,
    won = r.won + excluded.won, contributed = r.contributed + excluded.contributed,
    net = r.net + excluded.net, net_bb_milli = r.net_bb_milli + excluded.net_bb_milli,
    rake_paid = r.rake_paid + excluded.rake_paid, out_of_pot = r.out_of_pot + excluded.out_of_pot,
    cashout_risk = r.cashout_risk + excluded.cashout_risk, sd_net_bb_milli = r.sd_net_bb_milli + excluded.sd_net_bb_milli,
    sd_net = r.sd_net + excluded.sd_net;

  insert into public.hero_report_rows (
    hand_id, stats_version, seat, owner_id, played_at, hand_key, site_id, game_format, variant,
    limit_type, size, currency, currency_minor_units, big_blind, stake, "position", kind, net, net_bb_milli,
    table_name, pot_type, stack, hand_class, players, street,
    vpip_opp, vpip, pfr_opp, pfr, rfi_opp, rfi, three_bet_opp, three_bet, fold_to_three_bet_opp, fold_to_three_bet, steal_opp, steal, cbet_flop_opp, cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, wwsf_opp, wwsf
  )
  select
    x.hand_id, x.stats_version, x.seat, x.owner_id, x.played_at, x.hand_key, x.site_id, x.game_format,
    coalesce(x.variant, ''), coalesce(x.limit_type, ''), case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end,
    x.currency, x.currency_minor_units, coalesce(x.big_blind, 0), case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end, coalesce(x."position", ''), ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint,
    x.net, x.net_bb_milli, x.table_name, coalesce(x.pot_type, ''), case
          when x.starting_stack_bb_tenths is null then ''
          when x.starting_stack_bb_tenths <  200 then '0-20'
          when x.starting_stack_bb_tenths <  400 then '20-40'
          when x.starting_stack_bb_tenths <  700 then '40-70'
          when x.starting_stack_bb_tenths < 1000 then '70-100'
          when x.starting_stack_bb_tenths < 1500 then '100-150'
          when x.starting_stack_bb_tenths < 2500 then '150-250'
          else '250+' end,
    coalesce(x.hand_class, ''), x.player_count, coalesce(x.street_reached, ''),
    x.vpip_opp, x.vpip, x.pfr_opp, x.pfr, x.rfi_opp, x.rfi, x.three_bet_opp, x.three_bet, x.fold_to_three_bet_opp, x.fold_to_three_bet, x.steal_opp, x.steal, x.cbet_flop_opp, x.cbet_flop, x.wtsd_opp, x.wtsd, x.wsd_opp, x.wsd, x.wwsf_opp, x.wwsf
  from inserted x
  where x.is_hero
  on conflict (hand_id, stats_version, seat) do nothing;

  with t as (
    select distinct i.hand_id, i.stats_version from inserted i
  ),
  v as (
    select
      s.hand_id,
      s.stats_version as v_version,
      s.played_at,
      s.owner_id as owner_id,
      s.stats_version as stats_version,
      s.site_id as site_id,
      case when s.site_anonymization = 'opaque-id' then '' else s.player end as player,
      s.site_anonymization as site_anonymization,
      s.game_format as game_format,
      coalesce(s.variant, '') as variant,
      coalesce(s.limit_type, '') as limit_type,
      case
      when coalesce(case when coalesce(s.max_seats, 0) >= 2 then s.max_seats else s.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(s.max_seats, 0) >= 2 then s.max_seats else s.player_count end <= 6 then '6max'
      else 'full'
    end as size,
      s.currency as currency,
      coalesce(s.big_blind, 0) as big_blind,
      s.hands::bigint as hands,
      s.vpip_opp::bigint as vpip_opp,
      s.vpip::bigint as vpip,
      s.pfr_opp::bigint as pfr_opp,
      s.pfr::bigint as pfr,
      s.three_bet_opp::bigint as three_bet_opp,
      s.three_bet::bigint as three_bet,
      s.fold_to_three_bet_opp::bigint as fold_to_three_bet_opp,
      s.fold_to_three_bet::bigint as fold_to_three_bet,
      s.cbet_flop_opp::bigint as cbet_flop_opp,
      s.cbet_flop::bigint as cbet_flop,
      s.fold_to_cbet_flop_opp::bigint as fold_to_cbet_flop_opp,
      s.fold_to_cbet_flop::bigint as fold_to_cbet_flop,
      s.wtsd_opp::bigint as wtsd_opp,
      s.wtsd::bigint as wtsd,
      s.wsd_opp::bigint as wsd_opp,
      s.wsd::bigint as wsd,
      (s.bet_flop + s.bet_turn + s.bet_river)::bigint as bets,
      (s.raise_flop + s.raise_turn + s.raise_river)::bigint as raises,
      (s.call_flop + s.call_turn + s.call_river)::bigint as calls,
      (s.fold_flop + s.fold_turn + s.fold_river)::bigint as folds,
      i.hand_id is not null as fresh
    from t
    join public.hand_stats s on s.hand_id = t.hand_id and s.stats_version = t.stats_version
    left join inserted i on i.hand_id = s.hand_id and i.stats_version = s.stats_version and i.seat = s.seat
    where not s.is_hero and not s.is_bomb_pot and s.player <> ''
  ),
  h as (
    select s.hand_id, s.stats_version, s.has_cashout, s.net_bb_milli, i.hand_id is not null as fresh
    from t
    join public.hand_stats s on s.hand_id = t.hand_id and s.stats_version = t.stats_version
    left join inserted i on i.hand_id = s.hand_id and i.stats_version = s.stats_version and i.seat = s.seat
    where s.is_hero
  ),
  c as (
    select
      v.owner_id, v.stats_version, v.site_id, v.player, v.site_anonymization, v.game_format,
      v.variant, v.limit_type, v.size, v.currency, v.big_blind,
      v.hands, v.vpip_opp, v.vpip, v.pfr_opp, v.pfr, v.three_bet_opp,
      v.three_bet, v.fold_to_three_bet_opp, v.fold_to_three_bet, v.cbet_flop_opp, v.cbet_flop, v.fold_to_cbet_flop_opp,
      v.fold_to_cbet_flop, v.wtsd_opp, v.wtsd, v.wsd_opp, v.wsd, v.bets,
      v.raises, v.calls, v.folds,
      0::bigint as hero_hands, 0::bigint as hero_money_hands, 0::bigint as hero_net_bb_milli,
      v.played_at
    from v
    where v.fresh
    union all
    select
      v.owner_id, v.stats_version, v.site_id, v.player, v.site_anonymization, v.game_format,
      v.variant, v.limit_type, v.size, v.currency, v.big_blind,
      0::bigint as hands, 0::bigint as vpip_opp, 0::bigint as vpip, 0::bigint as pfr_opp, 0::bigint as pfr, 0::bigint as three_bet_opp,
      0::bigint as three_bet, 0::bigint as fold_to_three_bet_opp, 0::bigint as fold_to_three_bet, 0::bigint as cbet_flop_opp, 0::bigint as cbet_flop, 0::bigint as fold_to_cbet_flop_opp,
      0::bigint as fold_to_cbet_flop, 0::bigint as wtsd_opp, 0::bigint as wtsd, 0::bigint as wsd_opp, 0::bigint as wsd, 0::bigint as bets,
      0::bigint as raises, 0::bigint as calls, 0::bigint as folds,
      1::bigint,
      case when h.has_cashout then 0 else 1 end::bigint,
      case when h.has_cashout then 0 else h.net_bb_milli end::bigint,
      null::timestamptz
    from v
    join h on h.hand_id = v.hand_id and h.stats_version = v.v_version
    where v.fresh or h.fresh
  )
  insert into public.player_stats as r (
    owner_id, stats_version, site_id, player, site_anonymization, game_format,
    variant, limit_type, size, currency, big_blind,
    hands, vpip_opp, vpip, pfr_opp, pfr, three_bet_opp,
    three_bet, fold_to_three_bet_opp, fold_to_three_bet, cbet_flop_opp, cbet_flop, fold_to_cbet_flop_opp,
    fold_to_cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, bets,
    raises, calls, folds, hero_hands, hero_money_hands, hero_net_bb_milli,
    first_played_at, last_played_at
  )
  select
    c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format,
    c.variant, c.limit_type, c.size, c.currency, c.big_blind,
    sum(c.hands)::bigint, sum(c.vpip_opp)::bigint, sum(c.vpip)::bigint, sum(c.pfr_opp)::bigint,
    sum(c.pfr)::bigint, sum(c.three_bet_opp)::bigint, sum(c.three_bet)::bigint, sum(c.fold_to_three_bet_opp)::bigint,
    sum(c.fold_to_three_bet)::bigint, sum(c.cbet_flop_opp)::bigint, sum(c.cbet_flop)::bigint, sum(c.fold_to_cbet_flop_opp)::bigint,
    sum(c.fold_to_cbet_flop)::bigint, sum(c.wtsd_opp)::bigint, sum(c.wtsd)::bigint, sum(c.wsd_opp)::bigint,
    sum(c.wsd)::bigint, sum(c.bets)::bigint, sum(c.raises)::bigint, sum(c.calls)::bigint,
    sum(c.folds)::bigint, sum(c.hero_hands)::bigint, sum(c.hero_money_hands)::bigint, sum(c.hero_net_bb_milli)::bigint,
    min(c.played_at), max(c.played_at)
  from c
  group by c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format, c.variant, c.limit_type, c.size, c.currency, c.big_blind
  order by c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format, c.variant, c.limit_type, c.size, c.currency, c.big_blind
  on conflict on constraint player_stats_key do update set
    hands = r.hands + excluded.hands, vpip_opp = r.vpip_opp + excluded.vpip_opp,
    vpip = r.vpip + excluded.vpip, pfr_opp = r.pfr_opp + excluded.pfr_opp,
    pfr = r.pfr + excluded.pfr, three_bet_opp = r.three_bet_opp + excluded.three_bet_opp,
    three_bet = r.three_bet + excluded.three_bet, fold_to_three_bet_opp = r.fold_to_three_bet_opp + excluded.fold_to_three_bet_opp,
    fold_to_three_bet = r.fold_to_three_bet + excluded.fold_to_three_bet, cbet_flop_opp = r.cbet_flop_opp + excluded.cbet_flop_opp,
    cbet_flop = r.cbet_flop + excluded.cbet_flop, fold_to_cbet_flop_opp = r.fold_to_cbet_flop_opp + excluded.fold_to_cbet_flop_opp,
    fold_to_cbet_flop = r.fold_to_cbet_flop + excluded.fold_to_cbet_flop, wtsd_opp = r.wtsd_opp + excluded.wtsd_opp,
    wtsd = r.wtsd + excluded.wtsd, wsd_opp = r.wsd_opp + excluded.wsd_opp,
    wsd = r.wsd + excluded.wsd, bets = r.bets + excluded.bets,
    raises = r.raises + excluded.raises, calls = r.calls + excluded.calls,
    folds = r.folds + excluded.folds, hero_hands = r.hero_hands + excluded.hero_hands,
    hero_money_hands = r.hero_money_hands + excluded.hero_money_hands, hero_net_bb_milli = r.hero_net_bb_milli + excluded.hero_net_bb_milli,
    first_played_at = case when r.seen_exact then least(r.first_played_at, excluded.first_played_at) else r.first_played_at end,
    last_played_at  = case when r.seen_exact then greatest(r.last_played_at, excluded.last_played_at) else r.last_played_at end;

  return null;
end;
$$;

create or replace function public.hand_stats_summaries_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One writer per account at a time from here to its commit: concurrent
  -- statements of one account add to the same rows, and a pair of rows of
  -- one hand written by two of them is counted by the later one only.
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from deleted order by 1) o;

  merge into public.hero_rollups r
  using (
    select
      x.owner_id as owner_id,
      x.stats_version as stats_version,
      coalesce((x.played_at at time zone 'UTC')::date, '-infinity'::date) as day,
      x.site_id as site_id,
      x.game_format as game_format,
      coalesce(x.variant, '') as variant,
      coalesce(x.limit_type, '') as limit_type,
      case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end as size,
      x.currency as currency,
      x.currency_minor_units as currency_minor_units,
      coalesce(x.small_blind, 0) as small_blind,
      coalesce(x.big_blind, 0) as big_blind,
      case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end as stake,
      coalesce(x."position", '') as "position",
      ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint as kind,
      sum(x.hands)::bigint as hands, sum(x.vpip_opp)::bigint as vpip_opp, sum(x.vpip)::bigint as vpip,
      sum(x.pfr_opp)::bigint as pfr_opp, sum(x.pfr)::bigint as pfr, sum(x.rfi_opp)::bigint as rfi_opp,
      sum(x.rfi)::bigint as rfi, sum(x.iso_opp)::bigint as iso_opp, sum(x.iso)::bigint as iso,
      sum(x.limp_opp)::bigint as limp_opp, sum(x.limp)::bigint as limp, sum(x.cold_call_opp)::bigint as cold_call_opp,
      sum(x.cold_call)::bigint as cold_call, sum(x.three_bet_opp)::bigint as three_bet_opp, sum(x.three_bet)::bigint as three_bet,
      sum(x.four_bet_opp)::bigint as four_bet_opp, sum(x.four_bet)::bigint as four_bet, sum(x.five_bet_opp)::bigint as five_bet_opp,
      sum(x.five_bet)::bigint as five_bet, sum(x.squeeze_opp)::bigint as squeeze_opp, sum(x.squeeze)::bigint as squeeze,
      sum(x.steal_opp)::bigint as steal_opp, sum(x.steal)::bigint as steal, sum(x.fold_to_steal_opp)::bigint as fold_to_steal_opp,
      sum(x.fold_to_steal)::bigint as fold_to_steal, sum(x.call_steal)::bigint as call_steal, sum(x.three_bet_vs_steal)::bigint as three_bet_vs_steal,
      sum(x.fold_to_three_bet_opp)::bigint as fold_to_three_bet_opp, sum(x.fold_to_three_bet)::bigint as fold_to_three_bet, sum(x.call_three_bet)::bigint as call_three_bet,
      sum(x.raise_vs_three_bet)::bigint as raise_vs_three_bet, sum(x.fold_to_four_bet_opp)::bigint as fold_to_four_bet_opp, sum(x.fold_to_four_bet)::bigint as fold_to_four_bet,
      sum(x.call_four_bet)::bigint as call_four_bet, sum(x.raise_vs_four_bet)::bigint as raise_vs_four_bet, sum(x.flop_seen)::bigint as flop_seen,
      sum(x.turn_seen)::bigint as turn_seen, sum(x.river_seen)::bigint as river_seen, sum(x.cbet_flop_opp)::bigint as cbet_flop_opp,
      sum(x.cbet_flop)::bigint as cbet_flop, sum(x.cbet_turn_opp)::bigint as cbet_turn_opp, sum(x.cbet_turn)::bigint as cbet_turn,
      sum(x.cbet_river_opp)::bigint as cbet_river_opp, sum(x.cbet_river)::bigint as cbet_river, sum(x.fold_to_cbet_flop_opp)::bigint as fold_to_cbet_flop_opp,
      sum(x.fold_to_cbet_flop)::bigint as fold_to_cbet_flop, sum(x.call_cbet_flop)::bigint as call_cbet_flop, sum(x.raise_cbet_flop)::bigint as raise_cbet_flop,
      sum(x.fold_to_cbet_turn_opp)::bigint as fold_to_cbet_turn_opp, sum(x.fold_to_cbet_turn)::bigint as fold_to_cbet_turn, sum(x.call_cbet_turn)::bigint as call_cbet_turn,
      sum(x.raise_cbet_turn)::bigint as raise_cbet_turn, sum(x.fold_to_cbet_river_opp)::bigint as fold_to_cbet_river_opp, sum(x.fold_to_cbet_river)::bigint as fold_to_cbet_river,
      sum(x.call_cbet_river)::bigint as call_cbet_river, sum(x.raise_cbet_river)::bigint as raise_cbet_river, sum(x.donk_flop_opp)::bigint as donk_flop_opp,
      sum(x.donk_flop)::bigint as donk_flop, sum(x.donk_turn_opp)::bigint as donk_turn_opp, sum(x.donk_turn)::bigint as donk_turn,
      sum(x.donk_river_opp)::bigint as donk_river_opp, sum(x.donk_river)::bigint as donk_river, sum(x.check_raise_flop_opp)::bigint as check_raise_flop_opp,
      sum(x.check_raise_flop)::bigint as check_raise_flop, sum(x.check_raise_turn_opp)::bigint as check_raise_turn_opp, sum(x.check_raise_turn)::bigint as check_raise_turn,
      sum(x.check_raise_river_opp)::bigint as check_raise_river_opp, sum(x.check_raise_river)::bigint as check_raise_river, sum(x.bet_flop)::bigint as bet_flop,
      sum(x.raise_flop)::bigint as raise_flop, sum(x.call_flop)::bigint as call_flop, sum(x.check_flop)::bigint as check_flop,
      sum(x.fold_flop)::bigint as fold_flop, sum(x.bet_turn)::bigint as bet_turn, sum(x.raise_turn)::bigint as raise_turn,
      sum(x.call_turn)::bigint as call_turn, sum(x.check_turn)::bigint as check_turn, sum(x.fold_turn)::bigint as fold_turn,
      sum(x.bet_river)::bigint as bet_river, sum(x.raise_river)::bigint as raise_river, sum(x.call_river)::bigint as call_river,
      sum(x.check_river)::bigint as check_river, sum(x.fold_river)::bigint as fold_river, sum(x.wwsf_opp)::bigint as wwsf_opp,
      sum(x.wwsf)::bigint as wwsf, sum(x.wtsd_opp)::bigint as wtsd_opp, sum(x.wtsd)::bigint as wtsd,
      sum(x.wsd_opp)::bigint as wsd_opp, sum(x.wsd)::bigint as wsd, sum(x.cashed_out)::bigint as cashed_out,
      sum(x.won)::bigint as won, sum(x.contributed)::bigint as contributed, sum(x.net)::bigint as net,
      sum(x.net_bb_milli)::bigint as net_bb_milli, sum(x.rake_paid)::bigint as rake_paid, sum(x.out_of_pot)::bigint as out_of_pot,
      sum(x.cashout_risk)::bigint as cashout_risk, sum((case when x.wtsd > 0 then x.net_bb_milli else 0 end))::bigint as sd_net_bb_milli, sum((case when x.wtsd > 0 then x.net else 0 end))::bigint as sd_net
    from deleted x
    where x.is_hero
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  ) d
  on r.owner_id = d.owner_id
    and r.stats_version = d.stats_version
    and r.day = d.day
    and r.site_id = d.site_id
    and r.game_format = d.game_format
    and r.variant = d.variant
    and r.limit_type = d.limit_type
    and r.size = d.size
    and r.currency = d.currency
    and r.currency_minor_units = d.currency_minor_units
    and r.small_blind = d.small_blind
    and r.big_blind = d.big_blind
    and r.stake = d.stake
    and r."position" = d."position"
    and r.kind = d.kind
  when matched and r.hands - d.hands <= 0 then delete
  when matched then update set
    hands = r.hands - d.hands, vpip_opp = r.vpip_opp - d.vpip_opp,
    vpip = r.vpip - d.vpip, pfr_opp = r.pfr_opp - d.pfr_opp,
    pfr = r.pfr - d.pfr, rfi_opp = r.rfi_opp - d.rfi_opp,
    rfi = r.rfi - d.rfi, iso_opp = r.iso_opp - d.iso_opp,
    iso = r.iso - d.iso, limp_opp = r.limp_opp - d.limp_opp,
    limp = r.limp - d.limp, cold_call_opp = r.cold_call_opp - d.cold_call_opp,
    cold_call = r.cold_call - d.cold_call, three_bet_opp = r.three_bet_opp - d.three_bet_opp,
    three_bet = r.three_bet - d.three_bet, four_bet_opp = r.four_bet_opp - d.four_bet_opp,
    four_bet = r.four_bet - d.four_bet, five_bet_opp = r.five_bet_opp - d.five_bet_opp,
    five_bet = r.five_bet - d.five_bet, squeeze_opp = r.squeeze_opp - d.squeeze_opp,
    squeeze = r.squeeze - d.squeeze, steal_opp = r.steal_opp - d.steal_opp,
    steal = r.steal - d.steal, fold_to_steal_opp = r.fold_to_steal_opp - d.fold_to_steal_opp,
    fold_to_steal = r.fold_to_steal - d.fold_to_steal, call_steal = r.call_steal - d.call_steal,
    three_bet_vs_steal = r.three_bet_vs_steal - d.three_bet_vs_steal, fold_to_three_bet_opp = r.fold_to_three_bet_opp - d.fold_to_three_bet_opp,
    fold_to_three_bet = r.fold_to_three_bet - d.fold_to_three_bet, call_three_bet = r.call_three_bet - d.call_three_bet,
    raise_vs_three_bet = r.raise_vs_three_bet - d.raise_vs_three_bet, fold_to_four_bet_opp = r.fold_to_four_bet_opp - d.fold_to_four_bet_opp,
    fold_to_four_bet = r.fold_to_four_bet - d.fold_to_four_bet, call_four_bet = r.call_four_bet - d.call_four_bet,
    raise_vs_four_bet = r.raise_vs_four_bet - d.raise_vs_four_bet, flop_seen = r.flop_seen - d.flop_seen,
    turn_seen = r.turn_seen - d.turn_seen, river_seen = r.river_seen - d.river_seen,
    cbet_flop_opp = r.cbet_flop_opp - d.cbet_flop_opp, cbet_flop = r.cbet_flop - d.cbet_flop,
    cbet_turn_opp = r.cbet_turn_opp - d.cbet_turn_opp, cbet_turn = r.cbet_turn - d.cbet_turn,
    cbet_river_opp = r.cbet_river_opp - d.cbet_river_opp, cbet_river = r.cbet_river - d.cbet_river,
    fold_to_cbet_flop_opp = r.fold_to_cbet_flop_opp - d.fold_to_cbet_flop_opp, fold_to_cbet_flop = r.fold_to_cbet_flop - d.fold_to_cbet_flop,
    call_cbet_flop = r.call_cbet_flop - d.call_cbet_flop, raise_cbet_flop = r.raise_cbet_flop - d.raise_cbet_flop,
    fold_to_cbet_turn_opp = r.fold_to_cbet_turn_opp - d.fold_to_cbet_turn_opp, fold_to_cbet_turn = r.fold_to_cbet_turn - d.fold_to_cbet_turn,
    call_cbet_turn = r.call_cbet_turn - d.call_cbet_turn, raise_cbet_turn = r.raise_cbet_turn - d.raise_cbet_turn,
    fold_to_cbet_river_opp = r.fold_to_cbet_river_opp - d.fold_to_cbet_river_opp, fold_to_cbet_river = r.fold_to_cbet_river - d.fold_to_cbet_river,
    call_cbet_river = r.call_cbet_river - d.call_cbet_river, raise_cbet_river = r.raise_cbet_river - d.raise_cbet_river,
    donk_flop_opp = r.donk_flop_opp - d.donk_flop_opp, donk_flop = r.donk_flop - d.donk_flop,
    donk_turn_opp = r.donk_turn_opp - d.donk_turn_opp, donk_turn = r.donk_turn - d.donk_turn,
    donk_river_opp = r.donk_river_opp - d.donk_river_opp, donk_river = r.donk_river - d.donk_river,
    check_raise_flop_opp = r.check_raise_flop_opp - d.check_raise_flop_opp, check_raise_flop = r.check_raise_flop - d.check_raise_flop,
    check_raise_turn_opp = r.check_raise_turn_opp - d.check_raise_turn_opp, check_raise_turn = r.check_raise_turn - d.check_raise_turn,
    check_raise_river_opp = r.check_raise_river_opp - d.check_raise_river_opp, check_raise_river = r.check_raise_river - d.check_raise_river,
    bet_flop = r.bet_flop - d.bet_flop, raise_flop = r.raise_flop - d.raise_flop,
    call_flop = r.call_flop - d.call_flop, check_flop = r.check_flop - d.check_flop,
    fold_flop = r.fold_flop - d.fold_flop, bet_turn = r.bet_turn - d.bet_turn,
    raise_turn = r.raise_turn - d.raise_turn, call_turn = r.call_turn - d.call_turn,
    check_turn = r.check_turn - d.check_turn, fold_turn = r.fold_turn - d.fold_turn,
    bet_river = r.bet_river - d.bet_river, raise_river = r.raise_river - d.raise_river,
    call_river = r.call_river - d.call_river, check_river = r.check_river - d.check_river,
    fold_river = r.fold_river - d.fold_river, wwsf_opp = r.wwsf_opp - d.wwsf_opp,
    wwsf = r.wwsf - d.wwsf, wtsd_opp = r.wtsd_opp - d.wtsd_opp,
    wtsd = r.wtsd - d.wtsd, wsd_opp = r.wsd_opp - d.wsd_opp,
    wsd = r.wsd - d.wsd, cashed_out = r.cashed_out - d.cashed_out,
    won = r.won - d.won, contributed = r.contributed - d.contributed,
    net = r.net - d.net, net_bb_milli = r.net_bb_milli - d.net_bb_milli,
    rake_paid = r.rake_paid - d.rake_paid, out_of_pot = r.out_of_pot - d.out_of_pot,
    cashout_risk = r.cashout_risk - d.cashout_risk, sd_net_bb_milli = r.sd_net_bb_milli - d.sd_net_bb_milli,
    sd_net = r.sd_net - d.sd_net;

  delete from public.hero_report_rows r
  using deleted d
  where d.is_hero and r.hand_id = d.hand_id and r.stats_version = d.stats_version and r.seat = d.seat;

  merge into public.player_stats r
  using (
  with t as (
    select distinct d.hand_id, d.stats_version from deleted d
  ),
  v as (
    -- The opponents' rows of the touched hands: the ones deleted, and the
    -- ones still there (whose pairs with a deleted hero row go).
    select
      d.hand_id,
      d.stats_version as v_version,
      d.played_at,
      d.owner_id as owner_id,
      d.stats_version as stats_version,
      d.site_id as site_id,
      case when d.site_anonymization = 'opaque-id' then '' else d.player end as player,
      d.site_anonymization as site_anonymization,
      d.game_format as game_format,
      coalesce(d.variant, '') as variant,
      coalesce(d.limit_type, '') as limit_type,
      case
      when coalesce(case when coalesce(d.max_seats, 0) >= 2 then d.max_seats else d.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(d.max_seats, 0) >= 2 then d.max_seats else d.player_count end <= 6 then '6max'
      else 'full'
    end as size,
      d.currency as currency,
      coalesce(d.big_blind, 0) as big_blind,
      d.hands::bigint as hands,
      d.vpip_opp::bigint as vpip_opp,
      d.vpip::bigint as vpip,
      d.pfr_opp::bigint as pfr_opp,
      d.pfr::bigint as pfr,
      d.three_bet_opp::bigint as three_bet_opp,
      d.three_bet::bigint as three_bet,
      d.fold_to_three_bet_opp::bigint as fold_to_three_bet_opp,
      d.fold_to_three_bet::bigint as fold_to_three_bet,
      d.cbet_flop_opp::bigint as cbet_flop_opp,
      d.cbet_flop::bigint as cbet_flop,
      d.fold_to_cbet_flop_opp::bigint as fold_to_cbet_flop_opp,
      d.fold_to_cbet_flop::bigint as fold_to_cbet_flop,
      d.wtsd_opp::bigint as wtsd_opp,
      d.wtsd::bigint as wtsd,
      d.wsd_opp::bigint as wsd_opp,
      d.wsd::bigint as wsd,
      (d.bet_flop + d.bet_turn + d.bet_river)::bigint as bets,
      (d.raise_flop + d.raise_turn + d.raise_river)::bigint as raises,
      (d.call_flop + d.call_turn + d.call_river)::bigint as calls,
      (d.fold_flop + d.fold_turn + d.fold_river)::bigint as folds,
      true as fresh
    from deleted d
    where not d.is_hero and not d.is_bomb_pot and d.player <> ''
    union all
    select
      s.hand_id,
      s.stats_version as v_version,
      s.played_at,
      s.owner_id as owner_id,
      s.stats_version as stats_version,
      s.site_id as site_id,
      case when s.site_anonymization = 'opaque-id' then '' else s.player end as player,
      s.site_anonymization as site_anonymization,
      s.game_format as game_format,
      coalesce(s.variant, '') as variant,
      coalesce(s.limit_type, '') as limit_type,
      case
      when coalesce(case when coalesce(s.max_seats, 0) >= 2 then s.max_seats else s.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(s.max_seats, 0) >= 2 then s.max_seats else s.player_count end <= 6 then '6max'
      else 'full'
    end as size,
      s.currency as currency,
      coalesce(s.big_blind, 0) as big_blind,
      s.hands::bigint as hands,
      s.vpip_opp::bigint as vpip_opp,
      s.vpip::bigint as vpip,
      s.pfr_opp::bigint as pfr_opp,
      s.pfr::bigint as pfr,
      s.three_bet_opp::bigint as three_bet_opp,
      s.three_bet::bigint as three_bet,
      s.fold_to_three_bet_opp::bigint as fold_to_three_bet_opp,
      s.fold_to_three_bet::bigint as fold_to_three_bet,
      s.cbet_flop_opp::bigint as cbet_flop_opp,
      s.cbet_flop::bigint as cbet_flop,
      s.fold_to_cbet_flop_opp::bigint as fold_to_cbet_flop_opp,
      s.fold_to_cbet_flop::bigint as fold_to_cbet_flop,
      s.wtsd_opp::bigint as wtsd_opp,
      s.wtsd::bigint as wtsd,
      s.wsd_opp::bigint as wsd_opp,
      s.wsd::bigint as wsd,
      (s.bet_flop + s.bet_turn + s.bet_river)::bigint as bets,
      (s.raise_flop + s.raise_turn + s.raise_river)::bigint as raises,
      (s.call_flop + s.call_turn + s.call_river)::bigint as calls,
      (s.fold_flop + s.fold_turn + s.fold_river)::bigint as folds,
      false
    from t
    join public.hand_stats s on s.hand_id = t.hand_id and s.stats_version = t.stats_version
    where not s.is_hero and not s.is_bomb_pot and s.player <> ''
  ),
  h as (
    select d.hand_id, d.stats_version, d.has_cashout, d.net_bb_milli, true as fresh
    from deleted d
    where d.is_hero
    union all
    select s.hand_id, s.stats_version, s.has_cashout, s.net_bb_milli, false
    from t
    join public.hand_stats s on s.hand_id = t.hand_id and s.stats_version = t.stats_version
    where s.is_hero
  ),
  c as (
    select
      v.owner_id, v.stats_version, v.site_id, v.player, v.site_anonymization, v.game_format,
      v.variant, v.limit_type, v.size, v.currency, v.big_blind,
      v.hands, v.vpip_opp, v.vpip, v.pfr_opp, v.pfr, v.three_bet_opp,
      v.three_bet, v.fold_to_three_bet_opp, v.fold_to_three_bet, v.cbet_flop_opp, v.cbet_flop, v.fold_to_cbet_flop_opp,
      v.fold_to_cbet_flop, v.wtsd_opp, v.wtsd, v.wsd_opp, v.wsd, v.bets,
      v.raises, v.calls, v.folds,
      0::bigint as hero_hands, 0::bigint as hero_money_hands, 0::bigint as hero_net_bb_milli,
      v.played_at
    from v
    where v.fresh
    union all
    select
      v.owner_id, v.stats_version, v.site_id, v.player, v.site_anonymization, v.game_format,
      v.variant, v.limit_type, v.size, v.currency, v.big_blind,
      0::bigint as hands, 0::bigint as vpip_opp, 0::bigint as vpip, 0::bigint as pfr_opp, 0::bigint as pfr, 0::bigint as three_bet_opp,
      0::bigint as three_bet, 0::bigint as fold_to_three_bet_opp, 0::bigint as fold_to_three_bet, 0::bigint as cbet_flop_opp, 0::bigint as cbet_flop, 0::bigint as fold_to_cbet_flop_opp,
      0::bigint as fold_to_cbet_flop, 0::bigint as wtsd_opp, 0::bigint as wtsd, 0::bigint as wsd_opp, 0::bigint as wsd, 0::bigint as bets,
      0::bigint as raises, 0::bigint as calls, 0::bigint as folds,
      1::bigint,
      case when h.has_cashout then 0 else 1 end::bigint,
      case when h.has_cashout then 0 else h.net_bb_milli end::bigint,
      null::timestamptz
    from v
    join h on h.hand_id = v.hand_id and h.stats_version = v.v_version
    where v.fresh or h.fresh
  ),
  a as (
    select
      c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format,
      c.variant, c.limit_type, c.size, c.currency, c.big_blind,
      sum(c.hands)::bigint as hands, sum(c.vpip_opp)::bigint as vpip_opp, sum(c.vpip)::bigint as vpip,
      sum(c.pfr_opp)::bigint as pfr_opp, sum(c.pfr)::bigint as pfr, sum(c.three_bet_opp)::bigint as three_bet_opp,
      sum(c.three_bet)::bigint as three_bet, sum(c.fold_to_three_bet_opp)::bigint as fold_to_three_bet_opp, sum(c.fold_to_three_bet)::bigint as fold_to_three_bet,
      sum(c.cbet_flop_opp)::bigint as cbet_flop_opp, sum(c.cbet_flop)::bigint as cbet_flop, sum(c.fold_to_cbet_flop_opp)::bigint as fold_to_cbet_flop_opp,
      sum(c.fold_to_cbet_flop)::bigint as fold_to_cbet_flop, sum(c.wtsd_opp)::bigint as wtsd_opp, sum(c.wtsd)::bigint as wtsd,
      sum(c.wsd_opp)::bigint as wsd_opp, sum(c.wsd)::bigint as wsd, sum(c.bets)::bigint as bets,
      sum(c.raises)::bigint as raises, sum(c.calls)::bigint as calls, sum(c.folds)::bigint as folds,
      sum(c.hero_hands)::bigint as hero_hands, sum(c.hero_money_hands)::bigint as hero_money_hands, sum(c.hero_net_bb_milli)::bigint as hero_net_bb_milli
    from c
    group by c.owner_id, c.stats_version, c.site_id, c.player, c.site_anonymization, c.game_format, c.variant, c.limit_type, c.size, c.currency, c.big_blind
  )
  select
    a.owner_id, a.stats_version, a.site_id, a.player, a.site_anonymization, a.game_format,
    a.variant, a.limit_type, a.size, a.currency, a.big_blind,
    a.hands, a.vpip_opp, a.vpip, a.pfr_opp, a.pfr, a.three_bet_opp,
    a.three_bet, a.fold_to_three_bet_opp, a.fold_to_three_bet, a.cbet_flop_opp, a.cbet_flop, a.fold_to_cbet_flop_opp,
    a.fold_to_cbet_flop, a.wtsd_opp, a.wtsd, a.wsd_opp, a.wsd, a.bets,
    a.raises, a.calls, a.folds, a.hero_hands, a.hero_money_hands, a.hero_net_bb_milli
  from a
  order by a.owner_id, a.stats_version, a.site_id, a.player, a.site_anonymization, a.game_format, a.variant, a.limit_type, a.size, a.currency, a.big_blind
  ) a
  on r.owner_id = a.owner_id
    and r.stats_version = a.stats_version
    and r.site_id = a.site_id
    and r.player = a.player
    and r.site_anonymization = a.site_anonymization
    and r.game_format = a.game_format
    and r.variant = a.variant
    and r.limit_type = a.limit_type
    and r.size = a.size
    and r.currency = a.currency
    and r.big_blind = a.big_blind
  when matched and r.hands - a.hands <= 0 then delete
  when matched then update set
    hands = r.hands - a.hands, vpip_opp = r.vpip_opp - a.vpip_opp,
    vpip = r.vpip - a.vpip, pfr_opp = r.pfr_opp - a.pfr_opp,
    pfr = r.pfr - a.pfr, three_bet_opp = r.three_bet_opp - a.three_bet_opp,
    three_bet = r.three_bet - a.three_bet, fold_to_three_bet_opp = r.fold_to_three_bet_opp - a.fold_to_three_bet_opp,
    fold_to_three_bet = r.fold_to_three_bet - a.fold_to_three_bet, cbet_flop_opp = r.cbet_flop_opp - a.cbet_flop_opp,
    cbet_flop = r.cbet_flop - a.cbet_flop, fold_to_cbet_flop_opp = r.fold_to_cbet_flop_opp - a.fold_to_cbet_flop_opp,
    fold_to_cbet_flop = r.fold_to_cbet_flop - a.fold_to_cbet_flop, wtsd_opp = r.wtsd_opp - a.wtsd_opp,
    wtsd = r.wtsd - a.wtsd, wsd_opp = r.wsd_opp - a.wsd_opp,
    wsd = r.wsd - a.wsd, bets = r.bets - a.bets,
    raises = r.raises - a.raises, calls = r.calls - a.calls,
    folds = r.folds - a.folds, hero_hands = r.hero_hands - a.hero_hands,
    hero_money_hands = r.hero_money_hands - a.hero_money_hands, hero_net_bb_milli = r.hero_net_bb_milli - a.hero_net_bb_milli,
    seen_exact = r.seen_exact and a.hands = 0;

  return null;
end;
$$;

-- Nothing updates `hand_stats` (no grant, no function); a hand fixed by
-- hand as `postgres` gets its owner's summaries counted again.
create or replace function public.hand_stats_summaries_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  for v_owner in
    select owner_id from old_rows union select owner_id from new_rows
  loop
    perform public.report_summaries_rebuild(v_owner);
  end loop;
  return null;
end;
$$;

create or replace function public.hand_stats_summaries_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  truncate public.hero_rollups, public.hero_report_rows, public.player_stats;
  return null;
end;
$$;

revoke all on function public.hand_stats_summaries_insert() from public, anon, authenticated;
revoke all on function public.hand_stats_summaries_delete() from public, anon, authenticated;
revoke all on function public.hand_stats_summaries_update() from public, anon, authenticated;
revoke all on function public.hand_stats_summaries_truncate() from public, anon, authenticated;

create trigger hand_stats_summaries_after_insert
  after insert on public.hand_stats
  referencing new table as inserted
  for each statement execute function public.hand_stats_summaries_insert();

create trigger hand_stats_summaries_after_delete
  after delete on public.hand_stats
  referencing old table as deleted
  for each statement execute function public.hand_stats_summaries_delete();

create trigger hand_stats_summaries_after_update
  after update on public.hand_stats
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.hand_stats_summaries_update();

create trigger hand_stats_summaries_after_truncate
  after truncate on public.hand_stats
  for each statement execute function public.hand_stats_summaries_truncate();

-- ---------------------------------------------------------------------------
-- 3. Indexes for what the summaries cannot answer
-- ---------------------------------------------------------------------------

-- An account's EV rows: the all-in ones (`applicable`, the few the EV line
-- and the summary's adjustment read) and, for the count of hands still
-- waiting for theirs, all of them - index-only either way.
create index hand_stats_ev_owner_idx on public.hand_stats_ev (owner_id, ev_version, applicable)
  include (hand_id, seat, ev_net_bb_milli);

-- The hands without a hero seat (an observed table), counted by
-- `stats_coverage`.
create index hands_owner_no_hero_idx on public.hands (owner_id) where hero_seat is null;

-- The same visibility-map point as `hero_report_rows`: an account's EV rows
-- and hands are counted index-only.
alter table public.hand_stats_ev set (
  autovacuum_vacuum_insert_threshold = 20000,
  autovacuum_vacuum_insert_scale_factor = 0.01
);
alter table public.hands set (
  autovacuum_vacuum_insert_threshold = 20000,
  autovacuum_vacuum_insert_scale_factor = 0.01
);

-- ---------------------------------------------------------------------------
-- 4. The readers
-- ---------------------------------------------------------------------------

create or replace function public.report_open(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Planned per call: the predicates of the groups that are not set fold away
-- (R4.5b's lesson: a cached generic plan keeps them all).
set plan_cache_mode = force_custom_plan
-- A report sums up to a million rows into a few thousand groups: with the
-- default few MB the planner sorts them on disk instead of hashing.
set work_mem = '64MB'
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_ev        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_from      timestamptz;
  v_to        timestamptz;
  v_from_day  date;
  v_to_day    date;
  v_from_at   timestamptz;
  v_to_at     timestamptz;
  v_bomb      boolean;
  v_straddle  boolean;
  v_cashouts  boolean;
  v_total     jsonb;
  v_groups    jsonb;
  v_mixed_kind     boolean;
  v_mixed_currency boolean;
  v_ev_delta  bigint;
  v_all_in    bigint;
begin
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_from      := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  v_cashouts  := coalesce(case when jsonb_typeof(v_filter -> 'includeCashouts') = 'boolean' then (v_filter ->> 'includeCashouts')::boolean end, false);
  -- The formats as the enum (an unknown one matches nothing) and the kinds
  -- the options let in, as lists: predicates the planner can estimate
  -- (`kind & 1 = 0` it cannot, and a plan built for ten rows sorts a million).
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));
  -- Whole UTC days come from the rollup: from the first midnight at or after
  -- `from` to the last one at or before `to`; the rest of the range (the
  -- partial days at its two ends) from the hero's rows.
  if v_from is not null then
    v_from_day := (v_from at time zone 'UTC')::date
                  + case when (v_from at time zone 'UTC')::time = '00:00' then 0 else 1 end;
  end if;
  if v_to is not null then
    v_to_day := (v_to at time zone 'UTC')::date;
  end if;
  v_from_at := coalesce(v_from_day::timestamp at time zone 'UTC', '-infinity'::timestamptz);
  v_to_at   := coalesce(v_to_day::timestamp at time zone 'UTC', 'infinity'::timestamptz);
  if v_owner is null then
    return jsonb_build_object('statsVersion', v_version, 'evVersion', v_ev, 'hands', 0, 'moneyHands', 0,
      'mixedCurrency', false, 'mixedUnitKind', false, 'currency', null, 'currencyMinorUnits', null,
      'total', null, 'groups', '{}'::jsonb, 'allInHands', 0);
  end if;

  -- The rows summed once per (position, stake, size, room, format,
  -- currency, kind) - a few thousand at most - then split five ways.
  with f0 as (
      select z."position", z.size, z.site_id, z.game_format, z.currency, z.stake, z.kind, min(z.currency_minor_units) as currency_minor_units, sum(z.hands) as hands, sum(z.vpip_opp) as vpip_opp, sum(z.vpip) as vpip, sum(z.pfr_opp) as pfr_opp, sum(z.pfr) as pfr, sum(z.rfi_opp) as rfi_opp, sum(z.rfi) as rfi, sum(z.iso_opp) as iso_opp, sum(z.iso) as iso, sum(z.limp_opp) as limp_opp, sum(z.limp) as limp, sum(z.cold_call_opp) as cold_call_opp, sum(z.cold_call) as cold_call, sum(z.three_bet_opp) as three_bet_opp, sum(z.three_bet) as three_bet, sum(z.four_bet_opp) as four_bet_opp, sum(z.four_bet) as four_bet, sum(z.five_bet_opp) as five_bet_opp, sum(z.five_bet) as five_bet, sum(z.squeeze_opp) as squeeze_opp, sum(z.squeeze) as squeeze, sum(z.steal_opp) as steal_opp, sum(z.steal) as steal, sum(z.fold_to_steal_opp) as fold_to_steal_opp, sum(z.fold_to_steal) as fold_to_steal, sum(z.call_steal) as call_steal, sum(z.three_bet_vs_steal) as three_bet_vs_steal, sum(z.fold_to_three_bet_opp) as fold_to_three_bet_opp, sum(z.fold_to_three_bet) as fold_to_three_bet, sum(z.call_three_bet) as call_three_bet, sum(z.raise_vs_three_bet) as raise_vs_three_bet, sum(z.fold_to_four_bet_opp) as fold_to_four_bet_opp, sum(z.fold_to_four_bet) as fold_to_four_bet, sum(z.call_four_bet) as call_four_bet, sum(z.raise_vs_four_bet) as raise_vs_four_bet, sum(z.flop_seen) as flop_seen, sum(z.turn_seen) as turn_seen, sum(z.river_seen) as river_seen, sum(z.cbet_flop_opp) as cbet_flop_opp, sum(z.cbet_flop) as cbet_flop, sum(z.cbet_turn_opp) as cbet_turn_opp, sum(z.cbet_turn) as cbet_turn, sum(z.cbet_river_opp) as cbet_river_opp, sum(z.cbet_river) as cbet_river, sum(z.fold_to_cbet_flop_opp) as fold_to_cbet_flop_opp, sum(z.fold_to_cbet_flop) as fold_to_cbet_flop, sum(z.call_cbet_flop) as call_cbet_flop, sum(z.raise_cbet_flop) as raise_cbet_flop, sum(z.fold_to_cbet_turn_opp) as fold_to_cbet_turn_opp, sum(z.fold_to_cbet_turn) as fold_to_cbet_turn, sum(z.call_cbet_turn) as call_cbet_turn, sum(z.raise_cbet_turn) as raise_cbet_turn, sum(z.fold_to_cbet_river_opp) as fold_to_cbet_river_opp, sum(z.fold_to_cbet_river) as fold_to_cbet_river, sum(z.call_cbet_river) as call_cbet_river, sum(z.raise_cbet_river) as raise_cbet_river, sum(z.donk_flop_opp) as donk_flop_opp, sum(z.donk_flop) as donk_flop, sum(z.donk_turn_opp) as donk_turn_opp, sum(z.donk_turn) as donk_turn, sum(z.donk_river_opp) as donk_river_opp, sum(z.donk_river) as donk_river, sum(z.check_raise_flop_opp) as check_raise_flop_opp, sum(z.check_raise_flop) as check_raise_flop, sum(z.check_raise_turn_opp) as check_raise_turn_opp, sum(z.check_raise_turn) as check_raise_turn, sum(z.check_raise_river_opp) as check_raise_river_opp, sum(z.check_raise_river) as check_raise_river, sum(z.bet_flop) as bet_flop, sum(z.raise_flop) as raise_flop, sum(z.call_flop) as call_flop, sum(z.check_flop) as check_flop, sum(z.fold_flop) as fold_flop, sum(z.bet_turn) as bet_turn, sum(z.raise_turn) as raise_turn, sum(z.call_turn) as call_turn, sum(z.check_turn) as check_turn, sum(z.fold_turn) as fold_turn, sum(z.bet_river) as bet_river, sum(z.raise_river) as raise_river, sum(z.call_river) as call_river, sum(z.check_river) as check_river, sum(z.fold_river) as fold_river, sum(z.wwsf_opp) as wwsf_opp, sum(z.wwsf) as wwsf, sum(z.wtsd_opp) as wtsd_opp, sum(z.wtsd) as wtsd, sum(z.wsd_opp) as wsd_opp, sum(z.wsd) as wsd, sum(z.cashed_out) as cashed_out, sum(z.won) as won, sum(z.contributed) as contributed, sum(z.net) as net, sum(z.net_bb_milli) as net_bb_milli, sum(z.rake_paid) as rake_paid, sum(z.out_of_pot) as out_of_pot, sum(z.cashout_risk) as cashout_risk
      from (
        select r."position", r.size, r.site_id, r.game_format, r.currency, r.stake, r.kind, min(r.currency_minor_units) as currency_minor_units, sum(r.hands) as hands, sum(r.vpip_opp) as vpip_opp, sum(r.vpip) as vpip, sum(r.pfr_opp) as pfr_opp, sum(r.pfr) as pfr, sum(r.rfi_opp) as rfi_opp, sum(r.rfi) as rfi, sum(r.iso_opp) as iso_opp, sum(r.iso) as iso, sum(r.limp_opp) as limp_opp, sum(r.limp) as limp, sum(r.cold_call_opp) as cold_call_opp, sum(r.cold_call) as cold_call, sum(r.three_bet_opp) as three_bet_opp, sum(r.three_bet) as three_bet, sum(r.four_bet_opp) as four_bet_opp, sum(r.four_bet) as four_bet, sum(r.five_bet_opp) as five_bet_opp, sum(r.five_bet) as five_bet, sum(r.squeeze_opp) as squeeze_opp, sum(r.squeeze) as squeeze, sum(r.steal_opp) as steal_opp, sum(r.steal) as steal, sum(r.fold_to_steal_opp) as fold_to_steal_opp, sum(r.fold_to_steal) as fold_to_steal, sum(r.call_steal) as call_steal, sum(r.three_bet_vs_steal) as three_bet_vs_steal, sum(r.fold_to_three_bet_opp) as fold_to_three_bet_opp, sum(r.fold_to_three_bet) as fold_to_three_bet, sum(r.call_three_bet) as call_three_bet, sum(r.raise_vs_three_bet) as raise_vs_three_bet, sum(r.fold_to_four_bet_opp) as fold_to_four_bet_opp, sum(r.fold_to_four_bet) as fold_to_four_bet, sum(r.call_four_bet) as call_four_bet, sum(r.raise_vs_four_bet) as raise_vs_four_bet, sum(r.flop_seen) as flop_seen, sum(r.turn_seen) as turn_seen, sum(r.river_seen) as river_seen, sum(r.cbet_flop_opp) as cbet_flop_opp, sum(r.cbet_flop) as cbet_flop, sum(r.cbet_turn_opp) as cbet_turn_opp, sum(r.cbet_turn) as cbet_turn, sum(r.cbet_river_opp) as cbet_river_opp, sum(r.cbet_river) as cbet_river, sum(r.fold_to_cbet_flop_opp) as fold_to_cbet_flop_opp, sum(r.fold_to_cbet_flop) as fold_to_cbet_flop, sum(r.call_cbet_flop) as call_cbet_flop, sum(r.raise_cbet_flop) as raise_cbet_flop, sum(r.fold_to_cbet_turn_opp) as fold_to_cbet_turn_opp, sum(r.fold_to_cbet_turn) as fold_to_cbet_turn, sum(r.call_cbet_turn) as call_cbet_turn, sum(r.raise_cbet_turn) as raise_cbet_turn, sum(r.fold_to_cbet_river_opp) as fold_to_cbet_river_opp, sum(r.fold_to_cbet_river) as fold_to_cbet_river, sum(r.call_cbet_river) as call_cbet_river, sum(r.raise_cbet_river) as raise_cbet_river, sum(r.donk_flop_opp) as donk_flop_opp, sum(r.donk_flop) as donk_flop, sum(r.donk_turn_opp) as donk_turn_opp, sum(r.donk_turn) as donk_turn, sum(r.donk_river_opp) as donk_river_opp, sum(r.donk_river) as donk_river, sum(r.check_raise_flop_opp) as check_raise_flop_opp, sum(r.check_raise_flop) as check_raise_flop, sum(r.check_raise_turn_opp) as check_raise_turn_opp, sum(r.check_raise_turn) as check_raise_turn, sum(r.check_raise_river_opp) as check_raise_river_opp, sum(r.check_raise_river) as check_raise_river, sum(r.bet_flop) as bet_flop, sum(r.raise_flop) as raise_flop, sum(r.call_flop) as call_flop, sum(r.check_flop) as check_flop, sum(r.fold_flop) as fold_flop, sum(r.bet_turn) as bet_turn, sum(r.raise_turn) as raise_turn, sum(r.call_turn) as call_turn, sum(r.check_turn) as check_turn, sum(r.fold_turn) as fold_turn, sum(r.bet_river) as bet_river, sum(r.raise_river) as raise_river, sum(r.call_river) as call_river, sum(r.check_river) as check_river, sum(r.fold_river) as fold_river, sum(r.wwsf_opp) as wwsf_opp, sum(r.wwsf) as wwsf, sum(r.wtsd_opp) as wtsd_opp, sum(r.wtsd) as wtsd, sum(r.wsd_opp) as wsd_opp, sum(r.wsd) as wsd, sum(r.cashed_out) as cashed_out, sum(r.won) as won, sum(r.contributed) as contributed, sum(r.net) as net, sum(r.net_bb_milli) as net_bb_milli, sum(r.rake_paid) as rake_paid, sum(r.out_of_pot) as out_of_pot, sum(r.cashout_risk) as cashout_risk
        from public.hero_rollups r
        where r.owner_id = v_owner and r.stats_version = v_version
          and ((v_from is null and v_to is null)
               or (r.day > '-infinity'::date
                   and (v_from_day is null or r.day >= v_from_day)
                   and (v_to_day is null or r.day < v_to_day)))
          and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
        group by 1, 2, 3, 4, 5, 6, 7
        union all
        select coalesce(x."position", '') as "position", case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end as size, x.site_id as site_id, x.game_format as game_format, x.currency as currency, case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end as stake, ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint as kind, min(x.currency_minor_units) as currency_minor_units, sum(x.hands) as hands, sum(x.vpip_opp) as vpip_opp, sum(x.vpip) as vpip, sum(x.pfr_opp) as pfr_opp, sum(x.pfr) as pfr, sum(x.rfi_opp) as rfi_opp, sum(x.rfi) as rfi, sum(x.iso_opp) as iso_opp, sum(x.iso) as iso, sum(x.limp_opp) as limp_opp, sum(x.limp) as limp, sum(x.cold_call_opp) as cold_call_opp, sum(x.cold_call) as cold_call, sum(x.three_bet_opp) as three_bet_opp, sum(x.three_bet) as three_bet, sum(x.four_bet_opp) as four_bet_opp, sum(x.four_bet) as four_bet, sum(x.five_bet_opp) as five_bet_opp, sum(x.five_bet) as five_bet, sum(x.squeeze_opp) as squeeze_opp, sum(x.squeeze) as squeeze, sum(x.steal_opp) as steal_opp, sum(x.steal) as steal, sum(x.fold_to_steal_opp) as fold_to_steal_opp, sum(x.fold_to_steal) as fold_to_steal, sum(x.call_steal) as call_steal, sum(x.three_bet_vs_steal) as three_bet_vs_steal, sum(x.fold_to_three_bet_opp) as fold_to_three_bet_opp, sum(x.fold_to_three_bet) as fold_to_three_bet, sum(x.call_three_bet) as call_three_bet, sum(x.raise_vs_three_bet) as raise_vs_three_bet, sum(x.fold_to_four_bet_opp) as fold_to_four_bet_opp, sum(x.fold_to_four_bet) as fold_to_four_bet, sum(x.call_four_bet) as call_four_bet, sum(x.raise_vs_four_bet) as raise_vs_four_bet, sum(x.flop_seen) as flop_seen, sum(x.turn_seen) as turn_seen, sum(x.river_seen) as river_seen, sum(x.cbet_flop_opp) as cbet_flop_opp, sum(x.cbet_flop) as cbet_flop, sum(x.cbet_turn_opp) as cbet_turn_opp, sum(x.cbet_turn) as cbet_turn, sum(x.cbet_river_opp) as cbet_river_opp, sum(x.cbet_river) as cbet_river, sum(x.fold_to_cbet_flop_opp) as fold_to_cbet_flop_opp, sum(x.fold_to_cbet_flop) as fold_to_cbet_flop, sum(x.call_cbet_flop) as call_cbet_flop, sum(x.raise_cbet_flop) as raise_cbet_flop, sum(x.fold_to_cbet_turn_opp) as fold_to_cbet_turn_opp, sum(x.fold_to_cbet_turn) as fold_to_cbet_turn, sum(x.call_cbet_turn) as call_cbet_turn, sum(x.raise_cbet_turn) as raise_cbet_turn, sum(x.fold_to_cbet_river_opp) as fold_to_cbet_river_opp, sum(x.fold_to_cbet_river) as fold_to_cbet_river, sum(x.call_cbet_river) as call_cbet_river, sum(x.raise_cbet_river) as raise_cbet_river, sum(x.donk_flop_opp) as donk_flop_opp, sum(x.donk_flop) as donk_flop, sum(x.donk_turn_opp) as donk_turn_opp, sum(x.donk_turn) as donk_turn, sum(x.donk_river_opp) as donk_river_opp, sum(x.donk_river) as donk_river, sum(x.check_raise_flop_opp) as check_raise_flop_opp, sum(x.check_raise_flop) as check_raise_flop, sum(x.check_raise_turn_opp) as check_raise_turn_opp, sum(x.check_raise_turn) as check_raise_turn, sum(x.check_raise_river_opp) as check_raise_river_opp, sum(x.check_raise_river) as check_raise_river, sum(x.bet_flop) as bet_flop, sum(x.raise_flop) as raise_flop, sum(x.call_flop) as call_flop, sum(x.check_flop) as check_flop, sum(x.fold_flop) as fold_flop, sum(x.bet_turn) as bet_turn, sum(x.raise_turn) as raise_turn, sum(x.call_turn) as call_turn, sum(x.check_turn) as check_turn, sum(x.fold_turn) as fold_turn, sum(x.bet_river) as bet_river, sum(x.raise_river) as raise_river, sum(x.call_river) as call_river, sum(x.check_river) as check_river, sum(x.fold_river) as fold_river, sum(x.wwsf_opp) as wwsf_opp, sum(x.wwsf) as wwsf, sum(x.wtsd_opp) as wtsd_opp, sum(x.wtsd) as wtsd, sum(x.wsd_opp) as wsd_opp, sum(x.wsd) as wsd, sum(x.cashed_out) as cashed_out, sum(x.won) as won, sum(x.contributed) as contributed, sum(x.net) as net, sum(x.net_bb_milli) as net_bb_milli, sum(x.rake_paid) as rake_paid, sum(x.out_of_pot) as out_of_pot, sum(x.cashout_risk) as cashout_risk
        from public.hand_stats x
        where x.owner_id = v_owner and x.stats_version = v_version and x.is_hero
          and (v_from is not null or v_to is not null)
          and x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
          and x.played_at < coalesce(v_to, 'infinity'::timestamptz)
          and not (x.played_at >= v_from_at and x.played_at < v_to_at)
          and (cardinality(v_sites) = 0 or x.site_id = any (v_sites))
          and (not v_fmt_set or x.game_format = any (v_fmt_enum))
          and (cardinality(v_variants) = 0 or coalesce(x.variant, '') = any (v_variants))
          and (cardinality(v_limits) = 0 or coalesce(x.limit_type, '') = any (v_limits))
          and (cardinality(v_sizes) = 0 or case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end = any (v_sizes))
          and (cardinality(v_stakes) = 0 or case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end = any (v_stakes))
          and (cardinality(v_positions) = 0 or coalesce(x."position", '') = any (v_positions))
          and (v_bomb or not x.is_bomb_pot)
          and (v_straddle or not x.has_straddle)
        group by 1, 2, 3, 4, 5, 6, 7
      ) z
      group by z."position", z.size, z.site_id, z.game_format, z.currency, z.stake, z.kind
  ),
  f as (
    select f0.* from f0
  ),
  g as (
    select
      case
        when grouping(f."position") = 0 then 'position'
        when grouping(f.stake) = 0 then 'stake'
        when grouping(f.size) = 0 then 'size'
        when grouping(f.site_id) = 0 then 'site'
        when grouping(f.game_format) = 0 then 'format'
        else 'total'
      end as dim,
      coalesce(f."position", f.stake, f.size, f.site_id, f.game_format::text) as key,
      coalesce(sum(f.hands), 0)::bigint as hands, coalesce(sum(f.vpip_opp), 0)::bigint as vpip_opp, coalesce(sum(f.vpip), 0)::bigint as vpip,
      coalesce(sum(f.pfr_opp), 0)::bigint as pfr_opp, coalesce(sum(f.pfr), 0)::bigint as pfr, coalesce(sum(f.rfi_opp), 0)::bigint as rfi_opp,
      coalesce(sum(f.rfi), 0)::bigint as rfi, coalesce(sum(f.iso_opp), 0)::bigint as iso_opp, coalesce(sum(f.iso), 0)::bigint as iso,
      coalesce(sum(f.limp_opp), 0)::bigint as limp_opp, coalesce(sum(f.limp), 0)::bigint as limp, coalesce(sum(f.cold_call_opp), 0)::bigint as cold_call_opp,
      coalesce(sum(f.cold_call), 0)::bigint as cold_call, coalesce(sum(f.three_bet_opp), 0)::bigint as three_bet_opp, coalesce(sum(f.three_bet), 0)::bigint as three_bet,
      coalesce(sum(f.four_bet_opp), 0)::bigint as four_bet_opp, coalesce(sum(f.four_bet), 0)::bigint as four_bet, coalesce(sum(f.five_bet_opp), 0)::bigint as five_bet_opp,
      coalesce(sum(f.five_bet), 0)::bigint as five_bet, coalesce(sum(f.squeeze_opp), 0)::bigint as squeeze_opp, coalesce(sum(f.squeeze), 0)::bigint as squeeze,
      coalesce(sum(f.steal_opp), 0)::bigint as steal_opp, coalesce(sum(f.steal), 0)::bigint as steal, coalesce(sum(f.fold_to_steal_opp), 0)::bigint as fold_to_steal_opp,
      coalesce(sum(f.fold_to_steal), 0)::bigint as fold_to_steal, coalesce(sum(f.call_steal), 0)::bigint as call_steal, coalesce(sum(f.three_bet_vs_steal), 0)::bigint as three_bet_vs_steal,
      coalesce(sum(f.fold_to_three_bet_opp), 0)::bigint as fold_to_three_bet_opp, coalesce(sum(f.fold_to_three_bet), 0)::bigint as fold_to_three_bet, coalesce(sum(f.call_three_bet), 0)::bigint as call_three_bet,
      coalesce(sum(f.raise_vs_three_bet), 0)::bigint as raise_vs_three_bet, coalesce(sum(f.fold_to_four_bet_opp), 0)::bigint as fold_to_four_bet_opp, coalesce(sum(f.fold_to_four_bet), 0)::bigint as fold_to_four_bet,
      coalesce(sum(f.call_four_bet), 0)::bigint as call_four_bet, coalesce(sum(f.raise_vs_four_bet), 0)::bigint as raise_vs_four_bet, coalesce(sum(f.flop_seen), 0)::bigint as flop_seen,
      coalesce(sum(f.turn_seen), 0)::bigint as turn_seen, coalesce(sum(f.river_seen), 0)::bigint as river_seen, coalesce(sum(f.cbet_flop_opp), 0)::bigint as cbet_flop_opp,
      coalesce(sum(f.cbet_flop), 0)::bigint as cbet_flop, coalesce(sum(f.cbet_turn_opp), 0)::bigint as cbet_turn_opp, coalesce(sum(f.cbet_turn), 0)::bigint as cbet_turn,
      coalesce(sum(f.cbet_river_opp), 0)::bigint as cbet_river_opp, coalesce(sum(f.cbet_river), 0)::bigint as cbet_river, coalesce(sum(f.fold_to_cbet_flop_opp), 0)::bigint as fold_to_cbet_flop_opp,
      coalesce(sum(f.fold_to_cbet_flop), 0)::bigint as fold_to_cbet_flop, coalesce(sum(f.call_cbet_flop), 0)::bigint as call_cbet_flop, coalesce(sum(f.raise_cbet_flop), 0)::bigint as raise_cbet_flop,
      coalesce(sum(f.fold_to_cbet_turn_opp), 0)::bigint as fold_to_cbet_turn_opp, coalesce(sum(f.fold_to_cbet_turn), 0)::bigint as fold_to_cbet_turn, coalesce(sum(f.call_cbet_turn), 0)::bigint as call_cbet_turn,
      coalesce(sum(f.raise_cbet_turn), 0)::bigint as raise_cbet_turn, coalesce(sum(f.fold_to_cbet_river_opp), 0)::bigint as fold_to_cbet_river_opp, coalesce(sum(f.fold_to_cbet_river), 0)::bigint as fold_to_cbet_river,
      coalesce(sum(f.call_cbet_river), 0)::bigint as call_cbet_river, coalesce(sum(f.raise_cbet_river), 0)::bigint as raise_cbet_river, coalesce(sum(f.donk_flop_opp), 0)::bigint as donk_flop_opp,
      coalesce(sum(f.donk_flop), 0)::bigint as donk_flop, coalesce(sum(f.donk_turn_opp), 0)::bigint as donk_turn_opp, coalesce(sum(f.donk_turn), 0)::bigint as donk_turn,
      coalesce(sum(f.donk_river_opp), 0)::bigint as donk_river_opp, coalesce(sum(f.donk_river), 0)::bigint as donk_river, coalesce(sum(f.check_raise_flop_opp), 0)::bigint as check_raise_flop_opp,
      coalesce(sum(f.check_raise_flop), 0)::bigint as check_raise_flop, coalesce(sum(f.check_raise_turn_opp), 0)::bigint as check_raise_turn_opp, coalesce(sum(f.check_raise_turn), 0)::bigint as check_raise_turn,
      coalesce(sum(f.check_raise_river_opp), 0)::bigint as check_raise_river_opp, coalesce(sum(f.check_raise_river), 0)::bigint as check_raise_river, coalesce(sum(f.bet_flop), 0)::bigint as bet_flop,
      coalesce(sum(f.raise_flop), 0)::bigint as raise_flop, coalesce(sum(f.call_flop), 0)::bigint as call_flop, coalesce(sum(f.check_flop), 0)::bigint as check_flop,
      coalesce(sum(f.fold_flop), 0)::bigint as fold_flop, coalesce(sum(f.bet_turn), 0)::bigint as bet_turn, coalesce(sum(f.raise_turn), 0)::bigint as raise_turn,
      coalesce(sum(f.call_turn), 0)::bigint as call_turn, coalesce(sum(f.check_turn), 0)::bigint as check_turn, coalesce(sum(f.fold_turn), 0)::bigint as fold_turn,
      coalesce(sum(f.bet_river), 0)::bigint as bet_river, coalesce(sum(f.raise_river), 0)::bigint as raise_river, coalesce(sum(f.call_river), 0)::bigint as call_river,
      coalesce(sum(f.check_river), 0)::bigint as check_river, coalesce(sum(f.fold_river), 0)::bigint as fold_river, coalesce(sum(f.wwsf_opp), 0)::bigint as wwsf_opp,
      coalesce(sum(f.wwsf), 0)::bigint as wwsf, coalesce(sum(f.wtsd_opp), 0)::bigint as wtsd_opp, coalesce(sum(f.wtsd), 0)::bigint as wtsd,
      coalesce(sum(f.wsd_opp), 0)::bigint as wsd_opp, coalesce(sum(f.wsd), 0)::bigint as wsd, coalesce(sum(f.cashed_out), 0)::bigint as cashed_out,
      coalesce(sum(f.hands) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as money_hands,
      coalesce(sum(f.won) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as won,
      coalesce(sum(f.contributed) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as contributed,
      coalesce(sum(f.net) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as net,
      coalesce(sum(f.net_bb_milli) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as net_bb_milli,
      coalesce(sum(f.rake_paid) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as rake_paid,
      coalesce(sum(f.out_of_pot) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as out_of_pot,
      coalesce(sum(f.cashout_risk) filter (where (v_cashouts or f.kind & 4 = 0)), 0)::bigint as cashout_risk,
      min(f.currency) as min_currency,
      max(f.currency) as max_currency,
      min(f.currency_minor_units)::integer as minor_units,
      coalesce(bool_or(f.game_format = 'cash'), false) as any_cash,
      coalesce(bool_or(f.game_format <> 'cash'), false) as any_chips
    from f
    group by grouping sets ((), (f."position"), (f.stake), (f.size), (f.site_id), (f.game_format))
  )
  select
    (select to_jsonb(t) - 'dim' - 'key' from g t where t.dim = 'total'),
    (select coalesce(jsonb_object_agg(d.dim, d.rows), '{}'::jsonb)
       from (select g.dim, jsonb_agg(jsonb_build_object(
          'key', g.key, 'hands', g.hands, 'money_hands', g.money_hands,
          'vpip_opp', g.vpip_opp, 'vpip', g.vpip, 'pfr_opp', g.pfr_opp, 'pfr', g.pfr,
          'rfi_opp', g.rfi_opp, 'rfi', g.rfi, 'three_bet_opp', g.three_bet_opp, 'three_bet', g.three_bet,
          'fold_to_three_bet_opp', g.fold_to_three_bet_opp, 'fold_to_three_bet', g.fold_to_three_bet, 'steal_opp', g.steal_opp, 'steal', g.steal,
          'cbet_flop_opp', g.cbet_flop_opp, 'cbet_flop', g.cbet_flop, 'wtsd_opp', g.wtsd_opp, 'wtsd', g.wtsd,
          'wsd_opp', g.wsd_opp, 'wsd', g.wsd, 'wwsf_opp', g.wwsf_opp, 'wwsf', g.wwsf,
          'net', g.net, 'net_bb_milli', g.net_bb_milli) order by g.hands desc, g.key) as rows
               from g where g.dim <> 'total' group by g.dim) d)
  into v_total, v_groups;

  v_mixed_kind     := coalesce((v_total ->> 'any_cash')::boolean and (v_total ->> 'any_chips')::boolean, false);
  v_mixed_currency := coalesce(v_total ->> 'min_currency' <> v_total ->> 'max_currency', false);

  -- The all-in EV adjustment: few rows (all in with cards to come), each
  -- looked up by key in the hero's report rows for the filter.
  select coalesce(sum(e.ev_net_bb_milli - r.net_bb_milli) filter (where (v_cashouts or r.kind & 4 = 0)), 0)::bigint,
         count(*)::bigint
    into v_ev_delta, v_all_in
    from public.hand_stats_ev e
    cross join lateral (
      select r.net_bb_milli, r.kind
      from public.hero_report_rows r
      where r.hand_id = e.hand_id and r.stats_version = v_version and r.seat = e.seat
        and r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
      -- one row (the key): kept a lookup per all-in hand, not flattened into a scan
      limit 1
    ) r
   where e.owner_id = v_owner and e.ev_version = v_ev and e.applicable;

  v_total := v_total || jsonb_build_object('ev_net_bb_milli', (v_total ->> 'net_bb_milli')::bigint + v_ev_delta);

  if v_mixed_kind then
    -- Chips and cash: nothing denominated survives, big blinds included.
    v_total := v_total - 'won' - 'contributed' - 'net' - 'net_bb_milli' - 'rake_paid' - 'out_of_pot'
                       - 'cashout_risk' - 'ev_net_bb_milli';
    v_groups := (select coalesce(jsonb_object_agg(k, (select coalesce(jsonb_agg(r - 'net' - 'net_bb_milli'), '[]'::jsonb)
                                                    from jsonb_array_elements(v) r)), '{}'::jsonb)
                   from jsonb_each(v_groups) as e(k, v));
  elsif v_mixed_currency then
    -- Two currencies: big blinds survive, the currency figures do not.
    v_total := v_total - 'won' - 'contributed' - 'net' - 'rake_paid' - 'out_of_pot' - 'cashout_risk';
    v_groups := (select coalesce(jsonb_object_agg(k, (select coalesce(jsonb_agg(r - 'net'), '[]'::jsonb)
                                                    from jsonb_array_elements(v) r)), '{}'::jsonb)
                   from jsonb_each(v_groups) as e(k, v));
  end if;

  return jsonb_build_object(
    'statsVersion',       v_version,
    'evVersion',          v_ev,
    'hands',              coalesce((v_total ->> 'hands')::bigint, 0),
    'moneyHands',         coalesce((v_total ->> 'money_hands')::bigint, 0),
    'mixedCurrency',      v_mixed_currency,
    'mixedUnitKind',      v_mixed_kind,
    'currency',           case when v_mixed_currency or v_mixed_kind then null else v_total ->> 'min_currency' end,
    'currencyMinorUnits', case when v_mixed_currency or v_mixed_kind then null else (v_total ->> 'minor_units')::integer end,
    'total',              v_total - 'min_currency' - 'max_currency' - 'minor_units' - 'any_cash' - 'any_chips',
    'groups',             v_groups,
    'allInHands',         v_all_in
  );
end;
$$;

create or replace function public.report_graph(p_filter jsonb default '{}'::jsonb, p_points integer default 60)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Planned per call: the predicates of the groups that are not set fold away
-- (R4.5b's lesson: a cached generic plan keeps them all).
set plan_cache_mode = force_custom_plan
-- A report sums up to a million rows into a few thousand groups: with the
-- default few MB the planner sorts them on disk instead of hashing.
set work_mem = '64MB'
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_ev        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_from      timestamptz;
  v_to        timestamptz;
  v_from_day  date;
  v_to_day    date;
  v_from_at   timestamptz;
  v_to_at     timestamptz;
  v_bomb      boolean;
  v_straddle  boolean;
  v_cashouts  boolean;
  v_count          bigint;
  v_money_hands    bigint;
  v_min_currency   text;
  v_max_currency   text;
  v_minor          integer;
  v_any_cash       boolean;
  v_any_chips      boolean;
  v_mixed_kind     boolean;
  v_mixed_currency boolean;
  v_points integer := least(greatest(coalesce(p_points, 60), 1), 1200);
  v_rows   jsonb;
  v_all_in bigint;
begin
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_from      := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  v_cashouts  := coalesce(case when jsonb_typeof(v_filter -> 'includeCashouts') = 'boolean' then (v_filter ->> 'includeCashouts')::boolean end, false);
  -- The formats as the enum (an unknown one matches nothing) and the kinds
  -- the options let in, as lists: predicates the planner can estimate
  -- (`kind & 1 = 0` it cannot, and a plan built for ten rows sorts a million).
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));
  -- Whole UTC days come from the rollup: from the first midnight at or after
  -- `from` to the last one at or before `to`; the rest of the range (the
  -- partial days at its two ends) from the hero's rows.
  if v_from is not null then
    v_from_day := (v_from at time zone 'UTC')::date
                  + case when (v_from at time zone 'UTC')::time = '00:00' then 0 else 1 end;
  end if;
  if v_to is not null then
    v_to_day := (v_to at time zone 'UTC')::date;
  end if;
  v_from_at := coalesce(v_from_day::timestamp at time zone 'UTC', '-infinity'::timestamptz);
  v_to_at   := coalesce(v_to_day::timestamp at time zone 'UTC', 'infinity'::timestamptz);
  if v_owner is null then
    return public.stats_empty_graph(v_version);
  end if;

  -- The sample's size and units from the summaries.
  select coalesce(u.n, 0)::bigint, coalesce(u.money_n, 0)::bigint, u.min_currency, u.max_currency,
         u.minor::integer, coalesce(u.any_cash, false), coalesce(u.any_chips, false)
    into v_count, v_money_hands, v_min_currency, v_max_currency, v_minor, v_any_cash, v_any_chips
    from (
      select sum(z.n) as n, sum(z.money_n) as money_n, min(z.min_currency) as min_currency, max(z.max_currency) as max_currency, min(z.minor) as minor, bool_or(z.any_cash) as any_cash, bool_or(z.any_chips) as any_chips
      from (
        select sum(r.hands) as n, sum(r.hands) filter (where (v_cashouts or r.kind & 4 = 0)) as money_n, min(r.currency) as min_currency, max(r.currency) as max_currency, min(r.currency_minor_units) as minor, bool_or(r.game_format = 'cash') as any_cash, bool_or(r.game_format <> 'cash') as any_chips
        from public.hero_rollups r
        where r.owner_id = v_owner and r.stats_version = v_version
          and ((v_from is null and v_to is null)
               or (r.day > '-infinity'::date
                   and (v_from_day is null or r.day >= v_from_day)
                   and (v_to_day is null or r.day < v_to_day)))
          and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
        union all
        select sum(x.hands) as n, sum(x.hands) filter (where (v_cashouts or not x.has_cashout)) as money_n, min(x.currency) as min_currency, max(x.currency) as max_currency, min(x.currency_minor_units) as minor, bool_or(x.game_format = 'cash') as any_cash, bool_or(x.game_format <> 'cash') as any_chips
        from public.hand_stats x
        where x.owner_id = v_owner and x.stats_version = v_version and x.is_hero
          and (v_from is not null or v_to is not null)
          and x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
          and x.played_at < coalesce(v_to, 'infinity'::timestamptz)
          and not (x.played_at >= v_from_at and x.played_at < v_to_at)
          and (cardinality(v_sites) = 0 or x.site_id = any (v_sites))
          and (not v_fmt_set or x.game_format = any (v_fmt_enum))
          and (cardinality(v_variants) = 0 or coalesce(x.variant, '') = any (v_variants))
          and (cardinality(v_limits) = 0 or coalesce(x.limit_type, '') = any (v_limits))
          and (cardinality(v_sizes) = 0 or case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end = any (v_sizes))
          and (cardinality(v_stakes) = 0 or case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end = any (v_stakes))
          and (cardinality(v_positions) = 0 or coalesce(x."position", '') = any (v_positions))
          and (v_bomb or not x.is_bomb_pot)
          and (v_straddle or not x.has_straddle)
      ) z
    ) u;

  v_mixed_kind     := v_any_cash and v_any_chips;
  v_mixed_currency := coalesce(v_min_currency <> v_max_currency, false);

  if v_count = 0 then
    return public.stats_empty_graph(v_version);
  end if;
  if v_mixed_kind then
    return jsonb_build_object(
      'statsVersion', v_version, 'buckets', '[]'::jsonb, 'hands', v_count, 'moneyHands', v_money_hands,
      'currency', null, 'currencyMinorUnits', null, 'mixedCurrency', v_mixed_currency,
      'mixedUnitKind', true, 'moneyAvailable', false, 'allInEv', null);
  end if;

  with days0 as (
    -- Each day of the sample summed: whole days from `hero_rollups`, the
    -- partial ones at a date range's ends from the rows.
    select z.day, sum(z.n) as n, sum(z.money_n) as money_n, sum(z.net_bb) as net_bb, sum(z.sd_bb) as sd_bb, sum(z.net) as net, sum(z.sd_net) as sd_net
      from (
        select r.day, sum(r.hands) as n, sum(r.hands) filter (where (v_cashouts or r.kind & 4 = 0)) as money_n, sum(r.net_bb_milli) filter (where (v_cashouts or r.kind & 4 = 0)) as net_bb, sum(r.sd_net_bb_milli) filter (where (v_cashouts or r.kind & 4 = 0)) as sd_bb, sum(r.net) filter (where (v_cashouts or r.kind & 4 = 0)) as net, sum(r.sd_net) filter (where (v_cashouts or r.kind & 4 = 0)) as sd_net
        from public.hero_rollups r
        where r.owner_id = v_owner and r.stats_version = v_version
          and ((v_from is null and v_to is null)
               or (r.day > '-infinity'::date
                   and (v_from_day is null or r.day >= v_from_day)
                   and (v_to_day is null or r.day < v_to_day)))
          and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
        group by 1
        union all
        select coalesce((x.played_at at time zone 'UTC')::date, '-infinity'::date) as day, sum(x.hands) as n, sum(x.hands) filter (where (v_cashouts or not x.has_cashout)) as money_n, sum(x.net_bb_milli) filter (where (v_cashouts or not x.has_cashout)) as net_bb, sum((case when x.wtsd > 0 then x.net_bb_milli else 0 end)) filter (where (v_cashouts or not x.has_cashout)) as sd_bb, sum(x.net) filter (where (v_cashouts or not x.has_cashout)) as net, sum((case when x.wtsd > 0 then x.net else 0 end)) filter (where (v_cashouts or not x.has_cashout)) as sd_net
        from public.hand_stats x
        where x.owner_id = v_owner and x.stats_version = v_version and x.is_hero
          and (v_from is not null or v_to is not null)
          and x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
          and x.played_at < coalesce(v_to, 'infinity'::timestamptz)
          and not (x.played_at >= v_from_at and x.played_at < v_to_at)
          and (cardinality(v_sites) = 0 or x.site_id = any (v_sites))
          and (not v_fmt_set or x.game_format = any (v_fmt_enum))
          and (cardinality(v_variants) = 0 or coalesce(x.variant, '') = any (v_variants))
          and (cardinality(v_limits) = 0 or coalesce(x.limit_type, '') = any (v_limits))
          and (cardinality(v_sizes) = 0 or case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end = any (v_sizes))
          and (cardinality(v_stakes) = 0 or case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end = any (v_stakes))
          and (cardinality(v_positions) = 0 or coalesce(x."position", '') = any (v_positions))
          and (v_bomb or not x.is_bomb_pot)
          and (v_straddle or not x.has_straddle)
        group by 1
      ) z
      group by z.day
  ),
  d as (
    -- Where each day starts in the sample (in time order, the hands without
    -- a time last), and whether it has more hands than a point.
    select x.*,
           x.n * v_points > v_count as fat,
           (x.s * v_points) / v_count as b
    from (
      select days0.day, coalesce(days0.n, 0)::bigint as n, coalesce(days0.money_n, 0)::bigint as money_n,
             coalesce(days0.net_bb, 0)::bigint as net_bb, coalesce(days0.sd_bb, 0)::bigint as sd_bb,
             coalesce(days0.net, 0)::bigint as net, coalesce(days0.sd_net, 0)::bigint as sd_net,
             coalesce(sum(days0.n) over (order by days0.day = '-infinity'::date, days0.day
                                         rows between unbounded preceding and 1 preceding), 0)::bigint as s
      from days0
    ) x
  ),
  split as (
    select d.day, d.s,
           case when d.day = '-infinity'::date then null else d.day::timestamp at time zone 'UTC' end as day_from,
           case when d.day = '-infinity'::date then null else (d.day + 1)::timestamp at time zone 'UTC' end as day_to
    from d
    where d.fat
  ),
  hands as (
    -- A fat day's hands in time order: one range of the time index each.
    select h.*, ((h.s + h.k - 1) * v_points) / v_count as b
    from split sp
    cross join lateral (
      select sp.s, r.hand_id, r.seat, r.played_at, r.kind, r.net, r.net_bb_milli, r.wtsd as wtsd,
             row_number() over (order by r.played_at, r.hand_key) as k
      from public.hero_report_rows r
      where sp.day_from is not null
        and r.owner_id = v_owner and r.stats_version = v_version
        and r.played_at >= sp.day_from and r.played_at < sp.day_to
        and r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
      union all
      select sp.s, r.hand_id, r.seat, r.played_at, r.kind, r.net, r.net_bb_milli, r.wtsd as wtsd,
             row_number() over (order by r.hand_key) as k
      from public.hero_report_rows r
      where sp.day_from is null
        and r.owner_id = v_owner and r.stats_version = v_version and r.played_at is null
        and r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
    ) h
  ),
  parts as (
    select d.b, d.n as hands, d.money_n as money_hands, d.net_bb, d.sd_bb, d.net, d.sd_net, d.day
    from d where not d.fat
    union all
    select h.b, 1, case when (v_cashouts or h.kind & 4 = 0) then 1 else 0 end,
           case when (v_cashouts or h.kind & 4 = 0) then h.net_bb_milli else 0 end,
           case when (v_cashouts or h.kind & 4 = 0) and h.wtsd > 0 then h.net_bb_milli else 0 end,
           case when (v_cashouts or h.kind & 4 = 0) then h.net else 0 end,
           case when (v_cashouts or h.kind & 4 = 0) and h.wtsd > 0 then h.net else 0 end,
           null::date
    from hands h
  ),
  per_point as (
    select p.b,
           sum(p.hands)::bigint as hands,
           sum(p.money_hands)::bigint as money_hands,
           sum(p.net_bb)::bigint as net_bb_milli,
           sum(p.sd_bb)::bigint as sd_bb_milli,
           sum(p.net)::bigint as net,
           sum(p.sd_net)::bigint as sd_net,
           min(p.day) filter (where p.day > '-infinity'::date) as first_day,
           max(p.day) filter (where p.day > '-infinity'::date) as last_day
    from parts p
    group by p.b
  ),
  hands_times as (
    select h.b, min(h.played_at) as first_at, max(h.played_at) as last_at from hands h group by h.b
  ),
  times as (
    -- A point's first and last hand: among its hands read one by one, the
    -- first hand of its first whole day and the last of its last.
    select pp.b,
           least(ht.first_at,
                 case when pp.first_day is not null then (
                   select min(r.played_at) from public.hero_report_rows r
                   where r.owner_id = v_owner and r.stats_version = v_version
                     and r.played_at >= pp.first_day::timestamp at time zone 'UTC'
                     and r.played_at < (pp.first_day + 1)::timestamp at time zone 'UTC'
                     and r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)) end) as first_played_at,
           greatest(ht.last_at,
                    case when pp.last_day is not null then (
                      select max(r.played_at) from public.hero_report_rows r
                      where r.owner_id = v_owner and r.stats_version = v_version
                        and r.played_at >= pp.last_day::timestamp at time zone 'UTC'
                        and r.played_at < (pp.last_day + 1)::timestamp at time zone 'UTC'
                        and r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)) end) as last_played_at
    from per_point pp
    left join hands_times ht on ht.b = pp.b
  ),
  ev_rows as materialized (
    -- The all-in hands of the sample (few), each looked up by key.
    select r.hand_id, r.seat, coalesce((r.played_at at time zone 'UTC')::date, '-infinity'::date) as day,
           e.ev_net_bb_milli - r.net_bb_milli as delta, e.ev_net - r.net as delta_net, (v_cashouts or r.kind & 4 = 0) as money
    from public.hand_stats_ev e
    cross join lateral (
      select r.hand_id, r.seat, r.played_at, r.net_bb_milli, r.net, r.kind
      from public.hero_report_rows r
      where r.hand_id = e.hand_id and r.stats_version = v_version and r.seat = e.seat
        and r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
      -- one row (the key): a lookup per all-in hand, not flattened into a scan
      limit 1
    ) r
    where e.owner_id = v_owner and e.ev_version = v_ev and e.applicable
  ),
  ev as (
    -- Each in its day's point, or on a day read hand by hand, in its own.
    select coalesce(hb.b, dd.b) as b,
           coalesce(sum(er.delta) filter (where er.money), 0)::bigint as delta,
           coalesce(sum(er.delta_net) filter (where er.money), 0)::bigint as delta_net,
           count(*)::bigint as all_in
    from ev_rows er
    join d dd on dd.day = er.day
    left join hands hb on hb.hand_id = er.hand_id and hb.seat = er.seat
    group by 1
  )
  select coalesce(jsonb_agg(to_jsonb(t) - 'b' order by t.b), '[]'::jsonb), coalesce(sum(t.ev_applicable), 0)::bigint
  into v_rows, v_all_in
  from (
    select
      p.b,
      row_number() over o as bucket,
      p.hands, p.money_hands, tm.first_played_at, tm.last_played_at,
      sum(p.hands)        over o as cum_hands,
      sum(p.money_hands)  over o as cum_money_hands,
      sum(p.net_bb_milli) over o as cum_net_bb_milli,
      sum(p.sd_bb_milli)  over o as cum_sd_bb_milli,
      sum(p.net_bb_milli - p.sd_bb_milli) over o as cum_nsd_bb_milli,
      sum(p.net)          over o as cum_net,
      sum(p.sd_net)       over o as cum_sd_net,
      sum(p.net - p.sd_net) over o as cum_nsd_net,
      sum(p.net_bb_milli + coalesce(ev.delta, 0)) over o as cum_ev_bb_milli,
      sum(p.net + coalesce(ev.delta_net, 0)) over o as cum_ev_net,
      coalesce(ev.all_in, 0) as ev_applicable
    from per_point p
    join times tm on tm.b = p.b
    left join ev on ev.b = p.b
    window o as (order by p.b rows between unbounded preceding and current row)
  ) t;

  if v_mixed_currency then
    select coalesce(jsonb_agg(e - 'cum_net' - 'cum_sd_net' - 'cum_nsd_net' - 'cum_ev_net'), '[]'::jsonb)
      into v_rows from jsonb_array_elements(v_rows) e;
  end if;

  return jsonb_build_object(
    'statsVersion',       v_version,
    'buckets',            v_rows,
    'hands',              v_count,
    'moneyHands',         v_money_hands,
    'currency',           case when v_mixed_currency then null else v_min_currency end,
    'currencyMinorUnits', case when v_mixed_currency then null else v_minor end,
    'mixedCurrency',      v_mixed_currency,
    'mixedUnitKind',      false,
    'moneyAvailable',     true,
    'allInEv',            jsonb_build_object('evVersion', v_ev, 'allInHands', v_all_in)
  );
end;
$$;

create or replace function public.report_situations(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Planned per call: the predicates of the groups that are not set fold away
-- (R4.5b's lesson: a cached generic plan keeps them all).
set plan_cache_mode = force_custom_plan
-- A report sums up to a million rows into a few thousand groups: with the
-- default few MB the planner sorts them on disk instead of hashing.
set work_mem = '64MB'
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_ev        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_from      timestamptz;
  v_to        timestamptz;
  v_from_day  date;
  v_to_day    date;
  v_from_at   timestamptz;
  v_to_at     timestamptz;
  v_bomb      boolean;
  v_straddle  boolean;
  v_cashouts  boolean;
  v_total  jsonb;
  v_groups jsonb;
  v_mixed_kind     boolean;
  v_mixed_currency boolean;
begin
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_from      := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  v_cashouts  := coalesce(case when jsonb_typeof(v_filter -> 'includeCashouts') = 'boolean' then (v_filter ->> 'includeCashouts')::boolean end, false);
  -- The formats as the enum (an unknown one matches nothing) and the kinds
  -- the options let in, as lists: predicates the planner can estimate
  -- (`kind & 1 = 0` it cannot, and a plan built for ten rows sorts a million).
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));
  -- Whole UTC days come from the rollup: from the first midnight at or after
  -- `from` to the last one at or before `to`; the rest of the range (the
  -- partial days at its two ends) from the hero's rows.
  if v_from is not null then
    v_from_day := (v_from at time zone 'UTC')::date
                  + case when (v_from at time zone 'UTC')::time = '00:00' then 0 else 1 end;
  end if;
  if v_to is not null then
    v_to_day := (v_to at time zone 'UTC')::date;
  end if;
  v_from_at := coalesce(v_from_day::timestamp at time zone 'UTC', '-infinity'::timestamptz);
  v_to_at   := coalesce(v_to_day::timestamp at time zone 'UTC', 'infinity'::timestamptz);
  if v_owner is null then
    return jsonb_build_object('statsVersion', v_version, 'groups', '{}'::jsonb, 'mixedCurrency', false, 'mixedUnitKind', false);
  end if;

  -- One pass over the hero's report rows (`hero_report_rows_time_idx`
  -- carries every column read here), split five ways at once.
  with f0 as (
    -- Per combination of the five (a few thousand), then split; grouped by
    -- the plain columns, which `hero_report_rows_situation` has statistics on.
    select
      r.pot_type, r.stack, r.hand_class, r.players, r.street, r.game_format, r.currency, r.kind,
      count(*) as hands,
      sum(r.vpip_opp) as vpip_opp, sum(r.vpip) as vpip, sum(r.pfr_opp) as pfr_opp,
      sum(r.pfr) as pfr, sum(r.rfi_opp) as rfi_opp, sum(r.rfi) as rfi,
      sum(r.three_bet_opp) as three_bet_opp, sum(r.three_bet) as three_bet, sum(r.fold_to_three_bet_opp) as fold_to_three_bet_opp,
      sum(r.fold_to_three_bet) as fold_to_three_bet, sum(r.steal_opp) as steal_opp, sum(r.steal) as steal,
      sum(r.cbet_flop_opp) as cbet_flop_opp, sum(r.cbet_flop) as cbet_flop, sum(r.wtsd_opp) as wtsd_opp,
      sum(r.wtsd) as wtsd, sum(r.wsd_opp) as wsd_opp, sum(r.wsd) as wsd,
      sum(r.wwsf_opp) as wwsf_opp, sum(r.wwsf) as wwsf,
      sum(r.net) as net, sum(r.net_bb_milli) as net_bb_milli
    from public.hero_report_rows r
    where r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  f as (
    select f0.pot_type, f0.stack, f0.hand_class, coalesce(f0.players::text, '') as players, f0.street,
           f0.game_format, f0.currency, (v_cashouts or f0.kind & 4 = 0) as money,
           f0.hands, f0.vpip_opp, f0.vpip, f0.pfr_opp, f0.pfr, f0.rfi_opp, f0.rfi, f0.three_bet_opp, f0.three_bet, f0.fold_to_three_bet_opp, f0.fold_to_three_bet, f0.steal_opp, f0.steal, f0.cbet_flop_opp, f0.cbet_flop, f0.wtsd_opp, f0.wtsd, f0.wsd_opp, f0.wsd, f0.wwsf_opp, f0.wwsf, f0.net, f0.net_bb_milli
    from f0
  ),
  g as (
    select
      case
        when grouping(f.pot_type) = 0 then 'potType'
        when grouping(f.stack) = 0 then 'stack'
        when grouping(f.hand_class) = 0 then 'handClass'
        when grouping(f.players) = 0 then 'players'
        when grouping(f.street) = 0 then 'street'
        else 'total'
      end as dim,
      coalesce(f.pot_type, f.stack, f.hand_class, f.players, f.street) as key,
      coalesce(sum(f.hands), 0)::bigint as hands,
      coalesce(sum(f.hands) filter (where f.money), 0)::bigint as money_hands,
      coalesce(sum(f.vpip_opp), 0)::bigint as vpip_opp, coalesce(sum(f.vpip), 0)::bigint as vpip, coalesce(sum(f.pfr_opp), 0)::bigint as pfr_opp,
      coalesce(sum(f.pfr), 0)::bigint as pfr, coalesce(sum(f.rfi_opp), 0)::bigint as rfi_opp, coalesce(sum(f.rfi), 0)::bigint as rfi,
      coalesce(sum(f.three_bet_opp), 0)::bigint as three_bet_opp, coalesce(sum(f.three_bet), 0)::bigint as three_bet, coalesce(sum(f.fold_to_three_bet_opp), 0)::bigint as fold_to_three_bet_opp,
      coalesce(sum(f.fold_to_three_bet), 0)::bigint as fold_to_three_bet, coalesce(sum(f.steal_opp), 0)::bigint as steal_opp, coalesce(sum(f.steal), 0)::bigint as steal,
      coalesce(sum(f.cbet_flop_opp), 0)::bigint as cbet_flop_opp, coalesce(sum(f.cbet_flop), 0)::bigint as cbet_flop, coalesce(sum(f.wtsd_opp), 0)::bigint as wtsd_opp,
      coalesce(sum(f.wtsd), 0)::bigint as wtsd, coalesce(sum(f.wsd_opp), 0)::bigint as wsd_opp, coalesce(sum(f.wsd), 0)::bigint as wsd,
      coalesce(sum(f.wwsf_opp), 0)::bigint as wwsf_opp, coalesce(sum(f.wwsf), 0)::bigint as wwsf,
      coalesce(sum(f.net) filter (where f.money), 0)::bigint as net,
      coalesce(sum(f.net_bb_milli) filter (where f.money), 0)::bigint as net_bb_milli,
      min(f.currency) as min_currency,
      max(f.currency) as max_currency,
      coalesce(bool_or(f.game_format = 'cash'), false) as any_cash,
      coalesce(bool_or(f.game_format <> 'cash'), false) as any_chips
    from f
    group by grouping sets ((), (f.pot_type), (f.stack), (f.hand_class), (f.players), (f.street))
  )
  select
    (select to_jsonb(t) from g t where t.dim = 'total'),
    (select coalesce(jsonb_object_agg(d.dim, d.rows), '{}'::jsonb)
       from (select g.dim, jsonb_agg(jsonb_build_object(
          'key', g.key, 'hands', g.hands, 'money_hands', g.money_hands,
          'vpip_opp', g.vpip_opp, 'vpip', g.vpip, 'pfr_opp', g.pfr_opp, 'pfr', g.pfr,
          'rfi_opp', g.rfi_opp, 'rfi', g.rfi, 'three_bet_opp', g.three_bet_opp, 'three_bet', g.three_bet,
          'fold_to_three_bet_opp', g.fold_to_three_bet_opp, 'fold_to_three_bet', g.fold_to_three_bet, 'steal_opp', g.steal_opp, 'steal', g.steal,
          'cbet_flop_opp', g.cbet_flop_opp, 'cbet_flop', g.cbet_flop, 'wtsd_opp', g.wtsd_opp, 'wtsd', g.wtsd,
          'wsd_opp', g.wsd_opp, 'wsd', g.wsd, 'wwsf_opp', g.wwsf_opp, 'wwsf', g.wwsf,
          'net', g.net, 'net_bb_milli', g.net_bb_milli) order by g.hands desc, g.key) as rows
               from g where g.dim <> 'total' group by g.dim) d)
  into v_total, v_groups;

  v_mixed_kind     := coalesce((v_total ->> 'any_cash')::boolean and (v_total ->> 'any_chips')::boolean, false);
  v_mixed_currency := coalesce(v_total ->> 'min_currency' <> v_total ->> 'max_currency', false);
  if v_mixed_kind then
    v_groups := (select coalesce(jsonb_object_agg(k, (select coalesce(jsonb_agg(r - 'net' - 'net_bb_milli'), '[]'::jsonb)
                                                    from jsonb_array_elements(v) r)), '{}'::jsonb)
                   from jsonb_each(v_groups) as e(k, v));
  elsif v_mixed_currency then
    v_groups := (select coalesce(jsonb_object_agg(k, (select coalesce(jsonb_agg(r - 'net'), '[]'::jsonb)
                                                    from jsonb_array_elements(v) r)), '{}'::jsonb)
                   from jsonb_each(v_groups) as e(k, v));
  end if;

  return jsonb_build_object(
    'statsVersion',  v_version,
    'groups',        v_groups,
    'mixedCurrency', v_mixed_currency,
    'mixedUnitKind', v_mixed_kind
  );
end;
$$;

create or replace function public.report_sessions(p_filter jsonb default '{}'::jsonb, p_gap_minutes integer default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Planned per call: the predicates of the groups that are not set fold away
-- (R4.5b's lesson: a cached generic plan keeps them all).
set plan_cache_mode = force_custom_plan
-- A report sums up to a million rows into a few thousand groups: with the
-- default few MB the planner sorts them on disk instead of hashing.
set work_mem = '64MB'
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_ev        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_from      timestamptz;
  v_to        timestamptz;
  v_from_day  date;
  v_to_day    date;
  v_from_at   timestamptz;
  v_to_at     timestamptz;
  v_bomb      boolean;
  v_straddle  boolean;
  v_cashouts  boolean;
  v_gap        interval := make_interval(mins => least(greatest(coalesce(p_gap_minutes, 30), 5), 720));
  v_rows       jsonb;
  v_unit_kinds integer;
  v_currencies integer;
  v_currency_out text;
  v_minor      integer;
begin
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_from      := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  v_cashouts  := coalesce(case when jsonb_typeof(v_filter -> 'includeCashouts') = 'boolean' then (v_filter ->> 'includeCashouts')::boolean end, false);
  -- The formats as the enum (an unknown one matches nothing) and the kinds
  -- the options let in, as lists: predicates the planner can estimate
  -- (`kind & 1 = 0` it cannot, and a plan built for ten rows sorts a million).
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));
  -- Whole UTC days come from the rollup: from the first midnight at or after
  -- `from` to the last one at or before `to`; the rest of the range (the
  -- partial days at its two ends) from the hero's rows.
  if v_from is not null then
    v_from_day := (v_from at time zone 'UTC')::date
                  + case when (v_from at time zone 'UTC')::time = '00:00' then 0 else 1 end;
  end if;
  if v_to is not null then
    v_to_day := (v_to at time zone 'UTC')::date;
  end if;
  v_from_at := coalesce(v_from_day::timestamp at time zone 'UTC', '-infinity'::timestamptz);
  v_to_at   := coalesce(v_to_day::timestamp at time zone 'UTC', 'infinity'::timestamptz);
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.' using errcode = '42501';
  end if;

  -- `stats_sessions` over the shared filter, in time order from
  -- `hero_report_rows_time_idx`.
  with h as (
    select r.played_at, r.table_name, r.kind & 4 <> 0 as has_cashout, r.net, r.net_bb_milli,
           r.game_format, r.currency, r.currency_minor_units
    from public.hero_report_rows r
    where r.owner_id = v_owner and r.stats_version = v_version
        and (v_from is null or r.played_at >= v_from)
        and (v_to is null or r.played_at < v_to)
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
      and r.played_at is not null
  ),
  marked as (
    select h.*,
           case when lag(h.played_at) over w is null
                  or h.played_at - lag(h.played_at) over w > v_gap
                then 1 else 0 end as starts
    from h
    window w as (order by h.played_at)
  ),
  numbered as (
    select m.*, sum(m.starts) over (order by m.played_at rows unbounded preceding) as session
    from marked m
  ),
  per_table as (
    -- Per session and table first (hashed), so the tables of a session are a
    -- count of groups rather than a distinct over a million sorted rows.
    select n.session, n.table_name,
           min(n.played_at) as started_at,
           max(n.played_at) as ended_at,
           count(*) as hands,
           coalesce(sum(n.net_bb_milli) filter (where not n.has_cashout), 0) as net_bb_milli,
           coalesce(sum(n.net) filter (where not n.has_cashout), 0) as net,
           bool_or(n.game_format = 'cash') as any_cash,
           bool_or(n.game_format <> 'cash') as any_chips,
           min(n.currency) as min_currency,
           max(n.currency) as max_currency,
           min(n.currency_minor_units)::integer as minor_units
    from numbered n
    group by n.session, n.table_name
  ),
  sessions as (
    select t.session,
           min(t.started_at) as started_at,
           max(t.ended_at) as ended_at,
           sum(t.hands) as hands,
           count(t.table_name) as tables,
           sum(t.net_bb_milli) as net_bb_milli,
           sum(t.net) as net,
           bool_or(t.any_cash) as any_cash,
           bool_or(t.any_chips) as any_chips,
           min(t.min_currency) as min_currency,
           max(t.max_currency) as max_currency,
           min(t.minor_units) as minor_units
    from per_table t
    group by t.session
  ),
  units as (
    select (case when bool_or(s.any_cash) then 1 else 0 end) + (case when bool_or(s.any_chips) then 1 else 0 end) as kinds,
           case when min(s.min_currency) is null then 0
                when min(s.min_currency) = max(s.max_currency) then 1 else 2 end as currencies,
           min(s.min_currency) as currency,
           min(s.minor_units) as minor
    from sessions s
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
              'startedAt',  s.started_at,
              'endedAt',    s.ended_at,
              'hands',      s.hands,
              'tables',     s.tables,
              'netBbMilli', case when u.kinds > 1 then null else s.net_bb_milli end,
              'net',        case when u.kinds > 1 or u.currencies > 1 then null else s.net end
            ) order by s.session desc), '[]'::jsonb)
       from (select * from sessions order by session desc limit 2000) s cross join units u),
    u.kinds, u.currencies, u.currency, u.minor
  into v_rows, v_unit_kinds, v_currencies, v_currency_out, v_minor
  from units u;

  return jsonb_build_object(
    'gapMinutes',         extract(epoch from v_gap)::integer / 60,
    'sessions',           coalesce(v_rows, '[]'::jsonb),
    'mixedUnitKind',      coalesce(v_unit_kinds, 0) > 1,
    'mixedCurrency',      coalesce(v_currencies, 0) > 1,
    'currency',           case when coalesce(v_unit_kinds, 0) > 1 or coalesce(v_currencies, 0) > 1 then null else v_currency_out end,
    'currencyMinorUnits', case when coalesce(v_unit_kinds, 0) > 1 or coalesce(v_currencies, 0) > 1 then null else v_minor end
  );
end;
$$;

create or replace function public.report_facets(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Planned per call: the predicates of the groups that are not set fold away
-- (R4.5b's lesson: a cached generic plan keeps them all).
set plan_cache_mode = force_custom_plan
-- A report sums up to a million rows into a few thousand groups: with the
-- default few MB the planner sorts them on disk instead of hashing.
set work_mem = '64MB'
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_ev        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_from      timestamptz;
  v_to        timestamptz;
  v_from_day  date;
  v_to_day    date;
  v_from_at   timestamptz;
  v_to_at     timestamptz;
  v_bomb      boolean;
  v_straddle  boolean;
  v_cashouts  boolean;
  v_out jsonb;
begin
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_from      := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  v_cashouts  := coalesce(case when jsonb_typeof(v_filter -> 'includeCashouts') = 'boolean' then (v_filter ->> 'includeCashouts')::boolean end, false);
  -- The formats as the enum (an unknown one matches nothing) and the kinds
  -- the options let in, as lists: predicates the planner can estimate
  -- (`kind & 1 = 0` it cannot, and a plan built for ten rows sorts a million).
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));
  -- Whole UTC days come from the rollup: from the first midnight at or after
  -- `from` to the last one at or before `to`; the rest of the range (the
  -- partial days at its two ends) from the hero's rows.
  if v_from is not null then
    v_from_day := (v_from at time zone 'UTC')::date
                  + case when (v_from at time zone 'UTC')::time = '00:00' then 0 else 1 end;
  end if;
  if v_to is not null then
    v_to_day := (v_to at time zone 'UTC')::date;
  end if;
  v_from_at := coalesce(v_from_day::timestamp at time zone 'UTC', '-infinity'::timestamptz);
  v_to_at   := coalesce(v_to_day::timestamp at time zone 'UTC', 'infinity'::timestamptz);
  if v_owner is null then
    return jsonb_build_object('total', 0, 'library', 0, 'sites', '[]'::jsonb, 'formats', '[]'::jsonb,
      'variants', '[]'::jsonb, 'limits', '[]'::jsonb, 'sizes', '[]'::jsonb, 'stakes', '[]'::jsonb,
      'positions', '[]'::jsonb);
  end if;

  -- Each group's values with the hands they would match under the other
  -- groups (0 kept, so a chosen value keeps its chip), from the summaries;
  -- `library_facets`' rule over the hero's statistics rows.
  with u0 as (
      select z.site_id, z.game_format, z.variant, z.limit_type, z.size, z.currency, z.stake, z."position", sum(z.hands) as hands, min(z.currency_minor_units) as currency_minor_units, min(z.small_blind) as small_blind, min(z.big_blind) as big_blind
      from (
        select r.site_id, r.game_format, r.variant, r.limit_type, r.size, r.currency, r.stake, r."position", sum(r.hands) as hands, min(r.currency_minor_units) as currency_minor_units, min(r.small_blind) as small_blind, min(r.big_blind) as big_blind
        from public.hero_rollups r
        where r.owner_id = v_owner and r.stats_version = v_version
          and ((v_from is null and v_to is null)
               or (r.day > '-infinity'::date
                   and (v_from_day is null or r.day >= v_from_day)
                   and (v_to_day is null or r.day < v_to_day)))
          and r.kind = any (v_kinds)
        group by 1, 2, 3, 4, 5, 6, 7, 8
        union all
        select x.site_id as site_id, x.game_format as game_format, coalesce(x.variant, '') as variant, coalesce(x.limit_type, '') as limit_type, case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end as size, x.currency as currency, case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end as stake, coalesce(x."position", '') as "position", sum(x.hands) as hands, min(x.currency_minor_units) as currency_minor_units, min(coalesce(x.small_blind, 0)) as small_blind, min(coalesce(x.big_blind, 0)) as big_blind
        from public.hand_stats x
        where x.owner_id = v_owner and x.stats_version = v_version and x.is_hero
          and (v_from is not null or v_to is not null)
          and x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
          and x.played_at < coalesce(v_to, 'infinity'::timestamptz)
          and not (x.played_at >= v_from_at and x.played_at < v_to_at)
          and (v_bomb or not x.is_bomb_pot) and (v_straddle or not x.has_straddle)
        group by 1, 2, 3, 4, 5, 6, 7, 8
      ) z
      group by z.site_id, z.game_format, z.variant, z.limit_type, z.size, z.currency, z.stake, z."position"
  ),
  u as (
    select u0.* from u0
  ),
  f as (
    select u.site_id, u.game_format::text as format, u.variant, u.limit_type, u.size, u.stake, u."position",
           u.currency, u.currency_minor_units, u.small_blind, u.big_blind, u.hands,
           (cardinality(v_sites) = 0 or u.site_id = any (v_sites)) as m_site,
           (not v_fmt_set or u.game_format = any (v_fmt_enum)) as m_format,
           (cardinality(v_variants) = 0 or u.variant = any (v_variants)) as m_variant,
           (cardinality(v_limits) = 0 or u.limit_type = any (v_limits)) as m_limit,
           (cardinality(v_sizes) = 0 or u.size = any (v_sizes)) as m_size,
           (cardinality(v_stakes) = 0 or u.stake = any (v_stakes)) as m_stake,
           (cardinality(v_positions) = 0 or u."position" = any (v_positions)) as m_position
    from u
  ),
  g as (
    select
      case
        when grouping(f.site_id) = 0 then 'sites'
        when grouping(f.format) = 0 then 'formats'
        when grouping(f.variant) = 0 then 'variants'
        when grouping(f.limit_type) = 0 then 'limits'
        when grouping(f.size) = 0 then 'sizes'
        when grouping(f.stake) = 0 then 'stakes'
        when grouping(f."position") = 0 then 'positions'
        else 'total'
      end as dim,
      coalesce(f.site_id, f.format, f.variant, f.limit_type, f.size, f.stake, f."position") as value,
      coalesce(sum(f.hands) filter (where f.m_format and f.m_variant and f.m_limit and f.m_size and f.m_stake and f.m_position), 0)::bigint as c_sites,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_variant and f.m_limit and f.m_size and f.m_stake and f.m_position), 0)::bigint as c_formats,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_format and f.m_limit and f.m_size and f.m_stake and f.m_position), 0)::bigint as c_variants,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_format and f.m_variant and f.m_size and f.m_stake and f.m_position), 0)::bigint as c_limits,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_format and f.m_variant and f.m_limit and f.m_stake and f.m_position), 0)::bigint as c_sizes,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_format and f.m_variant and f.m_limit and f.m_size and f.m_position), 0)::bigint as c_stakes,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_format and f.m_variant and f.m_limit and f.m_size and f.m_stake), 0)::bigint as c_positions,
      coalesce(sum(f.hands) filter (where f.m_site and f.m_format and f.m_variant and f.m_limit and f.m_size and f.m_stake and f.m_position), 0)::bigint as c_total,
      coalesce(sum(f.hands), 0)::bigint as c_library,
      min(f.currency) as currency,
      min(f.currency_minor_units)::integer as minor_units,
      min(f.small_blind) as small_blind,
      min(f.big_blind) as big_blind
    from f
    group by grouping sets ((), (f.site_id), (f.format), (f.variant), (f.limit_type), (f.size), (f.stake), (f."position"))
  ),
  c as (
    select g.dim, g.value,
           case g.dim
             when 'sites' then g.c_sites when 'formats' then g.c_formats when 'variants' then g.c_variants
             when 'limits' then g.c_limits when 'sizes' then g.c_sizes when 'stakes' then g.c_stakes
             when 'positions' then g.c_positions else g.c_total end as n,
           g.currency, g.minor_units, g.small_blind, g.big_blind, g.c_library
    from g
  )
  select jsonb_build_object(
    'total',     coalesce((select c.n from c where c.dim = 'total'), 0),
    'library',   coalesce((select c.c_library from c where c.dim = 'total'), 0),
    'sites',     coalesce((select jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc, c.value) from c where c.dim = 'sites'), '[]'::jsonb),
    'formats',   coalesce((select jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc, c.value) from c where c.dim = 'formats'), '[]'::jsonb),
    'variants',  coalesce((select jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc, c.value) from c where c.dim = 'variants'), '[]'::jsonb),
    'limits',    coalesce((select jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc, c.value) from c where c.dim = 'limits'), '[]'::jsonb),
    'sizes',     coalesce((select jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc, c.value) from c where c.dim = 'sizes'), '[]'::jsonb),
    'positions', coalesce((select jsonb_agg(jsonb_build_object('value', c.value, 'count', c.n) order by c.n desc, c.value) from c where c.dim = 'positions'), '[]'::jsonb),
    'stakes',    coalesce((select jsonb_agg(jsonb_build_object(
                    'value', c.value, 'count', c.n,
                    'currency', case when c.value = 'chips' then null else c.currency end,
                    'minorUnits', case when c.value = 'chips' then null else c.minor_units end,
                    'smallBlind', case when c.value = 'chips' then null else c.small_blind end,
                    'bigBlind', case when c.value = 'chips' then null else c.big_blind end,
                    'currencySymbol', case when c.value = 'chips' then null else (
                      select h.currency_symbol from public.hands h
                      where h.owner_id = v_owner and h.currency = c.currency and h.currency_symbol is not null
                      limit 1) end
                  ) order by c.n desc, c.value) from c where c.dim = 'stakes'), '[]'::jsonb)
  )
  into v_out;

  return v_out;
end;
$$;

revoke all on function public.report_open(jsonb) from public, anon;
grant execute on function public.report_open(jsonb) to authenticated;
revoke all on function public.report_graph(jsonb, integer) from public, anon;
grant execute on function public.report_graph(jsonb, integer) to authenticated;
revoke all on function public.report_situations(jsonb) from public, anon;
grant execute on function public.report_situations(jsonb) to authenticated;
revoke all on function public.report_sessions(jsonb, integer) from public, anon;
grant execute on function public.report_sessions(jsonb, integer) to authenticated;
revoke all on function public.report_facets(jsonb) from public, anon;
grant execute on function public.report_facets(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. stats_opponents over player_stats
-- ---------------------------------------------------------------------------

create or replace function public.stats_opponents(p_filters jsonb default '{}'::jsonb, p_search text default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_site     text := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_format   public.game_format;
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_min      integer := greatest(coalesce(nullif(btrim(coalesce(p_filters ->> 'minHands', '')), '')::integer, 1), 1);
  v_cap      integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_pattern  text;
  v_rows     jsonb;
  v_kinds    integer;
  v_hidden   bigint;
  v_total    bigint;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_pattern := replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- R4.5c: from `player_stats` (the opponents' rows summed as they are
  -- written) instead of every villain row; the same answer.
  select
    (case when bool_or(p.game_format = 'cash') then 1 else 0 end) + (case when bool_or(p.game_format <> 'cash') then 1 else 0 end),
    coalesce(sum(p.hands) filter (where p.site_anonymization = 'opaque-id'), 0),
    coalesce(sum(p.hands), 0)
  into v_kinds, v_hidden, v_total
  from public.player_stats p
  where p.owner_id = v_owner
    and p.stats_version = v_version
    and (v_site is null or p.site_id = v_site)
    and (v_format is null or p.game_format = v_format)
    and (v_currency is null or p.currency = v_currency)
    and (v_big_blind is null or p.big_blind = v_big_blind);

  with agg as (
    select
      p.site_id                       as site,
      p.player                        as player,
      sum(p.hands)::bigint            as hands,
      sum(p.vpip_opp)::bigint as vpip_opp, sum(p.vpip)::bigint as vpip,
      sum(p.pfr_opp)::bigint as pfr_opp, sum(p.pfr)::bigint as pfr,
      sum(p.three_bet_opp)::bigint as three_bet_opp, sum(p.three_bet)::bigint as three_bet,
      sum(p.fold_to_three_bet_opp)::bigint as fold_to_three_bet_opp, sum(p.fold_to_three_bet)::bigint as fold_to_three_bet,
      sum(p.cbet_flop_opp)::bigint as cbet_flop_opp, sum(p.cbet_flop)::bigint as cbet_flop,
      sum(p.fold_to_cbet_flop_opp)::bigint as fold_to_cbet_flop_opp, sum(p.fold_to_cbet_flop)::bigint as fold_to_cbet_flop,
      sum(p.wtsd_opp)::bigint as wtsd_opp, sum(p.wtsd)::bigint as wtsd,
      sum(p.wsd_opp)::bigint as wsd_opp, sum(p.wsd)::bigint as wsd,
      sum(p.bets)::bigint as bets, sum(p.raises)::bigint as raises,
      sum(p.calls)::bigint as calls, sum(p.folds)::bigint as folds,
      max(p.last_played_at)           as last_seen,
      bool_and(p.seen_exact)          as seen_exact,
      sum(p.hero_net_bb_milli)::bigint as hero_net_bb_milli,
      sum(p.hero_money_hands)::bigint  as hero_money_hands
    from public.player_stats p
    where p.owner_id = v_owner
      and p.stats_version = v_version
      and p.site_anonymization = 'none'
      and (v_site is null or p.site_id = v_site)
      and (v_format is null or p.game_format = v_format)
      and (v_currency is null or p.currency = v_currency)
      and (v_big_blind is null or p.big_blind = v_big_blind)
      and (v_pattern is null or lower(p.player) like v_pattern)
    group by p.site_id, p.player
    having sum(p.hands) >= v_min
  ),
  top as (
    select * from agg order by hands desc, player limit v_cap
  )
  select coalesce(jsonb_agg(to_jsonb(a) - 'seen_exact' order by a.hands desc, a.player), '[]'::jsonb)
  into v_rows
  from (
    select t.site, t.player, t.hands,
           t.vpip_opp, t.vpip, t.pfr_opp, t.pfr,
           t.three_bet_opp, t.three_bet, t.fold_to_three_bet_opp, t.fold_to_three_bet,
           t.cbet_flop_opp, t.cbet_flop, t.fold_to_cbet_flop_opp, t.fold_to_cbet_flop,
           t.wtsd_opp, t.wtsd, t.wsd_opp, t.wsd,
           t.bets, t.raises, t.calls, t.folds,
           -- A delete touched one of the rows: the newest hand read again.
           case when t.seen_exact then t.last_seen else (
             select max(s.played_at) from public.hand_stats s
             where s.owner_id = v_owner and s.stats_version = v_version and not s.is_hero
               and s.player = t.player and s.site_id = t.site and not s.is_bomb_pot
               and s.site_anonymization = 'none'
               and (v_format is null or s.game_format = v_format)
               and (v_currency is null or s.currency = v_currency)
               and (v_big_blind is null or coalesce(s.big_blind, 0) = v_big_blind)) end as last_seen,
           t.hero_net_bb_milli, t.hero_money_hands
    from top t
  ) a;

  if coalesce(v_kinds, 0) > 1 then
    v_rows := (select coalesce(jsonb_agg(r - 'hero_net_bb_milli' - 'hero_money_hands'), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r);
  end if;

  return jsonb_build_object(
    'statsVersion',  v_version,
    'rows',          v_rows,
    'mixedUnitKind', coalesce(v_kinds, 0) > 1,
    'opaqueRows',    coalesce(v_hidden, 0),
    'villainRows',   coalesce(v_total, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The coverage line from the summaries
-- ---------------------------------------------------------------------------

-- `stats_coverage` read every hand and probed `hand_stats` twice for each
-- (10-11 s for a 1M-hand account): it opens the statistics screen, before
-- anything else. The usual case - every row at one version - now comes from
-- counts: the account's hands (index-only), those without a hero seat
-- (`hands_owner_no_hero_idx`), and the hero rows at the version from
-- `hero_rollups` (a hand's rows are written together, so a hand with rows
-- at the version has its hero's). While another version has rows (a version
-- change in progress) the per-hand count is kept: `stale` and `missing`
-- need it. The answer is the same.
create or replace function public.stats_coverage(p_version text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_hands   bigint;
  v_without bigint;
  v_at      bigint;
  v_out     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'stats_coverage needs a stats_version.'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.hand_stats s where s.owner_id = v_owner and not s.is_hero and s.stats_version < p_version)
     and not exists (select 1 from public.hand_stats s where s.owner_id = v_owner and not s.is_hero and s.stats_version > p_version)
     and not exists (select 1 from public.hand_stats s where s.owner_id = v_owner and s.is_hero and s.stats_version < p_version)
     and not exists (select 1 from public.hand_stats s where s.owner_id = v_owner and s.is_hero and s.stats_version > p_version)
  then
    select count(*) into v_hands from public.hands h where h.owner_id = v_owner;
    select count(*) into v_without from public.hands h where h.owner_id = v_owner and h.hero_seat is null;
    select coalesce(sum(r.hands), 0) into v_at
      from public.hero_rollups r where r.owner_id = v_owner and r.stats_version = p_version;
    return jsonb_build_object(
      'statsVersion', p_version,
      'hands',        v_hands - v_without,
      'atVersion',    v_at,
      'stale',        0,
      'missing',      greatest(v_hands - v_without - v_at, 0),
      'withoutHero',  v_without,
      'obsoleteRows', 0,
      'stakes', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'gameFormat',         x.game_format,
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n
               ) order by x.n desc, x.big_blind), '[]'::jsonb)
        from (
          -- The summaries keep a missing blind as 0 (no stake has one).
          select r.game_format::text as game_format, r.currency, r.currency_minor_units,
                 nullif(r.small_blind, 0) as small_blind, nullif(r.big_blind, 0) as big_blind,
                 sum(r.hands) as n
          from public.hero_rollups r
          where r.owner_id = v_owner and r.stats_version = p_version
          group by 1, 2, 3, 4, 5
        ) x
      )
    );
  end if;

  with h as (
    select
      hd.hero_seat is not null as has_hero,
      exists (
        select 1 from public.hand_stats s
        where s.hand_id = hd.id and s.stats_version = p_version
      ) as is_current,
      exists (
        select 1 from public.hand_stats s
        where s.hand_id = hd.id and s.stats_version <> p_version
      ) as has_old
    from public.hands hd
    where hd.owner_id = v_owner
  )
  select jsonb_build_object(
    'statsVersion', p_version,
    'hands',        count(*) filter (where has_hero),
    'atVersion',    count(*) filter (where has_hero and is_current),
    'stale',        count(*) filter (where has_hero and not is_current and has_old),
    'missing',      count(*) filter (where has_hero and not is_current and not has_old),
    'withoutHero',  count(*) filter (where not has_hero),
    'obsoleteRows', (
      select count(*) from public.hand_stats s
      where s.owner_id = v_owner and s.stats_version <> p_version
    ),
    'stakes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'gameFormat',         x.game_format,
               'currency',           x.currency,
               'currencyMinorUnits', x.currency_minor_units,
               'smallBlind',         x.small_blind,
               'bigBlind',           x.big_blind,
               'hands',              x.n
             ) order by x.n desc, x.big_blind), '[]'::jsonb)
      from (
        select s.game_format::text as game_format, s.currency, s.currency_minor_units,
               s.small_blind, s.big_blind, count(*) as n
        from public.hand_stats s
        where s.owner_id = v_owner and s.stats_version = p_version and s.is_hero
        group by 1, 2, 3, 4, 5
      ) x
    )
  )
  into v_out
  from h;

  return v_out;
end;
$$;

-- Hands with hero statistics at a version and no EV row at another: an
-- anti-join of two index-only scans (the hero's report rows, the account's EV
-- rows) instead of a probe per hand (2-3 s at 1M hands).
create or replace function public.stats_ev_missing(p_version text, p_ev_version text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select count(*)
  from public.hero_report_rows r
  where r.owner_id = (select auth.uid())
    and r.stats_version = p_version
    and not exists (
      select 1 from public.hand_stats_ev e
      where e.owner_id = (select auth.uid()) and e.ev_version = p_ev_version
        and e.hand_id = r.hand_id);
$$;

-- ---------------------------------------------------------------------------
-- 7. Backfill
-- ---------------------------------------------------------------------------

-- Every account's summaries, from the rows already stored.
do $$
declare
  v_owner uuid;
begin
  for v_owner in select distinct owner_id from public.hand_stats loop
    perform public.report_summaries_rebuild(v_owner);
  end loop;
end;
$$;

commit;

