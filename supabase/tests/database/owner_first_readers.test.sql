-- pgTAP: owner first - a reader's work depends only on the caller's own rows
-- (`20270804090000_owner_first_readers.sql`).
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
--     (plans from "rows / owners", see the migration);
--   * every owner-scoped reader plans each call (`force_custom_plan`) and
--     none is a SQL function (whose owner would be an InitPlan again);
--   * the rewritten readers answer as their previous bodies did (kept here
--     as pg_temp copies), for both accounts;
--   * owner only, and anon refused (or, for `unparsed_summary`, shown
--     nothing).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(51);

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

set local session_replication_role = origin;

select public.report_summaries_rebuild('00000000-0000-0000-0000-0000000061b1');
select public.report_summaries_rebuild('00000000-0000-0000-0000-0000000061a1');

analyze public.hands;
analyze public.hand_stats;
analyze public.hand_stats_ev;
analyze public.hero_rollups;
analyze public.hero_report_rows;
analyze public.player_stats;
analyze public.player_notes;
analyze public.unparsed_hands;

-- ---------------------------------------------------------------------------
-- 2. Every owner reader plans each call and is PL/pgSQL
-- ---------------------------------------------------------------------------

create temp table readers (fn regprocedure primary key);
insert into readers values
  ('public.hands_facets()'),
  ('public.library_rows(jsonb)'),
  ('public.library_page(jsonb, jsonb, integer)'),
  ('public.library_facets(jsonb)'),
  ('public.search_hands(jsonb, integer, integer)'),
  ('public.hands_since(timestamptz, uuid, integer)'),
  ('public.hands_needing_stats(text, uuid, integer, boolean, text)'),
  ('public.stats_summary(jsonb)'),
  ('public.stats_graph(jsonb, integer)'),
  ('public.stats_breakdown(jsonb, text)'),
  ('public.stats_sessions(jsonb, integer)'),
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
  ('public.unparsed_summary(integer)');
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

create function pg_temp.tuples_read() returns bigint language sql as $$
  select coalesce(sum(pg_stat_get_xact_tuples_returned(c.oid)), 0)::bigint
  from pg_class c
  where c.oid in (
    select t.oid from pg_class t
    where t.relnamespace = 'public'::regnamespace
      and t.relname in ('hands', 'hand_stats', 'hand_stats_ev', 'hero_rollups', 'hero_report_rows',
                        'player_stats', 'player_notes', 'unparsed_hands')
    union
    select i.indexrelid from pg_index i join pg_class t on t.oid = i.indrelid
    where t.relnamespace = 'public'::regnamespace
      and t.relname in ('hands', 'hand_stats', 'hand_stats_ev', 'hero_rollups', 'hero_report_rows',
                        'player_stats', 'player_notes', 'unparsed_hands'));
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
  ('hands_facets',              pg_temp.reads($q$select public.hands_facets()$q$)),
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
  ('stats_summary',             pg_temp.reads($q$select public.stats_summary('{"statsVersion":"stats/1"}')$q$)),
  ('stats_graph',               pg_temp.reads($q$select public.stats_graph('{"statsVersion":"stats/1"}', 60)$q$)),
  ('stats_breakdown',           pg_temp.reads($q$select public.stats_breakdown('{"statsVersion":"stats/1"}', 'position')$q$)),
  ('stats_sessions',            pg_temp.reads($q$select public.stats_sessions('{"statsVersion":"stats/1"}', 30)$q$)),
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
  ('unparsed_summary',          pg_temp.reads($q$select public.unparsed_summary(50)$q$));

-- The counters move at all (the measure works): the small account's own
-- library is read.
select ok((select n from small_reads where reader = 'hands_facets') >= 30,
          'the measure counts a reader''s reads (hands_facets reads the small account''s 30 hands)');

select is(
  (select array_agg(reader || ': ' || n order by reader) from small_reads where n >= 1500),
  null,
  'no reader reads the big account''s rows for the small account (each under 1 500 tuples; the big one holds 6 000 hands, 12 000 statistics rows)');

select pg_temp.as_postgres();

-- ---------------------------------------------------------------------------
-- 4. The same answers as the previous bodies
-- ---------------------------------------------------------------------------

