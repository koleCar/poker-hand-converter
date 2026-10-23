-- ============================================================================
-- Session review (R5.1): after a session, the hands worth a look.
-- ============================================================================
--
-- One reader, `session_review(filter, at, gap, limit)`, for the web's
-- `/analysis/session` (the shared `packages/ui/review/` screen). It answers,
-- for ONE session:
--
--   session        its bounds, hands, tables, the result in big blinds and
--                  (one currency of cash) in money, the all-in EV adjusted
--                  result, whether it has ended, and the instants of the
--                  sessions on either side (`previousAt`, `nextAt`) to walk to;
--   analysis       how many of its hands have an analysis row at the client's
--                  `analysisVersion`, how many are graded, how many have none;
--   worst          per hand its worst graded decision of Inaccurate or worse,
--                  worst first (grade, then the EV it cost);
--   deviations     per hand its preflop decision graded against the shipped
--                  charts (`source = 'chart'`) of Inaccurate or worse - the
--                  chart plays the hero's action under 3.5 % of the time
--                  (`docs/ANALYSIS-PLAN.md` §2: anything played more often is
--                  Good or Perfect) - by the EV it cost;
--   pots           the biggest pots, in big blinds;
--   hands          what the three lists show of each hand they name.
--
-- Each list is ranked and capped here (`p_limit`, at most 50); the screen
-- shows a hand once, in the first list it is in, with badges for the others.
--
-- **What a session is** is `report_sessions`' rule (R4.5c-1, from
-- `stats_sessions`, #54), not a new one: the hero's hands under the shared
-- screens' filter (bomb pots out unless asked for), in time order across
-- every table; a break longer than the gap (default 30 minutes, 5..720)
-- starts the next one. `report_sessions` numbers every session of the
-- filter in one pass over all of the account's hands (~1 s at a million);
-- this walks the same index (`hero_report_rows_time_idx`) from one instant
-- outwards until it meets a gap on each side, so it reads only the
-- session's own hands and their two neighbours. pgTAP holds the two to the
-- same bounds, hands, tables and results.
--
-- `p_at` is any instant in the session (the list's `startedAt`): the session
-- of the latest hand at or before it, or of the first after it when there is
-- none. Without it, the latest session that has **ended** (its last hand
-- more than the gap ago): a session still being played is named in
-- `ongoing` and not reviewed unless asked for by its instant - the review is
-- for after the session (guideline §7, A10: nothing during play).
--
-- What is read, and nothing else: `hero_report_rows` (the time index), and
-- per hand of the session by key `hands`, `hand_stats_ev`, `hand_analysis`,
-- `decision_analysis`. Security invoker under RLS, plus the explicit owner,
-- so another account's hands are never seen and anon is refused. Grading is
-- the analysis library's, read as stored: nothing here grades.
-- ============================================================================

begin;

create or replace function public.session_review(
  p_filter      jsonb       default '{}'::jsonb,
  p_at          timestamptz default null,
  p_gap_minutes integer     default 30,
  p_limit       integer     default 20
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
-- Planned per call: the predicates of the groups that are not set fold away
-- (R4.5b's lesson: a cached generic plan keeps them all).
set plan_cache_mode = force_custom_plan
as $$
declare
  v_owner     uuid    := (select auth.uid());
  v_filter    jsonb   := case when jsonb_typeof(p_filter) = 'object' then p_filter else '{}'::jsonb end;
  v_version   text;
  v_ev        text;
  v_av        text;
  v_sites     text[];
  v_formats   text[];
  v_fmt_set   boolean;
  v_fmt_enum  public.game_format[];
  v_kinds     smallint[];
  v_variants  text[];
  v_limits    text[];
  v_sizes     text[];
  v_stakes    text[];
  v_positions text[];
  v_bomb      boolean;
  v_straddle  boolean;
  v_gap       interval := make_interval(mins => least(greatest(coalesce(p_gap_minutes, 30), 5), 720));
  v_limit     integer  := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_anchor    timestamptz;
  v_start     timestamptz;
  v_end       timestamptz;
  v_prev      timestamptz;
  v_next      timestamptz;
  v_t         timestamptz;
  v_from      timestamptz;
  v_times     timestamptz[];
  c_chunk     constant integer := 500;
  v_pass      integer;
  v_ongoing   jsonb := null;
  v_session   jsonb;
  v_analysis  jsonb;
  v_lists     jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to review a session.' using errcode = '42501';
  end if;

  v_version   := coalesce(nullif(btrim(coalesce(v_filter ->> 'statsVersion', '')), ''), 'stats/1');
  v_ev        := coalesce(nullif(btrim(coalesce(v_filter ->> 'evVersion', '')), ''), 'ev/1');
  v_av        := coalesce(nullif(btrim(coalesce(v_filter ->> 'analysisVersion', '')), ''), 'analysis/1');
  if v_av !~ '^analysis/[0-9]+$' then
    raise exception 'Unknown analysis version: %', v_av using errcode = '22023';
  end if;
  v_sites     := public.library_list(v_filter, 'sites');
  v_formats   := public.library_list(v_filter, 'formats');
  v_variants  := public.library_list(v_filter, 'variants');
  v_limits    := public.library_list(v_filter, 'limits');
  v_sizes     := public.library_list(v_filter, 'sizes');
  v_stakes    := public.library_list(v_filter, 'stakes');
  v_positions := public.library_list(v_filter, 'positions');
  v_bomb      := coalesce(case when jsonb_typeof(v_filter -> 'includeBombPots') = 'boolean' then (v_filter ->> 'includeBombPots')::boolean end, false);
  v_straddle  := coalesce(case when jsonb_typeof(v_filter -> 'includeStraddled') = 'boolean' then (v_filter ->> 'includeStraddled')::boolean end, true);
  -- As `report_sessions`: the formats as the enum (an unknown one matches
  -- nothing), the kinds the options let in as a list.
  v_fmt_set   := cardinality(v_formats) > 0;
  v_fmt_enum  := array(select f::public.game_format from unnest(v_formats) f
                       where f = any (enum_range(null::public.game_format)::text[]));
  v_kinds     := array(select k::smallint from generate_series(0, 7) k
                       where (v_bomb or k & 1 = 0) and (v_straddle or k & 2 = 0));

  -- 1. The anchor: one hand of the session.
  if p_at is null then
    select r.played_at into v_anchor
    from public.hero_report_rows r
    where r.owner_id = v_owner and r.stats_version = v_version and r.played_at is not null
      and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
      and (not v_fmt_set or r.game_format = any (v_fmt_enum))
      and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
      and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
      and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
      and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
      and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
      and r.kind = any (v_kinds)
    order by r.played_at desc
    limit 1;
  else
    select r.played_at into v_anchor
    from public.hero_report_rows r
    where r.owner_id = v_owner and r.stats_version = v_version and r.played_at <= p_at
      and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
      and (not v_fmt_set or r.game_format = any (v_fmt_enum))
      and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
      and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
      and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
      and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
      and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
      and r.kind = any (v_kinds)
    order by r.played_at desc
    limit 1;
    if v_anchor is null then
      select r.played_at into v_anchor
      from public.hero_report_rows r
      where r.owner_id = v_owner and r.stats_version = v_version and r.played_at > p_at
        and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
        and (not v_fmt_set or r.game_format = any (v_fmt_enum))
        and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
        and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
        and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
        and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
        and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
        and r.kind = any (v_kinds)
      order by r.played_at
      limit 1;
    end if;
  end if;

  if v_anchor is null then
    return jsonb_build_object(
      'gapMinutes', extract(epoch from v_gap)::integer / 60,
      'analysisVersion', v_av,
      'session', null,
      'ongoing', null);
  end if;

  -- 2. The bounds: from the anchor outwards along the time index, until a
  --    break longer than the gap (`report_sessions`: a hand more than the
  --    gap after the one before it starts a session). Read in chunks of
  --    `c_chunk` with a LIMIT, so each read is a short index scan: a cursor
  --    over "every hand before the anchor" is planned for all of them (a
  --    million rows sorted). Hands sharing an instant with a chunk's last
  --    one may be skipped - a gap of 0, which moves no bound. A second pass
  --    when the default's latest session has not ended: the one before it.
  for v_pass in 1 .. 2 loop
    v_start := v_anchor;
    v_prev  := null;
    v_from  := v_anchor;
    <<back>>
    loop
      select array_agg(q.played_at order by q.played_at desc) into v_times
      from (
        select r.played_at
        from public.hero_report_rows r
        where r.owner_id = v_owner and r.stats_version = v_version and r.played_at < v_from
            and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
            and (not v_fmt_set or r.game_format = any (v_fmt_enum))
            and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
            and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
            and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
            and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
            and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
            and r.kind = any (v_kinds)
        order by r.played_at desc
        limit c_chunk
      ) q;
      exit back when v_times is null;
      foreach v_t in array v_times loop
        if v_start - v_t > v_gap then
          v_prev := v_t;
          exit back;
        end if;
        v_start := v_t;
      end loop;
      exit back when cardinality(v_times) < c_chunk;
      v_from := v_times[cardinality(v_times)];
    end loop;

    v_end  := v_anchor;
    v_next := null;
    v_from := v_anchor;
    <<forward>>
    loop
      select array_agg(q.played_at order by q.played_at) into v_times
      from (
        select r.played_at
        from public.hero_report_rows r
        where r.owner_id = v_owner and r.stats_version = v_version and r.played_at > v_from
            and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
            and (not v_fmt_set or r.game_format = any (v_fmt_enum))
            and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
            and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
            and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
            and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
            and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
            and r.kind = any (v_kinds)
        order by r.played_at
        limit c_chunk
      ) q;
      exit forward when v_times is null;
      foreach v_t in array v_times loop
        if v_t - v_end > v_gap then
          v_next := v_t;
          exit forward;
        end if;
        v_end := v_t;
      end loop;
      exit forward when cardinality(v_times) < c_chunk;
      v_from := v_times[cardinality(v_times)];
    end loop;

    exit when p_at is not null or v_pass = 2 or now() - v_end > v_gap or v_prev is null;
    v_ongoing := jsonb_build_object('startedAt', v_start, 'endedAt', v_end);
    v_anchor  := v_prev;
  end loop;

  -- 3. The session's hands, then everything from them in one statement.
  with s as materialized (
    select r.hand_id, r.seat, r.played_at, r.table_name, r.kind, r.net, r.net_bb_milli,
           r.game_format, r.currency, r.currency_minor_units
    from public.hero_report_rows r
    where r.owner_id = v_owner and r.stats_version = v_version
      and r.played_at >= v_start and r.played_at <= v_end
      and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
      and (not v_fmt_set or r.game_format = any (v_fmt_enum))
      and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
      and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
      and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
      and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
      and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
      and r.kind = any (v_kinds)
  ),
  totals as (
    -- `report_sessions`' sums: an EV-cashout hand's result is not counted.
    select count(*) as hands,
           count(distinct s.table_name) as tables,
           coalesce(sum(s.net_bb_milli) filter (where s.kind & 4 = 0), 0) as net_bb_milli,
           coalesce(sum(s.net) filter (where s.kind & 4 = 0), 0) as net,
           bool_or(s.game_format = 'cash') as any_cash,
           bool_or(s.game_format <> 'cash') as any_chips,
           min(s.currency) as min_currency,
           max(s.currency) as max_currency,
           min(s.currency_minor_units)::integer as minor_units
    from s
  ),
  ev as (
    -- The all-in hands (cards to come): their EV in place of their result,
    -- as `report_open` adjusts its summary.
    select coalesce(sum(e.ev_net_bb_milli - s.net_bb_milli), 0) as delta_bb_milli,
           coalesce(sum(e.ev_net - s.net), 0) as delta_net,
           count(*) as all_in
    from s
    join public.hand_stats_ev e
      on e.hand_id = s.hand_id and e.ev_version = v_ev and e.seat = s.seat
    where e.applicable and s.kind & 4 = 0
  ),
  symbol as (
    select h.currency_symbol
    from s join public.hands h on h.id = s.hand_id
    where s.game_format = 'cash' and coalesce(h.currency_symbol, '') <> ''
    limit 1
  )
  select jsonb_build_object(
           'startedAt',    v_start,
           'endedAt',      v_end,
           'finished',     now() - v_end > v_gap,
           'previousAt',   v_prev,
           'nextAt',       v_next,
           'hands',        t.hands,
           'tables',       t.tables,
           'allInHands',   ev.all_in,
           'mixedUnitKind', coalesce(t.any_cash and t.any_chips, false),
           'mixedCurrency', coalesce(t.min_currency <> t.max_currency, false),
           'cash',          coalesce(t.any_cash and not t.any_chips, false),
           'currency',      case when t.min_currency = t.max_currency then t.min_currency end,
           'currencySymbol', (select symbol.currency_symbol from symbol),
           'currencyMinorUnits', case when t.min_currency = t.max_currency then t.minor_units end,
           -- Chips and cash: no result at all. Money: one currency of cash only.
           'netBbMilli',   case when t.any_cash and t.any_chips then null else t.net_bb_milli end,
           'evNetBbMilli', case when t.any_cash and t.any_chips then null else t.net_bb_milli + ev.delta_bb_milli end,
           'net',          case when t.any_cash and not t.any_chips and t.min_currency = t.max_currency then t.net end,
           'evNet',        case when t.any_cash and not t.any_chips and t.min_currency = t.max_currency
                                then t.net + ev.delta_net end)
    into v_session
  from totals t cross join ev;

  with s as materialized (
    select r.hand_id, r.seat, r.played_at, r.net, r.net_bb_milli, r.kind, r.pot_type
    from public.hero_report_rows r
    where r.owner_id = v_owner and r.stats_version = v_version
      and r.played_at >= v_start and r.played_at <= v_end
      and (cardinality(v_sites) = 0 or r.site_id = any (v_sites))
      and (not v_fmt_set or r.game_format = any (v_fmt_enum))
      and (cardinality(v_variants) = 0 or r.variant = any (v_variants))
      and (cardinality(v_limits) = 0 or r.limit_type = any (v_limits))
      and (cardinality(v_sizes) = 0 or r.size = any (v_sizes))
      and (cardinality(v_stakes) = 0 or r.stake = any (v_stakes))
      and (cardinality(v_positions) = 0 or r."position" = any (v_positions))
      and r.kind = any (v_kinds)
  ),
  ha as materialized (
    select s.hand_id, a.status, a.grade, a.score, a.ev_loss_bb
    from s
    join public.hand_analysis a on a.hand_id = s.hand_id and a.analysis_version = v_av
  ),
  -- Every graded decision of Inaccurate or worse in the session's hands.
  bad as materialized (
    select d.hand_id, d.ord, d.action_index, d.street, d.action, d.scenario, d.source, d.grade,
           public.analysis_grade_rank(d.grade) as rank,
           d.ev_loss_bb, d.ev_loss_pot,
           public.analysis_best_action(d.options) as best,
           case when d.chosen is not null and jsonb_typeof(d.options -> d.chosen::integer -> 'freq') = 'number'
                then (d.options -> d.chosen::integer ->> 'freq')::numeric end as chosen_freq,
           case when coalesce(d.facts ->> 'position', '') ~ '^[A-Z0-9+]{1,8}$' then d.facts ->> 'position' end as pos,
           s.played_at
    from s
    join public.decision_analysis d on d.hand_id = s.hand_id and d.analysis_version = v_av
    where d.grade in ('inaccurate', 'mistake', 'blunder')
  ),
  worst as (
    select w.*
    from (select distinct on (b.hand_id) b.*
          from bad b
          order by b.hand_id, b.rank desc, b.ev_loss_bb desc nulls last, b.ord) w
    order by w.rank desc, w.ev_loss_bb desc nulls last, w.played_at desc, w.hand_id
    limit v_limit
  ),
  deviations as (
    select w.*
    from (select distinct on (b.hand_id) b.*
          from bad b
          where b.street = 'preflop' and b.source = 'chart'
          order by b.hand_id, b.ev_loss_bb desc nulls last, b.rank desc, b.ord) w
    order by w.ev_loss_bb desc nulls last, w.rank desc, w.played_at desc, w.hand_id
    limit v_limit
  ),
  pots as (
    select s.hand_id, round(h.total_pot::numeric / h.big_blind, 2) as pot_bb, s.played_at
    from s
    join public.hands h on h.id = s.hand_id
    where h.big_blind > 0 and h.total_pot is not null
    order by h.total_pot::numeric / h.big_blind desc, s.played_at desc, s.hand_id
    limit v_limit
  ),
  named as (
    select hand_id from worst
    union
    select hand_id from deviations
    union
    select hand_id from pots
  )
  select jsonb_build_object(
    'analysis', (select jsonb_build_object(
                   'hands',     (select count(*) from s),
                   'analysed',  count(*),
                   'graded',    count(*) filter (where ha.grade is not null),
                   'notAnalysed', count(*) filter (where ha.status = 'not-analysed'))
                 from ha),
    'worst', coalesce((select jsonb_agg(jsonb_build_object(
                 'handId', w.hand_id, 'ord', w.ord, 'actionIndex', w.action_index, 'street', w.street,
                 'action', w.action, 'best', w.best, 'scenario', w.scenario, 'position', w.pos,
                 'source', w.source, 'grade', w.grade, 'evLossBb', w.ev_loss_bb, 'evLossPot', w.ev_loss_pot,
                 'chosenFreq', w.chosen_freq)
               order by w.rank desc, w.ev_loss_bb desc nulls last, w.played_at desc, w.hand_id) from worst w), '[]'::jsonb),
    'deviations', coalesce((select jsonb_agg(jsonb_build_object(
                 'handId', w.hand_id, 'ord', w.ord, 'actionIndex', w.action_index, 'street', w.street,
                 'action', w.action, 'best', w.best, 'scenario', w.scenario, 'position', w.pos,
                 'source', w.source, 'grade', w.grade, 'evLossBb', w.ev_loss_bb, 'evLossPot', w.ev_loss_pot,
                 'chosenFreq', w.chosen_freq)
               order by w.ev_loss_bb desc nulls last, w.rank desc, w.played_at desc, w.hand_id) from deviations w), '[]'::jsonb),
    'pots', coalesce((select jsonb_agg(jsonb_build_object('handId', p.hand_id, 'potBb', p.pot_bb)
               order by p.pot_bb desc, p.played_at desc, p.hand_id) from pots p), '[]'::jsonb),
    'hands', coalesce((select jsonb_object_agg(n.hand_id, jsonb_build_object(
                 'playedAt',      h.played_at,
                 'site',          h.site,
                 'stakesLabel',   h.stakes_label,
                 'gameFormat',    h.game_format,
                 'currency',      h.currency,
                 'currencySymbol', coalesce(h.currency_symbol, ''),
                 'minorUnits',    h.currency_minor_units,
                 'bigBlind',      h.big_blind,
                 'tableName',     h.table_name,
                 'position',      h.hero_position,
                 'heroCards',     to_jsonb(h.hero_cards),
                 'handClass',     h.hero_hand_class,
                 'board',         to_jsonb(h.board_cards),
                 'potType',       nullif(s.pot_type, ''),
                 'potBb',         case when h.big_blind > 0 and h.total_pot is not null
                                       then round(h.total_pot::numeric / h.big_blind, 2) end,
                 'net',           s.net,
                 'netBbMilli',    s.net_bb_milli,
                 'evNetBbMilli',  case when e.applicable then e.ev_net_bb_milli end,
                 'grade',         ha.grade,
                 'evLossBb',      ha.ev_loss_bb))
               from named n
               join s on s.hand_id = n.hand_id
               join public.hands h on h.id = n.hand_id
               left join ha on ha.hand_id = n.hand_id
               left join public.hand_stats_ev e
                 on e.hand_id = n.hand_id and e.ev_version = v_ev and e.seat = s.seat), '{}'::jsonb)
  )
  into v_lists;

  return jsonb_build_object(
    'gapMinutes',      extract(epoch from v_gap)::integer / 60,
    'analysisVersion', v_av,
    'limit',           v_limit,
    'session',         v_session,
    'ongoing',         v_ongoing,
    'analysis',        v_lists -> 'analysis',
    'worst',           v_lists -> 'worst',
    'deviations',      v_lists -> 'deviations',
    'pots',            v_lists -> 'pots',
    'hands',           v_lists -> 'hands'
  );
end;
$$;

comment on function public.session_review(jsonb, timestamptz, integer, integer) is
  'R5.1: one session of the caller''s (report_sessions'' gap rule over the shared filter; the latest ended one '
  'by default) with its summary and, ranked and capped, its worst graded decisions, its preflop deviations from '
  'the shipped charts and its biggest pots. Invoker, RLS-scoped.';

revoke all on function public.session_review(jsonb, timestamptz, integer, integer) from public, anon;
grant execute on function public.session_review(jsonb, timestamptz, integer, integer) to authenticated;

commit;
