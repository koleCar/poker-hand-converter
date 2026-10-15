-- rail-store schema, version 14 (docs/RAIL-PLAN.md R3.7): the part of the
-- opponents' rollups that comes from hands the user did not play.
--
-- PokerStars, Winamax and ACR allow HUD statistics only from hands the user
-- played (`sites.json` `hud.restrictions.ownHandsOnly`). `player_rollups`
-- sums every kept seat of every hand, so it cannot say which part of a
-- player's numbers came from an observed hand (one with no hero seat: a
-- table watched, a hand history of someone else's table). These tables hold
-- exactly that part, keyed as the tables they come from, so the HUD reads
-- `player_rollups - player_rollups_observed` for a restricted room: one more
-- key range per player, and nothing written for a hand the user played.
--
-- - `player_rollups_observed`: per (site, player, scope, segment) the sums
--   of the current generation's seat rows of hands without a hero seat, with
--   `aggregate`'s default exclusions - the same columns and rules as
--   `player_rollups`. Written with the hand by the import, summed again by a
--   recompute (R2.11: a fifth summed table, swapped in with the others).
-- - `recompute_player_rollups_observed`: its twin for the recompute.
-- - `custom_player_rollups_observed`: the same part of
--   `custom_player_rollups` (R2.10), counted by the custom pass.
--
-- Filled after this SQL by `rail_store::stats::fill_observed` in the same
-- transaction (SQL cannot read the seat rows' counter blob): the seat rows
-- of hands without a hero seat, decoded and summed; when there are any, the
-- custom statistics are counted again (their counts come from the decision
-- events, which only the custom pass derives). A rows job a build left
-- running is begun again on open (its twins have no observed part yet):
-- its target is changed here, which `recompute::ensure_current` reads as
-- "begun by a build of other versions".

CREATE TABLE player_rollups_observed (
  -- `segments.site`, repeated so a player's rows of one site are one range
  site                     TEXT    NOT NULL,
  player                   TEXT    NOT NULL,
  scope                    TEXT    NOT NULL,
  segment_id               INTEGER NOT NULL,
  last_played_at           TEXT,
  hands                    INTEGER NOT NULL,
  -- Preflop.
  vpip_opp                 INTEGER NOT NULL,
  vpip                     INTEGER NOT NULL,
  pfr_opp                  INTEGER NOT NULL,
  pfr                      INTEGER NOT NULL,
  rfi_opp                  INTEGER NOT NULL,
  rfi                      INTEGER NOT NULL,
  iso_opp                  INTEGER NOT NULL,
  iso                      INTEGER NOT NULL,
  limp_opp                 INTEGER NOT NULL,
  limp                     INTEGER NOT NULL,
  cold_call_opp            INTEGER NOT NULL,
  cold_call                INTEGER NOT NULL,
  three_bet_opp            INTEGER NOT NULL,
  three_bet                INTEGER NOT NULL,
  four_bet_opp             INTEGER NOT NULL,
  four_bet                 INTEGER NOT NULL,
  five_bet_opp             INTEGER NOT NULL,
  five_bet                 INTEGER NOT NULL,
  squeeze_opp              INTEGER NOT NULL,
  squeeze                  INTEGER NOT NULL,
  steal_opp                INTEGER NOT NULL,
  steal                    INTEGER NOT NULL,
  fold_to_steal_opp        INTEGER NOT NULL,
  fold_to_steal            INTEGER NOT NULL,
  call_steal               INTEGER NOT NULL,
  three_bet_vs_steal       INTEGER NOT NULL,
  fold_to_three_bet_opp    INTEGER NOT NULL,
  fold_to_three_bet        INTEGER NOT NULL,
  call_three_bet           INTEGER NOT NULL,
  raise_vs_three_bet       INTEGER NOT NULL,
  fold_to_four_bet_opp     INTEGER NOT NULL,
  fold_to_four_bet         INTEGER NOT NULL,
  call_four_bet            INTEGER NOT NULL,
  raise_vs_four_bet        INTEGER NOT NULL,
  -- Postflop.
  flop_seen                INTEGER NOT NULL,
  turn_seen                INTEGER NOT NULL,
  river_seen               INTEGER NOT NULL,
  cbet_flop_opp            INTEGER NOT NULL,
  cbet_flop                INTEGER NOT NULL,
  cbet_turn_opp            INTEGER NOT NULL,
  cbet_turn                INTEGER NOT NULL,
  cbet_river_opp           INTEGER NOT NULL,
  cbet_river               INTEGER NOT NULL,
  fold_to_cbet_flop_opp    INTEGER NOT NULL,
  fold_to_cbet_flop        INTEGER NOT NULL,
  call_cbet_flop           INTEGER NOT NULL,
  raise_cbet_flop          INTEGER NOT NULL,
  fold_to_cbet_turn_opp    INTEGER NOT NULL,
  fold_to_cbet_turn        INTEGER NOT NULL,
  call_cbet_turn           INTEGER NOT NULL,
  raise_cbet_turn          INTEGER NOT NULL,
  fold_to_cbet_river_opp   INTEGER NOT NULL,
  fold_to_cbet_river       INTEGER NOT NULL,
  call_cbet_river          INTEGER NOT NULL,
  raise_cbet_river         INTEGER NOT NULL,
  donk_flop_opp            INTEGER NOT NULL,
  donk_flop                INTEGER NOT NULL,
  donk_turn_opp            INTEGER NOT NULL,
  donk_turn                INTEGER NOT NULL,
  donk_river_opp           INTEGER NOT NULL,
  donk_river               INTEGER NOT NULL,
  check_raise_flop_opp     INTEGER NOT NULL,
  check_raise_flop         INTEGER NOT NULL,
  check_raise_turn_opp     INTEGER NOT NULL,
  check_raise_turn         INTEGER NOT NULL,
  check_raise_river_opp    INTEGER NOT NULL,
  check_raise_river        INTEGER NOT NULL,
  -- Raw postflop action counts.
  bet_flop                 INTEGER NOT NULL,
  raise_flop               INTEGER NOT NULL,
  call_flop                INTEGER NOT NULL,
  check_flop               INTEGER NOT NULL,
  fold_flop                INTEGER NOT NULL,
  bet_turn                 INTEGER NOT NULL,
  raise_turn               INTEGER NOT NULL,
  call_turn                INTEGER NOT NULL,
  check_turn               INTEGER NOT NULL,
  fold_turn                INTEGER NOT NULL,
  bet_river                INTEGER NOT NULL,
  raise_river              INTEGER NOT NULL,
  call_river               INTEGER NOT NULL,
  check_river              INTEGER NOT NULL,
  fold_river               INTEGER NOT NULL,
  -- Showdown.
  wwsf_opp                 INTEGER NOT NULL,
  wwsf                     INTEGER NOT NULL,
  wtsd_opp                 INTEGER NOT NULL,
  wtsd                     INTEGER NOT NULL,
  wsd_opp                  INTEGER NOT NULL,
  wsd                      INTEGER NOT NULL,
  -- Flags.
  cashed_out               INTEGER NOT NULL,
  -- Money: minor units (one currency in a cash segment); net_bb_milli in
  -- thousandths of a big blind.
  won                      INTEGER NOT NULL,
  contributed              INTEGER NOT NULL,
  net                      INTEGER NOT NULL,
  net_bb_milli             INTEGER NOT NULL,
  rake_paid                INTEGER NOT NULL,
  out_of_pot               INTEGER NOT NULL,
  cashout_risk             INTEGER NOT NULL,
  -- The hands whose money is in the sums (`moneyHands` of `aggregate`).
  money_hands              INTEGER NOT NULL,
  PRIMARY KEY (site, player, scope, segment_id)
) STRICT, WITHOUT ROWID;


CREATE TABLE recompute_player_rollups_observed (
  -- `segments.site`, repeated so a player's rows of one site are one range
  site                     TEXT    NOT NULL,
  player                   TEXT    NOT NULL,
  scope                    TEXT    NOT NULL,
  segment_id               INTEGER NOT NULL,
  last_played_at           TEXT,
  hands                    INTEGER NOT NULL,
  -- Preflop.
  vpip_opp                 INTEGER NOT NULL,
  vpip                     INTEGER NOT NULL,
  pfr_opp                  INTEGER NOT NULL,
  pfr                      INTEGER NOT NULL,
  rfi_opp                  INTEGER NOT NULL,
  rfi                      INTEGER NOT NULL,
  iso_opp                  INTEGER NOT NULL,
  iso                      INTEGER NOT NULL,
  limp_opp                 INTEGER NOT NULL,
  limp                     INTEGER NOT NULL,
  cold_call_opp            INTEGER NOT NULL,
  cold_call                INTEGER NOT NULL,
  three_bet_opp            INTEGER NOT NULL,
  three_bet                INTEGER NOT NULL,
  four_bet_opp             INTEGER NOT NULL,
  four_bet                 INTEGER NOT NULL,
  five_bet_opp             INTEGER NOT NULL,
  five_bet                 INTEGER NOT NULL,
  squeeze_opp              INTEGER NOT NULL,
  squeeze                  INTEGER NOT NULL,
  steal_opp                INTEGER NOT NULL,
  steal                    INTEGER NOT NULL,
  fold_to_steal_opp        INTEGER NOT NULL,
  fold_to_steal            INTEGER NOT NULL,
  call_steal               INTEGER NOT NULL,
  three_bet_vs_steal       INTEGER NOT NULL,
  fold_to_three_bet_opp    INTEGER NOT NULL,
  fold_to_three_bet        INTEGER NOT NULL,
  call_three_bet           INTEGER NOT NULL,
  raise_vs_three_bet       INTEGER NOT NULL,
  fold_to_four_bet_opp     INTEGER NOT NULL,
  fold_to_four_bet         INTEGER NOT NULL,
  call_four_bet            INTEGER NOT NULL,
  raise_vs_four_bet        INTEGER NOT NULL,
  -- Postflop.
  flop_seen                INTEGER NOT NULL,
  turn_seen                INTEGER NOT NULL,
  river_seen               INTEGER NOT NULL,
  cbet_flop_opp            INTEGER NOT NULL,
  cbet_flop                INTEGER NOT NULL,
  cbet_turn_opp            INTEGER NOT NULL,
  cbet_turn                INTEGER NOT NULL,
  cbet_river_opp           INTEGER NOT NULL,
  cbet_river               INTEGER NOT NULL,
  fold_to_cbet_flop_opp    INTEGER NOT NULL,
  fold_to_cbet_flop        INTEGER NOT NULL,
  call_cbet_flop           INTEGER NOT NULL,
  raise_cbet_flop          INTEGER NOT NULL,
  fold_to_cbet_turn_opp    INTEGER NOT NULL,
  fold_to_cbet_turn        INTEGER NOT NULL,
  call_cbet_turn           INTEGER NOT NULL,
  raise_cbet_turn          INTEGER NOT NULL,
  fold_to_cbet_river_opp   INTEGER NOT NULL,
  fold_to_cbet_river       INTEGER NOT NULL,
  call_cbet_river          INTEGER NOT NULL,
  raise_cbet_river         INTEGER NOT NULL,
  donk_flop_opp            INTEGER NOT NULL,
  donk_flop                INTEGER NOT NULL,
  donk_turn_opp            INTEGER NOT NULL,
  donk_turn                INTEGER NOT NULL,
  donk_river_opp           INTEGER NOT NULL,
  donk_river               INTEGER NOT NULL,
  check_raise_flop_opp     INTEGER NOT NULL,
  check_raise_flop         INTEGER NOT NULL,
  check_raise_turn_opp     INTEGER NOT NULL,
  check_raise_turn         INTEGER NOT NULL,
  check_raise_river_opp    INTEGER NOT NULL,
  check_raise_river        INTEGER NOT NULL,
  -- Raw postflop action counts.
  bet_flop                 INTEGER NOT NULL,
  raise_flop               INTEGER NOT NULL,
  call_flop                INTEGER NOT NULL,
  check_flop               INTEGER NOT NULL,
  fold_flop                INTEGER NOT NULL,
  bet_turn                 INTEGER NOT NULL,
  raise_turn               INTEGER NOT NULL,
  call_turn                INTEGER NOT NULL,
  check_turn               INTEGER NOT NULL,
  fold_turn                INTEGER NOT NULL,
  bet_river                INTEGER NOT NULL,
  raise_river              INTEGER NOT NULL,
  call_river               INTEGER NOT NULL,
  check_river              INTEGER NOT NULL,
  fold_river               INTEGER NOT NULL,
  -- Showdown.
  wwsf_opp                 INTEGER NOT NULL,
  wwsf                     INTEGER NOT NULL,
  wtsd_opp                 INTEGER NOT NULL,
  wtsd                     INTEGER NOT NULL,
  wsd_opp                  INTEGER NOT NULL,
  wsd                      INTEGER NOT NULL,
  -- Flags.
  cashed_out               INTEGER NOT NULL,
  -- Money: minor units (one currency in a cash segment); net_bb_milli in
  -- thousandths of a big blind.
  won                      INTEGER NOT NULL,
  contributed              INTEGER NOT NULL,
  net                      INTEGER NOT NULL,
  net_bb_milli             INTEGER NOT NULL,
  rake_paid                INTEGER NOT NULL,
  out_of_pot               INTEGER NOT NULL,
  cashout_risk             INTEGER NOT NULL,
  -- The hands whose money is in the sums (`moneyHands` of `aggregate`).
  money_hands              INTEGER NOT NULL,
  PRIMARY KEY (site, player, scope, segment_id)
) STRICT, WITHOUT ROWID;


CREATE TABLE custom_player_rollups_observed (
  stat_id    INTEGER NOT NULL,
  site       TEXT    NOT NULL,
  player     TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  segment_id INTEGER NOT NULL,
  made       INTEGER NOT NULL,
  opp        INTEGER NOT NULL,
  PRIMARY KEY (stat_id, site, player, scope, segment_id)
) STRICT, WITHOUT ROWID;

UPDATE kv SET value = 'migration 14' WHERE key = 'recompute.rows.target';
