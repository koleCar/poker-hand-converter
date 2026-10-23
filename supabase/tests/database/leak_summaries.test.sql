-- pgTAP: the leak finder's top three (R5.2) -- `20270728090000_leak_summaries.sql`.
--
-- The leak sums are kept by triggers on `decision_analysis` and read by
-- `analysis_top_leaks` and `analysis_leak_examples`. What has to hold:
--
--   * security: three tables with RLS (select-own), no client write grant;
--     the trigger functions, the rebuild and the spot helpers are definer or
--     internal and executable by no client role; the readers are invoker with
--     an empty search_path, executable by `authenticated`, not by `anon`;
--   * the sums are the leak finder's: `analysis_top_leaks`' rows equal
--     `analysis_leaks`' (every spot, set, count and sum, the graded hands and
--     moves) all time and in the last 30 days of play and the 30 before, under
--     each filter it takes - after the inserts, after a prune of another
--     version, after a hand is deleted, and after a rebuild;
--   * the windows count back from the last graded day in scope;
--   * example hands: worse than Perfect only, costliest first, capped, inside
--     the window and the filters, with where the replayer opens;
--   * validation, and one account never reads another's.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(48);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000b52a1', 'top.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000b52b1', 'top.b@example.com', now(), now());

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

-- The leak finder's rows and the top three's, as comparable sets.
create function pg_temp.leak_rows(p_rows jsonb)
returns table (key text, chart_set text, decisions bigint, non_perfect bigint, mistakes bigint,
               ev_bb numeric, ev_pot numeric, score_sum numeric, score_sq numeric)
language sql as $$
  select r ->> 'key', r ->> 'set', (r ->> 'decisions')::bigint, (r ->> 'nonPerfect')::bigint,
         (r ->> 'mistakes')::bigint, (r ->> 'evLossBb')::numeric, (r ->> 'evLossPot')::numeric,
         (r ->> 'scoreSum')::numeric, (r ->> 'scoreSq')::numeric
  from jsonb_array_elements(p_rows) r;
$$;
grant execute on function pg_temp.leak_rows(jsonb) to authenticated;

-- Whether a top-three sample equals `analysis_leaks` over the same filters and days.
create function pg_temp.same(p_filters jsonb, p_sample jsonb, p_from text, p_to text)
returns boolean language plpgsql as $$
declare
  v_ref jsonb := public.analysis_leaks(p_filters
                   || case when p_from is null then '{}'::jsonb else jsonb_build_object('from', p_from) end
                   || case when p_to is null then '{}'::jsonb else jsonb_build_object('to', p_to) end);
begin
  return (v_ref ->> 'hands')::bigint = (p_sample ->> 'hands')::bigint
     and (v_ref ->> 'graded')::bigint = (p_sample ->> 'graded')::bigint
     and not exists (select * from pg_temp.leak_rows(v_ref -> 'rows') except select * from pg_temp.leak_rows(p_sample -> 'rows'))
     and not exists (select * from pg_temp.leak_rows(p_sample -> 'rows') except select * from pg_temp.leak_rows(v_ref -> 'rows'));
end;
$$;
grant execute on function pg_temp.same(jsonb, jsonb, text, text) to authenticated;

-- Every sample of the top three against `analysis_leaks`, for one filter set.
create function pg_temp.all_same(p_filters jsonb)
returns boolean language plpgsql as $$
declare
  v_all jsonb := public.analysis_top_leaks(p_filters, 'all');
  v_30  jsonb := public.analysis_top_leaks(p_filters, '30d');
  v_last date := (v_all ->> 'last')::date;
begin
  if v_last is null then
    return (v_all -> 'sample' ->> 'graded')::bigint = (public.analysis_leaks(p_filters) ->> 'graded')::bigint;
  end if;
  return pg_temp.same(p_filters, v_all -> 'sample', null, null)
     and pg_temp.same(p_filters, v_30 -> 'sample', (v_last - 29)::text, (v_last + 1)::text)
     and pg_temp.same(p_filters, v_all -> 'now', (v_last - 29)::text, (v_last + 1)::text)
     and pg_temp.same(p_filters, v_all -> 'was', (v_last - 59)::text, (v_last - 29)::text);
