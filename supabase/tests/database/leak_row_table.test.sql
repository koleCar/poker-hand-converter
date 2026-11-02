-- pgTAP: postflop leak rows carry their hand's table (`20271102090000_leak_row_table.sql`).
--
-- What has to hold:
--
--   * security: the table helper is immutable with an empty search_path,
--     executable by `authenticated` (the invoker scan calls it), not by
--     `anon`; the row trigger and the backfill are definer with an empty
--     search_path and executable by no client role; the scan stays invoker,
--     gated (R6.2) and executable by `authenticated` only; no client write
--     grant on the leak tables;
--   * the helper picks the set as `pickChartSet` does: the table by the
--     players dealt in, the depth nearest the effective stack of the players
--     still in at the flop, within 20%; '' for anything no set answers;
--   * a flop, turn or river leak row written by `save_hand_analysis` carries
--     its hand's set (heads-up 100bb and 150bb, 6-max, 9-max), a preflop row
--     keeps what it had (the chart grade's set, '' off the charts), a hand no
--     set answers keeps '';
--   * the leak finder reads the set: `analysis_leaks` from the sums and from
--     its scan (a hand-list filter) give the same rows; the sums equal a
--     rebuild;
--   * the backfill gives old rows (written before this migration) the set,
--     recounts the sums to what a rebuild counts, and finds nothing the
--     second time;
--   * one account never reads another's rows.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(34);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000011e7a1', 'leakrow.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000011e7b1', 'leakrow.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.as_postgres() to anon, authenticated;

-- A PHF with what the helper reads: the game, the players (position, hero,
-- starting stack in cents at a $1 big blind) and the preflop folds.
create function pg_temp.phf(p_format text, p_players jsonb, p_folds int[] default '{}', p_extra jsonb default '[]')
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'game', jsonb_build_object('variant', 'holdem', 'limit', 'nl', 'format', p_format, 'bigBlind', 100, 'smallBlind', 50),
    'players', (select jsonb_agg(jsonb_build_object('seat', (n)::int, 'name', 'p' || n, 'position', p ->> 0,
                                                    'isHero', (p ->> 2)::boolean, 'startingStack', (p ->> 1)::numeric * 100)
                                 order by n)
                from jsonb_array_elements(p_players) with ordinality as e(p, n)),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('street', 'preflop', 'seat', s, 'type', 'fold') order by s)
                         from unnest(p_folds) s), '[]'::jsonb) || p_extra);
$$;
grant execute on function pg_temp.phf(text, jsonb, int[], jsonb) to authenticated;

-- ----------------------------------------------------------- security --

select ok(
  (select p.provolatile = 'i' and not p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.oid = 'public.analysis_hand_table_set(jsonb)'::regprocedure),
  'the table helper is immutable, invoker, with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.analysis_hand_table_set(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_hand_table_set(jsonb)', 'execute'),
  '... executable by authenticated (the scan calls it), not by anon');
select ok(
  (select bool_and(p.prosecdef) and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and count(*) = 2
   from pg_proc p
   where p.oid in ('public.analysis_leak_rows_table_set()'::regprocedure,
                   'public.analysis_leak_rows_table_backfill()'::regprocedure)),
  'the row trigger and the backfill are security definer with an empty search_path');
select ok(
  not has_function_privilege('authenticated', 'public.analysis_leak_rows_table_set()', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_rows_table_set()', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_leak_rows_table_backfill()', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_rows_table_backfill()', 'execute'),
  '... executable by no client role');
select is(
  (select count(*)::int from pg_trigger t
   where t.tgrelid = 'public.analysis_leak_rows'::regclass and t.tgname = 'analysis_leak_rows_table_set'
     and t.tgfoid = 'public.analysis_leak_rows_table_set()'::regprocedure
     and (t.tgtype & 1) = 1      -- row
     and (t.tgtype & 2) = 2      -- before
     and (t.tgtype & 4) = 4      -- insert
     and (t.tgtype & 24) = 0),   -- not delete, not update
  1, 'analysis_leak_rows carries the before-insert row trigger');
select ok(
  (select not p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
          and position('public.require_entitlement(''analysis'')' in pg_get_functiondef(p.oid)) > 0
   from pg_proc p where p.oid = 'public.analysis_leaks_scan(jsonb)'::regprocedure),
  'the re-created scan is invoker, empty search_path, and keeps its R6.2 entitlement gate');
select ok(
  has_function_privilege('authenticated', 'public.analysis_leaks_scan(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leaks_scan(jsonb)', 'execute'),
  '... executable by authenticated, not by anon');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('analysis_leak_rows', 'analysis_leak_totals', 'analysis_leak_stake_totals')
     and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'),
  0, 'still no client write grant on the leak rows and sums');

