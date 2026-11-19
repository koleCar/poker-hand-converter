-- pgTAP: deleting hands (`20271119200000_hand_deletion.sql`).
--
-- What has to hold:
--
--   * the RPCs are signed-in only, the internals and the tables sealed;
--   * `delete_hands` / `delete_hands_by_key` delete the caller's hands only
--     (another account's ids and keys are ignored), at most 200 a call, and
--     leave every summary exactly what its rebuild counts from the rows left
--     (library counts, report rollups and rows, opponents, every analysis
--     summary, the preflop rows and totals) without marking the account
--     stale; the per-hand rows go, a tombstone per hand is written;
--   * a published copy of a deleted hand stays (its source link is cleared);
--     a share link of it goes;
--   * `hand_tombstones_since`: rows older than a minute, keyset paged, the
--     caller's only;
--   * `delete_all_hands`: needs DELETE; deletes every hand stored before the
--     wipe began and empties every summary; one tombstone for the wipe; the
--     other account untouched; hands stored during a wipe stay and the cron
--     step rebuilds the summaries from them.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(44);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000de1a1', 'delete.a@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000de1b1', 'delete.b@example.com', now(), now());

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

create function pg_temp.r(p_i integer, p_salt text) returns integer language sql immutable as $$
  select abs(hashtext(p_i::text || ':' || p_salt));
$$;

-- ------------------------------------------------------------- the data --
--
-- Per account: hands over a year, hero and villain statistics rows at two
-- versions, EV rows, and an analysis (preflop chart decisions, postflop
-- solver ones) for most hands at two versions.

create function pg_temp.add_hands(p_owner uuid, p_n integer, p_tag text) returns void language sql as $$
  insert into public.hands (owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                            currency, currency_minor_units, currency_symbol, small_blind, big_blind,
                            max_seats, player_count, played_at, hero_name, hero_seat, hero_position, hero_cards,
                            hero_hand_class, board_cards, player_names, went_to_showdown, total_pot, hero_profit)
  select p_owner, p_tag || ':' || i, '{"schema":"phf/1"}', 'std',
         (array['pokerstars', 'ggpoker', 'winamax'])[1 + pg_temp.r(i, p_tag || 's') % 3],
         case when pg_temp.r(i, p_tag || 'f') % 5 = 0 then 'tournament' else 'cash' end::public.game_format,
         'holdem', 'nl', 'USD', 100, '$',
         (array[1, 5, 10])[1 + pg_temp.r(i, p_tag || 'b') % 3],
         (array[2, 10, 20])[1 + pg_temp.r(i, p_tag || 'b') % 3],
         (array[2, 6, 9])[1 + pg_temp.r(i, p_tag || 'm') % 3],
         2 + pg_temp.r(i, p_tag || 'pc') % 5,
         timestamptz '2026-01-01 00:00:00+00' + make_interval(mins => pg_temp.r(i, p_tag || 'ts') % (60 * 24 * 300)),
         'Hero', 0,
         (array['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'])[1 + pg_temp.r(i, p_tag || 'p') % 6],
         array['Ah', 'Kd'], 'AKo', array['2c', '7d', 'Ks'],
         array['Hero', 'v' || (pg_temp.r(i, p_tag || 'o') % 5)],
         pg_temp.r(i, p_tag || 'w') % 3 = 0,
         100 + pg_temp.r(i, p_tag || 'q') % 900,
         (pg_temp.r(i, p_tag || 'q') % 400) - 200
  from generate_series(1, p_n) i;
$$;

create function pg_temp.add_stats(p_owner uuid, p_version text) returns void language sql as $$
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, position,
                                 hands, game_format, site_anonymization, currency, currency_minor_units,
                                 big_blind, played_at, won, contributed, net, net_bb_milli, pot_type,
                                 starting_stack_bb_tenths, vpip_opp, vpip, pfr_opp, pfr)
  select h.id, h.owner_id, p_version, s.seat, h.hand_key, h.site, s.seat = 0,
         case when s.seat = 0 then 'Hero' else h.player_names[2] end,
         case when s.seat = 0 then h.hero_position else 'BB' end,
         1, h.game_format, h.site_anonymization, h.currency, 100, h.big_blind, h.played_at,
         greatest(h.hero_profit, 0), greatest(-h.hero_profit, 0), h.hero_profit, h.hero_profit * 10,
         (array['limped', 'single-raised', '3bet'])[1 + pg_temp.r(1, h.hand_key || p_version) % 3],
         (array[150, 500, 1000, 2000])[1 + pg_temp.r(2, h.hand_key || p_version) % 4],
         1, pg_temp.r(3, h.hand_key || s.seat) % 2, 1,
         (pg_temp.r(3, h.hand_key || s.seat) % 2) * (pg_temp.r(4, h.hand_key || s.seat) % 2)
  from public.hands h
  cross join (values (0), (1)) s(seat)
  where h.owner_id = p_owner;
