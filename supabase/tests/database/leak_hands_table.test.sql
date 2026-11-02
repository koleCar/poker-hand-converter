-- pgTAP: the hands behind a leak, read on its table (`20271103090000_leak_hands_table.sql`).
--
-- What has to hold:
--
--   * security: the tag helper is immutable with an empty search_path,
--     executable by `authenticated`, not by `anon`; both readers stay
--     invoker with an empty search_path, keep the R6.2 entitlement gate and
--     are executable by `authenticated` only;
--   * the helper tags a set as the leak finder does (`tableOfSet`): `hu`,
--     `9max`, `other` for 6-max, the straddle set, '' and null;
--   * without `leakTable` both readers return what they returned (every
--     table's decisions on the keys);
--   * with it, only that table's: heads-up (100 and 150bb), `other` (6-max
--     and a hand no set answers), 9-max; postflop by the hand's table,
--     preflop by the chart grade's set (off the charts: `other`); the fast
--     path (the leak rows) and the scan (a hand-list filter) agree;
--   * an unknown table is refused on both paths; one account never reads
--     another's hands; anon cannot call the helper.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(26);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000012e7a1', 'leakhands.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000012e7b1', 'leakhands.b@example.com', now(), now());

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

-- A PHF with what the table helper reads (`leak_row_table.test.sql`'s).
create function pg_temp.phf(p_format text, p_players jsonb, p_folds int[] default '{}')
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema', 'phf/1',
    'game', jsonb_build_object('variant', 'holdem', 'limit', 'nl', 'format', p_format, 'bigBlind', 100, 'smallBlind', 50),
    'players', (select jsonb_agg(jsonb_build_object('seat', (n)::int, 'name', 'p' || n, 'position', p ->> 0,
                                                    'isHero', (p ->> 2)::boolean, 'startingStack', (p ->> 1)::numeric * 100)
                                 order by n)
                from jsonb_array_elements(p_players) with ordinality as e(p, n)),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('street', 'preflop', 'seat', s, 'type', 'fold') order by s)
                         from unnest(p_folds) s), '[]'::jsonb));
$$;

-- ----------------------------------------------------------- security --

select ok(
  (select p.provolatile = 'i' and not p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.oid = 'public.analysis_leak_table_of(text)'::regprocedure),
  'the tag helper is immutable, invoker, with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.analysis_leak_table_of(text)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_table_of(text)', 'execute'),
  '... executable by authenticated (the readers call it), not by anon');
select ok(
  (select bool_and(not p.prosecdef)
          and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and bool_and(position('public.require_entitlement(''analysis'')' in pg_get_functiondef(p.oid)) > 0)
          and count(*) = 2
   from pg_proc p
   where p.oid in ('public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)'::regprocedure,
                   'public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer)'::regprocedure)),
  'both re-created readers are invoker, empty search_path, and keep their R6.2 entitlement gate');
select ok(
  has_function_privilege('authenticated', 'public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer)', 'execute'),
  '... executable by authenticated, not by anon');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('analysis_leak_rows', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'),
  0, 'still no client write grant on the leak rows or the decisions');

-- --------------------------------------------------------- the helper --

select is(
  array[public.analysis_leak_table_of('nlhe-cash-hu-100bb'), public.analysis_leak_table_of('nlhe-cash-hu-150bb'),
        public.analysis_leak_table_of('nlhe-cash-9max-100bb'), public.analysis_leak_table_of('nlhe-cash-9max-200bb'),
        public.analysis_leak_table_of('nlhe-cash-6max-100bb'), public.analysis_leak_table_of('nlhe-cash-6max-100bb-straddle'),
        public.analysis_leak_table_of(''), public.analysis_leak_table_of(null)],
  array['hu', 'hu', '9max', '9max', 'other', 'other', 'other', 'other'],
  'the tag of every kind of set, as tableOfSet');