-- --------------------------------------------------------- the helper --

select is(public.analysis_hand_table_set(pg_temp.phf('cash', '[["SB",100,true],["BB",120,false]]')),
  'nlhe-cash-hu-100bb', 'heads-up at 100bb effective: the heads-up 100bb set');
select is(public.analysis_hand_table_set(pg_temp.phf('cash', '[["SB",160,false],["BB",145,true]]')),
  'nlhe-cash-hu-150bb', 'heads-up at 145bb: the heads-up 150bb set');
select is(public.analysis_hand_table_set(pg_temp.phf('cash',
    '[["UTG",100,false],["HJ",100,false],["CO",300,false],["BTN",100,false],["SB",100,false],["BB",100,true]]', '{1,2,3,5}')),
  'nlhe-cash-6max-100bb', 'six dealt in, the deep cutoff folded: 6-max 100bb');
select is(public.analysis_hand_table_set(pg_temp.phf('cash',
    '[["UTG",100,false],["HJ",100,false],["CO",300,false],["BTN",100,false],["SB",100,false],["BB",210,true]]', '{1,2,4,5}')),
  'nlhe-cash-6max-200bb', '... the deep cutoff still in against a deep hero: 6-max 200bb (the deepest opponent in)');
select is(public.analysis_hand_table_set(pg_temp.phf('cash',
    '[["SB",100,false],["BB",100,true],["BTN",60,false]]')),
  'nlhe-cash-6max-100bb', 'three-handed reads on a 6-max set');
select is(public.analysis_hand_table_set(pg_temp.phf('cash',
    '[["UTG",100,false],["UTG+1",100,false],["UTG+2",100,false],["LJ",100,false],["HJ",100,false],["CO",100,false],["BTN",100,true],["SB",100,false],["BB",100,false]]')),
  'nlhe-cash-9max-100bb', 'nine dealt in: the 9-max 100bb set');
select is(
  array[public.analysis_hand_table_set(pg_temp.phf('tournament', '[["SB",100,true],["BB",100,false]]')),
        public.analysis_hand_table_set(pg_temp.phf('cash', '[["SB",100,true],["BB",100,false]]', '{}',
                                                   '[{"street":"preflop","seat":1,"type":"straddle"}]')),
        public.analysis_hand_table_set(pg_temp.phf('cash', '[["SB",30,true],["BB",100,false]]')),
        public.analysis_hand_table_set(pg_temp.phf('cash', '[["SB",100,false],["BB",100,false]]')),
        public.analysis_hand_table_set(pg_temp.phf('cash',
          '[["A",100,false],["B",100,false],["C",100,false],["D",100,false],["E",100,false],["F",100,false],["G",100,false],["H",100,false],["I",100,false],["J",100,true]]')),
        public.analysis_hand_table_set('{"schema":"phf/1"}'),
        public.analysis_hand_table_set('[1,2]'),
        public.analysis_hand_table_set(null)],
  array['', '', '', '', '', '', '', ''],
  'no set: a tournament, a straddle, 30bb heads-up (outside every band), no hero, ten players, no players, junk, null');

