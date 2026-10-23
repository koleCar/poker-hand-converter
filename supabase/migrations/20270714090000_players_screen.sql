-- ============================================================================
-- The shared Players screen on the web (docs/RAIL-PLAN.md R4.5c-3).
-- ============================================================================
--
-- The desktop app's Players (R2.7c: the opponents of rooms with real screen
-- names, most hands together first, searched by the start of a name; beside
-- the list one opponent's profile) moves into `packages/ui/players/` with a
-- `PlayersSource` per surface. The web's source reads these, as the user
-- under RLS; on the web the opponents exist only while opponent statistics
-- are on (villain rows, opt-in per account, `20261123090000_villain_stats.sql`)
-- and the screen asks for them otherwise. Colours and labels stay the
-- app's (owner's decision, 2026-10-23: no sync); the web's notes are
-- `player_notes` as they are (`set_player_note`, unchanged).
--
--   * `players_list(p_query)` - the list, from `player_stats` (R4.5c-1, kept
--     by triggers): per opponent of a room with real names, the hero's hands
--     with them and the hero's result against them in big blinds, cash and
--     tournament chips apart; the desktop's `Reader::player_list` rules - a
--     case-insensitive prefix of the name, a room, a kind (all / cash /
--     chips), "with a note" (`player_notes`), most hands together first; no
--     result when the list mixes chips with cash; the opaque-id rooms'
--     opponents' hands counted, not listed.
--   * `player_profile(site, player, kind, version)` - one opponent: what
--     `player_stats` holds for them (hands, first and last seen, the hands
--     together and the result per kind) and every counter of their rows of
--     that kind summed - in total and by position, stake, table size and game
--     - read from their villain rows (`hand_stats_villain_idx`), bomb pots
--     out and an EV cashout's money out, as the desktop's rollups; big
--     blinds withheld when chips and cash mix. The client turns the sums into
--     statistics with the shipped definitions (`showStat`), as Reports do.
--   * `player_sites()` - the rooms with listed opponents (the room filter).
--
-- And `/players` is a new top-level route: reserved as a username.
--
-- Invoker functions, `search_path = ''`, executable by `authenticated` only.
-- ============================================================================

begin;

insert into public.username_reservations (username_lower, reason)
values ('players', 'route')
on conflict (username_lower) do nothing;

-- ---------------------------------------------------------------------------
-- 1. The list
-- ---------------------------------------------------------------------------

