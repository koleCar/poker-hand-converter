-- ============================================================================
-- Analytics rollout safety (docs/ANALYTICS.md Step 12): the builder's facts
-- across a facts version bump.
-- ============================================================================
--
-- Step 11 (20271122110000) moved the web's facts to `facts/2` (the effective
-- stack). The builder read only the row at the client's version, so until a
-- user's facts rebuild ran, every builder-fact filter (sizes, made hands,
-- draws, kickers, opponents, position on the flop, buy-in, level, bluffs,
-- the Effective stack) matched none of their hands - on the Hands list, its
-- counts, the reports and the Analytics checker alike.
--
-- * `library_builder_where` reads each hand's row at the client's version
--   when it has one, else its newest. The facts a version adds are null on
--   an older row, so the Effective stack chip matches a hand once its facts
--   were derived at `facts/2`, and every older filter keeps matching
--   meanwhile. The rebuild (`/api/stats/rebuild`, `hands_needing_stats`'
--   `p_facts_version`, triggered by the Hands and Analytics pages and the
--   web's shell) still derives every hand at the new version.
-- * `save_hand_facts` drops a hand's rows at versions older than the one it
--   just wrote (the rows are derived; the rebuild would otherwise leave a
--   second copy of every hand's facts). Never a newer version's: a browser
--   still running the previous build writes its version beside the newer
--   row and reads its own. Owners may delete their own facts rows for it.
--
-- Safe on a database with data: functions replaced, one policy and grant;
-- no table rewrite, no index build, no lock beyond the catalog's.

-- Owners may delete their own facts rows (save_hand_facts' prune is invoker).
grant delete on public.hand_facts to authenticated;
drop policy if exists hand_facts_owner_delete on public.hand_facts;
create policy hand_facts_owner_delete on public.hand_facts
  for delete to authenticated using (owner_id = (select auth.uid()));

-- save_hand_facts: as in 20271122110000, and a saved hand's older versions dropped.
create or replace function public.save_hand_facts(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_owner    uuid := (select auth.uid());
  v_received integer;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'You must be signed in to save statistics.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_hand_facts expects a JSON array' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received > 1000 then
    raise exception 'save_hand_facts accepts at most 1000 rows per call (got %)', v_received
      using errcode = '53400';
  end if;

  with input as (
    select * from jsonb_to_recordset(p_rows) as x(
      hand_key text, facts_version text, open_tenths integer, flop_bet_pct integer, turn_bet_pct integer,
      river_bet_pct integer, flop_made smallint, turn_made smallint, river_made smallint, flop_kicker smallint,
      turn_kicker smallint, river_kicker smallint, flop_draws smallint, turn_draws smallint, players_flop smallint,
      hero_ip boolean, vs_seats text, vs_positions text, vs_players text[], buy_in_cents bigint, bounty boolean,
      tour_level integer, hero_bluff smallint, vs_bluff smallint, eff_stack_tenths integer)
  ),
  ins as (
    -- RLS on `hands` is the ownership check.
    insert into public.hand_facts (
      hand_id, owner_id, facts_version, hand_key, open_tenths, flop_bet_pct, turn_bet_pct, river_bet_pct,
      flop_made, turn_made, river_made, flop_kicker, turn_kicker, river_kicker, flop_draws, turn_draws,
      players_flop, hero_ip, vs_seats, vs_positions, vs_players, buy_in_cents, bounty, tour_level,
      hero_bluff, vs_bluff, eff_stack_tenths)
    select h.id, v_owner, i.facts_version, i.hand_key, i.open_tenths, i.flop_bet_pct, i.turn_bet_pct,
           i.river_bet_pct, i.flop_made, i.turn_made, i.river_made, i.flop_kicker, i.turn_kicker, i.river_kicker,
           coalesce(i.flop_draws, 0), coalesce(i.turn_draws, 0), coalesce(i.players_flop, 0), i.hero_ip,
           coalesce(i.vs_seats, ''), coalesce(i.vs_positions, ''), coalesce(i.vs_players, '{}'),
           i.buy_in_cents, coalesce(i.bounty, false), i.tour_level, coalesce(i.hero_bluff, 0),
           coalesce(i.vs_bluff, 0), i.eff_stack_tenths
    from input i
    join public.hands h on h.hand_key = i.hand_key
    on conflict (hand_id, facts_version) do nothing
    returning hand_id, facts_version
  ),
  -- The hands just saved at a version: their rows at any older one go (the
  -- newest version saved for a hand in this call decides).
  saved as (
    select hand_id, max(substr(facts_version, 7)::integer) as version from ins group by hand_id
  ),
  pruned as (
    delete from public.hand_facts f
    using saved s
    where f.hand_id = s.hand_id and f.owner_id = v_owner
      and substr(f.facts_version, 7)::integer < s.version
    returning 1
  )
  select (select count(*) from ins) into v_inserted
  from (select count(*) from pruned) p;
  return jsonb_build_object('received', v_received, 'inserted', v_inserted);
end;
$fn$;

comment on function public.save_hand_facts(jsonb) is
  'Saves the caller''s hands'' builder facts (hand_key resolved under RLS); a row already there at its version is kept, '
  'and a saved hand''s rows at older facts versions are dropped.';

-- library_builder_where: as in 20271122110000, the facts row the newest the hand has
-- when it has none at the client's version.
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
  -- The facts' codes (the app's facts::MADE and facts::DRAWS, in order).
  v_made  text[] := array['highCard', 'underpair', 'bottomPair', 'middlePair', 'topPair', 'overpair', 'twoPair',
                          'trips', 'set', 'straight', 'flush', 'fullHouse'];
  v_draws text[] := array['flushDraw', 'nutFlushDraw', 'oesd', 'gutshot', 'comboDraw', 'backdoorFlush'];
  sizes   text[];
  opp     text[];
  mask    bigint;
  s_name  text;
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

  -- The hand's facts (`hand_facts`, 20271116130000; the app's `facts.rs`):
  -- every condition on the one row of the version the client reads.
  parts := array[]::text[];
  n := public.library_number(p_filter, 'openMin');
  if n is not null then parts := parts || ('f.open_tenths >= ' || n || ' * 10'); end if;
  n := public.library_number(p_filter, 'openMax');
  if n is not null then parts := parts || ('f.open_tenths <= ' || n || ' * 10'); end if;
  for v, g in select * from (values ('f.flop_bet_pct', p_filter -> 'flopSizes'), ('f.turn_bet_pct', p_filter -> 'turnSizes'),
                                    ('f.river_bet_pct', p_filter -> 'riverSizes')) x(c, l) loop
    if jsonb_typeof(g) = 'array' then
      sizes := array_remove(array(select case t
          when 'small' then v || ' <= 33'
          when 'medium' then v || ' between 34 and 75'
          when 'large' then v || ' between 76 and 125'
          when 'overbet' then v || ' > 125'
        end from jsonb_array_elements_text(g) t), null);
      if cardinality(sizes) > 0 then
        parts := parts || ('(' || v || ' is not null and (' || array_to_string(sizes, ' or ') || '))');
      end if;
    end if;
  end loop;
  for v, g in select * from (values ('f.flop_made', p_filter -> 'flopMade'), ('f.turn_made', p_filter -> 'turnMade'),
                                    ('f.river_made', p_filter -> 'riverMade')) x(c, l) loop
    if jsonb_typeof(g) = 'array' then
      sizes := array(select (array_position(v_made, t) - 1)::text from jsonb_array_elements_text(g) t
                     where array_position(v_made, t) is not null);
      if cardinality(sizes) > 0 then
        parts := parts || (v || ' in (' || array_to_string(sizes, ', ') || ')');
      end if;
    end if;
  end loop;
  sizes := array_remove(array(select case t when 'top' then '1' when 'good' then '2' when 'weak' then '3' end
                              from unnest(public.library_list(p_filter, 'kickers')) t), null);
  if cardinality(sizes) > 0 then
    v := array_to_string(sizes, ', ');
    parts := parts || ('(f.flop_kicker in (' || v || ') or f.turn_kicker in (' || v || ') or f.river_kicker in (' || v || '))');
  end if;
  for v, g in select * from (values ('f.flop_draws', p_filter -> 'flopDraws'), ('f.turn_draws', p_filter -> 'turnDraws')) x(c, l) loop
    if jsonb_typeof(g) = 'array' then
      mask := coalesce((select sum(distinct 1 << (array_position(v_draws, t) - 1)) from jsonb_array_elements_text(g) t
                        where array_position(v_draws, t) is not null), 0);
      if mask <> 0 then parts := parts || ('(' || v || ' & ' || mask || ') <> 0'); end if;
    end if;
  end loop;
  sizes := array(select 'position(' || quote_literal(' ' || t || ' ') || ' in f.vs_positions) > 0'
                 from unnest(public.library_list(p_filter, 'vsPositions')) t where t ~ '^[A-Z0-9+]{1,8}$');
  if cardinality(sizes) > 0 then parts := parts || ('(' || array_to_string(sizes, ' or ') || ')'); end if;
  sizes := array_remove(array(select case t when 'ip' then 'f.hero_ip' when 'oop' then 'f.hero_ip = false' end
                              from unnest(public.library_list(p_filter, 'positionFlop')) t), null);
  if cardinality(sizes) > 0 then parts := parts || ('(' || array_to_string(sizes, ' or ') || ')'); end if;
  sizes := array_remove(array(select case t when '2' then 'f.players_flop = 2' when '3' then 'f.players_flop = 3'
                                            when '4plus' then 'f.players_flop >= 4' end
                              from unnest(public.library_list(p_filter, 'playersFlop')) t), null);
  if cardinality(sizes) > 0 then parts := parts || ('(' || array_to_string(sizes, ' or ') || ')'); end if;
  -- An opponent in the pot by their numbers over every hand (`player_stats`).
  opp := array[]::text[];
  sizes := array_remove(array(select case t
      when 'fish' then '(s.n >= 30 and s.vpip >= 40)'
      when 'reg' then '(s.n >= 30 and s.vpip between 15 and 30 and s.pfr >= s.vpip * 0.6)'
      when 'unknown' then 's.n < 30'
    end from unnest(public.library_list(p_filter, 'vsTypes')) t), null);
  if cardinality(sizes) > 0 then opp := opp || ('(' || array_to_string(sizes, ' or ') || ')'); end if;
  n := public.library_number(p_filter, 'vsVpipMin');
  if n is not null then opp := opp || ('s.vpip >= ' || n); end if;
  n := public.library_number(p_filter, 'vsVpipMax');
  if n is not null then opp := opp || ('s.vpip <= ' || n); end if;
  if cardinality(opp) > 0 then
    parts := parts || ('exists (select 1 from unnest(f.vs_players) vp(name) cross join lateral ('
      'select coalesce(sum(ps.hands), 0) as n,'
      ' coalesce(sum(ps.vpip), 0) * 100.0 / greatest(coalesce(sum(ps.vpip_opp), 0), 1) as vpip,'
      ' coalesce(sum(ps.pfr), 0) * 100.0 / greatest(coalesce(sum(ps.pfr_opp), 0), 1) as pfr'
      ' from public.player_stats ps where ps.owner_id = $4 and ps.site_id = h.site and ps.player = vp.name'
      ' and ps.stats_version = coalesce(nullif(btrim(coalesce($1 ->> ''statsVersion'', '''')), ''''), ''stats/1'')) s'
      ' where ' || array_to_string(opp, ' and ') || ')');
  end if;
  n := public.library_number(p_filter, 'buyInMin');
  if n is not null then parts := parts || ('f.buy_in_cents >= ' || n || ' * 100'); end if;
  n := public.library_number(p_filter, 'buyInMax');
  if n is not null then parts := parts || ('f.buy_in_cents <= ' || n || ' * 100'); end if;
  if jsonb_typeof(p_filter -> 'bounty') = 'boolean' then
    parts := parts || ('f.bounty = ' || (p_filter ->> 'bounty')::boolean::text);
  end if;
  sizes := array_remove(array(select case t
      when '1-5' then 'f.tour_level between 1 and 5'
      when '6-10' then 'f.tour_level between 6 and 10'
      when '11-15' then 'f.tour_level between 11 and 15'
      when '16plus' then 'f.tour_level >= 16'
    end from unnest(public.library_list(p_filter, 'levels')) t), null);
  if cardinality(sizes) > 0 then parts := parts || ('(' || array_to_string(sizes, ' or ') || ')'); end if;
  for v, s_name in select * from (values ('f.flop_bet_pct', 'flop'), ('f.turn_bet_pct', 'turn'), ('f.river_bet_pct', 'river')) x(c, s) loop
    n := public.library_number(p_filter, s_name || 'PctMin');
    if n is not null then parts := parts || (v || ' is not null and ' || v || ' >= ' || n); end if;
    n := public.library_number(p_filter, s_name || 'PctMax');
    if n is not null then parts := parts || (v || ' is not null and ' || v || ' <= ' || n); end if;
  end loop;
  for v, g in select * from (values ('f.hero_bluff', p_filter -> 'heroBluffs'), ('f.vs_bluff', p_filter -> 'vsBluffs')) x(c, l) loop
    if jsonb_typeof(g) = 'array' then
      mask := coalesce((select sum(distinct case t when 'flop' then 1 when 'turn' then 2 when 'river' then 4 else 0 end)
                        from jsonb_array_elements_text(g) t), 0);
      if mask <> 0 then parts := parts || ('(' || v || ' & ' || mask || ') <> 0'); end if;
    end if;
  end loop;
  -- The effective stack at the hero's first preflop action (20271122110000):
  -- the chips' buckets, `config/stats/stack-buckets.json`'s `filter` list.
  sizes := array(select quote_literal(t) from unnest(public.library_list(p_filter, 'effStacks')) t
                 where t ~ '^[0-9]{1,5}(-[0-9]{1,5}|\+)$');
  if jsonb_typeof(p_filter -> 'effStacks') = 'array' and jsonb_array_length(p_filter -> 'effStacks') > 0 then
    parts := parts || (case when cardinality(sizes) > 0
      then 'public.rail_stack_bucket(f.eff_stack_tenths, ''filter'') in (' || array_to_string(sizes, ', ') || ')'
      else 'false' end);
  end if;
  if cardinality(parts) > 0 then
    -- The hand's row at the version the client reads, else its newest
    -- (20271123090000): a hand whose facts the rebuild has not derived at a
    -- new version yet keeps matching on the facts it has. A fact the older
    -- row lacks is null there, so its condition matches nothing until then.
    w := w || ' and exists (select 1 from public.hand_facts f where f.hand_id = h.id and f.owner_id = $4'
              ' and f.facts_version = (select f2.facts_version from public.hand_facts f2'
              ' where f2.hand_id = h.id and f2.owner_id = $4'
              ' order by f2.facts_version = coalesce(nullif(btrim(coalesce($1 ->> ''factsVersion'', '''')), ''''), ''facts/1'') desc,'
              ' substr(f2.facts_version, 7)::integer desc limit 1)'
              ' and ' || array_to_string(parts, ' and ') || ')';
  end if;

  return w;
end;
$fn$;

-- The R6.2 entitlement gate, back in every re-created gated function.
select public.entitlement_gates_apply();
