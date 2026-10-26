-- pgTAP: the analysis screens over summaries (`20270825090000_analysis_screen_summaries.sql`).
--
-- The Analysis screens' readers answer from narrow rows and sums kept by
-- triggers on `hand_analysis` and `decision_analysis`. No answer may change.
-- What has to hold:
--
--   * security: the new tables have RLS (select-own) and no client write
--     grant; the triggers and the rebuild are definer and executable by no
--     client role; the readers stay invoker;
--   * the same answers: every reader equals its previous body (the
--     `20270818090000` definitions: the `<reader>_scan` copies, and those
--     read wholly from sums kept here verbatim) for two accounts on random
--     data, under every filter (each alone, combined, empty strings, case
--     and spaces, ranges on and off UTC midnight, the hand-list filters that
--     send a report to its scan) - after the first writes (in two batches),
--     after a re-analysis at a new version, after a prune, after a hand and a
--     single decision are deleted and a decision added to a stored hand;
--   * the triggers keep exactly what a rebuild recounts, after every step;
--   * a deleted account leaves nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(24);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-00000000c5a1', 'screens.one@example.com', now(), now()),
  ('00000000-0000-0000-0000-00000000c5b1', 'screens.two@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.act_as(uuid), pg_temp.as_postgres() to authenticated;

create function pg_temp.r(p_i bigint, p_salt text) returns integer language sql immutable as $$
  select abs(hashtext(p_i::text || ':' || p_salt));
$$;

-- ---------------------------------------------------------------------------
-- 1. Security
-- ---------------------------------------------------------------------------

create temp table summary_tables (t text primary key);
insert into summary_tables values
  ('analysis_hand_rows'), ('analysis_month_hands'), ('analysis_leak_rows'), ('analysis_leak_totals'),
  ('analysis_leak_stake_totals'), ('analysis_trend_days'), ('analysis_overview_hands'), ('analysis_overview_decisions'),
  ('analysis_overview_flags'), ('analysis_overview_keys'), ('analysis_node_totals'), ('analysis_graded_sites');

select is(
  (select count(*)::int from pg_class c join summary_tables s on s.t = c.relname
   where c.relnamespace = 'public'::regnamespace and c.relrowsecurity),
  12, 'the twelve summary tables exist with row level security');
select is(
  (select count(*)::int from information_schema.role_table_grants g join summary_tables s on s.t = g.table_name
   where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated')
     and (g.privilege_type <> 'SELECT' or g.grantee = 'anon')),
  0, 'no client write grant on them, nothing for anon');
select is(
  (select count(*)::int from pg_policies p join summary_tables s on s.t = p.tablename
   where p.schemaname = 'public' and p.cmd = 'SELECT' and p.qual like '%auth.uid()%'),
  12, 'each is readable by its owner only');
select ok(
  (select bool_and(p.prosecdef) and count(*) = 5 from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_hand_rows_on_insert', 'analysis_hand_rows_on_delete', 'analysis_leak_rows_on_insert',
                       'analysis_leak_rows_on_delete', 'analysis_leak_summaries_rebuild'))
  and not has_function_privilege('authenticated', 'public.analysis_hand_rows_on_insert()', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_hand_rows_on_delete()', 'execute')
  and not has_function_privilege('authenticated', 'public.analysis_leak_summaries_rebuild(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.analysis_leak_summaries_rebuild(uuid)', 'execute'),
  'the triggers and the rebuild are security definer and executable by no client role');
select is(
  (select count(*)::int from pg_trigger
   where (tgrelid = 'public.hand_analysis'::regclass and tgname in ('hand_analysis_rows_insert', 'hand_analysis_rows_delete'))
      or (tgrelid = 'public.decision_analysis'::regclass
          and tgname in ('decision_analysis_leak_rows_insert', 'decision_analysis_leak_rows_delete'))),
  4, 'hand_analysis and decision_analysis carry the statement triggers');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('analysis_overview', 'analysis_breakdown', 'analysis_hands', 'analysis_coverage',
                       'hands_needing_analysis_recent', 'analysis_leaks', 'analysis_leak_hands', 'analysis_trend',
                       'analysis_node_actions', 'analysis_node_hands', 'drill_due_by_spot', 'analysis_graded_facets',
                       'analysis_top_leaks', 'analysis_leak_sample')
     and (p.prosecdef or has_function_privilege('anon', p.oid, 'execute')
          or not has_function_privilege('authenticated', p.oid, 'execute'))),
  null, 'the readers stay invoker, executable by authenticated, not by anon');

-- ---------------------------------------------------------------------------
-- 2. The data
-- ---------------------------------------------------------------------------
--
-- Hands as postgres with triggers off (their own budgets are not what this
-- file is about), the library's counts rebuilt; the analysis rows with the
-- triggers on, in several statements. Flag codes keep one severity each and
-- a chart line one scenario (the previous bodies left those ties unordered).

set local session_replication_role = replica;

