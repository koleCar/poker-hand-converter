-- pgTAP: the session review (R5.1) -- `20270721090000_session_review.sql`.
--
-- What has to hold:
--
--   * a session is `report_sessions`' (the gap rule over the shared filter,
--     bomb pots out by default): for every session `report_sessions` lists,
--     `session_review` at its start gives the same bounds, hands, tables and
--     result - with the default filter, with bomb pots, and with other gaps
--     (a break of exactly the gap does not split);
--   * without an instant, the latest session that has ended; one still being
--     played is named in `ongoing`, and reviewed only when asked for;
--   * the three lists: the worst graded decision per hand (Inaccurate or
--     worse, worst first), the preflop chart deviations (by EV), the biggest
--     pots (in big blinds), each capped by `p_limit`, with the hands they
--     name; the analysis counts at the asked version;
--   * the summary: money only for one currency of cash, an EV-cashout hand's
--     result left out, the all-in EV in place of the result;
--   * RLS: another account sees only its own hands, anon may not call it.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(47);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000c5a1', 'review.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000c5b1', 'review.b@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000c5c1', 'review.c@example.com', now(), now());

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

-- A's hands (ids ...c5NN), PokerStars $1/$2 unless said:
--   session 1 (2026-09-01): 11 10:00 T1 | 12 10:20 T2 | 13 10:45 T1 | 14 11:10 T2
--                           15 11:30 T1, a bomb pot (out by default)
--   session 2:              21 12:00 T3, an EV cashout | 22 12:10 T3, EUR | 23 12:40 T3
--   session 3 (still on):   31 now - 10 min | 32 now - 5 min
-- B: one hand at 10:05 on 2026-09-01. C: none.
create temp table gen (id uuid, owner uuid, n text, at timestamptz, tbl text, cur text, pot bigint, won bigint,
                       contributed bigint, bomb boolean, cashout boolean) on commit drop;
insert into gen values
  ('00000000-0000-0000-0000-00000000c511', '00000000-0000-0000-0000-00000000c5a1', '11', '2026-09-01T10:00:00Z', 'T1', 'USD', 2000, 0, 600, false, false),
  ('00000000-0000-0000-0000-00000000c512', '00000000-0000-0000-0000-00000000c5a1', '12', '2026-09-01T10:20:00Z', 'T2', 'USD', 6000, 6000, 3000, false, false),
  ('00000000-0000-0000-0000-00000000c513', '00000000-0000-0000-0000-00000000c5a1', '13', '2026-09-01T10:45:00Z', 'T1', 'USD', 1000, 0, 400, false, false),
  ('00000000-0000-0000-0000-00000000c514', '00000000-0000-0000-0000-00000000c5a1', '14', '2026-09-01T11:10:00Z', 'T2', 'USD', 40000, 0, 20000, false, false),
  ('00000000-0000-0000-0000-00000000c515', '00000000-0000-0000-0000-00000000c5a1', '15', '2026-09-01T11:30:00Z', 'T1', 'USD', 900, 900, 300, true, false),
  ('00000000-0000-0000-0000-00000000c521', '00000000-0000-0000-0000-00000000c5a1', '21', '2026-09-01T12:00:00Z', 'T3', 'USD', 3000, 3000, 1000, false, true),
  ('00000000-0000-0000-0000-00000000c522', '00000000-0000-0000-0000-00000000c5a1', '22', '2026-09-01T12:10:00Z', 'T3', 'EUR', 800, 0, 200, false, false),
  ('00000000-0000-0000-0000-00000000c523', '00000000-0000-0000-0000-00000000c5a1', '23', '2026-09-01T12:40:00Z', 'T3', 'USD', 1200, 1200, 400, false, false),
  ('00000000-0000-0000-0000-00000000c531', '00000000-0000-0000-0000-00000000c5a1', '31', now() - interval '10 minutes', 'T4', 'USD', 500, 0, 200, false, false),
  ('00000000-0000-0000-0000-00000000c532', '00000000-0000-0000-0000-00000000c5a1', '32', now() - interval '5 minutes', 'T4', 'USD', 500, 500, 200, false, false),
  ('00000000-0000-0000-0000-00000000c5b9', '00000000-0000-0000-0000-00000000c5b1', 'b9', '2026-09-01T10:05:00Z', 'TB', 'USD', 700, 700, 300, false, false);

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, table_name, total_pot,
                          hero_profit, site_hand_id)