end;
$$;
grant execute on function pg_temp.all_same(jsonb) to authenticated;

-- A: six hands. Last graded day 30 March; the 30 days of play are 1-30 March,
-- the 30 before 30 January - 28 February. h6 has no time (all time only).
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, currency_minor_units, small_blind, big_blind, hero_profit,
                          hero_cards, played_at) values
  ('00000000-0000-0000-0000-0000000b5201', '00000000-0000-0000-0000-0000000b52a1', 'weplay:t1',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['Qh','Jh'], '2026-03-30T22:00:00Z'),
  ('00000000-0000-0000-0000-0000000b5202', '00000000-0000-0000-0000-0000000b52a1', 'weplay:t2',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, -100,
   array['Kc','Qd'], '2026-03-20T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b5203', '00000000-0000-0000-0000-0000000b52a1', 'weplay:t3',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'UTG', 'cash', 'USD', 100, 50, 100, 150,
   array['As','Kd'], '2026-02-15T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b5204', '00000000-0000-0000-0000-0000000b52a1', 'pokerstars:t4',
   '{"schema":"phf/1"}', 'std', 'pokerstars', 3, 'BTN', 'tournament', 'USD', 100, 50, 100, 0,
   array['9s','8s'], '2026-02-10T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b5205', '00000000-0000-0000-0000-0000000b52a1', 'weplay:t5',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0,
   array['7c','2d'], '2025-12-01T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b5206', '00000000-0000-0000-0000-0000000b52a1', 'weplay:t6',
   '{"schema":"phf/1"}', 'std', 'weplay', 4, 'CO', 'cash', 'USD', 100, 50, 100, 0,
   array['Ac','Jc'], null),
  ('00000000-0000-0000-0000-0000000b5b01', '00000000-0000-0000-0000-0000000b52b1', 'weplay:tb1',
   '{"schema":"phf/1"}', 'std', 'weplay', 2, 'BB', 'cash', 'USD', 100, 50, 100, 0,
   array['Ah','Ad'], '2026-03-25T10:00:00Z');

-- ---------------------------------------------------------- security --

select ok(
  (select bool_and(c.relrowsecurity) and count(*) = 3 from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('analysis_leak_rows', 'analysis_leak_days', 'analysis_leak_day_hands')),
  'the three leak tables exist with row level security');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('analysis_leak_rows', 'analysis_leak_days', 'analysis_leak_day_hands')
     and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'),
  0, 'no client write grant on them');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('analysis_leak_rows', 'analysis_leak_days', 'analysis_leak_day_hands')
     and grantee = 'anon'),
  0, '... and nothing at all for anon');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename in ('analysis_leak_rows', 'analysis_leak_days', 'analysis_leak_day_hands')
     and cmd = 'SELECT' and qual like '%auth.uid()%'),
  3, 'each is readable by its owner only');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 3 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_leak_rows_on_insert', 'analysis_leak_rows_on_delete', 'analysis_leak_summaries_rebuild')),
  'the triggers and the rebuild are security definer');
select ok(
  not has_function_privilege('authenticated', 'public.analysis_leak_summaries_rebuild(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_summaries_rebuild(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_leak_rows_on_insert()', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_leak_rows_on_delete()', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_leak_spot_key(text, text, text, jsonb, text, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_leak_chart_set(text, jsonb)', 'execute'),
  '... and, with the spot helpers, executable by no client role');
