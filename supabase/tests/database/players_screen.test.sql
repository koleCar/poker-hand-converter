-- pgTAP: the shared Players screen's readers on the web (R4.5c-3) --
-- `20270714090000_players_screen.sql`.
--
-- What has to hold:
--
--   * `players_list` answers what the rows answer: the opponents of rooms
--     with real names, the hero's hands with each and result against each
--     per kind, written out here over the villain and hero rows themselves
--     (not over `player_stats`), for every filter - room, kind, a name's
--     prefix (with LIKE's own characters taken literally), "with a note",
--     the limit - with the mixed-kind refusal, the opaque-id opponents
--     counted, and after deletes (first and last seen read again);
--   * `player_profile` sums the opponent's rows of a kind - in total and by
--     position, stake, game and table size - with the summary line, the
--     note and its tags, big blinds withheld when chips and cash mix, and
--     nothing for a name that is no opponent;
--   * RLS: B's answers are over B's rows only; anon cannot call them.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(46);
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
-- 1. Random rows (as `report_summaries.test.sql`)
-- ---------------------------------------------------------------------------
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


-- A's rows at one version, written as the triggers see any write; B's too.
insert into public.hand_stats select * from pg_temp.rows_of(1, 330, 'stats/9');

-- A's notes on two opponents (one with tags), one empty note with tags only.
insert into public.player_notes (owner_id, site, player, note, tags)
values ('00000000-0000-0000-0000-0000000045a1', 'pokerstars', 'p03', 'Calls too much.', '{station}'),
       ('00000000-0000-0000-0000-0000000045a1', 'winamax', 'p07', 'Three-bets light.', '{}'),
       ('00000000-0000-0000-0000-0000000045a1', 'winamax', 'p09', '', '{reg}');

-- ---------------------------------------------------------------------------
-- 2. The oracle: the list written out over the rows
-- ---------------------------------------------------------------------------
--
-- Per named opponent of A (a villain row of a room with real names, not a
-- bomb pot): the hero's hands with them and result per kind (the hero's row
-- of the same hand; an EV cashout's money out), first and last seen; the
-- rules of the desktop's `Reader::player_list` over them.

create function pg_temp.lines(p_owner uuid, p_site text) returns table (
  site text, player text, cash_hands bigint, chips_hands bigint, cash_money bigint, cash_net bigint,
  chips_money bigint, chips_net bigint, first_seen timestamptz, last_seen timestamptz, hands bigint, has_note boolean
) language sql as $$
  select v.site_id, v.player,
         count(h.hand_id) filter (where v.game_format = 'cash'),
         count(h.hand_id) filter (where v.game_format <> 'cash'),
         count(h.hand_id) filter (where v.game_format = 'cash' and not h.has_cashout),
         coalesce(sum(h.net_bb_milli) filter (where v.game_format = 'cash' and not h.has_cashout), 0)::bigint,
         count(h.hand_id) filter (where v.game_format <> 'cash' and not h.has_cashout),
         coalesce(sum(h.net_bb_milli) filter (where v.game_format <> 'cash' and not h.has_cashout), 0)::bigint,
         min(v.played_at), max(v.played_at), count(*),
         coalesce(max(n.note), '') <> ''
  from public.hand_stats v
  left join public.hand_stats h
    on h.hand_id = v.hand_id and h.stats_version = v.stats_version and h.is_hero
  left join public.player_notes n
    on n.owner_id = v.owner_id and n.site = v.site_id and n.player = v.player
  where v.owner_id = p_owner and v.stats_version = 'stats/9' and not v.is_hero and not v.is_bomb_pot
    and v.player <> '' and v.site_anonymization = 'none'
    and (p_site is null or v.site_id = p_site)
  group by v.site_id, v.player;
$$;

-- What `players_list` should answer for a query, in its shape.
create function pg_temp.list_oracle(p_owner uuid, p_query jsonb) returns jsonb language plpgsql as $$
declare
  v_kind   text := coalesce(p_query ->> 'kind', 'all');
  v_search text := lower(coalesce(p_query ->> 'search', ''));
  v_noted  boolean := (p_query ->> 'noted')::boolean;
  v_limit  integer := coalesce((p_query ->> 'limit')::integer, 200);
  v_cash   bigint;
  v_chips  bigint;
  v_mixed  boolean;
  v_rows   jsonb;
  v_players bigint;
  v_matching bigint;
  v_hidden bigint;
begin
  create temp table if not exists ls on commit drop as select * from pg_temp.lines(p_owner, null) limit 0;
  alter table ls add column if not exists together bigint;
  truncate ls;
  insert into ls select l.*, case v_kind when 'cash' then l.cash_hands when 'chips' then l.chips_hands
                                   else l.cash_hands + l.chips_hands end
                 from pg_temp.lines(p_owner, p_query ->> 'site') l;
  select coalesce(sum(cash_hands), 0), coalesce(sum(chips_hands), 0) into v_cash, v_chips from ls;
  v_mixed := v_kind = 'all' and v_cash > 0 and v_chips > 0;
  select count(*) filter (where together > 0),
         count(*) filter (where together > 0 and starts_with(lower(player), v_search)
                            and (v_noted is null or has_note = v_noted))
    into v_players, v_matching from ls;
  select coalesce(jsonb_agg(jsonb_build_object(
           'site', t.site, 'player', t.player, 'hands', t.together,
           'netBbMilli', case when v_mixed then null when v_kind = 'cash' then t.cash_net
                              when v_kind = 'chips' then t.chips_net else t.cash_net + t.chips_net end,
           'moneyHands', case v_kind when 'cash' then t.cash_money when 'chips' then t.chips_money
                                     else t.cash_money + t.chips_money end,
           'firstPlayedAt', t.first_seen, 'lastPlayedAt', t.last_seen, 'hasNote', t.has_note)
         order by t.together desc, t.player, t.site), '[]'::jsonb)
    into v_rows
    from (select * from ls
          where together > 0 and starts_with(lower(player), v_search) and (v_noted is null or has_note = v_noted)
          order by together desc, player, site limit v_limit) t;
  select coalesce(sum(1), 0) into v_hidden
    from public.hand_stats v
    where v.owner_id = p_owner and v.stats_version = 'stats/9' and not v.is_hero and not v.is_bomb_pot
      and v.player <> '' and v.site_anonymization = 'opaque-id'
      and (p_query ->> 'site' is null or v.site_id = p_query ->> 'site')
      and (v_kind = 'all' or (v.game_format = 'cash') = (v_kind = 'cash'));
  return jsonb_build_object('statsVersion', 'stats/9', 'rows', v_rows, 'matching', v_matching,
    'players', v_players, 'cashHands', v_cash, 'chipsHands', v_chips, 'mixedKind', v_mixed,
    'hiddenHands', v_hidden);
end;
$$;

-- The same answer, as a value to compare (times as instants, not text).
create function pg_temp.norm(p jsonb) returns jsonb language sql as $$
  select p - 'rows' || jsonb_build_object('rows', coalesce((
    select jsonb_agg(r || jsonb_build_object(
             'firstPlayedAt', to_jsonb((r ->> 'firstPlayedAt')::timestamptz),
             'lastPlayedAt', to_jsonb((r ->> 'lastPlayedAt')::timestamptz)) order by o)
    from jsonb_array_elements(p -> 'rows') with ordinality e(r, o)), '[]'::jsonb));
$$;

grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The list
-- ---------------------------------------------------------------------------

create temp table queries (n serial, q jsonb);
insert into queries (q) values
  ('{}'), ('{"kind":"cash"}'), ('{"kind":"chips"}'), ('{"site":"pokerstars"}'),
  ('{"site":"winamax","kind":"cash"}'), ('{"search":"P0"}'), ('{"search":"p1"}'),
  ('{"noted":true}'), ('{"noted":false,"kind":"cash"}'), ('{"limit":3}'), ('{"site":"ggpoker"}'),
  ('{"site":"ignition"}'), ('{"search":"%"}'), ('{"search":"_0"}');
grant select on queries to authenticated;

-- The oracle as postgres (it reads every row), the function as A.
create temp table expected as
  select n, pg_temp.norm(pg_temp.list_oracle('00000000-0000-0000-0000-0000000045a1', q)) as e from queries;
grant select on expected to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
create temp table actual as
  select n, pg_temp.norm(public.players_list(q || '{"statsVersion":"stats/9"}')) as a from queries;
select pg_temp.as_postgres();

select is((select a from actual where n = q.n), (select e from expected where n = q.n),
          'players_list answers the rows'' answer for ' || q.q::text)
from queries q order by q.n;

select ok((select (e -> 'rows') <> '[]'::jsonb and (e ->> 'mixedKind')::boolean from expected where n = 1),
          'the data has opponents, and a mixed list (so the result is withheld)');
select ok((select (e ->> 'hiddenHands')::bigint > 0 from expected where n = 1),
          'and opaque-id opponents, counted not listed');
select ok((select (e ->> 'matching')::int = 2 and not (e -> 'rows') @> '[{"player":"p09","site":"winamax"}]' from expected where n = 8)
            and (select jsonb_array_length(e -> 'rows') = 3 from expected where n = 10),
          'notes (a note with only tags is no note) and the limit are exercised');

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select is(public.player_sites('stats/9'), '["pokerstars", "winamax"]'::jsonb,
          'player_sites: the rooms with listed opponents');
select throws_ok($$ select public.players_list('{"kind":"spin"}') $$, '22023', null, 'an unknown kind is refused');
select is(jsonb_array_length(public.players_list('{"limit":100000,"statsVersion":"stats/9"}') -> 'rows'),
          (select (e ->> 'matching')::int from expected where n = 1), 'the limit is capped at 500, not refused');
select pg_temp.as_postgres();

-- ---------------------------------------------------------------------------
-- 4. A profile
-- ---------------------------------------------------------------------------

-- The opponent with the most rows, and one with both kinds if there is one.
create temp table subject as
  select site, player from pg_temp.lines('00000000-0000-0000-0000-0000000045a1', null)
  order by hands desc, player, site limit 1;
create temp table mixed_subject as
  select site, player from pg_temp.lines('00000000-0000-0000-0000-0000000045a1', null)
  where cash_hands > 0 and chips_hands > 0 order by hands desc, player, site limit 1;
grant select on subject, mixed_subject to authenticated;

-- Their rows of a kind summed, as the oracle.
create function pg_temp.rows_of_player(p_site text, p_player text, p_kind text) returns setof public.hand_stats language sql as $$
  select * from public.hand_stats v
  where v.owner_id = '00000000-0000-0000-0000-0000000045a1' and v.stats_version = 'stats/9'
    and not v.is_hero and not v.is_bomb_pot and v.site_anonymization = 'none'
    and v.site_id = p_site and v.player = p_player
    and (p_kind = 'all' or (v.game_format = 'cash') = (p_kind = 'cash'));
$$;
grant execute on function pg_temp.rows_of_player(text, text, text) to authenticated;

create temp table profiles as select null::text as kind, null::jsonb as p limit 0;
grant select, insert on profiles to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
insert into profiles select k, public.player_profile(s.site, s.player, k, 'stats/9')
  from subject s cross join unnest(array['all', 'cash', 'chips']) k;
insert into profiles select 'mixed', public.player_profile(s.site, s.player, 'all', 'stats/9') from mixed_subject s;
insert into profiles select 'nobody', public.player_profile('pokerstars', 'nobody-at-all', 'all', 'stats/9');
insert into profiles select 'token', public.player_profile('ggpoker', 'tok-1-2', 'all', 'stats/9');
select pg_temp.as_postgres();

select is((select p -> 'total' ->> 'hands' from profiles where kind = k)::bigint,
          (select count(*) from subject s, pg_temp.rows_of_player(s.site, s.player, k)),
          'profile (' || k || '): their hands of the kind')
from unnest(array['all', 'cash', 'chips']) k;

select is((select jsonb_build_object('vpip', p -> 'total' -> 'vpip', 'pfr_opp', p -> 'total' -> 'pfr_opp',
                                     'cbet_flop', p -> 'total' -> 'cbet_flop', 'wsd', p -> 'total' -> 'wsd',
                                     'bet_flop', p -> 'total' -> 'bet_flop', 'money_hands', p -> 'total' -> 'money_hands')
           from profiles where kind = 'cash'),
          (select jsonb_build_object('vpip', sum(r.vpip), 'pfr_opp', sum(r.pfr_opp), 'cbet_flop', sum(r.cbet_flop),
                                     'wsd', sum(r.wsd), 'bet_flop', sum(r.bet_flop),
                                     'money_hands', count(*) filter (where not r.has_cashout))
           from subject s, pg_temp.rows_of_player(s.site, s.player, 'cash') r),
          'profile: the counters are their rows'' sums, an EV cashout out of the money hands');

select is((select (p -> 'total' ->> 'net_bb_milli')::bigint from profiles where kind = 'cash'),
          (select coalesce(sum(r.net_bb_milli) filter (where not r.has_cashout), 0)::bigint
           from subject s, pg_temp.rows_of_player(s.site, s.player, 'cash') r),
          'profile: their result in big blinds, one kind');

select is((select jsonb_object_agg(g ->> 'key', (g ->> 'hands')::bigint) from profiles, jsonb_array_elements(p -> 'groups' -> 'position') g where kind = 'all'),
          (select jsonb_object_agg(k, n) from (select coalesce(r."position", '') k, count(*) n
             from subject s, pg_temp.rows_of_player(s.site, s.player, 'all') r group by 1) x),
          'profile: by position (none assigned under '''')');
select is((select jsonb_object_agg(g ->> 'key', (g ->> 'hands')::bigint) from profiles, jsonb_array_elements(p -> 'groups' -> 'stake') g where kind = 'all'),
          (select jsonb_object_agg(k, n) from (select case when r.game_format = 'cash' then r.currency || ':' || coalesce(r.big_blind, 0) else 'chips' end k, count(*) n
             from subject s, pg_temp.rows_of_player(s.site, s.player, 'all') r group by 1) x),
          'profile: by stake (USD:200, chips)');
select is((select jsonb_object_agg(g ->> 'key', (g ->> 'hands')::bigint) from profiles, jsonb_array_elements(p -> 'groups' -> 'format') g where kind = 'all'),
          (select jsonb_object_agg(r.game_format::text, n) from (select game_format, count(*) n
             from subject s, pg_temp.rows_of_player(s.site, s.player, 'all') x group by 1) r),
          'profile: by game');
select is((select sum((g ->> 'hands')::bigint) from profiles, jsonb_array_elements(p -> 'groups' -> 'size') g where kind = 'all'),
          (select (p -> 'total' ->> 'hands')::numeric from profiles where kind = 'all'),
          'profile: the table sizes add up to the total');
select ok((select bool_and(s ? 'currency' and s ? 'smallBlind' and s ->> 'key' <> 'chips')
           from profiles, jsonb_array_elements(p -> 'stakes') s where kind = 'all')
          and (select jsonb_array_length(p -> 'stakes') from profiles where kind = 'all')
              = (select count(*) from profiles, jsonb_array_elements(p -> 'groups' -> 'stake') g where kind = 'all' and g ->> 'key' <> 'chips'),
          'profile: a sample per cash stake for its label');

select is((select p -> 'seen' from profiles where kind = 'chips'),
          (select jsonb_build_object('hands', l.hands, 'firstPlayedAt', l.first_seen, 'lastPlayedAt', l.last_seen,
             'cash', jsonb_build_object('hands', l.cash_hands, 'moneyHands', l.cash_money, 'netBbMilli', l.cash_net),
             'chips', jsonb_build_object('hands', l.chips_hands, 'moneyHands', l.chips_money, 'netBbMilli', l.chips_net))
           from subject s join pg_temp.lines('00000000-0000-0000-0000-0000000045a1', null) l using (site, player)),
          'profile: what we know of them (every kind, whichever is shown)');

select ok((select (p ->> 'mixedKind')::boolean and not (p -> 'total' ? 'net_bb_milli')
                  and not exists (select 1 from jsonb_array_elements(p -> 'groups' -> 'position') g where g ? 'net_bb_milli')
           from profiles where kind = 'mixed')
          or not exists (select 1 from mixed_subject),
          'profile: chips with cash withhold the big blinds');
select is((select p -> 'notes' from profiles where kind = 'all'),
          coalesce((select jsonb_build_object('note', n.note, 'tags', to_jsonb(n.tags)) from subject s
                    join public.player_notes n on n.owner_id = '00000000-0000-0000-0000-0000000045a1' and n.site = s.site and n.player = s.player),
                   '{"note":"","tags":[]}'::jsonb),
          'profile: the note and its tags');
select ok((select p -> 'seen' = 'null'::jsonb and p -> 'groups' = '{}'::jsonb from profiles where kind = 'nobody')
          and (select p -> 'seen' = 'null'::jsonb from profiles where kind = 'token'),
          'nobody, or a session token, has no profile');

select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
select throws_ok($$ select public.player_profile('pokerstars', 'p01', 'spin', 'stats/9') $$, '22023', null,
                 'player_profile refuses an unknown kind');
select pg_temp.as_postgres();

-- ---------------------------------------------------------------------------
-- 5. After deletes: first and last seen read again
-- ---------------------------------------------------------------------------

delete from public.hands where id in (
  select h.id from pg_temp.gen_hands h where h.owner_id = '00000000-0000-0000-0000-0000000045a1' and h.i % 7 = 0);
select ok((select bool_or(not seen_exact) from public.player_stats
           where owner_id = '00000000-0000-0000-0000-0000000045a1' and site_anonymization = 'none'),
          'deleting hands left some opponents'' times stale');
truncate expected;
insert into expected select n, pg_temp.norm(pg_temp.list_oracle('00000000-0000-0000-0000-0000000045a1', q)) from queries where n in (1, 2, 4);
select pg_temp.act_as('00000000-0000-0000-0000-0000000045a1');
truncate actual;
insert into actual select n, pg_temp.norm(public.players_list(q || '{"statsVersion":"stats/9"}')) from queries where n in (1, 2, 4);
select pg_temp.as_postgres();
select is((select a from actual where n = q.n), (select e from expected where n = q.n),
          'after deletes, players_list still answers the rows'' answer for ' || q.q::text)
from queries q where q.n in (1, 2, 4) order by q.n;

-- ---------------------------------------------------------------------------
-- 6. Who may ask
-- ---------------------------------------------------------------------------

create temp table b_expected as
  select pg_temp.norm(pg_temp.list_oracle('00000000-0000-0000-0000-0000000045b1', '{}')) as e,
         (select count(*) from subject s, public.hand_stats v
          where v.owner_id = '00000000-0000-0000-0000-0000000045b1' and v.stats_version = 'stats/9' and not v.is_hero
            and not v.is_bomb_pot and v.site_id = s.site and v.player = s.player) as subject_rows;
grant select on b_expected to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000045b1');
select is(pg_temp.norm(public.players_list('{"statsVersion":"stats/9"}')), (select e from b_expected),
          'B''s list is the answer over B''s rows only');
select is(coalesce((select (public.player_profile(s.site, s.player, 'all', 'stats/9') -> 'total' ->> 'hands')::bigint from subject s), 0),
          (select subject_rows from b_expected),
          'B''s profile of a name reads B''s rows only');
select pg_temp.act_as_anon();
select throws_ok($$ select public.players_list('{}') $$, '42501', null, 'anon cannot list players');
select throws_ok($$ select public.player_profile('pokerstars', 'p01') $$, '42501', null, 'anon cannot read a profile');
select pg_temp.as_postgres();
select ok(not has_function_privilege('anon', 'public.player_sites(text)', 'execute')
          and has_function_privilege('authenticated', 'public.players_list(jsonb)', 'execute'),
          'executable by authenticated only');
select ok((select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""'])
           from pg_proc p where p.oid in ('public.players_list(jsonb)'::regprocedure,
             'public.player_profile(text, text, text, text)'::regprocedure, 'public.player_sites(text)'::regprocedure)),
          'the readers are security invoker with an empty search_path');
select is((select reason from public.username_reservations where username_lower = 'players'), 'route',
          '/players is reserved as a route, not a username');

select * from finish();
rollback;
