-- ============================================================================
-- Owner first: a reader's time depends only on the caller's own rows.
-- ============================================================================
--
-- Found while building R5.1: on a stack where another account held 1M hands,
-- a 7 496-hand account's `library_facets` took 38 s and `hands_facets` 6.5 s
-- (past the statement timeout, so `/library` fell back to the converter).
-- Reproduced on generated data (one account with 1 000 000 hands, their
-- 6M `hand_stats` rows with opponents and 1M `hand_stats_ev` rows, beside one
-- with 7 496): the small account's `library_facets` 16-24 s, `hands_facets`
-- 39-62 s, a filtered `library_page` 4-9 s. See docs/RAIL-PLAN.md §15 and
-- docs/DATABASE.md "Owner first".
--
-- The cause is one pattern in several places: the owner was known to the
-- query only as `(select auth.uid())` - an InitPlan, a value the planner
-- does not have when it plans. RLS adds the same InitPlan. So the planner
-- estimates "one owner's rows" as rows / distinct owners: with two accounts
-- half of every table, for the small account as for the big one. Half of
-- 1M hands and 6M `hand_stats` rows is a plan of sequential scans and hash
-- joins over *every* account's rows, with the owner applied as a filter at
-- the end - time that grows with what other accounts hold. (With many
-- accounts the same estimate turns the other way and gives the big account
-- nested loops over a million rows.)
--
--   * `library_rows` (under `library_facets`): `h.owner_id = (select
--     auth.uid())`, and its joins to `hand_stats` / `hand_stats_ev` by hand
--     only: a hash join that read all 6M `hand_stats` rows and all 1M
--     `hand_stats_ev` rows for a 7 496-hand account.
--   * `hands_facets`: no owner predicate at all, RLS only, in a SQL function -
--     thirteen sequential scans of the whole `hands` table per call.
--   * `library_page`, `search_hands`: the same InitPlan in the dynamic SQL.
--   * `stats_ev_missing`, `player_sites`, `my_player_notes`,
--     `unparsed_summary`: SQL functions with the InitPlan, or RLS only.
--   * readers that do bind the owner to a variable but let PL/pgSQL cache a
--     generic plan after five calls (`villain_counters`, `stats_summary`,
--     `stats_coverage`, `hands_since`, ...): a generic plan is planned for
--     "some owner" and a pooled connection serves every account.
--   * the global sort indexes (`hands_played_at_idx`, `hands_total_pot_idx`,
--     `hands_hero_profit_idx`, `hands_created_at_idx`): a page walked every
--     account's hands in order and filtered the owner out.
--   * and, for the big account's own pages: filters on expressions with no
--     statistics (`game_format::text`, `library_size(...)`) estimated at half
--     a percent, so a page sorted a million rows rather than walk its index
--     (5-6 minutes for "cash, 3-bet pots").
--
-- The rule now (docs/DATABASE.md): every owner-scoped reader is PL/pgSQL,
-- reads the caller once into a variable (`v_owner := auth.uid()`), filters
-- `owner_id = v_owner` on *every* owner table it reads, joins included, and
-- plans each call (`plan_cache_mode = force_custom_plan`), so the planner
-- sees the actual owner and that owner's row count and starts from the
-- owner's index range. RLS stays on every table (defence in depth): the
-- explicit predicate is the same as the policy's, so no result changes.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. hands_facets - one pass over the caller's rows
-- ---------------------------------------------------------------------------
--
-- Same keys, values and orders as before (pgTAP holds it to the previous
-- body); thirteen scans of the whole table became one grouping-sets pass over
-- the owner's rows.

create or replace function public.hands_facets()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner  uuid := auth.uid();
  v_result jsonb;
