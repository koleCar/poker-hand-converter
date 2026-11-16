-- ============================================================================
-- Reports over the Hands list's whole filter (2026-11-16, the owner: "one
-- filter everywhere, app and web").
-- ============================================================================
--
-- Until now a web report summed by the groups `hero_rollups` keeps - the
-- dates, the room, the format, variant, limit, table size, stake and the
-- hero's position - so the web's Reports offered those filters only, where
-- the Hands list offers many more (pot type, result, stack, all-in, the
-- hero's cards and class, the board, a player, showdown, the table's name,
-- the smallest pot, showdown and winning positions, the names).
--
-- * `library_where` - library_page's predicates, moved out of it into one
--   function, so the list and the reports read a filter the same way.
-- * `library_beyond_rollups` - whether a filter sets a group the summaries
--   cannot answer.
-- * `report_hand_ids` - the reader's hands of such a filter (null when it
--   sets none).
-- * `report_open`, `report_graph`, `report_situations` - when
--   `report_hand_ids` is not null, the rollups are left out and every hero
--   row of those hands is read (`hand_stats` for the sums,
--   `hero_report_rows` for the graph's cuts, the situations and the EV
--   lookups). Everything else is as it was; with no such group the plans
--   and the answers are unchanged.
--
-- The functions run with `plan_cache_mode = force_custom_plan`, so the id
-- list is a constant in each plan and `= any` hashes it.

create or replace function public.library_where(p_filter jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_where text := '';
begin
  if p_filter ? 'from' and coalesce(p_filter ->> 'from', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at >= ($1 ->> 'from')::timestamptz$w$;
  end if;
  if p_filter ? 'to' and coalesce(p_filter ->> 'to', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at < ($1 ->> 'to')::timestamptz$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'heroCards')) > 0 then
    v_where := v_where || $w$ and h.hero_cards @> public.library_list($1, 'heroCards')$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'heroHandClasses')) > 0 then
    v_where := v_where || $w$ and h.hero_hand_class = any (public.library_list($1, 'heroHandClasses'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'board')) > 0 then
    v_where := v_where || $w$ and h.board_cards @> public.library_list($1, 'board')$w$;
  end if;
  if coalesce(btrim(p_filter ->> 'player'), '') <> '' then
    v_where := v_where || $w$ and btrim($1 ->> 'player') = any (h.player_names)$w$;
  end if;
  if jsonb_typeof(p_filter -> 'showdown') = 'boolean' then
    v_where := v_where || $w$ and h.went_to_showdown = ($1 ->> 'showdown')::boolean$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'sites')) > 0 then
    v_where := v_where || $w$ and h.site = any (public.library_list($1, 'sites'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'formats')) > 0 then
    v_where := v_where || $w$ and h.game_format::text = any (public.library_list($1, 'formats'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'variants')) > 0 then
    v_where := v_where || $w$ and coalesce(h.variant, '') = any (public.library_list($1, 'variants'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'limits')) > 0 then
    v_where := v_where || $w$ and coalesce(h.limit_type, '') = any (public.library_list($1, 'limits'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'sizes')) > 0 then
    v_where := v_where || $w$ and public.library_size(h.max_seats, h.player_count) = any (public.library_list($1, 'sizes'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'stakes')) > 0 then
    v_where := v_where || $w$ and public.library_stake(h.game_format, h.currency, h.big_blind) = any (public.library_list($1, 'stakes'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'positions')) > 0 then
    v_where := v_where || $w$ and coalesce(h.hero_position, '') = any (public.library_list($1, 'positions'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'potTypes')) > 0 then
    v_where := v_where || $w$ and coalesce(hs.pot_type, '') = any (public.library_list($1, 'potTypes'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'results')) > 0 then
    v_where := v_where || $w$ and public.library_result(h.hero_profit) = any (public.library_list($1, 'results'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'stacks')) > 0 then
    v_where := v_where || $w$ and public.library_stack(hs.starting_stack_bb_tenths) = any (public.library_list($1, 'stacks'))$w$;
  end if;
  if coalesce(btrim(p_filter ->> 'tableName'), '') <> '' then
    v_where := v_where || $w$ and h.table_name ilike '%' || regexp_replace(btrim($1 ->> 'tableName'), '([%_\\])', '\\\1', 'g') || '%'$w$;
  end if;
  if jsonb_typeof(p_filter -> 'minPot') = 'number' then
    v_where := v_where || $w$ and h.total_pot >= ($1 ->> 'minPot')::numeric * h.currency_minor_units$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'showdownPositions')) > 0 then
    v_where := v_where || $w$ and h.showdown_positions && public.library_list($1, 'showdownPositions')$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'winnerPositions')) > 0 then
    v_where := v_where || $w$ and h.winner_positions && public.library_list($1, 'winnerPositions')$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'anonymizations')) > 0 then
    v_where := v_where || $w$ and h.site_anonymization::text = any (public.library_list($1, 'anonymizations'))$w$;
  end if;
  if jsonb_typeof(p_filter -> 'allIn') = 'boolean' then
    v_where := v_where || $w$ and coalesce(e.applicable, false) = ($1 ->> 'allIn')::boolean$w$;
  end if;

  return v_where;