create function pg_temp.make_hands(p_owner uuid, p_n integer, p_tag text) returns void language sql as $$
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, currency, currency_minor_units,
                            small_blind, big_blind, stakes_label, max_seats, played_at, hero_name, hero_seat,
                            hero_position, hero_cards, hero_hand_class, total_pot, hero_profit, table_name)
  select extensions.gen_random_uuid(), p_owner, p_tag || ':' || i,
         '{"schema":"phf/1","actions":[{"type":"raise","rawLine":"x","label":"y"},{"type":"call"}],"meta":{"rawText":"r"}}',
         'std', (array['pokerstars', 'ggpoker'])[1 + pg_temp.r(i, p_tag || 's') % 2],
         case when pg_temp.r(i, p_tag || 'f') % 5 = 0 then 'tournament' else 'cash' end::public.game_format,
         case when pg_temp.r(i, p_tag || 'cu') % 7 = 0 then 'EUR' else 'USD' end, 100,
         (array[5, 10])[1 + pg_temp.r(i, p_tag || 'b') % 2], (array[10, 25])[1 + pg_temp.r(i, p_tag || 'b') % 2],
         'stake', 6,
         case when pg_temp.r(i, p_tag || 't') % 31 = 0 then null
              else timestamptz '2026-01-05 10:00:00+00' + make_interval(days => i / 12, mins => (i % 12) * 9 + pg_temp.r(i, p_tag || 'j') % 5) end,
         'Hero', 0,
         case when pg_temp.r(i, p_tag || 'p') % 13 = 0 then null
              else (array['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'])[1 + pg_temp.r(i, p_tag || 'p') % 6] end,
         array['Ah', 'Kd'], (array['AKo', 'QQ', '72o', 'T9s', 'A5s', 'KJo'])[1 + pg_temp.r(i, p_tag || 'c') % 6],
         100 + pg_temp.r(i, p_tag || 'q') % 900,
         case when pg_temp.r(i, p_tag || 'e') % 11 = 0 then null else (pg_temp.r(i, p_tag || 'q') % 400) - 200 end,
         'Table ' || (pg_temp.r(i, p_tag || 'm') % 9)
  from generate_series(1, p_n) i;
$$;

select pg_temp.make_hands('00000000-0000-0000-0000-00000000c5a1', 420, 'one');
select pg_temp.make_hands('00000000-0000-0000-0000-00000000c5b1', 130, 'two');

set local session_replication_role = origin;
select public.library_counts_rebuild('00000000-0000-0000-0000-00000000c5a1');
select public.library_counts_rebuild('00000000-0000-0000-0000-00000000c5b1');

