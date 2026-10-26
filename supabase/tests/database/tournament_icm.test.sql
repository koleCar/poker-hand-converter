-- pgTAP: tournament decisions graded by ICM (R5.5b) -- `20270901090000_tournament_icm.sql`.
--
-- What has to hold:
--
--   * security: `tournament_settings` is the owner's only - select, insert,
--     update and delete under RLS for `authenticated`, nothing for `anon`;
--     another account neither sees, changes nor deletes a row; an update
--     cannot move a row to another account or tournament; the guard and the
--     re-queue are definer and executable by no client role;
--   * the shape: `tournament_settings_problem` gives `settingsProblem`'s
--     codes (`frontend/src/lib/analysis/tournament.ts`, the same cases in
--     `tests/test/analysisIcm.test.ts`); a write is refused with it; 2 000
--     tournaments an account, 120 writes per 10 minutes;
--   * a write (insert, update, delete) deletes the stored analysis of the
--     owner's hands of that tournament - every version - and nothing else:
--     not another tournament's, not a cash hand's, not another account's;
--     the decisions go with it, and so do their own-chart rows;
--   * `decision_analysis.source` takes `icm`; a push/fold decision is filed
--     for the user's own charts by `facts.icm.chart` (the push/fold tables'
--     ids, lines in the charts' vocabulary);
--   * a shared hand keeps `facts.icm` without the tournament key, and still
--     keeps `multiway`;
--   * a deleted account leaves no settings.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(41);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000ca01', 'icm.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000cb01', 'icm.b@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000cc01', 'icm.c@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000cd01', 'icm.d@example.com', now(), now());

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

create function pg_temp.refused(p_sql text, p_like text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlerrm like p_like;
end;
$$;
grant execute on function pg_temp.refused(text, text) to authenticated, anon;

create function pg_temp.affected(p_sql text) returns int language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function pg_temp.affected(text) to authenticated;

-- ---------------------------------------------------------- security --

select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.tournament_settings'::regclass),
  'tournament_settings exists with row level security');
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'tournament_settings' and grantee = 'anon'),
  0, '... nothing at all for anon');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'tournament_settings'
     and coalesce(qual, '') || coalesce(with_check, '') like '%auth.uid()%'),
  4, '... a policy per command, each the owner''s');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 2 from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('tournament_settings_guard', 'tournament_settings_requeue')),
  'the guard and the re-queue are security definer');
select ok(
  not has_function_privilege('authenticated', 'public.tournament_settings_guard()', 'execute')
  and not has_function_privilege('authenticated', 'public.tournament_settings_requeue()', 'execute')
  and not has_function_privilege('anon', 'public.tournament_settings_guard()', 'execute')
  and not has_function_privilege('anon', 'public.tournament_settings_requeue()', 'execute'),
  '... executable by no client role');
select ok(
  has_function_privilege('authenticated', 'public.tournament_settings_problem(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.tournament_settings_problem(jsonb)', 'execute'),
  'the shape check is callable by the signed-in, not anon');

-- -------------------------------------------------------------- the shape --
-- The same cases as `settingsProblem` in tests/test/analysisIcm.test.ts.

select is(public.tournament_settings_problem('{}'), null, 'no settings: nothing wrong');
select is(public.tournament_settings_problem(
  '{"kind":"sng","payouts":[50,30,20],"entrants":9,"startingStack":1500,"playersLeft":[{"at":"2026-01-01T00:00:00Z","left":5}]}'),
  null, 'a whole set of settings: nothing wrong');
select is(
  array[
    public.tournament_settings_problem('{"kind":"cash"}'),
    public.tournament_settings_problem('{"payouts":[]}'),
    public.tournament_settings_problem('{"payouts":[30,50]}'),
    public.tournament_settings_problem('{"payouts":[60,50]}'),
    public.tournament_settings_problem('{"payouts":[0]}'),
    public.tournament_settings_problem('{"entrants":1}'),
    public.tournament_settings_problem('{"entrants":2.5}'),
    public.tournament_settings_problem('{"startingStack":0}'),
    public.tournament_settings_problem('{"playersLeft":[{"at":"yesterday","left":5}]}'),
    public.tournament_settings_problem('{"entrants":9,"playersLeft":[{"at":"2026-01-01T00:00:00Z","left":10}]}'),
    public.tournament_settings_problem('{"entrants":2,"payouts":[50,30,20]}'),
    public.tournament_settings_problem('{"rake":5}')
  ],
  array['kind', 'payouts', 'payouts-order', 'payouts-sum', 'payouts', 'entrants', 'entrants', 'starting-stack',
        'players-left', 'players-left', 'payouts-places', 'settings'],
  'every refusal names settingsProblem''s code');

