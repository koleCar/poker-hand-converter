-- pgTAP: the library's counts (`20270818090000_big_account_readers.sql`).
--
-- What has to hold:
--
--   * the triggers keep `library_hand_counts` / `library_hero_counts`
--     exactly what `library_counts_rebuild` counts from the rows, through
--     every write path: hands arriving, hero and villain statistics rows, EV
--     rows before and after their hero row, a version pruned, EV rows
--     deleted, an UPDATE by hand; a hand deleted while its account stays
--     marks the account stale (and its readers read the hands); an account
--     deleted takes its counts with it;
--   * `library_facets` answers as its previous body (kept here as a pg_temp
--     copy, over the same `library_rows`) on random filters - groups,
--     versions, ranges whole and partial (UTC month bounds included), hands
--     without a time, the searches - for two accounts, and stale;
--   * an unfiltered call reads no hand, statistics or EV row;
--   * R2.9's readers and `hands_facets` are gone; the table-name index
--     leads with the owner;
--   * owner only, anon refused.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(43);

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('00000000-0000-0000-0000-0000000071a1', 'counts.one@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000071b1', 'counts.two@example.com', now(), now()),
  ('00000000-0000-0000-0000-0000000071c1', 'counts.gone@example.com', now(), now());

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

create function pg_temp.r(p_i integer, p_salt text) returns integer language sql immutable as $$
  select abs(hashtext(p_i::text || ':' || p_salt));
$$;

-- ---------------------------------------------------------------------------
-- 1. Retired, and the index
-- ---------------------------------------------------------------------------

select hasnt_function('public', 'stats_summary', array['jsonb'], 'stats_summary is retired');
select hasnt_function('public', 'stats_graph', array['jsonb', 'integer'], 'stats_graph is retired');
select hasnt_function('public', 'stats_breakdown', array['jsonb', 'text'], 'stats_breakdown is retired');
select hasnt_function('public', 'stats_sessions', array['jsonb', 'integer'], 'stats_sessions is retired');
select hasnt_function('public', 'hands_facets', array[]::text[], 'hands_facets is retired');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('hand_stats_filter_sql', 'hand_stats_counter_keys', 'hand_stats_money_keys', 'stats_empty_summary')),
  null, 'their helpers are retired with them');
select is(
  (select a.attname::text from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indexrelid = 'public.hands_owner_table_idx'::regclass),
  'owner_id', 'the table-name index leads with the owner');
select hasnt_index('public', 'hands', 'hands_table_trgm', 'the global table-name trigram index (unusable under RLS) is gone');

