-- pgTAP: the web's report summaries (R4.5c-1) --
-- `20270707090000_report_summaries.sql`.
--
-- What has to hold:
--
--   * `hero_rollups`, `hero_report_rows` and `player_stats` always equal a
--     from-scratch aggregation of `hand_stats` - for random rows written in
--     statements of every size, through `save_hand_stats` as the user and
--     directly, and after every kind of delete (a hand's cascade, an old
--     version pruned, opponent rows pruned, the hero's row alone), after a
--     refused write (the per-account budget) and after a rebuild;
--   * the readers answer what a scan of the rows answers: `report_open`
--     (totals and its five breakdowns, with dates cut inside days),
--     `report_facets`, `report_graph` (its rule written out hand by hand)
--     and `report_situations` against `stats_breakdown`, `report_sessions` against
--     `stats_sessions`, and `stats_opponents` against its previous body;
--   * RLS: another account sees nothing of A's, anon is refused, nobody
--     writes the summaries.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(90);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000045a1', 'summaries.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000045b1', 'summaries.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.as_postgres() to anon, authenticated;

-- A stable "random" number for (i, salt).
create function pg_temp.r(p_i integer, p_salt text) returns integer language sql immutable as $$
  select abs(hashtext(p_i::text || ':' || p_salt));
$$;

-- ---------------------------------------------------------------------------
-- 1. The objects and who may touch them
-- ---------------------------------------------------------------------------

select has_table('public', 'hero_rollups', 'hero_rollups exists');
select has_table('public', 'hero_report_rows', 'hero_report_rows exists');
select has_table('public', 'player_stats', 'player_stats exists');
select ok((select bool_and(relrowsecurity) from pg_class
           where oid in ('public.hero_rollups'::regclass, 'public.hero_report_rows'::regclass, 'public.player_stats'::regclass)),
          'RLS on all three');
select ok(not has_table_privilege('anon', 'public.hero_rollups', 'select')
          and not has_table_privilege('anon', 'public.hero_report_rows', 'select')
          and not has_table_privilege('anon', 'public.player_stats', 'select'),
          'anon cannot read them');
select ok(not has_table_privilege('authenticated', 'public.hero_rollups', 'insert')
          and not has_table_privilege('authenticated', 'public.hero_rollups', 'update')
          and not has_table_privilege('authenticated', 'public.hero_rollups', 'delete')
          and not has_table_privilege('authenticated', 'public.hero_report_rows', 'insert')
          and not has_table_privilege('authenticated', 'public.player_stats', 'update')
          and not has_table_privilege('authenticated', 'public.player_stats', 'delete'),
          'a user cannot write them');
select ok(not has_function_privilege('authenticated', 'public.report_summaries_rebuild(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.hand_stats_summaries_insert()', 'execute'),
          'nor call the rebuild or the trigger functions');
select ok(not has_function_privilege('anon', 'public.report_open(jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.report_graph(jsonb, integer)', 'execute')
          and not has_function_privilege('anon', 'public.report_situations(jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.report_sessions(jsonb, integer)', 'execute')
          and not has_function_privilege('anon', 'public.report_facets(jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.refresh_report_summaries()', 'execute'),
          'anon cannot call the readers');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
           from pg_proc p where p.oid in ('public.report_summaries_rebuild(uuid)'::regprocedure,
             'public.hand_stats_summaries_insert()'::regprocedure, 'public.hand_stats_summaries_delete()'::regprocedure,
             'public.hand_stats_summaries_update()'::regprocedure, 'public.refresh_report_summaries()'::regprocedure)),
          'the writers are security definer with an empty search_path');
select ok((select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""'])
           from pg_proc p where p.oid in ('public.report_open(jsonb)'::regprocedure, 'public.report_graph(jsonb, integer)'::regprocedure,
             'public.report_situations(jsonb)'::regprocedure, 'public.report_sessions(jsonb, integer)'::regprocedure,
             'public.report_facets(jsonb)'::regprocedure, 'public.stats_opponents(jsonb, text, integer)'::regprocedure)),
          'the readers are security invoker with an empty search_path');

-- ---------------------------------------------------------------------------
-- 2. Random rows
-- ---------------------------------------------------------------------------
--
-- A: 320 hands over three weeks (some without a time), four rooms (one
-- positional, one opaque-id), cash in two currencies and three tournament
-- formats, bomb pots, straddles, EV cashouts, up to four opponents a hand
-- from a pool of twelve names (some empty). B: a few hands of its own.

create table pg_temp.gen_hands as
select
  i,
  ('00000000-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid as id,
  case when i > 320 then '00000000-0000-0000-0000-0000000045b1'::uuid else '00000000-0000-0000-0000-0000000045a1'::uuid end as owner_id,
  site || ':g' || i as hand_key,
  site,
  case site when 'ignition' then 'positional' when 'ggpoker' then 'opaque-id' else 'none' end::public.site_anonymization as site_anonymization,
  fmt::public.game_format as game_format,
  case when fmt = 'cash' then (array['USD','EUR'])[1 + pg_temp.r(i, 'cur') % 2] else 'CHIPS' end as currency,
  case when fmt = 'cash' then 100 else 1 end::smallint as currency_minor_units,
  case when pg_temp.r(i, 'nobb') % 30 = 0 then null else bb / 2 end as small_blind,
  case when pg_temp.r(i, 'nobb') % 30 = 0 then null else bb end as big_blind,
  (array[2, 6, 9, null])[1 + pg_temp.r(i, 'seats') % 4]::smallint as max_seats,
  (2 + pg_temp.r(i, 'players') % 8)::smallint as player_count,
  (array['holdem', 'omaha', null])[1 + pg_temp.r(i, 'var') % 3] as variant,
  (array['nl', 'pl', null])[1 + pg_temp.r(i, 'lim') % 3] as limit_type,
  case when pg_temp.r(i, 'notime') % 25 = 0 then null
       else '2026-10-01T00:00:00Z'::timestamptz + make_interval(mins => pg_temp.r(i, 'time') % (21 * 24 * 60)) end as played_at,
  'T' || (pg_temp.r(i, 'table') % 7) as table_name,
  pg_temp.r(i, 'straddle') % 10 = 0 as has_straddle,
  pg_temp.r(i, 'bomb') % 15 = 0 as is_bomb_pot,
  pg_temp.r(i, 'cashout') % 12 = 0 as has_cashout,
  case when site = 'ignition' then 0 else pg_temp.r(i, 'villains') % 5 end as villains
from generate_series(1, 330) as i
cross join lateral (select (array['pokerstars', 'ggpoker', 'winamax', 'ignition'])[1 + pg_temp.r(i, 'site') % 4] as site) s
cross join lateral (select case when pg_temp.r(i, 'fmt') % 10 < 7 then 'cash'
                                else (array['tournament', 'sng', 'spin'])[1 + pg_temp.r(i, 'fmt2') % 3] end as fmt) f
cross join lateral (select (array[2, 5, 10, 200])[1 + pg_temp.r(i, 'bb') % 4]::bigint as bb) b;

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, currency, currency_minor_units,
                          small_blind, big_blind, max_seats, player_count, played_at, hero_seat, site_anonymization, variant,
                          limit_type, currency_symbol)
select id, owner_id, hand_key, '{"schema":"phf/1"}', 'std', site, game_format, currency, currency_minor_units,
       small_blind, big_blind, max_seats, player_count, played_at, 1, site_anonymization, variant, limit_type,
       case currency when 'USD' then '$' when 'EUR' then '€' end
from pg_temp.gen_hands;