select ok(
  (select bool_and(not p.prosecdef)
          and bool_and(coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
          and count(*) = 3
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_top_leaks', 'analysis_leak_examples', 'analysis_leak_sample')),
  'the readers are security invoker with an empty search_path');
select ok(
  has_function_privilege('authenticated', 'public.analysis_top_leaks(jsonb, text)', 'execute')
  and has_function_privilege('authenticated', 'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.analysis_leak_sample(uuid, text, text, text, text, date, date)', 'execute'),
  '... executable by authenticated');
select ok(
  not has_function_privilege('anon', 'public.analysis_top_leaks(jsonb, text)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_examples(jsonb, date, date, jsonb, integer)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_sample(uuid, text, text, text, text, date, date)', 'execute'),
  '... and not by anon');
select is(
  (select count(*)::int from pg_trigger
   where tgrelid = 'public.decision_analysis'::regclass
     and tgname in ('decision_analysis_leak_rows_insert', 'decision_analysis_leak_rows_delete')),
  2, 'decision_analysis carries the two statement triggers');

-- ------------------------------------------------------------ the data --
--
--   t1 30 Mar cash BB  vs-open fffrf fold  mistake  0.8 best call (6-max set)
--                      river pfr-ip-vs-bet check good 0.3 best bet
--   t2 20 Mar cash BB  vs-open fffrf fold  blunder  2.0 best call (6-max set)
--                      flop heuristic bet, not graded
--   t3 15 Feb cash UTG unopened ""   raise  perfect  0   (6-max set)
--   t4 10 Feb tourn BTN vs-3bet  r   fold  mistake  1.1 best call (9-max set), pot 3bet
--   t5  1 Dec cash BB  vs-open fffrf fold  inaccurate 0.2 best call
--   t6  no time cash CO river pfr-oop-first bet inaccurate 0.5 best check
--   B   25 Mar cash BB  vs-open fffrf fold blunder 3.0 best call

select pg_temp.act_as('00000000-0000-0000-0000-0000000b52a1');

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
create function pg_temp.hand(p_id text, p_pot text, p_decisions jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('hand_id', p_id, 'analysis_version', 'analysis/3', 'status', 'full', 'hero_seat', 1,
                            'pot_type', p_pot, 'grade', 'good', 'score', 80, 'ev_loss_bb', 0, 'ev_loss_pot', 0,
                            'approximations', '[]'::jsonb, 'decisions', p_decisions);
$$;
grant execute on function pg_temp.dec(int, int, text, text, text, text, text, numeric, text, jsonb),
                          pg_temp.hand(text, text, jsonb) to authenticated;

select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.hand('00000000-0000-0000-0000-0000000b5201', 'single-raised', jsonb_build_array(
    pg_temp.dec(0, 5, 'preflop', 'fold', 'vs-open', 'chart', 'mistake', 0.8, 'call',
      '{"handClass":"QJs","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf"}}'),
    pg_temp.dec(1, 11, 'river', 'check', 'pfr-ip-vs-bet', 'solver', 'good', 0.3, 'bet', '{"position":"BB"}'))),
  pg_temp.hand('00000000-0000-0000-0000-0000000b5202', 'single-raised', jsonb_build_array(
    pg_temp.dec(0, 5, 'preflop', 'fold', 'vs-open', 'chart', 'blunder', 2.0, 'call',
      '{"handClass":"KQo","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf"}}'),
    pg_temp.dec(1, 9, 'flop', 'bet', 'pfr-ip-first', 'heuristic', null, null, null, '{}'))),
  pg_temp.hand('00000000-0000-0000-0000-0000000b5203', 'single-raised', jsonb_build_array(
    pg_temp.dec(0, 2, 'preflop', 'raise', 'unopened', 'chart', 'perfect', 0, 'raise',
      '{"handClass":"AKo","position":"UTG","chart":{"set":"nlhe-cash-6max-100bb","line":""}}'))),
  pg_temp.hand('00000000-0000-0000-0000-0000000b5204', '3bet', jsonb_build_array(
    pg_temp.dec(0, 7, 'preflop', 'fold', 'vs-3bet', 'chart', 'mistake', 1.1, 'call',
      '{"handClass":"98s","position":"BTN","chart":{"set":"nlhe-cash-9max-100bb","line":"r"}}'))),
  pg_temp.hand('00000000-0000-0000-0000-0000000b5205', 'single-raised', jsonb_build_array(
    pg_temp.dec(0, 5, 'preflop', 'fold', 'vs-open', 'chart', 'inaccurate', 0.2, 'call',
      '{"handClass":"72o","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf"}}'))),
  pg_temp.hand('00000000-0000-0000-0000-0000000b5206', 'single-raised', jsonb_build_array(
    pg_temp.dec(0, 13, 'river', 'bet', 'pfr-oop-first', 'solver', 'inaccurate', 0.5, 'check', '{"position":"CO"}')))
)) ->> 'decisions')::int, 8, 'A''s six hands are saved through save_hand_analysis (8 decisions, 7 graded)');

