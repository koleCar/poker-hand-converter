-- rail-store schema, version 7 (docs/RAIL-PLAN.md R2.7a): the Hands screen.
--
-- - `hand_list`: one narrow row per hand with statistics rows (`hand_stats`),
--   what the Hands list shows and filters on: the hero's position, cards,
--   result and stack, the board, the all-in and showdown flags, the pot
--   type, the unit's symbol and the
--   segment (site, format, variant, limit, table size, stake). Clustered by
--   the list's order, (`played_at`, `hand_key`), so a page is one range of
--   the table and a keyset cursor a seek; `hands` (whose rows hold the PHF)
--   is read only for the rows of a page. Derived, like the statistics: it is
--   written with a hand's `hand_stats` row (at import and by a rebuild) and
--   deleted with it (the trigger below, which a cascade from `hands` fires
--   too).
-- - `hand_notes`, `hand_tags`: the user's note and tags per hand. Keyed by
--   `hand_key` and not tied to `hands` by a foreign key: they are the
--   user's words, and survive whatever happens to the derived rows. Local
--   only for now; syncing them to the web is a later step.
-- - `saved_filters`: the Hands screen's saved filters (guideline §6), a
--   name and the filter as JSON (`rail_store::hand_list::HandFilter`).
-- - `hand_list_site_hand_id_idx`: "go to hand" by the id the room printed.
--   On the list rather than on `hands`: an index on `hands` would read the
--   whole table (the PHF) inside this migration, seconds at 500k hands
--   before the app opens; the list's is built as the rebuild writes it.
--
-- A store from an earlier version has statistics but no list rows: the
-- statistics version is forgotten here, so opening the store starts a
-- rebuild (`stats::ensure_current`), and the background pass writes every
-- hand's list row with its statistics.

CREATE TABLE hand_list (
  -- `hands.played_at`, '' for a hand without one (it sorts last)
  played_at            TEXT    NOT NULL,
  hand_key             TEXT    NOT NULL,
  -- `hands.site_hand_id`: the hand's number as the room printed it
  site_hand_id         TEXT    NOT NULL,
  segment_id           INTEGER NOT NULL,
  -- the hero's seat row (NULL: no hero)
  hero_position        TEXT,
  hero_cards           TEXT,
  hero_net             INTEGER,
  hero_net_bb_milli    INTEGER,
  hero_stack_bb_tenths INTEGER,
  -- the primary runout, the cards separated by spaces ('' before a flop)
  board                TEXT    NOT NULL,
  -- the hero all in with cards to come (`rail_store::ListFacts::all_in`)
  all_in               INTEGER NOT NULL CHECK (all_in IN (0, 1)),
  -- `results.wentToShowdown`
  showdown             INTEGER NOT NULL CHECK (showdown IN (0, 1)),
  pot_type             TEXT    NOT NULL,
  currency_symbol      TEXT    NOT NULL,
  PRIMARY KEY (played_at, hand_key)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER hand_stats_list_delete AFTER DELETE ON hand_stats BEGIN
  DELETE FROM hand_list
   WHERE played_at = coalesce(old.played_at, '') AND hand_key = old.hand_key;
END;

CREATE TABLE hand_notes (
  hand_key   TEXT    NOT NULL PRIMARY KEY,
  note       TEXT    NOT NULL CHECK (note <> ''),
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE hand_tags (
  hand_key TEXT    NOT NULL,
  tag      TEXT    NOT NULL CHECK (tag <> ''),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (hand_key, tag)
) STRICT, WITHOUT ROWID;

-- The hands of a tag (the list's tag filter), and the tags in use.
CREATE INDEX hand_tags_tag_idx ON hand_tags (tag, hand_key);

CREATE TABLE saved_filters (
  id         INTEGER NOT NULL PRIMARY KEY,
  -- the screen it belongs to: 'hands' (R2.7a); Reports later
  screen     TEXT    NOT NULL,
  name       TEXT    NOT NULL CHECK (name <> ''),
  filter     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (screen, name)
) STRICT;

CREATE INDEX hand_list_site_hand_id_idx ON hand_list (site_hand_id);

DELETE FROM kv WHERE key = 'stats.version';
