-- pgTAP: hand analysis, phase A9 -- `20270310090000_analysis_multiway.sql`.
--
--   * an approximate multiway grade (`source = 'approx'`) is stored through
--     the usual writer, as the caller, and read back under RLS;
--   * any other unknown source is still refused by the check;
--   * a shared analysis's fact projection keeps `multiway` and still drops
--     keys it does not know;
--   * nothing about who may call what changed.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(9);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000a9aa1', 'mw.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000a9bb1', 'mw.b@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, hero_position,
                          game_format, currency, big_blind, hero_profit, played_at) values
  ('00000000-0000-0000-0000-0000000a9001', '00000000-0000-0000-0000-0000000a9aa1', 'weplay:mw1',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 0, now()),
  ('00000000-0000-0000-0000-0000000a9002', '00000000-0000-0000-0000-0000000a9aa1', 'weplay:mw2',
   '{"schema":"phf/1"}', 'std', 'weplay', 1, 'BTN', 'cash', 'USD', 100, 0, now());

select pg_temp.act_as('00000000-0000-0000-0000-0000000a9aa1');

select is(public.save_hand_analysis($$[
  {"hand_id":"00000000-0000-0000-0000-0000000a9001","analysis_version":"analysis/7","status":"partial",
   "hero_seat":1,"pot_type":"single-raised","grade":"mistake","score":40,"ev_loss_bb":2.4,"ev_loss_pot":0.06,
   "approximations":["multiway-approx","narrowing-heuristic","rake-profile"],"decisions":[
     {"ord":4,"action_index":9,"street":"flop","action":"check","status":"not-analysed","reason":"multiway","node":"n",
      "scenario":"caller-mw-oop-first","source":"heuristic",
      "flags":[{"code":"multiway-slowplay","severity":"note","params":{"opponents":2,"equity":61}}],
      "facing_bet":false,"pot_bb":8,"facts":{"street":"flop","multiway":{"players":3,"field":0.61}}},
     {"ord":9,"action_index":20,"street":"river","action":"call","status":"analysed","node":"n",
      "scenario":"caller-mw-ip-vs-bet","source":"approx","grade":"mistake","score":40,"ev_loss_bb":2.4,
      "ev_loss_pot":0.06,"freq_diff":1,"chosen":1,
      "options":[{"action":"fold","freq":1,"ev":0},{"action":"call","freq":0,"ev":-2.4}],
      "approximations":["multiway-approx","narrowing-heuristic","rake-profile"],"flags":[],
      "facing_bet":true,"pot_bb":40,"pot_odds":0.2,"mdf":0.8,
      "facts":{"street":"river","multiway":{"players":3,"ev":{"call":-2.4}}}}]}
]$$::jsonb) ->> 'inserted', '1', 'an approximate multiway grade is saved through the writer');

select is(
  (select source || ':' || grade from public.decision_analysis
   where hand_id = '00000000-0000-0000-0000-0000000a9001' and ord = 9),
  'approx:mistake', 'and read back by its owner with its source and grade');
select is(
  (select row(decisions, analysed, flag_count, worst_flag)::text from public.hand_analysis
   where hand_id = '00000000-0000-0000-0000-0000000a9001'),
  '(2,1,1,note)', 'the hand''s counts include the multiway decisions, graded or not');

select throws_ok($$ select public.save_hand_analysis('[{"hand_id":"00000000-0000-0000-0000-0000000a9002","analysis_version":"analysis/7","status":"full","decisions":[
    {"ord":1,"action_index":1,"street":"river","action":"call","status":"analysed","node":"n","scenario":"x","source":"guess","facts":{}}]}]') $$,
  '23514', null, 'a source outside the four is refused');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a9bb1');
select is(
  (select count(*)::int from public.decision_analysis where hand_id = '00000000-0000-0000-0000-0000000a9001'),
  0, 'another user sees none of it');

reset role;

select is(
  public.analysis_public_facts('{"street":"river","multiway":{"players":3},"secret":1}'::jsonb),
  '{"street":"river","multiway":{"players":3}}'::jsonb,
  'the shared projection keeps the multiway facts and drops unknown keys');
select ok(
  not has_function_privilege('anon', 'public.analysis_public_facts(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_public_facts(jsonb)', 'execute'),
  'the projection is still internal');
select ok(
  (select coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%' from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'analysis_public_facts'),
  'its search_path is still pinned');
select ok(
  not has_table_privilege('authenticated', 'public.decision_analysis', 'insert'),
  'and there is still no direct write to the decisions');

select * from finish();
rollback;
