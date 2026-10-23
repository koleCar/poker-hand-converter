-- pgTAP: seat numbers past 24 and the per-account statistics budget
-- (docs/RAIL-PLAN.md R4.4, findings F1 and F2) -
-- `20270623093000_stats_seats_and_budget.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(24);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000f1a1', 'seats.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000f1b1', 'seats.b@example.com', now(), now());

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
-- One hero statistics row for a hand of the caller's, at `seat`.
create function pg_temp.stats_row(p_hand uuid, p_key text, p_seat integer) returns void language plpgsql as $$
begin
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands,
                                 game_format, currency, currency_minor_units, big_blind, played_at,
                                 won, contributed, net, net_bb_milli)
  values (p_hand, (select auth.uid()), 'stats/1', p_seat, p_key, 'ignition', true, 1,
          'tournament', 'T$', 1, 100, now(), 0, 100, -100, -1000);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.as_postgres(),
                          pg_temp.stats_row(uuid, text, integer) to anon, authenticated;

-- An Ignition tournament hand with the hero in seat 1 227, for each account,
-- and a second hand of A's.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000f1a1', 'ignition:mtt1', '{"schema":"phf/1"}', 'std', 'ignition', 1227, now()),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000f1a1', 'ignition:mtt2', '{"schema":"phf/1"}', 'std', 'ignition', 1227, now()),
  ('00000000-0000-0000-0000-0000000f1b01', '00000000-0000-0000-0000-00000000f1b1', 'ignition:mttb', '{"schema":"phf/1"}', 'std', 'ignition', 1227, now());

-- ---------------------------------------------------------------- F1 ---

select pg_temp.act_as('00000000-0000-0000-0000-00000000f1a1');

select lives_ok($$ select pg_temp.stats_row('00000000-0000-0000-0000-0000000f1001', 'ignition:mtt1', 1227) $$,
  'hand_stats takes an Ignition tournament seat (1227)');
select lives_ok($$ select pg_temp.stats_row('00000000-0000-0000-0000-0000000f1001', 'ignition:mtt1', 32767) $$,
  '... and any smallint seat');
select throws_ok($$ select pg_temp.stats_row('00000000-0000-0000-0000-0000000f1002', 'ignition:mtt2', -1) $$,
  '23514', null, 'a negative seat is still refused');
select is((public.save_hand_ev('[{"hand_key":"ignition:mtt1","seat":1227,"ev_version":"ev/1","applicable":false,"ev_net":-100,"ev_net_bb_milli":-1000}]'::jsonb) ->> 'inserted')::int,
  1, 'hand_stats_ev takes seat 1227 through save_hand_ev');
select throws_ok($$ select public.save_hand_ev('[{"hand_key":"ignition:mtt2","seat":-1,"ev_version":"ev/1","applicable":false,"ev_net":0,"ev_net_bb_milli":0}]'::jsonb) $$,
  '23514', null, '... and refuses a negative one');
select is((public.save_hand_analysis('[{"hand_id":"00000000-0000-0000-0000-0000000f1001","analysis_version":"analysis/1",
   "status":"not-analysed","reason":"tournament","hero_seat":1227,"pot_type":"single-raised","approximations":[],"decisions":[]}]'::jsonb) ->> 'inserted')::int,
  1, 'hand_analysis takes a tournament hand''s hero seat 1227');

select pg_temp.as_postgres();
select throws_ok($$ insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason, hero_seat)
  values ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000f1a1', 'analysis/1', 'not-analysed', 'tournament', -1) $$,
  '23514', null, '... and refuses a negative one');
select is(pg_get_constraintdef((select oid from pg_constraint where conname = 'comments_anchor_seat_ok')),
  'CHECK (((anchor_seat IS NULL) OR (anchor_seat >= 1)))', 'a forum comment may anchor any seat from 1');
select is((select count(*)::int from pg_constraint c
            where c.connamespace = 'public'::regnamespace and c.contype = 'c'
              and pg_get_constraintdef(c.oid) ~ '\m(hero_|anchor_)?seat <= 24'),
  0, 'no seat-number check stops at 24 any more (max_seats, a count, still does)');

-- ---------------------------------------------------------------- F2 ---

-- What A's two statistics writes above (two rows + one EV row) charged.
select is((select hits from public.ingest_rate_limit where bucket = 'hand_stats_insert:00000000-0000-0000-0000-00000000f1a1'),
  3, 'statistics and EV rows are charged to the account''s own bucket');
select is((select hits from public.ingest_rate_limit where bucket = 'hand_stats_insert_day:00000000-0000-0000-0000-00000000f1a1'),
  3, '... and its day bucket');
select ok((select hits from public.ingest_rate_limit where bucket = 'hand_stats_insert') >= 3,
  '... and the global ceiling');
select ok(not exists (select 1 from public.ingest_rate_limit where bucket like 'hand_stats_insert%00000000f1b1'),
  'B has spent nothing');

-- A exhausts the 10-minute budget.
update public.ingest_rate_limit set hits = 1000000
 where bucket = 'hand_stats_insert:00000000-0000-0000-0000-00000000f1a1';

select pg_temp.act_as('00000000-0000-0000-0000-00000000f1a1');
select throws_ok($$ select pg_temp.stats_row('00000000-0000-0000-0000-0000000f1002', 'ignition:mtt2', 1) $$,
  '53400', null, 'A over its budget: statistics refused');
select throws_ok($$ select public.save_hand_ev('[{"hand_key":"ignition:mtt2","seat":1,"ev_version":"ev/1","applicable":false,"ev_net":0,"ev_net_bb_milli":0}]'::jsonb) $$,
  '53400', null, '... and EV rows, the same budget');

select pg_temp.act_as('00000000-0000-0000-0000-00000000f1b1');
select lives_ok($$ select pg_temp.stats_row('00000000-0000-0000-0000-0000000f1b01', 'ignition:mttb', 1227) $$,
  'B is not blocked by A''s budget');

select pg_temp.as_postgres();
select is((select hits from public.ingest_rate_limit where bucket = 'hand_stats_insert:00000000-0000-0000-0000-00000000f1b1'),
  1, 'B''s row went to B''s bucket');
select is((select hits from public.ingest_rate_limit where bucket = 'hand_stats_insert:00000000-0000-0000-0000-00000000f1a1'),
  1000000, 'A''s refused writes charged nothing');

-- The day budget is its own limit.
update public.ingest_rate_limit set hits = 0
 where bucket = 'hand_stats_insert:00000000-0000-0000-0000-00000000f1a1';
update public.ingest_rate_limit set hits = 10000000
 where bucket = 'hand_stats_insert_day:00000000-0000-0000-0000-00000000f1a1';
select pg_temp.act_as('00000000-0000-0000-0000-00000000f1a1');
select throws_ok($$ select pg_temp.stats_row('00000000-0000-0000-0000-0000000f1002', 'ignition:mtt2', 1) $$,
  '53400', null, 'A over its day budget: refused');

-- The global ceiling still stops everyone.
select pg_temp.as_postgres();
update public.ingest_rate_limit set hits = 3000000 where bucket = 'hand_stats_insert';
select pg_temp.act_as('00000000-0000-0000-0000-00000000f1b1');
select throws_ok($$ select public.save_hand_ev('[{"hand_key":"ignition:mttb","seat":1227,"ev_version":"ev/1","applicable":false,"ev_net":0,"ev_net_bb_milli":0}]'::jsonb) $$,
  '53400', null, 'the global ceiling refuses B too');

-- Clients cannot charge (or burn) a budget directly.
select throws_ok($$ select public.hand_stats_charge_budget('00000000-0000-0000-0000-00000000f1a1', 1) $$,
  '42501', null, 'authenticated cannot call hand_stats_charge_budget');

-- anon: still nothing.
select pg_temp.act_as_anon();
select throws_ok($$ insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands,
                                 game_format, currency, currency_minor_units, played_at, won, contributed, net, net_bb_milli)
  values ('00000000-0000-0000-0000-0000000f1b01', '00000000-0000-0000-0000-00000000f1b1', 'stats/1', 1227, 'ignition:mttb', 'ignition', true, 1,
          'tournament', 'T$', 1, now(), 0, 0, 0, 0) $$,
  '42501', null, 'anon cannot insert statistics');
select throws_ok($$ select public.save_hand_ev('[]'::jsonb) $$, '42501', null, 'anon cannot call save_hand_ev');
select throws_ok($$ select public.hand_stats_charge_budget('00000000-0000-0000-0000-00000000f1a1', 1) $$,
  '42501', null, 'anon cannot call hand_stats_charge_budget');

select * from finish();
rollback;