-- Analysis rows at a version for the hands a predicate picks.
create function pg_temp.analyse(p_owner uuid, p_version text, p_pick text) returns void language plpgsql as $$
begin
  execute format($q$
    insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason, hero_seat, grade, score,
                                      ev_loss_bb, ev_loss_pot, decisions, analysed, flag_count, worst_flag,
                                      approximations, pot_type)
    select h.id, h.owner_id, %L,
           case k.k when 0 then 'not-analysed' when 1 then 'partial' else 'full' end,
           case when k.k = 0 then (array['no-hero', 'multiway'])[1 + pg_temp.r(3, h.hand_key) %% 2] end, 0,
           case when k.k = 0 or pg_temp.r(4, h.hand_key) %% 9 = 0 then null
                else (array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(5, h.hand_key || %L) %% 5] end,
           case when k.k = 0 then null else pg_temp.r(6, h.hand_key) %% 100 end,
           case when k.k = 0 then null else (pg_temp.r(7, h.hand_key) %% 300) / 100.0 end,
           case when k.k = 0 then null else (pg_temp.r(8, h.hand_key) %% 100) / 1000.0 end,
           k.n, case k.k when 0 then 0 when 1 then k.n - 1 else k.n end,
           pg_temp.r(9, h.hand_key) %% 3, case pg_temp.r(9, h.hand_key) %% 3 when 0 then null when 1 then 'note' else 'inaccurate' end,
           case pg_temp.r(11, h.hand_key) %% 5 when 0 then array['bucketed-range'] when 1 then array['bucketed-range', 'flop-library'] else '{}' end,
           case when pg_temp.r(12, h.hand_key) %% 9 = 0 then null
                else (array['limped', 'single-raised', '3bet', '4bet+', 'walk'])[1 + pg_temp.r(1, h.hand_key) %% 5] end
    from public.hands h
    cross join lateral (
      select case when pg_temp.r(13, h.hand_key) %% 10 = 0 then 0 when pg_temp.r(13, h.hand_key) %% 10 = 1 then 1 else 2 end as k,
             case when pg_temp.r(13, h.hand_key) %% 10 = 0 then pg_temp.r(14, h.hand_key) %% 2
                  when pg_temp.r(13, h.hand_key) %% 10 = 1 then 2 + pg_temp.r(14, h.hand_key) %% 2
                  else 1 + pg_temp.r(14, h.hand_key) %% 4 end as n) k
    where h.owner_id = %L and (%s)
      and not exists (select 1 from public.hand_analysis a where a.hand_id = h.id and a.analysis_version = %L)$q$,
    p_version, p_version, p_owner, p_pick, p_version);

  execute format($q$
    insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status,
                                          reason, node, scenario, source, grade, score, ev_loss_bb, ev_loss_pot,
                                          options, chosen, flags, worst_flag, facing_bet, pot_bb, mdf, facts)
    select a.hand_id, a.owner_id, a.analysis_version, d.ord, d.ord * 2 + 1,
           (array['preflop', 'flop', 'turn', 'river'])[1 + d.ord],
           (array['fold', 'call', 'raise', 'check', 'bet'])[1 + pg_temp.r(d.ord, a.hand_id::text) %% 5],
           case when d.ord < a.analysed then 'analysed' else 'not-analysed' end,
           case when d.ord < a.analysed then null else 'no-chart' end,
           'node-' || d.ord,
           case when d.ord = 0 then x.scenario
                else (array['srp-ip', 'srp-oop', '3bp', 'probe'])[1 + pg_temp.r(d.ord, a.hand_id::text || 's') %% 4] end,
           x.source,
           case when d.ord < a.analysed and not (x.source = 'heuristic' and pg_temp.r(d.ord, a.hand_id::text || 'u') %% 3 = 0)
                then (array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(d.ord, a.hand_id::text || 'g' || %L) %% 5] end,
           case when d.ord < a.analysed and pg_temp.r(d.ord, a.hand_id::text || 'sn') %% 8 <> 0 then pg_temp.r(d.ord, a.hand_id::text || 'sc') %% 100 end,
           case when d.ord < a.analysed and pg_temp.r(d.ord, a.hand_id::text || 'en') %% 11 <> 0 then (pg_temp.r(d.ord, a.hand_id::text || 'e') %% 200) / 100.0 end,
           case when d.ord < a.analysed and pg_temp.r(d.ord, a.hand_id::text || 'pn') %% 13 <> 0 then (pg_temp.r(d.ord, a.hand_id::text || 'p') %% 90) / 1000.0 end,
           case when pg_temp.r(d.ord, a.hand_id::text || 'op') %% 17 = 0 then '[]'::jsonb
                else jsonb_build_array(
                  jsonb_build_object('action', 'fold', 'freq', (pg_temp.r(d.ord, a.hand_id::text || 'f1') %% 10) / 10.0, 'ev', 0),
                  jsonb_build_object('action', 'call', 'freq', (pg_temp.r(d.ord, a.hand_id::text || 'f2') %% 10) / 10.0,
                                     'ev', (pg_temp.r(d.ord, a.hand_id::text || 'e2') %% 5) / 10.0),
                  jsonb_build_object('action', 'raise', 'freq', 0.3, 'ev', (pg_temp.r(d.ord, a.hand_id::text || 'e3') %% 5) / 10.0,
                                     'allIn', pg_temp.r(d.ord, a.hand_id::text || 'ai') %% 4 = 0)) end,
           case when d.ord < a.analysed and pg_temp.r(d.ord, a.hand_id::text || 'cn') %% 9 <> 0 then pg_temp.r(d.ord, a.hand_id::text || 'ch') %% 4 end,
           x.flags,
           case when x.flags @> '[{"severity":"inaccurate"}]' then 'inaccurate' when jsonb_array_length(x.flags) > 0 then 'note' end,
           pg_temp.r(d.ord, a.hand_id::text || 'fb') %% 2 = 0, 12.5,
           case when pg_temp.r(d.ord, a.hand_id::text || 'mn') %% 7 <> 0 then (pg_temp.r(d.ord, a.hand_id::text || 'md') %% 1000) / 1000.0 end,
           case when d.ord = 0 and x.source = 'chart'
                then jsonb_strip_nulls(jsonb_build_object(
                       'chart', jsonb_strip_nulls(jsonb_build_object(
                         'set', (array['nlhe-cash-6max-100bb', 'nlhe-cash-9max-100bb', null, 'Not A Set'])[1 + pg_temp.r(0, a.hand_id::text || 'cs') %% 4],
                         'line', x.line, 'scenario', x.scenario, 'inRange', pg_temp.r(0, a.hand_id::text || 'ir') %% 2 = 0)),
                       'handClass', case when pg_temp.r(0, a.hand_id::text || 'hc') %% 6 <> 0
                                         then (array['AKo', 'QQ', '72o', 'T9s'])[1 + pg_temp.r(0, a.hand_id::text || 'hk') %% 4] end,
                       'position', case pg_temp.r(0, a.hand_id::text || 'po') %% 7 when 0 then 'CO' when 1 then 'bad seat' end))
                else jsonb_strip_nulls(jsonb_build_object(
                       'position', case when pg_temp.r(d.ord, a.hand_id::text || 'po') %% 5 = 0 then 'BTN' end)) end
    from public.hand_analysis a
    cross join lateral generate_series(0, a.decisions - 1) d(ord)
    cross join lateral (
      select l.line, l.scenario,
             case when d.ord = 0 then (case when pg_temp.r(0, a.hand_id::text || 'so') %% 6 = 0 then 'heuristic' else 'chart' end)
                  else (array['solver', 'heuristic', 'approx'])[1 + pg_temp.r(d.ord, a.hand_id::text || 'so') %% 3] end as source,
             case pg_temp.r(d.ord, a.hand_id::text || 'fl') %% 6
               when 0 then '[{"code":"overbet","severity":"note"}]'::jsonb
               when 1 then '[{"code":"thin-value","severity":"inaccurate"}]'::jsonb
               when 2 then '[{"code":"overbet","severity":"note"},{"code":"thin-value","severity":"inaccurate"}]'::jsonb
               else '[]'::jsonb end as flags
      from (select (array['', 'f', 'ff', 'r', 'rc', 'x'])[1 + pg_temp.r(0, a.hand_id::text || 'ln') %% 6] as line) l0
      cross join lateral (select l0.line,
                                 case l0.line when '' then 'open' when 'f' then 'open' when 'ff' then 'open'
                                              when 'r' then 'vs-open' when 'rc' then 'squeeze' else 'odd' end as scenario) l) x
    where a.owner_id = %L and a.analysis_version = %L
      and not exists (select 1 from public.decision_analysis z where z.hand_id = a.hand_id and z.analysis_version = a.analysis_version)$q$,
    p_version, p_owner, p_version);