-- ------------------------------------------------------------ the data --
--
--   h1 HU  100bb: preflop chart (hu-100bb) fold-call, flop BB caller oop vs bet fold (mistake), river (good)
--   h2 HU  150bb: preflop chart (hu-150bb), flop BB caller oop vs bet fold (blunder)
--   h3 6-max 100bb: preflop chart (6max-100bb), flop BB caller oop vs bet fold (mistake), turn (inaccurate)
--   h4 9-max 100bb: preflop heuristic (no set), river pfr ip first check (mistake)
--   h5 no PHF to read: flop BB caller oop vs bet fold (mistake)
--   B  HU 100bb: flop BB caller oop vs bet fold (mistake)

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-00000011e701', '00000000-0000-0000-0000-00000011e7a1', 'weplay:lr1',
   pg_temp.phf('cash', '[["SB",110,false],["BB",100,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Qh','Jh'], '2026-10-30T10:00:00Z'),
  ('00000000-0000-0000-0000-00000011e702', '00000000-0000-0000-0000-00000011e7a1', 'weplay:lr2',
   pg_temp.phf('cash', '[["SB",150,false],["BB",150,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Kc','Qd'], '2026-10-30T11:00:00Z'),
  ('00000000-0000-0000-0000-00000011e703', '00000000-0000-0000-0000-00000011e7a1', 'weplay:lr3',
   pg_temp.phf('cash', '[["UTG",100,false],["HJ",100,false],["CO",100,false],["BTN",100,false],["SB",100,false],["BB",100,true]]', '{1,2,3,5}'),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['As','Td'], '2026-10-30T12:00:00Z'),
  ('00000000-0000-0000-0000-00000011e704', '00000000-0000-0000-0000-00000011e7a1', 'weplay:lr4',
   pg_temp.phf('cash', '[["UTG",100,false],["UTG+1",100,false],["UTG+2",100,false],["LJ",100,false],["HJ",100,false],["CO",100,false],["BTN",100,true],["SB",100,false],["BB",100,false]]', '{1,2,3,4,5,6,8}'),
   'std', 'weplay', 7, 'BTN', 'cash', 'USD', 100, 50, 100, 50, array['9s','8s'], '2026-10-30T13:00:00Z'),
  ('00000000-0000-0000-0000-00000011e705', '00000000-0000-0000-0000-00000011e7a1', 'weplay:lr5',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0, array['7c','2d'], '2026-10-30T14:00:00Z'),
  ('00000000-0000-0000-0000-00000011eb01', '00000000-0000-0000-0000-00000011e7b1', 'weplay:lrb1',
   pg_temp.phf('cash', '[["SB",100,false],["BB",100,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0, array['Ah','Ad'], '2026-10-30T15:00:00Z');

create function pg_temp.dec(p_ord int, p_ai int, p_street text, p_action text, p_scenario text, p_source text,
                            p_grade text, p_ev numeric, p_best text, p_facts jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'ord', p_ord, 'action_index', p_ai, 'street', p_street, 'action', p_action, 'status', 'analysed',
    'node', 'n', 'scenario', p_scenario, 'source', p_source, 'grade', p_grade,
    'score', case p_grade when 'perfect' then 100 when 'good' then 90 when 'inaccurate' then 70
                          when 'mistake' then 40 when 'blunder' then 10 end,
    'ev_loss_bb', p_ev, 'ev_loss_pot', p_ev / 10, 'freq_diff', 0,
    'options', case when p_best is null then '[]'::jsonb else jsonb_build_array(
                 jsonb_build_object('action', p_action, 'freq', 0.1, 'ev', 0),
                 jsonb_build_object('action', p_best, 'freq', 0.9, 'ev', 1)) end,
    'chosen', 0, 'flags', '[]'::jsonb, 'approximations', '[]'::jsonb, 'facing_bet', false, 'pot_bb', 5,
    'facts', p_facts);
$$;
create function pg_temp.hand(p_id text, p_decisions jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('hand_id', p_id, 'analysis_version', 'analysis/37', 'status', 'full', 'hero_seat', 2,
                            'pot_type', 'single-raised', 'grade', 'good', 'score', 80, 'ev_loss_bb', 0, 'ev_loss_pot', 0,
                            'approximations', '[]'::jsonb, 'decisions', p_decisions);
$$;
grant execute on function pg_temp.dec(int, int, text, text, text, text, text, numeric, text, jsonb),
                          pg_temp.hand(text, jsonb) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000011e7a1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.hand('00000000-0000-0000-0000-00000011e701', jsonb_build_array(
    pg_temp.dec(0, 3, 'preflop', 'call', 'vs-open', 'chart', 'perfect', 0, 'call',
      '{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-hu-100bb","line":"r"}}'),
    pg_temp.dec(1, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 1.5, 'call', '{"position":"BB"}'),
    pg_temp.dec(2, 9, 'river', 'check', 'caller-oop-first', 'solver', 'good', 0.2, 'bet', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000011e702', jsonb_build_array(
    pg_temp.dec(0, 3, 'preflop', 'call', 'vs-open', 'chart', 'perfect', 0, 'call',
      '{"handClass":"KQo","position":"BB","chart":{"set":"nlhe-cash-hu-150bb","line":"r"}}'),
    pg_temp.dec(1, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'blunder', 3.0, 'call', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000011e703', jsonb_build_array(
    pg_temp.dec(0, 7, 'preflop', 'call', 'vs-open', 'chart', 'perfect', 0, 'call',
      '{"handClass":"ATo","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf"}}'),
    pg_temp.dec(1, 10, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 1.0, 'call', '{"position":"BB"}'),
    pg_temp.dec(2, 13, 'turn', 'check', 'caller-oop-first', 'solver', 'inaccurate', 0.4, 'bet', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000011e704', jsonb_build_array(
    pg_temp.dec(0, 7, 'preflop', 'raise', 'unopened', 'heuristic', 'good', 0.1, 'raise', '{"position":"BTN"}'),
    pg_temp.dec(1, 12, 'river', 'check', 'pfr-ip-first', 'solver', 'mistake', 0.9, 'bet', '{"position":"BTN"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000011e705', jsonb_build_array(
    pg_temp.dec(0, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 0.7, 'call', '{"position":"BB"}')))
)) ->> 'decisions')::int, 11, 'A''s five hands are saved through save_hand_analysis (11 decisions)');
select pg_temp.act_as('00000000-0000-0000-0000-00000011e7b1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.hand('00000000-0000-0000-0000-00000011eb01', jsonb_build_array(
    pg_temp.dec(0, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 2.0, 'call', '{"position":"BB"}')))
)) ->> 'decisions')::int, 1, '... and B''s one');

