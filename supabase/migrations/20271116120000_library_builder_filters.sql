-- ============================================================================
-- The filter builder's groups on the web (2026-11-16, the owner: "add the
-- advanced filters to web Hands").
-- ============================================================================
--
-- The desktop's Hands screen has the filter builder's groups (V1,
-- 2026-11-05); the web's had none. The ones a hand's existing columns
-- answer are added here, as SQL over `hands` and the hero's `hand_stats`
-- row, in `library_builder_where`:
--
--   the hero's actions (from the hero's counters, the app's `ACTS`), the
--   flop's suits, pairing, high card and straight draws, players dealt in,
--   straddle / ante / run it twice, days of the week and parts of the day
--   in the reader's time, the latest N hands, the hero's stack, the
--   result and the pot as ranges, the analysis' grades and EV lost, and
--   whether an opponent's cards were seen.
--
-- It is part of `library_where`, so the list (`library_page`), the reports
-- (`report_hand_ids`) and the Analysis tabs (`analysis_hand_ids`) read the
-- groups at once; `library_facets` counts them through `library_rows`
-- (`library_builder_ids`), as it counts the searches.
--
-- The groups a hand's columns cannot answer (sizes, made hands, kickers,
-- draws, the opponents in the pot, position on the flop, the tournament's
-- buy-in, bounty and level, bluffs) need the app's per-hand facts and are
-- not offered on the web yet.

-- ---------------------------------------------------------------------------
-- The builder's groups as SQL
-- ---------------------------------------------------------------------------

