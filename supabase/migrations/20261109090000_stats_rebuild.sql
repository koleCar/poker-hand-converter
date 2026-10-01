-- ===========================================================================
-- Statistics: coverage, and the read side of a server-side rebuild (F11, #44)
-- ===========================================================================
--
-- `hand_stats` is derived data. Until now the only writer was the browser,
-- right after an upload -- which leaves three ways for a library to end up with
-- hands that have no statistics:
--
--   * hands uploaded before `hand_stats` existed;
--   * a statistics write that failed after the hands themselves were saved
--     (deliberately not fatal -- see `saveHandStats` in `lib/db/stats.ts`);
--   * a `stats_version` bump, which makes every existing row obsolete at once.
--
-- The fix for all three is the same operation: find the caller's hands that have
-- no row at the current version, derive, insert. The derivation is TypeScript
-- (`lib/stats`), so it cannot run in here; what this migration adds is the two
-- reads that let it run *next to* the database instead of in a browser tab.
-- A full rebuild pulls every `phf` document, which is ~20 KB a hand; doing that
-- over a phone connection is not a feature anyone would use twice. The route
-- handler `app/api/stats/rebuild/route.ts` runs the identical function in the
-- same region as the database.
--
-- **It runs as the user, not as the service role.** Both functions below are
-- `security invoker`: the caller's own RLS on `hands` and `hand_stats` is the
-- whole ownership check, exactly as it is for `save_hand_stats`. The route holds
-- the anon key plus the caller's cookie -- the same credential the browser has
-- -- so moving the work to the server buys bandwidth and nothing else. In
-- particular it buys no privilege, which is the point.
-- ===========================================================================

begin;

-- `hands_needing_stats` walks one library in `id` order. Without this the
-- planner's choices are "every hand of every user, filtered" or "this user's
-- hands, sorted", and the second is a sort of the whole library per page.
create index if not exists hands_owner_id_idx on public.hands (owner_id, id);

-- --------------------------------------------------------------- coverage ---
--
-- What the statistics screen shows above the numbers: how many of your hands
-- the numbers are actually about.
--
-- A hand without a hero (`hero_seat is null` -- an observed table, a converter
-- that could not tell who the account holder was) produces no hero row under
-- any version, so it is counted on its own line rather than as "missing".
-- Otherwise it would be missing forever and the screen would offer a rebuild
-- that can never finish.
--
--   hands        hands that can have statistics
--   atVersion    ... and have them under `p_version`
--   stale        ... have them only under some other version (a bump)
--   missing      ... have none at all
--   withoutHero  hands that cannot have hero statistics
--   obsoleteRows rows under other versions, i.e. what `prune_hand_stats` frees
--   stakes       [{gameFormat, currency, currencyMinorUnits, smallBlind, bigBlind,
--                hands}] over the current version's hero rows, biggest first

create or replace function public.stats_coverage(p_version text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_out   jsonb;
begin
  if v_owner is null then
    raise exception 'You must be signed in to read statistics.'
      using errcode = '42501';
  end if;
  if p_version is null or btrim(p_version) = '' then
    raise exception 'stats_coverage needs a stats_version.'
      using errcode = '22023';
  end if;

  with h as (
    select
      hd.hero_seat is not null as has_hero,
      exists (
        select 1 from public.hand_stats s
        where s.hand_id = hd.id and s.stats_version = p_version
      ) as is_current,
      exists (
        select 1 from public.hand_stats s
        where s.hand_id = hd.id and s.stats_version <> p_version
      ) as has_old
    from public.hands hd
    where hd.owner_id = v_owner
  )
  select jsonb_build_object(
    'statsVersion', p_version,
    'hands',        count(*) filter (where has_hero),
    'atVersion',    count(*) filter (where has_hero and is_current),
    'stale',        count(*) filter (where has_hero and not is_current and has_old),
    'missing',      count(*) filter (where has_hero and not is_current and not has_old),
    'withoutHero',  count(*) filter (where not has_hero),
    'obsoleteRows', (
      select count(*) from public.hand_stats s
      where s.owner_id = v_owner and s.stats_version <> p_version
    ),
    -- What the library is made of, for the screen's filter. A report over
    -- cash and tournament chips together has no win rate (chips are not
    -- money), so the screen needs to know which formats and stakes exist
    -- before it can offer the reader one of them. Sorted by volume, so the
    -- first entry is the sensible default.
    'stakes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'gameFormat',         x.game_format,
               'currency',           x.currency,
               'currencyMinorUnits', x.currency_minor_units,
               'smallBlind',         x.small_blind,
               'bigBlind',           x.big_blind,
               'hands',              x.n
             ) order by x.n desc, x.big_blind), '[]'::jsonb)
      from (
        select s.game_format::text as game_format, s.currency, s.currency_minor_units,
               s.small_blind, s.big_blind, count(*) as n
        from public.hand_stats s
        where s.owner_id = v_owner and s.stats_version = p_version and s.is_hero
        group by 1, 2, 3, 4, 5
      ) x
    )
  )
  into v_out
  from h;

  return v_out;