select g.id, g.owner, 'pokerstars:r' || g.n, '{"schema":"phf/1"}', 'std', 'pokerstars', 'cash', 'holdem', 'nl',
       g.cur, 100, case g.cur when 'USD' then '$' else '€' end, 100, 200, 6, 6, g.at, 1, 'BTN', '{Ah,Kh}', 'AKs',
       g.tbl, g.pot, g.won - g.contributed, 'r' || g.n
from gen g;

insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, game_format,
                               currency, currency_minor_units, big_blind, played_at, won, contributed, net, net_bb_milli,
                               table_name, "position", max_seats, player_count, is_bomb_pot, has_cashout, pot_type)
select g.id, g.owner, 'stats/2', 1, 'pokerstars:r' || g.n, 'pokerstars', true, 1, 'cash', g.cur, 100, 200, g.at,
       g.won, g.contributed, g.won - g.contributed, (g.won - g.contributed) * 1000 / 200, g.tbl, 'BTN', 6, 6,
       g.bomb, g.cashout, case when g.bomb then 'bomb' else 'single-raised' end
from gen g;

-- Hand 12 was all in with cards to come: its EV is 8 bb more than its result.
insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli) values
  ('00000000-0000-0000-0000-00000000c512', '00000000-0000-0000-0000-00000000c5a1', 1, 'ev/1', 'pokerstars:r12', true, 4600, 23000),
  ('00000000-0000-0000-0000-00000000c513', '00000000-0000-0000-0000-00000000c5a1', 1, 'ev/1', 'pokerstars:r13', false, -400, -2000);

-- The analysis (analysis/9): 11 a preflop chart Blunder (3 bb); 12 a Good
-- preflop and a flop Mistake (1.5 bb); 13 a preflop chart Inaccurate (0.2 bb)
-- and a river Blunder (5 bb); 14 none yet. Session 2's 22 a not-analysed row.
insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason, hero_seat, grade, score,
                                  ev_loss_bb, ev_loss_pot, decisions, analysed, pot_type) values
  ('00000000-0000-0000-0000-00000000c511', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 'full', null, 1, 'blunder', 10, 3, 0.5, 1, 1, 'single-raised'),
  ('00000000-0000-0000-0000-00000000c512', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 'full', null, 1, 'mistake', 60, 1.5, 0.05, 2, 2, 'single-raised'),
  ('00000000-0000-0000-0000-00000000c513', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 'full', null, 1, 'blunder', 30, 5.2, 0.4, 2, 2, 'single-raised'),
  ('00000000-0000-0000-0000-00000000c522', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 'not-analysed', 'multiway', 1, null, null, null, null, 1, 0, null);

insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status,
                                      node, scenario, source, grade, score, ev_loss_bb, ev_loss_pot, freq_diff,
                                      options, chosen, facts) values
  ('00000000-0000-0000-0000-00000000c511', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 0, 4, 'preflop', 'call', 'analysed',
   'pre|vs-open', 'vs-open', 'chart', 'blunder', 10, 3, 0.5, 0.97,
   '[{"action":"fold","freq":0.99,"ev":0},{"action":"call","freq":0.01,"ev":-3}]', 1, '{"position":"BTN"}'),
  ('00000000-0000-0000-0000-00000000c512', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 0, 4, 'preflop', 'raise', 'analysed',
   'pre|unopened', 'unopened', 'chart', 'good', 90, 0.01, 0.001, 0.2,
   '[{"action":"fold","freq":0.6,"ev":0},{"action":"raise","freq":0.4,"ev":0.1}]', 1, '{"position":"BTN"}'),
  ('00000000-0000-0000-0000-00000000c512', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 1, 9, 'flop', 'bet', 'analysed',
   'flop|cbet', 'cbet', 'solver', 'mistake', 40, 1.5, 0.05, 0.6,
   '[{"action":"check","freq":0.8,"ev":2},{"action":"bet","freq":0.2,"ev":0.5}]', 1, '{}'),
  ('00000000-0000-0000-0000-00000000c513', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 0, 4, 'preflop', 'raise', 'analysed',
   'pre|unopened', 'unopened', 'chart', 'inaccurate', 70, 0.2, 0.01, 0.98,
   '[{"action":"fold","freq":0.99,"ev":0},{"action":"raise","freq":0.01,"ev":-0.2}]', 1, '{"position":"BTN"}'),
  ('00000000-0000-0000-0000-00000000c513', '00000000-0000-0000-0000-00000000c5a1', 'analysis/9', 1, 15, 'river', 'call', 'analysed',
   'river|vs-bet', 'vs-bet', 'solver', 'blunder', 0, 5, 0.4, 1,
   '[{"action":"fold","freq":1,"ev":0},{"action":"call","freq":0,"ev":-5}]', 1, '{}');

-- Helpers: the review as a user, and a session's bounds and counts.
create function pg_temp.review(p_filter jsonb, p_at timestamptz default null, p_gap integer default 30, p_limit integer default 20)
returns jsonb language sql as $$
  select public.session_review(p_filter || '{"statsVersion":"stats/2","evVersion":"ev/1","analysisVersion":"analysis/9"}',
                               p_at, p_gap, p_limit);
$$;
create function pg_temp.bounds(p_review jsonb) returns text language sql as $$
  select to_char((p_review -> 'session' ->> 'startedAt')::timestamptz at time zone 'UTC', 'HH24:MI') || '-'
      || to_char((p_review -> 'session' ->> 'endedAt')::timestamptz at time zone 'UTC', 'HH24:MI') || ' '
      || (p_review -> 'session' ->> 'hands') || 'h ' || (p_review -> 'session' ->> 'tables') || 't';
$$;
-- The last two characters of each hand id of a list, in order.
create function pg_temp.ids(p_list jsonb) returns text language sql as $$
  select coalesce(string_agg(right(x ->> 'handId', 2), ',' order by o), '')
  from jsonb_array_elements(p_list) with ordinality as t(x, o);
$$;
-- Every session `report_sessions` lists, compared with `session_review` at its start.
create function pg_temp.agrees(p_filter jsonb, p_gap integer) returns text language plpgsql as $$
declare
  v_list jsonb := public.report_sessions(p_filter || '{"statsVersion":"stats/2"}', p_gap);
  v_s    jsonb;
  v_r    jsonb;
  v_bad  text := '';
  v_n    integer := 0;
begin
  for v_s in select * from jsonb_array_elements(v_list -> 'sessions') loop
    v_n := v_n + 1;
    v_r := pg_temp.review(p_filter, (v_s ->> 'startedAt')::timestamptz, p_gap) -> 'session';
    if (v_r ->> 'startedAt')::timestamptz is distinct from (v_s ->> 'startedAt')::timestamptz
       or (v_r ->> 'endedAt')::timestamptz is distinct from (v_s ->> 'endedAt')::timestamptz
       or (v_r ->> 'hands') is distinct from (v_s ->> 'hands')
       or (v_r ->> 'tables') is distinct from (v_s ->> 'tables')
       or (v_r ->> 'netBbMilli') is distinct from (v_s ->> 'netBbMilli') then
      v_bad := v_bad || ' ' || (v_s ->> 'startedAt') || ' list ' || v_s::text || ' review ' || v_r::text;
    end if;
  end loop;
  return case when v_bad = '' then v_n || ' sessions agree' else v_bad end;