end;
$$;

-- A: analysis/7 for most hands, in two statements each; analysis/6 for some.
select pg_temp.analyse('00000000-0000-0000-0000-00000000c5a1', 'analysis/7', $p$pg_temp.r(15, h.hand_key) % 9 <> 0 and pg_temp.r(16, h.hand_key) % 2 = 0$p$);
select pg_temp.analyse('00000000-0000-0000-0000-00000000c5a1', 'analysis/7', $p$pg_temp.r(15, h.hand_key) % 9 <> 0$p$);
select pg_temp.analyse('00000000-0000-0000-0000-00000000c5a1', 'analysis/6', $p$pg_temp.r(17, h.hand_key) % 4 = 0$p$);
-- B: analysis/7 for most.
select pg_temp.analyse('00000000-0000-0000-0000-00000000c5b1', 'analysis/7', $p$pg_temp.r(15, h.hand_key) % 7 <> 0$p$);

-- Drill items for some mistakes (by hand and action, as the trainer files them).
insert into public.drill_items (owner_id, hand_id, action_index, analysis_version, ord, street, spot_key, source_grade)
select d.owner_id, d.hand_id, d.action_index, d.analysis_version, d.ord, d.street,
       d.street || '|x||BTN|' || d.action || '|call', d.grade
from public.decision_analysis d
where d.analysis_version = 'analysis/7' and d.grade in ('mistake', 'blunder') and pg_temp.r(d.ord, d.hand_id::text || 'dr') % 3 = 0;

analyze public.hands;
analyze public.hand_analysis;
analyze public.decision_analysis;

-- ---------------------------------------------------------------------------
-- 3. The previous bodies
-- ---------------------------------------------------------------------------
--
-- `<reader>_scan` is the reader's `20270818090000` definition; the readers
-- with no scan are kept here verbatim. Calls between them go to the copies.

create temp table olddefs (fn text primary key, def text);
insert into olddefs values
  ('analysis_hands', $d$
CREATE OR REPLACE FUNCTION public.analysis_hands(p_filters jsonb DEFAULT '{}'::jsonb, p_sort text DEFAULT 'recent'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner  uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  v_sort   text := coalesce(p_sort, 'recent');
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if v_sort not in ('recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result') then
    raise exception 'Unknown analysis sort: %', v_sort using errcode = '22023';
  end if;

  select count(*) into v_total from public.analysis_scope(p_filters);

  select coalesce(jsonb_agg(row_json order by rn), '[]'::jsonb)
    into v_rows
  from (
    select
      row_number() over (
        order by
          case when v_sort = 'oldest' then h.played_at end asc nulls last,
          case when v_sort = 'flags' then a.flag_count end desc,
          case when v_sort = 'flags' then a.worst_flag end asc nulls last,
          case when v_sort = 'ev_loss' then a.ev_loss_bb end desc nulls last,
          case when v_sort = 'ev_loss_pot' then a.ev_loss_pot end desc nulls last,
          case when v_sort = 'score' then a.score end asc nulls last,
          case when v_sort = 'result' and h.big_blind > 0
               then h.hero_profit::numeric / h.big_blind end asc nulls last,
          h.played_at desc nulls last,
          a.hand_id
      ) as rn,
      jsonb_build_object(
        'handId',             a.hand_id,
        'playedAt',           h.played_at,
        'site',               h.site,
        'stakesLabel',        h.stakes_label,
        'gameFormat',         h.game_format,
        'currency',           h.currency,
        'currencyMinorUnits', h.currency_minor_units,
        'bigBlind',           h.big_blind,
        'position',           h.hero_position,
        'heroCards',          to_jsonb(h.hero_cards),
        'handClass',          h.hero_hand_class,
        'potType',            a.pot_type,
        'status',             a.status,
        'reason',             a.reason,
        'grade',              a.grade,
        'score',              a.score,
        'evLossBb',           a.ev_loss_bb,
        'evLossPot',          a.ev_loss_pot,
        'flagCount',          a.flag_count,
        'worstFlag',          a.worst_flag,
        'netBb', case when h.big_blind > 0 and h.hero_profit is not null
                      then round(h.hero_profit::numeric / h.big_blind, 2) end,
        'decisions', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'ord',         d.ord,
                   'actionIndex', d.action_index,
                   'street',      d.street,
                   'action',      d.action,
                   'status',      d.status,
                   'grade',       d.grade,
                   'evLossBb',    d.ev_loss_bb,
                   'worstFlag',   d.worst_flag) order by d.ord)
          from public.decision_analysis d
          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)
      ) as row_json
    from public.analysis_scope(p_filters) a
    join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
    order by rn
    offset v_offset
    limit v_limit
  ) page;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   v_sort,
    'rows',   v_rows
  );