-- ------------------------------------------------------------ the data --
--
--   h1 HU  100bb: preflop chart (hu-100bb, line r) call, flop BB caller oop vs bet fold (mistake)
--   h2 HU  150bb: preflop chart (hu-150bb, line r) call, flop BB caller oop vs bet fold (blunder)
--   h3 6-max 100bb: flop BB caller oop vs bet fold (mistake)
--   h4 9-max 100bb: preflop heuristic BTN raise (good, no set), river BTN pfr ip first check (mistake)
--   h5 no PHF to read: flop BB caller oop vs bet fold (mistake)
--   B  HU 100bb: flop BB caller oop vs bet fold (mistake)

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-00000012e701', '00000000-0000-0000-0000-00000012e7a1', 'weplay:lh1',
   pg_temp.phf('cash', '[["SB",110,false],["BB",100,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Qh','Jh'], '2026-10-30T10:00:00Z'),
  ('00000000-0000-0000-0000-00000012e702', '00000000-0000-0000-0000-00000012e7a1', 'weplay:lh2',
   pg_temp.phf('cash', '[["SB",150,false],["BB",150,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Kc','Qd'], '2026-10-30T11:00:00Z'),
  ('00000000-0000-0000-0000-00000012e703', '00000000-0000-0000-0000-00000012e7a1', 'weplay:lh3',
   pg_temp.phf('cash', '[["UTG",100,false],["HJ",100,false],["CO",100,false],["BTN",100,false],["SB",100,false],["BB",100,true]]', '{1,2,3,5}'),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['As','Td'], '2026-10-30T12:00:00Z'),
  ('00000000-0000-0000-0000-00000012e704', '00000000-0000-0000-0000-00000012e7a1', 'weplay:lh4',
   pg_temp.phf('cash', '[["UTG",100,false],["UTG+1",100,false],["UTG+2",100,false],["LJ",100,false],["HJ",100,false],["CO",100,false],["BTN",100,true],["SB",100,false],["BB",100,false]]', '{1,2,3,4,5,6,8}'),
   'std', 'weplay', 7, 'BTN', 'cash', 'USD', 100, 50, 100, 50, array['9s','8s'], '2026-10-30T13:00:00Z'),
  ('00000000-0000-0000-0000-00000012e705', '00000000-0000-0000-0000-00000012e7a1', 'weplay:lh5',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0, array['7c','2d'], '2026-10-30T14:00:00Z'),
  ('00000000-0000-0000-0000-00000012eb01', '00000000-0000-0000-0000-00000012e7b1', 'weplay:lhb1',
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

select pg_temp.act_as('00000000-0000-0000-0000-00000012e7a1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.hand('00000000-0000-0000-0000-00000012e701', jsonb_build_array(
    pg_temp.dec(0, 3, 'preflop', 'call', 'vs-open', 'chart', 'perfect', 0, 'call',
      '{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-hu-100bb","line":"r"}}'),
    pg_temp.dec(1, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 1.5, 'call', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000012e702', jsonb_build_array(
    pg_temp.dec(0, 3, 'preflop', 'call', 'vs-open', 'chart', 'perfect', 0, 'call',
      '{"handClass":"KQo","position":"BB","chart":{"set":"nlhe-cash-hu-150bb","line":"r"}}'),
    pg_temp.dec(1, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'blunder', 3.0, 'call', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000012e703', jsonb_build_array(
    pg_temp.dec(0, 10, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 1.0, 'call', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000012e704', jsonb_build_array(
    pg_temp.dec(0, 7, 'preflop', 'raise', 'unopened', 'heuristic', 'good', 0.1, 'raise', '{"position":"BTN"}'),
    pg_temp.dec(1, 12, 'river', 'check', 'pfr-ip-first', 'solver', 'mistake', 0.9, 'bet', '{"position":"BTN"}'))),
  pg_temp.hand('00000000-0000-0000-0000-00000012e705', jsonb_build_array(
    pg_temp.dec(0, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 0.7, 'call', '{"position":"BB"}')))
)) ->> 'decisions')::int, 8, 'A''s five hands are saved through save_hand_analysis (8 decisions)');
select pg_temp.act_as('00000000-0000-0000-0000-00000012e7b1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.hand('00000000-0000-0000-0000-00000012eb01', jsonb_build_array(
    pg_temp.dec(0, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'solver', 'mistake', 2.0, 'call', '{"position":"BB"}')))
)) ->> 'decisions')::int, 1, '... and B''s one');