end;
$$;
grant select on gen to authenticated;
grant execute on function pg_temp.review(jsonb, timestamptz, integer, integer), pg_temp.bounds(jsonb),
  pg_temp.ids(jsonb), pg_temp.agrees(jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. The function and who may call it
-- ---------------------------------------------------------------------------

select has_function('public', 'session_review', array['jsonb', 'timestamp with time zone', 'integer', 'integer'],
                    'session_review(filter, at, gap, limit) exists');
select ok(not (select prosecdef from pg_proc where oid = 'public.session_review(jsonb, timestamptz, integer, integer)'::regprocedure),
          'it is security invoker (RLS applies)');
select ok(has_function_privilege('authenticated', 'public.session_review(jsonb, timestamptz, integer, integer)', 'execute'),
          'a signed-in user may call it');
select ok(not has_function_privilege('anon', 'public.session_review(jsonb, timestamptz, integer, integer)', 'execute'),
          'anon may not');
select ok(not has_function_privilege('public', 'public.session_review(jsonb, timestamptz, integer, integer)', 'execute'),
          'nor may public');

select pg_temp.act_as_anon();
select throws_ok($$ select public.session_review('{}'::jsonb, null, 30, 20) $$, '42501', null, 'anon is refused');

-- ---------------------------------------------------------------------------
-- 2. Which session
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000c5a1');

select is(pg_temp.bounds(pg_temp.review('{}')), '12:00-12:40 3h 1t',
          'no instant: the latest session that has ended (the one still being played is not reviewed)');
select ok(pg_temp.review('{}') -> 'ongoing' is not null
          and (pg_temp.review('{}') -> 'ongoing' ->> 'startedAt')::timestamptz = (select at from gen where n = '31'),
          '... and the one still being played is named as ongoing');
select is((pg_temp.review('{}') -> 'session' ->> 'previousAt')::timestamptz, '2026-09-01T11:10:00Z'::timestamptz,
          'previousAt: the last hand of the session before (the bomb pot left out)');
select is((pg_temp.review('{}') -> 'session' ->> 'nextAt')::timestamptz, (select at from gen where n = '31'),
          'nextAt: the first hand of the session after');
select is((pg_temp.review('{}', (select at from gen where n = '31')) -> 'session' ->> 'finished')::boolean, false,
          'asked for by its instant, the ongoing session is reviewed, marked not finished');
select ok(pg_temp.review('{}', (select at from gen where n = '31')) -> 'ongoing' = 'null'::jsonb,
          '... with no ongoing note');

select is(pg_temp.bounds(pg_temp.review('{}', '2026-09-01T10:00:00Z')), '10:00-11:10 4h 2t',
          'at its first hand: session 1, the bomb pot out');
select is(pg_temp.bounds(pg_temp.review('{}', '2026-09-01T10:30:00Z')), '10:00-11:10 4h 2t',
          'at an instant inside it: the same session');
select is(pg_temp.bounds(pg_temp.review('{}', '2026-08-01T00:00:00Z')), '10:00-11:10 4h 2t',
          'before every hand: the first session');
select is(pg_temp.bounds(pg_temp.review('{"includeBombPots":true}', '2026-09-01T10:00:00Z')), '10:00-12:40 8h 3t',
          'with bomb pots: 11:30 then 12:00 is a break of exactly the gap, which does not split');
select is(pg_temp.bounds(pg_temp.review('{}', '2026-09-01T10:00:00Z', 20)), '10:00-10:20 2h 2t',
          'a 20-minute gap splits at the 25-minute break');
select is((pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' ->> 'finished')::boolean, true, 'an old session has ended');
select ok(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' -> 'previousAt' = 'null'::jsonb,
          'the first session has no previous one');

-- The same sessions as `report_sessions`.
select is(pg_temp.agrees('{}', 30), '3 sessions agree', 'report_sessions'' sessions, default filter: same bounds, hands, tables, result');
select is(pg_temp.agrees('{"includeBombPots":true}', 30), '2 sessions agree', '... with bomb pots');
select is(pg_temp.agrees('{}', 15), '7 sessions agree', '... with a 15-minute gap');
select is(pg_temp.agrees('{}', 120), '2 sessions agree', '... with a two-hour gap');

-- ---------------------------------------------------------------------------
-- 3. The summary
-- ---------------------------------------------------------------------------

select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' -> 'netBbMilli', '-90000'::jsonb,
          'session 1 in big blinds (thousandths): -3 + 15 - 2 - 100 = -90 bb');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' -> 'net', '-18000'::jsonb,
          'in money (minor units): one currency of cash');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' -> 'evNetBbMilli', '-82000'::jsonb,
          'all-in EV adjusted: hand 12 counts at its EV (+8 bb)');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' -> 'allInHands', '1'::jsonb, 'one all-in hand');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'session' ->> 'currencySymbol', '$', 'the currency''s symbol');
