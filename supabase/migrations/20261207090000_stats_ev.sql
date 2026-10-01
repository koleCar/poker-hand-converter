-- ===========================================================================
-- All-in EV: storage, backfill and the graph's fourth line (F13 / M5, #50)
-- ===========================================================================
--
-- The equity engine is `frontend/src/lib/equity` (pure TypeScript, tested over
-- the corpus). This is where its answer lives and how the graph reads it.
--
-- ## A sibling table, not columns on `hand_stats`
--
-- Under the no-UPDATE posture, an EV fix would otherwise mean re-inserting the
-- whole statistics row. `ev_version` is separate from `stats_version` for the
-- same reason: an equity fix must not force a statistics rebuild, nor the other
-- way round.
--
-- ## One row per evaluated hero hand, applicable or not
--
-- Most hands have no all-in, so their EV is their result. Storing a row for
-- those as well (`applicable = false`, `ev_net = net`) is what makes "which
-- hands still need evaluating" a computed question -- the same keyset backfill
-- the statistics use -- instead of re-deriving the whole library to find the
-- 6% that matter. The rows are a few dozen bytes.
--
-- ## Who writes it
--
-- The statistics rebuild route, as the user, next to the database: it already
-- holds every document it derives from. `save_hand_ev` is `security invoker`
-- and resolves `hand_key` under RLS, exactly like `save_hand_stats`.
-- ===========================================================================

begin;

create table if not exists public.hand_stats_ev (
  hand_id         uuid not null references public.hands (id) on delete cascade,
  owner_id        uuid not null references auth.users (id) on delete cascade,
  seat            smallint not null check (seat between 0 and 24),
  ev_version      text not null check (ev_version ~ '^ev/[0-9]+$'),
  hand_key        text not null check (char_length(hand_key) between 1 and 200),
  -- True when there was an all-in with cards to come; false means ev = net.
  applicable      boolean not null,
  ev_net          bigint not null,
  ev_net_bb_milli bigint not null,
  created_at      timestamptz not null default now(),
  primary key (hand_id, ev_version, seat)
);

comment on table public.hand_stats_ev is
  'All-in EV per evaluated hero seat. applicable=false rows carry ev_net = net, '
  'so "needs evaluating" is computed. Derived from hands.phf by lib/equity.';

alter table public.hand_stats_ev enable row level security;
revoke all on public.hand_stats_ev from anon, authenticated;
grant select, insert on public.hand_stats_ev to authenticated;

create policy hand_stats_ev_owner_select on public.hand_stats_ev
  for select to authenticated using (owner_id = (select auth.uid()));
create policy hand_stats_ev_owner_insert on public.hand_stats_ev
  for insert to authenticated with check (owner_id = (select auth.uid()));