-- Valid counters for one seat: the table's checks (legs, chains, bomb pots,
-- cashouts) hold by construction.
create function pg_temp.counters(p_i integer, p_bomb boolean, p_cashout boolean) returns table (
  vpip_opp smallint, vpip smallint, pfr_opp smallint, pfr smallint, rfi_opp smallint, rfi smallint,
  three_bet_opp smallint, three_bet smallint, steal_opp smallint, steal smallint,
  fold_to_three_bet_opp smallint, fold_to_three_bet smallint, call_three_bet smallint, raise_vs_three_bet smallint,
  fold_to_steal_opp smallint, fold_to_steal smallint, call_steal smallint, three_bet_vs_steal smallint,
  flop_seen smallint, turn_seen smallint, river_seen smallint, cbet_flop_opp smallint, cbet_flop smallint,
  fold_to_cbet_flop_opp smallint, fold_to_cbet_flop smallint, call_cbet_flop smallint, raise_cbet_flop smallint,
  wwsf_opp smallint, wwsf smallint, wtsd_opp smallint, wtsd smallint, wsd_opp smallint, wsd smallint,
  bet_flop smallint, raise_flop smallint, call_flop smallint, fold_flop smallint, bet_turn smallint, call_river smallint,
  check_turn smallint, cashed_out smallint, won bigint, contributed bigint, net bigint, net_bb_milli bigint,
  rake_paid bigint, out_of_pot bigint, cashout_risk bigint
) language sql immutable as $$
  with b as (
    select
      not p_bomb as pre,
      pg_temp.r(p_i, 'a') % 2 = 0 as a, pg_temp.r(p_i, 'b') % 3 = 0 as b, pg_temp.r(p_i, 'c') % 2 = 0 as c,
      pg_temp.r(p_i, 'd') % 4 = 0 as d, pg_temp.r(p_i, 'e') % 2 = 0 as e, pg_temp.r(p_i, 'f') % 5 = 0 as f,
      pg_temp.r(p_i, 'g') % 3 as g, pg_temp.r(p_i, 'h') % 3 = 0 as h, pg_temp.r(p_i, 'k') % 3 as k,
      pg_temp.r(p_i, 'fl') % 2 = 0 as fl, pg_temp.r(p_i, 'tu') % 2 = 0 as tu, pg_temp.r(p_i, 'ri') % 2 = 0 as ri,
      pg_temp.r(p_i, 'cb') % 2 = 0 as cb, pg_temp.r(p_i, 'cm') % 2 = 0 as cm, pg_temp.r(p_i, 'fc') % 3 = 0 as fc,
      pg_temp.r(p_i, 'fk') % 3 as fk, pg_temp.r(p_i, 'ww') % 2 = 0 as ww, pg_temp.r(p_i, 'sd') % 2 = 0 as sd,
      pg_temp.r(p_i, 'ws') % 2 = 0 as ws, pg_temp.r(p_i, 'won') % 900 as won, pg_temp.r(p_i, 'con') % 500 as con,
      pg_temp.r(p_i, 'co') % 2 = 0 as co
  )
  select
    pre::int::smallint, (pre and a)::int::smallint, pre::int::smallint, (pre and a and b)::int::smallint,
    (pre and c)::int::smallint, (pre and c and b)::int::smallint,
    (pre and d)::int::smallint, (pre and d and e)::int::smallint, (pre and e)::int::smallint, (pre and e and a)::int::smallint,
    (pre and f)::int::smallint, (pre and f and g = 0)::int::smallint, (pre and f and g = 1)::int::smallint, (pre and f and g = 2)::int::smallint,
    (pre and h)::int::smallint, (pre and h and k = 0)::int::smallint, (pre and h and k = 1)::int::smallint, (pre and h and k = 2)::int::smallint,
    fl::int::smallint, (fl and tu)::int::smallint, (fl and tu and ri)::int::smallint, (fl and cb)::int::smallint, (fl and cb and cm)::int::smallint,
    (fl and fc)::int::smallint, (fl and fc and fk = 0)::int::smallint, (fl and fc and fk = 1)::int::smallint, (fl and fc and fk = 2)::int::smallint,
    fl::int::smallint, (fl and ww)::int::smallint, fl::int::smallint, (fl and sd)::int::smallint, (fl and sd)::int::smallint, (fl and sd and ws)::int::smallint,
    (pg_temp.r(p_i, 'bf') % 3)::smallint, (pg_temp.r(p_i, 'rf') % 2)::smallint, (pg_temp.r(p_i, 'cf') % 3)::smallint,
    (pg_temp.r(p_i, 'ff') % 2)::smallint, (pg_temp.r(p_i, 'bt') % 2)::smallint, (pg_temp.r(p_i, 'cr') % 2)::smallint,
    (pg_temp.r(p_i, 'ct') % 2)::smallint, (p_cashout and co)::int::smallint,
    won::bigint, con::bigint, (won - con)::bigint, ((won - con) * 37 + pg_temp.r(p_i, 'bbm') % 11)::bigint,
    (pg_temp.r(p_i, 'rake') % 7)::bigint, (pg_temp.r(p_i, 'oop') % 3)::bigint, (case when p_cashout then pg_temp.r(p_i, 'risk') % 50 else 0 end)::bigint
  from b;
$$;

-- Every column's default, for the rows below to start from.
create temp table hs_default (like public.hand_stats including defaults);
alter table hs_default alter column hand_id drop not null, alter column owner_id drop not null,
  alter column seat drop not null, alter column hand_key drop not null, alter column site_id drop not null;
insert into hs_default default values;
grant select on pg_temp.gen_hands, pg_temp.hs_default to authenticated;

-- The rows of hands [p_lo, p_hi] at a version.
create function pg_temp.rows_of(p_lo integer, p_hi integer, p_version text) returns setof public.hand_stats language sql as $$
  select (x).* from (
    select jsonb_populate_record(null::public.hand_stats, (select to_jsonb(d) from hs_default d) || to_jsonb(t) || '{"hands": 1}'::jsonb) as x from (
      select
    h.id, h.owner_id, p_version, s.seat, h.hand_key, h.site, h.played_at, h.variant, h.limit_type, h.game_format,
    h.site_anonymization, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.player_count, h.max_seats,
    h.table_name, h.has_straddle, h.is_bomb_pot, h.has_cashout,
    (array['preflop','flop','turn','river','showdown',null])[1 + pg_temp.r(h.i * 31 + s.seat, 'street') % 6],
    (array['walk','limped','single-raised','3bet','4bet+',null])[1 + pg_temp.r(h.i * 31 + s.seat, 'pot') % 6],
    case when s.seat = 1 then '' when h.site_anonymization = 'opaque-id' then 'tok-' || h.i || '-' || s.seat
         when pg_temp.r(h.i * 31 + s.seat, 'empty') % 20 = 0 then ''
         else 'p' || lpad((1 + pg_temp.r(h.i * 31 + s.seat, 'who') % 12)::text, 2, '0') end,
    s.seat = 1,
    (array['BTN','SB','BB','CO','MP','UTG',null])[1 + pg_temp.r(h.i * 31 + s.seat, 'pos') % 7],
    (array['AKs','QQ','72o','T9s','AA',null])[1 + pg_temp.r(h.i * 31 + s.seat, 'class') % 6],
    case when pg_temp.r(h.i * 31 + s.seat, 'nostack') % 15 = 0 then null else 50 + pg_temp.r(h.i * 31 + s.seat, 'stack') % 3000 end,
    c.*
  from pg_temp.gen_hands h
  cross join lateral generate_series(1, 1 + h.villains) as s(seat)
  cross join lateral pg_temp.counters(h.i * 31 + s.seat, h.is_bomb_pot, h.has_cashout) c
      where h.i between p_lo and p_hi
    ) t (hand_id, owner_id, stats_version, seat, hand_key, site_id, played_at, variant, limit_type, game_format,
    site_anonymization, currency, currency_minor_units, small_blind, big_blind, player_count, max_seats,
    table_name, has_straddle, is_bomb_pot, has_cashout, street_reached, pot_type, player, is_hero,
    "position", hand_class, starting_stack_bb_tenths,
    vpip_opp, vpip, pfr_opp, pfr, rfi_opp, rfi, three_bet_opp, three_bet, steal_opp, steal,
    fold_to_three_bet_opp, fold_to_three_bet, call_three_bet, raise_vs_three_bet,
    fold_to_steal_opp, fold_to_steal, call_steal, three_bet_vs_steal,
    flop_seen, turn_seen, river_seen, cbet_flop_opp, cbet_flop,
    fold_to_cbet_flop_opp, fold_to_cbet_flop, call_cbet_flop, raise_cbet_flop,
    wwsf_opp, wwsf, wtsd_opp, wtsd, wsd_opp, wsd,
    bet_flop, raise_flop, call_flop, fold_flop, bet_turn, call_river, check_turn,
    cashed_out, won, contributed, net, net_bb_milli, rake_paid, out_of_pot, cashout_risk)
  ) z;
$$;