-- ------------------------------------------------------------- the hands --
--
--   a1 a2   account A, weplay tournament 111 (a1 with an ICM decision)
--   a3      account A, weplay tournament 222
--   a4      account A, a cash hand
--   b1      account B, weplay tournament 111 too (the same id, another account)

create temp table gen (id uuid, owner uuid, n text, fmt text, tid text) on commit drop;
insert into gen values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000ca01', 'a1', 'tournament', '111'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000ca01', 'a2', 'tournament', '111'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000ca01', 'a3', 'tournament', '222'),
  ('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-00000000ca01', 'a4', 'cash', null),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000cb01', 'b1', 'tournament', '111');

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, table_name, total_pot,
                          hero_profit, site_hand_id, tournament_id)
select g.id, g.owner, 'weplay:icm' || g.n, '{"schema":"phf/1"}', 'std', 'weplay', g.fmt::public.game_format,
       'holdem', 'nl', 'USD', 100, '$', 100, 200, 9, 9, '2026-03-30T10:00:00Z', 1, 'CO', '{Ad,Kc}', 'AKo', 'T1', 1000, 0,
       'icm' || g.n, g.tid
from gen g;

create function pg_temp.analyse(p_version text) returns void language sql as $$
  insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, hero_seat, decisions, analysed)
  select g.id, g.owner, p_version, 'full', 1, 1, 1 from gen g
  on conflict do nothing;
$$;
select pg_temp.analyse('analysis/34');
select pg_temp.analyse('analysis/35');

-- a1's decision: a push from the cutoff of a 6-handed table read on the 6-seat chart table (earliest seats folded).
create function pg_temp.icm_facts(p_set text, p_line text, p_cls text) returns jsonb language sql as $$
  select jsonb_build_object('handClass', p_cls, 'position', 'CO', 'effStackBb', 14.2, 'allIn', true,
                            'icm', jsonb_build_object('model', 'icm', 'key', 'weplay:111', 'scenario', 'push',
                                                      'chart', jsonb_build_object('set', p_set, 'line', p_line)),
                            'multiway', jsonb_build_object('players', 3));
$$;

insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status,
                                      node, scenario, source, grade, ev_loss_bb, facts) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000ca01', 'analysis/35', 0, 12, 'preflop', 'raise', 'analysed',
   'n', 'push-fold', 'icm', 'mistake', 0.42, pg_temp.icm_facts('icm-pushfold-6max', 'ff', 'AKo')),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000ca01', 'analysis/35', 0, 14, 'preflop', 'call', 'analysed',
   'n', 'push-fold-call', 'icm', 'good', 0, pg_temp.icm_facts('icm-pushfold-9max', 'fffffa', 'AKo') || '{"allIn": false}'),
  ('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-00000000ca01', 'analysis/35', 0, 4, 'preflop', 'fold', 'analysed',
   'n', 'push-fold', 'icm', 'perfect', 0, pg_temp.icm_facts('icm-pushfold-hu', '', 'AKo') || '{"allIn": false}');

-- ------------------------------------------------- source and own charts --

select ok(
  pg_temp.refused($$insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action,
                     status, node, scenario, source) values ('00000000-0000-0000-0000-00000000c002',
                     '00000000-0000-0000-0000-00000000ca01', 'analysis/35', 0, 3, 'preflop', 'fold', 'analysed', 'n', 'x', 'bogus')$$,
                  '%decision_analysis_source_check%'),
  'decision_analysis takes icm and still refuses what is not a source');