-- ---------------------------------------------------------------------------
-- 2. The data, written through the triggers
-- ---------------------------------------------------------------------------
--
-- Hands over fourteen months (some exactly on a UTC month's first instant,
-- some without a time), hero rows at two versions, villains, EV rows at two
-- versions (some on a villain's seat, some written before their hero row).

create function pg_temp.add_hands(p_owner uuid, p_from integer, p_to integer, p_tag text) returns void language sql as $$
  insert into public.hands (owner_id, hand_key, phf, standard_text, site, game_format, variant, limit_type,
                            currency, currency_minor_units, currency_symbol, small_blind, big_blind,
                            max_seats, player_count, played_at, hero_name, hero_seat, hero_position, hero_cards,
                            hero_hand_class, board_cards, player_names, showdown_positions, winner_positions,
                            went_to_showdown, total_pot, hero_profit, table_name, site_anonymization)
  select p_owner, p_tag || ':' || i, '{"schema":"phf/1"}', 'std',
         (array['pokerstars', 'ggpoker', 'winamax'])[1 + pg_temp.r(i, p_tag || 's') % 3],
         case when pg_temp.r(i, p_tag || 'f') % 5 = 0 then 'tournament' else 'cash' end::public.game_format,
         case pg_temp.r(i, p_tag || 'v') % 5 when 0 then 'omaha' when 1 then null else 'holdem' end,
         case pg_temp.r(i, p_tag || 'v') % 5 when 0 then 'pl' when 1 then null else 'nl' end,
         case when pg_temp.r(i, p_tag || 'c') % 6 = 0 then 'EUR' else 'USD' end, 100,
         case when pg_temp.r(i, p_tag || 'y') % 4 = 0 then null when pg_temp.r(i, p_tag || 'c') % 6 = 0 then '€' else '$' end,
         case when pg_temp.r(i, p_tag || 'b') % 11 = 0 then null else (array[1, 5, 10])[1 + pg_temp.r(i, p_tag || 'b') % 3] end,
         case when pg_temp.r(i, p_tag || 'b') % 11 = 0 then null else (array[2, 10, 20])[1 + pg_temp.r(i, p_tag || 'b') % 3] end,
         case when pg_temp.r(i, p_tag || 'm') % 9 = 0 then null else (array[2, 6, 9])[1 + pg_temp.r(i, p_tag || 'm') % 3] end,
         2 + pg_temp.r(i, p_tag || 'pc') % 7,
         case when pg_temp.r(i, p_tag || 't') % 19 = 0 then null
              -- a few exactly on a month's first instant (UTC)
              when pg_temp.r(i, p_tag || 't') % 23 = 0
                then timestamptz '2025-11-01 00:00:00+00' + make_interval(months => pg_temp.r(i, p_tag || 'mo') % 14)
              else timestamptz '2025-11-01 00:00:00+00' + make_interval(mins => pg_temp.r(i, p_tag || 'ts') % (60 * 24 * 425)) end,
         'Hero', 0,
         case when pg_temp.r(i, p_tag || 'p') % 8 = 0 then null
              else (array['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO', 'MP'])[1 + pg_temp.r(i, p_tag || 'p') % 7] end,
         array['Ah', 'Kd'], 'AKo',
         case when pg_temp.r(i, p_tag || 'd') % 3 = 0 then '{}'::text[] else array['2c', '7d', 'Ks'] end,
         case when pg_temp.r(i, p_tag || 'a') % 7 = 0 then '{}'::text[] else array['Hero', 'v' || (pg_temp.r(i, p_tag || 'o') % 9)] end,
         case when pg_temp.r(i, p_tag || 'w') % 3 = 0 then array['BTN', 'BB'] else '{}' end,
         array['BTN'],
         pg_temp.r(i, p_tag || 'w') % 3 = 0,
         100 + pg_temp.r(i, p_tag || 'q') % 900,
         case when pg_temp.r(i, p_tag || 'e') % 13 = 0 then null
              when pg_temp.r(i, p_tag || 'e') % 13 = 1 then 0
              else (pg_temp.r(i, p_tag || 'q') % 400) - 200 end,
         case pg_temp.r(i, p_tag || 'n') % 10
           when 0 then null
           when 1 then 'Big_Game ' || (pg_temp.r(i, p_tag || 'n') % 7) || '%'
           when 2 then 'Back\slash ' || (pg_temp.r(i, p_tag || 'n') % 3)
           else 'Table ' || (pg_temp.r(i, p_tag || 'n') % 30) end,
         case when pg_temp.r(i, p_tag || 'a') % 7 = 0 then 'positional' else 'none' end::public.site_anonymization
  from generate_series(p_from, p_to) i;
$$;

create function pg_temp.add_stats(p_owner uuid, p_tag text, p_version text, p_pick integer, p_villains boolean) returns void language sql as $$
  insert into public.hand_stats (hand_id, owner_id, stats_version, seat, hand_key, site_id, is_hero, player, position,
                                 hands, game_format, site_anonymization, currency, currency_minor_units,
                                 big_blind, played_at, won, contributed, net, net_bb_milli, pot_type,
                                 starting_stack_bb_tenths)
  select h.id, h.owner_id, p_version, s.seat, h.hand_key, h.site, s.seat = 0,
         case when s.seat = 0 then 'Hero' else h.player_names[2] end,
         case when s.seat = 0 then h.hero_position else 'BB' end,
         1, h.game_format, h.site_anonymization, h.currency, 100, h.big_blind, h.played_at,
         0, 0, 0, 0,
         case when pg_temp.r(5, h.hand_key || p_version) % 7 = 0 then null
              else (array['limped', 'single-raised', '3bet', '4bet+', 'walk'])[1 + pg_temp.r(1, h.hand_key || p_version) % 5] end,
         case when pg_temp.r(6, h.hand_key || p_version) % 9 = 0 then null
              else (array[150, 399, 400, 799, 800, 1199, 1200, 3000])[1 + pg_temp.r(2, h.hand_key || p_version) % 8] end
  from public.hands h
  cross join (values (0), (1)) s(seat)
  where h.owner_id = p_owner and h.hand_key like p_tag || ':%'
    and pg_temp.r(7, h.hand_key || p_version) % 10 < p_pick
    and (s.seat = 0 or (p_villains and h.site_anonymization = 'none' and cardinality(h.player_names) = 2))
  on conflict do nothing;
$$;

create function pg_temp.add_ev(p_owner uuid, p_tag text, p_version text, p_salt text, p_pick integer) returns void language sql as $$
  insert into public.hand_stats_ev (hand_id, owner_id, seat, ev_version, hand_key, applicable, ev_net, ev_net_bb_milli)
  select h.id, h.owner_id, s.seat, p_version, h.hand_key, pg_temp.r(3, h.hand_key || p_salt) % 3 = 0, 5, 50
  from public.hands h
  cross join (values (0), (1)) s(seat)
  where h.owner_id = p_owner and h.hand_key like p_tag || ':%'
    and pg_temp.r(4, h.hand_key || p_salt || s.seat) % 10 < p_pick
  on conflict do nothing;
$$;

-- Two accounts. EV rows at ev/1 for some hands first, then the statistics,
-- then EV rows at ev/1 (the rest) and ev/2.
select pg_temp.add_hands('00000000-0000-0000-0000-0000000071a1', 1, 900, 'one');
select pg_temp.add_hands('00000000-0000-0000-0000-0000000071a1', 901, 1400, 'one');
select pg_temp.add_hands('00000000-0000-0000-0000-0000000071b1', 1, 400, 'two');
select pg_temp.add_hands('00000000-0000-0000-0000-0000000071c1', 1, 50, 'gone');
select pg_temp.add_ev('00000000-0000-0000-0000-0000000071a1', 'one', 'ev/1', 'first', 3);
select pg_temp.add_stats('00000000-0000-0000-0000-0000000071a1', 'one', 'stats/1', 7, true);
select pg_temp.add_stats('00000000-0000-0000-0000-0000000071a1', 'one', 'stats/2', 5, false);
select pg_temp.add_stats('00000000-0000-0000-0000-0000000071b1', 'two', 'stats/1', 9, true);
select pg_temp.add_stats('00000000-0000-0000-0000-0000000071c1', 'gone', 'stats/1', 9, true);
select pg_temp.add_ev('00000000-0000-0000-0000-0000000071a1', 'one', 'ev/1', 'later', 6);
select pg_temp.add_ev('00000000-0000-0000-0000-0000000071a1', 'one', 'ev/2', 'two', 7);
select pg_temp.add_ev('00000000-0000-0000-0000-0000000071b1', 'two', 'ev/1', 'b', 7);
select pg_temp.add_ev('00000000-0000-0000-0000-0000000071c1', 'gone', 'ev/1', 'c', 7);

analyze public.hands;
analyze public.hand_stats;
analyze public.hand_stats_ev;

-- The counts as kept, against the counts the rebuild makes from the rows.
create function pg_temp.snapshot(p_owner uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'hand', (select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text), '[]'::jsonb)
             from public.library_hand_counts c where c.owner_id = p_owner),
    'hero', (select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text), '[]'::jsonb)
             from public.library_hero_counts c where c.owner_id = p_owner));
$$;
create function pg_temp.kept_exactly(p_owner uuid) returns boolean language plpgsql as $$
declare
  v_kept jsonb := pg_temp.snapshot(p_owner);
begin
  perform public.library_counts_rebuild(p_owner);
  return v_kept = pg_temp.snapshot(p_owner);
end;
$$;

select ok((select count(*) from public.library_hero_counts where owner_id = '00000000-0000-0000-0000-0000000071a1' and ev_version = 'ev/1') > 0,
          'the all-in pairs are counted (the check below compares something)');
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071a1'), 'kept = recounted: hands, two versions, EV before and after its hero row');
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071b1'), 'kept = recounted: the second account');
select is((select sum(hands) from public.library_hand_counts where owner_id = '00000000-0000-0000-0000-0000000071a1'),
          1400::numeric, 'every hand counted once');

