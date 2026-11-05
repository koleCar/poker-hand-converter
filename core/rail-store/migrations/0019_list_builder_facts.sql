-- rail-store schema, version 19 (2026-11-05, the owner's filter builder V1,
-- its second half): what the builder reads of a hand beyond its counters,
-- derived from the PHF where the list row is written (`facts::derive`):
--
-- - the hero's sizes: the open preflop in tenths of a big blind, the first
--   bet or raise on the flop, turn and river as a share of the pot;
-- - what the hero made on each street (`facts::MADE`: top pair, set, flush,
--   ...), a top pair's kicker, the draws on the flop and turn
--   (`facts::DRAWS`);
-- - the players who saw the flop, whether the hero had position on it, the
--   opponents in the pot (their seats and positions);
-- - a tournament's buy-in (cents of its unit), bounty and level.
--
-- They come from the PHF, which SQL cannot read: the statistics version is
-- forgotten, as versions 7 and 8 did, so the next open rebuilds the
-- statistics in the background and every list row is written again with
-- these columns.

ALTER TABLE hand_list ADD COLUMN open_tenths INTEGER;
ALTER TABLE hand_list ADD COLUMN flop_bet_pct INTEGER;
ALTER TABLE hand_list ADD COLUMN turn_bet_pct INTEGER;
ALTER TABLE hand_list ADD COLUMN river_bet_pct INTEGER;
ALTER TABLE hand_list ADD COLUMN flop_made INTEGER;
ALTER TABLE hand_list ADD COLUMN turn_made INTEGER;
ALTER TABLE hand_list ADD COLUMN river_made INTEGER;
ALTER TABLE hand_list ADD COLUMN flop_kicker INTEGER;
ALTER TABLE hand_list ADD COLUMN turn_kicker INTEGER;
ALTER TABLE hand_list ADD COLUMN river_kicker INTEGER;
ALTER TABLE hand_list ADD COLUMN flop_draws INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hand_list ADD COLUMN turn_draws INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hand_list ADD COLUMN players_flop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hand_list ADD COLUMN hero_ip INTEGER;
ALTER TABLE hand_list ADD COLUMN vs_seats TEXT NOT NULL DEFAULT '';
ALTER TABLE hand_list ADD COLUMN vs_positions TEXT NOT NULL DEFAULT '';
ALTER TABLE hand_list ADD COLUMN buy_in_cents INTEGER;
ALTER TABLE hand_list ADD COLUMN bounty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hand_list ADD COLUMN tour_level INTEGER;
ALTER TABLE recompute_list ADD COLUMN open_tenths INTEGER;
ALTER TABLE recompute_list ADD COLUMN flop_bet_pct INTEGER;
ALTER TABLE recompute_list ADD COLUMN turn_bet_pct INTEGER;
ALTER TABLE recompute_list ADD COLUMN river_bet_pct INTEGER;
ALTER TABLE recompute_list ADD COLUMN flop_made INTEGER;
ALTER TABLE recompute_list ADD COLUMN turn_made INTEGER;
ALTER TABLE recompute_list ADD COLUMN river_made INTEGER;
ALTER TABLE recompute_list ADD COLUMN flop_kicker INTEGER;
ALTER TABLE recompute_list ADD COLUMN turn_kicker INTEGER;
ALTER TABLE recompute_list ADD COLUMN river_kicker INTEGER;
ALTER TABLE recompute_list ADD COLUMN flop_draws INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN turn_draws INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN players_flop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN hero_ip INTEGER;
ALTER TABLE recompute_list ADD COLUMN vs_seats TEXT NOT NULL DEFAULT '';
ALTER TABLE recompute_list ADD COLUMN vs_positions TEXT NOT NULL DEFAULT '';
ALTER TABLE recompute_list ADD COLUMN buy_in_cents INTEGER;
ALTER TABLE recompute_list ADD COLUMN bounty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recompute_list ADD COLUMN tour_level INTEGER;

DELETE FROM kv WHERE key = 'stats.version';
