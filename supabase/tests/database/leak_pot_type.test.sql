-- pgTAP: a postflop leak area per pot type (`20271105090000_leak_pot_type.sql`).
--
-- What has to hold:
--
--   * security: `analysis_leak_pot_of` is immutable, not definer, empty
--     search_path, executable by `authenticated` only; `drill_due_by_spot_pots`
--     and `drill_queue_on_area` are new, invoker, empty search_path, gated
--     (listed in `entitlement_gates`), `authenticated` only; the re-created
--     readers stay invoker with an empty search_path and keep their gate; the
--     per-table drill readers and `drill_queue` / `drill_due_by_spot` are
--     untouched; still no client write grant;
--   * the helper's tags;
--   * the leak list: a postflop row per spot, set and pot (`pot` on a 3-bet
--     or 4-bet+ row only, never on a preflop row), the same from the sums,
--     the room and stake sums (3-bet rows moved out of the untagged row), the
--     rows, the complement, the scan and the top leaks' samples; an answer
--     with no 3-bet or 4-bet+ postflop row names no pot at all;
--   * the hands behind a leak (`leakPot`) on the fast path and the scan, alone
--     and with `leakTable`; the examples (`pot`); unknown pots refused;
--   * drills: `drill_due_by_spot_pots` is `drill_due_by_spot_tables` plus
--     `pots` (summing to the tables), `drill_queue_on_area` deals one table
--     and pot; unknown or missing pots refused;
--   * one account never reads another's; anon is refused.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(39);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000014a7a1', 'leakpot.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000014a7b1', 'leakpot.b@example.com', now(), now());

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

