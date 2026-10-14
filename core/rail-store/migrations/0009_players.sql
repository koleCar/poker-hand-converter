-- rail-store schema, version 9 (docs/RAIL-PLAN.md R2.7c): the Players screen.
--
-- - `players`: the user's words on an opponent - a colour tag, a note - by
--   (site, name), and `player_labels` their labels (the web's
--   `player_notes.tags`). Keyed by the natural key with no foreign key, like
--   `hand_notes`: they outlive any rebuild of the derived rows. Local only
--   for now; syncing them with the web's `player_notes` is a later step.
--   Written only for an opponent the store has seen in a room that prints
--   real screen names (`rail_store::players`, the web's `set_player_note`
--   rule): never for a positional room's seat label (another human every
--   hand) nor an opaque token (GGPoker, ACR/WPN's mined ids: another human
--   next session).
-- - `player_summary`: per (site, name) of an opponent of such a room, what
--   the list shows and sorts by - hands seen, first and last seen, and the
--   hero's hands with them and result against them in big blinds, cash and
--   tournament chips apart (the web's `stats_opponents` never adds the two).
--   Derived like the rollups: summed at import with `aggregate`'s defaults
--   (bomb pots out; an EV cashout's result out), emptied by a rebuild.
-- - `player_hidden`: per site, the opponents' hands of opaque-id rooms -
--   counted, not listed (the web's `opaqueRows`).
-- - `player_hands`: an opponent's seat rows by name ("hands with this
--   player", the profile by position) - villains of rooms with real names
--   only. A table rather than an index on `seat_stats`, and written by the
--   background pass after the import (`kv` `players.indexed`), not by the
--   import: written with every import transaction (as an index, or as this
--   table) it cost the import 4-5 % of its rate, measured - each
--   transaction touched a page of a name-ordered table per opponent. A seat
--   row deleted (a rebuild replaces a hand's rows) takes its entry with it
--   (the trigger below). Empty here: the pass fills it from the seat rows,
--   in large sorted chunks, once the rebuild below is done.
--
-- The summary comes from the statistics rows (the hero's result is in the
-- seat blobs), so the statistics version is forgotten as versions 7 and 8
-- did: the next open rebuilds the statistics in the background and the
-- pass fills the summary.

CREATE TABLE players (
  -- `segments.site`: the site id trimmed and lower-cased
  site       TEXT    NOT NULL,
  player     TEXT    NOT NULL,
  -- one of the app's fixed palette (`rail_store::players::COLOURS`)
  colour     TEXT    CHECK (colour IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple')),
  note       TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site, player)
) STRICT, WITHOUT ROWID;

CREATE TABLE player_labels (
  site     TEXT    NOT NULL,
  player   TEXT    NOT NULL,
  label    TEXT    NOT NULL CHECK (label <> ''),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (site, player, label)
) STRICT, WITHOUT ROWID;

-- The players with a label, and the labels in use.
CREATE INDEX player_labels_label_idx ON player_labels (label, site, player);

CREATE TABLE player_summary (
  site                    TEXT    NOT NULL,
  player                  TEXT    NOT NULL,
  -- the opponent's seat rows counted (bomb pots out): `player_rollups.hands`
  -- summed over the name's segments
  hands                   INTEGER NOT NULL,
  first_played_at         TEXT,
  last_played_at          TEXT,
  -- of those, the hands the hero played too ("hands together"), cash and
  -- tournament chips apart...
  cash_hands              INTEGER NOT NULL,
  chips_hands             INTEGER NOT NULL,
  -- ...and the hero's result in them, thousandths of a big blind, over the
  -- hands whose money counts (an EV cashout's does not)
  cash_money_hands        INTEGER NOT NULL,
  cash_net_bb_milli       INTEGER NOT NULL,
  chips_money_hands       INTEGER NOT NULL,
  chips_net_bb_milli      INTEGER NOT NULL,
  PRIMARY KEY (site, player)
) STRICT, WITHOUT ROWID;

CREATE TABLE player_hidden (
  site       TEXT    NOT NULL PRIMARY KEY,
  -- opponents' seat rows of opaque-id hands (bomb pots out), and of those
  -- in cash games
  hands      INTEGER NOT NULL,
  cash_hands INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE player_hands (
  player  TEXT    NOT NULL,
  -- `seat_stats` (`hand_id`, `seat`)
  hand_id INTEGER NOT NULL,
  seat    INTEGER NOT NULL,
  PRIMARY KEY (player, hand_id, seat)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER seat_stats_player_delete AFTER DELETE ON seat_stats
  WHEN old.is_hero = 0 AND old.scope = '' AND old.player <> '' BEGIN
  DELETE FROM player_hands
   WHERE player = old.player AND hand_id = old.hand_id AND seat = old.seat;
END;

DELETE FROM kv WHERE key = 'stats.version';
