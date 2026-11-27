-- pgTAP: types and the "vs fish" figures (`20271127110000_pool_types.sql`,
-- docs/POOL.md P3).
--
-- What has to hold:
--
--   * security: `player_types`, `hero_opp_rollups` owner-select only,
--     `player_type_changes` no client grant, all three in the inventory;
--     the helpers, the re-tag and the backfill are nobody's;
--     `analytics_pool_you` is an invoker for `authenticated`, gated (analysis);
--   * `player_types` follows `player_stats` (insert, update, delete) by Rail's
--     rule; opaque-id rows ('') stay untyped; a move between reg, fish and
--     neither is recorded for the re-tag, other moves are not;
--   * a hero row is tagged when written (facts first) and again when its
--     facts come after it; GG's opaque opponents leave a hand `unknown`;
--   * `hero_opp_rollups` always equals hero_report_rows summed, through
--     writes, a re-tag, a delete and the backfill;
--   * `analytics_pool_you` equals the two `report_open` calls over the "vs
--     type" it replaces, for the whole library, cash, a position, a date range
--     cut inside days, cashouts in, a group beyond the rollups and a stake;
--   * a type change is followed by the re-tag (by the function, and by the
--     worker's empty claim, never a user's), after which the figures agree
--     again; the backfill tags rows from scratch in batches;
--   * one account never sees another's; an account deletion cascades.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(49);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000e00a1', 'types.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000e00b1', 'types.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to anon, authenticated;

create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function pg_temp.as_postgres() to anon, authenticated, rail_derive;

create function pg_temp.hid(p_n bigint) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000e0' || lpad(p_n::text, 3, '0'))::uuid;
$$;
grant execute on function pg_temp.hid(bigint) to anon, authenticated;

-- ----------------------------------------------------------- security --

select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.player_types'::regclass, 'public.player_type_changes'::regclass,
                   'public.hero_opp_rollups'::regclass))
  and has_table_privilege('authenticated', 'public.player_types', 'select')
  and has_table_privilege('authenticated', 'public.hero_opp_rollups', 'select')
  and not has_table_privilege('authenticated', 'public.player_types', 'insert, update, delete')
  and not has_table_privilege('authenticated', 'public.hero_opp_rollups', 'insert, update, delete')
  and not has_table_privilege('authenticated', 'public.player_type_changes', 'select, insert, update, delete')
  and not has_table_privilege('anon', 'public.player_types', 'select')
  and not has_table_privilege('anon', 'public.hero_opp_rollups', 'select'),
  'RLS on; player_types and hero_opp_rollups owner-select, player_type_changes no client grant');
select is(
  (select count(*)::int from public.account_data_inventory
   where name in ('public.player_types', 'public.player_type_changes', 'public.hero_opp_rollups')),
  3, 'the three tables are in account_data_inventory');
select ok(
  not exists (
    select 1 from pg_proc p, unnest(array['anon', 'authenticated', 'rail_derive']) r(role)
    where p.oid in ('public.player_kind_of(numeric, numeric, numeric)'::regprocedure,
                    'public.player_types_refresh(jsonb)'::regprocedure,
                    'public.player_stats_types_follow()'::regprocedure,
                    'public.hero_opp_mix_of(uuid, text, text, uuid)'::regprocedure,
                    'public.hero_opp_mix_retag_hands(uuid, uuid[], text)'::regprocedure,
                    'public.hero_opp_rollups_follow()'::regprocedure,
                    'public.opp_mix_retag(integer, uuid, integer)'::regprocedure,
                    'public.hero_opp_mix_backfill(uuid, integer)'::regprocedure)
      and has_function_privilege(r.role, p.oid, 'execute')),
  'the helpers, the re-tag and the backfill are nobody''s');
select ok(
  has_function_privilege('authenticated', 'public.analytics_pool_you(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analytics_pool_you(jsonb)', 'execute')
  and not has_function_privilege('rail_derive', 'public.analytics_pool_you(jsonb)', 'execute')
  and (select not p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
              and position('public.require_entitlement(''analysis'')' in pg_get_functiondef(p.oid)) > 0
       from pg_proc p where p.oid = 'public.analytics_pool_you(jsonb)'::regprocedure)
  and exists (select 1 from public.entitlement_gates
              where function_sig = 'public.analytics_pool_you(jsonb)' and feature = 'analysis'),
  'analytics_pool_you: invoker for authenticated, empty search_path, gated (analysis)');

