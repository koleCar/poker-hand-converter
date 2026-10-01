-- pgTAP: opponent statistics (F13 / M4, #49) -- `20261123090000_villain_stats.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(17);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000008a1', 'vs.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000008b1', 'vs.b@example.com', now(), now());

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

-- A hand with a hero row and, optionally, villain rows (`p_villains`: name => net bb milli).
create function pg_temp.hand(p_owner uuid, p_id uuid, p_anon text, p_hero_net bigint, p_villains jsonb)
returns void language plpgsql as $$
declare v_seat int := 2; v record;
begin
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at, site_anonymization)
  values (p_id, p_owner, 'weplay:' || p_id, '{"schema":"phf/1"}', 'std', 'weplay', 1, now(),
          p_anon::public.site_anonymization);
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, hands,
                                 site_anonymization, won, contributed, net, net_bb_milli)
  values (p_id, p_owner, 'stats/1', 1, 'weplay:' || p_id, 'weplay', true, 'Me', 1, p_anon::public.site_anonymization,
          1000 + p_hero_net / 10, 1000, p_hero_net / 10, p_hero_net);
  for v in select key, value from jsonb_each_text(coalesce(p_villains, '{}')) loop
    insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, hands,
                                   site_anonymization, vpip_opp, vpip)
    values (p_id, p_owner, 'stats/1', v_seat, 'weplay:' || p_id, 'weplay', false, v.key, 1,
            p_anon::public.site_anonymization, 1, 1);
    v_seat := v_seat + 1;
  end loop;
end;
$$;

-- A: two hands with Fish_1 and Reg; one opaque-id hand with a hash; one hand
-- with hero rows only; one positional hand.
select pg_temp.hand('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-00000000e001', 'none',  5000, '{"Fish_1":0,"Reg":0}');
select pg_temp.hand('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-00000000e002', 'none', -2000, '{"Fish_1":0}');
select pg_temp.hand('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-00000000e003', 'opaque-id', 0, '{"a1b2c3d4":0}');
select pg_temp.hand('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-00000000e004', 'none', 0, null);
select pg_temp.hand('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-00000000e005', 'positional', 0, null);
-- B: one hand with a villain of the same name.
select pg_temp.hand('00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-00000000e0b1', 'none', 9000, '{"Fish_1":0}');

select pg_temp.act_as('00000000-0000-0000-0000-0000000008a1');

-- ---------------------------------------------------------------- report --

select is(jsonb_array_length(public.stats_opponents() -> 'rows'), 2, 'two opponents with persistent names');
select is(public.stats_opponents() -> 'rows' -> 0 ->> 'player', 'Fish_1', 'biggest sample first');
select is((public.stats_opponents() -> 'rows' -> 0 ->> 'hands')::int, 2, 'Fish_1: A''s two hands, not B''s');
select is((public.stats_opponents() -> 'rows' -> 0 ->> 'hero_net_bb_milli')::int, 3000,
  'the caller''s own result across the hands they shared');
select is((public.stats_opponents() ->> 'opaqueRows')::int, 1,
  'the opaque-id opponent is counted as left out, not listed');
select ok(not exists (select 1 from jsonb_array_elements(public.stats_opponents() -> 'rows') r
                      where r ->> 'player' = 'a1b2c3d4'), '... and is not in the list');
select is(jsonb_array_length(public.stats_opponents('{"minHands":2}') -> 'rows'), 1, 'minHands drops thin samples');
select is(public.stats_opponents('{}', 'fi') -> 'rows' -> 0 ->> 'player', 'Fish_1', 'prefix search, case-insensitive');
select is(jsonb_array_length(public.stats_opponents('{}', '%') -> 'rows'), 0, 'a % in the search is a literal, not a wildcard');

-- --------------------------------------------------------------- backfill --

select ok(not exists (select 1 from public.hands_needing_stats('stats/1') where id = '00000000-0000-0000-0000-00000000e004'),
  'a hand with a hero row needs nothing when villains are off');
select ok(exists (select 1 from public.hands_needing_stats('stats/1', null, 100, true) where id = '00000000-0000-0000-0000-00000000e004'),
  '... and needs villain rows when they are on');
select ok(not exists (select 1 from public.hands_needing_stats('stats/1', null, 100, true) where id = '00000000-0000-0000-0000-00000000e005'),
  'a positional hand never needs villain rows');
select is((select count(*)::int from public.hands_needing_stats('stats/1', null, 100)), 0,
  'the three-argument call still resolves, as the old one did');

-- ------------------------------------------------------------------ prune --

select is((public.prune_villain_stats() ->> 'deleted')::int, 4, 'turning it off removes A''s villain rows');
select is((select count(*)::int from public.hand_stats where is_hero), 5, '... and none of A''s hero rows');
select pg_temp.act_as('00000000-0000-0000-0000-0000000008b1');
select is((select count(*)::int from public.hand_stats where not is_hero), 1, 'B''s villain rows are untouched');

select pg_temp.act_as_anon();
select throws_ok($$ select public.stats_opponents() $$, '42501', null, 'anon cannot read opponents');

select * from finish();
rollback;
