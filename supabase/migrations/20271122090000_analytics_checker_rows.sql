-- ============================================================================
-- Analytics Step 2: the checker rows (docs/ANALYTICS.md §5 Step 2).
-- ============================================================================
--
-- What the stat checker needs from each analysed decision, one row per
-- (decision, catalogue rate it belongs to): whether it took the rate's action
-- class, the reference's share of the class (Σ freq of its options in it),
-- whether the reference's best option is in it, the EV loss, the bet-size
-- bucket, the hand class and the spot (`pot|role|hero|opponent`).
--
-- ## Why a new narrow table, not columns on `analysis_leak_rows`
--
--   * A decision belongs to 0..n rates (preflop VPIP + PFR + RFI at once;
--     flop fold and flop raise vs a bet), and "taken" and the class share are
--     per rate: one row per (decision, rate) groups with a plain GROUP BY.
--   * The membership cannot be computed in SQL (it needs the hand's whole
--     action stream: raise levels, steals, the cbet chain, a checked-through
--     street; `decision_analysis` and its facts do not hold it). The rows are
--     derived where the decisions are analysed - in the browser
--     (`web/src/lib/stats/analyticsRows.ts`, over `decisionMembership`) - and
--     written by `analytics_rows_save`, so they cannot be kept by the leak
--     rows' statement triggers on `decision_analysis`.
--   * They carry their own version (`membership_version`,
--     `ANALYTICS_MEMBERSHIP_VERSION`): a catalogue change re-derives them
--     without touching the analysis.
--
-- ## Tables
--
--   * `analysis_checker_rows` - one row per (hand, analysis version, ord,
--     stat), with the hand's groups (time, room, stake, format, seat, pot
--     type) and the decision's action index and EV loss copied from its leak
--     row, so the readers filter one narrow table. A foreign key to
--     `decision_analysis` takes the rows away with their decision (a prune, a
--     hand or an account deleted).
--   * `analysis_checker_hands` - one row per hand whose rows were written at
--     a membership version (rows or not: a hand with no decision in any rate
--     has none). The backfill's work list is a hand analysed at the version
--     without a row here at the current membership version.
--
-- ## Functions (every one Pro, `require_entitlement('analysis')`)
--
--   analytics_rows_save(p_hands jsonb)                    definer writer
--   analytics_rows_pending(p_analysis_version, p_membership_version, p_after, p_limit)
--                                                         the backfill's page
--   analytics_checker(p_filters jsonb)                    grouped sums
--   analytics_checker_examples(p_filters, p_stat, p_spot, p_size, p_hand_class, p_side, p_limit)
--                                                         top decisions by EV loss
--
-- The filters are the analysis readers' (`analysis_filter_of`: version,
-- dates, room, format / kind, stake, seat, pot type, the Hands list's
-- `hands`) plus `potKind` (`hu`, `mw`, `bomb`, as the leak readers read it)
-- and `membershipVersion` (default `analytics/1`). A grade, status, street or
-- flag filter does not apply to the checker and is ignored.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.analysis_checker_hands (
  hand_id            uuid        not null,
  analysis_version   text        not null,
  owner_id           uuid        not null references auth.users (id) on delete cascade,
  membership_version text        not null check (membership_version ~ '^analytics/[0-9]+$'),
  -- The hand's groups, for the readers' hand count.
  played_at          timestamptz,
  site               text        not null,
  game_format        text        not null,
  currency           text        not null,
  big_blind          bigint,
  hero_position      text        not null,
  pot_type           text        not null,
  saved_at           timestamptz not null default now(),
  primary key (hand_id, analysis_version),
  foreign key (hand_id, analysis_version)
    references public.hand_analysis (hand_id, analysis_version) on delete cascade
);

comment on table public.analysis_checker_hands is
  'Analytics Step 2: a hand whose checker rows were written at membership_version (with or without rows). '
  'Written by analytics_rows_save; a hand analysed without a row here at the current version is the backfill''s work.';

create index if not exists analysis_checker_hands_owner_idx
  on public.analysis_checker_hands (owner_id, analysis_version, membership_version);