-- A version pruned (the rebuild route's end), then EV rows deleted, then a
-- villain row more: each kept exactly.
delete from public.hand_stats where owner_id = '00000000-0000-0000-0000-0000000071a1' and stats_version = 'stats/2'
  and pg_temp.r(8, hand_key) % 2 = 0;
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071a1'), 'kept = recounted: hero rows pruned');
delete from public.hand_stats_ev where owner_id = '00000000-0000-0000-0000-0000000071a1' and ev_version = 'ev/1'
  and pg_temp.r(9, hand_key) % 3 = 0;
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071a1'), 'kept = recounted: EV rows deleted');
select pg_temp.add_stats('00000000-0000-0000-0000-0000000071a1', 'one', 'stats/2', 10, false);
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071a1'), 'kept = recounted: the pruned hero rows written again');
update public.hands set hero_profit = -hero_profit, hero_position = null
  where owner_id = '00000000-0000-0000-0000-0000000071b1' and pg_temp.r(10, hand_key) % 4 = 0;
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071b1'), 'kept = recounted: an UPDATE by hand recounts');

-- ---------------------------------------------------------------------------
-- 3. The same answers as the previous bodies
-- ---------------------------------------------------------------------------
--
-- `library_rows` and `library_page` as #244 left them (a table name matched
-- by `ilike` on every hand), verbatim; the previous `library_facets` reads the
-- previous `library_rows`.

