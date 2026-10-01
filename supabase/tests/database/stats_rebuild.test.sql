-- pgTAP: statistics coverage and the rebuild read path (F11, #44) --
-- `20261109090000_stats_rebuild.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(25);

-- ------------------------------------------------------------------ setup --

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000006a1', 'sr.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000006b1', 'sr.b@example.com', now(), now());

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
create function pg_temp.act_as_owner() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.act_as_anon(), pg_temp.act_as_owner() to anon, authenticated;

-- A: three hands with a hero (current, stale, missing) and one observed table.
-- B: one hand with no statistics.
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000006a1', 'pokerstars:sr1',
   '{"schema":"phf/1","n":1}', 'std', 'pokerstars', 1, now()),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000006a1', 'pokerstars:sr2',
   '{"schema":"phf/1","n":2}', 'std', 'pokerstars', 2, now()),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000006a1', 'pokerstars:sr3',
   '{"schema":"phf/1","n":3}', 'std', 'pokerstars', 3, now()),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000006a1', 'pokerstars:sr4',
   '{"schema":"phf/1","n":4}', 'std', 'pokerstars', null, now()),
  ('00000000-0000-0000-0000-00000000f0b1', '00000000-0000-0000-0000-0000000006b1', 'pokerstars:srb1',
   '{"schema":"phf/1","n":5}', 'std', 'pokerstars', 1, now());

insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000006a1', 'stats/9001', 1, 'pokerstars:sr1', 'pokerstars', true, 1),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000006a1', 'stats/9000', 1, 'pokerstars:sr1', 'pokerstars', true, 1),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000006a1', 'stats/9000', 2, 'pokerstars:sr2', 'pokerstars', true, 1);

-- -------------------------------------------------------------- coverage --

select pg_temp.act_as('00000000-0000-0000-0000-0000000006a1');

select is(public.stats_coverage('stats/9001') - 'stakes',
  '{"statsVersion":"stats/9001","hands":3,"atVersion":1,"stale":1,"missing":1,"withoutHero":1,"obsoleteRows":2}'::jsonb,
  'coverage splits current, stale, missing and hero-less hands');

select is((public.stats_coverage('stats/9000') ->> 'atVersion')::int, 2,
  'coverage is relative to the version asked about');
select is(public.stats_coverage('stats/9000') -> 'stakes',
  '[{"gameFormat":"cash","currency":"USD","currencyMinorUnits":100,"smallBlind":null,"bigBlind":null,"hands":2}]'::jsonb,
  'coverage lists the formats and stakes present at that version, with volumes');

-- ---------------------------------------------------- hands_needing_stats --

select is((select array_agg(id::text order by id) from public.hands_needing_stats('stats/9001')),
  array['00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000f003'],
  'needing stats: the stale and the missing hand, in id order');
select is((select phf ->> 'n' from public.hands_needing_stats('stats/9001') limit 1), '2',
  '... with the document to derive from');
select is((select array_agg(id::text) from public.hands_needing_stats('stats/9001', '00000000-0000-0000-0000-00000000f002')),
  array['00000000-0000-0000-0000-00000000f003'], 'the keyset cursor continues after the given id');
select is((select count(*)::int from public.hands_needing_stats('stats/9001', null, 0)), 1,
  'the page size is clamped to at least one');
select is((select count(*)::int from public.hands_needing_stats('stats/9001', null, 100000)), 2,
  '... and a huge one is harmless');
select ok(not exists (select 1 from public.hands_needing_stats('stats/9001') where id = '00000000-0000-0000-0000-00000000f004'),
  'a hand without a hero is never offered: it cannot have hero statistics');
select ok(not exists (select 1 from public.hands_needing_stats('stats/9001') where id = '00000000-0000-0000-0000-00000000f0b1'),
  'another user''s hand is never offered');

select throws_ok($$ select public.stats_coverage(null) $$, '22023', null, 'coverage needs a version');
select throws_ok($$ select * from public.hands_needing_stats(' ') $$, '22023', null, 'so does the rebuild read');

-- ------------------------------------------------------------- isolation --

select pg_temp.act_as('00000000-0000-0000-0000-0000000006b1');
select is(public.stats_coverage('stats/9001') - 'stakes',
  '{"statsVersion":"stats/9001","hands":1,"atVersion":0,"stale":0,"missing":1,"withoutHero":0,"obsoleteRows":0}'::jsonb,
  'B sees only B''s library');
select is((select array_agg(id::text) from public.hands_needing_stats('stats/9001')),
  array['00000000-0000-0000-0000-00000000f0b1'], 'B is offered only B''s hand');
select is((public.prune_hand_stats('stats/9001') ->> 'deleted')::int, 0,
  'B''s prune cannot reach A''s obsolete rows');

select pg_temp.act_as_anon();
select throws_ok($$ select public.stats_coverage('stats/9001') $$, '42501', null, 'anon cannot read coverage');
select throws_ok($$ select * from public.hands_needing_stats('stats/9001') $$, '42501', null,
  'anon cannot read documents through the rebuild path');

-- ------------------------------------------------- prune closes the loop --

select pg_temp.act_as('00000000-0000-0000-0000-0000000006a1');

-- The reports run as the caller. Every one of their helpers must be callable
-- by `authenticated`, or the screen fails for everyone but a superuser.
select lives_ok($$ select public.stats_summary('{"statsVersion":"stats/9001"}') $$,
  'stats_summary runs as a signed-in user');
select is((public.stats_summary('{"statsVersion":"stats/9001"}') ->> 'hands')::int, 1,
  '... and counts the caller''s hero rows at that version');
select lives_ok($$ select public.stats_graph('{"statsVersion":"stats/9001"}', 10) $$,
  'stats_graph runs as a signed-in user');
select pg_temp.act_as_anon();
select throws_ok($$ select public.stats_summary('{}') $$, '42501', null, 'anon still cannot');
select pg_temp.act_as('00000000-0000-0000-0000-0000000006a1');
select is((public.prune_hand_stats('stats/9001') ->> 'deleted')::int, 2, 'A prunes the obsolete rows');
select is(public.stats_coverage('stats/9001') ->> 'obsoleteRows', '0', 'nothing obsolete is left');
select is((public.stats_coverage('stats/9001') ->> 'missing')::int, 2,
  'a hand whose only rows were obsolete is now plainly missing');
select is((public.stats_coverage('stats/9001') ->> 'atVersion')::int, 1, 'the current row survived');

select * from finish();
rollback;
