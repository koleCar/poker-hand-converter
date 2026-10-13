-- rail-store schema, version 6 (docs/RAIL-PLAN.md R2.3): local statistics.
--
-- - `segments`: what statistics are summed over, (site, game format,
--   variant, limit, table-size class, stake) - `rail_stats::Segment`. Small;
--   rows are never deleted.
-- - `hand_stats`: per hand with kept rows, the statistics' hand-level columns
--   of the web's `hand_stats` that `hands` does not already hold, its
--   segment, and `gen`, the rollup generation its rows are counted in.
-- - `seat_stats`: one row per kept seat (`rail_stats::stored_rows`: the hero
--   always, villains unless the room is positionally anonymised): the seat's
--   columns and its 90 counters and 7 money values in one `totals` blob
--   (`rail_store::stats::encode_seat`: only the values that are not zero).
--   With the hand's columns repeated per seat and a column per counter the
--   rows cost ~2 KB a hand and a third of the import's speed (R2.3, measured).
-- - `player_rollups`: per (site, player, scope, segment) the sums of the
--   current generation's seat rows with `aggregate`'s default exclusions
--   (bomb pots left out; EV-cashout hands left out of the money) - the HUD
--   reads one row per player and segment.
-- - `hero_rollups`: the hero's rows summed per (segment, position, UTC day,
--   kind), kind = bomb pot 1 | straddled 2 | EV cashout 4, nothing excluded:
--   reports sum days instead of hands, with any of `aggregate`'s options.
-- - `ev_rows`: the hero's all-in EV of the hands where it differs from the
--   result (`applicable`: an all-in with cards to come), at `ev_version`.
--   Every other hero hand's EV row is `ev_net = net`, implied.
--   `ev_pending`: hands the background pass still has to evaluate (preflop
--   all-ins, everything after an EV version bump).
--
-- The rollups' counter columns are `rail_stats::COUNTER_KEYS` in order, then
-- `MONEY_KEYS`, then `money_hands` (`tests/stats.rs` checks); the web's
-- names. The generation and rebuild bookkeeping lives in `kv` (`stats.gen`,
-- `stats.version`, `stats.rebuild.*`, `ev.version`): see `SCHEMA.md`.

CREATE TABLE segments (
  id          INTEGER NOT NULL PRIMARY KEY,
  site        TEXT    NOT NULL,
  game_format TEXT    NOT NULL,
  variant     TEXT    NOT NULL,
  limit_type  TEXT    NOT NULL,
  -- `hu`, `6max`, `full`
  size_class  TEXT    NOT NULL,
  -- `chips`, or `<currency>:<big blind in minor units>`
  stake       TEXT    NOT NULL,
  UNIQUE (site, game_format, variant, limit_type, size_class, stake)
) STRICT;

CREATE TABLE hand_stats (
  id                   INTEGER NOT NULL PRIMARY KEY,
  hand_key             TEXT    NOT NULL UNIQUE REFERENCES hands (hand_key) ON DELETE CASCADE,
  gen                  INTEGER NOT NULL,
  -- `hands.played_at`, repeated here so a date range never reads `hands`
  -- (its rows hold the PHF)
  played_at            TEXT,
  segment_id           INTEGER NOT NULL,
  stats_version        TEXT    NOT NULL,
  -- `none`, `positional`, `opaque-id`
  site_anonymization   TEXT    NOT NULL,
  site_id              TEXT    NOT NULL,
  currency_minor_units INTEGER NOT NULL,
  player_count         INTEGER NOT NULL,
  tournament_id        TEXT,
  fast_fold            TEXT,
  has_straddle         INTEGER NOT NULL,
  is_bomb_pot          INTEGER NOT NULL,
  is_big_blind_ante    INTEGER NOT NULL,
  is_run_it_twice      INTEGER NOT NULL,
  has_cashout          INTEGER NOT NULL,
  is_walk              INTEGER NOT NULL,
  street_reached       TEXT    NOT NULL,
  pot_type             TEXT    NOT NULL,
  total_pot            INTEGER NOT NULL,
  house_into_pot       INTEGER NOT NULL,
  fees                 INTEGER NOT NULL
) STRICT;

-- The hands of a date range: the partial days of a report, the hero's EV
-- over a range, (R2.7) hand lists.
CREATE INDEX hand_stats_played_idx ON hand_stats (played_at);

CREATE TABLE seat_stats (
  hand_id                  INTEGER NOT NULL REFERENCES hand_stats (id) ON DELETE CASCADE,
  seat                     INTEGER NOT NULL,
  player                   TEXT    NOT NULL,
  -- '' or, for a villain of an opaque-id hand, its session (`<table>@<day>`)
  scope                    TEXT    NOT NULL,
  is_hero                  INTEGER NOT NULL,
  position                 TEXT,
  -- the cards separated by spaces ('' when none were seen)
  hole_cards               TEXT    NOT NULL,
  hand_class               TEXT,
  starting_stack           INTEGER NOT NULL,
  starting_stack_bb_tenths INTEGER NOT NULL,
  -- the counters and money (`rail_store::stats::encode_seat`)
  totals                   BLOB    NOT NULL,
  PRIMARY KEY (hand_id, seat)
) STRICT, WITHOUT ROWID;

CREATE TABLE player_rollups (
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

CREATE TABLE hero_rollups (
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

CREATE TABLE ev_rows (
  hand_key        TEXT    NOT NULL PRIMARY KEY REFERENCES hands (hand_key) ON DELETE CASCADE,
  seat            INTEGER NOT NULL,
  ev_version      TEXT    NOT NULL,
  ev_net          INTEGER NOT NULL,
  ev_net_bb_milli INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE ev_pending (
  -- newest first: a hand just played is evaluated before a backlog
  id       INTEGER NOT NULL PRIMARY KEY,
  hand_key TEXT    NOT NULL UNIQUE REFERENCES hands (hand_key) ON DELETE CASCADE
) STRICT;
