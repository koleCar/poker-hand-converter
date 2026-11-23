-- rail-store schema, version 30: `player_hands` by hand.
--
-- `player_hands` is keyed by player first (`PRIMARY KEY (player, hand_id,
-- seat)`), which serves an opponent's hands. The "vs type" and "vs VPIP"
-- filters (`hand_list::where_sql`) go the other way: from a hand to the
-- named opponents in it. Without this index every hand scanned the whole
-- table, so a report over the filter took minutes on a large library - the
-- Analytics Pool tab asks for two (you with a fish in the pot, you against
-- regs only) and never opened (91,901 hands: about 40 minutes a report,
-- 0.4 s with the index).

CREATE INDEX IF NOT EXISTS player_hands_hand_idx ON player_hands (hand_id, seat, player);