select is(
  array[public.preflop_chart_set_table('icm-pushfold-hu'), public.preflop_chart_set_table('icm-pushfold-6max'),
        public.preflop_chart_set_table('icm-pushfold-9max'), public.preflop_chart_set_table('icm-pushfold-10max'),
        public.preflop_chart_set_table('nlhe-cash-9max-100bb')],
  array[2, 6, 9, null, 9]::smallint[],
  'the push/fold chart tables have their seats; the shipped sets keep theirs');
select is(
  (select string_agg(right(hand_id::text, 2) || ' ' || node_key || ' ' || hand_class || ' ' || action || ' '
                     || table_size || ' ' || depth_band || ' ' || game_format, '; ' order by hand_id)
   from public.preflop_decision_rows where owner_id = '00000000-0000-0000-0000-00000000ca01'),
  '01 rfi:CO 13 allin 6 10 tournament; 03 vs-open:BTN:CO 13 call 9 10 tournament; 04 rfi:SB 13 fold 2 10 cash',
  'a push/fold decision is filed for the own charts by facts.icm.chart: key, class, action, table, depth');
select is(
  (select count(*)::int from public.preflop_decision_totals where owner_id = '00000000-0000-0000-0000-00000000ca01'),
  3, '... and summed');

-- ------------------------------------------------------------- the writes --

select pg_temp.act_as('00000000-0000-0000-0000-00000000ca01');
select is(
  pg_temp.affected($$insert into public.tournament_settings (site, tournament_id, settings)
                     values ('weplay', '111', '{"kind":"mtt","payouts":[50,30,20],"entrants":30}')$$),
  1, 'the owner saves a tournament''s settings');
select is(
  (select owner_id from public.tournament_settings where site = 'weplay' and tournament_id = '111'),
  '00000000-0000-0000-0000-00000000ca01'::uuid, '... owned by them');
select ok(
  pg_temp.refused($$insert into public.tournament_settings (site, tournament_id, settings)
                    values ('weplay', '333', '{"payouts":[30,50]}')$$, 'Tournament settings not saved: payouts-order'),
  'settings the shape check refuses are not saved, and say why');
select ok(
  pg_temp.refused($$insert into public.tournament_settings (owner_id, site, tournament_id, settings)
                    values ('00000000-0000-0000-0000-00000000cb01', 'weplay', '444', '{}')$$, '%row-level security%'),
  'a row cannot be planted in another account');

reset role;
select is(
  (select string_agg(right(hand_id::text, 2) || ' ' || analysis_version, ', ' order by hand_id, analysis_version)
   from public.hand_analysis where hand_id in (select id from gen)),
  '03 analysis/34, 03 analysis/35, 04 analysis/34, 04 analysis/35, b1 analysis/34, b1 analysis/35',
  'saving deletes the stored analysis of the tournament''s hands, every version - not another tournament''s, a cash hand''s or another account''s');
select is(
  (select count(*)::int from public.decision_analysis where hand_id = '00000000-0000-0000-0000-00000000c001'),
  0, '... the decisions go with it');
select is(
  (select string_agg(right(hand_id::text, 2), ', ' order by hand_id) from public.preflop_decision_rows
   where owner_id = '00000000-0000-0000-0000-00000000ca01'),
  '03, 04', '... and their own-chart rows');
select is(
  (select sum(decisions)::int from public.preflop_decision_totals where owner_id = '00000000-0000-0000-0000-00000000ca01'),
  2, '... and their sums');

-- The update and delete paths re-queue too.
select pg_temp.analyse('analysis/35');
select pg_temp.act_as('00000000-0000-0000-0000-00000000ca01');
select is(
  pg_temp.affected($$update public.tournament_settings set settings = '{"kind":"sng"}', site = 'other', tournament_id = '999',
                     owner_id = '00000000-0000-0000-0000-00000000cb01' where site = 'weplay' and tournament_id = '111'$$),
  1, 'the owner updates their settings');
select is(
  (select site || ':' || tournament_id || ' ' || (settings ->> 'kind') from public.tournament_settings),
  'weplay:111 sng', '... the settings change; the tournament and the owner cannot');