-- ---------------------------------------------------------------- types --

-- A's opponents' numbers over every hand (one segment each; the hands below add their own rows).
insert into public.player_stats (owner_id, stats_version, site_id, player, site_anonymization, game_format, variant,
                                 limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr)
values
  ('00000000-0000-0000-0000-0000000e00a1', 'stats/2', 'pokerstars', 'RegRita', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 200, 100, 100, 22, 100, 18),
  ('00000000-0000-0000-0000-0000000e00a1', 'stats/2', 'pokerstars', 'FishFred', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 200, 100, 100, 55, 100, 5),
  ('00000000-0000-0000-0000-0000000e00a1', 'stats/2', 'pokerstars', 'NewNick', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 200, 10, 10, 2, 10, 2),
  ('00000000-0000-0000-0000-0000000e00a1', 'stats/2', 'pokerstars', 'OtherOlga', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 200, 100, 100, 35, 100, 10),
  ('00000000-0000-0000-0000-0000000e00a1', 'stats/2', 'ggpoker', '', 'opaque-id', 'cash', 'holdem', 'nl', '6max', 'USD', 200, 500, 500, 300, 500, 10);

select is(
  (select string_agg(t.player || '=' || t.kind || '/' || t.n, ' ' order by t.player)
   from public.player_types t where t.owner_id = '00000000-0000-0000-0000-0000000e00a1'),
  'FishFred=fish/100 NewNick=unknown/10 OtherOlga=other/100 RegRita=reg/100',
  'player_stats written: each named opponent typed by Rail''s rule; the opaque-id rows ('''') are not');
select is(
  (select string_agg(c.player, ' ' order by c.player) from public.player_type_changes c
   where c.owner_id = '00000000-0000-0000-0000-0000000e00a1'),
  'FishFred RegRita', 'a player becoming reg or fish is recorded for the re-tag; unknown / other are not');
select is((public.opp_mix_retag(5000, '00000000-0000-0000-0000-0000000e00a1') ->> 'left')::int, 0,
  'the re-tag clears the changes (no hands yet)');

-- -------------------------------------------------------------- the hands --

-- n, owner, site, format, minor units, hero position, played at, net (milli bb), cashout, showdown, opponents in the pot.
create temporary table spec (n int, owner uuid, site text, format text, units smallint, pos text, at timestamptz,
                             net bigint, cashout boolean, sd boolean, vs text[]) on commit drop;
insert into spec values
  (1, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'BTN', '2026-11-01T12:00:00Z', 1000, false, true, '{FishFred}'),
  (2, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'CO', '2026-11-01T18:00:00Z', -2000, false, true, '{RegRita}'),
  (3, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'BTN', '2026-11-02T06:00:00Z', 3000, false, true, '{RegRita,NewNick}'),
  (4, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'SB', '2026-11-02T12:00:00Z', 500, false, false, '{NewNick}'),
  (5, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'BB', '2026-11-03T12:00:00Z', -1500, false, false, '{RegRita,FishFred}'),
  (6, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'BTN', '2026-11-03T13:00:00Z', 0, false, false, '{}'),
  (7, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'tournament', 1, 'BTN', '2026-11-04T10:00:00Z', 7000, false, false, '{FishFred}'),
  (8, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'BTN', '2026-11-04T11:00:00Z', 9000, true, false, '{RegRita}'),
  (9, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'CO', '2026-11-04T12:00:00Z', 100, false, false, '{OtherOlga}'),
  (10, '00000000-0000-0000-0000-0000000e00a1', 'ggpoker', 'cash', 100, 'BTN', '2026-11-04T13:00:00Z', 4000, false, false, '{a1b2c3d4}'),
  (11, '00000000-0000-0000-0000-0000000e00a1', 'pokerstars', 'cash', 100, 'CO', '2026-11-05T12:00:00Z', 2500, false, false, '{RegRita}'),
  (12, '00000000-0000-0000-0000-0000000e00b1', 'pokerstars', 'cash', 100, 'BTN', '2026-11-01T12:00:00Z', 600, false, false, '{FishFred}');

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position, game_format,
                          variant, limit_type, currency, currency_minor_units, small_blind, big_blind, max_seats,
                          hero_profit, hero_cards, played_at, went_to_showdown, player_names)
select pg_temp.hid(s.n), s.owner, s.site || ':types' || s.n,
       jsonb_build_object('schema', 'phf/1', 'players', '[]'::jsonb, 'actions', '[]'::jsonb),
       'std', s.site, 1, s.pos, s.format::public.game_format, 'holdem', 'nl',
       case when s.format = 'cash' then 'USD' else 'CHIPS' end, s.units, 50, 100, 6, s.net / 10,
       array['As', 'Kd'], s.at, s.sd, s.vs || array['Hero']
from spec s;
delete from public.derive_queue;

create function pg_temp.facts(p_n int) returns void language sql as $$
  insert into public.hand_facts (hand_id, owner_id, facts_version, hand_key, vs_players)
  select pg_temp.hid(s.n), s.owner, 'facts/2', s.site || ':types' || s.n, s.vs from spec s where s.n = p_n;
$$;

create function pg_temp.stats(p_n int) returns void language sql as $$
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, game_format, currency,
                                 currency_minor_units, has_cashout, player, is_hero, hands, "position", played_at,
                                 net, won, contributed, net_bb_milli, big_blind, max_seats, variant, limit_type)
  select pg_temp.hid(s.n), s.owner, 'stats/2', 1, s.site || ':types' || s.n, s.site, s.format::public.game_format,
         case when s.format = 'cash' then 'USD' else 'CHIPS' end, s.units, s.cashout, 'Hero', true, 1, s.pos, s.at,
         s.net / 10, greatest(s.net / 10, 0), greatest(-s.net / 10, 0), s.net, 100, 6, 'holdem', 'nl'
  from spec s where s.n = p_n;
$$;

-- The one pass's order (facts, then statistics) for every hand but 11,
-- whose statistics come first (an older client).
select pg_temp.facts(n) from generate_series(1, 12) n where n <> 11;
select pg_temp.stats(n) from generate_series(1, 12) n;

select is(
  (select string_agg(r.opp_mix, ' ' order by r.hand_id) from public.hero_report_rows r
   where r.hand_id = any (array(select pg_temp.hid(n) from generate_series(1, 12) n))),
  'fish regs mixed unknown fish unknown fish regs unknown unknown unknown unknown',
  'written after their facts, the hero rows are tagged: fish, regs, mixed, unknown; GG''s opaque opponents and B''s untyped ones unknown');
select pg_temp.facts(11);
select is((select r.opp_mix from public.hero_report_rows r where r.hand_id = pg_temp.hid(11)), 'regs',
  'facts written after the statistics: the hand''s hero row is tagged then');

-- The rollup as the rows say it should be.
create function pg_temp.drift(p_owner uuid) returns bigint language sql stable as $$
  with want as (
    select stats_version, opp_mix, coalesce((played_at at time zone 'UTC')::date, '-infinity'::date) as day,
           site_id, game_format, variant, limit_type, size, stake, "position", kind,
           count(*) as hands, sum(net_bb_milli) as net
    from public.hero_report_rows where owner_id = p_owner and opp_mix is not null
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
  ), have as (
    select stats_version, opp_mix, day, site_id, game_format, variant, limit_type, size, stake, "position", kind,
           hands, net_bb_milli
    from public.hero_opp_rollups where owner_id = p_owner
  )
  select count(*) from ((select * from want except select * from have) union all (select * from have except select * from want)) x;
$$;
grant execute on function pg_temp.drift(uuid) to authenticated;

select is(pg_temp.drift('00000000-0000-0000-0000-0000000e00a1') + pg_temp.drift('00000000-0000-0000-0000-0000000e00b1'),
  0::bigint, 'hero_opp_rollups equals the hero rows summed (both accounts)');

-- -------------------------------------------- the figures vs report_open --

-- What the Pool tab read before: two report_open calls over the vs type.
create function pg_temp.from_reports(p_filter jsonb) returns jsonb language sql stable as $$
  with f as (select public.report_open(p_filter || '{"vsTypes":["fish"]}') as r),
       a as (select public.report_open(p_filter || '{"vsTypes":["reg","fish"]}') as r)
  select jsonb_build_object(
    'fish', jsonb_build_object('hands', (f.r ->> 'hands')::bigint, 'moneyHands', (f.r ->> 'moneyHands')::bigint,
                               'netBbMilli', (f.r -> 'total' -> 'net_bb_milli')),
    'regsOnly', jsonb_build_object(
      'hands', (a.r ->> 'hands')::bigint - (f.r ->> 'hands')::bigint,
      'moneyHands', (a.r ->> 'moneyHands')::bigint - (f.r ->> 'moneyHands')::bigint,
      'netBbMilli', to_jsonb((a.r -> 'total' ->> 'net_bb_milli')::bigint - (f.r -> 'total' ->> 'net_bb_milli')::bigint)))
  from f, a;
$$;
grant execute on function pg_temp.from_reports(jsonb) to authenticated;

create function pg_temp.you(p_filter jsonb) returns jsonb language sql stable as $$
  select public.analytics_pool_you(p_filter) - 'statsVersion';
$$;
grant execute on function pg_temp.you(jsonb) to authenticated;

create temporary table filters (label text, f jsonb) on commit drop;
insert into filters values
  ('everything (chips and cash: no big blinds)', '{}'),
  ('cash', '{"formats":["cash"]}'),
  ('cash on the button', '{"formats":["cash"],"positions":["BTN"]}'),
  ('a date range cut inside days', '{"formats":["cash"],"from":"2026-11-01T15:00:00Z","to":"2026-11-03T12:30:00Z"}'),
  ('cashouts in', '{"formats":["cash"],"includeCashouts":true}'),
  ('a group beyond the rollups (showdown)', '{"formats":["cash"],"showdown":true}'),
  ('a stake and a room', '{"sites":["pokerstars"],"stakes":["USD:100"]}');
update filters set f = f || '{"statsVersion":"stats/2","factsVersion":"facts/2","evVersion":"ev/1"}';
grant select on filters to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000e00a1');
select is(pg_temp.you(f), pg_temp.from_reports(f), 'analytics_pool_you = report_open by vs type: ' || label)
from filters order by label;
select is(pg_temp.you('{"statsVersion":"stats/2","formats":["cash"]}'),
  '{"fish": {"hands": 2, "moneyHands": 2, "netBbMilli": -500}, "regsOnly": {"hands": 4, "moneyHands": 3, "netBbMilli": 3500}}'::jsonb,
  'cash: with a fish hands 1 and 5; regs and no fish hands 2, 3, 8 (a cashout: no money) and 11');
select is(pg_temp.you('{"statsVersion":"stats/2","vsTypes":["unknown"]}'), pg_temp.you('{"statsVersion":"stats/2"}'),
  'the filter''s own vs type is ignored (the split is the reader''s)');
select ok(
  (select count(*) > 0 from public.player_types) and (select bool_and(owner_id = auth.uid()) from public.player_types)
  and (select bool_and(owner_id = auth.uid()) from public.hero_opp_rollups),
  'A reads only A''s types and rollups');

select pg_temp.act_as('00000000-0000-0000-0000-0000000e00b1');
select is(pg_temp.you('{"statsVersion":"stats/2"}'),
  '{"fish": {"hands": 0, "moneyHands": 0, "netBbMilli": 0}, "regsOnly": {"hands": 0, "moneyHands": 0, "netBbMilli": 0}}'::jsonb,
  'B (no typed opponents) has neither; A''s hands are not B''s');
select is((select count(*)::int from public.player_types), 0, 'B reads none of A''s types');
select pg_temp.act_as(null);
select throws_ok($$select public.analytics_pool_you('{}')$$, '42501', null, 'without a user the reader refuses');
select pg_temp.as_postgres();
set local role anon;
select throws_ok($$select public.analytics_pool_you('{}')$$, '42501', null, 'anon cannot execute it');
reset role;

-- ---------------------------------------------------- a type changes --

-- NewNick plays 30 more hands, loosely: a fish now.
insert into public.player_stats (owner_id, stats_version, site_id, player, site_anonymization, game_format, variant,
                                 limit_type, size, currency, big_blind, hands, vpip_opp, vpip, pfr_opp, pfr)
values ('00000000-0000-0000-0000-0000000e00a1', 'stats/2', 'pokerstars', 'NewNick', 'none', 'cash', 'holdem', 'nl', '6max', 'USD', 500, 30, 30, 30, 30, 3);
select is(
  (select t.kind || '/' || t.n from public.player_types t
   where t.owner_id = '00000000-0000-0000-0000-0000000e00a1' and t.player = 'NewNick'),
  'fish/40', 'a player_stats write types the player again (40 hands, VPIP 80%: a fish)');
select is(
  (select string_agg(c.player, ' ') from public.player_type_changes c where c.owner_id = '00000000-0000-0000-0000-0000000e00a1'),
  'NewNick', '... and records the change');
select is((select string_agg(r.opp_mix, ' ' order by r.hand_id) from public.hero_report_rows r
           where r.hand_id in (pg_temp.hid(3), pg_temp.hid(4))), 'mixed unknown',
  'the hands NewNick played keep their tags until the re-tag (no page re-tags)');

-- A user's own drain does not re-tag; the worker's empty claim does.
select pg_temp.act_as('00000000-0000-0000-0000-0000000e00a1');
select is((select count(*)::int from public.derive_claim(10, '{}')), 0, 'A''s claim: nothing queued ...');
select pg_temp.as_postgres();
select is((select count(*)::int from public.player_type_changes where owner_id = '00000000-0000-0000-0000-0000000e00a1'), 1,
  '... and nothing re-tagged by it');
set local request.jwt.claims = '{"role":"authenticated","rail_worker":"derive"}';
set local role authenticated;
select is((select count(*)::int from public.derive_claim(10, '{}')), 0, 'the worker''s claim finds nothing queued ...');
select pg_temp.as_postgres();
select is((select string_agg(r.opp_mix, ' ' order by r.hand_id) from public.hero_report_rows r
           where r.hand_id in (pg_temp.hid(3), pg_temp.hid(4))), 'fish fish',
  '... and re-tags NewNick''s hands: both have a fish in the pot now');
select ok(not exists (select 1 from public.player_type_changes where owner_id = '00000000-0000-0000-0000-0000000e00a1')
          and pg_temp.drift('00000000-0000-0000-0000-0000000e00a1') = 0,
  'the change is done and the rollup moved with the tags');
select pg_temp.act_as('00000000-0000-0000-0000-0000000e00a1');
select is(pg_temp.you(f), pg_temp.from_reports(f), 'after the re-tag, again = report_open: ' || label)
from filters where label in ('cash', 'everything (chips and cash: no big blinds)') order by label;
select pg_temp.as_postgres();

-- opp_mix_retag itself: back to a nit (40 hands at 10% VPIP: other), one account.
update public.player_stats set vpip = 0, pfr = 0
 where owner_id = '00000000-0000-0000-0000-0000000e00a1' and player = 'NewNick' and big_blind = 500;
select is(
  (select t.kind from public.player_types t where t.owner_id = '00000000-0000-0000-0000-0000000e00a1' and t.player = 'NewNick'),
  'other', 'an update of player_stats types the player again (other)');
-- A page of one hand at a time: the player's place is kept between calls.
select is(public.opp_mix_retag(0, '00000000-0000-0000-0000-0000000e00a1', 1),
  '{"left": 1, "rows": 1, "players": 0}'::jsonb, 'opp_mix_retag pages through a player''s hands: one hand ...');
select is((select after_hand from public.player_type_changes where player = 'NewNick'), pg_temp.hid(3),
  '... its place kept ...');
select is(public.opp_mix_retag(5000, '00000000-0000-0000-0000-0000000e00a1', 1) - 'left',
  '{"rows": 1, "players": 1}'::jsonb, '... then the rest: one player, two hero rows tagged again in all');
select is((select string_agg(r.opp_mix, ' ' order by r.hand_id) from public.hero_report_rows r
           where r.hand_id in (pg_temp.hid(3), pg_temp.hid(4))), 'mixed unknown', '... mixed and unknown again');

-- --------------------------------------------------------- a delete --

delete from public.player_stats where owner_id = '00000000-0000-0000-0000-0000000e00a1' and player = 'OtherOlga';
select ok(not exists (select 1 from public.player_types where player = 'OtherOlga')
          and not exists (select 1 from public.player_type_changes where player = 'OtherOlga'),
  'player_stats rows gone: the type goes (other -> nothing: no re-tag needed)');

delete from public.hand_stats where hand_id = pg_temp.hid(1);
select ok(not exists (select 1 from public.hero_report_rows where hand_id = pg_temp.hid(1))
          and pg_temp.drift('00000000-0000-0000-0000-0000000e00a1') = 0,
  'a hand''s statistics deleted: its row leaves the rollup (subtracted)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000e00a1');
select is(pg_temp.you('{"statsVersion":"stats/2","formats":["cash"]}') -> 'fish',
  '{"hands": 1, "moneyHands": 1, "netBbMilli": -1500}'::jsonb, '... and the figure by that hand only');
select pg_temp.as_postgres();

-- ------------------------------------------------------- the backfill --

update public.hero_report_rows set opp_mix = null where owner_id = '00000000-0000-0000-0000-0000000e00a1';
select ok(not exists (select 1 from public.hero_opp_rollups where owner_id = '00000000-0000-0000-0000-0000000e00a1'),
  'rows untagged (before the backfill) are in no rollup');
create temporary table steps (n int, out jsonb) on commit drop;
insert into steps values (1, public.hero_opp_mix_backfill('00000000-0000-0000-0000-0000000e0000', 4));
insert into steps select 2, public.hero_opp_mix_backfill((out ->> 'after')::uuid, 4) from steps where n = 1;
insert into steps select 3, public.hero_opp_mix_backfill((out ->> 'after')::uuid, 3) from steps where n = 2;
select is(
  (select string_agg((out ->> 'after') || ':' || (out ->> 'tagged'), ' ' order by n) from steps),
  pg_temp.hid(5) || ':4 ' || pg_temp.hid(9) || ':4 ' || pg_temp.hid(12) || ':2',
  'hero_opp_mix_backfill pages through the hands by id, tagging each page (B''s hand 12 tagged already)');
select is(public.hero_opp_mix_backfill('ffffffff-ffff-ffff-ffff-ffffffffffff', 4),
  '{"after": "ffffffff-ffff-ffff-ffff-ffffffffffff", "done": true, "tagged": 0}'::jsonb, '... and says when it is done');
select is(
  (select string_agg(r.opp_mix, ' ' order by r.hand_id) from public.hero_report_rows r
   where r.owner_id = '00000000-0000-0000-0000-0000000e00a1'),
  'regs mixed unknown fish unknown fish regs unknown unknown regs', '... with the tags they had');
select is(pg_temp.drift('00000000-0000-0000-0000-0000000e00a1'), 0::bigint, '... and the rollup back');

-- ------------------------------------------- analytics_pool reads types --

insert into public.pool_players (owner_id, membership_version, site_id, player, field_key, seats, hands, net_bb, net_bb_sq)
values ('00000000-0000-0000-0000-0000000e00a1', 'analytics/1', 'pokerstars', 'RegRita', 'pokerstars|cash|holdem|nl|6max|USD:100', 3, 3, 1.5, 4.5),
       ('00000000-0000-0000-0000-0000000e00a1', 'analytics/1', 'pokerstars', 'FishFred', 'pokerstars|cash|holdem|nl|6max|USD:100', 2, 2, -4, 10),
       ('00000000-0000-0000-0000-0000000e00a1', 'analytics/1', 'pokerstars', 'NewNick', 'pokerstars|cash|holdem|nl|6max|USD:100', 2, 2, 1, 1);
select pg_temp.act_as('00000000-0000-0000-0000-0000000e00a1');
select is(
  (select (p -> 'reg' ->> 'players') || '/' || (p -> 'reg' ->> 'hands') || ' ' || (p -> 'fish' ->> 'players') || '/' || (p -> 'fish' ->> 'hands')
   from (select public.analytics_pool('{"statsVersion":"stats/2"}') p) x),
  '1/3 1/2', 'analytics_pool types the pool from player_types (NewNick, other, in neither)');
select pg_temp.as_postgres();

-- ---------------------------------------------------- account deletion --

delete from auth.users where id = '00000000-0000-0000-0000-0000000e00a1';
select ok(not exists (select 1 from public.player_types where owner_id = '00000000-0000-0000-0000-0000000e00a1')
          and not exists (select 1 from public.player_type_changes where owner_id = '00000000-0000-0000-0000-0000000e00a1')
          and not exists (select 1 from public.hero_opp_rollups where owner_id = '00000000-0000-0000-0000-0000000e00a1'),
  'an account deletion cascades through the types, the changes and the rollup without writing for the account');

select * from finish();
rollback;