select is((select count(*)::int from public.analysis_leak_rows), 7,
  'the insert trigger made one leak row per graded decision');
select is((select sum(hands)::int from public.analysis_leak_day_hands), 6, '... and counted six graded hands');

-- ------------------------------------------------- equal to the finder --

select ok(pg_temp.all_same('{"analysisVersion":"analysis/3"}'),
  'every sample equals analysis_leaks: all time, the last 30 days of play, the 30 before');
select ok(pg_temp.all_same('{"analysisVersion":"analysis/3","gameFormat":"cash"}'), '... with a format');
select ok(pg_temp.all_same('{"analysisVersion":"analysis/3","position":"bb"}'), '... with the hero''s seat (any case)');
select ok(pg_temp.all_same('{"analysisVersion":"analysis/3","potType":"3bet"}'), '... with a pot type');
select ok(pg_temp.all_same('{"analysisVersion":"analysis/3","gameFormat":"tournament","potType":"single-raised"}'),
  '... with filters that match nothing');

select is(public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', '30d') -> 'current',
  '{"from":"2026-03-01","to":"2026-03-30"}'::jsonb, 'the 30 days of play end on the last graded day');
select is(public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', '30d') -> 'prior',
  '{"from":"2026-01-30","to":"2026-02-28"}'::jsonb, '... and the 30 before them');
select is(public.analysis_top_leaks('{"analysisVersion":"analysis/3","gameFormat":"tournament"}', 'all') ->> 'last',
  '2026-02-10', 'the last day is the scope''s own');