CREATE FUNCTION pg_temp.old_library_rows(p_filter jsonb)
 RETURNS TABLE(id uuid, played_at timestamp with time zone, total_pot bigint, hero_profit bigint, net_bb_milli bigint, ev_net bigint, ev_net_bb_milli bigint, site text, format text, variant text, limit_type text, size text, stake text, "position" text, pot_type text, result text, stack text, all_in boolean, currency text, currency_symbol text, minor_units smallint, small_blind bigint, big_blind bigint, anonymization text, m_site boolean, m_format boolean, m_variant boolean, m_limit boolean, m_size boolean, m_stake boolean, m_position boolean, m_pot_type boolean, m_result boolean, m_stack boolean, m_all_in boolean, m_anon boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET work_mem TO '64MB'
AS $function$
declare
  v_owner      uuid    := auth.uid();
  v_filter     jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_anons      text[]  := public.library_list(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end, 'anonymizations');
  v_sd_pos     text[]  := public.library_list(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end, 'showdownPositions');
  v_win_pos    text[]  := public.library_list(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end, 'winnerPositions');
  v_table      text    := nullif(btrim(coalesce(p_filter ->> 'tableName', '')), '');
  v_min_pot    numeric := case when jsonb_typeof(p_filter -> 'minPot') = 'number' then (p_filter ->> 'minPot')::numeric end;
  v_stats      text    := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev         text    := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_sites      text[];
  v_formats    text[];
  v_variants   text[];
  v_limits     text[];
  v_sizes      text[];
  v_stakes     text[];
  v_positions  text[];
  v_pot_types  text[];
  v_results    text[];
  v_stacks     text[];
  v_cards      text[];
  v_classes    text[];
  v_board      text[];
  v_all_in     boolean;
  v_showdown   boolean;
  v_player     text    := nullif(btrim(coalesce(v_filter ->> 'player', '')), '');
  v_from       timestamptz := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to         timestamptz := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
begin
  -- A list of strings, or none (a missing key, a non-array or an empty one
  -- is "any").
  v_sites := public.library_list(v_filter, 'sites');
  v_formats := public.library_list(v_filter, 'formats');
  v_variants := public.library_list(v_filter, 'variants');
  v_limits := public.library_list(v_filter, 'limits');
  v_sizes := public.library_list(v_filter, 'sizes');
  v_stakes := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_pot_types := public.library_list(v_filter, 'potTypes');
  v_results := public.library_list(v_filter, 'results');
  v_stacks := public.library_list(v_filter, 'stacks');
  v_cards := public.library_list(v_filter, 'heroCards');
  v_classes := public.library_list(v_filter, 'heroHandClasses');
  v_board := public.library_list(v_filter, 'board');
  v_all_in   := case when jsonb_typeof(v_filter -> 'allIn') = 'boolean' then (v_filter ->> 'allIn')::boolean end;
  v_showdown := case when jsonb_typeof(v_filter -> 'showdown') = 'boolean' then (v_filter ->> 'showdown')::boolean end;

  return query
  with d as (
    select
      h.id,
      h.played_at,
      h.total_pot,
      h.hero_profit,
      hs.net_bb_milli,
      case when e.applicable then e.ev_net end as ev_net,
      case when e.applicable then e.ev_net_bb_milli end as ev_net_bb_milli,
      h.site,
      h.game_format::text as format,
      coalesce(h.variant, '') as variant,
      coalesce(h.limit_type, '') as limit_type,
      -- The helpers' rules written out: a call per row and group made the
      -- counts 2.6 times slower at 200 000 hands (they are not inlined).
      case
        when coalesce(case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end, 0) <= 2 then 'hu'
        when case when coalesce(h.max_seats, 0) >= 2 then h.max_seats else h.player_count end <= 6 then '6max'
        else 'full'
      end as size,
      case when h.game_format = 'cash' then h.currency || ':' || coalesce(h.big_blind, 0)::text else 'chips' end as stake,
      coalesce(h.hero_position, '') as "position",
      coalesce(hs.pot_type, '') as pot_type,
      case
        when h.hero_profit is null then ''
        when h.hero_profit > 0 then 'won'
        when h.hero_profit < 0 then 'lost'
        else 'even'
      end as result,
      case
        when hs.starting_stack_bb_tenths is null then ''
        when hs.starting_stack_bb_tenths < 400 then '0-40'
        when hs.starting_stack_bb_tenths < 800 then '40-80'
        when hs.starting_stack_bb_tenths < 1200 then '80-120'
        else '120+'
      end as stack,
      coalesce(e.applicable, false) as all_in,
      h.currency,
      h.currency_symbol,
      h.currency_minor_units as minor_units,
      h.small_blind,
      h.big_blind,
      h.site_anonymization::text as anonymization
    from public.hands h
    -- Owner first on every table: a join by hand alone let the planner hash
    -- every account's statistics rows.
    left join public.hand_stats hs
      on hs.hand_id = h.id and hs.owner_id = v_owner and hs.stats_version = v_stats and hs.is_hero
    left join public.hand_stats_ev e
      on e.hand_id = h.id and e.owner_id = v_owner and e.ev_version = v_ev and e.seat = hs.seat
    where h.owner_id = v_owner
      and (v_from is null or (h.played_at is not null and h.played_at >= v_from))
      and (v_to is null or (h.played_at is not null and h.played_at < v_to))
      and (cardinality(v_cards) = 0 or h.hero_cards @> v_cards)
      and (cardinality(v_classes) = 0 or h.hero_hand_class = any (v_classes))
      and (cardinality(v_board) = 0 or h.board_cards @> v_board)
      and (v_player is null or v_player = any (h.player_names))
      and (v_showdown is null or h.went_to_showdown = v_showdown)
      and (v_table is null
           or h.table_name ilike '%' || regexp_replace(v_table, '([%_\\])', '\\\1', 'g') || '%')
      and (v_min_pot is null or h.total_pot >= v_min_pot * h.currency_minor_units)
      and (cardinality(v_sd_pos) = 0 or h.showdown_positions && v_sd_pos)
      and (cardinality(v_win_pos) = 0 or h.winner_positions && v_win_pos)
  )
  select
    d.*,
    cardinality(v_sites) = 0 or d.site = any (v_sites),
    cardinality(v_formats) = 0 or d.format = any (v_formats),
    cardinality(v_variants) = 0 or d.variant = any (v_variants),
    cardinality(v_limits) = 0 or d.limit_type = any (v_limits),
    cardinality(v_sizes) = 0 or d.size = any (v_sizes),
    cardinality(v_stakes) = 0 or d.stake = any (v_stakes),
    cardinality(v_positions) = 0 or d."position" = any (v_positions),
    cardinality(v_pot_types) = 0 or d.pot_type = any (v_pot_types),
    cardinality(v_results) = 0 or d.result = any (v_results),
    cardinality(v_stacks) = 0 or d.stack = any (v_stacks),
    v_all_in is null or d.all_in = v_all_in,
    cardinality(v_anons) = 0 or d.anonymization = any (v_anons)
  from d;
end;
$function$;

CREATE FUNCTION pg_temp.old_library_page(p_filter jsonb DEFAULT '{}'::jsonb, p_after jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  v_owner  uuid := auth.uid();
  v_filter jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_sort   text := coalesce(nullif(btrim(coalesce(v_filter ->> 'sort', '')), ''), 'newest');
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_col    text;
  v_type   text;
  v_desc   boolean;
  v_op     text;
  v_dir    text;
  v_has_after boolean := jsonb_typeof(p_after) = 'object' and coalesce(p_after ->> 'id', '') <> '';
  -- The owner is bound ($4), not an InitPlan: the planner sees whose rows
  -- these are and how many.
  v_where  text := 'h.owner_id = $4';
  v_rows   jsonb;
  v_last   jsonb;
  v_more   boolean;
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  case v_sort
    when 'newest' then v_col := 'played_at';   v_type := 'timestamptz'; v_desc := true;
    when 'oldest' then v_col := 'played_at';   v_type := 'timestamptz'; v_desc := false;
    when 'pot'    then v_col := 'total_pot';   v_type := 'bigint';      v_desc := true;
    when 'won'    then v_col := 'hero_profit'; v_type := 'bigint';      v_desc := true;
    when 'lost'   then v_col := 'hero_profit'; v_type := 'bigint';      v_desc := false;
    else
      raise exception 'Unknown sort: %', v_sort using errcode = '22023';
  end case;
  v_op  := case when v_desc then '<' else '>' end;
  v_dir := case when v_desc then 'desc' else 'asc' end;

  -- The predicates, written for the groups that are set only, so the plan
  -- is the owner's index in the sort's order for the common case. Every
  -- value is read from the parameter ($1), never spliced in.
  if v_filter ? 'from' and coalesce(v_filter ->> 'from', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at >= ($1 ->> 'from')::timestamptz$w$;
  end if;
  if v_filter ? 'to' and coalesce(v_filter ->> 'to', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at < ($1 ->> 'to')::timestamptz$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'heroCards')) > 0 then
    v_where := v_where || $w$ and h.hero_cards @> public.library_list($1, 'heroCards')$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'heroHandClasses')) > 0 then
    v_where := v_where || $w$ and h.hero_hand_class = any (public.library_list($1, 'heroHandClasses'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'board')) > 0 then
    v_where := v_where || $w$ and h.board_cards @> public.library_list($1, 'board')$w$;
  end if;
  if coalesce(btrim(v_filter ->> 'player'), '') <> '' then
    v_where := v_where || $w$ and btrim($1 ->> 'player') = any (h.player_names)$w$;
  end if;
  if jsonb_typeof(v_filter -> 'showdown') = 'boolean' then
    v_where := v_where || $w$ and h.went_to_showdown = ($1 ->> 'showdown')::boolean$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'sites')) > 0 then
    v_where := v_where || $w$ and h.site = any (public.library_list($1, 'sites'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'formats')) > 0 then
    v_where := v_where || $w$ and h.game_format::text = any (public.library_list($1, 'formats'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'variants')) > 0 then
    v_where := v_where || $w$ and coalesce(h.variant, '') = any (public.library_list($1, 'variants'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'limits')) > 0 then
    v_where := v_where || $w$ and coalesce(h.limit_type, '') = any (public.library_list($1, 'limits'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'sizes')) > 0 then
    v_where := v_where || $w$ and public.library_size(h.max_seats, h.player_count) = any (public.library_list($1, 'sizes'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'stakes')) > 0 then
    v_where := v_where || $w$ and public.library_stake(h.game_format, h.currency, h.big_blind) = any (public.library_list($1, 'stakes'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'positions')) > 0 then
    v_where := v_where || $w$ and coalesce(h.hero_position, '') = any (public.library_list($1, 'positions'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'potTypes')) > 0 then
    v_where := v_where || $w$ and coalesce(hs.pot_type, '') = any (public.library_list($1, 'potTypes'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'results')) > 0 then
    v_where := v_where || $w$ and public.library_result(h.hero_profit) = any (public.library_list($1, 'results'))$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'stacks')) > 0 then
    v_where := v_where || $w$ and public.library_stack(hs.starting_stack_bb_tenths) = any (public.library_list($1, 'stacks'))$w$;
  end if;
  if coalesce(btrim(v_filter ->> 'tableName'), '') <> '' then
    v_where := v_where || $w$ and h.table_name ilike '%' || regexp_replace(btrim($1 ->> 'tableName'), '([%_\\])', '\\\1', 'g') || '%'$w$;
  end if;
  if jsonb_typeof(v_filter -> 'minPot') = 'number' then
    v_where := v_where || $w$ and h.total_pot >= ($1 ->> 'minPot')::numeric * h.currency_minor_units$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'showdownPositions')) > 0 then
    v_where := v_where || $w$ and h.showdown_positions && public.library_list($1, 'showdownPositions')$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'winnerPositions')) > 0 then
    v_where := v_where || $w$ and h.winner_positions && public.library_list($1, 'winnerPositions')$w$;
  end if;
  if cardinality(public.library_list(v_filter, 'anonymizations')) > 0 then
    v_where := v_where || $w$ and h.site_anonymization::text = any (public.library_list($1, 'anonymizations'))$w$;
  end if;
  if jsonb_typeof(v_filter -> 'allIn') = 'boolean' then
    v_where := v_where || $w$ and coalesce(e.applicable, false) = ($1 ->> 'allIn')::boolean$w$;
  end if;

  -- After the cursor: nulls last in either direction, ties by id in the
  -- sort's direction.
  if v_has_after then
    if jsonb_typeof(p_after -> 'value') in ('string', 'number') then
      v_where := v_where || format(
        $w$ and (h.%1$I is null or h.%1$I %2$s ($2 ->> 'value')::%3$s
                 or (h.%1$I = ($2 ->> 'value')::%3$s and h.id %2$s ($2 ->> 'id')::uuid))$w$,
        v_col, v_op, v_type);
    else
      v_where := v_where || format($w$ and h.%1$I is null and h.id %2$s ($2 ->> 'id')::uuid$w$, v_col, v_op);
    end if;
  end if;

  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object(
      'handKey', p.id,
      'site', p.site,
      'siteHandId', coalesce(p.site_hand_id, ''),
      'playedAt', p.played_at,
      'gameFormat', p.game_format,
      'variant', coalesce(p.variant, ''),
      'limitType', coalesce(p.limit_type, ''),
      'currency', p.currency,
      'currencySymbol', coalesce(p.currency_symbol, ''),
      'minorUnits', p.currency_minor_units,
      'smallBlind', p.small_blind,
      'bigBlind', p.big_blind,
      'ante', coalesce(p.ante, 0),
      'maxSeats', coalesce(p.max_seats, 0),
      'tableName', p.table_name,
      'heroPosition', p.hero_position,
      'heroCards', to_jsonb(p.hero_cards),
      'heroHandClass', p.hero_hand_class,
      'board', to_jsonb(p.board_cards),
      'heroNet', p.hero_profit,
      'heroNetBbMilli', p.net_bb_milli,
      'allIn', p.all_in,
      'evNet', p.ev_net,
      'evNetBbMilli', p.ev_net_bb_milli,
      'evPending', false,
      'potType', coalesce(p.pot_type, ''),
      'totalPot', p.total_pot,
      'showdown', p.went_to_showdown,
      'anonymization', p.site_anonymization,
      'hasNote', false,
      'tags', '[]'::jsonb,
      'sortValue', p.%1$I
    ) order by p.%1$I %2$s nulls last, p.id %2$s), '[]'::jsonb)
    from (
      select h.id, h.site, h.site_hand_id, h.played_at, h.game_format, h.variant, h.limit_type, h.currency,
             h.currency_symbol, h.currency_minor_units, h.small_blind, h.big_blind, h.ante, h.max_seats,
             h.table_name, h.hero_position, h.hero_cards, h.hero_hand_class, h.board_cards, h.hero_profit,
             h.total_pot, h.went_to_showdown, h.site_anonymization,
             hs.net_bb_milli, hs.pot_type,
             coalesce(e.applicable, false) as all_in,
             case when e.applicable then e.ev_net end as ev_net,
             case when e.applicable then e.ev_net_bb_milli end as ev_net_bb_milli
      from public.hands h
      left join public.hand_stats hs
        on hs.hand_id = h.id and hs.owner_id = $4 and hs.is_hero
       and hs.stats_version = coalesce(nullif(btrim(coalesce($1 ->> 'statsVersion', '')), ''), 'stats/1')
      left join public.hand_stats_ev e
        on e.hand_id = h.id and e.owner_id = $4 and e.seat = hs.seat
       and e.ev_version = coalesce(nullif(btrim(coalesce($1 ->> 'evVersion', '')), ''), 'ev/1')
      where %3$s
      order by h.%1$I %2$s nulls last, h.id %2$s
      limit $3 + 1
    ) p
  $q$, v_col, v_dir, v_where)
  into v_rows
  using v_filter, p_after, v_limit, v_owner;

  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
  end if;

  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(r - 'sortValue' order by o)
                        from jsonb_array_elements(v_rows) with ordinality as t(r, o)), '[]'::jsonb),
    'next', case when v_more then jsonb_build_object('value', v_last -> 'sortValue', 'id', v_last -> 'handKey') end
  );
