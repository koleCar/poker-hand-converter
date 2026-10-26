-- ===========================================================================
-- Rail R6.5: `/terms` and `/privacy` are routes, so they are nobody's username
-- ===========================================================================
--
-- `docs/RAIL-PLAN.md` R6.5 serves the terms of use and the privacy policy at
-- two new top-level paths. Every top-level segment is reserved for nobody
-- (`20261007090000_forum_identity.sql`: "a new top-level route belongs in
-- that seed"), so a profile can never be confused with them. An account that
-- already holds one of the names keeps it; nobody new can take it.
-- ===========================================================================

insert into public.username_reservations (username_lower, reason)
values ('terms', 'route'), ('privacy', 'route')
on conflict (username_lower) do nothing;
