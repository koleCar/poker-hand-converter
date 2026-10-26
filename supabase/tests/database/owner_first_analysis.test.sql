-- pgTAP: the older owner-scoped readers under the owner-first rule
-- (`20270818090000_big_account_readers.sql`, section 5).
--
-- The analysis, drill, trainer and study readers - and `get_hand`, the
-- forum's own-state readers - now bind the caller once, filter `owner_id` on
-- every owner table a statement reads, and plan per call. No answer may
-- change: here each one is compared with its previous body, for two
-- accounts with graded hands, drill items and trainer results, on many
-- arguments. The previous PL/pgSQL bodies are the current definitions with
-- each edit of the migration undone (every edit must be found, so a later
-- change to a reader shows up here); the previous SQL ones are kept
-- verbatim. Their rows-read guard is in `owner_first_readers`.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(8);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000081a1', 'analysis.one@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000081b1', 'analysis.two@example.com', now(), now());

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

create function pg_temp.r(p_i integer, p_salt text) returns integer language sql immutable as $$
  select abs(hashtext(p_i::text || ':' || p_salt));
$$;

-- ---------------------------------------------------------------------------
-- 1. The data: graded hands for two accounts
-- ---------------------------------------------------------------------------

set local session_replication_role = replica;

create function pg_temp.make(p_owner uuid, p_n integer, p_tag text) returns void language sql as $$
  insert into public.hands (id, owner_id, hand_key, phf, standard_text, site, game_format, currency, currency_minor_units,
                            small_blind, big_blind, stakes_label, max_seats, played_at, hero_name, hero_seat,
                            hero_position, hero_cards, hero_hand_class, total_pot, hero_profit, table_name)
  select extensions.gen_random_uuid(), p_owner, p_tag || ':' || i,
         '{"schema":"phf/1","actions":[{"type":"raise","rawLine":"x","label":"y"},{"type":"call"}],"meta":{"rawText":"r"}}',
         'std', (array['pokerstars', 'ggpoker'])[1 + pg_temp.r(i, p_tag || 's') % 2],
         case when pg_temp.r(i, p_tag || 'f') % 5 = 0 then 'tournament' else 'cash' end::public.game_format,
         'USD', 100, (array[1, 5])[1 + pg_temp.r(i, p_tag || 'b') % 2], (array[2, 10])[1 + pg_temp.r(i, p_tag || 'b') % 2],
         '$' || (pg_temp.r(i, p_tag || 'b') % 2), 6,
         case when pg_temp.r(i, p_tag || 't') % 29 = 0 then null
              else timestamptz '2026-01-05 18:00:00+00' + make_interval(mins => i * 37 + pg_temp.r(i, p_tag || 'j') % 20) end,
         'Hero', 0, (array['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'])[1 + pg_temp.r(i, p_tag || 'p') % 6],
         array['Ah', 'Kd'], (array['AKo', 'QQ', '72o', 'T9s'])[1 + pg_temp.r(i, p_tag || 'c') % 4],
         100 + pg_temp.r(i, p_tag || 'q') % 900,
         case when pg_temp.r(i, p_tag || 'e') % 11 = 0 then null else (pg_temp.r(i, p_tag || 'q') % 400) - 200 end,
         'Table ' || (pg_temp.r(i, p_tag || 'm') % 9)
  from generate_series(1, p_n) i;

  -- Two versions: the current one (analysis/7) for most hands, an old one for some.
  insert into public.hand_analysis (hand_id, owner_id, analysis_version, status, reason, hero_seat, grade, score,
                                    ev_loss_bb, ev_loss_pot, decisions, analysed, flag_count, worst_flag,
                                    approximations, pot_type)
  select h.id, h.owner_id, v.version,
         case k.k when 0 then 'not-analysed' when 1 then 'partial' else 'full' end,
         case when k.k = 0 then 'no-hero' end, 0,
         case when k.k = 0 then null else (array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(5, h.hand_key) % 5] end,
         case when k.k = 0 then null else pg_temp.r(6, h.hand_key) % 100 end,
         case when k.k = 0 then null else (pg_temp.r(7, h.hand_key) % 300) / 100.0 end,
         case when k.k = 0 then null else (pg_temp.r(8, h.hand_key) % 100) / 1000.0 end,
         3, case k.k when 0 then 0 when 1 then 2 else 3 end,
         pg_temp.r(9, h.hand_key) % 3, case pg_temp.r(9, h.hand_key) % 3 when 0 then null when 1 then 'note' else 'inaccurate' end,
         case when pg_temp.r(11, h.hand_key) % 4 = 0 then array['bucketed-range'] else '{}' end,
         case when pg_temp.r(12, h.hand_key) % 9 = 0 then null
              else (array['limped', 'single-raised', '3bet', '4bet+'])[1 + pg_temp.r(1, h.hand_key) % 4] end
  from public.hands h
  cross join lateral (select case when pg_temp.r(13, h.hand_key) % 10 = 0 then 0 when pg_temp.r(13, h.hand_key) % 10 = 1 then 1 else 2 end as k) k
  cross join (values ('analysis/7'), ('analysis/6')) v(version)
  where h.owner_id = p_owner and (v.version = 'analysis/7' or pg_temp.r(14, h.hand_key) % 4 = 0)
    and pg_temp.r(15, h.hand_key) % 8 <> 0;

  insert into public.decision_analysis (hand_id, owner_id, analysis_version, ord, action_index, street, action, status,
                                        reason, node, scenario, source, grade, score, ev_loss_bb, ev_loss_pot,
                                        options, chosen, flags, worst_flag, facing_bet, pot_bb, mdf, facts)
  select a.hand_id, a.owner_id, a.analysis_version, d.ord, d.ord * 2 + 1,
         (array['preflop', 'flop', 'turn'])[1 + d.ord],
         (array['fold', 'call', 'raise', 'check', 'bet'])[1 + pg_temp.r(d.ord, a.hand_id::text) % 5],
         case when d.ord < a.analysed then 'analysed' else 'not-analysed' end,
         case when d.ord < a.analysed then null else 'no-chart' end,
         'node-' || d.ord, (array['open', 'srp', '3bp', 'vs-open'])[1 + pg_temp.r(d.ord, a.hand_id::text || 's') % 4],
         case when d.ord = 0 then 'chart' when d.ord = 1 then 'solver' else 'heuristic' end,
         case when d.ord < a.analysed then (array['perfect', 'good', 'inaccurate', 'mistake', 'blunder'])[1 + pg_temp.r(d.ord, a.hand_id::text || 'g') % 5] end,
         case when d.ord < a.analysed then pg_temp.r(d.ord, a.hand_id::text || 'sc') % 100 end,
         case when d.ord < a.analysed then (pg_temp.r(d.ord, a.hand_id::text || 'e') % 200) / 100.0 end,
         case when d.ord < a.analysed then 0.01 end,
         '[{"action":"fold","freq":0.2,"ev":0},{"action":"call","freq":0.5,"ev":0.1},{"action":"raise","freq":0.3,"ev":0.2,"allIn":false}]'::jsonb,
         case when d.ord < a.analysed then pg_temp.r(d.ord, a.hand_id::text || 'ch') % 3 end,
         case when pg_temp.r(d.ord, a.hand_id::text || 'fl') % 5 = 0 then '[{"code":"overbet","severity":"note"}]'::jsonb
              when pg_temp.r(d.ord, a.hand_id::text || 'fl') % 5 = 1 then '[{"code":"thin-value","severity":"inaccurate"}]'::jsonb
              else '[]'::jsonb end,
         case pg_temp.r(d.ord, a.hand_id::text || 'fl') % 5 when 0 then 'note' when 1 then 'inaccurate' end,
         pg_temp.r(d.ord, a.hand_id::text || 'fb') % 2 = 0, 12.5, 0.6,
         case when d.ord = 0
              then jsonb_build_object('chart', jsonb_build_object(
                     'set', (array['cash-6max', 'mtt'])[1 + pg_temp.r(d.ord, a.hand_id::text || 'cs') % 2],
                     'line', (array['r', '', 'rc'])[1 + pg_temp.r(d.ord, a.hand_id::text || 'cl') % 3],
                     'scenario', 'open', 'inRange', true),
                   'handClass', 'AKo', 'position', 'BTN')
              else '{}'::jsonb end
  from public.hand_analysis a
  cross join (values (0), (1), (2)) d(ord)
  where a.owner_id = p_owner;

  insert into public.drill_items (owner_id, hand_id, action_index, analysis_version, ord, street, spot_key, source_grade,
                                  source_ev_loss_bb, due_at, reps, reviews, interval_days)
  select d.owner_id, d.hand_id, d.action_index, d.analysis_version, d.ord, d.street,
         d.street || '|' || d.scenario || '||BTN|' || d.action || '|call', d.grade, coalesce(d.ev_loss_bb, 0),
         now() + make_interval(hours => (pg_temp.r(d.ord, d.hand_id::text || 'due') % 96) - 48),
         pg_temp.r(d.ord, d.hand_id::text || 'rp') % 2, pg_temp.r(d.ord, d.hand_id::text || 'rv') % 3,
         (pg_temp.r(d.ord, d.hand_id::text || 'iv') % 40)
  from public.decision_analysis d
  where d.owner_id = p_owner and d.analysis_version = 'analysis/7' and d.grade in ('mistake', 'blunder')
    and pg_temp.r(d.ord, d.hand_id::text || 'dr') % 2 = 0;

  insert into public.trainer_results (owner_id, mode, family, spot, position, hand_class, grade, ev_loss_bb, ev_loss_pot, score, created_at)
  select p_owner, (array['preflop', 'river', 'drill'])[1 + i % 3], 'open', 'spot' || (i % 5), 'BTN', 'AKo',
         (array['perfect', 'good', 'mistake'])[1 + i % 3], (i % 7) / 10.0, 0.01, 50 + i % 50, now() - make_interval(days => i % 90)
  from generate_series(1, p_n / 4) i;