end;
$function$;

grant execute on function pg_temp.old_library_rows(jsonb), pg_temp.old_library_page(jsonb, jsonb, integer) to authenticated;


create function pg_temp.old_library_facets(p_filter jsonb default '{}'::jsonb) returns jsonb language plpgsql stable
set search_path = '' set work_mem = '64MB' as $$
declare
  v_owner  uuid := auth.uid();
  v_result jsonb;
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  with r as (
    select * from pg_temp.old_library_rows(p_filter)
  ),
  g as (
    select
      grouping(site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in, anonymization) as gid,
      site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in, anonymization,
      count(*) filter (where m_format and m_variant and m_limit and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_site,
      count(*) filter (where m_site and m_variant and m_limit and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_format,
      count(*) filter (where m_site and m_format and m_limit and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_variant,
      count(*) filter (where m_site and m_format and m_variant and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_limit_type,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_size,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_position
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_stake,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_position,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_result and m_stack and m_all_in and m_anon) as c_pot_type,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_stack and m_all_in and m_anon) as c_result,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_all_in and m_anon) as c_stack,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_stack and m_anon) as c_all_in,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_stack and m_all_in) as c_anonymization,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_stack and m_all_in and m_anon) as c_total,
      min(currency) as currency,
      min(currency_symbol) as currency_symbol,
      min(minor_units) as minor_units,
      min(small_blind) as small_blind,
      min(big_blind) as big_blind
    from r
    group by grouping sets ((site), (format), (variant), (limit_type), (size), (stake), ("position"), (pot_type), (result), (stack), (all_in), (anonymization), ())
  ),
  f as (
    select
      jsonb_agg(jsonb_build_object('value', site, 'count', c_site) order by c_site desc, site)
        filter (where gid = 4095 - 2048 and site <> '') as sites,
      jsonb_agg(jsonb_build_object('value', format, 'count', c_format) order by c_format desc, format)
        filter (where gid = 4095 - 1024 and format <> '') as formats,
      jsonb_agg(jsonb_build_object('value', variant, 'count', c_variant) order by c_variant desc, variant)
        filter (where gid = 4095 - 512 and variant <> '') as variants,
      jsonb_agg(jsonb_build_object('value', limit_type, 'count', c_limit_type) order by c_limit_type desc, limit_type)
        filter (where gid = 4095 - 256 and limit_type <> '') as limits,
      jsonb_agg(jsonb_build_object('value', size, 'count', c_size) order by c_size desc, size)
        filter (where gid = 4095 - 128 and size <> '') as sizes,
      jsonb_agg(jsonb_build_object('value', stake, 'count', c_stake,
                                   'currency', case when stake <> 'chips' then currency end,
                                   'currencySymbol', case when stake <> 'chips' then coalesce(currency_symbol, '') end,
                                   'minorUnits', case when stake <> 'chips' then minor_units end,
                                   'smallBlind', case when stake <> 'chips' then small_blind end,
                                   'bigBlind', case when stake <> 'chips' then big_blind end)
                order by stake = 'chips', currency, big_blind)
        filter (where gid = 4095 - 64 and stake <> '') as stakes,
      jsonb_agg(jsonb_build_object('value', "position", 'count', c_position) order by c_position desc, "position")
        filter (where gid = 4095 - 32 and "position" <> '') as positions,
      jsonb_agg(jsonb_build_object('value', pot_type, 'count', c_pot_type) order by c_pot_type desc, pot_type)
        filter (where gid = 4095 - 16 and pot_type <> '') as pot_types,
      jsonb_agg(jsonb_build_object('value', result, 'count', c_result) order by c_result desc, result)
        filter (where gid = 4095 - 8 and result <> '') as results,
      jsonb_agg(jsonb_build_object('value', stack, 'count', c_stack) order by c_stack desc, stack)
        filter (where gid = 4095 - 4 and stack <> '') as stacks,
      jsonb_agg(jsonb_build_object('value', case when all_in then '1' else '0' end, 'count', c_all_in)
                order by all_in desc)
        filter (where gid = 4095 - 2) as all_in,
      jsonb_agg(jsonb_build_object('value', anonymization, 'count', c_anonymization) order by c_anonymization desc, anonymization)
        filter (where gid = 4095 - 1 and anonymization <> '') as anonymizations,
      max(c_total) filter (where gid = 4095) as total
    from g
  )
  select jsonb_build_object(
    'total', coalesce(f.total, 0),
    'library', (select count(*) from public.hands h where h.owner_id = v_owner),
    'sites', coalesce(f.sites, '[]'::jsonb),
    'formats', coalesce(f.formats, '[]'::jsonb),
    'variants', coalesce(f.variants, '[]'::jsonb),
    'limits', coalesce(f.limits, '[]'::jsonb),
    'sizes', coalesce(f.sizes, '[]'::jsonb),
    'stakes', coalesce(f.stakes, '[]'::jsonb),
    'positions', coalesce(f.positions, '[]'::jsonb),
    'potTypes', coalesce(f.pot_types, '[]'::jsonb),
    'results', coalesce(f.results, '[]'::jsonb),
    'stacks', coalesce(f.stacks, '[]'::jsonb),
    'allIn', coalesce(f.all_in, '[]'::jsonb),
    'anonymizations', coalesce(f.anonymizations, '[]'::jsonb)
  ) into v_result
  from f;

  return v_result;