select pg_temp.as_postgres();
create temp table expected (hand_id uuid, street text, chart_set text);
insert into expected values
  ('00000000-0000-0000-0000-00000011e701', 'preflop', 'nlhe-cash-hu-100bb'),
  ('00000000-0000-0000-0000-00000011e701', 'flop',    'nlhe-cash-hu-100bb'),
  ('00000000-0000-0000-0000-00000011e701', 'river',   'nlhe-cash-hu-100bb'),
  ('00000000-0000-0000-0000-00000011e702', 'preflop', 'nlhe-cash-hu-150bb'),
  ('00000000-0000-0000-0000-00000011e702', 'flop',    'nlhe-cash-hu-150bb'),
  ('00000000-0000-0000-0000-00000011e703', 'preflop', 'nlhe-cash-6max-100bb'),
  ('00000000-0000-0000-0000-00000011e703', 'flop',    'nlhe-cash-6max-100bb'),
  ('00000000-0000-0000-0000-00000011e703', 'turn',    'nlhe-cash-6max-100bb'),
  ('00000000-0000-0000-0000-00000011e704', 'preflop', ''),
  ('00000000-0000-0000-0000-00000011e704', 'river',   'nlhe-cash-9max-100bb'),
  ('00000000-0000-0000-0000-00000011e705', 'flop',    ''),
  ('00000000-0000-0000-0000-00000011eb01', 'flop',    'nlhe-cash-hu-100bb');
grant select on expected to authenticated;