end;
$$;

comment on function public.stats_coverage(text) is
  'How many of the caller''s hands have statistics at the given stats_version: '
  '{statsVersion, hands, atVersion, stale, missing, withoutHero, obsoleteRows, stakes}.';

revoke all on function public.stats_coverage(text) from public;
revoke all on function public.stats_coverage(text) from anon;
grant execute on function public.stats_coverage(text) to authenticated;

-- ---------------------------------------------------- hands_needing_stats ---
--
-- One page of the caller's hands that have a hero and no row at `p_version`,
-- with the document to derive from. Keyset on `id`, so a page that derives to
-- zero rows (a hero who was not dealt in) is stepped over instead of returned
-- again forever.
--
-- Capped at 200 server-side: at ~20 KB a document that is a 4 MB response,
-- which is about what one route invocation should be holding at once.

create or replace function public.hands_needing_stats(
  p_version text,
  p_after   uuid    default null,
  p_limit   integer default 100
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
    and not exists (
      select 1 from public.hand_stats s
      where s.hand_id = hd.id and s.stats_version = p_version
    )
  order by hd.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function public.hands_needing_stats(text, uuid, integer) is
  'A keyset page of the caller''s hands with a hero and no hand_stats row at the '
  'given version, with their phf. Read side of the statistics rebuild; RLS-scoped.';

revoke all on function public.hands_needing_stats(text, uuid, integer) from public;
revoke all on function public.hands_needing_stats(text, uuid, integer) from anon;
grant execute on function public.hands_needing_stats(text, uuid, integer) to authenticated;

-- ------------------------------------------------------ prune_hand_stats ---
--
-- **Bug fix.** The version in `20261006090000_hand_stats_prune.sql` selects and
-- joins on `hand_stats.id`, a column the table has never had -- its key is
-- `(hand_id, stats_version, seat)`. plpgsql only resolves that when the
-- statement first runs, so the migration applied cleanly and every call since
-- has failed with 42703. Nothing called it until the rebuild route did, which
-- is how it survived; `tests/database/stats_rebuild.test.sql` now covers it.
--
-- Same function, same contract, same reasoning (read the header of that
-- migration before changing it): it now joins on the primary key.

create or replace function public.prune_hand_stats(
  p_keep_version text,
  p_limit        integer default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner   uuid := (select auth.uid());
  v_deleted integer;
  v_cap     integer := least(greatest(coalesce(p_limit, 5000), 1), 20000);
begin
  if v_owner is null then
    raise exception 'You must be signed in to prune statistics.'
      using errcode = '42501';
  end if;

  if p_keep_version is null or btrim(p_keep_version) = '' then
    raise exception 'prune_hand_stats needs the stats_version to keep.'
      using errcode = '22023';
  end if;

  with doomed as (
    select hand_id, stats_version, seat
    from public.hand_stats
    where owner_id = v_owner
      and stats_version <> p_keep_version
    limit v_cap
  )
  delete from public.hand_stats s
  using doomed d
  where s.hand_id = d.hand_id
    and s.stats_version = d.stats_version
    and s.seat = d.seat;

  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'deleted', v_deleted,
    'more',    v_deleted >= v_cap
  );
end;
$$;

revoke all on function public.prune_hand_stats(text, integer) from public;
revoke all on function public.prune_hand_stats(text, integer) from anon;
grant execute on function public.prune_hand_stats(text, integer) to authenticated;

-- ------------------------------------------------ the report's helpers ---
--
-- **Bug fix.** `stats_summary` and `stats_graph` are `security invoker` -- on
-- purpose, so RLS scopes every row they sum -- and they call five helpers:
-- `hand_stats_filter_sql`, `hand_stats_counter_keys`, `hand_stats_money_keys`,
-- `stats_empty_summary`, `stats_empty_graph`. `20261005090000_hand_stats.sql`
-- revoked EXECUTE on all five from `authenticated` as "internal". An invoker
-- function runs with its caller's privileges, so that made both reports fail
-- for every signed-in user with "permission denied for function
-- hand_stats_filter_sql" -- the statistics screen has never worked outside a
-- superuser session, which is the only place it had been run.
--
-- Granting them back is safe because there is nothing in them to protect: each
-- one reads no table and returns a constant (a WHERE clause as text with
-- placeholders, a list of column names, an all-zero JSON shape). The thing that
-- must not be callable directly is the dynamic SQL *runner*, and there is none
-- -- the `EXECUTE ... USING` lives inside the two reports, bound to `auth.uid()`.
-- `anon` stays revoked: it cannot call the reports either.

grant execute on function public.hand_stats_filter_sql()      to authenticated;
grant execute on function public.hand_stats_counter_keys()    to authenticated;
grant execute on function public.hand_stats_money_keys()      to authenticated;
grant execute on function public.stats_empty_summary(text)    to authenticated;
grant execute on function public.stats_empty_graph(text)      to authenticated;

commit;