end;
$$;
grant execute on function pg_temp.old_library_facets(jsonb) to authenticated;

-- Random filters: a few values of a few groups, a version or two, a range
-- (whole months, partial ones, inside one month, exactly on a month's first
-- instant, open at either end), and now and then a search.
create function pg_temp.pick(p_values text[], p_i integer, p_salt text) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(v), '[]'::jsonb)
  from unnest(p_values) with ordinality u(v, n)
  where pg_temp.r(p_i * 31 + n::integer, p_salt) % 3 = 0;
$$;
create function pg_temp.instant(p_i integer, p_salt text) returns text language sql immutable as $$
  select case pg_temp.r(p_i, p_salt) % 6
           when 0 then null
           when 1 then (timestamptz '2025-11-01 00:00:00+00' + make_interval(months => pg_temp.r(p_i, p_salt || 'm') % 16))::text
           when 2 then (timestamptz '2025-11-01 00:00:00+00' + make_interval(months => pg_temp.r(p_i, p_salt || 'm') % 16, days => 9, hours => 5))::text
           when 3 then (timestamptz '2026-03-01 00:00:00+00' - interval '1 microsecond')::text
           else (timestamptz '2025-10-20 00:00:00+00' + make_interval(hours => pg_temp.r(p_i, p_salt || 'h') % (24 * 470)))::text
         end;
