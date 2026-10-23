-- pgTAP: the library for the shared Hands screen (R4.5b) --
-- `20270630090000_library_list.sql`.
--
-- What has to hold:
--
--   * every filter group selects by the app's vocabulary (`rail_store::
--     hand_list`): sites, formats, variants, limits, sizes, stakes, the
--     hero's position, pot type, result, starting stack, all in; the dates
--     (from inclusive, to exclusive, a bound leaves out a hand without a
--     time); and the web's searches (hero cards, hand class, board, a player,
--     showdown);
--   * the page is newest first by default, a hand without a time last, and
--     the keyset (`next` -> `p_after`) walks every hand exactly once, in
--     every sort;
--   * the counts: per group, each value under the *other* groups; `total` is
--     the filter's, `library` the caller's;
--   * RLS: another account sees nothing of A's, anon is refused.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(52);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000b5a1', 'library.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000b5b1', 'library.b@example.com', now(), now());

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
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon() to anon, authenticated;

-- A's six hands (ids ...b501-b506) and B's one.
--   1 PokerStars $1/$2 6-max, BTN AhKh, board 2c7d Kd, +$5, showdown; stats: single-raised, 100 bb, all in (EV)
--   2 PokerStars $1/$2 9-max, BB QsQd, -$3; 3-bet pot, 30 bb
--   3 GGPoker EUR 0.05/0.10 heads-up, SB 7c2d, even; no statistics yet
--   4 Winamax tournament 6-max, CO, -1000 chips; limped, 200 bb
--   5 PokerStars $1/$2 6-max, BTN, +$1, no time, a player called Villain_X
--   6 PokerStars $1/$2 6-max, BTN, +$0.50, the earliest
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, board_cards, player_names,
                          went_to_showdown, total_pot, hero_profit, site_hand_id) values
  ('00000000-0000-0000-0000-00000000b501', '00000000-0000-0000-0000-00000000b5a1', 'pokerstars:l1', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, '2026-10-05T12:00:00Z', 1, 'BTN',
   '{Ah,Kh}', 'AKs', '{2c,7d,Kd}', '{Hero1,Opp1}', true, 1500, 500, 'l1'),
  ('00000000-0000-0000-0000-00000000b502', '00000000-0000-0000-0000-00000000b5a1', 'pokerstars:l2', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 9, 9, '2026-10-04T12:00:00Z', 1, 'BB',
   '{Qs,Qd}', 'QQ', '{}', '{Hero1,Opp2}', false, 900, -300, 'l2'),
  ('00000000-0000-0000-0000-00000000b503', '00000000-0000-0000-0000-00000000b5a1', 'ggpoker:l3', '{"schema":"phf/1"}', 'std',
   'ggpoker', 'cash', 'holdem', 'nl', 'EUR', 100, '€', 5, 10, 2, 2, '2026-10-03T12:00:00Z', 1, 'SB',
   '{7c,2d}', '72o', '{}', '{}', false, 20, 0, 'l3'),
  ('00000000-0000-0000-0000-00000000b504', '00000000-0000-0000-0000-00000000b5a1', 'winamax:l4', '{"schema":"phf/1"}', 'std',
   'winamax', 'tournament', 'holdem', 'nl', 'CHIPS', 1, '', 50, 100, 6, 6, '2026-10-02T12:00:00Z', 1, 'CO',
   '{9s,9h}', '99', '{}', '{Hero1}', false, 4000, -1000, 'l4'),
  ('00000000-0000-0000-0000-00000000b505', '00000000-0000-0000-0000-00000000b5a1', 'pokerstars:l5', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, null, 1, 'BTN',
   '{Jc,Tc}', 'JTs', '{}', '{Hero1,Villain_X}', false, 600, 100, 'l5'),
  ('00000000-0000-0000-0000-00000000b506', '00000000-0000-0000-0000-00000000b5a1', 'pokerstars:l6', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, '2026-10-01T12:00:00Z', 1, 'BTN',
   '{As,Ad}', 'AA', '{}', '{Hero1}', false, 300, 50, 'l6'),
  ('00000000-0000-0000-0000-00000000b5b9', '00000000-0000-0000-0000-00000000b5b1', 'pokerstars:lb', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 100, 200, 6, 6, '2026-10-06T12:00:00Z', 1, 'BTN',
   '{Ah,Kh}', 'AKs', '{}', '{}', false, 100, 10, 'lb');

insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, game_format,
                               currency, currency_minor_units, big_blind, played_at, won, contributed, net, net_bb_milli,
                               pot_type, starting_stack_bb_tenths) values
  ('00000000-0000-0000-0000-00000000b501', '00000000-0000-0000-0000-00000000b5a1', 'stats/2', 1, 'pokerstars:l1', 'pokerstars', true, 1, 'cash', 'USD', 100, 200, '2026-10-05T12:00:00Z', 1000, 500, 500, 2500, 'single-raised', 1000),
  ('00000000-0000-0000-0000-00000000b502', '00000000-0000-0000-0000-00000000b5a1', 'stats/2', 1, 'pokerstars:l2', 'pokerstars', true, 1, 'cash', 'USD', 100, 200, '2026-10-04T12:00:00Z', 0, 300, -300, -1500, '3bet', 300),
  ('00000000-0000-0000-0000-00000000b504', '00000000-0000-0000-0000-00000000b5a1', 'stats/2', 1, 'winamax:l4', 'winamax', true, 1, 'tournament', 'CHIPS', 1, 100, '2026-10-02T12:00:00Z', 0, 1000, -1000, -10000, 'limped', 2000),
  ('00000000-0000-0000-0000-00000000b505', '00000000-0000-0000-0000-00000000b5a1', 'stats/2', 1, 'pokerstars:l5', 'pokerstars', true, 1, 'cash', 'USD', 100, 200, null, 300, 200, 100, 500, 'single-raised', 1000),
  ('00000000-0000-0000-0000-00000000b506', '00000000-0000-0000-0000-00000000b5a1', 'stats/2', 1, 'pokerstars:l6', 'pokerstars', true, 1, 'cash', 'USD', 100, 200, '2026-10-01T12:00:00Z', 150, 100, 50, 250, 'limped', 1000);

insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli) values
  ('00000000-0000-0000-0000-00000000b501', '00000000-0000-0000-0000-00000000b5a1', 1, 'ev/1', 'pokerstars:l1', true, 300, 1500),
  ('00000000-0000-0000-0000-00000000b502', '00000000-0000-0000-0000-00000000b5a1', 1, 'ev/1', 'pokerstars:l2', false, -300, -1500);

-- The web library's other filters (tables, positions at showdown and among
-- the winners, what the names are).
update public.hands h set
  table_name = v.table_name,
  showdown_positions = v.sd,
  winner_positions = v.won,
  site_anonymization = v.anon::public.site_anonymization
from (values
  ('00000000-0000-0000-0000-00000000b501'::uuid, 'Zeta Polaris', '{BTN,BB}'::text[], '{BTN}'::text[], 'none'),
  ('00000000-0000-0000-0000-00000000b502'::uuid, 'Zeta 100%', '{BB,CO}', '{CO}', 'none'),
  ('00000000-0000-0000-0000-00000000b503'::uuid, 'Alpha', '{}', '{}', 'positional'),
  ('00000000-0000-0000-0000-00000000b504'::uuid, 'Final table', '{}', '{}', 'opaque-id'),
  ('00000000-0000-0000-0000-00000000b505'::uuid, 'zeta_ii', '{}', '{BTN}', 'none'),
  ('00000000-0000-0000-0000-00000000b506'::uuid, null, '{}', '{}', 'none')
) as v(id, table_name, sd, won, anon)
where h.id = v.id;

-- The ids of a page's rows, as the last digit ('1'..'6'), in order.
create function pg_temp.ids(p_filter jsonb, p_after jsonb default null, p_limit integer default 100) returns text
language sql as $$
  select coalesce(string_agg(right(r ->> 'handKey', 1), '' order by o), '')
  from jsonb_array_elements(public.library_page(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1"}', p_after, p_limit) -> 'rows')
       with ordinality as t(r, o);
$$;
-- Every page of a sort, walked with the cursor, `p_limit` at a time.
create function pg_temp.walk(p_filter jsonb, p_limit integer) returns text
language plpgsql as $$
declare
  v_after jsonb := null;
  v_page  jsonb;
  v_out   text := '';
begin
  loop
    v_page := public.library_page(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1"}', v_after, p_limit);
    v_out := v_out || coalesce((select string_agg(right(r ->> 'handKey', 1), '' order by o)
                                  from jsonb_array_elements(v_page -> 'rows') with ordinality as t(r, o)), '');
    v_after := v_page -> 'next';
    exit when v_after is null or jsonb_typeof(v_after) = 'null';
  end loop;
  return v_out;
end;
$$;
create function pg_temp.facets(p_filter jsonb) returns jsonb language sql as $$
  select public.library_facets(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1"}');
$$;
create function pg_temp.counts(p_facet jsonb) returns text language sql as $$
  select coalesce(string_agg((f ->> 'value') || '=' || (f ->> 'count'), ',' order by f ->> 'value'), '')
  from jsonb_array_elements(p_facet) f;
$$;
grant execute on function pg_temp.ids(jsonb, jsonb, integer), pg_temp.walk(jsonb, integer),
  pg_temp.facets(jsonb), pg_temp.counts(jsonb) to anon, authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000000b5a1');

-- ------------------------------------------------------------- the page --

select is(pg_temp.ids('{}'), '123465', 'newest first, the hand without a time last');
select is(pg_temp.walk('{}', 2), '123465', 'the cursor walks every hand once, two at a time');
select is(pg_temp.walk('{"sort":"oldest"}', 4), '643215', 'oldest first (no time still last)');
select is(pg_temp.walk('{"sort":"pot"}', 1), '412563', 'biggest pot first, one at a time');
select is(pg_temp.walk('{"sort":"won"}', 2), '156324', 'best result first');
select is(pg_temp.walk('{"sort":"lost"}', 5), '423651', 'worst result first');
select throws_ok($$ select public.library_page('{"sort":"random"}') $$, '22023', null, 'an unknown sort is refused');

select is(
  (select (public.library_page('{"statsVersion":"stats/2","evVersion":"ev/1"}', null, 1) -> 'rows' -> 0)
          - 'handKey' - 'playedAt'),
  '{"site": "pokerstars", "ante": 0, "tags": [], "board": ["2c", "7d", "Kd"], "allIn": true, "evNet": 300,
    "heroNet": 500, "hasNote": false, "potType": "single-raised", "variant": "holdem", "bigBlind": 200,
    "currency": "USD", "maxSeats": 6, "showdown": true, "totalPot": 1500, "heroCards": ["Ah", "Kh"],
    "limitType": "nl", "tableName": "Zeta Polaris", "evPending": false, "gameFormat": "cash", "minorUnits": 100,
    "siteHandId": "l1", "smallBlind": 100, "evNetBbMilli": 1500, "heroPosition": "BTN", "anonymization": "none",
    "heroHandClass": "AKs", "currencySymbol": "$", "heroNetBbMilli": 2500}'::jsonb,
  'a row in the screen''s shape');
select is(public.library_page('{}', null, 6) -> 'next', 'null'::jsonb, 'no next page after the last');

-- ---------------------------------------------------------- the groups --

select is(pg_temp.ids('{"sites":["pokerstars"]}'), '1265', 'sites');
select is(pg_temp.ids('{"sites":["ggpoker","winamax"]}'), '34', 'sites, two of them');
select is(pg_temp.ids('{"formats":["tournament"]}'), '4', 'formats');
select is(pg_temp.ids('{"sizes":["hu"]}'), '3', 'sizes: heads-up');
select is(pg_temp.ids('{"sizes":["full"]}'), '2', 'sizes: full ring');
select is(pg_temp.ids('{"stakes":["USD:200"]}'), '1265', 'stakes: a cash stake by currency and big blind');
select is(pg_temp.ids('{"stakes":["chips"]}'), '4', 'stakes: chips');
select is(pg_temp.ids('{"positions":["BTN"]}'), '165', 'the hero''s position');
select is(pg_temp.ids('{"potTypes":["limped"]}'), '46', 'pot type');
select is(pg_temp.ids('{"results":["lost"]}'), '24', 'result: lost');
select is(pg_temp.ids('{"results":["even"]}'), '3', 'result: even');
select is(pg_temp.ids('{"stacks":["0-40"]}'), '2', 'stack: under 40 bb');
select is(pg_temp.ids('{"stacks":["120+"]}'), '4', 'stack: 120 bb and more');
select is(pg_temp.ids('{"allIn":true}'), '1', 'all in');
select is(pg_temp.ids('{"allIn":false}'), '23465', 'not all in (a hand without statistics included)');
select is(pg_temp.ids('{"from":"2026-10-02T00:00:00Z","to":"2026-10-05T00:00:00Z"}'), '234',
  'dates: from inclusive, to exclusive, no time left out');
select is(pg_temp.ids('{"positions":["BTN"],"results":["won"],"sites":["pokerstars"]}'), '165', 'groups together');

-- ------------------------------------------------------- the searches --

select is(pg_temp.ids('{"heroCards":["Ah"]}'), '1', 'hero cards');
select is(pg_temp.ids('{"heroHandClasses":["QQ","AA"]}'), '26', 'hand classes');
select is(pg_temp.ids('{"board":["Kd","2c"]}'), '1', 'board cards, all of them');
select is(pg_temp.ids('{"player":"Villain_X"}'), '5', 'a player at the table');
select is(pg_temp.ids('{"showdown":true}'), '1', 'showdown');

-- ------------------------------------------- the library's other filters --

select is(pg_temp.ids('{"tableName":"ZETA"}'), '125', 'table: a part of the name, any case');
select is(pg_temp.ids('{"tableName":"eta_"}'), '5', 'table: _ and % are letters, not wildcards');
select is(pg_temp.ids('{"minPot":9}'), '124', 'minimum pot in the hand''s own unit: $9 at the dollar tables, 9 chips in the tournament');
select is(pg_temp.ids('{"minPot":0.2}'), '123465', '... and EUR 0.20 at the euro table');
select is(pg_temp.ids('{"minPot":5000}'), '', '... none past the biggest');
select is(pg_temp.ids('{"showdownPositions":["CO","UTG"]}'), '2', 'showdown positions: any of them');
select is(pg_temp.ids('{"winnerPositions":["BTN"]}'), '15', 'winner positions: any of them');
select is(pg_temp.ids('{"anonymizations":["positional","opaque-id"]}'), '34', 'names: positional and opaque-id rooms');
select is(pg_temp.counts(pg_temp.facets('{}') -> 'anonymizations'), 'none=4,opaque-id=1,positional=1', 'the names group is counted');
select is(pg_temp.counts(pg_temp.facets('{"anonymizations":["positional"]}') -> 'anonymizations'), 'none=4,opaque-id=1,positional=1',
  '... leaving its own selection out');
select is(pg_temp.counts(pg_temp.facets('{"anonymizations":["positional"]}') -> 'sites'), 'ggpoker=1,pokerstars=0,winamax=0',
  '... and narrowing the other groups');
select is(pg_temp.counts(pg_temp.facets('{"winnerPositions":["BTN"]}') -> 'sites'), 'pokerstars=2',
  'the uncounted filters narrow every group''s counts, as the dates do');

-- ---------------------------------------------------------- the counts --

select is(pg_temp.facets('{}') ->> 'total', '6', 'total: every hand');
select is(pg_temp.counts(pg_temp.facets('{}') -> 'sites'), 'ggpoker=1,pokerstars=4,winamax=1', 'the rooms');
select is(pg_temp.counts(pg_temp.facets('{"positions":["BTN"]}') -> 'positions'), 'BB=1,BTN=3,CO=1,SB=1',
  'a group''s own selection does not narrow its counts ...');
select is(pg_temp.counts(pg_temp.facets('{"positions":["BTN"]}') -> 'sites'), 'ggpoker=0,pokerstars=3,winamax=0',
  '... but narrows every other group''s (a value it leaves at none is still listed, with 0)');
select is(pg_temp.facets('{"positions":["BTN"]}') ->> 'library', '6', '... and library is every hand');
select is(pg_temp.facets('{}') -> 'stakes' -> 0,
  '{"value": "EUR:10", "count": 1, "currency": "EUR", "bigBlind": 10, "minorUnits": 100, "smallBlind": 5, "currencySymbol": "€"}'::jsonb,
  'a stake carries its unit and blinds, for its label');

-- The page's predicates and the counts' flags state each rule twice; they
-- must agree.
select is(
  (select string_agg(f::text || '=' || char_length(pg_temp.walk(f, 2))::text || '/' || (pg_temp.facets(f) ->> 'total'), ' ')
     from unnest(array[
       '{"sizes":["6max"],"results":["won"]}'::jsonb, '{"stakes":["USD:200"],"stacks":["80-120"]}',
       '{"potTypes":["limped","3bet"],"allIn":false}', '{"formats":["cash"],"positions":["BTN","SB"]}',
       '{"variants":["holdem"],"limits":["nl"],"sites":["pokerstars"],"from":"2026-10-03T00:00:00Z"}',
       '{"tableName":"zeta","anonymizations":["none"]}', '{"minPot":5,"winnerPositions":["BTN","CO"]}']) f),
  (select string_agg(f::text || '=' || n || '/' || n, ' ')
     from unnest(array[
       '{"sizes":["6max"],"results":["won"]}'::jsonb, '{"stakes":["USD:200"],"stacks":["80-120"]}',
       '{"potTypes":["limped","3bet"],"allIn":false}', '{"formats":["cash"],"positions":["BTN","SB"]}',
       '{"variants":["holdem"],"limits":["nl"],"sites":["pokerstars"],"from":"2026-10-03T00:00:00Z"}',
       '{"tableName":"zeta","anonymizations":["none"]}', '{"minPot":5,"winnerPositions":["BTN","CO"]}'],
       array['3', '3', '3', '4', '2', '3', '3']) as t(f, n)),
  'the page and the counts agree, group by group');

-- ---------------------------------------------------------- RLS --

select pg_temp.act_as('00000000-0000-0000-0000-00000000b5b1');
select is(pg_temp.ids('{}'), '9', 'B sees only B''s hand');
select pg_temp.act_as_anon();
select throws_ok($$ select public.library_page('{}') $$, '42501', null, 'anon cannot read a library');

select * from finish();
rollback;
