-- rail-store schema, version 18 (2026-11-05, the owner's filter builder V1):
-- what the hero did and faced, street by street, on the list row.
--
-- `hand_list.hero_acts` is a bit set over the hero's counters
-- (`hand_list::ACTS`: opened, 3-bet, faced a 3-bet, saw the turn, c-bet the
-- flop, faced a c-bet, ...), so the builder's preflop action and line
-- filters are one `&` in SQL instead of reading every seat's counter blob.
-- The counters are a blob SQL cannot read: the column is filled in Rust in
-- this migration's transaction (`migrate::after_sql`, from each hand's hero
-- seat row), as version 14 filled the observed rollups, and written by
-- every list row from now on (the import, a pull, a recompute).

ALTER TABLE hand_list ADD COLUMN hero_acts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN hero_acts INTEGER NOT NULL DEFAULT 0;
