-- ===========================================================================
-- Opponent statistics: villain rows, their backfill, and the report (F13 / M4, #49)
-- ===========================================================================
--
-- `hand_stats` has carried a row per dealt-in seat since M1; the writer has
-- emitted hero rows only. This turns the other rows on -- **per user, opt-in**,
-- because they multiply the table about six-fold -- and adds the report that
-- reads them.
--
-- ## The two anonymization rules, restated because this is where they bite
--
-- * `positional` (Ignition / Bodog / Bovada): **no villain rows, ever.** A
--   seat called `UTG+1` is a different human every hand. Already enforced by
--   `hand_stats_positional_anonymity` and in the writer; nothing here relaxes
--   it.
-- * `opaque-id` (GGPoker, mined ACR/WPN): rows **are** written -- within one
--   session a token groups correctly, and discarding it would be irreversible
--   -- but `stats_opponents` leaves them out. Summing a hash across sessions is
--   exactly the cross-session claim `docs/DATABASE.md` ("Player identity and
--   anonymized rooms") says the UI must refuse. The report counts what it
--   left out, so the screen can say so instead of silently shrinking.
-- ===========================================================================

begin;

-- Partial, so it costs nothing until somebody turns villain rows on.
create index if not exists hand_stats_villain_idx
  on public.hand_stats (owner_id, stats_version, player)
  where not is_hero;

-- --------------------------------------------------- hands_needing_stats ---
--
-- Gains `p_villains`. With it, a hand also needs work when it is eligible for
-- villain rows (a hero, a room that is not `positional`) and has none yet --
-- which is what turning the setting on for an existing library means.
--
-- The three-argument version is dropped rather than overloaded: two candidates
-- with defaults would make a PostgREST call that names three arguments
-- ambiguous. A caller that names three gets this one with `p_villains` false,
-- which is exactly the old behaviour.

drop function if exists public.hands_needing_stats(text, uuid, integer);

create or replace function public.hands_needing_stats(
  p_version  text,
  p_after    uuid    default null,
  p_limit    integer default 100,
  p_villains boolean default false
)
returns table (id uuid, phf jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
begin
  if v_owner is null then
    raise exception 'You must be signed in to rebuild statistics.'
      using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'hands_needing_stats needs a stats_version.'
      using errcode = '22023';
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
        where s.hand_id = hd.id and s.stats_version = p_version and s.is_hero
      )
      or (
        coalesce(p_villains, false)
        and hd.site_anonymization <> 'positional'
        and not exists (
          select 1 from public.hand_stats s
          where s.hand_id = hd.id and s.stats_version = p_version and not s.is_hero
        )
      )
    )
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.hands_needing_stats(text, uuid, integer, boolean) is
  'A keyset page of the caller''s hands that need statistics at the given version '
  '(no hero row; or, with p_villains, no villain rows in a room that allows them).';

revoke all on function public.hands_needing_stats(text, uuid, integer, boolean) from public;
revoke all on function public.hands_needing_stats(text, uuid, integer, boolean) from anon;
grant execute on function public.hands_needing_stats(text, uuid, integer, boolean) to authenticated;

-- -------------------------------------------------- prune_villain_stats ---
--
-- Turning the setting off has to be able to give the storage back, or "opt
-- in" is a one-way door with a 6x bill behind it.
--
-- `security definer` on the same terms as `prune_hand_stats`, and annotated to
-- the same standard because it is the schema's second delete:
--
--   * the actor is `auth.uid()`, never an argument;
--   * it deletes one kind of row -- the caller's own **non-hero** rows -- and
--     cannot be pointed at anything else: no table, column, version or id is
--     accepted;
--   * hero rows are untouchable through it, so the caller's own statistics
--     cannot be lost by it, whatever they pass;
--   * the cap is clamped server-side;
--   * everything it removes is a pure function of `hands.phf` and comes back
--     with one rebuild.

create or replace function public.prune_villain_stats(p_limit integer default 20000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_deleted integer;
  v_cap     integer := least(greatest(coalesce(p_limit, 20000), 1), 20000);
begin
  if v_owner is null then
    raise exception 'You must be signed in to prune statistics.'
      using errcode = '42501';
  end if;

  with doomed as (
    select hand_id, stats_version, seat
    from public.hand_stats
    where owner_id = v_owner
      and not is_hero
    limit v_cap
  )
  delete from public.hand_stats s
  using doomed d
  where s.hand_id = d.hand_id
    and s.stats_version = d.stats_version
    and s.seat = d.seat
    and not s.is_hero;

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted, 'more', v_deleted >= v_cap);
end;
$$;

comment on function public.prune_villain_stats(integer) is
  'Removes the caller''s own non-hero hand_stats rows (turning opponent statistics '
  'off). Cannot touch hero rows -- see 20261123090000_villain_stats.sql.';

revoke all on function public.prune_villain_stats(integer) from public;
revoke all on function public.prune_villain_stats(integer) from anon;
grant execute on function public.prune_villain_stats(integer) to authenticated;

-- ------------------------------------------------------- stats_opponents ---
--
-- One row per opponent: the HUD a player keeps on a regular, plus **the
-- caller's own result in the hands they shared** -- "who do I win from" is
-- the question this screen exists to answer, and it is a join to the hero row
-- of the same hand, not anything stored on the villain's.
--
-- Static SQL with nullable parameters rather than `hand_stats_filter_sql()`:
-- that predicate is hard-wired to `is_hero` on purpose, and a second, villain
-- variant of it would be the drift it exists to prevent. The filters here are
-- the few that make sense for an opponent list.
--
-- Money: bb only, and none at all when the scope mixes chips with cash, for
-- the reasons `stats_summary` gives.

create or replace function public.stats_opponents(
  p_filters jsonb   default '{}'::jsonb,
  p_search  text    default null,
  p_limit   integer default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner    uuid := (select auth.uid());
  v_version  text := coalesce(nullif(btrim(coalesce(p_filters ->> 'statsVersion', '')), ''), 'stats/1');
  v_site     text := nullif(btrim(coalesce(p_filters ->> 'site', '')), '');
  v_format   public.game_format;
  v_currency text := nullif(upper(btrim(coalesce(p_filters ->> 'currency', ''))), '');
  v_big_blind bigint := nullif(btrim(coalesce(p_filters ->> 'bigBlind', '')), '')::bigint;
  v_min      integer := greatest(coalesce(nullif(btrim(coalesce(p_filters ->> 'minHands', '')), '')::integer, 1), 1);
  v_cap      integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_pattern  text;
  v_rows     jsonb;
  v_kinds    integer;
  v_hidden   bigint;
  v_total    bigint;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_filters ->> 'gameFormat', '')), '') is not null then
    v_format := (p_filters ->> 'gameFormat')::public.game_format;
  end if;
  -- A prefix search on the name. `like` metacharacters in the input are
  -- escaped, so `%` finds a player called `%`, not everybody.
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_pattern := replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with v as (
    select s.*
    from public.hand_stats s
    where s.owner_id = v_owner
      and s.stats_version = v_version
      and not s.is_hero
      and s.player <> ''
      and (v_site is null or s.site_id = v_site)
      and (v_format is null or s.game_format = v_format)
      and (v_currency is null or s.currency = v_currency)
      and (v_big_blind is null or s.big_blind = v_big_blind)
      and not s.is_bomb_pot
  )
  select
    count(distinct (v.game_format = 'cash')),
    count(*) filter (where v.site_anonymization = 'opaque-id'),
    count(*)
  into v_kinds, v_hidden, v_total
  from v;

  with v as (
    select s.*
    from public.hand_stats s
    where s.owner_id = v_owner
      and s.stats_version = v_version
      and not s.is_hero
      and s.player <> ''
      and s.site_anonymization = 'none'
      and (v_site is null or s.site_id = v_site)
      and (v_format is null or s.game_format = v_format)
      and (v_currency is null or s.currency = v_currency)
      and (v_big_blind is null or s.big_blind = v_big_blind)
      and not s.is_bomb_pot
      and (v_pattern is null or lower(s.player) like v_pattern)
  ),
  agg as (
    select
      v.site_id                                   as site,
      v.player                                    as player,
      sum(v.hands)::bigint                        as hands,
      sum(v.vpip_opp)::bigint                     as vpip_opp,
      sum(v.vpip)::bigint                         as vpip,
      sum(v.pfr_opp)::bigint                      as pfr_opp,
      sum(v.pfr)::bigint                          as pfr,
      sum(v.three_bet_opp)::bigint                as three_bet_opp,
      sum(v.three_bet)::bigint                    as three_bet,
      sum(v.fold_to_three_bet_opp)::bigint        as fold_to_three_bet_opp,
      sum(v.fold_to_three_bet)::bigint            as fold_to_three_bet,
      sum(v.cbet_flop_opp)::bigint                as cbet_flop_opp,
      sum(v.cbet_flop)::bigint                    as cbet_flop,
      sum(v.fold_to_cbet_flop_opp)::bigint        as fold_to_cbet_flop_opp,
      sum(v.fold_to_cbet_flop)::bigint            as fold_to_cbet_flop,
      sum(v.wtsd_opp)::bigint                     as wtsd_opp,
      sum(v.wtsd)::bigint                         as wtsd,
      sum(v.wsd_opp)::bigint                      as wsd_opp,
      sum(v.wsd)::bigint                          as wsd,
      sum(v.bet_flop + v.bet_turn + v.bet_river)::bigint       as bets,
      sum(v.raise_flop + v.raise_turn + v.raise_river)::bigint as raises,
      sum(v.call_flop + v.call_turn + v.call_river)::bigint    as calls,
      sum(v.fold_flop + v.fold_turn + v.fold_river)::bigint    as folds,
      max(v.played_at)                            as last_seen,
      -- The caller's own result in the hands this opponent was dealt into.
      -- `hand_stats` has one hero row per hand at a version, so this join is
      -- one-to-one and the sum cannot double count.
      coalesce(sum(h.net_bb_milli) filter (where not h.has_cashout), 0)::bigint as hero_net_bb_milli,
      count(h.*) filter (where not h.has_cashout)::bigint                        as hero_money_hands
    from v
    left join public.hand_stats h
      on h.hand_id = v.hand_id
     and h.stats_version = v.stats_version
     and h.is_hero
    group by v.site_id, v.player
    having sum(v.hands) >= v_min
  )
  select coalesce(jsonb_agg(to_jsonb(a) order by a.hands desc, a.player), '[]'::jsonb)
  into v_rows
  from (select * from agg order by hands desc, player limit v_cap) a;

  if coalesce(v_kinds, 0) > 1 then
    v_rows := (select coalesce(jsonb_agg(r - 'hero_net_bb_milli' - 'hero_money_hands'), '[]'::jsonb)
               from jsonb_array_elements(v_rows) r);
  end if;

  return jsonb_build_object(
    'statsVersion',  v_version,
    'rows',          v_rows,
    'mixedUnitKind', coalesce(v_kinds, 0) > 1,
    -- Villain rows that exist but were left out because the room's names do
    -- not survive a session. The screen says how many.
    'opaqueRows',    coalesce(v_hidden, 0),
    'villainRows',   coalesce(v_total, 0)
  );
end;
$$;

comment on function public.stats_opponents(jsonb, text, integer) is
  'One row per opponent (rooms with persistent names only): their HUD and the '
  'caller''s own bb result in the hands they shared.';

revoke all on function public.stats_opponents(jsonb, text, integer) from public;
revoke all on function public.stats_opponents(jsonb, text, integer) from anon;
grant execute on function public.stats_opponents(jsonb, text, integer) to authenticated;

commit;