$$;

select pg_temp.make('00000000-0000-0000-0000-0000000081a1', 700, 'one');
select pg_temp.make('00000000-0000-0000-0000-0000000081b1', 160, 'two');

set local session_replication_role = origin;
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-0000000081a1');
select public.analysis_leak_summaries_rebuild('00000000-0000-0000-0000-0000000081b1');
-- The library's counts too: coverage and "analyse my newest" read them.
select public.library_counts_rebuild('00000000-0000-0000-0000-0000000081a1');
select public.library_counts_rebuild('00000000-0000-0000-0000-0000000081b1');
analyze public.hands;
analyze public.hand_analysis;
analyze public.decision_analysis;

-- ---------------------------------------------------------------------------
-- 2. The previous bodies
-- ---------------------------------------------------------------------------

create temp table undo (fn text primary key, back text[]);
insert into undo values
  ('analysis_scope', array[
    $n$AS $function$
declare
  v_owner     uuid := auth.uid();
$n$,
    $o$AS $function$
declare
$o$,
    $n$  join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
  where a.owner_id = v_owner
$n$,
    $o$  join public.hands h on h.id = a.hand_id
  where a.owner_id = (select auth.uid())
$o$,
    $n$          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner
            and d.street = p_filters ->> 'street'))$n$,
    $o$          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
            and d.street = p_filters ->> 'street'))$o$,
    $n$          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner
            and d.flags @>$n$,
    $o$          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version
            and d.flags @>$o$]),
  ('analysis_overview', array[
    $n$  v_owner   uuid := auth.uid();$n$,
    $o$  v_owner   uuid := (select auth.uid());$o$,
    $n$    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner
  ),$n$,
    $o$    from public.decision_analysis dd
    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
  ),$o$]),
  ('analysis_breakdown', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$    join public.hands h on h.id = dd.hand_id and h.owner_id = v_owner
    where dd.owner_id = v_owner
      and (p_group <> 'preflop_scenario' or dd.street = 'preflop')
$n$,
    $o$    join public.hands h on h.id = dd.hand_id
    where p_group <> 'preflop_scenario' or dd.street = 'preflop'
$o$]),
  ('analysis_hands', array[
    $n$  v_owner  uuid := auth.uid();$n$,
    $o$  v_owner  uuid := (select auth.uid());$o$,
    $n$          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)$n$,
    $o$          where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version), '[]'::jsonb)$o$,
    $n$    from public.analysis_scope(p_filters) a
    join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