$$;
create temp table filters as
select i, jsonb_strip_nulls(jsonb_build_object(
         'sites', case when pg_temp.r(i, 'gs') % 3 = 0 then pg_temp.pick(array['pokerstars', 'ggpoker', 'winamax', 'nosuch'], i, 's') end,
         'formats', case when pg_temp.r(i, 'gf') % 4 = 0 then pg_temp.pick(array['cash', 'tournament'], i, 'f') end,
         'variants', case when pg_temp.r(i, 'gv') % 5 = 0 then pg_temp.pick(array['holdem', 'omaha', ''], i, 'v') end,
         'limits', case when pg_temp.r(i, 'gl') % 6 = 0 then pg_temp.pick(array['nl', 'pl', ''], i, 'l') end,
         'sizes', case when pg_temp.r(i, 'gz') % 4 = 0 then pg_temp.pick(array['hu', '6max', 'full'], i, 'z') end,
         'stakes', case when pg_temp.r(i, 'gk') % 4 = 0 then pg_temp.pick(array['USD:2', 'USD:10', 'EUR:20', 'USD:0', 'chips'], i, 'k') end,
         'positions', case when pg_temp.r(i, 'gp') % 4 = 0 then pg_temp.pick(array['BTN', 'SB', 'BB', 'CO', ''], i, 'p') end,
         'potTypes', case when pg_temp.r(i, 'gt') % 4 = 0 then pg_temp.pick(array['limped', 'single-raised', '3bet', 'walk', ''], i, 't') end,
         'results', case when pg_temp.r(i, 'gr') % 5 = 0 then pg_temp.pick(array['won', 'lost', 'even', ''], i, 'r') end,
         'stacks', case when pg_temp.r(i, 'gb') % 5 = 0 then pg_temp.pick(array['0-40', '40-80', '80-120', '120+', ''], i, 'b') end,
         'anonymizations', case when pg_temp.r(i, 'ga') % 6 = 0 then pg_temp.pick(array['none', 'positional'], i, 'a') end,
         'allIn', case pg_temp.r(i, 'gi') % 5 when 0 then to_jsonb(true) when 1 then to_jsonb(false) end,
         'statsVersion', case pg_temp.r(i, 'sv') % 4 when 0 then 'stats/2' when 1 then 'stats/9' when 2 then 'stats/1' end,
         'evVersion', case pg_temp.r(i, 'ev') % 3 when 0 then 'ev/2' when 1 then 'ev/1' end,
         'from', case when pg_temp.r(i, 'rf') % 2 = 0 then pg_temp.instant(i, 'from') end,
         'to', case when pg_temp.r(i, 'rt') % 3 = 0 then pg_temp.instant(i, 'to') end,
         'tableName', case when pg_temp.r(i, 'x') % 17 = 0 then 'table 1' end,
         'showdown', case when pg_temp.r(i, 'x') % 17 = 1 then to_jsonb(true) end,
         'heroCards', case when pg_temp.r(i, 'x') % 17 = 2 then '["Ah"]'::jsonb end,
         'minPot', case when pg_temp.r(i, 'x') % 17 = 3 then to_jsonb(4) end
       )) as f
from generate_series(1, 160) i
union all
-- the edges written out: no filter, a range inside one month, exactly whole
-- months, open ends, a range ending on a month's first instant
select 1000 + n, f from (values
  (1, '{}'::jsonb),
  (2, '{"from":"2026-02-03T10:00:00Z","to":"2026-02-20T00:00:00Z"}'),
  (3, '{"from":"2026-01-01T00:00:00Z","to":"2026-04-01T00:00:00Z"}'),
  (4, '{"from":"2026-01-01T00:00:00Z"}'),
  (5, '{"to":"2026-04-01T00:00:00Z"}'),
  (6, '{"from":"2025-12-31T23:59:59.999999Z","to":"2026-03-01T00:00:00.000001Z"}'),
  (7, '{"from":"2026-02-01T00:00:00+01:00","to":"2026-06-15T00:00:00-05:00","statsVersion":"stats/2","evVersion":"ev/2"}'),
  (8, '{"from":"2030-01-01T00:00:00Z"}'),
  (9, '{"potTypes":[""],"stacks":[""],"allIn":false,"positions":[""],"results":[""]}'),
  (10, '{"from":"2026-05-01T00:00:00Z","to":"2026-05-01T00:00:00Z"}'),
  (11, '{"tableName":"TABLE 2"}'),
  (12, '{"tableName":"_"}'),
  (13, '{"tableName":"%"}'),
  (14, '{"tableName":"e 1","formats":["cash"],"from":"2026-02-01T00:00:00Z"}'),
  (15, '{"tableName":"\\\\"}'),
  (16, '{"tableName":"nowhere"}'),
  (17, '{"tableName":"  big_game 3%  "}')) v(n, f);
grant select on filters to authenticated;

create temp table differ (account text, i integer, f jsonb);
grant all on differ to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000071a1');
insert into differ select 'one', i, f from filters
  where public.library_facets(f) is distinct from pg_temp.old_library_facets(f);
select pg_temp.act_as('00000000-0000-0000-0000-0000000071b1');
insert into differ select 'two', i, f from filters
  where public.library_facets(f) is distinct from pg_temp.old_library_facets(f);

select is((select array_agg(account || ' #' || i || ' ' || f::text order by account, i) from differ), null,
          'library_facets = its previous body on 177 filters, both accounts');

-- Pages: every order, the first page and the one after it.
create temp table page_differ (i integer, sort text, f jsonb);
grant all on page_differ to authenticated;
create function pg_temp.pages_same(p_filter jsonb) returns boolean language plpgsql as $$
declare
  v_new jsonb := public.library_page(p_filter, null, 20);
  v_old jsonb := pg_temp.old_library_page(p_filter, null, 20);
begin
  if v_new is distinct from v_old then
    return false;
  end if;
  return v_new -> 'next' is null
      or public.library_page(p_filter, v_new -> 'next', 20) is not distinct from pg_temp.old_library_page(p_filter, v_new -> 'next', 20);
end;
$$;
grant execute on function pg_temp.pages_same(jsonb) to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000071a1');
insert into page_differ
select i, s, f from filters, unnest(array['newest', 'oldest', 'pot', 'won', 'lost']) s
where (i % 5 = 0 or f ? 'tableName') and not pg_temp.pages_same(f || jsonb_build_object('sort', s));
select is((select array_agg(i || ' ' || sort order by i, sort) from page_differ), null,
          'library_page = its previous body: table names and the other filters, every order, two pages');