create table if not exists public.analysis_checker_rows (
  hand_id            uuid           not null,
  analysis_version   text           not null,
  ord                smallint       not null,
  -- The catalogue rate (config/stats/analytics.json).
  stat               text           not null check (stat ~ '^[a-z][a-z0-9_]{0,47}$'),
  owner_id           uuid           not null references auth.users (id) on delete cascade,
  membership_version text           not null check (membership_version ~ '^analytics/[0-9]+$'),
  action_index       integer        not null,
  -- The hand's groups (from its leak row).
  played_at          timestamptz,
  site               text           not null,
  game_format        text           not null,
  currency           text           not null,
  big_blind          bigint,
  hero_position      text           not null,
  pot_type           text           not null,
  -- The decision took the rate's action class.
  taken              boolean        not null,
  -- Σ of the reference's frequencies of the options in the class, and whether
  -- its best option is in it; both null for a decision that was not analysed.
  ref_share          numeric(9, 6)  check (ref_share between 0 and 2),
  best_in            boolean,
  -- The leak row's: 0 where the decision has none.
  ev_loss_bb         numeric(12, 3) not null,
  -- '' preflop or with no bet faced; else a catalogue size bucket id.
  size               text           not null check (size ~ '^([0-9]+(-[0-9]+|\+))?$'),
  -- '' preflop; else a catalogue hand class id.
  hand_class         text           not null check (hand_class ~ '^[a-z_]*$'),
  -- pot|role|hero|opponent (analyticsRows.ts spotKey).
  spot               text           not null check (spot ~ '^[a-z0-9+-]*\|[a-z0-9-]*\|[A-Z0-9+]*\|([A-Z0-9+]*|multi)$'),
  -- The decision's scenario is multiway (`-mw-`).
  multiway           boolean        not null,
  primary key (hand_id, analysis_version, ord, stat),
  foreign key (hand_id, analysis_version, ord)
    references public.decision_analysis (hand_id, analysis_version, ord) on delete cascade,
  check ((ref_share is null) = (best_in is null))
);

comment on table public.analysis_checker_rows is
  'Analytics Step 2: one row per (analysed decision, catalogue rate it belongs to) - taken, the reference''s '
  'class share, best option in class, EV loss, size bucket, hand class, spot - with the hand''s groups. '
  'Derived in the browser (analyticsRows.ts), written by analytics_rows_save; summed by analytics_checker.';

-- Every reader scans one account's version; the examples read by EV loss.
create index if not exists analysis_checker_rows_read_idx
  on public.analysis_checker_rows (owner_id, analysis_version, stat, ev_loss_bb desc);

do $$
declare
  t text;
begin
  foreach t in array array['analysis_checker_hands', 'analysis_checker_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))',
                   t || '_owner_select', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The writer
-- ---------------------------------------------------------------------------
--
-- p_hands: at most 200 hands, each
--   { hand_id, analysis_version, membership_version,
--     rows: [{ ord, stat, taken, ref_share, best_in, size, hand_class, spot, multiway }] }
-- Per hand: the caller's analysis at that version must exist (else the hand
-- is skipped as missing); its rows at that version are replaced, rows whose
-- (hand, version, ord) has no decision are dropped, and the hand's marker is
-- set to the membership version. Idempotent: the same call twice leaves the
-- same rows.