select results_eq(
  $$select hand_id, street, chart_set from public.analysis_leak_rows order by hand_id, ord$$,
  $$select hand_id, street, chart_set from expected
    order by hand_id, array_position(array['preflop','flop','turn','river'], street)$$,
  'each postflop row carries its hand''s table (heads-up 100 and 150bb, 6-max, 9-max), preflop rows keep theirs, '
  'a hand with nothing to read keeps ''''');

select is(
  (select array_agg(chart_set || ':' || decisions order by chart_set) from public.analysis_leak_totals
   where owner_id = '00000000-0000-0000-0000-00000011e7a1' and spot_key = 'flop|caller-oop-vs-bet||BB|fold|call'),
  array[':1', 'nlhe-cash-6max-100bb:1', 'nlhe-cash-hu-100bb:1', 'nlhe-cash-hu-150bb:1'],
  'the leak sums keep the flop spot once per table');
select is(
  (select array_agg(chart_set || ':' || decisions order by chart_set) from public.analysis_leak_stake_totals
   where owner_id = '00000000-0000-0000-0000-00000011e7a1' and spot_key = 'flop|caller-oop-vs-bet||BB|fold|call'),
  array[':1', 'nlhe-cash-6max-100bb:1', 'nlhe-cash-hu-100bb:1', 'nlhe-cash-hu-150bb:1'],
  '... and so do the room and stake sums');

-- ------------------------------------------------------ the leak finder --

create function pg_temp.sets_of(p_out jsonb, p_key text) returns text[] language sql as $$
  select array_agg(coalesce(r ->> 'set', '') || ':' || (r ->> 'decisions') order by coalesce(r ->> 'set', ''))
  from jsonb_array_elements(p_out -> 'rows') r where r ->> 'key' = p_key;
$$;
grant execute on function pg_temp.sets_of(jsonb, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000011e7a1');
select is(pg_temp.sets_of(public.analysis_leaks('{"analysisVersion":"analysis/37"}'), 'flop|caller-oop-vs-bet||BB|fold|call'),
  array[':1', 'nlhe-cash-6max-100bb:1', 'nlhe-cash-hu-100bb:1', 'nlhe-cash-hu-150bb:1'],
  'analysis_leaks names each postflop row''s set (one row per table; none where the hand names none)');
select is(pg_temp.sets_of(public.analysis_leaks('{"analysisVersion":"analysis/37","street":"flop"}'), 'flop|caller-oop-vs-bet||BB|fold|call'),
  array[':1', 'nlhe-cash-6max-100bb:1', 'nlhe-cash-hu-100bb:1', 'nlhe-cash-hu-150bb:1'],
  '... and so does its scan (a hand-list filter)');
select is(
  (select array_agg(coalesce(r ->> 'set', '') || '|' || (r ->> 'key') || '|' || (r ->> 'decisions')
                    order by r ->> 'key', coalesce(r ->> 'set', ''))
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/37"}') -> 'rows') r
   where r ->> 'street' <> 'preflop'),
  (select array_agg(coalesce(r ->> 'set', '') || '|' || (r ->> 'key') || '|' || (r ->> 'decisions')
                    order by r ->> 'key', coalesce(r ->> 'set', ''))
   from unnest(array['flop', 'turn', 'river']) s,
        jsonb_array_elements(public.analysis_leaks(jsonb_build_object('analysisVersion', 'analysis/37', 'street', s)) -> 'rows') r
   -- (the street filter keeps the hands that reached it, with all their decisions)
   where r ->> 'street' = s),
  'the sums and the scan give the same postflop rows and sets');
select is(
  (select count(*)::int from public.analysis_leak_rows where hand_id = '00000000-0000-0000-0000-00000011eb01'),
  0, 'A reads none of B''s leak rows');
select pg_temp.act_as('00000000-0000-0000-0000-00000011e7b1');
select is(pg_temp.sets_of(public.analysis_leaks('{"analysisVersion":"analysis/37"}'), 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['nlhe-cash-hu-100bb:1'], '... and B''s leak list holds only its own heads-up flop');

-- ----------------------------------------------------- rebuild, backfill --

select pg_temp.as_postgres();
create temp table sums_now as
  select 't' as t, owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set,
         decisions, hands, non_perfect, mistakes, ev_loss_bb, ev_loss_pot, score_sum, score_sq, null::text as site
  from public.analysis_leak_totals
  union all
  select 's', owner_id, analysis_version, null, null, null, spot_key, chart_set,
         decisions, hands, non_perfect, mistakes, ev_loss_bb, ev_loss_pot, score_sum, score_sq, site
  from public.analysis_leak_stake_totals;
create function pg_temp.sums_equal() returns boolean language sql as $$
  select not exists (
    (select * from sums_now
     except
     select 't', owner_id, analysis_version, game_format, hero_position, pot_type, spot_key, chart_set,
            decisions, hands, non_perfect, mistakes, ev_loss_bb, ev_loss_pot, score_sum, score_sq, null::text
     from public.analysis_leak_totals
     except
     select 's', owner_id, analysis_version, null, null, null, spot_key, chart_set,
            decisions, hands, non_perfect, mistakes, ev_loss_bb, ev_loss_pot, score_sum, score_sq, site
     from public.analysis_leak_stake_totals))
  and (select count(*) from sums_now)
      = (select count(*) from public.analysis_leak_totals) + (select count(*) from public.analysis_leak_stake_totals);
$$;

select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-00000011e7a1');
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-00000011e7b1');
select ok(pg_temp.sums_equal(), 'the sums the triggers kept equal a rebuild');
select is((select count(*)::int from public.analysis_leak_rows r join expected e using (hand_id, street)
           where r.chart_set = e.chart_set), 12, '... which gives every row the same set');

-- Rows as they were before this migration: no set off the preflop charts,
-- the sums counted that way.
alter table public.analysis_leak_rows disable trigger analysis_leak_rows_table_set;
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-00000011e7a1');
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-00000011e7b1');
alter table public.analysis_leak_rows enable trigger analysis_leak_rows_table_set;
select is((select count(*)::int from public.analysis_leak_rows where street <> 'preflop' and chart_set <> ''), 0,
  'old rows: no postflop set');
select ok(not pg_temp.sums_equal(), '... and the sums counted without it');

select is(public.analysis_leak_rows_table_backfill(), 7, 'the backfill sets the seven postflop rows whose hand names a table');
select results_eq(
  $$select hand_id, street, chart_set from public.analysis_leak_rows order by hand_id, ord$$,
  $$select hand_id, street, chart_set from expected
    order by hand_id, array_position(array['preflop','flop','turn','river'], street)$$,
  '... to the sets the trigger gives');
select ok(pg_temp.sums_equal(), '... and recounts the sums to what a rebuild counts');
select is(public.analysis_leak_rows_table_backfill(), 0, 'a second run finds nothing to set');

-- Anon cannot call the helper or the backfill.
set local role anon;
select throws_ok($$select public.analysis_hand_table_set('{}')$$, '42501', null, 'anon cannot call the table helper');
reset role;

select * from finish();
rollback;
