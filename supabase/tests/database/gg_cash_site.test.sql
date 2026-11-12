-- pgTAP: plain GG cash hands move from `standard` to `ggpoker`
-- (`20271112090000_gg_cash_site.sql`, `move_gg_cash_hands`).
--
-- What has to hold:
--
--   * only `standard` hands whose id is GG's cash id (`HD` + digits) move;
--     another `standard` hand, another room's hand and a hand the account
--     already has under the new key stay as they are;
--   * a moved hand has the GGPoker site, the `ggpoker:` key and the PHF's
--     meta; its statistics and EV rows follow, and the summaries and library
--     counts rebuilt by their triggers name the new site and key;
--   * notes on players seen in the moved hands move, unless that player has
--     a GGPoker note already; other notes stay;
--   * one owner at a time, or all; a second run moves nothing;
--   * granted to nobody.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(24);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000a6a1', 'gg.site.one@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000a6b1', 'gg.site.two@example.com', now(), now());

create function pg_temp.hand(p_owner uuid, p_site text, p_id text, p_players text[]) returns uuid language sql as $$
  insert into public.hands (owner_id, hand_key, site_hand_id, phf, standard_text, site, game_format, variant, limit_type,
                            currency, currency_minor_units, currency_symbol, small_blind, big_blind, max_seats,
                            played_at, hero_name, hero_seat, hero_position, player_names, hero_profit, site_anonymization)
  values (p_owner, p_site || ':' || p_id, p_id,
          jsonb_build_object('schema', 'phf/1',
                             'meta', jsonb_build_object('siteId', p_site, 'siteName', 'Rail standard', 'handId', p_id, 'handKey', p_id)),
          'std', p_site, 'cash', 'holdem', 'nl', 'USD', 100, '$', 50, 100, 6,
          timestamptz '2026-11-10 12:00:00+00', 'Hero', 1, 'BTN', p_players, 150, 'none')
  returning id;
$$;

create function pg_temp.stats(p_hand uuid) returns void language sql as $$
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, site_hand_id, played_at,
                                 game_format, currency, currency_minor_units, small_blind, big_blind, player, is_hero, position, hands, net)
  select h.id, h.owner_id, 'stats/2', s.seat, h.hand_key, h.site, h.site_hand_id, h.played_at,
         h.game_format, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, s.player, s.seat = 1, s.pos, 1, s.net
  from public.hands h
  cross join (values (1, 'Hero', 'BTN', 150), (2, 'v1', 'BB', -150)) as s(seat, player, pos, net)
  where h.id = p_hand;
$$;

-- Owner A
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'standard', 'HD100', array['Hero', 'v1']);
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'standard', 'HD101', array['Hero', 'v3']);
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'standard', 'RAIL5', array['Hero', 'zz']);
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'ggpoker', 'HD102', array['Hero', 'v2']);
-- the same hand twice: under the new key already, and under the old one
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'ggpoker', 'HD103', array['Hero', 'v4']);
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'standard', 'HD103', array['Hero', 'v4']);
select pg_temp.hand('00000000-0000-0000-0000-00000000a6a1', 'pokerstars', 'HD104', array['Hero', 'v5']);
-- Owner B
select pg_temp.hand('00000000-0000-0000-0000-00000000a6b1', 'standard', 'HD200', array['Hero', 'w1']);

select pg_temp.stats(id) from public.hands
 where owner_id = '00000000-0000-0000-0000-00000000a6a1' and hand_key in ('standard:HD100', 'standard:RAIL5');
insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
select hand_id, owner_id, seat, 'ev/1', hand_key, true, 99, 990 from public.hand_stats
 where owner_id = '00000000-0000-0000-0000-00000000a6a1' and hand_key = 'standard:HD100' and is_hero;

insert into public.player_notes (owner_id, site, player, note) values
  ('00000000-0000-0000-0000-00000000a6a1', 'standard', 'v1', 'calls too much'),
  ('00000000-0000-0000-0000-00000000a6a1', 'standard', 'v4', 'old note'),
  ('00000000-0000-0000-0000-00000000a6a1', 'ggpoker',  'v4', 'new note'),
  ('00000000-0000-0000-0000-00000000a6a1', 'standard', 'zz', 'not a GG player');

