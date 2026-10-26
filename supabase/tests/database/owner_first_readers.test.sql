-- pgTAP: owner first - a reader's work depends only on the caller's own rows
-- (`20270804090000_owner_first_readers.sql`; the readers it did not list -
-- analysis, drill, trainer, study, `get_hand`, the forum's own-state ones -
-- and the library's counts, `20270818090000_big_account_readers.sql`).
--
-- What has to hold:
--
--   * a small account's readers read (about) its own rows only, however many
--     another account holds: here a big account of 6 000 hands (12 000
--     `hand_stats` rows, 6 000 EV rows, 2 000 unparsed samples) beside a
--     small one of 30, the statistics analysed. Measured, not planned: the
--     tuples each call returns from the tables' heaps and indexes, read from
--     this transaction's own statistics counters (`pg_stat_get_xact_
--     tuples_returned`), must stay far under the big account's rows. With the
--     fix the most any reader returns is ~200; the previous definitions of
--     `hands_facets`, `library_facets`, `library_page`, `search_hands`,
--     `hands_needing_stats` and `stats_ev_missing` returned 4 929-84 140 here
--     (plans from "rows / owners", see the migration). The analysis readers
--     read beside a big account's 9 000 graded decisions and their leak
--     summaries;
--   * every owner-scoped reader plans each call (`force_custom_plan`) and
--     none is a SQL function (whose owner would be an InitPlan again);
--   * the rewritten readers answer as their previous bodies did (kept here
--     as pg_temp copies), for both accounts (the analysis readers: in
--     `owner_first_analysis`; `library_facets` since its counts: in
--     `library_counts`);
--   * owner only, and anon refused (or, for `unparsed_summary`, shown
--     nothing).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(49);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000061a1', 'ownerfirst.small@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000061b1', 'ownerfirst.big@example.com', now(), now());

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

-- A stable "random" number for (i, salt).
create function pg_temp.r(p_i integer, p_salt text) returns integer language sql immutable as $$
  select abs(hashtext(p_i::text || ':' || p_salt));
$$;

-- ---------------------------------------------------------------------------
-- 1. The data: a big account and a small one
-- ---------------------------------------------------------------------------
--
-- Written as postgres with triggers off (the per-statement batch limits and
-- budgets are not what this file is about); the summaries rebuilt after.

set local session_replication_role = replica;

create function pg_temp.make_hands(p_owner uuid, p_n integer, p_tag text) returns void language sql as $$
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                            currency, currency_minor_units, currency_symbol, small_blind, big_blind, stakes_label,
                            max_seats, player_count, played_at, hero_name, hero_seat, hero_position, hero_cards,
                            hero_hand_class, board_cards, player_names, player_positions, showdown_positions,
                            winner_positions, went_to_showdown, street_reached, total_pot, hero_profit, table_name,
                            site_anonymization, site_hand_id)
  select extensions.gen_random_uuid(), p_owner, p_tag || ':' || i, '{"schema":"phf/1"}', 'std',
         (array['pokerstars','ggpoker','winamax'])[1 + pg_temp.r(i, p_tag || 's') % 3],
         case when pg_temp.r(i, p_tag || 'f') % 10 < 8 then 'cash' else 'tournament' end::public.game_format,
         case when pg_temp.r(i, p_tag || 'v') % 9 = 0 then 'omaha' else 'holdem' end,
         case when pg_temp.r(i, p_tag || 'v') % 9 = 0 then 'pl' else 'nl' end,
         'USD', 100, '$',
         case when pg_temp.r(i, p_tag || 'b') % 17 = 0 then null else (array[1, 5, 10, 25])[1 + pg_temp.r(i, p_tag || 'b') % 4] end,
         case when pg_temp.r(i, p_tag || 'b') % 17 = 0 then null else (array[2, 10, 20, 50])[1 + pg_temp.r(i, p_tag || 'b') % 4] end,
         '$' || (pg_temp.r(i, p_tag || 'b') % 4),
         6, 2,
         case when pg_temp.r(i, p_tag || 't') % 23 = 0 then null
              else timestamptz '2026-01-01' + make_interval(mins => i * 7) end,
         case when pg_temp.r(i, p_tag || 'n') % 13 = 0 then null else 'Hero' || (pg_temp.r(i, p_tag || 'n') % 2) end,
         0,
         (array['BTN','SB','BB','UTG','HJ','CO'])[1 + pg_temp.r(i, p_tag || 'p') % 6],
         array['Ah', 'Kd'], 'AKo',
         case when pg_temp.r(i, p_tag || 'd') % 3 = 0 then '{}'::text[] else array['2c', '7d', 'Ks'] end,
         case when pg_temp.r(i, p_tag || 'a') % 7 = 0 then '{}'::text[] else array['Hero', 'v' || (pg_temp.r(i, p_tag || 'o') % 40)] end,
         array['BTN', 'BB'],
         case when pg_temp.r(i, p_tag || 'w') % 4 = 0 then array['BTN', 'BB'] when pg_temp.r(i, p_tag || 'w') % 4 = 1 then array['CO'] else '{}' end,
         array['BTN'],
         pg_temp.r(i, p_tag || 'w') % 4 = 0,
         case when pg_temp.r(i, p_tag || 'd') % 3 = 0 then 'preflop' when pg_temp.r(i, p_tag || 'd') % 5 = 0 then null else 'river' end,
         100 + pg_temp.r(i, p_tag || 'q') % 900,
         (pg_temp.r(i, p_tag || 'q') % 400) - 200,
         case when pg_temp.r(i, p_tag || 'm') % 11 = 0 then null else 'Table ' || (pg_temp.r(i, p_tag || 'm') % 60) end,
         case when pg_temp.r(i, p_tag || 'a') % 7 = 0 then 'positional' else 'none' end::public.site_anonymization,
         i::text
  from generate_series(1, p_n) i;

  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, position,
                                 hands, vpip_opp, vpip, game_format, site_anonymization, currency, currency_minor_units,
                                 big_blind, played_at, won, contributed, net, net_bb_milli, pot_type,
                                 starting_stack_bb_tenths, player_count, max_seats)
  select h.id, h.owner_id, 'stats/1', s.seat, h.hand_key, h.site, s.seat = 0,
         case when s.seat = 0 then coalesce(h.hero_name, '') else h.player_names[2] end,
         case when s.seat = 0 then h.hero_position else 'BB' end,
         1, 1, (pg_temp.r(s.seat, h.hand_key) % 2), h.game_format, h.site_anonymization, h.currency, 100,
         h.big_blind, h.played_at, greatest(h.hero_profit, 0), greatest(-h.hero_profit, 0), h.hero_profit,
         h.hero_profit * 10, (array['limped','single-raised','3bet'])[1 + pg_temp.r(1, h.hand_key) % 3],
         200 + pg_temp.r(2, h.hand_key) % 1500, 2, 6
  from public.hands h
  cross join (values (0), (1)) s(seat)
  where h.owner_id = p_owner
    and (s.seat = 0 or (h.site_anonymization = 'none' and cardinality(h.player_names) = 2));

  insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
  select h.id, h.owner_id, 0, 'ev/1', h.hand_key, pg_temp.r(3, h.hand_key) % 10 = 0, 5, 50
  from public.hands h
  where h.owner_id = p_owner and pg_temp.r(4, h.hand_key) % 5 <> 0;

  insert into public.unparsed_hands (fingerprint, raw_text, detected_site, stage, reason, message, parser_version,
                                     status, occurrences, submitted_by, origin, guessed_site,
                                     consented_at, anonymiser_version, os, client_version)
  select encode(extensions.digest(p_tag || ':u' || i, 'sha256'), 'hex'), 'raw',
         case when i % 3 = 0 then null else 'pokerstars' end,
         (array['detect','parse'])[1 + i % 2]::public.conversion_stage, 'reason ' || (i % 4), 'm', 'p/1',
         (array['new','triaged'])[1 + i % 2]::public.unparsed_status, 1 + i % 5, p_owner,
         case when i % 5 = 0 then 'desktop' else 'web' end::public.unparsed_origin,
         case when i % 2 = 0 then 'ggpoker' end,
         case when i % 5 = 0 then now() end, case when i % 5 = 0 then 'a1' end,
         case when i % 5 = 0 then 'macos' end, case when i % 5 = 0 then '1.0' end
  from generate_series(1, greatest(p_n / 3, 10)) i;

  insert into public.player_notes (owner_id, site, player, note, updated_at)
  select p_owner, 'pokerstars', 'v' || i, 'note ' || i, timestamptz '2026-02-01' + make_interval(mins => i)
  from generate_series(1, least(p_n / 10, 40)) i;
$$;

select pg_temp.make_hands('00000000-0000-0000-0000-0000000061b1', 6000, 'big');
select pg_temp.make_hands('00000000-0000-0000-0000-0000000061a1', 30, 'small');

-- Graded hands: half the big account's, all the small one's; three
-- decisions each, drill items, trainer results.
create function pg_temp.make_analysis(p_owner uuid, p_every integer) returns void language sql as $$
  insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, hero_seat, grade, score, ev_loss_bb,
                                    ev_loss_pot, decisions, analysed, flag_count, pot_type)
  select h.id, h.owner_id, 'analysis/7', 'full', 0,
         (array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(5, h.hand_key) % 5],
         pg_temp.r(6, h.hand_key) % 100, (pg_temp.r(7, h.hand_key) % 300) / 100.0, 0.01, 3, 3,
         pg_temp.r(9, h.hand_key) % 2, (array['limped', 'single-raised', '3bet'])[1 + pg_temp.r(1, h.hand_key) % 3]
  from public.hands h
  where h.owner_id = p_owner and pg_temp.r(10, h.hand_key) % p_every = 0;

  insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status,
                                        node, scenario, source, grade, score, ev_loss_bb, ev_loss_pot, options, chosen,
                                        flags, facts)
  select a.hand_id, a.owner_id, a.analysis_version, d.ord, d.ord * 2, (array['preflop', 'flop', 'turn'])[1 + d.ord],
         (array['fold', 'call', 'raise'])[1 + pg_temp.r(d.ord, a.hand_id::text) % 3], 'analysed', 'node', 'srp',
         case when d.ord = 0 then 'chart' else 'heuristic' end,
         (array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(d.ord, a.hand_id::text || 'g') % 5],
         50, (pg_temp.r(d.ord, a.hand_id::text || 'e') % 200) / 100.0, 0.01,
         '[{"action":"fold","ev":0},{"action":"call","ev":0.1},{"action":"raise","ev":0.2}]'::jsonb, 1,
         case when d.ord = 1 then '[{"code":"overbet","severity":"note"}]'::jsonb else '[]'::jsonb end,
         case when d.ord = 0 then '{"chart":{"set":"cash-6max","line":"r"},"handClass":"AKo"}'::jsonb else '{}'::jsonb end
  from public.hand_analysis a
  cross join (values (0), (1), (2)) d(ord)
  where a.owner_id = p_owner;

  insert into public.drill_items (owner_id, hand_id, action_index, analysis_version, ord, street, spot_key, source_grade)
  select d.owner_id, d.hand_id, d.action_index, d.analysis_version, d.ord, d.street, 'flop|srp||BTN|call|raise', d.grade
  from public.decision_analysis d
  where d.owner_id = p_owner and d.grade in ('mistake', 'blunder');

  insert into public.trainer_results (owner_id, mode, family, position, hand_class, grade, ev_loss_bb, ev_loss_pot, score)
  select p_owner, 'preflop', 'open', 'BTN', 'AKo', 'good', 0.1, 0.01, 80
  from generate_series(1, 10);
$$;
select pg_temp.make_analysis('00000000-0000-0000-0000-0000000061b1', 2);
select pg_temp.make_analysis('00000000-0000-0000-0000-0000000061a1', 1);

set local session_replication_role = origin;

select public.report_summaries_rebuild('00000000-0000-0000-0000-0000000061b1');
select public.report_summaries_rebuild('00000000-0000-0000-0000-0000000061a1');
select public.library_counts_rebuild('00000000-0000-0000-0000-0000000061b1');
select public.library_counts_rebuild('00000000-0000-0000-0000-0000000061a1');
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-0000000061b1');
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-0000000061a1');

analyze public.hands;
analyze public.hand_stats;
analyze public.hand_stats_ev;
analyze public.hero_rollups;
analyze public.hero_report_rows;
analyze public.player_stats;
analyze public.player_notes;
analyze public.unparsed_hands;
analyze public.library_hand_counts;
analyze public.library_hero_counts;
analyze public.hand_analysis;
analyze public.decision_analysis;
analyze public.analysis_leak_rows;
analyze public.analysis_leak_totals;
analyze public.analysis_trend_days;
analyze public.analysis_hand_rows;
analyze public.analysis_month_hands;
analyze public.analysis_overview_hands;
analyze public.analysis_overview_decisions;
analyze public.analysis_overview_flags;
analyze public.analysis_overview_keys;
analyze public.analysis_node_totals;
analyze public.analysis_graded_sites;
analyze public.drill_items;
analyze public.trainer_results;

-- ---------------------------------------------------------------------------
-- 2. Every owner reader plans each call and is PL/pgSQL
-- ---------------------------------------------------------------------------

create temp table readers (fn regprocedure primary key);
insert into readers values
  ('public.library_rows(jsonb)'),
  ('public.library_page(jsonb, jsonb, integer)'),
  ('public.library_facets(jsonb)'),
  ('public.search_hands(jsonb, integer, integer)'),
  ('public.hands_since(timestamptz, uuid, integer)'),
  ('public.hands_needing_stats(text, uuid, integer, boolean, text)'),
  ('public.stats_coverage(text)'),
  ('public.stats_ev_missing(text, text)'),
  ('public.stats_opponents(jsonb, text, integer)'),
  ('public.report_open(jsonb)'),
  ('public.report_graph(jsonb, integer)'),
  ('public.report_situations(jsonb)'),
  ('public.report_sessions(jsonb, integer)'),
  ('public.report_facets(jsonb)'),
  ('public.session_review(jsonb, timestamptz, integer, integer)'),
  ('public.players_list(jsonb)'),
  ('public.player_profile(text, text, text, text)'),
  ('public.player_sites(text)'),
  ('public.my_player_notes(text)'),
  ('public.villain_counters(jsonb, jsonb)'),
  ('public.unparsed_summary(integer)'),
  -- 20270818090000: the readers #244 did not list
  ('public.library_count()'),
  ('public.library_table_names(text)'),
  ('public.analysis_scope(jsonb)'),
  ('public.analysis_graded_decisions(jsonb)'),
  ('public.analysis_graded_facets(text)'),
  ('public.analysis_leak_sample(uuid, text, text, text, text, date, date)'),
  ('public.analysis_overview(jsonb)'),
  ('public.analysis_breakdown(jsonb, text)'),
  ('public.analysis_hands(jsonb, text, integer, integer)'),
  ('public.analysis_hand(uuid, text)'),
  ('public.analysis_node_actions(jsonb)'),
  ('public.analysis_node_hands(jsonb, text[], text, boolean, text, integer, integer)'),
  ('public.analysis_leaks(jsonb)'),
  ('public.analysis_leak_hands(jsonb, text[], boolean, text, integer, integer)'),
  ('public.analysis_trend(jsonb, text, text, integer)'),
  ('public.analysis_top_leaks(jsonb, text)'),
  ('public.analysis_leak_examples(jsonb, date, date, jsonb, integer)'),
  ('public.analysis_coverage(text)'),
  ('public.hands_needing_analysis(text, uuid, integer)'),
  ('public.hands_needing_analysis_recent(text, timestamptz, uuid, integer)'),
  ('public.drill_queue(text, text[], boolean, integer)'),
  ('public.drill_summary(text, timestamptz)'),
  ('public.drill_due_by_spot(text, timestamptz)'),
  -- 20270825090000: the previous bodies, kept for the filters the sums do not hold
  ('public.analysis_overview_scan(jsonb)'),
  ('public.analysis_breakdown_scan(jsonb, text)'),
  ('public.analysis_node_actions_scan(jsonb)'),
  ('public.analysis_node_hands_scan(jsonb, text[], text, boolean, text, integer, integer)'),
  ('public.analysis_leaks_scan(jsonb)'),
  ('public.analysis_leak_hands_scan(jsonb, text[], boolean, text, integer, integer)'),
  ('public.analysis_trend_scan(jsonb, text, text, integer)'),
  ('public.hands_needing_analysis_recent_scan(text, timestamptz, uuid, integer)'),
  ('public.trainer_summary(integer)'),
  ('public.study_plan(date, timestamptz)'),
  ('public.get_hand(uuid)'),
  ('public.my_post_state(text)'),
  ('public.my_saved_posts(integer, timestamptz)'),
  ('public.my_notifications(integer, bigint)'),
  ('public.unread_notification_count()');
grant select on readers to authenticated, anon;

select is(
  (select array_agg(r.fn::text order by r.fn::text) from readers r join pg_proc p on p.oid = r.fn
    where not coalesce('plan_cache_mode=force_custom_plan' = any (p.proconfig), false)),
  null,
  'every owner-scoped reader plans each call (plan_cache_mode = force_custom_plan)');

select is(
  (select array_agg(r.fn::text order by r.fn::text) from readers r join pg_proc p on p.oid = r.fn
    join pg_language l on l.oid = p.prolang where l.lanname <> 'plpgsql'),
  null,
  'every owner-scoped reader is PL/pgSQL (its owner a bound value, not an InitPlan)');

select is(
  (select array_agg(r.fn::text order by r.fn::text) from readers r join pg_proc p on p.oid = r.fn where p.prosecdef),
  null,
  'every owner-scoped reader is security invoker (RLS stays in force)');

select is(
  (select array_agg(i.indexrelid::regclass::text order by 1)
     from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.hands'::regclass
      and a.attname in ('played_at', 'total_pot', 'hero_profit', 'created_at')
      and i.indpred is null),
  null,
  'no index on hands sorts every account''s hands together (each sort index leads with owner_id)');

-- ---------------------------------------------------------------------------
-- 3. The small account reads its own rows only
-- ---------------------------------------------------------------------------
--
-- Tuples returned by sequential scans of the owner tables plus index entries
-- returned by their indexes, in this transaction so far.

create temp table owner_tables (relname text primary key);
insert into owner_tables values
  ('hands'), ('hand_stats'), ('hand_stats_ev'), ('hero_rollups'), ('hero_report_rows'), ('player_stats'),
  ('player_notes'), ('unparsed_hands'), ('library_hand_counts'), ('library_hero_counts'), ('hand_analysis'),
  ('decision_analysis'), ('analysis_leak_rows'), ('drill_items'), ('trainer_results'), ('study_plans'),
  ('study_tasks'), ('notifications'), ('saved_posts'), ('thread_subscriptions'),
  -- 20270825090000's summaries (R5.2's daily sums replaced)
  ('analysis_leak_totals'), ('analysis_leak_stake_totals'), ('analysis_trend_days'), ('analysis_hand_rows'), ('analysis_month_hands'),
  ('analysis_overview_hands'), ('analysis_overview_decisions'), ('analysis_overview_flags'),
  ('analysis_overview_keys'), ('analysis_node_totals'), ('analysis_graded_sites');
grant select on owner_tables to authenticated;

create function pg_temp.tuples_read() returns bigint language sql as $$
  select coalesce(sum(pg_stat_get_xact_tuples_returned(c.oid)), 0)::bigint
  from pg_class c
  where c.oid in (
    select t.oid from pg_class t
    where t.relnamespace = 'public'::regnamespace
      and t.relname in (select relname from owner_tables)
    union
    select i.indexrelid from pg_index i join pg_class t on t.oid = i.indrelid
    where t.relnamespace = 'public'::regnamespace
      and t.relname in (select relname from owner_tables));
$$;
-- What one call reads (the second call: the first warms nothing that
-- matters here, but a reader's plan is the steady state's).
create function pg_temp.reads(p_sql text) returns bigint language plpgsql as $$
declare v_before bigint;
begin
  execute p_sql;
  v_before := pg_temp.tuples_read();
  execute p_sql;
  return pg_temp.tuples_read() - v_before;
end;
$$;
grant execute on function pg_temp.tuples_read(), pg_temp.reads(text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000061a1');

-- The small account's rows: 30 hands, at most 60 statistics rows, 30 EV
-- rows, 10 unparsed, 3 notes - and the summaries. A plan that reaches the
-- big account's rows reads thousands.
create temp table small_reads (reader text, n bigint);
grant all on small_reads to authenticated;
insert into small_reads values
  ('library_facets {}',         pg_temp.reads($q$select public.library_facets('{}')$q$)),
  ('library_facets filtered',   pg_temp.reads($q$select public.library_facets('{"formats":["cash"],"positions":["BTN"],"anonymizations":["none"]}')$q$)),
  ('library_page {}',           pg_temp.reads($q$select public.library_page('{}', null, 100)$q$)),
  ('library_page pot type',     pg_temp.reads($q$select public.library_page('{"potTypes":["3bet"],"sort":"pot"}', null, 100)$q$)),
  ('library_page oldest',       pg_temp.reads($q$select public.library_page('{"sort":"oldest"}', null, 100)$q$)),
  ('library_page won',          pg_temp.reads($q$select public.library_page('{"sort":"won","formats":["cash"]}', null, 100)$q$)),
  ('library_page lost',         pg_temp.reads($q$select public.library_page('{"sort":"lost","stakes":["USD:20"]}', null, 100)$q$)),
  ('search_hands {}',           pg_temp.reads($q$select public.search_hands('{}', 50, 0)$q$)),
  ('search_hands site',         pg_temp.reads($q$select public.search_hands('{"site":"pokerstars","sort":"pot_desc"}', 50, 0)$q$)),
  ('hands_since',               pg_temp.reads($q$select count(*) from public.hands_since(null, null, 500)$q$)),
  ('hands_needing_stats',       pg_temp.reads($q$select count(*) from public.hands_needing_stats('stats/1', null, 200, true, 'ev/1')$q$)),
  ('stats_coverage',            pg_temp.reads($q$select public.stats_coverage('stats/1')$q$)),
  ('stats_ev_missing',          pg_temp.reads($q$select public.stats_ev_missing('stats/1', 'ev/1')$q$)),
  ('stats_opponents',           pg_temp.reads($q$select public.stats_opponents('{"statsVersion":"stats/1"}', null, 50)$q$)),
  ('report_open',               pg_temp.reads($q$select public.report_open('{}')$q$)),
  ('report_graph',              pg_temp.reads($q$select public.report_graph('{}', 60)$q$)),
  ('report_situations',         pg_temp.reads($q$select public.report_situations('{}')$q$)),
  ('report_sessions',           pg_temp.reads($q$select public.report_sessions('{}', 30)$q$)),
  ('report_facets',             pg_temp.reads($q$select public.report_facets('{}')$q$)),
  ('session_review',            pg_temp.reads($q$select public.session_review('{}', null, 30, 20)$q$)),
  ('players_list',              pg_temp.reads($q$select public.players_list('{}')$q$)),
  ('player_profile',            pg_temp.reads($q$select public.player_profile('pokerstars', 'v1', 'all', 'stats/1')$q$)),
  ('player_sites',              pg_temp.reads($q$select public.player_sites('stats/1')$q$)),
  ('my_player_notes',           pg_temp.reads($q$select public.my_player_notes(null)$q$)),
  ('villain_counters',          pg_temp.reads($q$select count(*) from public.villain_counters('[{"site":"pokerstars","player":"v1"},{"site":"ggpoker","player":"v2"}]', '{"statsVersion":"stats/1"}')$q$)),
  ('unparsed_summary',          pg_temp.reads($q$select public.unparsed_summary(50)$q$)),
  ('library_count',             pg_temp.reads($q$select public.library_count()$q$)),
  ('library_table_names',       pg_temp.reads($q$select public.library_table_names('table 1')$q$)),
  ('library_page table name',   pg_temp.reads($q$select public.library_page('{"tableName":"table 1","sort":"pot"}', null, 100)$q$)),
  ('library_facets range',         pg_temp.reads($q$select public.library_facets('{"from":"2026-01-02T00:00:00Z","statsVersion":"stats/1"}')$q$)),
  ('analysis_overview',            pg_temp.reads($q$select public.analysis_overview('{"analysisVersion":"analysis/7"}')$q$)),
  ('analysis_breakdown',           pg_temp.reads($q$select public.analysis_breakdown('{"analysisVersion":"analysis/7"}', 'position')$q$)),
  ('analysis_hands',               pg_temp.reads($q$select public.analysis_hands('{"analysisVersion":"analysis/7"}', 'recent', 25, 0)$q$)),
  ('analysis_hand',                pg_temp.reads($q$select public.analysis_hand((select id from public.hands where owner_id = auth.uid() order by id limit 1), 'analysis/7')$q$)),
  ('analysis_node_actions',        pg_temp.reads($q$select public.analysis_node_actions('{"analysisVersion":"analysis/7"}')$q$)),
  ('analysis_node_hands',          pg_temp.reads($q$select public.analysis_node_hands('{"analysisVersion":"analysis/7"}', array['cash-6max:r'], null, false, 'ev_loss', 25, 0)$q$)),
  ('analysis_leaks',               pg_temp.reads($q$select public.analysis_leaks('{"analysisVersion":"analysis/7"}')$q$)),
  ('analysis_leak_hands',          pg_temp.reads($q$select public.analysis_leak_hands('{"analysisVersion":"analysis/7"}', array['flop|srp||BTN|call|raise'], false, 'ev_loss', 25, 0)$q$)),
  ('analysis_trend',               pg_temp.reads($q$select public.analysis_trend('{"analysisVersion":"analysis/7"}', 'session', 'position', 30)$q$)),
  ('analysis_top_leaks',           pg_temp.reads($q$select public.analysis_top_leaks('{"analysisVersion":"analysis/7"}', 'all')$q$)),
  ('analysis_leak_examples',       pg_temp.reads($q$select public.analysis_leak_examples('{"analysisVersion":"analysis/7"}', null, null, '[{"id":"a","keys":["flop|srp||BTN|call|raise"]}]', 15)$q$)),
  ('analysis_coverage',            pg_temp.reads($q$select public.analysis_coverage('analysis/7')$q$)),
  ('hands_needing_analysis',       pg_temp.reads($q$select count(*) from public.hands_needing_analysis('analysis/7', null, 100)$q$)),
  ('hands_needing_analysis_recent', pg_temp.reads($q$select count(*) from public.hands_needing_analysis_recent('analysis/7', null, null, 100)$q$)),
  ('drill_queue',                  pg_temp.reads($q$select public.drill_queue('analysis/7', null, false, 50)$q$)),
  ('drill_summary',                pg_temp.reads($q$select public.drill_summary('analysis/7', null)$q$)),
  ('drill_due_by_spot',            pg_temp.reads($q$select public.drill_due_by_spot('analysis/7', null)$q$)),
  -- 20270825090000's other paths: the leak rows, the hand rows, the scans.
  ('analysis_leaks range',         pg_temp.reads($q$select public.analysis_leaks('{"analysisVersion":"analysis/7","from":"2026-01-01T00:00:00Z","site":"pokerstars"}')$q$)),
  ('analysis_trend week',          pg_temp.reads($q$select public.analysis_trend('{"analysisVersion":"analysis/7"}', 'week', 'street', 30)$q$)),
  ('analysis_trend filtered',      pg_temp.reads($q$select public.analysis_trend('{"analysisVersion":"analysis/7","position":"BTN"}', 'month', 'street', 30)$q$)),
  ('analysis_node_actions seat',   pg_temp.reads($q$select public.analysis_node_actions('{"analysisVersion":"analysis/7","position":"BTN"}')$q$)),
  ('analysis_hands flag',          pg_temp.reads($q$select public.analysis_hands('{"analysisVersion":"analysis/7","flag":"overbet","street":"flop"}', 'ev_loss', 25, 0)$q$)),
  ('analysis_overview scan',       pg_temp.reads($q$select public.analysis_overview('{"analysisVersion":"analysis/7","street":"flop"}')$q$)),
  ('analysis_leaks scan',          pg_temp.reads($q$select public.analysis_leaks('{"analysisVersion":"analysis/7","grade":"blunder"}')$q$)),
  ('trainer_summary',              pg_temp.reads($q$select public.trainer_summary(30)$q$)),
  ('study_plan',                   pg_temp.reads($q$select public.study_plan(public.study_week(), null)$q$)),
  ('get_hand',                     pg_temp.reads($q$select public.get_hand((select id from public.hands where owner_id = auth.uid() order by id limit 1))$q$)),
  ('my_notifications',             pg_temp.reads($q$select public.my_notifications(30, null)$q$)),
  ('unread_notification_count',    pg_temp.reads($q$select public.unread_notification_count()$q$)),
  ('my_saved_posts',               pg_temp.reads($q$select public.my_saved_posts(25, null)$q$));

-- The counters move at all (the measure works): the small account's own
-- library is read.
select ok((select n from small_reads where reader = 'library_page {}') >= 30
          and (select n from small_reads where reader = 'analysis_overview') >= 90,
          'the measure counts a reader''s reads (the small account''s 30 hands, its 90 graded decisions)');

select is(
  (select array_agg(reader || ': ' || n order by reader) from small_reads where n >= 1500),
  null,
  'no reader reads the big account''s rows for the small account (each under 1 500 tuples; the big one holds 6 000 hands, 12 000 statistics rows)');

select pg_temp.as_postgres();

-- ---------------------------------------------------------------------------
-- 4. The same answers as the previous bodies
-- ---------------------------------------------------------------------------

create function pg_temp.old_unparsed_summary(p_limit integer default 50) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'total',       (select count(*) from public.unparsed_hands),
    'occurrences', (select coalesce(sum(occurrences), 0) from public.unparsed_hands),
    'byStatus', (
      select coalesce(jsonb_object_agg(status::text, n), '{}'::jsonb)
      from (select status, count(*) as n from public.unparsed_hands group by status) s
    ),
    'gaps', (
      select coalesce(jsonb_agg(to_jsonb(g) order by g.total_occurrences desc), '[]'::jsonb)
      from (
        select * from public.unparsed_gaps
        order by total_occurrences desc
        limit least(greatest(coalesce(p_limit, 50), 1), 500)
      ) g
    )
  );
$$;

create function pg_temp.old_stats_ev_missing(p_version text, p_ev_version text) returns bigint language sql stable set search_path = '' as $$
  select count(*)
  from public.hero_report_rows r
  where r.owner_id = (select auth.uid())
    and r.stats_version = p_version
    and not exists (
      select 1 from public.hand_stats_ev e
      where e.owner_id = (select auth.uid()) and e.ev_version = p_ev_version
        and e.hand_id = r.hand_id);
$$;

create function pg_temp.old_player_sites(p_stats_version text default null) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(s.site_id order by s.site_id), '[]'::jsonb)
  from (
    select distinct p.site_id
    from public.player_stats p
    where p.owner_id = (select auth.uid())
      and p.stats_version = coalesce(nullif(btrim(coalesce(p_stats_version, '')), ''), 'stats/1')
      and p.site_anonymization = 'none'
  ) s;
$$;

create function pg_temp.old_my_player_notes(p_site text default null) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'site', n.site, 'player', n.player, 'note', n.note,
           'tags', to_jsonb(n.tags), 'updatedAt', n.updated_at
         ) order by n.updated_at desc), '[]'::jsonb)
  from public.player_notes n
  where n.owner_id = (select auth.uid())
    and (p_site is null or n.site = p_site);
$$;

grant execute on all functions in schema pg_temp to authenticated;

-- The gaps' order among equal impact is the table's: compare them as sets.
create function pg_temp.sorted_gaps(p jsonb) returns jsonb language sql immutable as $$
  select p - 'gaps' || jsonb_build_object('gaps',
    (select coalesce(jsonb_agg(g order by g::text), '[]'::jsonb) from jsonb_array_elements(p -> 'gaps') g));
$$;
grant execute on function pg_temp.sorted_gaps(jsonb) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000061a1');
select is(pg_temp.sorted_gaps(public.unparsed_summary(50)), pg_temp.sorted_gaps(pg_temp.old_unparsed_summary(50)),
          'unparsed_summary: the previous answer (small account)');
select is(public.stats_ev_missing('stats/1', 'ev/1'), pg_temp.old_stats_ev_missing('stats/1', 'ev/1'),
          'stats_ev_missing: the previous answer (small account)');
select is(public.player_sites('stats/1'), pg_temp.old_player_sites('stats/1'), 'player_sites: the previous answer (small account)');
select is(public.my_player_notes(null), pg_temp.old_my_player_notes(null), 'my_player_notes: the previous answer (small account)');
select is(public.my_player_notes('pokerstars'), pg_temp.old_my_player_notes('pokerstars'),
          'my_player_notes for a room: the previous answer (small account)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000061b1');
select is(pg_temp.sorted_gaps(public.unparsed_summary(50)), pg_temp.sorted_gaps(pg_temp.old_unparsed_summary(50)),
          'unparsed_summary: the previous answer (big account)');
select is(public.stats_ev_missing('stats/1', 'ev/1'), pg_temp.old_stats_ev_missing('stats/1', 'ev/1'),
          'stats_ev_missing: the previous answer (big account)');
select is(public.player_sites('stats/1'), pg_temp.old_player_sites('stats/1'), 'player_sites: the previous answer (big account)');
select is(public.my_player_notes(null), pg_temp.old_my_player_notes(null), 'my_player_notes: the previous answer (big account)');

-- An empty library.
select pg_temp.as_postgres();
insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000061c1', 'ownerfirst.empty@example.com', now(), now());
select pg_temp.act_as('00000000-0000-0000-0000-0000000061c1');
select is(public.unparsed_summary(50), pg_temp.old_unparsed_summary(50), 'unparsed_summary: the previous answer (nothing submitted)');

-- ---------------------------------------------------------------------------
-- 5. Owner only: each account sees exactly its own rows
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-0000000061a1');
select is((public.analysis_overview('{"analysisVersion":"analysis/7"}') ->> 'hands')::int, 30,
          'analysis_overview: the small account''s 30 graded hands');
select is((public.library_facets('{}') ->> 'library')::int, 30, 'library_facets: library is the small account''s 30 hands');
select is((public.library_facets('{}') ->> 'total')::int, 30, 'library_facets: total is the small account''s 30 hands');
select is(jsonb_array_length(public.library_page('{}', null, 500) -> 'rows'), 30, 'library_page: the small account''s 30 rows');
select is((public.search_hands('{}', 200, 0) ->> 'total')::int, 30, 'search_hands: total is the small account''s 30');
select is(jsonb_array_length(public.search_hands('{}', 200, 0) -> 'rows'), 30, 'search_hands: the small account''s 30 rows');
select ok(
  (select bool_and(r ->> 'id' in (select h.id::text from public.hands h where h.owner_id = '00000000-0000-0000-0000-0000000061a1'))
     from jsonb_array_elements(public.search_hands('{"sort":"pot_desc"}', 200, 0) -> 'rows') r),
  'search_hands: every row is the small account''s');
select is((public.unparsed_summary(50) ->> 'total')::int, 10, 'unparsed_summary: the small account''s 10');
select is(jsonb_array_length(public.my_player_notes(null)), 3, 'my_player_notes: the small account''s 3');
select is(public.stats_ev_missing('stats/1', 'ev/1'),
          (select count(*) from public.hands h where h.owner_id = '00000000-0000-0000-0000-0000000061a1'
              and pg_temp.r(4, h.hand_key) % 5 = 0),
          'stats_ev_missing: the small account''s hands without an EV row');

select pg_temp.act_as('00000000-0000-0000-0000-0000000061b1');
select is((public.analysis_overview('{"analysisVersion":"analysis/7"}') ->> 'hands')::int,
          (select count(*)::int from public.hand_analysis where owner_id = '00000000-0000-0000-0000-0000000061b1'),
          'analysis_overview: the big account''s graded hands');
select is((public.library_facets('{}') ->> 'library')::int, 6000, 'library_facets: the big account''s 6 000 hands');
select is((public.search_hands('{}', 10, 0) ->> 'total')::int, 6000, 'search_hands: the big account''s 6 000');
select is((public.unparsed_summary(50) ->> 'total')::int, 2000, 'unparsed_summary: the big account''s 2 000');
select is(jsonb_array_length(public.my_player_notes(null)), 40, 'my_player_notes: the big account''s 40');

-- The page walks the whole small library and nothing else, keyset.
select pg_temp.act_as('00000000-0000-0000-0000-0000000061a1');
create temp table walked (id text);
grant all on walked to authenticated;
do $$
declare v_after jsonb := null; v_page jsonb; i integer := 0;
begin
  loop
    v_page := public.library_page('{"sort":"pot"}', v_after, 7);
    insert into walked select r ->> 'handKey' from jsonb_array_elements(v_page -> 'rows') r;
    v_after := v_page -> 'next';
    i := i + 1;
    exit when v_after is null or jsonb_typeof(v_after) = 'null' or i > 20;
  end loop;
end $$;
select is((select count(distinct id) from walked), 30::bigint, 'library_page: the keyset walks the small account''s 30 hands');
select is((select count(*) from walked), 30::bigint, 'library_page: each once');

-- Another account, signed in, with no hands: nothing of anyone's.
select pg_temp.act_as('00000000-0000-0000-0000-0000000061c1');
select is((public.library_facets('{}') ->> 'library')::int, 0, 'library_facets: an empty account sees no hands');
select is(jsonb_array_length(public.library_page('{}', null, 100) -> 'rows'), 0, 'library_page: an empty account sees no rows');
select is((public.search_hands('{}', 50, 0) ->> 'total')::int, 0, 'search_hands: an empty account sees none');
select is(public.player_sites('stats/1'), '[]'::jsonb, 'player_sites: an empty account sees no rooms');
select is(public.stats_ev_missing('stats/1', 'ev/1'), 0::bigint, 'stats_ev_missing: an empty account counts none');

-- ---------------------------------------------------------------------------
-- 6. anon
-- ---------------------------------------------------------------------------

select pg_temp.act_as_anon();
select throws_ok($q$select public.analysis_overview('{}')$q$, '42501', null, 'anon: analysis_overview refused');
select throws_ok($q$select public.analysis_leak_sample('00000000-0000-0000-0000-0000000061a1', 'analysis/7', null, null, null, null, null)$q$,
                 '42501', null, 'anon: analysis_leak_sample refused');
select throws_ok($q$select public.get_hand(extensions.gen_random_uuid())$q$, '42501', null, 'anon: get_hand refused');
select throws_ok($q$select public.library_facets('{}')$q$, '42501', null, 'anon: library_facets refused');
select throws_ok($q$select public.library_page('{}', null, 10)$q$, '42501', null, 'anon: library_page refused');
select throws_ok($q$select public.search_hands('{}', 10, 0)$q$, '42501', null, 'anon: search_hands refused');
select throws_ok($q$select public.stats_ev_missing('stats/1', 'ev/1')$q$, '42501', null, 'anon: stats_ev_missing refused');
select throws_ok($q$select public.player_sites('stats/1')$q$, '42501', null, 'anon: player_sites refused');
select throws_ok($q$select public.my_player_notes(null)$q$, '42501', null, 'anon: my_player_notes refused');
select throws_ok($q$select public.villain_counters('[]', '{}')$q$, '42501', null, 'anon: villain_counters refused');
select is(public.unparsed_summary(50) ->> 'total', '0', 'anon: unparsed_summary shows nothing');

select * from finish();
rollback;
