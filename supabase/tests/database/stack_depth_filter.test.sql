-- pgTAP: stack depth as a filter (`20271122110000_stack_depth_filter.sql`,
-- docs/ANALYTICS.md Step 11).
--
-- What has to hold:
--
--   * `rail_stack_bucket` is `config/stats/stack-buckets.json` (the edges
--     below are the file's; tests/test/stackBuckets.test.ts generates the
--     function from it), and the Stack chip's `library_stack` reads it;
--   * `save_hand_facts` stores the hero's effective stack (facts/2);
--   * the Effective stack chips (`effStacks`) narrow the Hands list
--     (`library_page`) and its counts (`library_facets`), the reports
--     (`report_hand_ids`: the graph, the figures, the Pool tab's win rates)
--     and the Analytics checker (`analysis_hand_ids`, the `hands` it is
--     given) to the same hands - the facts of the version the client reads;
--   * an id that is no bucket matches nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(17);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000eff01', 'eff.a@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- The buckets.
select is(
  (select string_agg(coalesce(public.rail_stack_bucket(t, 'filter'), 'null'), ' ' order by t)
     from unnest(array[-1, 0, 399, 400, 799, 800, 1199, 1200, 99999]) t),
  '0-40 0-40 0-40 40-80 40-80 80-120 80-120 120+ 120+',
  'filter: 0-40, 40-80, 80-120, 120+ (tenths), a stack below the first counts with it');
select is(
  (select string_agg(public.rail_stack_bucket(t, 'breakdown'), ' ' order by t)
     from unnest(array[0, 199, 200, 400, 700, 1000, 1500, 2499, 2500]) t),
  '0-20 0-20 20-40 40-70 70-100 100-150 150-250 150-250 250+',
  'breakdown: 0-20 ... 250+');
select is(public.rail_stack_bucket(null, 'filter'), null, 'no stack, no bucket');
select is(
  (select count(*) from generate_series(-20, 3000, 3) t
    where public.library_stack(t) is distinct from public.rail_stack_bucket(t, 'filter')),
  0::bigint, 'the Stack chip''s band is the filter bucket');
select is(public.library_stack(null), '', '... and '''' without statistics, as before');

-- A's four hands.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                          currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats, player_count,
                          played_at, hero_seat, hero_position, hero_cards, hero_hand_class, board_cards, player_names,
                          went_to_showdown, total_pot, hero_profit, site_hand_id) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000eff01', 'pokerstars:e1', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-05T12:00:00Z', 6, 'CO',
   '{Ah,Qd}', 'AQo', '{}', '{Hero,Villain}', false, 250, 150, 'e1'),
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000eff01', 'pokerstars:e2', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-04T12:00:00Z', 3, 'BB',
   '{9h,8h}', '98s', '{2c,7d,9s}', '{Hero,Villain}', true, 650, 350, 'e2'),
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000eff01', 'pokerstars:e3', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-03T12:00:00Z', 4, 'UTG',
   '{Kc,Kd}', 'KK', '{}', '{Hero}', false, 250, 150, 'e3'),
  ('00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-0000000eff01', 'pokerstars:e4', '{"schema":"phf/1"}', 'std',
   'pokerstars', 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6, 6, '2026-10-02T12:00:00Z', 1, 'BTN',
   '{7c,2d}', '72o', '{}', '{Hero}', false, 150, -50, 'e4');

select pg_temp.act_as('00000000-0000-0000-0000-0000000eff01');
select is(public.save_hand_facts($j$[
  {"hand_key": "pokerstars:e1", "facts_version": "facts/2", "eff_stack_tenths": 1000},
  {"hand_key": "pokerstars:e2", "facts_version": "facts/2", "eff_stack_tenths": 455},
  {"hand_key": "pokerstars:e3", "facts_version": "facts/2", "eff_stack_tenths": 1200},
  {"hand_key": "pokerstars:e4", "facts_version": "facts/2", "eff_stack_tenths": null},
  {"hand_key": "pokerstars:e4", "facts_version": "facts/1", "eff_stack_tenths": 300}
]$j$::jsonb) ->> 'inserted', '5', 'save_hand_facts stores the effective stack');
select is((select string_agg(coalesce(eff_stack_tenths::text, 'null'), ' ' order by hand_key)
             from public.hand_facts where facts_version = 'facts/2'),
  '1000 455 1200 null', '... as sent, null where the hand has no blind');

create function pg_temp.ids(p_filter jsonb) returns text language sql as $$
  select coalesce(string_agg(right(r ->> 'handKey', 1), '' order by r ->> 'handKey'), '')
  from jsonb_array_elements(public.library_page(p_filter || '{"statsVersion":"stats/2","factsVersion":"facts/2"}', null, 100) -> 'rows') r;
$$;
create function pg_temp.keys(p_ids uuid[]) returns text language sql as $$
  select coalesce(string_agg(right(h.hand_key, 1), '' order by h.hand_key), '')
  from public.hands h where h.id = any (p_ids);
$$;
grant execute on function pg_temp.ids(jsonb), pg_temp.keys(uuid[]) to authenticated;

select is(pg_temp.ids('{}'), '1234', 'no chip: every hand');
select is(pg_temp.ids('{"effStacks":["80-120"]}') || '/' || pg_temp.ids('{"effStacks":["40-80"]}') || '/'
          || pg_temp.ids('{"effStacks":["120+"]}'),
  '1/2/3', 'one chip: the hands in that bucket (1000 is 80-120, 1200 is 120+, 455 is 40-80)');
select is(pg_temp.ids('{"effStacks":["40-80","120+"]}'), '23', 'several chips: any of them');
select is(pg_temp.ids('{"effStacks":["0-40"]}'), '', 'the facts of the version the client reads (an older row''s is not read)');
select is(pg_temp.ids('{"effStacks":["90-95"]}') || '/' || pg_temp.ids('{"effStacks":["x; drop table hands"]}'), '/',
  'an id that is no bucket matches nothing');
select is((public.library_facets('{"statsVersion":"stats/2","factsVersion":"facts/2","effStacks":["80-120","40-80"]}') ->> 'total')::int, 2,
  'the counts read the chips');
select ok(public.library_beyond_rollups('{"effStacks":["80-120"],"factsVersion":"facts/2"}'),
  'a report with the chip reads the list''s hands');
select is(pg_temp.keys(public.report_hand_ids('{"statsVersion":"stats/2","factsVersion":"facts/2","effStacks":["40-80","80-120"]}')),
  '12', 'the reports (graph, figures, the Pool tab''s win rates): the same hands');
select is(pg_temp.keys(public.analysis_hand_ids('{"hands":{"statsVersion":"stats/2","factsVersion":"facts/2","effStacks":["120+"]}}')),
  '3', 'the Analytics checker''s hands: the same');
select is(pg_temp.ids('{"effStacks":["80-120"],"positions":["CO"]}') || '/' || pg_temp.ids('{"effStacks":["80-120"],"positions":["BB"]}'),
  '1/', 'with the other groups: every one');

select * from finish();
rollback;