-- Same posture as `hand_stats_normalize`: the owner is the session's, whatever
-- the client sent.
create or replace function public.hand_stats_ev_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.owner_id := (select auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists hand_stats_ev_normalize_before on public.hand_stats_ev;
create trigger hand_stats_ev_normalize_before
before insert on public.hand_stats_ev
for each row execute function public.hand_stats_ev_normalize();

-- The statistics bucket: a backfill writes both, and it must not lock anybody
-- out of uploading (the reasoning is on `hand_stats_rate_limit`).
create or replace function public.hand_stats_ev_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  select count(*) into v_rows from inserted;
  if v_rows > 2000 then
    raise exception 'Batch too large: % EV rows in one statement (max 2000).', v_rows
      using errcode = '53400';
  end if;
  perform public.enforce_rate_limit('hand_stats_insert', v_rows, 200000, interval '10 minutes');
  return null;
end;
$$;

revoke execute on function public.hand_stats_ev_rate_limit() from public, anon, authenticated;

drop trigger if exists hand_stats_ev_rate_limit_after_insert on public.hand_stats_ev;
create trigger hand_stats_ev_rate_limit_after_insert
after insert on public.hand_stats_ev
referencing new table as inserted
for each statement execute function public.hand_stats_ev_rate_limit();

-- --------------------------------------------------------- save_hand_ev ---

create or replace function public.save_hand_ev(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_ev expects a JSON array' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 1000 then
    raise exception 'save_hand_ev accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_to_recordset(p_rows) as x(
      hand_key text, seat smallint, ev_version text, applicable boolean,
      ev_net bigint, ev_net_bb_milli bigint)
  ),
  ins as (
    insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
    select h.id, v_owner, i.seat, i.ev_version, i.hand_key, i.applicable, i.ev_net, i.ev_net_bb_milli
    from input i
    -- RLS on `hands` is the ownership check, as in `save_hand_stats`.
    join public.hands h on h.hand_key = i.hand_key
    on conflict (hand_id, ev_version, seat) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object('received', v_received, 'inserted', v_inserted);
end;
$$;

revoke all on function public.save_hand_ev(jsonb) from public, anon;
grant execute on function public.save_hand_ev(jsonb) to authenticated;

-- -------------------------------------------- the backfill learns about EV ---
--
-- `hands_needing_stats` gains `p_ev_version`: with it, a hand that has its
-- statistics but no EV row at that version needs work too. Dropped and
-- recreated rather than overloaded, for the reason given in 20261123090000.

drop function if exists public.hands_needing_stats(text, uuid, integer, boolean);

create or replace function public.hands_needing_stats(
  p_version    text,
  p_after      uuid    default null,
  p_limit      integer default 100,
  p_villains   boolean default false,
  p_ev_version text    default null
)
returns table (id uuid, phf jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is null then
    raise exception 'You must be signed in to rebuild statistics.' using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'hands_needing_stats needs a stats_version.' using errcode = '22023';
  end if;

  return query
  select hd.id, hd.phf
  from public.hands hd
  where hd.owner_id = v_owner
    and hd.hero_seat is not null
    and (p_after is null or hd.id > p_after)
    and (
      not exists (
        select 1 from public.hand_stats s
        where s.hand_id = hd.id and s.stats_version = p_version and s.is_hero)
      or (
        coalesce(p_villains, false)
        and hd.site_anonymization <> 'positional'
        and not exists (
          select 1 from public.hand_stats s
          where s.hand_id = hd.id and s.stats_version = p_version and not s.is_hero))
      or (
        p_ev_version is not null
        and not exists (
          select 1 from public.hand_stats_ev e
          where e.hand_id = hd.id and e.ev_version = p_ev_version))
    )
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

revoke all on function public.hands_needing_stats(text, uuid, integer, boolean, text) from public, anon;
grant execute on function public.hands_needing_stats(text, uuid, integer, boolean, text) to authenticated;

-- ------------------------------------------- coverage counts EV, too ---

create or replace function public.stats_ev_missing(p_version text, p_ev_version text)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  -- Hands with hero statistics at `p_version` and no EV row at `p_ev_version`.
  select count(*)
  from public.hand_stats s
  where s.owner_id = (select auth.uid())
    and s.stats_version = p_version
    and s.is_hero
    and not exists (
      select 1 from public.hand_stats_ev e
      where e.hand_id = s.hand_id and e.ev_version = p_ev_version);
$$;

revoke all on function public.stats_ev_missing(text, text) from public, anon;
grant execute on function public.stats_ev_missing(text, text) to authenticated;

-- ----------------------------------------------------------- the graph ---
--
-- `stats_graph` as in 20261005090000, with the EV series joined in. The base
-- set, the bucketing and every other series are unchanged, so the fourth line
-- is drawn over exactly the hands the other three are.

create or replace function public.stats_graph(
  p_filters jsonb    default '{}'::jsonb,
  p_buckets integer  default 60
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_from     timestamptz := nullif(btrim(coalesce(p_filters ->> 'from', '')), '')::timestamptz;
  v_to       timestamptz := nullif(btrim(coalesce(p_filters ->> 'to', '')), '')::timestamptz;
  v_site     text := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_variant  text := nullif(btrim(coalesce(p_filters ->> 'variant', '')), '');
  v_limit    text := nullif(lower(btrim(coalesce(p_filters ->> 'limitType', ''))), '');
  v_format   public.game_format;
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_positions text[];
  v_classes   text[];
  v_tourney  text := nullif(btrim(coalesce(p_filters ->> 'tournamentId', '')), '');
  v_fast     text := nullif(btrim(coalesce(p_filters ->> 'fastFold', '')), '');
  v_fast_only boolean := nullif(btrim(coalesce(p_filters ->> 'fastFoldOnly', '')), '')::boolean;
  v_min_players integer := nullif(btrim(coalesce(p_filters ->> 'minPlayers', '')), '')::integer;
  v_max_players integer := nullif(btrim(coalesce(p_filters ->> 'maxPlayers', '')), '')::integer;
  v_bomb     boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeBombPots', '')), '')::boolean, false);
  v_straddle boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeStraddled', '')), '')::boolean, true);
  v_cashouts boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'includeCashouts', '')), '')::boolean, false);
  v_where    text := public.hand_stats_filter_sql();
  -- Bounded: one bucket is a single point and 400 is already more than there
  -- are pixels across a chart on a phone. A caller asking for 100 000 would
  -- otherwise be asking for a sort with 100 000 groups.
  v_buckets  integer := least(greatest(coalesce(p_buckets, 60), 1), 400);
  v_ev_version text := coalesce(nullif(btrim(coalesce(p_filters ->> 'evVersion', '')), ''), 'ev/1');
  v_ev       jsonb;
  v_meta     jsonb;
  v_rows     jsonb;
  v_mixed_currency boolean;
  v_mixed_kind     boolean;
  v_total    bigint;
