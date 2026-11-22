-- rail-store schema, version 29 (docs/ANALYTICS.md Step 11): the hero's
-- effective stack at its first preflop action, for the Effective stack
-- filter chip.
--
-- `eff_stack_tenths`: the hero's starting stack against the largest stack
-- still live at its first preflop decision, in tenths of the hand's largest
-- forced blind (`rail_stats::events::effective_first_action_bb` / 100; a
-- walk is the hero's own stack). NULL without a hero or a blind. The chips'
-- buckets are `config/stats/stack-buckets.json`'s `filter` list.
--
-- It comes from the PHF, which SQL cannot read. New list rows get it where
-- they are written (`facts::derive`); the rows already stored are filled by
-- the background pass (`rail_store::eff_stack::backfill_step`,
-- `background::Step::Stacked`), a page at a time from `kv`
-- `eff_stack.after` (the last `played_at`, `hand_key` filled; 'done' at the
-- end), so opening a large library does not wait for it.

ALTER TABLE hand_list ADD COLUMN eff_stack_tenths INTEGER;
ALTER TABLE recompute_list ADD COLUMN eff_stack_tenths INTEGER;

INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES ('eff_stack.after', '', 0);
