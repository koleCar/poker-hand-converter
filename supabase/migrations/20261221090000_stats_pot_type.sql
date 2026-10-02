-- ===========================================================================
-- stats/2: the pot type, and a breakdown by it (F13)
-- ===========================================================================
--
-- `pot_type` is what the hand became preflop — limped, single-raised, 3-bet,
-- 4-bet+, or a walk or bomb pot — and it is the split players reach for first
-- after position ("I lose in 3-bet pots"). M3 left it out because it was not
-- on the row; it is now, derived in `lib/stats` (`potTypeOf`).
--
-- Nullable, because rows derived under stats/1 do not have it. They do not
-- need to: `STATS_VERSION` moves to stats/2, every library reads as stale,
-- and the statistics screen re-derives it on its own (`stats_coverage`,
-- `hands_needing_stats`, `POST /api/stats/rebuild`), pruning the stats/1 rows
-- on the last slice. This migration is the first real run of that path.
--
-- `save_hand_stats` names its columns, so it is redefined to carry the new
-- one; `stats_breakdown` gains the group. Both are otherwise unchanged.
-- ===========================================================================

begin;

alter table public.hand_stats add column if not exists pot_type text;
alter table public.hand_stats drop constraint if exists hand_stats_pot_type_ok;
alter table public.hand_stats add constraint hand_stats_pot_type_ok
  check (pot_type is null or pot_type in ('walk', 'bomb', 'limped', 'single-raised', '3bet', '4bet+'));

comment on column public.hand_stats.pot_type is
  'stats/2: what the pot became preflop (walk, bomb, limped, single-raised, 3bet, 4bet+). Null on stats/1 rows.';

