-- pgTAP: drills and top-leak examples read on a leak area's table
-- (`20271104090000_drills_by_table.sql`).
--
-- What has to hold:
--
--   * security: `drill_due_by_spot_tables` and `drill_queue_on_table` are
--     new, invoker, empty search_path, gated (R6.2, listed in
--     `entitlement_gates`), executable by `authenticated` only; the
--     re-created `analysis_leak_examples` stays invoker with an empty
--     search_path and keeps its gate and grants; `drill_queue` and
--     `drill_due_by_spot` are untouched; still no client write grant on the
--     drill items or the leak rows;
--   * `drill_due_by_spot_tables`: each key's `key` / `items` / `due` exactly
--     `drill_due_by_spot`'s (every table), and `tables` splitting them per
--     table (drilled and not yet drilled Mistakes alike), summing to the key's;
--   * `drill_queue_on_table`: only that table's items (postflop by the
--     hand's table, `other` for 6-max and a hand no set answers), each saying
--     its table; an unknown or missing table refused; `drill_queue` still
--     returns every table's;
--   * `analysis_leak_examples`: a leak without `table` (or a null one) as
--     before, with one its table's examples only; an unknown table refused;
--   * one account never reads another's; anon is refused.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(29);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000013d7a1', 'drilltable.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000013d7b1', 'drilltable.b@example.com', now(), now());

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

-- A PHF with what the table helper reads (`leak_hands_table.test.sql`'s).
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
  (select bool_and(not p.prosecdef)
          and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and bool_and(position('public.require_entitlement(''analysis'')' in pg_get_functiondef(p.oid)) > 0)
          and count(*) = 3
   from pg_proc p
   where p.oid in ('public.drill_queue_on_table(text, text, text[], boolean, integer)'::regprocedure,
                   'public.drill_due_by_spot_tables(text, timestamptz)'::regprocedure,
                   'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)'::regprocedure)),
  'the two new readers and the re-created one are invoker, empty search_path, and carry the R6.2 gate');
select is(
  (select array_agg(function_sig order by function_sig) from public.entitlement_gates
    where function_sig in ('public.drill_queue_on_table(text,text,text[],boolean,integer)',
                           'public.drill_due_by_spot_tables(text,timestamp with time zone)') and feature = 'analysis'),
  array['public.drill_due_by_spot_tables(text,timestamp with time zone)', 'public.drill_queue_on_table(text,text,text[],boolean,integer)'],
  '... the new ones are listed in entitlement_gates (analysis)');
select ok(
  has_function_privilege('authenticated', 'public.drill_queue_on_table(text, text, text[], boolean, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.drill_due_by_spot_tables(text, timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)', 'execute')
  and not has_function_privilege('anon', 'public.drill_queue_on_table(text, text, text[], boolean, integer)', 'execute')
  and not has_function_privilege('anon', 'public.drill_due_by_spot_tables(text, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)', 'execute'),
  '... executable by authenticated, not by anon');
select ok(
  (select bool_and(position('analysis_leak_table_of' in pg_get_functiondef(f)) = 0
                   and position('public.require_entitlement(''analysis'')' in pg_get_functiondef(f)) > 0)
   from unnest(array['public.drill_queue(text, text[], boolean, integer)'::regprocedure,
                     'public.drill_due_by_spot(text, timestamptz)'::regprocedure]) f),
  'drill_queue and drill_due_by_spot are untouched (no table, still gated)');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('drill_items', 'analysis_leak_rows', 'decision_analysis')
     and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'),
  0, 'still no client write grant on the drill items, the leak rows or the decisions');

