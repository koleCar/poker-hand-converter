-- ===========================================================================
-- Opponents' counters for exactly the players being analysed (analysis/20)
-- ===========================================================================
--
-- The per-villain range adjustment (`frontend/src/lib/analysis/villain.ts`,
-- docs/ANALYSIS-PLAN.md §10 2026-10-10) read its counters from
-- `stats_opponents`, which is the opponents panel's report: it returns the
-- 200 biggest samples and nothing else. A learner with more than 200
-- opponents of 30+ hands got the population range for everybody past the
-- cap, silently.
--
-- `villain_counters` answers the analysis' actual question instead: "these
-- players appear in the hands I am about to analyse -- what are their
-- counters?" The client collects the opponents of a batch of hands and asks
-- for them by key, so there is no cap on how many opponents a library can
-- have, only on how many keys one call may name.
--
-- Same rules as `stats_opponents`, deliberately:
--
--   * **The caller's own rows only.** `security invoker`, so `hand_stats`'
--     RLS applies, and `owner_id = auth.uid()` on top of it so the plan uses
--     `hand_stats_villain_idx` and a policy change cannot widen it.
--   * **Rooms with persistent names only** (`site_anonymization = 'none'`):
--     an `opaque-id` hash summed across sessions is the cross-session claim
--     `docs/DATABASE.md` ("Player identity and anonymized rooms") refuses;
--     `positional` rooms have no villain rows at all.
--   * No bomb pots; the same `statsVersion` / `gameFormat` / `minHands`
--     filters, read the same way.
--
-- Read-only: no table grant changes, nothing `security definer`.
-- ===========================================================================

begin;

create or replace function public.villain_counters(
  p_players jsonb,
  p_filters jsonb default '{}'::jsonb
)
returns table (
  site     text,
  player   text,
  hands    bigint,
  vpip_opp bigint,
  vpip     bigint,
  pfr      bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_version text;
  v_format  public.game_format;
  v_min     integer;
  v_count   integer;
  v_item    jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'villain_counters: p_filters must be an object.'
      using errcode = '22023';
  end if;
  if p_players is null or jsonb_typeof(p_players) <> 'array' then
    raise exception 'villain_counters: p_players must be an array of {site, player}.'
      using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_players);
  if v_count > 500 then
    raise exception 'villain_counters takes at most 500 players per call (got %).', v_count
      using errcode = '22023';
  end if;
  for v_item in select e from jsonb_array_elements(p_players) e loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'site') is distinct from 'string'
       or jsonb_typeof(v_item -> 'player') is distinct from 'string'
       or btrim(v_item ->> 'site') = ''
       or (v_item ->> 'player') = ''
       or length(v_item ->> 'site') > 64
       or length(v_item ->> 'player') > 256 then
      raise exception 'villain_counters: every player must be {site, player}, both non-empty strings.'
        using errcode = '22023';
    end if;
  end loop;

  v_version := coalesce(nullif(btrim(coalesce(v_filters ->> 'statsVersion', '')), ''), 'stats/1');
  if nullif(btrim(coalesce(v_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (v_filters ->> 'gameFormat')::public.game_format;
  end if;
  v_min := greatest(coalesce(nullif(btrim(coalesce(v_filters ->> 'minHands', '')), '')::integer, 1), 1);

  return query
  with wanted as (
    select distinct e ->> 'site' as site, e ->> 'player' as player
    from jsonb_array_elements(p_players) e
  )
  select
    s.site_id                as site,
    s.player                 as player,
    sum(s.hands)::bigint     as hands,
    sum(s.vpip_opp)::bigint  as vpip_opp,
    sum(s.vpip)::bigint      as vpip,
    sum(s.pfr)::bigint       as pfr
  from wanted w
  join public.hand_stats s
    on s.site_id = w.site
   and s.player = w.player
  where s.owner_id = v_owner
    and s.stats_version = v_version
    and not s.is_hero
    and s.player <> ''
    and s.site_anonymization = 'none'
    and (v_format is null or s.game_format = v_format)
    and not s.is_bomb_pot
  group by s.site_id, s.player
  having sum(s.hands) >= v_min
  order by s.site_id, s.player;
end;
$$;

comment on function public.villain_counters(jsonb, jsonb) is
  'The caller''s own counters (hands, vpip_opp, vpip, pfr) for the named opponents '
  '(at most 500 {site, player} keys per call; rooms with persistent names only, '
  'no bomb pots) -- the analysis'' per-villain ranges, without stats_opponents'' cap of 200.';

revoke all on function public.villain_counters(jsonb, jsonb) from public;
revoke all on function public.villain_counters(jsonb, jsonb) from anon;
grant execute on function public.villain_counters(jsonb, jsonb) to authenticated;

commit;