end;
$function$;
$d$),
  ('analysis_coverage', $d$
CREATE OR REPLACE FUNCTION public.analysis_coverage(p_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_coverage needs an analysis_version.' using errcode = '22023';
  end if;

  with h as (
    select
      exists (select 1 from public.hand_analysis a
              where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version) as is_current,
      exists (select 1 from public.hand_analysis a
              where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version <> p_version) as has_old
    from public.hands hd
    where hd.owner_id = v_owner
  )
  select jsonb_build_object(
    'analysisVersion', p_version,
    'hands',           count(*),
    'atVersion',       count(*) filter (where is_current),
    'stale',           count(*) filter (where not is_current and has_old),
    'missing',         count(*) filter (where not is_current and not has_old),
    'obsoleteRows', (
      select count(*) from public.hand_analysis a
      where a.owner_id = v_owner and a.analysis_version <> p_version)
  )
  into v_out
  from h;

  return v_out;
end;
$function$;
$d$),
  ('drill_due_by_spot', $d$
CREATE OR REPLACE FUNCTION public.drill_due_by_spot(p_version text, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner uuid := auth.uid();
  v_until timestamptz := coalesce(p_until, now() + interval '1 day');
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to drill your hands.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'drill_due_by_spot needs an analysis_version.' using errcode = '22023';
  end if;

  with drilled as (
    select di.spot_key, count(*) as items, count(*) filter (where di.due_at <= v_until) as due
    from public.drill_items di
    where di.owner_id = v_owner
      and di.analysis_version = p_version
      and exists (
        select 1 from public.decision_analysis d
        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)
    group by di.spot_key
  ),
  fresh as (
    select g.spot_key, count(*) as items
    from public.analysis_graded_decisions(jsonb_build_object('analysisVersion', p_version)) g
    where public.analysis_grade_rank(g.grade) >= public.analysis_grade_rank('mistake')
      and not exists (
        select 1 from public.drill_items x
        where x.owner_id = v_owner and x.hand_id = g.hand_id and x.action_index = g.action_index)
    group by g.spot_key
  ),
  keys as (
    select spot_key from drilled union select spot_key from fresh
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',   k.spot_key,
           'items', coalesce(d.items, 0) + coalesce(f.items, 0),
           'due',   coalesce(d.due, 0) + coalesce(f.items, 0)) order by k.spot_key), '[]'::jsonb)
  into v_out
  from keys k
  left join drilled d on d.spot_key = k.spot_key
  left join fresh f on f.spot_key = k.spot_key;

  return v_out;
end;
$function$;
$d$),
  ('analysis_graded_facets', $d$
create or replace function public.analysis_graded_facets(p_version text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
begin
  return (
    with f as materialized (
      select h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.played_at
      from public.hand_analysis a
      join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
      where a.owner_id = v_owner
        and a.analysis_version = p_version
        and exists (
          select 1 from public.decision_analysis dd
          where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version and dd.owner_id = v_owner
            and dd.grade is not null)
    )
    select jsonb_build_object(
      'sites', coalesce((
        select jsonb_agg(jsonb_build_object('site', x.site, 'hands', x.n) order by x.n desc, x.site)
        from (select site, count(*) as n from f group by site) x), '[]'::jsonb),
      'stakes', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'currency',           x.currency,
                 'currencyMinorUnits', x.currency_minor_units,
                 'smallBlind',         x.small_blind,
                 'bigBlind',           x.big_blind,
                 'hands',              x.n)
               order by x.n desc, x.currency, x.big_blind)
        from (
          select currency, currency_minor_units, small_blind, big_blind, count(*) as n
          from f
          group by 1, 2, 3, 4
        ) x), '[]'::jsonb),
      'first', (select min(played_at) from f),
      'last',  (select max(played_at) from f)));
end;
$$;
$d$);
insert into olddefs
select replace(p.proname, '_scan', ''), pg_get_functiondef(p.oid)
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('analysis_overview_scan', 'analysis_breakdown_scan', 'analysis_node_actions_scan',
                    'analysis_node_hands_scan', 'analysis_leaks_scan', 'analysis_leak_hands_scan',
                    'analysis_trend_scan', 'hands_needing_analysis_recent_scan');

create function pg_temp.make_old(p_fn text) returns void language plpgsql as $$
declare
  v_def text := (select def from olddefs where fn = p_fn);
begin
  v_def := regexp_replace(v_def, '(?i)create or replace function public\.' || p_fn || '(_scan)?\(',
                          'CREATE FUNCTION pg_temp.old_' || p_fn || '(');
  v_def := replace(v_def, 'public.analysis_graded_facets(', 'pg_temp.old_analysis_graded_facets(');
  execute v_def;
end;
$$;
select pg_temp.make_old(fn) from olddefs order by fn = 'analysis_graded_facets' desc, fn;
grant execute on all functions in schema pg_temp to authenticated;

select is((select count(*)::int from pg_proc where pronamespace = pg_my_temp_schema() and proname like 'old\_%'), 12,
  'the twelve previous bodies are rebuilt');

-- ---------------------------------------------------------------------------
-- 4. The comparisons
-- ---------------------------------------------------------------------------

