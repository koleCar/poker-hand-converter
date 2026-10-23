-- ============================================================================
-- Big accounts' own readers under a second; R2.9's readers retired.
-- ============================================================================
--
-- Follow-up to `20270804090000_owner_first_readers.sql` (docs/RAIL-PLAN.md
-- §15, docs/DATABASE.md "Owner first"). That migration made every reader's
-- time depend on the caller's own rows only. What it left slow is an
-- account's *own* million rows, and readers it did not list:
--
--   1. R2.9's `stats_summary`, `stats_graph`, `stats_breakdown`,
--      `stats_sessions` (12-27 s at 1M hands). Nothing calls them since
--      R4.5c-2: the web's `/stats` is the shared Reports screen over
--      R4.5c-1's `report_*` readers and summaries, sessions included
--      (`report_sessions`); their TypeScript wrappers were exported and
--      imported by no one. Dropped, with the helpers only they used
--      (`hand_stats_filter_sql`, `hand_stats_counter_keys`,
--      `hand_stats_money_keys`, `stats_empty_summary`). `hands_facets`
--      (4.9 s; the browse UI's counts before R4.5b) goes too: its one caller
--      left was the web's header badge, which read its total and now reads
--      `library_count()`.
--   2. `library_facets` (7.7 s at 1M hands): every hand joined to its hero
--      row and EV row, then grouped thirteen ways. It now reads two
--      summaries kept by triggers, as R4.5c-1 and R5.2 do - the library's
--      groups counted per (owner, UTC month, the groups' values) - and only
--      the hands of a range's partial months, or of a search the summaries
--      cannot answer, hand by hand. Same answers (pgTAP compares it to its
--      previous body on random filters).
--   3. A table-name search (`library_page`, `library_facets`: a part of the
--      name, `ilike '%...%'`) read a big account's whole library when few
--      hands matched (2-6 s at 1M hands): under RLS a non-leakproof operator
--      such as `~~*` is never an index condition, so the trigram index was
--      never used. The part is now matched against the caller's distinct
--      table names (a skip scan of an owner-led btree) and the hands read by
--      those names.
--   4. The readers #244 did not list, under the same rule: the analysis
--      readers (`analysis_*`, `hands_needing_analysis*`, `drill_*`,
--      `trainer_summary`, `study_plan`), `get_hand`, and the forum's
--      `my_*` / notification readers - RLS alone, an InitPlan, or (for
--      `analysis_leak_sample`) the owner as an argument, which a SQL
--      function plans as an unknown. No grading or analysis rule changes:
--      every edit adds the policy's own predicate (`owner_id = v_owner`) on
--      a table the statement reads, or binds the caller once, or plans per
--      call; the bodies are otherwise the previous ones.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Retired: R2.9's readers and the browse UI's old counts
-- ---------------------------------------------------------------------------

drop function public.stats_summary(jsonb);
drop function public.stats_graph(jsonb, integer);
drop function public.stats_breakdown(jsonb, text);
drop function public.stats_sessions(jsonb, integer);
drop function public.hand_stats_filter_sql();
drop function public.hand_stats_counter_keys();
drop function public.hand_stats_money_keys();
drop function public.stats_empty_summary(text);
drop function public.hands_facets();

-- ---------------------------------------------------------------------------
-- 2. The library's counts, kept by the rows' own statements
-- ---------------------------------------------------------------------------
--
-- `library_facets` counts an account's hands by twelve groups, each group's
-- values under the other groups' filters. Its rows are `library_rows`': a
-- hand, its hero's statistics row at a version (pot type, stack band) and
-- that seat's EV row at a version (all-in or not). Two summaries hold what
-- those rows are made of, per UTC month:
--
--   * `library_hand_counts` - hands per (owner, month, the hand's own groups:
--     room, format, variant, limit, size, stake, position, result,
--     anonymity, and the stake's currency and blinds the chips show);
--   * `library_hero_counts` - per (owner, statistics version, EV version,
--     month, the hand's groups, pot type, stack band): with EV version ''
--     every hero row; with 'ev/N' the hero rows whose EV row at N is an
--     all-in.
--
-- A filter's rows for (version, EV version) are then a signed sum: each
-- hand counted once without a pot type, stack or all-in; minus, plus each
-- hero row moving its hand to its pot type and stack; minus, plus each
-- all-in pair moving it to all-in. That is exactly `library_rows`' left
-- joins (one hero row per hand and version, as every reader assumes).
--
-- Kept by statement triggers in the writer's transaction (every insert and
-- delete path; R4.5c-1's account lock orders them and makes a hero row and
-- an EV row written by two transactions counted by the later one). A hand
-- deleted while its account stays (nothing does that today: hands go with
-- their account) takes its hero rows with it before the hand's own trigger
-- runs, so they can no longer say which counts they were in: the account is
-- marked `library_counts_stale` and its readers read every hand until
-- `library_counts_rebuild` (also run by `refresh_report_summaries`) counts
-- it again. An UPDATE of any of the three tables recounts its accounts.

create table public.library_hand_counts (
  owner_id             uuid not null references auth.users (id) on delete cascade,
  -- The UTC month of `played_at` (its first day); '-infinity' for a hand without a time.
  month                date not null,
  site                 text not null,
  game_format          public.game_format not null,
  -- '' where the hand has none.
  variant              text not null,
  limit_type           text not null,
  -- 'hu', '6max', 'full' (`library_size`).
  size                 text not null,
  -- 'USD:200', 'chips' (`library_stake`).
  stake                text not null,
  "position"           text not null,
  -- 'won', 'lost', 'even', '' (`library_result`).
  result               text not null,
  site_anonymization   public.site_anonymization not null,
  currency             text not null,
  currency_symbol      text,
  currency_minor_units smallint not null,
  small_blind          bigint,
  big_blind            bigint,
  hands                bigint not null,
  constraint library_hand_counts_key unique nulls not distinct (
    owner_id, month, site, game_format, variant, limit_type, size, stake, "position", result,
    site_anonymization, currency, currency_symbol, currency_minor_units, small_blind, big_blind)
);

comment on table public.library_hand_counts is
  'Hands per (owner, UTC month, the library''s groups); kept by triggers on hands. Read by library_facets.';

create table public.library_hero_counts (
  owner_id             uuid not null references auth.users (id) on delete cascade,
  stats_version        text not null,
  -- '': every hero row; 'ev/N': the hero rows whose EV row at N is an all-in.
  ev_version           text not null,
  month                date not null,
  site                 text not null,
  game_format          public.game_format not null,
  variant              text not null,
  limit_type           text not null,
  size                 text not null,
  stake                text not null,
  "position"           text not null,
  result               text not null,
  site_anonymization   public.site_anonymization not null,
  currency             text not null,
  currency_symbol      text,
  currency_minor_units smallint not null,
  small_blind          bigint,
  big_blind            bigint,
  -- '' where the row has none; the stack in `library_stack`'s bands.
  pot_type             text not null,
  stack                text not null,
  hands                bigint not null,
  constraint library_hero_counts_key unique nulls not distinct (
    owner_id, stats_version, ev_version, month, site, game_format, variant, limit_type, size, stake,
    "position", result, site_anonymization, currency, currency_symbol, currency_minor_units, small_blind,
    big_blind, pot_type, stack)
);

comment on table public.library_hero_counts is
  'Hero statistics rows (ev_version '''') and their all-in EV rows (ev_version ''ev/N'') per (owner, version, UTC month, the library''s groups, pot type, stack); kept by triggers on hands, hand_stats and hand_stats_ev. Read by library_facets.';

create table public.library_counts_stale (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  since    timestamptz not null default now()
);

comment on table public.library_counts_stale is
  'Accounts whose library counts cannot be kept exactly (a hand deleted while the account stays); library_facets reads their hands until library_counts_rebuild.';

alter table public.library_hand_counts enable row level security;
alter table public.library_hero_counts enable row level security;
alter table public.library_counts_stale enable row level security;
create policy library_hand_counts_owner_select on public.library_hand_counts
  for select to authenticated using (owner_id = (select auth.uid()));
create policy library_hero_counts_owner_select on public.library_hero_counts
  for select to authenticated using (owner_id = (select auth.uid()));
create policy library_counts_stale_owner_select on public.library_counts_stale
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.library_hand_counts, public.library_hero_counts, public.library_counts_stale
  from public, anon, authenticated;
grant select on public.library_hand_counts, public.library_hero_counts, public.library_counts_stale
  to authenticated;

-- The account's counts recounted from its rows: the backfill below, the
-- repair, and the answer to an UPDATE of the counted tables.
create or replace function public.library_counts_rebuild(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hand_keys bigint;
  v_hero_keys bigint;
begin
  if p_owner is null then
    raise exception 'library_counts_rebuild needs an owner.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || p_owner::text, 0));

  delete from public.library_hand_counts where owner_id = p_owner;
  delete from public.library_hero_counts where owner_id = p_owner;
  delete from public.library_counts_stale where owner_id = p_owner;

  insert into public.library_hand_counts (owner_id, month, site, game_format, variant, limit_type, size, stake, "position", result, site_anonymization, currency, currency_symbol, currency_minor_units, small_blind, big_blind, hands)
  select x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, count(*)
  from (
    select h.owner_id,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind
    from public.hands h
    where h.owner_id = p_owner
  ) x
  group by x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind;
  get diagnostics v_hand_keys = row_count;

  insert into public.library_hero_counts (owner_id, stats_version, ev_version, month, site, game_format, variant, limit_type, size, stake, "position", result, site_anonymization, currency, currency_symbol, currency_minor_units, small_blind, big_blind, pot_type, stack, hands)
  select x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack, count(*)
  from (
    select s.owner_id, s.stats_version, ''::text as ev_version,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind,
           coalesce(s.pot_type, '') as pot_type,
           case
             when s.starting_stack_bb_tenths is null then ''
             when s.starting_stack_bb_tenths < 400 then '0-40'
             when s.starting_stack_bb_tenths < 800 then '40-80'
             when s.starting_stack_bb_tenths < 1200 then '80-120'
             else '120+'
           end as stack
    from public.hand_stats s
    join public.hands h on h.id = s.hand_id and h.owner_id = p_owner
    where s.owner_id = p_owner and s.is_hero
    union all
    select s.owner_id, s.stats_version, e.ev_version,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind,
           coalesce(s.pot_type, '') as pot_type,
           case
             when s.starting_stack_bb_tenths is null then ''
             when s.starting_stack_bb_tenths < 400 then '0-40'
             when s.starting_stack_bb_tenths < 800 then '40-80'
             when s.starting_stack_bb_tenths < 1200 then '80-120'
             else '120+'
           end as stack
    from public.hand_stats s
    join public.hands h on h.id = s.hand_id and h.owner_id = p_owner
    join public.hand_stats_ev e on e.hand_id = s.hand_id and e.owner_id = p_owner and e.seat = s.seat and e.applicable
    where s.owner_id = p_owner and s.is_hero
  ) x
  group by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack;
  get diagnostics v_hero_keys = row_count;

  return jsonb_build_object('handKeys', v_hand_keys, 'heroKeys', v_hero_keys);
end;
$$;

-- Hands: counted as they arrive.
create or replace function public.hands_library_counts_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- R4.5c-1's account lock, to commit: one writer of an account's counts at
  -- a time, and the upserts in one order.
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from inserted order by 1) o;

  insert into public.library_hand_counts as c (owner_id, month, site, game_format, variant, limit_type, size, stake, "position", result, site_anonymization, currency, currency_symbol, currency_minor_units, small_blind, big_blind, hands)
  select x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, count(*)
  from (
    select h.owner_id,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind
    from inserted h
  ) x
  group by x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind
  order by x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind
  on conflict on constraint library_hand_counts_key do update set hands = c.hands + excluded.hands;

  return null;
end;
$$;

create or replace function public.hands_library_counts_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from deleted order by 1) o;

  -- An account deleted takes its counts with it (cascade): only the hands of
  -- accounts that stay are taken back.
  merge into public.library_hand_counts c
  using (
    select x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, count(*) as hands
    from (
      select h.owner_id,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind
      from deleted h
      where h.owner_id in (
        select o.owner_id from (select distinct owner_id from deleted) o
        where exists (select 1 from auth.users u where u.id = o.owner_id))
    ) x
    group by x.owner_id, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind
  ) x
  on c.owner_id = x.owner_id and c.month = x.month and c.site = x.site and c.game_format = x.game_format
     and c.variant = x.variant and c.limit_type = x.limit_type and c.size = x.size and c.stake = x.stake
     and c."position" = x."position" and c.result = x.result
     and c.site_anonymization = x.site_anonymization and c.currency = x.currency
     and c.currency_symbol is not distinct from x.currency_symbol
     and c.currency_minor_units = x.currency_minor_units
     and c.small_blind is not distinct from x.small_blind
     and c.big_blind is not distinct from x.big_blind
  when matched and c.hands <= x.hands then delete
  when matched then update set hands = c.hands - x.hands;

  return null;
end;
$$;

-- Statistics rows: the hero's, with the EV rows already there.
create or replace function public.hand_stats_library_counts_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from inserted where is_hero order by 1) o;

  insert into public.library_hero_counts as c (owner_id, stats_version, ev_version, month, site, game_format, variant, limit_type, size, stake, "position", result, site_anonymization, currency, currency_symbol, currency_minor_units, small_blind, big_blind, pot_type, stack, hands)
  select x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack, count(*)
  from (
    select s.owner_id, s.stats_version, v.ev_version,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind,
           coalesce(s.pot_type, '') as pot_type,
           case
             when s.starting_stack_bb_tenths is null then ''
             when s.starting_stack_bb_tenths < 400 then '0-40'
             when s.starting_stack_bb_tenths < 800 then '40-80'
             when s.starting_stack_bb_tenths < 1200 then '80-120'
             else '120+'
           end as stack
    from inserted s
    join public.hands h on h.id = s.hand_id and h.owner_id = s.owner_id
    cross join lateral (
      select ''::text as ev_version
      union all
      select e.ev_version from public.hand_stats_ev e
      where e.hand_id = s.hand_id and e.owner_id = s.owner_id and e.seat = s.seat and e.applicable
    ) v
    where s.is_hero
  ) x
  group by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack
  order by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack
  on conflict on constraint library_hero_counts_key do update set hands = c.hands + excluded.hands;

  return null;
end;
$$;

create or replace function public.hand_stats_library_counts_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from deleted where is_hero order by 1) o;

  merge into public.library_hero_counts c
  using (
    select x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack, count(*) as hands
    from (
      select s.owner_id, s.stats_version, v.ev_version,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind,
           coalesce(s.pot_type, '') as pot_type,
           case
             when s.starting_stack_bb_tenths is null then ''
             when s.starting_stack_bb_tenths < 400 then '0-40'
             when s.starting_stack_bb_tenths < 800 then '40-80'
             when s.starting_stack_bb_tenths < 1200 then '80-120'
             else '120+'
           end as stack
      from deleted s
      join public.hands h on h.id = s.hand_id and h.owner_id = s.owner_id
      cross join lateral (
        select ''::text as ev_version
        union all
        select e.ev_version from public.hand_stats_ev e
        where e.hand_id = s.hand_id and e.owner_id = s.owner_id and e.seat = s.seat and e.applicable
      ) v
      where s.is_hero
    ) x
    group by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack
  ) x
  on c.owner_id = x.owner_id and c.stats_version = x.stats_version and c.ev_version = x.ev_version
     and c.month = x.month and c.site = x.site and c.game_format = x.game_format
     and c.variant = x.variant and c.limit_type = x.limit_type and c.size = x.size and c.stake = x.stake
     and c."position" = x."position" and c.result = x.result
     and c.site_anonymization = x.site_anonymization and c.currency = x.currency
     and c.currency_symbol is not distinct from x.currency_symbol
     and c.currency_minor_units = x.currency_minor_units
     and c.small_blind is not distinct from x.small_blind
     and c.big_blind is not distinct from x.big_blind and c.pot_type = x.pot_type and c.stack = x.stack
  when matched and c.hands <= x.hands then delete
  when matched then update set hands = c.hands - x.hands;

  -- Hero rows whose hand is gone while the account stays (a hand's delete
  -- cascades here before its own trigger runs): which counts they were in
  -- cannot be known any more.
  insert into public.library_counts_stale (owner_id)
  select distinct s.owner_id
  from deleted s
  where s.is_hero
    and not exists (select 1 from public.hands h where h.id = s.hand_id)
    and exists (select 1 from auth.users u where u.id = s.owner_id)
  on conflict (owner_id) do nothing;

  return null;
end;
$$;

-- EV rows: an all-in pairs with the hero row already there.
create or replace function public.hand_stats_ev_library_counts_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from inserted where applicable order by 1) o;

  insert into public.library_hero_counts as c (owner_id, stats_version, ev_version, month, site, game_format, variant, limit_type, size, stake, "position", result, site_anonymization, currency, currency_symbol, currency_minor_units, small_blind, big_blind, pot_type, stack, hands)
  select x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack, count(*)
  from (
    select s.owner_id, s.stats_version, e.ev_version,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind,
           coalesce(s.pot_type, '') as pot_type,
           case
             when s.starting_stack_bb_tenths is null then ''
             when s.starting_stack_bb_tenths < 400 then '0-40'
             when s.starting_stack_bb_tenths < 800 then '40-80'
             when s.starting_stack_bb_tenths < 1200 then '80-120'
             else '120+'
           end as stack
    from inserted e
    join public.hand_stats s on s.hand_id = e.hand_id and s.owner_id = e.owner_id and s.seat = e.seat and s.is_hero
    join public.hands h on h.id = e.hand_id and h.owner_id = e.owner_id
    where e.applicable
  ) x
  group by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack
  order by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack
  on conflict on constraint library_hero_counts_key do update set hands = c.hands + excluded.hands;

  return null;
end;
$$;

create or replace function public.hand_stats_ev_library_counts_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
  from (select distinct owner_id from deleted where applicable order by 1) o;

  merge into public.library_hero_counts c
  using (
    select x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack, count(*) as hands
    from (
      select s.owner_id, s.stats_version, e.ev_version,
           coalesce(date_trunc('month', h.played_at at time zone 'UTC')::date, '-infinity'::date) as month,
           h.site as site,
           h.game_format as game_format,
           coalesce(h.variant, '') as variant,
           coalesce(h.limit_type, '') as limit_type,
           case
             when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
             when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
             else 'full'
           end as size,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           coalesce(h.hero_position, '') as "position",
           case
             when h.hero_profit is null then ''
             when h.hero_profit > 0 then 'won'
             when h.hero_profit < 0 then 'lost'
             else 'even'
           end as result,
           h.site_anonymization as site_anonymization,
           h.currency as currency,
           h.currency_symbol as currency_symbol,
           h.currency_minor_units as currency_minor_units,
           h.small_blind as small_blind,
           h.big_blind as big_blind,
           coalesce(s.pot_type, '') as pot_type,
           case
             when s.starting_stack_bb_tenths is null then ''
             when s.starting_stack_bb_tenths < 400 then '0-40'
             when s.starting_stack_bb_tenths < 800 then '40-80'
             when s.starting_stack_bb_tenths < 1200 then '80-120'
             else '120+'
           end as stack
      from deleted e
      join public.hand_stats s on s.hand_id = e.hand_id and s.owner_id = e.owner_id and s.seat = e.seat and s.is_hero
      join public.hands h on h.id = e.hand_id and h.owner_id = e.owner_id
      where e.applicable
    ) x
    group by x.owner_id, x.stats_version, x.ev_version, x.month, x.site, x.game_format, x.variant, x.limit_type, x.size, x.stake, x."position", x.result, x.site_anonymization, x.currency, x.currency_symbol, x.currency_minor_units, x.small_blind, x.big_blind, x.pot_type, x.stack
  ) x
  on c.owner_id = x.owner_id and c.stats_version = x.stats_version and c.ev_version = x.ev_version
     and c.month = x.month and c.site = x.site and c.game_format = x.game_format
     and c.variant = x.variant and c.limit_type = x.limit_type and c.size = x.size and c.stake = x.stake
     and c."position" = x."position" and c.result = x.result
     and c.site_anonymization = x.site_anonymization and c.currency = x.currency
     and c.currency_symbol is not distinct from x.currency_symbol
     and c.currency_minor_units = x.currency_minor_units
     and c.small_blind is not distinct from x.small_blind
     and c.big_blind is not distinct from x.big_blind and c.pot_type = x.pot_type and c.stack = x.stack
  when matched and c.hands <= x.hands then delete
  when matched then update set hands = c.hands - x.hands;

  insert into public.library_counts_stale (owner_id)
  select distinct e.owner_id
  from deleted e
  where e.applicable
    and not exists (select 1 from public.hands h where h.id = e.hand_id)
    and exists (select 1 from auth.users u where u.id = e.owner_id)
  on conflict (owner_id) do nothing;

  return null;
end;
$$;

-- Nothing updates these tables (no grant, no function): a fix by hand as
-- `postgres` recounts the accounts it touched.
create or replace function public.library_counts_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  for v_owner in
    select o.owner_id
    from (select owner_id from old_rows union select owner_id from new_rows) o
    where exists (select 1 from auth.users u where u.id = o.owner_id)
    order by 1
  loop
    perform public.library_counts_rebuild(v_owner);
  end loop;
  return null;
end;
$$;

create or replace function public.library_counts_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'hands' then
    truncate public.library_hand_counts, public.library_hero_counts, public.library_counts_stale;
  elsif tg_table_name = 'hand_stats' then
    truncate public.library_hero_counts;
  else
    delete from public.library_hero_counts where ev_version <> '';
  end if;
  return null;
end;
$$;

revoke all on function public.library_counts_rebuild(uuid) from public, anon, authenticated;
revoke all on function public.hands_library_counts_insert() from public, anon, authenticated;
revoke all on function public.hands_library_counts_delete() from public, anon, authenticated;
revoke all on function public.hand_stats_library_counts_insert() from public, anon, authenticated;
revoke all on function public.hand_stats_library_counts_delete() from public, anon, authenticated;
revoke all on function public.hand_stats_ev_library_counts_insert() from public, anon, authenticated;
revoke all on function public.hand_stats_ev_library_counts_delete() from public, anon, authenticated;
revoke all on function public.library_counts_update() from public, anon, authenticated;
revoke all on function public.library_counts_truncate() from public, anon, authenticated;

create trigger hands_library_counts_after_insert
  after insert on public.hands
  referencing new table as inserted
  for each statement execute function public.hands_library_counts_insert();
create trigger hands_library_counts_after_delete
  after delete on public.hands
  referencing old table as deleted
  for each statement execute function public.hands_library_counts_delete();
create trigger hands_library_counts_after_update
  after update on public.hands
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.library_counts_update();
create trigger hands_library_counts_after_truncate
  after truncate on public.hands
  for each statement execute function public.library_counts_truncate();

create trigger hand_stats_library_counts_after_insert
  after insert on public.hand_stats
  referencing new table as inserted
  for each statement execute function public.hand_stats_library_counts_insert();
create trigger hand_stats_library_counts_after_delete
  after delete on public.hand_stats
  referencing old table as deleted
  for each statement execute function public.hand_stats_library_counts_delete();
create trigger hand_stats_library_counts_after_update
  after update on public.hand_stats
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.library_counts_update();
create trigger hand_stats_library_counts_after_truncate
  after truncate on public.hand_stats
  for each statement execute function public.library_counts_truncate();

create trigger hand_stats_ev_library_counts_after_insert
  after insert on public.hand_stats_ev
  referencing new table as inserted
  for each statement execute function public.hand_stats_ev_library_counts_insert();
create trigger hand_stats_ev_library_counts_after_delete
  after delete on public.hand_stats_ev
  referencing old table as deleted
  for each statement execute function public.hand_stats_ev_library_counts_delete();
create trigger hand_stats_ev_library_counts_after_update
  after update on public.hand_stats_ev
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.library_counts_update();
create trigger hand_stats_ev_library_counts_after_truncate
  after truncate on public.hand_stats_ev
  for each statement execute function public.library_counts_truncate();

-- The caller's repair (R4.5c-1) recounts the library as well.
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
  perform public.library_counts_rebuild(v_owner);
  return public.report_summaries_rebuild(v_owner);
end;
$$;

-- The backfill: every account with hands.
select public.library_counts_rebuild(u.id)
from auth.users u
where exists (select 1 from public.hands h where h.owner_id = u.id);

-- ---------------------------------------------------------------------------
-- 3. library_facets over the counts
-- ---------------------------------------------------------------------------
--
-- The same answer as before (the counts beside the chips, each group's
-- values under the other groups' filters), from the summaries' rows - each
-- weighted by its hands - instead of every hand:
--
--   * no range: every month of the summaries;
--   * a range (`from`, `to`): its whole UTC months from the summaries, the
--     hands of its partial months at either end from `library_rows` (a range
--     inside one month is read hand by hand);
--   * a search the summaries do not hold (hero cards or class, board, a
--     player, showdown, table name, minimum pot, showdown or winner
--     positions), or an account marked stale: `library_rows` for every hand,
--     as before.

create or replace function public.library_facets(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
set work_mem = '64MB'
as $$
declare
  v_owner     uuid := auth.uid();
  v_filter    jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_stats     text := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        text := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_from      timestamptz := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        timestamptz := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_sites     text[] := public.library_list(v_filter, 'sites');
  v_formats   text[] := public.library_list(v_filter, 'formats');
  v_variants  text[] := public.library_list(v_filter, 'variants');
  v_limits    text[] := public.library_list(v_filter, 'limits');
  v_sizes     text[] := public.library_list(v_filter, 'sizes');
  v_stakes    text[] := public.library_list(v_filter, 'stakes');
  v_positions text[] := public.library_list(v_filter, 'positions');
  v_pot_types text[] := public.library_list(v_filter, 'potTypes');
  v_results   text[] := public.library_list(v_filter, 'results');
  v_stacks    text[] := public.library_list(v_filter, 'stacks');
  v_anons     text[] := public.library_list(v_filter, 'anonymizations');
  v_all_in    boolean := case when jsonb_typeof(v_filter -> 'allIn') = 'boolean' then (v_filter ->> 'allIn')::boolean end;
  v_stale     boolean;
  -- The summaries answer: their months [v_lo, v_hi) (a null bound: open),
  -- every month when there is no range at all.
  v_counted   boolean;
  v_lo        date;
  v_hi        date;
  v_lo_at     timestamptz;
  v_hi_at     timestamptz;
  -- What is read hand by hand (`library_rows`' filter; null: nothing).
  v_head      jsonb;
  v_tail      jsonb;
  v_library   bigint;
  v_result    jsonb;
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  v_stale := exists (select 1 from public.library_counts_stale s where s.owner_id = v_owner);
  -- The searches `library_rows` applies to a hand itself.
  v_counted := not v_stale and not coalesce(
       cardinality(public.library_list(v_filter, 'heroCards')) > 0
    or cardinality(public.library_list(v_filter, 'heroHandClasses')) > 0
    or cardinality(public.library_list(v_filter, 'board')) > 0
    or nullif(btrim(coalesce(v_filter ->> 'player', '')), '') is not null
    or jsonb_typeof(v_filter -> 'showdown') = 'boolean'
    or nullif(btrim(coalesce(v_filter ->> 'tableName', '')), '') is not null
    or jsonb_typeof(v_filter -> 'minPot') = 'number'
    or cardinality(public.library_list(v_filter, 'showdownPositions')) > 0
    or cardinality(public.library_list(v_filter, 'winnerPositions')) > 0, false);

  if v_counted and (v_from is not null or v_to is not null) then
    if v_from is not null then
      v_lo := date_trunc('month', v_from at time zone 'UTC')::date;
      if (v_lo::timestamp at time zone 'UTC') < v_from then
        v_lo := (v_lo + interval '1 month')::date;
      end if;
      v_lo_at := v_lo::timestamp at time zone 'UTC';
    end if;
    if v_to is not null then
      v_hi := date_trunc('month', v_to at time zone 'UTC')::date;
      v_hi_at := v_hi::timestamp at time zone 'UTC';
    end if;
    if v_lo is not null and v_hi is not null and v_lo >= v_hi then
      -- Not one whole month in the range.
      v_counted := false;
    else
      if v_from is not null and v_from < v_lo_at then
        v_head := v_filter || jsonb_build_object('from', v_from, 'to', v_lo_at);
      end if;
      if v_to is not null and v_hi_at < v_to then
        v_tail := v_filter || jsonb_build_object('from', v_hi_at, 'to', v_to);
      end if;
    end if;
  end if;
  if not v_counted then
    v_head := v_filter;
    v_tail := null;
  end if;

  with s as (
    -- The summaries' rows, signed (see the tables' comment), summed per key.
    select k.site, k.format, k.variant, k.limit_type, k.size, k.stake, k."position", k.pot_type, k.result,
           k.stack, k.all_in, k.anonymization, k.currency, k.currency_symbol, k.minor_units, k.small_blind,
           k.big_blind, sum(k.n)::bigint as w
    from (
      select a.site, a.game_format::text as format, a.variant, a.limit_type, a.size, a.stake, a."position",
             ''::text as pot_type, a.result, ''::text as stack, false as all_in,
             a.site_anonymization::text as anonymization, a.currency, a.currency_symbol,
             a.currency_minor_units as minor_units, a.small_blind, a.big_blind, a.hands as n
      from public.library_hand_counts a
      where v_counted
        and a.owner_id = v_owner
        and (v_lo is null or a.month >= v_lo)
        and (v_hi is null or a.month < v_hi)
        and (v_from is null and v_to is null or a.month > '-infinity'::date)
      union all
      select b.site, b.game_format::text, b.variant, b.limit_type, b.size, b.stake, b."position",
             v.pot_type, b.result, v.stack, v.all_in,
             b.site_anonymization::text, b.currency, b.currency_symbol,
             b.currency_minor_units, b.small_blind, b.big_blind, v.n
      from public.library_hero_counts b
      cross join lateral (values
        (case when b.ev_version = '' then '' else b.pot_type end,
         case when b.ev_version = '' then '' else b.stack end, false, -b.hands),
        (b.pot_type, b.stack, b.ev_version <> '', b.hands)) v(pot_type, stack, all_in, n)
      where v_counted
        and b.owner_id = v_owner
        and b.stats_version = v_stats
        and b.ev_version in ('', v_ev)
        and (v_lo is null or b.month >= v_lo)
        and (v_hi is null or b.month < v_hi)
        and (v_from is null and v_to is null or b.month > '-infinity'::date)
    ) k
    group by k.site, k.format, k.variant, k.limit_type, k.size, k.stake, k."position", k.pot_type, k.result,
             k.stack, k.all_in, k.anonymization, k.currency, k.currency_symbol, k.minor_units, k.small_blind,
             k.big_blind
    having sum(k.n) > 0
  ),
  d as (
    select s.w, s.site, s.format, s.variant, s.limit_type, s.size, s.stake, s."position", s.pot_type, s.result,
           s.stack, s.all_in, s.anonymization, s.currency, s.currency_symbol, s.minor_units, s.small_blind,
           s.big_blind
    from s
    union all
    select 1::bigint, x.site, x.format, x.variant, x.limit_type, x.size, x.stake, x."position", x.pot_type,
           x.result, x.stack, x.all_in, x.anonymization, x.currency, x.currency_symbol, x.minor_units,
           x.small_blind, x.big_blind
    from public.library_rows(v_head) x
    where v_head is not null
    union all
    select 1::bigint, x.site, x.format, x.variant, x.limit_type, x.size, x.stake, x."position", x.pot_type,
           x.result, x.stack, x.all_in, x.anonymization, x.currency, x.currency_symbol, x.minor_units,
           x.small_blind, x.big_blind
    from public.library_rows(v_tail) x
    where v_tail is not null
  ),
  r as (
    select d.*,
           cardinality(v_sites) = 0 or d.site = any (v_sites) as m_site,
           cardinality(v_formats) = 0 or d.format = any (v_formats) as m_format,
           cardinality(v_variants) = 0 or d.variant = any (v_variants) as m_variant,
           cardinality(v_limits) = 0 or d.limit_type = any (v_limits) as m_limit,
           cardinality(v_sizes) = 0 or d.size = any (v_sizes) as m_size,
           cardinality(v_stakes) = 0 or d.stake = any (v_stakes) as m_stake,
           cardinality(v_positions) = 0 or d."position" = any (v_positions) as m_position,
           cardinality(v_pot_types) = 0 or d.pot_type = any (v_pot_types) as m_pot_type,
           cardinality(v_results) = 0 or d.result = any (v_results) as m_result,
           cardinality(v_stacks) = 0 or d.stack = any (v_stacks) as m_stack,
           v_all_in is null or d.all_in = v_all_in as m_all_in,
           cardinality(v_anons) = 0 or d.anonymization = any (v_anons) as m_anon
    from d
  ),
  g as (
    select
      grouping(site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in, anonymization) as gid,
      site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in, anonymization,
      coalesce(sum(w) filter (where m_format and m_variant and m_limit and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_site,
      coalesce(sum(w) filter (where m_site and m_variant and m_limit and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_format,
      coalesce(sum(w) filter (where m_site and m_format and m_limit and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_variant,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_limit_type,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_size,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_stake,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_position,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_result and m_stack and m_all_in and m_anon), 0) as c_pot_type,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_stack and m_all_in and m_anon), 0) as c_result,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_all_in and m_anon), 0) as c_stack,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_stack and m_anon), 0) as c_all_in,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_stack and m_all_in), 0) as c_anonymization,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_total,
      min(currency) as currency,
      min(currency_symbol) as currency_symbol,
      min(minor_units) as minor_units,
      min(small_blind) as small_blind,
      min(big_blind) as big_blind
    from r
    group by grouping sets ((site), (format), (variant), (limit_type), (size), (stake), ("position"), (pot_type), (result), (stack), (all_in), (anonymization), ())
  ),
  -- `grouping()` sets a bit per argument *not* in the row's set, the first
  -- argument highest: the set of argument i (0-based, of 12) is
  -- 4095 - 2^(11 - i).
  f as (
    select
      jsonb_agg(jsonb_build_object('value', site, 'count', c_site) order by c_site desc, site)
        filter (where gid = 4095 - 2048 and site <> '') as sites,
      jsonb_agg(jsonb_build_object('value', format, 'count', c_format) order by c_format desc, format)
        filter (where gid = 4095 - 1024 and format <> '') as formats,
      jsonb_agg(jsonb_build_object('value', variant, 'count', c_variant) order by c_variant desc, variant)
        filter (where gid = 4095 - 512 and variant <> '') as variants,
      jsonb_agg(jsonb_build_object('value', limit_type, 'count', c_limit_type) order by c_limit_type desc, limit_type)
        filter (where gid = 4095 - 256 and limit_type <> '') as limits,
      jsonb_agg(jsonb_build_object('value', size, 'count', c_size) order by c_size desc, size)
        filter (where gid = 4095 - 128 and size <> '') as sizes,
      jsonb_agg(jsonb_build_object('value', stake, 'count', c_stake,
                                   'currency', case when stake <> 'chips' then currency end,
                                   'currencySymbol', case when stake <> 'chips' then coalesce(currency_symbol, '') end,
                                   'minorUnits', case when stake <> 'chips' then minor_units end,
                                   'smallBlind', case when stake <> 'chips' then small_blind end,
                                   'bigBlind', case when stake <> 'chips' then big_blind end)
                order by stake = 'chips', currency, big_blind)
        filter (where gid = 4095 - 64 and stake <> '') as stakes,
      jsonb_agg(jsonb_build_object('value', "position", 'count', c_position) order by c_position desc, "position")
        filter (where gid = 4095 - 32 and "position" <> '') as positions,
      jsonb_agg(jsonb_build_object('value', pot_type, 'count', c_pot_type) order by c_pot_type desc, pot_type)
        filter (where gid = 4095 - 16 and pot_type <> '') as pot_types,
      jsonb_agg(jsonb_build_object('value', result, 'count', c_result) order by c_result desc, result)
        filter (where gid = 4095 - 8 and result <> '') as results,
      jsonb_agg(jsonb_build_object('value', stack, 'count', c_stack) order by c_stack desc, stack)
        filter (where gid = 4095 - 4 and stack <> '') as stacks,
      jsonb_agg(jsonb_build_object('value', case when all_in then '1' else '0' end, 'count', c_all_in)
                order by all_in desc)
        filter (where gid = 4095 - 2) as all_in,
      jsonb_agg(jsonb_build_object('value', anonymization, 'count', c_anonymization) order by c_anonymization desc, anonymization)
        filter (where gid = 4095 - 1 and anonymization <> '') as anonymizations,
      max(c_total) filter (where gid = 4095) as total
    from g
  )
  select jsonb_build_object(
    'total', coalesce(f.total, 0),
    'library', case when v_stale then (select count(*) from public.hands h where h.owner_id = v_owner)
                    else (select coalesce(sum(a.hands), 0) from public.library_hand_counts a where a.owner_id = v_owner) end,
    'sites', coalesce(f.sites, '[]'::jsonb),
    'formats', coalesce(f.formats, '[]'::jsonb),
    'variants', coalesce(f.variants, '[]'::jsonb),
    'limits', coalesce(f.limits, '[]'::jsonb),
    'sizes', coalesce(f.sizes, '[]'::jsonb),
    'stakes', coalesce(f.stakes, '[]'::jsonb),
    'positions', coalesce(f.positions, '[]'::jsonb),
    'potTypes', coalesce(f.pot_types, '[]'::jsonb),
    'results', coalesce(f.results, '[]'::jsonb),
    'stacks', coalesce(f.stacks, '[]'::jsonb),
    'allIn', coalesce(f.all_in, '[]'::jsonb),
    'anonymizations', coalesce(f.anonymizations, '[]'::jsonb)
  ) into v_result
  from f;

  return v_result;
end;
$$;

comment on function public.library_facets(jsonb) is
  'The library''s counts beside its chips (R4.5b): from library_hand_counts / library_hero_counts, the hands of a range''s partial months and of searches from library_rows (owner first, planned per call).';

-- How many hands the caller has stored (the web's header badge, which read
-- `hands_facets()`'s total: every distinct value of the library computed to
-- show one number). From the counts; from the hands when stale.
create or replace function public.library_count()
returns bigint
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;
  if exists (select 1 from public.library_counts_stale s where s.owner_id = v_owner) then
    return (select count(*) from public.hands h where h.owner_id = v_owner);
  end if;
  return (select coalesce(sum(a.hands), 0)::bigint from public.library_hand_counts a where a.owner_id = v_owner);
end;
$$;

revoke all on function public.library_count() from public, anon;
grant execute on function public.library_count() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A table-name search starts from the owner's table names
-- ---------------------------------------------------------------------------
--
-- `table_name ilike '%...%'` cannot use an index for an invoker reader: under
-- RLS only leakproof operators may be index conditions (the policy runs
-- first), and `~~*` is not one - so the trigram index was never used by
-- `library_page` / `library_rows`, and a big account's search for a name few
-- hands have read its whole library (6 s at 1M hands). Now the part is
-- matched against the caller's distinct table names - a skip scan of
-- `hands_owner_table_idx` (`=` and `>` on text are leakproof), a few thousand
-- names at most - and the hands are read by those names (`= any`), through
-- the same index or the page's order. The same hands match: a name holds the
-- part exactly when it is one of the names that hold it.

create index hands_owner_table_idx on public.hands (owner_id, table_name) where table_name is not null;
drop index public.hands_table_trgm;

-- The caller's table names that hold `p_table` (case-insensitive; `%`, `_`
-- and `\` taken literally, as the library's search always has).
create or replace function public.library_table_names(p_table text)
returns text[]
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
    with recursive t(name) as (
      (select h.table_name from public.hands h
        where h.owner_id = v_owner and h.table_name is not null
        order by h.table_name limit 1)
      union all
      select (select h.table_name from public.hands h
               where h.owner_id = v_owner and h.table_name > t.name
               order by h.table_name limit 1)
      from t
      where t.name is not null
    )
    select coalesce(array_agg(t.name order by t.name), '{}'::text[])
    from t
    where t.name is not null
      and t.name ilike '%' || regexp_replace(p_table, '([%_\\])', '\\\1', 'g') || '%');
end;
$$;

revoke all on function public.library_table_names(text) from public, anon;
grant execute on function public.library_table_names(text) to authenticated;

CREATE OR REPLACE FUNCTION public.library_rows(p_filter jsonb)
 RETURNS TABLE(id uuid, played_at timestamp with time zone, total_pot bigint, hero_profit bigint, net_bb_milli bigint, ev_net bigint, ev_net_bb_milli bigint, site text, format text, variant text, limit_type text, size text, stake text, "position" text, pot_type text, result text, stack text, all_in boolean, currency text, currency_symbol text, minor_units smallint, small_blind bigint, big_blind bigint, anonymization text, m_site boolean, m_format boolean, m_variant boolean, m_limit boolean, m_size boolean, m_stake boolean, m_position boolean, m_pot_type boolean, m_result boolean, m_stack boolean, m_all_in boolean, m_anon boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET work_mem TO '64MB'
AS $function$
declare
  v_owner      uuid    := auth.uid();
  v_filter     jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_anons      text[]  := public.library_list(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end, 'anonymizations');
  v_sd_pos     text[]  := public.library_list(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end, 'showdownPositions');
  v_win_pos    text[]  := public.library_list(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end, 'winnerPositions');
  v_table      text    := nullif(btrim(coalesce(p_filter ->> 'tableName', '')), '');
  v_tables     text[];
  v_min_pot    numeric := case when jsonb_typeof(p_filter -> 'minPot') = 'number' then (p_filter ->> 'minPot')::numeric end;
  v_stats      text    := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev         text    := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites      text[];
  v_formats    text[];
  v_variants   text[];
  v_limits     text[];
  v_sizes      text[];
  v_stakes     text[];
  v_positions  text[];
  v_pot_types  text[];
  v_results    text[];
  v_stacks     text[];
  v_cards      text[];
  v_classes    text[];
  v_board      text[];
  v_all_in     boolean;
  v_showdown   boolean;
  v_player     text    := nullif(btrim(coalesce(v_filter ->> 'player', '')), '');
  v_from       timestamptz := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to         timestamptz := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
begin
  -- A part of the table's name: the caller's table names that hold it (see
  -- `library_table_names`), then those names by equality.
  if v_table is not null then
    v_tables := public.library_table_names(v_table);
  end if;
  -- A list of strings, or none (a missing key, a non-array or an empty one
  -- is "any").
  v_sites := public.library_list(v_filter, 'sites');
  v_formats := public.library_list(v_filter, 'formats');
  v_variants := public.library_list(v_filter, 'variants');
  v_limits := public.library_list(v_filter, 'limits');
  v_sizes := public.library_list(v_filter, 'sizes');
  v_stakes := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_pot_types := public.library_list(v_filter, 'potTypes');
  v_results := public.library_list(v_filter, 'results');
  v_stacks := public.library_list(v_filter, 'stacks');
  v_cards := public.library_list(v_filter, 'heroCards');
  v_classes := public.library_list(v_filter, 'heroHandClasses');
  v_board := public.library_list(v_filter, 'board');
  v_all_in   := case when jsonb_typeof(v_filter -> 'allIn') = 'boolean' then (v_filter ->> 'allIn')::boolean end;
  v_showdown := case when jsonb_typeof(v_filter -> 'showdown') = 'boolean' then (v_filter ->> 'showdown')::boolean end;

  return query
  with d as (
    select
      h.id,
      h.played_at,
      h.total_pot,
      h.hero_profit,
      hs.net_bb_milli,
      case when e.applicable then e.ev_net end as ev_net,
      case when e.applicable then e.ev_net_bb_milli end as ev_net_bb_milli,
      h.site,
      h.game_format::text as format,
      coalesce(h.variant, '') as variant,
      coalesce(h.limit_type, '') as limit_type,
      -- The helpers' rules written out: a call per row and group made the
      -- counts 2.6 times slower at 200 000 hands (they are not inlined).
      case
        when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
        when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
        else 'full'
      end as size,
      case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
      coalesce(h.hero_position, '') as "position",
      coalesce(hs.pot_type, '') as pot_type,
      case
        when h.hero_profit is null then ''
        when h.hero_profit > 0 then 'won'
        when h.hero_profit < 0 then 'lost'
        else 'even'
      end as result,
      case
        when hs.starting_stack_bb_tenths is null then ''
        when hs.starting_stack_bb_tenths < 400 then '0-40'
        when hs.starting_stack_bb_tenths < 800 then '40-80'
        when hs.starting_stack_bb_tenths < 1200 then '80-120'
        else '120+'
      end as stack,
      coalesce(e.applicable, false) as all_in,
      h.currency,
      h.currency_symbol,
      h.currency_minor_units as minor_units,
      h.small_blind,
      h.big_blind,
      h.site_anonymization::text as anonymization
    from public.hands h
    -- Owner first on every table: a join by hand alone let the planner hash
    -- every account's statistics rows.
    left join public.hand_stats hs
      on hs.hand_id = h.id and hs.owner_id = v_owner and hs.stats_version = v_stats and hs.is_hero
    left join public.hand_stats_ev e
      on e.hand_id = h.id and e.owner_id = v_owner and e.ev_version = v_ev and e.seat = hs.seat
    where h.owner_id = v_owner
      and (v_from is null or (h.played_at is not null and h.played_at >= v_from))
      and (v_to is null or (h.played_at is not null and h.played_at < v_to))
      and (cardinality(v_cards) = 0 or h.hero_cards @> v_cards)
      and (cardinality(v_classes) = 0 or h.hero_hand_class = any (v_classes))
      and (cardinality(v_board) = 0 or h.board_cards @> v_board)
      and (v_player is null or v_player = any (h.player_names))
      and (v_showdown is null or h.went_to_showdown = v_showdown)
      and (v_table is null or h.table_name = any (v_tables))
      and (v_min_pot is null or h.total_pot >= v_min_pot * h.currency_minor_units)
      and (cardinality(v_sd_pos) = 0 or h.showdown_positions && v_sd_pos)
      and (cardinality(v_win_pos) = 0 or h.winner_positions && v_win_pos)
  )
  select
    d.*,
    cardinality(v_sites) = 0 or d.site = any (v_sites),
    cardinality(v_formats) = 0 or d.format = any (v_formats),
    cardinality(v_variants) = 0 or d.variant = any (v_variants),
    cardinality(v_limits) = 0 or d.limit_type = any (v_limits),
    cardinality(v_sizes) = 0 or d.size = any (v_sizes),
    cardinality(v_stakes) = 0 or d.stake = any (v_stakes),
    cardinality(v_positions) = 0 or d."position" = any (v_positions),
    cardinality(v_pot_types) = 0 or d.pot_type = any (v_pot_types),
    cardinality(v_results) = 0 or d.result = any (v_results),
    cardinality(v_stacks) = 0 or d.stack = any (v_stacks),
    v_all_in is null or d.all_in = v_all_in,
    cardinality(v_anons) = 0 or d.anonymization = any (v_anons)
  from d;
end;
$function$;

CREATE OR REPLACE FUNCTION public.library_page(p_filter jsonb DEFAULT '{}'::jsonb, p_after jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner  uuid := auth.uid();
  v_filter jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_sort   text := coalesce(nullif(btrim(coalesce(v_filter ->> 'sort', '')), ''), 'newest');
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_col    text;
  v_type   text;
  v_desc   boolean;
  v_op     text;
  v_dir    text;
  v_has_after boolean := jsonb_typeof(p_after) = 'object' and coalesce(p_after ->> 'id', '') <> '';
  -- The owner is bound ($4), not an InitPlan: the planner sees whose rows
  -- these are and how many.
  v_where  text := 'h.owner_id = $4';
  v_rows   jsonb;
  v_last   jsonb;
  v_more   boolean;
  v_tables text[];
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  case v_sort
    when 'newest' then v_col := 'played_at';   v_type := 'timestamptz'; v_desc := true;
    when 'oldest' then v_col := 'played_at';   v_type := 'timestamptz'; v_desc := false;
    when 'pot'    then v_col := 'total_pot';   v_type := 'bigint';      v_desc := true;
    when 'won'    then v_col := 'hero_profit'; v_type := 'bigint';      v_desc := true;
    when 'lost'   then v_col := 'hero_profit'; v_type := 'bigint';      v_desc := false;
    else
      raise exception 'Unknown sort: %', v_sort using errcode = '22023';
  end case;
  v_op  := case when v_desc then '<' else '>' end;
  v_dir := case when v_desc then 'desc' else 'asc' end;

  -- The predicates, written for the groups that are set only, so the plan
  -- is the owner's index in the sort's order for the common case. Every
  -- value is read from the parameter ($1), never spliced in.
  if v_filter ? 'from' and coalesce(v_filter ->> 'from', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at >= ($1 ->> 'from')::timestamptz$w$;
  end if;
  if v_filter ? 'to' and coalesce(v_filter ->> 'to', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at < ($1 ->> 'to')::timestamptz$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'heroCards')) > 0 then
    v_where := v_where || $w$ and h.hero_cards @> public.library_list($1, 'heroCards')$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'heroHandClasses')) > 0 then
    v_where := v_where || $w$ and h.hero_hand_class = any (public.library_list($1, 'heroHandClasses'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'board')) > 0 then
    v_where := v_where || $w$ and h.board_cards @> public.library_list($1, 'board')$w$;
  end if;
  if coalesce(btrim(v_filter ->> 'player'), '') <> '' then
    v_where := v_where || $w$ and btrim($1 ->> 'player') = any (h.player_names)$w$;
  end if;
  if jsonb_typeof(v_filter -> 'showdown') = 'boolean' then
    v_where := v_where || $w$ and h.went_to_showdown = ($1 ->> 'showdown')::boolean$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'sites')) > 0 then
    v_where := v_where || $w$ and h.site = any (public.library_list($1, 'sites'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'formats')) > 0 then
    v_where := v_where || $w$ and h.game_format::text = any (public.library_list($1, 'formats'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'variants')) > 0 then
    v_where := v_where || $w$ and coalesce(h.variant, '') = any (public.library_list($1, 'variants'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'limits')) > 0 then
    v_where := v_where || $w$ and coalesce(h.limit_type, '') = any (public.library_list($1, 'limits'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'sizes')) > 0 then
    v_where := v_where || $w$ and public.library_size(h.max_seats, h.player_count) = any (public.library_list($1, 'sizes'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'stakes')) > 0 then
    v_where := v_where || $w$ and public.library_stake(h.game_format, h.currency, h.big_blind) = any (public.library_list($1, 'stakes'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'positions')) > 0 then
    v_where := v_where || $w$ and coalesce(h.hero_position, '') = any (public.library_list($1, 'positions'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'potTypes')) > 0 then
    v_where := v_where || $w$ and coalesce(hs.pot_type, '') = any (public.library_list($1, 'potTypes'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'results')) > 0 then
    v_where := v_where || $w$ and public.library_result(h.hero_profit) = any (public.library_list($1, 'results'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'stacks')) > 0 then
    v_where := v_where || $w$ and public.library_stack(hs.starting_stack_bb_tenths) = any (public.library_list($1, 'stacks'))$w$;
  end if;
  if coalesce(btrim(v_filter ->> 'tableName'), '') <> '' then
    -- The caller's table names holding the part, matched by equality ($5).
    v_tables := public.library_table_names(btrim(v_filter ->> 'tableName'));
    v_where := v_where || $w$ and h.table_name = any ($5)$w$;
  end if;
  if jsonb_typeof(v_filter -> 'minPot') = 'number' then
    v_where := v_where || $w$ and h.total_pot >= ($1 ->> 'minPot')::numeric * h.currency_minor_units$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'showdownPositions')) > 0 then
    v_where := v_where || $w$ and h.showdown_positions && public.library_list($1, 'showdownPositions')$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'winnerPositions')) > 0 then
    v_where := v_where || $w$ and h.winner_positions && public.library_list($1, 'winnerPositions')$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'anonymizations')) > 0 then
    v_where := v_where || $w$ and h.site_anonymization::text = any (public.library_list($1, 'anonymizations'))$w$;
  end if;
  if jsonb_typeof(v_filter -> 'allIn') = 'boolean' then
    v_where := v_where || $w$ and coalesce(e.applicable, false) = ($1 ->> 'allIn')::boolean$w$;
  end if;

  -- After the cursor: nulls last in either direction, ties by id in the
  -- sort's direction.
  if v_has_after then
    if jsonb_typeof(p_after -> 'value') in ('string', 'number') then
      v_where := v_where || format(
        $w$ and (h.%1$I is null or h.%1$I %2$s ($2 ->> 'value')::%3$s
                 or (h.%1$I = ($2 ->> 'value')::%3$s and h.id %2$s ($2 ->> 'id')::uuid))$w$,
        v_col, v_op, v_type);
    else
      v_where := v_where || format($w$ and h.%1$I is null and h.id %2$s ($2 ->> 'id')::uuid$w$, v_col, v_op);
    end if;
  end if;

  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object(
      'handKey', p.id,
      'site', p.site,
      'siteHandId', coalesce(p.site_hand_id, ''),
      'playedAt', p.played_at,
      'gameFormat', p.game_format,
      'variant', coalesce(p.variant, ''),
      'limitType', coalesce(p.limit_type, ''),
      'currency', p.currency,
      'currencySymbol', coalesce(p.currency_symbol, ''),
      'minorUnits', p.currency_minor_units,
      'smallBlind', p.small_blind,
      'bigBlind', p.big_blind,
      'ante', coalesce(p.ante, 0),
      'maxSeats', coalesce(p.max_seats, 0),
      'tableName', p.table_name,
      'heroPosition', p.hero_position,
      'heroCards', to_jsonb(p.hero_cards),
      'heroHandClass', p.hero_hand_class,
      'board', to_jsonb(p.board_cards),
      'heroNet', p.hero_profit,
      'heroNetBbMilli', p.net_bb_milli,
      'allIn', p.all_in,
      'evNet', p.ev_net,
      'evNetBbMilli', p.ev_net_bb_milli,
      'evPending', false,
      'potType', coalesce(p.pot_type, ''),
      'totalPot', p.total_pot,
      'showdown', p.went_to_showdown,
      'anonymization', p.site_anonymization,
      'hasNote', false,
      'tags', '[]'::jsonb,
      'sortValue', p.%1$I
    ) order by p.%1$I %2$s nulls last, p.id %2$s), '[]'::jsonb)
    from (
      select h.id, h.site, h.site_hand_id, h.played_at, h.game_format, h.variant, h.limit_type, h.currency,
             h.currency_symbol, h.currency_minor_units, h.small_blind, h.big_blind, h.ante, h.max_seats,
             h.table_name, h.hero_position, h.hero_cards, h.hero_hand_class, h.board_cards, h.hero_profit,
             h.total_pot, h.went_to_showdown, h.site_anonymization,
             hs.net_bb_milli, hs.pot_type,
             coalesce(e.applicable, false) as all_in,
             case when e.applicable then e.ev_net end as ev_net,
             case when e.applicable then e.ev_net_bb_milli end as ev_net_bb_milli
      from public.hands h
      left join public.hand_stats hs
        on hs.hand_id = h.id and hs.owner_id = $4 and hs.is_hero
       and hs.stats_version = coalesce(nullif(btrim(coalesce($1 ->> 'statsVersion', '')), ''), 'stats/1')
      left join public.hand_stats_ev e
        on e.hand_id = h.id and e.owner_id = $4 and e.seat = hs.seat
       and e.ev_version = coalesce(nullif(btrim(coalesce($1 ->> 'evVersion', '')), ''), 'ev/1')
      where %3$s
      order by h.%1$I %2$s nulls last, h.id %2$s
      limit $3 + 1
    ) p
  $q$, v_col, v_dir, v_where)
  into v_rows
  using v_filter, p_after, v_limit, v_owner, v_tables;

  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
  end if;

  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(r - 'sortValue' order by o)
                        from jsonb_array_elements(v_rows) with ordinality as t(r, o)), '[]'::jsonb),
    'next', case when v_more then jsonb_build_object('value', v_last -> 'sortValue', 'id', v_last -> 'handKey') end
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The older owner-scoped readers under the rule
-- ---------------------------------------------------------------------------
--
-- Their previous bodies (as `pg_get_functiondef` prints them), with only:
-- the caller bound once (`v_owner := auth.uid()`, not an InitPlan),
-- `owner_id = v_owner` on every owner table a statement reads that had none
-- (`hands`, `hand_analysis`, `decision_analysis` joined or probed by hand),
-- and `plan_cache_mode = force_custom_plan`. `analysis_graded_decisions` is
-- PL/pgSQL now (a SQL function plans its caller as an unknown). The predicate
-- is the policy's own, so no answer changes; grading is not touched.

CREATE OR REPLACE FUNCTION public.analysis_scope(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS SETOF hand_analysis
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner     uuid := auth.uid();
  v_grade     text := nullif(btrim(coalesce(p_filters ->> 'grade', '')), '');
  v_min_grade text := nullif(btrim(coalesce(p_filters ->> 'minGrade', '')), '');
begin
  if v_grade is not null and public.analysis_grade_rank(v_grade) is null then
    raise exception 'Unknown grade: %', v_grade using errcode = '22023';
  end if;
  if v_min_grade is not null and public.analysis_grade_rank(v_min_grade) is null then
    raise exception 'Unknown grade: %', v_min_grade using errcode = '22023';
  end if;

  return query
  select a.*
  from public.hand_analysis a
  join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
  where a.owner_id = v_owner
    and a.analysis_version = public.analysis_version_of(p_filters)
    and (nullif(p_filters ->> 'from', '') is null or h.played_at >= (p_filters ->> 'from')::timestamptz)
    and (nullif(p_filters ->> 'to', '') is null or h.played_at < (p_filters ->> 'to')::timestamptz)
    and (nullif(p_filters ->> 'site', '') is null or h.site = lower(btrim(p_filters ->> 'site')))
    and (nullif(p_filters ->> 'gameFormat', '') is null or h.game_format::text = p_filters ->> 'gameFormat')
    and (nullif(p_filters ->> 'currency', '') is null or h.currency = upper(btrim(p_filters ->> 'currency')))
    and (nullif(p_filters ->> 'bigBlind', '') is null or h.big_blind = (p_filters ->> 'bigBlind')::bigint)
    and (nullif(p_filters ->> 'position', '') is null or h.hero_position = upper(btrim(p_filters ->> 'position')))
    and (nullif(p_filters ->> 'potType', '') is null or a.pot_type = p_filters ->> 'potType')
    and (nullif(p_filters ->> 'status', '') is null or a.status = p_filters ->> 'status')
    and (coalesce((nullif(p_filters ->> 'flagged', ''))::boolean, false) = false or a.flag_count > 0)
    and (v_grade is null or a.grade = v_grade)
    and (v_min_grade is null
         or public.analysis_grade_rank(a.grade) >= public.analysis_grade_rank(v_min_grade))
    and (nullif(p_filters ->> 'street', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner
            and d.street = p_filters ->> 'street'))
    and (nullif(p_filters ->> 'flag', '') is null or exists (
          select 1 from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner
            and d.flags @> jsonb_build_array(jsonb_build_object('code', p_filters ->> 'flag'))));
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_graded_decisions(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(hand_id uuid, ord smallint, action_index integer, played_at timestamp with time zone, hero_position text, pot_type text, street text, scenario text, line text, "position" text, taken text, best text, spot_key text, source text, grade text, score numeric, ev_loss_bb numeric, ev_loss_pot numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
declare
  v_owner uuid := auth.uid();
begin
  return query
  select x.hand_id, x.ord, x.action_index, x.played_at, x.hero_position, x.pot_type,
         x.street, x.scenario, x.line, x.pos, x.taken, x.best,
         public.analysis_spot_key(x.street, x.scenario, x.line, x.pos, x.taken, x.best),
         x.source, x.grade, x.score, x.ev_loss_bb, x.ev_loss_pot
  from (
    select dd.hand_id,
           dd.ord,
           dd.action_index,
           h.played_at,
           h.hero_position,
           s.pot_type,
           dd.street,
           dd.scenario,
           case when dd.source = 'chart' and coalesce(dd.facts -> 'chart' ->> 'line', '') ~ '^[fkcra]{0,24}$'
                then coalesce(dd.facts -> 'chart' ->> 'line', '') else '' end as line,
           case when coalesce(dd.facts ->> 'position', h.hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
                then coalesce(dd.facts ->> 'position', h.hero_position, '') else '' end as pos,
           dd.action as taken,
           coalesce(public.analysis_best_action(dd.options), '') as best,
           dd.source,
           dd.grade,
           dd.score,
           coalesce(dd.ev_loss_bb, 0) as ev_loss_bb,
           coalesce(dd.ev_loss_pot, 0) as ev_loss_pot
    from public.analysis_scope(p_filters) s
    join public.decision_analysis dd on dd.hand_id = s.hand_id and dd.analysis_version = s.analysis_version
     and dd.owner_id = v_owner
    join public.hands h on h.id = s.hand_id and h.owner_id = v_owner
    where dd.grade is not null
  ) x;
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_overview(p_filters jsonb DEFAULT '{}'::jsonb)
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

CREATE OR REPLACE FUNCTION public.analysis_breakdown(p_filters jsonb DEFAULT '{}'::jsonb, p_group text DEFAULT 'street'::text)
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

CREATE OR REPLACE FUNCTION public.analysis_hands(p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'recent'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
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
  v_sort   text := coalesce(p_sort, 'recent');
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_sort not in ('recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  select count(*) into v_total from public.analysis_scope(p_filters);

  select coalesce(jsonb_agg(row_json order by rn), '[]'::jsonb)
    into v_rows
  from (
    select
      row_number() over (
        order by
          case when v_sort = 'oldest' then h.played_at end asc nulls last,
          case when v_sort = 'flags' then a.flag_count end desc,
          case when v_sort = 'flags' then a.worst_flag end asc nulls last,
          case when v_sort = 'ev_loss' then a.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then a.ev_loss_pot end desc nulls last,
          case when v_sort = 'score' then a.score end asc nulls last,
          case when v_sort = 'result' and h.big_blind > 0
               then h.hero_profit::numeric / h.big_blind end asc nulls last,
          h.played_at desc nulls last,
          a.hand_id
      ) as rn,
      jsonb_build_object(
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
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)
      ) as row_json
    from public.analysis_scope(p_filters) a
    join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
    order by rn
    offset v_offset
    limit v_limit
  ) page;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_hand(p_hand_id uuid, p_version text DEFAULT 'analysis/1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_hand needs an analysis_version.' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'handId',          a.hand_id,
    'analysisVersion', a.analysis_version,
    'status',          a.status,
    'reason',          a.reason,
    'heroSeat',        a.hero_seat,
    'grade',           a.grade,
    'score',           a.score,
    'evLossBb',        a.ev_loss_bb,
    'evLossPot',       a.ev_loss_pot,
    'flagCount',       a.flag_count,
    'worstFlag',       a.worst_flag,
    'approximations',  to_jsonb(a.approximations),
    'potType',         a.pot_type,
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ord',            d.ord,
               'actionIndex',    d.action_index,
               'street',         d.street,
               'action',         d.action,
               'status',         d.status,
               'reason',         d.reason,
               'node',           d.node,
               'scenario',       d.scenario,
               'source',         d.source,
               'grade',          d.grade,
               'score',          d.score,
               'evLossBb',       d.ev_loss_bb,
               'evLossPot',      d.ev_loss_pot,
               'freqDiff',       d.freq_diff,
               'options',        d.options,
               'chosen',         d.chosen,
               'flags',          d.flags,
               'worstFlag',      d.worst_flag,
               'approximations', to_jsonb(d.approximations),
               'facts',          d.facts) order by d.ord)
      from public.decision_analysis d
      where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)
  )
  into v_out
  from public.hand_analysis a
  where a.hand_id = p_hand_id
    and a.analysis_version = p_version
    and a.owner_id = v_owner;

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_node_actions(p_filters jsonb DEFAULT '{}'::jsonb)
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

CREATE OR REPLACE FUNCTION public.analysis_node_hands(p_filters jsonb DEFAULT '{}'::jsonb, p_nodes text[] DEFAULT NULL::text[], p_action text DEFAULT NULL::text, p_deviations boolean DEFAULT true, p_sort text DEFAULT 'ev_loss'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
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

CREATE OR REPLACE FUNCTION public.analysis_leaks(p_filters jsonb DEFAULT '{}'::jsonb)
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

CREATE OR REPLACE FUNCTION public.analysis_leak_hands(p_filters jsonb DEFAULT '{}'::jsonb, p_keys text[] DEFAULT NULL::text[], p_deviations boolean DEFAULT true, p_sort text DEFAULT 'ev_loss'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
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

CREATE OR REPLACE FUNCTION public.analysis_trend(p_filters jsonb DEFAULT '{}'::jsonb, p_bucket text DEFAULT 'week'::text, p_group text DEFAULT 'all'::text, p_gap_minutes integer DEFAULT 30)
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

CREATE OR REPLACE FUNCTION public.analysis_top_leaks(p_filters jsonb DEFAULT '{}'::jsonb, p_period text DEFAULT '30d'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
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
$function$;

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
        on dd.hand_id = p.hand_id and dd.analysis_version = v_version and dd.ord = p.ord and dd.owner_id = v_owner
      where p.n = lk.n and p.rn <= v_limit), '[]'::jsonb)) order by lk.n), '[]'::jsonb))
    into v_out
  from leaks lk;

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.analysis_coverage(p_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_coverage needs an analysis_version.' using errcode = '22023';
  end if;

  with h as (
    select
      exists (select 1 from public.hand_analysis a
              where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version) as is_current,
      exists (select 1 from public.hand_analysis a
              where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version <> p_version) as has_old
    from public.hands hd
    where hd.owner_id = v_owner
  )
  select jsonb_build_object(
    'analysisVersion', p_version,
    'hands',           count(*),
    'atVersion',       count(*) filter (where is_current),
    'stale',           count(*) filter (where not is_current and has_old),
    'missing',         count(*) filter (where not is_current and not has_old),
    'obsoleteRows', (
      select count(*) from public.hand_analysis a
      where a.owner_id = v_owner and a.analysis_version <> p_version)
  )
  into v_out
  from h;

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hands_needing_analysis(p_version text, p_after uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, phf jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'hands_needing_analysis needs an analysis_version.' using errcode = '22023';
  end if;

  return query
  select hd.id,
         jsonb_set(
           hd.phf #- '{meta,rawText}',
           '{actions}',
           coalesce((select jsonb_agg(a - 'rawLine' - 'label' order by ord)
                     from jsonb_array_elements(hd.phf -> 'actions') with ordinality as x(a, ord)),
                    '[]'::jsonb))
  from public.hands hd
  where hd.owner_id = v_owner
    and (p_after is null or hd.id > p_after)
    and not exists (
      select 1 from public.hand_analysis a
      where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$function$;

CREATE OR REPLACE FUNCTION public.hands_needing_analysis_recent(p_version text, p_before_played timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
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

CREATE OR REPLACE FUNCTION public.drill_queue(p_version text, p_keys text[] DEFAULT NULL::text[], p_due_only boolean DEFAULT true, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
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
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    order by di.due_at, di.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) q;

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.drill_summary(p_version text, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
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
      where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
        and d.owner_id = v_owner);

  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.drill_due_by_spot(p_version text, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.trainer_summary(p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
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
$function$;

CREATE OR REPLACE FUNCTION public.study_plan(p_week_start date, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
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
$function$;

-- SQL functions with the owner as an InitPlan, RLS alone, or an argument:
-- PL/pgSQL with the caller bound, the same query.

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
      select h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.played_at
      from public.hand_analysis a
      join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
      where a.owner_id = v_owner
        and a.analysis_version = p_version
        and exists (
          select 1 from public.decision_analysis dd
          where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version and dd.owner_id = v_owner
            and dd.grade is not null)
    )
    select jsonb_build_object(
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
      'last',  (select max(played_at) from f)));
end;
$$;

-- R5.2's sample: the owner was an argument, unknown when a SQL function is
-- planned. Only the caller's own counts are read (the policy's answer for
-- anyone else was none).
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
  return (
    select jsonb_build_object(
      'hands', coalesce((
        select sum(hands)::bigint from public.analysis_leak_day_hands
        where owner_id = v_owner and analysis_version = p_version
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
      where owner_id = v_owner and analysis_version = p_version
        and (p_from is null or day >= p_from) and (p_to is null or day <= p_to)
        and (p_format is null or game_format = p_format)
        and (p_position is null or hero_position = p_position)
        and (p_pot is null or pot_type = p_pot)
      group by spot_key, chart_set
    ) x);
end;
$$;

create or replace function public.get_hand(p_id uuid)
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
  return (select to_jsonb(h) from public.hands h where h.id = p_id and h.owner_id = v_owner);
end;
$$;

-- The forum's own-state readers: the posts are public, the saved posts,
-- subscriptions and notifications the caller's.
create or replace function public.my_post_state(p_public_id text)
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
    select jsonb_build_object(
      'saved', exists (select 1 from public.saved_posts s where s.user_id = v_owner and s.post_id = p.id),
      'subscription', (select t.level from public.thread_subscriptions t where t.user_id = v_owner and t.post_id = p.id)
    )
    from public.posts p
    where p.public_id = p_public_id);
end;
$$;

create or replace function public.my_saved_posts(p_limit integer default 25, p_before timestamptz default null)
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
    select coalesce(jsonb_agg(public.forum_post_json(p) || jsonb_build_object('savedAt', s.created_at)
                              order by s.created_at desc), '[]'::jsonb)
    from (
      select * from public.saved_posts
      where user_id = v_owner
        and (p_before is null or created_at < p_before)
      order by created_at desc
      limit least(greatest(coalesce(p_limit, 25), 1), 50)
    ) s
    join public.posts p on p.id = s.post_id);
end;
$$;

create or replace function public.my_notifications(p_limit integer default 30, p_before bigint default null)
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
    select jsonb_build_object(
      'unread', (select count(*) from public.notifications where user_id = v_owner and read_at is null),
      'items', coalesce(jsonb_agg(jsonb_build_object(
          'id', n.id,
          'kind', n.kind,
          'createdAt', n.created_at,
          'read', n.read_at is not null,
          'actor', (select jsonb_build_object('username', a.username) from public.profiles_public a where a.id = n.actor_id),
          'post', jsonb_build_object('publicId', p.public_id, 'slug', p.slug, 'title', p.title,
                                     'board', (select b.slug from public.boards b where b.id = p.board_id)),
          'seq', c.seq,
          'excerpt', left(c.body, 160)
        ) order by n.id desc), '[]'::jsonb)
    )
    from (
      select * from public.notifications
      where user_id = v_owner
        and (p_before is null or id < p_before)
      order by id desc
      limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) n
    join public.posts p on p.id = n.post_id
    left join public.comments c on c.id = n.comment_id);
end;
$$;

create or replace function public.unread_notification_count()
returns integer
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
begin
  return (select count(*)::integer from public.notifications where user_id = v_owner and read_at is null);
end;
$$;

commit;