select ok((select count(*) from filters where f ? 'from' or f ? 'to') >= 60, '... of which many with a range');
select ok((select (public.library_facets('{}') ->> 'total')::int) = 1400, '... and the counts are the account''s (1 400 hands)');

-- Reads: an unfiltered call counts from the summaries, a hand range reads
-- the partial months only.
create function pg_temp.rows_read() returns bigint language sql as $$
  select coalesce(sum(pg_stat_get_xact_tuples_returned(c.oid) + pg_stat_get_xact_tuples_fetched(c.oid)), 0)::bigint
  from pg_class c
  where c.oid in (
    select t.oid from pg_class t
    where t.relnamespace = 'public'::regnamespace and t.relname in ('hands', 'hand_stats', 'hand_stats_ev')
    union
    select i.indexrelid from pg_index i join pg_class t on t.oid = i.indrelid
    where t.relnamespace = 'public'::regnamespace and t.relname in ('hands', 'hand_stats', 'hand_stats_ev'));
$$;
create function pg_temp.reads(p_sql text) returns bigint language plpgsql as $$
declare v_before bigint;
begin
  execute p_sql;
  v_before := pg_temp.rows_read();
  execute p_sql;
  return pg_temp.rows_read() - v_before;
end;
$$;
grant execute on function pg_temp.rows_read(), pg_temp.reads(text) to authenticated;

select pg_temp.act_as('00000000-0000-0000-0000-0000000071a1');
select is(pg_temp.reads($q$select public.library_facets('{"statsVersion":"stats/1","positions":["BTN"]}')$q$), 0::bigint,
          'library_facets without a range or a search reads no hand, statistics or EV row');
select cmp_ok(pg_temp.reads($q$select public.library_facets('{"from":"2026-01-20T00:00:00Z"}')$q$),
          '<', pg_temp.reads($q$select public.library_facets('{"minPot":0}')$q$),
          'a range reads the hands of its partial month, not the library (a search reads every hand)');

-- ---------------------------------------------------------------------------
-- 4. A hand deleted while its account stays: stale, still right
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();
delete from public.hands where id in (
  select hand_id from public.hand_stats
  where owner_id = '00000000-0000-0000-0000-0000000071a1' and stats_version = 'stats/1' and is_hero
  order by hand_key limit 3);
select ok(exists (select 1 from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000071a1'),
          'a hand deleted with its statistics: the account is marked stale');
select pg_temp.act_as('00000000-0000-0000-0000-0000000071a1');
select is((select count(*) from filters where public.library_facets(f) is distinct from pg_temp.old_library_facets(f) and i % 4 = 0),
          0::bigint, 'stale: library_facets still answers as before (it reads the hands)');
select is((public.library_facets('{}') ->> 'library')::int, 1397, 'stale: the library is counted from the hands');
select is(public.library_count(), 1397::bigint, 'stale: library_count counts the hands');
select pg_temp.as_postgres();
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071b1'), 'the other account is untouched');
select public.library_counts_rebuild('00000000-0000-0000-0000-0000000071a1');
select ok(not exists (select 1 from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000071a1'),
          'the rebuild clears the mark');
select pg_temp.act_as('00000000-0000-0000-0000-0000000071a1');
select is((select count(*) from filters where public.library_facets(f) is distinct from pg_temp.old_library_facets(f) and i % 4 = 1),
          0::bigint, 'recounted: the same answers again');
select is(pg_temp.reads($q$select public.library_facets('{}')$q$), 0::bigint, '... from the summaries again');

-- The caller's repair recounts the library too.
select lives_ok($q$select public.refresh_report_summaries()$q$, 'refresh_report_summaries runs for the caller');

-- ---------------------------------------------------------------------------
-- 5. An account deleted takes its counts with it
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();
select ok(exists (select 1 from public.library_hero_counts where owner_id = '00000000-0000-0000-0000-0000000071c1'),
          'the third account has counts');
select lives_ok($q$delete from auth.users where id = '00000000-0000-0000-0000-0000000071c1'$q$, 'an account with hands, statistics and EV rows is deleted');
select is((select count(*) from public.library_hand_counts where owner_id = '00000000-0000-0000-0000-0000000071c1')
        + (select count(*) from public.library_hero_counts where owner_id = '00000000-0000-0000-0000-0000000071c1')
        + (select count(*) from public.library_counts_stale where owner_id = '00000000-0000-0000-0000-0000000071c1'),
          0::bigint, '... and its counts go with it, nothing marked');
select ok(pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071a1') and pg_temp.kept_exactly('00000000-0000-0000-0000-0000000071b1'),
          'the others are kept exactly');

-- ---------------------------------------------------------------------------
-- 6. Owner only; anon refused; nothing writable
-- ---------------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-0000-0000-0000000071b1');
select is((select count(*) from public.library_hand_counts where owner_id <> '00000000-0000-0000-0000-0000000071b1'), 0::bigint,
          'a reader sees its own hand counts only');
select is((select count(*) from public.library_hero_counts where owner_id <> '00000000-0000-0000-0000-0000000071b1'), 0::bigint,
          'a reader sees its own hero counts only');
select throws_ok($q$insert into public.library_hand_counts (owner_id, month, site, game_format, variant, limit_type, size, stake,
                     "position", result, site_anonymization, currency, currency_minor_units, hands)
                    values ('00000000-0000-0000-0000-0000000071b1', '2026-01-01', 'x', 'cash', '', '', 'hu', 'chips', '', '', 'none', 'USD', 100, 5)$q$,
                 '42501', null, 'a reader cannot write its counts');
select throws_ok($q$select public.library_counts_rebuild('00000000-0000-0000-0000-0000000071b1')$q$, '42501', null,
                 'a reader cannot call the rebuild');
select is((public.library_facets('{}') ->> 'library')::int, 400, 'library_facets: the reader''s own library');
select is(public.library_count(), 400::bigint, 'library_count: the reader''s own library');

select pg_temp.act_as_anon();
select throws_ok($q$select public.library_facets('{}')$q$, '42501', null, 'anon: library_facets refused');
select throws_ok($q$select count(*) from public.library_hand_counts$q$, '42501', null, 'anon: no counts');

select * from finish();
rollback;
