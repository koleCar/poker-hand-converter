-- rail-store schema, version 12 (docs/RAIL-PLAN.md R2.11): targeted
-- recompute.
--
-- When a definition changes (a `STATS_VERSION`, `SEGMENT_VERSION` or
-- `EV_VERSION` bump, or "rebuild statistics"), the background pass works
-- out the new statistics beside the ones the screens read and swaps them in,
-- in one transaction, at the end (`rail_store::recompute`). A reader sees
-- the old statistics, whole, until that commit, and the new ones, whole,
-- after it - never a rollup half rebuilt. These tables hold the work in
-- between; they are empty when no recompute runs.
--
-- - `recompute_hands`, `recompute_seats`, `recompute_list`: the new rows of
--   the hands whose rows differ from the stored ones, by part (`parts`: 1
--   the `hand_stats` columns, 2 the seat rows, 4 the `hand_list` row, 8 the
--   hand keeps no rows any more, 16 only the seat rows' `totals`), written
--   into `hand_stats`, `seat_stats` and `hand_list` by the swap. A hand whose rows are already right is not
--   here: nothing of it is rewritten, and it keeps its `hand_stats.id`
--   either way. `recompute_hands` also says what the swap does with the
--   hand's all-in EV when the hero's seat or result changed (`ev_plan`: 0
--   keep it, 1 store the row in the `ev_` columns, 2 no row, 3 queue it).
-- - `recompute_player_rollups`, `recompute_hero_rollups`,
--   `recompute_player_summary`, `recompute_player_hidden`: the rollups and
--   the Players list's lines summed again from every hand's new rows - the
--   same shape as the live tables, so the swap renames them into place (and
--   the old ones become the empty twins of the next recompute). A migration
--   that changes one of the four live tables changes its twin the same way.
-- - `recompute_ev`: the hero hands whose all-in EV an `EV_VERSION` bump
--   evaluates again, and each one's new row once done (`done`); the swap
--   writes them into `ev_rows`.
--
-- The jobs' state is in `kv` (`recompute.rows.*`, `recompute.ev.*`; see
-- `SCHEMA.md`). Every swap moves `kv` `stats.epoch` on, which a reader that
-- spreads one answer over several connections compares before and after.

CREATE TABLE recompute_hands (
  -- `hand_stats.id`
  hand_id              INTEGER NOT NULL PRIMARY KEY,
  hand_key             TEXT    NOT NULL,
  -- 1 hand_stats columns | 2 seat rows | 4 list row | 8 no rows any more |
  -- 16 only the seat rows' totals
  parts                INTEGER NOT NULL,
  -- `hand_stats`' columns (when parts & 1)
  played_at            TEXT,
  segment_id           INTEGER,
  stats_version        TEXT,
  site_anonymization   TEXT,
  site_id              TEXT,
  currency_minor_units INTEGER,
  player_count         INTEGER,
  tournament_id        TEXT,
  fast_fold            TEXT,
  has_straddle         INTEGER,
  is_bomb_pot          INTEGER,
  is_big_blind_ante    INTEGER,
  is_run_it_twice      INTEGER,
  has_cashout          INTEGER,
  is_walk              INTEGER,
  street_reached       TEXT,
  pot_type             TEXT,
  total_pot            INTEGER,
  house_into_pot       INTEGER,
  fees                 INTEGER,
  -- the all-in EV when the hero's seat or result changed: 0 keep, 1 the
  -- row below, 2 no row, 3 queue it for the background pass
  ev_plan              INTEGER NOT NULL DEFAULT 0,
  ev_seat              INTEGER,
  ev_version           TEXT,
  ev_net               INTEGER,
  ev_net_bb_milli      INTEGER
) STRICT;

-- `seat_stats`' columns: a staged hand's new seat rows (parts & 2, or 16).
CREATE TABLE recompute_seats (
  hand_id                  INTEGER NOT NULL,
  seat                     INTEGER NOT NULL,
  player                   TEXT    NOT NULL,
  scope                    TEXT    NOT NULL,
  is_hero                  INTEGER NOT NULL,
  position                 TEXT,
  hole_cards               TEXT    NOT NULL,
  hand_class               TEXT,
  starting_stack           INTEGER NOT NULL,
  starting_stack_bb_tenths INTEGER NOT NULL,
  totals                   BLOB    NOT NULL,
  PRIMARY KEY (hand_id, seat)
) STRICT, WITHOUT ROWID;

-- `hand_list`'s columns: a staged hand's new list row (parts & 4).
CREATE TABLE recompute_list (
  hand_id              INTEGER NOT NULL PRIMARY KEY,
  played_at            TEXT    NOT NULL,
  hand_key             TEXT    NOT NULL,
  site_hand_id         TEXT    NOT NULL,
  segment_id           INTEGER NOT NULL,
  hero_position        TEXT,
  hero_cards           TEXT,
  hero_net             INTEGER,
  hero_net_bb_milli    INTEGER,
  hero_stack_bb_tenths INTEGER,
  board                TEXT    NOT NULL,
  all_in               INTEGER NOT NULL,
  showdown             INTEGER NOT NULL,
  pot_type             TEXT    NOT NULL,
  currency_symbol      TEXT    NOT NULL,
  kind                 INTEGER NOT NULL,
  hero_wtsd            INTEGER NOT NULL,
  currency             TEXT    NOT NULL,
  minor_units          INTEGER NOT NULL
) STRICT;

-- The twins of `player_rollups` and `hero_rollups` (version 6).
CREATE TABLE recompute_player_rollups (
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

CREATE TABLE recompute_hero_rollups (
  segment_id               INTEGER NOT NULL,
  -- `BTN`, ..., or '' when the engine assigned none
  position                 TEXT    NOT NULL,
  -- the UTC day of `played_at` (`YYYY-MM-DD`), '' for a hand without one
  day                      TEXT    NOT NULL,
  -- bomb pot 1 | straddled 2 | EV cashout 4
  kind                     INTEGER NOT NULL,
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
  PRIMARY KEY (segment_id, position, day, kind)
) STRICT, WITHOUT ROWID;

-- The twins of `player_summary` and `player_hidden` (version 9).
CREATE TABLE recompute_player_summary (
  site                    TEXT    NOT NULL,
  player                  TEXT    NOT NULL,
  hands                   INTEGER NOT NULL,
  first_played_at         TEXT,
  last_played_at          TEXT,
  cash_hands              INTEGER NOT NULL,
  chips_hands             INTEGER NOT NULL,
  cash_money_hands        INTEGER NOT NULL,
  cash_net_bb_milli       INTEGER NOT NULL,
  chips_money_hands       INTEGER NOT NULL,
  chips_net_bb_milli      INTEGER NOT NULL,
  PRIMARY KEY (site, player)
) STRICT, WITHOUT ROWID;

CREATE TABLE recompute_player_hidden (
  site       TEXT    NOT NULL PRIMARY KEY,
  hands      INTEGER NOT NULL,
  cash_hands INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE recompute_ev (
  hand_key        TEXT    NOT NULL PRIMARY KEY,
  -- 0 waiting, 1 evaluated: the columns below hold its row (`applicable`
  -- 1), or say it has none (0)
  done            INTEGER NOT NULL DEFAULT 0,
  seat            INTEGER,
  ev_version      TEXT,
  ev_net          INTEGER,
  ev_net_bb_milli INTEGER,
  applicable      INTEGER
) STRICT, WITHOUT ROWID;

-- The hands still waiting, in key order.
CREATE INDEX recompute_ev_waiting_idx ON recompute_ev (done, hand_key);