-- ------------------------------------------------------------ the data --
--
--   h1 HU  100bb: flop BB caller oop vs bet fold (mistake 1.5)   drilled
--   h2 HU  150bb: the same (blunder 3.0)                          drilled
--   h3 6-max 100bb: the same (mistake 1.0)                        drilled
--   h4 9-max 100bb: river BTN pfr ip first check (mistake 0.9)    drilled
--   h5 no PHF to read: flop as h1 (mistake 0.7)                   drilled
--   h6 HU 100bb: flop as h1 (mistake 2.0), saved after the sync:  not drilled yet
--   B  HU 100bb: flop as h1 (mistake 2.0)                         drilled

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-00000013d701', '00000000-0000-0000-0000-00000013d7a1', 'weplay:dt1',
   pg_temp.phf('cash', '[["SB",110,false],["BB",100,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Qh','Jh'], '2026-10-30T10:00:00Z'),
  ('00000000-0000-0000-0000-00000013d702', '00000000-0000-0000-0000-00000013d7a1', 'weplay:dt2',
   pg_temp.phf('cash', '[["SB",150,false],["BB",150,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Kc','Qd'], '2026-10-30T11:00:00Z'),
  ('00000000-0000-0000-0000-00000013d703', '00000000-0000-0000-0000-00000013d7a1', 'weplay:dt3',
   pg_temp.phf('cash', '[["UTG",100,false],["HJ",100,false],["CO",100,false],["BTN",100,false],["SB",100,false],["BB",100,true]]', '{1,2,3,5}'),
   'std', 'weplay', 6, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['As','Td'], '2026-10-30T12:00:00Z'),
  ('00000000-0000-0000-0000-00000013d704', '00000000-0000-0000-0000-00000013d7a1', 'weplay:dt4',
   pg_temp.phf('cash', '[["UTG",100,false],["UTG+1",100,false],["UTG+2",100,false],["LJ",100,false],["HJ",100,false],["CO",100,false],["BTN",100,true],["SB",100,false],["BB",100,false]]', '{1,2,3,4,5,6,8}'),
   'std', 'weplay', 7, 'BTN', 'cash', 'USD', 100, 50, 100, 50, array['9s','8s'], '2026-10-30T13:00:00Z'),
  ('00000000-0000-0000-0000-00000013d705', '00000000-0000-0000-0000-00000013d7a1', 'weplay:dt5',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0, array['7c','2d'], '2026-10-30T14:00:00Z'),
  ('00000000-0000-0000-0000-00000013d706', '00000000-0000-0000-0000-00000013d7a1', 'weplay:dt6',
   pg_temp.phf('cash', '[["SB",100,false],["BB",100,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100, array['Td','9d'], '2026-10-30T16:00:00Z'),
  ('00000000-0000-0000-0000-00000013db01', '00000000-0000-0000-0000-00000013d7b1', 'weplay:dtb1',
   pg_temp.phf('cash', '[["SB",100,false],["BB",100,true]]'),
   'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0, array['Ah','Ad'], '2026-10-30T15:00:00Z');

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
    'facts', jsonb_build_object('position', case when p_street = 'river' then 'BTN' else 'BB' end));
$$;
create function pg_temp.hand(p_id text, p_decisions jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('hand_id', p_id, 'analysis_version', 'analysis/38', 'status', 'full', 'hero_seat', 2,
                            'pot_type', 'single-raised', 'grade', 'good', 'score', 80, 'ev_loss_bb', 0, 'ev_loss_pot', 0,
                            'approximations', '[]'::jsonb, 'decisions', p_decisions);
$$;
create function pg_temp.flop(p_id text, p_grade text, p_ev numeric) returns jsonb language sql as $$
  select pg_temp.hand(p_id, jsonb_build_array(pg_temp.dec(0, 6, 'flop', 'fold', 'caller-oop-vs-bet', p_grade, p_ev, 'call')));
$$;
grant execute on function pg_temp.dec(int, int, text, text, text, text, numeric, text),
                          pg_temp.hand(text, jsonb), pg_temp.flop(text, text, numeric) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000013d7a1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.flop('00000000-0000-0000-0000-00000013d701', 'mistake', 1.5),
  pg_temp.flop('00000000-0000-0000-0000-00000013d702', 'blunder', 3.0),
  pg_temp.flop('00000000-0000-0000-0000-00000013d703', 'mistake', 1.0),
  pg_temp.hand('00000000-0000-0000-0000-00000013d704', jsonb_build_array(
    pg_temp.dec(0, 12, 'river', 'check', 'pfr-ip-first', 'mistake', 0.9, 'bet'))),
  pg_temp.flop('00000000-0000-0000-0000-00000013d705', 'mistake', 0.7)
)) ->> 'decisions')::int, 5, 'A''s five hands are saved through save_hand_analysis');
select is((public.sync_drill_items('analysis/38') ->> 'inserted')::int, 5, '... and drilled (sync_drill_items)');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.flop('00000000-0000-0000-0000-00000013d706', 'mistake', 2.0)
)) ->> 'decisions')::int, 1, '... then a sixth, heads-up, not drilled yet');
select pg_temp.act_as('00000000-0000-0000-0000-00000013d7b1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.flop('00000000-0000-0000-0000-00000013db01', 'mistake', 2.0)
)) ->> 'decisions')::int, 1, 'B''s one hand is saved');
select is((public.sync_drill_items('analysis/38') ->> 'inserted')::int, 1, '... and drilled');

-- Readers' answers, reduced to what the tests compare.
create function pg_temp.due_row(p_key text) returns jsonb language sql as $$
  select r from jsonb_array_elements(public.drill_due_by_spot_tables('analysis/38')) r where r ->> 'key' = p_key;
$$;
-- The per-table reader with its breakdown taken out: drill_due_by_spot's answer if it counts as that does.
create function pg_temp.due_untabled() returns jsonb language sql as $$
  select coalesce(jsonb_agg(r - 'tables' order by r ->> 'key'), '[]'::jsonb)
  from jsonb_array_elements(public.drill_due_by_spot_tables('analysis/38')) r;
$$;
grant execute on function pg_temp.due_untabled() to authenticated;
create function pg_temp.queue(p_table text, p_keys text[]) returns text[] language sql as $$
  select coalesce(array_agg(right(q ->> 'handId', 1) || ':' || (q ->> 'table') order by q ->> 'handId'), '{}')
  from jsonb_array_elements(public.drill_queue_on_table('analysis/38', p_table, p_keys, false, 50)) q;