select is(pg_temp.review('{}') -> 'session' -> 'net', 'null'::jsonb, 'session 2 spans two currencies: no money');
select is(pg_temp.review('{}') -> 'session' -> 'netBbMilli', '3000'::jsonb,
          '... its big blinds without the EV cashout hand (-1 + 4 = 3 bb)');

-- ---------------------------------------------------------------------------
-- 4. The lists
-- ---------------------------------------------------------------------------

select is(pg_temp.ids(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'worst'), '13,11,12',
          'worst: per hand its worst decision, Blunders first, then by EV');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'worst' -> 0 ->> 'street', 'river',
          '... hand 13 by its river Blunder, not its preflop Inaccurate');
select is(pg_temp.ids(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'deviations'), '11,13',
          'deviations: the preflop chart decisions of Inaccurate or worse, by EV (a Good one is not)');
select is((select jsonb_build_object('best', x -> 'best', 'action', x -> 'action', 'freq', x -> 'chosenFreq',
                                     'position', x -> 'position', 'actionIndex', x -> 'actionIndex')
           from jsonb_array_elements(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'deviations') x limit 1),
          '{"best":"fold","action":"call","freq":0.01,"position":"BTN","actionIndex":4}'::jsonb,
          '... with the action taken, the chart''s best, how often the chart plays it, the seat and where to open the hand');
select is(pg_temp.ids(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'pots'), '14,12,11,13',
          'pots: biggest first');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'pots' -> 0 -> 'potBb', '200.00'::jsonb, '... in big blinds');
select is((select string_agg(right(k, 2), ',' order by k) from jsonb_object_keys(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'hands') k),
          '11,12,13,14', 'every hand a list names is described, once');
select is((pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'hands' -> '00000000-0000-0000-0000-00000000c512') - 'playedAt',
          '{"site":"pokerstars","board":[],"grade":"mistake","net":3000,"potBb":30.00,"bigBlind":200,"currency":"USD","evLossBb":1.500,
            "position":"BTN","potType":"single-raised","handClass":"AKs","heroCards":["Ah","Kh"],"tableName":"T2","gameFormat":"cash",
            "minorUnits":100,"netBbMilli":15000,"stakesLabel":null,"evNetBbMilli":23000,"currencySymbol":"$"}'::jsonb,
          '... with its cards, seat, pot, result, all-in EV and grade');
select is(pg_temp.review('{}', '2026-09-01T10:00:00Z') -> 'analysis',
          '{"hands":4,"analysed":3,"graded":3,"notAnalysed":0}'::jsonb, 'analysis: 3 of 4 hands analysed and graded');
select is(pg_temp.review('{}') -> 'analysis', '{"hands":3,"analysed":1,"graded":0,"notAnalysed":1}'::jsonb,
          '... session 2: one not-analysed row');
select is(jsonb_build_array(jsonb_array_length(pg_temp.review('{}', '2026-09-01T10:00:00Z', 30, 1) -> 'worst'),
                            jsonb_array_length(pg_temp.review('{}', '2026-09-01T10:00:00Z', 30, 1) -> 'deviations'),
                            jsonb_array_length(pg_temp.review('{}', '2026-09-01T10:00:00Z', 30, 1) -> 'pots')),
          '[1,1,1]'::jsonb, 'p_limit caps each list');