create or replace function public.analytics_rows_save(p_hands jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_hands    integer;
  v_rows     integer;
  v_ids      uuid[];
  v_versions text[];
  v_mvs      text[];
  v_rowsets  jsonb[];
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to save an analysis.' using errcode = '42501';
  end if;
  if p_hands is null or jsonb_typeof(p_hands) <> 'array' then
    raise exception 'analytics_rows_save expects a JSON array of hands.' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_hands);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'saved', 0, 'missing', 0, 'rows', 0);
  end if;
  if v_received > 200 then
    raise exception 'analytics_rows_save accepts at most 200 hands per call (got %).', v_received
      using errcode = '53400';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'hand_id', '') !~ '^[0-9a-fA-F-]{36}$'
       or coalesce(e ->> 'analysis_version', '') !~ '^analysis/[0-9]+$'
       or coalesce(e ->> 'membership_version', '') !~ '^analytics/[0-9]+$'
       or jsonb_typeof(e -> 'rows') is distinct from 'array'
       or jsonb_array_length(e -> 'rows') > 2000)
  then
    raise exception 'analytics_rows_save: a hand needs hand_id, analysis_version, membership_version and rows (at most 2000).'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_hands) e, jsonb_array_elements(e -> 'rows') r
    where jsonb_typeof(r) <> 'object'
       or jsonb_typeof(r -> 'ord') is distinct from 'number'
       or jsonb_typeof(r -> 'taken') is distinct from 'boolean'
       or jsonb_typeof(r -> 'multiway') is distinct from 'boolean'
       or jsonb_typeof(r -> 'ref_share') not in ('number', 'null')
       or jsonb_typeof(r -> 'best_in') not in ('boolean', 'null')
       or (jsonb_typeof(r -> 'ref_share') = 'null') <> (jsonb_typeof(r -> 'best_in') = 'null')
       or coalesce(r ->> 'stat', '') !~ '^[a-z][a-z0-9_]{0,47}$'
       or (r ->> 'size') is null or (r ->> 'hand_class') is null or (r ->> 'spot') is null)
  then
    raise exception 'analytics_rows_save: a row needs ord, stat, taken, ref_share, best_in, size, hand_class, spot and multiway.'
      using errcode = '22023';
  end if;

  perform public.enforce_rate_limit('analytics_rows:' || v_owner::text, v_received, 100000, interval '10 minutes');

  -- The caller's hands, analysed at the version named (the first entry of a hand named twice).
  select coalesce(array_agg(x.hand_id order by x.hand_id), '{}'), coalesce(array_agg(x.analysis_version order by x.hand_id), '{}'),
         coalesce(array_agg(x.membership_version order by x.hand_id), '{}'), coalesce(array_agg(x.rows order by x.hand_id), '{}')
    into v_ids, v_versions, v_mvs, v_rowsets
  from (
    select distinct on ((e ->> 'hand_id')::uuid, e ->> 'analysis_version')
           (e ->> 'hand_id')::uuid as hand_id, e ->> 'analysis_version' as analysis_version,
           e ->> 'membership_version' as membership_version, e -> 'rows' as rows
    from jsonb_array_elements(p_hands) with ordinality as t(e, n)
    join public.hand_analysis a
      on a.hand_id = (e ->> 'hand_id')::uuid and a.analysis_version = e ->> 'analysis_version'
     and a.owner_id = v_owner
    order by (e ->> 'hand_id')::uuid, e ->> 'analysis_version', n
  ) x;
  v_hands := cardinality(v_ids);

  delete from public.analysis_checker_rows c
  using unnest(v_ids, v_versions) as i(hand_id, analysis_version)
  where c.hand_id = i.hand_id and c.analysis_version = i.analysis_version and c.owner_id = v_owner;

  insert into public.analysis_checker_rows (
    hand_id, analysis_version, ord, stat, owner_id, membership_version, action_index,
    played_at, site, game_format, currency, big_blind, hero_position, pot_type,
    taken, ref_share, best_in, ev_loss_bb, size, hand_class, spot, multiway)
  select distinct on (i.hand_id, i.analysis_version, z.ord, r ->> 'stat')
         i.hand_id, i.analysis_version, z.ord, r ->> 'stat', v_owner, i.membership_version, z.action_index,
         z.played_at, z.site, z.game_format, z.currency, z.big_blind, z.hero_position, z.pot_type,
         (r ->> 'taken')::boolean, (r ->> 'ref_share')::numeric, (r ->> 'best_in')::boolean, z.ev_loss_bb,
         r ->> 'size', r ->> 'hand_class', r ->> 'spot', (r ->> 'multiway')::boolean
  from unnest(v_ids, v_versions, v_mvs, v_rowsets) as i(hand_id, analysis_version, membership_version, rows)
  cross join lateral jsonb_array_elements(i.rows) r
  join public.analysis_leak_rows z
    on z.hand_id = i.hand_id and z.analysis_version = i.analysis_version
   and z.ord = (r ->> 'ord')::smallint and z.owner_id = v_owner;
  get diagnostics v_rows = row_count;

  insert into public.analysis_checker_hands (
    hand_id, analysis_version, owner_id, membership_version, played_at, site, game_format, currency,
    big_blind, hero_position, pot_type, saved_at)
  select i.hand_id, i.analysis_version, v_owner, i.membership_version, h.played_at, h.site, h.game_format::text,
         h.currency, h.big_blind, coalesce(h.hero_position, ''), a.pot_type, now()
  from unnest(v_ids, v_versions, v_mvs) as i(hand_id, analysis_version, membership_version)
  join public.hand_analysis a on a.hand_id = i.hand_id and a.analysis_version = i.analysis_version
  join public.hands h on h.id = i.hand_id and h.owner_id = v_owner
  on conflict (hand_id, analysis_version) do update
    set membership_version = excluded.membership_version, saved_at = excluded.saved_at;

  return jsonb_build_object('received', v_received, 'saved', v_hands, 'missing', v_received - v_hands, 'rows', v_rows);
