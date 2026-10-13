-- Realtime: an anonymous socket must not learn *when* notifications happen.
--
-- `notifications` is in the `supabase_realtime` publication
-- (20261026090000_forum_social.sql). Realtime checks each change against
-- the subscriber's RLS; a role with no SELECT privilege on the table at all
-- does not get "no rows" - it gets an empty "Error 401" notice for every
-- change, which tells anyone watching the timing of every account's
-- notifications. Found while building `hand_arrivals` (R1.10,
-- 20270512090000_hand_arrivals.sql), which closed the same gap for its own
-- table this way.
--
-- The fix is the same: `anon` gets SELECT and still no policy
-- (`notifications_own_select` is `to authenticated`), so RLS hands it zero
-- rows and Realtime sends it nothing. No write privilege changes.

grant select on public.notifications to anon;