create function pg_temp.old_hands_facets() returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'total', (select count(*) from public.hands),
    'sites', (
      select coalesce(jsonb_agg(jsonb_build_object('value', site, 'count', n) order by n desc, site), '[]'::jsonb)
      from (select site, count(*) as n from public.hands group by site) s
    ),
    'heroes', (
      select coalesce(jsonb_agg(jsonb_build_object('value', hero_name, 'count', n) order by n desc, hero_name), '[]'::jsonb)
      from (select hero_name, count(*) as n from public.hands where hero_name is not null group by hero_name) s
    ),
    'tables', (
      select coalesce(jsonb_agg(distinct table_name order by table_name), '[]'::jsonb)
      from public.hands where table_name is not null
    ),
    'stakes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'bigBlind', big_blind, 'label', label, 'currency', currency, 'count', n
             ) order by big_blind), '[]'::jsonb)
      from (
        select big_blind, max(stakes_label) as label, max(currency) as currency, count(*) as n
        from public.hands where big_blind is not null group by big_blind
      ) s
    ),
    'variants', (
      select coalesce(jsonb_agg(distinct variant order by variant), '[]'::jsonb)
      from public.hands where variant is not null
    ),
    'limitTypes', (
      select coalesce(jsonb_agg(distinct limit_type order by limit_type), '[]'::jsonb)
      from public.hands where limit_type is not null
    ),
    'gameFormats', (
      select coalesce(jsonb_agg(distinct game_format::text order by game_format::text), '[]'::jsonb)
      from public.hands
    ),
    'heroHandClasses', (
      select coalesce(jsonb_agg(distinct hero_hand_class order by hero_hand_class), '[]'::jsonb)
      from public.hands where hero_hand_class is not null
    ),
    'streets', (
      select coalesce(jsonb_agg(distinct street_reached order by street_reached), '[]'::jsonb)
      from public.hands where street_reached is not null
    ),
    'heroPositions', (
      select coalesce(jsonb_agg(jsonb_build_object('value', hero_position, 'count', n) order by n desc, hero_position), '[]'::jsonb)
      from (select hero_position, count(*) as n from public.hands where hero_position is not null group by hero_position) s
    ),
    'showdownPositions', (
      select coalesce(jsonb_agg(distinct p order by p), '[]'::jsonb)
      from public.hands, unnest(showdown_positions) as p
    ),
    'anonymizations', (
      select coalesce(jsonb_agg(jsonb_build_object('value', site_anonymization::text, 'count', n)
                                order by n desc, site_anonymization::text), '[]'::jsonb)
      from (select site_anonymization, count(*) as n from public.hands group by site_anonymization) s
    ),
    'playedAtRange', (
      select jsonb_build_object('min', min(played_at), 'max', max(played_at)) from public.hands
    ),
    'unparsedTotal', (select count(*) from public.unparsed_hands)
  );
$$;

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
select is(public.hands_facets(), pg_temp.old_hands_facets(), 'hands_facets: the previous answer (small account)');
select is(pg_temp.sorted_gaps(public.unparsed_summary(50)), pg_temp.sorted_gaps(pg_temp.old_unparsed_summary(50)),
          'unparsed_summary: the previous answer (small account)');
select is(public.stats_ev_missing('stats/1', 'ev/1'), pg_temp.old_stats_ev_missing('stats/1', 'ev/1'),
          'stats_ev_missing: the previous answer (small account)');
select is(public.player_sites('stats/1'), pg_temp.old_player_sites('stats/1'), 'player_sites: the previous answer (small account)');
select is(public.my_player_notes(null), pg_temp.old_my_player_notes(null), 'my_player_notes: the previous answer (small account)');
select is(public.my_player_notes('pokerstars'), pg_temp.old_my_player_notes('pokerstars'),
          'my_player_notes for a room: the previous answer (small account)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000061b1');
select is(public.hands_facets(), pg_temp.old_hands_facets(), 'hands_facets: the previous answer (big account)');
select is(pg_temp.sorted_gaps(public.unparsed_summary(50)), pg_temp.sorted_gaps(pg_temp.old_unparsed_summary(50)),
          'unparsed_summary: the previous answer (big account)');
select is(public.stats_ev_missing('stats/1', 'ev/1'), pg_temp.old_stats_ev_missing('stats/1', 'ev/1'),
          'stats_ev_missing: the previous answer (big account)');
select is(public.player_sites('stats/1'), pg_temp.old_player_sites('stats/1'), 'player_sites: the previous answer (big account)');
select is(public.my_player_notes(null), pg_temp.old_my_player_notes(null), 'my_player_notes: the previous answer (big account)');

-- hands_facets on an empty library: the shape of no hands.
select pg_temp.as_postgres();
insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000061c1', 'ownerfirst.empty@example.com', now(), now());
select pg_temp.act_as('00000000-0000-0000-0000-0000000061c1');
select is(public.hands_facets(), pg_temp.old_hands_facets(), 'hands_facets: the previous answer (an empty library)');
select is(public.unparsed_summary(50), pg_temp.old_unparsed_summary(50), 'unparsed_summary: the previous answer (nothing submitted)');

-- ---------------------------------------------------------------------------
-- 5. Owner only: each account sees exactly its own rows
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-0000000061a1');
select is((public.hands_facets() ->> 'total')::int, 30, 'hands_facets: the small account''s 30 hands');
select is((public.hands_facets() ->> 'unparsedTotal')::int, 10, 'hands_facets: the small account''s 10 unparsed samples');
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
select is((public.hands_facets() ->> 'total')::int, 6000, 'hands_facets: the big account''s 6 000 hands');
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
select throws_ok($q$select public.hands_facets()$q$, '42501', null, 'anon: hands_facets refused');
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