end;
$$;

comment on function public.analytics_rows_save(jsonb) is
  'Analytics Step 2: replaces the caller''s checker rows of up to 200 analysed hands (keyed by hand, version, ord, '
  'stat) and marks each hand at its membership version. Groups, action index and EV loss come from the leak rows.';

revoke all on function public.analytics_rows_save(jsonb) from public, anon;
grant execute on function public.analytics_rows_save(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The backfill's page
-- ---------------------------------------------------------------------------
--
-- The caller's hands analysed at p_analysis_version without a marker at
-- p_membership_version (never written, or written at another version), by
-- hand id after p_after: each with its stored hand (as hands_needing_analysis
-- returns it) and its decisions (ord, action_index, status, options,
-- ev_loss_bb, facts) - what analyticsRows reads. No re-analysis.

create or replace function public.analytics_rows_pending(
  p_analysis_version   text,
  p_membership_version text,
  p_after              uuid    default null,
  p_limit              integer default 100
)
returns table (
  id uuid, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz, decisions jsonb
)
language plpgsql
stable
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_owner uuid := auth.uid();
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to analyse hands.' using errcode = '42501';
  end if;
  if p_analysis_version is null or p_analysis_version !~ '^analysis/[0-9]+$' then
    raise exception 'analytics_rows_pending needs an analysis_version.' using errcode = '22023';
  end if;
  if p_membership_version is null or p_membership_version !~ '^analytics/[0-9]+$' then
    raise exception 'analytics_rows_pending needs a membership_version.' using errcode = '22023';
  end if;

  return query
  with page as (
    select a.hand_id
    from public.hand_analysis a
    where a.owner_id = v_owner and a.analysis_version = p_analysis_version
      and (p_after is null or a.hand_id > p_after)
      and not exists (
        select 1 from public.analysis_checker_hands c
        where c.hand_id = a.hand_id and c.analysis_version = a.analysis_version
          and c.membership_version = p_membership_version)
    order by a.hand_id
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  )
  select hd.id, public.analysis_trimmed_phf(hd.phf),
         case when hd.phf is null then hd.standard_text end,
         hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'ord', d.ord, 'action_index', d.action_index, 'status', d.status, 'options', d.options,
                    'ev_loss_bb', d.ev_loss_bb, 'facts', d.facts) order by d.ord)
           from public.decision_analysis d
           where d.hand_id = hd.id and d.analysis_version = p_analysis_version and d.owner_id = v_owner),
           '[]'::jsonb)
  from page p
  join public.hands hd on hd.id = p.hand_id and hd.owner_id = v_owner
  order by hd.id;
end;
$$;

comment on function public.analytics_rows_pending(text, text, uuid, integer) is
  'Analytics Step 2: a page of the caller''s hands analysed at a version whose checker rows are missing or at another '
  'membership version, with their stored hand and decisions (the browser derives the rows; no re-analysis).';