-- A PHF with what the table helper reads (`drills_by_table.test.sql`'s).
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
create function pg_temp.six() returns jsonb language sql immutable as $$
  select pg_temp.phf('cash', '[["UTG",100,false],["HJ",100,false],["CO",100,false],["BTN",100,false],["SB",100,false],["BB",100,true]]', '{1,2,3,5}');
$$;
create function pg_temp.hu() returns jsonb language sql immutable as $$
  select pg_temp.phf('cash', '[["SB",100,false],["BB",100,true]]');
$$;

-- ----------------------------------------------------------- security --

select ok(
  (select p.provolatile = 'i' and not p.prosecdef
          and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
   from pg_proc p where p.oid = 'public.analysis_leak_pot_of(text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.analysis_leak_pot_of(text)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_pot_of(text)', 'execute'),
  'analysis_leak_pot_of: immutable, not definer, empty search_path, authenticated only');
select ok(
  (select bool_and(not p.prosecdef)
          and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and bool_and(position('public.require_entitlement(''analysis'')' in pg_get_functiondef(p.oid)) > 0)
          and count(*) = 8
   from pg_proc p
   where p.oid in ('public.drill_due_by_spot_pots(text, timestamptz, text)'::regprocedure,
                   'public.drill_queue_on_area(text, text, text, text[], boolean, integer, text)'::regprocedure,
                   'public.analysis_leaks(jsonb)'::regprocedure,
                   'public.analysis_leaks_scan(jsonb)'::regprocedure,
                   'public.analysis_leak_sample(uuid, text, text[], text, text, date, date)'::regprocedure,
                   'public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)'::regprocedure,
                   'public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer)'::regprocedure,
                   'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)'::regprocedure)),
  'the two new readers and the six re-created ones are invoker, empty search_path, and carry the R6.2 gate');
select is(
  (select array_agg(function_sig order by function_sig) from public.entitlement_gates
    where function_sig in ('public.drill_due_by_spot_pots(text,timestamp with time zone,text)',
                           'public.drill_queue_on_area(text,text,text,text[],boolean,integer,text)') and feature = 'analysis'),
  array['public.drill_due_by_spot_pots(text,timestamp with time zone,text)',
        'public.drill_queue_on_area(text,text,text,text[],boolean,integer,text)'],
  '... the new ones are listed in entitlement_gates (analysis)');
select ok(
  has_function_privilege('authenticated', 'public.drill_due_by_spot_pots(text, timestamptz, text)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_queue_on_area(text, text, text, text[], boolean, integer, text)', 'execute')
  and not has_function_privilege('anon', 'public.drill_due_by_spot_pots(text, timestamptz, text)', 'execute')
  and not has_function_privilege('anon', 'public.drill_queue_on_area(text, text, text, text[], boolean, integer, text)', 'execute')
  and has_function_privilege('authenticated', 'public.analysis_leaks(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leaks(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)', 'execute'),
  '... executable by authenticated, not by anon');
select ok(
  (select bool_and(position('analysis_leak_pot_of' in pg_get_functiondef(f)) = 0
                   and position('public.require_entitlement(''analysis'')' in pg_get_functiondef(f)) > 0)
   from unnest(array['public.drill_queue(text, text[], boolean, integer, text)'::regprocedure,
                     'public.drill_due_by_spot(text, timestamptz, text)'::regprocedure,
                     'public.drill_queue_on_table(text, text, text[], boolean, integer, text)'::regprocedure,
                     'public.drill_due_by_spot_tables(text, timestamptz, text)'::regprocedure]) f),
  'drill_queue, drill_due_by_spot and the two per-table readers are untouched (no pot, still gated)');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('drill_items', 'analysis_leak_rows', 'analysis_leak_totals', 'analysis_leak_stake_totals', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'),
  0, 'still no client write grant on the drill items, the leak rows and sums or the decisions');

select is(
  (select array_agg(public.analysis_leak_pot_of(p) order by n)
   from unnest(array['3bet', '4bet+', 'single-raised', 'limped', 'walk', 'bomb', '', null]) with ordinality t(p, n)),
  array['3bp', '4bp', 'other', 'other', 'other', 'other', 'other', 'other'],
  'the pot tag: 3bp for a 3-bet pot, 4bp for a 4-bet+ one, other for the rest and none');

-- ------------------------------------------------------------ the data --
--
--   h1 6-max single-raised: flop BB caller oop vs bet fold (mistake 1.0)   drilled
--   h2 6-max 3-bet: preflop vs-3bet fold (mistake 0.5) and the flop (2.0)  drilled
--   h3 6-max 4-bet+: the flop (blunder 3.0)                                drilled
--   h4 HU 3-bet: the flop (mistake 1.5)                                     drilled
--   h6 6-max 3-bet: the flop (mistake 0.8), saved after the sync:          not drilled yet
--   B  6-max 3-bet: the flop (mistake 2.0)                                  drilled

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-00000014a701', '00000000-0000-0000-0000-00000014a7a1', 'weplay:lp1', pg_temp.six(),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['As','Td'], '2026-10-30T10:00:00Z'),
  ('00000000-0000-0000-0000-00000014a702', '00000000-0000-0000-0000-00000014a7a1', 'weplay:lp2', pg_temp.six(),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Kc','Qd'], '2026-10-30T11:00:00Z'),
  ('00000000-0000-0000-0000-00000014a703', '00000000-0000-0000-0000-00000014a7a1', 'weplay:lp3', pg_temp.six(),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Ah','Kd'], '2026-10-30T12:00:00Z'),
  ('00000000-0000-0000-0000-00000014a704', '00000000-0000-0000-0000-00000014a7a1', 'weplay:lp4', pg_temp.hu(),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Qh','Jh'], '2026-10-30T13:00:00Z'),
  ('00000000-0000-0000-0000-00000014a706', '00000000-0000-0000-0000-00000014a7a1', 'weplay:lp6', pg_temp.six(),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Td','9d'], '2026-10-30T16:00:00Z'),
  ('00000000-0000-0000-0000-00000014ab01', '00000000-0000-0000-0000-00000014a7b1', 'weplay:lpb1', pg_temp.six(),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, 0, array['Ah','Ad'], '2026-10-30T15:00:00Z');

create function pg_temp.dec(p_ord int, p_ai int, p_street text, p_action text, p_scenario text,
                            p_grade text, p_ev numeric, p_best text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'ord', p_ord, 'action_index', p_ai, 'street', p_street, 'action', p_action, 'status', 'analysed',
    'node', 'n', 'scenario', p_scenario, 'source', 'solver', 'grade', p_grade,
    'score', case p_grade when 'mistake' then 40 when 'blunder' then 10 else 90 end,
    'ev_loss_bb', p_ev, 'ev_loss_pot', p_ev / 10, 'freq_diff', 0,
    'options', jsonb_build_array(
                 jsonb_build_object('action', p_action, 'freq', 0.1, 'ev', 0),
                 jsonb_build_object('action', p_best, 'freq', 0.9, 'ev', 1)),
    'chosen', 0, 'flags', '[]'::jsonb, 'approximations', '[]'::jsonb, 'facing_bet', false, 'pot_bb', 5,
    'facts', jsonb_build_object('position', 'BB'));
$$;
create function pg_temp.hand(p_id text, p_pot text, p_decisions jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('hand_id', p_id, 'analysis_version', 'analysis/39', 'status', 'full', 'hero_seat', 6,
                            'pot_type', p_pot, 'grade', 'good', 'score', 80, 'ev_loss_bb', 0, 'ev_loss_pot', 0,
                            'approximations', '[]'::jsonb, 'decisions', p_decisions);
$$;
create function pg_temp.flop(p_id text, p_pot text, p_grade text, p_ev numeric) returns jsonb language sql as $$
  select pg_temp.hand(p_id, p_pot, jsonb_build_array(pg_temp.dec(0, 6, 'flop', 'fold', 'caller-oop-vs-bet', p_grade, p_ev, 'call')));
$$;
grant execute on function pg_temp.dec(int, int, text, text, text, text, numeric, text),
                          pg_temp.hand(text, text, jsonb), pg_temp.flop(text, text, text, numeric) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000014a7a1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.flop('00000000-0000-0000-0000-00000014a701', 'single-raised', 'mistake', 1.0),
  pg_temp.hand('00000000-0000-0000-0000-00000014a702', '3bet', jsonb_build_array(
    pg_temp.dec(0, 3, 'preflop', 'fold', 'vs-3bet', 'mistake', 0.5, 'call'),
    pg_temp.dec(1, 6, 'flop', 'fold', 'caller-oop-vs-bet', 'mistake', 2.0, 'call'))),
  pg_temp.flop('00000000-0000-0000-0000-00000014a703', '4bet+', 'blunder', 3.0),
  pg_temp.flop('00000000-0000-0000-0000-00000014a704', '3bet', 'mistake', 1.5)
)) ->> 'decisions')::int, 5, 'A''s four hands (five decisions) are saved through save_hand_analysis');
select is((public.sync_drill_items('analysis/39') ->> 'inserted')::int, 5, '... and drilled (sync_drill_items)');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.flop('00000000-0000-0000-0000-00000014a706', '3bet', 'mistake', 0.8)
)) ->> 'decisions')::int, 1, '... then a fifth, a 6-max 3-bet pot, not drilled yet');
select pg_temp.act_as('00000000-0000-0000-0000-00000014a7b1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.flop('00000000-0000-0000-0000-00000014ab01', '3bet', 'mistake', 2.0)
)) ->> 'decisions')::int, 1, 'B''s one hand is saved');
select is((public.sync_drill_items('analysis/39') ->> 'inserted')::int, 1, '... and drilled');