begin
  -- A grouping set per facet. `grouping()` sets a bit per argument *not* in
  -- the row's set, the first argument highest: argument i (0-based, of 12)
  -- is 4095 - 2^(11 - i); () is 4095.
  with g as (
    select
      grouping(site, hero_name, table_name, big_blind, variant, limit_type, game_format,
               hero_hand_class, street_reached, hero_position, site_anonymization, showdown_positions) as gid,
      site, hero_name, table_name, big_blind, variant, limit_type, game_format,
      hero_hand_class, street_reached, hero_position, site_anonymization, showdown_positions,
      count(*) as n,
      max(stakes_label) as label,
      max(currency) as currency,
      min(played_at) as min_at,
      max(played_at) as max_at
    from public.hands h
    where h.owner_id = v_owner
    group by grouping sets ((site), (hero_name), (table_name), (big_blind), (variant), (limit_type), (game_format),
                            (hero_hand_class), (street_reached), (hero_position), (site_anonymization),
                            (showdown_positions), ())
  )
  select jsonb_build_object(
    'total', coalesce(max(n) filter (where gid = 4095), 0),
    'sites', coalesce(jsonb_agg(jsonb_build_object('value', site, 'count', n) order by n desc, site)
                        filter (where gid = 4095 - 2048), '[]'::jsonb),
    'heroes', coalesce(jsonb_agg(jsonb_build_object('value', hero_name, 'count', n) order by n desc, hero_name)
                         filter (where gid = 4095 - 1024 and hero_name is not null), '[]'::jsonb),
    'tables', coalesce(jsonb_agg(table_name order by table_name)
                         filter (where gid = 4095 - 512 and table_name is not null), '[]'::jsonb),
    -- stakes, cheapest first
    'stakes', coalesce(jsonb_agg(jsonb_build_object('bigBlind', big_blind, 'label', label, 'currency', currency, 'count', n)
                                 order by big_blind)
                         filter (where gid = 4095 - 256 and big_blind is not null), '[]'::jsonb),
    'variants', coalesce(jsonb_agg(variant order by variant)
                           filter (where gid = 4095 - 128 and variant is not null), '[]'::jsonb),
    'limitTypes', coalesce(jsonb_agg(limit_type order by limit_type)
                             filter (where gid = 4095 - 64 and limit_type is not null), '[]'::jsonb),
    'gameFormats', coalesce(jsonb_agg(game_format::text order by game_format::text)
                              filter (where gid = 4095 - 32), '[]'::jsonb),
    'heroHandClasses', coalesce(jsonb_agg(hero_hand_class order by hero_hand_class)
                                  filter (where gid = 4095 - 16 and hero_hand_class is not null), '[]'::jsonb),
    'streets', coalesce(jsonb_agg(street_reached order by street_reached)
                          filter (where gid = 4095 - 8 and street_reached is not null), '[]'::jsonb),
    -- Hero positions carry counts: an uneven distribution is itself a useful
    -- signal ("why do I have three times as many BB hands?").
    'heroPositions', coalesce(jsonb_agg(jsonb_build_object('value', hero_position, 'count', n) order by n desc, hero_position)
                                filter (where gid = 4095 - 4 and hero_position is not null), '[]'::jsonb),
    -- Lets the UI decide whether to offer the player-name filter at all.
    'anonymizations', coalesce(jsonb_agg(jsonb_build_object('value', site_anonymization::text, 'count', n)
                                         order by n desc, site_anonymization::text)
                                 filter (where gid = 4095 - 2), '[]'::jsonb),
    -- Which villain positions are actually reachable in the stored corpus:
    -- the distinct position arrays, unnested.
    'showdownPositions', (
      select coalesce(jsonb_agg(distinct p order by p), '[]'::jsonb)
      from g g2, unnest(g2.showdown_positions) as p
      where g2.gid = 4095 - 1
    ),
    'playedAtRange', jsonb_build_object('min', max(min_at) filter (where gid = 4095),
                                        'max', max(max_at) filter (where gid = 4095)),
    'unparsedTotal', (select count(*) from public.unparsed_hands u where u.submitted_by = v_owner)
  ) into v_result
  from g;

  return v_result;
end;
$$;

comment on function public.hands_facets() is
  'Every distinct filter value the browse UI offers, for the caller''s own hands: one pass over the caller''s rows (owner first, planned per call). security invoker; the owner policy applies as well.';

-- ---------------------------------------------------------------------------
-- 2. The library (R4.5b): the owner bound, on every table read
-- ---------------------------------------------------------------------------

create or replace function public.library_rows(p_filter jsonb)
returns table (
  id               uuid,
  played_at        timestamptz,
  total_pot        bigint,
  hero_profit      bigint,
  net_bb_milli     bigint,
  ev_net           bigint,
  ev_net_bb_milli  bigint,
  site             text,
  format           text,
  variant          text,
  limit_type       text,
  size             text,
  stake            text,
  "position"       text,
  pot_type         text,
  result           text,
  stack            text,
  all_in           boolean,
  currency         text,
  currency_symbol  text,
  minor_units      smallint,
  small_blind      bigint,
  big_blind        bigint,
  anonymization    text,
  m_site           boolean,
  m_format         boolean,
  m_variant        boolean,
  m_limit          boolean,
  m_size           boolean,
  m_stake          boolean,
  m_position       boolean,
  m_pot_type       boolean,
  m_result         boolean,
  m_stack          boolean,
  m_all_in         boolean,
  m_anon           boolean
)
language plpgsql
stable
security invoker
set search_path = ''
-- Planned for each filter and each caller: a cached generic plan cannot drop
-- the predicates of the groups that are not set (R4.5b), nor know whose rows
-- it reads (owner first).
set plan_cache_mode = force_custom_plan
-- A million rows hash-join in memory rather than in sixteen batches on disk.
set work_mem = '64MB'
as $$
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
$$;

