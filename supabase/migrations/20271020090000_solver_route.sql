-- ===========================================================================
-- Rail: `/solver` is a route, so it is nobody's username
-- ===========================================================================
--
-- The Solver library tab (`/solver`) browses the flop library's solves. Every
-- top-level segment is reserved for nobody (`20261007090000_forum_identity.sql`:
-- "a new top-level route belongs in that seed"), so a profile can never be
-- confused with it. An account that already holds the name keeps it; nobody
-- new can take it.
-- ===========================================================================

insert into public.username_reservations (username_lower, reason)
values ('solver', 'route')
on conflict (username_lower) do nothing;