-- Readers' answers, reduced to what the tests compare.
create function pg_temp.cells(p_rows jsonb, p_key text) returns text[] language sql as $$
  select coalesce(array_agg(coalesce(r ->> 'set', '') || '|' || coalesce(r ->> 'pot', '') || '|' || (r ->> 'decisions')
                            || '|' || (r ->> 'mistakes') || '|' || ((r ->> 'evLossBb')::numeric)::text
                            order by coalesce(r ->> 'set', ''), coalesce(r ->> 'pot', '')), '{}')
  from jsonb_array_elements(p_rows) r where r ->> 'key' = p_key;
$$;
create function pg_temp.hands(p_filters jsonb) returns text[] language sql as $$
  select coalesce(array_agg(right(r ->> 'handId', 1) order by n), '{}')
  from jsonb_array_elements(public.analysis_leak_hands(jsonb_build_object('analysisVersion', 'analysis/39') || p_filters,
                                                       array['flop|caller-oop-vs-bet||BB|fold|call']) -> 'rows')
       with ordinality t(r, n);
$$;
create function pg_temp.examples(p_leaks jsonb) returns jsonb language sql as $$
  select jsonb_object_agg(l ->> 'id', (select coalesce(jsonb_agg(right(r ->> 'handId', 1)), '[]'::jsonb)
                                       from jsonb_array_elements(l -> 'rows') r))
  from jsonb_array_elements(public.analysis_leak_examples('{"analysisVersion":"analysis/39"}', null, null, p_leaks, 30) -> 'leaks') l;
