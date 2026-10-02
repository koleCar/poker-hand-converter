-- pgTAP: stats/2 pot_type -- `20261221090000_stats_pot_type.sql`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(5);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000aa0a1', 'pt.a@example.com', now(), now());
insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, hero_seat, played_at) values
  ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-0000000aa0a1', 'pokerstars:pt1', '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now()),
  ('00000000-0000-0000-0000-0000000aa002', '00000000-0000-0000-0000-0000000aa0a1', 'pokerstars:pt2', '{"schema":"phf/1"}', 'std', 'pokerstars', 1, now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- One full row written directly, then a second sent through the writer as a
-- copy of it -- the writer takes whole rows, the way the rebuild sends them.
insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, pot_type)
values ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-0000000aa0a1', 'stats/2', 1, 'pokerstars:pt1', 'pokerstars', true, 1, '3bet');

select pg_temp.act_as('00000000-0000-0000-0000-0000000aa0a1');

select is((public.save_hand_stats(jsonb_build_array(
  (select to_jsonb(s) - 'hand_id' - 'owner_id' - 'created_at' from public.hand_stats s where s.hand_key = 'pokerstars:pt1')
    || '{"hand_key":"pokerstars:pt2","pot_type":"limped"}'::jsonb
)) ->> 'inserted')::int, 1, 'save_hand_stats carries pot_type');

select is((select pot_type from public.hand_stats where hand_key = 'pokerstars:pt2'), 'limped', '... and stores it');

select is((select string_agg(r ->> 'key', ',' order by r ->> 'key')
           from jsonb_array_elements(public.stats_breakdown('{"statsVersion":"stats/2"}', 'pot_type') -> 'rows') r),
  '3bet,limped', 'the breakdown splits by pot type');

select is(jsonb_array_length(public.stats_breakdown('{}', 'pot_type') -> 'rows'), 0,
  'a caller that does not name a version reads stats/1, which is why the client always names one');

select throws_ok($$ insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, hands, pot_type)
                   values ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-0000000aa0a1', 'stats/3', 1, 'pokerstars:pt1', 'pokerstars', true, 1, 'huge') $$,
  '23514', null, 'an unknown pot type is refused');

select * from finish();
rollback;