revoke all on function public.analytics_rows_pending(text, text, uuid, integer) from public, anon;
grant execute on function public.analytics_rows_pending(text, text, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The readers
-- ---------------------------------------------------------------------------

-- The checker's membership version from the filters (default analytics/1).
create or replace function public.analytics_membership_version_of(p_filters jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := coalesce(nullif(btrim(coalesce(p_filters ->> 'membershipVersion', '')), ''), 'analytics/1');
begin
  if v !~ '^analytics/[0-9]+$' then
    raise exception 'Not a membership version: %', v using errcode = '22023';
  end if;
  return v;
end;
$$;

revoke all on function public.analytics_membership_version_of(jsonb) from public, anon;
grant execute on function public.analytics_membership_version_of(jsonb) to authenticated;

-- The pot kind filter as the leak readers read it: null, hu, mw or bomb.
create or replace function public.analytics_pot_kind_of(p_filters jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_filters ->> 'potKind', '')), '');
begin
  if v is not null and v not in ('hu', 'mw', 'bomb') then
    raise exception 'Unknown pot kind: %', v using errcode = '22023';
  end if;
  return v;
end;
$$;

revoke all on function public.analytics_pot_kind_of(jsonb) from public, anon;
grant execute on function public.analytics_pot_kind_of(jsonb) to authenticated;

-- analytics_checker(p_filters) -> {
--   analysisVersion, membershipVersion,
--   hands     -- hands in scope with rows at the membership version
--   pending   -- hands analysed at the version still without them (unfiltered)
--   groups: [{ stat, spot, size, handClass,
--              opps, oppsTaken,      -- every member decision, and those that took the class
--              n, taken,             -- of them, the analysed ones (the target's sample)
--              refShare,             -- Σ reference share of the class over the n
--              evHigh,               -- Σ EV loss of the n that took the class (too much)
--              evLow,                -- Σ EV loss of the n that did not, the best option in the class (too little)
--              hands }]              -- distinct hands in the group
-- }   groups ordered by (stat, spot, size, handClass), byte order.
create or replace function public.analytics_checker(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
  q       public.analysis_filter;
  v_mv    text;
  v_kind  text;
  v_out   jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  q := public.analysis_filter_of(p_filters);
  v_mv := public.analytics_membership_version_of(p_filters);
  v_kind := public.analytics_pot_kind_of(p_filters);

  with r as materialized (
    select r.hand_id, r.stat, r.spot, r.size, r.hand_class, r.taken, r.ref_share, r.best_in, r.ev_loss_bb
    from public.analysis_checker_rows r
    where r.owner_id = v_owner and r.analysis_version = q.version and r.membership_version = v_mv
      and (q.from_at is null or r.played_at >= q.from_at)
      and (q.to_at is null or r.played_at < q.to_at)
      and (q.site is null or r.site = q.site)
      and (q.formats is null or r.game_format = any (q.formats))
      and (q.currency is null or r.currency = q.currency)
      and (q.big_blind is null or r.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and r.hero_position = q."position"))
      and (q.pot_type is null or r.pot_type = q.pot_type)
      and (q.hands is null or r.hand_id = any (q.hands))
      and (v_kind is null
           or (v_kind = 'hu' and r.pot_type <> 'bomb' and not r.multiway)
           or (v_kind = 'mw' and r.pot_type <> 'bomb' and r.multiway)
           or (v_kind = 'bomb' and r.pot_type = 'bomb'))
  )
  select jsonb_build_object(
    'analysisVersion', q.version,
    'membershipVersion', v_mv,
    'hands', (
      select count(*)::bigint from public.analysis_checker_hands c
      where c.owner_id = v_owner and c.analysis_version = q.version and c.membership_version = v_mv
        and (q.from_at is null or c.played_at >= q.from_at)
        and (q.to_at is null or c.played_at < q.to_at)
        and (q.site is null or c.site = q.site)
        and (q.formats is null or c.game_format = any (q.formats))
        and (q.currency is null or c.currency = q.currency)
        and (q.big_blind is null or c.big_blind = q.big_blind)
        and (q."position" is null or (q."position" <> '' and c.hero_position = q."position"))
        and (q.pot_type is null or c.pot_type = q.pot_type)
        and (q.hands is null or c.hand_id = any (q.hands))
        and (v_kind is null or (v_kind = 'bomb') = (c.pot_type = 'bomb'))),
    'pending', greatest(0,
      coalesce((select sum(m.hands) from public.analysis_month_hands m
                where m.owner_id = v_owner and m.analysis_version = q.version), 0)
      - (select count(*) from public.analysis_checker_hands c
         where c.owner_id = v_owner and c.analysis_version = q.version and c.membership_version = v_mv))::bigint,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'stat',      x.stat,
               'spot',      x.spot,
               'size',      x.size,
               'handClass', x.hand_class,
               'opps',      x.opps,
               'oppsTaken', x.opps_taken,
               'n',         x.n,
               'taken',     x.taken,
               'refShare',  x.ref_share,
               'evHigh',    x.ev_high,
               'evLow',     x.ev_low,
               'hands',     x.hands)
             order by x.stat collate "C", x.spot collate "C", x.size collate "C", x.hand_class collate "C")
      from (
        select stat, spot, size, hand_class,
               count(*)::bigint as opps,
               count(*) filter (where taken)::bigint as opps_taken,
               count(*) filter (where ref_share is not null)::bigint as n,
               count(*) filter (where ref_share is not null and taken)::bigint as taken,
               round(coalesce(sum(ref_share), 0), 6)::float8 as ref_share,
               round(coalesce(sum(ev_loss_bb) filter (where ref_share is not null and taken), 0), 3)::float8 as ev_high,
               round(coalesce(sum(ev_loss_bb) filter (where ref_share is not null and not taken and best_in), 0), 3)::float8
                 as ev_low,
               count(distinct hand_id)::bigint as hands
        from r
        group by stat, spot, size, hand_class
      ) x), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;

