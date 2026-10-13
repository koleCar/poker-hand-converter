-- rail-store schema, version 3 (docs/RAIL-PLAN.md R1.4).
--
-- The room whose default folder a watched folder is: the `config/sites.json`
-- id that first-run discovery found it for. It names the room in the
-- interface and narrows which files of the folder are read (the room's
-- `files.glob`). It is not a parser override (`site_override` is): detection
-- still decides per file. NULL for a folder added by hand.
ALTER TABLE sources ADD COLUMN site TEXT;