reset role;
select is(
  (select count(*)::int from public.hand_analysis
   where hand_id in ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c002')),
  0, 'an update re-queues the tournament''s hands');
select pg_temp.analyse('analysis/35');

select pg_temp.act_as('00000000-0000-0000-0000-00000000cb01');
select is((select count(*)::int from public.tournament_settings), 0, 'another account reads none of them');
select is(
  pg_temp.affected($$update public.tournament_settings set settings = '{}'$$) +
  pg_temp.affected($$delete from public.tournament_settings$$),
  0, '... and changes or deletes none');
reset role;
select is(
  (select count(*)::int from public.hand_analysis
   where hand_id in ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c002')),
  2, '... so nothing of the owner''s is re-queued');

select pg_temp.act_as('00000000-0000-0000-0000-00000000ca01');
select is(
  pg_temp.affected($$delete from public.tournament_settings where site = 'weplay' and tournament_id = '111'$$),
  1, 'the owner deletes their settings');
reset role;
select is(
  (select count(*)::int from public.hand_analysis
   where hand_id in ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c002')),
  0, '... and the hands are analysed again on the assumptions');

select pg_temp.act_as_anon();
select ok(pg_temp.refused($$select * from public.tournament_settings$$, '%permission denied%'), 'anon cannot read the table');
select ok(
  pg_temp.refused($$insert into public.tournament_settings (site, tournament_id) values ('weplay', '1')$$, '%permission denied%'),
  '... nor write it');
reset role;

-- --------------------------------------------------------------- the limits --

-- 1 999 tournaments saved for account C without a session (no rate limit), then two by C.
insert into public.tournament_settings (owner_id, site, tournament_id, settings)
select '00000000-0000-0000-0000-00000000cc01', 'weplay', 'L' || n, '{}' from generate_series(1, 1999) n;
select pg_temp.act_as('00000000-0000-0000-0000-00000000cc01');
select is(
  pg_temp.affected($$insert into public.tournament_settings (site, tournament_id) values ('weplay', 'L2000')$$),
  1, 'the 2 000th tournament is saved');
select ok(
  pg_temp.refused($$insert into public.tournament_settings (site, tournament_id) values ('weplay', 'L2001')$$, '%At most 2000%'),
  '... the 2 001st is not');
select is(
  pg_temp.affected($$update public.tournament_settings set settings = '{"kind":"mtt"}' where tournament_id = 'L1'$$),
  1, '... an update at the limit still is');

-- 120 writes per 10 minutes: account D.
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000cd01');
select is(
  pg_temp.affected($$insert into public.tournament_settings (site, tournament_id) select 'weplay', 'R' || n from generate_series(1, 120) n$$),
  120, '120 writes in ten minutes are taken');
select ok(
  pg_temp.refused($$insert into public.tournament_settings (site, tournament_id) values ('weplay', 'R121')$$, '%rate%'),
  '... the 121st is not');
reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  pg_temp.refused($$insert into public.tournament_settings (owner_id, site, tournament_id) values
                    ('00000000-0000-0000-0000-00000000cd01', 'WePlay', 'X')$$, '%tournament_settings_site_check%'),
  'the site is stored lower-cased, as hands.site is');

-- --------------------------------------------------------- shared facts --

select is(
  public.analysis_public_facts(pg_temp.icm_facts('icm-pushfold-6max', 'ff', 'AKo')) -> 'icm',
  '{"model":"icm","scenario":"push","chart":{"set":"icm-pushfold-6max","line":"ff"}}'::jsonb,
  'a shared hand keeps the push/fold facts without the tournament key');
select ok(
  public.analysis_public_facts(pg_temp.icm_facts('icm-pushfold-6max', 'ff', 'AKo')) ? 'multiway',
  '... and still keeps multiway');
select ok(
  not (public.analysis_public_facts('{"villain":{"hands":30},"street":"preflop"}') ? 'villain'),
  '... and still drops what it never showed');

-- ------------------------------------------------------- a deleted account --

delete from auth.users where id = '00000000-0000-0000-0000-00000000cc01';
select is(
  (select count(*)::int from public.tournament_settings where owner_id = '00000000-0000-0000-0000-00000000cc01'),
  0, 'a deleted account leaves no settings');

select * from finish();
rollback;
