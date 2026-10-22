-- ============================================================================
-- The library as the shared Hands screen reads it (R4.5b).
-- ============================================================================
--
-- R4.5 puts the desktop app's Hands screen (`packages/ui/screens/hands/`) on
-- the web. That screen pages a list newest first with a keyset cursor and
-- shows, beside each filter chip, how many hands that value would match with
-- the rest of the filter as it is (`rail_store::hand_list`, R2.7a). The web's
-- `search_hands` pages by offset with one value per filter, and
-- `hands_facets` counts the whole library; neither answers that. These two
-- functions do, over the same rows the app's store answers from - the hands,
-- the hero's `hand_stats` row (position, pot type, starting stack, result in
-- big blinds) and its `hand_stats_ev` row (all in with cards to come) - with
-- the app's filter vocabulary:
--
--   sites       `hands.site`
--   formats     `cash`, `tournament`, `sng`, `spin`
--   variants    `holdem`, `omaha`, ...
--   limits      `nl`, `pl`, `fl`
--   sizes       `hu` (2 seats), `6max` (3-6), `full` (7+), by `max_seats`,
--               by the players dealt in when it is under 2
--               (`rail_stats::segment::SizeClass`)
--   stakes      a cash hand's `<currency>:<big blind in minor units>`
--               (`USD:200`), `chips` for the tournament formats
--               (`rail_stats::segment::Stake`)
--   positions   the hero's (`hands.hero_position`)
--   potTypes    the hero row's `pot_type`
--   results     `won`, `lost`, `even` by the sign of `hero_profit`
--   stacks      `0-40`, `40-80`, `80-120`, `120+` big blinds, the hero's
--               starting stack (`rail_store::hand_list::STACK_DEPTHS`)
--   allIn       true / false: an applicable `hand_stats_ev` row
--   from, to    `played_at`, from inclusive, to exclusive; a bound leaves
--               out hands without a time
--
-- and what the web's library could already search by, which the store has
-- no column for yet:
--
--   heroCards        every card in the hero's hand (`hero_cards @>`)
--   heroHandClasses  the hero's class is one of these (`AKs`, `TT`)
--   board            every card on the board (`board_cards @>`)
--   player           an exact name at the table (`player_names`; never a
--                    positional room's row, which has none)
--   showdown         true: the hand went to showdown
--   sort             `newest` (default), `oldest`, `pot` (biggest first),
--                    `won` (best result first), `lost` (worst first)
--
-- `statsVersion` / `evVersion` name the rows to read, as the statistics
-- functions take them (the client's `STATS_VERSION`, `EV_VERSION`). A hand
-- whose statistics are not derived yet still lists; it matches no filter on
-- a statistic's column (position excepted: that is the hand's).
--
-- Both are security invoker: RLS on `hands`, `hand_stats` and
-- `hand_stats_ev` already scopes every read to the caller, and the explicit
-- `owner_id = auth.uid()` lets the planner use the owner's indexes.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The dimensions, stated once
-- ---------------------------------------------------------------------------
--
-- What a hand's value is in each group the hands table cannot answer with a
-- bare column, for the page's predicates. `library_rows` writes the same
-- rules out (pgTAP holds the two to the same answers).

-- The strings of `p_filter -> p_key`; empty for a missing key or a non-array.
create or replace function public.library_list(p_filter jsonb, p_key text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(x), '{}')
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_filter -> p_key) = 'array' then p_filter -> p_key else '[]'::jsonb end) as x;
$$;

