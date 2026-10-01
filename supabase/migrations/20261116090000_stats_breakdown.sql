-- ===========================================================================
-- stats_breakdown: the same report, split by one dimension (F13 / M3, #48)
-- ===========================================================================
--
-- `stats_summary` answers "how do I play"; this answers "where": by position,
-- by table size, by stakes, by stack depth, by room, and by starting hand --
-- the last one being what the 13x13 matrix on `/stats` is drawn from.
--
-- **No derivation change.** Every dimension here is already a column on the
-- hero row, stored in M1 for exactly this; the split is a `group by`.
--
-- ## The group key is whitelisted, never interpolated
--
-- `p_group` picks one expression out of a fixed `case`, the same discipline as
-- `v_order` in `search_hands`. An unknown key is a 22023, not a fallback: a
-- typo in a client should be loud, and there is no input for which the right
-- answer is "group by whatever the caller sent". The expression is then
-- `format()`ed into the query as `%s` -- safe *only* because every possible
-- value of it is a literal written in this file. Nothing from `p_filters`
-- reaches the SQL text; those are bound as `$1..$20` exactly as in
-- `stats_summary`, through the one shared `hand_stats_filter_sql()`.
--
-- ## A subset of the counters, on purpose
--
-- A breakdown row is a table cell, not a HUD. It carries the dozen counters a
-- per-position or per-hand table actually shows (VPIP, PFR, RFI, 3-bet, fold
-- to 3-bet, steal, flop cbet, WTSD, W$SD, WWSF) plus the money, and the client
-- divides with the same `rates()` the HUD uses. Ninety columns times thirteen
-- squared cells is a payload nobody reads.
--
-- ## Money: the same two refusals as `stats_summary`
--
-- Chips mixed with cash: no money at all, not even bb (a big blind of chips is
-- not a unit of the same game as a big blind of dollars). Mixed currency: the
-- bb figure survives, the minor-unit total does not.
-- ===========================================================================

begin;

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
            hint = 'One of position, table_size, site, stakes, hand_class, stack_bb.';
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

revoke all on function public.stats_breakdown(jsonb, text) from public;
revoke execute on function public.stats_breakdown(jsonb, text) from anon;
grant execute on function public.stats_breakdown(jsonb, text) to authenticated;

comment on function public.stats_breakdown(jsonb, text) is
  'The caller''s hero rows split by one whitelisted dimension (position, table_size, '
  'site, stakes, hand_class, stack_bb), same filters and money refusals as stats_summary.';

commit;
