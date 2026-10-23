-- Statistics: Ignition seats above 24 and a per-account insert budget
-- (docs/RAIL-PLAN.md R4.4, findings F1 and F2).
--
-- F1 - seat numbers past 24
-- -------------------------
-- A PHF seat is the room's own seat number, a `u32` in the Rust model
-- (`core/rail-core/src/phf/mod.rs`, "Seats ... are `u32`") and a plain number
-- in the TypeScript one; no parser bounds it. Ignition's tournament hands
-- number seats past 24 (25 to 1 227 in the corpus: 15 hands in 5 MTT files).
-- The server already stores such a hand: `hands.hero_seat` is a bare
-- `smallint` and `hand_row_problem` checks no seat. Four per-seat columns
-- assumed 0-24 (or 1-24) and refused it:
--   * `hand_stats.seat` (`hand_stats_seat_ok`). The statistics rebuild sends
--     a page of hands to `save_hand_stats` at once, so one such hand failed
--     the whole page - and, "missing" being computed, the same page on every
--     later run: no hand after it ever got statistics (F1).
--   * `hand_stats_ev.seat`, the same rows' EV sibling.
--   * `hand_analysis.hero_seat`: a tournament hand is written as a
--     "not-analysed" row that still carries its hero seat, so an Ignition MTT
--     hand failed its analysis batch the same way.
--   * `comments.anchor_seat`: a comment anchored to a seat of a shared hand.
-- Each now takes what the column's type takes: `smallint`, so up to 32 767,
-- the bound `hands.hero_seat` has always had. No tighter bound is invented:
-- the rooms do not publish one, and a row above `smallint` fails the cast
-- (22003) exactly where `hands` would. The lower bounds stay (0 for the
-- statistics and analysis rows, 1 for the forum anchor). Counts are not seat
-- numbers and stay as they are (`max_seats` 2-24, `player_count` 1-24).
--
-- Each constraint is dropped and re-added `not valid`, then validated: the
-- new one is wider, so every stored row passes, and `validate constraint`
-- scans without the ACCESS EXCLUSIVE lock a plain `add` would hold for the
-- scan.
--
-- F2 - one statistics budget for every account
-- --------------------------------------------
-- `hand_stats` and `hand_stats_ev` inserts charged one site-wide bucket,
-- `hand_stats_insert`, 200 000 rows per 10 minutes for everybody together. A
-- 1 000 000-hand library is ~2 000 000 rows (hero + EV; ~7 000 000 with
-- villain rows): 100 minutes of the whole site's budget, during which no
-- other account's statistics could be written - R4.2's `hands_insert`
-- problem again. Now each account has its own buckets, as `ingest_hands`
-- does, and the global one stays only as a ceiling far above them:
--
--   `hand_stats_insert:<uid>`      1 000 000 rows / 10 min
--   `hand_stats_insert_day:<uid>` 10 000 000 rows / day
--   `hand_stats_insert`            3 000 000 rows / 10 min, everyone
--
-- Why these numbers:
--   * The rebuild route writes from one tab, one slice at a time; measured on
--     a local stack (R4.4, the whole corpus with villain rows) it writes ~1 250
--     rows a second, ~750 000 per 10 minutes. The per-account budget is above
--     that, so a single rebuild is never slowed by it: a 1 000 000-hand
--     library is ~30 minutes hero-only and ~1.5 hours with villain rows, paced
--     by the route, where the global bucket made it 1.7 and ~6 hours *and*
--     locked everyone else out. What it stops is one account writing from
--     many tabs or scripts at once (~1 700 rows/s at most).
--   * The day budget: an account's rows are bounded by its hands, but not per
--     version (`stats_version` is free text, `stats/N`), so without it one
--     account could write ~144 000 000 rows a day. 10 000 000 is a full
--     rebuild of a 1 000 000-hand library with villain rows and EV (~7 000 000)
--     with room to spare; the hands themselves arrive at most 2 000 000 a day
--     (`desktop_ingest_day`).
--   * The global ceiling is a safety net, not a share: three accounts at their
--     full budget (four rebuilds at the measured pace) before anyone is
--     refused, ~5 000 rows a second - beyond that the database is better off
--     refusing than slowing every query. It was 200 000.
--   Rows are charged per owner of the rows inserted (the transition table),
--   which for a client is always the session's account (the normalising
--   triggers overwrite `owner_id`). A refused statement rolls back its own
--   charge, as before. The 2 000-rows-per-statement cap is unchanged.
-- pgTAP: `supabase/tests/database/stats_seats_budget.test.sql`.