$n$,
    $o$    from public.analysis_scope(p_filters) a
    join public.hands h on h.id = a.hand_id
$o$]),
  ('analysis_hand', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$      where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version and d.owner_id = v_owner), '[]'::jsonb)$n$,
    $o$      where d.hand_id = a.hand_id and d.analysis_version = a.analysis_version), '[]'::jsonb)$o$]),
  ('analysis_node_actions', array[
    $n$  v_owner   uuid := auth.uid();$n$,
    $o$  v_owner   uuid := (select auth.uid());$o$,
    $n$    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner
      and dd.street = 'preflop'
$n$,
    $o$    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.street = 'preflop'
$o$,
    $n$    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner and dd.street <> 'preflop' and dd.status = 'analysed'
$n$,
    $o$    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.street <> 'preflop' and dd.status = 'analysed'
$o$,
    $n$    join public.hands h on h.id = a.hand_id and h.owner_id = v_owner
    where a.owner_id = v_owner
$n$,
    $o$    join public.hands h on h.id = a.hand_id
    where a.owner_id = v_owner
$o$,
    $n$        where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version and dd.owner_id = v_owner
          and dd.street = 'preflop'$n$,
    $o$        where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version
          and dd.street = 'preflop'$o$]),
  ('analysis_node_hands', array[
    $n$  v_owner  uuid := auth.uid();$n$,
    $o$  v_owner  uuid := (select auth.uid());$o$,
    $n$    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.owner_id = v_owner
      and dd.street = 'preflop'
$n$,
    $o$    join s on s.hand_id = dd.hand_id and s.analysis_version = dd.analysis_version
    where dd.street = 'preflop'
$o$,
    $n$    from m
    join public.hands h on h.id = m.hand_id and h.owner_id = v_owner
$n$,
    $o$    from m
    join public.hands h on h.id = m.hand_id
$o$]),
  ('analysis_leaks', array[
    $n$  v_owner   uuid := auth.uid();$n$,
    $o$  v_owner   uuid := (select auth.uid());$o$,
    $n$      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version and dd.owner_id = v_owner
$n$,
    $o$      on dd.hand_id = d.hand_id and dd.ord = d.ord and dd.analysis_version = v_version
$o$]),
  ('analysis_leak_hands', array[
    $n$  v_owner  uuid := auth.uid();$n$,
    $o$  v_owner  uuid := (select auth.uid());$o$,
    $n$    from m
    join public.hands h on h.id = m.hand_id and h.owner_id = v_owner
$n$,
    $o$    from m
    join public.hands h on h.id = m.hand_id
$o$,
    $n$            and dd.analysis_version = public.analysis_version_of(p_filters) and dd.owner_id = v_owner), '[]'::jsonb)$n$,
    $o$            and dd.analysis_version = public.analysis_version_of(p_filters)), '[]'::jsonb)$o$]),
  ('analysis_trend', array[
    $n$  v_owner   uuid := auth.uid();$n$,
    $o$  v_owner   uuid := (select auth.uid());$o$,
    $n$    join public.hands h on h.id = s.hand_id and h.owner_id = v_owner
    where v_bucket = 'session'$n$,
    $o$    join public.hands h on h.id = s.hand_id
    where v_bucket = 'session'$o$]),
  ('analysis_coverage', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$              where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version) as is_current,$n$,
    $o$              where a.hand_id = hd.id and a.analysis_version = p_version) as is_current,$o$,
    $n$              where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version <> p_version) as has_old$n$,
    $o$              where a.hand_id = hd.id and a.analysis_version <> p_version) as has_old$o$]),
  ('hands_needing_analysis', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$      where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)$n$,
    $o$      where a.hand_id = hd.id and a.analysis_version = p_version)$o$]),
  ('hands_needing_analysis_recent', array[
    $n$  v_owner  uuid := auth.uid();$n$,
    $o$  v_owner  uuid := (select auth.uid());$o$,
    $n$      where a.hand_id = hd.id and a.owner_id = v_owner and a.analysis_version = p_version)$n$,
    $o$      where a.hand_id = hd.id and a.analysis_version = p_version)$o$]),
  ('drill_queue', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)$n$,
    $o$        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord)$o$]),
  ('drill_summary', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$      where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
        and d.owner_id = v_owner);$n$,
    $o$      where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord);$o$]),
  ('drill_due_by_spot', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$,
    $n$        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord
          and d.owner_id = v_owner)$n$,
    $o$        where d.hand_id = di.hand_id and d.analysis_version = di.analysis_version and d.ord = di.ord)$o$]),
  ('trainer_summary', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$]),
  ('study_plan', array[
    $n$  v_owner uuid := auth.uid();$n$,
    $o$  v_owner uuid := (select auth.uid());$o$]),
  ('analysis_leak_examples', array[
    $n$  v_owner    uuid := auth.uid();$n$,
    $o$  v_owner    uuid := (select auth.uid());$o$,
    $n$        on dd.hand_id = p.hand_id and dd.analysis_version = v_version and dd.ord = p.ord and dd.owner_id = v_owner
$n$,
    $o$        on dd.hand_id = p.hand_id and dd.analysis_version = v_version and dd.ord = p.ord
$o$]);

