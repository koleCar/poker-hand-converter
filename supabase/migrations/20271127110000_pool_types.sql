-- ============================================================================
-- Field pool program P3: types and the "vs fish" figures precomputed
-- (docs/POOL.md §4, §5 P3).
-- ============================================================================
--
-- Until now every read of the Pool tab typed the owner's opponents again from
-- all of `player_stats`, and its two figures "You with a fish in the pot" /
-- "You, regs only" were two `report_open` calls with the Hands filter's "vs
-- type" (every hand's opponents looked up in `player_stats`): 40-50 s on a
-- 92 000-hand account, past the statement timeout. Here:
--
--   * `player_types (owner, stats version, room, player)` - each named
--     opponent's type by Rail's rule (the one `analytics_pool` and the Hands
--     filter apply: 30+ hands; fish VPIP >= 40; reg VPIP 15-30 with PFR >=
--     0.6 VPIP; else `other`, or `unknown` under 30 hands), with its hands,
--     VPIP and PFR. Kept by statement triggers on `player_stats` (whatever
--     writes it: the one pass's statistics, a delete, a rebuild) for the
--     players the statement touched - never per read. Opaque-id rooms (GG:
--     per-session tokens) are summed under '' and stay untyped.
--   * `player_type_changes` - a player whose type moved between reg, fish
--     and neither: the hands they played need their tag again.
--   * `hero_report_rows.opp_mix` - who the hero played against: `fish` (a
--     fish put money in or saw the flop: the facts' `vs_players`), `regs`
--     (every such opponent a reg), `mixed` (a reg and someone untyped or
--     neither, no fish), `unknown` (no reg, no fish). Set when the row is
--     written (`hero_report_rows_opp_mix`, from the hand's facts and
--     `player_types`; the one pass now writes the facts before the
--     statistics) and again when the hand's facts arrive later
--     (`hand_facts_opp_mix`). Null: not tagged yet (rows from before this
--     migration until `hero_opp_mix_backfill` has run, docs/POOL.md P7).
--   * `hero_opp_rollups` - the hero's hands and result per day, segment,
--     position, kind and opp_mix (the `hero_rollups` grain): kept by
--     statement triggers on `hero_report_rows` (a row in adds, out
--     subtracts, a re-tag moves it).
--   * **The re-tag** - `opp_mix_retag(budget_ms, owner, page)`: for each changed
--     player (oldest owner first), the hero rows of the hands they sat in
--     (`hands.player_names`, GIN) are tagged again. Run by the worker: the
--     cron drain's last, empty claim (`derive_claim` as `rail_derive`) spends
--     up to 2 s on it; and nightly by pg_cron with a bigger budget (P7, not
--     scheduled here). Never by a page.
--   * `analytics_pool` joins `player_types` instead of typing everyone from
--     `player_stats` per request.
--   * `analytics_pool_you(filter)` - the two figures from `hero_opp_rollups`
--     (whole days; partial days and the groups beyond the rollups from
--     `hero_report_rows`), with `report_open`'s rules for the filter, the
--     money hands and the chips / cash refusal. The Pool tab reads it
--     instead of the two `report_open` calls (the desktop keeps its own).
--
-- `player_types` is filled here from `player_stats`; existing hero rows are
-- tagged by `hero_opp_mix_backfill(after, limit)` (nobody's: the owner's
-- rollout, P7). Until then their figures count only the rows tagged.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------------

create table if not exists public.player_types (
  owner_id      uuid    not null references auth.users (id) on delete cascade,
  stats_version text    not null,
  site_id       text    not null,
  player        text    not null check (player <> ''),
  kind          text    not null check (kind in ('reg', 'fish', 'other', 'unknown')),
  -- Their hands (villain rows), VPIP and PFR in percent, over every segment
  -- of the room (`player_stats` summed).
  n             bigint  not null,
  vpip          numeric not null,
  pfr           numeric not null,
  updated_at    timestamptz not null default now(),
  primary key (owner_id, stats_version, site_id, player)
);

comment on table public.player_types is
  'P3 (docs/POOL.md): each named opponent''s Rail type (reg, fish, other, unknown under 30 hands) per room and '
  'statistics version, from player_stats; kept by player_stats'' statement triggers. Read by analytics_pool.';

alter table public.player_types enable row level security;
revoke all on public.player_types from public, anon, authenticated;
grant select on public.player_types to authenticated;
drop policy if exists player_types_owner_select on public.player_types;
create policy player_types_owner_select on public.player_types
  for select to authenticated using (owner_id = (select auth.uid()));

create table if not exists public.player_type_changes (
  owner_id      uuid not null references auth.users (id) on delete cascade,
  stats_version text not null,
  site_id       text not null,
  player        text not null,
  changed_at    timestamptz not null default now(),
  -- The re-tag's place in the player's hands (hand id order): it goes a page
  -- at a time, so one regular in 90 000 hands never holds a call for long.
  after_hand    uuid,
  primary key (owner_id, stats_version, site_id, player)
);

alter table public.player_type_changes add column if not exists after_hand uuid;

comment on table public.player_type_changes is
  'P3: opponents whose type moved between reg, fish and neither: the hero rows of their hands are tagged again '
  '(opp_mix_retag). Internal.';

alter table public.player_type_changes enable row level security;
revoke all on public.player_type_changes from public, anon, authenticated;

-- Rail's rule (the Hands filter's "vs type", `analytics_pool` until now).
create or replace function public.player_kind_of(p_n numeric, p_vpip numeric, p_pfr numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_n >= 30 and p_vpip >= 40 then 'fish'
    when p_n >= 30 and p_vpip between 15 and 30 and p_pfr >= p_vpip * 0.6 then 'reg'
    when p_n >= 30 then 'other'
    else 'unknown'
  end
$$;

revoke all on function public.player_kind_of(numeric, numeric, numeric) from public, anon, authenticated;

-- The players named (p_keys: [[owner, version, site, player], ...]) typed
-- again from their player_stats rows; a move between reg, fish and neither
-- is recorded for the re-tag (only for an account that still exists: an
-- account deletion's cascade records nothing).
create or replace function public.player_types_refresh(p_keys jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with k as (
    select distinct (e ->> 0)::uuid as owner_id, e ->> 1 as stats_version, e ->> 2 as site_id, e ->> 3 as player
    from jsonb_array_elements(p_keys) e
    where coalesce(e ->> 3, '') <> ''
  ), now_ as (
    select k.owner_id, k.stats_version, k.site_id, k.player, s.n, s.vpip, s.pfr,
           case when coalesce(s.n, 0) > 0 then public.player_kind_of(s.n, s.vpip, s.pfr) else 'unknown' end as kind
    from k
    cross join lateral (
      select sum(ps.hands) as n,
             coalesce(sum(ps.vpip), 0) * 100.0 / greatest(coalesce(sum(ps.vpip_opp), 0), 1) as vpip,
             coalesce(sum(ps.pfr), 0) * 100.0 / greatest(coalesce(sum(ps.pfr_opp), 0), 1) as pfr
      from public.player_stats ps
      where ps.owner_id = k.owner_id and ps.stats_version = k.stats_version
        and ps.site_id = k.site_id and ps.player = k.player
    ) s
  ), was as (
    select t.owner_id, t.stats_version, t.site_id, t.player, t.kind
    from public.player_types t
    join k on k.owner_id = t.owner_id and k.stats_version = t.stats_version
          and k.site_id = t.site_id and k.player = t.player
  ), kept as (
    insert into public.player_types as t (owner_id, stats_version, site_id, player, kind, n, vpip, pfr, updated_at)
    select a.owner_id, a.stats_version, a.site_id, a.player, a.kind, a.n, a.vpip, a.pfr, now()
    from now_ a
    where coalesce(a.n, 0) > 0
    order by 1, 2, 3, 4
    on conflict (owner_id, stats_version, site_id, player) do update
      set kind = excluded.kind, n = excluded.n, vpip = excluded.vpip, pfr = excluded.pfr, updated_at = excluded.updated_at
      where (t.kind, t.n, t.vpip, t.pfr) is distinct from (excluded.kind, excluded.n, excluded.vpip, excluded.pfr)
    returning 1
  ), gone as (
    delete from public.player_types t
    using now_ a
    where coalesce(a.n, 0) <= 0
      and t.owner_id = a.owner_id and t.stats_version = a.stats_version and t.site_id = a.site_id and t.player = a.player
    returning 1
  )
  insert into public.player_type_changes as c (owner_id, stats_version, site_id, player, changed_at)
  select a.owner_id, a.stats_version, a.site_id, a.player, now()
  from now_ a
  left join was w on w.owner_id = a.owner_id and w.stats_version = a.stats_version
                 and w.site_id = a.site_id and w.player = a.player
  where (case when coalesce(w.kind, 'unknown') in ('reg', 'fish') then w.kind else '' end)
        is distinct from (case when a.kind in ('reg', 'fish') then a.kind else '' end)
    and exists (select 1 from auth.users u where u.id = a.owner_id)
  order by 1, 2, 3, 4
  on conflict (owner_id, stats_version, site_id, player) do update
    set changed_at = excluded.changed_at, after_hand = null;
end;
$$;

comment on function public.player_types_refresh(jsonb) is
  'P3: the named players typed again from player_stats (player_types); a move between reg, fish and neither '
  'goes to player_type_changes. Internal: player_stats'' triggers.';

revoke all on function public.player_types_refresh(jsonb) from public, anon, authenticated;

create or replace function public.player_stats_types_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys jsonb;
begin
  if tg_op = 'INSERT' then
    select jsonb_agg(distinct jsonb_build_array(r.owner_id, r.stats_version, r.site_id, r.player)) into v_keys
    from added r where r.player <> '';
  elsif tg_op = 'DELETE' then
    select jsonb_agg(distinct jsonb_build_array(r.owner_id, r.stats_version, r.site_id, r.player)) into v_keys
    from gone r where r.player <> '';
  else
    select jsonb_agg(distinct x.k) into v_keys
    from (select jsonb_build_array(r.owner_id, r.stats_version, r.site_id, r.player) as k from added r where r.player <> ''
          union all
          select jsonb_build_array(r.owner_id, r.stats_version, r.site_id, r.player) from gone r where r.player <> '') x;
  end if;
  if v_keys is not null then
    perform public.player_types_refresh(v_keys);
  end if;
  return null;
end;
$$;

revoke all on function public.player_stats_types_follow() from public, anon, authenticated;

create or replace function public.player_stats_types_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  truncate public.player_types, public.player_type_changes;
  return null;
end;
$$;

revoke all on function public.player_stats_types_truncate() from public, anon, authenticated;

drop trigger if exists player_stats_types_insert on public.player_stats;
create trigger player_stats_types_insert
  after insert on public.player_stats
  referencing new table as added
  for each statement execute function public.player_stats_types_follow();

drop trigger if exists player_stats_types_update on public.player_stats;
create trigger player_stats_types_update
  after update on public.player_stats
  referencing old table as gone new table as added
  for each statement execute function public.player_stats_types_follow();

drop trigger if exists player_stats_types_delete on public.player_stats;
create trigger player_stats_types_delete
  after delete on public.player_stats
  referencing old table as gone
  for each statement execute function public.player_stats_types_follow();

drop trigger if exists player_stats_types_truncate on public.player_stats;
create trigger player_stats_types_truncate
  after truncate on public.player_stats
  for each statement execute function public.player_stats_types_truncate();

-- Everyone's types now (the triggers keep them from here).
insert into public.player_types as t (owner_id, stats_version, site_id, player, kind, n, vpip, pfr)
select s.owner_id, s.stats_version, s.site_id, s.player, public.player_kind_of(s.n, s.vpip, s.pfr), s.n, s.vpip, s.pfr
from (
  select ps.owner_id, ps.stats_version, ps.site_id, ps.player,
         sum(ps.hands) as n,
         coalesce(sum(ps.vpip), 0) * 100.0 / greatest(coalesce(sum(ps.vpip_opp), 0), 1) as vpip,
         coalesce(sum(ps.pfr), 0) * 100.0 / greatest(coalesce(sum(ps.pfr_opp), 0), 1) as pfr
  from public.player_stats ps
  where ps.player <> ''
  group by ps.owner_id, ps.stats_version, ps.site_id, ps.player
  having sum(ps.hands) > 0
) s
on conflict (owner_id, stats_version, site_id, player) do update
  set kind = excluded.kind, n = excluded.n, vpip = excluded.vpip, pfr = excluded.pfr, updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. The hero's opponents by type: hero_report_rows.opp_mix
-- ---------------------------------------------------------------------------

alter table public.hero_report_rows add column if not exists opp_mix text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hero_report_rows_opp_mix_check'
                   and conrelid = 'public.hero_report_rows'::regclass) then
    alter table public.hero_report_rows add constraint hero_report_rows_opp_mix_check
      check (opp_mix in ('fish', 'regs', 'mixed', 'unknown'));
  end if;
end;
$$;

comment on column public.hero_report_rows.opp_mix is
  'P3: the hero''s opponents in the pot (the facts'' vs_players) by player_types: fish (one is a fish), regs (all '
  'regs), mixed (a reg and someone else, no fish), unknown (no reg, no fish). Null: not tagged yet.';

-- One hero row's tag: the hand's newest facts row, its opponents' types.
create or replace function public.hero_opp_mix_of(p_owner uuid, p_version text, p_site text, p_hand uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when count(*) filter (where t.kind = 'fish') > 0 then 'fish'
    when count(*) filter (where t.kind = 'reg') > 0 and count(*) filter (where t.kind = 'reg') = count(*) then 'regs'
    when count(*) filter (where t.kind = 'reg') > 0 then 'mixed'
    else 'unknown'
  end
  from (
    select f.vs_players from public.hand_facts f
    where f.hand_id = p_hand and f.owner_id = p_owner
    order by substr(f.facts_version, 7)::integer desc
    limit 1
  ) f
  cross join unnest(f.vs_players) vp(name)
  left join public.player_types t
    on t.owner_id = p_owner and t.stats_version = p_version and t.site_id = p_site and t.player = vp.name
$$;

revoke all on function public.hero_opp_mix_of(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.hero_report_rows_opp_mix()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.opp_mix is null then
    new.opp_mix := public.hero_opp_mix_of(new.owner_id, new.stats_version, new.site_id, new.hand_id);
  end if;
  return new;
end;
$$;

revoke all on function public.hero_report_rows_opp_mix() from public, anon, authenticated;

drop trigger if exists hero_report_rows_opp_mix on public.hero_report_rows;
create trigger hero_report_rows_opp_mix
  before insert on public.hero_report_rows
  for each row execute function public.hero_report_rows_opp_mix();

-- The hero rows of these hands tagged again where their tag changed, under
-- the owner's summaries lock (taken in owner order). Internal.
create or replace function public.hero_opp_mix_retag_hands(p_owner uuid, p_hands uuid[], p_version text default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_owner is null or cardinality(p_hands) = 0 then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || p_owner::text, 0));
  update public.hero_report_rows r
     set opp_mix = m.mix
    from (
      select x.hand_id, x.stats_version, x.seat,
             public.hero_opp_mix_of(x.owner_id, x.stats_version, x.site_id, x.hand_id) as mix
      from public.hero_report_rows x
      where x.hand_id = any (p_hands) and x.owner_id = p_owner
        and (p_version is null or x.stats_version = p_version)
    ) m
   where r.hand_id = m.hand_id and r.stats_version = m.stats_version and r.seat = m.seat
     and r.opp_mix is distinct from m.mix;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.hero_opp_mix_retag_hands(uuid, uuid[], text) from public, anon, authenticated;

-- Facts written after the statistics (an older client's order): the hand's
-- hero rows tagged now.
create or replace function public.hand_facts_opp_mix()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_hands uuid[];
begin
  for v_owner, v_hands in
    select a.owner_id, array_agg(distinct a.hand_id)
    from added a
    where exists (select 1 from public.hero_report_rows r where r.hand_id = a.hand_id)
    group by a.owner_id
    order by a.owner_id
  loop
    perform public.hero_opp_mix_retag_hands(v_owner, v_hands);
  end loop;
  return null;
end;
$$;

revoke all on function public.hand_facts_opp_mix() from public, anon, authenticated;

drop trigger if exists hand_facts_opp_mix on public.hand_facts;
create trigger hand_facts_opp_mix
  after insert on public.hand_facts
  referencing new table as added
  for each statement execute function public.hand_facts_opp_mix();

-- ---------------------------------------------------------------------------
-- 3. The rollup by opp_mix
-- ---------------------------------------------------------------------------

create table if not exists public.hero_opp_rollups (
  owner_id      uuid not null references auth.users (id) on delete cascade,
  stats_version text not null,
  opp_mix       text not null check (opp_mix in ('fish', 'regs', 'mixed', 'unknown')),
  -- The UTC day of `played_at`; '-infinity' for a hand without a time (as hero_rollups).
  day           date not null,
  site_id       text not null,
  game_format   public.game_format not null,
  variant       text not null,
  limit_type    text not null,
  size          text not null,
  stake         text not null,
  "position"    text not null,
  -- bomb pot 1 | straddled 2 | EV cashout 4.
  kind          smallint not null,
  hands         bigint not null default 0,
  net_bb_milli  bigint not null default 0,
  primary key (owner_id, stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind)
);

comment on table public.hero_opp_rollups is
  'P3: the hero''s hands and result (big blinds) per day, segment, position, kind and opp_mix - hero_rollups'' grain '
  'split by who was in the pot. Kept by hero_report_rows'' statement triggers. Read by analytics_pool_you.';

alter table public.hero_opp_rollups enable row level security;
revoke all on public.hero_opp_rollups from public, anon, authenticated;
grant select on public.hero_opp_rollups to authenticated;
drop policy if exists hero_opp_rollups_owner_select on public.hero_opp_rollups;
create policy hero_opp_rollups_owner_select on public.hero_opp_rollups
  for select to authenticated using (owner_id = (select auth.uid()));

-- Rows in: added (upsert). Rows out: subtracted, never inserted (an account
-- deletion's cascade must not write rows for the account). A re-tag: both.
create or replace function public.hero_opp_rollups_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The owners' summaries lock (re-entrant: a statistics write holds it already).
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
    from (select distinct owner_id from added where opp_mix is not null order by 1) o;
    insert into public.hero_opp_rollups as o
      (owner_id, stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind,
       hands, net_bb_milli)
    select owner_id, stats_version, opp_mix, coalesce((played_at at time zone 'UTC')::date, '-infinity'::date),
           site_id, game_format, variant, limit_type, size, stake, "position", kind, count(*), sum(net_bb_milli)
    from added
    where opp_mix is not null
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    on conflict (owner_id, stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind)
    do update set hands = o.hands + excluded.hands, net_bb_milli = o.net_bb_milli + excluded.net_bb_milli;
    return null;
  end if;

  if tg_op = 'UPDATE' then
    perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
    from (select distinct x.owner_id from (select owner_id from added union all select owner_id from gone) x order by 1) o;
    with d as (
      select owner_id, stats_version, opp_mix, coalesce((played_at at time zone 'UTC')::date, '-infinity'::date) as day,
             site_id, game_format, variant, limit_type, size, stake, "position", kind, 1 as sign, net_bb_milli
      from added where opp_mix is not null
      union all
      select owner_id, stats_version, opp_mix, coalesce((played_at at time zone 'UTC')::date, '-infinity'::date),
             site_id, game_format, variant, limit_type, size, stake, "position", kind, -1, net_bb_milli
      from gone where opp_mix is not null
    )
    insert into public.hero_opp_rollups as o
      (owner_id, stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind,
       hands, net_bb_milli)
    select owner_id, stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind,
           sum(sign), sum(sign * net_bb_milli)
    from d
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    having sum(sign) <> 0 or sum(sign * net_bb_milli) <> 0
    order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    on conflict (owner_id, stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind)
    do update set hands = o.hands + excluded.hands, net_bb_milli = o.net_bb_milli + excluded.net_bb_milli;
  else
    -- Rows out are subtracted, never inserted: an account deletion's cascade
    -- must not write rows for the account.
    perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || o.owner_id::text, 0))
    from (select distinct owner_id from gone where opp_mix is not null order by 1) o;
    with d as (
      select owner_id, stats_version, opp_mix, coalesce((played_at at time zone 'UTC')::date, '-infinity'::date) as day,
             site_id, game_format, variant, limit_type, size, stake, "position", kind,
             count(*) as hands, sum(net_bb_milli) as net
      from gone where opp_mix is not null
      group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    )
    update public.hero_opp_rollups o
       set hands = o.hands - d.hands, net_bb_milli = o.net_bb_milli - d.net
      from d
     where o.owner_id = d.owner_id and o.stats_version = d.stats_version and o.opp_mix = d.opp_mix and o.day = d.day
       and o.site_id = d.site_id and o.game_format = d.game_format and o.variant = d.variant
       and o.limit_type = d.limit_type and o.size = d.size and o.stake = d.stake and o."position" = d."position"
       and o.kind = d.kind;
  end if;

  -- Emptied rows go.
  delete from public.hero_opp_rollups o
   using (select distinct owner_id, stats_version, opp_mix, coalesce((played_at at time zone 'UTC')::date, '-infinity'::date) as day,
                 site_id, game_format, variant, limit_type, size, stake, "position", kind
          from gone where opp_mix is not null) k
   where o.owner_id = k.owner_id and o.stats_version = k.stats_version and o.opp_mix = k.opp_mix and o.day = k.day
     and o.site_id = k.site_id and o.game_format = k.game_format and o.variant = k.variant
     and o.limit_type = k.limit_type and o.size = k.size and o.stake = k.stake and o."position" = k."position"
     and o.kind = k.kind and o.hands <= 0;
  return null;
end;
$$;

comment on function public.hero_opp_rollups_follow() is
  'P3: hero_report_rows'' statement trigger: rows in add to hero_opp_rollups, rows out subtract, a re-tag moves them.';

revoke all on function public.hero_opp_rollups_follow() from public, anon, authenticated;

create or replace function public.hero_opp_rollups_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  truncate public.hero_opp_rollups;
  return null;
end;
$$;

revoke all on function public.hero_opp_rollups_truncate() from public, anon, authenticated;

drop trigger if exists hero_opp_rollups_insert on public.hero_report_rows;
create trigger hero_opp_rollups_insert
  after insert on public.hero_report_rows
  referencing new table as added
  for each statement execute function public.hero_opp_rollups_follow();

drop trigger if exists hero_opp_rollups_update on public.hero_report_rows;
create trigger hero_opp_rollups_update
  after update on public.hero_report_rows
  referencing old table as gone new table as added
  for each statement execute function public.hero_opp_rollups_follow();

drop trigger if exists hero_opp_rollups_delete on public.hero_report_rows;
create trigger hero_opp_rollups_delete
  after delete on public.hero_report_rows
  referencing old table as gone
  for each statement execute function public.hero_opp_rollups_follow();

drop trigger if exists hero_opp_rollups_truncate on public.hero_report_rows;
create trigger hero_opp_rollups_truncate
  after truncate on public.hero_report_rows
  for each statement execute function public.hero_opp_rollups_truncate();

-- ---------------------------------------------------------------------------
-- 4. The re-tag and the backfill (the worker, pg_cron, the rollout)
-- ---------------------------------------------------------------------------

-- The changed players' hands tagged again, oldest change first within an
-- account, accounts in id order (the order every writer takes their locks
-- in), p_page of a player's hands at a time, until p_budget_ms. p_owner:
-- that account's only. Returns {players, rows, left}. Internal: derive_claim
-- (the worker) and pg_cron.
drop function if exists public.opp_mix_retag(integer, uuid);
create or replace function public.opp_mix_retag(p_budget_ms integer default 2000, p_owner uuid default null,
                                                p_page integer default 2000)
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_page    integer := least(greatest(coalesce(p_page, 2000), 1), 20000);
  v_until   timestamptz := clock_timestamp() + make_interval(secs => greatest(coalesce(p_budget_ms, 2000), 0) / 1000.0);
  v_owner   uuid;
  v_change  public.player_type_changes;
  v_players integer := 0;
  v_rows    integer := 0;
  v_hands   uuid[];
  v_left    bigint;
begin
  <<owners>>
  for v_owner in
    select distinct c.owner_id from public.player_type_changes c
    where p_owner is null or c.owner_id = p_owner
    order by 1
  loop
    -- The summaries' lock first: every writer of player_type_changes holds it.
    perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || v_owner::text, 0));
    loop
      select * into v_change from public.player_type_changes c
      where c.owner_id = v_owner
      order by c.changed_at, c.stats_version, c.site_id, c.player
      limit 1;
      exit when not found;
      v_hands := array(select h.id from public.hands h
                       where h.owner_id = v_owner and h.site = v_change.site_id
                         and h.player_names @> array[v_change.player]
                         and (v_change.after_hand is null or h.id > v_change.after_hand)
                       order by h.id
                       limit v_page);
      v_rows := v_rows + public.hero_opp_mix_retag_hands(v_owner, v_hands, v_change.stats_version);
      if cardinality(v_hands) < v_page then
        delete from public.player_type_changes c
         where c.owner_id = v_change.owner_id and c.stats_version = v_change.stats_version
           and c.site_id = v_change.site_id and c.player = v_change.player;
        v_players := v_players + 1;
      else
        update public.player_type_changes c set after_hand = v_hands[cardinality(v_hands)]
         where c.owner_id = v_change.owner_id and c.stats_version = v_change.stats_version
           and c.site_id = v_change.site_id and c.player = v_change.player;
      end if;
      exit owners when clock_timestamp() >= v_until;
    end loop;
  end loop;

  select count(*) into v_left from public.player_type_changes c where p_owner is null or c.owner_id = p_owner;
  return jsonb_build_object('players', v_players, 'rows', v_rows, 'left', v_left);
end;
$$;

comment on function public.opp_mix_retag(integer, uuid, integer) is
  'P3: hero rows of the hands of players whose type changed (player_type_changes) tagged again, within a time '
  'budget. Internal: the worker''s empty claim (2 s) and pg_cron nightly (docs/POOL.md P7).';

revoke all on function public.opp_mix_retag(integer, uuid, integer) from public, anon, authenticated;

-- The rollout's tagging of existing hero rows: up to p_limit hands after
-- p_after (hand id order, every account), each hero row tagged where its tag
-- is missing or changed. Returns {after, tagged, done}. Granted to nobody:
-- the owner runs it at rollout (docs/POOL.md P7), as postgres.
create or replace function public.hero_opp_mix_backfill(p_after uuid default null, p_limit integer default 20000)
returns jsonb
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20000), 1), 100000);
  v_ids   uuid[];
  v_last  uuid;
  v_owner uuid;
  v_hands uuid[];
  v_n     integer := 0;