create function pg_temp.hero_scratch() returns setof public.hero_rollups language sql as $$
  select
    x.owner_id,
    x.stats_version,
    coalesce((x.played_at at time zone 'UTC')::date, '-infinity'::date),
    x.site_id,
    x.game_format,
    coalesce(x.variant, ''),
    coalesce(x.limit_type, ''),
    case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end,
    x.currency,
    x.currency_minor_units,
    coalesce(x.small_blind, 0),
    coalesce(x.big_blind, 0),
    case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end,
    coalesce(x."position", ''),
    ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint,
    sum(x.hands)::bigint, sum(x.vpip_opp)::bigint, sum(x.vpip)::bigint, sum(x.pfr_opp)::bigint, sum(x.pfr)::bigint, sum(x.rfi_opp)::bigint,
    sum(x.rfi)::bigint, sum(x.iso_opp)::bigint, sum(x.iso)::bigint, sum(x.limp_opp)::bigint, sum(x.limp)::bigint, sum(x.cold_call_opp)::bigint,
    sum(x.cold_call)::bigint, sum(x.three_bet_opp)::bigint, sum(x.three_bet)::bigint, sum(x.four_bet_opp)::bigint, sum(x.four_bet)::bigint, sum(x.five_bet_opp)::bigint,
    sum(x.five_bet)::bigint, sum(x.squeeze_opp)::bigint, sum(x.squeeze)::bigint, sum(x.steal_opp)::bigint, sum(x.steal)::bigint, sum(x.fold_to_steal_opp)::bigint,
    sum(x.fold_to_steal)::bigint, sum(x.call_steal)::bigint, sum(x.three_bet_vs_steal)::bigint, sum(x.fold_to_three_bet_opp)::bigint, sum(x.fold_to_three_bet)::bigint, sum(x.call_three_bet)::bigint,
    sum(x.raise_vs_three_bet)::bigint, sum(x.fold_to_four_bet_opp)::bigint, sum(x.fold_to_four_bet)::bigint, sum(x.call_four_bet)::bigint, sum(x.raise_vs_four_bet)::bigint, sum(x.flop_seen)::bigint,
    sum(x.turn_seen)::bigint, sum(x.river_seen)::bigint, sum(x.cbet_flop_opp)::bigint, sum(x.cbet_flop)::bigint, sum(x.cbet_turn_opp)::bigint, sum(x.cbet_turn)::bigint,
    sum(x.cbet_river_opp)::bigint, sum(x.cbet_river)::bigint, sum(x.fold_to_cbet_flop_opp)::bigint, sum(x.fold_to_cbet_flop)::bigint, sum(x.call_cbet_flop)::bigint, sum(x.raise_cbet_flop)::bigint,
    sum(x.fold_to_cbet_turn_opp)::bigint, sum(x.fold_to_cbet_turn)::bigint, sum(x.call_cbet_turn)::bigint, sum(x.raise_cbet_turn)::bigint, sum(x.fold_to_cbet_river_opp)::bigint, sum(x.fold_to_cbet_river)::bigint,
    sum(x.call_cbet_river)::bigint, sum(x.raise_cbet_river)::bigint, sum(x.donk_flop_opp)::bigint, sum(x.donk_flop)::bigint, sum(x.donk_turn_opp)::bigint, sum(x.donk_turn)::bigint,
    sum(x.donk_river_opp)::bigint, sum(x.donk_river)::bigint, sum(x.check_raise_flop_opp)::bigint, sum(x.check_raise_flop)::bigint, sum(x.check_raise_turn_opp)::bigint, sum(x.check_raise_turn)::bigint,
    sum(x.check_raise_river_opp)::bigint, sum(x.check_raise_river)::bigint, sum(x.bet_flop)::bigint, sum(x.raise_flop)::bigint, sum(x.call_flop)::bigint, sum(x.check_flop)::bigint,
    sum(x.fold_flop)::bigint, sum(x.bet_turn)::bigint, sum(x.raise_turn)::bigint, sum(x.call_turn)::bigint, sum(x.check_turn)::bigint, sum(x.fold_turn)::bigint,
    sum(x.bet_river)::bigint, sum(x.raise_river)::bigint, sum(x.call_river)::bigint, sum(x.check_river)::bigint, sum(x.fold_river)::bigint, sum(x.wwsf_opp)::bigint,
    sum(x.wwsf)::bigint, sum(x.wtsd_opp)::bigint, sum(x.wtsd)::bigint, sum(x.wsd_opp)::bigint, sum(x.wsd)::bigint, sum(x.cashed_out)::bigint,
    sum(x.won)::bigint, sum(x.contributed)::bigint, sum(x.net)::bigint, sum(x.net_bb_milli)::bigint, sum(x.rake_paid)::bigint, sum(x.out_of_pot)::bigint,
    sum(x.cashout_risk)::bigint, sum((case when x.wtsd > 0 then x.net_bb_milli else 0 end))::bigint
  from public.hand_stats x
  where x.is_hero
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
$$;
create function pg_temp.report_rows_scratch() returns setof public.hero_report_rows language sql as $$
  select x.hand_id, x.stats_version, x.seat, x.owner_id, x.played_at, x.hand_key, x.site_id,
    x.game_format, coalesce(x.variant, ''), coalesce(x.limit_type, ''), case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end, x.currency,
    x.currency_minor_units, coalesce(x.big_blind, 0), case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0)::text else 'chips' end, coalesce(x."position", ''), ((case when x.is_bomb_pot then 1 else 0 end) + (case when x.has_straddle then 2 else 0 end) + (case when x.has_cashout then 4 else 0 end))::smallint, x.net,
    x.net_bb_milli, x.table_name, coalesce(x.pot_type, ''), case
      when x.starting_stack_bb_tenths is null then ''
      when x.starting_stack_bb_tenths <  200 then '0-20'
      when x.starting_stack_bb_tenths <  400 then '20-40'
      when x.starting_stack_bb_tenths <  700 then '40-70'
      when x.starting_stack_bb_tenths < 1000 then '70-100'
      when x.starting_stack_bb_tenths < 1500 then '100-150'
      when x.starting_stack_bb_tenths < 2500 then '150-250'
      else '250+' end, coalesce(x.hand_class, ''),
    x.player_count, coalesce(x.street_reached, ''), x.vpip_opp, x.vpip, x.pfr_opp, x.pfr, x.rfi_opp, x.rfi, x.three_bet_opp, x.three_bet, x.fold_to_three_bet_opp, x.fold_to_three_bet, x.steal_opp, x.steal, x.cbet_flop_opp, x.cbet_flop, x.wtsd_opp, x.wtsd, x.wsd_opp, x.wsd, x.wwsf_opp, x.wwsf
  from public.hand_stats x where x.is_hero