begin
  if v_owner is null then
    return public.stats_empty_graph(v_version);
  end if;

  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;

  v_positions := coalesce(
    public.normalize_positions(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'positions', '[]'::jsonb)))
    ), '{}'::text[]);
  v_classes := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'handClasses', '[]'::jsonb))),
    '{}'::text[]);

  execute format($q$
    select to_jsonb(t) from (
      select
        count(*)::bigint                                   as row_count,
        count(distinct hs.currency)::integer               as currency_count,
        count(distinct (hs.game_format = 'cash'))::integer as unit_kind_count,
        min(hs.currency)                                   as currency,
        min(hs.currency_minor_units)::integer              as currency_minor_units,
        count(*) filter (where $20::boolean or not hs.has_cashout)::bigint as money_hands
      from public.hand_stats hs
      %1$s
    ) t
  $q$, v_where)
    into v_meta
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts;

  v_total := coalesce((v_meta ->> 'row_count')::bigint, 0);
  if v_total = 0 then
    return public.stats_empty_graph(v_version);
  end if;

  v_mixed_currency := (v_meta ->> 'currency_count')::integer > 1;
  v_mixed_kind     := (v_meta ->> 'unit_kind_count')::integer > 1;

  if v_mixed_kind then
    -- Refused outright. Every series on this chart is money.
    return jsonb_build_object(
      'statsVersion',       v_version,
      'buckets',            '[]'::jsonb,
      'hands',              v_total,
      'moneyHands',         coalesce((v_meta ->> 'money_hands')::bigint, 0),
      'currency',           null,
      'currencyMinorUnits', null,
      'mixedCurrency',      v_mixed_currency,
      'mixedUnitKind',      true,
      'moneyAvailable',     false,
      'allInEv',            null
    );
  end if;

  execute format($q$
    with base as (
      select hs.played_at, hs.hand_key, hs.wtsd, hs.net, hs.net_bb_milli, hs.has_cashout,
             -- A hand with no all-in has no variance to take out: its EV line
             -- is its result. A hand not evaluated yet is the same, and is
             -- counted, so the screen can say how much of the line is real.
             coalesce(ev.ev_net_bb_milli, hs.net_bb_milli) as ev_bb_milli,
             ev.hand_id is not null                        as ev_known,
             coalesce(ev.applicable, false)                as ev_applicable
      from public.hand_stats hs
      left join public.hand_stats_ev ev
        on ev.hand_id = hs.hand_id and ev.seat = hs.seat and ev.ev_version = $22::text
      %1$s
    ),
    ordered as (
      -- `hand_key` breaks the tie so the bucketing is deterministic: two hands
      -- with the same timestamp (common -- a fast-fold pool deals several a
      -- second) must not land in different buckets on two different runs, or
      -- the graph would shimmer between reloads.
      select b.*, ntile($21::integer) over (order by b.played_at asc nulls last, b.hand_key) as bucket
      from base b
    ),
    per_bucket as (
      select
        o.bucket,
        count(*)::bigint as hands,
        count(*) filter (where $20::boolean or not o.has_cashout)::bigint as money_hands,
        coalesce(sum(o.net_bb_milli)
                 filter (where $20::boolean or not o.has_cashout), 0)::bigint as net_bb_milli,
        coalesce(sum(o.net_bb_milli)
                 filter (where ($20::boolean or not o.has_cashout) and o.wtsd = 1), 0)::bigint as sd_bb_milli,
        coalesce(sum(o.net_bb_milli)
                 filter (where ($20::boolean or not o.has_cashout) and o.wtsd = 0), 0)::bigint as nsd_bb_milli,
        coalesce(sum(o.net)
                 filter (where $20::boolean or not o.has_cashout), 0)::bigint as net,
        coalesce(sum(o.ev_bb_milli)
                 filter (where $20::boolean or not o.has_cashout), 0)::bigint as ev_bb_milli,
        count(*) filter (where o.ev_known)::bigint      as ev_known,
        count(*) filter (where o.ev_applicable)::bigint as ev_applicable,
        min(o.played_at) as first_played_at,
        max(o.played_at) as last_played_at
      from ordered o
      group by o.bucket
    )
    select coalesce(jsonb_agg(to_jsonb(t) order by t.bucket), '[]'::jsonb) from (
      select
        p.bucket,
        p.hands,
        p.money_hands,
        p.first_played_at,
        p.last_played_at,
        sum(p.hands)        over o as cum_hands,
        sum(p.money_hands)  over o as cum_money_hands,
        sum(p.net_bb_milli) over o as cum_net_bb_milli,
        sum(p.sd_bb_milli)  over o as cum_sd_bb_milli,
        sum(p.nsd_bb_milli) over o as cum_nsd_bb_milli,
        sum(p.net)          over o as cum_net,
        sum(p.ev_bb_milli)  over o as cum_ev_bb_milli,
        p.ev_known,
        p.ev_applicable
      from per_bucket p
      window o as (order by p.bucket rows between unbounded preceding and current row)
    ) t
  $q$, v_where)
    into v_rows
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts,
          v_buckets, v_ev_version;

  select jsonb_build_object(
           'evVersion',      v_ev_version,
           'evaluatedHands', coalesce(sum((e ->> 'ev_known')::bigint), 0),
           'allInHands',     coalesce(sum((e ->> 'ev_applicable')::bigint), 0))
    into v_ev
    from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) e;

  if v_mixed_currency then
    -- Dollars and euros in one sample: the big-blind series survive, the
    -- currency one is removed rather than rendered as a number with no unit.
    select coalesce(jsonb_agg(e - 'cum_net'), '[]'::jsonb)
      into v_rows
      from jsonb_array_elements(coalesce(v_rows, '[]'::jsonb)) e;
  end if;

  return jsonb_build_object(
    'statsVersion',       v_version,
    'buckets',            coalesce(v_rows, '[]'::jsonb),
    'hands',              v_total,
    'moneyHands',         coalesce((v_meta ->> 'money_hands')::bigint, 0),
    'currency',           case when v_mixed_currency then null else v_meta ->> 'currency' end,
    'currencyMinorUnits', case when v_mixed_currency then null else (v_meta ->> 'currency_minor_units')::integer end,
    'mixedCurrency',      v_mixed_currency,
    'mixedUnitKind',      false,
    'moneyAvailable',     true,
    -- The fourth series (20261207090000): cum_ev_bb_milli on every bucket, and
    -- how much of the sample it actually covers.
    'allInEv',            v_ev
  );
end;
$$;

revoke all on function public.stats_graph(jsonb, integer) from public;
revoke execute on function public.stats_graph(jsonb, integer) from anon;
grant execute on function public.stats_graph(jsonb, integer) to authenticated;

commit;