create or replace function public.players_list(p_query jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
set work_mem = '64MB'
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_query    jsonb := coalesce(p_query, '{}'::jsonb);
  v_version  text := coalesce(nullif(btrim(coalesce(v_query ->> 'statsVersion', '')), ''), 'stats/1');
  v_site     text := nullif(btrim(coalesce(v_query ->> 'site', '')), '');
  v_kind     text := coalesce(nullif(btrim(coalesce(v_query ->> 'kind', '')), ''), 'all');
  v_noted    boolean := case when jsonb_typeof(v_query -> 'noted') = 'boolean' then (v_query ->> 'noted')::boolean end;
  v_limit    integer := least(greatest(coalesce(nullif(btrim(coalesce(v_query ->> 'limit', '')), '')::integer, 200), 1), 500);
  v_pattern  text;
  v_cash     bigint;
  v_chips    bigint;
  v_players  bigint;
  v_matching bigint;
  v_mixed    boolean;
  v_rows     jsonb;
  v_hidden   bigint;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if v_kind not in ('all', 'cash', 'chips') then
    raise exception 'No such game kind: %.', v_kind
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_query ->> 'search', '')), '') is not null then
    v_pattern := replace(replace(replace(lower(btrim(v_query ->> 'search')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- One line per opponent of the room (every segment summed), the kind's
  -- hands together beside it; then the scope's counts and the first rows.
  with lines as materialized (
    select a.*,
           case v_kind when 'cash' then a.cash_hands when 'chips' then a.chips_hands
                       else a.cash_hands + a.chips_hands end as together,
           coalesce(n.note, '') <> '' as has_note
    from (
      select p.site_id as site, p.player,
             coalesce(sum(p.hero_hands) filter (where p.game_format = 'cash'), 0)::bigint as cash_hands,
             coalesce(sum(p.hero_hands) filter (where p.game_format <> 'cash'), 0)::bigint as chips_hands,
             coalesce(sum(p.hero_money_hands) filter (where p.game_format = 'cash'), 0)::bigint as cash_money_hands,
             coalesce(sum(p.hero_net_bb_milli) filter (where p.game_format = 'cash'), 0)::bigint as cash_net_bb_milli,
             coalesce(sum(p.hero_money_hands) filter (where p.game_format <> 'cash'), 0)::bigint as chips_money_hands,
             coalesce(sum(p.hero_net_bb_milli) filter (where p.game_format <> 'cash'), 0)::bigint as chips_net_bb_milli,
             min(p.first_played_at) as first_seen, max(p.last_played_at) as last_seen,
             bool_and(p.seen_exact) as seen_exact
      from public.player_stats p
      where p.owner_id = v_owner
        and p.stats_version = v_version
        and p.site_anonymization = 'none'
        and (v_site is null or p.site_id = v_site)
      group by p.site_id, p.player
    ) a
    left join public.player_notes n
      on n.owner_id = v_owner and n.site = a.site and n.player = a.player
  ),
  matched as (
    select l.* from lines l
    where l.together > 0
      and (v_pattern is null or lower(l.player) like v_pattern)
      and (v_noted is null or l.has_note = v_noted)
  ),
  top as (
    select m.* from matched m
    order by m.together desc, m.player, m.site
    limit v_limit
  )
  select
    (select coalesce(sum(l.cash_hands), 0)::bigint from lines l),
    (select coalesce(sum(l.chips_hands), 0)::bigint from lines l),
    (select count(*) from lines l where l.together > 0),
    (select count(*) from matched),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'site', t.site, 'player', t.player, 'hands', t.together,
              'cashNetBbMilli', t.cash_net_bb_milli, 'chipsNetBbMilli', t.chips_net_bb_milli,
              'cashMoneyHands', t.cash_money_hands, 'chipsMoneyHands', t.chips_money_hands,
              -- A delete touched one of their rows: first and last seen read again.
              'firstPlayedAt', case when t.seen_exact then t.first_seen else s.first_seen end,
              'lastPlayedAt',  case when t.seen_exact then t.last_seen else s.last_seen end,
              'hasNote', t.has_note)
            order by t.together desc, t.player, t.site), '[]'::jsonb)
       from top t
       left join lateral (
         select min(h.played_at) as first_seen, max(h.played_at) as last_seen
         from public.hand_stats h
         where not t.seen_exact
           and h.owner_id = v_owner and h.stats_version = v_version and not h.is_hero
           and h.player = t.player and h.site_id = t.site and not h.is_bomb_pot
           and h.site_anonymization = 'none'
       ) s on true)
  into v_cash, v_chips, v_players, v_matching, v_rows;

  -- The desktop's rule (and `stats_opponents`'): a scope with chips and cash has no result.
  v_mixed := v_kind = 'all' and v_cash > 0 and v_chips > 0;
  v_rows := (select coalesce(jsonb_agg(
               (r - 'cashNetBbMilli' - 'chipsNetBbMilli' - 'cashMoneyHands' - 'chipsMoneyHands')
               || jsonb_build_object(
                    'netBbMilli', case when v_mixed then null
                                       when v_kind = 'cash' then r -> 'cashNetBbMilli'
                                       when v_kind = 'chips' then r -> 'chipsNetBbMilli'
                                       else to_jsonb((r ->> 'cashNetBbMilli')::bigint + (r ->> 'chipsNetBbMilli')::bigint) end,
                    'moneyHands', case v_kind when 'cash' then (r ->> 'cashMoneyHands')::bigint
                                              when 'chips' then (r ->> 'chipsMoneyHands')::bigint
                                              else (r ->> 'cashMoneyHands')::bigint + (r ->> 'chipsMoneyHands')::bigint end)
               order by o), '[]'::jsonb)
             from jsonb_array_elements(v_rows) with ordinality as e(r, o));

  select coalesce(sum(p.hands), 0)::bigint
    into v_hidden
    from public.player_stats p
    where p.owner_id = v_owner
      and p.stats_version = v_version
      and p.site_anonymization = 'opaque-id'
      and (v_site is null or p.site_id = v_site)
      and (v_kind = 'all' or (p.game_format = 'cash') = (v_kind = 'cash'));

  return jsonb_build_object(
    'statsVersion', v_version,
    'rows',         v_rows,
    'matching',     v_matching,
    'players',      v_players,
    'cashHands',    v_cash,
    'chipsHands',   v_chips,
    'mixedKind',    v_mixed,
    'hiddenHands',  v_hidden
  );
end;
$$;

comment on function public.players_list(jsonb) is
  'The shared Players screen''s list (R4.5c-3): opponents of rooms with real names from player_stats, most hands together first; p_query {search, site, kind all|cash|chips, noted, limit <= 500, statsVersion}.';