begin;

-- ----------------------------------------------------------------- F1 ---

alter table public.hand_stats
  drop constraint if exists hand_stats_seat_ok,
  add constraint hand_stats_seat_ok check (seat >= 0) not valid;
alter table public.hand_stats validate constraint hand_stats_seat_ok;

alter table public.hand_stats_ev
  drop constraint if exists hand_stats_ev_seat_check,
  add constraint hand_stats_ev_seat_check check (seat >= 0) not valid;
alter table public.hand_stats_ev validate constraint hand_stats_ev_seat_check;

alter table public.hand_analysis
  drop constraint if exists hand_analysis_hero_seat_check,
  add constraint hand_analysis_hero_seat_check check (hero_seat >= 0) not valid;
alter table public.hand_analysis validate constraint hand_analysis_hero_seat_check;

alter table public.comments
  drop constraint if exists comments_anchor_seat_ok,
  add constraint comments_anchor_seat_ok check (anchor_seat is null or anchor_seat >= 1) not valid;
alter table public.comments validate constraint comments_anchor_seat_ok;

comment on column public.hand_stats.seat is
  'The room''s seat number (PHF seat). Any smallint >= 0: Ignition tournament seats run past 1 000.';

-- ----------------------------------------------------------------- F2 ---

-- What both statement triggers charge, per owner of the rows inserted.
create or replace function public.hand_stats_charge_budget(p_owner uuid, p_rows integer)
returns void
language plpgsql
-- security definer: `enforce_rate_limit` is not executable by clients. Not
-- granted to any client role either; only the two triggers below call it.
security definer
set search_path = ''
as $$
begin
  perform public.enforce_rate_limit('hand_stats_insert:' || coalesce(p_owner::text, 'none'),
                                    p_rows, 1000000, interval '10 minutes');
  perform public.enforce_rate_limit('hand_stats_insert_day:' || coalesce(p_owner::text, 'none'),
                                    p_rows, 10000000, interval '1 day');
  perform public.enforce_rate_limit('hand_stats_insert', p_rows, 3000000, interval '10 minutes');
end;
$$;

revoke all on function public.hand_stats_charge_budget(uuid, integer) from public, anon, authenticated;

comment on function public.hand_stats_charge_budget(uuid, integer) is
  'Charges statistics rows (hand_stats, hand_stats_ev) to the owner''s budget (1M / 10 min, 10M / day) and the global ceiling (3M / 10 min). Raises 53400 when over.';

create or replace function public.hand_stats_rate_limit()
returns trigger
language plpgsql
-- security definer: unchanged reason - `enforce_rate_limit` is not
-- executable by clients. Reads nothing but its transition table.
security definer
set search_path = ''
as $$
declare
  v_rows  integer;
  v_owner record;
begin
  select count(*) into v_rows from inserted;

  if v_rows > 2000 then
    raise exception 'Batch too large: % stats rows in one statement (max 2000).', v_rows
      using errcode = '53400';
  end if;

  for v_owner in select owner_id, count(*)::integer as n from inserted group by owner_id loop
    perform public.hand_stats_charge_budget(v_owner.owner_id, v_owner.n);
  end loop;
  return null;
end;
$$;

revoke execute on function public.hand_stats_rate_limit() from public, anon, authenticated;

create or replace function public.hand_stats_ev_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows  integer;
  v_owner record;
begin
  select count(*) into v_rows from inserted;
  if v_rows > 2000 then
    raise exception 'Batch too large: % EV rows in one statement (max 2000).', v_rows
      using errcode = '53400';
  end if;

  for v_owner in select owner_id, count(*)::integer as n from inserted group by owner_id loop
    perform public.hand_stats_charge_budget(v_owner.owner_id, v_owner.n);
  end loop;
  return null;
end;
$$;

revoke execute on function public.hand_stats_ev_rate_limit() from public, anon, authenticated;

commit;