create or replace function public.library_page(
  p_filter jsonb default '{}'::jsonb,
  p_after  jsonb default null,
  p_limit  integer default 100
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
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
$$;


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
  v_owner  uuid := auth.uid();
  v_result jsonb;
begin
  if v_owner is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  with r as (
    select * from public.library_rows(p_filter)
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

-- ---------------------------------------------------------------------------
-- 3. search_hands - the owner bound in its dynamic SQL
-- ---------------------------------------------------------------------------

create or replace function public.search_hands(
  p_filters jsonb default '{}'::jsonb,
  p_limit   integer default 25,
  p_offset  integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  -- Owner first ($25): RLS scopes the rows as well, but only a bound owner
  -- lets the planner start from the owner's index range.
  v_owner       uuid    := auth.uid();
  v_site        text    := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_board       text[];
  v_hero_cards  text[];
  v_hero_class  text[];
  v_player      text    := nullif(btrim(coalesce(p_filters ->> 'player', '')), '');
  v_hero_name   text    := nullif(btrim(coalesce(p_filters ->> 'heroName', '')), '');
  v_table       text    := nullif(btrim(coalesce(p_filters ->> 'tableName', '')), '');
  v_variant     text    := nullif(btrim(coalesce(p_filters ->> 'variant', '')), '');
  v_limit_type  text    := nullif(lower(btrim(coalesce(p_filters ->> 'limitType', ''))), '');
  v_tourney     text    := nullif(btrim(coalesce(p_filters ->> 'tournamentId', '')), '');
  v_format      public.game_format;
  v_anon        public.site_anonymization;
  v_hero_pos    text[];
  v_sd_pos      text[];
  v_win_pos     text[];
  v_big_blind   bigint  := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_street      text    := nullif(btrim(coalesce(p_filters ->> 'street', '')), '');
  v_showdown    boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'showdownOnly', '')), '')::boolean, false);
  v_hero_won    boolean := coalesce(nullif(btrim(coalesce(p_filters ->> 'heroWonOnly', '')), '')::boolean, false);
  v_min_pot     bigint  := nullif(btrim(coalesce(p_filters ->> 'minPot', '')), '')::bigint;
  v_from        timestamptz := nullif(btrim(coalesce(p_filters ->> 'from', '')), '')::timestamptz;
  v_to          timestamptz := nullif(btrim(coalesce(p_filters ->> 'to', '')), '')::timestamptz;
  v_order       text;
  v_where       text;
  v_total       bigint;
  v_rows        jsonb;
  v_limit       integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset      integer := greatest(coalesce(p_offset, 0), 0);