end;
$fn$;

comment on function public.library_where(jsonb) is
  'The Hands list''s predicates for a filter, as SQL over hands h, hand_stats hs (the hero''s row) and hand_stats_ev e reading the filter as $1: library_page''s, and the reports'' hands (report_hand_ids). One definition, 2026-11-16.';

create or replace function public.library_beyond_rollups(p_filter jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(cardinality(public.library_list(p_filter, 'potTypes')) > 0
      or cardinality(public.library_list(p_filter, 'results')) > 0
      or cardinality(public.library_list(p_filter, 'stacks')) > 0
      or cardinality(public.library_list(p_filter, 'heroCards')) > 0
      or cardinality(public.library_list(p_filter, 'heroHandClasses')) > 0
      or cardinality(public.library_list(p_filter, 'board')) > 0
      or coalesce(btrim(p_filter ->> 'player'), '') <> ''
      or jsonb_typeof(p_filter -> 'showdown') = 'boolean'
      or coalesce(btrim(p_filter ->> 'tableName'), '') <> ''
      or jsonb_typeof(p_filter -> 'minPot') = 'number'
      or cardinality(public.library_list(p_filter, 'showdownPositions')) > 0
      or cardinality(public.library_list(p_filter, 'winnerPositions')) > 0
      or cardinality(public.library_list(p_filter, 'anonymizations')) > 0
      or jsonb_typeof(p_filter -> 'allIn') = 'boolean', false)
$fn$;

comment on function public.library_beyond_rollups(jsonb) is
  'Whether a filter sets a group the report summaries do not sum by (anything but the dates, the segment and the hero''s position).';

create or replace function public.report_hand_ids(p_filter jsonb)
returns uuid[]
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $fn$
declare
  v_owner  uuid  := (select auth.uid());
  v_filter jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_ids    uuid[];
begin
  if v_owner is null or not public.library_beyond_rollups(v_filter) then
    return null;
  end if;
  execute format($q$
    select coalesce(array_agg(h.id), '{}'::uuid[])
    from public.hands h
    left join public.hand_stats hs
      on hs.hand_id = h.id and hs.owner_id = $4 and hs.is_hero
     and hs.stats_version = coalesce(nullif(btrim(coalesce($1 ->> 'statsVersion', '')), ''), 'stats/1')
    left join public.hand_stats_ev e
      on e.hand_id = h.id and e.owner_id = $4 and e.seat = hs.seat
     and e.ev_version = coalesce(nullif(btrim(coalesce($1 ->> 'evVersion', '')), ''), 'ev/1')
    where h.owner_id = $4%s
  $q$, public.library_where(v_filter - array['sites', 'formats', 'variants', 'limits', 'sizes', 'stakes', 'positions']))
  into v_ids
  using v_filter, null::jsonb, null::integer, v_owner;
  return v_ids;
end;
$fn$;

comment on function public.report_hand_ids(jsonb) is
  'The reader''s hands a report filter lists when it sets a group beyond the rollups'' (library_where, the Hands list''s own predicates, over the hand-level groups and the dates: the segment and the position stay the reports'' own predicates); null when it sets none (the summaries answer).';

revoke all on function public.library_where(jsonb) from public, anon;
grant execute on function public.library_where(jsonb) to authenticated;
revoke all on function public.library_beyond_rollups(jsonb) from public, anon;
grant execute on function public.library_beyond_rollups(jsonb) to authenticated;
revoke all on function public.report_hand_ids(jsonb) from public, anon;
grant execute on function public.report_hand_ids(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- library_page: its predicates are library_where's (unchanged otherwise).
-- ---------------------------------------------------------------------------

create or replace function public.library_page(
  p_filter jsonb default '{}'::jsonb,
  p_after  jsonb default null,
  p_limit  integer default 100
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
  v_where := v_where || public.library_where(v_filter);

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
  using v_filter, p_after, v_limit, v_owner;

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
$$;

-- ---------------------------------------------------------------------------
-- The reports: unchanged but for v_ids (rollups left out, every hero row of
-- the listed hands read instead).
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
  v_ids       uuid[];
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
  -- A group beyond the rollups' (2026-11-16): exactly the Hands list's hands.
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
        and v_ids is null
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
          and (v_ids is not null or v_from is not null or v_to is not null)
          and (v_ids is not null or (x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
               and x.played_at < coalesce(v_to, 'infinity'::timestamptz)))
          and (v_ids is not null or not (x.played_at >= v_from_at and x.played_at < v_to_at))
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
          and (v_ids is null or x.hand_id = any (v_ids))
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
        and (v_ids is null or r.hand_id = any (v_ids))
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
  v_ids       uuid[];
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
  -- A group beyond the rollups' (2026-11-16): exactly the Hands list's hands.
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
        and v_ids is null
        and r.kind = any (v_kinds)
        union all
        select sum(x.hands) as n, sum(x.hands) filter (where (v_cashouts or not x.has_cashout)) as money_n, min(x.currency) as min_currency, max(x.currency) as max_currency, min(x.currency_minor_units) as minor, bool_or(x.game_format = 'cash') as any_cash, bool_or(x.game_format <> 'cash') as any_chips
        from public.hand_stats x
        where x.owner_id = v_owner and x.stats_version = v_version and x.is_hero
          and (v_ids is not null or v_from is not null or v_to is not null)
          and (v_ids is not null or (x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
               and x.played_at < coalesce(v_to, 'infinity'::timestamptz)))
          and (v_ids is not null or not (x.played_at >= v_from_at and x.played_at < v_to_at))
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
          and (v_ids is null or x.hand_id = any (v_ids))
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
        and v_ids is null
        and r.kind = any (v_kinds)
        group by 1
        union all
        select coalesce((x.played_at at time zone 'UTC')::date, '-infinity'::date) as day, sum(x.hands) as n, sum(x.hands) filter (where (v_cashouts or not x.has_cashout)) as money_n, sum(x.net_bb_milli) filter (where (v_cashouts or not x.has_cashout)) as net_bb, sum((case when x.wtsd > 0 then x.net_bb_milli else 0 end)) filter (where (v_cashouts or not x.has_cashout)) as sd_bb, sum(x.net) filter (where (v_cashouts or not x.has_cashout)) as net, sum((case when x.wtsd > 0 then x.net else 0 end)) filter (where (v_cashouts or not x.has_cashout)) as sd_net
        from public.hand_stats x
        where x.owner_id = v_owner and x.stats_version = v_version and x.is_hero
          and (v_ids is not null or v_from is not null or v_to is not null)
          and (v_ids is not null or (x.played_at >= coalesce(v_from, '-infinity'::timestamptz)
               and x.played_at < coalesce(v_to, 'infinity'::timestamptz)))
          and (v_ids is not null or not (x.played_at >= v_from_at and x.played_at < v_to_at))
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
          and (v_ids is null or x.hand_id = any (v_ids))
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
        and (v_ids is null or r.hand_id = any (v_ids))
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
        and (v_ids is null or r.hand_id = any (v_ids))
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
        and (v_ids is null or r.hand_id = any (v_ids))
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
        and (v_ids is null or r.hand_id = any (v_ids))
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
        and (v_ids is null or r.hand_id = any (v_ids))
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
  v_ids       uuid[];
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
  -- A group beyond the rollups' (2026-11-16): exactly the Hands list's hands.
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
        and (v_ids is null or r.hand_id = any (v_ids))
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

-- The R6.2 entitlement gate, back in every re-created gated function.
select public.entitlement_gates_apply();