create or replace function public.library_act_sql(p_name text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  -- The app's `hand_list::ACTS` over the hero's statistics row (`hs`).
  select case p_name
    when 'open'            then 'hs.rfi > 0'
    when 'limp'            then 'hs.limp > 0'
    when 'iso'             then 'hs.iso > 0'
    when 'callOpen'        then 'hs.cold_call > 0'
    when 'threeBet'        then 'hs.three_bet > 0'
    when 'callThreeBet'    then 'hs.call_three_bet > 0'
    when 'fourBet'         then '(hs.four_bet > 0 or hs.five_bet > 0)'
    when 'squeeze'         then 'hs.squeeze > 0'
    when 'steal'           then 'hs.steal > 0'
    when 'foldToThreeBet'  then 'hs.fold_to_three_bet > 0'
    when 'facedUnopened'   then 'hs.rfi_opp > 0'
    when 'facedLimp'       then 'hs.iso_opp > 0'
    when 'facedOpen'       then '(hs.three_bet_opp > 0 or hs.cold_call_opp > 0)'
    when 'facedThreeBet'   then 'hs.fold_to_three_bet_opp > 0'
    when 'facedFourBet'    then 'hs.fold_to_four_bet_opp > 0'
    when 'aggressor'       then 'hs.pfr > 0'
    when 'caller'          then '(hs.vpip > 0 and hs.pfr = 0)'
    when 'sawFlop'         then 'hs.flop_seen > 0'
    when 'sawTurn'         then 'hs.turn_seen > 0'
    when 'sawRiver'        then 'hs.river_seen > 0'
    when 'cbetFlop'        then 'hs.cbet_flop > 0'
    when 'checkRaiseFlop'  then 'hs.check_raise_flop > 0'
    when 'donkFlop'        then 'hs.donk_flop > 0'
    when 'facingCbetFlop'  then 'hs.fold_to_cbet_flop_opp > 0'
    when 'raiseCbetFlop'   then 'hs.raise_cbet_flop > 0'
    when 'cbetTurn'        then 'hs.cbet_turn > 0'
    when 'facingCbetTurn'  then 'hs.fold_to_cbet_turn_opp > 0'
    when 'checkRaiseTurn'  then 'hs.check_raise_turn > 0'
    when 'donkTurn'        then 'hs.donk_turn > 0'
    when 'cbetRiver'       then 'hs.cbet_river > 0'
    when 'facingCbetRiver' then 'hs.fold_to_cbet_river_opp > 0'
    when 'checkRaiseRiver' then 'hs.check_raise_river > 0'
    when 'donkRiver'       then 'hs.donk_river > 0'
  end
$fn$;

comment on function public.library_act_sql(text) is
  'One of the filter builder''s hero actions as a predicate over the hero''s hand_stats row hs (the app''s hand_list::ACTS); null for an unknown name.';

-- A number of the filter, validated, as SQL text (null when absent or not a number).
create or replace function public.library_number(p_filter jsonb, p_key text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when jsonb_typeof(p_filter -> p_key) = 'number'
              and (p_filter ->> p_key)::numeric between -1e12 and 1e12
         then ((p_filter ->> p_key)::numeric)::text end
$fn$;

create or replace function public.library_builder_where(p_filter jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  w      text := '';
  g      jsonb;
  parts  text[];
  v      text;
  n      text;
  -- The flop: its ranks (A=1 ... 2=13) and suits.
  flop   text := 'cardinality(h.board_cards) >= 3';
  r1 text := 'substr(h.board_cards[1], 1, 1)';
  r2 text := 'substr(h.board_cards[2], 1, 1)';
  r3 text := 'substr(h.board_cards[3], 1, 1)';
  s1 text := 'substr(h.board_cards[1], 2, 1)';
  s2 text := 'substr(h.board_cards[2], 2, 1)';
  s3 text := 'substr(h.board_cards[3], 2, 1)';
  i1 text := 'strpos(''AKQJT98765432'', substr(h.board_cards[1], 1, 1))';
  i2 text := 'strpos(''AKQJT98765432'', substr(h.board_cards[2], 1, 1))';
  i3 text := 'strpos(''AKQJT98765432'', substr(h.board_cards[3], 1, 1))';
  distinct_ranks text;
  straight text;
  offset_m integer := 0;
  local_at text;
  v_version text := 'coalesce(nullif(btrim(coalesce($1 ->> ''analysisVersion'', '''')), ''''), ''analysis/1'')';
  analysed text;
begin
  if jsonb_typeof(p_filter) is distinct from 'object' then
    return '';
  end if;

  -- The hero's actions: a hand matches a group with any of its actions, and every group.
  if jsonb_typeof(p_filter -> 'acts') = 'array' then
    for g in select x from jsonb_array_elements(p_filter -> 'acts') x loop
      if jsonb_typeof(g) = 'array' then
        parts := array(select s from (select public.library_act_sql(t) as s from jsonb_array_elements_text(g) t) q
                       where s is not null);
        if cardinality(parts) > 0 then
          w := w || ' and (' || array_to_string(parts, ' or ') || ')';
        end if;
      end if;
    end loop;
  end if;

  -- The flop's texture.
  parts := array(select case t
      when 'monotone' then format('(%1$s = %2$s and %2$s = %3$s)', s1, s2, s3)
      when 'twoTone' then format('(not (%1$s = %2$s and %2$s = %3$s) and (%1$s = %2$s or %2$s = %3$s or %1$s = %3$s))', s1, s2, s3)
      when 'rainbow' then format('(%1$s <> %2$s and %2$s <> %3$s and %1$s <> %3$s)', s1, s2, s3)
    end from unnest(public.library_list(p_filter, 'flopSuits')) t);
  parts := array_remove(parts, null);
  if cardinality(parts) > 0 then
    w := w || ' and (' || flop || ' and (' || array_to_string(parts, ' or ') || '))';
  end if;
  parts := array_remove(array(select case t
      when 'trips' then format('(%1$s = %2$s and %2$s = %3$s)', r1, r2, r3)
      when 'paired' then format('(not (%1$s = %2$s and %2$s = %3$s) and (%1$s = %2$s or %2$s = %3$s or %1$s = %3$s))', r1, r2, r3)
      when 'unpaired' then format('(%1$s <> %2$s and %2$s <> %3$s and %1$s <> %3$s)', r1, r2, r3)
    end from unnest(public.library_list(p_filter, 'flopPairing')) t), null);
  if cardinality(parts) > 0 then
    w := w || ' and (' || flop || ' and (' || array_to_string(parts, ' or ') || '))';
  end if;
  parts := array_remove(array(select case
      when t in ('A', 'K', 'Q', 'J', 'T') then format('least(%s, %s, %s) = %s', i1, i2, i3, strpos('AKQJT98765432', t))
      when t = 'low' then format('least(%s, %s, %s) >= 6', i1, i2, i3)
    end from unnest(public.library_list(p_filter, 'flopHigh')) t), null);
  if cardinality(parts) > 0 then
    w := w || ' and (' || flop || ' and (' || array_to_string(parts, ' or ') || '))';
  end if;
  -- Three different ranks within five (A also low with 2-5).
  distinct_ranks := format('(%1$s <> %2$s and %2$s <> %3$s and %1$s <> %3$s)', r1, r2, r3);
  straight := format('(%1$s and (greatest(%2$s, %3$s, %4$s) - least(%2$s, %3$s, %4$s) <= 4'
                     ' or greatest(%5$s, %6$s, %7$s) - least(%5$s, %6$s, %7$s) <= 4))',
                     distinct_ranks, i1, i2, i3,
                     format('(case when %1$s = 1 then 14 else %1$s end)', i1),
                     format('(case when %1$s = 1 then 14 else %1$s end)', i2),
                     format('(case when %1$s = 1 then 14 else %1$s end)', i3));
  parts := array_remove(array(select case t
      when 'straight' then straight
      when 'noStraight' then 'not ' || straight
    end from unnest(public.library_list(p_filter, 'flopConnect')) t), null);
  if cardinality(parts) > 0 then
    w := w || ' and (' || flop || ' and (' || array_to_string(parts, ' or ') || '))';
  end if;

  -- Players dealt in.
  parts := array_remove(array(select case
      when t = '7plus' then 'coalesce(hs.player_count, h.player_count) >= 7'
      when t ~ '^[2-6]$' then 'coalesce(hs.player_count, h.player_count) = ' || t
    end from unnest(public.library_list(p_filter, 'players')) t), null);
  if cardinality(parts) > 0 then
    w := w || ' and (' || array_to_string(parts, ' or ') || ')';
  end if;

  -- Game conditions: every one.
  for v in select t from unnest(public.library_list(p_filter, 'conditions')) t loop
    w := w || case v
      when 'straddle' then ' and coalesce(hs.has_straddle, false)'
      when 'runItTwice' then ' and coalesce(hs.is_run_it_twice, false)'
      when 'ante' then ' and (coalesce(hs.is_big_blind_ante, false) or coalesce(h.ante, 0) > 0)'
      else '' end;
  end loop;

  -- Days and parts of the day in the reader's time.
  if public.library_number(p_filter, 'utcOffsetMinutes') is not null then
    offset_m := greatest(least(round((p_filter ->> 'utcOffsetMinutes')::numeric)::integer, 1440), -1440);
  end if;
  local_at := format('((h.played_at at time zone ''UTC'') + interval ''%s minutes'')', offset_m);
  if jsonb_typeof(p_filter -> 'weekdays') = 'array' then
    parts := array(select x::text from (
      select (t ->> 0)::numeric as x from jsonb_array_elements(p_filter -> 'weekdays') t
      where jsonb_typeof(t) = 'number') q where x in (1, 2, 3, 4, 5, 6, 7));
    if cardinality(parts) > 0 then
      w := w || format(' and (h.played_at is not null and extract(isodow from %s)::integer in (%s))',
                       local_at, array_to_string(parts, ', '));
    end if;
  end if;
  parts := array_remove(array(select case t
      when 'night' then 'between 0 and 5'
      when 'morning' then 'between 6 and 11'
      when 'afternoon' then 'between 12 and 17'
      when 'evening' then 'between 18 and 23'
    end from unnest(public.library_list(p_filter, 'dayParts')) t), null);
  if cardinality(parts) > 0 then
    w := w || ' and (h.played_at is not null and ('
              || array_to_string(array(select format('extract(hour from %s)::integer %s', local_at, p) from unnest(parts) p), ' or ')
              || '))';
  end if;

  -- The latest this many hands (of the reader's every hand).
  n := public.library_number(p_filter, 'lastHands');
  if n is not null and n::numeric >= 1 then
    w := w || format(' and h.played_at >= coalesce((select x.played_at from public.hands x'
                     ' where x.owner_id = $4 and x.played_at is not null'
                     ' order by x.played_at desc offset %s limit 1), ''-infinity''::timestamptz)',
                     floor(n::numeric)::bigint - 1);
  end if;

  -- The hero's stack and result, big blinds; the pot, big blinds or money.
  n := public.library_number(p_filter, 'heroStackMin');
  if n is not null then w := w || ' and hs.starting_stack_bb_tenths >= ' || n || ' * 10'; end if;
  n := public.library_number(p_filter, 'heroStackMax');
  if n is not null then w := w || ' and hs.starting_stack_bb_tenths <= ' || n || ' * 10'; end if;
  n := public.library_number(p_filter, 'netMin');
  if n is not null then w := w || ' and hs.net_bb_milli >= ' || n || ' * 1000'; end if;
  n := public.library_number(p_filter, 'netMax');
  if n is not null then w := w || ' and hs.net_bb_milli <= ' || n || ' * 1000'; end if;
  if public.library_number(p_filter, 'potMin') is not null or public.library_number(p_filter, 'potMax') is not null then
    v := case when p_filter ->> 'potUnit' = 'money' then 'h.currency_minor_units' else 'h.big_blind' end;
    w := w || ' and ' || v || case when v = 'h.big_blind' then ' > 0' else ' > 1' end;
    n := public.library_number(p_filter, 'potMin');
    if n is not null then w := w || ' and h.total_pot >= ' || n || ' * ' || v; end if;
    n := public.library_number(p_filter, 'potMax');
    if n is not null then w := w || ' and h.total_pot <= ' || n || ' * ' || v; end if;
  end if;

  -- The analysis (the version the client reads).
  analysed := 'exists (select 1 from public.hand_analysis a where a.hand_id = h.id and a.owner_id = $4'
              ' and a.analysis_version = ' || v_version || ' and a.status <> ''not-analysed'')';
  parts := array_remove(array(select case
      when t in ('blunder', 'mistake', 'inaccurate') then
        'exists (select 1 from public.decision_analysis g where g.hand_id = h.id and g.owner_id = $4'
        ' and g.analysis_version = ' || v_version || ' and g.grade = ' || quote_literal(t) || ')'
      when t = 'clean' then
        '(' || analysed || ' and not exists (select 1 from public.decision_analysis g where g.hand_id = h.id'
        ' and g.owner_id = $4 and g.analysis_version = ' || v_version
        || ' and g.grade in (''inaccurate'', ''mistake'', ''blunder'')))'
      when t = 'notAnalysed' then 'not ' || analysed
    end from unnest(public.library_list(p_filter, 'grades')) t), null);
  if cardinality(parts) > 0 then
    w := w || ' and (' || array_to_string(parts, ' or ') || ')';
  end if;
  n := public.library_number(p_filter, 'evLossMin');
  if n is not null then
    w := w || ' and exists (select 1 from public.hand_analysis a where a.hand_id = h.id and a.owner_id = $4'
              ' and a.analysis_version = ' || v_version || ' and a.ev_loss_bb >= ' || n || ')';
  end if;

  -- An opponent's cards were seen: the PHF's players where the row keeps
  -- it, the showdown's positions where it keeps the text alone.
  if jsonb_typeof(p_filter -> 'knownCards') = 'boolean' then
    v := '(case when h.phf ? ''players'' then exists (select 1 from jsonb_array_elements(h.phf -> ''players'') p'
         ' where not coalesce((p ->> ''isHero'')::boolean, false)'
         ' and jsonb_typeof(p -> ''holeCards'') = ''array'' and jsonb_array_length(p -> ''holeCards'') > 0)'
         ' else exists (select 1 from unnest(coalesce(h.showdown_positions, ''{}'')) sp'
         ' where sp is distinct from h.hero_position) end)';
    w := w || case when (p_filter ->> 'knownCards')::boolean then ' and ' || v else ' and not ' || v end;
  end if;

  return w;
end;
$fn$;

comment on function public.library_builder_where(jsonb) is
  'The filter builder''s groups (the app''s builder V1: the hero''s actions, the flop''s texture, players, conditions, days and hours, the latest hands, stack, result and pot ranges, the analysis, known cards) as SQL over hands h, the hero''s hand_stats hs and the reader $4, the filter as $1. Part of library_where.';

-- The reader's hands the builder's groups keep (null when none is set): what
-- library_rows (the counts) narrows by.
create or replace function public.library_builder_ids(p_filter jsonb)
returns uuid[]
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $fn$
declare
  v_owner  uuid  := (select auth.uid());
  v_filter jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_where  text  := public.library_builder_where(v_filter);
  v_ids    uuid[];
begin
  if v_owner is null or v_where = '' then
    return null;
  end if;
  execute format($q$
    select coalesce(array_agg(h.id), '{}'::uuid[])
    from public.hands h
    left join public.hand_stats hs
      on hs.hand_id = h.id and hs.owner_id = $4 and hs.is_hero
     and hs.stats_version = coalesce(nullif(btrim(coalesce($1 ->> 'statsVersion', '')), ''), 'stats/1')
    where h.owner_id = $4%s
  $q$, v_where)
  into v_ids
  using v_filter, null::jsonb, null::integer, v_owner;
  return v_ids;
end;
$fn$;

revoke all on function public.library_act_sql(text) from public, anon;
grant execute on function public.library_act_sql(text) to authenticated;
revoke all on function public.library_number(jsonb, text) from public, anon;
grant execute on function public.library_number(jsonb, text) to authenticated;
revoke all on function public.library_builder_where(jsonb) from public, anon;
grant execute on function public.library_builder_where(jsonb) to authenticated;
revoke all on function public.library_builder_ids(jsonb) from public, anon;
grant execute on function public.library_builder_ids(jsonb) to authenticated;

-- library_where: as in 20271116100000_report_hands_filter.sql, with the builder's groups.
create or replace function public.library_where(p_filter jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_where text := '';
begin
  if p_filter ? 'from' and coalesce(p_filter ->> 'from', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at >= ($1 ->> 'from')::timestamptz$w$;
  end if;
  if p_filter ? 'to' and coalesce(p_filter ->> 'to', '') <> '' then
    v_where := v_where || $w$ and h.played_at is not null and h.played_at < ($1 ->> 'to')::timestamptz$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'heroCards')) > 0 then
    v_where := v_where || $w$ and h.hero_cards @> public.library_list($1, 'heroCards')$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'heroHandClasses')) > 0 then
    v_where := v_where || $w$ and h.hero_hand_class = any (public.library_list($1, 'heroHandClasses'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'board')) > 0 then
    v_where := v_where || $w$ and h.board_cards @> public.library_list($1, 'board')$w$;
  end if;
  if coalesce(btrim(p_filter ->> 'player'), '') <> '' then
    v_where := v_where || $w$ and btrim($1 ->> 'player') = any (h.player_names)$w$;
  end if;
  if jsonb_typeof(p_filter -> 'showdown') = 'boolean' then
    v_where := v_where || $w$ and h.went_to_showdown = ($1 ->> 'showdown')::boolean$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'sites')) > 0 then
    v_where := v_where || $w$ and h.site = any (public.library_list($1, 'sites'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'formats')) > 0 then
    v_where := v_where || $w$ and h.game_format::text = any (public.library_list($1, 'formats'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'variants')) > 0 then
    v_where := v_where || $w$ and coalesce(h.variant, '') = any (public.library_list($1, 'variants'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'limits')) > 0 then
    v_where := v_where || $w$ and coalesce(h.limit_type, '') = any (public.library_list($1, 'limits'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'sizes')) > 0 then
    v_where := v_where || $w$ and public.library_size(h.max_seats, h.player_count) = any (public.library_list($1, 'sizes'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'stakes')) > 0 then
    v_where := v_where || $w$ and public.library_stake(h.game_format, h.currency, h.big_blind) = any (public.library_list($1, 'stakes'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'positions')) > 0 then
    v_where := v_where || $w$ and coalesce(h.hero_position, '') = any (public.library_list($1, 'positions'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'potTypes')) > 0 then
    v_where := v_where || $w$ and coalesce(hs.pot_type, '') = any (public.library_list($1, 'potTypes'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'results')) > 0 then
    v_where := v_where || $w$ and public.library_result(h.hero_profit) = any (public.library_list($1, 'results'))$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'stacks')) > 0 then
    v_where := v_where || $w$ and public.library_stack(hs.starting_stack_bb_tenths) = any (public.library_list($1, 'stacks'))$w$;
  end if;
  if coalesce(btrim(p_filter ->> 'tableName'), '') <> '' then
    v_where := v_where || $w$ and h.table_name ilike '%' || regexp_replace(btrim($1 ->> 'tableName'), '([%_\\])', '\\\1', 'g') || '%'$w$;
  end if;
  if jsonb_typeof(p_filter -> 'minPot') = 'number' then
    v_where := v_where || $w$ and h.total_pot >= ($1 ->> 'minPot')::numeric * h.currency_minor_units$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'showdownPositions')) > 0 then
    v_where := v_where || $w$ and h.showdown_positions && public.library_list($1, 'showdownPositions')$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'winnerPositions')) > 0 then
    v_where := v_where || $w$ and h.winner_positions && public.library_list($1, 'winnerPositions')$w$;
  end if;
  if cardinality(public.library_list(p_filter, 'anonymizations')) > 0 then
    v_where := v_where || $w$ and h.site_anonymization::text = any (public.library_list($1, 'anonymizations'))$w$;
  end if;
  if jsonb_typeof(p_filter -> 'allIn') = 'boolean' then
    v_where := v_where || $w$ and coalesce(e.applicable, false) = ($1 ->> 'allIn')::boolean$w$;
  end if;

  -- The filter builder's groups (2026-11-16).
  v_where := v_where || public.library_builder_where(p_filter);
  return v_where;
