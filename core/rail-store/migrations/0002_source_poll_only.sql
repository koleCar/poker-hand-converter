-- rail-store schema, version 2 (docs/RAIL-PLAN.md R1.3).
--
-- A watched folder can be read by polling only: network shares deliver no
-- (or unreliable) change notifications, so the watcher stats their files on
-- a short timer instead. Set when the watcher finds the folder on a network
-- file system, or by the user (R1.5).
ALTER TABLE sources ADD COLUMN poll_only INTEGER NOT NULL DEFAULT 0 CHECK (poll_only IN (0, 1));