begin
  v_board := coalesce(
    public.normalize_cards(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'board', '[]'::jsonb)))
    ), '{}'::text[]);
  v_hero_cards := coalesce(
    public.normalize_cards(
      (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'heroCards', '[]'::jsonb)))
    ), '{}'::text[]);
  v_hero_class := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'heroHandClasses', '[]'::jsonb))),
    '{}'::text[]);

  v_hero_pos := public.normalize_positions(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'heroPositions', '[]'::jsonb))));
  v_sd_pos := public.normalize_positions(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'showdownPositions', '[]'::jsonb))));
  v_win_pos := public.normalize_positions(
    (select array_agg(value) from jsonb_array_elements_text(coalesce(p_filters -> 'winnerPositions', '[]'::jsonb))));

  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;
  if nullif(btrim(coalesce(p_filters ->> 'anonymization', '')), '') is not null then
    v_anon := (p_filters ->> 'anonymization')::public.site_anonymization;
  end if;

  -- Whitelisted sort keys only; nothing from p_filters is ever interpolated.
  v_order := case coalesce(p_filters ->> 'sort', 'played_desc')
    when 'played_asc'   then 'played_at asc nulls last, id asc'
    when 'pot_desc'     then 'total_pot desc nulls last, id desc'
    when 'profit_desc'  then 'hero_profit desc nulls last, id desc'
    when 'profit_asc'   then 'hero_profit asc nulls last, id asc'
    when 'created_desc' then 'created_at desc, id desc'
    else 'played_at desc nulls last, id desc'
  end;

  -- Every parameter is explicitly cast: EXECUTE ... USING cannot infer a type
  -- from `$n IS NULL` alone, and an untyped `||` would be ambiguous.
  --
  -- `heroPositions` / `showdownPositions` / `winnerPositions` use `&&`
  -- (overlap), not `@>` (containment): asking for "hero was on the button or
  -- the cutoff" is a union, and a hand can only ever have one hero position, so
  -- containment of a two-element array would match nothing.
  v_where := $w$
    where h.owner_id = $25::uuid
      and ($1::text is null or h.site = $1::text)
      and (cardinality($2::text[]) = 0 or h.board_cards @> $2::text[])
      and (cardinality($3::text[]) = 0 or h.hero_cards  @> $3::text[])
      and (cardinality($4::text[]) = 0 or h.hero_hand_class = any($4::text[]))
      and ($5::text is null or h.player_names @> array[$5::text])
      and ($6::text is null or h.hero_name = $6::text)
      and ($7::text is null or h.table_name ilike '%' || $7::text || '%')
      and ($8::text is null or h.variant = $8::text)
      and ($9::public.game_format is null or h.game_format = $9::public.game_format)
      and ($10::bigint is null or h.big_blind = $10::bigint)
      and ($11::text is null or h.street_reached = $11::text)
      and ($12::boolean is false or h.went_to_showdown)
      and ($13::boolean is false or h.hero_profit > 0)
      and ($14::bigint is null or h.total_pot >= $14::bigint)
      and ($15::timestamptz is null or h.played_at >= $15::timestamptz)
      and ($16::timestamptz is null or h.played_at <= $16::timestamptz)
      and ($17::text is null or h.limit_type = $17::text)
      and ($18::text is null or h.tournament_id = $18::text)
      and (cardinality($19::text[]) = 0 or h.hero_position = any($19::text[]))
      and (cardinality($20::text[]) = 0 or h.showdown_positions && $20::text[])
      and (cardinality($21::text[]) = 0 or h.winner_positions  && $21::text[])
      and ($22::public.site_anonymization is null
           or h.site_anonymization = $22::public.site_anonymization)
  $w$;

  execute 'select count(*) from public.hands h ' || v_where
    into v_total
    using v_site, v_board, v_hero_cards, v_hero_class, v_player, v_hero_name,
          v_table, v_variant, v_format, v_big_blind, v_street, v_showdown,
          v_hero_won, v_min_pot, v_from, v_to, v_limit_type, v_tourney,
          v_hero_pos, v_sd_pos, v_win_pos, v_anon,
          v_offset, v_limit, v_owner;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(x) order by %1$s), '[]'::jsonb)
    from (
      select
        h.id, h.hand_key, h.site, h.site_hand_id, h.variant, h.limit_type,
        h.game_format, h.tournament_id, h.site_anonymization,
        h.currency, h.currency_minor_units, h.currency_symbol,
        h.small_blind, h.big_blind, h.ante, h.stakes_label,
        h.table_name, h.max_seats, h.played_at,
        h.hero_name, h.hero_seat, h.hero_position, h.hero_cards, h.hero_hand_class,
        h.board_cards, h.player_names, h.player_positions, h.player_count,
        h.street_reached, h.went_to_showdown, h.total_pot, h.rake, h.hero_profit,
        h.winners, h.winner_positions, h.showdown_positions,
        h.schema_version, h.parser_version, h.source_filename, h.created_at
      from public.hands h
      %2$s
      order by %1$s
      offset $23::integer limit $24::integer
    ) x
  $q$, v_order, v_where)
    into v_rows
    using v_site, v_board, v_hero_cards, v_hero_class, v_player, v_hero_name,
          v_table, v_variant, v_format, v_big_blind, v_street, v_showdown,
          v_hero_won, v_min_pot, v_from, v_to, v_limit_type, v_tourney,
          v_hero_pos, v_sd_pos, v_win_pos, v_anon,
          v_offset, v_limit, v_owner;

  return jsonb_build_object(
    'total',  v_total,
    'limit',  v_limit,
    'offset', v_offset,
    'rows',   v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The small readers: the owner bound instead of an InitPlan
-- ---------------------------------------------------------------------------

create or replace function public.stats_ev_missing(p_version text, p_ev_version text)
returns bigint
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
    select count(*)
    from public.hero_report_rows r
    where r.owner_id = v_owner
      and r.stats_version = p_version
      and not exists (
        select 1 from public.hand_stats_ev e
        where e.owner_id = v_owner and e.ev_version = p_ev_version
          and e.hand_id = r.hand_id));