end;
$fn$;

-- library_beyond_rollups: as in 20271116100000_report_hands_filter.sql, with the builder's groups.
create or replace function public.library_beyond_rollups(p_filter jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(cardinality(public.library_list(p_filter, 'potTypes')) > 0
      or cardinality(public.library_list(p_filter, 'results')) > 0
      or cardinality(public.library_list(p_filter, 'stacks')) > 0
      or cardinality(public.library_list(p_filter, 'heroCards')) > 0
      or cardinality(public.library_list(p_filter, 'heroHandClasses')) > 0
      or cardinality(public.library_list(p_filter, 'board')) > 0
      or coalesce(btrim(p_filter ->> 'player'), '') <> ''
      or jsonb_typeof(p_filter -> 'showdown') = 'boolean'
      or coalesce(btrim(p_filter ->> 'tableName'), '') <> ''
      or jsonb_typeof(p_filter -> 'minPot') = 'number'
      or cardinality(public.library_list(p_filter, 'showdownPositions')) > 0
      or cardinality(public.library_list(p_filter, 'winnerPositions')) > 0
      or cardinality(public.library_list(p_filter, 'anonymizations')) > 0
      or jsonb_typeof(p_filter -> 'allIn') = 'boolean'
      or public.library_builder_where(p_filter) <> '', false)
$fn$;

-- library_rows: as in 20270818090000_big_account_readers.sql, with the builder's groups.
CREATE OR REPLACE FUNCTION public.library_rows(p_filter jsonb)
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
  v_tables     text[];
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
  -- The filter builder's groups (2026-11-16): the hands they keep, or null.
  v_builder    uuid[] := public.library_builder_ids(case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end);
begin
  -- A part of the table's name: the caller's table names that hold it (see
  -- `library_table_names`), then those names by equality.
  if v_table is not null then
    v_tables := public.library_table_names(v_table);
  end if;
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
      and (v_builder is null or h.id = any (v_builder))
      and (v_from is null or (h.played_at is not null and h.played_at >= v_from))
      and (v_to is null or (h.played_at is not null and h.played_at < v_to))
      and (cardinality(v_cards) = 0 or h.hero_cards @> v_cards)
      and (cardinality(v_classes) = 0 or h.hero_hand_class = any (v_classes))
      and (cardinality(v_board) = 0 or h.board_cards @> v_board)
      and (v_player is null or v_player = any (h.player_names))
      and (v_showdown is null or h.went_to_showdown = v_showdown)
      and (v_table is null or h.table_name = any (v_tables))
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

-- library_facets: as in 20270818090000_big_account_readers.sql, with the builder's groups.
create or replace function public.library_facets(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
set work_mem = '64MB'
as $$
declare
  v_owner     uuid := auth.uid();
  v_filter    jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_stats     text := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        text := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_from      timestamptz := nullif(btrim(coalesce(v_filter ->> 'from', '')), '')::timestamptz;
  v_to        timestamptz := nullif(btrim(coalesce(v_filter ->> 'to', '')), '')::timestamptz;
  v_sites     text[] := public.library_list(v_filter, 'sites');
  v_formats   text[] := public.library_list(v_filter, 'formats');
  v_variants  text[] := public.library_list(v_filter, 'variants');
  v_limits    text[] := public.library_list(v_filter, 'limits');
  v_sizes     text[] := public.library_list(v_filter, 'sizes');
  v_stakes    text[] := public.library_list(v_filter, 'stakes');
  v_positions text[] := public.library_list(v_filter, 'positions');
  v_pot_types text[] := public.library_list(v_filter, 'potTypes');
  v_results   text[] := public.library_list(v_filter, 'results');
  v_stacks    text[] := public.library_list(v_filter, 'stacks');
  v_anons     text[] := public.library_list(v_filter, 'anonymizations');
  v_all_in    boolean := case when jsonb_typeof(v_filter -> 'allIn') = 'boolean' then (v_filter ->> 'allIn')::boolean end;
  v_stale     boolean;
  -- The summaries answer: their months [v_lo, v_hi) (a null bound: open),
  -- every month when there is no range at all.
  v_counted   boolean;
  v_lo        date;
  v_hi        date;
  v_lo_at     timestamptz;
  v_hi_at     timestamptz;
  -- What is read hand by hand (`library_rows`' filter; null: nothing).
  v_head      jsonb;
  v_tail      jsonb;
  v_library   bigint;
  v_result    jsonb;
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  v_stale := exists (select 1 from public.library_counts_stale s where s.owner_id = v_owner);
  -- The searches `library_rows` applies to a hand itself.
  v_counted := not v_stale and not coalesce(
       cardinality(public.library_list(v_filter, 'heroCards')) > 0
    or cardinality(public.library_list(v_filter, 'heroHandClasses')) > 0
    or cardinality(public.library_list(v_filter, 'board')) > 0
    or nullif(btrim(coalesce(v_filter ->> 'player', '')), '') is not null
    or jsonb_typeof(v_filter -> 'showdown') = 'boolean'
    or nullif(btrim(coalesce(v_filter ->> 'tableName', '')), '') is not null
    or jsonb_typeof(v_filter -> 'minPot') = 'number'
    or cardinality(public.library_list(v_filter, 'showdownPositions')) > 0
    or cardinality(public.library_list(v_filter, 'winnerPositions')) > 0
    -- the filter builder's groups (2026-11-16) are read from the hands, like the searches
    or public.library_builder_where(v_filter) <> '', false);

  if v_counted and (v_from is not null or v_to is not null) then
    if v_from is not null then
      v_lo := date_trunc('month', v_from at time zone 'UTC')::date;
      if (v_lo::timestamp at time zone 'UTC') < v_from then
        v_lo := (v_lo + interval '1 month')::date;
      end if;
      v_lo_at := v_lo::timestamp at time zone 'UTC';
    end if;
    if v_to is not null then
      v_hi := date_trunc('month', v_to at time zone 'UTC')::date;
      v_hi_at := v_hi::timestamp at time zone 'UTC';
    end if;
    if v_lo is not null and v_hi is not null and v_lo >= v_hi then
      -- Not one whole month in the range.
      v_counted := false;
    else
      if v_from is not null and v_from < v_lo_at then
        v_head := v_filter || jsonb_build_object('from', v_from, 'to', v_lo_at);
      end if;
      if v_to is not null and v_hi_at < v_to then
        v_tail := v_filter || jsonb_build_object('from', v_hi_at, 'to', v_to);
      end if;
    end if;
  end if;
  if not v_counted then
    v_head := v_filter;
    v_tail := null;
  end if;

  with s as (
    -- The summaries' rows, signed (see the tables' comment), summed per key.
    select k.site, k.format, k.variant, k.limit_type, k.size, k.stake, k."position", k.pot_type, k.result,
           k.stack, k.all_in, k.anonymization, k.currency, k.currency_symbol, k.minor_units, k.small_blind,
           k.big_blind, sum(k.n)::bigint as w
    from (
      select a.site, a.game_format::text as format, a.variant, a.limit_type, a.size, a.stake, a."position",
             ''::text as pot_type, a.result, ''::text as stack, false as all_in,
             a.site_anonymization::text as anonymization, a.currency, a.currency_symbol,
             a.currency_minor_units as minor_units, a.small_blind, a.big_blind, a.hands as n
      from public.library_hand_counts a
      where v_counted
        and a.owner_id = v_owner
        and (v_lo is null or a.month >= v_lo)
        and (v_hi is null or a.month < v_hi)
        and (v_from is null and v_to is null or a.month > '-infinity'::date)
      union all
      select b.site, b.game_format::text, b.variant, b.limit_type, b.size, b.stake, b."position",
             v.pot_type, b.result, v.stack, v.all_in,
             b.site_anonymization::text, b.currency, b.currency_symbol,
             b.currency_minor_units, b.small_blind, b.big_blind, v.n
      from public.library_hero_counts b
      cross join lateral (values
        (case when b.ev_version = '' then '' else b.pot_type end,
         case when b.ev_version = '' then '' else b.stack end, false, -b.hands),
        (b.pot_type, b.stack, b.ev_version <> '', b.hands)) v(pot_type, stack, all_in, n)
      where v_counted
        and b.owner_id = v_owner
        and b.stats_version = v_stats
        and b.ev_version in ('', v_ev)
        and (v_lo is null or b.month >= v_lo)
        and (v_hi is null or b.month < v_hi)
        and (v_from is null and v_to is null or b.month > '-infinity'::date)
    ) k
    group by k.site, k.format, k.variant, k.limit_type, k.size, k.stake, k."position", k.pot_type, k.result,
             k.stack, k.all_in, k.anonymization, k.currency, k.currency_symbol, k.minor_units, k.small_blind,
             k.big_blind
    having sum(k.n) > 0
  ),
  d as (
    select s.w, s.site, s.format, s.variant, s.limit_type, s.size, s.stake, s."position", s.pot_type, s.result,
           s.stack, s.all_in, s.anonymization, s.currency, s.currency_symbol, s.minor_units, s.small_blind,
           s.big_blind
    from s
    union all
    select 1::bigint, x.site, x.format, x.variant, x.limit_type, x.size, x.stake, x."position", x.pot_type,
           x.result, x.stack, x.all_in, x.anonymization, x.currency, x.currency_symbol, x.minor_units,
           x.small_blind, x.big_blind
    from public.library_rows(v_head) x
    where v_head is not null
    union all
    select 1::bigint, x.site, x.format, x.variant, x.limit_type, x.size, x.stake, x."position", x.pot_type,
           x.result, x.stack, x.all_in, x.anonymization, x.currency, x.currency_symbol, x.minor_units,
           x.small_blind, x.big_blind
    from public.library_rows(v_tail) x
    where v_tail is not null
  ),
  r as (
    select d.*,
           cardinality(v_sites) = 0 or d.site = any (v_sites) as m_site,
           cardinality(v_formats) = 0 or d.format = any (v_formats) as m_format,
           cardinality(v_variants) = 0 or d.variant = any (v_variants) as m_variant,
           cardinality(v_limits) = 0 or d.limit_type = any (v_limits) as m_limit,
           cardinality(v_sizes) = 0 or d.size = any (v_sizes) as m_size,
           cardinality(v_stakes) = 0 or d.stake = any (v_stakes) as m_stake,
           cardinality(v_positions) = 0 or d."position" = any (v_positions) as m_position,
           cardinality(v_pot_types) = 0 or d.pot_type = any (v_pot_types) as m_pot_type,
           cardinality(v_results) = 0 or d.result = any (v_results) as m_result,
           cardinality(v_stacks) = 0 or d.stack = any (v_stacks) as m_stack,
           v_all_in is null or d.all_in = v_all_in as m_all_in,
           cardinality(v_anons) = 0 or d.anonymization = any (v_anons) as m_anon
    from d
  ),
  g as (
    select
      grouping(site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in, anonymization) as gid,
      site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in, anonymization,
      coalesce(sum(w) filter (where m_format and m_variant and m_limit and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_site,
      coalesce(sum(w) filter (where m_site and m_variant and m_limit and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_format,
      coalesce(sum(w) filter (where m_site and m_format and m_limit and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_variant,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_size and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_limit_type,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_stake and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_size,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_position
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_stake,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_position,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_result and m_stack and m_all_in and m_anon), 0) as c_pot_type,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_stack and m_all_in and m_anon), 0) as c_result,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_all_in and m_anon), 0) as c_stack,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_stack and m_anon), 0) as c_all_in,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_stack and m_all_in), 0) as c_anonymization,
      coalesce(sum(w) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                                and m_position and m_pot_type and m_result and m_stack and m_all_in and m_anon), 0) as c_total,
      min(currency) as currency,
      min(currency_symbol) as currency_symbol,
      min(minor_units) as minor_units,
      min(small_blind) as small_blind,
      min(big_blind) as big_blind
    from r
    group by grouping sets ((site), (format), (variant), (limit_type), (size), (stake), ("position"), (pot_type), (result), (stack), (all_in), (anonymization), ())
  ),
  -- `grouping()` sets a bit per argument *not* in the row's set, the first
  -- argument highest: the set of argument i (0-based, of 12) is
  -- 4095 - 2^(11 - i).
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
    'library', case when v_stale then (select count(*) from public.hands h where h.owner_id = v_owner)
                    else (select coalesce(sum(a.hands), 0) from public.library_hand_counts a where a.owner_id = v_owner) end,
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

-- The R6.2 entitlement gate, back in every re-created gated function.
select public.entitlement_gates_apply();