create temp table filters (i integer, f jsonb);
insert into filters values
  (1,  '{"analysisVersion":"analysis/7"}'),
  (2,  '{"analysisVersion":"analysis/6"}'),
  (3,  '{"analysisVersion":"analysis/8"}'),
  (4,  '{}'),
  (5,  '{"analysisVersion":"analysis/7","gameFormat":"cash"}'),
  (6,  '{"analysisVersion":"analysis/7","position":"btn"}'),
  (7,  '{"analysisVersion":"analysis/7","position":" BB "}'),
  (8,  '{"analysisVersion":"analysis/7","position":" "}'),
  (9,  '{"analysisVersion":"analysis/7","potType":"3bet"}'),
  (10, '{"analysisVersion":"analysis/7","gameFormat":"tournament","position":"SB","potType":"single-raised"}'),
  (11, '{"analysisVersion":"analysis/7","from":"2026-01-20T00:00:00Z","to":"2026-02-10T00:00:00Z"}'),
  (12, '{"analysisVersion":"analysis/7","from":"2026-01-20T13:30:00Z"}'),
  (13, '{"analysisVersion":"analysis/7","to":"2026-02-03T11:00:00+02"}'),
  (14, '{"analysisVersion":"analysis/7","site":" PokerStars "}'),
  (15, '{"analysisVersion":"analysis/7","currency":"eur","bigBlind":"25"}'),
  (16, '{"analysisVersion":"analysis/7","bigBlind":10}'),
  (17, '{"analysisVersion":"analysis/7","site":"ggpoker","position":"CO","from":"2026-01-15T00:00:00Z"}'),
  (18, '{"analysisVersion":"analysis/7","status":"partial"}'),
  (19, '{"analysisVersion":"analysis/7","grade":"mistake"}'),
  (20, '{"analysisVersion":"analysis/7","minGrade":"inaccurate","gameFormat":"cash"}'),
  (21, '{"analysisVersion":"analysis/7","street":"turn"}'),
  (22, '{"analysisVersion":"analysis/7","flag":"overbet"}'),
  (23, '{"analysisVersion":"analysis/7","flagged":true}'),
  (24, '{"analysisVersion":"analysis/7","flagged":"false","position":"UTG"}'),
  (25, '{"analysisVersion":"analysis/7","gameFormat":"","site":"","from":"","potType":""}'),
  (26, '{"analysisVersion":"analysis/7","potType":"walk","to":"2026-03-01T00:00:00Z"}'),
  (27, '{"analysisVersion":"analysis/8","position":"BTN","from":"2026-01-10T00:00:00Z"}'),
  (28, '{"analysisVersion":"analysis/7","to":"2026-01-06T00:00:00Z"}');

-- (reader, call) pairs: the new reader and its previous body on the same arguments.
create temp table calls (n serial, reader text, args text, light boolean);
create function pg_temp.call(p_reader text, p_args text, p_light boolean default true) returns void language sql as $$
  insert into calls (reader, args, light) values (p_reader, p_args, p_light);
$$;
select pg_temp.call('analysis_overview', quote_literal(f) || '::jsonb') from filters;
select pg_temp.call('analysis_breakdown', quote_literal(f) || '::jsonb, ' || quote_literal(g), g in ('street', 'position'))
  from filters, unnest(array['street', 'position', 'pot_type', 'scenario', 'preflop_scenario']) g;
select pg_temp.call('analysis_hands', quote_literal(f) || '::jsonb, ' || quote_literal(s) || ', 15, 3', s in ('recent', 'ev_loss'))
  from filters, unnest(array['recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result']) s;
select pg_temp.call('analysis_hands', quote_literal(f) || '::jsonb, ''recent'', 100, 0') from filters;
select pg_temp.call('analysis_node_actions', quote_literal(f) || '::jsonb') from filters;
select pg_temp.call('analysis_node_hands', quote_literal(f) || '::jsonb, '
                    || 'array[''nlhe-cash-6max-100bb:r'', ''nlhe-cash-6max-100bb:'', ''nlhe-cash-9max-100bb:rc'', ''nlhe-cash-6max-100bb:f'', ''nlhe-cash-6max-100bb:f''], '
                    || coalesce(quote_literal(a), 'null') || ', ' || d || ', ' || quote_literal(s) || ', 10, ' || o, a is null and s = 'ev_loss')
  from filters, (values ('raise'), (null), ('fold'), ('allin')) x(a), (values (true), (false)) y(d),
       unnest(array['ev_loss', 'ev_loss_pot', 'recent', 'oldest']) s, (values (0)) z(o)
  where filters.i % 3 = 1 or (a is null and d);
select pg_temp.call('analysis_leaks', quote_literal(f) || '::jsonb') from filters;
select pg_temp.call('analysis_leak_hands', quote_literal(f) || '::jsonb, (select array_agg(k) || array[''flop|nosuch||BTN|bet|call''] from (select distinct spot_key as k from public.analysis_leak_rows where grade is not null order by 1 limit 400) z), '
                    || d || ', ' || quote_literal(s) || ', 12, ' || o, s = 'ev_loss' and o = 0)
  from filters, (values (true), (false)) y(d), unnest(array['ev_loss', 'ev_loss_pot', 'recent', 'oldest']) s, (values (0), (9)) z(o)
  where filters.i % 2 = 1 or (s = 'ev_loss' and o = 0);
select pg_temp.call('analysis_trend', quote_literal(f) || '::jsonb, ' || quote_literal(b) || ', ' || quote_literal(g) || ', ' || gap,
                    b = 'week' and g in ('all', 'street'))
  from filters, unnest(array['week', 'month', 'session']) b, unnest(array['all', 'street', 'position', 'pot_type']) g,
       (values (30), (5)) gg(gap)
  where (gap = 30 or b = 'session') and (filters.i % 2 = 0 or g = 'all');
select pg_temp.call('analysis_coverage', quote_literal(v)) from unnest(array['analysis/7', 'analysis/6', 'analysis/8', 'analysis/1']) v;
select pg_temp.call('analysis_graded_facets', quote_literal(v)) from unnest(array['analysis/7', 'analysis/6', 'analysis/8']) v;
select pg_temp.call('drill_due_by_spot', quote_literal(v) || ', null') from unnest(array['analysis/7', 'analysis/8', 'analysis/6']) v;
-- Newest hands still to analyse: whole pages, a page from a cursor inside the
-- history, a cursor among the hands without a time.
create function pg_temp.recent(p_reader text, p_version text, p_skip integer, p_limit integer, p_nulls boolean)
returns jsonb language plpgsql as $$
declare
  v_at timestamptz;
  v_id uuid;
  v_out jsonb;
