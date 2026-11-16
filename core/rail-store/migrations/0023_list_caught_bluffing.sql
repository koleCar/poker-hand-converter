-- rail-store schema, version 23 (2026-11-15, the owner's ask): who was
-- caught bluffing in a hand, street by street, for the filter builder.
--
-- A seat is caught bluffing on a street when it bet or raised there with
-- no pair of its own on that street's board (`facts::MADE` "highCard":
-- bluffs and semi-bluffs alike) and its cards were seen: the hero's at a
-- showdown, an opponent's whenever the hand history shows them. Bits:
-- 1 flop, 2 turn, 4 river; `hero_bluff` for the hero, `vs_bluff` for any
-- opponent.
--
-- They come from the PHF, which SQL cannot read: the migration fills them
-- in Rust (`facts::fill_caught_bluffing`), in its transaction, so no
-- statistics rebuild is needed. New hands get them where the list row is
-- written (`facts::derive`).

ALTER TABLE hand_list ADD COLUMN hero_bluff INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hand_list ADD COLUMN vs_bluff INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN hero_bluff INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN vs_bluff INTEGER NOT NULL DEFAULT 0;