-- Since `20270825090000_analysis_screen_summaries.sql` most of these readers
-- answer from sums, so their `20270818090000` definitions - what the edits
-- are undone from - are read elsewhere: those that still fall back to it
-- keep it as `<reader>_scan`; the others' are kept here, verbatim. The
-- comparison below then holds the summed readers to the bodies before
-- `20270818090000` as well.
create temp table defs (fn text primary key, def text);
insert into defs
select replace(p.proname, '_scan', ''),
       replace(pg_get_functiondef(p.oid), 'FUNCTION public.' || p.proname || '(',
               'FUNCTION public.' || replace(p.proname, '_scan', '') || '(')
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('analysis_overview_scan', 'analysis_breakdown_scan', 'analysis_node_actions_scan',
                    'analysis_node_hands_scan', 'analysis_leaks_scan', 'analysis_leak_hands_scan',
                    'analysis_trend_scan', 'hands_needing_analysis_recent_scan');
insert into defs values
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
$d$);

-- The current definition with each edit undone: (new, old) pairs, each of
-- which must be found. Calls of the rewritten helpers go to their previous
-- bodies too.
create function pg_temp.previous(p_fn text, p_back text[]) returns text language plpgsql as $$
declare
  v_def text;
  i     integer;
begin
  v_def := (select d.def from defs d where d.fn = p_fn);
  if v_def is null then
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  end if;
  for i in 1 .. coalesce(array_length(p_back, 1), 0) by 2 loop
    if position(p_back[i] in v_def) = 0 then
      return p_fn || ': an edit is not in the current definition: ' || left(p_back[i], 80);
    end if;
    v_def := replace(v_def, p_back[i], p_back[i + 1]);
  end loop;
  v_def := replace(v_def, 'CREATE OR REPLACE FUNCTION public.', 'CREATE FUNCTION pg_temp.old_');
  v_def := replace(v_def, 'public.analysis_scope(', 'pg_temp.old_analysis_scope(');
  v_def := replace(v_def, 'public.analysis_graded_decisions(', 'pg_temp.old_analysis_graded_decisions(');
  v_def := replace(v_def, 'public.analysis_graded_facets(', 'pg_temp.old_analysis_graded_facets(');
  v_def := replace(v_def, 'public.analysis_leak_sample(', 'pg_temp.old_analysis_leak_sample(');
  execute v_def;
  return null;
