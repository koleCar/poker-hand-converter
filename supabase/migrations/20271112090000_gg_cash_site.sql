-- Plain GG cash hands an older build filed under `standard` move to `ggpoker`:
-- the web twin of the desktop store's migration 21
-- (`core/rail-store/src/site_fix.rs`).
--
-- GG's plain cash export (`Poker Hand #HD…`) is read by the standard parser on
-- purpose. Until 2026-11-10 that parser also stamped those hands with its own
-- room, so they were stored under `standard` and split from the GGPoker
-- hands of the same player (a Rush & Cash hand, `RC…`, is read by the GG
-- parser and was always `ggpoker`). Since then both parsers label a hand
-- whose id is GG's cash id (`HD` and digits) as GGPoker
-- (`is_gg_cash_hand_id`, `GG_CASH_HAND_ID`); this moves the hands stored
-- before.
--
-- Per owner, for every `standard` hand whose `site_hand_id` is `^HD[0-9]+$`:
--
--   * the hand: `site`, its key `standard:<id>` -> `ggpoker:<id>` (the key
--     the GG parser and the desktop write), and the PHF's `meta.siteId` /
--     `meta.siteName`. A hand the account already has under the new key
--     stays where it is, untouched: nothing is dropped here;
--   * its statistics rows (`hand_stats.site_id`, `hand_key`) and EV rows
--     (`hand_stats_ev.hand_key`). Their update triggers rebuild the owner's
--     report summaries and library counts, and the hands' own update
--     trigger the library counts;
--   * the analysis screen's rows, which copy the hand's site when stored:
--     rebuilt with `analysis_leak_summaries_rebuild` when the owner has any
--     for a moved hand;
--   * the owner's notes on players seen in the moved hands, unless that
--     player already has a GGPoker note.
--
-- Published hands are snapshots and keep the room they were published under.

create or replace function public.move_gg_cash_hands(p_owner uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_moved integer := 0;
  v_n integer;
begin
  create temp table if not exists gg_cash_moved (
    id      uuid primary key,
    old_key text not null,
    new_key text not null,
    players text[]
  ) on commit drop;

  for v_owner in
    select distinct h.owner_id
    from public.hands h
    where h.site = 'standard'
      and h.site_hand_id ~ '^HD[0-9]+$'
      and (p_owner is null or h.owner_id = p_owner)
    order by 1
  loop
    -- One writer of an account's summaries at a time (the summaries' own lock).
    perform pg_advisory_xact_lock(hashtextextended('report_summaries:' || v_owner::text, 0));

    truncate pg_temp.gg_cash_moved;
    insert into pg_temp.gg_cash_moved (id, old_key, new_key, players)
    select h.id, h.hand_key, 'ggpoker:' || h.site_hand_id, h.player_names
    from public.hands h
    where h.owner_id = v_owner
      and h.site = 'standard'
      and h.site_hand_id ~ '^HD[0-9]+$'
      and not exists (
        select 1 from public.hands d
        where d.owner_id = v_owner and d.hand_key = 'ggpoker:' || h.site_hand_id
      );
    get diagnostics v_n = row_count;
    continue when v_n = 0;
    v_moved := v_moved + v_n;

    update public.hands h
       set site     = 'ggpoker',
           hand_key = m.new_key,
           phf      = case
                        when jsonb_typeof(h.phf -> 'meta') = 'object'
                          then jsonb_set(jsonb_set(h.phf, '{meta,siteId}', '"ggpoker"'), '{meta,siteName}', '"GGPoker"')
                        else h.phf
                      end
      from pg_temp.gg_cash_moved m
     where h.id = m.id;

    update public.hand_stats s
       set site_id = 'ggpoker', hand_key = m.new_key
      from pg_temp.gg_cash_moved m
     where s.owner_id = v_owner and s.hand_id = m.id;

    update public.hand_stats_ev e
       set hand_key = m.new_key
      from pg_temp.gg_cash_moved m
     where e.owner_id = v_owner and e.hand_id = m.id;

    if exists (
      select 1 from public.analysis_hand_rows r
      join pg_temp.gg_cash_moved m on m.id = r.hand_id
      where r.owner_id = v_owner
    ) then
      perform public.analysis_leak_summaries_rebuild(v_owner);
    end if;

    update public.player_notes n
       set site = 'ggpoker'
     where n.owner_id = v_owner
       and n.site = 'standard'
       and n.player in (select unnest(m.players) from pg_temp.gg_cash_moved m)
       and not exists (
         select 1 from public.player_notes g
         where g.owner_id = v_owner and g.site = 'ggpoker' and g.player = n.player
       );
  end loop;

  return v_moved;
end;
$$;

comment on function public.move_gg_cash_hands(uuid) is
  'Moves the plain GG cash hands (site_hand_id HD + digits) an older parser stored under `standard` to `ggpoker`, '
  'with their keys, PHF meta, statistics and EV rows, analysis screen rows and player notes; one owner, or every owner '
  'when null. Returns the hands moved. A hand already stored under the new key is left alone. Definer; granted to nobody.';

revoke all on function public.move_gg_cash_hands(uuid) from public, anon, authenticated;

select public.move_gg_cash_hands();
