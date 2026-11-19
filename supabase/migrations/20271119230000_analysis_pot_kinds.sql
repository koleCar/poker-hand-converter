-- analysis/45: the Analysis tab's Multiway and Bomb pots pages (design
-- `ideas-potkinds` variant C; the app's twins are rail-store `pot_kinds.rs`).
--
-- - analysis_bomb_hands: the reader's cash bomb pots, newest first, a page at
--   a time, in the row shape the analysis reads hands in (PHF, or the stored
--   text it is restored from: 20271114090000). The page sums them itself
--   (`lib/analysis/potKinds.ts`).
-- - analysis_multiway_summary: the hands with a multiway decision of the
--   hero's (a `-mw-` scenario, no bomb pot), their result and decisions by
--   players at the decision.
-- - analysis_pot_kind_decisions: one kind's (`mw` or `bomb`) decisions graded
--   Inaccurate or worse, most EV lost first.
--
-- Read-only, the reader's own rows (`auth.uid()`), behind the analysis
-- entitlement like every analysis reader.

create or replace function public.analysis_bomb_hands(
  p_stats_version text        default 'stats/2',
  p_before_played timestamptz default null,
  p_before_id     uuid        default null,
  p_limit         integer     default 200
)
returns table (
  id uuid, played_at timestamptz, phf jsonb, standard_text text, hand_key text, site text,
  parser_version text, source_filename text, created_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner  uuid := auth.uid();
  v_before timestamptz := coalesce(p_before_played, 'infinity'::timestamptz);
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read your bomb pots.' using errcode = '42501';
  end if;

  return query
  select hd.id,
         hd.played_at,
         public.analysis_trimmed_phf(hd.phf),
         case when hd.phf is null then hd.standard_text end,
         hd.hand_key, hd.site, hd.parser_version, hd.source_filename, hd.created_at
  from public.hand_stats s
  join public.hands hd on hd.id = s.hand_id and hd.owner_id = v_owner
  where s.owner_id = v_owner
    and s.stats_version = coalesce(nullif(btrim(p_stats_version), ''), 'stats/2')
    and s.is_hero
    and s.is_bomb_pot
    and s.game_format = 'cash'
    and (p_before_id is null
         or (coalesce(hd.played_at, '-infinity'::timestamptz), hd.id) < (v_before, p_before_id))
  order by coalesce(hd.played_at, '-infinity'::timestamptz) desc, hd.id desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$$;

comment on function public.analysis_bomb_hands(text, timestamptz, uuid, integer) is
  'analysis/45: the reader''s cash bomb pots, newest first, a page at a time (keyset on played_at, id), as hands_needing_analysis returns rows.';
revoke all on function public.analysis_bomb_hands(text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.analysis_bomb_hands(text, timestamptz, uuid, integer) to authenticated, service_role;

create or replace function public.analysis_multiway_summary(
  p_version       text,
  p_stats_version text default 'stats/2'
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner   uuid := auth.uid();
  v_stats   text := coalesce(nullif(btrim(p_stats_version), ''), 'stats/2');
  v_hands   jsonb;
  v_players jsonb;
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_multiway_summary needs an analysis_version.' using errcode = '22023';
  end if;

  with d as (
    select d.hand_id, d.grade, d.ev_loss_bb,
           least(coalesce((d.facts ->> 'players')::int, 3), 5) as players
    from public.decision_analysis d
    join public.hand_analysis a
      on a.hand_id = d.hand_id and a.analysis_version = d.analysis_version and a.owner_id = v_owner
    join public.hands h on h.id = d.hand_id and h.owner_id = v_owner and h.game_format = 'cash'
    where d.owner_id = v_owner and d.analysis_version = p_version
      and a.pot_type is distinct from 'bomb'
      and strpos(d.scenario, '-mw-') > 0
  ),
  hands as (
    select s.net_bb_milli, s.wtsd
    from (select distinct hand_id from d) x
    join public.hand_stats s
      on s.hand_id = x.hand_id and s.owner_id = v_owner and s.stats_version = v_stats and s.is_hero
  )
  select jsonb_build_object(
           'hands', count(*),
           'netBbMilli', coalesce(sum(net_bb_milli), 0),
           'showdownBbMilli', coalesce(sum(net_bb_milli) filter (where wtsd > 0), 0),
           'nonShowdownBbMilli', coalesce(sum(net_bb_milli) filter (where wtsd = 0), 0))
    into v_hands
  from hands;

  select coalesce(jsonb_agg(jsonb_build_object(
           'players', p.players, 'decisions', p.decisions, 'graded', p.graded, 'off', p.off,
           'evLossBb', p.ev_loss_bb, 'grades', p.grades) order by p.players), '[]'::jsonb)
    into v_players
  from (
    select d.players,
           count(*) as decisions,
           count(d.grade) as graded,
           count(*) filter (where d.grade in ('inaccurate', 'mistake', 'blunder')) as off,
           coalesce(sum(d.ev_loss_bb) filter (where d.grade is not null), 0) as ev_loss_bb,
           jsonb_build_array(
             count(*) filter (where d.grade = 'perfect'), count(*) filter (where d.grade = 'good'),
             count(*) filter (where d.grade = 'inaccurate'), count(*) filter (where d.grade = 'mistake'),
             count(*) filter (where d.grade = 'blunder')) as grades
    from (
      select d.hand_id, d.grade, d.ev_loss_bb, least(coalesce((d.facts ->> 'players')::int, 3), 5) as players
      from public.decision_analysis d
      join public.hand_analysis a
        on a.hand_id = d.hand_id and a.analysis_version = d.analysis_version and a.owner_id = v_owner
      join public.hands h on h.id = d.hand_id and h.owner_id = v_owner and h.game_format = 'cash'
      where d.owner_id = v_owner and d.analysis_version = p_version
        and a.pot_type is distinct from 'bomb'
        and strpos(d.scenario, '-mw-') > 0
    ) d
    group by d.players
  ) p;

  return v_hands || jsonb_build_object('byPlayers', v_players);
end;
$$;

comment on function public.analysis_multiway_summary(text, text) is
  'analysis/45: the reader''s cash hands with a multiway decision (a -mw- scenario, no bomb pot): their result, and the decisions by players at the decision.';
revoke all on function public.analysis_multiway_summary(text, text) from public, anon;
grant execute on function public.analysis_multiway_summary(text, text) to authenticated, service_role;

create or replace function public.analysis_pot_kind_decisions(
  p_version text,
  p_kind    text,
  p_limit   integer default 12
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  perform public.require_entitlement('analysis');
  if v_owner is null then
    raise exception 'You must be signed in to read the analysis.' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^analysis/[0-9]+$' then
    raise exception 'analysis_pot_kind_decisions needs an analysis_version.' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('mw', 'bomb') then
    raise exception 'Unknown pot kind: %', p_kind using errcode = '22023';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'handKey', x.hand_id, 'ord', x.ord, 'actionIndex', x.action_index, 'playedAt', x.played_at,
             'street', x.street, 'action', x.action, 'scenario', x.scenario, 'grade', x.grade,
             'evLossBb', x.ev_loss_bb, 'heroCards', x.hero_cards, 'position', x.position, 'players', x.players)
             order by x.ev_loss_bb desc nulls last, x.played_at desc nulls last), '[]'::jsonb)
    from (
      select d.hand_id, d.ord, d.action_index, h.played_at, d.street, d.action, d.scenario, d.grade,
             coalesce(d.ev_loss_bb, 0) as ev_loss_bb,
             (select string_agg(c, ' ') from jsonb_array_elements_text(
                case when jsonb_typeof(d.facts -> 'holeCards') = 'array' then d.facts -> 'holeCards' else '[]'::jsonb end) c) as hero_cards,
             d.facts ->> 'position' as position,
             (d.facts ->> 'players')::int as players
      from public.decision_analysis d
      join public.hand_analysis a
        on a.hand_id = d.hand_id and a.analysis_version = d.analysis_version and a.owner_id = v_owner
      join public.hands h on h.id = d.hand_id and h.owner_id = v_owner and h.game_format = 'cash'
      where d.owner_id = v_owner and d.analysis_version = p_version
        and d.grade in ('inaccurate', 'mistake', 'blunder')
        and case p_kind
              when 'bomb' then a.pot_type = 'bomb'
              else a.pot_type is distinct from 'bomb' and strpos(d.scenario, '-mw-') > 0
            end
      order by d.ev_loss_bb desc nulls last, h.played_at desc nulls last
      limit least(greatest(coalesce(p_limit, 12), 1), 50)
    ) x
  );
end;
$$;

comment on function public.analysis_pot_kind_decisions(text, text, integer) is
  'analysis/45: one pot kind''s (mw or bomb) decisions graded Inaccurate or worse, most EV lost first.';
revoke all on function public.analysis_pot_kind_decisions(text, text, integer) from public, anon;
grant execute on function public.analysis_pot_kind_decisions(text, text, integer) to authenticated, service_role;