end;
$$;

create or replace function public.player_sites(p_stats_version text default null)
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
    select coalesce(jsonb_agg(s.site_id order by s.site_id), '[]'::jsonb)
    from (
      select distinct p.site_id
      from public.player_stats p
      where p.owner_id = v_owner
        and p.stats_version = coalesce(nullif(btrim(coalesce(p_stats_version, '')), ''), 'stats/1')
        and p.site_anonymization = 'none'
    ) s);
end;
$$;

create or replace function public.my_player_notes(p_site text default null)
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
    select coalesce(jsonb_agg(jsonb_build_object(
             'site', n.site, 'player', n.player, 'note', n.note,
             'tags', to_jsonb(n.tags), 'updatedAt', n.updated_at
           ) order by n.updated_at desc), '[]'::jsonb)
    from public.player_notes n
    where n.owner_id = v_owner
      and (p_site is null or n.site = p_site));
end;
$$;

-- `unparsed_hands` is one table for every account (the failure corpus,
-- deduplicated by fingerprint); a caller reads the rows it submitted. The
-- view `unparsed_gaps` groups the whole table under RLS, so the summary
-- writes the view's grouping out over the caller's rows (the same columns,
-- in the view's order, so `to_jsonb` gives the same keys).
create or replace function public.unparsed_summary(p_limit integer default 50)
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
    with mine as materialized (
      select * from public.unparsed_hands u where u.submitted_by = v_owner
    )
    select jsonb_build_object(
      'total',       (select count(*) from mine),
      'occurrences', (select coalesce(sum(occurrences), 0) from mine),
      'byStatus', (
        select coalesce(jsonb_object_agg(status::text, n), '{}'::jsonb)
        from (select status, count(*) as n from mine group by status) s
      ),
      'gaps', (
        select coalesce(jsonb_agg(to_jsonb(g) order by g.total_occurrences desc), '[]'::jsonb)
        from (
          select * from (
            select coalesce(m.detected_site, '(unknown)') as detected_site,
                   m.stage,
                   m.reason,
                   m.status,
                   count(*) as distinct_hands,
                   sum(m.occurrences) as total_occurrences,
                   min(m.first_seen_at) as first_seen_at,
                   max(m.last_seen_at) as last_seen_at,
                   count(*) filter (where m.origin = 'desktop') as desktop_hands,
                   coalesce(array_agg(distinct m.guessed_site order by m.guessed_site)
                              filter (where m.guessed_site is not null), '{}'::text[]) as guessed_sites
            from mine m
            group by coalesce(m.detected_site, '(unknown)'), m.stage, m.reason, m.status
          ) v
          order by v.total_occurrences desc
          limit least(greatest(coalesce(p_limit, 50), 1), 500)
        ) g
      )
    ));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Readers that bind the owner already: plan every call
-- ---------------------------------------------------------------------------
--
-- PL/pgSQL caches a statement's plan and, from the sixth call on, may keep a
-- generic one - planned for "an owner", with the estimate of an average
-- account - and PostgREST's pooled connections serve every account. These
-- already filter `owner_id = v_owner` on every table; planned per call they
-- keep their owner's plan. (R4.5c-1's readers and `players_list`,
-- `player_profile`, `stats_opponents` set it already.)

alter function public.villain_counters(jsonb, jsonb) set plan_cache_mode = force_custom_plan;
alter function public.hands_since(timestamptz, uuid, integer) set plan_cache_mode = force_custom_plan;
alter function public.stats_coverage(text) set plan_cache_mode = force_custom_plan;
alter function public.stats_summary(jsonb) set plan_cache_mode = force_custom_plan;
alter function public.stats_graph(jsonb, integer) set plan_cache_mode = force_custom_plan;
alter function public.stats_breakdown(jsonb, text) set plan_cache_mode = force_custom_plan;
alter function public.stats_sessions(jsonb, integer) set plan_cache_mode = force_custom_plan;