comment on function public.analytics_checker(jsonb) is
  'Analytics Step 2: the caller''s checker sums per (stat, spot, size bucket, hand class) over the analysed '
  'decisions in the analysis filters'' scope (+ potKind, membershipVersion): n, taken, Σ reference share, '
  'Σ EV loss too much / too little, hands.';

revoke all on function public.analytics_checker(jsonb) from public, anon;
grant execute on function public.analytics_checker(jsonb) to authenticated;

-- analytics_checker_examples(p_filters, p_stat, p_spot, p_size, p_hand_class, p_side, p_limit) -> {
--   rows: [{ handId, ord, actionIndex, playedAt, site, stat, spot, size, handClass, taken, bestIn,
--            refShare, evLossBb, facingPot, cards, board }]
-- }  the analysed decisions of one stat (narrowed by spot, size and hand class when given), the
--    costliest first. p_side: 'high' (took the class: "too much"), 'low' (did not, the best option
--    in the class: "too little") or 'any'.
create or replace function public.analytics_checker_examples(
  p_filters    jsonb,
  p_stat       text,
  p_spot       text    default null,
  p_size       text    default null,
  p_hand_class text    default null,
  p_side       text    default 'high',
  p_limit      integer default 20
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
  q       public.analysis_filter;
  v_mv    text;
  v_kind  text;
  v_side  text := coalesce(nullif(btrim(coalesce(p_side, '')), ''), 'high');
  v_out   jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_stat is null or p_stat !~ '^[a-z][a-z0-9_]{0,47}$' then
    raise exception 'analytics_checker_examples needs a stat.' using errcode = '22023';
  end if;
  if v_side not in ('high', 'low', 'any') then
    raise exception 'Unknown side: %', v_side using errcode = '22023';
  end if;
  q := public.analysis_filter_of(p_filters);
  v_mv := public.analytics_membership_version_of(p_filters);
  v_kind := public.analytics_pot_kind_of(p_filters);

  with x as (
    select r.hand_id, r.ord, r.action_index, r.played_at, r.site, r.stat, r.spot, r.size, r.hand_class,
           r.taken, r.best_in, r.ref_share, r.ev_loss_bb
    from public.analysis_checker_rows r
    where r.owner_id = v_owner and r.analysis_version = q.version and r.stat = p_stat
      and r.membership_version = v_mv and r.ref_share is not null
      and (p_spot is null or r.spot = p_spot)
      and (p_size is null or r.size = p_size)
      and (p_hand_class is null or r.hand_class = p_hand_class)
      and (v_side = 'any' or (v_side = 'high' and r.taken) or (v_side = 'low' and not r.taken and r.best_in))
      and (q.from_at is null or r.played_at >= q.from_at)
      and (q.to_at is null or r.played_at < q.to_at)
      and (q.site is null or r.site = q.site)
      and (q.formats is null or r.game_format = any (q.formats))
      and (q.currency is null or r.currency = q.currency)
      and (q.big_blind is null or r.big_blind = q.big_blind)
      and (q."position" is null or (q."position" <> '' and r.hero_position = q."position"))
      and (q.pot_type is null or r.pot_type = q.pot_type)
      and (q.hands is null or r.hand_id = any (q.hands))
      and (v_kind is null
           or (v_kind = 'hu' and r.pot_type <> 'bomb' and not r.multiway)
           or (v_kind = 'mw' and r.pot_type <> 'bomb' and r.multiway)
           or (v_kind = 'bomb' and r.pot_type = 'bomb'))
    order by r.ev_loss_bb desc, r.played_at desc nulls last, r.hand_id, r.ord
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  )
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
           'handId',      x.hand_id,
           'ord',         x.ord,
           'actionIndex', x.action_index,
           'playedAt',    x.played_at,
           'site',        x.site,
           'stat',        x.stat,
           'spot',        x.spot,
           'size',        x.size,
           'handClass',   x.hand_class,
           'taken',       x.taken,
           'bestIn',      x.best_in,
           'refShare',    x.ref_share::float8,
           'evLossBb',    x.ev_loss_bb::float8,
           'facingPot',   d.facts -> 'facingPot',
           'cards',       coalesce(d.facts -> 'holeCards', '[]'::jsonb),
           'board',       coalesce(d.facts -> 'board', '[]'::jsonb))
         order by x.ev_loss_bb desc, x.played_at desc nulls last, x.hand_id, x.ord), '[]'::jsonb))
  into v_out
  from x
  left join public.decision_analysis d
    on d.hand_id = x.hand_id and d.analysis_version = q.version and d.ord = x.ord and d.owner_id = v_owner;
  return v_out;