select is(
  (select jsonb_agg(r ->> 'key' order by r ->> 'key') from jsonb_array_elements(
     public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', '30d') -> 'sample' -> 'rows') r),
  '["preflop|vs-open|fffrf|BB|fold|call", "river|pfr-ip-vs-bet||BB|check|bet"]'::jsonb,
  'the 30-day sample is March''s spots');
select is(
  (select r from jsonb_array_elements(public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', 'all') -> 'sample' -> 'rows') r
   where r ->> 'key' = 'preflop|vs-open|fffrf|BB|fold|call'),
  '{"key":"preflop|vs-open|fffrf|BB|fold|call","set":"nlhe-cash-6max-100bb","street":"preflop","scenario":"vs-open",
    "line":"fffrf","position":"BB","taken":"fold","best":"call","decisions":3,"hands":3,"nonPerfect":3,"mistakes":3,
    "evLossBb":3.000,"evLossPot":0.3000,"scoreSum":120.00,"scoreSq":6600.00}'::jsonb,
  'a row is analysis_leaks'' row: parts, set, counts and sums');
select is((public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', 'all') -> 'sample' ->> 'hands')::int, 6,
  'all time counts the hand without a time');
select is(public.analysis_top_leaks('{"analysisVersion":"analysis/9"}', 'all') -> 'sample',
  '{"hands":0,"graded":0,"rows":[]}'::jsonb, 'another version reads nothing');

-- ------------------------------------------------------------ examples --

select is(
  (select jsonb_agg(jsonb_build_array(r ->> 'handId', (r ->> 'actionIndex')::int, r ->> 'grade', r ->> 'evLossBb'))
   from jsonb_array_elements(public.analysis_leak_examples('{"analysisVersion":"analysis/3"}', null, null,
     '[{"id":"bb","keys":["preflop|vs-open|fffrf|BB|fold|call"]}]') -> 'leaks' -> 0 -> 'rows') r),
  '[["00000000-0000-0000-0000-0000000b5202",5,"blunder","2.000"],
    ["00000000-0000-0000-0000-0000000b5201",5,"mistake","0.800"],
    ["00000000-0000-0000-0000-0000000b5205",5,"inaccurate","0.200"]]'::jsonb,
  'examples: a leak''s decisions, costliest first, with where the replayer opens');
select is(
  (select jsonb_agg(r ->> 'handId') from jsonb_array_elements(public.analysis_leak_examples('{"analysisVersion":"analysis/3"}',
     '2026-03-01', '2026-03-30', '[{"id":"bb","keys":["preflop|vs-open|fffrf|BB|fold|call"]}]', 1) -> 'leaks' -> 0 -> 'rows') r),
  '["00000000-0000-0000-0000-0000000b5202"]'::jsonb, '... inside the days, capped');
select is(
  public.analysis_leak_examples('{"analysisVersion":"analysis/3"}', null, null,
    '[{"id":"utg","keys":["preflop|unopened||UTG|raise|raise"]},{"id":"bb","keys":["preflop|vs-open|fffrf|BB|fold|call"]}]',
    5) -> 'leaks' -> 0,
  '{"id":"utg","rows":[]}'::jsonb, '... never a Perfect decision, and each leak in the order asked');
select is(
  public.analysis_leak_examples('{"analysisVersion":"analysis/3","gameFormat":"tournament"}', null, null,
    '[{"id":"bb","keys":["preflop|vs-open|fffrf|BB|fold|call"]}]') -> 'leaks' -> 0 -> 'rows',
  '[]'::jsonb, '... and the filters apply');
select is(
  public.analysis_leak_examples('{"analysisVersion":"analysis/3"}', null, null,
    '[{"id":"r","keys":["river|pfr-oop-first||CO|bet|check"]}]') -> 'leaks' -> 0 -> 'rows' -> 0 ->> 'handClass',
  null, 'a decision without a hand class reads null');
select throws_ok(
  $$select public.analysis_leak_examples('{}', null, null, '[{"id":"x","keys":["not a key"]}]')$$,
  '22023', null, 'examples refuse a spot key that is not one');
select throws_ok(
  $$select public.analysis_leak_examples('{}', null, null,
      (select jsonb_agg(jsonb_build_object('id', g::text, 'keys', '["river|x||CO|bet|check"]'::jsonb)) from generate_series(1, 11) g))$$,
  '22023', null, '... and more than ten leaks');
select throws_ok($$select public.analysis_top_leaks('{}', 'week')$$, '22023', null, 'the period is 30d or all');

-- -------------------------------------------------------------- B, anon --

select pg_temp.act_as('00000000-0000-0000-0000-0000000b52b1');
select is((public.save_hand_analysis(jsonb_build_array(
  pg_temp.hand('00000000-0000-0000-0000-0000000b5b01', 'single-raised', jsonb_build_array(
    pg_temp.dec(0, 5, 'preflop', 'fold', 'vs-open', 'chart', 'blunder', 3.0, 'call',
      '{"handClass":"AA","position":"BB","chart":{"set":"nlhe-cash-6max-100bb","line":"fffrf"}}')))
)) ->> 'decisions')::int, 1, 'B saves one hand');
select is((public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', 'all') -> 'sample' ->> 'hands')::int, 1,
  'B''s top three reads B''s one hand');
select is(
  (select jsonb_agg(r ->> 'handId') from jsonb_array_elements(public.analysis_leak_examples('{"analysisVersion":"analysis/3"}',
     null, null, '[{"id":"bb","keys":["preflop|vs-open|fffrf|BB|fold|call"]}]') -> 'leaks' -> 0 -> 'rows') r),
  '["00000000-0000-0000-0000-0000000b5b01"]'::jsonb, '... and B''s examples only B''s hand');
select is((select count(*)::int from public.analysis_leak_rows), 1, 'B sees one leak row of the eight');
select is(
  (select (public.analysis_leak_sample('00000000-0000-0000-0000-0000000b52a1', 'analysis/3', null, null, null, null, null) ->> 'graded')::int),
  0, 'the sample helper, asked for A''s rows by B, reads nothing (RLS)');

select pg_temp.act_as_anon();
select throws_ok($$select public.analysis_top_leaks('{}', 'all')$$, '42501', null, 'anon cannot read the top three');
select throws_ok($$select public.analysis_leak_examples('{}', null, null, '[]')$$, '42501', null, '... nor examples');

-- -------------------------------------------- prune, delete, rebuild --

-- A's t3 also at another version (as postgres: the save checks nothing else), then pruned.
reset role;
insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, hero_seat, grade, score, decisions, analysed, pot_type)
values ('00000000-0000-0000-0000-0000000b5203', '00000000-0000-0000-0000-0000000b52a1', 'analysis/2', 'full', 1, 'perfect', 100, 1, 1, 'single-raised');
insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status, node,
                                      scenario, source, grade, score, ev_loss_bb, ev_loss_pot, options, facts)
values ('00000000-0000-0000-0000-0000000b5203', '00000000-0000-0000-0000-0000000b52a1', 'analysis/2', 0, 2, 'preflop',
        'raise', 'analysed', 'n', 'unopened', 'chart', 'mistake', 40, 1, 0.1,
        '[{"action":"raise","ev":0},{"action":"fold","ev":1}]', '{"position":"UTG","chart":{"line":""}}');
select is((select count(*)::int from public.analysis_leak_rows where analysis_version = 'analysis/2'), 1,
  'a write at another version gets its own leak row');

select pg_temp.act_as('00000000-0000-0000-0000-0000000b52a1');
select is((public.prune_hand_analysis('analysis/3') ->> 'deleted')::int, 1, 'A prunes the other version');
reset role;
select is((select count(*)::int from public.analysis_leak_rows where analysis_version = 'analysis/2')
        + (select count(*)::int from public.analysis_leak_days where analysis_version = 'analysis/2')
        + (select count(*)::int from public.analysis_leak_day_hands where analysis_version = 'analysis/2'),
  0, '... and its leak rows and sums go with it');

-- A hand deleted: its decisions cascade away after it, the leak rows still know their day.
delete from public.hands where id = '00000000-0000-0000-0000-0000000b5202';
select is((select count(*)::int from public.analysis_leak_rows where hand_id = '00000000-0000-0000-0000-0000000b5202'), 0,
  'a deleted hand''s leak rows go');
select pg_temp.act_as('00000000-0000-0000-0000-0000000b52a1');
select ok(pg_temp.all_same('{"analysisVersion":"analysis/3"}') and pg_temp.all_same('{"analysisVersion":"analysis/3","position":"BB"}'),
  '... and the sums equal analysis_leaks again');
select is((public.analysis_top_leaks('{"analysisVersion":"analysis/3"}', 'all') -> 'sample' ->> 'hands')::int, 5,
  '... with one hand fewer');

-- The rebuild recounts the same.
reset role;
create temp table before_days as select * from public.analysis_leak_days;
create temp table before_hands as select * from public.analysis_leak_day_hands;
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-0000000b52a1');
select ok(
  not exists (select * from before_days except select * from public.analysis_leak_days)
  and not exists (select * from public.analysis_leak_days except select * from before_days)
  and not exists (select * from before_hands except select * from public.analysis_leak_day_hands)
  and not exists (select * from public.analysis_leak_day_hands except select * from before_hands),
  'the rebuild recounts exactly what the triggers kept');

-- An account deleted takes its sums with it.
delete from auth.users where id = '00000000-0000-0000-0000-0000000b52b1';
select is((select count(*)::int from public.analysis_leak_rows where owner_id = '00000000-0000-0000-0000-0000000b52b1')
        + (select count(*)::int from public.analysis_leak_days where owner_id = '00000000-0000-0000-0000-0000000b52b1')
        + (select count(*)::int from public.analysis_leak_day_hands where owner_id = '00000000-0000-0000-0000-0000000b52b1'),
  0, 'a deleted account leaves no leak rows or sums');

select * from finish();
rollback;