begin
  -- The cursor: a hand without a time, or the previous walk's p_skip-th hand.
  if p_nulls then
    select null, h.id into v_at, v_id from public.hands h where h.played_at is null order by h.id desc offset 1 limit 1;
  elsif p_skip > 0 then
    select r.played_at, r.id into v_at, v_id
    from pg_temp.old_hands_needing_analysis_recent(p_version, null, null, 200) r offset p_skip limit 1;
  end if;
  if p_reader = 'new' then
    select jsonb_agg(jsonb_build_array(r.id, r.played_at, r.phf)) into v_out
    from public.hands_needing_analysis_recent(p_version, v_at, v_id, p_limit) r;
  else
    select jsonb_agg(jsonb_build_array(r.id, r.played_at, r.phf)) into v_out
    from pg_temp.old_hands_needing_analysis_recent(p_version, v_at, v_id, p_limit) r;
  end if;
  return coalesce(v_out, '[]'::jsonb);
end;
$$;
grant execute on function pg_temp.recent(text, text, integer, integer, boolean) to authenticated;
select pg_temp.call('recent', quote_literal(v) || ', ' || sk || ', ' || lim || ', ' || nl, false)
  from unnest(array['analysis/7', 'analysis/6', 'analysis/8']) v, (values (0), (7), (30)) s(sk), (values (5), (100)) l(lim),
       (values (false), (true)) z(nl)
  where not (nl and sk > 0);

grant select on calls, filters to authenticated;
create temp table differ (phase text, account text, n integer, reader text, args text);
grant all on differ to authenticated;

-- Compares the calls (all, or the light ones) for the account acting now.
create function pg_temp.compare(p_phase text, p_account text, p_light boolean) returns void language plpgsql as $$
declare
  c record;
  v_new jsonb;
  v_old jsonb;
begin
  for c in select * from calls where not p_light or light order by n loop
    if c.reader = 'recent' then
      execute 'select pg_temp.recent(''new'', ' || c.args || ')' into v_new;
      execute 'select pg_temp.recent(''old'', ' || c.args || ')' into v_old;
    else
      execute 'select to_jsonb(x.v) from (select public.' || c.reader || '(' || c.args || ')) x(v)' into v_new;
      execute 'select to_jsonb(x.v) from (select pg_temp.old_' || c.reader || '(' || c.args || ')) x(v)' into v_old;
    end if;
    if v_new is distinct from v_old then
      insert into differ values (p_phase, p_account, c.n, c.reader, c.args);
    end if;
  end loop;
end;
$$;
grant execute on function pg_temp.compare(text, text, boolean) to authenticated;

-- The summaries as a set of rows, to hold the triggers to a rebuild.
-- (Compared as JSON values: a sum kept as 0.000 equals one recounted as 0.)
create temp table kept (t text, row_value jsonb);
create function pg_temp.snapshot() returns void language plpgsql as $$
declare
  s record;
begin
  delete from kept;
  for s in select t from summary_tables loop
    execute format('insert into kept select %L, to_jsonb(x) from public.%I x', s.t, s.t);
  end loop;
end;
$$;
create function pg_temp.rebuilt_same() returns boolean language plpgsql as $$
declare
  v_same boolean;
begin
  perform pg_temp.snapshot();
  create temp table before_rebuild on commit drop as select * from kept;
  perform public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-00000000c5a1');
  perform public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-00000000c5b1');
  perform pg_temp.snapshot();
  v_same := not exists (select * from before_rebuild except all select * from kept)
        and not exists (select * from kept except all select * from before_rebuild);
  drop table before_rebuild;
  return v_same;
end;
$$;

select ok((select count(*) from calls) > 600, 'many calls to compare: ' || (select count(*) from calls));
select ok(pg_temp.rebuilt_same(), 'after the first writes the triggers kept exactly what a rebuild recounts');

select pg_temp.act_as('00000000-0000-0000-0000-00000000c5a1');
select pg_temp.compare('written', 'one', false);
select is((select array_agg(reader || ': ' || args order by n) from differ where phase = 'written' and account = 'one'), null,
          'every reader answers as its previous body (first account, every call)');
select ok((public.analysis_overview('{"analysisVersion":"analysis/7"}') ->> 'hands')::int > 300
          and jsonb_array_length(public.analysis_leaks('{"analysisVersion":"analysis/7"}') -> 'rows') > 30
          and jsonb_array_length(public.analysis_node_actions('{"analysisVersion":"analysis/7"}') -> 'classes') > 10
          and jsonb_array_length(public.analysis_trend('{"analysisVersion":"analysis/7"}', 'session', 'street', 5) -> 'rows') > 30
          and (public.analysis_coverage('analysis/7') ->> 'missing')::int > 10
          and jsonb_array_length(public.drill_due_by_spot('analysis/7', null)) > 5,
          '... over hands, leaks, nodes, sessions, hands to analyse and drills (the comparisons compare something)');

select pg_temp.act_as('00000000-0000-0000-0000-00000000c5b1');
select pg_temp.compare('written', 'two', true);
select is((select array_agg(reader || ': ' || args order by n) from differ where phase = 'written' and account = 'two'), null,
          'every reader answers as its previous body (second account)');