$$;
create function pg_temp.due_row(p_fn text, p_key text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  execute format('select r from jsonb_array_elements(public.%I(''analysis/39'')) r where r ->> ''key'' = $1', p_fn)
    into v using p_key;
  return v;
end;
$$;
create function pg_temp.queue(p_table text, p_pot text, p_keys text[]) returns text[] language sql as $$
  select coalesce(array_agg(right(q ->> 'handId', 1) || ':' || (q ->> 'table') || ':' || (q ->> 'pot') order by q ->> 'handId'), '{}')
  from jsonb_array_elements(public.drill_queue_on_area('analysis/39', p_table, p_pot, p_keys, false, 50)) q;
$$;
grant execute on function pg_temp.cells(jsonb, text), pg_temp.hands(jsonb), pg_temp.examples(jsonb),
                          pg_temp.due_row(text, text), pg_temp.queue(text, text, text[]) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000014a7a1');

-- ------------------------------------------------------ the leak list --

select is(pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  array['nlhe-cash-6max-100bb||1|1|1.000', 'nlhe-cash-6max-100bb|3bp|2|2|2.800', 'nlhe-cash-6max-100bb|4bp|1|1|3.000',
        'nlhe-cash-hu-100bb|3bp|1|1|1.500'],
  'analysis_leaks (the sums): a postflop row per set and pot, the pot named on 3-bet and 4-bet+ rows only');
select is(pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'preflop|vs-3bet||BB|fold|call'),
  array['||1|1|0.500'], '... a preflop decision in a 3-bet pot names no pot (its line says it)');