end;
$$;

-- (Their helpers' previous bodies are made below.)
set local check_function_bodies = off;

CREATE FUNCTION pg_temp.old_analysis_graded_decisions(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(hand_id uuid, ord smallint, action_index integer, played_at timestamp with time zone, hero_position text, pot_type text, street text, scenario text, line text, "position" text, taken text, best text, spot_key text, source text, grade text, score numeric, ev_loss_bb numeric, ev_loss_pot numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select x.hand_id, x.ord, x.action_index, x.played_at, x.hero_position, x.pot_type,
         x.street, x.scenario, x.line, x.pos, x.taken, x.best,
         public.analysis_spot_key(x.street, x.scenario, x.line, x.pos, x.taken, x.best),
         x.source, x.grade, x.score, x.ev_loss_bb, x.ev_loss_pot
  from (
    select dd.hand_id,
           dd.ord,
           dd.action_index,
           h.played_at,
           h.hero_position,
           s.pot_type,
           dd.street,
           dd.scenario,
           case when dd.source = 'chart' and coalesce(dd.facts -> 'chart' ->> 'line', '') ~ '^[fkcra]{0,24}$'
                then coalesce(dd.facts -> 'chart' ->> 'line', '') else '' end as line,
           case when coalesce(dd.facts ->> 'position', h.hero_position, '') ~ '^[A-Z0-9+]{0,8}$'
                then coalesce(dd.facts ->> 'position', h.hero_position, '') else '' end as pos,
           dd.action as taken,
           coalesce(public.analysis_best_action(dd.options), '') as best,
           dd.source,
           dd.grade,
           dd.score,
           coalesce(dd.ev_loss_bb, 0) as ev_loss_bb,
           coalesce(dd.ev_loss_pot, 0) as ev_loss_pot
    from pg_temp.old_analysis_scope(p_filters) s
    join public.decision_analysis dd on dd.hand_id = s.hand_id and dd.analysis_version = s.analysis_version
    join public.hands h on h.id = s.hand_id
    where dd.grade is not null
  ) x;
$function$;

CREATE FUNCTION pg_temp.old_analysis_graded_facets(p_version text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with f as materialized (
    select h.site, h.currency, h.currency_minor_units, h.small_blind, h.big_blind, h.played_at
    from public.hand_analysis a
    join public.hands h on h.id = a.hand_id
    where a.owner_id = (select auth.uid())
      and a.analysis_version = p_version
      and exists (
        select 1 from public.decision_analysis dd
        where dd.hand_id = a.hand_id and dd.analysis_version = a.analysis_version and dd.grade is not null)
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
    'last',  (select max(played_at) from f));
$function$;

CREATE FUNCTION pg_temp.old_analysis_leak_sample(p_owner uuid, p_version text, p_format text, p_position text, p_pot text, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'hands', coalesce((
      select sum(hands)::bigint from public.analysis_leak_day_hands
      where owner_id = p_owner and analysis_version = p_version
        and (p_from is null or day >= p_from) and (p_to is null or day <= p_to)
        and (p_format is null or game_format = p_format)
        and (p_position is null or hero_position = p_position)
        and (p_pot is null or pot_type = p_pot)), 0),
    'graded', coalesce(sum(x.n), 0),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
              'key',        x.spot_key,
              'set',        nullif(x.chart_set, ''),
              'street',     split_part(x.spot_key, '|', 1),
              'scenario',   split_part(x.spot_key, '|', 2),
              'line',       split_part(x.spot_key, '|', 3),
              'position',   split_part(x.spot_key, '|', 4),
              'taken',      split_part(x.spot_key, '|', 5),
              'best',       split_part(x.spot_key, '|', 6),
              'decisions',  x.n,
              'hands',      x.n,
              'nonPerfect', x.non_perfect,
              'mistakes',   x.mistakes,
              'evLossBb',   round(x.ev_bb, 3),
              'evLossPot',  round(x.ev_pot, 4),
              'scoreSum',   round(x.score_sum, 2),
              'scoreSq',    round(x.score_sq, 2))
            order by x.spot_key, nullif(x.chart_set, '') nulls first), '[]'::jsonb))
  from (
    select spot_key, chart_set,
           sum(decisions)::bigint as n, sum(non_perfect)::bigint as non_perfect, sum(mistakes)::bigint as mistakes,
           sum(ev_loss_bb) as ev_bb, sum(ev_loss_pot) as ev_pot, sum(score_sum) as score_sum, sum(score_sq) as score_sq
    from public.analysis_leak_days
    where owner_id = p_owner and analysis_version = p_version
      and (p_from is null or day >= p_from) and (p_to is null or day <= p_to)
      and (p_format is null or game_format = p_format)
      and (p_position is null or hero_position = p_position)
      and (p_pot is null or pot_type = p_pot)
    group by spot_key, chart_set
  ) x;
$function$;

CREATE FUNCTION pg_temp.old_get_hand(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select to_jsonb(h) from public.hands h where h.id = p_id;
$function$;

CREATE FUNCTION pg_temp.old_my_post_state(p_public_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'saved', exists (select 1 from public.saved_posts s where s.post_id = p.id),
    'subscription', (select t.level from public.thread_subscriptions t where t.post_id = p.id)
  )
  from public.posts p
  where p.public_id = p_public_id;
$function$;

CREATE FUNCTION pg_temp.old_my_saved_posts(p_limit integer DEFAULT 25, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(public.forum_post_json(p) || jsonb_build_object('savedAt', s.created_at)
                            order by s.created_at desc), '[]'::jsonb)
  from (
    select * from public.saved_posts
    where (p_before is null or created_at < p_before)
    order by created_at desc
    limit least(greatest(coalesce(p_limit, 25), 1), 50)
  ) s
  join public.posts p on p.id = s.post_id;
$function$;

CREATE FUNCTION pg_temp.old_my_notifications(p_limit integer DEFAULT 30, p_before bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'unread', (select count(*) from public.notifications where read_at is null),
    'items', coalesce(jsonb_agg(jsonb_build_object(
        'id', n.id,
        'kind', n.kind,
        'createdAt', n.created_at,
        'read', n.read_at is not null,
        'actor', (select jsonb_build_object('username', a.username) from public.profiles_public a where a.id = n.actor_id),
        'post', jsonb_build_object('publicId', p.public_id, 'slug', p.slug, 'title', p.title,
                                   'board', (select b.slug from public.boards b where b.id = p.board_id)),
        'seq', c.seq,
        'excerpt', left(c.body, 160)
      ) order by n.id desc), '[]'::jsonb)
  )
  from (
    select * from public.notifications
    where (p_before is null or id < p_before)
    order by id desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) n
  join public.posts p on p.id = n.post_id
  left join public.comments c on c.id = n.comment_id;
$function$;

CREATE FUNCTION pg_temp.old_unread_notification_count()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select count(*)::integer from public.notifications where read_at is null;
$function$;

select is(
  (select array_agg(m order by m) from (select pg_temp.previous(u.fn, u.back) as m from undo u order by u.fn = 'analysis_scope' desc, u.fn) x
    where m is not null),
  null,
  'every edit of the migration is found in the current definitions (the previous bodies are rebuilt from them)');
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The same answers
-- ---------------------------------------------------------------------------

create temp table filters (i integer, f jsonb);
insert into filters values
  (1, '{"analysisVersion":"analysis/7"}'),
  (2, '{"analysisVersion":"analysis/6"}'),
  (3, '{"analysisVersion":"analysis/7","gameFormat":"cash","position":"BTN"}'),
  (4, '{"analysisVersion":"analysis/7","potType":"3bet","street":"flop"}'),
  (5, '{"analysisVersion":"analysis/7","flag":"overbet","minGrade":"mistake"}'),
  (6, '{"analysisVersion":"analysis/7","from":"2026-01-10T00:00:00Z","to":"2026-01-20T00:00:00Z","site":"pokerstars"}'),
  (7, '{"analysisVersion":"analysis/7","grade":"blunder","flagged":"true","status":"full"}'),
  (8, '{"analysisVersion":"analysis/7","currency":"usd","bigBlind":"10"}'),
  (9, '{}');

-- (reader, new call, previous call): every reader, a few arguments each.
create temp table calls (n serial, reader text, sql_new text, sql_old text);
create function pg_temp.call(p_reader text, p_args text) returns void language sql as $$
  insert into calls (reader, sql_new, sql_old)
  values (p_reader, format('select public.%s(%s)', p_reader, p_args), format('select pg_temp.old_%s(%s)', p_reader, p_args));
$$;
select pg_temp.call('analysis_overview', quote_literal(f) || '::jsonb') from filters;
select pg_temp.call('analysis_breakdown', quote_literal(f) || '::jsonb, ' || quote_literal(g))
  from filters, unnest(array['street', 'position', 'pot_type', 'scenario', 'preflop_scenario']) g where filters.i % 2 = 0;
select pg_temp.call('analysis_hands', quote_literal(f) || '::jsonb, ' || quote_literal(s) || ', 25, ' || o)
  from filters, unnest(array['recent', 'oldest', 'flags', 'ev_loss', 'ev_loss_pot', 'score', 'result']) s, (values (0), (20)) v(o)
  where filters.i % 3 = 0;
select pg_temp.call('analysis_node_actions', quote_literal(f) || '::jsonb') from filters;
select pg_temp.call('analysis_node_hands', quote_literal(f) || '::jsonb, array[''cash-6max:r'', ''cash-6max:'', ''mtt:rc''], '
                    || coalesce(quote_literal(a), 'null') || ', ' || d || ', ' || quote_literal(s) || ', 10, 0')
  from filters, (values ('raise'), (null), ('fold')) x(a), (values (true), (false)) y(d),
       unnest(array['ev_loss', 'recent', 'oldest', 'ev_loss_pot']) s
  where filters.i % 4 = 0;
select pg_temp.call('analysis_leaks', quote_literal(f) || '::jsonb') from filters;
select pg_temp.call('analysis_leak_hands', quote_literal(f) || '::jsonb, (select array_agg(distinct spot_key) from public.analysis_leak_rows), '
                    || d || ', ' || quote_literal(s) || ', 15, 0')
  from filters, (values (true), (false)) y(d), unnest(array['ev_loss', 'recent', 'oldest']) s
  where filters.i % 2 = 1;
select pg_temp.call('analysis_trend', quote_literal(f) || '::jsonb, ' || quote_literal(b) || ', ' || quote_literal(g) || ', 45')
  from filters, unnest(array['week', 'month', 'session']) b, unnest(array['all', 'street', 'position', 'pot_type']) g
  where filters.i % 3 = 1;
select pg_temp.call('analysis_leak_examples', quote_literal(f) || '::jsonb, ' || fr || ', ' || tt
                    || ', (select jsonb_agg(jsonb_build_object(''id'', k, ''keys'', jsonb_build_array(k))) from (select distinct spot_key k from public.analysis_leak_rows order by 1 limit 8) z), 5')
  from filters, (values ('null', 'null'), ('''2026-02-01''::date', '''2026-04-30''::date')) v(fr, tt);
select pg_temp.call('analysis_coverage', quote_literal(v)) from unnest(array['analysis/7', 'analysis/6', 'analysis/1']) v;
select pg_temp.call('analysis_graded_facets', quote_literal(v)) from unnest(array['analysis/7', 'analysis/6']) v;
select pg_temp.call('analysis_hand', quote_literal(h.id) || '::uuid, ''analysis/7''')
  from (select id from public.hands order by hand_key limit 40) h;
select pg_temp.call('get_hand', quote_literal(h.id) || '::uuid')
  from (select id from public.hands order by hand_key limit 40) h;
select pg_temp.call('drill_queue', '''analysis/7'', ' || k || ', ' || d || ', 50')
  from (values ('null'), ('(select array_agg(distinct spot_key) from public.drill_items)')) x(k), (values (true), (false)) y(d);
select pg_temp.call('drill_summary', '''analysis/7'', null');
select pg_temp.call('drill_due_by_spot', '''analysis/7'', null');
select pg_temp.call('trainer_summary', d::text) from unnest(array[1, 30, 3650]) d;
select pg_temp.call('study_plan', '''' || public.study_week() || '''::date, null');
select pg_temp.call('my_notifications', '30, null');
select pg_temp.call('unread_notification_count', '');
select pg_temp.call('my_saved_posts', '25, null');
select pg_temp.call('my_post_state', '''nosuch''');

grant select on calls, filters to authenticated;

create temp table differ (account text, n integer, reader text, sql text);
grant all on differ to authenticated;

create function pg_temp.compare(p_account text) returns void language plpgsql as $$
declare
  c record;
  v_new jsonb;
  v_old jsonb;
begin
  for c in select * from calls order by n loop
    execute 'select to_jsonb(x.v) from (' || c.sql_new || ') x(v)' into v_new;
    execute 'select to_jsonb(x.v) from (' || c.sql_old || ') x(v)' into v_old;
    if v_new is distinct from v_old then
      insert into differ values (p_account, c.n, c.reader, c.sql_new);
    end if;
  end loop;
end;
$$;
grant execute on function pg_temp.compare(text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000081a1');
select pg_temp.compare('one');
select is((select array_agg(reader || ': ' || sql order by n) from differ where account = 'one'), null,
          'every reader answers as its previous body (first account)');
select ok((public.analysis_overview('{"analysisVersion":"analysis/7"}') ->> 'hands')::int > 500
          and jsonb_array_length(public.analysis_leaks('{"analysisVersion":"analysis/7"}') -> 'rows') > 10
          and jsonb_array_length(public.drill_queue('analysis/7', null, false, 50)) > 10
          and jsonb_array_length(public.analysis_trend('{"analysisVersion":"analysis/7"}', 'session', 'all', 45) -> 'rows') > 3,
          '... over graded hands, leaks, drill items and sessions (the comparisons compare something)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000081b1');
select pg_temp.compare('two');
select is((select array_agg(reader || ': ' || sql order by n) from differ where account = 'two'), null,
          'every reader answers as its previous body (second account)');
select is((public.analysis_overview('{"analysisVersion":"analysis/7"}') ->> 'hands')::int,
          (select count(*)::int from public.hand_analysis where analysis_version = 'analysis/7'),
          '... its own graded hands only');

select pg_temp.as_postgres();
select ok((select count(*) from calls) > 300, 'many calls compared: ' || (select count(*) from calls));

-- R5.2's sample: the owner argument must be the caller (the policy's answer
-- for anyone else was nothing). Its previous body read R5.2's daily sums,
-- which `20270825090000` replaced; the top three's equality with the leak
-- finder (whose previous body is compared above) is `leak_summaries`'.
select pg_temp.act_as('00000000-0000-0000-0000-0000000081b1');
select is(public.analysis_leak_sample('00000000-0000-0000-0000-0000000081a1', 'analysis/7', null, null, null, null, null),
          '{"hands": 0, "graded": 0, "rows": []}'::jsonb,
          'analysis_leak_sample: another account''s owner reads nothing, as before');
select is((public.analysis_leak_sample('00000000-0000-0000-0000-0000000081b1', 'analysis/7', 'cash', null, null, null, null) ->> 'graded')::int,
          (pg_temp.old_analysis_leaks('{"analysisVersion":"analysis/7","gameFormat":"cash"}') ->> 'graded')::int,
          'analysis_leak_sample: the caller''s own sample, its graded decisions the leak finder''s');

select * from finish();
rollback;