-- `hu` (2 seats), `6max` (3-6), `full` (7+); by the players when the table
-- size is unusable (`rail_stats::segment::SizeClass::of`).
create or replace function public.library_size(p_max_seats smallint, p_players smallint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(case when coalesce(p_max_seats, 0) >= 2 then p_max_seats else p_players end, 0) <= 2 then 'hu'
    when case when coalesce(p_max_seats, 0) >= 2 then p_max_seats else p_players end <= 6 then '6max'
    else 'full'
  end;
$$;

-- `<currency>:<big blind>` for cash, `chips` otherwise (`Stake::key`).
create or replace function public.library_stake(p_format public.game_format, p_currency text, p_big_blind bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_format = 'cash' then p_currency || ':' || coalesce(p_big_blind, 0)::text else 'chips' end;
$$;

-- `won`, `lost`, `even`; '' without a hero.
create or replace function public.library_result(p_profit bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_profit is null then '' when p_profit > 0 then 'won' when p_profit < 0 then 'lost' else 'even' end;
$$;

-- The starting-stack band (`STACK_DEPTHS`); '' without statistics.
create or replace function public.library_stack(p_tenths integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tenths is null then ''
    when p_tenths < 400 then '0-40'
    when p_tenths < 800 then '40-80'
    when p_tenths < 1200 then '80-120'
    else '120+'
  end;
$$;

revoke all on function public.library_list(jsonb, text) from public;
revoke all on function public.library_size(smallint, smallint) from public;
revoke all on function public.library_stake(public.game_format, text, bigint) from public;
revoke all on function public.library_result(bigint) from public;
revoke all on function public.library_stack(integer) from public;
revoke execute on function public.library_list(jsonb, text) from anon;
revoke execute on function public.library_size(smallint, smallint) from anon;
revoke execute on function public.library_stake(public.game_format, text, bigint) from anon;
revoke execute on function public.library_result(bigint) from anon;
revoke execute on function public.library_stack(integer) from anon;
grant execute on function public.library_list(jsonb, text) to authenticated;
grant execute on function public.library_size(smallint, smallint) to authenticated;
grant execute on function public.library_stake(public.game_format, text, bigint) to authenticated;
grant execute on function public.library_result(bigint) to authenticated;
grant execute on function public.library_stack(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. library_rows -- the filtered rows with every dimension and match flag
-- ---------------------------------------------------------------------------
--
-- One row per hand of the caller that passes the filter's common part (the
-- dates and the searches), with each group's value and whether it matches
-- that group: the counts take, for each group, the rows matching every
-- *other* group. (The page writes its own query: one that reads the owner's
-- hands in the sort's index order and stops at the page.)

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
  m_all_in         boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_filter     jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
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
      h.big_blind
    from public.hands h
    left join public.hand_stats hs
      on hs.hand_id = h.id and hs.stats_version = v_stats and hs.is_hero
    left join public.hand_stats_ev e
      on e.hand_id = h.id and e.ev_version = v_ev and e.seat = hs.seat
    where h.owner_id = (select auth.uid())
      and (v_from is null or (h.played_at is not null and h.played_at >= v_from))
      and (v_to is null or (h.played_at is not null and h.played_at < v_to))
      and (cardinality(v_cards) = 0 or h.hero_cards @> v_cards)
      and (cardinality(v_classes) = 0 or h.hero_hand_class = any (v_classes))
      and (cardinality(v_board) = 0 or h.board_cards @> v_board)
      and (v_player is null or v_player = any (h.player_names))
      and (v_showdown is null or h.went_to_showdown = v_showdown)
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
    v_all_in is null or d.all_in = v_all_in
  from d;
end;
$$;

revoke all on function public.library_rows(jsonb) from public;
revoke execute on function public.library_rows(jsonb) from anon;
grant execute on function public.library_rows(jsonb) to authenticated;

comment on function public.library_rows(jsonb) is
  'The caller''s hands that pass a library filter''s dates and searches, with each filter group''s value and match flag (R4.5b). Internal to library_facets; RLS scopes it.';

-- ---------------------------------------------------------------------------
-- 3. library_page -- one page, keyset
-- ---------------------------------------------------------------------------
--
-- `p_after` is the last row of the page before, as this function returned it
-- in `next`: `{"value": <the sort column's value or null>, "id": <uuid>}`.
-- Rows without a value for the sort column (no time, no pot, no hero) come
-- last, in id order. The row's shape is the shared screen's `HandRow`
-- (`packages/ui/screens/hands/model.ts`) less what the web has no data for
-- (notes, tags; a room's display name is the client's).

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
as $$
declare
  v_filter jsonb := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_sort   text := coalesce(nullif(btrim(coalesce(v_filter ->> 'sort', '')), ''), 'newest');
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_col    text;
  v_type   text;
  v_desc   boolean;
  v_op     text;
  v_dir    text;
  v_has_after boolean := jsonb_typeof(p_after) = 'object' and coalesce(p_after ->> 'id', '') <> '';
  v_where  text := 'h.owner_id = (select auth.uid())';
  v_rows   jsonb;
  v_last   jsonb;
  v_more   boolean;
begin
  if (select auth.uid()) is null then
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
        on hs.hand_id = h.id and hs.is_hero
       and hs.stats_version = coalesce(nullif(btrim(coalesce($1 ->> 'statsVersion', '')), ''), 'stats/1')
      left join public.hand_stats_ev e
        on e.hand_id = h.id and e.seat = hs.seat
       and e.ev_version = coalesce(nullif(btrim(coalesce($1 ->> 'evVersion', '')), ''), 'ev/1')
      where %3$s
      order by h.%1$I %2$s nulls last, h.id %2$s
      limit $3 + 1
    ) p
  $q$, v_col, v_dir, v_where)
  into v_rows
  using v_filter, p_after, v_limit;

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

revoke all on function public.library_page(jsonb, jsonb, integer) from public;
revoke execute on function public.library_page(jsonb, jsonb, integer) from anon;
grant execute on function public.library_page(jsonb, jsonb, integer) to authenticated;

comment on function public.library_page(jsonb, jsonb, integer) is
  'One page of the caller''s library for the shared Hands screen (R4.5b): the app''s filter groups plus the web''s searches, sorted (newest by default), keyset (`p_after` = the previous page''s `next`). Rows in the screen''s HandRow shape. At most 500 a page.';

-- ---------------------------------------------------------------------------
-- 4. library_facets -- the counts beside the chips
-- ---------------------------------------------------------------------------
--
-- For each group, every value present (in the hands the dates and searches
-- leave) with the number of hands it would match given every *other* group
-- of the filter (the app's `hands_facets` rule) - 0 included, so a value the
-- reader chose keeps its chip and its label - in one pass: a grouping set per group, each counted under the
-- match flags of the other groups. `total` is what the filter matches;
-- `library` every hand of the caller.

create or replace function public.library_facets(p_filter jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to read your hands.' using errcode = '42501';
  end if;

  with r as (
    select * from public.library_rows(p_filter)
  ),
  g as (
    select
      grouping(site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in) as gid,
      site, format, variant, limit_type, size, stake, "position", pot_type, result, stack, all_in,
      count(*) filter (where m_format and m_variant and m_limit and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in) as c_site,
      count(*) filter (where m_site and m_variant and m_limit and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in) as c_format,
      count(*) filter (where m_site and m_format and m_limit and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in) as c_variant,
      count(*) filter (where m_site and m_format and m_variant and m_size and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in) as c_limit,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_stake and m_position
                         and m_pot_type and m_result and m_stack and m_all_in) as c_size,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_position
                         and m_pot_type and m_result and m_stack and m_all_in) as c_stake,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_pot_type and m_result and m_stack and m_all_in) as c_position,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_result and m_stack and m_all_in) as c_pot_type,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_stack and m_all_in) as c_result,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_all_in) as c_stack,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_stack) as c_all_in,
      count(*) filter (where m_site and m_format and m_variant and m_limit and m_size and m_stake
                         and m_position and m_pot_type and m_result and m_stack and m_all_in) as c_total,
      min(currency) as currency,
      min(currency_symbol) as currency_symbol,
      min(minor_units) as minor_units,
      min(small_blind) as small_blind,
      min(big_blind) as big_blind
    from r
    group by grouping sets ((site), (format), (variant), (limit_type), (size), (stake), ("position"),
                            (pot_type), (result), (stack), (all_in), ())
  ),
  -- `grouping()` sets a bit per argument *not* in the row's set, the first
  -- argument highest: the set of argument i (0-based, of 11) is 2047 - 2^(10 - i).
  f as (
    select
      jsonb_agg(jsonb_build_object('value', site, 'count', c_site) order by c_site desc, site)
        filter (where gid = 2047 - 1024 and site <> '') as sites,
      jsonb_agg(jsonb_build_object('value', format, 'count', c_format) order by c_format desc, format)
        filter (where gid = 2047 - 512 and format <> '') as formats,
      jsonb_agg(jsonb_build_object('value', variant, 'count', c_variant) order by c_variant desc, variant)
        filter (where gid = 2047 - 256 and variant <> '') as variants,
      jsonb_agg(jsonb_build_object('value', limit_type, 'count', c_limit) order by c_limit desc, limit_type)
        filter (where gid = 2047 - 128 and limit_type <> '') as limits,
      jsonb_agg(jsonb_build_object('value', size, 'count', c_size) order by c_size desc, size)
        filter (where gid = 2047 - 64 and size <> '') as sizes,
      jsonb_agg(jsonb_build_object('value', stake, 'count', c_stake,
                                   'currency', case when stake <> 'chips' then currency end,
                                   'currencySymbol', case when stake <> 'chips' then coalesce(currency_symbol, '') end,
                                   'minorUnits', case when stake <> 'chips' then minor_units end,
                                   'smallBlind', case when stake <> 'chips' then small_blind end,
                                   'bigBlind', case when stake <> 'chips' then big_blind end)
                order by stake = 'chips', currency, big_blind)
        filter (where gid = 2047 - 32 and stake <> '') as stakes,
      jsonb_agg(jsonb_build_object('value', "position", 'count', c_position) order by c_position desc, "position")
        filter (where gid = 2047 - 16 and "position" <> '') as positions,
      jsonb_agg(jsonb_build_object('value', pot_type, 'count', c_pot_type) order by c_pot_type desc, pot_type)
        filter (where gid = 2047 - 8 and pot_type <> '') as pot_types,
      jsonb_agg(jsonb_build_object('value', result, 'count', c_result) order by c_result desc, result)
        filter (where gid = 2047 - 4 and result <> '') as results,
      jsonb_agg(jsonb_build_object('value', stack, 'count', c_stack) order by c_stack desc, stack)
        filter (where gid = 2047 - 2 and stack <> '') as stacks,
      jsonb_agg(jsonb_build_object('value', case when all_in then '1' else '0' end, 'count', c_all_in)
                order by all_in desc)
        filter (where gid = 2047 - 1) as all_in,
      max(c_total) filter (where gid = 2047) as total
    from g
  )
  select jsonb_build_object(
    'total', coalesce(f.total, 0),
    'library', (select count(*) from public.hands h where h.owner_id = (select auth.uid())),
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
    'allIn', coalesce(f.all_in, '[]'::jsonb)
  ) into v_result
  from f;

  return v_result;
end;
$$;

revoke all on function public.library_facets(jsonb) from public;
revoke execute on function public.library_facets(jsonb) from anon;
grant execute on function public.library_facets(jsonb) to authenticated;

comment on function public.library_facets(jsonb) is
  'The counts beside the shared Hands screen''s filter chips (R4.5b): per group, each value with the hands it would match under the other groups; total (the filter) and library (every hand of the caller).';

commit;