begin
  select array_agg(x.hand_id order by x.hand_id) into v_ids
  from (
    select distinct r.hand_id from public.hero_report_rows r
    where p_after is null or r.hand_id > p_after
    order by r.hand_id
    limit v_limit
  ) x;
  if v_ids is null then
    return jsonb_build_object('after', p_after, 'tagged', 0, 'done', true);
  end if;
  v_last := v_ids[cardinality(v_ids)];

  for v_owner, v_hands in
    select r.owner_id, array_agg(distinct r.hand_id)
    from public.hero_report_rows r
    where r.hand_id = any (v_ids)
    group by r.owner_id
    order by r.owner_id
  loop
    v_n := v_n + public.hero_opp_mix_retag_hands(v_owner, v_hands);
  end loop;

  return jsonb_build_object('after', v_last, 'tagged', v_n, 'done', cardinality(v_ids) < v_limit);
end;
$$;

comment on function public.hero_opp_mix_backfill(uuid, integer) is
  'P3 rollout: tags the hero rows of up to p_limit hands after p_after (opp_mix from facts and player_types). '
  'Repeat from the returned after until done. Granted to nobody.';

revoke all on function public.hero_opp_mix_backfill(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The one pass: facts before statistics
-- ---------------------------------------------------------------------------
--
-- The body of 20271127090000 with the facts written first, so a hero row is
-- tagged from its hand's facts as it is written.

create or replace function public.derive_write(p_owner uuid, p_hands jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows  jsonb;
  v_chunk jsonb := '[]'::jsonb;
  v_hand  jsonb;
  v_n     integer := 0;
  v_pv    text;
begin
  -- Facts first (P3: the hero rows read the opponents in the pot from them).
  select coalesce(jsonb_agg(e -> 'facts'), '[]'::jsonb) into v_rows
  from jsonb_array_elements(p_hands) e
  join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
  where jsonb_typeof(e -> 'facts') = 'object' and e -> 'facts' ->> 'hand_key' = h.hand_key;
  if jsonb_array_length(v_rows) > 0 then
    perform public.save_hand_facts(v_rows);
  end if;

  -- Statistics, then EV (a hand whose statistics are refused refuses the
  -- call: derive_save retries hand by hand). A row names its own hand only.
  for v_hand in
    select jsonb_build_object('rows', coalesce(jsonb_agg(r), '[]'::jsonb))
    from jsonb_array_elements(p_hands) e
    join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
    cross join lateral jsonb_array_elements(case when jsonb_typeof(e -> 'stats') = 'array' then e -> 'stats' else '[]'::jsonb end) r
    where r ->> 'hand_key' = h.hand_key
    group by h.id
  loop
    v_rows := v_hand -> 'rows';
    if v_n > 0 and v_n + jsonb_array_length(v_rows) > 1000 then
      perform public.save_hand_stats(v_chunk);
      v_chunk := '[]'::jsonb;
      v_n := 0;
    end if;
    v_chunk := v_chunk || v_rows;
    v_n := v_n + jsonb_array_length(v_rows);
  end loop;
  if v_n > 0 then
    perform public.save_hand_stats(v_chunk);
  end if;

  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows
  from jsonb_array_elements(p_hands) e
  join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
  cross join lateral jsonb_array_elements(case when jsonb_typeof(e -> 'ev') = 'array' then e -> 'ev' else '[]'::jsonb end) r
  where r ->> 'hand_key' = h.hand_key;
  if jsonb_array_length(v_rows) > 0 then
    perform public.save_hand_ev(v_rows);
  end if;

  -- Checker rows: an analysed hand's (analysis is Pro; an owner without it
  -- any more keeps the analysis and gets no new rows).
  if public.has_entitlement(p_owner, 'analysis') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'hand_id', h.id,
             'analysis_version', e -> 'checker' ->> 'analysis_version',
             'membership_version', e -> 'checker' ->> 'membership_version',
             'rows', coalesce(e -> 'checker' -> 'rows', '[]'::jsonb))), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_hands) e
    join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
    where jsonb_typeof(e -> 'checker') = 'object';
    if jsonb_array_length(v_rows) > 0 then
      perform public.analytics_rows_save(v_rows);
    end if;
  end if;

  -- The pool, per catalogue version sent (one, in practice).
  for v_pv in
    select distinct e -> 'pool' ->> 'version' from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e -> 'pool') = 'object'
  loop
    select coalesce(jsonb_agg(jsonb_build_object('hand_id', h.id, 'players', coalesce(e -> 'pool' -> 'players', '[]'::jsonb))),
                    '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(p_hands) e
    join public.hands h on h.id = (e ->> 'hand_id')::uuid and h.owner_id = p_owner
    where jsonb_typeof(e -> 'pool') = 'object' and e -> 'pool' ->> 'version' is not distinct from v_pv;
    if jsonb_array_length(v_rows) > 0 then
      perform public.analytics_pool_add(p_owner, v_pv, v_rows);
    end if;
  end loop;
end;
$$;

revoke all on function public.derive_write(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The worker's empty claim re-tags
-- ---------------------------------------------------------------------------
--
-- The body of 20271127100000; when the derive role finds nothing to claim,
-- it spends up to 2 s on the re-tag (a user's claim never does).

create or replace function public.derive_claim(p_limit integer default 50, p_versions jsonb default '{}'::jsonb)
returns table (
  hand_id uuid, owner_id uuid, reason text, villains boolean,
  phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz,
  analysis_version text, decisions jsonb
)
language plpgsql
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_owner uuid := public.derive_caller();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_av    text := nullif(btrim(coalesce(p_versions ->> 'analysis', '')), '');
  v_mv    text := nullif(btrim(coalesce(p_versions ->> 'membership', '')), '');
  v_ids   uuid[];
begin
  if p_versions is not null and jsonb_typeof(p_versions) <> 'object' then
    raise exception 'derive_claim expects a JSON object of versions.' using errcode = '22023';
  end if;
  if v_mv is not null and v_mv !~ '^analytics/[0-9]+$' then
    raise exception 'derive_claim: a membership version is analytics/N.' using errcode = '22023';
  end if;

  -- A hand that crashed its worker five times is given up on.
  with dead as (
    delete from public.derive_queue q
    where q.tries >= 5 and q.claimed_at < now() - interval '5 minutes'
      and (v_owner is null or q.owner_id = v_owner)
    returning q.hand_id, q.owner_id, q.reason, q.tries, q.last_error
  )
  insert into public.derive_failures as f (hand_id, owner_id, reason, error, tries, failed_at)
  select d.hand_id, d.owner_id, d.reason, coalesce(d.last_error, 'The worker stopped before it finished.'), d.tries, now()
  from dead d
  on conflict (hand_id) do update
    set reason = excluded.reason, error = excluded.error, tries = excluded.tries, failed_at = excluded.failed_at;

  -- Free rows, or rows a worker claimed and never answered for.
  if v_owner is null then
    select array_agg(x.hand_id) into v_ids from (
      select q.hand_id from public.derive_queue q
      where (q.claimed_at is null or q.claimed_at < now() - interval '5 minutes') and q.tries < 5
      order by q.priority, q.enqueued_at, q.hand_id
      limit v_limit
      for update skip locked
    ) x;
  else
    select array_agg(x.hand_id) into v_ids from (
      select q.hand_id from public.derive_queue q
      where q.owner_id = v_owner
        and (q.claimed_at is null or q.claimed_at < now() - interval '5 minutes') and q.tries < 5
      order by q.priority, q.enqueued_at, q.hand_id
      limit v_limit
      for update skip locked
    ) x;
  end if;
  if v_ids is null then
    -- P3: the worker's idle moment re-tags the hands of players whose type
    -- changed (a user's own drain never does).
    if v_owner is null then
      perform public.opp_mix_retag(2000);
    end if;
    return;
  end if;

  update public.derive_queue q set claimed_at = now(), tries = q.tries + 1 where q.hand_id = any (v_ids);

  return query
  select q.hand_id, q.owner_id, q.reason, coalesce(o.villains, false),
         h.phf, case when h.phf is null then h.standard_text end,
         h.hand_key, h.site, h.parser_version, h.source_filename, h.created_at,
         a.analysis_version,
         case when a.analysis_version is null then null else coalesce((
           select jsonb_agg(jsonb_build_object(
                    'ord', d.ord, 'action_index', d.action_index, 'status', d.status, 'options', d.options,
                    'ev_loss_bb', d.ev_loss_bb, 'facts', d.facts) order by d.ord)
           from public.decision_analysis d
           where d.hand_id = q.hand_id and d.analysis_version = a.analysis_version and d.owner_id = q.owner_id),
           '[]'::jsonb) end
  from public.derive_queue q
  join public.hands h on h.id = q.hand_id and h.owner_id = q.owner_id
  left join public.derive_options o on o.owner_id = q.owner_id
  left join lateral (
    select ha.analysis_version from public.hand_analysis ha
    where v_av is not null and v_mv is not null
      and ha.hand_id = q.hand_id and ha.analysis_version = v_av and ha.owner_id = q.owner_id
      and not exists (
        select 1 from public.analysis_checker_hands c
        where c.hand_id = ha.hand_id and c.analysis_version = ha.analysis_version and c.membership_version = v_mv)
  ) a on true
  where q.hand_id = any (v_ids)
  order by q.priority, q.enqueued_at, q.hand_id;
end;
$$;

comment on function public.derive_claim(integer, jsonb) is
  'P1: claims up to 100 queued hands (the caller''s, or every owner''s for rail_derive) for five minutes and returns '
  'what the one pass needs to work each out. P3: the derive role''s empty claim re-tags (opp_mix_retag, 2 s).';

revoke all on function public.derive_claim(integer, jsonb) from public, anon;
grant execute on function public.derive_claim(integer, jsonb) to authenticated, rail_derive;

-- ---------------------------------------------------------------------------
-- 7. The Pool tab's readers
-- ---------------------------------------------------------------------------

-- The body of 20271127100000 with the types read from player_types.
create or replace function public.analytics_pool(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner    uuid := auth.uid();
  v_filters  jsonb := coalesce(p_filters, '{}'::jsonb);
  v_mv       text;
  v_formats  text[];
  v_sites    text[];
  v_variants text[];
  v_limits   text[];
  v_sizes    text[];
  v_stakes   text[];
  v_stats    text := coalesce(nullif(btrim(coalesce(v_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_pending  bigint;
  v_out      jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read your pool.' using errcode = '42501';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'analytics_pool expects a JSON object of filters.' using errcode = '22023';
  end if;
  v_mv := public.analytics_membership_version_of(v_filters);
  v_formats := public.library_list(v_filters, 'formats');
  if cardinality(v_formats) = 0 then
    v_formats := public.filter_formats(v_filters);
  end if;
  v_sites    := public.library_list(v_filters, 'sites');
  v_variants := public.library_list(v_filters, 'variants');
  v_limits   := public.library_list(v_filters, 'limits');
  v_sizes    := public.library_list(v_filters, 'sizes');
  v_stakes   := public.library_list(v_filters, 'stakes');

  v_pending := public.derive_pending();

  with fields as (
    -- The owner's fields the filter names.
    select f.field_key
    from (select distinct p.field_key from public.pool_players p
          where p.owner_id = v_owner and p.membership_version = v_mv) f
    where (cardinality(v_sites) = 0 or split_part(f.field_key, '|', 1) = any (v_sites))
      and (v_formats is null or split_part(f.field_key, '|', 2) = any (v_formats))
      and (cardinality(v_variants) = 0 or split_part(f.field_key, '|', 3) = any (v_variants))
      and (cardinality(v_limits) = 0 or split_part(f.field_key, '|', 4) = any (v_limits))
      and (cardinality(v_sizes) = 0 or split_part(f.field_key, '|', 5) = any (v_sizes))
      and (cardinality(v_stakes) = 0 or split_part(f.field_key, '|', 6) = any (v_stakes))
  ), members as (
    select p.site_id, p.player, ty.kind,
           sum(p.hands) as hands, sum(p.net_bb) as net_bb, sum(p.net_bb_sq) as net_bb_sq
    from public.pool_players p
    join fields f on f.field_key = p.field_key
    join public.player_types ty
      on ty.owner_id = v_owner and ty.stats_version = v_stats and ty.site_id = p.site_id and ty.player = p.player
     and ty.kind in ('reg', 'fish')
    where p.owner_id = v_owner and p.membership_version = v_mv
    group by p.site_id, p.player, ty.kind
    having sum(p.hands) > 0
  ), by_type as (
    select m.kind, count(*) as players, sum(m.hands) as hands, sum(m.net_bb) as net_bb, sum(m.net_bb_sq) as net_bb_sq
    from members m
    group by m.kind
  ), rates as (
    select s.stat, m.kind, sum(s.made) as made, sum(s.opp) as opp
    from public.pool_player_stats s
    join fields f on f.field_key = s.field_key
    join members m on m.site_id = s.site_id and m.player = s.player
    where s.owner_id = v_owner and s.membership_version = v_mv
    group by s.stat, m.kind
    having sum(s.opp) > 0
  )
  select jsonb_build_object(
    'version', v_mv,
    'pending', v_pending,
    'reg', coalesce((select jsonb_build_object('players', b.players, 'hands', b.hands, 'netBb', b.net_bb, 'netBbSq', b.net_bb_sq)
                     from by_type b where b.kind = 'reg'),
                    jsonb_build_object('players', 0, 'hands', 0, 'netBb', 0, 'netBbSq', 0)),
    'fish', coalesce((select jsonb_build_object('players', b.players, 'hands', b.hands, 'netBb', b.net_bb, 'netBbSq', b.net_bb_sq)
                      from by_type b where b.kind = 'fish'),
                     jsonb_build_object('players', 0, 'hands', 0, 'netBb', 0, 'netBbSq', 0)),
    'stats', coalesce((select jsonb_agg(jsonb_build_object('stat', r.stat, 'type', r.kind, 'made', r.made, 'opp', r.opp)
                                        order by r.stat collate "C", r.kind desc)
                       from rates r), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;

comment on function public.analytics_pool(jsonb) is
  'Analytics Step 10 / P2 / P3: the caller''s regs and fish (player_types) - players, hands, sum of results and of '
  'their squares - and their catalogue rates, over the fields the filter names (rooms, formats, games, limits, '
  'sizes, stakes); pending: the caller''s hands still being processed (derive_pending).';

revoke all on function public.analytics_pool(jsonb) from public, anon;
grant execute on function public.analytics_pool(jsonb) to authenticated;

-- The player's results with a fish in the pot (opp_mix fish) and with regs
-- and no fish (regs, mixed) over the Hands filter: `report_open`'s summary
-- (hands, money hands, big blinds; null big blinds when chips and cash mix)
-- for the "vs type" filters the Pool tab ran before, from hero_opp_rollups
-- for whole days and hero_report_rows for the rest (partial days; a group
-- beyond the rollups: `report_hand_ids`). The filter's own `vsTypes` is
-- ignored (the split is this reader's). Rows not tagged yet count in
-- neither.
create or replace function public.analytics_pool_you(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter - 'vsTypes' else '{}'::jsonb end;
  v_ids       uuid[];
  v_version   text;
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
  v_out       jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read your pool.' using errcode = '42501';
  end if;
  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ids       := public.report_hand_ids(v_filter);
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
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));
  -- report_open's cut: whole UTC days from the rollup, the partial days at
  -- the range's two ends from the rows.
  if v_from is not null then
    v_from_day := (v_from at time zone 'UTC')::date
                  + case when (v_from at time zone 'UTC')::time = '00:00' then 0 else 1 end;
  end if;
  if v_to is not null then
    v_to_day := (v_to at time zone 'UTC')::date;
  end if;
  v_from_at := coalesce(v_from_day::timestamp at time zone 'UTC', '-infinity'::timestamptz);
  v_to_at   := coalesce(v_to_day::timestamp at time zone 'UTC', 'infinity'::timestamptz);

  with f as (
    select r.opp_mix, r.kind, r.game_format, sum(r.hands) as hands, sum(r.net_bb_milli) as net
    from public.hero_opp_rollups r
    where r.owner_id = v_owner and r.stats_version = v_version
      and r.opp_mix in ('fish', 'regs', 'mixed')
      and v_ids is null
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
    group by 1, 2, 3
    union all
    select x.opp_mix, x.kind, x.game_format, count(*), sum(x.net_bb_milli)
    from public.hero_report_rows x
    where x.owner_id = v_owner and x.stats_version = v_version
      and x.opp_mix in ('fish', 'regs', 'mixed')
      and (v_ids is not null or v_from is not null or v_to is not null)
      and (v_ids is not null or (x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
           and x.played_at < coalesce(v_to, 'infinity'::timestamptz)))
      and (v_ids is not null or not (x.played_at >= v_from_at and x.played_at < v_to_at))
      and (v_ids is null or x.hand_id = any (v_ids))
      and (cardinality(v_sites) = 0 or x.site_id = any (v_sites))
      and (not v_fmt_set or x.game_format = any (v_fmt_enum))
      and (cardinality(v_variants) = 0 or x.variant = any (v_variants))
      and (cardinality(v_limits) = 0 or x.limit_type = any (v_limits))
      and (cardinality(v_sizes) = 0 or x.size = any (v_sizes))
      and (cardinality(v_stakes) = 0 or x.stake = any (v_stakes))
      and (cardinality(v_positions) = 0 or x."position" = any (v_positions))
      and x.kind = any (v_kinds)
    group by 1, 2, 3
  ), g as (
    select s.side,
           coalesce(sum(f.hands), 0)::bigint as hands,
           coalesce(sum(f.hands) filter (where v_cashouts or f.kind & 4 = 0), 0)::bigint as money_hands,
           coalesce(sum(f.net) filter (where v_cashouts or f.kind & 4 = 0), 0)::bigint as net,
           coalesce(bool_or(f.game_format = 'cash'), false) and coalesce(bool_or(f.game_format <> 'cash'), false) as mixed
    from (values ('fish'), ('any')) s(side)
    left join f on s.side = 'any' or f.opp_mix = 'fish'
    group by s.side
  )
  select jsonb_build_object(
    'statsVersion', v_version,
    'fish', (select jsonb_build_object('hands', a.hands, 'moneyHands', a.money_hands,
                                       'netBbMilli', case when a.mixed then null else a.net end)
             from g a where a.side = 'fish'),
    'regsOnly', (select jsonb_build_object('hands', b.hands - a.hands, 'moneyHands', b.money_hands - a.money_hands,
                                           'netBbMilli', case when a.mixed or b.mixed then null else b.net - a.net end)
                 from g a, g b where a.side = 'fish' and b.side = 'any'))
  into v_out;
  return v_out;
end;
$$;

comment on function public.analytics_pool_you(jsonb) is
  'P3: the player''s hands, money hands and result (bb) with a fish in the pot and with regs and no fish, over the '
  'Hands filter (report_open''s rules), from hero_opp_rollups and hero_report_rows.opp_mix. The Pool tab''s figures.';

revoke all on function public.analytics_pool_you(jsonb) from public, anon;
grant execute on function public.analytics_pool_you(jsonb) to authenticated;

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.analytics_pool_you(jsonb)', 'analysis', 'Analytics: the Pool tab''s "you with a fish / regs only" figures')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

select public.entitlement_gates_apply();

-- ---------------------------------------------------------------------------
-- 8. The account's data
-- ---------------------------------------------------------------------------

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.player_types', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of opponents: each opponent''s type (reg, fish, other, unknown) from their statistics.'),
  ('public.player_type_changes', 'table', '{owner_id}', 'internal', null, null, null, null, '{}', 'cascade',
   'Opponents whose type changed, whose hands are being tagged again.'),
  ('public.hero_opp_rollups', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of hand_stats: the hero''s hands and result by the types of opponents in the pot.')
on conflict (name) do nothing;

commit;