$$;
create function pg_temp.examples(p_leaks jsonb) returns jsonb language sql as $$
  select jsonb_object_agg(l ->> 'id', (select coalesce(jsonb_agg(right(r ->> 'handId', 1)), '[]'::jsonb)
                                       from jsonb_array_elements(l -> 'rows') r))
  from jsonb_array_elements(public.analysis_leak_examples('{"analysisVersion":"analysis/38"}', null, null, p_leaks, 30) -> 'leaks') l;
$$;
grant execute on function pg_temp.due_row(text), pg_temp.queue(text, text[]), pg_temp.examples(jsonb) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-00000013d7a1');

-- --------------------------------------------------- drills by spot --

select is(pg_temp.due_row('flop|caller-oop-vs-bet||BB|fold|call') - 'tables',
  '{"key":"flop|caller-oop-vs-bet||BB|fold|call","items":5,"due":5}'::jsonb,
  'drill_due_by_spot_tables: the key''s counts over every table (four drilled, one not yet)');
select is(pg_temp.due_untabled(), public.drill_due_by_spot('analysis/38'),
  '... every row, without its tables, exactly drill_due_by_spot''s');
select is(jsonb_array_length(public.drill_due_by_spot('analysis/38')), 2, '... which still has no tables, two keys');
select is(pg_temp.due_row('flop|caller-oop-vs-bet||BB|fold|call') -> 'tables',
  '{"hu":{"items":3,"due":3},"other":{"items":2,"due":2}}'::jsonb,
  '... split per table: heads-up h1, h2 and the undrilled h6; other the 6-max h3 and h5 (no set)');
select is(pg_temp.due_row('river|pfr-ip-first||BTN|check|bet') -> 'tables',
  '{"9max":{"items":1,"due":1}}'::jsonb, '... the full-ring river on its own table');
select ok(
  (select bool_and((r ->> 'items')::int = (select coalesce(sum((v ->> 'items')::int), 0) from jsonb_each(r -> 'tables') t(k, v))
               and (r ->> 'due')::int = (select coalesce(sum((v ->> 'due')::int), 0) from jsonb_each(r -> 'tables') t(k, v)))
   from jsonb_array_elements(public.drill_due_by_spot_tables('analysis/38')) r),
  '... every key''s tables sum to its counts');

-- ------------------------------------------------- the queue on a table --

select is(pg_temp.queue('hu', array['flop|caller-oop-vs-bet||BB|fold|call']), array['1:hu', '2:hu'],
  'drill_queue_on_table hu: the heads-up drills only (100 and 150bb), each saying its table');
select is(pg_temp.queue('other', array['flop|caller-oop-vs-bet||BB|fold|call']), array['3:other', '5:other'],
  '... other: 6-max and the hand no set answers');
select is(pg_temp.queue('9max', null), array['4:9max'], '... 9max over every key: the full-ring river');
select is(jsonb_array_length(public.drill_queue('analysis/38', array['flop|caller-oop-vs-bet||BB|fold|call'], false, 50)), 4,
  'drill_queue still deals every table''s drills on the key');
select throws_ok($$select public.drill_queue_on_table('analysis/38', '6max')$$, '22023', null, 'an unknown table is refused');
select throws_ok($$select public.drill_queue_on_table('analysis/38', null)$$, '22023', null, '... and so is none (use drill_queue)');

-- ------------------------------------------------------- the examples --

select is(pg_temp.examples('[{"id":"all","keys":["flop|caller-oop-vs-bet||BB|fold|call"]},
                             {"id":"null","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":null},
                             {"id":"hu","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":"hu"},
                             {"id":"other","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":"other"},
                             {"id":"9max","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":"9max"}]'),
  '{"all":["2","6","1","3","5"],"null":["2","6","1","3","5"],"hu":["2","6","1"],"other":["3","5"],"9max":[]}'::jsonb,
  'analysis_leak_examples: no table (or null) every table''s as before, else that table''s, costliest first');
select throws_ok(
  $$select public.analysis_leak_examples('{}', null, null, '[{"id":"x","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":"6max"}]')$$,
  '22023', null, 'an unknown table is refused');
select throws_ok(
  $$select public.analysis_leak_examples('{}', null, null, '[{"id":"x","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":1}]')$$,
  '22023', null, '... and so is one that is not a string');

-- ----------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-00000013d7b1');
select is(pg_temp.due_row('flop|caller-oop-vs-bet||BB|fold|call') -> 'tables', '{"hu":{"items":1,"due":1}}'::jsonb,
  'B counts only its own drill');
select is(pg_temp.queue('hu', null), array['1:hu'], '... is dealt only its own (db01)');
select is(pg_temp.examples('[{"id":"hu","keys":["flop|caller-oop-vs-bet||BB|fold|call"],"table":"hu"}]'), '{"hu":["1"]}'::jsonb,
  '... and reads only its own examples');

select pg_temp.as_postgres();
set local role anon;
select throws_ok($$select public.drill_queue_on_table('analysis/38', 'hu')$$, '42501', null, 'anon cannot read the queue on a table');
reset role;

select * from finish();
rollback;