create or replace function public.save_hand_stats(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
  v_resolved integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_stats expects a JSON array of stats rows'
      using errcode = '22023';
  end if;

  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object('received', 0, 'inserted', 0, 'duplicates', 0, 'skipped', 0);
  end if;
  if v_received > 1000 then
    raise exception 'save_hand_stats accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_populate_recordset(null::public.hand_stats, p_rows)
  ),
  deduped as (
    select distinct on (hand_key, stats_version, seat) *
    from input
    where hand_key is not null and btrim(hand_key) <> ''
    order by hand_key, stats_version, seat
  ),
  resolved as (
    -- RLS on `public.hands` is the ownership check. `(owner_id, hand_key)` is
    -- unique, so this is at most one row per input.
    select d.*, h.id as resolved_hand_id
    from deduped d
    join public.hands h on h.hand_key = d.hand_key
  ),
  ins as (
    insert into public.hand_stats (
      hand_id, owner_id, stats_version, seat, hand_key, site_id, site_hand_id,
      played_at, variant, limit_type, game_format, site_anonymization,
      currency, currency_minor_units, small_blind, big_blind, player_count,
      max_seats, table_name, tournament_id, fast_fold, has_straddle,
      is_bomb_pot, is_big_blind_ante, is_run_it_twice, has_cashout, is_walk,
      street_reached, pot_type, total_pot, house_into_pot, fees, player, is_hero,
      position, hole_cards, hand_class, starting_stack,
      starting_stack_bb_tenths, hands, vpip_opp, vpip, pfr_opp, pfr, rfi_opp,
      rfi, iso_opp, iso, limp_opp, limp, cold_call_opp, cold_call,
      three_bet_opp, three_bet, four_bet_opp, four_bet, five_bet_opp,
      five_bet, squeeze_opp, squeeze, steal_opp, steal, fold_to_steal_opp,
      fold_to_steal, call_steal, three_bet_vs_steal, fold_to_three_bet_opp,
      fold_to_three_bet, call_three_bet, raise_vs_three_bet,
      fold_to_four_bet_opp, fold_to_four_bet, call_four_bet,
      raise_vs_four_bet, flop_seen, turn_seen, river_seen, cbet_flop_opp,
      cbet_flop, cbet_turn_opp, cbet_turn, cbet_river_opp, cbet_river,
      fold_to_cbet_flop_opp, fold_to_cbet_flop, call_cbet_flop,
      raise_cbet_flop, fold_to_cbet_turn_opp, fold_to_cbet_turn,
      call_cbet_turn, raise_cbet_turn, fold_to_cbet_river_opp,
      fold_to_cbet_river, call_cbet_river, raise_cbet_river, donk_flop_opp,
      donk_flop, donk_turn_opp, donk_turn, donk_river_opp, donk_river,
      check_raise_flop_opp, check_raise_flop, check_raise_turn_opp,
      check_raise_turn, check_raise_river_opp, check_raise_river, bet_flop,
      raise_flop, call_flop, check_flop, fold_flop, bet_turn, raise_turn,
      call_turn, check_turn, fold_turn, bet_river, raise_river, call_river,
      check_river, fold_river, wwsf_opp, wwsf, wtsd_opp, wtsd, wsd_opp, wsd,
      cashed_out, won, contributed, net, net_bb_milli, rake_paid, out_of_pot,
      cashout_risk
    )
    select
      r.resolved_hand_id, v_owner, r.stats_version, r.seat, r.hand_key,
      r.site_id, r.site_hand_id, r.played_at, r.variant, r.limit_type,
      r.game_format, r.site_anonymization, r.currency, r.currency_minor_units,
      r.small_blind, r.big_blind, r.player_count, r.max_seats, r.table_name,
      r.tournament_id, r.fast_fold, r.has_straddle, r.is_bomb_pot,
      r.is_big_blind_ante, r.is_run_it_twice, r.has_cashout, r.is_walk,
      r.street_reached, r.pot_type, r.total_pot, r.house_into_pot, r.fees, r.player,
      r.is_hero, r.position, r.hole_cards, r.hand_class, r.starting_stack,
      r.starting_stack_bb_tenths, r.hands, r.vpip_opp, r.vpip, r.pfr_opp,
      r.pfr, r.rfi_opp, r.rfi, r.iso_opp, r.iso, r.limp_opp, r.limp,
      r.cold_call_opp, r.cold_call, r.three_bet_opp, r.three_bet,
      r.four_bet_opp, r.four_bet, r.five_bet_opp, r.five_bet, r.squeeze_opp,
      r.squeeze, r.steal_opp, r.steal, r.fold_to_steal_opp, r.fold_to_steal,
      r.call_steal, r.three_bet_vs_steal, r.fold_to_three_bet_opp,
      r.fold_to_three_bet, r.call_three_bet, r.raise_vs_three_bet,
      r.fold_to_four_bet_opp, r.fold_to_four_bet, r.call_four_bet,
      r.raise_vs_four_bet, r.flop_seen, r.turn_seen, r.river_seen,
      r.cbet_flop_opp, r.cbet_flop, r.cbet_turn_opp, r.cbet_turn,
      r.cbet_river_opp, r.cbet_river, r.fold_to_cbet_flop_opp,
      r.fold_to_cbet_flop, r.call_cbet_flop, r.raise_cbet_flop,
      r.fold_to_cbet_turn_opp, r.fold_to_cbet_turn, r.call_cbet_turn,
      r.raise_cbet_turn, r.fold_to_cbet_river_opp, r.fold_to_cbet_river,
      r.call_cbet_river, r.raise_cbet_river, r.donk_flop_opp, r.donk_flop,
      r.donk_turn_opp, r.donk_turn, r.donk_river_opp, r.donk_river,
      r.check_raise_flop_opp, r.check_raise_flop, r.check_raise_turn_opp,
      r.check_raise_turn, r.check_raise_river_opp, r.check_raise_river,
      r.bet_flop, r.raise_flop, r.call_flop, r.check_flop, r.fold_flop,
      r.bet_turn, r.raise_turn, r.call_turn, r.check_turn, r.fold_turn,
      r.bet_river, r.raise_river, r.call_river, r.check_river, r.fold_river,
      r.wwsf_opp, r.wwsf, r.wtsd_opp, r.wtsd, r.wsd_opp, r.wsd, r.cashed_out,
      r.won, r.contributed, r.net, r.net_bb_milli, r.rake_paid, r.out_of_pot,
      r.cashout_risk
    from resolved r
    -- Villain rows for a positionally anonymised room are refused here as well
    -- as by `hand_stats_positional_anonymity`, so a client that sends them gets
    -- them dropped rather than the whole batch rejected. The constraint is what
    -- makes it impossible; this is what makes it survivable.
    where r.is_hero or r.site_anonymization <> 'positional'
    on conflict (hand_id, stats_version, seat) do nothing
    returning 1
  )
  select (select count(*) from resolved)::integer,
         (select count(*) from ins)::integer
    into v_resolved, v_inserted;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   coalesce(v_inserted, 0),
    -- Rows whose hand was found but that were already stored.
    'duplicates', coalesce(v_resolved, 0) - coalesce(v_inserted, 0),
    -- Rows naming a hand this caller does not have. Not an error: a client that
    -- derives statistics for a batch it then fails to save should report a
    -- number, not throw.
    'skipped',    v_received - coalesce(v_resolved, 0)
  );