$$;
create function pg_temp.player_scratch() returns table (
  owner_id uuid, stats_version text, site_id text, player text, site_anonymization public.site_anonymization, game_format public.game_format, variant text, limit_type text, size text, currency text, big_blind bigint,
  hands bigint, vpip_opp bigint, vpip bigint, pfr_opp bigint, pfr bigint, three_bet_opp bigint, three_bet bigint, fold_to_three_bet_opp bigint, fold_to_three_bet bigint, cbet_flop_opp bigint, cbet_flop bigint, fold_to_cbet_flop_opp bigint, fold_to_cbet_flop bigint, wtsd_opp bigint, wtsd bigint, wsd_opp bigint, wsd bigint, bets bigint, raises bigint, calls bigint, folds bigint, hero_hands bigint, hero_money_hands bigint, hero_net_bb_milli bigint,
  first_played_at timestamptz, last_played_at timestamptz
) language sql as $$
  select
    v.owner_id as owner_id,
    v.stats_version as stats_version,
    v.site_id as site_id,
    case when v.site_anonymization = 'opaque-id' then '' else v.player end as player,
    v.site_anonymization as site_anonymization,
    v.game_format as game_format,
    coalesce(v.variant, '') as variant,
    coalesce(v.limit_type, '') as limit_type,
    case
      when coalesce(case when coalesce(v.max_seats, 0) >= 2 then v.max_seats else v.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(v.max_seats, 0) >= 2 then v.max_seats else v.player_count end <= 6 then '6max'
      else 'full'
    end as size,
    v.currency as currency,
    coalesce(v.big_blind, 0) as big_blind,
    sum(v.hands::bigint)::bigint as hands, sum(v.vpip_opp::bigint)::bigint as vpip_opp,
    sum(v.vpip::bigint)::bigint as vpip, sum(v.pfr_opp::bigint)::bigint as pfr_opp,
    sum(v.pfr::bigint)::bigint as pfr, sum(v.three_bet_opp::bigint)::bigint as three_bet_opp,
    sum(v.three_bet::bigint)::bigint as three_bet, sum(v.fold_to_three_bet_opp::bigint)::bigint as fold_to_three_bet_opp,
    sum(v.fold_to_three_bet::bigint)::bigint as fold_to_three_bet, sum(v.cbet_flop_opp::bigint)::bigint as cbet_flop_opp,
    sum(v.cbet_flop::bigint)::bigint as cbet_flop, sum(v.fold_to_cbet_flop_opp::bigint)::bigint as fold_to_cbet_flop_opp,
    sum(v.fold_to_cbet_flop::bigint)::bigint as fold_to_cbet_flop, sum(v.wtsd_opp::bigint)::bigint as wtsd_opp,
    sum(v.wtsd::bigint)::bigint as wtsd, sum(v.wsd_opp::bigint)::bigint as wsd_opp,
    sum(v.wsd::bigint)::bigint as wsd, sum((v.bet_flop + v.bet_turn + v.bet_river)::bigint)::bigint as bets,
    sum((v.raise_flop + v.raise_turn + v.raise_river)::bigint)::bigint as raises, sum((v.call_flop + v.call_turn + v.call_river)::bigint)::bigint as calls,
    sum((v.fold_flop + v.fold_turn + v.fold_river)::bigint)::bigint as folds,
    count(h.hand_id)::bigint as hero_hands,
    (count(h.hand_id) filter (where not h.has_cashout))::bigint as hero_money_hands,
    coalesce(sum(h.net_bb_milli) filter (where not h.has_cashout), 0)::bigint as hero_net_bb_milli,
    min(v.played_at) as first_played_at, max(v.played_at) as last_played_at
  from public.hand_stats v
  left join public.hand_stats h on h.hand_id = v.hand_id and h.stats_version = v.stats_version and h.is_hero
  where not v.is_hero and not v.is_bomb_pot and v.player <> ''
  group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
$$;
-- The three summaries hold exactly the scratch aggregation (first and last
-- hand where a delete has not made them stale).
create function pg_temp.in_step() returns text language plpgsql as $$
declare
  v_out text := '';
begin
  if exists (select * from pg_temp.hero_scratch() except select * from public.hero_rollups)
     or exists (select * from public.hero_rollups except select * from pg_temp.hero_scratch()) then
    v_out := v_out || 'hero_rollups ';
  end if;
  if exists (select * from pg_temp.report_rows_scratch() except select * from public.hero_report_rows)
     or exists (select * from public.hero_report_rows except select * from pg_temp.report_rows_scratch()) then
    v_out := v_out || 'hero_report_rows ';
  end if;
  if exists (select owner_id, stats_version, site_id, player, site_anonymization, game_format, variant, limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr, three_bet_opp, three_bet, fold_to_three_bet_opp, fold_to_three_bet, cbet_flop_opp, cbet_flop, fold_to_cbet_flop_opp, fold_to_cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, bets, raises, calls, folds, hero_hands, hero_money_hands, hero_net_bb_milli from pg_temp.player_scratch() except select owner_id, stats_version, site_id, player, site_anonymization, game_format, variant, limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr, three_bet_opp, three_bet, fold_to_three_bet_opp, fold_to_three_bet, cbet_flop_opp, cbet_flop, fold_to_cbet_flop_opp, fold_to_cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, bets, raises, calls, folds, hero_hands, hero_money_hands, hero_net_bb_milli from public.player_stats)
     or exists (select owner_id, stats_version, site_id, player, site_anonymization, game_format, variant, limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr, three_bet_opp, three_bet, fold_to_three_bet_opp, fold_to_three_bet, cbet_flop_opp, cbet_flop, fold_to_cbet_flop_opp, fold_to_cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, bets, raises, calls, folds, hero_hands, hero_money_hands, hero_net_bb_milli from public.player_stats except select owner_id, stats_version, site_id, player, site_anonymization, game_format, variant, limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr, three_bet_opp, three_bet, fold_to_three_bet_opp, fold_to_three_bet, cbet_flop_opp, cbet_flop, fold_to_cbet_flop_opp, fold_to_cbet_flop, wtsd_opp, wtsd, wsd_opp, wsd, bets, raises, calls, folds, hero_hands, hero_money_hands, hero_net_bb_milli from pg_temp.player_scratch()) then
    v_out := v_out || 'player_stats ';
  end if;
  if exists (select 1 from public.player_stats p join pg_temp.player_scratch() s using (owner_id, stats_version, site_id, player, site_anonymization, game_format, variant, limit_type, size, currency, big_blind)
             where p.seen_exact and (p.first_played_at is distinct from s.first_played_at
                                     or p.last_played_at is distinct from s.last_played_at)) then
    v_out := v_out || 'player_stats.seen ';
  end if;
  return coalesce(nullif(v_out, ''), 'in step');
end;
$$;

create function pg_temp.oracle(p_filter jsonb, p_group text default null) returns jsonb
language plpgsql as $$
declare
  v_out jsonb;
begin
  execute format($q$
    select coalesce(jsonb_object_agg(g, j), '{}'::jsonb) from (
      select %s as g, to_jsonb(t) - 'g' as j from (
        select
          %s as g,
          sum(x.hands)::bigint as hands, sum(x.vpip_opp)::bigint as vpip_opp, sum(x.vpip)::bigint as vpip, sum(x.pfr_opp)::bigint as pfr_opp,
          sum(x.pfr)::bigint as pfr, sum(x.rfi_opp)::bigint as rfi_opp, sum(x.rfi)::bigint as rfi, sum(x.iso_opp)::bigint as iso_opp,
          sum(x.iso)::bigint as iso, sum(x.limp_opp)::bigint as limp_opp, sum(x.limp)::bigint as limp, sum(x.cold_call_opp)::bigint as cold_call_opp,
          sum(x.cold_call)::bigint as cold_call, sum(x.three_bet_opp)::bigint as three_bet_opp, sum(x.three_bet)::bigint as three_bet, sum(x.four_bet_opp)::bigint as four_bet_opp,
          sum(x.four_bet)::bigint as four_bet, sum(x.five_bet_opp)::bigint as five_bet_opp, sum(x.five_bet)::bigint as five_bet, sum(x.squeeze_opp)::bigint as squeeze_opp,
          sum(x.squeeze)::bigint as squeeze, sum(x.steal_opp)::bigint as steal_opp, sum(x.steal)::bigint as steal, sum(x.fold_to_steal_opp)::bigint as fold_to_steal_opp,
          sum(x.fold_to_steal)::bigint as fold_to_steal, sum(x.call_steal)::bigint as call_steal, sum(x.three_bet_vs_steal)::bigint as three_bet_vs_steal, sum(x.fold_to_three_bet_opp)::bigint as fold_to_three_bet_opp,
          sum(x.fold_to_three_bet)::bigint as fold_to_three_bet, sum(x.call_three_bet)::bigint as call_three_bet, sum(x.raise_vs_three_bet)::bigint as raise_vs_three_bet, sum(x.fold_to_four_bet_opp)::bigint as fold_to_four_bet_opp,
          sum(x.fold_to_four_bet)::bigint as fold_to_four_bet, sum(x.call_four_bet)::bigint as call_four_bet, sum(x.raise_vs_four_bet)::bigint as raise_vs_four_bet, sum(x.flop_seen)::bigint as flop_seen,
          sum(x.turn_seen)::bigint as turn_seen, sum(x.river_seen)::bigint as river_seen, sum(x.cbet_flop_opp)::bigint as cbet_flop_opp, sum(x.cbet_flop)::bigint as cbet_flop,
          sum(x.cbet_turn_opp)::bigint as cbet_turn_opp, sum(x.cbet_turn)::bigint as cbet_turn, sum(x.cbet_river_opp)::bigint as cbet_river_opp, sum(x.cbet_river)::bigint as cbet_river,
          sum(x.fold_to_cbet_flop_opp)::bigint as fold_to_cbet_flop_opp, sum(x.fold_to_cbet_flop)::bigint as fold_to_cbet_flop, sum(x.call_cbet_flop)::bigint as call_cbet_flop, sum(x.raise_cbet_flop)::bigint as raise_cbet_flop,
          sum(x.fold_to_cbet_turn_opp)::bigint as fold_to_cbet_turn_opp, sum(x.fold_to_cbet_turn)::bigint as fold_to_cbet_turn, sum(x.call_cbet_turn)::bigint as call_cbet_turn, sum(x.raise_cbet_turn)::bigint as raise_cbet_turn,
          sum(x.fold_to_cbet_river_opp)::bigint as fold_to_cbet_river_opp, sum(x.fold_to_cbet_river)::bigint as fold_to_cbet_river, sum(x.call_cbet_river)::bigint as call_cbet_river, sum(x.raise_cbet_river)::bigint as raise_cbet_river,
          sum(x.donk_flop_opp)::bigint as donk_flop_opp, sum(x.donk_flop)::bigint as donk_flop, sum(x.donk_turn_opp)::bigint as donk_turn_opp, sum(x.donk_turn)::bigint as donk_turn,
          sum(x.donk_river_opp)::bigint as donk_river_opp, sum(x.donk_river)::bigint as donk_river, sum(x.check_raise_flop_opp)::bigint as check_raise_flop_opp, sum(x.check_raise_flop)::bigint as check_raise_flop,
          sum(x.check_raise_turn_opp)::bigint as check_raise_turn_opp, sum(x.check_raise_turn)::bigint as check_raise_turn, sum(x.check_raise_river_opp)::bigint as check_raise_river_opp, sum(x.check_raise_river)::bigint as check_raise_river,
          sum(x.bet_flop)::bigint as bet_flop, sum(x.raise_flop)::bigint as raise_flop, sum(x.call_flop)::bigint as call_flop, sum(x.check_flop)::bigint as check_flop,
          sum(x.fold_flop)::bigint as fold_flop, sum(x.bet_turn)::bigint as bet_turn, sum(x.raise_turn)::bigint as raise_turn, sum(x.call_turn)::bigint as call_turn,
          sum(x.check_turn)::bigint as check_turn, sum(x.fold_turn)::bigint as fold_turn, sum(x.bet_river)::bigint as bet_river, sum(x.raise_river)::bigint as raise_river,
          sum(x.call_river)::bigint as call_river, sum(x.check_river)::bigint as check_river, sum(x.fold_river)::bigint as fold_river, sum(x.wwsf_opp)::bigint as wwsf_opp,
          sum(x.wwsf)::bigint as wwsf, sum(x.wtsd_opp)::bigint as wtsd_opp, sum(x.wtsd)::bigint as wtsd, sum(x.wsd_opp)::bigint as wsd_opp,
          sum(x.wsd)::bigint as wsd, sum(x.cashed_out)::bigint as cashed_out,
          (count(*) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout))::bigint as money_hands,
          coalesce(sum(x.won) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as won,
          coalesce(sum(x.contributed) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as contributed,
          coalesce(sum(x.net) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as net,
          coalesce(sum(x.net_bb_milli) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as net_bb_milli,
          coalesce(sum(x.rake_paid) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as rake_paid,
          coalesce(sum(x.out_of_pot) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as out_of_pot,
          coalesce(sum(x.cashout_risk) filter (where coalesce(($1 ->> 'includeCashouts')::boolean, false) or not x.has_cashout), 0)::bigint as cashout_risk
        from (
          select x.*,
            coalesce(x."position", '') as pos_key,
            case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0) else 'chips' end as stake_key,
            case
      when coalesce(case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(x.max_seats, 0) >= 2 then x.max_seats else x.player_count end <= 6 then '6max'
      else 'full'
    end as size_key
          from public.hand_stats x
          where x.owner_id = auth.uid() and x.stats_version = 'stats/2' and x.is_hero
        ) x
        where ($1 ->> 'from' is null or x.played_at >= ($1 ->> 'from')::timestamptz)
          and ($1 ->> 'to' is null or x.played_at < ($1 ->> 'to')::timestamptz)
          and ($1 -> 'sites' is null or x.site_id in (select jsonb_array_elements_text($1 -> 'sites')))
          and ($1 -> 'formats' is null or x.game_format::text in (select jsonb_array_elements_text($1 -> 'formats')))
          and ($1 -> 'positions' is null or x.pos_key in (select jsonb_array_elements_text($1 -> 'positions')))
          and ($1 -> 'stakes' is null or x.stake_key in (select jsonb_array_elements_text($1 -> 'stakes')))
          and ($1 -> 'sizes' is null or x.size_key in (select jsonb_array_elements_text($1 -> 'sizes')))
          and ($1 -> 'variants' is null or coalesce(x.variant, '') in (select jsonb_array_elements_text($1 -> 'variants')))
          and ($1 -> 'limits' is null or coalesce(x.limit_type, '') in (select jsonb_array_elements_text($1 -> 'limits')))
          and (coalesce(($1 ->> 'includeBombPots')::boolean, false) or not x.is_bomb_pot)
          and (coalesce(($1 ->> 'includeStraddled')::boolean, true) or not x.has_straddle)
        group by 1
      ) t
    ) z
  $q$, 'g', coalesce(p_group, '''~total'''))
  into v_out using p_filter;
  return v_out;
end;
$$;

create function pg_temp.open_diffs(p_filter jsonb) returns integer language plpgsql as $$
declare
  v_new jsonb := public.report_open(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1"}');
  v_old jsonb := pg_temp.oracle(p_filter) -> '~total';
  v_n   integer := 0;
  k     text;
begin
  if v_old is null then
    return case when (v_new ->> 'hands')::bigint = 0 then 0 else 1 end;
  end if;
  for k in select jsonb_object_keys(v_old) loop
    -- Money the units refuse is absent from the reader's answer.
    if v_new -> 'total' ? k and (v_new -> 'total' ->> k)::bigint is distinct from (v_old ->> k)::bigint then
      v_n := v_n + 1;
    elsif not (v_new -> 'total' ? k) and k not in ('won', 'contributed', 'net', 'net_bb_milli', 'rake_paid', 'out_of_pot', 'cashout_risk') then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
create function pg_temp.group_diffs(p_filter jsonb, p_dim text, p_key text) returns integer language plpgsql as $$
declare
  v_new jsonb := public.report_open(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1"}') -> 'groups' -> p_dim;
  v_old jsonb := pg_temp.oracle(p_filter, p_key);
  v_n   integer := 0;
  r     jsonb;
  k     text;
begin
  if jsonb_array_length(coalesce(v_new, '[]')) <> (select count(*) from jsonb_object_keys(v_old)) then
    return 1000;
  end if;
  for r in select jsonb_array_elements(coalesce(v_new, '[]')) loop
    for k in select jsonb_object_keys(r) loop
      continue when k = 'key';
      if (r ->> k)::bigint is distinct from (v_old -> (r ->> 'key') ->> k)::bigint then
        v_n := v_n + 1;
      end if;
    end loop;
  end loop;
  return v_n;
end;
$$;

-- Statements of different sizes, straight into the table as postgres...
insert into public.hand_stats select * from pg_temp.rows_of(1, 1, 'stats/2');
insert into public.hand_stats select * from pg_temp.rows_of(2, 120, 'stats/2');
insert into public.hand_stats select * from pg_temp.rows_of(121, 250, 'stats/2');
insert into public.hand_stats select * from pg_temp.rows_of(321, 330, 'stats/2');

select is(pg_temp.in_step(), 'in step', 'after four insert statements: the summaries equal the rows summed');

-- ... and the user's own write path: save_hand_stats, one call.
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is((public.save_hand_stats((select jsonb_agg(to_jsonb(x) - 'owner_id' - 'hand_id' - 'created_at')
                                   from pg_temp.rows_of(251, 315, 'stats/2') x)) ->> 'skipped')::integer, 0,
          'save_hand_stats as A stores hands 251-315');
select pg_temp.as_postgres();
select is(pg_temp.in_step(), 'in step', '... and the summaries follow');
select ok((select count(*) from public.hero_rollups where owner_id = '00000000-0000-0000-0000-0000000045a1') between 50 and 330,
          'A has hero rollups');
select ok((select count(*) from public.player_stats where owner_id = '00000000-0000-0000-0000-0000000045a1' and player = '' and site_anonymization = 'opaque-id') > 0
          and not exists (select 1 from public.player_stats where site_anonymization = 'opaque-id' and player <> '')
          and not exists (select 1 from public.player_stats where site_anonymization = 'positional'),
          'opaque-id opponents are summed under no name, positional rooms have none');
select ok(not exists (select 1 from public.player_stats p where p.hands <= 0)
          and not exists (select 1 from public.hero_rollups r where r.hands <= 0),
          'no empty summary rows');

-- The coverage line, as its previous body counted it hand by hand.
select pg_temp.as_postgres();
create function pg_temp.stats_coverage_old(p_version text) returns jsonb language plpgsql stable set search_path = '' as $old$
declare
  v_owner uuid := (select auth.uid());
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'stats_coverage needs a stats_version.'
      using errcode = '22023';
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
    -- What the library is made of, for the screen's filter. A report over
    -- cash and tournament chips together has no win rate (chips are not
    -- money), so the screen needs to know which formats and stakes exist
    -- before it can offer the reader one of them. Sorted by volume, so the
    -- first entry is the sensible default.
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

$old$;
create function pg_temp.stats_ev_missing_old(p_version text, p_ev_version text) returns bigint language sql stable set search_path = '' as $old$
  -- Hands with hero statistics at `p_version` and no EV row at `p_ev_version`.
  select count(*)
  from public.hand_stats s
  where s.owner_id = (select auth.uid())
    and s.stats_version = p_version
    and s.is_hero
    and not exists (
      select 1 from public.hand_stats_ev e
      where e.hand_id = s.hand_id and e.ev_version = p_ev_version);

$old$;
create function pg_temp.sorted_stakes(p jsonb) returns jsonb language sql as $$
  select p || jsonb_build_object('stakes', (select coalesce(jsonb_agg(r order by r::text), '[]'::jsonb) from jsonb_array_elements(p -> 'stakes') r));
$$;
grant execute on function pg_temp.stats_coverage_old(text), pg_temp.stats_ev_missing_old(text, text), pg_temp.sorted_stakes(jsonb) to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is(pg_temp.sorted_stakes(public.stats_coverage('stats/2')), pg_temp.sorted_stakes(pg_temp.stats_coverage_old('stats/2')),
          'stats_coverage from the summaries = counted hand by hand (one version)');
select is((public.stats_coverage('stats/2') ->> 'missing')::integer, 5, '... five hands without statistics');
select pg_temp.as_postgres();

-- A second version for some hands (a version bump in progress).
insert into public.hand_stats select * from pg_temp.rows_of(1, 60, 'stats/1');
select is(pg_temp.in_step(), 'in step', 'a second version: its own summary rows');
select ok(exists (select 1 from public.hero_rollups where stats_version = 'stats/1'), '... which exist');
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is(pg_temp.sorted_stakes(public.stats_coverage('stats/2')), pg_temp.sorted_stakes(pg_temp.stats_coverage_old('stats/2')),
          'stats_coverage with two versions = as before');
select is(pg_temp.sorted_stakes(public.stats_coverage('stats/1')), pg_temp.sorted_stakes(pg_temp.stats_coverage_old('stats/1')),
          '... read at the older one');
select pg_temp.as_postgres();

-- EV rows for the hero's all-in hands (every 7th hand), and a non-applicable one.
insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
select s.hand_id, s.owner_id, s.seat, 'ev/1', s.hand_key, g.i % 7 = 0, s.net + 13, s.net_bb_milli + (case when g.i % 7 = 0 then 777 else 0 end)
from public.hand_stats s join pg_temp.gen_hands g on g.id = s.hand_id
where s.is_hero and s.stats_version = 'stats/2' and g.i % 7 in (0, 3);

-- ---------------------------------------------------------------------------
-- 3. The readers against a scan of the rows
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is(public.stats_ev_missing('stats/2', 'ev/1'), pg_temp.stats_ev_missing_old('stats/2', 'ev/1'),
          'stats_ev_missing = as before');
select ok(public.stats_ev_missing('stats/2', 'ev/1') > 0, '... some hands still without EV');

select is(pg_temp.open_diffs('{}'), 0, 'report_open: every total, no filter');
select is(pg_temp.open_diffs('{"formats":["cash"]}'), 0, '... cash');
select is(pg_temp.open_diffs('{"formats":["cash"],"stakes":["USD:200","USD:10"]}'), 0, '... two stakes');
select is(pg_temp.open_diffs('{"formats":["tournament","sng","spin"]}'), 0, '... the chip formats (no money mixing)');
select is(pg_temp.open_diffs('{"from":"2026-10-03T07:30:00Z","to":"2026-10-11T18:15:00Z"}'), 0, '... dates cut inside two days');
select is(pg_temp.open_diffs('{"from":"2026-10-05T03:00:00Z","to":"2026-10-05T21:00:00Z","formats":["cash"]}'), 0, '... a range inside one day');
select is(pg_temp.open_diffs('{"from":"2026-10-05T00:00:00Z","to":"2026-10-09T00:00:00Z"}'), 0, '... whole days');
select is(pg_temp.open_diffs('{"to":"2026-10-08T12:00:00Z","formats":["cash"]}'), 0, '... an upper bound only (no hand without a time)');
select is(pg_temp.open_diffs('{"from":"2026-10-08T12:00:00Z","formats":["cash"]}'), 0, '... a lower bound only');
select is(pg_temp.open_diffs('{"sites":["pokerstars"],"positions":["BTN","CO"],"formats":["cash"]}'), 0, '... a room and positions');
select is(pg_temp.open_diffs('{"sizes":["6max","full"],"variants":["holdem"],"limits":["nl",""],"formats":["cash"]}'), 0, '... sizes, variant, limit');
select is(pg_temp.open_diffs('{"includeBombPots":true,"includeStraddled":false,"includeCashouts":true,"formats":["cash"]}'), 0, '... the three options');
select is(pg_temp.group_diffs('{"formats":["cash"]}', 'position', 'x.pos_key'), 0, 'report_open: by position');
select is(pg_temp.group_diffs('{"formats":["cash"],"from":"2026-10-02T11:00:00Z"}', 'stake', 'x.stake_key'), 0, '... by stake, from a time');
select is(pg_temp.group_diffs('{"formats":["cash"]}', 'size', 'x.size_key'), 0, '... by table size');
select is(pg_temp.group_diffs('{"formats":["cash"]}', 'site', 'x.site_id'), 0, '... by room');
select is(pg_temp.group_diffs('{"formats":["tournament","sng"]}', 'format', 'x.game_format::text'), 0, '... by format');

select is((public.report_open('{"statsVersion":"stats/2"}') ->> 'mixedUnitKind')::boolean, true,
          'chips with cash: mixedUnitKind');
select ok(not (public.report_open('{"statsVersion":"stats/2"}') -> 'total' ? 'net_bb_milli'),
          '... and no result at all');
select ok((public.report_open('{"statsVersion":"stats/2","formats":["cash"]}') ->> 'mixedCurrency')::boolean
          and (public.report_open('{"statsVersion":"stats/2","formats":["cash"]}') -> 'total' ? 'net_bb_milli')
          and not (public.report_open('{"statsVersion":"stats/2","formats":["cash"]}') -> 'total' ? 'net'),
          'two currencies: big blinds only');

-- The all-in EV sum: the result with each applicable hand's EV in place of its result.
select is((public.report_open('{"statsVersion":"stats/2","evVersion":"ev/1","formats":["cash"]}') -> 'total' ->> 'ev_net_bb_milli')::bigint,
          (select sum(coalesce(case when e.applicable then e.ev_net_bb_milli end, x.net_bb_milli))::bigint
           from public.hand_stats x
           left join public.hand_stats_ev e on e.hand_id = x.hand_id and e.seat = x.seat and e.ev_version = 'ev/1'
           where x.owner_id = auth.uid() and x.stats_version = 'stats/2' and x.is_hero and x.game_format = 'cash'
             and not x.is_bomb_pot and not x.has_cashout),
          'report_open: the all-in EV sum');
select is((public.report_open('{"statsVersion":"stats/2","evVersion":"ev/1","formats":["cash"]}') ->> 'allInHands')::bigint,
          (select count(*) from public.hand_stats x
           join public.hand_stats_ev e on e.hand_id = x.hand_id and e.seat = x.seat and e.ev_version = 'ev/1' and e.applicable
           where x.owner_id = auth.uid() and x.stats_version = 'stats/2' and x.is_hero and x.game_format = 'cash' and not x.is_bomb_pot),
          '... and its all-in hands');

-- Facets: each group's values counted under the other groups.
select is(
  (select jsonb_object_agg(f ->> 'value', (f ->> 'count')::bigint)
     from jsonb_array_elements(public.report_facets('{"statsVersion":"stats/2","formats":["cash"],"sites":["winamax"],"from":"2026-10-04T06:00:00Z"}') -> 'sites') f),
  (select jsonb_object_agg(site_id, n) from (
     select x.site_id, count(*) filter (where x.game_format = 'cash') as n
     from public.hand_stats x
     where x.owner_id = auth.uid() and x.stats_version = 'stats/2' and x.is_hero and not x.is_bomb_pot
       and x.played_at >= '2026-10-04T06:00:00Z'
     group by x.site_id) z),
  'report_facets: rooms counted under the format (their own choice left out)');
select is(
  (select jsonb_object_agg(f ->> 'value', (f ->> 'count')::bigint)
     from jsonb_array_elements(public.report_facets('{"statsVersion":"stats/2","formats":["cash"],"sites":["winamax"]}') -> 'stakes') f),
  (select jsonb_object_agg(k, n) from (
     select case when x.game_format = 'cash' then x.currency || ':' || coalesce(x.big_blind, 0) else 'chips' end as k,
            count(*) filter (where x.game_format = 'cash' and x.site_id = 'winamax') as n
     from public.hand_stats x
     where x.owner_id = auth.uid() and x.stats_version = 'stats/2' and x.is_hero and not x.is_bomb_pot
     group by 1) z),
  '... stakes under the room and the format');
select is((public.report_facets('{"statsVersion":"stats/2","formats":["cash"],"sites":["winamax"]}') ->> 'total')::bigint,
          (public.report_open('{"statsVersion":"stats/2","formats":["cash"],"sites":["winamax"]}') ->> 'hands')::bigint,
          '... and the total is the report''s');
select ok((select bool_and(f ? 'currency' and f ? 'smallBlind' and f ? 'currencySymbol')
             from jsonb_array_elements(public.report_facets('{"statsVersion":"stats/2"}') -> 'stakes') f),
          '... a stake carries what its label needs');

-- The graph: its rule written out hand by hand. The hands in time order (a
-- hand without a time last, then by key), T = hands / points; a day of at
-- most T hands goes whole to point floor(start / T), a bigger day's hands
-- each to floor(index / T).
create function pg_temp.graph_oracle(p_filter jsonb, p_points integer) returns jsonb language sql as $$
  with x as (
    select h.*, coalesce((h.played_at at time zone 'UTC')::date, '-infinity'::date) as day,
           row_number() over (order by h.played_at asc nulls last, h.hand_key) - 1 as i,
           count(*) over () as total,
           coalesce(case when e.applicable then e.ev_net_bb_milli end, h.net_bb_milli) as ev_bb,
           coalesce(e.applicable, false) as all_in
    from public.hand_stats h
    left join public.hand_stats_ev e on e.hand_id = h.hand_id and e.seat = h.seat and e.ev_version = 'ev/1'
    where h.owner_id = auth.uid() and h.stats_version = 'stats/2' and h.is_hero and not h.is_bomb_pot
      and (p_filter -> 'formats' is null or h.game_format::text in (select jsonb_array_elements_text(p_filter -> 'formats')))
      and (p_filter -> 'sites' is null or h.site_id in (select jsonb_array_elements_text(p_filter -> 'sites')))
      and (p_filter -> 'positions' is null or coalesce(h."position", '') in (select jsonb_array_elements_text(p_filter -> 'positions')))
      and (p_filter ->> 'from' is null or h.played_at >= (p_filter ->> 'from')::timestamptz)
      and (p_filter ->> 'to' is null or h.played_at < (p_filter ->> 'to')::timestamptz)
  ),
  dd as (select day, count(*) as n, min(i) as s from x group by day),
  y as (
    select x.*, case when dd.n * p_points > x.total then (x.i * p_points) / x.total else (dd.s * p_points) / x.total end as b
    from x join dd using (day)
  ),
  p as (
    select b, count(*) as hands, count(*) filter (where not has_cashout) as money_hands,
           min(played_at) as first_played_at, max(played_at) as last_played_at,
           coalesce(sum(net_bb_milli) filter (where not has_cashout), 0) as net_bb,
           coalesce(sum(net_bb_milli) filter (where not has_cashout and wtsd > 0), 0) as sd_bb,
           coalesce(sum(net) filter (where not has_cashout), 0) as net,
           coalesce(sum(ev_bb) filter (where not has_cashout), 0) as ev_bb
    from y group by b
  )
  select jsonb_agg(to_jsonb(t) - 'b' order by t.b) from (
    select p.b, row_number() over o as bucket, p.hands, p.money_hands, p.first_played_at, p.last_played_at,
           sum(p.hands) over o as cum_hands, sum(p.money_hands) over o as cum_money_hands,
           sum(p.net_bb) over o as cum_net_bb_milli, sum(p.sd_bb) over o as cum_sd_bb_milli,
           sum(p.net_bb - p.sd_bb) over o as cum_nsd_bb_milli, sum(p.net) over o as cum_net,
           sum(p.ev_bb) over o as cum_ev_bb_milli
    from p window o as (order by p.b rows between unbounded preceding and current row)
  ) t;
$$;
create function pg_temp.graph_same(p_filter jsonb, p_points integer) returns boolean language sql as $$
  select coalesce(
    (select jsonb_agg(b - 'ev_applicable' - 'cum_net') from jsonb_array_elements(public.report_graph(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1"}', p_points) -> 'buckets') b)
    = (select jsonb_agg(b - 'cum_net') from jsonb_array_elements(pg_temp.graph_oracle(p_filter, p_points)) b),
    false);
$$;
select ok(pg_temp.graph_same('{"formats":["cash"]}', 37), 'report_graph: 37 points, cash (the rule, hand by hand)');
select ok(pg_temp.graph_same('{"formats":["cash"],"sites":["pokerstars"],"from":"2026-10-06T05:00:00Z"}', 400), '... a room from a time, more points than hands');
select ok(pg_temp.graph_same('{"formats":["cash"],"positions":["BTN","SB","BB"]}', 4), '... four points (whole days)');
select ok(pg_temp.graph_same('{"formats":["tournament","sng","spin"],"to":"2026-10-15T09:30:00Z"}', 9), '... chips, up to a time inside a day');
select is((select sum((b ->> 'hands')::bigint)::bigint from jsonb_array_elements(public.report_graph('{"statsVersion":"stats/2","formats":["cash"]}', 37) -> 'buckets') b),
          (public.report_open('{"statsVersion":"stats/2","formats":["cash"]}') ->> 'hands')::bigint,
          '... every hand of the sample in one point');
select is((public.report_graph('{"statsVersion":"stats/2","formats":["cash"]}', 37) -> 'buckets' -> -1 ->> 'cum_net_bb_milli')::bigint,
          (public.stats_graph('{"statsVersion":"stats/2","gameFormat":"cash"}', 37) -> 'buckets' -> -1 ->> 'cum_net_bb_milli')::bigint,
          '... and the same end as stats_graph''s');
select is((public.report_graph('{"statsVersion":"stats/2","formats":["cash"]}', 37) -> 'allInEv' ->> 'allInHands')::bigint,
          (public.stats_graph('{"statsVersion":"stats/2","gameFormat":"cash"}', 37) -> 'allInEv' ->> 'allInHands')::bigint,
          '... the same all-in hands');
select is(public.report_graph('{"statsVersion":"stats/2"}', 37) - 'allInEv' - 'buckets',
          public.stats_graph('{"statsVersion":"stats/2"}', 37) - 'allInEv' - 'buckets',
          '... and the same refusal for chips with cash');

-- Situations: stats_breakdown's rows.
create function pg_temp.sit_same(p_group text, p_dim text) returns boolean language sql as $$
  select coalesce(
    (select jsonb_object_agg(coalesce(r ->> 'key', ''), r - 'key') from jsonb_array_elements(public.stats_breakdown('{"statsVersion":"stats/2","gameFormat":"cash"}', p_group) -> 'rows') r)
    = (select jsonb_object_agg(r ->> 'key', r - 'key') from jsonb_array_elements(public.report_situations('{"statsVersion":"stats/2","formats":["cash"]}') -> 'groups' -> p_dim) r),
    false);
$$;
select ok(pg_temp.sit_same('pot_type', 'potType'), 'report_situations: by pot type = stats_breakdown');
select ok(pg_temp.sit_same('stack_bb', 'stack'), '... by stack');
select ok(pg_temp.sit_same('hand_class', 'handClass'), '... by starting hand');
select ok(pg_temp.sit_same('table_size', 'players'), '... by players dealt in');
select is((select sum((r ->> 'hands')::bigint)::bigint from jsonb_array_elements(public.report_situations('{"statsVersion":"stats/2","formats":["cash"],"from":"2026-10-03T07:30:00Z","to":"2026-10-11T18:15:00Z"}') -> 'groups' -> 'street') r),
          (public.report_open('{"statsVersion":"stats/2","formats":["cash"],"from":"2026-10-03T07:30:00Z","to":"2026-10-11T18:15:00Z"}') ->> 'hands')::bigint,
          '... by street: every hand of the filter once');

-- Sessions: stats_sessions' answer (which counts bomb pots).
select is(public.report_sessions('{"statsVersion":"stats/2","formats":["cash"],"includeBombPots":true}', 30),
          public.stats_sessions('{"statsVersion":"stats/2","gameFormat":"cash"}', 30),
          'report_sessions = stats_sessions, cash');
select is(public.report_sessions('{"statsVersion":"stats/2","formats":["tournament"],"stakes":["chips"],"includeBombPots":true}', 45),
          public.stats_sessions('{"statsVersion":"stats/2","gameFormat":"tournament"}', 45),
          '... tournaments, another gap');

-- stats_opponents: its previous body over every villain row.
select pg_temp.as_postgres();
create function pg_temp.stats_opponents_old(p_filters jsonb default '{}'::jsonb, p_search text default null, p_limit integer default 50)
returns jsonb language plpgsql stable set search_path = '' as $old$
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
  -- A prefix search on the name. `like` metacharacters in the input are
  -- escaped, so `%` finds a player called `%`, not everybody.
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_pattern := replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with v as (
    select s.*
    from public.hand_stats s
    where s.owner_id = v_owner
      and s.stats_version = v_version
      and not s.is_hero
      and s.player <> ''
      and (v_site is null or s.site_id = v_site)
      and (v_format is null or s.game_format = v_format)
      and (v_currency is null or s.currency = v_currency)
      and (v_big_blind is null or s.big_blind = v_big_blind)
      and not s.is_bomb_pot
  )
  select
    count(distinct (v.game_format = 'cash')),
    count(*) filter (where v.site_anonymization = 'opaque-id'),
    count(*)
  into v_kinds, v_hidden, v_total
  from v;

  with v as (
    select s.*
    from public.hand_stats s
    where s.owner_id = v_owner
      and s.stats_version = v_version
      and not s.is_hero
      and s.player <> ''
      and s.site_anonymization = 'none'
      and (v_site is null or s.site_id = v_site)
      and (v_format is null or s.game_format = v_format)
      and (v_currency is null or s.currency = v_currency)
      and (v_big_blind is null or s.big_blind = v_big_blind)
      and not s.is_bomb_pot
      and (v_pattern is null or lower(s.player) like v_pattern)
  ),
  agg as (
    select
      v.site_id                                   as site,
      v.player                                    as player,
      sum(v.hands)::bigint                        as hands,
      sum(v.vpip_opp)::bigint                     as vpip_opp,
      sum(v.vpip)::bigint                         as vpip,
      sum(v.pfr_opp)::bigint                      as pfr_opp,
      sum(v.pfr)::bigint                          as pfr,
      sum(v.three_bet_opp)::bigint                as three_bet_opp,
      sum(v.three_bet)::bigint                    as three_bet,
      sum(v.fold_to_three_bet_opp)::bigint        as fold_to_three_bet_opp,
      sum(v.fold_to_three_bet)::bigint            as fold_to_three_bet,
      sum(v.cbet_flop_opp)::bigint                as cbet_flop_opp,
      sum(v.cbet_flop)::bigint                    as cbet_flop,
      sum(v.fold_to_cbet_flop_opp)::bigint        as fold_to_cbet_flop_opp,
      sum(v.fold_to_cbet_flop)::bigint            as fold_to_cbet_flop,
      sum(v.wtsd_opp)::bigint                     as wtsd_opp,
      sum(v.wtsd)::bigint                         as wtsd,
      sum(v.wsd_opp)::bigint                      as wsd_opp,
      sum(v.wsd)::bigint                          as wsd,
      sum(v.bet_flop + v.bet_turn + v.bet_river)::bigint       as bets,
      sum(v.raise_flop + v.raise_turn + v.raise_river)::bigint as raises,
      sum(v.call_flop + v.call_turn + v.call_river)::bigint    as calls,
      sum(v.fold_flop + v.fold_turn + v.fold_river)::bigint    as folds,
      max(v.played_at)                            as last_seen,
      -- The caller's own result in the hands this opponent was dealt into.
      -- `hand_stats` has one hero row per hand at a version, so this join is
      -- one-to-one and the sum cannot double count.
      coalesce(sum(h.net_bb_milli) filter (where not h.has_cashout), 0)::bigint as hero_net_bb_milli,
      count(h.*) filter (where not h.has_cashout)::bigint                        as hero_money_hands
    from v
    left join public.hand_stats h
      on h.hand_id = v.hand_id
     and h.stats_version = v.stats_version
     and h.is_hero
    group by v.site_id, v.player
    having sum(v.hands) >= v_min
  )
  select coalesce(jsonb_agg(to_jsonb(a) order by a.hands desc, a.player), '[]'::jsonb)
  into v_rows
  from (select * from agg order by hands desc, player limit v_cap) a;

  if coalesce(v_kinds, 0) > 1 then
    v_rows := (select coalesce(jsonb_agg(r - 'hero_net_bb_milli' - 'hero_money_hands'), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r);
  end if;

  return jsonb_build_object(
    'statsVersion',  v_version,
    'rows',          v_rows,
    'mixedUnitKind', coalesce(v_kinds, 0) > 1,
    -- Villain rows that exist but were left out because the room's names do
    -- not survive a session. The screen says how many.
    'opaqueRows',    coalesce(v_hidden, 0),
    'villainRows',   coalesce(v_total, 0)
  );
end;

$old$;
grant execute on function pg_temp.stats_opponents_old(jsonb, text, integer) to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
create function pg_temp.sorted(p jsonb) returns jsonb language sql as $$
  select p || jsonb_build_object('rows', (select coalesce(jsonb_agg(r order by r::text), '[]'::jsonb) from jsonb_array_elements(p -> 'rows') r));
$$;
select is(pg_temp.sorted(public.stats_opponents(f, s, n)), pg_temp.sorted(pg_temp.stats_opponents_old(f, s, n)),
          'stats_opponents as before: ' || f::text || coalesce(' search ' || s, ''))
from (values
  ('{"statsVersion":"stats/2"}'::jsonb, null::text, 50),
  ('{"statsVersion":"stats/2","gameFormat":"cash"}', null, 50),
  ('{"statsVersion":"stats/2","gameFormat":"cash","currency":"USD","bigBlind":"200"}', null, 50),
  ('{"statsVersion":"stats/2","site":"winamax","minHands":"3"}', 'p0', 50)
) as v(f, s, n);

-- ---------------------------------------------------------------------------
-- 4. Deletes, a refused write, a rebuild
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();

-- A hand's rows go with the hand.
delete from public.hands where id in (select id from pg_temp.gen_hands where i in (5, 17, 18, 200, 260)
  or i in (select i from pg_temp.gen_hands where villains >= 2 and site_anonymization = 'none' and i between 100 and 300 order by i limit 4));
select is(pg_temp.in_step(), 'in step', 'hands deleted (their rows cascade): in step');
-- The older version pruned, in slices, as the rebuild does it.
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select public.prune_hand_stats('stats/2', 37);
select pg_temp.as_postgres();
select is(pg_temp.in_step(), 'in step', 'an old version half pruned: in step');
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select public.prune_hand_stats('stats/2', 20000);
select pg_temp.as_postgres();
select is((select count(*) from public.hero_rollups where stats_version = 'stats/1'), 0::bigint,
          '... wholly pruned: its summaries are gone');
-- The hero's row alone (an opponent's pairs with it go, the opponent stays).
delete from public.hand_stats where hand_id in (select id from pg_temp.gen_hands where i in (30, 31, 32, 99)) and is_hero;
select is(pg_temp.in_step(), 'in step', 'hero rows deleted alone: in step');
-- One opponent row of a summary with several hands, alone.
delete from public.hand_stats s
where (s.hand_id, s.stats_version, s.seat) in (
  select v.hand_id, v.stats_version, v.seat
  from public.hand_stats v
  join public.player_stats p
    on p.owner_id = v.owner_id and p.stats_version = v.stats_version and p.site_id = v.site_id
   and p.player = v.player and p.site_anonymization = v.site_anonymization and p.game_format = v.game_format
   and p.variant = coalesce(v.variant, '') and p.limit_type = coalesce(v.limit_type, '')
   and p.size = case
      when coalesce(case when coalesce(v.max_seats, 0) >= 2 then v.max_seats else v.player_count end, 0) <= 2 then 'hu'
      when case when coalesce(v.max_seats, 0) >= 2 then v.max_seats else v.player_count end <= 6 then '6max'
      else 'full'
    end and p.currency = v.currency and p.big_blind = coalesce(v.big_blind, 0)
  where not v.is_hero and not v.is_bomb_pot and v.player <> '' and p.hands >= 2
  order by v.hand_id, v.seat
  limit 1);
select ok(exists (select 1 from public.player_stats where not seen_exact), '... a deleted opponent row makes its row''s times stale');
select is(pg_temp.in_step(), 'in step', '... in step');
-- Opponent statistics switched off, then on again for some hands.
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select public.prune_villain_stats(50);
select pg_temp.as_postgres();
select is(pg_temp.in_step(), 'in step', 'opponent rows pruned in a slice: in step');
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select public.prune_villain_stats(20000);
select pg_temp.as_postgres();
select is((select count(*) from public.player_stats where owner_id = '00000000-0000-0000-0000-0000000045a1'), 0::bigint, '... all of them: no opponent summaries');
insert into public.hand_stats select r.* from pg_temp.rows_of(1, 150, 'stats/2') r
where not r.is_hero and exists (select 1 from public.hands h where h.id = r.hand_id);
select is(pg_temp.in_step(), 'in step', 'opponent rows written again beside the hero''s: in step');

-- The hero's row written after its opponents' (pairs counted from the other side).
insert into public.hand_stats select r.* from pg_temp.rows_of(30, 32, 'stats/2') r where r.is_hero;
select is(pg_temp.in_step(), 'in step', 'a hero row after its opponents: in step');

-- A write over the per-account budget is refused with its summaries.
update public.ingest_rate_limit set hits = 1000000 where bucket = 'hand_stats_insert:00000000-0000-0000-0000-0000000045a1';
create temp table before_refusal as select * from public.hero_rollups where owner_id = '00000000-0000-0000-0000-0000000045a1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select throws_ok($$ select public.save_hand_stats((select jsonb_agg(to_jsonb(x) - 'owner_id' - 'hand_id' - 'created_at')
                                                   from pg_temp.rows_of(20, 20, 'stats/3') x)) $$,
                 '53400', null, 'over the budget: refused');
select pg_temp.as_postgres();
select ok(not exists (select * from public.hero_rollups where owner_id = '00000000-0000-0000-0000-0000000045a1' except select * from before_refusal)
          and not exists (select * from before_refusal except select * from public.hero_rollups where owner_id = '00000000-0000-0000-0000-0000000045a1'),
          '... and the summaries did not move');
update public.ingest_rate_limit set hits = 0 where bucket = 'hand_stats_insert:00000000-0000-0000-0000-0000000045a1';

-- A rebuild from the rows changes nothing; one from summaries gone wrong mends them.
select public.report_summaries_rebuild('00000000-0000-0000-0000-0000000045a1');
select is(pg_temp.in_step(), 'in step', 'rebuilt: in step');
update public.hero_rollups set vpip = vpip + 5 where owner_id = '00000000-0000-0000-0000-0000000045a1';
delete from public.hero_report_rows where owner_id = '00000000-0000-0000-0000-0000000045a1' and seat = 1 and played_at < '2026-10-04';
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select ok((public.refresh_report_summaries() ->> 'heroRollups')::integer > 0, 'refresh_report_summaries as A');
select pg_temp.as_postgres();
select is(pg_temp.in_step(), 'in step', '... mends what was broken');
-- An update (no client can make one) counts its owner again.
update public.hand_stats set vpip = 0, pfr = 0 where hand_id = (select id from pg_temp.gen_hands where i = 40) and is_hero;
select is(pg_temp.in_step(), 'in step', 'an update as postgres: in step');

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-0000000045b1');
select is((select count(*) from public.hero_rollups where owner_id = '00000000-0000-0000-0000-0000000045a1'), 0::bigint, 'B sees none of A''s rollups');
select is((select count(*) from public.hero_report_rows where owner_id <> '00000000-0000-0000-0000-0000000045b1')
          + (select count(*) from public.player_stats where owner_id <> '00000000-0000-0000-0000-0000000045b1'), 0::bigint, '... nor of A''s rows and opponents');
select ok((public.report_open('{"statsVersion":"stats/2"}') ->> 'hands')::bigint
          = (select count(*) from pg_temp.gen_hands g where g.owner_id = '00000000-0000-0000-0000-0000000045b1' and not g.is_bomb_pot),
          'B''s report is B''s hands');
select pg_temp.act_as_anon();
select throws_ok($$ select public.report_open('{}') $$, '42501', null, 'anon: report_open refused');
select throws_ok($$ select count(*) from public.hero_rollups $$, '42501', null, 'anon: the rollups refused');

select * from finish();
rollback;
