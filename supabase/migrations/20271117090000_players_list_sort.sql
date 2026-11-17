-- The Players list sorts by any of its columns (name, room, hands together,
-- result, last seen), both ways, as the desktop's store does
-- (`rail_store::players::PlayerSort`): `players_list`'s query takes
-- `sort: {column, descending}`; none keeps most hands together first. The
-- function is `20270714090000_players_screen.sql`'s with the R6.2
-- entitlement gate it was given (`20270908090000_entitlements.sql`) and the
-- order; a client that sends no sort gets the same answer as before.

create or replace function public.players_list(p_query jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
set work_mem = '64MB'
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_query    jsonb := coalesce(p_query, '{}'::jsonb);
  v_version  text := coalesce(nullif(btrim(coalesce(v_query ->> 'statsVersion', '')), ''), 'stats/1');
  v_site     text := nullif(btrim(coalesce(v_query ->> 'site', '')), '');
  v_kind     text := coalesce(nullif(btrim(coalesce(v_query ->> 'kind', '')), ''), 'all');
  v_noted    boolean := case when jsonb_typeof(v_query -> 'noted') = 'boolean' then (v_query ->> 'noted')::boolean end;
  v_limit    integer := least(greatest(coalesce(nullif(btrim(coalesce(v_query ->> 'limit', '')), '')::integer, 200), 1), 500);
  -- The order the reader picked ({column, descending}); none: most hands together first.
  v_column   text := case when jsonb_typeof(v_query -> 'sort') = 'object'
                          then nullif(btrim(coalesce(v_query #>> '{sort,column}', '')), '') end;
  v_desc     boolean := case when jsonb_typeof(v_query #> '{sort,descending}') = 'boolean'
                          then (v_query #>> '{sort,descending}')::boolean else false end;
  v_pattern  text;
  v_cash     bigint;
  v_chips    bigint;
  v_players  bigint;
  v_matching bigint;
  v_mixed    boolean;
  v_rows     jsonb;
  v_hidden   bigint;
begin
  perform public.require_entitlement('reports_full');  -- R6.2 entitlement gate
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if v_kind not in ('all', 'cash', 'chips') then
    raise exception 'No such game kind: %.', v_kind
      using errcode = '22023';
  end if;
  if v_column is not null and v_column not in ('name', 'room', 'hands', 'result', 'lastSeen') then
    raise exception 'No such column: %.', v_column
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(v_query ->> 'search', '')), '') is not null then
    v_pattern := replace(replace(replace(lower(btrim(v_query ->> 'search')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- One line per opponent of the room (every segment summed), the kind's
  -- hands together beside it; then the scope's counts and the first rows,
  -- in the reader's order (the result as the list shows it: none when the
  -- scope mixes chips with cash; a missing result or date last either way),
  -- equal values most hands together first.
  with lines as materialized (
    select a.*,
           case v_kind when 'cash' then a.cash_hands when 'chips' then a.chips_hands
                       else a.cash_hands + a.chips_hands end as together,
           coalesce(n.note, '') <> '' as has_note
    from (
      select p.site_id as site, p.player,
             coalesce(sum(p.hero_hands) filter (where p.game_format = 'cash'), 0)::bigint as cash_hands,
             coalesce(sum(p.hero_hands) filter (where p.game_format <> 'cash'), 0)::bigint as chips_hands,
             coalesce(sum(p.hero_money_hands) filter (where p.game_format = 'cash'), 0)::bigint as cash_money_hands,
             coalesce(sum(p.hero_net_bb_milli) filter (where p.game_format = 'cash'), 0)::bigint as cash_net_bb_milli,
             coalesce(sum(p.hero_money_hands) filter (where p.game_format <> 'cash'), 0)::bigint as chips_money_hands,
             coalesce(sum(p.hero_net_bb_milli) filter (where p.game_format <> 'cash'), 0)::bigint as chips_net_bb_milli,
             min(p.first_played_at) as first_seen, max(p.last_played_at) as last_seen,
             bool_and(p.seen_exact) as seen_exact
      from public.player_stats p
      where p.owner_id = v_owner
        and p.stats_version = v_version
        and p.site_anonymization = 'none'
        and (v_site is null or p.site_id = v_site)
      group by p.site_id, p.player
    ) a
    left join public.player_notes n
      on n.owner_id = v_owner and n.site = a.site and n.player = a.player
  ),
  scope as (
    select v_kind = 'all' and coalesce(sum(l.cash_hands), 0) > 0 and coalesce(sum(l.chips_hands), 0) > 0 as mixed
    from lines l
  ),
  matched as (
    select l.*,
           case when (select s.mixed from scope s) then null
                when v_kind = 'cash' then l.cash_net_bb_milli
                when v_kind = 'chips' then l.chips_net_bb_milli
                else l.cash_net_bb_milli + l.chips_net_bb_milli end as net
    from lines l
    where l.together > 0
      and (v_pattern is null or lower(l.player) like v_pattern)
      and (v_noted is null or l.has_note = v_noted)
  ),
  ranked as (
    select m.*,
           row_number() over (order by
             case when v_column = 'name' and not v_desc then lower(m.player) end asc,
             case when v_column = 'name' and v_desc then lower(m.player) end desc,
             case when v_column = 'room' and not v_desc then m.site end asc,
             case when v_column = 'room' and v_desc then m.site end desc,
             case when v_column = 'hands' and not v_desc then m.together end asc,
             case when v_column = 'hands' and v_desc then m.together end desc,
             case when v_column = 'result' and not v_desc then m.net end asc nulls last,
             case when v_column = 'result' and v_desc then m.net end desc nulls last,
             case when v_column = 'lastSeen' and not v_desc then m.last_seen end asc nulls last,
             case when v_column = 'lastSeen' and v_desc then m.last_seen end desc nulls last,
             m.together desc, m.player, m.site) as place
    from matched m
  ),
  top as (
    select r.* from ranked r
    order by r.place
    limit v_limit
  )
  select
    (select coalesce(sum(l.cash_hands), 0)::bigint from lines l),
    (select coalesce(sum(l.chips_hands), 0)::bigint from lines l),
    (select count(*) from lines l where l.together > 0),
    (select count(*) from matched),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'site', t.site, 'player', t.player, 'hands', t.together,
              'cashNetBbMilli', t.cash_net_bb_milli, 'chipsNetBbMilli', t.chips_net_bb_milli,
              'cashMoneyHands', t.cash_money_hands, 'chipsMoneyHands', t.chips_money_hands,
              -- A delete touched one of their rows: first and last seen read again.
              'firstPlayedAt', case when t.seen_exact then t.first_seen else s.first_seen end,
              'lastPlayedAt',  case when t.seen_exact then t.last_seen else s.last_seen end,
              'hasNote', t.has_note)
            order by t.place), '[]'::jsonb)
       from top t
       left join lateral (
         select min(h.played_at) as first_seen, max(h.played_at) as last_seen
         from public.hand_stats h
         where not t.seen_exact
           and h.owner_id = v_owner and h.stats_version = v_version and not h.is_hero
           and h.player = t.player and h.site_id = t.site and not h.is_bomb_pot
           and h.site_anonymization = 'none'
       ) s on true)
  into v_cash, v_chips, v_players, v_matching, v_rows;

  -- The desktop's rule (and `stats_opponents`'): a scope with chips and cash has no result.
  v_mixed := v_kind = 'all' and v_cash > 0 and v_chips > 0;
  v_rows := (select coalesce(jsonb_agg(
               (r - 'cashNetBbMilli' - 'chipsNetBbMilli' - 'cashMoneyHands' - 'chipsMoneyHands')
               || jsonb_build_object(
                    'netBbMilli', case when v_mixed then null
                                       when v_kind = 'cash' then r -> 'cashNetBbMilli'
                                       when v_kind = 'chips' then r -> 'chipsNetBbMilli'
                                       else to_jsonb((r ->> 'cashNetBbMilli')::bigint + (r ->> 'chipsNetBbMilli')::bigint) end,
                    'moneyHands', case v_kind when 'cash' then (r ->> 'cashMoneyHands')::bigint
                                              when 'chips' then (r ->> 'chipsMoneyHands')::bigint
                                              else (r ->> 'cashMoneyHands')::bigint + (r ->> 'chipsMoneyHands')::bigint end)
               order by o), '[]'::jsonb)
             from jsonb_array_elements(v_rows) with ordinality as e(r, o));

  select coalesce(sum(p.hands), 0)::bigint
    into v_hidden
    from public.player_stats p
    where p.owner_id = v_owner
      and p.stats_version = v_version
      and p.site_anonymization = 'opaque-id'
      and (v_site is null or p.site_id = v_site)
      and (v_kind = 'all' or (p.game_format = 'cash') = (v_kind = 'cash'));

  return jsonb_build_object(
    'statsVersion', v_version,
    'rows',         v_rows,
    'matching',     v_matching,
    'players',      v_players,
    'cashHands',    v_cash,
    'chipsHands',   v_chips,
    'mixedKind',    v_mixed,
    'hiddenHands',  v_hidden
  );
end;
$$;

comment on function public.players_list(jsonb) is
  'The shared Players screen''s list (R4.5c-3): opponents of rooms with real names from player_stats; p_query {search, site, kind all|cash|chips, noted, sort {column name|room|hands|result|lastSeen, descending} (none: most hands together first), limit <= 500, statsVersion}.';