end;
$$;

create or replace function public.stats_breakdown(
  p_filters jsonb default '{}'::jsonb,
  p_group   text  default 'position'
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
  v_key      text;
  v_head     jsonb;
  v_rows     jsonb;
  v_mixed_currency boolean;
  v_mixed_kind     boolean;
begin
  -- The whitelist. Each branch is a literal; see the header.
  v_key := case p_group
    when 'position'   then 'hs.position'
    when 'table_size' then 'hs.player_count::text'
    when 'site'       then 'hs.site_id'
    when 'stakes'     then $k$hs.currency || ':' || coalesce(hs.small_blind::text, '') || ':' || coalesce(hs.big_blind::text, '')$k$
    when 'hand_class' then 'hs.hand_class'
    -- stats/2: limped, single-raised, 3bet, 4bet+, walk, bomb.
    when 'pot_type'   then 'hs.pot_type'
    -- The hero's own stack in big blinds, in the bands a cash player thinks
    -- in. Not *effective* stack -- that needs every opponent's stack at the
    -- moment of each decision, which is a derivation change and belongs to
    -- the villain-rows milestone.
    when 'stack_bb'   then $k$case
        when hs.starting_stack_bb_tenths is null then null
        when hs.starting_stack_bb_tenths <  200  then '0-20'
        when hs.starting_stack_bb_tenths <  400  then '20-40'
        when hs.starting_stack_bb_tenths <  700  then '40-70'
        when hs.starting_stack_bb_tenths < 1000  then '70-100'
        when hs.starting_stack_bb_tenths < 1500  then '100-150'
        when hs.starting_stack_bb_tenths < 2500  then '150-250'
        else '250+' end$k$
    else null
  end;
  if v_key is null then
    raise exception 'stats_breakdown: unknown group "%"', p_group
      using errcode = '22023',
            hint = 'One of position, table_size, site, stakes, hand_class, stack_bb, pot_type.';
  end if;

  if v_owner is null then
    return jsonb_build_object('statsVersion', v_version, 'group', p_group, 'rows', '[]'::jsonb,
                              'mixedCurrency', false, 'mixedUnitKind', false,
                              'currency', null, 'currencyMinorUnits', null);
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

  -- Pass 1: is the whole sample one unit? Decides what money survives.
  execute format($q$
    select jsonb_build_object(
      'currency_count',  count(distinct hs.currency),
      'unit_kind_count', count(distinct (hs.game_format = 'cash')),
      'currency',        min(hs.currency),
      'minor_units',     min(hs.currency_minor_units))
    from public.hand_stats hs
    %1$s
  $q$, v_where)
    into v_head
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts;

  v_mixed_currency := coalesce((v_head ->> 'currency_count')::integer, 0) > 1;
  v_mixed_kind     := coalesce((v_head ->> 'unit_kind_count')::integer, 0) > 1;

  -- Pass 2: the split. `to_jsonb(t)` over an explicit projection, the shape
  -- every report in this schema uses.
  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(t) order by t.hands desc, t.key), '[]'::jsonb) from (
      select
        %2$s                                                  as key,
        coalesce(sum(hs.hands), 0)::bigint                    as hands,
        count(*) filter (where $20::boolean or not hs.has_cashout)::bigint as money_hands,
        coalesce(sum(hs.vpip_opp), 0)::bigint                 as vpip_opp,
        coalesce(sum(hs.vpip), 0)::bigint                     as vpip,
        coalesce(sum(hs.pfr_opp), 0)::bigint                  as pfr_opp,
        coalesce(sum(hs.pfr), 0)::bigint                      as pfr,
        coalesce(sum(hs.rfi_opp), 0)::bigint                  as rfi_opp,
        coalesce(sum(hs.rfi), 0)::bigint                      as rfi,
        coalesce(sum(hs.three_bet_opp), 0)::bigint            as three_bet_opp,
        coalesce(sum(hs.three_bet), 0)::bigint                as three_bet,
        coalesce(sum(hs.fold_to_three_bet_opp), 0)::bigint    as fold_to_three_bet_opp,
        coalesce(sum(hs.fold_to_three_bet), 0)::bigint        as fold_to_three_bet,
        coalesce(sum(hs.steal_opp), 0)::bigint                as steal_opp,
        coalesce(sum(hs.steal), 0)::bigint                    as steal,
        coalesce(sum(hs.cbet_flop_opp), 0)::bigint            as cbet_flop_opp,
        coalesce(sum(hs.cbet_flop), 0)::bigint                as cbet_flop,
        coalesce(sum(hs.wtsd_opp), 0)::bigint                 as wtsd_opp,
        coalesce(sum(hs.wtsd), 0)::bigint                     as wtsd,
        coalesce(sum(hs.wsd_opp), 0)::bigint                  as wsd_opp,
        coalesce(sum(hs.wsd), 0)::bigint                      as wsd,
        coalesce(sum(hs.wwsf_opp), 0)::bigint                 as wwsf_opp,
        coalesce(sum(hs.wwsf), 0)::bigint                     as wwsf,
        coalesce(sum(hs.net_bb_milli) filter (where $20::boolean or not hs.has_cashout), 0)::bigint as net_bb_milli,
        coalesce(sum(hs.net) filter (where $20::boolean or not hs.has_cashout), 0)::bigint         as net
      from public.hand_stats hs
      %1$s
      group by 1
    ) t
  $q$, v_where, v_key)
    into v_rows
    using v_owner, v_version, v_from, v_to, v_site, v_variant, v_limit, v_format,
          v_currency, v_big_blind, v_positions, v_classes, v_tourney, v_fast,
          v_fast_only, v_min_players, v_max_players, v_bomb, v_straddle, v_cashouts;

  if v_mixed_kind then
    v_rows := (select coalesce(jsonb_agg(r - 'net' - 'net_bb_milli'), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r);
  elsif v_mixed_currency then
    v_rows := (select coalesce(jsonb_agg(r - 'net'), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r);
  end if;

  return jsonb_build_object(
    'statsVersion',       v_version,
    'group',              p_group,
    'rows',               v_rows,
    'mixedCurrency',      v_mixed_currency,
    'mixedUnitKind',      v_mixed_kind,
    'currency',           case when v_mixed_currency or v_mixed_kind then null else v_head ->> 'currency' end,
    'currencyMinorUnits', case when v_mixed_currency or v_mixed_kind then null else (v_head ->> 'minor_units')::integer end
  );
end;
$$;

commit;