end;
$$;

comment on function public.analytics_checker_examples(jsonb, text, text, text, text, text, integer) is
  'Analytics Step 2: the caller''s costliest analysed decisions of one stat (by spot, size, hand class; '
  'side high / low / any), with cards, board and size.';

revoke all on function public.analytics_checker_examples(jsonb, text, text, text, text, text, integer) from public, anon;
grant execute on function public.analytics_checker_examples(jsonb, text, text, text, text, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Pro, and the account's data
-- ---------------------------------------------------------------------------

insert into public.entitlement_gates (function_sig, feature, note) values
  ('public.analytics_rows_save(jsonb)', 'analysis', 'Analytics: the checker rows'' writer'),
  ('public.analytics_rows_pending(text,text,uuid,integer)', 'analysis', 'Analytics: the checker rows'' backfill'),
  ('public.analytics_checker(jsonb)', 'analysis', 'Analytics: the stat checker''s sums'),
  ('public.analytics_checker_examples(jsonb,text,text,text,text,text,integer)', 'analysis', 'Analytics: the stat checker''s examples')
on conflict (function_sig) do update set feature = excluded.feature, note = excluded.note;

select public.entitlement_gates_apply();

insert into public.account_data_inventory
  (name, kind, owner_columns, export, export_file, export_reader, export_section, export_key, export_omit, on_delete, note)
values
  ('public.analysis_checker_hands', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of decision_analysis: which hands have Analytics checker rows.'),
  ('public.analysis_checker_rows', 'table', '{owner_id}', 'derived', null, null, null, null, '{}', 'cascade',
   'Summary of decision_analysis: the Analytics checker''s rows.')
on conflict (name) do nothing;