create or replace function public.player_sites(p_stats_version text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(s.site_id order by s.site_id), '[]'::jsonb)
  from (
    select distinct p.site_id
    from public.player_stats p
    where p.owner_id = (select auth.uid())
      and p.stats_version = coalesce(nullif(btrim(coalesce(p_stats_version, '')), ''), 'stats/1')
      and p.site_anonymization = 'none'
  ) s;
$$;

comment on function public.player_sites(text) is
  'The rooms with listed opponents (the Players screen''s room filter, R4.5c-3).';

-- ---------------------------------------------------------------------------
-- 2. One opponent
-- ---------------------------------------------------------------------------

create or replace function public.player_profile(
  p_site          text,
  p_player        text,
  p_kind          text default 'all',
  p_stats_version text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_version text := coalesce(nullif(btrim(coalesce(p_stats_version, '')), ''), 'stats/1');
  v_kind    text := coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'all');
  v_seen    jsonb;
  v_exact   boolean;
  v_total   jsonb;
  v_groups  jsonb;
  v_stakes  jsonb;
  v_mixed   boolean;
  v_notes   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if v_kind not in ('all', 'cash', 'chips') then
    raise exception 'No such game kind: %.', v_kind
      using errcode = '22023';
  end if;

  select jsonb_build_object('note', coalesce(n.note, ''), 'tags', coalesce(to_jsonb(n.tags), '[]'::jsonb))
    into v_notes
    from (select 1) one
    left join public.player_notes n
      on n.owner_id = v_owner and n.site = p_site and n.player = p_player;

  -- What `player_stats` holds: their hands (the statistics' sample), when
  -- they were seen, the hands together and the result per kind.
  select case when count(*) = 0 then null else jsonb_build_object(
           'hands', sum(p.hands),
           'firstPlayedAt', min(p.first_played_at),
           'lastPlayedAt', max(p.last_played_at),
           'cash', jsonb_build_object(
             'hands', coalesce(sum(p.hero_hands) filter (where p.game_format = 'cash'), 0),
             'moneyHands', coalesce(sum(p.hero_money_hands) filter (where p.game_format = 'cash'), 0),
             'netBbMilli', coalesce(sum(p.hero_net_bb_milli) filter (where p.game_format = 'cash'), 0)),
           'chips', jsonb_build_object(
             'hands', coalesce(sum(p.hero_hands) filter (where p.game_format <> 'cash'), 0),
             'moneyHands', coalesce(sum(p.hero_money_hands) filter (where p.game_format <> 'cash'), 0),
             'netBbMilli', coalesce(sum(p.hero_net_bb_milli) filter (where p.game_format <> 'cash'), 0))) end,
         coalesce(bool_and(p.seen_exact), true)
    into v_seen, v_exact
    from public.player_stats p
    where p.owner_id = v_owner and p.stats_version = v_version
      and p.site_id = p_site and p.player = p_player and p.site_anonymization = 'none';

  if v_seen is null then
    -- Not an opponent of a room with real names (or opponent statistics are off).
    return jsonb_build_object('statsVersion', v_version, 'site', p_site, 'player', p_player,
      'seen', null, 'notes', v_notes, 'mixedKind', false, 'total', '{}'::jsonb,
      'groups', '{}'::jsonb, 'stakes', '[]'::jsonb, 'lastPlayedAt', null);
  end if;

  if not v_exact then
    select v_seen || jsonb_build_object('firstPlayedAt', min(h.played_at), 'lastPlayedAt', max(h.played_at))
      into v_seen
      from public.hand_stats h
      where h.owner_id = v_owner and h.stats_version = v_version and not h.is_hero
        and h.player = p_player and h.site_id = p_site and not h.is_bomb_pot
        and h.site_anonymization = 'none';
  end if;

  -- Their rows of the kind, summed in total and by position, stake, table
  -- size and game.
  with f as (
    select h.*,
           coalesce(h."position", '') as pos,
           case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
           case
      when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
      else 'full'
    end as size_class
    from public.hand_stats h
    where h.owner_id = v_owner
      and h.stats_version = v_version
      and not h.is_hero
      and h.player = p_player
      and h.site_id = p_site
      and h.site_anonymization = 'none'
      and not h.is_bomb_pot
      and (v_kind = 'all' or (h.game_format = 'cash') = (v_kind = 'cash'))
  ),
  g as (
    select
      case
        when grouping(f.pos) = 0 then 'position'
        when grouping(f.stake) = 0 then 'stake'
        when grouping(f.size_class) = 0 then 'size'
        when grouping(f.game_format) = 0 then 'format'
        else 'total'
      end as dim,
      coalesce(f.pos, f.stake, f.size_class, f.game_format::text) as key,
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
      coalesce(sum(f.hands) filter (where not f.has_cashout), 0)::bigint as money_hands,
      coalesce(sum(f.net_bb_milli) filter (where not f.has_cashout), 0)::bigint as net_bb_milli,
      min(f.currency) as currency,
      min(f.currency_minor_units)::integer as minor_units,
      min(f.small_blind) as small_blind,
      max(f.big_blind) as big_blind,
      max(f.played_at) as last_played_at,
      coalesce(bool_or(f.game_format = 'cash'), false) as any_cash,
      coalesce(bool_or(f.game_format <> 'cash'), false) as any_chips
    from f
    group by grouping sets ((), (f.pos), (f.stake), (f.size_class), (f.game_format))
  )
  select
    (select to_jsonb(t) - 'dim' - 'key' from g t where t.dim = 'total'),
    (select coalesce(jsonb_object_agg(d.dim, d.rows), '{}'::jsonb)
       from (select g.dim, jsonb_agg(jsonb_build_object(
          'key', g.key, 'hands', g.hands, 'money_hands', g.money_hands, 'vpip_opp', g.vpip_opp, 'vpip', g.vpip, 'pfr_opp', g.pfr_opp, 'pfr', g.pfr, 'rfi_opp', g.rfi_opp, 'rfi', g.rfi, 'three_bet_opp', g.three_bet_opp, 'three_bet', g.three_bet, 'fold_to_three_bet_opp', g.fold_to_three_bet_opp, 'fold_to_three_bet', g.fold_to_three_bet, 'steal_opp', g.steal_opp, 'steal', g.steal, 'cbet_flop_opp', g.cbet_flop_opp, 'cbet_flop', g.cbet_flop, 'wtsd_opp', g.wtsd_opp, 'wtsd', g.wtsd, 'wsd_opp', g.wsd_opp, 'wsd', g.wsd, 'wwsf_opp', g.wwsf_opp, 'wwsf', g.wwsf, 'net_bb_milli', g.net_bb_milli) order by g.hands desc, g.key) as rows
             from g where g.dim <> 'total' group by g.dim) d),
    (select coalesce(jsonb_agg(jsonb_build_object(
          'key', g.key, 'currency', g.currency, 'minorUnits', g.minor_units,
          'smallBlind', g.small_blind, 'bigBlind', g.big_blind) order by g.key), '[]'::jsonb)
       from g where g.dim = 'stake' and g.key <> 'chips')
  into v_total, v_groups, v_stakes;

  v_mixed := coalesce((v_total ->> 'any_cash')::boolean and (v_total ->> 'any_chips')::boolean, false);
  if v_mixed then
    -- Chips and cash: no big blinds add up.
    v_total := v_total - 'won' - 'contributed' - 'net' - 'net_bb_milli' - 'rake_paid' - 'out_of_pot' - 'cashout_risk';
    v_groups := (select coalesce(jsonb_object_agg(k, (select coalesce(jsonb_agg(r - 'net_bb_milli'), '[]'::jsonb)
                                                    from jsonb_array_elements(v) r)), '{}'::jsonb)
                   from jsonb_each(v_groups) as e(k, v));
  end if;

  return jsonb_build_object(
    'statsVersion', v_version,
    'site',         p_site,
    'player',       p_player,
    'seen',         v_seen,
    'notes',        v_notes,
    'mixedKind',    v_mixed,
    'total',        coalesce(v_total, '{}'::jsonb) - 'currency' - 'minor_units' - 'small_blind' - 'big_blind'
                      - 'last_played_at' - 'any_cash' - 'any_chips',
    'groups',       coalesce(v_groups, '{}'::jsonb),
    'stakes',       coalesce(v_stakes, '[]'::jsonb),
    'lastPlayedAt', v_total ->> 'last_played_at'
  );
end;
$$;

comment on function public.player_profile(text, text, text, text) is
  'One opponent for the shared Players screen (R4.5c-3): player_stats'' summary line and their villain rows of a kind summed in total and by position, stake, table size and game.';

revoke all on function public.players_list(jsonb) from public, anon;
grant execute on function public.players_list(jsonb) to authenticated;
revoke all on function public.player_sites(text) from public, anon;
grant execute on function public.player_sites(text) to authenticated;
revoke all on function public.player_profile(text, text, text, text) from public, anon;
grant execute on function public.player_profile(text, text, text, text) to authenticated;

commit;