-- The hands a reader returns for one key, under filters (the fast path: no hand-list filter; the scan: `street`).
create function pg_temp.hands_of(p_filters jsonb, p_key text, p_dev boolean default true) returns text[] language sql as $$
  select coalesce(array_agg(right(r ->> 'handId', 1) order by r ->> 'handId'), '{}')
  from jsonb_array_elements(public.analysis_leak_hands(p_filters, array[p_key], p_dev, 'ev_loss', 100, 0) -> 'rows') r;
$$;
create function pg_temp.total_of(p_filters jsonb, p_key text) returns int language sql as $$
  select (public.analysis_leak_hands(p_filters, array[p_key], true, 'ev_loss', 100, 0) ->> 'total')::int;
$$;
grant execute on function pg_temp.hands_of(jsonb, text, boolean), pg_temp.total_of(jsonb, text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000012e7a1');

-- ----------------------------------------------------- the fast path --

select is(pg_temp.hands_of('{"analysisVersion":"analysis/37"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['1', '2', '3', '5'], 'no leakTable: every table''s decisions on the key, as before');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"hu"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['1', '2'], 'leakTable hu: the heads-up hands (100 and 150bb) only');
select is(pg_temp.total_of('{"analysisVersion":"analysis/37","leakTable":"hu"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  2, '... and the total counts them alone');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"other"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['3', '5'], 'leakTable other: 6-max and the hand no set answers');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"9max"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  '{}'::text[], 'leakTable 9max: none on this key');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"9max"}', 'river|pfr-ip-first||BTN|check|bet'),
  array['4'], '... the full-ring river on its own');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"hu"}', 'preflop|vs-open|r|BB|call|call', false),
  array['1', '2'], 'preflop by the chart grade''s set (heads-up)');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"other"}', 'preflop|unopened||BTN|raise|raise', false),
  array['4'], '... and a preflop decision off the charts is other');

-- ---------------------------------------------------------- the scan --

select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","street":"flop"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['1', '2', '3', '5'], 'the scan, no leakTable: every table''s, as before');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","street":"flop","leakTable":"hu"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['1', '2'], 'the scan, leakTable hu: the heads-up hands, as the fast path');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","street":"flop","leakTable":"other"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['3', '5'], '... other: 6-max and the hand no set answers');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","street":"river","leakTable":"9max"}', 'river|pfr-ip-first||BTN|check|bet'),
  array['4'], '... the full-ring river');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","street":"flop","leakTable":"hu"}', 'preflop|vs-open|r|BB|call|call', false),
  array['1', '2'], '... preflop by the chart grade''s set');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","street":"river","leakTable":"other"}', 'preflop|unopened||BTN|raise|raise', false),
  array['4'], '... and off the charts, other');

-- ------------------------------------------------------------ refusals --

select throws_ok(
  $$select public.analysis_leak_hands('{"analysisVersion":"analysis/37","leakTable":"6max"}', array['flop|caller-oop-vs-bet||BB|fold|call'])$$,
  '22023', null, 'an unknown table is refused');
select throws_ok(
  $$select public.analysis_leak_hands('{"analysisVersion":"analysis/37","street":"flop","leakTable":"x;drop"}', array['flop|caller-oop-vs-bet||BB|fold|call'])$$,
  '22023', null, '... on the scan too');

select pg_temp.act_as('00000000-0000-0000-0000-00000012e7b1');
select is(pg_temp.hands_of('{"analysisVersion":"analysis/37","leakTable":"hu"}', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['1'], 'B reads only its own heads-up hand (eb01)');

select pg_temp.as_postgres();
set local role anon;
select throws_ok($$select public.analysis_leak_table_of('nlhe-cash-hu-100bb')$$, '42501', null, 'anon cannot call the tag helper');
reset role;

select * from finish();
rollback;