-- 1. The function
select has_function('public', 'move_gg_cash_hands', array['uuid'], 'move_gg_cash_hands exists');
select is((select prosecdef from pg_proc where oid = 'public.move_gg_cash_hands(uuid)'::regprocedure), true, 'it is a definer');
select is(has_function_privilege('authenticated', 'public.move_gg_cash_hands(uuid)', 'execute'), false, 'authenticated cannot run it');
select is(has_function_privilege('anon', 'public.move_gg_cash_hands(uuid)', 'execute'), false, 'anon cannot run it');

-- 2. One owner
select is(public.move_gg_cash_hands('00000000-0000-0000-0000-00000000a6a1'), 2, 'A: two hands move (HD100, HD101)');

select is((select site || '|' || hand_key || '|' || (phf -> 'meta' ->> 'siteId') || '|' || (phf -> 'meta' ->> 'siteName')
             from public.hands where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'HD100'),
          'ggpoker|ggpoker:HD100|ggpoker|GGPoker', 'a moved hand: site, key and PHF meta');
select is((select phf -> 'meta' ->> 'handKey' from public.hands
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'HD100'),
          'HD100', '... the PHF''s own hand key is unchanged');
select is((select site from public.hands where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'RAIL5'),
          'standard', 'a standard hand without a GG cash id stays');
select is((select count(*)::int from public.hands
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'HD103' and site = 'standard'),
          1, 'a hand already stored under the new key: the old copy is left alone');
select is((select site from public.hands where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'HD104'),
          'pokerstars', 'another room''s hand stays');
select is((select site from public.hands where owner_id = '00000000-0000-0000-0000-00000000a6b1'),
          'standard', 'B is not touched by A''s run');

select is((select array_agg(site_id || '|' || hand_key order by seat) from public.hand_stats
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'HD100'),
          array['ggpoker|ggpoker:HD100', 'ggpoker|ggpoker:HD100'], 'its statistics rows follow');
select is((select hand_key from public.hand_stats_ev where owner_id = '00000000-0000-0000-0000-00000000a6a1'),
          'ggpoker:HD100', 'its EV row follows');
select is((select site_id from public.hand_stats where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site_hand_id = 'RAIL5' and is_hero),
          'standard', 'the standard hand''s statistics stay');
select is((select count(*)::int from public.hero_report_rows
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and hand_key = 'ggpoker:HD100' and site_id = 'ggpoker'),
          1, 'the report rows name the new site and key');
select is((select count(*)::int from public.hero_report_rows
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and hand_key = 'standard:HD100'),
          0, '... and none the old');
select is((select coalesce(sum(hands), 0)::int from public.library_hand_counts
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site = 'ggpoker'),
          (select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site = 'ggpoker'),
          'the library counts the GGPoker hands');
select is((select coalesce(sum(hands), 0)::int from public.library_hand_counts
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and site = 'standard'),
          2, '... and the two standard hands left');

select is((select site from public.player_notes where owner_id = '00000000-0000-0000-0000-00000000a6a1' and player = 'v1'),
          'ggpoker', 'a note on a player of a moved hand moves');
select is((select array_agg(site || ':' || note order by site) from public.player_notes
            where owner_id = '00000000-0000-0000-0000-00000000a6a1' and player = 'v4'),
          array['ggpoker:new note', 'standard:old note'], 'a player with a GGPoker note already keeps both');
select is((select site from public.player_notes where owner_id = '00000000-0000-0000-0000-00000000a6a1' and player = 'zz'),
          'standard', 'a note on a player of no moved hand stays');

-- 3. Every owner, then again
select is(public.move_gg_cash_hands(), 1, 'every owner: B''s hand moves');
select is((select hand_key from public.hands where owner_id = '00000000-0000-0000-0000-00000000a6b1'),
          'ggpoker:HD200', '... under its new key');
select is(public.move_gg_cash_hands(), 0, 'a second run moves nothing');

select * from finish();
rollback;