select is(pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39","site":"weplay"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  '... the same under a room (the room and stake sums, the 3-bet and 4-bet+ rows moved out of the untagged one)');
select is((public.analysis_leaks('{"analysisVersion":"analysis/39","site":"weplay"}') ->> 'graded')::int,
  (public.analysis_leaks('{"analysisVersion":"analysis/39"}') ->> 'graded')::int, '... and the same decisions in all');
select is(pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39","site":"weplay","from":"2026-01-01T00:00:00Z"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  '... and from the rows (a room and a range)');
select is(pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39","from":"2026-01-01T00:00:00Z"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  '... and from the complement (a range holding most of the history)');
select is(pg_temp.cells(public.analysis_leaks_scan('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  '... and from the scan');
select is(pg_temp.cells(public.analysis_top_leaks('{"analysisVersion":"analysis/39"}', 'all') -> 'sample' -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call')
          || pg_temp.cells(public.analysis_top_leaks('{"analysisVersion":"analysis/39"}', '30d') -> 'now' -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call')
  || pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
  '... and in the top leaks'' samples (all time from the sums, 30 days from the rows)');
select ok(
  (select bool_and(not (r ? 'pot')) and count(*) > 0
   from jsonb_array_elements(public.analysis_leaks('{"analysisVersion":"analysis/39","potType":"single-raised"}') -> 'rows') r),
  'an answer with no 3-bet or 4-bet+ postflop row names no pot (as before)');

-- --------------------------------------------------- the hands, examples --

select is(pg_temp.hands('{}'), array['3', '2', '4', '1', '6'], 'analysis_leak_hands without leakPot: every pot, as before');
select is(pg_temp.hands('{"leakPot":"3bp"}') || pg_temp.hands('{"leakPot":"3bp","leakTable":"other"}')
          || pg_temp.hands('{"leakPot":"other"}') || pg_temp.hands('{"leakPot":"4bp"}'),
  array['2', '4', '6', '2', '6', '1', '3'],
  '... leakPot keeps one pot: 3bp; with leakTable other the 6-max 3-bet pots; other; 4bp');
select is(pg_temp.hands('{"street":"flop","leakPot":"3bp"}') || pg_temp.hands('{"street":"flop","leakPot":"3bp","leakTable":"other"}')
          || pg_temp.hands('{"street":"flop","leakPot":"other"}') || pg_temp.hands('{"street":"flop","leakPot":"4bp"}'),
  array['2', '4', '6', '2', '6', '1', '3'],
  '... and the same on the scan (a hand-list filter)');
select throws_ok($$select pg_temp.hands('{"leakPot":"srp"}')$$, '22023', null, 'an unknown pot is refused');
select throws_ok($$select pg_temp.hands('{"street":"flop","leakPot":"3bet"}')$$, '22023', null, '... on the scan too');
select is(pg_temp.examples('[{"id":"all","keys":["flop|caller-oop-vs-bet||BB|fold|call"]},
                             {"id":"null","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":null},
                             {"id":"3bp","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":"3bp"},
                             {"id":"hu3bp","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":"3bp","table":"hu"},
                             {"id":"other","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":"other"},
                             {"id":"4bp","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":"4bp"}]'),
  '{"all":["3","2","4","1","6"],"null":["3","2","4","1","6"],"3bp":["2","4","6"],"hu3bp":["4"],"other":["1"],"4bp":["3"]}'::jsonb,
  'analysis_leak_examples: no pot (or null) every pot''s as before, else that pot''s (with the table too)');
select throws_ok(
  $$select public.analysis_leak_examples('{}', null, null, '[{"id":"x","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":"srp"}]')$$,
  '22023', null, 'an unknown pot is refused');
select throws_ok(
  $$select public.analysis_leak_examples('{}', null, null, '[{"id":"x","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"pot":3}]')$$,
  '22023', null, '... and so is one that is not a string');

-- ------------------------------------------------------------- drills --

select is(pg_temp.due_row('drill_due_by_spot_pots', 'flop|caller-oop-vs-bet||BB|fold|call') - 'pots',
  pg_temp.due_row('drill_due_by_spot_tables', 'flop|caller-oop-vs-bet||BB|fold|call'),
  'drill_due_by_spot_pots: without its pots, exactly drill_due_by_spot_tables''s row');
select is(
  (select coalesce(jsonb_agg(r - 'pots' order by r ->> 'key'), '[]'::jsonb)
   from jsonb_array_elements(public.drill_due_by_spot_pots('analysis/39')) r),
  public.drill_due_by_spot_tables('analysis/39'), '... every row');
select is(pg_temp.due_row('drill_due_by_spot_pots', 'flop|caller-oop-vs-bet||BB|fold|call') -> 'pots',
  '{"hu":{"3bp":{"items":1,"due":1}},"other":{"3bp":{"items":2,"due":2},"4bp":{"items":1,"due":1},"other":{"items":1,"due":1}}}'::jsonb,
  '... split per table and pot: the 6-max 3-bet pots h2 and the undrilled h6, the 4-bet+ h3, the single-raised h1');
select ok(
  (select bool_and((t.v ->> 'items')::int = (select sum((c.v ->> 'items')::int) from jsonb_each(r -> 'pots' -> t.k) c(k, v))
               and (t.v ->> 'due')::int = (select sum((c.v ->> 'due')::int) from jsonb_each(r -> 'pots' -> t.k) c(k, v)))
   from jsonb_array_elements(public.drill_due_by_spot_pots('analysis/39')) r, jsonb_each(r -> 'tables') t(k, v)),
  '... every table''s pots sum to its counts');
select is(
  array[pg_temp.queue('other', '3bp', array['flop|caller-oop-vs-bet||BB|fold|call']),
        pg_temp.queue('hu', '3bp', null), pg_temp.queue('other', 'other', array['flop|caller-oop-vs-bet||BB|fold|call']),
        pg_temp.queue('other', '4bp', null)],
  array[array['2:other:3bp'], array['4:hu:3bp'], array['1:other:other'], array['3:other:4bp']],
  'drill_queue_on_area: one table''s and one pot''s drills, each saying both');
select is(pg_temp.queue('9max', '3bp', null), '{}'::text[], '... none on a table and pot with none');
select throws_ok($$select public.drill_queue_on_area('analysis/39', 'other', 'srp')$$, '22023', null, 'an unknown pot is refused');
select throws_ok($$select public.drill_queue_on_area('analysis/39', 'other', null)$$, '22023', null, '... and so is none (use drill_queue_on_table)');

-- ----------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-00000014a7b1');
select is(
  array[pg_temp.cells(public.analysis_leaks('{"analysisVersion":"analysis/39"}') -> 'rows', 'flop|caller-oop-vs-bet||BB|fold|call'),
        pg_temp.queue('other', '3bp', null),
        array[(pg_temp.due_row('drill_due_by_spot_pots', 'flop|caller-oop-vs-bet||BB|fold|call') -> 'pots')::text],
        pg_temp.hands('{"leakPot":"3bp"}')],
  array[array['nlhe-cash-6max-100bb|3bp|1|1|2.000'], array['1:other:3bp'], array['{"other": {"3bp": {"due": 1, "items": 1}}}'],
        array['1']],
  'B reads only its own leak rows, drills and hands');

select pg_temp.as_postgres();
set local role anon;
select throws_ok($$select public.drill_queue_on_area('analysis/39', 'other', '3bp')$$, '42501', null, 'anon cannot read the queue on an area');
reset role;

select * from finish();
rollback;