select is((public.analysis_overview('{"analysisVersion":"analysis/7"}') ->> 'hands')::int,
          (select count(*)::int from public.hand_analysis where analysis_version = 'analysis/7'),
          '... its own hands only');

-- A re-analysis at a new version for a third of A's hands.
select pg_temp.as_postgres();
select pg_temp.analyse('00000000-0000-0000-0000-00000000c5a1', 'analysis/8', $p$pg_temp.r(18, h.hand_key) % 3 = 0$p$);
select ok(pg_temp.rebuilt_same(), 'after a re-analysis at a new version the sums equal a rebuild');
select pg_temp.act_as('00000000-0000-0000-0000-00000000c5a1');
select pg_temp.compare('version', 'one', true);
select is((select array_agg(reader || ': ' || args order by n) from differ where phase = 'version'), null,
          '... and every reader its previous body');

-- A prune of the older versions, in slices.
select is((public.prune_hand_analysis('analysis/8', 90) ->> 'deleted')::int, 90, 'A prunes 90 older analysis rows');
select pg_temp.as_postgres();
select ok(pg_temp.rebuilt_same(), 'after a prune the sums equal a rebuild');
select pg_temp.act_as('00000000-0000-0000-0000-00000000c5a1');
select pg_temp.compare('prune', 'one', true);
select is((select array_agg(reader || ': ' || args order by n) from differ where phase = 'prune'), null,
          '... and every reader its previous body');

-- A hand deleted; one decision of a stored hand deleted; one decision added
-- to a stored hand (no writer does the last two: as postgres).
select pg_temp.as_postgres();
delete from public.hands h
where h.id = (select a.hand_id from public.hand_analysis a
              where a.owner_id = '00000000-0000-0000-0000-00000000c5a1' and a.analysis_version = 'analysis/7' and a.decisions >= 3
              order by a.hand_id limit 1);
delete from public.decision_analysis d
where (d.hand_id, d.analysis_version, d.ord) = (
  select x.hand_id, x.analysis_version, x.ord from public.decision_analysis x
  where x.owner_id = '00000000-0000-0000-0000-00000000c5a1' and x.analysis_version = 'analysis/7' and x.ord = 0
    and x.grade is not null and x.source = 'chart' and x.flags <> '[]'
    and exists (select 1 from public.decision_analysis y where y.hand_id = x.hand_id and y.analysis_version = x.analysis_version and y.ord = 1)
  order by x.hand_id limit 1);
insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status, node,
                                      scenario, source, grade, score, ev_loss_bb, ev_loss_pot, options, chosen, flags, worst_flag,
                                      facts)
select a.hand_id, a.owner_id, a.analysis_version, 9, 41, 'river', 'bet', 'analysed', 'n', 'probe', 'solver', 'blunder', 10,
       2.5, 0.2, '[{"action":"check","ev":1},{"action":"bet","ev":0}]', 1, '[{"code":"overbet","severity":"note"}]', 'note',
       '{"position":"HJ"}'
from public.hand_analysis a
where a.owner_id = '00000000-0000-0000-0000-00000000c5a1' and a.analysis_version = 'analysis/7' and a.decisions between 1 and 2
order by a.hand_id limit 2;
select ok(pg_temp.rebuilt_same(), 'after a hand and a decision deleted and decisions added the sums equal a rebuild');
select pg_temp.act_as('00000000-0000-0000-0000-00000000c5a1');
select pg_temp.compare('edits', 'one', true);
select is((select array_agg(reader || ': ' || args order by n) from differ where phase = 'edits'), null,
          '... and every reader its previous body');

-- An account deleted takes its rows and sums with it.
select pg_temp.as_postgres();
delete from auth.users where id = '00000000-0000-0000-0000-00000000c5b1';
select is(
  (select sum(n)::int from (
     select count(*) as n from public.analysis_hand_rows where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_month_hands where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_leak_rows where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_leak_totals where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_leak_stake_totals where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_trend_days where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_overview_hands where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_overview_decisions where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_overview_flags where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_overview_keys where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_node_totals where owner_id = '00000000-0000-0000-0000-00000000c5b1'
     union all select count(*) from public.analysis_graded_sites where owner_id = '00000000-0000-0000-0000-00000000c5b1') x),
  0, 'a deleted account leaves no summary row');
select ok(pg_temp.rebuilt_same(), '... and the other account''s sums still equal a rebuild');

-- The filters the sums hold go to them, the others to the scan (no answer
-- differs either way: this is about where the work is done).
select pg_temp.act_as('00000000-0000-0000-0000-00000000c5a1');
select ok(public.analysis_filter_sums_ok(public.analysis_filter_of('{"gameFormat":"cash","position":"BTN","potType":"3bet","flagged":false}'))
          and not public.analysis_filter_sums_ok(public.analysis_filter_of('{"from":"2026-01-01T00:00:00Z"}'))
          and public.analysis_filter_rows_ok(public.analysis_filter_of('{"from":"2026-01-01T00:00:00Z","site":"x","bigBlind":"10"}'))
          and not public.analysis_filter_rows_ok(public.analysis_filter_of('{"street":"flop"}'))
          and not public.analysis_filter_rows_ok(public.analysis_filter_of('{"minGrade":"good"}')),
          'the sums hold format, seat and pot type; the rows a range, a room and a stake; the hand-list filters go to the scan');
select throws_ok($$select public.analysis_overview('{"grade":"awful"}')$$, '22023', null,
                 'an unknown grade is refused as before');

select * from finish();
rollback;