-- `hands_needing_stats` (the rebuild route's cursor): its three "is there a
-- row" probes looked a hand up by `hand_id` alone in indexes every account
-- shares; with the owner they probe the owner's own index range (the hero's
-- row by `hand_stats_owner_hero_cover_idx`, index only).
create or replace function public.hands_needing_stats(
  p_version    text,
  p_after      uuid    default null,
  p_limit      integer default 100,
  p_villains   boolean default false,
  p_ev_version text    default null
)
returns table (id uuid, phf jsonb)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'You must be signed in to rebuild statistics.' using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'hands_needing_stats needs a stats_version.' using errcode = '22023';
  end if;

  return query
  select hd.id, hd.phf
  from public.hands hd
  where hd.owner_id = v_owner
    and hd.hero_seat is not null
    and (p_after is null or hd.id > p_after)
    and (
      not exists (
        select 1 from public.hand_stats s
        where s.owner_id = v_owner and s.stats_version = p_version and s.is_hero and s.hand_id = hd.id)
      or (
        coalesce(p_villains, false)
        and hd.site_anonymization <> 'positional'
        and not exists (
          select 1 from public.hand_stats s
          where s.hand_id = hd.id and s.stats_version = p_version and s.owner_id = v_owner and not s.is_hero))
      or (
        p_ev_version is not null
        and not exists (
          select 1 from public.hand_stats_ev e
          where e.hand_id = hd.id and e.ev_version = p_ev_version and e.owner_id = v_owner))
    )
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Indexes and statistics that start from the owner
-- ---------------------------------------------------------------------------
--
-- Every sort the library and `search_hands` page by, led by the owner: the
-- global `hands_played_at_idx`, `hands_total_pot_idx`, `hands_hero_profit_idx`
-- and `hands_created_at_idx` let a page walk every account's hands in that
-- order and filter the owner out (a big account's pot-sorted page read the
-- small account's hands first, and the other way round). The owner-led
-- `(owner_id, played_at desc nulls last)` already serves "newest"; "oldest"
-- and "worst result" are ascending with nulls last, which a backward scan
-- of a descending index does not give.
create index hands_owner_played_asc_idx on public.hands (owner_id, played_at asc nulls last, id);
create index hands_owner_pot_idx on public.hands (owner_id, total_pot desc nulls last, id desc);
create index hands_owner_profit_desc_idx on public.hands (owner_id, hero_profit desc nulls last, id desc);
create index hands_owner_profit_asc_idx on public.hands (owner_id, hero_profit asc nulls last, id);
drop index if exists public.hands_played_at_idx;
drop index if exists public.hands_total_pot_idx;
drop index if exists public.hands_hero_profit_idx;
-- "Recently imported": `hands_owner_created_idx` (owner_id, created_at, id) read
-- backwards is the owner's.
drop index if exists public.hands_created_at_idx;

-- What the library's counts read of a hand and of its hero row, so a
-- million-hand account's counts read two narrow index ranges instead of
-- every column of its hands and every seat's statistics row (index only:
-- `hands` holds the standard text inline, `hand_stats` six rows a hand with
-- opponents on). The hero's row by hand is also what `library_page` and
-- `hands_needing_stats` probe.
create index hands_owner_library_idx on public.hands (owner_id)
  include (id, played_at, total_pot, hero_profit, site, game_format, variant, limit_type, max_seats, player_count,
           currency, currency_symbol, currency_minor_units, small_blind, big_blind, hero_position, site_anonymization);
create index hand_stats_owner_hero_cover_idx on public.hand_stats (owner_id, stats_version, hand_id)
  include (seat, net_bb_milli, pot_type, starting_stack_bb_tenths)
  where is_hero;

-- The library's groups as the page writes them (a cast, a coalesce, the
-- dimension helpers): without statistics on the expressions the planner
-- guesses half a percent per value, sorts a million rows for a filter half of
-- them match, and reads them all. With these it walks the sort's index and
-- stops at the page.
create statistics public.hands_library_groups on
  (game_format::text), (coalesce(variant, '')), (coalesce(limit_type, '')), (coalesce(hero_position, '')),
  (site_anonymization::text), (public.library_size(max_seats, player_count)),
  (public.library_stake(game_format, currency, big_blind)), (public.library_result(hero_profit))
  from public.hands;
create statistics public.hand_stats_library_groups on
  (coalesce(pot_type, '')), (public.library_stack(starting_stack_bb_tenths))
  from public.hand_stats;

commit;