$$;

create function pg_temp.add_ev(p_owner uuid, p_version text) returns void language sql as $$
  insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
  select h.id, h.owner_id, 0, p_version, h.hand_key, pg_temp.r(5, h.hand_key || p_version) % 3 <> 0, 5, 50
  from public.hands h
  where h.owner_id = p_owner and pg_temp.r(6, h.hand_key || p_version) % 2 = 0;
$$;

create function pg_temp.add_analysis(p_owner uuid, p_version text) returns void language plpgsql as $$
begin
  insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, hero_seat, grade, score,
                                    decisions, analysed, pot_type)
  select h.id, h.owner_id, p_version, 'full', 0,
         (array['perfect', 'good', 'mistake', 'blunder'])[1 + pg_temp.r(7, h.hand_key || p_version) % 4],
         50, 2, 2, (array['single-raised', '3bet'])[1 + pg_temp.r(8, h.hand_key) % 2]
  from public.hands h
  where h.owner_id = p_owner and pg_temp.r(9, h.hand_key || p_version) % 5 <> 0;

  insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action,
                                        status, node, scenario, source, grade, score, ev_loss_bb, ev_loss_pot,
                                        options, facts)
  select a.hand_id, a.owner_id, a.analysis_version, d.ord, d.ai, d.street, d.act, 'analysed', 'n', d.scenario, d.source,
         (array['perfect', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(10 + d.ord, h.hand_key || p_version) % 4],
         40, (pg_temp.r(12 + d.ord, h.hand_key) % 30) / 10.0, 0.1,
         jsonb_build_array(jsonb_build_object('action', d.act, 'ev', 0), jsonb_build_object('action', 'call', 'ev', 1)),
         case when d.street = 'preflop'
              then jsonb_build_object('handClass', 'AKo', 'position', h.hero_position,
                                      'chart', jsonb_build_object('set', 'nlhe-cash-6max-100bb', 'line', 'fffrf'))
              else jsonb_build_object('position', h.hero_position) end
  from public.hand_analysis a
  join public.hands h on h.id = a.hand_id
  cross join (values (0, 5, 'preflop', 'fold', 'vs-open', 'chart'),
                     (1, 11, 'river', 'check', 'pfr-ip-vs-bet', 'solver')) d(ord, ai, street, act, scenario, source)
  where a.owner_id = p_owner and a.analysis_version = p_version;
end;
$$;

select pg_temp.add_hands('00000000-0000-0000-0000-0000000de1a1', 120, 'a');
select pg_temp.add_hands('00000000-0000-0000-0000-0000000de1b1', 40, 'b');
select pg_temp.add_ev('00000000-0000-0000-0000-0000000de1a1', 'ev/1');
select pg_temp.add_stats('00000000-0000-0000-0000-0000000de1a1', 'stats/1');
select pg_temp.add_stats('00000000-0000-0000-0000-0000000de1a1', 'stats/2');
select pg_temp.add_stats('00000000-0000-0000-0000-0000000de1b1', 'stats/1');
select pg_temp.add_ev('00000000-0000-0000-0000-0000000de1a1', 'ev/2');
select pg_temp.add_ev('00000000-0000-0000-0000-0000000de1b1', 'ev/1');
select pg_temp.add_analysis('00000000-0000-0000-0000-0000000de1a1', 'analysis/2');
select pg_temp.add_analysis('00000000-0000-0000-0000-0000000de1a1', 'analysis/3');
select pg_temp.add_analysis('00000000-0000-0000-0000-0000000de1b1', 'analysis/3');

-- Every summary of an account, as comparable rows (the opponents' first and
-- last time are recomputed by their reader when no longer exact).
create temporary table snap (tag text, tbl text, r jsonb);
create function pg_temp.snapshot(p_owner uuid, p_tag text) returns void language plpgsql as $$
declare t text;
begin
  foreach t in array array['library_hand_counts', 'library_hero_counts', 'hero_rollups', 'hero_report_rows',
    'player_stats', 'analysis_hand_rows', 'analysis_month_hands', 'analysis_leak_rows', 'analysis_leak_totals',
    'analysis_leak_stake_totals', 'analysis_trend_days', 'analysis_overview_hands', 'analysis_overview_decisions',
    'analysis_overview_flags', 'analysis_overview_keys', 'analysis_node_totals', 'analysis_graded_sites',
    'preflop_decision_rows', 'preflop_decision_totals'] loop
    execute format('insert into snap select %L, %L, to_jsonb(x) - ''first_played_at'' - ''last_played_at'' - ''seen_exact''
                    from public.%I x where owner_id = $1', p_tag, t, t) using p_owner;
  end loop;
end;
$$;
-- The tables whose rows differ from what the rebuilds count.
create function pg_temp.drift(p_owner uuid) returns text[] language plpgsql as $$
declare v text[];
begin
  delete from snap;
  perform pg_temp.snapshot(p_owner, 'kept');
  perform public.library_counts_rebuild(p_owner);
  perform public.report_summaries_rebuild(p_owner);
  perform public.analysis_leak_summaries_rebuild(p_owner);
  perform public.preflop_decision_rows_rebuild(p_owner);
  perform pg_temp.snapshot(p_owner, 'rebuilt');
  select array_agg(distinct x.tbl order by x.tbl) into v from (
    (select tbl, r from snap where tag = 'kept' except all select tbl, r from snap where tag = 'rebuilt')
    union all
    (select tbl, r from snap where tag = 'rebuilt' except all select tbl, r from snap where tag = 'kept')) x;
  return v;
end;
$$;

select is(pg_temp.drift('00000000-0000-0000-0000-0000000de1a1'), null,
  'the data: A''s summaries are what the rebuilds count');
select ok((select count(*) from public.analysis_leak_rows where owner_id = '00000000-0000-0000-0000-0000000de1a1') > 100
          and (select count(*) from public.preflop_decision_rows where owner_id = '00000000-0000-0000-0000-0000000de1a1') > 50
          and (select count(*) from public.player_stats where owner_id = '00000000-0000-0000-0000-0000000de1a1') > 4
          and (select count(*) from public.library_hero_counts where owner_id = '00000000-0000-0000-0000-0000000de1a1' and ev_version <> '') > 0,
  '... and every family of them has rows');

-- A published copy and a share link of a hand A deletes.
insert into public.published_hands (id, public_id, author_id, mode, phf, site)
values ('00000000-0000-0000-0000-0000000de1f1', 'abcdefghjk', '00000000-0000-0000-0000-0000000de1a1', 'pseudonyms', '{}', 'pokerstars');
insert into public.published_hand_sources (published_id, author_id, hand_id)
select '00000000-0000-0000-0000-0000000de1f1', owner_id, id from public.hands where hand_key = 'a:1';
insert into public.shares (slug, hand_id, owner_id)
select 'deshare22', id, owner_id from public.hands where hand_key = 'a:1';

-- --------------------------------------------------------------- security --

select ok(
  has_function_privilege('authenticated', 'public.delete_hands(uuid[])', 'execute')
  and has_function_privilege('authenticated', 'public.delete_hands_by_key(text[])', 'execute')
  and has_function_privilege('authenticated', 'public.delete_all_hands(text)', 'execute')
  and has_function_privilege('authenticated', 'public.hand_tombstones_since(timestamptz, bigint, integer)', 'execute'),
  'the four RPCs are executable by authenticated');
select ok(
  not has_function_privilege('anon', 'public.delete_hands(uuid[])', 'execute')
  and not has_function_privilege('anon', 'public.delete_hands_by_key(text[])', 'execute')
  and not has_function_privilege('anon', 'public.delete_all_hands(text)', 'execute')
  and not has_function_privilege('anon', 'public.hand_tombstones_since(timestamptz, bigint, integer)', 'execute'),
  '... not by anon');
select ok(
  not has_function_privilege('authenticated', 'public.hand_delete_owned(uuid, uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'public.hand_wipe_continue(uuid, timestamptz, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.hand_wipe_finish(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.finish_hand_wipes(integer)', 'execute')
  and not has_function_privilege('anon', 'public.finish_hand_wipes(integer)', 'execute'),
  'the internals are executable by no client role');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.hand_tombstones'::regclass, 'public.hand_wipes'::regclass))
  and not has_table_privilege('authenticated', 'public.hand_tombstones', 'select')
  and not has_table_privilege('authenticated', 'public.hand_wipes', 'select'),
  'the tombstones and wipes are sealed');
select is((select count(*)::int from cron.job where jobname = 'hand-wipes-finish'), 1,
  'pg_cron finishes the wipes a client left');

select pg_temp.act_as_anon();
select throws_ok($$ select public.delete_hands('{}') $$, '42501', null, 'anon cannot delete');
select pg_temp.act_as('00000000-0000-0000-0000-0000000de1a1');
select throws_ok($$ select public.delete_hands((select array_agg(extensions.gen_random_uuid()) from generate_series(1, 201))) $$,
  '22023', 'At most 200 hands at a time.', 'at most 200 ids a call');
select throws_ok($$ select public.delete_hands_by_key((select array_agg(i::text) from generate_series(1, 201) i)) $$,
  '22023', 'At most 200 hands at a time.', '... and 200 keys');
select throws_ok($$ delete from public.hands $$, '42501', null, 'hands still cannot be deleted directly');

-- ------------------------------------------------------ chosen hands --

reset role;
create temporary table chosen as
select id from public.hands
 where (owner_id = '00000000-0000-0000-0000-0000000de1a1' and hand_key in ('a:1', 'a:2', 'a:3', 'a:5', 'a:8', 'a:13', 'a:21', 'a:34', 'a:55', 'a:89'))
    or (owner_id = '00000000-0000-0000-0000-0000000de1b1' and hand_key in ('b:1', 'b:2'));
grant select on chosen to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000de1a1');
select is(public.delete_hands((select array_agg(id) from chosen)), '{"deleted": 10}'::jsonb,
  'A deletes ten of its hands; B''s two ids among them are ignored');
reset role;
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000de1a1'), 110, 'A has 110 hands left');
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000de1b1'), 40, 'B has its 40');
select is(
  (select count(*)::int from chosen c
    where exists (select 1 from public.hand_stats s where s.hand_id = c.id)
       or exists (select 1 from public.hand_stats_ev s where s.hand_id = c.id)
       or exists (select 1 from public.hand_analysis s where s.hand_id = c.id)
       or exists (select 1 from public.decision_analysis s where s.hand_id = c.id)
       or exists (select 1 from public.hero_report_rows s where s.hand_id = c.id)
       or exists (select 1 from public.analysis_hand_rows s where s.hand_id = c.id)
       or exists (select 1 from public.analysis_leak_rows s where s.hand_id = c.id)
       or exists (select 1 from public.preflop_decision_rows s where s.hand_id = c.id)),
  2, 'the deleted hands'' rows are gone everywhere (only B''s two hands keep theirs)');
select ok(not exists (select 1 from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000de1a1'),
  'the account is not marked stale: its counts were kept exactly');
select is(pg_temp.drift('00000000-0000-0000-0000-0000000de1a1'), null,
  'every summary of A is what the rebuilds count from the hands left');
select is((select array_agg(hand_key order by hand_key) from public.hand_tombstones where owner_id = '00000000-0000-0000-0000-0000000de1a1'),
  array['a:1', 'a:13', 'a:2', 'a:21', 'a:3', 'a:34', 'a:5', 'a:55', 'a:8', 'a:89'],
  'a tombstone per deleted hand, with its key');
select ok((select bool_and(hand_id is not null and all_before is null) from public.hand_tombstones), '... and its id');

select ok(exists (select 1 from public.published_hands where id = '00000000-0000-0000-0000-0000000de1f1'),
  'the published copy of a deleted hand stays');
select is((select hand_id from public.published_hand_sources where published_id = '00000000-0000-0000-0000-0000000de1f1'), null,
  '... its link to the stored hand is cleared');
select is((select count(*)::int from public.shares where slug = 'deshare22'), 0, 'a share link of the hand goes with it');

select pg_temp.act_as('00000000-0000-0000-0000-0000000de1a1');
select is(public.delete_hands_by_key(array['a:4', 'a:6', 'a:1', 'b:3', 'nope']),
  '{"deleted": 2, "keys": ["a:4", "a:6"]}'::jsonb, 'by key: the caller''s hands that are there');
reset role;
select is(pg_temp.drift('00000000-0000-0000-0000-0000000de1a1'), null, '... with the summaries exact again');
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000de1b1'), 40, '... and B''s hands untouched');

-- ----------------------------------------------------- the app's pull --

select pg_temp.act_as('00000000-0000-0000-0000-0000000de1a1');
select is((select count(*)::int from public.hand_tombstones_since()), 0, 'tombstones younger than a minute are not served yet');
reset role;
update public.hand_tombstones set deleted_at = deleted_at - interval '2 minutes';
select pg_temp.act_as('00000000-0000-0000-0000-0000000de1a1');
select is((select count(*)::int from public.hand_tombstones_since()), 12, 'then every one is');
select is(
  (select count(*)::int from public.hand_tombstones_since(
     (select deleted_at from public.hand_tombstones_since(null, null, 5) order by deleted_at desc, seq desc limit 1),
     (select seq from public.hand_tombstones_since(null, null, 5) order by deleted_at desc, seq desc limit 1))),
  7, 'keyset paging: after a page of five, seven');
select throws_ok($$ select * from public.hand_tombstones_since(now(), null) $$, '22023', null, 'both halves of the cursor or neither');
select pg_temp.act_as('00000000-0000-0000-0000-0000000de1b1');
select is((select count(*)::int from public.hand_tombstones_since()), 0, 'B reads none of A''s');

-- --------------------------------------------------------- delete all --

select pg_temp.act_as('00000000-0000-0000-0000-0000000de1a1');
select throws_ok($$ select public.delete_all_hands('yes') $$, '22023', null, 'deleting every hand needs DELETE');
select is(public.delete_all_hands('DELETE') - 'before',
  '{"deleted": 108, "remaining": 0, "done": true}'::jsonb, 'every hand of A goes');
reset role;
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000de1a1'), 0, 'A has no hand');
select is(
  (select count(*)::int from public.hand_stats where owner_id = '00000000-0000-0000-0000-0000000de1a1')
  + (select count(*)::int from public.hand_analysis where owner_id = '00000000-0000-0000-0000-0000000de1a1')
  + (select count(*)::int from public.hand_facts where owner_id = '00000000-0000-0000-0000-0000000de1a1'),
  0, '... and no statistics, analysis or facts row');
delete from snap;
select pg_temp.snapshot('00000000-0000-0000-0000-0000000de1a1', 'kept');
select is((select count(*)::int from snap), 0, 'every summary of A is empty');
select ok(not exists (select 1 from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000de1a1')
          and not exists (select 1 from public.hand_wipes),
  'the wipe is over: no stale mark, no wipe left');
select is((select count(*)::int from public.hand_tombstones where owner_id = '00000000-0000-0000-0000-0000000de1a1' and all_before is not null),
  1, 'one tombstone stands for the whole wipe');
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000de1b1'), 40, 'B''s hands are untouched');
select is(pg_temp.drift('00000000-0000-0000-0000-0000000de1b1'), null, '... and so are its summaries');

-- B's wipe began an hour ago; half of B's hands were stored before it, the
-- other half arrived during it.
update public.hands set created_at = now() - interval '2 hours'
 where owner_id = '00000000-0000-0000-0000-0000000de1b1' and (substr(hand_key, 3))::int <= 20;
insert into public.hand_wipes (owner_id, before, started_at)
values ('00000000-0000-0000-0000-0000000de1b1', now() - interval '1 hour', now() - interval '1 hour');
insert into public.library_counts_stale (owner_id) values ('00000000-0000-0000-0000-0000000de1b1');
select pg_temp.act_as('00000000-0000-0000-0000-0000000de1b1');
select is(public.delete_all_hands('DELETE') - 'before', '{"deleted": 20, "remaining": 0, "done": true}'::jsonb,
  'a wipe deletes the hands stored before it began');
reset role;
select is((select count(*)::int from public.hands where owner_id = '00000000-0000-0000-0000-0000000de1b1'), 20,
  '... and keeps those stored during it');
select ok((select rebuild from public.hand_wipes where owner_id = '00000000-0000-0000-0000-0000000de1b1')
          and exists (select 1 from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000de1b1'),
  'their summaries wait for the cron job, the library counts read from the hands meanwhile');
select is(public.hand_wipe_continue('00000000-0000-0000-0000-0000000de1b1', clock_timestamp() + interval '5 seconds', true) ->> 'done',
  'true', 'the cron step rebuilds them');
select ok(not exists (select 1 from public.hand_wipes) and not exists (select 1 from public.library_counts_stale
          where owner_id = '00000000-0000-0000-0000-0000000de1b1')
          and (select sum(hands)::int from public.library_hand_counts where owner_id = '00000000-0000-0000-0000-0000000de1b1') = 20
          and (select count(*)::int from public.hero_report_rows where owner_id = '00000000-0000-0000-0000-0000000de1b1') = 20,
  '... counting the 20 hands left');

select * from finish();
rollback;
