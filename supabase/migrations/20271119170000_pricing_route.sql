-- ===========================================================================
-- Rail: `/pricing` is a route, so it is nobody's username
-- ===========================================================================
--
-- `/pricing` is Free against Pro and the upgrade (the pricing round, owner
-- 2026-11-19; the desktop app opens it in the browser). Every top-level
-- segment is reserved for nobody (`20261007090000_forum_identity.sql`: "a new
-- top-level route belongs in that seed"), so a profile can never be confused
-- with it. An account that already holds the name keeps it; nobody new can
-- take it.
-- ===========================================================================

insert into public.username_reservations (username_lower, reason)
values ('pricing', 'route')
on conflict (username_lower) do nothing;