select is(public.session_review('{"statsVersion":"stats/2","analysisVersion":"analysis/8"}', '2026-09-01T10:00:00Z') -> 'worst',
          '[]'::jsonb, 'another analysis version: none of these grades');
select throws_ok($$ select public.session_review('{"statsVersion":"stats/2","analysisVersion":"v9"}') $$, '22023', null,
                 'an analysis version that is not one is refused');

-- ---------------------------------------------------------------------------
-- 5. Accounts
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-00000000c5b1');
select is(pg_temp.bounds(pg_temp.review('{}', '2026-09-01T10:00:00Z')), '10:05-10:05 1h 1t',
          'B at A''s instant: B''s own session, none of A''s hands in it');
select pg_temp.act_as('00000000-0000-0000-0000-00000000c5c1');
select ok(pg_temp.review('{}') -> 'session' = 'null'::jsonb, 'an account with no hands has no session');

-- A long session: C plays 1 200 hands a minute apart (the walk reads the
-- index in chunks of 500), then one more after a long break.
select pg_temp.as_postgres();
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, currency, currency_minor_units,
                          small_blind, big_blind, max_seats, player_count, played_at, hero_seat, total_pot, hero_profit)
select md5('long' || g)::uuid, '00000000-0000-0000-0000-00000000c5c1', 'pokerstars:long' || g, '{"schema":"phf/1"}', 'std',
       'pokerstars', 'cash', 'USD', 100, 100, 200, 6, 6,
       case when g = 1201 then '2026-09-03T12:00:00Z'::timestamptz
            else '2026-09-02T00:00:00Z'::timestamptz + make_interval(mins => g) end,
       1, 600, 0
from generate_series(1, 1201) g
where g <= 600;
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, currency, currency_minor_units,
                          small_blind, big_blind, max_seats, player_count, played_at, hero_seat, total_pot, hero_profit)
select md5('long' || g)::uuid, '00000000-0000-0000-0000-00000000c5c1', 'pokerstars:long' || g, '{"schema":"phf/1"}', 'std',
       'pokerstars', 'cash', 'USD', 100, 100, 200, 6, 6,
       case when g = 1201 then '2026-09-03T12:00:00Z'::timestamptz
            else '2026-09-02T00:00:00Z'::timestamptz + make_interval(mins => g) end,
       1, 600, 0
from generate_series(601, 1201) g;
-- (At most 1 000 rows a statement: the writers' batch limit.)
insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, game_format,
                               currency, currency_minor_units, big_blind, played_at, won, contributed, net, net_bb_milli)
select h.id, h.owner_id, 'stats/2', 1, h.hand_key, 'pokerstars', true, 1, 'cash', 'USD', 100, 200, h.played_at, 0, 0, 0, 0
from public.hands h where h.owner_id = '00000000-0000-0000-0000-00000000c5c1' and h.played_at < '2026-09-02T10:00:30Z';
insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, game_format,
                               currency, currency_minor_units, big_blind, played_at, won, contributed, net, net_bb_milli)
select h.id, h.owner_id, 'stats/2', 1, h.hand_key, 'pokerstars', true, 1, 'cash', 'USD', 100, 200, h.played_at, 0, 0, 0, 0
from public.hands h where h.owner_id = '00000000-0000-0000-0000-00000000c5c1' and h.played_at >= '2026-09-02T10:00:30Z';
select pg_temp.act_as('00000000-0000-0000-0000-00000000c5c1');
select is(pg_temp.bounds(pg_temp.review('{}', '2026-09-02T10:00:00Z')), '00:01-20:00 1200h 0t',
          'a session of 1 200 hands is walked whole, both ways, across chunks');
select is(pg_temp.bounds(pg_temp.review('{}')), '12:00-12:00 1h 0t', '... and the hand after the break is the next session');

select * from finish();
rollback;
