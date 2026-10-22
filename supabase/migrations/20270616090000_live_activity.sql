-- Rail R4.3: live progress across an account's tabs and devices
-- (docs/RAIL-PLAN.md R4.3).
--
-- A bulk upload (R4.2) knows its own progress in the tab that runs it. R4.3
-- makes it visible in the account's *other* tabs and devices: "Saving
-- 120 000 of ~1 000 000 hands from a web upload", then "finished". The
-- mechanism is **Realtime Presence on a private channel per account**,
-- `activity:<uid>`, and this migration is its authorisation.
--
-- Why Presence on a private channel (and not a progress table)
-- ------------------------------------------------------------
--   * **No database writes per batch.** Presence state lives in the Realtime
--     server's memory; the uploading tab re-tracks its state at most every
--     2 s (and every 15 s while nothing changes). A progress row would be an
--     UPDATE plus a WAL decode and an RLS check per subscriber, per call, for
--     a 1M-hand upload that already makes ~4 000 `ingest_hands` calls - the
--     same cost `hand_arrivals` was designed to keep off `hands`.
--   * **Stale progress expires by itself.** A presence entry belongs to its
--     socket: a closed tab, a killed browser or a dead network drops it
--     (immediately on a close, after Realtime's heartbeat timeout otherwise).
--     The web also ignores an entry that has not changed for 45 s, so a
--     frozen tab cannot leave a bar standing either. A table would need a
--     janitor for both.
--   * **A tab opened mid-upload sees it at once**: Presence sends the current
--     state on join; a Broadcast-only design would wait for the next message.
--
-- Authorisation (Realtime Authorization, `realtime.messages` RLS)
-- ---------------------------------------------------------------
-- When a socket joins a channel with `private: true`, Realtime decides what
-- it may do by running, as the socket's JWT role with `request.jwt.claims`
-- and `realtime.topic` set to the channel's name, a SELECT (may receive)
-- and an INSERT (may send) against `realtime.messages`, inside a
-- transaction it rolls back. With RLS on and no policy (as shipped), every
-- private join is refused. These two policies admit exactly this:
--
--   an `authenticated` JWT, on the topic `activity:<its own sub>`: to
--   receive (presence and broadcast) and to send presence.
--
-- Receiving names `broadcast` as well because Realtime's join itself is a
-- broadcast read: with `presence` alone the join is refused ("You do not
-- have permissions to read from this Channel topic", measured on the local
-- stack's Realtime). Sending is `presence` only, so nobody can broadcast on
-- the topic and there is nothing to receive but presence.
-- Not admitted: another account's topic (B on `activity:<A>`), `anon` (no
-- policy for the role), any other topic, any broadcast sent. A *public*
-- channel of the same name is a different channel on the server (checked:
-- nothing tracked there reaches the private one, nor the other way).
-- The channels the web already uses - `notifications:<uid>` and
-- `hand-arrivals:<uid>`, Postgres Changes on public channels - are not
-- private and are authorised by their tables' RLS, so nothing here changes
-- them. pgTAP:
-- `supabase/tests/database/live_activity.test.sql`; end to end through a real
-- Realtime server: `npm run realtime:activity` (tests/).
--
-- What a member of the channel learns is its own account's uploads in
-- progress: a random upload id, a state and counts. No hand, no file name.
--
-- Hosted project: nothing to configure. Private channels need no dashboard
-- setting; "allow public access" must stay on (the bell and the arrivals
-- channel are public channels guarded by table RLS).
--
-- Each policy also holds the row's own `topic` to the channel's. Realtime
-- writes and reads rows of exactly that topic, so this changes nothing for
-- it; it only means that a role that could ever query the table (it is not
-- exposed through the API) sees no other account's rows.

create policy live_activity_own_receive
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('presence', 'broadcast')
    and (select realtime.topic()) = 'activity:' || (select auth.uid())::text
    and realtime.messages.topic = (select realtime.topic())
  );

create policy live_activity_own_send
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'activity:' || (select auth.uid())::text
    and realtime.messages.topic = (select realtime.topic())
  );
